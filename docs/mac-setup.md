# Mac setup: Bob's machine and a second Parano1d node

One checklist. Each step is one command or one action, with the output to expect. Nothing here moves money.
A setup pass on an Apple Silicon Mac (8 GB, macOS) followed this file on 2026-11-06 and its findings are folded in below:
sections 1, 3, 4, 5 and the fixture check of section 8 were run there; section 7 ran in live runs 9 to 12, and the tunnel of
section 6 ran in live run 12 (`docs/live-run-12.md`). Every step still marked
**UNVERIFIED** is not stated in any file of this repository and was never run on a Mac: if it
fails, read the pointer after it and stop; do not improvise with funds. Apple silicon is "M-series" below,
Intel is "x86-64". Commands are typed in the Terminal app (zsh).

Why a Mac node at all: `swap-cli` can compare two independent Parano1d nodes before Bob locks and Alice reveals
(`swap-cli/README.md`, "F5"). A second node on another machine is the cheap way to get that.

Which lock kind decides how much of this you need. With the `poseidon` Ethereum lock kind (`--eth-lock-kind poseidon`,
raw variant only, `docs/runbook-two-party.md`) there is no equivalence proof and no `equiv-prove` on Bob's side: sections
3.2 to 3.4 can be skipped. With the `sha256` kind Bob verifies a receipt and needs them (but read 3.4 first).

## 1. Prerequisites

1. Apple command line tools: `xcode-select --install`. A dialog opens; accept. Check: `clang --version` prints a version.
   If it says "already installed", fine.
2. Homebrew (the Mac package manager): follow the one line on https://brew.sh, then follow the "Next steps" it prints
   (it adds brew to your PATH; on M-series brew lives in `/opt/homebrew`, on Intel in `/usr/local`). Check: `brew --version`.
