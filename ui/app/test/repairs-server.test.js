"use strict";
// The server repairs of 2026-11-16: loopback only in every mode, the token on every /api request (GET too), a plain 401 without it, and that the
// pages' own requests send it.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const http = require("http");
const path = require("path");
const { createServer } = require("../server");
const { makeRunFolder, registerToken } = require("./helpers");

const APP = path.join(__dirname, "..");
const BASE = { mock: false, host: "127.0.0.1", config: path.join(APP, "swaps.json"), mockDir: path.join(APP, "mock") };

function raw(port, { method = "GET", path: p = "/", headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, method, path: p, headers: { host: `127.0.0.1:${port}`, ...headers } }, (res) => {
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

test("--host: loopback only in EVERY mode (read-only, runner, actions); any other address is refused before anything listens", () => {
  const run = makeRunFolder();
  try {
    const modes = [{}, { allowRunReadonly: true, wslDistro: "U", wslRunDir: "/home/u/live-run-4", helpersDir: "/home/u/live-run-4/bin" }];
    for (const mode of modes) {
      for (const host of ["0.0.0.0", "::", "192.168.1.20", "example.com", "127.0.0.2", "LOCALHOST.evil", "127.0.0.1.evil", "[::1]"]) {
        assert.throws(() => createServer({ ...BASE, runDirs: [run.dir], ...mode, host }), /loopback only/, `${host} / ${Object.keys(mode).join()}`);
      }
      for (const host of ["127.0.0.1", "::1", "localhost"]) {
        const s = createServer({ ...BASE, runDirs: [run.dir], ...mode, host });
        assert.ok(s, host);
        s.close();
      }
    }
    // the read-only console with no flag at all: the case that was open
    assert.throws(() => createServer({ ...BASE, runDirs: [], host: "0.0.0.0" }), /--host 0\.0\.0\.0 is refused/);
    assert.throws(() => createServer({ ...BASE, runDirs: [], host: "10.0.0.5", demo: true }), /loopback only/);
  } finally {
    run.cleanup();
  }
});

async function withServer(opts, fn) {
  const server = createServer({ ...BASE, ...opts });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = registerToken(server);
  try {
    await fn({ port, server, token: server.runToken });
  } finally {
    await new Promise((r) => server.close(r));
  }
}

test("every /api GET needs the token, in every mode: no token, a wrong token, a token in the query string or the cookie are a plain 401; static files need none", async () => {
  const run = makeRunFolder();
  try {
    for (const mode of [{ runDirs: [run.dir] }, { runDirs: [] }, { runDirs: [], demo: true }, { mock: true, runDirs: [] }]) {
      await withServer(mode, async ({ port, token }) => {
        assert.equal(token.length, 48);
        const paths = ["/api/run", "/api/demo", "/api/demo/scenarios", "/api/health", "/api/swaps", "/api/swaps/run-2", "/api/nonsense"];
        for (const p of paths) {
          for (const headers of [{}, { "x-swap-token": "0".repeat(48) }, { "x-swap-token": token.slice(0, -1) }, { "x-swap-token": "" }, { cookie: "x-swap-token=" + token }]) {
            const r = await raw(port, { path: p, headers });
            assert.equal(r.status, 401, `${p} ${JSON.stringify(headers)}`);
            assert.match(r.json.error, /missing or wrong token/);
            assert.ok(!r.text.includes(token));
          }
          assert.equal((await raw(port, { path: p + "?token=" + token })).status, 401, `${p}: a query string is no key`);
          const ok = await raw(port, { path: p, headers: { "x-swap-token": token } });
          assert.notEqual(ok.status, 401, p);
          assert.ok(!ok.text.includes(token), `${p} must not echo the token`);
        }
        assert.equal((await raw(port, { path: "/api/run", headers: { "x-swap-token": token } })).status, 200);
        assert.equal((await raw(port, { path: "/api/demo", headers: { "x-swap-token": token } })).status, 200);
        // the pages are static: no token, and none inside them
        for (const p of ["/", "/operator.js", "/operator.css", "/phases.js", "/enginetext.js", "/viewmodel.js", "/actions.js", "/console", "/app.js", "/styles.css"]) {
          const r = await raw(port, { path: p });
          assert.equal(r.status, 200, p);
          assert.ok(!r.text.includes(token), p);
        }
        // a POST is still answered by its own checks first (method), not by the read rule
        assert.equal((await raw(port, { method: "POST", path: "/api/run", headers: { "x-swap-token": token } })).status, 405);
      });
    }
  } finally {
    run.cleanup();
  }
});

test("the pages' own requests send the key: operator.js (every getJson), actions.js (every POST) and app.js (the chain console) read it from the URL fragment", () => {
  const read = (f) => fs.readFileSync(path.join(APP, f), "utf8");
  const op = read("operator.js");
  const getJson = /async function getJson\(url, init\) \{([\s\S]*?)\n  \}/.exec(op)[1];
  assert.match(getJson, /"x-swap-token": state\.token/, "every GET of the operator page carries the key");
  assert.match(op, /token=\(\[0-9a-f\]\{16,\}\)/, "the key is read from the fragment");
  assert.ok(!/state\.token = null/.test(op), "the key is no longer dropped when the runner is off");
  assert.match(op, /a\[href="\/console"\]/, "the link to the chain console carries it");
  assert.match(read("actions.js"), /"x-swap-token": H\.state\.token/, "the POSTs carry it");
  const app = read("app.js");
  assert.match(app, /token=\(\[0-9a-f\]\{16,\}\)/);
  assert.match(app, /fetch\("\/api\/swaps", \{ cache: "no-store", headers: TOKEN \? \{ "x-swap-token": TOKEN \} : \{\} \}\)/);
  assert.match(app, /res\.status === 401/, "a missing key is said in words");
  // no page puts the key in a URL or in storage
  for (const f of [op, app, read("actions.js")]) assert.ok(!/localStorage\.setItem\([^)]*token/i.test(f));
  assert.ok(read("index.html").includes('<script src="/enginetext.js"></script>'), "the page loads the engine-text module before the view model");
});

test("--host with an empty or a missing value is refused; the address that is bound is the one that was checked", () => {
  const { parseArgs } = require("../server");
  assert.equal(parseArgs(["--host"]).host, "", "a missing value is not 'no host'");
  assert.equal(parseArgs(["--host", ""]).host, "");
  assert.throws(() => createServer({ ...BASE, runDirs: [], host: parseArgs(["--host"]).host }), /loopback only/);
  assert.throws(() => createServer({ ...BASE, runDirs: [], host: "" }), /loopback only/);
  assert.equal(createServer({ ...BASE, runDirs: [], host: undefined }).host, "127.0.0.1", "no --host at all: the default, and it is what the caller binds");
  assert.equal(createServer({ ...BASE, runDirs: [], host: "::1" }).host, "::1");
});
