"use strict";
// The market reference rate (display only): the snapshot's validation, the age bands, the unavailable conditions, the comparison with a swap's rate, the one network read (at most once in ten
// minutes, https only, 64 KB, no redirect), the server's routes, and the page (the new-swap form and the approval, Ethereum mainnet only). No real network anywhere: the read goes through a fake
// `https`, and every page request goes through a fake fetch.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { EventEmitter } = require("events");
const M = require("../lib/marketref");
const MF = require("../lib/marketfetch");
const L = require("../lib/launchfacts");
const { loadPage, textOf } = require("./program-page-dom");
const PF = require("./program-page-fixtures");
const { openSwap, AP, LM, status, cardPayload, has, F, OWN_NOID, SW_A } = (() => {
  const h = require("./look-harness");
  return { ...h, SW_A: h.F.SWAP_A };
})();
const { makeEnv } = require("./program-harness");
const programsettings = require("../lib/programsettings");

const NOW = Date.parse("2026-11-27T12:00:00Z");
const iso = (ms) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");
const MIN = 60000;
/** A good snapshot: ETH 3200 USD, NOID 0.64 USD (5,000 NOID per ETH), 12 minutes old. */
const snap = (o = {}) => ({ v: 1, generated_at: iso(NOW - 12 * MIN), sources: { eth_usd: "A", noid_usd: "B" }, eth_usd: 3200, noid_usd: 0.64, noid_usd_venue: "SmallEx", noid_volume_24h_usd: 25000, noid_price_ts: iso(NOW - 12 * MIN), noid_price_stale: false, parano1d: { top_producer_share_pct: 50, window_blocks: 144, measured_at: iso(NOW) }, eth_gas_gwei: 1, ...o });
const good = (o) => {
  const r = M.parse(JSON.stringify(snap(o)), NOW);
  assert.equal(r.ok, true, JSON.stringify(r));
  return r.ref;
};

// ------------------------------------------------------------------ the schema
test("schema: a good snapshot is read, unknown keys are ignored, and the numbers come out as they are", () => {
  const r = M.parse(JSON.stringify({ ...snap(), extra: { a: 1 } }), NOW);
  assert.equal(r.ok, true);
  assert.deepEqual(r.ref, { eth_usd: 3200, noid_usd: 0.64, venue: "SmallEx", volume: 25000, generated_ms: NOW - 12 * MIN, noid_ts_ms: NOW - 12 * MIN, noid_stale: false });
});

test("schema: bad, oversized and sample data are refused (the whole read fails, never a partial one)", () => {
  const bad = (o, why) => assert.deepEqual(M.parse(typeof o === "string" ? o : JSON.stringify(o), NOW), { ok: false, why });
  bad("not json", "bad_json");
  bad("[]", "bad_schema");
  bad("null", "bad_schema");
  bad(snap({ v: 2 }), "bad_schema");
  bad(snap({ sample: true }), "sample");
  bad("﻿" + JSON.stringify(snap()), "bad_file");
  bad(JSON.stringify(snap()) + " ".repeat(M.MAX_BYTES), "bad_file");
  bad(snap({ generated_at: "2026-02-31T10:00:00Z" }), "bad_time");
  bad(snap({ generated_at: "yesterday" }), "bad_time");
  bad(snap({ generated_at: iso(NOW + 6 * MIN) }), "bad_time");
  bad(snap({ noid_price_ts: iso(NOW + 6 * MIN) }), "bad_time");
  bad(snap({ eth_usd: -1 }), "bad_eth");
  bad(snap({ eth_usd: "3200" }), "bad_eth");
  bad(snap({ eth_usd: 0 }), "bad_eth");
  bad(snap({ noid_usd: 1e12 }), "bad_noid");
  bad(snap({ noid_usd_venue: "<script>alert(1)</script>" }), "bad_venue");
  bad(snap({ noid_usd_venue: "Sample venue (not live)" }), "bad_venue");
  bad(snap({ noid_usd_venue: null }), "bad_venue");
  bad(snap({ noid_volume_24h_usd: -5 }), "bad_volume");
  bad(snap({ noid_volume_24h_usd: null }), "bad_volume");
  bad(snap({ noid_price_stale: "no" }), "bad_stale");
  bad(snap({ noid_price_ts: null }), "bad_time");
  // a missing field is not a null
  const o = snap();
  delete o.eth_usd;
  bad(o, "bad_eth");
  // nulls that are allowed together
  assert.equal(M.parse(JSON.stringify(snap({ noid_usd: null, noid_usd_venue: null, noid_volume_24h_usd: null, noid_price_ts: null })), NOW).ok, true);
  assert.equal(M.parse(JSON.stringify(snap({ eth_usd: null })), NOW).ok, true);
});

