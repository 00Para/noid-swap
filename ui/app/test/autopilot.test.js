"use strict";
// The autopilot (lib/autopilot.js): the approval, the loop, the stop rules and the amendments A to K of the design note. No timer: `step()` is called by hand,
// with the clock the ActionRunner was given. The helpers are the fake ones of autopilot-harness.js.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { make, steps, codes, refusedSync, TX, ALL_STATEMENTS } = require("./autopilot-harness");
const { SPENDS, factsReady } = require("../lib/gate");
const F = require("./actions-fixtures");

const fileOf = (h, role) => path.join(h.f.run, `autopilot-${role}.json`);
const readApproval = (h, role) => JSON.parse(fs.readFileSync(fileOf(h, role), "utf8"));
const viewOf = (h, role) => h.ap.view(h.run())[role];
function rewriteJson(file, fn) {
  const j = JSON.parse(fs.readFileSync(file, "utf8"));
  fn(j);
  fs.writeFileSync(file, JSON.stringify(j));
}
const bundles = (h) => [path.join(h.f.run, "alice.bundle.json"), path.join(h.f.pub, "alice.bundle.json")];
const real = (h, script) => h.count(script, false);
const needs = (h, role) => viewOf(h, role).needs_you;

// ---------------------------------------------------------------------------------------------- the approval
test("approval: refused for another console's role, a wrong amount, a missing or non-true statement, no funding on offer, production, a lost run lock and missing terms; nothing is written", () => {
  const h = make({ role: "alice" });
  try {
    h.loop("alice");
    h.tick("alice", "fund_noid");
    // the console drives Alice only
    assert.equal(refusedSync(() => h.ap.turnOn("bob", "0.001 ETH", ALL_STATEMENTS)).status, 403);
    // the typed amount is the role's own amount: 10 NOID for Alice
    for (const t of ["5 NOID", "10 ETH", "10", "0.001 ETH", ""]) {
      const e = refusedSync(() => h.ap.turnOn("alice", t, ALL_STATEMENTS));
      assert.equal(e.status, 422, t);
      assert.deepEqual(codes(e), ["typed"], t);
    }
    // every statement, one by one (J: the statement that nothing is sent by hand is one of them)
    for (const k of Object.keys(ALL_STATEMENTS)) {
      const e = refusedSync(() => h.ap.turnOn("alice", "10 NOID", { ...ALL_STATEMENTS, [k]: undefined }));
      assert.equal(e.status, 422, k);
      assert.deepEqual(codes(e), [`statement_${k}`], k);
      assert.equal(refusedSync(() => h.ap.turnOn("alice", "10 NOID", { ...ALL_STATEMENTS, [k]: "true" })).status, 422, "only the boolean true counts: " + k);
      assert.equal(refusedSync(() => h.ap.turnOn("alice", "10 NOID", { ...ALL_STATEMENTS, [k]: 1 })).status, 422, "only the boolean true counts: " + k);
    }
    // the request shape (the route's own checks): a statement that is not a boolean is a 400
    assert.equal(refusedSync(() => h.ap.handle({ on: true, role: "alice", typed: "10 NOID", statements: { ...ALL_STATEMENTS, stay_on: "yes" } })).status, 400);
    assert.equal(refusedSync(() => h.ap.handle({ on: true, role: "alice", typed: 10, statements: ALL_STATEMENTS })).status, 400);
    assert.equal(refusedSync(() => h.ap.handle({ role: "alice" })).status, 400);
    assert.equal(refusedSync(() => h.ap.handle({ on: true, role: "carol", typed: "x" })).status, 400);
    // Alice: the engine must offer the funding now (amendment B)
    h.waitTick("alice");
    const e2 = refusedSync(() => h.ap.turnOn("alice", "10 NOID", ALL_STATEMENTS));
    assert.deepEqual(codes(e2), ["funding_not_offered"]);
    assert.equal(fs.existsSync(fileOf(h, "alice")), false, "no refusal wrote an approval");
    assert.ok(h.audit.all().some((r) => r.action === "autopilot" && r.phase === "note" && /^refused: /.test(r.result)), "the refusals are in the audit log");
  } finally {
    h.cleanup();
  }
  // a console whose run lock is not ours
  const g = make({ role: "bob", runLock: { verify: () => ({ ok: false, why: "the lock file is gone" }), isLazy: false, file: "x" } });
  try {
    g.tick("bob", "lock_eth");
    assert.equal(refusedSync(() => g.approve("bob")).status, 409);
    assert.equal(fs.existsSync(fileOf(g, "bob")), false);
  } finally {
    g.cleanup();
  }
  // a production run
  const p = make({ role: "bob" });
  try {
    p.tick("bob", "lock_eth");
    fs.writeFileSync(path.join(p.f.run, "env.local.sh"), "PROFILE='production'\n");
    assert.equal(refusedSync(() => p.approve("bob")).status, 403);
    assert.equal(fs.existsSync(fileOf(p, "bob")), false);
  } finally {
    p.cleanup();
  }
  // no terms in the run folder
  const t = make({ role: "bob", noBundle: true });
  try {
    t.tick("bob", "lock_eth");
    assert.deepEqual(codes(refusedSync(() => t.approve("bob"))), ["terms_missing"]);
  } finally {
    t.cleanup();
  }
});

