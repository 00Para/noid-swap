"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { parseStatusText, pyLiteral, parseKeyValues } = require("../lib/statusfile");

const ALICE = [
  "[alice] tick exit 0 at 18:25:14",
  'noid: tip 281108 instance {"amount_micronoid": 10000000, "creation_id": 737344, "slot_index": 9705979} matches True pending 0 confirmed null tracked_pending None',
  "eth : latest 1416 finalized 1416 ts 1793816708 lock null claimed null pending_preimage None refunded {'block_number': 1320, 'lock_id': '0x844f4c78d095ca6b65a01bf160c09c721ca394ca244288f6d64ada0d147e3cba', 'tx_hash': '0x6f659b4f10fd46620dad2011ff4f9aa2dffa63eea09412d724ac329e8be12682'}",
  "events: []",
  'ACTION: {"action": "wait", "reason": "reveal cutoff passed; keeping the secret and waiting for D"}',
  'notes: ["not revealing: (I2) reveal cutoff passed: now 1793816714 > T_reveal - M_A = 1793813678; the reveal must not be broadcast"]',
  "applied: True phase_after: lock_final",
  "",
].join("\n");

const BOB = [
  "[bob] tick exit 0 at 18:05:39",
  'noid: tip 281074 instance {"amount_micronoid": 10000000, "creation_id": 737344, "slot_index": 9705979} matches True pending 0 confirmed null tracked_pending None',
  "eth : latest 1317 finalized 1317 ts 1793815531 lock null claimed null pending_preimage None refunded None",
  "events: []",
  'ACTION: {"action": "refund_eth", "lock_id": "0x844f4c78d095ca6b65a01bf160c09c721ca394ca244288f6d64ada0d147e3cba"}',
  "notes: []",
  "applied: True phase_after: locked",
].join("\n");

test("Alice's run-2 block: phase, action, reason, notes, both chains", () => {
  const v = parseStatusText(ALICE);
  assert.equal(v.role, "alice");
  assert.equal(v.tick_at, "18:25:14");
  assert.equal(v.exit_code, 0);
  assert.equal(v.phase, "lock_final");
  assert.equal(v.action, "wait");
  assert.equal(v.reason, "reveal cutoff passed; keeping the secret and waiting for D");
  assert.equal(v.notes.length, 1);
  assert.match(v.notes[0], /the reveal must not be broadcast/);
  assert.deepEqual(v.events, []);
  assert.equal(v.applied, true);
  assert.equal(v.noid.tip, 281108);
  assert.deepEqual(v.noid.instance, { amount_micronoid: 10000000, creation_id: 737344, slot_index: 9705979 });
  assert.equal(v.noid.matches, true);
  assert.equal(v.noid.pending, 0);
  assert.equal(v.noid.confirmed, null);
  assert.equal(v.noid.tracked_pending, null);
  assert.equal(v.eth.latest, 1416);
  assert.equal(v.eth.finalized, 1416);
  assert.equal(v.eth.ts, 1793816708);
  assert.equal(v.eth.lock, null);
  assert.equal(v.eth.pending_preimage, null);
  assert.deepEqual(v.eth.refunded, {
    block_number: 1320,
    lock_id: "0x844f4c78d095ca6b65a01bf160c09c721ca394ca244288f6d64ada0d147e3cba",
    tx_hash: "0x6f659b4f10fd46620dad2011ff4f9aa2dffa63eea09412d724ac329e8be12682",
  });
  assert.equal(v.blocks_in_file, 1);
});

test("Bob's block: an action without a reason, refunded None, phase locked", () => {
  const v = parseStatusText(BOB);
  assert.equal(v.role, "bob");
  assert.equal(v.phase, "locked");
  assert.equal(v.action, "refund_eth");
  assert.equal(v.reason, null);
  assert.equal(v.action_details.lock_id, "0x844f4c78d095ca6b65a01bf160c09c721ca394ca244288f6d64ada0d147e3cba");
  assert.equal(v.eth.refunded, null);
  assert.deepEqual(v.notes, []);
});

test("several blocks in one file: the last one wins; a failed tick keeps its exit code", () => {
  const text = BOB + "\n" + ALICE + "\n[alice] tick exit 1 at 18:27:00\nevents: []\nACTION: {\"action\": \"wait\", \"reason\": \"poll failed\"}\n";
  const v = parseStatusText(text);
  assert.equal(v.tick_at, "18:27:00");
  assert.equal(v.exit_code, 1);
  assert.equal(v.phase, null);
  assert.equal(v.reason, "poll failed");
  assert.equal(v.blocks_in_file, 3);
});

test("garbage or empty input gives null, never a throw", () => {
  assert.equal(parseStatusText(""), null);
  assert.equal(parseStatusText("tick exit 0\nnoid: tip"), null);
  const v = parseStatusText("[alice] tick exit 0 at 10:00:00\nnoid: tip {unbalanced\nACTION: not json\nnotes: [1,");
  assert.equal(v.role, "alice");
  assert.equal(v.action, null);
  assert.deepEqual(v.notes, []);
});

test("python literals: True/False/None, single quotes, nested, apostrophes inside double-quoted JSON strings", () => {
  assert.equal(pyLiteral("True"), true);
  assert.equal(pyLiteral("None"), null);
  assert.equal(pyLiteral("42"), 42);
  assert.deepEqual(pyLiteral("{'a': None, 'b': [True, False, 'x']}"), { a: null, b: [true, false, "x"] });
  assert.deepEqual(pyLiteral('{"reason": "Bob\'s refund is None"}'), { reason: "Bob's refund is None" });
  assert.deepEqual(parseKeyValues("tip 5 instance {'a': 1} matches True x"), { tip: 5, instance: { a: 1 }, matches: true, x: null });
});
