"use strict";
// The figures of the launch screens (lib/launchfacts.js): the worked example of the build spec to the wei, the edges of every rule, and the drift tests that read the sources of the copies.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const L = require("../lib/launchfacts");
const VM = require("../lib/viewmodel");

const ROOT = path.resolve(__dirname, "..", "..", "..");
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), "utf8");

// ---- drift: the profile copies against swap-cli/src/params.rs and lib/viewmodel.js
function rustProfile(text, name) {
  const m = new RegExp(`pub const ${name}: Gates = Gates \\{([\\s\\S]*?)\\n\\};`).exec(text);
  assert.ok(m, `${name} block found in params.rs`);
  const o = {};
  for (const f of m[1].matchAll(/^\s*([a-z_0-9]+):\s*([0-9_]+),/gm)) o[f[1]] = Number(f[2].replace(/_/g, ""));
  return o;
}

test("the profile copies equal swap-cli/src/params.rs (the drift test): tau_fast, d_offset, b_final, w_a, finality and b_post = epoch + fee + final + safety", () => {
  const params = read("swap-cli", "src", "params.rs");
  for (const [name, rs] of [["production", "PRODUCTION"], ["sepolia", "SEPOLIA"], ["rehearsal", "REHEARSAL"]]) {
    const r = rustProfile(params, rs);
    const c = L.PROFILES[name];
    assert.equal(c.tau_fast_s, r.tau_fast_s, `${name} tau_fast_s`);
    assert.equal(c.d_offset, r.d_offset, `${name} d_offset`);
    assert.equal(c.b_final, r.b_final, `${name} b_final`);
    assert.equal(c.w_a_s, r.w_a_s, `${name} w_a_s`);
    assert.equal(c.eth_finality_s, name === "rehearsal" ? 1140 : r.eth_finality_s, `${name} eth_finality_s`);
    assert.equal(c.b_post, r.b_epoch_budget + r.b_fee + r.b_final + r.b_safety, `${name} b_post`);
  }
  // the nominal block time and the hc_lead default
  assert.match(params, /pub const TAU_NOM_S: u64 = 30;/);
  assert.equal(L.PROFILES.production.block_nom_s, 30);
  const runsettings = require("../lib/runsettings");
  for (const p of Object.values(L.PROFILES)) assert.equal(p.hc_lead, runsettings.DEFAULTS.hc_lead);
});

test("the profile copies agree with the profiles of lib/viewmodel.js (w_a_s); viewmodel.js is not touched", () => {
  for (const name of ["production", "sepolia", "rehearsal"]) assert.equal(L.PROFILES[name].w_a_s, VM.PROFILES[name].w_a_s, name);
});

test("the gas ceilings equal the constants of eth/scripts/live.js; the sweep ceiling is its SWEEP_GAS_CAP and the sweep figure is the gas limit it signs for a plain transfer (estimate 21,001 plus 20 %)", () => {
  const live = read("eth", "scripts", "live.js");
  const num = (re) => {
    const m = re.exec(live);
    assert.ok(m, String(re));
    return BigInt(m[1].replace(/_/g, ""));
  };
  assert.equal(L.GAS.lock.ceiling, num(/LOCK_GAS_RESERVE = \{[^}]*poseidon: ([0-9_]+)n/));
  assert.equal(L.GAS.reveal.ceiling, num(/POSEIDON_CLAIM_GAS_LIMIT = ([0-9_]+)n/));
  assert.equal(L.GAS.refund.ceiling, num(/REFUND_GAS_RESERVE = \{[^}]*poseidon: ([0-9_]+)n/));
  assert.equal(L.GAS.sweep.ceiling, num(/SWEEP_GAS_CAP = ([0-9_]+)n/));
  const liveModule = require("../../../eth/scripts/live.js");
  assert.equal(L.GAS.sweep.ceiling, liveModule.SWEEP_GAS_CAP);
  assert.equal(L.GAS.sweep.measured, liveModule.sweepGasLimit(21001n));
  assert.equal(L.GAS.sweep.measured, 25202n);
  for (const g of Object.values(L.GAS)) assert.ok(g.measured <= g.ceiling);
});

