# Live run 13 — the first swap with Alice's steps driven from the operator console, 2026-11-06

> Clock times in this log are UTC. All of them belong to 2026-11-06. The Parano1d tip is given in brackets.

The sequel of run 11 (`docs/live-run-11.md`): the same swap, the same two machines, but Alice's side was not run from a terminal. It was
run from the operator console. The swap **settled**: 5 NOID against 0.001 Sepolia ETH, Alice's side final 50 minutes after the funding
(run 12: 45, run 11: 44). Bob's side was run from a terminal on the Mac, as before.

Words, once (the others are explained in `docs/live-run-11.md` and `docs/live-run-12.md`). The *operator console* is a local web page
over the same helpers of `scripts/live/`. It shows the engine's state and runs the fixed steps as buttons. A step that spends is behind a
dry run, a set of checks (the "gate") and an amount the operator must type; the operator starts every spending step. The console adds no
new way to spend: it calls `fund.sh` and `reveal.sh`. A *marker* is a small file that `fund.sh` writes before it calls the wallet, so a
second funding of the same contract is refused.

## Setting

As run 11: 5 NOID against 0.001 Sepolia ETH, lock kind `poseidon`, raw variant, contract version 1, profile `sepolia`. Alice was a
Windows PC with the helpers under WSL, Bob an Apple Silicon Mac with the native helpers. What is new or different:

- **Alice's steps from the operator console.** Setup, prepare, the object-file check, the watch loop, the funding (dry run, then send)
  and the reveal (dry run, then send) were buttons. The funding went through `scripts/live/fund.sh`, the reveal through
  `scripts/live/reveal.sh`. Each spend ran after a dry run compared with the terms, and the operator typed the amount.
- **Bob's side from a terminal, as before.** `lock.sh` and `claim.sh`, each after its dry run.
- **One node per chain per side, as in run 11** (`SINGLE_NODE_OK=1`; no tunnel, no second endpoints). The two-node check was not on.
- **`fund.sh` in the form it has after three reviews:** it fails closed, works on a private copy of the object file for each process,
  and writes three markers before the wallet call.
- One operator played both roles, as in all earlier runs.

## Parameters

| item | value |
|---|---|
| Tip at preparation | 286,444 (15:17:00) |
| `h_create` / `D` | 286,484 / 286,784 (`h_create` + 300) |
| Bob's lock-by | 286,533 (`D − 251`) |
| Contract root | `o1awm6lxrxajzxrnxy7hzj8ntl3kfug69nyle595078z42c5e7xmzsp6rv7d` |
| Funded instance | slot 640,281, creation id 758,490 |
| Ethereum contract | `HTLCPoseidonV2`, the same code-hash pin as run 12, `0xf510d2a368c730339fa7cf5e023bcf2429d5732793f043e03025780bb7043ff3` |
| `T_reveal` / Alice's reveal cutoff | 17:05:24 / 16:35:24 (`T_reveal` − 1,800 s) |

## Log

- 15:15:17 **setup**, 15:16:17 to 15:16:19 **prepare** (a matter of seconds: the lock kind is proof-free), from the operator console. The
  wallet's object file was created. 15:17:48 the object-file check: OK.
- 15:18:35 the watch loop was started from the console. It ran detached, 123 ticks, and stopped by itself on a terminal phase; none
  of its ticks failed.
- **The bundle on the Mac, first attempt.** The bundle was relayed between the machines as text and arrived damaged: the long run of
  zeros in `opening_hex` had three zeros too many. `new-bob` refused it (`opening_hex`: odd number of digits), wrote no file and sent
  nothing. In run 11 three characters were lost the same way. The field was then corrected on the Mac and accepted only
  because its length (1,398 characters) and the sha256 of the hex text matched the values read from Alice's file. `new-bob` then exited 0: "bundle checked: opening rebuilt
  byte-for-byte". The client R self-test passed (882 ms, owner-authorization V4), with the same contract root, `h_create`, `D` and
  lock-by. Bob's loop started; its first tick was at [286,459].
