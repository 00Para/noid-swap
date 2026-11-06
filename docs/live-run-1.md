# Live run 1 — first real NOID ↔ ETH swap (Sepolia + mainnet-tiny), 2026-11-04

> Clock times in this log are UTC (converted from the operator's local clock); an entry after 00:00 falls on the calendar day after the one in the title.

Runbook and log for milestone M2.7's first scenario ("happy, raw variant"), played by the owner
in both roles on one machine. Nothing here is sent to a chain without the owner's go-ahead in
the session (PROJECT.md). Amounts are tiny; the Ethereum side is the Sepolia test network.

Plain words: Alice holds NOID and makes the secret; Bob holds ETH. Alice locks NOID in a
contract that only the secret's address can close to Bob before height `D`. Bob locks ETH
in a contract that Alice can take only by publishing the secret before `T_reveal`. Alice
publishes it (the *reveal*) to take the ETH; Bob reads it and closes the NOID contract to
himself. If either side stops, the timeouts give each party their own funds back.

## Parties and amounts (filled in as the run proceeds)

| Item | Value |
|---|---|
| Alice (NOID side, recovery authority) | `o1zjj6zqc7uh4lts9neryq86dda6n76s7zj8c7wa0gfsnms3greqequtpurk` (wallet app, index 0) |
| Bob's NOID address (claim recipient) | `o1xpyc7ar25emv3tyvlphettpw43fec66q2agnd86r3g8fu5x6tg2s8w8q9r` (same wallet, index 1, inactive; derived 13:47) |
| NOID amount | 10 NOID = 10,000,000 μNOID (proposed; the 1 % fee-cap rule needs ≥ 5 NOID) |
| `max_fee` | max(50,000, 3 × 5,800) = 50,000 μNOID |
| Bob (Sepolia sender) | `0x6f8560EC1185f50104f5B64Df21e858dBd592883` (`eth/keys/bob.key`, throwaway) |
| Alice (Sepolia receiver) | `0x49877DaCE5b72f4E8768FbF5Cb7eE1573c9fF9eA` (`eth/keys/alice.key`, throwaway) |
| ETH amount | 0.001 ETH = 1,000,000,000,000,000 wei |
| Ethereum chain | **Fallback used: local Hardhat node** `http://127.0.0.1:8545`, chain id 31337, empty blocks every 12 s (`HARDHAT_INTERVAL_MINING_MS`), started from the local dev-server launcher. Sepolia (`https://ethereum-sepolia-rpc.publicnode.com`, 11155111) was the plan; the faucets refused the request |
| Parano1d node | wallet app's node, `http://127.0.0.1:9601`, mainnet, synced |
| HTLC contract | `0x489228d5b89EC1B2e441fc5FFF5517Cb79C6Ec48` (local chain, block 4, deployer Bob, `codeHash 0xa906117f…545e2f`, matches the artifact). Bob and Alice funded with 1 test ETH each from Hardhat account #0 |
| Swap files | `~/live-run-1/alice.swap.json`, `~/live-run-1/bob.swap.json` in WSL (never committed) |

Timeouts (design §4.3): `D = H_create + 725` (~6 h), Bob's lock-by `D − 619`, `W_A = 7,200 s`,
`T_reveal = min(now + 7,200, T_max)`, claim target ≤ `D − 18`.

## Steps and checkpoints

Every WSL command runs with `BIN=$HOME/noid-target/release/swap-cli`, the Windows
tool is `C:\Parano1d\bin\parano1d-cli.exe`, and Ethereum commands run from `eth/` on Windows
with `ETH_RPC_URL` set to the Sepolia RPC. `tick` always uses
`--transport curl --noid-rpc http://127.0.0.1:9601 --eth-rpc <Sepolia RPC> --eth-from-block <recent block>`.

0. **Prerequisites.** Node synced at height ≥ 279,388 ✅ (280,5xx). swap-cli 135 tests ✅, eth 54 ✅. Draft dry run: `tick` against the real node + Sepolia ✅; the node's `contract create` reproduces a draft swap file's opening byte-for-byte ✅ (13:37).
   Bob's Sepolia address funded by a faucet (≥ 0.03 ETH) ☐. Bob's NOID address chosen ☐.
1. **Bob deploys the HTLC on Sepolia** (`live.js deploy --dry-run` first, then for real; note
   `contract`, `codeHash`, `matchesArtifact: true`). Then `live.js send` 0.01 ETH to Alice for gas.
   *Go-ahead needed: first Sepolia transactions.*
2. **Alice creates the swap file** with `new-alice` (`--h-create` = current tip at this moment),
   prints the bundle; `swap-cli secret` gives the secret to the prover only.
3. **Equivalence proof** (≈ 20 min on this machine): `equiv-prove prove raw <m> alice.receipt` (historical: this form was removed on 2026-11-04; the secret is piped with `--secret-stdin`),
   then `equiv-prove verify raw <H> <A> alice.receipt` → image id + journal values.
   **Bob**: `new-bob` with his own terms, the verify output, and the pinned image id.
4. **Alice builds and checks the contract**: `alice-params --definition-out`, `parano1d-cli contract create`,
   `alice-params --check-object` must print "object file OK" and the same root as the bundle.
   **GO / NO-GO** on: object OK, tip + 725 = D not straddling anything, Bob's file exists,
   wallet active address = Alice's. Then `parano1d-cli contract fund swap.object.json 10.000000`.
   *Go-ahead needed: real NOID leaves the wallet.*
5. **Loop `tick` for both files** every ~30 s. Alice's shows the instance, then finality (18 blocks).
   Bob's says `lock_eth` with `t_reveal`: run `live.js lock` with exactly those values; note
   `lockId`, `blockNumber`, `blockTimestamp`. *Go-ahead needed: Sepolia lock.*
6. Alice's `tick` says `reveal_eth` once Bob's lock is `finalized` on Sepolia (≈ 15 min) and (I2)
   holds: `live.js claim --key-file keys/alice.key --preimage <secret>`. *Go-ahead needed.* (Historical: since the
   REVIEW-2 fixes of 2026-11-04 the `--preimage` flag no longer exists; the secret is piped in with
   `swap-cli secret FILE | node scripts/live.js claim … --secret-stdin`, and `--chain-id`/`--code-hash` are mandatory.)
7. Bob's `tick` records the secret and says `claim_noid`: `swap-cli claim bob.swap.json …` (dry run:
   proves, prints txid/call height/recipient), then `--submit`. Then `tick` until the claim is final
   (18 blocks). *Go-ahead needed: the NOID close.*
