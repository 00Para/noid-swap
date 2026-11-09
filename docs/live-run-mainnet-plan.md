# Plan: the first swap with the Ethereum leg on public mainnet (`production` profile)

> Renamed 2026-11-05 (it was `docs/live-run-4.md`): the number "run 4" went to the Sepolia abort run that happened first (the new `docs/live-run-4.md`). This plan has no run number yet; the run folder `~/live-run-4/` is taken, so use the next free `~/live-run-N/`.

> Clock times in this document are UTC. Before the run they are offsets (`T0` = the moment of the go-ahead, `F` = the moment the NOID funding is submitted); the log gets real UTC times when the run happens.

> **Executed 2026-11-06 as run 8** (`docs/live-run-8.md`); see "What differed from the plan" at the end.

Prepared 2026-11-05 (UTC). This is the plan only; nothing in it had been sent when it was written. Same shape as run 3
(`docs/live-run-3.md`): the happy path, raw variant, contract v1 (`HashTimeLock`), the owner in both roles on one
machine. **One new variable: the chain.** Bob's leg moves from Sepolia (chain id 11155111) to Ethereum mainnet
(chain id 1), so the ETH is real, the gas price is real, and the Ethereum network is the one the product will
actually use. The `production` profile comes with the chain (its timing numbers are the design's §9.1 numbers, it
has no amount cap, and it demands a second independent node); the stock variant, contract v2 and the abort
paths stay later runs. Nothing is sent without the owner's go-ahead in the session (`PROJECT.md`): every spend
below is marked, and a go-ahead given for an earlier run or an earlier day does not carry over. The amounts are
the smallest ones that still exercise everything: **10 NOID against 0.001 ETH**.

Words, once: the *hashlock* `H` is the SHA-256 fingerprint of a secret `s` that only Alice knows. The *reveal* is
the moment Alice publishes `s` on Ethereum to take her ETH; from then on anyone can read it, which is how Bob gets
the NOID. *Finality* is the point after which a block can no longer be undone. A *timeout* is the moment a locked
amount can go back to the side that locked it, so nobody is stuck if the other side disappears.

## Parties and amounts (to fill in when the run starts)

