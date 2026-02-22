#!/usr/bin/env node

/**
 * Example: Play Slots
 *
 * Usage: node play-slots.js [casinoUrl] [depositEth] [betEth] [spins]
 */

const AgentCasinoClient = require('../agent-client');

const CASINO_URL = process.argv[2] || 'http://localhost:3847/a2a/casino';
const DEPOSIT = process.argv[3] || '0.01';
const BET = process.argv[4] || '0.001';
const SPINS = parseInt(process.argv[5] || '10');

async function main() {
  const client = new AgentCasinoClient(CASINO_URL);

  console.log('Starting casino session...');
  console.log(`  Deposit: ${DEPOSIT} ETH`);
  console.log(`  Bet per spin: ${BET} ETH`);
  console.log(`  Spins: ${SPINS}`);
  console.log();

  // Start session
  const session = await client.startSession(DEPOSIT);
  console.log(`Stealth address: ${session.stealthAddress}`);
  console.log();

  // Play spins
  for (let i = 1; i <= SPINS; i++) {
    try {
      const result = await client.playSlots(BET);

      const reelStr = result.reels.join(' | ');
      const win = result.payout > 0;

      console.log(
        `Spin ${i}: [ ${reelStr} ] ` +
        (win ? `WIN ${result.multiplier}x = ${result.payout} ETH` : 'MISS') +
        ` | Balance: ${result.agentBalance.toFixed(6)} ETH`
      );
    } catch (err) {
      console.error(`Spin ${i} error: ${err.message}`);
      break;
    }
  }

  console.log();

  // Close session
  const close = await client.closeSession();
  console.log('Session closed.');
  console.log(`  Final balance: ${close.agentBalance} ETH`);
  console.log(`  Games played: ${close.sessionStats.gamesPlayed}`);
  console.log(`  Total bet: ${close.sessionStats.totalBet.toFixed(6)} ETH`);
  console.log(`  Total won: ${close.sessionStats.totalWon.toFixed(6)} ETH`);
  console.log(`  Net: ${close.sessionStats.netResult.toFixed(6)} ETH`);
}

main().catch(err => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