test("approval: written once through a temporary file with the fields of amendment G; a second one is refused; turning it off deletes it", () => {
  const h = make({ role: "bob" });
  try {
    h.tick("bob", "lock_eth");
    const r = h.approve("bob");
    assert.equal(r.status, 200);
    const file = readApproval(h, "bob");
    assert.equal(file.v, 1);
    assert.equal(file.role, "bob");
    assert.match(file.terms_sha256, /^[0-9a-f]{64}$/);
    assert.match(file.approved_at, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);
    assert.deepEqual(file.statements, ["stay_on", "no_manual_steps"]);
    assert.equal(typeof file.console_pid_start, "string");
    assert.deepEqual(file.needs_you, []);
    assert.deepEqual(fs.readdirSync(h.f.run).filter((n) => n.endsWith(".tmp")), [], "no temporary file is left");
    const before = fs.readFileSync(fileOf(h, "bob"), "utf8");
    assert.equal(refusedSync(() => h.approve("bob")).status, 409, "already on");
    assert.equal(fs.readFileSync(fileOf(h, "bob"), "utf8"), before, "the file was not touched");
    assert.equal(viewOf(h, "bob").on, true);
    // the approval line is in the audit log, without a transaction or an address
    const line = h.audit.all().find((x) => x.action === "autopilot" && x.result === "approval given");
    assert.ok(line && /terms=[0-9a-f]{12}/.test(line.detail));
    // off
    const off = h.ap.handle({ on: false, role: "bob" });
    assert.equal(off.status, 200);
    assert.equal(fs.existsSync(fileOf(h, "bob")), false);
    assert.equal(viewOf(h, "bob").on, false);
    // and it can be approved again
    assert.equal(h.approve("bob").status, 200);
  } finally {
    h.cleanup();
  }
});

test("approval: it survives a restart of the console", () => {
  const h = make({ role: "bob" });
  try {
    h.tick("bob", "lock_eth");
    h.approve("bob");
    const h2 = h.restart();
    assert.equal(viewOf(h2, "bob").on, true);
    h2.loop("bob");
    steps(h2, 2);
    assert.equal(real(h2, "lock.sh"), 1, "the restarted console carries on");
  } finally {
    h.cleanup();
  }
});

test("approval: a change of the terms switches it off by itself (amendment G: every bound field, the object file, env.local.sh and the helpers in bin/)", () => {
  const h = make({ role: "bob" });
  try {
    h.tick("bob", "lock_eth");
    h.loop("bob");
    h.approve("bob");
    assert.equal(viewOf(h, "bob").on, true);
    const originals = bundles(h).map((f) => fs.readFileSync(f, "utf8"));
    const restoreBundles = () => bundles(h).forEach((f, i) => fs.writeFileSync(f, originals[i]));
    const objFile = path.join(h.f.pub, "swap.object.json");
    const objOriginal = fs.readFileSync(objFile, "utf8");
    const bundleMutations = {
      hashlock: (j) => (j.hashlock = "0x" + "ee".repeat(32)),
      deadline_height: (j) => (j.params.deadline_height += 1),
      h_create: (j) => (j.params.h_create += 1),
      amount_micronoid: (j) => (j.params.amount_micronoid += 1),
      alice_noid: (j) => (j.params.alice_noid = "o1OTHER"),
      bob_noid: (j) => (j.params.bob_noid = "o1OTHER"),
      variant: (j) => (j.params.variant = "stock"),
      profile: (j) => (j.params.profile = "rehearsal"),
      contract_version: (j) => (j.params.contract_version = 2),
      max_fee_micronoid: (j) => (j.params.max_fee_micronoid = 60000),
      contract_root: (j) => (j.contract_root = "o1someotherroot"),
      chain_id: (j) => (j.params.eth.chain_id = 31337),
      htlc_contract: (j) => (j.params.eth.contract = "0x" + "00".repeat(18) + "beef"),
      alice_receiver: (j) => (j.params.eth.alice_receiver = "0x" + "00".repeat(18) + "a22c"),
      bob_sender: (j) => (j.params.eth.bob_sender = "0x" + "00".repeat(18) + "b1b1"),
      amount_wei: (j) => (j.params.eth.amount_wei = "2000000000000000"),
      lock_kind: (j) => (j.params.eth.lock_kind = "poseidon"),
      code_hash: (j) => (j.params.eth.code_hash = "0x" + "c1".repeat(32)),
      consistent: (j) => (j.claim_authority = "o1DIFFERENT"), // the object's authority and the bundle's no longer agree
    };
    for (const [name, mutate] of Object.entries(bundleMutations)) {
      for (const f of bundles(h)) rewriteJson(f, mutate);
      assert.equal(viewOf(h, "bob").on, false, `${name}: off`);
      assert.equal(viewOf(h, "bob").terms_changed, true, `${name}: said so`);
      restoreBundles();
      assert.equal(viewOf(h, "bob").on, true, `${name}: back on when the terms are back`);
    }
    // the object file (its sha256 and its claim authority)
    rewriteJson(objFile, (j) => (j.claim_authority = "o1AUTH-CHANGED"));
    assert.equal(viewOf(h, "bob").on, false, "object file");
    fs.writeFileSync(objFile, objOriginal);
    assert.equal(viewOf(h, "bob").on, true);
    fs.writeFileSync(objFile, objOriginal.replace("}", ', "note": 1}'));
    assert.equal(viewOf(h, "bob").on, false, "any byte of the object file");
    fs.writeFileSync(objFile, objOriginal);
    // env.local.sh
    fs.writeFileSync(path.join(h.f.run, "env.local.sh"), "AMOUNT=1\n");
    assert.equal(viewOf(h, "bob").on, false, "env.local.sh appeared");
    fs.rmSync(path.join(h.f.run, "env.local.sh"));
    assert.equal(viewOf(h, "bob").on, true);
    // the frozen helpers: a file added, one changed
    h.ap.turnOff("bob");
    fs.mkdirSync(path.join(h.f.run, "bin"));
    fs.writeFileSync(path.join(h.f.run, "bin", "lock.sh"), "echo one\n");
    h.tick("bob", "lock_eth");
    h.approve("bob");
    assert.equal(viewOf(h, "bob").on, true);
    fs.writeFileSync(path.join(h.f.run, "bin", "lock.sh"), "echo two\n");
    assert.equal(viewOf(h, "bob").on, false, "a helper changed");
    fs.writeFileSync(path.join(h.f.run, "bin", "lock.sh"), "echo one\n");
    assert.equal(viewOf(h, "bob").on, true);
    fs.writeFileSync(path.join(h.f.run, "bin", "extra.sh"), "echo x\n");
    assert.equal(viewOf(h, "bob").on, false, "a helper added");
  } finally {
    h.cleanup();
  }
});

