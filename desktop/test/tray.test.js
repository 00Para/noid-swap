"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { createFakeElectron } = require("./fake-electron");
const { createTray, buildApplicationMenu, tooltipFor } = require("../lib/tray");

const A = (active) => ({ swap_id: "a".repeat(32), role: "alice", phase: "x", active, in_contract: false, coins: { noid_micronoid: null, eth_wei: null }, until_unix: null, until_text: null, needs_you: false });

test("tooltip counts active swaps", () => {
  assert.equal(tooltipFor([]), "No1d Swap: 0 active swaps");
  assert.equal(tooltipFor([A(true)]), "No1d Swap: 1 active swap");
  assert.equal(tooltipFor([A(true), A(true), A(false)]), "No1d Swap: 2 active swaps");
});

test("tray: Windows icon, tooltip follows the list, menu is Open and Quit", () => {
  const electron = createFakeElectron();
  let opened = 0;
  let quit = 0;
  const tray = createTray({ electron, platform: "win32", assetsDir: path.join("x", "assets"), onOpen: () => opened++, onQuit: () => quit++ });
  const t = electron.trays[0];
  assert.ok(t.image.path.endsWith("tray.png"));
  assert.equal(t.tooltip, "No1d Swap: 0 active swaps");
  tray.update([A(true)]);
  assert.equal(t.tooltip, "No1d Swap: 1 active swap");
  const labels = t.menu.template.filter((i) => i.label).map((i) => i.label);
  assert.deepEqual(labels, ["Open", "Quit"]);
  t.menu.template[0].click();
  t.emit("click");
  t.menu.template[2].click();
  assert.equal(opened, 2);
  assert.equal(quit, 1);
  tray.destroy();
  assert.equal(t.destroyed, true);
});

test("tray on macOS uses the template image", () => {
  const electron = createFakeElectron();
  createTray({ electron, platform: "darwin", assetsDir: "a", onOpen() {}, onQuit() {} });
  const t = electron.trays[0];
  assert.ok(t.image.path.endsWith("trayTemplate.png"));
  assert.equal(t.image.template, true);
});

test("application menu: About, Settings, Recovery code, Help, Quit, Edit roles; no developer tools when packaged", () => {
  const electron = createFakeElectron();
  const hits = [];
  const menu = buildApplicationMenu({ electron, isPackaged: true, onSettings: () => hits.push("s"), onRecoveryCode: () => hits.push("r"), onHelp: () => hits.push("h"), onQuit: () => hits.push("q") });
  assert.equal(electron.Menu.applicationMenu, menu);
  const main = menu.template[0].submenu.filter((i) => i.label);
  assert.deepEqual(main.map((i) => i.label), ["About No1d Swap", "Settings", "Recovery code", "Help", "Quit"]);
  for (const i of main.slice(1)) i.click();
  assert.deepEqual(hits, ["s", "r", "h", "q"]);
  main[0].click();
  assert.ok(electron.calls.some((c) => c.name === "showAboutPanel"));
  const roles = menu.template[1].submenu.map((i) => i.role).filter(Boolean);
  assert.ok(roles.includes("copy") && roles.includes("paste"));
  const all = JSON.stringify(menu.template);
  assert.ok(!/toggleDevTools|reload|forceReload/.test(all));
});

test("application menu: with a check handler it offers Check for a new version, after Help", () => {
  const electron = createFakeElectron();
  const hits = [];
  const menu = buildApplicationMenu({ electron, isPackaged: true, onSettings() {}, onRecoveryCode() {}, onHelp() {}, onCheckUpdate: () => hits.push("u"), onQuit() {} });
  const main = menu.template[0].submenu.filter((i) => i.label);
  assert.deepEqual(main.map((i) => i.label), ["About No1d Swap", "Settings", "Recovery code", "Help", "Check for a new version", "Quit"]);
  main[4].click();
  assert.deepEqual(hits, ["u"]);
});

test("application menu: a development run has a Develop menu", () => {
  const electron = createFakeElectron();
  const menu = buildApplicationMenu({ electron, isPackaged: false, onSettings() {}, onRecoveryCode() {}, onHelp() {}, onQuit() {} });
  assert.ok(/toggleDevTools/.test(JSON.stringify(menu.template)));
});

test("the tray icons exist as PNG files", () => {
  const fs = require("node:fs");
  for (const n of ["tray.png", "trayTemplate.png", "trayTemplate@2x.png"]) {
    const b = fs.readFileSync(path.join(__dirname, "..", "assets", n));
    assert.equal(b.subarray(0, 8).toString("hex"), "89504e470d0a1a0a", n);
  }
});
