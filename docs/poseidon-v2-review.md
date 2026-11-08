# Second review: `Poseidon2b.sol` (Yul) and `HTLCPoseidonV2.sol`

Independent review, 2026-11-05, at commit `46196c0`. Read-only on all source. No Hardhat or cargo run. The
first review (`docs/poseidon-evm-review.md`) and `docs/poseidon-leg.md` were read only after the derivations
below were done. The claims were checked against the vendor crate itself, not against `equiv/portable`.

One mechanical check was run: a throwaway Node script, not committed. It reads only three files:
vendor `hardware.rs`, vendor `permutation.rs` and `Poseidon2b.sol`. It does four things:

* re-implements the Yul exactly as written, with every constant, mask and the round schedule parsed from the
  `.sol`;
* implements the vendor's binary tower field from scratch: `Block8` with the AES polynomial, then
  `y^2 = y + tau` at each level;
* compares the two;
* proves that the vendor basis change is a field isomorphism.

Results are quoted where used.

## Verdict

1. **Testnet: yes, wire it in.** No defect was found in either contract. For every 32-byte secret, the EVM's
   `Addr` equals both the node's flat-basis `Addr` and the prover's tower-basis permutation. This follows from a
   proof over all inputs plus machine checks, not from the vectors alone.
2. **Real funds at trial amounts: yes on the contract side**, once these are in place:
   * the `swap-cli` / `live.js` integration of `poseidon-leg.md` section 9, with the gas, calldata and log-scan
     rules below;
   * one harness test proving the prover handles edge secrets (V2-9).

   On L1, 0.001 ETH is uneconomic: the claim fee is about 50 % of the leg.
3. **Fix first:** nothing in `Poseidon2b.sol` or `HTLCPoseidonV2.sol`. In the tooling, before real funds:
   * the edge-secret prover test (V2-9);
   * a claim gas limit with margin (V2-6);
   * calldata built and length-checked by the tool itself (V2-7);
   * a fail-closed `Locked` log scan (V2-8);
   * a "client R works here" gate for Bob (V2-10).

## Findings

