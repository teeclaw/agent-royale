/**
 * Deploy remaining 3 contracts + wire everything.
 * RelayRouter already at 0x7Ccf9A9a35219f7B6FAe02DAB5c8a5130F9F23CC
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
const RELAY_ADDRESS = '0x7Ccf9A9a35219f7B6FAe02DAB5c8a5130F9F23CC';

function loadArtifact(name) {
  const p = resolve(__dirname, `../artifacts/contracts/${name}.sol/${name}.json`);
  return JSON.parse(readFileSync(p, 'utf-8'));
}

async function deployContract(signer, provider, artifact, args, label) {
  const factory = new ethers.ContractFactory(artifact.abi, artifact.bytecode, signer);

  // Get fresh nonce
  const nonce = await provider.getTransactionCount(await signer.getAddress(), 'latest');
  console.log(`\n⚡ Deploying ${label} (nonce: ${nonce})...`);

  const contract = await factory.deploy(...args, { nonce });
  const tx = contract.deploymentTransaction();
  console.log(`   Tx: ${tx.hash}`);

  await contract.waitForDeployment();
  const addr = await contract.getAddress();
  console.log(`   ✅ ${label}: ${addr}`);
  return { contract, address: addr };
}

async function main() {
  console.log('═══════════════════════════════════════════════');
  console.log('  Deploying BankrollManager + InsuranceFund + ChannelManager');
  console.log('═══════════════════════════════════════════════\n');

  const provider = new ethers.JsonRpcProvider(BASE_RPC);
  const signer = new KmsSigner(provider);
  const address = await signer.getAddress();
  const balance = await provider.getBalance(address);

  console.log('Deployer:', address);
  console.log('Balance: ', ethers.formatEther(balance), 'ETH');
  console.log('RelayRouter (existing):', RELAY_ADDRESS);

  const bankrollArt = loadArtifact('BankrollManager');
  const insuranceArt = loadArtifact('InsuranceFund');
  const channelArt = loadArtifact('ChannelManager');

  // Deploy BankrollManager (temp channelManager = deployer, updated after)
  const bankroll = await deployContract(signer, provider, bankrollArt,
    [address, address, MAX_EXPOSURE], 'BankrollManager');

  // Deploy InsuranceFund (temp channelManager = deployer)
  const insurance = await deployContract(signer, provider, insuranceArt,
    [address, address], 'InsuranceFund');

  // Deploy ChannelManager
  const channel = await deployContract(signer, provider, channelArt,
    [address, insurance.address, bankroll.address], 'ChannelManager');

  // Wire modules
  console.log('\n🔗 Wiring...');

  const bankrollContract = new ethers.Contract(bankroll.address, bankrollArt.abi, signer);
  const nonce1 = await provider.getTransactionCount(address, 'latest');
  const tx1 = await bankrollContract.setChannelManager(channel.address, { nonce: nonce1 });
  await tx1.wait();
  console.log('   BankrollManager.channelManager →', channel.address, '✅');

  const insuranceContract = new ethers.Contract(insurance.address, insuranceArt.abi, signer);
  const nonce2 = await provider.getTransactionCount(address, 'latest');
  const tx2 = await insuranceContract.setChannelManager(channel.address, { nonce: nonce2 });
  await tx2.wait();
  console.log('   InsuranceFund.channelManager →', channel.address, '✅');

  // Verify
  console.log('\n── Verification ──');
  const chContract = new ethers.Contract(channel.address, channelArt.abi, provider);
  const [casino, bm, im] = await Promise.all([
    chContract.casino(),
    bankrollContract.channelManager(),
    insuranceContract.channelManager(),
  ]);
  console.log('casino():', casino === address ? '✅' : '❌');
  console.log('bankroll.channelMgr:', bm === channel.address ? '✅' : '❌');
  console.log('insurance.channelMgr:', im === channel.address ? '✅' : '❌');

  const finalBal = await provider.getBalance(address);

  console.log('\n═══════════════════════════════════════════════');
  console.log('  ✅ MODULAR CASINO DEPLOYED');
  console.log('═══════════════════════════════════════════════');
  console.log(`  ChannelManager:  ${channel.address}`);
  console.log(`  BankrollManager: ${bankroll.address}`);
  console.log(`  InsuranceFund:   ${insurance.address}`);
  console.log(`  RelayRouter:     ${RELAY_ADDRESS}`);
  console.log(`  Gas spent:       ${ethers.formatEther(balance - finalBal)} ETH`);
  console.log('');
  console.log(`CHANNEL_MANAGER=${channel.address}`);
  console.log(`BANKROLL_MANAGER=${bankroll.address}`);
  console.log(`INSURANCE_FUND=${insurance.address}`);
  console.log(`RELAY_ROUTER=${RELAY_ADDRESS}`);
}

main().catch(err => {
  console.error('\n❌ Failed:', err.message || err);
  process.exit(1);
});
