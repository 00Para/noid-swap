"use strict";
/*
 * The vault (piece 4, step 4.6; spec 6.1 to 6.6, interface I5): the install secret S, sealed by the system key store behind a small port, and everything
 * derived from it (derive.js): each swap's passphrase, the board's sealing keys, the invite secret's key.
 *
 *   createVault({ dataDir, keyStore, secretUi, fs?, randomBytes?, randomInt?, now? }) -> Vault
 *
 *   keyStore  I5 port { kind: "dpapi"|"keychain"|"fake", available(): boolean, seal(Buffer): Buffer, open(Buffer): Buffer }. One that is not available is
 *             never used: the vault goes to the passphrase fallback (6.6). Nothing is ever stored in clear.
 *   secretUi  I6 port { show, askGroups, askText, askFolder, say }: the only place a recovery code, a restore input, the fallback passphrase or the invite
 *             secret is shown or typed. Positions given to askGroups are 1-based group numbers (1 to 14).
 *
 * Files (I8), all inside <dataDir>/vault/ (mode 0600):
 *   install-secret.v1       S sealed by the key store (binary)            written with the exclusive flag at the first start
 *   install-secret.pw.v1    S sealed under scrypt(passphrase) (JSON)       the fallback when there is no usable key store
 *   key-check.json          {"v":1,"check":"<16 hex>"}                    tells one installation from another (derive.keyCheck)
 *   recovery.json           {"v":1,"confirmed_at":"<ISO time>"|null}      set only after the person typed groups of the code back
 *   board-invite.sealed     the board's invite secret (sealed.js, label "board-invite")
 *
 * S is opened from its file each time it is used and zero-filled right after; it is not kept in a variable of this module (the fallback keeps the scrypt key
 * of the session, not S). The vault has no function that returns S or the recovery code: the code goes to secretUi.show only.
 * Errors are VaultError with fixed texts that carry no secret.
 */

const crypto = require("crypto");
const nodeFs = require("fs");
const path = require("path");
const derive = require("./derive");
const sealed = require("./sealed");
const rc = require("./recoverycode");

const F_SECRET = "install-secret.v1";
const F_SECRET_PW = "install-secret.pw.v1";
const F_CHECK = "key-check.json";
const F_RECOVERY = "recovery.json";
const F_INVITE = "board-invite.sealed";
const F_MIGRATED = "passphrase.sealed";
const F_RUN_CHECK = "vault-check.json";
const SCRYPT = Object.freeze({ N: 131072, r: 8, p: 1 });
const SCRYPT_MAXMEM = 256 * 1024 * 1024;
const MIN_PASSPHRASE = 12;
const PW_AAD = Buffer.from("no1d-swap install-secret.pw v1", "utf8");
const HEX16 = /^[0-9a-f]{16}$/;
const HEX64 = /^[0-9a-f]{64}$/;
const RUN_CHECK_SHAPE = (j) => !!j && j.v === 1 && Object.keys(j).length === 2 && typeof j.check === "string" && HEX16.test(j.check);
const KEY_CHECK_SHAPE = RUN_CHECK_SHAPE;

class VaultError extends Error {}

function scryptKey(passphrase, salt) {
  return new Promise((resolve, reject) => {
    crypto.scrypt(Buffer.from(String(passphrase).normalize("NFC"), "utf8"), salt, 32, { ...SCRYPT, maxmem: SCRYPT_MAXMEM }, (e, k) => (e ? reject(e) : resolve(k)));
  });
}

function sealPw(key, S, salt) {
  const nonce = crypto.randomBytes(12);
  const c = crypto.createCipheriv("aes-256-gcm", key, nonce, { authTagLength: 16 });
  c.setAAD(PW_AAD);
  const ct = Buffer.concat([c.update(S), c.final()]);
  return { v: 1, kdf: "scrypt", N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p, salt: salt.toString("hex"), nonce: nonce.toString("hex"), ct: ct.toString("hex"), tag: c.getAuthTag().toString("hex") };
}

