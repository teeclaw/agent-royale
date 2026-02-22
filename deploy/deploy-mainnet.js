/**
 * Deploy CasinoChannel to Base Mainnet
 *
 * CAUTION: Real money. Double-check everything.
 */

const { ethers } = require('hardhat');

async function main() {
  const [deployer] = await ethers.getSigners();
  console.log('=== BASE MAINNET DEPLOYMENT ===');
  console.log('Deployer:', deployer.address);

  const balance = await ethers.provider.getBalance(deployer.address);
  console.log('Balance:', ethers.formatEther(balance), 'ETH');

  if (balance < ethers.parseEther('0.01')) {
    console.error('Insufficient balance for deployment');
    process.exit(1);
  }

  const casinoAddress = process.env.CASINO_ADDRESS || deployer.address;
  const maxExposure = ethers.parseEther(process.env.MAX_EXPOSURE || '50');

  console.log('Casino operator:', casinoAddress);
  console.log('Max exposure:', ethers.formatEther(maxExposure), 'ETH');

  // Confirmation prompt
  console.log('\n⚠️  MAINNET DEPLOYMENT - Real funds at risk');
  console.log('Press Ctrl+C within 10 seconds to abort...');
  await new Promise(r => setTimeout(r, 10000));

  // Deploy
  const CasinoChannel = await ethers.getContractFactory('CasinoChannel');
  const casino = await CasinoChannel.deploy(casinoAddress, maxExposure);
  await casino.waitForDeployment();

  const address = await casino.getAddress();
  console.log('\n✅ CasinoChannel deployed to:', address);
  console.log(`CASINO_CHANNEL_CONTRACT=${address}`);

  // Verify
  if (process.env.BASESCAN_API_KEY) {
    console.log('\nVerifying on BaseScan...');
    try {
      await hre.run('verify:verify', {
        address,
        constructorArguments: [casinoAddress, maxExposure],
      });
      console.log('Verified!');
    } catch (err) {
      console.log('Verification failed:', err.message);
    }
  }
}

main()
  .then(() => process.exit(0))
  .catch(err => {
    console.error(err);
    process.exit(1);
  });
