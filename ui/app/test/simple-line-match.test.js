"use strict";
// The line match (build spec 1.5): the person says the other side read out the same 16 digits. It is recorded on the server (line-match.json and one audit note), and in program mode outside a
// board run neither role can approve, and nobody can send a funding or a lock by hand, until the record exists for the current check line.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { makeEnv, until } = require("./program-harness");
const { SwapSet } = require("../lib/swapset");
const { readLineMatch, lineMatchFor, confirmLineMatch, MATCH_FILE, CHECK_FILE } = require("../lib/firststeps");
const { evaluateSpend, SPENDS, LINE_MATCH_MISSING } = require("../lib/gate");
const runsettings = require("../lib/runsettings");
const F = require("./actions-fixtures");
const { WNA, WTX, statusText } = require("./wallet-harness");

const HEX = "b4271c7f3ea51fe7";
const OTHER = "0000000000000001";
const TYPED_ALICE = "10 NOID";
const TYPED_BOB = "0.001 ETH";
const ALICE_STATEMENTS = { stay_on: true, no_manual_steps: true, bob_check_matches: true };
const BOB_STATEMENTS = { stay_on: true, no_manual_steps: true, alice_check_matches: true };
const WORDS = "First confirm that the other person read you their check line and all 16 digits match.";

const fundHead = () => [`wallet-fund: wallet ${WNA}`, `wallet-fund: contract_root ${F.TERMS.contract_root}`, `wallet-fund: reserve covered=true required_wei=1000000000000000 balance_wei=5000000000000000 address=${F.E.alice_receiver}`];
const fundDry = () =>
  [...fundHead(), "wallet-fund: outcome dry_run", `wallet-fund: target ${F.TERMS.contract_root}`, `wallet-fund: amount_micronoid ${F.TERMS.amount_micronoid}`, "wallet-fund: fee_micronoid 6000", "wallet-fund: inputs 1", `wallet-fund: txid ${WTX}`, "wallet-fund: summary dry run built", `dry run: would fund ${F.TERMS.amount_micronoid} micro-NOID once from the swap wallet to the contract address; nothing was written or sent`, "wallet-fund exit 0 (swap-cli wallet fund, outcome dry_run)"].join("\n") + "\n";
const fundSent = () => [...fundHead(), "wallet-fund: outcome sent", `wallet-fund: target ${F.TERMS.contract_root}`, `wallet-fund: txid ${WTX}`, "wallet-fund exit 0 (swap-cli wallet fund, outcome sent)"].join("\n") + "\n";

const idle = (runner) => until(() => runner.busy === null, "the action to end");
const mk = (env) => {
  const set = new SwapSet({ program: env.program, deps: env.deps() });
  set.scan();
  return set;
};

/** A prepared swap of a role: terms, swap file, a check line (and no match yet). */
function prepared(env, role) {
  const sw = env.addSwap({ role });
  env.writeTerms(sw, { aliceNoid: WNA });
  env.swapFile(sw, role);
  env.writeLineMatch(sw, role, { hex: HEX, match: false });
  return sw;
}
const post = (api, sw, body) => api("POST", "/api/checkline/confirm", { swap: sw.id, ...body });
const notes = (swap) => swap.audit.all().filter((r) => r.action === "check-line");

