"use strict";
// R4 and R5 on the server: `launch` in /api/run from a fixture swap, the base fee in the node status and its staleness (the fee of another network is never used), the deposit status' own fee,
// the settlement and Bob's lock check in the run payload.
const test = require("node:test");
const assert = require("node:assert/strict");
const { makeEnv } = require("./program-harness");
const { bobCanLock, withFeeAges } = require("../server");
const L = require("../lib/launchfacts");

const fee = (wei, profile, ageMs = 30000) => ({ base_fee_wei: wei, block: 21000000, at: Date.now() - ageMs, profile });
const SEPOLIA = { gas_price_gwei: "1", priority_fee_gwei: "0.05" };

test("node status: each fee carries age_s and stale (over 120 s) from the server's clock; a fee of an odd shape is dropped; nothing else is changed", async () => {
  const env = makeEnv();
  try {
    env.node.eth.fee = fee("300000000", "sepolia", 30000);
    env.node.eth.fees = { sepolia: fee("300000000", "sepolia", 30000), production: fee("5", "production", 200000), bad: { base_fee_wei: "x", at: 1 } };
    const { api } = await env.start();
    const eth = (await api("GET", "/api/program")).body.node.eth;
    assert.equal(eth.state, "ok");
    assert.equal(eth.fee.stale, false);
    assert.ok(eth.fee.age_s >= 30 && eth.fee.age_s < 40);
    assert.equal(eth.fees.sepolia.stale, false);
    assert.equal(eth.fees.production.stale, true);
    assert.ok(eth.fees.production.age_s >= 200);
    assert.equal(eth.fees.bad, undefined);
    env.node.eth.fee = null;
    assert.equal((await api("GET", "/api/program")).body.node.eth.fee, null);
    delete env.node.eth.fee;
    assert.equal("fee" in (await api("GET", "/api/program")).body.node.eth, false);
  } finally {
    await env.cleanup();
  }
  assert.equal(withFeeAges(null), null);
  assert.deepEqual(withFeeAges({ noid: {} }), { noid: {} });
});

test("/api/run: `launch` from the swap's run.json and the base fee of its own network, in the shape of the spec", async () => {
  const env = makeEnv();
  try {
    const sw = env.addSwap({ role: "alice", settings: { ...SEPOLIA } });
    env.node.eth.fees = { sepolia: fee("300000000", "sepolia") };
    const { api } = await env.start();
    const r = await api("GET", `/api/run?swap=${sw.id}`);
    assert.equal(r.status, 200);
    const l = r.body.program.launch;
    assert.equal(l.profile, "sepolia");
    assert.equal(l.mainnet, false);
    assert.deepEqual(l.rate, L.rate("10000000", "1000000000000000"));
    assert.equal(l.fees.happy.eth_now_wei, "266465400000000", "0.35 gwei x 689,324 gas + the sweep (25,202 gas) at the 1 gwei cap");
    assert.equal(l.fees.happy.eth_max_wei, "1300000000000000");
    assert.equal(l.fees.happy.noid_micro, "9000");
    assert.equal(l.fees.stopped.noid_micro, "20600");
    assert.equal(typeof l.fees.share_bp, "number");
    assert.equal(l.fees.loud, true, "10 NOID for 0.001 ETH: the fees are a large share");
    assert.equal(l.fees.refused_now, null);
    assert.ok(l.fees.base_fee_age_s >= 30 && l.fees.base_fee_age_s < 40);
    assert.deepEqual(l.times, { usual_min: 50, back_after_s: L.backAfter("sepolia", "alice", 50), bob_online_min: 5 });
    assert.equal(typeof l.get_after_fees, "string");
    // the shape of the spec's top level
    assert.deepEqual(Object.keys(l).sort(), ["fees", "get_after_fees", "mainnet", "profile", "rate", "times"]);
    for (const k of ["happy", "stopped"]) for (const f of ["eth_now_wei", "eth_max_wei", "noid_micro", "noid_upto_micro"]) assert.ok(f in l.fees[k], `${k}.${f}`);
  } finally {
    await env.cleanup();
  }
});

