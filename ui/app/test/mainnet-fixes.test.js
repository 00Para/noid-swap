"use strict";
// (Fix round 2 changes: S1 reads only while a lock intent is pending, L2 the acknowledgement once per round, L4 the cap bounds, L8 create-only rules.)
// Fix round 1 after the independent review of the mainnet opening: M1 (a stuck reveal or ETH refund is re-sent at a new, higher fee cap typed by the person), S1 (no producer latch from Bob's
// ticks before his lock while his approval is off), L1 (loopback is http:// only), L2 (the statement names the 65 % ceiling), L3 (a mainnet tip limit), L8 (call sites, the approval of Bob on
// production through Autopilot.turnOn).
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const rs = require("../lib/runsettings");
const programsettings = require("../lib/programsettings");
const C = require("../lib/steps/common");
const steps = require("../lib/steps");
const { createWatch, loopLine } = require("../lib/steps/watch");
const { ActionRunner } = require("../lib/actions");
const { handleActionPost } = require("../lib/actionroutes");
const { createStepExecutor, lockEverSentIn } = require("../lib/stepexec");
const { createRunJsonSource } = require("../lib/settingsource");
const { AuditLog } = require("../lib/audit");
const { BY_ID } = require("../lib/actions");
const { SwapSet } = require("../lib/swapset");
const { Autopilot, STATEMENTS } = require("../lib/autopilot");
const { makeEnv } = require("./program-harness");
const { makeHarness } = require("./steps-fixtures/harness");
const { KEY_CANARY, SECRET_CANARY } = require("./steps-fixtures/rules");
const SF = require("./steps-fixtures/spend-fixtures");
const { WNA } = require("./wallet-harness");
const F = require("./actions-fixtures");

const E = (c) => "0x" + c.repeat(40);
const TX = "0x" + "ab".repeat(32);
const MAIN = { profile: "production", chain_id: 1, contract_version: 1, gas_price_gwei: "1", priority_fee_gwei: "0.05", eth_rpc2: "https://rpc.mevblocker.io" };

// ---------------------------------------------------------------- L1, L2, L3

test("L1: a node address counts as this machine's own only when it is written with http:// (swap-cli's rule)", () => {
  assert.equal(rs.isLoopbackUrl("http://127.0.0.1:9601"), true);
  assert.equal(rs.isLoopbackUrl("http://[::1]:9601"), true);
  assert.equal(rs.isLoopbackUrl("http://localhost:9601"), false, "a name goes through the hosts file: not a proof of loopback");
  assert.equal(rs.isLoopbackUrl("https://localhost:9601"), false);
  assert.equal(rs.isLoopbackUrl("https://127.0.0.1:9601"), false);
  assert.equal(rs.isLoopbackUrl("http://evil.example"), false);
  assert.equal(rs.isLoopbackUrl(null), false);
  // so a Bob production run.json with an https loopback node and no second node is refused by the schema (swap-cli would refuse it later)
  const bob = { v: 1, run_id: "0123456789abcdef0123456789abcdef", role: "bob", profile: "production", chain_id: 1, contract: E("1"), lock_kind: "poseidon", variant: "raw", contract_version: 1, amount_micronoid: "5000000", amount_wei: "1000000000000000", alice_noid: null, bob_noid: "o1myesz750uxepkx3hfekln7pp7h0f7prn2lu5taswn940g3mws0yqedcswg", alice_eth: null, bob_eth: null, noid_payout: null, eth_payout: E("4"), noid_rpc: "https://localhost:9601", noid_rpc2: null, noid_rpc2_remote: false, eth_rpc2_remote: false, single_node_ok: false, eth_rpc: "https://ethereum-rpc.publicnode.com", eth_rpc2: "https://rpc.mevblocker.io", rpc_timeout_s: 60, gas_price_gwei: "1", priority_fee_gwei: "0.05", deploy_block: null, eth_start_margin: 2400, hc_lead: 50, lock_precheck_timeout_s: null, handover: null, alert_url: null };
  assert.ok(rs.validate(bob).some((p) => p.startsWith("noid_rpc2")));
  assert.deepEqual(rs.validate({ ...bob, noid_rpc: "http://127.0.0.1:9601" }), []);
});

test("L2: Bob's statement says he read the producer warning and accepts the risk (the share warns, it never refuses)", () => {
  assert.equal(STATEMENTS.producer_share_ack, "I read the producer warning. {SHARE} If the miner behind Alice holds most of the blocks, no time window protects my ETH and she can take both sides. I accept that risk for this swap.");
});

test("L3: on mainnet the tip is at most 2 gwei and at most the cap, in the schema and in the form; a test network keeps its own rules", async () => {
  const base = { v: 1, run_id: "0123456789abcdef0123456789abcdef", role: "alice", profile: "production", chain_id: 1, contract: E("1"), lock_kind: "poseidon", variant: "raw", contract_version: 1, amount_micronoid: "5000000", amount_wei: "1000000000000000", alice_noid: null, bob_noid: "o1lqvrmvsyl7mkt3cptkz3c965ujt5ce6mjawxwwxe7mgn36mjzt8sn69xw2", alice_eth: null, bob_eth: E("2"), noid_payout: "o125qayvgtmvqnlhqmqwe08dza3acaax5mct3u5h4uen3qtrds3jfset7wlk", eth_payout: E("4"), noid_rpc: "http://127.0.0.1:9601", noid_rpc2: null, noid_rpc2_remote: false, eth_rpc2_remote: false, single_node_ok: false, eth_rpc: "https://ethereum-rpc.publicnode.com", eth_rpc2: "https://rpc.mevblocker.io", rpc_timeout_s: 60, gas_price_gwei: "50", priority_fee_gwei: "2", deploy_block: null, eth_start_margin: 2400, hc_lead: 50, lock_precheck_timeout_s: null, handover: null, alert_url: null };
  assert.deepEqual(rs.validate(base, { create: true }), [], "2 gwei is the limit");
  // (fix round 2, L8) the mainnet tip limit is checked when a swap is made, not when its run.json is loaded
  assert.deepEqual(rs.validate({ ...base, priority_fee_gwei: "50" }), [], "a loaded file with a larger tip still loads");
  const keys = (o) => rs.validate({ ...base, ...o }, { create: true }).map((p) => p.split(":")[0]);
  assert.deepEqual(keys({ priority_fee_gwei: "2.000000001" }), ["priority_fee_gwei"]);
  assert.deepEqual(keys({ priority_fee_gwei: "50" }), ["priority_fee_gwei"], "a tip typed 50 for 0.05, under a cap of 50");
  assert.deepEqual(keys({ gas_price_gwei: "1", priority_fee_gwei: "1.5" }), ["priority_fee_gwei"], "above the cap");
  assert.match(rs.validate({ ...base, priority_fee_gwei: "50" }, { create: true })[0], /at most 2 gwei on Ethereum mainnet/);
  // a Sepolia file keeps the old rule (the tip up to the cap)
  assert.deepEqual(rs.validate({ ...base, profile: "sepolia", chain_id: 11155111, eth_rpc2: null, gas_price_gwei: "50", priority_fee_gwei: "40" }), []);
  // the form
  const env = makeEnv();
  try {
    const set = new SwapSet({ program: env.program, deps: env.deps() });
    const FORM = (o = {}) => ({ role: "alice", profile: "production", contract_version: 1, noid_amount: "5", eth_amount: "0.001", contract: E("1"), bob_noid: base.bob_noid, bob_eth: E("2"), noid_payout: base.noid_payout, eth_payout: E("4"), single_node_ok: false, ...o });
    const ps = programsettings.defaults();
    assert.equal(set.validateForm(FORM(), ps).ok, true, "the defaults pass");
    assert.match(set.validateForm(FORM({ gas_price_gwei: "50", priority_fee_gwei: "50" }), ps).errors.priority_fee_gwei, /at most 2 gwei on Ethereum mainnet/);
    assert.match(set.validateForm(FORM({ gas_price_gwei: "1", priority_fee_gwei: "1.5" }), ps).errors.priority_fee_gwei, /cannot be above the fee cap/);
    assert.equal(set.validateForm(FORM({ gas_price_gwei: "50", priority_fee_gwei: "2" }), ps).ok, true);
    // a test network: no such limit
    assert.equal(set.validateForm(FORM({ profile: "sepolia", gas_price_gwei: "50", priority_fee_gwei: "40" }), ps).ok, true);
  } finally {
    await env.cleanup();
  }
});