| id | severity | status | finding | where |
|---|---|---|---|---|
| V2-1 | info | CONFIRMED | GF(2^128) `gmul`, `gsqr` and the reduction are exact for every pair of operands < 2^128. Every operand reached from `addr` is < 2^128 | `Poseidon2b.sol:495-531`, `:118-391` |
| V2-2 | info | CONFIRMED | The basis change, the 264 round constants, the 157-step schedule, both MDS layers, the IV and the label all equal the **vendor's**, checked directly | `Poseidon2b.sol:42-46, 118-391, 536-784`; vendor `hardware.rs:29, 161`, `permutation.rs:185-206`, `domain.rs:27-40, 56` |
| V2-3 | info | CONFIRMED | `TOWER_TO_FLAT` is a field isomorphism from the vendor's tower field onto GCM GF(2^128), and `FLAT_TO_TOWER` is its inverse. So the EVM's flat computation equals the prover's tower computation (`noid_gkr` `evaluate_permutation`) on **every** input, not only on the vectors | vendor `noid_core/src/tower/*.rs`, `noid_gkr/src/layers.rs:116-189`, `wallet_authorization.rs:390-402` |
| V2-4 | info | CONFIRMED | Byte order, IV lane order and output lanes match vendor `derive_address`. No memory or free-pointer use, no `calldatasize`, no 128-bit truncation on the `addr` path | `Poseidon2b.sol:49-53, 95-113`; vendor `primitives.rs:222-239, 300-305`, `compression.rs:70-77, 115-123, 139-145, 198-216` |
| V2-5 | info | CONFIRMED (latent) | `internal` helpers (`_permute`, `_towerToFlat`, `_flatToTower`, `gmulFlat`, `gsqrFlat`, `permute(uint256[4])`) silently mis-compute or drop bits for operands ≥ 2^128. Not reachable from V2 | `Poseidon2b.sol:71-78, 118, 256, 396, 441, 488` |
| V2-6 | low | CONFIRMED (margin) / REFUTED (lock-up, griefing) | `MIN_CLAIM_GAS = 540,000` sits only about 26-30 k (about 5 %) above the post-check work, priced under Cancun rules. If a fork raises storage or account-creation costs, a claim that passes the check can run out of gas mid-way. The result is a revert with `s` public and a resend, not a loss. The check cannot lock funds, and no third party can make an honest EOA claim fail after it | `HTLCPoseidonV2.sol:75-78, 176-189` |
| V2-7 | low | CONFIRMED | The exact-68-byte rule turns any calldata suffix into a revert that has already published `s`. Examples of a suffix: wallet attribution suffixes, middleware that appends data. Short calldata also reveals up to 31 bytes before the decoder reverts | `HTLCPoseidonV2.sol:169` |
| V2-8 | info | CONFIRMED | `lockAddr` is not an indexed topic in `Locked`, so Bob's "no earlier lock on this `A`" check (`poseidon-leg.md` 6, step 3) must read every `Locked` log since deployment. Public RPC range caps can silently truncate that scan | `HTLCPoseidonV2.sol:82-89` |
| V2-9 | low | PLAUSIBLE (pre-existing) | The prover code that was read accepts every 32-byte `s`: no value checks from `SpendSecret::from_bytes` to the state table. The ZK proof built from the state table was not read. A value-dependent prover failure would be the F7 attack (Alice picks that `s`) | vendor `primitives.rs:222-224`, `wallet_authorization.rs:45-49, 381-411`, `zk_auth_capsule.rs:236-252` |
| V2-10 | low | CONFIRMED | Bob has no stock-wallet fallback on this leg. `--import-wallet-secret` takes a **master** secret `m` and authorizes `Addr(Derive(m, i))`, so a lock on `A = Addr(s)` can be claimed only with client R (raw `noid_gkr`) | vendor `noid_node/src/main.rs:1374-1376, 1995-1998`; `poseidon-leg.md` 4 |
| V2-11 | info | CONFIRMED | Every behavioural difference from `HTLC.sol` is listed in `poseidon-leg.md` 8.2 or `FUZZ.md` 8. Two ABI-level differences are listed in neither as a tooling hazard: (a) the `Lock` component is named `lockAddr`, so decoders that read the field by name (`l.hashlock`) break; (b) the two public getters `MIN_CLAIM_GAS` and `RECOMMENDED_CLAIM_GAS_LIMIT`. Neither affects safety | `HTLCPoseidonV2.sol:59-68, 75-78`; `HTLC.sol:60-69` |
| V2-12 | info | CONFIRMED | The protocol claim holds: there is no 32-byte value on which the EVM and Parano1d disagree. Bob's checks, done as `poseidon-leg.md` 6 specifies, leave a malicious Alice no way to make the NOID claim authority differ from the ETH lock word. There are no non-canonical encodings | section D below |

---

## A. `Poseidon2b.sol` derived independently and checked line by line

### A.1 Field and multiplication

**Reference.** The node's field is the vendor binary tower:

* `Block8` is GF(2^8) mod `x^8+x^4+x^3+x+1` (`block8.rs:87-129`).
* Each doubling is `y^2 = y + tau` with Karatsuba (`block16.rs:93-111`, `block32.rs:87-100`, `block64.rs:88-100`,
  `block128.rs:100-113`).
* `tau` = `0x20`, `0x2000`, `0x2000_0000`, `0x2000_0000_0000_0000`. These are `block8.rs:46`, `block32.rs:20`,
  `block64.rs:22`, `block128.rs:22`. Equivalently, `1 << (h-3)` at half-width `h`.

The flat (GCM) field used by the native permutation is GF(2)[x]/(x^128+x^7+x^2+x+1), with bit i the coefficient of
x^i (`hardware.rs:393-425, 458`).

**Yul `gmul`** (`Poseidon2b.sol:495-516`). Each operand is split into five masks. Mask k is the set of bit
positions ≡ k (mod 5) in [0,255]. Checked by parsing the masks from the file.

For a product `a_i * b_j`:

* Every term lands on a position ≡ i+j (mod 5).
* The count at one position is at most the number of bits below 128 in one residue class. That number is **26**
  for residues 0, 1, 2 and 25 for residues 3, 4.
* 26 < 32, so each column count fits in the 5 bits n..n+4 and never reaches n+5. That means no carries between
  columns: bit n is the parity.
* The product is < 2^256, so `MUL` does not wrap.

The five result rows group the 25 pairs by i+j (mod 5), each pair once, each row masked to its own class. Checked
by parsing the five rows.