| item | value |
|---|---|
| Alice (NOID holder, makes the secret) | wallet index 0 (recovery address too) — `o1…` to record |
| Bob (NOID recipient) | wallet index 1 — `o1…` to record |
| Bob (mainnet sender, deployer) | a **new** throwaway key made for this run (`keygen --out keys/bob-mainnet.key`; never reuse a testnet key on mainnet), address to record |
| Alice (mainnet receiver) | a **new** throwaway key (`keys/alice-mainnet.key`), address to record |
| Ethereum chain | **mainnet, chain id 1**; `ETH_RPC_URL` = a keyless public HTTPS endpoint for `live.js`, and a second endpoint from another operator for `swap-cli tick` (production demands two independent Ethereum nodes for Bob's lock and Alice's reveal). Both must report chain id 1 |
| HTLC contract | to be deployed by Bob; must report `matchesArtifact: true` and `codeHash` `0xa906117fc4e604bd25fcee2a6a41da8b824ec9b4a17d10137704e7da42545e2f` (the hash of this repo's `deployedBytecode`, the same as runs 1 and 3; `swap-cli` has it compiled in) |
| Amounts | 10 NOID (10,000,000 μNOID) ↔ 0.001 ETH (`1000000000000000` wei). **The first mainnet swap is 0.001 ETH, nothing larger.** The `production` profile has no cap (`max_noid_micro`, `max_eth_wei` and the chain list are unset), so the limit is the operator's rule, not a gate: both amounts are typed by hand and checked in the dry runs |
| Profile / contract version / variant | `production` (no `--profile` flag; the field is absent from the swap file) / 1 / raw |
| Timing (production) | `D = h_create + 735` (about 6 h 08 min at the planning pace of 30 s per block); Bob's lock-by `D − 629` (full window) or `D − 539` (minimum window); `W_A` 7,200 s, `W_A_min` 5,400 s; Alice's reveal cutoff `T_reveal − 1,800 s`; Ethereum finality budget 1,140 s; `B_post` 252 (`B_epoch` 144 + `B_fee` 60 + `B_final` 18 + `B_safety` 30); `B_fund` 10, `B_bob` 60 |
| Fee settings | NOID `max_fee` 50,000 μNOID (at least 5,800); Ethereum `--max-fee-gwei` chosen on the day (see the gas budget) |

## What is new compared with run 3, and what stays

| | run 3 | this plan |
|---|---|---|
| Ethereum chain | Sepolia (testnet ETH) | **mainnet (real ETH)** |
| `live.js` flags | `--chain-id 11155111` | `--mainnet --max-fee-gwei N --chain-id 1`, and `--swap FILE` (the file must say chain 1 and `production`) |
| Profile | `sepolia` (`D = h_create + 300`, `W_A` 4,200 s, capped) | `production` (`D = h_create + 735`, `W_A` 7,200 s, no caps, two nodes required) |
| HTLC contract | deployed on Sepolia | **a new deployment on mainnet** (the dominant gas cost, once per network) |
| Everything else | raw variant, contract v1, happy path, one machine, equivalence proof, wallet node | the same |

## Mainnet gas budget

**Assumption to check on the day, not a measurement:** a typical total price (base fee plus tip) of 1–5 gwei. Check
it just before starting, with `eth_gasPrice` and `eth_feeHistory` on both endpoints, and write the reading in the
log. Gas amounts are from the earlier runs: deploy 4,389,542 gas used (run 3 receipt; `deploy --dry-run` estimated
4,425,547), plain send 21,000, refund about 67,000 (run 2 estimate), lock about 150,000 (run 1 estimate on a local
chain; the public Sepolia endpoint estimated 600,127 in run 3, which is the figure the balance check will read from
the dry run), claim about 100,000 (an assumption: the claim has not been measured separately).

| step | gas | ETH at 1 gwei | ETH at 5 gwei |
|---|---|---|---|
| deploy the HTLC (Bob, once) | 4.39 M | 0.0044 | 0.0220 |
| gas money to Alice (send) | 21 k | 0.00002 | 0.0001 |
| Bob's lock | 150 k (up to 600 k estimated) | 0.00015 (0.0006) | 0.00075 (0.003) |
| Alice's claim (the reveal) | 100 k | 0.0001 | 0.0005 |
| **happy path, gas only** | about 4.7 M | **about 0.005** | **about 0.023** |
| refund, abort path only (Bob) | 67 k | 0.00007 | 0.00034 |

On top of the gas: 0.001 ETH leaves Bob into the lock and arrives at Alice, and Bob sends Alice about 0.002 ETH of
gas money (her claim costs 0.0001–0.0005 ETH; the rest stays hers). `--max-fee-gwei` is a ceiling, not a price: the
network charges the base fee plus a tip of at most 1 gwei, never more than the cap. But the **balance check uses the
cap**: the dry run refuses unless the sender holds amount + gas estimate × cap. A deploy dry run with a 10 gwei cap
needs 0.044 ETH in Bob's wallet (4.43 M × 10 gwei); with a 5 gwei cap, 0.022 ETH. Plan: choose each cap as about
twice the day's reading, round up, and fund Bob's mainnet wallet with about 0.05 ETH (0.03 if the day's reading allows
a 5 gwei cap); the real spend stays near the table above, the rest remains in his wallet. Time-critical steps (Alice's
reveal, Bob's refund) get a generous cap, at least three times the day's base fee: `live.js` has no replace or cancel
for a stuck transaction, and a transaction priced below the base fee waits in the pool.

## GO / NO-GO checks

All of these are read-only or dry runs. Any NO-GO stops the run; nothing is "fixed on the fly" after funding.

1. **Code and tests.** `cd eth && npx hardhat test test/live.test.js` green; `cd swap-cli && cargo test --offline` green;
   the release `swap-cli` rebuilt from the commit being used. The `--mainnet` refusals are covered by tests, but
   confirm once by hand: `node scripts/live.js send --to <addr> --amount-wei 1 --dry-run` (no `--mainnet`) must
   refuse with "Ethereum mainnet (chainId 1) without --mainnet".
2. **Chain.** `node scripts/live.js balance <Bob's address>` on each endpoint prints `"chainId": "1"`; the two endpoints'
   latest blocks differ by no more than a few blocks, and both answer the `finalized` tag.
3. **Gas.** The day's reading is within the assumption (total price at most 5 gwei). **NO-GO above 10 gwei**: wait; the
   run is not time-pressured until the funding is submitted.
4. **Balances.** Bob's mainnet wallet holds enough for the deploy dry run at the chosen cap; Alice's NOID wallet holds at
   least 10.01 NOID (10 + the 0.009 funding fee) and her *active address is index 0*; the wallet node answers.
5. **Fresh keys.** The two mainnet key files were made for this run, are in `eth/keys/` (git-ignored), and are backed
   up. Their addresses are written in the table above and read back from the files, not from memory.
6. **Deploy dry run.** `deploy --mainnet --max-fee-gwei N --dry-run` prints `chainId` `1`, the worst-case cost,
   `senderBalanceEth`, the expected contract address, and does not refuse.
7. **Deployment check (after the deploy).** `matchesArtifact: true`, `codeHash` equal to the value in the table,
   `status`/`balance` on a second endpoint shows the same code at the same address.
8. **Swap files.** Alice's `new-alice` (no `--profile`; `--eth-chain-id 1`, `--eth-contract`, `--eth-code-hash`,
   `--eth-amount-wei 1000000000000000`, `--eth-receiver`, `--eth-sender`, `--amount 10000000`, `--h-create` = the tip expected when the equivalence proof
   finishes) and Bob's `new-bob` (his own typed terms, the receipt, the pinned image id) both succeed: "bundle checked:
   opening rebuilt byte-for-byte … your terms match", "receipt was verified by this tool". `swap-cli gates --d … --h-now …
   --t-now …` (production) passes. The swap files carry no `profile` field and `eth.chain_id` 1; `live.js --mainnet --swap`
   refuses any other file by itself.
9. **Object and window.** `alice-params --check-object` says "object file OK" with the bundle's contract root; `h_create`
   within a few blocks of the tip; `D = h_create + 735`; the tip is at least 279,388 (the trial start; long past) and
   `check_i5` passes; Bob's file exists and is in phase `received`.
10. **Second nodes.** `tick` is given `--eth-rpc` twice with two different operators. For the NOID side there is only the
    wallet's own node, so `--single-node-ok` is needed; this is an explicit choice to record in the log (the production
    profile otherwise blocks Bob's lock and Alice's reveal on a single node).
11. **Dry runs staged.** For the lock, the reveal and the refund, the exact `live.js` command lines are written down with
    `--dry-run` and have been run once against the real chain where they can be (deploy, send, and the lock's dry run
    once the NOID funding is final).

## Where a go-ahead is needed

Every item moves real value or publishes something; each needs the owner's explicit yes in the session (one yes that
names the whole run and mainnet counts, as in run 3, but it must be said for this run):

1. Funding Bob's mainnet wallet with ETH (the owner's own action, outside these tools).
2. **The HTLC deployment on mainnet** (the first mainnet transaction, about 0.005–0.022 ETH of gas) and the gas money to Alice.
3. **Funding the NOID contract**: `parano1d-cli contract fund swap.object.json 10.000000` (real NOID leaves the wallet).
4. **Bob's lock of 0.001 ETH** (`live.js lock --mainnet …`).
5. **Alice's reveal** (`live.js claim --mainnet … --secret-stdin`): it publishes the secret.
6. **Bob's NOID close** (`swap-cli claim --submit`).
7. In an abort: Bob's refund (`live.js refund --mainnet …`) and Alice's recovery close.

## Steps and checkpoints

Same layout as run 3: WSL commands use `BIN=$HOME/noid-target/release/swap-cli` and a run folder `~/live-run-N/` with a fresh
`passphrase.txt`; the Windows tool is `parano1d-cli.exe`; Ethereum commands run from `eth/` on Windows with
`ETH_RPC_URL=<the first mainnet endpoint>`. `tick` always uses `--transport curl`, `--noid-rpc http://127.0.0.1:9601`
(plus `--single-node-ok`), `--eth-rpc <first> --eth-rpc <second>` and `--eth-from-block <the contract's deployment block>`
(public endpoints cap `eth_getLogs` at about 50,000 blocks; never scan from 0). The tick helper is a copy of run 3's with the
new folder and endpoints, written beside the old one and moved into place (run 3 lesson: never edit a helper a loop is calling).

0. **Prerequisites** (checks 1–5 above) ☐.
1. **Bob deploys the HTLC on mainnet** (`live.js deploy --mainnet --max-fee-gwei N --key-file keys/bob-mainnet.key
   --dry-run`, then for real): note `contract`, `codeHash` (must equal the table), `matchesArtifact: true`, `blockNumber`,
   the gas used and the price paid. Then `live.js send --mainnet --max-fee-gwei N --key-file keys/bob-mainnet.key --to <Alice>
   --amount-wei 2000000000000000` (dry run first). *Go-ahead needed: the first two mainnet transactions.*
2. **Alice creates the swap file**: `new-alice` with the mainnet terms (check 8) and `--h-create` = the tip expected when the
   proof finishes (about 2 blocks per minute of proof; run 1 lesson). Print the bundle.
3. **Equivalence proof** (about 25 min on this machine, run 3): `equiv-prove prove raw … alice.receipt`, then `new-bob` with
   Bob's own terms and the pinned image id. No process listing with arguments while the proof runs.
4. **Alice builds and checks the contract**: `alice-params --definition-out`, `parano1d-cli contract create`,
   `alice-params --check-object`. **GO / NO-GO** on checks 8–10 again with the tip in hand, then
   `parano1d-cli contract fund swap.object.json 10.000000` at `F`. *Go-ahead needed: real NOID leaves the wallet.* Send the owner the contract root
   (`o1…`) and the mainnet contract's explorer link, so the swap can be watched from the wallet app.
5. **Loop `tick` for both files** every 30 s with `--apply`. Alice's file shows the instance, then funding finality. Bob's says
   `lock_eth` with `t_reveal` (`min(now + 7,200 s, T_max)`): run `live.js lock --mainnet --max-fee-gwei N --swap bob.swap.json
   --chain-id 1 --from-block <deploy block>` (dry run first, with exactly the intent's values; the dry run prints the
   worst-case cost, the balance and `foreignLocksSameHashlock`). Note `lockId`, `blockNumber`, `blockTimestamp`.
   *Go-ahead needed: the mainnet lock.*
6. Alice's `tick` says `reveal_eth` once Bob's lock is at or below the mainnet `finalized` block and (I2) holds: `swap-cli
   secret alice.swap.json | node scripts/live.js claim --mainnet --max-fee-gwei N --key-file keys/alice-mainnet.key --swap
   alice.swap.json --chain-id 1 --secret-stdin` (dry run first). The reveal must be before `T_reveal − 1,800 s`, i.e. within
   90 minutes of Bob's lock, of which about 13–19 minutes are Ethereum finality. *Go-ahead needed: the reveal.*
7. Bob's `tick` records the secret from the `Claimed` event and says `claim_noid`: `swap-cli claim bob.swap.json …` (dry run proves
   and prints txid / call height / recipient), then `--submit`. `tick` until the claim is final (18 blocks). Bob's claim must be
   final before `D` (target `D − 18`). *Go-ahead needed: the NOID close.*
