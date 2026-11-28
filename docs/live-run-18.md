# Live run 18 — first try at the third-party close (hostile plan L4): the reveal came too late, clean abort, 2026-11-15

> Clock times in this log are UTC. The run started on 2026-11-15 and ended after midnight, on 2026-11-16; the rows
> after midnight are marked. The Parano1d tip is given in the `tip` column.

The fourth run of the hostile-counterparty campaign (`docs/hostile-run-plan.md`, L4). The plan: a normal swap up to
Alice's reveal, then a third party (anyone who read the secret on Ethereum) closes the Parano1d contract before Bob
does, and Bob's tool has to read that close and record it. **The run did not get that far.** The operator sent
Alice's reveal 110 seconds after its cutoff and the tool refused it. The reveal is the step in which Alice publishes
the secret on Ethereum to take the ETH; its cutoff is the last moment at which that is still safe for her. Nothing was
revealed, the pending step was cancelled, and both sides took their coins back: Bob's ETH after his timelock, Alice's
NOID after the deadline `D`. **L4's own questions (the third-party close, Bob's `--closed-by`) are not answered and
need a second run.** What the run did show: a late funding, a lock one block after the nominal lock-by, a third
party's copy of Bob's file following the real lock, the recovery dry run before `D` (scenario A9), and the tool's
refusal of a late reveal on a real chain.

## Setting

5 NOID against 0.001 Sepolia ETH, lock kind `poseidon`, raw variant, contract version 1, profile `sepolia`, one node
per chain (`SINGLE_NODE_OK=1`), the helpers of `scripts/live/` frozen for the run. Sepolia
contract `0x48Ce4D6cf3c175737532017e82B9261b51F8E5eF`, Parano1d contract root
`o16yae3pfcaz4gumqvasgtr38phy3fvz0l49ygxlxftlua0tzy62qqfzc8nd`. As in runs 15 to 17: one Windows PC in both roles,
ticks by hand (Bob's file with `--apply`; Alice's file applied at the funding, at the reveal and at the recovery,
read-only in between). The four spends (the funding, the lock, the ETH refund, the recovery) were sent by the
operator; everything else was a read or a dry run. The wallet's active address was Alice's for the whole run.

The third party was a copy of the run folder made before any tick, without Alice's swap file (so without the secret):
Bob's file in phase `received`, the bundle and the helpers. The bundle and Bob's terms are not secret, so any observer
could build the same.

Numbers of the swap: `h_create` 313115, nominal lock-by 313165, last lock height 313207, `D` 313417, log start on
Sepolia 12140419, lock word `0x1597c3c604cba080fa1b2d373fe19993e0a6ffedd864684ff86250f61f21194c`.

## What happened

