"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { HttpJsonRpc, FixtureRpc, ALLOWED, RpcError, redactUrl } = require("../lib/rpc");

function fakeFetch(handler) {
  const calls = [];
  const fn = async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push(body);
    const out = handler(body);
    if (out instanceof Error) throw out;
    return { ok: true, status: 200, json: async () => ({ jsonrpc: "2.0", id: body.id, ...out }) };
  };
  fn.calls = calls;
  return fn;
}

test("allowlist refuses every mutating or wallet method before any network call", async () => {
  const fetch = fakeFetch(() => ({ result: 1 }));
  const rpc = new HttpJsonRpc("http://127.0.0.1:9601", "noid", { fetch });
  for (const m of ["paranoid_submitTxIntent", "paranoid_createObject", "paranoid_walletFundObject", "paranoid_walletWatchObject", "paranoid_walletSend", "wallet_anything", "paranoid_getMempoolEntry", "paranoid_getSlotHints", "eth_blockNumber"]) {
    await assert.rejects(rpc.call(m, []), (e) => e instanceof RpcError && e.kind === "refused" && /refused/.test(e.message));
  }
  const eth = new HttpJsonRpc("http://127.0.0.1:8545", "eth", { fetch });
  for (const m of ["eth_sendTransaction", "eth_sendRawTransaction", "eth_accounts", "eth_sign", "personal_sign", "hardhat_mine", "evm_mine", "paranoid_blockCount"]) {
    await assert.rejects(eth.call(m, []), (e) => e.kind === "refused");
  }
  assert.equal(fetch.calls.length, 0, "no request may leave the process");
  assert.equal(rpc.stats.refused, 9);
});

test("allowlist is exactly the documented read-only set", () => {
  assert.deepEqual([...ALLOWED.noid].sort(), [
    "paranoid_blockCount",
    "paranoid_estimateFeeDetailed",
    "paranoid_getEpochAnchor",
    "paranoid_getMempoolInfo",
    "paranoid_getObjectInstances",
    "paranoid_getObjectStatus",
    "paranoid_getTx",
  ]);
  assert.deepEqual([...ALLOWED.eth].sort(), ["eth_blockNumber", "eth_call", "eth_chainId", "eth_getBlockByNumber", "eth_getLogs"]);
});

test("successful answers are cached for 10 s per method+params; in-flight calls are deduplicated", async () => {
  let t = 1_000_000;
  const fetch = fakeFetch((b) => ({ result: b.method === "paranoid_blockCount" ? 42 : "x" }));
  const rpc = new HttpJsonRpc("http://127.0.0.1:9601", "noid", { fetch, clock: () => t });
  const [a, b] = await Promise.all([rpc.call("paranoid_blockCount", []), rpc.call("paranoid_blockCount", [])]);
  assert.equal(a, 42);
  assert.equal(b, 42);
  assert.equal(fetch.calls.length, 1, "concurrent identical calls share one request");
  t += 9_000;
  assert.equal(await rpc.call("paranoid_blockCount", []), 42);
  assert.equal(fetch.calls.length, 1, "within 10 s: cache hit");
  await rpc.call("paranoid_getTx", ["aa"]);
  await rpc.call("paranoid_getTx", ["bb"]);
  assert.equal(fetch.calls.length, 3, "different params are different keys");
  t += 1_001;
  await rpc.call("paranoid_blockCount", []);
  assert.equal(fetch.calls.length, 4, "after 10 s: refetched");
  assert.equal(rpc.stats.cacheHits, 2);
});

test("a JSON-RPC error becomes RpcError(remote) and is cached only briefly; transport errors are reported with a redacted URL", async () => {
  let t = 0;
  let fail = true;
  const fetch = fakeFetch(() => (fail ? { error: { code: -32000, message: "contract: Encoding" } } : { result: 7 }));
  const rpc = new HttpJsonRpc("http://127.0.0.1:9601/secret-path?key=abc", "noid", { fetch, clock: () => t });
  await assert.rejects(rpc.call("paranoid_getObjectInstances", ["zz", 0, 16]), (e) => e.kind === "remote" && e.code === -32000 && !/secret-path|key=abc/.test(e.message));
  await assert.rejects(rpc.call("paranoid_getObjectInstances", ["zz", 0, 16]), (e) => e.kind === "remote");
  assert.equal(fetch.calls.length, 1, "error cached for a short time");
  t += 3_001;
  fail = false;
  assert.equal(await rpc.call("paranoid_getObjectInstances", ["zz", 0, 16]), 7);

  const down = new HttpJsonRpc("http://127.0.0.1:1/x", "noid", { fetch: fakeFetch(() => new Error("ECONNREFUSED")) });
  await assert.rejects(down.call("paranoid_blockCount", []), (e) => e.kind === "transport" && /ECONNREFUSED/.test(e.message) && !/\/x/.test(e.message));
  const bad = new HttpJsonRpc("http://127.0.0.1:1", "noid", { fetch: async () => ({ ok: false, status: 500 }) });
  await assert.rejects(bad.call("paranoid_blockCount", []), (e) => e.kind === "transport" && /HTTP 500/.test(e.message));
  assert.equal(redactUrl("https://user:pw@host.example:8443/v1/KEY"), "https://host.example:8443");
});

test("FixtureRpc matches params when the entry has them, falls back to method-only entries, and still enforces the allowlist", async () => {
  const fx = new FixtureRpc(
    {
      calls: [
        { method: "paranoid_getTx", params: ["aa"], result: { height: 1 } },
        { method: "paranoid_getTx", params: ["bb"], result: null },
        { method: "paranoid_blockCount", result: 5 },
        { method: "paranoid_getObjectInstances", params: ["bad", 0, 16], error: { code: -32000, message: "contract: Encoding" } },
        { method: "paranoid_submitTxIntent", params: ["deadbeef"], result: "would be a txid" },
      ],
    },
    "noid"
  );
  assert.deepEqual(await fx.call("paranoid_getTx", ["aa"]), { height: 1 });
  assert.equal(await fx.call("paranoid_getTx", ["bb"]), null);
  assert.equal(await fx.call("paranoid_blockCount", [7]), 5);
  await assert.rejects(fx.call("paranoid_getTx", ["cc"]), (e) => e.kind === "fixture");
  await assert.rejects(fx.call("paranoid_getObjectInstances", ["bad", 0, 16]), (e) => e.kind === "remote" && e.code === -32000);
  await assert.rejects(fx.call("paranoid_submitTxIntent", ["deadbeef"]), (e) => e.kind === "refused");
});
