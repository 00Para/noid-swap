# Live run 19 — a third party closes to Bob first (hostile plan L4, scenarios T1 and A9), 2026-11-16

> Clock times in this log are UTC. All of them belong to 2026-11-16. The Parano1d tip is given in the `tip` column.

The second try at group L4 of the hostile-counterparty campaign (`docs/hostile-run-plan.md`; the first try, run 18,
ended on its abort path before the step that matters). A normal swap up to Alice's reveal. The reveal is the step in
which Alice publishes the secret on Ethereum to take the ETH; from then on the secret is public. Then somebody who is
not Bob, and who has nothing but the public bundle and the secret read from Ethereum, closes the Parano1d contract
before Bob does. The questions: does that close pay Bob, what does Bob's real tool say about a close it did not make,
and can Bob's file record it. **The third party's close paid Bob's payout address 4.994200 NOID. Bob's tool showed
the expected text while the close was pending and the expected text once it was mined, and `tick --closed-by`
recorded it as Bob's claim. Both files ended `done`.** The swap settled: 5 NOID against 0.001 Sepolia ETH.

## Setting

5 NOID against 0.001 Sepolia ETH, lock kind `poseidon`, raw variant, contract version 1, profile `sepolia`, one node
per chain (`SINGLE_NODE_OK=1`), the helpers of `scripts/live/` frozen for the run. Sepolia contract
`0x48Ce4D6cf3c175737532017e82B9261b51F8E5eF`, Parano1d contract root
`o1whtmmt0thss94uu3yjncmmp03m276euwhh8zf26kvksq2zwm7g4q3zedlp`. One Windows PC in all three roles, ticks by hand
(Bob's file with `--apply`; Alice's file applied at the funding, at the reveal and after it). The four spends (the
funding, the lock, the reveal, the third party's close) were sent by the operator; everything else was a read or a
dry run. Bob's own `claim.sh --submit` was never run.

The third party was a copy of the run folder made before any tick, without Alice's swap file (so without the secret):
Bob's file in phase `received`, the bundle and the helpers, in a folder of its own. The bundle and Bob's terms are not
secret, so any observer could build the same. It holds no key and no coins: the fee of a close is paid from the
contract's balance.

Numbers of the swap: `h_create` 315021, lock-by 315071, last lock height 315113, `D` 315323, log start on Sepolia
12145220, lock word `0x55555650a170cb51db3fb8778916985c2002b068b43e5d272f332b06e217aaa0`.

## What happened

| UTC | tip | who | what |
|---|---|---|---|
| 13:46:35 | 315009 | Alice | `prepare.sh`, `contract create`, `check-object.sh` ("object file OK"); `fund.sh --dry-run` passed. The third party's folder was copied |
| 13:50:56 | 315022 | Alice | applied: `fund_noid` offered and recorded; note "funding window: 25 blocks left before it is too late to fund" |
| 13:51:29 | 315025 | Alice | **the funding, sent once by the operator:** `fund.sh`. Txid `460686c9982dda77b97aaf6fa849decaec0702ed245e8a71131e9458bb53372b`, fee 9,000 μNOID, included at 315027 |
| 13:54:10 | 315028 | both | instance: slot 596949, incarnation 812274, 5.000000 NOID; both files `funded` (Bob at tip 315028, Alice at 315029) |
| 14:02:58 | 315047 | Bob | `noid_funding_final`; `lock_eth` offered and recorded (`T_reveal` 1794841968, 15:12:48). The producer screen warned and, in this profile, did not refuse (largest address 48.1 % of the last 2,880 blocks and 40.5 % of the last 720). `lock.sh --dry-run` passed |
| 14:04:12 | about 315050 | Bob | **the lock, sent once by the operator:** `lock.sh`. Tx `0x60847a627f992bccda9bdaab8a7f8d45f297dd6465f7f80c4c17904980a4fdd8`, Sepolia block 12147796 (timestamp 1794837852), lock id `0x0fb0594b36740db9f66abe349f6eac49f87ee0ea56da158f53883010b2d51a90`. The helper's fresh read-only tick was made 16 s before the lock's block; both lock records were written |
| 14:04:17 | | both | a tick 5 s after the lock's block failed for both files (see observation 4); nothing was written |
| 14:04:47 | 315052 | both | Bob: `eth_lock_seen`, phase `locked`. Alice (read-only): `noid_funding_final`, `eth_lock_seen`, "waiting for Bob's lock to be finalized" |
| 14:05:02 | 315052 | third party | first tick of the copy, after the real lock was mined: the instance is seen, phase `funded` |
| 14:15 | 315071 | third party | `noid_funding_final`, `eth_lock_seen`, phase `locked`, "waiting for the secret (or T_reveal)". No `lock_eth` step of its own |
| 14:19:24 | | | Sepolia's finalized block (12147806) passed the lock's block |
| 14:19:50 | 315083 | Alice | applied: `reveal_eth` offered and recorded, cutoff 1794840168 (14:42:48). `reveal.sh --dry-run` passed, with 1,375 s to the cutoff by the tool's count |
| 14:20:18 | about 315086 | Alice | **the reveal, sent once by the operator:** `reveal.sh`, 28 s after the dry run. Tx `0x76eb69c40a456c1e57b73b24932a9c00698d0847db3f876489037ec829b72159`, Sepolia block 12147877. The reveal sidecar was written before the broadcast |
| 14:20:54 | 315088 | all three | Alice: `eth_claim_mined`, phase `revealed`. Bob: `eth_preimage_seen`, `claim_noid` offered (`call_height` 315089, fee 5,800), phase `secret_seen`. Third party: the same event and the same offer |
| 14:21:24 | | third party | `claim.sh` (dry run) from the copy: proof made and self-verified in 9 s, owner-authorization V4, recipient Bob's payout address, 4,994,200 μNOID, fee 5,800 |
| 14:22:07 | about 315089 | third party | **the close, sent once by the operator from the copy:** `claim.sh --submit`. Txid `3626ea152aa945c8e05ebb4eabb407c645cc34e4b56934d01bbd37061b481fe4`, `call_height` 315090, accepted by the node (an intent of 90,577 bytes) |
| 14:22:30 | 315091 | Bob | **the pending text:** `wait`, "a close by someone else is pending on the instance (3626ea15…1fe4); it pays B_noid if valid; proving again only after it is evicted (T2)" |
| 14:22:52 | 315092 | Bob | the close was included at 315092. **The mined text:** `wait`, "the instance is gone but no tracked transaction closed it; verify the contract receipts manually" |
| 14:23:00 | 315093 | Bob | `tick.sh bob --closed-by TXID --apply`: event `noid_closed_externally` at 315092, phase `claim_included`, "waiting for NOID claim finality"; the note says the close was "RECORDED … as Bob's claim" and that the payout is not read from the transaction but follows from the branch rule |
| 14:23 | | | read from the node: Bob's payout address holds a new coin of 4.994200 NOID (slot 9749042) |
| 14:33:49 | 315112 | Bob, third party | Bob: `noid_tx_final`, "done: NOID received", phase `done`. The copy: `noid_tx_included` at 315092, `noid_tx_final`, `done` |
| 14:41:10 | 315126 | Alice | `eth_claim_final`, "done: ETH received", phase `done` |

Afterwards `contract instances` printed nothing. Alice's NOID balance went down by 5.009000 (the 5
NOID and the funding fee of 9,000 μNOID). Bob's payout address received 4.994200 NOID (5 minus the close fee of
5,800). On Sepolia Alice's test address went from about 0.011 to about 0.012 ETH and Bob's from about 0.0405 to about
0.0395 ETH; gas was a fraction of a gwei per unit and cost next to nothing.

