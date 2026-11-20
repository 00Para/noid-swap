# Review 1: Parano1d capabilities report and HTLC harness

Reviewer pass against `vendor/parano1d` at `d29b801`. Vendor is unmodified (`git status --short` there is empty). Paths are relative to `vendor/parano1d/` unless they start with `parano1d/`, `docs/` (this repo) or `/tmp`.

Scratch artefacts I used (all outside the repo; nothing in the repo was changed):
- `/tmp/review_scratch`: a crate that depends on the harness plus the vendor crates. Six extra tests.
- `/tmp/review_vendor`: a `git archive` copy of vendor with one added circuit test in `noid_recursive/src/acceptance/block_slots.rs`.

## Verdict table

| # | Claim | Status | Evidence | Notes |
|---|---|---|---|---|
| 1 | ABI 3 has no hash/bytes/bitwise opcode, and no caller-argument operand (native and in-circuit) | CONFIRMED | Native: `noid_tx/src/experimental_object/integer_program.rs:13-16` (constants), `:105-116` (10 opcodes), `:263-286` (`Context::from_body`), `:382-407` (interpreter). Circuit: `noid_recursive/src/acceptance/trace/integer_program.rs:10-12` (shared constants), `:267` (opcode selector pinned to `OPCODE_COUNT`), `:299-306` (results only from ops 0-9). | Caller-influenced values the program *can* read: `fee`, `retained_slot`/`payout_slot` (u32), `input_slot`/`input_creation_id` (State-bound), and `payout_owner0..3`. Closes have no hidden data channel because dead outputs must be the dummy value (`noid_tx/src/paged_spend.rs:532-535`). |
| 2a | `check_call` makes a terminal close pay `outputs[0].owner == recipient_at(h)`, independent of the authority | CONFIRMED | `noid_tx/src/experimental_object.rs:139-145`, `:210-213`. The authority is chosen separately at `:220`. | Prover and verifier both run `check_call` first (`noid_gkr/src/wallet_authorization.rs:436-439`, `:617-620`). |
| 2b | The same recipient rule is enforced in the block relation (HistoryStep) | CONFIRMED (component-tested; root binding read, not tested) | `noid_recursive/src/acceptance/block_slots.rs:921-940`: `before_deadline = lt_strict(height, deadline)`. `:1044-1067`: `terminal * (output0_owner + select(before_deadline, claim_recipient, refund_recipient)) = 0`. `:1083-1141`: mode bits, fee cap, reserve, payout cap and fixed payout recipient. Recipient wires are pinned into the CNTPOL sponge rows in `root()` order at `trace/region_source_binding.rs:1180-1239`. The old object root is pinned to the body `input_owner` at `block_slots.rs:1513-1520`. Production call site: `block_slots.rs:2974`, inside `build_selected_zk_block_slots_core` (`:2262`, not `cfg(test)`). | **Run:** I added `review_terminal_close_must_pay_branch_recipient_in_circuit` to the scratch copy. At h=49 and h=50 it pays a stranger, the other-branch recipient, or the claim authority. Each time `check_call` returns `Recipient` and the R1CS is **unsatisfied**; the honest close satisfies it. Result: 5/5 `object_execution_tests` pass. The test is at component level, with opening wires allocated directly. The end-to-end binding of those wires to the funded root is from reading the code only. |
| 3 | Auth proof public inputs = (logical_txid, authority); the mempool verifies it; the relation is lanes 0-1 of `P([s_lo,s_hi,IV(ADDRFIX_)])` == authority | CONFIRMED | `wallet_authorization.rs:381-397`: native precheck builds `[s0,s1,iv0,iv1]`, runs `evaluate_permutation`, requires `final_state()[..2] == expected_address`, and the capsule is proven from that trace. `:612-634`: verifier public = `(canonical.logical_txid, checked.authority)`. `noid_mempool/src/pool.rs:426-438`: verify. `:478-483`: authority recheck. | **Run:** a proof stays bound to the fee and the output slot: changing either gives `AuthProof`. I did not audit the in-capsule constraints. Forged traces (honest `s'` trace, or `s'` trace with the last row patched to `Addr(s)`) are refused by the public low-level prover (`BoundaryMismatch{claim_index:2}`, `MainRelationMismatch{round:65}`). That is still prover-side; verifier soundness against a malicious prover is assumed, not tested. |
| 4 | `Addr(s)` definition and the test vector | CONFIRMED | `noid_poseidon2b/src/primitives.rs:298-305`, `native/domain.rs:27-40,56`, `native/compression.rs:70-77,198-216`. | **Run:** computed two ways, via `derive_address` and via a hand-built `Poseidon2bPermutation::permute_mut([s_lo,s_hi,L<<64,L])` taking lanes 0-1 LE. Both give `f8183db204ffb765c7015d851c1754e4974c675b975c6738d9f6d138eb7212cf`. The bech32 form, SHA256(s) and `capacity_iv == [L<<64, L]` also match. I also replicated `Derive(s,0)` from `noid_node/src/wallet/keystore.rs:74-91` (IV 0, four absorbs, padded finalize), which gives `o125qayv…set7wlk` and matches. The `ADDRESS_` doc drift at `primitives.rs:72-73` is real. |
| 5 | Mempool evicts a call whose branch flips at the next height; 144-block epoch anchor | CONFIRMED | `noid_mempool/src/contracts.rs:92-113`, run per block from `pool.rs:799-803` with tip+1. Epoch: `docs/protocol/transactions.md:96-107`, `noid_chain/src/consensus/params.rs:226` (`TX_EPOCH_BLOCKS = 144`), `noid_chain/src/consensus/epoch_anchor.rs:62`, admission equality check at `pool.rs:1274-1294`. | The last valid inclusion height for a claim is D-1. See risk R2 (reorg). |
| 6 | V3→V4 owner-auth switch at 279,370; admission rejects the other version | CONFIRMED (citation fix) | `params.rs:23,31-34,47-61`. The real rejection is the version-selected verify at `pool.rs:429-435`. `:486-493` is only a TOCTOU guard. `pool.rs:753-776` evicts pending entries at the boundary (`AuthorizationProfileChanged`). | **Run:** V3 and V4 proofs do not cross-verify (`AuthProof` both ways). |
| 7 | Stock wallet authorizes only for `Addr(Derive(m, active_index))`; `--import-wallet-secret` replaces the wallet | CONFIRMED | `noid_node/src/wallet/builder.rs:109-126`; `noid_node/src/main.rs:1370-1376`, `:1995-2005`; `noid_node/src/wallet/state.rs:617-650`. | Import resets `active_index=0, next_index=1` (`state.rs:637-640`), so the stock lock address is `Addr(Derive(m,0))`. The imported secret is written as `PLAIN_MAGIC ‖ raw 32 bytes`, i.e. unencrypted (`keystore.rs:231-236`). |
| 8 | Custody is NOID-only; native tokens sent to a contract root are unspendable | CONFIRMED (inference; one bad citation) | Instance = NOID output owned by the root: `experimental_object.rs:327-336`. Native-asset authorization goes through the same ADDRFIX selected statement over the canonical input owner: `wallet_authorization.rs:450-467` → `:381-397`. | The cited `noid_tx/src/native_assets.rs:560-600` is `NativeOpening::validate()`. It checks only that the owner is non-zero (`:1040-1045`) and says nothing about authorization. Not tested: whether a contract call could consume a token-typed slot. |
| 9 | Fee formula; ≥5,800 μNOID close; relay floor | CONFIRMED | `noid_chain/src/consensus/fees.rs:96-122`, `params.rs:428-446` (5000/100/700/2500). `pool.rs:1256-1270`: required = max(floor, consensus). Floor: `floor.rs:4-11,112-120`, window 50 (`config.rs:55`). It latches only at ≥80% count or bytes and resets below 50% (`floor.rs:60-87`). | `check_call` does not enforce the minimum fee (**run:** a fee=1 close passes `check_call`); only admission and consensus do. See R3: `max_fee < 5,800` locks *both* branches. |
| 10 | Harness tests do what their names say | CONFIRMED, with caveats | See "Harness findings". | |
| 11 | Missed HTLC risks | — | See "Additional risks". | |

