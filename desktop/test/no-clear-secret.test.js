"use strict";
// 6.10 "No secret in clear" (design 10 test): after a full flow with stub tools (setup, wallet setup, prepare and join, board key save, the invite secret, an
// import), every file under the data folder is scanned: no install secret (raw bytes, hex, base64, base64url, Crockford with and without hyphens), no derived
// passphrase, no migrated passphrase, no board secret key, no invite secret. The steps run against the stub tools of the console's step tests.
const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { makeHarness } = require("../../ui/app/test/steps-fixtures/harness");
const registry = require("../../ui/app/test/steps-fixtures/registry-setup");
const { KeyStore } = require("../../ui/app/lib/board/keys");
const { createMigrator } = require("../lib/migrate");
const rc = require("../lib/recoverycode");
const derive = require("../lib/derive");
const { createFakeSecretUi } = require("./fake-secretui");
const { makeVault, secretFromShown, filesUnder, tmpDir, cleanupAll } = require("./vault-helpers");

test.after(cleanupAll);

const INVITE = "ef".repeat(32);
const OLD_PASS = "legacy-test-passphrase-do-not-use-0123456789";
const FIX = path.join(__dirname, "fixtures");
const entry = (name) => registry.find((e) => e.name === name);

/** Everything a scan must not find, as Buffers (a text form is searched as latin1 bytes too). */
function forbiddenFor(S, extra) {
  const forms = [S, Buffer.from(S.toString("hex")), Buffer.from(S.toString("hex").toUpperCase()), Buffer.from(S.toString("base64")), Buffer.from(S.toString("base64url")), Buffer.from(S.toString("base64").replace(/=+$/, ""))];
  const raw = rc.encodeRaw(S);
  forms.push(Buffer.from(raw), Buffer.from(raw.toLowerCase()), Buffer.from(rc.encode(S)), Buffer.from(rc.encode(S).toLowerCase()));
  return [...forms, ...extra.map((t) => Buffer.from(t))];
}

