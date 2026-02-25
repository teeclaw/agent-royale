const crypto = require('crypto');
const { ethers } = require('ethers');
const { rest, hasConfig } = require('../_supabase');

const CASINO_NAME = 'AgentCasino';
const COMMIT_TTL_MS = 5 * 60 * 1000;
const DEFAULT_SETTLEMENT_MODE = process.env.DEFAULT_SETTLEMENT_MODE || 'onchain-settle';

const CHANNEL_MANAGER_ABI = [
  'function channels(address) view returns (uint256 agentDeposit, uint256 casinoDeposit, uint256 agentBalance, uint256 casinoBalance, uint256 nonce, bytes32 openingBlockHash, uint256 openingBlockNumber, uint8 state)',
  'function fundCasinoSide(address agent) payable',
];

const ENTROPY_COINFLIP_ABI = [
  'function quoteFee() view returns (uint256)',
  'function requestCoinflip(bytes32 roundId,address agent,uint8 choice,uint256 betAmount,bytes32 userRandom) payable returns (uint64)',
  'function markSettled(bytes32 roundId)',
  'function getRound(bytes32 roundId) view returns (address agent,uint8 choice,uint256 betAmount,uint64 sequenceNumber,bytes32 userRandom,bytes32 entropyRandom,uint256 requestedAt,uint256 fulfilledAt,uint8 state)',
];

let _chain = null;
function getChain() {
  if (_chain) return _chain;
  const rpc = process.env.ONCHAIN_RPC_URL || process.env.BASE_RPC_URL;
  const cm = process.env.CHANNEL_MANAGER;
  if (!rpc || !cm) {
    throw new Error('Onchain settlement env missing (ONCHAIN_RPC_URL/BASE_RPC_URL, CHANNEL_MANAGER)');
  }

  const provider = new ethers.JsonRpcProvider(rpc);
  const cmc = new ethers.Contract(cm, CHANNEL_MANAGER_ABI, provider);

  let casino;
  const env = String(process.env.NODE_ENV || '').toLowerCase();
  const useKms = String(process.env.USE_KMS || '').toLowerCase() === 'true' || !process.env.CASINO_PRIVATE_KEY;

  if (env === 'production' && !useKms) {
    throw new Error('Production requires KMS signer (set USE_KMS=true and remove CASINO_PRIVATE_KEY fallback)');
  }

  if (useKms) {
    const { KmsSigner } = require('../../../server/kms-signer');
    casino = new KmsSigner(provider);
  } else {
    casino = new ethers.Wallet(process.env.CASINO_PRIVATE_KEY, provider);
  }

  _chain = { provider, casino, cmc, cm };
  return _chain;
}

function getEntropyChain() {
  const { provider, casino } = getChain();
  const entropyCoinflip = process.env.ENTROPY_COINFLIP;
  const enabled = String(process.env.RNG_PROVIDER || '').toLowerCase() === 'pyth_entropy';
  if (!enabled) throw new Error('Pyth Entropy mode disabled (set RNG_PROVIDER=pyth_entropy)');
  if (!entropyCoinflip) throw new Error('Entropy contract not configured (set ENTROPY_COINFLIP)');
  const ec = new ethers.Contract(entropyCoinflip, ENTROPY_COINFLIP_ABI, provider);
  return { provider, casino, ec, entropyCoinflip };
}

async function recordSettlementTx(agent, action, txHash, chainId, status = 'submitted', blockNumber = null, error = null) {
  await rest('casino_settlement_txs', {
    method: 'POST',
    body: [{ agent, action, tx_hash: txHash, chain_id: chainId, status, block_number: blockNumber, error, updated_at: nowIso() }],
  }).catch(() => {});
}

async function onchainOpenAndFund(agentAddr, agentDepositEth, casinoDepositEth, openTxHash = null) {
  const { provider, casino, cmc } = getChain();
  const network = await provider.getNetwork();
  const chainId = Number(network.chainId);

  // Agent opens channel from their own wallet externally.
  // We verify channel state and then fund casino side.
  const ch = await cmc.channels(agentAddr);
  const state = Number(ch.state ?? ch[7] ?? 0);
  if (state !== 1) throw new Error('Onchain channel is not open. Agent must open channel first onchain.');

  const onchainAgentDeposit = Number(ethers.formatEther(ch.agentDeposit ?? ch[0] ?? 0n));
  if (onchainAgentDeposit + 1e-12 < Number(agentDepositEth)) {
    throw new Error(`Onchain agent deposit too low. expected>=${agentDepositEth}, got=${onchainAgentDeposit}`);
  }

  const fundTx = await cmc.connect(casino).fundCasinoSide(agentAddr, { value: ethers.parseEther(String(casinoDepositEth)) });
  const fundRcpt = await fundTx.wait();
  await recordSettlementTx(agentAddr, 'fund', fundTx.hash, chainId, 'mined', fundRcpt?.blockNumber || null);
  if (openTxHash) await recordSettlementTx(agentAddr, 'open', openTxHash, chainId, 'submitted', null, null);

  return {
    chainId,
    openTxHash: openTxHash || null,
    fundTxHash: fundTx.hash,
    openBlock: null,
    fundBlock: fundRcpt?.blockNumber || null,
    onchainAgent: agentAddr,
  };
}

