"use strict";
// "Reading without recording": Bob's read loop (rule W's "read" mode) runs `swap-cli tick --apply --observe-only` (Alice's keeps the plain read-only tick), so the facts the chains show (Bob's funded and funding_final from the
// first sighting of Alice's funding) are written to the swap file before the person has approved and deposited, and nothing that needs an approval is: no intent, no abort, no spend parameters.
// Where swap-cli refuses it (the file holds an intent) the round reads with the plain read-only tick, never with a full --apply. The model of swap-cli below (`model`) stands in for the tool:
// its behaviour is the one tested in swap-cli/tests/observe_only.rs.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { makeEnv, until, loopKit } = require("./program-harness");
const { createStepExecutor } = require("../lib/stepexec");
const { createRunJsonSource } = require("../lib/settingsource");
const { AuditLog } = require("../lib/audit");
const { createWatch } = require("../lib/steps/watch");
const { tick } = require("../lib/steps/tick");
const { watchWanted, BOB_NOT_ACTED } = require("../lib/firststeps");
const { evaluateSpend } = require("../lib/gate");
const { makeHarness } = require("./steps-fixtures/harness");

const tickOf = (o = {}) => ({ now: 1, phase_after: "created", events_applied_to_file: false, intent: { status: "none", intent: null }, action: { action: "wait", reason: "x" }, notes: [], ...o });
// what swap-cli prints for an observe-only tick (swap-cli/src/main.rs): events applied, no intent, the spend withheld
const observeTick = (o = {}) =>
  tickOf({ events_applied_to_file: true, observe_only: true, action: { kind: "lock_eth", parameters: "withheld", note: "an observe-only tick records no intent; run a full tick --apply to record this intent and print its parameters" }, ...o });

// ---------------------------------------------------------------------------------------------------------------- the argv

test("the tick step: observeOnly runs `--apply --observe-only` and nothing else; the plain read-only tick and the apply tick are as before", async () => {
  const h = makeHarness({});
  try {
    h.swapFile("alice");
    h.scenario({ swapCli: { tick: { stdout: JSON.stringify({ events_applied_to_file: true, observe_only: true, phase_after: "created" }), touch: true } } });
    const r = await tick(h.ctx, "alice", { observeOnly: true });
    assert.equal(r.code, 0);
    const argv = h.calls("swapCli")[0].argv;
    assert.deepEqual(argv.slice(-2), ["--apply", "--observe-only"]);
    assert.equal(argv.filter((a) => a === "--apply").length, 1);
    assert.ok(argv.includes("--record-noid") && argv.includes("--record-eth"));
    // another flag with it is refused before anything runs
    const n = h.calls("swapCli").length;
    const bad = await tick(h.ctx, "alice", { observeOnly: true, args: ["--apply"] });
    assert.equal(bad.code, 2);
    assert.equal(h.calls("swapCli").length, n);
    await tick(h.ctx, "alice", {});
    await tick(h.ctx, "alice", { args: ["--apply"] });
    const [plain, applied] = h.calls("swapCli").slice(n);
    assert.ok(!plain.argv.includes("--apply") && !plain.argv.includes("--observe-only"), "the plain read-only tick");
    assert.equal(applied.argv.at(-1), "--apply");
    assert.ok(!applied.argv.includes("--observe-only"));
  } finally {
    h.cleanup();
  }
});

