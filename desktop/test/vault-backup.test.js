"use strict";
// T-D3 + L1-L4: vault.backupSealer and vault.openBackup (same install, fresh install adopt, other-install refusal, L1/L2/L3/L4, canary).
const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { createVault, VaultError } = require("../lib/vault");
const derive = require("../lib/derive");
const sealed = require("../lib/sealed");
const rc = require("../lib/recoverycode");

const RUN_ID = "0123456789abcdef0123456789abcdef";
const CANARY = "CANARY-BACKUP-SECRET-99887766";
const cleanup = [];
test.after(() => cleanup.forEach((d) => fs.rmSync(d, { recursive: true, force: true })));

function mkDir() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "no1d-vbackup-"));
  cleanup.push(d);
  return d;
}

function fakeKeyStore(available = true) {
  return {
    kind: "fake",
    available: () => available,
    seal: (b) => Buffer.concat([Buffer.from("SEAL:"), b]),
    open: (b) => {
      if (!b.subarray(0, 5).equals(Buffer.from("SEAL:"))) throw new Error("bad");
      return Buffer.from(b.subarray(5));
    },
  };
}

function makeUi(overrides = {}) {
  const calls = [];
  let shownGroups = null;
  const ui = {
    calls,
    shownGroups: () => shownGroups,
    async show(arg) {
      calls.push(["show", arg.kind]);
      if (arg.kind === "recovery-code") shownGroups = arg.groups.slice();
    },
    async askGroups({ positions }) {
      calls.push(["askGroups", positions]);
      return positions.map((p) => shownGroups[p - 1]);
    },
    async askText(arg) {
      calls.push(["askText", arg.kind, !!arg.again]);
      if (typeof overrides.askText === "function") return overrides.askText(arg);
      return null;
    },
    async askConfirm(arg) {
      calls.push(["askConfirm", arg.kind]);
      if (typeof overrides.askConfirm === "function") return overrides.askConfirm(arg);
      return true;
    },
    async say(arg) {
      calls.push(["say", arg.kind, arg.reason || null]);
    },
  };
  return ui;
}

test("same install opens backup with no prompt and sealed text never holds plain text", async () => {
  const dir = mkDir();
  const ui = makeUi();
  const vault = createVault({ dataDir: dir, keyStore: fakeKeyStore(), secretUi: ui });
  await vault.open();

  const sealer = vault.backupSealer(RUN_ID);
  const envText = sealer.seal(Buffer.from(CANARY, "utf8"));
  assert.ok(!envText.includes(CANARY));

  const callsBefore = ui.calls.length;
  const res = await vault.openBackup(envText, RUN_ID);
  assert.equal(res.adopted, false);
  assert.equal(res.plain.toString("utf8"), CANARY);
  assert.equal(ui.calls.length, callsBefore, "same install asks no code");
});

