# swap-cli review 4 (independent, adversarial, read-only)

Reviewed 2026-11-05 against the committed tree, `HEAD` = `2077e78`. Scope: everything that changed since the code REVIEW-3
examined (`be9e3fa`): `git diff be9e3fa..HEAD -- swap-cli/src swap-cli/tests eth/scripts/live.js eth/contracts/HTLCERC20.sol scripts/live`
(the REVIEW-3 fixes, M2.5b, the chaos fixes, the validator relations, production `B_safety` 30, the mainnet gate of `live.js`).
`swap-cli/CHAOS.md`, `docs/formal/README.md` and `eth/FUZZ.md` were used as evidence and challenged, not trusted. Every
`file:line` below is from `2077e78`.

What I ran: the swap-cli suite once, in WSL (`~/verify-suite.sh`, one cargo process, 56 s): **385 passed, 0 failed, 1 ignored**.
Nothing else was run (no node, no network, no Hardhat, no live.js).

Evidence words: **CONFIRMED** (read in the code; a concrete sequence exists), **PLAUSIBLE** (follows from the code but needs a
chain, node or operator behaviour I could not check), **REFUTED** (the attack does not work, with the reason).

## Verdict

**(a) Owner controls both roles, or trusts the counterparty: yes, with real money at trial amounts only** (the planned
0.001 ETH against 10 NOID; never above the test-profile caps of 0.01 ETH / 20 NOID per swap before milestone M4), with the
run-4 discipline: a generous fee cap checked against the base fee just before the reveal, Alice signs her claim with the
`alice_receiver` key, no `intent --cancel` of a `lock_eth`, and swap-cli and live.js on the same RPC endpoint. Nothing found
moves value to a third party; the remaining failures strand a leg until a timeout or hand it to the counterparty, which a
trusted counterparty can return.
**(b) A stranger at the capped profiles: acceptable on `sepolia` only** (rehearsal is a local chain). The worst case is bounded
by the 20 NOID cap, because the ETH leg has no value. Each party runs their own build and their own node, and two nodes per
chain are configured. **Not for production or mainnet with a stranger** until R4-1, R4-2, R4-3 and R4-8 are fixed and M4 is done.

The engine itself held up. Every re-send rule I attacked either reuses the same on-chain identity (a duplicate reverts in
`HTLC.sol`) or stops at `T_reveal - DE`. `refund_mined` and `lost` fail safe against lagging nodes. The mainnet gate has no
signing path around it. What is left sits where the engine meets the operator and `live.js`:

- a reveal with a fee cap and no way to replace it (R4-1);
- a cancelled lock re-decided under a NEW lock id (R4-2);
- the late re-send that review H1 added is unreachable through `live.js` (R4-3);
- F5 is off by default in the helpers (R4-8).

## Summary

