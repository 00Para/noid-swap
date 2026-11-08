# swap-cli review 6 (independent, adversarial, read-only)

Reviewed 2026-11-05 (UTC) against `HEAD` = `ef3145f`. Scope: the change that adds the `poseidon` Ethereum lock kind,
`git diff 7c1835d..ef3145f -- swap-cli/src eth/scripts/live.js scripts/live parano1d/harness`. Read as evidence of intent:
`swap-cli/tests/poseidon_kind.rs`, `swap-cli/tests/poseidon_cli.rs`, `eth/test/live-poseidon.test.js`,
`parano1d/harness/tests/edge_secrets.rs`. Background: `docs/poseidon-leg.md`, `docs/poseidon-v2-review.md`. Every `file:line` is from `ef3145f`.

Nothing was run: no cargo, no Hardhat, no node, no network. One library fact was read from the installed package
(`eth/node_modules/ethers`, version 6.17.0). Evidence words as in REVIEW-5: **CONFIRMED** (read in the code, a concrete sequence exists),
**PLAUSIBLE** (follows from the code but needs a chain, node or operator behaviour I could not check), **REFUTED** (the attack does not
work, with the reason).

Plain words for the one new idea: with `poseidon`, the Ethereum lock opens for any 32 bytes `x` with `Addr(x) = A`, and `A` is also the
claim authority of the NOID lock. Both locks then open for the same secrets, so the zero-knowledge proof that "the SHA-256 lock and the
NOID lock share one secret" has nothing left to prove. What replaces it is a 32-byte comparison Bob makes himself.

## Verdict

1. **Sepolia with the owner in both roles: yes.** No finding moves value to anyone in that setting. Use an Ethereum endpoint without a
   log-result cap for the full `Locked` scan (or a fresh `HTLCPoseidonV2` deployment), and give Alice's address 1,000,000 x the fee cap.
2. **Before real funds at trial amounts:** nothing blocks owner-only use. Fix R6-1 before any counterparty is involved; it is small.
3. **Before a stranger:** R6-1, R6-2, R6-3 and R6-4, plus the REVIEW-5 items as they stand. Production and mainnet also need M4; the
   second independent Yul review and Q8 are unchanged. M1.1 (reproducible image id) does not apply to this kind.

## Answers to the six questions

### 1. Kind confusion

The two contracts share selectors and event topics (`docs/poseidon-leg.md` section 3). Only the pinned code hash and address tell them
apart. Every path ties the kind to that pin.

| Attack | Result | Why |
|---|---|---|
| Alice gets Bob to lock on `HTLC.sol` (sha256) with a word that is not `sha256(s)` | **REFUTED** | A sha256 Bob file needs an equivalence attestation for `(variant, H, A)` (swapfile.rs:1027, `new_bob_with` 949-951). The receipt proves `sha256(s) = H`, so `H = A` would need `sha256(s) = Addr(s)`. Bob names the kind himself (`--eth-lock-kind`, main.rs:914), and a bundle of another kind is refused (main.rs:931-936, swapfile.rs:433-438) |
| The reverse: a poseidon lock on a word that is not `Addr(s)` | **REFUTED** | `check` requires `hashlock == claim_authority bytes == opening.claim_authority` (swapfile.rs:312-325) and rebuilds the opening byte for byte. `check_bob_terms` repeats the opening comparison (swapfile.rs:439-450) |
| A poseidon file accepts a receipt-less swap on the sha256 contract | **REFUTED** | The kind's code hash is enforced in `check` (`code_hash_for`, params.rs), in Bob's terms (swapfile.rs:462-465) and on every poll before any spend. The contract at the pinned address has one code. `live.js` compares the file's pin with the artifact of the file's kind (live.js:745-749) and the chain's code with it (live.js:830-835). A flag that names another kind is refused (live.js:731-733) |
| `live.js` without `--swap` uses the wrong kind | **REFUTED** | `kindOf` defaults to sha256 (live.js:128). `verifyTarget` then pins the sha256 artifact's hash, so a poseidon contract fails at the code-hash check before anything is sent. The poseidon kind against `HTLC.sol` fails the same way |
| Kind inside the digested, sealed public section | **CONFIRMED (Alice)**. **Not applicable (Bob)** | Alice: `lock_kind` is part of `SwapPublic` serialization (written only for `poseidon`), the digest is `sha256(serde_json(SwapPublic))` (swapfile.rs:481-484), and the secret is sealed to it. Bob's file has no digest and never did. `load` re-validates kind, pin, word and attestation presence together (swapfile.rs:1021-1039), so a flipped kind fails closed |
| Files written before this change | **REFUTED** (no change in meaning) | No `lock_kind` field means sha256. The default is not serialized, so the digest and the sealed secret are unchanged. No `client_r_selftest`, and new `EthObservation` fields default to empty. A poseidon file read by an older build or an older `live.js` is refused: the V2 pin is not `HTLC_CODE_HASH`, and Bob's file has no attestation. Fails closed |

