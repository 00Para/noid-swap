"use strict";
// The by-hand tool (spec 6.3): the code on stdin only, the secret or a run folder's passphrase on stdout, the vectors of Appendix A.
const test = require("node:test");
const assert = require("node:assert/strict");
const childProcess = require("child_process");
const fs = require("fs");
const path = require("path");
const { main } = require("../tools/recovery");
const derive = require("../lib/derive");
const rc = require("../lib/recoverycode");
const sealed = require("../lib/sealed");
const backupfile = require("../lib/backupfile");
const { tmpDir, cleanupAll } = require("./vault-helpers");

test.after(cleanupAll);

const S = Buffer.from([...Array(32).keys()]);
const R = "0123456789abcdef0123456789abcdef";
const CODE = rc.encode(S);
const TOOL = path.join(__dirname, "..", "tools", "recovery.js");

function run(argv, stdin) {
  const out = [];
  const err = [];
  const code = main(argv, { stdin: () => stdin, stdout: (t) => out.push(t), stderr: (t) => err.push(t) });
  return { code, out, err };
}
function runDir(files = {}) {
  const d = tmpDir("no1d-recovery-");
  fs.writeFileSync(path.join(d, "run.json"), `${JSON.stringify({ v: 1, run_id: R })}\n`);
  fs.writeFileSync(path.join(d, "vault-check.json"), `${JSON.stringify({ v: 1, check: derive.keyCheck(S) })}\n`);
  for (const [n, t] of Object.entries(files)) fs.writeFileSync(path.join(d, n), t);
  return d;
}

test("secret: the code on stdin gives the 64-hex secret of Appendix A", () => {
  const r = run(["secret"], `${CODE}\n`);
  assert.deepEqual([r.code, r.out, r.err], [0, [S.toString("hex")], []]);
  assert.equal(run(["secret"], CODE.toLowerCase().replace(/-/g, " ")).out[0], S.toString("hex"));
});

test("passphrase: a run folder's derived passphrase is the vector's; the run id comes from run.json", () => {
  const r = run(["passphrase", runDir()], CODE);
  assert.deepEqual([r.code, r.out], [0, ["1390979abfa070d153819225d0f04fe3dba89cd5c662d7bdb845ed2b534fe8b1"]]);
});

test("passphrase: a folder with passphrase.sealed gives the old (migrated) passphrase", () => {
  const key = derive.migratedKey(S, R);
  const d = runDir();
  sealed.writeSealedFile(path.join(d, "passphrase.sealed"), { key, label: "migrated-passphrase", runId: R, plain: Buffer.from("the-old-one") });
  assert.deepEqual(run(["passphrase", d], CODE).out, ["the-old-one"]);
  // a tampered one is refused and prints nothing
  const f = path.join(d, "passphrase.sealed");
  const o = JSON.parse(fs.readFileSync(f, "utf8"));
  fs.writeFileSync(f, JSON.stringify({ ...o, tag: (o.tag[0] === "0" ? "1" : "0") + o.tag.slice(1) }));
  const bad = run(["passphrase", d], CODE);
  assert.deepEqual([bad.code, bad.out], [1, []]);
});

test("passphrase: the code of another installation is refused (vault-check.json), nothing is printed; a folder without one is allowed with a note", () => {
  const other = Buffer.from(S);
  other[0] ^= 1;
  const r = run(["passphrase", runDir()], rc.encode(other));
  assert.deepEqual([r.code, r.out], [1, []]);
  assert.match(r.err.join(" "), /not the one of that run folder/);
  const d = runDir();
  fs.rmSync(path.join(d, "vault-check.json"));
  const ok = run(["passphrase", d], CODE);
  assert.equal(ok.code, 0);
  assert.equal(ok.out.length, 1);
  assert.match(ok.err.join(" "), /no vault-check\.json/);
});