8. **Verify**: `parano1d-cli contract instances` shows no live instance; Bob's NOID address received 10 NOID − fee (5,800 μNOID under
   v1 if the close pays the floor); Alice's mainnet address holds 0.001 ETH plus what is left of the gas money; Bob's balance equals
   his start minus 0.001, 0.002 and the gas; receipts exported (`contract receipt` and `contract verify`). Record the day's gas prices,
   the real gas used per step, the timings, and update `TASKS.md` M2.7 and design §9.3. Keep the key files.

## Expected timings (production gates, `swap-cli/src/params.rs`)

Offsets from `F`, at the planning pace of 30 s per Parano1d block (20 s is the fast pace the gates are sized for) and 12 s per
Ethereum block. The gates are budgets, the "typical" column is what runs 1–3 showed.

| step | typical | gate / budget |
|---|---|---|
| funding included | `F` + 1–2 min | within `B_fund` = 10 blocks (5 min) |
| funding final | `F` + 10 min | inclusion + 18 blocks |
| Bob's lock mined | `F` + 12–15 min | within `B_bob` = 60 blocks (30 min) after funding final, and by `D − 629` (= `h_create` + 106, about 53 min after `h_create`; minimum window `D − 539`, about 98 min) |
| lock final on Ethereum | lock + 13 min (two epochs) | budget 1,140 s (19 min); run 3 on Sepolia: 18.9 min |
| Alice's reveal mined | lock + 14–20 min | cutoff `T_reveal − 1,800 s` = lock + 90 min; `T_reveal` = lock + 7,200 s |
| Bob's claim: detect, prove, submit | reveal + 1–3 min | `Δ_detect` 300 s, `P_auth` budget 20 s (measured p50 1.5 s, worst p99 6.0 s) |
| Bob's claim final | submission + 10 min | 18 blocks; must be before `D` (target `D − 18`) |
| Alice's claim final on Ethereum (her file `done`) | reveal + 13 min | about the same finality as the lock |

