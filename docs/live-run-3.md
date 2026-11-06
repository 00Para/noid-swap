# Live run 3 — NOID ↔ ETH with the Ethereum leg on Sepolia (`sepolia` profile)

> Clock times in this log are UTC (converted from the operator's local clock); an entry after 00:00 falls on the calendar day after the one in the title.

Planned and run 2026-11-05 (UTC). Same shape as run 1 (`docs/live-run-1.md`): the happy
path, raw variant, the owner in both roles on one machine (Alice in WSL, Bob's Ethereum commands on
Windows). New in this run: Bob's leg is on the public Sepolia test network instead of a local Hardhat
chain, so Ethereum finality (about 18 minutes), a public RPC and real block times are exercised for the
first time; and the timing numbers come from the new `sepolia` profile of `swap-cli` (README "The
rehearsal and sepolia profiles"). Nothing in this file is sent without the owner's go-ahead in the
session (PROJECT.md). Amounts are tiny.

## Parties and amounts (filled in as the run proceeds)

| item | value |
|---|---|
| Alice (NOID holder, makes the secret) | wallet index 0 `o1zjj6zqc7…utpurk` (recovery address too) |
| Bob (NOID recipient) | wallet index 1 `o1xpyc7ar2…8w8q9r` |
| Bob (Sepolia sender, deployer) | `0x6f8560EC1185f50104f5B64Df21e858dBd592883` (`eth/keys/bob.key`, throwaway; 0.0525 ETH from the faucet) |
| Alice (Sepolia receiver) | `0x49877DaCE5b72f4E8768FbF5Cb7eE1573c9fF9eA` (`eth/keys/alice.key`, throwaway; 0 ETH until Bob sends gas) |
| Ethereum chain | **Sepolia, chain id 11155111**, `https://ethereum-sepolia-rpc.publicnode.com` (no key). `swap-cli tick` reaches it with `--transport curl`; `live.js` with `ETH_RPC_URL` |
| HTLC contract | **`0x489228d5b89EC1B2e441fc5FFF5517Cb79C6Ec48`** on Sepolia, deployed by Bob 01:32 in block 12,066,295 (tx `0x1ae6ebd3…c60c`), `codeHash` **`0xa906117fc4e604bd25fcee2a6a41da8b824ec9b4a17d10137704e7da42545e2f`** = keccak256 of the artifact's `deployedBytecode` (2,633 bytes), `matchesArtifact: true`; the same address and hash as run 1's local deployment (Bob's nonce was 0 on both chains) |
| Amounts | 10 NOID (10,000,000 μNOID) ↔ 0.001 ETH (1,000,000,000,000,000 wei) |
| Profile / contract version / variant | `sepolia` / 1 (`HashTimeLock`) / raw. One new variable per run: the chain. v2 (fixed fee) and the stock variant are later runs |
| Timing (sepolia profile) | `D = h_create + 300` (2 h 30 at 30 s/block); Bob's lock-by `D − 251` (minimum window `D − 209`); `W_A` 4,200 s, `W_A_min` 3,360 s; Alice's reveal cutoff `T_reveal − 1,800 s` (= `live.js claim`'s default `--margin-s`); Ethereum finality budget 1,140 s; `B_post` 33; caps 20 NOID / 0.01 ETH / chain 11155111 only |

Sepolia as measured on 2026-11-05 01:15 (read-only, before anything was sent): tip 12,066,232, `finalized`
91 blocks behind (≈ 18 min at 12 s), base fee 15 wei, median tip ≈ 1 gwei, block gas limit 200,000,000.
`deploy --dry-run` estimates 4,425,547 gas and `send --dry-run` 207,391 gas: this RPC's `eth_estimateGas`
is inflated about 10× (a plain transfer uses 21,000), so expect ≈ 450,000 gas for the deploy, i.e. about
0.0005 ETH at 1 gwei. Bob's 0.0525 ETH covers the deploy, 0.005 ETH of gas for Alice, the 0.001 ETH lock
and every fee many times over.

## Steps and checkpoints

Every WSL command runs with `BIN=$HOME/noid-target/release/swap-cli` (rebuilt from the commit
that adds the `sepolia` profile), the Windows tool is `C:\Parano1d\bin\parano1d-cli.exe`, Ethereum
commands run from `eth/` on Windows with `ETH_RPC_URL=https://ethereum-sepolia-rpc.publicnode.com`.
`tick` always uses `--transport curl --noid-rpc http://127.0.0.1:9601 --eth-rpc <the Sepolia RPC>
--eth-from-block <the contract's deployment block>` (public RPCs cap `eth_getLogs` at 50,000 blocks;
never scan from 0). Helper: `~/live3-tick.sh alice|bob [--apply]`, a copy of run 2's with
`L=$HOME/live-run-3` and the Sepolia RPC.

0. **Prerequisites.** `swap-cli` tests green with the `sepolia` profile and the release binary rebuilt ☐.
   Wallet node synced; `balance` of index 0 ≥ 11 NOID ☐. `~/live-run-3/` with a fresh `passphrase.txt` ☐.
   Chain id 11155111 confirmed by `live.js balance` ☐ (done read-only 01:15 ✅).
1. **Bob deploys the HTLC on Sepolia** (`live.js deploy --key-file keys/bob.key --dry-run` ✅ 01:18, then for
   real): note `contract`, `codeHash` (must be the expected hash above), `matchesArtifact: true`,
   `blockNumber`. Then `live.js send --key-file keys/bob.key --to <Alice> --amount-wei 5000000000000000`
   (dry run ✅). *Go-ahead needed: the first two Sepolia transactions.*
2. **Alice creates the swap file**: `new-alice --profile sepolia` with `--eth-chain-id 11155111`,
   `--eth-contract <contract>`, `--eth-code-hash <codeHash>` and `--h-create` = the tip expected when the
   equivalence proof finishes (about 2 blocks per minute of proof; run 1 lesson). Print the bundle.
3. **Equivalence proof** (20–36 min on this machine): `equiv-prove prove raw … alice.receipt`, then
   `new-bob --profile sepolia --receipt … --equiv-prove …` with Bob's own terms and the pinned image id. No
   process listing with arguments while the proof runs.
4. **Alice builds and checks the contract**: `alice-params --definition-out`, `parano1d-cli contract
   create`, `alice-params --check-object` → "object file OK" with the bundle's root. **GO / NO-GO** on:
   object OK, `h_create` within a few blocks of the tip, `D = h_create + 300` (no rotation concern: the
   profile accepts the rotation risk), Bob's file exists, wallet active address = Alice's. Then
   `parano1d-cli contract fund swap.object.json 10.000000`. *Go-ahead needed: real NOID leaves the wallet.*
5. **Loop `tick` for both files** every ~30 s. Alice's shows the instance, then finality (18 blocks ≈ 9 min).
   Bob's says `lock_eth` with `t_reveal`: `live.js lock` with exactly those values (`--chain-id 11155111
   --code-hash <codeHash> --from-block <deploy block>`); note `lockId`, `blockNumber`, `blockTimestamp`.
   *Go-ahead needed: the Sepolia lock.*
6. Alice's `tick` says `reveal_eth` once Bob's lock is at or below Sepolia's `finalized` block (≈ 18 min
   after inclusion) and (I2) holds: `swap-cli secret alice.swap.json | node scripts/live.js claim
   --key-file keys/alice.key … --secret-stdin` (dry run first). The reveal must be before
   `T_reveal − 1,800 s`; with `W_A` 4,200 s that leaves about 40 minutes after Bob's lock for finality plus
   the claim. *Go-ahead needed: the reveal.*
7. Bob's `tick` records the secret from the `Claimed` event and says `claim_noid`: `swap-cli claim
   bob.swap.json …` (dry run proves and prints txid / call height / recipient), then `--submit`. `tick` until
   the claim is final (18 blocks). *Go-ahead needed: the NOID close.*
8. **Verify**: `parano1d-cli contract instances` shows no live instance; Bob's NOID address received
   10 NOID − fee; Alice's Sepolia address holds 0.001 ETH (minus nothing: the claim gas comes from Bob's
   0.005 ETH); receipts exported. Record timings below, keep the `--record-*` fixtures (first recordings
   of a public Ethereum chain), update `TASKS.md` M2.7 and design §9.3.

Expected wall clock after funding: ≈ 9 min (funding final) + 1 min (lock) + 18 min (finality) + 2 min
(reveal included) + 1 min (Bob's proof and submission) + 9 min (claim final) ≈ 40 minutes, inside the
first hour of a 2 h 30 window.

Abort paths (not planned for this run): Bob never locks → Alice does nothing until `D`, then the
recovery close (chain `--preview` and `--expected-txid` in one command, run 2 lesson). Alice never
reveals → Bob refunds at `T_reveal` (`live.js refund`); the NOID returns to Alice at `D`.

## Log

- 01:32 Owner's go-ahead for the two Sepolia prep transactions.
- 01:32:00 **HTLC deployed on Sepolia**: `live.js deploy --key-file keys/bob.key` → contract `0x489228d5b89EC1B2e441fc5FFF5517Cb79C6Ec48`,
  block 12,066,295, tx `0x1ae6ebd3d968ea3d04105a0918d32a1f6831ca6c2f72c7c899881ca8db35c60c`, `codeHash` = the expected
  `0xa906117f…545e2f`, `matchesArtifact: true`. Receipt: status 1, gasUsed 4,389,542 (so the RPC's 4.43 M estimate was not
  inflated for the deploy; the plain transfer's 207 k estimate was), effective gas price 1,018 wei, cost 4.5 nano-ETH.
- 01:32:48 **Gas for Alice**: `live.js send` 0.005 ETH Bob → Alice, tx `0xb2fa63acd80398a9bbb2f853c21d2463f57dad4d792b69521298cce33068f2e1`,
  block 12,066,299. Balances: Bob 0.0475 ETH, Alice 0.005 ETH. Wallet node answers; index-0 balance 2,048.926590 NOID.
- 01:35 WSL `~/live-run-3/` created (fresh passphrase, `eth-deploy-block.txt` = 12066295, `bob/`, `rec/`); helper `~/live3-tick.sh`.
- 01:36:19 **Alice's file** (`new-alice --profile sepolia`, tip 281,950, fee estimate 5,800 from `paranoid_estimateFee`):
  planned `h_create` 282,000, **D 282,300**, Bob's lock-by 282,049 (full window) / 282,091 (minimum), `max_fee` 50,000 μNOID,
  hashlock `0x35d63194d2059d1a26a2f7893deec54e006d21c416f2370c00b0312a1d25fd37`, claim authority
  `o1qwtc8y9epyznfcv9fqnr937m68rt96r6w6m5028k0u7wfvem0fuqmafpf4`, contract root `o10tc9l6d7a5dffsadlpddxuwsds5wlr8rqdhck99xl8668zws87wqzej993`,
  chain 11155111, code hash pinned. Bundle copied to `C:/Users/00/Documents/live-run-3/alice.bundle.json`.
- 01:36:19 **Equivalence proof started** (`swap-cli secret | equiv-prove prove raw --secret-stdin`, segment po2 18).
- 01:45 Owner asks for the contract root and the files at every run (bundle sent 01:47; the object file follows the create step).
- 01:45 Owner's go-ahead for the funding, conditional on the GO/NO-GO checks.
- 02:01:29 **Proof done**: 1,510 s wall (25 min), 2,754,050 user cycles, 13 segments, receipt 223,356 bytes; `equiv-prove verify`
  OK, image id `7e9d8477…6187` = the pin. **Bob's file** (`new-bob --profile sepolia --receipt … --equiv-prove …`): "bundle checked:
  opening rebuilt byte-for-byte, tool guard and (I5) pass, your terms match", "receipt was verified by this tool"; phase `received`,
  D 282,300, lock-by 282,049. Definition + pruv params written; tip 281,995 at the end (planned `h_create` 282,000: on time).
- 02:02 `parano1d-cli contract create swap.def.json --out swap.object.json` → `Contract: o10tc9l6d7a5dffsadlpddxuwsds5wlr8rqdhck99xl8668zws87wqzej993`
  (= the bundle's root); object file sent to the owner.
- 02:02 **GO**: `alice-params --check-object` → "object file OK: its opening is byte-for-byte the swap file's; fund exactly this
  address: o10tc9l6…j993"; wallet active address = index 0 (Alice); Bob's file phase `received`; tip 281,995; balance 2,048.93 NOID.
- 02:03:20 **Funded**: `parano1d-cli contract fund swap.object.json 10.000000` → "Funding submitted:
  3963ed8e3511bfcc4d8ab3b31d5a341566378216fb4b8148ed579009972b17fc". Tick loops started for both roles (`~/live3-watch.sh`,
  every 30 s with `--apply`, logs `~/live-run-3/loop-{alice,bob}.txt`).
- 02:05 **Instance visible** at tip 282,002: slot 9,704,558, creation id 744,169, 10,000,000 μNOID, `instance_matches_opening: true`
  (Bob's engine: phase `funded`, "waiting for funding finality"). Alice's tick of 02:05:09 exited 1: "eth watcher: transport: curl.exe did not finish within 35 s; killed", a
  transient timeout of the public RPC (first one in ~40 Sepolia calls today); the loop continued and the helper now passes
  `--rpc-timeout 60`. Operator slip at 21:06: while adding that flag, a failed edit left `~/live3-tick.sh` empty for ~90 s
  (the loops ran empty ticks 02:06–02:07); restored from a fresh copy with an atomic `mv`. Lesson: never edit a helper in place
  while a loop calls it; write the new file beside it and `mv`.
- 02:13 **Funding final** at tip 282,020 (creation id 744,169, i.e. included at ≈ 282,001; 18 blocks ≈ 10 min). Alice: phase
  `funding_final`, "waiting for Bob's lock". **Bob's engine: `lock_eth`** at 21:14:11: 1,000,000,000,000,000 wei, hashlock
  `0x35d6…fd37`, receiver `0x4987…f9ea`, **`t_reveal` 1793849040** (4,200 s = `W_A` after the tick's block time
  02:14:00; Alice's reveal cutoff 02:54:00). Sepolia `finalized` 12,066,417 vs latest 12,066,504 (87 blocks ≈ 17 min).
- 02:15 Lock dry run OK (gas estimate 600,127, no foreign lock). Owner: "Lock now" (02:16), then "do all, non stop, I am busy":
  the reveal and the NOID close are authorized without further questions.
- 02:17:00 **Bob's lock on Sepolia**: lock id `0x8a520c700e8b289a276d446fb6f7b6a891fe76244aa81bb887fb85ae4f25b143`, tx
  `0x3ad6622412d16f415b5a8171fc0a6e43628d7d85caa1d8c7f72f761d026c5b91`, block 12,066,519 (timestamp 1793845020), 0.001 ETH,
  timelock 1793849040. Parano1d tip ≈ 282,026 (lock-by was 282,049). Expected final ≈ 02:35; Alice's cutoff 02:54.
- 02:17–02:19 Claim and reveal commands staged and dry-run (`~/reveal3.sh`: secret piped from WSL `swap-cli secret` into Windows
  `node live.js claim --secret-stdin` through WSL interop, `WSLENV` carrying `ETH_RPC_URL`; `~/claim3.sh`: Bob's client R).
- 02:35:51 **Lock final on Sepolia**: `finalized` 12,066,545 ≥ lock block 12,066,519 (18.5 min after the lock). Alice's engine:
  phase `lock_final`, **`reveal_eth`** for lock id `0x8a52…b143`; Bob: "waiting for the secret (or T_reveal)". Parano1d tip 282,060.
- 02:37:08 **Alice revealed** (`~/reveal3.sh`: `swap-cli secret | node live.js claim --secret-stdin`, exit 0): claim tx
  `0x2f7b865c14754f62184058973ccda5b6b221bf4830a5c134284cc83e07ecb455`, Sepolia block 12,066,615, 17 min before the 02:54 cutoff.
  The secret is now public in the `Claimed` event.
- 02:37:54 **Bob's claim, dry run** (`~/claim3.sh`, 9 s incl. the RPC reads): engine `claim_noid` from the `Claimed` log; plan: call
  height 282,070, fee 5,800 μNOID, 9,994,200 μNOID to `o1xpyc7ar2…8w8q9r`, authorization V4, `OnTarget`, self-verified, intent
  90,129 bytes, txid `cb1591f9…ee4e` (for that height). Alice's Sepolia balance 0.006 ETH (0.005 gas + 0.001 claimed − gas).
- 02:38:32 **Bob's claim submitted** (`~/claim3.sh --submit`, 10 s): re-proved for call height 282,070, intent 90,065 bytes, accepted by
  `http://127.0.0.1:9601`, txid `9efbf8a6aac1a75137478e63af66e4472e34a106d23bb392eb2b1b474a58bef6`, phase `claim_submitted`
  (`pending_intent` recorded in Bob's file). 21.5 min from Alice's reveal signal to Bob's submission, 1.4 min of it after the reveal was mined.
- 02:39 Bob's engine: "NOID claim pending" (1 pending call, tracked). **Included at height 282,072** (block `b2b50e60…a355`, position 1), i.e.
  2 blocks after the call height 282,070 was proved for.
- 02:47:16 **Bob's engine: `done: NOID received`** at tip 282,089 (claim final: 282,072 + 17); Alice's engine sees the instance gone.
  Loops stopped. Verification at tip 282,091: `contract instances` → none; Bob's address has a new UTXO slot 615,766, creation id
  744,461, **9.994200 NOID**; Alice's index-0 balance 2,038.917590 NOID = 2,048.926590 − 10 − 0.009000 (funding fee 9,000 μNOID,
  as in run 2); Alice's Sepolia balance 0.006 ETH (= 0.005 gas from Bob + 0.001 claimed − claim gas), Bob 0.0465 ETH. `parano1d-cli tx`
  no longer finds the funding transaction (block bodies are pruned after 42 blocks; it was included ≈ 282,001, 90 blocks earlier).
- 02:52 **Receipt**: `parano1d-cli contract receipt --out claim-3.receipt swap.object.json 9efbf8a6…bef6` → 897,013 bytes; `contract verify`
  → "Verified on selected chain at height 282072". (The wallet-level `parano1d-cli receipt <hash>` says "no receipt": it only covers the
  wallet's own transactions; the contract-side export works because this node created the opening and retains the receipts of its calls.)
  Swap files: Bob `done`, Alice `revealed` (her engine marks `done` once Sepolia finalizes her claim block 12,066,615; ticking until then).
  Loop statistics: 61 ticks per role in 44 min, 1 failed tick (Alice, the 35 s RPC timeout), 242 node answers recorded (7.5 MB).
- 02:55:22 **Alice's engine: `done: ETH received`** (Sepolia `finalized` 12,066,635 ≥ her claim block 12,066,615; 18 min 14 s after the
  claim was mined). Both swap files `done`; run 3 closed.

## Result

**Settled.** The first swap with a public Ethereum network: 10 NOID on Parano1d mainnet against 0.001 ETH on Sepolia, raw variant,
`sepolia` profile, the owner in both roles. Bob received 9,994,200 μNOID (10 NOID − 5,800 fee) at `o1xpyc7ar2…8w8q9r`
(slot 615,766, creation id 744,461, claim included at 282,072, final at 282,089); Alice received 0.001 ETH at
`0x4987…F9EA` (claim tx `0x2f7b865c…b455`, Sepolia block 12,066,615). Alice paid the 9,000 μNOID funding fee; Bob paid
the Sepolia gas (deploy 4.39 M gas, lock ≈ 600 k, both at ≈ 1 gwei) and 0.005 ETH of gas money to Alice.

| step | clock | chain time |
|---|---|---|
| HTLC deployed on Sepolia, gas to Alice | 01:32:00 / 01:32:48 | blocks 12,066,295 / 12,066,299 |
| Alice's file (`h_create` 282,000, D 282,300) | 01:36:19 | tip 281,950 |
| Equivalence proof (raw, local, segment po2 18) | 01:36 → 02:01 | 1,510 s wall; 2,754,050 user cycles; receipt 223 KB |
| Bob's file (receipt verified, opening rebuilt) | 02:01:29 | — |
| Object built + checked, GO | 02:02 | tip 281,995 |
| Funding submitted → instance visible → final | 02:03:20 → 02:05 → 02:13 | ≈ 282,001 → 282,002 → 282,020 (18 blocks ≈ 10 min) |
| Bob's `lock_eth` → lock mined | 02:14:11 → 02:17:00 | lock block 12,066,519; `t_reveal` 03:24:00 (full `W_A`) |
| Lock final on Sepolia → `reveal_eth` | 02:35:51 | finalized 12,066,545 (18.9 min after the lock) |
| Alice's claim mined (reveal) | 02:37:08 | block 12,066,615; 17 min before the cutoff |
| Bob: dry run → submit | 02:37:54 → 02:38:32 | proved for call height 282,070, included 282,072 |
| Bob's claim final | 02:47:16 | tip 282,089 |
| Alice's claim final on Sepolia (her engine `done`) | 02:55:22 | finalized 12,066,635 ≥ 12,066,615 (18 min 14 s after the claim) |

Chain-bound time from funding to Bob's NOID being final: **44 minutes** (02:03 → 02:47), of which Sepolia finality ≈ 19 min,
Parano1d finality 2 × 9–10 min, everything else a few minutes. The whole run, from the go-ahead to Bob's final NOID, took
1 h 15 including the 25-minute proof. The 2 h 30 deadline was never close: at Bob's claim the window still had 228 blocks.

What this run shows that runs 1 and 2 did not: real Ethereum finality (the engine's `finalized`-tag gate and `live.js`'s
refusal before finality both triggered as designed), a public RPC (one 35 s timeout in ~130 calls, no other error), the
`sepolia` profile's numbers end to end, and the secret path from the sealed file into the Ethereum claim across the
WSL/Windows boundary (`--secret-stdin` over a pipe, never on argv). Not covered: the stock variant, the abort paths on
Sepolia, epoch rotation (none fell inside the 70 blocks between funding and the claim), the second node (F5).