test("fresh install adopts backup secret via shared adoptSecret (L1): .old aside, key-check & recovery written, passphraseFor works, payout-history fails soft (L4)", async () => {
  // Install A creates the backup
  const dirA = mkDir();
  const uiA = makeUi();
  const vaultA = createVault({ dataDir: dirA, keyStore: fakeKeyStore(), secretUi: uiA });
  await vaultA.open();
  const codeA = uiA.shownGroups().join("-");
  const checkA = vaultA.keyCheck();
  const envText = vaultA.backupSealer(RUN_ID).seal(Buffer.from(CANARY, "utf8"));

  // Install B is fresh (has its own secret and a payout-history.sealed under B's secret)
  const dirB = mkDir();
  const uiB = makeUi({ askText: () => codeA, askConfirm: () => true });
  const vaultB = createVault({ dataDir: dirB, keyStore: fakeKeyStore(), secretUi: uiB });
  await vaultB.open();
  const checkB = vaultB.keyCheck();
  assert.notEqual(checkA, checkB);
  const histBlobB = vaultB.historySealer().seal(Buffer.from('{"v":1}'), "payout-history.sealed");

  // Open backup on Install B -> prompts backup-code + backup-adopt, adopts A's secret
  const res = await vaultB.openBackup(envText, RUN_ID);
  assert.equal(res.adopted, true);
  assert.equal(res.plain.toString("utf8"), CANARY);
  assert.equal(vaultB.keyCheck(), checkA);
  assert.equal(vaultB.state().state, "ready");
  assert.equal(vaultB.recoveryConfirmed(), true);

  // L1 checks: old secret moved aside, key-check.json updated, passphraseFor works on A's run folder, next startup succeeds
  const vaultFiles = fs.readdirSync(path.join(dirB, "vault"));
  assert.ok(vaultFiles.some((f) => f.startsWith("install-secret.v1.") && f.endsWith(".old")), "old secret renamed aside");
  const runDir = path.join(dirB, "runs", RUN_ID);
  fs.mkdirSync(runDir, { recursive: true });
  fs.writeFileSync(path.join(runDir, "vault-check.json"), JSON.stringify({ v: 1, check: checkA }) + "\n");
  assert.equal(vaultB.passphraseFor(runDir, RUN_ID), vaultA.passphraseFor((() => {
    const rdA = path.join(dirA, "runs", RUN_ID);
    fs.mkdirSync(rdA, { recursive: true });
    fs.writeFileSync(path.join(rdA, "vault-check.json"), JSON.stringify({ v: 1, check: checkA }) + "\n");
    return rdA;
  })(), RUN_ID));

  // Reopening Install B on next start succeeds cleanly (L1)
  const vaultB2 = createVault({ dataDir: dirB, keyStore: fakeKeyStore(), secretUi: makeUi() });
  assert.equal((await vaultB2.open()).state, "ready");
  assert.equal(vaultB2.keyCheck(), checkA);

  // L4: old install's payout-history.sealed no longer opens (throws SealedError so program.js moves it aside)
  assert.throws(() => vaultB.historySealer().open(histBlobB, "payout-history.sealed"), sealed.SealedError);
});

test("install with its own run folders (live or .ended) refuses adoption and changes nothing on disk", async () => {
  const dirA = mkDir();
  const uiA = makeUi();
  const vaultA = createVault({ dataDir: dirA, keyStore: fakeKeyStore(), secretUi: uiA });
  await vaultA.open();
  const codeA = uiA.shownGroups().join("-");
  const envText = vaultA.backupSealer(RUN_ID).seal(Buffer.from(CANARY, "utf8"));

  for (const sub of ["runs/aaaa1111bbbb2222cccc3333dddd4444", "runs/.ended/aaaa1111bbbb2222cccc3333dddd4444"]) {
    const dirB = mkDir();
    const uiB = makeUi({ askText: () => codeA, askConfirm: () => true });
    const vaultB = createVault({ dataDir: dirB, keyStore: fakeKeyStore(), secretUi: uiB });
    await vaultB.open();
    const checkB = vaultB.keyCheck();
    const ownRun = path.join(dirB, sub);
    fs.mkdirSync(ownRun, { recursive: true });
    fs.writeFileSync(path.join(ownRun, "vault-check.json"), JSON.stringify({ v: 1, check: checkB }) + "\n");

    const secretBefore = fs.readFileSync(path.join(dirB, "vault", "install-secret.v1"));
    await assert.rejects(() => vaultB.openBackup(envText, RUN_ID), (e) => e instanceof VaultError && e.code === "other-install");
    assert.equal(vaultB.keyCheck(), checkB);
    assert.ok(fs.readFileSync(path.join(dirB, "vault", "install-secret.v1")).equals(secretBefore));
  }
});

