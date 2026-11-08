# swap-cli review 5 (independent, adversarial, read-only)

Reviewed 2026-11-05 (UTC) against `HEAD` = `6d9bc3e`. Scope, narrow on purpose: the diff that fixed REVIEW-4,
`git diff 69ff20e..6d9bc3e -- swap-cli/src eth/scripts/live.js scripts/live`, with `swap-cli/tests/review4.rs` and
`eth/test/live.test.js` (section "live.js REVIEW-4") read as evidence of intent. Every `file:line` is from `6d9bc3e`.

Nothing was run: no cargo, no Hardhat, no node, no network. Every statement below comes from reading the code and the tests.

Evidence words as in REVIEW-4: **CONFIRMED** (read in the code, a concrete sequence exists), **PLAUSIBLE** (follows from the
code but needs a chain, node or operator behaviour I could not check), **REFUTED** (the attack does not work, with the reason).

## Verdict

1. **Owner's own real money at trial amounts (both roles, or a trusted counterparty): yes.** No change in the diff moves value
   to a third party or opens a new loss path. One gap is left, and it needs operator discipline: a stuck first reveal cannot be
   replaced once the `M_A` cutoff has passed (R5-1). So reveal as soon as the lock is final, use a cap of at least 3x the base
   fee, and run `reveal.sh --replace 0xHASH` if the claim is not mined within a few blocks.
2. **What to fix first:** nothing blocks that use. R5-1 is the first fix in any case.
3. **Before a stranger on the capped `sepolia` profile**, all of these:
   - R5-1;
   - R5-2: `--replace` must find and identify the old transaction or refuse;
   - R5-4: an abort after a cancelled lock needs a fresh Ethereum head, on both nodes when there are two;
   - the R4-8 remainder: both second nodes configured, and `--single-node-ok` opt-in instead of the helpers' default;
   - M1.1 (reproducible image id), as already planned.

   Production and mainnet with a stranger also need M4.

## REVIEW-4 findings at HEAD

| Id | Status | Evidence |
|---|---|---|
| R4-1 base fee, no replacement | **PARTIAL** | Fixed: base-fee check before signing, also in `--dry-run` (live.js:189-215; claim 2x, lock and refund 1x, live.js:322-333); same-nonce `--replace` (live.js:259-320). Left: refused past the `M_A` cutoff (R5-1); the old transaction usually goes unidentified (R5-2); nothing prompts the operator (R5-8) |
| R4-2 cancelled lock, new id | **CLOSED** | `cancelled_intents` (swapfile.rs:771, engine.rs:2588); re-decided with the first cancelled `T_reveal` or Bob walks away (engine.rs:1971-1991, 2144-2176); `expected_lock_id` keeps asking for the cancelled id (engine.rs:2662). Residuals: R5-4, R5-6 |
| R4-3 late re-send blocked by live.js | **CLOSED** | `secretMayBePublic` from the file's history (live.js:88, 575); the frozen cutoff rules only then (live.js:990-997). Event names match `secret_may_be_public` (engine.rs:1096-1098) |
| R4-4 second instance blocks the re-send | **CLOSED** | engine.rs:1519-1525; a first reveal keeps the refusal (engine.rs:1526-1535) |
| R4-5 claim key not tied to the file | **CLOSED** | live.js:923 (claim: `alice_receiver`), live.js:1087 (refund: `bob_sender`) |
| R4-6 resolved intents block every abort | **CLOSED** for Bob | engine.rs:2464-2471; Alice's `fund_noid` hold kept on purpose (only `created` can abort, state.rs:449). The new "abort only when the ETH leg is final" rule (engine.rs:2230-2235) has its own liveness gap (R5-3) |
| R4-7 record-only refund never final | **CLOSED** for `refund_mined` | engine.rs:1750-1758. The same root cause remains in the new `eth_leg_not_settled` (R5-3) |
| R4-8 F5 opt-out, single-source secret | **PARTIAL** | Fixed: the secret is read from either node and each candidate is checked (engine.rs:212-231, 1821-1848); an alarm while Bob waits (engine.rs:752-768, 2210-2222). Left: `env.sh` still adds `--single-node-ok` by default; it now warns on every call (env.sh:50, 54, 62). REVIEW-4 asked for an explicit opt-in |
| R4-9 `lost` on one node | **CLOSED** in code | engine.rs:1165-1181 (fresh second node past `D + 18`, or an error blocks). Under the helpers' default `--single-node-ok` it is still one node's word, which is the R4-8 remainder |
| R4-10 second spend beside a held intent | **CLOSED** | engine.rs:2406-2419; `claim_noid` exempt. Cannot hold a time-critical spend (see question 6); manual cancel sometimes needed (R5-7) |
| R4-11 constants not per profile | **CLOSED** | `tx_grace_s` per profile (params.rs:343, 369, 396; engine.rs:339); validator lower bound (params.rs:815); notes in a `done` with a leftover leg (engine.rs:508, 536-544). Missing relations: R5-5 |
| R4-12 documentation drift | **CLOSED** | PROJECT.md:119 says 735 / 629. Old production files still fail closed, by design |

