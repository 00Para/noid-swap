# Review: Poseidon2b on the EVM (`Poseidon2b.sol`, `HTLCPoseidon.sol`)

Independent adversarial review, read-only, 2026-11-04. Reviewed at commit `8bb0679` (the files are
unchanged since then). Nothing was compiled or run. A live swap was using the machine, so every gas
figure and test result below comes from `docs/poseidon-evm.md`; this review did not reproduce them. All
arithmetic and constant checks below were done by hand from the source.

**Verdict.** It is safe to keep building v2 on this code: no input was found on which the Solidity and
the Rust spec differ, and the field arithmetic is proved correct for every input. It is **not yet**
safe to lock real funds with it, for four reasons:

- the Solidity has been compared with the vendor crate only indirectly, through the portable Rust and
  the JS port;
- its cross-check can be skipped, and has run in full only once;
- its generator is not in the repo;
- the 0.52 M-gas claim brings new operating hazards that the tooling and protocol do not handle yet.

In plain words: Alice chooses the secret. If even one 32-byte value exists for which the EVM's
`Addr` disagrees with Parano1d's `Addr`, Alice can pick it, take Bob's ETH, and leave Bob unable to
claim the NOID. "It agreed on 200 random inputs" is therefore not enough on its own. What makes it
enough is a proof that the code is the same function for *every* input (sections F1–F4), plus tests
that cannot be skipped and that compare directly against the vendor (F5).

## Findings

| id | severity | status | claim | citation |
|---|---|---|---|---|
| F1 | info | CONFIRMED | GF(2^128) multiply, squaring and reduction are exact for every input < 2^128. Column sums are ≤ 26 < 32, the two folds always finish, and every operand reached from `addr` is < 2^128 | `Poseidon2b.sol:491-527`, `lib.rs:62-103` |
| F2 | info | CONFIRMED | The basis change is the vendor's linear bijection. It is applied to the 2 input lanes, the 2 output lanes and (at generation time) to every constant, and nowhere else. All 264 round constants and 6 MDS constants check out by hand | `Poseidon2b.sol:114-387, 536-552, 560-779`; `constants.rs:14-35` |
| F3 | info | CONFIRMED | Round structure matches: initial `MDS_FULL`, 4 full, 58 partial (S-box on lane 0 only), 4 full. AddRC → S-box → linear in that order. The MDS factorisation and `(d_i+1)·in_i + Σin` are algebraically exact | `Poseidon2b.sol:528-780`; `lib.rs:168-181` |
| F4 | info | CONFIRMED | Sponge, IV order, byte order, `derive` tag/pad lanes and the flat-basis shortcut in `derive`/`addrStock` all match the Rust and vendor. The IV/tag literals are covered only by the vectors | `Poseidon2b.sol:41-109`; `lib.rs:237-281`; vendor `primitives.rs:300-305`, `domain.rs:35-40` |
| F5 | **medium** | RISK | The Solidity-side checks can be skipped. Vector tests and random cross-checks are memory-gated, so they go *pending* or *pass with fewer inputs* instead of failing. They ran in full once and never directly against the vendor. The published vector never touches 48 of the 128 `TOWER_TO_FLAT` rows at run time | `Poseidon2b.test.js:220-244, 346, 353, 371, 379, 387` |
| F6 | **medium** | RISK | The generator (`gen.js`) is not in the repo, so the 789-line file cannot be regenerated or diffed. `gmul`/`gsqr` exist in 3 textual copies, and the unit tests exercise a different copy from the one the permutation uses | `Poseidon2b.sol:10-12, 392-479 vs 491-527`; `poseidon-evm.md:27-31` |
| F7 | **high impact / low likelihood** | RISK | Alice chooses `s`, so a mismatch on *any* single input lets Alice take the ETH while Bob cannot claim the NOID. This replaces T10 (π soundness) as the load-bearing assumption. No mismatch was found (F1–F4), but random testing cannot establish this on its own | design §1, §8 T10 (`protocol-design.md:58, 583`) |
| F8 | medium | CONFIRMED (properties) / RISK (gas) | `HTLCPoseidon` keeps every `HTLC.sol` property. New: a claim under-provisioned for gas reverts *with `s` public* (the T3/T11 pattern); fees are 6× higher at the reveal; zkEVM trace/counter limits are untested | `HTLCPoseidon.sol:138-157`; `HTLC.sol:155-174` |
| F9 | low | RISK | `addrOf(bytes32)` invites calling `eth_call(addrOf(s))` with the live secret on a remote RPC before Bob locks. That leaks `s`, and Bob can then close the NOID lock to himself and never lock ETH | `HTLCPoseidon.sol:96-100` |
| F10 | info | REFUTED (doc claim) | "Removes SHA-256 as an independent second line" overstates the loss. SHA-256 never protected the swap against an `Addr` preimage attack (Bob could already invert `A` on the NOID leg), and third-party inversion pays fixed recipients. Q8 exposure is unchanged. Linkability moves earlier | `poseidon-evm.md:120-127`; `protocol-design.md:581, 592` |
| F11 | low | CONFIRMED (doc errors) | `poseidon-evm.md` calls the 6× claim "Bob's"; it is Alice's. The `HTLCPoseidon` header has stale gas numbers (0.3 M / 30 k; measured 428,747 / 88,926) | `poseidon-evm.md:113-114`; `HTLCPoseidon.sol:34-35`; `protocol-design.md:58, 117` |
| F12 | info | CONFIRMED | 428,747 gas is consistent with the operation counts (448 mul, 180 sqr, 4 conversions). At most ~5–10 % can still be saved; nothing that changes the mainnet picture | `poseidon-evm.md:59-74` |

