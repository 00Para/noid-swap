"use strict";
// T-D2: pure backup file format (outer wrapper, canonical sha256, inner allowlist, L5 home entries, L6 envelope hash).
const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const sealed = require("../lib/sealed");
const bf = require("../lib/backupfile");

const KEY = crypto.randomBytes(32);
const RUN_ID = "0123456789abcdef0123456789abcdef";
const HASHLOCK = "a".repeat(64);
const DIGEST = "b".repeat(64);
const SENDER = "11223344556677889900aabbccddeeff11223344";

function sampleInner(overrides = {}) {
  const role = overrides.role || "alice";
  const profile = overrides.profile || "sepolia";
  const chainId = overrides.chainId !== undefined ? overrides.chainId : profile === "production" ? 1 : 11155111;
  const runJson = Buffer.from(JSON.stringify({ run_id: RUN_ID, role, profile, chain_id: chainId }) + "\n");
  const swapPath = role === "alice" ? "alice.swap.json" : "bob/bob.swap.json";
  const swapBytes = Buffer.from(JSON.stringify({ phase: "created" }) + "\n");
  return {
    madeBy: "0.1.8",
    madeAt: "2026-11-25T12:00:00Z",
    seq: 1,
    runId: RUN_ID,
    role,
    profile,
    chainId,
    phase: "created",
    safetyDigest: DIGEST,
    registry: { hashlock: HASHLOCK, role },
    files: [
      { path: "run.json", bytes: runJson },
      { path: swapPath, bytes: swapBytes },
      { path: "pub/ui-audit.jsonl", bytes: Buffer.from('{"v":1}\n') },
    ],
    home: [
      { path: `lock-sent/${chainId}-${SENDER}-${HASHLOCK}.json`, bytes: Buffer.from('{"ok":true}\n') },
    ],
    ...overrides,
  };
}

test("outer + inner round trip succeeds, and a renamed copy keeps opening", () => {
  assert.equal(bf.defaultBackupName(RUN_ID), "no1d-swap-backup-01234567.no1dbackup");
  const plain = bf.buildPlain(sampleInner());
  const env = sealed.seal({ key: KEY, label: "swap-backup", runId: RUN_ID, fileName: "swap-backup", plain });
  const outerText = bf.formatOuter({ runId: RUN_ID, sealedEnvelope: env });

  const outer = bf.parseOuter(outerText);
  assert.equal(outer.runId, RUN_ID);
  const opened = sealed.open({ key: KEY, label: "swap-backup", runId: RUN_ID, fileName: "swap-backup", envelope: outer.sealed });
  const parsed = bf.parsePlain(opened, { expectedRunId: RUN_ID, currentVersion: "0.1.8", bobSender: "0x" + SENDER });
  assert.equal(parsed.run_id, RUN_ID);
  assert.equal(parsed.role, "alice");
  assert.equal(parsed.files.length, 3);
  assert.equal(parsed.home.length, 1);
  assert.equal(parsed.files[0].bytes.toString("utf8").includes(RUN_ID), true);
});

test("outer refusals: non-JSON, non-backup JSON, wrong version, bad sha256, extra key, duplicate key, bad envelope", () => {
  const plain = bf.buildPlain(sampleInner());
  const env = sealed.seal({ key: KEY, label: "swap-backup", runId: RUN_ID, fileName: "swap-backup", plain });
  const outerObj = JSON.parse(bf.formatOuter({ runId: RUN_ID, sealedEnvelope: env }));

  assert.throws(() => bf.parseOuter("not json"), (e) => e instanceof bf.BackupFileError && e.code === "not_backup");
  assert.throws(() => bf.parseOuter('{"hello":1}'), (e) => e instanceof bf.BackupFileError && e.code === "not_backup");
  assert.throws(() => bf.parseOuter(JSON.stringify({ ...outerObj, no1d_swap_backup: 2 })), (e) => e instanceof bf.BackupFileError && e.code === "not_backup");
  assert.throws(() => bf.parseOuter(JSON.stringify({ ...outerObj, extra: 1 })), (e) => e instanceof bf.BackupFileError && e.code === "damaged");
  const flipSha = (outerObj.sha256[0] === "0" ? "1" : "0") + outerObj.sha256.slice(1);
  assert.throws(() => bf.parseOuter(JSON.stringify({ ...outerObj, sha256: flipSha })), (e) => e instanceof bf.BackupFileError && e.code === "damaged");
  const badCt = { ...outerObj, sealed: { ...outerObj.sealed, ct: (outerObj.sealed.ct[0] === "0" ? "1" : "0") + outerObj.sealed.ct.slice(1) } };
  assert.throws(() => bf.parseOuter(JSON.stringify(badCt)), (e) => e instanceof bf.BackupFileError && e.code === "damaged");
  const dupText = bf.formatOuter({ runId: RUN_ID, sealedEnvelope: env }).replace('"no1d_swap_backup":1', '"no1d_swap_backup":1,"no1d_swap_backup":1');
  assert.throws(() => bf.parseOuter(dupText), (e) => e instanceof bf.BackupFileError && e.code === "damaged");
});

