"use strict";
/*
 * Sealed per-swap backup file format. Pure module: no Electron, no disk I/O, no secrets kept.
 *
 * Outer JSON (.no1dbackup, ASCII JSON, <= 4 MiB):
 *   { "no1d_swap_backup": 1, "run_id": "<32 hex>", "sha256": "<64 hex>", "sealed": { ...sealed.js envelope... } }
 *   where `sha256` is SHA-256 of canonicalSealedJson(sealed) (fixed key order: v, alg, label, run_id, nonce, ct, tag).
 *   The sealed envelope uses label "swap-backup", run_id = <32 hex>, and fixed AAD fileName "swap-backup" so a renamed
 *   or cloud-duplicated file still opens.
 *
 * Inner plain text (UTF-8 JSON, <= 1 MiB):
 *   { "v": 1, "kind": "no1d-swap-backup", "made_by": "x.y.z", "made_at": "<UTC ISO>", "seq": <int>,
 *     "run_id": "<32 hex>", "role": "alice"|"bob", "profile": "sepolia"|"rehearsal"|"production", "chain_id": <int>,
 *     "phase": "<phase>", "safety_digest": "<64 hex>",
 *     "registry": { "hashlock": "<64 hex>", "role": "alice"|"bob" },
 *     "files": [ { "path": "...", "sha256": "<64 hex>", "b64": "<base64>" }, ... ],
 *     "home":  [ { "path": "lock-sent/<chain>-<40 hex>-<64 hex>.json", "sha256": "<64 hex>", "b64": "<base64>" } ] }
 */

const crypto = require("crypto");
const { isRunId } = require("./derive");
const { versionParts, compareParts } = require("./releasefile");

const OUTER_VERSION = 1;
const INNER_VERSION = 1;
const INNER_KIND = "no1d-swap-backup";
const SEALED_LABEL = "swap-backup";
const SEALED_NAME = "swap-backup";
const MAX_OUTER_BYTES = 4 * 1024 * 1024;
const MAX_PLAIN_BYTES = 1024 * 1024;

const OUTER_KEYS = Object.freeze(["no1d_swap_backup", "run_id", "sha256", "sealed"]);
const SEALED_KEYS = Object.freeze(["v", "alg", "label", "run_id", "nonce", "ct", "tag"]);
const INNER_KEYS = Object.freeze([
  "v",
  "kind",
  "made_by",
  "made_at",
  "seq",
  "run_id",
  "role",
  "profile",
  "chain_id",
  "phase",
  "safety_digest",
  "registry",
  "files",
  "home",
]);
const ENTRY_KEYS = Object.freeze(["path", "sha256", "b64"]);
const REGISTRY_KEYS = Object.freeze(["hashlock", "role"]);

const ROLES = Object.freeze(["alice", "bob"]);
const PROFILES = Object.freeze(["sepolia", "rehearsal", "production"]);
const HEX64 = /^[0-9a-f]{64}$/;
const HEX24 = /^[0-9a-f]{24}$/;
const HEX32 = /^[0-9a-f]{32}$/;
const EVEN_HEX = /^(?:[0-9a-f]{2})*$/;
const B64_RE = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const UTC_ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z$/;
const PHASE_RE = /^[a-z][a-z0-9_-]{0,63}$/;
const HOME_LOCK_RE = /^lock-sent\/(\d+)-([0-9a-f]{40})-([0-9a-f]{64})\.json$/;