// ---- rate
test("rate: 2,000 NOID for 0.4 ETH is 0.0002 ETH a NOID and 5,000 NOID an ETH, exact", () => {
  const r = L.rate(2000n * 1000000n, 4n * 10n ** 17n);
  assert.deepEqual(r, { noid_in_eth: "0.0002", eth_in_noid: "5000", rounded: false });
  assert.deepEqual(L.rateParts(r), ["1 NOID = 0.0002 ETH", "1 ETH = 5,000 NOID"]);
});

test("rate: a figure that is cut shows 'about' after the '='; six significant digits, half up", () => {
  const r = L.rate(3000000n, 1000000000000000n); // 3 NOID for 0.001 ETH: 1 NOID = 0.000333333 ETH, 1 ETH = 3000 NOID
  assert.equal(r.noid_in_eth, "0.000333333");
  assert.equal(r.eth_in_noid, "3000");
  assert.equal(r.rounded, true);
  assert.deepEqual(L.rateParts(r), ["1 NOID = about 0.000333333 ETH", "1 ETH = about 3,000 NOID"]);
  assert.equal(L.rate(0n, 1n), null);
  assert.equal(L.rate("x", 1n), null);
  assert.equal(L.sig(999999500n, 1000n, 6).text, "1000000"); // 999999.5 rounds up to 1,000,000: seven digits, still at most six significant
  assert.equal(L.sig(1n, 3n, 6).text, "0.333333");
  assert.equal(L.sig(2n, 3n, 6).text, "0.666667");
  assert.equal(L.sig(5n, 1n, 6).text, "5");
});

test("fmtNoid and fmtEth group the whole part and keep six significant digits", () => {
  assert.deepEqual(L.fmtNoid(1999994200n, { exact: true }), { text: "1,999.9942", rounded: false });
  assert.deepEqual(L.fmtNoid(1999994200n), { text: "1,999.99", rounded: true });
  assert.deepEqual(L.fmtEth(4n * 10n ** 17n), { text: "0.4", rounded: false });
  assert.deepEqual(L.fmtEth(399737366600000n), { text: "0.000399737", rounded: true });
  assert.equal(L.fmtEth(null), null);
});

// ---- fees: the worked example, production, 2,000 NOID <-> 0.4 ETH, base 0.30 gwei, tip 0.05, cap 1
const GWEI = 10n ** 9n;
const EX = { baseFeeWei: 300000000n, capWei: GWEI, tipWei: 50000000n };

test("ethFees, Alice on the happy path: reveal 689,324 gas at 0.35 gwei plus the sweep (25,202 gas) at the cap, to the wei; at most 0.0013 ETH (ceilings 1,000,000 and 300,000 gas at the cap)", () => {
  const f = L.ethFees({ role: "alice", ...EX, path: "happy" });
  assert.equal(f.now_wei, (689324n * 350000000n + 25202n * GWEI).toString());
  assert.equal(f.now_wei, "266465400000000");
  assert.equal(f.max_wei, ((1000000n + 300000n) * GWEI).toString());
  assert.equal(f.max_wei, "1300000000000000");
  assert.deepEqual(f.steps.map((s) => s.id), ["reveal", "sweep"]);
});

test("ethFees, Bob: lock plus sweep on the happy path; lock, refund and sweep when stopped", () => {
  const h = L.ethFees({ role: "bob", ...EX, path: "happy" });
  assert.equal(h.now_wei, (583853n * 350000000n + 25202n * GWEI).toString());
  assert.equal(h.now_wei, "229550550000000");
  assert.deepEqual(h.steps.map((s) => s.id), ["lock", "sweep"]);
  const s = L.ethFees({ role: "bob", ...EX, path: "stopped" });
  assert.deepEqual(s.steps.map((x) => x.id), ["lock", "refund", "sweep"]);
  assert.equal(s.now_wei, ((583853n + 158608n) * 350000000n + 25202n * GWEI).toString());
  assert.equal(s.now_wei, "285063350000000");
  assert.equal(s.max_wei, ((700000n + 200000n + 300000n) * GWEI).toString());
  assert.equal(s.max_wei, "1200000000000000");
  assert.deepEqual(L.ethFees({ role: "alice", ...EX, path: "stopped" }).steps.map((x) => x.id), ["sweep"]);
});

