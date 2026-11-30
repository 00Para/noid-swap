"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { buildSwapView, chainPhase, timers, obsStatus, short, MAX_OBSERVATION_AGE_S } = require("../lib/aggregate");
const { termsFrom } = require("../lib/config");

const NOW = 1793820000;
const OBJECT = {
  address: "o1root",
  claim_authority: "o1addr_s",
  claim_recipient: "o1bob",
  deadline_height: 281514,
  max_fee_micronoid: 50000,
  opening_hex: "4e4f".repeat(10),
  code_id: "5d2f",
};
const BUNDLE = {
  hashlock: "0x" + "9a".repeat(32),
  claim_authority: "o1addr_s",
  opening_hex: "4e4f".repeat(10),
  contract_root: "o1root",
  params: {
    variant: "raw",
    amount_micronoid: 10000000,
    max_fee_micronoid: 50000,
    h_create: 280789,
    deadline_height: 281514,
    lock_by_height: 280895,
    w_a_s: 7200,
    alice_noid: "o1alice",
    bob_noid: "o1bob",
    eth: { chain_id: 31337, contract: "0x" + "48".repeat(20), code_hash: null, amount_wei: "1000000000000000", alice_receiver: "0x" + "aa".repeat(20), bob_sender: "0x" + "bb".repeat(20) },
  },
};
const CFG = { id: "t", label: "test", role: "alice", eth: { contract: "0x" + "48".repeat(20), lock_id: "0x" + "84".repeat(32) }, noid_rpc_label: "http://127.0.0.1:9601", eth_rpc_label: "http://127.0.0.1:8545" };
const terms = termsFrom(OBJECT, BUNDLE);

const noidObs = (over = {}) => ({
  ok: true,
  value: {
    observed_at: NOW - 5,
    tip: 281108,
    epoch_anchor: "28".repeat(32),
    fee_estimate_1_1: 5800,
    relay_floor: 5000,
    mempool: { size: 0, fee_floor: 5000, single_page_entries: 0 },
    contract_root: "o1root",
    instance: { slot_index: 9705979, creation_id: 737344, amount_micronoid: 10000000 },
    instance_count: 1,
    matches_opening: true,
    active_authority: "o1addr_s",
    object: { deadline_height: 281514, code_id: "5d2f" },
    fund_tx: { txid: "c4".repeat(32), confirmed: true, height: 280814 },
    fund_final: true,
    close_tx: null,
    close_final: null,
    ...over,
  },
});
const lock = (over = {}) => ({ sender: "0x" + "bb".repeat(20), receiver: "0x" + "aa".repeat(20), amount_wei: "1000000000000000", hashlock: "0x" + "9a".repeat(32), timelock: 1793815478, claimed: false, refunded: false, ...over });
const ethObs = (over = {}) => ({
  ok: true,
  value: {
    observed_at: NOW - 3,
    chain_id: 31337,
    latest_number: 1416,
    latest: { number: 1416, timestamp: 1793816708 },
    finalized: { number: 1416 },
    lock: lock(),
    lock_block: 716,
    lock_finalized: true,
    state: "expired-unclaimed (refundable)",
    events: [{ name: "Locked", block_number: 716, tx_hash: "0x" + "2d".repeat(32), timelock: 1793815478, hashlock: "0x" + "9a".repeat(32) }],
    preimage_revealed: false,
    preimage_matches_hashlock: null,
    ...over,
  },
});

test("obsStatus: fresh within 120 s, stale beyond, stale on failure or a future stamp", () => {
  assert.deepEqual(obsStatus({ ok: true, value: { observed_at: NOW - 119 } }, NOW).stale, false);
  assert.equal(obsStatus({ ok: true, value: { observed_at: NOW - MAX_OBSERVATION_AGE_S - 1 } }, NOW).stale, true);
  assert.equal(obsStatus({ ok: false, error: "ECONNREFUSED" }, NOW).stale, true);
  assert.equal(obsStatus({ ok: true, value: { observed_at: NOW + 120 } }, NOW).stale, true);
  assert.equal(obsStatus({ ok: true, value: {} }, NOW).stale, true);
  assert.equal(obsStatus(null, NOW).ok, false);
});

