"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { createFakeElectron } = require("./fake-electron");
const { createGuard } = require("../lib/hardening");
const { createMainWindow, baseWebPreferences, isReloadKey, GONE_PAGE } = require("../lib/window");

const URL_WITH_TOKEN = "no1d://app/#token=tok-abc";

function make(opts = {}) {
  const electron = createFakeElectron(opts);
  const guard = createGuard(electron);
  guard.install();
  let active = false;
  const ctl = createMainWindow({ electron, guard, isPackaged: !!opts.isPackaged, url: URL_WITH_TOKEN, hidden: !!opts.hidden, shouldHide: () => active });
  return { electron, guard, ctl, setActive: (v) => (active = v) };
}

test("every webPreferences value of build spec 7.3", () => {
  const { ctl } = make({ isPackaged: true });
  const p = ctl.window.options.webPreferences;
  assert.deepEqual(p, {
    contextIsolation: true,
    sandbox: true,
    nodeIntegration: false,
    nodeIntegrationInWorker: false,
    nodeIntegrationInSubFrames: false,
    webSecurity: true,
    allowRunningInsecureContent: false,
    experimentalFeatures: false,
    webviewTag: false,
    navigateOnDragDrop: false,
    spellcheck: false,
    devTools: false,
    safeDialogs: true,
    partition: "no1d-main",
    preload: undefined,
  });
});

test("devTools is on only when not packaged", () => {
  assert.equal(make({ isPackaged: false }).ctl.window.options.webPreferences.devTools, true);
  assert.equal(make({ isPackaged: true }).ctl.window.options.webPreferences.devTools, false);
});

test("the partition is a named in-memory one: persist: is refused", () => {
  assert.throws(() => baseWebPreferences({ isPackaged: true, partition: "persist:x" }), /persist/);
  assert.throws(() => baseWebPreferences({ isPackaged: true, partition: "" }), /partition/);
  const { ctl } = make();
  assert.ok(!ctl.window.options.webPreferences.partition.startsWith("persist:"));
});

test("the window loads only the page URL, and the token sits only in loadURL", () => {
  const { electron, ctl } = make();
  assert.equal(ctl.window.loadedUrl, URL_WITH_TOKEN);
  for (const c of electron.calls) {
    if (c.name === "loadURL") continue;
    assert.ok(!JSON.stringify(c.args).includes("tok-abc"), `${c.who}.${c.name} carries the token`);
  }
});

test("navigation to another origin, a new window, a webview and a redirect are refused", () => {
  const { ctl } = make();
  const wc = ctl.webContents;
  assert.deepEqual(wc.openHandler(), { action: "deny" });
  for (const ev of ["will-navigate", "will-redirect", "will-frame-navigate"]) {
    let prevented = false;
    wc.emit(ev, { preventDefault: () => (prevented = true) }, "https://example.com/");
    assert.equal(prevented, true, `${ev} to another origin`);
    prevented = false;
    wc.emit(ev, { preventDefault: () => (prevented = true) }, "no1d://app/other");
    assert.equal(prevented, true, `${ev} to another path of the same origin`);
    prevented = false;
    wc.emit(ev, { preventDefault: () => (prevented = true) }, "no1d://app/#token=tok-abc");
    assert.equal(prevented, false, `${ev} to the page itself is allowed`);
    prevented = false;
    wc.emit(ev, { preventDefault: () => (prevented = true) }, "no1d://other/");
    assert.equal(prevented, true, `${ev} to another host of the scheme`);
    prevented = false;
    wc.emit(ev, { preventDefault: () => (prevented = true) }, "http://127.0.0.1:43210/");
    assert.equal(prevented, true, `${ev} to a local port`);
    prevented = false;
    wc.emit(ev, { preventDefault: () => (prevented = true), url: "http://127.0.0.1:99/" });
    assert.equal(prevented, true, `${ev} with the URL on the event`);
  }
  let prevented = false;
  wc.emit("will-attach-webview", { preventDefault: () => (prevented = true) });
  assert.equal(prevented, true);
});

