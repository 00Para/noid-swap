"use strict";
/*
 * The hash of the files an autopilot approval is bound to in program mode (spec 5.A.5): the nine tool files (swap-cli, live.js, ...) and the code that
 * decides a spend. `swap-cli` is tens of MB and the approval is looked at every 3 s, so there are two ways to read a file:
 *   - `sha256File(path)`            the views and the 3 s timer: a cache keyed by (path, size, mtimeMs, ctimeMs, ino); a file whose metadata is unchanged is not read again
 *   - `sha256File(path, {fresh:true})`  every byte read again, the cache never asked and then refreshed: `Autopilot.authorize` uses it right before every automatic spend,
 *                                    so a file changed WITHOUT a change of its metadata (a restored mtime) still takes the approval out of force
 * A file that cannot be read gives `null`, never a word like "none": the caller then has no hash and nothing is in force.
 */

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const CHUNK = 1024 * 1024;
// a file up to this size is read whole with readFileSync. In the packaged program the step code sits inside the application archive, where
// Electron reads a file natively with readFileSync but copies it to a temporary file first for openSync; only swap-cli (outside the archive) is larger.
const SMALL_MAX = 8 * 1024 * 1024;

/**
 * sha256 of a file (a synchronous read: the callers are synchronous). Throws on any error. With `size` (from the caller's stat) at most
 * SMALL_MAX the file is read whole; otherwise, or without `size`, in chunks.
 */
function hashFile(file, fsm = fs, size) {
  if (Number.isSafeInteger(size) && size >= 0 && size <= SMALL_MAX) return crypto.createHash("sha256").update(fsm.readFileSync(file)).digest("hex");
  const fd = fsm.openSync(file, "r");
  try {
    const h = crypto.createHash("sha256");
    const buf = Buffer.allocUnsafe(CHUNK);
    for (;;) {
      const n = fsm.readSync(fd, buf, 0, CHUNK, null);
      if (n === 0) break;
      h.update(buf.subarray(0, n));
    }
    return h.digest("hex");
  } finally {
    fsm.closeSync(fd);
  }
}

function createToolHasher({ fs: fsm = fs, maxEntries = 256 } = {}) {
  const cache = new Map(); // path -> { key, sha }
  const stats = { reads: 0, hits: 0 };
  return {
    stats,
    /** @returns {string|null} the lower-case hex sha256, or null when the file cannot be read as a plain file */
    sha256File(file, { fresh = false } = {}) {
      if (typeof file !== "string" || !path.isAbsolute(file)) return null;
      try {
        const st = fsm.statSync(file);
        if (!st.isFile()) return null;
        const key = `${st.size}|${st.mtimeMs}|${st.ctimeMs}|${st.ino}`;
        if (!fresh) {
          const c = cache.get(file);
          if (c && c.key === key) {
            stats.hits++;
            return c.sha;
          }
        }
        const sha = hashFile(file, fsm, st.size);
        stats.reads++;
        if (cache.size >= maxEntries && !cache.has(file)) cache.delete(cache.keys().next().value);
        cache.set(file, { key, sha });
        return sha;
      } catch {
        cache.delete(file);
        return null;
      }
    },
    clear() {
      cache.clear();
    },
  };
}

/**
 * The files the program counts as "step code" (spec 5.A.5): every *.js of ui/app/lib/steps/, plus stepexec.js, exitcodes.js, gate.js, actions.js and autopilot.js.
 * `uiAppDir` is the absolute path of ui/app (in the packaged program: the one inside the application archive's unpacked copy or the archive itself, as the program reads it).
 * The program object's `codeFiles` is made from this (desktop/lib/program.js); a test of this module pins the list.
 */
function codeFilesOf(uiAppDir) {
  const lib = path.join(uiAppDir, "lib");
  const steps = path.join(lib, "steps");
  const out = [];
  for (const name of fs.readdirSync(steps).sort()) if (/\.js$/.test(name)) out.push(path.join(steps, name));
  for (const name of ["stepexec.js", "exitcodes.js", "gate.js", "actions.js", "autopilot.js"]) out.push(path.join(lib, name));
  return out;
}

/** sha256 over the sorted list of [base name, sha256(content)] of the files, or null when one cannot be read (or the list is empty or has a repeated base name). */
function stepCodeHash(files, hasher, { fresh = false } = {}) {
  if (!Array.isArray(files) || !files.length) return null;
  const pairs = [];
  const seen = new Set();
  for (const f of files) {
    const name = path.basename(String(f));
    if (seen.has(name)) return null;
    seen.add(name);
    const sha = hasher.sha256File(f, { fresh });
    if (!sha) return null;
    pairs.push([name, sha]);
  }
  pairs.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  return crypto.createHash("sha256").update(JSON.stringify(pairs)).digest("hex");
}

// the nine inputs of design 12.3, by the name `program.toolFiles()` gives them; the approval item is `<name>_sha256`
const TOOL_KEYS = ["swap_cli", "live_js", "bounded_send_js", "poseidon2b_js", "htlc_json", "htlc_poseidon_v2_json", "lib_rs", "constants_rs", "basis_tables_rs"];

module.exports = { createToolHasher, hashFile, codeFilesOf, stepCodeHash, TOOL_KEYS, SMALL_MAX };
