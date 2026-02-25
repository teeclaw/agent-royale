import { ethers } from 'ethers';
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { KmsSigner } from '../../scripts/kms-signer.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));

const BASE_RPC = process.env.BASE_RPC_URL || 'https://mainnet.base.org';
const ENTROPY_ADDRESS = process.env.ENTROPY_ADDRESS;
const ENTROPY_PROVIDER = process.env.ENTROPY_PROVIDER;
const ENTROPY_ADMIN = process.env.ENTROPY_ADMIN || '0x1Af5f519DC738aC0f3B58B19A4bB8A8441937e78';
const CALLBACK_GAS_LIMIT = process.env.ENTROPY_CALLBACK_GAS_LIMIT
  ? Number(process.env.ENTROPY_CALLBACK_GAS_LIMIT)
  : null;

if (!ENTROPY_ADDRESS) throw new Error('Missing ENTROPY_ADDRESS');
if (!ENTROPY_PROVIDER) throw new Error('Missing ENTROPY_PROVIDER');

function loadArtifact(name) {
  const p = resolve(__dirname, `../artifacts/contracts/${name}.sol/${name}.json`);
  return JSON.parse(readFileSync(p, 'utf-8'));
}

async function main() {
  const provider = new ethers.JsonRpcProvider(BASE_RPC);
  const signer = new KmsSigner(provider);
  const deployer = await signer.getAddress();

  console.log('Network: base (8453)');
  console.log('Deployer (KMS):', deployer);
  console.log('Admin:', ENTROPY_ADMIN);
  console.log('Entropy:', ENTROPY_ADDRESS);
  console.log('Provider:', ENTROPY_PROVIDER);

  const balance = await provider.getBalance(deployer);
  console.log('Balance:', ethers.formatEther(balance), 'ETH');

  const artifact = loadArtifact('EntropyCoinflip');
  const factory = new ethers.ContractFactory(artifact.abi, artifact.bytecode, signer);

  const deployTxReq = await factory.getDeployTransaction(ENTROPY_ADMIN, ENTROPY_ADDRESS, ENTROPY_PROVIDER);
  const gas = await provider.estimateGas({ ...deployTxReq, from: deployer });
  const feeData = await provider.getFeeData();
  const gasPrice = feeData.maxFeePerGas || feeData.gasPrice;
  console.log('Gas estimate:', gas.toString(), 'cost≈', ethers.formatEther(gas * gasPrice), 'ETH');

  const contract = await factory.deploy(ENTROPY_ADMIN, ENTROPY_ADDRESS, ENTROPY_PROVIDER);
  const tx = contract.deploymentTransaction();
  console.log('Deploy tx:', tx.hash);
  await contract.waitForDeployment();
  const address = await contract.getAddress();
  console.log('EntropyCoinflip deployed:', address);

  if (CALLBACK_GAS_LIMIT && ENTROPY_ADMIN.toLowerCase() === deployer.toLowerCase()) {
    const setTx = await contract.setCallbackGasLimit(CALLBACK_GAS_LIMIT);
    await setTx.wait();
    console.log('Callback gas limit set:', CALLBACK_GAS_LIMIT, 'tx:', setTx.hash);
  }

  console.log('\nSet env:');
  console.log(`ENTROPY_COINFLIP=${address}`);
  console.log('RNG_PROVIDER=pyth_entropy');
  console.log('BaseScan:', `https://basescan.org/address/${address}`);
}

main().catch((e) => {
  console.error('Deploy failed:', e.message);
  process.exit(1);
});
