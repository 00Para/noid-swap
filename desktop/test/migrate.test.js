"use strict";
// Import of an old run folder (spec 6.8, 6.10 "Import at rest"): the refusals leave the original untouched; a good import seals the passphrase, deletes the
// clear file in the original, seals board keys, appends lock records.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { createMigrator, statusFromSwapCli, parseHashlockLine, ALLOWED_PHASES } = require("../lib/migrate");
const { createFakeSecretUi } = require("./fake-secretui");
const { makeVault, snapshot, filesUnder, tmpDir, cleanupAll, sha } = require("./vault-helpers");
const rs = require("../../ui/app/lib/runsettings");
const { KeyStore } = require("../../ui/app/lib/board/keys");
const { generateSecretKey, getPublicKey } = require("../../ui/app/lib/board/note");

test.after(cleanupAll);

const FIX = path.join(__dirname, "fixtures");
const OLD_PASS = "legacy-test-passphrase-do-not-use-0123456789";
const RENAMES = { "env.local.sh.fixture": "env.local.sh", "legacy-passphrase.fixture": "passphrase.txt", "alice.swap.json.fixture": "alice.swap.json" };

/** Copies the legacy fixture to a new temporary folder under its real names (the fixture names dodge the repository's ignore rules). */
function legacyRun(o = {}) {
  const dir = path.join(tmpDir("no1d-legacy-"), "old-run");
  const copy = (from, to) => {
    fs.mkdirSync(to, { recursive: true });
    for (const e of fs.readdirSync(from, { withFileTypes: true })) {
      if (e.isDirectory()) copy(path.join(from, e.name), path.join(to, e.name));
      else fs.copyFileSync(path.join(from, e.name), path.join(to, RENAMES[e.name] || e.name));
    }
  };
  copy(path.join(FIX, "legacy-run"), dir);
  if (o.swap === false) fs.rmSync(path.join(dir, "alice.swap.json"));
  if (o.passphrase === false) fs.rmSync(path.join(dir, "passphrase.txt"));
  if (o.env) fs.writeFileSync(path.join(dir, "env.local.sh"), o.env(fs.readFileSync(path.join(dir, "env.local.sh"), "utf8")));
  return dir;
}
const bobEnv = (text) => text.replace("UI_ROLE='alice'", "UI_ROLE='bob'").replace(/^NOID_PAYOUT=.*\n/m, "").replace(/^BOB_ETH=.*\n/m, "BOB_ETH=''\n");
function legacyBob() {
  const dir = legacyRun({ swap: false, env: bobEnv });
  fs.mkdirSync(path.join(dir, "bob"));
  fs.writeFileSync(path.join(dir, "bob", "bob.swap.json"), "{}");
  return dir;
}

/** A migrator over a ready vault. `phase` is what the stub of `swap-cli status` answers (a string, or a function of the file). */
async function rig(o = {}) {
  const made = makeVault();
  await made.vault.open();
  const home = tmpDir("no1d-home-");
  const ui = createFakeSecretUi(o.uiAnswers || {});
  const phaseOf = o.phase === undefined ? "created" : o.phase;
  const calls = [];
  const migrator = createMigrator({
    vault: o.vault || made.vault,
    secretUi: ui,
    runsDir: path.join(made.dataDir, "runs"),
    home,
    programVersion: "0.1.0",
    statusOf: async (file) => {
      calls.push(file);
      return typeof phaseOf === "function" ? phaseOf(file) : phaseOf;
    },
    ...(o.deps || {}),
  });
  return { ...made, home, ui, migrator, calls, runs: path.join(made.dataDir, "runs") };
}
const runFolders = (r) => fs.readdirSync(r.runs).filter((n) => /^[0-9a-f]{32}$/.test(n));
const unchanged = async (r, src, answers, why) => {
  const before = snapshot(src);
  const beforeNames = fs.readdirSync(src).sort();
  const res = await r.migrator.importRun();
  assert.equal(res.ok, false, why);
  assert.deepEqual(snapshot(src), before, `${why}: the original changed`);
  assert.deepEqual(fs.readdirSync(src).sort(), beforeNames, `${why}: the original's file list changed`);
  assert.deepEqual(runFolders(r), [], `${why}: a run folder was made`);
  const staging = path.join(r.runs, ".importing");
  assert.deepEqual(fs.existsSync(staging) ? fs.readdirSync(staging) : [], [], `${why}: staging left`);
  return res;
};
const ask = (src, extra = {}) => ({ askFolder: { "import-run": [src], ...(extra.askFolder || {}) }, ...(extra.rest || {}) });

