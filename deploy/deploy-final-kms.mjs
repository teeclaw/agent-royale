/**
 * Deploy InsuranceFund + ChannelManager + wire everything.
 *
 * Already deployed:
 *   RelayRouter:     0x7Ccf9A9a35219f7B6FAe02DAB5c8a5130F9F23CC
 *   BankrollManager: 0x52717d801F76AbDA82350c673050D5f5c8213451
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
const RELAY = '0x7Ccf9A9a35219f7B6FAe02DAB5c8a5130F9F23CC';
const BANKROLL = '0x52717d801F76AbDA82350c673050D5f5c8213451';

function loadArtifact(name) {
  return JSON.parse(readFileSync(resolve(__dirname, `../artifacts/contracts/${name}.sol/${name}.json`), 'utf-8'));
}

async function main() {
  const provider = new ethers.JsonRpcProvider(BASE_RPC);
  const signer = new KmsSigner(provider);
  const address = await signer.getAddress();

  console.log('Deployer:', address);
  console.log('Nonce:', await provider.getTransactionCount(address, 'latest'));

  const insuranceArt = loadArtifact('InsuranceFund');
  const channelArt = loadArtifact('ChannelManager');
  const bankrollArt = loadArtifact('BankrollManager');

  // 1. Deploy InsuranceFund
  console.log('\n⚡ InsuranceFund...');
  const insFactory = new ethers.ContractFactory(insuranceArt.abi, insuranceArt.bytecode, signer);
  const insContract = await insFactory.deploy(address, address); // temp channelMgr = deployer
  await insContract.waitForDeployment();
  const INSURANCE = await insContract.getAddress();
  console.log('   ✅', INSURANCE);

  // 2. Deploy ChannelManager
  console.log('\n⚡ ChannelManager...');
  const chFactory = new ethers.ContractFactory(channelArt.abi, channelArt.bytecode, signer);
  const chContract = await chFactory.deploy(address, INSURANCE, BANKROLL);
  await chContract.waitForDeployment();
  const CHANNEL = await chContract.getAddress();
  console.log('   ✅', CHANNEL);

  // 3. Wire BankrollManager → ChannelManager
  console.log('\n🔗 Wiring BankrollManager...');
  const bankroll = new ethers.Contract(BANKROLL, bankrollArt.abi, signer);
  const tx1 = await bankroll.setChannelManager(CHANNEL);
  await tx1.wait();
  console.log('   ✅ BankrollManager.channelManager =', CHANNEL);

  // 4. Wire InsuranceFund → ChannelManager
  console.log('🔗 Wiring InsuranceFund...');
  const insurance = new ethers.Contract(INSURANCE, insuranceArt.abi, signer);
  const tx2 = await insurance.setChannelManager(CHANNEL);
  await tx2.wait();
  console.log('   ✅ InsuranceFund.channelManager =', CHANNEL);

  // 5. Verify everything
  console.log('\n── Verification ──');
  const channel = new ethers.Contract(CHANNEL, channelArt.abi, provider);
  const [casino, bCM, iCM, bMax, paused] = await Promise.all([
    channel.casino(),
    bankroll.channelManager(),
    insurance.channelManager(),
    bankroll.maxExposure(),
    channel.paused(),
  ]);
  console.log('casino():', casino === address ? '✅' : '❌', casino);
  console.log('bankroll.channelMgr:', bCM === CHANNEL ? '✅' : '❌');
  console.log('insurance.channelMgr:', iCM === CHANNEL ? '✅' : '❌');
  console.log('maxExposure:', ethers.formatEther(bMax), 'ETH');
  console.log('paused:', !paused ? '✅ (active)' : '⚠️');

  const finalBal = await provider.getBalance(address);

  console.log('\n═══════════════════════════════════════════════');
  console.log('  ✅ MODULAR CASINO FULLY DEPLOYED');
  console.log('═══════════════════════════════════════════════');
  console.log(`  ChannelManager:  ${CHANNEL}`);
  console.log(`  BankrollManager: ${BANKROLL}`);
  console.log(`  InsuranceFund:   ${INSURANCE}`);
  console.log(`  RelayRouter:     ${RELAY}`);
  console.log(`  Balance left:    ${ethers.formatEther(finalBal)} ETH`);
}

main().catch(err => { console.error('❌', err.message); process.exit(1); });
