"use strict";
/*
 * Import of an old run folder (piece 4, step 4.6; spec 6.8): a folder of the bash helpers (env.local.sh, passphrase.txt, board-keys.json, swap files) becomes a
 * run folder of the program (run.json, passphrase.sealed, board keys sealed), AT REST ONLY.
 *
 *   createMigrator({ vault, secretUi, runsDir, home, programVersion?, writeRunFiles?, statusOf, now?, isAlive?, fs?, randomBytes?,
 *                    runsettings?, makeKeyStore?, makeAudit? }) -> { importRun(), importLockRecords(oldHomeDir) }
 *
 *   statusOf(swapFile) -> Promise<string|null>    the phase from `swap-cli status FILE` (no passphrase); statusFromSwapCli() builds one from the tool's argv prefix
 *   writeRunFiles(dir)                            writes written-by.json and vault-check.json into a folder (the set's writer); the default writes both itself
 *
 * What it does, in this order (a refusal before the copy changes nothing; a failure after it removes the copy and leaves the original as it was):
 *   1  the folder comes from the secret window's folder dialog (askFolder "import-run"), never from a request
 *   2  refuses unless: a wallet run with the poseidon lock (migrateFromEnvLocal says so); no run.json yet; at most one role's swap file, and its phase is one
 *      where nothing of the swap is in a contract and nothing is pending (Alice created, done, refunded, lost, aborted; Bob received, done, refunded, aborted);
 *      no live console lock; no loop-*.txt changed in the last 5 minutes; no link inside; a passphrase file where there is a swap file
 *   3  copies every file except bin/, passphrase.txt and the console lock to runs/.importing/<random>/, compares the sha256 of each, makes run.json there with
 *      migrateFromEnvLocal (its random run id names the folder), then writes the set's two small files
 *   4  seals the old passphrase into passphrase.sealed (the vault does it), reads it back through passphraseFor and compares; a plain board-keys.json is sealed
 *   5  renames the copy to runs/<run id>/; only then deletes passphrase.txt in the original (when that fails the new folder is removed and nothing is lost),
 *      and writes MOVED-TO-NO1D-SWAP.txt there
 *   6  asks for the old .noid-swap folder (askFolder "import-home") and appends its hashlocks.txt lines to <home>/.noid-swap/hashlocks.txt, without duplicates
 *   7  audit lines in the new folder, never a value
 *
 * Deviation from the spec text, safer: passphrase.txt is never copied (so no second clear copy is ever on disk); the copy is staged under runs/.importing/ and the
 * run id comes from run.json, because the id is made by migrateFromEnvLocal and the folder must be named by it.
 * Nothing secret is returned, logged or put in an error text. The secret window is told only fixed words.
 */

const crypto = require("crypto");
const nodeFs = require("fs");
const path = require("path");
const childProcess = require("child_process");
const derive = require("./derive");
const sealed = require("./sealed");

const ALLOWED_PHASES = Object.freeze({
  alice: Object.freeze(["created", "done", "refunded", "lost", "aborted"]),
  bob: Object.freeze(["received", "done", "refunded", "aborted"]),
});
const LOOP_QUIET_MS = 5 * 60 * 1000;
const MAX_FILES = 5000;
const MAX_BYTES = 1024 * 1024 * 1024;
const HASHLOCK_MAX = 1024 * 1024;
const MOVED = "MOVED-TO-NO1D-SWAP.txt";
const SKIP_TOP = new Set(["bin", "passphrase.txt", "ui-console.lock"]);
// the line swap-cli's registry writes and reads (swap-cli/src/swapfile.rs HashlockRegistry): a hashlock, optionally a role, then an ignored third field
const HASHLOCK_LINE = /^([0-9a-f]{64})(?:[ \t]+(alice|bob)(?:[ \t]+\S+)?)?[ \t]*$/;

class ImportRefused extends Error {}

const sha256File = (fs, p) => crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex");

