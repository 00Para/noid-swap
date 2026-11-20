# Bob-side concentration gate

Status: **built** (2026-11-08) in `swap-cli`: the reader (`swap-cli/src/watch/producers.rs`), the engine screen (`swap-cli/src/producer_gate.rs`, called from `bob_action` at `funding_final` in `swap-cli/src/engine.rs`), the per-profile numbers (`Gates` in `swap-cli/src/params.rs`), the flag `--accept-producer-concentration`, the helper setting `ACCEPT_PRODUCER_CONCENTRATION` and an alert for a removed claim. Tests: `swap-cli/tests/producer_gate.rs` and the unit tests in the same files. Nothing in it touches a chain beyond read-only header calls. The threat, the measurement and the model are in `docs/miner-concentration.md` (threat T21 in `docs/protocol-design.md` section 8); this document does not repeat them. Section 9 records the decisions that shaped the build; section 10 is about Bob's re-send after a reorg (an alert is built, an automatic re-send is not).

## Bottom line

- **The gate is a screen, not a defence.** Before Bob locks his ETH, `swap-cli` reads who produced the last 2,880 and the last 720 blocks of Parano1d from the node's own headers. Under the `production` profile it does not offer `lock_eth` when one address produced more than 35 % of either window, or when it cannot read the headers in full, they are stale, or the second Parano1d node disagrees. Under `sepolia` and `rehearsal` (limit 28 %) the same evaluation runs and only prints a warning.
- **Two largest together above 50 % is a warning in every profile**, never a refusal.
- **It stops a swap against a producer that is visibly large.** It does not stop one that hides behind fresh addresses, a pool, a partner, rented hashrate, or a share that grows after the lock. Section 2 lists what stays open.
- **As of the measurement it would refuse every production swap**, and it would have refused every swap for the last 20 days.
- **An explicit flag, `--accept-producer-concentration`, waives the production refusals.** It is printed on every tick and recorded once in the swap file's history, and no profile implies it.
- **A removed claim now raises an alert** (a note that starts with `ALERT:`, and an optional message from the watch loop). **No automatic re-send is built** (section 10).

## 1. Purpose and threat

1. If one party holds more than half of the hashrate of Parano1d and is Alice, she can reveal the secret on Ethereum, claim Bob's ETH, then keep Bob's NOID claim from becoming final until `D` and take the NOID back. Bob loses.
2. Above half of the hashrate no window length helps; below it the window and Bob's re-send speed decide (`docs/miner-concentration.md`, sections 3 to 4).
3. Bob can see, before he locks, who produced the recent blocks: every Parano1d header carries the producer's address.
4. The gate refuses to lock (production) or warns (the other profiles) when the recent producers are too concentrated. It looks backwards, at one address at a time (and the top two together, as a warning).
5. It concerns Bob only. Alice's side has no such exposure (`docs/miner-concentration.md`, section 4.1), and Alice's role never reads headers.
6. It fails closed under production: if the headers cannot be read in full, are stale, or the two nodes disagree, there is no lock.

## 2. What the gate can and cannot do

**It can** refuse a swap (production) or warn about one when the node's own headers show a producer above a stated share of the recent blocks. It costs Bob nothing when the chain is not concentrated, and a swap that is refused loses nothing: Bob has locked nothing.

**It cannot defend.** What stays open, each of these defeats or weakens the screen:

