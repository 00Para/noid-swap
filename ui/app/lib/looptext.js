"use strict";
/*
 * Parser for `$L/loop-ROLE.txt`.
 *
 * `scripts/live/watch.sh` appends ONE line per tick:
 *
 *   18:25:44 [alice] tick exit 0 at 18:25:44 noid: tip 281108 instance {...} ... eth : latest 1416 ... ACTION: {"action": "wait", "reason": "..."} notes: [...] intent: {...} applied: True phase_after: lock_final
 *
 * The helper now cuts each part of the line on its own and always ends it with `applied: … phase_after: …`, so the tail is there. Lines
 * written before that change were cut as a whole at 1200 characters: their tail is missing or ends in a fragment of a phase name
 * ("lock_final" cut to "re"). A phase name is taken from a line only when it is a phase the console knows, or when the line is too short to
 * have been cut; otherwise the line has NO phase (`phase_after` null, `truncated` true) and takes no part in the phase changes. Older runs wrote
 * the multi-line block that `statusfile.js` parses. Both are accepted; the result is a short history (newest last) of
 * `{ time, role, exit_code, action, reason, phase_after, truncated }`. Nothing here is trusted beyond display.
 */

const { splitBlocks, parseBlock } = require("./statusfile");
const P = require("./phases");

// The longest line the old helper wrote: `cut -c1-1200`. A line at or past this length may have lost its tail.
const OLD_CUT = 1190;
const KNOWN_PHASES = new Set([...P.phaseIds("alice"), ...P.phaseIds("bob")]);

const LINE = /^(?:(\d{2}:\d{2}:\d{2})\s+)?\[(\w+)\]\s+tick\s+exit\s+(-?\d+)\s+at\s+(\S+)(.*)$/;

function fromLine(line) {
  const m = LINE.exec(line.trim());
  if (!m) return null;
  const rest = m[5] || "";
  const act = /ACTION:\s*\{\s*"(?:action|kind)"\s*:\s*"([a-z_]+)"(?:\s*,\s*"reason"\s*:\s*"((?:[^"\\]|\\.)*)")?/.exec(rest);
  const phm = /phase_after:\s*([a-z_]+)\s*$/.exec(rest);
  // a name that is not a phase this console knows, on a line long enough to have been cut, is a fragment: no phase at all
  const ph = phm && (KNOWN_PHASES.has(phm[1]) || line.trim().length < OLD_CUT) ? phm : null;
  const applied = /applied:\s*(True|False|true|false)/.exec(rest);
  const intent = /intent:\s*\{\s*"status"\s*:\s*"([a-z]+)"/.exec(rest);
  let reason = act && act[2] ? act[2] : null;
  if (reason) reason = reason.replace(/\\"/g, '"').replace(/\\\\/g, "\\");
  return {
    time: m[1] || m[4],
    role: m[2],
    exit_code: Number(m[3]),
    action: act ? act[1] : null,
    reason,
    phase_after: ph ? ph[1] : null,
    applied: applied ? /^t/i.test(applied[1]) : null,
    intent_status: intent ? intent[1] : null,
    truncated: !ph,
  };
}

/** @returns {{entries: object[], total: number}} the last `limit` ticks, oldest first. */
function parseLoopText(text, limit = 40) {
  const s = String(text || "");
  const entries = [];
  let blocks = 0;
  const lines = s.split(/\r?\n/);
  const hasBlocks = lines.some((l) => /^\[\w+\]\s+tick\s/.test(l));
  if (hasBlocks) {
    for (const b of splitBlocks(s)) {
      const v = parseBlock(b);
      if (!v) continue;
      blocks++;
      entries.push({
        time: v.tick_at,
        role: v.role,
        exit_code: v.exit_code,
        action: v.action,
        reason: v.reason,
        phase_after: v.phase,
        applied: v.applied,
        intent_status: null,
        truncated: false,
      });
    }
  }
  if (!hasBlocks || !entries.length) {
    for (const l of lines) {
      const e = fromLine(l);
      if (e) entries.push(e);
    }
  }
  return { entries: entries.slice(-limit), total: entries.length };
}

/** Phase transitions in a loop history: `[{time, from, to}]`, from the entries that carry `phase_after`. */
function phaseChanges(entries) {
  const out = [];
  let prev = null;
  for (const e of entries) {
    if (!e.phase_after) continue;
    if (prev !== null && e.phase_after !== prev) out.push({ time: e.time, from: prev, to: e.phase_after });
    prev = e.phase_after;
  }
  return out;
}

module.exports = { parseLoopText, phaseChanges, fromLine };
