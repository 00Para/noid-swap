"use strict";
// The notify-only update check (step 4.8, build spec 8.6). Offline: the fetch is injected, and node's real https is
// replaced by a function that throws for the whole file, so any test that reached for the network would fail.
const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const realHttps = require("node:https");
const U = require("../lib/updates.js");

const realGet = realHttps.get;
realHttps.get = () => {
  throw new Error("a test of the update check reached for the real network");
};
test.after(() => {
  realHttps.get = realGet;
});

const REPO = "owner/name";
const rel = (tag, extra = {}) => ({ tag_name: tag, draft: false, prerelease: false, html_url: `https://github.com/${REPO}/releases/tag/${tag}`, ...extra });
const fetchOf = (answer) => {
  const calls = [];
  const f = async (url, opts) => {
    calls.push({ url, opts });
    if (answer instanceof Error) throw answer;
    return typeof answer === "function" ? answer() : answer;
  };
  f.calls = calls;
  return f;
};
const check = (releases, over = {}) => U.checkForUpdate({ fetchJson: fetchOf(releases), currentVersion: "0.1.0", anyActive: false, repo: REPO, ...over });

test("a newer release is reported with its version and its release page", async () => {
  assert.deepEqual(await check([rel("v0.2.0")]), { state: "newer", latest: "0.2.0", url: `https://github.com/${REPO}/releases/tag/v0.2.0` });
});

test("the same version and an older one report none", async () => {
  assert.deepEqual(await check([rel("v0.1.0")]), { state: "none" });
  assert.deepEqual(await check([rel("v0.0.9"), rel("v0.0.1")]), { state: "none" });
  assert.deepEqual(await check([]), { state: "none" });
});

test("the highest counting release wins, compared as numbers and not as text", async () => {
  const r = await check([rel("v0.9.0"), rel("v0.10.0"), rel("v0.2.0")]);
  assert.equal(r.latest, "0.10.0");
  assert.equal((await check([rel("v1.0.0")], { currentVersion: "0.99.99" })).state, "newer");
  assert.equal((await check([rel("v1.0.0")], { currentVersion: "1.0.0" })).state, "none");
});

test("a draft, a prerelease and a tag of another shape never count", async () => {
  const noise = [
    rel("v9.0.0", { draft: true }),
    rel("v9.1.0", { prerelease: true }),
    rel("9.2.0"),
    rel("v9.3"),
    rel("v9.4.0-rc1"),
    rel("v9.5.0+build"),
    rel("V9.6.0"),
    rel("v09.7.x"),
    rel(" v9.8.0"),
  ];
  assert.deepEqual(await check(noise), { state: "none" });
  assert.equal((await check([...noise, rel("v0.3.0")])).latest, "0.3.0");
});

test("a release page that is not this repository's tag page is a bad answer, never shown", async () => {
  for (const url of [
    `https://github.com/other/name/releases/tag/v0.2.0`,
    `http://github.com/${REPO}/releases/tag/v0.2.0`,
    `https://github.com.evil.example/${REPO}/releases/tag/v0.2.0`,
    `https://github.com/${REPO}/releases/tag/v0.3.0`,
    `https://github.com/${REPO}/releases/tag/v0.2.0/../../x`,
    undefined,
    42,
  ]) {
    assert.deepEqual(await check([rel("v0.2.0", { html_url: url })]), { state: "error", reason: "bad_answer" }, String(url));
  }
});

test("an answer that is not the expected shape is a bad answer", async () => {
  for (const answer of ["not json", "{}", '{"message":"rate limited"}', "null", "[1]", '[{"tag_name":"v1.0.0"}]', '[{"tag_name":"v1.0.0","draft":"no","prerelease":false}]', {}, null, 7]) {
    assert.deepEqual(await check(answer), { state: "error", reason: "bad_answer" }, JSON.stringify(answer));
  }
  assert.deepEqual(await check(new Array(101).fill(rel("v0.0.1"))), { state: "error", reason: "bad_answer" });
});

test("an answer over 256 KB is refused (as text, and as an already parsed value)", async () => {
  const big = JSON.stringify([rel("v0.2.0", { body: "x".repeat(U.MAX_BYTES) })]);
  assert.deepEqual(await check(big), { state: "error", reason: "too_large" });
  assert.deepEqual(await check([rel("v0.2.0", { body: "x".repeat(U.MAX_BYTES) })]), { state: "error", reason: "too_large" });
  assert.equal((await check(JSON.stringify([rel("v0.2.0")]))).state, "newer");
  assert.deepEqual(await check(JSON.stringify([rel("v0.2.0")]), { maxBytes: 20 }), { state: "error", reason: "too_large" });
});

