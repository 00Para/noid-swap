# Formal check of the swap timeouts (explicit-state model)

`model.py` is an exhaustive, breadth-first model checker (standard library only, Python 3.12) for the safety of the
NOID <-> ETH swap under its timeouts. It models the two chains, the two lock contracts, the gates (I1), (I2), (I3)
of `docs/protocol-design.md` sections 2 and 4 (as implemented in `swap-cli/src/params.rs`), and an adversarial
environment: delayed or stopped parties, stalled or evicted NOID closes, bounded reorgs on both chains, a third party
that holds the secret. It reports, for each invariant, either "holds in every reachable state" or the shortest trace.

Nothing here touches the network, the vendored node or any key. Status: model and results below are the output of the
commands in "Reproduce"; they have not been reviewed independently yet.

**Bottom line.** With all gates on, and inside the environment bounds listed in section 2, no invariant is violated in
any of the three parameter sets (toy, production / 10, production / 6; up to 1.8 million states per configuration). Every gate, switched off alone, produces a counter-example, so the model is not vacuous. The bounds
themselves are tight: the design's budgets have **no unused slack** against one more unit of reorg, eviction, detection
delay, proving time or an unbounded mempool stall (section 6). One finding concerns the code: `Gates::validate`
checks `M_A > eth_finality` only, while the model needs `M_A >= eth_finality + 2 * inclusion delay + reaction`
(section 7).

## 1. Reproduce

```sh
cd docs/formal
python model.py relations          # inequality checks of every parameter set (instant)
python model.py demo toy           # witnesses that a completed swap is reachable in A, B, L
python model.py witness toy        # shortest runs ending in the two excused losses
python model.py base toy           # all gates on: every configuration, every invariant
python model.py ablate scaled      # one gate off at a time -> invariant x gate matrix
python model.py sweep scaled       # assumption / slack sweeps
python model.py all                # toy and scaled, everything above
python model.py base scaled6       # the larger (production / 6) run
```

Measured on one desktop (Python 3.12.10, one thread; the machine was short of memory while the numbers were taken, so
the larger runs are retried automatically after an out-of-memory error):

| run | states (all configs) | wall time |
|---|---|---|
| `base toy` | 107,514 | 2 s |
| `ablate toy` (20 runs), `sweep toy` (25 runs) | 741,606 and 1,205,588 | 13 s and 27 s |
| `base scaled` (production / 10) | 883,264 | 15 s |
| `ablate scaled` (20 runs), `sweep scaled` (25 runs) | 5,602,642 and 7,157,672 | 103 s and 145 s |
| `base scaled6` (production / 6) | 5,318,991 | 92 s |

(Counts are the sum over the runs; the largest single run is 1,813,227 states. The gate-off and sweep runs on the
larger sets stop at the first violation where they fail, so those counts are not state-space sizes.)

The checker keeps about 50 bytes per state (one `bytearray` plus an open-addressing table of 32-bit ids).

## 2. What is modelled

**Time.** One tick = `tau_fast` = 20 s in production. Heights and times are integers. Parano1d produces one block per
tick; the adversary may skip blocks (`LAG`, a slow chain) or add blocks (`BURST`, faster than `tau_fast`, outside the
design and used only as a sensitivity run). The state stores only relative quantities (blocks until `D`, ticks until
`T_reveal`, ages), so two situations that differ by a time shift are one state.

**Parano1d side** (design 2, 6, 8):
- Alice's lock, funded by Alice, mined within `B_fund` blocks, final once `NF` more blocks are mined
  (`NF` = 18 in production; `B_final = NF + 1`).
- Claim branch for heights `h < D`, recovery to Alice for `h >= D`. A pending close is evicted as soon as the next
  height would flip the branch, so the last inclusion height is `D - 1` (design I4).
- A close pays Bob whoever submits it: Bob, or a third party holding the secret (design T1, T2).
- Environment powers on Bob's pending close: it can be kept out of up to `B_epoch + B_fee` blocks in total (the stall
  budget, design T2, T5, T6); it can be evicted `N_EVICT` times (epoch rotation, each time Bob must notice for `RD`
  ticks and prove for `PA` ticks); a reorg of depth up to `NF` can drop a not-yet-final close `N_NOID` times (the tip
  never goes down: the replaced blocks are replaced by as many).
