"use strict";
// The vault (spec 6.1 to 6.6, 6.10): first start, the key store port, the recovery code and its type-back, the fallback, restore, derived passphrases,
// sealed board keys and the invite secret, and the 12.2 rule that nothing hands the secret or the code to a caller.
const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { createVault, VaultError } = require("../lib/vault");
const derive = require("../lib/derive");
const rc = require("../lib/recoverycode");
const sealed = require("../lib/sealed");
const { createFakeKeyStore } = require("./fake-keystore");
const { createFakeSecretUi } = require("./fake-secretui");
const { makeVault, makeRun, secretFromShown, codeFromShown, filesUnder, snapshot, tmpDir, cleanupAll, hex32 } = require("./vault-helpers");

test.after(cleanupAll);
const R = "0123456789abcdef0123456789abcdef";
const vdir = (dataDir) => path.join(dataDir, "vault");

test("first start with a key store: the secret is sealed by it, the check and the recovery record are written, the code is shown, the type-back confirms", async () => {
  const { vault, dataDir, ui } = makeVault();
  assert.deepEqual(vault.ready(), { ok: false, why: "the vault is not open yet" });
  assert.deepEqual(await vault.open(), { state: "ready" });
  assert.deepEqual(vault.ready(), { ok: true, why: null });
  assert.equal(vault.recoveryConfirmed(), true);
  assert.deepEqual(vault.newSwapAllowed(), { ok: true, why: null });
  assert.equal(vault.mode(), "keystore");
  assert.deepEqual(fs.readdirSync(vdir(dataDir)).sort(), ["install-secret.v1", "key-check.json", "recovery.json"]);
  const S = secretFromShown(ui);
  assert.equal(S.length, 32);
  assert.equal(vault.keyCheck(), derive.keyCheck(S));
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(vdir(dataDir), "key-check.json"), "utf8")), { v: 1, check: derive.keyCheck(S) });
  const rec = JSON.parse(fs.readFileSync(path.join(vdir(dataDir), "recovery.json"), "utf8"));
  assert.equal(rec.v, 1);
  assert.match(rec.confirmed_at, /^\d{4}-\d\d-\d\dT/);
  // the sealed file does not hold S in any form
  const blob = fs.readFileSync(path.join(vdir(dataDir), "install-secret.v1"));
  assert.ok(!blob.includes(S));
  // the shown code has 14 groups and is the code of that secret
  const shown = ui.of("show");
  assert.equal(shown.length, 1);
  assert.equal(shown[0].arg.groups.length, 14);
  assert.equal(codeFromShown(ui), rc.encode(S));
  // a passphrase from the vault is the derived one
  const run = makeRun(dataDir, vault, R);
  assert.equal(vault.passphraseFor(run.dir, R), derive.passphrase(S, R));
  if (process.platform !== "win32") for (const f of fs.readdirSync(vdir(dataDir))) assert.equal(fs.statSync(path.join(vdir(dataDir), f)).mode & 0o077, 0, f);
});

test("a later start reads the secret and shows nothing; the same passphrase comes out; another vault on another key store cannot open it", async () => {
  const a = makeVault();
  await a.vault.open();
  const run = makeRun(a.dataDir, a.vault, R);
  const p = a.vault.passphraseFor(run.dir, R);
  const ui2 = createFakeSecretUi({});
  const v2 = createVault({ dataDir: a.dataDir, keyStore: a.keyStore, secretUi: ui2 });
  assert.deepEqual(await v2.open(), { state: "ready" });
  assert.equal(v2.passphraseFor(run.dir, R), p);
  assert.equal(ui2.calls.length, 0, "no window");
  assert.equal(v2.keyCheck(), a.vault.keyCheck());
  // the same data folder on a key store that is not the one that sealed the secret (another machine or account)
  const ui3 = createFakeSecretUi({});
  const v3 = createVault({ dataDir: a.dataDir, keyStore: createFakeKeyStore(), secretUi: ui3 });
  const r3 = await v3.open();
  assert.equal(r3.state, "locked");
  assert.match(v3.ready().why, /restore it with the recovery code/);
  assert.deepEqual(v3.newSwapAllowed().ok, false);
  assert.throws(() => v3.passphraseFor(run.dir, R), VaultError);
});

test("the secret is opened from its file for every use: the key store is asked each time (nothing long-lived holds S)", async () => {
  const ks = createFakeKeyStore();
  let opens = 0;
  const counting = { ...ks, open: (b) => (opens++, ks.open(b)) };
  const { vault, dataDir } = makeVault({ keyStore: counting });
  await vault.open();
  const run = makeRun(dataDir, vault, R);
  const before = opens;
  vault.passphraseFor(run.dir, R);
  vault.passphraseFor(run.dir, R);
  vault.boardSealer(R).seal(Buffer.from("x"), "board-keys.json");
  assert.equal(opens - before, 3);
});

test("first start, the person cancels the type-back: the vault is ready but not confirmed; no new swap; the menu shows the code again and confirms", async () => {
  const ui = createFakeSecretUi({ askGroups: [null] });
  const { vault, dataDir } = makeVault({ ui });
  assert.deepEqual(await vault.open(), { state: "needs_confirm" });
  assert.equal(vault.ready().ok, true);
  assert.equal(vault.recoveryConfirmed(), false);
  const na = vault.newSwapAllowed();
  assert.equal(na.ok, false);
  assert.match(na.why, /recovery code/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(vdir(dataDir), "recovery.json"), "utf8")).confirmed_at, null);
  // existing swaps keep working
  const run = makeRun(dataDir, vault, R);
  assert.match(vault.passphraseFor(run.dir, R), /^[0-9a-f]{64}$/);
});

test("an unconfirmed vault is confirmed through showRecoveryCode (code shown again, three groups typed back); a confirmed one only shows the code", async () => {
  const ks = createFakeKeyStore();
  const dataDir = tmpDir();
  fs.mkdirSync(path.join(dataDir, "runs"));
  const ui1 = createFakeSecretUi({ askGroups: [null] });
  const v1 = createVault({ dataDir, keyStore: ks, secretUi: ui1 });
  assert.equal((await v1.open()).state, "needs_confirm");
  // a later start: still unconfirmed, no window at start
  const ui2 = createFakeSecretUi({ autoTypeBack: true });
  const v2 = createVault({ dataDir, keyStore: ks, secretUi: ui2 });
  assert.equal((await v2.open()).state, "needs_confirm");
  assert.equal(ui2.calls.length, 0);
  await v2.showRecoveryCode();
  assert.equal(v2.recoveryConfirmed(), true);
  assert.equal(ui2.of("show").length, 1);
  assert.equal(ui2.of("askGroups").length, 1);
  assert.equal(JSON.parse(fs.readFileSync(path.join(vdir(dataDir), "recovery.json"), "utf8")).confirmed_at.length > 10, true);
  // already confirmed: the code is shown and nothing is asked
  await v2.showRecoveryCode();
  assert.equal(ui2.of("show").length, 2);
  assert.equal(ui2.of("askGroups").length, 1);
  assert.equal(codeFromShown(ui2), rc.encode(secretFromShown(ui1)), "the same code every time");
});

