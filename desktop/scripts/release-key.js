#!/usr/bin/env node
"use strict";
/*
 * release-key.js: the owner's offline release signing tool (docs/release-key.md). Node built-ins only.
 *
 *   node desktop/scripts/release-key.js keygen --out DIR
 *   node desktop/scripts/release-key.js sign   --key FILE --in release.json      (writes release.json.sig)
 *   node desktop/scripts/release-key.js verify --pub BASE64 --in FILE --sig FILE
 *
 * The private key lives in one file, encrypted with a passphrase (scrypt, then AES-256-GCM). The passphrase is typed at the
 * terminal without echo: it is never an argument, never an environment variable, never printed. The private key is never
 * printed and is never written inside the repository. Run keygen and sign on an offline machine you control.
 */

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { parseReleaseJson, verifyDetached, SPKI_PREFIX, PKCS8_PREFIX } = require("../lib/releasefile");
const { PUBLIC_KEY_B64 } = require("../lib/releasekey");

const FORMAT = "no1d-release-key-v1";
const KDF = { N: 1 << 17, r: 8, p: 1, maxmem: 512 * 1024 * 1024 };
const MIN_PASSPHRASE = 12;

class UsageError extends Error {}

function repoRoot() {
  let dir = path.resolve(__dirname);
  for (;;) {
    if (fs.existsSync(path.join(dir, ".git"))) return dir;
    const up = path.dirname(dir);
    if (up === dir) return null;
    dir = up;
  }
}

/** realpath of the deepest existing ancestor, then the rest appended (the target need not exist yet). */
function realish(p) {
  let cur = path.resolve(p);
  const rest = [];
  for (;;) {
    try {
      return path.join(fs.realpathSync(cur), ...rest.reverse());
    } catch {
      const up = path.dirname(cur);
      if (up === cur) return path.resolve(p);
      rest.push(path.basename(cur));
      cur = up;
    }
  }
}

function insideRepo(target, root = repoRoot()) {
  if (!root) return false;
  const rel = path.relative(realish(root), realish(target));
  return rel === "" || (rel !== ".." && !rel.startsWith(".." + path.sep) && !path.isAbsolute(rel));
}

/** True when the folder, or any folder above it, holds a .git entry (a repository, a worktree or a submodule). */
function hasGitAncestor(target) {
  let dir = realish(target);
  for (;;) {
    if (fs.existsSync(path.join(dir, ".git"))) return true;
    const up = path.dirname(dir);
    if (up === dir) return false;
    dir = up;
  }
}

function args(argv, allowed) {
  const out = {};
  for (let i = 0; i < argv.length; i += 2) {
    const k = argv[i];
    if (!k || !k.startsWith("--") || !allowed.includes(k.slice(2))) throw new UsageError(`unknown or misplaced option: ${k}`);
    if (argv[i + 1] === undefined) throw new UsageError(`${k} needs a value`);
    out[k.slice(2)] = argv[i + 1];
  }
  for (const k of allowed) if (!(k in out)) throw new UsageError(`missing --${k}`);
  return out;
}

/** The version in desktop/package.json (the release being signed must be this one); null when it cannot be read. */
function packageVersion() {
  try {
    const v = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "package.json"), "utf8")).version;
    return typeof v === "string" ? v : null;
  } catch {
    return null;
  }
}

/** The lines of a sha256sum file as { name -> hash } (the two usual spellings: "HASH  NAME" and "HASH *NAME"); a name listed twice keeps every hash. */
function sumsOf(text) {
  const m = new Map();
  for (const line of String(text).split(/\r?\n/)) {
    const r = /^([0-9a-fA-F]{64}) [ *](.+)$/.exec(line.trim());
    if (r) m.set(r[2], [...(m.get(r[2]) || []), r[1].toLowerCase()]);
  }
  return m;
}

/** The passphrase from the terminal, no echo. Refuses when stdin is not a terminal. */
function readPassphraseTty(prompt) {
  return new Promise((resolve, reject) => {
    const stdin = process.stdin;
    if (!stdin.isTTY || typeof stdin.setRawMode !== "function") {
      reject(new UsageError("the passphrase is read from a terminal only: run this in your own terminal window"));
      return;
    }
    process.stderr.write(prompt);
    let buf = "";
    const done = (fn, v) => {
      stdin.setRawMode(false);
      stdin.pause();
      stdin.removeListener("data", onData);
      process.stderr.write("\n");
      fn(v);
    };
    const onData = (chunk) => {
      for (const ch of chunk.toString("utf8")) {
        if (ch === "\r" || ch === "\n") return done(resolve, buf);
        if (ch === "\u0003") return done(reject, new UsageError("cancelled"));
        if (ch === "\u007f" || ch === "\b") buf = [...buf].slice(0, -1).join("");
        else if (ch >= " ") buf += ch;
      }
    };
    stdin.setRawMode(true);
    stdin.resume();
    stdin.on("data", onData);
  });
}

