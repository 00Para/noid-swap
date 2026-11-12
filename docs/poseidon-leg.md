# The Ethereum leg locked on `Addr(s)`: protocol delta and integration spec

Status 2026-11-05. Contract: `eth/contracts/HTLCPoseidonV2.sol` (production candidate, replaces the prototype
`HTLCPoseidon.sol`). Evidence: `eth/test/poseidon-vectors.test.js`, `eth/test/HTLCPoseidonV2.test.js`,
`eth/test/fuzz.test.js` (campaign "HTLCPoseidonV2"), `eth/FUZZ.md` section 8. Background and the library:
`docs/poseidon-evm.md`; the independent review it answers: `docs/poseidon-evm-review.md`.

## 1. Bottom line

For an EVM pair the Ethereum lock can sit directly on Parano1d's address `A = Addr(s)`. Claiming on
Ethereum then proves knowledge of the same `s` that unlocks the NOID, with nothing in between: **the
equivalence proof (20 to 36 minutes of RISC Zero proving per swap, plus trusting the zkVM) is not needed on
an EVM leg.** The price is gas: a reveal costs 0.50 to 0.55 M gas on Hardhat (517,084 on mainnet in run 8, 689,324 on Sepolia in runs 5 and 11) instead of 89 k, and the swap now rests on
one claim that is easy to state and test: *the EVM computes the same `Addr` as the Parano1d node for every
32-byte secret*. That claim has been compared with the vendor crate on 12,299 vectors with 0 mismatches
(section 7). Bitcoin is not covered (Script has no Poseidon); a BTC leg still needs `sha256(s)` and the proof.

Plain words for the three ideas this rests on:

* **Hashlock.** A lock that opens for anyone who can show a secret whose fingerprint matches a value written
  into the lock. Before, the Ethereum fingerprint was `SHA-256(s)` and the Parano1d one was `Addr(s)`: two
  different fingerprints of one secret, so Bob needed a proof that both belong to the same `s`.
* **Equivalence proof.** That proof ("the `s` behind this SHA-256 value is the `s` behind this address"),
  made with a zero-knowledge virtual machine. It existed only because the two chains used different
  fingerprints.
* **Reveal.** Ethereum shows the secret in the `claim` transaction; Parano1d never shows it (its spends are
  proofs). So the NOID holder (Alice) always makes the secret and reveals it on Ethereum. Unchanged.

## 2. What replaces `H = sha256(s)` and why the proof disappears

| | v1 (`HTLC.sol`) | this document (`HTLCPoseidonV2.sol`) |
|---|---|---|
| ETH lock value | `H = SHA-256(s)` | `A = Addr(s)`, the 32 address bytes |
| ETH claim check | `sha256(preimage) == H` | `Poseidon2b.addr(preimage) == A` |
| What links the legs | proof `pi`: exists `s` with `sha256(s) = H` and `Addr(s) = A` | nothing to prove: both locks carry the same 32 bytes |
| Bob's check before locking | verify `pi` (image id, journal, receipt) | compare 32 bytes: the ETH lock word is the `claim_authority` of the opening he rebuilt |
| Tools needed | RISC Zero (`rzup`, `r0vm`), 20 to 36 min proving | none |

`A` is the payload of the `o1...` bech32m address, first byte as the most significant byte of the `bytes32`.
Example: `Addr(00 01 .. 1f) = f8183db204ffb765c7015d851c1754e4974c675b975c6738d9f6d138eb7212cf` =
`o1lqvrmvsyl7mkt3cptkz3c965ujt5ce6mjawxwwxe7mgn36mjzt8sn69xw2`.

