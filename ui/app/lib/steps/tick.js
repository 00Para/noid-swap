"use strict";
/*
 * One tick of one role (scripts/live/tick.sh): `swap-cli tick FILE <nodes> <log start> <reveal tx> --record-noid .. --record-eth .. [--apply] [--closed-by TXID]`.
 * Read-only without --apply (it withholds a spend's parameters). `opts.observeOnly` runs `--apply --observe-only` instead: it records the facts the chains show (phase moves) and
 * never an intent, an abort or a spend's parameters (swap-cli README, "tick --apply --observe-only"); it is refused by swap-cli while the file holds an intent (exit 1, "observe-only is refused"). The tick's JSON goes to last-tick-ROLE.json and its stderr to last-tick-ROLE.err in the run
 * folder (both opened, and so emptied, before the tool runs: the console reads a half-written file as "being written"); every node answer is recorded under rec/.
 * The result's stdout is the one-screen summary the helper prints, with each ALERT: note and the pending-claim ALARM: note on a line of its own.
 *
 * Exit code: swap-cli's own code (0 ok, 1 its refusal or failure); 2 a setting, a flag or a tool is wrong, or there is no passphrase (nothing was run);
 * 124 the limit given in `opts.limitMs` was hit (the child was killed); 127 swap-cli could not be started.
 */

const fs = require("fs");
const path = require("path");
const C = require("./common");

// ---- Python's printing of a JSON value, so that the summary has the helper's exact wording (tick.sh builds it with python3)

function jsonAscii(s) {
  return JSON.stringify(s).replace(/[^\x20-\x7e]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);
}

/** json.dumps (default separators, ensure_ascii). */
function pyDumps(v) {
  if (v === null || v === undefined) return "null";
  if (typeof v === "boolean") return v ? "true" : "false";
  if (typeof v === "number") return String(v);
  if (typeof v === "string") return jsonAscii(v);
  if (Array.isArray(v)) return `[${v.map(pyDumps).join(", ")}]`;
  return `{${Object.entries(v)
    .map(([k, x]) => `${jsonAscii(k)}: ${pyDumps(x)}`)
    .join(", ")}}`;
}

function pyStrLiteral(s) {
  const q = s.includes("'") && !s.includes('"') ? '"' : "'";
  let o = q;
  for (const ch of s) {
    if (ch === "\\") o += "\\\\";
    else if (ch === q) o += `\\${q}`;
    else if (ch === "\n") o += "\\n";
    else if (ch === "\r") o += "\\r";
    else if (ch === "\t") o += "\\t";
    else if (ch < " " || ch === "\x7f") o += `\\x${ch.charCodeAt(0).toString(16).padStart(2, "0")}`;
    else o += ch;
  }
  return o + q;
}

/** repr() of a JSON value. */
function pyRepr(v) {
  if (v === null || v === undefined) return "None";
  if (typeof v === "boolean") return v ? "True" : "False";
  if (typeof v === "number") return String(v);
  if (typeof v === "string") return pyStrLiteral(v);
  if (Array.isArray(v)) return `[${v.map(pyRepr).join(", ")}]`;
  return `{${Object.entries(v)
    .map(([k, x]) => `${pyStrLiteral(k)}: ${pyRepr(x)}`)
    .join(", ")}}`;
}

/** What print() shows for one argument. */
function pyStr(v) {
  return typeof v === "string" ? v : pyRepr(v);
}

const obj = (x) => (x && typeof x === "object" && !Array.isArray(x) ? x : {});
const len = (x) => (!x ? 0 : Array.isArray(x) || typeof x === "string" ? x.length : typeof x === "object" ? Object.keys(x).length : 0);

/** The summary lines of tick.sh for a tick's JSON text. */
function summaryLines(text) {
  let v;
  try {
    v = JSON.parse(text);
  } catch (e) {
    return [`no json: ${text.trim() === "" ? "Expecting value: line 1 column 1 (char 0)" : e.message}`];
  }
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const n = obj(v.noid);
  const e = obj(v.eth);
  const p = (...parts) => parts.map(pyStr).join(" ");
  const L = [];
  L.push(p("noid: tip", n.tip, "instance", pyDumps(n.instance).slice(0, 160), "matches", n.instance_matches_opening, "pending", len(n.pending_calls), "confirmed", pyDumps(n.confirmed_tx).slice(0, 100), "tracked_pending", n.tracked_tx_pending));
  L.push(p("eth : latest", e.latest_block, "finalized", e.finalized_block, "ts", e.latest_timestamp, "lock", pyDumps(e.lock).slice(0, 200), "claimed", pyDumps(e.claimed).slice(0, 80), "pending_preimage", e.pending_preimage, "refunded", pyDumps(e.refunded).slice(0, 80)));
  L.push(p("sources:", pyDumps(v.sources).slice(0, 300)));
  L.push(p("events:", pyDumps(v.events).slice(0, 300)));
  L.push(p("ACTION:", pyDumps(v.action).slice(0, 600)));
  L.push(p("notes:", pyDumps(v.notes).slice(0, 1500)));
  const notes = Array.isArray(v.notes) ? v.notes : [];
  for (const note of notes) if (typeof note === "string" && note.startsWith("ALERT:")) L.push(note);
  for (const note of notes) if (typeof note === "string" && note.startsWith("ALARM: the NOID claim is still pending")) L.push(note);
  L.push(p("intent:", pyDumps(v.intent).slice(0, 300)));
  // an observe-only tick (the program's read loop) wrote facts and decided nothing: not "applied: True" (scripts/live/tick.sh never passes --observe-only, so its wording is unchanged)
  L.push(p("applied:", v.observe_only === true ? "observe-only" : v.events_applied_to_file, "phase_after:", v.phase_after));
  return L;
}

