"use strict";
// T-B4: backup route refusals (practice id, board run, read-only folder, locked vault) and no path leak in status payload.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { createBackupManager } = require("../lib/backupmgr");

const RUN_ID = "0123456789abcdef0123456789abcdef";
const HASHLOCK = "a".repeat(64);
const SECRET_PATH = "/mnt/external/usb-stick/my-backup.no1dbackup";
const cleanup = [];
test.after(() => cleanup.forEach((d) => fs.rmSync(d, { recursive: true, force: true })));

function makeDir() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "no1d-broute-"));
  cleanup.push(d);
  fs.writeFileSync(path.join(d, "run.json"), JSON.stringify({ run_id: RUN_ID, role: "alice", profile: "sepolia", chain_id: 11155111 }) + "\n");
  fs.writeFileSync(
    path.join(d, "alice.swap.json"),
    JSON.stringify({
      role: "alice",
      phase: { phase: "created" },
      public: { hashlock: "0x" + HASHLOCK, params: { profile: "sepolia", eth: { chain_id: 11155111 } } },
      history: [],
    }) + "\n",
  );
  return d;
}

test("T-B4: refuses practice id, board run, read-only folder, locked vault, and status payload leaks no target path", async () => {
  let vaultOk = true;
  const program = {
    version: "0.2.0",
    vaultReady: () => ({ ok: vaultOk }),
    sealBackup: (_id, p) => Buffer.from(JSON.stringify(p)),
    saveBackup: async () => ({ status: "saved", target: SECRET_PATH }),
    writeBackupTarget: async () => "saved",
  };
  const mgr = createBackupManager({ program });
  const dir = makeDir();
  const baseSwap = { id: RUN_ID, dir, runner: {}, readOnly: false, board: null, settingsSource: { role: () => "alice" } };

  // Practice id refused
  const rPractice = await mgr.save({ ...baseSwap, id: "practice-0123456789abcdef" });
  assert.equal(rPractice.status, 404);
  assert.equal(mgr.statusOf({ ...baseSwap, id: "practice-0123456789abcdef" }), null);

  // Board run refused
  const rBoard = await mgr.save({ ...baseSwap, board: {} });
  assert.equal(rBoard.status, 409);
  assert.equal(mgr.statusOf({ ...baseSwap, board: {} }), null);

  // Read-only folder refused
  const rRo = await mgr.save({ ...baseSwap, readOnly: true });
  assert.equal(rRo.status, 409);

  // Locked vault refused
  vaultOk = false;
  const rLocked = await mgr.save(baseSwap);
  assert.equal(rLocked.status, 409);
  vaultOk = true;

  // Successful save never leaks target path in response or statusOf
  const rOk = await mgr.save(baseSwap);
  assert.equal(rOk.status, 200);
  assert.ok(!JSON.stringify(rOk).includes(SECRET_PATH), "save response must never carry target path");
  const st = mgr.statusOf(baseSwap);
  assert.equal(st.state, "up_to_date");
  assert.ok(!JSON.stringify(st).includes(SECRET_PATH), "status payload must never carry target path");
});

test("cannot_write save shows drive words", async () => {
  const mk = (status) => ({
    version: "0.2.0",
    vaultReady: () => ({ ok: true }),
    sealBackup: (_id, p) => Buffer.from(JSON.stringify(p)),
    saveBackup: async () => ({ status, target: null }),
    writeBackupTarget: async () => "saved",
  });
  const dir = makeDir();
  const swap = { id: RUN_ID, dir, runner: {}, readOnly: false, board: null, settingsSource: { role: () => "alice" } };
  const drive = await createBackupManager({ program: mk("cannot_write") }).save(swap);
  assert.equal(drive.status, 409);
  assert.match(drive.body.error, /a drive may not be answering/);
  assert.doesNotMatch(drive.body.error, /data folder/);
  // the data-folder words stay for a refused place
  const refused = await createBackupManager({ program: mk("refused") }).save(swap);
  assert.equal(refused.status, 409);
  assert.match(refused.body.error, /outside No1d Swap's data folder/);
});
