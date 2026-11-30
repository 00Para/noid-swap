"use strict";
/*
 * Is this run folder a BOARD run? (piece 3.) A board run is made by the board host (lib/board/host.js): its env.local.sh carries `HANDOVER='board'`, written by the same writer
 * the settings form uses (lib/swapform.js), and the host keeps `handover-ROLE.json` beside it.
 *
 * Read exactly as lib/walletrun.js reads USE_SWAP_WALLET: one strict line pattern; a mention of HANDOVER this reader cannot evaluate (an indented assignment, a variable, any value but
 * `board`) makes the run `ambiguous`, and an ambiguous run is refused everything that puts coins in. The careful reading: a run folder that holds a handover file is a board run even when
 * the line is gone (a hand edit must not turn the board's strict funding rule into the human statement).
 */

const fs = require("fs");
const path = require("path");
const { pathCandidates } = require("../runfolder");

const LINE = /^\s*(?:export\s+)?HANDOVER=(?:'([^']{0,40})'|"([^"$`\\]{0,40})"|([^\s#;'"$`\\]{0,40}))\s*(?:#.*)?$/;
const MENTION = /\bHANDOVER\b/;
const FILES = ["handover-alice.json", "handover-bob.json"];

/** `{ found, declared, ambiguous }` from <dir>/env.local.sh. The last strict assignment wins (as in bash). */
function envLocalHandover(dir) {
  const out = { found: false, declared: false, ambiguous: false };
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
      const v = m[1] !== undefined ? m[1] : m[2] !== undefined ? m[2] : m[3] !== undefined ? m[3] : "";
      if (v === "board") out.declared = true;
      else if (v === "") out.declared = false;
      else out.ambiguous = true;
    }
    return out;
  }
  return out;
}

/** Does the run folder hold a handover file of the board? */
function handoverFilePresent(dir) {
  if (!dir) return false;
  for (const c of pathCandidates(dir)) {
    for (const f of FILES) {
      try {
        if (fs.existsSync(path.join(c, f))) return true;
      } catch {
        /* next */
      }
    }
  }
  return false;
}

/** `{ on, declared, file, ambiguous }`: on = the line says board, or a handover file is there. */
function boardRun(dir) {
  const e = envLocalHandover(dir);
  const file = handoverFilePresent(dir);
  return { on: e.declared || file, declared: e.declared, file, ambiguous: e.ambiguous };
}

module.exports = { envLocalHandover, handoverFilePresent, boardRun, FILES };