test("a fetch that does not answer in time is a time-out, and its signal is aborted", async () => {
  let signal;
  const fetchJson = (url, opts) => {
    signal = opts.signal;
    return new Promise(() => {});
  };
  const r = await U.checkForUpdate({ fetchJson, currentVersion: "0.1.0", anyActive: false, repo: REPO, timeoutMs: 25 });
  assert.deepEqual(r, { state: "error", reason: "timeout" });
  assert.equal(signal.aborted, true);
});

test("a failing fetch is a network error, and a reason it carries is kept", async () => {
  assert.deepEqual(await check(new Error("ECONNRESET")), { state: "error", reason: "network" });
  assert.deepEqual(await check(Object.assign(new Error("x"), { reason: "too_large" })), { state: "error", reason: "too_large" });
  assert.deepEqual(await check(Object.assign(new Error("x"), { reason: "something else" })), { state: "error", reason: "network" });
});

test("while a swap is active nothing is asked", async () => {
  const f = fetchOf([rel("v9.0.0")]);
  assert.deepEqual(await U.checkForUpdate({ fetchJson: f, currentVersion: "0.1.0", anyActive: true, repo: REPO }), { state: "skipped_active" });
  assert.equal(f.calls.length, 0);
});

test("without a configured repository, or with a malformed one, nothing is asked", async () => {
  for (const repo of [null, undefined, "", "owner", "owner/name/extra", "../x", "owner/na me", "http://x/y"]) {
    const f = fetchOf([]);
    assert.deepEqual(await U.checkForUpdate({ fetchJson: f, currentVersion: "0.1.0", anyActive: false, repo }), { state: "error", reason: "not_configured" }, String(repo));
    assert.equal(f.calls.length, 0);
  }
  const f = fetchOf([]);
  assert.deepEqual(await U.checkForUpdate({ fetchJson: f, currentVersion: "0.1", anyActive: false, repo: REPO }), { state: "error", reason: "bad_version" });
  assert.equal(f.calls.length, 0);
});

test("the request is one GET of the releases list with the generic user agent and no cookie, no token", async () => {
  const f = fetchOf([]);
  await U.checkForUpdate({ fetchJson: f, currentVersion: "0.1.0", anyActive: false, repo: REPO });
  assert.equal(f.calls.length, 1);
  const { url, opts } = f.calls[0];
  assert.equal(url, "https://api.github.com/repos/owner/name/releases?per_page=10");
  assert.deepEqual(Object.keys(opts.headers).sort(), ["Accept", "User-Agent"]);
  assert.equal(opts.headers["User-Agent"], "No1d-Swap-update-check");
  assert.equal(opts.timeoutMs, 10000);
  assert.equal(opts.maxBytes, 256 * 1024);
});

test("the module can only notify: it has no download, install or write function", () => {
  assert.deepEqual(Object.keys(U).sort(), ["API_HOST", "MAX_BYTES", "NOTICE_TEXT", "TIMEOUT_MS", "USER_AGENT", "UpdateError", "checkForUpdate", "compareVersions", "createHttpsFetchJson", "describe", "isDailyDue", "parseVersion", "selectRelease"]);
  const src = require("node:fs").readFileSync(require.resolve("../lib/updates.js"), "utf8");
  assert.ok(!/child_process|writeFile|createWriteStream|execFile|spawn|shell\.openExternal|autoUpdater/.test(src));
});

// ---- the real fetch on a fake https ----

function fakeHttps(script) {
  const calls = [];
  return {
    calls,
    get(opts, cb) {
      calls.push(opts);
      const req = new EventEmitter();
      req.destroyed = false;
      req.destroy = () => {
        req.destroyed = true;
      };
      setImmediate(() => script(req, cb));
      return req;
    },
  };
}
const response = (status, headers = {}) => Object.assign(new EventEmitter(), { statusCode: status, headers, resume() {} });
const opts = { headers: { "User-Agent": U.USER_AGENT, Accept: "application/vnd.github+json" }, timeoutMs: 1000, maxBytes: 100 };
const URL_OK = "https://api.github.com/repos/owner/name/releases?per_page=10";

test("createHttpsFetchJson: one request to api.github.com, no agent reuse, only the two headers; the body comes back as text", async () => {
  const https = fakeHttps((req, cb) => {
    const res = response(200, { "content-length": "7" });
    cb(res);
    res.emit("data", Buffer.from("[1,"));
    res.emit("data", Buffer.from("2,3]"));
    res.emit("end");
  });
  const fetchJson = U.createHttpsFetchJson({ https });
  assert.equal(await fetchJson(URL_OK, { ...opts, headers: { ...opts.headers, Cookie: "a=b", Authorization: "token x" } }), "[1,2,3]");
  const o = https.calls[0];
  assert.equal(o.host, "api.github.com");
  assert.equal(o.path, "/repos/owner/name/releases?per_page=10");
  assert.equal(o.agent, false);
  assert.deepEqual(Object.keys(o.headers).sort(), ["Accept", "User-Agent"]);
});

