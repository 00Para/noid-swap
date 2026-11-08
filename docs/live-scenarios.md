# Live scenarios still open in M2.7: the operator's plan

Status 2026-11-05. Plan, except scenario 1+2, which was run as live run 4 and settled (section 1+2, `live-run-4.md`); the rest was not run, funded or sent. Parano1d mainnet (tiny NOID) against public
Sepolia, `sepolia` profile, the owner in both roles, with the versioned helpers of `scripts/live/` (README there).
Every step that moves NOID or ETH needs the owner's go-ahead in the same session (`PROJECT.md`); a blanket "do all"
from an earlier session does not carry over. Clock times are UTC. Sources: `live-run-2.md`, `live-run-3.md`,
`runbook-two-party.md` 4-5, `swap-cli/README.md`, `htlc-v2-fixed-fee.md`, `mac-setup.md`.

## 0. Numbers every scenario shares

`sepolia` profile (`swap-cli/src/params.rs`): `D = h_create + 300` (about 2 h 30 at 30 s/block); Bob's lock-by `D - 251`
= `h_create + 49` (hard minimum-window limit `D - 209` = `+91`); `W_A` 4,200 s so `T_reveal` is about 70 min after
Bob's lock tick; Alice's reveal cutoff `T_reveal - 1,800 s` (about 40 min after the lock); Sepolia finality about 19 min;
Parano1d finality 18 blocks (about 9 min); caps 20 NOID, 0.01 ETH, chain 11155111. Run 3 milestones in blocks after
`h_create`: instance visible +2, funding final +20, Bob's `lock_eth` +22, lock mined +26, lock final +60, reveal +70,
Bob's claim final +88, Alice `done` about +105. Minimum amount: both versions refuse a swap whose `max_fee` (50,000
μNOID) exceeds 1 % of the amount, so at least 5 NOID; 10 NOID is the default (`AMOUNT`).

Per-run setup (same for every run N; `export RUN=N` in EVERY shell, `env.sh` derives `$L=~/live-run-N` from it, and
`env.local.sh` is sourced after `$L` so it cannot change `RUN`):
```
bash scripts/live/install.sh N ; export RUN=N ; bash ~/live-run-N/bin/setup.sh      # then edit ~/live-run-N/env.local.sh:
  ALICE_NOID=o1...  BOB_NOID=o1...  ALICE_ETH=0x...  BOB_ETH=0x...  CONTRACT=0x...   # CONTRACT = the run-3 Sepolia HTLC (reuse)
  VARIANT=raw|stock   CONTRACT_VERSION=1|2   HC_LEAD=<blocks>   AMOUNT=10000000   NOID_RPC2= ETH_RPC2=   # last two only in scenario 8
bash ~/live-run-N/bin/prepare.sh        # Alice's file, proof 20-36 min, Bob's file, swap.def.json -> $PUB. Sends nothing.
# Windows:  parano1d-cli contract create swap.def.json --out swap.object.json
bash ~/live-run-N/bin/check-object.sh   # must print "object file OK"
# GO / NO-GO: object OK; tip within a few blocks of the planned h_create (printed by prepare.sh); wallet active address =
#   Alice's; Bob's file phase `received`.   GO-AHEAD (NOID leaves the wallet):   parano1d-cli contract fund swap.object.json 10.000000
bash ~/live-run-N/bin/watch.sh both 30 > /dev/null 2>&1 &     # then: tail -f ~/live-run-N/loop-alice.txt ~/live-run-N/loop-bob.txt
```
Send the owner at every run the contract root (`o1...`) and the Sepolia contract link (memory rule). Never edit a
helper after `install.sh`. Keep `swap.object.json` and both swap files: the opening cannot be recovered from the chain.