### 2. The removed proof

**What replaces it:**
- **Three equal 32-byte values:** the bundle's lock word, the `claim_authority` bech32 payload, and the `claim_authority` inside the opening.
  Bob checks this in `check` and in `check_bob_terms`, after rebuilding the opening byte for byte.
- **The V2 code-hash pin.**
- **Evidence that the EVM's `Addr` equals the node's for every input:** 12,299 vendor vectors and the V2 review.
- **The prover's edge-secret test** (`edge_secrets.rs`): all-zero, all-ones, and zero first S-box input, under V3 and V4.
- **Bob's client R self-test** (R6-4).

**A bundle with a lock word other than the opening's claim authority passes `new-bob`: REFUTED.** swapfile.rs:317-325 and 439-450. The
words are compared as raw bytes; the byte order is `Address.0`, which is the one the vendor vectors use.

**A stock authority `Addr(Derive(m,0))` presented as raw: REFUTED as an attack.**
- Declared stock is refused: swapfile.rs:274, 313-316, 447-449, main.rs:839-841.
- Declared raw, it is the raw variant with `s = d = Derive(m,0)`. `HTLCPoseidonV2` opens only for `d`, because it checks `Addr(preimage)`.
  It never opens for `m`.
- Bob claims with client R and `d`. Any `x` that opens one lock opens the other.
- The risk falls on Alice alone: `d` is a spend secret of a real wallet address.

### 3. The secret's exposure

**`live.js`, poseidon kind: REFUTED.** No request other than `eth_sendRawTransaction` carries `s`.
- `execute` short-circuits every estimate when `fixedGas` is set (live.js:604-616). This covers the first send, `--replace` (624-625) and
  `--mainnet` (619-623).
- ethers 6.17's `populateTransaction` skips `estimateGas` when `gasLimit` is set (`abstract-signer.js:71`).
- `Wallet` signs locally, and the dry run never simulates.
- A dry run with the secret is refused against a non-loopback `ETH_RPC_URL` (live.js:1116-1121).
- `resolveReplaced` only reads pool data.
- Errors are redacted (live.js:1125-1126).
- The Hardhat test that records every JSON-RPC request (live-poseidon.test.js:208-244) matches this reading for the first send and the
  dry run. `--replace` and `--mainnet` were checked by reading only.

**`swap-cli`: REFUTED.**
- The secret leaves the sealed file only through `swap-cli secret` (main.rs:1148) to stdout.
- No watcher request contains it. The watchers read pending transactions by hash and logs.
- `client_r_selftest` uses a fresh random secret and sends nothing (raw.rs:206-237).
- Fixtures record node answers, which hold `s` only once it is public.

**Pre-existing, not a regression (Info, R6-8):** the sha256 kind still sends the claim calldata to the node in `eth_estimateGas`. This
happens on a first claim and on a dry run with the secret. The loopback rule of live.js:1116 applies to poseidon only.

### 4. The claim

| Item | Result |
|---|---|
| Calldata exactly 68 bytes | **CONFIRMED enforced.** `assertPoseidonClaimCalldata` checks the length and the exact `selector ‖ lockId ‖ secret` before signing (live.js:1144-1151, 1313) |
| 1,000,000 gas against the floor | **Sound.** The floor is 540,000 at the permutation, and the worst honest claim is 544,584 gas in total. At 1 M about 970 k is left at the check. The constants are read from the pinned contract and bounded (live.js:1183-1193). Fork repricing stays the V2-6 residual |
| Balance check | **CONFIRMED.** `requireFundsFor` checks `value + 1,000,000 x cap` before signing (live.js:574-589, 626). Under `--mainnet`, `mainnetCosts` runs with the fixed gas. If no cap is known it returns silently (Info) |
| Claim reverts after publishing `s` | **Gap, R6-3.** Neither tool notices a mined reverted claim. The "treat as possibly public" note cannot fire for this kind |
| Over-long pending calldata | **CONFIRMED as designed.** `find_pending_claim` returns it as `overlong_claim`, only for poseidon, only when `Addr(x) == word` (eth.rs:670-681). The engine uses it as a preimage candidate for Bob's NOID claim, checked again by `check_preimage_for` (engine.rs `preimage_candidates`, `bob_preimage_fact`). It is never treated as Alice's reveal. Unchanged for sha256 (`long_ok` is false) |

