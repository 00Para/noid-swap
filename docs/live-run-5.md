# Live run 5 — happy path with the proof-free Ethereum lock kind (`poseidon`), 2026-11-05

> Clock times in this log are UTC (converted from the loop files' local clock with the offset of five hours confirmed in run 4; the Sepolia block timestamp of Bob's lock, 1793913228 = 21:13:48, agrees with it).

First swap with the `poseidon` lock kind (`docs/poseidon-leg.md`): the Ethereum side is `HTLCPoseidonV2`, locked directly on the
Parano1d claim authority `A = Addr(s)`, so the contract itself checks the secret against the address that the NOID lock commits
to. Bob therefore needs **no equivalence proof and no receipt**: nothing is proved before he locks, and `prepare.sh` finished
in seconds (both files, Bob's client R self-test 3.3 s, the contract definition). Scenario: happy path, raw variant, contract
version 1, `sepolia` profile, the owner in both roles, one node per chain (`SINGLE_NODE_OK=1`). Expected: Alice funds, Bob locks
0.001 ETH once the funding is final, Alice reveals by claiming on Sepolia, Bob reads the secret from the claim, checks
`Addr(preimage) == A` and claims the NOID, both files end `done`. The review of this lock kind (`swap-cli/REVIEW-6.md`) had
cleared it for exactly this setting (owner in both roles, Sepolia) before the run. The helpers were installed from the working
tree for this run.

## Parameters

| item | value |
|---|---|
| Profile / variant / contract / lock kind | `sepolia` / raw / version 1 (`HashTimeLock`) / `poseidon` (`HTLCPoseidonV2`), `--single-node-ok` on both chains |
| Amount (NOID) / `max_fee` | 10 NOID (10,000,000 μNOID) / 50,000 μNOID |
| Amount (ETH) | 0.001 ETH (1,000,000,000,000,000 wei) |
| Tip at preparation | 284,232 |
| `h_create` (planned) / `D` | 284,240 / 284,540 (`h_create` + 300) |
| Bob's lock-by | 284,289 |
| Contract root | `o1ptsrsdh4s48rrxq059gu0qc05k45kkwys9uhkftfmp29a7675fnqzwtphc` |
| Alice (funds, recovers, receives ETH) | wallet index 0 `o1zjj6zqc7…utpurk`; Sepolia address of Alice's key |
| Ethereum contract | `HTLCPoseidonV2` `0x48Ce4D6cf3c175737532017e82B9261b51F8E5eF`, deployed in Sepolia block 12,072,004, tx `0x99d15031e12ac0fa67de1f590f1966c26e7d1ef554bffb6ba11bb8bdcbde8e08`; code hash `0xf510d2a368c730339fa7cf5e023bcf2429d5732793f043e03025780bb7043ff3` = the pin compiled into the tool |
| Hashlock on Ethereum | the NOID claim authority `A` itself (no SHA-256 hashlock; the bundle's `hashlocks.txt` shows the lock word) |
| Lock id | `0xdfc993d4066be6eae7a2bdb5448f4fba6bd7395344c442824e5a33583d05d72f` |
| Folder | `~/live-run-5/` in WSL (both swap files, bundle, `loop-alice.txt`, `loop-bob.txt`, `eth-*.json`, `claim-*.out`, `rec/`) |

## Log

- 21:00:59 **Funded**: txid `68b18c83c37c68ab84dd8f2082206023e7f3a8d999787cc72945b877ac76f23a`, fee 9,000 μNOID.
- 21:01:30 First tick of the watch loop (every 65 s or so): tip 284,236, "node is behind H_create". 21:02:28 instance visible at
  tip 284,238 (slot 628,523, creation id 751,918, 10,000,000 μNOID, matches the opening): `funded`.
- 21:12:51 Bob's engine, tip 284,256: **`lock_eth`**. 21:13:33 Alice: `funding_final` (tip 284,258).
- 21:13:14–21:13:52 **Bob's lock**: dry run first (it scanned 0 earlier `Locked` events on the new contract, the full-log rule of
  REVIEW-6), then the send at about 21:13:52, tx `0x6d7eb298ff1fc437d1bc77e19b0e3df7d286cf6ab823f50a514e3cd2e4137c1a`,
  Sepolia block 12,072,071 (timestamp 1793913228, 21:13:48). 21:13:51 Bob's engine holds the intent ("the chain does not show
  it yet"); 21:14:38 Alice sees the lock (`lock_seen`); 21:14:59 Bob: `locked`, "waiting for the secret".
- 21:28:41 Lock final on Sepolia, tip 284,290: Alice's engine says **`reveal_eth`**.
- 21:28:57 reveal dry run (no secret in the simulation). About 21:29:51 **reveal sent** with a fixed gas limit of 1,000,000, no
  gas estimate: tx `0x5be71c75e9266129b7e0a6fcf94707b9e4d0e285ab423ef58c9fe0127657fe90`, Sepolia block 12,072,148. 21:30:31
  Alice: `revealed`, "waiting for ETH claim finality".
- 21:30:45 Bob's engine reads the secret from the claim, checks `Addr(preimage) == A`: **`claim_noid`** (phase `secret_seen`,
  tip 284,295).
