"use strict";
// Ethereum mainnet in program mode (2026-11-20): the production profile of run.json, its caps and rules, the network-consistency check that replaced "any production refuses",
// the mainnet fee flags of the steps, Bob's acknowledgement and its up-front screen, the settings defaults, the invitation, and what stays refused (the board, the terminal console,
// migration, contract version 2).

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const rs = require("../lib/runsettings");
const form = require("../lib/swapform");
const prod = require("../lib/production");
const C = require("../lib/steps/common");
const ps = require("../lib/programsettings");
const inv = require("../lib/invitation");
const { producerScreen } = require("../lib/producerscreen");
const { Autopilot } = require("../lib/autopilot");
const { BoardHost } = require("../lib/board/host");

const A1 = "o125qayvgtmvqnlhqmqwe08dza3acaax5mct3u5h4uen3qtrds3jfset7wlk";
const A2 = "o1lqvrmvsyl7mkt3cptkz3c965ujt5ce6mjawxwwxe7mgn36mjzt8sn69xw2";
const A3 = "o1myesz750uxepkx3hfekln7pp7h0f7prn2lu5taswn940g3mws0yqedcswg";
const E = (c) => "0x" + c.repeat(40);
const RUN_ID = "0123456789abcdef0123456789abcdef";
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "mainnet-"));

const prodBase = () => ({
  profile: "production", chain_id: 1, contract: E("1"), lock_kind: "poseidon", variant: "raw", contract_version: 1,
  amount_micronoid: "5000000", amount_wei: "1000000000000000",
  noid_rpc: "http://127.0.0.1:9601", noid_rpc2: null, noid_rpc2_remote: false, eth_rpc2_remote: false, single_node_ok: false,
  eth_rpc: "https://ethereum-rpc.publicnode.com", eth_rpc2: "https://rpc.mevblocker.io", rpc_timeout_s: 60,
  gas_price_gwei: "1", priority_fee_gwei: "0.05", deploy_block: null, eth_start_margin: 2400, hc_lead: 50, lock_precheck_timeout_s: null, handover: null, alert_url: null,
});
const aliceP = (o = {}) => ({ v: 1, run_id: RUN_ID, ...prodBase(), role: "alice", alice_noid: null, bob_noid: A2, alice_eth: null, bob_eth: E("2"), noid_payout: A1, eth_payout: E("4"), ...o });
const bobP = (o = {}) => ({ v: 1, run_id: RUN_ID, ...prodBase(), role: "bob", alice_noid: null, bob_noid: A3, alice_eth: null, bob_eth: null, noid_payout: null, eth_payout: E("4"), ...o });
const keys = (o) => rs.validate(o).map((s) => s.split(":")[0]);
const withRunJson = (content) => {
  const d = tmp();
  fs.writeFileSync(path.join(d, "run.json"), content);
  return d;
};

// ---------------------------------------------------------------- run.json

test("run.json: a production file for each role is valid, and at the caps it still is", () => {
  assert.deepEqual(rs.validate(aliceP()), []);
  assert.deepEqual(rs.validate(bobP()), []);
  assert.deepEqual(rs.validate(aliceP({ amount_micronoid: "20000000000", amount_wei: "1000000000000000000" })), []);
});

test("run.json: one above a cap, on either coin, is refused on production", () => {
  assert.deepEqual(keys(aliceP({ amount_micronoid: "20000000001" })), ["amount_micronoid"]);
  assert.deepEqual(keys(aliceP({ amount_wei: "1000000000000000001" })), ["amount_wei"]);
  // the test networks keep their own tiny caps
  assert.deepEqual(keys({ ...aliceP(), profile: "sepolia", chain_id: 11155111, gas_price_gwei: null, priority_fee_gwei: null, amount_micronoid: "20000001" }), ["amount_micronoid"]);
});

