"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { createNodeCheck, isLoopback, CHECKPOINT } = require("../lib/nodecheck");

const NOW = 1_800_000_000_000;
const NOW_S = NOW / 1000;
const NOID = "http://127.0.0.1:9601";
const ETH1 = "https://sepolia.example.invalid/secret-api-key-123";
const ETH2 = "https://second.example.invalid/other-key";

const baseSettings = () => ({ noid_rpc: NOID, eth: { sepolia: { rpc: ETH1, rpc2: ETH2 }, rehearsal: { rpc: "http://127.0.0.1:8545", rpc2: null } } });

/** A scripted post: handlers[url][method] is a value, a function, or an Error to throw. */
function fakePost(handlers, log = []) {
  return async (url, body) => {
    log.push({ url, method: body.method, params: body.params });
    const h = handlers[url] && handlers[url][body.method];
    if (h === undefined) return { jsonrpc: "2.0", id: 1, error: { code: -32601, message: "no" } };
    const v = typeof h === "function" ? h(body.params) : h;
    if (v instanceof Error) throw v;
    return { jsonrpc: "2.0", id: 1, result: v };
  };
}
const refused = () => Object.assign(new Error("refused"), { kind: "refused" });
const transport = () => Object.assign(new Error("transport"), { kind: "transport" });

function make({ handlers, settings = baseSettings, checkpoint = null, profiles }) {
  return createNodeCheck({ post: fakePost(handlers), now: () => NOW, settings, checkpoint, profiles, autoStart: false });
}

const goodNoid = (extra = {}) => ({
  paranoid_blockCount: 300000,
  paranoid_getBlockHeader: (p) => ({ height: p[0], hash: p[0] === 279370 ? "AB".repeat(32) : "cd".repeat(32), timestamp: NOW_S - 20 }),
  ...extra,
});
const goodEth = (id = 11155111, age = 5) => ({ eth_chainId: "0x" + id.toString(16), eth_getBlockByNumber: { number: "0x1", timestamp: "0x" + (NOW_S - age).toString(16) } });

test("isLoopback", () => {
  for (const u of ["http://127.0.0.1:9601", "http://localhost:9601", "http://[::1]:9601"]) assert.equal(isLoopback(u), true, u);
  for (const u of ["http://192.168.1.5:9601", "https://example.com", "nope", "http://127.0.0.1.evil.com"]) assert.equal(isLoopback(u), false, u);
});

test("all good: ok / ok; a null checkpoint reports chain_checked false", async () => {
  const c = make({ handlers: { [NOID]: goodNoid(), [ETH1]: goodEth(), [ETH2]: goodEth() } });
  const s = await c.checkOnce();
  assert.equal(s.noid.state, "ok");
  assert.equal(s.noid.tip, 300000);
  assert.equal(s.noid.chain_checked, false);
  assert.equal(s.noid.ok_since_start, true);
  assert.equal(s.noid.checked_at, NOW);
  assert.equal(s.eth.state, "ok");
  assert.equal(s.eth.chain_id, 11155111);
  assert.equal(s.eth.endpoints, 2);
  assert.deepEqual(c.status(), s);
});

test("the pinned checkpoint: height 279,370, a 32-byte hex hash, frozen, and used when no checkpoint is given", async () => {
  assert.equal(CHECKPOINT.height, 279370);
  assert.match(CHECKPOINT.hash, /^[0-9a-f]{64}$/);
  assert.ok(Object.isFrozen(CHECKPOINT));
  const withDefault = (hashAt) =>
    createNodeCheck({
      post: fakePost({ [NOID]: goodNoid({ paranoid_getBlockHeader: (p) => ({ height: p[0], hash: p[0] === 279370 ? hashAt : "cd".repeat(32), timestamp: NOW_S - 20 }) }), [ETH1]: goodEth(), [ETH2]: goodEth() }),
      now: () => NOW,
      settings: baseSettings,
      autoStart: false,
    }).checkOnce();
  const ok = await withDefault(CHECKPOINT.hash.toUpperCase());
  assert.equal(ok.noid.state, "ok");
  assert.equal(ok.noid.chain_checked, true);
  const other = await withDefault("ab".repeat(32));
  assert.equal(other.noid.state, "wrong_chain");
  assert.equal(other.noid.chain_checked, false);
});

