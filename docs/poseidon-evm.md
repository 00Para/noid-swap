# Poseidon2b on the EVM: locking the ETH leg directly on `Addr(s)`

Feasibility experiment, 2026-11-04. Files: `eth/contracts/Poseidon2b.sol` (the library),
`eth/contracts/HTLCPoseidon.sol` (the HTLC that uses it), `eth/contracts/test/Poseidon2bHarness.sol`
(test-only wrapper), `eth/test/Poseidon2b.test.js` (vectors, JS cross-check, HTLC tests, gas report).

## Bottom line

**It works, and it is cheap enough.** A Solidity/Yul implementation of Parano1d's address function
`Addr(s)` (one Poseidon2b permutation over GF(2^128)) reproduces both published vectors and agrees
with an independent JavaScript port on 200 random secrets, 40 random permutation states and 10
random `Derive` cases. A `claim` on `HTLCPoseidon` costs **519,537 gas** (receipt), of which the
permutation is **428,747 gas**. That is about 6x a SHA-256 `claim` (88,926 gas on `HTLC.sol`) and
far below the 10 M gas "too expensive" line: 1.56 USD on Ethereum L1 at 1 gwei, 31 USD at 20 gwei,
a few cents on a rollup. The equivalence proof (20-36 minutes of RISC Zero proving per swap) is no
longer needed on any EVM leg.

## What was built

| Piece | What it does |
|---|---|
| `Poseidon2b.addr(bytes32 s)` | `Addr(s)`: lanes `[s_lo, s_hi, L<<64, L]` with `L = "ADDRFIX_"`, one permutation, lanes 0-1 out, little-endian limbs as in the node. Raw variant. |
| `Poseidon2b.derive(m, i)` / `addrStock(m)` | `Derive(m, i)` (3 permutations) and `Addr(Derive(m, 0))` (4 permutations), for the stock-wallet variant. Implemented for completeness and as extra test coverage; `HTLCPoseidon` uses `addr` only. |
| `Poseidon2b.permute(uint256[4])` | The bare permutation on a tower-basis state, for cross-checking. |
| `HTLCPoseidon` | `HTLC.sol` with `lockAddr` in place of `hashlock` and `Poseidon2b.addr(preimage) == lockAddr` in place of `sha256(preimage) == hashlock`. Same lock id scheme, same events, same errors, same timelock windows, same fixed receiver, same re-entrancy guard and checks-effects-interactions order. `addrOf(bytes32)` lets a counterparty check the encoding before locking. |

The library is **generated** from the zero-dependency Rust spec (`equiv/portable/src/`) by
`eth/scripts/poseidon/gen.js`: it parses `constants.rs` (round constants, MDS matrices),
`basis_tables.rs` (the two 128x128 GF(2) change-of-basis matrices) and the few literals that sit in
`lib.rs` as code (`ADDRFIX_` label, `DERIVE_TAG`, the Derive pad block), converts the constants to
the flat basis exactly like the Rust `const fn`s do, and emits the Solidity. Nothing numeric is typed
by hand. The JavaScript reference model it uses (`eth/scripts/poseidon/poseidon2b.js`) is the same one
the tests use as their oracle.

### How to regenerate, and how it is kept honest

From `eth/`:

```sh
npm run poseidon:gen                       # rewrite contracts/Poseidon2b.sol
npm run poseidon:check                     # regenerate in memory; exit 1 unless byte-identical to the committed file
node scripts/poseidon/gen.js --out F.sol   # write elsewhere, then diff F.sol contracts/Poseidon2b.sol yourself
node scripts/poseidon/gen.js --explain     # print how each computed constant is derived
```

The output is a pure function of the three Rust files and of `gen.js` (no environment switches, no
timestamps, no absolute paths). `npx hardhat test test/Poseidon2b.test.js` regenerates the file into a
temp directory through the command line and fails on any byte of difference. Never edit
`Poseidon2b.sol` by hand: change the generator or the spec, regenerate, review the diff, and re-run the
vector and cross-check tests. Any change to the file changes the compiled bytecode (and its metadata
hash), so a runtime code-hash pin must be taken from the final build.

Constants the generator **computes** rather than copies from a Rust table (printed by `--explain`):
`T1 = flat(2)`, `T2 = flat(4)` (MDS_FULL factors), `E[i] = flat(d_i) xor 1` (MDS_PARTIAL diagonal plus the
all-ones matrix), `IV_HI_FLAT = flat(ADDRFIX << 64)`, `IV_LO_FLAT = flat(ADDRFIX)`, the flat `"noid-deri"`
tag and the two flat pad constants, plus the bit masks for the multiply, squaring and byte swap. The
generator refuses to run if `MDS_FULL` or `MDS_PARTIAL` stop having the shapes the factored layer
assumes. `gmul`/`gsqr` are emitted three times from one template (the permutation's own copy and the
two test-only wrappers); a test checks the three texts are identical, so the unit tests exercise the
same code the permutation runs, and the permutation-level cross-checks run the permutation's own copy.

