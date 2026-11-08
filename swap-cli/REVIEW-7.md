# swap-cli review 7 (independent, adversarial, read-only)

Reviewed 2026-11-05 (UTC) against `HEAD` = `f738076` (documentation only on top of `c85ebd7`, so every source line is the one of
`c85ebd7`). Scope: the fixes for REVIEW-6, `git diff c95d63c..c85ebd7 -- swap-cli/src eth/scripts/live.js scripts/live`. Read as evidence
of intent: `swap-cli/tests/poseidon_kind.rs`, `cli_live.rs`, `poseidon_cli.rs`, `eth/test/live.test.js`, `eth/test/live-poseidon.test.js`.

Nothing was run: no cargo, no Hardhat, no node, no helper script, no network. One library fact was read from the installed package
(`eth/node_modules/ethers`, 6.17.0, `lib.commonjs/providers/provider.js:1054-1160`). Evidence words as before: **CONFIRMED** (read in the
code, a concrete sequence exists), **PLAUSIBLE** (needs chain, node or operator behaviour I could not check), **REFUTED** (the attack does
not work, with the reason). Status words for the REVIEW-6 items: **CLOSED**, **PARTIAL**, **OPEN**.

Plain words for the one idea this review leans on: a hashlock is a lock that opens for whoever shows the secret; "the secret is public"
means anyone who watches the chain or the mempool can now open every lock keyed on it. The tools treat "the secret may be public" as a
switch that relaxes some of Alice's rules (a late re-send of her reveal is allowed), so the question for R6-3 is whether a liar can flip
that switch.

## Verdict

1. **Owner in both roles, Sepolia: yes. Owner, trial amounts on mainnet: nothing in this diff blocks it** (the project's own rules for
   mainnet still apply: owner's go-ahead per run, tiny amounts until M4). No finding below moves value to anyone.
2. **Fix first (both Low, both small):** R7-1 (the remaining full `Locked` scan is a veto anyone can hold without knowing `A`; an indexed
   `sender` query answers the only question left) and R7-2 (a failed `self-test` leaves the earlier passing record in force).
3. **Before a stranger:** R7-1, R7-2, the build binding of R6-4 made real (`SWAP_CLI_BUILD_ID` set by the build the run uses), a second
   Ethereum node that Bob's lock decision actually requires (R7-4), plus the REVIEW-5 items as they stand. Production and mainnet beyond
   trial size also need M4, the second independent Yul review and Q8, unchanged.

## REVIEW-6 items

### R6-1 The full `Locked` scan could stop Bob's tool after the reveal: **CLOSED**

**What changed.**
- Both kinds now discover the swap's own locks with the indexed `sender` and `receiver` topics (`discover_lock_ids`, eth.rs:388-432,
  called at eth.rs:243-246). The topics are compared again locally (eth.rs:410-417), so a provider that ignores the topic filter cannot
  slip a foreign log in.
- The full scan (`discover_poseidon`, eth.rs:440-494) runs only when the caller sets `word_scan` (eth.rs:317-336). Its error, a cap-size
  result and the "targeted lock missing from the scan" cross-check all become `WordScan::Failed`, never a poll error.
- `word_scan_wanted` (engine.rs:2326-2330) is true only for Bob, poseidon kind, phases `Received`, `Funded`, `FundingFinal` and
  `LockSubmitted`. It is set on both watchers (main.rs:422, 428, 440).

**Attacks tried.**

