"use strict";
/*
 * The board's messaging keys and the invite secret, kept in `board-keys.json` in the run folder.
 *
 * SEALING (step 4.6). Without a sealer (terminal mode, the console as it was) the file is plain JSON with owner-only permissions where the platform supports them (mode 0600 on POSIX;
 * on Windows the mode is ignored and the folder's own access rules apply), through a temporary file and a rename: byte for byte what this module always wrote. With a sealer
 * (`new KeyStore(dir, { sealer })`, the program's vault gives one per run: desktop/lib/vault.js boardSealer) the whole text is AES-256-GCM sealed under a key derived from the install
 * secret and the run id before it is written: a sealed envelope is opened with the sealer, a PLAIN file found with a sealer is read and saved again sealed (the migration), and a
 * SEALED file found without a sealer is refused ("sealed by the program: open it in the program"). The sealer is { seal(plain: Buffer, fileName) => Buffer, open(sealed: Buffer, fileName) => Buffer }.
 * What the file holds controls NO coins: a messaging key can only talk inside one swap (lib/board/handover.js), and the invite secret admits to a small trusted test board.
 * Nothing here is ever logged, put in an audit line, an error text, the run payload or the page: a key leaves this module only as the Buffer a signer needs.
 *
 * Shape (the plain text, sealed or not): { v: 1, invite: <64 hex>|null, keys: { <x-only public key>: <64 hex secret>, ... } }. A key is looked up by its public key; the file is read again after a restart.
 */

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { pathCandidates } = require("../runfolder");
const { generateSecretKey, getPublicKey, isHex64 } = require("./note");

const FILE = "board-keys.json";
const MAX_KEYS = 64;

/** True for a sealed envelope (desktop/lib/sealed.js) as opposed to the plain key file. */
function isSealedShape(j) {
  return !!j && typeof j === "object" && !Array.isArray(j) && Object.prototype.hasOwnProperty.call(j, "ct") && Object.prototype.hasOwnProperty.call(j, "tag") && Object.prototype.hasOwnProperty.call(j, "nonce");
}

class KeyStore {
  /**
   * @param {string} dir the run folder (as the console reads it)
   * @param {{sealer?: {seal: Function, open: Function}|null}} [opts] sealer: see the header; null or absent keeps the plain file
   */
  constructor(dir, opts = {}) {
    this.dir = dir;
    this.sealer = (opts && opts.sealer) || null;
    this.data = { v: 1, invite: null, keys: {} };
    this.load();
  }

  load() {
    for (const c of pathCandidates(this.dir)) {
      let raw;
      try {
        raw = fs.readFileSync(path.join(c, FILE));
      } catch (e) {
        if (e && e.code === "ENOENT") continue;
        throw new Error("the board's key file cannot be read");
      }
      let j;
      try {
        j = JSON.parse(raw.toString("utf8"));
      } catch {
        throw new Error("the board's key file is not JSON");
      }
      let migrate = false;
      if (isSealedShape(j)) {
        if (!this.sealer) throw new Error("the board's key file is sealed by the program: open it in the program");
        let plain = null;
        try {
          plain = this.sealer.open(raw, FILE);
        } catch {
          throw new Error("the board's key file cannot be opened: it was sealed by another installation, or it is damaged");
        }
        try {
          j = JSON.parse(plain.toString("utf8"));
        } catch {
          throw new Error("the board's key file is not JSON");
        } finally {
          if (Buffer.isBuffer(plain)) plain.fill(0);
        }
      } else if (this.sealer) migrate = true;
      if (!j || j.v !== 1 || typeof j.keys !== "object" || j.keys === null || Array.isArray(j.keys)) throw new Error("the board's key file is not one this console wrote");
      const keys = {};
      for (const [pub, sec] of Object.entries(j.keys)) {
        if (!isHex64(pub) || !isHex64(sec) || getPublicKey(sec) !== pub) throw new Error("the board's key file holds a key that does not match its public key");
        keys[pub] = sec;
      }
      if (j.invite !== null && !isHex64(j.invite)) throw new Error("the board's key file holds an invite secret in the wrong shape");
      this.data = { v: 1, invite: j.invite, keys };
      if (migrate) this.save(); // a plain file found with a sealer is saved again sealed
      return;
    }
  }

  save() {
    let last = null;
    const text = JSON.stringify(this.data) + "\n";
    let body = text;
    if (this.sealer) {
      const plain = Buffer.from(text, "utf8");
      try {
        body = this.sealer.seal(plain, FILE);
      } catch {
        throw new Error("the board's key file cannot be sealed");
      } finally {
        plain.fill(0);
      }
    }
    for (const c of pathCandidates(this.dir)) {
      const tmp = path.join(c, `.${FILE}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`);
      try {
        fs.writeFileSync(tmp, body, { flag: "wx", mode: 0o600 });
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