function encryptSeed(seed, pubRaw, passphrase) {
  const salt = crypto.randomBytes(16);
  const iv = crypto.randomBytes(12);
  const key = crypto.scryptSync(passphrase, salt, 32, KDF);
  const c = crypto.createCipheriv("aes-256-gcm", key, iv, { authTagLength: 16 });
  c.setAAD(pubRaw);
  const ct = Buffer.concat([c.update(seed), c.final()]);
  return {
    format: FORMAT,
    public_key: pubRaw.toString("base64"),
    kdf: { name: "scrypt", N: KDF.N, r: KDF.r, p: KDF.p, salt: salt.toString("base64") },
    cipher: { name: "aes-256-gcm", iv: iv.toString("base64"), tag: c.getAuthTag().toString("base64"), ciphertext: ct.toString("base64") },
  };
}

function decryptKeyFile(text, passphrase) {
  try {
    const f = JSON.parse(text);
    if (f.format !== FORMAT || f.kdf.name !== "scrypt" || f.cipher.name !== "aes-256-gcm") throw new Error("shape");
    const pubRaw = Buffer.from(f.public_key, "base64");
    // the work factors come from this program, never from the file: a file cannot ask for a cheaper or a huge derivation
    if (f.kdf.N !== KDF.N || f.kdf.r !== KDF.r || f.kdf.p !== KDF.p || pubRaw.length !== 32) throw new Error("params");
    const key = crypto.scryptSync(passphrase, Buffer.from(f.kdf.salt, "base64"), 32, KDF);
    const tag = Buffer.from(f.cipher.tag, "base64");
    const iv = Buffer.from(f.cipher.iv, "base64");
    if (tag.length !== 16 || iv.length !== 12) throw new Error("tag");
    const d = crypto.createDecipheriv("aes-256-gcm", key, iv, { authTagLength: 16 });
    d.setAAD(pubRaw);
    d.setAuthTag(tag);
    const seed = Buffer.concat([d.update(Buffer.from(f.cipher.ciphertext, "base64")), d.final()]);
    if (seed.length !== 32) throw new Error("len");
    const priv = crypto.createPrivateKey({ key: Buffer.concat([PKCS8_PREFIX, seed]), format: "der", type: "pkcs8" });
    const derived = crypto.createPublicKey(priv).export({ format: "der", type: "spki" }).subarray(SPKI_PREFIX.length);
    if (!derived.equals(pubRaw)) throw new Error("mismatch");
    return { priv, pubB64: f.public_key };
  } catch {
    throw new UsageError("the key file could not be opened: wrong passphrase or not a release key file");
  }
}

/**
 * main(argv, io) -> exit code. io: { readPassphrase(prompt) -> Promise<string>, out(line), err(line) }; the CLI passes the
 * terminal; tests pass a hook. Nothing here reads a passphrase from anywhere else.
 */