Why this is sound: the Parano1d lock opens for a ZK proof of knowledge of an `s'` with `Addr(s') = A`; the
Ethereum lock opens for a preimage `s'` with `EVM-Addr(s') = A`. If `EVM-Addr = Addr` for every input, the two
conditions are the same condition, so whoever can open one can open the other with the same `s'`, and any `s'`
(not only Alice's own) works on both. The only way this fails is a 32-byte value on which the EVM and the node
disagree. Alice chooses `s`, so even one such value would let her take Bob's ETH while Bob could not claim the
NOID (review F7). That is why the evidence in section 7 is what the design stands on.

## 3. What stays the same, and what moves

Unchanged (design sections in brackets):

* Roles, order, who reveals: Alice makes `s`, locks NOID first with the longer timeout `D`, Bob locks ETH
  second, Alice claims ETH (reveal), Bob claims NOID from the revealed `s` (sections 1, 2.2).
* Every timeout inequality and number (section 4): `W_A = 7,200 s`, `M_A = 1,800 s`,
  `D = creation + 725` blocks, Bob's lock-by `D - 619`, `B_post = 252` blocks. Block time and finality of both
  chains are the same; the claim is just a bigger transaction. The windows of `HTLCPoseidonV2` are identical
  to `HTLC.sol` (claim while `timestamp < timelock`, refund when `timestamp >= timelock`).
* The Parano1d contract (`htlc.pruv`, `htlc_v2.pruv`), its opening, Bob's rebuild-byte-for-byte check, the
  `max_fee >= 5,800` rule, the 279,370 activation rule, the `Addr(s)` raw secret, throwaway secrets.
* Lock id `keccak256(sender, receiver, amount, lockAddr, timelock)`; fixed receiver; EOA-only receiver and
  sender; re-entrancy guard; first-lock-wins duplicate refusal; the preimage is public once claimed.
* Event shapes and function selectors: `Locked(bytes32,address,address,uint256,bytes32,uint256)`,
  `Claimed(bytes32,bytes32)`, `Refunded(bytes32)`, `newLock(bytes32,uint256,address)`, `claim(bytes32,bytes32)`,
  `refund(bytes32)`, `getLock(bytes32)` are byte-identical to `HTLC.sol`'s (the `bytes32` that was `hashlock` is
  now `lockAddr`). **A watcher therefore cannot tell the two contracts apart by shape; only the pinned address and
  the runtime code hash tell them apart (review F8 note).**

Moves, by threat-model row (design section 8):

| Row | Change |
|---|---|
| T10 equivalence proof | **Gone on an EVM leg.** Replaced by "EVM `Addr` equals the node's `Addr` for every input" (section 7) |
| T8 Poseidon2b margin | Substance unchanged: the ETH lock is as strong as `Addr` is preimage resistant, which every NOID address already needs (review F10). SHA-256 was never a second line for the swap |
| T9 secret reuse | The local database stores `A` (the lock word), not `H`. The ETH side now also exposes `A` in `Locked` from Bob's lock onward |
| T11 receiver rejects ETH / under-gassed claim | A claim that runs out of gas or reverts with `InsufficientGas` still published `s` in its calldata (the lock stays claimable; resend). New: send claims with an explicit gas limit of 650,000, simulate on one's own node only |
| T17 wrong contract | The pin must be the V2 code hash below, never `HTLC_CODE_HASH`. Same ABI shape, so a wrong pin is not caught by the ABI |
| T19 linkability | Earlier and wider: `A` is visible on Ethereum at Bob's lock, also for swaps that are later refunded |
| T3 late reveal | Same cutoff; the reveal is 6 times the gas, so the fee cap matters more (section 5) |

## 4. Raw variant only

The stock-wallet variant locks on `Addr(Derive(m, 0))` and reveals the master secret `m`, so the Ethereum side
would have to compute `Derive` (three more permutations, about 1.7 M gas per claim) before `Addr`. `Poseidon2b.sol`
contains that code (`addrStock`, tested), but `HTLCPoseidonV2` checks `Addr(preimage)` only and the stock variant
is not offered on this leg. A stock-wallet address can still be used in a poseidon swap by treating
`d = Derive(m, 0)` as the raw secret (lock on `Addr(d)`, reveal `d`); that is the raw variant with `s = d`, and
needs Bob's raw client (R), not the stock import path. Not recommended: `d` is a spend secret of a real wallet
address, so a throwaway `m` is required anyway.

## 5. Gas and cost

Measured on Hardhat (solc 0.8.24, optimizer 200, `cancun`; `test/HTLCPoseidonV2.test.js`, receipts):

