#!/usr/bin/env node
"use strict";
/*
 * The by-hand way back (piece 4, step 4.6; spec 6.3): turns the recovery code into the install secret, or into one run folder's swap passphrase, with no
 * program running. Runs under any Node 22 or later, or under the program's own binary with ELECTRON_RUN_AS_NODE=1. Standard library only.
 *
 *   node desktop/tools/recovery.js secret                       the recovery code on stdin; prints the install secret as 64 hex characters
 *   node desktop/tools/recovery.js passphrase <run folder>        the recovery code on stdin; prints that run folder's swap passphrase
 *   node desktop/tools/recovery.js backup-open <file> <outdir>    the recovery code on stdin; decrypts a .no1dbackup file into a new folder <outdir>
 *
 * The code is read from STDIN only, never from an argument, so it is not left in a shell history. The secret and the passphrase are printed on stdout,
 * only when a person runs this, and nowhere else (no file, no log). A run folder that holds passphrase.sealed (an imported swap) is opened with the
 * migrated-passphrase key; any other run folder gets the derived passphrase. The run id is read from run.json, never from the folder's name.
 * A run folder whose vault-check.json is not this code's check is refused (the wrong code would give a passphrase that opens nothing).
 *
 * The same by openssl (checked against the test vector of the build spec, Appendix A):
 *   printf '%s' "no1d-swap/v1/swap-passphrase/$RUN_ID" | openssl dgst -sha256 -mac HMAC -macopt hexkey:$SECRET_HEX
 */

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const derive = require("../lib/derive");
const rc = require("../lib/recoverycode");
const sealed = require("../lib/sealed");
const backupfile = require("../lib/backupfile");

function readSmall(io, file, max) {
  let st;
  try {
    st = io.lstatSync(file);
  } catch {
    return null;
  }
  if (!st.isFile() || st.size > max) throw new Error(`${path.basename(file)} is not a plain small file`);
  return io.readFileSync(file);
}

/** The run folder's passphrase for secret S; `note(text)` gets warnings. Throws Error with a fixed text. */
function passphraseOf(S, runDir, io, note) {
  const runJson = readSmall(io, path.join(runDir, "run.json"), 65536);
  if (runJson === null) throw new Error("there is no run.json in that folder");
  let id;
  try {
    id = JSON.parse(runJson.toString("utf8")).run_id;
  } catch {
    throw new Error("run.json is not JSON");
  }
  if (!derive.isRunId(id)) throw new Error("run.json has no valid run_id");
  const vc = readSmall(io, path.join(runDir, "vault-check.json"), 1024);
  if (vc === null) note("note: this folder has no vault-check.json: it cannot be checked against the code");
  else {
    let check = null;
    try {
      check = JSON.parse(vc.toString("utf8")).check;
    } catch {
      check = null;
    }
    if (check !== derive.keyCheck(S)) throw new Error("this recovery code is not the one of that run folder");
  }
  const sp = path.join(runDir, "passphrase.sealed");
  let present = true;
  try {
    io.lstatSync(sp);
  } catch (e) {
    if (e && e.code === "ENOENT") present = false;
    else throw new Error("passphrase.sealed cannot be examined");
  }
  if (!present) return derive.passphrase(S, id);
  const key = derive.migratedKey(S, id);
  try {
    const plain = sealed.readSealedFile(sp, { key, label: "migrated-passphrase", runId: id }, io);
    const t = plain.toString("utf8");
    plain.fill(0);
    return t;
  } finally {
    key.fill(0);
  }
}

/**
 * Opens a sealed `.no1dbackup` file into a brand-new folder `outDir` using install secret `S`.
 * Refuses an existing `outDir`, verifies every file's SHA-256, writes all files with mode 0600,
 * writes `vault-check.json` so `recovery.js passphrase <outDir>` works on the opened folder,
 * and returns a plain summary with zero secrets.
 */
