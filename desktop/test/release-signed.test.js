"use strict";
// The signed release notice (docs/release-key.md): the update check believes "newer" only with a valid signature, says so when
// it does not check, fails closed without a compiled-in key, and exposes the "unsafe for new swaps" flag. Offline: the fetch is
// injected, and node's real https is replaced by a function that throws for the whole file.
const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const crypto = require("node:crypto");
const realHttps = require("node:https");
const U = require("../lib/updates.js");
const F = require("./release-fixture.js");

const realGet = realHttps.get;
realHttps.get = () => {
  throw new Error("a test of the update check reached for the real network");
};
test.after(() => {
  realHttps.get = realGet;
});

const REPO = "owner/name";
const rel = (tag, extra = {}) => F.withAssets({ tag_name: tag, draft: false, prerelease: false, html_url: `https://github.com/${REPO}/releases/tag/${tag}`, ...extra });
const NONE = { state: "none", unsafeForNewSwaps: false, unsafeNote: null };
const ASSET_URL = (id) => `https://api.github.com/repos/${REPO}/releases/assets/${id}`;
const strip = (r) => {
  const { signedOldest, ...rest } = r;
  return rest;
};
const check = async (releases, over = {}) => {
  const { files, fetchJson, ...rest } = over;
  return strip(await U.checkForUpdate({ fetchJson: fetchJson || F.releaseFetch(releases, files), currentVersion: "0.1.0", anyActive: false, repo: REPO, publicKey: F.PUB, ...rest }));
};

test("signed: the note and the version come only after a valid signature, fetched from the two asset addresses", async () => {
  const f = F.releaseFetch([rel("v0.2.0")], { note: "Fixes a display error." });
  const r = await check(null, { fetchJson: f });
  assert.equal(r.state, "newer");
  assert.equal(r.note, "Fixes a display error.");
  assert.deepEqual(
    f.calls.map((c) => c.url),
    ["https://api.github.com/repos/owner/name/releases?per_page=10", ASSET_URL(1), ASSET_URL(2)]
  );
  for (const c of f.calls.slice(1)) {
    assert.deepEqual(Object.keys(c.opts.headers).sort(), ["Accept", "User-Agent"]);
    assert.equal(c.opts.headers.Accept, "application/octet-stream");
    assert.deepEqual(c.opts.redirectHosts, ["objects.githubusercontent.com", "release-assets.githubusercontent.com"]);
  }
  assert.equal(f.calls[1].opts.maxBytes, 8 * 1024);
  assert.equal(f.calls[2].opts.maxBytes, 512);
  assert.equal(f.calls[0].opts.redirectHosts, undefined, "the releases list never follows a redirect");
});

test("unsigned: a newer release without the two assets is listed but never presented as an update", async () => {
  const bare = { tag_name: "v0.2.0", draft: false, prerelease: false, html_url: `https://github.com/${REPO}/releases/tag/v0.2.0` };
  const r = await check([bare]);
  assert.deepEqual(r, { state: "unverified", latest: "0.2.0", url: `https://github.com/${REPO}/releases/tag/v0.2.0` });
  const d = U.describe(r);
  assert.equal(d.state, "unverified");
  assert.match(d.text, /signature does not check: do not install it/);
  assert.equal((await check([{ ...bare, assets: [{ name: "release.json", id: 1 }] }])).state, "unverified");
  assert.equal((await check([{ ...bare, assets: [...F.withAssets({}).assets, { name: "release.json", id: 3 }] }])).state, "unverified");
  assert.equal((await check([{ ...bare, assets: [{ name: "release.json", id: "1" }, { name: "release.json.sig", id: 2 }] }])).state, "unverified");
});

test("badly signed: another key, a changed byte, a garbled, short or empty signature, a signature of another file", async () => {
  const good = F.noticeText("0.2.0");
  const goodSig = F.sign(good);
  const cases = {
    "another key": { notice: good, sig: goodSig, publicKey: F.OTHER_PUB },
    "changed byte": { notice: good.replace("short", "shirt"), sig: goodSig },
    "garbled signature": { notice: good, sig: "!!!not base64!!!" },
    "short signature": { notice: good, sig: Buffer.alloc(63).toString("base64") },
    "empty signature": { notice: good, sig: "" },
    "signature of another file": { notice: F.noticeText("0.2.0", { note: "other" }), sig: goodSig },
  };
  for (const [name, c] of Object.entries(cases)) {
    const r = await check([rel("v0.2.0")], { files: { notice: c.notice, sig: c.sig }, ...(c.publicKey ? { publicKey: c.publicKey } : {}) });
    assert.equal(r.state, "unverified", name);
  }
});

