// Reference model of Parano1d's Addr(s) / Derive(m, i): a plain BigInt JavaScript port of the
// zero-dependency Rust spec in equiv/portable/src/ (lib.rs, constants.rs, basis_tables.rs).
//
// It is used in two places:
//   * scripts/poseidon/gen.js converts the spec constants to the flat basis with it and emits
//     contracts/Poseidon2b.sol;
//   * test/Poseidon2b.test.js uses it as the expected-value oracle for the Solidity.
// Everything numeric is PARSED from the Rust files, never typed here. The few spec literals that
// live in lib.rs as code (not in a table) are parsed too and checked against the expected values.
//
// Deliberately slow and simple: shift-and-add multiply, naive 4x4 MDS. No dependencies.
"use strict";
const fs = require("fs");
const path = require("path");

const SPEC_DIR = path.resolve(__dirname, "../../../equiv/portable/src");

function parseU128List(src, name) {
  const start = src.indexOf("pub const " + name + ":");
  if (start < 0) throw new Error(name + " not found in the Rust spec");
  const open = src.indexOf("= [", start) + 3;
  const close = src.indexOf("];", open);
  return src
    .slice(open, close)
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length)
    .map((s) => BigInt(s));
}
function parseMatrix(src, name, rows, cols) {
  const start = src.indexOf("pub const " + name + ":");
  if (start < 0) throw new Error(name + " not found in the Rust spec");
  const open = src.indexOf("= [", start) + 3;
  const close = src.indexOf("\n];", open);
  const out = src
    .slice(open, close)
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.startsWith("["))
    .map((l) =>
      l
        .replace(/^\[/, "")
        .replace(/\],?$/, "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
        .map(BigInt)
    );
  if (out.length !== rows || out.some((r) => r.length !== cols)) throw new Error(name + ": unexpected shape");
  return out;
}

const basisSrc = fs.readFileSync(path.join(SPEC_DIR, "basis_tables.rs"), "utf8");
const constSrc = fs.readFileSync(path.join(SPEC_DIR, "constants.rs"), "utf8");
const libSrc = fs.readFileSync(path.join(SPEC_DIR, "lib.rs"), "utf8");

const TOWER_TO_FLAT = parseU128List(basisSrc, "TOWER_TO_FLAT");
const FLAT_TO_TOWER = parseU128List(basisSrc, "FLAT_TO_TOWER");
const F_ROUNDS = 8;
const P_ROUNDS = 58;
const N_ROUNDS = F_ROUNDS + P_ROUNDS;
const ROUND_CONSTANTS = parseMatrix(constSrc, "ROUND_CONSTANTS", 4, N_ROUNDS);
const MDS_FULL = parseMatrix(constSrc, "MDS_FULL", 4, 4);
const MDS_PARTIAL = parseMatrix(constSrc, "MDS_PARTIAL", 4, 4);
if (TOWER_TO_FLAT.length !== 128 || FLAT_TO_TOWER.length !== 128) throw new Error("basis tables: bad length");

// ---- spec literals that sit in lib.rs as code: parse, then assert the shape we rely on ----------
// `pub const ADDRFIX_LABEL: u64 = u64::from_be_bytes(*b"ADDRFIX_");`
if (!/pub const ADDRFIX_LABEL: u64 = u64::from_be_bytes\(\*b"ADDRFIX_"\);/.test(libSrc)) {
  throw new Error("lib.rs: ADDRFIX_LABEL definition changed; update poseidon2b.js");
}
const ADDRFIX = BigInt("0x" + Buffer.from("ADDRFIX_").toString("hex"));
// `pub const DERIVE_TAG: u128 = 0x6E6F69642D64657269;`  ("noid-deri")
const tagMatch = /pub const DERIVE_TAG: u128 = (0x[0-9A-Fa-f_]+);/.exec(libSrc);
if (!tagMatch) throw new Error("lib.rs: DERIVE_TAG not found");
const DERIVE_TAG = BigInt(tagMatch[1].replace(/_/g, ""));
if (DERIVE_TAG !== BigInt("0x" + Buffer.from("noid-deri").toString("hex"))) throw new Error('DERIVE_TAG is not "noid-deri"');
// pad block of Derive: `st[0] ^= 0x80;` and `st[1] ^= 1u128 << 120;`
if (!/st\[0\] \^= 0x80;/.test(libSrc) || !/st\[1\] \^= 1u128 << 120;/.test(libSrc)) {
  throw new Error("lib.rs: Derive pad block changed; update poseidon2b.js");
}
const PAD0 = 0x80n;
const PAD1 = 1n << 120n;

