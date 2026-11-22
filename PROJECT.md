# noid-swap — project notes

## Project

Bridge-free atomic swaps between Parano1d (native token NOID) and Ethereum / Bitcoin, using
hash-time-locked contracts (HTLCs) on both sides. No bridge, no multisig, no wrapped token: either
both legs settle or both refund. Why it is interesting: Parano1d has no signatures — every spend is
a zero-knowledge proof of knowledge of a 256-bit secret whose hash is the address — so the
*hashlock is free*: a contract whose claim authority is `Addr(s)` is already a hash-preimage lock.
The twist: a Parano1d claim never reveals the secret (it is a ZK proof), so Parano1d can never be the
"reveal" leg. The NOID holder must always generate the secret, and the reveal always happens on
Ethereum or Bitcoin. That one fact shapes the whole protocol.

Status (2026-11-04): research, design, review and four component prototypes are done and tested
offline; M0 is complete (harness 26 tests, `P_auth` measured), M1.2–M1.4 are done (real zkVM receipts,
100k-input parity, automated negative checks), and Q2 is CONFIRMED by source reading
(`docs/q2-history-step.md`). Baseline committed on `main`. **2026-11-04: the first real swap settled** (10 NOID on mainnet ↔ 0.001 ETH on a local
Hardhat chain, raw variant, `swap-cli` driving both roles, receipt verified; `docs/live-run-1.md`). The abort path settled the same
day (run 2, `docs/live-run-2.md`) and the first swap against **public Sepolia** the same day (run 3, `sepolia` profile,
`docs/live-run-3.md`). **2026-11-06: the first swap against Ethereum mainnet settled** (run 8: 5 NOID ↔ 0.001 ETH, proof-free `poseidon` lock, `production` profile, 54 minutes, `docs/live-run-8.md`). **2026-11-06: the first two-machine runs** (Alice on a Windows PC, Bob on an Apple Silicon Mac with the helpers in native mode) ended on their abort paths, both clean: run 9 stopped before any lock after the contract was funded three times by mistake (all three instances recovered at `D`), run 10 stopped after Bob's lock because Alice's reveal was not sent before its cutoff (Bob refunded, Alice recovered; `docs/live-run-9-10.md`). **2026-11-06: the first complete swap across two machines settled** (run 11, the retry: 5 NOID ↔ 0.001 Sepolia ETH, `poseidon`, 44 minutes, Bob's claim sent from the Mac; `docs/live-run-11.md`). **2026-11-06: the two-node check ran live** (run 12, the same two-machine swap with two Parano1d nodes and two Sepolia endpoints per side, joined by one SSH tunnel; 45 minutes, settled; `docs/live-run-12.md`). **2026-11-06: the first swap with Alice's steps driven from the operator console settled** (run 13: the same two-machine swap, one node per chain, funding and reveal each started from the console behind a dry run and a typed amount, Bob's side from a terminal; 50 minutes; nine low findings, `docs/live-run-13.md`). **2026-11-08: the finality depth was corrected from 17 to 18** (the chain's `is_final` is tip >= height + 18; the tool and the docs counted 17): `B_final` 19, Bob's claim target `D − 19`, production `B_safety` 31, `B_post` 254, `D_offset` 738 (`docs/protocol-design.md` §9.1). **2026-11-09: run 14, the first run with the finality-18 code, settled** (the run-13 setting, two machines, 5 NOID ↔ 0.001 Sepolia ETH, `poseidon`, `sepolia` profile; 51 minutes 49 seconds from funding to Alice's side final; funding and Bob's claim each final 18 blocks after their inclusion; the reveal sidecar was written 0.43 s before the broadcast on the real Windows-to-WSL path and read by the next tick (T21-15 closed); the producer screen warned and did not refuse; the public Sepolia endpoint had pruned its old logs, so every run needs a recent log start; `docs/live-run-14.md`). Still to run (M2.7): the stock variant, the rotation and conflicting-close cases, a hostile counterparty (groups L1 to L6 are now runs 15 to 20). See `TASKS.md`. **Known limit (2026-11-08):** one address on Parano1d has mined between 45 % and 63 % of every day's blocks for 20 days, and above half of the hashrate no window length protects Bob (the Ethereum side) from a miner who is Alice; swaps in which Bob locks ETH against an unknown Alice are not recommended, and amounts stay tiny; a Bob-side screen is built (a screen, not a defence: it refuses to lock in the production profile above 35 % of recent blocks, and cannot see a hidden or new producer) (`docs/miner-concentration.md`, `docs/bob-concentration-gate.md`).
**2026-11-05: public release prepared** (license, third-party notices, landing README, SECURITY.md); the first public copy is one
commit of this tree without the `ui/` prototype.

## Who / how to work here

- Owner: 00 (anonymous by design; never put a name, place, language or timezone in the repository).
  Writing style: short, bottom line first. Explain any cryptographic concept in plain words the first
  time it comes up (what a hashlock is, why a timeout exists, what "reveal" means).
- Have anything load-bearing reviewed independently before it is relied on.
- Never touch mainnet funds, broadcast a transaction, fund an address, or run a node that mines
  without an explicit go-ahead from the owner in the same session. Testnets / signet / tiny amounts
  only until milestone M4 (external review) is done.
- Hard safety rules (do not relax):
  1. Never fund `parano1d/contracts/htlc.params.example.json` — its hashlock secret is the public
     test vector `00 01 … 1f`.
  2. Never use Parano1d's `refundable_payment` template for a swap: it sets recipient = authority,
     so once the secret is public anyone can take the funds. Only the custom `HashTimeLock` with
     `claim_recipient` pinned to Bob is safe.
  3. Fresh 32-byte secret from an OS CSPRNG per swap. The stock-wallet variant reveals a whole
     wallet master secret on claim — throwaway wallet per swap, never fund its other addresses.
  4. No swap window may straddle Parano1d height 279,370 (v2.1 activation, ≈ 2026-11-04 04:00 UTC):
     the owner-authorization proof version switches there and pending calls are evicted.
  5. `max_fee` must be ≥ 5,800 μNOID or both claim and refund are locked forever.
- Never modify `vendor/`. If a patch is ever unavoidable, put a `.patch` in `parano1d/patches/` and
  explain it in `parano1d/README.md`.

## Parano1d in 12 bullets (verified against source, commit d29b801, 2026-10-30)

- Signatureless: a wallet authorizes by a ZK proof of knowledge of a 256-bit secret `s`, bound to the
  transaction. No public key, no signature on the wire. Address `A = Addr(s)` = one Poseidon2b
  permutation over GF(2^128) with the `ADDRFIX_` IV, lanes 0–1 output (32 bytes, shown as bech32m
  `o1…`, HRP `o`). Not SHA-256.
- ABI 3 contracts ("proof-native contracts", written in Pruv): 16 program slots, 10 opcodes
  (keep, move, add, subtract, min, max, less_than, equal, assert_equal, assert_less_or_equal),
  two persistent u64 state registers, two scratch registers, checked arithmetic, no loops, no
  cross-contract calls, **no hash opcode, no caller-supplied arguments**.
- Programs can read the inclusion block height. One committed `deadline` per contract switches the
  active party: `h < deadline` → claim branch, `h ≥ deadline` → recovery branch.
- `claim_authority`, `recovery_authority`, `claim_recipient`, `recovery_recipient`, `deadline`,
  `max_fee` and the mode bits are committed at creation (699-byte opening). The opening is not
  recoverable from chain after it leaves the mempool — both parties keep it.
- A terminal close must pay `outputs[0].owner == recipient_at(height)`. Enforced in Rust admission
  (`check_call`) AND inside the block proof circuit (HistoryStep; component-tested in review-1). So
  learning `s` lets you close *to Bob* early (burning ≤ `max_fee`), never redirect the funds.
- Custody is NOID only. Native tokens/NFTs cannot be held by these contracts.
- Mempool is strict first-seen per input slot, no replace-by-fee. A pending call is evicted if its
  branch would flip at the next height. Every authorization is bound to a 144-block epoch anchor
  and must be re-proved after a rotation.
- Finality 18 blocks after inclusion (`is_final`: tip ≥ height + 18, vendored `consensus/header.rs`; the upstream documents' "17 blocks of rollback" is the same rule from the other side and must not size a margin; the docs and the tool counted 17 until 2026-11-08). Target block interval 30 s (ASERT); plan with 20 s fast.
- Close fee ≥ 5,800 μNOID (formula `5000 + 100·in + 700·out + growth`), paid from the contract
  balance, capped by `max_fee`; local relay floor can rise under load.
- Stock wallet only authorizes for `Addr(Derive(m, active_index))` (Derive = 3 extra permutations);
  `parano1d --import-wallet-secret` replaces the wallet in a data dir. A custom Rust client using
  `noid_gkr` can authorize with a raw `s`.
- v2.1 (tokens, bonding curves, DEX, NFT market as native templates) activates at height 279,370;
  owner-authorization version V3 → V4 at the same height.
- Block bodies are pruned after 42 blocks; contract receipts stay verifiable; receipts do not prove
  current unspentness.

## Repository map

| Path | What | Status |
|---|---|---|
| `docs/parano1d-capabilities.md` | Source-verified report on what ABI 3 contracts can do; exact `Addr` definition; test vectors | Done; the eight review-1 corrections were applied 2026-11-04 |
| `docs/protocol-design.md` | Protocol design v1: roles, ETH and BTC flows with Mermaid diagrams, timeout inequalities with worked examples, equivalence proof, lock contract, claim tooling, threat model, parameters, open questions Q1–Q15, milestones M0–M4 | Done, nothing measured yet |
| `docs/review-1.md` | Independent adversarial review of the report + harness: 10 claims CONFIRMED, 0 refuted, citation fixes, additional risks | Done; "Applied 2026-11-04" note at the end |
| `docs/q2-history-step.md` | Q2 finding: does the block proof force a close to pay the committed recipient? Constraint path with citations, Rust-only checks, negative-test spec N1/N2 | CONFIRMED by source reading and by the component test N2 (2 passed, forged openings rejected by the side-proof verifier; test kept as `parano1d/patches/q2-n2-tests.patch`); N1 full-block and N3 devnet not run |
| `eth/` | Hardhat project. `contracts/HTLC.sol` (ETH) and `HTLCERC20.sol`; `scripts/secret.js`; `test/HTLC.test.js` | **306 passing** tests (HTLC, `live.js` incl. the mainnet gate, and the fuzz campaign at its default size; `FUZZ_N=2000` for the full one). solc falls back to the npm `solc@0.8.24` package if the binary download is blocked |
| `parano1d/` | `contracts/htlc.pruv` (HashTimeLock), `htlc.params.example.json`, `htlc.definition.json` (pruv build output); `harness/` Rust crate with path deps on vendor | Compiles to **1/16 instructions**; `pruv verify` passed (1 postcondition, z3 from the `z3-solver` wheel); harness **37/37 passing** (9 of them for `htlc_v2.pruv`, the fixed-fee v2) with real `noid_gkr` proofs (stock-wallet path, V3/V4 + cross-version rejection, verifier-side rejection of tampered/replayed proofs, `check_swap_params` guard) plus an ignored `P_auth` benchmark |
| `btc/` | Node library: `src/htlc.js` (P2WSH script, address, claim/refund tx builders), `src/verify.js` (minimal script checker + `extractPreimage`), `src/secret.js`, `scripts/demo.js` | **91 passing** `node:test` tests; cross-checked against the eth hashlock encoding; `scripts/live.js` signet live layer over the Esplora REST API (2026-11-04, nothing broadcast yet; script aligned with design §3.1: `OP_SIZE 32`, RBF refund) |
| `equiv/` | Equivalence-proof groundwork: `portable/` (no_std, zero-dep Poseidon2b + Derive + SHA-256, the future zkVM guest code), `reference/` (`equiv-ref` CLI + vendor parity tests), `zkvm/` (RISC Zero guest/host, separate workspace) | **23 passing** (portable + parity; 100,000-input release run: 0 mismatches) + 3 in `zkvm/core` + 14 host tests (remote-prover refusal, 138 negative cases on the real receipts). Raw and stock receipts proved and verified 2026-11-03 in WSL (ImageID `7e9d8477…6187`, local build; the reproducible docker ImageID of M1.1 needs Docker) |
| `swap-cli/` | Rust swap tool (M2.3–M2.6 + live layer): persisted swap file with the secret sealed, state machine, Parano1d/ETH watchers (fixtures recorded from the real node where possible), engine with the §4/§9.1 gates, Bob's clients R (`noid_gkr` + `submitTxIntent`) and S (scripted), `tick`/`claim`/`alice-params`/`secret`/`intent`/`gates` commands, transports `tcp` and `curl` (WSL reaches Windows only through `curl.exe`; `curl` also does https), profiles `--profile production|rehearsal|sepolia` (rehearsal: 1-hour windows, chain 31337; sepolia: `D = +302`, chain 11155111; both capped at 20 NOID / 0.01 ETH), contract versions 1/2 (v2 fee rule `max(50,000, 5 × floor_seen)`), reorg handling after inclusion, `tick --closed-by`, leftover-leg refunds, every lock/instance reported; header-time and second-node checks (F5); `REVIEW-1.md` and `REVIEW-2.md` reviews (all 14 REVIEW-2 findings fixed in code 2026-11-04; `REVIEW-3.md` (2026-11-05) re-checked them: 7 closed, 7 partial, 4 new; its seven must-fix items were fixed the same day: read-only `tick` withholds spend parameters, fail-closed `intent --cancel`, `live.js --swap FILE`, no reveal with two fitting instances, compiled-in HTLC code hash and image id, receipt-only attestation outside rehearsal, cleared child environment, dev-mode receipts refused by `equiv-prove`, unknown header time blocks, two distinct nodes under sepolia, secret also from `getLock`, stored `--eth-from-block`; next gate: a live run with the new gates, then a fresh review; M2.5b 2026-11-05: Bob's ETH refund is final before `refunded` (`refund_mined`, reorg back to `locked`), Alice's lost reveal gets a truthful state and a terminal `lost` phase; exec transport retries the spawn on `ETXTBSY`; 2026-11-05 chaos-test fixes: `CHAOS.md` F-1, F-3, F-4, F-5, F-9, F-12, F-13, F-15, F-16 fixed, the `DE`/`RA` validator checks and the production `B_safety` 30 (`D_offset` 735) from the formal model (31 and 738 since the finality correction of 2026-11-08); `REVIEW-4.md` 2026-11-05: the Rust-side findings fixed (a cancelled `lock_eth` keeps its `T_reveal` or aborts, `lost` needs the second node, Bob raises an alarm on a lagging Ethereum node and reads the secret from either node, a held intent refuses a second ledger spend; see the README section "What REVIEW-4 changed"); production swap files made before `B_safety` 30 no longer load, by design) | **625 passing** + 37 harness; real node recordings of a funded lock, pending and final close; first live swap settled 2026-11-04 (`docs/live-run-1.md`) |
| `scripts/live/` | Versioned live-run helpers (WSL): `install.sh`, `setup.sh`, `prepare.sh` (files + proof + definition), `check-object.sh`, `tick.sh`, `watch.sh` (`tick --apply` loop, stops on a terminal phase), `lock.sh` / `reveal.sh` / `refund-eth.sh` (`live.js --swap` through the `\wsl.localhost` path), `claim.sh`; adapted to the REVIEW-3 flags; none sends without `--submit` or a missing `--dry-run` | Checked read-only 2026-11-05 against the run-3 files; replaces the `live3-*.sh` scripts of WSL home |
| `vendor/parano1d` | Shallow clone of ignotusnemo/parano1d at `d29b801` (its own `.git` is present; remove it or make it a submodule before committing this repo) | Read-only |
| `target/` | Shared cargo target dir used in the sandbox (`CARGO_TARGET_DIR`); not shipped | — |

## Key decisions

1. **Roles.** Alice = NOID holder = generates `s`, locks first with the longer timeout. Bob = ETH/BTC
   holder, locks second, shorter timeout. Parano1d is always the second-claim leg, because a Parano1d
   claim never reveals `s`. A BTC/ETH holder who wants NOID must have the NOID holder make the secret.
2. **Lock = custom Pruv `HashTimeLock`** (`parano1d/contracts/htlc.pruv`): `claim_authority = Addr(s)`,
   `claim_recipient = Bob`, `recovery_authority = recovery_recipient = Alice`, `deadline_height = D`,
   close-only modes, `unrestricted_payout_recipient = false`. Bob rebuilds the opening himself and
   requires a byte-for-byte match before locking.
3. **Equivalence proof π** (Bob must see, before locking, that `sha256(s) = H` and `Addr(s) = A` share
   one `s`): RISC Zero zkVM running the portable Rust, proved locally only. Reason: the proof must be
   zero-knowledge of a *live* secret; SP1's default (non-wrapped) proofs are not documented as ZK.
   Journal = 65 bytes `variant(1) ‖ H(32) ‖ A(32)`; image ID pinned and checked separately.
4. **Raw-secret variant preferred** (`A = Addr(s)`, Bob claims with a small Rust client built on
   `noid_gkr` + `noid_tx` + `submitTxIntent`). **Stock-wallet variant as fallback** (`A = Addr(Derive(m,0))`,
   Bob claims via `--import-wallet-secret` into a throwaway data dir). Both variants are implemented in
   `equiv/`.
5. **Bitcoin script**: `OP_IF OP_SIZE 32 OP_EQUALVERIFY OP_SHA256 <H> OP_EQUALVERIFY <alicePub> OP_ELSE <T_b> OP_CLTV OP_DROP <bobPub>
   OP_ENDIF OP_CHECKSIG` as P2WSH. Alice's key in the hash branch (she receives BTC and reveals `s` in
   the witness); Bob's key in the CLTV refund branch. Locktime by block height. Taproot variant is M3 stretch.
6. **v1 timeouts** (design §4.3–4.5 and §9.1, re-derived 2026-11-04 after M0.5; M2 measurements may move
   them again): ETH — Alice's reveal window `W_A` = 7,200 s, Parano1d
   `D = creation + 738` blocks (~6 h), Bob's lock-by = `D − 631`; BTC — 24-block lock, `D = creation + 2,050`
   blocks (~17 h), Bob's lock-by = `D − 1,873`. `P_auth` budget 20 s (×2) = 3 × the worst measured p99.
   Budget after reveal `B_post = 144 (epoch) + 60 (fee floor) + 19 (finality 18 + the inclusion block) + 31 (slack; was 20, then 30, until the 2026-11-08 finality correction) = 254` blocks.
   Bob's claim must be *final* before `D` (target inclusion ≤ `D − 19`).
7. **Fee cap** `max_fee = max(50,000 μNOID, 3 × estimateFeeDetailed(1,1))`, ≤ 1 % of the amount.
8. **Trial window**: start only at Parano1d height ≥ 279,388 (activation + 18).

## Top risks and open questions (design §8–§9.2, review-1)

- Consensus enforcement of the recipient rule: CONFIRMED end-to-end by source reading
  (`docs/q2-history-step.md`) and by component tests (review-1 honest-opening case; N2 forged-opening
  cases, 2026-11-04). Not a full block proof; the frozen v2.1 matrices are unchecked against `d29b801` (Q7).
- Bob's claim can be stalled: first-seen mempool with no fee bumping means Alice (or anyone holding
  `s`) can broadcast a minimum-fee close that still pays Bob but cannot be outbid; under congestion it
  may sit until eviction at the deadline, after which Alice refunds (Q1). Budgeted as one epoch; needs
  the Q1 experiment.
