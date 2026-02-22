/**
 * Agent Casino SDK
 *
 * Client library for agents to interact with the casino.
 * Handles: stealth addresses, commit-reveal verification,
 * state backup, dispute initiation.
 *
 * Usage:
 *   const client = new AgentCasinoClient('https://api.agentroyale.xyz/a2a/casino');
 *   await client.startSession('0.1');
 *   const result = await client.playSlots('0.001');
 *   console.log(result.reels, result.payout);
 *   await client.closeSession();
 */

const { ethers } = require('ethers');
const StealthAddress = require('../privacy/stealth');
const CommitReveal = require('../server/commit-reveal');
const fs = require('fs').promises;
const path = require('path');

class AgentCasinoClient {
  constructor(casinoUrl, options = {}) {
    this.casinoUrl = casinoUrl; // Must be full A2A endpoint, e.g. https://api.agentroyale.xyz/a2a/casino
    this.backupDir = options.backupDir || './casino-states';
    this.stealth = null;
    this.states = [];
    this.gamesPlayed = 0;
  }

  // ─── Session Lifecycle ──────────────────────────────────

  /**
   * Start a new casino session.
   * Generates stealth address, requests relay funding, opens channel.
   *
   * @param {string} depositEth - ETH amount as string, e.g. '0.1'
   * @param {object} options - { masterKey, index } for deterministic stealth, or omit for random
   */
  async startSession(depositEth, options = {}) {
    if (typeof depositEth === 'number') depositEth = depositEth.toString();

    // Generate stealth address
    if (options.masterKey && options.index !== undefined) {
      this.stealth = StealthAddress.deriveFromMaster(options.masterKey, options.index);
    } else {
      this.stealth = StealthAddress.generate();
    }

    await fs.mkdir(this.backupDir, { recursive: true });

    // Request relay funding from casino
    const relayResult = await this._request('relay_fund', {
      stealthAddress: this.stealth.stealthAddress,
      amount: depositEth,
      payment: options.paymentProof || { type: 'prepaid', credits: depositEth },
    });

    // Open channel
    const channelResult = await this._request('open_channel', {
      stealthAddress: this.stealth.stealthAddress,
      agentDeposit: depositEth,
      casinoDeposit: depositEth,
    });

    await this._backup();

    return {
      stealthAddress: this.stealth.stealthAddress,
      relay: relayResult,
      channel: channelResult,
    };
  }

  /**
   * Close session and get final signature for on-chain withdrawal.
   */
  async closeSession() {
    const result = await this._request('close_channel', {
      stealthAddress: this.stealth.stealthAddress,
    });

    this.states.push({
      agentBalance: result.agentBalance,
      casinoBalance: result.casinoBalance,
      nonce: result.nonce,
      signature: result.signature,
      final: true,
      timestamp: Date.now(),
    });

    await this._backup();

    return {
      ...result,
      sessionStats: {
        gamesPlayed: this.gamesPlayed,
        statesStored: this.states.length,
      },
    };
  }

  // ─── Slots ──────────────────────────────────────────────

  /**
   * Play one slot spin with commit-reveal fairness verification.
   * Two-step: commit (get hash), then reveal (send seed, get result).
   *
   * @param {string} betEth - Bet amount as string, e.g. '0.001'
   */
  async playSlots(betEth) {
    if (typeof betEth === 'number') betEth = betEth.toString();

    // Step 1: Get casino's commitment
    const commitResult = await this._request('slots_commit', {
      stealthAddress: this.stealth.stealthAddress,
      betAmount: betEth,
    });

    const { commitment } = commitResult;

    // Step 2: Generate our seed (after seeing commitment, so casino can't predict it)
    const agentSeed = ethers.hexlify(ethers.randomBytes(32));

    // Step 3: Send seed, get result
    const result = await this._request('slots_reveal', {
      stealthAddress: this.stealth.stealthAddress,
      agentSeed,
    });

    // Step 4: VERIFY casino didn't cheat
    this._verifyCommitment(commitment, result);

    // Step 5: Store signed state
    this._storeState(result);
    this.gamesPlayed++;
    await this._backup();

    return result;
  }

  // ─── Coinflip ───────────────────────────────────────────

  /**
   * Play one coinflip with commit-reveal fairness verification.
   *
   * @param {string} betEth - Bet amount as string
   * @param {string} choice - 'heads' or 'tails'
   */
  async playCoinflip(betEth, choice) {
    if (typeof betEth === 'number') betEth = betEth.toString();
    if (!['heads', 'tails'].includes(choice)) {
      throw new Error('Choice must be "heads" or "tails"');
    }

    // Step 1: Commit
    const commitResult = await this._request('coinflip_commit', {
      stealthAddress: this.stealth.stealthAddress,
      betAmount: betEth,
      choice,
    });

    const { commitment } = commitResult;

    // Step 2: Agent seed
    const agentSeed = ethers.hexlify(ethers.randomBytes(32));

    // Step 3: Reveal
    const result = await this._request('coinflip_reveal', {
      stealthAddress: this.stealth.stealthAddress,
      agentSeed,
    });

    // Step 4: Verify
    this._verifyCommitment(commitment, result);

    // Step 5: Store
    this._storeState(result);
    this.gamesPlayed++;
    await this._backup();

    return result;
  }