test("type-back: three different groups not in a row, compared by the reading rules; a wrong group asks again; recovery.json is written only on a full match", async () => {
  let n = 0;
  const log = [];
  let shownGroups = null;
  const ui = createFakeSecretUi({
    askGroups: (arg) => {
      n++;
      log.push(arg.positions);
      if (n === 1) return ["0000", "0000", "0000"]; // wrong
      if (n === 2) return arg.positions.map((p, i) => (i === 2 ? "ZZZZ" : shownGroups[p - 1])); // one wrong of three
      return arg.positions.map((p) => shownGroups[p - 1].toLowerCase().replace(/0/g, "o").replace(/1/g, "l")); // the reading rules apply
    },
  });
  const origShow = ui.show.bind(ui);
  ui.show = async (arg) => {
    shownGroups = arg.groups;
    return origShow(arg);
  };
  const { vault, dataDir } = makeVault({ ui });
  const open = vault.open();
  // while the type-back is going on, nothing is confirmed
  const state = await open;
  assert.equal(state.state, "ready");
  assert.equal(n, 3);
  for (const p of log) {
    assert.equal(p.length, 3);
    assert.equal(new Set(p).size, 3);
    assert.ok(!(p[1] === p[0] + 1 && p[2] === p[1] + 1));
  }
  assert.deepEqual(log[0], log[1], "the same groups are asked again after a wrong try");
  assert.equal(ui.of("say").filter((c) => c.arg.kind === "wrong-code").length, 2);
  assert.equal(ui.of("show").length, 1);
  assert.ok(JSON.parse(fs.readFileSync(path.join(vdir(dataDir), "recovery.json"), "utf8")).confirmed_at);
});

test("type-back: after three wrong tries the code is shown again and new groups are asked; still not confirmed until a full match", async () => {
  let n = 0;
  const seenAt = [];
  let dataDirRef = null;
  const ui = createFakeSecretUi({
    askGroups: (arg) => {
      n++;
      seenAt.push(ui.of("show").length);
      if (n <= 3) {
        const rec = JSON.parse(fs.readFileSync(path.join(vdir(dataDirRef), "recovery.json"), "utf8"));
        assert.equal(rec.confirmed_at, null, "not confirmed during the wrong tries");
        return ["1111", "1111", "1111"];
      }
      return null; // then the person gives up
    },
  });
  const made = makeVault({ ui });
  dataDirRef = made.dataDir;
  assert.equal((await made.vault.open()).state, "needs_confirm");
  assert.equal(n, 4);
  assert.deepEqual(seenAt, [1, 1, 1, 2], "the code was shown again after the third wrong try");
  assert.equal(JSON.parse(fs.readFileSync(path.join(vdir(made.dataDir), "recovery.json"), "utf8")).confirmed_at, null);
});

test("a window that fails to show the code leaves the vault unconfirmed; a window that throws on a question is a cancelled question", async () => {
  const ui = createFakeSecretUi({ showThrows: true, autoTypeBack: true });
  const { vault } = makeVault({ ui });
  assert.equal((await vault.open()).state, "needs_confirm");
  assert.equal(ui.of("askGroups").length, 0, "nothing is asked about a code that was not shown");
});

test("passphraseFor: not open, a run id that is no run id, no vault-check.json, another installation's check, a damaged one: all throw VaultError", async () => {
  const { vault, dataDir } = makeVault();
  const early = path.join(dataDir, "runs", R);
  fs.mkdirSync(early, { recursive: true });
  assert.throws(() => vault.passphraseFor(early, R), /not open/);
  await vault.open();
  const run = makeRun(dataDir, vault, R);
  assert.match(vault.passphraseFor(run.dir, R), /^[0-9a-f]{64}$/);
  assert.throws(() => vault.passphraseFor(run.dir, "xyz"), VaultError);
  assert.throws(() => vault.passphraseFor(run.dir, R.toUpperCase()), VaultError);
  assert.throws(() => vault.passphraseFor("", R), VaultError);
  const bare = path.join(dataDir, "runs", hex32());
  fs.mkdirSync(bare);
  assert.throws(() => vault.passphraseFor(bare, R), /no vault-check\.json/);
  fs.writeFileSync(path.join(run.dir, "vault-check.json"), `${JSON.stringify({ v: 1, check: "0000000000000000" })}\n`);
  assert.throws(() => vault.passphraseFor(run.dir, R), /another installation/);
  fs.writeFileSync(path.join(run.dir, "vault-check.json"), "{not json");
  assert.throws(() => vault.passphraseFor(run.dir, R), /damaged/);
  fs.writeFileSync(path.join(run.dir, "vault-check.json"), `${JSON.stringify({ v: 1, check: vault.keyCheck(), extra: 1 })}\n`);
  assert.throws(() => vault.passphraseFor(run.dir, R), /damaged/);
});

test("passphraseFor uses the run id it is given, not the folder name; two runs get two passphrases", async () => {
  const { vault, dataDir } = makeVault();
  await vault.open();
  const a = makeRun(dataDir, vault, R);
  const b = makeRun(dataDir, vault, "fedcba9876543210fedcba9876543210");
  assert.notEqual(vault.passphraseFor(a.dir, R), vault.passphraseFor(b.dir, b.id));
  // a moved folder still opens: same run id, another folder name
  const moved = path.join(dataDir, "runs", "renamed-folder");
  fs.cpSync(a.dir, moved, { recursive: true });
  assert.equal(vault.passphraseFor(moved, R), vault.passphraseFor(a.dir, R));
});