async function onchainCloseSignature(agentAddr, agentBalanceEth, casinoBalanceEth, nonce) {
  const { provider, casino, cm } = getChain();
  const network = await provider.getNetwork();
  const chainId = Number(network.chainId);

  const domain = { name: 'AgentCasino', version: '1', chainId, verifyingContract: cm };
  const types = {
    ChannelState: [
      { name: 'agent', type: 'address' },
      { name: 'agentBalance', type: 'uint256' },
      { name: 'casinoBalance', type: 'uint256' },
      { name: 'nonce', type: 'uint256' },
    ],
  };
  const value = {
    agent: agentAddr,
    agentBalance: ethers.parseEther(String(agentBalanceEth)),
    casinoBalance: ethers.parseEther(String(casinoBalanceEth)),
    nonce: BigInt(nonce),
  };
  const casinoSig = await casino.signTypedData(domain, types, value);

  return { chainId, casinoSig, onchainAgent: agentAddr };
}

function reply(res, content, status = 200) {
  return res.status(status).json({
    version: '0.3.0',
    from: { name: CASINO_NAME },
    message: { contentType: 'application/json', content },
  });
}

function err(res, message, status = 400, code = 'BAD_REQUEST') {
  return reply(res, { error: true, code, message }, status);
}

function shortAddr(addr = '') {
  if (addr.startsWith('0x') && addr.length > 10) return `${addr.slice(0, 6)}...${addr.slice(-4)}`;
  return addr;
}

function toNum(x, d = 0) {
  const n = Number(x);
  return Number.isFinite(n) ? n : d;
}

function sha256(s) {
  return crypto.createHash('sha256').update(String(s)).digest('hex');
}

function randHex(bytes = 32) {
  return crypto.randomBytes(bytes).toString('hex');
}

function nowIso() { return new Date().toISOString(); }

async function getOpenChannel(agent) {
  const rows = await rest(`casino_channels?select=*&agent=eq.${encodeURIComponent(agent)}&status=eq.open&limit=1`).catch(() => []);
  return rows?.[0] || null;
}

async function updateChannel(id, patch) {
  try {
    const rows = await rest(`casino_channels?id=eq.${id}`, {
      method: 'PATCH',
      body: { ...patch, updated_at: nowIso() },
      prefer: 'return=representation',
    });
    return rows?.[0] || null;
  } catch (e) {
    if (String(e.message || '').includes("updated_at")) {
      const rows = await rest(`casino_channels?id=eq.${id}`, {
        method: 'PATCH',
        body: { ...patch },
        prefer: 'return=representation',
      });
      return rows?.[0] || null;
    }
    throw e;
  }
}

async function insertEvent(type, action, agent, result) {
  await rest('casino_events', {
    method: 'POST',
    body: [{ ts: nowIso(), type, action, agent, result }],
  }).catch(() => {});
}

async function upsertGameStats(game, wagerDelta = 0, payoutDelta = 0, roundDelta = 1) {
  const rows = await rest(`casino_game_stats?select=game,total_rounds,total_wagered,total_paid_out&game=eq.${encodeURIComponent(game)}&limit=1`).catch(() => []);
  if (!rows || rows.length === 0) {
    await rest('casino_game_stats', {
      method: 'POST',
      body: [{ game, total_rounds: roundDelta, total_wagered: wagerDelta, total_paid_out: payoutDelta }],
    });
    return;
  }
  const r = rows[0];
  await rest(`casino_game_stats?game=eq.${encodeURIComponent(game)}`, {
    method: 'PATCH',
    body: {
      total_rounds: toNum(r.total_rounds) + roundDelta,
      total_wagered: toNum(r.total_wagered) + wagerDelta,
      total_paid_out: toNum(r.total_paid_out) + payoutDelta,
    },
  });
}

async function insertRound(payload) {
  await rest('casino_rounds', { method: 'POST', body: [payload] });
}

async function insertEntropyRound(payload) {
  await rest('casino_entropy_rounds', { method: 'POST', body: [payload] }).catch(() => {});
}

async function getEntropyRoundByRoundId(roundId) {
  const rows = await rest(`casino_entropy_rounds?select=*&round_id=eq.${encodeURIComponent(roundId)}&limit=1`).catch(() => []);
  return rows?.[0] || null;
}

async function getLatestEntropyRoundByAgent(agent) {
  const rows = await rest(`casino_entropy_rounds?select=*&agent=eq.${encodeURIComponent(agent)}&order=created_at.desc&limit=1`).catch(() => []);
  return rows?.[0] || null;
}

async function updateEntropyRound(roundId, patch) {
  await rest(`casino_entropy_rounds?round_id=eq.${encodeURIComponent(roundId)}`, {
    method: 'PATCH',
    body: { ...patch, updated_at: nowIso() },
  }).catch(() => {});
}

async function getStoredRequest(requestKey) {
  const rows = await rest(`casino_requests?select=id,response,status,created_at&request_key=eq.${encodeURIComponent(requestKey)}&limit=1`).catch(() => []);
  return rows?.[0] || null;
}

async function putStoredRequest(requestKey, action, agent, response, status = 'done') {
  const existing = await getStoredRequest(requestKey);
  if (existing) {
    await rest(`casino_requests?request_key=eq.${encodeURIComponent(requestKey)}`, {
      method: 'PATCH', body: { response, status },
    });
    return;
  }
  await rest('casino_requests', {
    method: 'POST',
    body: [{ request_key: requestKey, action, agent, status, response, created_at: nowIso() }],
  });
}

function reelFromHash(hash, offset) {
  const n = parseInt(hash.slice(offset, offset + 8), 16) % 100;
  if (n < 30) return 0;
  if (n < 55) return 1;
  if (n < 75) return 2;
  if (n < 90) return 3;
  return 4;
}

function slotsOutcome(seedA, seedB, nonce) {
  const h = sha256(`${seedA}${seedB}${nonce}`);
  const r0 = reelFromHash(h, 0);
  const r1 = reelFromHash(h, 8);
  const r2 = reelFromHash(h, 16);
  const names = ['cherry', 'lemon', 'orange', 'diamond', 'seven'];
  const payouts = [5, 10, 25, 50, 290];
  const same = r0 === r1 && r1 === r2;
  const multiplier = same ? payouts[r0] : 0;
  return { reelIndices: [r0, r1, r2], reels: [names[r0], names[r1], names[r2]], multiplier, resultHash: h };
}