3. Tools: `brew install cmake pkgconf llvm git node@22`. (Homebrew's `pkg-config` installs as `pkgconf`.) Check: `cmake --version`,
   `git --version`. `node@22` is "keg-only" and marked deprecated in Homebrew (end of life 2027-04-30). If a newer node is
   installed it may not come first on the PATH, so put it first for the session:
   `export PATH="/opt/homebrew/opt/node@22/bin:$PATH"`, then `node --version` must start with `v22`
   (the repo needs Node 21 or later). The vendor notes ask for a C/C++ compiler, CMake, libclang and Git
   (`vendor/parano1d/docs/developers/build.md`); libclang comes with `llvm`. `LIBCLANG_PATH` was not needed on that Mac.
   If a build later says "couldn't find libclang", run `export LIBCLANG_PATH="$(brew --prefix llvm)/lib"` and retry.
4. Rust. Either `curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh` (press 1 for the default), or
   `brew install rustup`. With the Homebrew package there is no `sh.rustup.rs` step and its `cargo` and `rustc` are not on the PATH.
   The vendored code pins 1.96.0 in `vendor/parano1d/rust-toolchain.toml`; inside `vendor/` rustup fetches it by itself.
   The three Rust folders of this repo (`swap-cli`, `equiv`, `equiv/zkvm`) have no pin, so build them with the same compiler:
   `rustup toolchain install 1.96.0 --profile minimal -c rustfmt`.
   Every Terminal you build in needs these two lines (put them in `~/.zshrc` if you like):

   ```sh
   export PATH="$HOME/.risc0/bin:$HOME/.cargo/bin:/opt/homebrew/opt/node@22/bin:/opt/homebrew/opt/rustup/bin:/opt/homebrew/bin:$PATH"
   export RUSTUP_TOOLCHAIN=1.96.0 CARGO_BUILD_JOBS=4
   ```

   Check: `rustc --version` prints `1.96.0` (`runbook-two-party.md` section 2, Bob step 2). **Warning:** with `RUSTUP_TOOLCHAIN`
   unset, a plain `rustup --version` on that Mac installed the latest stable toolchain by itself (about 1.3 GB). Set the variable first.
   If a build fails, `rustup show` and compare.
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

1. `cd swap-cli && cargo build --release --locked`. It took 35 s on that Mac. Expected last line: `Finished release`.
   The binary is `swap-cli/target/release/swap-cli`. (`swap-cli` reaches `../parano1d/harness` and `../vendor/parano1d/*`
   by path, so the whole tree must be present.) Then `export BIN=$PWD/target/release/swap-cli`. `$BIN --help` prints the usage
   to stderr, prefixed `error: usage:`, and exits 1; that is expected. It lists `new-bob`, `tick`, `claim`. If the build fails
   inside `vendor/`, copy the first error line to Alice.
2. RISC Zero (the proof system Bob uses only to verify; only for the `sha256` kind): `curl -L https://risczero.com/install | bash`,
   open a new Terminal, then install the versions listed in `equiv/README.md` instead of a bare `rzup install`:

   ```sh
   rzup install cargo-risczero 3.0.6
   rzup install r0vm 3.0.6
   rzup install rust 1.97.0
   rzup install cpp
   ```

   Check: `r0vm --version` prints `3.0.6`. `rzup` reads a saved GitHub CLI credential if one exists on the account. To keep it from
   doing so, run it with `HOME` pointing at an empty folder and the three tool homes set explicitly:
   `REAL="$HOME"; HOME="$(mktemp -d)" RISC0_HOME="$REAL/.risc0" CARGO_HOME="$REAL/.cargo" RUSTUP_HOME="$REAL/.rustup" rzup install r0vm 3.0.6`
   (the same prefix for each line). The installer adds only `~/.risc0/bin` to `~/.zshrc`, and `r0vm` lands in `~/.cargo/bin`,
   so the PATH line of 1.4 is still needed. If it errors with an architecture message, read what `rzup install` prints and
   `equiv/README.md` section 5. Intel Macs are the most doubtful case (not tried).
3. Verifier binary: `cd ../equiv/zkvm && cargo build --release --locked -p equiv-host` (102 s on that Mac, guest included).
   The program is `target/release/equiv-prove`. `export EQ=$PWD/target/release/equiv-prove`.
   Check: `cargo run --release --locked -p equiv-host -- image-id` prints a hex image id.
4. The image id compiled into `swap-cli` is `7e9d8477…6187` (`swap-cli/README.md`). **The id built on that Mac did not match it, and
   this is not a Mac quirk.** The guest binary's loaded read-only data contains panic-location paths under the builder's home folder
   (`$HOME/.cargo/registry/...`, 9 of them) and under the prebuilt toolchain's own build path (3 of them), and loaded bytes are
   hashed into the image id. The same source and the same toolchain with only `HOME` moved give a different id. `CARGO_HOME` has
   no effect on the guest build, and the checkout path is not in the guest. So a builder with a different home folder cannot
   reproduce the id with a local build.

   Effect: a locally built `equiv-prove` on a second machine cannot accept a `sha256`-kind receipt made by the first machine's
   build, and `new-bob` for such a swap refuses (fail closed). Nothing is lost. Ways out, in order:

   1. Use the `poseidon` lock kind (`--eth-lock-kind poseidon` on `new-alice` and `new-bob`). It needs no equivalence proof and no
      `equiv-prove` on Bob's side. This is what the Mac is ready for.
   2. The reproducible docker build (`EQUIV_REPRODUCIBLE=1`, needs Docker) on both sides: milestone M1.1 in `TASKS.md`, not done. It
      changes the compiled-in id.
   3. Make `equiv-prove verify` check a receipt against the pinned image id instead of the locally built one (verifying needs only the
      id). This is security-relevant and needs a review first. Not done.
5. Node side: `cd ../../eth && npm ci && npx hardhat compile`. Use `npm ci`, not `npm install`, so the lock file stays unchanged.
   Expected: `Compiled ... Solidity files successfully`. If the solc download is blocked it falls back to the npm package by itself
   (`eth/README.md`).
6. Do not export `RISC0_DEV_MODE`; the tools refuse it.

## 4. Run the test suites (offline, no node needed)

Run each from the repo root in a Terminal with the same `RUSTUP_TOOLCHAIN`. Counts below are what that pass saw.

| Command (folder) | Expect |
|---|---|
| `cd eth && npx hardhat test` | `265 passing`, `0 failing` (that pass saw 243 in 70 s, peak memory about 1.2 GB; 22 tests were added after it. Of those, the macOS memory fix was re-run on a Mac 2026-11-06: `npx hardhat test test/free-mem.test.js test/Poseidon2b.test.js` gave `28 passing` without any workaround; the full suite was not re-run there) |
| `cd btc && npm ci && npm test` | 91 pass (Bitcoin is not used by an ETH swap; optional) |
| `cd swap-cli && cargo test --offline --locked --no-fail-fast` | 520 passing, 1 ignored |
| `cd equiv && cargo test --release --locked` | 23 pass |
| `cd equiv/zkvm && cargo test --locked -p equiv-guest-core` | 3 pass |

Drop `--offline` on the first `cargo test` if crates are missing: cargo then downloads four small crates
(`swap-cli/README.md`). A failure on the Mac that Alice's machine does not have is exactly what this step is for:
send her the test name and the first error lines, change nothing.

Timing on that Mac with `CARGO_BUILD_JOBS=4`: the `swap-cli` suite took about 53 minutes, almost all of it `tests/chaos.rs`. The likely
cause (not measured): that test writes its swap files to `/dev/shm` when it exists and syncs them to disk on every save
(`swap-cli/CHAOS.md`), and macOS has no `/dev/shm`. `CHAOS_N` sets the number of chaos scenarios (default 1,000, `swap-cli/CHAOS.md`);
`CHAOS_N=100 cargo test --offline --locked --test chaos` is a short run, with fewer scenarios than the full one.

Measured on that Mac: the client R self-test took 791 to 834 ms per authorization proof (V4), over 4 runs at 2 heights.

## 5. Install and sync a Parano1d node (does not mine)

0. First look for an already installed wallet app (`ls /Applications | grep -i parano`). Its own `parano1d-node` listens on the same
   ports (P2P 9600, RPC 9601) and uses its own data folder and config (`data/parano1d-gui.toml`), while Core reads
   `~/.parano1d/parano1d.toml`. If the app is running, use its node for the read-only steps and do not start Core beside it.
   Starting Core against the app's data folder is untested. Steps 1 to 5 below are for a Mac without the app.
1. Download the Core archive from the release page named in `vendor/parano1d/docs/getting-started/core.md`:
   `parano1d-core-vVERSION-macos-aarch64.tar.gz` (M-series) or `parano1d-core-vVERSION-macos-x86_64.tar.gz` (Intel),
   version 2.1.0 or later, and `SHA256SUMS` from the same release. The repository name differs between files:
   the vendor docs `operate/node.md` and `getting-started/wallet.md` name `proof-native/parano1d` on GitHub, while
   `scripts/fetch-vendor.sh` clones `ignotusnemo/parano1d`. The archive used on that Mac was
   `https://github.com/proof-native/parano1d/releases/download/v2.1.0/parano1d-core-v2.1.0-macos-aarch64.tar.gz`, with its `SHA256SUMS`.
   The other name was not tried. (The wallet app `.dmg` runs the same node; use one or the other, never both, they share a port.)
2. `shasum -a 256 parano1d-core-*.tar.gz` and compare with the line in `SHA256SUMS`. Different: delete the file, stop.
3. `mkdir ~/parano1d && tar -xzf parano1d-core-*.tar.gz -C ~/parano1d && cd ~/parano1d`. The archive is flat (no top-level folder).
   A file downloaded with `curl` carries no quarantine flag, so macOS showed no Gatekeeper prompt, although the binary is only
   ad-hoc signed. If you download in a browser instead and macOS refuses the program ("cannot be opened"): Control-click it, Open,
   confirm; or System Settings, Privacy and Security, Open Anyway, after step 2 passed.
4. `./parano1d --check-hardware`: the expected result is `NODE READY` (needs NEON and PMULL on M-series; SSE4.1 and
   PCLMULQDQ on Intel). It is not the last line: a jemalloc warning prints first, and the last line is
   `MINING CAPACITY CALIBRATED AT RUNTIME`. The backend printed on that Mac was `neon+pmull`. Anything else: stop, `operate/hardware.md`.
5. `./parano1d` in this Terminal window (leave it open; it does not mine, mining is off unless you pass a `--mode miner`
   option, `operate/configuration.md`). First start creates `~/.parano1d/parano1d.toml` and `~/.parano1d/data/`.
6. In a second Terminal: `cd ~/parano1d && ./parano1d-cli status`. Initial sync takes a long time (hours). The chain tip
   it prints must match what the first node (Alice's wallet) shows for the current height, within a few blocks (blocks are
   about 30 s). If it keeps showing a height far below the other node for hours: `./parano1d-cli peers` must list peers;
   if empty, `operate/troubleshooting.md`.
7. Needed by `swap-cli`: the node must answer `paranoid_getBlockHeader` with the tip height as its one parameter
   (`swap-cli/README.md`, table "Parano1d RPC methods"). Put the height from `./parano1d-cli status` in place of 123456:
   `curl -s -X POST -H 'content-type: application/json' --data '{"jsonrpc":"2.0","id":1,"method":"paranoid_getBlockHeader","params":[123456]}' http://127.0.0.1:9601`.
   Expect a reply with a `timestamp` number. Verified on v2.1.0: the reply for the tip carried a `timestamp` field. A `null` or an
   error means the node cannot serve the F5 check: tell Alice.
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
   and leave it running. Check from the PC: `curl.exe -s -X POST -H "content-type: application/json" --data "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"paranoid_getChainInfo\",\"params\":[]}" http://127.0.0.1:19601`
   returns a JSON reply with a height. The method name is `paranoid_getChainInfo`: the bare `getChainInfo` answers "Method not found".
   This was run in live run 12 (`docs/live-run-12.md`): one SSH connection from the PC with a local and a remote port forward, so the
   PC saw the Mac's node on a local port and the Mac saw the PC's node on a local port. The Mac end answered with the same height and
   best block hash as the Mac's own node. If the client offers keys the Mac does not know, the server may refuse before it asks for
   the password: force password login for that connection (the SSH option `PreferredAuthentications=password`).
3. The PC passes both nodes: `--noid-rpc http://127.0.0.1:9601 --noid-rpc http://127.0.0.1:19601`. The tool accepts another
   port on the same machine "with a note" because it shares one network view of the endpoint; the Mac node syncs independently,
   which is the point. From WSL on the PC use `--transport curl` (WSL cannot reach the Windows loopback by TCP). The tool prints the
   same-host note (G3) on every tick, because a tunnelled node appears on localhost (finding 1 of `docs/live-run-12.md`); the two
   nodes are still on two machines, though on one private network.
4. Better still, run `swap-cli` on the Mac itself, where both Ethereum and Parano1d nodes are local (section 7): then Bob
   needs the tunnel the other way round for a second Parano1d node (a node of the PC or another operator). Same recipe, ports swapped.
5. Turn Remote Login off after the check if you do not need it.

## 7. What changes in the helper scripts (`scripts/live/`)

The helpers have a native mode (`scripts/live/README.md`, section "On macOS or Linux"). `env.sh` picks it by itself when `wslpath` or
`/mnt/c` is missing; to force it put `LIVE_PLATFORM=native` in `$L/env.local.sh` (`L` defaults to `$HOME/live-run-N`; that file is
sourced last and overrides any setting). In native mode the defaults are:

- `CURL=curl` (macOS ships `/usr/bin/curl`). `node_flags` keeps `--transport curl` (it also does https, which the Ethereum endpoint needs) and adds
  `--curl-path "$CURL"`; `swap-cli` would pick plain `curl` on its own when the WSL curl.exe path does not exist.
- `NODE=node` (Homebrew), `ETH_DIR` = the repository's `eth/` (found from `env.sh`'s own place; the copy that `install.sh` freezes under
  `$L/bin` reads `$L/repo-dir.txt`), `PUB=$L/pub` (a plain local folder, made on first use).