| Id | Finding | Severity | Status |
|---|---|---|---|
| R4-1 | Mainnet reveal: fixed `maxFeePerGas`, no base-fee check, no same-nonce replacement; a stuck claim publishes `s` and only Bob can use it | Medium (strangers, mainnet) | CONFIRMED path, event PLAUSIBLE |
| R4-2 | After `intent --cancel` of `lock_eth`, the next lock gets a fresh `T_reveal`, so a NEW lock id; a one-node nonce view can let both land | Medium (strangers) | PLAUSIBLE |
| R4-3 | Review H1's late re-send (`T_reveal - DE`) cannot pass `live.js claim`: default `--margin-s` 1,800 wins, `reveal.sh` does not lower it, mainnet forbids running without `--swap` | Low-Medium | CONFIRMED |
| R4-4 | H1 waives the "instance visible" gate but not the "two fitting instances" gate; a counterparty who funds a second instance blocks Alice's re-send and claims both | Low | CONFIRMED path, PLAUSIBLE precondition |
| R4-5 | `live.js claim` accepts any key, but drop detection and the cancel guard read `alice_receiver`'s nonces | Low | CONFIRMED |
| R4-6 | `spend_may_be_in_flight` counts RESOLVED intents, so after a lock (or funding) every later abort stays unrecorded | Low | CONFIRMED |
| R4-7 | A refund read from the `getLock` record carries `block = latest`, so Bob's `refund_mined` "moves" every poll and never becomes final while the log is missing | Low | CONFIRMED |
| R4-8 | Helpers add `--single-node-ok` whenever no second node is set (the owner has one NOID node); after the lock nothing checks the Ethereum head lag, so a lagging node can delay Bob's secret past `D` | Low-Medium (strangers) | CONFIRMED path, loss PLAUSIBLE |
| R4-9 | `lost` (terminal) can be declared on one lying node, or after a wallet close Alice did not poll; the watch loop then stops | Low | PLAUSIBLE |
| R4-10 | While one intent is held, a DIFFERENT ledger spend (e.g. `refund_noid` beside a held `reveal_eth`) is printed with parameters and never recorded | Info | CONFIRMED |
| R4-11 | `ETH_TX_GRACE_S` (600 s) is one constant: above the `RA` the validator assumes for a never-mined drop, longer than the whole rehearsal reveal window; `is_settled` hides the relay-floor note in a `done` that still needs a refund | Info | CONFIRMED |
| R4-12 | Documentation drift: `PROJECT.md` still says `D = creation + 725`, lock-by `D - 619`; old production files no longer load (fail closed) | Info | CONFIRMED |

Severity counts: Medium 2, Low-Medium 2, Low 5, Info 3.

## Detailed findings

### R4-1 (Medium for strangers on mainnet) A reveal priced under the base fee cannot be rescued

**Code.**
- live.js:153-156: on mainnet `maxFeePerGas = --max-fee-gwei` and the tip is `min(cap, 1 gwei)`.
- live.js:289-310: `mainnetCosts` checks the balance against `gas x cap`. It never compares the cap with the current base fee.
- live.js:317-357: `execute` lets ethers pick the nonce. live.js has no nonce flag and no replace command (grep: no `baseFee`, `getFeeData` or `nonce` in a send path).
- engine.rs:322-345: `eth_tx_dropped` holds while the signer's pending nonce is above its latest, so the file keeps saying "ETH claim pending" (engine.rs:1489).

**Attack.**
1. Alice reveals with `--max-fee-gwei 3x` the base fee of that minute, as docs/live-run-4.md:70 advises.
2. The base fee rises past the cap. It can climb 12.5 % a block, so three times takes about 10 full blocks, about 2 minutes. The claim sits in public mempools with `s` in its calldata.
3. A Bob who watches the mempool (his tool does this if handed the tx hash with `--pending-tx`, eth.rs:537-561) claims the NOID (`preimage_for` prefers pending calldata, engine.rs:205-211).
4. At `T_reveal` he refunds his ETH (engine.rs:1866-1867, 1893-1896).
5. Alice has no tool to bump her claim. A second `claim` gets nonce N+1 and waits behind N.

Loss: 10 NOID plus the 0.001 ETH she should have received. With an honest Bob the same event ends in two refunds: nothing lost, only the secret burned.

**Fix.** Before a mainnet `claim` (and `refund`), refuse when the cap is below about 2x the latest base fee plus the tip. Add `live.js claim --replace` that reuses the pending nonce with a higher fee and the same calldata. Print the base fee next to the worst case in the dry run.

### R4-2 (Medium for strangers) A cancelled lock is re-decided under a new lock id

**Code.**
- `cancel_intent_checked` (engine.rs:2262-2352) drops a `lock_eth` intent after 600 s when the swap-cli node shows `pending nonce == latest` and no lock with the intent's id.
- The next tick is back in `funding_final` and calls `choose_t_reveal` (engine.rs:1972), which returns `t_now + W_A` (params.rs:658). That is a new `T_reveal`, so a new lock id.
- Review H2's "same lock, never a second id" (engine.rs:1987-2014) covers only the Runner's `lock_submitted` path. The CLI never enters `lock_submitted`.
- `live.js lock` refuses only a MINED lock of this sender under this hashlock, or the new id (live.js:660-675).

