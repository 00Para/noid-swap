"use strict";
/*
 * The single source of truth for what goes into a per-swap backup.
 * Pure Node.js built-ins only; no Electron, no child-process spawns.
 *
 * Read order: readSnapshot() reads record files and markers FIRST, and the role's swap file LAST,
 * so a phase never appears in a backup without the send/lock/reveal record written before it.
 *
 * Safety digest: computeSafetyDigest() reads the phase/intent/history count from the last tick (or directly
 * from the public JSON of the swap file) plus the SHA-256 of every included file other than the swap file
 * and run.json, plus run.json's SHA-256 — no `swap-cli status` spawn every 3 s.
 *
 * Audit log: pub/ui-audit.jsonl IS included (under the 1 MiB plain-text cap), while other pub/* copies stay excluded.
 */

const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");

const BACKUP_STATE_FILE = "backup-state.json";
const HEX64 = /^[0-9a-f]{64}$/;
const HEX40 = /^[0-9a-f]{40}$/;

/** Included files in snapshot read order: records & markers FIRST, run.json & swap files LAST. */
const RECORD_FILES = Object.freeze([
  "alice.swap.json.wallet-fund.json",
  "alice.swap.json.wallet-recover.json",
  "alice.swap.json.wallet-sweep.json",
  "alice.swap.json.reveal-sent",
  "alice.swap.json.reveal-fees",
  "bob/bob.swap.json.lock-sent",
  "bob/bob.swap.json.producer-differs",
  "bob/bob.swap.json.wallet-fund.json",
  "bob/bob.swap.json.wallet-recover.json",
  "bob/bob.swap.json.wallet-sweep.json",
]);

const OTHER_INCLUDED_FILES = Object.freeze([
  "hashlocks.txt",
  "alice.bundle.json",
  "eth-deploy-block.txt",
  "wallet-addresses.txt",
  "check-line.json",
  "line-match.json",
  "join-new-bob.out",
  "new-alice.err",
  "wallet-funded.marker",
  "wallet-swept-noid.marker",
  "wallet-swept-eth-alice.marker",
  "wallet-swept-eth-bob.marker",
  "settlement.json",
  "passphrase.sealed",
  "pub/ui-audit.jsonl",
  "offer-post.json",
]);

const SWAP_FILES = Object.freeze(["alice.swap.json", "bob/bob.swap.json"]);

const INCLUDED_FILES = Object.freeze([...RECORD_FILES, ...OTHER_INCLUDED_FILES, "run.json", ...SWAP_FILES]);
const INCLUDED_SET = new Set(INCLUDED_FILES);
const RECORD_SET = new Set(RECORD_FILES);

/** Exact patterns for files intentionally left out of the backup. */
const EXCLUDED_EXACT = new Set([
  "autopilot-alice.json",
  "autopilot-bob.json",
  "ui-console.lock",
  "written-by.json",
  "vault-check.json",
  "backup-state.json",
  "restored.json",
  "passphrase.txt",
  "env.local.sh",
  "board-keys.json",
  "handover.json",
  "alice.swap.json.lock",
  "alice.swap.json.lock-lock",
  "alice.swap.json.claim-lock",
  "alice.swap.json.producers",
  "bob/bob.swap.json.lock",
  "bob/bob.swap.json.lock-lock",
  "bob/bob.swap.json.claim-lock",
  "bob/bob.swap.json.producers",
]);

const EXCLUDED_PATTERNS = Object.freeze([
  /^autopilot-(?:alice|bob)\.json$/,
  /\.lock$/,
  /\.lock-lock$/,
  /\.claim-lock$/,
  /\.tmp$/,
  /\.producers$/,
  /^last-tick-/,
  /^loop-/,
  /^(?:wallet-fund|wallet-recover|wallet-sweep|eth-lock|eth-reveal|eth-refund|lock-precheck|reveal-precheck|claim|dry|setup|prepare|join|tick|self-test|selftest|watch|wallet-status|reserve|sweep|recover|refund|reveal|fund)[^/]*\.(?:json|err|out|txt)$/,
  /^deposit-seen/,
  /^wallet-setup\//,
  /^bin\//,
  /^board-/,
  /^handover-/,
  /^pub\/(?!ui-audit\.jsonl$).+/,
  /\.refused-/,
  /\.stale-/,
  /^\./,
]);

/** Classifies a run-folder relative path as "include", "exclude", or "unknown". */
function classifyPath(relPath) {
  if (typeof relPath !== "string" || !relPath) return "unknown";
  const norm = relPath.replace(/\\/g, "/");
  if (INCLUDED_SET.has(norm)) return "include";
  if (EXCLUDED_EXACT.has(norm)) return "exclude";
  for (const re of EXCLUDED_PATTERNS) {
    if (re.test(norm)) return "exclude";
  }
  return "unknown";
}

function sha256Hex(buf) {
  return crypto.createHash("sha256").update(buf).digest("hex");
}

