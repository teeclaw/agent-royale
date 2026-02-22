/**
 * Deploy CasinoChannel to Base Mainnet via GCP KMS
 *
 * Key never leaves hardware. Signs deployment tx via Cloud KMS HSM.
 * Casino operator = KMS wallet (0x1Af5f519DC738aC0f3B58B19A4bB8A8441937e78)
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

async function main() {
  console.log('═══════════════════════════════════════════');
  console.log('  AGENT CASINO — BASE MAINNET DEPLOYMENT');
  console.log('  Signing via GCP Cloud KMS (HSM)');
  console.log('═══════════════════════════════════════════\n');

  // Setup provider + KMS signer
  const provider = new ethers.JsonRpcProvider(BASE_RPC);
  const signer = new KmsSigner(provider);
  const address = await signer.getAddress();

  console.log('Deployer (KMS):', address);
  console.log('Chain ID:       8453 (Base)');
  console.log('Max exposure:  ', ethers.formatEther(MAX_EXPOSURE), 'ETH');
  console.log('Casino operator:', address, '(same as deployer)');

  // Check balance
  const balance = await provider.getBalance(address);
  console.log('Balance:        ', ethers.formatEther(balance), 'ETH');

  if (balance < ethers.parseEther('0.0005')) {
    console.error('\n❌ Insufficient balance. Need ~0.0005 ETH for deployment gas on Base.');
    process.exit(1);
  }

  // Load compiled artifact
  const artifactPath = resolve(__dirname, '../artifacts/contracts/CasinoChannel.sol/CasinoChannel.json');
  const artifact = JSON.parse(readFileSync(artifactPath, 'utf-8'));

  // Estimate gas first
  console.log('\nEstimating gas...');
  const factory = new ethers.ContractFactory(artifact.abi, artifact.bytecode, signer);
  const deployTx = await factory.getDeployTransaction(address, MAX_EXPOSURE);

  const feeData = await provider.getFeeData();
  const gasEstimate = await provider.estimateGas({ ...deployTx, from: address });
  const estimatedCost = gasEstimate * (feeData.maxFeePerGas || feeData.gasPrice);

  console.log('Gas estimate:   ', gasEstimate.toString());
  console.log('Estimated cost: ', ethers.formatEther(estimatedCost), 'ETH');
  console.log('Max fee/gas:    ', ethers.formatUnits(feeData.maxFeePerGas || feeData.gasPrice, 'gwei'), 'gwei');

  // Deploy
  console.log('\n⚡ Deploying (KMS signing)...');
  const contract = await factory.deploy(address, MAX_EXPOSURE);

  console.log('Tx hash:        ', contract.deploymentTransaction().hash);
  console.log('Waiting for confirmation...');

  await contract.waitForDeployment();
  const contractAddress = await contract.getAddress();

  console.log('\n═══════════════════════════════════════════');
  console.log('  ✅ DEPLOYED');
  console.log('═══════════════════════════════════════════');
  console.log('Contract:       ', contractAddress);
  console.log('Casino operator:', address);
  console.log('Tx:             ', contract.deploymentTransaction().hash);
  console.log('BaseScan:        https://basescan.org/address/' + contractAddress);
  console.log(`\nAdd to .env:\nCASINO_CHANNEL_CONTRACT=${contractAddress}`);

  // Quick sanity check
  const deployed = new ethers.Contract(contractAddress, artifact.abi, provider);
  const casino = await deployed.casino();
  const maxExp = await deployed.maxCasinoExposure();
  const paused = await deployed.paused();

  console.log('\n── Post-deploy verification ──');
  console.log('casino():         ', casino, casino === address ? '✅' : '❌');
  console.log('maxCasinoExposure:', ethers.formatEther(maxExp), 'ETH', maxExp === MAX_EXPOSURE ? '✅' : '❌');
  console.log('paused():         ', paused, !paused ? '✅' : '⚠️');
}

main().catch(err => {
  console.error('\n❌ Deploy failed:', err.message);
  process.exit(1);
});