/** The pieces of a fallback file, checked; throws VaultError. The parameters must be exactly ours (no downgrade, no huge cost set by a file). */
function parsePw(text) {
  let o;
  try {
    o = JSON.parse(text);
  } catch {
    throw new VaultError("the passphrase-sealed install secret is not readable");
  }
  const keys = ["v", "kdf", "N", "r", "p", "salt", "nonce", "ct", "tag"];
  if (!o || typeof o !== "object" || Array.isArray(o) || Object.keys(o).length !== keys.length || !keys.every((k) => Object.prototype.hasOwnProperty.call(o, k))) throw new VaultError("the passphrase-sealed install secret is not readable");
  if (o.v !== 1 || o.kdf !== "scrypt" || o.N !== SCRYPT.N || o.r !== SCRYPT.r || o.p !== SCRYPT.p) throw new VaultError("the passphrase-sealed install secret is of a kind this program does not know");
  if (!/^[0-9a-f]{32}$/.test(o.salt) || !/^[0-9a-f]{24}$/.test(o.nonce) || !/^[0-9a-f]{64}$/.test(o.ct) || !/^[0-9a-f]{32}$/.test(o.tag)) throw new VaultError("the passphrase-sealed install secret is not readable");
  return { salt: Buffer.from(o.salt, "hex"), nonce: Buffer.from(o.nonce, "hex"), ct: Buffer.from(o.ct, "hex"), tag: Buffer.from(o.tag, "hex") };
}

function openPw(key, parts) {
  const d = crypto.createDecipheriv("aes-256-gcm", key, parts.nonce, { authTagLength: 16 });
  d.setAAD(PW_AAD);
  d.setAuthTag(parts.tag);
  return Buffer.concat([d.update(parts.ct), d.final()]);
}