test("a good import: run.json, the set's two files, passphrase.sealed that reads back, no clear passphrase anywhere in the new folder, passphrase.txt gone from the original, a note in it", async () => {
  const src = legacyRun();
  const r = await rig({ uiAnswers: ask(src, { askFolder: { "import-home": [path.join(FIX, "legacy-home")] } }) });
  const before = snapshot(src);
  const res = await r.migrator.importRun();
  assert.equal(res.ok, true, res.why);
  assert.match(res.swapId, /^[0-9a-f]{32}$/);
  assert.equal(res.role, "alice");
  const dir = path.join(r.runs, res.swapId);
  const settings = rs.load(dir);
  assert.equal(settings.run_id, res.swapId);
  assert.equal(settings.role, "alice");
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, "written-by.json"), "utf8")), { v: 1, program_version: "0.1.0" });
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, "vault-check.json"), "utf8")), { v: 1, check: r.vault.keyCheck() });
  // the passphrase: sealed, reads back as the old one, and the clear file is nowhere in the new folder
  assert.equal(r.vault.passphraseFor(dir, res.swapId), OLD_PASS);
  assert.ok(fs.existsSync(path.join(dir, "passphrase.sealed")));
  assert.ok(!fs.existsSync(path.join(dir, "passphrase.txt")));
  for (const f of filesUnder(dir)) assert.ok(!f.bytes.toString("latin1").includes(OLD_PASS), f.rel);
  // the original: passphrase.txt deleted, a note naming the new folder, nothing else changed
  assert.ok(!fs.existsSync(path.join(src, "passphrase.txt")));
  const note = fs.readFileSync(path.join(src, "MOVED-TO-NO1D-SWAP.txt"), "utf8");
  assert.ok(note.includes(res.swapId));
  const after = snapshot(src);
  const expected = { ...before };
  delete expected["passphrase.txt"];
  expected["MOVED-TO-NO1D-SWAP.txt"] = sha(fs.readFileSync(path.join(src, "MOVED-TO-NO1D-SWAP.txt")));
  assert.deepEqual(after, expected);
  // the copy: every file but bin/ and passphrase.txt, byte for byte
  for (const [rel, h] of Object.entries(before)) {
    if (rel === "passphrase.txt" || rel.startsWith("bin/")) continue;
    assert.equal(sha(fs.readFileSync(path.join(dir, rel))), h, rel);
  }
  assert.ok(!fs.existsSync(path.join(dir, "bin")));
  assert.ok(fs.existsSync(path.join(dir, "env.local.sh")), "env.local.sh stays in the copy");
  assert.deepEqual(fs.readdirSync(path.join(r.runs, ".importing")), []);
  // the audit lines: no value
  const audit = fs.readFileSync(path.join(dir, "pub", "ui-audit.jsonl"), "utf8");
  assert.match(audit, /import-copy/);
  assert.match(audit, /import-passphrase/);
  assert.match(audit, /import-lock-records/);
  assert.ok(!audit.includes(OLD_PASS));
  // the window was told
  assert.deepEqual(r.ui.of("say").map((c) => c.arg.kind), ["imported"]);
  assert.deepEqual(res.warnings, []);
});

test("lock records: the lines that match swap-cli's registry pattern are appended without duplicates, the rest are counted; a second import adds nothing", async () => {
  const src = legacyRun();
  const r = await rig({ uiAnswers: ask(src, { askFolder: { "import-home": [path.join(FIX, "legacy-home"), path.join(FIX, "legacy-home")] } }) });
  fs.mkdirSync(path.join(r.home, ".noid-swap"), { recursive: true });
  fs.writeFileSync(path.join(r.home, ".noid-swap", "hashlocks.txt"), `${"1".repeat(64)} alice`); // an existing line without a final newline
  const res = await r.migrator.importRun();
  assert.equal(res.ok, true, res.why);
  assert.deepEqual(res.lockRecords, { state: "imported", imported: 4, already_there: 1, not_matching: 3 });
  const lines = fs.readFileSync(path.join(r.home, ".noid-swap", "hashlocks.txt"), "utf8").split("\n");
  assert.deepEqual(lines, [`${"1".repeat(64)} alice`, `${"0".repeat(62)}aa alice`, `${"0".repeat(62)}bb bob`, `${"0".repeat(62)}cc`, `${"0".repeat(62)}dd alice`, ""]);
  const info = JSON.parse(fs.readFileSync(path.join(r.runs, res.swapId, "import.json"), "utf8"));
  assert.deepEqual(info, { v: 1, lock_records: "imported", imported: 4, already_there: 1, not_matching: 3 });
  assert.equal(r.ui.of("say")[0].arg.count, 4);
  // the same records again: nothing is added
  const again = r.migrator.importLockRecords(path.join(FIX, "legacy-home"));
  assert.deepEqual(again, { imported: 0, already_there: 5, not_matching: 3 });
  assert.equal(fs.readFileSync(path.join(r.home, ".noid-swap", "hashlocks.txt"), "utf8").split("\n").length, 6);
});