| UTC | tip | who | what |
|---|---|---|---|
| 21:33:39 | 313103 | Alice | `prepare.sh`, `contract create`, `check-object.sh` ("object file OK"); `fund.sh --dry-run` passed. The third party's folder was copied |
| 21:40:44 | 313115 | Alice | applied: `fund_noid` offered and recorded |
| 21:54:57 | 313141 | Alice | **the funding, sent once by the operator:** `fund.sh`, about 14 minutes after the offer. Txid `ec23b19de0e0adfcced0e826bb5d244bc78945b51ac5e6ef0466d84d59de7c01`, fee 9,000 μNOID, included at 313143. Alice's tick at 313141 showed it pending, with the note "funding window is short: 0 blocks left" |
| 21:59:40 | 313146 | both | instance: slot 9751844, incarnation 808991, 5.000000 NOID; both files `funded` (Bob at tip 313146, Alice at 313147) |
| 22:05:42 | 313162 | Bob | `wait`, "waiting for funding finality"; `lock.sh --dry-run`: exit 1, no pending intent |
| 22:06:21 | 313166 | Bob | `noid_funding_final`; `lock_eth` offered and recorded (`T_reveal` 1794784552). Notes: the producer warning (largest address 49.5 % of the last 2,880 blocks and 52.0 % of the last 720), "single node: F5 cross-check not possible", and "nominal lock-by 313165 has passed (tip 313166); the lock is still allowed until the hard limit 313207". `lock.sh --dry-run` passed |
| 22:07:24 | about 313168 | Bob | **the lock, sent once by the operator:** `lock.sh`. Tx `0xc36342c1ae36f1e7898dcd73d96b7a91c507f9fe45db5989337e2a72c5752da6`, Sepolia block 12143078 (timestamp 1794780444), lock id `0x205b876a57d62c52e91769ae00b1d454dfab910774dee10d5872682a4effbeb4`. The lock record beside the swap file and the per-user lock record were written |
| 22:07:28 | 313168 | both | Bob: `eth_lock_seen`, phase `locked`. Alice (read-only): `noid_funding_final`, `eth_lock_seen`, "waiting for Bob's lock to be finalized" |
| 22:07:50 | 313168 | third party | first tick of the copy, after the real lock was mined: the instance is seen, phase `funded`, note "lock-by 313165 has passed: tip 313168 is 3 blocks beyond it" |
| 22:24:10 | 313188 | third party | `noid_funding_final`, `eth_lock_seen`, phase `locked`, "waiting for the secret (or T_reveal)". The copy recorded no `lock_eth` intent of its own and adopted the real lock |
| 22:26 | 313192 | Alice | Sepolia had finalized the lock's block at 22:25:53. Applied: `reveal_eth` offered and recorded, cutoff 1794782752 (22:45:52). `reveal.sh --dry-run` passed at 22:26:21, with 1,169 s to the cutoff by the tool's count |
| 22:47:42 | about 313238 | Alice | **the reveal, tried once by the operator, refused by the tool:** `reveal.sh`, 110 s after the cutoff: "refusing: past the reveal cutoff. now 1794782862 > cutoff 1794782752 (timelock 1794784552 - margin 1800 s, or the swap file's frozen cutoff 1794782752, whichever is earlier) (a late claim publishes the secret and lets the counterparty take both legs; use --margin-s only if you know the risk)". Nothing was sent |
| 22:48:22 | 313238 | Alice | read-only: note "not revealing: (I2) reveal cutoff passed: now 1794782902 > T_reveal - M_A = 1794782752; do NOT broadcast"; the `reveal_eth` intent still held |
| 22:48:55 | | Alice | `swap-cli intent FILE --cancel` with the chain flags of a tick: exit 0, the intent is gone. The cancel checks the chain first; the nonce of Alice's Ethereum sender was unchanged |
| 22:48:57 | 313241 | Alice | `wait`, "reveal cutoff passed; keeping the secret and waiting for D" |
| 22:49:15 | 313243 | Alice | **A9:** `recover-noid.sh --dry-run` before `D`: exit 1. The node's preview of a close at this height is a claim-branch close: `recovery` false, `terminal` true, authority the claim authority, payout 4,994,200 μNOID to Bob's payout address. The helper refuses it |
| 23:16:48 | 313295 | Bob | applied, after `T_reveal`: `refund_eth` offered and recorded; `refund-eth.sh --dry-run` passed (gas estimate 158,595) |
| 00:33 (16th) | | Bob | **the ETH refund, sent once by the operator:** `refund-eth.sh`. Tx `0xded869c3b6f60ea474790d5c32ac4d20bd4b1f1bbde0d347ac22b1ac11ec7b96`, Sepolia block 12143796 |
| 00:55:21 (16th) | 313485 | Bob | applied: `eth_refund_mined` and `eth_refund_final` in one tick, "done: ETH refunded", phase `refunded` (terminal) |
| 00:55:36 (16th) | 313485 | Alice | applied: `eth_refund_mined`, `noid_instance_alive_at_d`, `refund_noid` offered and recorded (`call_height` 313486, fee 5,800) |
| 00:55:50 (16th) | 313485 | Alice | `recover-noid.sh --dry-run`: "preview ok"; the preview: `recovery` true, `terminal` true, authority Alice's address, payout 4,994,200 μNOID, fee 5,800 |
| 01:14:25 (16th) | about 313517 | Alice | **the recovery, sent once by the operator:** `recover-noid.sh`. Txid `28c3ed227951de8f45eb84629a7f43b95387cc152387d1358104716a2a350b38`, included at 313519; "Confirmed call", "Receipt verified and saved" |
| 01:15:33 (16th) | 313520 | Alice | `tick.sh alice --closed-by TXID --apply`: event `noid_closed_externally` at 313519, the `refund_noid` intent resolved, phase `refund_included`, `wait` "waiting for NOID refund finality" |
| 01:16:39 (16th) | 313522 | third party | applied: `eth_refund_mined`, `eth_refund_final`, phase `refunded` (terminal). The copy never held a spend step |
| 01:24:10 (16th) | 313538 | Alice | applied: `noid_tx_final`, "done: NOID refunded", phase `refunded` (terminal). The recovery was final from tip 313537 (18 blocks after its inclusion) |