test("the route writes line-match.json once and one audit note; the same hex again answers the same and writes nothing", async () => {
  const env = makeEnv();
  try {
    const sw = prepared(env, "alice");
    const { srv, api } = await env.start();
    const swap = srv.swapSet.get(sw.id);
    assert.equal(swap.runner.view(null).line_match, null);
    let r = await post(api, sw, { matches: true, hex: HEX });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.ok, true);
    assert.equal(r.body.line_match.hex, HEX);
    assert.equal(Number.isInteger(r.body.line_match.at), true);
    const text = fs.readFileSync(path.join(sw.dir, MATCH_FILE), "utf8");
    assert.deepEqual(JSON.parse(text), { v: 1, role: "alice", hex: HEX, at: r.body.line_match.at });
    assert.equal(text.endsWith("\n"), true);
    assert.deepEqual(Object.keys(JSON.parse(text)), ["v", "role", "hex", "at"]);
    const n = notes(swap);
    assert.equal(n.length, 1);
    assert.deepEqual([n[0].role, n[0].phase, n[0].result, n[0].detail], ["alice", "note", "the other side's line matches", HEX]);
    // again: the same answer, no second line, the file as it was
    const r2 = await post(api, sw, { matches: true, hex: HEX });
    assert.equal(r2.status, 200);
    assert.deepEqual(r2.body, r.body);
    assert.equal(notes(swap).length, 1);
    assert.equal(fs.readFileSync(path.join(sw.dir, MATCH_FILE), "utf8"), text);
    // the run payload shows the record, for the current line only
    const payload = (await api("GET", `/api/run?swap=${sw.id}`)).body.actions;
    assert.deepEqual(payload.line_match, { hex: HEX, at: r.body.line_match.at });
    assert.deepEqual(payload.check_line, { hex: HEX, from: "prepare" });
  } finally {
    await env.cleanup();
  }
});

test("the route's refusals, each with its words, and nothing is written", async () => {
  const env = makeEnv();
  try {
    const sw = prepared(env, "alice");
    const noLine = env.addSwap({ role: "alice" });
    const board = prepared(env, "alice");
    fs.writeFileSync(path.join(board.dir, "run.json"), fs.readFileSync(path.join(board.dir, "run.json"), "utf8").replace('"handover": null', '"handover": "board"'));
    const prod = prepared(env, "alice");
    fs.writeFileSync(path.join(prod.dir, "run.json"), fs.readFileSync(path.join(prod.dir, "run.json"), "utf8").replace('"sepolia"', '"production"'));
    const { srv, api } = await env.start();
    const swap = srv.swapSet.get(sw.id);
    let r = await post(api, sw, { matches: false, hex: HEX });
    assert.deepEqual([r.status, r.body.error], [400, "matches must be true"]);
    r = await post(api, sw, { hex: HEX });
    assert.equal(r.status, 400);
    r = await post(api, sw, { matches: "true", hex: HEX });
    assert.equal(r.status, 400);
    r = await post(api, noLine, { matches: true, hex: HEX });
    assert.deepEqual([r.status, r.body.error], [409, "There is no check line yet."]);
    r = await post(api, sw, { matches: true, hex: OTHER });
    assert.deepEqual([r.status, r.body.error], [409, "The check line on the page is not this swap's line any more. Read it again."]);
    r = await post(api, sw, { matches: true });
    assert.equal(r.status, 409, "no hex is not this line");
    r = await post(api, sw, { matches: true, hex: 12345 });
    assert.equal(r.status, 409);
    r = await post(api, board, { matches: true, hex: HEX });
    assert.deepEqual([r.status, r.body.error], [409, "A board run compares the full digest by itself."]);
    r = await post(api, prod, { matches: true, hex: HEX });
    assert.equal(r.status, 403, "a production run: the existing words");
    assert.match(r.body.error, /production/i);
    for (const s of [sw, noLine, board, prod]) assert.equal(fs.existsSync(path.join(s.dir, MATCH_FILE)), false, "nothing was written");
    assert.equal(notes(swap).length, 0);
    // a read-only folder (another console holds it) is refused too
    const held = prepared(env, "alice");
    fs.writeFileSync(path.join(held.dir, "ui-console.lock"), JSON.stringify({ pid: process.pid, started: "2020-01-01T00:00:00Z", role: "alice" }) + "\n");
    srv.swapSet.scan();
    r = await post(api, held, { matches: true, hex: HEX });
    assert.equal(r.status, 409);
    assert.equal(fs.existsSync(path.join(held.dir, MATCH_FILE)), false);
    // no swap named
    r = await api("POST", "/api/checkline/confirm", { matches: true, hex: HEX });
    assert.equal(r.status, 400);
  } finally {
    await env.cleanup();
  }
});

