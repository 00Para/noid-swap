"use strict";
// Fix round 1 of the release key: duplicate keys, the note's characters, key-folder placement, the known-answer check,
// the signed hashes in the notice, the exact received bytes, and the ignore rules.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const R = require("../lib/releasefile.js");
const U = require("../lib/updates.js");
const tool = require("../scripts/release-key.js");
const F = require("./release-fixture.js");

const base = () => ({ product: "No1d Swap", version: "1.2.3", oldest_safe_version: "1.0.0", note: "ok", sha256: { "a.exe": "a".repeat(64) } });
const refused = (text) => assert.throws(() => R.parseReleaseJson(text), R.ReleaseFileError);

test("duplicate keys are refused at any depth, also when written with escapes", () => {
  const g = JSON.stringify(base());
  assert.ok(R.parseReleaseJson(g));
  refused(g.replace('"note":"ok"', '"note":"ok","note":"other"'));
  refused(g.replace('"note":"ok"', '"note":"ok","n\\u006fte":"other"'));
  refused(g.replace('"a.exe":"' + "a".repeat(64) + '"', '"a.exe":"' + "a".repeat(64) + '","a.exe":"' + "b".repeat(64) + '"'));
  // a key's text inside a string value is not a key
  assert.ok(R.parseReleaseJson(JSON.stringify({ ...base(), note: 'say "note":"x", twice' })));
});

test("the note refuses control, format, surrogate, private-use and unassigned characters and line separators", () => {
  const withNote = (n) => JSON.stringify({ ...base(), note: n });
  for (const bad of ["a\u0007b", "a\u007fb", "a​b", "a­b", "a‮b", "ab", "a͸b", "a b", "a b", "a﻿b"]) refused(withNote(bad));
  refused(JSON.stringify(base()).replace('"ok"', '"a\\ud800b"'));
  assert.ok(R.parseReleaseJson(withNote("Fixes a bug: café, 100% ✓.")));
});

test("the known-answer Ed25519 check passes on this runtime", () => {
  assert.equal(R.ed25519KnownAnswer(), true);
});

test("a sibling folder named like '..keys' is outside, a folder under the repository is inside, and a folder under a .git is refused", async () => {
  const root = tool.repoRoot();
  assert.equal(tool.insideRepo(path.join(root, "..", "..keys-sibling")), false);
  assert.equal(tool.insideRepo(path.join(root, "..keys-inside")), true, "a folder of that name under the root is inside it");
  assert.equal(tool.insideRepo(root), true);
  const outer = fs.mkdtempSync(path.join(os.tmpdir(), "relgit-"));
  try {
    fs.mkdirSync(path.join(outer, ".git"));
    const deep = path.join(outer, "a", "b");
    assert.equal(tool.hasGitAncestor(deep), true);
    const lines = [];
    const errs = [];
    const code = await tool.main(["keygen", "--out", deep], { readPassphrase: async () => assert.fail("no passphrase may be asked"), out: (l) => lines.push(l), err: (l) => errs.push(l) });
    assert.equal(code, 2);
    assert.match(errs[0], /inside a repository/);
    assert.equal(fs.existsSync(deep), false);
  } finally {
    fs.rmSync(outer, { recursive: true, force: true });
  }
});

test(".gitignore keeps the key file out of the repository", () => {
  const ignore = fs.readFileSync(path.join(tool.repoRoot(), ".gitignore"), "utf8").split(/\r?\n/);
  assert.ok(ignore.includes("release-key.enc.json"));
  assert.ok(ignore.includes("*.enc.json"));
});

test("the key tool checks key layouts and pins the tag length, and the file is proven to open before it is written", () => {
  const src = fs.readFileSync(path.join(__dirname, "..", "scripts", "release-key.js"), "utf8");
  assert.equal((src.match(/authTagLength: 16/g) || []).length, 2, "the cipher and the decipher");
  assert.match(src, /subarray\(0, PKCS8_PREFIX\.length\)\.equals\(PKCS8_PREFIX\)/);
  assert.match(src, /failed its own round trip/);
});