test("lock records, cancelled: the swap is imported anyway and the folder says the old lock records were not imported", async () => {
  const src = legacyRun();
  const r = await rig({ uiAnswers: ask(src) }); // the import-home question gets no answer
  const res = await r.migrator.importRun();
  assert.equal(res.ok, true);
  assert.equal(res.lockRecords.state, "not_imported");
  assert.equal(JSON.parse(fs.readFileSync(path.join(r.runs, res.swapId, "import.json"), "utf8")).lock_records, "not_imported");
  assert.ok(!fs.existsSync(path.join(r.home, ".noid-swap", "hashlocks.txt")));
  assert.equal(r.ui.of("say")[0].arg.lockRecords, "not_imported");
});

test("the hashlock line pattern is swap-cli's: 64 lower-case hex, an optional alice or bob, then an ignored third field", () => {
  const h = "ab".repeat(32);
  assert.deepEqual(parseHashlockLine(h), { hashlock: h, role: null });
  assert.deepEqual(parseHashlockLine(`${h} alice`), { hashlock: h, role: "alice" });
  assert.deepEqual(parseHashlockLine(`${h}\tbob\r`), { hashlock: h, role: "bob" });
  assert.deepEqual(parseHashlockLine(`${h} alice 2026-01-01`), { hashlock: h, role: "alice" });
  for (const bad of ["", h.toUpperCase(), h.slice(1), `${h}0`, `${h} carol`, `${h} 12`, `x ${h}`, "ab".repeat(33)]) assert.equal(parseHashlockLine(bad), null, bad);
});

test("board keys: a plain board-keys.json in the old folder is sealed in the copy and still opens with the run's sealer; without one it is refused", async () => {
  const src = legacyRun();
  const plain = new KeyStore(src);
  const k = plain.newKey();
  const original = fs.readFileSync(path.join(src, "board-keys.json"), "utf8");
  assert.ok(original.includes(k.secret.toString("hex")));
  const r = await rig({ uiAnswers: ask(src) });
  const res = await r.migrator.importRun();
  assert.equal(res.ok, true, res.why);
  const dir = path.join(r.runs, res.swapId);
  const text = fs.readFileSync(path.join(dir, "board-keys.json"), "utf8");
  assert.ok(!text.includes(k.secret.toString("hex")) && !text.includes(k.pub), "no key in clear in the copy");
  assert.equal(JSON.parse(text).label, "board");
  const ks = new KeyStore(dir, { sealer: r.vault.boardSealer(res.swapId) });
  assert.ok(ks.has(k.pub));
  assert.ok(ks.secretFor(k.pub).equals(k.secret));
  assert.throws(() => new KeyStore(dir), /sealed by the program/);
  assert.equal(fs.readFileSync(path.join(src, "board-keys.json"), "utf8"), original, "the original's board keys are left as they were");
});

test("the role comes from the swap file; Bob's folder imports as Bob", async () => {
  const src = legacyBob();
  const r = await rig({ phase: "received", uiAnswers: ask(src) });
  const res = await r.migrator.importRun();
  assert.equal(res.ok, true, res.why);
  assert.equal(res.role, "bob");
  assert.equal(rs.load(path.join(r.runs, res.swapId)).role, "bob");
  assert.deepEqual(r.calls, [path.join(src, "bob", "bob.swap.json")]);
});

