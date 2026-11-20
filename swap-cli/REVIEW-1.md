# swap-cli review 1 (independent, adversarial, read-only)

Reviewed 2026-11-04 against `docs/protocol-design.md` sections 0, 2.2-2.5, 4.1-4.3, 6.3, 7, 8 and 9.1, the M0 harness (`parano1d/harness/src/lib.rs`), `eth/contracts/HTLC.sol` and the vendored node at `d29b801`. I ran nothing and contacted no network. `src/state.rs`, `tests/scenarios.rs`, `tests/resume.rs` and `tests/cli.rs` changed on disk while I was reading (the new `SecretSeen.attempts` field). The line numbers below are from the versions on disk at that time.

**Summary.** `params.rs` is right. Every section 9.1 number and every formula I re-derived matches the design and the vendored epoch-anchor code: B_post = 242, RHS(I1) = 619 (529 for W_A_min), T_max, (I2), (I4), (I5), the 279,388 start, F_max at creation, the anchor height `((c-1)/144)*144`, and the 4-block T6 guard. Inside one tick, `decide` applies those gates correctly. Alice is never told to reveal outside (I2) or before Bob's lock is final. Bob never refunds ETH before `T_reveal`. Alice never refunds NOID before `D` or after a reveal. The problems are around the gates, not in them:
- **Bob's bundle check trusts Alice for Bob's own terms.** It rebuilds the opening only from values Alice supplied, so a self-consistent bundle that pays Alice passes. No equivalence proof π is carried or verified.
- **A pending action whose outcome is unknown is retried blindly or dropped.** That can double-fund the NOID lock. It can also leave Bob `aborted` while his ETH lock is still in flight, or let him send a second lock with a different `T_reveal`. Each case loses one side's full amount.
- **Bob's refund phase ignores a revealed secret.**
- **Bob never checks the `F_max` lower bound, and an unchecked multiply lets a crafted bundle bypass the 1 % upper bound in a release build.**
- **The pinned ETH code hash is never checked.**
- **The CLI points the ETH watcher at lock id `0x00…00`, so as wired neither party can ever see Bob's lock.**

The simulator hides most of these: it keeps one lock and one pending funding, and it hands observations straight to the engine. So several tests show less than their names say. Verdict: the gates (`params.rs`) are sound; the engine, the bundle check and the wiring need the fixes below before M2.7.

Findings: 4 critical, 4 high, 8 medium, 8 low, 5 nit.

---

## Verdict table

