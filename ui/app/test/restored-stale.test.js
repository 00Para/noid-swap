"use strict";
// A swap restored from a backup made before its own coins went in (rehearsal of 2026-11-26, findings F2 and F4): Alice's copy said `created` after she had funded, Bob's said `received`
// after he had locked. The deposit was spent into the funding or the lock, so the wallet no longer showed it: rule W kept Alice's loop reading for ever, and both pages asked for the
// deposit again (Bob's "needs you" told him to send 0.001 ETH more). `coinsAlreadyIn` (lib/viewmodel.js) tells that case from the tick alone; rule W lets an approved Alice record it,
// Bob's observe-only loop records his facts by itself, and no deposit is asked for. A swap whose coins are not in keeps every rule it had.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const V = require("../lib/viewmodel");
const { watchWanted } = require("../lib/firststeps");
const { steps } = require("./autopilot-harness");
const { mkTick, NOW, TERMS } = require("./helpers");
const { makeWallet, WNA, E } = require("./wallet-harness");

const SEEN = { event: "noid_instance_seen", instance: { slot_index: 7, creation_id: 3, amount_micronoid: 10000000 }, tip: 280500 };

// ---------------------------------------------------------------- coinsAlreadyIn

test("coinsAlreadyIn: Alice at created with her own instance among the tick's events; nothing else counts", () => {
  const c = (o) => V.coinsAlreadyIn("alice", mkTick({ phase: "created", ...o }));
  assert.equal(c({ events: [SEEN] }), true);
  assert.equal(c({ events: [] }), false, "an instance at the root that the engine did not accept is not an event");
  assert.equal(c({ events: [{ event: "noid_instance_gone" }] }), false);
  assert.equal(V.coinsAlreadyIn("alice", mkTick({ phase: "funded", events: [SEEN] })), false, "past created the file already knows");
  assert.equal(V.coinsAlreadyIn("alice", { phase_after: "created", events: "noid_instance_seen" }), false);
  assert.equal(V.coinsAlreadyIn("alice", null), false);
  assert.equal(V.coinsAlreadyIn("bob", mkTick({ phase: "received", events: [SEEN] })), false, "Alice's instance is not Bob's coin");
});

test("coinsAlreadyIn: Bob before his lock whose fresh swap key has sent something (latest or pending nonce above 0), on the first node AND on the second when one is set", () => {
  const SENT = { signer_nonce_latest: 1, signer_nonce_pending: 1 };
  const c = (phase, eth) => V.coinsAlreadyIn("bob", mkTick({ phase, eth: { second: SENT, ...eth } }));
  for (const phase of ["received", "funded", "funding_final"]) {
    assert.equal(c(phase, SENT), true, phase);
    assert.equal(c(phase, { signer_nonce_latest: 0, signer_nonce_pending: 1 }), true, `${phase}: a lock in the pool`);
    assert.equal(c(phase, { signer_nonce_latest: 0, signer_nonce_pending: 0 }), false, `${phase}: nothing sent`);
  }
  assert.equal(c("funded", { signer_nonce_latest: 0, signer_nonce_pending: 0, second: SENT }), false, "the second node alone is not enough");
  assert.equal(c("funded", { ...SENT, second: { signer_nonce_latest: 0, signer_nonce_pending: 0 } }), false, "the first node alone is not enough while a second is set");
  assert.equal(c("funded", { ...SENT, second: {} }), false, "a second node with no nonces does not agree");
  assert.equal(c("funded", { ...SENT, second_error: "eth second node: timeout" }), false, "a second node that failed does not agree");
  assert.equal(V.coinsAlreadyIn("bob", { phase_after: "funded", eth: SENT }), true, "no second node set: the first node's word");
  assert.equal(c("funded", {}), false, "unknown nonces are not a lock");
  assert.equal(c("funded", { signer_nonce_latest: "1", signer_nonce_pending: "1" }), false, "only whole numbers");
  assert.equal(c("locked", { signer_nonce_latest: 1, signer_nonce_pending: 1 }), false, "past the lock the file already knows");
  assert.equal(V.coinsAlreadyIn("alice", mkTick({ phase: "created", eth: { signer_nonce_latest: 1 } })), false, "Alice's key is not her NOID");
});

// ---------------------------------------------------------------- rule W