| Open | Why |
|---|---|
| One miner on many addresses | The header names the address that gets the reward. An operator can split over fresh addresses; a measured share is a lower bound for that operator. |
| A pool | A pool pays one address. The gate sees the pool as one producer; whoever runs the pool can attack, and the gate cannot tell. |
| Several large producers acting together | The top-two rule is a crude cover, and only a warning. Three or more parties together are not covered. Today 10 distinct addresses produce blocks; the largest three together held 85.9 % of the last 24 hours. |
| Rented or switched hashrate | The gate looks backwards at 24 hours and 6 hours. A miner who joins after the lock, or rents hashrate for the swap, is not in the window. Bob's exposure runs from his lock to `D` (about 6 hours at 30 s per block). |
| A past share is not the future share | In the sustained period the largest share changed by 1 to 3 points from day to day and by at most 9.5 points (`docs/miner-concentration.md`, section 5). The 5-point allowance below is a judgement. |
| The reward address is not the worker | The block template accepts any valid address for an external worker. A new attacker can mine to a fresh address and show no history. |
| No exit after the lock | Once Bob has locked, only Alice's reveal or the timeout ends the swap. The gate does not watch the share during the swap, and it is not applied to the re-send of a dropped lock (the exposure decision was taken at the first send). A `lock_eth` intent that is already recorded is not withdrawn if the screen fails later: the recorded intent is what `live.js` sends, as with every other gate. |
| The headers are trusted | `swap-cli` does not check proof of work in a header, and does not recompute a header's hash. A node that lies is caught only by the second node, which compares the hash of one block below the tip. A node can in principle report a true `hash` next to a false `miner`; recomputing each hash would close that and is not built. |
| Refusing is not free | Under production it also refuses honest Alices. Availability falls to zero while one address holds more than the limit. |
| Other pairings | The thresholds are derived for the Ethereum pairing and its guaranteed spans (361 blocks production, 132 sepolia). A Bitcoin pairing has other spans (`D_offset` 2,050) and needs its own derivation. |
| Model gaps | Deeper reorgs than seen, timestamp choices on a private branch, and the repeated game with the difficulty rule are not modelled (`docs/miner-concentration.md`, sections 2 and 7). |

## 3. The data

**Source.** The node's own headers through `paranoid_getBlockHeader(height)`, field `miner` (the coinbase recipient, bech32m). Never a third-party service: that is the point of reading it from Bob's own node, and `swap-cli` already asks the same call for the tip's timestamp (F5). The reply also carries `hash`, `prev_hash` and `timestamp` (`noid_rpc/src/types.rs`, `BlockHeaderInfo`). A header's hash covers the miner address, and the hash of a header covers its parent's hash.

**Where it is read.** Only by `swap-cli tick`, only for Bob's role, only while the file is in `received`, `funded` or `funding_final` (the phases in which a lock can still be decided), and only against a live node (`--noid-rpc`; a fixture replay reads none). `claim`, `intent` and Alice's ticks read none. The reader uses its own transports, never the recording one, so none of its headers ends up in a recorded fixture. The watcher's own F5 call for the tip header (it reads the timestamp only) does go through the recording transport; the recorder now replaces the `miner` field of any recorded `paranoid_getBlockHeader` reply with a fixed label, so a recording holds no producer address (recordings made before this change may). The reader's per-call timeout is capped at 10 s and the whole read, the second node's one header included, shares one 40 s budget (a call already under way when it ends can overrun it by at most the per-call cap).

**JSON-RPC batching (measured, 2026-11-08, read-only, local node).** One batch of 50 `paranoid_getBlockHeader` calls was sent to the node on the local machine: accepted (HTTP 200), the answer was an array of 50 objects in request order with no error, 32,791 bytes, 150 ms including the start of the `curl` process. A batch of 250 was also accepted: an array of 250 in order, 164,141 bytes (about 0.65 KB per header), 281 ms. Heights were contiguous and every `prev_hash` was the `hash` of the header below it. So the node serves batches of 250, and a first read of 2,880 headers is 12 requests. The implementation does not rely on it: `JsonRpc::call_batch` has a default that sends the calls one at a time, the HTTP and `curl` transports send an array body and match the answers by `id`, and the reader asks again with single calls whenever the answer is not an array of the right length (a node that refuses batches answers with one error object), when the transport fails on the batch, or for any item of a batch that came back as an error.

**The cache.** A rolling file beside the swap file, `<swap file>.producers` (not the swap file itself, so a swap file made before the change loads unchanged), one line per height: `height hash parent_hash timestamp miner`, ascending and gap-free, written atomically and readable by its owner only. The producer is kept as the address string in this local file, because it has to be counted; it is never printed (a producer is shown as the first 8 hex characters of the SHA-256 of its address) and the file is not committed. It holds the long window (and up to 64 heights below it as the window slides), about 0.6 MB.