test("approval: with the terms changed nothing runs, and the page is told so (the autopilot is treated as absent)", () => {
  const h = make({ role: "bob" });
  try {
    h.tick("bob", "lock_eth");
    h.loop("bob");
    h.approve("bob");
    for (const f of bundles(h)) rewriteJson(f, (j) => (j.params.h_create += 1));
    steps(h, 4);
    assert.equal(h.log.length, 0, "no helper ran");
    const v = viewOf(h, "bob");
    assert.equal(v.on, false);
    assert.equal(v.terms_changed, true);
    // approval authority: startSpend refuses an automatic start for it (the snapshot it reads has other terms)
    const e = refusedSync(() => h.runner.startSpend("send-lock", null, { auto: h.ap.token }));
    assert.deepEqual(codes(e), ["autopilot_off"]);
  } finally {
    h.cleanup();
  }
});

// ---------------------------------------------------------------------------------------------- the loop: each spend, dry run then send, with no request from a page
const FLOWS = [
  { name: "fund (Alice)", role: "alice", kind: "fund_noid", script: "fund.sh", id: "send-fund", sendFlags: [] },
  { name: "lock (Bob)", role: "bob", kind: "lock_eth", script: "lock.sh", id: "send-lock", sendFlags: [] },
  { name: "reveal (Alice)", role: "alice", kind: "reveal_eth", script: "reveal.sh", id: "send-reveal", sendFlags: [] },
  { name: "claim (Bob)", role: "bob", kind: "claim_noid", script: "claim.sh", id: "send-claim", sendFlags: ["--submit"] },
  { name: "refund the ETH (Bob)", role: "bob", kind: "refund_eth", script: "refund-eth.sh", id: "send-refund-eth", sendFlags: [] },
];
for (const fl of FLOWS) {
  test(`loop: ${fl.name}: the dry run, then the send through startSpend, each once, with nothing posted by a page`, { skip: fl.kind === "fund_noid" && F.WSL_HOST_ONLY }, () => {
    const h = make({ role: fl.role });
    try {
      // Alice's approval needs the funding on offer; the swap then moves on to the tick of the step under test
      if (fl.kind !== "fund_noid" && fl.role === "alice") h.tick("alice", "fund_noid");
      else h.tick(fl.role, fl.kind);
      h.loop(fl.role);
      h.approve(fl.role);
      if (fl.kind !== "fund_noid" && fl.role === "alice") h.tick("alice", fl.kind);
      const calls = [];
      const orig = h.runner.startSpend.bind(h.runner);
      h.runner.startSpend = (id, typed, meta) => (calls.push({ id, typed, meta }), orig(id, typed, meta));
      steps(h);
      assert.equal(h.count(fl.script, true), 1, "the dry run");
      assert.equal(real(h, fl.script), 0, "not yet sent");
      assert.equal(calls.length, 0);
      steps(h);
      assert.equal(real(h, fl.script), 1, "sent once");
      assert.equal(calls.length, 1);
      assert.equal(calls[0].id, fl.id);
      assert.equal(calls[0].typed, null, "the autopilot types nothing: the amount comes from the approval's terms");
      assert.equal(calls[0].meta.auto, h.ap.token);
      assert.deepEqual(h.log.filter((l) => !l.dry && l.script === fl.script)[0].flags, fl.sendFlags);
      steps(h, 4);
      assert.equal(real(h, fl.script), 1, "and not again");
      assert.equal(h.count(fl.script, true), 1);
      // the audit line before the send says it was automatic and which approval it stood on
      const start = h.audit.all().find((r) => r.action === fl.id && r.phase === "start");
      const file = readApproval(h, fl.role);
      assert.ok(start.detail.includes(`auto=1; approval=${file.terms_sha256.slice(0, 12)}`), start.detail);
      assert.deepEqual(needs(h, fl.role), [], "no stop");
    } finally {
      h.cleanup();
    }
  });
}