test("a migrated swap: passphrase.sealed is opened with the migrated key and gives the old passphrase; a tampered, moved or foreign one throws", async () => {
  const { vault, dataDir } = makeVault();
  await vault.open();
  const run = makeRun(dataDir, vault, R);
  const derived = vault.passphraseFor(run.dir, R);
  vault.writeMigratedPassphrase(run.dir, R, "the-old-passphrase");
  assert.equal(vault.passphraseFor(run.dir, R), "the-old-passphrase");
  assert.notEqual(derived, "the-old-passphrase");
  const f = path.join(run.dir, "passphrase.sealed");
  assert.ok(!fs.readFileSync(f, "utf8").includes("the-old-passphrase"));
  const original = fs.readFileSync(f);
  // tampered
  const o = JSON.parse(original.toString("utf8"));
  fs.writeFileSync(f, JSON.stringify({ ...o, ct: (o.ct[0] === "0" ? "1" : "0") + o.ct.slice(1) }));
  assert.throws(() => vault.passphraseFor(run.dir, R), /passphrase\.sealed cannot be opened/);
  // another run's sealed file copied here
  const other = makeRun(dataDir, vault, "fedcba9876543210fedcba9876543210");
  vault.writeMigratedPassphrase(other.dir, other.id, "other-old");
  fs.copyFileSync(path.join(other.dir, "passphrase.sealed"), f);
  assert.throws(() => vault.passphraseFor(run.dir, R), /passphrase\.sealed cannot be opened/);
  // a link or a folder under that name is not read
  fs.rmSync(f);
  fs.mkdirSync(f);
  assert.throws(() => vault.passphraseFor(run.dir, R), /passphrase\.sealed cannot be opened/);
});

test("a key store that cannot open the secret at a later start locks the vault with a fixed sentence; nothing is derived", async () => {
  const a = makeVault();
  await a.vault.open();
  const run = makeRun(a.dataDir, a.vault, R);
  a.keyStore.knobs.openThrows = true;
  const v2 = createVault({ dataDir: a.dataDir, keyStore: a.keyStore, secretUi: createFakeSecretUi({}) });
  assert.equal((await v2.open()).state, "locked");
  assert.equal(v2.ready().ok, false);
  assert.throws(() => v2.passphraseFor(run.dir, R), VaultError);
  assert.throws(() => v2.boardSealer(R).seal(Buffer.from("x"), "board-keys.json"), VaultError);
  assert.equal(v2.newSwapAllowed().ok, false);
  assert.throws(() => v2.keyCheck(), VaultError);
});

test("a key store that lies (other bytes) is caught: the vault's key check no longer fits and it is locked", async () => {
  const a = makeVault();
  await a.vault.open();
  a.keyStore.knobs.wrongData = true;
  const v2 = createVault({ dataDir: a.dataDir, keyStore: a.keyStore, secretUi: createFakeSecretUi({}) });
  const r = await v2.open();
  assert.equal(r.state, "locked");
  assert.match(v2.ready().why, /key-check\.json/);
});

test("a key store that refuses to seal at the first start: locked, nothing is left in the vault folder, nothing is shown", async () => {
  const ks = createFakeKeyStore();
  ks.knobs.sealThrows = true;
  const { vault, dataDir, ui } = makeVault({ keyStore: ks });
  assert.equal((await vault.open()).state, "locked");
  assert.match(vault.ready().why, /refused to seal/);
  assert.deepEqual(fs.readdirSync(vdir(dataDir)), []);
  assert.equal(ui.of("show").length, 0);
});

test("a key store that does not read the secret back at the first start: the file is removed and the vault is locked", async () => {
  const ks = createFakeKeyStore();
  const lying = { ...ks, open: () => crypto.randomBytes(32) };
  const { vault, dataDir } = makeVault({ keyStore: lying });
  assert.equal((await vault.open()).state, "locked");
  assert.match(vault.ready().why, /did not read back/);
  assert.deepEqual(fs.readdirSync(vdir(dataDir)), []);
});

test("a vault folder that lost key-check.json or recovery.json is repaired from the secret the key store opened; a key-check that disagrees locks it", async () => {
  const a = makeVault();
  await a.vault.open();
  fs.rmSync(path.join(vdir(a.dataDir), "key-check.json"));
  fs.writeFileSync(path.join(vdir(a.dataDir), "recovery.json"), "garbage");
  const v2 = createVault({ dataDir: a.dataDir, keyStore: a.keyStore, secretUi: createFakeSecretUi({}) });
  assert.equal((await v2.open()).state, "needs_confirm", "a damaged recovery record counts as not confirmed");
  assert.equal(JSON.parse(fs.readFileSync(path.join(vdir(a.dataDir), "key-check.json"), "utf8")).check, a.vault.keyCheck());
  fs.writeFileSync(path.join(vdir(a.dataDir), "key-check.json"), `${JSON.stringify({ v: 1, check: "ffffffffffffffff" })}\n`);
  const v3 = createVault({ dataDir: a.dataDir, keyStore: a.keyStore, secretUi: createFakeSecretUi({}) });
  assert.equal((await v3.open()).state, "locked");
});

test("open() called twice is one open", async () => {
  const { vault, ui } = makeVault();
  const [a, b] = await Promise.all([vault.open(), vault.open()]);
  assert.deepEqual(a, b);
  assert.equal(ui.of("show").length, 1);
});

// ---------------------------------------------------------------- the fallback (no usable key store)

test("no usable key store: the passphrase is asked twice and sealed with scrypt; never a clear file; a later start asks for it", async () => {
  const ks = createFakeKeyStore();
  ks.knobs.available = false;
  const PASS = "correct horse battery staple";
  const ui = createFakeSecretUi({ askText: { "fallback-new": [PASS, PASS] }, autoTypeBack: true });
  const { vault, dataDir } = makeVault({ keyStore: ks, ui });
  assert.deepEqual(await vault.open(), { state: "ready" });
  assert.equal(vault.mode(), "fallback");
  const asks = ui.of("askText");
  assert.deepEqual(asks.map((c) => c.arg), [{ kind: "fallback-new" }, { kind: "fallback-new", again: true }]);
  assert.deepEqual(fs.readdirSync(vdir(dataDir)).sort(), ["install-secret.pw.v1", "key-check.json", "recovery.json"]);
  const pw = JSON.parse(fs.readFileSync(path.join(vdir(dataDir), "install-secret.pw.v1"), "utf8"));
  assert.deepEqual(Object.keys(pw), ["v", "kdf", "N", "r", "p", "salt", "nonce", "ct", "tag"]);
  assert.equal(pw.kdf, "scrypt");
  assert.equal(pw.N, 131072);
  assert.equal(pw.r, 8);
  assert.equal(pw.p, 1);
  assert.match(pw.salt, /^[0-9a-f]{32}$/);
  const S = secretFromShown(ui);
  const all = filesUnder(dataDir).map((f) => f.bytes);
  for (const b of all) {
    assert.ok(!b.includes(S));
    assert.ok(!b.toString("latin1").includes(S.toString("hex")));
    assert.ok(!b.toString("latin1").includes(PASS));
  }
  const run = makeRun(dataDir, vault, R);
  const pass1 = vault.passphraseFor(run.dir, R);
  assert.equal(pass1, derive.passphrase(S, R));
  // a later start
  const ui2 = createFakeSecretUi({ askText: { fallback: ["not it", PASS] } });
  const v2 = createVault({ dataDir, keyStore: ks, secretUi: ui2 });
  assert.deepEqual(await v2.open(), { state: "ready" });
  assert.equal(v2.passphraseFor(run.dir, R), pass1);
  assert.equal(ui2.of("say").filter((c) => c.arg.kind === "wrong-passphrase").length, 1);
  assert.equal(v2.mode(), "fallback");
});

