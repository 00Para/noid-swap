# Hostile counterparty: the campaign plan

Status 2026-11-06. Plan only: no live step in it was run, funded or sent (the offline tests for the gaps of section 6 were
written the same day, `swap-cli/tests/hostile_gaps.rs`). Thirteen live runs settled or aborted cleanly
(`live-scenarios.md`), but in every one the operator played both roles, and nobody tried to cheat. This plan lists
every misbehaviour we can think of, says which ones the code already answers offline, and gives the few live runs
that only the real chains can settle. Clock times are UTC. Sources: `live-scenarios.md`, `swap-cli/CHAOS.md`,
`swap-cli/README.md`, `swap-cli/src/engine.rs`, `swap-cli/src/params.rs`, `swap-cli/src/swapfile.rs`,
`swap-cli/tests/`, `eth/test/`, `eth/scripts/live.js`, `scripts/live/`, `runbook-two-party.md`, `protocol-design.md` 8.

Line numbers (`engine.rs:1873`) are those of the working tree on 2026-11-06, checked again after the safety review
below. The engine is being edited and the `engine.rs` numbers drift by tens of lines; if a line has moved, search for
the quoted text (a few places give a function name and an approximate line instead).

Words, once. A *hostile* party breaks the protocol on purpose; the *honest* side runs the tools as written. A *lock
word* is what the Ethereum lock is keyed on: with the `poseidon` lock kind (used since run 5) it is `A = Addr(s)`, the
NOID claim authority itself. *Lock-by* is the last Parano1d height at which Bob may still lock; *cutoff* is the
last moment Alice may reveal (`T_reveal - M_A`); `D` is the height from which the NOID goes back to Alice.

## 1. Purpose and rules

- **Goal.** Show that a counterparty who deviates can cost the honest side only fees and time, and that the honest
  side's tool says the right thing at the right step.
- **Amounts.** `sepolia` profile only (caps 20 NOID and 0.01 ETH, chain 11155111, `swap-cli/src/params.rs:395`). Use
  5 NOID against 0.001 Sepolia ETH, as runs 9 to 13 did. Never mainnet, never the `production` profile.
- **Who sends.** Every command that moves NOID or ETH is run by the operator, after its dry run, with a
  go-ahead in the same sitting. No loop, script or console button sends on its own. A deviation that needs a tool to
  misbehave uses the existing tools' own flags; where no tool can produce it, this plan says "needs a test-only
  script" and does not invent one.
- **One scenario per run folder.** Each live scenario gets its own run number (`export RUN=N`, `install.sh N`), its
  own secret, swap files and contract root. Dry-run checks that spend nothing may be added to any run; they are listed
  with the run.
- **Settings.** Raw variant, contract version 1, lock kind `poseidon`, `AMOUNT=5000000`, as runs 11 to 13. One node per
  chain (`SINGLE_NODE_OK=1`) except where a scenario needs two.
- **Pass.** (a) The honest side ends with what it started with, minus fees (or with the swapped amount, if the swap
  settled); (b) its tool refused or waited at the step this plan names, with the quoted reason (or a text that says
  the same thing); (c) both files end in a terminal phase that agrees with the chains. A different text with the
  same decision is a finding to record, not a failure. A different decision is a failure.
- **Stop at once** when: a tool offers a spend this plan says it must refuse; any figure on screen differs from the
  plan (amount, address, contract root, chain id); a node or endpoint behaves in a way the plan does not describe;
  the wallet shows an instance or a transaction nobody expected. Stopping means: send nothing more, keep ticking
  read-only, and use the abort path of the run (Bob's refund after `T_reveal`, Alice's recovery after `D`).
- **Record.** Per run, a log in the style of `live-run-12.md`: setting, parameters, a timed log, the exact refusal
  texts, costs, findings, and "What it did not show".

Numbers every run shares (`sepolia`, from `params.rs` and `live-scenarios.md` 0): `D = h_create + 300` (about 2 h 30);
Bob's nominal lock-by `D - 251` (`h_create + 49`), hard lock-by `D - 209` (`+91`); `W_A` 4,200 s, `W_A_min` 3,360 s,
`M_A` 1,800 s; Sepolia finality about 19 minutes; Parano1d finality 18 blocks. NOID cost of an abort: funding fee
9,000 plus recovery close 5,800 = 14,800 μNOID. Sepolia gas: a lock about 584,000, a `poseidon` claim about 689,000.

## 2. Scenario table

Columns: **Hostile act** (the concrete command or manual deviation); **Honest tool says** (quoted, with file:line);
**Refused at** (the step); **Worst case** (for the honest side); **Cost** (of trying it, for the hostile side);
**Offline** (tests in `swap-cli/tests` unless marked: `eng` = unit test in `src/engine.rs`, `swf` = in
`src/swapfile.rs`, `par` = in `src/params.rs`, `hns` = `parano1d/harness`, `htlc` / `pv2` / `live.js` = files in
`eth/test`; `CHAOS` = an event class of `swap-cli/CHAOS.md`).

### 2.1 Bob cheats (the ETH holder)

