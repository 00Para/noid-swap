"use strict";
// R5, the late-claim watch (Bob, program mode; reads only): the first tip of a fresh `secret_seen` tick is recorded once; the alarm rises at K blocks and not at K - 1, with no approval; it clears at
// `claim_included`; it is rebuilt from the audit log after a restart; a stale tick does not count; it counts as "needs you" and fires one `alarm` notification on its rising edge.
const test = require("node:test");
const assert = require("node:assert/strict");
const { makeEnv } = require("./program-harness");
const { SwapSet } = require("../lib/swapset");
const { lateK } = require("../lib/launchfacts");

const mk = (env, extra) => new SwapSet({ program: env.program, deps: env.deps(extra) });
const tickOf = (phase, tip) => ({ phase_after: phase, noid: { tip }, eth: {}, notes: [] });
/** A Bob swap on Sepolia (K = 5) with his swap file. */
function bobSwap(env) {
  const sw = env.addSwap({ role: "bob" });
  env.swapFile(sw, "bob");
  return sw;
}
const audit = (swap) => swap.audit.all().filter((r) => r.action === "autopilot" && /^claim watch/.test(r.result || ""));
const step = (swap) => {
  swap.snapshot = null;
  swap.autopilot.step();
};

test("K comes from the profile: 5 blocks on Sepolia, 10 in production", () => {
  assert.equal(lateK("sepolia"), 5);
  assert.equal(lateK("production"), 10);
});

test("the first tip is recorded once; the alarm rises at K blocks and not at K - 1, with no approval; the view and the needs-you count carry it", async () => {
  const env = makeEnv();
  try {
    const sw = bobSwap(env);
    const set = mk(env);
    set.scan();
    const swap = set.get(sw.id);
    const ap = swap.autopilot;
    env.writeTick(sw, "bob", tickOf("secret_seen", 1000));
    step(swap);
    assert.equal(ap.lateClaim(), null);
    assert.deepEqual(audit(swap).map((r) => r.result), ["claim watch: secret seen at 1000"]);
    env.writeTick(sw, "bob", tickOf("secret_seen", 1004)); // K - 1
    step(swap);
    assert.equal(ap.lateClaim(), null, "K - 1 blocks is not late");
    assert.equal(audit(swap).length, 1, "the first tip is recorded once");
    env.writeTick(sw, "bob", tickOf("secret_seen", 1005)); // K
    step(swap);
    assert.deepEqual(ap.lateClaim(), { phase: "secret_seen", blocks: 5, first_tip: 1000 });
    assert.equal(ap.view(null).bob.late_claim.blocks, 5);
    assert.equal(set.facts(swap).needs_you, true);
    assert.equal(set.facts(swap).late_claim, true);
    assert.equal(set.summary(swap).needs_you, true);
    // the claim was sent but is not in a block
    env.writeTick(sw, "bob", tickOf("claim_submitted", 1008));
    step(swap);
    assert.deepEqual(ap.lateClaim(), { phase: "claim_submitted", blocks: 8, first_tip: 1000 });
    // it clears at claim_included, once, with one audit note
    env.writeTick(sw, "bob", tickOf("claim_included", 1009));
    step(swap);
    step(swap);
    assert.equal(ap.lateClaim(), null);
    assert.equal(set.facts(swap).needs_you, false);
    assert.deepEqual(audit(swap).map((r) => r.result), ["claim watch: secret seen at 1000", "claim watch: cleared"]);
    await set.stopAll();
  } finally {
    await env.cleanup();
  }
});

test("after a restart the first tip is rebuilt from the audit log; a cleared watch is not rebuilt", async () => {
  const env = makeEnv();
  try {
    const sw = bobSwap(env);
    let set = mk(env);
    set.scan();
    let swap = set.get(sw.id);
    env.writeTick(sw, "bob", tickOf("secret_seen", 500));
    step(swap);
    await set.stopAll();
    // a new program process over the same folder: the memory is empty
    set = mk(env);
    set.scan();
    swap = set.get(sw.id);
    assert.equal(swap.autopilot.claimWatch.first_tip, null);
    env.writeTick(sw, "bob", tickOf("secret_seen", 507));
    step(swap);
    assert.deepEqual(swap.autopilot.lateClaim(), { phase: "secret_seen", blocks: 7, first_tip: 500 }, "counted from the recorded tip, not from this tick");
    assert.equal(audit(swap).filter((r) => /secret seen/.test(r.result)).length, 1, "no second record");
    env.writeTick(sw, "bob", tickOf("done", 520));
    step(swap);
    await set.stopAll();
    set = mk(env);
    set.scan();
    swap = set.get(sw.id);
    env.writeTick(sw, "bob", tickOf("secret_seen", 900)); // a reorg back to secret_seen after the clear starts a new count
    step(swap);
    assert.equal(swap.autopilot.claimWatch.first_tip, 900);
    await set.stopAll();
  } finally {
    await env.cleanup();
  }
});

