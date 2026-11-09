# Live run 4 — Alice aborts before any Ethereum lock (Bob never locks), 2026-11-05

> Clock times in this log are UTC, checked against the Ethereum block timestamps in the recordings.

Scenario 1+2 of `docs/live-scenarios.md` (Alice-abort before Bob locks, merged with "Bob never locks"): the owner as Alice
funds 10 NOID into a `HashTimeLock`, **Bob never appears** (no Bob file, no Sepolia transaction at all), and Alice takes the
NOID back at `D`. Expected: Alice's engine waits in `funding_final` ("waiting for Bob's lock") without ever aborting, offers
`refund_noid` at the first poll with tip + 1 ≥ `D`, her recovery close pays the amount minus the 5,800 μNOID close fee to her
index-0 address, `tick --closed-by` records it, and the file ends `refunded` once the close is final (18 blocks). Cost bound:
9,000 μNOID funding fee + 5,800 μNOID close fee = 14,800 μNOID. No equivalence proof was needed (the proof exists for Bob's
benefit); `prepare.sh` wrote Alice's file, the bundle and the definition in under a minute.

## Parameters

| item | value |
|---|---|
| Profile / variant / contract | `sepolia` / raw / version 1 (`HashTimeLock`), `--single-node-ok` for the Parano1d side |
| Amount / `max_fee` | 10 NOID (10,000,000 μNOID) / 50,000 μNOID |
| Tip at preparation | 283,864 |
| `h_create` (planned) / `D` | 283,872 / 284,172 (`h_create` + 300) |
| Bob's lock-by, nominal / hard | 283,921 (`D − 251`) / 283,963 (`D − 209`); never used |
| Hashlock | `0x374b8bf0…b524` |
| Contract root | `o1kue486qmnh45ag8glx0hgvh8r8n2m2jv48wlqzj2wxa28a4268csdnfh7w` |
| Alice (funds, recovers) | wallet index 0 `o1zjj6zqc7…utpurk` |
| Ethereum side | Sepolia (chain id 11155111), HTLC `0x4892…6Ec48` with the pinned code hash of run 3; read by the engine, nothing sent |
| Folder | `~/live-run-4/` in WSL (Alice's file, bundle, `loop-alice.txt`, `rec/` = the raw node answers of every tick) |

## Log

- 17:49:14 Alice's file and bundle written (`prepare.sh`, no proof); `check-object.sh` OK before funding.
- 17:49:49 **Funded**: txid
  `9e5403b2abf4fc73e5a36e600f06e65a0e7dd6f47cee57d3eec88ecb6b0faa9c`, fee 9,000 μNOID.
- 17:50:35 First tick of the watch loop (every 65 s or so): tip 283,865, instance not visible yet, `created`, "node is
  behind H_create". 17:51:40 instance visible at tip 283,866 (slot 620,540, creation id 750,857, 10,000,000 μNOID,
  matches the opening): `funded`. The funding was included six blocks before the planned `h_create`; `D` is committed in the
  opening, so nothing moves.
- 18:00:01 Tip 283,884: `funding_final`, "waiting for Bob's lock". From here 136 ticks say exactly that.
- 18:19:45 Tip 283,921 (nominal lock-by) and 18:41:32 tip 283,963 (hard limit) pass with no lock and no Bob: the engine
  stays put (Alice has nothing to abort once she has funded; the recovery opens at `D`).
- 20:28:55 Tip 284,173 (the first poll after the tip reached `D − 1` = 284,171): action **`refund_noid`**, call height
  284,174, fee 5,800 μNOID; the ledger records the intent. Loop continues (`tick --apply`).