Each tick:
1. Take the tip `T` from the observation (`paranoid_blockCount`, already read). The long window is the heights `T - 2,879 ..= T`. A chain shorter than the window is incomplete.
2. Load the cache; a file that does not parse, has a gap, a line that does not link to the one above, or does not start at or below the window's first height is discarded. Drop cached heights above `T`.
3. Read the header at the cache's highest height. If its hash is the cached hash, the cache is good. If not, a reorg happened since the last tick: read downwards, eight heights at a time, at most 64 deep, to the highest height whose hash still matches; drop everything above it. If nothing matches within 64, discard the cache. The depth of the mismatch (65 means none matched) is kept in the summary as a log-only field (`mismatch_depth`); nothing reads it.
4. Read the missing heights up to `T`, oldest first, in batches of up to 250.
5. Check the link: for every height, `prev_hash` equals the hash of the header below it, across the batches and the junction with the cache. A break means a reorg during the read: that batch is thrown away, the summary is incomplete with the reason, and the next tick reads again.
6. Count the long window (2,880 heights) and the short window (720) ending at `T`: the largest producer, the two largest together, the number of distinct producers.

**When to start, and the budget.** As soon as the swap file is in `received` (Bob has Alice's bundle), so that the window is ready when funding is final (at least 19 blocks, about 10 minutes, after Alice's funding). A tick reads for at most 40 s of wall clock and goes on at the next tick; the summary says how many headers are read so far. In `received` and `funded` the reading changes no decision; only `lock_eth` waits for it. With a warm cache a tick reads one to three headers.

**What the observation holds.** `NoidObservation.producers` (absent when nothing was read; `skip_serializing_if`, so old recordings and fixtures load unchanged): `source` (`scheme://host:port`), `tip`, `header_tip`, `read_at`, the two window sizes, `have` (headers of the long window held), `long` and `short` (window size, largest, 8-hex id of the largest, top two, distinct), `complete`, `headers_read`, `second` (the cross-check), `mismatch_depth`, `error`. It holds no address; the tick prints it with the rest of the observation.

## 4. The rule

All comparisons use integer counts (a share is `count / N`): over the limit when `count * 1000 > limit_permille * N`, so the boundary is exact. A share exactly at the limit passes. Shares are printed with one decimal, rounded up, so a printed share is above a limit exactly when the integer test says so.

**Windows.** Long window `N = 2,880` blocks (about 24 hours: the same unit as the measurement); short window `N = 720` (about 6 hours: the span of a swap, `D_offset` 738 in production, which catches a producer that appeared a few hours ago). Both must pass. The numbers live in `Gates` (`producer_window_long`, `producer_window_short`, `producer_limit_permille`, `producer_top_two_permille`, `producer_gate_enforced`) and `Gates::validate` checks them (limits between 1 and 999 permille, long at least short and short above 0, enforced exactly under `production`). They are not command-line options.

**The limit `X`, and where it comes from.** `X = L - 2 sigma - drift`. `L` is the working limit from `docs/miner-concentration.md`, section 5: the largest share at which the model keeps the attack under 0.1 % at the guaranteed span, with free ties and a private lead of 10 blocks (production 361 blocks: `L = 0.42`; sepolia 132 blocks: `L = 0.35`). `2 sigma` is 1.9 points (`N = 2,880`, worst case `p = 0.5`; 3.7 points for `N = 720`). `drift` is 5 points, **a judgement, not a measurement**: the largest share moved by 1 to 3 points from day to day and by at most 9.5 points over the sustained period.

| profile | `L` | minus 2 sigma | minus drift | `X` (set) |
|---|---|---|---|---|
| production | 42 % | 1.9 | 5 | **35 %** (350 permille) |
| sepolia, rehearsal | 35 % | 1.9 | 5 | **28 %** (280 permille) |

The short window uses the same `X`. Its own error is larger, so on its own it refuses somewhat more often near the limit. That is the intended direction for a screen that fails closed.

**What each finding does.**