test("the audit line comes first: when it cannot be written nothing is recorded", async () => {
  const env = makeEnv();
  try {
    const sw = prepared(env, "alice");
    const set = mk(env);
    const swap = set.get(sw.id);
    swap.runner.audit.append = () => {
      throw Object.assign(new Error("disk full"), { code: "ENOSPC" });
    };
    assert.throws(() => swap.runner.confirmCheckLine({ matches: true, hex: HEX }), (e) => e.status === 500 && /nothing was recorded/.test(e.message));
    assert.equal(fs.existsSync(path.join(sw.dir, MATCH_FILE)), false);
    await set.stopAll();
  } finally {
    await env.cleanup();
  }
});

test("Alice's approval is refused with line_match_missing before the record and passes after it, with her statements", async () => {
  const env = makeEnv();
  try {
    const sw = prepared(env, "alice");
    env.writeTick(sw, "alice", F.spendTick("fund_noid"));
    const set = mk(env);
    const swap = set.get(sw.id);
    assert.throws(
      () => swap.autopilot.turnOn("alice", TYPED_ALICE, ALICE_STATEMENTS),
      (e) => e.status === 422 && e.reasons[0].code === "line_match_missing" && e.reasons[0].text === WORDS,
    );
    assert.equal(fs.existsSync(path.join(sw.dir, "autopilot-alice.json")), false, "no approval file");
    swap.runner.confirmCheckLine({ matches: true, hex: HEX });
    const out = swap.autopilot.turnOn("alice", TYPED_ALICE, ALICE_STATEMENTS);
    assert.equal(out.status, 200);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(sw.dir, "autopilot-alice.json"), "utf8")).statements, ["stay_on", "no_manual_steps", "bob_check_matches"]);
    await set.stopAll();
  } finally {
    await env.cleanup();
  }
});

test("a record whose hex is not the current check line's counts as none, and so does one of the other role", async () => {
  const env = makeEnv();
  try {
    const sw = prepared(env, "alice");
    fs.writeFileSync(path.join(sw.dir, MATCH_FILE), JSON.stringify({ v: 1, role: "alice", hex: OTHER, at: 1_800_000_000 }) + "\n");
    assert.equal(lineMatchFor(sw.dir, "alice"), null);
    const set = mk(env);
    const swap = set.get(sw.id);
    assert.equal(swap.runner.view(null).line_match, null, "the payload shows only a match of the current line");
    assert.throws(() => swap.autopilot.turnOn("alice", TYPED_ALICE, ALICE_STATEMENTS), (e) => e.reasons[0].code === "line_match_missing");
    // another role's record
    fs.writeFileSync(path.join(sw.dir, MATCH_FILE), JSON.stringify({ v: 1, role: "bob", hex: HEX, at: 1_800_000_000 }) + "\n");
    assert.equal(lineMatchFor(sw.dir, "alice"), null);
    assert.equal(readLineMatch(sw.dir).role, "bob");
    // confirming again replaces a record that counts as none, with an audit line
    const r = swap.runner.confirmCheckLine({ matches: true, hex: HEX });
    assert.equal(r.status, 200);
    assert.deepEqual(lineMatchFor(sw.dir, "alice") && lineMatchFor(sw.dir, "alice").hex, HEX);
    assert.equal(notes(swap).length, 1);
    // an extra key or a bad hex in the file: none
    fs.writeFileSync(path.join(sw.dir, MATCH_FILE), JSON.stringify({ v: 1, role: "alice", hex: HEX, at: 1, x: 1 }) + "\n");
    assert.equal(readLineMatch(sw.dir), null);
    await set.stopAll();
  } finally {
    await env.cleanup();
  }
});