| # | Claim | Verdict | Where I looked |
|---|---|---|---|
| 1 | `B_POST = 144+60+18+20 = 242` | CONFIRMED | params.rs:26-34; design 4.1 last line, 9.1 |
| 2 | RHS(I1) for W_A = ceil(7,540/20)+242 = 619; for W_A_min = 287+242 = 529 | CONFIRMED | params.rs:161-163, 384-385; design 4.3 items 4-5, 9.1 |
| 3 | lock-by = D − 619 is the gate Bob applies before locking | UNSURE (design is ambiguous) | `choose_t_reveal` gates at D − 529 (params.rs:215), `Received` at D − 619 (engine.rs:429). Design 4.2/4.3 item 5 allow D − 529 with a shrunk window; 2.2 step 7 + 9.1 say "lock-by = D − 619". Safe under (I1) either way. Finding M4 |
| 4 | T_max = t_now + (D − h − B_post)·20 − 300 − 40 | CONFIRMED | params.rs:194-205. ceil(x) ≤ k ⇔ x ≤ k for integer k; 4.3 example gives t_b + 8,520 |
| 5 | T_reveal = min(t_now + W_A, T_max), refused below W_A_min, re-checked with (I1) | CONFIRMED | params.rs:209-230; design 2.2 step 8 |
| 6 | (I2): reveal only if lock finalized and now ≤ T_reveal − M_A (equality allowed) | CONFIRMED | params.rs:241-250, engine.rs:327-339; design 2.2 step 10, 4.2 |
| 7 | (I4): OnTarget ⇔ h ≤ D − 18, TooLate ⇔ h ≥ D | CONFIRMED | params.rs:275-283 |
| 8 | Finality `tip ≥ h + 17`; Alice's refund at `tip + 1 ≥ D` | CONFIRMED | params.rs:286-298 |
| 9 | (I5) window `[H_create, D + B_post]`, start ≥ 279,388 | CONFIRMED | params.rs:304-314; design 4.2 (I5), 9.1 "Fork rule" |
| 10 | F_max = max(50,000, 3 × est), ≤ 1 % V, at creation | CONFIRMED | params.rs:329-340, swapfile.rs:172 |
| 11 | Bob enforces the F_max range (6.3 item 6) | REFUTED | swapfile.rs:253 checks only the upper bound, unchecked; no lower bound anywhere on Bob's side. Finding H2 |
| 12 | Epoch anchor height `((c−1)/144)·144` | CONFIRMED | params.rs:346-351 vs `vendor/parano1d/noid_chain/src/consensus/epoch_anchor.rs` `tx_epoch_anchor_height_for_child` |
| 13 | T6 guard = ceil(20/20)+3 = 4 last blocks of an epoch | CONFIRMED | params.rs:70, 355-375; children k·144−3 … k·144 wait |
| 14 | Alice is never told to reveal when (I2) fails or Bob's lock is not final | CONFIRMED | engine.rs:254, 327-339; retries re-decide (engine.rs:705-708) so they are re-gated |
| 15 | Bob never locks when (I1) fails, a pending call exists, the amount differs, or past lock-by | CONFIRMED within one tick | engine.rs:437-466. Unknown observations pass (finding M2); "lock-by" is D − 529 (M4) |
| 16 | Bob never refunds ETH before `T_reveal` | CONFIRMED | engine.rs:470 uses `latest_timestamp ≥ T_reveal`; HTLC.sol:183 also enforces it |
| 17 | Alice never refunds NOID before D or after revealing | CONFIRMED | engine.rs:313-339; state.rs has no refund transition from `reveal_submitted`/`revealed` |
| 18 | A restart cannot cause a second lock with a different `T_reveal` | REFUTED | engine.rs:614-630 + 683-704. Finding C3 |
| 19 | A restart or retry cannot fund the NOID lock twice | REFUTED | engine.rs:705-708 retries `fund_noid` blindly. Finding C4 |
| 20 | The fact-derivation loop terminates | CONFIRMED | engine.rs:183, hard bound of 16; no derivation cycle exists in the tables |
| 21 | `eth_now = max(now, latest_ts)` is conservative for every gate | REFUTED for Bob's (I1) | right for Alice (cutoff, step-9 check 5); wrong direction for Bob's (I1) at engine.rs:452, 688. Finding L1 |
| 22 | No transition moves a terminal state; no role can take the other role's step | CONFIRMED | state.rs `alice()`/`bob()`; `load` checks phase role = file role (swapfile.rs:503) |
| 23 | The eviction transitions lose no information unsafely | CONFIRMED (information loss only) | state.rs:382, 450. Nit N4 |
| 24 | Bob's `check()` implements design 6.3 items 1-8 | REFUTED | swapfile.rs:210-260; main.rs:165-179. Findings C1, C2, H2, M5 |
| 25 | The secret never leaks through Debug, JSON or logs | CONFIRMED (found no leak) | secret.rs `Debug`, swapfile.rs tests, engine `Action::RevealEth` carries only the lock id, stock.rs `RedactedStdin` |
| 26 | Argon2id (64 MiB, t=3) → XChaCha20-Poly1305 with a random salt and a 24-byte nonce is sound | CONFIRMED | swapfile.rs:283-381; fresh salt, so a fresh key, per seal |
| 27 | The AAD binding is useful | CONFIRMED, limited | It protects the reveal (the secret only opens under the same public section) but nothing else. Finding L2 |
| 28 | Saves are atomic | CONFIRMED (single process) | swapfile.rs:472-495; no inter-process lock. Finding M6 |
| 29 | `new_alice` refuses the public test vector and a mismatched secret | CONFIRMED | swapfile.rs:167, 430-437; secret.rs `is_public_test_vector` |
| 30 | Client R page, version, proof and `ObjectIntent` are the node's | CONFIRMED for `build_call`, `check_call`, `owner_authorization_version(height)` (harness mirror), prove/verify and the envelope; differences in snapshotting and preflight | raw.rs:134-194 vs `wallet/mod.rs` L675-705 and `objects.rs` `prepare_call`. Finding M7 |
| 31 | Client S follows the CLI's preview → `--expected-txid` flow | CONFIRMED, with a retry defect | stock.rs:429-514 vs `contracts.rs` L335-392, `retain_review` L214. Finding M8 |
| 32 | ETH ABI decoding, lockId and selectors | CONFIRMED | eth.rs:37-53 matches `abi.encodePacked(address,address,uint256,bytes32,uint256)` (HTLC.sol:115); topics and selectors are pinned by eth.rs tests |
| 33 | The CLI wiring lets each party discover Bob's lock | REFUTED | main.rs:228-239. Finding H4 |

Erratum (2026-11-08): the chain's finality rule is 18 blocks after inclusion (`is_final`: tip >= height + 18), not 17; rows 7 and 8 of this table (claim target `D - 18`, finality `tip >= h + 17`) are therefore off by one, and the review's other findings are not affected.

---

## Findings

### Critical