| # | Condition | production | sepolia, rehearsal |
|---|---|---|---|
| R1 | The largest producer's share of the long or the short window is above `X`. | `lock_eth` not offered; `Wait` with an ALARM reason | warning note; the lock is offered |
| R3 | The headers cannot be read in full: no summary, a call failed, a reply did not decode, a height is missing, the chain of `prev_hash` is broken, the budget ran out before the window was complete, or the summary was built for other windows. | as R1 | as R1 |
| R4 | The data is stale: the headers end more than 2 blocks below the node's tip (the F5 limit `MAX_NOID_TIP_DIFF`), or the read finished more than 120 s before the decision (`MAX_OBSERVATION_AGE_S`), or its time is unknown. (The first half is a backstop: the read is aimed at the observation's own tip, so in practice only a poll that takes more than 120 s makes a read stale.) | as R1 | as R1 |
| R5 | A second Parano1d node is configured and the block at the anchor height differs, or the cross-check could not be read or did not run. | as R1 | as R1 |
| R2 | The two largest together hold more than 50 % of either window. | warning note only | warning note only |

**Two nodes.** Under `production` and `sepolia`, F5 already requires a second Parano1d node for `lock_eth` (or `--single-node-ok`). The reader reuses it and needs only one header from it: the anchor height is `min(tip_1, tip_2) - 3`, and the second node is asked for the block there. Because every hash covers its parent's hash, **equal hashes at the anchor mean the two nodes hold the same chain below it**, producers included, provided each node reports the real hash of its header (the reader does not recompute a hash, see section 2: a node that reports a true hash beside a false producer passes this check). The window's top three blocks are read from the first node only. A different hash is R5. When no second node is configured the screen says "single node, the producer cross-check is not possible" and F5 decides whether that is allowed. When the second node's whole poll failed (`second_error`), F5 holds the lock with its own reason and the screen does not ask that node for headers. One gap remains (section 2): a node can report a true `hash` next to a false `miner`.

**Phase 2: a refusal for a deep reorg (not built).** Refuse when any reorg deeper than 3 blocks is recorded in the window. The node's RPC exposes no reorg history, so it needs `swap-cli` to record its own chain of tip hashes (the cache already detects every mismatch between two ticks and its depth is kept in the summary as a log-only field), and it cannot be retroactive: a window with no record must say "no record", not "no reorg". Open, `TASKS.md` T21-7.

## 5. The override

An explicit flag, **`--accept-producer-concentration`** (no value), on `swap-cli tick`. It follows the pattern of `--single-node-ok`:

- It waives the `production` refusals of the screen: R1 and the fail-closed conditions R3, R4 and R5 (the header cross-check). It does **not** waive the F5 rules: a single node still needs `--single-node-ok`, and a second node that cannot be read at all still holds the lock with F5's reason. Under `sepolia` and `rehearsal` it changes nothing (the screen only warns there).
- It is **never implied by a profile.** No profile turns it on, and `--single-node-ok` does not imply it.
- In `scripts/live/env.sh` it is a setting in `env.local.sh` (`ACCEPT_PRODUCER_CONCENTRATION=1`, only the value 1 counts), passed to `swap-cli` only when set; every call that builds the node flags prints a warning on stderr, as `single_node_warning` does.
- `swap-cli` prints the OVERRIDDEN warning (section 6) **on every tick** while the flag is set and the screen would have refused.
- It is **recorded in the swap file's history** once (a log-only entry, `producer_concentration_overridden: ...` with the shares, or the reason the check could not be completed, never an address, no phase change) on the first tick that offers `lock_eth` under the override, when ticking with `--apply`.
- The warning adds that amounts must stay trial-sized.

## 6. Where it plugs in

**Observation.** `NoidObservation` (`swap-cli/src/watch/mod.rs`) gets the optional `producers` summary and the flag `accept_producer_concentration`, both skipped when empty. The reader is `watch::producers::read_producers`; `main.rs` calls it from `tick` after the node poll.

**Decision.** In `bob_action` (`swap-cli/src/engine.rs`), phase `FundingFinal`, after the timing gates have produced a `t_reveal` (so that a Bob who is held back still aborts when the last lock height passes) and after `poseidon_prelock_blocker`: `producer_gate::lock_gate` pushes its notes and, under `production` without the override, returns `Action::Wait` with the ALARM text as the reason. The gate reads only; it changes no state. The re-send of a dropped lock (`LockSubmitted`) is not gated: the exposure decision was taken at the first send. In `received` and `funded` the same finding is said as information when a summary was read.

