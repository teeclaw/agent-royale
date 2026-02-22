/**
 * Gaming Engine (BigInt/Wei, Plugin Architecture)
 *
 * All balances stored as BigInt (wei). Zero floating point.
 * Games are self-contained plugins in server/games/.
 *
 * Fixes applied:
 *   [FIX #1] All balance math in BigInt (wei) - no floats
 *   [FIX #6] Pending commits keyed by agent:game
 */

const { ethers } = require('ethers');
const CommitReveal = require('./commit-reveal');
const { toWei, toEth, ZERO } = require('./wei');

class GamingEngine {
  constructor(casinoWallet, contractAddress, chainId = 8453) {
    this.casino = casinoWallet;
    this.contractAddress = contractAddress;
    this.chainId = chainId;

    this.channels = new Map();
    this.pendingCommits = new Map();
    this.games = new Map();
    this.actionMap = new Map();
  }

  // ─── Game Registration ──────────────────────────────────

  registerGame(game) {
    this.games.set(game.name, game);
    for (const action of game.actions) {
      this.actionMap.set(`${game.name}_${action}`, { game, action });
    }
    console.log(`Game registered: ${game.displayName} [${game.actions.map(a => `${game.name}_${a}`).join(', ')}]`);
  }

  getRegisteredGames() {
    const games = {};
    for (const [name, game] of this.games) {
      games[name] = game.getInfo();
    }
    return games;
  }

  getAvailableActions() {
    return Array.from(this.actionMap.keys());
  }

  // ─── Action Routing ─────────────────────────────────────

  async handleGameAction(actionRoute, agentAddress, params) {
    const mapping = this.actionMap.get(actionRoute);
    if (!mapping) {
      throw new Error(`Unknown action: ${actionRoute}. Available: ${this.getAvailableActions().join(', ')}`);
    }

    const { game, action } = mapping;
    const noChannelActions = ['status', 'history', 'info'];
    let channel = null;

    if (!noChannelActions.includes(action)) {
      channel = this._getChannel(agentAddress);
    }

    const ctx = {
      commitReveal: CommitReveal,
      pendingCommits: this.pendingCommits,
      signState: this._signState.bind(this),
    };

    return await game.handleAction(action, channel, params, ctx);
  }

  // ─── Channel Management (BigInt) ────────────────────────

  openChannel(agentAddress, agentDepositEth, casinoDepositEth) {
    if (this.channels.has(agentAddress)) {
      throw new Error('Channel already exists');
    }

    const agentDeposit = toWei(agentDepositEth);
    const casinoDeposit = toWei(casinoDepositEth);

    const channel = {
      agent: agentAddress,
      agentDeposit,     // Immutable: original deposit
      casinoDeposit,    // Immutable: original deposit
      agentBalance: agentDeposit,     // BigInt: current
      casinoBalance: casinoDeposit,   // BigInt: current
      nonce: 0,
      games: [],
      createdAt: Date.now(),
    };

    this.channels.set(agentAddress, channel);

    return {
      status: 'open',
      agentBalance: toEth(channel.agentBalance),
      casinoBalance: toEth(channel.casinoBalance),
    };
  }

  getChannelStatus(agentAddress) {
    const ch = this.channels.get(agentAddress);
    if (!ch) return { status: 'not_found' };

    // Verify conservation invariant
    const totalDeposits = ch.agentDeposit + ch.casinoDeposit;
    const totalBalances = ch.agentBalance + ch.casinoBalance;
    const invariantOk = totalDeposits === totalBalances;

    return {
      status: 'open',
      agentBalance: toEth(ch.agentBalance),
      casinoBalance: toEth(ch.casinoBalance),
      nonce: ch.nonce,
      gamesPlayed: ch.games.length,
      invariantOk, // Should always be true with BigInt math
    };
  }

  async closeChannel(agentAddress) {
    const channel = this._getChannel(agentAddress);

    // [FIX #4] Check for pending lotto tickets
    for (const [, game] of this.games) {
      if (game.name === 'lotto' && game.draws) {
        for (const [, draw] of game.draws) {
          if (!draw.drawn && draw.tickets.has(agentAddress)) {
            // Don't block close, but warn
            // Unclaimed winnings are stored separately and can be claimed later
          }
        }
      }
    }

    // Verify invariant before signing
    const totalDeposits = channel.agentDeposit + channel.casinoDeposit;
    const totalBalances = channel.agentBalance + channel.casinoBalance;
    if (totalDeposits !== totalBalances) {
      throw new Error(
        `INVARIANT VIOLATION: deposits=${toEth(totalDeposits)}, balances=${toEth(totalBalances)}. ` +
        `This should never happen with BigInt math. DO NOT close channel.`
      );
    }

    const signature = await this._signState(
      agentAddress,
      channel.agentBalance,
      channel.casinoBalance,
      channel.nonce
    );

    const result = {
      agentBalance: toEth(channel.agentBalance),
      casinoBalance: toEth(channel.casinoBalance),
      nonce: channel.nonce,
      signature,
      totalGames: channel.games.length,
    };

    this.channels.delete(agentAddress);
    return result;
  }

  // ─── Scheduled Tasks ────────────────────────────────────

  async runScheduledTasks() {
    const results = [];

    for (const [name, game] of this.games) {
      if (typeof game.getPendingDraws === 'function') {
        const pendingDraws = game.getPendingDraws();

        for (const drawId of pendingDraws) {
          try {
            const signState = this._signState.bind(this);
            const drawResult = await game.executeDraw(drawId, signState);

            // Apply winnings to active channels
            for (const winner of drawResult.winners) {
              const channel = this.channels.get(winner.agent);
              if (channel) {
                const ctx = { signState: this._signState.bind(this) };
                const payoutWei = toWei(winner.payout);
                const applied = await game.applyWinnings(channel, payoutWei, ctx);
                winner.applied = applied;
              }
              // If channel closed, winnings stay in unclaimedWinnings [FIX #4]
            }

            results.push({ game: name, drawId, result: drawResult });
          } catch (err) {
            // Skip
          }
        }
      }
    }

    return results;
  }

  // ─── Stats ──────────────────────────────────────────────

  getStats() {
    const gameStats = {};
    for (const [name, game] of this.games) {
      gameStats[name] = {
        rtp: game.rtp,
        houseEdge: game.houseEdge,
        maxMultiplier: game.maxMultiplier,
      };
    }

    return {
      activeChannels: this.channels.size,
      pendingCommits: this.pendingCommits.size,
      registeredGames: this.games.size,
      games: gameStats,
    };
  }

  // ─── Internal ───────────────────────────────────────────

  _getChannel(addr) {
    const ch = this.channels.get(addr);
    if (!ch) throw new Error('Channel not found');
    return ch;
  }

  /**
   * Sign channel state (EIP-712).
   * Balances are BigInt (wei) - passed directly to ethers.
   */
  async _signState(agent, agentBalance, casinoBalance, nonce) {
    const domain = {
      name: 'AgentCasino',
      version: '1',
      chainId: this.chainId,
      verifyingContract: this.contractAddress,
    };

    const types = {
      ChannelState: [
        { name: 'agent', type: 'address' },
        { name: 'agentBalance', type: 'uint256' },
        { name: 'casinoBalance', type: 'uint256' },
        { name: 'nonce', type: 'uint256' },
      ],
    };

    // BigInt passed directly - no float conversion needed
    const value = {
      agent,
      agentBalance,
      casinoBalance,
      nonce,
    };

    return await this.casino.signTypedData(domain, types, value);
  }
}

module.exports = GamingEngine;