- `BIN` and `EQ` are `$HOME/noid-target/release/...` when those exist, else the section 3 paths `swap-cli/target/release/swap-cli` and
  `equiv/zkvm/target/release/equiv-prove` inside the repository. `NOID_RPC=http://127.0.0.1:9601` is the default and stays.
- `win_path` returns the path unchanged (a native node reads it directly), so `lock.sh`, `reveal.sh`, `refund-eth.sh` work with `live.js --swap FILE`.
- The scripts avoid `mapfile`, `grep -P`, `ls --time-style` and the other bash 4 / GNU-only forms, and expand possibly empty arrays in the
  bash 3.2 safe way, so the macOS `/bin/bash` works; `brew install bash` is no longer needed. `python3` is used by `setup.sh`, `prepare.sh`, `tick.sh`,
  `reveal.sh`; `python3 --version` should work after the Xcode tools. `WSLENV` lines are harmless.
- Bob needs only `tick.sh bob`, `watch.sh bob`, `lock.sh`, `claim.sh`, `refund-eth.sh`, plus a `bob.swap.json` made with `swap-cli new-bob` from
  Alice's bundle (put it at `$L/bob/bob.swap.json`). `prepare.sh` is Alice's script. The wallet CLI step (`contract create`) is not run by any helper:
  `prepare.sh` prints it as a by-hand step in native mode, and `check-object.sh` takes the path of the object file.
