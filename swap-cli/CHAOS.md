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
   exists or is pending, `tip + B_FUND + B_FINAL <= lock-by`. `lock_eth`: the agreed terms; funding final in the world;
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

**Open (not fixed in this round):** F-2, F-6, F-7, F-8, F-10, F-11, F-14 (described below, unchanged). One new finding, F-17, was found by the longer runs and fixed:

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
(replay: `CHAOS_SEED=<base> CHAOS_ONLY=<index> CHAOS_VERBOSE=1`). Counts are scenarios of the default 1,000.

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

### F-6 (Low) `locked` never re-checks the lock
A lock that left the chain for good (reorg, transaction dropped) leaves Bob in `locked` / `refund_submitted` /
`refund_mined` with "waiting for the secret". No funds at risk (nothing was locked). 75 scenarios (16, 37, 540).
**Fix:** a poll in which `find_lock` is empty and no lock transaction is pending, for N polls, emits `EthLockLost`
(back to `funding_final`, or `aborted` after the lock-by).

### F-11 (Low) Bob's file cannot end after Alice's recovery close beat him
Instance gone, no tracked transaction: `bob_claim_action` answers "verify the contract receipts manually" before it looks at
D; `--closed-by` refuses Alice's close ("pays Alice"). So `secret_seen` stays for ever. 5 scenarios (42, 444, 576, 716).
**Fix:** when the instance is gone, the claim branch is closed (`tip >= D`) and no tracked transaction exists, emit `Abort`
(`aborted: Alice recovered the NOID first`), and let `--closed-by` record a refused-because-late close as `aborted`.

### F-10 (Low) "More than one instance fits" is waited on for ever, also after D
Bob in `funding_final` (and Alice in `funding_submitted`, F-7) with two instances of the agreed amount at the root answers
`Wait` instead of `Abort` once the lock-by / D has passed. 5 scenarios. **Fix:** check the abort conditions (lock-by, D)
before the ambiguity wait.

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

### F-14 (Info) The ledger prints `refund_noid` again after a reorg re-queued the first
The intent resolved when the instance disappeared; a reorg brings the call back into the mempool and the instance back, and the
next tick records and prints a second `refund_noid`. The first-seen mempool refuses the second; harmless (scenario 979).
**Fix:** `alice_action` waits when `noid.pending_calls` is non-empty, as Bob's claim already does (T2).

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
F-14; `CHAOS_STRICT=1` fails on exactly those, 81 scenarios). Four runs of 3,000 scenarios (`0xc4a05eed`, `0xdeadbeef`, `0x5eed01`, `0xfeed42`) are
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
open finding closed: the list stays F-2, F-6, F-7, F-8, F-10, F-11, F-14. What the run still cannot show: R4-2's attack needs two nodes that disagree
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
`0xfeed42` are green (no hard failure; only the open findings are recorded).

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
