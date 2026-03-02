const { expect } = require("chai");
const { ethers } = require("hardhat");

describe("RootRegistry", function () {
  let RootRegistry, registry;
  let ritual, attacker;
  const zeroAddr = "0x0000000000000000000000000000000000000000";

  beforeEach(async function () {
    [ritual, attacker] = await ethers.getSigners();

    RootRegistry = await ethers.getContractFactory("RootRegistry");
    registry = await RootRegistry.deploy(ritual.address);
    await registry.waitForDeployment();
  });

  describe("Deployment", function () {
    it("should set the ritual contract address correctly", async function () {
      expect(await registry.ritualContract()).to.equal(ritual.address);
    });

    it("should revert if ritual contract address is zero", async function () {
      const RootRegistryFactory = await ethers.getContractFactory("RootRegistry");
      await expect(RootRegistryFactory.deploy(zeroAddr))
        .to.be.revertedWith("Registry: zero ritual");
    });
  });

  describe("Access control", function () {
    it("should allow only ritual contract to store roots", async function () {
      const groupId = 1;
      const newRoot = ethers.keccak256(ethers.toUtf8Bytes("root-1"));

      // Ritual sender
      await expect(
        registry.connect(ritual).storeRoot(groupId, newRoot)
      )
        .to.emit(registry, "RootUpdated")
        .withArgs(groupId, newRoot, await timeNow());

      // Unauthorized sender
      await expect(
        registry.connect(attacker).storeRoot(groupId, newRoot)
      ).to.be.revertedWith("Registry: unauthorized");
    });
  });

  describe("State and getters", function () {
    it("should store and retrieve the latest root and timestamp", async function () {
      const groupId = 42;
      const newRoot = ethers.keccak256(ethers.toUtf8Bytes("test-root"));

      const tx = await registry.connect(ritual).storeRoot(groupId, newRoot);
      const receipt = await tx.wait();
      const blockTs = (await ethers.provider.getBlock(receipt.blockNumber)).timestamp;

      const [storedRoot, storedTimestamp] = await registry.getRoot(groupId);
      expect(storedRoot).to.equal(newRoot);
      expect(storedTimestamp).to.equal(blockTs);

      expect(await registry.latestRoot(groupId)).to.equal(newRoot);
      expect(await registry.lastUpdated(groupId)).to.equal(blockTs);
    });
  });
});

// Helper to normalize timestamp checking logic with minor block delay allowance
async function timeNow() {
  const block = await ethers.provider.getBlock("latest");
  return block.timestamp;
}