- Poseidon2b preimage margin (Q8). The hashlock's security *is* `Addr`'s preimage resistance. The constants are small
  (round constants and full-round MDS entries ≤ 0x7; partial-round MDS diagonal 0x20, 0x2000, 0x200, 0x800 and 1
  elsewhere; all in a subfield), and they are the designers' own: the round constants (4 × 66), the full-round matrix
  and the partial-round matrix in `vendor/parano1d/noid_poseidon2b/src/native/permutation.rs` are identical to the
  designers' reference code (`https://github.com/Poseidon-Hash/Poseidon2b` at commit `7072a94`, file
  `binius_poseidon2b/crates/circuits/src/hades/poseidon2b_x7_128_512.rs`; compared as text on 2026-11-09, and the round
  schedule reads the same: 8 full and 58 partial rounds, `x^7`); the vendored file's header says it is adapted from
  that reference. So the instance is the designers' reference instance (IACR ePrint 2025/1893, first version 2025/058),
  and the margin rests on the designers' analysis and on public cryptanalysis, still to be read here: ePrint 2026/306
  and 2026/1792 (the upstream author's public reply to 2026/306, his own assessment:
  `https://ethresear.ch/t/poseidon2b-is-secure/25865`). **Not done:** the two implementations were not run on the same
  inputs, the papers were not read in full, and a cryptographer's review (M4.1) is still needed before amounts leave
  trial size.
