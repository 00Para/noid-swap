"use strict";
// The autopilot in a WALLET run (swap wallet, piece 2c): a whole swap and the abort path for both roles on fake helpers with zero spend requests from a page, the funding's unknown
// outcome run again, the waits, the approval, and that a classic run behaves as before. Every helper is a fake; none of this has been run against a real node or a public network.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { steps, codes, refusedSync } = require("./autopilot-harness");
const AP = require("../lib/autopilot");
const F = require("./actions-fixtures");
const { mkTick } = require("./helpers");
const { makeWallet, recoverTick, endedTick, WEP, WNP } = require("./wallet-harness");

const OK_STATEMENTS = { stay_on: true, no_manual_steps: true, bob_check_matches: true }; // a wallet run's Alice: no "no pending funding"
const BOB_STATEMENTS = { stay_on: true, no_manual_steps: true };
const spy = (h) => {
  const calls = [];
  const orig = h.runner.startSpend.bind(h.runner);
  h.runner.startSpend = (id, typed, meta) => (calls.push({ id, typed, meta }), orig(id, typed, meta));
  return calls;
};
const put = (h, role, tick) => h.f.writeTickAt(role, tick, h.clock.ms - 3000);
const waitTick = (phase) => mkTick({ phase, action: { action: "wait", reason: "waiting" } });
const real = (h, script, flag) => h.log.filter((l) => l.script === script && !l.dry && (flag === undefined || l.flags.join(" ") === flag)).length;
const dry = (h, script, flag) => h.log.filter((l) => l.script === script && l.dry && (flag === undefined || l.flags.join(" ") === flag)).length;
const needs = (h, role) => h.ap.view(h.run())[role].needs_you;
const everyAuto = (h, calls) => assert.ok(calls.every((c) => c.typed === null && c.meta.auto === h.ap.token), "every spend was an automatic one, nothing typed by a page");

// ---------------------------------------------------------------------------------------------- Alice
test("Alice, abort path: the funding from the swap wallet, then (after D) the recovery, its recording and both sweeps, each once, with zero spend requests", () => {
  const A = makeWallet({ role: "alice" });
  try {
    const calls = spy(A);
    A.runner.walletPoll(); // the deposit is seen
    A.tick("alice", "fund_noid");
    A.loop("alice");
    const r = A.approve("alice", { statements: OK_STATEMENTS });
    assert.equal(r.status, 200);
    assert.equal(r.body.funding_statements_valid_until, null, "a wallet run has no 300 s funding window");
    // 1. the funding: dry run, then the send, through wallet-fund.sh
    steps(A, 2);
    assert.equal(dry(A, "wallet-fund.sh"), 1);
    assert.equal(real(A, "wallet-fund.sh"), 1);
    assert.equal(A.count("fund.sh"), 0, "the classic fund.sh never ran");
    assert.ok(fs.existsSync(path.join(A.f.run, "wallet-funded.marker")));
    assert.deepEqual(needs(A, "alice"), []);
    // the funding is done: nothing more is offered for it, and no second funding is started on the next ticks
    A.adv(40000);
    put(A, "alice", mkTick({ phase: "funded", action: { action: "wait", reason: "waiting for finality" }, intent: { status: "held", intent: { action: "fund_noid", params: { action: "fund_noid", amount_micronoid: F.TERMS.amount_micronoid }, decided_at: F.INTENT_AT } }, notes: ["held: fresh decision was fund_noid"] }));
    A.loop("alice");
    steps(A, 3);
    assert.equal(real(A, "wallet-fund.sh"), 1, "never a second funding");
    // 2. after D: the recovery close (a ledger intent the engine offers)
    A.adv(40000);
    put(A, "alice", recoverTick());
    A.loop("alice");
    steps(A, 2);
    assert.equal(dry(A, "wallet-recover.sh", "--dry-run"), 1);
    assert.equal(real(A, "wallet-recover.sh", ""), 1);
    assert.ok(fs.existsSync(path.join(A.f.run, "wallet-recovered-txid.txt")));
    // 3. the close is sent and not yet recorded: the recording is tried (it sends nothing), about once a minute
    A.adv(40000);
    put(A, "alice", waitTick("lock_final"));
    A.loop("alice");
    steps(A, 1);
    assert.equal(A.log.filter((l) => l.script === "wallet-recover.sh" && l.flags.join(" ") === "--record").length, 1);
    steps(A, 1);
    assert.equal(A.log.filter((l) => l.flags.join(" ") === "--record").length, 1, "not again within a minute");
    A.adv(61000);
    put(A, "alice", waitTick("lock_final"));
    A.loop("alice");
    steps(A, 1);
    assert.equal(A.log.filter((l) => l.flags.join(" ") === "--record").length, 2, "tried again after a minute");
    // 4. the file records the end: the sweeps, NOID first, each once (dry run, then send)
    A.adv(40000);
    put(A, "alice", endedTick("refunded"));
    A.loop("alice");
    steps(A, 4);
    assert.equal(dry(A, "wallet-sweep.sh", "noid --dry-run"), 1);
    assert.equal(real(A, "wallet-sweep.sh", "noid"), 1);
    assert.equal(dry(A, "wallet-sweep.sh", "eth alice --dry-run"), 1);
    assert.equal(real(A, "wallet-sweep.sh", "eth alice"), 1);
    // and nothing is repeated afterwards
    A.adv(40000);
    put(A, "alice", endedTick("refunded"));
    A.loop("alice");
    steps(A, 4);
    assert.equal(real(A, "wallet-sweep.sh"), 2);
    assert.equal(real(A, "wallet-recover.sh", ""), 1);
    assert.deepEqual(needs(A, "alice"), []);
    assert.deepEqual(calls.map((c) => c.id), ["send-fund", "send-recover", "send-sweep-noid", "send-sweep-eth-alice"]);
    everyAuto(A, calls);
    assert.equal(A.spawned.length, 0, "the loops were running");
    // every send started by the autopilot is in the audit log with its approval
    for (const rec of A.audit.all().filter((x) => /^send-/.test(x.action) && x.phase === "start")) assert.match(rec.detail, /auto=1; approval=[0-9a-f]{12}/);
    assert.equal(A.audit.all().filter((x) => /^send-/.test(x.action) && x.phase === "start").length, 4);
  } finally {
    A.cleanup();
  }
});