- Optional `PRIORITY_FEE_GWEI` (the tip) next to `MAX_FEE_GWEI`: on mainnet set the cap at 3–4 x the base fee and the tip small, e.g. `0.01`.
- **Checked on a Mac (2026-11-06):** `/bin/bash scripts/live/selftest.sh` printed `60 ok, 0 failed (bash 3.2.57(1)-release)`, so the settings
  layer (`env.sh`: platform choice, fee and node flags, `read_lines`, frozen copy) works under the system bash. Off the Mac: `bash -n` on every
  script, and the printed settings under bash 5 in native mode and in WSL mode (identical to the earlier `env.sh`).
  **Run live on a Mac (2026-11-06, runs 9, 10 and 11, `docs/live-run-9-10.md`, `docs/live-run-11.md`):** the native helpers ran Bob's side of three live runs under the
  system bash 3.2: `install.sh`, `setup.sh`, `watch.sh` / `tick.sh` (about 400 ticks in runs 9 and 10, 64 in run 11), `lock.sh` and `refund-eth.sh`, each dry run and send,
  with no helper error, and `new-bob` rebuilt Alice's opening byte for byte (in run 11 it refused a hand-copied bundle that had lost three characters, before anything was sent). **`claim.sh` has now run on a Mac** (run 11: dry run and `--submit`, both exit 0, the claim was final 18 blocks later). **Still not run on a Mac:**
  `reveal.sh`, `prepare.sh`, `fund.sh` and `recover-noid.sh` (Alice's scripts; `fund.sh` has run live under WSL, in run 11). If one stops with `command not found`, `bad substitution` or
  `unbound variable`, it is almost always bash 3.2 or a missing tool.
- Public Ethereum endpoints and the Sepolia key steps are in `runbook-two-party.md` section 2, Bob steps 7 and 8, and `eth/README.md`.

## 8. Ready check (read-only)

1. Both Terminals from section 5 show the node synced (`./parano1d-cli status` tip equals the other node's within a few blocks).
   If the wallet app's node is the one in use (5.0), compare the app's height instead.
2. `SWAP_PASSPHRASE` is not needed for a `tick`: in the source only `new-alice` and `secret` read it, and Bob's swap file holds no
   sealed secret. (If you do set it, use the same one that sealed the file, only in this Terminal.)
3. With a swap file in hand from Alice (`bob.swap.json`):
   `$BIN tick bob.swap.json --transport tcp --noid-rpc http://127.0.0.1:9601 --eth-rpc http://127.0.0.1:8545 --single-node-ok`
   (replace the Ethereum URL by yours; under `sepolia` an https endpoint needs `--transport curl`).
   Without `--apply` it records nothing and, for a spend, prints `"parameters": "withheld"`: that is correct.
   The repository has no ready swap file. Before one exists, this check worked on that Mac: write the example Bob file with the test
   helper, then tick it against the recorded Ethereum fixture, from the `swap-cli` folder:

   ```sh
   cd swap-cli
   EXAMPLE_BOB_OUT=<file> cargo test --offline --locked --test cli_live -- --ignored write_example_bob_file
   $BIN tick <file> --transport tcp --noid-rpc http://127.0.0.1:9601 --eth-fixture fixtures/eth/locked.json --single-node-ok
   ```

   The file is synthetic, not a swap; it shows that the binary, the node's RPC and the header-time check work together.
4. Ready means: exit status 0 (`echo $?`), JSON that shows `noid.tip` close to the real height, a `tip_time` that is not
   `null` and an `action` such as `wait`. If `tip_time` is null the node lacks `paranoid_getBlockHeader`: update the node. If the tool
   says `lag (F5)`: the node is still syncing; wait.
5. Final: `git status` shows no change in the tree (you built only into `target/` and `node_modules/`); `git log -1` shows the commit from section 2.

## 9. What the setup leaves on the Mac

- Homebrew packages: `cmake`, `pkgconf`, `llvm`, `git`, `node@22`.
- Rust toolchains (`~/.rustup`; `rzup` keeps its own under `~/.risc0`).
- `~/.risc0`, about 1.7 GB (only if you ran 3.2).
- `~/.cargo` (the crate cache and the installed `r0vm`).
- About 3 GB of ignored build output (`target/` folders and `node_modules/`) inside the checkout.
- If you used Core: `~/parano1d` and `~/.parano1d` (the chain data grows over time).