test("fallback: three wrong passphrases lock the vault; a cancelled question locks it; no swap acts", async () => {
  const ks = createFakeKeyStore();
  ks.knobs.available = false;
  const PASS = "correct horse battery staple";
  const first = makeVault({ keyStore: ks, uiAnswers: { askText: { "fallback-new": [PASS, PASS] }, autoTypeBack: true } });
  await first.vault.open();
  const run = makeRun(first.dataDir, first.vault, R);
  const ui = createFakeSecretUi({ askText: { fallback: ["a", "b", "c", PASS] } });
  const v = createVault({ dataDir: first.dataDir, keyStore: ks, secretUi: ui });
  const r = await v.open();
  assert.equal(r.state, "locked");
  assert.match(v.ready().why, /wrong three times/);
  assert.equal(ui.of("askText").length, 3, "the fourth is never asked");
  assert.throws(() => v.passphraseFor(run.dir, R), VaultError);
  const v2 = createVault({ dataDir: first.dataDir, keyStore: ks, secretUi: createFakeSecretUi({ askText: { fallback: [] } }) });
  assert.equal((await v2.open()).state, "locked");
  assert.match(v2.ready().why, /no passphrase/);
});

test("fallback: a passphrase that is too short or typed differently the second time is asked again; three failures end with no vault and no file", async () => {
  const ks = createFakeKeyStore();
  ks.knobs.available = false;
  const ui = createFakeSecretUi({ askText: { "fallback-new": ["short", "a-long-enough-passphrase", "another-long-passphrase", "a-long-enough-passphrase", "different-one-ok-12", "x"] }, autoTypeBack: true });
  const { vault, dataDir } = makeVault({ keyStore: ks, ui });
  const r = await vault.open();
  assert.equal(r.state, "locked");
  assert.match(vault.ready().why, /no passphrase was chosen/);
  assert.deepEqual(ui.of("say").map((c) => c.arg.reason), ["short", "mismatch", "mismatch"]);
  assert.deepEqual(fs.readdirSync(vdir(dataDir)), []);
  // and a good pair after a bad one works
  const ui2 = createFakeSecretUi({ askText: { "fallback-new": ["short", "a-long-enough-passphrase", "a-long-enough-passphrase"] }, autoTypeBack: true });
  const ok = makeVault({ keyStore: ks, ui: ui2 });
  assert.equal((await ok.vault.open()).state, "ready");
});

test("fallback: a file with other scrypt parameters or fields is refused (no downgrade, no cost set by a file)", async () => {
  const ks = createFakeKeyStore();
  ks.knobs.available = false;
  const PASS = "correct horse battery staple";
  const first = makeVault({ keyStore: ks, uiAnswers: { askText: { "fallback-new": [PASS, PASS] }, autoTypeBack: true } });
  await first.vault.open();
  const f = path.join(vdir(first.dataDir), "install-secret.pw.v1");
  const good = JSON.parse(fs.readFileSync(f, "utf8"));
  for (const bad of [{ ...good, N: 1024 }, { ...good, kdf: "pbkdf2" }, { ...good, extra: 1 }, { ...good, salt: "00" }, { ...good, v: 2 }]) {
    fs.writeFileSync(f, JSON.stringify(bad));
    const v = createVault({ dataDir: first.dataDir, keyStore: ks, secretUi: createFakeSecretUi({ askText: { fallback: [PASS] } }) });
    assert.equal((await v.open()).state, "locked");
  }
});

test("a key store that is available at a later start while only a fallback file exists: the fallback file is used (no silent second secret)", async () => {
  const ks = createFakeKeyStore();
  ks.knobs.available = false;
  const PASS = "correct horse battery staple";
  const first = makeVault({ keyStore: ks, uiAnswers: { askText: { "fallback-new": [PASS, PASS] }, autoTypeBack: true } });
  await first.vault.open();
  ks.knobs.available = true;
  const v = createVault({ dataDir: first.dataDir, keyStore: ks, secretUi: createFakeSecretUi({ askText: { fallback: [PASS] } }) });
  assert.equal((await v.open()).state, "ready");
  assert.equal(v.mode(), "fallback");
  assert.deepEqual(fs.readdirSync(vdir(first.dataDir)).sort(), ["install-secret.pw.v1", "key-check.json", "recovery.json"]);
});

test("the key store is only sealed by when it is there: a sealed secret and a key store that is gone locks the vault (no fallback over it)", async () => {
  const a = makeVault();
  await a.vault.open();
  a.keyStore.knobs.available = false;
  const ui = createFakeSecretUi({});
  const v = createVault({ dataDir: a.dataDir, keyStore: a.keyStore, secretUi: ui });
  assert.equal((await v.open()).state, "locked");
  assert.match(v.ready().why, /key store is not available/);
  assert.equal(ui.calls.length, 0);
});

// ---------------------------------------------------------------- restore

