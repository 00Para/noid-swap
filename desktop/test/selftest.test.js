"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { makeEnv } = require("./shell-fixture");
const { runSelfTest, createSelfTestVault, requestStatus, holdMsFrom, pickPrefs, prefsOk, pageProbeProblem, secretProbeProblem, PAGE_PROBE } = require("../lib/selftest");

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
/** the secret window's probe when its page loaded with its script and its bridge */
const GOOD_SECRET = { loaded: true, script: true, css: true, bridge: true };
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
    assert.deepEqual(Object.keys(j), ["selftest", "node", "page", "prefs", "no_token", "page_script", "page_post", "secret_page"]);
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
    secretProbe: async () => GOOD_SECRET,
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
    secretProbe: async () => GOOD_SECRET,
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
    secretProbe: async () => GOOD_SECRET,
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
    await runSelfTest({ whenLoaded: async () => {}, webContents, request: async () => 401, secretProbe: async () => GOOD_SECRET, nodeCheck: { checkOnce: async () => ({ noid: { state: "not_running" } }) }, stop: async () => {}, cleanup: () => {}, print: (l) => lines.push(l), exit: (c) => (code = c) });
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

test("the secret window's probe: a page that did not load, a script, stylesheet or bridge missing, a probe that throws and no probe at all fail the self-test with words", async () => {
  const run = async (secretProbe) => {
    const lines = [];
    let code = null;
    await runSelfTest({ whenLoaded: async () => {}, webContents: goodPage(), request: async () => 401, secretProbe, nodeCheck: { checkOnce: async () => ({ noid: { state: "not_running" } }) }, stop: async () => {}, cleanup: () => {}, print: (l) => lines.push(l), exit: (c) => (code = c) });
    return { code, j: JSON.parse(lines[0]) };
  };
  const cases = [
    [async () => ({ loaded: false, script: false, css: false, bridge: false, why: "ERR_FILE_NOT_FOUND" }), /secret window's page did not load \(ERR_FILE_NOT_FOUND\)/],
    [async () => ({ loaded: false }), /secret window's page did not load$/],
    [async () => ({ ...GOOD_SECRET, script: false }), /secret window's script did not run/],
    [async () => ({ ...GOOD_SECRET, css: false }), /secret window's stylesheet did not load/],
    [async () => ({ ...GOOD_SECRET, bridge: false }), /preload did not give the page its bridge/],
    [async () => null, /did not answer its probe/],
    [async () => { throw new Error("the window could not be made"); }, /the window could not be made/],
    [undefined, /secret window's page could not be checked/],
  ];
  for (const [probe, re] of cases) {
    const r = await run(probe);
    assert.equal(r.code, 1, String(re));
    assert.equal(r.j.selftest, "failed");
    assert.match(r.j.why, re);
    assert.equal("secret_page" in r.j, false);
  }
  assert.equal(secretProbeProblem(GOOD_SECRET), null);
  const ok = await run(async () => GOOD_SECRET);
  assert.equal(ok.code, 0);
  assert.equal(ok.j.secret_page, true);
});

test("with the fake, a secret page that cannot be served fails the self-test with words", async () => {
  const e = makeEnv({ argv: ["x.exe", "--self-test"] });
  try {
    // the secret session's handler answers nothing: the page's files are 404
    e.electron.session.fromPartition = ((from) => (p) => {
      const s = from(p);
      if (p === "no1d-secret") {
        const handle = s.protocol.handle.bind(s.protocol);
        s.protocol.handle = (scheme) => handle(scheme, () => new Response("no", { status: 404 }));
      }
      return s;
    })(e.electron.session.fromPartition);
    await e.shell.start();
    assert.equal(e.electron.app.exitCode, 1);
    assert.match(JSON.parse(e.stdout[0]).why, /secret window's script did not run/);
  } finally {
    e.cleanup();
  }
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

test("the hold keeps everything up while it waits: the program stops only after it; the line is printed before the stop, so a stop that hangs cannot hide it", async () => {
  const order = [];
  let code = null;
  await runSelfTest({
    whenLoaded: async () => {},
    webContents: goodPage(),
    request: async () => 401,
    secretProbe: async () => GOOD_SECRET,
    nodeCheck: { checkOnce: async () => (order.push("check"), { noid: { state: "not_running" } }) },
    stop: async () => order.push("stop"),
    cleanup: () => order.push("cleanup"),
    print: () => order.push("print"),
    exit: (c) => ((code = c), order.push("exit")),
    holdMs: 60,
  });
  assert.deepEqual(order, ["check", "print", "stop", "cleanup", "exit"]);
  assert.equal(code, 0);
  const t0 = Date.now();
  await runSelfTest({
    whenLoaded: async () => {},
    webContents: goodPage(),
    request: async () => 401,
    secretProbe: async () => GOOD_SECRET,
    nodeCheck: { checkOnce: async () => ({ noid: { state: "not_running" } }) },
    stop: async () => order.push(`stop after ${Date.now() - t0 >= 50}`),
    cleanup: () => {},
    print: () => {},
    exit: () => {},
    holdMs: 60,
  });
  assert.equal(order[order.length - 1], "stop after true");
});

test("a stop that never ends: the line is already printed, and the program exits after stopMs anyway", async () => {
  const order = [];
  let code = null;
  const t0 = Date.now();
  await runSelfTest({
    whenLoaded: async () => {},
    webContents: goodPage(),
    request: async () => 401,
    secretProbe: async () => GOOD_SECRET,
    nodeCheck: { checkOnce: async () => ({ noid: { state: "not_running" } }) },
    stop: () => new Promise(() => {}),
    cleanup: () => order.push("cleanup"),
    print: (l) => order.push(JSON.parse(l).selftest),
    exit: (c) => ((code = c), order.push("exit")),
    stopMs: 40,
  });
  assert.deepEqual(order, ["ok", "cleanup", "exit"]);
  assert.equal(code, 0);
  assert.ok(Date.now() - t0 >= 35, "it waited for the stop as long as allowed");
});

test("the progress lines name each step in order; a progress function that throws changes nothing", async () => {
  const steps = [];
  await runSelfTest({
    whenLoaded: async () => {},
    webContents: goodPage(),
    request: async () => 401,
    secretProbe: async () => GOOD_SECRET,
    nodeCheck: { checkOnce: async () => ({ noid: { state: "not_running" } }) },
    stop: async () => {},
    cleanup: () => {},
    print: () => {},
    exit: () => {},
    holdMs: 5,
    progress: (s) => steps.push(s),
  });
  assert.deepEqual(steps, ["checks begin", "page loaded", "request without the token answered", "page probe answered", "secret page probe answered", "node check answered", "hold over", "result printed", "stopped"]);
  let code = null;
  const lines = [];
  await runSelfTest({
    whenLoaded: async () => {},
    webContents: goodPage(),
    request: async () => 401,
    secretProbe: async () => GOOD_SECRET,
    nodeCheck: { checkOnce: async () => ({ noid: { state: "not_running" } }) },
    stop: async () => {},
    cleanup: () => {},
    print: (l) => lines.push(l),
    exit: (c) => (code = c),
    progress: () => {
      throw new Error("stderr is closed");
    },
  });
  assert.equal(code, 0);
  assert.equal(JSON.parse(lines[0]).selftest, "ok");
});

test("the shell in the self-test: each stage and step goes to stderr with the time; a start-up failure prints its reason as the line and opens no dialog", async () => {
  const e = makeEnv({ argv: ["x.exe", "--self-test"] });
  try {
    await e.shell.start();
    assert.equal(e.electron.app.exitCode, 0);
    const err = e.stderr.join("");
    for (const s of ["self-test: stage cmdline at 1.3 s", "self-test: stage setPath at", "self-test: stage ready at", "self-test: checks begin at", "self-test: page loaded at", "self-test: result printed at", "self-test: stopped at"]) {
      assert.ok(err.includes(s), s);
    }
    assert.equal(e.stdout.length, 1, "stdout holds only the line");
  } finally {
    e.cleanup();
  }
  // a start-up failure in the self-test (the data folder's guard refuses): the reason is the line, no dialog waits for a click
  const f = makeEnv({ argv: ["x.exe", "--self-test"], guardFails: true });
  try {
    await f.shell.start().catch(() => {});
    assert.equal(f.electron.app.exitCode, 1);
    const j = JSON.parse(f.stdout.join("").trim());
    assert.equal(j.selftest, "failed");
    assert.match(j.why, /data folder is not private to you: another account can read this folder/);
    assert.ok(!f.electron.calls.some((c) => c.name === "showErrorBox"), "no dialog in the self-test");
  } finally {
    f.cleanup();
  }
  // a normal start keeps the dialog, and writes no stage line
  const n = makeEnv({ guardFails: true });
  try {
    await n.shell.start().catch(() => {});
    assert.ok(n.electron.calls.some((c) => c.name === "showErrorBox"));
    assert.equal(n.stderr.join(""), "");
    assert.equal(n.stdout.join(""), "");
  } finally {
    n.cleanup();
  }
});

test("NO1D_SELFTEST_REPORT: the self-test appends its stage lines and its line to that file; a relative path and a normal start write none", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "no1d-report-"));
  try {
    const file = path.join(dir, "selftest.report");
    const e = makeEnv({ argv: ["x.exe", "--self-test"] });
    e.proc.env.NO1D_SELFTEST_REPORT = file;
    try {
      await e.shell.start();
      assert.equal(e.electron.app.exitCode, 0);
      const lines = fs.readFileSync(file, "utf8").trim().split("\n");
      assert.ok(lines.includes("self-test: stage cmdline at 1.3 s"));
      assert.ok(lines.some((l) => l.startsWith("self-test: result printed at")));
      const json = lines.filter((l) => l.startsWith("{"));
      assert.equal(json.length, 1);
      assert.equal(JSON.parse(json[0]).selftest, "ok");
      assert.equal(json[0], e.stdout.join("").trim(), "the report holds the same line as stdout");
    } finally {
      e.cleanup();
    }
    // a start-up failure: the reason is in the report too
    const failFile = path.join(dir, "fail.report");
    const f = makeEnv({ argv: ["x.exe", "--self-test"], guardFails: true });
    f.proc.env.NO1D_SELFTEST_REPORT = failFile;
    try {
      await f.shell.start();
      const j = fs.readFileSync(failFile, "utf8").trim().split("\n").filter((l) => l.startsWith("{"));
      assert.equal(JSON.parse(j[0]).selftest, "failed");
      assert.match(JSON.parse(j[0]).why, /not private to you/);
    } finally {
      f.cleanup();
    }
    // a relative path is not used
    const r = makeEnv({ argv: ["x.exe", "--self-test"] });
    r.proc.env.NO1D_SELFTEST_REPORT = "selftest.report";
    try {
      await r.shell.start();
      assert.equal(r.electron.app.exitCode, 0);
      assert.equal(fs.existsSync(path.resolve("selftest.report")), false);
    } finally {
      r.cleanup();
    }
    // a normal start never reads it
    const normalFile = path.join(dir, "normal.report");
    const n = makeEnv({ guardFails: true });
    n.proc.env.NO1D_SELFTEST_REPORT = normalFile;
    try {
      await n.shell.start().catch(() => {});
      assert.equal(fs.existsSync(normalFile), false);
    } finally {
      n.cleanup();
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("the self-test and an unexpected error: a throw that is no start-up failure, and an uncaught error later, print their words as the line and exit 1 with no dialog", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "no1d-report-"));
  try {
    const file = path.join(dir, "selftest.report");
    const e = makeEnv({ argv: ["x.exe", "--self-test"] });
    e.proc.env.NO1D_SELFTEST_REPORT = file;
    e.modules.server.startProgramServer = async () => {
      throw new TypeError("server could not be built");
    };
    try {
      const r = await e.shell.start();
      assert.equal(r.state, "aborted");
      assert.equal(e.electron.app.exitCode, 1);
      const j = JSON.parse(e.stdout.join("").trim());
      assert.equal(j.selftest, "failed");
      assert.equal(j.why, "an unexpected error ended the start: TypeError: server could not be built");
      assert.ok(!e.electron.calls.some((c) => c.name === "showErrorBox"), "no dialog in the self-test");
      const report = fs.readFileSync(file, "utf8");
      assert.match(report, /self-test: stage server at/);
      assert.match(report, /self-test: unexpected error at/);
      assert.ok(report.includes(JSON.stringify(j)));
      assert.equal(e.shell.tempDir, null, "the temporary folder is removed");
    } finally {
      e.cleanup();
    }
    // outside the self-test the same throw still reaches main.js, which says "could not start" in a dialog
    const n = makeEnv();
    n.modules.server.startProgramServer = async () => {
      throw new TypeError("server could not be built");
    };
    try {
      await assert.rejects(n.shell.start(), /server could not be built/);
      assert.equal(n.stdout.join(""), "");
    } finally {
      n.cleanup();
    }
    // an uncaught error while the self-test runs (the quiet handler stays installed for the whole self-test)
    const u = makeEnv({ argv: ["x.exe", "--self-test"] });
    try {
      await u.shell.start();
      assert.equal(u.electron.app.exitCode, 0);
      u.proc.emit("unhandledRejection", new Error("late\nrejection"));
      assert.equal(u.electron.app.exitCode, 1);
      const lines = u.stdout.join("").trim().split("\n");
      assert.equal(JSON.parse(lines[0]).selftest, "ok");
      assert.equal(JSON.parse(lines[1]).why, "an unexpected error ended the start: Error: late rejection", "the last line says it, on one line");
    } finally {
      u.cleanup();
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("the folder guard's detail is added to the self-test's line, never to a normal start's dialog", async () => {
  const s = makeEnv({ argv: ["x.exe", "--self-test"], guardFails: true, guardDetail: "timed out after 20 s" });
  try {
    await s.shell.start();
    assert.equal(JSON.parse(s.stdout.join("").trim()).why, "The program's data folder is not private to you: another account can read this folder (detail: timed out after 20 s)");
  } finally {
    s.cleanup();
  }
  const n = makeEnv({ guardFails: true, guardDetail: "timed out after 20 s" });
  try {
    await n.shell.start().catch(() => {});
    const box = n.electron.calls.find((c) => c.name === "showErrorBox");
    assert.ok(box);
    assert.ok(!JSON.stringify(box).includes("detail"), "the dialog shows the fixed sentence only");
  } finally {
    n.cleanup();
  }
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