- zkVM: zero-knowledge and soundness rest on RISC Zero's own documentation, not an audit; default
  parameters are 98-bit conjectured (Q3, Q11).
- `P_auth` measured on the owner's 3 GB WSL VM (M0.5): p50 1.5 s, worst p99 6.0 s, V3 = V4, raw = stock;
  budget 20 s. Re-measure on the real counterparty's hardware before M2 (Q4).
- Mainnet relay-floor behaviour under load is unknown (Q6). An isolated devnet needs a proof bank
  (matrix pack) that is not in the repo (Q7).
- The harness now shows the *verifier* rejecting tampered, replayed and cross-version proofs (M0.4);
  a proof built without the secret cannot be constructed with the public API, so soundness against a
  malicious prover is still assumed.
- A claim included at `D−1` and reorged out (while fewer than 18 blocks are on top of it) becomes invalid; treat a claim as safe only
  when final.
- Ethereum: a receiver contract that rejects ETH makes `claim` revert and funds stay locked until refund
  (EOAs only in v1). Bitcoin: the claim branch never expires, so Bob's safety window runs to when his
  refund is buried, not to `T_b`.
- General HTLC "free option": Bob can watch prices before locking. Mitigate with short `W_A`.
- **Concentrated hashrate on Parano1d (T21, measured 2026-11-08, open).** One address has mined between 45 % and 63 % of every day's blocks for
  20 days (52.7 % of the last 24 hours), read from the node's own block headers. Above half of the hashrate a longer window between the reveal and `D`
  does not help, and Bob (the Ethereum side) is exposed to a majority miner who is Alice: at a 53 % share and the production window the model gives
  about 55 % from a clean start and about 90 % or more for a prepared attacker (`docs/miner-concentration.md`). A smaller miner is limited by the
  window and by how quickly Bob re-sends (an operator who re-sends by hand needs minutes). The Bob-side gate is built
  (2026-11-08, `docs/bob-concentration-gate.md`; a screen, not a defence): under `production` the lock is not offered while one address produced more
  than 35 % of the recent blocks or the headers cannot be read. Since 2026-11-09 the second node is also asked for 64 sampled blocks on each tick
  (hash and producer, both windows), and a finding that two honest nodes cannot produce is remembered beside the swap file and refuses the lock for
  the rest of the swap (`TASKS.md` T21-13; still a screen: a producer on several addresses, two lying nodes, or one only a few points over the limit
  pass). Swaps in which Bob locks ETH against an unknown Alice are still not recommended and amounts stay tiny.