test("other-install refusal names no impossible step", async () => {
  const dirA = mkDir();
  const uiA = makeUi();
  const vaultA = createVault({ dataDir: dirA, keyStore: fakeKeyStore(), secretUi: uiA });
  await vaultA.open();
  const codeA = uiA.shownGroups().join("-");
  const envText = vaultA.backupSealer(RUN_ID).seal(Buffer.from(CANARY, "utf8"));
  const dirB = mkDir();
  const uiB = makeUi({ askText: () => codeA, askConfirm: () => true });
  const vaultB = createVault({ dataDir: dirB, keyStore: fakeKeyStore(), secretUi: uiB });
  await vaultB.open();
  const ownRun = path.join(dirB, "runs/.ended/aaaa1111bbbb2222cccc3333dddd4444");
  fs.mkdirSync(ownRun, { recursive: true });
  fs.writeFileSync(path.join(ownRun, "vault-check.json"), JSON.stringify({ v: 1, check: vaultB.keyCheck() }) + "\n");
  await assert.rejects(
    () => vaultB.openBackup(envText, RUN_ID),
    (e) => e instanceof VaultError && e.code === "other-install" && !/Finish them first/i.test(e.message) && /finished ones count too/.test(e.message) && /fresh user account/.test(e.message) && /recovery tool/.test(e.message)
  );
  const text = require("../secret/secret").TEXTS.say["backup-other-install"];
  assert.ok(!/Finish them first/i.test(text) && /finished ones count too/.test(text));
});

test("L2: same computer whose vault folder was lost but whose run folders match typed code is allowed", async () => {
  const dirA = mkDir();
  const uiA = makeUi();
  const vaultA = createVault({ dataDir: dirA, keyStore: fakeKeyStore(), secretUi: uiA });
  await vaultA.open();
  const codeA = uiA.shownGroups().join("-");
  const checkA = vaultA.keyCheck();
  const envText = vaultA.backupSealer(RUN_ID).seal(Buffer.from(CANARY, "utf8"));

  // Simulate lost vault folder with existing run folder of checkA
  const dirLost = mkDir();
  const existingRun = path.join(dirLost, "runs", "11112222333344445555666677778888");
  fs.mkdirSync(existingRun, { recursive: true });
  fs.writeFileSync(path.join(existingRun, "vault-check.json"), JSON.stringify({ v: 1, check: checkA }) + "\n");

  const uiLost = makeUi({ askText: () => codeA, askConfirm: () => true });
  const vaultLost = createVault({ dataDir: dirLost, keyStore: fakeKeyStore(), secretUi: uiLost });
  assert.equal((await vaultLost.open()).state, "locked");

  const res = await vaultLost.openBackup(envText, RUN_ID);
  assert.equal(res.adopted, true);
  assert.equal(res.plain.toString("utf8"), CANARY);
  assert.equal(vaultLost.keyCheck(), checkA);
  assert.equal(vaultLost.state().state, "ready");
});

test("L3: validatePlain failure leaves fresh install on its old secret (no switch)", async () => {
  const dirA = mkDir();
  const uiA = makeUi();
  const vaultA = createVault({ dataDir: dirA, keyStore: fakeKeyStore(), secretUi: uiA });
  await vaultA.open();
  const codeA = uiA.shownGroups().join("-");
  const envText = vaultA.backupSealer(RUN_ID).seal(Buffer.from(CANARY, "utf8"));

  const dirB = mkDir();
  const uiB = makeUi({ askText: () => codeA, askConfirm: () => true });
  const vaultB = createVault({ dataDir: dirB, keyStore: fakeKeyStore(), secretUi: uiB });
  await vaultB.open();
  const checkB = vaultB.keyCheck();

  await assert.rejects(
    () => vaultB.openBackup(envText, RUN_ID, { validatePlain: () => { throw new Error("offline check failed"); } }),
    /offline check failed/,
  );
  assert.equal(vaultB.keyCheck(), checkB, "vault did not switch before offline checks passed");
});

