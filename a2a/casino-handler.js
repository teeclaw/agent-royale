/**
 * A2A Casino Handler (Plugin-Aware)
 *
 * Routes A2A messages to game plugins via the engine.
 * Game actions auto-discovered from registered plugins.
 * No code changes needed when adding new games.
 *
 * Action format: {gameName}_{action}
 *   e.g. slots_commit, lotto_buy, blackjack_deal
 *
 * System actions (always available):
 *   relay_fund, open_channel, close_channel, channel_status, info, stats, games
 */

const { ethers } = require('ethers');

const MAX_CHANNELS = 50;
const MIN_DEPOSIT = '0.001';
const MAX_DEPOSIT = '10';

class CasinoA2AHandler {
  constructor(engine, relay) {
    this.engine = engine;
    this.relay = relay;
  }

  /**
   * Handle incoming A2A message.
   */
  async handle(a2aMessage) {
    try {
      const content = a2aMessage.message?.content || a2aMessage;
      const { action, ...params } = content;

      if (!action) {
        return this._error('Missing action field');
      }

      // Check system actions first
      const systemHandler = this._getSystemHandler(action);
      if (systemHandler) {
        const result = await systemHandler(params);
        return this._respond(result);
      }

      // Route to game plugin via engine
      const stealthAddress = params.stealthAddress;
      if (!stealthAddress && !['info', 'stats', 'games'].includes(action)) {
        // Check if it's a status-type action that doesn't need an address
        const isStatusAction = action.endsWith('_status') || action.endsWith('_history') || action.endsWith('_info');
        if (!isStatusAction) {
          return this._error('Missing stealthAddress');
        }
      }

      const result = await this.engine.handleGameAction(action, stealthAddress, params);
      return this._respond(result);

    } catch (err) {
      return this._error(err.message);
    }
  }

  // ─── System Actions ─────────────────────────────────────

  _getSystemHandler(action) {
    const handlers = {
      relay_fund: (p) => this._relayFund(p),
      open_channel: (p) => this._openChannel(p),
      close_channel: (p) => this._closeChannel(p),
      channel_status: (p) => this._channelStatus(p),
      info: () => this._info(),
      stats: () => this._stats(),
      games: () => this._games(),
    };

    return handlers[action] || null;
  }

  async _relayFund(params) {
    return await this.relay.fundStealth(params.stealthAddress, params.amount, params.payment);
  }

  _openChannel(params) {
    // Validate address
    if (!params.stealthAddress || !ethers.isAddress(params.stealthAddress)) {
      throw new Error('Invalid stealthAddress');
    }

    // Validate deposits
    const agentDep = params.agentDeposit;
    const casinoDep = params.casinoDeposit;
    if (!agentDep || !casinoDep) throw new Error('Missing deposit amounts');

    let agentWei, casinoWei;
    try {
      agentWei = ethers.parseEther(agentDep.toString());
      casinoWei = ethers.parseEther(casinoDep.toString());
    } catch {
      throw new Error('Invalid deposit format');
    }

    if (agentWei <= 0n || casinoWei <= 0n) throw new Error('Deposits must be positive');
    if (agentWei < ethers.parseEther(MIN_DEPOSIT)) throw new Error(`Min deposit: ${MIN_DEPOSIT} ETH`);
    if (agentWei > ethers.parseEther(MAX_DEPOSIT)) throw new Error(`Max deposit: ${MAX_DEPOSIT} ETH`);

    // Channel limits
    if (this.engine.channels.has(params.stealthAddress)) {
      throw new Error('Channel already exists for this address');
    }
    if (this.engine.channels.size >= MAX_CHANNELS) {
      throw new Error('Max concurrent channels reached');
    }

    return this.engine.openChannel(params.stealthAddress, agentDep, casinoDep);
  }

  async _closeChannel(params) {
    if (!params.stealthAddress || !ethers.isAddress(params.stealthAddress)) {
      throw new Error('Invalid stealthAddress');
    }

    // Require signature proving ownership
    const channel = this.engine.channels.get(params.stealthAddress);
    if (!channel) throw new Error('No active channel for this address');

    if (!params.signature) {
      throw new Error('Signature required to close channel. Sign: "close_channel:{stealthAddress}:{nonce}"');
    }

    const message = `close_channel:${params.stealthAddress}:${channel.nonce}`;
    let recovered;
    try {
      recovered = ethers.verifyMessage(message, params.signature);
    } catch {
      throw new Error('Invalid signature format');
    }

    if (recovered.toLowerCase() !== params.stealthAddress.toLowerCase()) {
      throw new Error('Signature does not match channel owner');
    }

    return await this.engine.closeChannel(params.stealthAddress);
  }

  _channelStatus(params) {
    if (!params.stealthAddress || !ethers.isAddress(params.stealthAddress)) {
      throw new Error('Invalid stealthAddress');
    }
    return this.engine.getChannelStatus(params.stealthAddress);
  }

  _info() {
    return {
      name: 'Agent Casino',
      version: '1.0.0',
      chain: 'eip155:8453',
      contract: this.engine.contractAddress,
      privacy: {
        ipLogging: false,
        identityRequired: false,
        stealthAddresses: true,
        relayFunding: true,
        onchainFootprint: 'deposit and withdrawal only',
      },
      games: this.engine.getRegisteredGames(),
      actions: {
        system: ['relay_fund', 'open_channel', 'close_channel', 'channel_status', 'info', 'stats', 'games'],
        games: this.engine.getAvailableActions(),
      },
    };
  }

  _stats() {
    return this.engine.getStats();
  }

  _games() {
    return this.engine.getRegisteredGames();
  }

  // ─── Response Formatting ────────────────────────────────

  _respond(content) {
    return {
      version: '0.3.0',
      from: { name: 'AgentCasino' },
      message: {
        contentType: 'application/json',
        content,
      },
    };
  }

  _error(message) {
    return {
      version: '0.3.0',
      from: { name: 'AgentCasino' },
      message: {
        contentType: 'application/json',
        content: { error: true, message },
      },
    };
  }
}

module.exports = CasinoA2AHandler;