test("run.json: production needs chain 1, and chain 1 needs production (no mix)", () => {
  assert.ok(keys(aliceP({ chain_id: 11155111 })).includes("chain_id"));
  assert.ok(keys(aliceP({ chain_id: 31337 })).includes("chain_id"));
  assert.ok(keys({ ...aliceP(), profile: "sepolia", gas_price_gwei: null, priority_fee_gwei: null }).includes("chain_id"));
  assert.ok(keys({ ...aliceP(), profile: "rehearsal", gas_price_gwei: null, priority_fee_gwei: null }).includes("chain_id"));
});

test("run.json: production needs a fee cap, version 1, two Ethereum nodes, no single-node switch, no handover; Bob needs a second Parano1d node unless his own is on this machine", () => {
  assert.ok(keys(aliceP({ gas_price_gwei: null, priority_fee_gwei: null })).includes("gas_price_gwei"));
  assert.ok(keys(aliceP({ contract_version: 2 })).includes("contract_version"));
  assert.ok(keys(aliceP({ eth_rpc2: null })).includes("eth_rpc2"));
  assert.ok(keys(aliceP({ single_node_ok: true })).includes("single_node_ok"));
  assert.ok(keys(aliceP({ handover: "board" })).includes("handover"));
  assert.ok(keys(bobP({ noid_rpc: "https://parano1d.example.net", noid_rpc2: null })).includes("noid_rpc2"));
  assert.deepEqual(rs.validate(bobP({ noid_rpc: "https://parano1d.example.net", noid_rpc2: "https://other.example.net" })), []);
  assert.deepEqual(rs.validate(bobP({ noid_rpc: "http://[::1]:9601" })), []);
});

test("productionReason: a valid production file is acted on, an invalid one that says production is still refused", () => {
  const good = withRunJson(JSON.stringify(aliceP(), null, 2));
  assert.equal(rs.productionReason(good), null);
  const bad = withRunJson(JSON.stringify(aliceP({ amount_micronoid: "20000000001" }), null, 2));
  assert.equal(rs.productionReason(bad), rs.PRODUCTION_TEXT);
  const noCap = withRunJson(JSON.stringify(aliceP({ gas_price_gwei: null, priority_fee_gwei: null }), null, 2));
  assert.equal(rs.productionReason(noCap), rs.PRODUCTION_TEXT);
  const utf16 = withRunJson(Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(JSON.stringify(aliceP()), "utf16le")]));
  assert.equal(rs.productionReason(utf16), rs.PRODUCTION_TEXT);
});

test("migration of an old production env.local.sh stays refused", () => {
  const d = tmp();
  fs.writeFileSync(path.join(d, "env.local.sh"), "USE_SWAP_WALLET='1'\nPROFILE='production'\nCHAIN='1'\nLOCK_KIND='poseidon'\n");
  assert.throws(() => rs.migrateFromEnvLocal(d, { role: "alice" }), /production|CHAIN is 1/);
});

// ---------------------------------------------------------------- the tables

test("the terminal form and the board keep the test table: no production there; program mode has it, with the owner's caps and the mainnet deployment as its pin", () => {
  assert.deepEqual(Object.keys(form.PROFILES), ["sepolia", "rehearsal"]);
  assert.equal(form.PROGRAM_PROFILES.production.chain, 1);
  assert.equal(form.PROGRAM_PROFILES.production.max_noid_micro, 20_000_000_000n);
  assert.equal(form.PROGRAM_PROFILES.production.max_eth_wei, 1_000_000_000_000_000_000n);
  assert.equal(form.pinFor("production", null), null);
  assert.equal(form.programPinFor("production", null), "0x4e364cC86EdBF307CC6F336F3a72e1a24d284D70");
  assert.equal(form.programPinFor("production", { board: { pinned_htlc: { 1: "0x" + "ab".repeat(20) } } }), "0x4e364cC86EdBF307CC6F336F3a72e1a24d284D70", "no setting overrides the mainnet pin");
  assert.equal(form.programPinFor("sepolia", null), form.PINNED_CONTRACT.sepolia);
});

