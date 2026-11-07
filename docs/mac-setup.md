# Mac setup: Bob's machine and a second Parano1d node

One checklist. Each step is one command or one action, with the output to expect. Nothing here moves money.
Every step marked **UNVERIFIED** is not stated in any file of this repository and was never run on a Mac: if it
fails, read the pointer after it and stop; do not improvise with funds. Apple silicon is "M-series" below,
Intel is "x86-64". Commands are typed in the Terminal app (zsh).

Why a Mac node at all: `swap-cli` can compare two independent Parano1d nodes before Bob locks and Alice reveals
(`swap-cli/README.md`, "F5"). A second node on another machine is the cheap way to get that.

## 1. Prerequisites

1. Apple command line tools: `xcode-select --install`. A dialog opens; accept. Check: `clang --version` prints a version.
   If it says "already installed", fine.
2. Homebrew (the Mac package manager): follow the one line on https://brew.sh, then follow the "Next steps" it prints
   (it adds brew to your PATH; on M-series brew lives in `/opt/homebrew`, on Intel in `/usr/local`). Check: `brew --version`.
3. Tools: `brew install cmake pkg-config llvm git node@22`. Check: `cmake --version`, `git --version`.
   `node@22` is "keg-only": add it to the PATH with the line brew prints, then `node --version` must start with `v22`
   (the repo needs Node 21 or later). The vendor notes ask for a C/C++ compiler, CMake, libclang and Git
   (`vendor/parano1d/docs/developers/build.md`); libclang comes with `llvm`. If a build later says
   "couldn't find libclang", run `export LIBCLANG_PATH="$(brew --prefix llvm)/lib"` and retry. **UNVERIFIED** on macOS.
4. Rust: `curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh` (press 1 for the default), then open a new Terminal.
   Check: `rustc --version`. The vendored code pins 1.96.0 in `vendor/parano1d/rust-toolchain.toml`; inside `vendor/`
   rustup fetches it by itself. The three Rust folders of this repo (`swap-cli`, `equiv`, `equiv/zkvm`) have no pin,
   so build them with the same compiler: `rustup toolchain install 1.96.0` then `export RUSTUP_TOOLCHAIN=1.96.0`
   in every Terminal you build in (`runbook-two-party.md` section 2, Bob step 2). If it fails, `rustup show` and compare.
5. z3: not needed. It is only for `pruv verify` of the contract, which Bob does not run.
6. Disk: keep 40 GB or more free for the chain data, the build and the proof program. RAM: see
   `vendor/parano1d/docs/operate/hardware.md` for the node; the repo's own numbers are 8 GB for the node plus build.

## 2. Fetch the repository

1. `git clone https://github.com/00Para/noid-swap.git && cd noid-swap`
2. `git rev-parse HEAD`: must equal the commit Alice names. Different: stop, ask her.
3. `ls vendor/parano1d`: must list folders such as `noid_core` and `noid_gkr`. If `vendor/parano1d` is missing or empty:
   `bash scripts/fetch-vendor.sh`. It ends with `vendor/parano1d at d29b801`. Never edit anything in `vendor/`.
4. Anonymity on this machine (rules of `PROJECT.md`; the repository holds no name, place, language or timezone):
   `git config user.name 00` and `git config user.email 352887559+00Para@users.noreply.github.com`
   (the address of `docs/release-checklist.md`). If you ever commit here, fix the dates too:
   `export GIT_AUTHOR_DATE=2026-11-06T00:00:00+0000 GIT_COMMITTER_DATE=2026-11-06T00:00:00+0000`
   (a fixed UTC value, as the release checklist does). Normal Bob use does not commit at all.
   Also: do not sign in to a personal Apple, Google, GitHub or email account in the browser profile or the
   Terminal you use for the swap; make a separate macOS user or browser profile for it. Look at the Mac's
   name (`scutil --get ComputerName`): if it holds a real name, do not paste terminal output with the prompt into public places.

## 3. Build the tools

Everything is built in a target folder outside the repo tree if you like; below they use their default `target/`.

1. `cd swap-cli && cargo build --release`. First build takes several minutes. Expected last line: `Finished release`.
   The binary is `swap-cli/target/release/swap-cli`. (`swap-cli` reaches `../parano1d/harness` and `../vendor/parano1d/*`
   by path, so the whole tree must be present.) Then `export BIN=$PWD/target/release/swap-cli`; `$BIN --help` lists
   `new-bob`, `tick`, `claim`. If it fails inside `vendor/`, copy the first error line to Alice. **UNVERIFIED** on macOS
   (the code was only ever built on Linux/WSL).
2. RISC Zero (the proof system Bob uses only to verify): `curl -L https://risczero.com/install | bash`, open a new
   Terminal, `rzup install`. Check: `r0vm --version` prints `3.0.x`. **UNVERIFIED** that this works on your chip: if it errors
   with an architecture message, read what `rzup install` prints and `equiv/README.md` section 5. Intel Macs are the
   most doubtful case.
