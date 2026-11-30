"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("http");
const path = require("path");
const { createServer, parseArgs, runnerConfig, hostOk } = require("../server");
const { makeRunFolder, SENTINEL, FAKE_PREIMAGE, registerToken, withToken } = require("./helpers");

const APP = path.join(__dirname, "..");
const BASE = { mock: false, host: "127.0.0.1", config: path.join(APP, "swaps.json"), mockDir: path.join(APP, "mock") };

function listen(server) {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(registerToken(server))));
}

/** A raw request: node's http allows setting Host and Origin, which fetch does not. */
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

async function withServer(opts, fn) {
  const server = createServer({ ...BASE, ...opts });
  const port = await listen(server);
  try {
    await fn({ port, server });
  } finally {
    await new Promise((r) => server.close(r));
  }
}

test("args: --run (repeatable), --demo, --allow-run-readonly and the WSL options", () => {
  const o = parseArgs(["--run", "A", "--run", "B", "--demo", "--allow-run-readonly", "--wsl-distro", "U", "--helpers-dir", "/h/bin", "--wsl-run-dir", "/h/run", "--port", "9000"]);
  assert.deepEqual(o.runDirs, ["A", "B"]);
  assert.equal(o.demo, true);
  assert.equal(o.allowRunReadonly, true);
  assert.equal(o.wslDistro, "U");
  assert.equal(o.helpersDir, "/h/bin");
  assert.equal(o.wslRunDir, "/h/run");
  const d = parseArgs([]);
  assert.equal(d.allowRunReadonly, false, "the runner is off by default");
  assert.equal(d.demo, false);
  assert.throws(() => parseArgs(["--nonsense"]), /unknown argument/);
});

test("/api/run serves the parsed run folder and never a secret", async () => {
  const run = makeRunFolder();
  await withServer({ runDirs: [run.dir] }, async ({ port }) => {
    const r = await raw(port, { path: "/api/run" });
    assert.equal(r.status, 200);
    assert.equal(r.json.mode, "run");
    assert.equal(r.json.roles.alice.tick.phase_after, "lock_final");
    assert.equal(r.json.runner.enabled, false);
    for (const needle of [SENTINEL, FAKE_PREIMAGE.slice(2), "4e4f49444f424a33"]) assert.ok(!r.text.includes(needle), `served ${needle.slice(0, 10)}`);
    assert.equal(r.headers["cache-control"], "no-store");
    assert.match(r.headers["content-security-policy"], /frame-ancestors 'none'/);
    assert.equal(r.headers["cross-origin-resource-policy"], "same-origin");
    const h = await raw(port, { path: "/api/health" });
    assert.equal(h.json.operator.run_readonly_enabled, false);
    assert.equal(h.json.operator.start_in_demo, false);
    assert.deepEqual(h.json.operator.helper_ids, []);
  });
  run.cleanup();
});

test("no run folder: the page starts on the demo; /api/demo works either way", async () => {
  await withServer({ runDirs: [] }, async ({ port }) => {
    assert.equal((await raw(port, { path: "/api/health" })).json.operator.start_in_demo, true);
    const d = await raw(port, { path: "/api/demo?scenario=abort-b&role=bob&step=3&flags=held,stale,bogus" });
    assert.equal(d.status, 200);
    assert.equal(d.json.mode, "demo");
    assert.equal(d.json.roles.bob.tick.phase_after, "refund_mined");
    assert.deepEqual(d.json.demo.flags, ["held", "stale"]);
    const s = await raw(port, { path: "/api/demo/scenarios" });
    assert.ok(s.json.scenarios.some((x) => x.id === "abort-a"));
    const run = await raw(port, { path: "/api/run" });
    assert.equal(run.status, 200);
    assert.equal(run.json.readable, false, "no folder: nothing readable, said plainly");
  });
});

