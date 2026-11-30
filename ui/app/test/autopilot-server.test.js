"use strict";
// POST /api/autopilot and everything around it at the server: the transport checks, the refusals, the payload, the timer, and that a request can never make a spend
// automatic.
const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("http");
const fs = require("fs");
const path = require("path");
const { createServer } = require("../server");
const { ACTION_POSTS } = require("../lib/actionroutes");
const F = require("./actions-fixtures");
const { registerToken, withToken } = require("./helpers");
const { ALL_STATEMENTS } = require("./autopilot-harness");

const APP = path.join(__dirname, "..");
const BASE = { mock: false, host: "127.0.0.1", config: path.join(APP, "swaps.json"), mockDir: path.join(APP, "mock") };

function raw(port, { method = "GET", path: p = "/", headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const all = { host: `127.0.0.1:${port}`, ...withToken(port, method, headers) };
    for (const k of Object.keys(all)) if (all[k] === undefined) delete all[k];
    const req = http.request({ host: "127.0.0.1", port, method, path: p, headers: all }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        let json = null;
        try {
          json = JSON.parse(text);
        } catch {
          /* not json */
        }
        resolve({ status: res.statusCode, text, json });
      });
    });
    req.on("error", reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

async function withConsole(o, fn) {
  const f = F.makeFolders();
  const log = [];
  let seq = 0;
  const exec = (file, args, opts, cb) => {
    const si = args.findIndex((a) => /\.sh$/.test(a));
    const script = si >= 0 ? path.basename(args[si]) : "inline";
    log.push({ script, flags: si >= 0 ? args.slice(si + 1) : [] });
    if (script === "lock.sh" && args.includes("--dry-run")) f.write(`eth-lock-${100000 + ++seq}.json`, F.lockDry());
    cb(null, "", "");
  };
  fs.writeFileSync(path.join(f.pub, "swap.object.json"), JSON.stringify({ address: "o1rootplaceholder", claim_authority: "o1AUTH" }));
  const server = createServer({ ...BASE, runDirs: [f.run, f.pub], allowActions: true, role: "bob", skipFolderCheck: true, wslDistro: "Ubuntu-24.04", wslRunDir: "/home/u/live-run-5", helpersDir: "/home/u/live-run-5/bin", repoLiveDir: "/mnt/c/repo/scripts/live", autopilotIntervalMs: 0, actionsDeps: { exec, spawnDetached: () => ({ unref() {}, on() {} }), pollWatch: false }, ...(o.opts || {}) });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = registerToken(server);
  const ok = { origin: `http://127.0.0.1:${port}`, "content-type": "application/json", "x-swap-token": server.runToken, "sec-fetch-site": "same-origin" };
  const post = (p, body, headers = ok) => raw(port, { method: "POST", path: p, headers, body: typeof body === "string" ? body : JSON.stringify(body) });
  try {
    await fn({ server, port, ok, post, f, log });
  } finally {
    await new Promise((r) => server.close(r));
    f.cleanup();
  }
}

const ON_BOB = { on: true, role: "bob", typed: "0.001 ETH", statements: { stay_on: true, no_manual_steps: true } };

test("the route is one of the action posts, and the timer exists only in the actions mode", async () => {
  assert.ok(ACTION_POSTS.has("/api/autopilot"));
  await withConsole({}, async ({ server }) => {
    assert.ok(server.autopilot, "the autopilot belongs to the actions mode");
    assert.equal(server.autopilotTimer, null, "(these tests switch the timer off)");
  });
  await withConsole({ opts: { autopilotIntervalMs: undefined } }, async ({ server }) => {
    assert.ok(server.autopilotTimer, "a timer every 3 s in the actions mode");
  });
  // outside the actions mode: no autopilot and no timer at all
  const f = F.makeFolders();
  try {
    const s = createServer({ ...BASE, runDirs: [f.run, f.pub], allowActions: false });
    assert.equal(s.autopilot, null);
    assert.equal(s.autopilotTimer, null);
    if (s.runLock) s.runLock.release();
  } finally {
    f.cleanup();
  }
});

test("the timer calls step() every interval and stops with the server", async () => {
  await withConsole({ opts: { autopilotIntervalMs: 15 } }, async ({ server }) => {
    let n = 0;
    server.autopilot.step = () => void n++;
    await new Promise((r) => setTimeout(r, 120));
    assert.ok(n >= 3, `step ran ${n} times`);
    const at = n;
    await new Promise((r) => server.close(r)); // closed once here; withConsole's own close is a no-op afterwards
    await new Promise((r) => setTimeout(r, 60));
    assert.equal(n, at, "no step after close");
  });
});

test("transport: the same checks as the other action posts", async () => {
  await withConsole({}, async ({ port, ok, post }) => {
    const body = JSON.stringify(ON_BOB);
    assert.equal((await post("/api/autopilot", body, { ...ok, "x-swap-token": undefined })).status, 403, "no token");
    assert.equal((await post("/api/autopilot", body, { ...ok, "x-swap-token": "wrong" })).status, 403, "wrong token");
    assert.equal((await post("/api/autopilot", body, { ...ok, origin: "http://evil.example" })).status, 403, "foreign origin");
    assert.equal((await post("/api/autopilot", body, { ...ok, origin: undefined })).status, 403, "no origin");
    assert.equal((await post("/api/autopilot", body, { ...ok, "content-type": "text/plain" })).status, 415);
    assert.equal((await post("/api/autopilot", "not json")).status, 400);
    assert.equal((await post("/api/autopilot", "[1]")).status, 400);
    assert.equal((await post("/api/autopilot", { on: true })).status, 400, "no role");
    assert.equal((await raw(port, { method: "GET", path: "/api/autopilot" })).status, 404, "a GET answers nothing");
  });
  // the actions mode off: the route is closed
  const f = F.makeFolders();
  try {
    const s = createServer({ ...BASE, runDirs: [f.run, f.pub], allowActions: false });
    await new Promise((r) => s.listen(0, "127.0.0.1", r));
    const port = registerToken(s);
    const r = await raw(port, { method: "POST", path: "/api/autopilot", headers: { origin: `http://127.0.0.1:${port}`, "content-type": "application/json", "x-swap-token": s.runToken }, body: JSON.stringify(ON_BOB) });
    assert.equal(r.status, 403);
    await new Promise((res) => s.close(res));
  } finally {
    f.cleanup();
  }
});

test("on, the payload, clear and off through the route; the refusals carry their reasons", async () => {
  await withConsole({}, async ({ post, port, f, server }) => {
    f.writeTick("bob", F.spendTick("lock_eth"));
    const get = () => raw(port, { path: "/api/run" });
    let run = (await get()).json;
    assert.deepEqual(Object.keys(run.actions.autopilot).sort(), ["alice", "bob"]);
    assert.equal(run.actions.autopilot.alice.available, false, "this console is Bob's");
    assert.equal(run.actions.autopilot.bob.on, false);
    assert.equal(run.actions.autopilot.bob.expected_typed, "0.001 ETH");
    assert.deepEqual(run.actions.autopilot.bob.statements.map((s) => s.id), ["stay_on", "no_manual_steps"]);
    // refusals
    let r = await post("/api/autopilot", { ...ON_BOB, typed: "1 ETH" });
    assert.equal(r.status, 422);
    assert.deepEqual(r.json.reasons.map((x) => x.code), ["typed"]);
    r = await post("/api/autopilot", { ...ON_BOB, statements: { stay_on: true } });
    assert.equal(r.status, 422);
    assert.deepEqual(r.json.reasons.map((x) => x.code), ["statement_no_manual_steps"]);
    r = await post("/api/autopilot", { ...ON_BOB, role: "alice", typed: "10 NOID", statements: ALL_STATEMENTS });
    assert.equal(r.status, 403, "Alice's side runs on another machine");
    // on
    r = await post("/api/autopilot", ON_BOB);
    assert.equal(r.status, 200);
    assert.equal(r.json.ok, true);
    run = (await get()).json;
    const v = run.actions.autopilot.bob;
    assert.equal(v.on, true);
    assert.equal(v.terms_changed, false);
    assert.ok(v.approved_at > 0);
    assert.deepEqual(v.needs_you, []);
    assert.equal(JSON.stringify(run).includes("terms_sha256"), false, "the hash is not in the payload");
    // a needs_you and its clear
    server.autopilot.raise("bob", "send-lock", "outcome", "it may have been sent");
    run = (await get()).json;
    assert.equal(run.actions.autopilot.bob.needs_you.length, 1);
    assert.equal(run.actions.autopilot.bob.needs_you[0].spend, "send-lock");
    assert.equal((await post("/api/autopilot", { clear_needs_you: "send-claim", role: "bob" })).status, 404);
    assert.equal((await post("/api/autopilot", { clear_needs_you: "nonsense", role: "bob" })).status, 404);
    assert.equal((await post("/api/autopilot", { clear_needs_you: 5, role: "bob" })).status, 400);
    r = await post("/api/autopilot", { clear_needs_you: "send-lock", role: "bob" });
    assert.equal(r.status, 200);
    assert.deepEqual(r.json.needs_you, []);
    // off
    r = await post("/api/autopilot", { on: false, role: "bob" });
    assert.equal(r.status, 200);
    run = (await get()).json;
    assert.equal(run.actions.autopilot.bob.on, false);
    assert.equal(fs.existsSync(path.join(f.run, "autopilot-bob.json")), false);
  });
});

test("a body that carries `auto` changes nothing on /api/spend: no spend becomes automatic, no refusal reason changes", async () => {
  await withConsole({}, async ({ post, f, log }) => {
    f.writeTick("bob", F.spendTick("lock_eth"));
    assert.equal((await post("/api/autopilot", ON_BOB)).status, 200);
    const manual = await post("/api/spend", { id: "send-lock", typed: "0.001 ETH" });
    assert.equal(manual.status, 422);
    const base = manual.json.reasons.map((x) => x.code);
    assert.deepEqual(base, ["dry_missing"], "no dry run: the manual path refuses as always");
    for (const auto of [true, 1, "1", { approval: "x" }, { autopilot: true }, [true]]) {
      const r = await post("/api/spend", { id: "send-lock", typed: "0.001 ETH", auto });
      assert.equal(r.status, 422, JSON.stringify(auto));
      assert.deepEqual(r.json.reasons.map((x) => x.code), base, JSON.stringify(auto) + " changes no reason");
      // and without the typed text it is still the typed text that is missing: the body cannot supply it from the approval
      const r2 = await post("/api/spend", { id: "send-lock", typed: "", auto });
      assert.ok(r2.json.reasons.some((x) => x.code === "typed"), "the typed amount is still needed from a page");
    }
    assert.equal(log.filter((l) => l.script === "lock.sh" && !l.flags.includes("--dry-run")).length, 0, "nothing was sent");
    // route source: it passes only the two statements
    const src = fs.readFileSync(path.join(APP, "lib", "actionroutes.js"), "utf8");
    assert.equal(/meta\.auto|auto\s*:/.test(src.replace(/\/\*[\s\S]*?\*\//, "").replace(/^\s*\*.*$/gm, "")), false, "actionroutes.js never mentions `auto` in code");
  });
});