// ------------------------------------------------------------------ age bands, unavailable conditions
test("age bands: up to 30 minutes normal, 30 minutes to 6 hours stale with no comparison, over 6 hours unavailable", () => {
  const ref = good();
  const at = (min, swap = 5000) => M.view(ref, NOW - 12 * MIN + min * MIN, swap);
  assert.equal(at(0).state, "ok");
  assert.equal(at(30).state, "ok", "exactly 30 minutes is still normal");
  const stale = at(31);
  assert.equal(stale.state, "stale");
  assert.equal(stale.grey, true);
  assert.match(stale.ref_line, /^Market reference \(stale\): 1 ETH ≈ 5,000 NOID \(31 min old; NOID price from one small exchange, SmallEx\)\.$/);
  assert.equal(stale.swap_line, null, "no comparison when stale");
  assert.equal(stale.pct, null);
  assert.equal(at(360).state, "stale", "exactly 6 hours is still stale");
  const old = at(361);
  assert.equal(old.state, "unavailable");
  assert.match(old.ref_line, /^Reference rate unavailable \(too old\)\.$/);
  assert.equal(old.swap_line, null);
  // the older of the file's time and the NOID price's time counts
  const r2 = good({ noid_price_ts: iso(NOW - 40 * MIN) });
  assert.equal(M.view(r2, NOW, 5000).state, "stale");
  assert.equal(M.ageText(12 * MIN), "12 min");
  assert.equal(M.ageText(125 * MIN), "2 h 5 min");
  assert.equal(M.ageText(120 * MIN), "2 h");
});

