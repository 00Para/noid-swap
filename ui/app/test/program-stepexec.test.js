"use strict";
// Program mode: the step executor (lib/stepexec.js): the table-to-step mapping, the checks before every entry, the rules for a step that sends, the signal, the watch loop.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { makeEnv } = require("./program-harness");
const { createStepExecutor, resolve, isSender } = require("../lib/stepexec");
const { createRunJsonSource } = require("../lib/settingsource");
const { AuditLog } = require("../lib/audit");
const { TABLE, WALLET_TABLE, BOARD_TABLE, BY_ID } = require("../lib/actions");
const runsettings = require("../lib/runsettings");

const TX = "0x" + "ab".repeat(32);

function exec(env, role = "alice", o = {}) {
  const sw = env.addSwap({ role, ...(o.swap || {}) });
  const source = createRunJsonSource({ dir: sw.dir });
  const audit = new AuditLog(sw.pub, { role });
  const executor = createStepExecutor({ program: env.program, swap: { id: sw.id, dir: sw.dir, settingsSource: source, audit }, steps: env.steps, now: o.now, watchOpts: o.watchOpts });
  return { sw, executor, audit, source };
}

const ALL_IDS = [...TABLE, ...WALLET_TABLE, ...BOARD_TABLE].map((e) => e.id);

// table id -> [step name, args of the step after ctx]
const EXPECT = {
  setup: ["setup", []],
  prepare: ["prepare", []],
  join: ["join", ["/chosen/alice.bundle.json"]],
  "board-join": ["join", null],
  "wallet-setup-alice": ["walletSetup", ["alice", {}]],
  "wallet-setup-bob": ["walletSetup", ["bob", {}]],
  "wallet-status-alice": ["walletStatus", ["alice"]],
  "wallet-status-bob": ["walletStatus", ["bob"]],
  "tick-alice": ["tick", ["alice", {}]],
  "tick-bob": ["tick", ["bob", {}]],
  "dry-lock": ["lock", [{ dryRun: true }]],
  "send-lock": ["lock", [{ dryRun: false }]],
  "dry-reveal": ["reveal", [{ dryRun: true }]],
  "send-reveal": ["reveal", [{ dryRun: false }]],
  "dry-reveal-replace": ["reveal", [{ dryRun: true, replace: TX }]],
  "send-reveal-replace": ["reveal", [{ dryRun: false, replace: TX }]],
  "dry-claim": ["claim", [{ submit: false }]],
  "send-claim": ["claim", [{ submit: true }]],
  "dry-refund-eth": ["refundEth", [{ dryRun: true }]],
  "send-refund-eth": ["refundEth", [{ dryRun: false }]],
  "dry-refund-eth-replace": ["refundEth", [{ dryRun: true, replace: TX }]],
  "send-refund-eth-replace": ["refundEth", [{ dryRun: false, replace: TX }]],
  "dry-fund": ["walletFund", [{ dryRun: true }]],
  "send-fund": ["walletFund", [{ dryRun: false }]],
  "dry-recover": ["walletRecover", [{ dryRun: true }]],
  "send-recover": ["walletRecover", [{ dryRun: false }]],
  "wallet-record-close": ["walletRecover", [{ record: true }]],
  "dry-sweep-noid": ["walletSweep", ["noid", "alice", { dryRun: true }]],
  "send-sweep-noid": ["walletSweep", ["noid", "alice", { dryRun: false }]],
  "dry-sweep-eth-alice": ["walletSweep", ["eth", "alice", { dryRun: true }]],
  "send-sweep-eth-alice": ["walletSweep", ["eth", "alice", { dryRun: false }]],
  "dry-sweep-eth-bob": ["walletSweep", ["eth", "bob", { dryRun: true }]],
  "send-sweep-eth-bob": ["walletSweep", ["eth", "bob", { dryRun: false }]],
  "board-sign-addresses": ["boardSign", ["addresses"]],
  "board-sign-checked": ["boardSign", ["checked"]],
  "board-verify-addresses": ["boardVerify", ["addresses"]],
  "board-verify-checked": ["boardVerify", ["checked"]],
  "board-balance": ["boardBalance", []],
  "board-digest-alice": ["boardDigest", ["alice"]],
  "board-digest-bob": ["boardDigest", ["bob"]],
};