const ALLOWED_BACKUP_PATHS = Object.freeze([
  "run.json",
  "alice.swap.json",
  "alice.swap.json.wallet-fund.json",
  "alice.swap.json.wallet-recover.json",
  "alice.swap.json.wallet-sweep.json",
  "alice.swap.json.reveal-sent",
  "alice.swap.json.reveal-fees",
  "bob/bob.swap.json",
  "bob/bob.swap.json.lock-sent",
  "bob/bob.swap.json.producer-differs",
  "bob/bob.swap.json.wallet-fund.json",
  "bob/bob.swap.json.wallet-recover.json",
  "bob/bob.swap.json.wallet-sweep.json",
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
const ALLOWED_SET = new Set(ALLOWED_BACKUP_PATHS);

const WORDS = Object.freeze({
  NOT_BACKUP: "This is not a No1d Swap backup.",
  DAMAGED: "This file is damaged. Try another copy.",
  NEWER: "This backup was made by a newer version of No1d Swap. Update the program first.",
  TOO_LARGE: "This swap folder is too large to back up.",
  MISMATCH: "This backup file is not consistent.",
});

class BackupFileError extends Error {
  constructor(message, code = "damaged") {
    super(message);
    this.name = "BackupFileError";
    this.code = code;
  }
}

function sha256Hex(buf) {
  return crypto.createHash("sha256").update(buf).digest("hex");
}

function defaultBackupName(runId) {
  if (!isRunId(runId)) throw new BackupFileError(WORDS.NOT_BACKUP, "not_backup");
  return `no1d-swap-backup-${runId.slice(0, 8)}.no1dbackup`;
}

function isAllowedBackupPath(relPath) {
  if (typeof relPath !== "string" || !relPath) return false;
  if (relPath.includes("\\") || relPath.includes("\0") || relPath.includes("..") || relPath.startsWith("/") || /^[A-Za-z]:/.test(relPath)) return false;
  return ALLOWED_SET.has(relPath);
}

/** First duplicate key in a valid JSON text, or null. */
function firstDuplicateKey(text) {
  const stack = [];
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    const top = stack[stack.length - 1];
    if (c === "{") stack.push({ keys: new Set(), expectKey: true });
    else if (c === "[") stack.push(null);
    else if (c === "}" || c === "]") stack.pop();
    else if (c === "," && top) top.expectKey = true;
    else if (c === '"') {
      let j = i + 1;
      while (text[j] !== '"') j += text[j] === "\\" ? 2 : 1;
      const str = JSON.parse(text.slice(i, j + 1));
      if (top && top.expectKey) {
        if (top.keys.has(str)) return str;
        top.keys.add(str);
        top.expectKey = false;
      }
      i = j;
    }
  }
  return null;
}

function hasExactKeys(o, expected) {
  if (!o || typeof o !== "object" || Array.isArray(o)) return false;
  const k = Object.keys(o);
  return k.length === expected.length && expected.every((name) => Object.prototype.hasOwnProperty.call(o, name));
}

function decodeStrictJson(input, maxBytes, sizeErrCode = "damaged", sizeErrMsg = WORDS.DAMAGED) {
  const buf = Buffer.isBuffer(input) ? input : Buffer.from(String(input), "utf8");
  if (buf.length === 0 || buf.length > maxBytes) throw new BackupFileError(sizeErrMsg, sizeErrCode);
  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(buf);
  } catch {
    throw new BackupFileError(WORDS.DAMAGED, "damaged");
  }
  if (text.charCodeAt(0) === 0xfeff) throw new BackupFileError(WORDS.DAMAGED, "damaged");
  let obj;
  try {
    obj = JSON.parse(text);
  } catch {
    throw new BackupFileError(WORDS.NOT_BACKUP, "not_backup");
  }
  if (firstDuplicateKey(text) !== null) throw new BackupFileError(WORDS.DAMAGED, "damaged");
  return obj;
}

/** Deterministic canonical JSON of a sealed.js envelope. */
function canonicalSealedJson(env) {
  if (!hasExactKeys(env, SEALED_KEYS)) throw new BackupFileError(WORDS.DAMAGED, "damaged");
  return JSON.stringify({
    v: env.v,
    alg: env.alg,
    label: env.label,
    run_id: env.run_id,
    nonce: env.nonce,
    ct: env.ct,
    tag: env.tag,
  });
}

function checkSealedShape(env, runId) {
  if (!hasExactKeys(env, SEALED_KEYS)) return false;
  if (env.v !== 1 || env.alg !== "AES-256-GCM") return false;
  if (env.label !== SEALED_LABEL || env.run_id !== runId) return false;
  if (typeof env.nonce !== "string" || !HEX24.test(env.nonce)) return false;
  if (typeof env.tag !== "string" || !HEX32.test(env.tag)) return false;
  if (typeof env.ct !== "string" || !EVEN_HEX.test(env.ct) || env.ct.length > MAX_PLAIN_BYTES * 2) return false;
  return true;
}

