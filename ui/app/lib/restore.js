"use strict";
/*
 * Restore a swap from a sealed .no1dbackup file.
 *
 * Staging pattern (matching desktop/lib/migrate.js):
 *   1. Inspect outer wrapper & refuse if runs/<runId> or runs/.ended/<runId> already exists.
 *   2. Decrypt via program.openBackupFile with offline validation BEFORE vault adoption.
 *   3. Stage all files into runs/.importing/<random>/ with mode 0600, verify every SHA-256,
 *      apply optional Parano1d node address overrides (validated via runsettings), apply owner-only ACL.
 *   4. Run offline swap-cli verification (status + verify-sealed) and read-only chain check.
 *   5. Write written-by.json, vault-check.json, restored.json, then atomically rename to runs/<runId>/.
 *   6. Append hashlock line once to <home>/.noid-swap/hashlocks.txt and write per-user lock records
 *      to <home>/.noid-swap/lock-sent/ ONLY when absent (wx flag, real os.userInfo().homedir).
 *   7. Any failure before the rename deletes the staged folder cleanly and leaves nothing behind.
 */

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const childProcess = require("child_process");
const runsettings = require("./runsettings");
const BS = require("./backupset");

const RESTORED_FILE = "restored.json";
const HASHLOCK_LINE_RE = /^([0-9a-f]{64})(?:[ \t]+(alice|bob)(?:[ \t]+\S+)?)?[ \t]*$/;
const LOOPBACK_URL_RE = /^https?:\/\/(?:127\.0\.0\.1|\[::1\]|localhost)(?::\d{1,5})?(?:\/|$)/i;

function sha256Hex(buf) {
  return crypto.createHash("sha256").update(buf).digest("hex");
}

function writeAtomicMode(file, buf, fsm = fs) {
  const dir = path.dirname(file);
  fsm.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmp = path.join(dir, `.${path.basename(file)}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`);
  let fd = null;
  try {
    fd = fsm.openSync(tmp, "wx", 0o600);
    fsm.writeSync(fd, buf);
    if (typeof fsm.fsyncSync === "function") fsm.fsyncSync(fd);
    fsm.closeSync(fd);
    fd = null;
    fsm.renameSync(tmp, file);
  } catch (e) {
    if (fd !== null) {
      try {
        fsm.closeSync(fd);
      } catch {
        /* ignore */
      }
    }
    try {
      fsm.unlinkSync(tmp);
    } catch {
      /* ignore */
    }
    throw e;
  }
}

/** Appends `<hashlock> <role>\n` to `<home>/.noid-swap/hashlocks.txt` once (no duplicates). */
function appendHashlockOnce(homeDir, hashlock, role, fsm = fs) {
  const dir = path.join(homeDir, ".noid-swap");
  fsm.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const regPath = path.join(dir, "hashlocks.txt");
  let existing = "";
  try {
    existing = fsm.readFileSync(regPath, "utf8");
  } catch (e) {
    if (!e || e.code !== "ENOENT") throw e;
  }
  const lines = existing.split(/\r?\n/);
  for (const line of lines) {
    const m = HASHLOCK_LINE_RE.exec(line.trim());
    if (m && m[1] === hashlock && (!m[2] || m[2] === role)) return { added: false };
  }
  const prefix = existing.length > 0 && !existing.endsWith("\n") ? "\n" : "";
  fsm.appendFileSync(regPath, `${prefix}${hashlock} ${role}\n`, { mode: 0o600 });
  return { added: true };
}

/** Writes each validated per-user lock record ONLY if no file of that name already exists. */
function writeHomeLockRecords(homeDir, homeEntries, fsm = fs) {
  let written = 0;
  let kept = 0;
  for (const ent of homeEntries || []) {
    const relParts = ent.path.split("/");
    const dst = path.join(homeDir, ".noid-swap", ...relParts);
    fsm.mkdirSync(path.dirname(dst), { recursive: true, mode: 0o700 });
    try {
      fsm.writeFileSync(dst, ent.bytes, { flag: "wx", mode: 0o600 });
      written++;
    } catch (e) {
      if (e && e.code === "EEXIST") {
        kept++;
        continue;
      }
      throw e;
    }
  }
  return { written, kept };
}

