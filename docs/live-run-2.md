# Live run 2 — the refund paths (Alice never reveals), 2026-11-04

> Clock times in this log are UTC; an entry after 00:00 falls on the calendar day after the one in the title.

Same setup as `live-run-1.md` (Parano1d mainnet, 10 NOID, local Hardhat chain for the ETH leg, raw variant, owner in
both roles), but after Bob's ETH lock **Alice never publishes the secret**. Expected: Bob's engine waits until
`T_reveal` (lock time + 7,200 s) and then says `refund_eth`; Alice's engine says `reveal_eth` until `T_reveal − M_A`
passes, then waits for `D` and says `refund_noid`; Alice's recovery close pays the 10 NOID (minus the 5,800 μNOID
close fee) back to her index-0 address. Costs: funding fee ~9,000 μNOID + close fee 5,800 μNOID + local gas.

This time `--eth-code-hash` is given to both `new-alice` and `new-bob` (lesson from run 1), and `--h-create` is the tip
plus 40 blocks, because the proof runs for 20–35 minutes before funding can follow.

## Log

- 15:19 Started: Alice's file + equivalence proof running in WSL (`~/live-run-2/`).
- 15:19 Alice's file: tip 280,749, planned `h_create` 280,789, `D` 281,514, nominal lock-by 280,895,
  hard 280,985. Hashlock `0x9a5e5fac…5c260`, claim authority `o1tzhvcf…zskfs`, contract root
  `o16yuvxwzpnl8r0j2h36yzhc0exxs258lnhwqys559d4a632muqgzqn2w4pl`, code hash pinned on both sides. Proof started.
- 15:54 Proof done: 2,194 s prove (36 min with WSL otherwise idle; the Nov 3 reference of 1,180 s was with the always-on
  node stopped and more RAM for the VM), verify OK, image id `7e9d8477…6187`. `new-bob` accepted first time (code hash
  pinned on both sides).