- Alice's funding can be double-spent by a reorg while it is not final (used to show what the "funding final" gate
  protects).

**Ethereum side** (design 2, 4; `eth/contracts/HTLC.sol`):
- `newLock` reverts if `timelock <= block.timestamp`; `claim` only for `ts < T_reveal`; `refund` only for
  `ts >= T_reveal`; a late claim reverts but its calldata has already published the secret (design 2.3).
- Transactions are mined after 1 to `DE` ticks (adversarial choice). Blocks are final `FE` ticks after inclusion;
  before that, up to `N_ETH` reorgs may drop Alice's claim, or (arbitrary Bob only) remove Bob's lock altogether.
- A dropped claim is gone from the mempool: Alice must notice and rebroadcast within `RA` ticks.

**Parties.**
- *Configuration A* (protects Alice): Alice follows the gates and may crash at any tick; Bob is arbitrary: any lock
  time, any window `w`, any refund time, learns the secret at once.
- *Configuration B* (protects Bob): Bob follows the gates and is prompt (learns the secret no later than `Delta_detect` ticks
  after the claim is mined and no later than `T_reveal + Delta_detect`; notices a drop in `RD`; proves in `PA`); he may crash.
  Alice is arbitrary: funds when she likes, reveals when she likes (even after `T_reveal`), double-spends her funding
  if she can.
- *Configuration L* (liveness): both honest and prompt, no crash, environment hostile within the bounds.
- *Configuration LD*: both honest, free timing, no crash (used for L2).
- A crash is a transition any honest party may take at any tick.

**Gates** (each can be switched off on its own):

| flag | gate | where in the design |
|---|---|---|
| `I1` | Bob locks only if `D - h >= (w + Delta + 2*P_auth) + B_post` (so his claim can be final before `D`); `w = min(W_A, T_max)` | 4.2 (I1), `choose_t_reveal` |
| `I2c` | Alice reveals only if `T_reveal - now >= M_A` | (I2), `check_i2_eth` |
| `I2f` | ... and only once Bob's lock is final (`FE` ticks after it was mined) | (I2), step 9.4 |
| `I3` | Bob refuses a window shorter than `W_A_min` | (I3), `check_i3` |
| `FF` | Bob locks only once Alice's funding is final (not one of the three named gates; design 2.2 step 7) | 2.2 |

**Invariants.**

| id | statement | where checked |
|---|---|---|
| S1 | Bob never ends with the NOID and the ETH, unless Alice revealed and then crashed before her ETH claim was final (the excused "reveal then die" loss, counted separately) | settled states, A, L, LD |
| S2 | Alice never ends with the ETH and the NOID, unless Bob crashed (the excused F9 loss) | settled states, B, L, LD |
| S3 | no amount is locked forever: no settled state is "stuck" (all runs), and every open state can still reach a settled state (full graph, in the `base` runs and the toy `ablate` runs of configuration LD) | all |
| S4 | if Alice revealed and is alive, Bob's ETH refund or lock cancellation never succeeds | every state, A |
| L1 | (liveness, extra) both honest and prompt: the swap always completes (NOID to Bob, ETH to Alice) | settled states, L |
| L2 | (extra) no pointless lock: after any lock Bob broadcasts, some schedule still completes the swap | full graph, LD |

L1 and L2 are not requested but are the only way to say what (I3) protects: it has no safety role (section 5).

## 3. Parameters

All numbers are ticks or blocks. "design" relations mirror `Gates::validate`; "model" relations are what this model
needs in addition (derivations in section 7). Every parameter set below satisfies all of them.