function createVault(deps) {
  const { dataDir, keyStore, secretUi } = deps;
  if (typeof dataDir !== "string" || !path.isAbsolute(dataDir)) throw new Error("the vault needs an absolute data folder");
  if (!secretUi) throw new Error("the vault needs a secret window");
  const fs = deps.fs || nodeFs;
  const now = deps.now || Date.now;
  const randomBytes = deps.randomBytes || crypto.randomBytes;
  const randomInt = deps.randomInt || crypto.randomInt;
  const dir = path.join(dataDir, "vault");
  const runsDir = path.join(dataDir, "runs");
  const file = (n) => path.join(dir, n);

  const st = { mode: null, ready: false, why: "the vault is not open yet", confirmed: false, check: null, sessionKey: null, opening: null };

  // ---- small file helpers (every one fails closed with a fixed text)
  const exists = (p) => {
    try {
      fs.lstatSync(p);
      return true;
    } catch (e) {
      if (e && e.code === "ENOENT") return false;
      throw new VaultError("a vault file cannot be examined");
    }
  };
  const readSmall = (p, max = 4096) => {
    let s;
    try {
      s = fs.lstatSync(p);
    } catch {
      return null;
    }
    if (!s.isFile() || s.size > max) throw new VaultError("a vault file is not a plain small file");
    return fs.readFileSync(p);
  };
  const jsonFile = (p, shape) => {
    const b = readSmall(p);
    if (b === null) return null;
    try {
      const o = JSON.parse(b.toString("utf8"));
      return shape(o) ? o : undefined;
    } catch {
      return undefined; // present but not valid
    }
  };
  const writeJson = (p, o) => sealed.writeAtomic(p, Buffer.from(`${JSON.stringify(o)}\n`, "utf8"), fs);

  const ksUsable = () => {
    try {
      return !!keyStore && keyStore.available() === true;
    } catch {
      return false;
    }
  };

  // ---- S, opened per use
  function loadSecret() {
    if (!st.ready) throw new VaultError(st.why || "the vault is not open");
    try {
      if (st.mode === "keystore") {
        const raw = fs.readFileSync(file(F_SECRET));
        const got = keyStore.open(raw);
        const S = Buffer.from(got);
        if (Buffer.isBuffer(got)) got.fill(0);
        if (S.length !== 32) {
          S.fill(0);
          throw new Error("length");
        }
        return S;
      }
      const parts = parsePw(fs.readFileSync(file(F_SECRET_PW), "utf8"));
      const S = openPw(st.sessionKey, parts);
      if (S.length !== 32) {
        S.fill(0);
        throw new Error("length");
      }
      return S;
    } catch {
      throw new VaultError("the install secret could not be opened");
    }
  }
  function withSecret(fn) {
    const S = loadSecret();
    try {
      return fn(S);
    } finally {
      S.fill(0);
    }
  }

  // ---- the secret window, never allowed to break the vault
  async function ask(fnName, arg) {
    try {
      const f = secretUi[fnName];
      if (typeof f !== "function") return null;
      const v = await f.call(secretUi, arg);
      return v === undefined ? null : v;
    } catch {
      return null;
    }
  }
  /** `show` and `say` give no value: true when the window did it. */
  async function tell(fnName, arg) {
    try {
      const f = secretUi[fnName];
      if (typeof f !== "function") return false;
      await f.call(secretUi, arg);
      return true;
    } catch {
      return false;
    }
  }

  function writeRecovery(confirmedAt) {
    writeJson(file(F_RECOVERY), { v: 1, confirmed_at: confirmedAt });
  }
  /** The record, null when there is none, undefined when it is not valid (the caller treats that as "not confirmed" and writes it again). */
  function readRecovery() {
    return jsonFile(file(F_RECOVERY), (j) => j && j.v === 1 && Object.keys(j).length === 2 && (j.confirmed_at === null || (typeof j.confirmed_at === "string" && j.confirmed_at.length <= 40)));
  }

  // ---- an old secret file is never overwritten or deleted by a restore: it is renamed aside (install-secret.v1.<ms>.old), and put back when the new one fails
  function setAside(name) {
    const p = file(name);
    if (!exists(p)) return null;
    const a = `${p}.${now()}.old`;
    try {
      fs.renameSync(p, a);
    } catch {
      throw new VaultError("the old install secret could not be moved aside");
    }
    return { from: a, to: p };
  }
  function putBack(aside, newFile) {
    try {
      fs.unlinkSync(newFile);
    } catch {
      /* not there */
    }
    if (aside) {
      try {
        fs.renameSync(aside.from, aside.to);
      } catch {
        /* the .old file is still there */
      }
    }
  }

  // ---- storing a secret (first start and restore)
  async function askNewPassphrase() {
    for (let tries = 0; tries < 3; tries++) {
      const a = await ask("askText", { kind: "fallback-new" });
      if (a === null || typeof a !== "string") return null;
      if (a.length < MIN_PASSPHRASE) {
        await tell("say", { kind: "wrong-passphrase", reason: "short" });
        continue;
      }
      const b = await ask("askText", { kind: "fallback-new", again: true });
      if (b === null || typeof b !== "string") return null;
      if (a !== b) {
        await tell("say", { kind: "wrong-passphrase", reason: "mismatch" });
        continue;
      }
      return a;
    }
    return null;
  }

  /**
   * Seals S in the current mode and makes the session use it. `exclusive`: the first start (the file must not exist, the exclusive flag); else a restore
   * (replaced through a temporary file and a rename; the other mode's file, now useless, is removed). Throws VaultError.
   */
  async function storeSecret(S, exclusive) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    if (ksUsable()) {
      let blob;
      try {
        blob = Buffer.from(keyStore.seal(Buffer.from(S)));
      } catch {
        throw new VaultError("the key store refused to seal the install secret");
      }
      const aside = exclusive ? null : setAside(F_SECRET);
      try {
        if (exclusive) fs.writeFileSync(file(F_SECRET), blob, { flag: "wx", mode: 0o600 });
        else sealed.writeAtomic(file(F_SECRET), blob, fs);
      } catch (e) {
        // a file that was already there (EEXIST on the exclusive write) is not this call's: it is never deleted
        if (!(exclusive && e && e.code === "EEXIST")) putBack(aside, file(F_SECRET));
        throw new VaultError("the install secret could not be written");
      }
      // read back and open it once (6.2)
      let back = null;
      try {
        back = Buffer.from(keyStore.open(fs.readFileSync(file(F_SECRET))));
        if (back.length !== 32 || !crypto.timingSafeEqual(back, S)) throw new Error("differs");
      } catch {
        putBack(aside, file(F_SECRET));
        throw new VaultError("the install secret did not read back from the key store");
      } finally {
        if (back) back.fill(0);
      }
      if (!exclusive) {
        try {
          setAside(F_SECRET_PW); // the other mode's file is useless now, but it is kept aside, not deleted
        } catch {
          /* it stays where it is: the next start says "two install secrets" */
        }
      }
      st.mode = "keystore";
      st.sessionKey = null;
      return;
    }
    // no usable key store: the passphrase fallback (6.6)
    const pass = await askNewPassphrase();
    if (pass === null) throw new VaultError("no passphrase was chosen: there is no usable key store, so a passphrase is needed");
    const salt = randomBytes(16);
    const key = await scryptKey(pass, salt);
    const body = Buffer.from(`${JSON.stringify(sealPw(key, S, salt))}\n`, "utf8");
    let aside = null;
    try {
      aside = exclusive ? null : setAside(F_SECRET_PW); // a failed move throws here and leaves the old file where it is
    } catch (e) {
      key.fill(0);
      throw e instanceof VaultError ? e : new VaultError("the old install secret could not be moved aside");
    }
    try {
      if (exclusive) fs.writeFileSync(file(F_SECRET_PW), body, { flag: "wx", mode: 0o600 });
      else sealed.writeAtomic(file(F_SECRET_PW), body, fs);
    } catch (e) {
      key.fill(0);
      // a file that was already there (EEXIST on the exclusive write) is not this call's: it is never deleted
      if (!(exclusive && e && e.code === "EEXIST")) putBack(aside, file(F_SECRET_PW));
      throw new VaultError("the install secret could not be written");
    }
    let back = null;
    try {
      back = openPw(key, parsePw(fs.readFileSync(file(F_SECRET_PW), "utf8")));
      if (back.length !== 32 || !crypto.timingSafeEqual(back, S)) throw new Error("differs");
    } catch {
      key.fill(0);
      putBack(aside, file(F_SECRET_PW));
      throw new VaultError("the install secret did not read back");
    } finally {
      if (back) back.fill(0);
    }
    if (!exclusive) {
      try {
        setAside(F_SECRET); // the key-store file is useless now (no usable key store), but it is kept aside, not deleted
      } catch {
        /* it stays where it is */
      }
    }
    if (st.sessionKey) st.sessionKey.fill(0);
    st.mode = "fallback";
    st.sessionKey = key;
  }

  function becomeReady(check) {
    st.ready = true;
    st.why = null;
    st.check = check;
  }

  // ---- the recovery code: show, then type back
  function codeGroups() {
    return withSecret((S) => rc.groupsOf(rc.encodeRaw(S)));
  }
  /** Shows the code and asks for three groups back; true when they matched and recovery.json was written. */
  async function showAndConfirm() {
    const groups = codeGroups();
    if (!(await tell("show", { kind: "recovery-code", groups }))) return false; // the person never saw the code
    let positions = rc.pickPositions(randomInt);
    let wrong = 0;
    for (;;) {
      const typed = await ask("askGroups", { positions });
      if (typed === null) return false;
      const ok = Array.isArray(typed) && typed.length === positions.length && typed.every((t, i) => rc.normaliseGroup(t) === groups[positions[i] - 1]);
      if (ok) {
        writeRecovery(new Date(now()).toISOString());
        st.confirmed = true;
        return true;
      }
      await tell("say", { kind: "wrong-code" });
      wrong++;
      if (wrong >= 3) {
        await tell("show", { kind: "recovery-code", groups });
        positions = rc.pickPositions(randomInt);
        wrong = 0;
      }
    }
  }

  function states() {
    return { state: st.ready ? (st.confirmed ? "ready" : "needs_confirm") : "locked" };
  }

  // ---- open()
  async function doOpen() {
    try {
      return await doOpenInner();
    } catch (e) {
      st.ready = false;
      st.why = e instanceof VaultError ? e.message : "the vault could not be opened";
      return states();
    }
  }
  async function doOpenInner() {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const hasKs = exists(file(F_SECRET));
    const hasPw = exists(file(F_SECRET_PW));
    const lock = (why) => {
      st.ready = false;
      st.why = why;
      return states();
    };
    if (hasKs && hasPw) return lock("the vault holds two install secrets: remove the stale one or restore with the recovery code");
    if (hasKs) {
      if (!ksUsable()) return lock("the key store is not available, and the install secret is sealed by it");
      st.mode = "keystore";
      st.ready = true; // so that loadSecret may run; undone on failure
      let check;
      try {
        check = withSecret((S) => derive.keyCheck(S));
      } catch {
        st.ready = false;
        return lock("the key store cannot open the install secret: restore it with the recovery code");
      }
      try {
        return await afterOpen(check);
      } catch (e) {
        st.ready = false;
        return lock(e instanceof VaultError ? e.message : "the vault could not be read");
      }
    }
    if (hasPw) {
      for (let i = 0; i < 3; i++) {
        const pass = await ask("askText", { kind: "fallback" });
        if (pass === null || typeof pass !== "string") return lock("no passphrase was given");
        let parts;
        try {
          parts = parsePw(fs.readFileSync(file(F_SECRET_PW), "utf8"));
        } catch {
          return lock("the passphrase-sealed install secret is not readable");
        }
        const key = await scryptKey(pass, parts.salt);
        let S = null;
        try {
          S = openPw(key, parts);
        } catch {
          key.fill(0);
          await tell("say", { kind: "wrong-passphrase" });
          continue;
        }
        const check = derive.keyCheck(S);
        S.fill(0);
        st.mode = "fallback";
        st.sessionKey = key;
        st.ready = true;
        try {
          return await afterOpen(check);
        } catch (e) {
          st.ready = false;
          return lock(e instanceof VaultError ? e.message : "the vault could not be read");
        }
      }
      return lock("the passphrase was wrong three times");
    }
    // run folders of an installation whose secret is missing (the vault folder was lost, or the folders were copied in before the first start on a new machine):
    // no new secret is made, because swaps under a new one would make these folders unrestorable. The person restores with the recovery code.
    if (runChecks().size > 0) return lock("this computer has run folders of an installation whose secret is missing: restore with your recovery code");
    // the first start: make S, seal it, write the check and the recovery record, show the code
    const S = Buffer.from(randomBytes(32));
    try {
      await storeSecret(S, true);
      const check = derive.keyCheck(S);
      st.ready = true;
      writeJson(file(F_CHECK), { v: 1, check });
      writeRecovery(null);
      st.check = check;
      st.confirmed = false;
      st.why = null;
    } catch (e) {
      st.ready = false;
      return lock(e instanceof VaultError ? e.message : "the vault could not be made");
    } finally {
      S.fill(0);
    }
    await showAndConfirm();
    return states();
  }

  /** After S opened: the check file and the recovery record are read (or repaired when missing); a check that disagrees locks the vault. */
  async function afterOpen(check) {
    const kc = jsonFile(file(F_CHECK), (j) => j && j.v === 1 && Object.keys(j).length === 2 && typeof j.check === "string" && HEX16.test(j.check));
    if (kc && kc.check !== check) throw new VaultError("the vault's key-check.json is not the one of its install secret: restore with the recovery code");
    if (!kc) writeJson(file(F_CHECK), { v: 1, check }); // missing or damaged: made again from the secret the key store authenticated
    let rec = readRecovery();
    if (!rec) {
      writeRecovery(null); // missing or damaged: not confirmed, to be done again
      rec = { confirmed_at: null };
    }
    becomeReady(check);
    st.confirmed = rec.confirmed_at !== null;
    return states();
  }

  // ---- restore from a recovery code
  function runChecks() {
    const out = new Set();
    // the run folders, the ended ones (runs/.ended/*) and the half-made imports (runs/.importing/*): the key check of every one protects its secret
    for (const base of [runsDir, path.join(runsDir, ".ended"), path.join(runsDir, ".importing")]) {
      let names;
      try {
        names = fs.readdirSync(base);
      } catch {
        continue;
      }
      for (const n of names) {
        try {
          const d = path.join(base, n);
          if (!fs.lstatSync(d).isDirectory()) continue;
          const o = jsonFile(path.join(d, F_RUN_CHECK), RUN_CHECK_SHAPE);
          if (o) out.add(o.check);
        } catch {
          /* an unreadable folder is skipped */
        }
      }
    }
    return out;
  }

  /** The key check written beside the sealed secret, or null when there is none or it is not valid. */
  function diskCheck() {
    try {
      const o = jsonFile(file(F_CHECK), KEY_CHECK_SHAPE);
      return o ? o.check : null;
    } catch {
      return null;
    }
  }
  function secretFileExists() {
    try {
      return exists(file(F_SECRET)) || exists(file(F_SECRET_PW));
    } catch {
      return true; // cannot tell: assume there is one
    }
  }

  async function restore() {
    const text = await ask("askText", { kind: "restore" });
    if (text === null || typeof text !== "string") return { ok: false, why: "cancelled" };
    let S;
    try {
      S = rc.decode(text.replace(/[\r\n\t]+/g, " ")); // a pasted code may carry line ends; the reading rules themselves know only spaces and hyphens
    } catch {
      await tell("say", { kind: "wrong-code" });
      return { ok: false, why: "the code is not right" };
    }
    try {
      const check = derive.keyCheck(S);
      const refs = runChecks();
      // the check of the secret this installation holds now: from memory when it is open, else from vault/key-check.json on disk (a LOCKED vault still has a secret)
      const cur = st.ready ? st.check : diskCheck();
      if (st.ready && cur === check) {
        if (!st.confirmed) {
          writeRecovery(new Date(now()).toISOString()); // the whole code was typed
          st.confirmed = true;
        }
        return { ok: true, why: null }; // the same installation: nothing else to do
      }
      if (cur && cur !== check && refs.has(cur)) {
        await tell("say", { kind: "other-install" });
        return { ok: false, why: "this installation already has swaps under its own secret: it cannot be replaced" };
      }
      if (!cur && secretFileExists() && refs.size > 1) {
        await tell("say", { kind: "other-install" });
        return { ok: false, why: "the vault's key check is missing and run folders of more than one installation are here: it cannot be told which secret is in use" };
      }
      if (refs.size > 0 && !refs.has(check)) {
        await tell("say", { kind: "other-install" });
        return { ok: false, why: "this code is not the one of these run folders" };
      }
      try {
        await storeSecret(S, false);
      } catch (e) {
        return { ok: false, why: e instanceof VaultError ? e.message : "the secret could not be stored" };
      }
      writeJson(file(F_CHECK), { v: 1, check });
      writeRecovery(new Date(now()).toISOString()); // the whole code was typed: it is confirmed
      becomeReady(check);
      st.confirmed = true;
      return { ok: true, why: null };
    } finally {
      S.fill(0);
    }
  }

  // ---- reading a run folder's vault check
  function runCheckOf(runDir) {
    const o = jsonFile(path.join(runDir, F_RUN_CHECK), RUN_CHECK_SHAPE);
    if (o === null) throw new VaultError("this run folder has no vault-check.json: it was not made by this program (import it)");
    if (o === undefined) throw new VaultError("this run folder's vault-check.json is damaged");
    return o.check;
  }

  const vault = {
    async open() {
      if (!st.opening) st.opening = doOpen(); // the work is done once; a later call answers with the state as it is now
      await st.opening;
      return states();
    },
    /** The state now, as open() answers it: "ready", "needs_confirm" or "locked" (it changes after a restore or a confirmation). */
    state() {
      return states();
    },
    ready() {
      return st.ready ? { ok: true, why: null } : { ok: false, why: st.why };
    },
    recoveryConfirmed() {
      return st.ready && st.confirmed;
    },
    newSwapAllowed() {
      if (!st.ready) return { ok: false, why: st.why || "the vault is not open" };
      if (!st.confirmed) return { ok: false, why: "write down your recovery code and type part of it back first" };
      return { ok: true, why: null };
    },
    /** "keystore", "fallback" or null. The fallback cannot restart by itself: the swap page says so. */
    mode() {
      return st.mode;
    },
    keyCheck() {
      if (!st.ready || !st.check) throw new VaultError(st.why || "the vault is not open");
      return st.check;
    },
    passphraseFor(runDir, runId) {
      if (!st.ready) throw new VaultError(st.why || "the vault is not open");
      if (!derive.isRunId(runId)) throw new VaultError("the run id is not valid");
      if (typeof runDir !== "string" || !runDir) throw new VaultError("no run folder");
      if (runCheckOf(runDir) !== st.check) throw new VaultError("this run folder was made by another installation: restore its recovery code");
      const sp = path.join(runDir, F_MIGRATED);
      if (!exists(sp)) return withSecret((S) => derive.passphrase(S, runId));
      return withSecret((S) => {
        const key = derive.migratedKey(S, runId);
        let plain = null;
        try {
          plain = sealed.readSealedFile(sp, { key, label: "migrated-passphrase", runId }, fs);
          return plain.toString("utf8");
        } catch {
          throw new VaultError("passphrase.sealed cannot be opened with this installation's secret");
        } finally {
          key.fill(0);
          if (plain) plain.fill(0);
        }
      });
    },
    /** Seals an old passphrase (a string) into `<runDir>/passphrase.sealed` for the import (migrate.js). Returns nothing. */
    writeMigratedPassphrase(runDir, runId, passphrase) {
      if (!st.ready) throw new VaultError(st.why || "the vault is not open");
      if (!derive.isRunId(runId)) throw new VaultError("the run id is not valid");
      if (typeof passphrase !== "string" || !passphrase) throw new VaultError("no passphrase to seal");
      withSecret((S) => {
        const key = derive.migratedKey(S, runId);
        const plain = Buffer.from(passphrase, "utf8");
        try {
          sealed.writeSealedFile(path.join(runDir, F_MIGRATED), { key, label: "migrated-passphrase", runId, plain }, fs);
        } finally {
          key.fill(0);
          plain.fill(0);
        }
      });
    },
    boardSealer(runId) {
      if (!derive.isRunId(runId)) throw new VaultError("the run id is not valid");
      return {
        seal(plain, fileName) {
          return withSecret((S) => {
            const key = derive.boardKey(S, runId);
            try {
              return Buffer.from(sealed.sealToText({ key, label: "board", runId, fileName, plain }), "utf8");
            } finally {
              key.fill(0);
            }
          });
        },
        open(blob, fileName) {
          return withSecret((S) => {
            const key = derive.boardKey(S, runId);
            try {
              return sealed.open({ key, label: "board", runId, fileName, envelope: blob });
            } finally {
              key.fill(0);
            }
          });
        },
      };
    },
    /**
     * The sealer of the history of payout addresses (label "payout-history", run id "install", key K(S, "payout-history", "install")). Same shape as
     * boardSealer: seal(plain, fileName) gives the file's text as a Buffer, open(blob, fileName) gives the plain Buffer. A locked vault throws VaultError
     * from either call; a file that does not open throws SealedError. The caller (program.js) tells the two apart.
     */
    historySealer() {
      return {
        seal(plain, fileName) {
          return withSecret((S) => {
            const key = derive.historyKey(S);
            try {
              return Buffer.from(sealed.sealToText({ key, label: "payout-history", runId: "install", fileName, plain }), "utf8");
            } finally {
              key.fill(0);
            }
          });
        },
        open(blob, fileName) {
          return withSecret((S) => {
            const key = derive.historyKey(S);
            try {
              return sealed.open({ key, label: "payout-history", runId: "install", fileName, envelope: blob });
            } finally {
              key.fill(0);
            }
          });
        },
      };
    },
    inviteSecret() {
      if (!st.ready) throw new VaultError(st.why || "the vault is not open");
      const p = file(F_INVITE);
      if (!exists(p)) return null;
      return withSecret((S) => {
        const key = derive.inviteKey(S);
        let plain = null;
        try {
          plain = sealed.readSealedFile(p, { key, label: "board-invite", runId: "install" }, fs);
          const t = plain.toString("utf8");
          if (!HEX64.test(t)) throw new Error("shape");
          return t;
        } catch {
          throw new VaultError("the invite secret cannot be opened with this installation's secret");
        } finally {
          key.fill(0);
          if (plain) plain.fill(0);
        }
      });
    },
    async setInviteSecret() {
      if (!st.ready) throw new VaultError(st.why || "the vault is not open");
      const text = await ask("askText", { kind: "invite" });
      if (text === null || typeof text !== "string") return;
      const v = text.trim().toLowerCase();
      if (!HEX64.test(v)) {
        await tell("say", { kind: "wrong-code" });
        return;
      }
      withSecret((S) => {
        const key = derive.inviteKey(S);
        const plain = Buffer.from(v, "utf8");
        try {
          sealed.writeSealedFile(file(F_INVITE), { key, label: "board-invite", runId: "install", plain }, fs);
        } finally {
          key.fill(0);
          plain.fill(0);
        }
      });
    },
    async showRecoveryCode() {
      if (!st.ready) throw new VaultError(st.why || "the vault is not open");
      if (st.confirmed) {
        await tell("show", { kind: "recovery-code", groups: codeGroups() });
        return;
      }
      await showAndConfirm();
    },
    restore,
  };
  return vault;
}

module.exports = { createVault, VaultError, SCRYPT };
