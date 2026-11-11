# Live runs 9 and 10 — the first two-machine runs, both ended on their abort paths, `poseidon` lock kind, 2026-11-06

> Clock times in this log are UTC. All of them belong to 2026-11-06. The Parano1d tip is given in brackets.

Two runs, one log, because they overlapped in time and share their setting. Both were meant to be swaps; both ended as aborts, and
both aborts were clean: nobody lost anything but fees. Run 9 stopped **before any lock** because the NOID contract was funded more
than once by mistake. Run 10 stopped **after Bob's lock** because Alice's reveal was not sent in time.

Words, once. An *instance* is one funded copy of the Parano1d contract: the same opening can be funded any number of times, and each
funding makes another instance with its own slot. The *reveal* is Alice's claim of the ETH: it publishes the secret `s` on Ethereum,
and from then on anyone can read it; that is how Bob gets the NOID. `T_reveal` is the time after which Alice may no longer claim and
Bob may refund. The *reveal cutoff* is a margin before `T_reveal` (1,800 s here) after which Alice's tool refuses to reveal at all, so
a reveal can never race Bob's refund. `D` is the Parano1d block height at which the NOID lock flips from Bob's claim to Alice's
recovery. *Lock-by* is the last block at which Bob may still lock. *Finality* is the point after which a block can no longer be undone
(18 blocks on Parano1d, about 18 minutes on Sepolia).

## Setting (both runs)

5 NOID against 0.001 Sepolia ETH, lock kind `poseidon` (`docs/poseidon-leg.md`: no equivalence proof, no receipt), raw variant,
contract version 1, profile `sepolia` (`D = h_create + 300`, Bob's lock-by `D − 251`, reveal window 4,200 s, reveal margin 1,800 s),
`SINGLE_NODE_OK=1` on both sides.

**New in these runs: two machines.** Alice was a Windows PC with the helpers under WSL. Bob was an Apple Silicon Mac with the helpers in
**native mode** under the system bash 3.2, for the first time (`docs/mac-setup.md`). Each machine used its own Parano1d node, so two
independent nodes took part, and a public Sepolia endpoint. Each party still had one node per chain: the second-node cross-check (F5)
was waived on both sides by `SINGLE_NODE_OK=1`.

- Bob's Ethereum key was created on the Mac (`live.js keygen`) and topped up with 0.005 Sepolia ETH from the PC's test address. No key
  moved between the machines.
- Alice's bundle (2,478 bytes, no secret in it) went to the Mac by copy and paste. `new-bob` there rebuilt the opening byte for byte
  and passed the client R self-test.
- Bob's NOID recipient was an address of the operator's existing wallet. A claim only names a recipient, so the Mac needed no wallet.
- Every spending step was run by the operator by hand; the tools did the dry runs and the checks. Nothing was sent automatically.

## Run 9 — stopped before any lock

### Parameters

| item | value |
|---|---|
| Tip at preparation | 284,987 (03:12:29) |
| `h_create` (planned) / `D` | 285,027 / 285,327 (`h_create` + 300) |
| Bob's lock-by | 285,076 (`D − 251`) |
| Contract root | `o1cjyzm6pshl65exxl2uj48dwuj3vknp45njdcn5u0x4qlud3x985qy8a4qf` |

### Log

- 03:12:29 prepared. The object file made by the wallet CLI was checked against Alice's swap file: OK.
- About 03:18 the operator ran the wallet CLI's `contract fund` **twice by mistake** (a double click). Both fundings were mined at
  [285,000]: **two instances of the same contract**, 5 NOID each (slot 590,568, creation id 754,411; slot 620,470, creation id 754,409).
- About 03:28 the same old command was run a **third** time by mistake: a third instance (slot 641,266, creation id 754,469) at
  [285,014].
- What the tools did. Alice's tick notes said "instance seen but not accepted: 2 instances at our contract root fit the agreement and
  the tool will not guess which one is the lock's" (then 3), with every slot listed. Her action stayed `wait`. Until `h_create` the
  reason shown was "node is behind H_create"; after it, "an instance already exists at our contract root but was not accepted; not
  funding again (check its amount and the contract state)". At [285,054] (03:50:46) her engine said `abort`: "too late to fund: tip
  285054 + 23 > lock-by 285076". Her file ended `aborted`, from `created`; it never reached `funded`. Bob never locked, and his run 9
  loop on the Mac was stopped when run 10 replaced it.
- This is the designed behaviour. Once the secret is public, Bob could close every instance that fits the agreement to his own
  address, so with more than one instance Alice would be giving away more than the agreed amount. Therefore Bob's tool does not lock,
  and Alice's tool does not reveal, while more than one instance fits (`swap-cli/src/engine.rs`, the "more than one instance" rule,
  REVIEW-2 F10).
