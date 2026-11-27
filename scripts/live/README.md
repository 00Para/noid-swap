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
| `install.sh [--force] [RUN]` | — | freezes a copy of this folder under `$L/bin` (run 3 lesson: never edit a helper while a loop calls it); refuses with exit 3, copying nothing, when `$L` already holds a swap file, a `last-tick-*.json` or `loop-*.txt` file, a `funded.marker` or the operator console's lock file (a run under way keeps the helpers it started with); `--force` skips that check, only for a run folder you know is not in use | no |
| `setup.sh` | — | `$L` with a fresh passphrase (kept if present), `bob/`, `rec/`, the log start for `--eth-from-block` in `eth-deploy-block.txt`: a recent finalized block read from the Ethereum node now (see "The Ethereum log start" below), or `DEPLOY_BLOCK` when given. Reads the node (a read-only `eth_getBlockByNumber`), sends nothing | no |
| `prepare.sh` | both | `new-alice`, the equivalence proof (secret over a pipe), `new-bob --receipt`, the contract definition; copies the bundle and definition to `$PUB` for the owner. With `LOCK_KIND=poseidon` (`env.sh`; raw variant only; `CONTRACT` must be a `HTLCPoseidonV2` deployment) it skips the proof and the receipt, passes `--eth-lock-kind poseidon` to both tools, and `new-bob` runs the client R self-test | no |
| `check-object.sh [OBJ]` | Alice | `alice-params --check-object`: the object `parano1d-cli contract create` wrote must be byte-for-byte the swap file's opening | no |
| `fund.sh [--dry-run]` | Alice | the funding, **exactly once**: copies the object file to a private copy of its own per process (`$L/fund-object.XXXXXX/fund-object.json`, mode 600, removed when the script ends) and works on that copy only (check, hash, instance listing, funding), runs `check-object.sh`, reads the amount from the swap file's top-level `amount_micronoid` line and requires it to equal `AMOUNT` (plain decimal, no leading zero), refuses a contract that already has an instance, then writes **three markers** before it calls the wallet CLI's `contract fund`: `$HOME/.noid-swap/funded/<contract root>` (this user), `funded-<contract root>.marker` next to the original object file, and `$L/funded.marker` (this run folder). The run folder's marker records the time, `stage: calling wallet CLI`, the wallet CLI's output (the txid) and `wallet exit <code>`; a marker without an exit line means the call may or may not have gone out: check the txid and `contract instances`, then delete all three by hand. `--dry-run` makes no marker and leaves nothing behind The wallet call is piped through `tee -i`, so an interrupt cannot cut the `Funding submitted` line out of the marker (the markers then show the stage and the txid and no exit line). (run 9: a double click funded the contract twice and the swap had to stop; run 11: first live use under WSL, one instance) | **REAL NOID** without `--dry-run` |
| `tick.sh ROLE [--apply]` | either | one tick; read-only without `--apply` (then a spend's parameters are withheld, REVIEW-3 F3); records every node answer | no |
| `watch.sh [alice\|bob\|both] [s]` | either | `tick --apply` loop, one summary line per tick in `$L/loop-ROLE.txt` (each long part is cut on its own; the ACTION and `applied: ... phase_after: ...` are always kept whole at the end); stops when every watched file is terminal | no |
| `lock.sh [--dry-run]` | Bob | `live.js lock --swap bob.swap.json`: the lock Bob's file recorded as `lock_eth` (it refuses, also with `--dry-run`, when the producer screen of `swap-cli` remembers a detection for this file under `production`: the marker `bob.swap.json.producer-differs` or the history entry `producer_differs_seen`, unless the file records `--accept-producer-concentration` AFTER it; the same for a `producer_alert_lock_pending:<decided_at>[:kind]` entry of this intent, which a `tick --apply` writes when the screen refused the pending lock for any reason; only a `WARNING:` under `sepolia` and `rehearsal`). **A send (no `--dry-run`) first runs a fresh read-only `swap-cli tick` of Bob's file** (same node flags as `tick.sh`, no `--apply`, no recordings; its output is `$L/lock-precheck-HHMMSS.json`) and sends only if that tick still holds the `lock_eth` intent and the engine itself still decides the lock (note `held: fresh decision was lock_eth`, no `ALERT:`, no wait that says do NOT send it). Otherwise it prints `lock REFUSED, nothing sent` with the reason (the tick's own words) and exits 3; a tick that fails, or whose output cannot be read, refuses too (`lock_precheck` in `env.sh`; needs `python3`). A dry run does not tick. **The lock is sent through `lock.sh` only:** it hands `live.js lock` the APPROVAL of that tick, three values taken from the tick's own output and never from the swap file: `--approved-intent` (the `decided_at` of the intent the tick held), `--approved-terms` (the SHA-256 of the lock's terms: chain, contract, lock kind, code hash, sender, receiver, amount, lock word, `T_reveal`, `decided_at`, in the fixed encoding documented at `approvalText` in `eth/scripts/live.js`) and `--approved-at` (the tick's own Unix time). `live.js lock` recomputes the hash from what it is about to send and refuses, with nothing sent, when any of the three is missing, malformed or different, when the tick is older than 120 s (the engine's own observation age limit) or more than 5 s ahead of its own clock (both run on one machine; a WSL clock that has drifted refuses too, which is the safe direction). No flag and no environment variable skips it; a dry run needs none. It is a binding, not a proof: whoever reads the swap file can compute the three values by hand, so a direct `live.js lock --swap` call is for nobody. The approval is not single-use: a second send of the same lock is meant to be made impossible while the first is unresolved by five checks of `live.js`: the duplicate-hashlock rule (mined `Locked` events), the lock lock `FILE.lock-lock` (exclusive, held from before the checks until the send has settled), the pending-nonce check (an extra: nodes drop pending transactions), the lock record `FILE.lock-sent` and the per-user lock record (one file per chain, sender and lock word under `.noid-swap/lock-sent/` in the account's home, the home the operating system gives the user that runs `live.js`, not the `HOME` (Linux, macOS) or `USERPROFILE` (Windows) of the environment; found whatever the swap file is called; a lock without `--swap` writes it too; both below), which are the checks that count (tested offline only; another machine or another user account has neither record). The tick runs under a time limit (`LOCK_PRECHECK_TIMEOUT` seconds, default 3 x `RPC_TIMEOUT` cut to 90 s, which is what the default 60 s gives; a larger value is refused with exit 2, because the approval of a tick is good for only 120 s in `live.js`): a tick that does not finish is stopped, the lock is refused (exit 3, nothing sent) and the message says so and not to call `live.js` directly. `live.js` also refuses a swap file with more than one hard link (for `lock` and `claim`): keep one name. Passes the mainnet / gas-price fee flags (`MAX_FEE_GWEI`, `GAS_PRICE_GWEI`); no `--replace` (live.js has none for a lock); the result records the lock block's time, read again for a few seconds if the node does not serve the block yet, else `blockTimestamp: null` with a `blockTimestampNote` | **yes** without `--dry-run` |
| `reveal.sh [--dry-run] [--replace [TXHASH]]` | Alice | `swap-cli secret \| live.js claim --swap alice.swap.json --secret-stdin`: the reveal; `--replace` re-sends a stuck claim (see below); **run `tick.sh alice --apply` right after every reveal that was sent** (the watch loop does it on its next pass) | **yes** without `--dry-run` |
| `claim.sh [--submit]` | Bob | `swap-cli claim`: proves and prints the close (the whole output, bar the long `opening_hex` / `intent_hex` lines); `--submit` sends it to the node, and to `NOID_RPC2` too when that is set (`--submit-rpc`: the same intent to both; the claim is submitted when one node accepts it, and the other node may list it under `nodes.rejected` because it already had it from the first) | **yes** with `--submit` |
| `refund-eth.sh [--dry-run] [--replace [TXHASH]]` | Bob | `live.js refund --swap bob.swap.json` after `T_reveal` (abort path); the same fee flags and `--replace` as `reveal.sh` | **yes** without `--dry-run` |
| `recover-noid.sh [--dry-run]` | Alice | the NOID recovery after `D` (abort path), for every instance at the contract root: preview, check, send chained with `--expected-txid`, a marker per instance; txids in `$L/recovered-txids.txt`, then `tick.sh alice --closed-by TXID --apply`. Not yet run live in this form | **REAL NOID** without `--dry-run` |

The hashlock registry that `new-alice` and `new-bob` keep (T9) is now per machine, not per run folder: `~/.noid-swap/hashlocks.txt` (override: the `NOID_SWAP_HOME` directory), one line per swap file (hashlock and role, never a secret or a path; stderr names it only by that literal form); the run folder's `hashlocks.txt` is still written and checked too, so the same bundle offered again into a new `$L` on the same machine is refused, and so is the same bundle into the same path after the swap file was deleted or moved (no retry allowance: pass `--registry FILE` or remove the line by hand, as the refusal says; `swap-cli/README.md`, "The hashlock registry"). If Bob's tool prints an `ALARM: this lock's T_reveal … beyond the engine's own bound` note (a hand-made lock whose `T_reveal` is above the engine's bound, adopted like any other lock; G9), it changes no action: claim the moment the secret is seen, make no other lock, and `refund-eth.sh` refunds that lock after its `T_reveal` as usual.

Alice's NOID recovery at `D` (the abort path) is `recover-noid.sh`: for every instance of the contract it previews the recovery close,
checks the preview (a recovery, terminal, paying Alice's own address the amount minus the close fee) and sends it with `--expected-txid`
chained to that preview (run 2 lesson), then `tick.sh alice --closed-by TXID --apply` for each txid in `$L/recovered-txids.txt`. It was a
scratch script until runs 9 and 10 (four recovery closes). The wallet's active address must be Alice's. **The helper form has not been run
live; the scratch version, with the same checks, was.** A swap with one instance can also be recovered by hand with
`parano1d-cli contract call --close --preview` and `--expected-txid` in one command, as in runs 2, 4 and 6.

## A run, step by step (owner in both roles, `sepolia` profile)

```
bash scripts/live/install.sh 4            # RUN=4 → ~/live-run-4/bin
bash ~/live-run-4/bin/setup.sh            # passphrase, folders, eth-deploy-block.txt (a recent finalized Sepolia block, read from the node now)
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
previous `env.sh`. On a Mac (2026-11-06): `/bin/bash scripts/live/selftest.sh` printed `60 ok, 0 failed (bash 3.2.57(1)-release)`. **Current (2026-11-10): `selftest.sh` is 389 cases under bash 5.2 (WSL) and 315 under bash 5.3 in Git Bash (the tick.sh, lock_precheck and lock.sh cases skip without a usable python3); not yet re-run on a Mac.**
**Run live on a Mac (2026-11-06, runs 9, 10 and 11, `docs/live-run-9-10.md`, `docs/live-run-11.md`):** `install.sh`, `setup.sh`, `watch.sh` / `tick.sh` (about 400 ticks),
`lock.sh`, `refund-eth.sh` and, in run 11, `claim.sh` (dry run and `--submit`, both exit 0), each dry run and send, under the system bash 3.2, with no helper error. The abort path after Bob's lock
was settled that way (run 10), and so was a complete swap with Bob's claim from the Mac (run 11); the BSD tool calls inside those scripts worked.
**Still not run on a Mac:** `reveal.sh`, `prepare.sh`, `fund.sh` and `recover-noid.sh` (these are Alice's scripts;
her side ran on the other machine, under WSL). `fund.sh` has run live under WSL (run 11: exactly one instance).

## The Ethereum log start (run 14, finding 1)

Every Ethereum read of the engine (`eth_getLogs` for the lock, the claim and the refund) starts at one block, `--eth-from-block`; the helpers pass
the number in `$L/eth-deploy-block.txt`. Public endpoints prune old logs (run 14: `rpc error 4444: pruned history unavailable` from the old
default, the contract's deployment block) and cap the range, so the start must be recent.

**`setup.sh` now chooses it** when the file is absent: the **finalized** block of the configured Ethereum node (`ETH_RPC`) minus `ETH_START_MARGIN`
(default 2400 blocks, about 8 hours on Sepolia); if the node does not serve `finalized`, its latest block minus 256, minus the margin. Never below 0.
Each configured node must answer `eth_chainId` with `$CHAIN`, or nothing is chosen. With a second node (`ETH_RPC2`) both are read and the **lower**
value is used. Order of precedence: an existing `eth-deploy-block.txt` is kept; else `DEPLOY_BLOCK` (environment or `$L/env.local.sh`, a whole block
number) wins and the node is not asked; else the node is read. **If a configured node cannot be read, or is on another chain, setup stops with exit 2
and writes no start** (a guess could start after Bob's lock and hide it): fix the endpoint (`ETH_RPC` / `CHAIN` in `$L/env.local.sh`, then run
`setup.sh` again; it is idempotent) or give `DEPLOY_BLOCK`.

**Why it is safe, on both machines.** A swap's lock does not exist when its run folder is set up: the lock is sent after the bundle, the object
file and the funding, all of which come after `setup.sh`. A block that was already final at setup time is therefore before that lock, on every
chain history, and the margin puts the start about eight hours earlier still. **Each machine picks its own start at its own setup**; there is
nothing to agree on, and the two numbers may differ. The engine uses the start to find this swap's own events (its lock, claim and refund) and, for
Bob in a `poseidon` swap, his own earlier locks on the same lock word (the pre-lock check); `live.js lock` repeats that check from the swap file's
start. It does not need the contract's deployment block, but the boundary of those checks is the moment the run folder was set up, not the moment the
secret was made: a lock Bob sent from another folder or by hand before this folder was set up is seen only if it is within the margin.

**Rules.**
1. Do not run `setup.sh` for a run folder after Bob's lock was sent. A start later than the lock hides it. Bob's tick then fails loudly once the lock id
   is known (`getLock shows this lock but eth_getLogs returned no Locked event`); **Alice's discovery of Bob's lock does not fail, it finds nothing**,
   she waits, does not reveal, and the swap aborts (funds are safe). A folder that already holds a swap file gets no new guess from `setup.sh` (the
   swap file carries its stored start). To rebuild a folder after the lock, give `DEPLOY_BLOCK` set to the lock's block number minus a margin (the block
   is in Bob's tick output and in the lock result).
2. A start in `eth-deploy-block.txt` that is **higher** than the one a swap file in the folder already carries is **not passed** (`from_block_flags`
   prints a note and the stored start is used): the flag would replace the stored start, and a rebuilt folder must not move a good one past the lock.
3. The start ages: a public endpoint serves logs for a limited time and caps the range at 50,000 blocks (about a week on Sepolia), so set up the run
   folder within a day or two of the swap. A start that has aged out fails loudly on the first tick; put the lock's block number minus a margin (or,
   before the lock, a block a few thousand below the head) in the file, or pass `--eth-from-block N` once on `tick --apply` (this replaces the stored
   start; take care that it is not after the lock).

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

**A second node behind an SSH tunnel.** When `NOID_RPC2` (or `ETH_RPC2`) points at a local port that a tunnel forwards to a node on
another machine, `swap-cli` sees two endpoints on one host and prints the same-host caveat (G3) on every tick. Put
`NOID_RPC2_REMOTE=1` (and/or `ETH_RPC2_REMOTE=1`) in `$L/env.local.sh`: `node_flags` then passes `--noid-rpc2-is-remote` (and/or
`--eth-rpc2-is-remote`), but only when the matching second node is set. The flag changes the text of that note (the second node is
declared to be on another machine, which the tool cannot verify; two machines may still share one network and one upstream connection)
and nothing else: distinct endpoints are still required, the two-node rule is unchanged, and `SINGLE_NODE_OK` is not implied.
When the second node agrees, the tick's notes say so (`second Parano1d node agrees: …` / `second Ethereum node agrees: … finalized F (first node finalized F1), lock … final at the lower of the two`). The lock-by margin note (`lock-by margin: N blocks …`, for Alice before funding `funding window: N blocks left before it is too late to fund …`) never contains an instruction, only facts; when the margin is short it ends in `see the action`, and the action shown with the tick is the only thing to follow.

With two Ethereum nodes Bob's tool also reads the secret from either of them, and while Bob waits for it every tick compares the
Ethereum head time with the clock (limit 600 s): a lagging node shows up as an `ALARM` in the action reason. Switch `ETH_RPC` to a
healthy node when you see it.

## Clearing a FILE.lock-sent record

A real `lock --swap FILE` writes TWO records and syncs both BEFORE the lock is broadcast; a real lock without `--swap` writes the per-user record only (nothing in them is secret):

- `FILE.lock-sent`, beside the swap file: lock word, lock id, sender, nonce, the signed hash when the key is local, time.
- The per-user record: one file per chain id, sender and lock word, `CHAIN-SENDER-LOCKWORD.json` (sender and lock word in lower case, without `0x`), in the folder `.noid-swap/lock-sent/` of the account's home directory (on Windows `C:\Users\NAME\.noid-swap\lock-sent\`). The account's home is the one the operating system's account database gives the user that runs `live.js`; it is NOT read from the `HOME` or `USERPROFILE` of the environment. Refused, nothing sent: a `HOME` (Linux, macOS) or `USERPROFILE` (Windows) that names a directory other than the account's home (a changed variable, a wrapper that moves `HOME`, a `sudo` that kept the caller's `HOME` and cleared its `SUDO_` variables); run it as the same user, with `HOME` and `USERPROFILE` unchanged. This refusal names both homes (it prints "empty or not readable" for an empty one). Refused too, through the two variables `sudo` sets: a run with `SUDO_UID` or `SUDO_USER` set and not empty (an empty one counts as unset). `sudo` usually runs as another user account (its homes are then usually that account's; some setups keep the caller's `HOME`), which does not see this user's records; run it as the user that holds them. This refusal names no path, and neither does the refusal for an account home that cannot be read from the operating system. Not refused, because it cannot be detected: `su`, `runas`, another login and another machine run as another account or place, which has no record. Fine, the records are found: cron, a service unit and `env -i` take `HOME` from the account database or leave it unset, unless they set it themselves; then the two homes are equal. One that sets another `HOME` is a changed `HOME` and is refused. It holds the same fields, the same time, plus the chain id, the contract, the lock kind and the real path of the swap file (`null` for a lock without `--swap`). It is named from WHAT is locked, not from the swap file, so a renamed or copied swap file (and a lock without `--swap`) finds it. A lock without `--swap` has no record beside a swap file, no approval, no lock lock and no pending-nonce check; the per-user record is the only record it leaves.

While either exists, every later real lock refuses (the per-user record is looked for by every real lock, `--swap` or not), because the lock may be in flight and the duplicate rule reads mined locks only. A record that cannot be examined or read counts as present, and so does a home directory that cannot be placed or that differs from the account's. If a record cannot be made durable, nothing is sent. The tool never removes a record: only a call that was refused before the broadcast takes back the records it made itself. Refusing a lock is always the safe direction (no lock means no ETH at risk), so when in doubt wait, or let the swap abort. A dry run writes no record and warns when one exists. These checks are meant to prevent a second send and were tested offline only.

**What they do not cover.** Another machine, or another user account on this machine, has neither record: it has the duplicate rule (mined locks only) and, with a swap file, the pending-nonce check of its own node. A lock sent from there is not stopped by a record here. Send Bob's lock from one machine and one account.

**The homes of the helper modes.** `env.sh` decides which Node runs `live.js`. Under `LIVE_PLATFORM=wsl` it is the Windows `node.exe` through WSL interop (the default; the `NODE` variable overrides it in either mode), so the per-user records are in the Windows profile folder, `C:\Users\NAME\.noid-swap\lock-sent\`, and not in the WSL home. Under `LIVE_PLATFORM=native` it is the `node` of the shell: on macOS and Linux the records are in the Unix home of that user; in Git Bash on Windows, in the Windows profile folder. Except for `wsl` mode and Git Bash `native` mode under the same Windows account, which share the Windows profile folder, these are homes of different accounts, so do not change the platform mode, the machine or the user account while a lock is unresolved: none of them carries the record over, and the other one has the duplicate rule only.

**Upgrade.** A lock sent by a version from before the per-user record has only `FILE.lock-sent`. Resolve every `*.lock-sent` (clear it by the steps below, or confirm that the lock is mined) before you move to this version: after a rename or a copy of such a swap file only the duplicate rule (mined locks) and the node-local pending-nonce check hold a second lock back.

**A local test chain of your own that was restarted.** The lock went with the chain's state, so neither proof can be met. The record of such a lock (the chain id of the local test chain is in its file name) is removed by hand. This applies to a local test chain only, never to a public network.

Remove a record by hand ONLY if one of two proofs holds AND the contract reads of step 3 show no lock (all read-only; `$ETH_RPC` is the endpoint of `env.local.sh`, ask `$ETH_RPC2` too when you have it; `SENDER`, `HASH`, `NONCE`, `LOCK_ID` and `LOCK_WORD` are in the record: `cat bob.swap.json.lock-sent`):

1. Look up the recorded hash for a receipt, and the finalized block:
   ```bash
   curl -s -X POST "$ETH_RPC" -H 'Content-Type: application/json' --data '{"jsonrpc":"2.0","id":1,"method":"eth_getTransactionReceipt","params":["HASH"]}'
   curl -s -X POST "$ETH_RPC" -H 'Content-Type: application/json' --data '{"jsonrpc":"2.0","id":1,"method":"eth_getBlockByNumber","params":["finalized",false]}'
   ```
   **Proof 1:** the receipt exists and its `blockNumber` is at or below the finalized block's `number` (both are hex). `"status":"0x0"`: it reverted and locked nothing. `"status":"0x1"`: the lock is mined, which is not a reason to remove anything: step 3 will show it, and a record of a mined lock is kept (no second lock under this lock word is ever wanted). `"result":null` is no receipt: not mined, or not seen by this node.
2. Read the sender's nonce at the finalized block and compare it with the record:
   ```bash
   curl -s -X POST "$ETH_RPC" -H 'Content-Type: application/json' --data '{"jsonrpc":"2.0","id":1,"method":"eth_getTransactionCount","params":["SENDER","finalized"]}'
   ```
   **Proof 2:** the result (hex) is ABOVE the record's `nonce` (decimal), and step 1 shows no receipt for HASH on any endpoint you have: that nonce was used by another transaction, so the recorded one can never be mined. **Proof 2 alone is not enough**: a replacement of the same call under another hash (a wallet's "speed up") uses the same nonce, so "no receipt for the recorded hash" proves nothing by itself, and the replacement can be the lock that was mined. A record with no hash (`tx_hash` null: the key was not local) has no hash to look up at all: for it proof 2 only says that the nonce has passed, and step 3 is the whole check.
3. **Read the contract, on two endpoints, before you remove a record under EITHER proof.** Both reads are mandatory when the record has `tx_hash` null.
   - The record's lock id, from `eth/` (the endpoint is `ETH_RPC_URL`; run it once with `$ETH_RPC` and once with `$ETH_RPC2`; `--from-block` is a block a little before the lock was sent):
     ```bash
     ETH_RPC_URL="$ETH_RPC" node scripts/live.js status --contract CONTRACT --lock-id LOCK_ID --from-block BLOCKNUMBER
     ```
     It prints the lock (sender, receiver, amount, timelock, claimed, refunded) or says there is none.
   - The `Locked` events of this sender, up to the finalized block (`SENDERPAD` is the sender, 24 zeros then the 40 hex digits without `0x`; if the endpoint caps the range, ask in ranges of at most 50,000 blocks from a little before the lock was sent):
     ```bash
     curl -s -X POST "$ETH_RPC" -H 'Content-Type: application/json' --data '{"jsonrpc":"2.0","id":1,"method":"eth_getLogs","params":[{"address":"CONTRACT","fromBlock":"0xFROM","toBlock":"finalized","topics":["0x578af4d125bb96ec89cd1ade591cb196f35d15047d5b096c478e45e311d84263",null,"0xSENDERPAD"]}]}'
     ```
     In every log, the second 32-byte word of `data` (after the amount) is the lock word. A log whose lock word is the record's `lock_word` is a lock of this sender under this lock word, whatever its lock id and its timelock.

   If either read shows a lock, that lock IS mined: do not send another, and keep the records.
4. Remove the record (`rm bob.swap.json.lock-sent`, and the per-user file under `.noid-swap/lock-sent/`; remove the two together) only if proof 1 or proof 2 holds and step 3 shows no lock. If neither holds, do not remove it: wait (a pending transaction is mined, replaced or dropped), or let the swap abort.
5. A send that no node ever accepted (HTTP 429, a refused redirect or connection, "fee too low") leaves a record too, and the sender's nonce never moves, so proof 2 cannot come by waiting. The way out is to spend the recorded nonce yourself: send a 0-ETH transfer from the sender to itself at exactly that nonce (from the wallet that holds the key, with a fee above the base fee). Once that transaction is in a finalized block, proof 2 holds; the reads of step 3 still have to show no lock.
6. **An empty or half-written record.** A crash between creating a record and writing it leaves a file that is empty or holds part of the line. It normally comes from BEFORE the signature (the whole record is synced and read back before the signature is used), so no lock went out from that call; on a share that does not keep its promise to sync (the `\\wsl.localhost` path), after a power loss, treat it like a full record. It refuses like any record and the tool does not remove it. Remove it (and its twin, if there is one) only when (a) the sender's pending nonce equals its latest nonce on two endpoints (`eth_getTransactionCount` with `"pending"` and with `"latest"`: nothing of this sender is in flight) and (b) the reads of step 3 show no lock of this sender under the swap's lock word (a lock id is not in such a record: use the `Locked` events search, and the lock word of the swap file; the name of a per-user record carries the sender and the lock word).

A node that is behind, or a load-balanced endpoint, can answer `null` for a mined hash or an old nonce, or no logs for a lock that exists (a stale log index): ask more than once and from two endpoints. The pending-nonce check of `live.js` is only an extra, because nodes drop pending transactions; the records and the contract reads are what count.

## Producer concentration and the removed-claim alert (threat T21)

Design and texts: `docs/bob-concentration-gate.md`. Two settings, both off unless you set them (`ALERT_URL` in `$L/env.local.sh`; `ACCEPT_PRODUCER_CONCENTRATION` for ONE command only, not in the file, see below):

- **`ACCEPT_PRODUCER_CONCENTRATION=1`** makes `node_flags` pass `--accept-producer-concentration` to `swap-cli`. **It is a standing waiver, not a one-off:** the swap file records the override and it also covers a LATER finding that a node is misreporting the producers (a disagreement between two nodes), not only the concentration you looked at. Set it for ONE command only (`ACCEPT_PRODUCER_CONCENTRATION=1 scripts/live/tick.sh bob --apply`), never as a line in `env.local.sh`; the warning below says so on every call while it is on. Under the `production` profile Bob's tool does
  not offer the lock while one address produced more than 35 % of the last 2,880 or 720 Parano1d blocks, or while it cannot read those headers from
  the node in full (a screen, not a defence); this setting waives that refusal. It is opt-in only (only the value `1` counts), no profile and no other
  setting implies it, it does not waive the second-node rule (`SINGLE_NODE_OK` is separate), and every call that builds the node flags (every tick, every
  claim, so every poll of `watch.sh`) prints a warning on stderr while it is on. Under `sepolia` and `rehearsal` the screen only warns, so a run
  with both roles played by one person needs nothing. The tool keeps the headers it has read in `<swap file>.producers` beside Bob's swap file (it
  holds miner addresses; keep it local, never commit it).
- **`ALERT_URL=https://...`** makes `watch.sh` send a short message when Bob's mined NOID claim was removed by a reorg (a tick's `ALERT:` note;
  `tick.sh` prints each such note on a line of its own, and the loop line carries it). For every line that starts with `ALERT:` the loop runs
  `curl -s -f -m 20 -d "noid-swap run N: claim removed by a reorg; run claim.sh dry run" -K -` (with the helpers' `$CURL`), the URL on curl's standard
  input so that it is not in the process list. The engine prints the alert on one tick only (the tick that takes the transition), so there is no
  latch: a second removal later in the run alerts again, and the same message twice in one call is sent once. A send that fails is kept in
  `$L/alert-pending` (`TRIES|MESSAGE`) and tried again at every later tick, up to 20 times; it can never stop the loop. The message is fixed text
  and the run number: no address, amount or transaction id leaves the machine. **The URL
  is read only from `$L/env.local.sh`** (an `ALERT_URL` in the environment is ignored), is never printed by the helpers, and must never be put in a
  tracked file. The alert only asks you to look: run the dry run (`bash $L/bin/claim.sh`), check it, then `--submit`. Nothing is sent to a chain
  automatically; an opt-in automatic re-send is a later item (`TASKS.md` T21-8).
  **After a re-send, look at the next tick** (the alert text says the same): the claim must be in the pool or included; if it is gone, send it again.
  The Parano1d node does not re-admit orphaned transactions after a reorg and removes any copy of the same transaction already in its pool when it
  handles one, so a claim re-sent just before that can vanish again (T21-16). A claim or refund built near the end of a 144-block epoch can expire
  unconfirmed and must be built again (design T6).
- **The stuck-claim message (T21-12).** With the same `ALERT_URL`, `watch.sh` also sends **one** fixed message per swap file and kind when
  `tick.sh` prints `ALARM: the NOID claim is still pending ...`: Bob's claim is in the pool but not mined and the next call height is past the
  `D - 19` target (kind `late`: "Bob's NOID claim is still pending past its target; look at the loop log") or at or past `D` (kind `closed`: "... the
  claim branch is closed ..."). The engine prints that alarm on every tick while it holds, so a latch file in the run folder, `$L/alarm-sent-ROLE-KIND`
  (empty; created atomically with `noclobber` before the send), keeps it to one message per episode: a complete tick that no longer shows the kind clears the latch, so a later episode (the claim reorged out, re-sent and stuck again) is announced again. If the send fails the latch is removed and the next tick
  tries again (a failing send never stops the loop). Delete the latch file to have the message sent again. The message is fixed text and the run
  number; the URL, addresses, amounts and transaction ids are never in the message, the latch or the output.

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
- **The reveal sidecar (T21-11).** `reveal.sh` (that is, `live.js claim --swap FILE`) writes `FILE.reveal-sent` next to the swap file just before it
  broadcasts: the lock id, the signed transaction's hash when it is known, the time; never the secret. If it cannot be written, nothing is sent.
  `swap-cli tick` (so `tick.sh` and `watch.sh`) and `live.js` read it as evidence that the secret may be public, for a sidecar of this swap's
  lock only, so a reveal that was sent and then dropped before any tick saw it still gets the late cutoff on a re-send. The plan and the full
  result file (`eth-claim.json`) print `revealSidecar` (`absent`, `matching`, `foreign`, `unreadable`, `written`, `kept`). A sidecar means a send was started,
  not that it reached the network; after a send error that never left the machine see `swap-cli/README.md` ("Residual window") before the next tick. Run `tick --apply` at once after every reveal anyway.
- **The claim lock.** A real `reveal.sh` takes `FILE.claim-lock` (exclusive create) before it touches the sidecar and releases it as soon as the send has settled. If it finds one it refuses and names the file: remove it by hand only when you are sure no other claim for this swap file is running (a claim killed in the middle leaves its lock). The tool never removes a lock it did not make.
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
- `--eth-from-block` is still passed from `$L/eth-deploy-block.txt` (the flag wins and is stored again); after
  the first `tick --apply` the swap file carries it and the file could be dropped; a file value HIGHER than the stored one is not passed. Since 2026-11-09 `setup.sh` writes a recent finalized block there
  instead of the Sepolia deployment block ("The Ethereum log start" above).
- A read-only `tick` no longer prints a spend's parameters, so `watch.sh` always applies.
- `watch.sh` stops by itself on a terminal phase (`done`, `refunded`, `lost`, `aborted`).

Checked read-only on 2026-11-05 against the finished run-3 files (`RUN=3`): see `docs/runbook-two-party.md` §7.