test("restore (design 12.1 test): on an empty key store, the code and the run folders bring back a migrated swap's passphrase and a new swap's", async () => {
  // install 1: a new swap and a migrated swap
  const one = makeVault();
  await one.vault.open();
  const S1 = secretFromShown(one.ui);
  const newRun = makeRun(one.dataDir, one.vault, hex32());
  const oldRun = makeRun(one.dataDir, one.vault, hex32());
  one.vault.writeMigratedPassphrase(oldRun.dir, oldRun.id, "legacy-passphrase-xyz");
  const wantNew = one.vault.passphraseFor(newRun.dir, newRun.id);
  const wantOld = one.vault.passphraseFor(oldRun.dir, oldRun.id);
  assert.equal(wantOld, "legacy-passphrase-xyz");
  // install 2: another machine, an empty key store, the run folders copied over, the secret of its own first start never used
  const two = makeVault({ uiAnswers: { askText: { restore: [rc.encode(S1).toLowerCase()] }, autoTypeBack: true } });
  fs.cpSync(path.join(one.dataDir, "runs"), path.join(two.dataDir, "runs"), { recursive: true });
  await two.vault.open();
  // MF2: run folders are here and there is no secret: no new secret is made, the vault says to restore
  assert.equal(two.vault.state().state, "locked");
  assert.match(two.vault.ready().why, /secret is missing: restore with your recovery code/);
  assert.deepEqual(fs.readdirSync(vdir(two.dataDir)), [], "nothing was made");
  assert.equal(two.ui.of("show").length, 0, "no new code was shown");
  assert.throws(() => two.vault.passphraseFor(path.join(two.dataDir, "runs", newRun.id), newRun.id), VaultError);
  const r = await two.vault.restore();
  assert.deepEqual(r, { ok: true, why: null });
  assert.equal(two.vault.keyCheck(), one.vault.keyCheck());
  assert.equal(two.vault.passphraseFor(path.join(two.dataDir, "runs", newRun.id), newRun.id), wantNew);
  assert.equal(two.vault.passphraseFor(path.join(two.dataDir, "runs", oldRun.id), oldRun.id), wantOld);
  assert.equal(two.vault.recoveryConfirmed(), true, "the whole code was typed");
  assert.equal(two.vault.newSwapAllowed().ok, true);
  // and it stays: a restart of install 2 reads the restored secret
  const again = createVault({ dataDir: two.dataDir, keyStore: two.keyStore, secretUi: createFakeSecretUi({}) });
  assert.equal((await again.open()).state, "ready");
  assert.equal(again.passphraseFor(path.join(two.dataDir, "runs", newRun.id), newRun.id), wantNew);
});

test("restore: a code from another installation (another key check) is refused and nothing is written", async () => {
  const one = makeVault();
  await one.vault.open();
  const run = makeRun(one.dataDir, one.vault, hex32());
  const stranger = makeVault();
  await stranger.vault.open();
  const strangerCode = codeFromShown(stranger.ui);
  const two = makeVault({ uiAnswers: { askText: { restore: [strangerCode] }, autoTypeBack: true } });
  fs.cpSync(path.join(one.dataDir, "runs"), path.join(two.dataDir, "runs"), { recursive: true });
  await two.vault.open();
  const before = snapshot(two.dataDir);
  const r = await two.vault.restore();
  assert.equal(r.ok, false);
  assert.match(r.why, /not the one of these run folders/);
  assert.deepEqual(snapshot(two.dataDir), before, "no file changed");
  assert.equal(two.ui.of("say").filter((c) => c.arg.kind === "other-install").length, 1);
  assert.throws(() => two.vault.passphraseFor(path.join(two.dataDir, "runs", run.id), run.id), VaultError);
});

test("restore on a vault that opened with an empty runs folder: the run folders copied in afterwards are restored over the fresh, unused secret, which is kept aside", async () => {
  const one = makeVault();
  await one.vault.open();
  const S1 = secretFromShown(one.ui);
  const run = makeRun(one.dataDir, one.vault, hex32());
  const want = one.vault.passphraseFor(run.dir, run.id);
  const two = makeVault({ uiAnswers: { askText: { restore: [rc.encode(S1)] }, autoTypeBack: true } });
  await two.vault.open(); // a first start: a new secret S2
  const S2check = two.vault.keyCheck();
  fs.cpSync(path.join(one.dataDir, "runs"), path.join(two.dataDir, "runs"), { recursive: true });
  assert.deepEqual(await two.vault.restore(), { ok: true, why: null });
  assert.notEqual(two.vault.keyCheck(), S2check);
  assert.equal(two.vault.passphraseFor(path.join(two.dataDir, "runs", run.id), run.id), want);
  const aside = fs.readdirSync(vdir(two.dataDir)).filter((n) => /^install-secret\.v1\.\d+\.old$/.test(n));
  assert.equal(aside.length, 1, "the replaced secret file was renamed aside, not deleted");
});

test("MF2: a first start next to run folders (the vault folder was lost) makes no new secret, shows no code and says to restore; restoring with the old code brings the folders back", async () => {
  const a = makeVault();
  await a.vault.open();
  const codeA = codeFromShown(a.ui);
  const runA = makeRun(a.dataDir, a.vault, hex32());
  const want = a.vault.passphraseFor(runA.dir, runA.id);
  fs.rmSync(path.join(a.dataDir, "vault"), { recursive: true });
  const ui = createFakeSecretUi({ autoTypeBack: true, askText: { restore: [codeA] } });
  const v = createVault({ dataDir: a.dataDir, keyStore: a.keyStore, secretUi: ui });
  assert.deepEqual(await v.open(), { state: "locked" });
  assert.match(v.ready().why, /restore with your recovery code/);
  assert.equal(v.newSwapAllowed().ok, false);
  assert.equal(ui.of("show").length, 0);
  assert.deepEqual(fs.readdirSync(vdir(a.dataDir)), []);
  assert.deepEqual(await v.restore(), { ok: true, why: null });
  assert.equal(v.passphraseFor(runA.dir, runA.id), want);
  assert.equal(v.newSwapAllowed().ok, true);
});

test("MF2: ended run folders (runs/.ended/*) count too; a first start with no run folder at all still makes a secret", async () => {
  const a = makeVault();
  await a.vault.open();
  const ended = path.join(a.dataDir, "runs", ".ended", hex32());
  fs.mkdirSync(ended, { recursive: true });
  fs.writeFileSync(path.join(ended, "vault-check.json"), JSON.stringify({ v: 1, check: a.vault.keyCheck() }));
  fs.rmSync(path.join(a.dataDir, "vault"), { recursive: true });
  const v = createVault({ dataDir: a.dataDir, keyStore: a.keyStore, secretUi: createFakeSecretUi({ autoTypeBack: true }) });
  assert.equal((await v.open()).state, "locked");
  const fresh = makeVault();
  assert.equal((await fresh.vault.open()).state, "ready");
});