**Reduction.** The product has degree ≤ 254. Fold 1 leaves degree ≤ 133; fold 2 leaves degree ≤ 12. The result is
< 2^128 and correct because x^128 ≡ 1+x+x^2+x^7.

**`gsqr`** (`:518-531`). It is a Morton spread of 128 bits to 256 bits (bit i → 2i), with masks checked step by
step, followed by the same reduction.

**Machine check.** Yul `gmul`/`gsqr` equal a bit-serial GCM multiply on:

* all 16,384 basis pairs;
* 2,809 adversarial pairs: 0, 1, all-ones, 2^127, all-ones^1, 0x87, the half masks, each residue-class mask, and
  random values.

The worst case for column counts (residue mask × residue mask, all-ones × all-ones) is included.

**Precondition: operands < 2^128.** The induction over the `addr` path:

* `_limbs`/`_bswap128` output < 2^128 (`:95-113`). Every mask is 128 bits wide.
* `t2f`/`f2t` XOR 128-bit rows and read only bits 0..127.
* Every constant has 32 hex digits.
* `gmul`/`gsqr` outputs are < 2^128.
* `sbox` and MDS outputs are XORs of these.

Each lane lives in its own stack word, so a carry across a lane boundary is impossible by construction.

### A.2 Basis change and the isomorphism (the "all 2^256 inputs" argument)

* The 256 rows of `t2f`/`f2t` (`:118-391`) equal vendor `conversion_matrix::TOWER_TO_FLAT` / `FLAT_TO_TOWER`
  (`hardware.rs:29, 161`): **0 of 256 rows differ**. This was compared directly with the vendor, not with
  `equiv/portable`.
* φ = `TOWER_TO_FLAT` with φ(1) = 1, and φ(eᵢ·eⱼ) = φ(eᵢ)·φ(eⱼ) for **all 8,256 basis pairs**. The left product is
  vendor tower multiplication; the right is GCM. φ is GF(2)-linear and both multiplications are bilinear, so φ is a
  ring homomorphism. It is invertible, and `FLAT_TO_TOWER` ∘ φ = id on every basis vector (0 failures).
* **Consequence.** The permutation is a fixed composition of field additions, multiplications by constants and
  multiplications of state values, with no input-dependent branch. So
  `flat_perm = φ ∘ tower_perm ∘ φ⁻¹` **for every state**, provided every constant is φ of the tower constant
  (A.3). This is what ties the EVM to the **prover** (`evaluate_permutation`, tower arithmetic,
  `layers.rs:116-189`), and not just to the flat `derive_address` that generated the vectors.
* Independent confirmation: a tower-only implementation (no basis tables at all, vendor round constants and
  matrices) reproduces the published vector `f8183db2…12cf` for `00 01 … 1f`.

### A.3 Constants, rounds, linear layers

* **Round constants.** Vendor `ROUND_CONSTANTS` are values 0..7 (`permutation.rs:185-190`), so their flat images
  are XORs of φ(1) = 1, φ(2) = `0x3d5b…10ed` and φ(4) = `0xa72e…412f`. Hence φ(3) = `…10ec`,
  φ(5) = `…412e`, φ(6) = `0x9a75…51c2`, φ(7) = `…51c3`. All 264 were checked:
  * by hand for rounds 0-3 and 62-65 (all lanes) and for partial rounds 4-61 (lane 0);
  * by machine, parsing every `sbox(xor(lane, K))` line of `:562-784` and comparing it with φ(RC[i][r]).

  The schedule has 157 steps: 1 initial `mdsFull`; 4 full rounds (4 S-boxes + `mdsFull`); 58 partial rounds
  (S-box on lane 0 + `mdsPartial`); 4 full rounds. 0 mismatches. This matches vendor `permute_flat_u128`
  (`permutation.rs:68-90`): AddRC → S-box → linear, full when `r < 4 || r ≥ 62`.
