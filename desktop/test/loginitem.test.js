"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { createFakeElectron } = require("./fake-electron");
const { createLoginItem } = require("../lib/loginitem");

const S = (active) => ({ swap_id: "c".repeat(32), role: "alice", phase: "p", active, in_contract: false, coins: { noid_micronoid: null, eth_wei: null }, until_unix: null, until_text: null, needs_you: false });
const sets = (electron) => electron.calls.filter((c) => c.name === "setLoginItemSettings").map((c) => c.args[0]);

test("login item: on with --hidden while any swap is active, off when none; only on a change", () => {
  const electron = createFakeElectron({ isPackaged: true });
  const l = createLoginItem({ app: electron.app, platform: "darwin", execPath: "/x/No1d Swap", isPackaged: true });
  l.update([]);
  assert.deepEqual(sets(electron), [{ openAtLogin: false }], "the first answer is set once");
  l.update([]);
  assert.equal(sets(electron).length, 1);
  l.update([S(true)]);
  l.update([S(true), S(false)]);
  assert.deepEqual(sets(electron)[1], { openAtLogin: true, openAsHidden: true, args: ["--hidden"] }, "a Mac login item cannot pass an argument, so it asks to open hidden");
  assert.equal(sets(electron).length, 2);
  l.update([S(false)]);
  assert.deepEqual(sets(electron)[2], { openAtLogin: false });
  assert.equal(l.current(), false);
});

test("login item on Windows names the executable", () => {
  const electron = createFakeElectron({ isPackaged: true });
  const l = createLoginItem({ app: electron.app, platform: "win32", execPath: "C:\\P\\No1d Swap.exe", isPackaged: true });
  l.update([S(true)]);
  l.update([]);
  assert.deepEqual(sets(electron), [
    { openAtLogin: true, args: ["--hidden"], path: "C:\\P\\No1d Swap.exe" },
    { openAtLogin: false, path: "C:\\P\\No1d Swap.exe" },
  ]);
});

test("startedAtLogin reads the system's answer: opened at login or opened hidden; anything else or an error is no", () => {
  const { startedAtLogin } = require("../lib/loginitem");
  const app = (v) => ({ getLoginItemSettings: () => v });
  assert.equal(startedAtLogin(app({ wasOpenedAtLogin: true })), true);
  assert.equal(startedAtLogin(app({ wasOpenedAsHidden: true })), true);
  assert.equal(startedAtLogin(app({ wasOpenedAtLogin: false, wasOpenedAsHidden: false })), false);
  assert.equal(startedAtLogin(app({})), false);
  assert.equal(startedAtLogin(app(undefined)), false);
  assert.equal(startedAtLogin({ getLoginItemSettings() { throw new Error("no"); } }), false);
  assert.equal(startedAtLogin({}), false);
});

test("an unpackaged run never touches the login items", () => {
  const electron = createFakeElectron();
  const l = createLoginItem({ app: electron.app, platform: "win32", execPath: "C:\\electron.exe", isPackaged: false });
  l.update([S(true)]);
  l.update([]);
  assert.equal(sets(electron).length, 0);
});
