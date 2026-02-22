/**
 * Relay Funding Service
 *
 * Breaks the onchain link between agent identity and casino channel.
 *
 * Flow:
 *   1. Agent pays casino off-chain (x402 or direct ETH to casino wallet)
 *   2. Casino calls relayFund() on contract → funds stealth address
 *   3. Onchain: casino → stealth (no agent identity visible)
 *
 * The agent's real address never appears in any casino transaction.
 */

const { ethers } = require('ethers');

class RelayService {
  constructor(casinoWallet, channelContract) {
    this.casino = casinoWallet;
    this.contract = channelContract;
  }

  /**
   * Fund a stealth address via the contract's relayFund().
   *
   * @param {string} stealthAddress - The stealth address to fund
   * @param {number} amountEth - Amount in ETH
   * @param {object} paymentProof - Proof that agent paid off-chain
   * @returns {object} Transaction details
   */
  async fundStealth(stealthAddress, amountEth, paymentProof) {
    if (!this._verifyPayment(paymentProof, amountEth)) {
      throw new Error('Off-chain payment not verified');
    }

    if (!ethers.isAddress(stealthAddress)) {
      throw new Error('Invalid stealth address');
    }

    const amountWei = ethers.parseEther(amountEth.toString());

    const tx = await this.contract.relayFund(stealthAddress, {
      value: amountWei,
    });

    const receipt = await tx.wait();

    return {
      stealthAddress,
      amountEth,
      txHash: tx.hash,
      blockNumber: receipt.blockNumber,
      gasUsed: receipt.gasUsed.toString(),
    };
  }

  /**
   * Direct ETH funding (when relay contract not used).
   * Casino sends ETH directly to stealth address.
   */
  async fundDirect(stealthAddress, amountEth) {
    const tx = await this.casino.sendTransaction({
      to: stealthAddress,
      value: ethers.parseEther(amountEth.toString()),
    });

    const receipt = await tx.wait();

    return {
      stealthAddress,
      amountEth,
      txHash: tx.hash,
      blockNumber: receipt.blockNumber,
    };
  }

  /**
   * Verify off-chain payment proof.
   * Supports: x402 receipt, direct ETH transfer to casino.
   */
  _verifyPayment(proof, expectedAmount) {
    if (!proof) return false;

    switch (proof.type) {
      case 'x402':
        return proof.verified && proof.amount >= expectedAmount;

      case 'direct_transfer':
        // Verify ETH was sent to casino address
        return proof.txHash && proof.amount >= expectedAmount && proof.confirmed;

      case 'prepaid':
        // Agent has prepaid credits
        return proof.credits >= expectedAmount;

      default:
        return false;
    }
  }
}

module.exports = RelayService;