---

## F1 — Field arithmetic: CONFIRMED for all inputs

**Masks.** The five 256-bit masks are the hex strings `84210`, `08421`, `10842`, `21084` and
`42108`, each repeated. Reading the digits right to left gives the bit positions `20j + 5i + c`, so
mask *k* is exactly the set of bit positions ≡ *k* (mod 5) in [0, 255]: 0 up to 255, 1 up to 251,
2 up to 252, 3 up to 253, 4 up to 254. The masks are disjoint and together cover all 256 bits.
`Poseidon2b.sol:492-501`.

**Products.** `a_i·b_j` as an integer is Σ 2^(p+q) over the set bits p ≡ i and q ≡ j. Every term
lands at a position n ≡ i+j (mod 5). The coefficient c_n (the number of pairs with p+q = n) is at
most the number of p ≤ 127 in one residue class, which is ⌈128/5⌉ = **26**. Since 26 < 32 = 2^5,
c_n occupies bits n…n+4 and never reaches n+5, the next position of the same class. So there is no
carry between columns, and bit n of the product = c_n mod 2 = the carry-less product bit. Two notes:

- The header comment ("fit in the 4 bits between two positions", `:20-21`) is loosely worded. The
  sum needs 5 bits (n plus the 4 above it), and that is exactly the gap. The claim is correct.
- MUL's wrap mod 2^256 only drops bits ≥ 256 of c_254's top. Bit n ≤ 254 is never affected.

**Grouping.** The 25 pairs `(i, j)` are split into the five rows `:502-506` by i+j mod 5, each pair
exactly once (checked row by row), and each row is masked to its class.

**Precondition: operands < 2^128.** If an operand had bits ≥ 128, the count could reach 52 and carries
would corrupt the result. By induction every operand reached from `addr`/`derive`/`addrStock` is
< 2^128:

- `t2f` outputs are XORs of 128-bit rows;
- all constants are 32 hex digits;
- reduced products are < 2^128 (see below);
- MDS outputs are XORs of the above.

The harness entry `gmulFlat(x, y)` with x ≥ 2^128 would give wrong answers, but nothing reachable in
production passes such values.

**Reduction.** `x^128 ≡ x^7 + x^2 + x + 1`, the same polynomial as the Rust (`0x87`, `lib.rs:74`) and
the comment (`:17`). The raw product has degree ≤ 254, so h = r ≫ 128 has degree ≤ 126. After the
first fold, the `h≪7` term reaches degree ≤ 133. The second fold's h has degree ≤ 5, so `h≪7` has
degree ≤ 12 and the result is < 2^128. The reduction would still finish for any 256-bit r (degree
≤ 255 → ≤ 134 → second h degree ≤ 6 → result degree ≤ 13). It is complete for all 255-bit products.
`:508-511`.

**Squaring.** The 7-step Morton spread (`:516-522`) sends bit i to bit 2i. Each mask was checked for
its step, including the first step's 64-bit split into bits 0–63 and 128–191. The same two-fold
reduction follows. In characteristic 2, (Σaᵢxⁱ)² = Σaᵢx²ⁱ, so `gsqr(x) == gmul(x, x)` for all x. The
Rust uses a different but equivalent reduction formula (`lib.rs:96-103`); both are reduced mod the
same polynomial, so they agree.

**Edge values.** For zero, one, the top bit, and all-ones × all-ones (the worst case for column sums,
c_n = 26), nothing differs: the argument above has no special cases. The JS test includes `M128×M128`
and `2^127×2^127` (`Poseidon2b.test.js:294-295`).

