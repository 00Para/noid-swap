"use strict";
/*
 * Runtime manifest (build spec 7.11). It lists the sha256 of every file under `app.asar.unpacked/` and `bin/` of the program's
 * resources folder. The manifest itself is kept inside app.asar, so the archive's own integrity check covers it. On an unsigned
 * build this is a damage check, not a defence against a program running as the same user.
 *
 *   build(root, {version, commit}) -> manifest text   (keys sorted, "/" paths relative to root, trailing newline)
 *   write(root, {version, commit, outFile?})          writes it (default: <root>/runtime-manifest.json) and returns the text
 *   verify(root, text) -> {ok, why}                   every listed file exists and has its hash, and no file is missing from the list
 */

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const FOLDERS = ["app.asar.unpacked", "bin"];
const HEX64 = /^[0-9a-f]{64}$/;
const HEX40 = /^[0-9a-f]{40}$/;

function hashFile(file) {
  const h = crypto.createHash("sha256");
  const fd = fs.openSync(file, "r");
  try {
    const buf = Buffer.allocUnsafe(1 << 20);
    for (;;) {
      const n = fs.readSync(fd, buf, 0, buf.length, null);
      if (n === 0) break;
      h.update(buf.subarray(0, n));
    }
  } finally {
    fs.closeSync(fd);
  }
  return h.digest("hex");
}

/** Every plain file under the two folders, as { "app.asar.unpacked/x/y": "<sha256>" }. A link or a special file is an error. */
function collect(root) {
  const files = {};
  const problems = [];
  function walk(abs, rel) {
    let entries;
    try {
      entries = fs.readdirSync(abs, { withFileTypes: true });
    } catch {
      problems.push(`cannot read ${rel}`);
      return;
    }
    for (const e of entries) {
      const r = `${rel}/${e.name}`;
      const a = path.join(abs, e.name);
      if (e.isSymbolicLink()) problems.push(`${r} is a link`);
      else if (e.isDirectory()) walk(a, r);
      else if (e.isFile()) files[r] = hashFile(a);
      else problems.push(`${r} is not a plain file`);
    }
  }
  for (const f of FOLDERS) {
    const abs = path.join(root, f);
    if (fs.existsSync(abs)) walk(abs, f);
  }
  return { files, problems };
}

function sortedObject(o) {
  const out = {};
  for (const k of Object.keys(o).sort()) out[k] = o[k];
  return out;
}

function build(root, { version, commit }) {
  if (typeof version !== "string" || !version) throw new Error("manifest: version is required");
  if (typeof commit !== "string" || !HEX40.test(commit)) throw new Error("manifest: commit must be 40 lower-case hex characters");
  const { files, problems } = collect(root);
  if (problems.length) throw new Error(`manifest: ${problems[0]}`);
  return JSON.stringify({ v: 1, program_version: version, commit, files: sortedObject(files) }, null, 2) + "\n";
}

function write(root, { version, commit, outFile }) {
  const text = build(root, { version, commit });
  fs.writeFileSync(outFile || path.join(root, "runtime-manifest.json"), text);
  return text;
}

function pathProblem(p) {
  if (typeof p !== "string" || !p) return "an empty path";
  if (p.includes("\\") || p.startsWith("/") || p.split("/").some((s) => s === ".." || s === "." || s === "")) return "a path that is not relative";
  if (!FOLDERS.some((f) => p.startsWith(`${f}/`))) return "a path outside the two folders";
  return null;
}

function verify(root, text) {
  let m;
  try {
    m = JSON.parse(text);
  } catch {
    return { ok: false, why: "the manifest is not readable" };
  }
  if (!m || typeof m !== "object" || m.v !== 1 || typeof m.program_version !== "string" || typeof m.commit !== "string" || !HEX40.test(m.commit) || !m.files || typeof m.files !== "object" || Array.isArray(m.files)) {
    return { ok: false, why: "the manifest has the wrong shape" };
  }
  for (const [p, h] of Object.entries(m.files)) {
    const bad = pathProblem(p);
    if (bad) return { ok: false, why: `the manifest lists ${bad}` };
    if (typeof h !== "string" || !HEX64.test(h)) return { ok: false, why: "the manifest holds a bad hash" };
  }
  const { files, problems } = collect(root);
  if (problems.length) return { ok: false, why: problems[0] };
  for (const [p, h] of Object.entries(m.files)) {
    if (!(p in files)) return { ok: false, why: `a file is missing: ${p}` };
    if (files[p] !== h) return { ok: false, why: `a file changed: ${p}` };
  }
  for (const p of Object.keys(files)) {
    if (!(p in m.files)) return { ok: false, why: `a file is not in the manifest: ${p}` };
  }
  return { ok: true, why: null };
}

module.exports = { build, write, verify, collect, FOLDERS };