- 15:34:25 [286,483] Alice's engine offers the funding (`fund_noid`). Until then it had said "node is behind H_create": the engine offers
  the funding only when the chain reaches `h_create`. In runs 11 and 12 `fund.sh` was run from a terminal before `h_create`, about 30
  blocks earlier (see findings 2 to 4).
- 15:43:23 **funding dry run** from the console: every row matched. 15:43:55 the send: the typed amount, the statement "no funding of
  this contract is pending", then `fund.sh` once at 15:43:56. The wallet said "Funding submitted" and exited 0. The three markers were written before the wallet call. Nine
  minutes passed between the offer and the send.
- 15:45:02 [286,510] Alice `funded`: exactly one instance (slot 640,281, creation id 758,490).
- 15:56:01 [286,528] the funding is final.
- **Bob's lock, from the Mac.** Sepolia transaction `0x08b5bbf0cc11c86abdb3cd9929fc546a333b8602e32da64ca5d06545bbe13c78`, block 12,077,584,
  mined at 15:56:12, 583,853 gas. Alice saw it at 15:56:37 [286,529]: four Parano1d blocks inside the lock-by (run 12: 59).
- **One tick on the Mac failed right after the lock**, with "getLock shows this lock but eth_getLogs returned no Locked event for it": the
  provider's log index was behind its state for a moment. The next tick read the lock without
  help; it was the only failed tick of Bob's 107.
- 16:15:03 [286,569] the lock is final on Sepolia (18.9 minutes after it was mined) and Alice's engine asks for the reveal.
- **The reveal.** 16:17:18 to 16:17:21 the reveal dry run from the console passed, 1,083 s before the cutoff. 16:17:31 a first click on
  send was **refused by the console's gate** (no recent tick on record, and the dry run did not match). 16:17:38 the second click,
  seven seconds later, was accepted. Sepolia transaction `0x9fb6e2d834eefbff85e1b2d2c4a453eb4e7dbdf7834d740fe974b53cb836c7ec`, block
  12,077,689, 689,324 gas of the fixed limit of 1,000,000. The helper exited 0 at 16:17:54. Alice `revealed` at 16:18:11 [286,573], about
  17 minutes before the cutoff.
- **Bob's claim, from the Mac.** He read the secret at [286,573]. `claim.sh` dry run, then `claim.sh --submit`.
  Parano1d txid `4ad675a79354d58933cbec23f046ea54aa6a930bebd0c18bf9012740bf924340`, call height 286,575, confirmed at 286,577, fee 5,800 μNOID,
  payout 4,994,200 μNOID to Bob's address. Seen from the PC, the contract had no instance any more by [286,584] (16:22:10). Bob's file
  went to `done` and his loop stopped by itself at [286,595] (107 ticks, one failed, see above).
- 16:34:12 [286,606] Alice's ETH claim is final on Sepolia. Her file is `done` and her loop stopped by itself.

## Result