test("Alice, a whole swap: the funding, the reveal, then both sweeps once the file says done", () => {
  const A = makeWallet({ role: "alice" });
  try {
    const calls = spy(A);
    A.runner.walletPoll();
    A.tick("alice", "fund_noid");
    A.loop("alice");
    assert.equal(A.approve("alice", { statements: OK_STATEMENTS }).status, 200);
    steps(A, 2);
    assert.equal(real(A, "wallet-fund.sh"), 1);
    A.adv(40000);
    A.tick("alice", "reveal_eth");
    A.loop("alice");
    steps(A, 2);
    assert.equal(dry(A, "reveal.sh"), 1);
    assert.equal(real(A, "reveal.sh"), 1);
    A.adv(40000);
    put(A, "alice", endedTick("done"));
    A.loop("alice");
    steps(A, 4);
    assert.equal(real(A, "wallet-sweep.sh", "noid"), 1);
    assert.equal(real(A, "wallet-sweep.sh", "eth alice"), 1);
    assert.deepEqual(calls.map((c) => c.id), ["send-fund", "send-reveal", "send-sweep-noid", "send-sweep-eth-alice"]);
    everyAuto(A, calls);
    assert.deepEqual(needs(A, "alice"), []);
  } finally {
    A.cleanup();
  }
});

// ---------------------------------------------------------------------------------------------- Bob
test("Bob, abort path: the lock, the ETH refund, then the sweep of his key once the file is refunded, with zero spend requests", () => {
  const B = makeWallet({ role: "bob" });
  try {
    const calls = spy(B);
    B.runner.walletPoll();
    B.tick("bob", "lock_eth");
    B.loop("bob");
    assert.equal(B.approve("bob", { statements: BOB_STATEMENTS }).status, 200);
    steps(B, 2);
    assert.equal(dry(B, "lock.sh"), 1);
    assert.equal(real(B, "lock.sh"), 1);
    B.adv(40000);
    B.tick("bob", "refund_eth");
    B.loop("bob");
    steps(B, 2);
    assert.equal(dry(B, "refund-eth.sh"), 1);
    assert.equal(real(B, "refund-eth.sh"), 1);
    B.adv(40000);
    put(B, "bob", endedTick("refunded"));
    B.loop("bob");
    steps(B, 2);
    assert.equal(dry(B, "wallet-sweep.sh", "eth bob --dry-run"), 1);
    assert.equal(real(B, "wallet-sweep.sh", "eth bob"), 1);
    assert.equal(real(B, "wallet-sweep.sh", "noid"), 0, "Bob has no NOID wallet");
    assert.deepEqual(calls.map((c) => c.id), ["send-lock", "send-refund-eth", "send-sweep-eth-bob"]);
    everyAuto(B, calls);
    assert.deepEqual(needs(B, "bob"), []);
    assert.equal(B.spawned.length, 0);
  } finally {
    B.cleanup();
  }
});

test("Bob, a whole swap: the lock, the NOID claim, then the sweep of his key once the file says done", () => {
  const B = makeWallet({ role: "bob" });
  try {
    const calls = spy(B);
    B.runner.walletPoll();
    B.tick("bob", "lock_eth");
    B.loop("bob");
    assert.equal(B.approve("bob", { statements: BOB_STATEMENTS }).status, 200);
    steps(B, 2);
    B.adv(40000);
    B.tick("bob", "claim_noid");
    B.loop("bob");
    steps(B, 2);
    assert.equal(real(B, "claim.sh"), 1);
    B.adv(40000);
    put(B, "bob", endedTick("done"));
    B.loop("bob");
    steps(B, 2);
    assert.equal(real(B, "wallet-sweep.sh", "eth bob"), 1);
    assert.deepEqual(calls.map((c) => c.id), ["send-lock", "send-claim", "send-sweep-eth-bob"]);
    everyAuto(B, calls);
  } finally {
    B.cleanup();
  }
});

