"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { createFakeElectron } = require("./fake-electron");
const { createGuard } = require("../lib/hardening");
const { createSecretUi } = require("../lib/secretwin");
const page = require("../secret/secret.js");

const PRELOAD = path.join(__dirname, "..", "preload-secret.js");
const HTML = path.join(__dirname, "..", "secret", "secret.html");
const tick = () => new Promise((r) => setImmediate(r));

function make(opts = {}) {
  const electron = createFakeElectron(opts);
  const guard = createGuard(electron);
  guard.install();
  let parent = null;
  const ui = createSecretUi({ electron, guard, preloadPath: PRELOAD, htmlPath: HTML, getParent: () => parent });
  return { electron, ui, setParent: (p) => (parent = p) };
}

/** Wait until the window of the open request exists and has been sent its payload. */
async function openWindow(electron, n = 0) {
  for (let i = 0; i < 20; i++) {
    const w = electron.windows[n];
    if (w && w.webContents.sent.length) return w;
    await tick();
  }
  throw new Error("no window opened");
}

test("the window is hardened: own partition, preload, content protection, no devtools, file-only policy", async () => {
  const { electron, ui } = make();
  const p = ui.askText({ kind: "restore" });
  const w = await openWindow(electron);
  const wp = w.options.webPreferences;
  assert.equal(wp.partition, "no1d-secret");
  assert.equal(wp.preload, PRELOAD);
  assert.equal(wp.contextIsolation, true);
  assert.equal(wp.sandbox, true);
  assert.equal(wp.nodeIntegration, false);
  assert.equal(wp.devTools, false);
  assert.ok(!wp.partition.startsWith("persist:"));
  assert.equal(w.contentProtection, true);
  assert.equal(w.loadedFile, HTML);
  assert.equal(w.loadedUrl, null, "no server, no URL");
  // it may load only its own folder
  const decide = (url) => {
    let r;
    w.webContents.session.handlers.beforeRequest({ url }, (v) => (r = v));
    return r.cancel;
  };
  assert.equal(decide(require("node:url").pathToFileURL(path.join(__dirname, "..", "secret", "secret.css")).href), false);
  assert.equal(decide("http://127.0.0.1:5000/api/program"), true);
  assert.equal(decide("https://example.com/"), true);
  assert.equal(decide(require("node:url").pathToFileURL(path.join(__dirname, "..", "main.js")).href), true);
  let prevented = false;
  w.webContents.emit("will-navigate", { preventDefault: () => (prevented = true) }, "https://example.com/");
  assert.equal(prevented, true);
  await electron.ipcMain.invoke("no1d-secret", w.webContents, { type: "cancel" });
  assert.equal(await p, null);
});

test("it is modal to the main window when there is one", async () => {
  const { electron, ui, setParent } = make();
  const parent = { isDestroyed: () => false };
  setParent(parent);
  const p = ui.askText({ kind: "invite" });
  const w = await openWindow(electron);
  assert.equal(w.options.modal, true);
  assert.equal(w.options.parent, parent);
  await electron.ipcMain.invoke("no1d-secret", w.webContents, { type: "cancel" });
  await p;
});

test("show resolves only when the user acknowledges; the code goes to the window and nowhere else", async () => {
  const { electron, ui } = make();
  const groups = ["0400", "20G3", "0G2G"];
  let done = false;
  const p = ui.show({ kind: "recovery-code", groups }).then(() => (done = true));
  const w = await openWindow(electron);
  assert.deepEqual(w.webContents.sent[0], { channel: "no1d-secret:show", payload: { type: "show", groups } });
  await tick();
  assert.equal(done, false);
  assert.deepEqual(await electron.ipcMain.invoke("no1d-secret", w.webContents, { type: "submit", values: { ack: false } }), { ok: false, error: "That was not accepted." });
  assert.equal(done, false);
  assert.deepEqual(await electron.ipcMain.invoke("no1d-secret", w.webContents, { type: "submit", values: { ack: true } }), { ok: true });
  await p;
  assert.equal(done, true);
  assert.equal(w.isDestroyed(), true, "destroyed after each request");
  const logged = JSON.stringify(electron.calls.filter((c) => c.who !== "webContents"));
  assert.ok(!logged.includes("20G3"), "the code is in no recorded call but the send to the window");
});

