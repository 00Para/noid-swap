"use strict";
// Bob's new statement (build spec item 1): in program mode outside a board run his approval carries three statements, the last "Alice's check line matches mine", and a lock waits for it, whether he
// sends it by hand or the autopilot does. A board run and the terminal console are unchanged.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { makeEnv, until } = require("./program-harness");
const { SwapSet } = require("../lib/swapset");
const { requiredStatements, STATEMENTS, STOP_REASONS } = require("../lib/autopilot");
const { evaluateSpend, SPENDS, STATEMENT_ALICE_CHECK } = require("../lib/gate");
const F = require("./actions-fixtures");
const { WNA, statusText } = require("./wallet-harness");
const { parseWalletStatus } = require("../lib/walletrun");

const HEX = "b4271c7f3ea51fe7";
const BOB_STATEMENTS = { stay_on: true, no_manual_steps: true, alice_check_matches: true };
const TWO = { stay_on: true, no_manual_steps: true };
const idle = (runner) => until(() => runner.busy === null, "the action to end");

/** A Bob swap that is ready to lock: terms, swap file, the check line and the line match, a tick that records the lock, and a deposit that covers it. */
function bobReady(env, o = {}) {
  const sw = env.addSwap({ role: "bob" });
  env.writeTerms(sw, { aliceNoid: WNA });
  env.swapFile(sw, "bob");
  env.writeLineMatch(sw, "bob", { hex: HEX, match: o.match !== false });
  env.writeTick(sw, "bob", F.spendTick("lock_eth"));
  env.writeLoop(sw, "bob");
  env.steps.results.lock = (ctx, a) => {
    if (a.dryRun) {
      fs.writeFileSync(path.join(ctx.runDir, "eth-lock-100001.json"), JSON.stringify(F.lockDry()));
      return { code: 0, stdout: "", stderr: "", files: ["eth-lock-100001.json"] };
    }
    fs.writeFileSync(path.join(ctx.runDir, "eth-lock-100002.json"), JSON.stringify({ lockId: F.LOCK_ID, txHash: "0x" + "ab".repeat(32), blockNumber: 123 }));
    fs.writeFileSync(path.join(ctx.runDir, "eth-lock-100002.err"), `sent: 0x${"ab".repeat(32)} nonce 1\n`);
    return { code: 0, stdout: "", stderr: "", files: ["eth-lock-100002.json", "eth-lock-100002.err"] };
  };
  return sw;
}
const setStatus = (swap) => {
  const p = parseWalletStatus(statusText("bob"), "bob");
  swap.runner.walletStatus.bob = { at_ms: swap.runner.now(), ok: true, noid: null, eth: p.eth, problems: [] };
};
const mk = (env) => {
  const set = new SwapSet({ program: env.program, deps: env.deps() });
  set.scan();
  return set;
};

test("the statements: Bob's are three in the program outside a board run, and two otherwise; Alice's are unchanged", () => {
  assert.deepEqual(requiredStatements("bob", true, false, true), ["stay_on", "no_manual_steps", "alice_check_matches"]);
  assert.deepEqual(requiredStatements("bob", true, true, true), ["stay_on", "no_manual_steps"], "a board run");
  assert.deepEqual(requiredStatements("bob", true, false, false), ["stay_on", "no_manual_steps"], "the terminal console");
  assert.deepEqual(requiredStatements("bob", false, false, true), ["stay_on", "no_manual_steps"], "a classic run");
  assert.deepEqual(requiredStatements("bob"), ["stay_on", "no_manual_steps"]);
  for (const program of [false, true]) {
    assert.deepEqual(requiredStatements("alice", true, false, program), ["stay_on", "no_manual_steps", "bob_check_matches"]);
    assert.deepEqual(requiredStatements("alice", true, true, program), ["stay_on", "no_manual_steps"]);
    assert.deepEqual(requiredStatements("alice", false, false, program), ["stay_on", "no_manual_steps", "no_pending_funding", "bob_check_matches"]);
  }
  assert.equal(STATEMENTS.alice_check_matches, "Alice's check line matches mine: the 16 digits of her bundle check line are the ones of my line, compared over a second channel.");
  assert.equal(STATEMENT_ALICE_CHECK, "The statement was not confirmed: \"Alice's check line matches mine: the 16 digits of her bundle check line are the ones of my line, compared over a second channel\".");
});

