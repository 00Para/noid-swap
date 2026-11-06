# Parano1d-side HTLC prototype (the NOID leg of an atomic swap)

A hash-time-locked contract written in Pruv, plus a pure-Rust test harness that
checks the lock against the vendored Parano1d code (commit `d29b801`) without a
node, mining, or network access. Background and file/line citations are in
`../docs/parano1d-capabilities.md`.

Nothing under `vendor/` was modified (`git status` there is clean, so no
`patches/` directory exists).

## Contents

| Path | What |
|---|---|
| `contracts/htlc.pruv` | `HashTimeLock` contract, as in report section 7, plus `ensures terminal;` |
| `contracts/htlc.params.example.json` | Example parameters (valid `o1...` bech32m addresses, u64 as decimal strings) |
| `contracts/htlc.definition.json` | `pruv build` output (`custom_program` definition) for the example params |
| `contracts/htlc_v2.pruv`, `htlc_v2.definition.json` | v2 (fixed fee): v1 plus `require fee == max_fee;`; see "HashTimeLock v2 (fixed fee)" below |
| `harness/` | Standalone Cargo crate (own `[workspace]`, path deps on `noid_core`, `noid_poseidon2b`, `noid_tx`, `noid_gkr`, `noid_pruv`) |
| `harness/src/lib.rs` | Helpers: `addr()`, `derive_bytes()`/`addr_derived()` (stock wallet), compiling the real `htlc.pruv`, building/proving/verifying calls (default V4 and explicit-version variants), and the tool guard; `htlc_params()` and `compile_htlc_params()` (params object -> opening + SDK definition JSON, used by `swap-cli alice-params`) |
| `harness/tests/htlc.rs` | Contract/policy tests (12) |
| `harness/tests/auth_versions.rs` | Stock-wallet `Addr(Derive(m, 0))` path and owner-authorization V3/V4 (5) |
| `harness/tests/verifier_negative.rs` | Verifier-side negative tests on tampered or rebound proofs (5) |
| `harness/tests/guard.rs` | Tool guard for contract params (4) |
| `harness/tests/htlc_v2.rs` | v2 fixed-fee tests (9); not in the 26 |
| `harness/tests/pauth_bench.rs` | `P_auth` benchmark (M0.5). `#[ignore]` and env-gated, not in the 26 |

The example addresses are **test material only**: the hashlock is `Addr(00 01 .. 1f)`,
whose secret is public in this repo, so never fund a contract built from them.

## The contract

- `claim_authority = hashlock_authority` (= `Addr(s)`), `claim_recipient = receiver` (Bob)
- `recovery_authority = recovery_recipient = sender` (Alice)
- `deadline_height = timeout_height`, `max_fee_micronoid = max_fee`
- `max_payout = 0`, `min_retained = 0`
- `claim_can_close = recovery_can_close = true`; both `*_can_continue = false`
  (rule modes = `CLAIM_CLOSE | RECOVERY_CLOSE` = 10); `unrestricted_payout_recipient = false`
- `call { require terminal; }`, `ensures terminal;`

Behaviour: at inclusion height `h < deadline` only a prover who knows `s` can
authorize a close, and output 0 must pay Bob. At `h >= deadline` only Alice can
authorize a close, and output 0 must pay Alice. The program has no hash opcode
and no call argument, so everything is enforced by the committed policy and the
native authorization (see report sections 1 to 3).

### `pruv check` / `pruv build` / `pruv verify`

```
$ pruv check contracts/htlc.pruv --params contracts/htlc.params.example.json
HashTimeLock: ABI 3, 1/16 instructions, 0/2 state registers, 1 postconditions
$ pruv build contracts/htlc.pruv --params contracts/htlc.params.example.json --out contracts/htlc.definition.json
$ pruv verify contracts/htlc.pruv --params contracts/htlc.params.example.json --z3 <path>/z3
HashTimeLock: 1 postconditions verified for every successful ABI 3 integer execution
```

**Instruction count: 1 of 16** (a single `assert_equal terminal, one`).

`pruv` was built with `cargo build --release --locked --manifest-path ../vendor/parano1d/Cargo.toml -p noid_pruv`
(binary at `~/noid-swap/target/release/pruv`).