| Call | Gas |
|---|---|
| `Poseidon2b.addr` alone (pure execution) | 428,747 |
| `claim`, cheapest honest case (all-zero secret, funded EOA receiver) | **499,288** |
| `claim`, dearest honest case (all-0xff secret, receiver account never funded: +25,000 new-account) | **544,584** |
| `claim` to an EOA receiver over 2,000 random fuzz sequences (126 claims, some sent through a contract caller) | 534,737 mean, 549,139 max |
| `claim` with a hostile contract receiver (not allowed by the tool) | up to 741,522 |
| `claim` that fails `TimelockExpired` (checked before the permutation) | under 80,000 |
| `InsufficientGas` revert (below the floor) | no permutation runs; costs only the intrinsic and cold-read gas (about 34,000, the gap between the floor and the lowest successful limit) |
| `newLock` | 144,153 |
| `refund` | 61,332 |
| deployment | 3,383,073 (15,300 bytes, limit 24,576) |
| for comparison: `HTLC.claim` (SHA-256) | 88,926 |

Gas limit rules the contract publishes as constants: `MIN_CLAIM_GAS = 540,000` (gas that must still be left when
`claim` reaches the permutation; the work after the check needs at most about 510,000) and
`RECOMMENDED_CLAIM_GAS_LIMIT = 650,000` (floor plus about 34,000 of intrinsic cost, calldata and cold reads, plus
margin). Live figures differ from Hardhat's: a claim used 517,084 gas on mainnet (run 8) and 689,324 on Sepolia (runs 5 and 11), a lock 144,129 on mainnet and 583,841 on Sepolia (`docs/live-run-11.md`, finding 2). A test finds the lowest gas limit at which a claim succeeds (574,008 in the worst case) and shows that
every smaller limit fails with the named `InsufficientGas`, never with an out-of-gas in the middle. Re-measure the
floor after any fork that reprices storage or account creation.

Cost in USD (ETH = 3,000 USD, price x gas x 10^-9 x 3,000):

| Gas price | cheapest claim (499,288) | dearest claim (544,584) | SHA-256 claim (88,926) | ETH for the dearest claim |
|---|---|---|---|---|
| 1 gwei | 1.50 | 1.63 | 0.27 | 0.00054 |
| 5 gwei | 7.49 | 8.17 | 1.33 | 0.0027 |
| 10 gwei | 14.98 | 16.34 | 2.67 | 0.0054 |

Consequences:

* The reveal fee falls on Alice (she is the claimer on Ethereum). Bob's NOID claim is unchanged. The ETH amount
  must make this small: for the fee to be at most 1 % of the ETH leg, the ETH amount must be at least 0.055 ETH at
  1 gwei and 0.55 ETH at 10 gwei. At the 0.001 ETH trial size the claim costs 50 to 54 % of the swap at 1 gwei: use a
  testnet or an L2 for small swaps. On an EVM-equivalent rollup the execution gas price is cents-scale; zkEVM
  trace limits for ~11,000 `MUL` operations are untested (review F8.3).
* Alice's wallet must hold `gasLimit x maxFeePerGas` at the time of the reveal (650,000 x 20 gwei = 0.013 ETH).
  Bob's "gas money" transfer to Alice (README, live runs) must be sized for that, not for 89 k.
* `M_A = 1,800 s` stays; the fee cap rule `cap >= 2 x base fee` stays (a stuck reveal with `s` visible is T3).

## 6. What each side must verify

**Bob, before locking ETH** (replaces "verify `pi`", design 2.2 step 5; everything else in 5 to 8 stays):

1. The contract address is the one Bob pinned himself, `eth_chainId` is his pinned chain, and
   `keccak256(eth_getCode(address))` equals the V2 code hash (section 8.4). Not a value from Alice's message.
2. The 32 bytes he will pass as `lockAddr` are the `claim_authority` bytes of the opening he rebuilt byte for
   byte (design 6.3), in bech32m payload order (first byte most significant). Not `A` from Alice's message.