test("ethFees: the price is capped (base plus tip over the cap counts the cap); an unknown base fee gives no 'now' figure; no cap gives neither", () => {
  const f = L.ethFees({ role: "alice", baseFeeWei: 5n * GWEI, capWei: GWEI, tipWei: 50000000n, path: "happy" });
  assert.equal(f.now_wei, (689324n * GWEI + 25202n * GWEI).toString());
  assert.equal(f.now_wei, "714526000000000");
  const u = L.ethFees({ role: "alice", baseFeeWei: null, capWei: GWEI, tipWei: 50000000n, path: "happy" });
  assert.equal(u.now_wei, null);
  assert.equal(u.max_wei, "1300000000000000");
  const n = L.ethFees({ role: "alice", baseFeeWei: 1n, capWei: null, tipWei: null, path: "happy" });
  assert.equal(n.now_wei, null);
  assert.equal(n.max_wei, null);
  assert.equal(L.ethFees({ role: "carol", ...EX, path: "happy" }), null);
});

test("noidFees: Alice's funding fee (the status' own figure, else 9,000), stopped = funding + close + sweep = 20,600; Bob's close fee 5,800 up to his max fee", () => {
  assert.deepEqual(L.noidFees({ role: "alice", path: "happy", fundingFeeMicro: null, maxFeeMicro: null }), { micro: "9000", upto_micro: null, source: "constant" });
  assert.deepEqual(L.noidFees({ role: "alice", path: "happy", fundingFeeMicro: "9500", maxFeeMicro: null }), { micro: "9500", upto_micro: null, source: "status" });
  assert.equal(L.noidFees({ role: "alice", path: "stopped", fundingFeeMicro: null, maxFeeMicro: null }).micro, "20600");
  assert.deepEqual(L.noidFees({ role: "bob", path: "happy", fundingFeeMicro: null, maxFeeMicro: 50000 }), { micro: "5800", upto_micro: "50000", source: "constant" });
  assert.equal(L.noidFees({ role: "bob", path: "happy", fundingFeeMicro: null, maxFeeMicro: null }).upto_micro, null);
});

test("share: the worked example, Alice 0.07 % and Bob 0.06 %; the same fees on run 8's 5 NOID for 0.001 ETH are 26.8 %, which is loud", () => {
  const a = L.share("266465400000000", 4n * 10n ** 17n, "9000", 2000000000n);
  assert.equal(L.pct(a), "0.07");
  const bobEth = (583853n * 350000000n + 25202n * GWEI).toString();
  const b = L.share(bobEth, 4n * 10n ** 17n, "5800", 2000000000n);
  assert.equal(L.pct(b), "0.06");
  const run8 = L.share("266465400000000", 10n ** 15n, "9000", 5000000n);
  assert.equal(L.pct(run8), "26.8");
  assert.ok(run8 >= L.LOUD_BP);
  assert.equal(L.share(null, 1n, "1", 1n), null);
  assert.equal(L.share("1", 0n, "1", 1n), null);
  assert.equal(L.pct(0.2), "less than 0.01");
  assert.equal(L.pct(100), "1.0");
  assert.equal(L.pct(99.4), "0.99");
  assert.equal(L.pct(null), null);
});