test("rule W: an approved, restored Alice whose instance is seen records; without the approval, the restore, or the instance, she keeps reading", () => {
  const w = (o) => watchWanted({ role: "alice", tick: mkTick({ phase: "created", events: [SEEN] }), approvalInForce: true, depositReasons: ["deposit_short"], sticky: false, abortSeen: 0, restored: true, ...o });
  assert.equal(w({}), "apply", "F2: the deposit was spent into the funding, the instance is there");
  assert.equal(w({ approvalInForce: false }), "read", "no approval: nothing is recorded");
  assert.equal(w({ restored: false }), "read", "a swap that was not restored keeps the rule it had");
  assert.equal(w({ restored: undefined }), "read");
  assert.equal(w({ tick: mkTick({ phase: "created", events: [] }) }), "read", "the rule for a swap whose coins are not in is unchanged");
  assert.equal(w({ tick: mkTick({ phase: "created", events: [] }), depositReasons: [] }), "apply", "the deposit seen still counts as before");
});

test("rule W: Bob gets no such rule; his observe-only loop records the funding, its finality and his own lock by itself", () => {
  for (const phase of ["received", "funded", "funding_final"]) {
    const tick = mkTick({ phase, eth: { signer_nonce_latest: 1, signer_nonce_pending: 1 } });
    assert.equal(watchWanted({ role: "bob", tick, approvalInForce: true, depositReasons: ["deposit_short"], sticky: false, abortSeen: 0, restored: true }), "read", phase);
  }
  assert.equal(watchWanted({ role: "bob", tick: mkTick({ phase: "locked" }), approvalInForce: true, depositReasons: ["deposit_short"] }), "apply", "once his lock is adopted the loop records");
});

// ---------------------------------------------------------------- the view and the ticket

const viewOf = (role, tick) => V.buildView({ role, now: NOW, tick, tick_mtime: NOW - 3, loop: null, terms: TERMS, helpers: [], commands: {}, machines: null });

test("the ticket, told coins_in by the autopilot, never says 'Nothing is locked yet' over coins that are in; without it nothing changes", () => {
  const a = viewOf("alice", mkTick({ now: NOW, phase: "created", events: [SEEN] }));
  assert.equal(a.coins_in, undefined, "the view itself decides nothing: only the autopilot, which knows the restore marker");
  const la = V.legsFor(a, "alice", { coins_in: true });
  assert.equal(la.give.words, "Locked, being recorded");
  assert.notEqual(la.give.state, "none");
  assert.equal(V.legsFor(a, "alice").give.words, "In your own wallet", "not restored: unchanged");
  const b = viewOf("bob", mkTick({ now: NOW, phase: "funded", eth: { signer_nonce_latest: 1, signer_nonce_pending: 1 } }));
  const lb = V.legsFor(b, "bob", { coins_in: true });
  assert.equal(lb.give.words, "Your lock was sent");
  assert.equal(lb.give.state, "sent");
  assert.equal(V.legsFor(b, "bob").give.words, "In this swap's own key", "not restored: unchanged");
  assert.equal(V.legsFor(b, "bob", { coins_in: "yes" }).give.words, "In this swap's own key", "only true counts");
});

// ---------------------------------------------------------------- the "needs you" entries (lib/autopilot.js watchDeposits)

const BOB_STATEMENTS = { stay_on: true, no_manual_steps: true };
const ALICE_STATEMENTS = { stay_on: true, no_manual_steps: true, bob_check_matches: true };
const SHORT_NOTE = "lock margin is short: 12 blocks to the last lock height 280000 (nominal lock-by 280100, tip 279988); see the action";
const FUND_SHORT_NOTE = "funding window is short: 9 blocks left before it is too late to fund (lock-by 280624, tip 280500); see the action";
const put = (h, role, o) => h.f.writeTickAt(role, mkTick(o), h.clock.ms - 3000);
function status(h, role, o = {}) {
  const held = o.held;
  const need = o.need ?? (role === "alice" ? "1000000000000000" : "1900000000000000");
  const covered = BigInt(held) >= BigInt(need);
  const noid = role === "alice" ? { address: WNA, plain_micronoid: String(o.plain ?? 0), amount_micronoid: "10000000", fee_reserve_micronoid: "6000", need_micronoid: "10006000", covers: BigInt(o.plain ?? 0) >= 10006000n, tip: "280500" } : null;
  h.runner.walletStatus[role] = {
    at_ms: h.clock.ms,
    ok: true,
    noid,
    eth: { address: role === "alice" ? E.alice_receiver : E.bob_sender, required_wei: need, reserve_wei: "900000000000000", amount_wei: role === "bob" ? E.amount_wei : "0", balance_wei: held, shortfall_wei: covered ? "0" : String(BigInt(need) - BigInt(held)), covered, key_checked: true },
    problems: [],
  };
}
const needs = (h, role) => h.ap.view(h.run())[role].needs_you;
const raised = (h, role) => h.audit.all().filter((r) => r.action === "autopilot" && r.phase === "note" && r.role === role && /^needs you: deposit-/.test(r.result));

