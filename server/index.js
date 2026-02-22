/**
 * Agent Casino Server
 *
 * Privacy-first gaming server for autonomous agents.
 * No IP logging. No identity tracking. No analytics.
 * Signs game states via GCP Cloud KMS (key never leaves hardware).
 *
 * Endpoints:
 *   POST /a2a/casino       - A2A game interface
 *   GET  /casino/info      - Public game info
 *   GET  /casino/games     - Available games
 *   GET  /health           - Health check
 *   GET  /dashboard/state  - Dashboard snapshot (channels, stats, contracts)
 *   GET  /arena/events     - SSE stream of live game events
 *   GET  /arena/recent     - Recent game events (JSON)
 */

require('dotenv').config();

const express = require('express');
const path = require('path');
const { ethers } = require('ethers');
const { KmsSigner, KMS_ADDRESS } = require('./kms-signer');
const GamingEngine = require('./gaming-engine');
const BackupService = require('./backup');
const CasinoA2AHandler = require('../a2a/casino-handler');
const RelayService = require('../privacy/relay');
const eventBus = require('./event-bus');
const { toEth, toWei, ZERO } = require('./wei');
const { a2aLimiter, getLimiter, sseLimiter, rateLimit, getClientIP } = require('./rate-limit');
const { cacheMiddleware } = require('./cache');
const fs = require('fs');

// Game plugins
const SlotsGame = require('./games/slots');
const LottoGame = require('./games/lotto');
const CoinflipGame = require('./games/coinflip');

// ─── Config ──────────────────────────────────────────────

const PORT = parseInt(process.env.CASINO_PORT || '3847');
const HOST = process.env.CASINO_HOST || '127.0.0.1';
const CHAIN_ID = parseInt(process.env.CHAIN_ID || '8453');
const CHANNEL_MANAGER = process.env.CHANNEL_MANAGER;
const BANKROLL_MANAGER = process.env.BANKROLL_MANAGER;
const INSURANCE_FUND = process.env.INSURANCE_FUND;
const RELAY_ROUTER = process.env.RELAY_ROUTER;
const BACKUP_INTERVAL = 5 * 60 * 1000;
const SCHEDULER_INTERVAL = 60 * 1000;

// ─── Validate ────────────────────────────────────────────

function validateConfig() {
  const required = ['CHANNEL_MANAGER', 'BASE_RPC_URL'];
  const missing = required.filter(k => !process.env[k]);
  if (missing.length > 0) {
    console.error(`Missing env vars: ${missing.join(', ')}`);
    process.exit(1);
  }
}

// ─── Main ────────────────────────────────────────────────