| Attack | Result | Why |
|---|---|---|
| After Bob's lock, Alice pads the contract to an exact cap count and reveals | **REFUTED** | From `Locked` on, `word_scan_wanted` is false; the poll asks only the indexed queries and `read_logs(lockId)` (eth.rs:504-557). None of those return logs Alice can create: `sender` is `msg.sender`, and topic1 of `Claimed`/`Refunded` is Bob's lock id. Test `after_bobs_lock_a_failed_scan_changes_nothing_in_the_claim_path` states the same intent |
| Bob is still in `LockSubmitted` when the lock mines and Alice reveals at once | **REFUTED** | The scan runs in that poll, but its failure is a state; the engine still moves to `Locked` and reads the `Claimed` event. Only a re-send reads the scan (engine.rs:2510-2515) |
| A lock by Bob that the targeted query misses (address casing) | **REFUTED** | Topics are built from bytes (`pad32`, eth.rs:803-807) and compared as bytes; JSON-RPC hex is case-insensitive |
| A lock by Bob from another address | **Not a tool fault** | It is not `bob_sender`, so neither the indexed query nor the own-sender rule sees it, and Bob can lock again. That is a second key outside the swap file; `live.js lock --swap` refuses a key other than `bob_sender` (live.js:1025-1027) |
| A re-send after a node lags and hides Bob's own landed lock | **REFUTED** as a double payment | The re-send uses the SAME `T_reveal`, so the same lock id, and the contract refuses a duplicate (engine.rs:2491-2525); `live.js lock` also checks `getLock` of the id (live.js:1049-1051) |
| Bypass a `Failed` or `NotRun` scan and lock on a guess | **REFUTED** | `poseidon_prelock_blocker` (engine.rs:2271-2320) returns a wait for `NotRun` and `Failed` on every node present. Every `LockEth` comes from the two gated sites (engine.rs:2476, 2512); `reuse_pending` (engine.rs:3272-3291) only rewrites an action that already passed. A library caller that never sets `word_scan` gets `NotRun` and waits (fail-closed). `live.js lock` runs its own chunked scan and refuses on a cap count and on an own lock (live.js:1036-1048) |
| A provider that drops topic filters | **PLAUSIBLE, provider fault only** | The local re-check keeps the answers correct; a non-conforming provider that also truncates silently can make `read_logs` miss the `Locked` log, and then `require_no_record` fails the poll (eth.rs:288-289, 372-384). Alice can inflate the total log count, but only against such a provider. Info |

What is left of the scan is R7-1 (before the lock only) and R6-6 (unchanged, harmless now).

### R6-2 A 1-wei lock on `A` vetoed the swap: **CLOSED**

`poseidon_prelock_blocker` now blocks only on a `Locked` log with this word whose `sender == bob_sender` and whose id is not the
expected one, any receiver (engine.rs:2297-2319). Foreign locks become a note. `live.js lock` does the same (live.js:1036-1062).

**Can a foreign lock on the same word hurt anyone?** I find no way.
- **Lock ids cannot collide.** `lockId = keccak256(sender, receiver, amount, word, timelock)` (eth.rs:48-64), so a foreign lock never
  shares Bob's id. Alice's tool claims the pinned id only (`live.js claim --swap`, `checkLockAgainstSwap`, live.js:1188-1197).
- **Alice claims only a foreign lock (her own decoy, from another address) and leaves Bob's untouched.** The secret is then public in
  the decoy's `Claimed` event.
  - Bob's file watches only his own lock id (`preimage_candidates`, engine.rs:212-235), so it believes nothing happened.
  - At `T_reveal` Bob refunds his ETH (engine.rs:2535-2536). Alice takes the NOID back at `D`.
  - Both end whole; Alice paid for the decoy. Bob only misses an extra NOID claim he could have made (R7-8, Info).
- **Alice claims the decoy early and Bob's lock late.** Bob's NOID window is sized from `T_reveal`, not from the first publication, so
  he loses nothing.
  - An early public secret lets anyone close the NOID lock to Bob, burning at most `max_fee`. A minimum-fee close can stall Bob (Q1).
  - Both risks already exist with Alice holding the secret; neither is new.
- **Before Bob locks, someone closes the NOID lock to Bob.** Bob receives NOID for free. His lock gate requires the funded instance,
  so he does not lock.
- **What each file believes.**
  - Alice's file, if her claim went through the tool: the truth.
  - Bob's file: "unclaimed" until `T_reveal`, then `refunded`.
  - Neither file is wrong about Bob's own lock.

### R6-3 A mined, reverted claim was invisible: **CLOSED**

**live.js.**
- `execute` turns a status-0 receipt into `RevertedTx`. This covers both ethers' `CALL_EXCEPTION` carrying the receipt and a returned
  status-0 receipt (live.js:141-147, 679-687).
- `claimChecked` returns `reverted: true, secretPublic: true` with the hash (live.js:1341-1364), and `main` exits 3 (live.js:1584-1588).
- An ethers `TRANSACTION_REPLACED` whose repriced replacement reverted is not mapped (provider.js:1119-1132). That case appears only in
  the process that sent the first claim. The `--replace` process waits on its own hash and maps it. Info.

**swap-cli verification** (`read_reveal_tx`, eth.rs:732-785). The node must return, for that exact hash:
- `to` = the pinned contract;
- `from` = the lock's receiver, which equals the discovery rule's receiver;
- calldata at least 68 bytes, the `claim` selector, the pinned lock id;
- a preimage that opens the lock word for this kind;
- a block number;
- a receipt with the same hash and block, status 0.

