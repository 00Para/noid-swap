"use strict";
/*
 * `handover-ROLE.json`: the board's persisted state for the one swap of this run folder (piece 3). Written through a temporary file and a rename (nobody reads a half-written one),
 * mode 0600, after every change; read back after a restart so that a restart never repeats a helper action that already ran and never forgets a verified check.
 *
 * It holds NO key and NO secret: the messaging keys are in board-keys.json (lib/board/keys.js). It holds what the state machine needs to continue (its snapshot), the offer this swap is
 * for, the counterparty's messaging key, the messages sent (the outbox), the results of the helper steps that ran (a signature, a digest: public values), the verified handover
 * check, and a stop marker. Every field that reaches the run payload is turned into a fixed code first (lib/board/host.js view()); no free text of a message is stored at all.
 */

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { pathCandidates } = require("../runfolder");

const VERSION = 1;
const MAX_BYTES = 512 * 1024;
const fileOf = (role) => `handover-${role}.json`;

/** `{ exists, value, error }` of the handover file of a role, as it is on disk now. */
function readHandover(dir, role) {
  if (!dir) return { exists: false, value: null, error: null };
  let err = null;
  for (const c of pathCandidates(dir)) {
    const full = path.join(c, fileOf(role));
    let text;
    try {
      const st = fs.lstatSync(full);
      if (!st.isFile() || st.size > MAX_BYTES) return { exists: true, value: null, error: "not a regular file of a sane size" };
      text = fs.readFileSync(full, "utf8");
    } catch (e) {
      if (!e || e.code !== "ENOENT") err = (e && e.code) || "unreadable";
      continue;
    }
    try {
      const v = JSON.parse(text);
      if (!v || typeof v !== "object" || v.v !== VERSION || v.role !== role) return { exists: true, value: null, error: "not a handover file of this console" };
      return { exists: true, value: v, error: null };
    } catch {
      return { exists: true, value: null, error: "not JSON" };
    }
  }
  return err ? { exists: true, value: null, error: err } : { exists: false, value: null, error: null };
}

/** Writes the file atomically. Throws when it cannot (the caller then does not go on). */
function writeHandover(dir, role, obj) {
  if (!dir) throw new Error("no run folder is known");
  const text = JSON.stringify({ ...obj, v: VERSION, role }, null, 2) + "\n";
  if (text.length > MAX_BYTES) throw new Error("the handover file would be too large");
  let last = null;
  for (const c of pathCandidates(dir)) {
    const tmp = path.join(c, `.${fileOf(role)}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`);
    try {
      fs.writeFileSync(tmp, text, { flag: "wx", mode: 0o600 });
      fs.renameSync(tmp, path.join(c, fileOf(role)));
      return;
    } catch (e) {
      last = e;
      try {
        fs.unlinkSync(tmp);
      } catch {
        /* not there */
      }
    }
  }
  throw new Error(`the handover file cannot be written (${(last && last.code) || "error"})`);
}

module.exports = { readHandover, writeHandover, fileOf, VERSION };
