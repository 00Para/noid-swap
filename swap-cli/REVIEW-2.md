# swap-cli review 2 (independent, adversarial, read-only)

Reviewed 2026-11-04 against the committed tree (`HEAD` = `95f6fb2`). Every `file:line` below is from `git show HEAD:<path>`. A concurrent edit to `src/engine.rs` (an "ETH refund seen" event for Alice) was ignored. I ran nothing: no cargo, npm, node or WSL. I read `swap-cli/` (README, REVIEW-1, `src/*.rs`, `src/watch/*.rs`, `src/client/*.rs`, `tests/scenarios.rs`, `tests/common/mod.rs`), `eth/scripts/live.js`, `eth/contracts/HTLC.sol`, `docs/live-run-1.md`, `docs/live-run-2.md`, design sections 2.2-2.5, 4, 5.5, 6.3-6.4, 7, 8 and 9, and the guard in `parano1d/harness/src/lib.rs`.

## Verdict

**Not safe against a real, possibly malicious counterparty with real money.** The decision engine is mostly right inside one tick: the (I1)/(I2) arithmetic, the fee cap, (I5) and the fail-closed choke point all hold up. The danger is around the engine:

- **The ETH contract's code is not required to be pinned, and is never checked before Bob's ETH moves.** Run 1 had no pin at all, and Bob deployed the contract.
- **The equivalence proof π is attested by hand, not verified.** Bob types H, A and two image ids, and the tool compares what he typed with itself and with the bundle.
- **Every spending action except Bob's NOID claim runs outside the tool.** `parano1d-cli contract fund`, `live.js lock`, `live.js claim` and `live.js refund` re-apply none of the gates and record no intent. So the REVIEW-1 C3/C4 protections (no double lock, no double funding) and the (I2) reveal cutoff are advice printed by `tick`, not enforced rules.
- **Each chain is read from one node, and a node that lags or lies is not detected.**

For further self-swaps of tiny amounts by the owner the tool is adequate, with the operator discipline the two runs showed. For a stranger, the seven items in "Must fix" come first.

**Status note, 2026-11-04.** All fourteen findings now have fixes in the committed code (F1–F4, F6–F14 during the day, F5 the same day; see each section). The verdict above is the review's original and stands until an independent re-review (REVIEW-3) checks the fixes themselves; the one piece still missing from the fix list is the compiled-in reproducible image id of F2 (M1.1). **REVIEW-3 (2026-11-05, `REVIEW-3.md`) did that check: F6, F8, F9, F11, F12, F13, F14 closed; F1, F2, F3, F4, F5, F7, F10 partial; four new findings G1–G4; verdict still "not yet for a stranger", with a new must-fix list.**

## Findings

