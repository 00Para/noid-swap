"use strict";
/*
 * A fake key store for the tests (interface I5): seals with AES-256-GCM under a random key made for each instance, so what it writes is opaque to a
 * test and cannot be opened by another instance (as a key store of another machine or user could not be).
 *
 *   createFakeKeyStore({ kind? }) -> { kind, available(), seal(buf), open(buf), knobs }
 *   knobs: { available: true, openThrows: false, sealThrows: false, wrongData: false }   (change them at any time)
 *     available:false   available() answers false (a Linux "basic text" store, a refused Keychain)
 *     openThrows        open() throws (a user profile that lost its keys)
 *     sealThrows        seal() throws
 *     wrongData         open() answers 32 other bytes (a key store that lies)
 */

const crypto = require("crypto");

function createFakeKeyStore({ kind = "fake" } = {}) {
  const key = crypto.randomBytes(32);
  const knobs = { available: true, openThrows: false, sealThrows: false, wrongData: false };
  return {
    kind,
    knobs,
    available() {
      return knobs.available;
    },
    seal(plain) {
      if (knobs.sealThrows) throw new Error("fake key store: seal refused");
      const nonce = crypto.randomBytes(12);
      const c = crypto.createCipheriv("aes-256-gcm", key, nonce);
      const ct = Buffer.concat([c.update(plain), c.final()]);
      return Buffer.concat([nonce, c.getAuthTag(), ct]);
    },
    open(blob) {
      if (knobs.openThrows) throw new Error("fake key store: open refused");
      const d = crypto.createDecipheriv("aes-256-gcm", key, blob.subarray(0, 12));
      d.setAuthTag(blob.subarray(12, 28));
      const out = Buffer.concat([d.update(blob.subarray(28)), d.final()]);
      return knobs.wrongData ? crypto.randomBytes(out.length) : out;
    },
  };
}

module.exports = { createFakeKeyStore };