* **S-box** (`:532-535`): x·x² = x³, times (x²)² = x⁴, gives x⁷. Same as `permutation.rs:177-182`.
* **`mdsFull`** (`:539-549`). Vendor `MDS_FULL` is `[[5,7,1,3],[4,6,1,1],[1,3,5,7],[1,1,4,6]]`, with output i the
  sum over j of `M[i][j]·in[j]` (`permutation.rs:135-149`). Write T1 = φ(2), T2 = φ(4), s = a+b+c+d. By linearity
  φ(5) = 1+T2, φ(7) = 1+T1+T2, φ(3) = 1+T1, φ(6) = T1+T2. The rows become:
  * row 0 = s + T2(a+b) + T1(b+d)
  * row 1 = T2(a+b) + T1·b + c + d
  * row 2 = s + T1(b+d) + T2(c+d)
  * row 3 = a + b + T2(c+d) + T1·d

  With u = T2(a+b), v = T2(c+d), p = T1·b, q = T1·d, this is exactly `na, nb, nc, nd`. The constants are confirmed
  to be φ(4) and φ(2).
* **`mdsPartial`** (`:551-557`). Vendor `MDS_PARTIAL` is diag(0x20, 0x2000, 0x200, 0x800) with 1 everywhere else.
  So out_i = d_i·in_i + sum over j≠i of in_j = (d_i+1)·in_i + s. The constants are φ(d_i) XOR 1:
  * `…cf15` = φ(0x20)^1 (row 5)
  * `…5bbe` = φ(0x2000)^1 (row 13)
  * `…0831` = φ(0x200)^1 (row 9)
  * `…1a3d` = φ(0x800)^1 (row 11)

  Confirmed by hand and by machine.

### A.4 Sponge, IV, byte order, output

* **Vendor.** `derive_address` = `with_iv(capacity_iv(ADDRFIX_))` → state `[0, 0, L<<64, L]`. Then
  `absorb_pair(s_lo, s_hi)`, which XORs into the rate and permutes. Then `finalize_no_pad`, which takes lane0 LE ‖
  lane1 LE. Here `s_lo` = u128 LE of bytes 0..16 and `L` = u64 BE of `"ADDRFIX_"`. Sources: `primitives.rs:222-239,
  300-305`; `compression.rs:70-77, 115-123, 139-145, 198-216`; `domain.rs:27-40, 56`; `block128.rs:139-145`.
* **Prover.** It uses the identical state `[secret[0], secret[1], iv[0], iv[1]]` and compares lanes 0..1 with the
  public address (`wallet_authorization.rs:390-402`). The address comes from the opening through
  `Address::as_fields` (`primitives.rs:57-66`), with the same LE halves.
* **Yul** (`:49-53, 95-113`):
  * `bytes32` byte 0 is the most significant, so `w >> 128` is bytes 0..16 big-endian, and `_bswap128` gives the
    LE value. The four swap steps were checked mask by mask.
  * `IV_HI_FLAT` = φ(L<<64) and `IV_LO_FLAT` = φ(L): recomputed, equal. `ADDRFIX_LABEL` = `0x414444524649585F`
    = "ADDRFIX_": equal.
  * The two output lanes are converted back and byte-swapped into one `bytes32`, so byte 0 = A[0].
* The `derive` literals (`:89, 91`) are φ("noid-deri"), φ(0x80) and φ(1<<120): equal. They are unused by V2.

### A.5 Memory, stack, calldata, compiler

* The `addr` path uses only stack variables and Yul functions. It does not touch memory, the free-memory pointer,
  calldata or returndata, so a caller cannot violate any assumption.
* Only the test helper `permute(uint256[4] memory)` uses Solidity-managed memory.
* Assembly blocks are not marked `memory-safe`. That is harmless under the legacy pipeline that is pinned.
* `pragma ^0.8.24` floats, but the runtime code-hash pin fixes the exact build.

### A.6 Input classes the 12,299 vectors cannot exhaust

The argument in A.1-A.4 has no data-dependent case left:

* carries are bounded;
* `MUL` cannot wrap;
* table selection is exact;
* all operands are < 2^128.

As extra evidence, the transcription was compared with a bit-serial flat reference on 845 secrets: 0 mismatches.
The secrets were:

* zero and all-ones;
* all 256 single-bit secrets;
* all 256 "all-ones but one bit" secrets;
* `0xff`/`0x00` in bytes 0, 7, 8, 15, 16, 23, 24 and 31;
* the top bit of both lanes;
* each lane all-ones;
* lanes equal to φ⁻¹(1, 2, 4, 0x87, all-ones);
* `s = 35c1cecbc73c3c3f13b6b3b0b414141500000000000000000000000000000000`, constructed so that the first S-box input
  is zero;
