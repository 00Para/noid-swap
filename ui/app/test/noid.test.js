"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { FixtureRpc } = require("../lib/rpc");
const { observeNoid } = require("../lib/noid");

const FIX = path.join(__dirname, "..", "..", "..", "swap-cli", "fixtures", "parano1d");
const load = (name) => JSON.parse(fs.readFileSync(path.join(FIX, name), "utf8"));
const openingOf = (fx) => fx.calls.find((c) => c.method === "paranoid_getObjectInstances").params[0];
const CLAIM_TXID = "d50743e3ead6c3870ec7e9b1322113a956a034cf6fc259753743ecd49f3e1324";
const ADDR_S = "o1myesz750uxepkx3hfekln7pp7h0f7prn2lu5taswn940g3mws0yqedcswg";

test("recorded_funded_final: funded instance, matches opening, claim-side authority, deadline from the object", async () => {
  const fx = load("recorded_funded_final.json");
  const rpc = new FixtureRpc(fx, "noid");
  const o = await observeNoid(rpc, { opening_hex: openingOf(fx) }, () => 1793803000);
  assert.equal(o.observed_at, 1793803000);
  assert.equal(o.tip, 280655);
  assert.equal(o.next_call_height, 280656);
  assert.equal(o.epoch_anchor, "5339dc8eeeb085b5b86a1d22adf5550fd6c4c834a6ed401ae7a4621506943ae1");
  assert.equal(o.fee_estimate_1_1, 5800);
  assert.equal(o.relay_floor, 5000);
  assert.deepEqual(o.instance, { slot_index: 9750400, creation_id: 736337, amount_micronoid: 10000000, owner: "o1qjnr505ua8gg63enxsjq9a4rsvlfg3nkx7zy5pfsdudy9ktuajlq786367" });
  assert.equal(o.instance_count, 1);
  assert.equal(o.matches_opening, true);
  assert.equal(o.active_authority, ADDR_S);
  assert.equal(o.object.deadline_height, 281286);
  assert.equal(o.object.max_fee_micronoid, 50000);
  assert.equal(o.object.claim_recipient, "o1xpyc7ar25emv3tyvlphettpw43fec66q2agnd86r3g8fu5x6tg2s8w8q9r");
  assert.equal(o.mempool.fee_floor, 5000);
  assert.equal(o.fund_tx, null, "no txid configured: nothing looked up");
  assert.equal(o.fund_final, null);
  // Only allowed methods were asked, and getMempoolEntry (not allowed) never.
  const methods = new Set(rpc.log.map((c) => c.method));
  assert.ok(!methods.has("paranoid_getMempoolEntry"));
  assert.ok(!methods.has("paranoid_getMempoolStats"));
});

test("recorded_funded_first_seen: tip is raised to the instance page height (280,637 -> 280,638)", async () => {
  const fx = load("recorded_funded_first_seen.json");
  const o = await observeNoid(new FixtureRpc(fx, "noid"), { opening_hex: openingOf(fx) }, () => 1);
  assert.equal(fx.calls.find((c) => c.method === "paranoid_blockCount").result, 280637);
  assert.equal(o.tip, 280638);
  assert.ok(o.instance);
});

test("recorded_claim_included: instance gone, the close txid is confirmed at 280,659 and not yet final at tip 280,662", async () => {
  const fx = load("recorded_claim_included.json");
  const o = await observeNoid(new FixtureRpc(fx, "noid"), { opening_hex: openingOf(fx), close_txid: CLAIM_TXID }, () => 1);
  assert.equal(o.tip, 280662);
  assert.equal(o.instance, null);
  assert.equal(o.instance_count, 0);
  assert.equal(o.matches_opening, null);
  assert.equal(o.active_authority, null);
  assert.deepEqual(o.close_tx, { txid: CLAIM_TXID, confirmed: true, height: 280659, block_hash: "59eefd1215451ab761a3796a1cb86419ddc6b7aaf5b453e69bb7d1f1fd114928", tx_position: 1 });
  assert.equal(o.close_final, false);
  assert.equal(o.mempool.size, 0);
});

test("recorded_claim_final: instance gone at tip >= 280,676, busy mempool", async () => {
  const fx = load("recorded_claim_final.json");
  const o = await observeNoid(new FixtureRpc(fx, "noid"), { opening_hex: openingOf(fx) }, () => 1);
  assert.ok(o.tip >= 280676);
  assert.equal(o.instance, null);
  assert.ok(o.mempool.size >= 1, "the real mempool was busy at that tick");
});

test("finality arithmetic at the boundary: included at 280,659 is not final at tip +17, final at tip +18 (funding and close)", async () => {
  const fx = load("recorded_claim_included.json");
  const at = (tip) => ({ calls: fx.calls.map((c) => (c.method === "paranoid_blockCount" ? { ...c, result: tip } : c.method === "paranoid_getObjectInstances" ? { ...c, result: { ...c.result, height: tip } } : c)) });
  const swap = { opening_hex: openingOf(fx), fund_txid: CLAIM_TXID, close_txid: CLAIM_TXID };
  const a = await observeNoid(new FixtureRpc(at(280659 + 17), "noid"), swap, () => 1);
  assert.equal(a.close_final, false);
  assert.equal(a.fund_final, false);
  const b = await observeNoid(new FixtureRpc(at(280659 + 18), "noid"), swap, () => 1);
  assert.equal(b.close_final, true);
  assert.equal(b.fund_final, true);
});

test("recorded_claim_pending: a pending claim is in the mempool but the console cannot attribute it (no getMempoolEntry)", async () => {
  const fx = load("recorded_claim_pending.json");
  const rpc = new FixtureRpc(fx, "noid");
  const o = await observeNoid(rpc, { opening_hex: openingOf(fx), close_txid: CLAIM_TXID }, () => 1);
  assert.ok(o.instance, "still funded while the claim is pending");
  assert.equal(o.mempool.size, 8);
  assert.ok(o.mempool.single_page_entries >= 1);
  assert.equal(o.close_tx.confirmed, false, "getTx says null while pending");
  assert.ok(!rpc.log.some((c) => c.method === "paranoid_getMempoolEntry"));
});

test("idle.json: an unfunded opening gives no instance and no status call", async () => {
  const fx = load("idle.json");
  const rpc = new FixtureRpc(fx, "noid");
  const o = await observeNoid(rpc, { opening_hex: openingOf(fx) }, () => 1);
  assert.equal(o.instance, null);
  assert.ok(!rpc.log.some((c) => c.method === "paranoid_getObjectStatus"));
  assert.ok(typeof o.tip === "number" && o.tip > 279388);
});

test("malformed answers are errors, never a 'fine' observation", async () => {
  const fx = load("malformed.json");
  await assert.rejects(observeNoid(new FixtureRpc(fx, "noid"), { opening_hex: openingOf(fx) }, () => 1));
  await assert.rejects(observeNoid(new FixtureRpc({ calls: [{ method: "paranoid_blockCount", result: "not a number" }] }, "noid"), { opening_hex: "4e" }, () => 1), /blockCount/);
  await assert.rejects(observeNoid(new FixtureRpc({ calls: [] }, "noid"), { opening_hex: "" }, () => 1), /opening_hex/);
});