3. T9: that `A` has never been seen (local database of lock words) and `getSlotsByOwner(A)` on Parano1d is empty.
   Also scan the Ethereum contract's `Locked` logs for any lock with this `lockAddr`.
4. Funding, finality, lock-by height and the timeout gates of design 2.2 steps 7 and 8, unchanged.
5. Both ETH addresses have no code (EOA only), as in v1.

**Alice, before revealing** (replaces the SHA-256 check in step 9/10):

1. Same pins (address, chain id, code hash).
2. `getLock(lockId)`: sender, receiver (her own EOA), amount, `timelock`, `lockAddr == Addr(s)` computed **locally**
   with the reference crate or `eth/scripts/poseidon/poseidon2b.js`, neither claimed nor refunded, the `Locked`
   block finalized.
3. `now <= timelock - M_A`.
4. The balance covers `650,000 x maxFeePerGas`; `maxFeePerGas >= 2 x base fee`.
5. **Never send `s` to a remote node before the reveal itself**: no `eth_call`, no `eth_estimateGas`, no
   simulation on a public RPC (whoever sees `s` can close the NOID lock to Bob and Bob can then keep both, design
   section 1). Simulate on a node Alice runs herself, or not at all. The contract has no `addrOf` for this reason.
6. Send `claim(lockId, s)` with `gasLimit = 650,000` (explicit, never estimated) as exactly 68 bytes of calldata.

## 7. Evidence

All of it is re-runnable; commands in `eth/README.md`.

| Evidence | Result |
|---|---|
| Vendor vectors: `eth/test/vectors/addr-vectors.bin`, 12,299 vectors (299 structured incl. all 256 single-bit secrets, the all-zero and all-ones secrets and the published `00 01 .. 1f`; 12,000 seeded random), `Addr` computed by the vendor crate `noid_poseidon2b::primitives::derive_address` (`equiv-ref addr-vectors`), file SHA-256 `09c22287e0fbb205681b0de59fe0282240fa8f09737aebb1ff6e9d76e4a673da` | EVM contract: **12,299 / 12,299 equal, 0 mismatches** (full run in four slices); JavaScript port: 12,299 / 12,299 equal. Default test: 599 vectors (all structured + 300 random), 0 mismatches, 20 s |
| Hand proof of the arithmetic, round structure and byte order (review F1 to F4) | CONFIRMED for every input; no mismatching input found |
| Generator: `Poseidon2b.sol` regenerates byte-identically from the Rust spec | test in `Poseidon2b.test.js` |
| `HTLCPoseidonV2` unit tests with lock addresses taken from the vendor file | 15 tests |
| Fuzz campaign (reference model, `Addr` from the JS port which the vector test ties to the vendor) | default 200 sequences; one run of 2,000 sequences (46,730 transactions, 609 re-entry attempts, 0 successful): all invariants hold |
| Mutants (10 planted bugs: claim at `timelock`, refund gap, refund by anyone, pay before effects, id without timelock, double claim, no timelock check, trailing calldata accepted, SHA-256 instead of `Addr`, stored preimage differs from the event) | all 10 caught within the first 12 sequences |

