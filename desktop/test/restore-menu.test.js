"use strict";
/* Application menu "Restore a swap…", fixed script OPEN_RESTORE_SCRIPT, shell wiring, and help text (P6). */

const test = require("node:test");
const assert = require("node:assert/strict");
const { createMainWindow, OPEN_RESTORE_SCRIPT, OPEN_PRACTICE_SCRIPT, OPEN_SETTINGS_SCRIPT } = require("../lib/window");
const { buildApplicationMenu } = require("../lib/tray");
const { HELP_PARAGRAPHS } = require("../lib/helptext");
const { createFakeElectron } = require("./fake-electron");
const { createGuard } = require("../lib/hardening");
const { makeEnv } = require("./shell-fixture");

test("OPEN_RESTORE_SCRIPT clicks only Restore a swap… and has no dynamic arguments or network words", () => {
  const run = (labels) => {
    const clicked = [];
    const doc = {
      querySelectorAll: (sel) => {
        assert.equal(sel, ".pg-menu-list button");
        return labels.map((t) => ({ textContent: t, click: () => clicked.push(t) }));
      },
    };
    return { r: new Function("document", `return ${OPEN_RESTORE_SCRIPT}`)(doc), clicked };
  };
  assert.deepEqual(run(["Settings", "Practice swap", "Restore a swap\u2026", "Help"]), { r: true, clicked: ["Restore a swap\u2026"] });
  assert.deepEqual(run(["Restore from a recovery code"]), { r: false, clicked: [] });
  assert.ok(!/\$\{|location|hash|token|fetch|http/i.test(OPEN_RESTORE_SCRIPT));
  assert.notEqual(OPEN_RESTORE_SCRIPT, OPEN_PRACTICE_SCRIPT);
  assert.notEqual(OPEN_RESTORE_SCRIPT, OPEN_SETTINGS_SCRIPT);
});

test("createMainWindow.openRestore asks the page with OPEN_RESTORE_SCRIPT", async () => {
  const codes = [];
  const electron = createFakeElectron({ pageScript: async (code) => (codes.push(code), true) });
  const guard = createGuard(electron);
  guard.install();
  const w = createMainWindow({ electron, guard, isPackaged: true, url: "no1d://app/#token=abc" });
  assert.equal(await w.openRestore(), true);
  assert.deepEqual(codes, [OPEN_RESTORE_SCRIPT]);
});

test("buildApplicationMenu places Restore a swap… after Practice swap only when onRestore is given", () => {
  const electron = createFakeElectron();
  const labels = (m) => m.template[0].submenu.map((i) => i.label).filter(Boolean);
  const without = buildApplicationMenu({ electron, isPackaged: true, onSettings() {}, onRecoveryCode() {}, onHelp() {}, onPractice() {}, onQuit() {} });
  assert.ok(!labels(without).includes("Restore a swap\u2026"));

  const hits = [];
  const withR = buildApplicationMenu({
    electron,
    isPackaged: true,
    onSettings() {},
    onRecoveryCode() {},
    onHelp() {},
    onPractice() {},
    onRestore: () => hits.push("r"),
    onQuit() {},
  });
  const l = labels(withR);
  assert.equal(l.indexOf("Practice swap"), l.indexOf("Help") + 1);
  assert.equal(l.indexOf("Restore a swap\u2026"), l.indexOf("Practice swap") + 1);
  withR.template[0].submenu.find((i) => i.label === "Restore a swap\u2026").click();
  assert.deepEqual(hits, ["r"]);
});

test("shell wires Restore a swap… menu item to openRestore and help text covers swap backups", async () => {
  const e = makeEnv();
  try {
    const r = await e.shell.start();
    assert.equal(r.state, "running");
    const codes = [];
    e.shell.window.webContents.executeJavaScript = async (code) => {
      codes.push(code);
      return true;
    };
    e.shell.window.webContents.emit("did-finish-load");
    const item = e.electron.Menu.applicationMenu.template[0].submenu.find((i) => i.label === "Restore a swap\u2026");
    assert.ok(item, "Restore a swap… in application menu");
    item.click();
    await new Promise((res) => setImmediate(res));
    assert.deepEqual(codes, [OPEN_RESTORE_SCRIPT]);
  } finally {
    e.cleanup();
  }
  const help = HELP_PARAGRAPHS.join("\n");
  assert.match(help, /\.no1dbackup/);
  assert.match(help, /Restore a swap/);
  assert.match(help, /backup-open/);
});
