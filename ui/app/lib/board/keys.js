"use strict";
/*
 * The board's messaging keys and the invite secret, kept in `board-keys.json` in the run folder.
 *
 * KNOWN GAP OF THIS STEP (the README says so too): the file is NOT sealed. The swap tools' sealing (Argon2id + XChaCha20-Poly1305 with the run's passphrase) exists only inside swap-cli's
 * swap files, and no swap-cli command seals an arbitrary secret, so there is nothing to call. The file is written with owner-only permissions where the platform supports them (mode 0600
 * on POSIX; on Windows the mode is ignored and the folder's own access rules apply), through a temporary file and a rename. What it holds controls NO coins: a messaging key can only talk
 * inside one swap (lib/board/handover.js), and the invite secret admits to a small trusted test board. The installer piece moves both to the operating system's key store with the other
 * secrets. Nothing here is ever logged, put in an audit line, an error text, the run payload or the page: a key leaves this module only as the Buffer a signer needs.
 *
 * Shape: { v: 1, invite: <64 hex>|null, keys: { <x-only public key>: <64 hex secret>, ... } }. A key is looked up by its public key; the file is read again after a restart.
 */

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { pathCandidates } = require("../runfolder");
const { generateSecretKey, getPublicKey, isHex64 } = require("./note");

const FILE = "board-keys.json";
const MAX_KEYS = 64;

class KeyStore {
  /** @param {string} dir the run folder (as the console reads it) */
  constructor(dir) {
    this.dir = dir;
    this.data = { v: 1, invite: null, keys: {} };
    this.load();
  }

  load() {
    for (const c of pathCandidates(this.dir)) {
      let text;
      try {
        text = fs.readFileSync(path.join(c, FILE), "utf8");
      } catch (e) {
        if (e && e.code === "ENOENT") continue;
        throw new Error("the board's key file cannot be read");
      }
      let j;
      try {
        j = JSON.parse(text);
      } catch {
        throw new Error("the board's key file is not JSON");
      }
      if (!j || j.v !== 1 || typeof j.keys !== "object" || j.keys === null || Array.isArray(j.keys)) throw new Error("the board's key file is not one this console wrote");
      const keys = {};
      for (const [pub, sec] of Object.entries(j.keys)) {
        if (!isHex64(pub) || !isHex64(sec) || getPublicKey(sec) !== pub) throw new Error("the board's key file holds a key that does not match its public key");
        keys[pub] = sec;
      }
      if (j.invite !== null && !isHex64(j.invite)) throw new Error("the board's key file holds an invite secret in the wrong shape");
      this.data = { v: 1, invite: j.invite, keys };
      return;
    }
  }

  save() {
    let last = null;
    const text = JSON.stringify(this.data) + "\n";
    for (const c of pathCandidates(this.dir)) {
      const tmp = path.join(c, `.${FILE}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`);
      try {
        fs.writeFileSync(tmp, text, { flag: "wx", mode: 0o600 });
        fs.renameSync(tmp, path.join(c, FILE));
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
    throw new Error(`the board's key file cannot be written (${(last && last.code) || "error"})`);
  }

  /** A fresh messaging key from the OS generator; stored before it is returned. @returns {{pub:string, secret:Buffer}} */
  newKey() {
    if (Object.keys(this.data.keys).length >= MAX_KEYS) throw new Error("the board's key file holds too many keys: clear it by hand (a swap is over)");
    const secret = generateSecretKey();
    const pub = getPublicKey(secret);
    this.data.keys[pub] = secret.toString("hex");
    this.save();
    return { pub, secret };
  }

  has(pub) {
    return Object.prototype.hasOwnProperty.call(this.data.keys, pub);
  }

  /** The secret key of a stored public key, as a Buffer, or null. */
  secretFor(pub) {
    return this.has(pub) ? Buffer.from(this.data.keys[pub], "hex") : null;
  }

  /** The invite secret of the private test board as a Buffer, or null. */
  invite() {
    return this.data.invite ? Buffer.from(this.data.invite, "hex") : null;
  }

  setInvite(hex) {
    if (!isHex64(hex)) throw new Error("the invite secret is 64 lower-case hex characters");
    this.data.invite = hex;
    this.save();
  }
}

module.exports = { KeyStore, FILE };