## Corrections to the report (`docs/parano1d-capabilities.md`)

1. §4, L81: replace "Admission rejects a proof made for the other version (`pool.rs:L486-L493`)" with: "Admission verifies with the version selected by the candidate height (`pool.rs:L429-L435`), so a proof for the other version fails (`AuthProof`). L486-493 rejects if the version changes during verification, and `pool.rs:L753-L776` evicts pending calls when the profile switches at the boundary."
2. §5, L85: replace "`vendor/parano1d/noid_tx/src/native_assets.rs:L560-L600`" with "`vendor/parano1d/noid_gkr/src/wallet_authorization.rs:L450-L467` (native authorization uses the same ADDRFIX owner statement, `L381-L397`)".
3. "What we could NOT determine", 2nd bullet: replace it with "The HistoryStep relation enforces the terminal recipient (`noid_recursive/src/acceptance/block_slots.rs:L1044-L1067`), mode bits, fee cap and the fixed payout recipient (`L1083-L1141`), with `before_deadline = height < deadline` (`L929-L930`). A component-level negative test confirms this (review-1). The end-to-end root binding was read (`region_source_binding.rs:L1180-L1239`, `block_slots.rs:L1513-L1520`), not tested."
4. "What we could NOT determine", 6th bullet (third party blocking Bob): replace it with "The mempool is strict first-seen per input slot, with no replace-by-fee (`noid_mempool/src/pool.rs:L1296-L1297, L1334-L1356`). A conflicting close from any holder of `s` is rejected as `SlotConflict` if it arrives second, and it blocks Bob's if it arrives first. It still pays Bob, but at a fee the attacker chooses (see review-1, R1)."
5. §9, after "Liveness risk": add "If `max_fee` < 5,800, neither the claim nor the refund can ever pay the consensus minimum fee, and the funds are locked permanently. Nothing (Pruv, `check_call`, RPC builder) rejects such an opening."
6. §4, L79: append "A claim included at D-1 that is reorganized out (≤17 blocks) and re-included at height ≥ D becomes invalid, and the refund becomes valid. Bob should treat a claim as safe only if it is final (18 blocks) before D."
   Erratum (2026-11-08): the chain's finality rule is 18 blocks after inclusion (`is_final`: tip >= height + 18), not 17; read "(≤17 blocks)" above as "fewer than 18 blocks on top".