test("inner refusals: unknown path, traversal, absolute path, duplicate path, extra key, bad sha, run id mismatch, newer made_by, oversize", () => {
  const validObj = JSON.parse(bf.buildPlain(sampleInner()).toString("utf8"));

  // unknown path, traversal, absolute, drive letter, duplicate
  for (const badPath of ["autopilot-alice.json", "../escape.txt", "/etc/passwd", "C:\\x", "bob\\bob.swap.json", "vault-check.json"]) {
    const o = structuredClone(validObj);
    o.files.push({ path: badPath, sha256: bf.sha256Hex(Buffer.from("x")), b64: Buffer.from("x").toString("base64") });
    assert.throws(() => bf.parsePlain(JSON.stringify(o)), bf.BackupFileError, badPath);
  }
  const dupFile = structuredClone(validObj);
  dupFile.files.push(dupFile.files[0]);
  assert.throws(() => bf.parsePlain(JSON.stringify(dupFile)), bf.BackupFileError, "duplicate file");

  // extra key
  const extraKey = { ...validObj, extra: true };
  assert.throws(() => bf.parsePlain(JSON.stringify(extraKey)), bf.BackupFileError, "extra key");

  // bad file sha256
  const badSha = structuredClone(validObj);
  badSha.files[0].sha256 = "f".repeat(64);
  assert.throws(() => bf.parsePlain(JSON.stringify(badSha)), bf.BackupFileError, "bad sha");

  // run id mismatch
  assert.throws(
    () => bf.parsePlain(JSON.stringify(validObj), { expectedRunId: "fedcba9876543210fedcba9876543210" }),
    (e) => e instanceof bf.BackupFileError && e.code === "mismatch",
  );

  // newer made_by
  const newer = { ...validObj, made_by: "0.2.0" };
  assert.throws(
    () => bf.parsePlain(JSON.stringify(newer), { currentVersion: "0.1.8" }),
    (e) => e instanceof bf.BackupFileError && e.code === "newer_version" && /newer version/.test(e.message),
  );

  // oversize > 1 MiB
  const huge = Buffer.alloc(bf.MAX_PLAIN_BYTES + 10, 0x20);
  assert.throws(() => bf.parsePlain(huge), (e) => e instanceof bf.BackupFileError && e.code === "too_large");

  // L5: home entry wrong chain, wrong hashlock, wrong sender, or bad path
  const badHomeChain = structuredClone(validObj);
  badHomeChain.home = [{ path: `lock-sent/1-${SENDER}-${HASHLOCK}.json`, sha256: bf.sha256Hex(Buffer.from("{}")), b64: Buffer.from("{}").toString("base64") }];
  assert.throws(() => bf.parsePlain(JSON.stringify(badHomeChain)), (e) => e instanceof bf.BackupFileError && e.code === "mismatch");

  const badHomeHash = structuredClone(validObj);
  badHomeHash.home = [{ path: `lock-sent/11155111-${SENDER}-${"c".repeat(64)}.json`, sha256: bf.sha256Hex(Buffer.from("{}")), b64: Buffer.from("{}").toString("base64") }];
  assert.throws(() => bf.parsePlain(JSON.stringify(badHomeHash)), (e) => e instanceof bf.BackupFileError && e.code === "mismatch");

  assert.throws(
    () => bf.parsePlain(JSON.stringify(validObj), { bobSender: "0x" + "9".repeat(40) }),
    (e) => e instanceof bf.BackupFileError && e.code === "mismatch",
  );

  // profile vs chain_id mismatch
  const badChain = structuredClone(validObj);
  badChain.profile = "production";
  assert.throws(() => bf.parsePlain(JSON.stringify(badChain)), (e) => e instanceof bf.BackupFileError && e.code === "mismatch");
});

test("every file the console backs up is allowed by the desktop backup file (reveal-fees included)", () => {
  const BS = require("../../ui/app/lib/backupset");
  const allowed = new Set(bf.ALLOWED_BACKUP_PATHS);
  const missing = BS.INCLUDED_FILES.filter((p) => !allowed.has(p));
  assert.deepEqual(missing, []);
  assert.ok(allowed.has("alice.swap.json.reveal-fees"));
});

test("the offer posting key file is backed up, so a restored copy can still withdraw or close its offer", () => {
  const BS = require("../../ui/app/lib/backupset");
  assert.ok(BS.INCLUDED_FILES.includes("offer-post.json"));
  assert.ok(bf.ALLOWED_BACKUP_PATHS.includes("offer-post.json"));
});