| Id | Severity | Status | Claim | Citation |
|---|---|---|---|---|
| F1 | Critical | CONFIRMED | The ETH code hash is optional on both sides. It is checked only after a lock exists, so never before Bob sends ETH, and never at all when unpinned | main.rs:467, 519; swapfile.rs:298; engine.rs:152-156, 299-309, 314; eth.rs:181-188; live.js:233-309 |
| F2 | High | CONFIRMED | The π "attestation" is values Bob types. The tool never verifies the receipt, and the pinned image id is also a CLI flag | main.rs:523-538; swapfile.rs:357-385 |
| F3 | Critical | CONFIRMED | Gates are advisory in the live path. `tick` never records an intent, the external executors re-check nothing, and so double lock, double funding and a late reveal are one repeated command away | main.rs:260-288; engine.rs:459-470, 631-646, 748-764; live.js:233-309; HTLC.sol:134-135 |
| F4 | High | CONFIRMED | The reveal puts the secret on argv. `live.js claim --preimage`, including `--dry-run`, is fed from `swap-cli secret` stdout | live.js:292, 413; main.rs:596-603 |
| F5 | High | RISK | Single-source trust. The 120 s rule measures the poll's age, not the chain data's age. Lag and lies go undetected, and the built-in transport is plain HTTP to any host | engine.rs:329-348, 632; parano1d.rs:164-169; eth.rs:151-160; http.rs:49-53 |
| F6 | Medium | CONFIRMED | "Included" becomes "final" from the tip height alone. A ≤17-block reorg that drops Bob's claim (or Alice's refund) still ends in `done` | engine.rs:425-427, 566-568; main.rs:211-215 |
| F7 | Medium | CONFIRMED | Bob learns of his lock and of the secret only through `eth_getLogs`. `getLock` is called only after a `Locked` log is found, and `refund_eth` does not require the lock to be visible | eth.rs:181-188; engine.rs:323-327, 648-653 |
| F8 | Medium | CONFIRMED | No exclusive lock on the swap file and a fixed `.tmp` name, while the documented operation runs a `tick --apply` loop next to `claim --submit` | swapfile.rs:607-631, 683-687 |
| F9 | Medium | CONFIRMED | No cleanup of the leftover leg (REVIEW-1 M1). `secret_seen + TooLate` aborts (terminal in the Runner). Alice never refunds after a reveal | state.rs:399-402; engine.rs:654-691, 501-505 |
| F10 | Low | CONFIRMED | Lock discovery and the instance poll return only the first match, which lets a first junk lock or a dust instance grief the swap (and hides doubles, F3) | eth.rs:219-248; parano1d.rs:183 |
| F11 | Low | CONFIRMED | Alice accepts any `T_reveal` with ≥ `M_A` left. There is no (I3) `W_A_min` check, which gives Bob a cheap free option on Sepolia/mainnet | engine.rs:396-403; params.rs:253-260 |
| F12 | Low | CONFIRMED | Alice's cutoff clock is conservative. `--now` with a live RPC silently disables the staleness rule | engine.rs:128-130, 488-490; main.rs:243-251 |
| F13 | Low | CONFIRMED | Unchecked arithmetic and an `expect` on bundle or node data. No spending consequence found | swapfile.rs:240; engine.rs:461; harness lib.rs:120 |
| F14 | Low | CONFIRMED | `--fast-kdf` ships in the production CLI, and the KDF cost is read unbounded from the file (REVIEW-1 L3) | main.rs:473; swapfile.rs:408-420 |
| R1 | — | REFUTED | "Bob can be made to lock against an opening other than the one he rebuilt" | main.rs:216; swapfile.rs:222-239, 280-307, 642 |
| R2 | — | REFUTED | "`max_fee` can fall below 5,800, or bypass the 1 % cap" | swapfile.rs:253-261; harness lib.rs:309; engine.rs:613-622 |
| R3 | — | REFUTED | "a `refundable_payment`-style opening can slip through" | harness lib.rs:104-125, 306; swapfile.rs:222-226 |
| R4 | — | REFUTED | "a window can straddle 279,370" | params.rs:304-314; swapfile.rs:171, 252, 642 |
| R5 | — | REFUTED | "an unknown observation field lets a spend through" (except F1's code hash and F7's lock visibility) | engine.rs:284-365 |
| R6 | — | REFUTED | "malformed RPC data panics the watchers" | eth.rs:441-496; parano1d.rs:125-127; http.rs:32-33 |
| R7 | — | REFUTED | "Alice is told to reveal before Bob's lock is finalized" | engine.rs:412-414; watch/mod.rs:507-512 |
| R8 | — | REFUTED (claim path) | "a crash between the pending record and the send double-spends" | engine.rs:849-872, 896-924, 742-744; swapfile.rs:607-631 |

Erratum (2026-11-08): the chain's finality rule is 18 blocks after inclusion (`is_final`: tip >= height + 18), not 17; read the "17" in F6 as 18. The fix (follow the inclusion until final) is unchanged.

---

## F1. The ETH code hash is optional and is checked too late (Critical, CONFIRMED)

**Evidence.**
- **Optional at creation.** `new-alice` (main.rs:467) and `new-bob` (main.rs:519) both take `--eth-code-hash` as an optional flag. `check_bob_terms` compares the hash only `if terms.eth_code_hash.is_some()` (swapfile.rs:298). Run 1 ran with no pin on either side (live-run-1.md 14:22 UTC), and Bob deployed the contract himself (live-run-1.md, HTLC contract row).
- **Skipped when unpinned.** `lock_matches` checks the hash only when both the pin and the observation exist (engine.rs:152-156). `spend_blocker` accepts a reveal when nothing is pinned (`p.code_hash.is_none() || …`, engine.rs:314).
- **Read only after a lock exists.** The watcher computes `keccak256(eth_getCode(contract))` only when a `Locked` event was found (eth.rs:181-188). `spend_blocker` for `lock_eth` does not list it (engine.rs:299-309). So even a pinned hash is first compared after Bob's ETH is already inside the contract.
- **Not in `live.js` either.** `lock` and `claim` never look at the target's code; `deploy` reports `matchesArtifact`, and nothing else does (live.js:208-309).

**Attack on Alice (Bob deploys).** Bob deploys a look-alike contract:
1. It emits `Locked` events and serves `getLock` exactly as `HTLC.sol` would, so every cross-check passes (eth.rs:348-383).
2. Its `claim` stores the preimage and emits `Claimed`, but pays nothing.
3. Alice's file has no code hash, so her engine says `reveal_eth`. She reveals, Bob reads x and closes the NOID to himself.
4. Alice loses V.

**Attack on Bob (Alice deploys).** Alice gives Bob the address of a contract with a backdoor `withdraw`. Bob's `newLock` sends his ETH there. Even if Bob pinned the hash, the mismatch is reported only on the tick after his lock.