**Attack.**
1. Bob's first `live.js lock` (nonce N) reaches backend X of the load-balanced public endpoint (env.sh:23, the default `ETH_RPC`) and sits in X's pool. It is underpriced, or simply slow to propagate.
2. 600 s later Bob's swap-cli asks backend Y for the nonces: `latest = pending = N`. The cancel passes.
3. `tick --apply` decides `lock_eth` with a fresh `T_reveal`. `live.js lock` hits X, where pending is N+1, so the new lock gets nonce N+1.
4. Both locks are mined. If the second lands after Alice accepted the first, her tool reveals on the first (G2 change, engine.rs:1437-1452: other locks "only pay her more") and only notes the second.
5. A greedy Alice claims the second with the public `s`, any time before its `T_reveal`.

Bob loses one lock amount: 0.001 ETH in the run-4 plan, up to 0.01 Sepolia ETH under `sepolia`. With one consistent node the nonce rule makes the two sends share nonce N, so at most one lands. The attack needs diverging mempool views. The chaos simulator has one mempool, so it cannot show this (CHAOS.md "Limits").

**Fix.** After a cancelled `lock_eth`, re-decide with the cancelled intent's `T_reveal` (same lock id, so `LockAlreadyExists` dedups it, HTLC.sol:134-135) while (I1), `M_A` and `W_A_min + DE` still hold; otherwise abort. Recording the tx hash in the intent and asking `eth_getTransactionByHash` before a cancel would also help.

### R4-3 (Low-Medium) The late re-send of review H1 cannot be sent through live.js

**Code.**
- Engine: once `secret_may_be_public` (engine.rs:1032-1034), `reveal_eth` is decided until `T_reveal - DE` (engine.rs:1401-1411). The intent freezes `cutoff = T_reveal - DE` (engine.rs:2210-2214, `reveal_cutoff_for` at 1038-1045).
- live.js: `cutoff = min(timelock - margin, intentCutoff)` with `margin` defaulting to 1,800 s (live.js:73, 791-792). The frozen cutoff can only tighten the check, never relax it.
- `scripts/live/reveal.sh:10` passes no `--margin-s`.
- Under `--mainnet`, `--swap` is mandatory (live.js:147-151), so there is no bypass.

**Attack (chain event, not an adversary).**
1. Alice's claim is mined near the production cutoff (`T_reveal - 1,800`) and reorged out about 19 minutes later, at `T_reveal - 660`.
2. The F-9 path sends the file `revealed -> reveal_submitted -> lock_final`, and the engine prints `reveal_eth` with cutoff `T_reveal - 120`.
3. `reveal.sh` refuses ("past the reveal cutoff"). The secret was public (it was mined), so Bob claims the NOID and refunds at `T_reveal`: both legs lost.