  // ─── Lotto ──────────────────────────────────────────────

  /**
   * Buy lotto ticket(s).
   *
   * @param {number} pickedNumber - Number 1-100
   * @param {number} ticketCount - 1-10 tickets per draw
   */
  async buyLottoTicket(pickedNumber, ticketCount = 1) {
    const result = await this._request('lotto_buy', {
      stealthAddress: this.stealth.stealthAddress,
      pickedNumber,
      ticketCount,
    });

    this._storeState(result);
    this.gamesPlayed++;
    await this._backup();
    return result;
  }

  /**
   * Get current lotto draw status (draw ID, tickets sold, countdown).
   */
  async getLottoStatus() {
    return await this._request('lotto_status', {});
  }

  /**
   * Get past draw result.
   * @param {number} drawId
   */
  async getLottoHistory(drawId) {
    return await this._request('lotto_history', { drawId });
  }

  /**
   * Claim unclaimed lotto winnings into your channel balance.
   */
  async claimLottoWinnings() {
    const result = await this._request('lotto_claim', {
      stealthAddress: this.stealth.stealthAddress,
    });

    if (result.nonce) this._storeState(result);
    await this._backup();
    return result;
  }

  // ─── Info & Status ──────────────────────────────────────

  /**
   * Get channel status (balances, nonce, games played).
   */
  async getStatus() {
    return await this._request('channel_status', {
      stealthAddress: this.stealth.stealthAddress,
    });
  }

  /**
   * Get casino info (games, rules, contracts, privacy).
   */
  async getCasinoInfo() {
    return await this._request('info', {});
  }

  /**
   * Get all game stats (rounds, wagered, RTP).
   */
  async getStats() {
    return await this._request('stats', {});
  }

  /**
   * Get available games and their rules.
   */
  async getGames() {
    return await this._request('games', {});
  }

  /**
   * Get latest signed state (for on-chain dispute if casino disappears).
   */
  getLatestState() {
    if (this.states.length === 0) return null;
    return this.states[this.states.length - 1];
  }

  /**
   * Get all stored states (full history for dispute evidence).
   */
  getAllStates() {
    return [...this.states];
  }

  // ─── Recovery ───────────────────────────────────────────

  /**
   * Restore session from backup file.
   */
  async restoreSession(backupFile) {
    const data = JSON.parse(await fs.readFile(backupFile, 'utf-8'));
    this.stealth = { stealthAddress: data.stealthAddress };
    this.states = data.states;
    this.gamesPlayed = data.gamesPlayed || 0;
    return data;
  }

  // ─── Internal ───────────────────────────────────────────

  /**
   * Verify casino's commitment matches the revealed seed.
   * Throws if cheating detected and saves evidence.
   */
  _verifyCommitment(commitment, result) {
    if (!result.proof || !result.proof.casinoSeed) return;

    const isValid = CommitReveal.verify(commitment, result.proof.casinoSeed);
    if (!isValid) {
      console.error('!!! CASINO CHEATED - commitment mismatch !!!');
      console.error('Commitment:', commitment);
      console.error('Casino seed:', result.proof.casinoSeed);

      // Save evidence async (don't block)
      this._saveEvidence('commitment_mismatch', {
        commitment,
        casinoSeed: result.proof.casinoSeed,
        result,
        timestamp: Date.now(),
      }).catch(() => {});

      throw new Error('Casino cheated: commitment verification failed. Evidence saved.');
    }
  }

  /**
   * Store a signed state from a game result.
   */
  _storeState(result) {
    if (!result.nonce && result.nonce !== 0) return;
    this.states.push({
      agentBalance: result.agentBalance,
      casinoBalance: result.casinoBalance,
      nonce: result.nonce,
      signature: result.signature,
      timestamp: Date.now(),
    });
  }

  async _request(action, params) {
    const body = {
      version: '0.3.0',
      from: { name: 'Anonymous' },
      message: {
        contentType: 'application/json',
        content: { action, ...params },
      },
    };

    const response = await fetch(this.casinoUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      throw new Error(`Casino returned ${response.status}: ${response.statusText}`);
    }

    const data = await response.json();

    if (data.message?.content?.error) {
      throw new Error(data.message.content.message || 'Unknown casino error');
    }

    return data.message?.content || data;
  }

  async _backup() {
    if (!this.stealth) return;

    const filename = `${this.stealth.stealthAddress.slice(0, 10)}-${Date.now()}.json`;
    const filepath = path.join(this.backupDir, filename);

    await fs.writeFile(filepath, JSON.stringify({
      stealthAddress: this.stealth.stealthAddress,
      states: this.states,
      gamesPlayed: this.gamesPlayed,
      exportedAt: Date.now(),
    }, null, 2));
  }

  async _saveEvidence(type, evidence) {
    const dir = path.join(this.backupDir, 'evidence');
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(
      path.join(dir, `${type}-${Date.now()}.json`),
      JSON.stringify(evidence, null, 2)
    );
  }
}

module.exports = AgentCasinoClient;
