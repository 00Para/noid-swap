# Live run 14 — the first swap with the finality-18 code, the reveal sidecar and the producer screen, 2026-11-09

> Clock times in this log are UTC. All of them belong to 2026-11-09. The Parano1d tip is given in brackets.

The sequel of run 13 (`docs/live-run-13.md`): the same swap, the same two machines, the same setting, but the first run with the code of
the batch of 2026-11-08 (finality at 18 blocks, the reveal clock recheck, the reveal sidecar, the producer screen, the claim-removed alert
hook). The swap **settled**: 5 NOID against 0.001 Sepolia ETH, Alice's side final 51 minutes 49 seconds after the funding (run 13: 50
minutes). Bob's side was final at 10:43:56, 47 minutes after the funding.

Words, once (the others are explained in `docs/live-run-11.md`, `docs/live-run-12.md` and `docs/live-run-13.md`). The *reveal sidecar* is a
small file, `<swap file>.reveal-sent`, that `live.js claim` writes next to Alice's swap file just before it broadcasts the reveal. It holds
the lock id, the transaction hash and the time, never the secret. `tick` reads it as evidence that the secret may be public. The *producer
screen* is Bob's check, before his lock, of how many of the recent Parano1d blocks one address produced; under the `sepolia` profile it only
warns.

## Setting

As run 13: 5 NOID against 0.001 Sepolia ETH, lock kind `poseidon`, raw variant, contract version 1, profile `sepolia`, one node per chain
per side (`SINGLE_NODE_OK=1`). Alice was a Windows PC with the helpers under WSL, Bob an Apple Silicon Mac with the native helpers. One
operator played both roles and sent every spend. Both machines ran the same code (public commit `7fe9af5`; the PC binary was rebuilt from
a later tree whose only difference was a line of `TASKS.md`). What is different from run 13:

- **Alice's steps from the helpers, not from the operator console.** The console was left open, but the
  preparation, the object-file check, the watch loop, the funding (dry run, then send through `fund.sh`) and the reveal (dry run, then
  send through `reveal.sh`) were run as helper commands. This run was about the new code, not about the console.
- **The funding came from a terminal right after Bob's bundle check**, as decided after run 13 (`docs/runbook-two-party.md`, section 3).
- **A recent log start.** The Sepolia endpoint had pruned its old logs (finding 1): both machines used `12095751` as the log start.
- **Alice's loop carried the removed-claim alert hook** (`ALERT_URL`); it is meant for Bob's claim, so it could not fire on this side.

## Parameters

| item | value |
|---|---|
| Tip at preparation | 294,401 (09:50:44) |
| `h_create` / `D` | 294,441 / 294,743 (`h_create` + 302) |
| Bob's lock-by / hard lock-by | 294,491 / 294,533 |
| Contract root | `o1c7lf7qntan330yx79adgeskl82r09hfj3gmljc0h84gzrges9uwq8wjy06` |
| Funded instance | slot 615,393, creation id 773,858 |
| Ethereum contract | `HTLCPoseidonV2` at `0x48Ce4D6cf3c175737532017e82B9261b51F8E5eF` (Sepolia), code hash `0xf510d2a3…3ff3` |
| Lock id | `0xb3eee6068f0e390ba363f8f4832825e13c8921a7e78c817bcd0e78c8f19373c6` |
| `T_reveal` / Alice's reveal cutoff | 11:22:12 / 10:52:12 (`T_reveal` − 1,800 s) |
| Bundle | `opening_hex` 1,398 characters, longest run of zeros 1,052, `bundle check: b8e8307734fe7b72` (the same line on both machines) |

## Log

- 09:46 setup, 09:50:44 to 09:50:47 **prepare** (proof-free lock: seconds). 09:50:57 the object file was made with the wallet CLI
  (`contract create`, local, no fee); the object-file check printed "object file OK". The wallet's active address had to be switched back to
  Alice's (index 0) before this; it was Bob's from the end of run 13.
- 09:51:19, 09:51:52 and 09:52:25 **three failed ticks** (finding 1). Just before 09:53 the log start was set to 12,095,751 on the PC; the
  tick at 09:52:59 was clean. The loop (97 ticks in all, 94 clean, the three failures the first three) stopped by itself on `done`.
- The bundle went to the Mac as a file. Bob's `new-bob` printed `bundle check: b8e8307734fe7b72 ok`, the opening was rebuilt byte for
  byte, his own terms matched, and the client R self-test passed. The fingerprint of `opening_hex` (length, zero run, sha256) matched too.
  The Mac checked on its own that the old log start fails and the new one works.