test("a sweep is not offered while the swap is not over, or while the engine still offers a step; and not in a classic run", () => {
  const A = makeWallet({ role: "alice" });
  const C = makeWallet({ role: "alice", classic: true });
  try {
    A.runner.walletPoll();
    assert.equal(A.approve("alice", { statements: OK_STATEMENTS }).status, 200, "a wallet run's Alice may approve before the engine offers the funding");
    A.loop("alice");
    for (const tick of [waitTick("funding_final"), waitTick("lock_final"), mkTick({ phase: "done", action: { action: "refund_noid", call_height: 1, fee_micronoid: 5800 } }), mkTick({ phase: "done", action: { action: "wait", reason: "the ETH lock is still open (a leftover leg)" } })]) {
      A.adv(40000);
      put(A, "alice", tick);
      A.loop("alice");
      steps(A, 3);
      assert.equal(A.log.filter((l) => l.script === "wallet-sweep.sh").length, 0, JSON.stringify(tick.phase_after));
    }
    // the gate itself says why
    const ctx = A.runner.spendContext(require("../lib/gate").ALL_SPENDS["send-sweep-noid"], A.run(), A.clock.ms);
    assert.equal(ctx.relevant, false);
    // a classic run: an ended file offers no sweep and the autopilot starts nothing but the watch loop
    C.tick("alice", "fund_noid");
    C.loop("alice");
    C.f.writeTickAt("alice", endedTick("refunded"), C.clock.ms - 3000);
    assert.equal(C.ap.approvalState("alice", C.run()).exists, false);
    assert.equal(C.runner.spendContext(require("../lib/gate").ALL_SPENDS["send-sweep-noid"], C.run(), C.clock.ms).relevant, false);
    assert.equal(C.runner.spendContext(require("../lib/gate").ALL_SPENDS["send-recover"], C.run(), C.clock.ms).relevant, false);
  } finally {
    A.cleanup();
    C.cleanup();
  }
});

// ---------------------------------------------------------------------------------------------- rule 5: an unknown outcome of the funding is run again
test("rule 5: a funding whose outcome is unknown (exit 6) is not a stop: the helper is run again on a later tick, never twice on one tick, and sends the same bytes", () => {
  const A = makeWallet({ role: "alice", behaviour: { wallet: { exits: { "wallet-fund.sh": 6 } } } });
  try {
    const calls = spy(A);
    A.runner.walletPoll();
    A.tick("alice", "fund_noid");
    A.loop("alice");
    assert.equal(A.approve("alice", { statements: OK_STATEMENTS }).status, 200);
    steps(A, 2);
    assert.equal(real(A, "wallet-fund.sh"), 1);
    steps(A, 1); // the next step reads how it ended
    assert.deepEqual(needs(A, "alice"), [], "an unknown outcome is no longer a stop for the funding");
    const end = A.audit.all().filter((r) => r.action === "send-fund" && r.phase === "end").slice(-1)[0];
    assert.match(end.result, /^may have been sent, the same bytes may be sent again/);
    // the same tick: no second attempt, and the autopilot does not stop (it waits: the step was started on the tick now on disk)
    steps(A, 3);
    assert.match(A.ap.state.alice.waiting_reason, /started on the tick now on disk/);
    assert.equal(real(A, "wallet-fund.sh"), 1, "at most once per tick");
    assert.deepEqual(needs(A, "alice"), []);
    // a newer tick: the dry run and the helper again (this time it says sent)
    A.wallet.exits["wallet-fund.sh"] = 0;
    A.adv(10000);
    A.tick("alice", "fund_noid");
    A.loop("alice");
    steps(A, 3);
    assert.equal(real(A, "wallet-fund.sh"), 2);
    assert.ok(fs.existsSync(path.join(A.f.run, "wallet-funded.marker")));
    assert.deepEqual(needs(A, "alice"), []);
    assert.deepEqual(calls.map((c) => c.id), ["send-fund", "send-fund"]);
    // a restart does not turn that unknown outcome into a stop either (the audit log's end line is read as safe to run again)
    const R = A.restart();
    assert.deepEqual(R.ap.rebuildFromAudit("alice"), []);
  } finally {
    A.cleanup();
  }
});

test("rule 5: a funding that ends in any other unclear way (exit 1) is a stop, as before; a clean refusal is counted; 'nothing to send now' is neither", () => {
  const U = makeWallet({ role: "alice", behaviour: { wallet: { exits: { "wallet-fund.sh": 1 } } } });
  const R = makeWallet({ role: "alice", behaviour: { wallet: { exits: { "wallet-fund.sh": 3 } } } });
  const W = makeWallet({ role: "alice", behaviour: { wallet: { exits: { "wallet-fund.sh": 4 } } } });
  try {
    for (const h of [U, R, W]) {
      h.runner.walletPoll();
      h.tick("alice", "fund_noid");
      h.loop("alice");
      assert.equal(h.approve("alice", { statements: OK_STATEMENTS }).status, 200);
    }
    steps(U, 3);
    assert.equal(needs(U, "alice").length, 1);
    assert.equal(needs(U, "alice")[0].spend, "send-fund");
    steps(U, 3);
    assert.equal(real(U, "wallet-fund.sh"), 1, "a stop is not touched again");
    // a refusal (exit 3, nothing sent) is counted, three in a row stop it; each needs a newer tick and a new dry run
    for (let i = 0; i < 3; i++) {
      R.adv(10000);
      R.tick("alice", "fund_noid");
      R.loop("alice");
      steps(R, 3);
    }
    assert.equal(real(R, "wallet-fund.sh"), 3);
    assert.match(needs(R, "alice")[0].reason, /refused 3 times/);
    // "nothing to send now" (exit 4: the deposit is too young): not a refusal, not a stop, asked again only for a newer tick
    steps(W, 3);
    assert.equal(real(W, "wallet-fund.sh"), 1);
    assert.deepEqual(needs(W, "alice"), []);
    assert.equal(W.ap.refusals.get("send-fund"), undefined);
    steps(W, 3);
    assert.equal(real(W, "wallet-fund.sh"), 1, "the same tick: not asked again");
    assert.match(W.ap.state.alice.waiting_reason, /nothing to send now|next tick/);
    W.wallet.exits["wallet-fund.sh"] = 0;
    W.adv(10000);
    W.tick("alice", "fund_noid");
    W.loop("alice");
    steps(W, 3);
    assert.equal(real(W, "wallet-fund.sh"), 2, "a newer tick: asked again, and now it sends");
    assert.deepEqual(needs(W, "alice"), []);
  } finally {
    U.cleanup();
    R.cleanup();
    W.cleanup();
  }
});

