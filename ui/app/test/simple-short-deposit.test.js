"use strict";
// A short deposit after the person's approval raises a "needs you" entry (lib/autopilot.js `watchDeposits`): the live case (Bob approved, Alice's funding final, the swap key held 0.0011 ETH
// of the 0.0019 ETH needed, and for 40 minutes nothing needed the person). Every helper and every chain answer is fake; the wallet status is the one the console keeps for the role.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { steps } = require("./autopilot-harness");
const { mkTick } = require("./helpers");
const { makeWallet, WNA, E } = require("./wallet-harness");

const ALICE_STATEMENTS = { stay_on: true, no_manual_steps: true, bob_check_matches: true };
const BOB_STATEMENTS = { stay_on: true, no_manual_steps: true };
const SHORT_NOTE = "lock margin is short: 12 blocks to the last lock height 280000 (nominal lock-by 280100, tip 279988); see the action";
const QUIET_NOTE = "lock-by margin: 300 blocks (lock-by 280100, tip 279800)";
const EXACT_NOTE = "lock-by margin: 300 blocks (lock-by 280100, tip 279800); the last lock height is 280100";
const AT_MOST_NOTE = "lock-by margin is short: 12 blocks (lock-by 280100, tip 280088); the last lock height is at most 280100; see the action";
const NOMINAL_NOTE = "nominal lock-by 280100 has passed (tip 280120); the lock is still allowed until the hard limit 280200";
const FUND_CLOSED_NOTE = "funding window is closed: the last height to fund was 280078 (lock-by 280107, tip 280517)";
const BOB_LAST_PASSED_NOTE = "the last lock height 280000 has passed (nominal lock-by 280100, tip 280120)";
const TOO_LATE = { action: "abort", reason: "too late to fund: tip 280517 + 29 > lock-by 280107" };
const BOB_TOO_LATE = { action: "abort", reason: "last lock height 280000 passed before Alice's funding was final" };
const T5_ABORT = { action: "abort", reason: "F_max 50000 is below max(50,000, 3 x estimate 20000) = 60000: the contract v1 rule (multiplier 3) (T5)" };
const PASSED_NOTE = "lock-by 280100 has passed: tip 280120 is 20 blocks beyond it";
const FUND_SHORT_NOTE = "funding window is short: 9 blocks left before it is too late to fund (lock-by 280624, tip 280500); see the action";

const put = (h, role, phase, notes = [], action) => h.f.writeTickAt(role, mkTick({ phase, notes, ...(action ? { action } : {}) }), h.clock.ms - 3000);
const loop = (h, role) => h.loop(role);
/** The wallet status the console keeps for a role. eth: { held, need } in wei (as text); noid: { plain, need } in micro-NOID (Alice). */
function status(h, role, o = {}) {
  const held = o.held ?? "5000000000000000";
  const need = o.need ?? (role === "alice" ? "1000000000000000" : "1900000000000000");
  const covered = BigInt(held) >= BigInt(need);
  const noid = role === "alice" ? { address: WNA, plain_micronoid: String(o.plain ?? 10100000), amount_micronoid: "10000000", fee_reserve_micronoid: "6000", need_micronoid: String(o.needNoid ?? 10006000), covers: BigInt(o.plain ?? 10100000) >= BigInt(o.needNoid ?? 10006000), tip: "280500" } : null;
  h.runner.walletStatus[role] = {
    at_ms: o.at_ms ?? h.clock.ms,
    ok: true,
    noid,
    eth: { address: role === "alice" ? E.alice_receiver : E.bob_sender, required_wei: need, reserve_wei: "1000000000000000", amount_wei: role === "bob" ? E.amount_wei : "0", balance_wei: held, shortfall_wei: covered ? "0" : String(BigInt(need) - BigInt(held)), covered, key_checked: true },
    problems: [],
  };
}
const notes = (h, role) => h.audit.all().filter((r) => r.action === "autopilot" && r.phase === "note" && r.role === role);
const raised = (h, role) => notes(h, role).filter((r) => /^needs you: deposit-/.test(r.result));
const cleared = (h, role) => notes(h, role).filter((r) => /^cleared: deposit-/.test(r.result));
const view = (h, role) => h.ap.view(h.run())[role].needs_you;
const tickNow = (h, role) => JSON.parse(fs.readFileSync(path.join(h.f.run, `last-tick-${role}.json`), "utf8")).now;
const short = (a) => `${a.slice(0, 6)}…${a.slice(-5)}`;

/** Bob, approved, Alice's funding final (his file at funding_final), a fresh tick and loop; the status is set by the caller. */
function bobApproved(o = {}) {
  const B = makeWallet({ role: "bob" });
  put(B, "bob", o.phase || "funding_final", o.notes || [SHORT_NOTE], o.action);
  loop(B, "bob");
  assert.equal(B.approve("bob", { statements: BOB_STATEMENTS }).status, 200);
  return B;
}
/** Alice, approved, file at created. */
function aliceApproved(o = {}) {
  const A = makeWallet({ role: "alice" });
  put(A, "alice", o.phase || "created", o.notes || [FUND_SHORT_NOTE], o.action);
  loop(A, "alice");
  assert.equal(A.approve("alice", { statements: ALICE_STATEMENTS }).status, 200);
  return A;
}
/** A tick and a status older than the next steps would accept are written again on every call. */
const refresh = (h, role, phase, noteList, action) => {
  put(h, role, phase, noteList, action);
  loop(h, role);
};