function swapFileRel(role) {
  return role === "alice" ? "alice.swap.json" : role === "bob" ? "bob/bob.swap.json" : null;
}

/** Reads a plain regular file (never a symlink) up to maxBytes, else null. */
function readPlainIfExists(absPath, maxBytes = 1024 * 1024, fsm = fs) {
  let st;
  try {
    st = fsm.lstatSync(absPath);
  } catch (e) {
    if (e && e.code === "ENOENT") return null;
    throw e;
  }
  if (!st.isFile() || st.size > maxBytes) return null;
  return fsm.readFileSync(absPath);
}

/** Resolves the real OS home directory (matching live.js's os.userInfo().homedir). */
function realHomeDir(override) {
  if (typeof override === "string" && override) return override;
  try {
    return os.userInfo().homedir;
  } catch {
    return os.homedir();
  }
}

/** Extracts public metadata from parsed swap file JSON (no passphrase needed). */
function publicMetaFromSwap(swapObj) {
  if (!swapObj || typeof swapObj !== "object") return null;
  const pub = swapObj.public || {};
  const params = pub.params || {};
  const eth = params.eth || {};
  const hashlock = typeof pub.hashlock === "string" ? pub.hashlock.replace(/^0x/i, "").toLowerCase() : null;
  const bobSender = typeof eth.bob_sender === "string" ? eth.bob_sender.replace(/^0x/i, "").toLowerCase() : null;
  const phase = swapObj.phase && typeof swapObj.phase === "object" && typeof swapObj.phase.phase === "string" ? swapObj.phase.phase : null;
  const pendingAction = swapObj.pending_action && typeof swapObj.pending_action === "object" ? swapObj.pending_action.kind || null : null;
  const pendingIntent = swapObj.pending_intent && typeof swapObj.pending_intent === "object" ? swapObj.pending_intent.action || null : null;
  const historyCount = Array.isArray(swapObj.history) ? swapObj.history.length : 0;
  return {
    role: swapObj.role || null,
    phase,
    phaseDetail: swapObj.phase || null,
    pendingAction,
    pendingIntent,
    historyCount,
    hashlock: hashlock && HEX64.test(hashlock) ? hashlock : null,
    bobSender: bobSender && HEX40.test(bobSender) ? bobSender : null,
    chainId: Number.isSafeInteger(eth.chain_id) ? eth.chain_id : null,
    profile: typeof params.profile === "string" ? params.profile : "production",
  };
}

/**
 * Reads a consistent backup snapshot from `runDir` (record files FIRST, swap file LAST).
 * Returns `{ runId, role, profile, chainId, phase, registry, files, home, safetyDigest, recordHash }`, or null when not ready.
 */
function readSnapshot(runDir, role, { homeDir, tick, fs: fsm = fs } = {}) {
  const sfRel = swapFileRel(role);
  if (!sfRel) return null;

  // Read record files FIRST, then other included files, then run.json, then the swap file LAST.
  const files = [];
  const otherHashes = [];
  const recordHashes = [];

  const order = [...RECORD_FILES, ...OTHER_INCLUDED_FILES];
  for (const rel of order) {
    // Only include the current role's swap sidecars
    if (role === "alice" && rel.startsWith("bob/")) continue;
    if (role === "bob" && rel.startsWith("alice.swap.json.")) continue;
    const abs = path.join(runDir, ...rel.split("/"));
    const bytes = readPlainIfExists(abs, 512 * 1024, fsm);
    if (bytes === null) continue;
    const sha = sha256Hex(bytes);
    files.push({ path: rel, sha256: sha, b64: bytes.toString("base64"), bytes });
    otherHashes.push([rel, sha]);
    if (RECORD_SET.has(rel)) recordHashes.push([rel, sha]);
  }

  const runBytes = readPlainIfExists(path.join(runDir, "run.json"), 65536, fsm);
  if (runBytes === null) return null;
  let runObj;
  try {
    runObj = JSON.parse(runBytes.toString("utf8"));
  } catch {
    return null;
  }
  const runSha = sha256Hex(runBytes);
  files.push({ path: "run.json", sha256: runSha, b64: runBytes.toString("base64"), bytes: runBytes });

  // Swap file is read LAST so its phase cannot get ahead of the records read above.
  const swapBytes = readPlainIfExists(path.join(runDir, ...sfRel.split("/")), 512 * 1024, fsm);
  if (swapBytes === null) return null;
  let swapObj;
  try {
    swapObj = JSON.parse(swapBytes.toString("utf8"));
  } catch {
    return null;
  }
  const meta = publicMetaFromSwap(swapObj);
  if (!meta || meta.role !== role || !meta.hashlock || !meta.phase) return null;
  files.push({ path: sfRel, sha256: sha256Hex(swapBytes), b64: swapBytes.toString("base64"), bytes: swapBytes });

  const chainId = meta.chainId || Number(runObj.chain_id) || (runObj.profile === "production" ? 1 : 11155111);
  const home = [];
  if (meta.bobSender && meta.hashlock) {
    const lockName = `${chainId}-${meta.bobSender}-${meta.hashlock}.json`;
    const homeRel = `lock-sent/${lockName}`;
    const homeAbs = path.join(realHomeDir(homeDir), ".noid-swap", "lock-sent", lockName);
    const hBytes = readPlainIfExists(homeAbs, 16384, fsm);
    if (hBytes !== null) {
      const hSha = sha256Hex(hBytes);
      home.push({ path: homeRel, sha256: hSha, b64: hBytes.toString("base64"), bytes: hBytes });
      otherHashes.push([`home:${homeRel}`, hSha]);
      recordHashes.push([`home:${homeRel}`, hSha]);
    }
  }

  // Compute safety digest from tick (when matching) or swap file's public fields + run.json + other files (zero child spawn).
  const phase = (tick && typeof tick.phase_after === "string" && tick.phase_after) || meta.phase;
  const pendingIntent =
    tick && tick.pending_intent && typeof tick.pending_intent === "object"
      ? tick.pending_intent.action || null
      : meta.pendingIntent;
  const historyCount =
    tick && Number.isSafeInteger(tick.history_count) ? tick.history_count : meta.historyCount;

  otherHashes.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  recordHashes.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));

  const digestInput = JSON.stringify({
    v: 1,
    phase,
    pending_action: meta.pendingAction,
    pending_intent: pendingIntent,
    history_count: historyCount,
    run_sha: runSha,
    files: otherHashes,
  });
  const safetyDigest = sha256Hex(Buffer.from(digestInput, "utf8"));
  const recordHash = sha256Hex(Buffer.from(JSON.stringify(recordHashes), "utf8"));

  return {
    runId: runObj.run_id,
    role,
    profile: runObj.profile || meta.profile,
    chainId,
    phase,
    registry: { hashlock: meta.hashlock, role },
    files,
    home,
    safetyDigest,
    recordHash,
  };
}

