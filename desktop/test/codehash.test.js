"use strict";
// The contract code-hash check (step 4.8, build spec 8.3): swap-cli's compiled-in constants against the compiled artifacts.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { check, parseParamsRs, artifactCodeHash, buildInfoCommit, POSEIDON_V2_PIN } = require("../scripts/codehash-check.js");
const { keccak256 } = require("../../ui/app/lib/keccak.js");

const REPO = path.join(__dirname, "..", "..");
const REAL_PARAMS = path.join(REPO, "swap-cli", "src", "params.rs");

function tmp() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "no1d-codehash-"));
  return { dir, done: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

const rustBytes = (hex) => hex.match(/../g).map((b) => `0x${b}`).join(", ");
const paramsText = (a, b) =>
  `/// doc\npub const HTLC_CODE_HASH: [u8; 32] = [\n    ${rustBytes(a)},\n];\n\n/// doc\npub const HTLC_POSEIDON_V2_CODE_HASH: [u8; 32] = [\n    ${rustBytes(b)},\n];\n`;
const hashHex = (bytes) => keccak256(Buffer.from(bytes)).toString("hex");

function writeArtifacts(dir, a, b) {
  for (const [rel, code] of [["contracts/HTLC.sol/HTLC.json", a], ["contracts/HTLCPoseidonV2.sol/HTLCPoseidonV2.json", b]]) {
    const file = path.join(dir, ...rel.split("/"));
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ abi: [], bytecode: "0x00", deployedBytecode: "0x" + Buffer.from(code).toString("hex") }));
  }
}

const CODE_A = [0x60, 0x80, 0x60, 0x40, 0x52];
const CODE_B = [0x60, 0x80, 0x60, 0x40, 0x52, 0x34, 0x80];

test("parseParamsRs reads both constants from the real params.rs, and the poseidon one is the recorded value", () => {
  const c = parseParamsRs(fs.readFileSync(REAL_PARAMS, "utf8"));
  assert.match(c.HTLC_CODE_HASH, /^[0-9a-f]{64}$/);
  assert.equal(c.HTLC_POSEIDON_V2_CODE_HASH, POSEIDON_V2_PIN);
  assert.equal(POSEIDON_V2_PIN, "f510d2a368c730339fa7cf5e023bcf2429d5732793f043e03025780bb7043ff3");
  assert.notEqual(c.HTLC_CODE_HASH, c.HTLC_POSEIDON_V2_CODE_HASH);
});

test("parseParamsRs refuses a constant that is missing, short or not hex", () => {
  const good = paramsText(hashHex(CODE_A), hashHex(CODE_B));
  assert.throws(() => parseParamsRs(good.replace("HTLC_POSEIDON_V2_CODE_HASH", "OTHER")), /HTLC_POSEIDON_V2_CODE_HASH not found/);
  assert.throws(() => parseParamsRs(good.replace("0x", "0y")), /not 32 bytes/);
  assert.throws(() => parseParamsRs(good.replace(/, 0x[0-9a-f]{2},\n\];\n\n\/\/\/ doc\npub const HTLC_POSEIDON/, ",\n];\n\n/// doc\npub const HTLC_POSEIDON")), /not 32 bytes/);
});

test("a matching artifact passes (a made-up pin stands in for the recorded poseidon value)", () => {
  const t = tmp();
  try {
    const a = hashHex(CODE_A);
    const b = hashHex(CODE_B);
    fs.writeFileSync(path.join(t.dir, "params.rs"), paramsText(a, b));
    writeArtifacts(path.join(t.dir, "art"), CODE_A, CODE_B);
    const r = check({ artifactsDir: path.join(t.dir, "art"), paramsRs: path.join(t.dir, "params.rs"), poseidonPin: b });
    assert.deepEqual(r.problems, []);
    assert.equal(r.ok, true);
    assert.equal(r.hashes.HTLC_CODE_HASH, a);
  } finally {
    t.done();
  }
});

test("a stale artifact (other code than the constant) fails and names the contract", () => {
  const t = tmp();
  try {
    const a = hashHex(CODE_A);
    const b = hashHex(CODE_B);
    fs.writeFileSync(path.join(t.dir, "params.rs"), paramsText(a, b));
    writeArtifacts(path.join(t.dir, "art"), [...CODE_A, 0x00], CODE_B);
    const r = check({ artifactsDir: path.join(t.dir, "art"), paramsRs: path.join(t.dir, "params.rs"), poseidonPin: b });
    assert.equal(r.ok, false);
    assert.equal(r.problems.length, 1);
    assert.match(r.problems[0], /^HTLC: the compiled code hashes to/);
  } finally {
    t.done();
  }
});

