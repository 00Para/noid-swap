"use strict";
/*
 * The invitation file (build spec #4): what the person who sells ETH (Bob) saves so that the person who sells NOID (Alice) does not type his terms and his two
 * addresses. It is a file from ANOTHER PERSON, so it is read as untrusted input: a small size limit, a strict JSON reader (no duplicate key), exactly nine keys,
 * strings for every amount and address (a JSON number loses precision), Sepolia or Ethereum mainnet only (with that network's caps), the form's own address checks. `parse` returns the seven
 * fields of the new-swap form and nothing else: the invitation never carries or sets a payout address, `single_node_ok`, `hc_lead`, `deploy_block`, gas or a tip.
 * Alice still sees every value in her form and her approval names both amounts; Bob's `new-bob` checks the bundle against his own run.json and key.
 *
 * Plain module: no Electron, no network. It never returns or accepts a path of the program's data folder: the two dialogs live in the desktop shell.
 */

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { strictParse } = require("./programsettings");
const { ethAddressProblem, noidAddressProblem } = require("./walletrun");
const { PROGRAM_PROFILES } = require("./swapform");

// the network word of the file -> the program's profile (the file says "mainnet" for Ethereum mainnet: caps of the production profile, contract version 1 only)
const NETWORKS = Object.freeze({ sepolia: "sepolia", mainnet: "production" });

const KIND = "no1d-swap-invitation";
const CODE_PREFIX = "no1dinv1:";
const MAX_BYTES = 4096;
const MAX_CODE_CHARS = 6144;
const CHECKSUM_BYTES = 4;
const KEYS = ["kind", "v", "network", "contract", "contract_version", "noid_micronoid", "eth_wei", "bob_noid", "bob_eth"];

const WORDS = Object.freeze({
  TOO_LARGE: "That file is too large to be an invitation. Nothing was filled.",
  DAMAGED: "That file is not an invitation of this program, or it is damaged. Nothing was filled.",
  NETWORK: "This invitation is for a network this program does not use for invitations (Sepolia or Ethereum mainnet only). Nothing was filled.",
  CAPS: "The amounts in this invitation are above this program's limit for that network. Nothing was filled.",
  VERSION: "This invitation asks for a contract version that is not used on Ethereum mainnet (version 1 only). Nothing was filled.",
  value: (field) => `That invitation has a value this program cannot use (${field}). Nothing was filled.`,
});

const NOID_MICRO = /^[1-9][0-9]{0,15}$/;
const ETH_WEI = /^[1-9][0-9]{0,30}$/;
const WALLET_ADDRESSES = "wallet-addresses.txt";
const ETH_ADDRESS = /^0x[0-9a-fA-F]{40}$/;

const isPlain = (o) => o !== null && typeof o === "object" && !Array.isArray(o) && Object.getPrototypeOf(o) === Object.prototype;

/** Whole micro-NOID or wei (digits, BigInt) as a decimal with no trailing zeros: "5000000", 6 -> "5"; "1", 6 -> "0.000001". */
function toDecimal(digits, places) {
  const n = BigInt(digits);
  const unit = 10n ** BigInt(places);
  const whole = n / unit;
  const frac = (n % unit).toString().padStart(places, "0").replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : `${whole}`;
}

/**
 * The invitation's text, from Bob's run.json settings and the address of his swap key. Throws when the role is not Bob, the profile is not Sepolia, or a value is
 * missing or unusable (the same checks the reader applies, so the program never writes a file its own reader refuses).
 * @param {object} settings the loaded run.json
 * @param {string|null} bobEth `readBobKeyAddress(dir)`
 * @returns {string} `JSON.stringify(obj, null, 2) + "\n"`
 */