Every failure is a note, never an error (eth.rs:303-316).

**A lying node and Alice's FIRST reveal: REFUTED.** To be accepted, the fabricated transaction must carry `x` with `lock_word(x) = word`,
which needs the secret.
- Before publication, the only node that knows the secret is one Alice sent her signed claim to. For that node the secret is already out.
- `note_reverted_reveal` (engine.rs:1149-1161) accepts the evidence from either node. Recording `reveal_reverted_seen` then relaxes three
  rules: the `M_A` cutoff to `T_reveal - DE` (engine.rs:1198-1205, 1645-1655, live.js:1246-1260), the F-13 visibility rule (engine.rs:1662)
  and the two-instance rule (engine.rs:1674).
- That relaxation is the right answer when a node holds the secret: it can hand it to Bob.
- Residual: no block hash or finality check, and one node suffices (R7-5, Info).

**Bob gets a wrong preimage: REFUTED (confirmed).** The reverted claim joins the candidates (engine.rs:223) and passes the same
`check_preimage_for` against `H` and `A` as every other source (engine.rs:1982-2002). A wrong one is a note and never hides a right one
from the other node.

**Marker names.** `REVEAL_REVERTED_SEEN = "reveal_reverted_seen"` (engine.rs:1146) is in `secret_may_be_public` (engine.rs:1139-1141) and in
live.js `SECRET_PUBLIC_EVENTS` (live.js:127). Both match. The JS test repeats the list (live.test.js:2121, 2402-2405); no test compares
the two sources mechanically (Info, unchanged pattern).

**Helper scripts.**
- `reveal.sh` writes the hash only when `reverted is True` and `txHash` is a string (reveal.sh:43-54).
- `reveal_tx_flags` (env.sh:76-79) filters to `[0-9a-fA-Fx]` and passes the result as one array element. Nothing is evaluated, so
  **there is no injection**.
- A stale file can come from an earlier swap in the same `$L` (one directory per `RUN`). It names another lock id and swap-cli ignores
  it with a note.
- A corrupt file that still fits the shell pattern stops every `tick.sh` and `claim.sh` (R7-6, Info).
- `watch.sh` goes through `tick.sh`, so it passes the flag.

### R6-4 The self-test record was unbound: **PARTIAL**

**Bound now.**
- The record carries the lock word, the contract version and `build_id()` (swapfile.rs:887-895).
- `record_client_r_selftest` refuses another word or version (swapfile.rs:1089-1092).
- At the lock decision, `selftest_blocker` (engine.rs:2338-2372) requires the auth version of `tip + 1`, the word, the version, the same
  build string, `passed_at <= now + 300` and an age of at most 86,400 s.
- The throwaway is compiled for the swap's version with its `max_fee`, its version is detected, and it goes through `submit_claim`
  against a verifying mock (raw.rs:212-262).

**Replay.**
- **Between files of different swaps: REFUTED** (lock word).
- **Between machines:** not prevented. The record lives in the file, and the build string is `swap-cli <crate version>` unless
  `SWAP_CLI_BUILD_ID` was set at compile time (lib.rs:39-44). No helper sets it (no match in `scripts/`), so two builds from different
  commits with one crate version accept each other's records.
- The swap file is the operator's own, so this is a weak gate, not an attack. Low, as before.

**A failed self-test leaves a passing record: CONFIRMED, R7-2.**

### R6-5 The from-block advice: **CLOSED**

The messages now say: keep the from-block at or before the deployment block (eth.rs:454, live.js:929-930).

### R6-6 `latest` race between queries: **OPEN (Info)**

Each query still reads `latest`. The only effect left is a `WordScan::Failed` for one pre-lock poll (eth.rs:324-328).

### R6-7 Documentation drift: **PARTIAL (Info)**

- The `overlong_claim` comment is fixed (watch/mod.rs:642-645).
- `swap-cli secret` no longer advises `equiv-prove` for poseidon (main.rs:1162-1168).
- `prepare.sh` is unchanged.

### R6-8 The sha256 claim simulated with the secret: **CLOSED**

**Sent with a fixed limit, never estimated.** The sha256 claim now uses `SHA256_CLAIM_GAS_LIMIT = 200_000` (live.js:114, 1220-1223), the
same path as poseidon.
- `execute` returns the fixed limit from `estimate()` for the first send, `--replace` and `--mainnet` (live.js:629-650).
- The secret-carrying dry run is refused against a non-loopback node for both kinds (live.js:1143-1148).
- I find no request other than `eth_sendRawTransaction` that carries the secret. `getLock`, the gas views, fee data, nonce, balance and
  pool reads carry no secret; `explain` and `redact` are local.