| Id | Hostile act | Honest tool says (Alice) | Refused at | Worst case | Cost | Offline |
|---|---|---|---|---|---|---|
| B1 | Never locks. | `"waiting for Bob's lock"` (`engine.rs:1875`), then `refund_noid` once `tip + 1 >= D` | Alice's reveal is never offered | NOID tied up until `D`, 14,800 μNOID | nothing | `alice_funded_but_bob_never_locks_alice_refunds_at_d`, `sepolia_alice_funded_but_bob_never_locks_alice_refunds_at_d`; live run 4 |
| B2 | Locks after the lock-by, correct terms: `live.js lock` with explicit `--lock-addr --receiver --amount-wei --t-reveal` (no `--swap`; his own file has aborted, so `lock.sh` refuses: `live.js:880`). | Nothing: `alice_check_lock` (`engine.rs:1600`) checks the terms, `W_A_min` and `M_A`, not the lock-by. Alice takes the lock and reveals (pinned by a test, a recorded weakness). | not refused; it harms only Bob (his NOID claim may not fit before `D`) | none for Alice | lock gas, and possibly his 0.001 ETH | Bob's side: `i1_fails_when_bob_locks_too_late` (`par`), `past_the_lock_by_the_note_says_so`; Alice's side: `g1_alice_accepts_and_reveals_on_a_lock_made_after_bobs_lock_by_current_behaviour` (`hostile_gaps.rs`: `eth_lock_seen`, then `eth_lock_final` and `reveal_eth`, no note about the late lock) |
| B3 | Locks the wrong amount: `live.js lock ... --amount-wei 900000000000000`. | note `"lock rejected: amount … wei != agreed …"` (`engine.rs:1602`, `184`), reason `"Bob's lock did not pass the checks"` (`engine.rs:1873`) | Alice's lock acceptance | NOID tied up until `D`, 14,800 μNOID | lock + refund gas | `f10_a_bad_first_lock_does_not_hide_the_correct_second_one`, `bob_does_not_lock_on_a_word_that_his_own_sender_already_locked_but_a_strangers_lock_only_makes_a_note` |
| B4 | Wrong receiver: `live.js lock ... --receiver <not A_eth>`. | The lock is not even found: discovery asks for sender, receiver and lock word together; `"waiting for Bob's lock"` (`engine.rs:1875`). `lock_matches` would also say `"receiver is not A_eth"` (`engine.rs:178`). | Alice's lock discovery | as B1 | lock + refund gas | `alice_discovers_bobs_lock_by_parties_and_hashlock` (discovery); `g2_alice_does_not_take_a_lock_with_another_receiver_or_another_lock_word` and `g2_bob_does_not_take_a_lock_with_another_receiver_or_another_lock_word_as_his_own` (`hostile_gaps.rs`: with the lock put straight into the observation, no `eth_lock_seen`, notes `"lock rejected: receiver is not A_eth"` for Alice and `"a lock exists but is not ours: receiver is not A_eth"` for Bob) |
| B5 | Too-short timelock: `live.js lock ... --t-reveal <block time + 1800>` (below `W_A_min` 3,360 s). | note `"lock rejected: T_reveal … is only 1800 s after its block (timestamp …), less than W_A_min 3360 s (I3)"` (`engine.rs:1612`), reason `"Bob's lock did not pass the checks"` (`engine.rs:1873`) | Alice's lock acceptance | as B1 | lock + refund gas; refund after 30 min | `alice_rejects_a_lock_whose_reveal_window_is_shorter_than_w_a_min` (`eng`); `live.js` "lock rejects bad inputs before sending"; the opposite case, a `T_reveal` far above the engine's bound, is B5 on Bob's side: `g9_bob_adopts_a_hand_made_lock_with_a_t_reveal_far_beyond_the_engines_bound_current_behaviour` (`hostile_gaps.rs`; Bob's file adopts it and Alice's has no upper bound either) |
| B6 | Locks on another contract (the `sha256` HTLC deployment) or another chain (a local chain). | Alice's watcher reads only the pinned contract on the pinned chain; any other is `"node is on chain …"` / `"contract code hash differs from the pinned one (T17)"` (`engine.rs:165`, `170`); otherwise `"waiting for Bob's lock"` (`engine.rs:1875`) | Alice's lock discovery | as B1 | lock + refund gas | `locks_from_the_wrong_chain_contract_or_contract_sender_are_rejected` (`eng`); `live.js` "a chain id that differs from the node's is refused …", "a look-alike contract … is refused" |
| B7 | Another lock word: `live.js lock ... --lock-addr <other 32 bytes>`. | Not found (discovery); `lock_matches` would say `"hashlock differs"` (`engine.rs:175`) | Alice's lock discovery | as B1 | lock + refund gas | `alice_discovers_bobs_lock_by_parties_and_hashlock`; `pv2` "wrong secret, SHA-256 digest as lock, unknown lock, double claim revert …"; the same two tests as B4 with the lock word changed (`"lock rejected: hashlock differs"`, `"a lock exists but is not ours: hashlock differs"`) |
| B8 | Refunds early, before `T_reveal`: `refund-eth.sh` (refused: no `refund_eth` intent, `live.js:880-883`) or `live.js refund --lock-id …` without `--swap`. | live.js: `"too early: timelock is … s to go"` (`live.js:1523`); the contract reverts before the timelock | Bob's own tool, then the contract | none | nothing (refused before sending) | `htlc` "before timelock reverts"; `pv2` "only the sender, only at or after the timelock, never after a claim, never twice"; `live.js` "refuses before the timelock, refunds after" |
| B9 | Claims the NOID without the secret. No tool can build it: `swap-cli claim` needs the secret seen on Ethereum, and a proof without `s` cannot be made with the public API. | the node's verifier rejects the authorization | the node (admission and block proof) | none | needs a modified prover; not attempted | `claim_with_wrong_secret_rejected`, `verifier_rejects_tampered_proof_fields`, `verifier_rejects_proof_bound_to_a_different_transaction` (`hns`); `raw_claim_refuses_bad_inputs_before_proving` |

### 2.2 Alice cheats (the NOID holder)