test("the phases that count as at rest are the spec's, for each role; every one imports, every other phase is refused", async () => {
  assert.deepEqual([...ALLOWED_PHASES.alice], ["created", "done", "refunded", "lost", "aborted"]);
  assert.deepEqual([...ALLOWED_PHASES.bob], ["received", "done", "refunded", "aborted"]);
  const others = ["funding_submitted", "funded", "funding_final", "lock_seen", "lock_final", "reveal_submitted", "revealed", "refund_submitted", "refund_included", "weird", ""];
  for (const phase of ALLOWED_PHASES.alice) {
    const src = legacyRun();
    const r = await rig({ phase, uiAnswers: ask(src) });
    assert.equal((await r.migrator.importRun()).ok, true, `alice ${phase}`);
  }
  for (const phase of ALLOWED_PHASES.bob) {
    const src = legacyBob();
    const r = await rig({ phase, uiAnswers: ask(src) });
    assert.equal((await r.migrator.importRun()).ok, true, `bob ${phase}`);
  }
  for (const phase of [...others, "received", "lock_submitted", "locked", "secret_seen", "claim_submitted", "claim_included"]) {
    if (ALLOWED_PHASES.alice.includes(phase)) continue;
    const src = legacyRun();
    const r = await rig({ phase, uiAnswers: ask(src) });
    const res = await unchanged(r, src, null, `alice ${phase}`);
    assert.match(res.why, /not at rest|could not be read/, phase);
  }
  for (const phase of ["created", "funded", "lock_submitted", "locked", "claim_submitted", "lost", "weird"]) {
    if (ALLOWED_PHASES.bob.includes(phase)) continue;
    const src = legacyBob();
    const r = await rig({ phase, uiAnswers: ask(src) });
    await unchanged(r, src, null, `bob ${phase}`);
  }
});

test("each refusal at rest leaves the original exactly as it was (sha256 of every file and the file list before and after)", async () => {
  const cases = [];
  // the phase cannot be read, throws, or is not a string
  cases.push(["status unreadable", legacyRun(), { phase: null }]);
  cases.push(["status throws", legacyRun(), { phase: () => { throw new Error("tool missing"); } }]);
  // both roles' swap files
  const both = legacyRun();
  fs.mkdirSync(path.join(both, "bob"));
  fs.writeFileSync(path.join(both, "bob", "bob.swap.json"), "{}");
  cases.push(["both swap files", both, {}]);
  // a swap file with no passphrase.txt beside it
  cases.push(["swap file without its passphrase", legacyRun({ passphrase: false }), {}]);
  // a console that runs
  const live = legacyRun();
  fs.writeFileSync(path.join(live, "ui-console.lock"), `${JSON.stringify({ pid: 4242, started: "2026-11-18T00:00:00Z", role: "alice" })}\n`);
  cases.push(["a console is running", live, { deps: { isAlive: () => true } }]);
  const garbled = legacyRun();
  fs.writeFileSync(path.join(garbled, "ui-console.lock"), "not json");
  cases.push(["a lock that cannot be read", garbled, {}]);
  // a loop that wrote a moment ago
  const loop = legacyRun();
  fs.writeFileSync(path.join(loop, "loop-alice.txt"), "tick\n");
  cases.push(["a loop wrote just now", loop, {}]);
  const loopPub = legacyRun();
  fs.writeFileSync(path.join(loopPub, "pub", "loop-bob.txt"), "tick\n");
  cases.push(["a loop wrote just now (pub)", loopPub, {}]);
  // a run.json already there, a note already there
  const hasRunJson = legacyRun();
  fs.writeFileSync(path.join(hasRunJson, "run.json"), "{}");
  cases.push(["run.json exists", hasRunJson, {}]);
  const moved = legacyRun();
  fs.writeFileSync(path.join(moved, "MOVED-TO-NO1D-SWAP.txt"), "x");
  cases.push(["already imported", moved, {}]);
  // env.local.sh: missing, not a wallet run, sha256 lock, production, role disagreement, a line it cannot read
  const noEnv = legacyRun();
  fs.rmSync(path.join(noEnv, "env.local.sh"));
  cases.push(["no env.local.sh", noEnv, {}]);
  cases.push(["not a wallet run", legacyRun({ env: (t) => t.replace("USE_SWAP_WALLET='1'", "USE_SWAP_WALLET='0'") }), {}]);
  cases.push(["sha256 lock kind", legacyRun({ env: (t) => t.replace("LOCK_KIND='poseidon'", "LOCK_KIND='sha256'") }), {}]);
  cases.push(["production", legacyRun({ env: (t) => t.replace("PROFILE='sepolia'", "PROFILE='production'") }), {}]);
  cases.push(["mainnet chain", legacyRun({ env: (t) => t.replace("CHAIN='11155111'", "CHAIN='1'") }), {}]);
  cases.push(["role disagrees with the swap file", legacyRun({ env: (t) => t.replace("UI_ROLE='alice'", "UI_ROLE='bob'") }), {}]);
  cases.push(["a setting run.json does not carry", legacyRun({ env: (t) => `${t}SOME_OTHER_SETTING='x'\n` }), {}]);
  cases.push(["a swap file that is a folder", (() => { const d = legacyRun(); fs.rmSync(path.join(d, "alice.swap.json")); fs.mkdirSync(path.join(d, "alice.swap.json")); return d; })(), {}]);
  const bigEnv = legacyRun();
  fs.writeFileSync(path.join(bigEnv, "env.local.sh"), "#".repeat(70000));
  cases.push(["env.local.sh too large", bigEnv, {}]);
  // a passphrase.txt that is empty
  const emptyPass = legacyRun();
  fs.writeFileSync(path.join(emptyPass, "passphrase.txt"), "\n");
  cases.push(["empty passphrase file", emptyPass, {}]);
  // a board key file that does not read
  const badKeys = legacyRun();
  fs.writeFileSync(path.join(badKeys, "board-keys.json"), "{not json");
  cases.push(["unreadable board keys", badKeys, {}]);
  for (const [why, src, o] of cases) {
    const r = await rig({ ...o, uiAnswers: ask(src) });
    const res = await unchanged(r, src, null, why);
    assert.equal(typeof res.why, "string", why);
    assert.deepEqual(r.ui.of("say").map((c) => c.arg.kind), ["not-imported"], why);
    assert.ok(!JSON.stringify(r.ui.calls).includes(OLD_PASS), `${why}: the passphrase went to the window`);
  }
});