## Attacks on the fixes

### 1. R4-2: reuse of the cancelled `T_reveal`

**Stale cancel forces a lock outside the gates: REFUTED.**
- `lock_reuse_safe` (engine.rs:1982-1991) re-checks (I1) with Bob's earlier clock (`min(now, head time)`).
- It checks `M_A` and `W_A_min + DE` with the later clock (`eth_now = max`, engine.rs:143-145), and the lock-by height.
- So a lagging node or a stale `t0` can only shorten what Bob grants.
- `f5_gate` still blocks `lock_eth` on a lagging head or a missing second node (engine.rs:921-934).
- Alice's own I3 check (engine.rs:1216-1227) measures from the lock's block time, independently.
- The only gate `choose_t_reveal` has and the reuse lacks is `B_bob` (params.rs:661). The reuse window is bounded anyway: about
  1,680 s after the first decision in production, 720 s under `sepolia`. `B_bob` feeds only `D_offset`, and (I1) and lock-by are
  re-checked. Info.

**Two cancels: REFUTED.** The second decision already carries `t0`, so every entry in `cancelled_intents` names the same id.
`find_map` takes the first one with a `t_reveal`. With no recorded entry but a cancel in the history, Bob walks away
(engine.rs:1975). Migration residual: R5-6.

**Abort that strands a lock that lands later: REFUTED for Alice's acceptance, residual for Bob's view.**
- The abort is recorded no earlier than 3,600 s after the cancel (engine.rs:2476), and the cancel is at least 600 s after the
  decision (engine.rs:2526).
- So a lock that lands after the abort has `T_reveal - block time <= W_A - 4,200`: 3,000 s in production, 0 s under `sepolia`.
  Both are below `W_A_min`, so Alice rejects it (I3) and Bob refunds it by hand.
- This rests on numbers, not on a validator relation (R5-5).
- A lock that lands during the hold is adopted (`FundingFinal` + `EthLockSeen` -> `Locked`, state.rs:595) **if Bob's node shows
  it**. If his single node stalls, R5-4 applies.

### 2. R4-1: `--replace`

**Second nonce: REFUTED.** The nonce is the signer's `latest` count, set explicitly (live.js:266, 320). If the old transaction is
mined in between, the replacement is refused with "nonce too low".

**Another chain or contract: REFUTED.** `bindSwap` pins chain, contract, code hash and lock id from the file (live.js:606-646).
`execute` -> `assertAllowedChain` runs on every path. `claimChecked` re-reads the lock and refuses a claimed or refunded one
(live.js:976-977). Error text is redacted (live.js:379-383).

**Replacing a different transaction: CONFIRMED path, low impact (R5-2).** The old transaction is checked only when it is found
(live.js:268-279). Without `--replace-tx` it is looked for in the node's `pending` block (live.js:234), and a transaction priced
under the base fee, which is the stuck case, is normally not in that block. The plan then replaces whatever sits at the oldest
pending nonce.

**The thresholds.** A cap of 2x the base fee survives about six full blocks of maximum rise (1.125^6 ≈ 2.03), roughly 72 s. That
is fine only because `--replace` exists, and `--replace` is cut off by the `M_A` cutoff (R5-1).

**Direct `eth_estimateGas` against `latest`** (live.js:494-501). It is correct for a replacement: the pending state would revert
`AlreadyClaimed`. The calldata goes only to the endpoint the claim goes to, and in the replace case the secret is already public.

### 3. R4-3: the secret inferred from history