test("a signed notice that is badly formed or names another version than the tag is unverified, not an update", async () => {
  const bad = [
    F.noticeText("0.9.0"),
    JSON.stringify({ product: "No1d Swap", version: "0.2.0", oldest_safe_version: "0.0.1", note: "x", sha256: { a: "b".repeat(64) }, extra: 1 }),
    F.noticeText("0.2.0", { note: "x".repeat(281) }),
    F.noticeText("0.2.0", { oldest: "0.3.0" }),
    "not json",
  ];
  for (const notice of bad) assert.equal((await check([rel("v0.2.0")], { files: { notice, sig: F.sign(notice) } })).state, "unverified", notice.slice(0, 40));
});

test("an oversized or non-text notice answer is refused", async () => {
  const big = async (url) => (url.endsWith("per_page=10") ? [rel("v0.2.0")] : "x".repeat(8 * 1024 + 1));
  assert.deepEqual(await check(null, { fetchJson: big }), { state: "error", reason: "too_large" });
  const odd = async (url) => (url.endsWith("per_page=10") ? [rel("v0.2.0")] : { not: "a string" });
  assert.deepEqual(await check(null, { fetchJson: odd }), { state: "error", reason: "bad_answer" });
});

test("an asset that cannot be fetched is an error, not an update", async () => {
  assert.deepEqual(await check([rel("v0.2.0")], { files: { assetError: new Error("down") } }), { state: "error", reason: "network" });
});

test("the compiled-in key is one raw Ed25519 public key; without a usable key nothing is asked and no version is announced (fail closed, no crash)", async () => {
  const compiled = require("../lib/releasekey.js").PUBLIC_KEY_B64;
  assert.match(compiled, /^[A-Za-z0-9+/]{43}=$/, "44 characters of base64");
  assert.equal(Buffer.from(compiled, "base64").length, 32, "a raw 32-byte Ed25519 public key");
  for (const publicKey of ["", "AAAA", null, 7, "!".repeat(44)]) {
    const f = F.releaseFetch([rel("v9.0.0")]);
    const extra = publicKey === undefined ? {} : { publicKey };
    const r = await U.checkForUpdate({ fetchJson: f, currentVersion: "0.1.0", anyActive: false, repo: REPO, ...extra });
    assert.deepEqual(r, { state: "error", reason: "key_not_configured" }, String(publicKey));
    assert.equal(f.calls.length, 0);
  }
  const d = U.describe({ state: "error", reason: "key_not_configured" });
  assert.equal(d.state, "release_check_not_configured");
  assert.match(d.text, /not configured/);
});

test("oldest_safe_version: above the running version sets the flag with the signed note; at or below does not", async () => {
  const run = (oldest, current, tag = "v0.5.0") => check([rel(tag)], { files: { oldest, note: "Do not start new swaps." }, currentVersion: current });
  const above = await run("0.3.0", "0.2.9");
  assert.equal(above.state, "newer");
  assert.equal(above.unsafeForNewSwaps, true);
  assert.equal(above.unsafeNote, "Do not start new swaps.");
  const equal = await run("0.3.0", "0.3.0");
  assert.equal(equal.unsafeForNewSwaps, false);
  assert.equal(equal.unsafeNote, null);
  assert.equal((await run("0.3.0", "0.4.0")).unsafeForNewSwaps, false);
  assert.deepEqual(await run("0.5.0", "0.5.0"), NONE);
  const behind = await run("0.5.0", "0.4.9");
  assert.equal(behind.unsafeForNewSwaps, true);
  const d = U.describe(above);
  assert.equal(d.unsafeForNewSwaps, true);
  assert.equal(d.unsafeNote, "Do not start new swaps.");
});

test("a running version that is the newest is never flagged unsafe by the newest notice (its oldest safe version cannot exceed its own version)", async () => {
  // the notice of v0.5.0 cannot name an oldest safe version above 0.5.0 (refused), so the newest running version is never flagged
  const notice = F.noticeText("0.5.0", { oldest: "0.5.0" });
  const r = await check([rel("v0.5.0")], { files: { notice, sig: F.sign(notice) }, currentVersion: "0.5.0" });
  assert.deepEqual(r, NONE);
});