/** Builds the outer .no1dbackup ASCII JSON text (ending in LF). */
function formatOuter({ runId, sealedEnvelope }) {
  if (!isRunId(runId)) throw new BackupFileError(WORDS.NOT_BACKUP, "not_backup");
  const env = typeof sealedEnvelope === "string" ? JSON.parse(sealedEnvelope) : sealedEnvelope;
  if (!checkSealedShape(env, runId)) throw new BackupFileError(WORDS.DAMAGED, "damaged");
  const canonical = canonicalSealedJson(env);
  const hash = sha256Hex(Buffer.from(canonical, "utf8"));
  const out = `${JSON.stringify({ no1d_swap_backup: OUTER_VERSION, run_id: runId, sha256: hash, sealed: JSON.parse(canonical) })}\n`;
  if (Buffer.byteLength(out, "utf8") > MAX_OUTER_BYTES) throw new BackupFileError(WORDS.TOO_LARGE, "too_large");
  return out;
}

/**
 * Parses and validates the outer .no1dbackup wrapper before any decryption.
 * Returns { runId, sha256, sealed, sealedText }.
 */
function parseOuter(input) {
  const o = decodeStrictJson(input, MAX_OUTER_BYTES, "damaged", WORDS.DAMAGED);
  if (!o || typeof o !== "object" || Array.isArray(o) || !Object.prototype.hasOwnProperty.call(o, "no1d_swap_backup")) {
    throw new BackupFileError(WORDS.NOT_BACKUP, "not_backup");
  }
  if (!hasExactKeys(o, OUTER_KEYS)) throw new BackupFileError(WORDS.DAMAGED, "damaged");
  if (o.no1d_swap_backup !== OUTER_VERSION) throw new BackupFileError(WORDS.NOT_BACKUP, "not_backup");
  if (!isRunId(o.run_id)) throw new BackupFileError(WORDS.DAMAGED, "damaged");
  if (typeof o.sha256 !== "string" || !HEX64.test(o.sha256)) throw new BackupFileError(WORDS.DAMAGED, "damaged");
  if (!checkSealedShape(o.sealed, o.run_id)) throw new BackupFileError(WORDS.DAMAGED, "damaged");
  const sealedText = canonicalSealedJson(o.sealed);
  const actual = sha256Hex(Buffer.from(sealedText, "utf8"));
  if (!crypto.timingSafeEqual(Buffer.from(actual, "hex"), Buffer.from(o.sha256, "hex"))) {
    throw new BackupFileError(WORDS.DAMAGED, "damaged");
  }
  return { runId: o.run_id, sha256: o.sha256, sealed: o.sealed, sealedText };
}

function checkEntry(entry, allowPath) {
  if (!hasExactKeys(entry, ENTRY_KEYS)) throw new BackupFileError(WORDS.DAMAGED, "damaged");
  if (!allowPath(entry.path)) throw new BackupFileError(WORDS.DAMAGED, "damaged");
  if (typeof entry.sha256 !== "string" || !HEX64.test(entry.sha256)) throw new BackupFileError(WORDS.DAMAGED, "damaged");
  if (typeof entry.b64 !== "string" || !B64_RE.test(entry.b64)) throw new BackupFileError(WORDS.DAMAGED, "damaged");
  const bytes = Buffer.from(entry.b64, "base64");
  if (bytes.toString("base64") !== entry.b64) throw new BackupFileError(WORDS.DAMAGED, "damaged");
  const got = sha256Hex(bytes);
  if (!crypto.timingSafeEqual(Buffer.from(got, "hex"), Buffer.from(entry.sha256, "hex"))) {
    throw new BackupFileError(WORDS.DAMAGED, "damaged");
  }
  return { path: entry.path, sha256: entry.sha256, b64: entry.b64, bytes };
}

