"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { makeEnv } = require("./shell-fixture");
const { runSelfTest, createSelfTestVault, requestStatus, holdMsFrom, pickPrefs, prefsOk, pageProbeProblem, PAGE_PROBE } = require("../lib/selftest");

// The folder this test's self-test made (userData is its electron/ subfolder). Only that one is checked: another test file, or another
// run of the suite, may be making its own no1d-selftest- folder in the same temporary folder at the same time.
const ownTmp = (e) => {
  const d = path.dirname(e.electron.app.paths.userData);
  assert.equal(path.dirname(d), os.tmpdir());
  assert.ok(path.basename(d).startsWith("no1d-selftest-"));
  return d;
};
const GOOD_PREFS = { contextIsolation: true, sandbox: true, nodeIntegration: false, webSecurity: true, webviewTag: false };
/** web contents whose page answers the probe: `probe` is its answer (default: scripts ran, the POST was refused for the token). */
const goodPage = (probe = { scripts: true, post: { status: 403, error: "missing or wrong token" } }) => ({ getLastWebPreferences: () => GOOD_PREFS, executeJavaScript: async () => probe });

test("with the fake: one JSON line, exit 0, the temporary folder gone, the real data folder untouched", async () => {
  const e = makeEnv({ argv: ["x.exe", "--self-test"], updateSetting: "daily", updateRepo: "owner-x/no1d-swap", updateAnswer: [] });
  try {
    const r = await e.shell.start();
    assert.equal(r.state, "selftest");
    assert.equal(e.electron.app.exitCode, 0);
    assert.equal(e.fetched.length, 0, "the self-test never asks for a new version, whatever the settings say");
    assert.deepEqual(e.program().updateStatus(), { state: "never", latest: null, url: null });
    assert.equal(e.stdout.length, 1);
    const line = e.stdout[0];
    assert.ok(line.endsWith("\n") && line.trim().split("\n").length === 1);
    const j = JSON.parse(line);
    assert.deepEqual(Object.keys(j), ["selftest", "node", "page", "prefs", "no_token", "page_script", "page_post"]);
    // the page's POST went through the session's own scheme handler to the real server and was refused for the token
    assert.equal(j.page_script, true);
    assert.equal(j.page_post, 403);
    assert.ok(e.electron.calls.some((c) => c.who === "webContents" && c.name === "executeJavaScript"));
    assert.equal(j.selftest, "ok");
    assert.equal(j.node, "not_running");
    assert.equal(j.page, "loaded");
    assert.equal(j.no_token, 401);
    assert.deepEqual(j.prefs, { contextIsolation: true, sandbox: true, nodeIntegration: false, webSecurity: true, webviewTag: false });
    // the real data folder is never touched, no vault is opened, no real settings are read
    assert.ok(!e.rec.includes("dataDirFor"));
    assert.ok(!e.rec.includes("createVault"));
    assert.ok(!e.rec.includes("vault.open"));
    assert.ok(!fs.existsSync(e.dataDir));
    const ensured = e.rec.find((x) => x.startsWith("ensureDataDirs:"));
    assert.ok(ensured && ensured.includes("no1d-selftest-"));
    // userData is the temporary folder, set before the single-instance lock
    const names = e.electron.calls.map((c) => c.name);
    assert.ok(names.indexOf("setPath") < names.indexOf("requestSingleInstanceLock"));
    assert.ok(e.electron.app.paths.userData.includes("no1d-selftest-"));
    // the temporary folder is removed
    assert.equal(fs.existsSync(ownTmp(e)), false);
    // the window is hidden and destroyed; no tray, no login item, no crash handler
    assert.equal(e.electron.windows[0].visible, false);
    assert.equal(e.electron.trays.length, 0);
    assert.equal(e.electron.app.loginItem, null);
    // no crash handler (no relaunch, no state file); only the quiet one, which ends the program without Electron's error dialog
    assert.equal(e.proc.listenerCount("uncaughtException"), 1);
    e.electron.calls.length = 0;
    e.proc.emit("uncaughtException", new Error("x"));
    assert.deepEqual(e.electron.calls.map((c) => c.name), ["exit"]);
    assert.ok(e.rec.includes("server.stop"));
    assert.deepEqual(e.shell.trace, ["cmdline", "setPath", "lock", "manifest", "dirs", "ready", "vault", "nodecheck", "server"]);
  } finally {
    e.cleanup();
  }
});