### 5. Bob's pre-lock gates

**Client R self-test: CONFIRMED weak binding (R6-4).** The record is
`{passed_at, auth_version, call_height, proof_ms}` (swapfile.rs:878).
- It is outside the public section and bound to no digest, binary, vendor commit or machine.
- The engine checks only `auth_version == auth_version_at(tip+1)` (engine.rs:2245-2256). That is `V4` for every height past 279,370, so
  any record ever made, or copied from another file, passes for ever.
- `passed_at` is never compared with now.
- The throwaway uses a contract version 1 opening even for a version 2 swap (raw.rs:212). It proves and verifies locally and does not
  exercise `submitTxIntent`, the epoch-anchor read or the fee floor.

**The "any earlier lock on A" scan:**
- The pre-lock check is fail-closed only on a node error, a result of exactly 1,000 / 5,000 / 10,000 / 20,000 logs (eth.rs:406-412), or a
  malformed log. The cross-check "the scan must contain the lock the targeted query found" (eth.rs:251-261) needs Bob's own lock, so it
  cannot help BEFORE he locks.
- A provider that truncates silently at another size hides any lock beyond its cut: **CONFIRMED** by construction, as the doc admits.
- The from-block bounds the range. The operator can raise it by flag at any time (main.rs:342-349), and both tools' error messages advise
  doing so. So the bound is the operator's choice.
- I find the scan has no safety value for Bob (R6-2), so this is Info (R6-5).
- Bob's own earlier lock with another id remains blocked by the contract's duplicate-id rule and by R4-2's reuse of `T_reveal`.

**The scan is on the critical path after Bob's lock: CONFIRMED, R6-1.** This is the real problem with it.

**Can Alice grief Bob for ever by pre-locking dust on A?** No. Bob waits (engine.rs:2373-2376) and aborts once the last lock height has
passed (test `bob_never_locks_in_a_poseidon_swap_that_has_no_self_test...` shows the same timing path). Alice then refunds her NOID at
`D`. Nothing is lost, and Alice gains nothing she could not get by not funding. A third party who learns `A` can do the same: R6-2.

### 6. Regressions for the sha256 kind

**No safety change found.** Behaviour changes, all additive or fail-safe:
- `EthWatcher` defaults to sha256, and `discover_lock_ids`, `find_pending_claim` and `cross_check_get_lock` keep their sha256 rule
  (`lock_word_of`, eth.rs:113-118).
- `poseidon_prelock_blocker` returns `None` for sha256.
- `explain` tries the V2 interface first: same error selectors, plus a note.
- `fetchLock` returns a plain object.
- `status` and `lock` reports gain `lockKind`.
- The CHAOS change, "no re-send of a dropped lock while several instances fit" (engine.rs:2405-2420), applies to both kinds. It is a
  deliberate liveness trade (wait, then the existing unsafe-re-send abort). Info.

## New findings

### R6-1 (Medium for a stranger with real ETH above trial size; Low for the owner and trial amounts) The full `Locked` scan can stop Bob's tool after the reveal

**Code.**
- For poseidon, `observe` runs `discover_poseidon` on every poll and for both roles (eth.rs:219-224).
- `discover_poseidon` reads EVERY `Locked` log of the contract from `from_block` in one call. It returns an error when the result has
  exactly 1,000 / 5,000 / 10,000 / 20,000 entries (eth.rs:396-412), and the node errors when the result passes its cap.
- The cross-check (eth.rs:251-261) also errors when the scan misses the pinned lock.
- A primary-node error aborts the whole command (main.rs:414-421 `?`). This covers `tick` (main.rs:520) and `swap-cli claim`
  (main.rs:625), Bob's only NOID claim path for this kind.
- The scan runs whether or not Bob has locked. Bob needs it only to decide `lock_eth`.

**Sequence (malicious Alice).**
1. Bob locks. Alice adds 1-wei locks on the shared contract so the number of `Locked` logs since Bob's from-block (by default the
   deployment block, which is public) is exactly 1,000. Any EOA may call `newLock`.