test("refusedNow at the edges: Alice refuses when cap < 2 x base, Bob when cap < base", () => {
  assert.equal(L.refusedNow({ role: "alice", baseFeeWei: 500n, capWei: 999n }), "reveal");
  assert.equal(L.refusedNow({ role: "alice", baseFeeWei: 500n, capWei: 1000n }), null);
  assert.equal(L.refusedNow({ role: "bob", baseFeeWei: 500n, capWei: 499n }), "lock");
  assert.equal(L.refusedNow({ role: "bob", baseFeeWei: 500n, capWei: 500n }), null);
  assert.equal(L.refusedNow({ role: "bob", baseFeeWei: null, capWei: 1n }), null);
  assert.equal(L.refusedNow({ role: "bob", baseFeeWei: 1n, capWei: null }), null);
});

test("backAfter: Alice 24,240 s in production (about 6 h 45 min) and about 3 h 5 min on Sepolia; Bob 8,400 s (about 2 h 20 min) and 1 h 30 min", () => {
  assert.equal(L.backAfter("production", "alice"), 24240);
  assert.equal(L.fmtBack(24240), "about 6 h 45 min");
  assert.equal(L.fmtBack(L.backAfter("sepolia", "alice")), "about 3 h 5 min");
  assert.equal(L.backAfter("production", "bob"), 8400);
  assert.equal(L.fmtBack(8400), "about 2 h 20 min");
  assert.equal(L.fmtBack(L.backAfter("sepolia", "bob")), "about 1 h 30 min");
  assert.equal(L.fmtBack(3600), "about 1 h");
  assert.equal(L.fmtBack(600), "about 10 min");
  assert.equal(L.backAfter("production", "alice", 100), (100 + 738 + 20) * 30);
  assert.equal(L.backAfter("nowhere", "alice"), null);
});

test("bobOnlineMin is 75 in production and 5 on Sepolia; lateK is 10 and 5", () => {
  assert.equal(L.bobOnlineMin("production"), 75);
  assert.equal(L.bobOnlineMin("sepolia"), 5);
  assert.equal(L.lateK("production"), 10);
  assert.equal(L.lateK("sepolia"), 5);
  assert.equal(L.bobOnlineMin("x"), null);
  assert.equal(L.lateK("x"), null);
});

// ---- addresses, on the project's test vectors
test("groups: the project's test-vector addresses, prefix kept on the first group, the last group short, every character in order", () => {
  const noid = "o1lqvrmvsyl7mkt3cptkz3c965ujt5ce6mjawxwwxe7mgn36mjzt8sn69xw2";
  const g = L.groups(noid);
  assert.equal(g[0], "o1lqvr");
  assert.equal(g.join(""), noid);
  assert.ok(g.slice(1, -1).every((x) => x.length === 4));
  const noid2 = "o125qayvgtmvqnlhqmqwe08dza3acaax5mct3u5h4uen3qtrds3jfset7wlk";
  assert.equal(L.groups(noid2).join(""), noid2);
  const eth = "0x9a9a9a9a9a9a9a9a9a9a9a9a9a9a9a9a9a9a9a9a";
  const e = L.groups(eth);
  assert.equal(e.length, 10);
  assert.equal(e[0], "0x9a9a");
  assert.equal(e.join(""), eth);
  assert.equal(L.groups("not an address"), null);
  assert.equal(L.groups("0x12"), null);
  assert.equal(L.groups(null), null);
  assert.equal(L.groups("o1" + "b".repeat(30)), null); // 'b' is not a bech32 character
});

test("caseNote: mixed case is 'none', all one case is 'no_checksum'", () => {
  assert.equal(L.caseNote("0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed"), "none");
  assert.equal(L.caseNote("0x5aaeb6053f3e94c9b9a09f33669435e7ef1beaed"), "no_checksum");
  assert.equal(L.caseNote("0x5AAEB6053F3E94C9B9A09F33669435E7EF1BEAED"), "no_checksum");
  assert.equal(L.caseNote("0x" + "1".repeat(40)), "no_checksum");
  assert.equal(L.caseNote("o1abc"), null);
});

