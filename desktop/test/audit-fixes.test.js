"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const U = require("../lib/updates.js");
const F = require("./release-fixture.js");
const secretWin = require("../lib/secretwin.js");
const { createUpdateChecker } = require("../lib/updatecheck.js");

const REPO = "owner/name";

test("an unsigned higher release tag cannot shadow a lower release's signed oldest_safe_version floor", async () => {
  const signedRel = {
    tag_name: "v0.2.0",
    draft: false,
    prerelease: false,
    html_url: `https://github.com/${REPO}/releases/tag/v0.2.0`,
    assets: [
      { name: "release.json", id: 10 },
      { name: "release.json.sig", id: 11 },
    ],
  };
  const unsignedHigher = {
    tag_name: "v99.0.0",
    draft: false,
    prerelease: false,
    html_url: `https://github.com/${REPO}/releases/tag/v99.0.0`,
    assets: [],
  };
  const body = F.noticeText("0.2.0", { oldest: "0.2.0", note: "Critical fix." });
  const sig = F.sign(body);
  const fetchJson = async (url) => {
    if (url.includes("/releases?per_page=")) return [unsignedHigher, signedRel];
    if (url.endsWith("/assets/10")) return body;
    if (url.endsWith("/assets/11")) return sig;
    throw new Error(`unexpected url ${url}`);
  };
  const r = await U.checkForUpdate({
    fetchJson,
    currentVersion: "0.1.0",
    anyActive: false,
    repo: REPO,
    publicKey: F.PUB,
  });
  assert.equal(r.state, "unverified");
  assert.equal(r.latest, "99.0.0");
  assert.equal(r.unsafeForNewSwaps, true);
  assert.equal(r.unsafeNote, "Critical fix.");
  assert.deepEqual(r.signedOldest, { version: "0.2.0", note: "Critical fix." });
});

test("secretwin page server sends an HTTP Content-Security-Policy header with frame-ancestors none", async () => {
  const handler = secretWin.createPageServer(path.join(__dirname, "..", "secret"), (p) => fs.readFileSync(p));
  const res = await handler({ url: "no1d://secret/secret.html", method: "GET" });
  assert.equal(res.status, 200);
  const csp = res.headers.get("content-security-policy");
  assert.ok(csp && csp.includes("frame-ancestors 'none'") && csp.includes("default-src 'none'"));
});