const SENT = { signer_nonce_latest: 1, signer_nonce_pending: 1 };
const BOB_SENT = { ...SENT, second: { latest_block: 100, ...SENT } };
const BOB_NONE = { signer_nonce_latest: 0, signer_nonce_pending: 0, second: { latest_block: 100, signer_nonce_latest: 0, signer_nonce_pending: 0 } };
const markRestored = (h) => fs.writeFileSync(path.join(h.ap.runDir(), "restored.json"), JSON.stringify({ v: 1, restored_at: "2026-11-26T12:00:00Z", backup_phase: "created" }) + "\n");

test("F4, Bob: the restored copy whose key has sent the lock asks for no second deposit; the same copy with nothing sent still does", () => {
  const B = makeWallet({ role: "bob" });
  try {
    markRestored(B);
    put(B, "bob", { phase: "funded", notes: [SHORT_NOTE], eth: BOB_SENT });
    B.loop("bob");
    assert.equal(B.approve("bob", { statements: { ...BOB_STATEMENTS, one_computer: true } }).status, 200);
    // the rehearsal's figures: 0.0009 ETH left of the 0.0019 ETH the box asked for
    status(B, "bob", { held: "899999987739087" });
    steps(B, 2);
    assert.deepEqual(needs(B, "bob"), [], "no 'send 0.001 ETH more'");
    assert.equal(raised(B, "bob").length, 0);
    assert.deepEqual(B.log.filter((l) => !l.dry && l.script !== "wallet-status.sh"), [], "nothing was sent");
    assert.equal(B.ap.coinsInAhead("bob", B.run()), false);
    // the control: the key has sent nothing, so the short deposit is real and is said
    put(B, "bob", { phase: "funded", notes: [SHORT_NOTE], eth: BOB_NONE });
    B.loop("bob");
    status(B, "bob", { held: "899999987739087" });
    steps(B, 1);
    assert.equal(needs(B, "bob").length, 1);
    assert.equal(needs(B, "bob")[0].spend, "deposit-eth");
    // one node's word is not enough: the second node has not seen the send
    put(B, "bob", { phase: "funded", notes: [SHORT_NOTE], eth: { ...SENT, second: { latest_block: 100, signer_nonce_latest: 0, signer_nonce_pending: 0 } } });
    B.loop("bob");
    status(B, "bob", { held: "899999987739087" });
    steps(B, 1);
    assert.equal(needs(B, "bob").length, 1, "the entry stays while only one node shows the send");
    // and an entry that is open goes once both nodes show the lock was sent
    put(B, "bob", { phase: "funded", notes: [SHORT_NOTE], eth: BOB_SENT });
    B.loop("bob");
    status(B, "bob", { held: "899999987739087" });
    steps(B, 1);
    assert.deepEqual(needs(B, "bob"), []);
    const cleared = B.audit.all().filter((r) => r.action === "autopilot" && r.phase === "note" && r.role === "bob" && r.result === "cleared: deposit-eth");
    assert.equal(cleared.length, 1);
    assert.match(cleared[0].detail, /already sent your lock/);
  } finally {
    B.cleanup();
  }
});