**Fix.**
1. Make `--eth-code-hash` mandatory in `new-alice` and `new-bob`. Make `check_bob_terms` require equality, with no `is_some()` escape.
2. In the watcher, read `eth_getCode(contract)` on every poll, not only when a lock is found.
3. In `spend_blocker`, require `eth.contract_code_hash == Some(pinned)` for `lock_eth`, `reveal_eth` and `refund_eth`.
4. Give `live.js lock/claim/refund` a required `--code-hash` and `--chain-id`, and make them refuse on a mismatch before signing.
5. Pin the hash of the artifact built from this repo (`deployedBytecode`) as a constant, so neither party takes it from the other.

## F2. The equivalence proof is attested by hand, not verified (High, CONFIRMED)

**Status.** Fixes 1 and 3 are applied: `new-bob --receipt FILE --equiv-prove BIN` runs the verifier itself with H and A from the bundle, parses its OK line and image id, and Bob's file stores the receipt path, its SHA-256 and the verification time (`src/equiv.rs`, `tests/equiv.rs`). Fix 2 (a compiled-in image id) and fix 4 (M1.1 reproducible id) are still open: `--pinned-image-id` remains a flag. The typed form stays as a documented fallback and is recorded as `source: "typed"`.

**Evidence.**
- `new-bob` builds the "verified journal" from `--equiv-h` and `--equiv-a`, which Bob types (main.rs:525-533). It takes `--equiv-image-id` **and** `--pinned-image-id` from the same command line (main.rs:534-538).
- `EquivalenceAttestation::check` then only compares these values with each other and with the bundle (swapfile.rs:375-384).
- Copying H and A from the bundle Alice sent, and pasting any 32-byte value twice, passes. No receipt is read anywhere in `swap-cli`. The tool says so (main.rs:551), but nothing proves `equiv-prove verify` ever ran.
- `equiv-prove verify` itself is sound: it checks the receipt against the guest ID compiled into Bob's binary and requires the journal to be exactly `variant ‖ H ‖ A` (equiv/zkvm/host/src/main.rs:185-186, 243-251). But the reproducible (docker) image id of M1.1 does not exist yet, so a real Bob cannot pin a value that is independent of Alice's build.

**Why it matters.** Design T10, "unsound: Alice takes both". If Alice publishes `A = Addr(s′)` with `s′ ≠ s`, Bob's post-reveal check (engine.rs:552-559) rejects s. Bob cannot claim, Alice refunds the NOID at D, and Bob loses the ETH.

**Fix.**
1. `new-bob --receipt FILE` runs `equiv-prove verify <variant> <H> <A> <FILE>` itself, as a subprocess, with H and A taken from the bundle, and parses its OK line and image id.
2. The pinned image id is a constant compiled into `swap-cli`, equal to the reproducible docker build, not a flag.
3. Store the receipt's digest in Bob's file.
4. Finish M1.1 (reproducible image id) before any real counterparty.

## F3. The gates are advisory in the live path (Critical, CONFIRMED)

**Evidence.**
- `tick --apply` applies only the derived *events* (main.rs:266-271) and prints `"action_executed": false` (main.rs:283). It never records `FundingSubmitted`, `LockSubmitted`, `RevealSubmitted` or a pending action, and it never applies an `Abort`.
- The `maybe_sent` / `retry_safe` machinery that fixed REVIEW-1 C3/C4 lives in `Runner::tick` (engine.rs:849-924). The CLI uses `Runner` only in `claim --submit` (main.rs:353-354).
- Funding, the ETH lock, the reveal and both refunds are typed by the operator into other tools that know nothing of the swap file.

**Consequences, each reachable by re-running one printed command.**

1. **Double ETH lock (Bob loses a second amount).**
   - Mechanism:
     - Bob in `funding_final` has no recorded `T_reveal`, so `expected_lock_id` is `None` (engine.rs:748-764).
     - Until his first lock is mined *and* found by discovery, every tick recomputes a fresh `T_reveal` from the current time (engine.rs:631-643).
     - `live.js lock` has no guard against an existing lock for this hashlock (live.js:233-276).
     - `HTLC.newLock` refuses only an identical lockId (HTLC.sol:134-135), and a new `T_reveal` gives a new lockId.
   - Outcome: two locks with the same hashlock and receiver. Alice's discovery returns the first (eth.rs:219-248), she reveals on it, and the same preimage then claims the second.
   - Likely trigger: a gas spike on Sepolia or mainnet, or a public RPC whose `eth_getLogs` lags.
2. **Double NOID funding (Alice loses an extra V).**
   - Mechanism: `created` yields `fund_noid` until an instance is visible (engine.rs:459-470), and `tick` never records `FundingSubmitted`.
   - Outcome: a second `contract fund` creates a second instance at the same root. The watcher reports only the first (parano1d.rs:183). After the reveal, anyone can close the second instance to Bob.
   - The README warns in prose only (README "Funding twice creates two instances").
