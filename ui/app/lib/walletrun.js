"use strict";
/*
 * The tool's own wallets (swap wallet, piece 2c): what the console knows about a WALLET run, from files only. NOT run against a real node or a public network.
 *
 * A run is a wallet run or a classic run, fixed in the run folder's env.local.sh (`USE_SWAP_WALLET='1'`; absent or 0 = classic). Only three lines of that file are read, by a
 * strict pattern, exactly as lib/production.js reads PROFILE and CHAIN: USE_SWAP_WALLET, NOID_PAYOUT and ETH_PAYOUT (the user's own addresses the leftovers are swept to).
 * A line that mentions one of them in a way this reader cannot evaluate (an indented assignment, a variable, a value that is neither 0 nor 1) makes the run `ambiguous`,
 * and an ambiguous run refuses every wallet step and every classic funding: bash would evaluate such a line and this console cannot (the careful reading).
 *
 * parseWalletStatus reads what `scripts/live/wallet-status.sh` prints (and nothing else): the NOID deposit and the Ethereum reserve of one role. An address is taken only from a
 * line of a status that ended with `wallet-status: done` and whose Ethereum part says `key_checked=true` (the helper's reserve check recomputes the address from the key).
 */

const fs = require("fs");
const path = require("path");
const { pathCandidates } = require("./runfolder");
const { decodeBech32m } = require("./bech32");
const { keccak256Hex } = require("./keccak");

const NAMES = ["USE_SWAP_WALLET", "NOID_PAYOUT", "ETH_PAYOUT"];
const LINE = /^\s*(?:export\s+)?(USE_SWAP_WALLET|NOID_PAYOUT|ETH_PAYOUT)=(?:'([^']{0,120})'|"([^"$`\\]{0,120})"|([^\s#;'"$`\\]{0,120}))\s*(?:#.*)?$/;
const MENTION = /\b(USE_SWAP_WALLET|NOID_PAYOUT|ETH_PAYOUT)\b/;
const ETH_RE = /^0x[0-9a-fA-F]{40}$/;
const NOID_RE = /^o1[0-9a-z]{20,100}$/;