test("F4, Bob: a swap that was NOT restored keeps every rule: the same tick still raises the deposit entry and keeps the downtime rule", () => {
  const B = makeWallet({ role: "bob" });
  try {
    put(B, "bob", { phase: "funded", notes: [SHORT_NOTE], eth: BOB_SENT });
    B.loop("bob");
    assert.equal(B.approve("bob", { statements: BOB_STATEMENTS }).status, 200);
    status(B, "bob", { held: "899999987739087" });
    steps(B, 1);
    assert.equal(needs(B, "bob").length, 1, "a nonce on a swap that was not restored is no reason to stop asking");
    assert.equal(B.ap.coinsInAhead("bob", B.run()), true, "the downtime and backup rules still see the lock ahead");
    assert.equal(B.ap.view(B.run()).bob.coins_in, false);
  } finally {
    B.cleanup();
  }
});

test("F2/F4, Alice: the restored copy whose instance is seen asks for no deposit; without the instance, or without the restore, the empty wallet still raises its entry", () => {
  const A = makeWallet({ role: "alice" });
  try {
    markRestored(A);
    put(A, "alice", { phase: "created", notes: [FUND_SHORT_NOTE], events: [SEEN] });
    A.loop("alice");
    assert.equal(A.approve("alice", { statements: { ...ALICE_STATEMENTS, one_computer: true } }).status, 200);
    status(A, "alice", { held: "1000000000000000", plain: 1000000 });
    steps(A, 2);
    assert.deepEqual(needs(A, "alice"), []);
    assert.equal(raised(A, "alice").length, 0);
    assert.deepEqual(A.log.filter((l) => !l.dry && l.script !== "wallet-status.sh"), [], "no funding is sent: the instance is hers already");
    assert.equal(A.ap.coinsInAhead("alice", A.run()), false);
    put(A, "alice", { phase: "created", notes: [FUND_SHORT_NOTE], events: [] });
    A.loop("alice");
    status(A, "alice", { held: "1000000000000000", plain: 1000000 });
    steps(A, 1);
    assert.equal(needs(A, "alice").length, 1);
    assert.equal(needs(A, "alice")[0].spend, "deposit-noid");
  } finally {
    A.cleanup();
  }
  const N = makeWallet({ role: "alice" });
  try {
    put(N, "alice", { phase: "created", notes: [FUND_SHORT_NOTE], events: [SEEN] });
    N.loop("alice");
    assert.equal(N.approve("alice", { statements: ALICE_STATEMENTS }).status, 200);
    status(N, "alice", { held: "1000000000000000", plain: 1000000 });
    steps(N, 1);
    assert.equal(needs(N, "alice").length, 1, "not restored: the entry is raised as before");
    assert.equal(N.ap.coinsInAhead("alice", N.run()), true);
  } finally {
    N.cleanup();
  }
});

// ---------------------------------------------------------------- the page: the card and Details

test("static: the card and the Details box take coins_in from the autopilot (which knows the restore marker) before they ask for a deposit, in both roles", () => {
  const card = fs.readFileSync(path.join(__dirname, "..", "stagecard.js"), "utf8");
  const i = card.indexOf("x && x.coins_in === true");
  const j = card.indexOf("Ac.card.depositSeen(a, role)) {");
  assert.ok(i > 0 && j > 0 && i < j, "the coins_in branch comes before the deposit branch");
  assert.match(card, /Your NOID is already in the swap contract/);
  assert.match(card, /Your lock was already sent/);
  assert.doesNotMatch(card, /coinsAlreadyIn/, "the page never decides it from the tick alone");
  const acts = fs.readFileSync(path.join(__dirname, "..", "actions.js"), "utf8");
  const k = acts.indexOf("apv && apv.coins_in === true");
  const l = acts.indexOf("const s = r.status || null;");
  const m = acts.indexOf("Not read yet. The console reads the deposit");
  assert.ok(k > 0 && (l < 0 || k > l) && k < m, "the Details box says it before any address or figure");
  assert.doesNotMatch(acts, /coinsAlreadyIn/);
});

test("F3 (rehearsal 2026-11-26): the ticket is not sticky, so it can never slide over Details or the picture when the page is scrolled", () => {
  const css = fs.readFileSync(path.join(__dirname, "..", "operator.css"), "utf8");
  for (const m of css.matchAll(/([^{}]*)\{([^{}]*)\}/g)) {
    if (/(^|[\s,])\.tk(?![\w-])/.test(m[1])) assert.doesNotMatch(m[2], /position:\s*sticky/, m[0].trim());
  }
});