test("loop: nothing runs without an approval, for the other role, on a production run, or while an action runs", () => {
  // no approval
  const a = make();
  try {
    a.loop("bob");
    a.tick("bob", "lock_eth");
    steps(a, 4);
    assert.equal(a.log.length, 0);
  } finally {
    a.cleanup();
  }
  // an approval for Bob does not move Alice's step
  const b = make();
  try {
    b.tick("bob", "lock_eth");
    b.loop("bob");
    b.loop("alice");
    b.approve("bob");
    b.tick("alice", "reveal_eth");
    steps(b, 6);
    assert.equal(b.count("reveal.sh"), 0, "Alice has no approval");
    assert.equal(b.count("lock.sh", false), 1, "Bob's own step ran");
  } finally {
    b.cleanup();
  }
  // a production run (the profile in the terms)
  const c = make({ role: "bob" });
  try {
    c.tick("bob", "lock_eth");
    c.loop("bob");
    c.approve("bob");
    c.tick("bob", "lock_eth", { eth: { chain_id: 1 } }); // the engine's own observation says Ethereum mainnet
    steps(c, 4);
    assert.equal(c.log.length, 0);
    assert.match(viewOf(c, "bob").waiting_reason || "", /production/i);
    // and the terms of a production bundle: the approval is off (the terms changed) and nothing runs either
    for (const f of bundles(c)) rewriteJson(f, (j) => (j.params.profile = "production"));
    steps(c, 2);
    assert.equal(c.log.length, 0);
  } finally {
    c.cleanup();
  }
  // while an action runs: the send is held, the timer's steps do nothing, and the held send is not started a second time
  const d = make({ role: "bob", deferred: true });
  try {
    d.tick("bob", "lock_eth");
    d.loop("bob");
    d.approve("bob");
    steps(d, 2);
    assert.equal(real(d, "lock.sh"), 1);
    assert.ok(d.runner.busy, "the send is still running");
    steps(d, 5);
    assert.equal(real(d, "lock.sh"), 1);
    assert.equal(d.count("lock.sh", true), 1);
    d.hold.cb();
    steps(d, 4);
    assert.equal(real(d, "lock.sh"), 1);
    assert.deepEqual(needs(d, "bob"), []);
  } finally {
    d.cleanup();
  }
});

test("loop: one dry run per tick; a dry run that failed or had a red row waits for a newer tick (amendment A)", () => {
  const h = make({ role: "bob", behaviour: { lock: { valueWei: "1" } } }); // the dry run reports another amount: a red row
  try {
    h.tick("bob", "lock_eth");
    h.loop("bob");
    h.approve("bob");
    steps(h, 6);
    assert.equal(h.count("lock.sh", true), 1, "one dry run for this tick");
    assert.equal(real(h, "lock.sh"), 0, "never sent");
    assert.match(viewOf(h, "bob").waiting_reason, /red row|does not match/);
    // a newer tick: one more dry run
    h.adv(10000);
    h.tick("bob", "lock_eth");
    steps(h, 4);
    assert.equal(h.count("lock.sh", true), 2);
    assert.equal(real(h, "lock.sh"), 0);
    // a stale (not failed) dry run is replaced at once, on the same tick
    h.behaviour.lock = {};
    h.adv(10000);
    h.tick("bob", "lock_eth");
    steps(h, 2);
    assert.equal(real(h, "lock.sh"), 1, "a green dry run on the newer tick is used");
  } finally {
    h.cleanup();
  }
  // a dry run that is only old (over 90 s) is made again without waiting for a tick
  const g = make({ role: "bob" });
  try {
    g.loop("bob");
    g.tick("bob", "lock_eth");
    g.approve("bob");
    steps(g, 1);
    assert.equal(g.count("lock.sh", true), 1);
    // the engine keeps the same tick for 95 s and the loop file stays alive; the tick file is rewritten with its own clock (same step) so it stays fresh
    g.adv(95000);
    g.loop("bob");
    g.tick("bob", "lock_eth", {}, 3); // a new tick of the same step
    steps(g, 1, 0);
    assert.equal(g.count("lock.sh", true), 2, "the old dry run was made again");
    steps(g, 1);
    assert.equal(real(g, "lock.sh"), 1);
  } finally {
    g.cleanup();
  }
});

test("loop: no second send for one intent across a restart", () => {
  const h = make({ role: "bob", behaviour: { noErr: true } }); // the send leaves no `sent:` line, so the step stays on offer
  try {
    h.tick("bob", "lock_eth");
    h.loop("bob");
    h.approve("bob");
    steps(h, 2);
    assert.equal(real(h, "lock.sh"), 1);
    const h2 = h.restart();
    h2.loop("bob");
    steps(h2, 6);
    assert.equal(real(h2, "lock.sh"), 0, "the log did not forget it: the second console sent nothing");
    assert.equal(real(h, "lock.sh"), 1);
    const n = needs(h2, "bob");
    assert.equal(n.length, 1, "D: a latched step that is not the claim is for the person, never a silent wait");
    assert.equal(n[0].spend, "send-lock");
  } finally {
    h.cleanup();
  }
});

// ---------------------------------------------------------------------------------------------- the stop rules
test("stop: a send that did not end cleanly (exit 1, a timeout, no result file, a result file but no `sent:`) is needs_you and is not touched again", () => {
  for (const [name, behaviour] of Object.entries({ "exit 1": { exits: { "lock.sh": 1 } }, "ok but no result file": { noFile: true }, "exit 4": { exits: { "lock.sh": 4 } } })) {
    const h = make({ role: "bob", behaviour: { ...behaviour, noErr: true } });
    try {
      h.tick("bob", "lock_eth");
      h.loop("bob");
      h.approve("bob");
      steps(h, 3);
      assert.equal(real(h, "lock.sh"), 1, name);
      const n = needs(h, "bob");
      assert.equal(n.length, 1, name);
      assert.equal(n[0].spend, "send-lock");
      assert.match(n[0].reason, /may have been sent/);
      assert.ok(n[0].at > 0);
      // a newer tick does not change that, and the file has it
      h.adv(40000);
      h.tick("bob", "lock_eth");
      steps(h, 5);
      assert.equal(real(h, "lock.sh"), 1, name + ": not sent again");
      assert.equal(readApproval(h, "bob").needs_you[0].spend, "send-lock", "persisted in the approval file");
      assert.equal(viewOf(h, "bob").doing, "stopped: needs you");
      // only the person's click lifts it
      const r = h.ap.handle({ clear_needs_you: "send-lock", role: "bob" });
      assert.equal(r.status, 200);
      assert.deepEqual(needs(h, "bob"), []);
      assert.ok(h.audit.all().some((x) => x.action === "autopilot" && x.result === "cleared: send-lock"));
    } finally {
      h.cleanup();
    }
  }
});

