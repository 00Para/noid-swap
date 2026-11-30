"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { createServer, readStatusFile } = require("../server");
const { loadConfig } = require("../lib/config");

const APP = path.join(__dirname, "..");

function withServer(opts, fn) {
  return new Promise((resolve, reject) => {
    const s = createServer({ mock: true, port: 0, host: "127.0.0.1", config: path.join(APP, "swaps.json"), mockDir: path.join(APP, "mock"), ...opts });
    s.listen(0, "127.0.0.1", async () => {
      const base = `http://127.0.0.1:${s.address().port}`;
      try {
        await fn(base, s.runToken);
        resolve();
      } catch (e) {
        reject(e);
      } finally {
        s.close();
      }
    });
  });
}

test("mock mode: /api/swaps serves run 1 settled and run 2 refunded-waiting-for-D", async () => {
  await withServer({}, async (base, token) => {
    const T = { headers: { "x-swap-token": token } };
    const r = await (await fetch(base + "/api/swaps", T)).json();
    assert.equal(r.mode, "mock");
    assert.equal(r.swaps.length, 2);
    const [run1, run2] = r.swaps;
    assert.equal(run1.id, "run-1");
    assert.equal(run1.phase.source, "chain-only");
    assert.equal(run1.phase.value, "settled");
    assert.equal(run1.noid.ok && !run1.noid.stale, true);
    assert.equal(run1.eth.state, "claimed");
    assert.equal(run1.eth.preimage_matches_hashlock, true);
    assert.equal(run1.noid.close_final, true);
    assert.equal(run1.engine.connected, false);
    assert.ok(run1.steps.every((s) => s.state === "done"));

    assert.equal(run2.id, "run-2");
    assert.equal(run2.phase.source, "engine");
    assert.equal(run2.phase.value, "lock_final");
    assert.equal(run2.engine.action, "wait");
    assert.match(run2.engine.reason, /waiting for D/);
    assert.equal(run2.phase.chain_only.value, "eth_refunded");
    assert.equal(run2.eth.state, "refunded");
    assert.ok(run2.noid.instance && run2.noid.instance.slot_index === 9705979);
    assert.ok(run2.timers.blocks_to_D > 0 && run2.timers.blocks_to_D <= 281514 - 281108);
    assert.equal(run2.timers.eta_D_s, run2.timers.blocks_to_D * 30);
    assert.ok(run2.receipts.some((x) => x.label === "ETH Refunded tx"));
    assert.ok(run2.checks.every((c) => c.ok));
    assert.ok(!JSON.stringify(r).includes("4e4f49444f424a33"), "the raw opening is not served");

    const one = await (await fetch(base + "/api/swaps/run-2", T)).json();
    assert.equal(one.swap.id, "run-2");
    assert.equal((await fetch(base + "/api/swaps/nope", T)).status, 404);
  });
});

test("static files, health, GET-only, no traversal", async () => {
  await withServer({}, async (base, token) => {
    const T = { headers: { "x-swap-token": token } };
    const html = await fetch(base + "/");
    assert.equal(html.status, 200);
    assert.match(html.headers.get("content-type"), /text\/html/);
    assert.match(await html.text(), /No1d Swap/);
    assert.equal((await fetch(base + "/app.js")).status, 200);
    assert.equal((await fetch(base + "/styles.css")).status, 200);
    const tokens = await fetch(base + "/tokens.css");
    assert.ok(tokens.status === 200 || tokens.status === 404);
    assert.equal((await fetch(base + "/server.js")).status, 404);
    assert.equal((await fetch(base + "/lib/rpc.js")).status, 404);
    assert.equal((await fetch(base + "/..%2Fswaps.json")).status, 404);
    assert.equal((await fetch(base + "/api/swaps", { method: "POST" })).status, 405);
    const h = await (await fetch(base + "/api/health", T)).json();
    assert.equal(h.mode, "mock");
    assert.equal(h.read_only, true);
    assert.equal(h.swaps.length, 2);
    assert.equal(html.headers.get("cache-control"), "no-store");
  });
});

test("config refuses secret-bearing files", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "noid-ui-"));
  const write = (name, obj) => {
    const p = path.join(dir, name);
    fs.writeFileSync(p, JSON.stringify(obj));
    return p;
  };
  const good = { label: "x", role: "alice", object_file: "o.json", bundle_file: "b.json", eth: { contract: "0x" + "48".repeat(20), lock_id: "0x" + "84".repeat(32) } };
  assert.equal(loadConfig(write("ok.json", { swaps: [good] }))[0].id, "x");
  assert.throws(() => loadConfig(write("bad1.json", { swaps: [{ ...good, object_file: "C:\\x\\alice.swap.json" }] })), /sealed secret/);
  assert.throws(() => loadConfig(write("bad2.json", { swaps: [{ ...good, status_file: "/home/user/bob.swap.json" }] })), /sealed secret/);
  assert.throws(() => loadConfig(write("bad3.json", { swaps: [{ ...good, bundle_file: "C:\\repo\\eth\\keys\\bob.key" }] })), /key material/);
  assert.throws(() => loadConfig(write("bad4.json", { swaps: [{ ...good, role: "carol" }] })), /role/);
  assert.throws(() => loadConfig(write("bad5.json", { swaps: [good, good] })), /duplicate/);
  assert.throws(() => readStatusFile(path.join(dir, "x.swap.json")), /sealed secret/);
  const missing = readStatusFile(path.join(dir, "missing-loop.txt"));
  assert.equal(missing.connected, false);
  assert.match(missing.reason, /engine view not connected/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("a swap whose files are missing is reported, not fatal, and the rest still render", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "noid-ui-"));
  const cfg = path.join(dir, "swaps.json");
  const base = JSON.parse(fs.readFileSync(path.join(APP, "swaps.json"), "utf8"));
  base.swaps.push({ id: "ghost", label: "ghost", role: "bob", object_file: path.join(dir, "nope.json"), eth: { contract: "0x" + "48".repeat(20), lock_id: "0x" + "84".repeat(32) } });
  fs.writeFileSync(cfg, JSON.stringify(base));
  await withServer({ config: cfg, mockDir: path.join(APP, "mock") }, async () => {}).catch((e) => {
    assert.match(e.message, /ghost\.json not found/, "mock mode needs a mock file per swap");
  });
  fs.rmSync(dir, { recursive: true, force: true });
});