/** One registry line to { hashlock, role } or null. */
function parseHashlockLine(line) {
  const m = HASHLOCK_LINE.exec(String(line).replace(/\r$/, ""));
  return m ? { hashlock: m[1], role: m[2] || null } : null;
}

/** A `statusOf` that runs `swap-cli status FILE` (argument vector, no shell, no passphrase) and returns the JSON's "phase". */
function statusFromSwapCli(argv, { env = process.env, timeoutMs = 30000 } = {}) {
  return function statusOf(file) {
    return new Promise((resolve) => {
      const e = {};
      for (const k of ["PATH", "SystemRoot", "SYSTEMROOT", "WINDIR", "TEMP", "TMP", "LANG"]) if (env[k]) e[k] = env[k];
      childProcess.execFile(argv[0], [...argv.slice(1), "status", file], { env: e, shell: false, windowsHide: true, timeout: timeoutMs, maxBuffer: 1024 * 1024, encoding: "utf8" }, (err, stdout) => {
        if (err) return resolve(null);
        try {
          const o = JSON.parse(stdout);
          resolve(o && typeof o.phase === "string" ? o.phase : null);
        } catch {
          resolve(null);
        }
      });
    });
  };
}

function createMigrator(deps) {
  const { vault, secretUi, runsDir, home } = deps;
  if (!vault || !secretUi || typeof runsDir !== "string" || !path.isAbsolute(runsDir) || typeof home !== "string" || !path.isAbsolute(home)) throw new Error("the migrator needs a vault, a secret window, an absolute runs folder and an absolute home");
  const fs = deps.fs || nodeFs;
  const now = deps.now || Date.now;
  const randomBytes = deps.randomBytes || crypto.randomBytes;
  const statusOf = deps.statusOf;
  const isAlive =
    deps.isAlive ||
    ((pid) => {
      if (!Number.isInteger(pid) || pid <= 0) return false;
      try {
        process.kill(pid, 0);
        return true;
      } catch (e) {
        return !!e && e.code === "EPERM";
      }
    });
  const runsettings = () => deps.runsettings || require("../../ui/app/lib/runsettings");
  const makeKeyStore = (dir, sealer) => (deps.makeKeyStore ? deps.makeKeyStore(dir, sealer) : new (require("../../ui/app/lib/board/keys").KeyStore)(dir, { sealer }));
  const makeAudit = (dir) => (deps.makeAudit ? deps.makeAudit(dir) : new (require("../../ui/app/lib/audit").AuditLog)(dir, { now }));
  const importingDir = path.join(runsDir, ".importing");
  let busy = false;

  const writeRunFiles =
    deps.writeRunFiles ||
    ((dir) => {
      if (typeof deps.programVersion !== "string") throw new Error("no program version to write");
      sealed.writeAtomic(path.join(dir, "written-by.json"), Buffer.from(`${JSON.stringify({ v: 1, program_version: deps.programVersion })}\n`), fs);
      sealed.writeAtomic(path.join(dir, "vault-check.json"), Buffer.from(`${JSON.stringify({ v: 1, check: vault.keyCheck() })}\n`), fs);
    });

  const tell = async (arg) => {
    try {
      if (typeof secretUi.say === "function") await secretUi.say(arg);
    } catch {
      /* the window must not break the import */
    }
  };

  const rmTree = (p) => {
    try {
      fs.rmSync(p, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  };

  // ---- the checks at rest (they only read)
  function plainDir(p, what) {
    let st;
    try {
      st = fs.lstatSync(p);
    } catch {
      throw new ImportRefused(`${what} is not there`);
    }
    if (st.isSymbolicLink() || !st.isDirectory()) throw new ImportRefused(`${what} is not a plain folder`);
  }
  const lst = (p) => {
    try {
      return fs.lstatSync(p);
    } catch {
      return null;
    }
  };

  function checkNotLive(src) {
    const lock = path.join(src, "ui-console.lock");
    const st = lst(lock);
    if (st) {
      let held = null;
      try {
        held = JSON.parse(fs.readFileSync(lock, "utf8"));
      } catch {
        held = null;
      }
      if (!held || !Number.isInteger(held.pid)) throw new ImportRefused("the folder's console lock cannot be read: remove it by hand if no console is running");
      if (isAlive(held.pid)) throw new ImportRefused("a console is running on this folder: stop it first");
    }
    const t = now();
    for (const d of [src, path.join(src, "pub")]) {
      let names = [];
      try {
        names = fs.readdirSync(d);
      } catch {
        names = [];
      }
      for (const n of names) {
        if (!/^loop-.*\.txt$/.test(n)) continue;
        const s = lst(path.join(d, n));
        if (s && t - s.mtimeMs < LOOP_QUIET_MS) throw new ImportRefused("a watch loop wrote to this folder in the last five minutes: stop it and wait");
      }
    }
  }

  async function swapState(src) {
    const files = { alice: path.join(src, "alice.swap.json"), bob: path.join(src, "bob", "bob.swap.json") };
    const present = Object.keys(files).filter((r) => lst(files[r]) !== null);
    if (present.length > 1) throw new ImportRefused("the folder holds both roles' swap files");
    if (present.length === 0) return { role: null, file: null };
    const role = present[0];
    const st = lst(files[role]);
    if (!st.isFile()) throw new ImportRefused("a swap file is not a plain file");
    if (typeof statusOf !== "function") throw new ImportRefused("the swap file's phase cannot be read here");
    let phase = null;
    try {
      phase = await statusOf(files[role]);
    } catch {
      phase = null;
    }
    if (typeof phase !== "string") throw new ImportRefused("the swap file's phase could not be read");
    if (!ALLOWED_PHASES[role].includes(phase)) throw new ImportRefused("the swap is not at rest: something of it may be in a contract or pending. Finish it where it started");
    return { role, file: files[role] };
  }

  function roleFromEnvLocal(src) {
    let text = "";
    try {
      const st = lst(path.join(src, "env.local.sh"));
      if (!st || !st.isFile() || st.size > 65536) return null;
      text = fs.readFileSync(path.join(src, "env.local.sh"), "utf8");
    } catch {
      return null;
    }
    const m = /^(?:export[ \t]+)?UI_ROLE=(?:'([a-z]+)'|"([a-z]+)"|([a-z]+))[ \t]*$/m.exec(text);
    const v = m && (m[1] || m[2] || m[3]);
    return v === "alice" || v === "bob" ? v : null;
  }

  // ---- the copy
  function copyTree(src, dst, counts, top) {
    for (const e of fs.readdirSync(src, { withFileTypes: true })) {
      const from = path.join(src, e.name);
      const to = path.join(dst, e.name);
      if (top && SKIP_TOP.has(e.name)) continue;
      const st = fs.lstatSync(from);
      if (st.isSymbolicLink()) throw new ImportRefused("the folder holds a link: a run folder holds plain files only");
      if (st.isDirectory()) {
        fs.mkdirSync(to, { mode: 0o700 });
        copyTree(from, to, counts, false);
      } else if (st.isFile()) {
        counts.files++;
        counts.bytes += st.size;
        if (counts.files > MAX_FILES || counts.bytes > MAX_BYTES) throw new ImportRefused("the folder is too large to import");
        fs.copyFileSync(from, to, nodeFs.constants.COPYFILE_EXCL);
        try {
          fs.chmodSync(to, 0o600);
        } catch {
          /* Windows ignores modes */
        }
        if (sha256File(fs, from) !== sha256File(fs, to)) throw new ImportRefused("a file did not copy exactly");
      } else throw new ImportRefused("the folder holds something that is not a plain file or folder");
    }
  }

  function readOldPassphrase(src) {
    const p = path.join(src, "passphrase.txt");
    const st = lst(p);
    if (!st) return null;
    if (!st.isFile() || st.size === 0 || st.size > 4096) throw new ImportRefused("passphrase.txt is not a plain non-empty file");
    // What the bash helpers handed to swap-cli was $(cat passphrase.txt): the file's text with trailing newlines (\n) removed and nothing else. A carriage return
    // before the newline (a file edited on Windows) was therefore PART of the passphrase. This import cannot tell whether the swap file was sealed with it, and a
    // wrong guess would delete the only exact copy: so such a file is refused, and so is a NUL or text that is not valid UTF-8 (swap-cli takes Unicode only).
    const raw = fs.readFileSync(p);
    let text;
    try {
      text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(raw);
    } catch {
      throw new ImportRefused("passphrase.txt is not valid UTF-8 text: check it by hand. Nothing was changed");
    }
    if (text.includes("\r")) throw new ImportRefused("passphrase.txt has a carriage return (a Windows line end): the bash helpers passed it on as part of the passphrase, so check the file by hand. Nothing was changed");
    if (text.includes("\0")) throw new ImportRefused("passphrase.txt holds a NUL character: check it by hand. Nothing was changed");
    const t = text.replace(/\n+$/, "");
    if (!t) throw new ImportRefused("passphrase.txt is empty or not usable");
    let end = raw.length;
    while (end > 0 && raw[end - 1] === 0x0a) end--;
    if (!Buffer.from(t, "utf8").equals(raw.subarray(0, end))) throw new ImportRefused("passphrase.txt did not read exactly. Nothing was changed");
    return t;
  }

  async function importHomeRecords() {
    let dirPath = null;
    try {
      dirPath = typeof secretUi.askFolder === "function" ? await secretUi.askFolder({ kind: "import-home" }) : null;
    } catch {
      dirPath = null;
    }
    if (typeof dirPath !== "string" || !dirPath) return { state: "not_imported", imported: 0, already_there: 0, not_matching: 0 };
    try {
      return { state: "imported", ...importLockRecords(dirPath) };
    } catch {
      return { state: "not_imported", imported: 0, already_there: 0, not_matching: 0 };
    }
  }

  /** Appends the matching lines of <oldHomeDir>/hashlocks.txt to <home>/.noid-swap/hashlocks.txt (append flag, no duplicates). Counts only. */
  function importLockRecords(oldHomeDir) {
    const source = path.join(oldHomeDir, "hashlocks.txt");
    const sst = lst(source);
    if (!sst || !sst.isFile() || sst.size > HASHLOCK_MAX) throw new ImportRefused("there is no usable hashlocks.txt in that folder");
    const lines = fs.readFileSync(source, "utf8").split(/\n/);
    const targetDir = path.join(home, ".noid-swap");
    const target = path.join(targetDir, "hashlocks.txt");
    fs.mkdirSync(targetDir, { recursive: true, mode: 0o700 });
    const tst = lst(target);
    let existingText = "";
    if (tst) {
      if (!tst.isFile() || tst.size > HASHLOCK_MAX * 4) throw new ImportRefused("the program's hashlocks.txt is not a plain file");
      existingText = fs.readFileSync(target, "utf8");
    }
    const key = (r) => `${r.hashlock} ${r.role || ""}`;
    const have = new Set();
    for (const l of existingText.split("\n")) {
      const r = parseHashlockLine(l);
      if (r) have.add(key(r));
    }
    let notMatching = 0;
    let already = 0;
    const add = [];
    for (const l of lines) {
      if (l.trim() === "") continue;
      const r = parseHashlockLine(l);
      if (!r) {
        notMatching++;
        continue;
      }
      if (have.has(key(r))) {
        already++;
        continue;
      }
      have.add(key(r));
      add.push(`${r.hashlock}${r.role ? ` ${r.role}` : ""}\n`);
    }
    if (add.length) {
      const prefix = existingText && !existingText.endsWith("\n") ? "\n" : "";
      fs.appendFileSync(target, prefix + add.join(""), { flag: "a", mode: 0o600 });
    }
    return { imported: add.length, already_there: already, not_matching: notMatching };
  }

  // ---- the import
  async function doImport(src) {
    if (typeof src !== "string" || !path.isAbsolute(src)) throw new ImportRefused("the folder is not an absolute path");
    plainDir(src, "the folder");
    const realSrc = fs.realpathSync.native ? fs.realpathSync.native(src) : fs.realpathSync(src);
    const realRuns = (() => {
      try {
        return fs.realpathSync.native ? fs.realpathSync.native(runsDir) : fs.realpathSync(runsDir);
      } catch {
        return runsDir;
      }
    })();
    const rel = path.relative(realRuns, realSrc);
    if (rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel))) throw new ImportRefused("that folder is already inside the program's runs folder");
    if (lst(path.join(src, MOVED))) throw new ImportRefused("this folder was already imported");
    if (lst(path.join(src, "run.json"))) throw new ImportRefused("the folder already has a run.json: it is not a folder of the bash helpers");
    const env = lst(path.join(src, "env.local.sh"));
    if (!env || !env.isFile()) throw new ImportRefused("the folder has no env.local.sh: it is not a run folder of the bash helpers");
    checkNotLive(src);
    const swap = await swapState(src);
    const oldPass = readOldPassphrase(src);
    if (swap.file && oldPass === null) throw new ImportRefused("the swap file has no passphrase.txt beside it: it could not be opened");
    let role = swap.role || roleFromEnvLocal(src);
    if (!role) {
      let answer = null;
      try {
        answer = typeof secretUi.askChoice === "function" ? await secretUi.askChoice({ kind: "import-role", options: ["alice", "bob"] }) : null;
      } catch {
        answer = null;
      }
      if (answer !== "alice" && answer !== "bob") throw new ImportRefused("the role of this run could not be told");
      role = answer;
    }

    // staging
    fs.mkdirSync(runsDir, { recursive: true, mode: 0o700 });
    rmTree(importingDir);
    fs.mkdirSync(importingDir, { recursive: true, mode: 0o700 });
    const staging = path.join(importingDir, randomBytes(8).toString("hex"));
    fs.mkdirSync(staging, { mode: 0o700 });
    let finalDir = null;
    let renamed = false;
    try {
      copyTree(src, staging, { files: 0, bytes: 0 }, true);
      let settings;
      try {
        settings = runsettings().migrateFromEnvLocal(staging, { role }).settings;
      } catch (e) {
        throw new ImportRefused(e && e.message ? String(e.message).slice(0, 300) : "env.local.sh could not be migrated");
      }
      const id = settings.run_id;
      if (!derive.isRunId(id)) throw new ImportRefused("the new run id is not valid");
      finalDir = path.join(runsDir, id);
      if (lst(finalDir)) throw new ImportRefused("a run folder of that id already exists");
      fs.mkdirSync(path.join(staging, "pub"), { recursive: true, mode: 0o700 });
      writeRunFiles(staging);
      // the old passphrase, sealed, read back
      if (oldPass !== null) {
        vault.writeMigratedPassphrase(staging, id, oldPass);
        const back = vault.passphraseFor(staging, id);
        const a = Buffer.from(back, "utf8");
        const b = Buffer.from(oldPass, "utf8");
        if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) throw new ImportRefused("the sealed passphrase did not read back: nothing was changed");
      }
      // the board's keys
      const bk = path.join(staging, "board-keys.json");
      if (lst(bk)) {
        try {
          makeKeyStore(staging, vault.boardSealer(id));
        } catch {
          throw new ImportRefused("board-keys.json could not be read and sealed: remove it by hand if it is not needed");
        }
        let o = null;
        try {
          o = JSON.parse(fs.readFileSync(bk, "utf8"));
        } catch {
          o = null;
        }
        if (!sealed.isEnvelope(o)) throw new ImportRefused("board-keys.json was not sealed");
      }
      // into place
      fs.renameSync(staging, finalDir);
      renamed = true;
      // the original: its clear passphrase goes, only now
      const warnings0 = [];
      if (oldPass !== null) {
        try {
          fs.unlinkSync(path.join(src, "passphrase.txt"));
        } catch {
          if (lst(path.join(src, "passphrase.txt")) === null) {
            // the system threw after it had deleted the file: the sealed copy is now the only one, so the new folder stays
            warnings0.push("the old passphrase.txt was removed although the system reported an error: the sealed copy in the new folder is the only one");
          } else {
            rmTree(finalDir);
            renamed = false;
            throw new ImportRefused("the old passphrase.txt could not be deleted: nothing was changed");
          }
        }
      }
      const warnings = [...warnings0];
      try {
        fs.writeFileSync(path.join(src, MOVED), `This run folder was imported into the No1d Swap program as run ${id}.\nThe program's folder is ${finalDir}\nDo not act on this folder any more: the program does.\n`, { flag: "wx", mode: 0o600 });
      } catch {
        warnings.push("the note MOVED-TO-NO1D-SWAP.txt could not be written in the old folder");
      }
      const audit = [];
      try {
        const log = makeAudit(path.join(finalDir, "pub"));
        const line = (action, result, detail) => log.append({ action, role, phase: "import", result, detail });
        line("import-copy", "ok", "run folder copied and compared");
        if (oldPass !== null) line("import-passphrase", "ok", "old passphrase sealed, read back, old file deleted");
        else line("import-passphrase", "none", "no passphrase file");
        if (lst(path.join(finalDir, "board-keys.json"))) line("import-board-keys", "ok", "board keys sealed");
        audit.push("written");
      } catch {
        warnings.push("the import's audit lines could not be written");
      }
      const lockRecords = await importHomeRecords();
      try {
        sealed.writeAtomic(path.join(finalDir, "import.json"), Buffer.from(`${JSON.stringify({ v: 1, lock_records: lockRecords.state, imported: lockRecords.imported || 0, already_there: lockRecords.already_there || 0, not_matching: lockRecords.not_matching || 0 })}\n`), fs);
      } catch {
        warnings.push("import.json could not be written");
      }
      try {
        const log = makeAudit(path.join(finalDir, "pub"));
        log.append({ action: "import-lock-records", role, phase: "import", result: lockRecords.state, detail: `imported ${lockRecords.imported || 0}, already there ${lockRecords.already_there || 0}, not matching ${lockRecords.not_matching || 0}` });
      } catch {
        /* the warning above covers it */
      }
      return { ok: true, swapId: id, role, lockRecords, warnings };
    } catch (e) {
      if (!renamed) rmTree(staging);
      throw e;
    }
  }

  async function importRun() {
    if (busy) return { ok: false, why: "an import is already running" };
    busy = true;
    try {
      const allowed = vault.newSwapAllowed();
      if (!allowed.ok) {
        await tell({ kind: "not-imported", reason: "the vault is not ready" });
        return { ok: false, why: allowed.why };
      }
      let src = null;
      try {
        src = typeof secretUi.askFolder === "function" ? await secretUi.askFolder({ kind: "import-run" }) : null;
      } catch {
        src = null;
      }
      if (typeof src !== "string" || !src) return { ok: false, cancelled: true, why: "cancelled" };
      try {
        const r = await doImport(src);
        await tell({ kind: "imported", count: r.lockRecords.imported || 0, lockRecords: r.lockRecords.state });
        return r;
      } catch (e) {
        const why = e instanceof ImportRefused ? e.message : "the import failed: nothing was changed in the old folder";
        await tell({ kind: "not-imported", reason: why });
        return { ok: false, why };
      }
    } finally {
      busy = false;
    }
  }

  return { importRun, importLockRecords };
}

module.exports = { createMigrator, statusFromSwapCli, parseHashlockLine, ALLOWED_PHASES, ImportRefused };