**Absent summary.** A production Bob file whose observation has no summary (a fixture replay, a node that was not asked) **fails closed**: it is R3 and `lock_eth` is not offered unless `--accept-producer-concentration` is given. Under `sepolia` and `rehearsal` it is a warning.

**Compatibility.** Swap files made before the change load unchanged (the cache is a separate file, the history only gains log entries). No other decision changes: the guard test `guard_every_decision_of_a_whole_swap_is_the_same_...` runs a whole swap under each profile and variant and compares every tick's action and phase with the screen healthy, absent, over the limit and overridden.

**Producer ids.** A producer is shown as 8 hex characters of the SHA-256 of its address, never the address.

**Texts, as implemented.** Shares are printed with one decimal (rounded up); limits as whole percents. `{...}` is a value.

*ok* (a note; the screen lets the step through):

```
producer concentration ok (T21 screen, not a defence): largest producer {31.4} % of the last 2,880 blocks and {29.0} % of the last 720 (limit 35 %); two largest together {44.7} % and {41.5} % (warning above 50 %); headers to height {291914}, read {4} s ago from {http://127.0.0.1:9601}; second node holds the same block at height {291911}
```

The last clause is `single node, the producer cross-check is not possible` without a second node, and `the second node could not be read, F5 holds the lock` when that node's poll failed.

*refused* (production; a note and the reason of the `Wait`, the same text):

```
ALARM: producer concentration too high, not locking (T21): producer {7f3a9c21} mined {52.7} % of the last 2,880 blocks (limit 35 %) and {61.0} % of the last 720 (limit 35 %); the two largest together {71.5} % and {78.0} % (warning above 50 %). A miner who is Alice can keep Bob's claim from becoming final until D and take both legs. This is a screen, not a defence. Wait for the share to fall, or pass --accept-producer-concentration to accept the risk
```

If the largest producer differs between the windows: `producer {A} mined {x} % of the last 2,880 blocks (limit 35 %) and producer {B} mined {y} % of the last 720 (limit 35 %)`.

*cannot read* (production):

```
ALARM: producer concentration cannot be checked, not locking (T21): {1,420} of 2,880 headers read so far (the next tick reads on). The gate fails closed: no lock until the last 2,880 headers have been read from the node itself
```

Other first sentences: `paranoid_getBlockHeader at height {291203} failed: transport: ...`; `the header at height {291204} does not link to the header below it (a reorg during the read; the next tick reads again)`; `no producer summary was read in this poll (the headers were not asked for, or the read did not run)`; `the summary was computed for windows of {2,000} and {720} blocks, the profile wants 2,880 and 720`; `the second Parano1d node could not be read for the producer cross-check ({reason})`; `a second Parano1d node is configured but the producer cross-check did not run`.

*stale* (production):

```
ALARM: producer concentration data is stale, not locking (T21): the headers end at height {291910} but the node's tip is {291914} (limit 2 blocks behind); read {140} s ago (limit 120 s)
```

*two nodes disagree* (production):

```
ALARM: the two Parano1d nodes disagree about the producers, not locking (T21): the block at height {291911} is {3c1d85aa} on the first node and {9a02e4f1} on the second
```

*warning only* (sepolia, rehearsal; the lock is offered):

```
WARNING: producer concentration too high (T21 screen; under the sepolia profile it only warns and the lock is still offered): {the same sentence about the shares}. A miner who is Alice can keep Bob's claim from becoming final until D and take both legs. This is a screen, not a defence
WARNING: producer concentration cannot be checked (T21 screen; under the sepolia profile it only warns and the lock is still offered): {reason}
```

(the stale and disagreement cases have their own first words in the same frame).

*top two* (every profile; never a refusal):

```
WARNING (T21): the two largest producers together hold {50.1} % of the last 2,880 blocks and {50.0} % of the last 720 (warning above 50 %); two addresses can be one party. This is a warning only: the lock is not refused for it
```

*overridden* (production with the flag, on every tick that the screen would have refused):

```
WARNING: producer concentration gate OVERRIDDEN by --accept-producer-concentration (T21): {the sentence about the shares, or: the check could not be completed (headline: reason)}. This is the exposure the gate exists to prevent. Amounts must stay trial-sized
```