test("a stale console lock is fine and is not copied; a loop file older than five minutes is fine; bin/ is never copied", async () => {
  const src = legacyRun();
  fs.writeFileSync(path.join(src, "ui-console.lock"), `${JSON.stringify({ pid: 4242, started: "2026-11-18T00:00:00Z", role: "alice" })}\n`);
  fs.writeFileSync(path.join(src, "loop-alice.txt"), "tick\n");
  const t = new Date(Date.now() - 10 * 60 * 1000);
  fs.utimesSync(path.join(src, "loop-alice.txt"), t, t);
  const r = await rig({ deps: { isAlive: () => false }, uiAnswers: ask(src) });
  const res = await r.migrator.importRun();
  assert.equal(res.ok, true, res.why);
  const dir = path.join(r.runs, res.swapId);
  assert.ok(!fs.existsSync(path.join(dir, "ui-console.lock")));
  assert.ok(fs.existsSync(path.join(dir, "loop-alice.txt")));
  assert.ok(!fs.existsSync(path.join(dir, "bin")));
});

test("a loop file that changed 4 minutes ago is refused and one that changed 6 minutes ago is not (the clock is injectable)", async () => {
  for (const [minutes, ok] of [[4, false], [6, true]]) {
    const src = legacyRun();
    fs.writeFileSync(path.join(src, "loop-alice.txt"), "tick\n");
    const t = new Date(Date.now() - minutes * 60 * 1000);
    fs.utimesSync(path.join(src, "loop-alice.txt"), t, t);
    const r = await rig({ uiAnswers: ask(src) });
    assert.equal((await r.migrator.importRun()).ok, ok, `${minutes} minutes`);
  }
});

test("the folder must be a plain folder outside the runs folder; a relative path and a file are refused; a cancelled dialog changes nothing", async () => {
  const r = await rig({ uiAnswers: { askFolder: { "import-run": [path.join(tmpDir(), "nothing-here"), "relative/path", r2file(), null] } } });
  function r2file() {
    const f = path.join(tmpDir(), "afile");
    fs.writeFileSync(f, "x");
    return f;
  }
  assert.equal((await r.migrator.importRun()).ok, false);
  assert.equal((await r.migrator.importRun()).ok, false);
  assert.equal((await r.migrator.importRun()).ok, false);
  const c = await r.migrator.importRun();
  assert.deepEqual([c.ok, c.cancelled], [false, true]);
  assert.deepEqual(runFolders(r), []);
  // a folder inside the program's own runs folder
  const inside = await rig({});
  const sub = path.join(inside.runs, "0123456789abcdef0123456789abcdef");
  fs.mkdirSync(sub, { recursive: true });
  const again = createMigrator({ vault: inside.vault, secretUi: createFakeSecretUi({ askFolder: { "import-run": [sub, inside.runs] } }), runsDir: inside.runs, home: inside.home, programVersion: "0.1.0", statusOf: async () => "created" });
  assert.match((await again.importRun()).why, /already inside/);
  assert.match((await again.importRun()).why, /already inside/);
});