test("every table id has a mapping or is terminal-only or the watch (the table and the mapping cannot drift apart)", () => {
  for (const id of ALL_IDS) {
    if (id === "install" || id === "check-object") assert.equal(resolve(id, {}), null, id);
    else if (id === "watch-start" || id === "watch-stop") assert.equal(resolve(id, {}), null, id);
    else assert.ok(EXPECT[id], `${id} is a table id the test does not map`);
  }
  for (const id of Object.keys(EXPECT)) assert.ok(BY_ID.has(id), `${id} is not a table id`);
});

test("mapping: each entry runs its step with the option set of spec 5.A.2 (the replace hash, the chosen bundle file, the swap's role)", async () => {
  const env = makeEnv();
  try {
    for (const id of Object.keys(EXPECT)) {
      const role = BY_ID.get(id).role === "bob" || /bob$/.test(id) ? "bob" : "alice";
      // the entries of the other role are refused, so each runs in a swap of its own role; role-less ones in Alice's
      const { executor, sw } = exec(env, role);
      env.steps.calls.length = 0;
      if (id === "board-balance" || /^board-digest-/.test(id) || id === "board-verify-addresses") {
        // the board entries of a run that is not a board run are the runner's business (mode); the executor runs what it is given
      }
      const r = await executor.run(BY_ID.get(id), { tx: TX, bundlePath: "/chosen/alice.bundle.json" });
      assert.equal(r.refused, undefined, `${id}: ${r.why}`);
      assert.equal(env.steps.calls.length, 1, id);
      const c = env.steps.calls[0];
      const [name, args] = EXPECT[id];
      assert.equal(c.name, name, id);
      if (args !== null) assert.deepEqual(c.args, args, id);
      else assert.deepEqual(c.args, [path.join(sw.dir, "board", "bundle-in.json")], id);
      assert.equal(c.runDir, sw.dir);
      assert.equal(c.role, role);
      assert.equal(c.runNumber, sw.id.slice(0, 8));
      assert.equal(c.hasNotify, true);
      // a sender never gets a signal; everything that sends nothing does
      assert.equal(c.signal, !(BY_ID.get(id).group === "spend" || /^board-sign-/.test(id)), `signal for ${id}`);
      assert.equal(r.step, name);
      assert.equal(r.code, 0);
    }
  } finally {
    await env.cleanup();
  }
});

test("isSender: the spends and the signing steps only", () => {
  for (const e of [...TABLE, ...WALLET_TABLE, ...BOARD_TABLE]) assert.equal(isSender(e), e.group === "spend" || /^board-sign-/.test(e.id), e.id);
});

test("the terminal-only entries are refused 409 and no step is called", async () => {
  const env = makeEnv();
  try {
    const { executor } = exec(env);
    for (const id of ["install", "check-object"]) {
      const c = executor.precheck(BY_ID.get(id), {});
      assert.equal(c.ok, false);
      assert.equal(c.status, 409);
      assert.equal(c.tag, "terminal_only");
      const r = await executor.run(BY_ID.get(id), {});
      assert.equal(r.refused, true);
    }
    assert.equal(env.steps.calls.length, 0);
  } finally {
    await env.cleanup();
  }
});