2. Alternatively, she pushes the count past a provider's result cap (Infura and Alchemy answer an error above 10,000).
3. She reveals, and Bob's every `tick` and `claim` fails with "may be truncated". `watch.sh` keeps failing.
4. Unless Bob's operator acts before `D`, Alice gets the ETH and refunds the NOID at `D`.

**Bob's way out, if he knows it:**
- Change the count: add one lock himself, or include or exclude earlier logs with `--eth-from-block`.
- Alice can answer by escalating to the next cap value (5,000, 10,000, 20,000).
- Raising the from-block above his own lock block makes `require_no_record` fail (eth.rs:327-338), so spam placed after his lock cannot be
  filtered out that way.

**Cost and status.** On Sepolia the cost is nothing. On L1 it is about 144 k gas per lock: about 0.14 ETH at 1 gwei for 1,000 locks,
which is above trial amounts. The exact-count trigger is deterministic on a quiet contract. The code path is **CONFIRMED**; that a real
attacker hits Bob's exact from-block is **PLAUSIBLE**. No test covers a failing scan after the lock (`poseidon_kind.rs:402-422` tests only
the poll error itself).

**Fix.**
- Discover the swap's own locks with the indexed `sender` and `receiver` topics, exactly as the sha256 kind does (`discover_lock_ids`,
  eth.rs:343-387). Both are indexed in `Locked`.
- Run the full word scan only for Bob's lock decisions: the first lock and a re-send. Make its failure a `wait` on `lock_eth` only, never
  a poll error. Alice never needs it.
- Pin every log query of one poll to the `latest_block` read at its start (also R6-6).

### R6-2 (Low, liveness) Any party who learns `A` before Bob locks can veto the swap with a 1-wei lock

**Code.** `poseidon_prelock_blocker` counts every `Locked` log with this word other than Bob's expected id, on either node
(engine.rs:2259-2266). `live.js lock` refuses the same (live.js:1022-1028). The sha256 kind deliberately lets foreign locks through for this
reason (live.js:998-1001).

**Why the block buys Bob nothing.**
- Bob's lock pays the fixed receiver, and only for `x` with `Addr(x) = A`. His NOID lock pays only him.
- If `s` was already public through an earlier lock on `A`, anyone can close the NOID lock to Bob early. That helps Bob.
- A double payment by Bob's own sender is already refused separately (own-lock check, live.js:1010-1016; contract duplicate id).