8. **Verify**: `parano1d-cli contract instances` shows no live instance; Bob's NOID address received
   10 NOID − fee; Alice's Sepolia address holds 0.001 ETH; receipts exported. Record timings below,
   keep the `--record-noid` fixtures (first real recordings of a funded HashTimeLock), update
   `TASKS.md` M2.7 and design §9.

Abort paths: Bob never locks → Alice does nothing until `D`, then the recovery close (README "Alice 4").
Alice never reveals → Bob refunds the ETH at `T_reveal` (`live.js refund`); the NOID contract
returns to Alice at `D`. A claim is safe only when final; a reveal is safe only before `T_reveal − M_A`.

## Log

_(filled in during the run: times, heights, txids, what differed from the plan)_

- 13:46 Alice's swap file created in WSL (`~/live-run-1/alice.swap.json`, raw variant): `h_create` 280,561, `D` 281,286,
  nominal lock-by 280,667 (hard gate `D − 529` = 280,757), `max_fee` 50,000 μNOID, amount 10 NOID.
  Hashlock `0xb1dcdfad…16c5fe`, claim authority `o1myesz7…dcswg`, contract root `o1qjnr505ua8gg63enxsjq9a4rsvlfg3nkx7zy5pfsdudy9ktuajlq786367`.
- 13:46 Equivalence proof started (`equiv-prove prove raw`, 2^18 segments, 3 GB VM).
- 13:49 `parano1d-cli contract create` on the real node → same root; `alice-params --check-object`: "object file OK" (byte-for-byte).
  Claim recipient = Bob's index-1 address, recovery authority = recipient = Alice's index-0 (active) address.
