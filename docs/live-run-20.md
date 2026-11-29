# Live run 20 — the second node drops at Bob's lock, and a rotation before Bob's claim (hostile plan L5 and L6), 2026-11-16

> Clock times in this log are UTC. All of them belong to 2026-11-16. The Parano1d tip is given in the `tip` column.

The last run of the hostile-counterparty campaign (`docs/hostile-run-plan.md`, L5 and L6 in one run). Two things were
forced in one swap. **First, the second node goes away at Bob's lock.** Before Bob locks his ETH, his tool asks a
second, independent Parano1d node whether it sees the same funded contract, so that one lying node cannot make him
lock against nothing. If that node cannot be read, the tool must not offer the lock. **Second, an epoch rotation just
before Bob's claim.** Every 144 blocks the chain changes the anchor that each authorization proof is tied to; a
claim proved just before the change would be thrown out of the mempool. The tool must wait for the change and prove
after it. **Both held on the real chain: with the link to the second node closed, the lock was refused at three
ticks and offered at the first tick after it came back; three blocks before a rotation the tool refused to prove the
claim, and it proved and sent it after the rotation.** The swap settled: 5 NOID against 0.001 Sepolia ETH.

The rotation test needed two tries inside the run. The reveal was placed to land a few blocks before the rotation at
315360 and landed one block after it, so the tool had nothing to wait for. Bob's claim was then held on purpose for
the next rotation, at 315504, where the test was made.

## Setting