**The copies.** `gmul`, `gsqr` and the reduction appear three times in the file. A grep shows that each
of the 5 masks occurs exactly 9 times, each of the 5 product rows 3 times, and the reduction lines
24 times (6 functions × 4). So the three copies are textually identical (see also F6).

## F2 — Basis change: CONFIRMED

**Tables.** I compared 22 rows by hand with `equiv/portable/src/basis_tables.rs`, all identical:
`TOWER_TO_FLAT` rows 0–15, 64, 120 and 127, and `FLAT_TO_TOWER` rows 0, 1, 64, 120 and 127. Row 10
appears without its leading zero in the `.rs` file (`0x9ee9…`) and with it in Solidity (`0x09ee…`);
the value is the same. The test `convMany` (50 random values each way, not memory-gated,
`Poseidon2b.test.js:334-341`) checks every row with overwhelming probability: a wrong row i would fail
about 25 of the 50 inputs. The `.rs` tables are in turn tied to vendor `hardware.rs` by
`vendor_parity.rs:94-103` (1,000 random values per direction). The application is the same linear map
as the vendor's `apply_matrix` (`lib.rs:38-48`): an XOR of row i for each set bit i.

**Constants.** By linearity, `flat(3) = 1 ⊕ T1`, `flat(5) = 1 ⊕ T2`, `flat(6) = T1 ⊕ T2` and
`flat(7) = 1 ⊕ T1 ⊕ T2`, where T1 = row 1 and T2 = row 2. I XORed T1 ⊕ T2 by hand and got
`0x9a75122bf0b3a4f12b5cab2511a951c2`, which is the literal used. I then checked **all 264
round-constant uses** (rounds 0–3 and 62–65 on 4 lanes, rounds 4–61 on lane 0) against
`constants.rs:15-18`: every one matches.

The `MDS_PARTIAL` constants are `flat(d)+1`:

| tower `d` | flat row | constant used |
|---|---|---|
| 0x20 | row 5 | `…cf14` + 1 = `…cf15` (`:549`) |
| 0x2000 | row 13 | `…5bbf` + 1 = `…5bbe` (`:550`) |
| 0x200 | row 9 | `…0830` + 1 = `…0831` (`:551`) |
| 0x800 | row 11 | `…1a3c` + 1 = `…1a3d` (`:552`) |

`MDS_FULL` uses T1 and T2 (`:536-539`). The pad constants are row 7 (`0x80`) and row 120 (`1≪120`)
(`:87`).

**Where the conversion is applied.** On the two input lanes (`:47`, `:83`, and `_towerToFlat(index)`
at `:85`), on the two output lanes (`:48`, `:55`, `:63`), and in the test-only `permute` (`:67-74`).
Nowhere else.

**The flat-basis shortcut.** `_deriveFlat` and `addrStock` skip the convert-back-and-forth between
permutations. This is valid because `flat(tower(z) ⊕ c) = z ⊕ flat(c)`: the map is linear and the
tables are exact inverses (`vendor_parity.rs` and `lib.rs:346-355`).

**Constants not recomputed by hand.** `IV_HI_FLAT`, `IV_LO_FLAT` and the `"noid-deri"` flat constant
(`:41-42`, `:85`) would each take an XOR of 20–30 table rows. They are covered by the vectors: any error
in them changes `Addr(00..1f)` and `Addr(Derive(00..1f,0))`. **Risk that the wrong map was used for a
constant:** using F2T instead of T2F on a constant would change both vectors, so this is excluded as
long as the vector tests actually ran (F5).

## F3 — Round structure: CONFIRMED

- The Rust (`lib.rs:168-181`) runs one initial `MDS_FULL`. Rounds `r < 4` and `r ≥ 62` are full (RC
  on all 4 lanes, S-box on all 4, then `MDS_FULL`). Rounds 4–61 are partial (RC and S-box on lane 0
  only, then `MDS_PARTIAL`).
- The Yul matches: initial `:558`, full rounds `:559-582` and `:757-780`, partial rounds `:583-756`.
- A grep confirms the counts: 9 `mdsFull` calls, 58 `mdsPartial` calls, 90 `sbox(xor(lane, const))`
  calls (32 full + 58 partial), each partial on `a`.
