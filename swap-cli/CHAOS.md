# CHAOS.md — seeded chaos test over the two-chain simulator

Files: `tests/chaos.rs` (the test), `tests/common/chaos_support.rs` (seeded PRNG, failure type). No new crate: the
PRNG is a 20-line splitmix64 (`proptest` is in the local registry cache but not in the dependency graph, and the build is
`--offline`). The first version of this file changed nothing in `src/` and described sixteen findings; nine of them were fixed on 2026-11-05 (see
"Fix status" below, with the test of each in `tests/chaos_fixes.rs`), the rest are open.

## Run it

```sh
cd swap-cli
cargo test --offline --test chaos                                   # 1,000 scenarios, base seed 0xC4A05EED
cargo test --offline --test chaos -- --nocapture                    # same, with the seed and the full report printed
CHAOS_N=10000 CHAOS_SEED=0xdeadbeef cargo test --offline --test chaos -- --nocapture
CHAOS_SEED=0xc4a05eed CHAOS_ONLY=1639 CHAOS_VERBOSE=1 cargo test --offline --test chaos -- --nocapture   # replay one
CHAOS_TRACE=1 CHAOS_LOG_LINES=100000 ...                           # with CHAOS_ONLY: one line per tick of every party; the failure log keeps all lines
CHAOS_STRICT=1 ...                                                  # an OPEN finding (OPEN_FINDINGS in chaos.rs) also fails the run; a FIXED one always does
CHAOS_EARLY=0 ...                                                   # the simulated chain starts at tip 300,001 in every scenario, as before 2026-11-17 (every old seed reproduces); CHAOS_EARLY=1 starts every scenario before H_create
```

Every scenario seed is derived from `(CHAOS_SEED, index)`, so `CHAOS_ONLY=<index>` with the same base seed replays exactly
that scenario (the secret is derived from the seed too). A failure prints the base seed, the index, the violated invariant
and the last 120 lines of the event log. Swap files go to `/dev/shm` when it exists (they are fsynced on every save).

Default run: 1,000 scenarios, about 356,000 ticks, 30-40 s on the owner's WSL (about 30 ms a scenario). 3,000 scenarios take
90-110 s. Final code: base seed `0xc4a05eed` (1,000, twice) and `0xdeadbeef` (3,000) green; `0x5eed01` (3,000) was green on the revision before the last two harness fixes.

## What is exercised

One scenario = one whole swap, both roles, with the simulator of `tests/common/mod.rs`. Drawn from the seed: the profile
(production / rehearsal / sepolia), the variant (raw / stock), the contract version (v1 / v2), the regime, the driving mode,
each party's start time and clock skew (up to 100 s), the Parano1d block interval (20-49 s), the tick gaps.

**The start of the chain (2026-11-17).** The simulated Parano1d chain used to start at tip 300,001, after `H_create` (300,000), so Alice's funding was never
drawn before it. Since the funding opens `D_offset` blocks before `H_create` (`swap-cli/README.md`), about a quarter of the scenarios (the draw is one in four, from its own
generator seeded from the scenario seed, the way the lock kind is drawn, so no other choice of any scenario moves) start between 1 and `D_offset + 20` blocks earlier,
some of them before the funding opens, where Alice must wait ("too early to fund"), and the others inside the new window. A scenario that draws no early start is the scenario
its seed named before; `CHAOS_EARLY=0` forces that for all of them. The party start times scale with the blocks available before the lock-by, as they did. The oracle's `fund_noid` gate
has the new lower bound (invariant 2 below); the run prints how many scenarios started early.

*What the early start showed, and what was changed (2026-11-17).* The first runs with the early start printed a handful of hard violations across the sweeps and the replays. Each was
replayed; none comes from the funding rule (which only decides `created`), and all but one of the classes also occur with the old start (`CHAOS_EARLY=0`). They are now
classified, and the run is green on the default seeds:
- **Oracle: the late re-send (`gate-i2` and `eth-to-alice-without-timely-reveal`; seed `0xc4a05eed` scenario 321, and 5037 with `CHAOS_EARLY=1`).** Alice's `reveal_eth`
  crashed with an unknown outcome, her next tick came after the `M_A` cutoff, and the engine re-sent under the late cutoff `T_reveal - DE`. That is the documented design
  (R5-1: the outcome is unknown, so the secret may be public; `reveal_may_have_been_sent`, tested in `tests/review5.rs`). The oracle allowed the late cutoff only when the
  secret was truly public in the world. It now also allows it when Alice's file, read BEFORE the tick, carries the `reveal_maybe_sent` marker or a pending `reveal_eth` record
  marked maybe-sent (`Snap.reveal_maybe_sent`), and the end-of-run ETH rule measures such a first executed reveal against `T_reveal - DE`. **The accepted trade-off under it:**
  if nothing was in fact sent and the re-send misses `T_reveal`, the secret is published for the first time too late and Alice can lose both legs (Bob refunds his ETH and
  claims the NOID). That risk is pre-existing and was accepted in REVIEW-5, because withholding the re-send would leave a claim that was really sent stuck in the mempool.
- **Oracle: extra locks (`gate-reveal`; `0xc4a05eed` scenario 4534 and `0xdeadbeef` scenario 6697, both with the old start).** After Bob's own lock was refunded, the
  adversary's second lock on the agreed terms (variant 1 of `side_lock`) was open, and the engine revealed for that lock (it adopts every open lock on the agreed terms,
  REVIEW-3 G2: the lock pays Alice, the secret is the same, and the reveal is after `D`, where the claim branch is closed, so it exposes nothing). The oracle only knew the
  swap's own lock and called it "not on Ethereum". It now also accepts a lock id of the extra locks (`Snap.side_locks`); every other check of the gate applies to it.
- **Harness: the budgeted claim reorg (`atomicity-budgeted`; `0xc4a05eed` scenario 7694 with `CHAOS_EARLY=1`).** `ev_eth_claim_reorg` in the budgeted regime required 120 s
  of room before `T_reveal`, while the same regime draws a claim stall of up to 400 s (`freeze_eth_claim`: 101 to 400 s), so it could build a case no engine can win (the claim is back in the
  mempool, a stall follows, `T_reveal` passes). The room is now the longest stall plus the old 120 s (`BUDGETED_CLAIM_STALL_S` = 400, so 520 s), and the stall draw uses the same
  constant. This changes the scenarios of the budgeted regime that reached such a reorg between 120 and 520 s before `T_reveal` (the reorg is refused there now).
- **Real, pre-existing: F-22 and F-23** (`noid-stuck` seed `0xdeadbeef` scenario 1466 and, with the old start, 5888; `eth-stuck` seed `0xdeadbeef` scenario 5101 with the old start).
  Open findings below, each with a soft code limited to its exact conditions.
- The oracle's funding gate computes its opening from the file's own numbers (`D - H_create`), not from the profile table the engine reads.
The classes were seen with the old start too: a sweep of `0xdeadbeef` with `CHAOS_EARLY=0` (8,000 scenarios) still finds F-22 and F-23 once each (and, before the changes above,
`gate-reveal` in scenarios 4534 and 6697 and `noid-stuck` in 5888). Do not read these classes as rare in the old start.

- **Regime `Budgeted`** (437 of 1,000): every disturbance stays inside the design budget (ticks at least every 4 minutes, no
  party silent, outages up to 10 minutes, Parano1d stall up to 25 blocks, Ethereum claim stall up to 400 s, nothing that forces
  a re-proof in the last 40 blocks before D). Atomicity is REQUIRED.
- **Regime `Hostile`** (563): outages and stalls of hours, parties that stop ticking, lying nodes. Only the safety invariants
  are required; a lost leg must be explained by an adversity that was in force.
