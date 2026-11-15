# Live-run helpers (`scripts/live/`)

The shell helpers the owner's machine used for live runs 1–3 (`~/live3-tick.sh`, `~/reveal3.sh`, `~/claim3.sh`, …)
lived only in WSL home. This folder is the versioned version, adapted to the REVIEW-3 fixes of 2026-11-05. Under WSL they
drive `swap-cli` for the NOID side and Windows `node` + `eth/scripts/live.js` for the
Ethereum side through WSL interop, exactly as run 3 did (`docs/live-run-3.md`). On macOS and Linux they run natively
(section "On macOS or Linux (native mode)" below).

**They never move funds by themselves.** Every spend is a separate command with an explicit `--submit` or a missing
`--dry-run`, and each one needs the owner's go-ahead (`PROJECT.md`, hard rules). What runs unattended is `watch.sh`,
which only observes and records (`tick --apply` writes events and intents into the swap files; it sends nothing).

| script | role | what it does | sends anything? |
|---|---|---|---|
| `env.sh` | — | run number, platform (`LIVE_PLATFORM`), paths, nodes, amounts, fee settings; the four party addresses and the HTLC contract address have no default and come from `$L/env.local.sh` (also second nodes, another RPC) | no |
| `selftest.sh` | — | no-network self-test of the shell layer (`env.sh`: fee flags, node flags, `read_lines`, platform choice, frozen copy) in a temporary folder; prints `ok` / `FAIL` per case, exits non-zero on a failure | no |
| `install.sh [RUN]` | — | freezes a copy of this folder under `$L/bin` (run 3 lesson: never edit a helper while a loop calls it) | no |
| `setup.sh` | — | `$L` with a fresh passphrase (kept if present), `bob/`, `rec/`, the HTLC deployment block for `--eth-from-block` | no |
| `prepare.sh` | both | `new-alice`, the equivalence proof (secret over a pipe), `new-bob --receipt`, the contract definition; copies the bundle and definition to `$PUB` for the owner. With `LOCK_KIND=poseidon` (`env.sh`; raw variant only; `CONTRACT` must be a `HTLCPoseidonV2` deployment) it skips the proof and the receipt, passes `--eth-lock-kind poseidon` to both tools, and `new-bob` runs the client R self-test | no |
| `check-object.sh [OBJ]` | Alice | `alice-params --check-object`: the object `parano1d-cli contract create` wrote must be byte-for-byte the swap file's opening | no |
| `fund.sh [--dry-run]` | Alice | the funding, **exactly once**: copies the object file to a private copy of its own per process (`$L/fund-object.XXXXXX/fund-object.json`, mode 600, removed when the script ends) and works on that copy only (check, hash, instance listing, funding), runs `check-object.sh`, reads the amount from the swap file's top-level `amount_micronoid` line and requires it to equal `AMOUNT` (plain decimal, no leading zero), refuses a contract that already has an instance, then writes **three markers** before it calls the wallet CLI's `contract fund`: `$HOME/.noid-swap/funded/<contract root>` (this user), `funded-<contract root>.marker` next to the original object file, and `$L/funded.marker` (this run folder). The run folder's marker records the time, `stage: calling wallet CLI`, the wallet CLI's output (the txid) and `wallet exit <code>`; a marker without an exit line means the call may or may not have gone out: check the txid and `contract instances`, then delete all three by hand. `--dry-run` makes no marker and leaves nothing behind (run 9: a double click funded the contract twice and the swap had to stop; run 11: first live use under WSL, one instance) | **REAL NOID** without `--dry-run` |
| `tick.sh ROLE [--apply]` | either | one tick; read-only without `--apply` (then a spend's parameters are withheld, REVIEW-3 F3); records every node answer | no |
| `watch.sh [alice\|bob\|both] [s]` | either | `tick --apply` loop, one summary line per tick in `$L/loop-ROLE.txt`; stops when every watched file is terminal | no |
| `lock.sh [--dry-run]` | Bob | `live.js lock --swap bob.swap.json`: the lock Bob's file recorded as `lock_eth`; passes the mainnet / gas-price fee flags (`MAX_FEE_GWEI`, `GAS_PRICE_GWEI`); no `--replace` (live.js has none for a lock); the result records the lock block's time, read again for a few seconds if the node does not serve the block yet, else `blockTimestamp: null` with a `blockTimestampNote` | **yes** without `--dry-run` |
| `reveal.sh [--dry-run] [--replace [TXHASH]]` | Alice | `swap-cli secret \| live.js claim --swap alice.swap.json --secret-stdin`: the reveal; `--replace` re-sends a stuck claim (see below) | **yes** without `--dry-run` |
| `claim.sh [--submit]` | Bob | `swap-cli claim`: proves and prints the close (the whole output, bar the long `opening_hex` / `intent_hex` lines); `--submit` sends it to the node, and to `NOID_RPC2` too when that is set (`--submit-rpc`: the same intent to both; the claim is submitted when one node accepts it, and the other node may list it under `nodes.rejected` because it already had it from the first) | **yes** with `--submit` |
| `refund-eth.sh [--dry-run] [--replace [TXHASH]]` | Bob | `live.js refund --swap bob.swap.json` after `T_reveal` (abort path); the same fee flags and `--replace` as `reveal.sh` | **yes** without `--dry-run` |
| `recover-noid.sh [--dry-run]` | Alice | the NOID recovery after `D` (abort path), for every instance at the contract root: preview, check, send chained with `--expected-txid`, a marker per instance; txids in `$L/recovered-txids.txt`, then `tick.sh alice --closed-by TXID --apply`. Not yet run live in this form | **REAL NOID** without `--dry-run` |

Alice's NOID recovery at `D` (the abort path) is `recover-noid.sh`: for every instance of the contract it previews the recovery close,
checks the preview (a recovery, terminal, paying Alice's own address the amount minus the close fee) and sends it with `--expected-txid`
chained to that preview (run 2 lesson), then `tick.sh alice --closed-by TXID --apply` for each txid in `$L/recovered-txids.txt`. It was a
scratch script until runs 9 and 10 (four recovery closes). The wallet's active address must be Alice's. **The helper form has not been run
live; the scratch version, with the same checks, was.** A swap with one instance can also be recovered by hand with
`parano1d-cli contract call --close --preview` and `--expected-txid` in one command, as in runs 2, 4 and 6.

## A run, step by step (owner in both roles, `sepolia` profile)

```
bash scripts/live/install.sh 4            # RUN=4 → ~/live-run-4/bin
bash ~/live-run-4/bin/setup.sh            # passphrase, folders, eth-deploy-block.txt (12066295 = the Sepolia HTLC's deployment)
bash ~/live-run-4/bin/prepare.sh          # Alice's file + proof (20–36 min) + Bob's file + swap.def.json → copied to C:\Users\00\Documents\live-run-4
# Windows:  parano1d-cli contract create swap.def.json --out swap.object.json   (local, no fee)
bash ~/live-run-4/bin/check-object.sh     # "object file OK: … fund exactly this address"
# GO / NO-GO, then the owner's go-ahead:  bash $L/bin/fund.sh     (not `parano1d-cli contract fund` by hand: twice makes two instances)
bash ~/live-run-4/bin/watch.sh both 30 &  # both files, every 30 s, until both are terminal (tail -f ~/live-run-4/loop-*.txt)
# when Bob's loop says lock_eth:   lock.sh --dry-run, go-ahead, lock.sh
# when Alice's loop says reveal_eth: reveal.sh --dry-run, go-ahead, reveal.sh
# when Bob's loop says claim_noid:   claim.sh (dry run), go-ahead, claim.sh --submit
# abort path, Alice, after D:        recover-noid.sh --dry-run, go-ahead, recover-noid.sh; then tick.sh alice --closed-by TXID --apply
```

Send the owner, at every run: the Parano1d contract root (`o1…`, printed by `prepare.sh` and in `$PUB/alice.bundle.json`),
the Sepolia contract link, the bundle and the object file. Hand the bundle over as a file, never as pasted text, and compare the `bundle check:` line that `prepare.sh` prints with the one `new-bob` prints on the other machine (the bundle carries a `bundle_check`, which `new-bob` verifies before anything else).

## On macOS or Linux (native mode)

**How the mode is chosen.** `env.sh` sets `LIVE_PLATFORM` to `wsl` when `wslpath` exists and `/mnt/c` is a folder, else to `native`. Force it
with `LIVE_PLATFORM=wsl|native` in the environment or as a plain `LIVE_PLATFORM=...` line in `$L/env.local.sh` (that one line is read as text, early; the file is run once, last, as before; if the run then changes the platform, `env.sh` exits 2 instead of mixing two sets of defaults). Under `wsl` every default is the run-3 one. The helpers run under the macOS `/bin/bash` 3.2 (no `mapfile`; `env.sh` has `read_lines`).

**Run `bash scripts/live/selftest.sh` first**; on a Mac this is the check under the system bash 3.2 (it prints the bash version it ran under). It needs no network, no node and no keys, and removes its temporary folder.

**What differs in native mode.**

| setting | wsl | native |
|---|---|---|
| `CURL` | `/mnt/c/Windows/System32/curl.exe` | `curl`; `node_flags` also passes `--curl-path "$CURL"` to `swap-cli` (its own default is the WSL curl.exe if that file exists, else `curl`) |
| `NODE` | Windows `node.exe` | `node` |
| `ETH_DIR` | `/mnt/c/Users/00/Documents/noid-swap/eth` | the repository's `eth/`, found from `env.sh`'s own place (`REPO_DIR`); a frozen copy under `$L/bin` reads `$L/repo-dir.txt`, which `install.sh` writes |
| `PUB` | a Windows folder | `$L/pub`, plain local copies (made when a script first copies into it) |
| `win_path` | `wslpath -w` | the path unchanged (give an absolute `L`; it is made absolute if relative) |
| `BIN`, `EQ` | `$HOME/noid-target/release/...` | the same if present, else `swap-cli/target/release/swap-cli` and `equiv/zkvm/target/release/equiv-prove` under the repository |

The object file of the Parano1d wallet CLI (`prepare.sh` end, `check-object.sh`) is made by hand: `prepare.sh` prints the instruction, and
`check-object.sh` takes the file's path (or finds it in `$PUB`). No helper calls a Windows-only program in native mode.

**Bob's side needs only** `tick.sh bob`, `watch.sh bob`, `lock.sh`, `claim.sh` and `refund-eth.sh`, plus a `bob.swap.json` made with
`swap-cli new-bob` from Alice's bundle (put it at `$L/bob/bob.swap.json`; `prepare.sh` is Alice's script and makes both files). For
`--transport curl` over https the Ethereum endpoint needs curl, which macOS has.

**Verified so far** (2026-11-05, no network, nothing sent): `bash -n` on every script; `selftest.sh` (59 cases) from Git Bash with bash 5.3; the settings above printed from Git Bash with
`LIVE_PLATFORM=native` (flags, paths, empty-array expansions under `set -u`); the same settings under WSL printed identically to the
previous `env.sh`. On a Mac (2026-11-06): `/bin/bash scripts/live/selftest.sh` printed `60 ok, 0 failed (bash 3.2.57(1)-release)`.
**Run live on a Mac (2026-11-06, runs 9, 10 and 11, `docs/live-run-9-10.md`, `docs/live-run-11.md`):** `install.sh`, `setup.sh`, `watch.sh` / `tick.sh` (about 400 ticks),
`lock.sh`, `refund-eth.sh` and, in run 11, `claim.sh` (dry run and `--submit`, both exit 0), each dry run and send, under the system bash 3.2, with no helper error. The abort path after Bob's lock
was settled that way (run 10), and so was a complete swap with Bob's claim from the Mac (run 11); the BSD tool calls inside those scripts worked.
**Still not run on a Mac:** `reveal.sh`, `prepare.sh`, `fund.sh` and `recover-noid.sh` (these are Alice's scripts;
her side ran on the other machine, under WSL). `fund.sh` has run live under WSL (run 11: exactly one instance).

## Two nodes (REVIEW-3 F5)

Under `sepolia` and `production`, Bob's lock and Alice's reveal wait for a second, distinct node per chain unless
`--single-node-ok`. **The helpers pass `--single-node-ok` only when you opt in** (REVIEW-5, the rest of R4-8): put
`SINGLE_NODE_OK=1` in `$L/env.local.sh` for a run in which one person controls both roles or trusts the counterparty. It is then
passed while `NOID_RPC2` or `ETH_RPC2` is empty, with a warning on EVERY call of `tick.sh` / `claim.sh` (so on every poll of
`watch.sh`). Without it, and without the second nodes, the helpers pass nothing and print a note on every call that the engine
**will wait** before Bob's lock and before Alice's reveal until the second nodes are set. **A run with a stranger needs BOTH second
nodes** and no `SINGLE_NODE_OK`: set `NOID_RPC2` and `ETH_RPC2` in `$L/env.local.sh` (another Parano1d node on another host or
port; another Sepolia RPC provider). If either is empty the flag waives the second-node rule for BOTH chains. The same endpoint
twice is refused by `swap-cli`. (The frozen copy under `$L/bin` of a run that is already going is not changed by this.)

With two Ethereum nodes Bob's tool also reads the secret from either of them, and while Bob waits for it every tick compares the
Ethereum head time with the clock (limit 600 s): a lagging node shows up as an `ALARM` in the action reason. Switch `ETH_RPC` to a
healthy node when you see it.

## The reveal: fee cap, a stuck claim, a late re-send (REVIEW-4 R4-1, R4-3, R4-5; REVIEW-5 R5-1, R5-2)

- **Fee cap.** `live.js claim` reads the latest base fee before it signs (also in `--dry-run`) and refuses a cap below 2 x that
  base fee; the dry run prints `feeCheck` (base fee, cap, ratio). On mainnet put `MAX_FEE_GWEI=N` in `$L/env.local.sh`:
  `reveal.sh` then adds `--mainnet --max-fee-gwei N` (without it a chain-1 file is refused; on a test chain `GAS_PRICE_GWEI` does
  the same for `--gas-price-gwei`). Look at the base fee in the minute before the reveal and use at least 3 x. For mainnet also set
  `BOB_KEY` / `ALICE_KEY` in `env.local.sh` to the mainnet key files.
- **Tip.** `PRIORITY_FEE_GWEI` (optional; `lock.sh`, `reveal.sh`, `refund-eth.sh` add `--priority-fee-gwei` after the cap) sets the priority fee, so a send
  pays about the base fee plus the tip instead of the whole cap. On mainnet set the cap at 3–4 × the base fee and the tip small, e.g. `0.01`. It needs
  `MAX_FEE_GWEI` or `GAS_PRICE_GWEI`; alone, `lock.sh`, `reveal.sh` and `refund-eth.sh` stop with exit 2 before `live.js` runs (`check_fee_settings`). `live.js` refuses a tip below a tenth of the latest base fee, and a lock cannot be replaced: give the lock a generous tip, for example half the base fee. It needs a `live.js` that knows the flag.
- **Stuck claim.** A claim that sits in the mempool has already published the secret, and only Bob can use it. `live.js` prints
  `sent: 0x… nonce N …` on stderr (in `$L/eth-claim.err`) the moment it sends, before it waits for the receipt. If the claim does
  not get mined, run `reveal.sh --replace 0xHASH` with a higher `MAX_FEE_GWEI`: the same call is re-sent at the SAME nonce, both
  fee fields at least 12.5 % up and the cap at least 2 x the base fee. **Give the hash.** Without it (`--replace` alone) the node's
  pending block and pool are searched, but a transaction priced under the base fee is often not shown; then the command refuses and
  asks for `--replace-tx` (REVIEW-5 R5-2: it never replaces "whatever sits at the oldest nonce"). It also refuses when nothing is
  pending, when the pending transaction is not this claim, or when the lock is claimed already; it never uses a second nonce.
  `reveal.sh --dry-run --replace 0xHASH` shows the plan first. `refund-eth.sh --replace 0xHASH` does the same for a stuck refund.
- **A stuck FIRST reveal can be replaced past the `M_A` cutoff** (REVIEW-5 R5-1). The claim in the mempool has already published
  the secret, so `reveal.sh --replace 0xHASH` (the pending claim of this lock found and identified) uses the late cutoff
  `T_reveal - DE` that `swap-cli` froze in the intent (`late_cutoff`), not `T_reveal - 1800 s`. A first claim, with nothing pending,
  keeps the strict `M_A` rule. Use a cap of at least 3 x the base fee in any case, and replace within a few blocks if the claim is
  not mined. `swap-cli tick --apply` writes `reveal_pending_seen` into Alice's file as soon as it sees the receiver key's claim in the
  mempool while the `reveal_eth` intent is held; from then on the file itself treats the secret as possibly public.
- **Late re-send.** No margin flag is needed or passed. When the swap file's history shows the secret may already be public (a
  mined, reorged or dropped claim, or `reveal_pending_seen`), `live.js claim --swap` takes the late cutoff (`T_reveal - DE`) and not
  the stricter `T_reveal - 1800 s`, so `swap-cli`'s late re-send can actually be sent. Without that evidence the earlier cutoff rules.