Expected wall clock from `F` to Bob's NOID being final: **about 45–60 minutes** (run 3: 44 minutes with the Sepolia numbers),
roughly 20 of them waiting for Ethereum finality; Alice's file reaches `done` about 13 minutes later. The deadline `D` is about
6 h after `h_create`, so the happy path ends in the first sixth of the window. Add the proof (about 25 min) and the dry runs before `F`.

## Abort paths (not planned for this run, but each has its command ready)

- Bob never locks: Alice does nothing until `D` (about 6 h 08 min after `h_create`), then the recovery close (chain `--preview`
  and `--expected-txid` in one command, run 2 lesson). Bob has spent only the deploy gas and the gas money.
- Alice never reveals: Bob refunds at `T_reveal` (lock + 2 h) with `live.js refund --mainnet --max-fee-gwei N` (a generous cap); the NOID returns
  to Alice at `D`.
- Ethereum finality stalls past the 1,140 s budget: Alice's gate stays closed and she does not reveal; this ends as the previous case, with
  nobody out of pocket. Do not override the gates to "help" it along.
- A transaction stuck below the base fee: wait for the base fee to fall, or replace it from the same key by hand with a higher fee and the
  same nonce (`live.js` does not do this); a refund or claim near its cutoff is the reason for the generous caps above.

