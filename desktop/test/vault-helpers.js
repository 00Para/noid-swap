"use strict";
// Shared helpers of the 4.6 tests (not a test file): a temporary data folder, a vault over a fake key store and a scripted secret window, run folders.
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { createVault } = require("../lib/vault");
const { createFakeKeyStore } = require("./fake-keystore");
const { createFakeSecretUi } = require("./fake-secretui");
const rc = require("../lib/recoverycode");

const dirs = [];
function tmpDir(prefix = "no1d-vault-") {
  const d = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  dirs.push(d);
  return d;
}
function cleanupAll() {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
}

/** A vault with its own data folder (or the given one). `uiAnswers` as createFakeSecretUi; the default types the code back correctly. */
function makeVault(o = {}) {
  const dataDir = o.dataDir || tmpDir();
  fs.mkdirSync(path.join(dataDir, "runs"), { recursive: true });
  const keyStore = o.keyStore === undefined ? createFakeKeyStore() : o.keyStore;
  const ui = o.ui || createFakeSecretUi(o.uiAnswers || { autoTypeBack: true });
  const vault = createVault({ dataDir, keyStore, secretUi: ui, ...(o.deps || {}) });
  return { vault, dataDir, keyStore, ui };
}

const hex32 = () => crypto.randomBytes(16).toString("hex");

/** A run folder under <dataDir>/runs with the vault's vault-check.json and a run.json holding the id. Returns { dir, id }. */
function makeRun(dataDir, vault, id = hex32()) {
  const dir = path.join(dataDir, "runs", id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "vault-check.json"), `${JSON.stringify({ v: 1, check: vault.keyCheck() })}\n`);
  fs.writeFileSync(path.join(dir, "run.json"), `${JSON.stringify({ v: 1, run_id: id })}\n`);
  return { dir, id };
}

/** The secret behind the last code shown by the fake window (what the person would have written down). */
function secretFromShown(ui) {
  const shown = ui.of("show").filter((c) => c.arg && c.arg.kind === "recovery-code");
  if (!shown.length) return null;
  return rc.decode(shown[shown.length - 1].arg.groups.join(""));
}
const codeFromShown = (ui) => {
  const shown = ui.of("show").filter((c) => c.arg && c.arg.kind === "recovery-code");
  return shown.length ? shown[shown.length - 1].arg.groups.join("-") : null;
};

/** Every file under a folder, as { rel, bytes }. */
function filesUnder(root) {
  const out = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else out.push({ rel: path.relative(root, p).replace(/\\/g, "/"), bytes: fs.readFileSync(p) });
    }
  };
  if (fs.existsSync(root)) walk(root);
  return out;
}
const sha = (b) => crypto.createHash("sha256").update(b).digest("hex");
/** A map name -> sha256 of every file under a folder (for "nothing changed" checks). */
function snapshot(root) {
  return Object.fromEntries(filesUnder(root).map((f) => [f.rel, sha(f.bytes)]));
}

module.exports = { tmpDir, cleanupAll, makeVault, makeRun, secretFromShown, codeFromShown, filesUnder, snapshot, sha, hex32 };