test("the checks before every entry, in order: run.json, production, role, the other role's file, the folder guard, the vault, the recovery code", async () => {
  const env = makeEnv();
  try {
    const { sw, executor } = exec(env, "alice");
    const tick = BY_ID.get("tick-alice");
    const lock = BY_ID.get("dry-lock"); // Bob's entry in an Alice swap
    assert.equal(executor.precheck(tick, {}).ok, true);
    // role rule
    let c = executor.precheck(lock, {});
    assert.deepEqual([c.ok, c.status, c.tag], [false, 409, "role"]);
    c = executor.precheck(BY_ID.get("tick-bob"), {});
    assert.equal(c.tag, "role");
    // the other role's swap file in the folder
    fs.mkdirSync(path.join(sw.dir, "bob"));
    fs.writeFileSync(path.join(sw.dir, "bob", "bob.swap.json"), "{}");
    assert.equal(executor.precheck(tick, {}).tag, "other_role_file");
    fs.rmSync(path.join(sw.dir, "bob"), { recursive: true });
    // the folder guard
    env.guard.ok = false;
    c = executor.precheck(tick, { sender: true }); // read fresh (a view may still be answered by a 10 s cache)
    assert.deepEqual([c.ok, c.tag], [false, "folder_guard"]);
    env.guard.ok = true;
    assert.equal(executor.precheck(tick, { sender: true }).ok, true); // read again: the cache holds the newest answer
    // the vault
    env.vaultState.ready = false;
    assert.equal(executor.precheck(tick, {}).tag, "vault");
    env.vaultState.ready = true;
    // the recovery code, for funding and the deposit-related entries only
    env.vaultState.confirmed = false;
    assert.equal(executor.precheck(BY_ID.get("send-fund"), {}).tag, "recovery_code");
    assert.equal(executor.precheck(BY_ID.get("dry-fund"), {}).tag, "recovery_code");
    assert.equal(executor.precheck(BY_ID.get("wallet-setup-alice"), {}).tag, "recovery_code");
    assert.equal(executor.precheck(tick, {}).ok, true, "a read-only entry does not need it");
    assert.equal(executor.precheck(BY_ID.get("send-recover"), {}).ok, true, "taking coins back never waits for it");
    env.vaultState.confirmed = true;
    // run.json: a broken file refuses with run_json; a production value with production; no step was called by any refusal
    fs.writeFileSync(path.join(sw.dir, "run.json"), "{}");
    assert.equal(executor.precheck(tick, {}).tag, "run_json");
    const prodText = fs.readFileSync(path.join(sw.dir, "run.json"), "utf8");
    fs.writeFileSync(path.join(sw.dir, "run.json"), JSON.stringify({ v: 1, profile: "production", chain_id: 1 }));
    assert.equal(executor.precheck(tick, {}).tag, "production");
    void prodText;
    assert.equal(env.steps.calls.length, 0);
    // and run() answers the same refusals without calling a step
    const r = await executor.run(tick, {});
    assert.equal(r.refused, true);
    assert.equal(r.code, null);
    assert.equal(env.steps.calls.length, 0);
  } finally {
    await env.cleanup();
  }
});

test("a missing run.json refuses everything (409 run_json); the only exception is the board's two offline checks in a slot", async () => {
  const env = makeEnv();
  try {
    const { sw, executor } = exec(env, "alice", { swap: { noRunJson: true } });
    for (const id of ["tick-alice", "setup", "wallet-setup-alice", "board-verify-addresses", "board-verify-checked"]) assert.equal(executor.precheck(BY_ID.get(id), {}).ok, false, id);
    fs.writeFileSync(path.join(sw.dir, "board-slot.json"), JSON.stringify({ v: 1, run_id: sw.id, role: "alice" }));
    for (const id of ["board-verify-addresses", "board-verify-checked"]) assert.equal(executor.precheck(BY_ID.get(id), {}).ok, true, id);
    for (const id of ["tick-alice", "setup", "wallet-setup-alice", "board-balance", "board-digest-alice", "dry-fund", "send-fund", "watch-start"]) assert.equal(executor.precheck(BY_ID.get(id), {}).ok, false, `slot: ${id}`);
    // a slot of Bob's does not run Alice's verify entries
    fs.writeFileSync(path.join(sw.dir, "board-slot.json"), JSON.stringify({ v: 1, run_id: sw.id, role: "bob" }));
    assert.equal(executor.precheck(BY_ID.get("board-verify-addresses"), {}).ok, false);
    // in the slot the verify step runs with no settings (so no node address): the child environment guard is common.js's
    fs.writeFileSync(path.join(sw.dir, "board-slot.json"), JSON.stringify({ v: 1, run_id: sw.id, role: "alice" }));
    const r = await executor.run(BY_ID.get("board-verify-addresses"), {});
    assert.equal(r.code, 0);
    assert.equal(env.steps.calls[0].hasSettings, false);
  } finally {
    await env.cleanup();
  }
});

test("the folder guard is read fresh before a spend (the program's own fresh call) and cached 10 s otherwise", async () => {
  let clock = 1_000_000;
  const env = makeEnv();
  try {
    const { executor } = exec(env, "alice", { now: () => clock });
    const before = env.guard.calls;
    executor.precheck(BY_ID.get("tick-alice"), {});
    executor.precheck(BY_ID.get("tick-alice"), {});
    assert.equal(env.guard.calls - before, 1, "the view-style entries share one read");
    clock += 11_000;
    executor.precheck(BY_ID.get("tick-alice"), {});
    assert.equal(env.guard.calls - before, 2);
    const f0 = env.guard.fresh;
    executor.precheck(BY_ID.get("send-fund"), {});
    executor.precheck(BY_ID.get("send-fund"), {});
    assert.equal(env.guard.fresh - f0, 2, "each spend entry reads it again with no cache");
    // a guard that fails after the cache holds a pass still stops the spend (the cache is not asked)
    env.guard.ok = false;
    assert.equal(executor.precheck(BY_ID.get("send-fund"), {}).tag, "folder_guard");
    assert.equal(executor.precheck(BY_ID.get("tick-alice"), {}).ok, false, "the fresh read that failed is the newest answer a view sees");
  } finally {
    await env.cleanup();
  }
});