/** `{ found, use_swap_wallet, ambiguous, noid_payout, eth_payout }` from <dir>/env.local.sh. The last strict assignment of each name wins (as in bash). */
function envLocalWallet(dir) {
  const out = { found: false, use_swap_wallet: false, ambiguous: false, noid_payout: null, eth_payout: null };
  if (!dir) return out;
  for (const c of pathCandidates(dir)) {
    let text;
    try {
      text = fs.readFileSync(path.join(c, "env.local.sh"), "utf8");
    } catch {
      continue;
    }
    out.found = true;
    for (const raw of text.split(/\r?\n/)) {
      if (/^\s*#/.test(raw) || !MENTION.test(raw)) continue;
      const m = LINE.exec(raw);
      if (!m) {
        out.ambiguous = true;
        continue;
      }
      const v = m[2] !== undefined ? m[2] : m[3] !== undefined ? m[3] : m[4] !== undefined ? m[4] : "";
      if (m[1] === "USE_SWAP_WALLET") {
        if (v === "1") out.use_swap_wallet = true;
        else if (v === "0" || v === "") out.use_swap_wallet = false;
        else out.ambiguous = true;
      } else if (m[1] === "NOID_PAYOUT") out.noid_payout = v === "" ? null : v;
      else out.eth_payout = v === "" ? null : v;
    }
    return out;
  }
  return out;
}

/** The EIP-55 checksum of an Ethereum address (lower-case hex digits mixed in by the Keccak-256 of the address), or null when it is not an address. */
function toChecksum(addr) {
  if (typeof addr !== "string" || !ETH_RE.test(addr)) return null;
  const a = addr.slice(2).toLowerCase();
  const h = keccak256Hex(Buffer.from(a, "ascii")).slice(2);
  let out = "0x";
  for (let i = 0; i < a.length; i++) out += parseInt(h[i], 16) >= 8 ? a[i].toUpperCase() : a[i];
  return out;
}

/** An Ethereum address: 0x and 40 hex digits; when it is written in mixed case the case must be its EIP-55 checksum. Returns an error text or null. */
function ethAddressProblem(addr) {
  if (typeof addr !== "string" || !ETH_RE.test(addr)) return "0x followed by 40 hexadecimal characters";
  const body = addr.slice(2);
  if (body !== body.toLowerCase() && body !== body.toUpperCase() && toChecksum(addr) !== addr) return "the capital letters are not this address's checksum: a letter was mistyped";
  return null;
}

/** A Parano1d address: bech32m with the o1 prefix. Returns an error text or null. */
function noidAddressProblem(addr) {
  if (typeof addr !== "string") return "an o1... address";
  const d = decodeBech32m(addr);
  return d.ok ? null : `not a Parano1d address (o1...): ${d.reason}`;
}

const WHOLE = /^[0-9]{1,30}$/;
const TOKEN = (name, value) => new RegExp(`(?:^|\\s)${name}=(${value})(?=\\s|$)`);

/** The value of `name=` in a status line, or null (the line has it exactly once). */
function field(line, name, valueRe) {
  const re = new RegExp(`(?:^|\\s)${name}=(${valueRe})(?=\\s|$)`, "g");
  const all = [...line.matchAll(re)];
  return all.length === 1 ? all[0][1] : null;
}

/**
 * What wallet-status.sh printed, as facts. ok only when the whole thing is exactly what the helper prints: the role line, every part of the role (Alice: the NOID line and the
 * Ethereum line; Bob: the Ethereum line), each exactly once, `key_checked=true`, and the closing `wallet-status: done`. Never throws.
 * @returns {{ok:boolean, problems:string[], noid:object|null, eth:object|null}}
 */
function parseWalletStatus(text, role) {
  const res = { ok: false, problems: [], noid: null, eth: null };
  const lines = String(text || "").split(/\r?\n/).map((l) => l.trimEnd());
  const p = (m) => res.problems.push(m);
  const roleLines = lines.filter((l) => /^wallet-status: role /.test(l));
  if (roleLines.length !== 1 || roleLines[0] !== `wallet-status: role ${role}`) p("the status is not for this role");
  if (lines.filter((l) => l === "wallet-status: done").length !== 1) p("the status did not end with `wallet-status: done`");
  if (lines.some((l) => /^wallet-status: NOT complete/.test(l))) p("the status says it is not complete");
  const noidLines = lines.filter((l) => l.startsWith("wallet-status-noid: "));
  const ethLines = lines.filter((l) => l.startsWith("wallet-status-eth: "));
  if (role === "alice") {
    if (noidLines.length !== 1) p("the NOID part is missing or repeated");
    else {
      const l = noidLines[0];
      const o = {
        address: field(l, "address", "o1[0-9a-z]{20,100}"),
        plain_micronoid: field(l, "plain_micronoid", "[0-9]{1,18}"),
        amount_micronoid: field(l, "amount_micronoid", "[0-9]{1,18}"),
        fee_reserve_micronoid: field(l, "fee_reserve_micronoid", "[0-9]{1,18}"),
        need_micronoid: field(l, "need_micronoid", "[0-9]{1,18}"),
        covers: field(l, "covers", "true|false"),
        tip: field(l, "tip", "[0-9]{1,18}"),
      };
      if (Object.values(o).some((v) => v === null)) p("the NOID part is not in the shape the helper prints");
      else res.noid = { ...o, covers: o.covers === "true" };
    }
  } else if (noidLines.length) p("a NOID part for a role that has none");
  if (ethLines.length !== 1) p("the Ethereum part is missing or repeated");
  else {
    const l = ethLines[0];
    const o = {
      address: field(l, "address", "0x[0-9a-fA-F]{40}"),
      required_wei: field(l, "required_wei", "[0-9]{1,40}"),
      reserve_wei: field(l, "reserve_wei", "[0-9]{1,40}"),
      amount_wei: field(l, "amount_wei", "[0-9]{1,40}"),
      balance_wei: field(l, "balance_wei", "[0-9]{1,40}"),
      shortfall_wei: field(l, "shortfall_wei", "[0-9]{1,40}"),
      covered: field(l, "covered", "true|false"),
      key_checked: field(l, "key_checked", "true|false"),
    };
    if (Object.values(o).some((v) => v === null)) p("the Ethereum part is not in the shape the helper prints");
    else if (o.key_checked !== "true") p("the Ethereum part does not say the key was checked against the address");
    else res.eth = { ...o, covered: o.covered === "true", key_checked: true };
  }
  res.ok = res.problems.length === 0 && !!res.eth && (role !== "alice" || !!res.noid);
  if (!res.ok) {
    res.noid = null;
    res.eth = null;
  }
  return res;
}

/** Whole-number wei / micro-NOID text to a BigInt, or null. */
const big = (s) => (typeof s === "string" && WHOLE.test(s) ? BigInt(s) : null);

module.exports = { envLocalWallet, parseWalletStatus, toChecksum, ethAddressProblem, noidAddressProblem, ETH_RE, NOID_RE, NAMES, big, TOKEN };
