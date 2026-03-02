const { expect } = require("chai");
const { ethers } = require("hardhat");

describe("PrivacyRitualPolygonWithLZReceiver", () => {
  let lzEndpoint, semaphoreVerifier, ritual;
  let deployer, hub, user, attacker;

  beforeEach(async () => {
    [deployer, hub, user, attacker] = await ethers.getSigners();

    // ============================
    // Mock LayerZero endpoint
    // ============================
    const LZEndpointMock = await ethers.getContractFactory(`
      // SPDX-License-Identifier: MIT
      pragma solidity ^0.8.20;
      contract LZEndpointMock {
          function send(uint32, bytes32, bytes calldata) external {}
      }
    `);
    lzEndpoint = await LZEndpointMock.deploy();
    await lzEndpoint.waitForDeployment();

    // ============================
    // Mock Semaphore verifier
    // ============================
    const SemaphoreMock = await ethers.getContractFactory(`
      // SPDX-License-Identifier: MIT
      pragma solidity ^0.8.20;
      contract SemaphoreMock {
          bool public nextReturn;
          function setReturn(bool _value) external { nextReturn = _value; }
          function verifyProof(
              bytes32, bytes32, bytes32, uint256[8] calldata
          ) external view returns (bool) {
              return nextReturn;
          }
      }
    `);
    semaphoreVerifier = await SemaphoreMock.deploy();
    await semaphoreVerifier.waitForDeployment();

    // ============================
    // Mock base Ritual contract (PrivacyRitualBase)
    // ============================
    const RitualBaseMockFactory = await ethers.getContractFactory(`
      // SPDX-License-Identifier: MIT
      pragma solidity ^0.8.20;

      import "contracts/PrivacyRitualPolygonWithLZReceiver.sol";

      abstract contract PrivacyRitualBase {
          address public immutable lzEndpoint;
          address public immutable interchangeHub;
          mapping(bytes32 => bool) public nullifiers;
          mapping(uint256 => bytes32) public roots;
          event RootPropagated(bytes32 root, uint32 chainId, uint64 timestamp);
          event RitualProven(bytes32 groupRoot, bytes32 nullifierHash, uint32 chainId, address caller);

          constructor(address _lz, address _hub) {
              lzEndpoint = _lz;
              interchangeHub = _hub;
          }

          modifier onlyHub() {
              require(msg.sender == interchangeHub, "Base: only hub");
              _;
          }

          function _consumeNullifier(bytes32 n) internal {
              require(!nullifiers[n], "Base: nullifier used");
              nullifiers[n] = true;
          }

          function _storeRoot(uint256 gid, bytes32 root) internal {
              roots[gid] = root;
          }
      }
    `);
    // (NOTE: Imported abstract only for inheritance simulation in test environment)
    // Solidity imports abstract parent for correctness but ignored at runtime

    // Deploy target ritual contract
    const Ritual = await ethers.getContractFactory("PrivacyRitualPolygonWithLZReceiver", {
      signer: deployer,
      libraries: {},
    });
    ritual = await Ritual.deploy(
      await lzEndpoint.getAddress(),
      hub.address,
      await semaphoreVerifier.getAddress()
    );
    await ritual.waitForDeployment();
  });

  describe("Deployment", () => {
    it("sets correct immutable addresses", async () => {
      expect(await ritual.lzEndpoint()).to.equal(await lzEndpoint.getAddress());
      expect(await ritual.semaphoreVerifier()).to.equal(await semaphoreVerifier.getAddress());
      expect(await ritual.baseHubPacked()).to.equal(
        ethers.zeroPadValue(hub.address, 32)
      );
    });
  });

  describe("Ritual proof verification", () => {
    it("verifies a valid proof and emits event", async () => {
      await semaphoreVerifier.setReturn(true);

      const dummyProof = ethers.AbiCoder.defaultAbiCoder().encode(
        ["uint256[8]"],
        [[1, 2, 3, 4, 5, 6, 7, 8]]
      );

      const root = ethers.keccak256(ethers.toUtf8Bytes("groupRoot"));
      const nullifier = ethers.keccak256(ethers.toUtf8Bytes("nullifier"));
      const signal = ethers.keccak256(ethers.toUtf8Bytes("signal"));

      const tx = await ritual.connect(user).verifyRitualProof(root, nullifier, signal, dummyProof);
      await expect(tx)
        .to.emit(ritual, "RitualProven")
        .withArgs(root, nullifier, 137, user.address);

      expect(await ritual.nullifiers(nullifier)).to.be.true;
    });

    it("fails if verifier returns false", async () => {
      await semaphoreVerifier.setReturn(false);
      const dummyProof = ethers.AbiCoder.defaultAbiCoder().encode(["uint256[8]"], [[1, 2, 3, 4, 5, 6, 7, 8]]);
      const root = ethers.keccak256(ethers.toUtf8Bytes("rootX"));
      const nullifier = ethers.keccak256(ethers.toUtf8Bytes("nullifierX"));
      const signal = ethers.keccak256(ethers.toUtf8Bytes("signalX"));
      const result = await ritual.callStatic.verifyRitualProof(root, nullifier, signal, dummyProof);
      expect(result).to.be.false;
    });
  });

  describe("LayerZero receive hook", () => {
    it("stores root and emits RootPropagated", async () => {
      const groupId = 1;
      const root = ethers.keccak256(ethers.toUtf8Bytes("root1"));
      const payload = ethers.AbiCoder.defaultAbiCoder().encode(["uint256", "bytes32"], [groupId, root]);

      await expect(
        ritual.connect(lzEndpoint.runner).lzReceive(
          100,
          ethers.zeroPadValue(hub.address, 32),
          payload
        )
      )
        .to.emit(ritual, "RootPropagated")
        .withArgs(root, 100, await currentBlockTimestamp());
    });

    it("reverts if sender is not LayerZero endpoint", async () => {
      const payload = ethers.AbiCoder.defaultAbiCoder().encode(["uint256", "bytes32"], [1, ethers.ZeroHash]);
      await expect(ritual.connect(attacker).lzReceive(1, ethers.ZeroHash, payload))
        .to.be.revertedWith("Ritual: invalid LZ caller");
    });
  });

  describe("Root propagation", () => {
    it("allows only hub to trigger propagateRoot", async () => {
      const root = ethers.keccak256(ethers.toUtf8Bytes("rootA"));
      await expect(ritual.connect(attacker).propagateRoot(root, 42))
        .to.be.revertedWith("Base: only hub");

      await expect(ritual.connect(hub).propagateRoot(root, 42))
        .to.emit(ritual, "RootPropagated");
    });
  });
});

async function currentBlockTimestamp() {
  const block = await ethers.provider.getBlock("latest");
  return block.timestamp;
}