test("self-test fails with exit 1 when /api answers without the token", async () => {
  const e = makeEnv({ argv: ["x.exe", "--self-test"], noTokenStatus: 200 });
  try {
    await e.shell.start();
    assert.equal(e.electron.app.exitCode, 1);
    const j = JSON.parse(e.stdout[0]);
    assert.equal(j.selftest, "failed");
    assert.match(j.why, /without the token/);
    assert.equal(fs.existsSync(ownTmp(e)), false, "a failed self-test still removes its folder");
  } finally {
    e.cleanup();
  }
});

test("self-test fails with exit 1 when the page does not load", async () => {
  const e = makeEnv({ argv: ["x.exe", "--self-test"], electron: { loadFails: true } });
  try {
    await e.shell.start();
    assert.equal(e.electron.app.exitCode, 1);
    assert.equal(JSON.parse(e.stdout[0]).selftest, "failed");
  } finally {
    e.cleanup();
  }
});

test("self-test with a damaged window preference fails", async () => {
  const lines = [];
  let code = null;
  const r = await runSelfTest({
    whenLoaded: async () => {},
    webContents: { getLastWebPreferences: () => ({ contextIsolation: false, sandbox: true, nodeIntegration: false, webSecurity: true, webviewTag: false }) },
    request: async () => 401,
    nodeCheck: { checkOnce: async () => ({ noid: { state: "not_running" } }) },
    stop: async () => {},
    cleanup: () => {},
    print: (l) => lines.push(l),
    exit: (c) => (code = c),
  });
  assert.equal(code, 1);
  assert.equal(r.code, 1);
  assert.match(JSON.parse(lines[0]).why, /preferences/);
});

test("self-test times out", async () => {
  let code = null;
  const lines = [];
  await runSelfTest({
    whenLoaded: () => new Promise(() => {}),
    webContents: {},
    request: async () => 401,
    nodeCheck: { checkOnce: async () => ({}) },
    stop: async () => {},
    cleanup: () => {},
    print: (l) => lines.push(l),
    exit: (c) => (code = c),
    timeoutMs: 20,
  });
  assert.equal(code, 1);
  assert.match(JSON.parse(lines[0]).why, /timed out/);
});

test("a failing stop or cleanup does not hide the result", async () => {
  let code = null;
  const lines = [];
  await runSelfTest({
    whenLoaded: async () => {},
    webContents: goodPage(),
    request: async () => 401,
    nodeCheck: { checkOnce: async () => ({ noid: { state: "ok" } }) },
    stop: async () => {
      throw new Error("x");
    },
    cleanup: () => {
      throw new Error("y");
    },
    print: (l) => lines.push(l),
    exit: (c) => (code = c),
  });
  assert.equal(code, 0);
  assert.equal(JSON.parse(lines[0]).node, "ok");
});

