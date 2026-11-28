# Live run 16 — Alice funds the wrong amount (hostile plan L2, scenario A2), 2026-11-11

> Clock times in this log are UTC. All of them belong to 2026-11-11. The Parano1d tip is given in the `tip` column.

The second run of the hostile-counterparty campaign (`docs/hostile-run-plan.md`, L2). Alice's side prepared a swap for
5 NOID and then funded the contract with 4 NOID. The questions: does Bob's tool refuse to count a real instance of
another amount, does Alice's own tool refuse it too, and does the NOID come back after the deadline. **Yes on all
three.** Bob never locked, both files ended `aborted`, and the 4 NOID came back to Alice's address after the deadline,
less the close fee; the run cost her 14,800 μNOID in fees.

## Setting

5 NOID against 0.001 Sepolia ETH on paper, lock kind `poseidon`, raw variant, contract version 1, profile `sepolia`, one
node per chain (`SINGLE_NODE_OK=1`), the helpers of `scripts/live/` frozen for the run. Sepolia contract
`0x48Ce4D6cf3c175737532017e82B9261b51F8E5eF`, Parano1d contract root
`o10pneqyp85wftceup285kyxhwnzctdle8ped9h46xfw9nkp9jfrxsp7kaa0`. As in run 15: one Windows PC in both roles, ticks by
hand
(Bob's file with `--apply`; Alice's file read-only until her abort text appeared, then applied once). The two spends
(the funding and the recovery) were sent by the operator; everything else was a read or a dry run.

Numbers of the swap: `h_create` 301131, lock-by 301181, last lock height 301223, `D` 301433, log start on Sepolia
12110815.

## What happened

| UTC | tip | who | what |
|---|---|---|---|
| 17:47 | 301107 | Alice | `prepare.sh`, `contract create`, `check-object.sh` ("object file OK"); `fund.sh --dry-run`: "would fund 5.000000 NOID once"; `contract instances`: none |
| 17:50 | 301109 | Alice | **the deviation, sent once by the operator:** `parano1d-cli contract fund swap.object.json 4.000000`, straight to the wallet CLI because `fund.sh` refuses an amount that differs from the swap file's. Txid `2a09b25cfb2d7570cff39c5ae0323baf9362b0fea1b5fa7cffcbb0e68b493793`, fee 9,000 μNOID |
| 17:50:34 | 301110 | both | the funding is in the mempool; Bob: `wait`, "waiting for Alice's funding"; Alice (read-only): `wait`, "node is behind H_create" |
| 17:54:28 | 301117 | Bob | instance: slot 623261, incarnation 787369, 4.000000 NOID. `wait`; note "instance seen but not accepted: instance holds 4000000 micro-NOID, agreed 5000000" |
| 17:54 | 301118 | Alice | read-only: `wait`, "an instance of 4,000,000 micro-NOID sits at our contract root; it is not the agreed one (instance holds 4000000 micro-NOID, agreed 5000000) and is not counted as a funding; not funding until the contract state has been checked" |
| 18:23:03 | 301169 | Bob | still `wait`; note "lock-by margin is short: 12 blocks" |
| 18:23 | 301170 | Alice | applied: `abort`, "too late to fund: tip 301170 + 24 > lock-by 301181"; note "1 instance hold NOID at the contract root: slot 623261 (creation 787369, 4,000,000 micro-NOID). None fits the agreement, so none is this swap's funding; … This tool will not close it."; phase `aborted` |
| 18:51:51 | 301234 | Bob | applied: `abort`, "last lock height 301223 passed before Alice's funding was final"; phase `aborted`; no intent was ever held |
| 18:52 | | Bob | `lock.sh --dry-run`: exit 1, "the swap file has no pending intent; expected lock_eth" |
| 20:31:07 | 301433 | Alice | `recover-noid.sh --dry-run` with `AMOUNT=4000000` as the last line of `env.local.sh`: "preview ok: recovery close, terminal, payout to Alice's own address (amount minus the close fee)"; the preview: `recovery` true, `terminal` true, authority Alice's address, payout 3,994,200 μNOID, fee 5,800 |
| 21:00:33 | about 301493 | Alice | **the recovery, sent once by the operator:** `recover-noid.sh`. Txid `d2b332199fc8ddd4918b56e82223521b317ce94180a046ea427b877f6f0f61b1`, included at 301495; "Confirmed call", "Receipt verified and saved" |
| 21:03:23 | 301499 | Alice | `tick.sh alice --closed-by TXID --apply`: exit 1, "the swap is already `aborted` (terminal): there is nothing to record" |

The recovery was final at 301513 (18 blocks after its inclusion); at tip 301516 the node still listed it at height
301495. Afterwards `contract instances` printed nothing, and Alice's address held 3.994200 NOID in a new output. Her
        balance
went down by 14,800 μNOID: the funding fee (9,000) plus the close fee (5,800),
which is the cost the plan gave.

## Against the plan

- Bob's tool: the expected note, `wait`, then the abort at the last lock height, and the refusal of the lock dry run.
- Alice's tool: the expected `wait` text and the abort with the note that it will not close the instance.
- The recovery: the plan's reading of `recover-noid.sh` was right. With `AMOUNT=5000000` the helper would have refused
  the 4 NOID instance; with `AMOUNT=4000000` as the last line of `env.local.sh` the dry run and the send both passed.
  The line was taken out again afterwards. The manual fallback was not needed.
- `--closed-by` for the recovery: refused, because the file was already `aborted`. The plan left open whether it would
  be a refusal or a note; it is a refusal, and nothing was recorded. The swap file therefore does not hold the txid of
  the recovery; this log and `recovered-txids.txt` of the run folder do.

## Observations

1. **The funding went out before `h_create`** (at tip 301109, 22 blocks early; the instruction was to wait for 301131).
   Neither tool treated the early instance differently: the refusal texts name the amount only. The scenario was not
   affected.
2. **The wallet's active address was not Alice's at the start** (it was the address that receives Bob's payouts). It was
   switched by hand before the funding and stayed on Alice's address until the recovery, which needs it. The funding
   itself would have worked from either address; the recovery would not. A pre-run check of the active address belongs
   in the run list.
3. **A `recover-noid.sh` for an instance of another amount needs an edit of `env.local.sh`.** It worked, but an operator
   under pressure has to know it. A flag for the amount, or the amount read from the instance, would be simpler. Low.
4. **The recovery was sent 60 blocks after `D`**, with no harm: after `D` only Alice can close.
5. **Durations.** `prepare.sh` to Bob's abort: 65 minutes. To the recovery in a block: 3 hours 13 minutes, of which 30
   minutes were the operator's delay after `D`.

## Not covered

The two-machine form; the watch loops; the manual preview-and-send fallback; an instance not larger than the close fee
(which cannot be recovered). The scratch files of this run are a swap that must never be funded again.
