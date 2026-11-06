// Generates eth/contracts/Poseidon2b.sol from the portable Rust spec in equiv/portable/src/
// (constants.rs, basis_tables.rs and the literals in lib.rs), via the reference model
// ./poseidon2b.js. Nothing numeric in the contract is typed by hand.
//
//   node scripts/poseidon/gen.js             write contracts/Poseidon2b.sol
//   node scripts/poseidon/gen.js --check     regenerate in memory and fail unless it is byte-identical
//                                            to the committed contract (also run by the Hardhat test
//                                            and by "npm run poseidon:check")
//   node scripts/poseidon/gen.js --out FILE  write somewhere else (to diff it yourself)
//   node scripts/poseidon/gen.js --explain   print how every derived constant is computed
//
// The output is a pure function of the three Rust files and of this script: no environment
// switches, no timestamps, no absolute paths.
"use strict";
const fs = require("fs");
const path = require("path");
const P = require("./poseidon2b.js");
const DEFAULT_OUT = path.resolve(__dirname, "../../contracts/Poseidon2b.sol");

const hex = (v, w = 32) => "0x" + v.toString(16).padStart(w, "0");
const M128 = (1n << 128n) - 1n;

// masks for the 5-way split (bits p with p % 5 == m), over 256 bits
const MASK5 = [0, 1, 2, 3, 4].map((m) => {
  let v = 0n;
  for (let p = m; p < 256; p += 5) v |= 1n << BigInt(p);
  return v;
});
// spread masks (128 -> 256 bits): w ones, w zeros, ... from bit 0
const spreadMask = (w) => {
  let v = 0n;
  for (let p = 0; p < 256; p++) if (((p / w) | 0) % 2 === 0) v |= 1n << BigInt(p);
  return v;
};
const SPREAD = [64, 32, 16, 8, 4, 2, 1].map(spreadMask);
// byte-swap masks over 128 bits
const altMask = (w, high) => {
  let v = 0n;
  for (let p = 0; p < 128; p++) if ((((p / w) | 0) % 2 === 1) === high) v |= 1n << BigInt(p);
  return v;
};

// ---- constants COMPUTED here (not copied from a Rust table) --------------------------------------
//   t1, t2          flat(2), flat(4): the tower constants 2 and 4 behind MDS_FULL
//   E[i]            flat(d_i) ^ 1: MDS_PARTIAL = diag(d) + all-ones, so out_i = (d_i + 1) in_i + sum
//   ivHi, ivLo      flat(ADDRFIX << 64), flat(ADDRFIX): capacity IV lanes 2 and 3
//   deriveTagFlat   flat("noid-deri"); pad0Flat = flat(0x80); pad1Flat = flat(1 << 120)
//   MASK5, SPREAD, altMask   bit masks for the multiply, the squaring and the byte swap
// The factored MDS in the template below is only valid for exactly these matrix shapes, so the
// shapes are asserted against the parsed spec instead of being assumed.
const eqMat = (a, b) => a.every((row, i) => row.every((v, j) => v === BigInt(b[i][j])));
if (!eqMat(P.MDS_FULL, [[5, 7, 1, 3], [4, 6, 1, 1], [1, 3, 5, 7], [1, 1, 4, 6]])) throw new Error("MDS_FULL is not the matrix the factored layer assumes");
for (let i = 0; i < 4; i++)
  for (let j = 0; j < 4; j++)
    if (i !== j && P.MDS_PARTIAL[i][j] !== 1n) throw new Error("MDS_PARTIAL is not diag + ones");
const t1 = P.towerToFlat(2n);
const t2 = P.towerToFlat(4n);
const E = [0, 1, 2, 3].map((i) => P.towerToFlat(P.MDS_PARTIAL[i][i]) ^ 1n);
for (let i = 0; i < 4; i++) if ((P.MDS_PARTIAL_FLAT[i][i] ^ 1n) !== E[i]) throw new Error("partial diag mismatch");
const ivHi = P.towerToFlat(P.ADDRFIX << 64n);
const ivLo = P.towerToFlat(P.ADDRFIX);
const deriveTagFlat = P.towerToFlat(P.DERIVE_TAG);
const pad0Flat = P.towerToFlat(P.PAD0);
const pad1Flat = P.towerToFlat(P.PAD1);
const ADDRFIX_LABEL_HEX = "0x" + P.ADDRFIX.toString(16).toUpperCase();

