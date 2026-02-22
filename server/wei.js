/**
 * Wei Utilities
 *
 * All internal balance math uses BigInt (wei).
 * These helpers make conversion clean at API boundaries.
 */

const { ethers } = require('ethers');

const ZERO = 0n;

/**
 * Convert ETH string or number to wei BigInt.
 * Handles: "0.001", 0.001, "1000000000000000" (already wei string)
 */
function toWei(value) {
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number') return ethers.parseEther(value.toString());
  if (typeof value === 'string') {
    // If it looks like a wei value (no decimal, large number), treat as wei
    if (!value.includes('.') && value.length > 10) return BigInt(value);
    return ethers.parseEther(value);
  }
  throw new Error(`Cannot convert ${typeof value} to wei`);
}

/**
 * Convert wei BigInt to ETH string.
 */
function toEth(wei) {
  return ethers.formatEther(wei);
}

/**
 * Convert wei BigInt to ETH number (for display only, NOT for math).
 */
function toEthNumber(wei) {
  return parseFloat(ethers.formatEther(wei));
}

module.exports = { toWei, toEth, toEthNumber, ZERO };
