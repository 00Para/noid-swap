"use strict";
// The "Keep this file up to date" tick box, end to end: the page posts `keep_updated`, the server reads `keep_updated`, the saved state and the status payload say `keep_updated`.
// An unticked box must save with keep_updated false and the program must never refresh that file by itself afterwards.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { makeEnv } = require("./program-harness");
const BS = require("../lib/backupset");

const HASHLOCK = "a".repeat(64);

function writeSwapFile(dir, phase) {
  fs.writeFileSync(
    path.join(dir, "alice.swap.json"),
    JSON.stringify({ role: "alice", phase: { phase }, public: { hashlock: "0x" + HASHLOCK, params: { profile: "sepolia", eth: { chain_id: 11155111 } } }, history: [{ event: phase }] }) + "\n",
  );
}

function makeBackupProgram(env) {
  const writes = [];
  env.program.version = "0.2.0";
  env.program.vaultReady = () => ({ ok: true });
  env.program.sealBackup = (_id, p) => Buffer.from(JSON.stringify(p));
  env.program.saveBackup = async () => ({ status: "saved", target: "/fake/usb/swap.no1dbackup" });
  env.program.writeBackupTarget = async (target) => {
    writes.push(target);
    return "saved";
  };
  return writes;
}

test("unticking 'Keep this file up to date' saves keep_updated false and the file is never refreshed by itself", async () => {
  const env = makeEnv();
  try {
    const writes = makeBackupProgram(env);
    const sw = env.addSwap({ role: "alice" });
    writeSwapFile(sw.dir, "created");
    const { srv, api } = await env.start();

    const r = await api("POST", "/api/backup/save", { swap: sw.id, keep_updated: false });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.saved, true);
    assert.equal(r.body.backup.keep_updated, false, "the status payload says keep_updated false");
    assert.equal(BS.readBackupState(sw.dir).keep_updated, false, "the saved state says keep_updated false");

    // the swap moves on: with the box unticked the program must not write the file again
    writeSwapFile(sw.dir, "funded");
    const swap = srv.swapSet.get(sw.id);
    assert.equal(srv.swapSet.backupMgr.maybeRefresh(swap, { tick: null }), null, "no automatic refresh");
    assert.equal(writes.length, 0);
  } finally {
    await env.cleanup();
  }
});

test("a ticked box (and a request that does not say) keeps the file up to date: the refresh runs after the swap moves on", async () => {
  for (const body of [{ keep_updated: true }, {}]) {
    const env = makeEnv();
    try {
      const writes = makeBackupProgram(env);
      const sw = env.addSwap({ role: "alice" });
      writeSwapFile(sw.dir, "created");
      const { srv, api } = await env.start();
      const r = await api("POST", "/api/backup/save", { swap: sw.id, ...body });
      assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.equal(r.body.backup.keep_updated, true);
      assert.equal(BS.readBackupState(sw.dir).keep_updated, true);
      writeSwapFile(sw.dir, "funded");
      const p = srv.swapSet.backupMgr.maybeRefresh(srv.swapSet.get(sw.id), { tick: null });
      assert.ok(p, "a refresh was started");
      assert.equal(await p, "saved");
      assert.equal(writes.length, 1);
    } finally {
      await env.cleanup();
    }
  }
});

test("the page and the server use one name: no auto_refresh is posted or read anywhere in the console", () => {
  const root = path.join(__dirname, "..");
  for (const f of ["program.js", "stagecard.js", "server.js", path.join("lib", "backupmgr.js"), path.join("lib", "backupset.js")]) {
    assert.ok(!/auto_refresh/.test(fs.readFileSync(path.join(root, f), "utf8")), `${f} still says auto_refresh`);
  }
});