* 300 random.

The tower reference on 72 of these also gave 0 mismatches.

## B. `HTLCPoseidonV2.sol` against `HTLC.sol`

* **Lock id, `newLock`, `refund`, `getLock`, events, guard.** Line-for-line the same as `HTLC.sol`, with
  `hashlock` renamed to `lockAddr` (`:119-160, 193-217` against `HTLC.sol:108-149, 177-201`). The id covers sender,
  receiver, amount, word and timelock. It has no chain id or contract address, which is fine: ids are storage keys,
  not signatures. Duplicates revert. `lockAddr = 0` is accepted, as in `HTLC.sol`; it is harmless because Bob takes
  the word from the opening.
* **Checks-effects-interactions.** `claimed` and `preimage` are written and the event is emitted before the call
  (`:180-189`). `refund` does the same (`:202-209`). The global `nonReentrant` (`:111-116`) blocks every re-entry.
  A paid hook that reads `getLock` sees final state.
* **Timelock.**
  * claim: `ts < timelock` (`:175`); refund: `ts ≥ timelock` (`:199`); `newLock`: `timelock > ts` (`:143`).
  * The windows are disjoint and exhaustive, as in `HTLC.sol`.
  * Checking the timelock before the hash changes only which error an expired wrong-secret call returns.
* **Exact calldata** (`:169`). The ABI decoder rejects < 68 bytes before the body runs; the body rejects > 68.
  Correct, but see V2-7: a failed attempt has still shown `s`, or 31 bytes of it.
* **Gas floor** (`:75, 176`). Post-check work on the dearest honest path, estimated from opcode prices:

  | Item | Gas |
  |---|---|
  | permutation | ≈ 428.7 k |
  | `claimed` (warm 0→1) | 20,000 |
  | `preimage` (cold 0→x) | 22,100 |
  | cold `amount`/`receiver` reads | 4,200 |
  | `LOG2` | ≈ 1.4 k |
  | `CALL`: cold account + value | 2,600 + 9,000 |
  | new account | 25,000 |
  | `_status` restore | 100 |
  | dispatch overhead | small |
  | **Total** | **≈ 512-515 k** |

  This agrees with the stated "at most about 510,000" and the measured lowest successful limit of 574,008 (34 k is
  spent before the check). The answers to the gas questions:
  * **Can a griefer make an honest claim fail after the check?** No. Post-check cost depends only on this lock's
    slots and on whether the receiver exists. A third party can only make the receiver exist, which is cheaper.
    Copying `s` and front-running pays Alice anyway, and her own transaction stops at `AlreadyClaimed`.
  * **Does the 63/64 rule matter?** Not for an EOA receiver: the call's base cost is charged to the caller, and an
    EOA consumes no forwarded gas. It matters only for an EIP-7702-delegated or contract receiver. With a
    650,000 limit about 120-130 k remains at the call, and the 1/64 retained is negligible.
  * **Can the check lock funds?** No. It is a lower bound only. Any gas limit of about 575 k or more passes, which
    is far below every block cap and the 2^24 per-transaction cap. `refund` has no such check.
  * **Is 540,000 safe?** For Cancun/Prague/Osaka pricing, yes, but the margin is about 5 %. A repricing that raises
    SSTORE-set or account-creation costs by more than about 25-30 k in total breaks the guarantee "passing the
    check means the claim finishes". The failure mode is a revert with `s` public and a resend. Recommendation:
    the tool uses a gas limit well above the floor, for example 1,000,000. Unused gas is not charged; only
    `limit × maxFee` must be in the balance. Re-measure on the target chain after any fork.
* **Preimage storage.** It is stored and emitted. With `s = 0`, `preimage` stays 0 (I-ETH-4); use `claimed`.
* **Contract receiver.** Unchanged from `HTLC.sol`: a rejecting or gas-burning receiver can only fail its own claim,
  with `s` revealed (F-ETH-2). The `getCode == 0x` gate is not durable under EIP-7702, but only the receiver's
  owner can change that.
* **Undocumented differences.** None in behaviour. See V2-11 for the two ABI-level differences.

## C. Generator