3. Verifier binary: `cd ../equiv/zkvm && cargo build --release -p equiv-host`. The program is `target/release/equiv-prove`.
   `export EQ=$PWD/target/release/equiv-prove`. Check: `cargo run --release -p equiv-host -- image-id` prints a hex image id.
4. The image id must begin `7e9d8477` and end `6187` (the id compiled into `swap-cli`, `swap-cli/README.md`). **UNVERIFIED** that a Mac
   build gives the same id as Alice's WSL build. If it differs, `new-bob` refuses (fail closed); nothing is lost. Stop and tell
   Alice: the cure is the reproducible docker build (`EQUIV_REPRODUCIBLE=1`, needs Docker, milestone M1.1, not done).
5. Node side: `cd ../../eth && npm install && npx hardhat compile`. Expected: `Compiled ... Solidity files successfully`.
   If the solc download is blocked it falls back to the npm package by itself (`eth/README.md`).
6. Do not export `RISC0_DEV_MODE`; the tools refuse it.

## 4. Run the test suites (offline, no node needed)

Run each from the repo root in a Terminal with the same `RUSTUP_TOOLCHAIN`. Expected counts are from the project files.

| Command (folder) | Expect |
|---|---|
| `cd eth && npx hardhat test` | `181 passing` (PROJECT.md says 131 in one place, the latest commit says 181; the end of the output, not the number, is what matters: `0 failing`) |
| `cd btc && npm install && npm test` | 66 pass (Bitcoin is not used by an ETH swap; optional) |
| `cd swap-cli && cargo test --offline --no-fail-fast` | 362 tests pass (README says 359; later commits added more), 1 ignored. First run builds for 5 to 15 minutes |
| `cd equiv && cargo test --release` | 22 pass |
| `cd equiv/zkvm && cargo test -p equiv-guest-core` | 3 pass |

Drop `--offline` on the first `cargo test` if crates are missing: cargo then downloads four small crates
(`swap-cli/README.md`). A failure on the Mac that Alice's machine does not have is exactly what this step is for:
send her the test name and the first error lines, change nothing. Everything above on macOS is **UNVERIFIED**.

## 5. Install and sync a Parano1d node (does not mine)

1. Download the Core archive from the release page named in `vendor/parano1d/docs/getting-started/core.md`:
   `parano1d-core-vVERSION-macos-aarch64.tar.gz` (M-series) or `parano1d-core-vVERSION-macos-x86_64.tar.gz` (Intel),
   version 2.1.0 or later, and `SHA256SUMS` from the same release. (The wallet app `.dmg` runs the same node; use one or the
   other, never both, they share a port.)
2. `shasum -a 256 parano1d-core-*.tar.gz` and compare with the line in `SHA256SUMS`. Different: delete the file, stop.
3. `mkdir ~/parano1d && tar -xzf parano1d-core-*.tar.gz -C ~/parano1d && cd ~/parano1d`.
   macOS may refuse an unsigned program ("cannot be opened"): Control-click it, Open, confirm; or System Settings,
   Privacy and Security, Open Anyway, after step 2 passed. The `.tar.gz` programs may be blocked the same way
   (**UNVERIFIED**; `getting-started/wallet.md` only describes the app).
4. `./parano1d --check-hardware`: the last line must be `NODE READY` (needs NEON and PMULL on M-series; SSE4.1 and
   PCLMULQDQ on Intel). Anything else: stop, `operate/hardware.md`.
5. `./parano1d` in this Terminal window (leave it open; it does not mine, mining is off unless you pass a `--mode miner`
   option, `operate/configuration.md`). First start creates `~/.parano1d/parano1d.toml` and `~/.parano1d/data/`.
6. In a second Terminal: `cd ~/parano1d && ./parano1d-cli status`. Initial sync takes a long time (hours). The chain tip
   it prints must match what the first node (Alice's wallet) shows for the current height, within a few blocks (blocks are
   about 30 s). If it keeps showing a height far below the other node for hours: `./parano1d-cli peers` must list peers;
   if empty, `operate/troubleshooting.md`.
7. Needed by `swap-cli`: the node must answer `paranoid_getBlockHeader` with the tip height as its one parameter
   (`swap-cli/README.md`, table "Parano1d RPC methods"; that method was never called against a real node by the tool
   layer, so this is **UNVERIFIED**). Put the height from `./parano1d-cli status` in place of 123456:
   `curl -s -X POST -H 'content-type: application/json' --data '{"jsonrpc":"2.0","id":1,"method":"paranoid_getBlockHeader","params":[123456]}' http://127.0.0.1:9601`.
   Expect a reply with a `timestamp` number. A `null` or an error means the node cannot serve the F5 check: tell Alice.
8. Stop cleanly later with `./parano1d-cli stop`. Do not delete `~/.parano1d/data` on updates.
9. Bob's receiving address: `./parano1d-cli address --list` (an `o1...` string) is `--bob`. If the wallet is new, back up
   its master secret on paper now; never type it into a file or chat.
