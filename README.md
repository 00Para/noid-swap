# No1d Swap

A desktop program that swaps **NOID** (the coin of Parano1d) for **ETH** (Ethereum) between two people, with no bridge in
between. A contract on each chain holds the coins. Either both people get what they agreed on, or both get their own coins back
after a deadline. Nobody else holds anybody's coins, and the contracts have no owner and no admin key.

It is for **two people who have a reason to trust each other**, and for small amounts. Read "Limits and risks" before you use it.

The repository is called `noid-swap`. It holds the program, the swap tool behind it, the contracts, the protocol design and the
logs of every real run.

## Limits and risks

The program shows the same card under "Limits and risks". In short:

- **Caps per swap.** On Ethereum mainnet, at most **2,500 NOID and 0.5 ETH**. On the Sepolia test network, at most **20 NOID and
  0.01 ETH**. The program refuses more. Parano1d has no test network, so the NOID is real money in every swap, also on Sepolia.
- **Three ways to lose.**
  1. If you sell ETH and your computer is off after Alice takes the ETH: your program has at least about 75 minutes to claim the
     NOID. If it misses that, Alice can take the NOID back and you have lost the ETH.
  2. If you sell ETH to someone who controls most of Parano1d's mining, they can take both sides. One address mined between 45 %
     and 63 % of each day's blocks over 20 days (52.7 % of the last day measured), read from the chain's own block headers on
     2026-11-08. Above half of the hashrate a longer waiting window does not help. Sell ETH only to someone you have a reason to
     trust. Bob's program reads the current share before each lock: the swap tool refuses above 35 %, and Bob's approval can accept
     a share up to 65 %, never more. That is a screen, not a defence: it
     cannot see a miner on several addresses or a share that grows later. Model and numbers:
     [`docs/miner-concentration.md`](docs/miner-concentration.md); the screen: [`docs/bob-concentration-gate.md`](docs/bob-concentration-gate.md).
  3. The code, and the hash function behind the NOID lock, have not been reviewed by outside experts. A flaw could cost the coins
     of a swap. Keep amounts small.
- **Who is who.** Alice sells NOID and Bob sells ETH. Bob is the one exposed to the mining limit and to being offline after the reveal.
- **No outside audit.** Every review in this repository was made by the project itself. None came from an independent party.
- **Time.** About 50 minutes when both sides are online. If the swap stops, NOID can stay locked about 6 h 45 min after Alice's
  Prepare, and ETH about 2 h 20 min after Bob's lock, before they come back.
- **Track record.** On Ethereum mainnet so far: 1 swap settled, 0 refunded, both sides run by the developer with the terminal tools,
  before this program. The program itself has run only on the Sepolia test network (see "What has run").

## Get it

Installers are on this repository's **Releases** page: a Windows x64 installer (`No1d-Swap-<version>-win-x64.exe`) and a macOS
Apple Silicon disk image (`No1d-Swap-<version>-mac-arm64.dmg`). Each release also carries `release.json` and `release.json.sig`.

**Check an installer before you open it.** A signature is a short code that only the holder of a private key can make and anyone
with the public key can check. The project's one release key signs `release.json`, which lists each installer's SHA-256 (its
fingerprint: the same bytes always give the same one). The release page and its hosting account are not the proof; the signature is.

1. Take the public key from `desktop/lib/releasekey.js` in this repository, and compare it with the line the project publishes
   elsewhere.
2. Check the notice: `node desktop/scripts/release-key.js verify --pub <PUBLIC KEY> --in release.json --sig release.json.sig`
   must print `OK`.
3. Compute the installer's SHA-256 (`Get-FileHash FILE` on Windows, `shasum -a 256 FILE` on macOS) and compare it with the entry
   for that file name in `release.json`.

If the notice does not verify, do not install. Details and limits: [`docs/release-key.md`](docs/release-key.md). The build's
provenance attestation on the release page is a second check (`gh attestation verify FILE --repo OWNER/REPO`, see
[`docs/building.md`](docs/building.md)).