test("errors: a wrong code, a missing run.json, a bad run id, no argument, an unknown command, a code given as an argument; none prints a secret", () => {
  const bad = run(["secret"], CODE.replace("20G3", "20G4"));
  assert.deepEqual([bad.code, bad.out], [1, []]);
  for (const [argv, stdin] of [[[], CODE], [["other"], CODE], [["secret", CODE], ""], [["passphrase"], CODE], [["passphrase", "a", "b"], CODE]]) {
    const r = run(argv, stdin);
    assert.equal(r.code, 2, JSON.stringify(argv));
    assert.deepEqual(r.out, []);
  }
  const empty = tmpDir("no1d-recovery-");
  assert.equal(run(["passphrase", empty], CODE).code, 1);
  fs.writeFileSync(path.join(empty, "run.json"), JSON.stringify({ run_id: "../x" }));
  assert.equal(run(["passphrase", empty], CODE).code, 1);
  for (const r of [bad, run(["secret"], "")]) assert.ok(!r.err.join(" ").includes(S.toString("hex")) && !r.err.join(" ").includes(CODE));
});

test("a real process: reads the code on stdin only, prints the vectors; the code is never in its own argument vector", () => {
  const sec = childProcess.spawnSync(process.execPath, [TOOL, "secret"], { input: `${CODE}\n`, encoding: "utf8" });
  assert.equal(sec.status, 0, sec.stderr);
  assert.equal(sec.stdout.trim(), S.toString("hex"));
  const d = runDir();
  const pp = childProcess.spawnSync(process.execPath, [TOOL, "passphrase", d], { input: CODE, encoding: "utf8" });
  assert.equal(pp.status, 0, pp.stderr);
  assert.equal(pp.stdout.trim(), "1390979abfa070d153819225d0f04fe3dba89cd5c662d7bdb845ed2b534fe8b1");
  // the by-hand recipe of the spec: the secret from the tool into openssl gives the same passphrase
  let ssl = null;
  try {
    ssl = childProcess.execFileSync("openssl", ["dgst", "-sha256", "-mac", "HMAC", "-macopt", `hexkey:${sec.stdout.trim()}`], { input: `no1d-swap/v1/swap-passphrase/${R}`, encoding: "utf8", stdio: ["pipe", "pipe", "ignore"] });
  } catch {
    ssl = null;
  }
  if (ssl !== null) assert.equal(ssl.trim().split(/\s+/).pop(), pp.stdout.trim());
  const bad = childProcess.spawnSync(process.execPath, [TOOL, "secret"], { input: "nonsense", encoding: "utf8" });
  assert.equal(bad.status, 1);
  assert.equal(bad.stdout, "");
});