test("a link inside the folder is refused (no link is ever followed), when the system lets a test make one", async (t) => {
  const src = legacyRun();
  try {
    fs.symlinkSync(path.join(src, "env.local.sh"), path.join(src, "pub", "link"));
  } catch {
    t.skip("this user may not make links");
    return;
  }
  const r = await rig({ uiAnswers: ask(src) });
  const res = await unchanged(r, src, null, "a link");
  assert.match(res.why, /link/);
});

test("a passphrase that does not read back keeps passphrase.txt and removes the copy; so does a vault that fails to seal", async () => {
  for (const mode of ["readback", "seal"]) {
    const src = legacyRun();
    const made = makeVault();
    await made.vault.open();
    const wrapped = {
      ...made.vault,
      passphraseFor: mode === "readback" ? () => "a different passphrase" : made.vault.passphraseFor,
      writeMigratedPassphrase: mode === "seal" ? () => { throw new Error("seal failed"); } : made.vault.writeMigratedPassphrase,
    };
    const r = await rig({ vault: wrapped, uiAnswers: ask(src) });
    const before = snapshot(src);
    const res = await r.migrator.importRun();
    assert.equal(res.ok, false, mode);
    assert.deepEqual(snapshot(src), before);
    assert.ok(fs.existsSync(path.join(src, "passphrase.txt")));
    assert.deepEqual(runFolders(r), []);
    assert.deepEqual(fs.readdirSync(path.join(r.runs, ".importing")), []);
  }
});

test("when the old passphrase.txt cannot be deleted the new folder is removed again and nothing is lost", async () => {
  const src = legacyRun();
  const io = { ...fs, unlinkSync: (p) => { if (String(p).endsWith("passphrase.txt")) throw Object.assign(new Error("EPERM"), { code: "EPERM" }); return fs.unlinkSync(p); } };
  const r = await rig({ deps: { fs: io }, uiAnswers: ask(src) });
  const before = snapshot(src);
  const res = await r.migrator.importRun();
  assert.equal(res.ok, false);
  assert.match(res.why, /could not be deleted/);
  assert.deepEqual(snapshot(src), before);
  assert.deepEqual(runFolders(r), []);
});

test("a note that cannot be written is a warning, not a failure; the import is complete", async () => {
  const src = legacyRun();
  const io = { ...fs, writeFileSync: (p, ...a) => { if (String(p).endsWith("MOVED-TO-NO1D-SWAP.txt")) throw new Error("no"); return fs.writeFileSync(p, ...a); } };
  const r = await rig({ deps: { fs: io }, uiAnswers: ask(src) });
  const res = await r.migrator.importRun();
  assert.equal(res.ok, true);
  assert.match(res.warnings.join(" "), /MOVED-TO-NO1D-SWAP/);
  assert.ok(!fs.existsSync(path.join(src, "passphrase.txt")));
});

test("a file that does not copy exactly stops the import and leaves the original alone", async () => {
  const src = legacyRun();
  const io = { ...fs, copyFileSync: (a, b, f) => { fs.copyFileSync(a, b, f); if (String(a).endsWith("note.txt")) fs.writeFileSync(b, "corrupt"); } };
  const r = await rig({ deps: { fs: io }, uiAnswers: ask(src) });
  const before = snapshot(src);
  const res = await r.migrator.importRun();
  assert.equal(res.ok, false);
  assert.match(res.why, /did not copy exactly/);
  assert.deepEqual(snapshot(src), before);
  assert.deepEqual(runFolders(r), []);
});