function convFn(name, table, doc) {
  const lines = [`            function ${name}(v) -> r {`, `                // ${doc}`];
  for (let i = 0; i < 128; i++) {
    const bit = i === 0 ? "and(v, 1)" : `and(shr(${i}, v), 1)`;
    lines.push(
      i === 0
        ? `                r := mul(${bit}, ${hex(table[i])})`
        : `                r := xor(r, mul(${bit}, ${hex(table[i])}))`
    );
  }
  lines.push("            }");
  return lines.join("\n");
}

function rounds() {
  const L = [];
  L.push("            a, b, c, d := mdsFull(a, b, c, d) // initial linear layer");
  const names = ["a", "b", "c", "d"];
  for (let r = 0; r < 66; r++) {
    const full = r < 4 || r >= 62;
    if (full) {
      L.push(`            // full round ${r}`);
      for (let i = 0; i < 4; i++) L.push(`            ${names[i]} := sbox(xor(${names[i]}, ${hex(P.RC_FLAT[i][r])}))`);
      L.push("            a, b, c, d := mdsFull(a, b, c, d)");
    } else {
      L.push(`            // partial round ${r}`);
      L.push(`            a := sbox(xor(a, ${hex(P.RC_FLAT[0][r])}))`);
      L.push("            a, b, c, d := mdsPartial(a, b, c, d)");
    }
  }
  return L.join("\n");
}

function yulField() {
  const m = MASK5.map((v) => hex(v, 64));
  const reduceBody = (src) => `                let h := shr(128, ${src})
                r := xor(and(${src}, ${hex(M128)}), xor(xor(h, shl(1, h)), xor(shl(2, h), shl(7, h))))
                h := shr(128, r)
                r := xor(and(r, ${hex(M128)}), xor(xor(h, shl(1, h)), xor(shl(2, h), shl(7, h))))`;
  const residue = (mm) => {
    const parts = [];
    for (let i = 0; i < 5; i++) parts.push(`mul(a${i}, b${(mm - i + 5) % 5})`);
    const [p0, p1, p2, p3, p4] = parts;
    return `xor(xor(${p0}, ${p1}), xor(xor(${p2}, ${p3}), ${p4}))`;
  };
  return `            // carry-less multiply of two 128-bit polynomials via masked integer MULs, then reduce
            function gmul(ga, gb) -> r {
                let a0 := and(ga, ${m[0]})
                let a1 := and(ga, ${m[1]})
                let a2 := and(ga, ${m[2]})
                let a3 := and(ga, ${m[3]})
                let a4 := and(ga, ${m[4]})
                let b0 := and(gb, ${m[0]})
                let b1 := and(gb, ${m[1]})
                let b2 := and(gb, ${m[2]})
                let b3 := and(gb, ${m[3]})
                let b4 := and(gb, ${m[4]})
                r := and(${residue(0)}, ${m[0]})
                r := or(r, and(${residue(1)}, ${m[1]}))
                r := or(r, and(${residue(2)}, ${m[2]}))
                r := or(r, and(${residue(3)}, ${m[3]}))
                r := or(r, and(${residue(4)}, ${m[4]}))
                // reduce mod x^128 + x^7 + x^2 + x + 1 (deg r <= 254): two folds of the high half
${reduceBody("r")}
            }
            // squaring: spread bit i to bit 2i (128 -> 256 bits), then reduce
            function gsqr(ga) -> r {
                let x := ga
                x := and(or(x, shl(64, x)), ${hex(SPREAD[0], 64)})
                x := and(or(x, shl(32, x)), ${hex(SPREAD[1], 64)})
                x := and(or(x, shl(16, x)), ${hex(SPREAD[2], 64)})
                x := and(or(x, shl(8, x)), ${hex(SPREAD[3], 64)})
                x := and(or(x, shl(4, x)), ${hex(SPREAD[4], 64)})
                x := and(or(x, shl(2, x)), ${hex(SPREAD[5], 64)})
                x := and(or(x, shl(1, x)), ${hex(SPREAD[6], 64)})
${reduceBody("x")}
            }`;
}

