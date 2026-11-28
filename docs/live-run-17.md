# Live run 17 — Bob locks with a too-short timelock (hostile plan L3, scenarios B5 and B8), 2026-11-15

> Clock times in this log are UTC. All of them belong to 2026-11-15. The Parano1d tip is given in the `tip` column.

The third run of the hostile-counterparty campaign (`docs/hostile-run-plan.md`, L3). Alice funded 5 NOID as agreed.
Bob then ignored his tool's lock and made one by hand whose timelock left Alice about 28 minutes to reveal, where the
agreement needs at least 56 (`W_A_min` 3360 s). A timelock is the time after which the locker can take his coins back;
if it is too short, Alice could reveal the secret and still lose the ETH to Bob's refund. The questions: does Alice's
tool refuse to reveal against such a lock (check I3), what does Bob's own tool do with a lock made outside it, and is
an early refund refused. **Alice's tool refused for the whole run and never offered the reveal; Bob's tool adopted the
lock and later offered the refund; the early refund was refused by the tool and by the contract's own time rule.**
Bob's ETH was refunded after the timelock, Alice's NOID was recovered after the deadline. No secret was revealed.

## Setting

5 NOID against 0.001 Sepolia ETH, lock kind `poseidon`, raw variant, contract version 1, profile `sepolia`, one node
per chain (`SINGLE_NODE_OK=1`), the helpers of `scripts/live/` frozen for the run. Sepolia contract
`0x48Ce4D6cf3c175737532017e82B9261b51F8E5eF`, Parano1d contract root
`o1pgr7qyjwurwy4rnlh39kypr9aj249ahuluy9fqu94zhhtd6mc03s5s5p69`. As in runs 15 and 16: one Windows PC in both roles,
ticks by hand (Bob's file with `--apply`; Alice's file applied at the funding and at the recovery, read-only in
between). The four spends (the funding, the hand-made lock, the ETH refund, the recovery) were sent by the operator;
everything else was a read or a dry run. The wallet's active address was Alice's for the whole run.

Numbers of the swap: `h_create` 312612, lock-by 312662, last lock height 312704, `D` 312914, log start on Sepolia
12139225, lock word `0x773095addd34ec2888f2485990a6adeed914c1cdccb971a4d16e74f809bf0058`.

## What happened

| UTC | tip | who | what |
|---|---|---|---|
| 17:27:44 | 312602 | Alice | `prepare.sh`, `contract create`, `check-object.sh` ("object file OK"); `fund.sh --dry-run` passed; `contract instances`: none |
| 17:32:57 | 312612 | Alice | applied: `fund_noid` offered and recorded |
| 17:36:08 | 312619 | Alice | **the funding, sent once by the operator:** `fund.sh`. Txid `7c27af8fc8485c1939c6ac3275866dc6c89842550f30951b34cd2a32201dd08e`, fee 9,000 μNOID; pending in the mempool, the intent is held |
| 17:39:08 | 312627 | both | instance: slot 9703791, incarnation 808024, 5.000000 NOID; both files `funded` |
| 17:49:56 | 312645 | Bob | `noid_funding_final`; `lock_eth` offered and recorded with the tool's own `T_reveal` (1794769188, about 70 minutes ahead). The producer screen warned and, in this profile, did not refuse (largest address 48.4 % and 45.2 % of the two windows). Alice: `wait`, "waiting for Bob's lock" |
| 17:50 | | Bob | **the deviation, prepared:** a hand-made `live.js lock` without `--swap`, with `--t-reveal` = the time of the latest Sepolia block (12141816, 1794765024) + 1800 s = 1794766824. Its dry run passed (the contract accepts any future timelock) |
| 17:51:55 | about 312648 | Bob | **the deviation, sent once by the operator.** Tx `0x5bfac552944fe2678afa7868859b23665801ecb239a42ad79b0f649231271120`, Sepolia block 12141824 (timestamp 1794765120), lock id `0x010d958c70d32a3522a068a6be0c7a9df0a641bdcbb58db787524769237cb233`. The tool wrote its per-user lock record before the broadcast (see observation 1) |
| 17:52:28 | 312649 | Bob | applied: `eth_lock_seen`, phase `locked`, "waiting for the secret (or T_reveal)". The file adopted the hand-made lock; the pending `lock_eth` intent was resolved |
| 17:52 | 312650 | Alice | read-only: `wait`, "Bob's lock did not pass the checks"; note "lock rejected: T_reveal 1794766824 is only 1704 s after its block (timestamp 1794765120), less than W_A_min 3360 s (I3)" |
| 17:53:09 | | Alice | `reveal.sh --dry-run`: exit 1, "the swap file has no pending intent; expected reveal_eth" |
| 17:53 | | Bob | `refund-eth.sh --dry-run`: exit 1, "the swap file has no pending intent; expected refund_eth". The explicit `live.js refund --dry-run` for the lock id: "too early: timelock is 1794766824 (2026-11-15T18:20:24.000Z), latest block timestamp is 1794765180; 1644 s to go". `lock.sh --dry-run`: exit 1, "the swap file has no pending intent; expected lock_eth" |
| 18:21:31 | 312713 | Bob | applied: `refund_eth` offered and recorded (not held behind the old `lock_eth` intent); `refund-eth.sh --dry-run` passed |
| 18:32 | | Bob | **the ETH refund, sent once by the operator:** `refund-eth.sh`. Tx `0x03c16dfc2d248e284ef6cc2f3e901db145d5e99adc62d08162051b3c8e48de06`, Sepolia block 12142023 |
| 18:32:52 | 312731 | both | Bob: `refund_mined`. Alice (read-only): still `wait`, with the note "Bob's lock is already closed" |
| 18:54:24 | 312773 | Bob | `eth_refund_final`, "done: ETH refunded", phase `refunded` (terminal) |
| 20:04:07 | 312913 | Alice | applied: event `noid_instance_alive_at_d`, `refund_noid` offered and recorded (`call_height` 312914, fee 5,800) |
| 20:04:15 | 312913 | Alice | `recover-noid.sh --dry-run`: "preview ok"; the preview: `recovery` true, `terminal` true, authority Alice's address, payout 4,994,200 μNOID, fee 5,800 |
| 21:21:45 | about 313079 | Alice | **the recovery, sent once by the operator:** `recover-noid.sh`. Txid `bf27a7aaf0ce2b83e9650e78992694ed9c0aa46c36dab3a35b2db5edd55f3678`, included at 313081; "Confirmed call", "Receipt verified and saved" |
| 21:26:29 | 313087 | Alice | `tick.sh alice --closed-by TXID --apply`: event `noid_closed_externally` at 313081, the `refund_noid` intent resolved, phase `refund_included`, `wait` "waiting for NOID refund finality" |
| 21:32:26 | 313100 | Alice | applied: `noid_tx_final`, "done: NOID refunded", phase `refunded` (terminal). The recovery was final from tip 313099 (18 blocks after its inclusion) |