3. **Late reveal (Alice loses both legs).**
   - Mechanism: (I2) is checked when `tick` runs (engine.rs:487-490). `live.js claim` checks only that `timelock` has not passed (live.js:301-304). It does not check `T_reveal − M_A`, and it does not check that the lock is finalized.
   - Outcome: an operator acting on a `reveal_eth` printed at `T_reveal − 1,801 s` can broadcast well past the cutoff. That is design 2.3 row 4: "Bob can then refund ETH *and* claim NOID".
4. **Wrong chain or endpoint for the lock.**
   - Mechanism: `live.js` checks the chain id only against an allow-list (live.js:98-109), not against the swap's `chain_id`. It reads `ETH_RPC_URL`, which need not be the node `tick` watched.
   - Outcome: a lock sent to Holesky instead of Sepolia passes every `live.js` check. Bob's own engine never sees it, and Alice cannot claim it. Bob's ETH sits until he refunds it by hand, and the swap fails.
   - (I1) itself is time-consistent: a late lock with the printed `T_reveal` is still safe provided blocks did not come faster than τ_fast in between. Only Alice's window shrinks.

**Fix.** One executor path per action, owned by `swap-cli`. Before each send it:
1. **Records the intent** (`pending_action`, `maybe_sent = true`) in the swap file before it signs or calls `contract fund`.
2. **Re-observes and re-runs `decide`** immediately before sending.
3. **Signs exactly the printed parameters**, with the code hash, chain id, `T_reveal` and lock id pinned.
4. **Stops printing a spending action while an intent of that kind is pending.**

If `live.js` stays separate, it must take the swap file (or a short-lived signed decision with a not-after time) and enforce, at send time:
- (I2) `now ≤ T_reveal − M_A`, with the lock finalized, for `claim`;
- no existing `Locked` event for this (sender, receiver, hashlock), and no recorded intent, for `lock`.

## F4. The secret goes through argv for the reveal (High, CONFIRMED)

**Evidence.**
- `live.js claim` takes `--preimage` as a command-line value (live.js:292, 413).
- The documented source is `swap-cli secret` on stdout (main.rs:596-603). Its own warning only covers `equiv-prove`.
- A `--dry-run` of the reveal also needs the secret on the command line. It lands in shell history and is visible to any process listing, *before* Alice has decided to broadcast.
- The same slip happened in run 1 with `equiv-prove` (live-run-1.md 13:52 UTC). That path now has `--secret-stdin`; the argv form was removed on 2026-11-04 (the parser refuses it without echoing the argument).
- Minor: `SWAP_PASSPHRASE` sits in the environment and is inherited by every spawned `curl` (exec.rs:102-108; no `env_clear`). The swap-file seal itself is sound (swapfile.rs:459-495; mode 0600 at main save on unix, 607-618).

**Why it matters.** A secret that leaks while Alice still holds it (for example after a dry run, then the cutoff passes) lets Bob close the NOID to himself and refund his ETH at `T_reveal`: Alice loses both.

**Fix.**
- `live.js claim` reads the preimage from stdin or from the swap file through `swap-cli`, never from argv.
- `--dry-run` takes only the hashlock.
- Remove the argv form of `equiv-prove prove`. **Done 2026-11-04.**
- Clear the environment for child processes (`Command::env_clear` plus the few variables `curl` needs).

## F5. Single-source trust; lag and lies are undetected (High, RISK) — **fixed 2026-11-04**: the Parano1d tip header time (`paranoid_getBlockHeader`) and the Ethereum head time are checked against the clock before every spending action; a second node (`--noid-rpc`/`--eth-rpc` given twice) must agree before `lock_eth` (same instance, tips within 2 blocks) and before `reveal_eth` (same lock record, `finalized` within 64 blocks, the lower one used); under `production` one node is refused unless `--single-node-ok`; plain `http://` only to loopback unless `--allow-plain-http`; 13 scenarios

**Evidence.**
- Both watchers stamp `observed_at` from the local clock when the poll starts (parano1d.rs:164, eth.rs:151). `spend_blocker` compares that stamp with `now` (engine.rs:329-348). That measures how old the *poll* is, not how old the *chain data* is.
- A node that is 200 blocks behind but answers in 1 s passes. The README says so ("a node that lags but answers quickly still looks fresh").
- No block-header timestamp is read on Parano1d. No second node is consulted.
- `--transport tcp` is plain HTTP to any host (http.rs:49-53), so a non-loopback endpoint can be tampered with in transit.

**Decisions that go wrong with a stale or lying node.**

