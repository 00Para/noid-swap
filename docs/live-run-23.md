# Live run 23 — the failure run on Ethereum mainnet, stopped by the producer screen, 2026-11-23

> Clock times in this log are UTC. All of them belong to 2026-11-23. The Parano1d tip is given where it was read.

The first run on Ethereum mainnet, planned as the failure run: Alice funds, Bob locks, Alice stays away, and Bob's ETH
refund and Alice's NOID recovery after the deadline `D` are exercised with real money. It did not get that far. Both sides
were set up, Bob's invitation filled Alice's form and the two check lines matched; then Bob's tool showed one address
producing about 75 to 77 % of the recent Parano1d blocks, above the 65 % ceiling that Bob cannot acknowledge, and the page
refused his approval. The share was confirmed on a second node. **The run was stopped at 17:54, as designed. Nothing was
deposited, funded, locked or sent on either machine, on either chain.** The cost is zero.

## Setting

5 NOID against 0.001 ETH, lock kind `poseidon`, raw variant, contract version 1, profile `production` (chain 1), the
pinned mainnet contract (`ui/app/README.md` "Mainnet in program mode"), program 0.1.5 on both machines. The PC was Alice,
the Mac was Bob. Alice's program ran against the node of the wallet app on the PC, Bob's program against a node on the
Mac (one Parano1d node on the same machine, which the production profile allows without a second node; two public
Ethereum endpoints each). Fee cap chosen for both swaps: 2 gwei with a tip of 0.05 gwei, so the deposits the pages would
ask for were 0.00325 ETH for Bob's swap key, 0.0025 ETH of reserve for Alice's swap key and about 5.009 NOID for Alice's
swap wallet (the amount plus the funding's fee). No deposit was made.

Numbers of Alice's swap: `h_create` 335,756, lock-by 335,863, `D` 336,494, `W_A` 7,200 s, `max_fee` 50,000 micro-NOID.
Parano1d tip when the swap was made: about 335,700. Ethereum gas price at the start, about 0.68 gwei.

## What happened

| UTC | who | what |
|---|---|---|
| 17:36 | both | The run starts (it had been paused twice earlier in the day, before any swap existed; nothing was made then). |
| 17:40 | Bob | New swap in the program: role Bob, `production`, chain 1, the pin, 5,000,000 micro-NOID and 10^15 wei, fee cap 2 gwei. The setup steps and the swap wallet setup ran by themselves and ended `ok`. Parano1d node in sync (tip 335,696). |
| 17:41 | Bob | Bob's invitation file for mainnet saved (357 bytes). It stated no producer share yet. |
| 17:45 | Alice | The invitation arrived on the PC, unchanged (same size, same hash as the Mac's). |
| 17:47 | Alice | New swap made from the invitation: terms, contract and Bob's addresses filled by it. Prepared by itself at 17:48 (check line shown). Nothing funded, approved or sent. |
| 17:49 | both | Alice's copy for Bob (2,592 bytes) carried to the Mac. |
| 17:52 | Bob | The copy was joined: the check line matched, "opening rebuilt byte-for-byte, tool guard and (I5) pass, your terms match", the client self-test passed (814 ms). Phase `received`. The wallet status asked for 0.00325 ETH and held 0. The watch read the chains and recorded nothing. |
| 17:53:11 | Bob | First tick (observe only): the producer screen reported **concentrated**, enforced. 755 permille of the last 2,880 blocks and 766 permille of the last 720 from one address; limit 350, hard maximum 650, **not waivable by acknowledgement**. The two largest together: 84.1 % and 85.5 %. |
| 17:53:14 | Alice | The page recorded "the other side's line matches". No approval line was recorded in Alice's audit, and the autopilot file was never written. |
| 17:54 | Alice | Read-only count from the PC's own node (tip 335,717): the same address 551 of 720 (76.5 %) and 2,174 of 2,880 (75.5 %); the next address 8.9 % and 8.5 %. This agrees with the Mac's reading on a second, independent node. |
| 17:54 | both | **Run stopped.** Bob's approval is refused by the page above 65 % ("Do not start this swap"), so the swap could not go ahead on his side. Nothing had been approved on either machine. |
| 18:02 | | The approval form's typing problem (R23-2) found and fixed. |

Bob never locked and Alice never funded. Both swap files close by themselves: Alice's records its abort once the tip
passes the lock-by height 335,863 and the funding window has gone, and Bob's never offers a lock. (The closing ticks were
not taken before this log was written.)

## What it showed

- **The producer screen worked as designed.** It read the headers, counted both windows, found one address above the
  ceiling in both, said so before any money moved, and refused the approval on the page with a reason in plain words. The
  number came from Bob's tool and was reproduced on a second node by a separate read (76.5 % and 75.5 % against 76.6 % and
  75.5 %: the difference is the few blocks between the two readings).
- **No mainnet run in which Bob locks ETH can go ahead while one producer is above 65 % in either window.** Between 35 %
  and 65 % Bob may acknowledge the share, in the tool and on the page, and the page states it in his approval. Above 65 %
  nothing waives it: the screen is a refusal there, and nobody is asked. The reason is the one in
  `docs/miner-concentration.md`: against a majority producer who is Alice, no window protects Bob's ETH.
- **The setup path worked on mainnet:** the pinned contract was recognised, Bob's invitation filled Alice's form, the
  opening was rebuilt byte for byte, both check lines matched, and the swap wallet's reserve was computed at the chosen
  cap. These are the parts that ran before the stop. The funding, the lock, the refund and the recovery on mainnet were not
  reached and are still to run.
- Cost: nothing on either chain.

## Findings

1. **R23-1: a mainnet payout address came from a test network.** On mainnet the new-swap form pre-filled the Ethereum
   payout from Settings, and the address saved there had been used on Sepolia. The form gave no hint of it, and a swap's
   payout cannot be changed after it is made. Nothing was sent, so the swap was kept as made. Fix, for 0.1.6: a mainnet
   payout is never taken from a test network's setting.
2. **R23-2: the approval form emptied itself while it was typed.** Every redraw of a swap page (about every few seconds
   while the chains move) emptied the approval's typed amount ("5 NOID"), its ticks and the focus. This is the likely
   reason that Alice's approval was not recorded at 17:53. Fixed (the form is now emptied only when the person leaves the
   swap) and checked in a real browser; it ships in 0.1.6.
3. **The fee cap of Alice's swap was 1 gwei where 2 had been chosen.** The new-swap form starts at the program's default
   of 1 gwei, and the field was not changed when Alice's swap was made from the invitation; Bob's swap said 2. Each side
   sets its own cap, so the invitation does not carry it. Nothing was sent, so it had no effect here. An operator step,
   not a code change: read the form's fee cap against the plan before making the swap.

## Not covered

Everything after the lock decision on mainnet: Alice's funding, Bob's lock, the ETH refund, the recovery of the NOID
after `D`, the swap key sweeps, and the fee cap behaviour. The producer share has to be at or under 65 % in both windows
(and the person must acknowledge it above 35 %) before a mainnet run in which Bob locks can start; the failure run waits
for that. The two swap files of this run are scratch: their windows will pass and they must never be funded.