- **Keys.** With `--swap`, `claim` needs the key of the file's `alice_receiver` (`ALICE_KEY`, default `keys/alice.key`), `refund` and
  `lock` that of `bob_sender` (`BOB_KEY`, default `keys/bob.key`; both paths are relative to `eth/`); another key is refused. For mainnet
  set `BOB_KEY` / `ALICE_KEY` in `env.local.sh` to the mainnet key files.

## What changed since run 3's helpers

- (REVIEW-7) `reveal_tx_flags` (in `env.sh`) checks `$L/reveal-reverted-tx.txt` exactly (`0x` + 64 hex digits). A malformed file is ignored
  with a warning on stderr, so it cannot stop a `tick.sh` or a `claim.sh` (swap-cli refuses a malformed `--reveal-tx` before it polls). A run
  directory installed earlier has a frozen `env.sh`: run `install.sh` again to get this. `swap-cli self-test` now clears the earlier record
  and saves before it proves; a failed self-test leaves no valid record. `--reveal-tx` also needs the receipt's block on the node's canonical
  chain and, with two Ethereum nodes, both nodes to report the same reverted claim. `live.js lock` asks the node for Bob's own locks only
  (indexed sender), no longer for every lock of the contract.

- (REVIEW-6) A claim that is mined and REVERTS (`live.js claim` exits 3, prints `reverted`/`secretPublic` and the hash): `reveal.sh` saves the
  hash in `$L/reveal-reverted-tx.txt`, and `tick.sh` / `claim.sh` pass it to `swap-cli` as `--reveal-tx HASH` from then on. swap-cli re-reads the
  transaction from the node before it believes it. Delete the file only when the swap is over. The sha256 claim is sent with a fixed 200,000 gas
  limit and never estimated. For a poseidon swap, Bob's self-test record is bound to the file, the swap's contract version and the build, and expires
  after 24 hours: re-run `swap-cli self-test FILE` before the lock decision if `tick` says the record is old or from another build.

- (REVIEW-5) `--single-node-ok` is opt-in (`SINGLE_NODE_OK=1`); `lock.sh` and `refund-eth.sh` pass the fee flags like `reveal.sh`,
  `refund-eth.sh` takes `--replace [TXHASH]`; `reveal.sh --replace` past `M_A` and without a hash behave as described above.

- `live.js lock`, `claim` and `refund` take `--swap FILE` (a `\\wsl.localhost\…` path, `wslpath -w`): no more typed
  `--hashlock`, `--t-reveal`, `--receiver`, `--amount-wei`, `--lock-id`, `--code-hash`, `--from-block`.
- No `--eth-code-hash` on `new-alice`/`new-bob`, no `--pinned-image-id` on `new-bob`: both are constants of the build.
- `--eth-from-block` is still passed from `$L/eth-deploy-block.txt` (harmless: the flag wins and is stored again); after
  the first `tick --apply` the swap file carries it and the file could be dropped.
- A read-only `tick` no longer prints a spend's parameters, so `watch.sh` always applies.
- `watch.sh` stops by itself on a terminal phase (`done`, `refunded`, `lost`, `aborted`).

Checked read-only on 2026-11-05 against the finished run-3 files (`RUN=3`): see `docs/runbook-two-party.md` §7.