test("rule 4 in the autopilot: it waits for the deposit and the reserve (no dry run, no send) and says what it waits for", () => {
  const A = makeWallet({ role: "alice", behaviour: { wallet: { statusOpts: { covered: false } } } });
  try {
    A.runner.walletPoll();
    A.tick("alice", "fund_noid");
    A.loop("alice");
    assert.equal(A.approve("alice", { statements: OK_STATEMENTS }).status, 200);
    steps(A, 4);
    assert.equal(A.log.filter((l) => l.script === "wallet-fund.sh").length, 0, "no helper ran");
    assert.match(A.ap.state.alice.waiting_reason, /fee reserve|holds less/);
    // a short deposit is a wait, not a stop of a step; since the short-deposit entry (test/simple-short-deposit.test.js) a key that holds a little but not the reserve is also told to the person
    assert.deepEqual(needs(A, "alice").filter((n) => n.kind !== "deposit"), [], "a short deposit is a wait, not a stop");
    // the deposit arrives: the next status (a poll later) lets it go
    A.wallet.statusOpts = {};
    A.adv(45000);
    A.runner.walletPoll();
    A.tick("alice", "fund_noid");
    A.loop("alice");
    steps(A, 2);
    assert.equal(real(A, "wallet-fund.sh"), 1);
    // a status older than 120 s stops the funding too (nothing polls here: the autopilot never reads the deposit itself)
  } finally {
    A.cleanup();
  }
  const S = makeWallet({ role: "alice" });
  try {
    S.runner.walletPoll();
    S.adv(130000);
    S.tick("alice", "fund_noid");
    S.loop("alice");
    assert.equal(S.approve("alice", { statements: OK_STATEMENTS }).status, 200);
    steps(S, 3);
    assert.equal(S.log.filter((l) => l.script === "wallet-fund.sh").length, 0);
    assert.match(S.ap.state.alice.waiting_reason, /younger than 120 s/);
  } finally {
    S.cleanup();
  }
});

// ---------------------------------------------------------------------------------------------- rule 8: a refused sweep is a wait
test("rule 8: a sweep the tool refuses ('lock still open', 'instance not closed') is a wait, tried again after 5 minutes, never a stop and never a refusal that counts", () => {
  const A = makeWallet({ role: "alice", behaviour: { wallet: { exits: { "wallet-sweep.sh": 3 } } } });
  try {
    A.loop("alice");
    A.runner.walletPoll();
    A.tick("alice", "fund_noid");
    assert.equal(A.approve("alice", { statements: OK_STATEMENTS }).status, 200);
    A.adv(10000);
    put(A, "alice", endedTick("refunded"));
    A.loop("alice");
    steps(A, 5);
    assert.equal(real(A, "wallet-sweep.sh", "noid"), 1, "tried once");
    assert.deepEqual(needs(A, "alice"), []);
    // the NOID sweep waits; the Ethereum sweep (another spend) is not held back by it
    assert.equal(real(A, "wallet-sweep.sh", "eth alice"), 1, "the other sweep went on");
    // within 5 minutes nothing is tried again, even on new ticks
    for (let i = 0; i < 3; i++) {
      A.adv(60000);
      put(A, "alice", endedTick("refunded"));
      A.loop("alice");
      steps(A, 3);
    }
    assert.equal(real(A, "wallet-sweep.sh", "noid"), 1);
    assert.equal(A.ap.refusals.get("send-sweep-noid"), undefined, "a refused sweep is not counted");
    assert.match(A.ap.state.alice.waiting_reason || "", /tried again in \d+ min|not ready/);
    // after 5 minutes it is tried again (and this time the tool lets it go)
    A.wallet.exits["wallet-sweep.sh"] = 0;
    A.adv(300000);
    put(A, "alice", endedTick("refunded"));
    A.loop("alice");
    steps(A, 4);
    assert.equal(real(A, "wallet-sweep.sh", "noid"), 2);
    assert.deepEqual(needs(A, "alice"), []);
  } finally {
    A.cleanup();
  }
});

// An empty swap wallet (rehearsal 4.10, R410-7 and R410-4): the funding spent the wallet's one coin with no change, so every swap that went through leaves the NOID sweep with nothing to send.
const NOTHING_LEFT = "Nothing is left in the swap wallet to send back.";
const auditEnds = (h, action) => h.audit.all().filter((r) => r.action === action && r.phase === "end").map((r) => r.result);
const emptyWalletStart = (A) => {
  A.loop("alice");
  A.runner.walletPoll();
  A.tick("alice", "fund_noid");
  assert.equal(A.approve("alice", { statements: OK_STATEMENTS }).status, 200);
  A.adv(10000);
  // the swap ended: the watch loop has stopped, so no newer tick comes by itself
  put(A, "alice", endedTick("done"));
  A.loop("alice");
};

