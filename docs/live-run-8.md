# Live run 8 — the first swap with the Ethereum leg on public mainnet, proof-free lock kind (`poseidon`), `production` profile, 2026-11-06

> Clock times in this log are UTC. All of them belong to 2026-11-06. The Parano1d tip is given in brackets.

> **Ethereum mainnet identifiers are kept out of this log on purpose.** No Ethereum address, contract address, transaction hash, block
> number, lock id or lock word is written here. They are in the operator's run folder. Ethereum-side facts are given as amounts, gas,
> fees and durations only. The Parano1d side (contract root, txids, heights) is given in full, as in the earlier logs.

> Numbering: there is no `docs/live-run-7.md`. Run 7 was prepared with 10 NOID and never funded; it was replaced by this run at 5 NOID.

The happy path of run 5 (`docs/live-run-5.md`), moved from Sepolia to **Ethereum mainnet** (chain id 1), so the ETH, the gas and the
network are real. It is also the first live use of the `production` profile (the design's timing numbers, no amount caps) and of the
mainnet gate of `live.js` (`--mainnet`, `--max-fee-gwei`, and `--swap FILE` mandatory). The plan was `docs/live-run-mainnet-plan.md`.

Words, once. The *hashlock* is the lock that opens only with a secret `s` that Alice alone knows. In the `poseidon` lock kind
(`docs/poseidon-leg.md`) the Ethereum contract (`HTLCPoseidonV2`) is locked on the Parano1d claim authority `A = Addr(s)` itself, so the
contract checks the secret against the same address the NOID lock commits to, and Bob needs **no equivalence proof and no receipt**.
The *reveal* is Alice's claim of the ETH: it publishes `s` on Ethereum, and from then on anyone can read it; that is how Bob gets the
NOID. *Finality* is the point after which a block can no longer be undone.

Scenario: happy path, raw variant, contract version 1 (`HashTimeLock`, the version of run 5 and the default of the helpers), `production`
profile. One operator played both roles on one machine, with one Parano1d node and one public Ethereum RPC endpoint
(`SINGLE_NODE_OK=1`). The two-node path is still not run live. The Ethereum contract was deployed fresh on mainnet before the run with
two fresh keys (one per role); its code hash equals the pin compiled into the tools, `0xf510d2a368c730339fa7cf5e023bcf2429d5732793f043e03025780bb7043ff3`.
**Every spending step (funding, lock, reveal, claim) was sent by the operator by hand with one helper command, each after a dry run
was checked. Nothing was sent automatically.**

## Parameters

| item | value |
|---|---|
| Profile / variant / contract / lock kind | `production` / raw / version 1 (`HashTimeLock`) / `poseidon` (`HTLCPoseidonV2`), `--single-node-ok` on both chains |
| Amount (NOID) / `max_fee` | 5 NOID (5,000,000 μNOID) / 50,000 μNOID |
| Amount (ETH) | 0.001 ETH (1,000,000,000,000,000 wei) |
| Tip at preparation | 284,710 |
| `h_create` (planned) / `D` | 284,718 / 285,453 (`h_create` + 735) |
| Bob's lock-by | 284,824 (`D` − 629) |
| Alice's reveal window `W_A` / reveal margin | 7,200 s / 1,800 s before the reveal deadline `T_reveal` |
| Contract root | `o18ydk9wvnwqlgm32s9ud9yfpe6euqktwqyh7yqx83yyckd7p7e49qazt5uy` |
| Ethereum contract | `HTLCPoseidonV2`, deployed on mainnet before the run; code hash as above = the pin compiled into the tools. Address and deployment kept out of this log (see the note at the top) |
| Hashlock on Ethereum | the NOID claim authority `A` itself (no SHA-256 hashlock) |
| Folder | `~/live-run-8/` in WSL (both swap files, bundle, loop files, `eth-*.json`, `claim-*.out`, `rec/`), which also holds every Ethereum mainnet identifier |

Preparation had no proof step, so `prepare.sh` finished in seconds.

## Log

- 00:58:21 **Funded**: Parano1d txid `290eb0fa8fb4bbf83ad205bcccdf5fb88d4c6d9db9805155a58c173629541ea3`. 00:59 the instance is visible and
  matches the opening: `funded` [284,715]. 01:07:39 funding final [284,732].
- 01:08:53 **Bob's lock dry run** passed: value 0.001 ETH, lock kind `poseidon`, code hash equal to the pin, no other lock with this lock
  word on the contract, fee cap 0.12 gwei against a base fee of 0.045 gwei, balance sufficient. The lock was sent at about 01:16:34 and
  mined at 01:16:47: 144,129 gas at 0.12 gwei, 0.0000173 ETH. Bob's file `locked` at 01:16:57 [284,748], 76 blocks before his
  lock-by (284,824).
- 01:18:18 Alice sees the lock [284,751]. 01:34:03 the lock is final on Ethereum [284,777], about 17 minutes of Ethereum finality
  after it was mined.
- **Reveal (Alice claims the ETH, which publishes the secret).** The first dry run at a cap of 0.12 gwei passed with a ratio of 2.15
  against the tool's minimum of 2 × the base fee. But the base fee over the last 20 blocks ranged from 0.052 to 0.066 gwei, so a send
  at 0.12 would have been refused part of the time (it fails closed). The cap was raised to 0.2 gwei, and the second dry run showed a
  ratio of 3.35. Sent at about 01:36, mined within a minute: 517,084 gas (the fixed gas limit is 1,000,000; the claim is never
  simulated with the secret) at 0.2 gwei, 0.0001034 ETH. Alice's file `revealed` at 01:37:12 [284,782]. The reveal went out about an
  hour before the reveal cutoff (`T_reveal` minus the margin), so about an hour and a half before `T_reveal` itself.
- 01:37:20 Bob read the secret from the chain: `secret_seen` [284,783]. 01:37:43 claim dry run: 11 s including the authorization proof
  (V4), recipient = Bob's address, fee 5,800 μNOID, payout 4,994,200 μNOID.
- 01:38:22 **Claim submitted** at call height 284,786: Parano1d txid `948d97477f3f78181d7d679ceed6569a438d9e2d1fa97b7648ea6e6bb6ae5e92`.
  Included by [284,789] at 01:39:39. 01:48:04 the claim is final [284,806] and Bob's file is **`done`**, 647 blocks before `D`.
- 01:52:33 Alice's ETH claim is final on Ethereum and her file is **`done`** [284,816].

## Result

| leg | outcome |
|---|---|
| NOID (Bob) | claim txid `948d9747…2e92`, call height 284,786, final at tip 284,806; 4,994,200 μNOID to Bob's address (5 NOID − 5,800 μNOID close fee) |
| ETH (Alice) | reveal mined within a minute of sending, final at 01:52:33; she received 0.001 ETH minus 0.0001034 ETH of gas |
| ETH (Bob) | paid 0.001 ETH into the lock plus 0.0000173 ETH of gas for the lock |
| Alice's file | `created` → `funded` (284,715) → `funding_final` (284,732) → `lock_seen` (284,751) → `lock_final` (284,777) → `revealed` (284,782) → `done` (284,816, 01:52:33) |
| Bob's file | `received` → `funded` → `funding_final` → `locked` (284,748) → `secret_seen` (284,783) → `claim_submitted` (284,786) → `claim_included` (284,789) → `done` (284,806, 01:48:04) |
| After the run | both files `done`; the Parano1d contract instance is gone; the Ethereum contract's balance is 0 and the lock reads claimed |
| Wallet balance | Alice's NOID wallet went down by 5.009000 NOID (5 NOID swapped + 9,000 μNOID funding fee); Bob's address holds a new output of 4.994200 NOID |
| Cost of the swap | 0.0148 NOID (9,000 μNOID funding fee + 5,800 μNOID close fee) and 0.0001207 ETH in fees (lock 0.0000173 + reveal 0.0001034); the contract deployment is extra and not counted |
| Time | 54 minutes from funding (00:58:21) to both sides final (01:52:33); run 5 on Sepolia took about 47 |

## What it showed

- The swap works end to end on Ethereum mainnet with the proof-free lock kind: Bob locked on `A` itself, Alice's claim revealed `s`, and
  Bob's engine accepted it only because `Addr(preimage) == A`. No receipt anywhere in the chain of trust, and nothing to prove before the
  lock.
- The `production` profile ran for the first time: `D = h_create + 735`, a reveal window of 7,200 s, a reveal margin of 1,800 s and Bob's
  lock-by at `D − 629`. Bob locked 76 blocks before his lock-by and his claim was final 647 blocks before `D`, so the windows were
  never under pressure on the happy path.
- The mainnet gate of `live.js` worked as designed: `--mainnet`, `--max-fee-gwei` and `--swap FILE` were all required, and every check
  passed before each send (code hash against the pin, no other lock with the same lock word, fee cap against the base fee, balance).
- Fee gates fail closed, and a send below the 2 × base fee rule would have been refused, not sent cheaply.
- A `poseidon` claim costs 517,084 gas on mainnet (about 500,000 on Sepolia in run 5, where the figure is stated as "about"), because
  the Poseidon permutation runs in the EVM. At the 0.2 gwei cap it was 0.0001034 ETH.
- The whole swap cost 0.0148 NOID and 0.0001207 ETH in fees.

## Findings

1. **`live.js` pays the whole fee cap.** Its priority fee is the cap minus the base fee, so a reveal at a 0.2 gwei cap cost about three
   times what the base fee alone required. A separate, small priority-fee setting would fix it. Not done.
2. **The rule "claim cap ≥ 2 × base fee" is tight on mainnet when the cap is set close to the base fee.** The base fee moved by about a
   quarter within minutes (0.052 to 0.066 gwei over 20 blocks). Set the cap at 3 to 4 times the base fee seen at preparation, or the
   send is refused (safely) and time is lost.
3. **The key file names were hard-coded in the helpers** (`keys/bob.key`, `keys/alice.key`). For this run the run folder's copies were
   patched by hand to point at the mainnet keys. After the run the helpers got two settings, `BOB_KEY` and `ALICE_KEY`, with those
   defaults; for mainnet set them in `env.local.sh` to the mainnet key files (`scripts/live/README.md`).
4. **First live use of the `production` profile and of the mainnet gate of `live.js`:** all gates passed as designed (see above).

## What it did not show

- Two nodes per chain (`SINGLE_NODE_OK=1`, one node each), a second machine, and a hostile counterparty (one operator played both
  roles).
- The abort paths on mainnet (Alice never reveals; Bob never locks). They have been seen on Sepolia (runs 4 and 6) and on a local chain
  (run 2) only.
- The stock variant, contract version 2, the rotation case and the conflicting-close case.
- A stuck or replaced Ethereum transaction on mainnet, a reorg, or an eviction.