- 09:55:37 **funding dry run**: object file OK, amount 5,000,000 μNOID agreed with the swap file, "would fund 5.000000 NOID once".
- 09:56:58 **funding sent**, once, by the operator with `fund.sh`. Wallet exit 0, Parano1d transaction
  `e67e67174da53e3555bb4602c7c7bde85d748706560a192363cd42f2341a302a`; the marker in the run folder holds the txid and `wallet exit 0`.
- 09:59:03 [294,416] Alice `funded`: exactly one instance. Bob's tool saw it at the same height.
- **A plan mismatch on the Mac.** The run notes on the Mac had run 14 down as the first hostile group (L1, "Alice never funds"), and the operator there stopped Bob's
  applying loop when the instance appeared, continuing with read-only ticks. After a check that the funding was deliberate and
  that run 14 was a normal swap, Bob's applying loop was resumed (about ten minutes lost, no effect on the swap). During the gap a `lock.sh`
  run at 10:08, before the funding was final, was refused by the tool (no frozen intent); nothing was signed or sent.
- 10:12:40 [294,434] the funding is **final**: 18 blocks after the inclusion block 294,416, 15 minutes 42 seconds after the send (the
  chain ran at about 45 s per block in that stretch, and at 30 s later). Bob's engine offered `lock_eth` at 10:12:25 with 57 blocks left
  before the lock-by. **The producer screen warned and did not refuse**, as it must under `sepolia`: one address had produced 50.0 % and
  48.4 % of the two windows, against the 28 % limit. The warning printed in the lock decision of Bob's tick and is in his loop log.
- 10:14:00 **Bob's lock** mined: Sepolia transaction `0x6c6e5987d74bd5f032a72d9c511ad094a64b63b6135f90e778c002d24cf9429a`, block 12,096,858,
  583,853 gas, 4,092 s before `T_reveal`. Alice saw it at 10:14:27 [294,442] with 50 blocks left before the lock-by (run 13: 4 blocks
  inside it).
- 10:29:11 [294,462] the lock is final on Sepolia (15 minutes 11 seconds after it was mined; finalized block 12,096,865) and Alice's
  engine asks for the reveal. The high-priority alert went out at once.
- **The reveal.** 10:29:24 the dry run passed, 1,365 s before the cutoff, with the frozen lock id, Alice's receiver, 0.001 ETH, the pinned
  code hash and `revealSidecar: absent`. 10:30:01 the operator sent it with `reveal.sh`. Sepolia transaction
  `0xbabfdabf1a214c4f9c4b9e1cf3ceeb29e25da0141fb8cc9db09b1670878c6a52`, block 12,096,936, 689,324 gas of the fixed limit of 1,000,000 (the
  same as runs 11 and 13), 1,331 s before the cutoff. Alice `revealed` at 10:31:08 [294,467].
- **The sidecar, watched from outside.** A sampler polling every 50 ms saw `alice.swap.json.reveal-sent` appear at 10:30:01.248 and the
  `sent:` line of the helper's error output at 10:30:01.676, **0.43 s later**. The file held one line: the lock id, the transaction hash
  `babfdabf…6a52` and the Unix time 1794220201. The tick at 10:30:37 read it: its note said that a reveal send was started at that time,
  that the secret may already be public, and that a re-send is judged by the late cutoff `T_reveal − DE`. The result file of the send
  printed `revealSidecar: written`.
- **Bob's claim, from the Mac.** He read the secret at 10:30:20 [294,465]; dry run, then `--submit` at 10:32:56. Parano1d transaction
  `e01657324bc844a0744a2425d05b013b983ab1b35a915fd382ec39edd66364c1`, call height 294,474, included at 294,475 (10:34:03), fee 5,800 μNOID,
  4,994,200 μNOID to Bob's address. Seen from the PC, the contract had no instance at 10:40:33. Bob's claim was final at 10:43:56
  [294,493] (18 blocks after the inclusion), 231 blocks before the claim target `D − 19` (294,724). His file went to `done` and his loop
  stopped by itself.
- 10:48:47 [294,505] **Alice's ETH claim is final** on Sepolia (18 minutes 46 seconds after the reveal block was mined). Her file is `done`
  ("done: ETH received") and her loop stopped by itself.

## Result

