# Equivalence proof for a Parano1d (NOID) <-> Bitcoin/Ethereum atomic swap

Bob (the BTC/ETH holder) must be convinced, **before he locks**, that the SHA-256
hashlock `H` on his chain and the Parano1d claim-authority address `A` commit to the
same secret. The proof is checked off-chain by Bob. Nothing here touches either chain.

Definitions are those of `docs/parano1d-capabilities.md` section 10; line citations below
are into `vendor/parano1d` (not modified).

## 1. Statement

Two variants, selected by a flag that is part of the public input.

| variant | flag | statement |
|---|---|---|
| RAW   | `0` | `exists m (32 bytes): sha256(m) = H  and  Addr(m) = A` |
| STOCK | `1` | `exists m (32 bytes): sha256(m) = H  and  Addr(Derive(m, 0)) = A` |

* `Addr(s)`: one Poseidon2b permutation of `[s_lo, s_hi, L<<64, L]` with `L = u64_be("ADDRFIX_")`,
  output = lanes 0 and 1 as 16 little-endian bytes each (`noid_poseidon2b/src/primitives.rs:L298-L305`,
  `native/domain.rs:L27-L40,L56`, `native/compression.rs:L98-L103,L198-L216`).
  `s_lo = u128_le(s[0..16])`, `s_hi = u128_le(s[16..32])`, tower-basis `Block128`.
* `Derive(m, i)`: sponge with zero IV, absorb `m_lo, m_hi, i, 0x6E6F69642D64657269`, **padded** finalize
  (3 permutations) (`noid_node/src/wallet/keystore.rs:L75-L93`; padding `compression.rs:L293-L298`).
  The result is again 32 bytes, interpreted as the spend secret.
* Permutation: Poseidon2b over GF(2^128), t=4, x^7 S-box, 8 full + 58 partial rounds, constants and MDS
  in tower basis, evaluated in the flat (GCM) basis (`native/permutation.rs`).
* So RAW costs 1 permutation, STOCK costs 4 (3 for Derive, 1 for Addr). Plus one SHA-256 block.

Address-code note (from the capabilities doc): the doc comment at `primitives.rs:L72-L73` says
`ADDRESS_`, the code uses `ADDRFIX_`. The code is what is implemented here, and it matches the known vector.

### Which variant to use

* RAW needs a custom claimer (a small Rust client with `noid_gkr` + `noid_tx`), see doc section "Implications" 4.
  The secret `m` is the spend secret of exactly one address, `A`.
* STOCK works with the stock wallet: `parano1d --import-wallet-secret` reads 64 hex characters from stdin and
  hex-decodes them straight into the 32-byte master secret (`noid_node/src/wallet/state.rs:L620-L636`), resets
  `active_index` to 0 (L637-L641), so the wallet's first address is `Addr(Derive(m, 0))`. Hex of `m` is
  therefore exactly the string to import; no byte reordering.
  **`m` is the master secret of the whole wallet and it is revealed on the BTC/ETH chain when the hashlock is
  claimed. Use a fresh, isolated wallet data directory per swap and never fund other addresses of it.**

## 2. Encoding of public inputs

The zkVM guest commits exactly 65 raw bytes to the journal (no length prefix, no serialization framing):

```
offset  len  field
0       1    variant     0x00 = RAW, 0x01 = STOCK
1       32   H           SHA-256 digest of m, as 32 bytes (the HTLC hashlock, big-endian digest order as output by SHA-256)
33      32   A           Address bytes: lane0 (16 B little-endian) || lane1 (16 B little-endian)
                         = the 32 bytes bech32m-encoded with HRP "o" as the o1... address
```

`A` bytes are `Address.0` (`primitives.rs:L28-L45`); the `o1...` string is only a presentation
(`primitives.rs:L81-L145`, bech32m, HRP `o`, 60 characters). The variant flag is inside the journal so a RAW
proof can never be presented as a STOCK proof or vice versa. The program identity (zkVM ImageID) is not part of
the journal; it is checked separately (section 4).

## 3. Layout and test results