test("a folder with no swap file and no UI_ROLE needs the role: asked in the window when it can, refused when it cannot or the answer is not a role", async () => {
  const noRole = (t) => t.replace(/^UI_ROLE=.*\n/m, "");
  const asked = legacyRun({ swap: false, passphrase: false, env: noRole });
  const r = await rig({ uiAnswers: { ...ask(asked), askChoice: { "import-role": ["alice"] } } });
  const res = await r.migrator.importRun();
  assert.equal(res.ok, true, res.why);
  assert.deepEqual(r.ui.of("askChoice")[0].arg, { kind: "import-role", options: ["alice", "bob"] });
  assert.equal(res.role, "alice");
  for (const answer of [null, "carol"]) {
    const src = legacyRun({ swap: false, passphrase: false, env: noRole });
    const x = await rig({ uiAnswers: { ...ask(src), askChoice: { "import-role": [answer] } } });
    await unchanged(x, src, null, `answer ${answer}`);
  }
  // a window with no way to ask
  const src = legacyRun({ swap: false, passphrase: false, env: noRole });
  const noAsk = await rig({ uiAnswers: ask(src) });
  delete noAsk.ui.askChoice;
  await unchanged(noAsk, src, null, "no askChoice");
});

test("no swap file and no passphrase.txt: it imports, and the new folder uses the derived passphrase", async () => {
  const src = legacyRun({ swap: false, passphrase: false });
  const r = await rig({ uiAnswers: ask(src) });
  const res = await r.migrator.importRun();
  assert.equal(res.ok, true, res.why);
  const dir = path.join(r.runs, res.swapId);
  assert.ok(!fs.existsSync(path.join(dir, "passphrase.sealed")));
  assert.match(r.vault.passphraseFor(dir, res.swapId), /^[0-9a-f]{64}$/);
  assert.deepEqual(r.calls, [], "no swap file: swap-cli status was not asked");
  assert.ok(fs.existsSync(path.join(src, "MOVED-TO-NO1D-SWAP.txt")), "the note is written even when there was no passphrase to move");
});

test("a vault that does not allow a new swap (recovery code not confirmed, or not ready) refuses the import before the folder is asked", async () => {
  const ui = createFakeSecretUi({ askGroups: [null] });
  const made = makeVault({ ui });
  assert.equal((await made.vault.open()).state, "needs_confirm");
  const src = legacyRun();
  const m = createMigrator({ vault: made.vault, secretUi: createFakeSecretUi(ask(src)), runsDir: path.join(made.dataDir, "runs"), home: tmpDir(), programVersion: "0.1.0", statusOf: async () => "created" });
  const res = await m.importRun();
  assert.equal(res.ok, false);
  assert.match(res.why, /recovery code/);
  assert.ok(fs.existsSync(path.join(src, "passphrase.txt")));
});

test("two imports at once: the second is refused while the first runs", async () => {
  const src = legacyRun();
  const r = await rig({ uiAnswers: ask(src) });
  const [a, b] = await Promise.all([r.migrator.importRun(), r.migrator.importRun()]);
  assert.equal([a, b].filter((x) => x.ok).length, 1);
  assert.equal([a, b].filter((x) => !x.ok && /already running/.test(x.why)).length, 1);
});

test("two imports of two folders make two run folders with two ids", async () => {
  const s1 = legacyRun();
  const s2 = legacyRun();
  const r = await rig({ uiAnswers: { askFolder: { "import-run": [s1, s2] } } });
  const a = await r.migrator.importRun();
  const b = await r.migrator.importRun();
  assert.ok(a.ok && b.ok);
  assert.notEqual(a.swapId, b.swapId);
  assert.equal(runFolders(r).length, 2);
});

test("statusFromSwapCli runs the tool with an argument vector and no shell, no passphrase, and reads the phase; anything else is null", async () => {
  const dir = tmpDir("no1d-statusstub-");
  const stub = path.join(dir, "stub.js");
  fs.writeFileSync(
    stub,
    `const fs=require("fs");fs.writeFileSync(require("path").join(__dirname,"out.json"),JSON.stringify({argv:process.argv.slice(2),pass:process.env.SWAP_PASSPHRASE||null,env:Object.keys(process.env)}));` +
      `const f=process.argv[process.argv.length-1];if(f.endsWith("bad.json")){console.log("not json");}else if(f.endsWith("fail.json")){process.exit(1);}else console.log(JSON.stringify({phase:"created"}));\n`,
  );
  const out = path.join(dir, "out.json");
  {
    const statusOf = statusFromSwapCli([process.execPath, stub], { env: { ...process.env, SWAP_PASSPHRASE: "must-not-pass" } });
    assert.equal(await statusOf(path.join(dir, "a.json")), "created");
    const seen = JSON.parse(fs.readFileSync(out, "utf8"));
    assert.deepEqual(seen.argv, ["status", path.join(dir, "a.json")]);
    assert.equal(seen.pass, null);
    assert.ok(!seen.env.includes("SWAP_PASSPHRASE"));
    assert.equal(await statusOf(path.join(dir, "bad.json")), null);
    assert.equal(await statusOf(path.join(dir, "fail.json")), null);
    assert.equal(await createMigratorlessStatus([path.join(dir, "no-such-tool")])(path.join(dir, "a.json")), null);
  }
  function createMigratorlessStatus(argv) {
    return statusFromSwapCli(argv, {});
  }
});