test("program-mode Bob's approval lists three statements in the payload and the file, and is refused without the third", async () => {
  const env = makeEnv();
  try {
    const sw = bobReady(env);
    const set = mk(env);
    const swap = set.get(sw.id);
    assert.deepEqual(swap.autopilot.view(null).bob.statements.map((s) => s.id), ["stay_on", "no_manual_steps", "alice_check_matches"]);
    assert.throws(
      () => swap.autopilot.turnOn("bob", "0.001 ETH", TWO),
      (e) => e.status === 422 && e.reasons.length === 1 && e.reasons[0].code === "statement_alice_check_matches" && e.reasons[0].text === `The statement was not confirmed: "${STATEMENTS.alice_check_matches}"`,
    );
    assert.equal(swap.autopilot.turnOn("bob", "0.001 ETH", BOB_STATEMENTS).status, 200);
    const file = JSON.parse(fs.readFileSync(path.join(sw.dir, "autopilot-bob.json"), "utf8"));
    assert.deepEqual(file.statements, ["stay_on", "no_manual_steps", "alice_check_matches"]);
    assert.match(swap.audit.all().find((r) => r.action === "autopilot" && r.result === "approval given").detail, /statements=stay_on,no_manual_steps,alice_check_matches/);
    // Alice's side of the same program: unchanged
    assert.deepEqual(swap.autopilot.view(null).alice.available, false);
    await set.stopAll();
  } finally {
    await env.cleanup();
  }
});

test("statements_needed: the lock asks for alice_check_matches in the program outside a board run; every other spend and every other mode asks for none", async () => {
  const env = makeEnv();
  try {
    const sw = bobReady(env);
    const board = bobReady(env);
    fs.writeFileSync(path.join(board.dir, "run.json"), fs.readFileSync(path.join(board.dir, "run.json"), "utf8").replace('"handover": null', '"handover": "board"'));
    const set = mk(env);
    const spends = (id) => set.get(id).runner.view(null).spends;
    for (const s of Object.values(spends(sw.id))) assert.deepEqual(s.statements_needed, s.id === "send-lock" ? ["alice_check_matches"] : [], s.id);
    assert.deepEqual(spends(board.id)["send-lock"].statements_needed, [], "a board run");
    await set.stopAll();
  } finally {
    await env.cleanup();
  }
});

test("by hand: the lock is refused by the gate without the statement and passes with it; the route takes alice_check_matches as a boolean only; the audit line says so", async () => {
  const env = makeEnv();
  try {
    const sw = bobReady(env);
    const { srv, api } = await env.start();
    const swap = srv.swapSet.get(sw.id);
    setStatus(swap);
    let r = await api("POST", "/api/action", { swap: sw.id, id: "dry-lock" });
    assert.equal(r.status, 202, JSON.stringify(r.body));
    await idle(swap.runner);
    const view = (await api("GET", `/api/run?swap=${sw.id}`)).body.actions.spends["send-lock"];
    assert.equal(view.dry.all_ok, true, JSON.stringify(view.dry.rows));
    assert.deepEqual(view.statements_needed, ["alice_check_matches"]);
    const typed = view.expected_typed;
    assert.equal(typed, "0.001 ETH");
    // the route's own check
    for (const bad of ["yes", 1, null]) {
      r = await api("POST", "/api/spend", { swap: sw.id, id: "send-lock", typed, alice_check_matches: bad });
      assert.deepEqual([r.status, r.body.error], [400, "alice_check_matches must be true or false"], String(bad));
    }
    // without the statement
    r = await api("POST", "/api/spend", { swap: sw.id, id: "send-lock", typed });
    assert.equal(r.status, 422);
    assert.deepEqual(r.body.reasons.map((x) => x.code), ["statement_alice_check"]);
    assert.equal(r.body.reasons[0].text, STATEMENT_ALICE_CHECK);
    r = await api("POST", "/api/spend", { swap: sw.id, id: "send-lock", typed, alice_check_matches: false });
    assert.equal(r.status, 422);
    assert.equal(env.steps.calls.filter((c) => c.name === "lock" && c.args[0].dryRun === false).length, 0, "nothing was sent");
    // with it
    r = await api("POST", "/api/spend", { swap: sw.id, id: "send-lock", typed, alice_check_matches: true });
    assert.equal(r.status, 202, JSON.stringify(r.body));
    await idle(swap.runner);
    assert.equal(env.steps.calls.filter((c) => c.name === "lock" && c.args[0].dryRun === false).length, 1);
    const start = swap.audit.all().find((l) => l.action === "send-lock" && l.phase === "start");
    assert.match(start.detail, /statement=alice_check_line_matches/);
  } finally {
    await env.cleanup();
  }
});