| Decision | Stale by N blocks | Lying | Detectable now? |
|---|---|---|---|
| Bob `lock_eth`: instance exists, amount V, final, claim branch active, no pending call (engine.rs:598-646) | (I1) slack overstated by N, because `H_b = noid.tip` (engine.rs:632; params.rs:194-205). That eats into `B_epoch + B_fee`, exactly the budget Alice's T2 stall needs | Bob locks against a non-existent instance: total loss of the ETH | No |
| Bob `claim_noid` height class, rotation guard (engine.rs:673-690) | The D−18 target is judged on a stale height. The claim may land late, or carry a rotated anchor | Can stall Bob (fake pending call, fake "instance gone") | No |
| Bob `done` / Alice `refunded` (engine.rs:425-427, 566-568) | Late only | Declares a claim final that never happened: Bob stops watching | No |
| Alice `reveal_eth`: lock exists, terms, finalized, code hash (engine.rs:388-414, 487-490) | Discovery and finality are delayed (safe direction). The cutoff uses `max(now, latest_ts)` (engine.rs:128-130), so it stays safe | Alice reveals into a lock that does not exist and Bob claims the NOID. `live.js claim` re-reads `getLock` from `ETH_RPC_URL`, often the same provider (live.js:293) | No |
| Bob `refund_eth` (engine.rs:648-653) | Late only | Early: the refund reverts on chain (HTLC.sol:183). Gas only | — |
| Alice `refund_noid` | Late only | Early: the node and consensus refuse | — |

**Ethereum `finalized`.**
- **Handled correctly.** Unknown means `None` (eth.rs:156-160). Not finalized means no reveal (watch/mod.rs:507-512). On Hardhat, `finalized` equals `latest`, so the run-1 reveal at 0 confirmations was expected and harmless on a local chain. On Sepolia and mainnet the tag is the real finality checkpoint.
- **Nothing ties the finality rule to the chain id.** A real-value swap on a chain whose `finalized` maps to `latest` would reveal at 0 confirmations.
- `live.js` refuses chain id 1 outright (live.js:101), so real-money ETH is impossible today without editing the script.

**Fix.**
- Read the Parano1d tip header's timestamp and refuse spending actions if it trails the clock by more than about 3 × τ_nom.
- Require two independent nodes to agree before Bob locks and before Alice reveals: the same instance (slot, creation id, amount) and a tip within 2 blocks; the same lock record and finalized height.
- Refuse non-loopback `http://`.
- Document that each party must run its own Parano1d node.

## F6. A reorg after inclusion is not noticed (Medium, CONFIRMED)

**Evidence.**
- `ClaimIncluded → Done` (engine.rs:566-568) and `RefundIncluded → Refunded` (engine.rs:425-427) fire on `tip ≥ height + 17` alone.
- The watcher tracks a txid only in `claim_submitted` and `refund_submitted` (main.rs:211-215). After inclusion, nobody checks that the transaction is still in the chain.

**Why it matters.** A 17-block rollback is within the protocol's assumptions. If it drops Bob's claim and the node does not re-admit it (Q14 is open), Bob's tool says `done: NOID received` while the instance is live again, and Alice refunds at D. Bob loses the NOID after having paid the ETH.

Erratum (2026-11-08): the chain's finality rule is 18 blocks after inclusion (`is_final`: tip >= height + 18), not 17; read "17" in this section as 18.

**Fix.**
- Keep tracking the txid until final. Each tick, require `confirmed_tx.height == recorded height`.
- On disappearance, go back to `claim_submitted` (still pending) or `secret_seen` (re-prove).
- Add a scenario test that reorgs out an included claim.

## F7. Bob's view of his lock depends on logs only (Medium, CONFIRMED)

**Evidence.**
- `getLock(lockId)` is called only when a `Locked` log was found (eth.rs:181-188). With a lock id known, an empty `eth_getLogs` answer gives `lock = None` and `claimed = None`.
- An empty answer can come from:
  - `--eth-from-block` set above the lock's block (main.rs:228-231, operator-supplied);
  - a provider's block-range limit;
  - a lagging log index.
- Bob in `locked` then hits neither the refund nor the preimage fact (engine.rs:548-563).
- `bob_action(Locked)` says `refund_eth` on the timestamp alone (engine.rs:648-653), and `spend_blocker` does not require the lock to be visible for `refund_eth` (engine.rs:323-327).

**Why it matters.** If Alice already claimed, the refund reverts (harmless), but Bob never learns x. Alice refunds the NOID at D and Bob loses the ETH. The `getLock` ↔ logs consistency check (eth.rs:373-381) protects only when the logs return the `Locked` event.

**Fix.**
- Once the lock id is known, call `getLock(lockId)` on every poll, independently of the logs. Take x from its `preimage` field when `claimed` is true.
- Refuse `refund_eth` unless `getLock` shows the lock unclaimed and unrefunded.
- Default `--eth-from-block` to the pinned deployment block, never to a guess.

## F8. No exclusive lock on the swap file (Medium, CONFIRMED)

**Evidence.**
- `save` writes a fixed `<path>.tmp` and renames it into place (swapfile.rs:607-631, 683-687). Nothing takes a lock.
- Both runs used a background `tick --apply` loop (live-run-2.md 18:07 UTC) while `claim --submit` ran by hand.

