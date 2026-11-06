# swap-cli review 3 (independent, adversarial, read-only re-review of the REVIEW-2 fixes)

Reviewed 2026-11-05 against the committed tree (`HEAD` = `be9e3fa`). Every `file:line` below is from that tree. I ran nothing: no cargo, npm, node, npx, WSL or network. Only `git show` and `git log` were used besides reading files.

What I read:

- `swap-cli/REVIEW-2.md` in full, `swap-cli/REVIEW-1.md`, the README sections on profiles, F5, intents and the runbook.
- `swap-cli/src/engine.rs`, `main.rs`, `swapfile.rs`, `state.rs`, `params.rs`, `equiv.rs`, `exec.rs`, `watch/eth.rs`, `watch/parano1d.rs`, `watch/http.rs`, `client/raw.rs` (snapshot RPCs only), `Cargo.toml`.
- Tests: `tests/scenarios.rs` (the F5, F6, F9 and F10 blocks), `tests/common/mod.rs`, `tests/intents.rs`, `tests/watch_eth.rs`, `tests/cli.rs`, `tests/cli_live.rs`, `tests/equiv.rs`, and the unit tests at the end of `engine.rs` and `swapfile.rs`.
- `eth/scripts/live.js`, `eth/contracts/HTLC.sol`, `eth/test/live.test.js`.
- `equiv/zkvm/host/src/main.rs` and its `Cargo.toml`, `equiv/README.md`.
- `docs/live-run-3.md`; `vendor/parano1d/noid_rpc/src/server.rs` for `getBlockHeader` and `getTx`.

Status words: **CLOSED** (the REVIEW-2 attack no longer works), **PARTIAL** (the main path is fixed, a stated gap remains), **NOT FIXED**, **REGRESSION**. Evidence words: **CONFIRMED** (read in the code), **PLAUSIBLE** (follows from the code but depends on something I could not read or run), **REFUTED**.

## Verdict

**Status note, 2026-11-05.** All seven "Must fix" items below have fixes in code, each verified by the maintainer's own suite run before its commit (see "Fix status" at the end). The verdict is the review's original and stands until a live run exercises the new gates and a fresh review checks the fixes.

**Not yet safe to hand to a stranger as it stands.** The engine itself is now good. Code hash and chain id are mandatory. Reorgs are tracked. Leftover legs are refunded. The file is locked. Every instance and every lock is seen. The decision choke point fails closed. What remains is around the engine and at its edges:

- **F3 is still the biggest gap.** A tick without `--apply` prints a spending action and records nothing (engine.rs:1704). `intent --cancel` only looks at mined effects, so it can release a second lock while the first is still in the mempool (engine.rs:1723-1739). `live.js` does not read the swap file.
- **F10, Alice side.** Alice reveals even when a second fitting NOID instance of hers sits at the root. Bob can then claim both (engine.rs:1150-1182).
- **F1 and F2 still trust a value from the operator's hands.** The code hash pin can come from the counterparty's chat message. The image id pin is a CLI flag. The typed attestation is still accepted in every profile.
- **G1 (new).** `equiv-prove verify` does not refuse `RISC0_DEV_MODE`, so on a machine where it is set, a fake receipt passes (CONFIRMED against the risc0-zkvm 3.0.6 source; see G1).
- **F5 fails open on one input.** An unknown Parano1d header time only adds a note (engine.rs:766-773).

Today the only real-value leg is NOID: `live.js` refuses chain id 1 (live.js:44). A tiny NOID-against-Sepolia trial with a stranger is acceptable **only** with this discipline: always `tick --apply`; never `intent --cancel` while a send might be in a mempool; Alice never funds by hand a second time; receipt mode only, with `RISC0_DEV_MODE` unset; each party computes the code hash from their own build of `eth/artifacts`; each party runs their own node. Fix items 1-4 of "Must fix" before anything with ETH value.

## Summary