async function main() {
  validateConfig();

  const provider = new ethers.JsonRpcProvider(process.env.BASE_RPC_URL);
  const casinoWallet = new KmsSigner(provider);
  const casinoAddress = await casinoWallet.getAddress();

  console.log(`Casino wallet: ${casinoAddress} (KMS HSM)`);
  console.log(`ChannelManager: ${CHANNEL_MANAGER}`);
  console.log(`Chain: ${CHAIN_ID}`);

  // Verify KMS is accessible
  try {
    const testSig = await casinoWallet.signMessage('casino-startup-test');
    const recovered = ethers.verifyMessage('casino-startup-test', testSig);
    if (recovered.toLowerCase() !== casinoAddress.toLowerCase()) {
      throw new Error('KMS signature verification failed');
    }
    console.log('KMS signer: verified ✅');
  } catch (err) {
    console.error('KMS signer test failed:', err.message);
    process.exit(1);
  }

  // Contract interfaces (from compiled artifacts)
  const channelManagerAbi = require('../artifacts/contracts/ChannelManager.sol/ChannelManager.json').abi;
  const relayRouterAbi = require('../artifacts/contracts/RelayRouter.sol/RelayRouter.json').abi;

  const channelContract = new ethers.Contract(CHANNEL_MANAGER, channelManagerAbi, casinoWallet);
  const relayContract = RELAY_ROUTER ? new ethers.Contract(RELAY_ROUTER, relayRouterAbi, casinoWallet) : null;

  // Engine (uses KMS signer for EIP-712 state signatures)
  const engine = new GamingEngine(casinoWallet, CHANNEL_MANAGER, CHAIN_ID);

  // Register game plugins
  engine.registerGame(new SlotsGame());
  engine.registerGame(new LottoGame());
  engine.registerGame(new CoinflipGame());

  // Services
  const relay = new RelayService(casinoWallet, relayContract || channelContract);
  const handler = new CasinoA2AHandler(engine, relay);

  // Backup key: env > persisted file > generate + persist
  let backupKey = process.env.BACKUP_ENCRYPTION_KEY;
  const backupKeyFile = './backups/.encryption-key';
  if (!backupKey) {
    try { backupKey = fs.readFileSync(backupKeyFile, 'utf-8').trim(); } catch {}
  }
  if (!backupKey) {
    backupKey = require('crypto').randomBytes(32).toString('hex');
    console.warn('WARNING: No BACKUP_ENCRYPTION_KEY set. Generated and persisted to', backupKeyFile);
    fs.mkdirSync('./backups', { recursive: true });
    fs.writeFileSync(backupKeyFile, backupKey, { mode: 0o600 });
  }
  const backup = new BackupService(backupKey, './backups');
  await backup.init();

  // ─── Event Hooks (emit game events for arena) ────────

  const origHandleAction = engine.handleGameAction.bind(engine);
  engine.handleGameAction = async function(actionRoute, agentAddress, params) {
    const result = await origHandleAction(actionRoute, agentAddress, params);

    // Emit arena event (strip signatures for spectators, anonymize agent)
    const agentShort = agentAddress ? agentAddress.slice(0, 6) + '...' + agentAddress.slice(-4) : 'unknown';
    const safeResult = { ...result };
    delete safeResult.signature;
    delete safeResult.proof;

    eventBus.emit('game', {
      action: actionRoute,
      agent: agentShort,
      result: safeResult,
    });

    return result;
  };

  // Hook channel open/close
  const origOpen = engine.openChannel.bind(engine);
  engine.openChannel = function(addr, agentDep, casinoDep) {
    const result = origOpen(addr, agentDep, casinoDep);
    const agentShort = addr ? addr.slice(0, 6) + '...' + addr.slice(-4) : 'unknown';
    eventBus.emit('channel', { action: 'open', agent: agentShort, ...result });
    return result;
  };

  const origClose = engine.closeChannel.bind(engine);
  engine.closeChannel = async function(addr) {
    const result = await origClose(addr);
    const agentShort = addr ? addr.slice(0, 6) + '...' + addr.slice(-4) : 'unknown';
    const safeResult = { ...result };
    delete safeResult.signature;
    eventBus.emit('channel', { action: 'close', agent: agentShort, ...safeResult });
    return result;
  };

  // ─── Express ─────────────────────────────────────────

  const app = express();
  app.use(express.json({ limit: '10kb' }));

  // Security headers
  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('X-XSS-Protection', '0');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    next();
  });

  // Static files (frontend) with cache
  app.use(express.static(path.join(__dirname, '../frontend'), { maxAge: '1h' }));

  // CORS: only for API endpoints, not frontend
  const apiCors = (req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Headers', 'Content-Type');
    res.header('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
    if (req.method === 'OPTIONS') return res.sendStatus(200);
    next();
  };

  // ─── A2A Endpoint ────────────────────────────────────

  app.post('/a2a/casino', apiCors, rateLimit(a2aLimiter, 'A2A: 60 req/min'), async (req, res) => {
    try {
      const result = await handler.handle(req.body);
      res.json(result);
    } catch (err) {
      res.status(400).json({
        version: '0.3.0',
        from: { name: 'AgentCasino' },
        message: {
          contentType: 'application/json',
          content: { error: true, message: err.message },
        },
      });
    }
  });

  // ─── Public Info ─────────────────────────────────────

  app.get('/casino/info', apiCors, rateLimit(getLimiter, 'GET: 200 req/min'), cacheMiddleware('casino:info', 60000), async (req, res) => {
    try {
      const result = await handler.handle({ message: { content: { action: 'info' } } });
      res.json(result.message?.content || result);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/casino/games', apiCors, cacheMiddleware('casino:games', 60000), (req, res) => {
    res.json(engine.getRegisteredGames());
  });

  // Per-game stats
  app.get('/casino/games/:name/stats', apiCors, rateLimit(getLimiter, 'GET: 200 req/min'), (req, res) => {
    const game = engine.games.get(req.params.name);
    if (!game) return res.status(404).json({ error: 'Game not found' });
    res.json({ game: req.params.name, ...game.getStats() });
  });

  // All games stats
  app.get('/casino/stats', apiCors, cacheMiddleware('casino:stats', 5000), (req, res) => {
    const all = {};
    for (const [name, game] of engine.games) {
      all[name] = game.getStats();
    }
    res.json(all);
  });

  app.get('/health', apiCors, cacheMiddleware('health', 3000), (req, res) => {
    res.json({
      status: 'ok',
      uptime: process.uptime(),
      casino: casinoAddress,
      contract: CHANNEL_MANAGER,
      chain: CHAIN_ID,
      signer: 'KMS HSM',
      ...engine.getStats(),
    });
  });

  // ─── Per-Agent API ────────────────────────────────────

  // Active agents with recent game state
  app.get('/arena/agents', apiCors, cacheMiddleware('arena:agents', 2000), (req, res) => {
    const agents = [];
    for (const [addr, ch] of engine.channels) {
      const agentShort = addr.slice(0, 6) + '...' + addr.slice(-4);
      const lastGame = ch.games.length > 0 ? ch.games[ch.games.length - 1] : null;
      agents.push({
        agent: agentShort,
        agentBalance: toEth(ch.agentBalance),
        casinoBalance: toEth(ch.casinoBalance),
        nonce: ch.nonce,
        gamesPlayed: ch.games.length,
        openedAt: ch.createdAt,
        lastGame,
        recentGames: ch.games.slice(-10).reverse(),
      });
    }
    res.json(agents);
  });

  // ─── Agent Detail API ─────────────────────────────────

  // Single agent detail (by short address e.g. 0xABCD...1234)
  app.get('/api/agent/:shortAddr', apiCors, rateLimit(getLimiter, 'GET: 200 req/min'), (req, res) => {
    const short = req.params.shortAddr;

    // Find channel matching short address
    let found = null;
    let fullAddr = null;
    for (const [addr, ch] of engine.channels) {
      const s = addr.slice(0, 6) + '...' + addr.slice(-4);
      if (s === short) { found = ch; fullAddr = addr; break; }
    }

    if (!found) return res.status(404).json({ error: 'Agent not found or channel closed' });

    const ch = found;

    // BigInt math for precision
    const gameBreakdown = {};
    let totalWagered = ZERO;
    let totalPayout = ZERO;
    let agentWins = 0;
    let houseWins = 0;
    let biggestWin = ZERO;
    let biggestLoss = ZERO;
    let streak = 0;
    let maxStreak = 0;
    let currentStreakType = null;

    for (const g of ch.games) {
      const bet = g.bet || g.cost ? toWei(g.bet || g.cost) : ZERO;
      const payout = g.payout ? toWei(g.payout) : ZERO;
      const net = payout - bet;
      const isWin = payout > ZERO || g.won;

      totalWagered += bet;
      totalPayout += payout;

      if (isWin) {
        agentWins++;
        if (net > biggestWin) biggestWin = net;
        if (currentStreakType === 'win') { streak++; } else { streak = 1; currentStreakType = 'win'; }
      } else {
        houseWins++;
        if (bet > biggestLoss) biggestLoss = bet;
        if (currentStreakType === 'lose') { streak++; } else { streak = 1; currentStreakType = 'lose'; }
      }
      if (streak > maxStreak) maxStreak = streak;

      const gameName = g.game || 'unknown';
      if (!gameBreakdown[gameName]) {
        gameBreakdown[gameName] = { rounds: 0, wagered: ZERO, payout: ZERO, wins: 0, losses: 0 };
      }
      gameBreakdown[gameName].rounds++;
      gameBreakdown[gameName].wagered += bet;
      gameBreakdown[gameName].payout += payout;
      if (isWin) gameBreakdown[gameName].wins++; else gameBreakdown[gameName].losses++;
    }

    const netPnl = ch.agentBalance - ch.agentDeposit;
    const netPnlPercent = ch.agentDeposit > ZERO
      ? Number((netPnl * 10000n) / ch.agentDeposit) / 100
      : 0;

    // Serialize game breakdown
    const breakdownOut = {};
    for (const [name, s] of Object.entries(gameBreakdown)) {
      breakdownOut[name] = {
        rounds: s.rounds, wins: s.wins, losses: s.losses,
        wagered: toEth(s.wagered), payout: toEth(s.payout),
      };
    }

    res.json({
      agent: short,
      status: 'active',
      channel: {
        agentDeposit: toEth(ch.agentDeposit),
        casinoDeposit: toEth(ch.casinoDeposit),
        agentBalance: toEth(ch.agentBalance),
        casinoBalance: toEth(ch.casinoBalance),
        nonce: ch.nonce,
        openedAt: ch.createdAt,
      },
      performance: {
        netPnl: toEth(netPnl),
        netPnlPercent: netPnlPercent.toFixed(2),
        totalRounds: ch.games.length,
        agentWins,
        houseWins,
        winRate: ch.games.length > 0 ? ((agentWins / ch.games.length) * 100).toFixed(1) : '0',
        totalWagered: toEth(totalWagered),
        totalPayout: toEth(totalPayout),
        biggestWin: toEth(biggestWin),
        biggestLoss: toEth(biggestLoss),
        longestStreak: maxStreak,
        currentStreak: streak,
        currentStreakType: currentStreakType || 'none',
      },
      gameBreakdown: breakdownOut,
      recentGames: ch.games.slice(-20).reverse().map(g => ({
        game: g.game,
        bet: g.bet || g.cost,
        payout: g.payout || '0',
        won: g.won !== undefined ? g.won : (parseFloat(g.payout || '0') > 0),
        multiplier: g.multiplier,
        reels: g.reels,
        choice: g.choice,
        result: g.result,
        pickedNumber: g.pickedNumber,
        nonce: g.nonce,
        timestamp: g.timestamp,
      })),
    });
  });

  // ─── Dashboard API ───────────────────────────────────

  app.get('/dashboard/state', apiCors, cacheMiddleware('dashboard:state', 3000), (req, res) => {
    // Channel details (anonymized)
    const channels = [];
    for (const [addr, ch] of engine.channels) {
      channels.push({
        agent: addr.slice(0, 6) + '...' + addr.slice(-4),
        agentBalance: toEth(ch.agentBalance),
        casinoBalance: toEth(ch.casinoBalance),
        nonce: ch.nonce,
        gamesPlayed: ch.games.length,
        openedAt: ch.createdAt,
        invariantOk: (ch.agentDeposit + ch.casinoDeposit) === (ch.agentBalance + ch.casinoBalance),
      });
    }

    // Game stats from recent plays
    const gameStats = {};
    for (const [name, game] of engine.games) {
      gameStats[name] = {
        rtp: game.rtp,
        houseEdge: game.houseEdge,
        maxMultiplier: game.maxMultiplier,
      };
    }

    res.json({
      server: {
        uptime: process.uptime(),
        signer: 'KMS HSM',
        chain: CHAIN_ID,
      },
      contracts: {
        channelManager: CHANNEL_MANAGER,
        bankrollManager: BANKROLL_MANAGER || null,
        insuranceFund: INSURANCE_FUND || null,
        relayRouter: RELAY_ROUTER || null,
      },
      stats: {
        activeChannels: engine.channels.size,
        pendingCommits: engine.pendingCommits.size,
        registeredGames: engine.games.size,
      },
      channels,
      games: gameStats,
    });
  });

  // ─── Arena SSE (live game events) ────────────────────

  let sseConnections = 0;
  const MAX_SSE = 50;

  app.get('/arena/events', (req, res) => {
    if (sseConnections >= MAX_SSE) {
      return res.status(503).json({ error: 'Too many SSE connections' });
    }

    const ip = getClientIP(req);
    if (!sseLimiter.check(ip)) {
      return res.status(429).json({ error: 'SSE rate limited' });
    }

    sseConnections++;
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.flushHeaders();

    // Initial connection event
    res.write(`event: connected\ndata: ${JSON.stringify({ time: Date.now() })}\n\n`);

    // Send recent events as replay
    const recent = eventBus.getRecent(10);
    for (const entry of recent) {
      res.write(`id: ${entry.id}\nevent: ${entry.event}\ndata: ${JSON.stringify(entry.data)}\n\n`);
    }

    // Live events
    const onGame = (entry) => {
      res.write(`id: ${entry.id}\nevent: game\ndata: ${JSON.stringify(entry.data)}\n\n`);
    };
    const onChannel = (entry) => {
      res.write(`id: ${entry.id}\nevent: channel\ndata: ${JSON.stringify(entry.data)}\n\n`);
    };

    eventBus.on('game', onGame);
    eventBus.on('channel', onChannel);

    // Heartbeat every 15s to keep connection alive
    const heartbeat = setInterval(() => {
      res.write(`: heartbeat\n\n`);
    }, 15000);

    req.on('close', () => {
      sseConnections--;
      clearInterval(heartbeat);
      eventBus.off('game', onGame);
      eventBus.off('channel', onChannel);
    });
  });

  app.get('/arena/recent', apiCors, (req, res) => {
    const limit = Math.min(parseInt(req.query.limit) || 20, 50);
    res.json(eventBus.getRecent(limit));
  });

  // ─── Frontend routes ─────────────────────────────────

  app.get('/dashboard', (req, res) => {
    res.sendFile(path.join(__dirname, '../frontend/dashboard.html'));
  });

  app.get('/arena', (req, res) => {
    res.sendFile(path.join(__dirname, '../frontend/arena.html'));
  });

  app.get('/agent', (req, res) => {
    res.sendFile(path.join(__dirname, '../frontend/agent.html'));
  });

  app.get('/agent/:shortAddr', (req, res) => {
    res.sendFile(path.join(__dirname, '../frontend/agent.html'));
  });

  // ─── Scheduled Tasks (lotto draws, etc.) ─────────────

  setInterval(async () => {
    try {
      const results = await engine.runScheduledTasks();
      for (const r of results) {
        console.log(`[${r.game}] Draw #${r.drawId}: winner=${r.result.winningNumber}, winners=${r.result.winners.length}`);
        eventBus.emit('game', { action: 'lotto_draw', result: r.result });
      }
    } catch (err) {
      console.error('Scheduler error:', err.message);
    }
  }, SCHEDULER_INTERVAL);

  // ─── Backup ──────────────────────────────────────────

  setInterval(async () => {
    if (engine.channels.size > 0) {
      try {
        const result = await backup.backupChannels(engine.channels);
        console.log(`Backup: ${result.channels} channels, ${result.size} bytes`);
      } catch (err) {
        console.error('Backup error:', err.message);
      }
    }
  }, BACKUP_INTERVAL);

  // ─── Start ───────────────────────────────────────────

  app.listen(PORT, HOST, () => {
    console.log(`\nAgent Casino running on ${HOST}:${PORT}`);
    console.log(`Games: ${Array.from(engine.games.keys()).join(', ')}`);
    console.log(`Actions: ${engine.getAvailableActions().join(', ')}`);
    console.log('Signer: GCP Cloud KMS (HSM)');
    console.log('Privacy: ON (no logging)');
    console.log('Dashboard: /dashboard');
    console.log('Arena: /arena');
  });
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