test("rule 8, an empty NOID wallet (rehearsal 4.10, R410-7): the tool's 'no plain coin' refusal ends the NOID sweep: the Ethereum sweep goes on once, nothing is tried again, no waiting text, the swap reads as finished", () => {
  const A = makeWallet({ role: "alice", behaviour: { wallet: { sweepNoidDryExit: 3 } } });
  try {
    emptyWalletStart(A);
    steps(A, 8);
    assert.equal(dry(A, "wallet-sweep.sh", "noid --dry-run"), 1, "the NOID sweep's dry run was tried once");
    assert.equal(real(A, "wallet-sweep.sh", "noid"), 0, "a NOID sweep whose dry run was refused is never sent");
    assert.equal(dry(A, "wallet-sweep.sh", "eth alice --dry-run"), 1, "the Ethereum sweep's dry run ran");
    assert.equal(real(A, "wallet-sweep.sh", "eth alice"), 1, "the Ethereum sweep went on");
    assert.deepEqual(needs(A, "alice"), [], "no stop");
    assert.equal(A.ap.refusals.get("send-sweep-noid"), undefined, "not counted as a refusal");
    assert.equal(A.ap.timedWait.has("send-sweep-noid"), false, "not on the 5-minute timer");
    // the page: a plain finished line, no waiting text
    const v = A.ap.view(A.run()).alice;
    assert.deepEqual(v.finished_notes, [NOTHING_LEFT]);
    assert.match(v.doing, /finished/);
    assert.equal(v.waiting_reason, null);
    assert.doesNotMatch(JSON.stringify(v), /tried again in|did not accept/);
    // the audit line says what it was
    assert.deepEqual(auditEnds(A, "dry-sweep-noid"), ["nothing to sweep (exit 3)"]);
    // neither after 5 minutes nor after 30 minutes is anything tried again or a watch loop started (no loop file is written from here on)
    const started = A.spawned.length;
    for (const ms of [300000, 1800000]) {
      A.adv(ms);
      put(A, "alice", endedTick("done"));
      steps(A, 4);
    }
    assert.equal(dry(A, "wallet-sweep.sh", "noid --dry-run"), 1, "the NOID sweep is not tried again");
    assert.equal(real(A, "wallet-sweep.sh", "noid"), 0);
    assert.equal(real(A, "wallet-sweep.sh", "eth alice"), 1, "the Ethereum sweep is not sent twice");
    assert.equal(A.spawned.length, started, "no watch loop is started for a swap that is finished");
    assert.deepEqual(needs(A, "alice"), []);
    assert.match(A.ap.state.alice.doing, /finished/);
    assert.equal(A.ap.state.alice.waiting_reason, null);
  } finally {
    A.cleanup();
  }
});

test("rule 8, a NOID sweep refused with any other exit-3 text keeps the 5-minute wait, the waiting text and the audit wording 'failed'", () => {
  const A = makeWallet({ role: "alice", behaviour: { wallet: { sweepNoidDryExit: 3, sweepNoidDryText: "error: refused: the instance is not closed yet\n" } } });
  try {
    emptyWalletStart(A);
    steps(A, 8);
    assert.equal(dry(A, "wallet-sweep.sh", "noid --dry-run"), 1);
    assert.equal(real(A, "wallet-sweep.sh", "eth alice"), 1, "the Ethereum sweep still goes on");
    assert.equal(A.ap.timedWait.has("send-sweep-noid"), true, "on the 5-minute timer");
    assert.deepEqual(A.ap.view(A.run()).alice.finished_notes, []);
    assert.match(A.ap.state.alice.waiting_reason || "", /tried again in \d+ min/);
    assert.deepEqual(auditEnds(A, "dry-sweep-noid"), ["failed (exit 3)"]);
    A.adv(240000);
    put(A, "alice", endedTick("done"));
    steps(A, 3);
    assert.equal(dry(A, "wallet-sweep.sh", "noid --dry-run"), 1, "not tried again within 5 minutes");
    A.adv(120000);
    put(A, "alice", endedTick("done"));
    steps(A, 3);
    assert.ok(dry(A, "wallet-sweep.sh", "noid --dry-run") >= 2, "tried again after the timer");
    assert.deepEqual(needs(A, "alice"), []);
  } finally {
    A.cleanup();
  }
});

