"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("http");
const fs = require("fs");
const path = require("path");
const { createServer, parseArgs } = require("../server");
const F = require("./actions-fixtures");
const { registerToken, withToken } = require("./helpers");

const APP = path.join(__dirname, "..");
const BASE = { mock: false, host: "127.0.0.1", config: path.join(APP, "swaps.json"), mockDir: path.join(APP, "mock") };
const TX = "0x" + "ab".repeat(32);

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
        resolve({ status: res.statusCode, headers: res.headers, text, json });
      });
    });
    req.on("error", reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

/** The server in actions mode over temp folders, with a fake `wsl.exe` that writes the files the helpers would. */
async function withActions(o, fn) {
  const f = F.makeFolders();
  const log = [];
  let seq = 0;
  const hold = { cb: null };
  const exec = (file, args, opts, cb) => {
    const si = args.findIndex((a) => /\.sh$/.test(a));
    const script = si >= 0 ? path.basename(args[si]) : "inline";
    const flags = si >= 0 ? args.slice(si + 1) : [];
    log.push({ script, flags, args });
    const n = String(100000 + ++seq);
    const done = () => {
      if (script === "lock.sh" && flags.includes("--dry-run")) f.write(`eth-lock-${n}.json`, F.lockDry());
      else if (script === "lock.sh") {
        f.write(`eth-lock-${n}.json`, { lockId: F.LOCK_ID, txHash: TX, blockNumber: 1 });
      } else if (script === "fund.sh") {
        if (flags.includes("--dry-run")) {
          const objFile = path.join(f.pub, "swap.object.json");
          const asLinux = objFile.replace(/\\/g, "/").replace(/^([A-Za-z]):/, (m, l) => "/mnt/" + l.toLowerCase());
          let sha = "00".repeat(32);
          try {
            sha = require("crypto").createHash("sha256").update(fs.readFileSync(objFile)).digest("hex");
          } catch {
            /* none */
          }
          return cb(null, F.fundDry({ objPath: asLinux, sha }), "");
        }
        f.write("funded.marker", "2026-11-06T11:46:09Z\n");
        return cb(null, "funding 10.000000 NOID (once) at 11:46:09 UTC\n", "");
      } else if (script === "check-object.sh") return cb(null, '{"claim_authority": "o1x"}\n', "object file OK: its opening is byte-for-byte the swap file's; fund exactly this address: o1x\n"); // the real helper: JSON on stdout, the verdict on STDERR
      cb(null, "", "");
    };
    if (o.deferred) hold.cb = done;
    else done();
  };
  if (o.objectFile !== false) fs.writeFileSync(path.join(f.pub, "swap.object.json"), JSON.stringify({ address: "o1rootplaceholder" }));
  const server = createServer({ ...BASE, runDirs: [f.run, f.pub], allowActions: true, skipFolderCheck: true, wslDistro: "Ubuntu-24.04", wslRunDir: "/home/u/live-run-5", helpersDir: "/home/u/live-run-5/bin", repoLiveDir: "/mnt/c/repo/scripts/live", actionsDeps: { exec, spawnDetached: () => ({ unref() {}, on() {} }), pollWatch: false }, ...(o.opts || {}) });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = registerToken(server);
  const token = server.runToken;
  const ok = { origin: `http://127.0.0.1:${port}`, "content-type": "application/json", "x-swap-token": token, "sec-fetch-site": "same-origin" };
  const post = (p, body, headers = ok) => raw(port, { method: "POST", path: p, headers, body: typeof body === "string" ? body : JSON.stringify(body) });
  try {
    await fn({ port, server, token, ok, post, f, log, hold });
  } finally {
    await new Promise((r) => server.close(r));
    f.cleanup();
  }
}

test("args: --allow-actions and its options; the mode is off by default", () => {
  const o = parseArgs(["--run", "A", "--run", "B", "--allow-actions", "--audit-dir", "C", "--run-number", "7", "--repo-live-dir", "/r/scripts/live"]);
  assert.equal(o.allowActions, true);
  assert.equal(o.auditDir, "C");
  assert.equal(o.runNumber, 7);
  assert.equal(o.repoLiveDir, "/r/scripts/live");
  assert.equal(parseArgs([]).allowActions, false);
});
/** A server for a start-up test: its run-folder lock is let go at once (several servers on one folder in one test). */
const made = (o) => {
  const s = createServer(o);
  if (s.runLock) s.runLock.release();
  return s;
};


test("start-up guards: loopback only, a run folder, a public copy directory, a run number", () => {
  const f = F.makeFolders();
  try {
    const good = { ...BASE, runDirs: [f.run, f.pub], allowActions: true, skipFolderCheck: true, wslDistro: "U", wslRunDir: "/home/u/live-run-5", helpersDir: "/home/u/live-run-5/bin", repoLiveDir: "/r/scripts/live" };
    assert.ok(made(good).actions, "good configuration");
    assert.throws(() => createServer({ ...good, host: "0.0.0.0" }), /127\.0\.0\.1/);
    assert.throws(() => createServer({ ...good, runDirs: [] }), /--run RUN_FOLDER/);
    assert.throws(() => createServer({ ...good, runDirs: [f.run] }), /public copy directory/);
    assert.ok(made({ ...good, runDirs: [f.run], auditDir: f.pub }).actions, "--audit-dir stands in for the second --run");
    assert.throws(() => createServer({ ...good, wslRunDir: "/home/u/somewhere" }), /run number/);
    assert.ok(made({ ...good, wslRunDir: "/home/u/somewhere", helpersDir: "/home/u/somewhere/bin", runNumber: 9 }).actions);
    assert.throws(() => createServer({ ...good, auditDir: path.join(f.base, "does-not-exist") }));
    assert.equal(made({ ...good, allowActions: false }).actions, null);
    assert.equal(made({ ...good, allowActions: true }).runToken.length, 48, "implies the read-only runner and its token");
  } finally {
    f.cleanup();
  }
});

test("off by default: every action route is refused, even with a well-formed request", async () => {
  const f = F.makeFolders();
  const server = createServer({ ...BASE, runDirs: [f.run] });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = registerToken(server);
  try {
    for (const p of ["/api/action", "/api/spend", "/api/funded", "/api/newswap"]) {
      const r = await raw(port, { method: "POST", path: p, headers: { origin: `http://127.0.0.1:${port}`, "content-type": "application/json", "x-swap-token": "x" }, body: "{}" });
      assert.equal(r.status, 403, p);
      assert.match(r.json.error, /actions mode is off/);
    }
    assert.equal((await raw(port, { path: "/api/run" })).json.actions.enabled, false);
    assert.equal((await raw(port, { path: "/api/health" })).json.operator.actions_enabled, false);
  } finally {
    await new Promise((r) => server.close(r));
    f.cleanup();
  }
});

test("transport checks on every action route: token, Origin, fetch metadata, content type, body, Host; nothing runs and nothing is logged", async () => {
  await withActions({}, async ({ port, server, token, ok, post, log }) => {
    const bodies = { "/api/action": '{"id":"tick-bob"}', "/api/spend": '{"id":"send-lock","typed":"0.001 ETH"}', "/api/funded": '{"checked":true}', "/api/newswap": '{"fields":{}}' };
    for (const [p, body] of Object.entries(bodies)) {
      const t = (h, b = body) => post(p, b, h);
      assert.equal((await t({ ...ok, "x-swap-token": undefined })).status, 403, p + " no token");
      assert.equal((await t({ ...ok, "x-swap-token": "0".repeat(48) })).status, 403, p + " wrong token");
      assert.equal((await t({ ...ok, "x-swap-token": token.slice(0, -1) })).status, 403, p + " short token");
      assert.equal((await t({ ...ok, origin: undefined })).status, 403, p + " no Origin");
      assert.equal((await t({ ...ok, origin: "http://evil.example" })).status, 403, p + " foreign Origin");
      assert.equal((await t({ ...ok, origin: `http://localhost:${port}` })).status, 403, p + " Origin that is not the Host");
      assert.equal((await t({ ...ok, origin: "null" })).status, 403, p + " opaque Origin");
      assert.equal((await t({ ...ok, "sec-fetch-site": "cross-site" })).status, 403, p + " cross-site");
      assert.equal((await t({ ...ok, "sec-fetch-site": "same-site" })).status, 403, p + " same-site is not same-origin");
      assert.equal((await t({ ...ok, "content-type": "text/plain" })).status, 415, p + " form content type");
      assert.equal((await t({ ...ok, "content-type": "application/x-www-form-urlencoded" })).status, 415, p + " urlencoded");
      assert.equal((await t(ok, "not json")).status, 400, p + " not JSON");
      assert.equal((await t(ok, "[1]")).status, 400, p + " array");
      assert.equal((await t(ok, "null")).status, 400, p + " null");
      assert.equal((await raw(port, { method: "POST", path: p, headers: { ...ok, host: "evil.example" }, body })).status, 403, p + " rebound Host");
      assert.equal((await raw(port, { method: "POST", path: p, headers: { ...ok, host: `127.0.0.1:${port + 1}` }, body })).status, 403, p + " wrong port");
      assert.equal((await raw(port, { method: "GET", path: p, headers: {} })).status, 404, p + " GET is not a route");
    }
    assert.equal((await post("/api/action", JSON.stringify({ id: "tick-bob", pad: "x".repeat(900) }))).status, 413);
    assert.equal((await post("/api/spend", JSON.stringify({ id: "send-lock", typed: "x", pad: "x".repeat(900) }))).status, 413);
    assert.equal((await post("/api/newswap", JSON.stringify({ fields: { pad: "x".repeat(5000) } }))).status, 413);
    for (const m of ["PUT", "DELETE", "PATCH"]) assert.equal((await raw(port, { method: m, path: "/api/action", headers: ok })).status, 405);
    assert.deepEqual(log, [], "no helper ran for any refused request");
    assert.equal(server.actions.audit.tail(5).length, 0, "nothing logged: requests that fail the transport checks never reach the log");
  });
});

test("reads from another site or origin are refused in actions mode; the same origin works; the token never appears in a GET", async () => {
  await withActions({}, async ({ port, token, ok }) => {
    for (const h of [{ "sec-fetch-site": "cross-site" }, { "sec-fetch-site": "same-site" }, { origin: "http://evil.example" }, { origin: `http://localhost:${port}` }]) {
      assert.equal((await raw(port, { path: "/api/run", headers: h })).status, 403, JSON.stringify(h));
      assert.equal((await raw(port, { path: "/api/health", headers: h })).status, 403, JSON.stringify(h));
    }
    const same = await raw(port, { path: "/api/run", headers: { "sec-fetch-site": "same-origin" } });
    assert.equal(same.status, 200);
    assert.equal(same.json.actions.enabled, true);
    assert.equal((await raw(port, { path: "/api/run", headers: { "sec-fetch-site": "none" } })).status, 200);
    assert.equal((await raw(port, { path: "/api/run" })).status, 200, "no fetch metadata (a curl): the Host check still applies");
    for (const p of ["/api/run", "/api/health", "/", "/operator.js", "/actions.js", "/console"]) assert.ok(!(await raw(port, { path: p })).text.includes(token), `${p} must not leak the token`);
    const h = await raw(port, { path: "/api/health" });
    assert.equal(h.json.operator.actions_enabled, true);
    assert.ok(h.json.operator.action_ids.includes("send-lock") && h.json.operator.action_ids.includes("dry-lock"));
    assert.ok(ok["x-swap-token"]);
  });
});

test("the page's script is served and nothing else of the app folder", async () => {
  await withActions({}, async ({ port }) => {
    const r = await raw(port, { path: "/actions.js" });
    assert.equal(r.status, 200);
    assert.match(r.headers["content-type"], /javascript/);
    assert.ok(!/(^|[^a-z])(https?:)?\/\/(?!127\.0\.0\.1|localhost)[a-z0-9.-]+\.[a-z]{2,}/i.test(r.text.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "")), "no external request");
    assert.ok(!/\.style\b|setAttribute\(["']style/.test(r.text) && !/\son[a-z]+=/.test(r.text), "no inline style or handler");
    for (const p of ["/lib/actions.js", "/lib/gate.js", "/lib/audit.js", "/lib/actionroutes.js", "/test/actions.test.js"]) assert.equal((await raw(port, { path: p })).status, 404, p);
    const idx = (await raw(port, { path: "/" })).text;
    assert.match(idx, /src="\/actions\.js"/);
    assert.ok(!/<style|\sstyle=|\son[a-z]+=/i.test(idx));
  });
});

test("a lock end to end: dry run, the view says eligible, a wrong typed text is refused, the right one runs the helper once, the log shows it", async () => {
  await withActions({}, async ({ port, ok, post, log, f }) => {
    f.writeTick("bob", F.spendTick("lock_eth"));
    const view = async () => (await raw(port, { path: "/api/run", headers: { "sec-fetch-site": "same-origin" } })).json.actions;
    let a = await view();
    assert.equal(a.spends["send-lock"].relevant, true);
    assert.equal(a.spends["send-lock"].eligible, false);
    assert.ok(a.spends["send-lock"].reasons.some((r) => r.code === "dry_missing"));

    const noDry = await post("/api/spend", { id: "send-lock", typed: "0.001 ETH" });
    assert.equal(noDry.status, 422);
    assert.ok(noDry.json.reasons.some((r) => r.code === "dry_missing"));

    const dry = await post("/api/action", { id: "dry-lock" });
    assert.equal(dry.status, 202);
    assert.equal(dry.json.job.id, "dry-lock");
    a = await view();
    assert.equal(a.busy, null);
    assert.equal(a.spends["send-lock"].eligible, true, JSON.stringify(a.spends["send-lock"].reasons));
    assert.equal(a.spends["send-lock"].dry.all_ok, true);
    assert.ok(a.spends["send-lock"].dry.rows.length >= 8);
    assert.equal(a.spends["send-lock"].expected_typed, "0.001 ETH");
    assert.match(a.spends["send-lock"].plain.lines.join(" "), /real transaction/);

    for (const typed of ["", "0.001", "1 ETH", "0.001 NOID", "yes"]) {
      const r = await post("/api/spend", { id: "send-lock", typed });
      assert.equal(r.status, 422, typed);
      assert.deepEqual(r.json.reasons.map((x) => x.code), ["typed"], typed);
    }
    assert.equal((await post("/api/spend", { id: "send-lock" })).status, 400, "no typed field");
    assert.equal((await post("/api/spend", { id: "send-lock", typed: 5 })).status, 400);
    assert.equal((await post("/api/spend", { id: "send-lock", typed: "x".repeat(41) })).status, 400);
    assert.equal((await post("/api/spend", { id: "dry-lock", typed: "0.001 ETH" })).status, 400, "a dry-run id is not a spend");
    assert.equal((await post("/api/action", { id: "send-lock" })).status, 400, "a spend id is not a plain action");
    assert.equal(log.filter((c) => c.script === "lock.sh" && !c.flags.includes("--dry-run")).length, 0);

    const sent = await post("/api/spend", { id: "send-lock", typed: "0.001 ETH" });
    assert.equal(sent.status, 202, JSON.stringify(sent.json));
    assert.equal(log.filter((c) => c.script === "lock.sh" && !c.flags.includes("--dry-run")).length, 1);
    a = await view();
    const job = a.jobs.find((j) => j.id === "send-lock");
    assert.equal(job.tx, TX);
    assert.match(job.next, /Do not send it a second time/);
    const rows = a.audit.tail.filter((r) => r.action === "send-lock");
    assert.ok(rows.filter((r) => r.phase === "refused").length >= 5, "the refused attempts are logged too");
    assert.ok(rows.some((r) => r.phase === "start" && r.dry_hash === job.dry_hash));
    assert.ok(rows.some((r) => r.phase === "end" && r.tx === TX));
    assert.equal(a.audit.chain.ok, true);
    // the jsonl file is on disk in the public copy directory
    assert.ok(fs.existsSync(path.join(f.pub, "ui-audit.jsonl")));
    assert.ok(!fs.existsSync(path.join(f.run, "ui-audit.jsonl")), "not in the run folder");
    void ok;
  });
});

test("two requests at once: the second is refused with 409 while the first runs", async () => {
  await withActions({ deferred: true }, async ({ post, hold, log, server }) => {
    const first = await post("/api/action", { id: "tick-bob" });
    assert.equal(first.status, 202);
    assert.equal(first.json.job.state, "running");
    for (const [p, body] of [["/api/action", { id: "tick-alice" }], ["/api/action", { id: "install" }], ["/api/spend", { id: "send-lock", typed: "0.001 ETH" }]]) {
      const r = await post(p, body);
      assert.equal(r.status, 409, JSON.stringify(body));
    }
    assert.equal(log.length, 1);
    hold.cb();
    assert.equal(server.actions.busy, null);
    const next = await post("/api/action", { id: "check-object" });
    assert.equal(next.status, 202);
  });
});

test("the funding acknowledgement needs a good check-object first and executes nothing", async () => {
  await withActions({}, async ({ post, log, server }) => {
    assert.equal((await post("/api/funded", { checked: true })).status, 409);
    assert.equal((await post("/api/funded", { checked: false })).status, 400);
    assert.equal((await post("/api/funded", {})).status, 400);
    assert.equal((await post("/api/action", { id: "check-object" })).status, 202);
    const n = log.length;
    assert.equal((await post("/api/funded", { checked: true })).status, 200);
    assert.equal(log.length, n);
    assert.equal(server.actions.audit.tail(1)[0].action, "funded-ack");
  });
});

test("the new-swap form over HTTP: strict validation, nothing written on error, written once, never echoed back", async () => {
  await withActions({}, async ({ post, f, server }) => {
    const fields = { role: "both", run: "5", profile: "sepolia", lock_kind: "poseidon", noid_amount: "10", eth_amount: "0.001", alice_noid: "o1lqvrmvsyl7mkt3cptkz3c965ujt5ce6mjawxwwxe7mgn36mjzt8sn69xw2", bob_noid: "o125qayvgtmvqnlhqmqwe08dza3acaax5mct3u5h4uen3qtrds3jfset7wlk", alice_eth: "0x" + "a".repeat(40), bob_eth: "0x" + "b".repeat(40), contract: "0x" + "c".repeat(40), single_node_ok: true };
    const bad = await post("/api/newswap", { fields: { ...fields, eth_amount: "1", contract: "0x12; id", run: "6" } });
    assert.equal(bad.status, 422);
    assert.deepEqual(Object.keys(bad.json.errors).sort(), ["contract", "eth_amount", "run"]);
    assert.ok(!fs.existsSync(path.join(f.run, "env.local.sh")), "nothing written");
    const good = await post("/api/newswap", { fields });
    assert.equal(good.status, 200, JSON.stringify(good.json));
    assert.equal(good.json.written, true);
    for (const v of [fields.alice_noid, fields.bob_noid, fields.alice_eth, fields.contract]) assert.ok(!good.text.includes(v), "the response does not echo the values");
    const text = fs.readFileSync(path.join(f.run, "env.local.sh"), "utf8");
    assert.match(text, /^ALICE_NOID='o1lqvrmvsyl7/m);
    assert.match(text, /^SINGLE_NODE_OK='1'$/m);
    const again = await post("/api/newswap", { fields });
    assert.equal(again.status, 409);
    const replaced = await post("/api/newswap", { fields: { ...fields, noid_amount: "11" }, replace: true });
    assert.equal(replaced.status, 200);
    assert.equal(replaced.json.backup, true);
    assert.equal((await post("/api/newswap", { fields, replace: "yes" })).status, 400);
    assert.equal((await post("/api/newswap", { fields: "x" })).status, 422);
    const lines = server.actions.audit.tail(20).filter((r) => r.action === "newswap");
    assert.ok(lines.length >= 4);
    assert.ok(!JSON.stringify(lines).includes("o1lqvr") && !JSON.stringify(lines).includes("0xaaaa"), "addresses are not in the audit log");
    const view = (await raw(server.address().port, { path: "/api/run", headers: { "sec-fetch-site": "same-origin" } })).json.actions;
    assert.equal(view.form.env_local.exists, true);
    assert.ok(!JSON.stringify(view).includes("o1lqvr"), "the view never carries the settings back");
    assert.equal(view.form.run_number, 5);
  });
});

test("/api/helper is closed in actions mode; a non-ASCII token is a 403, not a crash; the run number must fit the folder name", async () => {
  await withActions({}, async ({ port, ok, post, log }) => {
    const r = await raw(port, { method: "POST", path: "/api/helper", headers: ok, body: '{"id":"tick-alice"}' });
    assert.equal(r.status, 403);
    assert.match(r.json.error, /actions/);
    assert.equal((await post("/api/action", { id: "tick-bob" }, { ...ok, "x-swap-token": "é".repeat(48) })).status, 403);
    assert.equal(log.length, 0);
  });
  const f = F.makeFolders();
  try {
    assert.throws(() => createServer({ ...BASE, runDirs: [f.run, f.pub], allowActions: true, skipFolderCheck: true, wslDistro: "U", wslRunDir: "/home/u/live-run-5", helpersDir: "/home/u/live-run-5/bin", repoLiveDir: "/r/scripts/live", runNumber: 6 }), /does not match the run folder/);
  } finally {
    f.cleanup();
  }
});

test("the form is closed once the run has swap files, and on replace it refuses a file it cannot rewrite faithfully", async () => {
  await withActions({}, async ({ post, f, server }) => {
    const fields = { role: "both", run: "5", profile: "sepolia", lock_kind: "sha256", noid_amount: "10", eth_amount: "0.001", alice_noid: "o1lqvrmvsyl7mkt3cptkz3c965ujt5ce6mjawxwwxe7mgn36mjzt8sn69xw2", bob_noid: "o125qayvgtmvqnlhqmqwe08dza3acaax5mct3u5h4uen3qtrds3jfset7wlk", alice_eth: "0x" + "a".repeat(40), bob_eth: "0x" + "b".repeat(40), contract: "0x" + "c".repeat(40) };
    assert.equal((await post("/api/newswap", { fields })).status, 200);
    assert.deepEqual(fs.readdirSync(f.run).filter((n) => n.startsWith("env.local.sh")), ["env.local.sh"], "no temp file left");
    // a hand-written line the template cannot carry
    fs.appendFileSync(path.join(f.run, "env.local.sh"), "ETH_RPC2='https://second.example/rpc'\nMAX_FEE_GWEI=30\n");
    const refused = await post("/api/newswap", { fields, replace: true });
    assert.equal(refused.status, 409);
    assert.match(refused.json.error, /sets ETH_RPC2, MAX_FEE_GWEI, which this form cannot write/, "neither a second node nor the mainnet fee cap (MAX_FEE_GWEI: production only) can be written by the form");
    assert.match(fs.readFileSync(path.join(f.run, "env.local.sh"), "utf8"), /ETH_RPC2/, "untouched");
    // a line the form CAN write, left empty in the submission, would vanish from a replaced file: refused and named
    fs.writeFileSync(path.join(f.run, "env.local.sh"), "PROFILE='sepolia'\nHC_LEAD=40\nDEPLOY_BLOCK=12072004\n");
    const dropped = await post("/api/newswap", { fields: { ...fields, hc_lead: "40" }, replace: true });
    assert.equal(dropped.status, 409);
    assert.match(dropped.json.error, /sets DEPLOY_BLOCK, and this form leaves it empty/);
    assert.equal(fs.readFileSync(path.join(f.run, "env.local.sh"), "utf8"), "PROFILE='sepolia'\nHC_LEAD=40\nDEPLOY_BLOCK=12072004\n", "untouched");
    // with every optional line the old file had filled in, the replace goes through and keeps them
    const kept = await post("/api/newswap", { fields: { ...fields, hc_lead: "40", deploy_block: "12072004" }, replace: true });
    assert.equal(kept.status, 200, JSON.stringify(kept.json));
    const text = fs.readFileSync(path.join(f.run, "env.local.sh"), "utf8");
    assert.match(text, /^HC_LEAD='40'$/m);
    assert.match(text, /^DEPLOY_BLOCK='12072004'$/m);
    // a swap file: settings are fixed
    fs.writeFileSync(path.join(f.run, "alice.swap.json"), "{}");
    const closed = await post("/api/newswap", { fields, replace: true });
    assert.equal(closed.status, 409);
    assert.match(closed.json.error, /swap files/);
    assert.ok(server.actions.audit.tail(10).some((r) => /swap files/.test(r.result)));
  });
});

// ---------------------------------------------------------------------------------------------- --role
test("--role: parsed and validated; default both", () => {
  assert.equal(parseArgs([]).role, "both");
  assert.equal(parseArgs(["--role", "alice"]).role, "alice");
  assert.equal(parseArgs(["--role", "bob"]).role, "bob");
  for (const bad of ["carol", "", "ALICE", "alice,bob"]) assert.throws(() => parseArgs(["--role", bad]), /--role must be alice, bob or both/, bad);
});

test("--role alice over HTTP: the other role's ids answer 403 with the reason and never reach a helper; /api/run hides the other role and offers only Alice's ids; the audit lines name the role", async () => {
  await withActions({ opts: { role: "alice" } }, async ({ post, port, f, log, server }) => {
    f.writeTick("bob", F.spendTick("lock_eth"));
    f.writeTick("alice", F.spendTick("fund_noid"));
    for (const [p, body] of [["/api/action", { id: "tick-bob" }], ["/api/action", { id: "dry-lock" }], ["/api/action", { id: "dry-claim" }], ["/api/spend", { id: "send-lock", typed: "0.001 ETH" }], ["/api/spend", { id: "send-claim", typed: "10 NOID" }]]) {
      const r = await post(p, body);
      assert.equal(r.status, 403, JSON.stringify(body));
      assert.match(r.json.error, /started with --role alice: .* belongs to bob, which runs on another machine/);
    }
    assert.equal(log.length, 0, "nothing reached a helper");
    const ok = await post("/api/action", { id: "tick-alice" });
    assert.equal(ok.status, 202);
    const run = await raw(port, { path: "/api/run", headers: { "sec-fetch-site": "same-origin" } });
    assert.equal(run.status, 200);
    assert.equal(run.json.role, "alice");
    assert.equal(run.json.roles.bob, null, "the other role's files are not shown (an old copy, another machine's tick)");
    assert.ok(run.json.roles.alice && run.json.roles.alice.tick);
    assert.ok(run.json.actions.table.filter((e) => !e.blocked).every((e) => !e.role || e.role === "alice"));
    assert.equal(run.json.actions.table.find((e) => e.id === "tick-bob").blocked.includes("another machine"), true);
    assert.equal(server.actions.audit.tail(5).every((r) => r.srv_role === "alice"), true);
    assert.equal(server.actions.audit.tail(5).length > 0, true);
  });
});

test("the default role is both: nothing is blocked and /api/run says so", async () => {
  await withActions({}, async ({ post, port, f }) => {
    f.writeTick("bob", F.spendTick("lock_eth"));
    f.writeTick("alice", F.spendTick("fund_noid"));
    const run = await raw(port, { path: "/api/run", headers: { "sec-fetch-site": "same-origin" } });
    assert.equal(run.json.role, "both");
    assert.ok(run.json.roles.alice && run.json.roles.bob);
    assert.equal(run.json.actions.table.some((e) => e.blocked), false);
    assert.equal((await post("/api/action", { id: "tick-bob" })).status, 202);
  });
});

// ---------------------------------------------------------------------------------------------- send-fund, the acknowledgement and --role bob over HTTP
test("/api/spend send-fund over HTTP: refused as a plain action; needs the second statement; the marker closes /api/funded and funding for good", { skip: F.WSL_HOST_ONLY }, async () => {
  await withActions({ opts: { role: "alice" } }, async ({ post, f, log, server }) => {
    f.writeTick("alice", F.spendTick("fund_noid"));
    // a spend id is never a plain action
    assert.equal((await post("/api/action", { id: "send-fund" })).status, 400);
    assert.equal(log.length, 0);
    // dry run, then the spend without / with a wrong / with the statement
    assert.equal((await post("/api/action", { id: "dry-fund" })).status, 202);
    await new Promise((r) => setTimeout(r, 2100)); // MIN_GAP_MS between runs of one id is per id; the dry run is the only one so far
    const noStmt = await post("/api/spend", { id: "send-fund", typed: "10 NOID" });
    assert.equal(noStmt.status, 422);
    assert.deepEqual(noStmt.json.reasons.map((r) => r.code), ["statement", "statement_bob_check"]);
    assert.equal((await post("/api/spend", { id: "send-fund", typed: "10 NOID", no_pending_funding: false, bob_check_matches: true })).status, 422);
    assert.equal((await post("/api/spend", { id: "send-fund", typed: "10 NOID", no_pending_funding: "yes", bob_check_matches: true })).status, 400);
    // the statement about Bob's check line: missing or false is the gate's refusal, a non-boolean is a bad request
    const noBob = await post("/api/spend", { id: "send-fund", typed: "10 NOID", no_pending_funding: true });
    assert.equal(noBob.status, 422);
    assert.deepEqual(noBob.json.reasons.map((r) => r.code), ["statement_bob_check"]);
    assert.equal((await post("/api/spend", { id: "send-fund", typed: "10 NOID", no_pending_funding: true, bob_check_matches: false })).status, 422);
    assert.equal((await post("/api/spend", { id: "send-fund", typed: "10 NOID", no_pending_funding: true, bob_check_matches: "yes" })).status, 400);
    assert.equal(log.filter((l) => l.script === "fund.sh" && l.flags.length === 0).length, 0, "no real fund.sh yet");
    const sent = await post("/api/spend", { id: "send-fund", typed: "10 NOID", no_pending_funding: true, bob_check_matches: true });
    assert.equal(sent.status, 202, JSON.stringify(sent.json));
    assert.equal(sent.json.job.funded_marker, "2026-11-06T11:46:09Z");
    assert.equal(log.filter((l) => l.script === "fund.sh" && l.flags.length === 0).length, 1, "fund.sh ran once, without --dry-run");
    const start = server.actions.audit.all().find((r) => r.action === "send-fund" && r.phase === "start");
    assert.match(start.detail, /statement=no_pending_funding; statement=bob_check_line_matches/);
    // the acknowledgement is closed now (a marker exists; a send-fund was started), and funding is not offered any more
    await post("/api/action", { id: "check-object" });
    const ack = await post("/api/funded", { checked: true });
    assert.equal(ack.status, 409);
    assert.match(ack.json.error, /funded\.marker|send-fund was started/);
    await new Promise((r) => setTimeout(r, 2100)); // past the per-id minimum gap, so the refusal below is the gate's
    assert.equal((await post("/api/spend", { id: "send-fund", typed: "10 NOID", no_pending_funding: true, bob_check_matches: true })).status, 422);
  });
});

test("/api/funded over HTTP: writes the markers (the run folder's and the contract's), closes funding for good, and refuses a second console's fund.sh through them", async () => {
  await withActions({ opts: { role: "alice" } }, async ({ post, f, server }) => {
    f.writeTick("alice", F.spendTick("fund_noid"));
    assert.equal((await post("/api/funded", { checked: true })).status, 409, "needs a good check-object first");
    assert.equal((await post("/api/action", { id: "check-object" })).status, 202);
    const ack = await post("/api/funded", { checked: true });
    assert.equal(ack.status, 200);
    assert.match(server.actions.audit.tail(1)[0].detail, /^marker=none; wrote funded\.marker and the contract's marker$/);
    const mk = fs.readFileSync(path.join(f.run, "funded.marker"), "utf8").split("\n");
    assert.match(mk[0], /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);
    assert.equal(mk[1], "acknowledged: funded outside fund.sh");
    assert.equal(fs.readFileSync(path.join(f.pub, "funded-" + F.TERMS.contract_root + ".marker"), "utf8").split("\n")[1], "acknowledged: funded outside fund.sh");
    // asking again changes nothing; a console that is told by the marker alone (no audit memory) is refused with 409
    const again = await post("/api/funded", { checked: true });
    assert.equal(again.status, 200);
    assert.equal(again.json.already, true);
    await new Promise((r) => setTimeout(r, 2100));
    assert.equal((await post("/api/action", { id: "dry-fund" })).status, 202);
    const refused = await post("/api/spend", { id: "send-fund", typed: "10 NOID", no_pending_funding: true, bob_check_matches: true });
    assert.equal(refused.status, 422);
    assert.ok(refused.json.reasons.some((r) => r.code === "already_sent" && /acknowledged/.test(r.text)), JSON.stringify(refused.json.reasons));
  });
});

test("--role bob over HTTP: prepare, check-object, the funding dry run and spend, and the acknowledgement are Alice's and answer 403", async () => {
  await withActions({ opts: { role: "bob" } }, async ({ post, log }) => {
    for (const id of ["prepare", "check-object", "dry-fund", "tick-alice", "dry-reveal"]) {
      const r = await post("/api/action", { id });
      assert.equal(r.status, 403, id);
      assert.match(r.json.error, /started with --role bob: .* belongs to alice, which runs on another machine/, id);
    }
    for (const id of ["send-fund", "send-reveal"]) assert.equal((await post("/api/spend", { id, typed: "10 NOID", no_pending_funding: true, bob_check_matches: true })).status, 403, id);
    const ack = await post("/api/funded", { checked: true });
    assert.equal(ack.status, 403);
    assert.match(ack.json.error, /--role bob/);
    assert.equal(log.length, 0, "nothing reached a helper");
    // Bob's own ids still work; install/setup (no role) too
    assert.equal((await post("/api/action", { id: "tick-bob" })).status, 202);
  });
});

test("the settings form: a console on one role refuses the other role's settings; NOID_CLI and OBJ are not fields", async () => {
  await withActions({ opts: { role: "alice" } }, async ({ post, f }) => {
    const fields = { role: "bob", run: "5", profile: "sepolia", lock_kind: "sha256", noid_amount: "10", eth_amount: "0.001", alice_noid: "o1lqvrmvsyl7mkt3cptkz3c965ujt5ce6mjawxwwxe7mgn36mjzt8sn69xw2", bob_noid: "o125qayvgtmvqnlhqmqwe08dza3acaax5mct3u5h4uen3qtrds3jfset7wlk", alice_eth: "0x" + "a".repeat(40), bob_eth: "0x" + "b".repeat(40), contract: "0x" + "c".repeat(40) };
    const wrongRole = await post("/api/newswap", { fields });
    assert.equal(wrongRole.status, 422);
    assert.match(wrongRole.json.errors.role, /started with --role alice/);
    const cli = await post("/api/newswap", { fields: { ...fields, role: "alice", noid_cli: "/tmp/evil" } });
    assert.equal(cli.status, 422);
    assert.equal(cli.json.errors.noid_cli, "unknown field");
    const obj = await post("/api/newswap", { fields: { ...fields, role: "alice", obj: "/tmp/evil.json" } });
    assert.equal(obj.json.errors.obj, "unknown field");
    assert.equal(fs.existsSync(path.join(f.run, "env.local.sh")), false, "nothing written");
    assert.equal((await post("/api/newswap", { fields: { ...fields, role: "alice" } })).status, 200);
  });
});

// ---------------------------------------------------------------------------------------------- L1/L3: one console per folder, the same folder, the read-only runner
test("L1: a second console on the same run folder refuses to start; the lock is let go when the first closes; a stale lock is replaced", async () => {
  const f = F.makeFolders();
  try {
    const opts = { ...BASE, runDirs: [f.run, f.pub], allowActions: true, skipFolderCheck: true, wslDistro: "U", wslRunDir: "/home/u/live-run-5", helpersDir: "/home/u/live-run-5/bin", repoLiveDir: "/r/scripts/live" };
    const a = createServer(opts);
    assert.ok(fs.existsSync(path.join(f.run, "ui-console.lock")));
    assert.throws(() => createServer(opts), /another console is already running on this run folder \(pid \d+/);
    assert.throws(() => createServer({ ...opts, runDirs: [f.run, f.pub], role: "alice" }), /already running/, "whatever the role");
    await new Promise((r) => a.close(r));
    assert.equal(fs.existsSync(path.join(f.run, "ui-console.lock")), false, "released on close");
    // a stale lock (the pid is gone) is replaced, and the server says so
    fs.writeFileSync(path.join(f.run, "ui-console.lock"), JSON.stringify({ pid: 2 ** 31 - 2, started: "2026-11-01T00:00:00Z" }) + "\n");
    const b = createServer(opts);
    assert.equal(b.runLock.replaced.pid, 2 ** 31 - 2);
    await new Promise((r) => b.close(r));
    // the lock does not stop the read-only modes
    const ro = createServer({ ...BASE, runDirs: [f.run], allowRunReadonly: true, wslDistro: "U", wslRunDir: "/home/u/live-run-5", helpersDir: "/home/u/live-run-5/bin" });
    assert.equal(ro.runLock, null);
  } finally {
    f.cleanup();
  }
});

test("L1: the folder read and the folder the helpers get as L must be shown to be the same, or actions mode is not enabled", () => {
  const f = F.makeFolders();
  try {
    const good = { ...BASE, runDirs: ["//wsl.localhost/Ubuntu-24.04/home/u/live-run-5", f.pub], allowActions: true, repoLiveDir: "/r/scripts/live" };
    // explicit helper settings that name another folder, another distro, or a read path that is no WSL share
    assert.throws(() => createServer({ ...good, wslRunDir: "/home/u/elsewhere/live-run-5", helpersDir: "/home/u/elsewhere/live-run-5/bin", runNumber: 5 }), /cannot be shown to be the folder the helpers get as L/);
    assert.throws(() => createServer({ ...good, wslDistro: "Other", runNumber: 5 }), /cannot be shown/);
    assert.throws(() => createServer({ ...good, runDirs: [f.run, f.pub], wslDistro: "Ubuntu-24.04", wslRunDir: "/home/u/live-run-5", helpersDir: "/home/u/live-run-5/bin" }), /cannot be shown/, "a Windows temp folder is not /home/u/live-run-5");
    // and nothing was locked by the refusals
    assert.equal(fs.existsSync(path.join(f.run, "ui-console.lock")), false);
  } finally {
    f.cleanup();
  }
});

test("L3: the read-only runner starts through wsl.exe -e like the actions runner, and refuses to start without a run number", () => {
  const s = createServer({ ...BASE, runDirs: ["//wsl.localhost/Ubuntu-24.04/home/u/live-run-7"], allowRunReadonly: true });
  const cmd = require("../lib/runner").buildCommand("check-object", s.runner.cfg);
  assert.deepEqual(cmd.args.slice(0, 5), ["-d", "Ubuntu-24.04", "-e", "env", "RUN=7"]);
  assert.ok(!cmd.args.includes("--"));
  assert.match(cmd.display, /^wsl\.exe -d Ubuntu-24\.04 -e env RUN=7 L=/);
  assert.throws(() => createServer({ ...BASE, runDirs: ["//wsl.localhost/Ubuntu-24.04/home/u/copy"], allowRunReadonly: true }), /no run number can be derived/);
  assert.ok(createServer({ ...BASE, runDirs: ["//wsl.localhost/Ubuntu-24.04/home/u/copy"], allowRunReadonly: true, runNumber: 3 }).runner.cfg.runNumber === 3);
});

test("C2 over HTTP: when the run folder's lock file names another console, a spend is refused (409) before the gate and nothing runs; the message says what to delete", async () => {
  await withActions({ opts: { role: "bob" } }, async ({ post, f, log, server }) => {
    f.writeTick("bob", F.spendTick("lock_eth"));
    assert.equal((await post("/api/action", { id: "dry-lock" })).status, 202);
    const lockFile = server.runLock.file;
    assert.equal(server.runLock.verify().ok, true);
    const mine = fs.readFileSync(lockFile, "utf8");
    fs.writeFileSync(lockFile, JSON.stringify({ pid: process.pid + 1, started: "2026-11-06T12:00:05Z", role: "bob" }) + "\n");
    const n = log.length;
    const r = await post("/api/spend", { id: "send-lock", typed: "0.001 ETH" });
    assert.equal(r.status, 409, r.text);
    assert.match(r.json.error, /no longer holds the run folder's lock/);
    assert.ok(r.json.error.includes(`delete ${lockFile}`));
    assert.equal(log.length, n, "no helper ran");
    assert.equal(server.actions.audit.all().some((x) => x.action === "send-lock" && x.phase === "start"), false);
    // every other state-changing route needs the lock too, with the same text, and leaves a refused line
    for (const [route, body, id] of [["/api/action", { id: "tick-bob" }, "tick-bob"], ["/api/action", { id: "dry-lock" }, "dry-lock"], ["/api/action", { id: "watch-start" }, "watch-start"], ["/api/newswap", { fields: {}, replace: false }, "newswap"]]) {
      const x = await post(route, body);
      assert.equal(x.status, 409, id + " " + x.text);
      assert.match(x.json.error, /no longer holds the run folder's lock/);
      assert.ok(server.actions.audit.all().some((l) => l.action === id && l.phase === "refused" && /run lock not ours/.test(l.result)), id);
    }
    assert.equal(log.length, n, "still no helper ran");
    fs.writeFileSync(lockFile, mine); // ours again (so the server can release it cleanly)
    assert.equal((await post("/api/action", { id: "tick-bob" })).status, 202);
  });
});