test("updatecheck rejects control and bidi override characters in stored notes", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "noid-uc-"));
  try {
    const stateFile = path.join(dir, "state.json");
    fs.writeFileSync(
      stateFile,
      JSON.stringify({
        update_check: {
          version: "0.1.0",
          floor: { oldest: "0.2.0", note: "bad\u202enote" },
        },
      })
    );
    const checker = createUpdateChecker({
      fetchJson: async () => [],
      currentVersion: "0.1.0",
      repo: REPO,
      publicKey: F.PUB,
      anyActive: () => false,
      setting: () => "off",
      saveSetting: () => {},
      ask: async () => null,
      fs,
      stateFile,
    });
    const st = checker.status();
    assert.equal(st.unsafeForNewSwaps, true);
    assert.equal(st.unsafeNote, null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---- the signed floor is searched past the first ten releases, and past an asset that cannot be read
const relOf = (tag, withAssets, ids) => ({
  tag_name: tag,
  draft: false,
  prerelease: false,
  html_url: `https://github.com/${REPO}/releases/tag/${tag}`,
  assets: withAssets
    ? [
        { name: "release.json", id: ids[0] },
        { name: "release.json.sig", id: ids[1] },
      ]
    : [],
});
const unsignedTags = (from, n) => Array.from({ length: n }, (_, i) => relOf(`v${99 - from - i}.0.0`, false));

test("ten unsigned tags do not hide a signed oldest_safe_version: the next pages are read, and the search stops at the first signed notice", async () => {
  const body = F.noticeText("0.2.0", { oldest: "0.2.0", note: "Critical fix." });
  const sig = F.sign(body);
  const asked = [];
  const fetchJson = async (url) => {
    asked.push(url);
    if (url.endsWith("/releases?per_page=10")) return unsignedTags(0, 10);
    if (url.endsWith("/releases?per_page=10&page=2")) return [...unsignedTags(10, 9), relOf("v0.2.0", true, [10, 11])];
    if (url.includes("&page=")) throw new Error("no page past the one that holds the signed notice");
    if (url.endsWith("/assets/10")) return body;
    if (url.endsWith("/assets/11")) return sig;
    throw new Error(`unexpected url ${url}`);
  };
  const r = await U.checkForUpdate({ fetchJson, currentVersion: "0.1.0", anyActive: false, repo: REPO, publicKey: F.PUB });
  assert.equal(r.state, "unverified");
  assert.equal(r.latest, "99.0.0");
  assert.equal(r.unsafeForNewSwaps, true);
  assert.equal(r.unsafeNote, "Critical fix.");
  assert.deepEqual(r.signedOldest, { version: "0.2.0", note: "Critical fix." });
  assert.equal(asked.filter((u) => u.includes("&page=")).length, 1, "only page 2 was asked");
});

test("the page search is capped, and a page that cannot be read ends it without a verdict (the remembered floor stays)", async () => {
  let pages = 0;
  const allUnsigned = async (url) => {
    if (url.includes("per_page=10")) {
      pages += 1;
      return unsignedTags((pages - 1) * 10, 10);
    }
    throw new Error(`unexpected url ${url}`);
  };
  const r = await U.checkForUpdate({ fetchJson: allUnsigned, currentVersion: "0.1.0", anyActive: false, repo: REPO, publicKey: F.PUB });
  assert.deepEqual(r, { state: "unverified", latest: "99.0.0", url: `https://github.com/${REPO}/releases/tag/v99.0.0` });
  assert.equal(pages, 5, "the first page and four more, no further");
  let n = 0;
  const brokenSecond = async (url) => {
    n += 1;
    if (url.endsWith("&page=2")) throw new Error("boom");
    return unsignedTags(0, 10);
  };
  const r2 = await U.checkForUpdate({ fetchJson: brokenSecond, currentVersion: "0.1.0", anyActive: false, repo: REPO, publicKey: F.PUB });
  assert.equal(r2.state, "unverified");
  assert.equal(r2.signedOldest, undefined);
  assert.equal(n, 2, "the search stops at the page that failed");
  // a short first page means there is nothing more to ask
  let m = 0;
  await U.checkForUpdate({ fetchJson: async () => (m += 1, unsignedTags(0, 3)), currentVersion: "0.1.0", anyActive: false, repo: REPO, publicKey: F.PUB });
  assert.equal(m, 1);
});

test("an asset that throws for the newest release does not end the check before the older signed notices are read", async () => {
  const body = F.noticeText("0.2.0", { oldest: "0.2.0", note: "Critical fix." });
  const sig = F.sign(body);
  const fetchJson = async (url) => {
    if (url.endsWith("/releases?per_page=10")) return [relOf("v99.0.0", true, [20, 21]), relOf("v0.2.0", true, [10, 11])];
    if (url.endsWith("/assets/20")) throw new U.UpdateError("network");
    if (url.endsWith("/assets/10")) return body;
    if (url.endsWith("/assets/11")) return sig;
    throw new Error(`unexpected url ${url}`);
  };
  const r = await U.checkForUpdate({ fetchJson, currentVersion: "0.1.0", anyActive: false, repo: REPO, publicKey: F.PUB });
  assert.equal(r.state, "error", "the newest release could not be judged: still an error");
  assert.equal(r.reason, "network");
  assert.equal(r.unsafeForNewSwaps, true);
  assert.deepEqual(r.signedOldest, { version: "0.2.0", note: "Critical fix." });
  assert.equal(U.describe(r).unsafeNote, "Critical fix.");
  // nothing older is signed: exactly the old answer
  const lone = async (url) => {
    if (url.endsWith("/releases?per_page=10")) return [relOf("v99.0.0", true, [20, 21])];
    throw new U.UpdateError("too_large");
  };
  assert.deepEqual(await U.checkForUpdate({ fetchJson: lone, currentVersion: "0.1.0", anyActive: false, repo: REPO, publicKey: F.PUB }), { state: "error", reason: "too_large" });
});

test("the update checker keeps the signed floor found past a failing asset of the newest release", async () => {
  const body = F.noticeText("0.2.0", { oldest: "0.2.0", note: "Critical fix." });
  const sig = F.sign(body);
  const fetchJson = async (url) => {
    if (url.endsWith("/releases?per_page=10")) return [relOf("v99.0.0", true, [20, 21]), relOf("v0.2.0", true, [10, 11])];
    if (url.endsWith("/assets/20")) throw new U.UpdateError("network");
    if (url.endsWith("/assets/10")) return body;
    if (url.endsWith("/assets/11")) return sig;
    throw new Error(`unexpected url ${url}`);
  };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "noid-uc-"));
  try {
    const checker = createUpdateChecker({ fetchJson, currentVersion: "0.1.0", repo: REPO, publicKey: F.PUB, anyActive: () => false, setting: () => "off", saveSetting: () => {}, ask: async () => null, fs, stateFile: path.join(dir, "state.json") });
    assert.equal(checker.status().unsafeForNewSwaps, false);
    await checker.checkNow();
    const st = checker.status();
    assert.equal(st.unsafeForNewSwaps, true);
    assert.equal(st.unsafeNote, "Critical fix.");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