test("rule 8, an empty NOID wallet: only a wallet status read AFTER the refusal that shows a plain coin brings the NOID sweep back", () => {
  const A = makeWallet({ role: "alice", behaviour: { wallet: { sweepNoidDryExit: 3 } } });
  try {
    emptyWalletStart(A);
    steps(A, 8);
    assert.equal(dry(A, "wallet-sweep.sh", "noid --dry-run"), 1);
    const status = (at_ms, plain) => ({ at_ms, ok: true, noid: { address: F.TERMS.alice_noid || "o1x", plain_micronoid: plain, amount_micronoid: "5000000", fee_reserve_micronoid: "6000", need_micronoid: "5006000", covers: false, tip: "1" }, eth: {}, problems: [] });
    const mark = A.ap.nothingLeft.get("send-sweep-noid").at_ms;
    // a status read before the refusal, or one that shows no coin, changes nothing
    A.runner.walletStatus.alice = status(mark - 1000, "5000000");
    A.adv(10000);
    put(A, "alice", endedTick("done"));
    steps(A, 3);
    assert.equal(dry(A, "wallet-sweep.sh", "noid --dry-run"), 1, "an older status does not bring it back");
    A.runner.walletStatus.alice = status(A.clock.ms, "0");
    A.adv(10000);
    put(A, "alice", endedTick("done"));
    steps(A, 3);
    assert.equal(dry(A, "wallet-sweep.sh", "noid --dry-run"), 1, "a newer status with no coin does not bring it back");
    // a newer status with a coin: the dry run is tried again (and this time the tool has something to send)
    A.wallet.sweepNoidDryExit = 0;
    A.runner.walletStatus.alice = status(A.clock.ms + 1000, "400000");
    A.adv(10000);
    put(A, "alice", endedTick("done"));
    A.loop("alice");
    steps(A, 4);
    assert.equal(dry(A, "wallet-sweep.sh", "noid --dry-run"), 2, "tried again");
    assert.equal(real(A, "wallet-sweep.sh", "noid"), 1, "and sent once");
    assert.deepEqual(A.ap.view(A.run()).alice.finished_notes, []);
    assert.deepEqual(needs(A, "alice"), []);
  } finally {
    A.cleanup();
  }
});

test("rule 8, an empty NOID wallet: 'nothing left' belongs to its run folder, and the manual dry run of the sweep still works", () => {
  const A = makeWallet({ role: "alice", behaviour: { wallet: { sweepNoidDryExit: 3 } } });
  try {
    emptyWalletStart(A);
    steps(A, 8);
    assert.equal(A.ap.nothingLeftNow("send-sweep-noid"), true);
    // the manual button is not affected: its own dry run starts as before
    A.adv(10000);
    A.runner.startAction("dry-sweep-noid");
    assert.equal(dry(A, "wallet-sweep.sh", "noid --dry-run"), 2);
    // another run folder is another wallet
    const dir = A.ap.runDir;
    A.ap.runDir = () => dir.call(A.ap) + "-other";
    assert.equal(A.ap.nothingLeftNow("send-sweep-noid"), false);
    assert.equal(A.ap.nothingLeft.has("send-sweep-noid"), false);
  } finally {
    A.cleanup();
  }
});

test("an Ethereum sweep that live.js broadcast and did not finish (exit 6 without the safe-to-repeat line) is a stop: it may have been sent and is not re-run", () => {
  const A = makeWallet({ role: "alice", behaviour: { wallet: { exits: { "wallet-sweep.sh:eth alice": 6 } } } });
  try {
    A.runner.walletPoll();
    A.tick("alice", "fund_noid");
    A.loop("alice");
    assert.equal(A.approve("alice", { statements: OK_STATEMENTS }).status, 200);
    A.adv(10000);
    put(A, "alice", endedTick("done"));
    A.loop("alice");
    steps(A, 8);
    assert.equal(real(A, "wallet-sweep.sh", "eth alice"), 1);
    assert.ok(needs(A, "alice").some((n) => n.spend === "send-sweep-eth-alice"), JSON.stringify(needs(A, "alice")));
    steps(A, 3);
    assert.equal(real(A, "wallet-sweep.sh", "eth alice"), 1, "not touched again");
  } finally {
    A.cleanup();
  }
});

// ---------------------------------------------------------------------------------------------- the approval
test("the approval of a wallet run: Alice's statements are stay_on, no_manual_steps and Bob's check line (no 'no pending funding'); the typed amount stays; both payouts are needed", () => {
  const A = makeWallet({ role: "alice" });
  const C = makeWallet({ role: "alice", classic: true });
  try {
    assert.deepEqual(AP.requiredStatements("alice", true), ["stay_on", "no_manual_steps", "bob_check_matches"]);
    assert.deepEqual(AP.requiredStatements("bob", true), ["stay_on", "no_manual_steps"]);
    assert.deepEqual(AP.requiredStatements("alice"), ["stay_on", "no_manual_steps", "no_pending_funding", "bob_check_matches"], "a classic run's statements are unchanged");
    A.runner.walletPoll();
    A.tick("alice", "fund_noid");
    // the typed amount still has to match
    assert.deepEqual(codes(refusedSync(() => A.approve("alice", { typed: "5 NOID", statements: OK_STATEMENTS }))), ["typed"]);
    // Bob's check line is still asked
    const e = refusedSync(() => A.approve("alice", { statements: { stay_on: true, no_manual_steps: true } }));
    assert.deepEqual(codes(e), ["statement_bob_check_matches"]);
    const v = A.ap.view(A.run()).alice;
    assert.deepEqual(v.statements.map((s) => s.id), ["stay_on", "no_manual_steps", "bob_check_matches"]);
    assert.equal(v.wallet, true);
    assert.deepEqual(v.payouts, { noid: WNP, eth: WEP });
    // a classic run does ask for the funding statement
    C.tick("alice", "fund_noid");
    assert.deepEqual(codes(refusedSync(() => C.approve("alice", { statements: OK_STATEMENTS }))), ["statement_no_pending_funding"]);
    assert.equal(C.ap.view(C.run()).alice.wallet, false);
    // Alice needs both payouts, Bob the Ethereum one
    const np = makeWallet({ role: "alice", noidPayout: null });
    const ep = makeWallet({ role: "bob", ethPayout: null });
    np.tick("alice", "fund_noid");
    ep.tick("bob", "lock_eth");
    assert.deepEqual(codes(refusedSync(() => np.approve("alice", { statements: OK_STATEMENTS }))), ["payout_missing"]);
    assert.deepEqual(codes(refusedSync(() => ep.approve("bob", { statements: BOB_STATEMENTS }))), ["payout_missing"]);
    np.cleanup();
    ep.cleanup();
    // approved once, a second approval is refused (nothing to re-arm in a wallet run)
    assert.equal(A.approve("alice", { statements: OK_STATEMENTS }).status, 200);
    assert.equal(refusedSync(() => A.approve("alice", { statements: OK_STATEMENTS })).status, 409);
  } finally {
    A.cleanup();
    C.cleanup();
  }
});

