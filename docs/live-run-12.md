# Live run 12 — the two-node check live: the same two-machine swap with two nodes per chain, 2026-11-06

> Clock times in this log are UTC. All of them belong to 2026-11-06. The Parano1d tip is given in brackets.

The sequel of run 11 (`docs/live-run-11.md`): the same swap, the same two machines, but without `SINGLE_NODE_OK`. Each side gave the tool
two Parano1d nodes and two Sepolia endpoints, so the two-node check ran live for the first time. The swap **settled**: 5 NOID against
0.001 Sepolia ETH, both legs final 45 minutes after the funding (run 11: 44).

Words, once (the others are explained in `docs/live-run-11.md`). The *two-node check* (called F5 in the reviews and in
`swap-cli/README.md`) is a rule of the `sepolia` and `production` profiles: Bob's lock needs a second Parano1d node, and Alice's reveal
(and Bob's reading of the secret) needs a second Ethereum node. The tool compares the two answers and waits if they differ or if the
second node cannot be read. The flag `--single-node-ok` waives the rule; run 11 used it, this run did not. A *tunnel* here is an SSH
connection that carries a port of one machine to the other, so a node that listens only on its own loopback can still be reached.

## Setting

As run 11: 5 NOID against 0.001 Sepolia ETH, lock kind `poseidon`, raw variant, contract version 1, profile `sepolia`. Alice was a
Windows PC with the helpers under WSL, Bob an Apple Silicon Mac with the native helpers. Every spending step was run by the operator by
hand, each after a dry run. The funding went through `scripts/live/fund.sh`. What is new:

- **Parano1d: each machine's own node plus the other machine's node.** One SSH connection from the PC, with a local and a remote port
  forward, carried both: the PC saw the Mac's node on a local port, the Mac saw the PC's node on a local port. Both machines were on the
  same private network. The nodes answer the owner methods that `tick` needs only to a loopback caller, which is why a tunnel was used
  and no RPC port was opened to the network (`docs/mac-setup.md` section 6 describes it; it was marked untested there and is now
  tested).
- **Ethereum: two different public Sepolia endpoints on each side.**
- No `SINGLE_NODE_OK` anywhere. The helpers passed no `--single-node-ok`, so at the two steps that need a second node the engine would
  have waited had a second node been missing or in disagreement.
- Before the run, a read-only `tick` of the finished run 11 files with two nodes per chain passed on the PC.

## Parameters

| item | value |
|---|---|
| Tip at preparation | 286,179 (13:05:14) |
| `h_create` / `D` | 286,219 / 286,519 (`h_create` + 300) |
| Bob's lock-by | 286,268 (`D − 251`) |
| Contract root | `o1q6w0el7ldje4prrl33y9hn24hu863nt53zmjqdpg2p2527uhu08qfsp2nu` |
| Funded instance | slot 610,527, creation id 757,525 |
| Ethereum contract | `HTLCPoseidonV2`; the code-hash pin compiled into the tools is `0xf510d2a368c730339fa7cf5e023bcf2429d5732793f043e03025780bb7043ff3` (the engine waits on a mismatch) |
| `T_reveal` / Alice's reveal cutoff | 14:29:36 / 13:59:36 (`T_reveal` − 1,800 s) |

## Log

- 13:05:14 [286,179] **prepared.** The object file was checked against Alice's swap file: OK. `fund.sh --dry-run`: OK.
- **The Mac, before anything was sent.** The end of the tunnel on the Mac answered with the same height and the same best block hash as the
  Mac's own node. `setup.sh` printed no single-node warning. The bundle was copied, not retyped, and `new-bob` passed. A read-only tick
  named two Parano1d sources and two Ethereum sources.
- 13:09:08 **`fund.sh` ran once.** One instance (slot 610,527, creation id 757,525), mined at [286,189]. Alice `funded` at 13:10:07; the
  funding was final at 13:20:15 [286,207].
- **Bob's lock, from the Mac.** The engine offered `lock_eth` at [286,206] with both Parano1d nodes read. Sepolia transaction
  `0x84a57ed6cba30c17b6edd1805af3407ca0b315995f0deb9873dc7e102a76b963`, block 12,076,816, mined at 13:21:00, 583,853 gas, seen on both
  Ethereum endpoints. Alice saw it at 13:21:24 [286,209], 59 Parano1d blocks inside the lock-by.
- 13:34:33 [286,240] the lock is final on Sepolia (13.5 minutes after it was mined, both endpoints read) and Alice's engine asks for the
  reveal. 13:34:59 the dry run passed, with 1,476 s left to the cutoff.
- **The reveal.** The operator started it at 13:35:48: Sepolia transaction
  `0xdb852c100d24532bf0c6d81976a90cfa99f609c9eb44fecf632ee1a530f414cc`, block 12,076,891, 689,312 gas of the fixed limit of 1,000,000.
  Alice `revealed` at 13:36:55 [286,242], about 23 minutes before the cutoff.
- **Bob's claim, from the Mac.** He read the secret at [286,242]. `claim.sh` dry run, then `claim.sh --submit`. Parano1d txid
  `e15596ea8b9256b7caa08fe7470d1fe6e94236ecdadd154770656ba4a63ab0f4`, call height 286,243, confirmed at 286,244, fee 5,800 μNOID,
  payout 4,994,200 μNOID to Bob's address. Both Parano1d nodes showed the same height and block hash. Bob's file went to `done` and his
  loop stopped by itself (67 ticks, none failed).
- 13:54:14 [286,279] Alice's ETH claim is final on Sepolia. Her file is `done` and her loop stopped by itself (73 ticks; every one read
  both Parano1d nodes and both Sepolia endpoints, with no disagreement and no second-node wait).