test("program settings: defaults carry the two mainnet endpoints; an old settings.json without eth.production loads with them; the board stays off mainnet", () => {
  const d = ps.defaults();
  assert.equal(d.eth.production.rpc, "https://ethereum-rpc.publicnode.com");
  assert.equal(d.eth.production.rpc2, "https://rpc.mevblocker.io");
  const old = ps.defaults();
  delete old.eth.production;
  const dir = tmp();
  fs.writeFileSync(path.join(dir, "settings.json"), JSON.stringify(old));
  assert.deepEqual(ps.load(dir).eth.production, d.eth.production);
  const b = ps.defaults();
  b.board.profile = "production";
  assert.ok(Object.keys(ps.validate(b)).includes("board.profile"));
});

// ---------------------------------------------------------------- the network consistency check

test("programNetworkReason: the files must name run.json's network (a Sepolia run.json with a chain-1 bundle or tick refuses, and the reverse)", () => {
  const sep = { profile: "sepolia", chain_id: 11155111 };
  const main = { profile: "production", chain_id: 1 };
  const run = (terms, tick) => ({ terms, roles: { alice: null, bob: tick ? { tick } : null } });
  assert.equal(prod.programNetworkReason(main, run({ profile: "production", profile_explicit: true, chain_id: 1 }, { eth: { chain_id: 1 }, swap_terms: { eth: { chain_id: 1 } } })), null);
  assert.equal(prod.programNetworkReason(sep, run({ profile: "sepolia", profile_explicit: true, chain_id: 11155111 }, { eth: { chain_id: 11155111 } })), null);
  assert.equal(prod.programNetworkReason(main, run(null, null)), null);
  assert.equal(prod.programNetworkReason(sep, run({ profile: "production", profile_explicit: true, chain_id: 1 }, null)), prod.MIXED_TEXT);
  assert.equal(prod.programNetworkReason(sep, run(null, { eth: { chain_id: 1 } })), prod.MIXED_TEXT);
  assert.equal(prod.programNetworkReason(sep, run(null, { swap_terms: { eth: { chain_id: 1 } } })), prod.MIXED_TEXT);
  assert.equal(prod.programNetworkReason(main, run({ profile: "sepolia", profile_explicit: true, chain_id: 1 }, null)), prod.MIXED_TEXT);
  assert.equal(prod.programNetworkReason(main, run(null, { eth: { chain_id: 11155111 } })), prod.MIXED_TEXT);
  assert.equal(prod.programNetworkReason(main, run({ profile: "production", profile_explicit: false, chain_id: "0x1" }, null)), prod.MIXED_TEXT, "an id it cannot read is a refusal");
});

// ---------------------------------------------------------------- the steps

const settingsOf = (o) => ({ profile: "production", role: "bob", gas_price_gwei: "1", priority_fee_gwei: "0.05", ...o });

test("steps: production gives --mainnet --max-fee-gwei (and the tip), never --gas-price-gwei; a test network never --mainnet", () => {
  assert.deepEqual(C.feeFlags(settingsOf({})), ["--mainnet", "--max-fee-gwei", "1", "--priority-fee-gwei", "0.05"]);
  assert.deepEqual(C.feeFlags(settingsOf({ priority_fee_gwei: null })), ["--mainnet", "--max-fee-gwei", "1"]);
  assert.deepEqual(C.reserveFeeFlags(settingsOf({})), ["--mainnet", "--max-fee-gwei", "1"]);
  assert.ok(!C.feeFlags(settingsOf({})).includes("--gas-price-gwei"));
  assert.deepEqual(C.feeFlags({ profile: "sepolia", gas_price_gwei: "2", priority_fee_gwei: null }), ["--gas-price-gwei", "2"]);
  assert.deepEqual(C.reserveFeeFlags({ profile: "sepolia", gas_price_gwei: "2" }), ["--gas-price-gwei", "2"]);
  assert.match(C.checkFeeSettings(settingsOf({ gas_price_gwei: null, priority_fee_gwei: null })), /mainnet and has no fee cap/);
  assert.equal(C.checkFeeSettings(settingsOf({})), null);
});

