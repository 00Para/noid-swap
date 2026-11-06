#!/usr/bin/env node
/*
 * Record JSON-RPC fixtures for swap-cli's Ethereum watcher
 * (swap-cli/src/watch/eth.rs, swap-cli/tests/watch_eth.rs).
 *
 * Run from the eth/ directory:   npx hardhat run scripts/record-fixtures.js
 *
 * It runs the HTLC through Hardhat's in-process network (local, no network access)
 * and writes the raw JSON the node returned, in the FixtureRpc format
 *   {"description": "...", "calls": [{"method": ..., "params"?: ..., "result": ...}, ...]}
 * to ../swap-cli/fixtures/eth/{locked,pending_claim,claimed,refunded}.json.
 *
 * Responses are served per method in file order, so the order below mirrors the order in
 * which EthWatcher::observe() calls each method. `params` is pinned only where it is
 * deterministic and worth checking (block tags, getCode/getTransactionByHash/eth_call args);
 * eth_getLogs is left unpinned so the Rust side may choose its own fromBlock.
 *
 * Determinism: every block timestamp is forced (evm_setNextBlockTimestamp / evm_mine [ts]),
 * signers are indices 0/1/2 of Hardhat's default accounts and the preimage is the public
 * test vector 00 01 .. 1f, so re-running regenerates byte-identical files. If Hardhat or
 * solc output changes (new Hardhat version, contract edit), hashes and gas may differ.
 *
 * NEVER use this preimage on a real network: it is public.
 */
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const hre = require("hardhat");
const { ethers } = hre;

const OUT_DIR = path.join(__dirname, "..", "..", "swap-cli", "fixtures", "eth");
const BASE_TS = 1893456000; // 2030-01-01T00:00:00Z, later than any real "now" Hardhat starts at
const PREIMAGE = "0x" + Buffer.from([...Array(32).keys()]).toString("hex");
const HASHLOCK = "0x" + crypto.createHash("sha256").update(Buffer.from(PREIMAGE.slice(2), "hex")).digest("hex");
const AMOUNT = ethers.parseEther("0.01");

const send = (method, params = []) => hre.network.provider.send(method, params);
const lower = (s) => s.toLowerCase();

/** Call `method` on the node and append the raw answer (or the error object) to `calls`. */
async function record(calls, method, params, pin) {
  const entry = { method };
  // Deep copy first: Hardhat's provider mutates params objects (it adds a default `from` to eth_call).
  if (pin) entry.params = JSON.parse(JSON.stringify(params));
  try {
    entry.result = await send(method, params);
  } catch (e) {
    const code = e.code !== undefined ? e.code : e.error && e.error.code;
    entry.error = { code: typeof code === "number" ? code : -32000, message: String(e.message).split("\n")[0] };
  }
  calls.push(entry);
}

/** One watcher poll, in the order EthWatcher::observe() makes its calls. */
async function snapshot(ctx, txHashes = []) {
  const { contract, lockId, sender, receiver } = ctx;
  const calls = [];
  const addr = lower(contract.target);
  await record(calls, "eth_blockNumber", [], true);
  await record(calls, "eth_getBlockByNumber", ["latest", false], true);
  await record(calls, "eth_getBlockByNumber", ["finalized", false], true);
  await record(
    calls,
    "eth_getLogs",
    [{
      address: addr,
      fromBlock: "0x0",
      toBlock: "latest",
      topics: [[ethers.id("Locked(bytes32,address,address,uint256,bytes32,uint256)"),
                ethers.id("Claimed(bytes32,bytes32)"),
                ethers.id("Refunded(bytes32)")], lockId],
    }],
    false
  );
  const data = contract.interface.encodeFunctionData("getLock", [lockId]);
  await record(calls, "eth_call", [{ to: addr, data }, "latest"], true);
  await record(calls, "eth_getCode", [lower(sender), "latest"], true);
  await record(calls, "eth_getCode", [lower(receiver), "latest"], true);
  for (const h of txHashes) await record(calls, "eth_getTransactionByHash", [h], true);
  // Not used by the watcher; recorded for reference (the contract is not an EOA).
  await record(calls, "eth_getCode", [addr, "latest"], true);
  return calls;
}