**First reveal pushed past `T_reveal - M_A`: REFUTED.**
- live.js uses the late cutoff only when (a) the file's history has one of the four events AND (b) the pending `reveal_eth`
  intent carries a frozen cutoff later than `timelock - 1,800`.
- (b) is written only when `secret_may_be_public` held at decide time (engine.rs:2435-2439, 1102-1109).
- The four events come only from `SwapFile::apply` of engine or Runner events. On the CLI path that means `eth_claim_mined` or
  `eth_claim_reorged`, i.e. a claim that was mined, so the secret was public. No CLI command writes them (`--closed-by` writes
  only `noid_closed_externally`).
- A forged history needs write access to the operator's swap file, which is outside the threat model: that writer could already
  edit the intent.

The flip side is R5-1: the CLI path never records "a claim was sent", so a pending (public) claim does not count.

### 4. R4-8 and R4-9: one lying node

**A spend or a terminal state one honest node would not give: REFUTED for the new code.**
- Every preimage candidate from either node is checked against `H` and `A` (engine.rs:1826-1846). A lying node cannot invent `s`,
  and a wrong one never hides a right one.
- `lost` now needs a fresh second node past `D + 18` that also lacks the instance, and a second node that could not be read also
  blocks (engine.rs:1165-1181). A lying second node can only delay.

**Residual (Info).** `eth_leg_not_settled` (engine.rs:1995-2013) reads the primary only. A lying primary can make Bob's `abort`
in `secret_seen` final while the lock is still open. Bob's ETH stays refundable to him alone, so nothing moves to anyone else,
but the watch loop stops.

### 5. Dead ends from R4-6 and the two chaos corrections

- **Bob's abort waits for a final close (engine.rs:2230-2235): new liveness gap, R5-3.** With the close known only from the
  `getLock` record, its block is the poll's head (watch/eth.rs:504, 512), never at or below `finalized`. The file prints `wait` for
  as long as the log is missing. It fails safe and nothing is lost.
- **Alice does not adopt a second lock after `eth_claim_final` (engine.rs:995-997, 1474-1475): no dead end.**
  `funding_final` refunds at `D`. A recovery close that re-lands after the reorg is recorded with `tick --closed-by`, as before.
  The CLI path has no other way out of `funding_final` once the instance is gone; that is pre-existing.
- **R4-6 for Alice:** a resolved `fund_noid` still holds an abort, but Alice can abort only from `created`, and `funded` falls back
  to `funding_submitted`, not `created` (state.rs:449-451). No dead end found.

### 6. R4-10: waiting beside a held intent

**Blocking a time-critical refund: REFUTED.**
- The hold replaces only ledger kinds that differ from the held one. `claim_noid` is exempt (engine.rs:2404-2407), and so is
  `abort`.
- For Bob the only pairs are `refund_eth` beside `lock_eth` (impossible: no lock, no refund) and `claim_noid` beside `refund_eth`
  (exempt).
- For Alice the pair is `refund_noid` beside `reveal_eth`. After `D` only the recovery branch is open, and it never expires.
- `refund_eth` after `T_reveal` cannot be raced either: `claim` needs `block.timestamp < T_reveal`.

Liveness cost: R5-7.

### 7. `tx_grace_s` and the validator rule

The values are 600 / 120 / 600 s, and the rule is `tx_grace_s >= 2 * RA` (params.rs:815).
- It is only a lower bound. The upper relation, that a reveal sent at the cutoff and silently dropped can still be re-sent
  (`tx_grace + RA + DE <= M_A`), holds by number (840 <= 1,800; 240 <= 300) but is not encoded.
- `MIN_CANCEL_AGE_S` (600) and `ABORT_AFTER_CANCEL_S` (3,600) are global constants (engine.rs:2482, 2487).
- R5-5.

## New findings

### R5-1 (Medium for strangers and mainnet; Low for the owner's own use) A stuck first reveal cannot be replaced past the `M_A` cutoff

**Code.**
- `claim --replace` goes through the same cutoff check as a first claim (live.js:985-1004), before `feePlan` (live.js:1056).
- On the CLI path the history gets none of the four "public" events while a claim is merely pending (reveal_submitted is a Runner
  event), so `lateResend` is false. The cutoff is then `min(timelock - margin, T_reveal - M_A)`.
- An explicit `--margin-s` can only tighten it.