Alice's recovery close (the one command used by scenarios 1, 3 and as the fallback elsewhere; not a helper). Only at
tip + 1 >= `D`; her index-0 address must be the active one (`parano1d-cli address --use INDEX`); S and C come from
`parano1d-cli contract instances swap.object.json`. Preview and send chained in ONE command (run 2 lost 20 s between
two; the `--json` key `txid` is assumed from the run-2 text, check it on the first preview):
```
$t = (parano1d-cli --json contract call swap.object.json S C --close --preview | ConvertFrom-Json).txid; parano1d-cli contract call swap.object.json S C --close --expected-txid $t --out refund.json
```
The preview must say `"recovery": true`, `"terminal": true`, authority = Alice, fee <= `max_fee`. GO-AHEAD first. Then
`bash ~/live-run-N/bin/tick.sh alice --closed-by TXID --apply` (or the watch loop with the flag) and, for the receipt,
`parano1d-cli contract receipt --out refund.receipt swap.object.json TXID` + `contract verify`.

Concurrency: proofs strictly one at a time (8 GB RAM; no argv listing, no cargo build meanwhile). Fundings at least
5 blocks apart and Bob's locks at least a minute apart (one wallet UTXO set, one Sepolia nonce). Different runs have
different swap files, passphrases, secrets and contract roots, so they can overlap freely after the proof.

## 1+2. Alice-abort before Bob locks, and Bob-abort after funding (merged): run 4 — DONE 2026-11-05

**Result (`live-run-4.md`).** Settled 20:41:43 UTC: 10 NOID funded 17:49:49, no Bob, no Sepolia transaction; `refund_noid` offered at tip 284,173
(`D` = 284,172), chained preview and send, recovery close confirmed at 284,179, receipt verified, Alice's file `refunded` at 284,197 (18 blocks
later); cost 14,800 μNOID (9,000 + 5,800), exactly the bound below. The Bob-side checks of this section (`lock_eth` refused after `h_create` + 49,
`lock.sh --dry-run` refusing after `+91`, Bob's file reaching `aborted`) were not run, because Bob never appeared: they remain open.

- **Merge.** From the chain's view both are "NOID funded, no Sepolia lock": Alice does nothing until `D`. The only
  difference is a person's intent, so one run covers both. Extra check for Bob's side: his engine must stop offering
  `lock_eth` after `h_create + 49` (hard `+91`), and a `lock.sh --dry-run` after that must refuse.
- **Proves (new).** The abort path with NOID at the contract and nothing on Ethereum; Bob's file reaches a terminal phase
  without ever touching Sepolia; Alice's engine offers `refund_noid` at `D` and `--closed-by` closes her file (run 2 only
  covered "after Bob's lock"). Uses the shortest path to `D`: no lock, no Sepolia finality.
- **Preconditions.** Wallet balance >= 11 NOID; Sepolia HTLC address known; `VARIANT=raw CONTRACT_VERSION=1`.
- **Commands.** Common setup and funding (GO-AHEAD: fund). Watch loop on. Bob: never run `lock.sh`. After `h_create + 91`
  (about 46 min after funding): `lock.sh --dry-run` (expect refusal; sends nothing). At tip >= `D - 1` ask for the
  GO-AHEAD, then Alice's recovery close above, then `tick.sh alice --closed-by TXID --apply`.
- **Watch.** `loop-alice.txt`: `funded` -> `funding_final` ("waiting for Bob's lock") -> `refund_noid` once tip + 1 >= `D`.
  `loop-bob.txt`: `lock_eth` offered between funding final and `D - 251`, then `wait` with a lock-by reason; no `intent
  lock_eth pending` remains if Bob ignores it (if the engine froze one, `swap-cli intent bob.swap.json --cancel`).
- **Duration.** 300 blocks to `D`, +18 to final: about 2 h 40 from `h_create`. Active work: 5 min at start, 5 min at `D`.
- **Pass.** Alice's index-0 balance back to start minus 9,000 (funding fee) minus 5,800 (v1 close) = minus 14,800 μNOID;
  `contract instances` empty; receipt verifies; Alice file `refunded`; Bob file terminal (`aborted`; if it stays `received`/
  `funded` past `D`, record it as a finding, not a failure); no Sepolia transaction at all.