## Known gaps carried into this run (for the owner to weigh at the go-ahead)

- The abort paths have been settled on a local chain (run 2) but not on a public network, and the stock variant, contract v2, the
  rotation case and the conflicting-close case (design Q1) are still open (`TASKS.md` M2.7). Mainnet adds nothing to those risks, but it
  adds real ETH to them.
- The production profile has no amount cap; the 0.001 ETH rule is only as strong as the typed numbers.
- Under `--mainnet`, `live.js lock`, `claim` and `refund` refuse without `--swap FILE`, so the commands in steps 5–7 are not usable by hand with bare flags.
- `PROJECT.md` allows testnets, signet and tiny amounts only until the external review (M4). This run is a tiny amount on a real
  network; whether that fits is the owner's call at the go-ahead.
- The NOID side has a single node (`--single-node-ok`); only the Ethereum side gets the two-node cross-check.

## What differed from the plan (run 8, 2026-11-06)

The mainnet happy path was executed as run 8 (`docs/live-run-8.md`). Only differences the log supports:

- **Amount and lock kind.** 5 NOID against 0.001 ETH instead of 10 NOID (a run at 10 NOID was prepared as run 7 and never funded), and the
  proof-free `poseidon` lock kind (contract `HTLCPoseidonV2`, no equivalence proof) instead of the SHA-256 lock with the proof. The
  plan's code hash and gas figures for the SHA-256 contract therefore did not apply; the `poseidon` contract's code hash is the pin
  `0xf510d2a3…3ff3`, and the reveal cost 517,084 gas.
- **Second node.** The plan asked for two Ethereum endpoints. The run used one public endpoint and one Parano1d node with
  `SINGLE_NODE_OK=1`, as the owner in both roles.
- **Fee caps.** Lock: 0.12 gwei. Reveal: the first dry run at 0.12 gwei passed, but the base fee ranged from 0.052 to 0.066 gwei over
  20 blocks, so the cap was raised to 0.2 gwei (ratio 3.35 against the latest base fee), which meets the plan's "at least three times the
  day's base fee" for the time-critical steps; the first cap (ratio 2.15) did not, and passing the 2 x gate was not enough.
- **Key files.** The helpers had `keys/bob.key` and `keys/alice.key` hard-coded; the run folder's copies were patched by hand. The
  helpers now read `BOB_KEY` / `ALICE_KEY` from `env.local.sh`.
- **Timing.** 54 minutes from funding to both sides final, inside the plan's 45 to 60 minutes.
