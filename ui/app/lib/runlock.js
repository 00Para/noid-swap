"use strict";
/*
 * One console per run folder (actions mode). Two consoles on the same folder would each keep their own latches, busy flag and watch state,
 * so a click in one is invisible to the other (a double funding, a double send). The lock is a file in the run folder, created with the
 * exclusive flag ("wx": it fails when the file exists), holding the pid, the start time of the console and the start time of its process
 * ("proc"). It is removed on a clean exit. A lock whose pid is gone (a crash, a killed window), or whose pid now belongs to another process
 * (after a reboot or a crash the system reuses pids: the process start time differs), is stale and is replaced, and the caller says so.
 * When the start time of a running process cannot be read, the lock is kept (fail closed). A lock whose content cannot be
 * read is NOT replaced (it might be mid-write by a console that is starting right now): remove it by hand.
 *
 * Two consoles can find the same stale lock at the same moment and both take it over. So a takeover waits a moment and reads the file again,
 * and gives up when the content is not its own; and every spend re-reads the file (`verify`) right before it starts: a console that does not
 * find its own pid and start time in the lock spends nothing.
 */

const fs = require("fs");
const path = require("path");
const cp = require("child_process");

const FILE = "ui-console.lock";
const SETTLE_MS = 150;

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return !!e && e.code === "EPERM"; // exists, but not ours to signal
  }
}

/**
 * An opaque string that identifies the process incarnation behind `pid` (its start time), or null when it cannot be read.
 * Linux: field 22 of /proc/PID/stat; macOS and other Unix: `ps -o lstart=`; Windows: the process creation time from PowerShell.
 */
function procStart(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  try {
    if (process.platform === "linux") {
      const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
      const rest = stat.slice(stat.lastIndexOf(")") + 2).split(" "); // after "pid (comm) ": state is field 3
      return rest[19] ? `linux:${rest[19]}` : null; // starttime is field 22
    }
    const r =
      process.platform === "win32"
        ? cp.spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", `(Get-Process -Id ${pid}).StartTime.ToFileTimeUtc()`], { encoding: "utf8", timeout: 10000, windowsHide: true })
        : cp.spawnSync("ps", ["-o", "lstart=", "-p", String(pid)], { encoding: "utf8", timeout: 5000, env: { ...process.env, LC_ALL: "C", TZ: "UTC" } });
    const out = r && r.status === 0 ? String(r.stdout).trim() : "";
    return out ? `${process.platform}:${out}` : null;
  } catch {
    return null;
  }
}

/**
 * The start time of THIS process, read once per process and kept (also when it could not be read: a blocked or slow PowerShell is not asked again for the
 * next swap folder). The console takes one lock per swap folder at start-up, and on Windows every read is a synchronous PowerShell call of up to 10 s.
 * Another pid (a holder found in a lock file) is never cached: it is read only on the takeover path.
 */
const ownStarts = new Map();
function ownProcStart(pid, read = procStart) {
  if (!ownStarts.has(pid)) ownStarts.set(pid, read(pid));
  return ownStarts.get(pid);
}

/** For tests: forget the kept start times. */
function resetOwnProcStart() {
  ownStarts.clear();
}

/** Does the lock's holder still run? A live pid with another start time is a reused pid: not the holder. An unreadable start time keeps the lock. */
function holderRuns(held, alive, start) {
  if (!alive(held.pid)) return false;
  if (typeof held.proc !== "string" || held.proc === "") return true; // a lock written before the start time was recorded: the pid alone
  const now = start(held.pid);
  return now === null || now === held.proc;
}

/** A short pause, without a timer (the caller is synchronous). */
function sleepMs(ms) {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  } catch {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      /* wait */
    }
  }
}