Not covered by the vectors: `Derive` (the stock variant, unused by V2). Not done: a second independent review of
the Yul (review must-do 4; this document's contract is small, the library is the load-bearing part), an
independent symbolic check of `gmul`, and Q8 (cryptanalysis of Poseidon2b) which applies to all of Parano1d.

## 8. `HTLCPoseidonV2` against `HTLC.sol`, and the pin

### 8.1 What is identical

State machine, struct layout (`lockAddr` where `hashlock` was), lock id, `newLock` checks and their order,
`refund`, `getLock`, events, the re-entrancy guard, checks-effects-interactions, the payout by low-level call to
the fixed receiver (so an EOA-only receiver, a receiver that rejects ETH and the sender hazard behave exactly as in
`HTLC.sol`; the same fuzz actors are used).

### 8.2 What differs (deliberate)

1. No function computes `Addr` (`addrOf` of the prototype is gone; a test checks the ABI and that the selectors
   of `addrOf`, `addr`, `derive`, `addrStock` and `permute` are not in the deployed code).
2. `claim` checks `msg.data.length == 68` first: the secret is exactly 32 bytes; a trailing byte reverts
   `BadCalldataLength` (HTLC.sol ignores it). A short secret still fails in the ABI decoder, as before.
3. `claim` checks the timelock before the permutation (HTLC.sol checks the hash first). Error priority in `claim`:
   `BadCalldataLength`, `LockNotFound`, `AlreadyClaimed`, `AlreadyRefunded`, `TimelockExpired`, `InsufficientGas`,
   `InvalidPreimage`, `TransferFailed`.
4. `claim` reverts `InsufficientGas` if less than `MIN_CLAIM_GAS` is left when it reaches the permutation. This
   does not stop the secret from being published by an under-gassed attempt; it makes the failure early and named.
5. Public constants `MIN_CLAIM_GAS` and `RECOMMENDED_CLAIM_GAS_LIMIT`.

### 8.3 Error set

`HTLC.sol`'s thirteen errors plus `BadCalldataLength` and `InsufficientGas`.

### 8.4 The pin (print it, compare it, never type it)

* Runtime code hash: **`0xf510d2a368c730339fa7cf5e023bcf2429d5732793f043e03025780bb7043ff3`**
  (`keccak256` of the artifact's `deployedBytecode`, 15,300 bytes; the contract has no immutables, so this is the
  code `eth_getCode` returns).
* Build: solc 0.8.24, optimizer enabled with 200 runs, EVM version `cancun`, Hardhat legacy pipeline,
  `eth/hardhat.config.js`. The same build reproduces `HTLC_CODE_HASH` (`0xa906117f...e2f`) exactly.
* The metadata hash is part of the code, so any change to `HTLCPoseidonV2.sol`, to `Poseidon2b.sol` (it is
  imported) or to a compiler setting changes the hash. The hash is pinned in `eth/test/HTLCPoseidonV2.test.js`
  (`PINNED_CODE_HASH`); change it there, here and in the swap tool together, after review.

## 9. Integration spec for `swap-cli` and `eth/scripts/live.js`

**Implemented 2026-11-05.** The text below is the spec as written; "What differs from the spec" at the end of this section lists every place the
code does something else and why. Where it lives: `swap-cli/README.md` ("Ethereum lock kinds"), `eth/README.md` ("The poseidon lock kind in `live.js`"),
`swap-cli/tests/poseidon_kind.rs`, `swap-cli/tests/poseidon_cli.rs`, `eth/test/live-poseidon.test.js`, `parano1d/harness/tests/edge_secrets.rs`.
The review rules it implements: V2-6 (claim gas), V2-7 (calldata), V2-8 (full-log scan, fail closed), V2-9 (edge secrets in the prover), V2-10 (client R gate).

### 9.1 A new lock kind

* `EthParams` (`swap-cli/src/swapfile.rs`) gets `lock_kind`: `"sha256"` (default, not written, so every existing
  file keeps its digest) or `"poseidon"` (written). It is part of the digested public section, so changing or
  dropping it breaks the digest like `contract_version` does.
* `lock_kind = "poseidon"` requires `variant = raw` (stock is refused, section 4), a pinned `contract` that Bob chose,
  and `code_hash == params::HTLC_POSEIDON_V2_CODE_HASH` (new constant, section 8.4; a unit test compares it with
  `eth/artifacts/contracts/HTLCPoseidonV2.sol/HTLCPoseidonV2.json`, as `htlc_code_hash_is_the_local_artifacts_runtime_code_hash`
  does for `HTLC_CODE_HASH`). `HTLC_CODE_HASH` is refused for a poseidon file and the reverse.
* `SwapPublic.hashlock` keeps its JSON key and its 32 bytes, now meaning "the ETH lock word". Under `poseidon`
  it **must equal** the 32 bytes decoded from `claim_authority` (checked in `SwapPublic::check`, and re-checked
  by Bob against the rebuilt opening). Keeping the key keeps the T9 database, `--swap` binding and the watchers
  working; the new `lock_kind` says what the word is.
* `Secret::hashlock()` becomes `Secret::lock_word(kind)`: `sha256(s)` or `Addr(s)`. `swapfile` secret binding
  (`SecretMismatch`) and `secret::check_preimage` compare against the right one: for poseidon,
  `Addr(preimage) == lock word == claim_authority` (the old `HashlockMismatch` step is the same comparison).

### 9.2 Checks that drop the receipt

* `EquivalenceAttestation` and `Bob's file has no equivalence attestation` (`swapfile.rs` 783 to 901, 1336 ff.):
  for `poseidon` the attestation must be **absent** (a present one is refused, so a file cannot claim a proof it
  does not need), `check` does not demand `receipt_path`, `receipt_sha256`, `verified_at` or the image id.
* `new-bob --receipt P --equiv-prove BIN` and `src/equiv.rs`: refused together with `--lock-kind poseidon`.
  `params::EQUIV_IMAGE_ID`, `child_env`'s prover spawn and the "receipt-only attestation outside rehearsal" rule are
  not consulted. Alice does not run the prover (saves 20 to 36 minutes and the RISC Zero toolchain).
* The engine gate "Bob may lock" (engine.rs around 596 to 700) loses "equivalence attested" and gains: lock word ==
  `claim_authority` bytes of the rebuilt opening; lock word never seen before (T9, database keyed by the word);
  no existing `Locked` log with this `lockAddr` on the pinned contract; `eth.contract_code_hash` equals the V2 pin.

### 9.3 Code-hash gates

Every place that compares the node's code hash with `p.code_hash` (engine.rs 168 to 172, 596 to 614, 679 to 682,
850 to 853, and the second-node check F5) already compares with the file's pinned value; the only change is that
the file's value is validated against the constant of its `lock_kind`. `eth_code_hash_flag` in `main.rs` (which
defaults to and insists on `HTLC_CODE_HASH`) becomes kind-aware: `--lock-kind poseidon` selects
`HTLC_POSEIDON_V2_CODE_HASH`.

