"use strict";
/*
 * The append-only audit log of the actions mode.
 *
 * One JSON object per line in <public copy dir>/ui-audit.jsonl. The file is opened with the "a" flag only (this module has
 * no code path that truncates, rewrites or deletes it), and each line carries `prev`, the SHA-256 of the previous line, so
 * an edit or a cut in the middle is visible to `verify()`. It holds times, action ids, roles, result codes, hashes of dry
 * runs and transaction hashes: no secret, no opening, no address of a wallet beyond what the result files already show.
 *
 * Fail closed: when a line cannot be written, `append` throws and the caller does not run the action.
 */

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const FILE = "ui-audit.jsonl";
const sha256 = (s) => crypto.createHash("sha256").update(s).digest("hex");
const utc = (ms) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");

class AuditLog {
  /** @param {string} dir the public copy directory (must exist) @param {{now?:()=>number}} [o] */
  constructor(dir, o = {}) {
    if (!dir) throw new Error("audit log: no directory");
    this.dir = dir;
    this.file = path.join(dir, FILE);
    this.now = o.now || Date.now;
    // The role this console was started with (alice | bob | both): every line says which machine-side wrote it.
    this.serverRole = o.role || null;
    // Created now so a read-only or missing directory is found at start, not at the first action.
    fs.closeSync(fs.openSync(this.file, "a"));
    const lines = this.readLines();
    this.seq = lines.length ? (lines[lines.length - 1].rec.seq || lines.length) : 0;
    this.lastLine = lines.length ? lines[lines.length - 1].raw : "";
  }

  readLines() {
    // The WHOLE file: the latches and the funding guards are rebuilt from it, so a cap on what is read would let an old line fall off the
    // end and re-open a send. (The log is a few hundred short lines per run.)
    const text = fs.readFileSync(this.file, "utf8");
    const out = [];
    for (const raw of text.split("\n")) {
      if (!raw.trim()) continue;
      try {
        out.push({ raw, rec: JSON.parse(raw) });
      } catch {
        out.push({ raw, rec: { corrupt: true } });
      }
    }
    return out;
  }

  /**
   * @param {{action:string, role?:string|null, phase:string, result:string, dry_hash?:string|null, detail?:string|null, tx?:string|null}} r
   * @returns {object} the record as written
   */
  append(r) {
    const rec = {
      t: utc(this.now()),
      seq: this.seq + 1,
      action: String(r.action).slice(0, 40),
      role: r.role || null,
      phase: String(r.phase).slice(0, 20),
      result: String(r.result).slice(0, 120),
      dry_hash: r.dry_hash || null,
      tx: r.tx || null,
      detail: r.detail ? String(r.detail).slice(0, 300) : null,
      ...(this.serverRole ? { srv_role: this.serverRole } : {}),
      prev: this.lastLine ? sha256(this.lastLine) : null,
    };
    const line = JSON.stringify(rec);
    const fd = fs.openSync(this.file, "a");
    try {
      fs.writeSync(fd, line + "\n");
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    this.seq = rec.seq;
    this.lastLine = line;
    return rec;
  }

  /** Every record, oldest first (the latches and the funding guards are rebuilt from all of them after a restart). */
  all() {
    return this.readLines().map((l) => l.rec);
  }

  /** The last n records, newest last. */
  tail(n = 40) {
    return this.readLines().slice(-n).map((l) => l.rec);
  }

  /** Walks the readable part of the file and reports the first broken link, if any. */
  verify() {
    const lines = this.readLines();
    for (let i = 1; i < lines.length; i++) {
      if (lines[i].rec.corrupt) return { ok: false, line: i + 1, reason: "a line is not JSON" };
      if (lines[i].rec.prev !== sha256(lines[i - 1].raw)) return { ok: false, line: i + 1, reason: "the previous-line hash does not match" };
    }
    return { ok: true, lines: lines.length };
  }
}

module.exports = { AuditLog, FILE, utc };