function profileMatchesChain(profile, chainId) {
  if (profile === "production") return chainId === 1;
  if (profile === "sepolia") return chainId === 11155111;
  return Number.isInteger(chainId) && chainId > 0;
}

/**
 * Validates and builds the inner backup payload Buffer (<= 1 MiB).
 * `files` and `home` entries may pass either `{ path, bytes }` or `{ path, sha256, b64 }`.
 */
function buildPlain({ madeBy, madeAt, seq, runId, role, profile, chainId, phase, safetyDigest, registry, files, home = [] }) {
  const normList = (arr) =>
    (Array.isArray(arr) ? arr : []).map((it) => {
      if (it && Buffer.isBuffer(it.bytes)) {
        return { path: it.path, sha256: sha256Hex(it.bytes), b64: it.bytes.toString("base64") };
      }
      return { path: it && it.path, sha256: it && it.sha256, b64: it && it.b64 };
    });
  const payload = {
    v: INNER_VERSION,
    kind: INNER_KIND,
    made_by: madeBy,
    made_at: madeAt,
    seq,
    run_id: runId,
    role,
    profile,
    chain_id: chainId,
    phase,
    safety_digest: safetyDigest,
    registry,
    files: normList(files),
    home: normList(home),
  };
  const buf = Buffer.from(`${JSON.stringify(payload)}\n`, "utf8");
  if (buf.length > MAX_PLAIN_BYTES) throw new BackupFileError(WORDS.TOO_LARGE, "too_large");
  // Self-validate everything with the exact strict parser
  parsePlain(buf, { expectedRunId: runId });
  return buf;
}

/**
 * Strictly parses and validates the decrypted backup payload.
 * Options:
 *   expectedRunId?: string        — must match inner run_id
 *   currentVersion?: string       — x.y.z; refuses made_by > currentVersion
 *   bobSender?: string            — optional 0x40-hex to pin the home lock-record sender
 * Returns parsed object with decoded `bytes` on each `files` and `home` item.
 */