- 21:30:18 claim dry run (call height 284,294, fee 5,800 μNOID, 9,994,200 μNOID to Bob's address); 21:31:09 **claim submitted**
  re-proved for call height 284,298 (the tip had moved), txid
  `4e1a0384316c5a47ac94269b2c388429101846a14fb00c4f157e4da966f01de3`. 21:31:40 Bob: `claim_submitted`, "NOID claim pending";
  21:33:42 `claim_included` (tip 284,302).
- 21:39:55 Tip 284,317: the claim is final, Bob's file **`done`** ("done: NOID received").
- 21:48:21 Sepolia has finalized Alice's reveal, tip 284,326: Alice's file **`done`** ("done: ETH received"). Both watch loops
  stopped on the terminal phase. One tick of Bob's loop exited 1 at 21:48:42 (a single failed poll right after Alice's file went
  terminal; the next tick at 21:49:36 was exit 0, `done`); every other tick of both loops exited 0, 48 lines each.

## Result

| leg | outcome |
|---|---|
| NOID (Bob) | claim txid `4e1a0384…1de3`, call height 284,298, final at tip 284,317; 9,994,200 μNOID to Bob's address (10 NOID − 5,800 μNOID close fee) |
| ETH (Alice) | reveal tx `0x5be71c75…fe90`, Sepolia block 12,072,148, finalized by 21:48:21 |
| Alice's file | `created` → `funded` (284,238) → `funding_final` (284,258) → `lock_seen` (284,260) → `lock_final` (284,290) → `revealed` → `done` (284,326, 21:48:21) |
| Bob's file | `received` → `funded` → `funding_final` (284,256) → `locked` (284,260) → `secret_seen` (284,295) → `claim_submitted` → `claim_included` (284,302) → `done` (284,317, 21:39:55) |
| Wallet balance | index 0: 2,038.902790 → 2,028.893790 NOID: 10 NOID swapped + 9,000 μNOID funding fee |
| Bob's address | received 9.994200 NOID |
| Alice's Sepolia address | 0.006 → 0.007 ETH |
| Time | about 47 minutes from funding (21:00:59) to both sides final (21:48:21); run 3 took 44 minutes after a 25-minute proof |

Operational notes from the run:

- No proof step: the equivalence proof of run 3 (about 25 minutes of the owner's laptop, one heavy job at a time) is gone from
  the critical path; the lock-by margin (`D − 251`, here 284,289) was never under pressure, Bob locked at 284,258.
- The claim on Sepolia costs about 500,000 gas because the Poseidon permutation runs in the EVM; hence the fixed 1,000,000 gas
  limit and no estimate (an estimate would be a simulation that carries the secret). At Sepolia prices this is nothing; on
  mainnet it is a real cost and the reason the kind is for the testnet until it is priced.
- The reveal dry run and the claim dry run both ran before the real sends, as in the earlier runs; the claim was re-proved for
  call height 284,298 because the tip moved between the dry run (284,294) and the send.
- The deploy took one transaction; the code hash printed by the deploy equals the hash compiled into the tool, so the engine
  accepted the contract without a flag.

## What it showed

- The proof-free lock kind works end to end on public Sepolia: Bob locks on `A` itself, Alice's claim reveals `s`, and Bob's
  engine accepts it only because `Addr(preimage) == A`, with no receipt anywhere in the chain of trust.
- The new gates behaved on a live run: the full-log scan found no earlier lock on the new contract, the code hash matched the
  pin, the self-test of client R ran before Bob could lock, the reveal went out with a fixed gas limit and without a secret in
  any simulation.
- Preparation dropped from a proof of minutes to seconds, and the whole swap from funding to both sides final took about 47
  minutes, bounded by the 18-block finality on the NOID side and Sepolia's finality for Alice's reveal.

## What it did not show

- Two nodes per chain (`SINGLE_NODE_OK=1`, one node each), a hostile counterparty (the operator played both roles), the abort
  paths with this lock kind (Alice never reveals, Bob never locks, a foreign dust lock on the contract), a reorg or an eviction.
- Mainnet gas: a claim at about 500,000 gas has not been priced against real fees; the kind stays a testnet kind for now.
- The stock variant, contract version 2, the `production` profile, the rotation case and the conflicting-close case.
- The four findings of `swap-cli/REVIEW-6.md` that are open (the full-log scan stopping Bob's tool after the reveal, a foreign
  dust lock blocking Bob, a mined-but-reverted claim going unseen, the unbound self-test record) were not triggered by this run.