test("steps: --acknowledge-producer-share 650 only for Bob on production while his approval holds it, and only on his tick and lock step (not the claim)", () => {
  const ctx = (settings, ack) => ({ settings, producerAck: ack });
  assert.deepEqual(C.producerAckFlags(ctx(settingsOf({}), () => 650)), ["--acknowledge-producer-share", "650"]);
  assert.deepEqual(C.producerAckFlags(ctx(settingsOf({}), () => null)), []);
  assert.deepEqual(C.producerAckFlags(ctx(settingsOf({}), () => 700)), []);
  assert.deepEqual(C.producerAckFlags(ctx(settingsOf({}), () => { throw new Error("x"); })), []);
  assert.deepEqual(C.producerAckFlags({ settings: settingsOf({}) }), []);
  assert.deepEqual(C.producerAckFlags(ctx(settingsOf({ role: "alice" }), () => 650)), []);
  assert.deepEqual(C.producerAckFlags(ctx(settingsOf({ profile: "sepolia" }), () => 650)), []);
  const dir = tmp();
  const full = (ack) => ({ runDir: dir, tools: {}, settings: { ...settingsOf({}), noid_rpc: "http://127.0.0.1:9601", noid_rpc2: null, noid_rpc2_remote: false, eth_rpc: "https://a.example", eth_rpc2: "https://b.example", eth_rpc2_remote: false, single_node_ok: false, rpc_timeout_s: 60 }, producerAck: ack });
  assert.ok(C.tickBase(full(() => 650), { ack: true }).args.join(" ").includes("--acknowledge-producer-share 650"));
  assert.ok(!C.tickBase(full(() => 650)).args.includes("--acknowledge-producer-share"), "the claim's tick base passes none");
  assert.ok(!C.tickBase(full(() => null), { ack: true }).args.includes("--acknowledge-producer-share"));
  assert.ok(!C.tickBase(full(() => 650), { ack: true }).args.includes("--accept-producer-concentration"));
});

// ---------------------------------------------------------------- Bob's producer screen

const goodTick = (o = {}) => ({
  noid: {
    tip: 1000,
    producers: {
      tip: 1000, header_tip: 1000, read_at: 5000, window_long: 2880, window_short: 720, have: 2880, complete: true,
      long: { n: 2880, largest: 1520, largest_id: "x", top_two: 2000, distinct: 5 }, short: { n: 720, largest: 360, largest_id: "x", top_two: 500, distinct: 5 },
      second: { state: "agrees", height: 990, sampled: 64 }, ...(o.p || {}),
    },
    ...(o.noid || {}),
  },
});