**Sequence.**
1. Alice reveals with a cap of 2-3x the base fee. The base fee outruns it within minutes, so the claim sits in public mempools
   and `s` is public.
2. The `M_A` cutoff passes before she reacts. Under `sepolia` with Bob at `W_A_min` that is as little as
   3,360 - 1,140 - 1,800 = 420 s after the lock is final; in production 2,460 s.
3. `reveal.sh --replace 0xHASH` is refused with "past the reveal cutoff".
4. Bob claims the NOID with the public `s` and refunds at `T_reveal`.

The same holds without any cap on a test chain (the node prices at 2x base fee + tip) when a fee spike follows.

**Fix.** Under `--replace`, a pending claim of THIS lock, found by `--replace-tx` (or in the pending block) and signed by
`alice_receiver`, proves the secret is public. Then allow the cutoff `T_reveal - DE`, as for the late re-send. In swap-cli, add a
note when a `reveal_eth` intent is held and the signer's pending nonce has stayed above latest for more than a few blocks.

### R5-2 (Low) `--replace` without an identified old transaction replaces whatever is at the oldest nonce

live.js:268-279 checks the old transaction only if it was found. The fallback search (live.js:231-246) uses the `pending` block,
which normally omits a transaction priced under the base fee. `reveal.sh --replace` without a hash is documented
(scripts/live/README.md, "Stuck claim").

With a key used by one swap only, the effect is a claim replacing the stuck claim, which is the intent. With a key shared across
swaps, it can cancel another swap's pending claim (whose secret is already public) or lock.

**Fix:** refuse `--replace` when the old transaction cannot be found and identified. Require `--replace-tx` and make `reveal.sh`
demand it.

### R5-3 (Low, liveness) Bob's abort in `secret_seen` never comes when the close is known only from `getLock`

`eth_leg_not_settled` (engine.rs:2002-2011) compares the close's block with `finalized`, but a record-only close carries
`latest_block` (watch/eth.rs:504, 512). This is R4-7's root cause in the new rule.

Fail safe: the file waits for as long as the log index lags or the `--eth-from-block` range misses the log.

Related, in R4-7's own fix (engine.rs:1750-1751): when a record-only refund is re-included after a reorg, finality is counted from
the first recorded block. That is negligible after `T_reveal` (no claim can replace a refund there).

**Fix:** keep the first block a record-only close was seen at, as Alice's claim does, and count from it.

### R5-4 (Low-Medium for strangers) An abort after a cancelled lock rests on one Ethereum node, with no head check

**Code.** `f5_gate` checks the Ethereum head time only for `lock_eth` and `reveal_eth` (engine.rs:921-928). An `abort` in
`funding_final` is recorded after the one-hour hold (engine.rs:2383-2398, 2476) on whatever the primary node's `getLock` says
about the cancelled id.

**Sequence.**
1. The cancelled lock lands within the I3-acceptable window (production: before about 1,800 s after the decision).
2. Bob's only Ethereum endpoint stalls for about 40 minutes.
3. The file records `aborted` and `watch.sh` stops.
4. Alice accepts the lock and reveals. Bob's terminal file does not claim the NOID before `D`.
5. The abort text tells him to refund at `T_reveal`, which is wrong once Alice has claimed.

Loss: the lock amount (capped at 0.01 Sepolia ETH under `sepolia`). PLAUSIBLE: it needs a stalled endpoint plus the R4-2
precondition.

**Fix.** Before recording an abort in a file that ever decided `lock_eth`:
- require `eth_lag_alarm` to be clear, and the second node to show no lock with any cancelled id when there is one;
- say in the reason: "if that lock lands and a secret appears, claim the NOID before D".

### R5-5 (Info) Safety by numbers, not by the validator

These relations hold in all three profiles but nothing enforces them:

| Relation | What it protects | Margin |
|---|---|---|
| `W_A - MIN_CANCEL_AGE_S - ABORT_AFTER_CANCEL_S < W_A_min` | a lock that lands after a recorded abort fails Alice's I3 | 3,000 < 5,400; 0 < 3,360; negative |
| `tx_grace + RA + DE <= M_A` | a reveal sent at the cutoff and dropped can be re-sent in time | 840 <= 1,800; 240 <= 300 |

`MIN_CANCEL_AGE_S` (600 s) also exceeds the whole `rehearsal` reveal window. Add the two relations to `Gates::validate` and make
the two cancel constants profile values.

