# swap-cli — the two-role NOID ↔ ETH swap tool (M2.3–M2.6, plus the live-network layer)

A standalone Rust package (`swap_cli`, library + `swap-cli` binary) that holds the
state machine, the persisted swap file, the chain watchers, the automatic actions
and Bob's two claim clients of `docs/protocol-design.md` §7 and §10 M2. The tests need
**no network, node or funds** (the only sockets are loopback mocks inside the test
process). Every chain interaction goes through a trait; besides the fixture/mock
implementations there are now live ones: `HttpJsonRpc` (plain `http://` on
`std::net`), `ExecJsonRpc` (spawns `curl`, which also reaches `https://`) and
`RecordingRpc` (writes what a live call returned as a replayable fixture). The only
command that can send anything to a chain is `swap-cli claim … --submit`.

Plain words for the pieces (the design doc explains them in full):

- the *secret* is 32 random bytes only Alice knows; its SHA-256 is the *hashlock*
  published on Ethereum and its Parano1d address is the *claim authority* of the
  NOID lock. Publishing the secret on Ethereum (the *reveal*) is what lets Bob claim.
- a *timeout* is the height or time after which a party can take its own funds back
  if the other side never acted: `D` on Parano1d (Alice's refund), `T_reveal` on
  Ethereum (Bob's refund).
- the *gates* (I1)…(I5) are the inequalities that keep each party safe: Bob only locks
  when there is enough time to claim after the latest possible reveal; Alice only
  reveals early enough that her Ethereum claim is final before Bob's refund opens.

## Layout

| Path | What | Status |
|---|---|---|
| `src/secret.rs` | `Secret` (zeroized, redacted `Debug`), `H = SHA-256(s)`, `Addr(s)` / `Addr(Derive(m,0))`, the `0x`/no-`0x` hex rules, Bob's step-11 `check_preimage` | tested against the §0 vectors |
| `src/params.rs` | §9.1 constants and the gates: `rhs_i1_eth` (629), `bob_lock_by` (`D − 629`), `t_max_eth`, `choose_t_reveal` (I1 + `W_A_min` + `B_bob`), `check_i2_eth` (reveal cutoff `T_reveal − M_A`), `classify_claim_height` (`D − 18` target, `D − 1` hard), `check_i5` (no 279,370 in `[H_create, D + 252]`, start ≥ 279,388), `fee_cap`, epoch anchor / T6 rotation guard | pins the §4.3 worked example |
| `src/swapfile.rs` | **M2.3** the swap file: `SwapPublic` (hashlock, authority, 699-byte opening hex, root, params; `check()` rebuilds the opening byte-for-byte through the M0.6 guard), `SwapFile` (role, phase, history, `pending_action`, sealed secret), atomic save (unique `.<pid>.<random>.tmp` + fsync + rename) and `SwapLock` (exclusive `.lock` sidecar), the `pending_intent` ledger, `HashlockRegistry` (T9) | secret at rest: Argon2id → XChaCha20-Poly1305, AAD = digest of the public section |
| `src/state.rs` | `AlicePhase` / `BobPhase`, `Event`, `transition()`: every allowed move, nothing else | unit-tested |
| `src/watch/mod.rs` | `JsonRpc` transport trait, `FixtureRpc` (replays `{"calls":[{method, params?, result|error}]}`), `NoidObservation`, `EthObservation`, the JSON-RPC envelope helpers | |
| `src/watch/http.rs` | `HttpJsonRpc`: HTTP/1.1 `POST` over `std::net::TcpStream`, `http://` only; reply by Content-Length, chunked or to EOF; one deadline for the whole call (default 30 s); HTTP ≠ 200 → `Transport`, JSON-RPC `error` → `Remote` | 9 unit tests against a loopback listener (Content-Length, chunked split across writes, no length, HTTP 500, 401, JSON-RPC error, malformed replies, timeout, connect refused) |
| `src/watch/exec.rs` | `ExecJsonRpc`: spawns `curl` (default `/mnt/c/Windows/System32/curl.exe` if it exists, else `curl`) with the request on stdin; reaches `http://127.0.0.1:9601` from WSL and any `https://` endpoint; watchdog kills a hung program | 6 unit tests with fake shell-script programs (no socket, no curl) |
| `src/watch/record.rs` | `RecordingRpc`: wraps any transport, appends every node answer (result or JSON-RPC error; never transport failures) to a fixture file `FixtureRpc` replays; refuses to overwrite a recording | 1 unit test + round trip through the binary |
| `src/contract_params.rs` | the Parano1d contract parameters of a swap in the forms the stock wallet takes (`pruv` params, SDK definition JSON), compiled through `noid_pruv` and checked against the swap file's 699-byte opening; `check_object_file` | tested (`tests/alice_params.rs`) |
| `src/watch/parano1d.rs` | **M2.4** Parano1d watcher: tip, epoch anchor, fee floor and estimate, our instance (`getObjectInstances`/`getObjectStatus`), pending calls whose mempool opening is ours, tracked txid | method names and shapes **verified against the live node 2026-11-04** (table below); `idle.json`, `recorded_misc.json` and six LIVE RUN 1 files (funded unfinal / final / first seen, claim pending / included / final) are real recordings of the first real swap; `funded.json` (drives the `cli.rs` tick test) and `pending_claim.json` (a second contract's call next to ours) stay synthesized; drift-guard test over the vendor source |
| `src/watch/eth.rs` | **M2.4** Ethereum watcher: `Locked`/`Claimed`/`Refunded` logs for our lock id, `getLock` cross-check, `eth_getCode` (T11), preimage from **pending** `claim` calldata; `compute_lock_id`, keccak topics/selectors | fixtures **recorded** from Hardhat 2.29.1 by `eth/scripts/record-fixtures.js` |
| `src/engine.rs` | **M2.5** `decide(file, noid, eth, now)` → facts + one `Action`; `Runner` persists before and after every action; a pending action with an unknown outcome is held (never re-funded, never aborted away), a lock is resent with its recorded `T_reveal`; `expected_lock_id` | scenario-tested |
| `src/client/raw.rs` | **M2.6** client R: builds the 1-in/1-out close like the node's wallet, `check_call` preflight, `noid_gkr` proof with the height's authorization version, self-verification, `ObjectIntent` bytes, fan-out submission via `IntentSubmitter`; `RawClaimExecutor` plugs into the engine | real proofs in tests, submission mocked |
| `src/client/stock.rs` | **M2.6** client S: the scripted stock-wallet fallback (`--import-wallet-secret` into a throwaway data dir, `contract call --close --preview`, then `--expected-txid` at the same height) through a `CommandRunner` trait | nothing is spawned; mock runner in tests |
| `src/equiv.rs` | **REVIEW-2 F2** `verify_receipt`: runs `equiv-prove verify <variant> <H> <A> <receipt>` (H, A from the bundle) through `CommandRunner` (`Step::EquivVerify`), parses `OK` + `image id`, checks the image id against the compiled-in `EQUIV_IMAGE_ID`, builds the `receipt` attestation; `ProcessRunner` is the real runner and runs that one step only | `tests/equiv.rs` (fakes + a shell-script stand-in for the binary) |
| `src/params.rs` (profiles) | `ProfileName` (`production` default, `rehearsal`, `sepolia`) and `Gates` (`PRODUCTION`, `REHEARSAL`, `SEPOLIA`): every timing number, the caps, `validate()`; the gate functions are methods on `Gates` | see "The rehearsal and sepolia profiles" |
| `src/params.rs` (contract versions) | `ContractVersion` (`V1` default, `V2`): `allowed_fee_range(max_fee)`, `is_fixed_fee()`, `source_path()`; `engine::close_fee_for(version, …)`; `swapfile::detect_contract_version(opening)`; `SwapParams::{fixed_close_fee, expected_bob_payout}` | see "Contract versions" |
| `src/main.rs` | `swap-cli new-alice | new-bob | bundle | status | tick | claim | alice-params | gates`; `tick`/`claim` take a fixture or a live node per chain (`--transport tcp|curl`) | `claim` is a dry run unless `--submit` |
| `tests/` | `scenarios.rs` (M2.5; also the rehearsal- and sepolia-profile scenarios), `equiv.rs` (F2), `rehearsal_cli.rs`, `resume.rs` (M2.3), `client_r.rs`, `client_s.rs`, `watch_eth.rs`, `watch_parano1d.rs`, `cli_live.rs` (flags, tick/claim over a loopback mock node), `alice_params.rs`, `contract_version.rs` (the version through the files and the binary); `common/mod.rs` is a two-chain simulator (it enforces the v2 fee rule on every close), `common/http_node.rs` a loopback JSON-RPC server | |
| `fixtures/` | `eth/*.json` recorded (Hardhat); `parano1d/idle.json`, `parano1d/recorded_misc.json` and the six LIVE RUN 1 files `parano1d/recorded_{funded_unfinal,funded_final,funded_first_seen,claim_pending,claim_included,claim_final}.json` recorded from the real node; `parano1d/{funded,pending_claim,malformed}.json` synthesized (each file's `description` says which) | |
| `REVIEW-1.md` | independent review of the load-bearing code | |

## Running the tests

Rust builds only inside WSL on the owner's machine (Ubuntu-24.04). The
package is its own workspace with path dependencies on `../parano1d/harness` and
`../vendor/parano1d/*`; it shares the harness's `Cargo.lock` so the compiled vendor
crates in the shared target directory are reused.

```sh
cd /mnt/c/Users/00/Documents/noid-swap/swap-cli
CARGO_TARGET_DIR=$HOME/noid-target CARGO_BUILD_JOBS=2 cargo test --no-fail-fast
```

First build about 1–2 minutes (the vendor crates are already built if the harness
was); the suite itself runs in well under a minute, of which `client_r` spends
about 8 s on real authorization proofs. No test reaches outside the machine (the HTTP tests use loopback listeners inside the
test process, the `curl` tests use fake shell scripts); `cargo` fetches four small crates from crates.io on the first build
(`chacha20poly1305`, `argon2`, `sha3`, `getrandom`) and nothing else. Use `--offline`; the live layer adds no crate.

Expected: every test binary green (unit 102, the binary 5, `alice_params` 3, `chaos` 3, `chaos_fixes` 23, `cli` 7, `cli_live` 15 (+1 `#[ignore]`d helper),
`client_r` 9, `client_s` 16, `contract_version` 11, `equiv` 13, `intents` 13, `rehearsal_cli` 12, `resume` 8, `review4` 19, `review5` 14, `scenarios` 92, `watch_eth` 18,
`watch_eth_discovery` 6, `watch_parano1d` 29: 418 tests (+1 ignored) at that point. The suite now runs 470 (+1 ignored) with the `poseidon_*` test binaries and later review fixes added; the per-binary counts above were not re-taken. It was 404 before the REVIEW-5 fixes, 385 before the REVIEW-4 fixes, 362 before the chaos-test fixes (`CHAOS.md`), 359 before the chaos test, 349 before M2.5b, 325 before the REVIEW-3 fixes, 318 before the REVIEW-3 F3 work, 291 before the F5 second-node, header-time and plain-HTTP work, 267 before the F9 leftover-leg cleanup and the F10 every-lock/every-instance work, 251 before the F6 reorg tracking and `tick --closed-by`, 240 before the per-version `max_fee` rule and the relay-floor note, 225 before the sepolia profile, 203 before contract versions, 173 before the F2 receipt
check and the rehearsal profile, 157 before REVIEW-2). Use `--offline --no-fail-fast`. The crate lists itself as a
dev-dependency with the `dev` feature (no new external crate), which is what gives `cargo test` the fast KDF.

Re-record the real-node fixture (WSL, node running; read-only calls, see "Live run" for the flags):

```sh
EXAMPLE_BOB_OUT=$HOME/bob33.swap.json cargo test --offline --test cli_live -- --ignored write_example_bob_file
swap-cli tick $HOME/bob33.swap.json --transport curl --noid-rpc http://127.0.0.1:9601    --record-noid idle.new.json --eth-fixture fixtures/eth/locked.json
# then update IDLE_TIP / IDLE_ANCHOR_HEX in tests/watch_parano1d.rs from the new file
```

Re-record the Ethereum fixtures (Windows, Node ≥ 21, after `cd eth && npm install`):

```sh
cd eth && npx hardhat run scripts/record-fixtures.js
```

## The CLI

```sh
export SWAP_PASSPHRASE='a long passphrase'          # never on the command line
swap-cli new-alice --out alice.swap.json --alice o1… --bob o1… --amount 10000000 \
   --fee-estimate 5800 --h-create 300000 --eth-contract 0x… --eth-chain-id 11155111 \
   --eth-amount-wei 10000000000000000 --eth-receiver 0x… --eth-sender 0x… \
   # --eth-chain-id is MANDATORY (no default). --eth-code-hash is OPTIONAL: the keccak256 of the HTLC runtime code is a
   # constant of this build (params::HTLC_CODE_HASH, REVIEW-3 F1); omitted = that constant, given = it must be equal, else refused.
   # Prints the bundle for Bob.
#   add --contract-version 2 for HashTimeLockV2 (every close pays exactly max_fee); default 1 = HashTimeLock; see "Contract versions"
#   (v2 only: --floor-seen MICRONOID = the highest relay floor you saw in the last 24 h; max_fee = max(50,000, 5 x max(estimate, floor)))
# Bob passes HIS terms (never read from the bundle) and the receipt Alice sent. REVIEW-2 F2: the tool itself runs
# `equiv-prove verify <variant> <H> <A> <receipt>` (equiv/README.md section 5) with H and A taken from the bundle,
# requires exit status 0, reads the image id it prints, and requires it to equal the image id compiled into this tool
# (params::EQUIV_IMAGE_ID, REVIEW-3 F2: `7e9d8477…6187`, the LOCAL build's id until the reproducible docker build, milestone M1.1, is
# done). Nothing about the proof is typed; --pinned-image-id is optional and, if given, must equal that constant (no override):
swap-cli new-bob --bundle bundle.json --out bob.swap.json --bob o1… --amount 10000000 --eth-chain-id 11155111 \
   --eth-contract 0x… --eth-amount-wei 10000000000000000 --eth-sender 0x… \
   --receipt swap.receipt --equiv-prove /path/to/equiv-prove
#   --variant raw|stock defaults to the bundle's here; --profile (production|rehearsal|sepolia) and --contract-version must equal the bundle's (defaults: production, 1).
# REVIEW-3 F2: --receipt and --equiv-prove are the ONLY form under production and sepolia. The typed form
#   ... --equiv-h 0x… --equiv-a o1… --equiv-image-id <printed>
# (nothing is verified by this tool; the file records source "typed") is accepted under the rehearsal profile only, and a typed file
# in any other profile is refused on load. (With --receipt these three flags are optional and, if given, must agree with the bundle and the verifier.)
swap-cli status alice.swap.json
swap-cli tick bob.swap.json --noid-fixture fixtures/parano1d/funded.json \
   --eth-fixture fixtures/eth/locked.json --now 1794312000                  # watchers over fixtures, decision printed
#   tick WITHOUT --apply records nothing, so for a spend (fund_noid, lock_eth, reveal_eth, refund_eth, refund_noid) it prints only
#   {"kind": ..., "parameters": "withheld", ...} (REVIEW-3 F3); tick --apply records the intent first and then prints the parameters
swap-cli intent bob.swap.json [--show]                                      # the frozen intent, if any
swap-cli intent bob.swap.json --cancel <the tick chain flags>               # drops an intent that was never sent; fails closed (below)
swap-cli gates --d 300735 --h-now 300040 --t-now 1794312000 --h-final 300022
```

### Data sources: fixture or live node, per chain

`tick` and `claim` read each chain from exactly one of `--noid-fixture FILE` / `--noid-rpc URL`
and `--eth-fixture FILE` / `--eth-rpc URL` (both or neither is an error; each flag may be given twice for a second node, see "F5" below).

| Flag | Meaning |
|---|---|
| `--transport tcp\|curl` | `tcp` (default): the built-in `http://` client, no TLS. `curl`: spawn `curl`; reaches `https://` and, inside WSL, the Windows host's loopback |
| `--curl-path PATH` | the program for `--transport curl` (default `/mnt/c/Windows/System32/curl.exe` if that file exists, else `curl`) |
| `--rpc-timeout SECS` | connect + write + read deadline per call (default 30) |
| `--record-noid FILE` / `--record-eth FILE` | live sources only: write every node answer to a new fixture file (`description` starts `RECORDED from …`, with date and chain height); replay it later with `--noid-fixture FILE`. An existing file is never overwritten |
| `--eth-from-block N` | first block `eth_getLogs` searches. Give it once: `tick --apply` and `claim --submit` store it in the swap file (history entry `eth_from_block_set:N`) and later commands reuse it without the flag; a flag given again wins and replaces the stored value on the next `--apply`. Without the flag and without a stored value the default is 0 on a local chain (31337, 1337) or with a fixture, and a live node on any other chain is refused (REVIEW-3 F7). The tick's `sources.eth_from_block` shows the value used. Public Ethereum nodes cap the range: `ethereum-sepolia-rpc.publicnode.com` answers `exceed maximum block range: 50000`, so pass a block shortly before the lock. A recording pins this value: replay with the same `--eth-from-block` |
| `--now UNIX` | FIXTURES ONLY (REVIEW-2 F12): refused together with `--noid-rpc` or `--eth-rpc`, because it rewrites both `observed_at` stamps and would switch the staleness rule off |
| `--pending-tx 0x…` | as before |
| `--reveal-tx 0x…` | (`tick`, `claim`, `intent --cancel`) one transaction hash: a claim of Alice's that `live.js` reported as mined and REVERTED. The watcher reads it and its receipt from the node (every Ethereum node given) and accepts it only as a call to the pinned contract's `claim` of THIS lock id from `alice_receiver` whose preimage opens the lock word; see "What REVIEW-6 changed" |
| `--closed-by TXID` | `tick` only (M2.5d). Record a close made OUTSIDE this tool, e.g. Alice's recovery close with the wallet CLI (`contract call --close`): see "Closes made outside the tool" below. Writes only together with `--apply` |

`tick` never executes an action: it prints the facts it would record and the one action the engine
wants, and with `--apply` records the facts in the file and, for a spending action, the intent (next section). Without `--apply`
it records nothing, so for a spending action of the intent ledger it prints the kind only (`"parameters": "withheld"`; REVIEW-3 F3), also in
`claim` when the engine's action is not `claim_noid`. A fixture belongs to one swap: the
Parano1d fixtures pin the opening they were made for (`example_public(seq_bytes(0x33), Raw)`), so
`tick` on another swap file stops with "called with params … but the fixture recorded …" instead of
silently reusing answers meant for a different contract (`tests/cli.rs` pins both behaviours).
Node URLs are never printed in full (an API key may be in the path); output shows `scheme://host:port`.
Both roles record `eth_refund_mined` when the ETH observation shows the swap's lock refunded; for Bob it moves him to `refund_mined` (M2.5b: not terminal; `refunded` only after `eth_refund_final`, see below), for Alice it is log-only (same phase, same action: she keeps the secret and waits for `D`), written once because the history already holds it.

**Reorg handling (F6).** A close that is "included" is not "final" until the NODE still says so. Bob's `claim_included` and Alice's
`refund_included` keep the transaction id tracked: every `tick` asks `paranoid_getTx` and `paranoid_getMempoolEntry` about it, and
`noid_tx_final` (then `done` / `refunded`) needs both the 17-block depth AND a `getTx` answer that still gives the recorded height on that very
tick. If the node says the transaction is no longer confirmed there (a rollback of up to 17 blocks), the phase steps back: still in the mempool,
Bob returns to `claim_submitted` and Alice to `refund_submitted` (event `noid_tx_reorged`); in neither chain nor mempool, Bob returns to `secret_seen`
(the engine then says `claim_noid` and he proves again; `claim_included` now carries the secret and the re-proof counter for this) and Alice to the
phase from which `refund_noid` is offered again (the same step an eviction takes). A transaction confirmed again at a DIFFERENT height is a
re-inclusion (`noid_tx_reincluded`): the recorded height changes and the 17-block count starts over. A poll that did not ask the node about the
txid at all (`tracked_tx_pending: null`, e.g. a recording made before F6) is never read as a reorg and never as final: the tick adds a note and waits.
`tests/scenarios.rs` (`f6_*`) drives all of it on the two-chain simulator.

**Phases added by M2.5b (2026-11-05).**

| Role | Phase (`name()`) | Terminal | Meaning | Leaves by |
|---|---|---|---|---|
| Bob | `refund_mined` | no | his `refund_eth` is mined at `block_number` but Ethereum has not finalized that block (the F6 rule applied to the ETH leg); the action is `wait` ("ETH refund mined at block N; waiting for Ethereum finality (finalized block F)") and nothing is sent again | `eth_refund_final` -> `refunded`; `eth_refund_mined` at another block (re-inclusion: the count starts over, same phase); `eth_refund_reorged` -> `locked` (the refund vanished, the lock is open: `refund_eth` is offered again); `eth_preimage_seen` -> `secret_seen` (a reorg replaced the refund by Alice's claim: the ETH is hers, the NOID is his to take) |
| Bob | `refunded` | yes | the refund is final on Ethereum (before M2.5b it was reached as soon as the refund was mined) | |
| Alice | `lost` | yes | both legs are gone: her reveal was still pending when Bob's refund of the lock was mined (the reveal reverted, its calldata had published the secret), Bob closed the NOID instance with it, and the refund is final | reached from `reveal_submitted` by `both_legs_lost`, only when ALL hold: the refund of her lock is final on Ethereum, no claim of hers is mined, the tip is at least `D + 18`, her recorded instance is gone, and no `refund_noid` was ever decided for the swap (otherwise a note asks for `tick --closed-by`) |

Events: `eth_refund_final`, `eth_refund_reorged`, `both_legs_lost` (the last carries the refund block and the reason). In `reveal_submitted`, once Bob's refund of her
lock is known and no claim of hers is mined, Alice's action is `wait` with "our reveal lost: Bob's refund of lock 0x... was mined at ETH block N (final / not final
yet); the reveal can no longer succeed, and its calldata published the secret, so Bob can still claim the NOID before D ...; refund_noid opens when the next call
height reaches D if the instance is still there" instead of "ETH claim pending", and the `eth_refund_mined` note is "Bob's refund of our lock was mined ... while our
reveal was pending" (the "ANOMALY" note is kept for `revealed`, where a refund next to a mined claim really is a contradiction). `refund_noid` at `D` works as before.

**Closes made outside the tool (`tick --closed-by TXID`, M2.5d).** If the instance was closed by something this tool did not send (live run 2: Alice
recovered her NOID with the wallet CLI, so her file stayed in `lock_final` with "nothing to refund (already closed?)"), tell the tool which
transaction did it: `swap-cli tick alice.swap.json … --closed-by <txid> --apply`. The tick asks the node about that txid and records the close only if
(1) it is confirmed (`getTx` gives a height) and (2) the instance is gone. Alice then moves to `refund_included` (requires height `>= D`; from
`funded`, `funding_final`, `lock_seen`, `lock_final` or `refund_submitted`) and Bob to `claim_included` (requires height `< D`; from `secret_seen` or
`claim_submitted`), and the same tick follows the finality rules above (`refunded` / `done` once 17 blocks deep). It refuses, with a message and
no change to the file, when: the txid is not 64 hex characters; the txid is unknown to the node or only in the mempool; the instance is still
visible; the height is on the wrong side of `D` for the role (a close before `D` paid Bob, at or after `D` paid Alice); the phase makes no sense
(`created`, `funding_submitted`, `received`, terminal phases, Alice after her reveal, Bob before he knows the secret); or the file already tracks a
different transaction. Without `--apply` it prints what it would record (`closed_by` in the JSON, `WOULD RECORD` in the notes) and writes nothing.
What it cannot know: `paranoid_getTx` returns only `{tx_hash, height, block_hash, tx_position}`, no outputs, so the payout is not read from the
chain; it follows from the branch rule the block proof enforces. The tool cannot prove that the txid is the call that closed THIS instance (only that
it is confirmed and that the instance is gone), so check it against the wallet's receipt. `paranoid_getObjectStatus` / `getObjectInstances` do not
name the closing transaction of a gone instance, so there is no automatic detection: the flag is the way.

`--transport curl` only accepts `http://` / `https://` URLs. With `--transport tcp` an `https://`
URL is refused with a pointer to `--transport curl`.

### F5: second node, header time, plain HTTP

REVIEW-2 F5: a node that lags (200 blocks behind, answering in 1 s) or lies looked exactly like a healthy one, because
`observed_at` only says how old the *poll* is. Three additions, all offline-testable, none changes what a single healthy loopback node does for
watching, claims or refunds.

**1. The chain's own age.** The Parano1d watcher ends every poll with `paranoid_getBlockHeader [tip]` (declared in `api.rs`; the reply's
`timestamp` is Unix seconds) and stores it as `NoidObservation.tip_time`. A node or a recording without the method (or a `null`, or a header
without a timestamp) gives `tip_time = null`: unknown, never an error in the watcher, so every older recording still loads (the engine
then refuses to spend on it, below). The engine (`f5_gate`, run after
`spend_blocker`) then holds a spend with `Wait` when the tip block trails the clock by MORE than 10 x the 30 s target = **300 s** (the review suggested 3 x; measured on 2026-11-04, a healthy node showed block gaps up to 180 s and tip trails of 108 and 171 s at random readings)
("noid tip header time trails the clock by 412 s (limit 300 s): the node lags (F5)"). It applies to `fund_noid`, `lock_eth`, `reveal_eth`,
`claim_noid` and `refund_noid`; not to `refund_eth` (an Ethereum action that never reads the NOID side). With `tip_time` unknown the spend is held too (REVIEW-3 F5, fail
closed): "noid tip header time unknown: the node did not answer paranoid_getBlockHeader ... use a node that answers it (F5)". A recording made
before F5 has no header time, so replaying it shows this blocker instead of a spend. Parano1d blocks are exponential-ish around 30 s, so a healthy node occasionally trails by more than 90 s and, rarely, by more than 300 s (a few
percent of polls): the engine waits and the next tick passes. On Ethereum the same idea uses `latest_timestamp`: `lock_eth` and `reveal_eth` hold
when the latest block trails the clock by more than **600 s** (Sepolia and mainnet blocks are 12 s apart). The `rehearsal` profile skips that
Ethereum rule, with a note: its chain is a local Hardhat node, and in automine mode it makes no blocks while idle, so the latest block can be
old without the node being behind. (Interval mining passes either way.)

**2. A second, independent node.** Give `--noid-rpc` twice and/or `--eth-rpc` twice (or `--noid-fixture` / `--eth-fixture` twice, which is how
the tests do it; do not mix a fixture and a url for one chain). **The second must be a different endpoint** (REVIEW-3 G3): URLs are
compared after trimming, lower-casing scheme and host, making the default port (80 / 443) explicit and reading `127.0.0.1`, `localhost` and
`[::1]` as one host; the same scheme, host and port is refused whatever the path, query or credentials ("--noid-rpc: the second node must
be a different endpoint (both are http://...)"; one provider's two API keys are one node), and so is the same fixture file twice (by path
or by canonical path). A different port on the same host is accepted with a note in the tick (`--noid-rpc: both nodes are on the host ...
shares its network view`), since a second node on the same machine is a weaker check. Two hostnames of one provider cannot be told
apart: choose the second node from another operator. The first is the primary: recorded by `--record-*`, the one `claim --submit`
reads and signs against. The second is polled in the same tick (for Parano1d without a tracked txid) and attached as `second` inside the first
observation; `sources` in the output lists it as `noid_second` / `eth_second`. If the second node cannot be read, the tick still succeeds and the
reason is attached as `second_error`; the two steps below then wait, whatever the profile. What is compared:

| Step | Needs | Compared (second node vs first) |
|---|---|---|
| Bob `lock_eth` | a second Parano1d node | the same instance (slot index, creation id, amount) after the same dust filtering the engine applies to the first; tips at most **2** blocks apart; the second poll no older than 120 s |
| Alice `reveal_eth` | a second Ethereum node | the same lock record (lock id, amount, receiver, timelock, claimed, refunded); the pinned chain id and contract code hash; `finalized` heights at most **64** blocks apart (two epochs); the lock final at the LOWER of the two heights; the second poll no older than 120 s |

A disagreement is a `Wait` whose reason names both answers ("the two noid nodes' tips are 3 blocks apart (limit 2): node 1 at …, node 2 at …"); no
secret is in it. With ONE node configured:

| Profile | `lock_eth` / `reveal_eth` with one node |
|---|---|
| `production`, `sepolia` | `Wait`: "a second node is required before this step (F5); pass --noid-rpc / --eth-rpc twice, or --single-node-ok to accept the risk" |
| `production` or `sepolia` + `--single-node-ok` | proceeds, note "single node: F5 cross-check not possible" |
| `rehearsal` | proceeds, the same note |

(`sepolia` joined `production` in REVIEW-3: a swap with a stranger there has real value on the NOID side.)

**Bob waiting on a foreign pending close.** Where Bob's claim waits because the primary node shows a pending call on the instance (T2), a
second Parano1d node that shows NONE ends the wait: the note "the primary node reports a pending call the second node does not see: not
waiting on it (F5)" is added and the claim decision goes on (a lying primary could otherwise keep Bob waiting until the claim branch
closes). The second opinion counts only if its poll is fresh and its tip is within 2 blocks of the first; with no second node, an unreadable
one, a stale or lagging one, or one that shows the pending call too, the wait stands (a lagging node has not seen the call yet).

Watching, claims (`claim_noid`), refunds (`refund_noid`, `refund_eth`) and `fund_noid` never wait for a second node. Each party must still run
their own Parano1d node: two providers you do not control are not independent of the network path between you and them.

**3. Plain HTTP only to this machine.** An `http://` URL whose host is not `127.0.0.1`, `localhost` or `[::1]` (any port) is refused while the
transport is built, before any connection, with either transport ("plain HTTP to a non-loopback host can be tampered with in transit; use https://
with --transport curl, or --allow-plain-http"). `http://127.0.0.1@elsewhere/` counts as `elsewhere`. The owner's WSL to Windows path is unchanged:
`--transport curl http://127.0.0.1:9601`. `https://` goes through `--transport curl` as before. The check applies to `--submit-rpc` URLs too.

| New flag | Meaning |
|---|---|
| `--noid-rpc URL` twice / `--eth-rpc URL` twice | the second, independent node (above) |
| `--single-node-ok` | accept one node for the two steps above under `production` or `sepolia` (no value) |
| `--allow-plain-http` | accept non-loopback `http://` (no value) |

Tests: `tests/scenarios.rs` `f5_*` (including `f5_an_unknown_header_time_blocks_every_noid_side_spend_and_names_the_remedy`,
`f5_sepolia_with_one_node_waits_before_the_lock_and_the_reveal_unless_single_node_ok`, `f5_bob_does_not_wait_on_a_pending_close_the_second_node_does_not_see`,
`f5_bob_keeps_waiting_on_a_pending_close_without_a_usable_second_opinion`; the simulator gives every tick an agreeing second node, with knobs for a lagging tip, another or no instance,
another lock record, another finalized height, a second node that cannot be read, a stale header time and a stale Ethereum head),
`engine::tests` (the 300 s / 600 s boundaries, the profile table), `tests/cli_live.rs` (two `--noid-rpc` against two loopback mocks, two fixtures,
the refusals, the same endpoint or fixture twice, the same-host note), `watch::http::tests::normalize_endpoint_*` and `main.rs` unit tests
(`the_second_node_must_be_another_endpoint_*`, `the_second_fixture_must_be_another_file`), `watch::http::tests` and `main.rs` unit tests (the loopback check; `--allow-plain-http` accepting a foreign host is a unit test,
because proving it end to end would need a connection to a foreign host), `tests/watch_parano1d.rs` (the header call and its absence).

### `claim` (Bob only)

```sh
swap-cli claim bob.swap.json --transport curl --noid-rpc http://127.0.0.1:9601 \
   --eth-rpc https://ethereum-sepolia-rpc.publicnode.com          # DRY RUN (--eth-from-block N comes from the file after one tick --apply)
swap-cli claim bob.swap.json … --submit [--submit-rpc URL]…                          # sends it
```

It re-runs both watchers and `decide`. **If and only if** the engine's action is `claim_noid` it runs
client R; otherwise it prints the action and does nothing (exit 0, `"submitted": false`).
Dry run (default): reads the epoch anchor and a slot hint, builds the one-input one-output close,
runs the consensus preflight (`check_call`), proves with `noid_gkr`, verifies its own proof, and
prints `txid`, `call_height`, `fee_micronoid`, `amount_out_micronoid`, `recipient`, `intent_bytes`.
Nothing is sent and the swap file is not touched (`--intent-out FILE` keeps the intent hex).
`--submit` (needs a live `--noid-rpc`) goes through the `Runner`: the pending action is written to the
swap file *before* the intent is posted (`maybe_sent` semantics), every URL (`--noid-rpc` plus each
`--submit-rpc`) receives `paranoid_submitTxIntent`, and the file is saved after. A node that answers
with a rejection, or cannot be connected to, leaves a "not sent" record that the next run retries;
a timeout or reset after sending leaves "outcome unknown", which the next run only repeats because
re-submitting the same close is harmless (first-seen mempool). The txid does not depend on the proof,
so the dry run's txid is the txid that will be submitted.

### `alice-params` (Alice, before funding)

```sh
swap-cli alice-params alice.swap.json --definition-out swap.def.json [--params-out swap.params.json]
swap-cli alice-params alice.swap.json --check-object swap.object.json
```

Prints the exact contract parameters of the swap (claim/recovery authorities and recipients, deadline `D`,
`max_fee`, mode byte 10 and its four booleans, state `["0","0"]`, the 699-byte opening and its root, the
amount in μNOID and in NOID) and writes the SDK definition JSON that `parano1d-cli contract create` takes
(the same document `pruv build … --out` writes, produced through the `noid_pruv` library) and, optionally, the
`pruv --params` file. An existing file with different content is never overwritten. `--check-object` compares
the `opening_hex` (and `address`) of the object file the wallet wrote with the swap file's, byte for byte,
and exits non-zero with `MISMATCH … do NOT fund it` otherwise.
The params file has the shape of `parano1d/contracts/htlc.params.example.json`:
`{"hashlock_authority": "<o1… Addr(s)>", "receiver": "<o1… Bob>", "sender": "<o1… Alice>", "timeout_height": "<D>", "max_fee": "<μNOID>"}`
(addresses bech32m, the two numbers decimal strings). Tests: for the example params the emitted definition is
JSON-equal and byte-equal (pretty JSON + newline) to `parano1d/contracts/htlc.definition.json`; for a real swap
the params file, read the way `pruv --params` reads it, compiles in the harness to the swap file's opening, and the
emitted definition, read the way the node's `createObject` reads a `custom_program` (re-implemented step by step
in `tests/alice_params.rs`, because the node crate does not build offline), gives the same 699 bytes.

## Parano1d RPC methods: what the tool calls, and what the real node answers

Why a grep for `"paranoid_blockCount"` in the vendored sources finds nothing: the methods are declared in
`vendor/parano1d/noid_rpc/src/api.rs` as `#[rpc(server, namespace = "paranoid")]` with
`#[method(name = "blockCount")]` and so on; the `jsonrpsee` macro prefixes the namespace, so the wire name is
`paranoid_blockCount`. **All eleven names the tool used then were right** and every one was confirmed against the owner's
node (v2.1.0, mainnet, height ≈ 280,5xx) on 2026-11-04 with read-only calls. No watcher or client change was needed;
`tests/watch_parano1d.rs` now pins the namespace and each method's parameter list against `api.rs`.

| Tool uses | Real method / positional params | Real reply (shape) | Status |
|---|---|---|---|
| tip | `paranoid_blockCount` `[]` | `280517` (u64) | recorded (`idle.json`, `recorded_misc.json`, every `recorded_funded_*` / `recorded_claim_*`) |
| epoch anchor | `paranoid_getEpochAnchor` `[]` | `"5339…3ae1"` 64 hex, no `0x` | recorded (`idle.json`; LIVE RUN 1 saw the anchor rotate to `"2893…a02d"` at 280,656 = 1,949 × 144) |
| fee estimate | `paranoid_estimateFeeDetailed` `[1, 1]` | `{n_inputs, n_outputs, net_new_slots, active_slot_count, log_slots, fee_micronoid: 5800, breakdown{…relay_floor: 5000…}}` | recorded (`idle.json`, all LIVE RUN 1 files: 5800 throughout) |
| fee floor | `paranoid_getMempoolStats` `[]` | `{size, capacity, intent_bytes, max_intent_bytes, fee_floor: 5000}` | recorded (`idle.json`, all LIVE RUN 1 files: 5000 throughout, even with 22 entries) |
| our instance | `paranoid_getObjectInstances` `[opening_hex, 0, 16]` | `{address, height, tip_hash, slots: [], next_slot: null}` for an unfunded or spent opening; funded: `slots: [{slot_index: 9750400, creation_id: 736337, value: 10000000, owner: <root>, empty: false}]` | recorded: unfunded (`idle.json`), **funded** (`recorded_funded_*`, `recorded_claim_pending`), **spent** (`recorded_claim_included`, `recorded_claim_final`); the `height` it carries can be one block ahead of `blockCount` (see below) |
| instance status | `paranoid_getObjectStatus` `[opening_hex, slot]` | `{object{…}, slot{empty:true…}, matches_opening: false, tip_height, next_call_height, active_authority}` for an empty slot (an answer, not an error) | recorded: empty slot (`recorded_misc.json`), **funded slot with `matches_opening: true`, claim-side `active_authority`, `next_call_height`, full `object{…}`** (`recorded_funded_*`, `recorded_claim_pending`); never asked once the slot is gone |
| pending calls | `paranoid_getMempoolInfo` `[]` | `{size, fee_floor, txs[{tx_hash, fee_micronoid, fee_rate, n_inputs, n_outputs, page_count, minimum_proof_class, requires_b255_miner, admitted_height, has_authorization}]}` | recorded: empty (`idle.json`, `recorded_funded_final`, `recorded_claim_included`), **non-empty with our claim in it** (`recorded_claim_pending`: 8 entries), busy (`recorded_claim_final`: 22 entries). Real lists also hold `page_count` 0 entries (fee 0, 0 outputs) and multi-page ones (3, 19), which the watcher never looks up (the synthesized list had no zero-page entry) |
| one mempool entry | `paranoid_getMempoolEntry` `[txid]` | the `txs[]` fields plus `contract_opening_hex` (`null` for ordinary payments, seen live); `null` for an unknown txid; bad hex → error `-32000 invalid txhash: expected 64-char hex` | recorded: unknown txid, bad hex, `contract_opening_hex: null` (the funding payment and ordinary payments), **our pending claim with the full 699-byte `contract_opening_hex`** (`recorded_claim_pending`, fee 5800, `admitted_height` 280,657), and `null` for our claim once mined (`recorded_claim_included`) |
| confirmation | `paranoid_getTx` `[txid]` | `{tx_hash, height, block_hash, tx_position}` (seen live on a coinbase); `null` for an unknown txid | recorded: unknown (`recorded_claim_pending`, `recorded_misc.json`), **confirmed claim `{height: 280659, block_hash: 59eefd12…4928, tx_position: 1}`** (`recorded_claim_included`) |
| client R output slot | `paranoid_getSlotHints` `[1]` | `[9714701]` (array of u32) | recorded (`recorded_misc.json`) |
| client R submit | `paranoid_submitTxIntent` `[intent_hex]` | txid hex; errors as `-32000` text | **synthesized, never called against the node** (it mutates); signature and return read from `api.rs` / `server.rs` |
| tip block time (F5) | `paranoid_getBlockHeader` `[tip]` | `{height, hash, prev_hash, state_root, tx_root, timestamp (Unix s), miner, nonce_hex, difficulty_target, log_slots, active_slot_count, ...}` or `null` | **declared in `api.rs`, never called against the node by this layer**; optional: an error, a `null` or a missing field is "tip time unknown" |

Also recorded (not used by the watchers): `getChainInfo`, `getContractProtocol` (ABI 3, 16 instructions, runtime available),
and three error replies: `getObjectInstances` with a malformed opening → `-32000 "contract: Encoding"`, an unknown method →
`-32601 "Method not found"`. `paranoid_createObject` was **not** called. Two environment facts that matter: the node only
answers owner-scope methods to a loopback client (a remote client needs a credential, and the operator token's allowlist does not
include `getEpochAnchor`, `getSlotHints`, `getObjectInstances` or `getMempoolInfo`); and Parano1d has no test network on this node
(`getChainInfo` is mainnet), so every NOID amount below is real money.

## Live run (what Alice and Bob type)

Prerequisites: the Parano1d node and wallet app running on Windows (RPC `http://127.0.0.1:9601`); WSL2 Ubuntu with the
built binary (`$HOME/noid-target/debug/swap-cli`, or `cargo run --offline --`); Windows `curl.exe` reachable from WSL
(`/mnt/c/Windows/System32/curl.exe`, ≈ 50 ms per call). In WSL the Windows loopback is not reachable over TCP, so
**WSL commands use `--transport curl`**. Paths below are examples. **Every step that spends is the owner's call**
(PROJECT.md: no funding, broadcasting or claiming without an explicit go-ahead; tiny amounts until M4).
The Windows tool is `C:\Parano1d\bin\parano1d-cli.exe` (written `parano1d-cli` below); its global flags are
`-r/--rpc URL` (default `http://127.0.0.1:9601`), `-j/--json`, `--rpc-timeout SECS`, and amounts are decimal NOID.

Sending the Ethereum transactions (Bob's `newLock`, Alice's `claim`, Bob's `refund`) is outside this crate (it has
no signer); `tick` prints which one is due (`lock_eth` with `t_reveal`, `reveal_eth` with the lock id, …).

### Alice (NOID holder)

0. Agree off-chain: amounts, `--alice` (an address of **the stock wallet that will do the refund**), Bob's `o1…`, the
   Ethereum HTLC deployment and chain id. `--h-create` is the current tip (`parano1d-cli status` or `blockCount`),
   `--fee-estimate` is `estimateFeeDetailed(1,1).fee_micronoid` (5800 today). Make sure the tip is ≥ 279,388.
   ```sh
   swap-cli new-alice --out alice.swap.json --alice o1… --bob o1… --amount 10000000 --fee-estimate 5800 \
      --h-create <TIP> --eth-contract 0x… --eth-chain-id <ID> --eth-amount-wei <WEI> --eth-receiver 0x… --eth-sender 0x…
   ```
   Send Bob the printed bundle (no secret in it) and the equivalence receipt (`equiv/README.md` §5). **Do not fund before
   Bob has run his pre-checks** (design step 5: `new-bob --receipt … --equiv-prove …`, which runs `equiv-prove verify` itself) and told you so; Alice funds at step 6.
   For a rehearsal add `--profile rehearsal` (short windows, ≤ 20 NOID, ≤ 0.01 ETH, Ethereum chain 31337 only), or `--profile sepolia` when Bob's leg is on the
   public Sepolia testnet (the same caps, chain 11155111 only, windows long enough for Sepolia's finality): see "The rehearsal and sepolia profiles".
1. (a) **Create and fund the HashTimeLock** from the swap file:
   ```sh
   swap-cli alice-params alice.swap.json --definition-out swap.def.json
   parano1d-cli contract create swap.def.json --out swap.object.json      # local: encodes and validates, no fee, no broadcast
   swap-cli alice-params alice.swap.json --check-object swap.object.json  # must print "object file OK"; compare the address it prints with the bundle's contract_root
   parano1d-cli contract fund swap.object.json 10.000000                  # REAL FUNDS: the amount alice-params printed as fund_amount_noid
   ```
   `contract create`'s `--out` must name a new file, and its input is limited to 16 KiB; our definition is about 1 KiB.
   `contract fund` is an ordinary payment from the wallet's **active** address to the contract root (`--fee` defaults to 0,
   which asks for the current relay minimum). The wallet remembers the opening when it funds (`remember_object_opening`), so
   `contract watch` is not required; keep `swap.object.json` and `alice.swap.json` anyway (the opening cannot be recovered from the
   chain). Funding twice creates two instances: if the response is lost, look first (step b).
   Fund promptly: Bob must lock on Ethereum by Parano1d height `lock_by_height` (printed), and `D` does not move.
2. (b) **Check the instance after inclusion:**
   ```sh
   parano1d-cli contract instances swap.object.json        # "Slot <S>  incarnation <C>  10.0 NOID"
   parano1d-cli contract status swap.object.json <S>       # "Opening matches State: true", "Next-call authority: <Addr(s)>" before D
   swap-cli tick alice.swap.json --transport curl --noid-rpc http://127.0.0.1:9601 \
      --eth-rpc <ETH URL> --eth-from-block <N> --apply      # run repeatedly (every ~30 s); it says when to reveal. <N> is stored on the first run; later runs may omit it
   ```
   Finality is 18 blocks; `tick` waits for it before it ever tells Alice to reveal.
3. Reveal on Ethereum when `tick` says `reveal_eth` (the Ethereum claim with the secret; outside this crate).
4. (c) **Recovery close at height ≥ D** if Bob never claimed (the contract is then on the recovery branch). The wallet's
   *active* address must be `recovery_authority` (the `--alice` address), or the node refuses:
   ```sh
   parano1d-cli address --list                             # find the index of the --alice address
   parano1d-cli address --use <INDEX>
   parano1d-cli contract call swap.object.json <S> <C> --close --preview
   #   check in the JSON: "recovery": true, "terminal": true, "authority": <alice address>, "call_height" >= D, fee <= max_fee; note "txid"
   parano1d-cli contract call swap.object.json <S> <C> --close --expected-txid <TXID> --out refund.json
   #   refund.json must be a NEW file; the call waits up to 600 s for inclusion and saves refund.receipt (--wait-seconds 0 returns at once)
   ```
   If the node reports that the height changed between preview and submit, preview again. Contract v1: `--fee` stays 0 (relay minimum, ≥ 5,800
   μNOID and ≤ `max_fee`). **Contract v2: pass `--fee <max_fee in NOID>` (for example `--fee 0.050000`); any other fee is rejected** (`alice-params` prints the
   command with the flag filled in). Do **not** do this before `D`: before `D` the committed authority is `Addr(s)`, not the wallet's address (the preview then shows `"recovery": false`).
   The same commands exist as `--preview` / `--expected-txid` in `docs/contracts/api.md` ("CLI workflow").

### Bob (ETH holder)

1. `swap-cli new-bob … --receipt swap.receipt --equiv-prove <equiv-prove>` (`--pinned-image-id` is optional and must equal the compiled-in id; see "The CLI"; the tool runs the
   verifier on Alice's receipt for the bundle's H and A and checks the image id against the one compiled into the tool; the typed `--equiv-h/-a/-image-id`
   form is for the rehearsal profile only, REVIEW-3 F2). Never fund Ethereum before `tick` says `lock_eth`.
2. Poll: `swap-cli tick bob.swap.json --transport curl --noid-rpc http://127.0.0.1:9601 --eth-rpc <ETH URL> --eth-from-block <N> --apply` (the first run stores `<N>` in the file; later runs and `claim` may omit the flag).
3. When Alice has revealed (the engine records the secret and prints `claim_noid`), **check first, then send** (client R):
   ```sh
   swap-cli claim bob.swap.json --transport curl --noid-rpc http://127.0.0.1:9601 --eth-rpc <ETH URL>
   #   dry run: proves and self-verifies, prints txid / call_height / fee / amount_out / recipient (must be Bob's o1…); sends nothing
   swap-cli claim bob.swap.json --transport curl --noid-rpc http://127.0.0.1:9601 --eth-rpc <ETH URL> --submit
   ```
   The claim must be **included and final before D** (target ≤ D − 18); `tick` afterwards tracks the txid until final.
4. Reference only, client S (the stock wallet, if client R is unavailable). The sequence the scripted `client::stock` follows, **not run
   anywhere yet** and with two unknowns noted:
   ```sh
   # a THROWAWAY data dir that is not the owner's wallet; the flag replaces the wallet there and is hidden (absent from --help)
   echo <64-hex secret m> | parano1d --import-wallet-secret --data-dir D:\throwaway
   parano1d --data-dir D:\throwaway --rpc-listen 127.0.0.1:19601 --p2p-listen 0.0.0.0:19600     # a second node on other ports
   parano1d-cli --json --rpc http://127.0.0.1:19601 contract call swap.object.json <S> <C> --close --fee 0.005800 --preview
   parano1d-cli --json --rpc http://127.0.0.1:19601 contract call swap.object.json <S> <C> --close --fee 0.005800 --expected-txid <TXID> --out claim.json --wait-seconds 0
   ```
   (Contract v2: replace `0.005800` with `max_fee` in NOID, e.g. `0.050000`; client S passes the swap file's fee and refuses any other.)
   `swap.object.json` for Bob is `{"opening_hex": "<swap file opening_hex>"}` (the CLI only reads that field). Not determined: that the
   hidden `--import-wallet-secret` flag exists in the installed v2.1.0 binary (it is in the vendored source at `main.rs` L1371-1376,
   L1995, and not in `--help`), and how long a fresh second node takes to sync before it can authorize. Never use the owner's
   real data directory for the import.

### What LIVE RUN 1 added (2026-11-04)

The first real swap ran `tick`/`claim` with `--record-noid`, so every call of the tool left one fixture file; six of them are
kept in `fixtures/parano1d/` and replayed by `tests/watch_parano1d.rs` (the rest of the run's recordings stay in WSL under `~/live-run-1/rec/`). Timeline
they pin: funding included at 280,638 (instance slot 9,750,400, creation id 736,337, 10,000,000 μNOID), final at 280,655 (tip =
inclusion + 17); our claim `d50743e3…1324` was in the mempool at 280,657 (the tick before the claim command had `tip` 280,657, so the claim was
proved for call height 280,658) and was **included at 280,659**, one block later than the height it was proved for (still the
claim branch: the deadline is 281,286); final at 280,676 (inclusion + 17). Differences from the synthesized shapes: none in
the keys the watcher reads (every top-level key of the synthesized `getObjectInstances`, `getObjectStatus`, `getMempoolInfo`,
`getMempoolEntry` and `getTx` answers matches); the real `getObjectStatus.object` also carries `code_id`, `max_payout_micronoid`,
`min_retained_micronoid`, `program`, `state` and `state_hex`; real mempool listings hold entries the synthesized ones did not
(`page_count` 0 with fee 0 and no outputs, dozens of `contract_opening_hex: null` payments); the relay floor was
5,000 all run (the synthesized files had 5,800 / 6,400); and the calls are not one snapshot: at the tick when the instance first
appeared, `blockCount` said 280,637 while `getObjectInstances.height` said 280,638 and `getObjectStatus.next_call_height` 280,639
(`recorded_funded_first_seen`).

### Things this layer cannot know

- Whether `contract create` (the real node's `createObject`) reproduces our 699 bytes: tested against a step-by-step re-implementation
  of the node's code, **not** against the node (the coordinator runs the real call; `--check-object` then settles it before funding).
- The live behaviour of `submitTxIntent` on a real claim (rejection texts, relay floor under load): never exercised.
- Behaviour outside what LIVE RUN 1 happened to record: a claim stalled behind first-seen admission, an eviction at the deadline, the
  refund branch (`active_authority` after `D`), and any reorg. The funded, pending, included and final states are now recorded.
- Tokens for a remote node (`Authorization: Bearer`) are supported by `HttpJsonRpc::with_bearer` but not wired to a flag.

## What is real and what is mocked

Real, exercised by the tests:

- the compiled `HashTimeLock` opening (via the harness and `noid_pruv`), the M0.6 guard,
  the byte-for-byte rebuild Bob performs on Alice's bundle;
- `Addr`, `Derive`, SHA-256, the keccak topics/selectors and `computeLockId` packing
  (cross-checked against ethers on 2026-11-04 and against the Hardhat-recorded lock id);
- the authorization proofs of client R (`noid_gkr`, V3/V4 by height), their self-verification,
  and the `ObjectIntent` wire bytes, decoded and re-verified by the mock node;
- the Ethereum JSON-RPC answers (recorded from Hardhat's in-process EVM running `HTLC.sol`);
- the live transports: `HttpJsonRpc` against a loopback listener and, by hand on 2026-11-04, `ExecJsonRpc` with the real Windows `curl.exe`
  from WSL against the owner's Parano1d node (read-only `tick`, recorded as `idle.json`) and against
  `https://ethereum-sepolia-rpc.publicnode.com` (chain id, blocks, logs; no lock exists there for the example swap);
- the full `claim` path (dry run, `--submit`, rejection, unreachable second node) against a loopback mock node that decodes and
  re-verifies the intent like a node;
- the secret at rest (Argon2id + XChaCha20-Poly1305), the atomic file replace, the history;
- the engine's decisions for both roles on a simulator that models first-seen mempool
  admission (`SlotConflict`), branch-flip eviction at `D`, finality on both chains,
  the Ethereum clock and `finalized` tag.

- the Parano1d RPC answers for a **funded** HashTimeLock (unfinal, final, first seen), our **pending** claim, the **included** claim
  and the **final** state, replayed from LIVE RUN 1's real recordings with the run's real 699-byte opening: observation fields, the
  lookups made (single-page entries only), the `tracked_tx_pending` / `confirmed_tx` logic, and the `tip >= inclusion + 17` finality
  arithmetic at its exact boundaries (funding 280,655, claim 280,676). The claim proved for call height 280,658 was included at
  280,659. Also real: unfunded-opening answers, fee, mempool, epoch anchor, slot hints and the error replies (see the method table);

Mocked or synthesized:

- the Parano1d RPC answers that no recording has: `funded.json` (the seed-0x33 example swap, used by the `cli.rs` tick test),
  `pending_claim.json` (another contract's call in the mempool next to ours) and `malformed.json` (negative), shaped from the vendored type
  definitions (the only values taken from real code are the opening hex and root);
- submission of a real claim: the `IntentSubmitter` over `paranoid_submitTxIntent` is real code but has only ever talked to a loopback mock; the stock-wallet commands (`CommandRunner`) are scripted but nothing spawns them;
- Alice's Ethereum transactions (the simulator mines them; there is no signer);
- the equivalence proof π (M1) is not verified by this crate's own code: `new-bob --receipt` runs the `equiv-prove verify` binary
  (the `equiv-host` workspace) as a subprocess (REVIEW-2 F2; tested here only against a shell script standing in for it, never against the
  real zkVM verifier) and records what it checked and printed (`EquivalenceAttestation`), refusing a journal or image id that is not this
  bundle's / the compiled-in image id (REVIEW-3 F2). The typed fallback (rehearsal profile only) records `source: "typed"`;
- the simulator's Ethereum has no gas, no reorgs, no competing locks.

## Review

`REVIEW-1.md` (independent, 2026-11-04) confirmed every number and gate in `params.rs`
against the design and found the problems around them. Applied the same day (each
pinned by a test): Bob's own terms are checked against the bundle (`BobTerms`), an
explicit equivalence-proof attestation is required before Bob's file exists
(`EquivalenceAttestation`: the journal `variant ‖ H ‖ A` and the image id that
`equiv-prove verify` printed must match this bundle and Bob's pinned id; the receipt
itself is still verified by that external tool), a pending action with an unknown
outcome is never turned into another action or an abort and funding is never retried
blindly (`ExecError::maybe_sent`, `retry_safe`), a secret revealed while Bob's refund
is unconfirmed still leads to his NOID claim, `F_max` is checked against the live fee
estimate at lock time and cannot overflow the 1 % rule, the sender must be an EOA and
the chain id / pinned code hash are compared when a lock appears, lock ids are compared
before "our lock is final", Bob's (I1) clock is the earlier of wall clock and chain
clock, a foreign pending close is tracked instead of re-proved into, and the CLI
derives the expected lock id from `T_reveal` (Bob) or discovers the lock by parties and
hashlock (Alice). Medium/low findings not applied are listed in the review and below.

`REVIEW-3.md` (independent, 2026-11-05, against `be9e3fa`) re-checked the fourteen REVIEW-2 fixes, and the
maintainer re-read every cited path and ran the suite once (318 passed). Seven closed (F6, F8, F9, F11, F12,
F13, F14), seven partial (F1, F2, F3, F4, F5, F7, F10), four new findings: G1 `equiv-prove verify` accepts a
dev-mode receipt when `RISC0_DEV_MODE` is set in Bob's environment (confirmed in the risc0-zkvm 3.0.6 source);
G2 the F10 "another open lock" rule is a post-lock cancel option for Bob; G3 the same node can be given twice as
the "second" node; G4 `live.js claim` does not check receiver or amount against the swap terms. Verdict: not yet
safe to hand to a stranger. The must-fix list in that file (F3 first: a read-only `tick` prints a spend's
parameters unrecorded, `intent --cancel` ignores the mempool, `live.js` is not tied to the swap file) is the
next gate.

## What REVIEW-7 changed (2026-11-05)

`REVIEW-7.md` (independent, read-only, against the REVIEW-6 fixes) closed R6-1, R6-2, R6-3, R6-5 and R6-8 and found two Low and six Info items. The
four below are fixed in code; R7-3 (the build string), R7-4 (a failed second Ethereum node at the poseidon lock decision), R7-7 and R7-8 are not part
of this change.

- **R7-1, the pre-lock check no longer reads every `Locked` log of the shared contract.** *Plain words:* after R6-2 the only question left before Bob locks
  is "has my own address already locked on this word A" (a lock by anyone else costs him nothing). The lock word is in the log's data, but the sender is
  an indexed topic (checked in `HTLCPoseidonV2.sol`: `Locked(bytes32 indexed lockId, address indexed sender, address indexed receiver, uint256 amount,
  bytes32 lockAddr, uint256 timelock)`), so the node is now asked for `[Locked, any, bob_sender]` only, from the stored from-block. The answer is bounded by
  Bob's own activity, so the rule that read a result of exactly 1,000 / 5,000 / 10,000 / 20,000 logs as truncated is **gone** (`SUSPECT_LOG_CAPS` removed):
  anyone could trip it by padding the contract with locks, without knowing `A`, and hold every poseidon Bob back. One call over the whole range first; a
  node that refuses it with a JSON-RPC error is asked again in chunks of `DEFAULT_LOG_RANGE_MAX` = 50,000 blocks (`EthWatcher::with_log_range_max`), and a
  chunk that fails fails the check. Every returned log is re-checked locally (contract, event, sender topic, lock id recomputed from its own fields), so a
  provider that ignores the topic filter cannot slip another sender's lock in. A node error is still `WordScan::Failed` and holds back `lock_eth` only, never
  the poll. The cross-check "the sender query contains the lock the targeted query found" stays. `EthObservation.word_locks` now lists Bob's own locks on the
  word only. `live.js lock` (poseidon kind) does the same with chunks of 50,000 blocks (`lockedEventsBySender`); `foreignLocksSameHashlock` stays `[]` for this kind
  and the output says `lockedEventsQuery: "sender"`. The sha256 kind's `live.js` check keeps reading every `Locked` log (it never had the cap rule, so it cannot
  be held back by padding). Tests: `the_poseidon_word_check_asks_the_indexed_sender_topic_and_reports_only_bobs_own_locks_on_the_word`,
  `a_failed_poseidon_scan_is_a_state_of_the_observation_never_an_error_of_the_poll` (padding of 1,000 / 5,000 foreign locks, a provider that ignores the
  filter, the chunked fallback with exact ranges, a chunk that still fails); `live-poseidon.test.js`.
- **R7-2, a failed `self-test` no longer leaves the earlier pass valid.** `swap-cli self-test FILE` clears the record (history `client_r_selftest_cleared`) and
  **saves the file before it proves anything**; the passing record is written, and saved, only on success. A run that fails (or is killed halfway) leaves no
  record, and the engine's `lock_eth` waits with "the client R self-test has not passed". A failure also adds `client_r_selftest_failed` to the history.
  Test: `a_poseidon_swap_is_started_without_any_proof_step` (a passing record, a failing run, no record, a later pass records again).
- **R7-5, `--reveal-tx` evidence needs the canonical chain and, with two nodes, both nodes.** The watcher compares the receipt's block hash with the hash of
  the node's block at that height (`eth_getBlockByNumber`), and with the transaction's own block hash when it names one; a block the node does not have, or has
  with another hash, is a note ("NOT on the canonical chain", nothing recorded). The engine records `reveal_reverted_seen` (Alice's late-cutoff switch) from
  a single node only when no second Ethereum node is configured; with a second node (answering, or `second_error`) **both must report the same reverted
  claim** (lock id, preimage, transaction hash, block number), otherwise the tick says why and records nothing; it is re-read on every poll. Bob's use of the
  preimage is unchanged (it passes the same lock-word check as every other source). Tests: `a_reverted_claim_whose_block_is_not_on_the_canonical_chain_is_not_recorded`,
  `alices_file_learns_from_a_reverted_claim_that_the_secret_is_public...` (both agree, one only, different transactions, second node failed, single node).
- **R7-6, a malformed `reveal-reverted-tx.txt` cannot stop a tick or a claim.** `scripts/live/env.sh` `reveal_tx_flags` matches `0x` + exactly 64 hex digits
  (surrounding whitespace allowed); anything else is ignored with a warning on stderr and no `--reveal-tx` is passed. The binary itself still refuses a malformed
  `--reveal-tx` typed on the command line (an explicit flag is an explicit mistake). A run directory installed earlier has a frozen `env.sh`: run `install.sh` again.

## What REVIEW-6 changed (2026-11-05)

`REVIEW-6.md` (independent, read-only, against `ef3145f`: the change that added the `poseidon` Ethereum lock kind) refuted every kind-confusion,
removed-proof and secret-exposure attack and found one Medium, three Low and four Info items. Fix status, finding by finding:

- **R6-1, the full `Locked` scan can no longer stop Bob's tool after the reveal.** *Plain words:* with the `poseidon` kind the lock word is not
  a searchable field of the `Locked` log, so "was this A locked before" can only be answered by reading every `Locked` log of the contract. That scan
  used to run on every poll and a hit on a provider's result cap made the whole poll fail, so Bob's `tick` and `swap-cli claim` could be blocked
  exactly when he has to claim. Now (a) the swap's own locks are found, for both kinds, by the indexed `sender`/`receiver` topics (the sha256
  kind's query); (b) the all-`Locked` scan is run only when the caller asks (`EthWatcher::with_word_scan`), and `engine::word_scan_wanted` asks
  only for Bob in a `poseidon` swap before his lock is seen and for the re-send of a dropped lock; (c) its result is `EthObservation.word_scan`
  (`not_run` / `complete` / `failed(reason)`), and a node error, a suspicious exact count, a malformed log or a lock the targeted query found
  that the scan misses makes it `failed` and **holds back `lock_eth` only** (action `wait`, with the reason); (d) from `locked` on, and for Alice,
  the poll depends on the targeted queries alone. A hand-built observation with `not_run` also holds Bob back: no lock on a guess. Tests:
  `a_failed_poseidon_scan_is_a_state_of_the_observation_never_an_error_of_the_poll` (a failing scan and a pending claim read in the same poll),
  `the_poseidon_scan_reads_every_locked_log_in_one_call...` (no all-`Locked` request without the flag), `bob_does_not_lock_without_a_complete_scan_on_every_node...`,
  `after_bobs_lock_a_failed_scan_changes_nothing_in_the_claim_path`, `the_full_scan_is_asked_only_while_bob_can_still_decide_to_lock`.
- **R6-2, a stranger's 1-wei lock on `A` no longer vetoes the swap.** Bob is blocked only by an earlier `Locked` log with the word made by his OWN
  sender (`bob_sender`, any receiver) other than the lock this file expects; locks by other senders are counted in the notes ("not blocking"). The
  reasoning is the sha256 kind's: Bob's lock pays only the fixed receiver, for an `x` with `Addr(x) = A`; the NOID lock pays only Bob. `live.js lock` is
  the same (own sender refuses; foreign locks go in `foreignLocksSameHashlock` and a stderr note).
- **R6-3, a mined but reverted claim is no longer invisible.** A reverted claim paid nobody but its calldata published the secret; no `Claimed` event
  marks it and it is not pending, so no read saw it. `live.js claim` now returns `reverted: true, secretPublic: true`, the `txHash`, a note and
  `swapCliFlag: "--reveal-tx HASH"`, and exits with status 3 (`reveal.sh` saves the hash in `$L/reveal-reverted-tx.txt`; `tick.sh` and `claim.sh` pass it
  on). `tick` / `claim` / `intent --cancel` take `--reveal-tx HASH`: the watcher fetches that transaction and its receipt from the node(s) and
  accepts it only if it is a call to the pinned contract's `claim`, for THIS lock id, from the lock's receiver (`alice_receiver`), with a preimage that
  opens the lock word of this kind (calldata of 68 bytes or more: the over-long call that reverts is the case for the poseidon kind), and its receipt says
  status 0. Anything else is **ignored with a note** (`EthObservation.reveal_tx_note`, repeated in the tick's notes); a hash the node does not know, a
  pending one or a receipt that is not there yet is a note too, never an error. A verified one becomes `EthObservation.reverted_claim` and
  (a) Alice's `tick --apply` writes the history marker `reveal_reverted_seen` once, which `secret_may_be_public` counts, so a re-send is judged by
  the late cutoff `T_reveal - DE` and `live.js claim --swap` (which reads the same marker name) agrees; (b) Bob's preimage candidates include it, checked
  against `H` and `A` like every other (a wrong preimage in it is "rejected" with a note). The marker is Alice's file only.
- **R6-4, the client R self-test record is bound.** `ClientRSelfTest` now carries `lock_word` (hex, this file's), `contract_version` (this swap's), `build_id`
  (`swap_cli::build_id()`: `swap-cli <crate version>`, plus `+<SWAP_CLI_BUILD_ID>` if that variable was set when compiling) next to `passed_at`, `auth_version`,
  `call_height`. `record_client_r_selftest` refuses a record for another lock word or version; the engine (`selftest_blocker`) holds back Bob's FIRST
  lock unless all of them match, the owner-authorization version is the next block's and the record is at most 24 hours old (`SELFTEST_MAX_AGE_S`;
  not dated in the future). Records written before this change carry none of the three and are refused: run `swap-cli self-test FILE` again. The
  throwaway is compiled with the swap's contract version and `max_fee`, recognised by `detect_contract_version` like the real opening, built by
  `build_claim`, and its intent goes through `submit_claim` to a mock node that decodes it, re-verifies the proof and must answer the txid we
  computed. The engine cannot re-run the proof itself: a stale record makes Bob `wait` with "run `swap-cli self-test FILE` again".
- **R6-5 (Info), the advice to raise `--eth-from-block`** is gone from the watcher's cap message and from `live.js`: raising it only hides earlier locks.
- **R6-6 (Info), the scan and the targeted read both use `latest`.** Not pinned to the block read at the start of the poll: the replayable fixtures
  (`fixtures/`, recordings) pin the request parameters, `"toBlock": "latest"` included. The cost of the race is now one `wait` of the lock decision
  (a scan that misses the lock the targeted query found is `failed`), not a failed poll.
- **R6-7 (Info), documentation drift.** The `overlong_claim` comment no longer says Alice counts a leak; `swap-cli secret` for a poseidon swap no longer
  advises piping into `equiv-prove`. Not changed: `scripts/live/prepare.sh` passes one `LOCK_KIND` to both roles (fine for the owner in both roles).
- **R6-8 (Info, pre-existing), the sha256 claim never sends the secret to the node except in the signed transaction.** `live.js claim` sends it with a
  fixed gas limit of 200,000 (the fuzz maximum in `eth/FUZZ.md` is 120,993) and never calls `eth_estimateGas`; `--replace` and the first send
  alike. A `--dry-run` with the secret is refused against a node that is not on this machine for both kinds. Test: `R6-8: the sha256 claim never sends the
  secret except in the signed raw transaction` (every JSON-RPC request recorded; only `eth_sendRawTransaction` carries the secret).

## What REVIEW-5 changed (2026-11-05)

`REVIEW-5.md` (independent, narrow, against `6d9bc3e`: the diff that fixed REVIEW-4) found one Medium, one Low-Medium, two Low and four Info
items. This section is the fix status, finding by finding; each Rust-side one is pinned by a test in `tests/review5.rs` (14 tests) that fails on the
code as the review read it, the `live.js` ones by tests in `eth/test/live.test.js` (REVIEW-5 describes), the helper ones by hand-run checks of
`scripts/live/env.sh`.

- **R5-1, a stuck first reveal can be replaced past the `M_A` cutoff.** *Plain words:* `M_A` (30 minutes before `T_reveal`) is the last moment to
  PUBLISH the secret for the first time, because a claim needs the time to become final. A claim that is already in the public mempool has
  published it, so the only thing left is to get a claim mined before `T_reveal`; the cutoff for that is `T_reveal - DE`. But the tool never
  learned that the claim had been sent (the operator sends it with `live.js`; `tick --apply` only records the intent), so a stuck claim could
  not be replaced once `M_A` had passed. Three changes:
  1. *The intent freezes both cutoffs.* Every `reveal_eth` intent carries `cutoff` (`T_reveal - M_A` for a first reveal, as before) and
     `late_cutoff` (`T_reveal - DE`, the profile's `DE`).
  2. *The CLI path records that the claim was sent.* While a `reveal_eth` intent is held and the receiver key's pending nonce is above its latest
     nonce (the signal `intent --cancel` already reads to refuse a cancel), `tick --apply` writes `reveal_pending_seen` once, and
     `secret_may_be_public` counts it. From then on the file allows the re-send until `T_reveal - DE` and no longer withholds it behind the
     two-instances rule (R4-4). A reveal that was only decided and never sent leaves no marker: it stays a first publication with the strict cutoff.
     *Library path:* a `Runner` whose executor reports an unknown outcome for a `reveal_eth` (it may have been sent) writes `reveal_maybe_sent`;
     that relaxes only the CUTOFF of the re-send (the two-instances rule waits for evidence, not for a crash). A failure the executor knows sent
     nothing leaves no marker.
  3. *`live.js claim --replace --swap FILE`* that has found and identified the signer's pending claim of THIS lock uses the intent's
     `late_cutoff` (an older intent: the profile's `DE`) even with no marker in the history, because the pending transaction itself proves the secret
     is out. A first claim keeps the strict rule. See `eth/README.md`.
  Residual: the marker rests on the receiver key having a pending transaction; a key used for something else during the swap could set it wrongly.
  Use the receiver key for nothing else (the cancel guard already assumes this).
- **R5-2, `--replace` replaces only what it identified (`live.js`).** The old transaction is looked for with `--replace-tx`, in the node's pending
  block and in `txpool_contentFrom`; if it cannot be found and shown to be this claim / refund of this lock, the command refuses and asks for
  `--replace-tx`. `reveal.sh` and `refund-eth.sh` say so.
- **R5-3, Bob's abort in `secret_seen` no longer waits for ever on a close known only from `getLock`.** The first poll that shows his lock closed
  by the record alone (zero tx hash, `claim_state_from_record`) writes `eth_close_record_seen:<head>` into the history; `eth_leg_not_settled`
  counts the finality of that close from that head (the close is in a block at or below it), not from each new poll's head.
- **R5-4, an abort over a lock that never showed needs a fresh head and the second node (`abort_eth_blocker`).** For a Bob file that decided
  `lock_eth` and holds no lock, the abort is recorded only when every Ethereum node read has a fresh head (the `lock_eth` limit, 600 s; not under
  `rehearsal`), a second node that was configured but cannot be read blocks whatever `--single-node-ok` says, where the profile asks for a second
  node (and the flag was not given) it must be present and fresh, and no node shows a lock under the id of any cancelled `lock_eth` intent. The recorded
  reason, and the walk-away text, no longer say "refund it at `T_reveal`": they say to look at the contract before `T_reveal`, claim the NOID before
  `D` if a secret was published, and refund the ETH only if the lock is still unclaimed.
- **R5-5, the two relations are in `Gates::validate`.** `tx_grace + RA + DE <= M_A` (a reveal sent at the cutoff and dropped can still be re-sent) and
  `W_A < W_A_min + min_cancel_age + abort_after_cancel` (a lock that lands after a recorded abort fails Alice's (I3)). `MIN_CANCEL_AGE_S` and
  `ABORT_AFTER_CANCEL_S` are profile values now (`Gates::min_cancel_age_s`, `abort_after_cancel_s`): 600 / 3,600 s for production and sepolia,
  120 / 600 s for rehearsal, whose whole reveal window is 600 s. The `pub const`s keep the production numbers.
- **R5-6, an older cancel beside a newer one.** A file with more `intent_cancelled:lock_eth` history entries than recorded cancelled `lock_eth`
  intents is treated as having an unrecorded cancel: Bob walks away, as for a pre-R4-2 file.
- **R5-7, a `reveal_eth` intent resolves when its lock is closed.** `intent_effect_seen` judges a `reveal_eth` by its own lock too (refunded or
  claimed), as it does for `refund_eth`. It no longer holds Alice's `refund_noid` at `D` after Bob's refund won the race and Bob never claimed.
  *Manual way out of an intent that still never resolves* (the lock is open, the claim neither mined nor dropped): the claim is stuck, so push it
  through with `reveal.sh --replace 0xHASH` (higher fee, same nonce); or wait until the node no longer holds it (a node may evict a stale pending transaction; this tool
  cannot make it) and then `swap-cli intent FILE --cancel` (refused while the receiver key's pending nonce is above its latest). The wallet's recovery close at
  `D` stays available throughout: the recovery branch never expires.
- **R5-8, helpers.** `lock.sh` and `refund-eth.sh` pass the mainnet / gas-price fee flags like `reveal.sh`; `refund-eth.sh` takes
  `--replace [TXHASH]`. `lock.sh --replace` is refused with a reason: `live.js` has no `--replace` for a lock, and none was added. "Your claim
  looks stuck" is the `reveal_pending_seen` marker plus the held intent; the tool still prints no prompt on its own.
- **The rest of R4-8.** `scripts/live/env.sh` passes `--single-node-ok` only when `SINGLE_NODE_OK=1` is set (in `env.local.sh`); without it and
  without second nodes the helpers pass nothing and print, on every call, that the engine will wait before Bob's lock and Alice's reveal.

Found while testing, not changed: chaos seed `0x5eed0001` shows two violations (`fail-closed`, `gate-lock-two-instances`) that are identical on the
code before these fixes; the default seed and `0xbadc0de5` are green.

## What REVIEW-4 changed (2026-11-05)

`REVIEW-4.md` (independent, 2026-11-05, against `2077e78`) found twelve things around the engine rather than in it. This section is the fix
status of the ones on the Rust side, finding by finding; each is pinned by a test in `tests/review4.rs` (19 tests) that fails on the code as the
review read it. The three findings that live in `eth/scripts/live.js` (R4-1 the mainnet fee check and replacement, R4-3 the late re-send
through `live.js`, R4-5 the signer check of `claim`) are fixed there, not here.

- **R4-2, a cancelled lock is never re-decided under a new lock id (`src/engine.rs`, `src/swapfile.rs`).** *Plain words:* `intent --cancel`
  says "the send never happened", but it rests on one node's view of the mempool; the send may still be queued somewhere and land later. The
  lock id is computed from `T_reveal` (among others), so a second lock chosen afresh gets a different id and BOTH could land: Bob pays twice.
  Now the swap file keeps every cancelled intent with its frozen parameters (`cancelled_intents`). A later `lock_eth` re-uses the cancelled
  lock's own `T_reveal` (the same lock id, so a duplicate reverts in `HTLC.sol`) while (I1), `M_A`, the minimum reveal window and the lock-by
  height still hold for it; when they no longer do, the action is `abort` (Bob walks away; the abort is recorded an hour after the cancel, as
  before). The watcher keeps asking `getLock` for the cancelled id, so a late landing is noticed. A file whose history shows a cancelled
  `lock_eth` but holds no record of it (written before this change) aborts too: its lock id is unknown.
- **R4-4, the re-send of a public secret is not blocked by a second fitting instance.** The "two instances of the agreed amount: do not
  reveal" rule protects a FIRST publication. Once the secret may be public (a reveal that was sent, mined, reorged or dropped) withholding the
  re-send protects nothing and only helps a Bob who funded a second instance, so the rule is skipped then (a note names the slots; refund the
  extra instances with the wallet at `D`).
- **R4-6, an abort after the lock is on chain is recorded.** The hold ("a `lock_eth` was decided and never cancelled, so the abort is not
  recorded") now ends when the file has SEEN the lock (Bob in `secret_seen` whose claim branch closed on him is recorded as `aborted` instead
  of printing `abort` for ever). A `fund_noid` stays held on purpose: the only phase an abort can end Alice's file from is `created`, and a
  visible instance that did not fit is not proof that hers has landed (found by the chaos test while fixing this). Two guards came out of the
  same chaos runs (`CHAOS.md`, "After REVIEW-4"): Bob's abort in `secret_seen` waits until his Ethereum lock is closed in a FINAL block and
  visible in the poll (a refund or claim a reorg can still take back must not end the file), and a file that already received its ETH
  (`eth_claim_final`) does not look for another lock when a reorg of its NOID recovery close sends it back to `funding_final`.
- **R4-7, a refund known only from the `getLock` record becomes final.** The record gives no block, so the watcher reports the poll's head,
  which grows. Bob's `refund_mined` treated every growth as a re-inclusion and restarted the finality count at every poll. Now a record-only
  refund (zero tx hash, `claim_state_from_record`) that only moves up is the same refund, counted from the block first seen, exactly as for Alice's
  claim.
- **R4-8, Bob's post-lock view is no longer a single quiet source (`src/engine.rs`, `scripts/live/env.sh`, `scripts/live/README.md`).** While
  Bob waits for the secret every tick compares the Ethereum head time with the clock (the limit `lock_eth` already used, 600 s; not under
  `rehearsal`) and a lagging first or second node puts an `ALARM` in the action reason and the notes. With two Ethereum nodes the secret is read
  from either one; each candidate is checked against the hashlock and the NOID address, so a junk preimage on one node never hides the real one on
  the other. The helpers passed `--single-node-ok` by default when a second node was missing (opt-in since REVIEW-5), and `single_node_warning` now prints on every
  `node_flags` call (every tick, every claim), and the README says a run with a stranger needs BOTH `NOID_RPC2` and `ETH_RPC2`.
- **R4-9, `lost` needs the second node.** Where the profile asks for a second node (production, sepolia) and `--single-node-ok` was not given,
  `lost` is declared only if the second Parano1d node was read, is fresh, has itself reached `D + 18` and does not list the instance. A second
  node that was configured but cannot be read blocks it whatever the flag says. The note says to recover with the wallet if the instance is still
  listed.
- **R4-10, a second ledger spend beside a held intent is refused.** The ledger holds one intent. A different ledger spend due beside it (a
  `refund_noid` at `D` beside a held `reveal_eth`) used to be printed with parameters at every tick and never recorded. It is now `wait` with
  the reason and the frozen parameters of the held intent until that one resolves or is cancelled. After `D` only the recovery branch is open, so
  nobody races the delay. `claim_noid` is not a ledger kind and still goes through (REVIEW-2 F9).
- **R4-11, the drop grace is a profile value and the relay-floor note reaches a `done` that still needs a refund.** `Gates::tx_grace_s`: 600 s
  for production and sepolia, 120 s for rehearsal (whose whole reveal window is 600 s); `validate` requires at least two rebroadcast times. The
  relay-floor and "several instances" notes are shown for a `done` file whose leg is still refundable.
- **R4-12, documentation.** `PROJECT.md` decision 6 and design section 9.1 already say 735 / 629 / 252 (historical derivations keep the old
  numbers, marked as such). **Production swap files created before the `B_safety` 30 change (`D_offset` 725) no longer load, by design:** the
  file's `D` is re-derived at load and must equal `h_create` plus the profile's offset; a swap in flight would need the wallet.

Not changed: Alice's `lost` is judged on Bob's refund as the first node reports it, so a refund known only from the record (R4-7's case, Alice's
side) stays "not final" for her and `lost` is not reached while the log is missing (it fails safe; the wallet recovers the NOID).

## What REVIEW-3 changed (2026-11-05)

`REVIEW-3.md` re-checked the REVIEW-2 fixes. This section lists what was fixed since, finding by finding (F3 first; the
others follow).

- **F7, the secret can come from the contract's record; `--eth-from-block` is stored (`src/watch/eth.rs`, `src/swapfile.rs`, `src/main.rs`, `eth/scripts/live.js`).**
  *Plain words:* Bob learns the secret when Alice claims his Ethereum lock. The tool read it only from the `Claimed` log, but a public
  node's log index can lag for minutes (or hours), and the contract itself already keeps the secret next to the lock's `claimed` flag
  (`getLock`). Now, when the record says claimed and no `Claimed` log is found, the watcher takes the preimage from the record, requires
  `sha256(preimage) == hashlock` (else a decode error), and reports the claim as if a log had shown it (`tx_hash` zero, `block_number` =
  the latest block, an upper bound, so finality is waited for conservatively); the observation carries `claim_state_from_record: true`
  and Bob's tick notes where the secret came from. A refunded record without a `Refunded` log is accepted the same way. Still an
  error: a log that says claimed/refunded while the record does not, a record preimage that differs from the log's, a record
  refunded next to a `Claimed` log, or both flags set. Second part: `--eth-from-block` was typed on every command and defaulted to 0.
  Now `SwapFile.eth_from_block` (optional, `#[serde(default)]`) holds it: `tick --apply` and `claim --submit` store a flag value
  that differs from the file's (history `eth_from_block_set:N`); a command without the flag uses the stored value; with neither, 0
  is used on chain ids 31337/1337 or with a fixture, and a live node on another chain is refused with `give --eth-from-block N
  once ...`. `live.js --swap FILE` takes `--from-block` from the file when omitted (a given flag wins). Tests:
  `watch_eth.rs` (`f7_a_claimed_record_without_a_claimed_log_yields_the_preimage_from_the_record`,
  `f7_real_contradictions_between_the_record_and_the_logs_still_fail`, the changed `get_lock_disagreeing_with_events_is_a_decode_error`),
  `scenarios.rs` (`f7_bob_sees_the_secret_from_the_get_lock_record_when_the_claimed_log_is_missing`), `cli_live.rs`
  (`f7_eth_from_block_is_stored_by_apply_reused_without_the_flag_and_required_on_a_public_chain`,
  `f7_eth_from_block_defaults_to_zero_only_on_a_local_chain`), `eth/test/live.test.js` (the file's `eth_from_block`).
- **F2, no typed attestation outside rehearsal; the image id is a constant of the build (`src/main.rs`, `src/swapfile.rs`, `src/params.rs`, `src/equiv.rs`).**
  *Plain words:* Bob must be sure that Alice's hashlock `H` and her claim address `A` come from one secret. The check is a RISC Zero
  receipt; this tool runs the verifier itself. Before, two doors stayed open: Bob could *type* what the verifier supposedly printed
  (a stranger Alice says "the prover crashed, just type these"), and the image id of the proof program (the fingerprint of the exact
  program the receipt is about) was a flag Bob typed. Now (1) the typed form (`--equiv-h/-a/-image-id`, no `--receipt`) is accepted
  under the `rehearsal` profile only; `new-bob` refuses it under `production` and `sepolia` with a message saying the receipt must be
  verified by this tool (`--receipt FILE --equiv-prove BIN`), and `EquivalenceAttestation::check` (so `load` and `SwapFile::new_bob`)
  refuses a `typed` attestation in any other profile, so an older file fails closed; (2) `params::EQUIV_IMAGE_ID` (`7e9d8477…6187`)
  is a constant of the build. `--pinned-image-id` is optional: omitted means the constant, given must equal it, else refused with
  nothing written (no override). `check` requires `pinned_image_id == EQUIV_IMAGE_ID` and `image_id == pinned_image_id`;
  `verify_receipt` compares the id the verifier printed with the constant (`VerifyRequest` lost its `pinned_image_id` field).
  **The constant is the id of the LOCAL build of `equiv/zkvm/methods/guest` at this commit.** When the reproducible docker build
  (milestone M1.1) is done, replace the constant; a file pinned to the old id then stops loading on purpose. Tests:
  `tests/equiv.rs` (`the_typed_form_is_refused_outside_rehearsal_and_works_under_it`, `an_image_id_other_than_the_compiled_in_one_is_a_refusal`,
  the pin cases in `refusals_write_no_swap_file`), `tests/rehearsal_cli.rs` (`the_typed_attestation_is_rehearsal_only_and_the_image_id_pin_is_a_constant`),
  `tests/cli.rs` (the production flow now goes through a stand-in `equiv-prove`; pin omitted / equal accepted, other refused; typed
  refused), `swapfile::tests` (`check_refuses_a_typed_attestation_outside_rehearsal_and_a_pin_that_is_not_the_constant`,
  `load_refuses_a_bob_file_with_a_typed_attestation_outside_rehearsal`). The test helper `example_attestation` is now receipt-shaped.
- **F4, children get an allow-listed environment (`src/child_env.rs`, `src/equiv.rs`, `src/watch/exec.rs`).** *Plain words:* a program
  this tool starts (`curl` for the `curl` transport, `equiv-prove` for the receipt) used to inherit the whole environment, including
  `SWAP_PASSPHRASE` (opens the swap file that seals the secret) and `RISC0_DEV_MODE` (which, in an older verifier, made a fake receipt
  pass: G1). The same user can read a process's environment, so both runners now call `child_env::apply`: `env_clear()` and only the
  names in `CHILD_ENV_ALLOWLIST` (`PATH`, `HOME`, `USERPROFILE`, `SYSTEMROOT`, `SystemRoot`, `WINDIR`, `TEMP`, `TMP`, `LANG`, `LC_ALL`,
  `SSL_CERT_FILE`, `SSL_CERT_DIR`, `CURL_CA_BUNDLE`, `CURL_HOME`, `HTTP_PROXY`, `HTTPS_PROXY`, `NO_PROXY` and the lower-case proxy
  names) are passed on, enough for `curl.exe` on Windows and WSL. Tests: `child_env::tests`, `watch::exec::tests::the_child_never_sees_the_passphrase_or_dev_mode_but_keeps_path`,
  `tests/equiv.rs` `the_verifier_child_gets_no_passphrase_and_no_dev_mode` (the real `swap-cli new-bob` started with both variables
  set; the stand-in verifier records `unset` for both and the allow-listed `LC_ALL`).

- **F1, the HTLC code hash is a constant of the build, not something an operator types.** REVIEW-3 showed the pin was whatever the
  operator typed, so a counterparty who deployed a look-alike contract could send "the address and the hash from the deploy output" and
  every check would pass against the attacker's number. Now `swap_cli::params::HTLC_CODE_HASH` holds `keccak256` of the runtime code of
  `eth/contracts/HTLC.sol` (`0xa906117fc4e604bd25fcee2a6a41da8b824ec9b4a17d10137704e7da42545e2f`, 2,633 bytes, Hardhat with solc 0.8.24;
  the local run-1 and the Sepolia deployment both reported it). Rules:
  - `new-alice` and `new-bob`: `--eth-code-hash` is optional. Omitted, the constant is used. Given, it must equal the constant, else the
    command stops before reading the bundle or writing anything, naming the compiled-in value and saying that a different value means a
    different contract. There is no override flag. `--eth-chain-id` stays mandatory.
  - `SwapPublic::check` (run by `build`, `new-bob` and `load`) requires the pin to be the constant: a bundle from the counterparty that
    pins another contract (or none) is refused, and so is a swap file written by another build (fail closed). `check_bob_terms` also
    requires Bob's own terms to equal the constant. `lock_matches` and `spend_blocker` still compare the chain against the pin, which is now
    always the constant.
  - `live.js lock|claim|refund`: `--code-hash` is optional; the default and the only accepted value is `keccak256(deployedBytecode)` of
    `eth/artifacts/contracts/HTLC.sol/HTLC.json` (missing artifact: "run `npx hardhat compile`"). With `--swap FILE` the file's `code_hash`
    must equal it too. `deploy` still reports `matchesArtifact`.
  - A unit test (`params::tests::htlc_code_hash_is_the_local_artifacts_runtime_code_hash`) compares the constant with the artifact
    whenever `eth/artifacts` is compiled (it prints `SKIPPED` otherwise). Changing `HTLC.sol` therefore needs a deliberate new constant
    and a new tool build; old swap files then refuse to load.
  Tests: `tests/cli.rs` `chain_id_is_mandatory_and_the_code_hash_is_the_compiled_in_constant_for_both_roles` and the omitted case in
  `alice_and_bob_files_through_the_binary`; `swapfile.rs` `bundle_arithmetic_is_checked_and_the_code_hash_is_the_compiled_in_constant`,
  `a_saved_file_pinning_another_contract_does_not_load`; `eth/test/live.test.js` "REVIEW-3 F1" (three).
- **F3, the ledger no longer has a way around it (three gaps).**
  1. *A read-only tick hands out no spend.* `tick` without `--apply` (and `claim` without `--submit`, when the engine's action is not
     `claim_noid`) prints a ledger spend as `{"kind": "lock_eth", "parameters": "withheld", "note": "a read-only tick records nothing; run
     tick --apply to record this intent and print its parameters"}` and nothing else of it. An intent already held keeps printing its
     frozen parameters in the `wait`; `claim_noid` is not a ledger kind (`swap-cli claim` runs it) and prints as before. Test:
     `tests/cli.rs` `read_only_tick_withholds_the_parameters_of_a_spend_and_apply_records_and_prints_them`.
  2. *`intent --cancel` fails closed while a send may be pending* (`engine::cancel_intent`). It refuses, naming the rule, when the chain
     already shows the effect (as before); when the intent is younger than `MIN_CANCEL_AGE_S` = 600 s; for `lock_eth`, `refund_eth` (Bob,
     signer `bob_sender`) and `reveal_eth` (Alice, signer `alice_receiver`) when the signer's `eth_getTransactionCount` at `pending` is above
     the one at `latest`, or either is unknown; for `refund_noid` when the instance shows a pending call. The two nonces are new fields of
     the Ethereum observation (`signer_nonce_latest`, `signer_nonce_pending`), read last in each poll for the file's own role. A node or a
     recording without the call gives "unknown" (like F5's header time): an ordinary `tick` never fails on it, but a cancel is then refused.
     Existing recordings need no change; to cancel from a fixture, append the two calls (`tests/cli.rs` shows it). Tests: `tests/intents.rs`
     `f3_*` (age, a lock stuck in the Ethereum mempool, unknown nonces, a pending reveal and refund, a pending Parano1d refund),
     `tests/watch_eth.rs` `f3_signer_nonces_*`.
  3. *`live.js lock|claim|refund --swap FILE`* (`eth/scripts/live.js`, tests `eth/test/live.test.js` "--swap FILE"). The script reads the
     JSON swap file (never its `secret`). `--chain-id`, `--contract`, `--code-hash` and the terms may be omitted and are then taken from the
     file; when given they must equal it (the code hash must in addition equal the local artifact's, see F1 below). `lock` needs a `lock_eth` intent whose `t_reveal` is used (a different `--t-reveal`,
     `--hashlock`, `--receiver` or `--amount-wei` is refused) and the key must be the file's `bob_sender`. `claim` needs a `reveal_eth` intent
     and the intent's `lock_id`; the lock on chain must have the file's receiver, sender, amount and hashlock and the `t_reveal` the intent
     froze; the cutoff is the earlier of `timelock - --margin-s` and the `cutoff` the engine froze into the intent from the file's `M_A` (the
     flag can tighten it, never loosen it). `refund` needs a `refund_eth` intent and its `lock_id`, and the same lock check. Every refusal
     names the two values that disagree. Without `--swap` the command line prints
     `warning: no --swap FILE, the swap file's intent is not checked (REVIEW-3 F3)` and behaves as before (so deploy and test flows keep
     working). The engine now writes `t_reveal` and `cutoff` into the `reveal_eth` intent; an intent recorded before this change lacks them and
     `claim --swap` refuses it (cancel it and tick again).
- **F10 (Alice side), two fitting instances stop her reveal.** Every instance at Alice's root has the same claim authority `Addr(s)` and
  `claim_recipient = Bob`, so after the reveal Bob can close each one that holds the agreed amount and opens to the agreed terms. In
  `A::LockFinal` the engine now counts the instances for which `instance_fits` is true; when there is more than one it does not
  `reveal_eth`: `wait` with "not revealing: N instances with the agreed amount sit at the contract root (slots …); revealing would let Bob
  claim every one of them; the swap ends by refund at D …", the same text in the notes, and no override flag. At `D` the usual
  `refund_noid` takes the recorded instance back; the notes then name every other instance (slot, creation, amount) so the operator
  refunds those with the wallet (`alice_leftover_refund` names them too). An instance of another amount (dust) does not count and does not
  stop the reveal; the "N instances at our contract root" note still lists it. If the extra instance goes away, the reveal goes ahead.
  Bob's wait on several fitting instances before he locks is unchanged. Tests: `tests/scenarios.rs` `f10_alice_*`.
- **G2, extra locks no longer cancel the reveal.** The REVIEW-2 F10 rule below ("another open lock on the agreed terms stops her
  `reveal_eth`") gave Bob a free cancel option after locking: a second identical lock stopped Alice's tool, both locks refunded to him at
  `T_reveal`. An extra open lock on the agreed terms has Alice as receiver and is hers to claim with the same secret, so it can only pay
  her more. Alice now reveals on the recorded lock and the notes carry "N other open lock(s) on the agreed terms, claimable by Alice with
  the same secret once revealed: …". A recorded lock that is missing, claimed or refunded still blocks the reveal (`spend_blocker`).
  Tests: `tests/scenarios.rs` `g2_*`.
  Alice's funding is still the manual `parano1d-cli contract fund`; see the funding discipline in the intent-ledger paragraph below.
- **F5, an unknown header time blocks; the second node is a different node; Bob does not wait on a lie (`src/engine.rs`, `src/main.rs`,
  `src/watch/http.rs`, `src/params.rs`).** *Plain words:* the tool judges whether a Parano1d node is behind by the timestamp of its newest block.
  A node that serves a frozen chain and simply fails that question used to pass, and a second "independent" node could be the first one again.
  Now (1) `tip_time = None` holds every NOID-side spend (`fund_noid`, `lock_eth`, `reveal_eth`, `claim_noid`, `refund_noid`) with a reason naming
  F5 and the remedy (a node that answers `paranoid_getBlockHeader`); a recording made before F5 shows that blocker instead of a spend;
  `refund_eth` is unaffected. (2) `profile sepolia` follows the production rule: one node waits before `lock_eth` and `reveal_eth` unless
  `--single-node-ok`; `rehearsal` keeps the note (`ProfileName::requires_second_node`). (3) Where Bob's claim would wait on a pending call
  the primary reports, a fresh second node within 2 blocks that sees none ends the wait, with a note; otherwise the wait stands. Tests:
  `tests/scenarios.rs` `f5_an_unknown_header_time_blocks_every_noid_side_spend_and_names_the_remedy`,
  `f5_sepolia_with_one_node_waits_before_the_lock_and_the_reveal_unless_single_node_ok`, `f5_rehearsal_accepts_one_node_with_a_note`,
  `f5_bob_does_not_wait_on_a_pending_close_the_second_node_does_not_see`, `f5_bob_keeps_waiting_on_a_pending_close_without_a_usable_second_opinion`;
  `engine::tests::header_time_known_old_waits_unknown_notes_and_fresh_is_silent` and `params::tests` (the profile table). The test harness
  now gives every observation a fresh header time by default; the shared Parano1d fixtures have no `getBlockHeader` call (the watcher tests
  rely on that), so `tests/cli.rs` replays a copy with one and the claim mock in `tests/cli_live.rs` answers it.
- **G3, the second endpoint must differ from the first (`src/main.rs` `chain_source`, `src/watch/http.rs` `normalize_endpoint`).** *Plain words:*
  asking the same node twice and calling the two answers "independent" proves nothing. `--noid-rpc X --noid-rpc X` (or `--eth-rpc`) is refused
  before any connection, naming the endpoint without its path or key; so is a fixture given twice. Same host with another port passes with a
  note in the tick. Tests: `tests/cli_live.rs` (`two_noid_rpc_flags_*`, `two_eth_fixtures_*`), `watch::http::tests::normalize_endpoint_*`, `main.rs`
  `the_second_node_must_be_another_endpoint_and_a_shared_host_is_noted`, `the_second_fixture_must_be_another_file`.

## M2.5b (2026-11-05): Bob's ETH refund follows Ethereum finality; Alice's lost reveal is named

*Plain words:* a refund that is merely mined can still be undone by a chain reorganisation, so Bob's file no longer calls the ETH leg finished until
Ethereum says the block is final (the rule the tool already applied to Parano1d closes, REVIEW-2 F6, and to Alice's ETH claim). And Alice no longer sits in
`reveal_submitted` saying "ETH claim pending" when Bob's refund has already won the race.

- **Bob.** New non-terminal phase `refund_mined { instance, lock, block_number }`. `eth_refund_mined` now leads there (from `locked` and `refund_submitted`)
  instead of straight to `refunded`; `eth_refund_final` (the observation's `finalized_block` has reached the refund's block) leads to `refunded`;
  `eth_refund_reorged` (no refund in the observation, the lock visible, open and unclaimed) leads back to `locked`, from which `refund_eth` is offered
  again (in the same tick, as `locked` always did); a secret visible instead (the reorg mined Alice's claim) leads to `secret_seen` and the NOID claim. A lock
  that is not visible at all, or visible and closed without a refund in the observation, keeps the phase and adds a "fail closed" note. A refund seen at a
  different block restarts the finality count. The intent ledger treats `refund_mined` like `refund_submitted`: the `refund_eth` effect is on chain.
  `tick --closed-by` refuses it like `locked` (the secret is not known to the file).
- **Alice.** In `reveal_submitted`: the truthful wait reason above; the note for `eth_refund_mined` says the reveal reverted (no ANOMALY). New terminal phase
  `lost { lock, instance, refund_block, reason }` (event `both_legs_lost`) under the conditions in the table above; the reason names the ETH block and the NOID instance (slot, creation).
  A decided `refund_noid` blocks the verdict, since a missing instance could then be her own recovery close made outside the tool.
- **Tests (`tests/scenarios.rs`, `src/state.rs`; the simulator gained `World::drop_eth_refund` and `World::replace_eth_refund_with_claim`).**
  `m25b_bobs_refund_is_terminal_only_once_final`, `m25b_bobs_refund_reorged_out_returns_to_locked_and_is_sent_again`,
  `m25b_bobs_refund_re_included_at_another_block_restarts_the_count`, `m25b_bobs_refund_reorged_into_alices_claim_gives_him_the_secret`,
  `m25b_a_refund_that_vanished_with_the_lock_not_visible_keeps_bob_in_refund_mined`,
  `m25b_alice_reveal_pending_bobs_refund_first_bob_never_claims_alice_refunds_at_d`,
  `m25b_alice_loses_both_legs_when_bob_refunds_and_claims_with_the_exposed_secret`,
  `m25b_alice_is_not_declared_lost_while_a_refund_noid_was_decided_for_her`; `state::tests::m25b_*` (2). The older "both refund" scenarios (production,
  rehearsal, sepolia, v2), the Alice-logs-the-refund pair, the two `m25d` tests that start from Bob's refund, and the `refund_eth` intent test now go
  through `refund_mined` and wait for finality before they expect `refunded`.
- **Not exercised live.** Everything above is simulator-tested; no live run has reorged an Ethereum refund, and Hardhat's `finalized` tag decides how soon a
  local rehearsal sees `refunded` (the same dependence Alice's `done` already has).

## What REVIEW-2 changed (2026-11-04)

`REVIEW-2.md` (independent, adversarial) found the engine right inside one tick and the edges weak. Fixed here:

- **F1, ETH code hash and chain id are mandatory and checked before every ETH spend.** `new-alice` and
  `new-bob` refuse to run without `--eth-code-hash 0x<64 hex>` (keccak256 of the HTLC runtime code) and
  `--eth-chain-id`, with a message saying why; there is no escape flag, and Bob's code hash is part of HIS
  terms, compared with the bundle. The ETH watcher reads `eth_chainId` and `keccak256(eth_getCode(contract))`
  on EVERY poll (before any lock exists); a node that cannot answer fails the poll. `spend_blocker` requires
  both, equal to the pinned values, for `lock_eth`, `reveal_eth` and `refund_eth` (it waits with a note
  otherwise); a swap file with no pinned hash (an old one) can never spend ETH. `lock_matches` is strict too.
  The recorded fixtures under `fixtures/eth/` got hand-added `eth_chainId` and Locked-block records and a
  reordered, param-free contract `eth_getCode` (the eth/ recorder script is outside this crate and was not
  updated: re-recording would drop them).
- **F3, the intent ledger.** `tick --apply` writes `pending_intent { action, params, decided_at,
  phase_at_decision, noid_tip, eth_block }` into the swap file BEFORE printing a spending action
  (`fund_noid`, `lock_eth`, `reveal_eth`, `refund_eth`, `refund_noid`; history entries `intent_decided:…`).
  While it is pending and the chain does not show its effect (the phase moved, a funded instance is visible,
  the recovery close removed the instance), `tick` answers `wait` with "intent <action> pending since <unix>:
  the chain does not show it yet; reuse the printed parameters, or `swap-cli intent FILE --cancel` …", the
  frozen parameters in a note and the `intent` object, and never emits that action again. It resolves into the
  history (`intent_resolved:…`) when the chain shows the effect. `fund_noid` is also not offered while an
  instance already sits at our root, nor `refund_noid` when it is gone. A read-only `tick` records nothing but
  still holds. New command: `swap-cli intent FILE [--show]` prints it; `swap-cli intent FILE --cancel` (with the
  same chain flags as `tick`: it must look at the chain) drops an intent that was never sent and REFUSES if the
  chain already shows its effect (REVIEW-3 F3 made the cancel fail closed and tied `live.js` to the file: see "What REVIEW-3
  changed"). The tool still does not send these actions; the operator uses the parameters `tick --apply` printed. Funding
  discipline: Alice funds only from the parameters a `tick --apply` has just recorded, and `tick --apply` refuses `fund_noid` while any
  instance exists at the root (`tick_apply`, the `noid.instance.is_some()` guard); the manual `parano1d-cli contract fund` has no
  other guard, so a second fund from a stale printout creates a second instance.
- **F7 (engine side).** (Since REVIEW-3 F7 the secret may also come from the `getLock` record when the `Claimed` log is
  missing; see "What REVIEW-3 changed".) With a lock id known (Bob from `T_reveal` or a frozen `lock_eth` intent; Alice once
  discovered) the watcher calls `getLock` on every poll. An empty log answer plus a `getLock` record fails the
  poll loudly (naming `--eth-from-block`, a range limit, a lagging index); only a `LockNotFound` revert means
  "no lock". `refund_eth` needs the named lock visible and neither claimed nor refunded; `reveal_eth` needs it
  visible, final, matching the agreed terms, and open.
- **F8.** `tick --apply`, `claim --submit` and `intent --cancel` hold an exclusive OS file lock on
  `<swap file>.lock` (`File::try_lock`; waits up to 10 s, then says another swap-cli command is using the file;
  dies with the process, so no stale lock). `save` writes `<file>.<pid>.<random>.tmp`, created new. Checked 2026-11-05: `flock`
  excludes on WSL's 9p drvfs mount (`/mnt/c`) exactly as on ext4 (two holders, the second refused), so a swap file under `/mnt/c` is
  protected between WSL processes; a Windows-native and a WSL `swap-cli` on the same file are untested, so keep swap files in WSL
  home (mode 700), as the live runs do.
- **F11.** Alice accepts a lock only if `T_reveal − (timestamp of the block that mined it) ≥ W_A_min` (5,400 s,
  (I3)); the watcher reads that block's timestamp (`EthLock.block_timestamp`); unknown = not accepted.
- **F12.** `--now` with a live RPC is refused. **F14.** `--fast-kdf` and `KdfParams::fast_for_tests` exist only
  under `cfg(test)` or the `dev` feature (a normal or `--release` build rejects the flag); `m_cost_kib`,
  `t_cost`, `p_cost` read from a file are bounded (512 MiB, 16, 8) at load and at use.
- **F13.** Checked arithmetic on bundle data (`h_create + 735`) and node data (`tip + B_FUND + B_FINAL`);
  the harness' `expect` (outside this crate) is wrapped so a panic becomes an error.

- **F2 (done, `src/equiv.rs`).** `new-bob --receipt PATH --equiv-prove BIN [--pinned-image-id HEX]` runs
  `BIN verify <variant> <H> <A> PATH` as a subprocess, with H and A read from the bundle (never typed) and `<variant>` the bundle's
  unless `--variant` says otherwise. It requires exit status 0, an `OK: exists m with sha256(m) = H and Addr(m) = A` line that names
  the right variant (`Addr(Derive(m,0))` for stock), exactly one image id on an `image id: <64 hex>` line, and that id equal to
  the image id compiled into the tool (REVIEW-3 F2; it was `--pinned-image-id`); any `H : …` / `A : …` echo must equal the bundle's. (`equiv-prove verify` does not echo H and A, see the notes
  in `src/equiv.rs`; they are enforced by passing the bundle's values.) The subprocess goes through the `CommandRunner` trait as
  `Step::EquivVerify`; `equiv::ProcessRunner` is the real implementation and refuses every other step; tests use fakes. A missing BIN,
  a missing receipt, a non-zero exit, a wrong image id, a wrong variant line and a tampered bundle each refuse, and no swap file is
  written. Bob's file then records `equivalence: { source: "receipt", receipt_path, receipt_sha256, verified_at, image_id,
  pinned_image_id, journal }` (the digest is of the receipt bytes the tool read). With `--receipt` the typed `--equiv-h`, `--equiv-a`,
  `--equiv-image-id` are optional and, if given, must agree. Without `--receipt` the typed form is the REHEARSAL-only fallback (REVIEW-3 F2, above: refused
  under production and sepolia, and on load) and the file records `source: "typed"`. The image id is now a constant of the build (REVIEW-3 F2);
  it is the local build's until the reproducible docker image id of M1.1 exists.
- **Rehearsal and sepolia profiles (`docs/ideas.md` idea 3, done).** See "The rehearsal and sepolia profiles" below: gate numbers come from the
  profile the swap file names, never from a global.

- **F9 (leftover legs, done; REVIEW-1 M1).** Once the secret is public the NOID leg and the ETH leg are independent, and each
  party now cleans up what is still theirs. *Plain words:* a refund returns your own money after a deadline; "leftover" is the
  leg that did not settle.
  - **Bob** (`refund_eth` after the secret). From `secret_seen`, `claim_submitted`, `claim_included` and `done`, when `getLock` shows
    his lock open (neither claimed nor refunded) and the chain clock is at or past `T_reveal`, the engine offers `refund_eth`. It never
    aborts while that is still possible: a closed claim branch (`TooLate`) with the lock open and `T_reveal` still ahead is a `wait`
    ("claim branch closed; the ETH lock is still open: refund_eth opens at T_reveal …"); the terminal `abort` stays for a lock that is
    claimed, refunded or not visible (Bob lost, or has nothing left). One action per tick: `claim_noid` goes first whenever the claim
    is still possible (on target or late but valid), with a note "refund_eth is also due"; `refund_eth` follows on the next tick,
    when the claim's phase has moved on. The refund after the secret is **log-only** for the phase: `eth_refund_submitted` and
    `eth_refund_mined` are recorded in the history and the claim's phase (`claim_submitted`/`claim_included`/`done`) is not touched; the
    history is also what makes the refund one-shot. Before the secret nothing changed (`locked` -> `refund_submitted` -> `refunded`).
    `BobPhase::Done` now carries the lock it settled against (`lock`, optional: a file from before F9 loads with none and offers
    nothing).
  - **Alice** (`refund_noid` after the reveal). From `reveal_submitted`, `revealed` and `done`, when the next call height has reached
    `D` (Bob's claim branch is closed for good) and the instance she recorded (same slot AND creation id) is still at the contract and
    still fits the agreement, the engine offers `refund_noid`, the same recovery close as before the reveal. `AlicePhase::Done` now
    carries that instance (`instance`, optional; a file from before F9 learns it from the node on a normal tick, from an instance that
    fits). While `done` and the NOID is still there, the wait reason says when `refund_noid` opens. The phase path is the existing one
    (`refund_submitted` -> `refund_included` -> `refunded`, a rollback falls back as in F6); `tick --closed-by` now also accepts the
    wallet CLI's recovery close from these three phases (the existing `h >= D` rule still refuses an earlier close, which paid Bob).
    The final `refunded` reason says "NOID refunded after the reveal; Bob never claimed it, so both legs ended with Alice" when the
    history shows a reveal.
  - **Intent ledger.** A `refund_noid` or `refund_eth` intent now resolves only when its own chain shows it (the recorded instance is
    gone; the named lock is refunded or claimed), not when the phase moves for another reason (`revealed` -> `done`, a claim submitted).
    `claim_noid` is never held back by a pending `refund_eth` intent (they spend different things).
  - Tests: `tests/scenarios.rs` `f9_*` and `bob_offline_until_d_...` (a stalled reveal past `T_reveal`: Bob claims the NOID, refunds the
    ETH and holds both legs because Alice's claim never landed; a closed claim branch is no abort while the lock is refundable; Alice
    revealed and Bob never claims: both legs end with Alice; `--closed-by` after the reveal), `tests/intents.rs` `f9_*`. The simulator has
    a `freeze_eth_claim` knob (a stalled Ethereum inclusion).
  - An honest Alice's claim is final before `T_reveal` by (I2) (the reveal cutoff `T_reveal − M_A`), so Bob holds both legs only when
    her claim was submitted in time and still did not land for `M_A` seconds (a stalled Ethereum); that is the rule of the design
    (§2.3 row 4), which the tool now carries to its end instead of stopping at `abort`.
- **F10 (every lock and every instance, done).** *Plain words:* nothing is hidden behind "the first one".
  - **Watchers.** `NoidObservation.instances` lists EVERY non-empty slot of the root, in slot order, each with its own `matches_opening`
    and `active_authority` (one `getObjectStatus` per slot; one call when there is one instance, as before); `instance_count` is their
    number. `instance`, `instance_matches_opening` and `active_authority` stay and describe the FIRST entry, as before.
    `EthObservation.locks` lists every `Locked` event of the contract that matches the agreed parties and the hashlock (the discovery
    `eth_getLogs` now runs also when the lock id is known, so a second lock is never hidden behind the pinned one), each read in full
    (`getLock`, code of both parties, block timestamp), at most `MAX_LOCKS_READ` (8) of them; `lock_count` counts them all. `lock` stays
    the pinned lock when a lock id is known, else the first match; `locks` puts the pinned one first. Observations built by hand or
    recorded before F10 leave the lists empty, which reads as "just `instance` / `lock`".
  - **Engine, instances.** Dust (or any other instance that does not fit: another amount, or an opening mismatch) no longer hides the
    real one: when exactly ONE instance fits the agreement, every check reads that one (Bob locks on it) and the others are named in
    the `notes` ("N instances at our contract root: slot … "). When SEVERAL fit, Bob does not lock (`wait`: "more than one instance at the
    contract root", not an abort, it may clear up) and Alice records none; the notes list them. Dust alone is still "instance seen but not
    accepted". Alice's `fund_noid` guard is unchanged: any instance at the root stops a second funding (so dust placed BEFORE she funds
    stops her, loudly; fund first, the dust cannot hide anything after).
  - **Engine, locks.** Alice judges each matching lock on its own (terms, closed, (I3), cutoff): with exactly one acceptable she takes
    it (a wrong-amount first lock no longer hides a correct second one); with several acceptable she takes none and says so; after she
    recorded a lock, another OPEN lock on the agreed terms used to stop her `reveal_eth`; since REVIEW-3 G2 it only adds a note (she reveals
    on the recorded lock; see "What REVIEW-3 changed"). Bob looks at all of them when waiting for his own lock to show. Both roles list
    every lock in the notes while more than one exists.
  - Tests: `tests/scenarios.rs` `f10_*`, `tests/watch_parano1d.rs` / `tests/watch_eth_discovery.rs` `f10_*` (scripted node with several
    locks, the cap, a pinned id, a page with dust first); the recorded fixtures are unchanged except for the new fields.

- **F5, lag and lies.** The tip block's header time (`paranoid_getBlockHeader`) holds NOID-side spends when it trails the clock by more
  than 300 s or is unknown (REVIEW-3: fail closed); the Ethereum head holds `lock_eth` / `reveal_eth` past 600 s; a second node (`--noid-rpc` / `--eth-rpc` twice) must agree before
  Bob locks and before Alice reveals, and under `production` and `sepolia` a single node blocks those two steps unless `--single-node-ok`; plain `http://`
  leaves the machine only with `--allow-plain-http`. Details: "F5: second node, header time, plain HTTP" under "The CLI". Not covered: the
  header method was never called against the live node; two providers are not independent of the network path; documenting that each party runs
  their own Parano1d node is all that is done about a lying path.

Not done: the compiled-in image id of F2 (it needs the reproducible docker build of M1.1; the pin is a CLI flag checked against the receipt).

## What the chaos test changed (2026-11-05)

`CHAOS.md` lists the sixteen findings of the seeded chaos test and, in its "Fix status" table, which are fixed and where the test is
(`tests/chaos_fixes.rs`, plus the chaos run itself, which no longer lets any of those symptoms through). In short: Alice's `revealed` re-checks her
claim before `done` (a reorg sends her back to `reveal_submitted`); a submitted Ethereum lock, reveal or refund that is no longer pending
(the signer's pending nonce equals its latest) and not mined after 10 minutes is treated as dropped and offered again; `intent --cancel` of a
`fund_noid` needs the node to say no funding is pending, or the operator's `--i-checked-the-wallet` (a real node cannot list a funding in its
mempool); `tick --apply` records `abort` (not while a funding or lock decided for the swap was never cancelled); Alice on the CLI path can
reach `lost`; the reveal needs the instance in that very poll; funding finality restarts when the instance is absent from a poll or comes back as
another incarnation; `refund_noid` is not offered for an instance that is gone, on either path; `done` is *settled* but no longer *terminal*
(`Phase::is_settled()` vs `is_terminal()`); the formal-model findings: `Gates::validate` checks the two `DE`/`RA` relations and the production
`B_safety` is 30 (`D_offset` 735).

## Contract versions (`--contract-version 1|2`)

The NOID is locked in one of two Parano1d contracts. Which one is a swap parameter, like the profile.

| | v1 `HashTimeLock` (default) | v2 `HashTimeLockV2` (fixed fee) |
|---|---|---|
| Pruv source | `parano1d/contracts/htlc.pruv` | `parano1d/contracts/htlc_v2.pruv` (`require terminal; require fee == max_fee;`) |
| Fee of a close (Bob's claim, Alice's recovery) | any fee in `[5,800, max_fee]`; the engine picks the live estimate clamped to that range (`engine::close_fee`) | **exactly `max_fee`** (`engine::close_fee_for` returns it; the live estimate and floor do not choose) |
| `max_fee` means | a ceiling | the ceiling and the price |
| Bob receives | `amount − (the fee paid)`, unknown until the close | `amount − max_fee`, known up front (`SwapParams::expected_bob_payout`, shown by `status` and `alice-params`) |
| Why | simplest | removes the cheap-close stall: nobody can broadcast a lower-fee close that Bob cannot outbid (first-seen mempool, no replace-by-fee); `docs/htlc-v2-fixed-fee.md` |
| Address | `Addr`-style root of the v1 opening | a different root for identical parameters (the program is part of the opening) |

- **Flags.** `new-alice --contract-version 1|2` (default 1) writes it. `new-bob --contract-version 1|2` (default 1) is Bob's own term, like
  `--profile`: a bundle of the other version is refused (`bundle disagrees with your terms: the bundle locks the NOID in contract v2 … you asked
  for v1`), and he rebuilds the opening from the matching program. `status` shows `contract_version` (and, for v2, `fixed_close_fee_micronoid` and
  `expected_bob_payout_micronoid`); `alice-params` emits the matching definition, `pruv --params` file, `contract_source` and `fee_rule`, and for v2
  fills `--fee <max_fee>` into the printed recovery-close command. `tick`, `claim` and `intent` read the version from the swap file; they have no flag.
- **The `max_fee` rule, by version** (`params::fee_cap_for`, applied by `new-alice`; both at most 1 % of `V`, both at least 5,800):
  v1 `F_max = max(50,000, 3 × estimateFeeDetailed(1,1))`; v2 `F_max = max(50,000, 5 × floor_seen)` with
  `floor_seen = max(--fee-estimate, --floor-seen)` (`F_MAX_FLOOR_MULTIPLIER_V2 = 5`, `docs/htlc-v2-fixed-fee.md` section 5). With v2 the number is
  also the price of every close, so a swap whose 1 % cannot pay it is refused (`F_max … exceeds 1 % of the amount`; at the 50,000 minimum that means
  `V ≥ 5 NOID`). `--floor-seen MICRONOID` is the highest relay floor **you** saw in the last 24 h (the tool keeps no floor history); it is a v2 input
  only. With `--contract-version 1` the flag is accepted, ignored, and a note on stderr says so (it is not an error). It is not stored: the file keeps
  `max_fee_micronoid` and nothing else changes, so v1 and older files, their bundles and digests are untouched. Examples: v2 estimate 12,000 gives
  60,000; v2 estimate 5,800 with `--floor-seen 11000` gives 55,000; v1 estimate 12,000 gives 50,000.
- **T5 at lock time, by version.** Before Bob's `lock_eth` the engine requires `max_fee ≥ max(50,000, m × live estimate)` with `m = 3` for a v1 file
  and `m = 5` for a v2 file (read from `params.contract_version`); otherwise it aborts, and the reason names the multiplier and the version
  (`… the contract v2 rule (multiplier 5) (T5)`). A v2 file built at a quiet 50,000 therefore locks while the estimate is ≤ 10,000 and aborts above it
  (v1: ≤ 16,666). `SwapPublic::check` verifies only what the file itself carries (`max_fee ≥ 50,000`, ≤ 1 % of the amount, the opening matches); the
  estimate at lock time is Bob's live reading, so T5 is the real guard.
- **Relay-floor note (both roles, every tick).** `NoidObservation.relay_floor` is `estimateFeeDetailed(1,1).breakdown.relay_floor` (`None` when the
  answer has no breakdown). While the swap is not over, a floor at or above `max_fee` adds the note `relay floor 60,000 >= max_fee 50,000: a close
  cannot be relayed through this node (T5/Q6)` to the tick's notes. It is a note only: the action is whatever the engine would have chosen anyway.
- **How the version is committed on both sides.** `params.contract_version` is in the public section and so in the bundle and in the digest the
  secret is sealed to. `1` is the default and is **not written**, so every file, bundle and fixture written before versions existed is a v1 file
  with the same digest. The real commitment is the opening itself: its program (the code id) is part of the 699 bytes and of the contract address, and
  `SwapPublic::check` (run at creation, in `new-bob`, and on every load of a swap file, so by `tick`, `claim`, `alice-params` and client S) rebuilds the opening byte-for-byte with
  the version's program. Relabelling a v2 bundle as v1, deleting the field, or the reverse, makes the rebuild mismatch; an older tool that does not
  know the field reads a v2 bundle as v1 and refuses it for the same reason.
- **Where the fee rule is enforced.** `engine::close_fee_for` (the action the engine plans), client R `build_claim` (the version is read off the
  opening with `swapfile::detect_contract_version`; a fee other than `max_fee` is `ClaimError::Fee { min: max_fee, max: max_fee }`, before any proof;
  `RawClaimExecutor::plan` also refuses a file whose opening is not the contract it names), client S `preflight` (`StockError::FeeOutOfRange` with
  `min == max`, before any wallet step), and the consensus preflight `check_call` underneath all of them. The v2 definition `alice-params` writes is checked
  for the program shape `terminal; fee == max_fee` (immediate = `max_fee`). The `max_fee ≥ 5,800` guard and the 1 % cap apply to both versions; the engine's
  T5 gate uses the multiplier of the file's version (see below).
- **Tests.** `tests/scenarios.rs` runs v2 happy paths (raw and stock) and both abort paths with a simulator that rejects any v2 close whose fee is not
  `max_fee` and pays Bob `amount − max_fee` (`common/mod.rs`); `tests/client_r.rs` builds a real v2 claim (fee == `max_fee`) and refuses other fees;
  `tests/client_s.rs` the same through the stock script; `tests/contract_version.rs` covers the files, the bundle, `new-bob`'s refusal, `alice-params`
  and the harness' v2 compile against `parano1d/contracts/htlc_v2.definition.json`, and `new-alice`'s `max_fee` by version and `--floor-seen`; `tests/scenarios.rs` also
  covers the T5 multiplier by version and the relay-floor note; `tests/watch_parano1d.rs` the `relay_floor` parse (`None` without a breakdown).
- **Which version the live runs used: v1.** LIVE RUN 1 (`docs/live-run-1.md`), every recorded fixture and the `cli_live`/`watch_parano1d` tests are v1
  (`htlc.pruv`); v2 has had no live run and no node recording yet (it is pruv-verified and harness-tested, `docs/htlc-v2-fixed-fee.md`). The
  simulator is the only v2 "chain" so far.
- **Not done here.** The 24-hour memory of relay floors: `--floor-seen` is the operator's own input at creation, and the watcher does not record
  floors between ticks (the per-tick note and T5 only see the current reading). The factor 5 should be re-derived once Q6 has two weeks of floor data.

## Ethereum lock kinds (`--eth-lock-kind sha256|poseidon`)

The Ethereum leg is locked in one of two contracts. Which one is a swap parameter, like the profile and the contract version
(`docs/poseidon-leg.md` section 9 is the spec; this is what exists).

| | `sha256` (default) | `poseidon` |
|---|---|---|
| Ethereum contract | `eth/contracts/HTLC.sol` | `eth/contracts/HTLCPoseidonV2.sol` |
| Code hash pinned in every file | `params::HTLC_CODE_HASH` (`0xa906117f…e2f`) | `params::HTLC_POSEIDON_V2_CODE_HASH` (`0xf510d2a3…3ff3`) |
| Lock word on Ethereum (the bundle's `hashlock`) | `SHA-256(s)` | `A = Addr(s)`, the 32 bytes of the NOID claim authority |
| What opens the Ethereum lock | a preimage with `sha256(x) == H` | a preimage with `Addr(x) == A` (computed by `secret::check_preimage_for`, never SHA-256) |
| Equivalence proof (RISC Zero, 20 to 36 min) | required: Bob verifies a receipt | **none**: the attestation is absent, not typed |
| Variant | raw or stock | **raw only** (`--variant stock` is refused with a message) |
| Ethereum reveal | about 89 k gas | about 0.50 to 0.55 M gas on Hardhat, 517,084 on mainnet (run 8), 689,324 on Sepolia (runs 5 and 11); `live.js` sends it with a fixed 1,000,000 limit |
| Bob claims the NOID with | client R, or client S for the stock variant | client R only (the stock wallet import cannot open a lock on `Addr(s)`) |

- **Flags.** `new-alice --eth-lock-kind poseidon` writes it (`--eth-code-hash`, if given, must equal the V2 constant; the HTLC one is refused).
  `new-bob --eth-lock-kind poseidon` is Bob's own term: a bundle of the other kind is refused before anything else is looked at. For the poseidon
  kind `--receipt`, `--equiv-prove`, `--equiv-h`, `--equiv-a`, `--equiv-image-id` and `--pinned-image-id` are refused (`new-bob` needs no proof step).
  `status` shows `eth_lock_kind`, `eth_lock_word` and the `client_r_selftest` record for a poseidon file. `tick`, `claim`, `intent` and
  `secret` read the kind from the swap file; they have no flag.
- **In the file.** `params.eth.lock_kind` (`"sha256"` is the default and is **not written**, so every older file, bundle and digest is
  unchanged; `"poseidon"` is written and is part of the digested public section). `SwapPublic::check` (run on creation, `new-bob` and every load)
  requires, for the poseidon kind: the raw variant; the lock word equal to the `claim_authority` bytes **and** to the `claim_authority` of the opening it
  rebuilds byte for byte; the V2 code hash (and for the sha256 kind the HTLC one: a poseidon file pinning `HTLC_CODE_HASH` and the reverse are
  refused); a lock word that is not the address of the public test vector or of the zero secret. `SwapFile::new_bob_with(public, terms, None, now)` is
  Bob's poseidon file: a present attestation is refused at creation and on load. `SwapPublic::check_bob_terms` repeats the "lock word == claim
  authority of the opening I rebuilt" test on its own, and compares Bob's terms (`BobTerms.lock_kind`, `eth_code_hash`) with the bundle.
- **The watchers** (`EthWatcher::with_lock_kind`) read the same ABI (event and function shapes are byte-identical; the V2 field is `lockAddr`, the
  Rust reads words by position). Differences: every "does this preimage open the lock" test is `watch::eth::lock_word_of(kind, x)`; the discovery of
  the swap's own locks is the sha256 kind's: **one** `eth_getLogs` with the INDEXED sender and receiver topics (REVIEW-6 R6-1). The word is in the event
  data, not a topic, so "has Bob's address locked on this A before" needs a separate query for the `Locked` logs of **Bob's own sender** (indexed topic2,
  REVIEW-7 R7-1; the word is compared locally) from the stored from-block; it is asked
  **only while Bob can still decide to lock** (`engine::word_scan_wanted`: Bob's phases `received`, `funded`, `funding_final`, `lock_submitted`) and its
  outcome is a state of the observation (`EthObservation.word_scan`: `not_run`, `complete`, `failed(reason)`), never an error of the poll: a node
  error, a malformed log or a lock the targeted query finds that the sender query does
  not list makes it `failed`, and Bob's lock waits (there is no provider-cap size rule any more). When complete, Bob's own locks carrying the word are `EthObservation.word_locks`. A pending `claim` with calldata **longer** than 68 bytes will revert (`BadCalldataLength`) but has shown the secret: it is
  reported as `EthObservation.overlong_claim`, never as Alice's reveal, and Bob claims the NOID from it. `TimelockExpired`, `BadCalldataLength` and
  `InsufficientGas` reverts all mean "the reveal did not happen, `s` may be public"; the engine learns that from the chain, not from revert names (`live.js`
  names them).
- **Bob's pre-lock gates** (`engine::poseidon_prelock_blocker`; `wait`, not `abort`, so a held-back Bob still aborts when the last lock height passes):
  1. *client R works on this machine* (review V2-10): the file holds a passed `client_r_selftest` for the owner-authorization version of the next block
     (`params::auth_version_at(tip + 1)`), **bound** (REVIEW-6 R6-4) to this file's lock word, this swap's contract version, this build
     (`swap_cli::build_id()`) and younger than 24 hours. `new-bob` runs it before it writes the file; `swap-cli self-test FILE [--noid-rpc URL | --call-height N]`
     re-runs it and records it (`SwapFile::record_client_r_selftest`). It builds a throwaway lock of THIS swap's contract version on a fresh random secret,
     proves the claim with client R, verifies the proof, re-decodes the encoded intent as a node does and sends it through `submit_claim` to a mock node
     (`client::raw::client_r_selftest`); nothing is sent to a real node and no real secret is read.
  2. *the query for Bob's own sender's `Locked` logs is complete on every node asked* (REVIEW-6 R6-1, REVIEW-7 R7-1), and *no earlier lock of Bob's OWN sender on this A* (T9,
     review V2-8, REVIEW-6 R6-2): a `Locked` log with this word made by `bob_sender` other than his expected lock blocks him; locks of other senders are
     reported in the notes and do not (a stranger's 1-wei lock would otherwise veto the swap, and it costs Bob nothing: his lock pays only the fixed
     receiver for an `x` with `Addr(x) = A`). Also applied to the re-send of a dropped lock.
  The remaining gates (funding final, timing, second Parano1d node, fee T5, one instance, code hash, chain id) are the sha256 kind's, unchanged.
- **Tests.** `tests/poseidon_kind.rs` (swap file, watcher, engine gates, a whole swap on the simulator), `tests/poseidon_cli.rs` (the binary), `src/params.rs` (the
  V2 constant against the compiled artifact), `src/secret.rs`. Every raw-variant scenario of the other suites runs against the poseidon kind with
  `SWAP_TEST_LOCK_KIND=poseidon cargo test --offline --test scenarios --test chaos_fixes --test intents --test review4 --test review5 --test contract_version --test resume`
  (two tests branch on the kind: an earlier lock on the word keeps Bob from locking at all, by design). The chaos test draws the kind from its own generator
  (about two in five raw-variant scenarios are poseidon) so the sha256 scenarios of every seed are the ones their `CHAOS.md` entries describe.

## The rehearsal and sepolia profiles

`production` is today's §9.1 (the default and the only value a file written before profiles can mean). `rehearsal` and `sepolia` run the same
engine on the same (I1)/(I2)/(I3) formulas with smaller budgets, so an abort path takes a few hours of blocks instead of six:

```
RHS(I1)  = ceil((W_A + Δ_detect + 2·P_auth) / τ_fast) + B_post        B_post = B_epoch + B_fee + B_final + B_safety
D_offset = B_fund + B_final + B_bob + RHS(I1) + margin
```

`rehearsal` is pinned to the local Hardhat chain (31337), where Ethereum finality is instant. Sepolia finalizes like mainnet (about 13 min, budget
1,140 s as in production), and the checker demands `M_A` > finality and `W_A_min − M_A ≥ finality + Δ_detect`, so Alice needs a longer reveal window:
`sepolia` is the rehearsal budgets with the real finality. Its `M_A` stays at the production 1,800 s on purpose: `eth/scripts/live.js claim` uses
1,800 s as its default `--margin-s`, so no extra flag is needed on Sepolia.

| item | production | rehearsal | sepolia | note |
|---|---|---|---|---|
| `W_A` / `W_A_min` / `M_A` | 7,200 / 5,400 / 1,800 s | 600 / 480 / 300 s | 4,200 / 3,360 / 1,800 s | `W_A` from ideas idea 3 (rehearsal); `W_A_min` = 0.8 `W_A`; `M_A` must exceed the Ethereum finality; sepolia: `W_A_min − M_A` = 1,560 s ≥ 1,260 s |
| `Δ_detect`, `2·P_auth` | 300 s, 40 s | 60 s, 40 s | 120 s, 40 s | one fast poll on a local chain; two Sepolia blocks plus one poll of a public RPC; same prover |
| `B_epoch` budget / `B_fee` / `B_final` / `B_safety` | 144 / 60 / 18 / **30** | 0 / 10 / 18 / 5 | 0 / 10 / 18 / 5 | `B_final` is Parano1d's finality and is not shortened; `B_epoch` 0 accepts the rotation risk in a rehearsal only; production `B_safety` was 20, which the model check (`docs/formal/README.md` §7) showed to be exactly one adversarial reorg of Bob's close with nothing on top, so it is 30 |
| `DE` / `RA` (Ethereum inclusion delay, Alice's rebroadcast time) | 120 s / 120 s | 60 s / 60 s | 120 s / 120 s | `Gates::validate` demands `M_A ≥ finality + 2·DE + RA` and `W_A_min ≥ DE + finality + RA + M_A` (one Ethereum reorg of Alice's claim can still be answered); 12-s blocks: ten blocks; the local chain mines on demand |
| `B_post` | 252 | 33 | 33 | `0 + 10 + 18 + 5` |
| `RHS(I1)` full window | 629 = 377 + 252 | **68** = ⌈(600+60+40)/20⌉ + 33 = 35 + 33 | **251** = ⌈(4,200+120+40)/20⌉ + 33 = 218 + 33 | minimum window: 539, 62 and **209** |
| `B_fund` / `B_bob` / `margin` | 10 / 60 / 18 | 5 / 20 / 9 | 5 / 20 / 6 | `margin` is a deliberate rounding-up |
| `D_offset` | **735** = 10+18+60+629+18 | **120** = 5+18+20+68+9 | **300** = 5+18+20+251+6 | 6 h 08 m vs exactly 1 h vs exactly 2 h 30 at 30 s/block |
| Bob's lock-by (full / minimum window) | `D − 629` / `D − 539` | `D − 68` / `D − 62` | `D − 251` / `D − 209` | |
| Alice's reveal cutoff | `T_reveal − 1,800 s` | `T_reveal − 300 s` | `T_reveal − 1,800 s` | |
| Full "Alice never reveals" cycle (creation to her final refund) | 752 blocks | 137 blocks | 317 blocks (≈ 2 h 40) | `D_offset + 17` |
| Ethereum finality assumed | 1,140 s | 0 s | 1,140 s | local Hardhat finalizes at once; Sepolia does not |
| caps | none | ≤ 20 NOID, ≤ 0.01 ETH, Ethereum chain **31337 only** | ≤ 20 NOID, ≤ 0.01 ETH, Ethereum chain **11155111 only** | refused at build, at `new-bob` and at every load |

A happy path under `sepolia` still settles in about 45 minutes (Alice's funding final ≈ 9 min, Bob's Sepolia lock finalized ≈ 13–19 min, the reveal,
Bob's claim final ≈ 9 min); the long `D_offset` only matters when somebody does not show up.

- `new-alice --profile rehearsal` or `--profile sepolia` writes it (`production` is the default). The profile is in `params.profile` of both swap
  files and of the bundle; `production` is **not written** (a file without the field is a production file, and its digest, which a sealed secret is
  bound to, is unchanged). A bundle with the field stripped or changed is read as another profile and fails `check()` (D is not `h_create +
  D_offset`, the lock-by, `W_A` or the chain id disagree). `new-bob` takes `--profile` (default production) and refuses a bundle of another
  profile; `gates --profile rehearsal|sepolia` prints the profile's numbers; `status` shows the profile.
- `params::Gates` holds the numbers (`PRODUCTION`, `REHEARSAL`, `SEPOLIA`); `engine.rs` and `swapfile.rs` read them through
  `file.public.params.profile.gates()`. The `pub const` values in `params.rs` (`W_A_S`, `M_A_S`, …) are the PRODUCTION numbers kept for the
  tests; the engine does not read them. The fee rule (`F_max`) and the chain facts (finality 18, epoch 144, minimum fee 5,800) are the same in
  every profile and stay global.
- `Gates::validate()` is the one checker of the §4.2/§4.3 relations (non-zero times and `W_A_min ≤ W_A`; `B_final` = Parano1d's 18; `M_A` >
  Ethereum finality; `W_A_min − M_A ≥ finality + Δ_detect`; `M_A ≥ finality + 2·DE + RA` and `W_A_min ≥ DE + finality + RA + M_A` (the per-profile Ethereum inclusion delay `DE` and Alice's rebroadcast time `RA`: one Ethereum reorg of her claim can still be answered); `D_offset` = the formula above; the T6 guard fits in `B_safety`; every non-production
  profile (`rehearsal`, `sepolia`) has all three caps and production none). All three profiles pass it; `params::tests::a_broken_profile_is_rejected`
  lists twenty-five hand-made broken ones (the last three are the `DE`/`RA` relations, each failing alone; five of them sepolia: `M_A` not above the finality, `D_offset` one short, no caps, no chain pin, the
  rehearsal window).
- Tests: `tests/scenarios.rs` runs, under `rehearsal` and under `sepolia` (`Scenario::with_profile`), the happy path (raw and stock), "Alice never
  reveals, both refund" (the whole abort cycle is `D_offset + 17` blocks from the creation height: 137 and 317), "Bob never locks" and the reveal
  cutoff. For `sepolia` the simulator, which has no time-based finality, is put on a finality lag of 95 Ethereum blocks (95 × 12 s = 1,140 s,
  `SEPOLIA_FINALITY_LAG_BLOCKS` in `tests/common/mod.rs`), and one scenario checks that Alice waits one block short of finality and reveals at the
  finalizing block, before her cutoff. `tests/rehearsal_cli.rs` covers the binary, the caps and the mismatch refusals for both profiles;
  `params::tests` pin the derived numbers (251, 209, 300, `B_post` 33, rotation guard 4).
- Not covered by a rehearsal. Epoch rotation: both profiles budget `B_epoch` = 0. With `D_offset` 300 > 144, at least one rotation of the epoch
  anchor falls inside a `sepolia` window (with `rehearsal`'s 120 one can), and a claim evicted at a rotation must be re-proved; the budget accepts
  that risk, and the one-epoch wait that production budgets (144 blocks) is not exercised. The mainnet relay-floor behaviour (Q6) and the
  Ethereum mainnet itself (chain 1) are not covered by either profile; the Sepolia run itself is pending (`docs/runbook-two-party.md` §6).

## Known gaps (follow-ups, not bugs in what is tested)

- **Fail-closed rule (REVIEW-1 M2, applied).** Every `Option` in an observation means "the
  poll could not tell", and an unknown field is never a pass. `decide` ends with one choke
  point (`spend_blocker`): an action that spends or commits is returned only if each
  observation field its gate reads is `Some` and the observations it reads are at most
  `MAX_OBSERVATION_AGE_S` = 120 s old against the caller's `now` (`observed_at`, stamped by
  the watchers from the system clock when a poll starts; a missing or future-dated stamp
  counts as stale). Otherwise the action becomes `Wait { reason: "<field> unknown" }` (or
  "<noid|eth> observation stale ...") plus a note: never an action, never an abort. Needed
  per action (`noid.*`, `eth.*`): `fund_noid` fresh noid, `epoch_anchor`; `claim_noid` and
  `refund_noid` fresh noid, `fee_estimate_1_1`, `fee_floor`, `epoch_anchor`; `lock_eth` fresh
  noid and eth, `instance_matches_opening`, `active_authority`, `fee_estimate_1_1`,
  `chain_id`, `latest_timestamp`; `reveal_eth` fresh eth, `chain_id`, `latest_timestamp`,
  `contract_code_hash` (when the file pins one), the lock and its `receiver_is_eoa` /
  `sender_is_eoa`; `refund_eth` fresh eth, `chain_id`, `latest_timestamp`. A known chain id
  (and, for the reveal, code hash) that differs from the pinned one holds as well. Waiting,
  tracking and abort decisions are unchanged. With `--now T` (replaying fixtures) both
  observations are taken to have been observed at `T`. Not covered: `pending_calls` is a
  plain list, so a watcher cannot report "unknown mempool" (it fails the poll instead), and
  the tip itself was not checked against a block-header timestamp or a second node (REVIEW-2 F5, fixed: see "F5: second node,
  header time, plain HTTP"; the poll-age rule alone still lets a lagging node that answers quickly look fresh).

- From REVIEW-1 (not applied): no automatic clean-up of the leftover leg after a reveal
  (M1: Bob's ETH refund after a failed claim, Alice's NOID refund after Bob never claims); client R takes its chain snapshot in separate RPCs
  instead of one locked read and does not preflight with `previewObjectCall` (M7); client S
  reuses the `--out` path across retries (M8); a mined-but-reverted claim is not scanned for
  the preimage (L5); `B_bob` counts from Bob's observation tip (L7).

- If Bob's claim is included by a submission the file never recorded (a crash between
  submit and record), the engine sees a pending close it does not own, holds without
  re-proving (first-seen would refuse the second spend anyway), and after inclusion stops
  with "verify the contract receipts manually" instead of finding the txid; `resume.rs`
  pins this behaviour.
- A lost Ethereum transaction (Alice's reveal or Bob's refund dropped by the mempool) is
  not re-broadcast; the executor is expected to make those idempotent.
- The Parano1d watcher costs one `getMempoolEntry` per single-page mempool entry (LIVE RUN 1: up to 19 per tick on a busy mempool).
- Poll skew found by LIVE RUN 1 (fixed the same day): the instance appeared in `getObjectInstances` (height 280,638) while
  `blockCount` still said 280,637, so the engine would have stored `seen_at_tip` = 280,637 and declared the funding final at
  280,654, one block early. The watcher now raises `tip` to the highest height any answer of the poll reflects
  (`getObjectInstances.height`, `getObjectStatus.tip_height`); `recorded_funded_first_seen` pins it (tip 280,638).
- Bob's refund of ETH uses the latest block timestamp; it does not wait for finality of
  Alice's non-claim (the HTLC's `refund` reverts if she claimed first, so nothing is lost).
- `PROJECT.md`'s repository map does not list this crate yet.
- **Several instances at the contract root after an abort (runs 9 and 10, low; messages fixed, recovery still outside the tool).** When MORE THAN ONE instance of the agreed amount sits at her root, Alice in `created` now says so first, whatever the tip is: the `wait` reason names how many instances sit there (and how many have the agreed amount), that the swap cannot go on with them (Bob does not lock on more than one fitting instance, Alice does not reveal), that nothing must be funded again, and that they can be recovered after `D`. `scripts/live/recover-noid.sh` closes the instances of the agreed amount only, and an instance not larger than the close fee (at least 5,800 micro-NOID, more under load) cannot be recovered at all. A single instance that does not fit (a foreign deposit, dust, another amount) gets a different, precise reason: it sits at the root, it is not the agreed one, it is not counted as a funding, and the tool does not fund beside it until the contract state is checked; nothing is claimed about the swap or about a recovery. The `abort` decided there ("too late to fund") and every later tick of the `aborted` file carry a note while instances remain: they hold NOID at the root (slot, creation, amount), those of the agreed amount are not lost, they can be recovered after `D` (the note says "now" once the next call height has reached `D`) with `scripts/live/recover-noid.sh`, and the tool will not close them; the note goes away when no instance is left. The one exception is CHAOS F-19 (a funding decided by the tool is on record and several instances fit): the file stays `created`, and the note says that at `D` this file adopts the oldest fitting instance and offers `refund_noid` for it itself, that the OTHER instances need the helper, and that running the helper for all of them before the tool's own refund means recording the tool's instance with `tick --closed-by TXID`. Alice's `aborted` only ever comes from `created`, so this is the one path. The `fund_noid` guard (no funding beside an instance that was not accepted) is now one function used by both `tick_apply` and `Runner::tick`; before, the library path would have funded beside it. Not done: the tool still does not close the other instances itself (no `refund_noid` is offered for an instance the file never recorded); `recover-noid.sh` does it outside the tool (`docs/live-run-9-10.md`, finding 2). Tests: `run9_*` in `tests/scenarios.rs`.