test("producerScreen: the measured share is said in plain words and never refuses; an unreadable share is unknown with a warning; a second-node problem still refuses", () => {
  const ok = producerScreen(goodTick(), 5010);
  assert.equal(ok.ok, true);
  assert.equal(ok.known, true);
  assert.equal(ok.share_text, "52.8");
  assert.equal(ok.level, "high");
  assert.equal(ok.sentence, "One producer mined 52.8 % of recent Parano1d blocks.");
  assert.equal(ok.warning, "One producer mined 52.8 % of recent Parano1d blocks. A Bob who faces that miner as Alice can lose his ETH: above half of the blocks, no time window protects him.");
  // a share above the old 65 % ceiling: allowed, same warning (the named 76 % case)
  const big = producerScreen(goodTick({ p: { long: { n: 2880, largest: 2190, largest_id: "x", top_two: 2500, distinct: 3 } } }), 5010);
  assert.equal(big.ok, true);
  assert.equal(big.level, "high");
  assert.match(big.warning, /^One producer mined 76\.\d % of recent Parano1d blocks\. A Bob who faces that miner as Alice can lose his ETH/);
  // a milder band and a quiet one
  assert.equal(producerScreen(goodTick({ p: { long: { n: 2880, largest: 1100, largest_id: "x", top_two: 1500, distinct: 5 }, short: { n: 720, largest: 200, largest_id: "x", top_two: 300, distinct: 5 } } }), 5010).level, "mild");
  const quiet = producerScreen(goodTick({ p: { long: { n: 2880, largest: 500, largest_id: "x", top_two: 800, distinct: 9 }, short: { n: 720, largest: 100, largest_id: "x", top_two: 200, distinct: 9 } } }), 5010);
  assert.equal(quiet.level, "none");
  assert.equal(quiet.warning, "");
  // unknown: nothing read, an error, incomplete, stale, behind the tip -> allowed, with the unknown warning
  const unknown = (t) => {
    const r = producerScreen(t, 5010);
    assert.equal(r.ok, true);
    assert.equal(r.known, false);
    assert.equal(r.level, "unknown");
    assert.equal(r.share_text, null);
    assert.match(r.warning, /^The share of one producer in recent Parano1d blocks is unknown right now\. /);
  };
  unknown(null);
  unknown({});
  unknown(goodTick({ p: { error: "node said no" } }));
  unknown(goodTick({ p: { complete: false } }));
  unknown(goodTick({ p: { read_at: 4000 } }));
  unknown(goodTick({ p: { header_tip: 990 } }));
  const no = (t, o) => assert.equal(producerScreen(t, 5010, o).ok, false);
  no(goodTick({ p: { second: { state: "differs", height: 9, first: "a", second: "b" } } }));
  no(goodTick({ p: { second: { state: "producer_differs", height: 9 } } }));
  no(goodTick({ p: { second: { state: "unreadable", reason: "x" } } }));
  no(goodTick({ p: { second: { state: "agrees", height: 990, sampled: 0 } } }));
  no(goodTick({ p: { second: { state: "not_configured" } } }), "no second node and not loopback");
  assert.equal(producerScreen(goodTick({ p: { second: { state: "not_configured" } } }), 5010, { ownNodeIsLoopback: true }).ok, true);
  no(goodTick({ noid: { producer_marker: { state: "present", height: 5, at: 1 } } }));
  no(goodTick({ noid: { producer_marker: { state: "remembered", at: 1 } } }));
  no(goodTick({ noid: { producer_marker: { state: "unreadable", reason: "x" } } }));
  no(goodTick({ noid: { second_error: "unreachable" } }));
  assert.equal(producerScreen(goodTick({ noid: { producer_marker: { state: "absent" } } }), 5010).ok, true);
});

test("producerScreen: swap-cli's own producer_screen verdict refuses first when enforced and not waivable; a waivable one still needs the page's reading", () => {
  const withPs = (ps, o) => ({ ...goodTick(o), producer_screen: { enforced: true, limit_permille: 350, hard_max_permille: 650, ...ps } });
  for (const state of ["disagrees", "remembered", "one_node", "cannot_check", "something_new"]) {
    const r = producerScreen(withPs({ state, waivable_by_acknowledgement: false }), 5010, { ownNodeIsLoopback: true });
    assert.equal(r.ok, false, state);
    assert.ok(r.why.length > 20, state);
  }
  // the share states are never refusals: swap-cli reports them as waivable
  for (const state of ["concentrated", "share_unknown"]) assert.equal(producerScreen(withPs({ state, waivable_by_acknowledgement: true }), 5010).ok, true, state);
  assert.equal(producerScreen(withPs({ state: "concentrated" }), 5010).ok, false, "a missing flag is not a yes (an old swap-cli that never says waivable)");
  assert.equal(producerScreen(withPs({ state: "disagrees", waivable_by_acknowledgement: true }, { p: { second: { state: "differs", height: 9, first: "a", second: "b" } } }), 5010).ok, false, "the page's own reading of the second node still has to pass");
  assert.equal(producerScreen({ ...goodTick(), producer_screen: { enforced: false, state: "pass", waivable_by_acknowledgement: true } }, 5010).ok, true);
  assert.equal(producerScreen({ ...goodTick(), producer_screen: null }, 5010).ok, true, "null outside Bob's early phases: the page's reading decides");
});

// ---------------------------------------------------------------- the autopilot and the board