test("the signed hashes travel through describe: each installer name with its signed value", async () => {
  const rel = F.withAssets({ tag_name: "v0.2.0", draft: false, prerelease: false, html_url: "https://github.com/o/n/releases/tag/v0.2.0" });
  const r = await U.checkForUpdate({ fetchJson: F.releaseFetch([rel]), currentVersion: "0.1.0", anyActive: false, repo: "o/n", publicKey: F.PUB });
  assert.deepEqual(U.describe(r).sha256, [{ name: "setup.exe", sha256: "a".repeat(64) }]);
  assert.deepEqual(r.signedOldest, { version: "0.0.1", note: "A short note." });
  assert.deepEqual(U.cleanSums({ "../x": "a".repeat(64), ok: "A".repeat(64), "good.exe": "b".repeat(64) }), [{ name: "good.exe", sha256: "b".repeat(64) }]);
  assert.match(U.NOTICE_TEXT, /Compare the installer's SHA-256 with the signed value below/);
  assert.doesNotMatch(U.NOTICE_TEXT, /on that page/);
});

test("the signature covers the received bytes: the assets are asked for raw and a Buffer answer is used as it is", async () => {
  const rel = F.withAssets({ tag_name: "v0.2.0", draft: false, prerelease: false, html_url: "https://github.com/o/n/releases/tag/v0.2.0" });
  const text = F.noticeText("0.2.0");
  const bytes = Buffer.from(text, "utf8");
  const seen = [];
  const fetchJson = async (url, opts) => {
    seen.push(opts.raw);
    if (url.endsWith("per_page=10")) return [rel];
    return url.endsWith("/1") ? bytes : Buffer.from(F.sign(text), "ascii");
  };
  const r = await U.checkForUpdate({ fetchJson, currentVersion: "0.1.0", anyActive: false, repo: "o/n", publicKey: F.PUB });
  assert.equal(r.state, "newer");
  assert.deepEqual(seen, [undefined, true, true]);
  // one flipped byte in the received Buffer is a bad signature, never a repaired text
  const flipped = Buffer.from(bytes);
  flipped[5] ^= 1;
  const f2 = async (url) => (url.endsWith("per_page=10") ? [rel] : url.endsWith("/1") ? flipped : Buffer.from(F.sign(text), "ascii"));
  assert.equal((await U.checkForUpdate({ fetchJson: f2, currentVersion: "0.1.0", anyActive: false, repo: "o/n", publicKey: F.PUB })).state, "unverified");
  // bytes that are not valid UTF-8 are not rounded through text: a signature over them still verifies, and the parser refuses them
  const odd = Buffer.concat([bytes, Buffer.from([0xff])]);
  const sigOdd = require("node:crypto").sign(null, odd, F.privateKey).toString("base64");
  const f3 = async (url) => (url.endsWith("per_page=10") ? [rel] : url.endsWith("/1") ? odd : Buffer.from(sigOdd, "ascii"));
  assert.equal((await U.checkForUpdate({ fetchJson: f3, currentVersion: "0.1.0", anyActive: false, repo: "o/n", publicKey: F.PUB })).state, "unverified");
});

test("the real fetch returns a Buffer when asked for raw bytes and text otherwise", async () => {
  const { EventEmitter } = require("node:events");
  const mk = () => ({
    get(o, cb) {
      const req = new EventEmitter();
      req.destroy = () => {};
      setImmediate(() => {
        const res = Object.assign(new EventEmitter(), { statusCode: 200, headers: {}, resume() {} });
        cb(res);
        res.emit("data", Buffer.from([0xff, 0x41]));
        res.emit("end");
      });
      return req;
    },
  });
  const o = { headers: { "User-Agent": "x", Accept: "y" }, timeoutMs: 1000, maxBytes: 100 };
  const url = "https://api.github.com/repos/o/n/releases/assets/1";
  const raw = await U.createHttpsFetchJson({ https: mk() })(url, { ...o, raw: true });
  assert.ok(Buffer.isBuffer(raw));
  assert.deepEqual([...raw], [0xff, 0x41]);
  assert.equal(typeof (await U.createHttpsFetchJson({ https: mk() })(url, o)), "string");
});