function parsePlain(input, opts = {}) {
  const o = decodeStrictJson(input, MAX_PLAIN_BYTES, "too_large", WORDS.TOO_LARGE);
  if (!hasExactKeys(o, INNER_KEYS)) throw new BackupFileError(WORDS.DAMAGED, "damaged");
  if (o.v !== INNER_VERSION || o.kind !== INNER_KIND) throw new BackupFileError(WORDS.NOT_BACKUP, "not_backup");

  const madeByParts = versionParts(o.made_by);
  if (!madeByParts) throw new BackupFileError(WORDS.DAMAGED, "damaged");
  if (typeof opts.currentVersion === "string" && opts.currentVersion) {
    const curParts = versionParts(opts.currentVersion);
    if (curParts && compareParts(madeByParts, curParts) > 0) {
      throw new BackupFileError(WORDS.NEWER, "newer_version");
    }
  }
  if (typeof o.made_at !== "string" || !UTC_ISO_RE.test(o.made_at) || Number.isNaN(Date.parse(o.made_at))) {
    throw new BackupFileError(WORDS.DAMAGED, "damaged");
  }
  if (!Number.isSafeInteger(o.seq) || o.seq < 0) throw new BackupFileError(WORDS.DAMAGED, "damaged");
  if (!isRunId(o.run_id)) throw new BackupFileError(WORDS.DAMAGED, "damaged");
  if (opts.expectedRunId && o.run_id !== opts.expectedRunId) throw new BackupFileError(WORDS.MISMATCH, "mismatch");
  if (!ROLES.includes(o.role)) throw new BackupFileError(WORDS.DAMAGED, "damaged");
  if (!PROFILES.includes(o.profile)) throw new BackupFileError(WORDS.DAMAGED, "damaged");
  if (!Number.isSafeInteger(o.chain_id) || o.chain_id <= 0 || !profileMatchesChain(o.profile, o.chain_id)) {
    throw new BackupFileError(WORDS.MISMATCH, "mismatch");
  }
  if (typeof o.phase !== "string" || !PHASE_RE.test(o.phase)) throw new BackupFileError(WORDS.DAMAGED, "damaged");
  if (typeof o.safety_digest !== "string" || !HEX64.test(o.safety_digest)) throw new BackupFileError(WORDS.DAMAGED, "damaged");

  if (!hasExactKeys(o.registry, REGISTRY_KEYS)) throw new BackupFileError(WORDS.DAMAGED, "damaged");
  if (typeof o.registry.hashlock !== "string" || !HEX64.test(o.registry.hashlock) || o.registry.role !== o.role) {
    throw new BackupFileError(WORDS.MISMATCH, "mismatch");
  }

  if (!Array.isArray(o.files) || !Array.isArray(o.home)) throw new BackupFileError(WORDS.DAMAGED, "damaged");

  const seenFiles = new Set();
  const files = [];
  for (const raw of o.files) {
    const ent = checkEntry(raw, isAllowedBackupPath);
    if (seenFiles.has(ent.path)) throw new BackupFileError(WORDS.DAMAGED, "damaged");
    seenFiles.add(ent.path);
    files.push(ent);
  }
  const requiredSwap = o.role === "alice" ? "alice.swap.json" : "bob/bob.swap.json";
  if (!seenFiles.has("run.json") || !seenFiles.has(requiredSwap)) {
    throw new BackupFileError(WORDS.DAMAGED, "damaged");
  }

  // Validate run.json consistency with inner header when parseable JSON
  const runEntry = files.find((f) => f.path === "run.json");
  let runObj;
  try {
    runObj = JSON.parse(runEntry.bytes.toString("utf8"));
  } catch {
    throw new BackupFileError(WORDS.DAMAGED, "damaged");
  }
  if (!runObj || typeof runObj !== "object" || Array.isArray(runObj)) throw new BackupFileError(WORDS.DAMAGED, "damaged");
  if (runObj.run_id !== o.run_id || runObj.role !== o.role || runObj.profile !== o.profile) {
    throw new BackupFileError(WORDS.MISMATCH, "mismatch");
  }
  if (runObj.chain_id !== undefined && Number(runObj.chain_id) !== o.chain_id) {
    throw new BackupFileError(WORDS.MISMATCH, "mismatch");
  }

  // Strict home entries: only lock-sent/<chain>-<40 hex>-<64 hex>.json matching chain_id, lock word, and optional bobSender
  const seenHome = new Set();
  const home = [];
  const wantSender = typeof opts.bobSender === "string" ? opts.bobSender.replace(/^0x/i, "").toLowerCase() : null;
  for (const raw of o.home) {
    const ent = checkEntry(raw, (p) => typeof p === "string" && HOME_LOCK_RE.test(p));
    if (seenHome.has(ent.path)) throw new BackupFileError(WORDS.DAMAGED, "damaged");
    seenHome.add(ent.path);
    const m = HOME_LOCK_RE.exec(ent.path);
    if (Number(m[1]) !== o.chain_id) throw new BackupFileError(WORDS.MISMATCH, "mismatch");
    if (m[3] !== o.registry.hashlock) throw new BackupFileError(WORDS.MISMATCH, "mismatch");
    if (wantSender && m[2] !== wantSender) throw new BackupFileError(WORDS.MISMATCH, "mismatch");
    home.push(ent);
  }

  return {
    v: o.v,
    kind: o.kind,
    made_by: o.made_by,
    made_at: o.made_at,
    seq: o.seq,
    run_id: o.run_id,
    role: o.role,
    profile: o.profile,
    chain_id: o.chain_id,
    phase: o.phase,
    safety_digest: o.safety_digest,
    registry: { hashlock: o.registry.hashlock, role: o.registry.role },
    files,
    home,
  };
}

module.exports = {
  OUTER_VERSION,
  INNER_VERSION,
  INNER_KIND,
  SEALED_LABEL,
  SEALED_NAME,
  MAX_OUTER_BYTES,
  MAX_PLAIN_BYTES,
  ALLOWED_BACKUP_PATHS,
  WORDS,
  BackupFileError,
  sha256Hex,
  defaultBackupName,
  isAllowedBackupPath,
  canonicalSealedJson,
  formatOuter,
  parseOuter,
  buildPlain,
  parsePlain,
};