| Id | REVIEW-2 severity | REVIEW-3 status | What remains | Citation |
|---|---|---|---|---|
| F1 | Critical | PARTIAL | Hash is mandatory and checked before every spend, but the pinned value is operator input, not compiled in | main.rs:642, 698, 761; swapfile.rs:235-237; engine.rs:163-173, 513-521 |
| F2 | High | PARTIAL | Receipt path works; typed fallback accepted in every profile; image id is a flag; M1.1 not done | main.rs:838, 848-860, 862-882; equiv.rs:134-168 |
| F3 | Critical | PARTIAL | Read-only tick prints spends unrecorded; cancel ignores mempools; live.js is not tied to the file; no re-decision at send time | engine.rs:1704-1716, 1723-1739; main.rs:398, 422; live.js:392-472, 484-594 |
| F4 | High | PARTIAL (minor) | Argv closed; child processes inherit `SWAP_PASSPHRASE` (no `env_clear`) | live.js:729-734; exec.rs:102; equiv.rs:184-190 |
| F5 | High | PARTIAL | Unknown header time passes with a note; same URL twice accepted; sepolia and rehearsal allow one node; claim and refund not cross-checked | engine.rs:610-613, 640-647, 766-778; parano1d.rs:258-266; main.rs:220-258 |
| F6 | Medium | CLOSED | False reorg if `getTx` forgets an old tx (PLAUSIBLE); a lying node can still fake finality | engine.rs:1315-1335; state.rs:452-457, 566-590; main.rs:285-292 |
| F7 | Medium | PARTIAL | `getLock` read every poll; secret still only from logs; `--eth-from-block` defaults to 0 | eth.rs:156-250, 414-449; main.rs:315-318 |
| F8 | Medium | CLOSED | Lock is advisory; drvfs `flock` untested; `claim --submit` blocks ticks while proving | swapfile.rs:797-826, 887-894, 907-931; main.rs:377-382, 398, 496 |
| F9 | Medium | CLOSED | None found | engine.rs:1184-1248, 1410-1451; HTLC.sol:155-161, 177-183 |
| F10 | Low | PARTIAL | Alice reveals with extra fitting instances; locks beyond 8 counted not read; dust at the root blocks funding | engine.rs:1150-1182, 1676-1679; eth.rs:112, 196-201 |
| F11 | Low | CLOSED | No upper bound on `T_reveal` (Bob's own risk) | engine.rs:881-906; params.rs:649-651 |
| F12 | Low | CLOSED | None | main.rs:276-280; cli_live.rs:487 |
| F13 | Low | CLOSED | Coverage of every add is PLAUSIBLE, not proved | swapfile.rs:320; engine.rs:1121-1123 |
| F14 | Low | CLOSED | KDF bounds are upper only; a `cargo test` build of the binary has `--fast-kdf` (PLAUSIBLE) | main.rs:657-666; swapfile.rs:555-573, 838-840; Cargo.toml |
| G1 | new | Medium | `equiv-prove verify` accepts dev-mode receipts when `RISC0_DEV_MODE` is set | equiv/zkvm/host/src/main.rs:180-187, 198-201, 238-247 |
| G2 | new | Low | The F10 "another open lock" rule gives Bob a free cancel option | engine.rs:1154-1170 |
| G3 | new | Low-Medium | The second node is not checked to be a different endpoint | main.rs:220-258 |
| G4 | new | Low | `live.js claim` does not check receiver, amount or sender against the swap terms | live.js:484-594 |

## F1. ETH code hash (Critical in REVIEW-2) — PARTIAL

**Evidence (CONFIRMED).**

- `new-alice` requires `--eth-code-hash` and `--eth-chain-id` (main.rs:696, 698). `new-bob` requires both from Bob's own terms (main.rs:761). `build_with_options` refuses an unpinned hash (swapfile.rs:235-237). `check_bob_terms` requires equality with the bundle (swapfile.rs:394-396).
- The watcher reads chain id and code on every poll (eth.rs:171-175).
- `lock_matches` is strict on both (engine.rs:163-173). `spend_blocker` requires both before `lock_eth` (engine.rs:513-521, 556-567). Reveal and refund need the named lock visible and matching (engine.rs:569-583).
- `live.js` checks the target before lock, claim and refund (live.js:267-282).

**Attack on the fix.** The pin is whatever the operator types. `CODE_HASH_WHY` (main.rs:642) even tells the user the hash may come from the `live.js deploy` output. In a stranger swap where Bob deploys, Bob deploys a look-alike HTLC whose `claim` does not pay or whose `refund` works early for him. He sends Alice the address and "the hash from the deploy output". Alice pins it. Every check now passes, because they compare the chain to the attacker's number. Alice reveals into a contract that never pays her, and Bob claims the NOID. PLAUSIBLE as a social attack; the code path is CONFIRMED.

**Residual risk.** One trusted value from outside the build. `check()` does not itself require a hash (swapfile.rs:281-355); only creation does. An old file without one still loads (nothing in `load`, swapfile.rs:828-848, requires the pin), but it cannot spend: `lock_matches` refuses an unpinned file (engine.rs:171) and `spend_blocker` refuses every ETH spend without a pin (engine.rs:561). Fail closed, and TASKS.md records it as a decision. CONFIRMED by the maintainer (see the verification note at the end).

**Tests.** `cli.rs:170` asserts that both flags are mandatory for both roles and that nothing is written (asserts the property). `watch_eth.rs:295-317` and `engine.rs:2294, 2407` assert a wrong hash blocks `lock_eth` (assert). `live.test.js:340-411` asserts the live.js target check. No test asserts the hash equals the repo artifact, because nothing compares it.

**Fix.** Compile `keccak256(deployedBytecode)` of `eth/contracts/HTLC.sol` into the binary (or read it from the local `eth/artifacts`) and refuse any other value. Drop the "from the deploy output" text.

## F2. Equivalence proof attested by hand (High) — PARTIAL

**Evidence (CONFIRMED).**

- `new-bob --receipt` runs `equiv-prove verify` with H and A from the bundle and checks its output (main.rs:862-882; equiv.rs:84-130, 134-168).
- The typed fallback is still accepted (main.rs:848-860), with `Typed` as the default source (swapfile.rs:459-470). No profile refuses it.
- The pinned image id is a CLI flag (main.rs:838). M1.1 (the reproducible docker image id) is not done.
- `load` requires an attestation for Bob (swapfile.rs:841-846), but either kind passes.

**Attack on the fix.** A stranger Alice says "the prover crashed, here are H and A, type them in". Bob, a non-expert, uses the typed path. A is an address whose secret is unrelated to H. Bob locks ETH; Alice reveals s for H; Bob cannot claim the NOID. CONFIRMED that the tool permits this path.

Second: the image id flag. A malicious Alice sends a receipt for her own guest and "the image id". But `equiv-prove verify` checks against its compiled-in `EQUIV_GUEST_ID` (equiv/zkvm/host/src/main.rs:238-247), and swap-cli compares the printed id to the flag. So a wrong flag makes the check fail, not pass, unless the attacker also supplies the `equiv-prove` binary. CONFIRMED that the flag cannot widen acceptance by itself; it is the binary's build that matters.

Third: a TOCTOU nit. swap-cli reads the receipt bytes (equiv.rs:144) and the subprocess reads the file again. Only an attacker with write access to Bob's disk can use it. Low.

**Residual risk.** Typed mode; and G1 (dev mode).

**Tests.** `tests/equiv.rs:62-192` asserts output parsing, wrong H/A, wrong image id and runner failures with a fake runner (asserts the parsing property; the real verifier is exercised only by the equiv host tests, which I did not run). No test asserts that typed mode is refused, because it is not.

**Fix.** Refuse typed mode outside `rehearsal`. Compile the image id into swap-cli. Finish M1.1.

## F3. Gates are advisory in the live path (Critical) — PARTIAL

**Evidence (CONFIRMED).**

- `tick --apply` now records a `pending_intent` for ledger kinds before printing (engine.rs:1704-1716; INTENT_KINDS at 1575), holds any repeat while it is pending (engine.rs:1685-1703), and resolves it when the chain shows the effect (engine.rs:1606-1634). The file is saved before printing (main.rs:423-425).
- `fund_noid` is refused while any instance exists at the root (engine.rs:1676-1679).
- `live.js` reads the secret only from stdin or a file (live.js:189-214), refuses a TTY (172-187), applies a reveal cutoff (518-527), requires finality (548-559), and refuses to lock when its own `Locked` event or lock id already exists (411-432).

**Attack 1: the read-only tick.** `tick` without `--apply` takes no lock (main.rs:398), calls `tick_apply(..., false)` (main.rs:422), and prints the decided action, including `lock_eth` with its parameters, without recording anything (engine.rs:1704). `tests/intents.rs:95-110` asserts exactly this. An operator who runs `tick` once, sends the lock, then runs `tick` again before it is mined sees a fresh `lock_eth` with a fresh `T_reveal`. CONFIRMED.

**Attack 2: cancel with a pending send.** `cancel_intent` refuses only when the effect is already on chain (engine.rs:1723-1739). On a Sepolia gas spike, Bob's lock 1 sits in the mempool. He cancels "the stuck intent", ticks, and is told to `lock_eth` again with a new `T_reveal` (expected_lock_id 1788-1812 follows the new intent). `live.js lock` scans mined logs only (live.js:411-429), so it does not see lock 1. Both locks are mined. A malicious Alice reveals on lock 1 just before its cutoff, claims lock 2 with the now-public s, and the NOID she owes covers only one. Under the F10 rule her tool would refuse, but a malicious Alice does not use the tool. Bob loses one lock amount. CONFIRMED path; the timing is PLAUSIBLE.

**Attack 3: live.js stands alone.** `live.js` does not read the swap file or the intent. It has no (I1) check at lock (live.js:392-472). Its reveal margin is `--margin-s`, a free flag with default 1800 (live.js:90-93, 518-527), not the file's `M_A`. A typo in `--lock-id` or `--t-reveal` goes through. CONFIRMED.

**Attack 4: Alice's funding.** `parano1d-cli contract fund` has no guard at all. The `fund_noid` guard in tick_apply only helps if the operator runs tick before each fund. CONFIRMED (no code path exists).

**Residual risk.** Double lock for Bob; double funding for Alice (which combines with F10 below); a reveal after the file's cutoff if the margin flag is set lower.

**Tests.** `intents.rs:49-268` asserts recording, holding, resolving and cancel-refused-when-mined (asserts). It also asserts the read-only behaviour that is the gap. No test covers cancel with a pending, unmined transaction.

**Fix.** A read-only tick must not print a spending action's parameters; print "would decide X, run with --apply". `intent --cancel` must require a mempool check by tx hash (or refuse while the intent is younger than a timeout and no tx hash is known). `live.js lock/claim/refund` should take `--swap FILE` and re-check the intent, `T_reveal`, amount, receiver and `M_A` from it.

## F4. Secret on argv (High) — PARTIAL (minor)

**Evidence (CONFIRMED).** `live.js` refuses `--preimage` and `--secret` in the parser (live.js:729-734). The secret comes from stdin or a file (live.js:189-214). `equiv-prove` lost its argv form (commit 6e2afbf). `swap-cli secret` prints to stdout with a warning (main.rs:931-938).

**Attack on the fix.** Children inherit the environment: `exec.rs:102` and `equiv.rs:184-190` spawn without `env_clear`. `SWAP_PASSPHRASE` is visible to `/proc/<pid>/environ` of those children, readable by the same user. The secret itself is not in the environment. Low.

**Tests.** `live.test.js:672-783, 842` assert the refusals (asserts).

**Fix.** `env_clear()` and pass an allow-list in both runners.

## F5. Single-source trust (High) — PARTIAL

**Evidence (CONFIRMED).**

- The choke point applies F5 after `spend_blocker` (engine.rs:414). Constants: 300 s Parano1d tip lag, 600 s Ethereum head lag, tips within 2 blocks, `finalized` within 64 blocks (engine.rs:595-602).
- Second-node policy: an error on the second node blocks (engine.rs:640-642); production with one node and no `--single-node-ok` blocks (643-645); otherwise a note (646-647).
- Agreement rules: same instance and tip (engine.rs:663-685); same lock record and finalized height, lower one used (690-748).
- Plain `http://` only to loopback unless `--allow-plain-http` (main.rs:189-198; http.rs:110-128).
- The vendor RPC has `getBlockHeader` with a timestamp (vendor server.rs:2004), so the method the fix depends on exists.

**Attack 1: unknown header time passes.** The watcher swallows any header error into `None` (parano1d.rs:258-266). `noid_tip_time_blocker` returns `None` for `None` (engine.rs:610-613), and `f5_gate` only adds a note (engine.rs:766-773). A node that serves a frozen tip and answers `getBlockHeader` with an error defeats the lag rule. With one node (sepolia, rehearsal, or `--single-node-ok`), nothing else catches it. CONFIRMED.

**Attack 2: the same node twice.** `chain_source` accepts at most two URLs per chain but does not check they differ (main.rs:220-258). `--noid-rpc X --noid-rpc X` passes the production rule. Two hostnames of one provider pass too. See G3. CONFIRMED.

**Attack 3: claim and refund are single-source.** Cross-checks run only before `lock_eth` and `reveal_eth`. A lying primary can report a fake pending call on Bob's instance. `bob_claim_action` then waits (engine.rs:1354-1363) until `TooLate` and Abort (1366-1368). Alice already has Bob's ETH (she revealed), and she refunds the NOID at D. Bob loses his side. CONFIRMED path; requires a lying node.

**Attack 4: profiles.** `sepolia` and `rehearsal` accept one node with a note (engine.rs:646-647). Rehearsal also skips the Ethereum head rule (engine.rs:777-778). Run 3 used `sepolia` with one node. CONFIRMED.

**Attack 5: live.js.** It uses one `ETH_RPC_URL` from the environment with no plain-HTTP rule (live.js:756). CONFIRMED.

**Live evidence.** None. F5 postdates run 3, and `docs/live-run-3.md:188` says F5 was not exercised.

**Tests.** `scenarios.rs:2057-2329` (13 scenarios) and `engine.rs:2555, 2571, 2594, 2617` assert the rules above, including stale second polls and the 2-block tip window (assert). No test asserts what happens when `tip_time` is `None`, beyond the note.

**Fix.** Treat `tip_time = None` as a blocker for spending actions. Refuse identical second URLs and print both hosts. Require two nodes in `sepolia` when the counterparty is not the owner. Cross-check the pending-call view before Bob waits on a foreign close.

## F6. Reorg after inclusion (Medium) — CLOSED

**Evidence (CONFIRMED).** The tracked txid includes `ClaimIncluded` and `RefundIncluded` (main.rs:285-292; parano1d.rs:240-252). A missing tx sends Alice back to `FundingFinal` (state.rs:452-457) and Bob back to `submitted` or `secret_seen` (state.rs:566-590; engine.rs:1315-1335). Re-inclusion restarts the count. `included_outcome` handles each case (engine.rs:1077-1088). `tick --closed-by` records an outside close (engine.rs:1012-1057, 969-1000).

**Attack on the fix.** `getTx` uses the tx index, then recent trade receipts (vendor server.rs:2045-2071). If the index forgets a tx once its body is pruned (42 blocks), a final claim looks "gone". The file goes back to a non-terminal phase with a misleading reorg note. This cannot move funds: the next claim would fail at admission. PLAUSIBLE; I could not check pruning behaviour. A lying node can still declare finality; that is F5.

**Tests.** `scenarios.rs:1492-1674` asserts reorg back-transitions and re-inclusion (asserts).

## F7. Bob's view of his lock (Medium) — PARTIAL

**Evidence (CONFIRMED).** Discovery runs on every poll (eth.rs:177-182). `getLock` is read for each matching lock, and an inconsistency between log and record fails the poll (eth.rs:414-449). No log means `require_no_record` (eth.rs:221-227, 255-267). `refund_eth` and `reveal_eth` need the lock visible, unclaimed and unrefunded (engine.rs:569-575).

**Attack on the fix.** The secret is still taken only from the `Claimed` log, not from `getLock` (eth.rs:438-447). A provider whose log index lags persistently makes every poll fail. That is loud (every tick errors), but if it lasts until D, Bob loses the NOID he could have claimed. `--eth-from-block` still defaults to 0 (main.rs:315-318), which makes the log query large on Sepolia and more likely to hit provider limits. PLAUSIBLE.

**Tests.** `watch_eth.rs:270-292` asserts the inconsistency failure (asserts).

**Fix.** Read the preimage from `getLock` when the record says claimed. Default `--eth-from-block` to the block where the swap was created.

## F8. File lock (Medium) — CLOSED

**Evidence (CONFIRMED).** `SwapLock::acquire` uses `File::try_lock` on `<file>.lock` (swapfile.rs:907-931). Saves use a random tmp name, `create_new`, fsync and rename (swapfile.rs:797-826, 887-894). `tick --apply`, `intent --cancel` and `claim --submit` take the lock (main.rs:398, 484, 496), with a 10 s wait (main.rs:377-382).

**Residual.** The lock is advisory: a read-only tick does not take it. Whether `flock` works on drvfs (`/mnt/c`) is untested; run 3 kept the file on the Linux side (PLAUSIBLE). `claim --submit` holds the lock while proving, so a parallel `tick --apply` errors after 10 s; that is safe but noisy.

**Tests.** `swapfile.rs:1287` asserts the lock primitive excludes a second holder (asserts).

## F9. Leftover legs (Medium) — CLOSED

**Evidence (CONFIRMED).** Bob refunds ETH from every post-secret phase while his lock is open and chain time ≥ `T_reveal`, claiming NOID first while possible (engine.rs:1410-1426, 1431-1451, 1540-1564). Alice refunds NOID after her reveal if the instance still exists and the next call height ≥ D (engine.rs:1184-1210, 1225-1248; params.rs:794-796).

**Attack on the fix.** Can either refund fire while the other side can still claim? On Ethereum, `claim` needs `timestamp < timelock` and `refund` needs `timestamp ≥ timelock` (HTLC.sol:155-161, 177-183), so they exclude each other. On Parano1d the branch flips at D, so Alice's refund cannot coexist with Bob's claim at one height. REFUTED.

**Tests.** `scenarios.rs:278-527` asserts both refunds and their gating (asserts).

## F10. Only the first lock and instance were seen (Low) — PARTIAL

**Evidence (CONFIRMED).** The watchers return all instances (parano1d.rs:204-219) and all matching locks (eth.rs:196-201). Bob waits when several instances fit (engine.rs:1484-1487). Alice refuses to reveal when another open lock fits (engine.rs:1154-1170).

**Attack on the fix: Alice's extra instance.** Alice's reveal checks other locks, but not other instances of her own root (engine.rs:1150-1182). Suppose Alice funds twice (F3 attack 4, or a read-only tick, or a manual retry), and the second funding is mined after Bob has locked. Bob's tool waited only while several instances fit *before* he locked (engine.rs:1484-1487). Alice reveals. Both instances have `claim_recipient = Bob` and the same authority `Addr(s)`. Bob claims both. Alice loses V. CONFIRMED that no check prevents the reveal; the double funding needs an operator slip.

**Other residuals.** Locks beyond `MAX_LOCKS_READ = 8` are counted but not read (eth.rs:112, 196-201), so a spammer with 9 junk locks makes the fitting-lock check depend on order. Dust sent to the contract root before Alice funds makes `fund_noid` refuse (engine.rs:1676-1679); that is a grief, not a loss. CONFIRMED.

**Tests.** `scenarios.rs:1824-1986` asserts the multi-instance and multi-lock waits (asserts). No test covers Alice revealing with two fitting instances.

**Fix.** In `A::LockFinal`, refuse to reveal when more than one fitting instance exists at the root, and tell Alice to refund the extra one at D or accept the loss knowingly.

## F11. (I3) window — CLOSED

`alice_check_lock` applies `check_i3` with the lock block's timestamp (engine.rs:881-906; params.rs:649-651). There is no upper bound on `T_reveal`; a long window costs only Bob (his ETH is locked longer). Test at `engine.rs:2493` asserts it.

## F12. `--now` with a live RPC — CLOSED

`--now` is refused when a live RPC is given (main.rs:276-280). `cli_live.rs:487` asserts it.

## F13. Unchecked arithmetic — CLOSED

`check()` uses `checked_add` (swapfile.rs:320), `Created` uses `checked_add` (engine.rs:1121-1123), and `compile_guarded` catches panics from the harness (swapfile.rs:941-958). `swapfile.rs:1322` asserts the overflow refusal. That every add on untrusted data is covered is PLAUSIBLE; I did not audit every line.

## F14. KDF settings — CLOSED

`--fast-kdf` exists only under `cfg(any(test, feature = "dev"))` (main.rs:657-666). `load` enforces KDF bounds (swapfile.rs:838-840); `derive` calls them (swapfile.rs:573). `swapfile.rs:1303` asserts it.

Residuals: the bounds are upper bounds only (swapfile.rs:555-570), so a file with a tiny KDF cost loads. And `Cargo.toml` has a dev-dependency on itself with `dev`, so a binary built by `cargo test` into `target/<profile>/swap-cli` has `--fast-kdf` (PLAUSIBLE; run 3 used the release binary, live-run-3.md:34). Both are Low.

## Re-check of R1-R8

| Id | REVIEW-3 | Note | Citation |
|---|---|---|---|
| R1 opening Bob rebuilt | Holds (REFUTED attack) | Same byte-for-byte rule | swapfile.rs:360-404, 828-848 |
| R2 fee cap | Holds | `check()` plus T5 by contract version | swapfile.rs:281-355; engine.rs:1502-1514 |
| R3 `refundable_payment` | Holds | Compiled from the pinned source | swapfile.rs:941-958 |
| R4 v2.1 straddle | Holds | (I5) still a constant boundary (L8) | params.rs:655-660 |
| R5 fail-closed | Holds, with one deliberate exception | An unknown header time passes (F5) | engine.rs:414, 489-586, 766-773 |
| R6 malformed RPC | Holds | No new decoding paths found | eth.rs:452-459; parano1d.rs:258-266 |
| R7 reveal before finality | Holds | Reveal needs `lock_matches` and finalized | engine.rs:576-583 |
| R8 Runner persistence | Holds | Pending saved with `maybe_sent` before execute; moved state clears it | engine.rs:1902-1904, 1948-1955, 1985-2022 |

## REVIEW-1 items: status at HEAD

| Item | Status | Where |
|---|---|---|
| C1 Bob's own terms | Applied; code hash now mandatory (pin source: F1) | swapfile.rs:360-404; main.rs:761 |
| C2 π | Applied in receipt mode; typed fallback remains (F2) | main.rs:848-882 |
| C3 lock of unknown outcome | Runner applied; tick ledger applied with the F3 bypasses | engine.rs:1704-1739, 1948-1955 |
| C4 double funding | Guarded in tick (`fund_noid` with any instance); manual `fund` unguarded; reveal ignores extra instances (F10) | engine.rs:1676-1679, 1150-1182 |
| H1 refund vs revealed secret | Applied | engine.rs:569-575 |
| H2 F_max bounds | Applied | swapfile.rs:320; engine.rs:1502-1514 |
| H3 code hash, chain id, EOAs, claim simulation | Applied, except claim simulation is still implicit (`ethers` gas estimate; not checked) | engine.rs:160-202; live.js:267-282 |
| H4 lock id wiring | Applied | engine.rs:1788-1812; main.rs:308 |
| M1 leftover leg | Applied (F9) | engine.rs:1184-1248, 1410-1451 |
| M2 fail-open, stale tip | Applied plus F5; unknown header time passes | engine.rs:760-799 |
| M3 foreign pending close | Applied | engine.rs:1354-1363 |
| M4 one lock-by | Applied | engine.rs:1523-1524 |
| M5 missing 6.3 checks | Partly: `D − H_now ≤ 2·D_offset` and `getSlotsByOwner(A)` empty still missing | swapfile.rs:281-355 |
| M6 file lock | Applied (F8) | swapfile.rs:907-931 |
| M7 client R snapshot | Not applied (separate anchor and slot-hint RPCs) | raw.rs:268-283 |
| M8 client S retry path | Not applied; client S not wired | main.rs (no caller) |
| L1 Bob's clock | Applied (`min` of clocks) | engine.rs:1523 |
| L2 file MAC | Not applied | swapfile.rs:828-848 |
| L3 KDF | Applied (F14) with upper bounds only | swapfile.rs:555-573 |
| L4 all instances | Applied (F10) | parano1d.rs:204-219 |
| L5 reverted claim scan | Not applied (mined claims skipped) | eth.rs:469-493 |
| L6 lock ids compared | Applied | engine.rs:576-583 |
| L7 `B_bob` origin | Not applied | engine.rs:1524 |
| L8 `check_i3`, version schedule | `check_i3` applied (F11); (I5) still one constant boundary | params.rs:649-660 |
| N1 conditional test | Not applied: the `if left <= GUARD` assertion is still there | engine.rs:2224-2231 |
| N2 unchecked add | Applied (F13) | swapfile.rs:320 |
| N3 zeroize | Partly (unchanged) | secret.rs; raw.rs |
| N4 eviction resets history | Not applied | state.rs:443-446, 546-553 |
| N5 "never twice" comment | Not applied (not re-read in detail; PLAUSIBLE) | engine.rs |

## New findings

### G1. `equiv-prove verify` accepts dev-mode receipts (Medium, CONFIRMED)

**Evidence.** `prove` refuses `RISC0_DEV_MODE` (equiv/zkvm/host/src/main.rs:198-201). `verify` does not (main.rs:238-247); it calls `receipt.verify(EQUIV_GUEST_ID)` (main.rs:180-187). The host depends on `risc0-zkvm` 3 with `default-features = false, features = ["client"]` and without the `disable-dev-mode` feature. swap-cli's `ProcessRunner` passes the full environment to the child (equiv.rs:184-190). `equiv/README.md:203` documents only the `prove` refusal. CONFIRMED end to end: the maintainer read the crate source (`risc0-zkvm-3.0.6` in the WSL cargo registry). `Receipt::verify` uses `VerifierContext::default()`, whose `dev_mode` field is `is_dev_mode_enabled_via_environment()` (receipt.rs:1029-1038); that function is true when `RISC0_DEV_MODE` is `1`, `true` or `yes` and the `disable-dev-mode` feature is off (lib.rs:204-218); and `FakeReceipt::verify_integrity_with_context` returns `Ok(())` whenever `ctx.dev_mode()` is true (receipt.rs:597-608). `equiv/zkvm/host/Cargo.toml` does not enable `disable-dev-mode`. A fake receipt is a claim with no seal, so Alice can make one for any image id and journal she likes.

**Attack.** Bob experimented with dev mode earlier and still has `RISC0_DEV_MODE=1` in his shell profile. A malicious Alice makes a fake receipt with the journal `variant ‖ H ‖ A′`, where A′ is not `Addr(s)`. `new-bob --receipt` reports OK. Bob locks ETH; Alice reveals s; Bob's claim against A′ is impossible. Bob loses his ETH.

**Fix.** Refuse `RISC0_DEV_MODE` in `verify` too. Build the host with `disable-dev-mode`. Use `env_clear()` in `ProcessRunner`. Reject a receipt whose inner kind is `Fake` explicitly.

### G2. The F10 lock rule gives Bob a free cancel option (Low, CONFIRMED)

**Evidence.** Alice does not reveal while another open lock fits the terms (engine.rs:1154-1170).

**Attack.** After Bob locks, the price moves against him. He sends a second, identical lock. Alice's tool stops revealing; both locks refund to Bob at `T_reveal`; Alice recovers her NOID at D. Bob paid only gas for an option that the HTLC design already gives him before locking, but now he holds it after locking too. No funds lost; it is a griefing and free-option issue.

**Fix.** Accept the recorded lock if it fits and is the first one mined; extra locks on the agreed terms only pay Alice more if she claims them too. Or reveal on the earliest one and let Bob refund the rest.

### G3. The second node can be the first node (Low-Medium, CONFIRMED)

**Evidence.** `chain_source` takes up to two URLs per chain and does not compare them (main.rs:220-258).

**Attack.** A user passes the same URL twice (or two URLs of one provider) to get past the production rule. F5's agreement check then compares a node with itself and always passes.

**Fix.** Refuse identical URLs and identical hosts; print both hosts in the notes so the operator sees what agreed.

### G4. `live.js claim` does not check the lock against the swap terms (Low, CONFIRMED)

**Evidence.** `claim` checks the contract target, finality and the cutoff (live.js:267-282, 518-559), but not the lock's receiver, amount or sender against anything the swap agreed (live.js:484-594).

**Attack.** A stranger Bob sends Alice "the lock id" of a lock whose receiver is not Alice, on the same hashlock. Alice runs `live.js claim` with it. The contract pays the lock's receiver (HTLC.sol:155-161), and s is now public. Bob claims the NOID. Alice's tool path (tick prints the right lock id) prevents this; a manual run does not. PLAUSIBLE as a social attack.

**Fix.** `live.js claim --swap FILE` re-checks receiver, amount, sender and `T_reveal` from the file.

## Must fix before a real counterparty

1. **F3.** Read-only tick prints no spending parameters. `intent --cancel` refuses while a tx may be pending. `live.js lock/claim/refund` read the swap file and intent and re-check (I1), `M_A`, amount and receiver. Add a guard or wrapper for Alice's `fund`.
2. **F10 (Alice).** Refuse the reveal when more than one fitting instance sits at the root.
3. **F1.** Compile in the HTLC code hash from the repo artifact; stop suggesting the deploy output.
4. **F2 + G1.** No typed attestation outside rehearsal; image id compiled into swap-cli; `verify` refuses dev mode; host built with `disable-dev-mode`; `env_clear` in the runner.
5. **F5 + G3.** Fail closed on an unknown header time; refuse identical second endpoints; require two nodes under `sepolia` for a stranger; cross-check before Bob waits on a foreign pending close.
6. **F7.** Take the preimage from `getLock`; set a sane `--eth-from-block` default.
7. **G4, F4 (`env_clear`), G2.**

## Not checked

- I ran nothing. Test counts (318 swap-cli, 35 harness) come from the docs and the commit message, not from a run. Where I say a test "asserts", I read its assertions; I did not see it pass.
- RISC Zero 3's exact behaviour for fake receipts was not checked by the reviewer; the maintainer settled it afterwards from the crate source (G1, now CONFIRMED).
- Whether `paranoid_getTx` still finds a tx after its block body is pruned (F6 residual).
- Whether `File::try_lock` is effective on drvfs (F8).
- Whether `ethers` v6 always simulates via `estimateGas` before sending (H3).
- `client/stock.rs`, the harness internals, `btc/`, and `parano1d-cli` behaviour.
- Every arithmetic site for F13; every place an old (pre-F1) swap file could still load without a code hash.
- Any live behaviour of the F5 code: it has not been exercised on a real network (live-run-3.md:188).

## Maintainer verification (2026-11-05)

Done by the session that commissioned this review, after the reviewer finished. The reviewer's text above was changed in two places only (the F1 residual and G1's evidence level), both marked.