test("wrong code, damaged envelope, locked vault, and canary leak check", async () => {
  const dirA = mkDir();
  const uiA = makeUi();
  const vaultA = createVault({ dataDir: dirA, keyStore: fakeKeyStore(), secretUi: uiA });
  await vaultA.open();
  const codeA = uiA.shownGroups().join("-");
  const envText = vaultA.backupSealer(RUN_ID).seal(Buffer.from(CANARY, "utf8"));

  // Wrong code
  const dirB = mkDir();
  const wrongCode = rc.groupsOf(rc.encodeRaw(crypto.randomBytes(32))).join("-");
  const uiB = makeUi({ askText: () => wrongCode });
  const vaultB = createVault({ dataDir: dirB, keyStore: fakeKeyStore(), secretUi: uiB });
  await vaultB.open();
  await assert.rejects(
    () => vaultB.openBackup(envText, RUN_ID),
    (e) => e instanceof VaultError && e.code === "wrong-code" && !e.message.includes(wrongCode) && !e.message.includes(CANARY),
  );

  // Damaged envelope
  const damaged = JSON.parse(envText);
  damaged.tag = (damaged.tag[0] === "0" ? "1" : "0") + damaged.tag.slice(1);
  const uiB2 = makeUi({ askText: () => codeA });
  const vaultB2 = createVault({ dataDir: dirB, keyStore: fakeKeyStore(), secretUi: uiB2 });
  await vaultB2.open();
  await assert.rejects(() => vaultB2.openBackup(JSON.stringify(damaged), RUN_ID), (e) => e instanceof VaultError && e.code === "wrong-code");

  // Locked vault refuses backupSealer.seal and openBackup with requireOpen
  const dirL = mkDir();
  const vaultLocked = createVault({ dataDir: dirL, keyStore: fakeKeyStore(false), secretUi: makeUi() });
  assert.throws(() => vaultLocked.backupSealer(RUN_ID).seal(Buffer.from("x")), VaultError);
  await assert.rejects(() => vaultLocked.openBackup(envText, RUN_ID, { requireOpen: true }), (e) => e instanceof VaultError && e.code === "locked");
});

test("L4: fallback mode (no key store) asks for a new passphrase when adopting a backup secret", async () => {
  const dirA = mkDir();
  const uiA = makeUi();
  const vaultA = createVault({ dataDir: dirA, keyStore: fakeKeyStore(true), secretUi: uiA });
  await vaultA.open();
  const codeA = uiA.shownGroups().join("-");
  const envText = vaultA.backupSealer(RUN_ID).seal(Buffer.from(CANARY, "utf8"));

  const dirB = mkDir();
  const uiB = makeUi({
    askText: (arg) => {
      if (arg.kind === "fallback-new") return "long-fallback-passphrase";
      if (arg.kind === "backup-code") return codeA;
      return null;
    },
    askConfirm: () => true,
  });
  const vaultB = createVault({ dataDir: dirB, keyStore: fakeKeyStore(false), secretUi: uiB });
  await vaultB.open();
  assert.equal(vaultB.mode(), "fallback");

  const res = await vaultB.openBackup(envText, RUN_ID);
  assert.equal(res.adopted, true);
  assert.equal(res.plain.toString("utf8"), CANARY);
  assert.equal(vaultB.keyCheck(), vaultA.keyCheck());
  assert.equal(vaultB.mode(), "fallback");
  assert.ok(uiB.calls.filter((c) => c[0] === "askText" && c[1] === "fallback-new").length >= 4, "asked new passphrase on first start and again on adopt");
});

test("secret.js supports backup-code (text) and backup-adopt (confirm) models cleanly", () => {
  const secretPage = require("../secret/secret");
  const mCode = secretPage.buildModel({ type: "text", kind: "backup-code" });
  assert.equal(mCode.type, "text");
  assert.equal(mCode.kind, "backup-code");
  assert.equal(mCode.fields.length, 1);
  assert.deepEqual(secretPage.collect(mCode, { text: "ABCD-EFGH" }), { text: "ABCD-EFGH" });
  assert.equal(secretPage.collect(mCode, { text: "   " }), null);

  const mAdopt = secretPage.buildModel({ type: "confirm", kind: "backup-adopt" });
  assert.equal(mAdopt.type, "confirm");
  assert.equal(mAdopt.kind, "backup-adopt");
  assert.equal(mAdopt.fields.length, 0);
  assert.equal(mAdopt.submit, "Use this code");
  assert.equal(mAdopt.cancel, "Cancel");
  assert.deepEqual(secretPage.collect(mAdopt, {}), { ack: true });
});