## How to run

Node parts (any OS, Node ≥ 21; tested on 22):
```sh
cd eth && npm install && npx hardhat test      # 306 passing; solc download falls back to npm solc@0.8.24
cd btc && npm install && npm test              # 91 passing (node --test)
node eth/scripts/secret.js                     # generate s + sha256 hashlock
```

Rust parts (WSL2 Ubuntu recommended on Windows; native needs Visual Studio Build Tools plus clang,
cmake, pkg-config per `vendor/parano1d/docs/developers/build.md`):
```sh
# toolchain: vendor pins rust 1.96.0 in vendor/parano1d/rust-toolchain.toml; rustup fetches it on a
# normal machine. The sandbox could not download it and used RUSTUP_TOOLCHAIN=stable (1.97.0) instead.
cd parano1d/harness && cargo test                                   # 37 tests (+1 ignored), ~2 min first build, ~40 s run
PAUTH_BENCH_N=30 cargo test --release --test pauth_bench -- --ignored --nocapture   # P_auth benchmark (idle machine)
cd equiv && cargo test --release                                     # 23 tests; EQUIV_PARITY_N=100000 for the big parity run
cd equiv/zkvm && cargo test -p equiv-guest-core                      # 3 tests; proving needs rzup — see equiv/README.md §5
cd equiv/zkvm && EQUIV_RECEIPT_DIR=~/zkvm-out cargo test --release -p equiv-host   # 14 host tests incl. negatives on real receipts
cd swap-cli && cargo test --offline                                  # 625 tests (+1 ignored); eth/ (live scripts included): cd eth && npx hardhat test (306)
# Pruv (run from the vendor workspace):
cargo run -p noid_pruv --manifest-path vendor/parano1d/Cargo.toml -- \
  check parano1d/contracts/htlc.pruv --params parano1d/contracts/htlc.params.example.json
cargo run -p noid_pruv --manifest-path vendor/parano1d/Cargo.toml -- \
  build parano1d/contracts/htlc.pruv --params parano1d/contracts/htlc.params.example.json --out /tmp/htlc.definition.json
cargo run -p noid_pruv --manifest-path vendor/parano1d/Cargo.toml -- \
  verify parano1d/contracts/htlc.pruv --params parano1d/contracts/htlc.params.example.json --z3 "$(which z3)"
```
`scripts/setup.sh` (WSL/Linux) runs all of the above except the zkVM; `scripts/setup.ps1` runs the Node parts.
Use `CARGO_TARGET_DIR=$PWD/target` to share one build cache across the three Rust workspaces.