test("after setup, wallet setup, prepare, join, a board key, the invite secret and an import, no file under the data folder holds a secret in clear", async () => {
  const ui = createFakeSecretUi({ autoTypeBack: true, askText: { invite: [INVITE] } });
  const { vault, dataDir } = makeVault({ ui });
  await vault.open();
  const S = secretFromShown(ui);
  const runsDir = path.join(dataDir, "runs");
  const derived = [];
  let proved = 0;

  // the steps, each in its own harness (the console's step tests do the same), then the run folder is moved under the data folder
  for (const [name, role] of [["setup", "alice"], ["walletSetup (alice)", "alice"], ["prepare", "alice"], ["walletSetup (bob)", "bob"], ["join", "bob"]]) {
    const e = entry(name);
    const id = crypto.randomBytes(16).toString("hex");
    const h = makeHarness({ passphrase: null, settings: { role, ...(e.settings || {}), run_id: id } });
    try {
      fs.writeFileSync(path.join(h.runDir, "vault-check.json"), `${JSON.stringify({ v: 1, check: vault.keyCheck() })}\n`);
      const pass = vault.passphraseFor(h.runDir, id);
      derived.push(pass);
      h.ctx.stubEnv.STUB_PASS_SHA256 = crypto.createHash("sha256").update(pass).digest("hex");
      const ctx = { ...h.ctx, getPassphrase: () => vault.passphraseFor(h.runDir, id) };
      e.prepare(h);
      h.scenario(e.scenario(h));
      const r = await e.run(ctx, h);
      assert.equal(r.code, e.cases[0].expect, `${name}: ${r.stderr}`);
      // the tool did get the vault's passphrase where the step passes one
      for (const c of h.calls("swapCli")) if (c.pass) {
        assert.equal(c.passMatches, true, `${name}: swap-cli got another passphrase than the vault's`);
        proved++;
      }
      assert.ok(!fs.existsSync(path.join(h.runDir, "passphrase.txt")), `${name}: a passphrase file was made`);
      fs.cpSync(h.runDir, path.join(runsDir, id), { recursive: true });
    } finally {
      h.cleanup();
    }
  }
  assert.ok(proved >= 4, "the passphrase really reached the tools in the flow");

  // a board key and the invite secret, sealed per run
  const boardId = crypto.randomBytes(16).toString("hex");
  const boardDir = path.join(runsDir, boardId);
  fs.mkdirSync(boardDir, { recursive: true });
  const ks = new KeyStore(boardDir, { sealer: vault.boardSealer(boardId) });
  const k = ks.newKey();
  ks.setInvite(INVITE);
  await vault.setInviteSecret();
  assert.equal(vault.inviteSecret(), INVITE);

  // an import of an old folder with a clear passphrase and clear board keys
  const old = path.join(tmpDir("no1d-old-"), "old-run");
  fs.mkdirSync(path.join(old, "pub"), { recursive: true });
  fs.copyFileSync(path.join(FIX, "legacy-run", "env.local.sh.fixture"), path.join(old, "env.local.sh"));
  fs.copyFileSync(path.join(FIX, "legacy-run", "alice.swap.json.fixture"), path.join(old, "alice.swap.json"));
  fs.writeFileSync(path.join(old, "passphrase.txt"), `${OLD_PASS}\n`);
  const oldKey = new KeyStore(old).newKey();
  const ui2 = createFakeSecretUi({ askFolder: { "import-run": [old], "import-home": [path.join(FIX, "legacy-home")] } });
  const migrator = createMigrator({ vault, secretUi: ui2, runsDir, home: tmpDir("no1d-home-"), programVersion: "0.1.0", statusOf: async () => "created" });
  const imp = await migrator.importRun();
  assert.equal(imp.ok, true, imp.why);
  assert.equal(vault.passphraseFor(path.join(runsDir, imp.swapId), imp.swapId), OLD_PASS);
  derived.push(derive.passphrase(S, imp.swapId));

  // the scan
  const forbidden = forbiddenFor(S, [...derived, OLD_PASS, k.secret.toString("hex"), oldKey.secret.toString("hex"), INVITE, INVITE.toUpperCase()]);
  const files = filesUnder(dataDir);
  assert.ok(files.length > 20, `scanned ${files.length} files`);
  assert.ok(files.some((f) => f.rel.startsWith("vault/")));
  assert.ok(files.some((f) => f.rel.endsWith("passphrase.sealed")));
  assert.ok(files.some((f) => f.rel.endsWith("board-keys.json")));
  for (const f of files) {
    for (const needle of forbidden) {
      assert.ok(!f.bytes.includes(needle), `${f.rel} holds a secret in clear (${needle.length} bytes, starts ${needle.subarray(0, 4).toString("hex")})`);
    }
  }
  // the original of the import: its clear passphrase is gone, and it is the only place the old board key remains in clear (left as it was)
  assert.ok(!fs.existsSync(path.join(old, "passphrase.txt")));
});

test("the scan itself can fail: a file that holds the secret in clear (any of the forms) is found", async () => {
  const { vault, dataDir, ui } = makeVault();
  await vault.open();
  const S = secretFromShown(ui);
  const forms = { raw: S, hex: Buffer.from(S.toString("hex")), b64: Buffer.from(S.toString("base64")), crockford: Buffer.from(rc.encode(S)), crockfordRaw: Buffer.from(rc.encodeRaw(S)) };
  for (const [name, bytes] of Object.entries(forms)) {
    const f = path.join(dataDir, `leak-${name}.txt`);
    fs.writeFileSync(f, Buffer.concat([Buffer.from("xx"), bytes, Buffer.from("yy")]));
    const hit = filesUnder(dataDir).some((x) => forbiddenFor(S, []).some((n) => x.bytes.includes(n)) && x.rel === `leak-${name}.txt`);
    assert.ok(hit, name);
    fs.rmSync(f);
  }
  // and the vault's own files are clean
  assert.ok(filesUnder(dataDir).every((x) => !forbiddenFor(S, []).some((n) => x.bytes.includes(n))));
});