**Who knows `A`:**
- Alice. Her veto is pointless; she can simply not fund.
- Anyone who sees the bundle.
- Possibly Parano1d mempool observers. The opening is in the creation call while it is pending (PROJECT.md: "not recoverable from chain
  after it leaves the mempool"). **PLAUSIBLE.**

**Effect.** Bob waits, aborts at the last lock height, and Alice refunds at `D`. Fees and time are lost, no funds.

**Fix.** Block only on locks by `bob_sender`, as the sha256 kind does. Report foreign locks. Keep the local T9 database.

### R6-3 (Low) A mined, reverted poseidon claim is invisible to both tools

**Code.**
- ethers 6.17 turns a status-0 receipt into `CALL_EXCEPTION` with `data: null` (`node_modules/ethers/lib.commonjs/providers/provider.js:1143-1149`).
  So `explain` cannot name the error, and the "a claim transaction carries the secret: treat it as possibly public" note (live.js:469, 489)
  never appears for a sent claim. This kind never simulates, so the note has no other source.
- The `receipt.status !== 1` branch (live.js:655) is unreachable.
- In `swap-cli`, `find_pending_claim` skips mined transactions ("the Claimed event covers it", eth.rs:662-664), but a revert emits no
  `Claimed`.
- Alice's re-send after a mined revert finds nothing pending for `--replace`, so the strict `M_A` cutoff rules (live.js:1209-1237), as in
  REVIEW-5 R5-1.

**When.** A stuck claim mined after `T_reveal` (`TimelockExpired`), or a race with a refund. Reverts are as rare as in the sha256 kind,
except that sha256's pre-flight estimate is gone for this kind. A revert also cost the sha256 kind its secret; only the operator message
and the re-send rule are affected. **CONFIRMED** in code. Impact on Alice is the T3 late-reveal risk, unchanged in size.

**Fix.**
- On `CALL_EXCEPTION` from a sent claim, print the hash and "the secret is public".
- Accept a mined reverted claim of this lock, signed by `alice_receiver`, named by hash, as evidence for the late cutoff `T_reveal - DE`.
- Let the watcher return a reverted claim from `--pending-tx` as a preimage candidate for Bob.

### R6-4 (Low) The client R self-test record proves little and is not bound to anything

**Code.** See question 5: swapfile.rs:878-890, engine.rs:2245-2256, raw.rs:206-237, main.rs:1160-1190.
- After activation the version check is constant.
- The record can be copied between files, has no age limit, and names no build.
- The throwaway is a version 1 opening even in a version 2 swap.

**Status.** **CONFIRMED.** The swap file is the operator's own, so this is a weak gate, not an attack.

**Fix.**
- Record the `swap-cli` build id (commit, or a hash of the binary) and the swap's contract version, and require both to match the running
  tool.
- Build the throwaway with the swap's contract version.
- Re-run the self-test at the lock decision when the record is older than a day.

### R6-5 (Info) The from-block is the only bound on the T9 scan, and the tools advise raising it

eth.rs:406-412 and 414 (message); live.js:897-898 ("or a later --from-block"). This is harmless given R6-2. If R6-2 is not adopted, the
advice should say "lower or keep", never "raise".

### R6-6 (Info) The scan and the targeted read each use `latest`

eth.rs:348, 401, 469. If Bob's lock is mined between the scan and `read_logs`, the cross-check (eth.rs:251-261) fails that one poll. On a
load-balanced provider it can recur. The fix is in R6-1.

### R6-7 (Info) Documentation drift

- watch/mod.rs:606-609 says Alice "counts it as a leaked secret". No code does; only Bob's preimage candidates read `overlong_claim`. This
  matches `poseidon-leg.md` 9.8 item 4, not the comment.
- `swap-cli secret` still advises the `equiv-prove` pipe after the poseidon note (main.rs:1149-1152).
- `prepare.sh` passes one `LOCK_KIND` to both roles. That is fine for the owner, but it does not show Bob choosing his own terms.

### R6-8 (Info, pre-existing) The sha256 kind simulates its claim with the secret

The sha256 kind's first claim and its `--dry-run` with the secret go through `eth_estimateGas` (live.js:611). `poseidon-leg.md` 6 item 5
gives a reason not to do this that holds for both kinds. Consider the loopback rule (live.js:1116) for both.

## Summary

| Id | Item | Status / severity |
|---|---|---|
| Q1 | Kind confusion (bundle, file, watcher, live.js) | REFUTED; kind sealed into Alice's digest; old files unchanged |
| Q2 | Word other than the opening's authority; stock as raw | REFUTED |
| Q3 | Secret in any request but the raw transaction (poseidon) | REFUTED (R6-8 is sha256, pre-existing) |
| Q4 | 68 bytes, gas, balance, over-long claim | CONFIRMED correct; revert gap R6-3 |
| Q5 | Self-test, earlier-lock scan, dust griefing | R6-4, R6-1, R6-2, R6-5 |
| Q6 | sha256 regressions | none for safety; Info changes listed |
| R6-1 | Full `Locked` scan blocks Bob's claim after the reveal | Medium (stranger, real ETH above trial size); Low (owner, trial) |
| R6-2 | 1-wei veto on `A` before Bob locks | Low (liveness) |
| R6-3 | Mined reverted claim seen by neither tool | Low |
| R6-4 | Self-test record unbound, constant version, v1 only | Low |
| R6-5 | From-block bound, "raise it" advice | Info |
| R6-6 | `latest` race between scan and targeted read | Info |
| R6-7 | Documentation drift | Info |
| R6-8 | sha256 claim simulated with the secret | Info (pre-existing) |

Severity counts (new): Medium 1, Low 3, Info 4.

## Not checked

- Anything live: no cargo test, no Hardhat, no node, no Sepolia or mainnet. The commit message's counts (446 Rust, 37 harness,
  237 Hardhat) were not reproduced.
- How real providers cap `eth_getLogs`: error versus silent truncation, the sizes, and whether load-balanced backends answer at different
  heights. R6-1, R6-5 and R6-6 assume the common behaviours.
- Whether the Parano1d creation call in the mempool exposes `claim_authority` to observers (R6-2).
- `client/raw.rs` beyond the self-test, and the real `submitTxIntent` path under V4 for a poseidon opening (live run 1 exercised client R
  for the raw variant on sha256).
- `HTLCPoseidonV2.sol`, `Poseidon2b.sol` and the vectors (covered by `docs/poseidon-v2-review.md`). Q8. The prover beyond the three edge
  secrets (V2-9 residual).
- The chaos simulator and the scenario world for the poseidon kind (`Scenario::poseidon`), read only through the tests listed.
- `ui/app`, `btc/`, `equiv/`.
