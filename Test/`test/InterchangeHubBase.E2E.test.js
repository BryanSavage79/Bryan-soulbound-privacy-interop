const { expect } = require("chai");
const { ethers } = require("hardhat");

describe("InterchangeHubBase End‑to‑End", function () {
  let hubBase, mockEndpoint, polygonRitual;
  let deployer, owner, anotherChain;

  beforeEach(async () => {
    [deployer, owner, anotherChain] = await ethers.getSigners();

    // --------------------------------------------------------
    // 1. Mock LayerZero Endpoint
    // --------------------------------------------------------
    const LZEndpointMock = await ethers.getContractFactory(`
      // SPDX-License-Identifier: MIT
      pragma solidity ^0.8.20;

      interface ILayerZeroReceiver {
          function lzReceive(uint32 srcEid, bytes32 sender, bytes calldata payload) external;
      }

      contract LZEndpointMock {
          event LZSend(uint32 dstEid, bytes payload, uint64 timestamp);
          address public lastReceiver;
          uint32  public lastDstEid;
          bytes   public lastPayload;

          // Mock quote ‑ always returns flat fee
          function quote(
              uint32, bytes calldata, bytes calldata, bool
          ) external pure returns (uint256 nativeFee, uint256 lzTokenFee) {
              nativeFee = 1e15; // 0.001 ETH
              lzTokenFee = 0;
          }

          function send(
              uint32 dstEid,
              bytes calldata payload,
              bytes calldata,
              (uint256,uint256) calldata,
              address
          ) external payable {
              lastDstEid = dstEid;
              lastPayload = payload;
              emit LZSend(dstEid, payload, uint64(block.timestamp));
          }

          // helper to simulate delivery from Base to destination ritual
          function simulateReceive(
              uint32 srcEid,
              address destReceiver,
              address baseHub
          ) external {
              bytes memory payload = abi.encode(1234, bytes32("mockroot")); // simple test payload
              ILayerZeroReceiver(destReceiver).lzReceive(
                  srcEid,
                  bytes32(uint256(uint160(baseHub))),
                  payload
              );
          }
      }
    `);
    mockEndpoint = await LZEndpointMock.deploy();
    await mockEndpoint.waitForDeployment();

    // --------------------------------------------------------
    // 2. Mock Polygon Privacy Ritual Receiver
    // --------------------------------------------------------
    const RitualReceiverMock = await ethers.getContractFactory(`
      // SPDX-License-Identifier: MIT
      pragma solidity ^0.8.20;
      import "../contracts/InterchangeHubBase.sol";
      contract RitualReceiverMock is IPrivacyRitualRootReceiver {
          event RootAccepted(uint256 gid, bytes32 root, address caller);
          uint256 public lastGroupId;
          bytes32 public lastRoot;
          function onRootReceived(uint256 gid, bytes32 root) external override {
              lastGroupId = gid;
              lastRoot = root;
              emit RootAccepted(gid, root, msg.sender);
          }
      }
    `);
    polygonRitual = await RitualReceiverMock.deploy();
    await polygonRitual.waitForDeployment();

    // --------------------------------------------------------
    // 3. Deploy InterchangeHubBase (Base chain)
    // --------------------------------------------------------
    const Hub = await ethers.getContractFactory("InterchangeHubBase");
    hubBase = await Hub.deploy(await mockEndpoint.getAddress());
    await hubBase.waitForDeployment();
  });

  it("should set and broadcast canonical root to Polygon chain", async () => {
    const eidPolygon = 200; // mock endpoint ID for Polygon
    const groupId = 1234;
    const root = ethers.keccak256(ethers.toUtf8Bytes("CanonicalRootV1"));

    // Configure chain + enable
    await hubBase.setChainConfig(eidPolygon, await polygonRitual.getAddress(), true);

    // Set canonical group root
    const tx = await hubBase.setGroupRoot(groupId, root);
    await expect(tx)
      .to.emit(hubBase, "GroupRootUpdated")
      .withArgs(groupId, root, await now());

    // Confirm stored
    const [storedRoot] = await hubBase.getGroupRoot(groupId);
    expect(storedRoot).to.equal(root);

    // Broadcast to chain
    const quote = await hubBase.quoteBroadcastRoot.staticCall(eidPolygon, groupId);
    const fee = quote.nativeFee ?? quote[0]; // fallback for struct vs tuple

    await expect(
      hubBase.broadcastRootToChain(eidPolygon, groupId, { value: fee })
    )
      .to.emit(hubBase, "RootBroadcastScheduled")
      .withArgs(groupId, root, eidPolygon, await polygonRitual.getAddress());
  });

  it("should simulate message delivery and emit RootBroadcastDelivered", async () => {
    // prepare a base group + chain config
    const eidPolygon = 201;
    const groupId = 1234;
    await hubBase.setChainConfig(eidPolygon, await polygonRitual.getAddress(), true);
    await hubBase.setGroupRoot(groupId, bytes32("mockroot"));

    // simulate an inbound message from Polygon back to Base through LZ endpoint
    const payload = ethers.AbiCoder.defaultAbiCoder().encode(
      ["uint256", "bytes32"],
      [groupId, bytes32("mockroot")]
    );

    const tx = await hubBase.lzReceive(
      eidPolygon,
      ethers.zeroPadValue(await polygonRitual.getAddress(), 32),
      payload
    );

    const receipt = await tx.wait();
    const log = receipt.logs.find(log => log.fragment?.name === "RootBroadcastDelivered");
    expect(log).to.not.be.undefined;
    expect(log.args.groupId).to.equal(groupId);
    expect(log.args.groupRoot).to.equal(bytes32("mockroot"));
    expect(log.args.srcEid).to.equal(eidPolygon);
  });
});

// helper util
async function now() {
  const block = await ethers.provider.getBlock("latest");
  return block.timestamp;
}