| | toy | production / 10 (`scaled`) | production / 6 (`scaled6`) | production (relations only) |
|---|---|---|---|---|
| `W_A` / `W_A_min` / `M_A` | 16 / 13 / 7 | 36 / 27 / 11 | 60 / 45 / 15 | 360 / 270 / 90 |
| `FE` (Ethereum finality) | 4 | 6 | 10 | 57 |
| `DE` / `RA` (inclusion, reaction) | 1 / 1 | 1 / 1 | 1 / 1 | 5 / 3 |
| `Delta_detect`, `P_auth` per proof, `RD` | 1, 1, 1 | 2, 1, 1 | 3, 1, 1 | 15, 1, 1 |
| `NF` (`B_final = NF + 1`) | 2 | 2 | 2 | 18 |
| `B_epoch` / `B_fee` / `B_safety` | 2 / 1 / 5 | 14 / 6 / 5 | 24 / 10 / 5 | 144 / 60 / 21 |
| `B_fund` / `B_bob` / `margin` | 2 / 3 / 2 | 2 / 6 / 3 | 2 / 10 / 3 | 10 / 60 / 18 |
| `B_post`, stall budget | 11, 3 | 28, 20 | 42, 34 | 244, 204 |
| `RHS(I1)(W_A)` | 30 | 68 | 107 | 621 |
| `D_offset` | 40 | 82 | 125 | 728 |
| reorg / eviction budgets | 1 / 1 / 1 | 1 / 1 / 1 | 1 / 1 / 1 | 1 / 1 / 1 |
| arbitrary Bob's windows `w` | all of 1..23 | 15 sampled values | 14 sampled values | - |

`python model.py relations` prints the checks; for production all of them hold (the production set is the design's with the zero-slack `B_safety` = 21 of
this model: `621` and `728`; the tool adds margin on top, see "Applied 2026-11-08" in section 7).

How the scaled sets are made. The design's `tau_fast` is 20 s, so the tick is already the design's own unit; the
large budgets (`W_A`, `M_A`, `FE`, `B_epoch`, `B_fee`, `D_offset`) are divided by about 10 (or 6) and rounded to keep
every inequality true. Quantities that cannot shrink (one proof is one tick, noticing a drop is one tick, `NF` of at
least 2, one block of inclusion delay) are kept. The slack of each model inequality is kept at about its production
ratio, with one exception kept exactly: production has `B_safety = 21 = NF + RD + PA + 1` (zero slack; 20 with `NF` = 17 before 2026-11-08), so every set
uses `B_safety = NF + 3`. `D_offset` is recomputed from the design's formula, not scaled.

Choices that are **mine, not the design's**: `DE`, `RA`, `RD`, the one-tick proof, and the budgets of one reorg, one
eviction on each chain; they appear in section 6 as the knobs that break the result when exceeded.

## 4. Method and what keeps it tractable

- A transition is one tick: the environment moves first (Ethereum inclusions and reorgs, NOID evictions and reorgs,
  block production with inclusion or stall), then crashes, then Bob's learning, then Alice, then Bob. Simultaneous
  independent events inside a tick are applied in that one fixed order, so there are no interleavings to enumerate.
- States are relative (no clock), so time-shifted situations merge. A state whose outcome is decided (both assets have
  an owner and nothing pending can change it) is collapsed to one record per outcome class and not expanded.
