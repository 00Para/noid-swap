"use strict";
/* The application menu's "Settings": the window comes forward and the page's settings screen opens. */
const test = require("node:test");
const assert = require("node:assert/strict");
const { createFakeElectron } = require("./fake-electron");
const { createGuard } = require("../lib/hardening");
const { createMainWindow, OPEN_SETTINGS_SCRIPT, GONE_PAGE } = require("../lib/window");
const { buildApplicationMenu } = require("../lib/tray");
const { makeEnv, tick } = require("./shell-fixture");

function make(opts = {}) {
  const electron = createFakeElectron(opts);
  const guard = createGuard(electron);
  guard.install();
  const ctl = createMainWindow({ electron, guard, isPackaged: true, url: "no1d://app/#token=tok-abc", shouldHide: () => false });
  return { electron, ctl };
}

const shown = (electron) => electron.calls.filter((c) => c.who === "window" && c.name === "show").length;
const asked = (electron) => electron.calls.filter((c) => c.who === "webContents" && c.name === "executeJavaScript").length;

test("openSettings shows the window and asks the page with the fixed script, once", async () => {
  const codes = [];
  const { electron, ctl } = make({ pageScript: async (code) => (codes.push(code), true) });
  const before = shown(electron);
  assert.equal(await ctl.openSettings(), true);
  assert.equal(shown(electron), before + 1);
  assert.deepEqual(codes, [OPEN_SETTINGS_SCRIPT]);
});

test("openSettings: false when the page has no such menu item, and the window is shown anyway", async () => {
  const { electron, ctl } = make({ pageScript: async () => false });
  const before = shown(electron);
  assert.equal(await ctl.openSettings(), false);
  assert.equal(shown(electron), before + 1);
});

test("openSettings: a page that throws gives false, never an error", async () => {
  const { ctl } = make({
    pageScript: async () => {
      throw new Error("no page");
    },
  });
  assert.equal(await ctl.openSettings(), false);
});

test("openSettings: nothing is asked of a page that is not the program's own page", async () => {
  const { electron, ctl } = make({ pageScript: async () => true });
  ctl.webContents.getURL = () => GONE_PAGE;
  assert.equal(await ctl.openSettings(), false);
  ctl.webContents.getURL = () => "https://example.com/";
  assert.equal(await ctl.openSettings(), false);
  assert.equal(asked(electron), 0);
  ctl.webContents.getURL = () => "no1d://app/";
  assert.equal(await ctl.openSettings(), true);
  assert.equal(asked(electron), 1);
});

test("openSettings: a window whose page did not load is not asked", async () => {
  const { electron, ctl } = make({ loadFails: true, pageScript: async () => true });
  assert.equal(await ctl.openSettings(), false);
  assert.equal(asked(electron), 0);
});

test("the fixed script clicks only the menu item named Settings, and says whether it found it", () => {
  const run = (labels) => {
    const clicked = [];
    const doc = {
      querySelectorAll: (sel) => {
        assert.equal(sel, ".pg-menu-list button");
        return labels.map((l) => ({ textContent: l, click: () => clicked.push(l) }));
      },
    };
    const r = new Function("document", `return ${OPEN_SETTINGS_SCRIPT}`)(doc);
    return { r, clicked };
  };
  assert.deepEqual(run(["Settings", "Help", "Recovery code"]), { r: true, clicked: ["Settings"] });
  assert.deepEqual(run(["Help", "Settings"]), { r: true, clicked: ["Settings"] });
  assert.deepEqual(run(["Help", "Settings and more"]), { r: false, clicked: [] });
  assert.deepEqual(run([]), { r: false, clicked: [] });
  // no argument, nothing from outside the program in it
  assert.ok(!/\$\{|location|hash|token|fetch|http/i.test(OPEN_SETTINGS_SCRIPT));
});

test("the application menu's Settings calls the open-settings function it is given", () => {
  const electron = createFakeElectron();
  const hits = [];
  const menu = buildApplicationMenu({ electron, isPackaged: true, onSettings: () => hits.push("s"), onRecoveryCode() {}, onHelp() {}, onQuit() {} });
  menu.template[0].submenu.find((i) => i.label === "Settings").click();
  assert.deepEqual(hits, ["s"]);
});

test("the shell wires the menu's Settings to the page: the window forward and the page asked", async () => {
  const codes = [];
  const e = makeEnv({ electron: { pageScript: async (code) => (codes.push(code), true) } });
  try {
    await e.shell.start();
    await tick();
    const win = e.electron.windows[e.electron.windows.length - 1];
    const before = shown(e.electron);
    codes.length = 0;
    e.electron.Menu.applicationMenu.template[0].submenu.find((i) => i.label === "Settings").click();
    await tick();
    await tick();
    assert.ok(win);
    assert.ok(shown(e.electron) > before, "the window was shown");
    assert.deepEqual(codes, [OPEN_SETTINGS_SCRIPT]);
  } finally {
    e.cleanup();
  }
});
