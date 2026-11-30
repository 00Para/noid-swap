# Live run 22 — the tool's own NOID wallet on the real chain: funding, recovery and sweep (one person), 2026-11-17

> Clock times in this log are UTC. All of them belong to 2026-11-17. The Parano1d tip is given with each step.

The first run of a wallet run (`USE_SWAP_WALLET=1`, `scripts/live/wallet-*.sh`): the swap's coins sit in a wallet the
tool made for this swap, not in the operator's own wallet. One person, Alice's side only, on purpose: the funding is
made, nobody locks on Ethereum, and after the deadline `D` the NOID is taken back and everything is sent to the
operator's own addresses. The questions were the three things no real node had seen: is a payment built by the tool's
own wallet accepted (the funding), is its recovery close accepted and recorded, and does the sweep return what is left.
**All three were accepted and mined. The funding put exactly 5 NOID at the swap's contract, the recovery returned it
to the swap wallet at `D + 2`, the tool recorded that close by itself, and the sweeps sent 4.999300 NOID and the
Sepolia ETH to the payout addresses sealed in the swap file. The cost was three fees, 20,700 micro-NOID.**

## Setting

5 NOID, lock kind `poseidon`, raw variant, contract version 1, profile `sepolia`, one node per chain
(`SINGLE_NODE_OK=1`), the helpers frozen for the run, driven by hand one helper at a time (no console, no autopilot).
`h_create` 318,520 (`HC_LEAD=120`), lock-by 318,570, `D` 318,822. Parano1d contract root
`o1smfwjlt4vwxsw5j2fp0sagax0mgznuuvavm4h505p0w9z28pstzqvnvy3r`. The swap wallet
`o1dce7gg0ke5n82gjrn2ch9vy862x2z3jhzz6mjfnfpspvuu6vhmssyv7j4h` (recovery authority and recipient of the contract) and
the Ethereum swap key `0x5f2DA54FCbffA4D0C39261E3Ae33D37F7BCf2f68` (`alice_receiver`) were made by `wallet-setup.sh`
and sealed into Alice's swap file by `prepare.sh`; the standalone key files were deleted by it. Payout addresses, from
the settings and sealed with the keys: `o1zjj6zqc7uh4lts9neryq86dda6n76s7zj8c7wa0gfsnms3greqequtpurk` and
`0x49877DaCE5b72f4E8768FbF5Cb7eE1573c9fF9eA`. Bob's addresses in the terms were those of earlier runs; no Bob took part.

A folder for a run 21 was set up the same way a few minutes earlier and only read (wallet setup, `prepare.sh`,
`wallet-status.sh`); nothing was deposited or sent there, and it has no record of its own.

## What happened