function write(name, description, calls) {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const file = path.join(OUT_DIR, name);
  fs.writeFileSync(file, JSON.stringify({ description, calls }, null, 2) + "\n");
  console.log(`wrote ${path.relative(process.cwd(), file)} (${calls.length} calls)`);
}

async function main() {
  const hhVersion = require("hardhat/package.json").version;
  const [, bob, alice] = await ethers.getSigners();
  const nextTs = (t) => send("evm_setNextBlockTimestamp", [t]);

  await nextTs(BASE_TS);
  const contract = await (await ethers.getContractFactory("HTLC")).deploy();
  await contract.waitForDeployment();
  const chainId = Number((await ethers.provider.getNetwork()).chainId);

  const describe = (what, ctx) =>
    `${what} Recorded by eth/scripts/record-fixtures.js on Hardhat ${hhVersion} (in-process network, chainId ${chainId}); ` +
    `block timestamps are forced so re-running regenerates identical files. ` +
    `contract=${lower(contract.target)} sender(Bob)=${lower(ctx.sender)} receiver(Alice)=${lower(ctx.receiver)} ` +
    `lockId=${ctx.lockId} hashlock=${HASHLOCK} timelock=${ctx.timelock} amount_wei=${AMOUNT} ` +
    `preimage=${PREIMAGE} (public test vector). Calls appear in the order EthWatcher::observe() makes them.`;

  // ---- lock 1: Bob locks 0.01 ETH for Alice, timelock = latest block timestamp + 7200 ----
  const latest = (await ethers.provider.getBlock("latest")).timestamp;
  const timelock1 = latest + 7200;
  const lockId1 = await contract.computeLockId(bob.address, alice.address, AMOUNT, HASHLOCK, timelock1);
  await nextTs(BASE_TS + 60);
  const lockTx = await contract.connect(bob).newLock(HASHLOCK, timelock1, alice.address, { value: AMOUNT });
  await lockTx.wait();
  const ctx1 = { contract, lockId: lockId1, sender: bob.address, receiver: alice.address, timelock: timelock1 };

  write("locked.json", describe("State right after Bob's newLock was mined (nothing claimed yet).", ctx1),
        await snapshot(ctx1));

  // ---- Alice's claim sits in the mempool (automine off) ----
  await send("evm_setAutomine", [false]);
  const claimTx = await contract.connect(alice).claim(lockId1, PREIMAGE);
  await new Promise((r) => setTimeout(r, 50));
  write("pending_claim.json",
        describe(`Alice's claim(lockId, preimage) is pending in the mempool (tx ${claimTx.hash}); the lock is still unclaimed on chain.`, ctx1),
        await snapshot(ctx1, [claimTx.hash]));

  // ---- the claim is mined ----
  await send("evm_mine", [BASE_TS + 120]);
  await send("evm_setAutomine", [true]);
  write("claimed.json",
        describe(`After the claim (tx ${claimTx.hash}) was mined: Claimed event, getLock claimed=true with the preimage stored.`, ctx1),
        await snapshot(ctx1, [claimTx.hash]));

  // ---- lock 2 (different timelock => different lockId), expires, Bob refunds ----
  const latest2 = (await ethers.provider.getBlock("latest")).timestamp;
  const timelock2 = latest2 + 3600;
  const lockId2 = await contract.computeLockId(bob.address, alice.address, AMOUNT, HASHLOCK, timelock2);
  await nextTs(BASE_TS + 180);
  await (await contract.connect(bob).newLock(HASHLOCK, timelock2, alice.address, { value: AMOUNT })).wait();
  await nextTs(timelock2 + 10);
  const refundTx = await contract.connect(bob).refund(lockId2);
  await refundTx.wait();
  const ctx2 = { contract, lockId: lockId2, sender: bob.address, receiver: alice.address, timelock: timelock2 };
  write("refunded.json",
        describe(`Second lock (lockId differs from locked.json), never claimed; Bob refunded after the timelock (tx ${refundTx.hash}). ` +
                 `The contract also holds lock 1 (${lockId1}) but the log filter selects lock 2 only.`, ctx2),
        await snapshot(ctx2));
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