test("by the autopilot: an approval that carries the statement locks; one that does not stops it with one needs-you entry and no loop of dry runs", async () => {
  const env = makeEnv();
  try {
    const sw = bobReady(env);
    const set = mk(env);
    const swap = set.get(sw.id);
    setStatus(swap);
    swap.autopilot.turnOn("bob", "0.001 ETH", BOB_STATEMENTS);
    const ap = swap.autopilot;
    // an approval whose statements lack the third (the hash is unchanged: it is still in force)
    const file = path.join(sw.dir, "autopilot-bob.json");
    const approved = JSON.parse(fs.readFileSync(file, "utf8"));
    fs.writeFileSync(file, JSON.stringify({ ...approved, statements: ["stay_on", "no_manual_steps"] }) + "\n");
    const run = () => swap.runner.readRunFn(swap.runner.cfg.runDirs, Math.floor(Date.now() / 1000));
    assert.equal(ap.approvalState("bob", run()).in_force, true);
    let t0 = 0;
    for (let i = 0; i < 12; i++) {
      env.writeTick(sw, "bob", F.spendTick("lock_eth"));
      setStatus(swap);
      swap.runner.last.clear();
      ap.step();
      await idle(swap.runner);
      if (ap.needViews("bob").length) {
        t0 = i;
        break;
      }
    }
    const need = ap.needViews("bob");
    assert.equal(need.length, 1, "one needs-you entry");
    assert.equal(need[0].spend, "send-lock");
    assert.equal(need[0].reason, STATEMENT_ALICE_CHECK);
    assert.ok(STOP_REASONS.has("statement_alice_check"));
    assert.ok(t0 < 11);
    assert.equal(env.steps.calls.filter((c) => c.name === "lock" && c.args[0].dryRun === false).length, 0, "nothing was sent");
    const dryRuns = env.steps.calls.filter((c) => c.name === "lock" && c.args[0].dryRun === true).length;
    assert.ok(dryRuns <= 1, `no loop of dry runs (${dryRuns})`);
    // more steps: nothing new
    for (let i = 0; i < 4; i++) {
      env.writeTick(sw, "bob", F.spendTick("lock_eth"));
      setStatus(swap);
      swap.runner.last.clear();
      ap.step();
      await idle(swap.runner);
    }
    assert.equal(ap.needViews("bob").length, 1);
    assert.equal(env.steps.calls.filter((c) => c.name === "lock").length, dryRuns, "no further step of the lock");
    await set.stopAll();
  } finally {
    await env.cleanup();
  }
});

test("by the autopilot with the statement: the lock goes through the same gate and is sent once", async () => {
  const env = makeEnv();
  try {
    const sw = bobReady(env);
    const set = mk(env);
    const swap = set.get(sw.id);
    setStatus(swap);
    swap.autopilot.turnOn("bob", "0.001 ETH", BOB_STATEMENTS);
    let sent = 0;
    for (let i = 0; i < 14 && !sent; i++) {
      env.writeTick(sw, "bob", F.spendTick("lock_eth"));
      setStatus(swap);
      swap.runner.last.clear();
      swap.autopilot.step();
      await idle(swap.runner);
      sent = env.steps.calls.filter((c) => c.name === "lock" && c.args[0].dryRun === false).length;
    }
    assert.equal(sent, 1);
    assert.deepEqual(swap.autopilot.needViews("bob"), []);
    const start = swap.audit.all().find((l) => l.action === "send-lock" && l.phase === "start");
    assert.match(start.detail, /statement=alice_check_line_matches/);
    assert.match(start.detail, /auto=1/);
    await set.stopAll();
  } finally {
    await env.cleanup();
  }
});

test("a board run and the terminal console are unchanged: the gate needs no statement without the flag, and a board run's lock is not asked for one", async () => {
  const ctx = (o = {}) => ({ run: { terms: F.TERMS, roles: {} }, nowMs: Date.now(), dry: null, expectedDryCommand: "x", requireTyped: true, typed: "0.001 ETH", ...o });
  const codes = (o) => evaluateSpend(SPENDS["send-lock"], ctx(o)).reasons.map((r) => r.code);
  assert.ok(!codes({}).includes("statement_alice_check"), "no flag: as before");
  assert.ok(!codes({ aliceCheckRequired: false }).includes("statement_alice_check"));
  assert.ok(codes({ aliceCheckRequired: true }).includes("statement_alice_check"));
  assert.ok(codes({ aliceCheckRequired: true, aliceCheck: false }).includes("statement_alice_check"));
  assert.ok(!codes({ aliceCheckRequired: true, aliceCheck: true }).includes("statement_alice_check"));
  assert.ok(!codes({ aliceCheckRequired: true, board: { on: true, facts: null } }).includes("statement_alice_check"), "a board run");
  // the statement is a statement of the request: the preview (no typed text asked) does not carry it
  assert.ok(!evaluateSpend(SPENDS["send-lock"], ctx({ requireTyped: false, aliceCheckRequired: true })).reasons.some((r) => r.code === "statement_alice_check"));
  // and only the lock
  for (const id of ["send-fund", "send-reveal", "send-claim"]) assert.ok(!evaluateSpend(SPENDS[id], ctx({ aliceCheckRequired: true })).reasons.some((r) => r.code === "statement_alice_check"), id);
});
