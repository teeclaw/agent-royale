/**
 * Ownership Transfer Security Tests
 *
 * Run: npx hardhat test test/ownership-transfer.js
 */

const { expect } = require('chai');
const { ethers } = require('hardhat');
const { time } = require('@nomicfoundation/hardhat-network-helpers');

describe('CasinoChannel — Ownership Transfer', function () {
  let contract, casino, newOwner, agent, attacker;
  const MAX_EXPOSURE = ethers.parseEther('100');
  const TWO_DAYS = 2 * 24 * 60 * 60;

  beforeEach(async function () {
    [casino, newOwner, agent, attacker] = await ethers.getSigners();
    const Factory = await ethers.getContractFactory('CasinoChannel');
    contract = await Factory.deploy(casino.address, MAX_EXPOSURE);
    await contract.waitForDeployment();
  });

  describe('Initiation', function () {
    it('owner can initiate transfer', async function () {
      const tx = await contract.connect(casino).transferCasino(newOwner.address);
      const receipt = await tx.wait();
      const block = await ethers.provider.getBlock(receipt.blockNumber);

      await expect(tx)
        .to.emit(contract, 'OwnershipTransferRequested')
        .withArgs(casino.address, newOwner.address, block.timestamp + TWO_DAYS);

      expect(await contract.pendingCasino()).to.equal(newOwner.address);
    });

    it('rejects zero address', async function () {
      await expect(contract.connect(casino).transferCasino(ethers.ZeroAddress))
        .to.be.revertedWith('Zero address');
    });

    it('rejects transfer to self', async function () {
      await expect(contract.connect(casino).transferCasino(casino.address))
        .to.be.revertedWith('Already owner');
    });

    it('non-owner cannot initiate', async function () {
      await expect(contract.connect(attacker).transferCasino(attacker.address))
        .to.be.revertedWithCustomError(contract, 'NotCasino');
    });

    it('blocks transfer when channels are open', async function () {
      // Agent opens channel
      await contract.connect(agent).openChannel({ value: ethers.parseEther('0.01') });
      // Casino funds it
      await contract.connect(casino).fundCasinoSide(agent.address, { value: ethers.parseEther('0.01') });

      await expect(contract.connect(casino).transferCasino(newOwner.address))
        .to.be.revertedWithCustomError(contract, 'ActiveChannelsExist');
    });
  });

  describe('Acceptance', function () {
    beforeEach(async function () {
      await contract.connect(casino).transferCasino(newOwner.address);
    });

    it('rejects acceptance before timelock', async function () {
      await expect(contract.connect(newOwner).acceptCasino())
        .to.be.revertedWithCustomError(contract, 'TransferNotReady');
    });

    it('succeeds after timelock', async function () {
      await time.increase(TWO_DAYS);

      await expect(contract.connect(newOwner).acceptCasino())
        .to.emit(contract, 'OwnershipTransferCompleted')
        .withArgs(casino.address, newOwner.address);

      expect(await contract.casino()).to.equal(newOwner.address);
      expect(await contract.pendingCasino()).to.equal(ethers.ZeroAddress);
    });

    it('wrong address cannot accept', async function () {
      await time.increase(TWO_DAYS);
      await expect(contract.connect(attacker).acceptCasino())
        .to.be.revertedWith('Not pending');
    });

    it('blocks acceptance if channel opened during timelock', async function () {
      // Channel opens during the 2-day wait
      await contract.connect(agent).openChannel({ value: ethers.parseEther('0.01') });
      await contract.connect(casino).fundCasinoSide(agent.address, { value: ethers.parseEther('0.01') });

      await time.increase(TWO_DAYS);

      await expect(contract.connect(newOwner).acceptCasino())
        .to.be.revertedWithCustomError(contract, 'ActiveChannelsExist');
    });
  });

  describe('Cancellation', function () {
    beforeEach(async function () {
      await contract.connect(casino).transferCasino(newOwner.address);
    });

    it('owner can cancel', async function () {
      await expect(contract.connect(casino).cancelTransferCasino())
        .to.emit(contract, 'OwnershipTransferCancelled')
        .withArgs(casino.address);

      expect(await contract.pendingCasino()).to.equal(ethers.ZeroAddress);
    });

    it('acceptance fails after cancel', async function () {
      await contract.connect(casino).cancelTransferCasino();
      await time.increase(TWO_DAYS);

      await expect(contract.connect(newOwner).acceptCasino())
        .to.be.revertedWith('Not pending');
    });

    it('non-owner cannot cancel', async function () {
      await expect(contract.connect(attacker).cancelTransferCasino())
        .to.be.revertedWithCustomError(contract, 'NotCasino');
    });

    it('reverts when nothing to cancel', async function () {
      await contract.connect(casino).cancelTransferCasino();
      await expect(contract.connect(casino).cancelTransferCasino())
        .to.be.revertedWithCustomError(contract, 'NoPendingTransfer');
    });
  });

  describe('Post-transfer', function () {
    it('new owner has full control', async function () {
      await contract.connect(casino).transferCasino(newOwner.address);
      await time.increase(TWO_DAYS);
      await contract.connect(newOwner).acceptCasino();

      // Old owner locked out
      await expect(contract.connect(casino).pause())
        .to.be.revertedWithCustomError(contract, 'NotCasino');

      // New owner works
      await contract.connect(newOwner).pause();
      expect(await contract.paused()).to.be.true;
    });

    it('new owner can initiate another transfer', async function () {
      await contract.connect(casino).transferCasino(newOwner.address);
      await time.increase(TWO_DAYS);
      await contract.connect(newOwner).acceptCasino();

      // Chain transfer
      await expect(contract.connect(newOwner).transferCasino(attacker.address))
        .to.emit(contract, 'OwnershipTransferRequested');
    });
  });
});