function backupOpen(S, backupPath, outDir, io = fs) {
  let exists = true;
  try {
    io.lstatSync(outDir);
  } catch (e) {
    if (e && e.code === "ENOENT") exists = false;
    else throw new Error("output folder cannot be examined");
  }
  if (exists) throw new Error("output folder already exists: choose a new folder name");

  let st;
  try {
    st = io.lstatSync(backupPath);
  } catch {
    throw new Error("backup file cannot be read");
  }
  if (st.isSymbolicLink() || !st.isFile()) throw new Error("backup file must be a plain file");
  if (st.size > backupfile.MAX_OUTER_BYTES) throw new Error("backup file is too large");

  const raw = io.readFileSync(backupPath);
  const outer = backupfile.parseOuter(raw);

  const key = derive.backupKey(S, outer.runId);
  let plain = null;
  let parsed;
  try {
    try {
      plain = sealed.open({ envelope: outer.sealed, key, label: "swap-backup", runId: outer.runId, fileName: "swap-backup" });
    } catch {
      throw new Error("this recovery code does not open this backup (or the file is damaged)");
    }
    parsed = backupfile.parsePlain(plain, { expectedRunId: outer.runId });
  } finally {
    key.fill(0);
    if (plain) plain.fill(0);
  }

  let created = false;
  try {
    io.mkdirSync(outDir, { recursive: false, mode: 0o700 });
    created = true;
    for (const ent of parsed.files) {
      const dst = path.join(outDir, ...ent.path.split("/"));
      const parent = path.dirname(dst);
      if (parent !== outDir) io.mkdirSync(parent, { recursive: true, mode: 0o700 });
      io.writeFileSync(dst, ent.bytes, { flag: "wx", mode: 0o600 });
      const actualSha = crypto.createHash("sha256").update(io.readFileSync(dst)).digest("hex");
      if (actualSha !== ent.sha256) throw new Error("checksum mismatch after writing extracted file");
    }
    if (Array.isArray(parsed.home) && parsed.home.length > 0) {
      for (const ent of parsed.home) {
        const dst = path.join(outDir, "home", ...ent.path.split("/"));
        io.mkdirSync(path.dirname(dst), { recursive: true, mode: 0o700 });
        io.writeFileSync(dst, ent.bytes, { flag: "wx", mode: 0o600 });
        const actualSha = crypto.createHash("sha256").update(io.readFileSync(dst)).digest("hex");
        if (actualSha !== ent.sha256) throw new Error("checksum mismatch after writing extracted home record");
      }
    }
    // The restore marker the restore itself writes (the console reads it for the one-computer statement, the funding pause, the 2x refusal and Bob's self-test): a folder opened by
    // hand and moved into runs/ must run under the same gates (audit of 0.2.0, L-4). first_read stays null: the funding pause holds until the first good tick fills it.
    io.writeFileSync(
      path.join(outDir, "restored.json"),
      `${JSON.stringify({ v: 1, restored_at: new Date().toISOString(), backup_seq: parsed.seq, backup_made_at: parsed.made_at, backup_phase: parsed.phase, first_read: null }, null, 2)}
`,
      { flag: "wx", mode: 0o600 },
    );
    const vcPath = path.join(outDir, "vault-check.json");
    io.writeFileSync(vcPath, `${JSON.stringify({ v: 1, check: derive.keyCheck(S) })}\n`, { flag: "wx", mode: 0o600 });
  } catch (e) {
    if (created) {
      try {
        io.rmSync(outDir, { recursive: true, force: true });
      } catch {
        /* ignore cleanup failure */
      }
    }
    throw e;
  }

  return {
    run_id: parsed.run_id,
    role: parsed.role,
    profile: parsed.profile,
    phase: parsed.phase,
    files: parsed.files.length,
    home: parsed.home.length,
  };
}

/** The whole program, with its inputs and outputs given (the tests call this). Returns the exit code. */
function main(argv, { stdin, stdout, stderr, io = fs } = {}) {
  const [cmd, arg, arg2] = argv;
  const usage = () => {
    stderr("usage: recovery.js secret | recovery.js passphrase <run folder> | recovery.js backup-open <file> <outdir>   (the recovery code on stdin)");
    return 2;
  };
  if (cmd !== "secret" && cmd !== "passphrase" && cmd !== "backup-open") return usage();
  if (cmd === "secret" && argv.length !== 1) return usage();
  if (cmd === "passphrase" && (argv.length !== 2 || !arg)) return usage();
  if (cmd === "backup-open" && (argv.length !== 3 || !arg || !arg2)) return usage();
  let text;
  try {
    text = stdin();
  } catch {
    stderr("the recovery code could not be read from stdin");
    return 1;
  }
  let S;
  try {
    // stdin brings line ends (echo, a pasted block over several lines); the reading rules of the code itself know only spaces and hyphens
    S = rc.decode(String(text).replace(/[\r\n\t]+/g, " "));
  } catch (e) {
    stderr(e instanceof rc.RecoveryCodeError ? e.message : "the recovery code could not be read");
    return 1;
  }
  try {
    if (cmd === "secret") {
      stdout(S.toString("hex"));
      return 0;
    }
    if (cmd === "backup-open") {
      const info = backupOpen(S, path.resolve(arg), path.resolve(arg2), io);
      stdout(`opened ${info.run_id} (${info.role}, ${info.profile}, phase ${info.phase}, ${info.files} files${info.home ? `, ${info.home} home records` : ""})`);
      return 0;
    }
    stdout(passphraseOf(S, path.resolve(arg), io, stderr));
    return 0;
  } catch (e) {
    stderr(e && e.message ? String(e.message) : "failed");
    return 1;
  } finally {
    S.fill(0);
  }
}

module.exports = { main, passphraseOf, backupOpen };

if (require.main === module) {
  const code = main(process.argv.slice(2), {
    stdin: () => {
      if (process.stdin.isTTY) process.stderr.write("Type or paste the recovery code, then press Enter and then Ctrl-D (Ctrl-Z, Enter on Windows):\n");
      return fs.readFileSync(0, "utf8");
    },
    stdout: (t) => process.stdout.write(`${t}\n`),
    stderr: (t) => process.stderr.write(`${t}\n`),
  });
  process.exitCode = code;
}
