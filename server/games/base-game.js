/**
 * BaseGame - Abstract game plugin interface
 *
 * All balances are BigInt (wei). Games convert at API boundaries.
 * Use toWei()/toEth() from server/wei.js for conversion.
 */

const { toEth, ZERO } = require('../wei');

class BaseGame {
  constructor() {
    // Cumulative stats (BigInt where money is involved)
    this._stats = {
      totalRounds: 0,
      totalWagered: 0n,    // wei
      totalPaidOut: 0n,    // wei
      agentWins: 0,
      houseWins: 0,
      biggestWin: 0n,      // wei
      biggestWinMultiplier: 0,
      lastPlayedAt: null,
    };
  }

  // ─── Identity (override required) ───────────────────────

  get name() { throw new Error('Override name'); }
  get displayName() { throw new Error('Override displayName'); }
  get description() { return ''; }

  // ─── Math (override required) ───────────────────────────

  /** @returns {number} Return to player (0-1) */
  get rtp() { throw new Error('Override rtp'); }
  get houseEdge() { return 1 - this.rtp; }

  /** @returns {number} Maximum payout multiplier */
  get maxMultiplier() { throw new Error('Override maxMultiplier'); }

  // ─── Actions (override required) ────────────────────────

  /** @returns {string[]} Action names */
  get actions() { throw new Error('Override actions'); }

  /**
   * Handle an action.
   * @param {string} action
   * @param {object} channel - { agent, agentBalance (BigInt), casinoBalance (BigInt), nonce, games }
   * @param {object} params - Raw params from A2A (ETH strings)
   * @param {object} context - { signState, commitReveal, pendingCommits }
   * @returns {Promise<object>} Result (ETH strings for balances)
   */
  async handleAction(action, channel, params, context) {
    throw new Error(`Override handleAction for ${action}`);
  }

  // ─── Validation (BigInt) ────────────────────────────────

  /**
   * Validate bet amount (BigInt wei) against channel state.
   */
  validateBet(channel, betWei, safetyMargin = 2) {
    if (betWei <= 0n) throw new Error('Bet must be positive');
    if (channel.agentBalance < betWei) {
      throw new Error(`Insufficient balance: have ${toEth(channel.agentBalance)} ETH, need ${toEth(betWei)} ETH`);
    }

    const maxPayout = betWei * BigInt(this.maxMultiplier);
    if (maxPayout * BigInt(safetyMargin) > channel.casinoBalance) {
      const maxBetWei = channel.casinoBalance / BigInt(this.maxMultiplier * safetyMargin);
      throw new Error(`Max bet: ${toEth(maxBetWei)} ETH (bankroll limit)`);
    }
  }

  // ─── Stats Tracking ──────────────────────────────────────

  /**
   * Record a completed round. Call from subclass after resolving.
   * @param {BigInt} betWei
   * @param {BigInt} payoutWei
   * @param {number} multiplier
   */
  recordRound(betWei, payoutWei, multiplier = 0) {
    this._stats.totalRounds++;
    this._stats.totalWagered += betWei;
    this._stats.totalPaidOut += payoutWei;
    this._stats.lastPlayedAt = Date.now();

    if (payoutWei > 0n) {
      this._stats.agentWins++;
      if (payoutWei > this._stats.biggestWin) {
        this._stats.biggestWin = payoutWei;
        this._stats.biggestWinMultiplier = multiplier;
      }
    } else {
      this._stats.houseWins++;
    }
  }

  /**
   * Get stats as display-safe object (ETH strings, no BigInt).
   */
  getStats() {
    const s = this._stats;
    const actualRtp = s.totalWagered > 0n
      ? Number((s.totalPaidOut * 10000n) / s.totalWagered) / 100
      : null;

    return {
      totalRounds: s.totalRounds,
      totalWagered: toEth(s.totalWagered),
      totalPaidOut: toEth(s.totalPaidOut),
      houseProfit: toEth(s.totalWagered - s.totalPaidOut),
      agentWins: s.agentWins,
      houseWins: s.houseWins,
      biggestWin: toEth(s.biggestWin),
      biggestWinMultiplier: s.biggestWinMultiplier,
      actualRtp: actualRtp !== null ? `${actualRtp.toFixed(2)}%` : null,
      targetRtp: `${(this.rtp * 100).toFixed(1)}%`,
      lastPlayedAt: s.lastPlayedAt,
    };
  }

  // ─── Info ───────────────────────────────────────────────

  getInfo() {
    return {
      name: this.name,
      displayName: this.displayName,
      description: this.description,
      rtp: `${(this.rtp * 100).toFixed(1)}%`,
      houseEdge: `${(this.houseEdge * 100).toFixed(1)}%`,
      maxMultiplier: this.maxMultiplier,
      actions: this.actions,
    };
  }
}

module.exports = BaseGame;