test("every permission, device selection and download is refused; a foreign request is cancelled", () => {
  const { ctl } = make();
  const s = ctl.webContents.session;
  let answer = null;
  s.handlers.permissionRequest({}, "notifications", (v) => (answer = v));
  assert.equal(answer, false);
  for (const perm of ["media", "geolocation", "clipboard-read", "midi", "openExternal"]) {
    answer = null;
    s.handlers.permissionRequest({}, perm, (v) => (answer = v));
    assert.equal(answer, false, perm);
  }
  assert.equal(s.handlers.permissionCheck({}, "media"), false);
  assert.equal(s.handlers.devicePermission({}), false);
  let prevented = false;
  s.emit("will-download", { preventDefault: () => (prevented = true) });
  assert.equal(prevented, true);
  for (const name of ["select-hid-device", "select-usb-device", "select-serial-port"]) {
    prevented = false;
    let chose = "untouched";
    s.emit(name, { preventDefault: () => (prevented = true) }, {}, {}, (v) => (chose = v));
    s.emit(name, { preventDefault: () => (prevented = true) }, {}, (v) => (chose = v));
    assert.equal(prevented, true, name);
    assert.notEqual(chose, "untouched", `${name} was answered with a cancel`);
  }
  prevented = false;
  ctl.webContents.emit("select-bluetooth-device", { preventDefault: () => (prevented = true) }, [], () => {});
  assert.equal(prevented, true);

  const decide = (url) => {
    let r = null;
    s.handlers.beforeRequest({ url }, (v) => (r = v));
    return r.cancel;
  };
  assert.equal(decide("no1d://app/operator.js"), false);
  assert.equal(decide("no1d://app/api/program?x=1"), false);
  assert.equal(decide("data:image/png;base64,AAAA"), false);
  assert.equal(decide("https://example.com/x.js"), true);
  assert.equal(decide("no1d://other/operator.js"), true, "another host of the scheme is another origin");
  assert.equal(decide("no1d://app:80/operator.js"), true, "a port is another origin");
  assert.equal(decide("no1d://user@app/operator.js"), true, "a user name is another origin");
  assert.equal(decide("http://app/operator.js"), true, "another scheme with the same host");
  assert.equal(decide("http://127.0.0.1:43210/operator.js"), true, "no local port is allowed any more");
  assert.equal(decide("http://localhost:43210/"), true);
  assert.equal(decide("file:///C:/secret.txt"), true);
  assert.equal(decide("not a url"), true);
  assert.equal(decide("devtools://devtools/bundled/x.js"), false, "unpackaged: devtools may load its own pages");
});

test("packaged: even devtools pages are refused", () => {
  const { ctl } = make({ isPackaged: true });
  let r = null;
  ctl.webContents.session.handlers.beforeRequest({ url: "devtools://devtools/x" }, (v) => (r = v));
  assert.equal(r.cancel, true);
});

test("a stray webContents (not a window of the program) starts denied", () => {
  const electron = createFakeElectron();
  const guard = createGuard(electron);
  guard.install();
  const stray = electron.strayWebContents();
  assert.deepEqual(stray.openHandler(), { action: "deny" });
  let prevented = false;
  stray.emit("will-navigate", { preventDefault: () => (prevented = true) }, "no1d://app/");
  assert.equal(prevented, true);
  let r = null;
  stray.session.handlers.beforeRequest({ url: "no1d://app/" }, (v) => (r = v));
  assert.equal(r.cancel, true);
});

test("hardening is installed once per webContents and per session (idempotent)", () => {
  const { electron, guard, ctl } = make();
  const before = ctl.webContents.listenerCount("will-navigate");
  guard.apply(ctl.webContents, { allowedOrigin: "no1d://app", pageUrl: URL_WITH_TOKEN });
  guard.apply(ctl.webContents, { allowedOrigin: "no1d://app", pageUrl: URL_WITH_TOKEN });
  assert.equal(ctl.webContents.listenerCount("will-navigate"), before);
  assert.ok(electron.windows.length === 1);
});

test("closing hides the window while a swap is active; with none active it closes", () => {
  const { ctl, setActive } = make();
  setActive(true);
  assert.equal(ctl.window.close(), false);
  assert.equal(ctl.window.isDestroyed(), false);
  setActive(false);
  assert.equal(ctl.window.close(), true);
  assert.equal(ctl.window.isDestroyed(), true);
});

test("once quitting, the window closes even while a swap is active", () => {
  const { ctl, setActive } = make();
  setActive(true);
  ctl.setQuitting();
  assert.equal(ctl.window.close(), true);
});

test("hidden start does not show the window; a normal start shows it when ready", () => {
  const a = make({ hidden: true });
  a.ctl.window.emit("ready-to-show");
  assert.equal(a.ctl.window.visible, false);
  const b = make({ hidden: false });
  b.ctl.window.emit("ready-to-show");
  assert.equal(b.ctl.window.visible, true);
});

test("showAndFocus brings a hidden window back", () => {
  const { ctl } = make();
  ctl.hide();
  ctl.showAndFocus();
  assert.equal(ctl.window.visible, true);
  assert.equal(ctl.window.focused, true);
});

test("whenLoaded resolves on did-finish-load and rejects on did-fail-load", async () => {
  await make().ctl.whenLoaded();
  await assert.rejects(make({ loadFails: true }).ctl.whenLoaded(), /did not load/);
});