**Why it matters.** `claim` loads the file and later saves it (main.rs:293, 353-354). A tick that saves in between is overwritten, or it overwrites `claim_submitted`. The engine then sees "a close by someone else" and ends at "verify the contract receipts manually" (engine.rs:655-672). Two writers sharing one `.tmp` can also rename a torn file into place.

**Fix.** Take an exclusive OS lock (`<file>.lock`, create-new, held for the process's life) in every command that saves. Use a random tmp suffix.

## F9. Leftover legs are not cleaned up (Medium, CONFIRMED; REVIEW-1 M1 still open) — **fixed 2026-11-04**: Bob gets `refund_eth` from every post-secret phase while his lock is open and the chain time ≥ `T_reveal` (`claim_noid` first while still possible); Alice gets `refund_noid` from `reveal_submitted`/`revealed`/`done` while the instance exists and the next call height ≥ `D`; 13 scenarios

**Evidence.**
- **Bob.** `secret_seen` + `TooLate` decides `Abort` (engine.rs:675-677), and that is terminal from `secret_seen` in the Runner (state.rs:399-402). If Alice's claim was pending and then reverted after `T_reveal`, Bob's ETH is refundable, but the tool never says `refund_eth`.
- **Alice.** In `reveal_submitted`, `revealed` and `done` she is never told to refund the NOID at D if Bob never claims (engine.rs:501-505).

**Fix.** As REVIEW-1 M1 proposed:
- Bob: `refund_eth` from any post-secret phase when `getLock` shows the lock open and `now ≥ T_reveal`.
- Alice: `refund_noid` from any post-reveal phase while the instance exists and `tip + 1 ≥ D`.

## F10. Only the first lock and the first instance are seen (Low, CONFIRMED) — **fixed 2026-11-04**: the watchers return every instance of the root and every matching lock (`instances`/`instance_count`, `locks`/`lock_count`, up to 8 locks read in full); a dust instance no longer hides the real one; with several fitting instances Bob waits, with several acceptable locks Alice reveals on none; all are listed in the notes

**Evidence.**
- `discover_lock_id` returns the first `Locked` event that matches (eth.rs:219-248).
- The NOID poll keeps the first non-empty slot (parano1d.rs:183). The comment at parano1d.rs:58-60 says a double funding "is visible, not hidden"; it is not.

**Why it matters.**
- Bob can place a first lock that fails Alice's checks (a wrong amount, a short `T_reveal`). Alice never sees a correct second lock.
- Anyone can fund the root with dust first, so Bob's `instance_ok` fails the amount check and he never locks.
- Both are liveness only, but they also hide F3's doubles.

**Fix.** Report every lock and every instance. Refuse to reveal or lock while more than one exists, and tell the operator.

## F11. Alice accepts a reveal window she cannot use (Low, CONFIRMED)

**Evidence.**
- The step-9 check is only `T_reveal − now ≥ M_A` (params.rs:253-255, engine.rs:396-403).
- `check_i3` (`W_A_min`) is still unused (params.rs:257-260).
- There is no upper bound on `T_reveal`.

**Why it matters.** With Ethereum finality of about 13–19 min, Bob can lock with 31 min left. The lock finalizes after the cutoff and Alice never reveals. This costs Alice's liveness only (her NOID returns at D), but it is a cheap free option for Bob.

**Fix.** Require `T_reveal − lock block timestamp ≥ W_A_min` at `EthLockSeen`.

## F12. The cutoff clock is right; `--now` is a foot-gun (Low, CONFIRMED)

**Evidence.**
- (I2) compares `max(local now, latest block timestamp)` with `T_reveal − M_A` (engine.rs:128-130, 487-490). That is conservative unless the local clock is slow *and* the node lags (F5).
- Bob's (I1) uses `min(now, latest_ts)` (engine.rs:631), the right direction (REVIEW-1 L1, applied).
- The two polls are sequential, so `H_b` may be up to 120 s, about 6 blocks, older than the Ethereum view. The 20-block `B_safety` absorbs that.
- `--now T` also overwrites both `observed_at` stamps (main.rs:243-251). With a live RPC this disables the staleness rule and pins the clock.

**Fix.** Allow `--now` only with fixtures.

## F13. Unchecked arithmetic and `expect` on untrusted data (Low, CONFIRMED)

**Evidence.**
- `p.h_create + ETH_D_OFFSET` adds bundle data unchecked (swapfile.rs:240; REVIEW-1 N2 still open).
- `noid.tip + B_FUND + B_FINAL` adds node data unchecked (engine.rs:461).
- `noid_pruv::compile(...).expect(...)` runs on bundle-derived parameters (harness lib.rs:120).
- Release builds wrap and debug builds panic. I found no path from these to a spend.

**Fix.** Use `checked_add` and turn the `expect` into an error.

## F14. KDF settings (Low, CONFIRMED; REVIEW-1 L3 still open)

**Evidence.** `--fast-kdf` (8 MiB, t=1) is reachable in `new-alice` (main.rs:473). `KdfParams` are read from the file without bounds (swapfile.rs:408-420), so a crafted file can exhaust memory.

**Fix.** Hide `--fast-kdf` behind `cfg(test)`. Bound `m_cost_kib` and `t_cost` at load.

## Refuted concerns (evidence)

- **R1. Can Bob lock against an opening other than the one he rebuilt? No.**
  - The NOID watcher queries by `file.public.opening_hex` (main.rs:216).
  - `new_bob` and `load` both require that hex to equal `try_compile_htlc(authority, bob, alice, D, max_fee)` byte for byte, and its root to equal `contract_root` (swapfile.rs:222-239, 586, 642).
  - `bob_noid`, the amounts, the chain, the contract and the sender must equal Bob's own terms (swapfile.rs:280-307).
  - What remains is whether A is bound to H. That is F2.
- **R2. Fee cap.**
  - `check()` enforces `50,000 ≤ F_max` and `100 × F_max ≤ V` with `checked_mul` (swapfile.rs:253-261).
  - The harness guard enforces `max_fee ≥ 5,800` (harness lib.rs:309).
  - Bob requires `F_max ≥ max(50,000, 3 × live estimate)` before locking (engine.rs:613-622).
  - The claim fee is clamped to `[5,800, max_fee]` (engine.rs:118-124; raw.rs:141-144).
- **R3. `refundable_payment`.**
  - Every opening is compiled from the pinned `htlc.pruv` and compared byte for byte.
  - The guard refuses `claim_recipient == claim_authority` (harness lib.rs:306).
  - `check()` also requires `claim_authority ≠ A_noid` (swapfile.rs:262).
- **R4. The v2.1 straddle.** `check_i5` runs in `build`, `check` and `load` (swapfile.rs:171, 252, 642). It refuses any window containing 279,370 and any `h_create < 279,388` (params.rs:304-314). Remaining: only that one boundary is known (REVIEW-1 L8).
- **R5. Fail-closed.** `spend_blocker` (engine.rs:284-365) does hold every listed field. The two gaps are the code hash for `lock_eth` (F1) and lock visibility for `refund_eth` (F7).
- **R6. Malformed RPC data.** All decoding returns `RpcError::Decode` (eth.rs:441-496; parano1d.rs:125-127). HTTP headers are capped at 64 KiB and bodies at 32 MiB (http.rs:32-33). The `expect("piped")` calls are on our own pipes.
- **R7. Reveal before finality.** `LockSeen → LockFinal` requires the same lock id and `finalized ≥ lock block` (engine.rs:412-414; watch/mod.rs:507-512). The reveal re-checks (I2) with a fresh clock (engine.rs:487-490).
- **R8. Persistence in the `claim --submit` path.**
  - The order is right: facts saved, then the intent saved with `maybe_sent = true` before `execute`, then the outcome saved (engine.rs:837-839, 896-924).
  - A pending action of unknown outcome is retried only if repeating it is harmless (`claim_noid`), and is never turned into an abort (engine.rs:849-872, 742-744).
  - Saves are tmp + fsync + rename (+ directory fsync on unix) (swapfile.rs:607-631).
  - A crash between a tick's observation and `--apply` loses nothing: the events are re-derived on the next tick.
  - The CLI path for every other action has no intent record at all (F3).

## Must fix before a real counterparty

1. **F1.** Make the ETH code hash and chain id mandatory, compiled-in or Bob-supplied, and check them on every poll before `lock_eth`, `reveal_eth` and `refund_eth`, in `swap-cli` *and* in `live.js`.
2. **F3.** Put fund, lock, reveal and both refunds behind one executor path that records the intent before sending, re-decides at send time, and refuses a second fund or lock while an intent is pending. Make `live.js claim` enforce `now ≤ T_reveal − M_A` with a finalized lock, and `live.js lock` refuse an existing lock for the hashlock.
3. **F2.** Verify π inside `new-bob`: run `equiv-prove verify` on `--receipt` with H and A from the bundle and a compiled-in reproducible image id (finish M1.1).
4. **F4.** Take the secret off argv everywhere: `live.js claim` reads stdin, a dry run needs no secret, and `equiv-prove`'s argv form is removed. **Done 2026-11-04** (the last part the same day; live run 3 revealed through the stdin pipe).
5. **F5.** **Done 2026-11-04** (see the F5 section). Run your own node on each chain. Check the Parano1d tip's header time against the clock, have a second independent node agree before Bob locks and before Alice reveals, and refuse non-loopback plain HTTP.
6. **F6 + F7.** Track inclusion until final (catch reorgs). Read `getLock(lockId)` directly on every poll, and refuse `refund_eth` unless the lock is visible and unclaimed. **Done 2026-11-04** (F7 first; F6 later the same day: an included claim or refund is followed with `paranoid_getTx` until final, a reorg sends the file back, a re-inclusion restarts the count; 7 scenarios).
7. **F8.** Take an exclusive lock on the swap file and use a unique tmp name.

## REVIEW-1 items: status in the committed code

| Item | Status | Where |
|---|---|---|
| C1 Bob's own terms | Applied, except the code hash, which is still optional (F1) | swapfile.rs:280-307; main.rs:509-522 |
| C2 π | Partly: an attestation of typed values, not a verification (F2) | swapfile.rs:357-385; main.rs:523-538 |
| C3 lock of unknown outcome | Applied in `Runner` only; the `tick` path has no intent record (F3) | engine.rs:849-872, 933-970 |
| C4 double funding | Applied in `Runner` only (`fund_noid` not retry-safe); the `tick` path is unprotected (F3) | engine.rs:742-744 |
| H1 refund vs revealed secret | Applied; weakened by F7 | state.rs:423; engine.rs:546-563 |
| H2 F_max bounds and overflow | Applied | swapfile.rs:253-261; engine.rs:613-622 |
| H3 code hash, chain id, EOAs, claim simulation | Partly: chain id and EOAs fail closed; code hash optional and checked late (F1); the claim is simulated only implicitly by `ethers`' gas estimate | engine.rs:145-185, 310-322; live.js:169 |
| H4 lock id wiring | Applied (`expected_lock_id`, discovery) | engine.rs:748-764; main.rs:221-238 |
| M1 leftover leg | Not applied (F9) | engine.rs:501-505, 675-677 |
| M2 fail-open, stale tip | Partly: `spend_blocker` applied; no lag check, no second node (F5) | engine.rs:284-365 |
| M3 foreign pending close | Applied | engine.rs:663-672 |
| M4 one lock-by | Applied (`D − 529` hard) | engine.rs:589; params.rs:215 |
| M5 missing 6.3 checks | Partly: `A ≠ A_noid`, test vectors and the registry are in; still missing `D − H_now ≤ 2·D_offset` and `getSlotsByOwner(A)` empty | swapfile.rs:262-267; main.rs:542-547 |
| M6 file lock | Not applied (F8) | swapfile.rs:607-631 |
| M7 client R snapshot | Not applied (separate anchor and slot-hint RPCs, no `previewObjectCall`) | raw.rs:257-271, 286-310 |
| M8 client S retry path | Not applied, and client S is not wired into any command | stock.rs; main.rs has no caller |
| L1 Bob's clock | Applied | engine.rs:631 |
| L2 file MAC | Not applied | swapfile.rs:453-495 |
| L3 KDF | Not applied (F14) | main.rs:473; swapfile.rs:408-420 |
| L4 all instances | Not applied (F10) | parano1d.rs:183 |
| L5 reverted claim scan | Not applied; pending claims are seen only via manual `--pending-tx` | eth.rs:391-417; main.rs:222-227 |
| L6 lock ids compared | Applied | engine.rs:413 |
| L7 `B_bob` origin | Not applied | engine.rs:632 |
| L8 `check_i3`, version schedule | Not applied (F11; R4) | params.rs:257-260, 304-314 |
| N2 unchecked add | Not applied (F13) | swapfile.rs:240 |
| N3 zeroize | Partly (`witness_bytes` returns `Zeroizing`; raw.rs copies it out) | secret.rs:112-116; raw.rs:165-166 |
| N4, N5 | Not applied | state.rs:384, 454-461; engine.rs:225-226 |
| N1 | Not re-checked | — |

## Not checked

- I ran nothing. The test counts (143 + 26) and the behaviour of the two live runs are taken from the docs.
- **Node behaviour, from the vendored source or the live node:**
  - whether `paranoid_getTx` still finds a transaction once its block body is pruned (42 blocks);
  - whether `getSlotHints` excludes mempool-reserved outputs;
  - whether reorged-out contract calls are re-admitted (Q14);
  - whether a Parano1d RPC exposes the tip header's timestamp (F5's fix assumes one does).
- **RISC Zero:** whether `equiv-prove verify` rejects dev-mode (fake) receipts in every build configuration, and the reproducibility of the image id (M1.1 is not done).
- **`ethers` v6:** whether `sendTransaction` always runs `estimateGas` (an implicit `eth_call` simulation) before signing.
- **Ethereum edge cases:** EIP-7702-delegated EOAs (the code check treats them as contracts, which fails closed); Hardhat's exact `finalized`/`safe` semantics beyond what live-run-1.md reports.
- **Other tools:** the stock-wallet commands that fund and refund (`parano1d-cli contract fund/call`), beyond the README text; `tests/` other than `scenarios.rs` and `common/mod.rs`.
- **The concurrent `engine.rs` edit.**