- S-box: `x² = sqr(x)`, `(x·x²)·sqr(x²) = x³·x⁴ = x⁷` (`:528-531`), the same as `lib.rs:107-112`.
- `MDS_FULL` (`:535-545`), with 5 = 1+T2, 7 = 1+T1+T2, 3 = 1+T1, 6 = T1+T2:
  - row 0: 5a+7b+c+3d = s + T2(a+b) + T1(b+d), which is `na = s⊕u⊕p⊕q` ✓
  - row 1: 4a+6b+c+d = T2(a+b) + T1·b + c + d ✓
  - row 2: a+3b+5c+7d = s + T1(b+d) + T2(c+d) ✓
  - row 3: a+b+4c+6d = a + b + T2(c+d) + T1·d ✓
- The orientation (row i · input vector) matches `apply_mds` (`lib.rs:150-164`), and multiplication
  is commutative.
- `MDS_PARTIAL`: out_i = d_i·in_i + Σ_{j≠i} in_j = (d_i+1)·in_i + Σ_j in_j ✓ (`:547-553`).

## F4 — Sponge and byte order: CONFIRMED

- **Lanes.** `_limbs` (`:91-94`) puts bytes 0..16 into the high half of the `bytes32` word, and
  `bswap128` makes byte 0 the least significant byte. That gives `u128::from_le_bytes(s[0..16])`,
  the same as `lib.rs:237-243` and vendor `prover_fields` (`primitives.rs:227-239`). Lane 1 likewise
  uses bytes 16..32.