| Id | Hostile act | Honest tool says (Bob) | Refused at | Worst case | Cost | Offline |
|---|---|---|---|---|---|---|
| A1 | Funds twice: `parano1d-cli contract fund swap.object.json 5.000000` twice (`fund.sh` refuses the second: `"REFUSED: the contract already has 1 instance(s)…"`, `fund.sh:137`). | `"more than one instance at the contract root: … instances at our contract root fit the agreement and the tool will not guess which one is the lock's: …"` (`engine.rs:2647`, `301`) | Bob's lock | none (he never locks) | two fundings, two recoveries | `f10_two_instances_that_both_fit_make_bob_refuse_to_lock_until_one_is_left`, `f10_alice_two_fitting_instances_at_the_root_stop_her_reveal_and_the_swap_ends_by_refund_at_d`, `r4_4_a_first_reveal_still_refuses_two_fitting_instances`, `alice_never_funds_twice_and_a_foreign_instance_is_not_a_reason_to_fund`; live run 9 |
| A2 | Funds the wrong amount: `parano1d-cli contract fund swap.object.json 4.000000` (`fund.sh` refuses: `fund.sh:127`). | note `"instance seen but not accepted: instance holds 4000000 micro-NOID, agreed 5000000"` (`engine.rs:2071`, `311`), `"waiting for Alice's funding"` (`engine.rs:2637`), then abort `"last lock height … passed before Alice's funding was final"` (`engine.rs:2634`) | Bob's acceptance of the funding | none | 14,800 μNOID | `f10_dust_alone_is_still_not_accepted`, `run9_a_single_foreign_dust_instance_gets_the_precise_wording_not_the_run_9_one` |
| A3 | Bundle whose opening pays someone else: `new-alice --bob <another o1>`; the bundle check passes (she computed it). | `new-bob`: `"bundle disagrees with your terms: bob_noid (your NOID payout address)"` (`swapfile.rs:413`, `453`); no file is written | `new-bob` | none | nothing | `bob_refuses_a_bundle_that_disagrees_with_his_terms`, `build_and_check_public_section` (`swf`) |
| A4 | Bundle with another deadline. (a) `new-alice --h-create` far ahead or behind; (b) a hand-built bundle whose `D` is not `h_create + 300` (needs a test-only script: rebuild the opening with another `deadline`, reseal the bundle check). | (a) far ahead: harmless, `D` only delays her own refund; behind: `"last lock height … passed …"` (`engine.rs:2634`) or `"not locking: height … is past Bob's lock-by height …"` (`engine.rs:2690`, `params.rs:570`). (b) `"deadline … != h_create … + 300 (the sepolia profile's D_offset)"` (`swapfile.rs:357`); a deadline changed without the opening: `"opening does not rebuild byte-for-byte …"` (`swapfile.rs:332`) | `new-bob`, or Bob's lock gate | none | nothing | `a_resealed_bundle_reaches_the_later_checks`, `alice_aborts_before_funding_when_too_late_and_bob_walks_away`; for (b) `g3_new_bob_refuses_a_consistent_bundle_whose_deadline_is_not_h_create_plus_the_profile_offset` (`hostile_gaps.rs`: a bundle with a valid check and a rebuilt opening and `D` = `h_create` + 835 is refused with `"deadline 300835 != h_create 300000 + 735 (the production profile's D_offset)"`, no file written) |
| A5 | Bundle with another amount: `new-alice --amount 6000000` while Bob types 5,000,000. (Not 4,000,000: the fee cap of 50,000 is more than 1 % of 4 NOID, so `new-alice` itself refuses, see G3.) | `"bundle disagrees with your terms: amount_micronoid"` (`swapfile.rs:456`) | `new-bob` | none | nothing | the ETH amount case of `bob_refuses_a_bundle_that_disagrees_with_his_terms` (`swf`); the NOID amount case: `g3_new_bob_refuses_a_bundle_whose_noid_amount_is_not_the_one_bob_typed` (`hostile_gaps.rs`; no file, no registry entry) |
| A6 | Never funds. | `"waiting for Alice's funding"` (`engine.rs:2637`), then abort `"last lock height … passed before Alice's funding was final"` (`engine.rs:2634`), recorded by `tick --apply` | Bob never reaches a lock | none | nothing | `alice_aborts_before_funding_when_too_late_and_bob_walks_away`, `f1_the_cli_path_records_the_abort` |
| A7 | Never reveals. | `"waiting for the secret (or T_reveal)"` (`engine.rs:2789`), then `refund_eth` past `T_reveal`, `refund_mined`, `refunded` at Sepolia finality | Bob's refund | Sepolia gas | 14,800 μNOID | `bob_locks_but_alice_never_reveals_both_refund`, `sepolia_alice_never_reveals_both_refund_in_about_317_blocks`; live run 6 |
| A8 | Reveals after the cutoff: `live.js claim --lock-id … --secret-stdin --margin-s 0` without `--swap` (with `--swap` it refuses: `"refusing: past the reveal cutoff …"`, `live.js:1392`). | Bob reads the secret and claims the NOID (`claim_noid`); past `T_reveal` the claim reverts, Bob refunds and may still claim (`--reveal-tx` needed to read a reverted claim, gap G6) | not refused; it harms only Alice | none for Bob | Alice may lose both legs | `alice_reveals_exactly_at_the_cutoff_but_never_one_second_later`, `m25b_alice_loses_both_legs_when_bob_refunds_and_claims_with_the_exposed_secret`, `bob_takes_the_secret_from_a_reverted_claim_and_checks_it_like_any_other_candidate`; `g6_bob_misses_a_secret_that_is_only_in_a_reverted_claim_unless_given_its_hash_current_behaviour` (`hostile_gaps.rs`: without the hash Bob's file sees no secret and offers `refund_eth`; with it, `claim_noid`); `live.js` "refuses past the cutoff the file froze, also with --margin-s 0 and --dry-run" |
| A9 | Reveals and at once tries the recovery close before `D`. | `recover-noid.sh`: a preview before `D` `"says 'not a recovery' and is refused"` (`recover-noid.sh:3`); the node refuses a recovery authority before `D` | the node | none | nothing | `refund_before_deadline_rejected`, `verifier_binds_proof_to_the_branch_at_the_inclusion_height` (`hns`); `f9_alice_does_not_refund_before_d_after_the_reveal_and_never_a_different_instance` |

Alice's other early-close option (she knows `s`, so she can close on the claim branch) is T1 and T2 below: such a
close must pay Bob.

### 2.3 Third parties and the chains

| Id | Hostile act | Honest tool says (Bob) | Refused at | Worst case | Cost | Offline |
|---|---|---|---|---|---|---|
| T1 | Someone who read the secret from the reveal closes first at the minimum fee (it still pays Bob): the stalled-claim case. | while pending: `"a close by someone else is pending on the instance (…); it pays B_noid if valid; proving again only after it is evicted (T2)"` (`engine.rs:2296`); once mined: `"the instance is gone but no tracked transaction closed it; verify the contract receipts manually"` (`engine.rs:2285`); then `tick --closed-by TXID --apply` | Bob's own claim waits | under congestion the rival can sit until eviction at an anchor rotation or `D`; Bob then loses the NOID (Q1, `protocol-design.md` T2) | 5,800 μNOID, paid from the instance | `bob_does_not_reprove_into_a_foreign_pending_close`, `m25d_bobs_claim_made_elsewhere_is_recorded_then_follows_to_done`, `f5_bob_keeps_waiting_on_a_pending_close_without_a_usable_second_opinion`; `g12_closed_by_is_accepted_for_a_bob_file_whose_decision_is_claim_noid` (`hostile_gaps.rs`); CHAOS "third party closes to Bob at minimum fee" |
| T2 | A close to Bob at `max_fee` (the burn, T1 of the design). | as T1 | none: it is a valid close | Bob loses up to `max_fee` (50,000 μNOID) | none to the closer | `fee_capped_by_max_fee`, `close_must_pay_committed_recipient` (`hns`); CHAOS invariant 5 |
| T3 | Two closes of one slot: the first seen wins, no replace-by-fee. | Bob's later close is rejected by the node; T1 texts | the node's mempool | as T1 | none | CHAOS ("starved in the mempool"; the simulator has one mempool), `bob_reproves_after_his_claim_is_evicted` |
| C1 | An epoch rotation while Bob's claim is pending. | `"epoch anchor rotates in N block(s); proving after the boundary (T6)"` (`engine.rs:2313`); after an eviction Bob proves again | Bob's claim timing | claim later, still before `D - 18` by (I1) | none | `epoch_anchor_and_rotation_guard` (`par`), `bob_reproves_after_his_claim_is_evicted`; CHAOS "pending calls evicted" |
| C2 | A reorg of Bob's lock block on Ethereum. | Alice reveals only on a lock in a finalized block; Bob re-sends the same lock id after a drop | Alice's reveal gate (finality) | none | none | `f5_a_lock_transaction_that_was_dropped_is_sent_again_only_when_nothing_of_the_signer_is_pending`, `m25b_bobs_refund_reorged_out_returns_to_locked_and_is_sent_again`; CHAOS |
| C3 | A reorg of Alice's reveal. | Alice's file never says `done` on a dropped claim; she re-sends until `T_reveal - DE` | Alice's `done` | none if re-sent in time | none | `f9_a_claim_that_a_reorg_dropped_never_reaches_done`, `f9_a_claim_that_moved_to_a_later_block_restarts_the_finality_count` |
| C4 | A Parano1d reorg of the funding or of Bob's claim. | Funding finality restarts when the instance is absent from a poll; a dropped claim is proved again | Bob's lock (funding final) | none | none | `f3_a_funding_that_left_the_chain_and_came_back_is_counted_from_its_return`, `f6_a_claim_reorged_out_and_gone_goes_back_to_secret_seen_and_is_proved_again` |
| C5 | A node that lags, or a second node that cannot be read. | `"the second node could not be read (…): it must agree before this step (F5)"` (`engine.rs:977`); `"… trails the clock by … s … the node lags (F5)"` (`engine.rs:927`, `933`); while Bob waits for the secret: `"ALARM, THE ETHEREUM NODE LAGS"` (`engine.rs:2785`) | Bob's lock, Alice's reveal | none (a wait) | none | `f5_a_second_noid_node_that_cannot_be_read_blocks_the_lock_with_the_reason`, `f5_a_lagging_second_noid_node_blocks_the_lock_until_the_tips_are_within_two_blocks`, `f5_a_stale_ethereum_head_blocks_the_lock_and_the_reveal_outside_the_rehearsal_profile`, `r4_8_bob_waiting_for_the_secret_raises_an_alarm_when_the_ethereum_node_lags` |
| C6 | A node that lies (shows a funding, a lock or a secret that is not on the chain). | With two nodes: `"the two eth nodes disagree about the lock …"` (`engine.rs:1063`) and the Parano1d equivalents; a wrong secret is checked against the lock word and dropped (`"preimage seen but rejected"`, `engine.rs:2241`). With one node (`SINGLE_NODE_OK`) a consistent lie is believed: that is why a stranger needs two nodes. | Bob's lock, Alice's reveal (two nodes only) | one node: the lie decides; two nodes: a wait | needs a test-only script (see L7) | `f5_a_second_noid_node_that_shows_another_instance_or_none_blocks_the_lock`, `f5_a_second_eth_node_with_another_lock_record_blocks_the_reveal`, `hostile_node_output_is_a_decode_error_never_a_panic`, `r4_8_a_wrong_secret_on_one_node_does_not_hide_the_right_one_on_the_other` |
| D1 | A damaged bundle. | `new-bob` refuses it before anything else, nothing is written | `new-bob` | none | nothing | `a_damaged_bundle_is_refused_before_anything_else_and_nothing_is_written`; live runs 11 and 13 |
| D2 | A replayed bundle (a finished swap's bundle offered again). | `new-bob` accepts it (it is valid; pinned by a test), then Bob's first tick aborts with `"last lock height … passed before Alice's funding was final"` (`engine.rs:2634`) even with an old `Locked` log of his sender on the word; a lock would also be refused because his own sender already locked that word (`engine.rs:2556`). A second `new-bob` of the same bundle into the same folder: `"… already exists; never overwrite a swap file"` for the same path, `"hashlock already used by another swap (T9)"` for another file name | Bob's first tick; `new-bob` (same folder) | none | nothing | `g4_a_bundle_given_to_new_bob_twice_into_one_folder_is_refused_the_second_time`, `g4_the_first_tick_of_a_replayed_bundle_is_an_abort_not_a_lock` (`hostile_gaps.rs`) |
| D3 | A second swap that reuses a secret (same lock word). `new-alice` always draws a fresh secret, so this needs a test-only script (a bundle built around an old `A`). | `poseidon`: `"… Locked log(s) of the pinned contract made by Bob's own sender already carry this lock word A …, so Bob does not lock on it again"` (`engine.rs:2556`); a lock word first locked by someone else gives only a note | Bob's lock | none for Bob: a public secret lets anyone close the NOID, but only to Bob | nothing | `hashlock_registry_refuses_reuse` (`swf`), `bob_does_not_lock_on_a_word_that_his_own_sender_already_locked_but_a_strangers_lock_only_makes_a_note`; `live.js` "a second lock from the same sender with the same hashlock but another timelock is refused …". The registry is per folder: `g5_the_same_bundle_into_two_folders_is_not_caught_by_the_default_registry_current_behaviour` (`hostile_gaps.rs`) shows the same bundle accepted into two folders (a recorded weakness, defence in depth) |

Counts: 30 scenarios (9 Bob, 9 Alice, 3 third party, 6 chain and node, 3 bundle). Since the tests of `swap-cli/tests/hostile_gaps.rs`
(11 tests, written for the gaps of section 6) 29 have a direct offline test and 1 is covered only in part (T3: the simulator has one mempool).
Before that file: 23 direct, 6 in part (B2, B4, B7, A4, A5, T3), 1 none (D2). Four of the new tests pinned a recorded weakness (names ending in
`_current_behaviour`: B2/G1 and, of low impact, A8/G6; B5/G9 and D3/G5 were fixed afterwards and their tests now assert the fixed behaviour); see section 6. The table names 78 distinct tests (69 in Rust,
9 in `eth/test`), plus the chaos campaign of `CHAOS.md` and live runs 4, 6, 9, 11 and 13 where they apply.

## 3. Which scenarios need a live run

A live run is worth its cost only for what a simulator cannot show: the real mempool (first seen wins, eviction at
a rotation), the real anchor timing, the relay floor, real provider lag, real finality, and real node answers to
odd states (an instance of another amount, a lock with odd terms, a close made by someone else).

| Scenario | Live? | Why |
|---|---|---|
| A6 (never funds) | yes, L1 | Bob's abort before any lock was never seen on the real nodes (`live-scenarios.md` 1+2 and 9 left it open) |
| A2 (wrong amount) | yes, L2 | the real instance listing with another amount, the recovery of an instance `recover-noid.sh` will not take |
| B5 (short timelock), B8 (early refund, dry run) | yes, L3 | Alice's I3 check on a real block timestamp; Bob's tool facing a lock of his own sender made outside it |
| T1 (third-party close), A9 (dry run) | yes, L4 | a real close by another party, Bob's real tool reading it, `--closed-by` for Bob live |
| C5 (second node down) | yes, L5 | the tunnel killed at the lock tick (`live-scenarios.md` 8, the part that did not run) |
| C1 (rotation) | yes, L6 | real anchor boundaries; `live-scenarios.md` 6 |
| T2, T3, C6 | later, L7 | need a fee override, an isolated node or a lying node, none of which exists as a tool |
| B1, A1, A7, D1 | already live | runs 4, 9, 6, 11 and 13 |
| B2, B3, B4, B6, B7, B9, A3, A4, A5, A8, C2, C3, C4, D2, D3 | no | settled offline, or not producible on real chains on demand (reorgs), or no new live information beyond L3; A3 to A5 and D2 can be checked at the desk with no funding (L0) |

## 4. The live campaign, in order

Common to every run: the per-run setup of `live-scenarios.md` 0 and `runbook-two-party.md` (install, setup, prepare,
object check, bundle carried as a file and its `bundle check:` line compared on both machines, `new-bob` on Bob's
machine), the watch loop on each machine (`watch.sh alice 30` on Alice's machine, `watch.sh bob 30` on Bob's machine),
and the GO / NO-GO of `live-scenarios.md` 0. Note the contract root and the Sepolia contract link at every
run. Run numbers below assume the order holds: the next free number is 14.

Abort paths, always available: Bob's `refund-eth.sh --dry-run`, then `refund-eth.sh` (Bob's machine) once his loop
says `refund_eth` (after `T_reveal`); Alice's `recover-noid.sh --dry-run`, then `recover-noid.sh`, then
`tick.sh alice --closed-by TXID --apply` (Alice's machine) once `tip + 1 >= D`. An instance of another amount: see L2
step 4 (`recover-noid.sh` compares the payout with `AMOUNT`, so it needs `AMOUNT` set to that amount; the fallback is the
chained wallet command of `live-scenarios.md` 0).

### L0. Desk checks, no run number, nothing on chain

On Alice's machine, in a scratch folder, `swap-cli new-alice` with the run settings but (a) `--bob <an address that is
not Bob's>`, (b) `--amount 6000000` (not 4,000,000: the fee cap of 50,000 is more than 1 % of 4 NOID and `new-alice` itself
refuses, see G3). Carry each bundle to Bob's machine and run `swap-cli new-bob` with Bob's own terms (`--bob`,
`--amount 5000000`, …) into a scratch folder of its own, not the folder of Alice's file on the same machine (her
`new-alice` registered the hashlock there, and `new-bob` would refuse it as reused).
- Expected: (a) `"bundle disagrees with your terms: bob_noid (your NOID payout address)"` (`swapfile.rs:453`); (b)
  `"bundle disagrees with your terms: amount_micronoid"` (`swapfile.rs:456`). No file written. Never fund these.