- Arbitrary Bob in the production / 10 and / 6 runs picks his window `w` from a boundary-value sample (around `M_A`,
  `FE + M_A`, `W_A_min`, `W_A`), not from all integers; the toy run uses every integer. In production / 10 and / 6
  configuration B, Bob cannot crash (a crash can only add excused losses and shrink Bob's actions); the toy run has
  the crash and shows F9.
- Gate-off and sweep runs on the larger sets stop at the end of the first level that contains a violation of the
  invariant under test ("-" in a table means the search stopped before deciding that invariant).
- S3 (reachability of a settled state from every open state) and L2 (reachability of a completed swap after a lock)
  use the full graph, with edges stored: done in the `base` runs and in configuration LD of `ablate`. Everywhere else
  S3 is only the test that no settled state is stuck.

## 5. Results: which gate protects which invariant

All gates on: no violation (rows "none"). Entries are "FAIL at n ticks" where n is the depth of the first violating
state counting from the start, so it includes any idle waiting an adversary needs (for example waiting until `D` is
near); it is not the length of the story.

Production / 10 (`python model.py ablate scaled`):

| gate switched off | S1 | S2 | S3 | S4 | L1 | L2 |
|---|---|---|---|---|---|---|
| none (baseline) | holds | holds | holds | holds | holds | holds |
| (I1) Bob's claim can be final before D | holds | FAIL @ 82 | holds | holds | holds | FAIL @ 72 |
| (I2) reveal cutoff `T_reveal - M_A` | FAIL @ 11 | holds | holds | FAIL @ 8 | holds | holds |
| (I2) Bob's lock final before reveal | FAIL @ 5 | holds | holds | FAIL @ 3 | holds | holds |
| (I3) window >= `W_A_min` | holds | holds | holds | holds | holds | FAIL @ 33 |
| Bob locks only on final funding | holds | FAIL @ 9 | holds | holds | holds | holds |

Toy (`python model.py ablate toy`, every search exhaustive): the same pattern, at 40, 9 / 6, 5 / 3, 15, 7 ticks.

Reading:
- **(I1)** protects S2: Bob locks with too few blocks left, Alice reveals, Bob cannot get his close final before `D`.
  It also protects L2 (the same lock is pointless).
- **(I2) cutoff** protects S1 and S4: Alice reveals when `T_reveal` is about to pass.
- **(I2) lock final** protects S1 and S4: Bob's lock is removed by an Ethereum reorg after Alice revealed.
- **(I3)** protects **no safety invariant**. It protects L2: without it Bob can lock a window too short for Alice to
  finish (finality, then her cutoff), the swap can no longer complete, and both sides are locked until their timeouts
  for nothing. Its value is liveness and capital, not safety.
- **Funding-final** gate protects S2 (Alice double-spends her funding after Bob locked).
- S3 holds in every gate-off run: no gate protects it. The only S3 violation found is outside the gates:
  `max_fee` below the fee floor (hard safety rule 5): both the claim and the recovery are inadmissible and the lock is
  stuck (section 6).

Shortest counter-examples (toy parameters; `t` counts from the first tick of that run; the lines show only ticks
where something happens).

(I2) cutoff off, S1: Bob locks with a window of 2 ticks, refunds at once; Alice, who does not check the cutoff,
reveals later; her claim reverts but the secret is public, so Bob also closes the NOID to himself.
```
t=0  Alice funds the NOID lock; Bob broadcasts newLock with T_reveal = t+2 (= 2)
t=1  Ethereum lock mined
t=2  NOID funding mined; Bob broadcasts refund(lockId)
t=3  Bob's refund mined (ETH back to Bob)
t=5  Alice broadcasts claim(lockId, x): the secret is public; Bob submits the NOID close to himself
t=6  Alice's claim mined at or after T_reveal (reverts, x still public); NOID close mined (pays Bob)
=> NOID to Bob, ETH to Bob, Alice alive
```

(I2) lock final off, S1 and S4: Alice reveals as soon as the lock is mined; an Ethereum reorg then removes the lock,
Bob keeps the ETH and takes the NOID.
```
t=0  Alice funds the NOID lock; Bob broadcasts newLock with T_reveal = t+8 (= 8)
t=1  Ethereum lock mined; NOID funding mined; Alice broadcasts claim(lockId, x): the secret is public; Bob submits the NOID close
t=2  Alice's claim mined before T_reveal (valid); NOID close mined (pays Bob)
t=4  Ethereum reorg removes Bob's lock (double-spend)
=> NOID to Bob, ETH to Bob, Alice alive
```

Funding-final off, S2: Bob locks on a funding that is mined but not final, Alice reveals and claims, then a NOID
reorg removes her funding.
```
t=0  Alice funds the NOID lock
t=1  NOID funding mined; Bob broadcasts newLock with T_reveal = t+16 (= 17)
t=2  Ethereum lock mined; Alice broadcasts claim(lockId, x): the secret is public
t=3  Alice's claim mined before T_reveal (valid); NOID reorg removes Alice's funding (double-spend)
t=4  Bob learns the secret
=> NOID to Alice, ETH to Alice, Bob alive
```

(I1) off, S2: Bob waits until 10 blocks remain before `D` (the gate would have required 30), then locks; Alice
reveals, Bob learns the secret 3 blocks before `D`, and the branch flips before his close can be mined.
```
t=0   Alice funds the NOID lock
t=2   NOID funding mined
t=30  (blocks to D: 10)  Bob broadcasts newLock with T_reveal = t+16 (= 46)
t=31  Ethereum lock mined
t=35  Alice broadcasts claim(lockId, x): the secret is public
t=36  Alice's claim mined before T_reveal (valid)
t=37  (blocks to D: 3)  Bob learns the secret; Bob starts proving his close
=> NOID to Alice, ETH to Alice, Bob alive
```

(I3) off, L2: Bob (honest, late but inside (I1)) locks with a window of 11 ticks, shorter than the 12 Alice needs
even in the best case (inclusion 1, finality 4, cutoff 7); no schedule completes the swap.
```
t=0   Alice funds the NOID lock
t=2   NOID funding mined
t=14  (blocks to D: 26)  Bob broadcasts newLock with T_reveal = t+11 (= 25)
```
The best-case threshold is 12; `W_A_min` = 13 is the worst-case threshold (inclusion 1 plus finality 4 plus reaction
1 plus cutoff 7). With `W_A = 12` (and `W_A_min` lowered to 12) configuration L fails L1; with 13 it holds, both in
the toy and (19 / 18) in production / 10.

## 6. Results: the environment bounds, one unit at a time

Gates on, one parameter changed. "gate" rows change a number the gates use; "world" rows change only the
environment, so the gates keep their old budget. Production / 10 (`python model.py sweep scaled`); the toy gives the
same verdicts except where noted.

| case (changed) | cfg | S1 / S2 / S4 / L1 | S3 | states |
|---|---|---|---|---|
| stall budget unlimited (open question Q1, design T2) | B | S2 FAIL | - | 51,607 |
| stall budget 0 | B | S2 holds | holds | 34,538 |
| stall budget + 1 (`B_epoch + B_fee + 1`) | B | S2 FAIL | - | 274,914 |
| NOID reorgs of the close: 2 (budgeted: 1) | B | S2 FAIL | - | 384,082 |
| NOID reorgs: 0 | B | S2 holds | holds | 129,941 |
| mempool evictions: 2 (budgeted: 1) | B | S2 FAIL | - | 389,886 |
| `B_safety - 1` (gate) | B | S2 FAIL | - | 290,172 |
| `B_safety = 0` and no NOID reorg (gate) | B | S2 holds | holds | 180,586 |
| `Delta_detect + 1` (world) | B | S2 FAIL | - | 280,016 |
| `P_auth + 1` tick (world) | B | S2 FAIL | - | 361,410 |
| `RD + 1` (world) | B | S2 FAIL | - | 347,810 |
| one burst block, faster than `tau_fast` (world) | B | S2 FAIL | - | 629,659 |
| slow chain, 2 skipped blocks (world) | B / L | holds / holds | holds | 964,518 / 163,840 |
| Ethereum reorgs: 2 (budgeted: 1) | A | S1 FAIL, S4 holds | holds | 634,853 |
| `M_A` = model bound 9 (gate) | A | holds | holds | 336,997 |
| `M_A` = bound - 1 = 8 (gate) | A | S1 FAIL, S4 holds | holds | 341,797 |
| Ethereum finality +1, +1 inclusion, +1 reaction (world, one each) | A | holds | holds | 391,416 / 434,144 / 370,576 |
| Ethereum finality + 3 (world; slack is 2) | A | S1 FAIL, S4 FAIL | - | 12,069 |
| window `W_A` = 19 / 18 (= `DE+FE+RA+M_A`, -1) | L | L1 holds / L1 FAIL | holds / - | 26,496 / 20,204 |
| `max_fee` below the fee floor (rule 5) | B / L | S2 holds / L1 FAIL | S3 FAIL / FAIL | 6,514 / 1,183 |

In the toy, whose model inequalities are all tight, every "+1" row fails S1 or S2 (for example `Delta_detect + 1`,
`P_auth + 1`, Ethereum inclusion + 1, reaction + 1, finality + 1); the verdicts of the unlimited stall, the second
NOID reorg, the second eviction, `B_safety - 1`, the burst block and the second Ethereum reorg are identical.

What these say:
1. **The (I1) budget is exactly the model's worst case.** `Delta_detect`, `P_auth`, `RD` each +1 break S2 even though the
   scaled sets keep the production ratios. There is no cushion at Bob's lock-by height. The `margin` in `D_offset`
   (18 blocks in production) only helps a Bob who locks earlier than the lock-by height.
2. **`B_safety` = 21 is exactly one NOID reorg** (20 with `NF` = 17, before the finality correction of 2026-11-08). The worst case: the close is mined, a reorg of depth `NF` drops it
   when it is one block short of final, Bob notices (`RD`), proves (`PA`), the close is mined again and must be final:
   `NF + RD + PA + 1 = 21`. With no NOID reorg `B_safety = 0` is enough; with the reorg, 20 is not. So the design's
   "restarts, RPC hiccups" slack has nothing left for restarts or hiccups on top of one adversarial reorg.
3. **An unbounded stall is a violation** (design T2, open question Q1). If a conflicting minimum-fee close can sit in
   the mempool until the branch flips, Bob loses the NOID although every gate held. The budget `B_epoch + B_fee` is
   an assumption to be measured, not a guarantee.
4. **A second reorg or second eviction** (Parano1d) or a second reorg (Ethereum) breaks it. These are assumptions
   too; the design budgets one of each.
5. **Fast blocks break it**, slow blocks do not (design T20).
6. `max_fee` below the fee floor is the only S3 violation: nobody can ever close the lock (hard safety rule 5).

The excused losses are reachable and are the only losses in the baseline (`python model.py witness toy`):
- Reveal then die (config A): the claim is mined, an Ethereum reorg drops it, Alice crashes before she rebroadcasts;
  Bob refunds and closes the NOID to himself. The model shows that a broadcast claim does not need Alice any more
  unless a reorg drops it.
```
t=5   Alice broadcasts claim(lockId, x): the secret is public; Bob submits the NOID close to himself
t=6   Alice's claim mined before T_reveal (valid); NOID close mined (pays Bob)
t=9   Ethereum reorg drops Alice's claim
t=10  ALICE CRASHES
=> NOID to Bob, ETH to Bob
```
- F9 (config B): Bob crashes after Alice's claim; Alice refunds at `D` and keeps the ETH.
```
t=23  Alice broadcasts claim(lockId, x): the secret is public
t=24  Alice's claim mined before T_reveal (valid)
t=25  BOB CRASHES
=> NOID to Alice, ETH to Alice
```

## 7. Findings for the design and the code

1. **No violation under the design's gates**, inside the bounds of section 2, for production / 10 and / 6 (exhaustive
   for every configuration; the largest run is 1.8 million states).
