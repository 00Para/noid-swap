#!/usr/bin/env node
"use strict";
/*
 * codehash-check.js: the contract code that ships is the code swap-cli accepts.
 *
 * swap-cli compiles in two constants (swap-cli/src/params.rs): the keccak256 of the runtime code of eth/contracts/HTLC.sol
 * and of eth/contracts/HTLCPoseidonV2.sol. live.js and swap-cli refuse any contract with another code hash, so a package
 * whose compiled artifacts do not match those constants would be a program that can never lock anything. This script
 * reads the constants from the same commit's params.rs, hashes the `deployedBytecode` of the compiled artifacts and fails
 * on any difference. It also fails unless the poseidon constant is the value written down in docs/poseidon-leg.md, and
 * (with --expect-commit or GITHUB_SHA) unless the swap-cli artifact's BUILD-INFO.txt names the commit being packaged.
 *
 *   node desktop/scripts/codehash-check.js --artifacts DIR --params swap-cli/src/params.rs [--build-info FILE] [--expect-commit SHA]
 *
 * DIR holds contracts/HTLC.sol/HTLC.json and contracts/HTLCPoseidonV2.sol/HTLCPoseidonV2.json (eth/artifacts, or the
 * staged or unpacked copy of it). Offline; Node standard library plus the repository's own keccak.
 */

const fs = require("fs");
const path = require("path");
const { keccak256 } = require("../../ui/app/lib/keccak.js");

const POSEIDON_V2_PIN = "f510d2a368c730339fa7cf5e023bcf2429d5732793f043e03025780bb7043ff3";

const ARTIFACTS = [
  { constant: "HTLC_CODE_HASH", file: path.join("contracts", "HTLC.sol", "HTLC.json"), name: "HTLC" },
  { constant: "HTLC_POSEIDON_V2_CODE_HASH", file: path.join("contracts", "HTLCPoseidonV2.sol", "HTLCPoseidonV2.json"), name: "HTLCPoseidonV2" },
];

/** The 32-byte array constants of params.rs, as lower-case hex. A constant that is missing or not exactly 32 bytes throws. */
function parseParamsRs(text) {
  const out = {};
  for (const { constant } of ARTIFACTS) {
    const m = new RegExp(`pub const ${constant}\\s*:\\s*\\[u8;\\s*32\\]\\s*=\\s*\\[([^\\]]*)\\]\\s*;`).exec(text);
    if (!m) throw new Error(`params.rs: ${constant} not found as a [u8; 32] constant`);
    const bytes = m[1]
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    if (bytes.length !== 32 || !bytes.every((b) => /^0x[0-9a-fA-F]{2}$/.test(b))) {
      throw new Error(`params.rs: ${constant} is not 32 bytes written as 0x..`);
    }
    out[constant] = bytes.map((b) => b.slice(2).toLowerCase()).join("");
  }
  return out;
}

/** keccak256 of the artifact's deployedBytecode, as lower-case hex. Throws when the file or the field is missing or not hex. */
function artifactCodeHash(file) {
  const artifact = JSON.parse(fs.readFileSync(file, "utf8"));
  const code = artifact.deployedBytecode;
  if (typeof code !== "string") throw new Error(`${file}: no deployedBytecode`);
  const hex = code.replace(/^0x/, "");
  if (hex.length === 0 || hex.length % 2 !== 0 || !/^[0-9a-fA-F]+$/.test(hex)) throw new Error(`${file}: deployedBytecode is empty or not hex`);
  return keccak256(Buffer.from(hex, "hex")).toString("hex");
}

/** The commit a swap-cli BUILD-INFO.txt names (the line `commit: <40 hex>`); null when there is none or more than one. */
function buildInfoCommit(text) {
  const found = [...text.matchAll(/^commit: ([0-9a-f]{40})\s*$/gm)].map((m) => m[1]);
  return found.length === 1 ? found[0] : null;
}

/**
 * @param {{artifactsDir:string, paramsRs:string, buildInfo?:string|null, expectCommit?:string|null, poseidonPin?:string}} opts (poseidonPin: a test may name another pin)
 * @returns {{ok:boolean, problems:string[], hashes:Object<string,string>}}
 */
function check({ artifactsDir, paramsRs, buildInfo = null, expectCommit = null, poseidonPin = POSEIDON_V2_PIN }) {
  const problems = [];
  const hashes = {};
  let pinned = null;
  try {
    pinned = parseParamsRs(fs.readFileSync(paramsRs, "utf8"));
  } catch (e) {
    problems.push(e.message);
  }
  if (pinned) {
    if (pinned.HTLC_POSEIDON_V2_CODE_HASH !== poseidonPin) {
      problems.push(`HTLC_POSEIDON_V2_CODE_HASH in params.rs is ${pinned.HTLC_POSEIDON_V2_CODE_HASH}, not the value ${poseidonPin} that docs/poseidon-leg.md records`);
    }
    if (pinned.HTLC_CODE_HASH === pinned.HTLC_POSEIDON_V2_CODE_HASH) problems.push("the two code-hash constants are equal: they must never be interchangeable");
    for (const a of ARTIFACTS) {
      let got = null;
      try {
        got = artifactCodeHash(path.join(artifactsDir, a.file));
      } catch (e) {
        problems.push(e.code === "ENOENT" ? `${a.name}: the compiled artifact ${path.join(artifactsDir, a.file)} is missing` : e.message);
      }
      if (got !== null) {
        hashes[a.constant] = got;
        if (got !== pinned[a.constant]) problems.push(`${a.name}: the compiled code hashes to ${got}, swap-cli's ${a.constant} is ${pinned[a.constant]}`);
      }
    }
  }
  if (buildInfo !== null) {
    if (!expectCommit || !/^[0-9a-f]{40}$/.test(expectCommit)) {
      problems.push("a BUILD-INFO check needs the commit being packaged (40 hex: --expect-commit or GITHUB_SHA)");
    } else {
      let text = null;
      try {
        text = fs.readFileSync(buildInfo, "utf8");
      } catch {
        problems.push(`${buildInfo} cannot be read`);
      }
      if (text !== null) {
        const c = buildInfoCommit(text);
        if (c === null) problems.push(`${buildInfo} does not name exactly one commit`);
        else if (c !== expectCommit) problems.push(`${buildInfo} names commit ${c}, this build is of ${expectCommit}`);
      }
    }
  }
  return { ok: problems.length === 0, problems, hashes };
}

function argValue(argv, flag) {
  const i = argv.indexOf(flag);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : null;
}

function main(argv) {
  const artifactsDir = argValue(argv, "--artifacts");
  const paramsRs = argValue(argv, "--params");
  if (!artifactsDir || !paramsRs) {
    process.stderr.write("usage: codehash-check.js --artifacts DIR --params swap-cli/src/params.rs [--build-info FILE] [--expect-commit SHA]\n");
    return 2;
  }
  const buildInfo = argValue(argv, "--build-info");
  const expectCommit = argValue(argv, "--expect-commit") || process.env.GITHUB_SHA || null;
  const r = check({ artifactsDir, paramsRs, buildInfo, expectCommit });
  for (const [k, v] of Object.entries(r.hashes)) process.stdout.write(`${k}: ${v}\n`);
  if (!r.ok) {
    for (const p of r.problems) process.stderr.write(`error: ${p}\n`);
    return 1;
  }
  process.stdout.write("code hashes match the constants compiled into swap-cli\n");
  return 0;
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));

module.exports = { check, parseParamsRs, artifactCodeHash, buildInfoCommit, POSEIDON_V2_PIN, ARTIFACTS };