**C1. Bob's bundle check never compares the bundle with Bob's own terms.** main.rs:165-179, swapfile.rs:210-260, 452-464.
- **What is wrong.** `new-bob` takes only `--bundle` and `--out`. `SwapPublic::check` rebuilds the opening from the values *inside* the bundle, so any self-consistent bundle passes. That includes one where:
  - `bob_noid` (the claim recipient) is an address Alice controls;
  - `eth.contract` is a contract Alice deployed;
  - `bob_sender`, `alice_receiver`, `amount_wei`, `chain_id` or `amount_micronoid` (V) differ from what was negotiated.
- **Design.** 6.3 item 2: "`B_noid` is Bob's own value and not taken from Alice". 2.2 step 0: Bob sends a10 himself.
- **Why it matters.** With a swapped `bob_noid`, Bob locks ETH, Alice reveals and takes it, and Bob's "claim" pays Alice: Bob loses the ETH. With a swapped `eth.contract`, Bob's `newLock` sends his ETH into Alice's contract. A tiny V gives Bob a fraction of the agreed NOID.
- **Fix.** Make `new_bob` take Bob's expected terms from Bob: `--bob-noid`, `--bob-eth`, `--alice-eth`, `--eth-contract`, `--eth-code-hash`, `--chain-id`, `--amount`, `--eth-amount-wei`, and an optional `--alice-noid`. Refuse the bundle unless each one is byte-equal. Add a test with a bundle that is valid but has `bob_noid` replaced.

**C2. No equivalence proof π in the bundle and no verification hook; `new-bob` prints "bundle verified".** swapfile.rs:139-151 (`SwapPublic` has no π, image id or journal field), main.rs:175.
- **What is wrong.** Without π, nothing ties `claim_authority` A to the hashlock H before Bob locks. The only tie is `check_preimage` after the reveal (engine.rs:389), which is too late.
- **Design.** 2.2 step 5 and 6.3 item 8: "π verifies (§5.5)".
- **Why it matters.** Alice publishes H = SHA-256(s) and A = Addr(s′) with s′ ≠ s. She reveals s and takes the ETH. Bob's check rejects s (`AuthorityMismatch`), so he can never claim, and Alice refunds the NOID at D. Bob loses the ETH (design T10, "unsound: Alice takes both").
- **Fix.**
  - Add `receipt_path` / `journal` / `image_id` to the bundle.
  - Make `new_bob` require a verified journal: run `equiv-host` verification, or accept a verified journal file and pin the image id.
  - Check the journal's variant byte, H and A against the bundle (`Variant::journal_byte` already exists for this).
  - Until then, `new-bob` must say "π NOT verified".

**C3. A pending ETH lock of unknown outcome can be dropped. Bob then aborts while his lock is in flight, or sends a second lock with a different `T_reveal`.** engine.rs:614-630, 683-704, 437-466; state.rs:401.
- **What is wrong.** The pending record is the only trace of a `lock_eth` whose broadcast may have happened (executor error after broadcast, or a crash). The phase stays `funding_final`, and `Runner::tick` clears the record whenever this tick's action is not a side-effecting `lock_eth`:
  1. `reuse_pending` returns `Wait` because `T_reveal = t0` is "no longer safe to resend" (engine.rs:695). Line 629 then clears the pending record. On the next tick there is no pending record, so `choose_t_reveal` picks a fresh `T_reveal`, and a **second lock with a different lockId** goes out.
  2. The decision is `Wait` for another reason (a pending call appeared, engine.rs:447): line 619 clears the record.
  3. The decision is `Abort` (`PastBobWindow`, `PastLockBy`, "instance incarnation changed"). Bob becomes `aborted`, a terminal phase that is allowed from `funding_final` (state.rs:401), with a lock possibly still in flight.
- **Why it matters.** A `newLock` stuck in the Ethereum mempool for half an hour (gas spike) is enough. Once `final_at_tip + 60` passes, Bob's tool aborts for good, the lock is mined later, and Alice's automated tool verifies it and reveals. Bob's tool ignores the reveal, Bob never claims, and Alice refunds the NOID at D: **Bob loses the ETH**. In case 1 Alice can claim both locks with one preimage (same H, same receiver): **Bob loses a second ETH amount**.
- **Fix.**
  - Record `LockSubmitted { t_reveal }` (or a new `LockIntended` phase) **before** broadcasting, not as an executor outcome.
  - Never allow `Abort` from that phase.
  - Never compute a fresh `T_reveal` while an earlier lock can still land. Give up only after the original nonce is provably used by another transaction, or `T_reveal` has passed with no lock at `lockId(t0)`. If that lock exists, go to `locked` and refund it.
  - Never clear a pending side-effect record because the current tick decided something else.

