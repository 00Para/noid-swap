"use strict";
/* The application menu's "Practice swap": the window comes forward and the page's practice swap opens, through its own fixed script. The practice itself uses nothing of the program (ui/app/lib/practice.js). */
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { createFakeElectron } = require("./fake-electron");
const { createGuard } = require("../lib/hardening");
const { createMainWindow, OPEN_PRACTICE_SCRIPT, OPEN_SETTINGS_SCRIPT, GONE_PAGE } = require("../lib/window");
const { buildApplicationMenu } = require("../lib/tray");
const { HELP_PARAGRAPHS } = require("../lib/helptext");
const { makeEnv, tick } = require("./shell-fixture");

function make(opts = {}) {
  const electron = createFakeElectron(opts);
  const guard = createGuard(electron);
  guard.install();
  const ctl = createMainWindow({ electron, guard, isPackaged: true, url: "no1d://app/#token=tok-abc", shouldHide: () => false });
  return { electron, ctl };
}
const asked = (electron) => electron.calls.filter((c) => c.who === "webContents" && c.name === "executeJavaScript").length;

test("openPractice shows the window and asks the page with its own fixed script; settings keeps its own", async () => {
  const codes = [];
  const { ctl } = make({ pageScript: async (code) => (codes.push(code), true) });
  assert.equal(await ctl.openPractice(), true);
  assert.equal(await ctl.openSettings(), true);
  assert.deepEqual(codes, [OPEN_PRACTICE_SCRIPT, OPEN_SETTINGS_SCRIPT]);
  assert.notEqual(OPEN_PRACTICE_SCRIPT, OPEN_SETTINGS_SCRIPT);
});

test("openPractice: false when the page has no such item or throws; nothing is asked of a page that is not the program's own or did not load", async () => {
  assert.equal(await make({ pageScript: async () => false }).ctl.openPractice(), false);
  assert.equal(await make({ pageScript: async () => { throw new Error("no page"); } }).ctl.openPractice(), false);
  const { electron, ctl } = make({ pageScript: async () => true });
  ctl.webContents.getURL = () => GONE_PAGE;
  assert.equal(await ctl.openPractice(), false);
  ctl.webContents.getURL = () => "https://example.com/";
  assert.equal(await ctl.openPractice(), false);
  assert.equal(asked(electron), 0);
  const bad = make({ loadFails: true, pageScript: async () => true });
  assert.equal(await bad.ctl.openPractice(), false);
  assert.equal(asked(bad.electron), 0);
});

test("the fixed script clicks only the page's menu item named Practice swap, and says whether it found it; no argument, nothing from outside", () => {
  const run = (labels) => {
    const clicked = [];
    const doc = { querySelectorAll: (sel) => (assert.equal(sel, ".pg-menu-list button"), labels.map((l) => ({ textContent: l, click: () => clicked.push(l) }))) };
    return { r: new Function("document", `return ${OPEN_PRACTICE_SCRIPT}`)(doc), clicked };
  };
  assert.deepEqual(run(["Settings", "Practice swap", "Help"]), { r: true, clicked: ["Practice swap"] });
  assert.deepEqual(run(["Practice swap now"]), { r: false, clicked: [] });
  assert.deepEqual(run([]), { r: false, clicked: [] });
  assert.ok(!/\$\{|location|hash|token|fetch|http/i.test(OPEN_PRACTICE_SCRIPT));
});

test("the application menu has Practice swap beside Help only when it is given a function, and calls it", () => {
  const electron = createFakeElectron();
  const hits = [];
  const labels = (m) => m.template[0].submenu.map((i) => i.label).filter(Boolean);
  const without = buildApplicationMenu({ electron, isPackaged: true, onSettings() {}, onRecoveryCode() {}, onHelp() {}, onQuit() {} });
  assert.ok(!labels(without).includes("Practice swap"));
  const menu = buildApplicationMenu({ electron, isPackaged: true, onSettings() {}, onRecoveryCode() {}, onHelp() {}, onPractice: () => hits.push("p"), onQuit() {} });
  const l = labels(menu);
  assert.equal(l.indexOf("Practice swap"), l.indexOf("Help") + 1);
  menu.template[0].submenu.find((i) => i.label === "Practice swap").click();
  assert.deepEqual(hits, ["p"]);
});

test("the shell wires the menu's Practice swap to the page: the window forward and the page asked", async () => {
  const codes = [];
  const e = makeEnv({ electron: { pageScript: async (code) => (codes.push(code), true) } });
  try {
    await e.shell.start();
    await tick();
    codes.length = 0;
    e.electron.Menu.applicationMenu.template[0].submenu.find((i) => i.label === "Practice swap").click();
    await tick();
    await tick();
    assert.deepEqual(codes, [OPEN_PRACTICE_SCRIPT]);
  } finally {
    e.cleanup();
  }
});

test("the help text names the practice and says it uses nothing real", () => {
  const t = HELP_PARAGRAPHS.join("\n");
  assert.match(t, /Practice swap/);
  assert.match(t, /no node, no coins, no network and no key store/);
  // the desktop shell has no code of its own for the practice beyond the menu item: it never requires the console's practice module
  for (const f of fs.readdirSync(path.join(__dirname, "..", "lib"))) assert.ok(!/require\(\s*["'][^"')]*practice/.test(fs.readFileSync(path.join(__dirname, "..", "lib", f), "utf8")), f);
});