- **One slip, harmless.** The command for Bob's lock, meant for the Mac, was also pasted into a shell on the PC, where it failed as a
  syntax error. The lock had already gone out from the Mac. Nothing was sent twice. Lesson: label every command in a runbook with the
  machine it belongs to.

## Result

| leg | outcome |
|---|---|
| NOID (Bob) | claim txid `e15596ea…b0f4`, call height 286,243, confirmed at 286,244; 4,994,200 μNOID to Bob's address (5 NOID − 5,800 μNOID close fee); Bob's file `done` |
| ETH (Alice) | reveal tx `0xdb852c10…14cc`, block 12,076,891, 689,312 gas, final at 13:54:14; 0.001 ETH received |
| ETH (Bob) | lock tx `0x84a57ed6…b963`, block 12,076,816, 583,853 gas |
| Alice's file | `created` → `funded` (13:10:07) → `funding_final` (286,207) → `lock_seen` (286,209) → `lock_final` (286,240) → `revealed` (286,242) → `done` (286,279, 13:54:14) |
| After the run | the Parano1d contract has no instance; Bob's address holds a new output of 4.994200 NOID; Alice's NOID wallet is lower by 5.009000 NOID (5 NOID + the 9,000 μNOID funding fee); on Sepolia Alice's address gained 0.001 ETH and Bob's lost 0.001 ETH |
| Cost of the swap | 0.0148 NOID (9,000 μNOID funding fee + 5,800 μNOID close fee) |
| Time | 45 minutes from funding (13:09:08) to both sides final (13:54:14); run 11 took 44 |

## What it showed

- The two-node rule ran live on both sides and in both directions: Bob's lock behind two Parano1d nodes, Alice's reveal and Bob's
  reading of the secret behind two Ethereum endpoints. Alice's 73 ticks showed no disagreement and no second-node wait.
- The SSH tunnel recipe works: one connection with a local and a remote forward gave each machine the other's node, and the node's RPC
  stayed on loopback on both machines.
- The full swap settled a second time across two machines, with the same timing as run 11.

## Findings

All low. They come from the Mac's report and from the PC's ticks.

1. **A false impression on every tick.** The tool prints "`--noid-rpc`: both nodes are on the host localhost (…): a second node on the same
   machine shares its network view, so their agreement is a weaker check (G3)" on every tick, because a tunnelled node appears on
   localhost although it runs on another machine. Informational. A way to tell the tool that a local port is a tunnel to another machine
   would remove the false impression. What the caveat still means here, honestly: the two nodes were on two machines, but on the same
   private network and behind the same internet connection, so they are not two independent networks (see "What it did not show").
2. **No positive line says the second node agreed.** Agreement is only implied by the step being offered. A printed confirmation (which
   node, which height and hash) would make the check visible in the logs.
3. **`lock.sh` recorded `"blockTimestamp": null`** for the lock in its result file, although the block's time was known from the chain. A
   record field only.
4. **Bob's claim goes to the primary Parano1d node only**, even with two configured. `swap-cli claim` has a `--submit-rpc URL` flag that
   sends the intent to further nodes too; `claim.sh` does not pass it.
5. **`claim.sh` prints only the first 40 lines of its output.** The full output file is complete.
6. **Gas** on Sepolia was again 583,853 for the lock and 689,312 for the reveal (run 11: 583,841 and 689,324), consistent with finding 2
   of `docs/live-run-11.md`.

## What it did not show

- Two independent networks for the second nodes: both machines were on one private network behind one connection.
- A hostile counterparty (one operator played both roles).
- The stock variant and contract version 2.

There is no run 7 log (see `docs/live-run-8.md`); the next free run number is 13.