test("Autopilot.producerAckPermille: 650 only for Bob's production approval in force that holds the statement", () => {
  const mk = (settings, ap) => ({
    mainnetSettings: () => settings,
    actions: { readRunFn: () => ({}), cfg: { runDirs: [] } },
    now: () => 0,
    approvalState: () => ap,
  });
  const inForce = { in_force: true, file: { role: "bob", statements: ["stay_on", "producer_share_ack"] } };
  const f = (self) => Autopilot.prototype.producerAckPermille.call(self);
  assert.equal(f(mk({ role: "bob" }, inForce)), 650);
  assert.equal(f(mk({ role: "alice" }, inForce)), null);
  assert.equal(f(mk(null, inForce)), null);
  assert.equal(f(mk({ role: "bob" }, { ...inForce, in_force: false })), null, "an approval that is not in force");
  assert.equal(f(mk({ role: "bob" }, { in_force: true, file: { role: "bob", statements: ["stay_on"] } })), null, "an approval without the statement");
  assert.equal(f({ ...mk({ role: "bob" }, inForce), approvalState: () => { throw new Error("x"); } }), null);
});

test("the board host refuses mainnet explicitly: its own settings, run.json's profile or chain, and an unreadable run.json", () => {
  const f = (self) => BoardHost.prototype.onMainnet.call(self);
  assert.equal(f({ settings: { profile: "production" }, actions: {} }), true);
  assert.equal(f({ settings: { profile: "sepolia" }, actions: { settingsSource: { load: () => ({ ok: true, settings: { profile: "production", chain_id: 1 } }) } } }), true);
  assert.equal(f({ settings: { profile: "sepolia" }, actions: { settingsSource: { load: () => ({ ok: true, settings: { profile: "sepolia", chain_id: 1 } }) } } }), true);
  assert.equal(f({ settings: { profile: "sepolia" }, actions: { settingsSource: { load: () => { throw new Error("x"); } } } }), true);
  assert.equal(f({ settings: { profile: "sepolia" }, actions: { settingsSource: { load: () => ({ ok: true, settings: { profile: "sepolia", chain_id: 11155111 } }) } } }), false);
  assert.equal(f({ settings: { profile: "sepolia" }, actions: {} }), false);
});

// ---------------------------------------------------------------- the invitation

test("invitation: mainnet is made with the production caps and read back; version 2, a cap overshoot and an unknown network are refused", () => {
  const s = { role: "bob", profile: "production", contract: E("1"), contract_version: 1, amount_micronoid: "5000000", amount_wei: "1000000000000000", bob_noid: A3 };
  const text = inv.build(s, E("2"));
  assert.match(text, /"network": "mainnet"/);
  const r = inv.parse(text);
  assert.equal(r.ok, true);
  assert.equal(r.fields.profile, "production");
  assert.equal(r.fields.noid_amount, "5");
  const mod = (k, v) => JSON.stringify({ ...JSON.parse(text), [k]: v });
  assert.equal(inv.parse(mod("contract_version", 2)).ok, false);
  assert.equal(inv.parse(mod("noid_micronoid", "20000000001")).ok, false);
  assert.equal(inv.parse(mod("noid_micronoid", "20000000000")).ok, true);
  assert.equal(inv.parse(mod("eth_wei", "1000000000000000001")).ok, false);
  assert.equal(inv.parse(mod("network", "production")).ok, false);
  assert.equal(inv.parse(mod("network", "rehearsal")).ok, false);
  // a Sepolia invitation keeps its own, tiny cap
  const sep = JSON.stringify({ ...JSON.parse(text), network: "sepolia", noid_micronoid: "20000001" });
  assert.equal(inv.parse(sep).ok, false);
  assert.throws(() => inv.build({ ...s, profile: "rehearsal" }, E("2")));
});

// ---------------------------------------------------------------- the page server (program mode)

const { makeEnv } = require("./program-harness");
const { SwapSet } = require("../lib/swapset");