test("an unsigned or badly signed notice can never set the unsafe flag", async () => {
  const notice = F.noticeText("0.5.0", { oldest: "0.5.0", note: "forged" });
  const r = await check([rel("v0.5.0")], { files: { notice, sig: "AAAA" }, currentVersion: "0.4.0" });
  assert.equal(r.state, "unverified");
  assert.equal(r.unsafeForNewSwaps, undefined);
  assert.equal(U.describe(r).unsafeForNewSwaps, false);
  const same = await check([rel("v0.5.0")], { files: { notice, sig: "AAAA" }, currentVersion: "0.5.0" });
  assert.deepEqual(same, NONE);
});

// ---- the redirect rule of the real fetch, on a fake https ----

function fakeHttps(script) {
  const calls = [];
  return {
    calls,
    get(o, cb) {
      calls.push(o);
      const req = new EventEmitter();
      req.destroy = () => {};
      setImmediate(() => script(req, cb, calls.length));
      return req;
    },
  };
}
const response = (status, headers = {}) => Object.assign(new EventEmitter(), { statusCode: status, headers, resume() {} });
const assetOpts = { headers: { "User-Agent": U.USER_AGENT, Accept: "application/octet-stream" }, timeoutMs: 1000, maxBytes: 1000, redirectHosts: U.ASSET_HOSTS };
const reason = (p) => p.then(() => "resolved", (e) => e.reason);

test("redirect: one hop to GitHub's asset host, with the user agent alone, and the body comes back", async () => {
  const https = fakeHttps((req, cb, n) => {
    if (n === 1) return cb(response(302, { location: "https://objects.githubusercontent.com/path?sig=abc" }));
    const res = response(200, {});
    cb(res);
    res.emit("data", Buffer.from("body"));
    res.emit("end");
  });
  assert.equal(await U.createHttpsFetchJson({ https })(ASSET_URL(1), assetOpts), "body");
  assert.equal(https.calls[0].host, "api.github.com");
  assert.equal(https.calls[1].host, "objects.githubusercontent.com");
  assert.equal(https.calls[1].path, "/path?sig=abc");
  assert.deepEqual(Object.keys(https.calls[1].headers), ["User-Agent"]);
  assert.equal(https.calls[1].agent, false);
});

test("redirect: any other target is refused before a second request", async () => {
  const targets = ["https://evil.example/x", "http://objects.githubusercontent.com/x", "https://objects.githubusercontent.com.evil.example/x", "https://u:p@objects.githubusercontent.com/x", "https://objects.githubusercontent.com:8443/x", "/relative", "", "https://github.com/x"];
  for (const location of targets) {
    const https = fakeHttps((req, cb) => cb(response(302, { location })));
    assert.equal(await reason(U.createHttpsFetchJson({ https })(ASSET_URL(1), assetOpts)), "network", location);
    assert.equal(https.calls.length, 1, location);
  }
});

test("redirect: only one hop; none without named hosts; a host outside the module's own list is ignored", async () => {
  const hop = fakeHttps((req, cb) => cb(response(302, { location: "https://objects.githubusercontent.com/x" })));
  assert.equal(await reason(U.createHttpsFetchJson({ https: hop })(ASSET_URL(1), assetOpts)), "network");
  assert.equal(hop.calls.length, 2);
  const none = fakeHttps((req, cb) => cb(response(302, { location: "https://objects.githubusercontent.com/x" })));
  assert.equal(await reason(U.createHttpsFetchJson({ https: none })(ASSET_URL(1), { ...assetOpts, redirectHosts: undefined })), "network");
  assert.equal(none.calls.length, 1);
  const own = fakeHttps((req, cb) => cb(response(302, { location: "https://evil.example/x" })));
  assert.equal(await reason(U.createHttpsFetchJson({ https: own })(ASSET_URL(1), { ...assetOpts, redirectHosts: ["evil.example"] })), "network");
  assert.equal(own.calls.length, 1);
});

test("a signature made with a real signing round trip verifies (the fixture key and the module agree)", () => {
  const text = F.noticeText("1.2.3");
  assert.equal(crypto.verify(null, Buffer.from(text), crypto.createPublicKey({ key: Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), Buffer.from(F.PUB, "base64")]), format: "der", type: "spki" }), Buffer.from(F.sign(text), "base64")), true);
});