## Against the plan

- Step 1 (fund, lock, reveal): done, each within about a minute of its offer (the funding 33 s, the lock 74 s, the
  reveal 28 s after
  its dry run).
- Step 2 (A9, the recovery dry run before `D`): not repeated; run 18 has it (the helper refuses, and the node's
  preview at that height is the claim branch paying Bob).
- Step 3 (Bob's tool offers `claim_noid`, the operator does not send it): as planned.
- Step 4 (the copy): as planned. Started after the real lock was mined, it counted the funding finality from its own
  first tick, took no lock step of its own, adopted the real lock, read the secret from Ethereum, and its `claim.sh`
  proved and sent the close.
- Step 5 (Bob's real tool): **both texts were observed**, the pending one at the tick 23 s after the submit and the
  mined one at the next tick; then `--closed-by` gave `claim_included` and, at finality, `done`. One difference from
  the plan's wording: Bob's file did not "hold the `claim_noid` step". With single ticks the offer is shown but no
  step is recorded (the claim step is recorded by `claim.sh` itself), so `--closed-by` met a file in `secret_seen`
  with nothing held. The held case stays covered by its test only.
- Step 6 (Alice's file follows her claim to `done`): as planned.

## Observations

1. **Anyone can finish Bob's side, and only in Bob's favour.** The third party had no key, no coins and no part of
   the swap. With the public bundle and the secret from Ethereum it made a valid close, and the 4.994200 NOID went to
   the address committed for Bob when the contract was created. This is the recipient rule (design §5, Q2) seen on
   the Parano1d mainnet with a caller who is not Bob: before `D` a close can only pay Bob. It is also why a watching
   service could look for
   the secret and close for a Bob who is offline.
2. **Bob's tool does not fight a close it did not make.** While the foreign close was pending it waited and said it
   would prove again only if that close were evicted. That is the behaviour the first-seen mempool requires: a second
   close for the same instance would be refused by the node anyway.
3. **The tool cannot see by itself whose close it was.** After the close was mined the plain tick said only that the
   instance is gone, and asked for a manual check; the operator has to pass the txid with `--closed-by`. The note is
   honest about what is checked (the txid is confirmed at a height and the instance is gone) and what is not (that
   this txid closed this instance, and the outputs). Here the payout was read from the node separately.
4. **A tick a few seconds after the lock's block can fail.** At 14:04:17, 5 s after the block, Bob's tick ended with
   "getLock shows this lock but eth_getLogs returned no Locked event for it. Right after a lock was mined this is
   usually the provider's log index lagging behind its state, and it clears on the next poll", and Alice's with
   "eth watcher: rpc error 3: execution reverted". Both cleared 30 s later. Bob's text explains itself; Alice's does
   not. Low, wording only.
5. **Timing against run 18.** The same steps with the operator at the keyboard: the funding 33 s after its offer
   (run 18: 14 minutes), the lock 74 s after its offer, the reveal 28 s after its dry run, with 22 minutes of
   window left (run 18: 110 s too late). The reveal window opened 15 minutes after the lock's block, earlier than the
   19 minutes planned for.
6. **Durations.** Funding sent to Bob's side final: 42 minutes 20 seconds. To Alice's side final: 49 minutes 41
   seconds. `prepare.sh` to the end: 54 minutes 35 seconds.

## Not covered

A close that stays pending for long (the stall of Q1: on this idle chain the close was mined within three blocks
of its submit); an eviction and Bob's re-proof after it; `--closed-by` on a Bob file that holds a recorded
`claim_noid` step; a third party on another machine and another node; the two-machine form and the watch loops. The
scratch files of this run, the third party's copy included, are a swap that must never be funded again.
