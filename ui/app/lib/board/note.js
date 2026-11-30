"use strict";
/*
 * Nostr notes (NIP-01): serialization, id, BIP-340 Schnorr signature and verification, strict shape checks.
 *
 * Written against the published NIP-01 text (read 2026-11-17). Signatures use the vendored @noble/curves (never our own curve code); SHA-256 is
 * Node's. A note is plain data: { id, pubkey, created_at, kind, tags, content, sig }. A "template" is the same without id, pubkey and sig.
 *
 * Secret keys are 32-byte Buffers or 64 lower-case hex strings. They are never put in an error text, a log line or a returned object.
 *
 * Difference from a common shortcut (JSON.stringify): NIP-01 says only the characters \n " \\ \r \t \b \f are escaped in the content and every other
 * character is written as it is. JSON.stringify writes the other control characters as \u00XX, which would give another id. This code follows
 * the text, and refuses (on creation) a string that contains such another control character, so two implementations cannot disagree on one of OUR notes.
 */

const crypto = require("crypto");
const { schnorr } = require("../../vendor");

const KINDS = Object.freeze({
  DELETION: 5,
  SEAL: 13,
  WRAP: 1059,
  // Our own kinds. Neither number is in the public kind list of the NIPs repository (checked in its README, 2026-11-17); the offer kind is in the
  // addressable range 30000-39999 (replaced by the newest note with the same author, kind and `d` tag); the handover rumor kind is only ever inside a seal.
  OFFER: 32871,
  HANDOVER: 4871,
});

const LIMITS = Object.freeze({
  maxContentChars: 131072,
  maxTags: 100,
  maxTagItems: 16,
  maxTagItemChars: 2048,
});

const N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;

const HEX64 = /^[0-9a-f]{64}$/;
const HEX128 = /^[0-9a-f]{128}$/;
const isHex64 = (s) => typeof s === "string" && HEX64.test(s);

class BoardError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "BoardError";
    this.code = code;
  }
}
const fail = (code, message) => {
  throw new BoardError(code, message);
};

const toHex = (b) => Buffer.from(b).toString("hex");

/** A secret key as a 32-byte Buffer, or a BoardError. Range: 1 <= k < n. Never echoes the key. */
function secretBytes(k) {
  let b;
  if (typeof k === "string") {
    if (!HEX64.test(k)) fail("bad_key", "a secret key is 64 lower-case hex characters");
    b = Buffer.from(k, "hex");
  } else if (k instanceof Uint8Array && k.length === 32) b = Buffer.from(k);
  else fail("bad_key", "a secret key is 32 bytes");
  const v = BigInt("0x" + b.toString("hex"));
  if (v <= 0n || v >= N) fail("bad_key", "secret key out of range");
  return b;
}

/** A fresh secret key from the OS generator (rejection sampling into [1, n-1]). */
function generateSecretKey() {
  for (;;) {
    const b = crypto.randomBytes(32);
    const v = BigInt("0x" + b.toString("hex"));
    if (v > 0n && v < N) return b;
  }
}

/** The x-only public key (64 hex) of a secret key. */
function getPublicKey(secret) {
  return toHex(schnorr.getPublicKey(secretBytes(secret)));
}