The chaos operator executes the printed action directly (chaos.rs:1545 uses the engine's cutoff), so the 3,000-scenario runs do not exercise live.js's rule. Probability: low on mainnet (a near-final reorg), but the fix is claimed as done, and on the real path it is not.

**Fix.** Under `--swap` with a `reveal_eth` intent, take the frozen cutoff as the authority. Default `--margin-s` from the file, `T_reveal - cutoff`, and accept a smaller flag only to tighten.

### R4-4 (Low) H1 re-send is blocked by the second-instance rule

**Code.** In `lock_final` the F-13 visibility gate is waived when the secret may be public (engine.rs:1418). The REVIEW-3 F10 rule "more than one fitting instance: no reveal" is not waived (engine.rs:1426-1436).

**Attack.**
1. Alice's mined claim is reorged out (the H1 situation).
2. Bob funds a second instance with the agreed amount at Alice's contract root. REVIEW-3 and CHAOS.md both treat third-party funding at the root as possible; I did not check it in the node.
3. Alice's re-send is refused: "revealing would let Bob claim every one of them".
4. `s` is already public, so Bob closes both instances to himself (`claim_recipient = Bob`) and refunds his ETH at `T_reveal`.

Bob's net cost is zero. Alice loses V NOID and the ETH. Once the secret may be public, withholding protects nothing.

**Fix.** Skip the multi-instance refusal when `secret_may_be_public(file)`. Keep the note that names the slots.

### R4-5 (Low) Alice's claim key is not tied to `alice_receiver`

**Code.**
- `live.js lock` refuses a key other than `bob_sender` (live.js:649-651). `claim` checks no signer (live.js:727-746, 761-868).
- swap-cli reads the nonces of `alice_receiver` for Alice (main.rs:403). Those nonces feed `eth_tx_dropped` (engine.rs:322-345) and the cancel guard (engine.rs:2308-2321).

**Effect.**
- A claim signed by another key is invisible to both. `intent --cancel` of a `reveal_eth` passes while the claim is pending.
- The cancel then erases the evidence `lost` needs (engine.rs:1047-1053), so a file in which Bob took both legs stays `lock_final` for ever.
- On the Runner path a pending claim is called "dropped" after 600 s and re-sent. That is harmless: the second claim reverts.

No direct loss.

**Fix.** Refuse `claim` unless the key is `alice_receiver`, as `lock` does for Bob.

### R4-6 (Low) Resolved intents block every later abort

**Code.** `spend_may_be_in_flight` (engine.rs:2233-2242) compares `intent_decided:<kind>` with `intent_cancelled:<kind>` only. An intent that RESOLVED (the funding or lock was seen) still counts as "decided, never cancelled".

**Sequence.**
1. Bob locks through `tick --apply`, so the history holds `intent_decided:lock_eth`. Alice claims the ETH.
2. Bob's NOID claim misses `D`: a stall, or a lying primary.
3. `bob_claim_action` returns `Abort` (engine.rs:1794-1796) and `bob_with_eth_left` keeps it (lock closed, engine.rs:1897).
4. `tick_apply` refuses to record it (engine.rs:2170-2186). The file stays `secret_seen` and prints `abort` on every tick, and `watch.sh` never stops.

Liveness and reporting only (the same end state as the open CHAOS F-11).

**Fix.** Treat `intent_resolved:<kind>` like a cancel for this check, or ask only about the currently pending intent plus the one-hour window.

### R4-7 (Low) Bob's refund read from the record never becomes final

**Code.**
- `cross_check_get_lock` synthesizes a refund with `block_number = latest_block` when the `Refunded` log is missing (eth.rs:508-513).
- `B::RefundMined` treats a different block as a re-inclusion (engine.rs:1648-1654). The value rises with every poll, so the count restarts on every poll.
- Alice's claim has the matching exception (engine.rs:980). Bob's refund does not.

With a capped log range or a lagging log index, Bob stays in `refund_mined` ("waiting for Ethereum finality") for as long as the log is missing. This fails safe. Liveness only.

**Fix.** The same rule as engine.rs:980: a record-sourced block only moves down.

### R4-8 (Low-Medium for strangers) F5 is opt-out in practice, and Bob's post-lock view is single-source

**Code.**
- `scripts/live/env.sh:52` adds `--single-node-ok` whenever `NOID_RPC2` or `ETH_RPC2` is empty, with one stderr warning. If either one is empty the flag waives the rule for BOTH chains.
- The owner has one NOID node; run 4 plans `--single-node-ok` (docs/live-run-4.md:103).
- `f5_gate` checks the Ethereum head lag only for `lock_eth` and `reveal_eth` (engine.rs:863-870). Nothing in Bob's `locked` / `refund_*` phases looks at `eth.latest_timestamp` against the clock.
- The second Ethereum node is never consulted for the secret.

**Sequence.** Bob's single Ethereum endpoint lags or stalls by an hour (its answers are well-formed and fresh in `observed_at`). Alice's claim lands; Bob's tool sees nothing. The design budgets `Delta_detect` = 300 s inside (I1), and the NOID claim branch closes at `D` before Bob learns `s`. Bob loses the NOID; Alice holds both. PLAUSIBLE: it needs a stalled RPC.

**Fix.**
- Make `--single-node-ok` an explicit line in `env.local.sh`, not the default.
- In Bob's post-lock phases, turn `eth_head_time_blocker` into a loud note or alarm.
- Read the second Ethereum node for the preimage too.

### R4-9 (Low) `lost` on one node's word, or after an unpolled wallet close

**Code.** `alice_both_legs_lost` (engine.rs:1075-1118) needs:
- Bob's refund final;
- `tip >= D + 18`;
- the recorded instance missing on the primary, and on the second node only if one exists;
- no `noid_instance_alive_at_d`;
- no `refund_noid` intent.

`reveal_evidence` also accepts a reveal intent that was decided and never sent (engine.rs:1047-1053).

**Sequences.**
1. One lying Parano1d node (`--single-node-ok`) reports a high tip and no instance from the moment of the reveal intent. `lost` is written and `watch.sh` stops (watch.sh:21).
2. CHAOS's own residual: Alice closes with the wallet without a tick between `D - 1` and the close.

In both cases the NOID stays recoverable with the wallet (the recovery branch pays only Alice), so nothing is lost unless the operator believes the file and walks away.

**Fix.** Before `lost`, require the second node when the profile requires one, and say in the reason "recover with the wallet if the instance is still listed".

### R4-10 (Info) A second ledger spend beside a held intent is not recorded

engine.rs:2187-2201 lets a different spend kind pass while an intent is held, and the `else if record` branch (engine.rs:2206) never records it. Example: Alice in `lock_final` with a held `reveal_eth` reaches `D` and is offered `refund_noid`. It is printed with its parameters on every tick and never frozen. It is harmless (a second close of the same slot is refused first-seen), but it is the one ledger kind that can still be printed twice.

### R4-11 (Info) Constants that do not follow the profile

- `ETH_TX_GRACE_S` = 600 s for every profile (engine.rs:316). The validator's `RA` (120 / 60 s, params.rs:337-338, 362-363) holds only for a mined-then-reorged claim, whose clock is back-dated (engine.rs:997). A claim that was never mined and then dropped is noticed after 600 s. Under `rehearsal` (`W_A` 600 s) the drop path cannot fire inside the window at all.
- `extras_notes` and the relay-floor note are skipped when `is_settled()` (engine.rs:482-494). A `done` that still needs `refund_noid` therefore does not warn that the relay floor exceeds `max_fee`.

### R4-12 (Info) Documentation drift and old files

`PROJECT.md` ("v1 timeouts") still says `D = creation + 725` and lock-by `D - 619`. params.rs, design §9.1 and docs/live-run-4.md:32 say 735 / 629 / 539. A production file created before `2077e78` no longer loads (swapfile.rs:326-334): this fails closed, and an in-flight swap would need the wallet.

## Attacks that failed (REFUTED)

**Re-send rules (question 1).**
- *Lock re-sent after a drop, Runner path:* same `T_reveal`, so the same id, and a duplicate reverts `LockAlreadyExists` (engine.rs:1612-1621, 1987-2014; state.rs re-send transition only when `t0 == t_reveal`; HTLC.sol:134-135). No second id there; the CLI path is R4-2.
- *Reveal sent after Bob can refund:* the engine needs `t_now + DE <= T_reveal` (engine.rs:1402), and live.js refuses once the latest block's time reaches `T_reveal` (live.js:785-787). `claim` and `refund` exclude each other in HTLC.sol:161, 183.
- *Refund or claim twice:* `AlreadyRefunded` / `AlreadyClaimed` (HTLC.sol:158-159, 181-182).
- *Never-propagated reveal, then a late re-send:* the Runner records `reveal_submitted` only after its executor sent. The repository has no real Ethereum executor (engine.rs:2356-2358), and on the CLI path H1 triggers only after a MINED claim (`eth_claim_mined`), which was public. A re-send then publishes nothing new. The residual risk is inclusion within `DE`, which is R4-1.

**`refund_mined` and `lost` (question 2).**
- *Lagging node:* it can only delay `refund_mined -> refunded` (finality is read, not assumed, engine.rs:1655) and `lost` (`tip >= D + 18` and refund finality, engine.rs:1084-1090).
- *Lying node:* it can fake Bob's refund finality, but the same node can already hide the secret (REVIEW-3 F5 residual). Nothing new.
- *Load-balanced backends:* they can push `revealed` back to `lock_final` for one poll (engine.rs:990-998). The resulting claim reverts `AlreadyClaimed`, or live.js refuses it (live.js:782). Liveness only.

**`done` / `is_terminal` / `is_settled` and the watch loop (question 3).**
- `done` is no longer terminal (state.rs:229-236, 269-275).
- `watch.sh` stops on `done` only when the action and notes name no refund, no "still at the contract", no open lock.
- The 1,200-character cut (watch.sh:15) can drop `phase_after` and keep the loop running. That is the safe direction.

**Mainnet gate (question 6).** Every signing path goes through `execute` -> `assertAllowedChain` (live.js:317-319, 180-198):
- chain 1 without `--mainnet` is refused;
- `--mainnet` without `--max-fee-gwei`, or combined with `--gas-price-gwei` or `--allow-chain-id`, is refused (live.js:131-144);
- `lock` / `claim` / `refund` under `--mainnet` without `--swap` are refused (live.js:147-151);
- a file with another chain or profile is refused (live.js:425-429);
- a chain-1 file without `--mainnet` is refused (live.js:504-506).

The fee arithmetic is BigInt wei (live.js:139-143, 289-310). Two small residues:
- ethers re-estimates `gasLimit` at send time, so the real worst case can exceed the printed one slightly.
- `send` and `deploy` need `--mainnet` and the cap but no swap file, which is by design.

There is no amount cap for production / mainnet anywhere: the amount discipline is procedural.

**Validator and budgets (question 7).** The relations hold with slack in every profile:

| Profile | `M_A` vs `FE + 2*DE + RA` | `W_A_min` vs `DE + FE + RA + M_A` |
|---|---|---|
| production | 1,800 >= 1,500 | 5,400 >= 3,180 |
| rehearsal | 300 >= 180 | 480 >= 420 |
| sepolia | 1,800 >= 1,500 | 3,360 >= 3,180 |

The engine reads every window from `file.public.params.profile.gates()`. The constants it uses directly (`B_FINAL`, `CLAIM_TARGET_MARGIN`) are 18 in all three profiles. `D_offset` and `lock_by_height` are re-derived and compared at load (swapfile.rs:326-334), so a file and a binary with different budgets refuse to work together. Production 735 / 629 / 539 is consistent in params.rs, the tests and docs/live-run-4.md.

`sepolia` and `rehearsal` keep `B_safety` 5, below the one adversarial NOID reorg the formal model needs (20). That costs only Bob's valueless leg, because the NOID moves to him only after the secret is public. Acceptable for those profiles.

**Abort recording and the one-hour hold (question 4).** The abort is not recorded while a funding or lock was decided and not cancelled (engine.rs:2170-2186), or within 3,600 s of a cancel (engine.rs:2239). This does what it says. Its over-reach is R4-6. The hold covers only the abort, not a re-funding or re-lock after the cancel: R4-2.

**`intent --cancel --i-checked-the-wallet` (question 5).** The flag only unlocks `fund_noid` when the node cannot say (engine.rs:2324-2339). A node that says `Some(true)` still wins. A false word from the operator gives a second instance. Alice's reveal is then refused (engine.rs:1426-1436), Bob waits before locking (engine.rs:1932-1934), and both sides refund. No loss.

## REVIEW-3 "Fix status" re-checked at HEAD

| Finding | Claimed | At `2077e78` | Evidence |
|---|---|---|---|
| F1 code hash | compiled in | CLOSED | params.rs `HTLC_CODE_HASH`; main.rs:768-777; swapfile.rs:242, 362, 410; live.js:433-436 |
| F2 typed attestation, image id | rehearsal only, id compiled in | CLOSED (M1.1 still open) | main.rs:957-992; swapfile.rs:550 |
| F3 read-only tick, cancel, live.js `--swap` | fixed | PARTIAL: read-only tick withholds parameters (main.rs:480-491, 557-561); cancel guards hold (engine.rs:2262-2352); live.js binds lock/claim/refund to the file (live.js:421-474), mandatory only on mainnet (live.js:1037 warns elsewhere). Still open: cancel then a NEW lock id (R4-2); no wrapper for Alice's manual `contract fund` | as cited |
| F4 child environment | cleared | CLOSED | child_env.rs:41 |
| F5 header time, sepolia two nodes, Bob's pending-call cross-check | fixed | CLOSED in code (engine.rs:694-704, 734-737, 1741-1762); PARTIAL in practice (R4-8) | env.sh:52 |
| F7 secret from `getLock`, from-block stored | fixed | CLOSED, with R4-7 as a side effect | eth.rs:496-516; main.rs:332-351 |
| F10 Alice, two fitting instances | no reveal | CLOSED, with R4-4 as a side effect | engine.rs:1426-1436 |
| G1 dev-mode receipts | refused | CLOSED (read the feature line and the kind check only) | equiv/zkvm/host/Cargo.toml:20; host main.rs:12, 174 |
| G2 free cancel option | extra locks do not stop the reveal | CLOSED; it widens R4-2's damage (a second lock now goes to Alice) | engine.rs:1437-1452 |
| G3 same node twice | refused | CLOSED (same scheme, host and port; same host on another port is a note) | main.rs:230-254 |
| G4 live.js claim terms | via `--swap` | CLOSED with `--swap`; the signer is unchecked (R4-5) | live.js:464-474, 768 |

The CHAOS open findings F-2, F-6, F-7, F-8, F-10, F-11 and F-14 are as described there. I found none worse than its stated severity. F-11 and R4-6 share an end state.

## Must fix before real money (ordered)

These apply even with a trusted counterparty or the owner in both roles: they strand or expose a leg through chain conditions or a tool gap, not through malice.

1. **R4-1.** Base-fee check before a mainnet `claim` (refuse a cap below about 2x the latest base fee plus the tip), and a same-nonce `--replace` for a stuck claim. Until then: a cap of at least 3x, and look at the base fee in the minute before the reveal.
2. **R4-3.** `live.js claim --swap` takes the intent's frozen cutoff as the authority (default margin from the file).
3. **R4-5.** `claim` refuses a key other than `alice_receiver`.
4. Keep PROJECT.md hard rule: trial amounts only until M4. No code-enforced amount cap exists for production.

## Must fix before strangers

1. **R4-2.** After a cancelled `lock_eth`, reuse its `T_reveal` (same lock id) or abort; never a fresh id.
2. **R4-8.** No default `--single-node-ok` in the helpers. An Ethereum head-lag alarm in Bob's post-lock phases. The second Ethereum node consulted for the secret. A second Parano1d node available to each party.
3. **R4-1** as a hard refusal, not an operator habit.
4. **R4-4.** Waive the multi-instance refusal once the secret may be public.
5. **R4-9.** `lost` needs the second node when the profile requires one.
6. M1.1 (reproducible image id) and M4 (external review), as already planned.
7. Low: R4-6, R4-7, R4-10, R4-11.

## Not checked

- Anything live: no node, Hardhat, Sepolia or mainnet; live.js and the helper scripts were read, not run. The live.js Hardhat suite was not run.
- Whether a third party can fund an instance at someone else's contract root (R4-4's precondition), and whether the wallet app can show a pending `contract fund` (the `--i-checked-the-wallet` premise).
- How load-balanced public Ethereum endpoints answer `eth_getTransactionCount(.., "pending")` across backends (R4-2's precondition).
- Ethereum mempool behaviour for a transaction priced below the base fee (kept and propagated, as geth does by default; assumed in R4-1).
- `tests/chaos.rs` in detail: I read its invariants and the operator's cutoff rule (chaos.rs:1545), not every scenario generator. CHAOS.md counts were not reproduced beyond the default run inside the suite.
- `docs/formal/model.py` was not re-run; the relations were checked by hand against params.rs.
- `equiv/zkvm/host` beyond the two G1 lines; `client/raw.rs` and `client/stock.rs`; the harness; `btc/`; `eth/FUZZ.md` claims (the contract was read only for the dedup and exclusion rules cited).