test("Bob's approval needs his own swap file first (his check of Alice's file), then the line match; his statements are three", async () => {
  const env = makeEnv();
  try {
    const sw = env.addSwap({ role: "bob" });
    env.writeTerms(sw, { aliceNoid: WNA });
    const set = mk(env);
    const swap = set.get(sw.id);
    // no swap file: the check of Alice's file has not passed
    assert.throws(
      () => swap.autopilot.turnOn("bob", TYPED_BOB, BOB_STATEMENTS),
      (e) => e.status === 422 && e.reasons[0].code === "terms_missing" && e.reasons[0].text === "Your check of Alice's file has not passed, so there is nothing to approve.",
    );
    env.swapFile(sw, "bob");
    env.writeLineMatch(sw, "bob", { hex: HEX, match: false });
    assert.throws(() => swap.autopilot.turnOn("bob", TYPED_BOB, BOB_STATEMENTS), (e) => e.reasons[0].code === "line_match_missing" && e.reasons[0].text === WORDS);
    swap.runner.confirmCheckLine({ matches: true, hex: HEX });
    assert.equal(swap.autopilot.turnOn("bob", TYPED_BOB, BOB_STATEMENTS).status, 200);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(sw.dir, "autopilot-bob.json"), "utf8")).statements, ["stay_on", "no_manual_steps", "alice_check_matches"]);
    assert.deepEqual(notes(swap).map((x) => x.role), ["bob"]);
    await set.stopAll();
  } finally {
    await env.cleanup();
  }
});

test("a funding sent by hand is refused by the gate until the record exists; then it goes through the same gate", async () => {
  const env = makeEnv();
  try {
    const sw = prepared(env, "alice");
    env.writeTick(sw, "alice", F.spendTick("fund_noid"));
    env.writeLoop(sw, "alice");
    env.steps.results.walletStatus = { code: 0, stdout: statusText("alice"), stderr: "", files: [] };
    env.steps.results.walletFund = (ctx, o) => {
      if (o.dryRun) return { code: 0, stdout: fundDry(), stderr: "", files: [] };
      fs.writeFileSync(path.join(ctx.runDir, "wallet-funded.marker"), `2026-11-17T10:00:00Z\ntxid ${WTX}\n`);
      return { code: 0, stdout: fundSent(), stderr: "", files: ["wallet-funded.marker"] };
    };
    const { srv, api } = await env.start();
    const swap = srv.swapSet.get(sw.id);
    srv.swapSet.tick();
    await idle(swap.runner);
    let r = await api("POST", "/api/action", { swap: sw.id, id: "dry-fund" });
    assert.equal(r.status, 202, JSON.stringify(r.body));
    await idle(swap.runner);
    const view = (await api("GET", `/api/run?swap=${sw.id}`)).body.actions.spends["send-fund"];
    assert.ok(view.reasons.some((x) => x.code === "line_match_missing" && x.text === WORDS), "the page's own preview shows it");
    assert.equal(view.eligible, false);
    r = await api("POST", "/api/spend", { swap: sw.id, id: "send-fund", typed: view.expected_typed, bob_check_matches: true });
    assert.equal(r.status, 422);
    assert.ok(r.body.reasons.some((x) => x.code === "line_match_missing"));
    assert.equal(env.steps.calls.filter((c) => c.name === "walletFund" && c.args[0].dryRun === false).length, 0, "nothing was sent");
    assert.ok(swap.audit.all().some((l) => l.action === "send-fund" && l.phase === "refused" && /line_match_missing/.test(l.result)));
    // the record
    assert.equal((await post(api, sw, { matches: true, hex: HEX })).status, 200);
    r = await api("POST", "/api/spend", { swap: sw.id, id: "send-fund", typed: view.expected_typed, bob_check_matches: true });
    assert.equal(r.status, 202, JSON.stringify(r.body));
    await idle(swap.runner);
    assert.equal(env.steps.calls.filter((c) => c.name === "walletFund" && c.args[0].dryRun === false).length, 1);
  } finally {
    await env.cleanup();
  }
});