- D2: on Bob's machine, `new-bob` on the run-12 bundle into a fresh scratch folder (with `--eth-lock-kind poseidon`;
  `new-bob` runs the client R self-test, which sends nothing), then one read-only `tick.sh`-equivalent
  `swap-cli tick FILE --transport curl --noid-rpc … --eth-rpc … --eth-from-block N --single-node-ok`
  (`--transport curl` because the Sepolia endpoint is https; `--eth-from-block` is given once on a live non-local
  chain, per the `tick` usage in `swap-cli/src/main.rs`, and is the deploy block of the contract, the content of
  `eth-deploy-block.txt` of a run folder).
  Expected (pinned offline by `g4_the_first_tick_of_a_replayed_bundle_is_an_abort_not_a_lock`): `new-bob` accepts; the tick
  says `abort` with `"last lock height … passed before Alice's funding was final"` (`engine.rs:2634`). Do not pass
  `--apply`. Record what `new-bob` said.
  The scratch Bob file of this check is built from a real swap whose secret is already public (run 12): it must never
  be used for anything but this read-only check (no `lock.sh`, no `refund-eth.sh`, no `claim.sh`, no `--apply`).
- `--closed-by` while a `claim_noid` is held (needed by L4 step 5): the existing test
  `tick_closed_by_records_an_outside_claim_only_with_apply_and_refuses_everything_doubtful` (`swap-cli/tests/cli_live.rs`,
  near line 574) uses a Bob file at `secret_seen` and does not say whether the loop had already decided `claim_noid`.
  Now pinned by `g12_closed_by_is_accepted_for_a_bob_file_whose_decision_is_claim_noid` (`hostile_gaps.rs`, library calls
  in the order the binary makes them): the file in `secret_seen` whose decision is `claim_noid` accepts the close, goes to
  `claim_included` and 17 blocks later to `done`. `claim_noid` is not an intent kind, so no intent is held for it.
- Record the texts. Cost: none.
- Afterwards delete the scratch files (the scratch folders of this check, the bundles, the Bob and Alice scratch swap
  files and their sealed secrets): none of them is a swap that may be run.

### L1 (run 14). A6: Alice prepares and never funds

- Proves: Bob's tool ends `aborted` on real nodes without any spend.
1. Alice's machine: setup, prepare, object check as usual. Hand over the bundle. **Do not run `fund.sh`.**
2. Bob's machine: `new-bob`, then `watch.sh bob 30`. Expected loop: `wait` "waiting for Alice's funding"
   (`engine.rs:2637`), with the lock-by margin note.