test("MF1: a LOCKED vault is not restored over a secret that run folders still use: refused, every file unchanged, nothing set aside", async () => {
  const B = makeVault();
  await B.vault.open();
  const runB = makeRun(B.dataDir, B.vault, hex32());
  const codeB = codeFromShown(B.ui);
  const A = makeVault();
  await A.vault.open();
  const runA = makeRun(A.dataDir, A.vault, hex32());
  const passA = A.vault.passphraseFor(runA.dir, runA.id);
  fs.cpSync(runB.dir, path.join(A.dataDir, "runs", runB.id), { recursive: true }); // a backup of install B's folder
  A.keyStore.knobs.openThrows = true; // the key store refuses once
  const ui = createFakeSecretUi({ askText: { restore: [codeB] } });
  const v = createVault({ dataDir: A.dataDir, keyStore: A.keyStore, secretUi: ui });
  assert.equal((await v.open()).state, "locked");
  A.keyStore.knobs.openThrows = false;
  const before = snapshot(A.dataDir);
  const r = await v.restore();
  assert.equal(r.ok, false);
  assert.match(r.why, /already has swaps under its own secret/);
  assert.deepEqual(snapshot(A.dataDir), before, "no file changed, nothing deleted, nothing set aside");
  assert.equal(ui.of("say").filter((c) => c.arg.kind === "other-install").length, 1);
  // the next start still opens A's own swap
  const v3 = createVault({ dataDir: A.dataDir, keyStore: A.keyStore, secretUi: createFakeSecretUi({}) });
  assert.equal((await v3.open()).state, "ready");
  assert.equal(v3.passphraseFor(runA.dir, runA.id), passA);
});

test("MF1: the same holds for a fallback vault locked by three wrong passphrases, and for an ended folder (runs/.ended) that uses the secret", async () => {
  const ks = createFakeKeyStore();
  ks.knobs.available = false;
  const PASS = "correct horse battery staple";
  const A = makeVault({ keyStore: ks, uiAnswers: { askText: { "fallback-new": [PASS, PASS] }, autoTypeBack: true } });
  await A.vault.open();
  const ended = path.join(A.dataDir, "runs", ".ended", hex32());
  fs.mkdirSync(ended, { recursive: true });
  fs.writeFileSync(path.join(ended, "vault-check.json"), JSON.stringify({ v: 1, check: A.vault.keyCheck() })); // only an ended folder uses it
  const B = makeVault();
  await B.vault.open();
  const runB = makeRun(B.dataDir, B.vault, hex32());
  fs.cpSync(runB.dir, path.join(A.dataDir, "runs", runB.id), { recursive: true });
  const v = createVault({ dataDir: A.dataDir, keyStore: ks, secretUi: createFakeSecretUi({ askText: { fallback: ["a", "b", "c"], restore: [codeFromShown(B.ui)], "fallback-new": [PASS, PASS] } }) });
  assert.equal((await v.open()).state, "locked");
  const before = snapshot(A.dataDir);
  const r = await v.restore();
  assert.equal(r.ok, false);
  assert.match(r.why, /already has swaps under its own secret/);
  assert.deepEqual(snapshot(A.dataDir), before);
});

test("MF1: a locked vault whose key store comes back can still be restored with ITS OWN code (a reinstalled system), and the old file is kept aside", async () => {
  const one = makeVault();
  await one.vault.open();
  const S1 = secretFromShown(one.ui);
  const run = makeRun(one.dataDir, one.vault, hex32());
  const want = one.vault.passphraseFor(run.dir, run.id);
  const v = createVault({ dataDir: one.dataDir, keyStore: createFakeKeyStore(), secretUi: createFakeSecretUi({ askText: { restore: [rc.encode(S1)] } }) });
  assert.equal((await v.open()).state, "locked");
  assert.deepEqual(await v.restore(), { ok: true, why: null });
  assert.equal(v.passphraseFor(run.dir, run.id), want);
  const names = fs.readdirSync(vdir(one.dataDir));
  assert.equal(names.filter((n) => /^install-secret\.v1\.\d+\.old$/.test(n)).length, 1, "the unreadable old file is kept aside");
  assert.ok(names.includes("install-secret.v1"));
});

test("a restore whose new secret cannot be written puts the old secret file back", async () => {
  const one = makeVault();
  await one.vault.open();
  const S1 = secretFromShown(one.ui);
  const before = snapshot(vdir(one.dataDir));
  const other = makeVault();
  await other.vault.open();
  // a vault over the same folder whose writes of the new secret fail after the old one was moved aside
  const real = fs;
  let failNext = false;
  const io = { ...real, renameSync: (a, b) => { if (String(b).endsWith("install-secret.v1") && !String(a).endsWith(".old") && failNext) throw new Error("disk"); return real.renameSync(a, b); } };
  const v = createVault({ dataDir: one.dataDir, keyStore: createFakeKeyStore(), secretUi: createFakeSecretUi({ askText: { restore: [rc.encode(S1)] } }), fs: io });
  assert.equal((await v.open()).state, "locked");
  failNext = true;
  const r = await v.restore();
  assert.equal(r.ok, false);
  assert.deepEqual(snapshot(vdir(one.dataDir)), before, "the vault folder is as it was");
});

test("restore with the vault's own code marks the recovery confirmed when it was not", async () => {
  const ui = createFakeSecretUi({ askGroups: [null] });
  const made = makeVault({ ui });
  assert.equal((await made.vault.open()).state, "needs_confirm");
  const code = codeFromShown(ui);
  const v = createVault({ dataDir: made.dataDir, keyStore: made.keyStore, secretUi: createFakeSecretUi({ askText: { restore: [code] } }) });
  assert.equal((await v.open()).state, "needs_confirm");
  assert.deepEqual(await v.restore(), { ok: true, why: null });
  assert.equal(v.recoveryConfirmed(), true);
  assert.equal(JSON.parse(fs.readFileSync(path.join(vdir(made.dataDir), "recovery.json"), "utf8")).confirmed_at.length > 10, true);
});

