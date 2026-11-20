# Bitcoin signet live layer: safety gates, tests, gaps

Scope: `scripts/live.js` (with `src/esplora.js`, `src/verify.js`, `src/htlc.js`). Signet only. Nothing has ever been
broadcast from this code; every test runs against a mocked explorer. This file is the Bitcoin counterpart of the
safety header of `eth/scripts/live.js` (REVIEW-3 F1/F3, REVIEW-4 R4-1/R4-3/R4-5 in `swap-cli/`).

Plain words first. On Bitcoin there is no contract, only a script. Alice's claim shows the secret in its witness, so
**the claim is the reveal**: once it is in any mempool the secret is public, and if it does not confirm before Bob's
refund (`T_b`), Bob keeps the BTC and also learns the secret. Most gates below exist to make that race unlikely to
be lost, and to make sure nobody leaks the secret before the reveal is meant to happen.

## The gates

Every gate also applies in a dry run (the default); `--send` is the only thing that broadcasts.

| # | Gate | Where | Refusal |
|---|---|---|---|
| 1 | **Chain identity.** Each API host must report the public signet genesis as block 0 before any request; an unverifiable host is dropped for the run, another chain is fatal. A `/signet/` in a URL is not accepted as proof. | `esplora.verifyChain`, `requireClient` | `chain check failed` |
| 2 | **Network names.** Mainnet/regtest/legacy addresses, mainnet WIFs (`5`/`K`/`L`), uncompressed keys, API bases without `/signet/`, `BTC_NETWORK` other than signet/testnet. | `assertSignetAddress`, `loadKey`, `assertSignetBase`, `main` | by name, with the reason |
| 3 | **Role key.** claim must be signed by the script's Alice key, refund by Bob's; `lock` funds from the key that becomes Bob's refund key (`--bob-pubkey`, if given, must equal it). Errors never print key material. | `assertRoleKey`, `lock` | `not the Alice (claim) key` etc. |
| 4 | **Script terms.** `--witness-script` must be our exact template (strict decoder; the pre-`OP_SIZE` layout is rejected); term flags given next to it must say the same thing. | `scriptFromArgs` | `disagrees with --witness-script` |
| 5 | **Public test-vector hashlocks** (`00..00`, `00 01 .. 1f`) are never locked. | `lock` | `PUBLIC TEST-VECTOR` |
| 6 | **Funding depth.** Alice's claim needs 3 confirmations on the funding (design §3.3 step 9); `--min-confirmations` lowers it for a rehearsal, `--allow-unconfirmed` skips it. | `claim` | `wants 3` |
| 7 | **Claim cutoff.** No claim, and no `--replace` of a claim, once the tip is past `T_b - 6` (design §3.3 step 10', I2). `--ignore-cutoff` overrides with a warning (a replacement past the cutoff only re-sends a secret that is already public). | `claim` | `past the claim cutoff` |
| 8 | **Refund maturity.** No refund before the tip reaches `T_b`. | `refund` | `too early` |
| 9 | **Fee floor (R4-1).** Claim and refund read the explorer's 2-block estimate (clamped 1..50 sat/vB) every time and refuse a `--fee-rate` below it, or an unreadable estimate. `lock` only reports (`feeCheck`, a warning). | `resolveFeeRate` | `below the explorer's estimate` |
| 10 | **RBF ladder (R4-1).** `--replace` re-sends the same spend: the pending spend is found through the explorer, must be a one-input one-output spend of this branch, signal RBF, pay the same script and have the same nLockTime; the new fee must rise by at least 1 sat/vB of the new size and the new rate by 1 sat/vB over the old. Refused when the outpoint is unspent, the pending spend is confirmed, or no rate up to the 50 sat/vB cap clears the increment. A plain claim over a pending one is refused with a pointer to `--replace`. | `loadPendingSpend`, `replacementOk` | `--replace: ...` |
| 11 | **The secret never on argv.** `--secret`, `--preimage`, `--secret=...`, `--s`, `--x` are refused; it comes from `--secret-file` or stdin; stdin on a terminal is refused. A **claim hex** carries the secret, so `broadcast` refuses it as a command-line argument (use `--hex-file` or `--hex-stdin`). | `parseArgs`, `readSecret`, `broadcast` | `never taken from the command line` |
| 12 | **The secret never printed or written by default.** `status`/`watch` say `preimageFound` and the hash; the value only with `--print-secret`, on stdout. `--print-secret` and `claim` (whose hex holds the secret) refuse a stdout that is a regular file. The watcher calls no file API. | `status`, `main` | `stdout is a file` |
| 13 | **Explorer answers are checked, not trusted.** A spending tx must hash to the txid asked for and spend this outpoint at the reported input before any branch or preimage is read; the preimage comes only from that input (`extractPreimage(..., inputIndex)`) and is re-hashed against `H`. A spend the explorer reports but cannot show yet is not read as "no reveal": `watch` keeps polling. | `status`, `watch` | `unknown branch` / keeps polling |
| 14 | **Swap file (F3).** `--swap FILE` on `lock`, `claim`, `refund`, `status`, `watch`: read-only (the sealed secret is never touched); version 1, role/phase consistent; the hashlock is filled in when left out and must equal the file's when given, and the script's hashlock must equal it; `lock` needs a Bob file, `claim` an Alice file; `lock` and `claim` refuse a finished phase (`refunded`, `aborted`, `lost`); `refund` is allowed under an aborted file. Without `--swap` the command line warns once. | `bindSwap` | `disagrees with the swap file` etc. |

## What the swap file does NOT carry (honest list)

`swap-cli` has no Bitcoin pair yet (TASKS M3.1). Its swap file format (version 1, `swapfile.rs`) holds the hashlock,
the role and phase, the NOID terms (`amount_micronoid`, `deadline_height`, `lock_by_height`, `w_a_s`, the opening) and a
**mandatory Ethereum block** (`public.params.eth`). So today:

* **Bound:** hashlock, role, "swap not finished", and (by stdin) the secret flow: `swap-cli secret FILE | node scripts/live.js claim ...`.
* **Not in the file, therefore not checked against it:** Alice's and Bob's BTC pubkeys, `T_b`, the BTC amount, the funding
  outpoint, the witness script, the signet network, and any Bitcoin *intent* (there is no `lock_btc` / `reveal_btc` /
  `refund_btc` action, so the equivalent of the Ethereum script's "pending intent must match" gate does not exist).
* **Every current file is an NOID<->ETH file.** `--swap` accepts it (it is the only format there is) and prints a warning:
  using its hashlock for a Bitcoin lock while the Ethereum lock of the same file is live would put one secret on two chains.
  Use a file made for the rehearsal, and never run both legs under one `H`.
* The file's `D` is not compared with `T_b`: the cross-chain timeout inequality (I1) for BTC is not evaluated by any code.

The file layout was read from the Rust sources, not from a file written by the tool: the tests use synthetic files with
the same field names. A real Alice/Bob file has not been fed to this script.

## What is tested (`npm test`: 91 tests, offline)

* `test/live.test.js` (40): all commands against a mocked chain, including every refusal above: chain check (once per
  client, wrong chain, client without a check), uncompressed/mainnet/wrong-role keys, term-vs-script disagreement,
  secret on argv and claim hex on argv, funding depth, fee floor (claim, refund, lock-as-warning, cap, unreadable
  estimate), `--replace` (same input, same payout script, BIP-125 arithmetic, explicit rate too low names the working
  minimum, estimate floor on a replacement, unspent / confirmed / refund / other destination / no-RBF / vanished /
  txid-mismatch / past cutoff / at-the-cap), refund `--replace`, `watch --lock` (unconfirmed claim found, hash shown,
  value only with `--print-secret`, nothing on stderr, no file API called, refund spends, hex not yet served, wrong
  txid or wrong input), `extractPreimage(inputIndex)`, the swap-file cases (roles, phases, hashlock, malformed files,
  sealed secret untouched).
* `test/esplora.test.js` (+3): `verifyChain` with both hosts, a wrong genesis (mainnet, testnet3), a dropped host that is
  never used again, no host verifiable.
* Mutation spot checks done by hand (not kept): turning off the BIP-125 check, the fee floor, the chain check, the RBF
  signalling check, the claim-hex-on-argv refusal or the confirmed-spend refusal each makes at least one test fail.

## What is NOT tested, and cannot be from the sources

* **No regtest, no bitcoind** (M3.2). Script validity is judged by `src/verify.js`, a re-implementation of this one
  template, not by `testmempoolaccept`. The first real run must dry-run every hex through a node first.
* **BIP-125 is policy arithmetic here, not Core's mempool.** The tool applies rules 3, 4 and the higher-rate rule; Core
  also bounds evictions (rule 5) and needs no new unconfirmed inputs (rule 2), both trivially true for a one-input spend. Whether
  mempool.space or blockstream.info relays a given replacement is unverified.
* **The explorer shape for a mempool spend.** Fixtures recorded from the real API hold a *confirmed* spend. The unconfirmed
  `outspend` answer (`status.confirmed: false`) is taken from the Esplora format and is what the watcher depends on to see
  a claim "in any mempool" (design §3.1). Check it on the first signet claim before relying on it. `GET /block-height/0`
  was read live from both default hosts (2026-11-05, read-only) and matches the constant in the code.
* **One explorer at a time.** Tip height, funding depth and spends come from whichever host answers; both are
  checked to be signet, but they are not cross-checked against each other (the Ethereum script's two-node and
  header-time checks, F5, have no counterpart), and nothing here is a second source against a lying explorer.
* **Reorgs.** A claim or refund that confirms and is reorged out is not tracked; the design's "final before `D`" logic lives
  in `swap-cli`, which does not know Bitcoin.
* **Timing** (the claim cutoff `T_b - 6`, `T_b - tip >= 12`) is judged on the explorer's tip. `T_b - tip >= 12` is a warning in `lock`,
  and shown (`claimCutoffHeight`) by `status`; no command of Alice's refuses on it before she locks NOID.
* **Fee ceiling.** The 50 sat/vB cap is a signet sanity bound (one explorer answered 3,901 sat/vB for some targets).
  On a real fee spike the cap would stop the ladder; that is acceptable only on signet.

## What the Bitcoin leg still needs before a live signet swap

1. **The BTC pair in `swap-cli`** (M3.1): a `btc` block in the swap file (network, both pubkeys, `T_b`, amount,
   funding outpoint, witness script), Bitcoin phases and intents (`lock_btc`, `reveal_btc`, `refund_btc`), a Bitcoin
   watcher (funding depth, spend detection incl. unconfirmed claim, reorg after inclusion), the engine gates for
   (I1)-(I5) with BTC numbers, and this script's `--swap` extended to compare the BTC terms and the pending intent
   exactly as `eth/scripts/live.js` does.
2. **The equivalence proof flow for BTC.** The hashlock is the same `H = SHA-256(s)` and the 65-byte journal
   (`variant ‖ H ‖ A`) names no chain, so the receipt format should carry over unchanged; what is missing is the wiring:
   Bob's attestation and the engine's "verified before locking" gate are written for the Ethereum pair, and the BTC script
   (`H`, Alice's pubkey, `T_b`) must be rebuilt by Bob and compared with the swap file before he funds.
3. **The D offsets and profiles from the design.** BTC: `T_b = h_btc_now + 24`, `D_offset = 2,050`, Bob's lock-by
   `D - 1,873`, `RHS(I1) = 1,873` for `B_safety = 31` and `B_final` 19 (design §4.4/§4.5; corrected 2026-11-08: the chain's finality is 18 blocks after inclusion); `swap-cli/src/params.rs` has production,
   rehearsal and sepolia profiles for the Ethereum pair only. A short signet rehearsal profile for BTC (shorter `N_btc`, and
   a `D` that respects the Parano1d v2.1 height rule) has to be defined and its inequalities checked before a run.
4. **A bitcoind check of every hex** (`testmempoolaccept`) and a regtest loop for the race (claim vs. refund at `T_b`) (M3.2).
5. **A go-ahead for each `--send`**, as for every live action in this project; fresh secret and fresh keys per swap.
