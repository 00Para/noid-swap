#!/usr/bin/env node
"use strict";
/*
 * make-runtime-lock.js: build desktop/runtime/package-lock.json OFFLINE from eth/package-lock.json.
 *
 * Why: the program ships `ethers` (live.js needs it) but in the repository it only arrives through a development
 * package (hardhat-toolbox), so it is flagged `dev` and `peer` in eth/package-lock.json. Changing eth/package.json
 * would need a lock regeneration with the network. Instead desktop/runtime/package.json names `ethers` as a direct
 * dependency, and this script cuts the closure of `ethers` out of the existing lock: the same versions, the same
 * `resolved` addresses and the same `integrity` hashes that eth/ already pins, with the `dev` and `peer` flags
 * dropped, written as lockfile version 3. The hosted build then runs `npm ci --omit=dev --ignore-scripts` on it.
 *
 *   node desktop/scripts/make-runtime-lock.js            write desktop/runtime/package-lock.json
 *   node desktop/scripts/make-runtime-lock.js --check    exit 1 unless the file on disk is exactly what would be written
 *
 * No network, no package manager. Node standard library only.
 */

const fs = require("fs");
const path = require("path");

const DROPPED_FLAGS = ["dev", "devOptional", "peer", "optional"];

/** The packages key of the package that `name` resolves to when required from the package at `from` ("" = the root). */
function resolveInLock(packages, from, name) {
  let base = from;
  for (;;) {
    const key = (base ? base + "/" : "") + "node_modules/" + name;
    if (Object.prototype.hasOwnProperty.call(packages, key)) return key;
    if (!base) return null;
    const i = base.lastIndexOf("/node_modules/");
    base = i < 0 ? "" : base.slice(0, i);
  }
}

const byCodeUnit = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * @param {{ethLock: object, runtimePackage: object}} input
 * @returns {object} the lock, ready for JSON.stringify
 */
function makeRuntimeLock({ ethLock, runtimePackage }) {
  if (!ethLock || ethLock.lockfileVersion !== 3 || typeof ethLock.packages !== "object") {
    throw new Error("eth/package-lock.json: lockfileVersion 3 with a packages table is required");
  }
  if (!runtimePackage || typeof runtimePackage.name !== "string" || typeof runtimePackage.dependencies !== "object") {
    throw new Error("runtime package.json: a name and a dependencies table are required");
  }
  const rootDeps = runtimePackage.dependencies;
  if (JSON.stringify(Object.keys(rootDeps)) !== JSON.stringify(["ethers"])) {
    throw new Error("runtime package.json: ethers must be the one and only dependency");
  }
  const packages = ethLock.packages;
  const picked = new Set();

  const walk = (key) => {
    if (picked.has(key)) return;
    picked.add(key);
    const entry = packages[key];
    const need = (name, optional) => {
      const dep = resolveInLock(packages, key, name);
      if (dep === null) {
        if (optional) return;
        throw new Error(`the lock has no entry for "${name}" required by ${key}`);
      }
      walk(dep);
    };
    for (const name of Object.keys(entry.dependencies || {})) need(name, false);
    for (const name of Object.keys(entry.optionalDependencies || {})) need(name, true);
    const meta = entry.peerDependenciesMeta || {};
    for (const name of Object.keys(entry.peerDependencies || {})) need(name, !!(meta[name] && meta[name].optional));
  };

  for (const [name, spec] of Object.entries(rootDeps)) {
    const key = resolveInLock(packages, "", name);
    if (key === null) throw new Error(`eth/package-lock.json has no entry for ${name}`);
    if (/^\d+\.\d+\.\d+$/.test(spec) && packages[key].version !== spec) {
      throw new Error(`${name} is ${packages[key].version} in eth/package-lock.json, the runtime package.json asks for exactly ${spec}`);
    }
    walk(key);
  }

  const out = {};
  for (const key of [...picked].sort(byCodeUnit)) {
    const src = packages[key];
    if (typeof src.version !== "string" || typeof src.resolved !== "string" || typeof src.integrity !== "string") {
      throw new Error(`${key}: version, resolved and integrity are all required in the source lock`);
    }
    if (!/^sha512-[A-Za-z0-9+/]+={0,2}$/.test(src.integrity)) throw new Error(`${key}: the integrity is not a sha512 value`);
    if (!src.resolved.startsWith("https://registry.npmjs.org/")) throw new Error(`${key}: resolved is not an https address of the npm registry`);
    const copy = {};
    for (const [field, value] of Object.entries(src)) if (!DROPPED_FLAGS.includes(field)) copy[field] = value;
    out[key] = copy;
  }

  const root = { name: runtimePackage.name, dependencies: { ...rootDeps } };
  if (typeof runtimePackage.version === "string") root.version = runtimePackage.version;
  const head = { name: runtimePackage.name };
  if (typeof runtimePackage.version === "string") head.version = runtimePackage.version;
  return { ...head, lockfileVersion: 3, requires: true, packages: { "": root, ...out } };
}

const serialize = (lock) => JSON.stringify(lock, null, 2) + "\n";

/** Every dependency of every entry resolves inside the lock, and every entry is reachable from the root: no gap, no extra. */
function checkClosure(lock) {
  const problems = [];
  const packages = lock.packages;
  const reach = new Set();
  const walk = (key) => {
    if (reach.has(key)) return;
    reach.add(key);
    const e = packages[key];
    const meta = e.peerDependenciesMeta || {};
    const names = [
      ...Object.keys(e.dependencies || {}).map((n) => [n, false]),
      ...Object.keys(e.optionalDependencies || {}).map((n) => [n, true]),
      ...Object.keys(e.peerDependencies || {}).map((n) => [n, !!(meta[n] && meta[n].optional)]),
    ];
    for (const [name, optional] of names) {
      const dep = resolveInLock(packages, key, name);
      if (dep === null) {
        if (!optional) problems.push(`${key || "(root)"} needs ${name}, which is not in the lock`);
      } else walk(dep);
    }
  };
  walk("");
  for (const key of Object.keys(packages)) if (!reach.has(key)) problems.push(`${key} is in the lock and nothing needs it`);
  return problems;
}

const PATHS = {
  ethLock: path.join(__dirname, "..", "..", "eth", "package-lock.json"),
  runtimePackage: path.join(__dirname, "..", "runtime", "package.json"),
  runtimeLock: path.join(__dirname, "..", "runtime", "package-lock.json"),
};

function build(paths = PATHS) {
  const ethLock = JSON.parse(fs.readFileSync(paths.ethLock, "utf8"));
  const runtimePackage = JSON.parse(fs.readFileSync(paths.runtimePackage, "utf8"));
  return serialize(makeRuntimeLock({ ethLock, runtimePackage }));
}

function main(argv) {
  const check = argv.includes("--check");
  const text = build();
  if (check) {
    let have = null;
    try {
      have = fs.readFileSync(PATHS.runtimeLock, "utf8");
    } catch {
      /* missing */
    }
    if (have !== text) {
      process.stderr.write("desktop/runtime/package-lock.json is not what eth/package-lock.json gives: run node desktop/scripts/make-runtime-lock.js and commit the result\n");
      return 1;
    }
    process.stdout.write("desktop/runtime/package-lock.json matches eth/package-lock.json\n");
    return 0;
  }
  fs.writeFileSync(PATHS.runtimeLock, text);
  process.stdout.write(`wrote ${path.relative(process.cwd(), PATHS.runtimeLock)}\n`);
  return 0;
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));

module.exports = { makeRuntimeLock, serialize, checkClosure, resolveInLock, build, PATHS };