7. §2, "With a raw `s`" bullet: add "`check_call` does not bind `inputs[0].amount`/`creation_id` to State; the mempool (`check_input_slots`) and HistoryStep do. A client must take them from verified State."
8. Implications §5: "about 2026-11-04 04:00 UTC" is roughly one day from today (2026-11-03). Add: "Calls pending at the boundary are evicted and must be re-proved with V4. Until 279,370 the mempool verifies V3, so a harness-built (V4-default) proof submitted now would be rejected."

## Harness findings

**Re-run** (`RUSTUP_TOOLCHAIN=stable`, `CARGO_TARGET_DIR=~/noid-swap/target`): 12 passed, 0 failed, 0 ignored, 7.64 s. This matches the README.

**Per-test check:**
- `claim_with_wrong_secret_rejected`: the "proof layer" rejection is the **prover's native precheck** (`wallet_authorization.rs:392-397`, `BoundaryMismatch`), raised before any proof exists. The verifier rejection is shown only for wrong-statement proofs (decoy contract, replay on an edited page). No test feeds the verifier a proof for `Addr(s)` made without `s`, and the public API cannot produce one; my scratch test shows the low-level prover also refuses. The README wording ("the prover refuses") is accurate. Do not read it as a soundness test.
- `close_must_pay_committed_recipient`: confirmed. `check_call` returns `ObjectError::Recipient` for Mallory, Alice and `Addr(s)` before D, and for Mallory and Bob at D. The prover returns `OwnerAuthStatement("…Recipient")`.
- `claim_after_deadline_rejected`, `refund_before_deadline_rejected`, `refund_after_deadline_pays_sender`, `fee_capped_by_max_fee`, `continuing_calls_and_payout_outputs_rejected`, `wrong_opening_is_rejected`, `compiled_policy_matches_the_spec`, `addr_vectors`: each exercises what its name says. All of them go through `htlc.pruv` compiled at run time.
- `example_params_reproduce_saved_definition`: this is the only test that reads `htlc.params.example.json`. The security tests use `Cast`/`D=1000`/`MAX_FEE=10,000`, not the example params (deadline 300,000, `max_fee` 20,000).