**C4. A pending NOID funding is retried blindly (double funding), or dropped by an `Abort`.** engine.rs:705-708 (`other => other`), 299-310, 624-630; state.rs:343.
- **What is wrong.** A `fund_noid` attempt that returned an error after broadcasting (an RPC timeout, or `contract fund` waiting for confirmation), or a crash before `FundingSubmitted` was recorded, leaves the phase at `created`. The watcher only sees confirmed instances (parano1d.rs:161-167), so the next tick decides `FundNoid` again, and `reuse_pending` sends it again ("retrying pending fund_noid").
- **Why it matters.** Two instances at the same root, each worth V. The engine tracks only the first (parano1d.rs:163 `find`). After Alice's reveal, *anyone* knows the secret and can close the second instance to Bob. Alice loses an extra V, which design 6.3 item 9 confirms ("each needs its own claim"). Alternatively, the tip passes `lock_by − 28` (engine.rs:301): Alice becomes `aborted` (terminal) while the funding is in flight, and the tool never refunds it at D.
- **Fix.** Record `FundingSubmitted` (with the wallet txid, or the reviewed preview txid) before broadcasting. Never re-send a funding while the previous one may be pending: look it up by txid (`getTx` / `getMempoolEntry`). Never `Abort` once a funding may exist. Make the watcher report **all** instances so the engine can refuse to reveal while a second instance exists, and refund it at D.

### High

**H1. Bob's `refund_submitted` phase ignores a revealed secret, and a reverted refund is never noticed.** engine.rs:407-411; state.rs:464-472 (no `refund_submitted + eth_preimage_seen` transition; the test at state.rs:573 pins this as "the machine does not go backwards").
- **What is wrong.** Bob decides to refund from `latest_timestamp ≥ T_reveal` (engine.rs:470). If his view of the logs was stale (a load-balanced RPC whose `eth_getLogs`/`getLock` backend lags its `latest` backend), or a head reorg replaces the last pre-`T_reveal` block with one holding Alice's claim, then Alice's claim is valid, his refund reverts with `AlreadyClaimed`, and his tool waits in `refund_submitted` forever.
- **Why it matters.** Bob loses the ETH, never claims the NOID, and Alice refunds the NOID at D: Bob loses both.
- **Fix.** In `refund_submitted`, first check `first_preimage()` and allow `refund_submitted → secret_seen`. Detect a reverted refund (`getLock.claimed == true`, or a receipt with status 0) and fall back to claiming. Base the refund decision on `getLock` at the same block as `latest`.

**H2. `F_max`: no lower-bound check on Bob's side, and an overflow bypasses the upper bound.** swapfile.rs:253, plus no `max_fee` check in engine.rs:437-466.
- **What is wrong.**
  1. Design 6.3 item 6 requires `max(50,000, 3 × estimateFeeDetailed(1,1)) ≤ F_max`. Bob's `check()` accepts anything ≥ 5,800, which is the harness guard (`check_swap_params`, harness lib.rs:301-313). The engine has `noid.fee_estimate_1_1` at lock time but never compares.
  2. `p.max_fee_micronoid * 100` is an unchecked u64 multiply on a value from the bundle. Release builds wrap on overflow (the test profile has overflow checks on, so the tests cannot see it). For example, `max_fee = 184_467_440_737_095_517` gives `×100 mod 2^64 = 84 ≤ V`, the check passes, and the byte-for-byte rebuild passes because the guard has no upper bound.
- **Why it matters.**
  - (1) T5: a relay floor above `F_max` means Bob's claim cannot be relayed. If that lasts until D, Bob loses.
  - (2) T1 without a cap: anyone holding x (any miner after the reveal) can close to Bob with `fee ≈ V` and take it back as the block tip. Bob gets about nothing for his ETH.
- **Fix.** `checked_mul` (and `checked_add` at swapfile.rs:240). In `bob_action(FundingFinal)`, refuse to lock unless `max_fee ≥ max(50_000, 3 × noid.fee_estimate_1_1)` and `max_fee × 100 ≤ V`.

**H3. The pinned ETH contract code hash and chain id are stored but never checked; `B_eth` is never checked to be an EOA; Alice does not simulate her claim.** swapfile.rs:98-104 (stored); `grep code_hash|chain_id` finds no use in `engine.rs` or `watch/eth.rs`; `sender_is_eoa` is filled (eth.rs:139) but never read; main.rs:131 makes the code hash optional.
- **Design.** 2.2 step 9.1: "`keccak256(eth_getCode)` equals the pinned runtime-bytecode hash". T17. T11: "Alice simulates `claim` with `eth_call` before broadcasting"; "`A_eth` and `B_eth` must be EOAs".
- **Why it matters.** If the pinned address is wrong (a typo, or an address Bob suggested), Alice reveals into a contract that emits a fake `Locked` and pays nothing. Bob then claims the NOID and Alice loses it. A watcher pointed at the wrong chain id gives a valid-looking observation of the wrong chain.
- **Fix.**
  - Make `code_hash` mandatory.
  - In the watcher, call `eth_chainId` and `eth_getCode(contract)` and refuse on mismatch.
  - In `lock_matches`, require `receiver_is_eoa == Some(true)` and `sender_is_eoa == Some(true)` (fail closed).
  - Add an `eth_call` dry run of `claim` just before `RevealEth`.