### 9.4 Watchers (`swap-cli/src/watch/eth.rs`)

* `Locked` decoding (96 data bytes: amount, lock word, timelock), `getLock` decoding (8 static words, word 3 is the
  lock word), `compute_lock_id`, topics and selectors: **no change** (section 3).
* Every `sha256(preimage) == hashlock` becomes "lock word of the preimage": `eth.rs` 492 and 500 (stored preimage
  of a claimed lock), 556 (`find_pending_claim`, a pending `claim(lockId, preimage)` in the mempool) and the
  discovery rule at 296 to 340 (`Locked` filter on sender and receiver, then word 1 == lock word; unchanged
  shape). The poseidon lock word of a preimage is `Addr(preimage)` through the vendor crate `swap-cli` already links
  for client R (`htlc_harness::addr`).
* `find_pending_claim`: a pending claim counts as a usable reveal only if calldata is exactly 68 bytes and
  `Addr(preimage) == lock word`. A claim with a longer tail, or one that later reverts (`InsufficientGas`,
  `BadCalldataLength`), has still shown `s`: record `secret_may_be_public` and, for Bob, claim the NOID from that `s`.
* New revert names to classify (`TimelockExpired` can now come before `InvalidPreimage` for an expired lock;
  `BadCalldataLength` and `InsufficientGas` are new): all three mean "the reveal did not happen, `s` may be public".
* The reveal detection needs no other change: `Claimed(lockId, preimage)` or `getLock(lockId).preimage` after
  `claimed == true`.

### 9.5 Alice's reveal in the engine

* Fee policy: gas limit **650,000 fixed** (read `RECOMMENDED_CLAIM_GAS_LIMIT` from the pinned contract and require
  it to be 650,000 or more, `MIN_CLAIM_GAS` to be at most 540,000), cap `>= 2 x base fee`, balance check on
  `gasLimit x cap` instead of the 89 k figure. Profile caps (20 NOID / 0.01 ETH) are unaffected.
* No gas estimation and no simulation of the real claim on any node that is not Alice's own: the secret must not
  reach a remote RPC before the reveal (section 6, item 5). `reveal_eth` intents keep their frozen cutoff.