### How the arithmetic is done

The permutation runs in the flat (GCM polynomial) basis, like the vendor and the portable Rust:
input lanes are converted tower -> flat, 66 rounds run flat, the two output lanes are converted back.

* **Multiplication** in GF(2)[x]/(x^128 + x^7 + x^2 + x + 1) has no EVM opcode. It is done with the
  256-bit integer `MUL`: each operand is split into five parts by bit position mod 5; the integer
  product of two parts holds, at the positions of one residue class, column sums of at most 26
  terms, which fit in the 4 bits between two class positions, so bit p of the product is exactly the
  carry-less product bit. 25 `MUL`s, five masks, two folds of the high half for the reduction.
  **~790 gas** per multiplication (measured, including the call overhead).
* **Squaring** is GF(2)-linear: spread bit i to bit 2i (7 shift/mask steps), then reduce. **~448 gas**.
* **S-box** `x^7 = (x * x^2) * x^4`: 2 squarings + 2 multiplications, as in the Rust.
* **MDS_FULL** `[[5,7,1,3],[4,6,1,1],[1,3,5,7],[1,1,4,6]]` (tower constants) is evaluated with 4
  multiplications instead of 10, using `5 = 1+4`, `7 = 1+2+4`, `3 = 1+2`, `6 = 2+4` and
  distributivity: `out0 = s + T2(a+b) + T1(b+d)`, `out1 = T2(a+b) + T1 b + c + d`,
  `out2 = s + T1(b+d) + T2(c+d)`, `out3 = a + b + T2(c+d) + T1 d` with `s = a+b+c+d`,
  `T1 = flat(2)`, `T2 = flat(4)`.
* **MDS_PARTIAL** `= diag(0x20, 0x2000, 0x200, 0x800) + ones`: `out_i = (d_i + 1) * in_i + s`, 4
  multiplications by precomputed constants.
* **Basis change**: XOR of the table row for each set bit, fully unrolled (128 x 4 ops): **4,416 gas**
  per conversion. The `ADDRFIX_` IV lanes, the `"noid-deri"` tag and the pad block are converted at
  generation time, so `addr` does 2 conversions in and 2 out.
* Everything lives on the stack; no memory, no loops (all 66 rounds unrolled). Deployed size of
  `HTLCPoseidon`: 15,145 bytes (limit 24,576).

## Operation counts per permutation (derived from `equiv/portable/src/lib.rs`)

| Stage | Rounds | S-boxes | GF(2^128) muls, naive (Rust) | GF(2^128) muls, Solidity | Squarings | Round-constant XORs |
|---|---|---|---|---|---|---|
| Initial `MDS_FULL` | 1 | 0 | 10 | 4 | 0 | 0 |
| Full rounds (r = 0-3, 62-65) | 8 | 32 | 32x2 + 8x10 = 144 | 32x2 + 8x4 = 96 | 64 | 32 |
| Partial rounds (r = 4-61) | 58 | 58 | 58x2 + 58x4 = 348 | 58x2 + 58x4 = 348 | 116 | 58 |
| **Total** | 66 | **90** | **502** (= `MULS_PER_PERMUTATION`) | **448** | **180** | **90** |

Basis conversions: Rust 4 in + 2 out per permutation; Solidity `addr` 2 in + 2 out (IV precomputed),
`addrStock` 2 in + 2 out for all 4 permutations (the sponge state stays flat in between).

EVM cost model from the measured primitives: 448 x 790 (mul) + 180 x 448 (sqr) + 4 x 4,416
(conversions) = 453 k, versus 428,747 measured for `addr` (the per-primitive figures include a
Solidity call wrapper each). 83 % of the cost is the 448 multiplications; 232 of them are the
partial-round diagonal, which is the structural minimum for this matrix shape.

## Gas and cost

| Measurement | Gas | Note |
|---|---|---|
| `Poseidon2b.addr` (pure, `gasleft()` delta) | **428,747** | final build |
| `HTLCPoseidon.claim` transaction (receipt `gasUsed`) | **519,537** | final build; includes 21k base, calldata, storage writes, the ETH transfer and the event |
| `addr` as a bare transaction (receipt) | 451,711 | final build; 21k base + calldata + one event |
| `Poseidon2b.addrStock` (4 permutations, pure) | 1,663,724 | final build; the stock-wallet variant would cost ~1.75 M per claim |
| `HTLC.claim` (SHA-256, for comparison) | 88,926 | |
| `HTLCPoseidon` deployment | 3,361,863 | |