- **Recovery after `D`.** Three recovery closes with the wallet CLI, one per instance. Each was previewed, checked (a recovery,
  terminal, paying Alice's own address 4,994,200 μNOID after the 5,800 μNOID fee) and sent chained to its preview (`--expected-txid`),
  by a script the operator ran once. Parano1d txids:
  - slot 590,568: `23dbbd9683c255a1890b8268d6e8fc7d1a25cab5a9a290c1f1b863b7457795a0`
  - slot 620,470: `b60a64ef877a24dadd2dcacb5e282637ed8a372f183abc7dd879694710a762e4`
  - slot 641,266: `1dc4e3bf67c8f57c24b1a0be62d18aa6a74d89c227f9c8fbe2e8d1ce912d32b2`

  All three were confirmed between 07:31 and 07:34 and their receipts verified. The contract root has no instance left.

### Result

| leg | outcome |
|---|---|
| ETH | nothing locked, no Sepolia transaction for this run |
| NOID (Alice) | three instances of 5 NOID, all three recovered at `D`; 4,994,200 μNOID back from each |
| Alice's file | `created` → `aborted` (tip 285,054, 03:50:46) |
| Cost | three fundings (9,000 μNOID each) and three recovery closes (5,800 μNOID each) |

## Run 10 — abort after Bob's lock: Alice's reveal was not sent in time

### Parameters

| item | value |
|---|---|
| Tip at preparation | 285,002 (03:22:24) |
| `h_create` (planned) / `D` | 285,042 / 285,342 (`h_create` + 300) |
| Bob's lock-by | 285,091 (`D − 251`) |
| Contract root | `o13y4xgp3mrktthv3pszlj4xpk7s84quhkdthvjmayyv7t8azr5gnsk2z9x9` |
| Ethereum contract | `HTLCPoseidonV2`; its code hash equals the pin compiled into the tools, `0xf510d2a368c730339fa7cf5e023bcf2429d5732793f043e03025780bb7043ff3` |
| `T_reveal` / Alice's reveal cutoff | 1793940552 (04:49:12) / 04:19:12 (`T_reveal` − 1,800 s) |

Same parties and settings as run 9, with a fresh secret. The Mac built Bob's file from the new bundle and started his loop.

### Log

- **Funding, once.** Through a fund-once script (a marker written atomically before the wallet CLI runs, and a refusal when the contract
  already has an instance), run once at 03:27:16. One instance (slot 650,617, creation id 754,471) at [285,014]. Alice `funded` at
  03:29:10 [285,014]; the funding was final at 03:39:33 [285,031].
- **Bob's lock (on the Mac).** The lock dry run passed and the operator sent the lock. It was mined in Sepolia block 12,073,969 at
  03:40:48 (chain time 1793936448), 54 Parano1d blocks before his lock-by. Alice saw it at 03:41:21 [285,037].
- 03:58:55 [285,068] the lock is final on Sepolia (18 minutes after it was mined) and Alice's engine asks for the reveal.
  03:59:19 the reveal dry run passed: lock kind, amount, receiver and code hash (equal to the pin) were right, and 1,190 s were left to
  the cutoff. **The operator was not at Alice's machine during those 20 minutes and the reveal was not sent.** No claim transaction
  exists: there is no claim record in the run folder, and Alice's Sepolia nonce was the same for the latest and the pending block.
- 04:20:54 the recorded `reveal_eth` intent was cancelled with `swap-cli intent --cancel` (it checks the chain first). The next tick:
  action `wait`, reason "reveal cutoff passed; keeping the secret and waiting for D", note "not revealing: (I2) reveal cutoff passed:
  now 1793938870 > T_reveal - M_A = 1793938752; do NOT broadcast". **The secret was never published.**
- **Bob (Mac).** He never saw a secret and `claim_noid` never appeared. After `T_reveal` he ran the refund dry run and then sent the
  refund: Sepolia transaction `0x782ac39a9aea99641957c894f469b1136503eafe0c9f67baef0c5b5d85656858`, block 12,075,083, gas 145,652.
  His file went to `refund_mined`, and once Ethereum had finalized the refund's block it reached **`refunded`**; his loop stopped by
  itself (reported from the Mac, not read from this machine). His balance went from 0.005 ETH to 0.00499999998 ETH: the 0.001 ETH came back and the Sepolia gas
  was negligible. On macOS the lock and refund dry runs, the two sends and 413 ticks all exited 0, with no helper error.
- **Alice.** `refund_noid` was offered at `D` [285,342], 06:15:26. At 07:31 the operator ran the recovery script: Parano1d txid
  `62b6f042b3d4194671f3e6883b82c35e837b986909c1e324ced2351ff4fe22d1`, confirmed at height 285,497, receipt verified. `tick
  --closed-by` recorded it: event `noid_closed_externally`, phase `refund_included` at 07:33:02 [285,501]. After 18 more
  blocks the close was final: **`refunded`** at 07:45:29 [285,515], and Alice's loop stopped by itself.

### Result

| leg | outcome |
|---|---|
| ETH (Bob) | lock in block 12,073,969; refund tx `0x782ac39a…6858`, block 12,075,083, 145,652 gas; 0.001 ETH back, no preimage on chain |
| NOID (Alice) | recovery close txid `62b6f042…22d1`, confirmed at 285,497; 4,994,200 μNOID back (5 NOID − 5,800 μNOID close fee) |
| Alice's file | `created` → `funded` (285,014) → `funding_final` (285,031) → `lock_seen` (285,037) → `lock_final` (285,068) → `refund_included` (285,501, 07:33:02) → `refunded` (285,515, 07:45:29) |
| Bob's file | `received` → `funded` → `funding_final` → `locked` → `refund_mined` → `refunded` |
| Secret | never published |

## Cost of both runs

Four fundings (9,000 μNOID each) and four recovery closes (5,800 μNOID each): 59,200 μNOID, 0.0592 NOID. The wallet's balance is lower
by exactly that amount. On the Ethereum side only Sepolia gas. Nothing was lost.

## What it showed

- The more-than-one-instance rule held on real chains. After a double funding neither side went on, and every copy came back at `D`.
- The first runs with the two roles on two machines and two independent Parano1d nodes, with the bundle carried by hand and the opening
  rebuilt and checked byte for byte on the second machine.
- The first live use of the native-mode helpers on macOS under bash 3.2: install, setup, `new-bob`, the watch loop, the lock and the
  refund all worked without an error.
- The abort after Bob's lock on two machines: Alice kept the secret past the cutoff, Bob refunded after `T_reveal`, and Alice
  recovered at `D`.
- The reveal gate refused cleanly: the cutoff is enforced, and a late reveal cannot be sent.

## Findings

1. **Funding twice is one double click away with the wallet CLI.** Fixed after run 9: `scripts/live/fund.sh` funds exactly once. It
   runs `check-object.sh` and stops unless the object file matches the swap file's opening; it refuses a second run for the same run
   folder (a marker file written before the wallet CLI is called) and a contract that already has an instance.
2. **After an abort from `created` with instances at the contract root, Alice's tool does not say that NOID sits at the root and does
   not offer the recovery at `D`; her loop stops at `aborted`.** Before `h_create` the reason shown was "node is behind H_create"
   while the real matter (several instances) was only in the notes. The recovery was done with the wallet CLI through a script. Open,
   low: name the instances in the reason, and offer the recovery at `D` for every instance at the root.
3. **The time between "lock final" and the reveal cutoff was 20 minutes under `sepolia`** (lock mined 03:40:48, final seen 03:58:55,
   cutoff 04:19:12). With an operator who has to be at one particular machine, that was missed. The abort was clean, but a run on two
   machines with hand-sent steps should be planned so that Alice's operator is at her machine from Bob's lock on. A longer reveal
   window for such runs is a question for the profile.
4. **Alice's recovery was a hand-made script.** After these runs it is a helper: `scripts/live/recover-noid.sh` (every instance at the
   root, preview check, chained send, a marker per instance). The helper form has not been run live; the scratch version was.
5. **Not exercised on macOS:** `claim.sh`, because there was no reveal.

## What it did not show

- The happy path across two machines (Bob's claim from the Mac).
- Two nodes per chain for each party (`SINGLE_NODE_OK=1` on both sides), and a hostile counterparty (one operator played both roles).
- Contract version 2, the stock variant, the rotation case, the conflicting-close case, and Ethereum mainnet on two machines.

A retry (run 11) is planned. There is no run 7 log (see `docs/live-run-8.md`); the next free run number is 11.
