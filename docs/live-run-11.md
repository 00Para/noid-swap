# Live run 11 — the first complete swap with the two roles on two machines, `poseidon` lock kind, 2026-11-06

> Clock times in this log are UTC. All of them belong to 2026-11-06. The Parano1d tip is given in brackets.

The retry of runs 9 and 10 (`docs/live-run-9-10.md`). Those two runs were the first with the roles on two machines and both ended on
their abort paths. This one **settled**: Alice on a Windows PC, Bob on an Apple Silicon Mac, each with its own Parano1d node, 5 NOID
against 0.001 Sepolia ETH, both legs final 44 minutes after the funding.

Words, once (the same as in the log of runs 9 and 10). An *instance* is one funded copy of the Parano1d contract. The *reveal* is
Alice's claim of the ETH: it publishes the secret `s` on Ethereum, and from then on anyone can read it; that is how Bob gets the NOID.
`T_reveal` is the time after which Alice may no longer claim and Bob may refund. The *reveal cutoff* is a margin before `T_reveal`
(1,800 s here) after which Alice's tool refuses to reveal at all. `D` is the Parano1d block height at which the NOID lock flips from
Bob's claim to Alice's recovery. *Lock-by* is the last block at which Bob may still lock. *Finality* is the point after which a block
can no longer be undone (18 blocks on Parano1d, about 14 to 19 minutes on Sepolia).

## Setting

Identical to runs 9 and 10: 5 NOID against 0.001 Sepolia ETH, lock kind `poseidon` (`docs/poseidon-leg.md`: no equivalence proof, no
receipt), raw variant, contract version 1, profile `sepolia` (`D = h_create + 300`, Bob's lock-by `D − 251`, reveal window 4,200 s,
reveal margin 1,800 s), `SINGLE_NODE_OK=1` on both sides.

- Alice was a Windows PC with the helpers under WSL. Bob was an Apple Silicon Mac with the helpers in native mode under the system
  bash 3.2 (`docs/mac-setup.md`).
- Each machine used its own Parano1d node and a public Sepolia endpoint. Each party still had one node per chain: **the two-node check
  (F5) was not done**; it was waived on both sides by `SINGLE_NODE_OK=1`.
- Bob's Ethereum key was the one created on the Mac for run 9. No key moved between the machines.
- Alice's bundle (2,478 bytes, no secret in it) went to the Mac by copy and paste.
- Every spending step was run by the operator by hand, each after a dry run. The funding went through `scripts/live/fund.sh`, for the
  first time live: it funds exactly once.

## Parameters

| item | value |
|---|---|
| Tip at preparation | 286,007 (11:41:02) |
| `h_create` / `D` | 286,047 / 286,347 (`h_create` + 300) |
| Bob's lock-by | 286,096 (`D − 251`) |
| Contract root | `o1ppd7k5v3ptf8c7e265c3k9gm0mf7yattf0ee5chp2tlrrw9lkxys2a3kpa` |
| Funded instance | slot 635,439, creation id 757,220 |
| Ethereum contract | `HTLCPoseidonV2`; its code hash equals the pin compiled into the tools, `0xf510d2a368c730339fa7cf5e023bcf2429d5732793f043e03025780bb7043ff3` |
| `T_reveal` / Alice's reveal cutoff | 13:06:00 / 12:36:00 (`T_reveal` − 1,800 s) |

## Log

