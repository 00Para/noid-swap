#!/usr/bin/env node
"use strict";
/*
 * The by-hand way back (piece 4, step 4.6; spec 6.3): turns the recovery code into the install secret, or into one run folder's swap passphrase, with no
 * program running. Runs under any Node 22 or later, or under the program's own binary with ELECTRON_RUN_AS_NODE=1. Standard library only.
 *
 *   node desktop/tools/recovery.js secret                 the recovery code on stdin; prints the install secret as 64 hex characters
 *   node desktop/tools/recovery.js passphrase <run folder>  the recovery code on stdin; prints that run folder's swap passphrase
 *
 * The code is read from STDIN only, never from an argument, so it is not left in a shell history. The secret and the passphrase are printed on stdout,
 * only when a person runs this, and nowhere else (no file, no log). A run folder that holds passphrase.sealed (an imported swap) is opened with the
 * migrated-passphrase key; any other run folder gets the derived passphrase. The run id is read from run.json, never from the folder's name.
 * A run folder whose vault-check.json is not this code's check is refused (the wrong code would give a passphrase that opens nothing).
 *
 * The same by openssl (checked against the test vector of the build spec, Appendix A):
 *   printf '%s' "no1d-swap/v1/swap-passphrase/$RUN_ID" | openssl dgst -sha256 -mac HMAC -macopt hexkey:$SECRET_HEX
 */

const fs = require("fs");
const path = require("path");
const derive = require("../lib/derive");
const rc = require("../lib/recoverycode");
const sealed = require("../lib/sealed");

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

/** The whole program, with its inputs and outputs given (the tests call this). Returns the exit code. */
function main(argv, { stdin, stdout, stderr, io = fs } = {}) {
  const [cmd, arg] = argv;
  const usage = () => {
    stderr("usage: recovery.js secret | recovery.js passphrase <run folder>   (the recovery code on stdin)");
    return 2;
  };
  if (cmd !== "secret" && cmd !== "passphrase") return usage();
  if (cmd === "secret" && argv.length !== 1) return usage();
  if (cmd === "passphrase" && (argv.length !== 2 || !arg)) return usage();
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
    stdout(passphraseOf(S, path.resolve(arg), io, stderr));
    return 0;
  } catch (e) {
    stderr(e && e.message ? String(e.message) : "failed");
    return 1;
  } finally {
    S.fill(0);
  }
}

module.exports = { main, passphraseOf };

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