test("stop: a timeout of the helper is an unknown outcome too", () => {
  const h = make({ role: "bob", behaviour: { noErr: true } });
  try {
    h.tick("bob", "lock_eth");
    h.loop("bob");
    h.approve("bob");
    steps(h, 1);
    // the real send ends by the launcher's timeout
    const orig = h.runner.exec;
    h.runner.exec = (file, args, opts, cb) => orig(file, args, opts, (err, so, se) => (args.some((a) => /lock\.sh$/.test(a)) && !args.includes("--dry-run") ? cb(Object.assign(new Error("timed out"), { killed: true, signal: "SIGTERM" }), so, se) : cb(err, so, se)));
    steps(h, 3);
    assert.equal(real(h, "lock.sh"), 1);
    assert.match(needs(h, "bob")[0].reason, /may have been sent/);
  } finally {
    h.cleanup();
  }
});

test("stop: an engine ALARM or ALERT at the step is needs_you at once, before any dry run, for the claim as for the others", () => {
  for (const [role, kind, script] of [["bob", "claim_noid", "claim.sh"], ["bob", "lock_eth", "lock.sh"]]) {
    const h = make({ role });
    try {
      h.tick(role, kind, { notes: ["ALARM: something the engine wants a person to read"] });
      h.loop(role);
      h.approve(role);
      steps(h, 1);
      const n = needs(h, role);
      assert.equal(n.length, 1, kind);
      assert.match(n[0].reason, /ALARM/);
      assert.equal(h.count(script), 0, "no dry run, no send");
      steps(h, 3);
      assert.equal(h.count(script), 0);
    } finally {
      h.cleanup();
    }
  }
  const h = make({ role: "bob" });
  try {
    h.tick("bob", "lock_eth", { notes: ["ALERT: the producer screen refuses this lock now"] });
    h.loop("bob");
    h.approve("bob");
    steps(h, 2);
    assert.equal(needs(h, "bob").length, 1);
    assert.equal(h.log.length, 0);
  } finally {
    h.cleanup();
  }
});

test("stop: a held step the engine does not offer is a wait (amendment F); one it says not to send, or a held reveal past its cutoff, is a stop; nothing runs either way", () => {
  const h = make({ role: "bob" });
  try {
    h.tick("bob", "lock_eth", { held: true, fresh: "wait" });
    h.loop("bob");
    h.approve("bob");
    // the gate's own words for it
    const sp = SPENDS["send-lock"];
    const ctx = h.runner.spendContext(sp, h.run(), h.clock.ms);
    const fr = factsReady(sp, ctx.gate);
    assert.ok(fr.reasons.some((r) => r.code === "engine_not_offering"));
    steps(h, 5);
    assert.equal(h.log.length, 0);
    assert.deepEqual(needs(h, "bob"), [], "not a stop");
    assert.equal(viewOf(h, "bob").doing, "waiting for the next step");
    // the engine says outright not to send it: a stop, reported once, and nothing runs
    h.tick("bob", "lock_eth", { held: true, mutate: (t) => (t.action.reason += " (do NOT send it)") });
    steps(h, 3);
    assert.equal(h.log.length, 0);
    assert.equal(needs(h, "bob").length, 1);
    assert.equal(needs(h, "bob")[0].spend, "send-lock");
    assert.match(needs(h, "bob")[0].reason, /not to send/);
    steps(h, 3);
    assert.equal(h.audit.all().filter((r) => r.action === "autopilot" && /needs you: send-lock/.test(r.result)).length, 1, "reported once");
  } finally {
    h.cleanup();
  }
  // a held reveal whose cutoff has passed (the engine's own words): a stop for Alice too
  const g = make({ role: "alice" });
  try {
    g.tick("alice", "fund_noid");
    g.loop("alice");
    g.approve("alice");
    g.tick("alice", "reveal_eth", { held: true, fresh: "wait", cutoffPassed: true });
    steps(g, 3);
    assert.equal(g.count("reveal.sh"), 0);
    assert.equal(needs(g, "alice").length, 1);
    assert.equal(needs(g, "alice")[0].spend, "send-reveal");
    assert.match(needs(g, "alice")[0].reason, /cutoff has passed/);
  } finally {
    g.cleanup();
  }
});

test("stop: the gate refusing the same step three times in a row is needs_you; a refusal for tick or dry freshness is not counted (amendment I: nor is a helper's clean refusal missed)", () => {
  const h = make({ role: "bob" });
  try {
    h.tick("bob", "lock_eth");
    h.loop("bob");
    h.approve("bob");
    const refuse = (codesList) => (h.runner.startSpend = () => { throw Object.assign(new Error("the gate refused this spend"), { status: 422, reasons: codesList.map((c) => ({ code: c, text: c })) }); });
    refuse(["tick_stale", "dry_stale"]);
    steps(h, 8);
    assert.deepEqual(needs(h, "bob"), [], "freshness is only waited out");
    refuse(["amount_mismatch"]);
    steps(h, 2);
    assert.equal(needs(h, "bob").length, 0, "two refusals are not enough");
    steps(h, 1);
    assert.equal(needs(h, "bob").length, 1);
    assert.match(needs(h, "bob")[0].reason, /3 times in a row/);
  } finally {
    h.cleanup();
  }
  // the helper's own clean refusals ("lock REFUSED, nothing sent") count too
  const g = make({ role: "bob", behaviour: { exits: { "lock.sh": 3 }, stdout: { "lock.sh": "lock REFUSED, nothing sent: the tick did not offer it\n" } } });
  try {
    g.tick("bob", "lock_eth");
    g.loop("bob");
    g.approve("bob");
    steps(g, 20);
    assert.equal(real(g, "lock.sh"), 3, "tried three times, each after a fresh dry run");
    assert.equal(g.count("lock.sh", true), 3);
    assert.equal(needs(g, "bob").length, 1);
    assert.match(needs(g, "bob")[0].reason, /3 times/);
    steps(g, 6);
    assert.equal(real(g, "lock.sh"), 3, "and then no more");
  } finally {
    g.cleanup();
  }
});