| leg | outcome |
|---|---|
| NOID (Bob) | claim `e0165732…64c1`, call height 294,474, included 294,475, final 294,493; 4,994,200 μNOID to Bob's address (5 NOID − 5,800 μNOID close fee); Bob's file `done` |
| ETH (Alice) | reveal `0xbabfdabf…6a52`, block 12,096,936, 689,324 gas; her address gained 999,999,950,368,672 wei (0.001 ETH minus 689,324 gas at 72 wei) |
| ETH (Bob) | lock `0x6c6e5987…429a`, block 12,096,858, 583,853 gas; his address lost 1,000,000,043,788,975 wei (0.001 ETH plus 583,853 gas at 75 wei) |
| Alice's file | `created` → `funded` (09:59:03, 294,416) → `funding_final` (10:12:40, 294,434) → `lock_seen` (10:14:27, 294,442) → `lock_final` (10:29:11, 294,462) → `revealed` (10:31:08, 294,467) → `done` (10:48:47, 294,505) |
| After the run | the Parano1d contract has no instance; Alice's wallet fell by 5.009000 NOID: 5,000,000 μNOID funded plus the funding fee of 9,000 μNOID |
| Cost of the swap | 5,800 μNOID close fee plus 9,000 μNOID funding fee = 14,800 μNOID (0.0148 NOID), as in runs 11 and 12 |
| Time | 51 minutes 49 seconds from funding (09:56:58) to Alice's side final (10:48:47); Bob's side final after 47 minutes |

## What it showed

- **Finality at 18 blocks, live, on both legs.** The funding (included 294,416) and Bob's claim (included 294,475) each became final exactly
  18 blocks after their inclusion block (294,434 and 294,493), the rule of the node's `is_final`; the tool no longer reports final one
  block early.
- **The reveal sidecar on the real Windows-to-WSL path (`TASKS.md` T21-15).** It is written before the broadcast (0.43 s earlier, seen
  from outside at 50 ms resolution), through the `\\wsl.localhost` share and without a secret in it, and the next `tick` reads it and applies
  the late cutoff to a re-send. Closed.
- **The producer screen under `sepolia`** warned and did not refuse, with the shares of the two windows and the limit, and the lock went
  ahead as intended.
- **The reveal clock recheck** ran inside the send (it prints nothing when it passes) and did not refuse: the send was 1,331 s before the
  cutoff. Its refusal path was not seen live.
- **The lock-by margin** printed from the first tick (57 blocks for Bob when the lock was offered, 50 when Alice saw it), against 6 and 4 in
  run 13; the terminal funding right after Bob's check gave Bob the room.
- **`new-bob` and the bundle check** passed at the first try with the bundle handed over as a file.
- The swap settled a fourth time across two machines.

## Findings

All low, unless said.

1. **The public Sepolia endpoint pruned its old logs** (medium for usability, none for safety). Without a recent log start every tick
   failed with `rpc error 4444: pruned history unavailable`. Run 13, three days earlier, had read from the contract's deployment block
   12,072,004 without trouble; today that range and the helpers' default (12,066,295) both fail. A swap that cannot read the lock cannot
   settle: the failure is loud, and the fix is a recent block in `eth-deploy-block.txt` (a safe value is a few thousand blocks below the head,
   because the lock comes later in the run). Both machines needed it. Done 2026-11-09: `setup.sh` takes the finalized block of the configured node by default (`scripts/live/README.md`, "The Ethereum log start"); the
   deployment block is no longer the default.
2. **The two machines had different written plans** (low). The plan on the Mac had run 14 as the first hostile group ("Alice never
   funds"); the PC side had a normal swap. The Mac's safety stop worked (read-only ticks, a refused lock, nothing sent) and cost about ten
   minutes. The hostile groups L1 to L6 of `docs/hostile-run-plan.md` therefore start at run 15. Every run needs one written plan that both
   sides read before the funding.
3. **The producer warning is in the loop log only, not in Bob's swap file** (low, by design: the file records only the override flag). It
   is printed in the lock decision and kept in the log of the loop.
4. **The wallet's active address was Bob's after run 13** (low). It was switched to Alice's by hand before the object file and the
   funding, as the preparation note says the recovery needs; the funding helper's dry run passed after the switch, and a wrong active
   address was not tried.
5. **The reveal window under `sepolia` was 22 minutes** between the lock being final (10:29:11) and the cutoff (10:52:12), with the
   reveal sent 51 seconds after the engine asked for it.

## What it did not show

- **The claim-removed alert.** No claim was removed, so the hook never fired; it is configured on the PC's loop, where it cannot apply (it
  is meant for Bob's claim). Its path is still untested live.
- **The producer screen's refusal** (it refuses only under `production`, and the production profile was not run).
- The two-node rule (`SINGLE_NODE_OK=1`), a hostile counterparty (one operator played both roles), the stock variant and contract version 2.
- The operator console on a spend (it was open and unused).

Next free run number: 15.