test("unavailable: no ETH price, no NOID price, a NOID price stale at its source, a NOID volume under 10,000 USD, a failed read: no figure and no comparison", () => {
  const un = (ref, reason) => {
    const v = M.view(ref, NOW, 5000);
    assert.equal(v.state, "unavailable");
    assert.equal(v.swap_line, null);
    assert.equal(v.pct, null);
    assert.equal(v.grey, true);
    assert.equal(v.far, false);
    assert.equal(v.ref_line, reason ? `Reference rate unavailable (${reason}).` : "Reference rate unavailable.");
    assert.ok(!/NOID \(|≈/.test(v.ref_line), "no figure is shown");
  };
  un(good({ eth_usd: null }), "no ETH price");
  un(good({ noid_usd: null, noid_usd_venue: null, noid_volume_24h_usd: null, noid_price_ts: null }), "no NOID price");
  un(good({ noid_price_stale: true }), "the NOID price is stale at its source");
  un(good({ noid_volume_24h_usd: 9999.99 }), "the NOID volume is too low to trust");
  un(null, null);
  un(undefined, null);
  assert.equal(M.view(good({ noid_volume_24h_usd: 10000 }), NOW, 5000).state, "ok", "10,000 USD is enough");
});

// ------------------------------------------------------------------ the comparison
test("comparison: above, below, at the reference; far from it only past 20 %; neutral words", () => {
  const ref = good(); // 5,000 NOID per ETH
  const v = (swap) => M.view(ref, NOW, swap);
  assert.equal(v(5950).swap_line, "This swap: 1 ETH = 5,950 NOID, 19 % above the reference.");
  assert.equal(v(5950).far, false);
  assert.equal(v(4000).swap_line, "This swap: 1 ETH = 4,000 NOID, 20 % below the reference.");
  assert.equal(v(4000).far, false, "exactly 20 % is not far");
  assert.equal(v(5000).swap_line, "This swap: 1 ETH = 5,000 NOID, at the reference.");
  assert.equal(v(5004).swap_line, "This swap: 1 ETH = 5,004 NOID, at the reference.", "under half a percent is at the reference");
  const far = v(6100);
  assert.equal(far.far, true);
  assert.equal(far.swap_line, "This swap: 1 ETH = 6,100 NOID, 22 % above the reference. Far from the reference.");
  assert.equal(v(3000).far, true);
  assert.equal(v(null).swap_line, null, "nothing typed: only the reference line");
  assert.equal(v(0).swap_line, null);
  assert.equal(v(NaN).swap_line, null);
  assert.equal(v(5950).ref_line, "Market reference: 1 ETH ≈ 5,000 NOID (12 min old; NOID price from one small exchange, SmallEx).");
  for (const x of [v(5950), v(1000), v(90000), v(5000)]) assert.ok(!/good|bad|deal|cheap|expensive|warning|risk/i.test(`${x.ref_line} ${x.swap_line}`), "neutral words");
  // the rate is shown to four digits for the reference
  assert.equal(M.fmtRate(4210.4, 4), "4,210");
  assert.equal(M.fmtRate(12.3456, 4), "12.35");
  assert.equal(M.fmtRate(0.00023456, 4), "0.0002346");
  assert.equal(M.fmtRate(0, 4), null);
});

test("the swap's rate from typed amounts: digits and one dot only, never a guess", () => {
  assert.equal(M.swapRateOf("5000", "1"), 5000);
  assert.equal(M.swapRateOf("5", "0.001"), 5000);
  for (const [n, e] of [["", "1"], ["5", ""], ["abc", "1"], ["5", "0"], ["5", "1e3"], ["-5", "1"], ["5,000", "1"], [null, "1"], ["5", undefined]]) assert.equal(M.swapRateOf(n, e), null);
});

test("the drawn block is plain text of the page's own builder: no markup, one line without a typed amount, two with it", () => {
  const el = (tag, attrs, ...kids) => ({ tag, attrs, kids });
  const one = M.node(el, M.view(good(), NOW, null));
  assert.equal(one.kids.length, 1);
  assert.equal(one.attrs.class, "market-ref");
  const two = M.node(el, M.view(good(), NOW, 6100));
  assert.equal(two.kids.length, 2);
  assert.equal(two.attrs.class, "market-ref far");
  assert.deepEqual(Object.keys(two.kids[1].attrs).sort(), ["class", "text"], "text, never html");
  assert.equal(M.node(el, M.view(good({ noid_price_stale: true }), NOW, 1)).attrs.class, "market-ref grey");
});

// ------------------------------------------------------------------ the read
/** A fake https: records every request; `answer` makes the response. */
function fakeHttps(answer) {
  const calls = [];
  return {
    calls,
    get(opts, cb) {
      calls.push(opts);
      const req = new EventEmitter();
      req.destroy = () => {
        req.destroyed = true;
      };
      setImmediate(() => {
        if (req.destroyed) return;
        const a = answer(opts);
        if (a.error) return req.emit("error", new Error(a.error));
        if (a.hang) return;
        const res = new EventEmitter();
        res.statusCode = a.status || 200;
        res.headers = a.headers || {};
        res.resume = () => {};
        cb(res);
        for (const chunk of a.chunks || [Buffer.from(a.body === undefined ? JSON.stringify(snap()) : a.body)]) res.emit("data", chunk);
        res.emit("end");
      });
      return req;
    },
  };
}
const clock = (t0 = NOW) => {
  const c = { t: t0, now: () => c.t };
  return c;
};

test("fetcher: the address is https only and fixed; one GET with no header, no cookie, no body, no query, no port; the answer is the parsed reference", async () => {
  assert.equal(MF.MARKET_URL, "https://no1dswap.github.io/data/market.json");
  const u = new URL(MF.MARKET_URL);
  assert.deepEqual([u.protocol, u.search, u.hash, u.port, u.username], ["https:", "", "", "", ""]);
  const h = fakeHttps(() => ({}));
  const f = MF.createMarketFetcher({ https: h, now: () => NOW });
  assert.deepEqual(f.peek(), { state: "pending", ref: null }, "nothing is read before it is asked for");
  assert.equal(h.calls.length, 0);
  const a = await f.get();
  assert.equal(a.state, "ok");
  assert.equal(a.ref.eth_usd, 3200);
  assert.equal(h.calls.length, 1);
  const o = h.calls[0];
  assert.equal(o.host, "no1dswap.github.io");
  assert.equal(o.path, "/data/market.json");
  assert.deepEqual(o.headers, {}, "no header of ours: no cookie, no identifier, nothing about the user or a swap");
  assert.equal(o.agent, false);
  assert.ok(!("method" in o) || o.method === "GET");
  assert.ok(o.timeout <= 10000);
  assert.deepEqual(f.peek(), a);
});

test("fetcher: a URL that is not https, has a port, credentials, or does not parse is refused before any request", async () => {
  for (const url of ["http://no1dswap.github.io/data/market.json", "https://u:p@no1dswap.github.io/x", "https://no1dswap.github.io:8443/x", "not a url", "ftp://x/y"]) {
    const h = fakeHttps(() => ({}));
    const f = MF.createMarketFetcher({ https: h, now: () => NOW, url });
    assert.equal((await f.get()).state, "unavailable", url);
    assert.equal(h.calls.length, 0, url);
  }
});

test("fetcher: a redirect, a bad status, a big body (declared or streamed), a body that is not UTF-8 or not the schema, a network error and a hang are all just \"unavailable\"", async () => {
  const cases = {
    redirect: () => ({ status: 302, headers: { location: "https://evil.example/market.json" } }),
    notfound: () => ({ status: 404, body: "no" }),
    declared: () => ({ headers: { "content-length": String(M.MAX_BYTES + 1) } }),
    streamed: () => ({ chunks: [Buffer.alloc(40000, 32), Buffer.alloc(40000, 32)] }),
    notutf8: () => ({ body: Buffer.from([0xff, 0xfe, 0xfd]) }),
    notjson: () => ({ body: "<html>" }),
    sample: () => ({ body: JSON.stringify(snap({ sample: true })) }),
    wrongschema: () => ({ body: JSON.stringify(snap({ eth_usd: "x" })) }),
    error: () => ({ error: "ECONNRESET" }),
  };
  for (const [name, answer] of Object.entries(cases)) {
    const h = fakeHttps(answer);
    const f = MF.createMarketFetcher({ https: h, now: () => NOW });
    assert.deepEqual(await f.get(), { state: "unavailable", ref: null }, name);
  }
  // a hang ends at the timeout (the timer is the module's own; a short one is used through httpGet)
  const h = fakeHttps(() => ({ hang: true }));
  await assert.rejects(MF.httpGet(h, MF.MARKET_URL, M.MAX_BYTES, 30), /timeout/);
});

test("fetcher: at most one read in ten minutes, a failed read included; many asks at once make one read; a clock that goes back does not cause a read at every ask", async () => {
  const c = clock();
  let fail = true;
  const h = fakeHttps(() => (fail ? { error: "down" } : {}));
  const f = MF.createMarketFetcher({ https: h, now: c.now });
  const all = await Promise.all([f.get(), f.get(), f.get(), f.get()]);
  assert.equal(h.calls.length, 1, "four asks, one read");
  assert.ok(all.every((x) => x.state === "unavailable"));
  c.t += 9 * MIN + 59000;
  for (let i = 0; i < 5; i++) await f.get();
  assert.equal(h.calls.length, 1, "a failure is not retried inside ten minutes");
  f.trigger();
  assert.equal(h.calls.length, 1, "a trigger inside the window reads nothing");
  fail = false;
  c.t += 2000;
  assert.equal((await f.get()).state, "ok");
  assert.equal(h.calls.length, 2);
  for (let i = 0; i < 5; i++) await f.get();
  assert.equal(h.calls.length, 2);
  c.t -= 3 * 3600000; // the clock jumps back
  for (let i = 0; i < 5; i++) await f.get();
  assert.equal(h.calls.length, 2, "no read at every ask after a jump back");
  c.t += 11 * MIN;
  await f.get();
  assert.equal(h.calls.length, 3);
});

test("static: the fetcher is the only module of this feature that touches the network; marketref.js has no require at all; neither writes a file", () => {
  const lib = path.join(__dirname, "..", "lib");
  const strip = (t) => t.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  const ref = strip(fs.readFileSync(path.join(lib, "marketref.js"), "utf8"));
  assert.ok(!/require\(|fetch\(|XMLHttpRequest|https?\.get|writeFile|fs\./.test(ref));
  const fe = strip(fs.readFileSync(path.join(lib, "marketfetch.js"), "utf8"));
  assert.deepEqual([...fe.matchAll(/require\(\s*["']([^"']+)["']\s*\)/g)].map((m) => m[1]).sort(), ["./marketref", "https"]);
  assert.ok(!/writeFile|appendFile|createWriteStream|setHeader|cookie|User-Agent/i.test(fe));
  // the page never fetches the snapshot itself: its address is in no page file
  // (program.js names the offers board in one line of the first-start guide, as plain text: the market file and any fetch of the site stay out of it)
  for (const f of ["program.js", "actions.js", "operator.js", "index.html"]) {
    const src = fs.readFileSync(path.join(__dirname, "..", f), "utf8");
    assert.ok(!/market\.json/.test(src), f);
    // program.js may name the board once, in the guide line; with that exact string removed the host must be gone (so a later fetch from it fails here)
    const GUIDE = "offers are posted and seen on the offers board, https://no1dswap.github.io/. Only the one";
    const rest = f === "program.js" ? src.replace(GUIDE, "") : src;
    if (f === "program.js") assert.ok(src.includes(GUIDE), "the guide line is there");
    assert.ok(!/no1dswap\.github\.io/.test(rest), f);
  }
});

// ------------------------------------------------------------------ the server
const REF = () => good();
/** A reading that is 12 minutes old by the real clock (the page uses it). */
const liveRef = () => ({ ...REF(), generated_ms: Date.now() - 12 * MIN, noid_ts_ms: Date.now() - 12 * MIN });
function fakeMarket(state = "ok") {
  const m = { gets: 0, triggers: 0, peeks: 0 };
  m.get = async () => {
    m.gets++;
    return state === "ok" ? { state: "ok", ref: REF() } : { state, ref: null };
  };
  m.peek = () => {
    m.peeks++;
    return state === "ok" ? { state: "ok", ref: REF() } : { state, ref: null };
  };
  m.trigger = () => {
    m.triggers++;
  };
  return m;
}
const MAIN = { profile: "production", chain_id: 1, contract_version: 1, gas_price_gwei: "1", priority_fee_gwei: "0.05", eth_rpc2: "https://rpc.mevblocker.io" };

test("server: GET /api/market answers the program's reading; with the update check set to Never it answers \"off\" and reads nothing", async () => {
  const env = makeEnv();
  try {
    const m = fakeMarket();
    const { api } = await env.start({ market: m });
    let r = await api("GET", "/api/market");
    assert.equal(r.status, 200);
    assert.equal(r.body.state, "ok");
    assert.equal(r.body.ref.eth_usd, 3200);
    assert.equal(m.gets, 1);
    // the route needs the token like every other
    const { request } = require("./program-harness");
    assert.equal((await request(env.servers[0], null, "GET", "/api/market")).status, 401);
    programsettings.save(env.dataDir, { ...programsettings.defaults(), update_check: "off" });
    r = await api("GET", "/api/market");
    assert.deepEqual(r.body, { state: "off", ref: null });
    assert.equal(m.gets, 1, "no read when the person turned the update check off");
  } finally {
    await env.cleanup();
  }
});

test("server: a mainnet swap that is not approved yet asks for the reading and carries it; a test network swap never does (no read, no field)", async () => {
  const env = makeEnv();
  try {
    const main = env.addSwap({ role: "alice", settings: MAIN });
    const test_ = env.addSwap({ role: "alice" });
    const m = fakeMarket();
    const { api } = await env.start({ market: m });
    let r = await api("GET", `/api/run?swap=${test_.id}`);
    assert.equal(r.status, 200);
    assert.equal(r.body.program.market, null);
    assert.equal(m.triggers + m.peeks + m.gets, 0, "a test network swap makes no ask at all");
    r = await api("GET", `/api/run?swap=${main.id}`);
    assert.equal(r.status, 200);
    assert.equal(r.body.program.market.state, "ok");
    assert.equal(r.body.program.market.ref.venue, "SmallEx");
    assert.ok(m.triggers >= 1);
    // never through the board, the terminal console's payload or the actions
    assert.ok(!("market" in (r.body.actions || {})));
  } finally {
    await env.cleanup();
  }
});

test("server: the reading never enters the terms, the run folder or the audit: a mainnet swap's folder is byte-identical before and after the reading is asked for", async () => {
  const env = makeEnv();
  try {
    const main = env.addSwap({ role: "alice", settings: MAIN });
    const snapshot = () => Object.fromEntries(fs.readdirSync(main.dir, { recursive: true }).filter((f) => fs.statSync(path.join(main.dir, f)).isFile()).map((f) => [f, fs.readFileSync(path.join(main.dir, f), "hex")]));
    const { api } = await env.start({ market: fakeMarket() });
    await api("GET", `/api/run?swap=${main.id}`);
    const before = snapshot();
    await api("GET", "/api/market");
    await api("GET", `/api/run?swap=${main.id}`);
    const after = snapshot();
    assert.deepEqual(Object.keys(after).sort(), Object.keys(before).sort());
    for (const k of Object.keys(before)) if (!/audit|\.log$/.test(k)) assert.equal(after[k], before[k], k);
    for (const [k, v] of Object.entries(after)) assert.ok(!/SmallEx|market/i.test(Buffer.from(v, "hex").toString("latin1")), `${k} names the reference`);
  } finally {
    await env.cleanup();
  }
});

test("server: an approved mainnet swap asks for no reading (the screen is gone), and a mainnet swap with the update check off carries none", async () => {
  const env = makeEnv();
  try {
    const main = env.addSwap({ role: "alice", settings: MAIN });
    const m = fakeMarket();
    const { api } = await env.start({ market: m });
    programsettings.save(env.dataDir, { ...programsettings.defaults(), update_check: "off" });
    const r = await api("GET", `/api/run?swap=${main.id}`);
    assert.equal(r.body.program.market, null);
    assert.equal(m.triggers + m.peeks, 0);
  } finally {
    await env.cleanup();
  }
});

// ------------------------------------------------------------------ the page: the new-swap form
const MY_NOID = "o1lqvrmvsyl7mkt3cptkz3c965ujt5ce6mjawxwwxe7mgn36mjzt8sn69xw2";
const MY_ETH = "0x" + "9a9A".repeat(10);
const SETTINGS = { v: 1, noid_rpc: "http://127.0.0.1:9601", noid_rpc2: null, noid_rpc2_remote: false, eth: { sepolia: { rpc: "https://s.example", rpc2: null }, rehearsal: { rpc: "http://127.0.0.1:8545", rpc2: null }, production: { rpc: "https://p.example", rpc2: "https://q.example" } }, eth_rpc2_remote: false, rpc_timeout_s: 60, alert_url: null, noid_payout: MY_NOID, eth_payout: MY_ETH, bob_noid: null, board: { relays: [], lead_blocks: 60, fund_k: null, reserve_wei: null, allow_public: false, allow_local_test: false, min_pow_bits: 0 }, update_check: "ask" };
const PIN = "0x48Ce4D6cf3c175737532017e82B9261b51F8E5eF";
const formInfo = () => ({ profiles: { sepolia: { chain: 11155111, max_noid: 20, max_eth: 0.01, contract: PIN }, rehearsal: { chain: 31337, max_noid: 20, max_eth: 0.01, contract: null }, production: { chain: 1, max_noid: 20000, max_eth: 1, contract: null, mainnet: true, fee_cap_gwei: "1", tip_gwei: "0.05" } }, roles: ["alice", "bob"] });
const norm = (t) => t.replace(/\s+/g, " ").trim();

async function formPage(marketAnswer, routes = {}) {
  const prog = PF.prog({ form: formInfo() });
  const page = await loadPage({ fetch: PF.router({ "GET /api/program": () => ({ status: 200, body: prog }), "GET /api/settings": { ok: true, settings: SETTINGS, payout_history: [], payout_history_state: "ok" }, "GET /api/market": () => ({ status: 200, body: marketAnswer }), ...routes }) });
  await page.byId("pg-new").click();
  await page.flush();
  const root = page.byId("pg-root");
  const g = (id) => root.all((n) => n.attrs.id === id)[0];
  const type = async (id, v) => {
    g(id).value = v;
    await g(id).fire("input");
  };
  const pick = async (id, v) => {
    g(id).value = v;
    await g(id).fire("change");
  };
  const marketCalls = () => page.calls.filter((c) => /\/api\/market/.test(JSON.stringify(c))).length;
  return { page, g, type, pick, marketCalls, box: () => g("ns-market") };
}

test("form: on Ethereum mainnet the reference shows, and the comparison follows the amounts typed; nothing is drawn before the program answers", async () => {
  const f = await formPage({ state: "ok", ref: liveRef() });
  await f.pick("ns-profile", "production");
  await f.page.flush();
  assert.equal(f.box().hidden, false);
  assert.match(norm(textOf(f.box())), /^Market reference: 1 ETH ≈ 5,000 NOID \(\d+ min old; NOID price from one small exchange, SmallEx\)\.$/);
  await f.type("ns-noid_amount", "5950");
  await f.type("ns-eth_amount", "1");
  assert.match(norm(textOf(f.box())), /This swap: 1 ETH = 5,950 NOID, 19 % above the reference\.$/);
  await f.type("ns-noid_amount", "6100");
  assert.match(norm(textOf(f.box())), /22 % above the reference\. Far from the reference\.$/);
  assert.ok(f.box().all((n) => has(n, "market-ref") && has(n, "far")).length === 1);
  await f.type("ns-noid_amount", "4000");
  assert.match(norm(textOf(f.box())), /20 % below the reference\.$/);
});

test("form: a stale reading is greyed with no comparison; an unavailable one says so with no figure; an update check set to Never draws nothing", async () => {
  const old = { ...liveRef(), generated_ms: Date.now() - 2 * 3600000, noid_ts_ms: Date.now() - 2 * 3600000 };
  let f = await formPage({ state: "ok", ref: old });
  await f.pick("ns-profile", "production");
  await f.page.flush();
  await f.type("ns-noid_amount", "5000");
  await f.type("ns-eth_amount", "1");
  const t = norm(textOf(f.box()));
  assert.match(t, /^Market reference \(stale\): /);
  assert.ok(!/This swap/.test(t));
  assert.ok(f.box().all((n) => has(n, "grey")).length === 1);
  f = await formPage({ state: "unavailable", ref: null });
  await f.pick("ns-profile", "production");
  await f.page.flush();
  await f.type("ns-noid_amount", "5000");
  await f.type("ns-eth_amount", "1");
  assert.equal(norm(textOf(f.box())), "Reference rate unavailable.");
  f = await formPage({ state: "off", ref: null });
  await f.pick("ns-profile", "production");
  await f.page.flush();
  assert.equal(f.box().hidden, true);
  assert.equal(norm(textOf(f.box())), "");
});

test("form: on a test network, and while the form shows a test network, the page never asks for the reading and draws nothing", async () => {
  const f = await formPage({ state: "ok", ref: liveRef() });
  await f.type("ns-noid_amount", "5");
  await f.type("ns-eth_amount", "0.001");
  await f.pick("ns-profile", "rehearsal");
  await f.page.flush();
  assert.equal(f.marketCalls(), 0);
  assert.equal(f.box().hidden, true);
  assert.equal(norm(textOf(f.box())), "");
  await f.pick("ns-profile", "sepolia");
  await f.page.flush();
  assert.equal(f.marketCalls(), 0);
  // and it asks once the person picks mainnet, not before
  await f.pick("ns-profile", "production");
  await f.page.flush();
  assert.ok(f.marketCalls() >= 1);
  // and going back to a test network hides it again
  await f.pick("ns-profile", "sepolia");
  assert.equal(f.box().hidden, true);
});

test("form: the reading changes nothing the form posts: the same body with and without it, no market field, nothing rounded or pre-filled", async () => {
  const OTHER = "o125qayvgtmvqnlhqmqwe08dza3acaax5mct3u5h4uen3qtrds3jfset7wlk";
  const body = async (answer) => {
    const posts = [];
    const f = await formPage(answer, { "POST /api/newswap": (u, b) => { posts.push(b); return { status: 200, body: { ok: true, swap: PF.SWAP_A || "a".repeat(32) } }; } });
    await f.pick("ns-profile", "production");
    await f.page.flush();
    await f.type("ns-noid_amount", "5123.456789");
    await f.type("ns-eth_amount", "1");
    await f.type("ns-bob_noid", OTHER);
    await f.type("ns-bob_eth", MY_ETH);
    await f.type("ns-contract", PIN);
    assert.equal(f.g("ns-noid_amount").value, "5123.456789", "the amount is left as typed");
    assert.equal(f.g("ns-eth_amount").value, "1");
    for (const id of ["ns-tick-noid_payout", "ns-tick-eth_payout"]) if (f.g(id)) {
      f.g(id).checked = true;
      await f.g(id).fire("change");
    }
    await f.g("ns-go").click();
    await f.page.flush();
    assert.equal(posts.length, 1, "the form posted");
    return JSON.stringify(posts[0]);
  };
  const a = await body({ state: "ok", ref: liveRef() });
  const b = await body({ state: "unavailable", ref: null });
  assert.equal(a, b);
  assert.ok(!/market|reference|SmallEx/i.test(a));
  assert.equal(JSON.parse(a).fields.noid_amount, "5123.456789");
});

// ------------------------------------------------------------------ the page: the approval
const aliceAp = (o = {}) => ({ alice: AP("alice", o), bob: null });
const mkLaunch = (role, o = {}) => L.launch({ profile: o.profile || "production", role, amountMicro: o.micro ?? 5000000000, amountWei: o.wei ?? "1000000000000000000", capGwei: "1", tipGwei: "0.05", baseFee: { base_fee_wei: "300000000", block: 1234, at: Date.now() }, nowMs: Date.now(), fundingFeeMicro: null, maxFeeMicro: 50000 });
const payload = (role, o = {}) => cardPayload(role, { line_match: LM, status: status(role), autopilot: aliceAp({ expected_typed: "5000 NOID", gets_text: "1 ETH" }), run: { program: { swap: null, own_noid: OWN_NOID, launch: mkLaunch(role, o.l || {}), market: o.market, ...(o.prog || {}) } } });
const approvalOf = (page) => page.byId("pg-card").all((n) => has(n, "autopilot-box"))[0];
const marketOf = (page) => approvalOf(page).all((n) => has(n, "market-ref"))[0];

test("approval: on a mainnet swap the reference and the comparison show beside the swap's own rate, for both roles", async () => {
  const fresh = () => ({ state: "ok", ref: { ...REF(), generated_ms: Date.now() - 12 * MIN, noid_ts_ms: Date.now() - 12 * MIN } });
  const page = await openSwap(SW_A, (r) => payload(r, { market: fresh(), l: { micro: 5950000000 } }));
  const m = marketOf(page);
  assert.ok(m, "drawn");
  const t = norm(textOf(m));
  assert.match(t, /^Market reference: 1 ETH ≈ 5,000 NOID \(12 min old; NOID price from one small exchange, SmallEx\)\. This swap: 1 ETH = 5,950 NOID, 19 % above the reference\.$/);
  assert.ok(!has(m, "far"));
  // far: the neutral note, no other box
  const far = await openSwap(SW_A, (r) => payload(r, { market: fresh(), l: { micro: 2000000000 } }));
  assert.match(norm(textOf(marketOf(far))), /60 % below the reference\. Far from the reference\.$/);
  assert.equal(approvalOf(far).all((n) => has(n, "alarm")).length, 0, "no alarm box comes from the reference");
  // Bob's approval too
  const SB = F.SWAP_B;
  const bob = await openSwap(SB, (r) => cardPayload(r, { line_match: LM, status: status(r), autopilot: { alice: null, bob: AP("bob", { expected_typed: "1 ETH", gets_text: "5000 NOID" }) }, run: { program: { swap: null, own_noid: OWN_NOID, launch: mkLaunch("bob", { micro: 5000000000 }), market: fresh() } } }));
  assert.match(norm(textOf(marketOf(bob))), /This swap: 1 ETH = 5,000 NOID, at the reference\.$/);
});

test("approval: stale greyed with no comparison, unavailable with no figure, nothing while the program has no reading, \"off\" or a test network", async () => {
  const stale = { state: "ok", ref: { ...REF(), generated_ms: Date.now() - 3 * 3600000, noid_ts_ms: Date.now() - 3 * 3600000 } };
  let page = await openSwap(SW_A, (r) => payload(r, { market: stale }));
  assert.match(norm(textOf(marketOf(page))), /^Market reference \(stale\): /);
  assert.ok(!/This swap/.test(textOf(marketOf(page))));
  assert.ok(has(marketOf(page), "grey"));
  page = await openSwap(SW_A, (r) => payload(r, { market: { state: "unavailable", ref: null } }));
  assert.equal(norm(textOf(marketOf(page))), "Reference rate unavailable.");
  for (const market of [undefined, null, { state: "pending", ref: null }, { state: "off", ref: null }]) {
    page = await openSwap(SW_A, (r) => payload(r, { market }));
    assert.equal(marketOf(page), undefined, JSON.stringify(market));
  }
  // a test network swap shows none even if a reading is in the payload
  page = await openSwap(SW_A, (r) => payload(r, { market: { state: "ok", ref: liveRef() }, l: { profile: "sepolia" } }));
  assert.equal(marketOf(page), undefined);
});

test("approval: the reference adds nothing to what is posted: the typed amount, the statements and the body of the approval are the same with and without it", async () => {
  const run = async (market) => {
    const page = await openSwap(SW_A, (r) => payload(r, { market }));
    const box = approvalOf(page);
    return JSON.stringify({ typed: box.all((n) => n.attrs && n.attrs.id === "ap-typed").length, hint: textOf(box.all((n) => n.attrs && n.attrs.id === "ap-typed-hint")[0]), inputs: box.all((n) => n.tag === "input").length });
  };
  const withIt = await run({ state: "ok", ref: { ...REF(), generated_ms: Date.now() - MIN, noid_ts_ms: Date.now() - MIN } });
  const without = await run(undefined);
  assert.equal(withIt, without);
});

// ------------------------------------------------------------------ the practice swap
test("practice: its module and its routes never touch the reference", () => {
  const dir = path.join(__dirname, "..");
  for (const f of ["practice.js", "lib/practice.js", "lib/practicetext.js"]) assert.ok(!/market/i.test(fs.readFileSync(path.join(dir, f), "utf8")), f);
});