function coinflipOutcome(seedA, seedB, nonce, choice) {
  const h = sha256(`${seedA}${seedB}${nonce}`);
  const bit = parseInt(h.slice(0, 2), 16) % 2;
  const result = bit === 0 ? 'heads' : 'tails';
  const won = result === choice;
  return { result, won, resultHash: h };
}

function slotsOutcomeFromEntropy(randomHex) {
  const h = sha256(String(randomHex || '0x0'));
  const r0 = reelFromHash(h, 0);
  const r1 = reelFromHash(h, 8);
  const r2 = reelFromHash(h, 16);
  const names = ['cherry', 'lemon', 'orange', 'diamond', 'seven'];
  const payouts = [5, 10, 25, 50, 290];
  const same = r0 === r1 && r1 === r2;
  const multiplier = same ? payouts[r0] : 0;
  return { reelIndices: [r0, r1, r2], reels: [names[r0], names[r1], names[r2]], multiplier, resultHash: h };
}

function lottoOutcomeFromEntropy(randomHex, range = 100) {
  const n = Number(BigInt(String(randomHex || '0x0')) % BigInt(range)) + 1;
  return n;
}

function validateAddress(a) {
  return typeof a === 'string' && ethers.isAddress(a);
}

async function ensureDraw() {
  const existing = await rest('casino_lotto_draws?select=*&drawn=eq.false&order=draw_id.desc&limit=1').catch(() => []);
  if (existing && existing[0]) return existing[0];

  const last = await rest('casino_lotto_draws?select=draw_id&order=draw_id.desc&limit=1').catch(() => []);
  const nextId = (last?.[0]?.draw_id || 0) + 1;
  const drawTime = new Date(Date.now() + 6 * 60 * 60 * 1000).toISOString();
  const commitment = sha256(randHex(32));
  const rows = await rest('casino_lotto_draws', {
    method: 'POST',
    body: [{ draw_id: nextId, commitment, draw_time: drawTime, drawn: false }],
  });
  return rows[0];
}

