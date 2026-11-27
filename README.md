# noid-swap

Atomic swaps between **Parano1d (NOID)** and **Ethereum or Bitcoin**, with a hash-time-locked contract
on each chain and nothing in between: no bridge, no custodian, no multisig, no wrapped token. Either both
sides settle or both sides get their own coins back after a deadline, provided each party stays online and
acts before its own deadline: a party that goes offline after the reveal can lose its side (design §8). The design, four component
prototypes, a command-line swap tool and the logs of twelve real runs (numbered 1 to 13; there is no run 7 log), one of them on Ethereum mainnet, are in this repository.

> **Known limit: concentrated mining on Parano1d.** One address has mined between 45 % and 63 % of every day's blocks for the last 20 days
> (52.7 % of the last 24 hours, read from a node's own block headers on 2026-11-08). The swap assumes that no party holds a majority of the hashrate,
> and that assumption is false today. Above half of the hashrate a longer window between the reveal and the deadline does not help: a miner who is
> Alice can keep Bob's NOID claim from becoming final until the deadline and take both legs, and the victim is Bob, the Ethereum side. At a 53 %
> share and the production window the model gives about 55 % from a clean start and about 90 % or more for a prepared attacker. A smaller miner is limited
> by the window and by how quickly Bob re-sends his claim after a reorg (an operator who re-sends by hand needs minutes). The `production` profile now
> refuses to offer Bob's lock while one address produced more than 35 % of the recent blocks (it is a screen, not a defence: it does not see an
> operator on several addresses, a pool, or a share that grows after the lock). Swaps in which Bob locks ETH against an Alice he does not know are
> still not recommended, and amounts stay tiny.
> Model and measurement: [`docs/miner-concentration.md`](docs/miner-concentration.md); the gate: [`docs/bob-concentration-gate.md`](docs/bob-concentration-gate.md).

## Why Parano1d makes this cheap, and why it decides who goes first

Two words first. A **hashlock** is a lock that opens for whoever shows a secret `s` whose hash `H` is
written on the lock. A **timelock** is a deadline after which the coins go back to whoever put them in.
An atomic swap puts one lock with the same `H` on each chain; one party takes the other's coins by
showing `s` (the **reveal**), and the other party reuses the now-public `s` to take theirs.

Parano1d has no signatures. A wallet spends by giving a zero-knowledge proof that it knows a 256-bit
secret whose hash is its address (`A = Addr(s)`). So a Parano1d contract whose claim authority is
`Addr(s)` *is already a hashlock*, with no extra opcode: the lock on the NOID side costs nothing beyond
a normal contract (`parano1d/contracts/htlc.pruv` compiles to 1 of 16 instructions).

The same fact fixes the order of play. A Parano1d claim never shows `s` (it is a proof, not a
preimage), so the NOID side can never be the reveal side. The NOID holder must create the secret and
lock first, with the longer deadline; the ETH or BTC holder locks second, with the shorter one; the
reveal always happens on Ethereum or Bitcoin, and the NOID holder's counterparty claims the NOID last
with the secret he read there. Before locking, that counterparty also checks an off-chain
zero-knowledge receipt that one and the same `s` is behind the Ethereum hashlock (`SHA-256(s)`) and
the Parano1d address (`Addr(s)`), otherwise the NOID lock could be a decoy. Full design:
[`docs/protocol-design.md`](docs/protocol-design.md).

## What it is not

Not a bridge, no wrapped NOID, nobody holds anybody's coins. Pairwise trades only: NOID against ETH (the only pair the swap tool runs today),
or, by design, against BTC. An ERC-20 contract exists (`eth/contracts/HTLCERC20.sol`) but the tool does not support it: a token that can block or fail a payout would publish the secret without paying, so an ERC-20 swap would need a vetted token list first. The counterparty's
chain needs nothing more than a hashlock and a timelock, which is why the same design covers Ethereum
(`HTLC.sol`) and Bitcoin (a P2WSH script, `btc/`). Not a market: the two parties find each other and
agree on a price elsewhere.

## Proof that it works: twelve runs on 4–6 November 2026 (UTC)

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

Runs 1–8 were played by the author in both roles on one machine. Runs 9 to 13 used two machines (the roles on different computers with
different Parano1d nodes), but all five were still played by the same person; runs 9 and 10 ended as aborts and runs 11 to 13 as settled swaps.
No swap between two separate people has run yet. The amounts are trial amounts.