test("claim: a failed claim raises the alarm at once but is tried again on a later tick, and a clean one clears it", () => {
  const h = make({ role: "bob", behaviour: { exits: { "claim.sh": 1 } } });
  try {
    h.tick("bob", "claim_noid");
    h.loop("bob");
    h.approve("bob");
    steps(h, 3);
    assert.equal(real(h, "claim.sh"), 1);
    const n = needs(h, "bob");
    assert.equal(n.length, 1);
    assert.equal(n[0].spend, "send-claim");
    assert.equal(n[0].retrying, true, "the page alarm is up from the first failure");
    // the same tick: nothing (the latch); a later tick: the dry run and the send again
    steps(h, 3);
    assert.equal(real(h, "claim.sh"), 1);
    h.behaviour.exits["claim.sh"] = 0;
    h.adv(40000);
    h.tick("bob", "claim_noid");
    steps(h, 2);
    assert.equal(real(h, "claim.sh"), 2, "tried again");
    steps(h, 2);
    assert.deepEqual(needs(h, "bob"), [], "a clean send takes the alarm away");
  } finally {
    h.cleanup();
  }
  // a claim that is already pending or confirmed is only waited for
  const g = make({ role: "bob" });
  try {
    g.tick("bob", "claim_noid", { noid: { pending_calls: [{ txid: "x" }] } });
    g.loop("bob");
    g.approve("bob");
    steps(g, 4);
    assert.equal(g.log.length, 0);
    assert.deepEqual(needs(g, "bob"), []);
  } finally {
    g.cleanup();
  }
});

// ---------------------------------------------------------------------------------------------- amendments
test("A: a tick being rewritten does not starve the send: the same dry run is used when the tick is back", () => {
  const h = make({ role: "bob" });
  try {
    h.tick("bob", "lock_eth");
    h.loop("bob");
    h.approve("bob");
    steps(h, 1);
    assert.equal(h.count("lock.sh", true), 1);
    // tick.sh truncates the file for 10 to 20 s
    const tf = path.join(h.f.run, "last-tick-bob.json");
    h.adv(3000);
    fs.writeFileSync(tf, "");
    const t = new Date(h.clock.ms - 1000);
    fs.utimesSync(tf, t, t);
    h.ap.step();
    assert.equal(real(h, "lock.sh"), 0, "waiting");
    assert.match(viewOf(h, "bob").waiting_reason, /being written/);
    h.adv(12000);
    h.tick("bob", "lock_eth");
    steps(h, 1);
    assert.equal(real(h, "lock.sh"), 1, "sent with the same dry run");
    assert.equal(h.count("lock.sh", true), 1);
    assert.deepEqual(needs(h, "bob"), []);
  } finally {
    h.cleanup();
  }
});

test("B: the funding statements are used once, within 300 s, by the process that took them; fresh ones re-arm", { skip: F.WSL_HOST_ONLY }, () => {
  // single use: a clean refusal of fund.sh used them up
  const h = make({ role: "alice", behaviour: { exits: { "fund.sh": 3 }, stdout: { "fund.sh": "REFUSED: a guard failed\n" } } });
  try {
    h.tick("alice", "fund_noid");
    h.loop("alice");
    assert.equal(h.approve("alice").status, 200);
    assert.ok(viewOf(h, "alice").funding_statements_valid_until > 0);
    steps(h, 2);
    assert.equal(real(h, "fund.sh"), 1);
    assert.equal(viewOf(h, "alice").funding_statements_valid_until, null, "consumed by the first automatic start");
    steps(h, 3);
    assert.equal(real(h, "fund.sh"), 1, "no second start without new statements");
    const n = needs(h, "alice");
    assert.equal(n.length, 1);
    assert.match(n[0].reason, /funding statements/);
    // new statements: the same call as the approval, allowed because the funding is on offer again
    h.behaviour.exits = {};
    const again = h.approve("alice");
    assert.equal(again.body.rearmed, true);
    assert.deepEqual(needs(h, "alice"), [], "the fresh statements answer the stop");
    steps(h, 2);
    assert.equal(real(h, "fund.sh"), 2);
  } finally {
    h.cleanup();
  }
  // 300 s
  const w = make({ role: "alice" });
  try {
    w.tick("alice", "fund_noid");
    w.loop("alice");
    w.approve("alice");
    w.adv(301000);
    w.tick("alice", "fund_noid");
    w.loop("alice");
    steps(w, 1, 0);
    assert.equal(w.count("fund.sh"), 0, "too late: nothing was started");
    assert.match(needs(w, "alice")[0].reason, /300 s/);
  } finally {
    w.cleanup();
  }
  // a restart voids them
  const r = make({ role: "alice" });
  try {
    r.tick("alice", "fund_noid");
    r.loop("alice");
    r.approve("alice");
    const r2 = r.restart();
    r2.loop("alice");
    steps(r2, 2);
    assert.equal(r2.count("fund.sh"), 0);
    assert.equal(needs(r2, "alice").length, 1);
  } finally {
    r.cleanup();
  }
  // a needs_you on the funding voids them
  const v = make({ role: "alice" });
  try {
    v.tick("alice", "fund_noid", { notes: ["ALARM: read me"] });
    v.loop("alice");
    v.approve("alice");
    steps(v, 1);
    assert.equal(needs(v, "alice").length, 1);
    assert.equal(viewOf(v, "alice").funding_statements_valid_until, null);
  } finally {
    v.cleanup();
  }
});

