"use strict";
/*
 * releasefile.js: the signed release notice (release.json) and its Ed25519 signature check. Built-in crypto only.
 *
 * release.json, strict: exactly these keys, nothing else (docs/release-key.md):
 *   { "product": "No1d Swap", "version": "x.y.z", "oldest_safe_version": "x.y.z", "note": "one sentence",
 *     "sha256": { "<installer file name>": "<64 hex>", ... } }
 * The detached signature is the base64 of the 64-byte Ed25519 signature over the file's exact bytes.
 */

const crypto = require("crypto");

const PRODUCT = "No1d Swap";
const MAX_FILE_BYTES = 8 * 1024;
const MAX_SIG_BYTES = 512;
const MAX_NOTE_CHARS = 280;
const KEYS = ["product", "version", "oldest_safe_version", "note", "sha256"];
const VERSION_RE = /^(\d+)\.(\d+)\.(\d+)$/;
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._ -]{0,99}$/;
const HEX_RE = /^[0-9a-f]{64}$/;
const B64_RE = /^[A-Za-z0-9+/]+={0,2}$/;
const SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");
const PKCS8_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");

class ReleaseFileError extends Error {
  constructor(message) {
    super(message);
    this.name = "ReleaseFileError";
  }
}

function versionParts(text) {
  const m = typeof text === "string" ? VERSION_RE.exec(text) : null;
  if (!m || m.slice(1).some((p) => p.length > 9)) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

function compareParts(a, b) {
  for (let i = 0; i < 3; i += 1) if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
  return 0;
}

/** The first object key that appears twice in the JSON text (after decoding escapes), or null. The text is already valid JSON. */
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

/** Strict parse of release.json bytes (Buffer or string). Throws ReleaseFileError with a plain reason. */
function parseReleaseJson(input) {
  const buf = Buffer.isBuffer(input) ? input : Buffer.from(String(input), "utf8");
  if (buf.length === 0 || buf.length > MAX_FILE_BYTES) throw new ReleaseFileError("the file is empty or over 8 KB");
  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(buf);
  } catch {
    throw new ReleaseFileError("the file is not valid UTF-8");
  }
  let o;
  try {
    o = JSON.parse(text);
  } catch {
    throw new ReleaseFileError("the file is not valid JSON");
  }
  const dup = firstDuplicateKey(text);
  if (dup !== null) throw new ReleaseFileError(`a key appears twice: ${dup.slice(0, 40)}`);
  if (o === null || typeof o !== "object" || Array.isArray(o)) throw new ReleaseFileError("the file is not a JSON object");
  const keys = Object.keys(o);
  for (const k of keys) if (!KEYS.includes(k)) throw new ReleaseFileError(`unknown key: ${k.slice(0, 40)}`);
  for (const k of KEYS) if (!keys.includes(k)) throw new ReleaseFileError(`missing key: ${k}`);
  if (o.product !== PRODUCT) throw new ReleaseFileError(`product must be "${PRODUCT}"`);
  const version = versionParts(o.version);
  if (!version) throw new ReleaseFileError("version must be x.y.z");
  const oldest = versionParts(o.oldest_safe_version);
  if (!oldest) throw new ReleaseFileError("oldest_safe_version must be x.y.z");
  if (compareParts(oldest, version) > 0) throw new ReleaseFileError("oldest_safe_version is above version");
  if (typeof o.note !== "string" || o.note.length === 0) throw new ReleaseFileError("note must be a non-empty string");
  if ([...o.note].length > MAX_NOTE_CHARS) throw new ReleaseFileError(`note is over ${MAX_NOTE_CHARS} characters`);
  if (/[\p{Cc}\p{Cf}\p{Cs}\p{Co}\p{Cn}\p{Zl}\p{Zp}]/u.test(o.note)) throw new ReleaseFileError("note holds a control, format, private-use, unassigned or line-separator character");
  const sums = o.sha256;
  if (sums === null || typeof sums !== "object" || Array.isArray(sums)) throw new ReleaseFileError("sha256 must be an object");
  const names = Object.keys(sums);
  if (names.length === 0 || names.length > 16) throw new ReleaseFileError("sha256 must hold 1 to 16 files");
  for (const n of names) {
    if (!NAME_RE.test(n)) throw new ReleaseFileError("a file name in sha256 is not a plain file name");
    if (typeof sums[n] !== "string" || !HEX_RE.test(sums[n])) throw new ReleaseFileError(`sha256 of ${n} must be 64 lower-case hex characters`);
  }
  return { product: o.product, version: o.version, oldest_safe_version: o.oldest_safe_version, note: o.note, sha256: { ...sums } };
}

/** A public key from its base64 (raw 32 bytes), or null when it is not one. */
function publicKeyObject(pubB64) {
  if (typeof pubB64 !== "string" || pubB64.length !== 44 || !B64_RE.test(pubB64)) return null;
  const raw = Buffer.from(pubB64, "base64");
  if (raw.length !== 32) return null;
  try {
    return crypto.createPublicKey({ key: Buffer.concat([SPKI_PREFIX, raw]), format: "der", type: "spki" });
  } catch {
    return null;
  }
}

/** True only for a valid signature (base64 text, 64 bytes) by the public key over exactly these bytes. Never throws. */
function verifyDetached(pubB64, bytes, sigText) {
  try {
    const key = publicKeyObject(pubB64);
    if (!key) return false;
    const s = String(sigText).trim();
    if (s.length > MAX_SIG_BYTES || !B64_RE.test(s)) return false;
    const sig = Buffer.from(s, "base64");
    if (sig.length !== 64) return false;
    return crypto.verify(null, Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes, "utf8"), key, sig);
  } catch {
    return false;
  }
}

/**
 * A known-answer test of Ed25519 (RFC 8032, test 1, empty message): the runtime signs with the known seed and must produce
 * the known signature, and the same check must verify it. A runtime without Ed25519 (or with a broken one) answers false, so the
 * packed program's start-up test fails instead of the update check quietly saying "not configured".
 */
function ed25519KnownAnswer() {
  try {
    const seed = Buffer.from("9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60", "hex");
    const pub = Buffer.from("d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a", "hex");
    const sig = Buffer.from("e5564300c360ac729086e2cc806e828a84877f1eb8e5d974d873e065224901555fb8821590a33bacc61e39701cf9b46bd25bf5f0595bbe24655141438e7a100b", "hex");
    const priv = crypto.createPrivateKey({ key: Buffer.concat([PKCS8_PREFIX, seed]), format: "der", type: "pkcs8" });
    const made = crypto.sign(null, Buffer.alloc(0), priv);
    return made.equals(sig) && verifyDetached(pub.toString("base64"), Buffer.alloc(0), sig.toString("base64")) && !verifyDetached(pub.toString("base64"), Buffer.from("x"), sig.toString("base64"));
  } catch {
    return false;
  }
}

module.exports = { ed25519KnownAnswer, parseReleaseJson, verifyDetached, publicKeyObject, versionParts, compareParts, ReleaseFileError, SPKI_PREFIX, PKCS8_PREFIX, PRODUCT, MAX_FILE_BYTES, MAX_SIG_BYTES, MAX_NOTE_CHARS };