5 NOID against 0.001 Sepolia ETH, lock kind `poseidon`, raw variant, contract version 1, profile `sepolia`, **two
nodes per chain and no `SINGLE_NODE_OK`**, the helpers of `scripts/live/` frozen for the run. Sepolia
contract `0x48Ce4D6cf3c175737532017e82B9261b51F8E5eF`, Parano1d contract root
`o1wwdy75hlm4mww76a7lpyt4aa54twar8e4fmkvshdzsz3668586rsd0yzqm`. Both roles on one Windows PC, ticks by hand (Bob's
file with `--apply`; Alice's file applied at the funding, at the reveal and after it). The four spends (the funding,
the lock, the reveal, Bob's claim) were sent by the operator; everything else was a read or a dry run.

The second Parano1d node ran on a second machine with another operating system and was reached through an SSH port
forward to a local port of the PC (`NOID_RPC2`, `NOID_RPC2_REMOTE=1`, which passes `--noid-rpc2-is-remote`). The
second Ethereum node was a second public Sepolia endpoint (`ETH_RPC2`). Before the run both Parano1d nodes gave the
same height. "The tunnel" below is that port forward; closing it means ending its process on the PC.

Numbers of the swap: `h_create` 315272, lock-by 315322, last lock height 315364, `D` 315574, log start on Sepolia
12145815 (the lower of the two nodes' answers), lock word
`0xfd093a626f594a5d54cf931400b8e400480f3cfeee7e825a38f53af4ab8b7648`. Rotation heights inside the window: 315360 and
315504 (multiples of 144).

## What happened

| UTC | tip | who | what |
|---|---|---|---|
| 15:44:09 | 315258 | Alice | `prepare.sh`, `contract create`, `check-object.sh` ("object file OK"); `fund.sh --dry-run` passed |
| 15:53:36 | 315274 | Alice | applied: `fund_noid` offered and recorded. Every tick of this run carried the same-host note (see observation 4) |
| 15:56:06 | about 315277 | Alice | **the funding, sent once by the operator:** `fund.sh`. Txid `6a775ed3b50641b47da1c5f45416fa9ff52f203712a88715ca7c03918200b52e`, fee 9,000 μNOID, included at 315280 |
| 15:57:22 | 315280 | both | instance: slot 593639, incarnation 812726, 5.000000 NOID; both files `funded` (Bob at tip 315280, Alice at 315281) |
| 16:03:27 | 315297 | | **the tunnel was closed on purpose**, one block before Bob's funding finality |
| 16:04:54 | 315300 | Bob | **tick 1 without the second node:** `noid_funding_final` recorded; `wait`, "the second node could not be read (parano1d watcher (second node): transport: connect … curl: (7) Failed to connect to 127.0.0.1:19601 …): it must agree before this step (F5)"; note "not lock_eth: … (fail closed)". No step recorded |
| 16:04:59 | | Bob | `lock.sh --dry-run`: exit 1, "the swap file has no pending intent; expected lock_eth" |
| 16:05:23 | 315300 | Bob | **tick 2:** the same `wait` and the same note |
| 16:05:52 | 315302 | Bob | **tick 3:** the same `wait` and the same note |
| 16:06:20 | | | the tunnel was opened again; both nodes at 315303 |
| 16:06:36 | 315303 | Bob | `lock_eth` offered and recorded (`T_reveal` 1794849396, 17:16:36); note "second Parano1d node agrees: … at height 315303 (first node 315303), slot 593639 creation 812726 amount 5000000". The producer screen warned and, in this profile, did not refuse (largest address 47.9 % of the last 2,880 blocks and 41.0 % of the last 720). `lock.sh --dry-run` passed |
| 16:07:24 | about 315305 | Bob | **the lock, sent once by the operator:** `lock.sh`. Tx `0x285e560bee0e0d3173e7318d58ca16307d823d303446d482541fd564fc6ed3dc`, Sepolia block 12148402 (timestamp 1794845244), lock id `0x14583c8e5984aa9030a39bac781db780982fa2701da773f2502fbb20ac77b048` |
| 16:07:57 | 315306 | both | Bob: `eth_lock_seen`, phase `locked`. Alice (read-only): `noid_funding_final`, `eth_lock_seen`, "waiting for Bob's lock to be finalized" |
| 16:20:58 | | | Sepolia's finalized block (12148404) passed the lock's block |
| 16:21:21 | 315333 | Alice | applied: `reveal_eth` offered and recorded, cutoff 1794847596 (16:46:36); note "second Ethereum node agrees: … finalized 12148404 (first node finalized 12148404), lock … final at the lower of the two". `reveal.sh --dry-run` passed, with 1,512 s to the cutoff by the tool's count |
| 16:31:24 | 315353 | Alice | the reveal was held back on purpose until here, 7 blocks before the rotation at 315360 |
| 16:35:04 | about 315360 | Alice | **the reveal, sent once by the operator**, 3 minutes 40 seconds later: `reveal.sh`. Tx `0x67daf0bd42aa9d18c0c478a2506c3cb7880801cb4d6acf0bb32da301b584aa3f`, Sepolia block 12148541 |
| 16:35:35 | 315361 | both | Bob: `eth_preimage_seen`, `claim_noid` offered (`call_height` 315362), phase `secret_seen`. Alice: `eth_claim_mined`, phase `revealed`. **The rotation at 315360 was already behind the tip: no wait was shown.** `claim.sh` (dry run) at 16:35:51 proved a claim for `call_height` 315363 |
| | | Bob | **decision: the claim is held for the next rotation, at 315504** (it had to be in a block by `D - 19` = 315555) |
| 17:07:28 | 315426 | both | Alice: `eth_claim_final`, "done: ETH received; the NOID is still at the contract, refund_noid opens when the next call height reaches D 315574 if Bob has not claimed it", phase `done`. Bob: `claim_noid` still offered |
| 17:42:12 | 315496 | Bob | `claim.sh` (dry run), 8 blocks before the rotation: proved, `call_height` 315497 |
| 17:45:41 | 315501 | Bob | **tick, 3 blocks before the rotation:** `wait`, "epoch anchor rotates in 3 block(s); proving after the boundary (T6)" |
| 17:45:48 | 315501 | Bob | **`claim.sh` (dry run):** the same `wait`, and "claim": "not attempted: the engine's action is not claim_noid" |
| 17:52:07 | 315505 | Bob | `claim.sh` (dry run), one block after the rotation: proved and self-verified, `call_height` 315506, recipient Bob's payout address, 4,994,200 μNOID, fee 5,800 |
| 17:53:03 | about 315510 | Bob | **the claim, sent once by the operator:** `claim.sh --submit`. Txid `786229553508f10522b3a46e1a94457216bcde6a7461738733dd770fad4a5b1b`, `call_height` 315512, sent to both nodes and accepted by both |
| 17:53:23 | 315511 | Bob | `wait`, "NOID claim pending", phase `claim_submitted` |
| 17:55:18 | 315513 | Bob | `noid_tx_included` at 315513, phase `claim_included`. Read from the node: a new coin of 4.994200 NOID on Bob's payout address (slot 9757501) |
| 18:02:28 | 315533 | both | Bob: `noid_tx_final`, "done: NOID received", phase `done`. The claim was final from tip 315531 (18 blocks after its inclusion), 43 blocks before `D`. Alice: `done` |

Afterwards `contract instances` printed nothing. Alice's NOID balance went down by 5.009000 (the 5
NOID and the funding fee of 9,000 μNOID). Bob's payout address received 4.994200 NOID (5 minus the close fee of
5,800). On Sepolia Alice's test address went from about 0.012 to about 0.013 ETH and Bob's from about 0.0395 to about
0.0385 ETH.

