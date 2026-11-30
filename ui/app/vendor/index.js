"use strict";
/*
 * Loader for the vendored @noble libraries (see VENDORED.md). The files under noble-curves/ and noble-hashes/ are byte-for-byte copies; the
 * curves files ask for "@noble/hashes/<name>", which has no node_modules folder to be found in here, so this loader points exactly those requests
 * (and only while the curves files are being loaded, and only from files inside this folder) at the sibling folder noble-hashes/.
 *
 * Exports only what the board needs: BIP-340 Schnorr signatures and secp256k1 point arithmetic for the key agreement. Nothing else is loaded.
 */

const Module = require("module");
const path = require("path");

const ROOT = __dirname + path.sep;
const HASHES = path.join(__dirname, "noble-hashes");

function load() {
  const original = Module._resolveFilename;
  Module._resolveFilename = function (request, parent, ...rest) {
    if (typeof request === "string" && request.startsWith("@noble/hashes/") && parent && typeof parent.filename === "string" && parent.filename.startsWith(ROOT)) {
      const name = request.slice("@noble/hashes/".length);
      if (!/^[a-z0-9_]+$/.test(name)) throw new Error("vendor loader: unexpected request " + request);
      request = path.join(HASHES, name);
    }
    return original.call(this, request, parent, ...rest);
  };
  try {
    return require("./noble-curves/secp256k1.js");
  } finally {
    Module._resolveFilename = original;
  }
}

const { secp256k1, schnorr } = load();
module.exports = { secp256k1, schnorr };
