"use strict";
/*
 * Everything the operator UI refuses to read or to show.
 *
 * Two layers, both tested:
 *   1. PATHS. `secretPathReason(p)` says why a path must never be opened: a swap file (its sealed
 *      section holds the secret), key material, a passphrase file, a wallet export. The run-folder
 *      reader also reads from an ALLOWLIST of file names, so this list is the second lock, not the first.
 *   2. VALUES. `redactDeep(value)` removes, from any parsed JSON, every field that can carry the
 *      secret or a transaction opening: `preimage`, `secret`, `passphrase`, `opening_hex`, `intent_hex`, …
 *      A tick's `eth.claimed.preimage`, `eth.pending_preimage.preimage`, `events[].preimage` and a
 *      `claim_noid` action's `preimage` are all public on chain once Alice reveals, but this UI never
 *      displays them: it shows only that the secret is public and where.
 */

const path = require("path");

/** Field names (case-insensitive, any depth) whose values are never kept. */
const SECRET_KEYS = [
  "preimage",
  "secret",
  "secret_hex",
  "passphrase",
  "password",
  "seed",
  "mnemonic",
  "master_secret",
  "private_key",
  "privatekey",
  "sealed",
  "sealed_secret",
  "ciphertext",
  "nonce_hex",
  "opening_hex",
  "contract_opening_hex",
  "intent_hex",
  "intent_bytes_hex",
  "wallet_secret",
];
const SECRET_KEY_SET = new Set(SECRET_KEYS);
const REDACTED = "[withheld]";

function isSecretKey(k) {
  return SECRET_KEY_SET.has(String(k).toLowerCase());
}

/** Deep copy without secret-bearing fields. A removed field leaves `{ "<key>": "[withheld]" }` so the shape stays visible. */
function redactDeep(v, depth = 0) {
  if (depth > 40) return null;
  if (Array.isArray(v)) return v.map((x) => redactDeep(x, depth + 1));
  if (v && typeof v === "object") {
    const out = {};
    for (const [k, x] of Object.entries(v)) {
      out[k] = isSecretKey(k) && x !== null && x !== undefined ? REDACTED : redactDeep(x, depth + 1);
    }
    return out;
  }
  return v;
}

/** True when a parsed object still carries a secret-bearing field with a real value (used by tests and as a final guard). */
function hasSecretField(v, depth = 0) {
  if (depth > 40) return false;
  if (Array.isArray(v)) return v.some((x) => hasSecretField(x, depth + 1));
  if (v && typeof v === "object") {
    return Object.entries(v).some(([k, x]) => (isSecretKey(k) && x !== null && x !== undefined && x !== REDACTED) || hasSecretField(x, depth + 1));
  }
  return false;
}

/**
 * Why a path must not be opened, or null. Matches on the base name and on the directory parts, in either
 * path style (Windows or POSIX), so `C:\x\alice.swap.json`, `/home/u/bob/bob.swap.json.lock`, `eth\keys\bob.key`
 * and `passphrase.txt` are all refused.
 */
function secretPathReason(p) {
  if (typeof p !== "string" || p === "") return null;
  const parts = p.split(/[\\/]+/).filter(Boolean);
  const base = (parts[parts.length - 1] || path.basename(p)).toLowerCase();
  if (/\.swap\.json/.test(base)) return "a *.swap.json holds a sealed secret; the console only reads public files";
  if (/(^|[\\/])eth[\\/]keys[\\/]/i.test(p) || parts.slice(0, -1).some((d) => d.toLowerCase() === "keys")) return "key material";
  if (/\.(key|pem|p12|pfx|keystore)$/.test(base) || /^id_(rsa|ed25519|ecdsa)/.test(base)) return "key material";
  if (/passphrase/.test(base)) return "a passphrase file";
  if (/(wallet|master).*(secret|export)|\bsecret\b.*\.(txt|json|hex|bin)$/.test(base)) return "secret material";
  return null;
}

module.exports = { SECRET_KEYS, REDACTED, isSecretKey, redactDeep, hasSecretField, secretPathReason };