const MAIN = { profile: "production", chain_id: 1, contract_version: 1, gas_price_gwei: "1", priority_fee_gwei: "0.05", eth_rpc2: "https://rpc.mevblocker.io" };
const tickOf = (chain) => ({ eth: { chain_id: chain }, swap_terms: { eth: { chain_id: chain } }, phase_after: "created" });

test("program mode: a valid production run.json is opened and acted on; a tick or a bundle naming another network refuses it, and a Sepolia swap refuses a chain-1 tick", async () => {
  const env = makeEnv();
  try {
    const main = env.addSwap({ role: "alice", settings: MAIN });
    const test_ = env.addSwap({ role: "alice" });
    const set = new SwapSet({ program: env.program, deps: env.deps() });
    assert.deepEqual(set.scan().opened.sort(), [main.id, test_.id].sort());
    const m = set.get(main.id);
    assert.equal(m.readOnly, false, "a valid production swap is not read-only");
    assert.equal(m.runner.productionBlock(), null);
    assert.equal(m.autopilot.mainnetSettings().profile, "production");
    assert.equal(set.get(test_.id).autopilot.mainnetSettings(), null);
    assert.equal(set.summary(m).network, "mainnet");
    assert.equal(set.summary(set.get(test_.id)).network, "test");
    // a tick on another chain than run.json's: refused, and the audit says so
    env.writeTick(main, "alice", tickOf(11155111));
    assert.equal(m.runner.productionBlock(), prod.MIXED_TEXT);
    assert.throws(() => m.runner.assertNotProduction("tick-alice"), (e) => e.status === 403);
    env.writeTick(main, "alice", tickOf(1));
    assert.equal(m.runner.productionBlock(), null);
    // the reverse: a Sepolia run.json with a chain-1 tick
    const t = set.get(test_.id);
    env.writeTick(test_, "alice", tickOf(1));
    assert.equal(t.runner.productionBlock(), prod.MIXED_TEXT);
    await set.stopAll();
  } finally {
    await env.cleanup();
  }
});

test("the top bar's network chip: lit by an open mainnet swap (being set up or active), never by one that is done or by a test swap (run 24 F10)", async () => {
  const { barNetwork } = require("../lib/swapset");
  const env = makeEnv();
  try {
    const main = env.addSwap({ role: "alice", settings: MAIN });
    const test_ = env.addSwap({ role: "alice" });
    const set = new SwapSet({ program: env.program, deps: env.deps() });
    set.scan();
    assert.equal(barNetwork(set.list()), "mainnet", "a mainnet swap being set up (no tick yet) lights it");
    env.swapFile(main, "alice");
    env.writeTick(main, "alice", { ...tickOf(1), phase_after: "done" });
    set.get(main.id).snapshot = null; // the set's short read cache
    assert.equal(set.summary(set.get(main.id)).phase, "done");
    assert.equal(barNetwork(set.list()), "test", "a finished mainnet swap does not light it over a test swap");
    env.swapFile(test_, "alice");
    env.writeTick(test_, "alice", tickOf(11155111));
    set.get(test_.id).snapshot = null;
    assert.equal(barNetwork(set.list()), "test");
    // the pure rule
    assert.equal(barNetwork([{ network: "mainnet", active: true, phase: "funded" }]), "mainnet");
    assert.equal(barNetwork([{ network: "mainnet", active: false, phase: null, unstarted: true }]), "test");
    assert.equal(barNetwork([{ network: "mainnet", active: false, phase: "aborted" }, { network: "test", active: true, phase: "created" }]), "test");
    assert.equal(barNetwork([]), "test");
    assert.equal(barNetwork(null), "test");
    await set.stopAll();
  } finally {
    await env.cleanup();
  }
});