test("historyLine: the five cases of the spec", () => {
  const info = { first_at: "2026-11-02T10:00:00Z", count: 3 };
  assert.deepEqual(L.historyLine("ok", info), { kind: "known", text: "Used for 3 swaps since 2026-11-02.", isNew: false });
  assert.equal(L.historyLine("ok", { first_at: "2026-11-02T10:00:00Z", count: 1 }).text, "Used for 1 swap since 2026-11-02.");
  assert.equal(L.historyLine("ok", undefined).text, "New address: not used for a swap on this computer before.");
  const rem = "0x9a9a9a9a9a9a9a9a9a9a9a9a9a9a9a9a9a9a9a9b";
  const ch = L.historyLine("ok", undefined, rem);
  assert.equal(ch.kind, "changed");
  assert.equal(ch.text, "Changed: your last swaps used 0x9a9a … 9a9b.");
  assert.equal(L.historyLine("unreadable", info).text, "The address history cannot be read, so every address is treated as new.");
  assert.equal(L.historyLine("locked", info).text, "The address history opens with the program's key store.");
  assert.equal(L.historyLine("unreadable", info).isNew, true, "an unreadable history never shows an address as known");
});

// ---- launch()
const BASE = { profile: "production", role: "alice", amountMicro: "2000000000", amountWei: String(4n * 10n ** 17n), capGwei: "1", tipGwei: "0.05", baseFee: { base_fee_wei: "300000000", block: 21000000, at: 1_800_000_000_000 }, nowMs: 1_800_000_030_000, fundingFeeMicro: null, maxFeeMicro: 50000 };

test("launch: the worked example for Alice and Bob in the shape of spec 5.1", () => {
  const a = L.launch(BASE);
  assert.equal(a.profile, "production");
  assert.equal(a.mainnet, true);
  assert.deepEqual(a.rate, { noid_in_eth: "0.0002", eth_in_noid: "5000", rounded: false });
  assert.equal(a.fees.happy.eth_now_wei, "266465400000000");
  assert.equal(a.fees.happy.eth_max_wei, "1300000000000000");
  assert.equal(a.fees.happy.noid_micro, "9000");
  assert.equal(a.fees.stopped.noid_micro, "20600");
  assert.equal(L.pct(a.fees.share_bp), "0.07");
  assert.equal(a.fees.loud, false);
  assert.equal(a.fees.refused_now, null);
  assert.equal(a.fees.base_fee_age_s, 30);
  assert.deepEqual(a.times, { usual_min: 50, back_after_s: 24240, bob_online_min: 75 });
  assert.equal(a.get_after_fees, "0.399734"); // 0.4 ETH less 0.0002664654 ETH, six significant digits
  const b = L.launch({ ...BASE, role: "bob" });
  assert.equal(b.fees.happy.noid_micro, "5800");
  assert.equal(b.fees.happy.noid_upto_micro, "50000");
  assert.equal(b.get_after_fees, "1,999.9942");
  assert.equal(b.times.back_after_s, 8400);
  assert.equal(L.pct(b.fees.share_bp), "0.06");
});

test("launch: run 8's amounts make the loud box (at least 500 basis points); a stale or missing base fee leaves only the 'at most' figure", () => {
  const loud = L.launch({ ...BASE, amountMicro: "5000000", amountWei: "1000000000000000" });
  assert.equal(L.pct(loud.fees.share_bp), "26.8");
  assert.equal(loud.fees.loud, true);
  const stale = L.launch({ ...BASE, nowMs: BASE.baseFee.at + 121 * 1000 });
  assert.equal(stale.fees.happy.eth_now_wei, null);
  assert.equal(stale.fees.happy.eth_max_wei, "1300000000000000");
  assert.equal(stale.fees.share_bp, null);
  assert.equal(stale.fees.loud, false);
  assert.equal(stale.fees.base_fee_age_s, 121);
  assert.equal(stale.get_after_fees, null);
  const none = L.launch({ ...BASE, baseFee: null });
  assert.equal(none.fees.happy.eth_now_wei, null);
  assert.equal(none.fees.base_fee_age_s, null);
  assert.equal(L.launch({ ...BASE, nowMs: BASE.baseFee.at + 120 * 1000 }).fees.happy.eth_now_wei, "266465400000000", "120 s is not yet stale");
});

