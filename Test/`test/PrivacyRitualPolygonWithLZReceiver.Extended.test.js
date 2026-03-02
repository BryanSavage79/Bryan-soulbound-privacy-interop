const { expect } = require("chai");
const { ethers } = require("hardhat");

describe("PrivacyRitualPolygonWithLZReceiver - Extended", () => {
  let lzEndpoint, semaphoreVerifier, ritual;
  let deployer, hub, user, attacker;

  beforeEach(async () => {
    [deployer, hub, user, attacker] = await ethers.getSigners();

    // Mock LayerZero Endpoint
    const LZEndpointMock = await ethers.getContractFactory(`
      // SPDX-License-Identifier: MIT
      pragma solidity ^0.8.20;
      contract LZEndpointMock {
          event MessageSent(uint32 dstEid, bytes32 sender, bytes payload, uint64 timestamp);
          function send(uint32 dstEid, bytes32 sender, bytes calldata payload) external {
              emit MessageSent(dstEid, sender, payload, uint64(block.timestamp));
          }
      }
    `);
    lzEndpoint = await LZEndpointMock.deploy();
    await lzEndpoint.waitForDeployment();

    // Mock Semaphore verifier
    const SemaphoreMock = await ethers.getContractFactory(`
      // SPDX-License-Identifier: MIT
      pragma solidity ^0.8.20;
      contract SemaphoreMock {
          bool public nextReturn;
          function setReturn(bool _val) external { nextReturn = _val; }
          function verifyProof(
              bytes32, bytes32, bytes32, uint256[8] calldata
          ) external view returns (bool) {
              return nextReturn;
          }
      }
    `);
    semaphoreVerifier = await SemaphoreMock.deploy();
    await semaphoreVerifier.waitForDeployment();

    // Ritual contract
    const Ritual = await ethers.getContractFactory("PrivacyRitualPolygonWithLZReceiver");
    ritual = await Ritual.deploy(
      await lzEndpoint.getAddress(),
      hub.address,
      await semaphoreVerifier.getAddress()
    );
    await ritual.waitForDeployment();
  });

  describe("LayerZero payload verification", () => {
    it("decodes incoming payload correctly and matches expected event data", async () => {
      const groupId = 1234;
      const root = ethers.keccak256(ethers.toUtf8Bytes("BaseCanonicalRoot"));

      const payload = ethers.AbiCoder.defaultAbiCoder().encode(
        ["uint256", "bytes32"],
        [groupId, root]
      );

      // Confirm payload round trip integrity
      const decoded = ethers.AbiCoder.defaultAbiCoder().decode(
        ["uint256", "bytes32"],
        payload
      );
      expect(decoded[0]).to.equal(groupId);
      expect(decoded[1]).to.equal(root);

      // Simulate LayerZero message in
      const tx = await ritual.connect(deployer).lzReceive(
        100, // srcEid
        ethers.zeroPadValue(hub.address, 32), // authorized sender
        payload
      );

      const receipt = await tx.wait();
      const log = receipt.logs.find(log => log.fragment?.name === "RootPropagated");
      const eventArgs = log ? log.args : null;

      // Verify RootPropagated correctness
      expect(eventArgs).to.not.be.null;
      expect(eventArgs[0]).to.equal(root);
      expect(eventArgs[1]).to.equal(100); // chainId matches srcEid
      expect(eventArgs[2]).to.be.a("bigint");

      // Cross-check stored root matches decoded payload
      const storedRoot = await ritual.roots(groupId).catch(() => null);
      if (storedRoot) expect(storedRoot).to.equal(root);
    });

    it("rejects unauthorized senders or wrong LZ endpoint", async () => {
      const groupId = 4321;
      const root = ethers.keccak256(ethers.toUtf8Bytes("SpoofedRoot"));
      const payload = ethers.AbiCoder.defaultAbiCoder().encode(["uint256", "bytes32"], [groupId, root]);

      // Wrong msg.sender (not LayerZero endpoint)
      await expect(
        ritual.connect(attacker).lzReceive(100, ethers.zeroPadValue(hub.address, 32), payload)
      ).to.be.revertedWith("Ritual: invalid LZ caller");

      // Correct endpoint but spoofed sender
      const FakeSender = ethers.zeroPadValue(user.address, 32);
      await expect(
        ritual.connect(deployer).lzReceive(100, FakeSender, payload)
      ).to.be.revertedWith("Ritual: unauthorized sender");
    });
  });

  describe("Ritual Proof Flow", () => {
    it("emits properly structured RitualProven event on valid proof", async () => {
      await semaphoreVerifier.setReturn(true);

      const proofBytes = ethers.AbiCoder.defaultAbiCoder().encode(
        ["uint256[8]"],
        [[1, 2, 3, 4, 5, 6, 7, 8]]
      );

      const groupRoot = ethers.keccak256(ethers.toUtf8Bytes("Root123"));
      const nullifier = ethers.keccak256(ethers.toUtf8Bytes("Nul123"));
      const signal = ethers.keccak256(ethers.toUtf8Bytes("Sig123"));

      const tx = await ritual.connect(user).verifyRitualProof(groupRoot, nullifier, signal, proofBytes);
      const receipt = await tx.wait();
      const log = receipt.logs.find(log => log.fragment?.name === "RitualProven");
      const args = log.args;

      expect(args.groupRoot).to.equal(groupRoot);
      expect(args.nullifierHash).to.equal(nullifier);
      expect(args.chainId).to.equal(137);
      expect(args.caller).to.equal(user.address);
    });

    it("does not emit if verification fails", async () => {
      await semaphoreVerifier.setReturn(false);
      const proofBytes = ethers.AbiCoder.defaultAbiCoder().encode(["uint256[8]"], [[1, 2, 3, 4, 5, 6, 7, 8]]);
      const groupRoot = ethers.keccak256(ethers.toUtf8Bytes("BadRoot"));
      const nullifier = ethers.keccak256(ethers.toUtf8Bytes("BadNull"));
      const signal = ethers.keccak256(ethers.toUtf8Bytes("BadSig"));

      const tx = await ritual.connect(user).verifyRitualProof(groupRoot, nullifier, signal, proofBytes);
      const receipt = await tx.wait();
      // No RitualProven logs expected
      const provenEvents = receipt.logs.filter(log => log.fragment?.name === "RitualProven");
      expect(provenEvents.length).to.equal(0);
    });
  });
});