test("rule 9: the approval is bound to the mode and to both payout addresses: a change of either turns it off", () => {
  const A = makeWallet({ role: "alice" });
  try {
    A.runner.walletPoll();
    A.tick("alice", "fund_noid");
    A.loop("alice");
    assert.equal(A.approve("alice", { statements: OK_STATEMENTS }).status, 200);
    const inForce = () => A.ap.approvalState("alice", A.run()).in_force;
    assert.equal(inForce(), true);
    const envPath = path.join(A.f.run, "env.local.sh");
    const original = fs.readFileSync(envPath, "utf8");
    // the hash lists the three wallet items: it differs from the same file read as a classic run
    const hashWallet = A.ap.termsHash(A.run());
    fs.writeFileSync(envPath, original.replace(WEP, "0x" + "4d".repeat(20)));
    assert.equal(inForce(), false, "ETH_PAYOUT changed");
    assert.equal(A.ap.approvalState("alice", A.run()).terms_changed, true);
    fs.writeFileSync(envPath, original);
    assert.equal(inForce(), true, "restored");
    fs.writeFileSync(envPath, original.replace(WNP, "o1selftestsomeotherpayoutxxxxxx"));
    assert.equal(inForce(), false, "NOID_PAYOUT changed");
    fs.writeFileSync(envPath, original.replace("USE_SWAP_WALLET='1'\n", ""));
    assert.equal(inForce(), false, "the mode changed");
    fs.writeFileSync(envPath, original);
    assert.equal(A.ap.termsHash(A.run()), hashWallet);
    // a classic run's hash does not carry the wallet items (it is the hash a classic approval always had)
    const C = makeWallet({ role: "alice", classic: true, noidPayout: null, ethPayout: null });
    const src = fs.readFileSync(path.join(__dirname, "..", "lib", "autopilot.js"), "utf8");
    assert.match(src, /if \(wr\.use_swap_wallet \|\| wr\.ambiguous\) items\.push/);
    assert.ok(C.ap.termsHash(C.run()));
    C.cleanup();
  } finally {
    A.cleanup();
  }
});

test("rule 10: nothing the autopilot sends bypasses startSpend: the new spends cannot be started with a request's meta.auto, and are refused without an approval", () => {
  const A = makeWallet({ role: "alice" });
  try {
    A.runner.walletPoll();
    put(A, "alice", endedTick("refunded"));
    A.loop("alice");
    for (const id of ["send-sweep-noid", "send-sweep-eth-alice", "send-recover"]) {
      const e = refusedSync(() => A.runner.startSpend(id, null, { auto: { autopilot: true } }));
      assert.deepEqual(codes(e), ["autopilot_off"], id);
      const g = refusedSync(() => A.runner.startSpend(id, null, { auto: A.ap.token }));
      assert.deepEqual(codes(g), ["autopilot_off"], id + " without an approval");
    }
    assert.equal(A.log.filter((l) => l.script !== "wallet-status.sh").length, 0);
    // the request route never reads meta.auto
    const routes = fs.readFileSync(path.join(__dirname, "..", "lib", "actionroutes.js"), "utf8");
    assert.doesNotMatch(routes, /auto\s*:/);
  } finally {
    A.cleanup();
  }
});

// ---------------------------------------------------------------------------------------------- a sweep mined and failed (rehearsal 2026-11-26, F5b)
const MINED_TX = "0x406afab61e2844f6a2abfff7c07131ba6c23fc1138808862892377b9a43c353e";
const MINED_FAILED = `sweep SEND exit 1\nsent: ${MINED_TX} nonce 1 maxFeePerGas 0.000000034 gwei tip 0.000000002 gwei\nerror: transaction ${MINED_TX} failed (status 0)\n`;
const aliceAtDone = (wallet) => {
  const A = makeWallet({ role: "alice", behaviour: { wallet } });
  A.runner.walletPoll();
  A.tick("alice", "fund_noid");
  A.loop("alice");
  assert.equal(A.approve("alice", { statements: OK_STATEMENTS }).status, 200);
  A.adv(10000);
  put(A, "alice", endedTick("done"));
  A.loop("alice");
  return A;
};
const endLines = (h, id) => h.audit.all().filter((r) => r.action === id && r.phase === "end").map((r) => r.result);