test("C: a clean success is exit 0 AND a result file AND no warning; the funding also needs `Funding submitted` in the marker", { skip: F.WSL_HOST_ONLY }, () => {
  const fundNoTx = make({ role: "alice", behaviour: { markerWithoutTx: true } });
  try {
    fundNoTx.tick("alice", "fund_noid");
    fundNoTx.loop("alice");
    fundNoTx.approve("alice");
    steps(fundNoTx, 3);
    assert.equal(real(fundNoTx, "fund.sh"), 1);
    assert.equal(needs(fundNoTx, "alice").length, 1);
    assert.equal(needs(fundNoTx, "alice")[0].spend, "send-fund");
  } finally {
    fundNoTx.cleanup();
  }
  const good = make({ role: "alice" });
  try {
    good.tick("alice", "fund_noid");
    good.loop("alice");
    good.approve("alice");
    steps(good, 3);
    assert.deepEqual(needs(good, "alice"), []);
  } finally {
    good.cleanup();
  }
  // the reveal: exit 3 (mined and reverted) says the secret is public
  const rev = make({ role: "alice", behaviour: { exits: { "reveal.sh": 3 } } });
  try {
    rev.tick("alice", "fund_noid");
    rev.loop("alice");
    rev.approve("alice");
    rev.tick("alice", "reveal_eth");
    steps(rev, 3);
    // exit 3 of reveal.sh is the helper's "mined and reverted": not a refusal, a warning
    assert.equal(real(rev, "reveal.sh"), 1);
    assert.equal(needs(rev, "alice").length, 1);
    assert.match(needs(rev, "alice")[0].reason, /SECRET|secret|may have been sent/);
  } finally {
    rev.cleanup();
  }
});

test("D: after a restart needs_you is rebuilt from the audit log: a start with no end, or an end that is neither ok nor `refused, nothing sent`; a `cleared` note forgets it", () => {
  const h = make({ role: "bob" });
  try {
    h.tick("bob", "lock_eth");
    h.approve("bob");
    // a start line with no end line (the console stopped while it ran)
    h.audit.append({ action: "send-lock", role: "bob", phase: "start", result: "started" });
    assert.deepEqual(needs(h, "bob"), [], "nothing before a restart: the running console knows its own job");
    const h2 = h.restart();
    let n = needs(h2, "bob");
    assert.equal(n.length, 1);
    assert.equal(n[0].spend, "send-lock");
    assert.match(n[0].reason, /never ended/);
    // cleared by the person: it stays cleared across the next restart
    h2.ap.handle({ clear_needs_you: "send-lock", role: "bob" });
    let cur = h2.restart();
    assert.deepEqual(needs(cur, "bob"), []);
    // an end line that is not ok
    cur.audit.append({ action: "send-lock", role: "bob", phase: "start", result: "started" });
    cur.audit.append({ action: "send-lock", role: "bob", phase: "end", result: "failed (exit 1, the transaction may have been sent)" });
    cur = cur.restart();
    n = needs(cur, "bob");
    assert.equal(n.length, 1);
    // an ok end and a clean refusal are not stops
    cur.ap.handle({ clear_needs_you: "send-lock", role: "bob" });
    cur.audit.append({ action: "send-lock", role: "bob", phase: "start", result: "started" });
    cur.audit.append({ action: "send-lock", role: "bob", phase: "end", result: "ok (exit 0)" });
    cur = cur.restart();
    assert.deepEqual(needs(cur, "bob"), []);
    cur.audit.append({ action: "send-lock", role: "bob", phase: "start", result: "started" });
    cur.audit.append({ action: "send-lock", role: "bob", phase: "end", result: "refused, nothing sent (lock.sh exit 3)" });
    cur = cur.restart();
    assert.deepEqual(needs(cur, "bob"), []);
    // a step of the other role is not Bob's
    cur.audit.append({ action: "send-reveal", role: "alice", phase: "start", result: "started" });
    assert.deepEqual(needs(cur.restart(), "bob"), []);
  } finally {
    h.cleanup();
  }
  // a new approval after an "off" also starts from what the log shows
  const g = make({ role: "bob" });
  try {
    g.tick("bob", "lock_eth");
    g.audit.append({ action: "send-lock", role: "bob", phase: "start", result: "started" });
    g.audit.append({ action: "send-lock", role: "bob", phase: "end", result: "timeout, the transaction may have been sent" });
    g.approve("bob");
    assert.equal(needs(g, "bob").length, 1, "an old unclear send stays in the way until the person clears it");
  } finally {
    g.cleanup();
  }
});