3. Alice's machine: first check what her loop did. Once the tip is at `h_create - 1` or later, `watch.sh alice 30`
   (which applies) has recorded a `fund_noid` intent, because the engine offers the funding and `tick --apply` freezes
   it. A held `fund_noid` intent keeps the abort from being recorded (`spend_may_be_in_flight`, `engine.rs` near line
   3071): the file stays `created` over a funding the chain has not shown. Look at `swap-cli intent ALICE_FILE --show`.
   If an intent is held, make sure nothing was funded (the wallet shows no pending funding, `contract instances` lists
   no instance), then drop it with
   `swap-cli intent ALICE_FILE --cancel --transport curl --noid-rpc URL --eth-rpc URL --i-checked-the-wallet`
   (the same chain flags as `tick`, `--single-node-ok` and `--eth-from-block` as in the run's other ticks; the node
   cannot list a funding in its mempool, so a `fund_noid` intent is cancelled only with `--i-checked-the-wallet`,
   `swap-cli/src/main.rs` usage and `cancel_intent_checked`, `engine.rs` near line 3171). The cancel is refused while
   the intent is younger than the profile's `min_cancel_age_s` (600 s on `sepolia`), and afterwards the abort stays
   back for `abort_after_cancel_s` (3,600 s on `sepolia`): add up to an hour to this run. Alternative that avoids the
   cancel: tick Alice's file without `--apply` (a read-only tick records no intent) until the abort text appears,
   then apply once. Expected: `wait`, then once the funding could no longer be final before the lock-by, `abort`
   "too late to fund: tip … > lock-by …" (`engine.rs:1851`), recorded, file `aborted`.
4. Bob's machine, at `h_create + 92` or later: `abort` "last lock height … passed before Alice's funding was final"
   (`engine.rs:2634`), recorded by `tick --apply` (no intent is held), file `aborted`, loop stops.
5. Bob's machine, after that: `lock.sh --dry-run`. Expected refusal from `live.js`: the file has no `lock_eth` intent
   (`live.js:880`).
- Abort path: none needed. Cost: nothing. Duration: about 50 minutes from `h_create`, up to an hour more if a held
  intent had to be cancelled.
- Record: both final phases, the two abort texts, the tip at each, whether Alice's loop had recorded a `fund_noid`
  intent and how it was dropped.

### L2 (run 15). A2: Alice funds the wrong amount

- Proves: Bob's tool refuses a real instance of another amount; Alice's NOID comes back by hand.
1. Alice's machine: setup, prepare, object check. `fund.sh --dry-run` (expected OK for 5 NOID). Then the deviation.
   This is the ONE documented exception to the project's rule that a funding goes only through `fund.sh`: `fund.sh`
   refuses an amount that differs from the swap file's (`fund.sh:127`), and that difference is the scenario, so the
   wallet CLI is called directly. Guards: (a) run `contract instances` for the object file first; it must print
   nothing (no instance, exit 0); (b) send it exactly ONCE, after the go-ahead, and never repeat it, even if the output
   looks odd (check the txid and `contract instances` instead); (c) use the form `fund.sh` builds, so the same object
   goes to the same wallet: under WSL the Windows wallet CLI `.exe` (`NOID_CLI`, default set at the top of `fund.sh`)
   with the Windows path of the object file (`wslpath -w`), standard input from `/dev/null`:
   `"$NOID_CLI" contract fund "$(wslpath -w swap.object.json)" 4.000000 < /dev/null`
   (native mode: `parano1d-cli contract fund swap.object.json 4.000000`). No marker is written by this command, so
   write down the time and the txid yourself. Note the txid.
2. Bob's machine: loop. Expected: note `"instance seen but not accepted: instance holds 4000000 micro-NOID, agreed
   5000000"` (`engine.rs:2071`, `311`), action `wait` "waiting for Alice's funding"; after `h_create + 91`, `abort`
   "last lock height … passed before Alice's funding was final", file `aborted`. `lock.sh --dry-run` refuses (no
   intent).
3. Alice's machine: loop. Expected: `wait` with `"an instance of 4,000,000 micro-NOID sits at our contract root; it is
   not the agreed one (…) and is not counted as a funding; not funding until the contract state has been checked"`
   (`engine.rs:374`); later `abort` with the note that the tool will not close it (`engine.rs:396`, `403`).
4. Alice's machine, at `tip + 1 >= D`: the recovery of an instance of another amount. Reading `recover-noid.sh`: its
   preview check requires the payout to be `AMOUNT - fee` (the python check, "payout … is not amount - fee"), so with
   `AMOUNT=5000000` it refuses the 4 NOID instance and goes on (exit 1). `AMOUNT=4000000 recover-noid.sh` on the
   command line does NOT help: `env.sh` takes `AMOUNT` from the environment first and then sources `env.local.sh`
   (`env.sh` lines 97 and 111), which sets `AMOUNT` again. What works, to be confirmed by the dry run at `D` (a
   preview before `D` is refused as "not a recovery", so it cannot be tried earlier): put `AMOUNT=4000000` as the LAST
   line of `env.local.sh` for the duration of the recovery, run `recover-noid.sh --dry-run` (expected: `preview ok`,
   payout `4000000 - fee`), then, after the go-ahead, `recover-noid.sh`, then put `AMOUNT=5000000` back. If the dry run
   still refuses, the fallback is the manual preview-and-send of `scripts/live/README.md` ("Alice's recovery close"
   and `live-scenarios.md` 0): `contract instances` for S and C, then preview and send chained in ONE command with
   `--expected-txid` (the preview must show `"recovery": true`, `"terminal": true`, authority Alice, payout to Alice,
   fee <= `max_fee`). Then `tick.sh alice --closed-by TXID --apply` (expected: refused or a note, since the file never
   accepted this instance; record which).
- Abort path: this run is the abort path. Cost: 9,000 + 5,800 μNOID. Duration: about 2 h 40.
- Record: the instance listing, every refusal text, the recovery receipt.

### L3 (run 16). B5 and B8: Bob locks with a too-short timelock

- Proves: Alice's (I3) check on a real lock; Bob's tool with a lock of his own sender made outside it; an early
  refund refused.
1. Both machines: setup to funding as in run 12, `fund.sh` (go-ahead). Loops on.
2. Bob's machine: when the loop first says `lock_eth`, do NOT run `lock.sh`. Note that by then `watch.sh` has already
   recorded a `lock_eth` intent with the tool's own `T_reveal` (about `W_A` ahead); the hand-made lock below has another
   one (see step 4). Read the lock word with `swap-cli status bob.swap.json` (field `hashlock`) and the latest Sepolia
   block time. Then, from `eth/`, load `env.local.sh` (or type the values) for `$CONTRACT`, `$ALICE_ETH` and
   `$GAS_PRICE_GWEI`, and make sure the Ethereum endpoint variable `ETH_RPC_URL` (the one `live.js` reads; the helpers
   set it from `ETH_RPC` in `env.sh`) points at Sepolia, not at a local chain:
   `node scripts/live.js lock --key-file keys/bob.key --contract $CONTRACT --chain-id 11155111 --lock-kind poseidon --lock-addr 0x<A> --receiver $ALICE_ETH --amount-wei 1000000000000000 --t-reveal <block time + 1800> --gas-price-gwei $GAS_PRICE_GWEI --dry-run`.
   Check every value. In particular the dry run must show `T_reveal` minus the latest block time of about 1,800 s: stop
   if it is larger (never more than about one hour ahead, see "Must NOT be run live"). Then the same without
   `--dry-run`, after the go-ahead. Note the lock id.
3. Alice's machine: loop. Expected note `"lock rejected: T_reveal … is only 1800 s after its block (timestamp …),
   less than W_A_min 3360 s (I3)"` (`engine.rs:1612`), action `wait` "Bob's lock did not pass the checks"
   (`engine.rs:1873`). `reveal.sh --dry-run` must refuse (no `reveal_eth` intent). This must hold until `D`.
