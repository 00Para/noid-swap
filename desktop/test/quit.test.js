"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { createFakeElectron } = require("./fake-electron");
const { createQuitGuard, quitText, formatNoid, formatEth } = require("../lib/quit");

const ID1 = "1".repeat(32);
const ID2 = "2".repeat(32);
const alice = { swap_id: ID1, role: "alice", phase: "funded", active: true, in_contract: true, coins: { noid_micronoid: "5000000", eth_wei: null }, until_unix: null, until_text: "about 14:20", needs_you: false };
const bob = { swap_id: ID2, role: "bob", phase: "locked", active: true, in_contract: true, coins: { noid_micronoid: null, eth_wei: "1000000000000000" }, until_unix: null, until_text: null, needs_you: false };

const tick = () => new Promise((r) => setImmediate(r));

test("amount formats", () => {
  assert.equal(formatNoid("5000000"), "5");
  assert.equal(formatNoid("1500000"), "1.5");
  assert.equal(formatNoid("1"), "0.000001");
  assert.equal(formatNoid(null), null);
  assert.equal(formatNoid("5.0"), null);
  assert.equal(formatEth("1000000000000000"), "0.001");
  assert.equal(formatEth("1000000000000000000"), "1");
  assert.equal(formatEth("x"), null);
});

test("the quit text names every swap at stake and until when", () => {
  const t = quitText([alice, bob, { ...alice, active: false }]);
  assert.match(t.message, /2 swaps/);
  assert.match(t.detail, /You sell NOID: 5 NOID in the contract until about 14:20/);
  assert.match(t.detail, /You sell ETH: 0\.001 ETH in the contract until a time the program cannot read now/);
  assert.equal(t.detail.split("\n").filter((l) => l.startsWith("You sell")).length, 2);
  const unix = quitText([{ ...alice, until_text: null, until_unix: Date.UTC(2026, 10, 18, 14, 20) / 1000 }]);
  assert.match(unix.detail, /until about \d\d:\d\d/);
  const nocoin = quitText([{ ...alice, coins: { noid_micronoid: null, eth_wei: null }, in_contract: false }]);
  assert.match(nocoin.detail, /coins committed to this swap/);
});

test("quit with an active swap asks first: Keep running keeps the program", async () => {
  const electron = createFakeElectron({ messageBoxAnswers: [0] });
  const g = createQuitGuard({ electron, getList: () => [alice, bob] });
  g.install();
  electron.app.quit();
  await tick();
  assert.equal(electron.dialog.boxes.length, 1);
  const box = electron.dialog.boxes[0];
  assert.deepEqual(box.buttons, ["Keep running", "Quit anyway"]);
  assert.equal(box.defaultId, 0);
  assert.equal(box.cancelId, 0);
  assert.match(box.detail, /You sell NOID/);
  assert.match(box.detail, /You sell ETH/);
  assert.equal(electron.app.exitCode, undefined);
  assert.equal(g.isConfirmed(), false);
  assert.equal(electron.calls.filter((c) => c.name === "quit").length, 1, "the app was not told to quit again");
});

test("Quit anyway lets the second quit through", async () => {
  const electron = createFakeElectron({ messageBoxAnswers: [1] });
  let accepted = 0;
  const g = createQuitGuard({ electron, getList: () => [alice], onAccepted: () => accepted++ });
  g.install();
  electron.app.quit();
  await tick();
  assert.equal(g.isConfirmed(), true);
  assert.equal(electron.calls.filter((c) => c.name === "quit").length, 2);
  assert.ok(accepted >= 1);
});

test("a second quit while the dialog is open does not open another", async () => {
  const electron = createFakeElectron({ messageBoxAnswers: [0] });
  const g = createQuitGuard({ electron, getList: () => [alice] });
  g.install();
  electron.app.quit();
  electron.app.quit();
  await tick();
  assert.equal(electron.dialog.boxes.length, 1);
});

test("with no active swap, quit is not asked", () => {
  const electron = createFakeElectron();
  let accepted = 0;
  const g = createQuitGuard({ electron, getList: () => [{ ...alice, active: false }], onAccepted: () => accepted++ });
  g.install();
  electron.app.quit();
  assert.equal(electron.dialog.boxes.length, 0);
  assert.equal(accepted, 1);
});

test("the system's own shutdown is not blocked", () => {
  const electron = createFakeElectron({ messageBoxAnswers: [0] });
  const g = createQuitGuard({ electron, getList: () => [alice] });
  g.install();
  g.markSystemShutdown();
  let prevented = false;
  g.beforeQuit({ preventDefault: () => (prevented = true) });
  assert.equal(prevented, false);
  assert.equal(electron.dialog.boxes.length, 0);
});

test("the dialog is a child of the window when one is shown", async () => {
  const electron = createFakeElectron({ messageBoxAnswers: [0] });
  const parent = { isVisible: () => true };
  const g = createQuitGuard({ electron, getList: () => [alice], getWindow: () => parent });
  g.install();
  electron.app.quit();
  await tick();
  assert.equal(electron.dialog.boxes.length, 1);
});