**The installers are not code-signed for the operating system** (there is no name to put on a certificate). Windows shows
"Windows protected your PC": choose "More info", then "Run anyway". macOS refuses to open the app at first: open System Settings,
Privacy and Security, and choose "Open Anyway". Do this only for an installer that passed the check above.

At the first start the program makes a vault in your operating system's key store and shows a **recovery code**. Write it on paper
before you deposit anything. With it and the swap's run folder you can finish a swap with `swap-cli` alone if the program no longer
starts (`desktop/README.md`, "By hand, without the program").

To build it yourself, see [`docs/building.md`](docs/building.md) and "How to run the tests" below.

## How a swap goes

Alice has NOID and wants ETH. Bob has ETH and wants NOID. Each side runs the program on its own computer.

1. **Bob saves an invitation.** It holds the amounts and Bob's two addresses. Alice opens it and her form fills in; she still
   checks every value.
2. **Alice presses Prepare.** The program has already made the swap's own wallets (a NOID wallet and an Ethereum key, one per swap,
   so your main wallets are not used); Prepare makes the swap file. Prepare starts the clock, so both people should be at their screens.
3. **Alice saves a copy for Bob. Bob chooses it and the program checks it.** Both screens then show a **check line**, four groups
   of four digits. Alice and Bob compare the two lines by another channel and each confirms that they match.
4. **Each side approves once.** The approval says what you give and what you get. Bob's approval adds that he accepts the measured
   mining share and that he swaps only with someone he has reason to trust.
5. **Both deposit.** Alice sends the NOID, Bob the ETH, to the addresses the program shows, with a clock for Alice. A short deposit
   is flagged with the amount still missing.
6. **The program does the rest**, each step behind a dry run and a gate: Alice funds the NOID contract, Bob locks the ETH, Alice
   reveals her secret on Ethereum and takes the ETH, Bob uses that secret to take the NOID, and each side's program sends what is
   left in the swap wallet to the payout address you chose.

The usual time from the funding to done is about 50 minutes; most of it is waiting for the chains to make the steps final.
If the swap stops, the deadlines return each side's coins: Bob's ETH about 2 h 20 min after his lock, Alice's NOID about 6 h 45 min
after Prepare. Keep both computers on and online until the swap is done. The program keeps the machine awake while coins sit in a
contract.

Ethereum mainnet is open only in the desktop program and only within the caps. The terminal console, the offer board, contract
version 2, the stock-wallet variant and the SHA-256 lock stay test-only. Why a swap runs this way is below.

**The Ethereum contract on mainnet** is `0x4e364cC86EdBF307CC6F336F3a72e1a24d284D70` (deployed 2026-11-20 from a key used for
nothing else). It has no owner, no admin key, no pause, no upgrade and no fee. Its source is verified on Sourcify (exact match:
the code on the chain is what [`eth/contracts/HTLCPoseidonV2.sol`](eth/contracts/HTLCPoseidonV2.sol) compiles to), and its code
hash `0xf510d2a368c730339fa7cf5e023bcf2429d5732793f043e03025780bb7043ff3` is compiled into the swap tool, which refuses a
contract with any other code.

## Why Parano1d makes this cheap, and why it decides who goes first

Three words first. A **hashlock** is a lock that opens for whoever shows a secret `s` whose hash `H` is written on the lock. A
**timelock** is a deadline after which the coins go back to whoever put them in. The **reveal** is the moment `s` becomes public:
one party takes the other's coins by showing it, and the other party reuses it to take theirs. An atomic swap puts one lock with
the same `H` on each chain.

Parano1d has no signatures. A wallet spends by giving a zero-knowledge proof that it knows a 256-bit secret whose hash is its
address (`A = Addr(s)`). So a Parano1d contract whose claim authority is `Addr(s)` *is already a hashlock*, with no extra opcode:
the lock on the NOID side costs nothing beyond a normal contract (`parano1d/contracts/htlc.pruv` compiles to 1 of 16 instructions).

