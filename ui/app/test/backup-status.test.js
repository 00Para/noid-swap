"use strict";
// T-B3 + S2 + S3: safety digest stability, phase & record triggers, 1-minute throttle bypassed on new record (S2),
// async single-flight non-blocking refresh (S3), cannot_write and not_needed states.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const BS = require("../lib/backupset");
const { createBackupManager } = require("../lib/backupmgr");

const RUN_ID = "0123456789abcdef0123456789abcdef";
const HASHLOCK = "a".repeat(64);
const cleanup = [];
test.after(() => cleanup.forEach((d) => fs.rmSync(d, { recursive: true, force: true })));

function makeSwap(phase = "created", historyLen = 1) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "no1d-bstat-"));
  cleanup.push(dir);
  fs.writeFileSync(path.join(dir, "run.json"), JSON.stringify({ run_id: RUN_ID, role: "alice", profile: "sepolia", chain_id: 11155111 }) + "\n");
  const writeSwap = (p, hLen) => {
    fs.writeFileSync(
      path.join(dir, "alice.swap.json"),
      JSON.stringify({
        role: "alice",
        phase: { phase: p },
        public: { hashlock: "0x" + HASHLOCK, params: { profile: "sepolia", eth: { chain_id: 11155111 } } },
        history: Array.from({ length: hLen }, (_, i) => ({ event: `e${i}` })),
      }) + "\n",
    );
  };
  writeSwap(phase, historyLen);
  return {
    swap: { id: RUN_ID, dir, runner: {}, readOnly: false, board: null, settingsSource: { role: () => "alice" } },
    writeSwap,
  };
}

test("T-B3: digest stays equal on a plain tick rewrite and changes on phase change or new record", () => {
  const { swap, writeSwap } = makeSwap("created", 1);
  const d1 = BS.computeSafetyDigest(swap.dir, "alice");
  // Rewrite swap file with identical phase/history/intent (e.g. a plain tick touching whitespace)
  writeSwap("created", 1);
  const d2 = BS.computeSafetyDigest(swap.dir, "alice");
  assert.equal(d1.digest, d2.digest, "plain tick must not change safety digest");

  // Phase change changes digest
  writeSwap("funded", 2);
  const d3 = BS.computeSafetyDigest(swap.dir, "alice");
  assert.notEqual(d3.digest, d1.digest);

  // New record file changes both digest and recordHash
  fs.writeFileSync(path.join(swap.dir, "alice.swap.json.reveal-sent"), '{"tx":"0x1"}\n');
  const d4 = BS.computeSafetyDigest(swap.dir, "alice");
  assert.notEqual(d4.digest, d3.digest);
  assert.notEqual(d4.recordHash, d3.recordHash);
});

test("S2 + S3: refresh throttles to 1 minute, bypasses immediately on new record file, is async & single-flight, and marks cannot_write on failure", async () => {
  const { swap, writeSwap } = makeSwap("created", 1);
  let clock = 1_700_000_000_000;
  let writes = 0;
  let writeResult = "saved";
  let releaseSlowWrite = null;

  const program = {
    version: "0.2.0",
    vaultReady: () => ({ ok: true }),
    sealBackup: (_id, p) => Buffer.from(JSON.stringify(p)),
    saveBackup: async () => ({ status: "saved", target: "/fake/usb/backup.no1dbackup" }),
    writeBackupTarget: async () => {
      writes++;
      if (releaseSlowWrite === "HOLD") {
        await new Promise((r) => { releaseSlowWrite = r; });
      }
      return writeResult;
    },
  };

  const mgr = createBackupManager({ program, now: () => clock, refreshMinMs: 60_000 });
  const saved = await mgr.save(swap, { keepUpdated: true });
  assert.equal(saved.status, 200);
  assert.equal(saved.body.backup.state, "up_to_date");

  // Phase changes at t+10s -> first refresh runs (never refreshed before)
  clock += 10_000;
  writeSwap("funded", 2);
  await mgr.maybeRefresh(swap);
  assert.equal(writes, 1);
  assert.equal(mgr.statusOf(swap).state, "up_to_date");

  // Phase changes again 5s later (no new record) -> throttled (< 60s)
  clock += 5_000;
  writeSwap("funding_final", 3);
  assert.equal(mgr.maybeRefresh(swap), null, "throttled within 60 s");
  assert.equal(writes, 1);

  // S2: A record file (.reveal-sent) appears 1s later -> bypasses 60 s throttle IMMEDIATELY!
  clock += 1_000;
  fs.writeFileSync(path.join(swap.dir, "alice.swap.json.reveal-sent"), '{"tx":"0xaa"}\n');
  await mgr.maybeRefresh(swap);
  assert.equal(writes, 2, "record file appearance must bypass 1-minute throttle");

  // S3: Single-flight while an async write is slow — second call returns null without blocking
  clock += 70_000;
  writeSwap("revealed", 4);
  releaseSlowWrite = "HOLD";
  const slowP = mgr.maybeRefresh(swap);
  assert.equal(mgr.isRefreshing(swap.id), true);
  assert.equal(mgr.maybeRefresh(swap), null, "single-flight must skip while write in progress");
  releaseSlowWrite();
  await slowP;
  assert.equal(mgr.isRefreshing(swap.id), false);
  assert.equal(writes, 3);

  // Missing USB stick -> cannot_write, never throws
  clock += 70_000;
  writeSwap("done", 5);
  writeResult = "cannot_write";
  await mgr.maybeRefresh(swap);
  assert.equal(mgr.statusOf(swap).state, "cannot_write");

  // Ended + swept -> not_needed
  assert.equal(mgr.statusOf(swap, { endedAndSwept: true }).state, "not_needed");
});