- 15:55 `contract create` → same root `o16yuvxw…n2w4pl`; `--check-object` byte-for-byte OK; active index 0.
  **Funded**: txid `c47eb2270a1e4f10d01dd09c05ace351ffca3860f287697629fe16c5547ddccb`, fee 9,000 μNOID, at tip 280,811
  (planned `h_create` 280,789: 22 blocks late, nominal lock-by 280,895 still 84 blocks away). Files in
  `C:\Users\00\Documents\live-run-2\`; `contract watch` registered the terms in the wallet app.
- 15:57 Funding included at 280,814 (instance slot 9,705,979, creation id 737,344); final at 280,831 (16:04).
  Erratum (2026-11-08): the chain's finality rule is 18 blocks after inclusion (`is_final`: tip >= height + 18), not 17; the outcome of this run was not affected.
- 16:05 Bob's engine: `lock_eth`, `t_reveal` 1,793,815,478. Bob locked 0.001 ETH: lock id
  `0x844f4c78…e3cba`, tx `0x2de640b0…067d`, block 716. Bob's engine: `locked`, "waiting for the secret (or T_reveal)".
  Alice's engine: `lock_final` → `reveal_eth` — **deliberately not executed**. From here Alice is silent.
- 16:06–16:19 Both engines steady: Alice `lock_final`/`reveal_eth` (ignored), Bob `locked`/wait. One poll at 16:17 returned
  nothing for Bob (a transient tick failure while the test suite was building in the same VM); the next poll was normal.
- 17:34 Alice's engine switched by itself: `reveal_eth` → `wait` ("reveal cutoff passed; keeping the secret and waiting
  for D"). The cutoff is `T_reveal − M_A` = 1,793,813,678 (`M_A` = 1,800 s): from here the engine refuses
  to broadcast the secret even if asked (note "(I2) … do NOT broadcast"), because a late reveal could let Bob claim the
  NOID while his own ETH refund is already possible.
- 18:04:38 `T_reveal`. 18:05:39 Bob's engine: `locked` → **`refund_eth`** on the first poll whose chain time was past
  `T_reveal` (eth block 1317, timestamp 1,793,815,531). The watch loop stopped as designed.
- 18:05 **Bob refunded** (local chain): dry run OK (gas estimate 66,577, amount 0.001 ETH), then tx
  `0x6f659b4f10fd46620dad2011ff4f9aa2dffa63eea09412d724ac329e8be12682`, block 1320. ≈ 80 s from `T_reveal` to the
  refund being mined, almost all of it the 60 s poll interval.
- 18:06 Bob's tick: event `eth_refund_mined` (1320), phase **`refunded`**, action "done: ETH refunded". Alice's tick sees
  the lock as `refunded` and keeps waiting for `D` (phase `lock_final`). Contract status: `state: refunded`, events
  `Locked` (716) and `Refunded` (1320), preimage `null`. Balances: contract 0 ETH, Bob 0.99763 ETH (1.0 − the 0.001 Alice
  claimed in run 1 − gas), Alice 1.00091 ETH. Observation: Alice's engine logs no event for the ETH refund (Bob's does);
  harmless, since her decision was already fixed by the cutoff, but a `eth_refund_seen` event would make her log clearer.
- 18:07 Next: Alice's `refund_noid` is expected at tip + 1 ≥ `D` = 281,514 (tip 281,074 now, ≈ 440 blocks).
  Watch loop re-armed (`~/live2-watch-recover.sh`, 2-min polls, Alice only; Bob is done).
- 18:30 Engine fix (commit below): Alice now records `eth_refund_mined` once when her lock is refunded, phase and action
  unchanged; 157 swap-cli tests (my own run). Found on the way: an Alice whose reveal is pending when Bob's refund lands
  has no path to `refund_noid` (TASKS M2.5b). The release binary used by this run is still the 14:59 build.
- 21:54:49 **D reached**: tip 281,515 ≥ D 281,514; Alice's engine: `lock_final` → action **`refund_noid`** (call height
  281,516, fee 5,800). Loop stopped as designed.
- 21:55 First recovery attempt **dropped**: `contract call … --close --preview` at tip 281,519 gave call height 281,520,
  txid `0f261d1c…fcbd`; the send with `--expected-txid` ~20 s later answered "call is no longer pending on this node …
  height-dependent calls may require a fresh preview". The node's `tx`/`mempool-tx` never saw it confirmed or pending,
  the instance still held 10 NOID with the recovery authority, so nothing was lost. Lesson: preview and send must be
  chained within a block (the run-1 claim had been proved for N and included at N+1, but here the tip caught up with the
  call height between the two commands).
- 21:56:37 Second attempt, preview + send chained in one command: call height 281,522, txid
  `dfe6044bc97168ea887938bccf862f9675ad6c549032c7a811767a815fe1ee42`; **confirmed at 281,522**, receipt verified and saved
  (`refund-2.receipt`, "Verified on selected chain at height 281522"); 21:58:42. `contract instances`: none.
  Index-0 UTXO 9,994,200 μNOID (slot 9,727,349, creation 741,980, block 281,522). Both legs closed: ETH refunded to Bob
  at block 1320, NOID recovered by Alice at 281,522. Chain-bound time from D to the recovery confirmed: ≈ 4 min
  (including the dropped attempt).
- 22:00 Alice's engine (release binary of 14:59) still says `refund_noid` after the close because that build does not
  resolve on "instance gone"; the 38e36aa+ engine does (`refund_noid` not offered when the instance is gone). The swap
  file will be advanced with the rebuilt binary.
- 22:00 Wallet bookkeeping question: `balance` (index 0) reads 2,048.926590 NOID, while the earlier reading after run 1
  was 2,138.951190 and run 2 nets −0.0148. `history` shows only this wallet's four swap transactions (two fundings, the
  dropped attempt, the recovery), and every old UTXO is stamped "at block 281,345" (20:28), i.e. the wallet re-indexed
  then. Not explained by any transaction of this wallet.
- 01:10 Resolved: the owner confirmed moving about 90 NOID in the wallet app during the day (a transfer the
  CLI `history` of this data dir does not list). The swap legs are accounted for to the cent; nothing is missing and
  the hold on mainnet funds is lifted.