function build(settings, bobEth) {
  if (!settings || typeof settings !== "object") throw new Error("the swap's settings are missing");
  if (settings.role !== "bob") throw new Error("only the side that sells ETH makes an invitation");
  if (settings.profile !== "sepolia" && settings.profile !== "production") throw new Error("invitations are made for Sepolia and Ethereum mainnet swaps only");
  const need = (k, v) => {
    if (v === null || v === undefined || v === "") throw new Error(`the swap has no ${k}`);
    return v;
  };
  const obj = {
    kind: KIND,
    v: 1,
    network: settings.profile === "production" ? "mainnet" : "sepolia",
    contract: need("contract", settings.contract),
    contract_version: need("contract_version", settings.contract_version),
    noid_micronoid: String(need("amount_micronoid", settings.amount_micronoid)),
    eth_wei: String(need("amount_wei", settings.amount_wei)),
    bob_noid: need("bob_noid", settings.bob_noid),
    bob_eth: need("the swap key's address", bobEth),
  };
  const text = `${JSON.stringify(obj, null, 2)}\n`;
  const r = parse(text);
  if (!r.ok) throw new Error(r.why);
  return text;
}

/**
 * The invitation text to the form's fields, or why not. `fields` has exactly: role, profile, contract_version ("1" or "2"), noid_amount, eth_amount (exact decimals),
 * contract, bob_noid, bob_eth.
 * @param {string} text
 * @returns {{ok:true, fields:object}|{ok:false, why:string}}
 */
function parse(text) {
  const no = (why) => ({ ok: false, why });
  if (typeof text !== "string") return no(WORDS.DAMAGED);
  if (Buffer.byteLength(text, "utf8") > MAX_BYTES) return no(WORDS.TOO_LARGE);
  let o;
  try {
    o = strictParse(text);
  } catch {
    return no(WORDS.DAMAGED);
  }
  if (!isPlain(o)) return no(WORDS.DAMAGED);
  const keys = Object.keys(o);
  if (keys.length !== KEYS.length || !KEYS.every((k) => Object.prototype.hasOwnProperty.call(o, k))) return no(WORDS.DAMAGED);
  if (o.kind !== KIND || o.v !== 1) return no(WORDS.DAMAGED);
  if (typeof o.network !== "string" || !Object.prototype.hasOwnProperty.call(NETWORKS, o.network)) return no(WORDS.NETWORK);
  const profile = NETWORKS[o.network];
  if (o.contract_version !== 1 && o.contract_version !== 2) return no(WORDS.value("contract_version"));
  for (const k of ["contract", "noid_micronoid", "eth_wei", "bob_noid", "bob_eth"]) if (typeof o[k] !== "string") return no(WORDS.value(k));
  if (ethAddressProblem(o.contract)) return no(WORDS.value("contract"));
  if (!NOID_MICRO.test(o.noid_micronoid)) return no(WORDS.value("noid_micronoid"));
  if (!ETH_WEI.test(o.eth_wei)) return no(WORDS.value("eth_wei"));
  if (noidAddressProblem(o.bob_noid)) return no(WORDS.value("bob_noid"));
  if (ethAddressProblem(o.bob_eth)) return no(WORDS.value("bob_eth"));
  if (profile === "production" && o.contract_version !== 1) return no(WORDS.VERSION);
  const caps = PROGRAM_PROFILES[profile];
  if (BigInt(o.noid_micronoid) > caps.max_noid_micro || BigInt(o.eth_wei) > caps.max_eth_wei) return no(WORDS.CAPS);
  return {
    ok: true,
    fields: {
      role: "alice",
      profile,
      contract_version: String(o.contract_version),
      noid_amount: toDecimal(o.noid_micronoid, 6),
      eth_amount: toDecimal(o.eth_wei, 18),
      contract: o.contract,
      bob_noid: o.bob_noid,
      bob_eth: o.bob_eth,
    },
  };
}

/**
 * Bob's swap key address from `wallet-addresses.txt` of a run folder: a plain file (no link) of at most 1 KB with the lines `ROLE=bob` and `BOB_ETH=0x…` (40 hex)
 * and nothing else, each once. Else null. The one reader of this file (build spec 1.2).
 * @param {string} dir the run folder
 * @returns {string|null}
 */