**H4. The CLI watches lock id `0x00…00` until a lock is recorded, so neither party can ever see Bob's lock.** main.rs:228-232 (`.unwrap_or([0u8; 32])`), eth.rs:153-158 (logs filtered by `topic1 = lock_id`).
- **What is wrong.** Alice in `funding_final` has no lock id. Bob in `lock_submitted` has none either, because `BobPhase::lock()` returns `None` there (state.rs:233-244), even though the lock id can be computed from `(B_eth, A_eth, amount, H, t_reveal)`. So `eth.lock` is always `None`: Alice never sees `lock_seen`, and Bob stays in `lock_submitted` forever.
- **Why it matters.** Combined with C3: after a crash, Bob in `funding_final` cannot see his own landed lock either, so the safe recognition that `resume.rs:106` "proves" happens only in the simulator. The real path goes to a resend (which reverts) or to the drop/abort branches of C3.
- **Fix.** Bob: compute the lock id from the pending or `LockSubmitted` `T_reveal`. Alice: take the lock id from Bob (artifact a12) as a CLI input, or scan `Locked` logs by `topic3 = A_eth` and filter on the hashlock. Add a CLI test that walks fixtures through `lock_seen`.

### Medium

**M1. After a reveal, nobody cleans up the leg that is left over.**
- **What is wrong.**
  - Bob in `secret_seen`/`claim_submitted`/`done` never refunds his ETH when Alice's claim reverts or never lands (engine.rs:475-511; no refund transition out of those phases). `secret_seen` + `TooLate` goes to `aborted` (terminal, engine.rs:486, state.rs:401), which also blocks the refund.
  - Alice in `reveal_submitted`/`revealed`/`done` never refunds the NOID at D when Bob never claims (engine.rs:341-345). The test scenarios.rs:214-238 asserts the NOID "stays in the contract until Alice refunds it manually".
- **Design.** 2.3 row 4: "Bob can then refund ETH *and* claim NOID". 2.4 row 3: "Alice refunds NOID at D and keeps the ETH". M2 acceptance: "no NOID is ever stuck".
- **Fix.** Let Bob refund at `T_reveal` from every post-secret phase when `getLock` shows the lock is neither claimed nor refunded. Let Alice refund at D from every post-reveal phase while the instance still exists.

**M2. The gates fail open on unknown observations, and there is no staleness check on the Parano1d tip.** engine.rs:153 (`receiver_is_eoa == Some(false)` only), 161 (`instance_matches_opening == Some(false)` only), 442 (`active_authority` `None` passes), watch/mod.rs:344-345 (`pending_calls: Vec` cannot say "unknown").
- **Why it matters.** Bob's (I1) uses `noid.tip` as `H_b` (engine.rs:453). A lagging or eclipsed node overstates the slack by its lag. An unknown mempool reads as empty, so the step-7 "no pending call" check passes.
- **Fix.** Use `Option` or `Unknown` for every safety-relevant field and refuse to lock on unknown. Before locking, require the tip header's timestamp to be within a few blocks of the local clock, and require ≥ 2 nodes to agree on the tip.

**M3. The rotation guard and pending-call warning are skipped for `LateButValid`, and Bob submits into a known `SlotConflict`.** engine.rs:489-503.
- **What is wrong.** With `pending_calls` non-empty (T2), Bob's claim is certain to fail with `SlotConflict`, and the runner retries a full proof every tick.
- **Why it matters.** Not unsafe, but under design T2/Q1 this is the stall case. The tool should report it loudly ("a competing close pays Bob: watch it") rather than loop.
- **Fix.** Branch on `pending_calls`: if a pending close exists, track that txid as the outcome, re-check that it pays `B_noid` (`getMempoolEntry`), and stop re-proving until it is evicted.

**M4. Two different lock-by heights.** params.rs:215 vs engine.rs:429 and swapfile.rs:128-129, 246.
- **What is wrong.** Bob aborts in `received` at `tip > D − 619`, but once funded he locks up to `D − 529` with a shorter window.
- **Design.** 9.1: "lock-by = `D − 619`". 2.2 step 7: "`H_now ≤ lock-by height`". 4.3 item 5 lists both values.
- **Why it matters.** It is (I1)-safe, but it shortens Alice's window to as little as 5,400 s, and the docs and the CLI `gates` output say 300,106.
- **Fix.** Decide in the design which value step 7 means. Then use `params.lock_by_height` (D − 619) in `choose_t_reveal`, or document D − 529 as the hard limit and rename the field.