module.exports = async (req, res) => {
  if (!hasConfig()) return err(res, 'Supabase env not configured', 500, 'SERVER_CONFIG');

  const content = req.body?.message?.content || {};
  const action = content.action;
  const agent = content.stealthAddress;

  if (!action) return err(res, 'Missing action');

  // Read-only actions
  if (action === 'info') {
    return reply(res, {
      name: 'Agent Royale',
      mode: 'vercel-supabase-phase2',
      rngProvider: (process.env.RNG_PROVIDER || 'commit-reveal'),
      entropyCoinflip: process.env.ENTROPY_COINFLIP || null,
      entropyCallbackGasLimit: Number(process.env.ENTROPY_CALLBACK_GAS_LIMIT || 120000),
      privacy: 'Stealth addresses + state updates in Supabase',
      actions: ['open_channel','close_channel','channel_status','slots_commit','slots_reveal','slots_entropy_commit','slots_entropy_status','slots_entropy_finalize','coinflip_commit','coinflip_reveal','coinflip_entropy_commit','coinflip_entropy_status','coinflip_entropy_finalize','lotto_buy','lotto_status','lotto_entropy_buy','lotto_entropy_status','lotto_entropy_finalize','info','stats'],
    });
  }

  if (action === 'stats') {
    const rows = await rest('casino_game_stats?select=game,total_rounds,total_wagered,total_paid_out').catch(() => []);
    const out = {};
    for (const r of rows || []) out[r.game] = r;
    return reply(res, out);
  }

  if (!validateAddress(agent)) return err(res, 'Invalid or missing stealthAddress');

  const idemKey = req.headers['x-idempotency-key'] || sha256(JSON.stringify(content));
  if (['open_channel','close_channel','slots_reveal','coinflip_reveal','slots_entropy_commit','slots_entropy_finalize','coinflip_entropy_commit','coinflip_entropy_finalize','lotto_buy','lotto_entropy_buy','lotto_entropy_finalize'].includes(action)) {
    const prev = await getStoredRequest(idemKey);
    if (prev?.response && prev.status === 'done') return reply(res, prev.response);
  }

  try {
    if (action === 'open_channel') {
      const existing = await getOpenChannel(agent);
      if (existing) return err(res, 'Channel already exists', 409, 'CHANNEL_ALREADY_EXISTS');

      const settlementMode = content.settlementMode || content.mode || DEFAULT_SETTLEMENT_MODE;
      const agentDeposit = toNum(content.agentDeposit, toNum(content.params?.agentDeposit, 0));
      const casinoDeposit = toNum(content.casinoDeposit, toNum(content.params?.casinoDeposit, agentDeposit));
      if (agentDeposit < 0.001 || casinoDeposit <= 0) return err(res, 'Min deposit: 0.001 ETH', 400, 'INVALID_DEPOSIT');

      let onchain = { chainId: 8453, openTxHash: null, fundTxHash: null, openBlock: null, fundBlock: null, onchainAgent: null };
      if (settlementMode === 'onchain-settle') {
        const openTxHash = content.openTxHash || content.params?.openTxHash || null;
        onchain = await onchainOpenAndFund(agent, agentDeposit, casinoDeposit, openTxHash);
      }

      const canonicalAgent = onchain.onchainAgent || agent;

      const baseRow = {
        agent: canonicalAgent,
        status: 'open',
        agent_deposit: agentDeposit,
        casino_deposit: casinoDeposit,
        agent_balance: agentDeposit,
        casino_balance: casinoDeposit,
        nonce: 0,
        games_played: 0,
        opened_at: nowIso(),
      };
      const extendedRow = {
        ...baseRow,
        settlement_mode: settlementMode,
        chain_id: onchain.chainId,
        open_tx_hash: onchain.openTxHash,
        fund_tx_hash: onchain.fundTxHash,
        open_block: onchain.openBlock,
        fund_block: onchain.fundBlock,
        settled_onchain: settlementMode === 'onchain-settle',
      };

      try {
        await rest('casino_channels', { method: 'POST', body: [extendedRow] });
      } catch (e) {
        await rest('casino_channels', { method: 'POST', body: [baseRow] });
      }

      const response = {
        status: 'open',
        settlementMode,
        chainId: onchain.chainId,
        openTxHash: onchain.openTxHash,
        fundTxHash: onchain.fundTxHash,
        onchainAgent: onchain.onchainAgent,
        agentBalance: String(agentDeposit),
        casinoBalance: String(casinoDeposit),
      };
      await insertEvent('channel', 'open', shortAddr(canonicalAgent), response);
      await putStoredRequest(idemKey, action, canonicalAgent, response);
      return reply(res, response);
    }

    if (action === 'channel_status') {
      const ch = await getOpenChannel(agent);
      if (!ch) return err(res, 'Channel not found', 404, 'CHANNEL_NOT_FOUND');
      return reply(res, {
        status: 'open',
        settlementMode: ch.settlement_mode || 'offchain-ledger',
        chainId: ch.chain_id || 8453,
        openTxHash: ch.open_tx_hash || null,
        fundTxHash: ch.fund_tx_hash || null,
        agentBalance: String(ch.agent_balance),
        casinoBalance: String(ch.casino_balance),
        nonce: Number(ch.nonce || 0),
        gamesPlayed: Number(ch.games_played || 0),
      });
    }

    if (action === 'slots_entropy_commit') {
      const ch = await getOpenChannel(agent);
      if (!ch) return err(res, 'Channel not found', 404, 'CHANNEL_NOT_FOUND');

      const betAmount = toNum(content.betAmount, toNum(content.params?.betAmount, 0));
      const minBet = 0.0001;
      if (betAmount < minBet) return err(res, `Min bet: ${minBet} Ξ`, 400, 'INVALID_BET');

      const casinoBal = toNum(ch.casino_balance);
      const maxBet = casinoBal / (290 * 2);
      if (betAmount > maxBet) return err(res, `Max bet: ${maxBet} Ξ (bankroll limit)`, 400, 'MAX_BET_EXCEEDED');

      const { provider, casino, ec } = getEntropyChain();
      const net = await provider.getNetwork();
      const chainId = Number(net.chainId);

      const roundId = `0x${randHex(32)}`;
      const userRandom = `0x${randHex(32)}`;
      const betWei = ethers.parseEther(String(betAmount));

      const fee = await ec.quoteFee();
      const tx = await ec.connect(casino).requestCoinflip(roundId, agent, 0, betWei, userRandom, { value: fee });
      await tx.wait();

      let sequenceNumber = null;
      try {
        const onchainRound = await ec.getRound(roundId);
        sequenceNumber = Number(onchainRound.sequenceNumber || onchainRound[3] || 0) || null;
      } catch (_) {}

      await insertEntropyRound({
        round_id: roundId,
        agent,
        game: 'slots',
        bet_amount: betAmount,
        choice: null,
        request_id: sequenceNumber ? String(sequenceNumber) : null,
        request_tx_hash: tx.hash,
        state: 'entropy_requested',
        created_at: nowIso(),
      });

      const response = { roundId, requestId: sequenceNumber, requestTxHash: tx.hash, chainId, status: 'entropy_requested', betAmount: String(betAmount), game: 'slots' };
      await putStoredRequest(idemKey, action, agent, response);
      await insertEvent('game', action, shortAddr(agent), response);
      return reply(res, response);
    }

    if (action === 'coinflip_entropy_commit') {
      const ch = await getOpenChannel(agent);
      if (!ch) return err(res, 'Channel not found', 404, 'CHANNEL_NOT_FOUND');

      const choiceRaw = String(content.choice || '').toLowerCase();
      if (!['heads', 'tails'].includes(choiceRaw)) return err(res, 'choice must be heads or tails', 400, 'INVALID_CHOICE');

      const betAmount = toNum(content.betAmount, toNum(content.params?.betAmount, 0));
      const minBet = 0.0001;
      if (betAmount < minBet) return err(res, `Min bet: ${minBet} ETH`, 400, 'INVALID_BET');

      const casinoBal = toNum(ch.casino_balance);
      const maxMultiplier = 2;
      const safetyMargin = 2;
      const maxBet = casinoBal / (maxMultiplier * safetyMargin);
      if (betAmount > maxBet) return err(res, `Max bet: ${maxBet} ETH (bankroll limit)`, 400, 'MAX_BET_EXCEEDED');

      const { provider, casino, ec } = getEntropyChain();
      const net = await provider.getNetwork();
      const chainId = Number(net.chainId);

      const roundId = `0x${randHex(32)}`;
      const userRandom = `0x${randHex(32)}`;
      const choiceNum = choiceRaw === 'heads' ? 0 : 1;
      const betWei = ethers.parseEther(String(betAmount));

      const fee = await ec.quoteFee();
      const tx = await ec.connect(casino).requestCoinflip(roundId, agent, choiceNum, betWei, userRandom, { value: fee });
      const rcpt = await tx.wait();

      let sequenceNumber = null;
      try {
        const onchainRound = await ec.getRound(roundId);
        sequenceNumber = Number(onchainRound.sequenceNumber || onchainRound[3] || 0) || null;
      } catch (_) {}

      await insertEntropyRound({
        round_id: roundId,
        agent,
        game: 'coinflip',
        bet_amount: betAmount,
        choice: choiceRaw,
        request_id: sequenceNumber ? String(sequenceNumber) : null,
        request_tx_hash: tx.hash,
        state: 'entropy_requested',
        created_at: nowIso(),
      });

      const response = {
        roundId,
        requestId: sequenceNumber,
        requestTxHash: tx.hash,
        chainId,
        status: 'entropy_requested',
        choice: choiceRaw,
        betAmount: String(betAmount),
      };
      await putStoredRequest(idemKey, action, agent, response);
      await insertEvent('game', action, shortAddr(agent), response);
      return reply(res, response);
    }

    if (action === 'slots_entropy_status' || action === 'coinflip_entropy_status' || action === 'lotto_entropy_status') {
      const roundId = content.roundId || content.requestId;
      const row = roundId
        ? (await getEntropyRoundByRoundId(roundId))
        : (await getLatestEntropyRoundByAgent(agent));
      if (!row) return err(res, 'Entropy round not found', 404, 'ROUND_NOT_FOUND');

      const { ec } = getEntropyChain();
      const onchain = await ec.getRound(row.round_id);
      const state = Number(onchain.state);
      const fulfilled = state >= 2;
      const ttlMs = Number(process.env.ENTROPY_ROUND_TTL_MS || 300000);
      const createdMs = row.created_at ? new Date(row.created_at).getTime() : Date.now();
      const expired = !fulfilled && Date.now() - createdMs > ttlMs;

      if (expired) {
        await updateEntropyRound(row.round_id, { state: 'expired' });
        await ec.markExpired(row.round_id).catch(() => {});
      }

      return reply(res, {
        roundId: row.round_id,
        requestId: row.request_id,
        requestTxHash: row.request_tx_hash,
        state: fulfilled ? 'entropy_fulfilled' : (expired ? 'expired' : 'entropy_requested'),
        entropyRandom: fulfilled ? onchain.entropyRandom : null,
        choice: row.choice,
        betAmount: String(row.bet_amount),
        retryAfterSec: fulfilled ? 0 : 10,
      });
    }

    if (action === 'slots_entropy_finalize' || action === 'coinflip_entropy_finalize' || action === 'lotto_entropy_finalize') {
      const roundId = content.roundId || content.requestId;
      const row = roundId
        ? (await getEntropyRoundByRoundId(roundId))
        : (await getLatestEntropyRoundByAgent(agent));
      if (!row) return err(res, 'Entropy round not found', 404, 'ROUND_NOT_FOUND');

      const ch = await getOpenChannel(agent);
      if (!ch) return err(res, 'Channel not found', 404, 'CHANNEL_NOT_FOUND');

      const { ec } = getEntropyChain();
      const onchain = await ec.getRound(row.round_id);
      const state = Number(onchain.state);
      if (state < 2) {
        const ttlMs = Number(process.env.ENTROPY_ROUND_TTL_MS || 300000);
        const createdMs = row.created_at ? new Date(row.created_at).getTime() : Date.now();
        if (Date.now() - createdMs > ttlMs) {
          await updateEntropyRound(row.round_id, { state: 'expired' });
          await ec.markExpired(row.round_id).catch(() => {});
          return err(res, 'Entropy round expired before callback fulfillment', 409, 'ENTROPY_EXPIRED');
        }
        return err(res, 'Entropy not ready', 409, 'ENTROPY_NOT_READY');
      }

      const randomHex = onchain.entropyRandom;
      const bet = toNum(row.bet_amount, 0);
      const game = row.game || (action.startsWith('slots') ? 'slots' : (action.startsWith('lotto') ? 'lotto' : 'coinflip'));

      let result = null;
      let won = false;
      let payout = 0;
      let multiplier = 0;
      let reels = null;
      let pickedNumber = null;

      if (game === 'coinflip') {
        const resultBit = Number(BigInt(randomHex) % 2n);
        result = resultBit === 0 ? 'heads' : 'tails';
        won = row.choice === result;
        payout = won ? bet * 1.9 : 0;
        multiplier = won ? 1.9 : 0;
      } else if (game === 'slots') {
        const out = slotsOutcomeFromEntropy(randomHex);
        reels = out.reelIndices;
        result = out.reels.join('-');
        multiplier = out.multiplier;
        won = out.multiplier > 0;
        payout = bet * out.multiplier;
      } else if (game === 'lotto') {
        const range = Number(process.env.LOTTO_RANGE || 100);
        const parts = String(row.choice || '').split(':');
        pickedNumber = Number(parts[0] || 0);
        const ticketCount = Number(parts[1] || 1);
        const winningNumber = lottoOutcomeFromEntropy(randomHex, range);
        result = String(winningNumber);
        won = pickedNumber === winningNumber;
        const ticketPrice = 0.001;
        const payoutMultiplier = 85;
        payout = won ? ticketPrice * ticketCount * payoutMultiplier : 0;
        multiplier = won ? payoutMultiplier : 0;
      }

      const nonce = Number(ch.nonce || 0) + 1;
      const nextAgent = toNum(ch.agent_balance) - bet + payout;
      const nextCasino = toNum(ch.casino_balance) + bet - payout;
      if (nextAgent < 0 || nextCasino < 0) return err(res, 'Insufficient channel balance', 400, 'INSUFFICIENT_BALANCE');

      const updated = await updateChannel(ch.id, {
        agent_balance: nextAgent,
        casino_balance: nextCasino,
        nonce,
        games_played: Number(ch.games_played || 0) + 1,
      });

      await insertRound({
        agent,
        game,
        bet,
        payout,
        won,
        multiplier,
        reels,
        choice: game === 'coinflip' ? row.choice : null,
        result,
        picked_number: game === 'lotto' ? pickedNumber : null,
        nonce,
        timestamp: nowIso(),
      });
      await upsertGameStats(game, bet, payout, 1);

      const onchainRequestId = Number(onchain.sequenceNumber || onchain[3] || 0) || null;
      await updateEntropyRound(row.round_id, {
        state: 'settled',
        won,
        payout,
        request_id: onchainRequestId ? String(onchainRequestId) : (row.request_id || null),
        entropy_value: randomHex,
      });
      await ec.markSettled(row.round_id).catch(() => {});

      const response = {
        roundId: row.round_id,
        requestId: onchainRequestId ? String(onchainRequestId) : row.request_id,
        requestTxHash: row.request_tx_hash,
        provider: 'pyth_entropy',
        game,
        choice: game === 'coinflip' ? row.choice : undefined,
        result,
        reels: game === 'slots' ? reels : undefined,
        pickedNumber: game === 'lotto' ? pickedNumber : undefined,
        won,
        multiplier,
        payout: String(payout),
        agentBalance: String(updated.agent_balance),
        casinoBalance: String(updated.casino_balance),
        nonce,
        proof: {
          requestId: onchainRequestId ? String(onchainRequestId) : row.request_id,
          requestTxHash: row.request_tx_hash,
          randomValue: randomHex,
          formula: game === 'coinflip' ? 'uint256(randomValue) % 2' : (game === 'slots' ? 'sha256(randomValue) -> weighted reels' : `uint256(randomValue) % ${Number(process.env.LOTTO_RANGE || 100)} + 1`),
          derivedResult: result,
        },
      };

      await putStoredRequest(idemKey, action, agent, response);
      await insertEvent('game', action, shortAddr(agent), response);
      return reply(res, response);
    }

    if (action === 'close_channel') {
      const ch = await getOpenChannel(agent);
      if (!ch) return err(res, 'Channel not found', 404, 'CHANNEL_NOT_FOUND');

      const settlementMode = ch.settlement_mode || DEFAULT_SETTLEMENT_MODE;
      let closeTx = { closeTxHash: null, closeBlock: null, chainId: ch.chain_id || 8453, casinoSig: null, onchainAgent: agent };

      if (settlementMode === 'onchain-settle') {
        // Agent handles close tx from their own wallet; server provides casino signature only.
        // Contract requires a strictly higher nonce on close; sign next nonce.
        closeTx = await onchainCloseSignature(agent, ch.agent_balance, ch.casino_balance, Number(ch.nonce || 0) + 1);

        const submittedCloseTxHash = content.closeTxHash || content.params?.closeTxHash || null;
        if (submittedCloseTxHash) {
          closeTx.closeTxHash = submittedCloseTxHash;
          await recordSettlementTx(agent, 'close', submittedCloseTxHash, closeTx.chainId, 'submitted', null, null);
          try {
            await updateChannel(ch.id, {
              status: 'closed',
              close_tx_hash: submittedCloseTxHash,
              settled_onchain: true,
            });
          } catch {
            await updateChannel(ch.id, { status: 'closed' });
          }
        }
      } else {
        await updateChannel(ch.id, { status: 'closed' });
      }

      const response = {
        settlementMode,
        settledOnchain: settlementMode === 'onchain-settle' ? Boolean(closeTx.closeTxHash) : false,
        chainId: closeTx.chainId,
        closeTxHash: closeTx.closeTxHash,
        closeBlock: closeTx.closeBlock,
        onchainAgent: closeTx.onchainAgent,
        agentBalance: String(ch.agent_balance),
        casinoBalance: String(ch.casino_balance),
        nonce: Number(ch.nonce || 0),
        signature: closeTx.casinoSig || 'vercel-supabase-phase2',
        totalGames: Number(ch.games_played || 0),
        nextStep: settlementMode === 'onchain-settle' && !closeTx.closeTxHash ? 'Submit closeChannel tx from agent wallet, then call close_channel again with closeTxHash.' : null,
      };
      await insertEvent('channel', 'close', shortAddr(agent), response);
      await putStoredRequest(idemKey, action, agent, response);
      return reply(res, response);
    }

    if (action === 'slots_commit' || action === 'coinflip_commit') {
      const ch = await getOpenChannel(agent);
      if (!ch) return err(res, 'Channel not found', 404, 'CHANNEL_NOT_FOUND');

      const game = action.startsWith('slots') ? 'slots' : 'coinflip';
      const pendingKey = `pending:${game}:${agent}`;
      const pending = await getStoredRequest(pendingKey);
      if (pending && pending.status === 'pending') return err(res, 'Pending commit exists for this game', 409, 'PENDING_COMMIT_EXISTS');

      const betAmount = toNum(content.betAmount, toNum(content.params?.betAmount, 0));
      const minBet = 0.0001;
      if (betAmount < minBet) return err(res, `Min bet: ${minBet} ETH`, 400, 'INVALID_BET');

      const casinoBal = toNum(ch.casino_balance);
      const maxMultiplier = game === 'slots' ? 290 : 2;
      const safetyMargin = 2;
      const maxBet = casinoBal / (maxMultiplier * safetyMargin);
      if (betAmount > maxBet) return err(res, `Max bet: ${maxBet} ETH (bankroll limit)`, 400, 'MAX_BET_EXCEEDED');

      if (game === 'coinflip' && !['heads', 'tails'].includes(content.choice)) {
        return err(res, 'choice must be heads or tails', 400, 'INVALID_CHOICE');
      }

      const casinoSeed = randHex(32);
      const commitment = sha256(casinoSeed);
      const pendingPayload = { commitment, casinoSeed, betAmount: String(betAmount), choice: content.choice || null };

      await putStoredRequest(pendingKey, action, agent, pendingPayload, 'pending');
      await rest('casino_commits', { method: 'POST', body: [{ agent, game, status: 'pending', created_at: nowIso() }] }).catch(() => {});

      const out = game === 'coinflip'
        ? { commitment, betAmount: String(betAmount), choice: content.choice }
        : { commitment, betAmount: String(betAmount) };
      return reply(res, out);
    }

    if (action === 'slots_reveal' || action === 'coinflip_reveal') {
      const ch = await getOpenChannel(agent);
      if (!ch) return err(res, 'Channel not found', 404, 'CHANNEL_NOT_FOUND');

      const game = action.startsWith('slots') ? 'slots' : 'coinflip';
      const pendingKey = `pending:${game}:${agent}`;
      const pending = await getStoredRequest(pendingKey);
      if (!pending || pending.status !== 'pending') return err(res, 'No pending commit', 400, 'COMMIT_NOT_FOUND');

      const createdAt = new Date(pending.created_at).getTime();
      if (Date.now() - createdAt > COMMIT_TTL_MS) {
        await putStoredRequest(pendingKey, `${game}_commit`, agent, pending.response, 'expired');
        return err(res, 'Commit expired', 400, 'COMMIT_EXPIRED');
      }

      const agentSeed = content.agentSeed;
      if (!agentSeed) return err(res, 'agentSeed required', 400, 'INVALID_SEED');

      const p = pending.response || {};
      const bet = toNum(p.betAmount, 0);
      const nonce = Number(ch.nonce || 0) + 1;
      const agentBal = toNum(ch.agent_balance);
      const casinoBal = toNum(ch.casino_balance);

      let outcome;
      let payout;
      if (game === 'slots') {
        outcome = slotsOutcome(p.casinoSeed, agentSeed, nonce);
        payout = bet * outcome.multiplier;
      } else {
        outcome = coinflipOutcome(p.casinoSeed, agentSeed, nonce, p.choice);
        payout = outcome.won ? bet * 1.9 : 0;
      }

      const nextAgent = agentBal - bet + payout;
      const nextCasino = casinoBal + bet - payout;
      if (nextAgent < 0 || nextCasino < 0) return err(res, 'Insufficient channel balance', 400, 'INSUFFICIENT_BALANCE');

      const updated = await updateChannel(ch.id, {
        agent_balance: nextAgent,
        casino_balance: nextCasino,
        nonce,
        games_played: Number(ch.games_played || 0) + 1,
      });

      const round = {
        agent,
        game,
        bet,
        payout,
        won: game === 'slots' ? outcome.multiplier > 0 : outcome.won,
        multiplier: game === 'slots' ? outcome.multiplier : (outcome.won ? 1.9 : 0),
        reels: game === 'slots' ? outcome.reelIndices : null,
        choice: game === 'coinflip' ? p.choice : null,
        result: game === 'coinflip' ? outcome.result : null,
        nonce,
        timestamp: nowIso(),
      };
      await insertRound(round);
      await upsertGameStats(game, bet, payout, 1);
      await insertEvent('game', action, shortAddr(agent), {
        ...round,
        reels: game === 'slots' ? outcome.reels : undefined,
      });

      await putStoredRequest(pendingKey, `${game}_commit`, agent, p, 'resolved');
      await rest(`casino_commits?agent=eq.${encodeURIComponent(agent)}&game=eq.${encodeURIComponent(game)}&status=eq.pending`, {
        method: 'PATCH', body: { status: 'resolved' },
      }).catch(() => {});

      const response = game === 'slots'
        ? {
            reels: outcome.reels,
            reelIndices: outcome.reelIndices,
            multiplier: outcome.multiplier,
            payout: String(payout),
            agentBalance: String(updated.agent_balance),
            casinoBalance: String(updated.casino_balance),
            nonce,
            signature: 'vercel-supabase-phase2',
            proof: { casinoSeed: p.casinoSeed, agentSeed, resultHash: outcome.resultHash },
          }
        : {
            choice: p.choice,
            result: outcome.result,
            won: outcome.won,
            payout: String(payout),
            agentBalance: String(updated.agent_balance),
            casinoBalance: String(updated.casino_balance),
            nonce,
            signature: 'vercel-supabase-phase2',
            proof: { casinoSeed: p.casinoSeed, agentSeed, resultHash: outcome.resultHash },
          };

      await putStoredRequest(idemKey, action, agent, response);
      return reply(res, response);
    }

    if (action === 'lotto_status') {
      const draw = await ensureDraw();
      const tickets = await rest(`casino_lotto_tickets?select=ticket_count,cost&draw_id=eq.${draw.draw_id}`).catch(() => []);
      const totalTickets = (tickets || []).reduce((s, t) => s + Number(t.ticket_count || 0), 0);
      const totalPool = (tickets || []).reduce((s, t) => s + Number(t.cost || 0), 0);
      return reply(res, {
        drawId: Number(draw.draw_id),
        commitment: draw.commitment,
        drawTime: new Date(draw.draw_time).getTime(),
        ticketPrice: '0.001',
        payoutMultiplier: 85,
        range: 100,
        totalTickets,
        totalPool: String(totalPool),
      });
    }

    if (action === 'lotto_entropy_buy') {
      const ch = await getOpenChannel(agent);
      if (!ch) return err(res, 'Channel not found', 404, 'CHANNEL_NOT_FOUND');

      const range = Number(process.env.LOTTO_RANGE || 100);
      const pickedNumber = Number(content.pickedNumber);
      const ticketCount = Number(content.ticketCount || 1);
      if (!Number.isInteger(pickedNumber) || pickedNumber < 1 || pickedNumber > range) return err(res, `pickedNumber must be 1-${range}`, 400, 'INVALID_PICK');
      if (!Number.isInteger(ticketCount) || ticketCount < 1 || ticketCount > 10) return err(res, 'ticketCount must be 1-10', 400, 'INVALID_TICKET_COUNT');

      const price = 0.001;
      const betAmount = price * ticketCount;
      const payoutMultiplier = 85;
      const maxLiability = betAmount * payoutMultiplier;

      const agentBal = toNum(ch.agent_balance);
      const casinoBal = toNum(ch.casino_balance);
      if (agentBal < betAmount) return err(res, 'Insufficient balance for tickets', 400, 'INSUFFICIENT_BALANCE');
      if (casinoBal < maxLiability) return err(res, `Casino can't cover max payout. Max possible payout: ${maxLiability} Ξ, casino balance: ${casinoBal} Ξ`, 400, 'MAX_BET_EXCEEDED');

      const { provider, casino, ec } = getEntropyChain();
      const net = await provider.getNetwork();
      const chainId = Number(net.chainId);

      const roundId = `0x${randHex(32)}`;
      const userRandom = `0x${randHex(32)}`;
      const betWei = ethers.parseEther(String(betAmount));
      const fee = await ec.quoteFee();
      const tx = await ec.connect(casino).requestCoinflip(roundId, agent, 0, betWei, userRandom, { value: fee });
      await tx.wait();

      let sequenceNumber = null;
      try {
        const onchainRound = await ec.getRound(roundId);
        sequenceNumber = Number(onchainRound.sequenceNumber || onchainRound[3] || 0) || null;
      } catch (_) {}

      const nonce = Number(ch.nonce || 0) + 1;
      const updated = await updateChannel(ch.id, {
        agent_balance: agentBal - betAmount,
        casino_balance: casinoBal + betAmount,
        nonce,
        games_played: Number(ch.games_played || 0) + 1,
      });

      await insertEntropyRound({
        round_id: roundId,
        agent,
        game: 'lotto',
        bet_amount: betAmount,
        choice: `${pickedNumber}:${ticketCount}`,
        request_id: sequenceNumber ? String(sequenceNumber) : null,
        request_tx_hash: tx.hash,
        state: 'entropy_requested',
        created_at: nowIso(),
      });

      const response = { roundId, requestId: sequenceNumber, requestTxHash: tx.hash, chainId, status: 'entropy_requested', pickedNumber, ticketCount, totalCost: String(betAmount), agentBalance: String(updated.agent_balance), casinoBalance: String(updated.casino_balance), nonce, game: 'lotto' };
      await putStoredRequest(idemKey, action, agent, response);
      await insertEvent('game', action, shortAddr(agent), response);
      return reply(res, response);
    }

    if (action === 'lotto_buy') {
      const ch = await getOpenChannel(agent);
      if (!ch) return err(res, 'Channel not found', 404, 'CHANNEL_NOT_FOUND');

      const pickedNumber = Number(content.pickedNumber);
      const ticketCount = Number(content.ticketCount || 1);
      if (!Number.isInteger(pickedNumber) || pickedNumber < 1 || pickedNumber > 100) return err(res, 'pickedNumber must be 1-100', 400, 'INVALID_PICK');
      if (!Number.isInteger(ticketCount) || ticketCount < 1 || ticketCount > 10) return err(res, 'ticketCount must be 1-10', 400, 'INVALID_TICKET_COUNT');

      const price = 0.001;
      const cost = price * ticketCount;
      const payoutMultiplier = 85;
      const maxLiability = cost * payoutMultiplier;

      const agentBal = toNum(ch.agent_balance);
      const casinoBal = toNum(ch.casino_balance);
      if (agentBal < cost) return err(res, 'Insufficient balance for tickets', 400, 'INSUFFICIENT_BALANCE');
      if (casinoBal < maxLiability) return err(res, `Casino can't cover max payout. Max tickets with current bankroll: ${Math.floor(casinoBal / (price * payoutMultiplier))}. Max possible payout: ${maxLiability} ETH, casino balance: ${casinoBal} ETH`, 400, 'MAX_BET_EXCEEDED');

      const draw = await ensureDraw();
      const nonce = Number(ch.nonce || 0) + 1;
      const updated = await updateChannel(ch.id, {
        agent_balance: agentBal - cost,
        casino_balance: casinoBal + cost,
        nonce,
        games_played: Number(ch.games_played || 0) + 1,
      });

      await rest('casino_lotto_tickets', {
        method: 'POST',
        body: [{ draw_id: draw.draw_id, agent, picked_number: pickedNumber, ticket_count: ticketCount, cost, created_at: nowIso() }],
      });

      await insertRound({
        agent,
        game: 'lotto',
        bet: cost,
        payout: 0,
        won: false,
        picked_number: pickedNumber,
        draw_id: draw.draw_id,
        ticket_count: ticketCount,
        nonce,
        timestamp: nowIso(),
      });
      await upsertGameStats('lotto', cost, 0, 1);
      await insertEvent('game', 'lotto_buy', shortAddr(agent), { drawId: draw.draw_id, pickedNumber, ticketCount, cost: String(cost) });

      const response = {
        drawId: Number(draw.draw_id),
        pickedNumber,
        ticketCount,
        totalCost: String(cost),
        agentBalance: String(updated.agent_balance),
        casinoBalance: String(updated.casino_balance),
        nonce,
      };
      await putStoredRequest(idemKey, action, agent, response);
      return reply(res, response);
    }

    return err(res, `Unsupported action: ${action}`, 400, 'UNSUPPORTED_ACTION');
  } catch (e) {
    return err(res, e.message || 'Internal error', 500, 'INTERNAL');
  }
};