*while Bob waits* (`received`, `funded`, when a summary was read and the finding is not a pass):

```
producer concentration, not yet blocking (the lock is decided when the funding is final; T21): {headline}: {detail}
```

## 7. Tests, and what must not change

**What the tests cover** (`swap-cli/tests/producer_gate.rs` unless named; fixtures use synthetic labels such as `synthetic-miner-A` only, never a real address):
- The boundary: exactly at the limit passes and one block over refuses, for each window; production 35 %, sepolia and rehearsal 28 % (warning only); the printed share against the integer test (unit test in `producer_gate.rs`).
- The top-two rule: a warning only in all three profiles, at both windows, with the exact text.
- Fail closed on every read failure under production and warn only under sepolia and rehearsal: a missing summary, an incomplete one (with the count so far), an error text, other windows, the stale boundaries (2 blocks passes, 3 refuses; 120 s passes, 121 s refuses; unknown time), a second node that differs, one that could not be read, one that was configured but not checked.
- The reader: a cold read in batches of 250; a warm tick reads only the new heights (the cache top and the new blocks, at most three); a hash mismatch re-reads from the match and gives the same counts as a fresh read; a mismatch deeper than 64 discards the cache; a broken or gapped or unlinked cache file is discarded and rewritten; a batch the node refuses or answers short falls back to single calls (against a fake node and over the real HTTP client against a loopback node, and the `curl` transport with a fake `curl`); a failed call, a missing header, a broken `prev_hash` link, a chain shorter than the window and a tip past the chain are incomplete with their reasons; a tick's budget stops the read and the next tick goes on without reading again; the second-node check agrees, differs, is unreadable, uses the lower tip.
- The override: the OVERRIDDEN warning on every decision, one history entry however many ticks, the flag absent means refused, the flag has no effect under sepolia, it waives an incomplete screen under production (decision D4) but not the F5 rules, no profile implies it, the helper passes the flag only when the setting is 1 (`scripts/live/selftest.sh`).
- No address anywhere: the summary and the observation JSON, every printed note, and the stdout of a whole `tick` through the binary; the cache file does hold the address and is local.
- Through the binary: `tick` against a loopback node reads the headers into the cache beside the swap file, leaves the swap file unchanged, reads three headers or fewer on the second tick, and does nothing for a fixture node.
- The texts above pinned exactly (refusal, cannot read, stale, top two, overridden).
- The removed-claim alert (section 10) appears on the reorg path and nowhere else.

