/**
 * Deploy ChannelManager + wire all 4 modules.
 *
 * Already deployed:
 *   RelayRouter:     0x7Ccf9A9a35219f7B6FAe02DAB5c8a5130F9F23CC
 *   BankrollManager: 0x52717d801F76AbDA82350c673050D5f5c8213451
 *   InsuranceFund:   0xb961b7C7cD68A9BC746483Fb56D52F564FD822c2
 */

import { ethers } from 'ethers';
import { KmsSigner } from '../../scripts/kms-signer.mjs';
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const BASE_RPC = 'https://mainnet.base.org';
const KMS = '0x1Af5f519DC738aC0f3B58B19A4bB8A8441937e78';
const RELAY = '0x7Ccf9A9a35219f7B6FAe02DAB5c8a5130F9F23CC';
const BANKROLL = '0x52717d801F76AbDA82350c673050D5f5c8213451';
const INSURANCE = '0xb961b7C7cD68A9BC746483Fb56D52F564FD822c2';

function loadABI(name) {
  return JSON.parse(readFileSync(resolve(__dirname, `../artifacts/contracts/${name}.sol/${name}.json`), 'utf-8'));
}

async function main() {
  const provider = new ethers.JsonRpcProvider(BASE_RPC);
  const signer = new KmsSigner(provider);

  const channelArt = loadABI('ChannelManager');
  const bankrollArt = loadABI('BankrollManager');
  const insuranceArt = loadABI('InsuranceFund');

  // Deploy ChannelManager
  console.log('⚡ Deploying ChannelManager...');
  const factory = new ethers.ContractFactory(channelArt.abi, channelArt.bytecode, signer);
  const contract = await factory.deploy(KMS, INSURANCE, BANKROLL);
  console.log('Tx:', contract.deploymentTransaction().hash);
  await contract.waitForDeployment();
  const CHANNEL = await contract.getAddress();
  console.log('✅ ChannelManager:', CHANNEL);

  // Small delay to avoid nonce race
  await new Promise(r => setTimeout(r, 3000));

  // Wire BankrollManager
  console.log('\n🔗 BankrollManager.setChannelManager...');
  const bankroll = new ethers.Contract(BANKROLL, bankrollArt.abi, signer);
  const tx1 = await bankroll.setChannelManager(CHANNEL);
  await tx1.wait();
  console.log('✅ Done');

  await new Promise(r => setTimeout(r, 3000));

  // Wire InsuranceFund
  console.log('🔗 InsuranceFund.setChannelManager...');
  const insurance = new ethers.Contract(INSURANCE, insuranceArt.abi, signer);
  const tx2 = await insurance.setChannelManager(CHANNEL);
  await tx2.wait();
  console.log('✅ Done');

  // Verify
  console.log('\n── Verify ──');
  const ch = new ethers.Contract(CHANNEL, channelArt.abi, provider);
  const [casino, bCM, iCM] = await Promise.all([
    ch.casino(),
    bankroll.channelManager(),
    insurance.channelManager(),
  ]);
  console.log('casino():', casino === KMS ? '✅' : '❌');
  console.log('bankroll.channelMgr:', bCM === CHANNEL ? '✅' : '❌');
  console.log('insurance.channelMgr:', iCM === CHANNEL ? '✅' : '❌');

  console.log('\n═══════════════════════════════════════');
  console.log('  ✅ MODULAR CASINO FULLY DEPLOYED');
  console.log('═══════════════════════════════════════');
  console.log(`  ChannelManager:  ${CHANNEL}`);
  console.log(`  BankrollManager: ${BANKROLL}`);
  console.log(`  InsuranceFund:   ${INSURANCE}`);
  console.log(`  RelayRouter:     ${RELAY}`);
}

main().catch(err => { console.error('❌', err.message); process.exit(1); });