The same fact fixes the order of play. A Parano1d claim never shows `s` (it is a proof, not a preimage), so the NOID side can never
be the reveal side. The NOID holder must create the secret and lock first, with the longer deadline; the ETH holder locks second,
with the shorter one; the reveal always happens on Ethereum, and the NOID holder's counterparty claims the NOID last with the secret
read there. In the lock kind the program uses (`poseidon`) the Ethereum contract checks `Addr(s)` itself, so one secret is behind both
locks without a proof. In the other kind (`sha256`, test-only) the counterparty checks an off-chain zero-knowledge receipt that one
and the same `s` is behind the Ethereum hashlock (`SHA-256(s)`) and the Parano1d address, otherwise the NOID lock could be a decoy.
Full design: [`docs/protocol-design.md`](docs/protocol-design.md).

## What it is not

Not a bridge, no wrapped NOID, nobody holds anybody's coins. Pairwise trades only: NOID against ETH (the only pair the swap tool runs
today) or, by design, against BTC (the Bitcoin library exists and is tested, nothing has been broadcast on signet). An ERC-20
contract exists (`eth/contracts/HTLCERC20.sol`) but the tool does not support it: a token that can block or fail a payout would
publish the secret without paying, so an ERC-20 swap would need a vetted token list first. Not a market: the two people find each
other and agree on a price elsewhere. The program does not set a price. The offer board (offers over Nostr relays) is a private test
board by invitation and is refused on mainnet.

## What has run