- 20:31:12–20:32:22 **Recovery close**, owner at the wallet: `contract call … --close --preview` showed recovery true,
  terminal true, authority Alice, fee 5,800 μNOID, payout 9,994,200 μNOID to Alice's index-0 address; the payout address
  and the fee were re-checked in the same command, and preview and send were **chained in one command** (run 2's lesson).
  Built for call height 284,177 (the engine's printed 284,174 was already behind the tip), txid
  `47cbaa725a3cda8bffb48f17789e0a48823c9db55e096458f141f45032b796ff`.
- 20:30:05–20:34:41 Five ticks hold the intent ("held: fresh decision was refund_noid", frozen parameters printed). 20:32:22
  the close is pending on the node (tip 284,178); the tip then stays at 284,178 for three polls (to 20:34:41).
- 20:35:52 Tip 284,186: the instance is gone; the close was **confirmed at height 284,179** (D + 7). The intent resolves;
  the action is "the instance is not visible, so there is nothing to refund" (the F-4 guard, working as designed).
  Receipt made, verified and saved.
- 20:37:04 `tick.sh alice --closed-by 47cbaa72… --apply`: phase `refund_included` ("waiting for NOID refund finality").
- 20:41:43 Tip 284,197 (= 284,179 + 18): event `noid_tx_final`, phase **`refunded`**, "done: NOID refunded". The watch loop
  stopped on its own ("all watched files terminal"). 157 ticks, every one with exit 0, no gap above 90 s.

## Result

| leg | outcome |
|---|---|
| NOID (Alice) | funded 10 NOID at 17:49:49 (visible at 283,866); recovered at 284,179 (`D` + 7 blocks): 9,994,200 μNOID back to index 0, close fee 5,800 μNOID, receipt verified |
| ETH (Bob) | nothing: no lock, no Sepolia transaction by either side |
| Alice's file | `created` → `funded` (283,866) → `funding_final` (283,884) → `refund_included` (20:37:04) → `refunded` (284,197, 20:41:43) |
| Wallet balance | 2,038.917590 → 2,038.902790 NOID: cost 0.014800 NOID = 9,000 μNOID funding fee + 5,800 μNOID close fee, as bounded |
| Funds at the contract | none left; no NOID was ever at risk beyond the 14,800 μNOID bound |

Operational notes from the run:

- The watch loop must run as a **detached process**: a tool-bound background job is killed after ten minutes, and this run
  lasts almost three hours. `watch.sh` (started detached) did the whole run and stopped on the terminal phase.
- The versioned helpers of `scripts/live/` were used on a live run for the first time (`install.sh`, `setup.sh`, `prepare.sh`,
  `check-object.sh`, `tick.sh`, `watch.sh`).
- The operator UI (`ui/app`) displayed the run from the run folder (header, next action, phase timeline, deadline countdown).
- The first start of WSL failed for lack of memory while other jobs were running; it worked on the second try. (8 GB machine:
  one heavy job at a time.)

## What it showed

- The abort path with NOID at the contract and nothing on Ethereum: Alice's engine neither aborts nor offers a refund early,
  stays in `funding_final` past both lock-by heights, and offers `refund_noid` at the first poll after `D − 1`.
- The recovery branch opens exactly at `D` and needs nothing from Bob; `tick --closed-by` followed the wallet's close to a
  final `refunded` with the 18-block finality, and the intent ledger held the printed parameters until the chain showed them.
- Preview and send chained in one command removed the dropped-attempt problem of run 2 (no retry was needed).
- The helpers, the loop and the UI hold up on a real run of almost three hours with no failed tick.

## What it did not show

- Bob's side: no Bob file, no `lock_eth` offered or refused after the lock-by heights, no check that `lock.sh --dry-run`
  refuses after `h_create` + 91 (the "extra check for Bob's side" of scenario 1+2 in `docs/live-scenarios.md`). Bob-abort stays open.
- Any Ethereum transaction on Sepolia, the stock variant, contract version 2, the `production` profile, a reorg or an eviction
  on the Parano1d side, the rotation case, a conflicting close. The abort path after Bob's lock was run 2 (local chain).
- The call-height difference (engine 284,174, sent 284,177) was harmless because the recovery branch accepts any height
  from `D` on; the run says nothing about a close that the tip overtakes between preview and send, since the chained command
  never let that happen.
