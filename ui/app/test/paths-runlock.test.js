"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { canonicalPath, samePath } = require("../lib/paths");
const { RunLock, FILE } = require("../lib/runlock");

test("canonicalPath: WSL shares, /mnt/<drive>, Windows drives and Linux paths compare by what they name", () => {
  const D = "Ubuntu-24.04";
  assert.equal(canonicalPath("\\\\wsl.localhost\\Ubuntu-24.04\\home\\u\\run\\", null), "lin:ubuntu-24.04:/home/u/run");
  assert.equal(canonicalPath("//wsl$/UBUNTU-24.04/home/u/run", null), "lin:ubuntu-24.04:/home/u/run");
  assert.equal(canonicalPath("/home/u/run", D), "lin:ubuntu-24.04:/home/u/run");
  assert.equal(canonicalPath("/home/u/run", null), "lin::/home/u/run");
  assert.equal(canonicalPath("C:\\Users\\X\\Run", null), "win:c:/users/x/run");
  assert.equal(canonicalPath("/mnt/c/Users/x/run", D), "win:c:/users/x/run");
  assert.equal(canonicalPath("/mnt/c/Users/x/run", null), "lin::/mnt/c/Users/x/run", "no distro: /mnt is just a Linux path");
  assert.equal(canonicalPath("/a//b///c", null), "lin::/a/b/c");
  for (const bad of ["", null, undefined, "relative/path", "./x", "//server/share/x", 5]) assert.equal(canonicalPath(bad, D), null, String(bad));
  assert.equal(samePath("C:/Users/x/o.json", null, "/mnt/c/users/X/o.json", D), true);
  assert.equal(samePath("C:/Users/x/o.json", null, "/mnt/d/users/x/o.json", D), false);
  assert.equal(samePath("//wsl.localhost/A/home/u/o.json", null, "/home/u/o.json", "B"), false);
  assert.equal(samePath("x", null, "x", null), false, "two non-absolute paths are never the same file");
});