- **The suite at `be9e3fa` was run once** in WSL (`cargo test --offline`, cached build, 27 s): 318 passed, 0 failed, 1 ignored (the benchmark). Every test the review says "asserts" therefore also passed at this commit.
- **Re-read in the source and confirmed:** F3 (engine.rs:1704 records only with `record`; `cancel_intent` refuses only a `Resolved` effect, engine.rs:1723-1739; `tests/intents.rs:95-110` asserts the read-only behaviour; `live.js lock` scans mined logs and the state of one lock id only, live.js:415-432; `expected_lock_id` follows the pending intent, engine.rs:1788-1812). F10 (no instance check in `A::LockFinal`, engine.rs:1150-1182; Bob's wait is only before his lock, engine.rs:1484-1487). F5 (`tip_time` `None` is a note, engine.rs:769-773; the watcher turns every header error into `None`, parano1d.rs:258-266; the one-node policy, engine.rs:640-647). G3 (`chain_source` never compares the two URLs, main.rs:220-258). F12 (main.rs:276-280). F1 (both pins required, main.rs:696-698 and 759-761; `CODE_HASH_WHY` names the deploy output, main.rs:642; `lock_matches` and `spend_blocker` strict, engine.rs:163-173, 556-567). F2 (typed path whenever `--receipt` is absent, main.rs:848-860; image id from `--pinned-image-id`, main.rs:838). F4 (no `env_clear`, exec.rs:102, equiv.rs:184). F7 (the preimage comes from the `Claimed` log and `getLock` only confirms it, eth.rs:438-447; `--eth-from-block` defaults to 0, main.rs:315-318). F8 (read-only tick takes no lock, main.rs:398; `claim --submit` holds it, main.rs:496; `SwapLock::acquire`, swapfile.rs:907-931). F11 (engine.rs:881-906). F13 (swapfile.rs:320). F14 (main.rs:657-666; swapfile.rs:555-573; the crate's self-dependency with the `dev` feature in `Cargo.toml`). F9 and F6 paths (engine.rs:1184-1248, 1315-1335, 1410-1451). G2 (engine.rs:1154-1170). G4 (`live.js claim` checks hashlock, state, cutoff, finality and log/record consistency, never receiver or amount, live.js:502-559). G1 (crate source, cited in its section).
- **Not re-derived:** the test line numbers quoted for each "asserts", the REVIEW-1 table, and the attack timings the reviewer marked PLAUSIBLE.