2. **Add two checks to `Gates::validate`.** It checks `M_A > eth_finality` and `W_A_min - M_A >= eth_finality +
   Delta_detect`. The model needs, for one Ethereum reorg of Alice's claim,
   `M_A >= FE + 2*DE + RA` (claim mined at the cutoff plus `DE`, dropped just before final `FE - 1` later,
   rebroadcast after up to `RA`, mined again within `DE`, still before `T_reveal`), and
   `W_A_min >= DE + FE + RA + M_A`. Production has 20 ticks (400 s) of slack on the first (90 against 70 with
   `DE` = 5 ticks, `RA` = 3 ticks) and 115 ticks on the second, but the validator would accept an `M_A` that has none.
   `DE` and `RA` are my assumptions, not measured.
3. **State the three reorg-and-stall assumptions as a unit**: one stall of at most `B_epoch + B_fee` blocks, one
   eviction, one reorg of the close. Together they use the whole of `B_post` (`B_epoch + B_fee + B_final +
   B_safety`, with the eviction paid by the second `P_auth`); one more of any breaks S2 (stall + 1 block, a second
   eviction, a second reorg all fail). Experiments Q1 and Q14 decide whether the assumptions hold.
4. **(I3) is a liveness gate, not a safety gate.** Keep it; document it as such.
5. **A "funding final" gate is safety-relevant** (Bob must not lock on a funding that a reorg can still remove). It is
   already in design 2.2 step 7; it is not one of the three named gates.