test("the poseidon constant must be the recorded value; two equal constants fail; a missing artifact fails", () => {
  const t = tmp();
  try {
    const a = hashHex(CODE_A);
    const b = hashHex(CODE_B);
    fs.writeFileSync(path.join(t.dir, "params.rs"), paramsText(a, b));
    writeArtifacts(path.join(t.dir, "art"), CODE_A, CODE_B);
    // the default pin is the real recorded value, which this fixture's constant is not
    const wrongPin = check({ artifactsDir: path.join(t.dir, "art"), paramsRs: path.join(t.dir, "params.rs") });
    assert.ok(wrongPin.problems.some((p) => p.includes(POSEIDON_V2_PIN)));
    fs.writeFileSync(path.join(t.dir, "same.rs"), paramsText(a, a));
    const same = check({ artifactsDir: path.join(t.dir, "art"), paramsRs: path.join(t.dir, "same.rs"), poseidonPin: a });
    assert.ok(same.problems.some((p) => /never be interchangeable/.test(p)));
    const missing = check({ artifactsDir: path.join(t.dir, "nothing"), paramsRs: path.join(t.dir, "params.rs"), poseidonPin: b });
    assert.equal(missing.problems.filter((p) => /is missing/.test(p)).length, 2);
  } finally {
    t.done();
  }
});

test("artifactCodeHash refuses an artifact without a hex deployedBytecode", () => {
  const t = tmp();
  try {
    const f = path.join(t.dir, "a.json");
    for (const body of [{}, { deployedBytecode: "0x" }, { deployedBytecode: "0xzz" }, { deployedBytecode: "0xabc" }]) {
      fs.writeFileSync(f, JSON.stringify(body));
      assert.throws(() => artifactCodeHash(f), /deployedBytecode/);
    }
  } finally {
    t.done();
  }
});

test("BUILD-INFO: the commit it names must be the commit being packaged", () => {
  const t = tmp();
  try {
    const sha = "a".repeat(40);
    const other = "b".repeat(40);
    const a = hashHex(CODE_A);
    const b = hashHex(CODE_B);
    fs.writeFileSync(path.join(t.dir, "params.rs"), paramsText(a, b));
    writeArtifacts(path.join(t.dir, "art"), CODE_A, CODE_B);
    const info = path.join(t.dir, "BUILD-INFO.txt");
    const run = (expectCommit) => check({ artifactsDir: path.join(t.dir, "art"), paramsRs: path.join(t.dir, "params.rs"), buildInfo: info, expectCommit, poseidonPin: b });
    fs.writeFileSync(info, `platform: windows-x86_64\ncommit: ${sha}\nrun: 1 attempt 1\n`);
    assert.equal(run(sha).ok, true);
    assert.match(run(other).problems[0], /names commit a+, this build is of b+/);
    assert.match(run(null).problems[0], /needs the commit being packaged/);
    assert.match(run("not-a-sha").problems[0], /needs the commit being packaged/);
    fs.writeFileSync(info, "platform: x\n");
    assert.match(run(sha).problems[0], /does not name exactly one commit/);
    fs.writeFileSync(info, `commit: ${sha}\ncommit: ${other}\n`);
    assert.match(run(sha).problems[0], /does not name exactly one commit/);
    assert.equal(buildInfoCommit(`chain source commit: ${sha}\n`), null, "only the line that starts with commit: counts");
  } finally {
    t.done();
  }
});

test("the real compiled contracts match the real constants (skipped when eth/ has not been compiled here)", (ctx) => {
  const art = path.join(REPO, "eth", "artifacts");
  if (!fs.existsSync(path.join(art, "contracts", "HTLC.sol", "HTLC.json")) || !fs.existsSync(path.join(art, "contracts", "HTLCPoseidonV2.sol", "HTLCPoseidonV2.json"))) {
    ctx.skip("eth/artifacts is not compiled on this machine");
    return;
  }
  const r = check({ artifactsDir: art, paramsRs: REAL_PARAMS });
  assert.deepEqual(r.problems, []);
});