test("program mode: an approval on a production swap is refused when a handover file makes it a board run", async () => {
  const env = makeEnv();
  try {
    const main = env.addSwap({ role: "alice", settings: MAIN });
    fs.writeFileSync(path.join(main.dir, "handover-alice.json"), "{}");
    const set = new SwapSet({ program: env.program, deps: env.deps() });
    set.scan();
    const m = set.get(main.id);
    assert.ok(m, "the folder opens");
    assert.throws(() => m.autopilot.turnOn("alice", "5 NOID", { stay_on: true, no_manual_steps: true, bob_check_matches: true }), (e) => e.status === 422 && /board/i.test(e.message || JSON.stringify(e.reasons)), "refused as a board run (no board identity here), never approved");
    await set.stopAll();
  } finally {
    await env.cleanup();
  }
});

test("mainnet cap: 1 ETH is accepted and 1 ETH plus 1 wei is refused", () => {
  assert.deepEqual(rs.validate(aliceP({ amount_wei: "1000000000000000000" })), []);
  assert.deepEqual(keys(aliceP({ amount_wei: "1000000000000000001" })), ["amount_wei"]);
  assert.equal(form.PROGRAM_PROFILES.production.max_eth_wei, 10n ** 18n);
});

test("the mainnet NOID cap is 20,000 NOID: exactly the cap is accepted, one micro-NOID above is refused (form, run.json, invitation, page field)", () => {
  assert.equal(form.PROGRAM_PROFILES.production.max_noid_micro, 20_000_000_000n);
  assert.deepEqual(rs.validate(aliceP({ amount_micronoid: "20000000000" })), []);
  assert.deepEqual(keys(aliceP({ amount_micronoid: "20000000001" })), ["amount_micronoid"]);
  const text = JSON.parse(inv.build({ role: "bob", profile: "production", contract: E("1"), contract_version: 1, amount_micronoid: "5000000", amount_wei: "1000000000000000", bob_noid: A3 }, E("2")));
  assert.equal(inv.parse(JSON.stringify({ ...text, noid_micronoid: "20000000000" })).ok, true);
  assert.equal(inv.parse(JSON.stringify({ ...text, noid_micronoid: "20000000001" })).ok, false);
  // the test networks keep 20 NOID
  assert.equal(form.PROGRAM_PROFILES.sepolia.max_noid_micro, 20_000_000n);
});

test("producerScreen: an unreadable share never skips the second-node refusals (logic audit M1)", () => {
  // (a) one node, not on this computer, headers unreadable (error, then stale): refused for the one-node reason
  const failed = { error: "header read failed", complete: false, long: null, short: null, second: { state: "not_configured" } };
  const a1 = producerScreen(goodTick({ p: failed }), 5010);
  assert.equal(a1.ok, false);
  assert.match(a1.why, /no second Parano1d node/);
  const a2 = producerScreen(goodTick({ p: { read_at: 4000, second: { state: "not_configured" } } }), 5010);
  assert.equal(a2.ok, false);
  assert.match(a2.why, /no second Parano1d node/);
  // with a loopback node, or with two nodes in the tick and an incomplete read, it stays an unknown share
  assert.equal(producerScreen(goodTick({ p: failed }), 5010, { ownNodeIsLoopback: true }).level, "unknown");
  assert.equal(producerScreen(goodTick({ p: failed, noid: { second: { tip: 1000 } } }), 5010).level, "unknown");
  // (b) stale share read plus a second node that differs, or cannot be read on a complete read: refused for the disagreement
  const stale = { read_at: 4000 };
  const b1 = producerScreen(goodTick({ p: { ...stale, second: { state: "differs", height: 9, first: "a", second: "b" } } }), 5010);
  assert.equal(b1.ok, false);
  assert.match(b1.why, /disagree/);
  assert.equal(producerScreen(goodTick({ p: { ...stale, second: { state: "unreadable", reason: "x" } } }), 5010).ok, false);
  // an incomplete first read makes the second node's "not checked" part of the unknown share
  assert.equal(producerScreen(goodTick({ p: { ...failed, second: { state: "unreadable", reason: "not checked: the first node's headers are not complete" } } }), 5010).level, "unknown");
  assert.equal(producerScreen(goodTick({ p: { ...failed, second: { state: "differs", height: 9, first: "a", second: "b" } } }), 5010).ok, false);
});