test("timers: blocks to D with a 30 s ETA, lock-by, funding finality, T_reveal and cutoff on the chain clock", () => {
  const tm = timers({ terms, noid: noidObs().value, eth: ethObs().value, now: NOW });
  assert.equal(tm.blocks_to_D, 281514 - 281108);
  assert.equal(tm.eta_D_s, 406 * 30);
  assert.equal(tm.eta_D_at, NOW + 406 * 30);
  assert.equal(tm.deadline_passed, false);
  assert.equal(tm.blocks_to_lock_by, 280895 - 281108);
  assert.equal(tm.fund_final_height, 280814 + 18);
  assert.equal(tm.t_reveal, 1793815478);
  assert.equal(tm.reveal_cutoff, 1793815478 - 1800);
  assert.equal(tm.seconds_to_t_reveal, 1793815478 - 1793816708);
  assert.equal(tm.seconds_to_reveal_cutoff, 1793813678 - 1793816708);
  assert.equal(tm.t_reveal_relevant, true);
  const closed = timers({ terms, noid: noidObs().value, eth: ethObs({ lock: lock({ refunded: true }) }).value, now: NOW });
  assert.equal(closed.t_reveal_relevant, false);
});

test("chain-only phases across the lifecycle", () => {
  const P = (n, e) => chainPhase({ terms, noid: n, eth: e, tm: timers({ terms, noid: n, eth: e, now: NOW }) }).value;
  const noLock = ethObs({ lock: null, lock_block: null, events: [], state: "not found" }).value;
  // not funded
  assert.equal(P(noidObs({ instance: null, instance_count: 0, fund_tx: null, fund_final: null }).value, noLock), "not_funded");
  // funded, not final
  assert.equal(P(noidObs({ fund_final: false }).value, noLock), "funded");
  // funded final, waiting for Bob, lock-by not passed
  assert.equal(P(noidObs({ tip: 280850 }).value, noLock), "funded_final");
  // lock-by passed
  assert.equal(P(noidObs().value, noLock), "lock_by_passed");
  // ETH locked, before the cutoff
  const open = ethObs({ lock: lock(), latest: { number: 800, timestamp: 1793810000 }, state: "open (claimable)" }).value;
  assert.equal(P(noidObs().value, open), "eth_locked");
  // past the cutoff, before T_reveal
  const late = ethObs({ latest: { number: 1300, timestamp: 1793815000 } }).value;
  assert.equal(P(noidObs().value, late), "reveal_cutoff_passed");
  // past T_reveal, unclaimed
  assert.equal(P(noidObs().value, ethObs().value), "t_reveal_passed");
  // revealed (claimed), instance still there -> Bob's claim due
  const claimed = ethObs({ lock: lock({ claimed: true }), events: [...ethObs().value.events, { name: "Claimed", block_number: 720, tx_hash: "0x" + "76".repeat(32) }], preimage_revealed: true, preimage_matches_hashlock: true, state: "claimed" }).value;
  assert.equal(P(noidObs().value, claimed), "revealed");
  // settled
  assert.equal(P(noidObs({ instance: null, instance_count: 0, matches_opening: null, active_authority: null, close_tx: { txid: "d5".repeat(32), confirmed: true, height: 280659 }, close_final: true }).value, claimed), "settled");
  // Bob refunded, Alice waits for D
  const refunded = ethObs({ lock: lock({ refunded: true }), events: [...ethObs().value.events, { name: "Refunded", block_number: 1320, tx_hash: "0x" + "6f".repeat(32) }], state: "refunded" }).value;
  assert.equal(P(noidObs().value, refunded), "eth_refunded");
  // D passed with the instance still there
  assert.equal(P(noidObs({ tip: 281514 }).value, refunded), "noid_refund_open");
  // both closed
  assert.equal(P(noidObs({ instance: null, instance_count: 0 }).value, refunded), "closed_both_refunded");
  // nothing at all
  assert.equal(P(null, null), "unknown");
});