test("restore: a typo (the checksum), a cancelled question and a code of a vault that is already in use are all refused; the secret in use is never replaced", async () => {
  const one = makeVault();
  await one.vault.open();
  const run = makeRun(one.dataDir, one.vault, hex32());
  const S1 = secretFromShown(one.ui);
  const code = rc.encode(S1);
  const typo = code.slice(0, 10) + (code[10] === "2" ? "3" : "2") + code.slice(11);
  const v = createVault({ dataDir: one.dataDir, keyStore: one.keyStore, secretUi: createFakeSecretUi({ askText: { restore: [typo, null] } }) });
  await v.open();
  const before = snapshot(one.dataDir);
  assert.equal((await v.restore()).ok, false);
  assert.equal((await v.restore()).why, "cancelled");
  assert.deepEqual(snapshot(one.dataDir), before);
  // the same installation's own code: nothing to do, ok
  const same = createVault({ dataDir: one.dataDir, keyStore: one.keyStore, secretUi: createFakeSecretUi({ askText: { restore: [code] } }) });
  await same.open();
  assert.deepEqual(await same.restore(), { ok: true, why: null });
  assert.deepEqual(snapshot(one.dataDir), before);
  // another code, while this vault has swaps under its own secret: refused even if the other code were in the run folders
  const other = makeVault();
  await other.vault.open();
  const otherCode = codeFromShown(other.ui);
  const inUse = createVault({ dataDir: one.dataDir, keyStore: one.keyStore, secretUi: createFakeSecretUi({ askText: { restore: [otherCode] } }) });
  await inUse.open();
  const r = await inUse.restore();
  assert.equal(r.ok, false);
  assert.match(r.why, /already has swaps under its own secret/);
  assert.deepEqual(snapshot(one.dataDir), before);
  assert.ok(run);
});

test("restore with the key store gone: the vault was locked (it could not open its secret); restoring seals the secret again, replacing the unreadable file", async () => {
  const one = makeVault();
  await one.vault.open();
  const S1 = secretFromShown(one.ui);
  const run = makeRun(one.dataDir, one.vault, hex32());
  const want = one.vault.passphraseFor(run.dir, run.id);
  const newKs = createFakeKeyStore(); // a reinstalled system: a new key store that cannot open the old file
  const ui = createFakeSecretUi({ askText: { restore: [rc.encode(S1)] } });
  const v = createVault({ dataDir: one.dataDir, keyStore: newKs, secretUi: ui });
  assert.equal((await v.open()).state, "locked");
  assert.deepEqual(await v.restore(), { ok: true, why: null });
  assert.equal(v.passphraseFor(run.dir, run.id), want);
  const v2 = createVault({ dataDir: one.dataDir, keyStore: newKs, secretUi: createFakeSecretUi({}) });
  assert.equal((await v2.open()).state, "ready");
  assert.equal(v2.passphraseFor(run.dir, run.id), want);
});

test("restore with no key store: the restored secret is sealed with a new passphrase (asked twice), and the unreadable key-store file is set aside", async () => {
  const one = makeVault();
  await one.vault.open();
  const S1 = secretFromShown(one.ui);
  const run = makeRun(one.dataDir, one.vault, hex32());
  const want = one.vault.passphraseFor(run.dir, run.id);
  const noKs = createFakeKeyStore();
  noKs.knobs.available = false;
  const PASS = "a new fallback passphrase";
  const ui = createFakeSecretUi({ askText: { restore: [rc.encode(S1)], "fallback-new": [PASS, PASS] } });
  const v = createVault({ dataDir: one.dataDir, keyStore: noKs, secretUi: ui });
  assert.equal((await v.open()).state, "locked"); // sealed by a key store that is not there
  assert.deepEqual(await v.restore(), { ok: true, why: null });
  assert.equal(v.mode(), "fallback");
  assert.equal(v.passphraseFor(run.dir, run.id), want);
  assert.deepEqual(fs.readdirSync(vdir(one.dataDir)).filter((n) => !/\.old$/.test(n)).sort(), ["install-secret.pw.v1", "key-check.json", "recovery.json"]);
  assert.equal(fs.readdirSync(vdir(one.dataDir)).filter((n) => /^install-secret\.v1\.\d+\.old$/.test(n)).length, 1, "the key-store file is kept aside, not deleted");
});

// ---------------------------------------------------------------- the board

test("the board sealer: seal and open round trip; the file name and the run are bound; the plain text is not in the sealed bytes", async () => {
  const { vault } = makeVault();
  await vault.open();
  const s = vault.boardSealer(R);
  const plain = Buffer.from('{"v":1,"invite":null,"keys":{}}\n');
  const blob = s.seal(plain, "board-keys.json");
  assert.ok(Buffer.isBuffer(blob));
  assert.ok(!blob.includes(plain.subarray(0, 12)));
  assert.ok(s.open(blob, "board-keys.json").equals(plain));
  assert.throws(() => s.open(blob, "other.json"));
  assert.throws(() => vault.boardSealer("fedcba9876543210fedcba9876543210").open(blob, "board-keys.json"));
  assert.throws(() => vault.boardSealer("nope"), VaultError);
});

test("the history sealer: round trip under its own label, the file name is bound, another installation cannot open it, a locked vault throws VaultError", async () => {
  const { vault } = makeVault();
  await vault.open();
  const s = vault.historySealer();
  const plain = Buffer.from('{"v":1,"entries":[]}');
  const blob = s.seal(plain, "payout-history.sealed");
  assert.equal(JSON.parse(blob.toString("utf8")).label, "payout-history");
  assert.equal(JSON.parse(blob.toString("utf8")).run_id, "install");
  assert.ok(s.open(blob, "payout-history.sealed").equals(plain));
  assert.throws(() => s.open(blob, "other.sealed"));
  const other = makeVault();
  await other.vault.open();
  assert.throws(() => other.vault.historySealer().open(blob, "payout-history.sealed"));
  const locked = makeVault({ keyStore: (() => { const k = createFakeKeyStore(); k.knobs.sealThrows = true; return k; })() });
  await locked.vault.open();
  assert.throws(() => locked.vault.historySealer().seal(plain, "payout-history.sealed"), VaultError);
});

test("the invite secret: asked in the secret window, sealed with its own key, read back; a bad value is a wrong code; cancel changes nothing", async () => {
  const INV = "ab".repeat(32);
  const ui = createFakeSecretUi({ autoTypeBack: true, askText: { invite: [`  ${INV.toUpperCase()}  `, "nope", null] } });
  const { vault, dataDir } = makeVault({ ui });
  await vault.open();
  assert.equal(vault.inviteSecret(), null);
  await vault.setInviteSecret();
  assert.equal(vault.inviteSecret(), INV);
  const f = path.join(vdir(dataDir), "board-invite.sealed");
  const sealedText = fs.readFileSync(f, "utf8");
  assert.ok(!sealedText.includes(INV));
  assert.equal(JSON.parse(sealedText).label, "board-invite");
  assert.equal(JSON.parse(sealedText).run_id, "install");
  await vault.setInviteSecret(); // "nope"
  assert.equal(ui.of("say").filter((c) => c.arg.kind === "wrong-code").length, 1);
  assert.equal(vault.inviteSecret(), INV);
  await vault.setInviteSecret(); // null: cancelled
  assert.equal(vault.inviteSecret(), INV);
  // another installation cannot read it
  const other = makeVault();
  await other.vault.open();
  fs.copyFileSync(f, path.join(vdir(other.dataDir), "board-invite.sealed"));
  assert.throws(() => other.vault.inviteSecret(), VaultError);
});

