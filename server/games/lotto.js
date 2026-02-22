/**
 * Bookmaker Lotto Plugin (BigInt/Wei)
 *
 * Pick 1 number from 1-100. Match = 85x payout.
 * Bookmaker model: casino is the house.
 *
 * Fixes applied:
 *   [FIX #1] BigInt precision
 *   [FIX #3] Max payout coverage check before selling tickets
 *   [FIX #4] Unclaimed winnings stored separately (survive channel close)
 */

const BaseGame = require('./base-game');
const CommitReveal = require('../commit-reveal');
const { toWei, toEth } = require('../wei');

const RANGE = 100;
const PAYOUT_MULTIPLIER = 85n;
const TICKET_PRICE = toWei('0.001');
const DRAW_INTERVAL = 6 * 60 * 60 * 1000;
const MAX_TICKETS_PER_DRAW = 10;

class LottoGame extends BaseGame {
  constructor() {
    super();
    this.draws = new Map();
    this.currentDrawId = 0;
    this.unclaimedWinnings = new Map(); // [FIX #4] agent → BigInt
    this._lottoStats = { totalTicketsSold: 0, totalDraws: 0 };
    this._startNewDraw();
  }

  get name() { return 'lotto'; }
  get displayName() { return 'Agent Lotto'; }
  get description() { return `Pick a number 1-${RANGE}. Match the draw to win ${PAYOUT_MULTIPLIER}x.`; }
  get rtp() { return 0.85; }
  get maxMultiplier() { return Number(PAYOUT_MULTIPLIER); }
  get actions() { return ['buy', 'status', 'history', 'claim']; }

  async handleAction(action, channel, params, ctx) {
    switch (action) {
      case 'buy': return await this._buy(channel, params, ctx);
      case 'status': return this._status();
      case 'history': return this._history(params);
      case 'claim': return await this._claim(channel, ctx);
      default: throw new Error(`Unknown lotto action: ${action}`);
    }
  }

  // ─── Buy Ticket ─────────────────────────────────────────

  async _buy(channel, params, ctx) {
    const { pickedNumber, ticketCount = 1 } = params;

    if (pickedNumber < 1 || pickedNumber > RANGE) {
      throw new Error(`Pick a number between 1 and ${RANGE}`);
    }
    if (ticketCount < 1 || ticketCount > MAX_TICKETS_PER_DRAW) {
      throw new Error(`Max ${MAX_TICKETS_PER_DRAW} tickets per draw`);
    }

    const costWei = TICKET_PRICE * BigInt(ticketCount);
    if (channel.agentBalance < costWei) {
      throw new Error('Insufficient balance');
    }

    // [FIX #3] Check if casino can cover max payout
    const maxPayoutWei = TICKET_PRICE * PAYOUT_MULTIPLIER * BigInt(ticketCount);
    if (maxPayoutWei > channel.casinoBalance) {
      const maxTickets = Number(channel.casinoBalance / (TICKET_PRICE * PAYOUT_MULTIPLIER));
      throw new Error(
        `Casino can't cover max payout. Max tickets with current bankroll: ${maxTickets}. ` +
        `Max possible payout: ${toEth(maxPayoutWei)} ETH, casino balance: ${toEth(channel.casinoBalance)} ETH`
      );
    }

    const draw = this.draws.get(this.currentDrawId);

    // Per-agent limit
    if (!draw.tickets.has(channel.agent)) {
      draw.tickets.set(channel.agent, []);
    }
    const agentTickets = draw.tickets.get(channel.agent);
    if (agentTickets.length + ticketCount > MAX_TICKETS_PER_DRAW) {
      throw new Error(`Already have ${agentTickets.length} tickets this draw (max ${MAX_TICKETS_PER_DRAW})`);
    }

    // Deduct cost (BigInt)
    channel.agentBalance -= costWei;
    channel.casinoBalance += costWei;
    channel.nonce++;

    for (let i = 0; i < ticketCount; i++) {
      agentTickets.push(pickedNumber);
    }
    draw.totalPool += costWei;
    this._lottoStats.totalTicketsSold += ticketCount;

    // Record as wagered (payout tracked at draw time)
    this._stats.totalRounds++;
    this._stats.totalWagered += costWei;
    this._stats.lastPlayedAt = Date.now();

    const signature = await ctx.signState(
      channel.agent, channel.agentBalance, channel.casinoBalance, channel.nonce
    );

    channel.games.push({
      nonce: channel.nonce,
      game: 'lotto',
      drawId: this.currentDrawId,
      pickedNumber,
      ticketCount,
      cost: toEth(costWei),
      timestamp: Date.now(),
    });

    return {
      drawId: this.currentDrawId,
      pickedNumber,
      ticketCount,
      cost: toEth(costWei),
      maxPossiblePayout: toEth(maxPayoutWei),
      drawTime: draw.drawTime,
      agentBalance: toEth(channel.agentBalance),
      casinoBalance: toEth(channel.casinoBalance),
      nonce: channel.nonce,
      signature,
    };
  }