test("T-D5 + audit L-4: backup-open writes restored.json; round trip, mode 0600, vault-check.json enables passphrase, refuses existing outdir, wrong code, damaged file, and code on argv", () => {
  const work = tmpDir("no1d-bopen-");
  const HASHLOCK = "a".repeat(64);
  const runBytes = Buffer.from(`${JSON.stringify({ v: 1, run_id: R, role: "bob", profile: "sepolia", chain_id: 11155111 })}\n`);
  const swapBytes = Buffer.from('{"role":"bob","profile":"sepolia","canary":"SUPER-SECRET-CANARY"}\n');
  const lockBytes = Buffer.from('{"tx":"0x11"}\n');
  const lockRel = `lock-sent/11155111-${"2".repeat(40)}-${HASHLOCK}.json`;
  const plain = backupfile.buildPlain({
    madeBy: "0.1.8",
    madeAt: "2026-11-25T12:00:00Z",
    seq: 3,
    runId: R,
    role: "bob",
    profile: "sepolia",
    chainId: 11155111,
    phase: "locked",
    safetyDigest: "b".repeat(64),
    registry: { hashlock: HASHLOCK, role: "bob" },
    files: [
      { path: "run.json", bytes: runBytes },
      { path: "bob/bob.swap.json", bytes: swapBytes },
    ],
    home: [{ path: lockRel, bytes: lockBytes }],
  });
  const key = derive.backupKey(S, R);
  const env = sealed.seal({ key, label: "swap-backup", runId: R, fileName: "swap-backup", plain });
  key.fill(0);
  const outerBuf = Buffer.from(backupfile.formatOuter({ runId: R, sealedEnvelope: env }), "utf8");
  const backupPath = path.join(work, "swap.no1dbackup");
  fs.writeFileSync(backupPath, outerBuf);

  // 1. Refuses extra argv (e.g. code passed on command line) or missing outdir
  assert.equal(run(["backup-open", backupPath, path.join(work, "o1"), CODE], "").code, 2);
  assert.equal(run(["backup-open", backupPath], CODE).code, 2);

  // 2. Refuses an existing output folder without touching it
  const existing = path.join(work, "already");
  fs.mkdirSync(existing);
  fs.writeFileSync(path.join(existing, "keep.txt"), "stay");
  const rExist = run(["backup-open", backupPath, existing], CODE);
  assert.equal(rExist.code, 1);
  assert.match(rExist.err.join(" "), /already exists/);
  assert.equal(fs.readFileSync(path.join(existing, "keep.txt"), "utf8"), "stay");

  // 3. Wrong code is refused and creates no output folder
  const other = Buffer.from(S);
  other[0] ^= 0xff;
  const outWrong = path.join(work, "out-wrong");
  const rWrong = run(["backup-open", backupPath, outWrong], rc.encode(other));
  assert.equal(rWrong.code, 1);
  assert.equal(fs.existsSync(outWrong), false);
  assert.equal(rWrong.out.length, 0);

  // 4. Damaged file is refused and creates no output folder
  const dmgPath = path.join(work, "damaged.no1dbackup");
  const dmgBuf = Buffer.from(outerBuf);
  dmgBuf[dmgBuf.length - 10] ^= 0x01;
  fs.writeFileSync(dmgPath, dmgBuf);
  const outDmg = path.join(work, "out-dmg");
  assert.equal(run(["backup-open", dmgPath, outDmg], CODE).code, 1);
  assert.equal(fs.existsSync(outDmg), false);

  // 5. Real subprocess round trip: reads code on stdin only, writes 0600 files + vault-check.json, prints zero secrets
  const outDir = path.join(work, "opened");
  const proc = childProcess.spawnSync(process.execPath, [TOOL, "backup-open", backupPath, outDir], { input: `${CODE}\n`, encoding: "utf8" });
  assert.equal(proc.status, 0, proc.stderr);
  assert.match(proc.stdout, new RegExp(`opened ${R}`));
  assert.equal(proc.stdout.includes("SUPER-SECRET-CANARY"), false, "no secret leaked to stdout");
  assert.equal(proc.stdout.includes(S.toString("hex")), false, "no install secret in stdout");
  assert.equal(proc.stderr.includes(CODE), false, "no recovery code in stderr");
  assert.deepEqual(fs.readFileSync(path.join(outDir, "run.json")), runBytes);
  assert.deepEqual(fs.readFileSync(path.join(outDir, "bob", "bob.swap.json")), swapBytes);
  assert.deepEqual(fs.readFileSync(path.join(outDir, "home", ...lockRel.split("/"))), lockBytes);
  assert.equal(JSON.parse(fs.readFileSync(path.join(outDir, "vault-check.json"), "utf8")).check, derive.keyCheck(S));
  // audit of 0.2.0, L-4: the by-hand route writes the restore marker, so the restore gates apply to a folder moved into runs/
  const marker = JSON.parse(fs.readFileSync(path.join(outDir, "restored.json"), "utf8"));
  assert.equal(marker.v, 1);
  assert.equal(marker.backup_phase, "locked");
  assert.equal(marker.backup_seq, 3);
  assert.equal(marker.backup_made_at, "2026-11-25T12:00:00Z");
  assert.equal(marker.first_read, null);
  assert.ok(Number.isFinite(Date.parse(marker.restored_at)));
  if (process.platform !== "win32") {
    assert.equal(fs.statSync(path.join(outDir, "bob", "bob.swap.json")).mode & 0o777, 0o600);
    assert.equal(fs.statSync(path.join(outDir, "vault-check.json")).mode & 0o777, 0o600);
  }

  // 6. `recovery.js passphrase <outDir>` works immediately on the opened folder!
  const pp = childProcess.spawnSync(process.execPath, [TOOL, "passphrase", outDir], { input: CODE, encoding: "utf8" });
  assert.equal(pp.status, 0, pp.stderr);
  assert.equal(pp.stdout.trim(), "1390979abfa070d153819225d0f04fe3dba89cd5c662d7bdb845ed2b534fe8b1");
});