4. Bob's machine: loop. Expected (to be confirmed by a test): the file adopts the lock, since in `funding_final`
   any lock of his sender on the agreed terms is taken whatever its `T_reveal` (`bob_fact`, `engine.rs:2083-2116`), and
   shows `locked`, `"waiting for the secret (or T_reveal)"`. If it does not adopt it: `"a lock exists but is not
   ours: …"` (`engine.rs:2096`), then the own-word refusal (`engine.rs:2556`) and an abort after the lock-by. Which of
   the two happens depends on the phase when the lock lands (`funding_final` with the `lock_eth` intent still pending,
   or `lock_submitted`, which looks for the intent's own lock id): record which. If the file adopts the lock while the
   `lock_eth` intent is still pending, a `refund_eth` due later may be held behind it ("held: a refund_eth is due, but
   a lock_eth intent is still pending"); then step 6 uses the explicit `live.js refund`. Also record that
   `eth/scripts/live.js` blocks a second lock from the same sender under the same hashlock (the "refusing: a Locked
   event for hashlock … from this sender … already exists" check, near line 1161), so `lock.sh` cannot add another
   lock after the hand-made one.
5. Bob's machine, before the 30 minutes are up (B8): `refund-eth.sh --dry-run` (expected: refused, no `refund_eth`
   intent) and `node scripts/live.js refund --key-file keys/bob.key --contract $CONTRACT --chain-id 11155111
   --lock-kind poseidon --lock-id 0x<id> --gas-price-gwei $GAS_PRICE_GWEI --dry-run` (expected
   `"too early: timelock is … s to go"`, `live.js:1523`).
6. Bob's machine, after `T_reveal`: if the file adopted the lock, `refund-eth.sh --dry-run`, go-ahead,
   `refund-eth.sh`; otherwise the explicit `live.js refund` above without `--dry-run`, go-ahead.
7. Alice's machine, at `tip + 1 >= D`: `recover-noid.sh --dry-run`, go-ahead, `recover-noid.sh`, `--closed-by`.
- Abort path: steps 6 and 7 are the abort path. Cost: lock + refund gas, about 730,000 gas in all (a lock is about
  584,000 gas in runs 11 to 13, a refund about 146,000 in run 9), so about 0.00073 Sepolia ETH for each gwei of gas
  price (about 0.0006 ETH for the lock alone at 1 gwei); 14,800 μNOID. Duration: about 2 h 40.
- Record: the I3 text with the real block timestamp, Bob's file phases, both refusals of step 5.

### L4 (run 17). T1 and A9: a third party closes to Bob first

- Proves: a close made by someone other than Bob, from the secret Alice published, pays Bob; Bob's real tool reads
  it and records it with `--closed-by`. The third party is the copy of Bob's file that `prepare.sh` made on Alice's
  machine (`$L/bob/bob.swap.json`); the bundle and Bob's terms are not secret, so any observer could do the same.
1. Both machines: the run-12 sequence up to Alice's reveal (fund, Bob's `lock.sh`, Alice's `reveal.sh`, each with a
   dry run and a go-ahead).
2. Alice's machine, right after the reveal is mined (A9, dry run only): `recover-noid.sh --dry-run`. Expected: the
   preview is refused before `D` (`recover-noid.sh:3`). Nothing is sent.
3. Bob's machine: the loop shows `claim_noid`. **The operator does not run `claim.sh --submit` on Bob's machine.**
4. Alice's machine (the third party). The copy starts at `received`, and the funding finality is counted from the
   copy's own first tick (`bob_fact`, `engine.rs`: `received` records the instance at the tip of that tick, `funded`
   needs 18 further blocks, `engine.rs` near lines 2069 and 2081). So start ticking the copy only AFTER Bob's real lock is
   mined: the copy then records no `lock_eth` intent of its own and adopts the real lock when its funding is final
   (about 9 minutes, shorter than the 19 minutes Alice waits for Sepolia finality of the lock before she reveals; the
   own-word check at `engine.rs:2556` would also refuse a second lock, but do not rely on it). **Never run `lock.sh` or
   `refund-eth.sh` on the copy; the only spend from the copy is `claim.sh`.** Then `tick.sh bob --apply` until it shows
   `claim_noid`, then `claim.sh` (dry run: recipient Bob's `o1`, fee 5,800), go-ahead, `claim.sh --submit`. Note the txid.
5. Bob's machine: loop. Expected, while pending: `"a close by someone else is pending on the instance (TXID); it pays
   B_noid if valid; proving again only after it is evicted (T2)"` (`engine.rs:2296`); once mined: `"the instance is
   gone but no tracked transaction closed it; verify the contract receipts manually"` (`engine.rs:2285`). On an idle
   chain the close can be mined within the 30 seconds between two ticks, so the "pending" text may never appear:
   record it as "not observed", not as a failure. Stop the loop, then `tick.sh bob --closed-by TXID --apply`; expected
   `claim_included`, then `done` at finality. This must work while Bob's file holds the `claim_noid` step (desk check
   in L0).
6. Alice's machine: her own file follows her claim to `done` as usual.
- Abort path: if the third-party close is not mined within a few blocks, Bob's own `claim.sh --submit` after it is
  evicted (the tool says when); if neither lands before `D - 18`, Alice recovers at `D`. Cost: as a normal swap.
  Duration: about 50 minutes. The mempool stall itself (Q1) is not shown: on an idle chain the close is mined in one
  or two blocks.
- Record: whether Bob's tool saw the close pending, the exact texts, Bob's net payout (amount - 5,800).

### L5 (run 18). C5: the second node goes away at Bob's lock

- Proves the fail-closed half of `live-scenarios.md` 8. Two nodes per chain, no `SINGLE_NODE_OK`, the tunnel of
  `mac-setup.md` 6.
1. As run 12 to `funding_final` on Bob's machine.
2. Just before the tick that would offer `lock_eth`: stop the tunnel. Bob's machine, expected: `wait` with `"the
   second node could not be read (…): it must agree before this step (F5)"` (`engine.rs:977`). `lock.sh --dry-run`
   refuses (no intent). Keep it down for at least three ticks. If the `lock_eth` intent was already recorded before the
   tunnel went down, `lock.sh --dry-run` will not refuse: record that, it is not a failure of the rule (the rule
   gates the offer of the step, not a step already recorded).