| time | tip | step |
|---|---|---|
| 17:43 | 318,400 | `wallet-setup.sh alice`: the wallet and the key are made; `live.js` confirms that the key owns its address. `prepare.sh` writes the swap file. `wallet-status.sh`: NOID 0 of 5,009,000 needed (the amount plus 9,000 for the funding's fee), ETH reserve 40,000,000 wei, not covered. A read-only tick already offers `fund_noid` ("funding is open from height 318218"). |
| 17:45 | | 0.001 Sepolia ETH is sent to the swap key from the address of an earlier run (transaction `0x2c745a2ab2ff15b056614daa689d67668e4e70cd109c726f8f6731baa1263757`, block 12,155,957). |
| 17:48 | 318,407 | The operator's deposit of 5.02 NOID is seen in the swap wallet (one coin). `tick --apply` records the `fund_noid` intent (17:48:23). `wallet-fund.sh --dry-run`: target the contract root, 5,000,000, fee 9,000, one input, built, proved and verified. |
| 17:48 | 318,407 | `wallet-fund.sh` (real): `hold`, "the deposit was first seen at tip 318407; it is spent only 2 blocks later". As designed. |
| 17:50 | 318,410 | `wallet-fund.sh` again: **sent**, `b9a5568e99f27363edb1a9199d4c8c0a54172a6c2262c2ec9d779d79885ea833`, held by the node. |
| | 318,416 | The tick shows the instance (5,000,000, slot 649600, creation 818531, matches the opening): phase `funded`. The wallet holds the change, 11,000. |
| | 318,467 | Phase `funding_final`, "waiting for Bob's lock". |
| | 318,621 | "lock-by 318570 has passed". Nothing to do until `D`. |
| 21:05 | 318,821 | The tick offers `refund_noid` (call height 318,822, fee 5,800) and records the intent (21:05:16). `wallet-recover.sh --dry-run`: target the swap wallet, 4,994,200, fee 5,800. |
| 21:05 | 318,822 | `wallet-recover.sh` (real): **sent**, `f6499dc39f1c0a5ff8d85e93d91ddb239395f7a8c4781a73ce807cdc33f1f0ae`. The recording tried in the same run is refused ("the instance is still visible at our contract root ... nothing is recorded"), as designed. |
| 21:07 | 318,824 | `wallet-recover.sh --record`: the close is confirmed at 318,824 and **recorded by the tool** (`closed-by recorded`): phase `refund_included`. No manual `tick --closed-by`. |
| 21:07 | 318,824 | Both sweeps as dry runs are refused: the NOID sweep holds ("swept only after the swap is over"), the ETH sweep refuses (the phase is not an ended one). As designed. |
| 21:16 | 318,844 | Phase `refunded` ("done: NOID refunded"), 18 blocks after the close plus the tick. |
| 21:17 | 318,845 | `wallet-sweep.sh noid`: **sent**, `e0699a91340e47d0da031197104e9144c88d4d95988c9ceab11cd5cf25e23ece`: 4,999,300 to the NOID payout, fee 5,900, two inputs (the recovered coin and the change). `wallet-sweep.sh eth alice`: **sent and mined**, `0x03f76ad4a6459ca2e68bcd39e90e9ed066d58b9e6fbdafba65be869189816caf`: 999,999,999,202,000 wei to the ETH payout. |
| | 318,846 | The next block was slow. The NOID sweep helper was run a second time while the transaction was pending: it sent the same bytes (the same txid) and the node kept one transaction. Mined at 318,846. The swap wallet holds 0; the swap key holds 378,000 wei of unused fee. |

## What it showed

- **The payment builder is accepted by a real node.** It was written after the chain's own wallet and had been
  checked offline only. Three transactions of three shapes went through: one input and two outputs (the funding with
  change), the recovery close of the contract, and two inputs with one output (the sweep).
- **The dry run and the real send agree** on target, amount, fee and inputs each time. The txid differs between a dry
  run and the send that follows (the proof is made again).
- **Re-sending is safe on the real node:** the second run of the sweep helper sent the recorded bytes and nothing doubled.
- **The recovery records itself.** The recording right after the send is refused until the chain shows the close, and
  succeeds a block later.
- **The holds held:** no spend of a deposit younger than two blocks, no sweep before the file's end state.
- Money: 5,020,000 micro-NOID in, 4,999,300 out to the payout address; fees 9,000 + 5,800 + 5,900 = 20,700. On
  Ethereum: 0.001 ETH in, all of it back but 798,000 wei of fee and 378,000 wei left in the key.

## Findings

1. The read-only wallet commands (`wallet address`, `wallet balance`) need a swap file; a standalone wallet file is
   refused ("missing field `role`"). The helpers already work that way.
2. Alice needs Bob's Ethereum address before `prepare.sh` in a wallet run (`BOB_ETH`). The board's handover carries it;
   by hand it is one more thing to pass.
3. The Ethereum fee reserve followed the node's fee suggestion, which on Sepolia was a few tens of wei per gas: the
   reserve was 40,000,000 wei. A reserve taken at such a moment covers nothing if the fee rises during the swap. Not
   tested here (no reveal was made). To look at before a run in which Alice reveals from a swap key.
4. The plain ETH transfer to the swap key estimated 207,391 gas for a transfer; not looked into.

## Not covered

No Bob, so no lock, reveal, claim or ETH refund from a swap key; no console and no autopilot; no board; one node per
chain; a deposit in one coin only; no unknown outcome, no rebuild after an epoch rotation, no fee above the ceiling.