- **If it goes wrong.** Close dropped ("no longer pending", tip passed the call height): preview again, chained. Wrong
  active address: refused by the node, switch and retry. Funds are never stuck: the recovery branch is open from `D`
  with no dependency on Bob. Loss bound: 14,800 μNOID.

## 2b. Happy path with the proof-free lock kind (`poseidon`): DONE 2026-11-05

Not part of the plan above: the first swap with `HTLCPoseidonV2` locked on `A = Addr(s)` (no equivalence proof, raw v1, `sepolia`
profile, owner in both roles, one node per chain) settled in about 47 minutes (`live-run-5.md`); the contract-version-2 and
stock scenarios below stay open, and the abort paths and two nodes with this lock kind were not run.

## 3. Alice never reveals after Bob's lock on Sepolia: run 5 (overlaps run 4)

- **Proves (new).** Run 2 on a public chain with Sepolia finality, and the M2.5b change: Bob's refund is `refund_mined`
  first and `refunded` only after Sepolia finalizes the block (and falls back to `locked` on a reorg); Alice's engine
  fixes "keep the secret" at the cutoff, records `eth_refund_mined`, and recovers with `--closed-by`.
- **Preconditions.** As run 4; Bob's Sepolia key holds >= 0.002 ETH; `keys/bob.key` present. `VARIANT=raw CONTRACT_VERSION=1`.
- **Commands.** Common setup and funding (GO-AHEAD). Watch loop on. When Bob's loop says `lock_eth` (about +22):
  `lock.sh --dry-run`, GO-AHEAD (0.001 ETH), `lock.sh`. Note lock id and block. **Alice stays silent**: do not run
  `reveal.sh` (a `--dry-run` is fine). At Bob's `refund_eth` (about `h_create` + 165 blocks): `refund-eth.sh --dry-run`,
  GO-AHEAD, `refund-eth.sh`. Keep ticking; at `D` Alice's recovery close (GO-AHEAD) and `--closed-by`.