function render() {
  return `// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * @title Poseidon2b
 * @notice Parano1d's address function Addr(s) on the EVM: one Poseidon2b permutation over
 *         GF(2^128) (t = 4, x^7 S-box, 8 full + 58 partial rounds) with the ADDRFIX_ IV,
 *         output lanes 0 and 1.
 *
 * THIS FILE IS GENERATED by eth/scripts/poseidon/gen.js from the zero-dependency Rust
 * spec in equiv/portable/src/{lib.rs,constants.rs,basis_tables.rs}: the round constants,
 * MDS factors, IV, tag, pad and basis tables below were converted mechanically, not typed.
 * Do not edit by hand: regenerate with "npm run poseidon:gen" (in eth/); the test suite and
 * "npm run poseidon:check" fail unless a fresh generation is byte-identical to this file.
 *
 * The permutation runs in the flat (GCM polynomial) basis exactly like the
 * Rust: the input lanes are converted tower -> flat, all 66 rounds run flat, the two
 * output lanes are converted flat -> tower.
 *
 * Field: GF(2)[x] / (x^128 + x^7 + x^2 + x + 1), bit i = coefficient of x^i.
 *   gmul   carry-less multiply done with masked integer MULs: each operand is split into
 *          five parts by bit position mod 5; an integer product of two parts holds, at the
 *          positions of one residue class, column sums of at most 26 terms, which fit in
 *          the 4 bits between two positions of the class, so bit p of the product is the
 *          GF(2) product bit. 5 x 5 = 25 MULs, five masks, then one reduction.
 *   gsqr   squaring is GF(2)-linear: spread bit i to 2i, then reduce.
 *   sbox   x^7 = (x * x^2) * x^4, as in the Rust.
 * Linear layers (constants in tower basis -> flat): MDS_FULL = [[5,7,1,3],[4,6,1,1],
 *   [1,3,5,7],[1,1,4,6]] is evaluated with 4 multiplications using 5 = 1+4, 7 = 1+2+4,
 *   3 = 1+2, 6 = 2+4 and distributivity (T1 = flat(2), T2 = flat(4)); MDS_PARTIAL =
 *   diag(0x20,0x2000,0x200,0x800) + ones, so out_i = (d_i + 1) * in_i + sum(in).
 *
 * Byte order (docs/parano1d-capabilities.md section 10): s_lo = u128 LE of s[0..16],
 * s_hi = u128 LE of s[16..32]; the address is lane0 LE || lane1 LE. In a bytes32 the
 * first byte is the most significant one, hence the byte swaps.
 *
 * Security note: with this lock the EVM leg's security is Addr's preimage resistance
 * (Poseidon2b with unusually small round constants, open question Q8 in the design).
 */
library Poseidon2b {
    /// @dev "ADDRFIX_" as a big-endian u64, as in the vendor domain tag.
    uint64 internal constant ADDRFIX_LABEL = ${ADDRFIX_LABEL_HEX};
    /// @dev capacity IV [L << 64, L] already converted to the flat basis:
    ///      IV_HI_FLAT = TOWER_TO_FLAT(ADDRFIX_LABEL << 64), IV_LO_FLAT = TOWER_TO_FLAT(ADDRFIX_LABEL).
    uint256 internal constant IV_HI_FLAT = ${hex(ivHi)};
    uint256 internal constant IV_LO_FLAT = ${hex(ivLo)};

    /// @notice Addr(s) for a raw 32-byte secret (the RAW swap variant).
    function addr(bytes32 s) internal pure returns (bytes32 a) {
        (uint256 lo, uint256 hi) = _limbs(uint256(s));
        (uint256 l0, uint256 l1, , ) = _permute(_towerToFlat(lo), _towerToFlat(hi), IV_HI_FLAT, IV_LO_FLAT);
        a = bytes32(_unlimbs(_flatToTower(l0), _flatToTower(l1)));
    }

    /// @notice Derive(m, index): spend secret \`index\` of the stock-wallet master secret \`m\`
    ///         (3 permutations: absorb m; absorb index || "noid-deri"; absorb the pad block).
    function derive(bytes32 m, uint32 index) internal pure returns (bytes32 d) {
        (uint256 l0, uint256 l1) = _deriveFlat(uint256(m), index);
        d = bytes32(_unlimbs(_flatToTower(l0), _flatToTower(l1)));
    }

    /// @notice Addr(Derive(m, 0)): the STOCK variant authority, 4 permutations, no
    ///         intermediate basis conversion.
    function addrStock(bytes32 m) internal pure returns (bytes32 a) {
        (uint256 l0, uint256 l1) = _deriveFlat(uint256(m), 0);
        (l0, l1, , ) = _permute(l0, l1, IV_HI_FLAT, IV_LO_FLAT);
        a = bytes32(_unlimbs(_flatToTower(l0), _flatToTower(l1)));
    }

    /// @notice The bare permutation on a tower-basis state (vendor permute_mut), for tests.
    function permute(uint256[4] memory st) internal pure returns (uint256[4] memory out) {
        (uint256 a, uint256 b, uint256 c, uint256 d) =
            _permute(_towerToFlat(st[0]), _towerToFlat(st[1]), _towerToFlat(st[2]), _towerToFlat(st[3]));
        out[0] = _flatToTower(a);
        out[1] = _flatToTower(b);
        out[2] = _flatToTower(c);
        out[3] = _flatToTower(d);
    }

    // ------------------------------------------------------------------ sponge helpers

    /// @dev Flat-basis lanes 0 and 1 after the third permutation of Derive(m, index).
    function _deriveFlat(uint256 m, uint32 index) private pure returns (uint256 l0, uint256 l1) {
        (uint256 lo, uint256 hi) = _limbs(m);
        uint256 l2;
        uint256 l3;
        (l0, l1, l2, l3) = _permute(_towerToFlat(lo), _towerToFlat(hi), 0, 0);
        // absorb index (lane 0) and "noid-deri" (lane 1); XOR commutes with the linear basis map
        (l0, l1, l2, l3) = _permute(l0 ^ _towerToFlat(uint256(index)), l1 ^ ${hex(deriveTagFlat)}, l2, l3);
        // pad block: byte 0 = 0x80 (lane 0, bit 7), byte 31 = 0x01 (lane 1, bit 120)
        (l0, l1, , ) = _permute(l0 ^ ${hex(pad0Flat)}, l1 ^ ${hex(pad1Flat)}, l2, l3);
    }

    /// @dev (u128 LE of bytes 0..16, u128 LE of bytes 16..32) of a bytes32 word.
    function _limbs(uint256 w) private pure returns (uint256 lo, uint256 hi) {
        lo = _bswap128(w >> 128);
        hi = _bswap128(w & ${hex(M128)});
    }

    /// @dev Inverse of _limbs.
    function _unlimbs(uint256 lo, uint256 hi) private pure returns (uint256 w) {
        w = (_bswap128(lo) << 128) | _bswap128(hi);
    }

    /// @dev Reverse the 16 bytes of a value < 2^128.
    function _bswap128(uint256 v) private pure returns (uint256 r) {
        assembly {
            v := or(shr(8, and(v, ${hex(altMask(8, true))})), shl(8, and(v, ${hex(altMask(8, false))})))
            v := or(shr(16, and(v, ${hex(altMask(16, true))})), shl(16, and(v, ${hex(altMask(16, false))})))
            v := or(shr(32, and(v, ${hex(altMask(32, true))})), shl(32, and(v, ${hex(altMask(32, false))})))
            r := or(shr(64, v), and(shl(64, v), ${hex(M128)}))
        }
    }

    // ------------------------------------------------------------------ basis change

    /// @dev Tower -> flat: XOR of TOWER_TO_FLAT[i] over the set bits i of v (vendor apply_matrix).
    function _towerToFlat(uint256 inp) internal pure returns (uint256 out) {
        assembly {
${convFn("t2f", P.TOWER_TO_FLAT, "equiv/portable/src/basis_tables.rs TOWER_TO_FLAT")}
            out := t2f(inp)
        }
    }

    /// @dev Flat -> tower.
    function _flatToTower(uint256 inp) internal pure returns (uint256 out) {
        assembly {
${convFn("f2t", P.FLAT_TO_TOWER, "equiv/portable/src/basis_tables.rs FLAT_TO_TOWER")}
            out := f2t(inp)
        }
    }

    // ------------------------------------------------------------------ field arithmetic (tests)

    /// @dev GF(2^128) multiplication in the flat basis (exposed for the test harness).
    function gmulFlat(uint256 px, uint256 py) internal pure returns (uint256 out) {
        assembly {
${yulField()}
            out := gmul(px, py)
        }
    }

    /// @dev GF(2^128) squaring in the flat basis (exposed for the test harness).
    function gsqrFlat(uint256 px) internal pure returns (uint256 out) {
        assembly {
${yulField()}
            out := gsqr(px)
        }
    }

    // ------------------------------------------------------------------ the permutation

    /// @dev Poseidon2b on a flat-basis state (vendor permute_flat_u128 / portable permute_flat).
    function _permute(uint256 s0, uint256 s1, uint256 s2, uint256 s3)
        internal
        pure
        returns (uint256, uint256, uint256, uint256)
    {
        assembly {
${yulField()}
            function sbox(x) -> r {
                let x2 := gsqr(x)
                r := gmul(gmul(x, x2), gsqr(x2))
            }
            // MDS_FULL with T1 = flat(2), T2 = flat(4), s = a+b+c+d:
            //   out0 = s + T2(a+b) + T1(b+d)     out1 = T2(a+b) + T1 b + c + d
            //   out2 = s + T1(b+d) + T2(c+d)     out3 = a + b + T2(c+d) + T1 d
            function mdsFull(ia, ib, ic, id) -> na, nb, nc, nd {
                let u := gmul(xor(ia, ib), ${hex(t2)})
                let v := gmul(xor(ic, id), ${hex(t2)})
                let p := gmul(ib, ${hex(t1)})
                let q := gmul(id, ${hex(t1)})
                let s := xor(xor(ia, ib), xor(ic, id))
                na := xor(xor(s, u), xor(p, q))
                nb := xor(xor(u, p), xor(ic, id))
                nc := xor(xor(s, p), xor(q, v))
                nd := xor(xor(ia, ib), xor(v, q))
            }
            // MDS_PARTIAL = diag(0x20, 0x2000, 0x200, 0x800) + ones: out_i = (d_i + 1) in_i + s
            function mdsPartial(ia, ib, ic, id) -> na, nb, nc, nd {
                let s := xor(xor(ia, ib), xor(ic, id))
                na := xor(s, gmul(ia, ${hex(E[0])}))
                nb := xor(s, gmul(ib, ${hex(E[1])}))
                nc := xor(s, gmul(ic, ${hex(E[2])}))
                nd := xor(s, gmul(id, ${hex(E[3])}))
            }
            let a := s0
            let b := s1
            let c := s2
            let d := s3
${rounds()}
            s0 := a
            s1 := b
            s2 := c
            s3 := d
        }
        return (s0, s1, s2, s3);
    }
}
`;
}