**Z3.** `z3` was not installed and `pip install` was not used. Instead I ran
`pip download z3-solver`, unzipped the wheel under `/tmp` and used the
`z3_solver-*.data/data/bin/z3` binary it ships (reported itself as "Z3 version 5.3.3").
That path is outside the project and will not survive; to repeat, redo those two
steps and pass `--z3`. As sanity checks, `ensures !terminal;` and
`ensures has_payout == false;` both fail verification (the second is true in
practice only because `check_call` pins the bitmap shape; the integer program
alone does not know it). The `ensures terminal` property is deliberately modest:
the program is a single assertion, so what it proves is that no successful
execution can be a continuing call. Everything else (recipient, authority, fee
cap) lives in the policy, outside the integer program, so `pruv verify` cannot
speak to it. The harness tests cover those.

## Running the tests

The pinned toolchain (1.96.0) cannot be downloaded behind the proxy; stable
rustc 1.97.0 builds everything. The harness is outside the vendored workspace, so
`rust-toolchain.toml` is not picked up; the env var is just belt-and-braces:

```sh
cd ~/noid-swap/parano1d/harness
CARGO_TARGET_DIR=~/noid-swap/target RUSTUP_TOOLCHAIN=stable cargo test
```

(Use `cargo +stable test` if you prefer.) `Cargo.lock` is the vendor workspace
lock, pruned by cargo. First build about 1 to 2 minutes on 2 cores; the 26 tests
then run in about 10 seconds per test binary (the binaries run one after another;
tests inside a binary run in parallel). `noid_gkr` builds without issue, so real
proofs are generated and verified; the only `#[ignore]`d test is the `P_auth` benchmark (see "Benchmark: P_auth"), not one of the 26. One authorization
proof takes about 1.2 s (optimized test profile, `opt-level = 3`); verification
about 30 ms.

## Results

All 26 tests pass (12 + 5 + 5 + 4). The first 12 are the original contract tests.

| Test | Result | What it shows |
|---|---|---|
| `addr_vectors` | pass | `Addr(00..1f)` = `f8183db2...72cf` = `o1lqvrmvsyl7mkt3cptkz3c965ujt5ce6mjawxwwxe7mgn36mjzt8sn69xw2`, matching the report |
| `claim_before_deadline_pays_receiver` | pass | close at D-1: `check_call` ok, authority `Addr(s)`, single output owner = Bob, amount = input - fee; proof with raw `s` generates and verifies |
| `claim_with_wrong_secret_rejected` | pass | see layers below |
| `claim_after_deadline_rejected` | pass | Bob-paying page rejected at D; `s` cannot authorize the Alice-paying page |
| `refund_after_deadline_pays_sender` | pass | at D, D+1, D+123456: owner = Alice, authority = Alice; proof with Alice's secret verifies |
| `refund_before_deadline_rejected` | pass | Alice-paying page rejected at D-1; Alice cannot authorize the Bob-paying page |
| `close_must_pay_committed_recipient` | pass | output owner Mallory, Alice, or `Addr(s)` before the deadline: rejected; even holder of `s` cannot get a proof |
| `fee_capped_by_max_fee` | pass | fee = max_fee ok; max_fee + 1 rejected (`FeeLimit`) |
| `compiled_policy_matches_the_spec` | pass | compiled `ObjectOpening` has the intended policy and modes = 10 |
| `example_params_reproduce_saved_definition` | pass | `compile(htlc.pruv, example params).definition()` equals `htlc.definition.json`, 1 instruction |
| `continuing_calls_and_payout_outputs_rejected` | pass | close-only modes hold (extra test) |
| `wrong_opening_is_rejected` | pass | changed deadline gives different root, `OldObject` (extra test) |
| `stock_wallet_derive_vector` | pass | `Addr(Derive(00..1f, 0))` = `o125qay...7wlk`; `Derive` is index-sensitive and differs from `Addr(m)` |
| `stock_wallet_claim_authorizes_with_derived_secret` | pass | authority `Addr(Derive(m,0))`: witness `Derive(m,0)` proves and verifies; raw `m`, `Derive(m,1)` and a raw-variant contract are refused; payout still pinned to Bob; after `D` the stock secret is useless |
| `auth_version_boundary` | pass | height 279,369 is V3, 279,370 is V4 (mirrors the vendor rule) |
| `raw_secret_v3_v4_roundtrip_and_cross_rejected` | pass | raw `s`: V3 proof verifies only under V3, V4 only under V4; each rejected under the other (`AuthProof`); a V3 proof at a V4 height is rejected; serialized proofs differ |
| `stock_wallet_v3_v4_roundtrip_and_cross_rejected` | pass | same, for `Addr(Derive(m,0))` |
| `verifier_rejects_flipped_proof_bytes` | pass | one bit flipped at 18 offsets over a genuine proof: 1 refused by the wire decoder, 17 reach the verifier and are all rejected; untampered control verifies |
| `verifier_rejects_tampered_proof_fields` | pass | `grind_nonce`, `phase_b_value`, `sigma` edited on the decoded proof (decoder bypassed): `AuthProof`; a valid proof of another contract: `AuthProof` |
| `verifier_rejects_malformed_bundle_bytes` | pass | truncated, trailing byte, bad magic, empty: decode errors |
| `verifier_rejects_proof_bound_to_a_different_transaction` | pass | page with other epoch anchor, fee, output slot, input, or a different recipient contract (all pass `check_call`): `AuthProof` |
| `verifier_binds_proof_to_the_branch_at_the_inclusion_height` | pass | Bob's proof at `D`, `D+1`, ... : `OwnerAuthStatement(Recipient)`; at any height below `D` it is the same statement and verifies (height is bound only through the branch) |
| `guard_rejects_claim_recipient_equal_to_claim_authority` | pass | `GuardError::ClaimRecipientIsClaimAuthority` from `check_swap_params`, `try_compile_htlc`, `check_params_value`, `check_opening` (also for the stock-wallet authority) |
| `guard_rejects_max_fee_below_minimum_close_fee` | pass | `max_fee` 0, 1, 5,799: `MaxFeeBelowMinimumCloseFee`; with 5,799 a minimum close hits `FeeLimit` on both branches |
| `guard_accepts_safe_parameters` | pass | distinct recipient, `max_fee` = 5,800 exactly: accepted and a real close at that cap builds; the shipped example params pass `load_params_guarded` |
| `guard_reports_unreadable_or_malformed_params` | pass | missing file, missing field, bad address: `BadParams` (fails closed) |

