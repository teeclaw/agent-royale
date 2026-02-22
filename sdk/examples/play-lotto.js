#!/usr/bin/env node

/**
 * Example: Play Lotto
 *
 * Usage: node play-lotto.js [casinoUrl] [depositEth] [pickedNumber] [tickets]
 */

const AgentCasinoClient = require('../agent-client');

const CASINO_URL = process.argv[2] || 'http://localhost:3847/a2a/casino';
const DEPOSIT = parseFloat(process.argv[3] || '0.01');
const PICKED = parseInt(process.argv[4] || Math.floor(Math.random() * 100) + 1);
const TICKETS = parseInt(process.argv[5] || '1');

async function main() {
  const client = new AgentCasinoClient(CASINO_URL);

  console.log('Starting casino session...');
  const session = await client.startSession(DEPOSIT);
  console.log(`Stealth address: ${session.stealthAddress}`);
  console.log();

  // Check lotto status
  const lottoInfo = await client.getLottoStatus();
  console.log(`Current draw: #${lottoInfo.drawId}`);
  console.log(`Draw time: ${new Date(lottoInfo.drawTime).toISOString()}`);
  console.log(`Ticket price: ${lottoInfo.ticketPrice} ETH`);
  console.log(`Payout: ${lottoInfo.payoutMultiplier}x`);
  console.log(`Range: 1-${lottoInfo.range}`);
  console.log();

  // Buy tickets
  console.log(`Buying ${TICKETS} ticket(s) for number ${PICKED}...`);
  const result = await client.buyLottoTicket(PICKED, TICKETS);

  console.log(`Tickets purchased!`);
  console.log(`  Draw: #${result.drawId}`);
  console.log(`  Number: ${result.pickedNumber}`);
  console.log(`  Cost: ${result.cost} ETH`);
  console.log(`  Balance: ${result.agentBalance} ETH`);
  console.log(`  Draw at: ${new Date(result.drawTime).toISOString()}`);
  console.log();
  console.log('Waiting for draw... (check back after draw time)');
}

main().catch(err => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