test("L8 (fix round 2): the loopback-only http:// rule, the mainnet tip limit and the mainnet cap limit apply when a swap is made, never when its run.json is loaded", () => {
  const alice = { v: 1, run_id: "0123456789abcdef0123456789abcdef", role: "alice", profile: "production", chain_id: 1, contract: E("1"), lock_kind: "poseidon", variant: "raw", contract_version: 1, amount_micronoid: "5000000", amount_wei: "1000000000000000", alice_noid: null, bob_noid: "o1lqvrmvsyl7mkt3cptkz3c965ujt5ce6mjawxwwxe7mgn36mjzt8sn69xw2", alice_eth: null, bob_eth: E("2"), noid_payout: "o125qayvgtmvqnlhqmqwe08dza3acaax5mct3u5h4uen3qtrds3jfset7wlk", eth_payout: E("4"), noid_rpc: "http://127.0.0.1:9601", noid_rpc2: null, noid_rpc2_remote: false, eth_rpc2_remote: false, single_node_ok: false, eth_rpc: "https://ethereum-rpc.publicnode.com", eth_rpc2: "https://rpc.mevblocker.io", rpc_timeout_s: 60, gas_price_gwei: "1", priority_fee_gwei: "0.05", deploy_block: null, eth_start_margin: 2400, hc_lead: 50, lock_precheck_timeout_s: null, handover: null, alert_url: null };
  const create = (o) => rs.validate({ ...alice, ...o }, { create: true });
  const load = (o) => rs.validate({ ...alice, ...o });
  // a node on another host written with http://
  const remote = { noid_rpc: "http://203.0.113.7:9601", noid_rpc2: "http://203.0.113.8:9601" };
  assert.ok(create(remote).some((x) => x.startsWith("noid_rpc")), "refused when a swap is made");
  assert.deepEqual(load(remote), [], "a file that passed before the rule still loads");
  assert.deepEqual(load({ eth_rpc: "http://eth.example:8545" }), [], "any host over http at load");
  assert.ok(create({ eth_rpc: "http://eth.example:8545" }).some((x) => x.startsWith("eth_rpc")));
  // the cap limit of a new mainnet swap
  assert.deepEqual(create({ gas_price_gwei: "100" }), []);
  assert.deepEqual(create({ gas_price_gwei: "100.000000001", priority_fee_gwei: "0.05" }).map((x) => x.split(":")[0]), ["gas_price_gwei"]);
  assert.match(create({ gas_price_gwei: "300" })[0], /at most 100 gwei for a new swap on Ethereum mainnet/);
  assert.deepEqual(load({ gas_price_gwei: "300" }), [], "a loaded file keeps the schema's own limit (1000)");
  assert.deepEqual(load({ gas_price_gwei: "1000" }), []);
  assert.ok(load({ gas_price_gwei: "1001" }).length > 0);
  // a test network has no such limits at create either
  assert.deepEqual(rs.validate({ ...alice, profile: "sepolia", chain_id: 11155111, eth_rpc2: null, gas_price_gwei: "300", priority_fee_gwei: "50" }, { create: true }), []);
  // newSettings and write (create) apply the create rules; load applies the load rules
  const fields = { ...alice };
  delete fields.v;
  delete fields.run_id;
  assert.throws(() => rs.newSettings({ ...fields, gas_price_gwei: "300" }), /gas_price_gwei: at most 100 gwei/);
  assert.throws(() => rs.newSettings({ ...fields, noid_rpc: "http://203.0.113.7:9601" }), /noid_rpc/);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "l8-"));
  try {
    const old = { ...alice, gas_price_gwei: "300", priority_fee_gwei: "50", noid_rpc: "http://203.0.113.7:9601", noid_rpc2: "http://203.0.113.8:9601" };
    fs.writeFileSync(path.join(dir, "run.json"), JSON.stringify(old));
    const loaded = rs.load(dir);
    assert.equal(loaded.gas_price_gwei, "300", "an older production run.json can still be opened (refund and sweep stay possible)");
    assert.equal(rs.canonicalBytes(loaded).length > 0, true, "and its approval bytes can still be made");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("L8 (fix round 2): the new swap form says why a mainnet cap above 100 gwei is refused, and a test network is not limited", async () => {
  const env = makeEnv();
  try {
    const set = new SwapSet({ program: env.program, deps: env.deps() });
    const FORM = (o = {}) => ({ role: "alice", profile: "production", contract_version: 1, noid_amount: "5", eth_amount: "0.001", contract: E("1"), bob_noid: "o1lqvrmvsyl7mkt3cptkz3c965ujt5ce6mjawxwwxe7mgn36mjzt8sn69xw2", bob_eth: E("2"), noid_payout: "o125qayvgtmvqnlhqmqwe08dza3acaax5mct3u5h4uen3qtrds3jfset7wlk", eth_payout: E("4"), single_node_ok: false, ...o });
    const ps = programsettings.defaults();
    assert.equal(set.validateForm(FORM({ gas_price_gwei: "100" }), ps).ok, true);
    assert.match(set.validateForm(FORM({ gas_price_gwei: "101" }), ps).errors.gas_price_gwei, /at most 100 gwei for a new swap on Ethereum mainnet/);
    assert.equal(set.validateForm(FORM({ profile: "sepolia", gas_price_gwei: "300" }), ps).ok, true);
  } finally {
    await env.cleanup();
  }
});

// ---------------------------------------------------------------- M1: the new fee cap of a re-send

const REPLACE_IDS = ["dry-reveal-replace", "send-reveal-replace", "dry-refund-eth-replace", "send-refund-eth-replace"];
const fakeRunner = (settings, programMode = true) => ({ programMode, settingsSource: { load: () => (settings ? { ok: true, settings } : { ok: false, why: "x" }) } });
const capOf = (self, id, raw) => ActionRunner.prototype.newCapFor.call(self, id, raw);
const refused = (fn, status, re) => assert.throws(fn, (e) => e.status === status && re.test(e.message), re.toString());

test("M1: the new fee cap is required for the four re-send ids and refused for every other id and in the terminal console", () => {
  const self = fakeRunner({ profile: "production", gas_price_gwei: "1" });
  for (const id of REPLACE_IDS) {
    refused(() => capOf(self, id, undefined), 400, /needs a new fee cap/);
    refused(() => capOf(self, id, null), 400, /needs a new fee cap/);
    assert.deepEqual(capOf(self, id, "2"), { cap: "2", approved: "1" });
  }
  for (const id of ["send-lock", "send-reveal", "send-claim", "send-refund-eth", "dry-reveal", "tick-bob", "setup", "send-sweep-eth-alice"]) {
    refused(() => capOf(self, id, "2"), 400, /only to a re-send/);
    assert.equal(capOf(self, id, undefined), null, id);
  }
  const terminal = fakeRunner({ profile: "production", gas_price_gwei: "1" }, false);
  for (const id of [...REPLACE_IDS, "send-lock"]) {
    refused(() => capOf(terminal, id, "2"), 400, /terminal console/);
    assert.equal(capOf(terminal, id, undefined), null, `${id}: the terminal console re-sends with the helper's own fee`);
  }
});

test("M1 and L4: the bounds are the server's: strictly above the approved cap, no multiple of it, at most 300 gwei on mainnet and 1000 on a test network, a plain decimal only", () => {
  const main = fakeRunner({ profile: "production", gas_price_gwei: "1" });
  refused(() => capOf(main, "send-reveal-replace", "1"), 422, /above the approved cap of 1 gwei/);
  refused(() => capOf(main, "send-reveal-replace", "0.5"), 422, /above the approved cap/);
  refused(() => capOf(main, "send-reveal-replace", "1.0"), 422, /above the approved cap/, "equal in value");
  assert.equal(capOf(main, "send-reveal-replace", "1.000000001").cap, "1.000000001");
  // L4: no multiple of the approved cap (a high cap costs only the balance the key must hold)
  assert.equal(capOf(main, "send-reveal-replace", "20").cap, "20");
  assert.equal(capOf(main, "send-reveal-replace", "21").cap, "21");
  assert.equal(capOf(main, "send-reveal-replace", "300").cap, "300");
  refused(() => capOf(main, "send-reveal-replace", "300.000000001"), 422, /at most 300 gwei on Ethereum mainnet/);
  const big = fakeRunner({ profile: "production", gas_price_gwei: "100" });
  assert.equal(capOf(big, "send-refund-eth-replace", "100.000000001").cap, "100.000000001", "an approved cap of 100 still has room above it");
  assert.equal(capOf(big, "send-refund-eth-replace", "300").cap, "300");
  refused(() => capOf(big, "send-refund-eth-replace", "301"), 422, /at most 300 gwei on Ethereum mainnet/);
  // a test network: up to 1000 gwei
  const test1 = fakeRunner({ profile: "sepolia", gas_price_gwei: "100" });
  assert.equal(capOf(test1, "send-reveal-replace", "1000").cap, "1000");
  refused(() => capOf(test1, "send-reveal-replace", "1001"), 422, /at most 1000 gwei on a test network/);
  // a test run with no cap: only the ceiling
  const none = fakeRunner({ profile: "sepolia", gas_price_gwei: null });
  assert.deepEqual(capOf(none, "send-reveal-replace", "30"), { cap: "30", approved: null });
  refused(() => capOf(none, "send-reveal-replace", "1001"), 422, /at most 1000 gwei/);
  // malformed text is a 400, never a number
  for (const bad of ["", " ", "abc", "1e3", "-2", "0", "0.0", "2 gwei", "1,5", "0x10", "2.1234567891", "99999", ".5", "NaN"]) refused(() => capOf(main, "send-reveal-replace", bad), 400, /decimal in gwei/);
  refused(() => capOf(main, "send-reveal-replace", 2), 400, /decimal in gwei/);
  refused(() => capOf(fakeRunner(null), "send-reveal-replace", "2"), 409, /run\.json cannot be used/);
});

test("M1: the page's limits (view) are the same numbers: the approved cap, the lowest not allowed, the highest", () => {
  const lim = (s) => ActionRunner.prototype.newCapLimits.call(fakeRunner(s));
  assert.deepEqual(lim({ profile: "production", gas_price_gwei: "1" }), { approved_gwei: "1", min_exclusive_gwei: "1", max_gwei: "300" });
  assert.deepEqual(lim({ profile: "production", gas_price_gwei: "10" }), { approved_gwei: "10", min_exclusive_gwei: "10", max_gwei: "300" });
  assert.deepEqual(lim({ profile: "production", gas_price_gwei: "0.05" }), { approved_gwei: "0.05", min_exclusive_gwei: "0.05", max_gwei: "300" });
  assert.deepEqual(lim({ profile: "sepolia", gas_price_gwei: "100" }), { approved_gwei: "100", min_exclusive_gwei: "100", max_gwei: "1000" });
  assert.deepEqual(lim({ profile: "sepolia", gas_price_gwei: null }), { approved_gwei: null, min_exclusive_gwei: null, max_gwei: "1000" });
  assert.equal(lim(null), null);
});

test("M1: the command that binds a dry run carries the cap, so a dry run at one cap never matches a send at another", () => {
  const self = { programMode: true };
  const cmd = (id, tx, extra) => ActionRunner.prototype.command.call(self, id, tx, extra).display;
  assert.equal(cmd("dry-reveal-replace", TX), `step dry-reveal-replace replacing ${TX}`);
  assert.equal(cmd("dry-reveal-replace", TX, { newCap: "3" }), `step dry-reveal-replace replacing ${TX} at fee cap 3 gwei`);
  assert.notEqual(cmd("dry-reveal-replace", TX, { newCap: "3" }), cmd("dry-reveal-replace", TX, { newCap: "4" }));
  assert.equal(cmd("send-lock", null, {}), "step send-lock");
  assert.throws(() => cmd("dry-reveal-replace", TX, { newCap: "3; rm" }), /decimal in gwei/);
});

test("M1: the two routes pass new_cap_gwei as text only; a number or an object is a 400 before anything runs", () => {
  const seen = [];
  const actions = {
    startAction: (id, meta) => (seen.push(["action", id, meta]), { job: 1 }),
    startSpend: (id, typed, meta) => (seen.push(["spend", id, typed, meta]), { job: 2 }),
  };
  handleActionPost("/api/action", { id: "dry-reveal-replace", new_cap_gwei: "3" }, { actions, runDir: "x", startMeta: { host: "h" } });
  assert.deepEqual(seen[0], ["action", "dry-reveal-replace", { host: "h", newCapGwei: "3" }]);
  handleActionPost("/api/spend", { id: "send-reveal-replace", typed: "0.001 ETH", new_cap_gwei: "3" }, { actions, runDir: "x" });
  assert.equal(seen[1][3].newCapGwei, "3");
  handleActionPost("/api/spend", { id: "send-lock", typed: "0.001 ETH" }, { actions, runDir: "x" });
  assert.equal("newCapGwei" in seen[2][3], false, "no field, no key");
  for (const v of [3, { a: 1 }, true, ["3"]]) {
    assert.throws(() => handleActionPost("/api/action", { id: "dry-reveal-replace", new_cap_gwei: v }, { actions, runDir: "x" }), (e) => e.status === 400);
    assert.throws(() => handleActionPost("/api/spend", { id: "send-reveal-replace", typed: "x", new_cap_gwei: v }, { actions, runDir: "x" }), (e) => e.status === 400);
  }
  assert.equal(seen.length, 3);
});

/** An executor over a swap of the program harness; the stub step records the settings it was given. */
function execOf(env, role, settings) {
  const sw = env.addSwap({ role, settings });
  const source = createRunJsonSource({ dir: sw.dir });
  const audit = new AuditLog(sw.pub, { role });
  const executor = createStepExecutor({ program: env.program, swap: { id: sw.id, dir: sw.dir, settingsSource: source, audit }, steps: env.steps });
  return { sw, executor, audit };
}

test("M1: the executor gives the step the new cap for a re-send only, passes it as --max-fee-gwei on mainnet, and never writes run.json", async () => {
  const env = makeEnv();
  try {
    const seen = [];
    const record = (ctx, o) => (seen.push({ settings: { gas_price_gwei: ctx.settings.gas_price_gwei, priority_fee_gwei: ctx.settings.priority_fee_gwei, profile: ctx.settings.profile }, opts: o, flags: C.feeFlags(ctx.settings) }), { code: 0, stdout: "", stderr: "", files: [] });
    env.steps.results.reveal = record;
    env.steps.results.refundEth = record;
    env.steps.results.claim = (ctx) => record(ctx, {});
    const a = execOf(env, "alice", MAIN);
    const before = fs.readFileSync(path.join(a.sw.dir, "run.json"));
    await a.executor.run(BY_ID.get("send-reveal-replace"), { tx: TX, newCap: "3" });
    await a.executor.run(BY_ID.get("dry-reveal-replace"), { tx: TX, newCap: "3.5" });
    await a.executor.run(BY_ID.get("send-reveal"), {});
    assert.deepEqual(seen[0].flags, ["--mainnet", "--max-fee-gwei", "3", "--priority-fee-gwei", "0.05"]);
    assert.deepEqual(seen[1].flags, ["--mainnet", "--max-fee-gwei", "3.5", "--priority-fee-gwei", "0.05"]);
    assert.deepEqual(seen[2].flags, ["--mainnet", "--max-fee-gwei", "1", "--priority-fee-gwei", "0.05"], "the first send keeps the approved cap");
    assert.equal(seen[0].opts.replace, TX);
    assert.ok(Buffer.from(before).equals(fs.readFileSync(path.join(a.sw.dir, "run.json"))), "run.json bytes unchanged");
    assert.equal(JSON.parse(fs.readFileSync(path.join(a.sw.dir, "run.json"), "utf8")).gas_price_gwei, "1");
    // the refund of Bob; and a test network gets --gas-price-gwei with the new value
    const b = execOf(env, "bob", { profile: "sepolia", gas_price_gwei: "2" });
    await b.executor.run(BY_ID.get("send-refund-eth-replace"), { tx: TX, newCap: "9" });
    assert.deepEqual(seen[3].flags, ["--gas-price-gwei", "9"]);
    // a new cap on any other id is refused before a step runs
    const n = seen.length;
    const r = await a.executor.run(BY_ID.get("send-reveal"), { newCap: "3" });
    assert.equal(r.refused, true);
    const r2 = await a.executor.run(BY_ID.get("send-reveal-replace"), { tx: TX, newCap: "3; x" });
    assert.equal(r2.refused, true);
    assert.equal(seen.length, n);
    await Promise.resolve();
  } finally {
    await env.cleanup();
  }
});

/** A swap of the program harness at a held reveal with a pending claim, behind a real SwapSet: the route-level view of M1. */
function aliceRevealSwap(env, settings) {
  const sw = env.addSwap({ role: "alice", settings });
  env.writeTerms(sw, { aliceNoid: WNA });
  env.swapFile(sw, "alice");
  env.writeLineMatch(sw, "alice");
  const chain = settings && settings.chain_id ? settings.chain_id : undefined;
  env.writeTick(sw, "alice", F.spendTick("reveal_eth", { held: true, eth: { pending_preimage: { lock_id: F.LOCK_ID, tx_hash: TX } }, mutate: (t) => { if (chain) { t.eth.chain_id = chain; t.swap_terms.eth.chain_id = chain; } } }));
  env.writeLoop(sw, "alice");
  return sw;
}

test("M1: through the runner in program mode a re-send needs the cap, the dry run and the send are bound to it, the audit says both caps, and run.json stays", async () => {
  const env = makeEnv();
  try {
    const flagsSeen = [];
    env.steps.results.reveal = (ctx, a) => {
      flagsSeen.push({ dry: a.dryRun === true, replace: a.replace, flags: C.feeFlags(ctx.settings) });
      if (a.dryRun) {
        fs.writeFileSync(path.join(ctx.runDir, "eth-claim-dry-100001.json"), JSON.stringify(F.revealDry({ replace: true, replacesTx: TX })));
        return { code: 0, stdout: "", stderr: "", files: ["eth-claim-dry-100001.json"] };
      }
      fs.writeFileSync(path.join(ctx.runDir, "eth-claim.json"), JSON.stringify({ txHash: "0x" + "cd".repeat(32), blockNumber: 124 }));
      fs.writeFileSync(path.join(ctx.runDir, "eth-claim.err"), `sent: 0x${"cd".repeat(32)} nonce 2\n`);
      return { code: 0, stdout: "", stderr: "", files: ["eth-claim.json", "eth-claim.err"] };
    };
    const sw = aliceRevealSwap(env, { gas_price_gwei: "2", priority_fee_gwei: "1" });
    const set = new SwapSet({ program: env.program, deps: env.deps() });
    set.scan();
    const swap = set.get(sw.id);
    assert.ok(swap && !swap.readOnly);
    const r = swap.runner;
    const idle = async () => {
      for (let i = 0; i < 200 && r.busy; i++) await new Promise((x) => setTimeout(x, 10));
      assert.equal(r.busy, null);
    };
    const runBefore = fs.readFileSync(path.join(sw.dir, "run.json"));
    // without the cap, with a bad one, and with one at or below the approved cap: refused, nothing runs
    assert.throws(() => r.startAction("dry-reveal-replace"), (e) => e.status === 400 && /new fee cap/.test(e.message));
    assert.throws(() => r.startAction("dry-reveal-replace", { newCapGwei: "2" }), (e) => e.status === 422);
    assert.throws(() => r.startAction("dry-reveal-replace", { newCapGwei: "1001" }), (e) => e.status === 422);
    assert.throws(() => r.startAction("tick-alice", { newCapGwei: "3" }), (e) => e.status === 400);
    assert.equal(env.steps.calls.filter((c) => c.name === "reveal").length, 0);
    // the dry run at 3 gwei
    r.now = () => Date.now() + 2500;
    const job = r.startAction("dry-reveal-replace", { newCapGwei: "3" });
    assert.equal(job.command, `step dry-reveal-replace replacing ${TX} at fee cap 3 gwei`);
    await idle();
    assert.deepEqual(flagsSeen[0], { dry: true, replace: TX, flags: ["--gas-price-gwei", "3", "--priority-fee-gwei", "1"] });
    const start = swap.audit.all().find((x) => x.action === "dry-reveal-replace" && x.phase === "start");
    assert.match(start.detail, /fee cap: approved 2 gwei, new 3 gwei/);
    const view = r.view(r.readRunFn(r.cfg.runDirs, Math.floor(Date.now() / 1000))).spends["send-reveal-replace"];
    assert.deepEqual(view.new_cap, { approved_gwei: "2", min_exclusive_gwei: "2", max_gwei: "1000" });
    assert.equal(view.dry_new_cap_gwei, "3");
    assert.equal(view.dry_command, `step dry-reveal-replace replacing ${TX} at fee cap 3 gwei`);
    // a send at another cap than the dry run's: the gate refuses (the dry run does not match); and without a cap it is a 400
    assert.throws(() => r.startSpend("send-reveal-replace", "0.001 ETH", {}), (e) => e.status === 400);
    assert.throws(() => r.startSpend("send-reveal-replace", "0.001 ETH", { newCapGwei: "4" }), (e) => e.status === 422 && Array.isArray(e.reasons) && e.reasons.length > 0);
    assert.equal(flagsSeen.length, 1, "nothing was sent");
    // a send at the dry run's cap
    const sent = r.startSpend("send-reveal-replace", "0.001 ETH", { newCapGwei: "3" });
    assert.equal(sent.state, "running");
    assert.equal(sent.command, `step send-reveal-replace replacing ${TX} at fee cap 3 gwei`);
    await idle();
    assert.deepEqual(flagsSeen[1], { dry: false, replace: TX, flags: ["--gas-price-gwei", "3", "--priority-fee-gwei", "1"] });
    const sendStart = swap.audit.all().find((x) => x.action === "send-reveal-replace" && x.phase === "start");
    assert.match(sendStart.detail, /fee cap: approved 2 gwei, new 3 gwei/);
    assert.match(sendStart.detail, new RegExp(`replaces ${TX}`));
    assert.ok(Buffer.from(runBefore).equals(fs.readFileSync(path.join(sw.dir, "run.json"))), "run.json is never rewritten");
    await set.stopAll();
  } finally {
    await env.cleanup();
  }
});

test("M1: the autopilot never raises a cap: a re-send with an automatic start is refused", async () => {
  const env = makeEnv();
  try {
    const sw = aliceRevealSwap(env, { gas_price_gwei: "2", priority_fee_gwei: "1" });
    const set = new SwapSet({ program: env.program, deps: env.deps() });
    set.scan();
    const r = set.get(sw.id).runner;
    r.now = () => Date.now() + 2500;
    // meta.auto can only be the autopilot's own object; a re-send with any value there is refused as "autopilot_off" (the replace branch never authorizes)
    assert.throws(() => r.startSpend("send-reveal-replace", "x", { auto: {}, newCapGwei: "3" }), (e) => e.status === 422 || e.status === 409 || e.status === 400);
    await set.stopAll();
  } finally {
    await env.cleanup();
  }
});

// ---------------------------------------------------------------- S1

const prodBob = (o = {}) => ({ profile: "production", role: "bob", gas_price_gwei: "1", priority_fee_gwei: "0.05", ...o });

test("S1: readingOnlyForAck is true only for Bob on production, with no acknowledgement, before his lock, with a lock intent pending and no lock send ever started", () => {
  const ctx = (settings, ack) => ({ settings, producerAck: ack });
  const none = () => null;
  const yes = () => 650;
  const R = (c, role, phase, sent, pending) => C.readingOnlyForAck(c, role, phase, sent, pending);
  for (const phase of [null, undefined, "received", "funded", "funding_final"]) assert.equal(R(ctx(prodBob(), none), "bob", phase, false, true), true, String(phase));
  // fix round 2 (S1): without a held or recorded lock_eth intent the round is NOT read-only, whatever else holds (so Rule W's height abort is recorded as before)
  for (const phase of [null, undefined, "received", "funded", "funding_final"]) assert.equal(R(ctx(prodBob(), none), "bob", phase, false, false), false, `no intent: ${phase}`);
  assert.equal(R(ctx(prodBob(), none), "bob", "funded", false, undefined), false, "an intent state that is not known is no intent");
  assert.equal(R(ctx(prodBob(), yes), "bob", "funded", false, true), false, "the flag is present");
  assert.equal(R(ctx(prodBob(), () => 700), "bob", "funded", false, true), true, "only 650 is the flag");
  assert.equal(R(ctx(prodBob(), none), "bob", "funded", true, true), false, "a lock send was started");
  for (const phase of ["lock_submitted", "locked", "secret_seen", "claim_submitted", "refund_submitted", "done", "aborted"]) assert.equal(R(ctx(prodBob(), none), "bob", phase, false, true), false, phase);
  assert.equal(R(ctx(prodBob({ role: "alice" }), none), "bob", "funded", false, true), false, "Alice's run");
  assert.equal(R(ctx(prodBob(), none), "alice", "funded", false, true), false, "Alice's tick");
  assert.equal(R(ctx(prodBob({ profile: "sepolia" }), none), "bob", "funded", false, true), false, "a test network");
  assert.equal(R({ settings: null }, "bob", "funded", false, true), false);
  // L2: the flags the round already decided are used; the program is not asked again
  let asked = 0;
  const counting = ctx(prodBob(), () => (asked++, null));
  assert.equal(C.readingOnlyForAck(counting, "bob", "funded", false, true, []), true);
  assert.equal(C.readingOnlyForAck(counting, "bob", "funded", false, true, ["--acknowledge-producer-share", "650"]), false);
  assert.equal(asked, 0, "given flags: no second read of the acknowledgement");
});

test("S1: lockIntentPendingIn reads the tick's intent block: held or recorded, and a lock_eth action only", () => {
  const I = (status, action) => ({ intent: { status, intent: action === undefined ? null : { action } } });
  assert.equal(C.lockIntentPendingIn(I("held", "lock_eth")), true);
  assert.equal(C.lockIntentPendingIn(I("recorded", "lock_eth")), true);
  assert.equal(C.lockIntentPendingIn(I("resolved", "lock_eth")), false, "resolved: the chain shows the effect");
  assert.equal(C.lockIntentPendingIn(I("none")), false);
  assert.equal(C.lockIntentPendingIn(I("held", "reveal_eth")), false);
  assert.equal(C.lockIntentPendingIn(I("held", "refund_eth")), false);
  for (const v of [null, undefined, {}, { intent: null }, { intent: "held" }, { intent: { status: "held" } }, { intent: { status: "held", intent: "lock_eth" } }, [], "x", 3]) assert.equal(C.lockIntentPendingIn(v), false, JSON.stringify(v));
});

test("S1: a send-lock start line counts as a lock send unless a clean 'refused, nothing sent' end line closed it", () => {
  const rec = (phase, result, action = "send-lock") => ({ action, phase, result });
  assert.equal(lockEverSentIn([]), false);
  assert.equal(lockEverSentIn(null), false);
  assert.equal(lockEverSentIn([rec("refused", "refused: autopilot_off")]), false, "a refusal before the start is no send");
  assert.equal(lockEverSentIn([rec("start", "started"), rec("end", "refused, nothing sent (lock exit 3)")]), false);
  assert.equal(lockEverSentIn([rec("start", "started"), rec("end", "ok (exit 0)")]), true);
  assert.equal(lockEverSentIn([rec("start", "started"), rec("end", "failed (exit 1, the transaction may have been sent)")]), true);
  assert.equal(lockEverSentIn([rec("start", "started")]), true, "no end line: a crash in the send");
  assert.equal(lockEverSentIn([rec("start", "started"), rec("end", "refused, nothing sent (x)"), rec("start", "started")]), true, "a later start");
  assert.equal(lockEverSentIn([rec("start", "started", "send-reveal"), rec("end", "ok (exit 0)", "send-reveal")]), false, "other steps do not count");
  assert.equal(lockEverSentIn([null, "x", 3, rec("start", "started"), rec("end", "refused, nothing sent (x)")]), false);
});

/** The real watch loop over a fake tick: what the tick was asked (args) and what the loop line says. */
async function watchRounds(o) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "s1-"));
  try {
    const calls = [];
    const lines = [];
    const settings = o.settings || prodBob();
    const ctx = { runDir: dir, settings, producerAck: () => (asks++, ackFn()), now: () => Date.UTC(2026, 10, 20, 12, 0, 0) };
    if (o.phase) fs.writeFileSync(path.join(dir, "last-tick-bob.json"), JSON.stringify({ phase_after: o.phase, ...(o.intent ? { intent: o.intent } : {}) }));
    let asks = 0;
    const ackFn = o.ack || (() => null);
    let n = 0;
    const w = createWatch(ctx, {
      intervalMs: 1,
      apply: o.apply !== false,
      lockEverSent: o.lockEverSent === undefined ? () => false : o.lockEverSent,
      sleep: () => new Promise((r) => setTimeout(r, 2)),
      tick: async (c, role, opts) => {
        calls.push({ role, args: opts && opts.args ? [...opts.args] : null, observe: !!(opts && opts.observeOnly), ackFlags: opts && opts.ackFlags ? [...opts.ackFlags] : null });
        if (++n >= (o.rounds || 2)) setTimeout(() => w.stop(), 0);
        return { code: 0, stdout: `applied: False phase_after: ${o.phase || "received"}\n`, stderr: `[bob] tick exit 0 at 12:00:00\n`, files: [] };
      },
      onLine: (r, line) => lines.push(line),
      roles: [settings.role],
    });
    await w.start();
    return { calls, lines, asks: () => asks };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const HELD = { status: "held", intent: { action: "lock_eth" } };
const RECORDED = { status: "recorded", intent: { action: "lock_eth" } };

test("S1: Bob's apply loop on production ticks read-only (no --apply) and says so, while his approval is off, his phase is before the lock, a lock intent is held or recorded and no lock was ever started", async () => {
  for (const intent of [HELD, RECORDED]) {
    for (const phase of ["received", "funded", "funding_final"]) {
      const r = await watchRounds({ phase, intent });
      assert.ok(r.calls.length >= 1);
      for (const c of r.calls) assert.deepEqual(c.args, [], `${phase} ${intent.status}: no --apply`);
      for (const l of r.lines) assert.match(l, /\[bob\] tick exit 0 at 12:00:00 Reading only: your approval is off, so nothing is recorded until you approve again\. /);
    }
  }
});

test("S1 (fix round 2): without a pending lock intent the loop applies, as on a test network: Rule W's height abort is recorded and the sweep can be offered", async () => {
  for (const phase of ["received", "funded", "funding_final", null]) {
    const r = await watchRounds({ phase });
    for (const c of r.calls) assert.deepEqual(c.args, ["--apply"], `${phase}: no intent`);
    for (const l of r.lines) assert.ok(!l.includes("Reading only"), phase);
  }
  // an intent that is none or already resolved, or another action's intent
  for (const intent of [{ status: "none", intent: null }, { status: "resolved", intent: { action: "lock_eth" } }, { status: "held", intent: { action: "reveal_eth" } }]) {
    const r = await watchRounds({ phase: "funding_final", intent });
    for (const c of r.calls) assert.deepEqual(c.args, ["--apply"], JSON.stringify(intent));
  }
});

test("S1: every other case keeps today's applied ticks and an ordinary loop line (Alice, a test network, the flag present, a lock send ever started, a later phase, a read loop), even with a lock intent held", async () => {
  const keeps = [
    ["the acknowledgement is in force", { phase: "funded", intent: HELD, ack: () => 650 }],
    ["a lock send was started", { phase: "funded", intent: HELD, lockEverSent: () => true }],
    ["the audit cannot be read (counts as started)", { phase: "funded", intent: HELD, lockEverSent: () => true }],
    ["a later phase", { phase: "locked", intent: HELD }],
    ["a later phase (done)", { phase: "done", intent: HELD }],
    ["a test network", { phase: "funded", intent: HELD, settings: prodBob({ profile: "sepolia" }) }],
    ["Alice", { phase: "funded", intent: HELD, settings: prodBob({ role: "alice" }) }],
  ];
  for (const [name, o] of keeps) {
    const r = await watchRounds(o);
    for (const c of r.calls) assert.deepEqual(c.args, ["--apply"], name);
    for (const l of r.lines) assert.ok(!l.includes("Reading only"), name);
  }
  // no hook at all (the old call): applied
  const noHook = await watchRounds({ phase: "funded", intent: HELD, lockEverSent: null });
  for (const c of noHook.calls) assert.deepEqual(c.args, ["--apply"]);
  // a read loop (observe-only ticks) is not changed by this rule
  const read = await watchRounds({ phase: "funded", intent: HELD, apply: false });
  for (const c of read.calls) assert.equal(c.observe, true);
});

test("S1: a lock that was sent, and everything after it, is still recorded: the loop applies once any send-lock was started, whatever the last tick says (intent held, recorded or none)", async () => {
  for (const intent of [HELD, RECORDED, undefined]) {
    for (const phase of ["received", "funded", "funding_final", "lock_submitted", "locked", "secret_seen", "claim_submitted", "refund_submitted"]) {
      const r = await watchRounds({ phase, intent, lockEverSent: () => true });
      for (const c of r.calls) assert.deepEqual(c.args, ["--apply"], `${phase} ${intent && intent.status}`);
    }
  }
});

test("S1: when the last tick cannot be read the loop uses the intent state it last saw", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "s1-mem-"));
  try {
    const ctx = { runDir: dir, settings: prodBob(), producerAck: () => null, now: () => Date.UTC(2026, 10, 20, 12, 0, 0) };
    const file = path.join(dir, "last-tick-bob.json");
    const w = createWatch(ctx, { intervalMs: 1, lockEverSent: () => false, sleep: () => Promise.resolve(), tick: async () => ({ code: 0, stdout: "", stderr: "", files: [] }) });
    assert.equal(w.decideRound(ctx, "bob").readOnly, false, "nothing read yet: no intent known");
    fs.writeFileSync(file, JSON.stringify({ phase_after: "funding_final", intent: HELD }));
    assert.equal(w.decideRound(ctx, "bob").readOnly, true);
    fs.writeFileSync(file, ""); // being written by another tick: unreadable
    assert.equal(w.decideRound(ctx, "bob").readOnly, true, "the remembered held intent still counts");
    fs.writeFileSync(file, JSON.stringify({ phase_after: "funding_final", intent: { status: "none", intent: null } }));
    assert.equal(w.decideRound(ctx, "bob").readOnly, false, "a tick that shows no intent clears it");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("S1 / L2: the acknowledgement is asked once per round and the same flags go to the tick", async () => {
  const held = await watchRounds({ phase: "funded", intent: HELD, rounds: 2 });
  assert.equal(held.asks(), held.calls.length, "one question per round");
  for (const c of held.calls) assert.deepEqual(c.ackFlags, [], "no acknowledgement: the empty list is handed on");
  const withAck = await watchRounds({ phase: "funded", intent: HELD, ack: () => 650, rounds: 3 });
  assert.equal(withAck.asks(), withAck.calls.length, "one question per round, with the acknowledgement too");
  for (const c of withAck.calls) {
    assert.deepEqual(c.args, ["--apply"]);
    assert.deepEqual(c.ackFlags, ["--acknowledge-producer-share", "650"]);
  }
  // an approval removed after the round's decision cannot turn that round's tick into an applied one without the flag: the decision is the round's
  const seq = [650, null];
  let k = 0;
  const flips = await watchRounds({ phase: "funded", intent: HELD, ack: () => seq[Math.min(k++, 1)], rounds: 2 });
  assert.deepEqual(flips.calls[0].ackFlags, ["--acknowledge-producer-share", "650"]);
  assert.deepEqual(flips.calls[0].args, ["--apply"]);
  assert.deepEqual(flips.calls[1].ackFlags, []);
  assert.deepEqual(flips.calls[1].args, [], "the next round reads only");
});

test("S1 / L2: the tick step takes the round's flags: the empty list or the one flag pair, nothing else; without them it asks the program itself", async () => {
  const run = async (ack, opts) => {
    const h = prodHarness("bob", null, ack);
    await steps.tick(h.ctx, "bob", opts);
    return argvOf(h)[0];
  };
  const withFlags = await run(() => null, { ackFlags: ["--acknowledge-producer-share", "650"] });
  assert.ok(withFlags.includes(FLAG), "the round's flags are used as given");
  const emptied = await run(() => 650, { ackFlags: [] });
  assert.ok(!emptied.includes(FLAG), "the round decided there is no acknowledgement: the program is not asked again");
  for (const bad of [["--acknowledge-producer-share", "999"], ["--accept-producer-concentration"], ["--apply"], "x"]) {
    const argv = await run(() => null, { ackFlags: bad });
    assert.ok(!argv.includes(FLAG) && !argv.includes("--accept-producer-concentration") && !argv.includes("999"), `refused: ${JSON.stringify(bad)}`);
  }
  const asked = await run(() => 650, {});
  assert.ok(asked.includes(FLAG), "no flags given: asked as before");
});

test("S1: the loop line keeps the helper's eight parts when nothing was read-only", () => {
  const out = "[bob] tick exit 0 at 12:00:00\nnoid: tip 5\neth : latest 7\nACTION: {\"action\": \"wait\"}\napplied: True phase_after: funded\n";
  assert.ok(!loopLine("12:00:00", out).includes("Reading only"));
  const withNote = loopLine("12:00:00", `${C.READING_ONLY_NOTE}\n${out}`);
  assert.match(withNote, /^12:00:00 \[bob\] tick exit 0 at 12:00:00 Reading only: your approval is off, so nothing is recorded until you approve again\. noid: /);
  assert.match(withNote, /applied: True phase_after: funded$/, "the tail stays last (the page's parser reads it)");
});

test("S1: through the executor, the loop asks the program's own audit: a clean refusal of the lock step keeps the loop reading, a started lock send turns it to applied ticks", async () => {
  const env = makeEnv();
  try {
    const kitCalls = [];
    const { loopKit } = require("./program-harness");
    const kit = loopKit(env, (ctx, role, args) => {
      kitCalls.push(args);
      return { code: 0, stdout: `[${role}] tick exit 0 at 12:00:00\napplied: False phase_after: funded\n`, stderr: "", files: [] };
    }, { pauseMs: 5 });
    const sw = env.addSwap({ role: "bob", settings: { ...MAIN, role: "bob", noid_rpc2: null } });
    const source = createRunJsonSource({ dir: sw.dir });
    const audit = new AuditLog(sw.pub, { role: "bob" });
    const executor = createStepExecutor({ program: env.program, swap: { id: sw.id, dir: sw.dir, settingsSource: source, audit, producerAck: () => null }, steps: kit.steps, watchOpts: kit.watchOpts });
    audit.append({ action: "send-lock", role: "bob", phase: "start", result: "started" });
    audit.append({ action: "send-lock", role: "bob", phase: "end", result: "refused, nothing sent (lock exit 2)" });
    // the last tick shows a held lock intent: the one state in which the round reads only
    fs.writeFileSync(path.join(sw.dir, "last-tick-bob.json"), JSON.stringify({ phase_after: "funding_final", intent: HELD }));
    assert.equal(executor.watchStart({ mode: "apply" }).started, true);
    await kit.next();
    assert.deepEqual(kitCalls[0], [], "read-only: no --apply");
    await executor.watchStop();
    // now a lock send that may have gone out
    audit.append({ action: "send-lock", role: "bob", phase: "start", result: "started" });
    audit.append({ action: "send-lock", role: "bob", phase: "end", result: "failed (exit 1, the transaction may have been sent)" });
    kitCalls.length = 0;
    assert.equal(executor.watchStart({ mode: "apply" }).started, true);
    await kit.next();
    assert.deepEqual(kitCalls[0], ["--apply"]);
    await executor.watchStop();
  } finally {
    await env.cleanup();
  }
});

// ---------------------------------------------------------------- L8: the flag at the call sites, and the approval of Bob on production

const prodHarness = (role, scenario, ack) => {
  const h = makeHarness({ settings: { role, profile: "production", chain_id: 1, gas_price_gwei: "1", priority_fee_gwei: "0.05", eth_rpc2: "https://b.example", noid_rpc: "http://127.0.0.1:9601", noid_rpc2: null, single_node_ok: false } });
  h.swapFile(role);
  h.scenario({ swapCli: { "ethkey emit": { stdout: `${KEY_CANARY}\n` }, secret: { stdout: `${SECRET_CANARY}\n` }, tick: { stdout: SF.tickGo() }, claim: { stdout: "{\n}\n", touch: true }, ...(scenario || {}) }, liveJs: { lock: { stdout: SF.LIVE_OK, stderr: SF.LIVE_SENT_ERR } } });
  h.ctx.producerAck = ack;
  return h;
};
const FLAG = "--acknowledge-producer-share";
const argvOf = (h) => h.calls("swapCli").map((c) => c.argv);

test("L8: at the call sites Bob's tick and his lock step carry the flag with the approval, never without, and the claim never", async () => {
  const withAck = prodHarness("bob", null, () => 650);
  await steps.tick(withAck.ctx, "bob");
  assert.ok(argvOf(withAck)[0].includes(FLAG) && argvOf(withAck)[0][argvOf(withAck)[0].indexOf(FLAG) + 1] === "650", "tick");
  const noAck = prodHarness("bob", null, () => null);
  await steps.tick(noAck.ctx, "bob");
  assert.ok(!argvOf(noAck)[0].includes(FLAG), "tick without the approval");
  // the lock step: its tick (the fresh read-only one) carries the flag
  const lockAck = prodHarness("bob", null, () => 650);
  await steps.lock(lockAck.ctx, {});
  const lockTicks = argvOf(lockAck).filter((a) => a[0] === "tick");
  assert.ok(lockTicks.length >= 1 && lockTicks.every((a) => a.includes(FLAG)), "lock step with the approval");
  const lockNo = prodHarness("bob", null, () => null);
  await steps.lock(lockNo.ctx, {});
  assert.ok(argvOf(lockNo).filter((a) => a[0] === "tick").every((a) => !a.includes(FLAG)), "lock step without the approval");
  // the claim: never, with the approval or without, dry or real
  for (const submit of [false, true]) {
    const h = prodHarness("bob", null, () => 650);
    await steps.claim(h.ctx, { submit });
    const claims = argvOf(h).filter((a) => a[0] === "claim");
    assert.equal(claims.length, 1);
    assert.ok(!claims[0].includes(FLAG), `claim submit=${submit}`);
    assert.ok(!claims[0].includes("--accept-producer-concentration"));
  }
  // and the older waiver is never passed anywhere
  for (const h of [withAck, lockAck]) assert.ok(argvOf(h).every((a) => !a.includes("--accept-producer-concentration")));
});

// Bob's approval on production, through Autopilot.turnOn on a real swap of the program harness

const HEX = "b4271c7f3ea51fe7";
const BOB_STATEMENTS = { stay_on: true, no_manual_steps: true, alice_check_matches: true, producer_share_ack: true };
const nowS = () => Math.floor(Date.now() / 1000);
const producers = (o = {}) => ({ tip: 1000, header_tip: 1000, read_at: nowS() - 5, window_long: 2880, window_short: 720, have: 2880, complete: true, long: { n: 2880, largest: 1520, largest_id: "x", top_two: 2000, distinct: 5 }, short: { n: 720, largest: 360, largest_id: "x", top_two: 500, distinct: 5 }, second: { state: "agrees", height: 990, sampled: 64 }, ...o });

function bobMainnet(env, o = {}) {
  const sw = env.addSwap({ role: "bob", settings: { ...MAIN, role: "bob", noid_rpc2: null, alice_noid: null, bob_noid: "o1lqvrmvsyl7mkt3cptkz3c965ujt5ce6mjawxwwxe7mgn36mjzt8sn69xw2" } });
  env.writeTerms(sw, { aliceNoid: WNA });
  // the public terms name Ethereum mainnet (the program refuses a bundle of another network)
  for (const d of [sw.dir, sw.pub]) {
    const f = path.join(d, "alice.bundle.json");
    const b = JSON.parse(fs.readFileSync(f, "utf8"));
    b.params.profile = "production";
    b.params.eth.chain_id = 1;
    fs.writeFileSync(f, JSON.stringify(b));
  }
  env.swapFile(sw, "bob");
  env.writeLineMatch(sw, "bob", { hex: HEX, match: true });
  env.writeTick(sw, "bob", F.spendTick("lock_eth", { mutate: (t) => { t.eth = { ...(t.eth || {}), chain_id: 1 }; t.swap_terms = { ...(t.swap_terms || {}), eth: { ...((t.swap_terms || {}).eth || {}), chain_id: 1 } }; t.noid.producers = producers({ tip: t.noid.tip, header_tip: t.noid.tip, ...(o.p || {}) }); Object.assign(t.noid, o.noid || {}); } }));
  env.writeLoop(sw, "bob");
  return sw;
}

test("L8: Autopilot.turnOn('bob') on a production swap: refused up front when the tick shows a share the flag cannot waive, refused without the statement, and with it records the share and the audit line", async () => {
  const env = makeEnv();
  try {
    const sw = bobMainnet(env);
    const set = new SwapSet({ program: env.program, deps: env.deps() });
    set.scan();
    const swap = set.get(sw.id);
    assert.ok(swap && !swap.readOnly, "the production swap is opened for action");
    const ap = swap.autopilot;
    assert.ok(ap.mainnetSettings(), "it is a mainnet swap");
    // the statement ids Bob must confirm, and the words with the measured share and the ceiling
    const view = ap.view(swap.runner.readRunFn(swap.runner.cfg.runDirs, nowS())).bob;
    assert.deepEqual(view.statements.map((s) => s.id), ["stay_on", "no_manual_steps", "alice_check_matches", "producer_share_ack"]);
    assert.match(view.statements[3].text, /^I read the producer warning\. One producer mined 52\.8 % of recent Parano1d blocks\. /);
    assert.equal(view.producer_screen.level, "high");
    assert.match(view.producer_screen.warning, /^One producer mined 52\.8 % of recent Parano1d blocks\. A Bob who faces that miner as Alice can lose his ETH: above half of the blocks, no time window protects him\.$/);
    // without the producer statement: refused, the reason names it
    assert.throws(() => ap.turnOn("bob", "0.001 ETH", { ...BOB_STATEMENTS, producer_share_ack: false }), (e) => e.status === 422 && e.reasons.some((r) => r.code === "statement_producer_share_ack" && /read the producer warning/.test(r.text)));
    assert.equal(ap.producerAckPermille(), null, "nothing was approved");
    // with it: approved, the file holds the statement and the share, the audit line names the share
    assert.equal(ap.turnOn("bob", "0.001 ETH", BOB_STATEMENTS).status, 200);
    const file = JSON.parse(fs.readFileSync(path.join(sw.dir, "autopilot-bob.json"), "utf8"));
    assert.deepEqual(file.statements, ["stay_on", "no_manual_steps", "alice_check_matches", "producer_share_ack"]);
    assert.equal(file.producer_share, "52.8");
    const line = swap.audit.all().find((r) => r.action === "autopilot" && r.result === "approval given");
    assert.match(line.detail, /statements=stay_on,no_manual_steps,alice_check_matches,producer_share_ack/);
    assert.match(line.detail, /producer share 52\.8 %/);
    assert.equal(ap.producerAckPermille(), 650, "while the approval is in force the flag is 650");
    // off again: no flag
    ap.turnOff("bob");
    assert.equal(ap.producerAckPermille(), null);
    await set.stopAll();
  } finally {
    await env.cleanup();
  }
});

test("L8: Autopilot.turnOn('bob') on a production swap is refused up front (producer_screen) for a disagreeing second node, never for the share; nothing is written", async () => {
  const cases = [
    ["a second node that disagrees", { p: { second: { state: "differs", height: 9, first: "a", second: "b" } } }, /second node|disagree|differ/i],
  ];
  for (const [name, o, re] of cases) {
    const env = makeEnv();
    try {
      const sw = bobMainnet(env, o);
      const set = new SwapSet({ program: env.program, deps: env.deps() });
      set.scan();
      const swap = set.get(sw.id);
      assert.throws(() => swap.autopilot.turnOn("bob", "0.001 ETH", BOB_STATEMENTS), (e) => e.status === 422 && e.reasons[0].code === "producer_screen" && re.test(e.message), name);
      assert.equal(fs.existsSync(path.join(sw.dir, "autopilot-bob.json")), false, `${name}: no approval file`);
      assert.equal(swap.autopilot.producerAckPermille(), null);
      await set.stopAll();
    } finally {
      await env.cleanup();
    }
  }
});

test("L8: a share of 76 % or an unreadable share is a warning: Bob's approval is allowed after his statement, and the warning is shown", async () => {
  const cases = [
    ["a share of 76 %", { p: { long: { n: 2880, largest: 2190, largest_id: "x", top_two: 2500, distinct: 3 }, short: { n: 720, largest: 547, largest_id: "x", top_two: 600, distinct: 3 } } }, "76", /^One producer mined 76\.\d % of recent Parano1d blocks\. A Bob who faces that miner as Alice can lose his ETH: above half of the blocks, no time window protects him\.$/, "high"],
    ["a stale reading", { p: { read_at: nowS() - 4000 } }, null, /^The share of one producer in recent Parano1d blocks is unknown right now\. /, "unknown"],
    ["an incomplete reading", { p: { complete: false, long: null, short: null, have: 1400 } }, null, /^The share of one producer in recent Parano1d blocks is unknown right now\. /, "unknown"],
  ];
  for (const [name, o, share, warnRe, level] of cases) {
    const env = makeEnv();
    try {
      const sw = bobMainnet(env, o);
      const set = new SwapSet({ program: env.program, deps: env.deps() });
      set.scan();
      const swap = set.get(sw.id);
      const ap = swap.autopilot;
      const view = ap.view(swap.runner.readRunFn(swap.runner.cfg.runDirs, nowS())).bob;
      assert.equal(view.producer_screen.ok, true, name);
      assert.equal(view.producer_screen.level, level, name);
      assert.match(view.producer_screen.warning, warnRe, name);
      assert.match(view.statements[3].text, share ? /^I read the producer warning\. One producer mined 76\.\d % of recent Parano1d blocks\./ : /^I read the producer warning\. The share of one producer in recent Parano1d blocks is unknown right now\./, name);
      // without the statement: refused; with it: approved and the audit line names what he saw
      assert.throws(() => ap.turnOn("bob", "0.001 ETH", { ...BOB_STATEMENTS, producer_share_ack: false }), (e) => e.status === 422 && e.reasons.some((r) => r.code === "statement_producer_share_ack"), name);
      assert.equal(ap.turnOn("bob", "0.001 ETH", BOB_STATEMENTS).status, 200, name);
      const line = swap.audit.all().find((r) => r.action === "autopilot" && r.result === "approval given");
      assert.match(line.detail, share ? /producer share 76\.\d %/ : /producer share unknown/, name);
      assert.equal(ap.producerAckPermille(), 650, name);
      await set.stopAll();
    } finally {
      await env.cleanup();
    }
  }
});

test("L8: the approval of Alice on production needs no producer statement, and the flag is never hers", async () => {
  const env = makeEnv();
  try {
    const sw = env.addSwap({ role: "alice", settings: MAIN });
    env.writeTerms(sw, { aliceNoid: WNA });
    env.swapFile(sw, "alice");
    const set = new SwapSet({ program: env.program, deps: env.deps() });
    set.scan();
    const ap = set.get(sw.id).autopilot;
    assert.deepEqual(ap.view(null).alice.statements.map((s) => s.id), ["stay_on", "no_manual_steps", "bob_check_matches"]);
    assert.equal(ap.producerAckPermille(), null);
    await set.stopAll();
  } finally {
    await env.cleanup();
  }
});

// ---------------------------------------------------------------- L4 (the console's half): the new-swap form's ask for the production fee

test("L4: GET /api/program?want=mainnet-fee tells the program the page asked for the production fee; the plain route and any other value do not", async () => {
  const env = makeEnv();
  try {
    let asked = 0;
    env.program.wantMainnetFee = () => {
      asked++;
    };
    env.addSwap({ role: "alice" });
    const { api } = await env.start();
    assert.equal((await api("GET", "/api/program")).status, 200);
    assert.equal(asked, 0);
    assert.equal((await api("GET", "/api/program?want=something-else")).status, 200);
    assert.equal(asked, 0);
    assert.equal((await api("GET", "/api/program?want=mainnet-fee")).status, 200);
    assert.equal(asked, 1);
    // a program without the call, or one that throws, still answers
    env.program.wantMainnetFee = () => {
      throw new Error("x");
    };
    assert.equal((await api("GET", "/api/program?want=mainnet-fee")).status, 200);
    delete env.program.wantMainnetFee;
    assert.equal((await api("GET", "/api/program?want=mainnet-fee")).status, 200);
  } finally {
    await env.cleanup();
  }
});

test("M1: through the server, a re-send without new_cap_gwei is a 400 and with a bad one a 422, and the field on any other id is a 400", async () => {
  const env = makeEnv();
  try {
    const sw = aliceRevealSwap(env, { gas_price_gwei: "2", priority_fee_gwei: "1" });
    const { api } = await env.start();
    const post = (p, body) => api("POST", p, { swap: sw.id, ...body });
    assert.equal((await post("/api/action", { id: "dry-reveal-replace" })).status, 400);
    assert.equal((await post("/api/action", { id: "dry-reveal-replace", new_cap_gwei: "2" })).status, 422);
    assert.equal((await post("/api/action", { id: "dry-reveal-replace", new_cap_gwei: 3 })).status, 400);
    assert.equal((await post("/api/action", { id: "tick-alice", new_cap_gwei: "3" })).status, 400);
    assert.equal((await post("/api/spend", { id: "send-reveal-replace", typed: "0.001 ETH" })).status, 400);
    assert.equal((await post("/api/spend", { id: "send-reveal-replace", typed: "0.001 ETH", new_cap_gwei: "99999" })).status, 400);
    assert.equal(env.steps.calls.filter((c) => c.name === "reveal").length, 0, "no step ran");
  } finally {
    await env.cleanup();
  }
});