- **Mode `Runner`** (639): `Runner::tick` with the simulator's executor (the library's automatic path, restarts from the file).
  **Mode `Cli`** (361): `tick_apply` and the intent ledger as `swap-cli tick --apply` runs it, with a simulated operator who
  sends what is printed (88 %), forgets (12 %), cancels (`intent --cancel`, with the engine's own refusals) and records
  outside closes with `--closed-by`; Bob's `claim_noid` goes through the executor as in `swap-cli claim --submit`.

Adversary, per 1,000 scenarios (default seed; "events" are applied events, not attempts):

| Event | Count | Event | Count |
|---|---|---|---|
| Parano1d reorg drops a close (back to mempool or gone) | 1,454 | pending calls evicted (`evict_all`, anchor rotation) | 811 |
| close re-included at another height | 894 | Parano1d inclusion frozen | 657 |
| Ethereum reorg drops Bob's lock block / lock for good | 1,213 / 91 | Ethereum claims stalled / Alice's reveal stalled | 540 / 1 |
| Ethereum reorg drops Bob's refund | 553 | party offline for a random action kind | 1,094 |
| Ethereum reorg drops Alice's mined claim | 155 | party stops ticking (hours) | 376 |
| funding reorg (instance gone for a block, re-included) | 673 | crash armed before / after an effect (then restart) | 1,059 |
| third party closes to Bob at minimum fee (included / starved in the mempool) | 178 / 172 | Ethereum node lags (up to 1,500 s) | 286 |
| Alice's wallet recovery close at D | 237 | bogus preimage in the Ethereum mempool | 822 |
| second instance, dust / with the agreed amount | 165 / 130 | second lock of Bob's address (wrong amount, short window, refunded, second correct) | 625 |
| a Parano1d stall while the instance is claimable | 85 | restarts from the file | 3,786 |

Degraded observations (about 8 % of ticks, 17 kinds, 1,050-1,220 each): epoch anchor / fee estimate / fee floor unknown,
stale Parano1d or Ethereum poll, chain id unknown or wrong, code hash unknown or wrong, tip header time unknown or 400 s old,
Ethereum head 700 s old, second node down / behind / disagreeing about the instance or the lock.

Outcomes (default seed): swapped 486, both refunded 150, nothing locked (Alice funded, Bob never locked) 211, nothing funded 120,
Alice lost a leg 5, Bob lost a leg 7 (all twelve in the hostile regime, each with an adversity in force), unresolved by a
documented gap 21. Actions performed: fund 880, lock 760, reveal 502, claim 742, ETH refund 419, NOID refund 358.

## Invariants

After every tick (all scenarios):

1. **Fail closed.** No action kind that the applied degradation must block (`Degrade::blocks`, from `spend_blocker` and
   `f5_gate`) is ever performed.
2. **Gates, judged on the true state of the world before the tick, not on what the engine saw.** `fund_noid`: no instance
   exists or is pending, `tip + B_FUND + B_FINAL <= lock-by`, and (since 2026-11-17) `tip + 1 >= max(H_create - D_offset, 279,388)`: the funding
   opens `D_offset` blocks before `H_create`, never before the trial start. The oracle writes this bound from the swap numbers, not from the engine's helper. `lock_eth`: the agreed terms; funding final in the world;
   claim branch open; (I1) holds (a 100-s clock tolerance in the engine's favour); window >= `W_A_min`; no lock on chain and no
   different pending lock; no call pending on the instance; not with two instances of the agreed amount. `reveal_eth`: the
   lock exists, is open, agreed, final, the time is at most the cutoff `T_reveal - M_A` (+ tolerance), exactly one instance of
   the agreed amount, the instance present. `claim_noid`: instance present, call height = tip + 1 < D, the secret is the
   published one, fee in the contract's range (v2: exactly `max_fee`). `refund_noid`: instance present, call height >= D, fee
   in range. `refund_eth`: lock open and `time >= T_reveal`. Wrong role is a violation.
   **Finality: 18 blocks (corrected 2026-11-08).** The oracle counts a funding or a close as final at `tip >= height + 18`, the node's rule
   (`is_final`, `CONSENSUS_FINALITY_DEPTH = 18`); it used 17 before, which the engine used too. `B_FINAL` is 19 (`NF + 1`), so the checks at
   `D + B_FINAL` and the funding gate `tip + B_FUND + B_FINAL <= lock-by` are one block stricter than before. The seeds and scenario numbers
   quoted below were drawn under the old rule; a replay under the new one is a different run.
3. **No spend twice.** Funding at most once; no second lock while the first lock or its transaction exists; no claim, refund
   or reveal against something already closed. In `Cli` mode, additionally: the ledger never prints a spend whose first copy
   (that the operator sent) is still in flight, and `intent --cancel` never succeeds while the operator's send is still in a
   mempool or on a chain.
4. **A terminal phase never changes**, except Alice's `done` (REVIEW-2 F9 by design).
5. The NOID is paid to Bob only after the secret is public on Ethereum, with a fee in `[5,800, max_fee]`.

At the end (after the adversary stops and a calm period of ticks every 5-90 s, with the operator attentive):

6. No NOID is left at the contract (instance, pending funding, mempool) and no Ethereum lock is left open.
7. Both files are terminal, and each terminal phase agrees with the chain (`done` = ETH to Alice, `refunded` = NOID back to
   Alice, `lost` = both legs to Bob, `aborted` = nothing funded / NOID not paid to Bob, Bob's `done` / `refunded` likewise).
8. The NOID went to Bob only if the secret was public before D; the NOID payout plus fee equals the amount; the ETH went to
   Alice only if her reveal was executed at or before the cutoff; to Bob only through a refund.
9. **Atomicity.** If both legs were funded: swapped or both refunded. A lost leg fails the run in the budgeted regime, and in
   the hostile regime unless an adversity that could cause it was in force (frozen inclusion, party silent or offline for the
   claim, foreign pending close, reorg, eviction, stalled Ethereum claim, degraded observation).

`chaos_oracles_catch_planted_violations` plants a violation of each gate and of the terminal rule and checks that the
oracle rejects it (the checks are not vacuous). Documented findings are recorded without stopping the scenario
(`KNOWN_FINDINGS` is empty on purpose: each finding is recognised under the exact conditions that produce it, any other
use of the same invariant id stays a hard failure).

## Result

Hard failures after the harness was corrected: none (final code: 5,000 scenarios in three runs). The first runs found many classes of
violation; every one was either one of the findings below or an error of the harness itself (phantom locks and foreign
instances that the single-lock simulator cannot close, a cancel counted as "after send" although a reorg had erased the send,
the Rehearsal profile's head-time rule being off by design, the lenient clock tolerance), which is why the harness now
injects foreign instances and locks only where the simulator can honour them. **Atomicity held in all 437 budgeted
scenarios of every run on the final code.** No finding below loses a leg by itself; F-9 can hide a lost leg.

## Fix status (2026-11-05)

Nine of the sixteen findings are fixed, plus a new one (F-17) and a small hardening that the chaos test found on other seeds. For each fixed item the chaos test no
longer has an allowance: its symptom (a "documented finding" soft code, an "explained" end state, a documented gate violation) was removed from
`tests/chaos.rs`, so a regression fails the run with its own invariant id (`closes-a-gone-instance`, `terminal-vs-chain`, `eth-stuck`,
`not-terminal`, `gate-reveal`, `gate-lock-funding-not-final`, `dup-fund`, `ledger-cancel-after-send` ...). `OPEN_FINDINGS` lists what is still
recorded without failing the run (`CHAOS_STRICT=1` fails on those too). Each test below fails on the code as it was and passes now (checked by
switching the fixes off in turn: the positive tests of F-1, F-3, F-4, F-5, F-9, F-12, F-13, F-15 and of the lock cancel failed; the negative
tests, which pin what must NOT change, and the F-16 predicate test were not mutated).

| Finding | Fix | Test |
|---|---|---|
| F-9 `done` without re-checking the claim | `alice_fact` for `revealed`: the claim must still be named by `eth.claimed` (and the node's head at or past its block) when it becomes final. Dropped by a reorg -> new event `eth_claim_reorged` -> `reveal_submitted` (the dropped-transaction, lost-reveal and re-send paths all start there); moved to another block -> `eth_claim_mined` again, the finality count starts over (a claim read from the `getLock` record only moves down: its block is an upper bound) | `f9_a_claim_that_a_reorg_dropped_never_reaches_done`, `f9_a_claim_that_moved_to_a_later_block_restarts_the_finality_count` |
| F-5 a submitted Ethereum transaction that is gone | `eth_tx_dropped`: 10 minutes (`ETH_TX_GRACE_S`) after the submission, a fresh Ethereum observation, the effect not on chain, and the signer's pending nonce equal to its latest (the `intent --cancel` rule; unknown nonces never count). Then `eth_lock_dropped` (a log entry; Bob stays in `lock_submitted` and the NEXT tick re-sends THE SAME lock: same `T_reveal`, same lock id, so a duplicate that lands anyway reverts, and only while (I1) and `M_A` still hold; never a fresh lock under a new id: independent review H2), `eth_reveal_dropped` (`reveal_submitted` -> `lock_final`, see the re-send rule below), `eth_refund_dropped` (`refund_submitted` -> `locked`; after the secret it is a log entry that ends the "already submitted" wait). Bob's lock is identified by its id, so another lock of his address on chain does not hide a dropped one. The drop is recorded in one tick and the action is offered by the same tick (reveal, refund from `locked`) or the next (lock, refund after the secret) | `f5_a_lock_transaction_that_was_dropped_is_sent_again_only_when_nothing_of_the_signer_is_pending` (same `T_reveal`), `f5_a_dropped_lock_is_not_called_dropped_while_another_lock_of_bobs_sits_on_chain`, `f5_a_reveal_that_was_dropped_is_offered_again_while_the_cutoff_allows`, `f5_a_refund_that_was_dropped_is_sent_again`, `f5_after_the_secret_a_refund_that_never_landed_is_not_waited_for_for_ever` |
| F-15 `intent --cancel` of `fund_noid` | new observation field `funding_pending` (`Some`: the node says; `None`: it cannot, which is every real node, since a mempool entry exposes the opening only for a call on an instance). `Some(true)` refuses; `None` refuses unless `--i-checked-the-wallet` (`cancel_intent_checked`); `Some(false)` allows. The simulator answers, so the chaos operator cannot cancel a funding a reorg put back | `f15_a_fund_noid_intent_cannot_be_cancelled_while_a_funding_sits_in_the_mempool` |
| F-1 the CLI never records `abort` | `tick_apply` applies `Event::Abort` when the action is `abort` and the call records (`tick --apply`; a read-only tick and the cancel probe do not). Not while a `fund_noid` / `lock_eth` was decided and never cancelled: that spend may have been sent and the chain not shown it, and a file must not say `aborted` over a live funding or lock; the abort is then only printed, with a note (a by-design residue, not counted as a finding) | `f1_the_cli_path_records_the_abort`, `f1_an_abort_is_not_recorded_over_a_funding_that_may_have_been_sent` |
| F-12 CLI path cannot reach `lost` | `alice_both_legs_lost` also runs from `lock_final` when the history shows the reveal was decided, sent or dropped (`intent_decided:reveal_eth`, `reveal_submitted`, `eth_reveal_dropped`); `both_legs_lost` is a legal event from `lock_final`. Without such evidence (a cancelled reveal intent is none) `lock_final` never becomes `lost` | `f12_alice_on_the_cli_path_reaches_lost_without_a_recorded_reveal`, `f12_without_any_trace_of_a_reveal_lock_final_does_not_become_lost` |
| F-13 reveal without the instance in the poll | `alice_action` for `lock_final`: the recorded instance must be at the contract, and fit the agreement, in that very poll, else `wait` (or `refund_noid` when `D` is reached) | `f13_alice_does_not_reveal_while_her_instance_is_not_in_the_poll` |
| F-3 funding finality counted from first sight | The node gives no creation height (`creation_id` is an allocation counter), so the fallback of the proposal: in `funded`, a poll in which the recorded instance (slot AND incarnation) is absent sends the file back (`noid_instance_gone`: Alice `funding_submitted`, Bob `received`) and the count restarts when it is seen again; a silent re-inclusion shows as another incarnation. From `D` on, with nothing listed at the root, the instance is taken as closed (that is `--closed-by`'s business). The simulator now gives every re-minted funding a fresh incarnation | `f3_a_funding_that_left_the_chain_and_came_back_is_counted_from_its_return`, `f3_a_silent_reincarnation_between_two_polls_is_noticed_too` |
| F-4 `Runner::tick` closes an instance that is gone | the guard moved into `decide` (both paths): `refund_noid` for an instance not at the contract becomes `wait` with the "nothing to refund" note | `f4_the_runner_does_not_try_to_close_an_instance_that_is_gone` |
| F-16 `Done` is terminal but leaves `done` | `is_terminal()` no longer includes `done` (Alice and Bob); new `is_settled()` is the old meaning ("the protocol is over"): the chaos test stops on it, and `scripts/live/watch.sh` stops on `done` only when its action no longer names a leftover leg | `f16_done_is_settled_but_not_terminal`, `state::tests::alice_happy_path` |
| (new) `intent --cancel` of a `lock_eth` whose lock this poll does not trust | found on seed `0xfeed42` (scenarios 1470, 1601): with an unknown or wrong chain id the mined lock failed `lock_matches`, the intent looked unresolved, the nonces showed nothing pending, and the cancel went through. The cancel now refuses when a lock with the intent's id is on the chain, trusted or not | `a_lock_intent_is_not_cancelled_while_its_lock_is_on_chain_even_if_this_poll_does_not_trust_it` |

**Changes after the independent review of this round** (a read-only review of the diff; every item below has a test in `tests/chaos_fixes.rs`):
- *H1 (high, fixed).* The model's relation `M_A >= finality + 2*DE + RA` exists so that Alice can re-send her claim AFTER the cutoff once one drop happened, but `LockFinal` refused every reveal past `T_reveal - M_A`, and a dropped reveal took 600 s to notice: both legs could be lost although the secret was public. Now, when the file shows that her claim reached the network (`reveal_submitted`, `eth_claim_mined`, `eth_claim_reorged`, `eth_reveal_dropped`; a merely decided CLI intent does not count), a re-send is allowed until `T_reveal - DE` (`secret_may_be_public`, `reveal_cutoff_for`; the intent's frozen `cutoff` follows), the instance-visible gate (F-13) is waived (nothing is protected by waiting any more), and a claim that was mined and reorged is judged by the signer's nonces at once (its drop clock is back-dated). `DE` is now read by the engine, not only by `validate`.
- *H2 (fixed).* A dropped lock is re-sent as the same lock (see F-5 above), so a second lock under a new id cannot come from the drop path.
- *M1 (fixed).* After `intent --cancel` of a funding or a lock the `abort` stays unrecorded for another hour (`ABORT_AFTER_CANCEL_S`): the cancel rests on one node's view of the mempool, and a transaction queued elsewhere would otherwise land under an `aborted` file.
- *M2 (fixed).* `lost` also needs the second Parano1d node, when there is one, to agree that the instance is gone.
- *M3 (fixed).* `scripts/live/watch.sh` no longer counts `done` as terminal while the action names a refund or a leftover leg.
- *M5 (fixed).* When `refund_noid` is held back because the recorded instance is gone, the note lists the other instances at the root (a funding that came back as a new incarnation), to be refunded with the wallet.
- *M4 (documented, not fixed).* F-3 is fixed for reorgs that a poll observes (absence, or another incarnation). A funding removed and re-included between two polls with the SAME slot and incarnation is invisible; only the inclusion height (`getTx` of the funding txid) would close it, and Bob does not know that txid.
- *Not changed:* a reveal that was sent, reverted and then cancelled in the ledger counts as no evidence of a reveal (a cancel is allowed once nothing of it is pending or mined), so if Bob took the NOID the file stays `lock_final` (stuck, never wrong); the F-17 marker is taken at a non-final tip (a deep reorg suppresses a true `lost`: the safe direction); a claim recorded from a log and later read from the `getLock` record is not judged as moved (a premature `done` while the log index lags); F-9 reads the reorg without re-checking the chain id (the wrong endpoint recovers with the right one); `lost` could still be declared when Alice's wallet closed the instance while she was not polling around `D` (fixed afterwards by F-18).

**Open (not fixed in this round):** F-2, F-6, F-7, F-8, F-10, F-11, F-14 (described below, unchanged; F-10 and F-14 were fixed on 2026-11-16, see their sections, and one finding, F-20, was added the same day; F-20 was fixed the same day, F-6 and F-11 in part, and F-21 was added: the open list is now F-2, F-6, F-7, F-8, F-11, F-21). One new finding, F-17, was found by the longer runs and fixed:

### F-17 (Low-Medium, new) `lost` while Alice's own un-final recovery close removed the instance — **FIXED 2026-11-05**
Seen on seed `0x5eed01`, scenario 1009 (replay: `CHAOS_SEED=0x5eed01 CHAOS_ONLY=1009`), and, after the F-12 fix let the CLI path reach `lost`, on
seed `0xc4a05eed` of 3,000 (scenarios 1259, 2116). `alice_both_legs_lost` (M2.5b) declared `lost` when Bob's ETH refund was final, the tip was
`B_final` past `D` and the recorded instance was gone, assuming Bob's claim closed it. If instead Alice's own wallet recovery close (outside the
tool, at `h >= D`) took it, the file said `lost` over a NOID she had got back (or, when a reorg dropped that close, over a NOID still at the
contract). **Fix:** a log-only event `noid_instance_alive_at_d`, written once when the recorded instance is seen at a poll with `tip + 1 >= D`
(from there on Bob's claim cannot be included), after which a disappearance can only be a recovery close and `lost` is never declared
(a note says so; `tick --closed-by` records the close). Residual: an instance that vanished while Alice was not polling around `D` leaves no
marker. Also: the evidence for a reveal that F-12 reads (`intent_decided:reveal_eth`) no longer counts once the intent was cancelled (a cancel
is refused while the claim is pending or mined, so a cancelled reveal was never sent). Tests:
`f17_an_instance_that_was_alive_when_bobs_claim_branch_closed_is_never_called_lost`,
`f12_a_reveal_intent_that_was_cancelled_is_no_trace_of_a_reveal`.

## Findings

Severity: Medium = a party can be misinformed about funds or an ETH leg stays locked behind a message that says "pending";
Low = a file or a swap cannot end by itself, no funds at risk; Info = noted. Seeds are for base `0xc4a05eed` unless given
(replay: `CHAOS_SEED=<base> CHAOS_ONLY=<index> CHAOS_VERBOSE=1`). Counts are scenarios of the default 1,000. The finding sections keep the text of the day they were written;
F-6, F-11 and F-20 were answered on 2026-11-16 (second batch, commit `198241c`) and F-21 was added: see their sections and the section "The stuck-instance finding and two chaos findings" below.

### F-9 (Medium) Alice reaches `done` without re-checking that her claim is still on Ethereum — **FIXED 2026-11-05**
`engine.rs` `A::Revealed { block_number } -> EthClaimFinal` fires when `finalized_block >= block_number`; it never looks at
`eth.claimed` again. If a reorg drops the mined claim and the transaction then reverts (the timelock passed), the file says
`done` (ETH received) while the lock is open or refunded to Bob and Bob took the NOID with the exposed secret: both legs lost,
file says success. Bob's side has the missing check (`refund_mined` goes back to `locked` on a reorg). Seen in 7 scenarios
(e.g. 278 on `0xc4a05eed`, 433). The (I2) margin of 30 minutes makes the revert improbable; the misreport is the problem.
**Fix:** in `alice_fact` for `Revealed`, if `eth.claimed` no longer shows the claim for this lock (and no claim is pending),
emit a new event `EthClaimReorged` back to `LockFinal` (or `RevealSubmitted` if a claim is pending); emit `EthClaimFinal` only
if `eth.claimed` still names the lock at `block_number` and that block is finalized. Reuse the `RefundMined` logic.

### F-5 (Medium for `refund_eth`, Low for `lock_eth` and `reveal_eth`) A submitted transaction that is gone is never noticed — **FIXED 2026-11-05**
Bob's `refund_submitted`, `lock_submitted` and Alice's `reveal_submitted` wait with "pending" for ever when the transaction was
dropped or replaced (and, for Bob after the secret, the history entry `eth_refund_submitted` makes `bob_eth_left` answer
"waiting for it to be mined" for ever). With `refund_submitted` Bob's ETH stays locked in the contract behind a message that
says "ETH refund pending" (scenario 86 on `0xc4a05eed`: refund mined, reorged out, transaction gone). 32 scenarios.
`Cli` mode is not affected for locks and refunds (the phase never leaves `locked`, the ledger holds and `--cancel` checks the
nonces); this is the `Runner` path.
**Fix:** a submitted ETH transaction older than a bound (say 3 blocks plus a few minutes) with the signer's pending nonce equal
to its latest nonce and the effect not visible goes back to the phase before (`locked`, `funding_final`, `lock_final`) with a
note, so the action is offered again; the ledger already treats "same params, effect absent" as safe to resend for `lock_eth`.

### F-3 (Low) Funding finality is counted from the tick that first saw the instance — **FIXED 2026-11-05**
`B::Funded` / `A::Funded` become final at `tip >= seen_at_tip + 18`; the observation carries no creation height. After a
reorg that takes the funding back and re-includes it later, Bob can lock up to a few blocks (at most the reorg depth, 18)
before the funding is really final (scenario 3, 18, 1054). 94 scenarios. The lock is still protected by the instance check
at `funding_final` (an absent instance aborts).
**Fix:** read the instance's creation height from the node if `getObjectInstances` / `getObjectStatus` gives it; otherwise
restart `seen_at_tip` whenever the instance was absent from a poll.

### F-13 (Low) Alice reveals without checking that her instance is visible — **FIXED 2026-11-05**
`alice_action` for `lock_final` checks (I2) and "two fitting instances" but not that the recorded instance is at the contract
in this very poll (scenario 1054: a one-block funding reorg). Revealing while the instance is absent hands Bob the ETH side
and leaves him nothing to claim until it reappears. **Fix:** in `alice_action`, `lock_final`: require
`noid.find_instance(recorded)` and `instance_fits`, else `Wait`.

### F-4 (Low) `Runner::tick` retries a recovery close of an instance that is gone — **FIXED 2026-11-05**
`tick_apply` has the guard "the instance is not visible, so there is nothing to refund"; `Runner::tick` does not, so after a
crash-after-effect the retried `refund_noid` goes against a closed instance every tick until `--closed-by` is run. The node
refuses it, nothing is lost. 58 scenarios. **Fix:** move the guard into `alice_action` / `decide`, for both paths.

### F-6 (Low) `locked` never re-checks the lock. FIXED 2026-11-16 for `locked`; open for the refund phases
A lock that left the chain for good (reorg, transaction dropped) leaves Bob in `locked` / `refund_submitted` /
`refund_mined` with "waiting for the secret". No funds at risk (nothing was locked). 75 scenarios (16, 37, 540).
**Fix:** a poll in which `find_lock` is empty and no lock transaction is pending, for N polls, emits `EthLockLost`
(back to `funding_final`, or `aborted` after the lock-by).
*Fixed for `locked` (2026-11-16, commit `198241c`):* see the section below. What remains open of F-6: the refund phases (`refund_submitted`, `refund_mined`) over a lock that left the chain.

### F-11 (Low) Bob's file cannot end after Alice's recovery close beat him. FIXED 2026-11-16 for the cases the engine can decide; two remain open
Instance gone, no tracked transaction: `bob_claim_action` answers "verify the contract receipts manually" before it looks at
D; `--closed-by` refuses Alice's close ("pays Alice"). So `secret_seen` stays for ever. 5 scenarios (42, 444, 576, 716).
**Fix:** when the instance is gone, the claim branch is closed (`tip >= D`) and no tracked transaction exists, emit `Abort`
(`aborted: Alice recovered the NOID first`), and let `--closed-by` record a refused-because-late close as `aborted`.
*Fixed in part (2026-11-16, commit `198241c`):* see the section below. What remains open of F-11: Alice in `funding_submitted` (the file cannot know), and the F-18 state when no `--closed-by` is given.

### F-10 (Low) "More than one instance fits" is waited on for ever, also after D. FIXED 2026-11-16 (Bob)
Bob in `funding_final` (and Alice in `funding_submitted`, F-7) with two instances of the agreed amount at the root answers
`Wait` instead of `Abort` once the lock-by / D has passed. 5 scenarios. **Fix:** check the abort conditions (lock-by, D)
before the ambiguity wait.
*Fixed for Bob (2026-11-16):* with more than one fitting instance his give-up heights are checked before the "more than one instance" wait: the last lock
height, and funding finality plus `B_bob` (the second only while no `lock_eth` intent was cancelled). He gives up at the same heights as with one instance.
Before those heights the wait stands and no lock goes out on a guess. Alice's side was already covered (F-19 for a funding behind a lookalike, F-7 for
`funding_submitted`). Tests, all in `tests/corner_cases.rs`: `f10_two_fitting_instances_before_the_give_up_heights_are_still_a_wait_and_nothing_is_locked`,
`f10_two_fitting_instances_after_the_give_up_height_end_the_file_as_one_instance_would`, `f10_with_a_cancelled_lock_eth_intent_only_the_lock_by_height_ends_the_wait`,
`f10_on_the_command_line_path_with_a_decided_lock_eth_intent_the_abort_is_printed_and_not_recorded`; the tests `f10_alice_with_two_fitting_instances_does_not_reveal_before_d`
and `f10_alice_with_two_fitting_instances_is_offered_the_recovery_close_of_her_own_instance_at_d` pin Alice's side.

### F-7 (Low, seen during development, no replayable seed in the final harness) Alice never accepts her funding behind a lookalike instance
While a second instance of the agreed amount sits at the root, Alice stays in `funding_submitted` ("funding not yet visible")
and the tool never offers `refund_noid`; her NOID waits for a manual wallet refund after D. The depositor loses their
deposit to Alice or Bob, so the attack only blocks the tool. **Fix:** from `created` / `funding_submitted`, once `tip + 1 >= D`
and an instance of the agreed amount is at the root, print a recovery close naming each slot (as F10 already does for the
post-reveal case), or accept the instance whose txid matches the funding.

### F-2 (Low, by design, documented in the code) A pending action of unknown outcome never resolves
`crash_before_effect` on `fund_noid` (nothing was sent) leaves `pending_action.maybe_sent = true`; the engine holds, also after
the lock-by passes, and the file stays `created` (3 scenarios; also `lock_eth`). The comment says "clear the pending record by
hand", but no command does. **Fix:** a `swap-cli clear-pending FILE` (with the chain flags: refuses while the effect could still
be in flight), or let `Abort` / the F-1 fix clear a pending record whose kind is `fund_noid` once the lock-by has passed with no
instance visible.

### F-1 (Low) The CLI prints `abort` and never records it — **FIXED 2026-11-05**
`main.rs` has no abort handling and `tick_apply` never applies `Event::Abort`; only `Runner::tick` does. In the `swap-cli tick
--apply` path a swap that should end (Alice too late to fund, Bob's lock-by passed, Bob's `T_reveal` window too short) stays in
`created` / `received` / `funding_final` and prints `abort` at every tick. 111 scenarios (in the default run 166 files).
**Fix:** in `tick_apply` (or in `main::tick` when `--apply`), apply `Event::Abort` when the decision is `Abort` and the phase
allows it (the transitions already exist), then save.

### F-12 (Low) In the CLI path Alice cannot reach `lost` — **FIXED 2026-11-05**
`alice_both_legs_lost` needs the phase `reveal_submitted`, which only the `Runner` path records; with the CLI the reveal is sent
by the operator and the phase stays `lock_final`. After a stalled reveal that Bob overtook (secret from the mempool calldata,
Bob claims, his refund lands) Alice's file says "the instance is not visible, so there is nothing to refund" for ever
(scenario 1675). **Fix:** accept a recorded `intent_decided:reveal_eth` (history) as the precondition in place of the phase.

### F-8 (Low) A lock's window can end up below `W_A_min`
Bob's resend keeps the recorded `T_reveal` and rechecks only `M_A`; a lock chosen against a node that lags up to the 600-s
limit or a clock 100 s behind has a window up to 700 s shorter than `W_A_min` measured on true time. Alice's (I3) check then
rejects the lock and the swap ends by two refunds: a liveness loss, no safety loss (scenario 1639: 5,229 s instead of 5,400 s).
**Fix:** at lock time and at resend require `T_reveal - max(now, latest_timestamp) >= W_A_min`. *Partly applied 2026-11-05:* the re-send of a dropped lock (F-5) checks it (measured to the likely block, `+ DE`); the first lock and the restart re-send (`reuse_pending`) do not yet, so the finding stays open.

### F-14 (Info) The ledger prints `refund_noid` again after a reorg re-queued the first. FIXED 2026-11-16
The intent resolved when the instance disappeared; a reorg brings the call back into the mempool and the instance back, and the
next tick records and prints a second `refund_noid`. The first-seen mempool refuses the second; harmless (scenario 979).
**Fix:** `alice_action` waits when `noid.pending_calls` is non-empty, as Bob's claim already does (T2).
*Fixed (2026-11-16):* `refund_noid` is a wait while a call on the contract (one of its instances) is pending in the node's mempool, with the same second-node
exception as Bob's claim wait (a second node that is fresh, level with the first and sees no pending call lets the refund go on). The refund is offered again only
if the call is evicted and the instance is still there. Tests, all in `tests/corner_cases.rs`: `f14_a_reorged_recovery_close_in_the_mempool_is_not_offered_a_second_time`,
`f14_the_library_path_does_not_send_a_recovery_close_while_a_call_is_pending`, `f14_a_second_node_that_is_level_and_sees_no_pending_call_lets_the_refund_go_on_as_for_bobs_claim`,
`f14_the_wait_stands_beside_a_held_reveal_eth_intent_and_records_nothing_new`, `f14_the_wait_stands_in_done_and_in_revealed_with_a_leftover_refund`,
`f14_with_a_pending_call_the_due_note_is_a_statement_that_is_true_beside_the_wait`.

### F-15 (Medium-Low) `intent --cancel` of `fund_noid` cannot see a funding in the mempool — **FIXED 2026-11-05**
For `lock_eth` / `reveal_eth` / `refund_eth` the cancel checks the signer's nonces; for `refund_noid` the pending calls; for
`fund_noid` only "no instance visible" and the 10-minute age. A funding that a reorg put back into the mempool (or one stuck
behind a stall) is invisible, the cancel succeeds and the next tick prints `fund_noid` again: a second instance of 10 NOID
(recoverable at D with the wallet, not lost). Seen once in 3,000 on `0xdeadbeef` (scenario 1389). **Fix:** refuse the cancel
of `fund_noid` unless the wallet's own pending-transaction list (or a node call for pending fundings) shows nothing, or require
`--i-checked-the-wallet`.

### F-16 (Info) `AlicePhase::Done` is `is_terminal()` but leaves `done` — **FIXED 2026-11-05**
By design (REVIEW-2 F9: `done -> refund_submitted` when Bob never claims). Any caller that stops ticking at `is_terminal()`
leaves the NOID unrefunded; 7 of the 1,000 default scenarios take this path. **Fix:** rename (`is_final_for_eth`) or give `Done`
with a live instance its own non-terminal marker.

## After the fixes (2026-11-05)

Default run (1,000 scenarios, base seed `0xc4a05eed`): green, about 25 s; the only recorded symptoms are the open findings (F-2, F-6, F-10, F-11,
F-14; `CHAOS_STRICT=1` fails on exactly those, 81 scenarios; since 2026-11-16 F-10 and F-14 are fixed, and the symptoms are F-6 in 69 scenarios and F-11 in 3, see the section "Extra seeds after the finality change"). Four runs of 3,000 scenarios (`0xc4a05eed`, `0xdeadbeef`, `0x5eed01`, `0xfeed42`) are
green. The two seeds `0x5eed01` and `0xfeed42` had not been run before, and the longer runs found, besides the items in the Fix status table: F-17,
the lock cancel, and four corrections of the harness (a party that adopted a foreign instance is not judged on `refund_noid` or on a cancel; the new
incarnation of a re-minted funding; the abort residue; the reveal gate after a sent reveal). Atomicity held in every budgeted scenario of every run:
swapped or both refunded, no lost leg.

## After REVIEW-4 (2026-11-05)

`REVIEW-4.md` (R4-2, R4-4, R4-6 to R4-11, fixed in `src/engine.rs`; tests in `tests/review4.rs`) changed engine behaviour the chaos run exercises:
a cancelled `lock_eth` is re-decided with its own `T_reveal` or aborted, a second ledger spend beside a held intent is refused, `lost` needs the second
node where the profile asks for one, and an abort after Bob has seen his lock is recorded. The default run (1,000 scenarios, `0xc4a05eed`) stays green.
The change to R4-6 was corrected three times by the chaos test, each time in the engine and not in the oracle. (1) Default seed, scenario 681
(`terminal-vs-chain`): releasing the abort hold for `fund_noid` as soon as ANY instance was visible let Alice's file say `aborted` over a funding that
a reorg had taken back and that landed later, behind a dust instance; the hold now ends only for `lock_eth`, and only when the file has seen the lock.
(2) `0xc4a05eed` of 3,000, scenario 2425 (`eth-stuck`): that released hold let Bob's file say `aborted` when his lock was closed in a block a reorg
could still take back, after which the lock was open again with nobody to refund it; Bob's abort now waits until the lock is closed in a FINAL block
(and visible in the poll). (3) Same run, scenario 2633 (`gate-reveal`): the shifted timeline reached an old path (`done` -> recovery close recorded ->
reorg -> `funding_final`) where Alice adopted a second matching lock and printed a second reveal; a file that already received its ETH
(`eth_claim_final`) no longer looks for a lock. The four 3,000-scenario runs (`0xc4a05eed`, `0xdeadbeef`, `0x5eed01`, `0xfeed42`) are green again. No
open finding closed: the list stays F-2, F-6, F-7, F-8, F-10, F-11, F-14 (F-10 and F-14 were closed on 2026-11-16). What the run still cannot show: R4-2's attack needs two nodes that disagree
about the mempool and the simulator has one (see Limits); the fix holds by construction (the same lock id, so a duplicate reverts) and is tested
directly in `tests/review4.rs`.

## Base seed `0x5eed0001` (2026-11-05)

Two violations on a seed not run before, both older than the recent work. One was an engine gap and one a harness error.

- **`gate-lock-two-instances`, scenario 145: engine bug, fixed.** Bob locked on one instance, the lock transaction was dropped, a second
  instance of the agreed amount appeared at the contract root, and the re-send path (`BobPhase::LockSubmitted`, `engine::bob_action`) sent the
  same lock again. The first-lock path already waits on `InstanceProblem::Ambiguous` (REVIEW-2 F10: the tool does not lock on a guess); the re-send
  never asked. It now waits with a note ("not re-sending the lock") until the ambiguity clears or the re-send is unsafe on its own terms. A lock
  that landed anyway is not affected (the same lock id, a duplicate reverts). Test: `a_dropped_lock_is_not_re_sent_while_two_instances_of_the_agreed_amount_sit_at_the_root`
  in `tests/chaos_fixes.rs`.
- **`fail-closed`, scenario 613: harness error, fixed in the oracle.** The `EthHeadLag` degradation put the head block 700 s behind the TRUE
  Ethereum time, while the engine measures the lag against the party's own clock. With the party's clock 100 s slow (skew -100, inside `SKEW_TOL`)
  it saw exactly 600 s, which is not above `MAX_ETH_HEAD_LAG_S`, and the correct reveal was reported as a violation. The degradation is now 700 s behind
  the party's clock (like `TipTimeLag`), so the oracle's "blocked" promise holds for every skew. Test: `the_head_lag_degradation_is_beyond_the_engines_limit_for_every_clock_skew`
  in `tests/chaos.rs`. No engine change.

The default seed and `0x5eed0001` are green after both changes (1,000 scenarios each).

### Longer runs after REVIEW-5 (3,000 scenarios, 2026-11-05): two more, not caused by the changes above or by the lock kind — both FIXED the same day (F-18, F-19)

`CHAOS_N=3000` on `0xdeadbeef` and `0x5eed01` is green. On `0xc4a05eed` and `0x5eed0001` one scenario each failed. Both reproduced with the lock kind forced to `sha256`
(`CHAOS_LOCK_KIND=sha256`) and with the two changes above switched off (checked by toggling them for the replay), so they came from the engine or the oracle as they were at
`7c1835d` (REVIEW-5). Diagnosis and fixes are in "F-18" and "F-19" below; the bullets keep the first description. Replay:
`CHAOS_LOCK_KIND=sha256 CHAOS_SEED=<seed> CHAOS_ONLY=<index> cargo test --offline --test chaos -- --nocapture`
(add `CHAOS_TRACE=1 CHAOS_LOG_LINES=100000` for a line per tick of every party).

- **`terminal-vs-chain`, `0xc4a05eed` scenario 1259** (hostile, CLI, rehearsal, raw, contract v2). Alice's operator never sends the printed `reveal_eth`; Bob refunds the Ethereum lock;
  Alice then closes the NOID with her wallet (recovery) **outside the tool** and the tool is not told (`--closed-by`). As far as the log shows, her file then goes to `lost` (M2.5b: reveal
  evidence, Ethereum refund final, instance gone) although she got her NOID back. The engine cannot tell her own recovery close from a third party's without `--closed-by`; the question is whether `lost`
  may be declared on that evidence at all while the instance disappeared by a close the file did not record (compare F-17). **Engine bug, fixed: F-18.**
- **`noid-stuck`, `0x5eed0001` scenario 2792** (hostile, CLI, rehearsal, raw, contract v1). A crash around Alice's `fund_noid` leaves her file in `created` with a pending
  `fund_noid` of unknown outcome (F-2); the real instance sits at the root, two extra instances of the agreed amount appear, Alice's recovery close is later dropped by a
  reorg, and the file still believes nothing was funded, so nothing refunds the NOID and it stays at the contract after D. First reading: F-2 with a real consequence. **Not F-2; engine gap
  (F-7 in the CLI path), fixed: F-19.**

### F-18 (Medium) `lost` declared over a NOID that Alice took back with her own recovery close — **FIXED 2026-11-05**
Base seed `0xc4a05eed`, scenario 1259 (hostile, CLI, rehearsal, raw, v2; replay with `CHAOS_LOCK_KIND=sha256`). Trace: the operator never sends the printed `reveal_eth`; Bob refunds
his ETH (final); Alice does not poll between about `D - 1` and her own wallet's recovery close at the first block at or after `D`; a reorg drops that close, her wallet closes again;
the first poll after all of it sees the instance gone, `tip >= D + B_FINAL`, Bob's refund final, a decided `reveal_eth` intent: `lost`. The chain says the NOID is back with Alice.
**Engine bug, not an oracle error.** F-17's marker (`noid_instance_alive_at_d`) needs a poll in the one or two blocks between `D - 1` and the recovery close; without it nothing
separated "Bob's claim took it (included at `h < D`)" from "her recovery took it (`h >= D`)", and the rule declared the first. A terminal state has to be true, so the evidence is
turned around: `lost` now needs a **positive** fact, and the only one that tells the two closes apart is a poll with `tip < D` that did not list the instance (only the claim branch
can close it then). New log-only events `noid_instance_gone_before_d` (written by `alice_gone_trace`, only in `lock_final` and `reveal_submitted`, when the recorded instance is absent in such a poll and the second node, if
there is one, does not list it either; not when the second node could not be read) and `noid_instance_back_after_gone` (written when it is listed again, so an absence a reorg undid
proves nothing). `alice_both_legs_lost` requires the first and no later second, in addition to everything it required before (Bob's refund final, `tip >= D + B_FINAL`, the second
node, a reveal on record, no `refund_noid` decided, no `alive_at_d`); F-17's veto stays. Without the evidence the file stays in `lock_final` / `reveal_submitted` and the note says
what to do: record the close with `tick --closed-by` if the wallet made it, otherwise check the contract receipts (the NOID went to Bob). **Cost:** a genuine loss where Alice
did not poll once between Bob's claim and `D` also stays non-terminal (stuck, never wrong); the oracle lists that as the F-11 gap (`alice_closed_unrecorded` now also covers "no
poll before D saw the instance gone"). On the default seed F-11 shows 2 scenarios in 1,000, both Bob's; none is an Alice file waiting for this evidence. Tests: `f18_lost_needs_a_poll_before_d_that_saw_the_instance_gone`,
`f18_the_note_says_what_to_do_when_the_evidence_is_missing`, `f18_an_absence_that_a_reorg_undid_is_no_evidence` (the existing `lost` tests now poll once before `D`, as the real
loop does every minute).

### F-19 (Medium) a funding behind a lookalike instance is never taken back — **FIXED 2026-11-05**
Base seed `0x5eed0001`, scenario 2792 (hostile, CLI, rehearsal, raw, v1). The first diagnosis (an unresolved `fund_noid` hides the instance) was wrong: the tool decided a
funding, the operator sent it, Alice did not poll for 29 blocks, and in that time a second instance **of the agreed amount** appeared at the root (the oracle's
`fitting_instance`). With two fitting instances `instance_ok` answers "ambiguous" and the file stays `created` (the phase the CLI path is in until it sees its instance;
`funding_submitted` on the library path); the action is "too late to fund" (printed as `abort`, not recorded while a decided `fund_noid` is uncancelled, F-1), so `refund_noid` is
never offered and the NOID stays at the contract after `D`. This is F-7 reached from `created`, which the oracle's F-7 allowance (`funding_submitted` only) did not cover,
and hence a hard `noid-stuck`. **Engine gap, fixed:** from `tip + 1 >= D`, with her own funding on record (phase `funding_submitted`, a `pending_action` `fund_noid`, or an
`intent_decided:fund_noid` that was not cancelled), several fitting instances no longer block: the OLDEST (lowest `creation_id`, then slot) is recorded as hers
(`noid_instance_seen`), with a note that names the others for the wallet. She funded once and an allocation counter orders the deposits; a wrong guess costs nothing, because every
instance at the root pays Alice on the recovery branch and the gates that protect her stay: Bob does not lock under ambiguity, she never reveals with two fitting instances
(REVIEW-3 F10, REVIEW-4 R4-4). Before `D` nothing changes, and without a trace of a funding of hers nothing is adopted. Tests: `f19_a_funding_behind_a_lookalike_is_taken_back_at_d`
(CLI path: decided intent), `f19_the_library_path_with_a_funding_that_was_submitted_ends_the_same_way`, `f19_a_lookalike_is_nobodys_business_without_a_trace_of_alices_funding`.
F-2 stays open on its own terms (a `pending_action` of unknown outcome with nothing at the root).

Runs after both fixes (2026-11-05): the whole suite is green (452 passed, 1 ignored; it was 446 before the six new tests); the two replays pass; 1,000 scenarios on `0xc4a05eed` and `0x5eed0001`, and 3,000 on `0xc4a05eed`, `0x5eed0001`, `0xdeadbeef`, `0x5eed01`,
`0xfeed42` are green (no hard failure; only the open findings are recorded). Those runs were made before the finality change of 2026-11-08; the next section says what the later runs showed.

## Extra seeds after the finality change, and the fixes of 2026-11-16

The finality change of commit `05851ce` (17 to 18 blocks) shifted the timing of every scenario, and the extra seeds were not re-run at 1,000 scenarios afterwards.
The seed `0x5eed0001` had been green at 1,000 and 3,000 on 2026-11-05. Run again on the tree of 2026-11-16 it showed three gaps of the TEST ORACLE, in two scenarios.
None was an engine defect, and the engine was not changed for them.

- **Scenario 496, first reported as `ledger-cancel-after-send`, then as `terminal-vs-chain`.** A held `fund_noid` intent was cancelled after `D`, when Alice's own
  recovery close had already closed the instance. It is the F-1 / F-19 class "no trace of the funding", reached through `intent --cancel`: the tool cannot tell a
  funding that was recovered outside it from one that never went out, and the cancel is the operator's statement that nothing was sent. The oracle no longer counts
  Alice's own recovery close as the effect of the funding (`fund_noid_effect_in_world`), and a file that ends `aborted` in this case, with the NOID back at Alice, is
  no longer a violation (`alice_aborted_after_a_cancelled_funding`); the run counts and prints these ("aborted after a cancelled sent funding").
- **Scenario 715, `not-terminal`.** The documented F-18 cost: the reveal is on record, Bob's refund is final, the instance is gone, and no poll before `D` saw it
  gone, so the file stays in `lock_final` or `reveal_submitted` by design. The allowance had matched on the text of the last action; it now matches on the file's
  structured state (`alice_reveal_lost_but_unprovable`).

Each helper is pinned by a unit test in `tests/chaos.rs`.

The same commit (`6cca4e2`) fixed F-10 and F-14 above (and R7-4 of `REVIEW-7.md`) and decided gap G1 as a note only (`docs/hostile-run-plan.md`). The oracle no longer
excuses F-10 and F-14: `OPEN_FINDINGS` is now F-2, F-6, F-7, F-8, F-11 (F-21 was added by the second batch below), so a return of either one is a hard failure with its own invariant id (`not-terminal` for F-10,
`ledger-duplicate-print` for F-14).

Results on the committed tree, 1,000 scenarios each (2026-11-16):

| Base seed | Result | Open findings recorded |
|---|---|---|
| `0x5eed0001` | green | F-6 in 47 scenarios, F-11 in 9, F-2 in 1 |
| `0xc4a05eed` (default) | green | F-6 in 69, F-11 in 3 |
| `0xdeadbeef` | green | F-6 in 68, F-11 in 4, F-2 in 2 |
| `0x5eed01` | green | F-6 in 58, F-11 in 6, F-2 in 2 |
| `0x5eed0001`, 3,000 scenarios | green | F-6 in 192, F-11 in 19, F-2 in 2 |
| `0xfeed42` | one hard violation (scenario 583, `noid-stuck`), older than this commit | F-20 below |

Owed: the 3,000-scenario runs of the other seeds (`0xc4a05eed`, `0xdeadbeef`, `0x5eed01`, `0xfeed42`) on this tree. (Superseded for `0xfeed42` by the second batch below.)

### F-20 (new 2026-11-16) `noid-stuck`: Alice's recorded instance is gone and a newer incarnation holds the same slot. FIXED 2026-11-16 for the case before any reveal
Seen on `0xfeed42`, scenario 583 (replay: `CHAOS_SEED=0xfeed42 CHAOS_ONLY=583`); it is older than the commit of 2026-11-16 (`6cca4e2`) and not caused by it. Alice is in
`funding_final`. After reorgs her recorded instance is gone and the same slot holds a newer incarnation, so the tool said there is nothing to refund and only named
the instance for a wallet refund. The NOID stayed at the contract until it was taken back by hand. *Fixed before a reveal (commit `198241c`):* see the section below,
which also says why there is deliberately no such fix after a reveal.

## The stuck-instance finding and two chaos findings (2026-11-16, second batch)

Commit `198241c` answers F-20, and the parts of F-11 and F-6 that the engine can decide. It changes decisions and adds end states in narrow cases. It was reviewed
independently in three passes (the last one found nothing that must be fixed) and tested offline only; the new tests are in `tests/recovery_cases.rs`. Nothing was run against a real chain.

**F-20, before any reveal.** At and after `D`, in the phases `funding_final`, `lock_seen` and `lock_final` with no reveal on record, when the recorded instance is not
listed (and a configured second node is fresh and does not list it either) and no close before `D` was recorded, the engine offers the recovery close (`refund_noid`)
for the oldest instance of the agreed amount at the contract root. The note says that this is not the recorded instance and names the other instances at the root,
which this close does not cover. The tool writes a history entry `noid_recovery_adopted:<slot>:<creation>:<amount>` (helpers read the target from it), and a reset entry
`noid_recovery_adopted:recorded` when a recovery close is decided again for the recorded instance because it came back. A final adopted close does not make the file
`refunded` while the recorded instance is listed again; where the second node does not confirm the recorded instance absent, the file stays open and says why. Why it
is safe: every instance at this opening pays Alice on the recovery branch, and nothing before `D` reads the adoption. **After a reveal there is deliberately no adoption,
whatever markers exist.** After a reveal Bob may have claimed the recorded instance before `D`, and the file must not end with a label (`refunded`, or a recovery of "her"
NOID) that it cannot know to be true. There the note reads "whether Bob claimed the recorded instance before D is not known to this file; the instance at the root can
be recovered with the wallet". Tests: `x1_*`, `m1_*`, `s1_*`, `s3_*`.

**F-11, a close made by someone else, recorded once it is final.** `tick --closed-by TXID` now accepts, on both files, a close that is FINAL (18 blocks deep, and on a
configured second node too; otherwise nothing is recorded). On Bob's file a close at or after `D` is the recovery branch (it paid Alice): it is recorded log-only as
`noid_closed_after_deadline:<txid>:<height>`, and his file then ends with "claim branch closed: ..." naming its evidence, either the operator's recorded close or
"the instance was listed ... when the claim branch had closed (D ...) and block D - 1 was final" with a second node that agreed (the log-only entries
`noid_instance_alive_at_d` and `noid_alive_at_d_tip:<tip>`). On Alice's file a final close before `D`, after a reveal (`lock_final` with a reveal on record, or
`reveal_submitted`), is the claim branch (it paid Bob): it is recorded as `noid_closed_before_deadline:<txid>:<height>` and counts as the evidence the `lost` end state
needs (F-18). What remains open of F-11: Alice in `funding_submitted` (the file cannot know what closed an instance it never saw), and the F-18 state when no
`--closed-by` is given. Tests: `x3_*`, `s3_closed_by_needs_the_second_node_to_see_the_close_final_too`.

**F-6, for `locked`.** Bob's file in `locked` ends `aborted` when its lock is gone for good. That needs all of: no such lock on any node used, each node on the pinned
chain id and the pinned contract code hash, the head time at least `T_reveal` plus the profile's finality time, the finalized block's time at least `T_reveal` where the
node reports it (`finalized_timestamp`; required under `production`), and no other lock of his on this swap's lock word that is open or claimed. The argument in one
sentence: `newLock` reverts once the timelock is not in the future and `claim` reverts at or after the timelock, so a lock that is absent then can neither appear nor
be claimed. A pending `refund_eth` intent is resolved by that abort. What remains open of F-6: the refund phases (`refund_submitted`, `refund_mined`). Tests: `x4_*`.

**Notes (second batch).** Two forms of "abort not recorded": "abort not recorded: a <kind> was decided for this swap and never cancelled, so it may have been sent ..." and
"abort not recorded yet: ... cancelled at <unix> (unix), <hold> s are kept back after a cancel (<left> s left) ...". A note on a recorded "too late to fund" abort after a cancelled
funding with no instance at the root ("a fund_noid was decided and later cancelled (taken as not sent); no instance of this contract is visible and the funding window is
closed; if a funding was sent, it is no longer at the contract: check the wallet's history"). Tests: `x2_*`.

### F-21 (new 2026-11-16, OPEN) Bob's recorded lock is gone but another lock of his on the same lock word is open or claimed
It is the case the F-6 rule must refuse. Bob's lock is not on the chain, but his sender has
another lock to Alice's receiver on this swap's lock word, open or claimed, so the engine cannot say that nothing is locked and keeps waiting. An open one gets an
ALARM that names it once its own `T_reveal` has passed ("... it can be refunded by hand with `live.js refund` (this tool offers no action for a lock that is not in
this file)"). A CLAIMED one means the secret is public: the watcher now reads that lock's claim (`EthObservation.other_claims`), and Bob's file takes the preimage through the
usual check (it must hash to the lock word and match the NOID address), moves to `secret_seen` and offers the NOID claim, with the note "the secret was read from a CLAIMED
lock of Bob's other than the one in this file (same lock word)". Only Bob's own key can create such locks. The simulator never fills `other_claims`, so the chaos run does not
exercise the claimed-other-lock path, and `other_claims` was not exercised against a real node; the symptom of the open-lock path is recorded in the runs below.
Tests: `s2_*`.

### Five minor points left open on purpose (low, 2026-11-16)
The last review round left these open on purpose, and no further round was made; the work on these low findings was stopped there by decision.
1. (F-21) The "other lock of Bob's" check does not know when the watcher's read cap (8 locks) cut the list short. Only Bob's own key can create such locks.
2. (F-20) In the check of a final adopted close, a listing of the recorded instance on the SECOND node alone also sends the file back, where staying in `refund_included`
   until both nodes agree would be better. The file says nothing false, and `--closed-by` still ends it.
3. (F-20) That path writes the existing history entry `noid_tx_reorged` although nothing was reorged. No decision reads the name; it is wrong as a log line.
4. (F-20) After such a go-back, the final text is plain "done: NOID refunded" and the adopted close is only in the history.
5. (F-11, F-6) Bob in `secret_seen`, reached through another lock's claim whose recorded lock stays invisible, cannot end if his claim becomes too late: the abort waits on
   "the ETH lock is not visible" for ever. No money is held by the file.

### Chaos results of the second batch (commit `198241c`, 1,000 scenarios each, all green)

| Base seed | Open findings recorded |
|---|---|
| `0x5eed0001` | F-11 in 1 scenario, F-2 in 1, F-21 in 14 |
| `0xc4a05eed` (default) | F-21 in 15 |
| `0xdeadbeef` | F-2 in 2, F-21 in 19 |
| `0x5eed01` | F-2 in 2, F-21 in 12 |
| `0xfeed42` | F-2 in 3, F-21 in 16 |

F-6 is 0 on all five (the scenario of `0xfeed42` that failed before, 583, is fixed). `OPEN_FINDINGS` in `tests/chaos.rs` is the authority for the open list: F-2, F-6, F-7,
F-8, F-11, F-21 (F-6 and F-11 stay in it for what is left of them). No 3,000-scenario run is recorded for this commit.

## F-22 and F-23 (new 2026-11-17, OPEN): the Runner path holds a maybe-sent action for ever once the situation behind it has ended
Both are the F-2 hold (a pending action of unknown outcome is never retried blindly) meeting a state in which the held action can no longer matter, on the library
`Runner` path only. The command-line ledger path has the rule that resolves such a hold (REVIEW-5 R5-7: a `reveal_eth` intent resolves when its lock is closed); the Runner
lacks it. Live, the Runner is used only for Bob's claim; the command-line path is what the operator runs.
- **F-22 (`noid-stuck`).** Alice's Runner holds a maybe-sent `reveal_eth` (the executor crashed with an unknown outcome), Bob's lock was refunded to him, and the tip is at or past `D`:
  her file stays in `lock_final` ("a reveal_eth was sent ... waiting for it to appear on chain (clear the pending record by hand if it never will)") and never offers `refund_noid`.
  Who can lose what: the coin is not lost (after `D` only her recovery authority can close the instance; `recover-noid.sh` or the wallet takes it back), the tool only stops acting.
  Seen: `0xdeadbeef` scenario 1466 (early start) and 5888 (old start). Soft code `F-22 ...`: Runner mode, Alice's pending record is a maybe-sent `reveal_eth`, the lock was refunded
  (not claimed) on Ethereum, the tip is at or past `D`, and the NOID is still at the contract at the end. Narrowed on 2026-11-17 after an independent read: the code
  first accepted a claimed lock too, which is a loss for Bob (the ETH went to Alice, the NOID can only go back to her); that case is a hard `noid-stuck` again.
- **F-23 (`eth-stuck`).** Bob's Runner holds a maybe-sent `claim_noid` (crash with an unknown outcome), Alice's reveal was dropped by an Ethereum reorg and she took her NOID back at
  `D`; Bob's lock is open past `T_reveal` and his file stays in `secret_seen`, so the ETH refund is never offered. Who can lose what: Bob's ETH stays locked until he refunds it
  by hand (`live.js refund`), which the contract allows him at any time after `T_reveal`; nothing is lost if he does. Seen: `0xdeadbeef` scenario 5101 (old start). Soft code
  `F-23 ...`: Runner mode, Bob's pending record is a maybe-sent `claim_noid`, the lock is open on Ethereum past `T_reveal`, the tip is at or past `D`, and the NOID
  was paid back to Alice. The last condition was added on 2026-11-17 after the same read: without it a run in which the NOID went to Bob while the lock stayed open
  (Alice has neither leg) ended with the soft code; it is a hard `eth-stuck` again.
Both are in `OPEN_FINDINGS`, so the default run records them and `CHAOS_STRICT=1` still fails on them.

**An independent read of the oracle's 2026-11-17 changes (same day; reading only).** Two must-fix points, both in the soft codes above and both fixed (the narrowed
conditions; the suite is 742 passed, 0 failed after them). Left as they are, low:
- The late cutoff after a reveal of unknown outcome is coded as stated. The marker it reads never expires and is not tied to one lock, as in the engine.
- A reveal for an extra lock on the agreed terms is accepted at any height, also while the swap's own lock is open; the text says "after Bob's own lock was refunded,
  after `D`". Every check that protects Alice still applies to that lock (open, final, its own cutoff, one fitting instance), and the simulator judges the outcome through
  the swap's own lock, so nothing is hidden.
- The room before a budgeted claim reorg: the generator no longer makes a budgeted claim reorg in the last 520 s before `T_reveal`. A reorg there without a following
  stall is winnable and is now exercised only in the hostile regime, where any loss is excused: a coverage gap, not a hidden violation.
- The trial-start floor of the funding gate never applies in chaos runs; its branch is covered by the engine's unit test only.

### The 2026-11-17 runs (default draw, early start about one scenario in four)
Hard violations: 0 in every run below. `CHAOS_STRICT=1`, which also fails on open findings, lists:

| Base seed (size) | Open findings recorded |
|---|---|
| `0xc4a05eed` (1,000) | F-2 in 1, F-21 in 18 |
| `0xdeadbeef` (3,000) | F-11 in 1, F-2 in 7, F-21 in 46, F-22 in 1, F-6 in 1 |
| `0x5eed01` (3,000) | F-11 in 1, F-2 in 13, F-21 in 45, F-6 in 3 |
| `0x5eed0001` (1,000) | F-11 in 1, F-2 in 6, F-21 in 17 |
| `0xfeed42` (1,000) | F-2 in 4, F-21 in 18 |

Sweeps of `0xdeadbeef`, 8,000 scenarios, no hard violation in either: with `CHAOS_EARLY=0`: F-11 6, F-2 16, F-21 134, F-22 1, F-23 1, F-6 3, F-8 2 (outcomes: swapped 3,793, both refunded 1,138,
nothing locked 1,992, nothing funded 979, Alice lost a leg 44, Bob lost a leg 52, unresolved 2); with the default draw (2,026 early starts): F-11 6, F-2 33, F-21 123, F-22 2, F-23 1, F-6 4, F-8 2
(swapped 3,771, both refunded 1,148, nothing locked 2,000, nothing funded 966, Alice lost a leg 55, Bob lost a leg 57, unresolved 3). `OPEN_FINDINGS` in `tests/chaos.rs` is the authority:
F-2, F-6, F-7, F-8, F-11, F-21, F-22, F-23.

## The Ethereum lock kind (2026-11-05)

About two in five raw-variant scenarios (about 22 in 100 overall) now run against the `poseidon` lock (`HTLCPoseidonV2`, `docs/poseidon-leg.md`), the rest against `sha256`.
The kind is drawn from its own generator (`seed ^ 0x504f5345_4944_4f4e`), not from the scenario's `rng`, so every other choice of every scenario and seed is the one it
was before and the entries above still name the same scenarios. The simulator keeps one lock word (`World.hashlock`; SHA-256 of the secret or `Addr(s)`) and its claim assertion
is per kind (`watch::eth::lock_word_of`); the oracle's claim gate is per kind too. What changes for a poseidon scenario is exactly what the engine changes: an earlier lock on the word, by
anyone (the `side_lock` events), keeps Bob from locking (and from re-sending), and Bob's file carries a passed client R self-test (`example_bob_file`). Default seed and `0x5eed0001`
stay green with the mix; the stats line prints the split (`lock {"poseidon": …, "sha256": …}`).

## Limits of this test

- The simulator holds one real instance and one real lock; foreign instances and phantom locks are injected only where it can
  honour them. A party that adopts a foreign instance (F-7 / F-10) cannot be run to the end there (counted, not judged).
- Atomicity is judged exactly only in the budgeted regime. In the hostile regime a lost leg is "explained" by any of nine
  adversity tags, which is generous.
- Parano1d proofs, the real watchers and the transports are not exercised (they have their own tests).
- Chain clocks are coupled (one Ethereum block of 12 s drives the Parano1d blocks due in it, 20-49 s apart); a Parano1d chain
  faster than the 20 s planning figure is outside the test.