test("createHttpsFetchJson: a status other than 200 (a redirect included), an oversized length or body, a time-out and an error are refused", async () => {
  const run = (script, o = opts) => U.createHttpsFetchJson({ https: fakeHttps(script) })(URL_OK, o).then(() => "resolved", (e) => e.reason);
  assert.equal(await run((req, cb) => cb(response(404))), "network");
  assert.equal(await run((req, cb) => cb(response(302, { location: "https://evil.example/" }))), "network");
  assert.equal(await run((req, cb) => cb(response(200, { "content-length": "101" }))), "too_large");
  assert.equal(
    await run((req, cb) => {
      const res = response(200, {});
      cb(res);
      res.emit("data", Buffer.alloc(60));
      res.emit("data", Buffer.alloc(60));
    }),
    "too_large"
  );
  assert.equal(await run((req) => req.emit("timeout")), "timeout");
  assert.equal(await run((req) => req.emit("error", new Error("ECONNRESET"))), "network");
});

test("createHttpsFetchJson: another host, another scheme or a bad address is refused before any request", async () => {
  const https = fakeHttps(() => {});
  const fetchJson = U.createHttpsFetchJson({ https });
  for (const url of ["https://evil.example/repos/o/n/releases", "http://api.github.com/repos/o/n/releases", "not a url", "https://api.github.com.evil.example/x"]) {
    await assert.rejects(() => fetchJson(url, opts), (e) => e.reason === "bad_answer", url);
  }
  assert.equal(https.calls.length, 0);
});

test("createHttpsFetchJson: an aborted signal stops the request", async () => {
  const https = fakeHttps(() => {});
  const controller = new AbortController();
  const p = U.createHttpsFetchJson({ https })(URL_OK, { ...opts, signal: controller.signal });
  setImmediate(() => controller.abort());
  await assert.rejects(p, (e) => e.reason === "timeout");
});

test("the whole check on the fake https: newer, and a hostile answer", async () => {
  const body = JSON.stringify([rel("v0.2.0")]);
  const https = fakeHttps((req, cb) => {
    const res = response(200, {});
    cb(res);
    res.emit("data", Buffer.from(body));
    res.emit("end");
  });
  const r = await U.checkForUpdate({ fetchJson: U.createHttpsFetchJson({ https }), currentVersion: "0.1.0", anyActive: false, repo: REPO });
  assert.equal(r.state, "newer");
  const hostile = fakeHttps((req, cb) => {
    const res = response(200, {});
    cb(res);
    res.emit("data", Buffer.from("<html>"));
    res.emit("end");
  });
  assert.deepEqual(await U.checkForUpdate({ fetchJson: U.createHttpsFetchJson({ https: hostile }), currentVersion: "0.1.0", anyActive: false, repo: REPO }), { state: "error", reason: "bad_answer" });
});

// ---- small helpers ----

test("isDailyDue: never checked, a day old, and not yet a day old", () => {
  const now = 1_800_000_000_000;
  const day = 24 * 60 * 60 * 1000;
  assert.equal(U.isDailyDue(null, now), true);
  assert.equal(U.isDailyDue(undefined, now), true);
  assert.equal(U.isDailyDue(NaN, now), true);
  assert.equal(U.isDailyDue(now - day, now), true);
  assert.equal(U.isDailyDue(now - day + 1, now), false);
  assert.equal(U.isDailyDue(now + 1000, now), true, "a time in the future is not trusted");
});

test("describe gives the page the version, the link and the fixed words, and nothing for the other states", () => {
  const d = U.describe({ state: "newer", latest: "0.2.0", url: "https://github.com/owner/name/releases/tag/v0.2.0" });
  assert.deepEqual(d, { state: "newer", latest: "0.2.0", url: "https://github.com/owner/name/releases/tag/v0.2.0", text: U.NOTICE_TEXT });
  assert.match(U.NOTICE_TEXT, /sha256 and build provenance on that page before installing/);
  assert.deepEqual(U.describe({ state: "none" }), { state: "none", latest: null, url: null });
  assert.deepEqual(U.describe({ state: "error", reason: "timeout" }), { state: "error", latest: null, url: null });
  assert.deepEqual(U.describe({ state: "skipped_active" }), { state: "skipped_active", latest: null, url: null });
});

test("parseVersion and compareVersions are strict", () => {
  assert.deepEqual(U.parseVersion("1.22.333"), [1, 22, 333]);
  for (const bad of ["1.2", "v1.2.3", "1.2.3-rc", "1.2.3.4", "", "a.b.c", null, undefined]) assert.equal(U.parseVersion(bad), null, String(bad));
  assert.equal(U.compareVersions([1, 2, 3], [1, 2, 3]), 0);
  assert.equal(U.compareVersions([1, 10, 0], [1, 9, 9]), 1);
  assert.equal(U.compareVersions([0, 9, 9], [1, 0, 0]), -1);
});