function explain() {
  const row = (name, how, v) => console.log(`${name.padEnd(16)} ${hex(v)}  = ${how}`);
  row("t1", "TOWER_TO_FLAT applied to tower constant 2", t1);
  row("t2", "TOWER_TO_FLAT applied to tower constant 4", t2);
  ["0x20", "0x2000", "0x200", "0x800"].forEach((d, i) => row(`E[${i}]`, `TOWER_TO_FLAT(MDS_PARTIAL[${i}][${i}] = ${d}) ^ 1`, E[i]));
  row("IV_HI_FLAT", 'TOWER_TO_FLAT("ADDRFIX_" << 64)', ivHi);
  row("IV_LO_FLAT", 'TOWER_TO_FLAT("ADDRFIX_")', ivLo);
  row("deriveTagFlat", 'TOWER_TO_FLAT("noid-deri" = lib.rs DERIVE_TAG)', deriveTagFlat);
  row("pad0Flat", "TOWER_TO_FLAT(0x80)  (Derive pad byte 0)", pad0Flat);
  row("pad1Flat", "TOWER_TO_FLAT(1 << 120)  (Derive pad byte 31)", pad1Flat);
  console.log("ADDRFIX_LABEL    " + ADDRFIX_LABEL_HEX + '  = u64 big-endian of the ASCII bytes "ADDRFIX_"');
  console.log("round constants  66 x 4 tower values of constants.rs ROUND_CONSTANTS, each through TOWER_TO_FLAT");
  console.log("                 (rounds 0-3 and 62-65 on 4 lanes, rounds 4-61 on lane 0 only)");
  console.log("basis tables     TOWER_TO_FLAT / FLAT_TO_TOWER of basis_tables.rs, copied row by row");
  console.log("masks            MASK5[0] = " + hex(MASK5[0], 64));
}

module.exports = { render, explain };

if (require.main === module) {
  const args = process.argv.slice(2);
  const outIdx = args.indexOf("--out");
  if (args.includes("--explain")) {
    explain();
  } else if (args.includes("--check")) {
    const fresh = Buffer.from(render(), "utf8");
    const committed = fs.readFileSync(DEFAULT_OUT);
    if (!fresh.equals(committed)) {
      console.error("FAIL: " + DEFAULT_OUT + " differs from a fresh generation (" + committed.length + " vs " + fresh.length + " bytes).");
      console.error("Run: npm run poseidon:gen   (or: node scripts/poseidon/gen.js --out FILE and diff)");
      process.exit(1);
    }
    console.log("OK: contracts/Poseidon2b.sol is byte-identical to a fresh generation (" + fresh.length + " bytes).");
  } else {
    const out = outIdx >= 0 ? path.resolve(args[outIdx + 1]) : DEFAULT_OUT;
    fs.writeFileSync(out, render());
    console.log("wrote " + out);
  }
}
