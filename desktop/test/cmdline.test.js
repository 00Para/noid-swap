"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { parseCommandLine, OWN_SWITCHES, REFUSED_SWITCH_NAMES } = require("../lib/shell");
const { makeEnv } = require("./shell-fixture");

test("the five switches of the spec are refused, in every spelling", () => {
  for (const arg of ["--remote-debugging-port=9222", "--remote-debugging-port", "--remote-debugging-pipe", "--inspect", "--inspect=9229", "--inspect-brk", "--inspect-brk=0.0.0.0:9229", "--js-flags=--expose-gc", "--js-flags"]) {
    const r = parseCommandLine(["x.exe", arg]);
    assert.ok(r.refused, arg);
    assert.ok(arg.startsWith(r.refused), `${arg} names ${r.refused}`);
  }
  assert.equal(parseCommandLine(["x", "--REMOTE-DEBUGGING-PORT=1"]).refused, "--REMOTE-DEBUGGING-PORT");
});

test("switches that weaken the window or open it to another program are refused too", () => {
  for (const arg of ["--no-sandbox", "--disable-web-security", "--remote-allow-origins=*", "--allow-running-insecure-content", "--ignore-certificate-errors", "--debug-port=1", "--allow-file-access-from-files"]) {
    assert.ok(parseCommandLine(["x", arg]).refused, arg);
  }
});

test("hasSwitch (Chromium's own command line) is asked for the five names", () => {
  for (const n of ["remote-debugging-port", "remote-debugging-pipe", "inspect", "inspect-brk", "js-flags"]) {
    assert.equal(parseCommandLine(["x"], (name) => name === n).refused, `--${n}`);
  }
  assert.equal(parseCommandLine(["x"], () => false).refused, null);
  assert.equal(parseCommandLine(["x"], () => { throw new Error("no"); }).refused, null);
  assert.ok(REFUSED_SWITCH_NAMES.length === 5);
});

test("the program's own switches are exactly two", () => {
  assert.deepEqual([...OWN_SWITCHES], ["--hidden", "--self-test"]);
});

test("only --hidden and --self-test are read; other arguments that are not switches are ignored", () => {
  assert.deepEqual(parseCommandLine(["x.exe", "--hidden"]), { refused: null, hidden: true, selfTest: false });
  assert.deepEqual(parseCommandLine(["x.exe", "--self-test"]), { refused: null, hidden: false, selfTest: true });
  assert.deepEqual(parseCommandLine(["x.exe", "--hidden", "--self-test", "C:\\folder\\file.json", "."]), { refused: null, hidden: true, selfTest: true });
  assert.deepEqual(parseCommandLine([]), { refused: null, hidden: false, selfTest: false });
  assert.deepEqual(parseCommandLine(undefined), { refused: null, hidden: false, selfTest: false });
});

test("any switch that is not the program's own is refused, whatever it is called and however it is spelled", () => {
  for (const arg of ["--proxy-server=http://127.0.0.1:8888", "--log-net-log=x.json", "--enable-logging", "--host-resolver-rules=MAP * 127.0.0.1", "--enable-features=Foo", "--user-data-dir=/x", "--something-else", "--hidden=1", "--"]) {
    assert.equal(parseCommandLine(["x.exe", arg]).refused, arg.split("=")[0], arg);
  }
  // single dash: Chromium reads it too
  for (const arg of ["-remote-debugging-port=9222", "-inspect", "-proxy-server=x", "-no-sandbox", "-hidden", "-"]) {
    assert.equal(parseCommandLine(["x.exe", arg]).refused, arg.split("=")[0], arg);
  }
  // an own switch in a refused company is still refused, wherever it stands
  assert.equal(parseCommandLine(["x.exe", "--hidden", "-inspect"]).refused, "-inspect");
  assert.equal(parseCommandLine(["x.exe", "--proxy-server=a", "--hidden"]).refused, "--proxy-server");
  // the first one is named
  assert.equal(parseCommandLine(["x.exe", "--a", "--b"]).refused, "--a");
  // own switches in the other case are the same switches
  assert.deepEqual(parseCommandLine(["x.exe", "--Hidden"]), { refused: null, hidden: true, selfTest: false });
});

test("on Windows a slash switch is refused too; a path is not a switch on the other systems", () => {
  assert.equal(parseCommandLine(["x.exe", "/proxy-server=x"], undefined, "win32").refused, "/proxy-server");
  assert.equal(parseCommandLine(["x.exe", "/inspect"], undefined, "win32").refused, "/inspect");
  assert.equal(parseCommandLine(["/Applications/No1d Swap.app/Contents/MacOS/No1d Swap", "/tmp/x.json"], undefined, "darwin").refused, null);
  assert.equal(parseCommandLine(["C:\\Program Files\\No1d Swap\\No1d Swap.exe", "C:\\x\\y.json"], undefined, "win32").refused, null);
});

test("macOS: the process serial number the launcher appends is not refused, in no other form", () => {
  assert.equal(parseCommandLine(["x", "-psn_0_12345"], undefined, "darwin").refused, null);
  assert.equal(parseCommandLine(["x", "-psn_0_12345", "--hidden"], undefined, "darwin").hidden, true);
  assert.equal(parseCommandLine(["x", "-psn_a_b"], undefined, "darwin").refused, "-psn_a_b");
  assert.equal(parseCommandLine(["x", "-psn_0_1"], undefined, "win32").refused, "-psn_0_1");
});

test("a refused switch exits 1 before the data folder, the vault or the server is touched", async () => {
  for (const arg of ["--remote-debugging-port=9222", "--inspect", "--inspect-brk", "--js-flags=--x", "--remote-debugging-pipe", "--proxy-server=http://127.0.0.1:1", "-enable-logging"]) {
    const e = makeEnv({ argv: ["x.exe", arg] });
    try {
      const r = await e.shell.start();
      assert.equal(r.state, "aborted", arg);
      assert.equal(e.electron.app.exitCode, 1);
      assert.match(e.electron.dialog.errorBoxes[0].text, /does not start with a switch of its own kind/);
      assert.deepEqual(e.shell.trace, ["cmdline"]);
      assert.equal(e.rec.length, 0);
      assert.equal(e.electron.windows.length, 0);
    } finally {
      e.cleanup();
    }
  }
});

test("a switch that only Chromium's command line knows is refused too", async () => {
  const e = makeEnv({ electron: { switches: ["remote-debugging-port"] } });
  try {
    assert.equal((await e.shell.start()).state, "aborted");
    assert.equal(e.rec.length, 0);
  } finally {
    e.cleanup();
  }
});

test("the inspector switches are also off by fuse (documented), and a normal start is not refused", async () => {
  const e = makeEnv({ argv: ["x.exe", "--hidden"] });
  try {
    assert.equal((await e.shell.start()).state, "running");
  } finally {
    e.cleanup();
  }
});