* `M_A`, `W_A`, `T_reveal - DE`: unchanged.

### 9.6 `eth/scripts/live.js`

* Contract selection by lock kind: `ARTIFACT_PATH` (line 78) and `artifactCodeHash()` (105) pick
  `HTLCPoseidonV2.json` for `--lock-kind poseidon` or when `--swap FILE` says `lock_kind: "poseidon"`; the file's
  `code_hash` must equal that artifact's hash (lines 617 to 622). `deploy` deploys the V2 artifact (3.38 M gas) and
  `matchesArtifact` compares with it.
* `lock`: `--lock-addr 0x...` replaces `--hashlock` (the latter kept for the sha256 kind); the duplicate scan reads
  `args.lockAddr` instead of `args.hashlock` (lines 846, 1017); `--swap` binding compares the file's `hashlock`
  with the on-chain `lockAddr` (lines 572, 654).
* `claim`: replace `ethers.sha256(secret) === l.hashlock` (line 971) by a **local** `Addr(secret)` comparison with
  `scripts/poseidon/poseidon2b.js` (11 ms), set `gasLimit` to 650,000, skip `estimateGas` entirely (the current
  `--dry-run` with a piped secret sends it to the RPC; for this kind the dry run must refuse a secret on stdin
  against a non-loopback RPC), pad the funds check to `gasLimit x cap`. `--replace` re-sends with the same limit.
* `status`: `preimageMatchesHashlock` (line 1184) becomes a local `Addr` comparison; output keeps the key `hashlock`
  and adds `lockKind`.
* `test/live.test.js`: add the kind to the existing refusal tests (wrong code hash, wrong chain, secret that does
  not match, 31/33-byte secret), and a test that no RPC call carries the secret before the claim transaction.

### 9.7 Design document updates this implies

Section 2.2 steps 2, 3, 5, 9 (2 and 5), 10, 11; section 5 (note: EVM legs skip it); section 8 rows T8, T9, T10, T11,
T17, T19; section 9.1 (gas money, minimum amount); section 10 M2 (stock variant open for sha256 only). Not edited here.

### 9.8 What differs from the spec (implemented 2026-11-05)

1. **Gas limit 1,000,000, not 650,000** (9.5, 9.6): review V2-6 recommends a limit well above the floor, and unused gas is not charged. Only
   `limit × fee cap` must be in Alice's balance (0.02 ETH at 20 gwei). `live.js` also reads `MIN_CLAIM_GAS` and `RECOMMENDED_CLAIM_GAS_LIMIT` from the pinned
   contract and refuses unless the floor is at most 540,000 and the recommendation is between 650,000 and its own limit. The gas limit is `live.js`'s
   (`POSEIDON_CLAIM_GAS_LIMIT`); `swap-cli` has no gas figure and no balance check (it never sends an Ethereum transaction). The funds check in `swap-cli` that
   9.5 mentions does not exist; it is `live.js`'s `requireFundsFor`.