* `eth/scripts/poseidon/gen.js` derives every literal from `equiv/portable`. It asserts the MDS shapes the factored
  layer assumes (`gen.js:51-58`) and emits the three `gmul`/`gsqr` copies from one template.
* This review did not rely on the generator or the portable crate. A.2-A.4 compare the **generated file** directly
  with the vendor sources. So a portable-crate error that the generator faithfully copied would have been caught.
  None was found.

## D. Protocol claim: "no equivalence proof is needed"

**What Bob must check before locking ETH** (`poseidon-leg.md` 6 is sufficient with the additions marked +):

1. **Opening.** He rebuilds the NOID opening himself. Its root equals the funded, final Parano1d contract.
   `claim_authority = A`, `claim_recipient` = Bob, recovery = Alice, `deadline` = D, `max_fee` ≥ 5,800, and close-only
   modes. Not `refundable_payment`.
2. **Lock word.** The ETH `lockAddr` is exactly those 32 `claim_authority` bytes, in payload order (byte 0 most
   significant). They are taken from his own opening, never from Alice's message.
3. **Contract.** Pinned address, chain id, and the V2 runtime code hash.
4. **Freshness (T9).** `A` is unseen, `getSlotsByOwner(A)` is empty, and there is no earlier `Locked` with this word.
   + The log scan covers deployment → now and fails closed on any truncated range (V2-8).
5. **Timeouts.** The timeout and lock-by gates, unchanged.
6. **+ Client R.** It is installed and has produced a valid authorization for the current owner-authorization
   version on his machine. The stock import cannot claim this lock (V2-10).

**Can a malicious Alice make the NOID claim authority differ from `A`?**

* Not through the opening: Bob derives `A` from the opening whose root he checked. Any other opening has a
  different root. This rests on the root's collision resistance (Poseidon2b again, Q8) and on Q2, both unchanged.
* Not through the encoding:
  * `claim_authority`, `Address::as_fields` and the prover's public input are the same two LE halves.
  * The EVM word is the same 32 bytes.
  * A byte-reversal mistake by Bob would make the ETH lock unclaimable, so Bob refunds: fail-safe, not theft.
* Not through `Addr` itself: A.2 shows `EVM-Addr(s) = node-Addr(s) = prover-Addr(s)` for every `s`.
* Not through non-canonical encodings: none exist. Every 32-byte string is exactly one pair of GF(2^128) elements.
  The byte↔lane maps are bijections on both sides. There is no modular reduction, no range check and no alternative
  encoding of the same `s`.
* Through **secrets the prover rejects**: none in the code read. `SpendSecret::from_bytes` takes any 32 bytes, and
  `OwnerAuthWitness::new` stores the secret as is. `prove_selected_authorization` runs the total
  `evaluate_permutation` and compares lanes. `from_permutation_witness` checks only the row count.
  * The ZK proof built from the state table (`prove_zk_authorization_from_state_table_for_version`) was not read.
  * This was equally true of the SHA-256 design.
  * Close it with one harness test that proves and verifies a contract-controller authorization for `s = 00…00`,
    `s = ff…ff` and the zero-S-box secret from A.6 (V2-9).

Bottom line: the only way the EVM leg and the NOID leg could open for different secrets is a disagreement in `Addr`
or a prover that rejects some `s`. The first is excluded for all inputs. The second is excluded for the code read;
the edge-secret test closes the rest.

## Not checked

* The ZK authorization proof and its verifier circuit (constraint system, masking) for value-dependent failure
  (V2-9).
* The vendor SIMD kernels (`batch_avx2`, `batch_aarch64`, `permutation.rs:51-64`). They affect only the addresses
  the wallet displays and the generation of the vectors, not the prover's tower path. The vectors were produced on
  whichever path the generating machine used.
* solc 0.8.24's code generation. The Yul was reviewed as source; the bytecode was not. The 12,299 on-chain vector
  matches are the evidence for the bytecode.
* Gas on any real network, L2 or zkEVM; future fork repricings (V2-6).
* `swap-cli` / `live.js` integration (`poseidon-leg.md` 9): not implemented, so not reviewed.
* Q8 (Poseidon2b cryptanalysis) and Q2 (recipient binding in the block proof). These are unchanged by this leg.
* The test files and the fuzz harness were not re-run. Their numbers are quoted from `FUZZ.md` 8 and
  `poseidon-leg.md` 5.