test("static files: the page and its three modules; nothing else from the app folder", async () => {
  await withServer({ runDirs: [] }, async ({ port }) => {
    for (const [p, type] of [["/", /text\/html/], ["/operator.js", /javascript/], ["/operator.css", /text\/css/], ["/phases.js", /javascript/], ["/viewmodel.js", /javascript/], ["/console", /text\/html/]]) {
      const r = await raw(port, { path: p });
      assert.equal(r.status, 200, p);
      assert.match(r.headers["content-type"], type, p);
    }
    const page = (await raw(port, { path: "/" })).text;
    assert.match(page, /operator console/);
    assert.ok(!/<style|\sstyle=|\son[a-z]+=/i.test(page),"no inline style or inline handler: the CSP forbids them");
    assert.ok(!/https?:\/\/(?!127\.0\.0\.1|localhost)/.test(page), "no external URL in the page");
    for (const p of ["/operator.js", "/operator.css", "/phases.js", "/viewmodel.js"]) {
      const t = (await raw(port, { path: p })).text;
      assert.ok(!/(^|[^a-z])(https?:)?\/\/(?!127\.0\.0\.1|localhost)[a-z0-9.-]+\.[a-z]{2,}/i.test(t.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "")), `${p}: no external request`);
    }
    // the two typefaces come from this server and from nowhere else; nothing else of the fonts folder is served
    {
      const r = await raw(port, { path: "/mark.svg" });
      assert.equal(r.status, 200, "/mark.svg");
      assert.match(r.headers["content-type"], /^image\/svg\+xml$/);
      assert.ok(!/<script|\son[a-z]+=|href=/i.test(r.text), "the mark is a plain drawing: no script, no handler, no link");
    }
    for (const p of ["/fonts/SpaceGrotesk-wght.woff2", "/fonts/JetBrainsMono-wght.woff2"]) {
      const r = await raw(port, { path: p });
      assert.equal(r.status, 200, p);
      assert.match(r.headers["content-type"], /^font\/woff2$/, p);
    }
    for (const p of ["/fonts/", "/fonts/README.md", "/fonts/SpaceGrotesk-OFL.txt", "/fonts/..%2Fserver.js"]) assert.equal((await raw(port, { path: p })).status, 404, p);
    for (const p of ["/server.js", "/lib/runner.js", "/lib/secrets.js", "/test/helpers.js", "/swaps.json", "/..%2Fserver.js", "/mock/run-1.json"]) assert.equal((await raw(port, { path: p })).status, 404, p);
  });
});

test("Host header: a rebound name or the wrong port is refused on every route", async () => {
  await withServer({ runDirs: [] }, async ({ port }) => {
    for (const host of ["evil.example", `evil.example:${port}`, `127.0.0.1:${port + 1}`, "127.0.0.1", `localhost.evil.example:${port}`]) {
      const r = await raw(port, { path: "/api/run", headers: { host } });
      assert.equal(r.status, 403, `Host ${JSON.stringify(host)}`);
    }
    for (const host of [`127.0.0.1:${port}`, `localhost:${port}`]) assert.equal((await raw(port, { path: "/api/health", headers: { host } })).status, 200);
    assert.equal(hostOk({ headers: { host: `[::1]:${port}` }, socket: { localPort: port } }), true);
  });
});

test("POST /api/helper is refused when the runner is off, whatever the headers say", async () => {
  await withServer({ runDirs: [] }, async ({ port }) => {
    const r = await raw(port, { method: "POST", path: "/api/helper", headers: { origin: `http://127.0.0.1:${port}`, "content-type": "application/json", "x-swap-token": "x" }, body: '{"id":"tick-alice"}' });
    assert.equal(r.status, 403);
    assert.match(r.json.error, /runner is off/);
    for (const m of ["POST", "PUT", "DELETE", "PATCH"]) assert.equal((await raw(port, { method: m, path: "/api/run" })).status, 405, m + " /api/run");
    assert.equal((await raw(port, { method: "POST", path: "/api/swaps" })).status, 405);
  });
});

test("the runner: token, same-origin, content type, body and id checks", async () => {
  const run = makeRunFolder();
  const calls = [];
  const fake = {
    describe: () => [{ id: "tick-alice", label: "t", note: "n" }],
    run: async (id) => {
      calls.push(id);
      if (id === "boom") throw Object.assign(new Error("busy: x is still running"), { status: 409 });
      return { id, ok: true, exit_code: 0, stdout: "out", stderr: "", duration_ms: 1, started_at: 1, label: id, command: "c" };
    },
  };
  await withServer({ runDirs: [run.dir], allowRunReadonly: true, wslDistro: "Ubuntu-24.04", wslRunDir: "/home/u/live-run-4", runnerOverride: fake }, async ({ port, server }) => {
    const token = server.runToken;
    assert.match(token, /^[0-9a-f]{48}$/, "a random token per start");
    const ok = { origin: `http://127.0.0.1:${port}`, "content-type": "application/json", "x-swap-token": token };
    const post = (headers, body = '{"id":"tick-alice"}') => raw(port, { method: "POST", path: "/api/helper", headers, body });

    // the token never appears in any GET
    for (const p of ["/api/run", "/api/health", "/", "/operator.js", "/console"]) assert.ok(!(await raw(port, { path: p })).text.includes(token), `${p} must not leak the token`);
    assert.equal((await raw(port, { path: "/api/health" })).json.operator.run_readonly_enabled, true);
    assert.equal((await raw(port, { path: "/api/run" })).json.runner.enabled, true);

    assert.equal((await post({ ...ok, "x-swap-token": undefined })).status, 403, "no token");
    assert.equal((await post({ ...ok, "x-swap-token": "0".repeat(48) })).status, 403, "wrong token");
    assert.equal((await post({ ...ok, "x-swap-token": token.slice(0, -1) })).status, 403, "short token");
    assert.equal((await post({ ...ok, origin: undefined })).status, 403, "no Origin");
    assert.equal((await post({ ...ok, origin: "http://evil.example" })).status, 403, "foreign Origin");
    assert.equal((await post({ ...ok, origin: `http://127.0.0.1:${port + 1}` })).status, 403, "Origin with another port");
    assert.equal((await post({ ...ok, origin: "null" })).status, 403, "opaque Origin");
    assert.equal((await post({ ...ok, "sec-fetch-site": "cross-site" })).status, 403, "cross-site fetch metadata");
    assert.equal((await post({ ...ok, "content-type": "text/plain" })).status, 415, "form-style content type");
    assert.equal((await post(ok, "not json")).status, 400);
    assert.equal((await post(ok, "{}")).status, 400);
    assert.equal((await post(ok, '{"id": 5}')).status, 400);
    assert.equal((await post(ok, JSON.stringify({ id: "tick-alice", pad: "x".repeat(2000) }))).status, 413, "body cap");
    assert.equal((await raw(port, { method: "POST", path: "/api/helper", headers: { ...ok, host: "evil.example" }, body: "{}" })).status, 403, "bad Host");
    assert.deepEqual(calls, [], "nothing ran for any refused request");

    const good = await post({ ...ok, "sec-fetch-site": "same-origin" });
    assert.equal(good.status, 200);
    assert.equal(good.json.id, "tick-alice");
    assert.deepEqual(calls, ["tick-alice"]);
    const busy = await post(ok, '{"id":"boom"}');
    assert.equal(busy.status, 409);
    assert.match(busy.json.error, /busy/);
  });
  run.cleanup();
});