function readBobKeyAddress(dir) {
  try {
    const file = path.join(dir, WALLET_ADDRESSES);
    const st = fs.lstatSync(file);
    if (!st.isFile() || st.isSymbolicLink() || st.size < 1 || st.size > 1024) return null;
    const text = new TextDecoder("utf-8", { fatal: true }).decode(fs.readFileSync(file));
    if (Buffer.byteLength(text, "utf8") > 1024) return null;
    const seen = {};
    for (const raw of text.split("\n")) {
      const line = raw.replace(/\r$/, "");
      if (line === "") continue;
      const m = /^(ROLE|BOB_ETH)=(.*)$/.exec(line);
      if (!m || Object.prototype.hasOwnProperty.call(seen, m[1])) return null;
      seen[m[1]] = m[2];
    }
    if (seen.ROLE !== "bob" || typeof seen.BOB_ETH !== "string" || !ETH_ADDRESS.test(seen.BOB_ETH)) return null;
    return seen.BOB_ETH;
  } catch {
    return null;
  }
}

/**
 * Compact, copy-pasteable invite code wrapping the exact 9-key public invitation JSON with a 4-byte SHA-256 checksum:
 * `no1dinv1:<base64url(utf8(compactJson) || sha256(utf8(compactJson))[0..4])>`. Holds no secret.
 * @param {object} settings the loaded run.json
 * @param {string|null} bobEth `readBobKeyAddress(dir)`
 * @returns {string}
 */
function encodeCode(settings, bobEth) {
  const jsonText = build(settings, bobEth);
  const compact = JSON.stringify(JSON.parse(jsonText));
  const payload = Buffer.from(compact, "utf8");
  const csum = crypto.createHash("sha256").update(payload).digest().subarray(0, CHECKSUM_BYTES);
  const code = CODE_PREFIX + Buffer.concat([payload, csum]).toString("base64url");
  const check = parseCode(code);
  if (!check.ok) throw new Error(check.why);
  return code;
}

/**
 * Parses either a compact invite code (`no1dinv1:...`) or raw invitation JSON text into the form's fields.
 * Verifies the 4-byte SHA-256 checksum on compact codes before applying the strict 9-key JSON parser.
 * @param {string} input
 * @returns {{ok:true, fields:object}|{ok:false, why:string}}
 */
function parseCode(input) {
  const no = (why) => ({ ok: false, why });
  if (typeof input !== "string") return no(WORDS.DAMAGED);
  // Strip ASCII whitespace only (never a leading UTF-8 BOM, which strict JSON parsing refuses).
  const trimmed = input.replace(/^[ \t\r\n]+|[ \t\r\n]+$/g, "");
  if (!trimmed) return no(WORDS.DAMAGED);
  if (Buffer.byteLength(trimmed, "utf8") > MAX_CODE_CHARS) return no(WORDS.TOO_LARGE);
  if (!trimmed.startsWith(CODE_PREFIX)) return parse(trimmed);
  const body = trimmed.slice(CODE_PREFIX.length);
  if (!body || !/^[A-Za-z0-9_-]+$/.test(body)) return no(WORDS.DAMAGED);
  const raw = Buffer.from(body, "base64url");
  if (raw.toString("base64url") !== body) return no(WORDS.DAMAGED);
  if (raw.length <= CHECKSUM_BYTES || raw.length > MAX_BYTES + CHECKSUM_BYTES) {
    return no(raw.length > MAX_BYTES + CHECKSUM_BYTES ? WORDS.TOO_LARGE : WORDS.DAMAGED);
  }
  const payload = raw.subarray(0, raw.length - CHECKSUM_BYTES);
  const got = raw.subarray(raw.length - CHECKSUM_BYTES);
  const want = crypto.createHash("sha256").update(payload).digest().subarray(0, CHECKSUM_BYTES);
  if (!crypto.timingSafeEqual(got, want)) return no(WORDS.DAMAGED);
  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(payload);
  } catch {
    return no(WORDS.DAMAGED);
  }
  return parse(text);
}

module.exports = { KIND, CODE_PREFIX, KEYS, MAX_BYTES, MAX_CODE_CHARS, WORDS, build, parse, encodeCode, parseCode, readBobKeyAddress, toDecimal };