- 13:52 Hygiene slip, recorded on purpose: a process listing (`pgrep -af`) during the proof showed the prover's
  command line, which carries the secret as an argument; the first 20 of its 32 bytes went into the session
  transcript. The remaining 96 bits keep the hashlock far out of reach, and this is a self-swap of 10 NOID, so the
  run continues. Lesson: never list processes with arguments while a proof runs; follow-up: `equiv-prove prove`
  should read the secret from stdin or a file descriptor, never from `argv` (TASKS.md).
- 14:19 Proof done: `prove time 2,090 s` (35 min; the Nov 3 reference was 1,180 s, this run shared the 3 GB VM with
  a disk inventory), 13 segments, 223,356-byte receipt, peak 2,762 MB. `equiv-prove verify raw` → OK, image id
  `7e9d8477…6187` (= pinned).
- 14:22 `new-bob` first refused: the bundle carries `code_hash: null` (Alice's `new-alice` was not given
  `--eth-code-hash`), so Bob's `--eth-code-hash` did not match "his terms"; rewritten without the pin (the watcher
  still checks chain id and that the sender is an EOA). Lesson: pass `--eth-code-hash` to BOTH `new-alice` and `new-bob`.
- 14:23 **Funded** (owner's go-ahead 09:0x "Go, fund 10 NOID"): `parano1d-cli contract fund swap.object.json 10.000000`
  at tip 280,635 → txid `267e6f1dbbfa7623d51d7acea9bcc1b78136ded8d205adbb3a3b0e88d4e67780`, fee 9,000 μNOID
  (1 input, 2 outputs). Pre-checks: active index 0, spendable 2,148.96 NOID, object file OK, proof verified, Bob's file written.
- 14:26 Funding included at height 280,638 (admitted 280,636; the 280,637 block missed it): instance slot 9,750,400,
  creation id 736,337, 10 NOID, `instance_matches_opening: true`; both swap files moved to `funded`, waiting for
  18-block finality. Public files copied to `C:\Users\00\Documents\live-run-1\` (object, definition, bundle, fund receipt).
- 14:34 Funding final at tip 280,655 (nominal lock-by 280,667). Bob's engine: `lock_eth` with `t_reveal` 1,793,810,086
  (= chain time + 7,200 s, full window), hashlock, receiver and amount as committed.
- 14:35 Bob locked 0.001 ETH on the local chain: lock id `0x23a340a6…8c69`, tx `0xfde62e25…db24`, block 265, gas est. 149,197.
  Both ticks saw the lock (`eth_lock_seen`); Alice's engine went `lock_final` → `reveal_eth` at once (local chain: `finalized` = latest).
- 14:36 Alice revealed: `HTLC.claim` tx `0x764db838…37ae`, block 269; her balance 1.000911 ETH (+0.001 − gas). Alice's
  engine: `eth_claim_mined`, `eth_claim_final` → **done**. Bob's engine: `eth_preimage_seen` (from the `Claimed` log) →
  `claim_noid` at call height 280,657, fee 5,800.
- 14:36 Bob's claim dry run (client R): built, proved (authorization V4, 3 s total), self-verified, intent 91,121 bytes,
  txid `e75489c8…8011`, payout 9,994,200 μNOID to `o1xpyc7a…8w8q9r`, height class OnTarget. Nothing submitted; waiting
  for the owner's go-ahead for `--submit` (the claim is rebuilt at the then-current height).
- 14:37 **Claim submitted** (owner's go-ahead "Go, submit claim"): `swap-cli claim --submit` rebuilt the close at call
  height 280,658 (tip 280,657), proved + self-verified in 3 s, intent 90,865 bytes, txid
  `d50743e3ead6c3870ec7e9b1322113a956a034cf6fc259753743ecd49f3e1324`; the node accepted it (`submitTxIntent`, first
  ever against a real node). Bob's file: `claim_submitted`; the next tick saw it as our pending call (`pending 1`,
  `tracked_tx_pending: true`).
- 14:38 Claim included at height **280,659** (block `59eefd12…4928`, position 1), one block after its call height 280,658:
  the authorization proof is bound to the branch and epoch anchor, not to the exact call height (answers REVIEW-1
  "could not determine" #1 in the favourable direction). Bob's file: `claim_included`.
- 14:45 **Claim final** at tip 280,676 (`noid_tx_final`). Bob's engine: `done: NOID received`.
- 14:46 Verification. Parano1d: Bob's index-1 address holds a new UTXO of **9,994,200 μNOID** (creation id 736,440,
  slot 606,411); `contract instances` lists nothing (the instance is closed); the wallet's active-address balance went
  2,148.960190 → 2,138.951190 NOID (= −10 NOID −9,000 μNOID fee; the index-1 funds are not in that figure). Receipt
  exported (`claim.receipt`, 872,441 bytes) and verified by the node: authority `o1myesz7…` (= Addr(s)), input 10,000,000,
  fee 5,800, height 280,659. Local Ethereum: lock `claimed`, preimage matches the hashlock, events Locked@265 / Claimed@269;
  Bob 0.997833 ETH (−0.001 − gas), Alice 1.000911 ETH (+0.001 − gas).

## Result

**Swap 1 settled on both legs: 10 NOID (mainnet) ↔ 0.001 ETH (local Hardhat chain), raw variant, no funds stuck.**
Wall clock from Alice's file to final claim: 13:46 → 14:45 (59 min), of which the equivalence proof took 35 min
and the owner's go-aheads a few minutes; the chain-bound part (fund → final → lock → reveal → claim → final) took 22 min.

Measured (feeds design §9 / TASKS M2.8):

| Step | Value |
|---|---|
| Funding: admitted → included | 2 blocks (280,636 → 280,638) |
| Funding: included → final (18) | 280,638 → 280,655, 8 min 30 s |
| Bob's lock decision → ETH lock mined | 37 s (local chain) |
| Reveal → Bob's engine sees the preimage | next tick (≤ 20 s), from the `Claimed` log |
| Claim build + prove + self-verify (client R, V4) | 3 s (dry run and submit alike) |
| Claim: submitted (call height 280,658) → included | 1 block (280,659) |
| Claim: included → final | 280,659 → 280,676, 7 min |
| Fees paid | funding 9,000 μNOID (wallet), close 5,800 μNOID (from the contract), ETH gas only on the local chain |
| Equivalence proof (raw, 2^18 segments, 3 GB VM, contended) | 2,090 s prove, < 1 s verify |

Not covered by this run (still M2.7): Sepolia (real finality and public RPC limits), the stock variant, the abort
paths (Bob refunds at `T_reveal`, Alice recovers at `D`), the forced epoch rotation, the `F_max`-burn early close and a
conflicting third-party close. The local chain's `finalized` tag equals `latest`, so (I2)'s finality wait was not exercised.
- 14:47 Receipt verification result: `valid: true`, `terminal: true`, authority `o1myesz7…` (= Addr(s)), input 10,000,000,
  fee 5,800, retained 0, payout `{o1xpyc7a…8w8q9r, 9,994,200}`, no successor.
- 14:55 The node's answers from this run became real fixtures (`swap-cli/fixtures/parano1d/recorded_*.json`: funded
  first-seen / unfinal / final, claim pending / included / final; suite 143 tests). Differences from the synthesized
  shapes: extra fields on `getObjectStatus.object`, zero-page mempool entries, relay floor 5,000 all run.
- 15:00 **Bug found by the recordings and fixed**: the poll is several RPCs, not one snapshot. At first sight of the
  instance `blockCount` said 280,637 while `getObjectInstances.height` said 280,638, so the engine would have stored
  `seen_at_tip` = 280,637 and declared the funding final at 280,654, one block before the real finality height 280,655
  (it did not bite in this run: the first-seen tick was Alice's, and Bob's `noid_funding_final` fired at 280,655 as
  measured). Fix in `watch/parano1d.rs`: `tip` is raised to the highest height any answer of the poll reflects.