test("an approval that is in force does not let the autopilot start a funding whose line match record is gone", async () => {
  const env = makeEnv();
  try {
    const sw = prepared(env, "alice");
    env.writeTick(sw, "alice", F.spendTick("fund_noid"));
    const set = mk(env);
    const swap = set.get(sw.id);
    swap.runner.confirmCheckLine({ matches: true, hex: HEX });
    swap.autopilot.turnOn("alice", TYPED_ALICE, ALICE_STATEMENTS);
    fs.rmSync(path.join(sw.dir, MATCH_FILE));
    assert.throws(
      () => swap.runner.startSpend("send-fund", null, { auto: swap.autopilot.token }),
      (e) => e.status === 422 && e.reasons.some((r) => r.code === "line_match_missing"),
    );
    assert.equal(env.steps.calls.filter((c) => c.name === "walletFund").length, 0);
    await set.stopAll();
  } finally {
    await env.cleanup();
  }
});

test("the gate: the rule needs its flag (a terminal console and a board run give none), and applies to the funding and the lock only", () => {
  const ctx = (o = {}) => ({ run: { terms: F.TERMS, roles: {} }, nowMs: Date.now(), dry: null, expectedDryCommand: "x", requireTyped: false, ...o });
  const has = (spend, o) => evaluateSpend(spend, ctx(o)).reasons.some((r) => r.code === "line_match_missing");
  for (const id of ["send-fund", "send-lock"]) {
    assert.equal(has(SPENDS[id], {}), false, `${id}: no flag, no rule`);
    assert.equal(has(SPENDS[id], { lineMatchRequired: true, lineMatch: false }), true, id);
    assert.equal(has(SPENDS[id], { lineMatchRequired: true, lineMatch: true }), false, id);
    assert.equal(has(SPENDS[id], { lineMatchRequired: true, lineMatch: false, board: { on: true, facts: null } }), false, `${id}: a board run compares the digest itself`);
    assert.equal(has(SPENDS[id], { lineMatchRequired: false, lineMatch: false }), false, id);
  }
  for (const id of ["send-reveal", "send-claim", "send-refund-eth"]) assert.equal(has(SPENDS[id], { lineMatchRequired: true, lineMatch: false }), false, `${id}: only a funding and a lock wait for the line match`);
  assert.equal(LINE_MATCH_MISSING, WORDS);
});

test("a board run's swap gets none of it: no match is asked and the payload has no record", async () => {
  const env = makeEnv();
  try {
    const sw = prepared(env, "alice");
    fs.writeFileSync(path.join(sw.dir, "run.json"), fs.readFileSync(path.join(sw.dir, "run.json"), "utf8").replace('"handover": null', '"handover": "board"'));
    const set = mk(env);
    const swap = set.get(sw.id);
    assert.equal(swap.runner.boardRun().on, true);
    assert.deepEqual(swap.runner.programGateCtx(SPENDS["send-fund"]), {});
    assert.deepEqual(swap.runner.view(null).spends["send-lock"].statements_needed, []);
    await set.stopAll();
  } finally {
    await env.cleanup();
  }
});

test("confirmLineMatch writes once (wx): a second write for the same folder is an error, the file stays", async () => {
  const env = makeEnv();
  try {
    const sw = env.addSwap({ role: "alice" });
    const rec = confirmLineMatch(sw.dir, "alice", HEX, 1_800_000_123_000);
    assert.deepEqual(rec, { v: 1, role: "alice", hex: HEX, at: 1_800_000_123 });
    assert.throws(() => confirmLineMatch(sw.dir, "alice", OTHER, 1_800_000_999_000), (e) => e.code === "EEXIST");
    assert.equal(readLineMatch(sw.dir).hex, HEX);
    assert.equal(fs.readFileSync(path.join(sw.dir, MATCH_FILE), "utf8"), `{"v":1,"role":"alice","hex":"${HEX}","at":1800000123}\n`);
    assert.equal(CHECK_FILE, "check-line.json");
    void runsettings;
  } finally {
    await env.cleanup();
  }
});
