"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { FixtureRpc } = require("../lib/rpc");
const { observeEth, htlcInterface } = require("../lib/eth");

const FIX = path.join(__dirname, "..", "..", "..", "swap-cli", "fixtures", "eth");
const load = (name) => JSON.parse(fs.readFileSync(path.join(FIX, name), "utf8"));
const CONTRACT = "0x5fbdb2315678afecb367f032d93f642f64180aa3";
const LOCK1 = "0xd767c0233cc9e31683a3cf13d5d4d3217d51e5a6c9624aa50daa7f23e795bb50";
const LOCK2 = "0xeed5e5853816fc3ff08283ef6a11ab1f55bcb8c2f2395d5d7f84f34f57b2364d";
const BOB = "0x70997970c51812dc3a010c7d01b50e0d17dc79c8";
const ALICE = "0x3c44cdddb6a900fa2b585dd299e03d12fa4293bc";
const H = "0x630dcd2966c4336691125448bbb25b4ff412a49c732db2c8abc1b8581bd710dd";
const PREIMAGE = "0x000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f";

test("event topics match the constants pinned in swap-cli/src/watch/eth.rs", () => {
  const iface = htlcInterface();
  assert.equal(iface.getEvent("Locked").topicHash, "0x578af4d125bb96ec89cd1ade591cb196f35d15047d5b096c478e45e311d84263");
  assert.equal(iface.getEvent("Claimed").topicHash, "0x38d6042dbdae8e73a7f6afbabd3fbe0873f9f5ed3cd71294591c3908c2e65fee");
  assert.equal(iface.getEvent("Refunded").topicHash, "0xfe509803c09416b28ff3d8f690c8b0c61462a892c46d5430c8fb20abe472daf0");
  assert.equal(iface.getFunction("getLock").selector, "0xd6f27b58");
});

test("locked.json: open lock, Locked event, no preimage; only allowed methods asked", async () => {
  const rpc = new FixtureRpc(load("locked.json"), "eth");
  const o = await observeEth(rpc, { contract: CONTRACT, lock_id: LOCK1 }, () => 5);
  assert.equal(o.observed_at, 5);
  assert.equal(o.chain_id, 1); // swap-cli's eth fixtures carry chain 1, the chain the production profile pins
  assert.equal(o.latest_number, 2);
  assert.equal(o.latest.number, 2);
  assert.equal(o.finalized.number, 2);
  assert.equal(o.state, "open (claimable)");
  assert.deepEqual(o.lock, { sender: BOB, receiver: ALICE, amount_wei: "10000000000000000", hashlock: H, timelock: 1893463200, claimed: false, refunded: false });
  assert.equal(o.lock_block, 2);
  assert.equal(o.lock_finalized, true);
  assert.deepEqual(o.events.map((e) => [e.name, e.block_number]), [["Locked", 2]]);
  assert.equal(o.events[0].hashlock, H);
  assert.equal(o.preimage_revealed, false);
  assert.equal(o.preimage_matches_hashlock, null);
  assert.equal(o.reveal_cutoff, 1893463200 - 1800);
  const asked = new Set(rpc.log.map((c) => c.method));
  for (const m of asked) assert.ok(["eth_chainId", "eth_blockNumber", "eth_getBlockByNumber", "eth_getLogs", "eth_call"].includes(m), m);
  assert.ok(!asked.has("eth_getCode") && !asked.has("eth_getTransactionByHash"));
});

test("claimed.json: Claimed event, lock claimed, preimage hashes to H but is never returned", async () => {
  const o = await observeEth(new FixtureRpc(load("claimed.json"), "eth"), { contract: CONTRACT, lock_id: LOCK1 }, () => 1);
  assert.equal(o.state, "claimed");
  assert.equal(o.lock.claimed, true);
  assert.deepEqual(o.events.map((e) => e.name), ["Locked", "Claimed"]);
  assert.equal(o.preimage_revealed, true);
  assert.equal(o.preimage_matches_hashlock, true);
  const text = JSON.stringify(o);
  assert.ok(!text.includes(PREIMAGE.slice(2)), "the preimage bytes must not appear in the observation");
  assert.ok(!("preimage" in (o.lock || {})));
});

test("refunded.json: Refunded event on lock 2, lock 1's logs are not mixed in", async () => {
  const o = await observeEth(new FixtureRpc(load("refunded.json"), "eth"), { contract: CONTRACT, lock_id: LOCK2 }, () => 1);
  assert.equal(o.state, "refunded");
  assert.equal(o.lock.refunded, true);
  assert.deepEqual(o.events.map((e) => e.name), ["Locked", "Refunded"]);
  assert.equal(o.preimage_revealed, false);
});

test("an expired, unclaimed lock is 'expired-unclaimed (refundable)' by the chain clock", async () => {
  const fx = load("locked.json");
  const late = { calls: fx.calls.map((c) => (c.method === "eth_getBlockByNumber" ? { ...c, result: { ...c.result, timestamp: "0x" + (1893463200).toString(16) } } : c)) };
  const o = await observeEth(new FixtureRpc(late, "eth"), { contract: CONTRACT, lock_id: LOCK1 }, () => 1);
  assert.equal(o.state, "expired-unclaimed (refundable)");
});

test("a node without eth_chainId gives chain_id null, not an error", async () => {
  const fx = load("locked.json");
  const noChain = { calls: fx.calls.filter((c) => c.method !== "eth_chainId") };
  const o = await observeEth(new FixtureRpc(noChain, "eth"), { contract: CONTRACT, lock_id: LOCK1 }, () => 1);
  assert.equal(o.chain_id, null);
  assert.equal(o.state, "open (claimable)");
});

test("no logs for an unknown lock id: not found, no eth_call made", async () => {
  const fx = load("locked.json");
  const none = { calls: fx.calls.map((c) => (c.method === "eth_getLogs" ? { ...c, result: [] } : c)) };
  const rpc = new FixtureRpc(none, "eth");
  const o = await observeEth(rpc, { contract: CONTRACT, lock_id: "0x" + "ab".repeat(32) }, () => 1);
  assert.equal(o.state, "not found");
  assert.equal(o.lock, null);
  assert.ok(!rpc.log.some((c) => c.method === "eth_call"));
});

test("bad swap config is rejected before any call", async () => {
  const rpc = new FixtureRpc({ calls: [] }, "eth");
  await assert.rejects(observeEth(rpc, { contract: "nope", lock_id: LOCK1 }), /contract/);
  await assert.rejects(observeEth(rpc, { contract: CONTRACT, lock_id: "0x12" }), /lock_id/);
  assert.equal(rpc.log.length, 0);
});