test("show rejects with CLOSED when the window is closed without an answer", async () => {
  const { electron, ui } = make();
  const p = ui.show({ kind: "recovery-code", groups: ["AAAA"] });
  const w = await openWindow(electron);
  w.destroy();
  await assert.rejects(p, (e) => e.code === "CLOSED");
});

test("askGroups returns the typed groups in order; wrong shapes are refused; cancel gives null", async () => {
  const { electron, ui } = make();
  const p = ui.askGroups({ positions: [2, 5, 9] });
  const w = await openWindow(electron);
  assert.deepEqual(w.webContents.sent[0].payload, { type: "groups", positions: [2, 5, 9] });
  const send = (values) => electron.ipcMain.invoke("no1d-secret", w.webContents, { type: "submit", values });
  assert.equal((await send({ groups: ["a", "b"] })).ok, false);
  assert.equal((await send({ groups: ["a", "", "c"] })).ok, false);
  assert.equal((await send({ groups: ["a", "b", "x".repeat(40)] })).ok, false);
  assert.equal((await send({ groups: "abc" })).ok, false);
  assert.equal((await send(null)).ok, false);
  assert.deepEqual(await send({ groups: ["1A2B", "C3D4", "E5F6"] }), { ok: true });
  assert.deepEqual(await p, ["1A2B", "C3D4", "E5F6"]);

  const q = ui.askGroups({ positions: [1, 2, 3] });
  const w2 = await openWindow(electron, 1);
  await electron.ipcMain.invoke("no1d-secret", w2.webContents, { type: "cancel" });
  assert.equal(await q, null);
});

test("askText: kinds, limits; fallback-new is two separate prompts the vault compares", async () => {
  const { electron, ui } = make();
  await assert.rejects(ui.askText({ kind: "bogus" }), /unknown text kind/);

  const p = ui.askText({ kind: "fallback-new" });
  const w = await openWindow(electron);
  assert.deepEqual(w.webContents.sent[0].payload, { type: "text", kind: "fallback-new" });
  const send = (values) => electron.ipcMain.invoke("no1d-secret", w.webContents, { type: "submit", values });
  assert.equal((await send({ text: "   " })).ok, false);
  assert.equal((await send({ text: "x".repeat(3000) })).ok, false);
  assert.equal((await send({ text: 42 })).ok, false);
  assert.equal((await send({ text: "long enough pass" })).ok, true);
  assert.equal(await p, "long enough pass");

  const again = ui.askText({ kind: "fallback-new", again: true });
  const w1 = await openWindow(electron, 1);
  assert.deepEqual(w1.webContents.sent[0].payload, { type: "text", kind: "fallback-new", again: true });
  await electron.ipcMain.invoke("no1d-secret", w1.webContents, { type: "submit", values: { text: "long enough pass" } });
  assert.equal(await again, "long enough pass");

  const q = ui.askText({ kind: "restore" });
  const w2 = await openWindow(electron, 2);
  assert.deepEqual(w2.webContents.sent[0].payload, { type: "text", kind: "restore" });
  await electron.ipcMain.invoke("no1d-secret", w2.webContents, { type: "submit", values: { text: "0400-20G3" } });
  assert.equal(await q, "0400-20G3");
});

test("a message from any other sender, or with no open prompt, is refused", async () => {
  const { electron, ui } = make();
  // no open request
  await assert.rejects(electron.ipcMain.invoke("no1d-secret", { id: 1 }, { type: "submit", values: { text: "x" } }), /refused/);
  const p = ui.askText({ kind: "fallback" });
  const w = await openWindow(electron);
  const stranger = new electron.FakeWebContents({ options: { webPreferences: {} } }, "main");
  await assert.rejects(electron.ipcMain.invoke("no1d-secret", stranger, { type: "submit", values: { text: "stolen" } }), /refused/);
  await assert.rejects(electron.ipcMain.invoke("no1d-secret", null, { type: "cancel" }), /refused/);
  await assert.rejects(electron.ipcMain.invoke("no1d-secret", w.webContents, "not an object"), /refused/);
  await assert.rejects(electron.ipcMain.invoke("no1d-secret", w.webContents, { type: "other" }), /refused/);
  // the real window still works
  await electron.ipcMain.invoke("no1d-secret", w.webContents, { type: "submit", values: { text: "my passphrase" } });
  assert.equal(await p, "my passphrase");
  // and once answered, the same sender is refused
  await assert.rejects(electron.ipcMain.invoke("no1d-secret", w.webContents, { type: "submit", values: { text: "again" } }), /refused/);
});