test("an exception of a step is code null for a spend and for any other entry, never a 2 or a 3, and its text is not kept", async () => {
  const env = makeEnv();
  try {
    const { executor } = exec(env, "alice");
    env.steps.results.walletFund = () => {
      throw Object.assign(new Error("secret path C:/x and 0xdeadbeef"), { code: "EIO" });
    };
    env.steps.results.tick = () => Promise.reject(new Error("another secret"));
    for (const id of ["send-fund", "dry-fund", "tick-alice"]) {
      const r = await executor.run(BY_ID.get(id), {});
      assert.equal(r.code, null, id);
      assert.equal(r.threw, true);
      assert.ok(!/secret|0xdeadbeef|C:\/x/.test(r.stdout + r.stderr), "the error's text is not carried");
    }
    // a step that answers 2 or 3 itself is passed through unchanged (its own refusal)
    env.steps.results.walletFund = { code: 3, stdout: "wallet-fund REFUSED, nothing sent: x\n", stderr: "", files: ["a.json"] };
    const r = await executor.run(BY_ID.get("send-fund"), {});
    assert.deepEqual([r.code, r.files], [3, ["a.json"]]);
  } finally {
    await env.cleanup();
  }
});

test("a step that sends is never abandoned: no signal, no time-out; one that sends nothing is aborted after the entry's time limit", async () => {
  const env = makeEnv();
  try {
    const { executor } = exec(env, "alice");
    let release;
    env.steps.results.walletFund = () => new Promise((r) => (release = () => r({ code: 0, stdout: "", stderr: "", files: [] })));
    const spend = { ...BY_ID.get("send-fund"), timeout: 20 };
    let settled = false;
    const p = executor.run(spend, {}).then((r) => {
      settled = true;
      return r;
    });
    await new Promise((r) => setTimeout(r, 120));
    assert.equal(settled, false, "past its time limit a spend is still running");
    assert.equal(env.steps.calls[0].signal, false);
    release();
    assert.equal((await p).code, 0);
    // a read-only entry gets a signal and is aborted at its limit: the step sees the abort and ends
    env.steps.results.tick = (ctx) =>
      new Promise((resolveStep) => {
        ctx.signal.addEventListener("abort", () => resolveStep({ code: 124, stdout: "", stderr: "", files: [] }));
      });
    const quick = { ...BY_ID.get("tick-alice"), timeout: 30 };
    const r = await executor.run(quick, {});
    assert.equal(r.code, 124);
    assert.equal(env.steps.calls[1].signal, true);
  } finally {
    await env.cleanup();
  }
});

test("join needs the file the dialog chose; a replace entry needs a transaction hash", async () => {
  const env = makeEnv();
  try {
    const a = exec(env, "bob");
    let r = await a.executor.run(BY_ID.get("join"), {});
    assert.equal(r.refused, true);
    assert.equal(r.why, "no file chosen");
    r = await a.executor.run(BY_ID.get("send-refund-eth-replace"), { tx: "0xnot-a-hash" });
    assert.equal(r.refused, true);
    r = await a.executor.run(BY_ID.get("dry-refund-eth-replace"), {});
    assert.equal(r.refused, true);
    assert.equal(env.steps.calls.length, 0);
  } finally {
    await env.cleanup();
  }
});

test("the passphrase is asked of the vault by the step, per call, with the folder and run.json's run id; the executor keeps none", async () => {
  const env = makeEnv();
  try {
    const { sw, executor } = exec(env, "alice");
    env.steps.results.tick = async (ctx) => {
      ctx.getPassphrase();
      return { code: 0, stdout: "", stderr: "", files: [] };
    };
    const r = await executor.run(BY_ID.get("tick-alice"), {});
    assert.deepEqual(env.vault.calls, [{ runDir: sw.dir, runId: sw.id }]);
    assert.ok(!JSON.stringify(r).includes("FIXED-TEST-PASSPHRASE"));
    assert.ok(!JSON.stringify(Object.keys(executor)).includes("pass"));
  } finally {
    await env.cleanup();
  }
});