- The Hardhat request-log tests for sha256 (live.test.js, the "no eth_estimateGas, no eth_call with the secret" cases) state the same
  intent.

**Is 200,000 enough?**
- `eth/FUZZ.md:280` gives a maximum of 120,993 gas for an EOA receiver; an accepting contract measured 98,269.
- A receiver account that does not exist yet would add 25,000 (new account). That cannot happen here: the receiver is the signer and
  holds the gas money.
- 200,000 leaves about 79,000. A future repricing of state access would eat into that (R7-7, Info).

**Contract receivers.** The tool requires EOAs at engine.rs:195-200 (`lock_matches`, T11). The code is read on every poll
(`is_eoa`, eth.rs:272-273, 681-685), and a lock that fails it is never revealed on.
- An EIP-7702 delegated account has non-empty code, so it is refused too.
- `live.js claim` itself has no receiver code check. A delegation set between the last tick and the send would make the claim revert
  `TransferFailed` with the secret out. The removed estimate used to catch that before publication (R7-7).

## New findings

### R7-1 (Low, liveness) The remaining full scan is a veto anyone can hold, and it answers a question an indexed query answers

**Why the scan is no longer needed.** After R6-2, the full scan answers one question: does `bob_sender` already have a lock on this word,
to any receiver. `sender` is an indexed topic of `Locked`, so that question can be put to the node directly.

**Why it is harmful.** It still reads EVERY `Locked` log of the shared contract from the deployment block in one call.
- It fails on a result of exactly 1,000, 5,000, 10,000 or 20,000 logs (eth.rs:440-458). `live.js lock` applies the same rule per
  50,000-block chunk (live.js:924-935).
- Anyone can therefore hold every poseidon Bob on that contract before his lock. It costs about 144 k gas per padding lock, and the
  attacker does not need to know `A`.
- The method: keep the contract's total `Locked` count from its deployment block at a cap value. Bob waits (engine.rs:2282-2294) and
  aborts at his last lock height.
- Bob's only counter is to add a lock of his own, which the attacker answers with one more.
- A busy shared contract also passes through 1,000 by itself.

**Status.** CONFIRMED in code. Cost about 0.14 ETH per 1,000 locks at 1 gwei on L1, nothing on Sepolia. Liveness only; nobody loses
funds.

**Fix.**
- Replace the full scan with `topics: [Locked, null, pad32(bob_sender)]`, chunked like `live.js`, and compare the word locally.
- The result is bounded by Bob's own activity, so the exact-cap heuristic can go.
- Keep the cross-check "the scan contains the lock the targeted query found".
- Do the same in `live.js lock`.
- Foreign locks are no longer needed for anything but a note, so dropping them loses nothing.

### R7-2 (Low) A failed self-test leaves the earlier passing record in force

`self_test` returns on a failed `client_r_selftest` before anything is written (main.rs:1196). A record from a pass earlier the same day
therefore stays in the file, and `selftest_blocker` accepts it for up to 24 h (engine.rs:2333, 2367-2370).

**The case.** Bob re-runs the self-test, for example after a system update, and it now fails. The tool still lets him lock, on a client he
has just seen fail. Only client R can claim the NOID with this lock kind, so that is the one thing the gate exists to prevent.

**Status.** CONFIRMED.

**Fix.** Clear `client_r_selftest` and log `client_r_selftest_failed` before proving, or on failure, and save.

### R7-3 (Info) The build binding is a version string

lib.rs:39-44 and the README note. Set `SWAP_CLI_BUILD_ID` (commit plus a dirty flag) in the build the helpers use, or hash the running
binary.

### R7-4 (Info) Bob's pre-lock scan can run on one Ethereum node

**Code.**
- A second Ethereum node whose whole poll fails is dropped: `eth.second = None`, `second_error` set (main.rs:444-445).
- `poseidon_prelock_blocker` then checks the scan only on the primary (engine.rs:2280-2281).
- For `LockEth`, the second-node policy reads only the NOID second node (engine.rs:954).

**Effect.** A lying or lagging primary can hide an earlier lock of Bob's own sender to another receiver. That is the only thing the scan
still guards, and live.js's own scan and the duplicate-id rule stand behind it.

**Fix.** Treat `eth.second_error` as a wait at the poseidon lock decision, as `abort_eth_blocker` already does (engine.rs:2871-2873).