function tmp() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "noid-lock-"));
  return { dir, done: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

test("RunLock: one console per run folder; the lock holds pid and time; it is let go on release; a second release is harmless", () => {
  const t = tmp();
  try {
    const a = RunLock.acquire(t.dir, { pid: process.pid, now: () => Date.UTC(2026, 10, 6, 12, 0, 0), role: "alice" });
    assert.equal(a.replaced, null);
    const held = JSON.parse(fs.readFileSync(path.join(t.dir, FILE), "utf8"));
    assert.deepEqual(held, { pid: process.pid, started: "2026-11-06T12:00:00Z", proc: held.proc, role: "alice" });
    assert.ok(held.proc === null || typeof held.proc === "string");
    assert.throws(() => RunLock.acquire(t.dir), new RegExp(`another console is already running on this run folder \\(pid ${process.pid}, started 2026-11-06T12:00:00Z`));
    a.release();
    a.release();
    assert.equal(fs.existsSync(path.join(t.dir, FILE)), false);
    const b = RunLock.acquire(t.dir);
    assert.equal(b.replaced, null);
    b.release();
  } finally {
    t.done();
  }
});

test("RunLock: a stale lock (its process is gone) is replaced and said so; an unreadable one is not; release never removes another console's lock", () => {
  const t = tmp();
  try {
    fs.writeFileSync(path.join(t.dir, FILE), JSON.stringify({ pid: 999999, started: "2026-11-01T00:00:00Z", role: "bob" }) + "\n");
    const lock = RunLock.acquire(t.dir, { isAlive: (pid) => pid === process.pid });
    assert.deepEqual(lock.replaced, { pid: 999999, started: "2026-11-01T00:00:00Z", role: "bob" });
    assert.equal(JSON.parse(fs.readFileSync(path.join(t.dir, FILE), "utf8")).pid, process.pid);
    // a live holder is never replaced
    assert.throws(() => RunLock.acquire(t.dir, { isAlive: () => true }), /already running/);
    // somebody else's lock appears after ours was removed: release leaves it alone
    fs.writeFileSync(path.join(t.dir, FILE), JSON.stringify({ pid: process.pid + 1, started: "x" }) + "\n");
    lock.release();
    assert.equal(JSON.parse(fs.readFileSync(path.join(t.dir, FILE), "utf8")).pid, process.pid + 1);
    // unreadable content (a console may be mid-write): refused, not replaced
    for (const junk of ["", "not json", "{}", '{"pid":"x"}']) {
      fs.writeFileSync(path.join(t.dir, FILE), junk);
      assert.throws(() => RunLock.acquire(t.dir, { isAlive: () => false }), /cannot be read/, JSON.stringify(junk));
      assert.equal(fs.readFileSync(path.join(t.dir, FILE), "utf8"), junk, "left alone");
    }
    // the real liveness probe: this process is alive, a huge pid is not
    const real = require("../lib/runlock").pidAlive;
    assert.equal(real(process.pid), true);
    assert.equal(real(2 ** 31 - 2), false);
    assert.equal(real(0), false);
    assert.equal(real(-1), false);
    assert.equal(real("12"), false);
  } finally {
    t.done();
  }
});

test("RunLock: the lock-held message says what to delete; verify() reads the file again and wants this console's pid AND start time", () => {
  const t = tmp();
  try {
    const a = RunLock.acquire(t.dir, { pid: process.pid, now: () => Date.UTC(2026, 10, 6, 12, 0, 0) });
    const file = path.join(t.dir, FILE);
    assert.throws(() => RunLock.acquire(t.dir), (e) => /already running/.test(e.message) && e.message.includes(`If no console is running, delete ${file}`));
    assert.deepEqual(a.verify(), { ok: true });
    // the same pid but another start time (a console of the same process id after a restart): not ours
    fs.writeFileSync(file, JSON.stringify({ pid: process.pid, started: "2026-11-06T12:00:01Z", role: null }) + "\n");
    assert.equal(a.verify().ok, false);
    assert.match(a.verify().why, /names another console/);
    // another pid
    fs.writeFileSync(file, JSON.stringify({ pid: process.pid + 1, started: "2026-11-06T12:00:00Z" }) + "\n");
    assert.equal(a.verify().ok, false);
    // unreadable, gone
    fs.writeFileSync(file, "junk");
    assert.match(a.verify().why, /cannot be read/);
    fs.rmSync(file);
    assert.match(a.verify().why, /is gone/);
    // release leaves a lock with our pid but another start time alone
    fs.writeFileSync(file, JSON.stringify({ pid: process.pid, started: "2026-11-06T12:00:01Z" }) + "\n");
    a.release();
    assert.equal(fs.existsSync(file), true);
  } finally {
    t.done();
  }
});

test("RunLock: after a stale-lock takeover the file is read again once, and a console that finds another's content gives up", () => {
  const t = tmp();
  try {
    const file = path.join(t.dir, FILE);
    fs.writeFileSync(file, JSON.stringify({ pid: 999999, started: "2026-11-01T00:00:00Z", role: "bob" }) + "\n");
    // a second console takes the lock in the pause: its record is in the file when we look again
    let slept = 0;
    const rival = JSON.stringify({ pid: process.pid + 7, started: "2026-11-06T12:00:00Z", role: "bob" }) + "\n";
    assert.throws(
      () => RunLock.acquire(t.dir, { isAlive: (pid) => pid === process.pid, sleep: (ms) => (slept++, assert.ok(ms > 0), fs.writeFileSync(file, rival)) }),
      (e) => /another console took it at the same moment/.test(e.message) && e.message.includes(`delete ${file}`)
    );
    assert.equal(slept, 1, "one pause, one look");
    assert.equal(fs.readFileSync(file, "utf8"), rival, "the rival's lock is left alone");
    // the quiet case: the pause happens, the file is ours, the lock is returned with the stale record
    fs.writeFileSync(file, JSON.stringify({ pid: 999999, started: "2026-11-01T00:00:00Z", role: "bob" }) + "\n");
    let n = 0;
    const lock = RunLock.acquire(t.dir, { isAlive: () => false, sleep: () => n++ });
    assert.equal(n, 1);
    assert.equal(lock.replaced.pid, 999999);
    assert.equal(lock.verify().ok, true);
    lock.release();
    // a fresh lock (nothing stale) takes no pause
    let m = 0;
    const fresh = RunLock.acquire(t.dir, { sleep: () => m++ });
    assert.equal(m, 0);
    fresh.release();
    // a stale record is only removed if it is still the one that was read: a lock replaced meanwhile is left alone
    fs.writeFileSync(file, JSON.stringify({ pid: 999999, started: "2026-11-01T00:00:00Z" }) + "\n");
    let reads = 0;
    const realRead = fs.readFileSync;
    fs.readFileSync = function (p, ...rest) {
      const v = realRead.call(fs, p, ...rest);
      if (String(p) === file && ++reads === 1) fs.writeFileSync(file, rival); // between our first read and our second look, somebody else took it
      return v;
    };
    try {
      assert.throws(() => RunLock.acquire(t.dir, { isAlive: (pid) => pid === process.pid + 7, sleep: () => {} }), /already running on this run folder \(pid \d+/);
    } finally {
      fs.readFileSync = realRead;
    }
    assert.equal(fs.readFileSync(file, "utf8"), rival);
  } finally {
    t.done();
  }
});
