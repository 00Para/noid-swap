"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { createFakeElectron } = require("./fake-electron");
const { createElectronKeyStore } = require("../lib/keystore-electron");

test("kind follows the platform", () => {
  const e = createFakeElectron();
  assert.equal(createElectronKeyStore(e.safeStorage, "win32").kind, "dpapi");
  assert.equal(createElectronKeyStore(e.safeStorage, "darwin").kind, "keychain");
});

test("available: Windows and macOS follow isEncryptionAvailable", () => {
  for (const platform of ["win32", "darwin"]) {
    const e = createFakeElectron({ safeStorageAvailable: true });
    assert.equal(createElectronKeyStore(e.safeStorage, platform).available(), true, platform);
    const off = createFakeElectron({ safeStorageAvailable: false });
    assert.equal(createElectronKeyStore(off.safeStorage, platform).available(), false, platform);
  }
});

test("available on Linux: not basic_text, not unknown", () => {
  for (const [backend, want] of [["gnome_libsecret", true], ["kwallet5", true], ["kwallet6", true], ["basic_text", false], ["unknown", false]]) {
    const e = createFakeElectron({ backend });
    assert.equal(createElectronKeyStore(e.safeStorage, "linux").available(), want, backend);
  }
  const noBackendCall = { isEncryptionAvailable: () => true };
  assert.equal(createElectronKeyStore(noBackendCall, "linux").available(), false);
});

test("available is false when the system throws", () => {
  const ks = createElectronKeyStore({ isEncryptionAvailable() { throw new Error("x"); } }, "win32");
  assert.equal(ks.available(), false);
});

test("seal and open round trip through the hex text; the sealed bytes are not the secret", () => {
  const e = createFakeElectron();
  const ks = createElectronKeyStore(e.safeStorage, "win32");
  const secret = Buffer.from("00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff", "hex");
  const sealed = ks.seal(secret);
  assert.ok(Buffer.isBuffer(sealed));
  assert.ok(!sealed.includes(secret));
  assert.deepEqual(ks.open(sealed), secret);
  const { seal, open } = ks; // a vault may call them unbound
  assert.deepEqual(open(seal(secret)), secret);
});

test("seal and open refuse when the store is not available, and refuse wrong types", () => {
  const e = createFakeElectron({ safeStorageAvailable: false });
  const ks = createElectronKeyStore(e.safeStorage, "darwin");
  assert.throws(() => ks.seal(Buffer.alloc(32)), /not available/);
  assert.throws(() => ks.open(Buffer.alloc(32)), /not available/);
  const ok = createElectronKeyStore(createFakeElectron().safeStorage, "darwin");
  assert.throws(() => ok.seal("text"), /Buffer/);
  assert.throws(() => ok.open("text"), /Buffer/);
  assert.throws(() => ok.open(Buffer.from("garbage")), /not sealed/);
});