/** Default offline verification using swap-cli status + swap-cli verify-sealed (passphrase via env, never argv). */
function defaultVerifySwap(program) {
  return async function verifySwap(stageDir, parsed) {
    if (!program || !program.tools || !Array.isArray(program.tools.swapCli) || !program.tools.swapCli.length) {
      return { ok: true };
    }
    const swapRel = parsed.role === "alice" ? "alice.swap.json" : path.join("bob", "bob.swap.json");
    const swapPath = path.join(stageDir, swapRel);
    const argv = program.tools.swapCli;

    const runCli = (args, extraEnv = {}) =>
      new Promise((resolve) => {
        const env = {};
        for (const k of ["PATH", "SystemRoot", "SYSTEMROOT", "WINDIR", "TEMP", "TMP", "LANG"]) {
          if (process.env[k]) env[k] = process.env[k];
        }
        Object.assign(env, extraEnv);
        childProcess.execFile(
          argv[0],
          [...argv.slice(1), ...args],
          { env, shell: false, windowsHide: true, timeout: 30000, maxBuffer: 1024 * 1024, encoding: "utf8" },
          (err, stdout, stderr) => resolve({ ok: !err, stdout: stdout || "", stderr: stderr || "" }),
        );
      });

    // 1. swap-cli status (rebuilds opening byte-for-byte through M0.6 guard on load)
    const st = await runCli(["status", swapPath]);
    if (!st.ok) return { ok: false, why: "The swap file inside this backup did not pass verification." };
    let sj;
    try {
      sj = JSON.parse(st.stdout);
    } catch {
      return { ok: false, why: "The swap file inside this backup could not be read." };
    }
    if (sj.role !== parsed.role || sj.profile !== parsed.profile) {
      return { ok: false, why: "This backup's header does not match its swap file." };
    }

    // 2. swap-cli verify-sealed (opens every sealed field with passphrase derived for this run)
    if (program.vault && typeof program.vault.passphraseFor === "function") {
      let pass;
      try {
        pass = program.vault.passphraseFor(stageDir, parsed.run_id);
      } catch {
        return { ok: false, why: "This installation's recovery code cannot derive the swap passphrase." };
      }
      const vs = await runCli(["verify-sealed", swapPath], { SWAP_PASSPHRASE: pass });
      if (!vs.ok) return { ok: false, why: "The sealed keys inside this backup could not be opened." };
    }
    return { ok: true, status: sj };
  };
}

/** Validates optional Parano1d node address overrides (mainnet Bob requires a loopback Parano1d node). */
function applyNodeOverrides(runObj, overrides) {
  if (!overrides || typeof overrides !== "object") return { ok: true, runObj };
  const next = { ...runObj };
  for (const field of ["noid_rpc", "noid_rpc2"]) {
    if (overrides[field] === undefined || overrides[field] === null || overrides[field] === "") continue;
    const val = String(overrides[field]).trim();
    if (!/^https?:\/\/[^\s]+$/i.test(val)) {
      return { ok: false, why: `Invalid node address for ${field}.` };
    }
    // Mainnet Bob requires a local loopback Parano1d node (runsettings / nodecheck rule).
    if (next.profile === "production" && next.role === "bob" && field === "noid_rpc" && !runsettings.isLoopbackUrl(val)) {
      return { ok: false, why: "On Ethereum mainnet, Bob's Parano1d node must be a local loopback address (127.0.0.1 or [::1])." };
    }
    next[field] = val;
  }
  return { ok: true, runObj: next };
}

function readRestoredMarker(runDir, fsm = fs) {
  const p = path.join(runDir, RESTORED_FILE);
  try {
    const st = fsm.lstatSync(p);
    if (!st.isFile() || st.size > 8192) return null;
    const o = JSON.parse(fsm.readFileSync(p, "utf8"));
    return o && o.v === 1 ? o : null;
  } catch {
    return null;
  }
}