/** The flags a tick may be given besides the standard ones: `--apply` and `--closed-by TXID`, each at most once. */
function checkExtraArgs(args) {
  if (!Array.isArray(args)) throw new C.Refusal(2, "the extra tick flags must be a list");
  let apply = false;
  let closed = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--apply" && !apply) apply = true;
    else if (a === "--closed-by" && !closed && typeof args[i + 1] === "string" && /^(0x)?[0-9a-fA-F]{64}$/.test(args[i + 1])) {
      closed = true;
      i++;
    } else throw new C.Refusal(2, `tick: the flag '${String(a).slice(0, 40)}' is not one this step passes on (--apply, --closed-by TXID). Nothing was run`);
  }
}

/**
 * @param {object} ctx the step context (see README.md)
 * @param {"alice"|"bob"} role
 * @param {{args?: string[], limitMs?: number, observeOnly?: boolean}} [opts] args: extra flags (`--apply`, `--closed-by TXID`); observeOnly: `--apply --observe-only` (no other flag)
 * @returns {Promise<{code:number|null, stdout:string, stderr:string, files:string[]}>}
 */
function tick(ctx, role, opts = {}) {
  return C.guard(async (out) => {
    C.checkRole(ctx, role);
    const observeOnly = opts.observeOnly === true;
    if (observeOnly && opts.args && opts.args.length) throw new C.Refusal(2, "tick: observe-only takes no other flag. Nothing was run");
    const extra = observeOnly ? ["--apply", "--observe-only"] : opts.args || [];
    if (!observeOnly) checkExtraArgs(extra);
    C.checkTool(ctx, "swapCli");
    const F = C.swapFile(ctx, role);
    C.mkdir700(path.join(ctx.runDir, "rec"));
    const base = C.tickBase(ctx);
    if (base.error) throw new C.Refusal(2, base.error);
    for (const w of base.warnings) out.warn(w);
    const stamp = C.clock(C.nowMs(ctx), false);
    const jsonName = `last-tick-${role}.json`;
    const errName = `last-tick-${role}.err`;
    const args = ["tick", F, ...base.args, "--record-noid", path.join(ctx.runDir, "rec", `${role}-noid-${stamp}.json`), "--record-eth", path.join(ctx.runDir, "rec", `${role}-eth-${stamp}.json`), ...extra];
    const r = await C.runChild(ctx, { tool: "swapCli", args, passphrase: true, stdoutFile: path.join(ctx.runDir, jsonName), stderrFile: path.join(ctx.runDir, errName), limitMs: opts.limitMs });
    out.file(jsonName);
    out.file(errName);
    for (const kind of ["noid", "eth"]) {
      const rel = `rec/${role}-${kind}-${stamp}.json`;
      if (fs.existsSync(path.join(ctx.runDir, rel))) out.file(rel);
    }
    let ec;
    if (r.error) {
      ec = 127;
      out.warn(`swap-cli could not be started: ${r.error.code || r.error.message}`);
    } else if (r.timedOut) ec = 124;
    else ec = r.code === null ? 1 : r.code;
    out.say(`[${role}] tick exit ${ec} at ${C.clock(C.nowMs(ctx), true)}`);
    const errText = C.readTextCapped(path.join(ctx.runDir, errName), 1024 * 1024) || "";
    const errLines = errText.split("\n");
    if (errText.endsWith("\n") || errText === "") errLines.pop();
    for (const line of errLines.slice(0, 5)) out.say(line);
    const text = C.readTextCapped(path.join(ctx.runDir, jsonName), 64 * 1024 * 1024) || "";
    const lines = summaryLines(text);
    if (lines === null) out.warn("tick summary: the tool's output is not a JSON object");
    else for (const l of lines) out.say(l);
    return out.done(ec);
  });
}

module.exports = { tick, summaryLines, pyDumps, pyRepr, pyStr };