## Fix status (2026-11-05)

Added by the maintainer after the fixes landed. Each item was implemented from this review's text, then
verified by the maintainer's own `cargo test` run in WSL before its commit (totals below are the whole swap-cli suite at that
commit; 1 ignored benchmark throughout). None of it has been exercised on a live network yet; the three read-only checks named
below ran against the real nodes with the rebuilt release binary.

| Finding | What the fix does | Commit | Tests after |
|---|---|---|---|
| F3 | A `tick` without `--apply` prints a ledger spend as kind only (`parameters: "withheld"`); `intent --cancel` is refused under 600 s of age, while the signer's pending nonce exceeds its latest nonce or either is unknown (`eth_getTransactionCount` latest/pending, new observation fields), while a call sits on the instance (`refund_noid`), or when the effect is on chain; the `reveal_eth` intent freezes `t_reveal` and `cutoff = T_reveal − M_A`; `live.js lock/claim/refund --swap FILE` fill and check every term and the intent from the file (claim: receiver, sender, amount, hashlock, the earlier of the two cutoffs; lock: the key must be `bob_sender`); without `--swap` one warning line | 9406003 | 325 (+127 hardhat) |
| G1 | `equiv-prove verify` and `prove` refuse `RISC0_DEV_MODE` (any value) before reading anything; `check_receipt` rejects a fake receipt by kind before `Receipt::verify`; the host is built with risc0's `disable-dev-mode`; image id unchanged | f5d1f00 | 22 host tests on the real receipts |
| F10 (Alice), G2 | No reveal while more than one instance with the agreed amount sits at the root (no override; `refund_noid` at D, the other slots named for a wallet refund); an extra open lock on the agreed terms no longer stops the reveal (it only pays Alice more) | 625be6a | 329 |
| F1 | `params::HTLC_CODE_HASH` (keccak256 of the artifact's `deployedBytecode`, the value both live deployments reported) is the only accepted pin: `--eth-code-hash` optional and refused unless equal; `check()` refuses a bundle or file pinning another contract on build, `new-bob` and `load`; `live.js` takes the hash from the local artifact, a given `--code-hash` or a swap file with another hash is refused; a unit test compares the constant with the artifact when compiled | f6356ac | 331 (+130 hardhat) |
| F2, F4 | `params::EQUIV_IMAGE_ID` (the local build's id until M1.1) is the only accepted pin, `--pinned-image-id` optional; the typed attestation is accepted under `rehearsal` only, refused up front and at `load` elsewhere; children (`curl`, `equiv-prove`) get a cleared environment plus a 20-name allow-list (`child_env.rs`), so `SWAP_PASSPHRASE` and `RISC0_DEV_MODE` never reach them. Read-only check: a `curl`-transport tick from WSL against both live nodes still works | f2b837b | 338 |
| F5, G3 | An unknown tip header time blocks every NOID-side spend; `sepolia` follows the production two-node rule (`--single-node-ok` to accept one); the second endpoint must differ (same scheme, host and port refused; a second port on one host passes with a note; the same fixture twice refused); Bob does not wait on a pending close that a fresh, level second node does not see | 723b5f9 | 344 |
| F7 | The secret is also read from the `getLock` record when the `Claimed` log is missing (after `sha256(preimage) == hashlock`; claim synthesized at `block = latest`, flagged `claim_state_from_record`); real contradictions still fail; `--eth-from-block` is given once and stored in the swap file (`tick --apply`, `claim --submit`), refused when neither exists on a live non-local chain; `live.js --swap` takes it from the file. Read-only check on the run-3 Bob file: refused without the flag on Sepolia, works with it | a9a7ee7 | 349 (+131 hardhat) |
| G4 | Covered by F3's `--swap FILE` (claim checks receiver, sender, amount and hashlock against the file) | 9406003 | — |

Still open from "Not checked": F5's two-node path and F7's record-sourced secret on a live network; `File::try_lock` on drvfs: checked 2026-11-05, `flock` excludes on this WSL's 9p
drvfs mount exactly as on ext4 (two holders, the second refused with EAGAIN; `mount` shows `9p … cache=0x5`), so a swap file under
`/mnt/c` is protected between WSL processes; a Windows-native `swap-cli.exe` and a WSL one on the same file remain untested; the
exec-transport flake (`Text file busy`, once on 2026-11-05): fixed the same day, `watch/exec.rs` retries the spawn on `ETXTBSY` up to ten times (commit 3c5bd09); M1.1 (the reproducible
image id, after which `EQUIV_IMAGE_ID` changes and older Bob files stop loading on purpose).