```
equiv/
  portable/   equiv-portable: no_std, forbid(unsafe), ZERO dependencies. Poseidon2b (compile-time flat-basis
              tables, shift-and-add GF(2^128)), ADDRFIX_ sponge, Derive, SHA-256, statement + public encoding.
              This is the code that runs in the zkVM guest.
  reference/  equiv-ref: depends on the vendor crates (noid_poseidon2b, noid_core). lib + CLI `equiv-ref <hex m>`.
              tests/vendor_parity.rs checks portable == vendor.
  zkvm/       RISC Zero guest + host (section 5). Separate Cargo workspace.
```

Commands (as run): `RUSTUP_TOOLCHAIN=stable CARGO_TARGET_DIR=~/noid-swap/target cargo test --workspace --offline`
in `equiv/` (add `--release` for the 1,000-case parity tests to finish in ~1 s instead of ~20 s; set
`EQUIV_PARITY_N=<n>` to change the Addr/Derive/statement case count, see below).

Results: 23 tests, all pass (re-run 2026-11-04 on the owner's PC after the M1.3 change below: 7 + 15; the 23rd, `structured_layout_and_published_vector` in `reference`, came with the Poseidon vectors, and a second machine counted 23).

**Large differential run (M1.3).** The `Addr`, `Derive` and statement tests use `EQUIV_PARITY_N` random inputs
(default 1,000; fixed seed; each iteration draws a fresh random 32-byte `m`, and `Derive` is checked both at index 0 and
at a random `u32` index). Opt-in big run, one test at a time so the timings are separate:

```
EQUIV_PARITY_N=100000 cargo test --release -p equiv-ref --test vendor_parity -- --nocapture --test-threads=1 \
  addr_matches derive_matches statements_match
```

Result (2026-11-04, WSL2 on the owner's PC, release, 2 build jobs): **N = 100,000, 0 mismatches**, whole run 159.5 s.

| test | N | comparisons | mismatches | time |
|---|---|---|---|---|
| `addr_matches_vendor` | 100,000 | `Addr(m)` portable vs vendor | 0 | 16.5 s |
| `derive_matches_vendor_sponge` | 100,000 | `Derive(m,0)` and `Derive(m,i)` random `i` (200,000 checks) | 0 | 72.5 s |
| `statements_match_vendor` | 100,000 | RAW and STOCK `(H, A)` statements (200,000 checks) | 0 | 70.5 s |

Caveat unchanged: the vendor side of `Derive` is the transcribed keystore lines on the vendor sponge (see below), not
the wallet itself.

* `equiv-portable`: 7 (basis round trip, field axioms and squaring, permutation determinism, known vector,
  cost-model constants, public encoding, SHA-256 NIST vectors).
* `equiv-ref` `tests/vendor_parity.rs`: 15, including
  * known vector `m = 00 01 .. 1f`: `sha256 = 630dcd29...10dd`, `Addr = f8183db2...12cf`
    (`o1lqvrmvsyl7mkt3cptkz3c965ujt5ce6mjawxwwxe7mgn36mjzt8sn69xw2`), and
    `Addr(Derive(m,0)) = 5501d231...8c93` which is **byte-equal to the decoded**
    `o125qayvgtmvqnlhqmqwe08dza3acaax5mct3u5h4uen3qtrds3jfset7wlk` from the report (decoded with the vendor
    bech32m parser, both directions);
  * 1,000 random cases (Addr, Derive, statements: `EQUIV_PARITY_N`, default 1,000) each of: permutation (portable vs vendor `Poseidon2bPermutation`), `Addr`, `Derive`
    (random index and index 0), both statements, tower<->flat conversion and GF multiplication vs vendor
    `tower_to_flat_u128` / `flat_to_tower_u128` / `clmul_gcm`; edge-case secrets (all-zero, all-0xff, single bits);
    SHA-256 vs the `sha2` crate for lengths 0..299.
* `equiv-guest-core` (zkvm/core): 3 tests (not counted above; run `cargo test` in `zkvm/`).

### Important limit of the Derive test

`MasterSecret::derive_spend_secret` is `pub(super)` inside a private module of `noid_node`, and `noid_node`'s
`lib.rs` exports only `networking` and two staging modules, so the vendor keystore path is **not reachable** from
a library. The reference `derive`/`derive0` is therefore the cited lines transcribed onto the vendor
`Poseidon2bSponge` (`reference/src/lib.rs`, line-by-line comments), and the portable version is an independent
re-implementation of the same lines; both are tested against each other and against the report's `o125...`
address. What is **not** done: running the real wallet (build `parano1d`, `--import-wallet-secret`, read the first
address over RPC). That is the one end-to-end check that would catch a misreading shared by all three
implementations. Do it once before the first real swap (it needs a node build, which was not attempted here).

## 4. How Bob verifies

Bob needs: `H` (read from the BTC/ETH HTLC he is about to fund, or recomputed), `A` (the `claim_authority`
policy field of the funded Parano1d object, via `getObjectInstances`), the variant, the receipt from Alice, and an
**ImageID that he built or obtained himself** (reproducible build of `zkvm/methods/guest`, `cargo risczero build`).

```
equiv-prove verify <raw|stock> <H hex> <A hex or o1...> proof.receipt
```

This checks (1) the receipt verifies against the guest ImageID compiled into Bob's own `equiv-prove`, and (2) the
journal is exactly `variant || H || A` for the (H, A) Bob supplied. Bob must not take H, A or the ImageID from Alice's
output; he derives them himself. Only after this passes does he proceed to the rest of the existing checklist
(opening hashes to the funded `o1` address, every policy field, deadline, `max_fee`; doc "Implications" 3).

The proof says nothing about Bob's claim recipient, the deadlines or the fee; those remain separate checks. It is
also safe to replay: it is a statement about (H, A) only.

## 5. zkVM: what was and was not possible here

Time-boxed attempt, ended after about 5 minutes (not fought):

* `sp1up` host `sp1up.succinct.xyz`: CONNECT refused (403 from the egress proxy).
* `rzup` installer host `risczero.com`: refused. The installer script itself is on `raw.githubusercontent.com`
  (reachable), but it downloads the `rzup` binary from `artifacts.risczero.net`: refused.
* GitHub release assets (`github.com/<org>/<repo>/releases`, both `succinctlabs/*` and `risc0/*`): 403 (repo not
  enabled for the session); `git clone` of both repos works, but both zkVMs need their custom Rust toolchain
  (riscv32 target std), and `rustup target add riscv32im-unknown-none-elf` is refused (`static.rust-lang.org`).
* Consequence: **no guest ELF could be built, so nothing was proven and no proving time, cycle count or proof size
  was measured.** Everything in section 6 about the zkVM is an estimate.

What does work here, and was run:

* `zkvm/core` `cargo test`: the guest computation as a pure function (3 tests pass).
* `zkvm/methods/guest` `cargo check` on the host target (stable 1.97.0): the guest compiles as a normal crate.
* `zkvm/host` (prove + verify subcommands) and `zkvm/methods` (build.rs, both the local and the
  `EQUIV_REPRODUCIBLE=1` docker variant): `RISC0_SKIP_BUILD=1 cargo check --all-targets` passes. The host API use
  (`default_prover().prove_with_opts`, `ProverOpts::succinct`, `Receipt::verify`, `SessionStats`) was checked against the
  risc0-zkvm 3.0.6 source. The optional in-process `prove` feature could not be built here: its build script downloads
  recursion circuits from `risc0-artifacts.s3.us-west-2.amazonaws.com` (HTTP 400 via the proxy). By default the host proves
  through the `r0vm` binary that `rzup` installs.
* Not run: the guest on the zkVM, any proof, any receipt verification. The `verify` path is therefore type-checked only.

### Choice: RISC Zero

RISC Zero was chosen over SP1 because the property that matters here is **zero knowledge of the live secret**, not
just soundness, and RISC Zero's own README states that its receipts are zero-knowledge ("perfect zero-knowledgeness
and 98 bits of conjectured security" with default parameters, `risc0/README.md` in the repo). I could not
establish the equivalent statement for SP1 from its repository (its README only calls it a "zero-knowledge virtual
machine"; whether core/compressed proofs hide the witness, versus only the Groth16/PLONK-wrapped ones, must be read
from its current docs before choosing SP1). Do not use any SP1 mode without confirming it hides the program's private
input. The crate versions resolved were `risc0-zkvm 3.0.6` / `risc0-build 3.0.6` (latest stable on crates.io at the
time; the repo's `main` is 5.0.0 which is only published as an rc). Install the matching toolchain with `rzup`.

### Instructions for a machine with normal internet

```
curl -L https://risczero.com/install | bash          # installs rzup
rzup install                                         # toolchain + r0vm matching the risc0 crates (3.0.x)
cd equiv/zkvm
cargo test -p equiv-guest-core                       # sanity
# Bob: reproducible guest build inside RISC Zero's pinned docker image -> ImageID (compare with other builders)
EQUIV_REPRODUCIBLE=1 cargo run --release -p equiv-host -- image-id
# Alice may use the local-toolchain build (drop EQUIV_REPRODUCIBLE) only if the ImageID printed equals Bob's.
# prove the known vector (m = 00 01 .. 1f). The secret is read from stdin (one line, 64 hex, with or without 0x),
# never from argv, so it does not show in a process listing during the 20-35 minute proof.
M=000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f
echo $M | cargo run --release -p equiv-host -- prove raw   --secret-stdin raw.receipt
echo $M | cargo run --release -p equiv-host -- prove stock --secret-stdin stock.receipt
# for a real swap (Alice): swap-cli secret alice.swap.json | equiv-prove prove raw --secret-stdin alice.receipt
# (stock variant: pipe the wallet master secret m the same way; it is the m the stock-variant address A = Addr(Derive(m,0)) was built from)
# verify (Bob). Expected outputs for the known vector:
H=630dcd2966c4336691125448bbb25b4ff412a49c732db2c8abc1b8581bd710dd
cargo run --release -p equiv-host -- verify raw   $H f8183db204ffb765c7015d851c1754e4974c675b975c6738d9f6d138eb7212cf raw.receipt
cargo run --release -p equiv-host -- verify stock $H o125qayvgtmvqnlhqmqwe08dza3acaax5mct3u5h4uen3qtrds3jfset7wlk stock.receipt
```

Notes: add `EQUIV_REPRODUCIBLE=1` to the `prove`/`verify` lines too so the same ImageID is embedded (Alice and Bob must
run binaries with identical ImageIDs, which `image-id` prints). `prove` prints prove time, user/total cycles, segment count
and receipt size; record them in section 6. `prove` and `verify` both refuse to run with `RISC0_DEV_MODE` set, `verify` rejects a dev-mode (fake) receipt by kind, and the
binary is built with risc0's `disable-dev-mode` feature (REVIEW-3 G1, 2026-11-05: before that, a Bob whose shell still had the
variable set from an experiment would have accepted a receipt with no proof, because risc0's default verifier context reads
that variable). `prove` also refuses a remote prover (section 6). The host uses `ProverOpts::succinct()` (one STARK-in-STARK receipt). A Groth16 receipt is not needed because
verification is off-chain. Add `--features prove` to link the prover in-process instead of using `r0vm`. Use
`RISC0_SKIP_BUILD=1` only for `cargo check`.

Secret input (M2.7a). `prove <raw|stock> --secret-stdin [out]` reads exactly one line from stdin (64 hex characters, `0x` optional, any
case, one trailing newline allowed; empty input, a second line or a wrong length is rejected, and error messages never echo the secret).
The old positional form `prove <raw|stock> <hex m> [out]` was removed (2026-11-04); only `--secret-stdin` exists. Any other argument shape is refused with
exit code 2 and a message that says the secret must be piped, without echoing the argument (a secret typed by mistake never reaches a log). Neither
the guest, the journal nor the ImageID changed. `prove` also refuses a terminal on stdin (a typed secret would be echoed) and an output path that looks like a 64-hex secret.

If using SP1 instead: the guest body is the same three lines (read `variant`, `m`; call `equiv_guest_core::run`;
`commit_slice`); only the entrypoint (`sp1_zkvm::entrypoint!`) and the host (`ProverClient`, v6 API shown in
`sp1/examples/fibonacci/script`) differ; patch `sha2` with the SP1 precompile fork to avoid pure-software SHA-256.

## 6. Costs

Measured here (native, not zkVM):

| item | value |
|---|---|
| general GF(2^128) multiplications per permutation | 502 (180 S-box + 90 full-round MDS + 232 partial-round MDS) |
| squarings per permutation | 180 (GF(2)-linear) |
| permutations | RAW 1, STOCK 4 |
| native time, portable code, shift-and-add (release, 2 vCPU shared) | RAW ~0.14 ms, STOCK ~0.39 ms per statement |

Estimates (not measured; treat as +-3x):

* The guest uses a bit-serial multiply: ~128 loop iterations of 128-bit shift/xor per multiplication. On RV32IM each
  u128 operation is several instructions, so roughly 5-8k cycles per multiplication, ~3-4 M cycles per permutation,
  hence **RAW ~3-4 M cycles, STOCK ~13-16 M cycles** plus SHA-256 (tens of thousands without a precompile).
* At typical CPU proving speeds that is on the order of a minute for RAW and several minutes for STOCK on a laptop, with
  several 2^20-cycle segments joined into one succinct receipt. A succinct receipt is about a couple of hundred KB.
  These were the pre-run estimates; the measured values follow.

Measured (2026-11-03, owner's PC: WSL2 Ubuntu-24.04, 6 cores, **3 GB VM**, `r0vm` 3.0.6, `risc0-zkvm` 3.0.6,
risc0 rust 1.97.0, local non-docker guest build, `ProverOpts::succinct()`, known vector `m = 00 01 … 1f`):

| item | RAW | STOCK |
|---|---|---|
| ImageID, local build (the reproducible docker ImageID of M1.1 is still to be obtained) | `7e9d8477c67a9971bf38bd6a3eb217cfb0a4b224062b2f2059d578c61d1c6187` | same binary |
| cycles, user / total | 2,752,498 / 3,145,728 at 2^20 segments; 2,752,498 / 3,276,800 at 2^18 (estimate above was 3–4 M) | 10,973,103 / 12,845,056 at 2^18 (estimate above was 13–16 M); 3.99 × RAW, as expected for 1 + 3 permutations |
| segments | 3 (2^20) · 13 (2^18) | 49 (2^18) |
| prove time | 1,715 s at 2^20 · 1,180 s at 2^18 — both **memory-starved** (peak 2,892 / 2,739 MB of a 2,910 MB VM, heavy swapping); not representative | 4,544 s (1 h 16 min) at 2^18, same memory starvation (peak 2,742 MB); 3.85 × RAW |
| receipt size, bincode | 223,356 bytes (identical for both segment sizes) | 223,356 bytes (succinct receipts are constant-size regardless of cycles) |
| `verify` (Bob), incl. journal check | OK, < 1 s | OK, < 1 s (`A` given as the `o1…` string; journal `A` = `5501d231…8c93`) |

The host honours `EQUIV_SEGMENT_PO2=<n>` (default 20). On this machine it cut the prove time by a third but not the
memory peak: the floor (~2.7 GB) is the succinct recursion prover, not the segment prover, so budget ≥ 4 GB for
`r0vm` before quoting a proving time.

Negative tests of `verify` (automated, M1.4b; 2026-11-04). Unit tests in `zkvm/host/src/tests.rs` run against the real
receipts above (`raw.receipt`, `stock.receipt`, copied into a temp dir; originals untouched, md5 unchanged), gated on
`EQUIV_RECEIPT_DIR` (skipped with a `SKIPPED` line when unset or when the files are absent):

```
EQUIV_RECEIPT_DIR=~/zkvm-out cargo test --release -p equiv-host -- --nocapture   # in equiv/zkvm
```

Result: 22 passed, 0 failed, ~0.7 s (14 receipt/refusal tests at M1.4b, plus 6 stdin and `prove` argument-parsing tests from M2.7a and F4, plus 2 dev-mode tests from REVIEW-3 G1 on 2026-11-05; the verifier is cheap, nothing is proved). The check under test is
`check_receipt` (the function `equiv-prove verify` calls): `Receipt::verify(ImageID)` then journal `== variant||H||A`.
"Journal" below = the proof is genuine but the journal differs from the claimed values; "Receipt" = `Receipt::verify`
itself fails.

| test | cases | all rejected? | rejected by |
|---|---|---|---|
| positive control (raw with true H, A; stock with true H and `o125…`) | 4 | accepted, as it must | - |
| wrong `H` (bits 0, 7, 100, 255 flipped), raw and stock | 8 | yes | Journal |
| wrong `A` (bits 0, 63, 128, 255 flipped; plus the other variant's address), raw and stock | 10 | yes | Journal |
| wrong variant (raw receipt as stock, stock as raw, variant byte 2) | 3 | yes | Journal |
| tampered seal, structured (one bit of seal words 0, 1, n/4, n/2, n-2, n-1; n = 55,667) | 12 | yes | Receipt |
| tampered seal, raw file bytes (one bit in each of 64 evenly spaced bytes across the seal region of the 223,356-byte bincode file, plus one full-byte `0xff` flip written to disk and loaded by the CLI path) | 65 | yes | Receipt |
| one byte of the journal flipped inside the receipt file (variant, H, A positions), with and without claiming the flipped value | 10 | yes | Receipt |
| wrong ImageID (one bit in each of the 8 words, on both receipts; all-zero; all-ones; two words swapped) | 19 | yes | Receipt |
| foreign journal: genuine proof claimed for the other variant's `A` (2); raw proof carrying the stock journal and vice versa (2); forged valid-shape journal with attacker's `A` (1); 64-byte, 66-byte and empty journals (3) | 8 | yes | Journal (2), Receipt (6) |
| garbage files: empty, truncated to half, all zeros, missing | 4 | yes | deserialization / read |
| dev-mode (fake) receipt whose claim names our ImageID and whose journal is exactly `raw ‖ H ‖ A` (REVIEW-3 G1; needs no receipt file) | 1 | yes | Receipt, by kind, before `Receipt::verify` |
| `RISC0_DEV_MODE` set to `1`, `true`, `yes`, `0` or empty: `prove` and `verify` refuse before reading anything (REVIEW-3 G1) | 5 | yes | refusal (exit 2) |

So the journal comparison and the proof are tested separately: wrong `H`, `A` and variant only reach the journal
comparison (the proof is genuine), whereas the seal, journal-splice and ImageID cases are the verifier rejecting a bad
or mismatched proof. CLI spot checks on a copy of the raw receipt: `verify raw H A` → OK (exit 0); `verify stock H A`
→ `INVALID: journal does not equal variant||H||A` (exit 2). Not tested: a receipt of a *different guest* with its own valid
proof (no second guest was built), so "wrong ImageID" is shown only by changing the ID the verifier checks against.

Remote proving refusal (M1.4a). `equiv-prove prove` now exits 2 before doing anything when the environment could send
`m` off the machine. Variable names, taken from `risc0-zkvm-3.0.6/src/host/client/prove/mod.rs` (`default_prover()`):
`BONSAI_API_URL` and `BONSAI_API_KEY` (Bonsai is selected when both are set; the host refuses if either is set, even
empty) and `RISC0_PROVER` (documented values `bonsai`, `local`, `ipc`, plus `actor`; the host allows only `ipc` and `local`
and refuses anything else). Not refused, because local: `RISC0_SERVER_PATH` (path of the local `r0vm`; it receives the
secret, so point it only at a binary you trust), `RISC0_EXECUTOR`, `EQUIV_SEGMENT_PO2`. The host is built with
`risc0-zkvm` features `client` only (no `bonsai` feature), so Bonsai is not even compiled in, but the guard is
unconditional in case feature unification ever enables it. Tests: `prove_allowed_with_clean_or_local_environment`,
`prove_refused_when_bonsai_variables_set`, `prove_refused_when_remote_prover_selected` (pure, always run, no process-env
mutation). Manual check: `BONSAI_API_KEY=x`, `BONSAI_API_URL=…`, `RISC0_PROVER=bonsai` each give
`error: refusing to prove: …`, exit 2, no output file.

* Cheap guest speedups, in order of value: (1) 322 of the 502 multiplications per permutation are by **fixed
  constants** (MDS entries) and are GF(2)-linear, so they can be table-driven (byte-sliced lookup tables, computed at
  compile time) instead of bit-serial; (2) windowed (4-bit) multiplication for the 180 variable multiplications;
  (3) 32-bit limbs instead of `u128`. Together plausibly 5-10x. Not done: the task asked for the simple version first,
  and the bit-serial code is the one directly verifiable against `clmul_gcm`.
* The report's circuit estimate (not measured by me, but consistent with the count above: 180 non-linear multiplications
  per permutation, since squaring and constant multiplication are linear): about 0.4 M AND gates RAW, 1.6 M STOCK,
  plus ~22 k for one SHA-256 block.

## 7. Trust assumptions

1. **Soundness of the zkVM** (RISC Zero: the STARK/recursion circuits, the verifier, 98 bits conjectured as stated by
   the project, i.e. below the usual 128-bit target) and of the guest toolchain. Bob must obtain the ImageID by his own
   reproducible build (or from an audited release), never from Alice. A malicious ImageID makes the proof meaningless.
2. **Zero knowledge, not only soundness.** `m` is the live secret: whoever learns it before Alice claims on the BTC/ETH
   chain can race her (RAW: claim authority; STOCK: the whole wallet). The proof system must therefore hide `m`
   completely. RISC Zero claims this; I have not audited it, and the claim must be re-checked for the exact version and
   receipt type used. Further leak channels to close:
   * `m` must be uniformly random 32 bytes; the proof hides `m` but not against guessing from a low-entropy `m`.
   * Alice's machine runs the prover: do not use remote proving (Bonsai or any prover network) for a live `m`, and
     do not run dev mode.
   * Bob must receive the receipt only; never logs or the executor environment.
   * Generate the proof before `m` is ever revealed on the other chain, then discard the witness.
3. **Fidelity of the statement to the real chain.** Equivalence of the portable code with the vendor crate is tested
   (section 3), but the vendor primitive itself and the claim that the node's wallet derives addresses this way are
   assumptions: see "Important limit of the Derive test". A one-time real-wallet check is recommended.
4. **Poseidon2b security**: `Addr` is a single permutation truncated to 256 bits, with all round constants <= 0x2000
   (a small subfield; the doc flags a possible Frobenius-type symmetry). Binding of `H` to `A` rests on preimage and
   collision resistance of that construction. Flagged for cryptographer review, out of scope here.
5. Standard: SHA-256 preimage resistance (BTC/ETH side).

## 8. Alternatives

* **Binius-style binary-field SNARK (the right long-term choice).** Poseidon2b is defined over GF(2^128) in tower
  basis (the vendor code is "adapted from binius_poseidon2b"), so the permutation is a natural fit: ~180
  non-linear multiplications per permutation, everything else linear. Proof size and time would be orders of magnitude
  below a general RISC-V zkVM, plus a SHA-256 gadget (~22 k gates). The vendor tree already contains `noid_fri_binius`
  and `noid_gkr`, which may be reusable; whether its authorization capsule is actually zero-knowledge is one of the open
  questions in the capabilities doc. Binius proofs are not zero-knowledge by default; blinding / a ZK PCS must be added,
  which is the same requirement as in section 7.2.
* **Hand-written circuit.** Boolean circuit (ZKBoo / Ligero / garbled-circuit style, or R1CS with bit decomposition):
  fully specified and small enough (0.4 M / 1.6 M AND gates), zero knowledge is native to ZKBoo-class systems, but it
  is the most engineering work and gives no tooling for ImageID-like program binding.
* **Trivial interactive alternative for v1 trials between parties who already trust each other somewhat.**
  (a) Alice sends `m` to Bob (or a mutual escrow) before he locks; Bob checks `sha256(m) = H` and `Addr(m)` (or
  `Addr(Derive(m,0))`) = `A` with `equiv-ref`. No proof needed.
  (b) Cut-and-choose: Alice commits to N pairs `(H_i, A_i)`, Bob asks for the secrets of N-1 of them and checks
  both relations, the unopened one is used for the real swap.
  **Why it is unacceptable for strangers:** in (a) Bob learns `m` before funding, and since `claim_authority = A(m)` is
  derived from `m` he can claim the NOID himself (recipient is his anyway) without ever locking his BTC/ETH, so Alice
  must trust Bob not to; in (b) a cheating Alice escapes with probability 1/N, which is a total loss of the swap value
  for Bob, so N would have to be enormous and both parties online; and the opened secrets are burned. Both are fine for
  mutual-trust dry runs, neither is a trustless protocol. The zkVM (or Binius) proof removes both problems:
  Bob learns nothing about `m` and the check is non-interactive.

## 9. Open issues

* No zkVM toolchain installable here: no measured cycles, proving time or proof size. Run section 5 on a machine
  with normal internet and fill section 6.
* Derive is verified against its cited source and the report's `o125...` vector, but never against a real running
  wallet.
* ZK property of the chosen proof system and receipt type is taken from the vendor's documentation, not audited.
* Guest multiplication is deliberately naive; a 5-10x cycle reduction is available (section 6) if proving cost matters.
* The 98-bit conjectured security of RISC Zero's default parameters is below 128; decide whether that suffices
  for the swap value.
* The v2.1 authorization switch at height 279,370 (doc "Implications" 5) is orthogonal to this statement but affects
  swap timing.
