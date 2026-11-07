# Live-run helpers (`scripts/live/`)

The shell helpers the owner's machine used for live runs 1–3 (`~/live3-tick.sh`, `~/reveal3.sh`, `~/claim3.sh`, …)
lived only in WSL home. This folder is the versioned version, adapted to the REVIEW-3 fixes of 2026-11-05. They
run in WSL, drive `swap-cli` for the NOID side and Windows `node` + `eth/scripts/live.js` for the
Ethereum side through WSL interop, exactly as run 3 did (`docs/live-run-3.md`).

**They never move funds by themselves.** Every spend is a separate command with an explicit `--submit` or a missing
`--dry-run`, and each one needs the owner's go-ahead (`PROJECT.md`, hard rules). What runs unattended is `watch.sh`,
which only observes and records (`tick --apply` writes events and intents into the swap files; it sends nothing).

| script | role | what it does | sends anything? |
|---|---|---|---|
| `env.sh` | — | run number, paths, nodes, amounts; the four party addresses and the HTLC contract address have no default and come from `$L/env.local.sh` (also second nodes, another RPC) | no |
| `install.sh [RUN]` | — | freezes a copy of this folder under `$L/bin` (run 3 lesson: never edit a helper while a loop calls it) | no |
| `setup.sh` | — | `$L` with a fresh passphrase (kept if present), `bob/`, `rec/`, the HTLC deployment block for `--eth-from-block` | no |
| `prepare.sh` | both | `new-alice`, the equivalence proof (secret over a pipe), `new-bob --receipt`, the contract definition; copies the bundle and definition to `$PUB` for the owner | no |
| `check-object.sh [OBJ]` | Alice | `alice-params --check-object`: the object `parano1d-cli contract create` wrote must be byte-for-byte the swap file's opening | no |
| `tick.sh ROLE [--apply]` | either | one tick; read-only without `--apply` (then a spend's parameters are withheld, REVIEW-3 F3); records every node answer | no |
| `watch.sh [alice\|bob\|both] [s]` | either | `tick --apply` loop, one summary line per tick in `$L/loop-ROLE.txt`; stops when every watched file is terminal | no |
| `lock.sh [--dry-run]` | Bob | `live.js lock --swap bob.swap.json`: the lock Bob's file recorded as `lock_eth` | **yes** without `--dry-run` |
| `reveal.sh [--dry-run] [--replace [TXHASH]]` | Alice | `swap-cli secret \| live.js claim --swap alice.swap.json --secret-stdin`: the reveal; `--replace` re-sends a stuck claim (see below) | **yes** without `--dry-run` |
| `claim.sh [--submit]` | Bob | `swap-cli claim`: proves and prints the close; `--submit` sends it to the node | **yes** with `--submit` |
| `refund-eth.sh [--dry-run]` | Bob | `live.js refund --swap bob.swap.json` after `T_reveal` (abort path) | **yes** without `--dry-run` |

Alice's NOID recovery at `D` is not a helper: it is `parano1d-cli contract call --close` on Windows with `--preview` and
`--expected-txid` chained in one command (run 2 lesson), then `tick.sh alice --closed-by TXID --apply`.

## A run, step by step (owner in both roles, `sepolia` profile)

```
bash scripts/live/install.sh 4            # RUN=4 → ~/live-run-4/bin
bash ~/live-run-4/bin/setup.sh            # passphrase, folders, eth-deploy-block.txt (12066295 = the Sepolia HTLC's deployment)
bash ~/live-run-4/bin/prepare.sh          # Alice's file + proof (20–36 min) + Bob's file + swap.def.json → copied to C:\Users\00\Documents\live-run-4
# Windows:  parano1d-cli contract create swap.def.json --out swap.object.json   (local, no fee)
bash ~/live-run-4/bin/check-object.sh     # "object file OK: … fund exactly this address"
# GO / NO-GO, then the owner's go-ahead:  parano1d-cli contract fund swap.object.json 10.000000
bash ~/live-run-4/bin/watch.sh both 30 &  # both files, every 30 s, until both are terminal (tail -f ~/live-run-4/loop-*.txt)
# when Bob's loop says lock_eth:   lock.sh --dry-run, go-ahead, lock.sh
# when Alice's loop says reveal_eth: reveal.sh --dry-run, go-ahead, reveal.sh
# when Bob's loop says claim_noid:   claim.sh (dry run), go-ahead, claim.sh --submit
```

Send the owner, at every run: the Parano1d contract root (`o1…`, printed by `prepare.sh` and in `$PUB/alice.bundle.json`),
the Sepolia contract link, the bundle and the object file.

## Two nodes (REVIEW-3 F5)

Under `sepolia` and `production`, Bob's lock and Alice's reveal wait for a second, distinct node per chain unless
`--single-node-ok`. The helpers pass `--single-node-ok` while `NOID_RPC2` / `ETH_RPC2` are empty, and print a warning
on EVERY call of `tick.sh` / `claim.sh` (so on every poll of `watch.sh`), not once in `setup.sh` (REVIEW-4 R4-8). That is for a
run in which one person controls both roles or trusts the counterparty. **A run with a stranger needs BOTH second nodes**: set
`NOID_RPC2` and `ETH_RPC2` in `$L/env.local.sh` (another Parano1d node on another host or port; another Sepolia RPC provider).
If either is empty the flag waives the second-node rule for BOTH chains. The same endpoint twice is refused by `swap-cli`.

With two Ethereum nodes Bob's tool also reads the secret from either of them, and while Bob waits for it every tick compares the
Ethereum head time with the clock (limit 600 s): a lagging node shows up as an `ALARM` in the action reason. Switch `ETH_RPC` to a
healthy node when you see it.

## The reveal: fee cap, a stuck claim, a late re-send (REVIEW-4 R4-1, R4-3, R4-5)

- **Fee cap.** `live.js claim` reads the latest base fee before it signs (also in `--dry-run`) and refuses a cap below 2 x that
  base fee; the dry run prints `feeCheck` (base fee, cap, ratio). On mainnet put `MAX_FEE_GWEI=N` in `$L/env.local.sh`:
  `reveal.sh` then adds `--mainnet --max-fee-gwei N` (without it a chain-1 file is refused; on a test chain `GAS_PRICE_GWEI` does
  the same for `--gas-price-gwei`). Look at the base fee in the minute before the reveal and use at least 3 x.
- **Stuck claim.** A claim that sits in the mempool has already published the secret, and only Bob can use it. `live.js` prints
  `sent: 0x… nonce N …` on stderr (in `$L/eth-claim.err`) the moment it sends, before it waits for the receipt. If the claim does
  not get mined, run `reveal.sh --replace 0xHASH` (or `--replace` alone; then the node's pending block is searched) with a higher
  `MAX_FEE_GWEI`: the same call is re-sent at the SAME nonce, both fee fields at least 12.5 % up and the cap at least 2 x the
  base fee. It refuses when nothing is pending, when the pending transaction is not this claim, or when the lock is claimed
  already; it never uses a second nonce. `reveal.sh --dry-run --replace 0xHASH` shows the plan first.
- **Late re-send.** No margin flag is needed or passed. When the swap file's history shows the secret may already be public (a
  mined, reorged or dropped claim), `live.js claim --swap` takes the cutoff the intent froze (`T_reveal - DE`) and not the
  stricter `T_reveal - 1800 s`, so `swap-cli`'s late re-send can actually be sent. Without that evidence the earlier cutoff rules.
- **Keys.** With `--swap`, `claim` needs the key of the file's `alice_receiver` (`keys/alice.key`), `refund` and `lock` that of
  `bob_sender` (`keys/bob.key`); another key is refused.

## What changed since run 3's helpers

- `live.js lock`, `claim` and `refund` take `--swap FILE` (a `\\wsl.localhost\…` path, `wslpath -w`): no more typed
  `--hashlock`, `--t-reveal`, `--receiver`, `--amount-wei`, `--lock-id`, `--code-hash`, `--from-block`.
- No `--eth-code-hash` on `new-alice`/`new-bob`, no `--pinned-image-id` on `new-bob`: both are constants of the build.
- `--eth-from-block` is still passed from `$L/eth-deploy-block.txt` (harmless: the flag wins and is stored again); after
  the first `tick --apply` the swap file carries it and the file could be dropped.
- A read-only `tick` no longer prints a spend's parameters, so `watch.sh` always applies.
- `watch.sh` stops by itself on a terminal phase (`done`, `refunded`, `lost`, `aborted`).

Checked read-only on 2026-11-05 against the finished run-3 files (`RUN=3`): see `docs/runbook-two-party.md` §7.