test("a stale tick does not count: no first tip is recorded from it, and an alarm already raised stays", async () => {
  const env = makeEnv();
  try {
    const sw = bobSwap(env);
    const set = mk(env);
    set.scan();
    const swap = set.get(sw.id);
    env.writeTick(sw, "bob", tickOf("secret_seen", 1000), 400); // 400 s old
    step(swap);
    assert.equal(swap.autopilot.claimWatch.first_tip, null);
    assert.equal(audit(swap).length, 0);
    env.writeTick(sw, "bob", tickOf("secret_seen", 1000));
    step(swap);
    env.writeTick(sw, "bob", tickOf("secret_seen", 1006));
    step(swap);
    assert.ok(swap.autopilot.lateClaim());
    env.writeTick(sw, "bob", tickOf("secret_seen", 1020), 400); // a stale reading neither raises more nor clears
    step(swap);
    assert.equal(swap.autopilot.lateClaim().blocks, 6);
    await set.stopAll();
  } finally {
    await env.cleanup();
  }
});

test("Alice's swaps never raise it", async () => {
  const env = makeEnv();
  try {
    const a = env.addSwap({ role: "alice" });
    env.swapFile(a, "alice");
    const set = mk(env);
    set.scan();
    const swap = set.get(a.id);
    env.writeTick(a, "alice", tickOf("secret_seen", 1000));
    step(swap);
    assert.equal(swap.autopilot.lateClaim(), null);
    assert.equal(swap.autopilot.view(null).alice.late_claim, undefined);
    await set.stopAll();
  } finally {
    await env.cleanup();
  }
});

test("one `alarm` notification on the rising edge, not on every read", async () => {
  const env = makeEnv();
  try {
    const sw = bobSwap(env);
    const set = mk(env);
    set.scan();
    const swap = set.get(sw.id);
    set.seedKinds(swap);
    env.writeTick(sw, "bob", tickOf("secret_seen", 1000));
    step(swap);
    set.notifyChanges();
    assert.deepEqual(env.notes, []);
    env.writeTick(sw, "bob", tickOf("secret_seen", 1006));
    step(swap);
    set.notifyChanges();
    set.notifyChanges();
    set.notifyChanges();
    assert.deepEqual(env.notes, [{ kind: "alarm", swapId: sw.id }], "one alarm, and no needs_you for the same event");
    env.writeTick(sw, "bob", tickOf("claim_included", 1010));
    step(swap);
    set.notifyChanges();
    assert.equal(env.notes.length, 1);
    await set.stopAll();
  } finally {
    await env.cleanup();
  }
});

test("proof for section 10: the watcher calls no step and no spend (stubs that throw on any call)", async () => {
  const env = makeEnv();
  try {
    const sw = bobSwap(env);
    const set = mk(env);
    set.scan();
    const swap = set.get(sw.id);
    const boom = () => {
      throw new Error("the watcher must not call this");
    };
    for (const k of Object.keys(env.steps)) if (typeof env.steps[k] === "function") env.steps[k] = boom;
    for (const m of ["startSpend", "startAction", "start", "run"]) if (typeof swap.runner[m] === "function") swap.runner[m] = boom;
    swap.executor.run = boom;
    const look = () => swap.autopilot.watchLateClaim(swap.runner.readRunFn(swap.runner.cfg.runDirs, Math.floor(Date.now() / 1000)), Date.now());
    env.writeTick(sw, "bob", tickOf("secret_seen", 1000));
    look();
    env.writeTick(sw, "bob", tickOf("secret_seen", 1010));
    look();
    assert.equal(swap.autopilot.lateClaim().blocks, 10);
    await set.stopAll();
  } finally {
    await env.cleanup();
  }
});

test("terminal console: the watcher is off (program mode only)", () => {
  const { Autopilot } = require("../lib/autopilot");
  const a = new Autopilot({ cfg: { role: "bob", runDirs: [] }, programMode: false, audit: { all: () => [], append() {} }, now: () => Date.now(), runFolder: () => "/x" });
  a.watchLateClaim({ roles: { bob: { tick: tickOf("secret_seen", 1) } } }, Date.now());
  assert.equal(a.lateClaim(), null);
});
