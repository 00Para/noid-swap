"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { EventEmitter } = require("node:events");
const { createFakeElectron } = require("./fake-electron");
const { createCrashHandler, readState } = require("../lib/crash");

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "no1d-crash-"));
  const stateFile = path.join(dir, "state.json");
  const electron = createFakeElectron();
  const proc = new EventEmitter();
  let t = 1_000_000;
  const notices = [];
  const h = createCrashHandler({ app: electron.app, fs, stateFile, now: () => t, notifier: { crashNotice: () => notices.push(t) }, proc });
  return { dir, stateFile, electron, proc, notices, h, at: (v) => (t = v), cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}
const names = (e) => e.calls.map((c) => c.name);

test("the first crash relaunches once and exits 1", () => {
  const s = setup();
  try {
    s.h.handle();
    assert.deepEqual(names(s.electron), ["relaunch", "exit"]);
    assert.equal(s.electron.app.exitCode, 1);
    assert.deepEqual(readState(fs, s.stateFile).crashes, [1_000_000]);
    assert.equal(s.notices.length, 0);
  } finally {
    s.cleanup();
  }
});

test("a second crash within ten minutes does not relaunch and says so", () => {
  const s = setup();
  try {
    s.h.handle();
    const h2 = createCrashHandler({ app: s.electron.app, fs, stateFile: s.stateFile, now: () => 1_000_000 + 9 * 60 * 1000, notifier: { crashNotice: () => s.notices.push("n") }, proc: new EventEmitter() });
    s.electron.calls.length = 0;
    h2.handle();
    assert.deepEqual(names(s.electron), ["exit"]);
    assert.equal(s.notices.length, 1);
  } finally {
    s.cleanup();
  }
});

test("a crash more than ten minutes after the last relaunches again", () => {
  const s = setup();
  try {
    s.h.handle();
    const h2 = createCrashHandler({ app: s.electron.app, fs, stateFile: s.stateFile, now: () => 1_000_000 + 11 * 60 * 1000, notifier: { crashNotice() { throw new Error("no"); } }, proc: new EventEmitter() });
    s.electron.calls.length = 0;
    h2.handle();
    assert.deepEqual(names(s.electron), ["relaunch", "exit"]);
  } finally {
    s.cleanup();
  }
});

test("state.json keeps the last five times and leaves other keys alone", () => {
  const s = setup();
  try {
    fs.writeFileSync(s.stateFile, JSON.stringify({ v: 1, update_check: { last: "x" }, crashes: [1, 2, 3, 4, 5] }));
    s.h.handle();
    const st = readState(fs, s.stateFile);
    assert.deepEqual(st.crashes, [2, 3, 4, 5, 1_000_000]);
    assert.deepEqual(st.update_check, { last: "x" });
  } finally {
    s.cleanup();
  }
});

test("a damaged state.json is treated as no history", () => {
  const s = setup();
  try {
    fs.writeFileSync(s.stateFile, "{not json");
    s.h.handle();
    assert.deepEqual(readState(fs, s.stateFile).crashes, [1_000_000]);
    assert.deepEqual(names(s.electron), ["relaunch", "exit"]);
  } finally {
    s.cleanup();
  }
});

test("install hooks both process events; a crash writes no error text anywhere", () => {
  const s = setup();
  try {
    s.h.install();
    assert.equal(s.proc.listenerCount("uncaughtException"), 1);
    assert.equal(s.proc.listenerCount("unhandledRejection"), 1);
    s.proc.emit("uncaughtException", new Error("secret-canary-text"));
    assert.ok(!fs.readFileSync(s.stateFile, "utf8").includes("secret-canary-text"));
    assert.ok(!JSON.stringify(s.electron.calls).includes("secret-canary-text"));
  } finally {
    s.cleanup();
  }
});

test("a state file that cannot be written still relaunches", () => {
  const s = setup();
  try {
    const bad = createCrashHandler({ app: s.electron.app, fs, stateFile: path.join(s.dir, "nope", "x", "state.json").replace(/nope/, "a\0b"), now: () => 1, notifier: {}, proc: new EventEmitter() });
    bad.handle();
    assert.deepEqual(names(s.electron), ["relaunch", "exit"]);
  } finally {
    s.cleanup();
  }
});
