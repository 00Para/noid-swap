"use strict";
// T-D4: program.saveBackup and program.writeBackupTarget refuse targets inside dataDir, hard links,
// symlinks into dataDir, return cannot_write on missing folder, write via temp + rename, one dialog at a time.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createProgram } = require("../lib/program");
const { createVault } = require("../lib/vault");

const RUN_ID = "0123456789abcdef0123456789abcdef";
const cleanup = [];
test.after(() => cleanup.forEach((d) => fs.rmSync(d, { recursive: true, force: true })));

function mkDir(prefix = "no1d-prog-bk-") {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  cleanup.push(d);
  return d;
}

function fakeKeyStore() {
  return {
    kind: "fake",
    available: () => true,
    seal: (b) => Buffer.concat([Buffer.from("SEAL:"), b]),
    open: (b) => Buffer.from(b.subarray(5)),
  };
}

async function makeProgram(dataDir, overrides = {}) {
  let groups = null;
  const vault = createVault({
    dataDir,
    keyStore: fakeKeyStore(),
    secretUi: {
      async show(a) { if (a.kind === "recovery-code") groups = a.groups.slice(); },
      async askGroups({ positions }) { return positions.map((p) => groups[p - 1]); },
      async askText() { return null; },
      async say() {},
    },
  });
  await vault.open();
  const rootDir = mkDir("no1d-root-");
  fs.mkdirSync(path.join(rootDir, "ui", "app", "lib", "steps"), { recursive: true });
  const program = createProgram({
    version: "0.2.0",
    dataDir,
    platform: process.platform,
    env: process.env,
    execPath: process.execPath,
    resourcesPath: rootDir,
    rootDir,
    isPackaged: false,
    homedir: os.homedir(),
    vault,
    folderGuard: () => ({ ok: true, why: null }),
    makeOwnerOnlyDir: (d) => fs.mkdirSync(d, { recursive: true, mode: 0o700 }),
    programsettings: { load: () => ({}) },
    nodeCheck: { status: () => ({}) },
    notify: () => {},
    onAtStake: () => {},
    chooseFile: async () => null,
    openHandlers: { help: async () => {}, import: async () => {}, "update-check": async () => {} },
    ...overrides,
  });
  return { program, vault };
}

test("T-D4: saveBackup writes atomically outside dataDir, refuses inside dataDir, hard links, symlinks, and enforces one dialog at a time", async () => {
  const dataDir = mkDir("no1d-data-");
  const outDir = mkDir("no1d-out-");
  const target = path.join(outDir, "backup.no1dbackup");
  let chosenPath = target;
  let holdResolve = null;

  const { program } = await makeProgram(dataDir, {
    saveBackupFile: async () => {
      if (holdResolve) return new Promise((r) => { holdResolve = () => r(chosenPath); });
      return chosenPath;
    },
  });

  const payload = Buffer.from('{"no1d_swap_backup":1}\n', "utf8");

  // 1. Valid save outside dataDir -> atomic temp + rename, no leftover .tmp
  const r1 = await program.saveBackup(RUN_ID, payload);
  assert.equal(r1.status, "saved");
  assert.equal(fs.readFileSync(target, "utf8"), payload.toString("utf8"));
  assert.deepEqual(fs.readdirSync(outDir).filter((n) => n.endsWith(".tmp")), []);

  // 2. Refuses target inside dataDir
  chosenPath = path.join(dataDir, "bad.no1dbackup");
  const rIn = await program.saveBackup(RUN_ID, payload);
  assert.equal(rIn.status, "refused");
  assert.equal(fs.existsSync(chosenPath), false);

  // 3. Refuses hard link (nlink > 1)
  const linkTarget = path.join(outDir, "hardlink.no1dbackup");
  fs.linkSync(target, linkTarget);
  chosenPath = linkTarget;
  const rHard = await program.saveBackup(RUN_ID, payload);
  assert.equal(rHard.status, "refused");

  // 4. Refuses symlink pointing into dataDir
  const symDir = path.join(outDir, "sym-to-data");
  let linked = true;
  try {
    // a junction needs no special right on Windows; elsewhere the type is ignored
    fs.symlinkSync(dataDir, symDir, "junction");
  } catch {
    linked = false;
  }
  if (linked) {
    chosenPath = path.join(symDir, "escape.no1dbackup");
    const rSym = await program.saveBackup(RUN_ID, payload);
    assert.equal(rSym.status, "refused");
  }

  // 5. Missing parent folder returns cannot_write
  const rMissing = await program.writeBackupTarget(path.join(outDir, "unplugged-usb", "b.no1dbackup"), payload);
  assert.equal(rMissing, "cannot_write");

  // 6. One dialog at a time -> second call returns busy
  chosenPath = path.join(outDir, "ok2.no1dbackup");
  holdResolve = true;
  const pFirst = program.saveBackup(RUN_ID, payload);
  const rSecond = await program.saveBackup(RUN_ID, payload);
  assert.equal(rSecond.status, "busy");
  holdResolve();
  const rFirst = await pFirst;
  assert.equal(rFirst.status, "saved");
});

