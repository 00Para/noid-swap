"use strict";
/*
 * Parser for the engine's tick-loop text (the `loop-<role>.txt` a watch loop
 * writes). One block looks like:
 *
 *   [alice] tick exit 0 at 18:25:14
 *   noid: tip 281108 instance {"amount_micronoid": 10000000, ...} matches True pending 0 confirmed null tracked_pending None
 *   eth : latest 1416 finalized 1416 ts 1793816708 lock null claimed null pending_preimage None refunded {'block_number': 1320, ...}
 *   events: []
 *   ACTION: {"action": "wait", "reason": "..."}
 *   notes: ["..."]
 *   applied: True phase_after: lock_final
 *
 * Values are a mix of JSON and Python literals (True/None, single quotes).
 * If the file holds several blocks, the LAST one wins. Nothing here is
 * trusted beyond display: a malformed block gives `null`, never a throw.
 */

/** Python literal -> JSON text (quotes, True/False/None), then JSON.parse. */
function pyLiteral(text) {
  if (text === undefined || text === null) return null;
  const s = String(text).trim();
  if (s === "" || s === "None" || s === "null") return null;
  if (s === "True" || s === "true") return true;
  if (s === "False" || s === "false") return false;
  if (/^-?\d+$/.test(s)) return Number(s);
  let out = "";
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (c === "'" || c === '"') {
      const q = c;
      let j = i + 1;
      let str = "";
      while (j < s.length && s[j] !== q) {
        if (s[j] === "\\" && j + 1 < s.length) {
          str += s[j] + s[j + 1];
          j += 2;
          continue;
        }
        str += s[j] === '"' && q === "'" ? '\\"' : s[j];
        j++;
      }
      out += '"' + str + '"';
      i = j + 1;
      continue;
    }
    const m = /^(True|False|None)\b/.exec(s.slice(i));
    if (m) {
      out += m[1] === "True" ? "true" : m[1] === "False" ? "false" : "null";
      i += m[1].length;
      continue;
    }
    out += c;
    i++;
  }
  try {
    return JSON.parse(out);
  } catch {
    return s; // leave it as text rather than fail the whole block
  }
}

/** "k1 v1 k2 {..} k3 v3" -> { k1, k2, k3 }; a value in brackets may contain spaces. */
function parseKeyValues(text) {
  const out = {};
  const s = text.trim();
  let i = 0;
  const skipWs = () => {
    while (i < s.length && /\s/.test(s[i])) i++;
  };
  const readValue = () => {
    const open = s[i];
    if (open === "{" || open === "[") {
      const close = open === "{" ? "}" : "]";
      let depth = 0;
      let q = null;
      let j = i;
      for (; j < s.length; j++) {
        const c = s[j];
        if (q) {
          if (c === "\\") j++;
          else if (c === q) q = null;
          continue;
        }
        if (c === "'" || c === '"') q = c;
        else if (c === open) depth++;
        else if (c === close) {
          depth--;
          if (depth === 0) {
            j++;
            break;
          }
        }
      }
      const v = s.slice(i, j);
      i = j;
      return v;
    }
    let j = i;
    while (j < s.length && !/\s/.test(s[j])) j++;
    const v = s.slice(i, j);
    i = j;
    return v;
  };
  while (i < s.length) {
    skipWs();
    if (i >= s.length) break;
    let j = i;
    while (j < s.length && !/\s/.test(s[j])) j++;
    const key = s.slice(i, j);
    i = j;
    skipWs();
    if (i >= s.length) {
      out[key] = null;
      break;
    }
    out[key] = pyLiteral(readValue());
  }
  return out;
}

const HEADER = /^\[(\w+)\]\s+tick\s+(.*?)\s+at\s+(\S+)\s*$/;

function splitBlocks(text) {
  const lines = String(text).split(/\r?\n/);
  const blocks = [];
  let cur = null;
  for (const line of lines) {
    if (HEADER.test(line)) {
      cur = [line];
      blocks.push(cur);
    } else if (cur) cur.push(line);
  }
  return blocks;
}

function parseBlock(lines) {
  const h = HEADER.exec(lines[0]);
  if (!h) return null;
  const exitMatch = /exit\s+(-?\d+)/.exec(h[2]);
  const view = {
    role: h[1],
    tick_at: h[3],
    exit_code: exitMatch ? Number(exitMatch[1]) : null,
    tick_status: h[2],
    noid: null,
    eth: null,
    events: [],
    action: null,
    reason: null,
    action_details: null,
    notes: [],
    applied: null,
    phase: null,
    raw_lines: lines.length,
  };
  for (const line of lines.slice(1)) {
    const t = line.trim();
    if (!t) continue;
    if (t.startsWith("noid:")) view.noid = parseKeyValues(t.slice(5));
    else if (/^eth\s*:/.test(t)) view.eth = parseKeyValues(t.replace(/^eth\s*:/, ""));
    else if (t.startsWith("events:")) {
      const v = pyLiteral(t.slice(7));
      view.events = Array.isArray(v) ? v : [];
    } else if (t.startsWith("ACTION:")) {
      const v = pyLiteral(t.slice(7));
      if (v && typeof v === "object" && !Array.isArray(v)) {
        view.action = v.action || null;
        view.reason = v.reason || null;
        view.action_details = v;
      } else (view.other = view.other || []).push(t); // an ACTION that is not an object is not an action
    } else if (t.startsWith("notes:")) {
      const v = pyLiteral(t.slice(6));
      view.notes = Array.isArray(v) ? v : [];
    } else if (t.startsWith("applied:")) {
      const kv = parseKeyValues(t);
      view.applied = kv["applied:"] === undefined ? null : kv["applied:"];
      view.phase = kv["phase_after:"] === undefined || kv["phase_after:"] === null ? null : String(kv["phase_after:"]);
    } else {
      (view.other = view.other || []).push(t);
    }
  }
  return view;
}

/** Parse the whole file text; returns the last block or null. */
function parseStatusText(text) {
  const blocks = splitBlocks(text);
  if (!blocks.length) return null;
  const last = parseBlock(blocks[blocks.length - 1]);
  if (last) last.blocks_in_file = blocks.length;
  return last;
}

module.exports = { parseStatusText, parseBlock, parseKeyValues, pyLiteral, splitBlocks };
