"use strict";
/* The real vault driven through the real key store wrapper and the real secret window logic, over the fake electron. */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createFakeElectron } = require("./fake-electron");
const { createGuard } = require("../lib/hardening");
const { createSecretUi } = require("../lib/secretwin");
const { createElectronKeyStore } = require("../lib/keystore-electron");
const { createVault } = require("../lib/vault");

const PRELOAD = path.join(__dirname, "..", "preload-secret.js");
const HTML = path.join(__dirname, "..", "secret", "secret.html");
const tick = () => new Promise((r) => setImmediate(r));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function setup(opts = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "no1d-wiring-"));
  fs.mkdirSync(path.join(dataDir, "runs"));
  const electron = createFakeElectron(opts);
  const guard = createGuard(electron);
  guard.install();
  const secretUi = createSecretUi({ electron, guard, preloadPath: PRELOAD, htmlPath: HTML, getParent: () => null });
  const keyStore = createElectronKeyStore(electron.safeStorage, "win32");
  const reply = async (n, msg) => {
    for (let i = 0; i < 500 && !(electron.windows[n] && electron.windows[n].webContents.sent.length); i++) await sleep(10); // scrypt runs between two prompts
    const w = electron.windows[n];
    assert.ok(w, `window ${n} opened`);
    const payload = w.webContents.sent[0].payload;
    const result = await electron.ipcMain.invoke("no1d-secret", w.webContents, msg(payload));
    return { payload, result };
  };
  return { dataDir, electron, secretUi, keyStore, reply, cleanup: () => fs.rmSync(dataDir, { recursive: true, force: true }) };
}

test("first start with a key store: the code is shown, typed back, and the vault becomes ready", async () => {
  const s = setup();
  try {
    const vault = createVault({ dataDir: s.dataDir, keyStore: s.keyStore, secretUi: s.secretUi });
    const opening = vault.open();
    const shown = await s.reply(0, () => ({ type: "submit", values: { ack: true } }));
    assert.equal(shown.payload.type, "show");
    assert.equal(shown.payload.groups.length, 14);
    const groups = shown.payload.groups;
    const typed = await s.reply(1, (p) => {
      assert.equal(p.type, "groups");
      assert.equal(p.positions.length, 3);
      return { type: "submit", values: { groups: p.positions.map((n) => groups[n - 1].toLowerCase()) } };
    });
    assert.equal(typed.result.ok, true);
    assert.deepEqual(await opening, { state: "ready" });
    assert.equal(vault.ready().ok, true);
    assert.equal(vault.recoveryConfirmed(), true);
    assert.equal(vault.newSwapAllowed().ok, true);
    // the install secret file is the key store's output, not the secret
    const sealedFile = fs.readFileSync(path.join(s.dataDir, "vault", "install-secret.v1"));
    assert.match(sealedFile.toString("utf8"), /^enc:/);
    // a second start with the same key store opens without any window
    const windowsBefore = s.electron.windows.length;
    const again = createVault({ dataDir: s.dataDir, keyStore: s.keyStore, secretUi: s.secretUi });
    assert.deepEqual(await again.open(), { state: "ready" });
    assert.equal(s.electron.windows.length, windowsBefore);
    assert.equal(again.keyCheck(), vault.keyCheck());
  } finally {
    s.cleanup();
  }
});

test("a wrong group asks again, with the fixed wrong-code message", async () => {
  const s = setup();
  try {
    const vault = createVault({ dataDir: s.dataDir, keyStore: s.keyStore, secretUi: s.secretUi });
    const opening = vault.open();
    const shown = await s.reply(0, () => ({ type: "submit", values: { ack: true } }));
    await s.reply(1, (p) => ({ type: "submit", values: { groups: p.positions.map(() => "ZZZZ") } }));
    const say = await s.reply(2, () => ({ type: "submit", values: { ack: true } }));
    assert.deepEqual(say.payload, { type: "say", kind: "wrong-code" });
    const groups = shown.payload.groups;
    await s.reply(3, (p) => ({ type: "submit", values: { groups: p.positions.map((n) => groups[n - 1]) } }));
    assert.deepEqual(await opening, { state: "ready" });
  } finally {
    s.cleanup();
  }
});

test("closing the code window without confirming leaves the vault not confirmed", async () => {
  const s = setup();
  try {
    const vault = createVault({ dataDir: s.dataDir, keyStore: s.keyStore, secretUi: s.secretUi });
    const opening = vault.open();
    for (let i = 0; i < 50 && !s.electron.windows[0]; i++) await tick();
    await tick();
    s.electron.windows[0].destroy();
    const r = await opening;
    assert.notEqual(r.state, "ready");
    assert.equal(vault.recoveryConfirmed(), false);
    assert.equal(vault.newSwapAllowed().ok, false);
  } finally {
    s.cleanup();
  }
});

test("no usable key store: the fallback asks for the passphrase in two prompts of the secret window", async () => {
  const s = setup({ safeStorageAvailable: false });
  try {
    const vault = createVault({ dataDir: s.dataDir, keyStore: s.keyStore, secretUi: s.secretUi });
    const opening = vault.open();
    const first = await s.reply(0, () => ({ type: "submit", values: { text: "a long passphrase here" } }));
    assert.deepEqual(first.payload, { type: "text", kind: "fallback-new" });
    const second = await s.reply(1, () => ({ type: "submit", values: { text: "a long passphrase here" } }));
    assert.deepEqual(second.payload, { type: "text", kind: "fallback-new", again: true });
    const shown = await s.reply(2, () => ({ type: "submit", values: { ack: true } }));
    const groups = shown.payload.groups;
    await s.reply(3, (p) => ({ type: "submit", values: { groups: p.positions.map((n) => groups[n - 1]) } }));
    assert.deepEqual(await opening, { state: "ready" });
    const files = fs.readdirSync(path.join(s.dataDir, "vault"));
    assert.ok(files.includes("install-secret.pw.v1"));
    assert.ok(!files.includes("install-secret.v1"), "never the plain key-store file without a key store");
    // the passphrase is not on disk in any file
    for (const f of files) assert.ok(!fs.readFileSync(path.join(s.dataDir, "vault", f), "utf8").includes("a long passphrase here"), f);
  } finally {
    s.cleanup();
  }
});
