"use strict";
/*
 * Sealed files (piece 4, spec 6.4): AES-256-GCM under a key derived from the install secret (derive.js), as one small JSON file.
 *
 *   { "v": 1, "alg": "AES-256-GCM", "label": "<label>", "run_id": "<32 hex>"|"install", "nonce": "<24 hex>", "ct": "<hex>", "tag": "<32 hex>" }
 *
 *   AAD   = UTF-8 of "no1d-swap sealed v1\u0000" + label + "\u0000" + run_id + "\u0000" + fileName        (fileName: the base name the file is written under)
 *   nonce = 12 random bytes, a new one for every write
 *   label = "migrated-passphrase" (passphrase.sealed), "board" (board-keys.json), "board-invite" (vault/board-invite.sealed, run id "install"),
 *           "payout-history" (payout-history.sealed in the data folder, run id "install")
 *
 * A file whose label, run id or file name does not match what the caller expects, whose fields are not exactly these, or that fails the tag check is
 * refused with a fixed text that carries no part of the file. Writes go through a temporary file and a rename, mode 0600.
 * Nothing here keeps a key or a plain text; the caller owns and zero-fills its buffers.
 */

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { isRunId } = require("./derive");

const LABELS = Object.freeze(["migrated-passphrase", "board", "board-invite", "payout-history", "swap-backup"]);
const MAX_CT = 1024 * 1024;
const FIELDS = ["v", "alg", "label", "run_id", "nonce", "ct", "tag"];

class SealedError extends Error {}

function idOk(label, runId) {
  return label === "board-invite" || label === "payout-history" ? runId === "install" : isRunId(runId);
}

function aad(label, runId, fileName) {
  return Buffer.from(`no1d-swap sealed v1\u0000${label}\u0000${runId}\u0000${fileName}`, "utf8");
}

function checkArgs(key, label, runId, fileName) {
  if (!Buffer.isBuffer(key) || key.length !== 32) throw new SealedError("the sealing key is not 32 bytes");
  if (!LABELS.includes(label)) throw new SealedError("unknown sealing label");
  if (!idOk(label, runId)) throw new SealedError("the run id is not valid for this label");
  if (typeof fileName !== "string" || !fileName || fileName !== path.basename(fileName) || fileName.includes("\0")) throw new SealedError("the file name is not a base name");
}

/** The envelope object for `plain` (a Buffer). */
function seal({ key, label, runId, fileName, plain }) {
  checkArgs(key, label, runId, fileName);
  if (!Buffer.isBuffer(plain) || plain.length > MAX_CT) throw new SealedError("nothing to seal, or too large");
  const nonce = crypto.randomBytes(12);
  const c = crypto.createCipheriv("aes-256-gcm", key, nonce, { authTagLength: 16 });
  c.setAAD(aad(label, runId, fileName));
  const ct = Buffer.concat([c.update(plain), c.final()]);
  return { v: 1, alg: "AES-256-GCM", label, run_id: runId, nonce: nonce.toString("hex"), ct: ct.toString("hex"), tag: c.getAuthTag().toString("hex") };
}

function sealToText(args) {
  return `${JSON.stringify(seal(args))}\n`;
}

/** True for an object that is shaped like an envelope (it says nothing of whether it opens): the board's key file uses this to tell sealed from plain. */
function isEnvelope(o) {
  return !!o && typeof o === "object" && !Array.isArray(o) && Object.prototype.hasOwnProperty.call(o, "ct") && Object.prototype.hasOwnProperty.call(o, "tag") && Object.prototype.hasOwnProperty.call(o, "nonce");
}

/** The plain text (a Buffer) of an envelope given as an object or as text. Throws SealedError. */
function open({ key, label, runId, fileName, envelope }) {
  checkArgs(key, label, runId, fileName);
  let o = envelope;
  if (Buffer.isBuffer(o)) o = o.toString("utf8");
  if (typeof o === "string") {
    try {
      o = JSON.parse(o);
    } catch {
      throw new SealedError("the sealed file is not JSON");
    }
  }
  if (!o || typeof o !== "object" || Array.isArray(o)) throw new SealedError("the sealed file is not a sealed file");
  const keys = Object.keys(o);
  if (keys.length !== FIELDS.length || !FIELDS.every((k) => Object.prototype.hasOwnProperty.call(o, k))) throw new SealedError("the sealed file is not a sealed file");
  if (o.v !== 1 || o.alg !== "AES-256-GCM") throw new SealedError("the sealed file is of a kind this program does not know");
  if (o.label !== label || o.run_id !== runId) throw new SealedError("the sealed file is for another run or another use");
  if (typeof o.nonce !== "string" || !/^[0-9a-f]{24}$/.test(o.nonce) || typeof o.tag !== "string" || !/^[0-9a-f]{32}$/.test(o.tag) || typeof o.ct !== "string" || !/^(?:[0-9a-f]{2})*$/.test(o.ct) || o.ct.length > MAX_CT * 2) {
    throw new SealedError("the sealed file is not a sealed file");
  }
  const d = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(o.nonce, "hex"), { authTagLength: 16 });
  d.setAAD(aad(label, runId, fileName));
  d.setAuthTag(Buffer.from(o.tag, "hex"));
  try {
    return Buffer.concat([d.update(Buffer.from(o.ct, "hex")), d.final()]);
  } catch {
    throw new SealedError("the sealed file cannot be opened: it is damaged, or it was sealed by another installation");
  }
}

/** Writes bytes to `file` through a temporary file in the same folder and a rename, mode 0600. */
function writeAtomic(file, data, io = fs) {
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`);
  let fd = null;
  try {
    fd = io.openSync(tmp, "wx", 0o600);
    io.writeSync(fd, data);
    io.fsyncSync(fd);
    io.closeSync(fd);
    fd = null;
    io.renameSync(tmp, file);
  } catch (e) {
    if (fd !== null) {
      try {
        io.closeSync(fd);
      } catch {
        /* ignore */
      }
    }
    try {
      io.unlinkSync(tmp);
    } catch {
      /* never made, or renamed away */
    }
    throw e;
  }
}

/** Seals `plain` and writes it as `file` (the base name of `file` is bound into the AAD). */
function writeSealedFile(file, { key, label, runId, plain }, io = fs) {
  writeAtomic(file, Buffer.from(sealToText({ key, label, runId, fileName: path.basename(file), plain }), "utf8"), io);
}

/** Reads and opens a sealed file. A link or a non-file is refused. */
function readSealedFile(file, { key, label, runId }, io = fs) {
  let st;
  try {
    st = io.lstatSync(file);
  } catch {
    throw new SealedError("the sealed file cannot be read");
  }
  if (!st.isFile()) throw new SealedError("the sealed file is not a plain file");
  if (st.size > MAX_CT * 4) throw new SealedError("the sealed file is too large");
  let buf;
  try {
    buf = io.readFileSync(file);
  } catch {
    throw new SealedError("the sealed file cannot be read");
  }
  return open({ key, label, runId, fileName: path.basename(file), envelope: buf });
}

module.exports = { LABELS, SealedError, seal, sealToText, open, isEnvelope, writeAtomic, writeSealedFile, readSealedFile };