test("the live case: Bob approved, the key holds 0.0011 ETH of 0.0019 ETH: one entry names the coin, the figures and what to send more, with the time left, and one audit line", () => {
  const B = bobApproved();
  try {
    status(B, "bob", { held: "1100000000000000", need: "1900000000000000" });
    assert.deepEqual(view(B, "bob"), [], "nothing before the first look");
    steps(B, 1);
    const v = view(B, "bob");
    assert.equal(v.length, 1);
    assert.equal(v[0].spend, "deposit-eth");
    assert.equal(v[0].kind, "deposit");
    assert.equal(v[0].label, "Your deposit");
    assert.equal(v[0].reason, `Your ETH deposit is short: this swap's key holds 0.0011 ETH of 0.0019 ETH. Send 0.0008 ETH more to ${short(E.bob_sender)}. The engine says: ${SHORT_NOTE}.`);
    assert.equal(v[0].until, tickNow(B, "bob") + 240, "12 blocks at 20 s: the time is a field of its own, not in the sentence");
    assert.match(v[0].reason, /^Your ETH deposit is short: this swap's key holds 0\.0011 ETH of 0\.0019 ETH\. Send 0\.0008 ETH more to 0x[0-9a-fA-F]{4}…[0-9a-fA-F]{5}\./);
    // the same entry through the swap list's own path (it drives the tray)
    assert.equal(B.ap.needViews("bob").length, 1);
    // one audit line when it is raised, none again on later steps
    assert.equal(raised(B, "bob").length, 1);
    assert.equal(raised(B, "bob")[0].result, "needs you: deposit-eth");
    assert.match(raised(B, "bob")[0].detail, /^deposit: Your ETH deposit is short/);
    for (let i = 0; i < 3; i++) {
      status(B, "bob", { held: "1100000000000000", need: "1900000000000000" });
      refresh(B, "bob", "funding_final", [SHORT_NOTE]);
      steps(B, 1);
    }
    assert.equal(raised(B, "bob").length, 1, "one line, however many steps");
    assert.equal(view(B, "bob").length, 1);
    // no secret and no key anywhere in the line
    for (const r of notes(B, "bob")) assert.doesNotMatch(JSON.stringify(r), /passphrase|0x[0-9a-f]{64}/i);
    // nothing was sent by this
    assert.deepEqual(B.log.filter((l) => !l.dry && l.script !== "wallet-status.sh"), []);
  } finally {
    B.cleanup();
  }
});

test("the entry also shows while an action is running, and it needs no 'I have dealt with it' (the page leaves the button out for kind deposit)", () => {
  const B = bobApproved();
  try {
    status(B, "bob", { held: "1100000000000000" });
    B.runner.busy = { id: "wallet-status-bob" };
    steps(B, 1);
    assert.equal(view(B, "bob").length, 1);
    assert.equal(view(B, "bob")[0].kind, "deposit");
    B.runner.busy = null;
    // the person cannot clear it by hand: it is not one of the stopped steps
    assert.throws(() => B.ap.clearNeedsYou("bob", "deposit-eth"), /nothing to clear/);
  } finally {
    B.cleanup();
  }
});

test("a coin with nothing deposited raises an entry only when the engine's note is short or passed", () => {
  // a quiet note: no entry
  const B = bobApproved({ notes: [QUIET_NOTE] });
  try {
    status(B, "bob", { held: "0" });
    steps(B, 2);
    assert.deepEqual(view(B, "bob"), []);
    assert.equal(raised(B, "bob").length, 0);
    // no note at all (before the first reading of the lock-by margin): no entry
    refresh(B, "bob", "funding_final", []);
    status(B, "bob", { held: "0" });
    steps(B, 1);
    assert.deepEqual(view(B, "bob"), []);
    // the engine's note turns short: "Deposit now"
    refresh(B, "bob", "funding_final", [SHORT_NOTE]);
    status(B, "bob", { held: "0" });
    steps(B, 1);
    assert.equal(view(B, "bob").length, 1);
    assert.equal(view(B, "bob")[0].reason, `Deposit now: this swap's key holds no ETH and needs 0.0019 ETH. Send 0.0019 ETH to ${short(E.bob_sender)}. The engine says: ${SHORT_NOTE}.`);
    assert.equal(view(B, "bob")[0].until, tickNow(B, "bob") + 240);
    assert.equal(raised(B, "bob").length, 1);
  } finally {
    B.cleanup();
  }
});

test("the nominal lock-by form ('still allowed until the hard limit') keeps the short-deposit entry, as a warning, without 'the time may be over'", () => {
  const B = bobApproved({ notes: [NOMINAL_NOTE] });
  try {
    status(B, "bob", { held: "0" });
    steps(B, 1);
    const v = view(B, "bob");
    assert.equal(v.length, 1);
    assert.match(v[0].reason, /^Deposit now: this swap's key holds no ETH and needs 0\.0019 ETH\. Send 0\.0019 ETH to /);
    assert.match(v[0].reason, /The engine says: nominal lock-by 280100 has passed/);
    assert.doesNotMatch(v[0].reason, /may be over|min left|too late/);
    assert.equal(v[0].until, null, "no count of blocks in this form");
    status(B, "bob", { held: "1100000000000000" });
    steps(B, 1);
    assert.match(view(B, "bob")[0].reason, /^Your ETH deposit is short: /);
    assert.equal(raised(B, "bob").length, 1);
  } finally {
    B.cleanup();
  }
});

test("a short deposit that holds something raises an entry whatever the note says, and without a fresh tick it says nothing of the time", () => {
  const B = bobApproved({ notes: [EXACT_NOTE] });
  try {
    status(B, "bob", { held: "1100000000000000" });
    steps(B, 1);
    assert.equal(view(B, "bob").length, 1);
    assert.equal(view(B, "bob")[0].until, tickNow(B, "bob") + 6000, "300 blocks at 20 s a block");
    assert.doesNotMatch(view(B, "bob")[0].reason, /min left/);
    // an old tick: the entry stays (the holding is short), the time clause goes
    B.adv(200000);
    status(B, "bob", { held: "1100000000000000" });
    B.ap.step();
    assert.equal(view(B, "bob").length, 1);
    assert.doesNotMatch(view(B, "bob")[0].reason, /min left|engine says/);
    assert.equal(view(B, "bob")[0].until, null, "a stale tick: no time");
    assert.equal(raised(B, "bob").length, 1, "an update of the words is not a new line");
  } finally {
    B.cleanup();
  }
});

test("the entry clears by itself as soon as the coin is covered: one audit line, the view is empty", () => {
  const B = bobApproved();
  try {
    status(B, "bob", { held: "1100000000000000" });
    steps(B, 1);
    assert.equal(view(B, "bob").length, 1);
    assert.equal(cleared(B, "bob").length, 0);
    status(B, "bob", { held: "2000000000000000" });
    steps(B, 1);
    assert.deepEqual(view(B, "bob"), []);
    assert.equal(B.ap.needViews("bob").length, 0);
    assert.equal(cleared(B, "bob").length, 1);
    assert.equal(cleared(B, "bob")[0].result, "cleared: deposit-eth");
    assert.equal(cleared(B, "bob")[0].detail, "the deposit is seen and covers it");
    steps(B, 2);
    assert.equal(cleared(B, "bob").length, 1, "once");
    // short again later: raised again, a second line
    status(B, "bob", { held: "1500000000000000" });
    steps(B, 1);
    assert.equal(view(B, "bob").length, 1);
    assert.equal(raised(B, "bob").length, 2);
  } finally {
    B.cleanup();
  }
});

test("the entry clears when the phase leaves the deposit phases (the lock was sent) and never appears after the deposit was spent", () => {
  const B = bobApproved();
  try {
    status(B, "bob", { held: "1100000000000000" });
    steps(B, 1);
    assert.equal(view(B, "bob").length, 1);
    // Bob's lock is in: his file is past the deposit phases, the key now "holds less than the reserve"
    refresh(B, "bob", "lock_seen", []);
    status(B, "bob", { held: "100000000000000" });
    steps(B, 1);
    assert.deepEqual(view(B, "bob"), []);
    assert.equal(cleared(B, "bob").length, 1);
    assert.equal(cleared(B, "bob")[0].detail, "the swap has moved past the deposit step");
    steps(B, 3);
    assert.equal(raised(B, "bob").length, 1, "nothing new after the lock");
  } finally {
    B.cleanup();
  }
});

test("after the lock from the start: a status that says the key holds less than the reserve raises nothing, for every phase past the deposit", () => {
  for (const phase of ["lock_seen", "lock_final", "reveal_seen", "claimed", "refunded", "done", "aborted"]) {
    const B = bobApproved({ phase, notes: [SHORT_NOTE] });
    try {
      status(B, "bob", { held: "100000000000000" });
      steps(B, 2);
      assert.deepEqual(view(B, "bob"), [], phase);
      assert.equal(raised(B, "bob").length, 0, phase);
    } finally {
      B.cleanup();
    }
  }
});

test("without a tick the program cannot place the swap: nothing is raised", () => {
  const B = makeWallet({ role: "bob" });
  try {
    B.loop("bob");
    assert.equal(B.approve("bob", { statements: BOB_STATEMENTS }).status, 200);
    status(B, "bob", { held: "1100000000000000" });
    steps(B, 2);
    assert.deepEqual(view(B, "bob"), []);
  } finally {
    B.cleanup();
  }
});

test("the approval withdrawn clears the entry with its audit line; an approval that lapsed (the terms changed) clears it at the next step", () => {
  const B = bobApproved();
  try {
    status(B, "bob", { held: "1100000000000000" });
    steps(B, 1);
    assert.equal(view(B, "bob").length, 1);
    assert.equal(B.ap.turnOff("bob").status, 200);
    assert.deepEqual(B.ap.needViews("bob"), []);
    assert.equal(cleared(B, "bob").length, 1);
    assert.equal(cleared(B, "bob")[0].detail, "the approval was withdrawn");
    status(B, "bob", { held: "1100000000000000" });
    steps(B, 3);
    assert.deepEqual(view(B, "bob"), [], "no approval: nothing is raised");
    assert.equal(raised(B, "bob").length, 1);
  } finally {
    B.cleanup();
  }
  const L = bobApproved();
  try {
    status(L, "bob", { held: "1100000000000000" });
    steps(L, 1);
    assert.equal(view(L, "bob").length, 1);
    // the settings changed after the approval: it is out of force
    fs.appendFileSync(path.join(L.f.run, "env.local.sh"), "# changed after the approval\nFOO='1'\n");
    status(L, "bob", { held: "1100000000000000" });
    steps(L, 1);
    assert.equal(L.ap.approvalState("bob", L.run(), { fresh: true }).in_force, false);
    assert.deepEqual(view(L, "bob").filter((n) => n.kind === "deposit"), []);
    assert.equal(cleared(L, "bob").length, 1);
    assert.equal(cleared(L, "bob")[0].detail, "the approval is not in force any more");
  } finally {
    L.cleanup();
  }
});

test("no approval, no entry: a short deposit alone raises nothing", () => {
  const B = makeWallet({ role: "bob" });
  try {
    put(B, "bob", "funding_final", [SHORT_NOTE]);
    loop(B, "bob");
    status(B, "bob", { held: "1100000000000000" });
    steps(B, 3);
    assert.deepEqual(view(B, "bob"), []);
    assert.equal(raised(B, "bob").length, 0);
  } finally {
    B.cleanup();
  }
});

test("a stale or missing wallet status says nothing new, and a stale one does not remove an entry that is already there", () => {
  const B = bobApproved();
  try {
    // missing
    B.runner.walletStatus.bob = null;
    steps(B, 2);
    assert.deepEqual(view(B, "bob"), []);
    // stale (older than the gate's 120 s)
    status(B, "bob", { held: "1100000000000000", at_ms: B.clock.ms - 200000 });
    steps(B, 2);
    assert.deepEqual(view(B, "bob"), []);
    assert.equal(raised(B, "bob").length, 0);
    // not clean
    B.runner.walletStatus.bob = { at_ms: B.clock.ms, ok: false, noid: null, eth: null, problems: ["the status helper timed out"] };
    steps(B, 1);
    assert.deepEqual(view(B, "bob"), []);
    // fresh and short: raised
    status(B, "bob", { held: "1100000000000000" });
    steps(B, 1);
    assert.equal(view(B, "bob").length, 1);
    // then the status goes stale: the entry stays, nothing is added, no clearing line
    B.adv(150000);
    refresh(B, "bob", "funding_final", [SHORT_NOTE]);
    B.runner.walletStatus.bob = { ...B.runner.walletStatus.bob, at_ms: B.clock.ms - 200000 };
    B.ap.step();
    assert.equal(view(B, "bob").length, 1);
    assert.equal(cleared(B, "bob").length, 0);
    assert.equal(raised(B, "bob").length, 1);
    // a status about another address says nothing either
    B.runner.walletStatus.bob = { ...B.runner.walletStatus.bob, at_ms: B.clock.ms, eth: { ...B.runner.walletStatus.bob.eth, address: "0x" + "12".repeat(20) } };
    B.ap.step();
    assert.equal(view(B, "bob").length, 1);
    assert.equal(cleared(B, "bob").length, 0);
  } finally {
    B.cleanup();
  }
});

test("Alice, a short NOID deposit: the entry names NOID, what the wallet holds and what to send more", () => {
  const A = aliceApproved();
  try {
    // the swap wallet holds 5.006 NOID of the 10.006 the funding needs; the ETH reserve is covered
    status(A, "alice", { plain: 5006000, needNoid: 10006000, held: "5000000000000000" });
    steps(A, 1);
    const v = view(A, "alice");
    assert.equal(v.length, 1);
    assert.equal(v[0].spend, "deposit-noid");
    assert.equal(v[0].reason, `Your NOID deposit is short: this swap's wallet holds 5.006 NOID of 10.006 NOID. Send 5 NOID more to ${short(WNA)}. The engine says: ${FUND_SHORT_NOTE}.`);
    assert.equal(v[0].until, tickNow(A, "alice") + 180);
    assert.equal(raised(A, "alice").length, 1);
    assert.equal(raised(A, "alice")[0].result, "needs you: deposit-noid");
    // covered: it goes
    status(A, "alice", { plain: 10100000, needNoid: 10006000, held: "5000000000000000" });
    steps(A, 1);
    assert.deepEqual(view(A, "alice"), []);
    assert.equal(cleared(A, "alice").length, 1);
    assert.equal(cleared(A, "alice")[0].result, "cleared: deposit-noid");
  } finally {
    A.cleanup();
  }
});

test("Alice: an empty NOID wallet with a quiet funding window raises nothing, the ETH reserve is its own coin", () => {
  const A = aliceApproved({ notes: ["funding window: 78 blocks left before it is too late to fund (lock-by 280624, tip 280517)"] });
  try {
    status(A, "alice", { plain: 0, needNoid: 10006000, held: "400000000000000", need: "1000000000000000" });
    steps(A, 1);
    // the NOID wallet is empty and the window is quiet: nothing for NOID; the ETH key holds something but not the reserve: one entry for ETH
    assert.deepEqual(view(A, "alice").map((n) => n.spend), ["deposit-eth"]);
    assert.match(view(A, "alice")[0].reason, /^Your ETH deposit is short: this swap's key holds 0\.0004 ETH of 0\.001 ETH\. Send 0\.0006 ETH more to /);
    // the window turns short: the empty NOID wallet is asked for too
    refresh(A, "alice", "created", [FUND_SHORT_NOTE]);
    status(A, "alice", { plain: 0, needNoid: 10006000, held: "400000000000000", need: "1000000000000000" });
    steps(A, 1);
    assert.deepEqual(view(A, "alice").map((n) => n.spend).sort(), ["deposit-eth", "deposit-noid"]);
    assert.match(view(A, "alice").find((n) => n.spend === "deposit-noid").reason, /^Deposit now: this swap's wallet holds no NOID and needs 10\.006 NOID\. Send 10\.006 NOID to /);
    assert.equal(raised(A, "alice").length, 2);
  } finally {
    A.cleanup();
  }
});

test("Alice after her funding (the marker) or past created: a short status raises nothing", () => {
  const A = aliceApproved();
  try {
    status(A, "alice", { plain: 5006000, needNoid: 10006000 });
    steps(A, 1);
    assert.equal(view(A, "alice").length, 1);
    // the funding is sent: the wallet's NOID is spent and the status says it is short
    fs.writeFileSync(path.join(A.f.run, "wallet-funded.marker"), "2026-11-19T10:00:00Z\ntxid " + "ef".repeat(32) + "\n");
    status(A, "alice", { plain: 0, needNoid: 10006000 });
    steps(A, 1);
    assert.deepEqual(view(A, "alice"), []);
    assert.equal(cleared(A, "alice").length, 1);
    steps(A, 2);
    assert.equal(raised(A, "alice").length, 1);
  } finally {
    A.cleanup();
  }
  const P = aliceApproved({ phase: "funded", notes: [] });
  try {
    status(P, "alice", { plain: 0, needNoid: 10006000 });
    steps(P, 2);
    assert.deepEqual(view(P, "alice"), []);
    assert.equal(raised(P, "alice").length, 0);
  } finally {
    P.cleanup();
  }
});

test("the swap list's needs_you flag sees the entry (it drives the tray): needViews is what the swap set reads", () => {
  const B = bobApproved();
  try {
    assert.equal(B.ap.needViews("bob").length, 0);
    status(B, "bob", { held: "1100000000000000" });
    steps(B, 1);
    assert.equal(B.ap.needViews("bob").length > 0, true);
    // and the page's payload carries it while the approval is in force
    assert.equal(B.ap.view(B.run()).bob.needs_you.length, 1);
  } finally {
    B.cleanup();
  }
});

test("a classic run (no swap wallet) is as before: nothing is looked at", () => {
  const C = makeWallet({ role: "bob", classic: true });
  try {
    put(C, "bob", "funding_final", [SHORT_NOTE]);
    loop(C, "bob");
    C.ap.turnOn("bob", "0.001 ETH", { stay_on: true, no_manual_steps: true });
    status(C, "bob", { held: "1100000000000000" });
    steps(C, 2);
    assert.deepEqual(C.ap.needViews("bob"), []);
    assert.equal(raised(C, "bob").length, 0);
  } finally {
    C.cleanup();
  }
});

test("the fixtures the tests lean on: Bob's file phases that need the deposit are the page's own", () => {
  // the page's depositNeeded: Bob received, funded, funding_final; Alice created with no funding marker
  const B = bobApproved({ phase: "received", notes: [SHORT_NOTE] });
  try {
    status(B, "bob", { held: "1100000000000000" });
    steps(B, 1);
    assert.equal(view(B, "bob").length, 1, "received");
  } finally {
    B.cleanup();
  }
  const Fnd = bobApproved({ phase: "funded", notes: [SHORT_NOTE] });
  try {
    status(Fnd, "bob", { held: "1100000000000000" });
    steps(Fnd, 1);
    assert.equal(view(Fnd, "bob").length, 1, "funded");
  } finally {
    Fnd.cleanup();
  }
});

// ---------------------------------------------------------------------------------------------------------------- fix round 1

const deposits = (h, role) => view(h, role).filter((n) => n.kind === "deposit");
const CLOSED_TEXT = "The engine says it is too late for this swap: do not send coins to it.";

test("a stale tick, a broken tick file and a node that is down and back never clear an open entry and never raise it twice", () => {
  const B = bobApproved();
  try {
    status(B, "bob", { held: "0" });
    steps(B, 1);
    assert.match(view(B, "bob")[0].reason, /^Deposit now: /);
    assert.equal(raised(B, "bob").length, 1);
    const same = (label) => {
      assert.equal(deposits(B, "bob").length, 1, label);
      assert.equal(raised(B, "bob").length, 1, `${label}: one raise line`);
      assert.equal(cleared(B, "bob").length, 0, `${label}: no clear line`);
    };
    // the node is down: the tick is not rewritten and passes 120 s; the wallet status is still read
    B.adv(200000);
    status(B, "bob", { held: "0" });
    steps(B, 2);
    same("stale tick");
    assert.equal(view(B, "bob")[0].until, null, "a kept entry on a stale tick carries no time");
    // the status helper fails too
    B.runner.walletStatus.bob = { at_ms: B.clock.ms, ok: false, noid: null, eth: null, problems: ["the status helper timed out"] };
    steps(B, 2);
    same("status not clean");
    // a broken tick file
    fs.writeFileSync(path.join(B.f.run, "last-tick-bob.json"), "{ not json");
    status(B, "bob", { held: "0" });
    steps(B, 2);
    same("broken tick file");
    // the node is back: a fresh tick and a fresh status
    refresh(B, "bob", "funding_final", [SHORT_NOTE]);
    status(B, "bob", { held: "0" });
    steps(B, 2);
    same("node back");
    assert.match(view(B, "bob")[0].reason, /^Deposit now: /);
    assert.equal(view(B, "bob")[0].until, tickNow(B, "bob") + 240, "a fresh tick gives the time again");
  } finally {
    B.cleanup();
  }
});

test("a missing tick (null) keeps an open entry as it is; only a tick that names a later phase takes it back", () => {
  const B = bobApproved();
  try {
    status(B, "bob", { held: "1100000000000000" });
    steps(B, 1);
    assert.equal(deposits(B, "bob").length, 1);
    fs.rmSync(path.join(B.f.run, "last-tick-bob.json"), { force: true });
    status(B, "bob", { held: "1100000000000000" });
    steps(B, 3);
    assert.equal(deposits(B, "bob").length, 1);
    assert.equal(cleared(B, "bob").length, 0);
    assert.equal(raised(B, "bob").length, 1);
    refresh(B, "bob", "lock_final", []);
    steps(B, 1);
    assert.equal(deposits(B, "bob").length, 0);
    assert.equal(cleared(B, "bob").length, 1);
  } finally {
    B.cleanup();
  }
});

test("after Bob's lock was sent, the balance the wallet poll reads is not a missing deposit, though the tick still reads funding_final", () => {
  const B = makeWallet({ role: "bob" });
  try {
    status(B, "bob", { held: "5000000000000000" });
    B.tick("bob", "lock_eth");
    B.loop("bob");
    assert.equal(B.approve("bob", { statements: BOB_STATEMENTS }).status, 200);
    steps(B, 2);
    assert.equal(B.log.filter((l) => l.script === "lock.sh" && !l.dry).length, 1, "the lock was sent by the autopilot");
    // 30 to 50 s until the next watch tick: the tick is still at funding_final, and the key now holds what is left after the lock
    refresh(B, "bob", "funding_final", [SHORT_NOTE]);
    status(B, "bob", { held: "100000000000000" });
    steps(B, 3);
    assert.deepEqual(deposits(B, "bob"), []);
    assert.equal(raised(B, "bob").length, 0);
    // even with nothing left in the key
    status(B, "bob", { held: "0" });
    steps(B, 2);
    assert.equal(raised(B, "bob").length, 0);
  } finally {
    B.cleanup();
  }
});

test("an open entry is taken back, with a truthful reason, once Bob's lock was started", () => {
  const B = bobApproved();
  try {
    status(B, "bob", { held: "1100000000000000" });
    steps(B, 1);
    assert.equal(deposits(B, "bob").length, 1);
    // the actions module's own record of a start that was not cleanly refused
    B.runner.latch.set("send-lock", { tickNow: 1, intentAt: null });
    steps(B, 1);
    assert.deepEqual(deposits(B, "bob"), []);
    assert.equal(cleared(B, "bob").length, 1);
    assert.match(cleared(B, "bob")[0].detail, /^your lock was started, so the key's balance no longer shows a missing deposit/);
    status(B, "bob", { held: "100000000000000" });
    steps(B, 2);
    assert.equal(raised(B, "bob").length, 1, "nothing new");
  } finally {
    B.cleanup();
  }
});

test("Alice after her funding was sent (the tick still at created): no entry, whether the marker or the latch tells it", () => {
  const A = makeWallet({ role: "alice" });
  try {
    status(A, "alice", { plain: 10100000, needNoid: 10006000 });
    A.tick("alice", "fund_noid");
    A.loop("alice");
    assert.equal(A.approve("alice", { statements: ALICE_STATEMENTS }).status, 200);
    steps(A, 2);
    assert.equal(A.log.filter((l) => l.script === "wallet-fund.sh" && !l.dry).length, 1, "the funding was sent by the autopilot");
    refresh(A, "alice", "created", [FUND_SHORT_NOTE]);
    status(A, "alice", { plain: 0, needNoid: 10006000 });
    steps(A, 3);
    assert.deepEqual(deposits(A, "alice"), []);
    assert.equal(raised(A, "alice").length, 0);
    // the latch alone (the marker removed) says the same
    fs.rmSync(path.join(A.f.run, "wallet-funded.marker"), { force: true });
    refresh(A, "alice", "created", [FUND_SHORT_NOTE]);
    status(A, "alice", { plain: 0, needNoid: 10006000 });
    steps(A, 2);
    assert.deepEqual(deposits(A, "alice"), []);
    assert.equal(raised(A, "alice").length, 0);
  } finally {
    A.cleanup();
  }
  const O = aliceApproved();
  try {
    status(O, "alice", { plain: 5006000, needNoid: 10006000 });
    steps(O, 1);
    assert.equal(deposits(O, "alice").length, 1);
    O.runner.latch.set("send-fund", { tickNow: 1, intentAt: null });
    steps(O, 1);
    assert.deepEqual(deposits(O, "alice"), []);
    assert.match(cleared(O, "alice")[0].detail, /^your funding was started/);
  } finally {
    O.cleanup();
  }
});

test("Alice: the window is closed and the engine aborts: no instruction to send coins; an open entry becomes one plain line without amounts or address", () => {
  const A = aliceApproved();
  try {
    status(A, "alice", { plain: 5006000, needNoid: 10006000 });
    steps(A, 1);
    assert.equal(view(A, "alice")[0].spend, "deposit-noid");
    refresh(A, "alice", "created", [FUND_CLOSED_NOTE], TOO_LATE);
    status(A, "alice", { plain: 5006000, needNoid: 10006000 });
    steps(A, 1);
    const v = view(A, "alice");
    assert.equal(v.length, 1);
    assert.equal(v[0].spend, "deposit-closed");
    assert.equal(v[0].kind, "deposit");
    assert.ok(v[0].reason.startsWith(CLOSED_TEXT));
    assert.match(v[0].reason, /funding window is closed/);
    assert.doesNotMatch(v[0].reason, /Send |NOID of|o1|0x|Deposit now/);
    assert.equal(cleared(A, "alice").length, 1);
    assert.match(cleared(A, "alice")[0].detail, /too late for this swap/);
    assert.equal(raised(A, "alice").length, 2, "the NOID entry and the plain line");
    steps(A, 3);
    assert.equal(raised(A, "alice").length, 2);
    assert.equal(cleared(A, "alice").length, 1);
    // the abort is recorded: the file leaves the deposit phase and the line goes
    refresh(A, "alice", "aborted", []);
    steps(A, 1);
    assert.deepEqual(deposits(A, "alice"), []);
    assert.equal(cleared(A, "alice").length, 2);
    assert.equal(cleared(A, "alice")[1].detail, "the swap has moved past the deposit step");
  } finally {
    A.cleanup();
  }
  // nothing open and nothing deposited: no instruction at all, not even a new line
  const Z = aliceApproved({ notes: [FUND_CLOSED_NOTE], action: TOO_LATE });
  try {
    status(Z, "alice", { plain: 0, needNoid: 10006000, held: "0", need: "1000000000000000" });
    steps(Z, 3);
    assert.deepEqual(deposits(Z, "alice"), []);
    assert.equal(raised(Z, "alice").length, 0);
  } finally {
    Z.cleanup();
  }
});

test("Bob: the last lock height passed (an abort, or only the note): the same plain line, never 'Deposit now'", () => {
  for (const o of [{ notes: [BOB_LAST_PASSED_NOTE], action: BOB_TOO_LATE }, { notes: [BOB_LAST_PASSED_NOTE] }, { notes: [], action: BOB_TOO_LATE }]) {
    const B = bobApproved();
    try {
      status(B, "bob", { held: "1100000000000000" });
      steps(B, 1);
      assert.equal(view(B, "bob")[0].spend, "deposit-eth");
      refresh(B, "bob", "funding_final", o.notes, o.action);
      status(B, "bob", { held: "1100000000000000" });
      steps(B, 1);
      assert.equal(view(B, "bob").length, 1, JSON.stringify(o));
      assert.equal(view(B, "bob")[0].spend, "deposit-closed");
      assert.ok(view(B, "bob")[0].reason.startsWith(CLOSED_TEXT));
      assert.doesNotMatch(view(B, "bob")[0].reason, /Send |ETH of|0x|Deposit now/);
    } finally {
      B.cleanup();
    }
    const N = bobApproved({ notes: o.notes, action: o.action });
    try {
      status(N, "bob", { held: "0" });
      steps(N, 3);
      assert.deepEqual(deposits(N, "bob"), [], `no entry from the start: ${JSON.stringify(o)}`);
      assert.equal(raised(N, "bob").length, 0);
    } finally {
      N.cleanup();
    }
  }
  // the lock-by passed in the plain form too
  const P = bobApproved({ notes: [PASSED_NOTE] });
  try {
    status(P, "bob", { held: "0" });
    steps(P, 2);
    assert.deepEqual(deposits(P, "bob"), []);
  } finally {
    P.cleanup();
  }
});

test("an abort that can turn back on the next tick (the fee rule) leaves an open entry as it is and raises nothing new", () => {
  const B = bobApproved();
  try {
    status(B, "bob", { held: "1100000000000000" });
    steps(B, 1);
    const before = view(B, "bob")[0].reason;
    refresh(B, "bob", "funding_final", [SHORT_NOTE], T5_ABORT);
    status(B, "bob", { held: "1100000000000000" });
    steps(B, 2);
    assert.equal(view(B, "bob")[0].reason, before);
    assert.equal(raised(B, "bob").length, 1);
    assert.equal(cleared(B, "bob").length, 0);
  } finally {
    B.cleanup();
  }
  const N = bobApproved({ action: T5_ABORT });
  try {
    status(N, "bob", { held: "0" });
    steps(N, 2);
    assert.deepEqual(deposits(N, "bob"), []);
  } finally {
    N.cleanup();
  }
});

test("a time is given only where the engine's count is the real limit", () => {
  const run = (notes, role = "bob", st = { held: "1100000000000000" }) => {
    const H = role === "bob" ? bobApproved({ notes }) : aliceApproved({ notes });
    try {
      status(H, role, st);
      steps(H, 1);
      const n = view(H, role)[0];
      return { ...n, secs: n.until === null ? null : n.until - tickNow(H, role) };
    } finally {
      H.cleanup();
    }
  };
  assert.equal(run([EXACT_NOTE]).secs, 6000, "lock-by margin with an exact last lock height");
  assert.equal(run([SHORT_NOTE]).secs, 240, "lock margin");
  assert.equal(run([FUND_SHORT_NOTE], "alice", { plain: 5006000, needNoid: 10006000 }).secs, 180, "funding window");
  for (const n of [AT_MOST_NOTE, QUIET_NOTE]) {
    const r = run([n]);
    assert.equal(r.secs, null, n);
    assert.match(r.reason, /The engine says: lock-by margin/, n);
  }
  assert.equal(run(["lock margin is short: 1 blocks to the last lock height 280000 (nominal lock-by 280100, tip 279999); see the action"]).secs, 20);
});

test("the closed line stays on a stale tick: no false reason, no new line, no deposit entry coming back", () => {
  const A = aliceApproved();
  try {
    status(A, "alice", { plain: 5006000, needNoid: 10006000 });
    steps(A, 1);
    refresh(A, "alice", "created", [FUND_CLOSED_NOTE], TOO_LATE);
    status(A, "alice", { plain: 5006000, needNoid: 10006000 });
    steps(A, 1);
    assert.equal(view(A, "alice")[0].spend, "deposit-closed");
    const lines = (notes(A, "alice")).length;
    // the node goes down: the tick is not rewritten and passes 120 s; the status is still read
    A.adv(200000);
    status(A, "alice", { plain: 5006000, needNoid: 10006000 });
    steps(A, 3);
    assert.deepEqual(view(A, "alice").map((n) => n.spend), ["deposit-closed"]);
    assert.equal(notes(A, "alice").length, lines, "no audit line");
    assert.equal(raised(A, "alice").filter((r) => /deposit-noid/.test(r.result)).length, 1, "the NOID entry was raised once, before");
    // a broken tick file says nothing either
    fs.writeFileSync(path.join(A.f.run, "last-tick-alice.json"), "{ not json");
    status(A, "alice", { plain: 5006000, needNoid: 10006000 });
    steps(A, 2);
    assert.deepEqual(view(A, "alice").map((n) => n.spend), ["deposit-closed"]);
    assert.equal(notes(A, "alice").length, lines);
    // a fresh tick that no longer says it takes the line back, with its reason
    refresh(A, "alice", "created", [FUND_SHORT_NOTE]);
    status(A, "alice", { plain: 5006000, needNoid: 10006000 });
    steps(A, 1);
    assert.deepEqual(view(A, "alice").map((n) => n.spend), ["deposit-noid"]);
    assert.equal(cleared(A, "alice").filter((r) => /deposit-closed/.test(r.result))[0].detail, "the engine no longer says it is too late");
  } finally {
    A.cleanup();
  }
});

test("a kept entry carries a time only while the tick it came from is fresh", () => {
  const B = bobApproved();
  try {
    status(B, "bob", { held: "1100000000000000" });
    steps(B, 1);
    assert.equal(view(B, "bob")[0].until, tickNow(B, "bob") + 240);
    // the status is not clean (kept), the tick is fresh: the time stays
    B.runner.walletStatus.bob = { at_ms: B.clock.ms, ok: false, noid: null, eth: null, problems: ["the status helper timed out"] };
    steps(B, 2);
    assert.equal(view(B, "bob").length, 1);
    assert.notEqual(view(B, "bob")[0].until, null);
    // the tick is not rewritten for 150 s: kept, and no time
    B.adv(150000);
    steps(B, 1);
    assert.equal(view(B, "bob").length, 1);
    assert.equal(view(B, "bob")[0].until, null);
    assert.equal(raised(B, "bob").length, 1);
    assert.equal(cleared(B, "bob").length, 0);
  } finally {
    B.cleanup();
  }
});

test("the engine's 'lock-by L has passed ...; the last lock height is H' is not over (the lock may still be allowed); '... has passed too' is", () => {
  const STILL = "lock-by 280100 has passed: tip 280120 is 20 blocks beyond it; the last lock height is at most 280200";
  const TOO = "lock-by 280100 has passed: tip 280300 is 200 blocks beyond it; the last lock height, at most 280200, has passed too";
  const B = bobApproved({ notes: [STILL] });
  try {
    status(B, "bob", { held: "0" });
    steps(B, 1);
    assert.equal(view(B, "bob").length, 1);
    assert.match(view(B, "bob")[0].reason, /^Deposit now: .*The engine says: lock-by 280100 has passed/);
    assert.doesNotMatch(view(B, "bob")[0].reason, /too late/);
    refresh(B, "bob", "funding_final", [TOO]);
    status(B, "bob", { held: "0" });
    steps(B, 1);
    assert.equal(view(B, "bob")[0].spend, "deposit-closed");
  } finally {
    B.cleanup();
  }
});

test("the board's 'needs you' shows a deposit entry as its own sentence, not as a stopped step", () => {
  const BV = require("../lib/boardview");
  const reason = "Your ETH deposit is short: this swap's key holds 0.0011 ETH of 0.0019 ETH. Send 0.0008 ETH more to 0x0000…0b0b0.";
  const n = BV.needsYou({ ap: { needs_you: [{ spend: "deposit-eth", label: "Your deposit", reason, kind: "deposit" }] }, board: {} });
  assert.equal(n.length, 1);
  assert.equal(n[0].code, "deposit_short");
  assert.equal(n[0].title, "Your deposit is short");
  assert.equal(n[0].text, reason);
  assert.equal(n[0].tool_words, null);
  assert.doesNotMatch(n[0].title + " " + n[0].text, /will not try again|stopped/);
  const c = BV.needsYou({ ap: { needs_you: [{ spend: "deposit-closed", reason: CLOSED_TEXT, kind: "deposit" }] }, board: {} });
  assert.equal(c[0].code, "deposit_closed");
  assert.equal(c[0].text, CLOSED_TEXT);
  // a stopped step is as before
  assert.equal(BV.needsYou({ ap: { needs_you: [{ spend: "send-lock", reason: "x" }] }, board: {} })[0].code, "step_stopped");
});

test("the page's render signature keys a deposit entry on its id, kind and figures, not on the minutes", () => {
  global.window = global.window || {};
  require("../actions.js");
  const NA = global.window.NoidActions;
  const noop = () => null;
  NA.init({ el: noop, chip: noop, copyButton: noop, short: String, clock: String, dayClock: String, nowS: () => 0, state: { token: "t", payload: null }, reload: async () => {}, rerender: noop });
  const AP = (n) => ({ available: true, on: true, needs_you: n });
  const sig = (n) => NA.signature({ enabled: true, autopilot: { alice: AP([]), bob: AP(n) } });
  const e = (reason, figs = "1100000000000000|1900000000000000") => [{ spend: "deposit-eth", label: "Your deposit", reason, kind: "deposit", figs }];
  assert.equal(sig(e("Your ETH deposit is short: x. About 40 min left (the engine says: a).")), sig(e("Your ETH deposit is short: x. About 39 min left (the engine says: a).")), "the minutes are not drawn into the signature");
  assert.notEqual(sig(e("x")), sig(e("x", "1500000000000000|1900000000000000")), "another amount is another box");
  assert.notEqual(sig(e("x")), sig([]));
  // a stopped step still goes by its reason
  const stopped = (r) => [{ spend: "send-lock", label: "Lock the ETH", reason: r }];
  assert.notEqual(sig(stopped("a")), sig(stopped("b")));
});

test("the page draws the time of a short deposit outside the alert, counts it down and updates it in place", () => {
  class Node {
    constructor(tag) {
      this.tag = tag;
      this.attrs = {};
      this.dataset = {};
      this.children = [];
      this.listeners = {};
      this.className = "";
      this.disabled = false;
      this._text = "";
    }
    setAttribute(k, v) {
      this.attrs[k] = v;
    }
    appendChild(c) {
      this.children.push(c);
      return c;
    }
    addEventListener(t, f) {
      (this.listeners[t] = this.listeners[t] || []).push(f);
    }
    set textContent(v) {
      this._text = String(v);
    }
    get textContent() {
      return this._text + this.children.map((c) => (c.textContent !== undefined ? c.textContent : "")).join("");
    }
    all(pred, out = []) {
      if (pred(this)) out.push(this);
      for (const c of this.children) if (c instanceof Node) c.all(pred, out);
      return out;
    }
  }
  class Text {
    constructor(t) {
      this.textContent = t;
    }
  }
  const el = (tag, attrs, ...kids) => {
    const e = new Node(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v === null || v === undefined || v === false) continue;
      if (k === "class") e.className = v;
      else if (k === "text") e.textContent = v;
      else if (k === "dataset") Object.assign(e.dataset, v);
      else if (k.startsWith("on") && typeof v === "function") e.addEventListener(k.slice(2), v);
      else e.setAttribute(k, v === true ? "" : String(v));
    }
    for (const c of kids.flat()) {
      if (c === null || c === undefined || c === false) continue;
      e.appendChild(typeof c === "string" || typeof c === "number" ? new Text(String(c)) : c);
    }
    return e;
  };
  let NOW = 1000;
  let root = null;
  global.document = { createElement: (t) => new Node(t), createTextNode: (t) => new Text(t), getElementById: () => null, querySelectorAll: (sel) => (sel === "[data-deposit-time]" && root ? root.all((n) => n.dataset && n.dataset.depositTime !== undefined) : []) };
  global.window = global.window || {};
  require("../actions.js");
  const NA = global.window.NoidActions;
  NA.init({ el, chip: (kind, text) => el("span", { class: "chip " + kind, text }), copyButton: () => el("span"), short: String, clock: String, dayClock: String, nowS: () => NOW, state: { token: "t", payload: null }, reload: async () => {}, rerender: () => {} });
  const entry = (until) => ({ spend: "deposit-eth", label: "Your deposit", reason: "Your ETH deposit is short: this swap's key holds 0.0011 ETH of 0.0019 ETH. Send 0.0008 ETH more to 0x0000…0b0b0. The engine says: x.", at: 1, kind: "deposit", figs: "1|2", until });
  const payload = (until) => ({ actions: { enabled: true, production: null, autopilot: { alice: null, bob: { available: true, on: true, approved_at: 1, terms_changed: false, doing: "waiting", waiting_reason: null, needs_you: [entry(until)], statements: [], expected_typed: "0.001 ETH", funding_offered: null } } } });
  const view = { role: "bob", phase: { id: "funding_final", terminal: false } };
  root = NA.autopilotBlock(view, payload(NOW + 5 * 60 + 30));
  const alert = root.all((n) => /alarm danger/.test(n.className))[0];
  assert.ok(alert, "the alert box is drawn");
  assert.match(alert.textContent, /Your ETH deposit is short/);
  assert.doesNotMatch(alert.textContent, /min left|Under a minute/, "the time is not inside the alert");
  assert.equal(alert.all((n) => n.dataset && n.dataset.depositTime !== undefined).length, 0);
  assert.equal(root.all((n) => n.tag === "button" || /btn/.test(n.className)).filter((n) => /dealt with it/.test(n.textContent)).length, 0, "no 'I have dealt with it'");
  const line = root.all((n) => n.dataset && n.dataset.depositTime === "deposit-eth")[0];
  assert.ok(line);
  assert.equal(line.textContent, "About 5 min left.");
  // it counts down by itself
  NOW += 4 * 60;
  NA.tick();
  assert.equal(line.textContent, "About 1 min left.");
  NOW += 40;
  NA.tick();
  assert.equal(line.textContent, "Under a minute left.");
  // a newer payload sets it in place (the box is not rebuilt): a new time, then none (a stale reading)
  NA.depositTimes.refresh(payload(NOW + 20 * 60).actions);
  assert.equal(line.textContent, "About 20 min left.");
  NA.depositTimes.refresh(payload(null).actions);
  assert.equal(line.textContent, "");
  NA.tick();
  assert.equal(line.textContent, "", "no time stays no time");
  assert.equal(NA.depositTimes.text(null), "");
});