test("the watch loop in read mode asks for an observe-only tick, in apply mode for --apply", async () => {
  const dir = fs.mkdtempSync(path.join(require("os").tmpdir(), "no1d-obs-"));
  try {
    const ctx = { runDir: dir, settings: { role: "bob" }, now: Date.now };
    const ask = async (opts) => {
      const seen = [];
      const tickFn = async (c, r, o) => {
        seen.push(o);
        return { code: 0, stdout: "applied: True phase_after: aborted\n", stderr: "", files: [] };
      };
      await createWatch(ctx, { tick: tickFn, sleep: async () => {}, roles: ["bob"], ...opts }).start();
      return seen[0];
    };
    assert.deepEqual(await ask({ apply: false }), { args: [], observeOnly: true, ackFlags: [] });
    assert.deepEqual(await ask({}), { args: ["--apply"], ackFlags: [] });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("Alice's read mode keeps the plain read-only tick: an observe tick could adopt a deposit someone else made at her contract root and turn rule W to apply", async () => {
  const dir = fs.mkdtempSync(path.join(require("os").tmpdir(), "no1d-obs-"));
  try {
    const ctx = { runDir: dir, settings: { role: "alice" }, now: Date.now };
    const ask = async (opts) => {
      const seen = [];
      const tickFn = async (c, r, o) => {
        seen.push(o);
        return { code: 0, stdout: "applied: False phase_after: aborted\n", stderr: "", files: [] };
      };
      await createWatch(ctx, { tick: tickFn, sleep: async () => {}, roles: ["alice"], ...opts }).start();
      return seen[0];
    };
    assert.deepEqual(await ask({ apply: false }), { args: [] });
    assert.deepEqual(await ask({}), { args: ["--apply"] });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("the summary line of an observe-only tick says observe-only, not applied: True", () => {
  const { summaryLines } = require("../lib/steps/tick");
  const line = (v) => summaryLines(JSON.stringify(v)).at(-1);
  assert.equal(line({ observe_only: true, events_applied_to_file: true, phase_after: "funded" }), "applied: observe-only phase_after: funded");
  assert.equal(line({ observe_only: false, events_applied_to_file: true, phase_after: "funded" }), "applied: True phase_after: funded");
  assert.equal(line({ events_applied_to_file: false, phase_after: "created" }), "applied: False phase_after: created");
});

// ---------------------------------------------------------------------------------------------------------------- the refusal fallback

test("a refused observe-only tick falls back to the plain read-only tick, never to --apply; one note per refusal streak", async () => {
  const dir = fs.mkdtempSync(path.join(require("os").tmpdir(), "no1d-obs-"));
  try {
    const calls = [];
    const notes = [];
    let round = 0;
    const refusal = { code: 1, stdout: "[bob] tick exit 1 at 12:00:00\nerror: observe-only is refused: the file holds an intent (lock_eth since 5 unix); run a full `tick --apply`, which holds it or resolves it\n", stderr: "", files: [] };
    const ok = (phase) => ({ code: 0, stdout: `[bob] tick exit 0 at 12:00:00\napplied: ${phase}\n`, stderr: "", files: [] });
    const tickFn = async (ctx, role, o) => {
      calls.push(o);
      if (o.observeOnly) {
        round++;
        // rounds 1 and 2 and 3 are refused; round 4 is accepted; round 5 is refused again; round 6 ends the loop
        if ([1, 2, 3, 5].includes(round)) return refusal;
        return round === 6 ? { code: 0, stdout: "applied: True phase_after: aborted\n", stderr: "", files: [] } : ok("True phase_after: funded");
      }
      return ok("False phase_after: funded");
    };
    const ctx = { runDir: dir, settings: { role: "bob" }, now: Date.now };
    const w = createWatch(ctx, { tick: tickFn, sleep: async () => {}, apply: false, roles: ["bob"], onNote: (t) => notes.push(t) });
    const end = await w.start();
    assert.equal(end.reason, "terminal");
    assert.ok(calls.every((o) => !(o.args && o.args.includes("--apply"))), "no full --apply is ever asked for");
    assert.deepEqual(calls.map((o) => (o.observeOnly ? "observe" : "read")), ["observe", "read", "observe", "read", "observe", "read", "observe", "observe", "read", "observe"]);
    assert.equal(notes.length, 2, "one note for the first streak (rounds 1 to 3) and one for the second (round 5)");
    assert.match(notes[0], /observe-only was refused/);
    const lines = fs.readFileSync(path.join(dir, "loop-bob.txt"), "utf8").split("\n").filter(Boolean);
    assert.equal(lines.length, 6, "one loop line per round");
    assert.ok(lines.every((l) => !l.includes("observe-only is refused")), "the loop line is the tick that was kept");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("only swap-cli's own refusal falls back: another failure of the observe tick is kept as it is", async () => {
  const dir = fs.mkdtempSync(path.join(require("os").tmpdir(), "no1d-obs-"));
  try {
    const calls = [];
    const tickFn = async (ctx, role, o) => {
      calls.push(o);
      return { code: 1, stdout: "error: parano1d watcher: connection refused\napplied: None phase_after: None\n", stderr: "", files: [] };
    };
    const ctx = { runDir: dir, settings: { role: "bob" }, now: Date.now };
    const w = createWatch(ctx, { tick: tickFn, sleep: async () => {}, apply: false, roles: ["bob"], onNote: () => assert.fail("no note") });
    await w.tickOnce("bob");
    assert.equal(calls.length, 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("the executor audits a refusal streak once (action watch, phase note)", async () => {
  const env = makeEnv();
  try {
    let n = 0;
    const kit = loopKit(env, async (ctx, role, args, i, opts) => {
      n++;
      if (opts && opts.observeOnly) return { code: 1, stdout: "error: observe-only is refused: x\n", stderr: "", files: [] };
      return { code: 0, stdout: "applied: False phase_after: received\n", stderr: "", files: [] };
    });
    const sw = env.addSwap({ role: "bob" });
    const audit = new AuditLog(sw.pub, { role: "bob" });
    const executor = createStepExecutor({ program: env.program, swap: { id: sw.id, dir: sw.dir, settingsSource: createRunJsonSource({ dir: sw.dir }), audit }, steps: kit.steps, watchOpts: { ...kit.watchOpts } });
    executor.watchStart({ mode: "read" });
    await until(() => kit.calls.length >= 2, "a first round");
    await kit.next();
    await kit.next();
    await executor.watchStop();
    const noted = audit.all().filter((r) => r.action === "watch" && /observe-only was refused/.test(r.result || ""));
    assert.equal(noted.length, 1, JSON.stringify(audit.all().map((r) => r.result)));
    assert.ok(n >= 3 && kit.calls.every((c) => !c.args.includes("--apply")));
  } finally {
    await env.cleanup();
  }
});

// ---------------------------------------------------------------------------------------------------------------- rule W reads an observe tick as it read a read-only tick

test("rule W: an observe-only tick that moves Bob to funded or funding_final never turns the watch to apply before his approval and deposit; the role has not acted", () => {
  for (const phase of ["received", "funded", "funding_final"]) {
    assert.ok(BOB_NOT_ACTED.has(phase));
    const t = observeTick({ phase_after: phase });
    assert.equal(watchWanted({ role: "bob", tick: t, approvalInForce: false, depositReasons: ["deposit_short"], sticky: false, abortSeen: 0 }), "read", phase);
    assert.equal(watchWanted({ role: "bob", tick: t, approvalInForce: true, depositReasons: ["deposit_short"], sticky: false, abortSeen: 0 }), "read", `${phase}: approved, deposit short`);
    assert.equal(watchWanted({ role: "bob", tick: t, approvalInForce: false, depositReasons: [], sticky: false, abortSeen: 0 }), "read", `${phase}: deposit seen, no approval`);
    // and it is the approval with the deposit that switches it, not the tick
    assert.equal(watchWanted({ role: "bob", tick: t, approvalInForce: true, depositReasons: [], sticky: false, abortSeen: 0 }), "apply", `${phase}: approval and deposit`);
  }
  // events_applied_to_file true is not a reason: nothing in the rule reads it
  assert.equal(watchWanted({ role: "bob", tick: observeTick({ phase_after: "funding_final", events: [{ event: "noid_funding_final" }] }), approvalInForce: false, depositReasons: ["x"], sticky: false, abortSeen: 0 }), "read");
  // Bob's own act (his lock seen or later) is a phase past the set: apply, as it was with the read-only tick (the phase_after of a read tick was the same in-memory phase)
  assert.equal(watchWanted({ role: "bob", tick: observeTick({ phase_after: "lock_submitted" }), approvalInForce: false, depositReasons: ["x"], sticky: false, abortSeen: 0 }), "apply");
});

test("rule W: Alice at `created` with no intent is read; a phase past `created` is read as her act (which is why her read loop never runs an observe tick)", () => {
  const t = observeTick({ phase_after: "created", action: { kind: "fund_noid", parameters: "withheld", note: "n" } });
  assert.equal(watchWanted({ role: "alice", tick: t, approvalInForce: false, depositReasons: ["deposit_short"], sticky: false, abortSeen: 0 }), "read");
  assert.equal(watchWanted({ role: "alice", tick: t, approvalInForce: true, depositReasons: ["deposit_short"], sticky: false, abortSeen: 0 }), "read");
  // the engine moves her past `created` only for a funding it sees (an instance at her contract root): the rule reads that as the role having acted, as before
  assert.equal(watchWanted({ role: "alice", tick: observeTick({ phase_after: "funded" }), approvalInForce: false, depositReasons: ["x"], sticky: false, abortSeen: 0 }), "apply");
});

// ---------------------------------------------------------------------------------------------------------------- the gate

test("an observe-only tick opens no send: the gate refuses a claim_noid, a sweep and a ledger spend on it, with the stated reason", () => {
  const now = 1_800_000_000;
  const mk = (kind, role, t) => ({ spend: { role, kind }, run: { terms: { amount_micronoid: 1 }, roles: { [role]: { tick: { now, phase_after: "secret_seen", notes: [], ...t }, tick_mtime: now - 2 } } }, nowMs: now * 1000 });
  const reasons = (kind, role, t) => {
    const c = mk(kind, role, t);
    return evaluateSpend(c.spend, c).reasons;
  };
  const cases = [
    ["claim_noid", "bob", { action: { action: "claim_noid" }, intent: { status: "none" } }],
    ["sweep_noid", "alice", { phase_after: "done", action: { action: "wait", reason: "done" }, intent: { status: "none" } }],
    ["sweep_eth", "bob", { phase_after: "done", action: { action: "wait", reason: "done" }, intent: { status: "none" } }],
    ["lock_eth", "bob", { phase_after: "funding_final", action: { action: "lock_eth" }, intent: { status: "recorded", intent: { action: "lock_eth" } } }],
    ["fund_noid", "alice", { phase_after: "created", action: { action: "fund_noid" }, intent: { status: "recorded", intent: { action: "fund_noid" } } }],
    ["reveal_eth", "alice", { phase_after: "lock_final", action: { action: "reveal_eth" }, intent: { status: "held", intent: { action: "reveal_eth" } } }],
  ];
  for (const [kind, role, t] of cases) {
    const full = reasons(kind, role, { events_applied_to_file: true, ...t }).map((r) => r.code);
    assert.ok(!full.includes("tick_observe_only") && !full.includes("tick_not_applied"), `${kind}: a full tick is not refused for being observe-only: ${full}`);
    const obs = reasons(kind, role, { events_applied_to_file: true, observe_only: true, ...t });
    const hit = obs.find((r) => r.code === "tick_observe_only");
    assert.ok(hit, kind);
    assert.equal(hit.text, "An observe-only tick cannot open a send: the loop must run a full tick first.");
    assert.ok(!reasons(kind, role, { events_applied_to_file: true, observe_only: false, ...t }).some((r) => r.code === "tick_observe_only"), kind);
  }
});

// ---------------------------------------------------------------------------------------------------------------- end to end, with a model of swap-cli

/** The behaviour of swap-cli's tick for Bob that the test needs (swap-cli/tests/observe_only.rs tests the tool itself). */
function bobModel() {
  const m = { phase: "received", seenAt: null, tip: 1000, intent: null, calls: [] };
  m.tick = (mode) => {
    m.calls.push(mode);
    if (mode === "observe" && m.intent) return { code: 1, stdout: "error: observe-only is refused: the file holds an intent (lock_eth)\n" };
    const events = [];
    if (m.phase === "received") {
      m.phase = "funded";
      m.seenAt = m.tip;
      events.push({ event: "noid_instance_seen" });
    }
    if (m.phase === "funded" && m.tip >= m.seenAt + 18) {
      m.phase = "funding_final";
      events.push({ event: "noid_funding_final" });
    }
    let action = { action: "wait", reason: "waiting for funding finality" };
    if (m.phase === "funding_final") {
      if (mode === "apply") {
        m.intent = { action: "lock_eth" };
        action = { action: "lock_eth", t_reveal: 9 };
      } else action = { kind: "lock_eth", parameters: "withheld" };
    }
    const json = { now: 1, events, action, intent: m.intent ? { status: "recorded", intent: m.intent } : { status: "none", intent: null }, events_applied_to_file: mode !== "read", observe_only: mode === "observe", phase_after: m.phase, notes: [] };
    return { code: 0, stdout: `applied: ${json.events_applied_to_file ? "True" : "False"} phase_after: ${m.phase}\n`, json };
  };
  return m;
}

test("end to end: read-mode observe ticks take Bob to funding_final before his approval; the first apply tick after approval and deposit offers lock_eth with no new wait", async () => {
  const env = makeEnv();
  try {
    const model = bobModel();
    const kit = loopKit(env, async (ctx, role, args, i, opts) => {
      const mode = opts && opts.observeOnly ? "observe" : args && args.includes("--apply") ? "apply" : "read";
      const r = model.tick(mode);
      if (r.json) fs.writeFileSync(path.join(ctx.runDir, `last-tick-${role}.json`), JSON.stringify(r.json));
      return { code: r.code, stdout: r.stdout, stderr: "", files: [] };
    });
    const sw = env.addSwap({ role: "bob" });
    const audit = new AuditLog(sw.pub, { role: "bob" });
    const executor = createStepExecutor({ program: env.program, swap: { id: sw.id, dir: sw.dir, settingsSource: createRunJsonSource({ dir: sw.dir }), audit }, steps: kit.steps, watchOpts: kit.watchOpts });
    executor.watchStart({ mode: "read" });
    await until(() => kit.calls.length >= 1, "the first observe tick");
    assert.equal(model.phase, "funded", "recorded from the first sighting, with no approval and no deposit");
    assert.equal(model.intent, null);
    model.tip += 18; // 18 blocks pass while Bob's deposit is short
    await kit.next();
    assert.equal(model.phase, "funding_final", "final in the file before the approval");
    assert.equal(model.intent, null, "even though the engine's decision at funding_final is lock_eth, nothing was frozen");
    const last = JSON.parse(fs.readFileSync(path.join(sw.dir, "last-tick-bob.json"), "utf8"));
    assert.equal(last.observe_only, true);
    assert.equal(last.action.parameters, "withheld");
    assert.equal(watchWanted({ role: "bob", tick: last, approvalInForce: false, depositReasons: ["deposit_short"], sticky: false, abortSeen: 0 }), "read");
    assert.equal(watchWanted({ role: "bob", tick: last, approvalInForce: true, depositReasons: [], sticky: false, abortSeen: 0 }), "apply", "approval and deposit seen: now it records");
    // the switch: the first apply tick decides lock_eth at once (no new 18-block wait)
    const r = executor.watchStart({ mode: "apply" });
    assert.equal(r.started, true);
    await r.upgrade;
    await until(() => kit.calls.some((c) => c.args.includes("--apply")), "the first apply tick");
    const applied = JSON.parse(fs.readFileSync(path.join(sw.dir, "last-tick-bob.json"), "utf8"));
    assert.equal(applied.action.action, "lock_eth");
    assert.equal(applied.intent.status, "recorded");
    assert.equal(model.tip, 1018, "no block was waited for");
    await executor.watchStop();
    assert.ok(kit.calls.filter((c) => c.args.includes("--apply")).length >= 1 && kit.observed.length >= 2);
  } finally {
    await env.cleanup();
  }
});