Afterwards `contract instances` printed nothing. Alice's balance went down by 14,800 μNOID: the funding fee (9,000)
plus the close fee (5,800), which is the cost the plan gave. On the Ethereum side
Bob paid the gas of one lock and one refund (the estimates of the dry runs were 600,162 and 158,608 gas) and got his
0.001 ETH back.

## Against the plan

- Alice's tool (step 3): the expected I3 note with the real timestamps, `wait`, and the refusal of the reveal dry run.
  It held until `D`: at no tick was a `reveal_eth` offered. The number in the note is 1704 s and not 1800 s because the
  check measures from the block that holds the lock, and the lock landed 96 s after the block its timelock was
  computed from. That is the right reference: it is the time Alice really has.
- Bob's tool (step 4): the plan left open which of two paths the file takes. It **adopted** the lock: in
  `funding_final`, with the `lock_eth` intent still pending, a lock of his sender on the agreed terms is taken whatever
  its `T_reveal`. The intent was resolved by the adoption, so the later `refund_eth` was **not** held behind it, and
  step 6 used the normal `refund-eth.sh`.
- The early refund (step 5): both refusals as expected, the helper's at the intent check and `live.js`'s "too early"
  with the seconds to go.
- The second lock (end of step 4): `lock.sh --dry-run` was refused, but earlier than the plan named: at the intent
  check, because the adoption had resolved the intent. The check in `live.js` that refuses a second lock of the same
  sender under the same lock word was therefore **not reached** in this run. It stays covered by tests only.
- The recovery (step 7): dry run, send, `--closed-by` as planned. Unlike run 16, `--closed-by` was accepted, because
  the file was not terminal.

## Observations

1. **The per-user lock record was written by a real lock for the first time.** The hand-made lock had no `--swap`, so
   since T21-23 it writes the per-user record before the broadcast. The result of the send named it:
   `<account home>/.noid-swap/lock-sent/11155111-<sender>-<lock word>.json`, with `swap_file` null and the nonce of
   the send. This is the Windows-native path of `live.js` on the account's real home, not a test folder. The record
   was left in place after the refund (clearing it needs two reads of the contract; nothing in this run needed it).
2. **A Bob who makes his own short lock hurts only himself.** Alice's tool never reveals against it, so he pays the
   gas of a lock and a refund and waits for his timelock. Alice waits until `D` for her NOID and pays her two fees
   (14,800 μNOID): that is the cost a hostile Bob can impose, the same as a Bob who never locks.
3. **Bob's tool does not judge his own lock's timelock.** It adopts it and waits. That is correct for his side (the
   short timelock is in his favour), and the file tracked the lock through refund and finality without a hand edit.
4. **`live.js status` could not be used in this run.** With `--chain-id` it answered "unknown flag --chain-id for
   status"; without it "error: could not coalesce error". Not looked into; the ticks gave the same facts. Low, open.
5. **The recovery was sent about 165 blocks after `D`** (included 167 after), with no harm: after `D` only Alice can
   close.
6. **Durations.** `prepare.sh` to Bob's refund final: 87 minutes. To the recovery in a block: about 3 hours 55
   minutes, of
   which about 77 minutes were the operator's delay after `D`.

## Not covered

The two-machine form; the watch loops; the phase `lock_submitted` at the moment the hand-made lock lands (the other
path of step 4); a short lock made after the lock-by; the `live.js` duplicate-lock check on a real chain. The scratch
files of this run are a swap that must never be funded again.