10. Ports: P2P 9600 (inbound optional), RPC 9601 (loopback only). Leave 9601 on loopback.

## 6. Letting the PC use this node for the second-node check

Facts: the node refuses to start an RPC listener on a non-loopback address unless a scoped key is configured; owner
methods that `tick` needs (`getEpochAnchor`, `getObjectInstances` and others) are answered only to a loopback client,
the operator key does not cover them, and `swap-cli` has no way to send a key (`swap-cli/README.md` around line 341;
`vendor/parano1d/docs/reference/cli.md`). So do **not** open 9601 to the network. Use an SSH tunnel; the node then sees a loopback caller.

1. On the Mac: System Settings, General, Sharing, turn on Remote Login for your user only. Note the Mac's local
   address (System Settings, Wi-Fi, Details) and keep both machines on the same private network, not a public one.
2. On the PC (Windows PowerShell, OpenSSH is built in): `ssh -N -L 127.0.0.1:19601:127.0.0.1:9601 MACUSER@MACADDRESS`
   and leave it running. Check from the PC: `curl.exe -s -X POST -H "content-type: application/json" --data "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"getChainInfo\",\"params\":[]}" http://127.0.0.1:19601`
   returns a JSON reply with a height (`getChainInfo` is a method the README records; the tunnel itself was never tried, **UNVERIFIED**).
3. The PC passes both nodes: `--noid-rpc http://127.0.0.1:9601 --noid-rpc http://127.0.0.1:19601`. The tool accepts another
   port on the same machine "with a note" because it shares one network view of the endpoint; the Mac node syncs independently,
   which is the point. From WSL on the PC use `--transport curl` (WSL cannot reach the Windows loopback by TCP).
4. Better still, run `swap-cli` on the Mac itself, where both Ethereum and Parano1d nodes are local (section 7): then Bob
   needs the tunnel the other way round for a second Parano1d node (a node of the PC or another operator). Same recipe, ports swapped.
5. Turn Remote Login off after the check if you do not need it.

## 7. What changes in the helper scripts (`scripts/live/`)

They were written for WSL: nothing in them is Mac-ready. Defaults to override, in `$L/env.local.sh`
(`L` defaults to `$HOME/live-run-N`; `env.sh` sources that file last):

- `CURL=curl` (macOS ships `/usr/bin/curl`; with `--transport tcp` against the local node curl is not needed at all,
  so on the Mac use `--transport tcp` for `http://127.0.0.1:9601` and `--transport curl` only for https Ethereum endpoints).
  `env.sh` hard-codes `--transport curl` in `node_flags`; either edit your own copy or call `$BIN` directly.
- `NODE=$(command -v node)`, `ETH_DIR=$HOME/noid-swap/eth`, `PUB=$HOME/live-run-N-public` (any folder you may share).
- `BIN` and `EQ` to the paths of section 3. `NOID_RPC=http://127.0.0.1:9601`.
- `win_path()` uses `wslpath -w`, which does not exist on a Mac. `lock.sh`, `reveal.sh`, `refund-eth.sh` call `live.js --swap FILE`
  through it. Replace the function body with `echo "$1"` in your `env.local.sh` (a plain path is right for a native node; `live.js` reads it directly).
- `WSLENV` lines are harmless. `mapfile` (used in `tick.sh`) needs bash 4; macOS bash is 3.2. Install `brew install bash`
  and run the helpers with it (`/opt/homebrew/bin/bash` or `/usr/local/bin/bash`). `python3` is used by `tick.sh`; `python3 --version` should work after the Xcode tools.
- Everything above is **UNVERIFIED**: the scripts were only run under WSL. If one stops with `command not found` or `bad substitution`, it is almost always bash 3.2.
- Public Ethereum endpoints and the Sepolia key steps are in `runbook-two-party.md` section 2, Bob steps 7 and 8, and `eth/README.md`.

## 8. Ready check (read-only)

1. Both Terminals from section 5 show the node synced (`./parano1d-cli status` tip equals the other node's within a few blocks).
2. `export SWAP_PASSPHRASE='...'` (12+ characters, only in this Terminal; the same one that sealed the swap file).
3. With a swap file in hand from Alice (`bob.swap.json`; before one exists use any fixture file from the repo):
   `$BIN tick bob.swap.json --transport tcp --noid-rpc http://127.0.0.1:9601 --eth-rpc http://127.0.0.1:8545 --single-node-ok`
   (replace the Ethereum URL by yours; under `sepolia` an https endpoint needs `--transport curl`).
   Without `--apply` it records nothing and, for a spend, prints `"parameters": "withheld"`: that is correct.
4. Ready means: exit status 0 (`echo $?`), JSON that shows `noid.tip` close to the real height, a `tip_time` that is not
   `null` and an `action` such as `wait`. If `tip_time` is null the node lacks `paranoid_getBlockHeader`: update the node. If the tool
   says `lag (F5)`: the node is still syncing; wait.
5. Final: `git status` shows no change in the tree (you built only into `target/` and `node_modules/`); `git log -1` shows the commit from section 2.
