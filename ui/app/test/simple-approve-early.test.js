"use strict";
// Approve before the deposit (build spec item 2, server side): the approval is bound to the bundle, run.json, the tools and the code, never to a tick, so it can be given before the first tick and
// stays in force when ticks arrive; with no deposit seen the program only reads; the deposit seen starts the recording and then the funding / the lock; the approval names what the person gets.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { makeEnv, until, loopKit } = require("./program-harness");
const { SwapSet } = require("../lib/swapset");
const F = require("./actions-fixtures");
const { WNA, WTX, statusText } = require("./wallet-harness");
const { parseWalletStatus } = require("../lib/walletrun");

const HEX = "b4271c7f3ea51fe7";
const ALICE_STATEMENTS = { stay_on: true, no_manual_steps: true, bob_check_matches: true };
const BOB_STATEMENTS = { stay_on: true, no_manual_steps: true, alice_check_matches: true };
const OK = { code: 0, stdout: "", stderr: "", files: [] };
const idle = (runner) => until(() => runner.busy === null, "the action to end");

const fundHead = () => [`wallet-fund: wallet ${WNA}`, `wallet-fund: contract_root ${F.TERMS.contract_root}`, `wallet-fund: reserve covered=true required_wei=1000000000000000 balance_wei=5000000000000000 address=${F.E.alice_receiver}`];
const fundDry = () =>
  [...fundHead(), "wallet-fund: outcome dry_run", `wallet-fund: target ${F.TERMS.contract_root}`, `wallet-fund: amount_micronoid ${F.TERMS.amount_micronoid}`, "wallet-fund: fee_micronoid 6000", "wallet-fund: inputs 1", `wallet-fund: txid ${WTX}`, "wallet-fund: summary dry run built", `dry run: would fund ${F.TERMS.amount_micronoid} micro-NOID once from the swap wallet to the contract address; nothing was written or sent`, "wallet-fund exit 0 (swap-cli wallet fund, outcome dry_run)"].join("\n") + "\n";
const fundSent = () => [...fundHead(), "wallet-fund: outcome sent", `wallet-fund: target ${F.TERMS.contract_root}`, `wallet-fund: txid ${WTX}`, "wallet-fund exit 0 (swap-cli wallet fund, outcome sent)"].join("\n") + "\n";

/** A prepared swap (terms, swap file, check line and its match), and NO tick file yet. */
function prepared(env, role) {
  const sw = env.addSwap({ role });
  env.writeTerms(sw, { aliceNoid: WNA });
  env.swapFile(sw, role);
  env.writeLineMatch(sw, role, { hex: HEX });
  return sw;
}
const setStatus = (swap, role, o = {}) => {
  const p = parseWalletStatus(statusText(role, o), role);
  swap.runner.walletStatus[role] = { at_ms: swap.runner.now(), ok: true, noid: p.noid, eth: p.eth, problems: [] };
};
const runOf = (swap) => swap.runner.readRunFn(swap.runner.cfg.runDirs, Math.floor(Date.now() / 1000));
// what a READ-ONLY tick prints when the funding is open: no intent is recorded and the spend is printed as its kind only, its parameters withheld (swap-cli main.rs printable_action)
const readStyle = (t) => {
  t.events_applied_to_file = false;
  t.intent = { status: "none", intent: null };
  t.action = { kind: "fund_noid", parameters: "withheld" };
};
const sends = (env, name) => env.steps.calls.filter((c) => c.name === name && c.args.length && c.args[0] && c.args[0].dryRun === false);

test("an approval given after the line match and before the first tick stays in force when ticks arrive, for either role", async () => {
  const env = makeEnv();
  try {
    for (const [role, typed, statements] of [["alice", "10 NOID", ALICE_STATEMENTS], ["bob", "0.001 ETH", BOB_STATEMENTS]]) {
      const sw = prepared(env, role);
      const set = new SwapSet({ program: env.program, deps: env.deps() });
      set.scan();
      const swap = set.get(sw.id);
      assert.equal(fs.existsSync(path.join(sw.dir, `last-tick-${role}.json`)), false, "no tick yet");
      assert.equal(swap.autopilot.turnOn(role, typed, statements).status, 200);
      const state = () => swap.autopilot.approvalState(role, runOf(swap), { fresh: true });
      assert.equal(state().in_force, true);
      const hash = state().hash;
      // ticks arrive, of the phases of both sides
      for (const phase of ["created", "received", "funding_final", "funded"]) {
        env.writeTick(sw, role, F.spendTick("fund_noid", { mutate: (t) => (t.phase_after = phase) }));
        assert.equal(state().in_force, true, `${role}: a tick in phase ${phase}`);
        assert.equal(state().hash, hash, "the hash does not read the tick");
      }
      assert.equal(swap.autopilot.view(runOf(swap))[role].on, true);
      await set.stopAll();
    }
  } finally {
    await env.cleanup();
  }
});