test("the migrator is built from absolute folders only and needs a vault and a window", () => {
  const ok = { vault: {}, secretUi: {}, runsDir: path.join(os.tmpdir(), "x"), home: os.tmpdir() };
  assert.doesNotThrow(() => createMigrator(ok));
  assert.throws(() => createMigrator({ ...ok, runsDir: "runs" }));
  assert.throws(() => createMigrator({ ...ok, home: "home" }));
  assert.throws(() => createMigrator({ ...ok, vault: null }));
  assert.throws(() => createMigrator({ ...ok, secretUi: null }));
  void crypto;
  void generateSecretKey;
  void getPublicKey;
});

test("MF3: a passphrase.txt with a carriage return, a NUL or bytes that are not UTF-8 is refused and the original is untouched; the message says why", async () => {
  const cases = [
    ["a Windows line end", Buffer.from("hand-made-passphrase-1\r\n"), /carriage return/],
    ["a lone carriage return inside", Buffer.from("hand\rmade-passphrase\n"), /carriage return/],
    ["a NUL", Buffer.from("hand\0made-passphrase\n"), /NUL/],
    ["not UTF-8", Buffer.from([0x70, 0x61, 0x73, 0x73, 0xff, 0xfe, 0x70, 0x61, 0x73, 0x73, 0x77, 0x6f, 0x72, 0x64, 0x31, 0x32]), /not valid UTF-8/],
  ];
  for (const [why, bytes, re] of cases) {
    const src = legacyRun();
    fs.writeFileSync(path.join(src, "passphrase.txt"), bytes);
    const r = await rig({ uiAnswers: ask(src) });
    const res = await unchanged(r, src, null, why);
    assert.match(res.why, re, why);
    assert.ok(fs.existsSync(path.join(src, "passphrase.txt")), `${why}: passphrase.txt is still there`);
  }
});

test("MF3: only trailing newlines are removed, as $(cat passphrase.txt) did: spaces and a tab at the end stay, and the sealed value is exactly what swap-cli would have been given", async () => {
  for (const [file, want] of [["spaced passphrase 12  \n\n", "spaced passphrase 12  "], ["tabbed-passphrase-12\t\n", "tabbed-passphrase-12\t"], ["plain-passphrase-no-newline", "plain-passphrase-no-newline"], ["ünïcode-päss-12\n", "ünïcode-päss-12"]]) {
    const src = legacyRun();
    fs.writeFileSync(path.join(src, "passphrase.txt"), file);
    const r = await rig({ uiAnswers: ask(src) });
    const res = await r.migrator.importRun();
    assert.equal(res.ok, true, res.why);
    const got = r.vault.passphraseFor(path.join(r.runs, res.swapId), res.swapId);
    assert.equal(Buffer.from(got).toString("hex"), Buffer.from(want).toString("hex"));
  }
});

test("LOW 12: when the system reports an error but the old passphrase.txt is already gone, the new folder (the only copy) is kept and a warning says so", async () => {
  const src = legacyRun();
  const io = { ...fs, unlinkSync: (p) => { if (String(p).endsWith("passphrase.txt")) { fs.unlinkSync(p); throw Object.assign(new Error("EIO"), { code: "EIO" }); } return fs.unlinkSync(p); } };
  const r = await rig({ deps: { fs: io }, uiAnswers: ask(src) });
  const res = await r.migrator.importRun();
  assert.equal(res.ok, true, res.why);
  assert.match(res.warnings.join(" "), /only one/);
  assert.equal(r.vault.passphraseFor(path.join(r.runs, res.swapId), res.swapId), OLD_PASS);
});