function writeRestoredMarker(runDir, obj, fsm = fs) {
  writeAtomicMode(path.join(runDir, RESTORED_FILE), Buffer.from(`${JSON.stringify(obj, null, 2)}\n`, "utf8"), fsm);
}

function createRestorer({ program, swapSet, verifySwap, readChainTick, homeDir, now = Date.now, fs: fsm = fs } = {}) {
  const verifyFn = verifySwap || defaultVerifySwap(program);

  function alreadyOnComputer(runId) {
    const runsDir = program.runsDir;
    for (const p of [path.join(runsDir, runId), path.join(runsDir, ".ended", runId)]) {
      try {
        fsm.lstatSync(p);
        return true;
      } catch (e) {
        if (!e || e.code !== "ENOENT") return true;
      }
    }
    return false;
  }

  /**
   * Restores a backup file into `program.runsDir/<runId>/`.
   * Options:
   *   filePath?: string         — skip dialog (tests or retry with nodeOverrides)
   *   nodeOverrides?: { noid_rpc?, noid_rpc2? }  — optional Parano1d node address override
   */
  async function restore({ filePath = null, nodeOverrides = null } = {}) {
    if (!program || typeof program.inspectBackupFile !== "function" || typeof program.openBackupFile !== "function") {
      return { ok: false, status: 409, code: "unavailable", error: "Restore is available in the desktop program only." };
    }

    // 1. Choose file
    let chosen = filePath;
    if (!chosen) {
      if (typeof program.chooseBackupFile !== "function") {
        return { ok: false, status: 409, code: "unavailable", error: "Restore dialog is not available." };
      }
      chosen = await program.chooseBackupFile();
      if (!chosen) return { ok: false, status: 200, code: "cancelled", error: "cancelled" };
    }

    // 2. Inspect outer wrapper BEFORE any vault interaction
    let outer;
    try {
      outer = program.inspectBackupFile(chosen);
    } catch (e) {
      return { ok: false, status: 422, code: (e && e.code) || "damaged", error: (e && e.message) || "This file is damaged. Try another copy." };
    }
    if (alreadyOnComputer(outer.runId)) {
      return { ok: false, status: 409, code: "already_here", error: "This swap is already on this computer." };
    }

    // 3. Decrypt and run offline validation BEFORE adopting the vault secret
    let opened;
    try {
      opened = await program.openBackupFile(chosen, {
        validateParsed: (parsed) => {
          const runEnt = parsed.files.find((f) => f.path === "run.json");
          let runObj;
          try {
            runObj = JSON.parse(runEnt.bytes.toString("utf8"));
          } catch {
            const err = new Error("This file is damaged. Try another copy.");
            err.code = "damaged";
            throw err;
          }
          if (runObj.board || runObj.handover) {
            const err = new Error("Board swaps cannot be restored in this version.");
            err.code = "unsupported";
            throw err;
          }
          const ov = applyNodeOverrides(runObj, nodeOverrides);
          if (!ov.ok) {
            const err = new Error(ov.why);
            err.code = "invalid_node";
            throw err;
          }
          // Check run.json against runsettings rules via temp validation when available
          if (typeof runsettings.validate === "function") {
            // validate() returns the list of problems (empty = valid); audit of 0.2.0, L-1
            const probs = runsettings.validate(ov.runObj);
            if (!Array.isArray(probs) || probs.length) {
              const err = new Error("This backup's settings are not valid for this program.");
              err.code = "invalid_settings";
              throw err;
            }
          }
        },
      });
    } catch (e) {
      const code = (e && e.code) || "open_failed";
      const status = code === "cancelled" ? 200 : code === "other-install" ? 409 : 422;
      return { ok: false, status, code, error: (e && e.message) || "This backup could not be opened." };
    }

    const { parsed, adopted } = opened;
    const runId = parsed.run_id;
    const runsDir = program.runsDir;
    const importRoot = path.join(runsDir, ".importing");
    const stageDir = path.join(importRoot, `restore-${crypto.randomBytes(8).toString("hex")}`);
    const finalDir = path.join(runsDir, runId);

    const cleanupStage = () => {
      try {
        // a few tries: on Windows a child of a killed chain read can still hold the stage folder as its working directory (EBUSY, EPERM)
        fsm.rmSync(stageDir, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
      } catch {
        /* ignore */
      }
    };

    let chainSummary = null;
    try {
      // 4. Stage files with mode 0600 and compare every SHA-256
      fsm.mkdirSync(stageDir, { recursive: true, mode: 0o700 });
      if (typeof program.makeOwnerOnlyDir === "function") program.makeOwnerOnlyDir(stageDir);

      let stagedRunObj = null;
      for (const ent of parsed.files) {
        const dst = path.join(stageDir, ...ent.path.split("/"));
        let bytes = ent.bytes;
        if (ent.path === "run.json") {
          const parsedRun = JSON.parse(bytes.toString("utf8"));
          const ov = applyNodeOverrides(parsedRun, nodeOverrides);
          if (!ov.ok) throw Object.assign(new Error(ov.why), { code: "invalid_node" });
          stagedRunObj = ov.runObj;
          if (nodeOverrides) bytes = Buffer.from(`${JSON.stringify(stagedRunObj, null, 2)}\n`, "utf8");
        }
        writeAtomicMode(dst, bytes, fsm);
        const writtenSha = sha256Hex(fsm.readFileSync(dst));
        const wantSha = ent.path === "run.json" && nodeOverrides ? sha256Hex(bytes) : ent.sha256;
        if (writtenSha !== wantSha) throw Object.assign(new Error("This file is damaged. Try another copy."), { code: "damaged" });
        if (process.platform !== "win32") {
          try {
            fsm.chmodSync(dst, 0o600);
          } catch {
            /* ignore */
          }
        }
      }

      // Write vault-check.json & written-by.json into stageDir so verify-sealed / passphraseFor work
      const check = program.vault && typeof program.vault.keyCheck === "function" ? program.vault.keyCheck() : null;
      if (check) {
        writeAtomicMode(path.join(stageDir, "vault-check.json"), Buffer.from(`${JSON.stringify({ v: 1, check })}\n`, "utf8"), fsm);
      }
      writeAtomicMode(
        path.join(stageDir, "written-by.json"),
        Buffer.from(`${JSON.stringify({ v: 1, program_version: program.version || "0.2.0" })}\n`, "utf8"),
        fsm,
      );

      // Enforce owner-only permissions on staged folder and bob/ subfolder
      if (typeof program.makeOwnerOnlyDir === "function") {
        program.makeOwnerOnlyDir(stageDir);
        const bobDir = path.join(stageDir, "bob");
        if (fsm.existsSync(bobDir)) program.makeOwnerOnlyDir(bobDir);
      }

      // 5. Offline swap-cli verification (status + verify-sealed)
      const vres = await verifyFn(stageDir, parsed);
      if (!vres || !vres.ok) {
        cleanupStage();
        return { ok: false, status: 422, code: "verify_failed", error: (vres && vres.why) || "The swap file inside this backup could not be verified." };
      }

      // 6. Optional read-only chain check (no --apply): if node is unreachable, stop and leave nothing behind
      let firstRead = null;
      if (typeof readChainTick === "function") {
        const cr = await readChainTick(stageDir, parsed, stagedRunObj);
        if (!cr || !cr.ok) {
          cleanupStage();
          if (cr && cr.what === "other") {
            // the cause is not known: neither node is named as certain, and the page does not send the person to the node fields
            const why = typeof cr.detail === "string" && cr.detail ? cr.detail : "the tool stopped without a message";
            return { ok: false, status: 503, code: "chain_read_failed", error: `No1d Swap could not read the chains this swap uses (${why}). Check the node settings and your connection, then press Try again.` };
          }
          const nodeName = (cr && cr.node) || (stagedRunObj && stagedRunObj.noid_rpc) || "127.0.0.1";
          const what = cr && cr.what === "ethereum" ? "the Ethereum node" : "the Parano1d node";
          return {
            ok: false,
            status: 503,
            code: "node_unreachable",
            node: nodeName,
            error: `No1d Swap cannot reach ${what} this swap uses (${nodeName}). Start it, then press Try again.`,
          };
        }
        if (Number.isSafeInteger(cr.noid_tip) && Number.isSafeInteger(cr.eth_block)) {
          firstRead = { noid_tip: cr.noid_tip, eth_block: cr.eth_block, at: new Date(now()).toISOString() };
        }
        chainSummary = cr.summary || null;
      }

      // 7. Write restored.json (no autopilot-*.json is ever restored: new approval required!)
      const restoredMarker = {
        v: 1,
        restored_at: new Date(now()).toISOString(),
        backup_seq: parsed.seq,
        backup_made_at: parsed.made_at,
        backup_phase: parsed.phase,
        first_read: firstRead,
      };
      writeRestoredMarker(stageDir, restoredMarker, fsm);

      // Re-check finalDir does not exist right before atomic rename
      if (alreadyOnComputer(runId)) {
        cleanupStage();
        return { ok: false, status: 409, code: "already_here", error: "This swap is already on this computer." };
      }
      fsm.renameSync(stageDir, finalDir);
    } catch (e) {
      cleanupStage();
      return { ok: false, status: 422, code: (e && e.code) || "restore_failed", error: (e && e.message) || "The backup could not be restored." };
    }

    // 8. Post-rename home-folder records (always uses the real user home directory; never overwrites an existing lock record).
    // Never swallow write errors silently: record plain-English warnings so the person knows what was not written and what to do.
    const home = BS.realHomeDir(homeDir);
    const warnings = [];
    let hashlockAdded = false;
    let lockRecordsWritten = 0;
    let lockRecordsKept = 0;
    try {
      const reg = appendHashlockOnce(home, parsed.registry.hashlock, parsed.registry.role, fsm);
      hashlockAdded = reg.added;
    } catch (e) {
      warnings.push(
        `The swap was restored, but its hashlock line could not be written to your home safety list (~/.noid-swap/hashlocks.txt: ${(e && (e.code || e.message)) || "write failed"}). Check permissions on ~/.noid-swap and do not start another swap with the same secret.`
      );
    }
    try {
      const lr = writeHomeLockRecords(home, parsed.home, fsm);
      lockRecordsWritten = lr.written;
      lockRecordsKept = lr.kept;
    } catch (e) {
      warnings.push(
        `The swap was restored, but its per-user Ethereum lock record could not be written to ~/.noid-swap/lock-sent/ (${(e && (e.code || e.message)) || "write failed"}). Check permissions on ~/.noid-swap before sending an Ethereum lock.`
      );
    }
    if (warnings.length > 0) {
      try {
        const cur = readRestoredMarker(finalDir, fsm) || { v: 1, restored_at: new Date(now()).toISOString(), backup_seq: parsed.seq, backup_made_at: parsed.made_at, backup_phase: parsed.phase, first_read: null };
        writeRestoredMarker(finalDir, { ...cur, home_warnings: warnings }, fsm);
      } catch {
        /* warnings are still returned directly to the restore screen */
      }
    }
    const homeResult = { hashlockAdded, lockRecordsWritten, lockRecordsKept };

    if (swapSet && typeof swapSet.scan === "function") {
      try {
        swapSet.scan();
      } catch {
        /* ignore */
      }
    }

    return {
      ok: true,
      status: 200,
      swap: runId,
      role: parsed.role,
      profile: parsed.profile,
      backup_phase: parsed.phase,
      backup_made_at: parsed.made_at,
      adopted,
      chain: chainSummary,
      home: homeResult,
      warnings,
    };
  }

  return { restore, alreadyOnComputer };
}

module.exports = {
  RESTORED_FILE,
  createRestorer,
  readRestoredMarker,
  writeRestoredMarker,
  appendHashlockOnce,
  writeHomeLockRecords,
  applyNodeOverrides,
};