test("in force with no deposit seen: only a read loop runs and nothing is sent, however many ticks come", async () => {
  const env = makeEnv();
  try {
    const sw = prepared(env, "alice");
    const kit = loopKit(env, async (ctx, role, args, n) => {
      env.writeTick(sw, "alice", F.spendTick("fund_noid", { mutate: args.length ? undefined : readStyle }), 3 + (n % 2));
      return { code: 0, stdout: `applied: ${args.length ? "True" : "False"} phase_after: created\n`, stderr: "", files: [] };
    }, { pauseMs: 10 });
    const set = new SwapSet({ program: env.program, deps: kit.deps() });
    set.scan();
    const swap = set.get(sw.id);
    setStatus(swap, "alice", { covers: false, plain: 5 });
    swap.autopilot.turnOn("alice", "10 NOID", ALICE_STATEMENTS);
    for (let i = 0; i < 12; i++) {
      set.tick();
      await idle(swap.runner);
      await new Promise((r) => setTimeout(r, 8));
    }
    assert.ok(kit.calls.length >= 3);
    assert.ok(kit.calls.every((c) => c.args.length === 0), "every tick is read-only");
    assert.equal(swap.executor.watchStatus().mode, "read");
    assert.equal(env.steps.calls.filter((c) => c.name === "walletFund").length, 0, "no dry run and no funding");
    assert.equal(swap.autopilot.view(runOf(swap)).alice.waiting_reason, "Waiting for your deposit to be seen; until then the program only reads the chains.");
    // no stopped step; the 5 micro-NOID the wallet holds are a short deposit, which the person is told (test/simple-short-deposit.test.js)
    assert.deepEqual(swap.autopilot.needViews("alice").filter((n) => n.kind !== "deposit"), []);
    await set.stopAll();
  } finally {
    await env.cleanup();
  }
});

test("a deposit that is seen upgrades the loop to recording, and the funding follows through the usual dry run and gate, once", async () => {
  const env = makeEnv();
  try {
    const sw = prepared(env, "alice");
    env.steps.results.walletFund = (ctx, o) => {
      if (o.dryRun) return { code: 0, stdout: fundDry(), stderr: "", files: [] };
      fs.writeFileSync(path.join(ctx.runDir, "wallet-funded.marker"), `2026-11-17T10:00:00Z\ntxid ${WTX}\n`);
      return { code: 0, stdout: fundSent(), stderr: "", files: ["wallet-funded.marker"] };
    };
    const kit = loopKit(env, async (ctx, role, args) => {
      // a read tick does not print the funding's parameters; an applied one records the intent
      env.writeTick(sw, "alice", F.spendTick("fund_noid", { mutate: args.length ? undefined : readStyle }), 3);
      return { code: 0, stdout: `applied: ${args.length ? "True" : "False"} phase_after: created\n`, stderr: "", files: [] };
    }, { pauseMs: 15 });
    const set = new SwapSet({ program: env.program, deps: kit.deps() });
    set.scan();
    const swap = set.get(sw.id);
    setStatus(swap, "alice", { covers: false, plain: 5 });
    swap.autopilot.turnOn("alice", "10 NOID", ALICE_STATEMENTS);
    for (let i = 0; i < 4; i++) {
      set.tick();
      await idle(swap.runner);
    }
    assert.equal(swap.executor.watchStatus().mode, "read");
    assert.equal(env.steps.calls.filter((c) => c.name === "walletFund").length, 0);
    // the deposit is seen
    let n = 0;
    await until(() => {
      setStatus(swap, "alice");
      swap.runner.last.clear();
      set.tick();
      n++;
      return sends(env, "walletFund").length === 1;
    }, "the funding", 8000);
    await idle(swap.runner);
    assert.ok(kit.calls.some((c) => c.args.includes("--apply")), "the loop records now");
    assert.equal(sends(env, "walletFund").length, 1);
    // nothing more is sent
    for (let i = 0; i < 6; i++) {
      setStatus(swap, "alice", { covers: false, plain: 0 });
      swap.runner.last.clear();
      set.tick();
      await idle(swap.runner);
    }
    assert.equal(sends(env, "walletFund").length, 1);
    void n;
    await set.stopAll();
  } finally {
    await env.cleanup();
  }
});

