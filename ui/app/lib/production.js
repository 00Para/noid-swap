"use strict";
/*
 * The TERMINAL console does not act on a production swap (Ethereum mainnet); program mode does, through run.json's own production rules, and uses `programNetworkReason`
 * below (every file names run.json's network). A run folder is a production run, for the terminal console, when ANY of these says so: the bundle's profile or chain id (the terms), a tick's Ethereum observation or the swap file's own terms
 * (`swap_terms.eth.chain_id`, copied by the engine), or the PROFILE / CHAIN line of the folder's env.local.sh (the settings the helpers will use; the
 * helpers default to sepolia when it sets neither). Only those two lines of env.local.sh are read, by a strict pattern, and nothing else of the file
 * leaves this module.
 */

const fs = require("fs");
const path = require("path");
const { pathCandidates } = require("./runfolder");
const { isProduction, PRODUCTION_TEXT } = require("./viewmodel");

const LINE = /^\s*(?:export\s+)?(PROFILE|CHAIN)=(?:'([^']{0,40})'|"([^"]{0,40})"|([^\s#;'"$`\\]{0,40}))\s*(?:#.*)?$/;

/**
 * `{ profile, chain, production }` from the PROFILE= / CHAIN= lines of <dir>/env.local.sh. `profile` and `chain` are the LAST assignment of each (as in bash); `production`
 * is true when ANY readable assignment says production or chain 1 (the careful reading: a later line cannot take it back, because the file is sourced by bash and a
 * later line this reader cannot evaluate could mean anything). Nulls and false when the file or the lines are absent.
 */
function envLocalNetwork(dir) {
  const out = { profile: null, chain: null, production: false };
  if (!dir) return out;
  for (const c of pathCandidates(dir)) {
    let text;
    try {
      text = fs.readFileSync(path.join(c, "env.local.sh"), "utf8");
    } catch {
      continue;
    }
    for (const raw of text.split(/\r?\n/)) {
      const m = LINE.exec(raw);
      if (!m) continue;
      const v = m[2] !== undefined ? m[2] : m[3] !== undefined ? m[3] : m[4] !== undefined ? m[4] : "";
      if (m[1] === "PROFILE") out.profile = v;
      else out.chain = v;
      if ((m[1] === "PROFILE" && v === "production") || (m[1] === "CHAIN" && v === "1")) out.production = true;
    }
    return out;
  }
  return out;
}

/**
 * The reason text when this run folder is a production run, else null.
 * @param {object|null} run the readRun result (terms and ticks)
 * @param {string|null} dir the run folder (for env.local.sh)
 */
function productionReason(run, dir) {
  const terms = run && run.terms;
  const ticks = run && run.roles ? ["alice", "bob"].map((r) => run.roles[r] && run.roles[r].tick).filter(Boolean) : [];
  if (isProduction(terms, null) || ticks.some((t) => isProduction(null, t))) return PRODUCTION_TEXT;
  const env = envLocalNetwork(dir);
  if (env.production) return PRODUCTION_TEXT;
  return null;
}

const num = (x) => (typeof x === "number" && Number.isFinite(x) ? x : typeof x === "string" && /^[0-9]{1,16}$/.test(x) ? Number(x) : null);
const MIXED_TEXT = "This swap's files do not all name the same network as its settings (run.json): every action is refused.";

/**
 * PROGRAM MODE: why this swap's files must not be acted on although run.json passed its schema, or null. In program mode production is a profile like the others, so the
 * old rule "any production refuses" becomes "nothing may name another network than run.json": the bundle's profile (when it states one) and its chain id, every tick's
 * Ethereum chain and the swap file's own chain (`swap_terms.eth.chain_id`, copied into the tick by the engine) must equal run.json's profile and chain. A Sepolia run.json with a
 * chain-1 bundle or tick, and the reverse, is refused here. Ids that are absent are not held against the swap (a swap with no bundle yet has none to compare).
 * @param {object} settings the loaded run.json
 * @param {object|null} run the readRun result (terms and ticks)
 * @returns {string|null}
 */
function programNetworkReason(settings, run) {
  if (!settings || typeof settings.profile !== "string" || !Number.isInteger(settings.chain_id)) return MIXED_TEXT;
  const wantMain = settings.profile === "production" || settings.chain_id === 1;
  // a mix between Ethereum mainnet and anything else is refused; the test networks among themselves (Sepolia against the rehearsal chain) cannot cost real ETH and are not held against a swap
  const clash = (chain) => chain !== undefined && chain !== null && (wantMain ? num(chain) !== 1 : num(chain) === 1 || num(chain) === null);
  const terms = run && run.terms;
  if (terms) {
    const p = terms.profile_explicit !== false && typeof terms.profile === "string" ? terms.profile : null;
    if (p !== null && (wantMain ? p !== "production" : p === "production")) return MIXED_TEXT;
    if (clash(terms.chain_id)) return MIXED_TEXT;
  }
  const ticks = run && run.roles ? ["alice", "bob"].map((r) => run.roles[r] && run.roles[r].tick).filter(Boolean) : [];
  for (const t of ticks) {
    const eth = (t && t.eth) || {};
    const st = (t && t.swap_terms && t.swap_terms.eth) || {};
    for (const v of [eth.chain_id, st.chain_id]) if (clash(v)) return MIXED_TEXT;
  }
  return null;
}

module.exports = { envLocalNetwork, productionReason, programNetworkReason, PRODUCTION_TEXT, MIXED_TEXT };