3. Restore the tunnel; the next tick offers `lock_eth`. Continue the run-12 sequence to the end.
- Abort path: if the tunnel cannot be restored before the hard lock-by (`h_create + 91`), Bob does not lock and the
  run ends as run 4 (Alice's `recover-noid.sh` at `D`). Cost: as a normal swap. Duration: about 1 hour.

### L6 (run 19). C1: an epoch rotation around Bob's claim

Run `live-scenarios.md` 6 as written, on raw v1 `poseidon`: pick the boundary `B` (a multiple of 144), set `HC_LEAD`,
fund promptly, delay `reveal.sh` until `tip >= B - 6` (still well before the cutoff), and expect Bob's `claim.sh`
dry run at `B - 3` to say `"epoch anchor rotates in N block(s); proving after the boundary (T6)"` (`engine.rs:2313`);
after `B + 1`, go-ahead, `claim.sh --submit`. Pass: the claim's call height is above `B` and final before `D - 18`.
Abort path: the run-6 one. Cost: as a normal swap.

### L7. Later, not scheduled: T2, T3, C6

- T2 (close at `max_fee`) and T3 (first-seen conflict): `live-scenarios.md` 7. For the raw variant there is no tool
  that closes at a chosen fee: **needs a test-only script**, a copy of `swap-cli claim` with a `--fee` that must lie
  in `[5,800, max_fee]`, used only by the third party. T3 also needs an isolated, synced node with peers off.
- C6 (lying node): **needs a test-only script**, a loopback JSON-RPC proxy that rewrites one answer (for example
  removes a `Locked` log or changes an instance amount), run only against a local chain with the `rehearsal` profile,
  never on Sepolia with real swap files.

## 5. Safety review of this plan

Why each live run cannot lose more than fees:

- **L0.** Nothing is funded or sent; the refused bundles never reach a contract.
- **L1.** No funding and no lock: nothing is at stake.
- **L2.** The 4 NOID sit at a contract whose opening pays Bob's own address on the claim branch and Alice's on the
  recovery branch; no lock is made, so Alice never reveals and the claim branch cannot be used. The recovery branch
  opens at `D` with no dependency on Bob (consensus rule, `q2-history-step.md`). Back by `D` + 18 blocks.
- **L3.** Bob's ETH sits in a lock only he can refund, from its own `T_reveal` (30 minutes). Alice's tool rejects the
  lock, so the secret is never published and no one can claim it. Alice's NOID comes back at `D`. The hand-made lock
  must have a short `T_reveal`: a long one is adopted by Bob's tool with an ALARM note (gap G9: refusing it would leave Bob without a claim path) and would let Alice reveal past the
  time Bob can still get a claim final before `D`; the dry run is checked for the 1,800 s before anything is sent.
- **L4.** Every close before `D` must pay `claim_recipient` = Bob (`check_call` and the block proof, Q2 CONFIRMED), with
  a fee of at most `max_fee`. The third party can only choose the fee (5,800 here) and the moment. Alice's reveal goes
  through the normal gates. Worst case: Bob receives `amount - max_fee`. The third-party copy is a file with Bob's
  terms and sender: it is ticked only after the real lock is mined and its only spend is `claim.sh`, so it cannot
  lock or refund anything.
- **L5.** A missing node only makes the tool wait. If Bob never locks, run 4's abort applies.
- **L6.** The reveal stays inside the cutoff; the guard only delays Bob's proof by a few blocks; (I1) budgets a
  full epoch, so the claim lands before `D - 18`.

Must NOT be run live:

- **Funding a contract whose opening pays a third party** (A3 with a funding). Once the secret is public, anyone can
  close it to that address. L0 stops at `new-bob`.
- **A reveal while the NOID side is not safely claimable by Bob**: after a late lock (B2), with two fitting instances
  (A1 after the reveal), after `T_reveal` (A8: the claim reverts and still publishes the secret), or close to `D`.
  These publish the secret where Bob may not be able to use it; the offline tests settle them.
- **Bob's lock to a receiver the operator does not control** (B4 with a foreign address): the ETH would be one leaked
  secret away from a stranger. Offline only.
- **A second swap on a reused secret** (D3): the old secret is public, so the new instance would be closable by anyone
  from the start (to Bob, but with any fee up to `max_fee`). Offline only.
- **Contract version 2** in any hostile run: never reviewed independently (`htlc-v2-fixed-fee.md` 6); a rejected close
  would leave the instance with no working branch.
- **The public test vector, the `refundable_payment` template, mainnet, the `production` profile**: hard rules of the
  project; a hostile run changes none of them.
- **A rewriting or lying proxy against Sepolia** (C6): it could make a tool act on a false view with real funds.
- **A hand-made lock whose `T_reveal` is more than about one hour ahead** (L3 uses 1,800 s after the block). Bob's tool
  adopts such a lock with an ALARM note on every tick (gap G9: the lock is adopted with an ALARM note, refusing it would leave Bob without a claim path: review finding), and Alice's check has no upper bound, so with a long one she may
  reveal at her cutoff past the time Bob can still get a claim final before `D`, and Bob could lose the ETH while
  Alice recovers the NOID.
- **Any spend from the third-party copy of Bob's file other than `claim.sh`** (L4): the copy holds a real swap's
  terms; `lock.sh` or `refund-eth.sh` on it would send real ETH from Bob's key on a file nobody is watching.
- **A second raw funding** (L2 step 1): the raw `contract fund` is the one documented exception and it is made once.
  A second one makes a second instance (run 9).

## 6. Gaps: behaviours that had no offline test and no safe live procedure

Each with the fixture, the expected engine answer and, where one was written, the test. G1 to G6, G9 and G12 were pinned on
2026-11-06 by `swap-cli/tests/hostile_gaps.rs` (11 tests, no change to `swap-cli/src` at the time; G5 and G9 were fixed afterwards and their tests were rewritten for the fixed behaviour): each test asserted what the engine did then,
and a name ending in `_current_behaviour` marks a recorded weakness, not a wanted behaviour. G7, G8, G10 and G11 are not in that
file (reasons below).

- **G1 (B2).** Alice facing a lock made after Bob's lock-by. Fixture: Alice in `funding_final`, a lock on the agreed
  terms mined at a Parano1d tip above the last lock height, `T_reveal` with a full window. Review verdict (2026-11-06):
  real. Alice's lock check and reveal gate look at neither Bob's lock-by nor `D`. It can only harm Bob, whose own tool
  refuses to lock late. Pinned by `g1_alice_accepts_and_reveals_on_a_lock_made_after_bobs_lock_by_current_behaviour`
  (both lock kinds): Alice's tick records `eth_lock_seen`, waits for finality, then records `eth_lock_final` and offers
  `reveal_eth`, with no note about the late lock; Bob's own tool at the same height aborts ("not locking: … past Bob's
  lock-by height"). RECORDED WEAKNESS; whether a note "Bob locked after his lock-by; his claim may not fit before D" or a
  refusal is wanted is a later decision.
- **G2 (B4, B7).** A lock with another receiver or another lock word put directly into `eth.lock` (bypassing
  discovery). Pinned by `g2_alice_does_not_take_a_lock_with_another_receiver_or_another_lock_word` (both kinds) and
  `g2_bob_does_not_take_a_lock_with_another_receiver_or_another_lock_word_as_his_own` (`sha256`; the `poseidon` kind adds the
  own-word refusal, covered by `bob_does_not_lock_on_a_word_that_his_own_sender_already_locked_but_a_strangers_lock_only_makes_a_note`).
  Observed, as wanted: Alice: no event, file stays `funding_final`, notes `"lock rejected: receiver is not A_eth"` and
  `"lock rejected: hashlock differs"`, reason `"Bob's lock did not pass the checks"`. Bob: no `eth_lock_seen`, notes `"a lock
  exists but is not ours: receiver is not A_eth"` and `"… hashlock differs"`, and the action is his own `lock_eth`.
- **G3 (A4, A5).** A self-consistent bundle whose opening was rebuilt with `D != h_create + offset` and a valid check;
  and a bundle whose NOID amount differs from Bob's `--amount`. Pinned by
  `g3_new_bob_refuses_a_consistent_bundle_whose_deadline_is_not_h_create_plus_the_profile_offset` and
  `g3_new_bob_refuses_a_bundle_whose_noid_amount_is_not_the_one_bob_typed`. Observed, as wanted: `new-bob` prints `bundle check:
  … ok` and then refuses with `"deadline 300835 != h_create 300000 + 735 (the production profile's D_offset)"` and with
  `"bundle disagrees with your terms: amount_micronoid"`; no file and no registry entry. Found on the way: `new-alice
  --amount 4000000` (the plan's earlier desk check) is refused by `new-alice` itself, because the fee cap of 50,000 is
  more than 1 % of 4 NOID; the desk check uses 6,000,000 against Bob's 5,000,000.
- **G4 (D2).** A replayed bundle: a Bob file made from a finished swap's bundle, with `tip > D`, and a `Locked` log of
  Bob's sender on the word. Pinned by `g4_a_bundle_given_to_new_bob_twice_into_one_folder_is_refused_the_second_time` and
  `g4_the_first_tick_of_a_replayed_bundle_is_an_abort_not_a_lock`. Observed, as wanted: `new-bob` accepts a valid bundle
  once; the same bundle again into the same output path is refused with `"… already exists; never overwrite a swap file"`,
  into another file of the same folder with `"hashlock already used by another swap (T9)"` (the registry; no file, the
  first file and the registry unchanged); a Bob file in Alice's own folder is refused the same way (her `new-alice`
  registered the hashlock there). The first tick of the replayed file is `abort`, `"last lock height … passed before
  Alice's funding was final"`, and nothing is locked. Across folders see G5.
- **G5 (D3). FIXED** (`g5_the_same_bundle_into_two_folders_is_refused_by_the_per_machine_registry`,
  `g5_an_explicit_registry_still_wins_over_the_per_machine_default`,
  `g5_the_default_is_dot_noid_swap_under_home_with_private_modes_and_no_home_falls_back_with_a_warning`,
  `g5_a_deleted_swap_file_does_not_let_the_same_bundle_be_replayed_into_the_same_path`). The hashlock
  registry used to default to the swap file's own folder, and the helpers make a new folder per run, so a reused lock word
  across runs on one machine was not caught (both `new-bob` runs were accepted). Review verdict (2026-11-06): real, defence
  in depth (Bob's own-word check on the chain and the fresh secret of `new-alice` are the other lines). Now the default is
  a per-machine file, `$NOID_SWAP_HOME/hashlocks.txt` else `~/.noid-swap/hashlocks.txt` (directory mode 700, file mode 600
  on Unix; written through a temporary file and a rename), holding the hashlock and the role (never a path); the run folder's `hashlocks.txt` is still written and checked, a hit in either
  refuses and a refusal writes nothing (a run that died after registering and before saving is run again with `--registry FILE` or after
  removing that line by hand: no retry rule, so a replayed bundle is refused even when the finished file was deleted); stderr names the per-machine file only as `$NOID_SWAP_HOME/hashlocks.txt` or
  `~/.noid-swap/hashlocks.txt`, never by its expanded path; `--registry FILE` replaces both; with no home the run folder's file is used
  alone and a warning says so. Alice's and Bob's files for one swap may share a machine (different roles). (`new-alice`
  always draws a fresh secret, so only a bundle offered again can repeat a hashlock.) See `swap-cli/README.md`, "The
  hashlock registry".
- **G6 (A8).** Bob reads a mined, reverted claim only when told its hash (`--reveal-tx`). Fixture: a reverted claim
  carrying the secret in a block, no `--reveal-tx`, no pending calldata. Review verdict (2026-11-06): real, low impact (he
  keeps his ETH by refunding). Pinned by
  `g6_bob_misses_a_secret_that_is_only_in_a_reverted_claim_unless_given_its_hash_current_behaviour` (the watcher half, "no
  flag, no read", is in `poseidon_kind.rs`): without the hash the observation shows no secret, Bob's tick records no
  `eth_preimage_seen` and, `T_reveal` having passed, offers `refund_eth`; he misses the NOID, which Alice takes back at
  `D`. With the verified reverted claim in the observation the tick records `eth_preimage_seen` and offers `claim_noid`,
  with the note `"refund_eth is also due …"`. RECORDED WEAKNESS (low); whether Bob should look for it by himself is a later
  decision.
- **G7 (A8).** Alice's file after a reveal sent outside the tool (`live.js claim` without `--swap`). Fixture: Alice in
  `lock_final`, no intent, the lock claimed by her receiver with the preimage. Expected (to be confirmed): the file
  records the claim and reaches `done`, not "reveal cutoff passed; keeping the secret".
- **G8 (A2).** `recover-noid.sh` against an instance of another amount. A `selftest.sh` case with a scripted wallet
  output: expected refusal of that instance with the payout check, and the other instances still closed. Found by
  reading (2026-11-06): the helper compares the payout with `AMOUNT - fee`, and `AMOUNT` is read from `env.local.sh`
  after the environment (`env.sh` lines 97 and 111), so `AMOUNT=4000000 recover-noid.sh` is overridden; the working
  recipe is an `AMOUNT=` line at the end of `env.local.sh` (L2 step 4), to be confirmed at `D`. A helper that took the
  amount from each instance listing, or a `--amount` flag, would remove the edit. Not in `hostile_gaps.rs`: a shell helper,
  not testable offline without a scripted wallet in `scripts/live/selftest.sh`.
- **G9 (B5). FIXED** (`g9_a_late_hand_made_lock_is_adopted_and_the_alarm_note_stays_on_every_tick`,
  `g9_a_hand_made_lock_at_exactly_the_bound_gets_no_note_and_one_second_above_it_gets_one`,
  `g9_the_lock_the_file_sent_itself_gets_no_note_even_when_the_bound_has_moved`,
  `g9_alice_reveals_on_the_late_lock_and_bobs_file_reaches_secret_seen_and_claims`,
  `g9_the_refund_of_a_late_lock_is_offered_after_t_reveal_as_for_any_lock`; both lock kinds). Bob's tool adopts a lock of his
  own sender made outside it with a `T_reveal` it did not choose, whatever that `T_reveal` (`bob_fact`). Review verdict
  (2026-11-06): a short one is harmless (Alice's tool rejects it and Bob refunds sooner); a LONG one lets Alice reveal at her
  cutoff past the time Bob can still get a claim final before `D`, so Bob could lose the ETH while Alice recovers the NOID.
  Only Bob himself can make such a lock (it needs his key), so it is self-inflicted. The lock is adopted with an ALARM note
  (refusing it would leave Bob without a claim path: review finding): a refused lock is still live, Alice's tool reveals on it
  as soon as it is final, and a file that never adopted it could neither read the secret nor claim. So the phase moves and
  the actions are exactly those of any lock (`funding_final` to `locked`, then `secret_seen` and `claim_noid` once the secret
  is public, or `refund_eth` after `T_reveal`); the only change is a note. When a lock that the file did not send itself (not
  the lock id named by its pending `lock_eth` record or intent, or a cancelled intent) has a `T_reveal` above `Gates::t_max_eth`
  at the current tip and clock (the bound `choose_t_reveal` applies; no bound at all counts as above), the tick that adopts it
  logs a history entry `late_lock:<lock id>:<T_reveal>:<bound>` and every tick while the lock is open says `ALARM: this lock's
  T_reveal <t> is <excess> s beyond the engine's own bound <bound> (D <d>): if Alice reveals late, the NOID claim may not be
  final before D; claim the moment the secret is seen; do not make another lock (lock <id>)`. A lock at exactly the bound, and
  the file's own lock whatever the bound does later, get no note. Alice's side is unchanged (her check has no upper bound; the
  short-window case is her I3 check, pinned by `alice_rejects_a_lock_whose_reveal_window_is_shorter_than_w_a_min`). See
  `swap-cli/README.md`, "Bob's tool and a lock of his own sender that it did not send".
- **G12 (T1, L4).** `tick --closed-by TXID --apply` for a Bob file in `secret_seen` whose loop has already decided
  `claim_noid`. Pinned by `g12_closed_by_is_accepted_for_a_bob_file_whose_decision_is_claim_noid` (library calls in the
  order the binary makes them: `check_external_close_phase`, `external_close_event`, `SwapFile::apply`, `tick_apply`).
  Observed, as wanted: accepted, the close recorded as `claim_included`, and 17 blocks later `done`. `claim_noid` is not an
  intent kind (the ledger holds `fund_noid`, `lock_eth`, `reveal_eth`, `refund_eth`, `refund_noid`), so no intent is held
  and nothing has to be cancelled first.
- **G10 (T1 to T3).** The mempool stall under congestion, the first-seen conflict and eviction at a real rotation:
  the simulator has one mempool and no load. Needs the isolated-node run and a test-only fee override (L7). Not testable
  offline without them.
- **G11 (C6).** A consistent lie from the only node. Not a test gap but a stated limit: with `SINGLE_NODE_OK` the tool
  trusts that node. A stranger needs two nodes on independent networks (run 12 used one private network).
- **Open chaos findings that a hostile party can trigger** (no funds lost, a file that cannot end): F-10 (two fitting
  instances waited on after `D`), F-11 (Bob's file after Alice's recovery beat him), F-6 (a lock that left the chain
  for good). See `swap-cli/CHAOS.md`.