async function main(argv, io) {
  const { out, err } = io;
  try {
    const [cmd, ...rest] = argv;
    if (cmd === "keygen") {
      const { out: dir } = args(rest, ["out"]);
      if (insideRepo(dir) || hasGitAncestor(dir)) throw new UsageError("refused: the key must not be written inside a repository (this one, or any folder under a .git)");
      const file = path.join(path.resolve(dir), "release-key.enc.json");
      if (fs.existsSync(file)) throw new UsageError("refused: a key file already exists there");
      const p1 = await io.readPassphrase("New passphrase (at least 12 characters): ");
      if ([...p1].length < MIN_PASSPHRASE) throw new UsageError(`the passphrase is shorter than ${MIN_PASSPHRASE} characters`);
      const p2 = await io.readPassphrase("Again: ");
      if (p1 !== p2) throw new UsageError("the two passphrases differ");
      const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
      const pkcs8 = privateKey.export({ format: "der", type: "pkcs8" });
      const spki = publicKey.export({ format: "der", type: "spki" });
      if (pkcs8.length !== PKCS8_PREFIX.length + 32 || !pkcs8.subarray(0, PKCS8_PREFIX.length).equals(PKCS8_PREFIX) || spki.length !== SPKI_PREFIX.length + 32 || !spki.subarray(0, SPKI_PREFIX.length).equals(SPKI_PREFIX)) {
        throw new UsageError("this runtime exports Ed25519 keys in an unexpected layout: nothing was written");
      }
      const seed = pkcs8.subarray(PKCS8_PREFIX.length);
      const pubRaw = spki.subarray(SPKI_PREFIX.length);
      const enc = encryptSeed(seed, pubRaw, p1);
      // before anything is written: the file must open with the passphrase and sign something the public key verifies
      const back = decryptKeyFile(JSON.stringify(enc), p1);
      const probe = Buffer.from("release-key round trip");
      if (back.pubB64 !== pubRaw.toString("base64") || !verifyDetached(back.pubB64, probe, crypto.sign(null, probe, back.priv).toString("base64"))) {
        throw new UsageError("the new key file failed its own round trip: nothing was written");
      }
      fs.mkdirSync(path.resolve(dir), { recursive: true, mode: 0o700 });
      fs.writeFileSync(file, JSON.stringify(enc, null, 2) + "\n", { flag: "wx", mode: 0o600 });
      out(`key file written: ${file}`);
      out("Back it up (two copies, offline) and remember the passphrase. Public key, for desktop/lib/releasekey.js:");
      out(pubRaw.toString("base64"));
      return 0;
    }
    if (cmd === "sign") {
      const a = args(rest, ["key", "in"]);
      const bytes = fs.readFileSync(a.in);
      const notice = parseReleaseJson(bytes);
      // L5: the notice must be for the version this tree builds, and the key file must be the key this tree believes: a release signed with another key or another version would make every
      // installed copy say that its signature does not check. io.desktopVersion / io.compiledKey are for tests (null skips the version check, "" the key check).
      const want = io.desktopVersion === undefined ? packageVersion() : io.desktopVersion;
      if (want && notice.version !== want) throw new UsageError(`refused: release.json says version ${notice.version} but desktop/package.json says ${want}: sign the notice of the version this tree builds`);
      const compiled = io.compiledKey === undefined ? PUBLIC_KEY_B64 : io.compiledKey;
      if (compiled) {
        let filePub = null;
        try {
          filePub = JSON.parse(fs.readFileSync(a.key, "utf8")).public_key;
        } catch {
          filePub = null;
        }
        if (filePub !== compiled) throw new UsageError("refused: the public key of this key file is not the one compiled into desktop/lib/releasekey.js: a release signed with it would be refused by every installed copy. Use the key whose public key is in that file, or change the file in a reviewed commit first");
      }
      out(`file:   ${path.resolve(a.in)}`);
      out(`sha256: ${crypto.createHash("sha256").update(bytes).digest("hex")}`);
      // the parsed fields, not the raw text: what is shown is what the program will read
      out(`product: ${notice.product}`);
      out(`version: ${notice.version}`);
      out(`oldest_safe_version: ${notice.oldest_safe_version}`);
      out(`note: ${JSON.stringify(notice.note)}`);
      for (const [name, hash] of Object.entries(notice.sha256)) out(`sha256 ${hash}  ${name}`);
      // the installers' own list, when it sits beside the notice: a hash in the notice that is not in it is a warning (a typed or stale hash would make the notice disagree with the file)
      try {
        const sums = sumsOf(fs.readFileSync(path.join(path.dirname(path.resolve(a.in)), "SHA256SUMS.txt"), "utf8"));
        for (const [name, hash] of Object.entries(notice.sha256)) {
          const have = sums.get(name);
          if (!have || !have.includes(hash)) err(`WARNING: ${name} with this hash is not listed in SHA256SUMS.txt beside the notice`);
        }
      } catch {
        /* no SHA256SUMS.txt beside the notice: nothing to compare */
      }
      out(`This signs version ${notice.version}, oldest safe version ${notice.oldest_safe_version}.`);
      const pass = await io.readPassphrase("Passphrase to sign this file: ");
      const { priv, pubB64 } = decryptKeyFile(fs.readFileSync(a.key, "utf8"), pass);
      const sig = crypto.sign(null, bytes, priv).toString("base64");
      if (!verifyDetached(pubB64, bytes, sig)) throw new UsageError("internal check failed: the new signature does not verify");
      fs.writeFileSync(`${a.in}.sig`, sig + "\n", "utf8");
      out(`signature written: ${a.in}.sig`);
      out(`public key: ${pubB64}`);
      return 0;
    }
    if (cmd === "verify") {
      const a = args(rest, ["pub", "in", "sig"]);
      const bytes = fs.readFileSync(a.in);
      const ok = verifyDetached(a.pub, bytes, fs.readFileSync(a.sig, "utf8"));
      if (!ok) {
        err("BAD: the signature does not match this file and this public key");
        return 1;
      }
      out("OK: the signature is valid for this file and this public key");
      return 0;
    }
    throw new UsageError("usage: keygen --out DIR | sign --key FILE --in release.json | verify --pub B64 --in FILE --sig FILE");
  } catch (e) {
    err(e instanceof UsageError || (e && e.name === "ReleaseFileError") ? `error: ${e.message}` : `error: ${e && e.code ? e.code : "failed"}`);
    return 2;
  }
}

module.exports = { main, sumsOf, insideRepo, hasGitAncestor, decryptKeyFile, repoRoot };

if (require.main === module) {
  main(process.argv.slice(2), { readPassphrase: readPassphraseTty, out: (l) => console.log(l), err: (l) => console.error(l) }).then((c) => process.exit(c));
}