test("a matching checkpoint sets chain_checked; a different hash is wrong_chain", async () => {
  const cp = { height: 279370, hash: "ab".repeat(32) };
  const ok = await make({ handlers: { [NOID]: goodNoid(), [ETH1]: goodEth() }, checkpoint: cp }).checkOnce();
  assert.equal(ok.noid.state, "ok");
  assert.equal(ok.noid.chain_checked, true);
  const bad = await make({ handlers: { [NOID]: goodNoid(), [ETH1]: goodEth() }, checkpoint: { height: 279370, hash: "00".repeat(32) } }).checkOnce();
  assert.equal(bad.noid.state, "wrong_chain");
  assert.equal(bad.noid.chain_checked, false);
  const behind = await make({ handlers: { [NOID]: goodNoid({ paranoid_blockCount: 100 }) }, checkpoint: cp }).checkOnce();
  assert.equal(behind.noid.state, "behind", "a tip below the checkpoint cannot be judged: behind");
});

test("Parano1d states: not_running, behind, error, a non-loopback address", async () => {
  const run = async (noidHandlers, settings) => (await make({ handlers: { [NOID]: noidHandlers, "http://10.0.0.5:9601": goodNoid() }, settings }).checkOnce()).noid.state;
  assert.equal(await run({ paranoid_blockCount: refused() }), "not_running");
  assert.equal(await run(goodNoid({ paranoid_getBlockHeader: () => ({ timestamp: NOW_S - 601 }) })), "behind");
  assert.equal(await run(goodNoid({ paranoid_getBlockHeader: () => ({ timestamp: NOW_S - 600 }) })), "ok");
  assert.equal(await run({ paranoid_blockCount: transport() }), "error");
  assert.equal(await run({ paranoid_blockCount: "banana" }), "error");
  assert.equal(await run({ paranoid_blockCount: 5 }), "error", "no header answer");
  assert.equal(await run({}), "error", "a JSON-RPC error answer");
  assert.equal(await run(goodNoid(), () => ({ noid_rpc: "http://10.0.0.5:9601", eth: {} })), "error", "never asks a non-loopback node");
});

test("ok_since_start stays true after a later failure", async () => {
  let up = true;
  const handlers = { [NOID]: { paranoid_blockCount: () => (up ? 5 : refused()), paranoid_getBlockHeader: { timestamp: NOW_S } }, [ETH1]: goodEth() };
  const c = make({ handlers });
  assert.equal((await c.checkOnce()).noid.ok_since_start, true);
  up = false;
  const s = await c.checkOnce();
  assert.equal(s.noid.state, "not_running");
  assert.equal(s.noid.ok_since_start, true);
  const fresh = make({ handlers: { [NOID]: { paranoid_blockCount: refused() } } });
  assert.equal((await fresh.checkOnce()).noid.ok_since_start, false);
});

test("Ethereum states: wrong chain, behind, unreachable, the worst endpoint wins", async () => {
  const eth = async (h1, h2) => (await make({ handlers: { [NOID]: goodNoid(), [ETH1]: h1, [ETH2]: h2 } }).checkOnce()).eth.state;
  assert.equal(await eth(goodEth(), goodEth()), "ok");
  assert.equal(await eth(goodEth(1), goodEth()), "wrong_chain");
  assert.equal(await eth(goodEth(11155111, 121), goodEth()), "behind");
  assert.equal(await eth(goodEth(11155111, 120), goodEth()), "ok");
  assert.equal(await eth({ eth_chainId: refused() }, goodEth()), "unreachable");
  assert.equal(await eth(goodEth(1), { eth_chainId: refused() }), "unreachable", "unreachable ranks worse than wrong_chain");
  assert.equal(await eth({ eth_chainId: transport() }, goodEth()), "unreachable");
  assert.equal(await eth({}, goodEth()), "error");
});