  // ─── Draw Execution ─────────────────────────────────────

  async executeDraw(drawId, signState) {
    const draw = this.draws.get(drawId);
    if (!draw) throw new Error(`Draw ${drawId} not found`);
    if (draw.drawn) throw new Error(`Draw ${drawId} already executed`);

    const agentEntropy = draw.tickets.size.toString() + ':' + draw.totalPool.toString();
    const { proof } = CommitReveal.computeResult(draw.casinoSeed, agentEntropy, drawId);

    const hashBuf = Buffer.from(proof.resultHash, 'hex');
    const winningNumber = (hashBuf.readUInt32BE(0) % RANGE) + 1;

    draw.winningNumber = winningNumber;
    draw.drawn = true;
    draw.drawnAt = Date.now();

    const winners = [];
    for (const [agent, tickets] of draw.tickets) {
      const matchCount = tickets.filter(t => t === winningNumber).length;
      if (matchCount > 0) {
        const payoutWei = TICKET_PRICE * PAYOUT_MULTIPLIER * BigInt(matchCount);

        // [FIX #4] Store winnings for claiming (survives channel close)
        const existing = this.unclaimedWinnings.get(agent) || 0n;
        this.unclaimedWinnings.set(agent, existing + payoutWei);

        winners.push({
          agent,
          tickets: matchCount,
          payout: toEth(payoutWei),
        });
      }
    }

    this._lottoStats.totalDraws++;

    // Track payouts
    for (const w of winners) {
      const payWei = TICKET_PRICE * PAYOUT_MULTIPLIER * BigInt(w.tickets);
      this._stats.totalPaidOut += payWei;
      this._stats.agentWins++;
      if (payWei > this._stats.biggestWin) {
        this._stats.biggestWin = payWei;
        this._stats.biggestWinMultiplier = Number(PAYOUT_MULTIPLIER);
      }
    }
    if (winners.length === 0) {
      this._stats.houseWins++;
    }

    this._startNewDraw();

    return {
      drawId,
      winningNumber,
      casinoSeed: draw.casinoSeed,
      commitment: draw.commitment,
      winners,
      totalPool: toEth(draw.totalPool),
      totalTickets: Array.from(draw.tickets.values()).flat().length,
    };
  }

  // ─── [FIX #4] Claim Unclaimed Winnings ──────────────────

  async _claim(channel, ctx) {
    const unclaimed = this.unclaimedWinnings.get(channel.agent) || 0n;
    if (unclaimed === 0n) {
      return { claimed: '0', message: 'No unclaimed winnings' };
    }

    // Cap to casino balance
    const claimable = unclaimed > channel.casinoBalance ? channel.casinoBalance : unclaimed;

    channel.agentBalance += claimable;
    channel.casinoBalance -= claimable;
    channel.nonce++;

    // Update or clear unclaimed
    const remaining = unclaimed - claimable;
    if (remaining > 0n) {
      this.unclaimedWinnings.set(channel.agent, remaining);
    } else {
      this.unclaimedWinnings.delete(channel.agent);
    }

    const signature = await ctx.signState(
      channel.agent, channel.agentBalance, channel.casinoBalance, channel.nonce
    );

    return {
      claimed: toEth(claimable),
      remaining: toEth(remaining),
      agentBalance: toEth(channel.agentBalance),
      casinoBalance: toEth(channel.casinoBalance),
      nonce: channel.nonce,
      signature,
    };
  }