**What must not change, and how it is checked:** no decision of any other step (Alice's steps, `fund_noid`, `reveal_eth`, `claim_noid`, the refunds, the re-send of a dropped lock, the abort at the last lock height), the F5 two-node rules, the swap file format, any recorded fixture's replay. Every earlier test passes; the ones that had to change are listed in `TASKS.md` T21-6, and each only needed the new data (a healthy summary in the simulator by default, `--accept-producer-concentration` in the two commands of one test that replay a fixture under production, a filter for the producer note in two exact-note assertions). The guard test above runs a whole swap under each profile and compares the action and the phase of every tick.

## 8. What the thresholds buy

The model's chance that the attack works (`docs/formal/t21_results.md`), free ties, at the span the design guarantees (production 361 blocks, sepolia 132), `rho` 2, percent. "Clean" is a start with no private lead; "lead 10" is a start with 10 private blocks.

| true share | production, clean | production, lead 10 | sepolia, clean | sepolia, lead 10 |
|---|---|---|---|---|
| 0.25 | 0 | 0 | 0 | 0 |
| 0.30 | 0 | 0 | <0.0001 | <0.0001 |
| 0.35 | 0 | 0 | 0.0022 | 0.0133 |
| 0.40 | <0.0001 | <0.0001 | 0.35 | 1.27 |
| 0.42 | 0.0020 | 0.0053 | 1.60 | 4.76 |
| 0.44 | 0.0675 | 0.15 | 5.49 | 13.5 |
| 0.45 | 0.29 | 0.62 | 9.21 | 20.6 |
| 0.50 | 28.5 | 41.4 | 49.6 | 72.0 |

How to read it. The production limit `X = 35 %` is a measured share. With 2 sigma (1.9 points) and the drift allowance (5 points) a measured 35 % can stand for a true share of up to 42 %: 0.0020 % (clean) and 0.0053 % (lead 10), under 0.1 %. The sepolia limit `X = 28 %` can stand for 35 %: 0.0022 % and 0.0133 %. Above the limit the chance climbs fast on the sepolia profile (1.27 % at 0.40, 20.6 % at 0.45) and more slowly on the production profile, whose span is longer. At 0.50 the chance is 28.5 % to 72.0 % depending on the profile and the start; above 0.50 the report's realistic figure is about 100 % (a prepared attacker, `docs/miner-concentration.md`, section 3.4), and only the gate's refusal, when the share is visible, keeps Bob from locking into it. **A larger re-send delay moves the limit down:** with `rho` 10 (about 5 minutes; strict ties) 0.40 gives 0.05 % and 0.45 gives 5.4 % in production (lead 10), so a Bob who re-sends by hand would want a production `X` of about 33 %. That was not adopted (section 9, point 8).

## 9. Decisions taken

These replace the open questions of the design. D1 to D8 are the decisions; the rest of the original list is noted where it was settled by them.

- **D1. The numbers.** Long window 2,880 and short window 720 blocks, both must pass. Single-address limit `X` 35 % for `production`, 28 % for `sepolia` and `rehearsal`. Integer comparison `count * 1000 > limit_permille * N`; a share exactly at the limit passes. The 5-point drift allowance stays a judgement until a daily record (`TASKS.md` T21-1) replaces it with a measurement. The short window is kept.
- **D2. The top-two rule** (the two largest together above 50 % of either window) is a **warning only**, in every profile. It is a printed note, never a refusal.
- **D3. Enforcement by profile.** Under `production` the single-address rule R1 is hard, and so are the fail-closed conditions (headers unreadable or incomplete, a broken parent-hash chain, stale data, a second-node disagreement or a second-node cross-check that could not be read). Under `sepolia` and `rehearsal` the same evaluation runs and everything is a warning; the lock is offered as before. A run in which one person plays both roles on `sepolia` or `rehearsal` therefore needs no flag.
- **D4. The override** is the explicit flag `--accept-producer-concentration` (section 5): it waives the `production` refusals of D3 (the fail-closed ones included), is printed as a warning on every tick, is recorded once in the swap file's history, is never implied by a profile or a default, and does not touch the F5 rules. The helper setting is `ACCEPT_PRODUCER_CONCENTRATION=1` in `env.local.sh`.
- **D5. Phase 2** (a refusal for a deep reorg) is **not built**. The cache-mismatch re-read is built (section 3, step 3), with the depth of the mismatch kept as a log-only field of the summary.
- **D6. The alert for a removed claim** is built (section 10); an automatic re-send is **not** built.
- **D7. Fixtures** use synthetic miner labels only; no real address is in any tracked file.
- **D8. Batching** is built with a fallback to single calls (section 3), and was measured against a local node first.

Settled by the above: the original points 2 (top-two: warning only, D2), 3 (short window: kept, D1), 4 (profiles: enforced under production only, D3), 5 (override under production: yes, D4), 6 (phase 2: not built, D5), 7 (re-send: an alert, not an automatic re-send, D6). Still open: point 8 (a lower `X` for a Bob who re-sends by hand: not adopted; `X` stays 35 %), point 9 (recomputing the header hash: not built; the second node is the only check on the headers) and point 10 (order of work: the daily snapshot, `TASKS.md` T21-1, is still not written).

## 10. Bob's re-send after a reorg

**What is true (checked in the code).**

- **The node does not put the transactions of a reverted block back into its mempool.** `readmit_after_reorg` in `vendor/parano1d/noid_mempool/src/pool.rs` only logs ("wallets should resubmit if needed") and removes duplicates that were submitted in the meantime. Its comment says the authorization bytes are not persisted, so a wallet must resubmit with a fresh authorization.
- **`swap-cli` notices and goes back.** When Bob's claim is no longer confirmed, the engine's `ClaimIncluded` branch gets `Included::Reorged`, records the event and sets the file back to `secret_seen` (or to `claim_submitted` when the node shows the claim pending again); the next tick offers `claim_noid` again with a new proof. The test is `f6_a_claim_reorged_out_and_gone_goes_back_to_secret_seen_and_is_proved_again` in `swap-cli/tests/scenarios.rs`.
- **The sending is not automatic.** Offering is not sending. The spend is a step the operator runs by hand (`claim.sh --submit`; without `--submit` it is a dry run). `tick --apply` writes state and sends nothing. No unattended Bob exists.
- So **the re-send delay is the loop interval plus the operator's reaction**: the helpers' loop runs every 30 s by default, and a person needs minutes, i.e. many blocks. It is longer inside the rotation guard (the last 4 blocks before each 144-block epoch boundary, where the claim waits) and while a close of someone else is pending (threat T2).

**Why the delay matters** (`docs/miner-concentration.md`, section 3.5; production, 361 blocks, clean start, strict ties): at a share of 0.45 a re-send after 2 block events gives 0.03 %, after 4 events 0.20 %, after 6 events 0.78 %, **after 10 events 3.6 %, after 20 events 15 %**; at 0.40 it is 0.027 % after 10 events and 1.2 % after 20. A person who re-sends by hand needs 10 to 20 events. The base case of the model, 2 events, is what a loop without an operator step would give.

**Built: the alert.** When a reorg removes Bob's mined claim and the node does not show it pending (the file goes back to `secret_seen`), the tick adds one note that starts with `ALERT:`:

```
ALERT: a reorg removed Bob's NOID claim from the chain and it is not pending. Send it again: `bash $L/bin/claim.sh` is the dry run, check it, then `bash $L/bin/claim.sh --submit` ($L is the helpers' run folder)
```

It appears on that transition and nowhere else (a claim that is pending again needs no new send and draws no alert; the next tick draws none). It names no address, amount or transaction. `scripts/live/tick.sh` prints each such note on a line of its own. If `ALERT_URL` is set in `$L/env.local.sh`, `scripts/live/watch.sh` sends a short, fixed message for every `ALERT:` line (`noid-swap run N: claim removed by a reorg; run claim.sh dry run`) with `curl -s -f -m 20 -d MESSAGE -K -`; the URL goes to curl on its standard input, so it is not in the process list. The engine prints the alert on one tick only, so there is no latch by line (a second removal of the claim later in the run alerts again, and the same message twice in one call is sent once). A send that fails is kept in `$L/alert-pending` and tried again at every later tick, up to 20 times, because the line is not printed again; a failure never stops the loop, and the URL is never printed (`scripts/live/README.md`). The alert shortens the delay to the operator's reaction; it does not make it seconds.

**Not built: an automatic re-send.** An opt-in unattended re-send of a claim that was already sent remains a proposal. The risk of automating this one step is small: the claim can only pay Bob (the recipient is committed in the contract), and the secret is public by then. It is not zero: a wrong send burns a fee (at most `max_fee`) and a pending call that is not the right one sits in the first-seen order until it is evicted. Conditions it would need:

1. Opt-in and visible. Off by default; a setting in `env.local.sh` that becomes a flag; printed on every tick while on; never implied by a profile.
2. Only for a claim this file sent. The history shows `claim_submitted` with a recorded txid, then the reorg event, and the chain shows that txid neither confirmed nor pending.
3. The same recipient check: the output owner equals the recipient pinned in the file, the opening equals the file's, the fee is within `max_fee`, and every gate that `claim_noid` has today holds (height below `D`, the target `D - 19`, the rotation guard, no pending call on the instance).
4. A dry-run self-check first: build and prove, check the intent against the recorded values exactly as the dry run does, and print them; any difference sends nothing and raises an alarm.
5. A latch against sending twice: a history entry `auto_resend:<removed txid>` written before the send and checked first, and a fixed maximum of automatic re-sends per swap.
6. A printed record: the removed txid, the new txid, the call height, the tip, the recipient.
7. Submitted to every configured Parano1d node, as `claim.sh --submit` does with a second node.

Whether a stored, already-built claim stays valid across a reorg inside its epoch was not checked (`docs/miner-concentration.md`, section 4.2). It changes the project's rule that every spend is started by the operator, so it needs an explicit decision and a live trial of the alert first (`TASKS.md` T21-8).