**Mutation 1** (`htlc.pruv`: `claim_recipient = receiver` → `= hashlock_authority`; run in `/tmp/review_scratch_target` because the shared target was locked by the circuit build): **5 failed / 7 passed**.
- Failed: `claim_before_deadline_pays_receiver` (htlc.rs:86), `close_must_pay_committed_recipient` (htlc.rs:238, on the `Addr(s)` thief, the intended failure), `compiled_policy_matches_the_spec` (:43), `example_params_reproduce_saved_definition` (:69), `fee_capped_by_max_fee` (:352).
- This matches the README's "5 tests fail".
- Restored: sha256 `1500c8ae…865ff` before and after; `cmp` is identical.

**Mutation 2** (example params: `receiver = hashlock_authority`): only `example_params_reproduce_saved_definition` fails, which confirms the point above. Restored: sha256 `9e624fe9…b20a0` is identical.

All five harness/contract files have the same sha256 after review as before it.

**Gaps (not defects):**
- No V3 test, though V3 is the live mainnet profile until 279,370.
- No test that `max_fee < 5,800` makes the opening unclosable.
- No test that `check_call` accepts falsified `inputs[0].amount` or `creation_id`. My scratch run shows it does (`None`); the mempool and HistoryStep reject them.
- No mempool, circuit or reorg coverage (the README already says so).

## Additional risks found

- **R1 First-seen, no RBF.** `pool.rs:1296-1297,1334-1356` rejects any second spend of the same input slot (`SlotConflict`), and I found no replacement path in `noid_mempool` or `noid_chain/src/mempool.rs`. Alice knows `s` from the start, and everyone knows it after the ETH reveal. After taking the ETH, Alice gains if Bob's claim fails. She can broadcast a minimum-fee close first. It still pays Bob, but Bob cannot outbid it on nodes that saw hers. If contract capacity is contended (≤63 calls per block, fee-ordered selection), it can sit until branch-flip eviction at D (`contracts.rs:92-113`) or an epoch rotation, and then Alice refunds. Mitigations:
  - set `max_fee` with large headroom;
  - Bob submits at `max_fee` the moment the reveal is visible, to many peers;
  - add a large D margin.
- **R2 Reorg across D.** Finality is 18 blocks, with up to 17 blocks of rollback (`docs/protocol/parameters.md:11`, `docs/contracts/lifecycle.md:85-89`). A claim included near D can be re-included at a height ≥ D, where it is invalid (`Recipient`), and the refund then becomes valid. Bob's effective deadline is about D-18.
  Erratum (2026-11-08): the chain's finality rule is 18 blocks after inclusion (`is_final`: tip >= height + 18), not 17; the finding itself (claim must be final before D) stands, with D-19 as the target.
- **R3 `max_fee` below 5,800 bricks both branches.** Every close is 1-in/1-out, so it needs ≥5,800 (`fees.rs:96-122`), and `check_call` caps the fee at `max_fee` (`experimental_object.rs:192`). Scratch: `max_fee` 5,799 gives `FeeLimit` for a 5,800 fee. The refund has the same problem, so the value is locked forever. Both parties must check `max_fee ≥ 5,800 + floor headroom` before funding or locking.
- **R4 Deadline sanity.** There is no horizon cap and no lower bound. `deadline ≤ funding height` means the claim branch is never reachable (scratch: `deadline=0` gives `authority_at(0) == Alice`). Bob must check that `D - current_height` covers the ETH timeout, the reveal, 18-block finality and an epoch rotation.
- **R5 Instances.** Each funding is a separate instance (`docs/contracts/lifecycle.md:22-26`), and one call consumes one instance. Bob must:
  - verify the exact `(slot, creation_id, amount)` in finalized State;
  - claim every instance, paying the fee on each.

  Third parties can attach dust instances to the same root; this is harmless but noisy.