test("a real ReadOnlyRunner behind the server refuses ids that are not in the table", async () => {
  await withServer({ runDirs: [], allowRunReadonly: true, wslDistro: "Ubuntu-24.04", wslRunDir: "/home/u/live-run-4", helpersDir: "/home/u/live-run-4/bin" }, async ({ port, server }) => {
    const ok = { origin: `http://127.0.0.1:${port}`, "content-type": "application/json", "x-swap-token": server.runToken };
    for (const id of ["lock", "reveal", "claim-submit", "tick-alice --apply", "rm"]) {
      const r = await raw(port, { method: "POST", path: "/api/helper", headers: ok, body: JSON.stringify({ id }) });
      assert.equal(r.status, 400, id);
      assert.match(r.json.error, /unknown helper id/);
    }
  });
});

test("--allow-run-readonly: loopback only, and the helper paths must be derivable", () => {
  assert.throws(() => createServer({ ...BASE, host: "0.0.0.0", runDirs: [], allowRunReadonly: true, wslDistro: "U", wslRunDir: "/r" }), /127\.0\.0\.1/);
  assert.throws(() => createServer({ ...BASE, runDirs: ["C:\\runs\\live-run-4"], allowRunReadonly: true }), /--helpers-dir|absolute POSIX path/);
  const s = createServer({ ...BASE, runDirs: ["\\\\wsl.localhost\\Ubuntu-24.04\\home\\u\\live-run-4"], allowRunReadonly: true });
  assert.ok(s.runToken);
  assert.deepEqual(runnerConfig({ runDirs: ["\\\\wsl.localhost\\Ubuntu-24.04\\home\\u\\live-run-4"] }), { distro: "Ubuntu-24.04", runDir: "/home/u/live-run-4", binDir: "/home/u/live-run-4/bin" });
  assert.deepEqual(runnerConfig({ runDirs: ["\\\\wsl.localhost\\Ubuntu-24.04\\home\\u\\run"], helpersDir: "/opt/h", wslDistro: "Other" }), { distro: "Other", runDir: "/home/u/run", binDir: "/opt/h" });
  assert.deepEqual(runnerConfig({ runDirs: ["/srv/run"] }), { distro: null, runDir: "/srv/run", binDir: "/srv/run/bin" });
  assert.equal(createServer({ ...BASE, runDirs: [] }).runToken.length, 48, "every mode has the key now (every /api request needs it); no runner without the flag");
  assert.equal(createServer({ ...BASE, runDirs: [] }).runner, null);
});

test("the read-only runner is told the run number (from the folder name, or --run-number), so the helpers do not default to run 4", () => {
  const a = createServer({ ...BASE, runDirs: ["//wsl.localhost/Ubuntu-24.04/home/u/live-run-11"], allowRunReadonly: true });
  assert.equal(a.runner.cfg.runNumber, 11);
  const b = createServer({ ...BASE, runDirs: ["//wsl.localhost/Ubuntu-24.04/home/u/live-run-ui-test"], allowRunReadonly: true, runNumber: 12 });
  assert.equal(b.runner.cfg.runNumber, 12);
  // no run number can be derived: no silent fallback to the helpers' default run (4); the runner is not started
  assert.throws(() => createServer({ ...BASE, runDirs: ["//wsl.localhost/Ubuntu-24.04/home/u/copy"], allowRunReadonly: true }), /no run number can be derived/);
});