test("Bob approves before any tick and his lock still waits for Alice's funding to be final and for his deposit", async () => {
  const env = makeEnv();
  try {
    const sw = prepared(env, "bob");
    env.steps.results.lock = (ctx, a) => {
      if (a.dryRun) {
        fs.writeFileSync(path.join(ctx.runDir, "eth-lock-100001.json"), JSON.stringify(F.lockDry()));
        return { code: 0, stdout: "", stderr: "", files: ["eth-lock-100001.json"] };
      }
      fs.writeFileSync(path.join(ctx.runDir, "eth-lock-100002.json"), JSON.stringify({ lockId: F.LOCK_ID, txHash: "0x" + "ab".repeat(32), blockNumber: 123 }));
      fs.writeFileSync(path.join(ctx.runDir, "eth-lock-100002.err"), `sent: 0x${"ab".repeat(32)} nonce 1\n`);
      return { code: 0, stdout: "", stderr: "", files: ["eth-lock-100002.json", "eth-lock-100002.err"] };
    };
    const kit = loopKit(env, undefined, { pauseMs: 2000 });
    const set = new SwapSet({ program: env.program, deps: kit.deps() });
    set.scan();
    const swap = set.get(sw.id);
    // approval first, no tick at all
    assert.equal(swap.autopilot.turnOn("bob", "0.001 ETH", BOB_STATEMENTS).status, 200);
    const step = async () => {
      set.tick();
      await idle(swap.runner);
      swap.runner.last.clear();
      swap.autopilot.step();
      await idle(swap.runner);
    };
    // Alice's funding is not final yet: the engine says wait. The deposit is there, the loop may record, and no lock is started
    setStatus(swap, "bob");
    env.writeTick(sw, "bob", F.spendTick("lock_eth", { mutate: (t) => ((t.phase_after = "funded"), (t.action = { action: "wait", reason: "waiting for funding finality" }), (t.intent = { status: "none", intent: null })) }));
    for (let i = 0; i < 5; i++) await step();
    assert.equal(env.steps.calls.filter((c) => c.name === "lock").length, 0, "no lock while Alice's funding is not final");
    // the lock is offered (the engine recorded it) but the deposit is short: no lock, no dry run
    env.writeTick(sw, "bob", F.spendTick("lock_eth"));
    setStatus(swap, "bob", { covered: false });
    for (let i = 0; i < 5; i++) {
      env.writeTick(sw, "bob", F.spendTick("lock_eth"));
      setStatus(swap, "bob", { covered: false });
      await step();
    }
    assert.equal(env.steps.calls.filter((c) => c.name === "lock").length, 0, "no lock while the deposit is short");
    // the deposit arrives
    let sent = 0;
    for (let i = 0; i < 14 && !sent; i++) {
      env.writeTick(sw, "bob", F.spendTick("lock_eth"));
      setStatus(swap, "bob");
      await step();
      sent = sends(env, "lock").length;
    }
    assert.equal(sent, 1);
    await set.stopAll();
  } finally {
    await env.cleanup();
  }
});

test("gets_text: what the person gets, from the terms: Alice gets ETH, Bob gets NOID", async () => {
  const env = makeEnv();
  try {
    const a = prepared(env, "alice");
    const b = prepared(env, "bob");
    // the agreed amounts of the bundle: 5 NOID for 0.001 ETH
    for (const sw of [a, b]) {
      for (const d of [sw.dir, sw.pub]) {
        const f = path.join(d, "alice.bundle.json");
        const j = JSON.parse(fs.readFileSync(f, "utf8"));
        j.params.amount_micronoid = 5000000;
        fs.writeFileSync(f, JSON.stringify(j));
      }
    }
    const set = new SwapSet({ program: env.program, deps: env.deps() });
    set.scan();
    const view = (sw, role) => set.get(sw.id).autopilot.view(runOf(set.get(sw.id)))[role];
    assert.equal(view(a, "alice").gets_text, "0.001 ETH");
    assert.equal(view(a, "alice").expected_typed, "5 NOID", "the typed amount stays what is given");
    assert.equal(view(b, "bob").gets_text, "5 NOID");
    assert.equal(view(b, "bob").expected_typed, "0.001 ETH");
    // without terms there is nothing to show
    assert.equal(set.get(a.id).autopilot.view(null).alice.gets_text, null);
    await set.stopAll();
  } finally {
    await env.cleanup();
  }
});

void OK;