Afterwards `contract instances` printed nothing. Alice's balance went down by 14,800 μNOID: the funding fee (9,000)
plus the close fee (5,800). On the Ethereum side Bob paid the gas of one lock and
one refund (the dry runs estimated 600,174 and 158,595 gas) and got his 0.001 ETH back. The secret was never
published.

## Against the plan

- Step 1 (fund, lock, reveal): the funding and the lock happened; the reveal did not. From there the run followed the
  plan's abort path in its last form ("Alice recovers at `D`"), with Bob's refund before it.
- Step 2 (A9): done, but before any reveal instead of right after it. The result is the expected one: before `D` the
  helper refuses, and the node's own preview shows why a close at that height cannot serve Alice: it is the claim
  branch and pays Bob.
- Step 4, first half (the third party's copy): as the plan expected. Started after the real lock was mined, the copy
  counted the funding finality from its own first tick, recorded no lock step of its own, and adopted the real lock.
  It then followed the lock to its refund without a hand edit. Its `claim.sh` was never reached.
- Steps 3, 5 and 6 (Bob's `claim_noid`, the third party's close, the "pending" and "gone" texts, `--closed-by` on
  Bob's file while it holds the claim step, Alice's file following her claim): **not run.**

## Observations

1. **The reveal cutoff held on a real chain, against the operator.** The dry run had passed 21 minutes earlier; the
   real send came 110 s too late and was refused with the two timestamps. A reveal after the cutoff would have
   published the secret with too little time left before Bob's refund opens, the case in which Bob can end with both
   coins. The tool names an override (`--margin-s`); it was not used.
2. **After a missed reveal the way out is `intent --cancel`, then wait.** The cancel is fail-closed: it reads the
   chain first, so it cannot drop a step whose transaction is already out. After it, Alice's file said to keep the
   secret and wait for `D`, and at `D` it offered the recovery by itself. This is the second missed reveal of the
   project (run 10 was the first) and both ended with every coin back.
3. **The reveal window is short in this profile, and it starts late.** Alice may reveal only once Sepolia has
   finalized the block of Bob's lock (about 19 minutes after it), and must be done 1,800 s before `T_reveal`. Here that
   left 19 minutes and 31 seconds between the offer and the cutoff. An operator who is not at the
   keyboard when the window opens can miss it. In the second try (run 19) the operator was at the keyboard before it
   opened.
4. **A late funding moves everything behind it.** The funding was sent 14 minutes after the offer, at the edge of its
   window, and landed 28 blocks after `h_create`. Bob's file counts the 18 blocks of funding finality from the tip at
   which it first saw the instance (313146), not from the inclusion block (313143), so the lock was offered at 313166:
   one block after the nominal lock-by, 41 blocks before the hard limit. The tool said so and allowed it. The reveal
   window was not shortened by this (`T_reveal` is set when the lock is offered).
5. **The wording of two notes.** At the lock offer Bob's note reads "the lock is still allowed until the hard limit";
   the third party's first tick reads "lock-by 313165 has passed: tip 313168 is 3 blocks beyond it" with no word on
   the hard limit. And Alice's (I2) note "do NOT broadcast" was still shown at the tick that offered the recovery,
   130 minutes after the cutoff, where it reads as if it were about the recovery. Both low, wording only.
6. **Durations.** `prepare.sh` to the refused reveal: 74 minutes. To Bob's refund in a block: about 3 hours. To the
   recovery in a block: 3 hours 41 minutes. Two waits on the operator's side made most of it: about 77 minutes from
   `T_reveal` to Bob's refund and about 55 minutes from `D` to the recovery (they overlap).

## Not covered

Everything L4 was made for: a close by a third party, the texts of Bob's tool while that close is pending and after
it is mined, `--closed-by` on Bob's file, Bob's net payout. Also the two-machine form and the watch loops. The scratch
files of this run, the third party's copy included, are a swap that must never be funded again.