/** Fast digest computation (no base64 encoding, no child process spawn). */
function computeSafetyDigest(runDir, role, opts = {}) {
  const snap = readSnapshot(runDir, role, opts);
  if (!snap) return null;
  return {
    digest: snap.safetyDigest,
    recordHash: snap.recordHash,
    phase: snap.phase,
    hasSwapFile: true,
  };
}

function readBackupState(runDir, fsm = fs) {
  const p = path.join(runDir, BACKUP_STATE_FILE);
  const buf = readPlainIfExists(p, 16384, fsm);
  if (buf === null) return null;
  try {
    const o = JSON.parse(buf.toString("utf8"));
    if (!o || typeof o !== "object" || o.v !== 1) return null;
    return o;
  } catch {
    return null;
  }
}

function writeBackupState(runDir, state, fsm = fs) {
  const p = path.join(runDir, BACKUP_STATE_FILE);
  const tmp = path.join(runDir, `.${BACKUP_STATE_FILE}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`);
  const data = Buffer.from(`${JSON.stringify(state, null, 2)}\n`, "utf8");
  let fd = null;
  try {
    fd = fsm.openSync(tmp, "wx", 0o600);
    fsm.writeSync(fd, data);
    if (typeof fsm.fsyncSync === "function") fsm.fsyncSync(fd);
    fsm.closeSync(fd);
    fd = null;
    fsm.renameSync(tmp, p);
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

/** Public backup status for `/api/run` (never exposes the filesystem target path). */
function backupStatus(runDir, role, { tick, endedAndSwept = false, homeDir, fs: fsm = fs } = {}) {
  const st = readBackupState(runDir, fsm);
  if (endedAndSwept) {
    return {
      state: "not_needed",
      saved_at: st ? st.saved_at || null : null,
      phase_at_save: st ? st.phase_at_save || null : null,
      keep_updated: st ? st.keep_updated === true : false,
    };
  }
  if (!st || !st.saved_at) {
    return { state: "none", saved_at: null, phase_at_save: null, keep_updated: false };
  }
  if (st.last_error === "cannot_write") {
    return {
      state: "cannot_write",
      saved_at: st.saved_at,
      phase_at_save: st.phase_at_save || null,
      keep_updated: st.keep_updated === true,
    };
  }
  const cur = computeSafetyDigest(runDir, role, { tick, homeDir, fs: fsm });
  const upToDate = !!cur && cur.digest === st.digest;
  return {
    state: upToDate ? "up_to_date" : "out_of_date",
    saved_at: st.saved_at,
    phase_at_save: st.phase_at_save || null,
    keep_updated: st.keep_updated === true,
  };
}

module.exports = {
  BACKUP_STATE_FILE,
  RECORD_FILES,
  OTHER_INCLUDED_FILES,
  SWAP_FILES,
  INCLUDED_FILES,
  classifyPath,
  readSnapshot,
  computeSafetyDigest,
  readBackupState,
  writeBackupState,
  backupStatus,
  realHomeDir,
  publicMetaFromSwap,
};
