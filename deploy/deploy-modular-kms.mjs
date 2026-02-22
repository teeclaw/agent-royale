/**
 * Deploy Modular Casino Suite to Base Mainnet via GCP KMS
 *
 * Deploys 4 contracts in dependency order:
 *   1. RelayRouter        — Privacy relay (standalone)
 *   2. BankrollManager    — Exposure tracking (needs ChannelManager, set after)
 *   3. InsuranceFund      — Treasury (needs ChannelManager, set after)
 *   4. ChannelManager     — Core channels (references InsuranceFund + BankrollManager)
 *   5. Wire: set ChannelManager as authorized caller in BankrollManager + InsuranceFund
 */

import { ethers } from 'ethers';
import { KmsSigner } from '../../scripts/kms-signer.mjs';
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

const BASE_RPC = 'https://mainnet.base.org';
const MAX_EXPOSURE = ethers.parseEther('50');
const KMS_ADDRESS = '0x1Af5f519DC738aC0f3B58B19A4bB8A8441937e78';

function loadArtifact(name) {
  const p = resolve(__dirname, `../artifacts/contracts/${name}.sol/${name}.json`);
  return JSON.parse(readFileSync(p, 'utf-8'));
}

async function deployContract(signer, artifact, args, label) {
  const factory = new ethers.ContractFactory(artifact.abi, artifact.bytecode, signer);
  console.log(`\n⚡ Deploying ${label}...`);

  const contract = await factory.deploy(...args);
  const tx = contract.deploymentTransaction();
  console.log(`   Tx: ${tx.hash}`);
  console.log('   Waiting...');

  await contract.waitForDeployment();
  const addr = await contract.getAddress();
  console.log(`   ✅ ${label}: ${addr}`);
  return { contract, address: addr };
}

async function main() {
  console.log('═══════════════════════════════════════════════');
  console.log('  AGENT CASINO — MODULAR DEPLOYMENT (Base)');
  console.log('  4 contracts via GCP Cloud KMS');
  console.log('═══════════════════════════════════════════════\n');

  const provider = new ethers.JsonRpcProvider(BASE_RPC);
  const signer = new KmsSigner(provider);
  const address = await signer.getAddress();

  const balance = await provider.getBalance(address);
  console.log('Deployer (KMS):', address);
  console.log('Balance:       ', ethers.formatEther(balance), 'ETH');
  console.log('Max exposure:  ', ethers.formatEther(MAX_EXPOSURE), 'ETH');

  if (balance < ethers.parseEther('0.001')) {
    console.error('\n❌ Need at least 0.001 ETH for 4 deployments + wiring.');
    process.exit(1);
  }

  // Load artifacts
  const relayArt = loadArtifact('RelayRouter');
  const bankrollArt = loadArtifact('BankrollManager');
  const insuranceArt = loadArtifact('InsuranceFund');
  const channelArt = loadArtifact('ChannelManager');

  // ─── Step 1: Deploy RelayRouter (standalone) ───────────
  const relay = await deployContract(signer, relayArt,
    [address],
    'RelayRouter');

  // ─── Step 2: Deploy BankrollManager ────────────────────
  // Use a placeholder for channelManager, we'll set it after ChannelManager deploys
  // Actually BankrollManager needs channelManager in constructor.
  // We'll use address(1) as placeholder and update via setChannelManager
  // No — constructor requires non-zero. Use deployer as temp, then update.
  const bankroll = await deployContract(signer, bankrollArt,
    [address, address, MAX_EXPOSURE],  // casino, channelManager (temp=deployer), maxExposure
    'BankrollManager');

  // ─── Step 3: Deploy InsuranceFund ──────────────────────
  const insurance = await deployContract(signer, insuranceArt,
    [address, address],  // casino, channelManager (temp=deployer)
    'InsuranceFund');

  // ─── Step 4: Deploy ChannelManager ─────────────────────
  const channel = await deployContract(signer, channelArt,
    [address, insurance.address, bankroll.address],
    'ChannelManager');

  // ─── Step 5: Wire modules ─────────────────────────────
  console.log('\n🔗 Wiring modules...');

  // Set ChannelManager as authorized caller in BankrollManager
  const bankrollContract = new ethers.Contract(bankroll.address, bankrollArt.abi, signer);
  const tx1 = await bankrollContract.setChannelManager(channel.address);
  await tx1.wait();
  console.log('   BankrollManager → ChannelManager:', channel.address, '✅');

  // Set ChannelManager as authorized caller in InsuranceFund
  const insuranceContract = new ethers.Contract(insurance.address, insuranceArt.abi, signer);
  const tx2 = await insuranceContract.setChannelManager(channel.address);
  await tx2.wait();
  console.log('   InsuranceFund → ChannelManager:', channel.address, '✅');

  // ─── Verify Wiring ────────────────────────────────────
  console.log('\n── Post-deploy verification ──');

  const channelContract = new ethers.Contract(channel.address, channelArt.abi, provider);
  const relayContract = new ethers.Contract(relay.address, relayArt.abi, provider);

  const checks = await Promise.all([
    channelContract.casino(),
    bankrollContract.channelManager(),
    bankrollContract.maxExposure(),
    insuranceContract.channelManager(),
    relayContract.casino(),
    relayContract.relayEnabled(),
  ]);

  console.log('ChannelManager.casino():    ', checks[0], checks[0] === address ? '✅' : '❌');
  console.log('BankrollMgr.channelManager:', checks[1], checks[1] === channel.address ? '✅' : '❌');
  console.log('BankrollMgr.maxExposure:   ', ethers.formatEther(checks[2]), 'ETH');
  console.log('InsuranceFund.channelMgr:  ', checks[3], checks[3] === channel.address ? '✅' : '❌');
  console.log('RelayRouter.casino():      ', checks[4], checks[4] === address ? '✅' : '❌');
  console.log('RelayRouter.enabled:       ', checks[5] ? '✅' : '❌');

  // ─── Summary ──────────────────────────────────────────
  const finalBalance = await provider.getBalance(address);
  const spent = balance - finalBalance;

  console.log('\n═══════════════════════════════════════════════');
  console.log('  ✅ ALL 4 CONTRACTS DEPLOYED + WIRED');
  console.log('═══════════════════════════════════════════════');
  console.log(`  ChannelManager:  ${channel.address}`);
  console.log(`  BankrollManager: ${bankroll.address}`);
  console.log(`  InsuranceFund:   ${insurance.address}`);
  console.log(`  RelayRouter:     ${relay.address}`);
  console.log(`  Casino operator: ${address}`);
  console.log(`  Total gas spent: ${ethers.formatEther(spent)} ETH`);
  console.log('');
  console.log('  BaseScan:');
  console.log(`    https://basescan.org/address/${channel.address}`);
  console.log(`    https://basescan.org/address/${bankroll.address}`);
  console.log(`    https://basescan.org/address/${insurance.address}`);
  console.log(`    https://basescan.org/address/${relay.address}`);
  console.log('');
  console.log('  .env:');
  console.log(`    CHANNEL_MANAGER=${channel.address}`);
  console.log(`    BANKROLL_MANAGER=${bankroll.address}`);
  console.log(`    INSURANCE_FUND=${insurance.address}`);
  console.log(`    RELAY_ROUTER=${relay.address}`);
}

main().catch(err => {
  console.error('\n❌ Deploy failed:', err.message || err);
  process.exit(1);
});