test("/api/run: a fee read for another network is never used; a stale fee gives only the 'at most' figures; a Bob swap gets the close fee and its max fee", async () => {
  const env = makeEnv();
  try {
    const a = env.addSwap({ role: "alice", settings: { ...SEPOLIA } });
    const b = env.addSwap({ role: "bob", settings: { ...SEPOLIA } });
    env.node.eth.fees = { production: fee("300000000", "production") };
    env.node.eth.fee = fee("300000000", "production");
    const { api } = await env.start();
    let l = (await api("GET", `/api/run?swap=${a.id}`)).body.program.launch;
    assert.equal(l.fees.happy.eth_now_wei, null, "a mainnet fee does not price a Sepolia swap");
    assert.equal(l.fees.happy.eth_max_wei, "1300000000000000");
    assert.equal(l.fees.base_fee_age_s, null);
    // the old single fee counts only when it names the profile
    env.node.eth.fee = fee("300000000", "sepolia");
    delete env.node.eth.fees;
    l = (await api("GET", `/api/run?swap=${a.id}`)).body.program.launch;
    assert.equal(l.fees.happy.eth_now_wei, "266465400000000");
    // stale
    env.node.eth.fee = fee("300000000", "sepolia", 130000);
    l = (await api("GET", `/api/run?swap=${a.id}`)).body.program.launch;
    assert.equal(l.fees.happy.eth_now_wei, null);
    assert.ok(l.fees.base_fee_age_s >= 130);
    assert.equal(l.get_after_fees, null);
    // Bob
    env.node.eth.fee = fee("300000000", "sepolia");
    l = (await api("GET", `/api/run?swap=${b.id}`)).body.program.launch;
    assert.equal(l.fees.happy.noid_micro, "5800");
    assert.equal(l.fees.happy.eth_now_wei, (583853n * 350000000n + 25202n * 1000000000n).toString());
    assert.equal(l.get_after_fees, "9.9942");
  } finally {
    await env.cleanup();
  }
});

test("/api/run: the swap's own deposit status gives Alice's funding fee; a swap with no cap has no 'at most' figure", async () => {
  const env = makeEnv();
  try {
    const sw = env.addSwap({ role: "alice", settings: { ...SEPOLIA } });
    const nocap = env.addSwap({ role: "alice" });
    const { api, srv } = await env.start();
    await api("GET", "/api/program");
    const swap = srv.swapSet.get(sw.id);
    swap.runner.walletStatus.alice = { at_ms: Date.now(), ok: true, noid: { fee_reserve_micronoid: "9500", plain_micronoid: "0", need_micronoid: "1", address: "o1x", covers: false }, eth: null, problems: [] };
    let l = (await api("GET", `/api/run?swap=${sw.id}`)).body.program.launch;
    assert.equal(l.fees.happy.noid_micro, "9500");
    assert.equal(l.fees.stopped.noid_micro, String(9500 + 5800 + 5800));
    const n = (await api("GET", `/api/run?swap=${nocap.id}`)).body.program.launch;
    assert.equal(n.fees.happy.eth_max_wei, null);
    assert.equal(n.fees.refused_now, null);
    l = null;
  } finally {
    await env.cleanup();
  }
});

test("/api/run: launch is not computed for a folder with no readable run.json, and a failure inside it never fails the payload", async () => {
  const env = makeEnv();
  try {
    const sw = env.addSwap({ role: "alice", noRunJson: true });
    const { api } = await env.start();
    const r = await api("GET", `/api/run?swap=${sw.id}`);
    assert.equal(r.status, 200);
    assert.equal(r.body.program.launch, undefined);
  } finally {
    await env.cleanup();
  }
});

test("/api/run: the settlement of a swap that is not done says state none and nothing else is invented", async () => {
  const env = makeEnv();
  try {
    const sw = env.addSwap({ role: "alice", settings: { ...SEPOLIA } });
    const { api } = await env.start();
    const s = (await api("GET", `/api/run?swap=${sw.id}`)).body.program.settlement;
    assert.equal(s.state, "none");
    assert.equal(s.complete, false);
    assert.equal(s.fees, null);
    assert.equal(s.time_min, null);
    assert.ok(!JSON.stringify(s).includes(env.root), "no path");
  } finally {
    await env.cleanup();
  }
});

test("Bob's lock check: ok with the share text, no with the screen's own words, loading with no tick, stale with an old tick; null without a screen", () => {
  const now = 1_800_000_000;
  const screenOk = { ok: true, share_text: "26.4", known: true, level: "none", warning: "" };
  assert.deepEqual(bobCanLock(screenOk, { now: now - 5 }, now), { ok: true, state: "ok", why: null, share_text: "26.4", known: true, level: "none", warning: "" });
  assert.deepEqual(bobCanLock({ ok: false, why: "The producer reading is not complete yet." }, { now }, now), { ok: false, state: "no", why: "The producer reading is not complete yet.", share_text: null, known: false, level: null, warning: "" });
  assert.equal(bobCanLock(screenOk, null, now).state, "loading");
  assert.equal(bobCanLock(screenOk, { now: now - 121 }, now).state, "stale");
  assert.equal(bobCanLock(screenOk, { now: now - 120 }, now).state, "ok");
  assert.equal(bobCanLock(screenOk, { now: "x" }, now).state, "stale");
  assert.equal(bobCanLock(null, { now }, now), null);
  assert.equal(bobCanLock(undefined, null, now), null);
});