| leg | outcome |
|---|---|
| NOID (Bob) | claim txid `4ad675a7…4340`, call height 286,575, confirmed at 286,577; 4,994,200 μNOID to Bob's address (5 NOID − 5,800 μNOID close fee); Bob's file `done` |
| ETH (Alice) | reveal tx `0x9fb6e2d8…c7ec`, block 12,077,689, 689,324 gas, final at 16:34:12; 0.001 ETH received |
| ETH (Bob) | lock tx `0x08b5bbf0…3c78`, block 12,077,584, 583,853 gas |
| Alice's file | `created` → `funded` (15:45:02) → `funding_final` (286,528) → `lock_seen` (286,529) → `lock_final` (286,569) → `revealed` (286,573) → `done` (286,606, 16:34:12) |
| After the run | the Parano1d contract has no instance (the wallet CLI's instance listing is empty). The chain's record for Bob's address shows 4,994,200 μNOID received from the contract root. On Sepolia Alice's address gained 0.001 ETH and Bob's lost 0.001 ETH plus the lock's gas |
| Cost of the swap | the 5,800 μNOID close fee plus the funding fee, which was not read from the wallet in this run (9,000 μNOID in runs 11 and 12, which would again make 0.0148 NOID) |
| The console's record of actions | 17 entries; it shows one refused spend (the first click on the reveal) and two accepted ones (funding, reveal) |
| Time | 50 minutes from funding (15:43:56) to Alice's side final (16:34:12); run 12 took 45, run 11 took 44 |

## What it showed

- The operator console drove a complete live swap for Alice. Every step that spends nothing and both spends (funding through
  `fund.sh`, reveal through `reveal.sh`) ran from it, each spend after a dry run compared with the terms, with the gate refusing once
  and passing once.
- The hardened `fund.sh` ran live in its final form: one instance, three markers written before the wallet call.
- `new-bob` again stopped a damaged bundle before anything was sent.
- The full swap settled a third time across two machines.

## Findings

All low, unless said. They come from the operator's notes of the run, from the PC's ticks and from Bob's tick log on the Mac.

1. **The bundle was damaged in transit a second time** (medium for usability, none for safety). In run 11 three characters were lost;
   now three zeros were added to the 1,052-zero run of `opening_hex`. `new-bob` refused both. A text relay is not a safe carrier: hand
   over the file, or give the length and the sha256 of `opening_hex` with every bundle so the receiver can check before `new-bob` (the
   checksum line that was already planned).
2. **Through the console the funding can start only at `h_create`.** `h_create` is the height written into the contract as its
   creation height; the engine offers the funding once the chain reaches it. A terminal `fund.sh` could run right after the
   preparation. With `HC_LEAD=40` and the lock-by at `h_create` + 49, that leaves Bob little room: here the funding went out 22 blocks
   after the offer, and Bob's lock was seen 4 blocks inside the lock-by. Nothing warned Bob
   that the window was short: his engine offered the lock at [286,527], six blocks before the lock-by. Options: a smaller `HC_LEAD` for console runs; let the engine offer
   the funding before `h_create`; or show the lock-by margin on the page while the funding is open.
3. **The page hid the step.** The funding box sits at the bottom of a card titled "Next: wait", whose text says nothing is to be done and
   that the funding has "no button on purpose". The operator did not find it for several minutes and almost took the terminal
   command shown above it for something to send to the other machine. The card must lead with the step that is due.
4. **After a browser reload the console's buttons are disabled** with no visible reason, until the page is opened again from its start link. It cost about four minutes
   at the funding. The page should say why, and how to get the buttons back.
5. **The first click on the reveal send was refused by the gate** (no recent tick on record, and the dry run did not match); the second, seven seconds
   later, passed. Fail-closed and harmless. The cause is not established (the watch loop rewrites the tick file about every 35 s).
6. **`watch.sh` cuts its summary line at 1,200 characters.** A tick that prints a long recorded intent loses the `phase_after` at the
   end of the line (one such line at 16:15:40), and the console's history then shows a cut phase name.
7. **The console refuses to start when the run folder does not exist yet,** so its "install helpers" button cannot be the first step;
   `install.sh` was run from a terminal first.
8. **Bob's tick failed once right after his lock** (the provider's log index was behind its state). It cleared on the
   next tick without help. Failing loudly is right, but one failed tick right after a lock can alarm an operator. The null block time
   that `lock.sh` recorded in run 12 (finding 3 there) looks like the same lag.
9. **A start of the watch loop ended without a trace, once, before the run.** In a rehearsal on a copy of run 12's folder, one of four
   starts ended in the middle of its first tick with nothing recorded. It was not reproduced and not seen in the run (123 ticks).
   Watch the loop file's age during a run.

Not a finding, a measurement: gas on Sepolia was unchanged, 583,853 for the lock and 689,324 for the reveal (run 12: 583,853 and 689,312;
run 11: 583,841 and 689,324).

## What it did not show

- The two-node rule (run 12 did), and a hostile counterparty (one operator played both roles).
- The stock variant and contract version 2.
- The operator console on Bob's side, and its paths for re-sending a stuck transaction and for the abort cases.

There is no run 7 log (see `docs/live-run-8.md`); the next free run number is 14.