test("watch: start is idempotent, status shows it, stop ends it; the watch's context carries a signal and the swap's role", async () => {
  const env = makeEnv();
  try {
    const { executor } = exec(env, "alice");
    assert.deepEqual(executor.watchStart(), { started: true });
    assert.deepEqual(executor.watchStart(), { started: false });
    assert.equal(env.steps.watches.length, 1);
    const w = env.steps.watches[0];
    assert.equal(!!w.ctx.signal, true);
    assert.deepEqual(w.opts.roles, ["alice"]);
    assert.equal(w.opts.intervalMs, 30000);
    assert.equal(executor.watchStatus().running, true);
    // the two watch modes (lib/firststeps.js, rule W): the default start records, and the status says which mode runs
    assert.equal(w.opts.apply, true);
    assert.equal(executor.watchStatus().mode, "apply");
    assert.deepEqual(Object.keys(executor.watchStatus()).sort(), ["applied_once", "last_end", "last_line_at", "mode", "running", "started_at", "stopped_by_person", "ticks", "upgrading"]);
    await executor.watchStop();
    assert.equal(executor.watchStatus().running, false);
    assert.equal(executor.watchStatus().mode, null, "no loop, no mode");
    assert.equal(executor.watchStatus().last_end.reason, "stopped");
    // a read start passes apply: false to the loop
    assert.deepEqual(executor.watchStart({ mode: "read" }), { started: true });
    assert.equal(env.steps.watches.at(-1).opts.apply, false);
    assert.equal(executor.watchStatus().mode, "read");
    await executor.watchStop();
    // through run(): the ids of the table
    const r = await executor.run(BY_ID.get("watch-start"), {});
    assert.equal(r.code, 0);
    assert.equal((await executor.run(BY_ID.get("watch-start"), {})).stdout, "the watch loop is already running\n");
    assert.equal((await executor.run(BY_ID.get("watch-stop"), {})).code, 0);
  } finally {
    await env.cleanup();
  }
});

test("watch: a loop file older than 180 s aborts the tick's signal and starts a new watch (with an audit line); a fresh one does not", async () => {
  const env = makeEnv();
  try {
    let clock = Date.now();
    const { sw, executor, audit } = exec(env, "alice", { now: () => clock });
    executor.watchStart();
    // a young watch is never judged
    assert.equal(await executor.supervise(), false);
    clock += 200 * 1000;
    env.writeLoop(sw, "alice", -1); // written "now" by the real clock: the loop is fresh by the injected clock only if it is within 180 s of it
    const p = path.join(sw.dir, "loop-alice.txt");
    fs.utimesSync(p, new Date(clock), new Date(clock));
    assert.equal(await executor.supervise(), false, "a fresh loop file keeps the watch");
    clock += 200 * 1000;
    const first = env.steps.watches[0];
    assert.equal(await executor.supervise(), true);
    assert.equal(first.ctx.signal.aborted, true, "the old watch's signal was aborted (its tick child is killed)");
    assert.equal(env.steps.watches.length, 2);
    assert.equal(env.steps.watches[1].ctx.signal.aborted, false);
    assert.equal(executor.watchStatus().running, true);
    assert.ok(audit.all().some((r) => /watch loop restarted/.test(r.result)));
  } finally {
    await env.cleanup();
  }
});

test("the watch's end (terminal, stopped, refused) is written as an audit line", async () => {
  const env = makeEnv();
  try {
    const { executor, audit } = exec(env, "alice");
    executor.watchStart();
    await executor.watchStop();
    await new Promise((r) => setTimeout(r, 20));
    assert.ok(audit.all().some((r) => /watch loop ended: stopped/.test(r.result)));
  } finally {
    await env.cleanup();
  }
});

test("nothing in the executor builds a path or an argument from a request: the runDir is the swap's, whatever the entry says", async () => {
  const env = makeEnv();
  try {
    const { sw, executor } = exec(env, "alice");
    await executor.run({ ...BY_ID.get("tick-alice"), runDir: "/etc", dir: "/etc" }, { runDir: "/etc", dir: "/etc" });
    assert.equal(env.steps.calls[0].runDir, sw.dir);
    assert.ok(runsettings.load(sw.dir).run_id === sw.id);
  } finally {
    await env.cleanup();
  }
});
