"use strict";
/*
 * The real key store of build spec I5 (7.8): Electron's safeStorage behind the vault's small port. Call it only after `ready`.
 * Windows: DPAPI; macOS: Keychain. Where the system gives only a plain-text store (Linux "basic_text"), `available()` is false and
 * the vault goes to its passphrase fallback; the program never stores a secret in clear.
 */

function createElectronKeyStore(safeStorage, platform) {
  function available() {
    try {
      if (!safeStorage || typeof safeStorage.isEncryptionAvailable !== "function" || !safeStorage.isEncryptionAvailable()) return false;
      if (platform === "linux") {
        const backend = typeof safeStorage.getSelectedStorageBackend === "function" ? safeStorage.getSelectedStorageBackend() : "unknown";
        if (backend === "basic_text" || backend === "unknown") return false;
      }
      return true;
    } catch {
      return false;
    }
  }
  return {
    kind: platform === "win32" ? "dpapi" : "keychain",
    available,
    seal(plain) {
      if (!Buffer.isBuffer(plain)) throw new TypeError("key store: seal takes a Buffer");
      if (!available()) throw new Error("key store: not available");
      return safeStorage.encryptString(plain.toString("hex"));
    },
    open(sealed) {
      if (!Buffer.isBuffer(sealed)) throw new TypeError("key store: open takes a Buffer");
      if (!available()) throw new Error("key store: not available");
      return Buffer.from(safeStorage.decryptString(sealed), "hex");
    },
  };
}

module.exports = { createElectronKeyStore };