## Conventions

- Preimage/secret `s` = exactly 32 raw bytes. Hashlock `H = SHA-256(s)` over those bytes only — no
  length prefix, no hex/ASCII, not keccak — identical on ETH (`HTLC.sol`) and BTC (`OP_SHA256`).
  Test vector: `s = 00 01 … 1f` → `H = 630dcd29…10dd`, `Addr(s) = f8183db2…12cf`
  (`o1lqvrmvsyl7mkt3cptkz3c965ujt5ce6mjawxwwxe7mgn36mjzt8sn69xw2`), `Addr(Derive(s,0))` =
  `o125qayvgtmvqnlhqmqwe08dza3acaax5mct3u5h4uen3qtrds3jfset7wlk`.
- `A` = 32 address bytes = lane0 (16 B LE) ‖ lane1 (16 B LE) = the bytes inside the bech32m `o1…` string.
- Amounts in μNOID (u64, 6 decimals). Heights are u64 block numbers; Bitcoin locktimes are heights
  (< 500,000,000); Ethereum timelocks are UNIX seconds.
- Each component's `README.md` is the source of truth for that component; `docs/` for the protocol.
- Keep `vendor/` untouched; keep the three Rust workspaces separate (they are not members of the
  vendor workspace on purpose).

## Next steps

See `TASKS.md` (milestones M0–M4 with acceptance criteria, first-session checklist, and the
experiment that settles each open question).