test("launch: the loud box at 499 and 500 basis points, and the cap-below-the-rule field", () => {
  // the NOID leg is made so large that its fee is a negligible share: only the Ethereum fee of Alice's happy path (266,465,400,000,000 wei) counts
  const fee = 266465400000000n;
  const huge = String(10n ** 18n);
  const withShare = (bp) => L.launch({ ...BASE, amountMicro: huge, amountWei: String((fee * 10000n) / BigInt(bp)) });
  const at499 = withShare(499);
  assert.ok(at499.fees.share_bp >= 499 && at499.fees.share_bp < 500);
  assert.equal(at499.fees.loud, false);
  const at500 = withShare(500);
  assert.ok(at500.fees.share_bp >= 500);
  assert.equal(at500.fees.loud, true);
  const refused = L.launch({ ...BASE, baseFee: { base_fee_wei: "600000000", block: 1, at: BASE.nowMs } });
  assert.equal(refused.fees.refused_now, "reveal");
  assert.equal(L.launch({ ...BASE, role: "bob", baseFee: { base_fee_wei: "600000000", block: 1, at: BASE.nowMs } }).fees.refused_now, null);
});

test("launch: an unknown profile, role or amount gives null; no cap gives no 'at most' figure; the figures are strings, not floats (except the share)", () => {
  assert.equal(L.launch({ ...BASE, profile: "x" }), null);
  assert.equal(L.launch({ ...BASE, role: "x" }), null);
  assert.equal(L.launch({ ...BASE, amountMicro: "0" }), null);
  assert.equal(L.launch({ ...BASE, amountWei: null }), null);
  const nocap = L.launch({ ...BASE, capGwei: null });
  assert.equal(nocap.fees.happy.eth_max_wei, null);
  assert.equal(nocap.fees.happy.eth_now_wei, null);
  const walk = (v, p) => {
    if (typeof v === "number") assert.ok(Number.isInteger(v) || /share_bp$/.test(p), `${p} is a float`);
    else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) walk(x, `${p}.${k}`);
  };
  walk(L.launch(BASE), "launch");
});

test("gweiToWei and weiToGwei", () => {
  assert.equal(L.gweiToWei("0.05"), 50000000n);
  assert.equal(L.gweiToWei("1"), 1000000000n);
  assert.equal(L.gweiToWei("0.0000000001"), null);
  assert.equal(L.gweiToWei("x"), null);
  assert.equal(L.weiToGwei("350000000"), "0.35");
  assert.equal(L.weiToGwei(1000000000n), "1");
});

test("baseFeeFor: eth.fees[profile] first; eth.fee only when it names the same profile; never a fee of another network", () => {
  const f = (w, profile) => ({ base_fee_wei: w, block: 5, at: 10, profile });
  const eth = { fee: f("7", "production"), fees: { sepolia: f("3", "sepolia"), production: f("7", "production") } };
  assert.deepEqual(L.baseFeeFor(eth, "sepolia"), { base_fee_wei: "3", block: 5, at: 10 });
  assert.deepEqual(L.baseFeeFor(eth, "production"), { base_fee_wei: "7", block: 5, at: 10 });
  assert.equal(L.baseFeeFor({ fee: f("7", "production") }, "sepolia"), null);
  assert.deepEqual(L.baseFeeFor({ fee: f("7", "production") }, "production"), { base_fee_wei: "7", block: 5, at: 10 });
  assert.equal(L.baseFeeFor({ fee: { base_fee_wei: "7", block: 1, at: 1 } }, "production"), null, "a fee with no profile is not used");
  assert.equal(L.baseFeeFor({ fee: null }, "sepolia"), null);
  assert.equal(L.baseFeeFor(null, "sepolia"), null);
  assert.equal(L.baseFeeFor({ fees: { sepolia: { base_fee_wei: "x" } } }, "sepolia"), null);
});
