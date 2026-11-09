# Live run 6 — Alice never reveals after Bob's lock, proof-free lock kind (`poseidon`), 2026-11-05 to 2026-11-06

> Clock times in this log are UTC. Times after 00:00 belong to 2026-11-06.

The abort path of run 2, now on public Sepolia with the `poseidon` lock kind (`docs/poseidon-leg.md`) and the Sepolia finality rule
introduced with M2.5b. Scenario 3 of `docs/live-scenarios.md`: Alice funds, Bob locks 0.001 ETH once the funding is final, and
**Alice never reveals**. Expected: Alice's engine offers the reveal while it is safe, then fixes "keep the secret" at the cutoff;
Bob's engine offers the ETH refund once `T_reveal` has passed, and calls the file `refunded` only when Sepolia has finalized the
refund block (until then `refund_mined`); at `D` Alice recovers her NOID. Raw variant, contract version 1, `sepolia` profile, the
owner in both roles, one node per chain (`SINGLE_NODE_OK=1`). The helpers were installed from the last commit
(`git archive HEAD scripts/live`), not from the working tree, because the tree was being edited and the helpers must match the
release binary in use. One detached watch loop ran both roles.

## Parameters

| item | value |
|---|---|
| Profile / variant / contract / lock kind | `sepolia` / raw / version 1 (`HashTimeLock`) / `poseidon` (`HTLCPoseidonV2`), `--single-node-ok` on both chains |
| Amount (NOID) / `max_fee` | 10 NOID (10,000,000 μNOID) / 50,000 μNOID |
| Amount (ETH) | 0.001 ETH (1,000,000,000,000,000 wei) |
| Tip at preparation | 284,334 |
| `h_create` (planned) / `D` | 284,342 / 284,642 (`h_create` + 300) |
| Bob's lock-by | 284,391 |
| Contract root | `o1f4eeqrrs2wc5zqmdp6ht7ln2fx49sk7xjt6xlxru48ywjva43nushg3u7c` |
| Alice (funds, recovers) | wallet index 0 `o1zjj6zqc7…utpurk` |
| Ethereum contract | `HTLCPoseidonV2` `0x48Ce4D6cf3c175737532017e82B9261b51F8E5eF` (the contract of run 5, reused; code hash matched the pin) |
| Lock id | `0xcd5424957ce15355bca0abd14939bf467f293fa9afdf56fba26f01efe0201566` |
| `T_reveal` | 1793920044 (23:07:24), lock time + 4,200 s as in the profile |
| Folder | `~/live-run-6/` in WSL (both swap files, bundle, `loop-alice.txt`, `loop-bob.txt`, `eth-*.json`, `rec/`) |

## Log

- 21:49:52 **Funded**: txid `5e1a7e86937a90b6d267276d051ffb6e0a2cd1fafb2b2979fcd00370470afa69`, fee 9,000 μNOID. 21:52:03 the
  instance is visible at tip 284,336 (slot 632,076, creation id 752,171, 10,000,000 μNOID, matches the opening): `funded`.
- 21:57:24 Alice `funding_final` (tip 284,353). 21:57:32 Bob's engine: **`lock_eth`**.
- 21:58:28 **Bob's lock**: dry run first (checked), then the send; tx
  `0x30cef37aa31a75b9dc86ae6565ec109d952cd08112d292a93f6fb708e27093d8`, Sepolia block 12,072,287. 21:59:05 Alice sees it
  (`lock_seen`); 21:59:20 Bob: `locked`, "waiting for the secret (or T_reveal)".
- 22:13:39 Lock final on Sepolia, tip 284,387: Alice's engine says **`reveal_eth`**. The operator did not send it. The engine
  then held the offered intent ("the chain does not show it yet") on every tick, which is the expected reading when nothing was
  sent.
- By 23:09:20 (tip 284,499) the reveal cutoff had passed: Alice's engine says **"reveal cutoff passed; keeping the secret and
  waiting for D"** and kept saying it until `D`. No reveal was ever sent.
- 23:07:51 Bob's engine, tip 284,491, first tick past `T_reveal`: **`refund_eth`**. Dry run, then the send at 23:09:04: tx
  `0xb949fc46976c5a62319fad0bcd5c344bf833ed3563e1d568e4c3b8f867e5d501`, Sepolia block 12,072,632.
