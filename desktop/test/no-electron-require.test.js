"use strict";
/* Build spec 2.4 and 7: only desktop/main.js and desktop/preload-secret.js may require("electron"); no test loads either. */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const DESKTOP = path.join(__dirname, "..");
const ALLOWED = new Set(["main.js", "preload-secret.js"]);

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === "node_modules" || e.name === "stage" || e.name === "dist") continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.(js|cjs|mjs)$/.test(e.name)) out.push(p);
  }
  return out;
}

const REQUIRES_ELECTRON = /require\(\s*["'`]electron["'`]\s*\)|from\s+["']electron["']|import\(\s*["']electron["']\s*\)/;

test("only main.js and preload-secret.js require electron", () => {
  const offenders = [];
  for (const f of walk(DESKTOP)) {
    const rel = path.relative(DESKTOP, f).split(path.sep).join("/");
    const code = fs.readFileSync(f, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
    if (REQUIRES_ELECTRON.test(code) && !ALLOWED.has(rel)) offenders.push(rel);
  }
  assert.deepEqual(offenders, []);
});

test("the two allowed files do require it", () => {
  for (const f of ALLOWED) assert.match(fs.readFileSync(path.join(DESKTOP, f), "utf8"), REQUIRES_ELECTRON, f);
});

test("no test file loads main.js or preload-secret.js", () => {
  const loaders = [];
  for (const f of walk(path.join(DESKTOP, "test"))) {
    if (path.basename(f) === "no-electron-require.test.js") continue;
    const code = fs.readFileSync(f, "utf8");
    if (/require\([^)]*(main|preload-secret)(\.js)?["'`]\s*\)/.test(code.replace(/PRELOAD\b/g, ""))) loaders.push(path.basename(f));
  }
  assert.deepEqual(loaders, []);
});

test("package.json pins exact versions and has no runtime dependencies", () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(DESKTOP, "package.json"), "utf8"));
  assert.equal(pkg.name, "no1d-swap");
  assert.equal(pkg.productName, "No1d Swap");
  assert.match(pkg.version, /^\d+\.\d+\.\d+$/,"a plain version number, raised at every build given to users (an update with the same number reads as changed terms)");
  assert.equal(pkg.private, true);
  assert.equal(pkg.main, "main.js");
  assert.equal(pkg.dependencies, undefined);
  assert.equal(pkg.scripts.test, "node --test test/");
  for (const [name, v] of Object.entries(pkg.devDependencies)) assert.match(v, /^\d+\.\d+\.\d+$/, `${name} is pinned exactly`);
  assert.equal(pkg.devDependencies.electron, "45.2.3");
  assert.equal(pkg.devDependencies["electron-builder"], "26.18.0");
});