const M128 = (1n << 128n) - 1n;
const applyMatrix = (m, v) => {
  let r = 0n;
  for (let i = 0; i < 128; i++) if ((v >> BigInt(i)) & 1n) r ^= m[i];
  return r;
};
const towerToFlat = (v) => applyMatrix(TOWER_TO_FLAT, v);
const flatToTower = (v) => applyMatrix(FLAT_TO_TOWER, v);

// GF(2)[x] / (x^128 + x^7 + x^2 + x + 1), shift-and-add (portable gf_mul)
function gfMul(a, b) {
  let r = 0n;
  while (b) {
    if (b & 1n) r ^= a;
    b >>= 1n;
    const carry = a >> 127n;
    a = (a << 1n) & M128;
    if (carry) a ^= 0x87n;
  }
  return r;
}
const gfSqr = (a) => gfMul(a, a);
const sbox = (x) => {
  const x2 = gfSqr(x);
  const x4 = gfSqr(x2);
  return gfMul(gfMul(x, x2), x4);
};

const RC_FLAT = ROUND_CONSTANTS.map((row) => row.map(towerToFlat));
const MDS_FULL_FLAT = MDS_FULL.map((row) => row.map(towerToFlat));
const MDS_PARTIAL_FLAT = MDS_PARTIAL.map((row) => row.map(towerToFlat));

function applyMds(s, m) {
  const inp = s.slice();
  for (let i = 0; i < 4; i++) {
    let out = 0n;
    for (let j = 0; j < 4; j++) out ^= m[i][j] === 1n ? inp[j] : gfMul(inp[j], m[i][j]);
    s[i] = out;
  }
}
function permuteFlat(s) {
  applyMds(s, MDS_FULL_FLAT);
  for (let r = 0; r < N_ROUNDS; r++) {
    if (r < F_ROUNDS / 2 || r >= F_ROUNDS / 2 + P_ROUNDS) {
      for (let i = 0; i < 4; i++) s[i] = sbox(s[i] ^ RC_FLAT[i][r]);
      applyMds(s, MDS_FULL_FLAT);
    } else {
      s[0] = sbox(s[0] ^ RC_FLAT[0][r]);
      applyMds(s, MDS_PARTIAL_FLAT);
    }
  }
}
/** Permutation on a tower-basis state (array of 4 BigInt); returns a new array. */
function permuteTower(st) {
  const f = st.map(towerToFlat);
  permuteFlat(f);
  return f.map(flatToTower);
}
const le128 = (buf) => {
  let v = 0n;
  for (let i = 15; i >= 0; i--) v = (v << 8n) | BigInt(buf[i]);
  return v;
};
const unle128 = (v) => {
  const b = Buffer.alloc(16);
  for (let i = 0; i < 16; i++) b[i] = Number((v >> BigInt(8 * i)) & 0xffn);
  return b;
};

/** Addr(s) for a 32-byte Buffer. */
function addr(s) {
  const st = permuteTower([le128(s.subarray(0, 16)), le128(s.subarray(16, 32)), ADDRFIX << 64n, ADDRFIX]);
  return Buffer.concat([unle128(st[0]), unle128(st[1])]);
}
/** Derive(m, index) for a 32-byte Buffer and a u32 index. */
function derive(m, index) {
  let st = permuteTower([le128(m.subarray(0, 16)), le128(m.subarray(16, 32)), 0n, 0n]);
  st[0] ^= BigInt(index);
  st[1] ^= DERIVE_TAG;
  st = permuteTower(st);
  st[0] ^= PAD0;
  st[1] ^= PAD1;
  st = permuteTower(st);
  return Buffer.concat([unle128(st[0]), unle128(st[1])]);
}

module.exports = {
  SPEC_DIR,
  TOWER_TO_FLAT,
  FLAT_TO_TOWER,
  ROUND_CONSTANTS,
  MDS_FULL,
  MDS_PARTIAL,
  RC_FLAT,
  MDS_FULL_FLAT,
  MDS_PARTIAL_FLAT,
  M128,
  ADDRFIX,
  DERIVE_TAG,
  PAD0,
  PAD1,
  towerToFlat,
  flatToTower,
  gfMul,
  gfSqr,
  sbox,
  permuteFlat,
  permuteTower,
  addr,
  derive,
  le128,
  unle128,
};

if (require.main === module) {
  const s = Buffer.from([...Array(32).keys()]);
  console.log("Addr(s)      =", addr(s).toString("hex"));
  console.log("Derive(s,0)  =", derive(s, 0).toString("hex"));
  console.log("Addr(Der0)   =", addr(derive(s, 0)).toString("hex"));
}