USD at ETH = 3,000 USD (gas x price x 1e-9 x 3,000):

| | 1 gwei | 20 gwei |
|---|---|---|
| `addr` alone (428,747) | 1.29 USD | 25.72 USD |
| full `claim` (519,537) | **1.56 USD** | **31.17 USD** |
| SHA-256 `claim` (88,926) | 0.27 USD | 5.34 USD |

On L2s the execution gas price is typically 0.005-0.1 gwei (Base, OP Mainnet, Arbitrum One; these
are typical 2025-26 figures, not measured here), so a claim is **0.01-0.16 USD** plus the L1 data
component for ~100 bytes of calldata (cents or less after EIP-4844). Any EVM-equivalent rollup
works unchanged; the 0.52 M-gas claim is far under every block and per-transaction gas limit
(including the 16.7 M per-transaction cap of EIP-7825). zkEVM rollups also work but will charge more
per gas for a MUL-heavy transaction; not measured.

## What it changes in the protocol

* **No equivalence proof on EVM legs.** Today Bob must verify a zkVM receipt that one `s` satisfies
  `sha256(s) = H` and `Addr(s) = A` (20-36 minutes of proving on the owner's machine, plus trust in
  RISC Zero's soundness and zero-knowledge, Q3/Q11). With `HTLCPoseidon` the ETH leg locks on `A`
  itself, so the statement to prove becomes "the two contracts carry the same 32 bytes": Bob reads
  `lockAddr` from the ETH lock and the `claim_authority` from the opening of Alice's Parano1d
  contract (which he already rebuilds byte for byte) and compares. Nothing to prove, nothing to
  trust beyond the two chains.
* **Flow is otherwise unchanged.** Alice still generates `s` and locks first; the reveal still
  happens on Ethereum (the `claim` publishes `s` in calldata, storage and the `Claimed` event);
  Parano1d remains the second-claim leg. Timeout inequalities are unchanged in time; the ETH claim is
  Alice's reveal, and it is ~6x more expensive in gas, so Alice's fee budget and `M_A` for the reveal
  window `W_A` under congestion must be sized for ~0.52 M gas (Bob's Parano1d claim is unchanged).
  The claim must also be sent with an explicit gas limit (>= 650,000): a claim that runs out of gas
  reverts with `s` already in the calldata.
* **Bitcoin is not covered.** Script has no Poseidon (and cannot get one), so a BTC leg still locks on
  `SHA-256(s)` and still needs the equivalence proof, or a different design.
* **Raw variant only.** The stock-wallet variant locks on `Addr(Derive(m, 0))` and reveals the
  master secret `m`; `addrStock` exists in the library (4 permutations, ~1.7 M gas) but
  `HTLCPoseidon` checks `addr` only. The raw variant is the preferred one anyway (key decision 4).
* **Security now rests on Poseidon2b on both chains.** The ETH lock's secrecy is the preimage
  resistance of `Addr`, no longer SHA-256's. That is the same assumption Parano1d itself already
  rests on (every NOID address is `Addr(s)`), so the swap adds no *new* assumption; but it does
  remove SHA-256 as an independent second line. Open question **Q8** applies in full: Poseidon2b's
  round constants are unusually small (all <= 0x2000, in a subfield) and the preimage margin has not
  been assessed by a cryptographer. An attacker who finds `s'` with `Addr(s') = A` takes the ETH
  (and, on Parano1d, could already take the NOID). `A` is 256 bits (two lanes), so generic attacks
  are out of reach; the question is structural.
* **Lock id / tooling.** `swap-cli` would gain a second ETH contract and a `lockAddr` field; the
  `lockId` formula is the same shape with `lockAddr` in place of `hashlock`.

## What was verified, and how

1. **Fixed vectors.** `Addr(00 01 .. 1f) = f8183db204ffb765c7015d851c1754e4974c675b975c6738d9f6d138eb7212cf`
   (`o1lqvrmv...9xw2`) and `Addr(Derive(00 01 .. 1f, 0)) = o125qayv...7wlk`
   (bech32m-decoded in the test to `5501d2310bdb013fdc1b03b2f3b45d8f71de9a9bc2e3ca5ebccce2058db08c93`),
   both as documented in `docs/parano1d-capabilities.md` section 10 and produced there with the
   vendor crate. Both pass in Solidity (`addr`, `addrStock`, and `derive` followed by `addr`).
2. **Two readings of the spec, on a fixed-seed input set that always runs.** `eth/scripts/poseidon/poseidon2b.js`
   is a plain JavaScript port of `equiv/portable/src/lib.rs` (BigInt shift-and-add multiply, naive 4x4
   MDS, matrix-apply basis change) whose constants are parsed from the Rust source files, not typed.
   The Solidity uses a different multiplication algorithm, a factored MDS and precomputed IVs. They
   agree on 100+9 `gmul` cases, 100+6 squarings, 50 basis changes each way, 206 secrets through `addr`
   (200 pseudo-random plus 6 structured: all-zero, all-ones, `0xe0` and `0x80` bytes, single bits 0 and
   255; the `0xe0` pattern sets bits 5-7 of every byte, which the published vector never does), 40
   random 4-lane states through the bare permutation, and 10 `Derive(m, i)` cases (index 0 and
   `0xffffffff` included). Every pseudo-random input is SHA-256 in counter mode over a fixed seed
   (`POSEIDON_SEED` changes it to widen coverage), so a failing input is reproducible; the failure
   message names the seed and the input. None of this is skippable or shrinkable: a machine that
   cannot hold it makes the test fail with a message, not pass.
3. **HTLC behaviour.** Lock/claim/refund, wrong secret, SHA-256 digest offered as `lockAddr`
   (rejected), timelock boundaries, double claim/refund, non-sender refund, claim after refund and
   refund after claim, a receiver contract that rejects ETH. Mirrors `HTLC.test.js`.
4. **Generator and copies.** `contracts/Poseidon2b.sol` regenerates byte-identically (see "How to
   regenerate"), and the `gmul`/`gsqr` text in the two test wrappers is identical to the copy inside
   the permutation. Mutation check: changing one hex digit of one basis-table row makes 9 tests fail,
   including the regenerate-and-diff test and the 206-secret cross-check (the published vector alone
   did not notice it).
5. **Existing suite.** `npx hardhat test` (2026-11-04, after the changes above): 113 passing, 0 pending,
   0 failing. 24 of them are in `Poseidon2b.test.js` (2 generator, 9 library, 4 cross-check/gas,
   9 HTLCPoseidon); the other 89 are `HTLC.test.js` and `live.test.js`. The gas figures above are
   unchanged by the rebuild (428,747 / 451,711 / 1,663,724 / 519,537).

## What could not be verified

* **Not run directly against the vendor crate.** The reference is the portable Rust spec plus the two
  vendor-produced vectors; the Rust spec itself was checked against the vendor on 100,000 inputs
  earlier (`equiv/reference`). A vendor-generated differential file (10 k random plus all 256
  single-bit secrets) run against this contract is still to do (review F5c / F7). The JS reference and
  the generator now share one module, so a misreading of the spec common to both is caught only by
  the vectors and the vendor-anchored `.rs` tables.
* **Memory of the test run.** Hardhat's EDR runtime (0.12.0-next.23 on Node 24) keeps the per-opcode
  trace of every call in native memory, about 30-45 MB per 0.43 M-gas call, and neither V8 GC nor
  mining a block releases it; the ~300 permutation-sized calls of this file would need ~9-13 GB if
  left alone (earlier runs died with a native crash on the owner's 8 GB machine). Recreating the
  provider does release it: the test file calls `hardhat_reset` plus a forced GC every
  16-20 calls (sized from the free RAM and the retention it measures), and redeploys the harness.
  Nothing computed changes. The run above had about 790 MB of free RAM at its start; if fewer than 6 calls fit
  between two recycles the test fails with an explicit message. `POSEIDON_FORCE` and
  `POSEIDON_BATCH` no longer exist (they only gated or shrank the run).
* **Gas on a real network / rollup** was not measured, only on Hardhat's in-process EVM (Cancun,
  solc 0.8.24, optimizer runs 200, legacy pipeline). Different compiler settings change the numbers.
* **Poseidon2b's cryptographic strength** (Q8) and the Yul itself have had no external review.

## Possible further gas savings (not done)

* Specialise the multiplications by the 6 MDS constants (pre-masked parts as literals): ~3 %.
* Karatsuba on the 5-way split with a 6-way spacing: fewer `MUL`s, more XORs; maybe 10 %.
* 2-bit table lookups for the basis change: ~10 k gas, +8 KB code.
  The multiplication count (448) is the floor for this round structure.

## Update 2026-11-05

The vendor-generated differential file this document lists under "What could not be verified" now exists:
12,299 vectors from the vendor crate, 0 mismatches against `Poseidon2b.sol` (`eth/test/poseidon-vectors.test.js`,
`eth/README.md`). The production contract is `eth/contracts/HTLCPoseidonV2.sol`; its protocol delta, measured gas
(claim 499,288 to 544,584), code-hash pin and the integration spec are in `docs/poseidon-leg.md`. `HTLCPoseidon.sol`
remains as the prototype.