> **Optional block: on-chain pointers.** Publishing them ties the handle "00" to the NOID wallet that funded
> the runs. Deleting these lines stops advertising the link but does not remove it: the recorded test fixtures
> in this repository carry the same addresses.
> - Parano1d contract root of run 3: `o10tc9l6d7a5dffsadlpddxuwsds5wlr8rqdhck99xl8668zws87wqzej993`
> - Sepolia HTLC: `0x489228d5b89EC1B2e441fc5FFF5517Cb79C6Ec48`, the reveal (claim) transaction `0x2f7b865c14754f62184058973ccda5b6b221bf4830a5c134284cc83e07ecb455` (the `Claimed` event carries the secret)

## Repository map

| Path | What | State |
|---|---|---|
| `docs/protocol-design.md` | The protocol: roles, ETH and BTC flows, timeout inequalities with worked examples, the equivalence proof, the lock contract, threat model, parameters, open questions | design v1, timeouts re-derived from measurements |
| `docs/parano1d-capabilities.md` | Source-verified report on what Parano1d's ABI 3 contracts can do; the exact `Addr` definition; test vectors | done |
| `docs/runbook-two-party.md` | How two people on two machines run a swap with today's tools | written, untested between two people |
| `docs/review-packet.md` | The starting point for an external reviewer: the four questions that matter most, what is promised, the assumptions with their status, what was run, what is still open | written for review |
| `docs/review-1.md`, `docs/poseidon-evm-review.md`, `docs/poseidon-v2-review.md`, `swap-cli/REVIEW-1.md` to `-7.md` | Internal adversarial reviews of the design, the Poseidon2b Solidity port and the swap tool | done; see "Status" |
| `docs/q2-history-step.md` | Does Parano1d's block proof force a close to pay the committed recipient? Constraint path with citations and a negative test | confirmed |
| `docs/live-run-1.md` to `-6.md`, `-8.md`, `-9-10.md`, `-11.md`, `-12.md`, `-13.md` | Logs of the twelve runs (there is no run 7 log: it was prepared and never funded; runs 9 and 10 share one log) | done |
| `docs/htlc-v2-fixed-fee.md`, `docs/poseidon-evm.md`, `docs/ideas.md` | A fixed-fee contract variant, `Addr(s)` on the EVM (an alternative hashlock), ranked improvements | notes |
| `eth/` | Hardhat project: `HTLC.sol` (ETH), `HTLCERC20.sol`, `HTLCPoseidon.sol` + `Poseidon2b.sol`, `scripts/live.js` (deploy / lock / claim / refund on Sepolia or a local chain), `scripts/secret.js` | 383 tests (385 on Linux and macOS, where two symlink tests run that skip on Windows) |
| `btc/` | Bitcoin HTLC as P2WSH: script, address, claim and refund transaction builders, a minimal script checker, a signet live layer over Esplora | 91 tests; nothing broadcast on signet yet |
| `parano1d/` | `contracts/htlc.pruv` (`HashTimeLock`), the v2 fixed-fee variant, example params (never fund them), a Rust harness that builds, proves and verifies real calls against the vendored node code | 37 tests (+1 ignored benchmark), `pruv verify` passes |
| `equiv/` | The equivalence proof: `portable/` (no_std Poseidon2b + Derive + SHA-256, the zkVM guest code), `reference/` (parity against the vendored code, 100,000 inputs), `zkvm/` (RISC Zero guest and host, `equiv-prove`) | 23 + 3 + 14 tests; receipts proved and verified |
| `swap-cli/` | The swap tool: persisted swap file with the secret sealed, state machine, Parano1d and Ethereum watchers, a fail-closed decision engine, the NOID claim client, profiles `production` / `rehearsal` / `sepolia` | 648 tests; drove every run |
| `scripts/live/` | The versioned live-run helpers (setup, prepare, fund, tick, watch, lock, reveal, claim, refund, recover): one script per step, nothing sent without an explicit flag | drove runs 4 to 6, 8, 9 and 10 (on a Mac in native mode for Bob's side in 9 and 10) |
| `scripts/` | `setup.sh` / `setup.ps1` (build and test everything), `fetch-vendor.sh` | — |
| `ui/` | A private prototype | not part of this repository |
| `vendor/parano1d` | Unmodified copy of the Parano1d source at commit `d29b801` (Apache-2.0, see `THIRD-PARTY-NOTICES.md`) | read-only |
| `PROJECT.md`, `TASKS.md` | Project memory and backlog | — |

Each component's `README.md` is the source of truth for that component.

## Status and warnings

- **Trial amounts only.** The tool caps swaps at 20 NOID / 0.01 ETH under the `rehearsal` and `sepolia` profiles; the `production` profile has no cap, so the limit there is discipline.
  `eth/scripts/live.js` refuses Ethereum mainnet unless `--mainnet` is given (with a fee cap and `--swap FILE`); run 8 ran on mainnet under
  `production`. Use amounts you can lose.
- **No external audit.** The reviews in this repository were adversarial but internal (`swap-cli/REVIEW-1.md` to `REVIEW-7.md`, `docs/review-1.md`,
  two reviews of the Poseidon2b port). The latest, `swap-cli/REVIEW-7.md`, finds nothing that blocks the owner in both roles on Sepolia or at trial amounts on
  mainnet, and lists what must be done before a stranger uses the tool (`SECURITY.md`). The security of the hashlock is the preimage resistance of Parano1d's `Addr`
  (Poseidon2b), which no cryptographer has reviewed for this use.
- **Hard rules** (details in `SECURITY.md`): never fund the example params; never use Parano1d's stock
  `refundable_payment` template for a swap; one fresh secret per swap, sealed, never on a command line;
  `max_fee` at least 5,800 μNOID; the NOID claim must be *final* before the deadline.
- **Still to run**: the stock-wallet variant, two separate people (the two-node check has run live, in run 12, but with both nodes of each kind on one private network),
  the Bitcoin leg on signet, an epoch rotation inside a swap window.
- Commit hashes quoted in the documents (review fix-status tables, `TASKS.md`) refer to the private
  development history and will not resolve in this repository.

## How to run the tests

Node parts (any OS, Node 21 or later; tested on 22):

```sh
cd eth && npm install && npx hardhat test      # 383 passing on Windows (385 on Linux and macOS: two symlink tests skip on Windows); solc falls back to the npm solc@0.8.24 package if the download is blocked
cd btc && npm install && npm test              # 91 passing (node --test)
```

Rust parts (Linux or WSL2; the vendored code pins Rust 1.96.0 in `vendor/parano1d/rust-toolchain.toml`):

```sh
cd parano1d/harness && cargo test                                   # 37 tests (+1 ignored), ~2 min first build
cd equiv && cargo test --release                                     # 23 tests; EQUIV_PARITY_N=100000 for the big parity run
cd equiv/zkvm && cargo test -p equiv-guest-core                      # 3 tests; proving needs rzup, see equiv/README.md
cd equiv/zkvm && EQUIV_RECEIPT_DIR=~/zkvm-out cargo test --release -p equiv-host   # 14 host tests on real receipts
cd swap-cli && cargo test                                            # the swap tool
# the Pruv contract, from the vendor workspace:
cargo run -p noid_pruv --manifest-path vendor/parano1d/Cargo.toml -- \
  check parano1d/contracts/htlc.pruv --params parano1d/contracts/htlc.params.example.json
```

`scripts/setup.sh` (Linux/WSL) runs everything except the zkVM proof; `scripts/setup.ps1` runs the
Node parts. `CARGO_TARGET_DIR=$PWD/target` shares one build cache across the three Rust workspaces.
To run a swap for real, read `docs/runbook-two-party.md` first, then `swap-cli/README.md`.

## Reading order

1. [`docs/protocol-design.md`](docs/protocol-design.md), sections 1 to 4, for the protocol and the timeouts.
2. [`docs/runbook-two-party.md`](docs/runbook-two-party.md) for what a swap looks like with the tools.
3. [`docs/review-1.md`](docs/review-1.md), [`swap-cli/REVIEW-2.md`](swap-cli/REVIEW-2.md) and
   [`swap-cli/REVIEW-3.md`](swap-cli/REVIEW-3.md) for what can go wrong and what was fixed.
4. [`docs/live-run-3.md`](docs/live-run-3.md) or [`docs/live-run-8.md`](docs/live-run-8.md) (mainnet) for a real run, minute by minute.

## License and reporting

MIT (`LICENSE`), copyright 2026 "00". The vendored Parano1d source is Apache-2.0 and keeps its
`LICENSE` and `NOTICE`; `THIRD-PARTY-NOTICES.md` lists what derives from it. Problems: `SECURITY.md`.
