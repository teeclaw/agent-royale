/**
 * Deploy CasinoChannel to Base Sepolia
 */

const { ethers } = require('hardhat');

async function main() {
  const [deployer] = await ethers.getSigners();
  console.log('Deploying with:', deployer.address);

  const balance = await ethers.provider.getBalance(deployer.address);
  console.log('Balance:', ethers.formatEther(balance), 'ETH');

  // Casino operator address (can be same as deployer for testnet)
  const casinoAddress = process.env.CASINO_ADDRESS || deployer.address;
  const maxExposure = ethers.parseEther(process.env.MAX_EXPOSURE || '10');

  console.log('Casino operator:', casinoAddress);
  console.log('Max exposure:', ethers.formatEther(maxExposure), 'ETH');

  // Deploy
  const CasinoChannel = await ethers.getContractFactory('CasinoChannel');
  const casino = await CasinoChannel.deploy(casinoAddress, maxExposure);
  await casino.waitForDeployment();

  const address = await casino.getAddress();
  console.log('CasinoChannel deployed to:', address);

  // Verify contract state
  const owner = await casino.casino();
  const exposure = await casino.maxCasinoExposure();
  console.log('Casino operator:', owner);
  console.log('Max exposure:', ethers.formatEther(exposure), 'ETH');
  console.log('Insurance fund:', ethers.formatEther(await casino.insuranceFund()), 'ETH');

  console.log('\nAdd to .env:');
  console.log(`CASINO_CHANNEL_CONTRACT=${address}`);

  // Verify on BaseScan (if API key provided)
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