**Applied 2026-11-05.** Findings 1-2 of the model check as seen from the code: `Gates::validate` now also demands `M_A >= eth_finality + 2*DE + RA`
and `W_A_min >= DE + eth_finality + RA + M_A`, with two new per-profile fields (`DE` = 120 / 60 / 120 s and `RA` = 120 / 60 / 120 s for
production / rehearsal / sepolia: ten 12-s blocks, two polls; the local chain mines on demand), and the production `B_safety` is 30 instead of 20,
so `B_post` = 252, `RHS(I1)` = 629 (full window) / 539 (minimum), `D_offset` = 735 (design 9.1; `swap-cli/src/params.rs`). `rehearsal` and `sepolia`
keep their numbers (they accept the rotation and reorg risk by design) and pass the new checks without change. The scaled runs of this section were made with `NF` = 2 and are unchanged by the later correction; the production column was then 242 / 619 / 725 (`NF` = 17, `B_safety` 20 in the model) and the tool 252 / 629 / 735.

**Applied 2026-11-08.** The finality depth is 18 (the vendored node's `is_final` is `tip >= height + 18`), not 17, so production `NF` = 18, `B_final` = 19 and the zero-slack `B_safety` = `NF + RD + PA + 1` = 21. The model's production set is now `NF` 18, `B_safety` 21, `B_post` 244, `RHS(I1)` 621, `D_offset` 728 (`python model.py relations`: every design relation holds). The tool's production `B_safety` is 31 (= 21 + the T6 guard 4 + 6 for restarts), `B_post` 254, `RHS(I1)` 631 (full window) / 541 (minimum), `D_offset` 738 (`swap-cli/src/params.rs`). The scaled sets (`NF` = 2, `B_safety` = `NF` + 3) do not change and were not run again.

## 8. What is abstracted away, and what the checker does not cover

- **No amounts or fees.** `max_fee`, the fee floor and the 1 % rule enter only as a boolean (S3 test). A burned
  `max_fee` (design T1) cannot change who holds what, so it is not visible here.
- **One chain pair only: NOID <-> ETH.** The Bitcoin pair differs: its claim branch never expires, and Bob's
  window is set by Bitcoin's block-time tail (design 4.4). Not modelled.
- **Cryptography is perfect.** The equivalence proof, the zero-knowledge authorization, `Addr`, SHA-256, the
  recipient rule in the block proof (design Q2, T14) and the Poseidon2b margin (T8) are assumed to hold. A claim
  always pays Bob; a refund always pays Alice; only the secret holder can close.
- **Mempool and relay are one nondeterministic delay.** Admission order, relay floors, replacement rules, the
  first-seen rule per slot and the epoch anchor appear only as: "the close may be kept out of up to `S` blocks"
  and "may be evicted `N_EVICT` times, then costs `RD + PA` ticks". The design's 144-block rotation is a budget, not
  a calendar; rotations at fixed block numbers (the guard of design T6) are not modelled.
- **The tip never goes down.** A reorg replaces the last blocks by as many; it can drop a not-yet-final close or
  funding, and the replacement blocks can be chosen to hold or not hold them, but a reorg that re-opens a past height
  below `D` for a late claim (Bob's benefit) is not represented. It cannot make Alice or Bob lose.
- **A cancelled Ethereum lock is final.** After a reorg removes Bob's lock he does not lock again.
- **No collusion with block producers.** Timestamps are exact; the few seconds of skew are inside `Delta_detect`.
- **Honest parties share the tick clock and act within a bounded reaction** (`RA`, `RD`, `PA`, `Delta_detect`); an
  honest party that is slower than its bound is outside the model (the sweeps show where the bounds break).
- **Version boundary (I5), v2.1 activation, the opening backup (T15), the stock-wallet variant, ERC-20, receivers
  that reject ETH (T11)** are outside.
- **Sampling.** Arbitrary Bob's windows in the two scaled runs are a boundary-value sample, and Bob cannot crash there.
  Both are exact in the toy run. The scaled sets are structured scalings of one design, not the design: the real
  production state space (728 blocks, 360-tick windows) is far too large to enumerate here, and the relations
  in section 3 are the bridge.
- **The model is mine.** It encodes my reading of the design; a different reading of "Bob learns the secret within
  `Delta_detect`" or of how fast a dropped close is noticed moves the exact thresholds above (not the structure).
  Review it before relying on it.