2. **`hashlock` keeps its JSON key and its name in Rust** (`SwapPublic.hashlock`, `Action::LockEth { hashlock }`, `EthLock.hashlock`, the intent's `params.hashlock`) as the
   spec says; `Secret::hashlock()` stays as it is and `Secret::lock_word(kind)` is new, instead of renaming the first. `check_preimage` keeps its signature (sha256);
   `check_preimage_for(kind, …)` is the kind-aware one the engine and client R use.
3. **The discovery rule** (9.4) is one `eth_getLogs` with topic0 = `Locked` only (no sender or receiver topic) for the poseidon kind, filtered in the watcher,
   so the same call also yields `EthObservation.word_locks` (every lock on the word, by anyone). Fail-closed on truncation is implemented as: a node error; a
   result of exactly 1,000 / 5,000 / 10,000 / 20,000 logs (the usual provider caps, `watch::eth::SUSPECT_LOG_CAPS`); or a lock the targeted query finds that the
   scan does not list. A node that truncates to some other size, and hides only an earlier lock, cannot be detected from the answer; the stored from-block
   (the deployment block) bounds the risk, and `--eth-from-block` is mandatory on a public chain for every kind.
4. **The over-long pending claim** (9.4, "record `secret_may_be_public`"): there is no such field. A pending `claim` with calldata longer than 68 bytes whose first
   68 bytes carry a preimage with `Addr(x) == A` is reported as `EthObservation.overlong_claim`; the engine reads it as a preimage candidate for Bob (so he claims the
   NOID) and never as Alice's reveal. Alice's `secret_may_be_public` is still derived from her own file history (`reveal_submitted`, …), unchanged. The revert names
   (`BadCalldataLength`, `InsufficientGas`, `TimelockExpired`) are not classified in Rust at all (the engine reads chain facts, not revert names); `live.js` decodes them.
5. **Bob's gate also needs client R** (review V2-10, not in the original 9.2): `swap-cli self-test FILE` and `new-bob` (poseidon kind) prove and verify a throwaway
   authorization with client R and record it in Bob's file (`client_r_selftest`, not part of the digested public section); the engine does not offer `lock_eth`
   without a record for the owner-authorization version of tip + 1. The gate is evaluated after the timing gates, so a Bob who cannot lock still aborts when the
   last lock height has passed.
6. **"No earlier lock" blocks any earlier lock on the word, including one by Bob's own address with other terms** (the sha256 kind lets those through): under the
   poseidon kind the word is the NOID address, so any earlier use of it is a T9 hit. Two existing tests branch on the kind for that reason.
7. **`live.js lock` refuses a foreign lock on the address** for the poseidon kind (it only reports it for sha256), as the swap tool does.
8. **`live.js claim --dry-run` with the secret** never sends it (nothing is simulated); it is refused against a non-loopback `ETH_RPC_URL` anyway, as 9.6 asks, because a
   dry run has no use for the secret there. In-process callers (the tests) are not subject to the URL rule.
9. **Stock variant** is refused where the spec says (`new-alice`, `SwapPublic::check`, `check_bob_terms`); the `secret` command prints a poseidon note instead of the `equiv-prove` pipe.
    **REVIEW-6 supersedes items 3, 6, 7 and 8** (`swap-cli/REVIEW-6.md`, `swap-cli/README.md` "What REVIEW-6 changed"): the swap's own locks are found by the indexed
    sender/receiver topics as for sha256 (3); the all-`Locked` scan runs only while Bob is deciding to lock, and its failure is a `WordScan::Failed` state that holds
    `lock_eth`, never a failed poll (3); "no earlier lock" blocks only a lock of Bob's OWN sender, locks of others are reported (6, 7: `live.js lock` the same); the sha256
    claim is also sent with a fixed 200,000 gas limit and never estimated, and a dry run with the secret is refused against a non-loopback node for both kinds (8).
    **REVIEW-7 supersedes item 3 again** (`swap-cli/README.md` "What REVIEW-7 changed", R7-1): the pre-lock check is no longer a scan of every `Locked` log; the node is asked
    for the `Locked` logs of Bob's own sender (indexed topic2) and the word is compared locally, so the exact-provider-cap-size rule (`SUSPECT_LOG_CAPS`) is gone.
10. **Not done:** design `docs/protocol-design.md` 9.7 updates (sections 2.2, 5, 8, 9.1, 10); a live run of the poseidon kind (nothing was sent anywhere); the second
    independent Yul review (review must-do 4) and Q8 are unchanged.

## 10. Residual risks

* Implementation equality is evidence (12,299 vendor vectors, hand proof, generator, fuzz), not a machine-checked
  proof, and the Yul has had one reviewer. A second independent Yul review and a symbolic check of `gmul` are open.
* Whether `noid_gkr` can authorize for every 32-byte `s` (for example the all-zero secret) was not checked here;
  an `s` the EVM accepts and the prover refuses would be the same attack (review F7, "related").
* Gas is Hardhat's. Real networks, rollups and zkEVM limits are untested; the floor must be re-measured after gas
  repricing forks. At small swap sizes the fee dominates on L1 (section 5).
* Q8 (Poseidon2b with unusually small round constants) needs a cryptographer; it is systemic to Parano1d.