- 23:09:30 Bob's file **`refund_mined`**: "ETH refund mined at block 12072632; waiting for Ethereum finality" (finalized block
  then 12,072,542). It stayed non-terminal on every tick until 23:23:46, tip 284,523, when Sepolia finalized the block: **`refunded`**
  ("done: ETH refunded"). About 14 minutes between the two phases.
- 00:22:43 Alice's engine, tip 284,641: **`refund_noid`** (call height 284,642, fee 5,800 μNOID). The recovery close was previewed
  (recovery true, terminal true, fee 5,800 μNOID, payout 9,994,200 μNOID to Alice) and sent chained with the payout address and the
  fee re-checked; it was built for call height 284,643: txid
  `62a02bc5528cd3d603690c3ea1164915002a1231c43fc834e977e045d1bf617a`.
- 00:25:12 The instance is gone at tip 284,644 (close confirmed at 284,644); the receipt verifies. Recorded with
  `tick --closed-by`: 00:25:49 `refund_included` (tip 284,646), 00:30:43 tip 284,661: Alice's file **`refunded`** ("done: NOID
  refunded"). Both watch loops had been running since 21:50; Bob's loop kept ticking `refunded` until the end.
- Single failed polls (exit 1, each followed by an exit 0 on the next tick): 6 in Alice's loop, 5 in Bob's.

## Result

| leg | outcome |
|---|---|
| ETH (Bob) | refund tx `0xb949fc46…d501`, Sepolia block 12,072,632, finalized by 23:23:46; the lock is `refunded`, no preimage on chain |
| NOID (Alice) | recovery close txid `62a02bc5…617a`, call height 284,643, confirmed at 284,644; 9,994,200 μNOID back to Alice (10 NOID − 5,800 μNOID close fee) |
| Alice's file | `created` → `funded` (284,336) → `funding_final` (284,353) → `lock_seen` (284,355) → `lock_final` (284,387) → `refund_included` (284,646) → `refunded` (284,661, 00:30:43) |
| Bob's file | `received` → `funded` (284,336) → `funding_final` (284,353) → `locked` (284,355) → `refund_mined` (284,499) → `refunded` (284,523, 23:23:46) |
| Cost | Alice 0.0148 NOID (9,000 μNOID funding fee + 5,800 μNOID close fee); Bob paid Sepolia gas for the lock and the refund |
| Wallet balance | the wallet's total changed during the run because of an unrelated transfer by the owner; the result is stated per coin (the recovered 9.9942 NOID coin at height 284,644), not by the wallet total |
| Time | about 2 h 41 from funding (21:49:52) to Alice's file `refunded` (00:30:43); Bob's side was final 1 h 34 after funding |

Operational notes from the run:

- The Ethereum refund was offered one tick after `T_reveal` and was a normal transaction on a lock with no preimage; the engine
  did not call it done at inclusion. The new intermediate phase was visible on every tick between 23:09:30 and 23:23:46.
- The recovery close was previewed and sent as one chained step (the lesson of run 2); the first attempt was not dropped.
- Helpers from `git archive HEAD` kept the helpers and the binary in step while the working tree was being edited.

## What it showed

- Both abort paths are now seen on real chains: before any lock (run 4) and after Bob's lock (runs 2 and 6), the latter on public
  Sepolia with the proof-free lock kind. Neither party could lose funds: Bob's refund was open from `T_reveal`, Alice's recovery
  from `D`, and the cost was gas on one side and 14,800 μNOID on the other.
- The `refund_mined` → `refunded` rule works live: Bob's file stayed non-terminal until Sepolia finalized the refund block, the
  first live use of that phase.
- Alice's cutoff works live: after it the engine refuses to offer the reveal and says it is keeping the secret until `D`; the
  secret never left the swap file.

## What it did not show

- Two nodes per chain (`SINGLE_NODE_OK=1`, one node each) and a hostile counterparty (the operator played both roles).
- The reveal-then-revert case, a reorg of the refund block, an eviction, or a late reveal racing the refund.
- Contract version 2, the stock variant, the rotation guard, the minimum-fee close, the `production` profile and mainnet.
