"use strict";
/*
 * The console does not act on a production swap (Ethereum mainnet): test networks only until the external review (PROJECT.md). A run folder is a
 * production run when ANY of these says so: the bundle's profile or chain id (the terms), a tick's Ethereum observation or the swap file's own terms
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

module.exports = { envLocalNetwork, productionReason, PRODUCTION_TEXT };
