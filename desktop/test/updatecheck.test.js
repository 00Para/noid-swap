"use strict";
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
const release = (tag, o = {}) => F.withAssets({ tag_name: tag, draft: false, prerelease: false, html_url: `https://github.com/${REPO}/releases/tag/${tag}`, ...o });

function setup(over = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "updcheck-"));
  const calls = { fetch: 0, ask: 0, saved: [] };
  let setting = over.setting || "daily";
  let t = over.now || 10 * DAY;
  const served = F.releaseFetch(() => over.answer || [release("v0.2.0"), release("v0.1.0")], over.files);
  const o = {
    // calls.fetch counts the requests of the releases list; the two notice assets are served by the fixture
    fetchJson: async (url, opts) => {
      if (!url.endsWith("/releases?per_page=10")) return served(url, opts);
      calls.fetch++;
      if (over.fetchThrows) throw new Error("offline");
      return over.answer || [release("v0.2.0"), release("v0.1.0")];
    },
    publicKey: F.PUB,
    currentVersion: "0.1.0",
    repo: over.repo === undefined ? REPO : over.repo,
    anyActive: () => !!over.active,
    setting: () => setting,
    saveSetting: (v) => {
      calls.saved.push(v);
      if (over.saveThrows) throw new Error("disk");
      setting = v;
    },
    ask: async () => {
      calls.ask++;
      if (over.askThrows) throw new Error("dialog");
      return over.askAnswer === undefined ? "daily" : over.askAnswer;
    },
    fs,
    stateFile: path.join(dir, "state.json"),
    now: () => t,
  };
  return { dir, calls, o, make: () => createUpdateChecker(o), advance: (ms) => (t += ms), state: () => JSON.parse(fs.readFileSync(o.stateFile, "utf8")), cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

test("daily: the first start checks, a newer version is shown with its page and the notice, and the time is kept beside the crash times", async () => {
  const s = setup();
  try {
    fs.writeFileSync(s.o.stateFile, JSON.stringify({ v: 1, crashes: [5] }));
    const c = s.make();
    assert.deepEqual(c.status(), { state: "never", latest: null, url: null, unsafeForNewSwaps: false, unsafeNote: null });
    assert.equal(await c.atStart(), "checked");
    assert.equal(s.calls.fetch, 1);
    assert.deepEqual(c.status(), { state: "newer", latest: "0.2.0", url: `https://github.com/${REPO}/releases/tag/v0.2.0`, text: updates.NOTICE_TEXT, note: "A short note.", sha256: [{ name: "setup.exe", sha256: "a".repeat(64) }], unsafeForNewSwaps: false, unsafeNote: null });
    const st = s.state();
    assert.deepEqual(st.crashes, [5], "the crash handler's key is left as it was");
    assert.equal(st.update_check.last_checked_ms, 10 * DAY);
    // the same day: not again; a day later: again; a new checker reads the last answer back
    assert.equal(await s.make().atStart(), "not-due");
    assert.equal(s.calls.fetch, 1);
    assert.equal(s.make().status().state, "newer");
    s.advance(DAY);
    assert.equal(await s.make().atStart(), "checked");
    assert.equal(s.calls.fetch, 2);
  } finally {
    s.cleanup();
  }
});

test("off never checks by itself; the menu item still checks", async () => {
  const s = setup({ setting: "off" });
  try {
    const c = s.make();
    assert.equal(await c.atStart(), "off");
    assert.equal(s.calls.fetch, 0);
    const r = await c.checkNow();
    assert.equal(r.state, "newer");
    assert.equal(s.calls.fetch, 1);
  } finally {
    s.cleanup();
  }
});

test("ask: the first start asks once and stores the answer; a closed dialog asks again next time; a failed save still honours the answer", async () => {
  const yes = setup({ setting: "ask", askAnswer: "daily" });
  try {
    assert.equal(await yes.make().atStart(), "checked");
    assert.deepEqual(yes.calls.saved, ["daily"]);
    assert.equal(yes.calls.fetch, 1);
  } finally {
    yes.cleanup();
  }
  const no = setup({ setting: "ask", askAnswer: "off" });
  try {
    assert.equal(await no.make().atStart(), "asked-off");
    assert.deepEqual(no.calls.saved, ["off"]);
    assert.equal(no.calls.fetch, 0);
  } finally {
    no.cleanup();
  }
  for (const over of [{ askAnswer: null }, { askAnswer: "sometimes" }, { askThrows: true }]) {
    const later = setup({ setting: "ask", ...over });
    try {
      assert.equal(await later.make().atStart(), "ask-later");
      assert.deepEqual(later.calls.saved, []);
      assert.equal(later.calls.fetch, 0);
    } finally {
      later.cleanup();
    }
  }
  const broken = setup({ setting: "ask", askAnswer: "daily", saveThrows: true });
  try {
    assert.equal(await broken.make().atStart(), "checked");
  } finally {
    broken.cleanup();
  }
});

test("never while a swap is active: nothing is asked of the network and no time is kept, so the next start tries again", async () => {
  const s = setup({ active: true });
  try {
    const c = s.make();
    assert.equal(await c.atStart(), "checked");
    assert.equal(s.calls.fetch, 0);
    assert.equal(fs.existsSync(s.o.stateFile), false);
    assert.equal(c.status().state, "never");
    const r = await c.checkNow();
    assert.equal(r.state, "skipped_active");
    assert.equal(s.calls.fetch, 0);
  } finally {
    s.cleanup();
  }
});

test("errors: no repository in this build, an offline network and a bad answer are shown as their state without a page; same version is none", async () => {
  const none = setup({ repo: null });
  try {
    const c = none.make();
    await c.atStart();
    assert.equal(none.calls.fetch, 0);
    assert.deepEqual(c.status(), { state: "not_configured", latest: null, url: null, unsafeForNewSwaps: false, unsafeNote: null });
  } finally {
    none.cleanup();
  }
  // nor is the first-start question asked: it would offer a check this build cannot make
  const noneAsk = setup({ repo: null, setting: "ask" });
  try {
    const c = noneAsk.make();
    assert.equal(await c.atStart(), "not-configured");
    assert.equal(noneAsk.calls.ask, 0);
    assert.equal(noneAsk.calls.fetch, 0);
    assert.deepEqual(noneAsk.calls.saved, []);
    assert.deepEqual(c.status(), { state: "not_configured", latest: null, url: null, unsafeForNewSwaps: false, unsafeNote: null });
  } finally {
    noneAsk.cleanup();
  }
  for (const over of [{ fetchThrows: true }, { answer: "not json" }, { answer: [release("v9.0.0", { html_url: "https://evil.example/v9.0.0" })] }]) {
    const s = setup(over);
    try {
      const c = s.make();
      await c.atStart();
      assert.deepEqual(c.status(), { state: "error", latest: null, url: null, unsafeForNewSwaps: false, unsafeNote: null });
    } finally {
      s.cleanup();
    }
  }
  const same = setup({ answer: [release("v0.1.0")] });
  try {
    const c = same.make();
    await c.atStart();
    assert.deepEqual(c.status(), { state: "none", latest: null, url: null, unsafeForNewSwaps: false, unsafeNote: null });
  } finally {
    same.cleanup();
  }
});

test("a broken state.json gives a check, never a throw; two calls at once make one request", async () => {
  const s = setup();
  try {
    fs.writeFileSync(s.o.stateFile, "{broken");
    const c = s.make();
    const [a, b] = await Promise.all([c.checkNow(), c.checkNow()]);
    assert.equal(a.state, "newer");
    assert.equal(b.state, "newer");
    assert.equal(s.calls.fetch, 1);
    assert.equal(s.state().update_check.last.state, "newer");
  } finally {
    s.cleanup();
  }
});