test("requests are served one at a time", async () => {
  const { electron, ui } = make();
  const a = ui.askText({ kind: "restore" });
  const b = ui.askText({ kind: "invite" });
  const w1 = await openWindow(electron);
  await tick();
  await tick();
  assert.equal(electron.windows.length, 1, "the second waits for the first");
  await electron.ipcMain.invoke("no1d-secret", w1.webContents, { type: "submit", values: { text: "one" } });
  assert.equal(await a, "one");
  const w2 = await openWindow(electron, 1);
  await electron.ipcMain.invoke("no1d-secret", w2.webContents, { type: "submit", values: { text: "two" } });
  assert.equal(await b, "two");
});

test("say shows a fixed kind and the count; unknown kinds are refused", async () => {
  const { electron, ui } = make();
  await assert.rejects(ui.say({ kind: "free text" }), /unknown say kind/);
  const p = ui.say({ kind: "imported", count: 3 });
  const w = await openWindow(electron);
  assert.deepEqual(w.webContents.sent[0].payload, { type: "say", kind: "imported", count: 3 });
  await electron.ipcMain.invoke("no1d-secret", w.webContents, { type: "submit", values: { ack: true } });
  await p;
  const q = ui.say({ kind: "wrong-passphrase", reason: "short" });
  const w2 = await openWindow(electron, 1);
  assert.deepEqual(w2.webContents.sent[0].payload, { type: "say", kind: "wrong-passphrase", reason: "short" });
  await electron.ipcMain.invoke("no1d-secret", w2.webContents, { type: "submit", values: { ack: true } });
  await q;
});

test("askFolder opens a native folder dialog, never the window", async () => {
  const { electron, ui } = make({ openAnswer: { canceled: false, filePaths: ["C:\\old\\run"] } });
  assert.equal(await ui.askFolder({ kind: "import-run" }), "C:\\old\\run");
  assert.equal(electron.windows.length, 0);
  const opts = electron.calls.find((c) => c.name === "showOpenDialog").args[0];
  assert.deepEqual(opts.properties, ["openDirectory"]);
  electron.dialog.openAnswer = { canceled: true, filePaths: [] };
  assert.equal(await ui.askFolder({ kind: "import-home" }), null);
  await assert.rejects(ui.askFolder({ kind: "anything" }), /unknown folder kind/);
});

test("a spy on console sees no typed or shown value", async () => {
  const seen = [];
  const orig = {};
  for (const m of ["log", "info", "warn", "error", "debug"]) {
    orig[m] = console[m];
    console[m] = (...a) => seen.push(a.join(" "));
  }
  try {
    const { electron, ui } = make();
    const p = ui.askText({ kind: "fallback" });
    const w = await openWindow(electron);
    await electron.ipcMain.invoke("no1d-secret", w.webContents, { type: "submit", values: { text: "canary-passphrase-123" } });
    await p;
    const q = ui.show({ kind: "recovery-code", groups: ["CANARY-GROUP"] });
    const w2 = await openWindow(electron, 1);
    await electron.ipcMain.invoke("no1d-secret", w2.webContents, { type: "submit", values: { ack: true } });
    await q;
  } finally {
    for (const m of Object.keys(orig)) console[m] = orig[m];
  }
  assert.deepEqual(seen, []);
});

// ---- the page's own logic (no DOM) ----

test("page model: the recovery code is drawn as groups, with no copy button", () => {
  const m = page.buildModel({ type: "show", groups: ["AAAA", "BBBB"] });
  assert.deepEqual(m.code, ["AAAA", "BBBB"]);
  assert.equal(m.submit, "I have written it down");
  assert.equal(m.cancel, null);
  assert.deepEqual(m.fields, []);
  assert.ok(!/copy/i.test(JSON.stringify({ submit: m.submit, cancel: m.cancel, fields: m.fields })), "no copy control");
});

test("page model: groups ask for the positions", () => {
  const m = page.buildModel({ type: "groups", positions: [3, 8, 11] });
  assert.deepEqual(m.fields.map((f) => f.label), ["Group 3", "Group 8", "Group 11"]);
  assert.deepEqual(page.collect(m, { g0: " a ", g1: "b", g2: "c" }), { groups: ["a", "b", "c"] });
  assert.equal(page.collect(m, { g0: "a", g1: "", g2: "c" }), null);
});