- **`bswap128`.** Its four steps (`:102-109`) are a correct 16-byte reversal for v < 2^128 (every
  mask's top part is zero, so the shifts stay within 128 bits).
- **Output.** `_unlimbs` writes lane0 LE ‖ lane1 LE, with address byte 0 as the most significant byte
  of the `bytes32`. That is the bech32m payload order (PROJECT.md conventions).
- **IV.** The state is `[s_lo, s_hi, L≪64, L]` (`lib.rs:255-261`) with `L = "ADDRFIX_"` big-endian.
  This matches vendor `capacity_iv` → `[high, low]` = `(state[2], state[3])` (`domain.rs:35-40`) and
  `derive_address` (`primitives.rs:300-305`), which absorbs the secret into lanes 0 and 1 with no pad.
  The Solidity passes `IV_HI_FLAT` as lane 2 and `IV_LO_FLAT` as lane 3 (`:47`). The constant
  `ADDRFIX_LABEL` (`:39`) is correct (`41 44 44 52 46 49 58 5F`) but is never used.
- **`derive`** (`:79-88`) follows `lib.rs:267-281`:
  - IV 0, then absorb (m_lo, m_hi) and permute;
  - XOR `index` into lane 0 and `"noid-deri"` into lane 1, then permute;
  - XOR the pad (byte 0 = 0x80 → lane 0 bit 7; byte 31 = 0x01 → lane 1 bit 120), then permute;
  - output lanes 0 and 1.

  `addrStock` equals `addr(derive(m, 0))` by the shortcut argument in F2.
- **Stock variant on `HTLCPoseidon`.** `HTLCPoseidon` checks `addr` only. A stock-variant lock would
  need Alice to reveal `Derive(m,0)` (not `m`), which Bob can use only with the raw client R. On EVM
  legs this makes the stock variant pointless rather than unsafe. The header's remark that the stock
  wallet "never exposes" `Derive(m,0)` (`HTLCPoseidon.sol:28-29`) is about the stock *GUI*. A tool can
  compute it.

## F5 — The cross-check can be skipped and has never been run against the vendor (medium, RISK)

**What the two published vectors exercise.** `Addr(00 01 … 1f)` exercises the whole round schedule,
every RC and MDS constant, the IV, the byte order and the output conversion. Its input bytes are all
≤ 0x1f, though, so bits 5–7 of every byte are zero. At Solidity run time it therefore **never touches
the 48 `TOWER_TO_FLAT` rows 8k+5, 8k+6, 8k+7**. The IV, which would use rows 8k+6, is precomputed.
About a quarter of the `FLAT_TO_TOWER` rows are also untouched, because neither output lane has those
bits set.

`Addr(Derive(00..1f, 0))` adds the tag and pad constants and the flat-basis chaining, but only with
index 0. The `derive`-then-`addr` check (`test.js:356-358`) runs on a pseudo-random value and covers
most rows. Neither vector exercises a non-zero index or the worst-case carries inside the permutation.

**What closes the gap.** The random tests (`convMany`, 200 `addr`, 40 `permute`, 10 `derive`) do. But:

1. **They can silently not run.**
   - `needHeavy` calls `this.skip()`, so the test reports *pending*, not failed (`:233-237`). This
     applies even to the fixed-vector tests (`:346`, `:353`).
   - `fitCount` lets the 200-input test **pass after checking fewer inputs**, leaving only a note
     (`:239-244`, `:371`).
   - The doc says the full set ran once (`poseidon-evm.md:141-144`) and later runs had 8 pending
     (`:148-152`).

   A green `npx hardhat test` therefore does not show that the Solidity computes `Addr`.
2. **The chain of evidence is indirect.** vendor ↔ portable Rust (`vendor_parity.rs`, 100 k) ↔ JS port
   (parses the same `.rs` files) ↔ Solidity. The JS port and the generator share their input files and
   their reading of `lib.rs`. A misreading they share would be caught only by the vectors, and the
   vectors leave the gaps above. Today the gaps are closed by the vendor-anchored `.rs` tables together
   with `convMany`, which is sound, but it is three links long.
3. **Copy drift.** `gmulMany`/`gsqrMany` test the copies in `gmulFlat`/`gsqrFlat` (`:392-479`), not the
   copy inside `_permute` (`:491-527`). They are identical today (F1), but nothing enforces that.

**Fix.**

- (a) Make the fixed-vector tests unconditional. One call costs about 30 MB.
- (b) Make every shortfall a failure.
- (c) Add a direct differential test: a small Rust bin on the vendor crate (`derive_address`, `Derive`)
  writes about 10,000 `(s, Addr(s))` pairs. Include structured inputs: the 256 single-bit secrets
  (which test each table row in isolation), all-zero, all-`ff`, each byte 0x80, the lane-boundary
  patterns from `vendor_parity.rs:196-222`, and non-zero `index` values for `derive`. Check them
  against the compiled contract on an EVM that does not keep traces (`forge test` with a vectors file,
  or `revm` from Rust). Expect 0 mismatches.
- (d) Run it once the live swap's processes are gone.

## F6 — Not reproducible (medium, RISK)

The file says it is generated (`:10-12`), but the generator "was a one-off" and is not committed
(`poseidon-evm.md:27-31`). A later hand edit, or a regeneration with a different script, cannot be
checked by diff. A reviewer also cannot confirm the precomputed IV and tag values except through the
vectors.

**Fix.** Commit the generator, for example as `eth/scripts/gen-poseidon2b.js`, and add a test that
regenerates the file and fails on any diff. Emit `gmul`/`gsqr` once (as a shared Yul snippet the
generator inlines), or test the permutation's own copy. Have the generator print the derivation of
`IV_HI_FLAT`, `IV_LO_FLAT` and the tag constant.

## F7 — The new load-bearing assumption: Solidity `Addr` == vendor `Addr` on every input (high impact, RISK)

**Attack.** Suppose some s* exists with `sol_Addr(s*) ≠ vendor_Addr(s*)`.

1. Alice computes A* = `sol_Addr(s*)` and creates her Parano1d lock with `claim_authority = A*`. Bob
   checks exactly this: lockAddr equals the opening's authority, and it does.
2. Bob locks ETH on A*.
3. Alice claims the ETH with s*, which passes `HTLCPoseidon.sol:144`.
4. Bob's NOID claim with s* fails, because `vendor_Addr(s*) ≠ A*`. Alice refunds the NOID at D.

Bob loses the ETH. Alice gets to choose s, so a rare bug is as bad as a common one. This replaces T10
(π soundness, `protocol-design.md:583`) for EVM legs. Bob's post-reveal recheck (`:120`) detects the
mismatch but cannot recover the funds.

**Assessment.** The code is straight-line and branch-free. Its only data-dependent behaviours are
integer carries, bounded in F1, and table-row selection, which is exact in F2. So equality on every
input follows from F1–F4. This review found no mismatching input. That conclusion now rests on one
reviewer's hand proof plus random tests, which is below the bar PROJECT.md sets for load-bearing
code.

**Fix.**

- A second independent review of the Yul, given the code and not this document.
- The direct vendor differential from F5(c).
- Optionally, a symbolic check (halmos/hevm) that `gmul` is bilinear and equals a bit-serial reference
  on symbolic 128-bit inputs. If that is too heavy for the solver, check the 16,384 basis pairs
  (eᵢ, eⱼ) plus the all-ones pair. Together with the carry bound these cover every input.

**Related, not checked.** Whether `noid_gkr` can authorize for every 32-byte s (for example s = 0).
`SpendSecret::from_bytes` accepts anything (`primitives.rs:222-224`). An s that the EVM accepts but the
Parano1d prover refuses would be the same attack. This was equally true of the SHA-256 design.

## F8 — `HTLCPoseidon` safety properties: CONFIRMED; new gas hazards: RISK

**Preserved (diffed against `HTLC.sol`):**

- Fixed receiver: `:150, 155`.
- Disjoint windows: claim if `ts < timelock` (`:143`), refund if `ts ≥ timelock` (`:166`).
- Re-entrancy guard (`:78-83`) and checks-effects-interactions (`:147-156`, `:169-176`).
- Mutual exclusion: `claimed`/`refunded` are checked in both functions (`:141-142`, `:164-165`).
- Lock id: same `keccak256(sender‖receiver‖amount‖lockAddr‖timelock)` (`:93`). Duplicate locks revert
  (`:118`).
- Only change: the timelock is checked *before* the hash (`:143-144`). That is better: an expired
  claim costs little gas.

**No new griefing.** There are no loops or unbounded storage. A front-runner who copies the preimage
pays the 0.5 M gas and pays Alice; Alice's own transaction then reverts cheaply at `AlreadyClaimed`
(`:141`).

**New hazards:**

1. **Out-of-gas publishes s.** A claim sent with a gas limit sized for the SHA-256 contract (89 k), or
   for a wallet default, reverts but leaves s in calldata. The lock stays claimable, so Alice can
   resend. Near the cutoff it becomes the "reverted claim → Bob takes both" case (`protocol-design.md:132`,
   T11 `:584`). The tool must set an explicit limit (≥ 650 k) and simulate the claim on its own node
   first.
2. **Higher fee sensitivity.** The reveal is 6× the gas, so a fee spike near `T_reveal − M_A` more
   easily leaves Alice's claim stuck in the mempool with s visible (T3). `M_A` and Alice's fee policy
   must be sized for 0.52 M gas.
3. **Chain choice.** 0.52 M gas is far below every EVM block and transaction cap. zkEVMs with trace
   or counter limits (Linea's per-module limits; Polygon zkEVM counters; older Scroll row limits) can
   reject a transaction with ~11,200 `MUL`s regardless of gas. This is untested.
4. **L1 economics at trial sizes.** 519,537 gas at 1 gwei is 0.00052 ETH, which is 52 % of the
   0.001 ETH live-run size. On L1, small swaps are not worth it. Use an L2, or a minimum amount.
5. **Receiver that rejects ETH.** Unchanged from T11. The "EOA" check (`getCode == 0x`) is not durable
   under EIP-7702 delegation, but this only hurts the address owner.

**Note.** `HTLC` and `HTLCPoseidon` share an ABI shape and the lock-id formula. Only the pinned address
plus runtime code hash tells them apart, so pin the new hash. Tools must not reuse the `HTLC.sol` pin.

## F9 — `addrOf` invites leaking the secret (low, RISK)

`addrOf(bytes32 secret)` (`HTLCPoseidon.sol:96-100`) is meant to let a counterparty check the encoding.
The natural misuse is Alice running `eth_call addrOf(s)` with the *live* s through Infura or a similar
RPC before Bob locks. Whoever sees s at that point can close the NOID lock to Bob (`protocol-design.md:131`),
and Bob can then take the NOID and never lock ETH. The SHA-256 design had no such convenience function.

**Fix.** Remove `addrOf` from the production contract and keep it in the harness. Or document in the
contract and the protocol that it may only be called with the public test vector, and that tooling
computes `Addr` locally with the reference crate.

## F10 — What locking on `A` changes in §8 (doc claim partly REFUTED)

- **Second-preimage vs preimage.** Locking on A instead of H changes nothing that matters for who can
  steal:
  - Alice already knows s, and any s′ with `Addr(s′) = A` claims both legs equally.
  - A third party who inverts A can only pay the fixed recipients early (ETH to Alice, NOID to Bob).
  - The one damaging inverter is **Bob**: invert A, close the NOID lock to himself, never lock ETH.
    That attack existed in v1 because the NOID leg was always guarded by `Addr` alone (T8, `:581`).

  So SHA-256 was never a "second line" for the swap, and `poseidon-evm.md:120-127` overstates the loss.
  Q8 (small, subfield round constants) applies *exactly as before*: it is systemic to Parano1d.
- **What is removed.**
  - T10 (zkVM soundness/ZK, image ID, Q3/Q11 for the π part).
  - The risk of a remote prover.
  - The 20–36 min proving step.
- **What is added.** F7 (exact implementation equality on every input, plus the code-hash pin), F8
  (gas), F9 (`addrOf`).
- **Who can compute what.**
  - Before the reveal, A is now public on Ethereum (`Locked` event) from the moment Bob locks.
  - Before, the ETH chain showed only H, and A lived in the opening (not recoverable from the Parano1d
    chain).
  - After the reveal nothing changes: s is public and anyone computes `Addr(s)`.
  - **T19 linkability** therefore moves earlier and now also covers refunded or aborted swaps, as far
    as A can be matched on Parano1d. Minor.
- **Bob's checks before locking (v2):**
  1. Rebuild the opening byte for byte and run all §6.3 checks. Use the opening's `claim_authority`
     bytes as `lockAddr`, in bech32m payload order with byte 0 as the most significant byte. Do not
     take A from Alice's message.
  2. Pin the `HTLCPoseidon` address and its runtime code hash.
  3. T9: A not seen before and `getSlotsByOwner(A)` empty. The local database now stores A instead of
     H.
  4. The usual funding, finality and lock-by gates.

  Drop π verification and H. Keep the post-reveal local `Addr(x)` recheck (`:120`) as a mismatch
  detector.
- **Alice's checks before revealing (v2):**
  - code hash;
  - `getLock().lockAddr == A`;
  - receiver is her EOA;
  - simulate `claim` on her own node, never on a remote RPC before the lock is final;
  - set an explicit gas limit ≥ 650 k;
  - fee policy sized for 0.52 M gas.

## F11 — Documentation errors (low)

- `poseidon-evm.md:113-114`: "Bob's claim is ~6x more expensive … fee budget for W_A". The ETH claim is
  **Alice's** reveal (`protocol-design.md:58, 117`). Bob's NOID claim is unchanged. The budget belongs
  to Alice's `M_A` and fee policy.
- `HTLCPoseidon.sol:34-35`: "about 0.3 M gas … versus ~30k for the SHA-256 version". Measured: 428,747
  for `addr` and 519,537 for `claim`, versus 88,926 for the SHA-256 claim.

## F12 — Gas and size: plausible (CONFIRMED)

**Counts.**

- Full part: 8 full rounds × 4 S-boxes × 2 muls = 64, plus 9 `mdsFull` × 4 = 36.
- Partial part: 58 × (2 + 4) = 348.
- Total: **448** `gmul`. Squarings: 90 × 2 = **180**. Conversions: 2 in + 2 out.

These match `poseidon-evm.md:61-66` and the Rust count of 502 (which includes the naive MDS).

**Per-operation estimate.**

- One inlined `gmul`: 10 split ANDs with PUSH32 masks (~90 gas), 25 `MUL`s with their DUPs (~275), 20
  XORs, 5 masks and 4 ORs (~100), two folds (~150), plus stack shuffling. That is ~650–750 gas.
- One `gsqr`: 7 spread steps (~130) plus the folds (~150), ~300.
- One conversion: 128 × ~8 ops, ~4.4 k.

Total: 448 × ~700 + 180 × ~300 + 4 × 4.4 k + RC XORs and MDS XORs (~10 k) ≈ 400–440 k. The measured
428,747 fits.

**What is left.**

- Pre-masking the constant operand: 268 of the 448 muls (all MDS products) multiply by one of 6
  constants. This saves ~10 ops each, about 2–3 %.
- The 5-way split is minimal for 128-bit operands: spacing 4 would allow sums up to 32 ≥ 2^4. 64-bit
  Karatsuba halves do not help, since 3 × 25 `MUL`s is worse.

Nothing here changes the mainnet picture. What matters is the target chain (F8.3) and the compiler
settings: record solc 0.8.24, optimizer 200 and the legacy pipeline alongside the code-hash pin. The
deployed size of 15,145 bytes is under the 24,576 limit.

---

## Must do before v2

1. **Direct vendor differential** (F5c/F7): vendor-generated `(s, Addr(s))` and `(m, i, Derive(m,i))`
   vectors, at least 10 k random plus structured edge cases including all 256 single-bit secrets, run
   on a trace-free EVM (forge or revm). Expect 0 mismatches.
2. **Make the Solidity tests fail rather than skip** (F5a/b). The fixed vectors run unconditionally.
   Any shortfall in the cross-check is a failure. Re-run the full suite once the live swap's processes
   are gone.
3. **Commit the generator plus a regenerate-and-diff test**, and dedupe or directly test the
   permutation's own `gmul`/`gsqr` (F6).
4. **A second independent review of the Yul** (F7; PROJECT.md rule for load-bearing code). Optionally,
   a symbolic or basis-pair check of `gmul`.
5. **Protocol and tooling for v2** (F8–F10):
   - update design §2.2 steps 2–3, 5, 9.2, 10 and 11, and §8 T8, T10, T11, T19;
   - pin the new runtime code hash;
   - store A in the T9 database;
   - explicit claim gas limit ≥ 650 k, simulated on Alice's own node;
   - `M_A` and fee policy sized for 0.52 M gas;
   - never send `s` to a remote `eth_call`, and remove `addrOf` from the production contract or
     restrict it to test vectors.
6. **Pick the EVM chain and test there** (F8.3/F8.4): gas, any zkEVM trace limits, and a minimum swap
   size on L1.
7. **Fix the two documentation errors** (F11).

## Not checked

- Nothing was compiled or executed. Every test outcome and gas figure is quoted from
  `docs/poseidon-evm.md`.
- `IV_HI_FLAT`, `IV_LO_FLAT` and the `"noid-deri"` flat constant were not recomputed by hand. They are
  covered only by the two vectors (F2).
- Of the 256 basis-table rows, 22 were compared by hand. The rest rely on `convMany` together with
  `vendor_parity.rs`.
- The solc output (optimizer and stack scheduling) is trusted. The bytecode was not audited.
- Whether `noid_gkr` can prove an authorization for every 32-byte s (F7, related).
- Poseidon2b cryptanalysis (Q8); the zkVM parts (no longer used on EVM legs).
- zkEVM or L2-specific limits, and gas on real networks.
- `swap-cli` integration: no v2 code exists yet.

## Applied 2026-11-04 (must-do items 2, 3 and 7)

- **F6 / item 3.** The generator is in the repo (`eth/scripts/poseidon/gen.js`, with the JS reference
  `poseidon2b.js`); `npm run poseidon:check` and the Hardhat test regenerate the contract and fail on
  any byte of difference (verified byte-identical, 55,219 bytes). The three `gmul`/`gsqr` copies are
  emitted from one template and a test asserts their text is identical, so the unit tests and the
  permutation share the same code; the cross-checks run the permutation's own copy.
- **F5a/b / item 2.** No test skips or shrinks any more. The vectors and a fixed-seed cross-check
  (206 secrets, 40 states, 10 derives, structured secrets with bits 5-7 set) always run; a machine
  that cannot hold them fails with a message. Full suite: 113 passing, 0 pending, 0 failing.
- **F11 / item 7.** `poseidon-evm.md` now says the ETH claim is Alice's reveal; the `HTLCPoseidon`
  header carries the measured gas (428,747 / 519,537 / 88,926) instead of the stale figures.
- Still open: item 1 (vendor differential), item 4 (second Yul review), items 5-6.

## Applied 2026-11-05 (must-do items 1, 5 contract side, 6 sizing; production contract)

- **Item 1 (vendor differential): done.** `equiv-ref addr-vectors` (new subcommand in `equiv/reference`) writes
  `eth/test/vectors/addr-vectors.bin`: 12,299 vectors computed by the vendor crate (299 structured, including all 256
  single-bit secrets, the all-zero, all-ones and published secrets; 12,000 seeded random). `eth/test/poseidon-vectors.test.js`
  compares the EVM contract on a trace-limited chain (recycled every few dozen calls): the whole file in four slices, **12,299 of
  12,299 equal, 0 mismatches**; the JS port also equals the vendor on all of them. No `Derive` vectors (the production contract
  does not use `Derive`).
- **Item 2 (fail, do not skip): done earlier, kept.** The new vector test, the V2 unit tests and the V2 fuzz campaign never skip
  or shrink; a machine that cannot hold a chunk fails with a message.
- **Item 3 (generator and regenerate test): done earlier**; unchanged.
- **Item 4 (second independent review of the Yul): not done.** The library `Poseidon2b.sol` is unchanged; the V2 contract is a small
  diff against `HTLC.sol` (`docs/poseidon-leg.md` section 8) and has not been reviewed independently either.
- **Item 5 (protocol and tooling for v2):** contract side done in `HTLCPoseidonV2.sol`: no `addrOf`, lock word and all terms in
  `Locked`, explicit minimum-gas check (`MIN_CLAIM_GAS` 540,000, recommended limit 650,000, measured claim gas 499,288 to 544,584),
  secret exactly 32 bytes, new runtime code hash pinned. Tool and design-document changes are specified in `docs/poseidon-leg.md`
  section 9 and not implemented (`swap-cli`, `live.js`, `protocol-design.md` untouched).
- **Item 6 (pick the chain and test there): not done.** Only Hardhat's EVM was used. `docs/poseidon-leg.md` section 5 gives the
  minimum swap size on L1 (about 0.055 ETH at 1 gwei for a 1 % fee).
- **Item 7 (documentation errors): done earlier.**
- F9: `addrOf` is gone from the production contract (a test checks the ABI and the bytecode selectors).