test("the page probe: scripts that did not run, a POST refused for its Origin, any other answer and no way to ask the page all fail the self-test", async () => {
  const run = async (webContents) => {
    const lines = [];
    let code = null;
    await runSelfTest({ whenLoaded: async () => {}, webContents, request: async () => 401, nodeCheck: { checkOnce: async () => ({ noid: { state: "not_running" } }) }, stop: async () => {}, cleanup: () => {}, print: (l) => lines.push(l), exit: (c) => (code = c) });
    return { code, j: JSON.parse(lines[0]) };
  };
  const cases = [
    [goodPage({ scripts: false, post: { status: 403, error: "missing or wrong token" } }), /scripts did not run/],
    [goodPage({ scripts: true, post: { status: 403, error: "cross-origin request refused" } }), /refused for its Origin/],
    [goodPage({ scripts: true, post: { status: 200, error: null } }), /not refused for the token \(status 200\)/],
    [goodPage({ scripts: true, post: { status: 0, error: "the fetch failed" } }), /status 0, "the fetch failed"/],
    [goodPage(null), /did not answer/],
    [{ getLastWebPreferences: () => GOOD_PREFS }, /could not be asked/],
  ];
  for (const [wc, re] of cases) {
    const r = await run(wc);
    assert.equal(r.code, 1);
    assert.equal(r.j.selftest, "failed");
    assert.match(r.j.why, re);
  }
  assert.equal(pageProbeProblem({ scripts: true, post: { status: 403, error: "missing or wrong token" } }), null);
  // the probe is one expression that sends no token and names no other address
  assert.ok(!/token=|x-swap-token|no1d:\/\/|https?:/.test(PAGE_PROBE));
  assert.match(PAGE_PROBE, /fetch\("\/api\/program\/open"/);
});

test("with the fake, a handler whose Origin check refuses the page fails the self-test with words", async () => {
  const e = makeEnv({ argv: ["x.exe", "--self-test"], electron: { pageScript: async () => ({ scripts: true, post: { status: 403, error: "cross-origin request refused" } }) } });
  try {
    await e.shell.start();
    assert.equal(e.electron.app.exitCode, 1);
    assert.match(JSON.parse(e.stdout[0]).why, /refused for its Origin/);
  } finally {
    e.cleanup();
  }
});

test("the self-test vault refuses everything", async () => {
  const v = createSelfTestVault();
  assert.deepEqual(await v.open(), { state: "locked" });
  assert.equal(v.ready().ok, false);
  assert.equal(v.newSwapAllowed().ok, false);
  assert.equal(v.recoveryConfirmed(), false);
  assert.throws(() => v.passphraseFor("d", "r"), /no passphrase/);
  assert.throws(() => v.boardSealer("r"), /no board sealer/);
  assert.equal(v.inviteSecret(), null);
  assert.match(v.keyCheck(), /^[0-9a-f]{16}$/);
});

test("pickPrefs and prefsOk", () => {
  assert.equal(prefsOk({ contextIsolation: true, sandbox: true, nodeIntegration: false, webSecurity: true, webviewTag: false, extra: 1 }), true);
  assert.equal(prefsOk({ contextIsolation: true, sandbox: false, nodeIntegration: false, webSecurity: true, webviewTag: false }), false);
  assert.equal(prefsOk(undefined), false);
  assert.deepEqual(Object.keys(pickPrefs({ a: 1 })), ["contextIsolation", "sandbox", "nodeIntegration", "webSecurity", "webviewTag"]);
});

test("without a stand-in, the self-test's no-token request goes through the scheme adapter to the server's handler and is refused with 401", async () => {
  const e = makeEnv({ argv: ["x.exe", "--self-test"], realRequestStatus: true });
  try {
    await e.shell.start();
    assert.equal(e.electron.app.exitCode, 0);
    const j = JSON.parse(e.stdout[0]);
    assert.equal(j.selftest, "ok");
    assert.equal(j.no_token, 401);
    assert.ok(e.rec.includes("handler:GET:/api/program"), "the request reached the handler");
  } finally {
    e.cleanup();
  }
});

test("requestStatus asks the adapter for no1d://app and gives back the status", async () => {
  const seen = [];
  const adapter = async (request) => {
    seen.push([request.url, request.method, [...request.headers].length]);
    return new Response("{}", { status: 401 });
  };
  assert.equal(await requestStatus(adapter, "/api/program"), 401);
  assert.deepEqual(seen, [["no1d://app/api/program", "GET", 0]]);
});

test("holdMsFrom: a whole number of seconds from 1 to 30, anything else is no hold", () => {
  assert.equal(holdMsFrom("12"), 12000);
  assert.equal(holdMsFrom("1"), 1000);
  assert.equal(holdMsFrom("30"), 30000);
  for (const bad of [undefined, null, "", "0", "00", "31", "99", "-5", "1.5", "abc", "10s", " 10", "100"]) assert.equal(holdMsFrom(bad), 0, String(bad));
});

test("the hold keeps everything up while it waits: the program stops only after it, and the line is printed after the stop", async () => {
  const order = [];
  let code = null;
  await runSelfTest({
    whenLoaded: async () => {},
    webContents: goodPage(),
    request: async () => 401,
    nodeCheck: { checkOnce: async () => (order.push("check"), { noid: { state: "not_running" } }) },
    stop: async () => order.push("stop"),
    cleanup: () => order.push("cleanup"),
    print: () => order.push("print"),
    exit: (c) => ((code = c), order.push("exit")),
    holdMs: 60,
  });
  assert.deepEqual(order, ["check", "stop", "cleanup", "print", "exit"]);
  assert.equal(code, 0);
  const t0 = Date.now();
  await runSelfTest({
    whenLoaded: async () => {},
    webContents: goodPage(),
    request: async () => 401,
    nodeCheck: { checkOnce: async () => ({ noid: { state: "not_running" } }) },
    stop: async () => order.push(`stop after ${Date.now() - t0 >= 50}`),
    cleanup: () => {},
    print: () => {},
    exit: () => {},
    holdMs: 60,
  });
  assert.equal(order[order.length - 1], "stop after true");
});

test("NO1D_SELFTEST_HOLD_SECONDS is read from the program's environment by the self-test", async () => {
  const e = makeEnv({ argv: ["x.exe", "--self-test"] });
  e.proc.env.NO1D_SELFTEST_HOLD_SECONDS = "1";
  const t0 = Date.now();
  try {
    await e.shell.start();
    assert.ok(Date.now() - t0 >= 900, "the self-test waited about a second");
    assert.equal(e.electron.app.exitCode, 0);
  } finally {
    e.cleanup();
  }
});
