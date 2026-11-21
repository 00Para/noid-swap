# Miner concentration on Parano1d and threat T21

Status: measured and modelled 2026-11-08, corrected the same day after an independent review (tie rule, percent formatting, lead cap, preparation before the swap, re-send delay). Model: `docs/formal/t21_race.py`; tests: `docs/formal/t21_race_test.py`; full result tables: `docs/formal/t21_results.md` and `docs/formal/t21_results.csv`. Nothing here touches a chain or a key. The model was reviewed independently twice on 2026-11-08: the first review found the points above; the second re-checked the corrected figures against a separate implementation (15 further points agree to four decimals) and the gate threshold. Not covered by any review: the repeated game with ASERT and timestamp manipulation.

## Bottom line

- **One address mined 53 % of the last 24 hours of blocks, and between 45 % and 63 % of every day for the last 20 days.** Before that no address had more than about 31 % of a day. The data comes from the node's own block headers.
- **If that party (or a partner) is Alice, the swap is not safe, and a longer window does not fix it. The victim is Bob** (the Ethereum side): Alice reveals the secret on Ethereum and claims the ETH, then keeps Bob's NOID claim from becoming final until the deadline `D`, and takes the NOID back as well.
- **The clean-start figure for a share of 53 % (55 % at the production window of 361 blocks, 60 % at the sepolia profile's 132 blocks) is a lower bound, not her best play.** A majority miner can prepare before the swap at no cost: her private lead grows on average, so she can start with a reserve. With a reserve of 20 blocks the chance is **90 % (production) and 97 % (sepolia)**, with 40 blocks 99 % and 100 %, with 80 blocks 100 %. Waiting inside the real swap timeline alone gives 92 % and 91 %. **For a share above 50 % the realistic figure is about 100 %.**
- **Ties matter and the first version of this model understated them.** Two blocks on one parent have equal work, the smaller hash wins, and she sees both hashes before publishing, so an equal-length chain costs her nothing when it would lose. Counting that (a "free tie"): at a share of 45 % the chance is 0.29 % (production) and 9.2 % (sepolia), against 0.032 % and 2.8 % without ties; at 50 % it is 28.5 % and 49.6 % (against 14.1 % and 30.3 %). If every tie she publishes wins (an upper bound) the figures are 2.9 %, 24.8 %, 51.2 %, 69.9 %.
- **The window length protects only against a minority.** Under 1 % at the production window needs a share of at most 0.47 (strict ties), 0.45 (free ties); under 0.1 %: 0.45 and 0.44. For the sepolia profile the limits are 0.42 / 0.40 (1 %) and 0.40 / 0.35 (0.1 %). With a head start of 10 blocks they fall by one to two grid steps. At 0.50 a window of about 1,900 blocks (16 hours) is needed for 1 % even with strict ties, and with free ties more than 2,500; above 0.50 no window gets under 1 %.
- **Bob's re-send delay is not a constant 2 blocks.** A person running the re-send by hand can take 10 to 20 blocks; at a share of 0.45 and the production window that turns 0.03 % into 3.6 % (10 blocks) and 15 % (20 blocks); at 0.40 into 0.027 % and 1.2 %.
- **What an honest-side change can still do:** a Bob-side check before locking (refuse when one address mined more than a stated share of the recent blocks; feasible from Bob's own node, built 2026-11-08 in `swap-cli` (`docs/bob-concentration-gate.md`); a screen, not a defence; the model puts the limit at about 35 % for the production profile after a margin for measurement error and drift, Section 5; design: `docs/bob-concentration-gate.md`), small amounts, and a faster re-send. A longer window costs Alice 0.5 minute of worst-case NOID lockup per block and does not change Bob's free option; it is useful only against a share up to about 0.45 to 0.47.
- **The reorg depths actually seen are small (at most 3 on the node that kept logs; most are 1).** This does not tell that a majority miner cannot do more: she has had no reason to.

## 1. What was measured

**Source.** Not an explorer: the node's own block headers. Every Parano1d header carries the miner's address (the recipient of the block reward, `miner_address` in the header, returned as `miner` by the node's `paranoid_getBlockHeader`). The headers were read from a local node through that call, for the last 25 "days" of 2,880 blocks each (a day is 2,880 consecutive blocks, about 24 hours at the measured 30.3 s per block; day 0 ends at the tip at the time of measurement, height 291,914, 2026-11-08 UTC). A public explorer's figures (24 hours 52.8 %, 7 days 49.3 %) agree; the node's headers are the source a Bob-side check would have to use.

**Last 24 hours (2,857 blocks, 10 distinct addresses).** Largest address 52.7 %; next 18.8 %, 14.4 %, 4.8 %, 3.3 %, 2.7 %. The largest two together 71.5 %, the largest three together 85.9 %.

**Per day** (share of the day's blocks of the largest address, of the largest two together, number of distinct addresses; day 0 is the latest):

| day | top 1 % | top 2 % | distinct | day | top 1 % | top 2 % | distinct |
|---|---|---|---|---|---|---|---|
| -25 | 30.2 | 53.8 | 10 | -12 | 52.8 | 66.4 | 10 |
| -24 | 30.7 | 52.6 | 10 | -11 | 52.6 | 66.4 | 11 |
| -23 | 26.5 | 45.4 | 12 | -10 | 55.1 | 68.2 | 10 |
| -22 | 29.6 | 52.7 | 14 | -9 | 60.1 | 73.0 | 11 |
| -21 | 26.1 | 45.2 | 12 | -8 | 52.3 | 67.2 | 13 |
| -20 | 53.8 | 68.8 | 17 | -7 | 48.2 | 65.9 | 10 |
| -19 | 63.3 | 75.7 | 13 | -6 | 50.2 | 65.7 | 10 |
| -18 | 59.1 | 73.8 | 15 | -5 | 48.2 | 64.2 | 11 |
| -17 | 56.1 | 70.3 | 12 | -4 | 45.0 | 59.5 | 12 |
| -16 | 54.3 | 68.9 | 11 | -3 | 48.3 | 62.6 | 12 |
| -15 | 54.3 | 68.6 | 12 | -2 | 49.4 | 63.8 | 10 |
| -14 | 57.7 | 71.2 | 11 | -1 | 51.5 | 69.7 | 10 |
| -13 | 54.3 | 68.4 | 10 | 0 | 52.7 | 71.6 | 10 |

The address that is the largest today first appears during day -21 (day buckets start at height 217,035; the day -21 bucket is about heights 228,555 to 231,435) and has held between 45 % and 63 % of every day since: a sustained half of the blocks, not a spike. Before day -21 no address had more than about 31 % of a day.

**Reorgs seen** (a reorg is the node replacing its newest blocks with a competing branch; an orphan is a block that lost such a race):
- The logs of an always-on node (6 files, reorg lines at heights 235,872 to 279,277, from 2026-10-20 to 2026-11-04): 270 reorgs, of depth 1: 253, depth 2: 12, depth 3: 5. The deepest was 3 (at height 238,267).
- The log of a wallet application's node (heights 203,849 to 291,887, up to 2026-11-08): 75 reorgs, all of depth 1.
- A public explorer's list of the latest 100 orphans (heights 285,097 to 291,709): all of depth 1.

**What this shows.** One address has held about half of the blocks for 20 days, and no reorg deeper than 3 was seen by these nodes in that time.

**What it does not show.**
- A miner address is only the recipient of the block reward. An operator can use several addresses, so a measured share is a lower bound for that operator. A pool pays to one address.
- The block template call accepts any valid address as the miner address for an external worker, so the field says where the reward goes, not who did the work.
- It does not say that the party is Alice, or is willing to attack: it has no reason to reorg today (no victim, no value at stake), so "never happened" is not "cannot happen".
- Logs rotate (the oldest file starts on 2026-10-20), and a node that was offline or on another branch may have seen deeper reorgs.
- A day is a block count, not a calendar day, and the hashrate behind a share can change within hours.

## 2. The model

**Terms, in half a sentence each.** *Hashrate share* `q`: the fraction of all mining power one party holds, which is also the chance that the next block is hers. *Private fork*: blocks she mines and keeps secret, building on an older block, instead of on the public tip. *Reorg*: the network switching to a competing branch that has more total work; the blocks of the losing branch become *orphans*. *Depth cap*: a node refuses a reorg that would replace more than 18 blocks above its finalized checkpoint, so a block with 18 more blocks on top (19 counting itself) can no longer be replaced. *ASERT*: the rule that sets the mining difficulty from the timestamps of the branch itself (half-life 6 blocks, 180 s at 30 s per block), so two competing branches soon have different difficulty. *Lead*: her private blocks minus the public blocks above her fork base.

**The game.** Alice reveals the secret on Ethereum. Bob's NOID claim has to be mined on Parano1d at a height below `D` and then needs 18 more blocks on top (is *final*). If it is not final when the public chain reaches `D - 1`, Alice's refund opens at `D`, and she holds both legs. Alice mines a share `q` of the blocks. She mines a private fork; whenever it is strictly longer than the public chain and branches off at most 18 public blocks below the tip, she may publish it, and the public chain becomes hers. If Bob's claim was in the replaced blocks it is gone. The chain does not put orphaned transactions back into the mempool, so Bob's tool must notice and send the claim again, which takes `rho` block events. Honest miners include the claim in the first block they mine after it is broadcast, as long as the block height is below `D`. The claim is never in a block she mines. She chooses what to do before every block (mine on, throw the fork away and start again from the tip, publish any number of blocks that makes her fork strictly heavier, which also moves the public tip forward and so brings `D` closer, or, under the tie rules below, publish an equal-length chain). `r` is the number of blocks left until the public tip reaches `D`. The model computes the **exact optimum** of her play by backward induction on `r` (the value of a state depends only on states with fewer blocks left, plus one same-layer step for ties), over the state (claim status, private blocks `a`, public blocks `d` above her fork base), for the span `S` = `r` at the reveal.

**Claim status.** *Not yet sent*: Bob needs `n_delay` block events after the reveal to see the secret and prove (production: (300 s detection + 20 s proving) / 30.3 s = 11; sepolia: (120 + 20) / 30.3 = 5; planning figures at 20 s per block: 16 and 7). *Sent, not mined*. *In the chain with `k` blocks counting the claim block*: `k = 19` is final and Bob wins. After a reorg removes the claim: *not yet sent* for `rho` events (base case 2; the table of Section 3.5 runs 0 to 20).

**Rules taken from the vendored node** (checked in the source, not assumed):
- A block at height `h` is final when the tip is at least `h + 18`; a fork can replace at most 18 blocks above the finalized checkpoint. So a fork whose base is `d` public blocks below the tip works only while `d <= 18`; when an honest block makes `d = 19` the fork is dead (if the claim is in the chain it can no longer be removed, so Bob wins; if not, she must start a new fork from the tip and her private blocks are lost).
- Fork choice is by cumulative work. A block's target depends only on its parent, so two blocks on the same parent have exactly equal work; at equal total work the branch with the smaller tip hash wins. She sees both hashes before she publishes, so a tie that would lose costs her nothing: she does not publish it and her fork survives. Three tie rules are computed: **strict** (she never publishes an equal-length chain; a lower bound), **free** (at equal length she publishes a tie that wins with probability 1/2, independently each time; the best estimate), **always** (every tie she publishes wins; an upper bound that also covers any influence of timestamps on work at equal block counts).
- A reorg does not return the orphaned transactions to the mempool (`readmit_after_reorg` only logs them). The re-send delay `rho` therefore exists, and it is the one lever Bob's tool has.
- ASERT difficulty: the main model counts blocks (equal difficulty on both branches). Section 7 checks the size of the error with a work race that follows the real rule.
- Heights: the claim is valid at height `<= D - 1`, her refund from `D`.

**Assumptions and what is not covered.**
- One attacker, one fork at a time; equal difficulty on both branches (checked only for a single attempt, Section 7).
- Network latency is ignored: a published fork is adopted by everyone at once, and Bob's claim reaches every miner at once.
- Every other miner is honest, follows the heaviest chain and includes the claim at the first chance; the claim is kept out only by Alice's own blocks (a second censoring party is not modelled).
- **`rho` is not constant.** The base case is 2 block events. Bob's tool re-sends within one tick (30 s) of noticing a removal, in the same tick as the new proof; but the rotation guard (the last 4 blocks before each 144-block epoch boundary) makes it wait (about 5 to 6 events if the removal lands there), a pending close by Alice herself makes it wait (threat T2), and the re-submission is a spending step an operator runs by hand (no unattended Bob exists), which can take minutes, i.e. many blocks. A larger `rho` favours the attacker (Section 3.5 gives 4, 6, 10, 20). The epoch anchor (a deep reorg across a boundary forces a new proof) is covered only through `rho`.
- The effect of a deep reorg on Bob's other checks (funding final, lock) is not modelled; the swap states are not modelled at all beyond the span `S`.
- The hashrate share is constant during the swap (a party can rent or move hashrate; not modelled).
- Time is measured in block events (hers and honest ones); `S` converts to hours at 30.3 s per block (Section 4).
- **The private-lead cap `A_MAX`** (she cannot hold more than `A_MAX` private blocks) lowers her value. The main grid uses 160; Section 3.6 shows that 80 understates a share of 0.53 at a span of 3,000 (48.0 % against 49.4 %) and 40 understates it badly (21.9 %); spans up to 800 are identical at 80 and 160.

## 3. Results

Spans: `S` is the number of Parano1d blocks between Alice's reveal and `D`. At the latest reveal the design guarantees `S = 361` blocks (production) and `S = 132` (sepolia profile) when blocks come every 20 s (the planning rate), and the spans become 453 and 173 at the measured 30.3 s per block (`swap-cli/src/params.rs`: `RHS(I1)` minus the reveal window). They are marked `*`. Numbers are percentages; values are for a clean start and `rho = 2` unless stated. The full grid (17 spans, 18 shares, both profiles, three tie rules, six starting cases) is in `docs/formal/t21_results.md` and `.csv`; a number printed as `<0.0001` is below 0.0001 %.

### 3.1 Chance that the attack works, by share, tie rule and span (clean start)

Production profile (`n_delay` 11):

| q | strict, 361* | free, 361* | always, 361* | strict, 453* | free, 453* |
|---|---|---|---|---|---|
| 0.30 | 0 | 0 | 0 | 0 | 0 |
| 0.40 | 0 | <0.0001 | 0.0068 | 0 | <0.0001 |
| 0.45 | 0.0324 | 0.29 | 2.94 | 0.0058 | 0.0723 |
| 0.50 | 14.1 | 28.5 | 51.2 | 11.0 | 23.4 |
| 0.53 | 54.8 | 71.7 | 85.9 | 53.4 | 70.5 |
| 0.55 | 77.7 | 88.1 | n/c | 77.6 | 88.0 |
| 0.60 | 97.2 | 98.7 | 99.6 | 97.2 | 98.7 |
| 0.715 | 100 | 100 | n/c | 100 | 100 |
| 0.859 | 100 | 100 | n/c | 100 | 100 |

Sepolia profile (`n_delay` 5; the Parano1d side is the same mainnet):

| q | strict, 132* | free, 132* | always, 132* | strict, 173* | free, 173* |
|---|---|---|---|---|---|
| 0.30 | 0 | <0.0001 | 0.0007 | 0 | 0 |
| 0.40 | 0.0382 | 0.35 | 2.84 | 0.0038 | 0.0620 |
| 0.45 | 2.79 | 9.21 | 24.8 | 1.13 | 4.78 |
| 0.50 | 30.3 | 49.6 | 69.9 | 24.8 | 43.4 |
| 0.53 | 60.2 | 76.4 | 88.4 | 57.3 | 74.3 |
| 0.55 | 76.8 | 87.8 | n/c | 75.8 | 87.2 |
| 0.60 | 95.9 | 98.2 | 99.3 | 95.9 | 98.2 |
| 0.715 | 100 | 100 | n/c | 100 | 100 |
| 0.859 | 100 | 100 | n/c | 100 | 100 |

(`n/c` = not computed; the "always" rule was computed for six shares.) The strict and free columns at 45 % and 50 % agree with an independent implementation written for the review (strict 0.032 %, free 0.29 %, always 2.9 % at 0.45 in production; 14.1 %, 28.5 %, 51.2 % at 0.50; sepolia 0.40: 0.038 %, 0.35 %, 2.8 %; 0.45: 2.79 %, 9.2 %, 24.8 %; 0.50: 30.3 %, 49.6 %, 69.9 %). **The strict rule is a lower bound; the free rule is the best estimate; always is an upper bound.**

Reading. For shares up to 0.45 the chance falls fast with the span: by a factor of 10 or more per 100 blocks, and faster the longer the window. At `q = 0.50` it falls slowly and without a sharp edge (strict: 14 % at 361, 5.2 % at 800, 0.9 % at 2,000). Above 0.50 it stops falling: the attacker's private lead tends to grow, so once she has a reserve she can spend one block of it per attempt for as long as she likes, and the chance settles on a plateau (Section 4).

### 3.2 One attempt: "any moment" versus "at the end"

One claim block has just been mined; no deadline; depth cap 18; strict ties. The attacker has `a0` private blocks mined before the claim block (none, or the number a miner of share `q` would have by chance, `P(a0 = j) = q^j (1 - q)`).

| q | any moment, no earlier private block | at the end, no earlier private block | any moment, with head start | at the end, with head start | any moment, with head start, no depth cap |
|---|---|---|---|---|---|
| 0.30 | 18.3 | 0.36 | 30.8 | 0.53 | 30.9 |
| 0.40 | 42.2 | 8.26 | 57.0 | 10.8 | 58.7 |
| 0.45 | 58.3 | 22.0 | 71.3 | 27.0 | 77.3 |
| 0.50 | 74.3 | 43.4 | 83.8 | 50.0 | 100 |
| 0.53 | 82.5 | 57.8 | 89.6 | 64.3 | 100 |
| 0.60 | 95.0 | 85.4 | 97.5 | 89.2 | 100 |
| 0.715 | 99.9 | 99.5 | 99.9 | 99.7 | 100 |
| 0.859 | 100 | 100 | 100 | 100 | 100 |

**Why "any moment" is the right criterion for one reorg, and why the whole attack is a different game.**
- Nodes adopt a heavier chain the instant it is published, so a single reorg of the claim block succeeds if her fork is strictly ahead at any moment while it is still within the 18-block reach; being ahead only "at the end" is one of the ways to get there, and "at the end" understates her (50 % at `q = 0.5` against 84 %).
- The classical catch-up formula (`(q/p)^(z+1)` for a deficit of `z` blocks, `p = 1 - q`) counts the same quantity without the depth cap and gives 1 for `q >= 0.5`; the cap is what keeps a single attempt below 100 % at `q >= 0.5`.
- The whole attack is repeated and bounded by the deadline: after each failure that does not end the game she can try again, her private lead can carry over, Bob needs `rho` events to re-send, and Bob wins the moment one claim block gets 18 blocks on top, so the chance is a race between her getting ahead every time it matters and the `S` blocks running out, not one coin flip.

Both groups of columns are for ONE reorg of the claim block. The first column is the figure with no private block mined before the claim block (74.3 % at `q = 0.50`, the usual "about three in four"); the third includes the head start a miner of share `q` has by chance (83.8 %). The whole attack at `q = 0.50` and the production window is 14.1 % (strict ties), far below both, because one reorg only delays Bob (he sends the claim again) and she has to repeat it until `D`.

### 3.3 Optimal play against the simple policy

The simple policy publishes the moment she is strictly ahead and never keeps a lead (it re-bases after every publish). The optimal policy keeps a reserve and publishes just enough. Strict ties, clean start.

| profile, S | q | optimal | simple |
|---|---|---|---|
| production, 361 | 0.50 | 14.1 | <0.0001 |
| production, 361 | 0.53 | 54.8 | 0.0026 |
| production, 361 | 0.60 | 97.2 | 4.96 |
| production, 361 | 0.715 | 100 | 91.6 |
| sepolia, 132 | 0.50 | 30.3 | 0.27 |
| sepolia, 132 | 0.53 | 60.2 | 2.05 |
| sepolia, 132 | 0.60 | 95.9 | 33.2 |
| sepolia, 132 | 0.715 | 100 | 96.9 |

The simple policy loses its lead on every publish and has to win a fresh race each time, so it fails after a few cycles; the reserve of the optimal policy is what makes the plateau. Any estimate that assumes the simple policy is far too low.

### 3.4 Preparation, patience and the realistic case

Her lead (private blocks minus the public blocks above her fork base) is a random walk. She can keep her fork fresh without losing the reserve by publishing just enough (`d + 1` blocks) whenever the public chain is 18 blocks past her base, which costs one block of lead per cycle of about 18 honest blocks. **For `q > 0.5` the lead grows on average by about `2q - 1` per event, so it outgrows that cost: she can build any reserve before the swap at no cost, and start the swap with it.** For `q < 0.5` the lead drifts down; a large lead is a rare excursion whose frequency is of the order `(q/p)^L` (about 13 % of the time for `L = 10` and 1.8 % for `L = 20` at `q = 0.45`; 1.7 % and 0.03 % at `q = 0.40`), so a patient attacker who waits for one before she starts the swap gains in proportion to that, not unboundedly.

Three kinds of start are computed. *Lead L0*: she starts with `a = L0`, `d = 0` (L0 = 10, 20, 40, 80). *Wait*: optimal stopping, she may delay the reveal for the real swap timeline: from creation to Bob's lock-by height (`D_offset - RHS(I1)`: 107 blocks production, 50 sepolia) plus Alice's reveal window (`(W_A - M_A)` over the planning block time: 5,400 s over 20 s = 270 blocks production, 2,400 s over 20 s = 120 sepolia), which is **377 public blocks (production) and 170 (sepolia)**; at the reveal she must have revealed by the latest allowed point `S`. (Counting in events of both kinds instead of public blocks would shorten these; the choice favours her.) *Unbounded patience* is not computed (see above).

Production, `S = 361`:

| q | clean | lead 10 | lead 20 | lead 40 | lead 80 | wait | free: clean | free: lead 10 | free: lead 20 | free: wait |
|---|---|---|---|---|---|---|---|---|---|---|
| 0.45 | 0.0324 | 0.12 | 0.51 | 4.60 | 53.3 | 0.0566 | 0.29 | 0.62 | 1.60 | 0.37 |
| 0.50 | 14.1 | 27.4 | 46.3 | 79.3 | 99.5 | 33.2 | 28.5 | 41.4 | 58.3 | 45.9 |
| 0.53 | 54.8 | 76.2 | 90.3 | 98.9 | 100 | 92.5 | 71.7 | 85.3 | 94.1 | 95.4 |
| 0.60 | 97.2 | 99.8 | 100 | 100 | 100 | 100 | 98.7 | 99.9 | 100 | 100 |

Sepolia, `S = 132`:

| q | clean | lead 10 | lead 20 | lead 40 | lead 80 | wait | free: clean | free: lead 10 | free: lead 20 | free: wait |
|---|---|---|---|---|---|---|---|---|---|---|
| 0.40 | 0.0382 | 0.32 | 2.33 | 33.3 | 99.9 | 0.0529 | 0.35 | 1.27 | 5.10 | 0.41 |
| 0.45 | 2.79 | 11.0 | 31.5 | 85.1 | 100 | 4.76 | 9.21 | 20.6 | 42.5 | 12.0 |
| 0.50 | 30.3 | 59.5 | 84.2 | 99.4 | 100 | 55.4 | 49.6 | 72.0 | 89.5 | 68.5 |
| 0.53 | 60.2 | 86.3 | 97.0 | 100 | 100 | 90.8 | 76.4 | 92.0 | 98.3 | 94.6 |

**Which case is the realistic one.**
- **`q > 0.5` (the measured case): the prepared attacker.** The clean-start figure (55 % and 60 % at 0.53) is a lower bound. With a reserve of 20 blocks it is 90 % and 97 %, and the swap timeline alone (wait) already gives 92 % and 91 %; a reserve of 40 gives 99 % to 100 %. The realistic figure is about 100 %.
- **`q` between 0.45 and 0.50:** the free-tie wait column: 0.37 % to 12 % at 0.45 and 46 % to 69 % at 0.50 (production and sepolia). A lead of 10 to 20 is possible by chance but not free.
- **`q <= 0.40`:** clean start with free ties (under 0.4 % in both profiles at 0.40); lead 20 reaches 5 % at 0.40 only for the sepolia profile, and only if she happens to hold that lead at the start (about 0.03 % of the time).

### 3.5 Effect of Bob's re-send delay and first broadcast

Re-send delay `rho` (block events after a removal until the claim is back); strict ties; `rho = 2` is the base case. Bob's tool re-sends within one tick, but a human running the step by hand, the rotation guard and a pending close by Alice make larger values real.

Production, `S = 361`:

| q | start | rho 0 | 2 | 4 | 6 | 10 | 20 |
|---|---|---|---|---|---|---|---|
| 0.40 | clean | 0 | 0 | <0.0001 | 0.0007 | 0.0269 | 1.16 |
| 0.40 | lead 10 | 0 | <0.0001 | <0.0001 | 0.0016 | 0.0501 | 1.76 |
| 0.45 | clean | 0.0144 | 0.0324 | 0.20 | 0.78 | 3.56 | 15.0 |
| 0.45 | lead 10 | 0.0687 | 0.12 | 0.49 | 1.47 | 5.44 | 19.6 |
| 0.53 | clean | 47.0 | 54.8 | 66.9 | 75.0 | 83.2 | 90.0 |
| 0.53 | lead 10 | 71.2 | 76.2 | 83.2 | 87.7 | 92.1 | 95.8 |

Sepolia, `S = 132`:

| q | start | rho 0 | 2 | 4 | 6 | 10 | 20 |
|---|---|---|---|---|---|---|---|
| 0.40 | clean | 0.0099 | 0.0382 | 0.32 | 1.16 | 4.63 | 18.4 |
| 0.40 | lead 10 | 0.13 | 0.32 | 1.31 | 3.38 | 10.0 | 31.0 |
| 0.45 | clean | 1.45 | 2.79 | 7.79 | 14.2 | 26.3 | 46.4 |
| 0.45 | lead 10 | 7.36 | 11.0 | 19.6 | 28.5 | 42.9 | 63.9 |
| 0.53 | clean | 51.9 | 60.2 | 72.1 | 79.0 | 85.6 | 90.9 |
| 0.53 | lead 10 | 82.0 | 86.3 | 91.1 | 93.7 | 96.1 | 98.0 |

**`rho` for a human Bob can be much larger than 2, and that favours the attacker:** at `rho = 10` (about 5 minutes) the production window at 0.45 gives 3.6 % (clean) and 5.4 % (lead 10); at `rho = 20` 15 % and 20 %. Even at 0.40 the chance is 1.2 % to 1.8 % at `rho = 20`.

Bob's first broadcast later (planning rate: 16 events in production instead of 11), strict ties: at `q = 0.50`, `S = 361`: 15.1 % against 14.1 %; at `q = 0.53`: 57.0 % against 54.8 %; sepolia `q = 0.45`, `S = 132`: 3.01 % against 2.79 %. Faster detection helps by a few points and does not change the picture.

### 3.6 Depth cap and lead cap

Depth cap `F` (production, `S = 361`, clean start, strict ties; 18 is the chain's rule, larger is hypothetical):

| q | F = 6 | F = 12 | F = 18 | F = 36 |
|---|---|---|---|---|
| 0.50 | 1.18 | 7.82 | 14.1 | 26.5 |
| 0.53 | 16.1 | 41.8 | 54.8 | 72.2 |

The cap of 18 is a large part of the protection of a minority; it is fixed by the chain. At `q = 0.50` six blocks less of cap change the result by 6 points, six blocks more of window by about 0.2.

Cap on the private lead `A_MAX` (production, clean start, strict ties; percent):

| q | A_MAX | S = 361 | S = 1000 | S = 3000 |
|---|---|---|---|---|
| 0.50 | 40 | 13.7189 | 1.9602 | 0.0048 |
| 0.50 | 80 | 14.1210 | 3.6067 | 0.1651 |
| 0.50 | 160 | 14.1210 | 3.6267 | 0.2662 |
| 0.50 | 240 | 14.1210 | 3.6267 | 0.2665 |
| 0.53 | 40 | 54.3345 | 43.2957 | 21.8660 |
| 0.53 | 80 | 54.7930 | 50.3712 | 48.0372 |
| 0.53 | 160 | 54.7930 | 50.3998 | 49.3958 |
| 0.53 | 240 | 54.7930 | 50.3998 | 49.3963 |

The first version of the grid used `A_MAX = 80`, which is identical to 160 up to a span of about 800 but understates long spans (48.0 % against 49.4 % at 0.53, `S = 3,000`). The grid now uses 160 (120 for the long-span runs at shares up to 0.50; 120 and 160 agree to four digits at 800 blocks for 0.45 and 0.50).

### 3.7 Checks of the model

- **Rule check by enumeration.** The exact solution equals an exhaustive expectimax over event sequences for tiny instances (finality depth 1 to 3, private-lead cap 3 to 5, several `rho` and `n_delay`), values agreeing to within the undecided probability mass (under 1e-3 in the worst case, mostly far smaller); this holds for the strict rule, for the free and always tie rules (both ways of modelling whether the coin is seen before choosing), for states with public blocks above the fork base, and for the optimal stopping values.
- **Limits.** `q = 0` gives 0 (and 1 when `S < n_delay + 2`, because Bob's first broadcast alone then comes too late); `q = 1` gives 1.
- **Closed forms.** The classical catch-up probability `(q/p)^(z+1)` is reproduced to nine digits with a cap of 400; at `q = 1/2` the reflection identity (`P(max of n steps >= 1) = P(S_n >= 1) + P(S_n >= 2)`) holds for `n` up to 60.
- **Monotone** in `q` (up), in `S` (down), in `A_MAX` (not down), in `rho` (not down), in the head start (not down), and in the tie rule (strict, free, always: not down); the simple policy never beats the optimal one.
- **Monte Carlo of the optimal policy** (200,000 runs per point, seed 20261108; the policy, including whether to take a tie, is read from the exact solution): the exact value lies inside the 99 % interval at all six points tried, among them four free-tie points (production 0.45 and 0.50, sepolia 0.45 and 0.50) and a lead-20 start; e.g. production free `q = 0.50`, `S = 361`: exact 28.46 %, simulated 28.44 % [28.18, 28.70]; strict `q = 0.53`, lead 20: 90.32 % against 90.39 % [90.21, 90.55]. The unit tests add three more tie-rule points.
- **Percent formatting.** The first version of the tables printed values below 0.0005 as a fraction while the heading said percent (so "3.2e-04" meant 0.032 %). Fixed; a unit test pins it.

## 4. Answers

### 4.1 How fast the attack's success falls with the span, per share

Smallest span `S` (blocks between the reveal and `D`) with a chance under 1 %, clean start, `rho = 2`; production / sepolia profile. The span is the same quantity in blocks for both profiles; they differ only in Bob's detection delay.

| share | strict ties | free ties | behaviour |
|---|---|---|---|
| 0.30 | 36 / 30 | 44 / 38 | gone within 50 blocks |
| 0.35 | 50 / 44 | 65 / 59 | |
| 0.40 | 82 / 76 | 114 / 108 | strict: 11.8 % at 41 blocks, 0.34 % at 100, 0.0012 % at 200 |
| 0.45 | 189 / 179 | 281 / 274 | strict: 34 % at 41, 7.2 % at 100, 0.78 % at 200, 0.032 % at 361; free: 17.6 % at 100, 3.5 % at 200, 0.29 % at 361 |
| 0.46 | 243 / 232 | 366 / 357 | |
| 0.47 | 331 / 316 | 500 / 489 | |
| 0.48 | 488 / 467 | 739 / n.r. | |
| 0.49 | 829 / n.r. | n.r. / n.r. | |
| 0.50 | 1,884 / 1,800 | n.r. / n.r. | strict: 41 % at 100, 24 % at 200, 14 % at 361, 5.2 % at 800, 0.9 % at 2,000, 0.46 % at 2,500; free: 28.5 % at 361, 12.6 % at 800, 1.4 % at 2,500 |
| 0.53 | never | never | strict plateau 49.4 % (production), 46.3 % (sepolia); free: 68.2 % at 800 and still falling slowly |
| 0.55 | never | never | plateau 77.4 % / 73.9 % (strict), 87.9 % (free, production) |
| 0.60 | never | never | plateau 97.2 % / 95.9 % (strict), 98.7 % (free, production) |
| 0.715, 0.859 | never | never | 100 % at every span |

("Never" = not reached within the computed range, where the curves are flat to three digits. "n.r." = not reached within the computed range: 830 blocks (production) and 600 (sepolia) for shares up to 0.35 and 0.42 to 0.49 on the main grid, 2,500 blocks for 0.40, 0.45 and 0.50 in the long runs. The same table for 0.1 % is in `t21_results.md`.) At 30.3 s per block, 189 blocks are 1.6 hours and 1,884 blocks are 15.9 hours.

**For the design-guaranteed spans.** Production (361 blocks) is under 1 % for a share up to 0.47 with strict ties and 0.45 with free ties; under 0.1 % up to 0.45 and 0.44. Sepolia profile (132 blocks): under 1 % up to 0.42 (strict) and 0.40 (free); under 0.1 % up to 0.40 and 0.35. Preparation moves this down (Section 5 gives the table of limits for lead 10 and for waiting). At 0.53, with the clean start, the figures are 54.8 % and 60.2 % (strict) and 71.7 % and 76.4 % (free); with a prepared reserve of 20 blocks 90.3 % and 97.0 %.

**For the share measured today.** The largest address held 52.7 % of the last 24 hours. If that party is Alice (or is working with her) the realistic chance is about 100 % (Section 3.4: a prepared majority attacker); the clean-start figures of 55 % and 60 % are a lower bound. If the largest two addresses were one party (71.5 %), or the largest three (85.9 %), the swap is lost for certain.

**Who can attack, who loses.** Only the party that holds the NOID and the hashrate can attack: Alice. The victim is Bob, the ETH side: Alice has claimed his ETH with the secret and he does not get the NOID (she takes it back at `D`). A miner who is Bob has no comparable gain from reorgs: a claim included at or after `D` is invalid whatever he mines. (A Bob who mines most blocks and tries to hold back Alice's refund is a different attack and was not modelled.)

### 4.2 What each lever costs

Cost is stated in minutes of Alice's worst-case NOID lockup (the abort case, where she recovers at `D`; `D_offset` is 738 blocks, about 6.2 hours at 30 s per block) and in effect on Bob's free option (design threat T13).

| lever | effect on the attack | cost |
|---|---|---|
| Lengthen the post-reveal budget `B_post` (the blocks between the reveal and `D`: `B_epoch`, `B_fee`, `B_final`, `B_safety`) by `L` blocks | at 0.45 and below it removes the attack quickly; to cover a share of 0.47 with free ties at the 1 % level needs 500 blocks (139 more than now); at 0.50 about 1,900 more with strict ties and more than 2,100 with free ties; above 0.50 it does nothing useful | 0.5 minute of worst-case lockup per block, one-for-one: `RHS(I1)` and `D_offset` grow together. For 0.50 with strict ties: `+1,523` blocks, `D_offset` 738 to about 2,260 (6.2 to 18.8 hours). The Bitcoin pairing already has `D_offset` 2,050. **No effect on Bob's free option:** his lock-by height stays `H_create + 107` (design 9.1), and T13's options depend on `B_bob` (60 blocks) and `W_A`, not on `D` |
| Faster re-send (`rho` toward 0, and no operator step in the loop) | the cheapest lever: at 0.45 (production, 361) `rho` 20 gives 15 %, 10 gives 3.6 %, 2 gives 0.032 %, 0 gives 0.014 %; at 0.53 47.0 % at `rho` 0 against 54.8 % at 2 | an engineering change; today the re-submission is a spending step the operator runs (no unattended Bob exists), which is why `rho` 10 to 20 is realistic. Whether a stored claim stays valid across a reorg inside its epoch was not checked here |
| Shorten Bob's detection `Delta_detect` (300 s) | 5 fewer events before the first broadcast: about 1 point at 0.50 (15.1 % to 14.1 % between 16 and 11 events) | more polling; the 300 s already includes a margin |
| Shorten Alice's reveal window `W_A` (7,200 s) | shortens the timeline she can wait in (377 blocks production, 170 sepolia); at 0.50 production, 361 blocks: wait gives 33.2 % against 14.1 % clean (strict) | Alice's own free option shrinks too; `W_A_min - M_A` must still cover Ethereum finality plus detection. She can also prepare before creating the swap, so this does not close the case |
| Depth cap 18 | the single biggest factor (Section 3.6) | fixed by the chain |
| A Bob-side concentration check (Section 5) | Bob locks nothing when it refuses; it does not see a hidden or new producer; does not change the model | a swap is refused while one address mines more than the threshold; as of the measurement every swap would be refused |

## 5. What the node exposes, and a Bob-side gate (built 2026-11-08)

**What can be read.** `paranoid_getChainInfo` gives the tip; `paranoid_getBlockHeader(height)` gives the header of any height tried (3,000, 100 blocks back, 230,000), including `miner`, the coinbase recipient. A script took about 75 ms per call over HTTP; 2,857 headers took under a second with six calls in parallel on the local node. So Bob's own node can supply "who mined the last `N` blocks" at the moment of locking, with no third party.

**The gate.** Before Bob locks, read the last `N` headers and refuse (no lock, nothing sent) if one address mined more than `X` % of them. **It is a screen, not a defence:** it stops a swap against a producer that is visibly large and nothing else (the limits are listed below). The design for review, with the data source, the cache, the rule, the override flag, the texts and the tests, is `docs/bob-concentration-gate.md`.

**Where `X` comes from.** The limit is the largest share at which the model keeps the attack under a chosen level at the guaranteed span; the threshold is that limit minus the error of the measurement minus an allowance for drift. From the grid (`t21_results.md`, section 3), largest grid share with a chance under 0.1 % and under 1 %, at the guaranteed span (production 361, sepolia 132):

| profile | case | strict: 1 % / 0.1 % | free: 1 % / 0.1 % |
|---|---|---|---|
| production | clean | 0.47 / 0.45 | 0.45 / 0.44 |
| production | lead 10 | 0.46 / 0.44 | 0.45 / 0.42 |
| production | wait (377 blocks) | 0.46 / 0.45 | 0.45 / 0.44 |
| sepolia | clean | 0.42 / 0.40 | 0.40 / 0.35 |
| sepolia | lead 10 | 0.40 / 0.35 | 0.35 / 0.35 |
| sepolia | wait (170 blocks) | 0.42 / 0.40 | 0.40 / 0.35 |

At the typical spans (453, 173) the limits are one grid step higher in most rows. The standard error of a measured share is `sqrt(q (1 - q) / N)`: at `q` near 0.40 to 0.45 it is 1.8 to 1.9 points for `N` = 720, 0.9 for 2,880 and 0.35 for 20,160 blocks, so 2 sigma is 3.7, 1.8 and 0.7 points. For `N` = 2,880 that is 1.83 to 1.85 at a share of 0.40 to 0.45 and 1.86 at the worst case of 0.5 (1.96 sigma at 0.5 would be 1.83); the 1.9 used below is the worst case rounded up, and with 1.83 the threshold is the same 35 %. Drift: in the sustained period of the table in Section 1 the largest share changed by 3 points or less from one 2,880-block day to the next in 11 of the 20 steps and by 3.2 to 4.2 points in 6, but by 9.5 points once (53.8 % to 63.3 %), 7.8 points once (60.1 % to 52.3 %) and 5.0 points once, so 3 of the 20 steps were 5 points or more; so the 5-point allowance is a judgement that the data does not support as a bound. **Measured on sliding windows** (26 days of the node's own headers, one start every 30 blocks, 2,376 starts): the share of the past largest address in the next 738 blocks (the span of a production swap) minus its share in the previous 2,880 had a median of 0, a 90th percentile of +6.2 points, a 99th of +16.6 and a maximum of +27.8. Of the 231 starts at which the gate (35 % in both windows) would have passed, 24 (10 %) were followed by a 738-block stretch in which one address held more than the 42 % working limit, and 2 by more than 50 %. All of them lie within about two days before the dominant address entered (its share went from about 19 % to 54 % in a day), so this is one episode, not a distribution. Trying other limits (25, 28, 30, 33 and 35 %: 1, 18, 87, 210 and 231 passing starts, of which 0, 3, 16, 21 and 24 were followed by more than 42 %) does not repair it: a lower limit selects the period just before the entry. **The threshold is therefore not moved on this evidence:** it cannot be calibrated from a single entry, a tighter limit does not reduce the share of bad passes, and what the screen cannot see is a producer that joins after the measurement. A rise rule (refuse when the short window is well above the long one) would look at the trend instead of the level; it is evaluated in `docs/bob-concentration-gate.md` and not built.

**Suggested threshold.** Take the free-tie, lead-10, 0.1 % limit as the working figure: 0.42 for the production profile. With `N` = 2,880 (2 sigma 1.9 points) and 5 points for drift, `X` is about **35 %**. For the sepolia profile (0.35) it is about **28 %**. If Bob re-sends by hand (`rho` 10) the production limit falls to somewhere near 0.40 (strict-tie figures: 0.40 gives 0.05 %, 0.45 gives 5.4 %; with free ties both are higher) and `X` to about 33 %. A shorter second look at the last 720 to 1,000 blocks (the span of a swap) should use the same `X` plus its own, larger, 2-sigma margin. As of the measurement the gate would have refused every swap for the last 20 days.

**Two more refusals, proposed in review (not decided).**
- **The two largest addresses together above 50 %** of the window. Two addresses that are one party are a majority; 50 % is the lowest sum at which a joint majority is possible. It refuses more often than the single-address rule: three of the four full days before the largest address first appeared had a top-two share of 52.6 % to 53.8 % (table in Section 1).
- **A reorg deeper than 3 blocks in the window** (phase 2). The deepest reorg seen in the node's logs is 3 (Section 1). The node's RPC exposes no reorg history, so this needs `swap-cli` to record its own chain of tip hashes while it ticks, or a read of the node's log, and it cannot be retroactive; a window with no record must say "no record", not "no reorg". `docs/bob-concentration-gate.md`, Section 4.

**Limits.**
- One operator can use several addresses, so a measured share is a lower bound. The gate cannot see a partner of Alice either; the top two or three addresses together (71.5 % and 85.9 % now) are a worry the model shows is real, but a threshold on sums would refuse nearly always.
- The block template call accepts any valid address as the miner address, so the field is where the reward goes, not who did the work; an attacker can mine for a fresh address.
- A new miner can appear within hours (a share can rise inside one swap); the gate looks backwards.
- It is for Bob only; Alice's own tool has no such exposure.
- It must fail closed (a node that cannot answer means no lock) and be one more gate in the list of the tool, like the others.

## 6. A daily snapshot (proposal; not written, not scheduled)

A read-only script that talks only to Bob's own node and appends one line to a local file:
- Inputs: the node's RPC address. Calls: `paranoid_getChainInfo`, then `paranoid_getBlockHeader` for the windows below, six at a time.
- Windows: since a stated start height (the first day the concentration was seen, a fixed number kept in the script's settings), the last 7 days (20,160 blocks), the last 24 hours (2,880 blocks).
- For each window: tip height, number of blocks, share of the largest address, of the largest two and three together, number of distinct addresses, and whether the largest address is the same as in the previous line. The local file keeps the shares and a hash of the largest address (to answer "the same as before"), never the address itself; it is not committed.
- Output: one UTC-dated line per run in a plain file, plus the reorg depths seen in the node's log since the previous line (count by depth).
- No side effects: no transaction, no mining, no key; the schedule (one run a day) is the owner's choice.

## 7. Robustness: work race with ASERT (done)

The main model counts blocks. The real chain compares total work, and the difficulty of each branch follows its own timestamps (ASERT, half-life 180 s), so a branch that is slow becomes easier to mine. A continuous-time Monte Carlo of one attempt (400,000 runs per share, each branch with its own difficulty, honest timestamps equal to real time) against the exact block-count figure for "any moment, with head start, cap 18" (strict ties):

| q | block-count model | continuous time, no feedback | continuous time, ASERT | ASERT 99 % interval |
|---|---|---|---|---|
| 0.30 | 30.8 | 30.8 | 33.9 | 33.7 to 34.1 |
| 0.40 | 57.0 | 56.8 | 58.1 | 57.9 to 58.3 |
| 0.50 | 83.8 | 83.7 | 82.9 | 82.7 to 83.0 |
| 0.53 | 89.6 | 89.6 | 88.5 | 88.4 to 88.6 |
| 0.60 | 97.5 | 97.4 | 96.9 | 96.8 to 97.0 |

With the difficulty feedback switched off the continuous-time race reproduces the block-count figures (a check of the code); with ASERT the single-attempt figure moves by +3.1 points at 0.30, +1.1 at 0.40, -0.9 at 0.50, -1.1 at 0.53 and -0.6 at 0.60. The block-count model is therefore a good approximation near the shares that matter; the effect on the repeated game was not simulated. **Timestamp manipulation is not modelled:** the node accepts timestamps above the median of the last 11 blocks and up to 120 s ahead of its own clock; an attacker who stamps her branch late makes it easier to mine by the rule's own formula (by at most a factor of about 2^(120/180) = 1.6 on her branch, arithmetic from the rule, not simulated). The "always" tie rule is an upper bound for any such influence on work at equal block counts.

## 8. Decisions for the owner

1. **Is the stated assumption (no party holds a majority) acceptable as it stands?** It is false at the time of measurement (52.7 % of 24 hours, 45 % to 63 % of every day for 20 days). The honest statement for the README and the review packet is: with the measured concentration the protocol offers no defence against a miner who is Alice (the realistic chance for a prepared majority miner is about 100 %); amounts stay at trial size.
2. **Build the Bob-side concentration gate?** Decided and built (2026-11-08): `X` 35 % over 2,880 blocks for the production profile (28 % for sepolia and rehearsal), with a second look over 720 blocks; the two largest addresses together above 50 % only warn; hard under production, a warning under the other profiles. It refuses every production swap today. Design and the decisions: `docs/bob-concentration-gate.md`, Section 9.
3. **Lengthen the window?** Useful only against a share up to about 0.47; at 0.50 it needs about 1,900 blocks with strict ties (16 hours of worst-case NOID lockup, about 12.7 hours more than now) and more with free ties; against a share above 0.50 it is useless. Suggested: do not change `B_post` now.
4. **Make the re-send faster?** Moving `rho` from 10 or 20 (by hand) to about 2 is worth three orders of magnitude at 0.45; it needs a decision on re-submitting an already-built claim without an operator step.
5. **Build the daily snapshot** (Section 6) and the reorg-depth monitoring (count by depth from the node's log)? Cheap, read-only, and the only way to see the concentration and reorg depth change over time.
6. **Tell the project upstream?** The chain's rule that gives one miner the power to reorder 18 blocks is inherent to proof of work at that hashrate share; reporting the measurement upstream: open.

## 9. Reproduce

```sh
cd docs/formal
python t21_race.py grid        # about 9 minutes (525 s, peak memory 539 MB), writes t21_results.csv and t21_results.md
python -m unittest t21_race_test   # about 40 s; from the repository root: python -m unittest docs/formal/t21_race_test.py
python t21_race.py single      # the single-attempt table
```
Needs Python 3.12; the unit tests of the closed forms and the enumeration need only the standard library, the rest and the grid need numpy (2.x was used). The grid is deterministic: two runs of the earlier version gave byte-identical results.