test("buildSwapView: engine view wins when connected, chain-only is kept beside it; stale engine file is flagged", () => {
  const engine = {
    connected: true,
    path: "\\\\wsl.localhost\\x\\loop-alice.txt",
    mtime: NOW - 40,
    view: { role: "alice", tick_at: "18:25:14", exit_code: 0, phase: "lock_final", action: "wait", reason: "reveal cutoff passed; keeping the secret and waiting for D", notes: ["not revealing: (I2) reveal cutoff passed: now 1793816714 > T_reveal - M_A = 1793813678; the reveal must not be broadcast"], events: [], applied: true, noid: { tip: 281108 }, eth: { latest: 1416 } },
  };
  const refundedEth = ethObs({ lock: lock({ refunded: true }), events: [...ethObs().value.events, { name: "Refunded", block_number: 1320, tx_hash: "0x" + "6f".repeat(32) }], state: "refunded" });
  const v = buildSwapView({ cfg: CFG, terms, noid: noidObs(), eth: refundedEth, engine, now: NOW });
  assert.equal(v.phase.source, "engine");
  assert.equal(v.phase.value, "lock_final");
  assert.match(v.phase.label, /Alice may reveal/);
  assert.equal(v.phase.stale, false);
  assert.equal(v.phase.chain_only.value, "eth_refunded");
  assert.equal(v.engine.action, "wait");
  assert.equal(v.engine.action_label, "wait");
  assert.deepEqual(v.engine.notes, ["not revealing: (I2) reveal cutoff passed: now 1793816714 > T_reveal - M_A = 1793813678; the reveal must not be broadcast"]);
  assert.equal(v.engine.age_s, 40);
  assert.equal(v.noid.stale, false);
  assert.equal(v.eth.stale, false);
  assert.deepEqual(v.steps.map((s) => `${s.key}:${s.state}`), ["created:done", "funded:done", "final:done", "eth_locked:done", "revealed:skipped", "eth_refunded:done", "noid_refunded:pending"]);
  assert.ok(v.checks.every((c) => c.ok), JSON.stringify(v.checks.filter((c) => !c.ok)));
  assert.ok(v.receipts.some((r) => r.label === "ETH Refunded tx" && r.short === "0x6f6f6f…6f6f6f"));
  assert.ok(!("opening_hex" in v.terms) || v.terms.opening_hex === undefined, "the 699-byte opening is not shipped to the page");
  assert.equal(v.terms.amount_noid, "10.000000");
  assert.equal(v.terms.amount_eth, "0.001");

  const old = buildSwapView({ cfg: CFG, terms, noid: noidObs(), eth: refundedEth, engine: { ...engine, mtime: NOW - 400 }, now: NOW });
  assert.equal(old.phase.stale, true);
  assert.match(old.engine.stale_reason, /400 s old/);
});

test("buildSwapView: no engine -> chain-only phase labelled as such, with 'engine view not connected'", () => {
  const v = buildSwapView({ cfg: CFG, terms, noid: noidObs(), eth: ethObs(), engine: { connected: false, reason: "engine view not connected: ENOENT", path: "x" }, now: NOW });
  assert.equal(v.phase.source, "chain-only");
  assert.equal(v.phase.value, "t_reveal_passed");
  assert.match(v.phase.hint, /engine view not connected/);
  assert.equal(v.engine.connected, false);
});

test("buildSwapView fails closed: a failed or old observation is stale and the phase is stale too; mismatches are reported", () => {
  const v = buildSwapView({ cfg: CFG, terms, noid: { ok: false, error: "ECONNREFUSED" }, eth: ethObs({ observed_at: NOW - 500 }), engine: { connected: false }, now: NOW });
  assert.equal(v.noid.ok, false);
  assert.equal(v.noid.stale, true);
  assert.match(v.noid.error, /ECONNREFUSED/);
  assert.equal(v.eth.stale, true);
  assert.match(v.eth.reason, /500 s old/);
  assert.equal(v.phase.stale, true);
  assert.equal(v.timers.blocks_to_D, undefined, "no tip: no block timer");
  const bad = buildSwapView({ cfg: CFG, terms, noid: noidObs({ matches_opening: false }), eth: ethObs({ lock: lock({ hashlock: "0x" + "00".repeat(32) }) }), engine: { connected: false }, now: NOW });
  assert.ok(bad.checks.some((c) => c.name === "instance matches our opening" && c.ok === false));
  assert.ok(bad.checks.some((c) => c.name === "ETH hashlock = terms" && c.ok === false));
});

test("termsFrom cross-checks the object against the bundle", () => {
  assert.equal(terms.consistent, true);
  const t2 = termsFrom({ ...OBJECT, deadline_height: 1 }, BUNDLE);
  assert.equal(t2.consistent, false);
  assert.equal(t2.deadline_height, 1, "the on-chain object wins for display");
  assert.equal(short("0x844f4c78d095ca6b65a01bf160c09c721ca394ca244288f6d64ada0d147e3cba"), "0x844f4c…7e3cba");
});