test("F5b: an Ethereum sweep mined with status 0 says 'nothing moved, only the fee was spent', never 'may have been sent', and is built again once, after the sweep timer", () => {
  const wallet = { exits: { "wallet-sweep.sh:eth alice": 1 }, stdout: { "wallet-sweep.sh": MINED_FAILED } };
  const A = aliceAtDone(wallet);
  try {
    steps(A, 8);
    assert.equal(real(A, "wallet-sweep.sh", "eth alice"), 1);
    assert.deepEqual(needs(A, "alice").filter((n) => n.spend === "send-sweep-eth-alice"), [], "no stop: the chain says nothing moved");
    assert.ok(endLines(A, "send-sweep-eth-alice").some((r) => /^failed, mined with status 0: nothing moved, only the fee was spent/.test(r)), JSON.stringify(endLines(A, "send-sweep-eth-alice")));
    assert.ok(!endLines(A, "send-sweep-eth-alice").some((r) => /may have been sent/.test(r)));
    steps(A, 3);
    assert.equal(real(A, "wallet-sweep.sh", "eth alice"), 1, "not again before the sweep timer");
    // the retry succeeds (this build's sweep signs the node's estimate)
    wallet.exits["wallet-sweep.sh:eth alice"] = 0;
    delete wallet.stdout["wallet-sweep.sh"];
    A.adv(AP.SWEEP_RETRY_MS + 1000);
    put(A, "alice", endedTick("done"));
    A.loop("alice");
    steps(A, 8);
    assert.equal(real(A, "wallet-sweep.sh", "eth alice"), 2, "built again once");
    assert.deepEqual(needs(A, "alice").filter((n) => n.spend === "send-sweep-eth-alice"), []);
  } finally {
    A.cleanup();
  }
});

test("F5b: a second mined failure of the sweep stops with the plain words; a status-0 line without the matching 'sent:' line stays 'may have been sent'", () => {
  const wallet = { exits: { "wallet-sweep.sh:eth alice": 1 }, stdout: { "wallet-sweep.sh": MINED_FAILED } };
  const A = aliceAtDone(wallet);
  try {
    steps(A, 8);
    A.adv(AP.SWEEP_RETRY_MS + 1000);
    put(A, "alice", endedTick("done"));
    A.loop("alice");
    steps(A, 8);
    assert.equal(real(A, "wallet-sweep.sh", "eth alice"), 2);
    const n = needs(A, "alice").find((x) => x.spend === "send-sweep-eth-alice");
    assert.ok(n, JSON.stringify(needs(A, "alice")));
    assert.match(n.reason, /mined and FAILED \(status 0, transaction 0x406afab6/);
    assert.match(n.reason, /nothing moved, only the fee was spent/);
    assert.doesNotMatch(n.reason, /may have been sent/);
    A.adv(AP.SWEEP_RETRY_MS + 1000);
    put(A, "alice", endedTick("done"));
    A.loop("alice");
    steps(A, 8);
    assert.equal(real(A, "wallet-sweep.sh", "eth alice"), 2, "never a third time by itself");
  } finally {
    A.cleanup();
  }
  const other = "0x" + "ab".repeat(32);
  const B = aliceAtDone({ exits: { "wallet-sweep.sh:eth alice": 1 }, stdout: { "wallet-sweep.sh": `sweep SEND exit 1\nsent: ${other} nonce 1\nerror: transaction ${MINED_TX} failed (status 0)\n` } });
  try {
    steps(B, 8);
    const n = needs(B, "alice").find((x) => x.spend === "send-sweep-eth-alice");
    assert.ok(n, "a stop, as before");
    assert.match(n.reason, /may have been sent/);
  } finally {
    B.cleanup();
  }
});

test("rebuildFromAudit clears nothing-to-sweep and names mined-failed", () => {
  const A = makeWallet({ role: "alice" });
  try {
    const rec = (action, phase, result, t) => ({ action, phase, result, t: new Date(t).toISOString() });
    const ends = (list) => {
      A.ap.actions.audit = { all: () => list };
      return A.ap.rebuildFromAudit("alice");
    };
    // "nothing to sweep" is a clean end: no entry after a restart
    assert.deepEqual(ends([rec("send-sweep-noid", "start", "", 1000), rec("send-sweep-noid", "end", "nothing to sweep (exit 3)", 2000)]), []);
    // a send mined and FAILED: the first Ethereum sweep failure is not an entry (it is built again once), and a second one names the failure in plain words
    const failed = "failed, mined with status 0: nothing moved, only the fee was spent (exit 5)";
    const one = [rec("send-sweep-eth-alice", "start", "", 1000), rec("send-sweep-eth-alice", "end", failed, 2000)];
    assert.deepEqual(ends(one), []);
    const two = one.concat([rec("send-sweep-eth-alice", "start", "", 3000), rec("send-sweep-eth-alice", "end", failed, 4000)]);
    const e2 = ends(two);
    assert.equal(e2.length, 1);
    assert.equal(e2[0].spend, "send-sweep-eth-alice");
    assert.match(e2[0].reason, /mined and FAILED \(status 0\): nothing moved, only the fee was spent/);
    assert.doesNotMatch(e2[0].reason, /may have been sent/);
    // any other step that was mined and failed is an entry at once, in the same words
    const other = ends([rec("send-fund", "start", "", 1000), rec("send-fund", "end", failed, 2000)]);
    assert.equal(other.length, 1);
    assert.match(other[0].reason, /mined and FAILED/);
    // unchanged: an unknown end still reads as "may have been sent"
    const unknown = ends([rec("send-fund", "start", "", 1000), rec("send-fund", "end", "failed (exit 1)", 2000)]);
    assert.match(unknown[0].reason, /may have been sent/);
  } finally {
    A.cleanup();
  }
});