**M5. Missing 6.3 checks on Bob's side.** swapfile.rs:210-260.
- **Item 3:** `A ∉ {A_noid}` is not checked; the guard checks only `A ≠ B_noid` (harness lib.rs:306).
- **Item 5:** `D − H_now ≤ 2 × D_offset` is not checked, and `h_create` is never compared with Bob's own tip.
- **Item 8:** `getSlotsByOwner(A)` empty, and H fresh in *Bob's* DB. `HashlockRegistry` is only used by `new_alice` (main.rs:156).
- **Also:** Bob does not refuse the public test-vector hashlock `630dcd29…10dd`.
- **Fix.** Add each check in `new_bob` or at Bob's lock time.

**M6. No exclusive lock on a swap file.** swapfile.rs:472-495 (fixed `<path>.tmp` name, no lock file).
- **Why it matters.** Two `tick --apply` processes, or a daemon plus a manual run, can both decide and act on the same phase: a double lock or a double fund (C3/C4) without any crash.
- **Fix.** Take an OS advisory lock (`<file>.lock`, created exclusively) for the life of a `Runner`, and use a random tmp suffix.

**M7. Client R takes its chain snapshot piecemeal.** raw.rs:287-297, versus `prepare_call` (objects.rs, the block from `let chain = handler.chain.read()` to `build_call`).
- **What is wrong.** The node takes `height = tip + 1`, the epoch anchor (`next_user_epoch_anchor`), the slot hints (salted with `alloc_counter ^ creation_id`, excluding mempool-reserved outputs) and the canonical slot under **one** chain read lock. It also refuses if the input already has a pending call (`reserved_slots`) and computes the fee minimum with `fee_breakdown(1, 1, active_slot_count, log_slots).max(floor)`. Client R instead:
  - uses `call_height` from the earlier observation;
  - fetches the anchor and `getSlotHints(1)` in separate RPCs at execute time;
  - does not re-read the slot;
  - does not check reserved inputs;
  - uses a fixed minimum of 5,800.
- **Why it matters.** The 5,800 minimum is correct for 1 input / 1 output (net zero new slots, so no growth fee; fees.rs:103). But a tip that moves across an epoch boundary between decide and execute pairs a new anchor with a stale `call_height`. The rotation guard makes this unlikely on target, but it is not checked on the `LateButValid` path.
- **Fix.** Fetch the tip, anchor and slot hint in the executor and refuse if `tip + 1 != call_height` or the anchor changed versus the observation. Preflight with `previewObjectCall` (design 7 mitigation, "previewObjectCall comparison"), or at least `getObjectStatus`, before proving.

**M8. Client S's retry loop reuses the same `--out` path.** stock.rs:479-488, against `contracts.rs` `retain_review` (L214, `new_output` is create-new) → `walletCallObject`.
- **What is wrong.** When the height changes between the CLI's internal re-preview and `walletCallObject`, `prepare_call` fails with "inclusion height changed" *after* `retain_review` has created the out file. The second attempt then fails with "create new artifact", which `run_stock_claim` reports as `Command`, not `HeightChanged`.
- **Fix.** Use an out path per attempt (`out.attempt-N`). Map both node messages ("inclusion height changed", "call body changed") to `HeightChanged`. Test with a runner that fails only after the file exists.

### Low