- **R6 Can the recovery party claim early?** No. `rules.permits(before_deadline, terminal)` (`policy.rs:50-58`) and `authority_at` (`experimental_object.rs:131-137`) give Alice no pre-D branch. Alice can close before D only by using `s`, and that pays Bob.
- **R7 Deadline comparison is consistent.** It is strict `height < deadline` everywhere:
  - Rust: `experimental_object.rs:132,140`, `integer_program.rs:271`;
  - circuit: `block_slots.rs:930` (`lt_strict`);
  - docs: `docs/contracts/core.md:58-59`, `lifecycle.md:39-40`, `pruv.md:152-153`;
  - the report and README agree.
- **R8 Stock-wallet import writes `m` unencrypted** (`keystore.rs:231-236`). Combined with revealing `m` on ETH, the import data directory must be disposable.
- **R9 Opening size.** 699 = 8+2+16·32+16+4·32+8+25 (`experimental_object.rs:33`); consistent. The opening is public in the mempool (`getMempoolEntry`), which links A, Bob and Alice on chain. This is a privacy cost only.

## Applied 2026-11-04

All eight corrections were applied to `docs/parano1d-capabilities.md` (task M0.1) after re-checking each citation against `vendor/parano1d` at `d29b801`. No line number in the list above needed changing.

1. Applied. §4 fork-boundary bullet now cites `pool.rs:L429-L435` (version-selected verify), `L486-L493` (TOCTOU guard) and `L753-L776` (boundary eviction).
2. Applied. §5 custody bullet now cites `noid_gkr/src/wallet_authorization.rs:L450-L467` and `L381-L397`. `noid_tx/src/native_assets.rs:L560-L600` is `NativeOpening::validate()` and says nothing about authorization.
3. Applied. "What we could NOT determine", 2nd bullet, now states what HistoryStep enforces (`block_slots.rs:L1044-L1067`, `L1083-L1141`, `L929-L930`, root binding `L1180-L1239` and `L1513-L1520`). Only the review-1 component test backs the "confirmed" part; the end-to-end binding stays "read, not tested".
4. Applied. 6th bullet (third party blocking Bob) now describes first-seen / no-RBF behaviour (`pool.rs:L1296-L1297, L1334-L1356`) and points to R1.
5. Applied. §9 gains the `max_fee` < 5,800 permanent-lock sentence after "Liveness risk". Supported by `ObjectRules::validate` (`policy.rs:L34-L39`, mode bits only) and `objects.rs:L247`; the RPC builder's minimum-fee check (`objects.rs:L525-L542`) is at call time, not at creation.
6. Applied. §4 mempool-eviction bullet (L79) gains the D-1 reorg sentence.
7. Applied. §2 "With a raw `s`" bullet gains the `check_call` / `inputs[0].amount` / `creation_id` sentence. Mempool half checked (`pool.rs:L1362-L1408`; `Context::from_body` reads both from the page body, `integer_program.rs:L270, L281`). The HistoryStep half was not traced to a State-slot binding in this pass; it rests on review-1's scratch run.
8. Applied, with one wording change: "submitted now" became "submitted before then", because the report is read after 2026-11-03. Activation height and version switch re-checked at `params.rs:L23, L47-L61`. The "roughly one day from today" remark was a note to the editor and was not copied into the report.

9. Settled by a live run, 2026-11-04. The first "could not determine" item of `swap-cli/REVIEW-1.md` (is the authorization proof bound to the exact `call_height`, or only to its branch?) was answered empirically by live run 1 (`docs/live-run-1.md`): Bob's claim was proved for call height 280,658 (tip 280,657) and the node included it at height 280,659, one block later, and the proof verified. So the proof is bound to the branch and epoch anchor, not to the exact height. One sample, a single-block gap; the eviction rule at the branch flip is unchanged (design §9.3).