// ---- serialization (NIP-01)
const ESCAPES = { "\n": "\\n", '"': '\\"', "\\": "\\\\", "\r": "\\r", "\t": "\\t", "\b": "\\b", "\f": "\\f" };
const ESCAPE_RE = /[\n"\\\r\t\x08\f]/g;
// every control character below 0x20 that NIP-01 does NOT escape
const OTHER_CONTROL = /[\x00-\x07\x0b\x0e-\x1f]/;

function jsonString(s) {
  return '"' + s.replace(ESCAPE_RE, (c) => ESCAPES[c]) + '"';
}

/** The exact string whose sha256 is the id: [0,pubkey,created_at,kind,tags,content]. Assumes a checked shape. */
function serializeForId(ev) {
  const tags = "[" + ev.tags.map((t) => "[" + t.map(jsonString).join(",") + "]").join(",") + "]";
  return "[0," + jsonString(ev.pubkey) + "," + String(ev.created_at) + "," + String(ev.kind) + "," + tags + "," + jsonString(ev.content) + "]";
}

function idOf(ev) {
  return crypto.createHash("sha256").update(serializeForId(ev), "utf8").digest("hex");
}

const isInt = (n, lo, hi) => Number.isSafeInteger(n) && n >= lo && n <= hi;

/**
 * The shape of the parts every note has (pubkey optional for a template). Returns a reason text or null.
 * `strings`: when true, a string with a control character NIP-01 does not escape is refused (used when WE create a note).
 */
function shapeProblem(ev, { needPubkey = true, strings = false } = {}) {
  if (!ev || typeof ev !== "object" || Array.isArray(ev)) return "not an object";
  if (needPubkey && !isHex64(ev.pubkey)) return "pubkey is not 64 lower-case hex";
  if (!isInt(ev.created_at, 0, 2 ** 40)) return "created_at is not a whole number of seconds";
  if (!isInt(ev.kind, 0, 65535)) return "kind is not a whole number from 0 to 65535";
  if (typeof ev.content !== "string") return "content is not a string";
  if (ev.content.length > LIMITS.maxContentChars) return "content is too long";
  if (!ev.content.isWellFormed()) return "content is not well-formed text";
  if (!Array.isArray(ev.tags) || ev.tags.length > LIMITS.maxTags) return "tags are not a short list";
  for (const t of ev.tags) {
    if (!Array.isArray(t) || t.length < 1 || t.length > LIMITS.maxTagItems) return "a tag is not a short list";
    for (const x of t) {
      if (typeof x !== "string" || x.length > LIMITS.maxTagItemChars || !x.isWellFormed()) return "a tag item is not a short string";
      if (strings && OTHER_CONTROL.test(x)) return "a tag item has a control character";
    }
  }
  if (strings && OTHER_CONTROL.test(ev.content)) return "content has a control character that NIP-01 does not escape";
  return null;
}

const NOTE_KEYS = ["id", "pubkey", "created_at", "kind", "tags", "content", "sig"];

/**
 * Signs a template with a secret key. The template's own pubkey (if any) must match; extra properties are refused.
 * @returns {object} the signed note { id, pubkey, created_at, kind, tags, content, sig }
 */
function finalizeEvent(template, secret, { auxRand } = {}) {
  const sk = secretBytes(secret);
  const pubkey = toHex(schnorr.getPublicKey(sk));
  for (const k of Object.keys(template || {})) if (!["created_at", "kind", "tags", "content", "pubkey"].includes(k)) fail("bad_note", `unexpected property ${k} in a template`);
  if (template.pubkey !== undefined && template.pubkey !== pubkey) fail("bad_note", "the template names another pubkey than the key");
  const ev = { pubkey, created_at: template.created_at, kind: template.kind, tags: template.tags, content: template.content };
  const why = shapeProblem(ev, { strings: true });
  if (why) fail("bad_note", why);
  const id = idOf(ev);
  const sig = toHex(schnorr.sign(Buffer.from(id, "hex"), sk, auxRand === undefined ? crypto.randomBytes(32) : auxRand));
  return { id, pubkey, created_at: ev.created_at, kind: ev.kind, tags: ev.tags, content: ev.content, sig };
}

/** An unsigned note with its id (a "rumor", NIP-59). */
function makeRumor(template, pubkey) {
  const ev = { pubkey, created_at: template.created_at, kind: template.kind, tags: template.tags, content: template.content };
  const why = shapeProblem(ev, { strings: true });
  if (why) fail("bad_note", why);
  return { id: idOf(ev), ...ev };
}

/**
 * Full check of a received note: exact keys, shapes, id equals the recomputed hash, and a valid BIP-340 signature. Returns true or false, never throws.
 * The id is NEVER trusted from the sender.
 */
function verifyEvent(ev) {
  try {
    if (!ev || typeof ev !== "object" || Array.isArray(ev)) return false;
    const keys = Object.keys(ev);
    if (keys.length !== NOTE_KEYS.length || !NOTE_KEYS.every((k) => keys.includes(k))) return false;
    if (shapeProblem(ev)) return false;
    if (!isHex64(ev.id) || typeof ev.sig !== "string" || !HEX128.test(ev.sig)) return false;
    if (idOf(ev) !== ev.id) return false;
    return schnorr.verify(Buffer.from(ev.sig, "hex"), Buffer.from(ev.id, "hex"), Buffer.from(ev.pubkey, "hex")) === true;
  } catch {
    return false;
  }
}

/** The values of the tags called `name` (each a list of the items after the name). */
const tagsNamed = (ev, name) => ev.tags.filter((t) => t[0] === name).map((t) => t.slice(1));
/** The single value of a tag that must appear exactly once, or null. */
function oneTag(ev, name) {
  const all = tagsNamed(ev, name);
  return all.length === 1 && all[0].length >= 1 ? all[0][0] : null;
}

module.exports = {
  KINDS,
  LIMITS,
  BoardError,
  fail,
  isHex64,
  toHex,
  secretBytes,
  generateSecretKey,
  getPublicKey,
  serializeForId,
  idOf,
  shapeProblem,
  finalizeEvent,
  makeRumor,
  verifyEvent,
  tagsNamed,
  oneTag,
};
