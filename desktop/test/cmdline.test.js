"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { parseCommandLine, REFUSED_PREFIXES, REFUSED_SWITCH_NAMES } = require("../lib/shell");
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
  assert.ok(REFUSED_PREFIXES.length >= 5 && REFUSED_SWITCH_NAMES.length === 5);
});

test("only --hidden and --self-test are read; other arguments are ignored", () => {
  assert.deepEqual(parseCommandLine(["x.exe", "--hidden"]), { refused: null, hidden: true, selfTest: false });
  assert.deepEqual(parseCommandLine(["x.exe", "--self-test"]), { refused: null, hidden: false, selfTest: true });
  assert.deepEqual(parseCommandLine(["x.exe", "--hidden", "--self-test", "--something-else", "C:\\folder\\file.json", "."]), { refused: null, hidden: true, selfTest: true });
  assert.deepEqual(parseCommandLine([]), { refused: null, hidden: false, selfTest: false });
  assert.deepEqual(parseCommandLine(undefined), { refused: null, hidden: false, selfTest: false });
});

test("a refused switch exits 1 before the data folder, the vault or the server is touched", async () => {
  for (const arg of ["--remote-debugging-port=9222", "--inspect", "--inspect-brk", "--js-flags=--x", "--remote-debugging-pipe"]) {
    const e = makeEnv({ argv: ["x.exe", arg] });
    try {
      const r = await e.shell.start();
      assert.equal(r.state, "aborted", arg);
      assert.equal(e.electron.app.exitCode, 1);
      assert.match(e.electron.dialog.errorBoxes[0].text, /does not start with a debugging or inspection switch/);
      assert.deepEqual(e.shell.trace, ["lock", "cmdline"]);
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