  /**
   * Apply winnings directly to active channel (called by engine scheduler).
   */
  async applyWinnings(channel, payoutEth, ctx) {
    // Convert to wei if needed
    const payoutWei = typeof payoutEth === 'bigint' ? payoutEth : toWei(payoutEth);
    const cappedPayout = payoutWei > channel.casinoBalance ? channel.casinoBalance : payoutWei;

    channel.agentBalance += cappedPayout;
    channel.casinoBalance -= cappedPayout;
    channel.nonce++;

    // Remove from unclaimed since we applied directly
    const unclaimed = this.unclaimedWinnings.get(channel.agent) || 0n;
    if (unclaimed >= cappedPayout) {
      const remaining = unclaimed - cappedPayout;
      if (remaining > 0n) {
        this.unclaimedWinnings.set(channel.agent, remaining);
      } else {
        this.unclaimedWinnings.delete(channel.agent);
      }
    }

    const signature = await ctx.signState(
      channel.agent, channel.agentBalance, channel.casinoBalance, channel.nonce
    );

    return { payout: toEth(cappedPayout), signature, nonce: channel.nonce };
  }

  // ─── Status ─────────────────────────────────────────────

  _status() {
    const draw = this.draws.get(this.currentDrawId);
    return {
      drawId: this.currentDrawId,
      commitment: draw.commitment,
      drawTime: draw.drawTime,
      ticketPrice: toEth(TICKET_PRICE),
      payoutMultiplier: Number(PAYOUT_MULTIPLIER),
      range: RANGE,
      totalTickets: Array.from(draw.tickets.values()).flat().length,
      totalPool: toEth(draw.totalPool),
    };
  }

  _history(params) {
    const { drawId } = params;
    const draw = this.draws.get(drawId);
    if (!draw) return { error: 'Draw not found' };
    if (!draw.drawn) return { drawId, status: 'pending', drawTime: draw.drawTime };

    return {
      drawId,
      status: 'completed',
      winningNumber: draw.winningNumber,
      casinoSeed: draw.casinoSeed,
      commitment: draw.commitment,
      totalPool: toEth(draw.totalPool),
      drawnAt: draw.drawnAt,
    };
  }

  // ─── Internal ───────────────────────────────────────────

  _startNewDraw() {
    this.currentDrawId++;
    const { seed, commitment } = CommitReveal.commit();

    this.draws.set(this.currentDrawId, {
      drawId: this.currentDrawId,
      casinoSeed: seed,
      commitment,
      drawTime: Date.now() + DRAW_INTERVAL,
      tickets: new Map(),
      totalPool: 0n, // BigInt
      winningNumber: null,
      drawn: false,
      drawnAt: null,
    });
  }

  getPendingDraws() {
    const pending = [];
    for (const [drawId, draw] of this.draws) {
      if (!draw.drawn && Date.now() >= draw.drawTime) {
        pending.push(drawId);
      }
    }
    return pending;
  }

  getStats() {
    const base = super.getStats();
    const draw = this.draws.get(this.currentDrawId);
    return {
      ...base,
      currentDrawId: this.currentDrawId,
      ticketsSoldThisDraw: Array.from(draw.tickets.values()).flat().length,
      currentPool: toEth(draw.totalPool),
      nextDrawTime: draw.drawTime,
      totalTicketsSold: this._lottoStats.totalTicketsSold,
      totalDraws: this._lottoStats.totalDraws,
      ticketPrice: toEth(TICKET_PRICE),
      payoutMultiplier: `${PAYOUT_MULTIPLIER}x`,
    };
  }

  getInfo() {
    return {
      ...super.getInfo(),
      range: `1-${RANGE}`,
      ticketPrice: toEth(TICKET_PRICE),
      payoutMultiplier: `${PAYOUT_MULTIPLIER}x`,
      drawInterval: '6 hours',
      maxTicketsPerDraw: MAX_TICKETS_PER_DRAW,
      currentDraw: this._status(),
    };
  }
}

module.exports = LottoGame;