**L1. `eth_now = max(now, latest_ts)` points the wrong way for Bob's (I1).** engine.rs:452-453, 688-690.
- **What is wrong.** (I1) needs the *earliest* plausible "now" as `t_b`, because blocks are produced in real time until the absolute `T_reveal + Δ`. A local clock ahead of real time by X seconds overstates Bob's slack by X/20 blocks. Using `max` is correct for Alice's cutoff and step-9 check 5 (engine.rs:238, 328).
- **Fix.** Pick `T_reveal` from `max` (Alice's view), but evaluate (I1) with `t_b = min(now, latest_ts)`. Also refuse when `|now − latest_ts|` is more than about 60 s.

**L2. The AAD binding protects the reveal and nothing else.** swapfile.rs:262-266, 339-381, 497-517.
- **What it does.** It works as a tripwire: the secret only opens under the exact public section, so a tampered `alice_receiver` or `eth.contract` blocks Alice's reveal at decrypt time.
- **What it does not do.**
  - It does not authenticate `phase`, `history` or `pending_action`. A forged `lock_final` phase with a fake lock id would make the tool reveal into a lock that reverts.
  - Bob's file has no integrity at all.
  - `load` never checks the digest.
  - A rewritten `sealed_to` reports `WrongPassphrase`, which misleads.
- **Fix.** Add a MAC over the whole file under the KDF key (Alice), or document clearly that the file is trusted storage.

**L3. KDF settings.** 64 MiB, t=3, p=1 is reasonable (RFC 9106's second recommended option uses p=4). However:
- `--fast-kdf` (8 MiB, t=1) is exposed in the production CLI (main.rs:137);
- the KDF parameters are read back from the file unbounded (swapfile.rs:298), so a file with a huge `m_cost_kib` makes the tool exhaust memory.
- **Fix.** Hide `--fast-kdf` behind `cfg(test)` or an env flag, and bound `m_cost` at load time.

**L4. The Parano1d watcher reports only the first instance.** parano1d.rs:163.
- **What is wrong.** The comment at parano1d.rs:55-57 says "a double-funding is visible, not hidden", but `find` drops every other instance before the engine sees it.
- **Fix.** Report `instances: Vec<…>`. See C4.

**L5. A claim that reverted after being mined is never scanned.** eth.rs:291-293 skips mined transactions ("the Claimed event covers it"), but a reverted claim emits no event. Bob misses x in that case. His ETH refund still works, so this is a missed windfall (design 2.3 row 4), not a loss. **Fix:** inspect the receipts of mined, reverted claim calls.

**L6. The engine trusts the wiring for lock identity.** `lock_finalized()` (watch/mod.rs:429-434) and `alice_fact(LockSeen)` (engine.rs:254) do not check `eth.lock.lock_id == recorded lock_id`. **Fix:** compare the ids.

**L7. `B_bob` is counted from Bob's own observation tip, not from the funding inclusion height.** engine.rs:369-371, 453. This affects Alice's liveness only. **Fix:** count from the instance's inclusion height.

**L8. Unused or partial helpers.**
- `check_i3` (params.rs:258) is never used: Alice does not enforce (I3).
- The (I5) schedule is a hard-coded constant (T7 residual says "the tool checks for scheduled version changes in the node's params").
- **Fix.** Use or remove `check_i3`, and add a node-params check before M2.7.

### Nit

- **N1.** engine.rs:890-898: the first case of `bob_claim_height_rules` asserts `Wait` *or* `ClaimNoid` depending on a value it computes itself. It cannot fail, and the comments show the author was unsure. Assert the expected value (`left = 1`, so `Wait`).
- **N2.** swapfile.rs:240: unchecked `h_create + ETH_D_OFFSET` on a bundle value. Use `checked_add`.
- **N3.** secret.rs (`authority`: `*self.witness_bytes(variant)`) and raw.rs:166 (`*witness`) copy the secret into temporaries that are never zeroized. This is cosmetic for Bob, whose secret is already public, but not for Alice's own uses.
- **N4.** state.rs:382 and 450: an eviction resets `final_at_tip`, `seen_at_tip` and `seen_at_time` to 0, and Alice loses her `lock` summary. None of this is safety-relevant (the engine re-derives it), but the history becomes misleading.
- **N5.** engine.rs:181-182: the comment says derivations "never return a fact twice". The loop is bounded at 16 anyway; say so instead.

---

## Tests: what they prove less than their names say, and what is missing

- **`resume.rs:73` `pending_lock_recorded_before_a_crash_is_resent_with_the_same_t_reveal`** uses `offline_for` (failure *before* effect), not a crash after the broadcast. It never takes the "no longer safe" branch, which is the double-lock path (C3). The simulator also cannot represent two locks: `lock_pending` and `lock` are single slots (common/mod.rs:64-65, 290, 214), so `lock_count == 1` would hold even after a double lock if the second replaced the first before mining.
- **`resume.rs:106` `lock_that_took_effect_before_the_crash_is_recognized_not_repeated`** passes because the simulator gives the engine the lock directly. Through `main.rs`, Bob's watcher looks for lock id `0x00…00` (H4).
- **`scenarios.rs:91` `alice_funded_but_bob_never_locks_alice_refunds_at_d`** pins the behaviour of C3 (Bob aborts with a `lock_eth` pending). It is safe here only because the attempt never took effect. The same test with `crash_after_effect.insert("lock_eth")` and the lock mined 70 blocks later would show Bob losing his ETH.
- **No `fund_noid` crash-after-effect test exists** (C4). The simulator's `funding_pending` (common/mod.rs:48, 283) is a single slot, so it would also hide double funding.
- **`scenarios.rs:214` `bob_offline_until_d_loses_and_alice_keeps_both`** asserts that NOID is stuck. That contradicts design 2.4 row 3 and the M2 acceptance ("no NOID is ever stuck").
- **The simulator** always sets `active_authority: None` and `instance_matches_opening: Some(true)` (common/mod.rs:124-125). The fail-open paths (M2) and the "already on the recovery branch" abort are never exercised.
- **`state.rs:573`** codifies the H1 defect as intended behaviour.
- **Missing scenarios that need no node** (design 10 M2 step 5 and section 8):
  - **F_max-burn early close by Alice.** She closes to `B_noid` with `fee = F_max` before revealing, and the instance disappears. What does Bob's tool do in `locked` and then in `secret_seen` (it waits forever, engine.rs:476-483)?
  - **Conflicting third-party close (T2).** The simulator already models first-seen `SlotConflict`. Inject a min-fee close paying Bob and check that Bob does not loop (M3) and reaches a final state.
  - **Forced epoch rotation.** The scenario is a claim proved in the last block of an epoch and withheld. `evict_all` only models the eviction, not the T6 guard interplay at the real boundary heights (for example `next_call_height = k·144 − 3`).
  - **Malicious late reveal at `T_reveal − 12 s`.** Bob must still claim inside D − 18. This checks the (I1) margin end to end.
  - **Reveal racing Bob's refund** (H1), and **Alice's claim reverting** (M1: Bob should get the NOID *and* his ETH back).
  - **A bundle with Bob's own fields swapped** (C1), and **a bundle with `max_fee = 184_467_440_737_095_517`** (H2).
  - **A stale tip** (M2) and **clock skew** (L1).

---

## What I could not determine

1. **Whether the proof is bound to the exact `call_height` or only to its branch.** The mempool re-checks only the branch at the candidate height (`noid_mempool/src/contracts.rs` `eviction_reason`), which suggests the branch. But `prove_experimental_object_authorization_for_version(page, opening, height, …)` takes `height`, and the node binds `expected_call_height`. If verification at admission or inclusion uses the inclusion height, a claim proved for `tip + 1` and included later would fail, and M7 becomes high. I did not read `noid_gkr::wallet_authorization` deeply enough to settle this.
2. **Whether `getSlotHints` (node entropy) excludes mempool-reserved outputs the way `collect_empty_slot_hints(…, reserved_outputs, …)` does in `prepare_call`.** I saw only the API docs (`api.rs` L293-306) and `server.rs` L2412-2414. If it does not, Bob's claim can collide with a pending output (Q12).
3. **Whether `paranoid_getTx` keeps finding a transaction after its block body is pruned (42 blocks).** If it does not, a late `tracked_outcome` (engine.rs:273-281) would report an included claim as evicted. The design's statement that receipts stay verifiable suggests it does.
4. **Whether the stock CLI's internal re-preview catches every height change before `retain_review`** (the case where M8 does not bite). It depends on timing.
5. **The fixtures.** I did not re-derive the recorded fixtures against Hardhat, or the topic hashes against an independent keccak. I relied on the crate's own `keccak_and_topic_constants` test.
6. **Whether a future M2.7 executor will record outcomes before broadcasting.** C3 and C4 are defects of the engine/runner contract as written, whatever the executor does: `reuse_pending` retries `fund_noid`, and `tick` clears or aborts a `lock_eth` it cannot account for.

## Applied 2026-11-04 (by the implementing session, after this review)

Critical and high findings, each with a test: C1 `SwapPublic::check_bob_terms` + `BobTerms` (`new-bob` takes Bob's
terms on the command line); C2 `EquivalenceAttestation` required by `SwapFile::new_bob` and on load (journal
`variant ‖ H ‖ A` and image id must match; the receipt is still verified externally by `equiv-prove verify`, and the
CLI says so); C3/C4 `ExecError::maybe_sent` + `PendingAction::maybe_sent` + `retry_safe`: an unknown-outcome
`fund_noid`/`lock_eth` is held (Wait), never retried blindly, never dropped or turned into an abort; a chain fact
resolves it (`tests/resume.rs`); H1 `RefundSubmitted + EthPreimageSeen → SecretSeen` and the matching fact
derivation (`tests/scenarios.rs`); H2 checked `max_fee` arithmetic, `F_max ≥ 50,000` in `check()`, and
`F_max ≥ max(50,000, 3 × estimate)` at Bob's lock decision; H3 `sender_is_eoa`, `chain_id` and the pinned contract
code hash are compared in `lock_matches` (the watcher now reads `eth_chainId` and `keccak256(eth_getCode(contract))`);
H4 `engine::expected_lock_id` (Bob) and `EthWatcher::with_discovery` (Alice) wired into `tick`.
Also applied: L1 (Bob's clock = min), L6 (lock ids compared), M3 (no re-proof into a foreign pending close), M4
(one hard lock-by, `D − 529`, with `lock_by_height` documented as the nominal full-window value), M5 items 3 and 8
partly (`A ≠ A_noid`, test-vector hashlocks refused, Bob registers the hashlock).
Not applied (follow-ups in README "Known gaps"): M1, M2, M6, M7, M8, L2–L5, L7, L8, nits.