class RunLock {
  /** Takes the lock or throws. `replaced` (on the returned object) is the stale holder's record, or null. */
  static acquire(dir, o = {}) {
    const pid = o.pid || process.pid;
    const now = o.now || Date.now;
    const alive = o.isAlive || pidAlive;
    const sleep = o.sleep || sleepMs;
    const start = o.procStart || ((p) => (p === process.pid ? ownProcStart(p) : procStart(p)));
    const file = path.join(dir, FILE);
    const started = new Date(now()).toISOString().replace(/\.\d{3}Z$/, "Z");
    const body = JSON.stringify({ pid, started, proc: o.procStart ? o.procStart(pid) : ownProcStart(pid), role: o.role || null }) + "\n";
    let replaced = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        fs.writeFileSync(file, body, { flag: "wx", mode: 0o600 });
        const lock = new RunLock(file, pid, started);
        lock.replaced = replaced;
        if (replaced) {
          // another console may have found the same stale lock: let it finish, then look at what the file holds
          sleep(o.settleMs === undefined ? SETTLE_MS : o.settleMs);
          if (!lock.verify().ok) throw new Error(`could not take ${file}: another console took it at the same moment. If no console is running, delete ${file}`);
        }
        return lock;
      } catch (e) {
        if (!e || e.code !== "EEXIST") throw e;
      }
      let held = null;
      try {
        held = JSON.parse(fs.readFileSync(file, "utf8"));
      } catch {
        held = null;
      }
      if (!held || !Number.isInteger(held.pid)) throw new Error(`${file} exists and cannot be read: another console may be starting on this run folder. Remove the file by hand if no console is running`);
      if (holderRuns(held, alive, start)) throw new Error(`another console is already running on this run folder (pid ${held.pid}, started ${held.started || "?"}; ${file}). Use that one, or stop it first. If no console is running, delete ${file}`);
      replaced = held;
      try {
        // only the stale record we read: a lock that was replaced meanwhile is somebody else's and is left alone
        const again = JSON.parse(fs.readFileSync(file, "utf8"));
        if (again && again.pid === held.pid && again.started === held.started) fs.unlinkSync(file);
      } catch (e) {
        if (!e || (e.code !== "ENOENT" && !(e instanceof SyntaxError))) throw e;
      }
    }
    throw new Error(`could not take ${file}: another console took it at the same moment. If no console is running, delete ${file}`);
  }

  constructor(file, pid, started) {
    this.file = file;
    this.pid = pid;
    this.started = started || null;
    this.replaced = null;
    this.released = false;
  }

  /** Reads the lock file again: `{ ok: true }` when it holds this console's pid and start time, else `{ ok: false, why }`. */
  verify() {
    let held;
    try {
      held = JSON.parse(fs.readFileSync(this.file, "utf8"));
    } catch (e) {
      return { ok: false, why: e && e.code === "ENOENT" ? "the lock file is gone" : "the lock file cannot be read" };
    }
    if (!held || held.pid !== this.pid || held.started !== this.started) return { ok: false, why: `the lock file now names another console (pid ${held && held.pid}, started ${held && held.started})` };
    return { ok: true };
  }

  /** Removes the lock file when it is still ours. Safe to call twice. */
  release() {
    if (this.released) return;
    this.released = true;
    try {
      const held = JSON.parse(fs.readFileSync(this.file, "utf8"));
      if (held && held.pid === this.pid && held.started === this.started) fs.unlinkSync(this.file);
    } catch {
      /* gone already, or not ours */
    }
  }
}

/**
 * The lock of a console that was started while its run folder did not exist yet (the "Install helpers" action creates the folder).
 * Nothing is taken at start. Every `verify()` (a spend, an action, a poll of the page) first tries to take the lock if the folder exists
 * by now; until the lock is held it answers `{ ok: false, folder_missing, why }` and the console does nothing but the install step.
 * Once taken it is an ordinary RunLock: `verify()` reads the file again, `release()` removes it. Fail-closed: a folder that exists but whose
 * lock cannot be taken (another console holds it) is NOT "missing" and not even install may run.
 */
class LazyRunLock {
  /** @param {string} dir the run folder (it may not exist) @param {{resolve?:(d:string)=>string, role?:string, acquire?:Function}} [o] */
  constructor(dir, o = {}) {
    this.dir = dir;
    this.o = o;
    this.resolve = o.resolve || ((d) => d);
    this.lock = null;
    this.why = null;
    this.folderMissing = true;
    this.replaced = null;
    this.isLazy = true;
    this.file = path.join(dir, FILE);
  }

  /** Is something at that path? ENOENT is "not yet"; anything else (a file, no permission) is a real problem and counts as "there": the acquire then reports it. */
  static exists(dir) {
    try {
      fs.statSync(dir);
      return true;
    } catch (e) {
      return !(e && e.code === "ENOENT");
    }
  }

  /** Tries to take the lock when the folder exists. Returns true when this console holds it. */
  tryAcquire() {
    if (this.lock) return true;
    const dir = this.resolve(this.dir);
    if (!LazyRunLock.exists(dir)) {
      this.folderMissing = true;
      this.why = `the run folder does not exist yet (${this.dir}): run "1. Install helpers"`;
      return false;
    }
    this.folderMissing = false;
    try {
      this.lock = RunLock.acquire(dir, { role: this.o.role || null });
      this.file = this.lock.file;
      this.replaced = this.lock.replaced;
      this.why = null;
      return true;
    } catch (e) {
      this.why = e.message;
      return false;
    }
  }

  get held() {
    return !!this.lock;
  }

  verify() {
    if (!this.tryAcquire()) return { ok: false, folder_missing: this.folderMissing, why: this.why };
    return this.lock.verify();
  }

  /** What the page shows: is the lock ours, is the folder missing, and why not. Tries to take the lock (the folder may have appeared). */
  status() {
    const v = this.verify();
    return { held: !!v.ok, folder_missing: !!v.folder_missing, why: v.ok ? null : v.why || this.why || null, replaced: this.replaced ? { pid: this.replaced.pid, started: this.replaced.started || null } : null };
  }

  release() {
    if (this.lock) this.lock.release();
  }
}

module.exports = { RunLock, LazyRunLock, FILE, pidAlive, procStart, ownProcStart, resetOwnProcStart };
