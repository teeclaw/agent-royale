const { ethers } = require('ethers');
const { rest, hasConfig } = require('../_supabase');

const CHAIN_ID = 8453;
const CHM = process.env.CHANNEL_MANAGER || '0xBe346665F984A9F1d0dDDE818AfEABA1992A998e';
const BRM = process.env.BANKROLL_MANAGER || '0x52717d801F76AbDA82350c673050D5f5c8213451';
const IFUND = process.env.INSURANCE_FUND || '0xb961b7C7cD68A9BC746483Fb56D52F564FD822c2';
const RLY = process.env.RELAY_ROUTER || '0x7Ccf9A9a35219f7B6FAe02DAB5c8a5130F9F23CC';
const HOUSE = process.env.CASINO_OWNER || '0x1Af5f519DC738aC0f3B58B19A4bB8A8441937e78';

async function getChannels() {
  const strictQuery =
    'casino_channels?select=agent,agent_balance,casino_balance,nonce,games_played,opened_at,status,agent_deposit,casino_deposit,settlement_mode,open_tx_hash,fund_tx_hash&status=eq.open&settlement_mode=eq.onchain-settle&open_tx_hash=not.is.null&fund_tx_hash=not.is.null&order=opened_at.desc&limit=200';
  const fallbackQuery =
    'casino_channels?select=agent,agent_balance,casino_balance,nonce,games_played,opened_at,status,agent_deposit,casino_deposit&status=eq.open&order=opened_at.desc&limit=200';

  try {
    const rows = await rest(strictQuery);
    return { rows: rows || [], dataMode: 'onchain-strict', fallbackReason: null };
  } catch (e) {
    const msg = String(e.message || e);
    const rows = await rest(fallbackQuery).catch(() => []);
    return { rows: rows || [], dataMode: 'degraded', fallbackReason: msg };
  }
}

module.exports = async (req, res) => {
  if (!hasConfig()) return res.status(500).json({ error: true, message: 'Supabase env not configured' });

  try {
    const [{ rows: channels, dataMode, fallbackReason }, pending] = await Promise.all([
      getChannels(),
      rest('casino_commits?select=id&status=eq.pending&limit=1', { headers: { Prefer: 'count=exact' } }).catch(() => []),
    ]);

    const outChannels = (channels || []).map(ch => {
      const agent = ch.agent || '';
      const short = agent.startsWith('0x') && agent.length > 10 ? `${agent.slice(0, 6)}...${agent.slice(-4)}` : agent;
      const ad = Number(ch.agent_deposit || 0);
      const cd = Number(ch.casino_deposit || 0);
      const ab = Number(ch.agent_balance || 0);
      const cb = Number(ch.casino_balance || 0);
      return {
        agent: short,
        agentBalance: String(ch.agent_balance ?? '0'),
        casinoBalance: String(ch.casino_balance ?? '0'),
        nonce: Number(ch.nonce || 0),
        gamesPlayed: Number(ch.games_played || 0),
        openedAt: ch.opened_at ? new Date(ch.opened_at).getTime() : Date.now(),
        invariantOk: Math.abs((ad + cd) - (ab + cb)) < 1e-12,
      };
    });

    const provider = new ethers.JsonRpcProvider(process.env.ONCHAIN_RPC_URL || process.env.BASE_RPC_URL || 'https://mainnet.base.org');
    const [treasuryWei, escrowWei] = await Promise.all([
      provider.getBalance(HOUSE),
      provider.getBalance(CHM),
    ]);

    const treasuryEth = ethers.formatEther(treasuryWei);
    const escrowEth = ethers.formatEther(escrowWei);
    const managedEth = (Number(treasuryEth) + Number(escrowEth)).toString();

    if (dataMode === 'degraded') {
      console.warn(`[dashboard/state] degraded mode fallback: ${fallbackReason}`);
    }

    return res.status(200).json({
      server: { uptime: 0, chain: CHAIN_ID },
      contracts: {
        channelManager: CHM,
        bankrollManager: BRM,
        insuranceFund: IFUND,
        relayRouter: RLY,
      },
      stats: {
        activeChannels: outChannels.length,
        pendingCommits: Array.isArray(pending) ? pending.length : 0,
        registeredGames: 3,
      },
      funds: {
        houseTreasury: treasuryEth,
        channelEscrow: escrowEth,
        totalManaged: managedEth,
      },
      dataMode,
      fallbackReason,
      channels: outChannels,
      games: {},
    });
  } catch (err) {
    return res.status(500).json({ error: true, message: err.message });
  }
};