## Against the plan

- **L5, step 2** (the tunnel stopped just before the tick that would offer the lock): the expected `wait` with the
  F5 text at three ticks, with the transport's own error inside the brackets; `lock.sh --dry-run` refused because no
  step was recorded. The funding-finality event itself was recorded at the first of these ticks: the rule holds back
  the offer of the lock, not the reading of the first node.
- **L5, step 3** (the tunnel restored): the first tick offered `lock_eth` and said that the second node agrees, with
  the instance it compared.
- **L6** (`live-scenarios.md` 6): the wait text appeared with N = 3 at a tick and at the claim dry run, and the claim
  was proved after the boundary, with `call_height` 315512 above 315504, and it was final at 315531, before
  `D - 19` = 315555. The plan's form (the reveal a few blocks before the boundary) was missed at 315360 and
  replaced by holding the claim for 315504. For the guard this is the same test: it looks at the tip and the next
  boundary, not at when the secret became public.

## Observations

1. **Without the second node Bob's tool does not lock, and it says why.** The refusal is the tool's own (the first
   node was healthy and showed the funding final). An operator who sees this text has one thing to fix, the link to
   the second node; two to three blocks after it was back the lock was in a Sepolia block.
2. **The lock's time budget absorbed the outage.** Bob's file recorded the funding as final at tip 315300 and the
   lock was offered at 315303. In this profile the tool gives up 20 blocks after it recorded the funding as final,
   here after 315320, so the outage had 17 blocks of room left. A longer one ends with Bob not locking at all and
   Alice recovering at `D`: the safe direction. (Corrected 2026-11-16: this paragraph first named the lock-by and
   `h_create + 92` as the limits; `h_create + 92` applies only while no funding has been seen.)
3. **A reveal cannot be placed to the block by hand.** The reveal was due 7 blocks before the rotation and was
   sent 3 minutes 40 seconds later, by which time 7 blocks had passed (about one every 31 s). Later in the run
   four blocks took more than 6 minutes and the next six took 76 seconds. A test that depends on a tip within a few
   blocks of a boundary should be made on the step the tool can wait with (Bob's claim), as here, not on Alice's
   reveal.
4. **The same-host note is printed on every tick** of a run with a tunnelled second node (both endpoints are on
   `localhost`); with `--noid-rpc2-is-remote` its text says that the tool cannot verify the claim that the node is on
   another machine (G3). Correct, and long: it crowds the other notes. Low, wording only (known from run 12).
5. **Holding a claim is visible on the other side.** While Bob's claim was held, Alice's finished file said that the
   NOID is still at the contract and when `refund_noid` would open. Nothing in either tool pushes Bob; the only
   deadline is `D - 19`. A Bob who waits that long for no reason gives up his margin against a stalled close (Q1).
6. **The guard's edge was not measured.** The dry run proved at 8 blocks before the boundary and waited at 3; the
   ticks in between were not made. The documented edge is 4 blocks.
7. **Durations.** Funding sent to Alice's side final: about 59 minutes (16:55, seen at the 17:07 tick). Reveal to
   Bob's claim sent: 78 minutes, almost all of it the deliberate hold. `prepare.sh` to the end: 2 hours 18 minutes.

## Not covered

The tunnel lost after the `lock_eth` step was already recorded (the plan says the dry run then does not refuse); a
second node that answers but disagrees; the second Ethereum node missing at the reveal or at Bob's read of the secret;
a claim already pending when the anchor rotates (it would be evicted and proved again); posting a claim proved before
the rotation after it (`live-scenarios.md` 6, optional); the two-machine form with Bob on the second machine; the
watch loops. The scratch files of this run are a swap that must never be funded again.