test("page model: text kinds, field types, fallback-new checks", () => {
  for (const kind of ["restore", "fallback-new", "fallback", "invite"]) {
    const m = page.buildModel({ type: "text", kind });
    assert.equal(m.type, "text");
    assert.ok(m.fields.length >= 1);
  }
  assert.equal(page.buildModel({ type: "text", kind: "fallback" }).fields[0].type, "password");
  assert.equal(page.buildModel({ type: "text", kind: "invite" }).fields[0].type, "password");
  const m = page.buildModel({ type: "text", kind: "fallback-new" });
  assert.equal(m.fields.length, 1);
  assert.equal(m.fields[0].type, "password");
  const again = page.buildModel({ type: "text", kind: "fallback-new", again: true });
  assert.match(again.fields[0].label, /again/);
  assert.deepEqual(page.collect(m, { text: "long enough pass" }), { text: "long enough pass" });
  assert.equal(page.collect(m, { text: "" }), null);
  assert.equal(page.collect(page.buildModel({ type: "text", kind: "restore" }), { text: "  " }), null);
});

test("page model: say uses fixed text, with a plural count", () => {
  assert.deepEqual(page.buildModel({ type: "say", kind: "imported", count: 0 }).lines, ["The run folder was imported."]);
  assert.deepEqual(page.buildModel({ type: "say", kind: "imported", count: 1 }).lines, ["The run folder was imported. 1 old lock record was added."]);
  assert.deepEqual(page.buildModel({ type: "say", kind: "imported", count: 2 }).lines, ["The run folder was imported. 2 old lock records were added."]);
  assert.match(page.buildModel({ type: "say", kind: "wrong-code" }).lines[0], /does not match/);
  assert.match(page.buildModel({ type: "say", kind: "wrong-passphrase", reason: "short" }).lines[0], /at least 12/);
  assert.match(page.buildModel({ type: "say", kind: "wrong-passphrase", reason: "mismatch" }).lines[0], /differ/);
  assert.match(page.buildModel({ type: "say", kind: "wrong-passphrase", reason: "<b>" }).lines[0], /not right/);
  assert.equal(page.buildModel({ type: "say", kind: "<script>" }).lines[0], "Done.");
  assert.equal(page.buildModel(null).type, "none");
  assert.equal(page.buildModel({ type: "text", kind: "say" }).type, "none", "a text request cannot name another kind's page");
});

test("the page is CSP-clean: no inline script, no inline style, no innerHTML, no network", () => {
  const html = fs.readFileSync(HTML, "utf8");
  assert.match(html, /default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; form-action 'none'; base-uri 'none'/);
  assert.ok(!/<script(?![^>]*\ssrc=)/i.test(html), "every script has a src");
  assert.ok(!/\sstyle=/i.test(html));
  assert.ok(!/\son\w+=/i.test(html));
  assert.ok(!/https?:\/\//i.test(html.replace(/<meta[^>]+>/g, "")), "no external URL");
  const js = fs.readFileSync(path.join(__dirname, "..", "secret", "secret.js"), "utf8");
  const code = js.replace(/\/\*[\s\S]*?\*\//g, "");
  assert.ok(!/innerHTML|outerHTML|insertAdjacentHTML|document\.write|eval\(|new Function|fetch\(|XMLHttpRequest|WebSocket|localStorage|sessionStorage|clipboard/i.test(code));
  const css = fs.readFileSync(path.join(__dirname, "..", "secret", "secret.css"), "utf8");
  assert.ok(!/@import|url\(/i.test(css), "the stylesheet loads nothing");
});

test("the preload exposes onShow, submit and cancel and nothing else", () => {
  const src = fs.readFileSync(PRELOAD, "utf8");
  const code = src.replace(/\/\*[\s\S]*?\*\//g, "");
  const exposed = [...code.matchAll(/exposeInMainWorld\("(\w+)"/g)].map((m) => m[1]);
  assert.deepEqual(exposed, ["no1dSecret"]);
  const body = code.slice(code.indexOf("exposeInMainWorld"));
  const members = [...body.matchAll(/^\s{2}(\w+)\(/gm)].map((m) => m[1]);
  assert.deepEqual(members, ["onShow", "submit", "cancel"]);
  assert.equal((code.match(/ipcRenderer\.invoke\(/g) || []).length, 2);
  assert.ok(code.includes('"no1d-secret"'));
  assert.ok(!/ipcRenderer\.send|webFrame|shell|remote|process\./.test(code));
});