- 11:41:02 [286,007] **prepared.** The object file made by the wallet CLI was checked against Alice's swap file: OK. `fund.sh
  --dry-run`: OK.
- **The bundle on the Mac.** The first save, copied by hand, had lost three zeros of `opening_hex`. `new-bob` refused it (an odd number
  of hex digits), wrote no file and sent nothing. The bundle was saved again from the exact text, checked byte for byte, and the client R
  self-test passed.
- 11:46:22 **`fund.sh` ran once.** One instance (slot 635,439, creation id 757,220), mined at [286,019]. Alice `funded` at 11:48:49
  [286,019]; the funding was final at 11:56:17 [286,037].
- **Bob's lock, from the Mac.** Sepolia transaction `0xd027513923dd0977ca33e6fe372e6a493b2c258b7aebe0880ebdaae023f3010b`, block
  12,076,412, mined at 11:57:00, 583,841 gas. Alice saw it at 11:57:28 [286,041], 55 Parano1d blocks inside the lock-by.
- 12:11:35 [286,065] the lock is final on Sepolia (14.5 minutes after it was mined) and Alice's engine asks for the reveal. 12:12:04
  the reveal dry run passed, with 1,433 s left to the cutoff.
- **The reveal.** The operator, at Alice's machine this time, sent it at about 12:14: Sepolia transaction
  `0xf6ca56f82918038b7b70e6c609d2e96d442725722af1f048d1a692c978c947dc`, block 12,076,498, 689,324 gas of the fixed limit of 1,000,000.
  Alice `revealed` at 12:15:17 [286,074], about 21 minutes before the cutoff.
- **Bob's claim, from the Mac.** He read the secret from Sepolia at [286,074]. `claim.sh` dry run, then `claim.sh --submit` (the first
  run of `claim.sh` on macOS; both exited 0). Parano1d txid `e30dbe4453aa64c4901934ebed95798e5230b3561532140876c0e5e8b1fda636`, call
  height 286,077, confirmed at 286,078, fee 5,800 μNOID, payout 4,994,200 μNOID to Bob's address. Final 18 blocks later, at [286,096].
  Bob's file went to `done` and his loop stopped by itself (64 ticks, none failed, no helper error on macOS).
- 12:30:39 [286,105] Alice's ETH claim is final on Sepolia. Her file is `done` and her loop stopped by itself.

## Result

| leg | outcome |
|---|---|
| NOID (Bob) | claim txid `e30dbe44…a636`, call height 286,077, confirmed at 286,078, final at [286,096]; 4,994,200 μNOID to Bob's address (5 NOID − 5,800 μNOID close fee) |
| ETH (Alice) | reveal tx `0xf6ca56f8…47dc`, block 12,076,498, 689,324 gas, final at 12:30:39; 0.001 ETH received |
| ETH (Bob) | lock tx `0xd0275139…010b`, block 12,076,412, 583,841 gas |
| Alice's file | `created` → `funded` (286,019) → `funding_final` (286,037) → `lock_seen` (286,041) → `lock_final` (286,065) → `revealed` (286,074) → `done` (286,105, 12:30:39) |
| Bob's file | `received` → `funded` → `funding_final` → `locked` → `secret_seen` (286,074) → `claim_submitted` (286,077) → `claim_included` (286,078) → `done` (286,096) |
| After the run | the Parano1d contract has no instance; Bob's address holds a new output of 4.994200 NOID; Alice's NOID wallet is lower by 5.009000 NOID (5 NOID + the 9,000 μNOID funding fee); on Sepolia Alice's address gained 0.001 ETH and Bob's lost 0.001 ETH (gas was negligible: the base fee was a few wei) |
| Cost of the swap | 0.0148 NOID (9,000 μNOID funding fee + 5,800 μNOID close fee) |
| Time | 44 minutes from funding (11:46:22) to both sides final (12:30:39); run 5 (one machine, Sepolia) took about 47, run 8 (mainnet) 54 |

## What it showed

- The full swap across two machines and two independent Parano1d nodes, with the bundle carried by hand.
- The native helpers on macOS for every step Bob has: `new-bob`, the watch loop, the lock and the claim.
- `fund.sh` live: the funding happened exactly once.
- A damaged copy of the bundle is refused before anything can be sent: the opening is rebuilt and checked byte for byte.
- The operator was at Alice's machine for the reveal window this time (the window that run 10 missed), and the reveal left 21 minutes of
  margin to the cutoff.

## Findings

1. **The bundle needs a safer carrier than copy and paste.** A hand-copied bundle lost three characters, and the tool refused it.
   Nothing was at risk. But a longer run of zeros dropped in pairs would give an even number of digits and be caught only by the
   byte-for-byte rebuild of the opening. Open: give the bundle a checksum line or a compact encoding that copies safely. This log does not
   design it; it states the need.
2. **Gas on Sepolia is far above mainnet for the same contract code** (the same code hash). Measured:

   | call | Sepolia | Ethereum mainnet |
   |---|---|---|
   | lock (`newLock`) | 583,841 (run 11), 583,853 (run 10) | 144,129 (run 8) |
   | reveal (`claim`) | 689,324 (runs 5 and 11) | 517,084 (run 8) |
   | refund | 145,652 (run 10) | not measured |

   The run 5 log said "about 500,000" for the Sepolia claim. That figure was never measured; the receipt of that very transaction shows
   689,324. The differences (about 440,000 for the lock, which writes several new storage slots; about 172,000 for the claim, which
   writes fewer) fit a higher price for creating storage on Sepolia than on mainnet. **This cause is an inference from the numbers and
   was not checked against the networks' fork schedules.**

   Why it matters: the `poseidon` reveal is sent with a fixed gas limit of 1,000,000 and is never simulated (a simulation would carry
   the secret to a node). On Sepolia it uses 69 % of that limit. If mainnet adopts the same pricing, the mainnet lock and reveal cost the
   same as on Sepolia, the headroom of the fixed limit shrinks to 31 %, and Alice's balance rule (1,000,000 × the fee cap) stays as it
   is. Open: re-measure after any network upgrade and keep the limit well above the measured use.

## What it did not show

- Two nodes per chain for each party (`SINGLE_NODE_OK=1` on both sides), and a hostile counterparty (one operator played both roles).
- The actions mode of the `ui/` console prototype (the prototype is not in the public copy).
- Contract version 2, the stock variant, the rotation case, the conflicting-close case, and Ethereum mainnet on two machines.
- `reveal.sh`, `prepare.sh`, `fund.sh` and `recover-noid.sh` on a Mac (Alice ran under WSL).

There is no run 7 log (see `docs/live-run-8.md`); the next free run number is 12.