| Run | What | Result |
|---|---|---|
| 1 | 10 NOID on Parano1d mainnet against 0.001 ETH on a local Hardhat chain, happy path, the raw-secret variant | settled on both legs; the NOID close receipt verified ([`docs/live-run-1.md`](docs/live-run-1.md)) |
| 2 | same amounts, the abort path: the NOID holder never reveals | both refunds settled (ETH refund at `T_reveal`, NOID recovery at `D`), nobody lost funds ([`docs/live-run-2.md`](docs/live-run-2.md)) |
| 3 | 10 NOID on mainnet against 0.001 ETH on **public Sepolia**, happy path | settled; 44 minutes from funding to final NOID, Ethereum finality (about 19 minutes) included ([`docs/live-run-3.md`](docs/live-run-3.md)) |
| 4 | 10 NOID against 0.001 ETH on Sepolia, the abort path before any Ethereum lock (Bob never appears) | the NOID recovered at `D`, cost 14,800 μNOID ([`docs/live-run-4.md`](docs/live-run-4.md)) |
| 5 | 10 NOID against 0.001 ETH on Sepolia, happy path with the proof-free `poseidon` lock kind (no equivalence proof) | settled; about 47 minutes from funding to both sides final ([`docs/live-run-5.md`](docs/live-run-5.md)) |
| 6 | the abort path after Bob's lock on Sepolia, `poseidon` lock kind: the NOID holder never reveals | both refunds settled, Bob's file `refunded` only at Ethereum finality ([`docs/live-run-6.md`](docs/live-run-6.md)) |
| 8 | 5 NOID against 0.001 ETH on **Ethereum mainnet**, happy path, `poseidon` lock kind, `production` profile (there is no run 7 log: it was never funded) | settled; 54 minutes from funding to both sides final ([`docs/live-run-8.md`](docs/live-run-8.md)) |
| 9 | 5 NOID against 0.001 ETH on Sepolia, `poseidon` lock kind, the first run with the two roles on two machines: the contract was funded three times by mistake before any lock | neither side went on, as designed; all three NOID instances recovered at `D` ([`docs/live-run-9-10.md`](docs/live-run-9-10.md)) |
| 10 | the same, funded once: the abort after Bob's lock, Alice's reveal not sent before its cutoff | Bob refunded his ETH, Alice recovered her NOID at `D`, the secret never published ([`docs/live-run-9-10.md`](docs/live-run-9-10.md)) |
| 11 | the retry of runs 9 and 10: 5 NOID against 0.001 ETH on Sepolia, happy path, `poseidon` lock kind, the two roles on two machines | settled; 44 minutes from funding to both sides final, Bob's claim sent from the Mac ([`docs/live-run-11.md`](docs/live-run-11.md)) |
| 12 | the same swap as run 11 with the two-node check on: two Parano1d nodes and two Sepolia endpoints for each side, the Parano1d nodes joined by one SSH tunnel | settled; 45 minutes from funding to both sides final ([`docs/live-run-12.md`](docs/live-run-12.md)) |
| 13 | the same swap as run 11 (one node per chain) with Alice's steps driven from the operator console over the same `scripts/live` helpers; Bob's side from a terminal | settled; 50 minutes from funding to Alice's side final ([`docs/live-run-13.md`](docs/live-run-13.md)) |
| 14 | the same setting as run 13, the first run with the finality-18 code (Alice's steps from the helpers, not the console) | settled; 51 minutes 49 seconds from funding to Alice's side final ([`docs/live-run-14.md`](docs/live-run-14.md)) |
| 15 | hostile counterparty, group L1: Alice prepares and never funds | both tools gave up by themselves on the real nodes, Bob at his last lock height; nothing was sent ([`docs/live-run-15.md`](docs/live-run-15.md)) |
| 16 | group L2: Alice funds 4 NOID where 5 was agreed | both tools refused to count the instance, Bob never locked; the 4 NOID came back after `D` less the 5,800 close fee; the run cost 14,800 μNOID in fees ([`docs/live-run-16.md`](docs/live-run-16.md)) |
| 17 | group L3: Bob makes a lock by hand that leaves Alice 28 minutes where 56 are required | Alice's tool rejected it and never offered the reveal; the early refund was refused twice; the ETH was refunded and the NOID came back after `D` ([`docs/live-run-17.md`](docs/live-run-17.md)) |
| 18 | group L4, first try: a third party closes the contract after the reveal | ended on its abort path: the operator's reveal came 110 seconds after its cutoff and the tool refused it; the close was not reached ([`docs/live-run-18.md`](docs/live-run-18.md)) |
| 19 | group L4, second try | settled; a third party with only the public bundle and the secret read from Ethereum closed the contract before Bob, and the close paid Bob; 49 minutes 41 seconds from funding to Alice's side final ([`docs/live-run-19.md`](docs/live-run-19.md)) |
| 20 | groups L5 and L6 in one run: the second Parano1d node away at Bob's lock, and an epoch rotation before Bob's claim; two nodes per chain | settled; with the link closed the lock was refused and offered when it was back; the claim was not proved three blocks before a rotation and was proved after it ([`docs/live-run-20.md`](docs/live-run-20.md)) |
| 22 | the swap's own NOID wallet on Parano1d mainnet, one person, Alice's side only (there is no run 21 log: that folder was only read) | the funding of 5 NOID, the recovery close after `D` and the sweep to the payout address were accepted and mined; 20,700 μNOID in fees ([`docs/live-run-22.md`](docs/live-run-22.md)) |

Runs 1–8 were played by the author in both roles on one machine. Runs 9 to 14 used two machines (the roles on different computers
with different Parano1d nodes), but all six were still played by the same person; runs 9 and 10 ended as aborts and runs 11 to 14
as settled swaps. Runs 15 to 20 were the hostile-counterparty campaign: one person played the misbehaving side as well, on one PC
in every role (in run 20 the second Parano1d node ran on a second machine); runs 15 to 17 ended on their abort paths as planned;
run 18 ended on its abort path after a reveal that came 110 seconds after its cutoff and was refused by the tool (retried as
run 19); runs 19 and 20 settled. **No swap between two separate people has run yet.**

**The desktop program, rehearsals 4.10 to 4.12 (19 to 20 November 2026, Sepolia).** The program on two machines, a Windows
installer of the hosted build as Alice and a Mac build as Bob, 5 NOID against 0.001 Sepolia ETH, one approval per machine. Every
send after the approvals was made by the programs: the funding, Bob's lock, the reveal, Bob's claim and the sweeps. All three
settled. Rehearsal 4.11 found that a short first ETH deposit was not flagged, which cost about 40 minutes; rehearsal 4.12 showed
the fix (the flag came 13 seconds after the block, and Bob's lock went out 55 seconds after his top-up). 4.12 took 49 minutes from
funding to Alice's side done. These rehearsals have no log in `docs/`.

> **Optional block: on-chain pointers.** Publishing them ties the handle "00" to the NOID wallet that funded
> the runs. Deleting these lines stops advertising the link but does not remove it: the recorded test fixtures
> in this repository carry the same addresses.
> - Parano1d contract root of run 3: `o10tc9l6d7a5dffsadlpddxuwsds5wlr8rqdhck99xl8668zws87wqzej993`
> - Sepolia HTLC: `0x489228d5b89EC1B2e441fc5FFF5517Cb79C6Ec48`, the reveal (claim) transaction `0x2f7b865c14754f62184058973ccda5b6b221bf4830a5c134284cc83e07ecb455` (the `Claimed` event carries the secret)

## Repository map

| Path | What | Tests |
|---|---|---|
| `desktop/` | The desktop program: one window on a private `no1d://app` scheme with no listening port, the secrets in the operating system's key store with a recovery code on paper, a notify-only update check that verifies the release key, a self-test, a start-up job | 623 (`node --test "desktop/test/*.test.js"`, against a fake shell; on Windows 620 pass and 3 skip); also run in real windows in rehearsals 4.10 to 4.12 |
| `ui/app/` | The operator console and the program's page: a read-only view, actions behind a gate (dry run, typed amount, latch, audit line), the autopilot, wallet runs, the offer board, program mode with the one-card-per-stage page and mainnet | 1780 (`node --test "ui/app/test/*.test.js"`; on Windows 1777 pass and 3 skip) |
| `swap-cli/` | The swap tool: persisted swap file with the secret sealed, state machine, Parano1d and Ethereum watchers, a fail-closed decision engine, the NOID claim client, a NOID wallet and an Ethereum key for each swap, profiles `production` / `rehearsal` / `sepolia` | 868 (+1 ignored); drove every run in the table |
| `eth/` | Hardhat project: `HTLC.sol` (ETH), `HTLCERC20.sol`, `HTLCPoseidon.sol` + `Poseidon2b.sol`, `scripts/live.js` (deploy, lock, claim, refund, sweep on a test network or, with `--mainnet` and a fee cap, on Ethereum), `scripts/secret.js` | 562 on Windows (2 pending: two symlink tests skip there); the Linux and macOS count was not re-taken |
| `parano1d/` | `contracts/htlc.pruv` (`HashTimeLock`), the v2 fixed-fee variant, example params (never fund them), a Rust harness that builds, proves and verifies real calls against the vendored node code | 37 (+1 ignored benchmark); `pruv verify` passes |
| `equiv/` | The equivalence proof: `portable/` (no_std Poseidon2b + Derive + SHA-256), `reference/` (parity with the vendored code, 100,000 inputs), `zkvm/` (RISC Zero guest and host, `equiv-prove`) | 23 + 3 + 14; receipts proved and verified |
| `btc/` | Bitcoin HTLC as P2WSH: script, address, claim and refund builders, a minimal script checker, a signet live layer over Esplora | 91; nothing broadcast on signet yet |
| `scripts/live/` | The versioned live-run shell helpers (setup, prepare, fund, tick, watch, lock, reveal, claim, refund, recover, wallet): one script per step, nothing sent without an explicit flag | self-test 780 cases (bash 5.2, no network) |
| `scripts/` | `setup.sh` / `setup.ps1` (build and test everything), `fetch-vendor.sh` | — |
| `docs/protocol-design.md` | The protocol: roles, ETH and BTC flows, timeout inequalities with worked examples, the equivalence proof, the lock contract, threat model, parameters, open questions | design v1, timeouts re-derived from measurements |
| `docs/parano1d-capabilities.md`, `docs/q2-history-step.md` | What Parano1d's ABI 3 contracts can do (source-verified, with the exact `Addr` definition and test vectors); whether the block proof forces a close to pay the committed recipient | done; the second confirmed |
| `docs/runbook-two-party.md`, `docs/review-packet.md` | How two people on two machines run a swap with the terminal tools; the starting point for an outside reviewer | written |
| `docs/review-1.md`, `docs/poseidon-evm-review.md`, `docs/poseidon-v2-review.md`, `swap-cli/REVIEW-1.md` to `-7.md` | Internal adversarial reviews of the design, the Poseidon2b Solidity port and the swap tool | done; see "Status" |
| `docs/miner-concentration.md`, `docs/bob-concentration-gate.md` | The mining-concentration limit: measurement, model, and Bob's screen | done |
| `docs/release-key.md`, `docs/building.md` | The release key and how a download is checked; the hosted build, what the installers are, how to build the tools yourself | written |
| `docs/live-run-1.md` to `-6.md`, `-8.md`, `-9-10.md`, `-11.md` to `-20.md`, `-22.md` | Logs of the runs in the table | done |
| `docs/hostile-run-plan.md`, `docs/live-scenarios.md` | The plan of the hostile-counterparty runs (groups L1 to L6 ran as runs 15 to 20) and the plan of the other live scenarios | done; what stays open is listed in them |
| `docs/htlc-v2-fixed-fee.md`, `docs/poseidon-evm.md`, `docs/ideas.md` | A fixed-fee contract variant, `Addr(s)` on the EVM (the other hashlock), ranked improvements | notes |
| `vendor/parano1d` | Unmodified copy of the Parano1d source at commit `d29b801` (Apache-2.0, see `THIRD-PARTY-NOTICES.md`) | read-only |
| `PROJECT.md`, `TASKS.md` | Project memory and backlog | — |

Each component's `README.md` is the source of truth for that component.

## Status and warnings

- **Caps.** 2,500 NOID and 0.5 ETH per swap on Ethereum mainnet; 20 NOID and 0.01 ETH on Sepolia and the rehearsal chain. The caps are
  enforced in the swap's settings file and again in the swap tool's profile. `eth/scripts/live.js` refuses Ethereum mainnet unless
  `--mainnet` is given with a fee cap and a swap file. Use amounts you can lose.
- **What opened on 2026-11-20, tested offline only.** Ethereum mainnet in the desktop program (version 0.1.5): the mainnet form,
  default fee cap 1 gwei, two public Ethereum endpoints, Bob's extra approval statement, the signed release notice; and the launch
  screens: addresses shown whole and read back after a copy, the rate, fees and worst-case times before the first click, a
  re-send of a stuck reveal or refund at a higher fee cap, Bob's late-claim alarm, the "Limits and risks" card, "needs you" entries
  in three parts, and the recording of a close made elsewhere. None of it has run on a network. The program's earlier steps ran on Sepolia (rehearsals 4.10 to 4.12), and the swap tool and its helpers ran on
  Ethereum mainnet once (run 8).
- **Still refused on mainnet:** the offer board, the terminal console, contract version 2, the stock-wallet variant and the
  SHA-256 lock.
- **No outside audit.** The reviews in this repository were adversarial but internal (`swap-cli/REVIEW-1.md` to `REVIEW-7.md`,
  `docs/review-1.md`, two reviews of the Poseidon2b port, and one independent read of each program piece, with the mainnet opening
  read and fixed once). The latest swap-tool review, `swap-cli/REVIEW-7.md`, lists what it wanted done before a stranger uses the
  tool. The strength of the hashlock is the preimage resistance of Parano1d's `Addr` (Poseidon2b), which no cryptographer has
  reviewed for this use. See `SECURITY.md`.
- **Hard rules** (details in `SECURITY.md`): never fund the example params; never use Parano1d's stock `refundable_payment`
  template for a swap; one fresh secret per swap, sealed, never on a command line; `max_fee` at least 5,800 μNOID; the NOID claim
  must be *final* before the deadline.
- **Still to run:** a swap between two separate people, the program on Ethereum mainnet, the abort paths on mainnet, the
  stock-wallet variant, contract version 2, a close at a chosen fee and a conflicting close, the Bitcoin leg on signet. The
  two-node check ran live in runs 12 and 20; the hostile-counterparty groups L1 to L6 ran as runs 15 to 20.
- Commit hashes quoted in the documents (review fix-status tables, `TASKS.md`) refer to the private development history and will
  not resolve in this repository.

## How to run the tests

Node parts (any OS, Node 21 or later; tested on 22):

```sh
cd eth && npm install && npx hardhat test      # 562 passing, 2 pending on Windows; solc falls back to the npm solc@0.8.24 package if the download is blocked
cd btc && npm install && npm test              # 91 passing (node --test)
node --test "ui/app/test/*.test.js"            # 1780 tests (the operator console and program mode)
node --test "desktop/test/*.test.js"           # 623 tests (the desktop program, against a fake shell)
```

Rust parts (Linux or WSL2; the vendored code pins Rust 1.96.0 in `vendor/parano1d/rust-toolchain.toml`):

```sh
cd parano1d/harness && cargo test                                   # 37 tests (+1 ignored), ~2 min first build
cd equiv && cargo test --release                                     # 23 tests; EQUIV_PARITY_N=100000 for the big parity run
cd equiv/zkvm && cargo test -p equiv-guest-core                      # 3 tests; proving needs rzup, see equiv/README.md
cd equiv/zkvm && EQUIV_RECEIPT_DIR=~/zkvm-out cargo test --release -p equiv-host   # 14 host tests on real receipts
cd swap-cli && cargo test --offline                                  # 868 tests (+1 ignored)
# the Pruv contract, from the vendor workspace:
cargo run -p noid_pruv --manifest-path vendor/parano1d/Cargo.toml -- \
  check parano1d/contracts/htlc.pruv --params parano1d/contracts/htlc.params.example.json
```

`scripts/setup.sh` (Linux/WSL) runs everything except the zkVM proof; `scripts/setup.ps1` runs the Node parts.
`CARGO_TARGET_DIR=$PWD/target` shares one build cache across the three Rust workspaces. The shell helpers have their own self-test:
`bash scripts/live/selftest.sh` (780 cases). To run a swap with the terminal tools, read `docs/runbook-two-party.md` first, then
`swap-cli/README.md`.

## Reading order

1. [`docs/protocol-design.md`](docs/protocol-design.md), sections 1 to 4, for the protocol and the timeouts.
2. [`docs/miner-concentration.md`](docs/miner-concentration.md) for the limit that matters most to an ETH seller.
3. [`docs/review-1.md`](docs/review-1.md), [`swap-cli/REVIEW-2.md`](swap-cli/REVIEW-2.md) and
   [`swap-cli/REVIEW-3.md`](swap-cli/REVIEW-3.md) for what can go wrong and what was fixed.
4. [`docs/live-run-3.md`](docs/live-run-3.md) or [`docs/live-run-8.md`](docs/live-run-8.md) (mainnet) for a real run, minute by minute.
5. [`ui/app/README.md`](ui/app/README.md) ("Simpler swaps", "Mainnet in program mode") and [`desktop/README.md`](desktop/README.md)
   for the program.

## License and reporting

MIT (`LICENSE`), copyright 2026 "00". The vendored Parano1d source is Apache-2.0 and keeps its `LICENSE` and `NOTICE`;
`THIRD-PARTY-NOTICES.md` lists what derives from it. Problems and security reports: `SECURITY.md`.