test("the window refuses a page URL that is not on the private scheme", () => {
  const electron = createFakeElectron();
  const guard = createGuard(electron);
  guard.install();
  for (const url of ["http://127.0.0.1:43210/#token=t", "https://example.com/", "no1d://other/#token=t", "no1d://app:80/#token=t", "no1d://u:p@app/#token=t", "file:///x", "not a url", ""]) {
    assert.throws(() => createMainWindow({ electron, guard, isPackaged: true, url, shouldHide: () => false }), /private scheme/, url);
  }
  assert.equal(electron.windows.length, 0, "no window was made for a refused URL");
});

test("the guard's allowed origin is the scheme's, compared by hand (the URL's own .origin of this scheme is the string null)", () => {
  assert.equal(new URL("no1d://app/").origin, "null");
  const { ctl } = make();
  const decide = (url) => {
    let r = null;
    ctl.webContents.session.handlers.beforeRequest({ url }, (v) => (r = v));
    return r.cancel;
  };
  assert.equal(decide("no1d://app/"), false);
  assert.equal(decide("null"), true);
  assert.equal(decide("no1d:///operator.js"), true, "no host");
});

test("reload keys are prevented: Ctrl+R, Ctrl+Shift+R, F5, Cmd+R, the browser's refresh key; other keys are not", () => {
  const { ctl } = make();
  const wc = ctl.webContents;
  assert.equal(wc.pressKey({ key: "r", control: true }), true);
  assert.equal(wc.pressKey({ key: "R", control: true, shift: true }), true);
  assert.equal(wc.pressKey({ key: "r", meta: true }), true);
  assert.equal(wc.pressKey({ key: "F5" }), true);
  assert.equal(wc.pressKey({ key: "F5", control: true }), true);
  assert.equal(wc.pressKey({ key: "F5", shift: true }), true);
  assert.equal(wc.pressKey({ key: "BrowserRefresh" }), true);
  assert.equal(wc.pressKey({ key: "r" }), false, "a plain r is typed text");
  assert.equal(wc.pressKey({ key: "r", alt: true }), false);
  assert.equal(wc.pressKey({ key: "c", control: true }), false, "copy still works");
  assert.equal(wc.pressKey({ key: "v", control: true }), false);
  assert.equal(wc.pressKey({ key: "F4" }), false);
  assert.equal(isReloadKey(null), false);
  assert.equal(isReloadKey({}), false);
});

test("a lost page process: the page is loaded again once with the same URL; the second loss shows a fixed message and loads nothing else", () => {
  const { electron, ctl } = make();
  const wc = ctl.webContents;
  const loads = () => electron.calls.filter((c) => c.name === "loadURL").map((c) => c.args[0]);
  assert.deepEqual(loads(), [URL_WITH_TOKEN]);
  wc.emit("render-process-gone", {}, { reason: "crashed", exitCode: 1 });
  assert.deepEqual(loads(), [URL_WITH_TOKEN, URL_WITH_TOKEN], "the first loss: the same URL, fragment included");
  wc.emit("render-process-gone", {}, { reason: "oom", exitCode: 1 });
  const all = loads();
  assert.equal(all.length, 3);
  assert.equal(all[2], GONE_PAGE);
  assert.ok(!all[2].includes("tok-abc"), "the message page carries no token");
  assert.match(decodeURIComponent(all[2]), /This window stopped working/);
  assert.ok(!/<script/i.test(decodeURIComponent(all[2])), "no script in the message");
  wc.emit("render-process-gone", {}, { reason: "killed", exitCode: 9 });
  wc.emit("render-process-gone", {}, { reason: "crashed", exitCode: 1 });
  assert.equal(loads().length, 5, "every later loss shows the message again; there is no loop of reloads");
  assert.ok(loads().slice(2).every((u) => u === GONE_PAGE));
});

test("a clean exit of the page process, or a lost process of a destroyed window, loads nothing", () => {
  const a = make();
  a.ctl.webContents.emit("render-process-gone", {}, { reason: "clean-exit", exitCode: 0 });
  assert.equal(a.electron.calls.filter((c) => c.name === "loadURL").length, 1);
  const b = make();
  b.ctl.destroy();
  b.ctl.webContents.emit("render-process-gone", {}, { reason: "crashed", exitCode: 1 });
  assert.equal(b.electron.calls.filter((c) => c.name === "loadURL").length, 1);
});

test("the token still appears only in loadURL arguments after a reload", () => {
  const { electron, ctl } = make();
  ctl.webContents.emit("render-process-gone", {}, { reason: "crashed", exitCode: 1 });
  for (const c of electron.calls) {
    if (c.name === "loadURL") continue;
    assert.ok(!JSON.stringify(c.args).includes("tok-abc"), `${c.who}.${c.name} carries the token`);
  }
});
