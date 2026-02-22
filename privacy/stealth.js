/**
 * Stealth Address Generator
 *
 * Generates ephemeral addresses for casino sessions.
 * No onchain link between agent identity and stealth address.
 *
 * Usage:
 *   const { stealthAddress, stealthPrivateKey } = StealthAddress.generate();
 *   // Fund stealthAddress via relay service
 *   // Play casino from stealthAddress
 *   // Sweep winnings later
 */

const { ethers } = require('ethers');
const { createHash } = require('crypto');

class StealthAddress {
  /**
   * Generate a fresh random stealth address.
   * No derivation path, no link to any existing key.
   */
  static generate() {
    const wallet = ethers.Wallet.createRandom();
    return {
      stealthAddress: wallet.address,
      stealthPrivateKey: wallet.privateKey,
      stealthPublicKey: wallet.publicKey,
    };
  }

  /**
   * Derive deterministic stealth address from a master key + index.
   * Agent can recreate all stealth addresses from master key alone.
   * Useful for backup/recovery.
   */
  static deriveFromMaster(masterPrivateKey, index) {
    const seed = createHash('sha256')
      .update(masterPrivateKey + ':casino:' + index.toString())
      .digest('hex');

    const wallet = new ethers.Wallet('0x' + seed);
    return {
      stealthAddress: wallet.address,
      stealthPrivateKey: wallet.privateKey,
      index,
    };
  }

  /**
   * Create a wallet instance from stealth private key.
   * Used to sign onchain transactions from stealth address.
   */
  static toWallet(stealthPrivateKey, provider) {
    return new ethers.Wallet(stealthPrivateKey, provider);
  }
}

module.exports = StealthAddress;
