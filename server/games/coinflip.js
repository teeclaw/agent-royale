/**
 * Coinflip Game Plugin (BigInt/Wei)
 *
 * Heads or tails. 1.9x payout. Commit-reveal fairness.
 *
 * P(win) = 50%, Payout = 1.9x
 * RTP = 95%, House Edge = 5%
 *
 * Payout math (BigInt): payoutWei = betWei * 19n / 10n
 * This gives exact 1.9x with zero precision loss.
 *
 * Fixes applied:
 *   [FIX #1] BigInt precision
 *   [FIX #2] Re-validate at reveal
 *   [FIX #6] Pending commits keyed by agent:game
 *   [FIX #7] Rate limit
 */

const BaseGame = require('./base-game');
const { toWei, toEth } = require('../wei');

const COMMIT_TIMEOUT = 5 * 60 * 1000;

class CoinflipGame extends BaseGame {
  get name() { return 'coinflip'; }
  get displayName() { return 'Agent Coinflip'; }
  get description() { return 'Heads or tails. 1.9x payout. 50/50 odds.'; }
  get rtp() { return 0.95; }
  get maxMultiplier() { return 2; } // Round up for bankroll safety (actual is 1.9)
  get actions() { return ['commit', 'reveal']; }

  async handleAction(action, channel, params, ctx) {
    switch (action) {
      case 'commit': return this._commit(channel, params, ctx);
      case 'reveal': return await this._reveal(channel, params, ctx);
      default: throw new Error(`Unknown coinflip action: ${action}`);
    }
  }

  _commit(channel, params, ctx) {
    const { choice } = params;
    if (!['heads', 'tails'].includes(choice)) {
      throw new Error('Choice must be "heads" or "tails"');
    }

    const betWei = toWei(params.betAmount);
    this.validateBet(channel, betWei);

    const commitKey = `${channel.agent}:coinflip`;
    if (ctx.pendingCommits.has(commitKey)) {
      throw new Error('Already have a pending coinflip. Reveal or wait for timeout.');
    }

    const { seed, commitment } = ctx.commitReveal.commit();

    ctx.pendingCommits.set(commitKey, {
      seed,
      betWei,
      choice,
      game: 'coinflip',
      timestamp: Date.now(),
    });

    return { commitment, betAmount: toEth(betWei), choice };
  }

  async _reveal(channel, params, ctx) {
    const { agentSeed } = params;
    const commitKey = `${channel.agent}:coinflip`;
    const pending = ctx.pendingCommits.get(commitKey);

    if (!pending) throw new Error('No pending coinflip');
    if (Date.now() - pending.timestamp > COMMIT_TIMEOUT) {
      ctx.pendingCommits.delete(commitKey);
      throw new Error('Commitment expired');
    }

    const { seed: casinoSeed, betWei, choice } = pending;

    // [FIX #2] Re-validate
    if (channel.agentBalance < betWei) {
      ctx.pendingCommits.delete(commitKey);
      throw new Error(`Insufficient balance at reveal: have ${toEth(channel.agentBalance)}, need ${toEth(betWei)}`);
    }

    const { proof } = ctx.commitReveal.computeResult(casinoSeed, agentSeed, channel.nonce);

    const hashBuf = Buffer.from(proof.resultHash, 'hex');
    const result = hashBuf.readUInt32BE(0) % 2 === 0 ? 'heads' : 'tails';
    const won = result === choice;

    // [FIX #1] BigInt payout: 1.9x = betWei * 19 / 10
    let payoutWei = 0n;
    if (won) {
      payoutWei = betWei * 19n / 10n;
      if (payoutWei > channel.casinoBalance + betWei) {
        payoutWei = channel.casinoBalance + betWei;
      }
    }

    // Update balances (BigInt)
    channel.agentBalance = channel.agentBalance - betWei + payoutWei;
    channel.casinoBalance = channel.casinoBalance + betWei - payoutWei;
    channel.nonce++;

    // Track stats
    this.recordRound(betWei, payoutWei, won ? 1.9 : 0);

    channel.games.push({
      nonce: channel.nonce,
      game: 'coinflip',
      bet: toEth(betWei),
      choice,
      result,
      won,
      payout: toEth(payoutWei),
      timestamp: Date.now(),
    });

    const signature = await ctx.signState(
      channel.agent, channel.agentBalance, channel.casinoBalance, channel.nonce
    );

    ctx.pendingCommits.delete(commitKey);

    return {
      choice,
      result,
      won,
      payout: toEth(payoutWei),
      agentBalance: toEth(channel.agentBalance),
      casinoBalance: toEth(channel.casinoBalance),
      nonce: channel.nonce,
      signature,
      proof: { casinoSeed, agentSeed, resultHash: proof.resultHash },
    };
  }

  getInfo() {
    return {
      ...super.getInfo(),
      choices: ['heads', 'tails'],
      payout: '1.9x',
      minBet: '0.0001 ETH',
    };
  }
}

module.exports = CoinflipGame;
