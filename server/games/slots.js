/**
 * Slots Game Plugin (BigInt/Wei)
 *
 * All balance math in BigInt. Converts at API boundary.
 * Commit-reveal: casino commits → agent sends seed → resolve.
 *
 * Fixes applied:
 *   [FIX #1] BigInt precision (no floats)
 *   [FIX #2] Re-validate balance at reveal time
 *   [FIX #6] Pending commits keyed by agent:game
 *   [FIX #7] Rate limit: 1 pending commit per agent
 */

const BaseGame = require('./base-game');
const { toWei, toEth } = require('../wei');

const SYMBOLS = ['cherry', 'lemon', 'orange', 'diamond', 'seven'];
const WEIGHTS = [30, 25, 20, 15, 10];
const PAYOUTS = [5n, 10n, 25n, 50n, 290n]; // BigInt multipliers
const COMMIT_TIMEOUT = 5 * 60 * 1000;

class SlotsGame extends BaseGame {
  get name() { return 'slots'; }
  get displayName() { return 'Agent Slots'; }
  get description() { return '3-reel slot machine. Match three symbols to win.'; }
  get rtp() { return 0.95; }
  get maxMultiplier() { return 290; }
  get actions() { return ['commit', 'reveal']; }

  async handleAction(action, channel, params, ctx) {
    switch (action) {
      case 'commit': return this._commit(channel, params, ctx);
      case 'reveal': return await this._reveal(channel, params, ctx);
      default: throw new Error(`Unknown slots action: ${action}`);
    }
  }

  // ─── Step 1: Casino Commits ─────────────────────────────

  _commit(channel, params, ctx) {
    const betWei = toWei(params.betAmount);
    this.validateBet(channel, betWei);

    // [FIX #7] Check for existing pending commit
    const commitKey = `${channel.agent}:slots`;
    if (ctx.pendingCommits.has(commitKey)) {
      throw new Error('Already have a pending slots spin. Reveal or wait for timeout.');
    }

    const { seed, commitment } = ctx.commitReveal.commit();

    // [FIX #6] Key by agent:game
    ctx.pendingCommits.set(commitKey, {
      seed,
      betWei,
      game: 'slots',
      timestamp: Date.now(),
    });

    return { commitment, betAmount: toEth(betWei) };
  }

  // ─── Step 2: Reveal + Resolve ───────────────────────────

  async _reveal(channel, params, ctx) {
    const { agentSeed } = params;

    // [FIX #6] Keyed lookup
    const commitKey = `${channel.agent}:slots`;
    const pending = ctx.pendingCommits.get(commitKey);

    if (!pending) {
      throw new Error('No pending slot spin');
    }
    if (Date.now() - pending.timestamp > COMMIT_TIMEOUT) {
      ctx.pendingCommits.delete(commitKey);
      throw new Error('Commitment expired (5min timeout)');
    }

    const { seed: casinoSeed, betWei } = pending;

    // [FIX #2] Re-validate balance at reveal time
    if (channel.agentBalance < betWei) {
      ctx.pendingCommits.delete(commitKey);
      throw new Error(`Insufficient balance at reveal: have ${toEth(channel.agentBalance)}, need ${toEth(betWei)}`);
    }

    // Compute provably fair result
    const { proof } = ctx.commitReveal.computeResult(casinoSeed, agentSeed, channel.nonce);

    // Generate 3 independent reels
    const hashBuf = Buffer.from(proof.resultHash, 'hex');
    const reels = [
      this._getSymbol(hashBuf.readUInt32BE(0) % 100),
      this._getSymbol(hashBuf.readUInt32BE(4) % 100),
      this._getSymbol(hashBuf.readUInt32BE(8) % 100),
    ];

    // Calculate payout (BigInt math - zero precision loss)
    let multiplier = 0n;
    let payoutWei = 0n;
    if (reels[0] === reels[1] && reels[1] === reels[2]) {
      multiplier = PAYOUTS[reels[0]];
      payoutWei = betWei * multiplier;
    }

    // Cap to casino balance
    if (payoutWei > channel.casinoBalance) {
      payoutWei = channel.casinoBalance;
    }

    // Update balances (BigInt - exact, no drift)
    channel.agentBalance = channel.agentBalance - betWei + payoutWei;
    channel.casinoBalance = channel.casinoBalance + betWei - payoutWei;
    channel.nonce++;

    // Record
    channel.games.push({
      nonce: channel.nonce,
      game: 'slots',
      bet: toEth(betWei),
      reels,
      multiplier: Number(multiplier),
      payout: toEth(payoutWei),
      timestamp: Date.now(),
    });

    // Track stats
    this.recordRound(betWei, payoutWei, Number(multiplier));

    // Sign state (BigInt passed directly - no conversion)
    const signature = await ctx.signState(
      channel.agent, channel.agentBalance, channel.casinoBalance, channel.nonce
    );

    ctx.pendingCommits.delete(commitKey);

    return {
      reels: reels.map(i => SYMBOLS[i]),
      reelIndices: reels,
      multiplier: Number(multiplier),
      payout: toEth(payoutWei),
      agentBalance: toEth(channel.agentBalance),
      casinoBalance: toEth(channel.casinoBalance),
      nonce: channel.nonce,
      signature,
      proof: {
        casinoSeed,
        agentSeed,
        resultHash: proof.resultHash,
      },
    };
  }

  _getSymbol(rng) {
    let cumulative = 0;
    for (let i = 0; i < WEIGHTS.length; i++) {
      cumulative += WEIGHTS[i];
      if (rng < cumulative) return i;
    }
    return 0;
  }

  getInfo() {
    return {
      ...super.getInfo(),
      symbols: SYMBOLS,
      weights: WEIGHTS,
      payouts: PAYOUTS.map(Number),
      minBet: '0.0001 ETH',
      maxBet: 'dynamic (bankroll-dependent)',
    };
  }
}

module.exports = SlotsGame;