- **Watch.** Alice: `reveal_eth` offered from lock final (+60) until the cutoff (about +100), then `wait` ("reveal
  cutoff passed; keeping the secret and waiting for D"); after Bob's refund an `eth_refund_mined` event. Bob: `locked`,
  then `refund_eth` on the first tick past `T_reveal`, then `refund_mined` (non-terminal), then `refunded` about 19
  min later. A phase `refunded` before Sepolia's `finalized` passes the refund block is a bug: stop and record.
- **Duration.** Refund offered about +165 blocks (82 min), final about +205; `D` at +300, NOID final about +318 (2 h 40).
- **Pass.** Bob's Sepolia balance back to start minus gas (about 0.0001 ETH); contract lock state `refunded`, preimage
  `null`; Alice's NOID back minus 14,800 μNOID; both files terminal; receipt verifies.
- **If it goes wrong.** Never run `reveal.sh` after the cutoff (it refuses; do not use `--margin-s`). Refund tx stuck or
  dropped: the intent ledger names the frozen parameters; resend the same `refund-eth.sh`, never a second lock. Bob's
  refund is open until Alice reveals, so a missed refund window costs nothing but delay (the reveal path is closed).

## 4. Happy path with contract version 2 (fixed fee): run 6

- **Proves (new).** The v2 program (`close must pay exactly max_fee`) is accepted by the real node and works in a claim
  on mainnet: first live use of `htlc_v2.pruv`. Bob receives exactly `amount - max_fee`.
- **Preconditions and risk.** v2 was never deployed; its harness tests pass but it has had no independent review
  (`htlc-v2-fixed-fee.md` 6). If the node's admission rejects the close, the instance has NO working branch. So: use the
  minimum amount (`AMOUNT=5000000`), get the owner's explicit acceptance of that risk at the fund GO, and prefer to fund
  only after an independent read of `htlc_v2.pruv` is done. `CONTRACT_VERSION=2 VARIANT=raw`.
- **Commands.** Common setup (the definition from `alice-params` carries the version; `check-object.sh` must say OK), fund
  (GO-AHEAD). Then the happy path of run 3: `lock.sh --dry-run`, GO, `lock.sh` at `lock_eth`; `reveal.sh --dry-run` then GO,
  `reveal.sh` at `reveal_eth` (Sepolia final, about +60); `claim.sh` (dry run: fee_micronoid must equal `max_fee` 50,000,
  recipient = Bob's `o1`), GO, `claim.sh --submit`. Loop until both files `done`.
- **Watch.** Bob's claim plan shows fee 50,000 (not 5,800); no "fee range" refusal. `max_fee` in the bundle >= 50,000.
- **Duration.** As run 3: Bob's NOID final about +88 blocks (45 min after funding), Alice `done` about +105.
- **Pass.** Bob received `AMOUNT - 50,000` μNOID (4.95 NOID at 5 NOID); Alice 0.001 ETH; Alice's NOID side = start - AMOUNT
  - 9,000; receipt verifies. Fallback if the preview of the close is rejected by the node: do nothing, wait for `D`, try
  Alice's recovery close (same program): if that is also rejected, the 5 NOID is stuck by design of v2 and v2 is withdrawn.

## 5. Happy path with the stock variant: run 7

- **Proves (new).** `A = Addr(Derive(m, 0))`: Bob claims with a stock wallet that imported the revealed `m`
  (`--import-wallet-secret` into a throwaway data dir): client S, never run anywhere; the hidden flag's existence in the
  installed 2.1.0 binary is undetermined. A claim reveals the whole wallet secret `m`: the throwaway wallet holds only this swap.
- **Preconditions.** A read-only rehearsal BEFORE funding: import a random test secret (never the swap's) into
  `D:\throwaway` and start a second node on ports 19600/19601 (README, client S block): proves the flag exists and
  measures sync time (the open unknown). `VARIANT=stock CONTRACT_VERSION=1`; `--alice` must be the index of the wallet
  that will refund (recovery address).
- **Commands.** Common setup, fund (GO), lock (GO), reveal (GO) as in run 3. For Bob's claim `claim.sh` is client R only
  and may not handle the stock variant (undetermined, see section 9): use the manual client-S sequence of the
  README (import `m` over stdin, `contract call ... --close --fee 0.005800 --preview`, then `--expected-txid`, same
  height, `swap.object.json` = `{"opening_hex": "<swap file opening_hex>"}`), GO-AHEAD before the send. Chain `--preview`
  and send in one command. The close must be included and final before `D - 18`.
- **Watch.** Bob: `claim_noid` from `Claimed`; the throwaway node synced to within a few blocks BEFORE the reveal;
  authorization proof time (stock = raw in M0.5, 3 extra permutations).
- **Duration.** As run 3 plus the second node's sync (prepare it hours earlier) plus the manual claim: about 1 h 15 from fund.
- **Pass.** Bob's address +10 NOID - 5,800 (v1); Alice 0.001 ETH; throwaway wallet balance 0 afterwards; receipt verifies;
  swap files `done`. If the stock claim cannot be made in time Bob gets nothing and Alice refunds at `D` AND keeps the
  ETH: do not reveal until the throwaway node is synced and a `--preview` succeeded against the real opening.

## 6. Forced epoch rotation (T6): overlay on run 6 (or a plain raw v1 run)

- **Proves (new).** The `sepolia` profile budgets `B_epoch` = 0 and the window (300 blocks) always contains a rotation, but
  nothing in 3 runs was near one. What can be forced: Bob's tick refuses to prove within 4 blocks of a boundary ("epoch
  anchor rotates in N block(s); proving after the boundary (T6)") and then builds the claim after it. What cannot be
  forced with one node: an already-pending claim evicted by a rotation (inclusion takes 1-2 blocks).
- **Plan the boundary.** Anchors rotate at heights that are multiples of 144 (280,656 = 1,949 x 144 in run 1). Pick the
  first boundary `B` with `B - 72 >= tip + 80` (the proof takes 40-70 blocks) and set `HC_LEAD = B - 72 - tip` before
  `prepare.sh`; fund promptly at about `B - 72` (funding must not be later than `h_create + 20`, lock-by is `+49`).
  Then Bob's lock is final about `B - 7`.
- **Commands.** The run-6 sequence, except: Alice delays `reveal.sh` until tip >= `B - 6` (the cutoff is about
  `B + 25`, so the slack is large), GO-AHEAD, reveal. Bob's `claim.sh` dry run at `B - 3` must say wait (T6); repeat
  after `B + 1`, GO, `--submit`. Do not bypass the guard.
- **Optional, unverified.** Prove a claim with `claim.sh --intent-out F` at `B - 6`, do NOT submit; after `B + 1` post the
  stale intent by hand with `paranoid_submitTxIntent`: expected rejection (anchor older than the epoch). No helper does
  this; if the node accepts it, record it as a finding.
- **Watch.** `loop-bob.txt` notes with "rotates in"; the claim's `call_height` > `B`; a changed anchor in the recording.
- **Pass.** Claim included after `B`, final before `D - 18`; otherwise the run-6 criteria. **Recover.** Guard refuses
  forever: tick again (it clears at `B`); if the reveal came too early/late, the run simply is not a rotation test.

## 7. Conflicting close at minimum fee, and the F_max burn (Q1): run 8, stock v1

- **Proves (new), and the honest limit.** The secret holder can close early and pay Bob anyway, and a close that pays Bob
  but burns up to `max_fee` is possible (T1 bound). Measured here: Bob's net payout when a rival closes at `max_fee`
  (50,000) instead of 5,800, i.e. the real burn (about 0.044 NOID). One node CANNOT show the stall: on an idle chain a
  minimum-fee close is mined in 1-2 blocks, so it never sits in the mempool; the mempool conflict ("first seen wins,
  no replace-by-fee") is visible only on a node that holds the rival and does not mine: use an isolated node (synced,
  then peers off, e.g. the scenario-8 Mac node) and submit Bob's close there second. Congestion (Q1, Q6) stays unmeasured
  without load; v2 removes the cheap-rival stall by design (run 6), so this run uses v1.
- **Why stock.** A rival close needs an authorizer with the secret: with the stock variant `parano1d-cli contract call --close
  --fee` is a second wallet that imported `m` (run 7's throwaway-wallet machinery). Raw has only `swap-cli claim`, whose
  fee the engine picks.
- **Commands.** As run 7 until the reveal (GO). After the reveal and before Bob claims: (a, only with an isolated node)
  submit the rival (`--fee 0.005800`, GO) to it, then Bob's normal close to it: expect rejection as a conflict; (b) on the
  wallet node submit the rival at `--fee 0.050000` (GO; this IS the burn), let it be included; Bob's own close then fails
  with "instance gone". Observe Bob's engine: `claim_noid` -> `done` through `tick --closed-by TXID --apply`
  (not a normal path: it records a close made outside the tool).
- **Pass.** Bob received 10 NOID - 50,000 μNOID; Alice 0.001 ETH; engines end `done`; the rejection text of (a) saved.
  **Recover.** If (b) is not included within a few blocks, Bob's own close (a higher fee is NOT possible: first seen) waits
  for the anchor rotation (up to 144 blocks) or `D`; record the wait, it is the measurement Q1 wants.

## 8. Two-node run: run 9 (any happy path once the Mac node is synced)

- **Setup.** `docs/mac-setup.md` 5-8: node synced, `ssh -N -L 127.0.0.1:19601:127.0.0.1:9601 USER@MACADDR` running on
  Windows (loopback only; never expose 9601), a second distinct Sepolia RPC. Put `NOID_RPC2=http://127.0.0.1:19601` and
  `ETH_RPC2=<another provider's Sepolia URL>` in `env.local.sh`; the helpers then drop `--single-node-ok`.
  Pre-check read-only: `tick.sh bob` on a fixture-free file exits 0, `tip_time` not null, no "lag (F5)".
- **Proves (new).** The F5 cross-checks before Bob's lock and Alice's reveal: both nodes agree on the lock record, code
  hash, chain id, finalized heights within 64 blocks. Plus fail-closed: with the tunnel killed at the `lock_eth` tick the
  engine must `wait` with a node reason and Bob must not lock; restore the tunnel and continue. Raw v1, run-3 sequence.
- **Pass.** Run-3 balances; the `sources` field of ticks lists two endpoints; the refusal observed while the tunnel was down.
  **Recover.** An unreachable second node is a refusal, not a loss: restore it or pass `--single-node-ok` only for a
  test file, not for a stranger.

## 9. Not determined by the sources

- Whether `swap-cli claim` / `claim.sh` can claim a `stock` swap (the README describes client R only; client S is "scripted,
  nothing spawned"), and how Bob obtains `m` for the import (probably from `eth_preimage_seen` in the file; no command named).
- Whether the hidden `--import-wallet-secret` exists in the installed 2.1.0 binary; second-node sync time.
- That the node accepts the v2 program (`fee == max_fee`) end to end; the `--json` output key `txid` of `contract call --preview`.
- How to inject a stale-anchor intent (scenario 6) and whether an isolated node can be built from the Mac setup (scenario 7a).
- The Bob-side terminal phase after an abort before any lock (`aborted` is listed in `watch.sh`, not confirmed for this path).

## 10. Summary and schedule

| # | Scenario | Run | NOID at risk (recovered less fees) | Sepolia ETH needed | Blocks to completion from `h_create` | Go-aheads |
|---|---|---|---|---|---|---|
| 1+2 | Abort before any lock | 4 | 10; loss 14,800 μ | 0 | 318 (2 h 40) | fund, recovery close |
| 3 | Alice never reveals | 5 | 10; loss 14,800 μ | 0.001 locked and returned + gas (about 0.0002) | 318 | fund, lock, refund-eth, recovery close |
| 4 | Happy, contract v2 | 6 | 5; Bob gets 4.95 | 0.001 to Alice + gas | about 105 (the fund GO also accepts the v2 risk) | fund, lock, reveal, claim submit |
| 5 | Happy, stock | 7 | 10 | 0.001 + gas; 0.0005 spare | about 105 plus throwaway-node sync | fund, lock, reveal, claim send |
| 6 | Epoch rotation | on 6 | as 4 | none extra | +10 blocks of waiting | the same as 4, reveal timed |
| 7 | Rival close, F_max burn | 8 | 10; burn 50,000 μ | 0.001 + gas | about 105 (+144 if stalled) | fund, lock, reveal, rival close(s) |
| 8 | Two nodes | 9 | 10 | 0.001 + gas | about 105 | fund, lock, reveal, claim submit |

Sepolia ETH in all: Bob's balance (0.0465 after run 3) covers every run (about 0.006 ETH of locks, a fraction returned);
Alice's 0.006 ETH covers her claim gas. NOID: balance 2,038 covers all runs concurrently.

Two-day schedule (UTC, each run offset from its own fund time F):
- **Day 1, about 07:00-11:30.** 07:00 prepare run 4 (proof to 07:30), fund 07:35. 07:35 prepare run 5 (proof to 08:10), fund
  08:15. Run 6 needs the planned boundary: prepare 08:15-08:50, fund at its `B - 72` (set `HC_LEAD` so that this is
  about 08:55), lock about +11 min, reveal at `B - 6` about 09:55, done about 10:20. Meanwhile run 5 locks at 08:30, its
  refund at about 09:40 (final 10:00), and run 4's recovery at `D` about 10:05, run 5's at about 10:45 (final 10:55).
- **Day 2, about 07:00-10:00.** 07:00 prepare run 7 (throwaway node synced the day before), fund 07:40, done about 08:50;
  07:40 prepare run 8 (proof to 08:15), fund 08:20, rival at about 09:30; run 9 later the same day (or whenever the Mac node
  is synced). Check the 8 GB limit before each proof: one proof at a time, no cargo build.