test("backup target validation is async (no sync I/O on target folder) and timed-out writes do not pile up", async () => {
  const dataDir = mkDir("no1d-data-async-");
  const outDir = mkDir("no1d-out-async-");
  const otherDir = mkDir("no1d-out-other-");
  const hungTarget = path.join(outDir, "hung.no1dbackup");
  const otherTarget = path.join(otherDir, "other.no1dbackup");
  const payload = Buffer.from('{"no1d_swap_backup":1}\n', "utf8");

  let syncCallsOnTarget = 0;
  let asyncRealpathCalls = 0;
  let releaseHung = null;

  const mockFs = new Proxy(fs, {
    get(target, prop) {
      if (prop === "realpathSync" || prop === "lstatSync") {
        return (...args) => {
          const p = String(args[0] || "");
          if (p.startsWith(outDir) || p.startsWith(otherDir)) {
            syncCallsOnTarget += 1;
            throw new Error(`unexpected sync ${prop} on backup target: ${p}`);
          }
          return target[prop](...args);
        };
      }
      if (prop === "promises") {
        return new Proxy(target.promises, {
          get(pt, pprop) {
            if (pprop === "realpath") {
              return async (p, ...rest) => {
                if (String(p).startsWith(outDir)) {
                  asyncRealpathCalls += 1;
                  if (!releaseHung) {
                    await new Promise((r) => {
                      releaseHung = r;
                    });
                  }
                }
                return pt.realpath(p, ...rest);
              };
            }
            const v = Reflect.get(pt, pprop, pt);
            return typeof v === "function" ? v.bind(pt) : v;
          },
        });
      }
      const v = Reflect.get(target, prop, target);
      return typeof v === "function" ? v.bind(target) : v;
    },
  });

  const { program } = await makeProgram(dataDir, { fs: mockFs });

  // 1. First write hangs inside async realpath (simulating a dead network mount) and times out cleanly.
  const r1 = await program.writeBackupTarget(hungTarget, payload, { timeoutMs: 30 });
  assert.equal(r1, "cannot_write");
  assert.equal(syncCallsOnTarget, 0, "must perform ZERO synchronous I/O on the backup target folder");
  assert.equal(asyncRealpathCalls, 1);

  // 2. While the timed-out write is still stuck in the OS, retries to the same OR another folder
  //    must return cannot_write immediately without queuing more hung writes onto the thread pool.
  const r2 = await program.writeBackupTarget(hungTarget, payload, { timeoutMs: 30 });
  const r3 = await program.writeBackupTarget(otherTarget, payload, { timeoutMs: 30 });
  assert.equal(r2, "cannot_write");
  assert.equal(r3, "cannot_write");
  assert.equal(asyncRealpathCalls, 1, "timed-out writes must not pile up");

  // 3. Once the hung OS call finally unwinds, the stale write cleans up without overwriting target
  //    and subsequent writes succeed again.
  releaseHung();
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(fs.existsSync(hungTarget), false, "timed-out write must not write stale bytes after waking up");

  const r4 = await program.writeBackupTarget(otherTarget, payload, { timeoutMs: 2000 });
  assert.equal(r4, "saved");
  assert.equal(fs.readFileSync(otherTarget, "utf8"), payload.toString("utf8"));
  assert.equal(syncCallsOnTarget, 0);
});

test("two different backup targets in one folder write at once; the same target twice is refused while busy", async () => {
  const dataDir = mkDir("no1d-data-twin-");
  const outDir = mkDir("no1d-out-twin-");
  const slow = path.join(outDir, "slow.no1dbackup");
  const fast = path.join(outDir, "fast.no1dbackup");
  const payload = Buffer.from('{"no1d_swap_backup":1}\n', "utf8");
  let release = null;
  const gate = new Promise((r) => {
    release = r;
  });
  const mockFs = new Proxy(fs, {
    get(target, prop) {
      if (prop === "promises") {
        return new Proxy(target.promises, {
          get(pt, pprop) {
            if (pprop === "realpath") {
              return async (p, ...rest) => {
                if (String(p) === outDir && !release.used) {
                  release.used = true;
                  await gate;
                }
                return pt.realpath(p, ...rest);
              };
            }
            const v = Reflect.get(pt, pprop, pt);
            return typeof v === "function" ? v.bind(pt) : v;
          },
        });
      }
      const v = Reflect.get(target, prop, target);
      return typeof v === "function" ? v.bind(target) : v;
    },
  });
  const { program } = await makeProgram(dataDir, { fs: mockFs });
  const pSlow = program.writeBackupTarget(slow, payload, { timeoutMs: 5000 });
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(await program.writeBackupTarget(fast, payload, { timeoutMs: 5000 }), "saved", "a second target in the same folder is not refused");
  assert.equal(await program.writeBackupTarget(slow, payload, { timeoutMs: 5000 }), "cannot_write", "the same target is refused while busy");
  release();
  assert.equal(await pSlow, "saved");
});