I also mutation-checked the suite: changing `claim_recipient = receiver` to
`claim_recipient = hashlock_authority` (the unsafe `refundable_payment`-style
setup) makes 5 tests fail, including `close_must_pay_committed_recipient`.

### Which layer rejects what

| Attack | Rejected by | Error |
|---|---|---|
| Close pays someone other than the branch recipient | `ObjectOpening::check_call` (also the preflight in prover and verifier) | `ObjectError::Recipient` |
| Bob-paying close at height >= D | `check_call` (recipient flips to Alice) | `Recipient` |
| Alice-paying close at height < D | `check_call` | `Recipient` |
| fee > max_fee | `check_call` (and `build_call`) | `FeeLimit` |
| Continuing call (terminal bit clear) | `check_call` policy mode check | `Policy` |
| Continuing call through `build_call` | the program's own `require terminal`, run before the policy check | `Program(Assertion { step: 0 })` |
| Close with a payout output | `check_call` shape check | `Shape` |
| Opening with any changed term | `check_call` root binding | `OldObject` |
| Wrong secret `s'` (or Alice's secret before D, or `s` after D, on a well-formed call) | **the prover**: `prove_experimental_object_authorization` refuses a witness whose `Addr(secret)` is not the authority at that height | `ProveAuthorizationError::BoundaryMismatch { input_index: 0, field: "owner_auth" }` |
| Proof for a different statement (decoy contract with `Addr(s')`, or replay on a modified page) | **the verifier**: `verify_experimental_object_authorization` | `VerifyAuthorizationError::AuthProof` |
| Proof made at one side of the deadline, verified on the other | verifier's `check_call` preflight | `VerifyAuthorizationError::OwnerAuthStatement(..Recipient..)` |

Key point for the swap: `check_call` alone never sees any secret, so a wrong
secret passes `check_call`. It is the authorization proof (prover refusal, then
verifier) that enforces "knows `s`". Conversely, knowing `s` cannot redirect
funds, because the recipient check is in `check_call` and the verifier re-runs
it. That is what makes publishing `s` on the other chain harmless on this side.

## Tool guard (TASKS M0.6)

`harness/src/lib.rs` refuses to produce an unsafe swap contract:

```rust
pub fn check_swap_params(claim_authority: &Address, claim_recipient: &Address, max_fee: u64)
    -> Result<(), GuardError>
```

| Rejected | Error | Why |
|---|---|---|
| `claim_recipient == claim_authority` | `ClaimRecipientIsClaimAuthority` | A Parano1d claim never reveals the secret, but once `s` is public on the other chain anyone who knows it can authorize a close. The funds are safe only because the recipient is pinned to Bob, an address not derived from `s`. Recipient = authority is the `refundable_payment` shape and hands the funds to the first person who copies `s`. |
| `max_fee < 5,800` (`MIN_CLOSE_FEE`) | `MaxFeeBelowMinimumCloseFee` | The cheapest 1-in/1-out close costs `5000 + 100*1 + 700*1 = 5,800` micro-NOID. A lower cap means no close is ever valid, so claim and refund are both locked forever. |

Where it is wired:

- `try_compile_htlc(hashlock, receiver, sender, timeout, max_fee)` runs the guard before compiling and `check_opening` on the compiled `ObjectOpening`. `compile_htlc` (used by every test) calls it and panics on refusal. Nothing in this crate can build an unguarded contract.
- `load_params_guarded(path)` is the params-file loader (parses like `pruv --params`, then `check_params_value`). `example_params_reproduce_saved_definition` loads the shipped example through it.
- `check_params_value(&Value)` and `check_opening(&ObjectOpening)` are the same rule on a parsed params object and on a compiled opening. The Pruv compiler itself does not know the rule (a test compiles the unsafe params directly to show that).

The guard is deliberately minimal. It does not check the deadline, the fee against the amount, or whether the hashlock is the public test vector `00 01 .. 1f` (the shipped example is that vector, so never fund it). A guard that fails to read the params returns `BadParams`, never a pass. The standalone `pruv` binary does not run this guard: any real contract build must go through this crate (or repeat the two checks by hand).

## Stock wallet and proof versions

- `derive_bytes(m, i)` / `addr_derived(m, i)` reimplement the stock wallet's `Derive` (3 Poseidon2b permutations) from `vendor/.../noid_node/src/wallet/keystore.rs`, which is `pub(super)`. They reproduce the test vector `Addr(Derive(00..1f, 0)) = o125qay...7wlk` and agree with `equiv/portable`. The stock wallet authorizes with `Derive(m, active_index)`, never `m`; `prove_stock_wallet` does the same.
- `prove_v` / `verify_v` take an explicit `OwnerAuthorizationVersion` (`V3` before height 279,370, `V4` from it). `prove` / `verify` remain V4. `auth_version_at(h)` mirrors the vendor's `owner_authorization_version`; it is mirrored, not imported, because `noid_chain` pulls in libmdbx. The constant `V2_1_ACTIVATION_HEIGHT = 279_370` therefore has to be kept in step with `vendor/parano1d/noid_chain/src/consensus/params.rs` by hand. The version tests deliberately use one opening that is open on both sides of 279,370; a real swap must never straddle it (PROJECT.md rule 4).

## Benchmark: P_auth (TASKS M0.5, design Q4)

`harness/tests/pauth_bench.rs` times one complete claim authorization the way Bob's client does it: fresh secret and fresh opening, build the closing page, prepare the witness, prove with `noid_gkr`; wall clock, end to end. It is `#[ignore]` and also does nothing unless `PAUTH_BENCH_N` is set, so plain `cargo test` still runs the 26 tests only. Each proof is verified after the timer stops.

```sh
cd parano1d/harness
PAUTH_BENCH_N=30 cargo test --release --test pauth_bench -- --ignored --nocapture   # headline numbers
PAUTH_BENCH_N=10 cargo test            --test pauth_bench -- --ignored --nocapture   # test profile
```

It runs V3 (page at height 279,369) and V4 (279,370), each for the `raw` variant (witness `s`) and the `stock` variant (witness `Derive(m,0)`), after one untimed cold proof, and prints a `PAUTH_ENV` header (N, build profile, `available_parallelism`, `RAYON_NUM_THREADS`, load average before and after) and per case `min / p50 / p90 / p99 / max / mean` in seconds (nearest-rank percentiles; with N = 30, p99 is the maximum). Both `end_to_end` (page build + witness + proof) and `prove_call_only` are printed. Run it only on an idle machine (no `cargo`/`rustc`/`r0vm`, 1-minute load below 1.0). The profile printed as `debug-assertions-on(test profile)` is `[profile.test]`, which this crate sets to `opt-level = 3`; a true `opt-level = 0` build was not measured.

Results on the owner's PC (WSL2 VM, 6 cores, 3 GB): p50 about 1.5 s, worst p99 6.0 s, V3 and V4 the same within noise. Full table, machine conditions and the resulting timeout budget are in `../docs/protocol-design.md` section 4.1. They are from that VM, not from a counterparty's machine.

## Addr, exactly as used

`Addr(s) = noid_poseidon2b::primitives::derive_address(&SpendSecret::from_bytes(s))`
(`harness/src/lib.rs::addr`). Per the report (section 10): one Poseidon2b
permutation over GF(2^128), sponge t=4, rate 2, capacity 2, IV from the label
`"ADDRFIX_"`; the 32-byte secret is split into two little-endian u128 limbs, XORed
into lanes 0 and 1, permuted, and lanes 0 and 1 (16 LE bytes each) are the 32-byte
address. It is not SHA-256 and not the wallet's `Derive(m, i)` path (3 more
permutations; reimplemented in the harness as `derive_bytes`, see "Stock wallet
and proof versions"). `SpendSecret` in the raw-variant tests is the swap secret `s`.

## HashTimeLock v2 (fixed fee)

`contracts/htlc_v2.pruv` is `htlc.pruv` plus one rule: **every close must pay exactly `max_fee`**
(`require fee == max_fee;`). It exists to kill the minimum-fee stall (design T2 / Q1, `docs/ideas.md` idea 5):
in v1 a close may pay any fee in [network minimum, `max_fee`], so whoever holds the secret can broadcast a
5,800 μNOID close that still pays Bob but that Bob cannot outbid (first-seen mempool, no replace-by-fee). In v2
no cheaper valid close exists. Background, cost and the `max_fee` rule: `../docs/htlc-v2-fixed-fee.md`.
v1 (`htlc.pruv`, `htlc.definition.json`) is untouched: the live runs and the swap-cli fixtures pin it.

Program (2 of 16 instructions):

```
call {
    require terminal;           // instruction 0: assert_equal terminal, one
    require fee == max_fee;     // instruction 1: assert_equal fee, immediate(max_fee)
}
ensures terminal;
ensures fee == max_fee;
```

- The program cannot read the policy's fee ceiling (the context operands are `height, fee, payout, retained,
  input_amount` and flags; there is no `max_fee` operand). So the fixed fee is a **second copy** of the `max_fee`
  parameter, embedded as the instruction-1 immediate (here `"20000"`). Both copies come from the same Pruv
  parameter, so they cannot disagree. The policy ceiling (`fee > max_fee` gives `FeeLimit`) is checked before the
  program runs; the program then rejects `fee < max_fee` (`ProgramError::Assertion { step: 1 }`).
- `fee` is `body.fee` (`integer_program.rs:Context::from_body`) and the block proof pins it to the body's fee leaf
  (`noid_recursive/src/acceptance/block_slots.rs:~1010`, `TX8X2_LEAF_FEE`) before `bind_program` executes the program,
  so the rule is enforced by consensus, not only by Rust admission.
- Instruction 0 is redundant with the close-only modes (a continuing call is already `ObjectError::Policy`). It is kept
  as in v1 because `ensures terminal` needs it for `pruv verify`; dropping it would save one of 16 slots and nothing else.
- The opening changes (a new program, a new code id), so a v2 contract has a different address than a v1 contract with
  identical parameters, and a v1 opening is rejected as `OldObject` by a v2 and vice versa.

```
$ pruv check contracts/htlc_v2.pruv --params contracts/htlc.params.example.json
HashTimeLockV2: ABI 3, 2/16 instructions, 0/2 state registers, 2 postconditions
$ pruv build contracts/htlc_v2.pruv --params contracts/htlc.params.example.json --out contracts/htlc_v2.definition.json
$ pruv verify contracts/htlc_v2.pruv --params contracts/htlc.params.example.json --z3 /usr/bin/z3
HashTimeLockV2: 2 postconditions verified for every successful ABI 3 integer execution
```

(Run from the vendor workspace as for v1: `cargo run --offline -p noid_pruv --manifest-path vendor/parano1d/Cargo.toml -- ...`;
2026-11-04, WSL Ubuntu-24.04, `z3` from apt at `/usr/bin/z3`. `pruv build` refuses to overwrite, so delete the
definition first when regenerating. The saved definition's program is two `assert_equal` entries; the second is
`left: fee, right: immediate, immediate: "20000"`.)

`harness/tests/htlc_v2.rs` (9 tests, `cargo test --offline --test htlc_v2`, about 3 to 8 s; reads `htlc_v2.pruv`, `lib.rs`
is unchanged; real proofs only in the last test). Whole harness, run 2026-11-04: 35 passed (26 old + 9 new), 0 failed,
1 ignored (the `P_auth` benchmark):

| Test | What it shows |
|---|---|
| `v2_compiles_and_guards_accept` | policy identical to v1; `check_swap_params` and `check_opening` accept; different root than v1; v1 page is `OldObject` |
| `v2_example_params_reproduce_saved_definition` | compiled definition equals `htlc_v2.definition.json`; 2 instructions, 2 postconditions; instruction 1 is `fee == 20000`; v1 definition still 1 instruction |
| `v2_guard_still_refuses_unsafe_params` | recipient == authority and `max_fee` 0, 1, 5,799 refused; `max_fee` = 5,800 accepted and then the fixed fee is 5,800 |
| `v2_fee_equal_to_max_fee_accepted_on_both_branches` | `fee == max_fee` passes `check_call` at D-1, D, D+123,456; recipient and amount (`AMOUNT - max_fee`) correct |
| `v2_fee_below_max_fee_rejected_on_both_branches` | NEGATIVE: fees 5,800, `max_fee - 1`, 1, 0 rejected by the builder (`Assertion { step: 1 }`); a hand-edited page with `max_fee - 1` is rejected by `check_call` and the prover refuses it (right secret); control: v1 accepts the 5,800 close |
| `v2_continuing_and_payout_calls_still_rejected` | `Assertion { step: 0 }` / `Policy`, as v1 |
| `v2_recipient_rule_unchanged` | wrong payee with the right fee: `Recipient`; boundary exact at D |
| `v2_fee_above_max_fee_rejected_as_before` | `max_fee + 1`, `+1000`: `FeeLimit` (ceiling fires before the program); the prover refuses; v1 control |
| `v2_claim_and_refund_prove_and_verify_with_the_fixed_fee` | real proofs: claim at D-1 and refund at D with `fee == max_fee` verify; the claim's proof is rejected for the cheaper page |

## Caveats and things that did not work

- **Not tested here:** the consensus HistoryStep relation (the in-circuit twin of
  `check_call`), mempool admission, epoch anchors, the eviction of pending calls at
  height 279,370 (only the V3 and V4 proof/verify relations are tested, not the
  switch itself), or relay-fee floors. The original 12 tests use the V4 default
  prover and verifier; heights in them are arbitrary. Whether the
  HistoryStep circuit enforces exactly `check_call` stays unverified (report,
  "What we could NOT determine").
- Zero-knowledge of the capsule is not tested; only soundness-style behaviour is.
- `verifier_negative.rs` shows that the verifier rejects genuine proofs that were
  tampered with or rebound to another transaction or branch. It does not show
  that a proof made WITHOUT the secret is rejected: the public prover API cannot
  produce one, so soundness against a malicious prover is still assumed.
- The vendor's own `object_capsule_binds_the_opened_authority_and_deadline_branch`
  test was not run; the harness reproduces its flow against the compiled HTLC.
- `build_call` refuses to build some invalid calls, so a few negative tests
  hand-edit the page body (`with_body`) to reach `check_call` directly.
- The `ensures terminal;` postcondition is weak by construction (see above).
- `max_fee` in the example (20,000 micro-NOID) is arbitrary; a close costs at least
  5,800 and the relay floor can rise (report section 9). The tests use fee 5,800
  and `max_fee` 10,000.

## Patches

`vendor/` is never modified. The only patch is test-only and is applied to a scratch copy:

- `patches/q2-n2-tests.patch` (2026-11-04): the Q2 negative test N2 from `docs/q2-history-step.md` §7.2.1, two
  `#[cfg(test)]` modules for `noid_recursive` (`acceptance/block_slots.rs` control case, `region_sidecar/walk_a.rs`
  forged-opening cases) plus one `#[cfg(test)]` hook that changes a prover-supplied value, never a constraint.
  To reproduce: copy `vendor/parano1d/noid_recursive` (only `src/` and `Cargo.toml`) outside the repo, rewrite its
  path dependencies to absolute paths into `vendor/parano1d/<crate>`, add an empty `[workspace]` table and
  `publish = false`, copy `vendor/parano1d/Cargo.lock` next to it, `cargo fetch` once (crates.io only), then
  `patch -p1 < .../q2-n2-tests.patch` and
  `cargo test --offline --release -p noid_recursive --lib q2_n2 -- --nocapture --test-threads=1`
  (about 4 min to build on the 3 GB WSL VM, 17 s to run; expect 2 passed).
