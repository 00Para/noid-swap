"use strict";
// The update checker with the signed release notice: the unsafe flag, the refusals and the per-version record.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const updates = require("../lib/updates");
const F = require("./release-fixture.js");
const { createUpdateChecker } = require("../lib/updatecheck");

const REPO = "example-owner/example-repo";
const DAY = 24 * 60 * 60 * 1000;
const release = (tag) => F.withAssets({ tag_name: tag, draft: false, prerelease: false, html_url: `https://github.com/${REPO}/releases/tag/${tag}` });

function make(over = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "updsigned-"));
  let version = over.version || "0.1.0";
  let t = 10 * DAY;
  let files = over.files || {};
  let offline = false;
  let answer = over.answer || [release("v0.5.0")];
  const o = {
    fetchJson: async (url, opts) => {
      if (offline) throw new Error("offline");
      return F.releaseFetch(() => answer, files)(url, opts);
    },
    ...(over.noKey ? { publicKey: "" } : { publicKey: F.PUB }), // "": a build with no key (the real file now carries the owner's)
    get currentVersion() {
      return version;
    },
    repo: REPO,
    anyActive: () => false,
    setting: () => "daily",
    saveSetting: () => {},
    ask: async () => "daily",
    fs,
    stateFile: path.join(dir, "state.json"),
    now: () => t,
  };
  return {
    o,
    checker: () => createUpdateChecker(o),
    advance: (ms) => (t += ms),
    setVersion: (v) => (version = v),
    setFiles: (f) => (files = f),
    setOffline: (b) => (offline = b),
    setAnswer: (a) => (answer = a),
    cleanup: () => fs.rmSync(dir, { recursive: true, force: true }),
  };
}

test("a signed notice below the oldest safe version: newer, with the signed hashes, the unsafe flag and its sentence, kept across a restart", async () => {
  const w = make({ files: { oldest: "0.3.0", note: "Do not start new swaps." } });
  try {
    const c = w.checker();
    await c.checkNow();
    const st = c.status();
    assert.equal(st.state, "newer");
    assert.equal(st.unsafeForNewSwaps, true);
    assert.equal(st.unsafeNote, "Do not start new swaps.");
    assert.equal(st.note, "Do not start new swaps.");
    assert.deepEqual(st.sha256, [{ name: "setup.exe", sha256: "a".repeat(64) }], "the signed installer hashes travel with the answer");
    assert.deepEqual(w.checker().status(), st, "a new checker reads the same answer back");
  } finally {
    w.cleanup();
  }
});

test("the unsafe flag stays on through a failed check, a bad signature, a missing release.json, a duplicate upload and an older signed notice; only a higher signed one raises it", async () => {
  const w = make({ files: { oldest: "0.3.0", note: "Do not start new swaps." } });
  try {
    const c = w.checker();
    await c.checkNow();
    const on = () => {
      const st = c.status();
      assert.equal(st.unsafeForNewSwaps, true);
      assert.equal(st.unsafeNote, "Do not start new swaps.");
    };
    on();
    w.setOffline(true);
    await c.checkNow();
    assert.equal(c.status().state, "error");
    on();
    w.setOffline(false);
    // a bad signature
    w.setFiles({ notice: F.noticeText("0.5.0", { oldest: "0.0.1" }), sig: "AAAA" });
    await c.checkNow();
    assert.equal(c.status().state, "unverified");
    on();
    // no release.json at all
    w.setFiles({});
    w.setAnswer([{ tag_name: "v0.5.0", draft: false, prerelease: false, html_url: `https://github.com/${REPO}/releases/tag/v0.5.0` }]);
    await c.checkNow();
    assert.equal(c.status().state, "unverified");
    on();
    // a duplicate upload of release.json
    w.setAnswer([{ tag_name: "v0.5.0", draft: false, prerelease: false, html_url: `https://github.com/${REPO}/releases/tag/v0.5.0`, assets: [...F.withAssets({}).assets, { name: "release.json", id: 3 }] }]);
    await c.checkNow();
    assert.equal(c.status().state, "unverified");
    on();
    // an older signed notice that says everything is safe
    w.setAnswer([release("v0.5.0")]);
    w.setFiles({ oldest: "0.0.1", note: "all fine" });
    await c.checkNow();
    assert.equal(c.status().state, "newer");
    on();
    // it survives a restart of the checker
    assert.equal(w.checker().status().unsafeForNewSwaps, true);
    // a higher signed notice raises it and replaces the sentence
    w.setFiles({ oldest: "0.4.0", note: "Worse." });
    await c.checkNow();
    assert.equal(c.status().unsafeNote, "Worse.");
    assert.equal(c.status().unsafeForNewSwaps, true);
  } finally {
    w.cleanup();
  }
});

test("a program update discards the record: a fixed version is not flagged by the old answer, and the next start checks at once", async () => {
  const w = make({ files: { oldest: "0.3.0", note: "Do not start new swaps." } });
  try {
    await w.checker().checkNow();
    w.setVersion("0.4.0");
    const c = w.checker();
    assert.equal(c.status().state, "never");
    assert.equal(c.status().unsafeForNewSwaps, false);
    assert.equal(await c.atStart(), "checked", "not 'not-due': the record was made by another version");
  } finally {
    w.cleanup();
  }
});

test("a newer release without a valid signature is shown as unverified with the words, never as newer", async () => {
  const w = make({ files: { notice: F.noticeText("0.5.0"), sig: "AAAA" } });
  try {
    const c = w.checker();
    await c.checkNow();
    const st = c.status();
    assert.equal(st.state, "unverified");
    assert.equal(st.text, updates.UNVERIFIED_TEXT);
    assert.equal(st.unsafeForNewSwaps, false);
    assert.equal(w.checker().status().state, "unverified");
  } finally {
    w.cleanup();
  }
});

test("a build without a release key says so and asks nothing at all", async () => {
  const w = make({ noKey: true });
  let asked = 0;
  w.o.fetchJson = async () => {
    asked += 1;
    return [];
  };
  try {
    const c = w.checker();
    const r = await c.checkNow();
    assert.equal(asked, 0);
    assert.equal(c.status().state, "release_check_not_configured");
    assert.equal(c.status().text, updates.KEY_MISSING_TEXT);
    assert.equal(r.shown.state, "release_check_not_configured");
  } finally {
    w.cleanup();
  }
});

test("a tampered record: a note over 280 characters is never shown, and a bad floor is ignored", async () => {
  const w = make({ files: { oldest: "0.3.0", note: "Do not start new swaps." } });
  try {
    await w.checker().checkNow();
    const file = w.o.stateFile;
    const st = JSON.parse(fs.readFileSync(file, "utf8"));
    st.update_check.floor.note = "x".repeat(281);
    fs.writeFileSync(file, JSON.stringify(st));
    const s1 = w.checker().status();
    assert.equal(s1.unsafeForNewSwaps, true);
    assert.equal(s1.unsafeNote, null);
    st.update_check.floor = { oldest: "9.9", note: "x" };
    fs.writeFileSync(file, JSON.stringify(st));
    assert.equal(w.checker().status().unsafeForNewSwaps, false);
  } finally {
    w.cleanup();
  }
});