### R7-5 (Info) `--reveal-tx` evidence: one node, no canonical-block check

Either node's verified reverted claim records the marker (engine.rs:1158). The receipt's block is not checked against the canonical chain
or finality. As argued under R6-3, a fabricating node must hold the secret, so the outcome is right. The rule is weaker than the two-node
rules elsewhere; say so in the README, or require the primary.

### R7-6 (Info) A malformed hash file stops every tick and claim

**Code.** `reveal_tx_flags` accepts `0x` followed by any 64 characters of `[0-9a-fA-Fx]` (env.sh:77-78). An `x` among them passes the shell,
and `parse_hex32` then fails `observe_tracking` before any poll (main.rs:415-419). That stops `tick.sh` and `claim.sh`, including Bob's
NOID claim in the owner's two-role setup.

**Who can trigger it.** Only the owner writes the file.

**Fix.**
- Match `0x[0-9a-fA-F]{64}` exactly.
- Make a malformed `--reveal-tx` a note, not an error.

**Related.** A run directory installed before this commit has a frozen `env.sh` without `reveal_tx_flags` (install.sh:2-9). Re-run
`install.sh`.

### R7-7 (Info) The fixed sha256 limit and the lost pre-flight

**The limit.** 200,000 against a measured 120,993. Re-measure at each fork that reprices state access or calls, or read the fork and
choose the limit from it.

**The lost pre-flight.** Without the estimate, a claim that would revert is found out only on chain, after the secret is public:
- `TransferFailed`, for a receiver that gained code after the last tick;
- a timelock that passes between the check and inclusion.

**Fix.** Re-check `getCode(receiver)` in `live.js claim` just before signing.

### R7-8 (Info) Bob sees a reverted claim only when told its hash

A stranger Bob has no channel for Alice's hash. A secret published on a foreign lock is not watched either. In both cases Bob loses
nothing: he refunds the ETH at `T_reveal`, and the NOID returns to Alice at `D`. He only misses a claim he was entitled to. A later
improvement: scan `claim` calls to the pinned contract for the lock id in recent blocks.

## Summary

| Id | Item | Status / severity |
|---|---|---|
| R6-1 | Full scan blocks Bob after the reveal | CLOSED |
| R6-2 | 1-wei veto on `A` | CLOSED; foreign locks harm nobody |
| R6-3 | Mined reverted claim unseen | CLOSED; lying node REFUTED (needs the secret); Bob's preimage check confirmed |
| R6-4 | Self-test record unbound | PARTIAL: word, version, age bound; build only by crate version; R7-2 |
| R6-5 | From-block advice | CLOSED |
| R6-6 | `latest` race | OPEN, Info (harmless now) |
| R6-7 | Documentation drift | PARTIAL, Info |
| R6-8 | sha256 claim estimated with the secret | CLOSED; 200,000 clears 120,993; EOA gate in the engine |
| R7-1 | Full scan: veto without knowing `A`; replace with an indexed `sender` query | Low (liveness) |
| R7-2 | Failed self-test keeps the earlier pass valid | Low |
| R7-3 | Build binding is the crate version | Info |
| R7-4 | Pre-lock scan on one ETH node when the second fails | Info |
| R7-5 | `--reveal-tx`: one node, no canonical check | Info |
| R7-6 | Malformed hash file stops tick and claim; frozen helpers | Info |
| R7-7 | Fixed sha256 limit margin; no pre-flight for a receiver that gains code | Info |
| R7-8 | Bob needs the hash; foreign-lock reveal unwatched | Info |

Severity counts (new): Low 2, Info 6.

## Not checked

- Anything live: no cargo, Hardhat, node or network. The commit's counts (459 Rust tests; the Hardhat run was pending) were not
  reproduced, and the new tests were read for intent only.
- Real provider behaviour: whether `eth_getLogs` caps error or truncate silently, range limits on one-call queries from the deployment
  block (also a pre-existing limit of `discover_lock_ids` and `read_logs`), and whether providers honour topic filters.
- Gas under any fork other than the one the fuzz run used. EIP-7702 delegation behaviour on Sepolia and mainnet.
- The chaos simulator and the scenario world for the new states (`WordScan`, `reverted_claim`).
- The `Runner` library path beyond the fact that it never sets `word_scan`.
- `client/raw.rs` beyond the self-test, and `submit_claim` against a real node.
- `HTLC.sol`, `HTLCPoseidonV2.sol`, Q8, `ui/app`, `btc/`, `equiv/`.