test("rehearsal profile: chain 31337, and block age is not judged", async () => {
  const c = make({
    handlers: { [NOID]: goodNoid(), "http://127.0.0.1:8545": { eth_chainId: "0x7a69", eth_getBlockByNumber: { timestamp: "0x1" } } },
    profiles: () => ["rehearsal"],
  });
  const s = await c.checkOnce();
  assert.equal(s.eth.state, "ok");
  assert.equal(s.eth.chain_id, 31337);
  assert.equal(s.eth.endpoints, 1);
});

test("no configured endpoint is unreachable with zero endpoints", async () => {
  const s = await make({ handlers: { [NOID]: goodNoid() }, settings: () => ({ noid_rpc: NOID, eth: { sepolia: { rpc: null, rpc2: null } } }) }).checkOnce();
  assert.equal(s.eth.state, "unreachable");
  assert.equal(s.eth.endpoints, 0);
});

test("settings may come wrapped, or fail to load", async () => {
  const wrapped = await make({ handlers: { [NOID]: goodNoid(), [ETH1]: goodEth() }, settings: () => ({ ok: true, settings: baseSettings() }) }).checkOnce();
  assert.equal(wrapped.noid.state, "ok");
  const broken = await make({ handlers: {}, settings: () => { throw new Error("bad file"); } }).checkOnce();
  assert.equal(broken.noid.state, "error");
});

test("no URL, host, key or error text appears anywhere in the status", async () => {
  const handlers = { [NOID]: { paranoid_blockCount: refused() }, [ETH1]: { eth_chainId: Object.assign(new Error(`failed ${ETH1}`), { kind: "weird" }) }, [ETH2]: goodEth() };
  const c = make({ handlers });
  const text = JSON.stringify(await c.checkOnce());
  for (const bad of ["127.0.0.1", "9601", "example", "secret-api-key", "other-key", "http", "failed"]) assert.ok(!text.includes(bad), `status leaks ${bad}`);
});

test("the status before the first check holds no state it has not measured", () => {
  const c = make({ handlers: {} });
  const s = c.status();
  assert.equal(s.noid.checked_at, null);
  assert.equal(s.noid.ok_since_start, false);
  assert.equal(s.eth.checked_at, null);
});

test("only read-only methods are called", async () => {
  const log = [];
  const post = fakePost({ [NOID]: goodNoid(), [ETH1]: goodEth(), [ETH2]: goodEth() }, log);
  await createNodeCheck({ post, now: () => NOW, settings: baseSettings, autoStart: false }).checkOnce();
  const allowed = new Set(["paranoid_blockCount", "paranoid_getBlockHeader", "eth_chainId", "eth_getBlockByNumber"]);
  assert.ok(log.length > 0);
  for (const l of log) assert.ok(allowed.has(l.method), l.method);
});

test("autoStart runs a check at once and then on the interval; stop ends it", async () => {
  const timers = [];
  let calls = 0;
  const post = async (_u, body) => {
    if (body.method === "paranoid_blockCount") calls += 1;
    throw refused();
  };
  const c = createNodeCheck({ post, now: () => NOW, settings: baseSettings, setIntervalFn: (fn, ms) => (timers.push({ fn, ms }), { unref() {} }), clearIntervalFn: () => timers.push("cleared") });
  await c.checkOnce();
  assert.equal(timers[0].ms, 15000);
  assert.ok(calls >= 1);
  timers[0].fn();
  c.stop();
  assert.equal(timers[timers.length - 1], "cleared");
});

test("overlapping checks share one run", async () => {
  let n = 0;
  const post = async () => {
    n += 1;
    throw refused();
  };
  const c = createNodeCheck({ post, now: () => NOW, settings: () => ({ noid_rpc: NOID, eth: {} }), autoStart: false });
  await Promise.all([c.checkOnce(), c.checkOnce(), c.checkOnce()]);
  assert.equal(n, 1);
});