test("the invite secret and every key function refuse when the vault is not ready", async () => {
  const { vault } = makeVault({ keyStore: (() => { const k = createFakeKeyStore(); k.knobs.sealThrows = true; return k; })() });
  await vault.open();
  assert.throws(() => vault.inviteSecret(), VaultError);
  await assert.rejects(() => vault.setInviteSecret(), VaultError);
  await assert.rejects(() => vault.showRecoveryCode(), VaultError);
  assert.throws(() => vault.writeMigratedPassphrase(tmpDir(), R, "x"), VaultError);
});

// ---------------------------------------------------------------- 12.2

test("12.2: the vault exposes no function that hands the secret or the recovery code to a caller; the module exports only the factory", async () => {
  const mod = require("../lib/vault");
  assert.deepEqual(Object.keys(mod).sort(), ["SCRYPT", "VaultError", "createVault"]);
  const { vault, ui, dataDir } = makeVault();
  assert.deepEqual(
    Object.keys(vault).sort(),
    ["boardSealer", "historySealer", "inviteSecret", "keyCheck", "mode", "newSwapAllowed", "open", "passphraseFor", "ready", "recoveryConfirmed", "restore", "setInviteSecret", "showRecoveryCode", "state", "writeMigratedPassphrase"].sort(),
  );
  await vault.open();
  const S = secretFromShown(ui);
  const run = makeRun(dataDir, vault, R);
  // call every function that has no secret input and look at what comes back: none of it holds the secret or the code
  const results = [await vault.open(), vault.ready(), vault.recoveryConfirmed(), vault.newSwapAllowed(), vault.mode(), vault.keyCheck(), vault.inviteSecret(), await vault.showRecoveryCode()];
  const blob = JSON.stringify(results);
  assert.ok(!blob.includes(S.toString("hex")));
  assert.ok(!blob.includes(codeFromShown(ui)));
  assert.ok(!blob.includes(codeFromShown(ui).replace(/-/g, "")));
  // the passphrase is derived (a different value), and no error text carries S or the code
  assert.notEqual(vault.passphraseFor(run.dir, R), S.toString("hex"));
  for (const bad of [() => vault.passphraseFor(run.dir, "no"), () => vault.passphraseFor("/nope", R)]) {
    try {
      bad();
      assert.fail("should throw");
    } catch (e) {
      assert.ok(!e.message.includes(S.toString("hex")) && !e.message.includes(codeFromShown(ui)));
    }
  }
  // sealed.js and derive.js hold the only byte-level functions; the vault module does not re-export them
  assert.equal(typeof sealed.seal, "function");
});

test("restore: a pasted code with line ends and spaces is read (the checksum protects it)", async () => {
  const one = makeVault();
  await one.vault.open();
  const S1 = secretFromShown(one.ui);
  const run = makeRun(one.dataDir, one.vault, hex32());
  const two = makeVault({ uiAnswers: { askText: { restore: [`  ${rc.encode(S1).replace(/-/g, " ")}\r\n`] }, autoTypeBack: true } });
  fs.cpSync(path.join(one.dataDir, "runs"), path.join(two.dataDir, "runs"), { recursive: true });
  await two.vault.open();
  assert.deepEqual(await two.vault.restore(), { ok: true, why: null });
  assert.equal(two.vault.passphraseFor(path.join(two.dataDir, "runs", run.id), run.id), one.vault.passphraseFor(run.dir, run.id));
});

test("state() follows the vault: locked, then ready after a restore (open() opens once and then answers with the state now)", async () => {
  const one = makeVault();
  await one.vault.open();
  const S1 = secretFromShown(one.ui);
  const newKs = createFakeKeyStore();
  const v = createVault({ dataDir: one.dataDir, keyStore: newKs, secretUi: createFakeSecretUi({ askText: { restore: [rc.encode(S1)] } }) });
  assert.deepEqual(await v.open(), { state: "locked" });
  assert.deepEqual(v.state(), { state: "locked" });
  await v.restore();
  assert.deepEqual(v.state(), { state: "ready" });
  assert.deepEqual(await v.open(), { state: "ready" }, "open() answers with the state now, without opening again");
});

test("fallback mode: a restore whose old secret cannot be moved aside deletes nothing; the old file stays and the vault still opens with it", async () => {
  const ks = { kind: "fake", available: () => false, seal() { throw new Error("no key store"); }, open() { throw new Error("no key store"); } };
  const ui = createFakeSecretUi({ autoTypeBack: true, askText: { "fallback-new": ["correct horse battery", "correct horse battery"] } });
  const A = makeVault({ keyStore: ks, ui });
  await A.vault.open();
  const B = makeVault();
  await B.vault.open();
  const codeB = codeFromShown(B.ui);
  const vaultDir = path.join(A.dataDir, "vault");
  const before = fs.readFileSync(path.join(vaultDir, "install-secret.pw.v1"));
  const fsx = { ...fs, renameSync: (a, b) => { if (String(a).endsWith("install-secret.pw.v1")) { const e = new Error("EBUSY"); e.code = "EBUSY"; throw e; } return fs.renameSync(a, b); } };
  const ui2 = createFakeSecretUi({ askText: { restore: [codeB], fallback: ["correct horse battery"], "fallback-new": ["another long passphrase", "another long passphrase"] } });
  const v = createVault({ dataDir: A.dataDir, keyStore: ks, secretUi: ui2, fs: fsx });
  assert.equal((await v.open()).state, "ready");
  const r = await v.restore();
  assert.equal(r.ok, false);
  assert.match(r.why, /moved aside/);
  assert.deepEqual(fs.readFileSync(path.join(vaultDir, "install-secret.pw.v1")), before, "the old sealed secret is still there, unchanged");
  const again = createVault({ dataDir: A.dataDir, keyStore: ks, secretUi: createFakeSecretUi({ askText: { fallback: ["correct horse battery"] } }) });
  assert.equal((await again.open()).state, "ready", "the vault still opens with its own passphrase");
});