### R5-6 (Info, migration only) A cancel written before `ef1e126` is ignored once a later cancel is recorded

`cancelled_lock` (engine.rs:1971-1978) returns `Known` as soon as one recorded entry exists. A file with an unrecorded older cancel
(another `T_reveal`) followed by a recorded one would reuse the newer `T_reveal`, so two ids are possible.

**Fix:** treat the file as `Unrecorded` when there are more `intent_cancelled:lock_eth` history entries than recorded `lock_eth`
entries.

### R5-7 (Info) A `reveal_eth` intent that never resolves holds Alice's `refund_noid`

On the CLI path the `reveal_eth` intent resolves only on a phase change (engine.rs:2320-2321).

**When this happens:** the reveal lost to Bob's refund and Bob never claimed, so the phase stays `lock_final`.

**Effect:**
- `refund_noid` at `D` is withheld until `intent --cancel`.
- That cancel is refused while a stuck claim keeps the nonce pending (engine.rs:2545-2551), and live.js has no tool to clear a
  nonce: `send` takes no nonce.
- The wallet's recovery close remains, and the recovery branch never expires.

**Fix:** resolve a `reveal_eth` intent when its lock is refunded or claimed (as `refund_eth` is resolved, engine.rs:2307-2316).

### R5-8 (Info) Operator tooling

- `refund-eth.sh` and `lock.sh` pass neither the mainnet fee flags nor `--replace`. A chain-1 file is therefore refused by them,
  which fails closed. `refund --replace` exists only through live.js directly.
- swap-cli never says "your claim looks stuck". The operator must read `eth-claim.err`.

## Summary

| Id | Item | Status / severity |
|---|---|---|
| R4-1 | Base fee and replacement | PARTIAL (R5-1, R5-2, R5-8) |
| R4-2 | Cancelled lock, new id | CLOSED (residuals R5-4, R5-6) |
| R4-3 | Late re-send through live.js | CLOSED |
| R4-4 | Second instance blocks the re-send | CLOSED |
| R4-5 | Claim key | CLOSED |
| R4-6 | Resolved intents block the abort | CLOSED (R5-3 is the new rule's gap) |
| R4-7 | Record-only refund finality | CLOSED for `refund_mined` (R5-3) |
| R4-8 | F5 opt-out; one source for the secret | PARTIAL (helpers still default to `--single-node-ok`) |
| R4-9 | `lost` on one node | CLOSED in code (practice follows R4-8) |
| R4-10 | Second spend beside a held intent | CLOSED (R5-7) |
| R4-11 | Per-profile grace, notes in `done` | CLOSED (R5-5) |
| R4-12 | Documentation drift | CLOSED |
| R5-1 | Stuck first reveal not replaceable past `M_A` | Medium (strangers, mainnet); Low (owner) |
| R5-2 | `--replace` without an identified old transaction | Low |
| R5-3 | Abort waits for ever on a record-only close | Low (liveness) |
| R5-4 | Abort after a cancel on one stalled Ethereum node | Low-Medium (strangers) |
| R5-5 | Relations held by numbers only | Info |
| R5-6 | Pre-`ef1e126` cancel ignored after a recorded one | Info (migration) |
| R5-7 | Unresolved `reveal_eth` holds `refund_noid` | Info |
| R5-8 | Helpers without replace or mainnet fees; no stuck prompt | Info |

Severity counts (new): Medium 1, Low-Medium 1, Low 2, Info 4.

## Not checked

- Anything live: no cargo test, no Hardhat (`live.test.js` and `review4.rs` were read, not run), no node, Sepolia or mainnet.
  The commit message's counts (404 Rust, 195 Hardhat) were not reproduced.
- Whether real nodes and public providers include a transaction priced under the base fee in `eth_getBlockByNumber("pending")`
  (assumed not, for R5-2), and how they answer `getTransactionCount(.., "pending")` across load-balanced backends.
- Whether `swap-cli claim` works on a Bob file that is already `aborted` (R5-4's recovery path).
- The chaos simulator (`tests/chaos.rs`) and the formal model: the two chaos-found corrections were judged from the engine code
  and the two `review4.rs` tests, not by re-running the seeds.
- Code outside the diff: `client/`, `watch/` beyond the record synthesis (watch/eth.rs:448-517), `HTLC.sol`, `btc/`, `equiv/`.