test("E: a re-send (--replace) becoming relevant is for the person: needs_you, never started; reported once", () => {
  const h = make({ role: "alice" });
  try {
    h.tick("alice", "fund_noid");
    h.loop("alice");
    h.approve("alice");
    h.tick("alice", "reveal_eth", { held: true, eth: { pending_preimage: { tx_hash: TX } } });
    steps(h, 4);
    const n = needs(h, "alice");
    assert.equal(n.length, 1);
    assert.equal(n[0].spend, "send-reveal-replace");
    assert.match(n[0].reason, /stuck/);
    assert.equal(h.count("reveal.sh"), 0, "no dry run and no send of a re-send");
    assert.equal(h.audit.all().filter((r) => r.action === "autopilot" && /needs you: send-reveal-replace/.test(r.result)).length, 1, "reported once");
    // and the gate refuses an automatic re-send outright
    const e = refusedSync(() => h.runner.startSpend("send-reveal-replace", null, { auto: h.ap.token }));
    assert.deepEqual(codes(e), ["autopilot_off"]);
  } finally {
    h.cleanup();
  }
});

test("G: startSpend takes meta.auto only as the autopilot's own object, for the role of the approval, on the snapshot it read", () => {
  const h = make({ role: "both" });
  try {
    h.tick("bob", "lock_eth");
    h.tick("alice", "fund_noid");
    h.loop("bob");
    h.loop("alice");
    h.approve("bob");
    // a forged object, `true`, a string: refused as autopilot_off; nothing runs
    for (const forged of [{ approval: "abc" }, true, "yes", { autopilot: true }, 1]) {
      const e = refusedSync(() => h.runner.startSpend("send-lock", "0.001 ETH", { auto: forged }));
      assert.deepEqual(codes(e), ["autopilot_off"], JSON.stringify(forged));
    }
    // the real token but for the other role's step (Alice has no approval)
    const e2 = refusedSync(() => h.runner.startSpend("send-fund", null, { auto: h.ap.token }));
    assert.deepEqual(codes(e2), ["autopilot_off"]);
    assert.equal(h.log.length, 0);
    // approval.role === spend.role, on the snapshot: terms of another snapshot do not pass
    const run = h.run();
    const other = { ...run, terms: { ...run.terms, hashlock: "0x" + "ee".repeat(32) } };
    assert.equal(h.ap.authorize(h.ap.token, SPENDS["send-lock"], other, h.clock.ms), null);
    assert.ok(h.ap.authorize(h.ap.token, SPENDS["send-lock"], run, h.clock.ms));
    assert.equal(h.ap.authorize({ autopilot: true }, SPENDS["send-lock"], run, h.clock.ms), null, "an equal-looking object is not the token");
    assert.equal(h.ap.authorize(h.ap.token, SPENDS["send-fund"], run, h.clock.ms), null);
    const refused = h.audit.all().filter((r) => r.phase === "refused" && /autopilot_off/.test(r.result));
    assert.ok(refused.length >= 6, "each refusal is in the audit log");
  } finally {
    h.cleanup();
  }
});

test("H: a real `sent:` line is found however many dry-run error files came after it", () => {
  const h = make({ role: "bob" });
  try {
    const t0 = Date.now() - 600000;
    const put = (name, text, at) => {
      const p = path.join(h.f.run, name);
      fs.writeFileSync(p, text);
      fs.utimesSync(p, new Date(at), new Date(at));
    };
    put("eth-lock-1.err", `sent: ${TX} nonce 1\n`, t0);
    for (let i = 2; i <= 14; i++) put(`eth-lock-${i}.err`, "dry run, nothing sent\n", t0 + i * 1000);
    assert.equal(h.runner.sentHashFor(SPENDS["send-lock"], h.run()), TX);
    // the same for the reveal's and the refund's files
    put("eth-refund-1.err", `sent: ${TX} nonce 3\n`, t0);
    for (let i = 2; i <= 12; i++) put(`eth-refund-${i}.err`, "dry\n", t0 + i * 1000);
    assert.equal(h.runner.sentHashFor(SPENDS["send-refund-eth"], h.run()), TX);
    // and nothing is invented
    assert.equal(h.runner.sentHashFor(SPENDS["send-reveal"], h.run()), null);
  } finally {
    h.cleanup();
  }
});

test("K: the watch loop is started only when no loop file was updated for 180 s and this console knows of no loop it started that is still alive", () => {
  // no loop file at all: started, once
  const h = make({ role: "bob" });
  try {
    h.tick("bob", "lock_eth");
    h.approve("bob");
    steps(h, 1);
    assert.equal(h.spawned.length, 1, "started");
    assert.match(viewOf(h, "bob").doing, /watch loop/);
    steps(h, 4);
    assert.equal(h.spawned.length, 1, "not a second one: this console knows the one it started is alive");
  } finally {
    h.cleanup();
  }
  // a fresh loop file (from a terminal): nothing started
  const g = make({ role: "bob" });
  try {
    g.tick("bob", "lock_eth");
    g.loop("bob", 100);
    g.approve("bob");
    steps(g, 3);
    assert.equal(g.spawned.length, 0);
  } finally {
    g.cleanup();
  }
  // a loop file 200 s old and no loop of ours: started
  const s = make({ role: "bob" });
  try {
    s.tick("bob", "lock_eth");
    s.loop("bob", 200);
    s.approve("bob");
    steps(s, 1, 0);
    assert.equal(s.spawned.length, 1);
  } finally {
    s.cleanup();
  }
  // a stale loop file but a loop this console started that is alive: left alone
  const k = make({ role: "bob" });
  try {
    k.tick("bob", "lock_eth");
    k.loop("bob", 200);
    k.runner.watch.alive = true;
    k.approve("bob");
    steps(k, 3, 0);
    assert.equal(k.spawned.length, 0);
    // once it is known dead, a new one starts
    k.runner.watch.alive = false;
    steps(k, 1, 0);
    assert.equal(k.spawned.length, 1);
  } finally {
    k.cleanup();
  }
});
