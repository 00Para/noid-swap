"use strict";
// The runtime lock file (step 4.8, build spec 8.3): made offline from eth/package-lock.json, byte for byte reproducible,
// complete (every dependency resolves inside it) and without anything extra.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { makeRuntimeLock, serialize, checkClosure, build, PATHS } = require("../scripts/make-runtime-lock.js");

const ethLock = JSON.parse(fs.readFileSync(PATHS.ethLock, "utf8"));
const runtimePackage = JSON.parse(fs.readFileSync(PATHS.runtimePackage, "utf8"));
const committed = fs.readFileSync(PATHS.runtimeLock, "utf8");

test("the committed lock is exactly what the script makes again from eth/package-lock.json", () => {
  assert.equal(build(), committed);
  assert.equal(serialize(makeRuntimeLock({ ethLock, runtimePackage })), committed);
});

test("the runtime package.json names ethers 6.17.0 and nothing else", () => {
  assert.deepEqual(runtimePackage, { name: "no1d-swap-eth-runtime", private: true, dependencies: { ethers: "6.17.0" } });
});

test("the lock is version 3, has the root entry, and the closure is complete with no extra entry", () => {
  const lock = JSON.parse(committed);
  assert.equal(lock.lockfileVersion, 3);
  assert.deepEqual(lock.packages[""], { name: "no1d-swap-eth-runtime", dependencies: { ethers: "6.17.0" } });
  assert.deepEqual(checkClosure(lock), []);
  assert.equal(lock.packages["node_modules/ethers"].version, "6.17.0");
});

test("every entry keeps the version, the address and the integrity hash eth/ pins, and the dev and peer flags are gone", () => {
  const lock = JSON.parse(committed);
  const keys = Object.keys(lock.packages).filter((k) => k !== "");
  assert.ok(keys.length >= 8, "ethers and its packages");
  for (const k of keys) {
    const src = ethLock.packages[k];
    const got = lock.packages[k];
    assert.ok(src, `${k} exists in eth/package-lock.json`);
    for (const f of ["version", "resolved", "integrity"]) assert.equal(got[f], src[f], `${k} ${f}`);
    for (const f of ["dev", "devOptional", "peer", "optional"]) assert.ok(!(f in got), `${k} has no ${f} flag`);
    assert.match(got.integrity, /^sha512-/);
    assert.ok(got.resolved.startsWith("https://registry.npmjs.org/"));
  }
});

test("no development package of eth/ leaks into the runtime lock", () => {
  const lock = JSON.parse(committed);
  for (const k of Object.keys(lock.packages)) assert.ok(!/hardhat|mocha|nomic|solc|typechain|chai/.test(k), k);
});

test("keys are sorted so the file does not change between runs", () => {
  const keys = Object.keys(JSON.parse(committed).packages);
  assert.equal(keys[0], "", "the root entry comes first");
  const rest = keys.slice(1);
  assert.deepEqual(rest, [...rest].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)));
  assert.equal(committed.endsWith("}\n"), true);
});

// ---- fixture cases of the algorithm ----

const entry = (version, extra = {}) => ({ version, resolved: `https://registry.npmjs.org/x/-/x-${version}.tgz`, integrity: "sha512-AAAA", ...extra });
const fixture = (packages) => ({ lockfileVersion: 3, packages: { "": {}, ...packages } });
const pkg = { name: "r", dependencies: { ethers: "6.17.0" } };

test("fixture: nested resolution, an optional dependency present and an optional peer absent", () => {
  const lock = makeRuntimeLock({
    runtimePackage: pkg,
    ethLock: fixture({
      "node_modules/ethers": entry("6.17.0", { dev: true, peer: true, dependencies: { a: "1.0.0", ws: "8.0.0" }, optionalDependencies: { opt: "1.0.0" } }),
      "node_modules/a": entry("1.0.0", { dev: true }),
      "node_modules/ethers/node_modules/a": entry("1.0.1", { dev: true }),
      "node_modules/ws": entry("8.0.0", { peerDependencies: { bufferutil: "^4" }, peerDependenciesMeta: { bufferutil: { optional: true } } }),
      "node_modules/opt": entry("1.0.0", { optional: true }),
      "node_modules/unrelated": entry("9.9.9", { dev: true }),
    }),
  });
  // ethers needs "a": the nested one wins for it, the top one is not needed by anything and stays out
  assert.deepEqual(Object.keys(lock.packages), ["", "node_modules/ethers", "node_modules/ethers/node_modules/a", "node_modules/opt", "node_modules/ws"]);
  assert.deepEqual(checkClosure(lock), []);
});

test("fixture: a missing dependency, a wrong version and a bad integrity are refused", () => {
  const base = { "node_modules/ethers": entry("6.17.0", { dependencies: { gone: "1.0.0" } }) };
  assert.throws(() => makeRuntimeLock({ runtimePackage: pkg, ethLock: fixture(base) }), /no entry for "gone"/);
  assert.throws(() => makeRuntimeLock({ runtimePackage: pkg, ethLock: fixture({ "node_modules/ethers": entry("6.16.0") }) }), /asks for exactly 6\.17\.0/);
  assert.throws(() => makeRuntimeLock({ runtimePackage: pkg, ethLock: fixture({ "node_modules/ethers": { ...entry("6.17.0"), integrity: "sha1-x" } }) }), /integrity/);
  assert.throws(() => makeRuntimeLock({ runtimePackage: pkg, ethLock: fixture({ "node_modules/ethers": { ...entry("6.17.0"), resolved: "http://evil.example/x.tgz" } }) }), /registry/);
  assert.throws(() => makeRuntimeLock({ runtimePackage: { name: "r", dependencies: { ethers: "6.17.0", other: "1.0.0" } }, ethLock: fixture({}) }), /one and only/);
  assert.throws(() => makeRuntimeLock({ runtimePackage: pkg, ethLock: { lockfileVersion: 2, packages: {} } }), /lockfileVersion 3/);
});

test("checkClosure finds a gap and an extra entry", () => {
  const lock = JSON.parse(committed);
  const gap = structuredClone(lock);
  delete gap.packages["node_modules/aes-js"];
  assert.ok(checkClosure(gap).some((p) => /needs aes-js/.test(p)));
  const extra = structuredClone(lock);
  extra.packages["node_modules/leftover"] = entry("1.0.0");
  assert.ok(checkClosure(extra).some((p) => /leftover.*nothing needs it/.test(p)));
});

test("the script's --check exits 1 when the file differs and 0 when it matches", () => {
  const { spawnSync } = require("child_process");
  const script = path.join(__dirname, "..", "scripts", "make-runtime-lock.js");
  const ok = spawnSync(process.execPath, [script, "--check"], { encoding: "utf8" });
  assert.equal(ok.status, 0, ok.stderr);
});
