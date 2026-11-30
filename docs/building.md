# Building the swap tool

Short version: a GitHub workflow (`.github/workflows/build.yml`) builds `swap-cli` for Windows, macOS and Linux on
GitHub's own machines, runs the offline tests, prints the sha256 of each program and attaches the programs as build
artifacts. The point is that you can get a program whose build you can read, instead of trusting one built on a private
machine.

**Status: the workflow has never run.** Nothing below about its results is known yet. Read "Not verified" before relying on it.

## What the workflow does

It runs on every push to `main` and on demand (`workflow_dispatch`). It uses no secrets and has read-only access to the
repository. Three jobs run side by side, one per platform:

| Platform | Machine | Target |
|---|---|---|
| Windows | `windows-latest` | `x86_64-pc-windows-msvc` |
| macOS (Apple Silicon) | `macos-latest` | `aarch64-apple-darwin` |
| Linux | `ubuntu-latest` | `x86_64-unknown-linux-gnu` |

Each job does this, in order:

1. Checks out this repository.
2. Checks that the chain's source is what it claims to be. That source ships in this repository, in `vendor/parano1d`, and
   the build uses it as it is. The workflow clones the upstream repository (the one `scripts/fetch-vendor.sh` names) at
   exactly one commit (`d29b8016c3c120312814f52d7f8a8ffef5523b80`) into a temporary folder outside the checkout, with
   line-ending conversion off, and compares the two trees file by file. The upstream `.git` folder and the upstream
   `research/` directory are left out (the shipped copy omits both, see `THIRD-PARTY-NOTICES.md`), and a carriage return
   at a line end is not counted (this repository stores text with LF endings). A file that exists on one side only, or
   any other difference, fails the job. It also fails if the compiler
   version pinned in the checked-out `vendor/parano1d/rust-toolchain.toml` differs from the one the workflow installs.
3. Installs Rust 1.96.0 with `rustup` (the version the chain's source pins). No third-party action is used for this.
4. Installs the native tools the chain's source needs: a C compiler, CMake and libclang.
5. Builds the program: `cargo build --release --locked` in `swap-cli`. `--locked` means the exact versions in
   `Cargo.lock` are used or the build fails.
6. Runs the tests: `cargo test --locked --no-fail-fast` in `swap-cli`, and `node --test "ui/app/test/*.test.js"` for the
   operator console (Node 22, no package manager).
7. Prints the sha256 of the program, writes it to a `.sha256` file and to the job summary, and uploads the program, the
   `.sha256` file and a `BUILD-INFO.txt` (commit, chain source commit, compiler version, test results) as the artifact
   `swap-cli-windows-x86_64`, `swap-cli-macos-aarch64` or `swap-cli-linux-x86_64`.

A fourth job runs the Ethereum side's tests (`npm ci`, `npx hardhat test` in `eth`) on Linux only. It takes about nine
minutes.

On Windows the two test steps are allowed to fail without failing the job, because they have never been run there. The
build step is never allowed to fail. Once a run shows the Windows tests passing, the flag `tests_may_fail` in the file
must be set to `false`. `BUILD-INFO.txt` records the real test result either way.

There is no cache in this first version. It is simpler, and there is nothing that could be poisoned.

## Check a downloaded program

A sha256 is a fingerprint of a file: the same bytes always give the same fingerprint, and a changed byte gives a
different one. To check a program, download the artifact from the workflow run, then compare the fingerprint of the
program with the one printed in the run's log (the step "Collect the program and print its sha256") or shown in its job
summary. Read the run's log on GitHub itself, not a copy somebody sent you.

```sh
# Linux (the .sha256 file sits beside the program)
sha256sum -c swap-cli.sha256
# macOS
shasum -a 256 -c swap-cli.sha256
```

```powershell
# Windows (compare the output by eye with the printed value)
Get-FileHash -Algorithm SHA256 .\swap-cli.exe
```

The artifact is a zip file. It does not keep the executable flag, so on macOS and Linux run `chmod +x swap-cli` after
unpacking. On macOS the program is not signed or notarized: the system may block it until you allow it. `BUILD-INFO.txt`
names the commit the program was built from: check that it is the commit you read.

What this proves and what it does not: it shows that the program in your hands is the one GitHub's machine built from that
commit, using the chain's source at the fixed commit (the workflow proves that the copy in the repository equals upstream there). It does not show that the source is free of mistakes, and it trusts
GitHub's machines and the toolchain they download. A program you build yourself on your own machine can differ in its bytes
(paths, compiler build); byte-for-byte reproducibility has not been tested.

## What is not built

- The zkVM prover and its proofs (`equiv/`). The proof-free lock kind (`poseidon`) needs neither a proof nor a receipt, so
  nothing here builds the guest, the host or the receipts. The `sha256` lock kind needs them and is outside this workflow.
- An installer, a signed or notarized program, a package for any system.
- The chain's own node and wallet (`vendor/parano1d` is built only as far as `swap-cli` depends on it).
- Bitcoin tests (`btc/`) and the Rust harness (`parano1d/harness`) are not run separately. The harness is compiled as a
  dependency of `swap-cli`.

## Not verified

- **The workflow itself has not run.** Its syntax, the native tool installation on each runner (CMake, libclang, paths
  marked as guesses in the file) and the comparison step on a Windows runner are all untested.
- **The comparison of `vendor/parano1d` with upstream has never run.** Until it passes, "the shipped copy equals upstream
  at that commit" is a claim the workflow is written to test, not a result. Differences in line endings or in files the
  copy leaves out would make it fail, by design.
- **The native Windows build of `swap-cli`** has never been made. It was built inside WSL, and natively on macOS for one
  role. The first Windows run is the first test of it.
- **The native Windows tests.** The dev-dependency on the chain's `noid_chain` crate pulls in libmdbx, a C library built
  with bindgen. It has not been built on Windows here.
- The three actions (checkout, setup-node, upload-artifact) are pinned to full commit ids, looked up on 2026-11-17; that
  each id is the release its comment names was not checked a second way.
- The operator console's tests run on Windows on a developer machine; they have never run on a hosted runner.

### Code that only works on Unix, and what the tool does on Windows

These are the places in `swap-cli` that are compiled only on Unix, or that branch on the platform. The Windows column is what the
code does, read from the source and never run on Windows.

| Place | On Unix | On Windows |
|---|---|---|
| File permissions: the swap file, its atomic rewrite, the hashlock registry and its folder, the producers cache and the producer marker (`swapfile.rs`, `watch/producers.rs`, `producer_marker.rs`) | created with mode 600 (folder 700) | no mode is set: the file gets the access rights its folder gives it, so it may be readable by other accounts that can read that folder |
| Directory sync after a rename (`sync_dir` in `swapfile.rs`, called after a swap file save, an atomic write and a producer marker write) | the folder is synced, and a failed sync is an error | skipped: the file is synced, but the rename is not flushed by a folder sync, so a power cut right after a save could lose the rename |
| The per-machine hashlock registry's place (`machine_registry_path` in `swapfile.rs`) | `NOID_SWAP_HOME`, else `$HOME/.noid-swap/hashlocks.txt` | `NOID_SWAP_HOME`, else `%USERPROFILE%\.noid-swap\hashlocks.txt` when `HOME` is unset |
| The per-user lock record of the Ethereum helper (`eth/scripts/live.js`) | in the home the account database gives the user (`os.userInfo().homedir`); a run whose `HOME` differs, or under `sudo`, is refused | the same code runs; what Node reports as the account home on Windows, and whether the check against `USERPROFILE` behaves, have not been tested. The helper also skips its own directory sync on Windows |
| The default `curl` program of the `curl` transport (`watch/exec.rs`) | `curl` from `PATH` (inside WSL, the Windows `curl.exe`) | `curl` from `PATH`; Windows ships `curl.exe`, but this has not been run |
| Tests using `sh`, symlinks, file modes or stub scripts (`child_env.rs`, `swapfile.rs`, `reveal_sidecar.rs`, `producer_marker.rs`, `watch/exec.rs`, and in `tests/`: `equiv.rs`, `hostile_gaps.rs`, `eth_key.rs`, `producer_gate.rs`, `common/equiv_stub.rs`) | run | not compiled, so not run: the checks they make (modes, symlink handling, directory sync, the stub prover) have no Windows test |

So on Windows, until this is looked at: keep the swap file and the run folder in a folder only your own account can read, and
treat the lack of a folder sync as a reason not to pull the plug during a save. These are known limits, not fixed ones.

## Build by hand

The commands are the ones the workflow runs. All three platforms need Git, Rust 1.96.0 (through `rustup`), a C compiler,
CMake and libclang. Run the commands from the root of a checkout of this repository.

The chain's source is already in the checkout (`vendor/parano1d`); nothing is fetched to build. To check it yourself the way
the workflow does (any platform; on Windows use Git Bash, which comes with Git for Windows), clone upstream outside the
checkout and compare:

```sh
git -c core.autocrlf=false clone --filter=blob:none https://github.com/ignotusnemo/parano1d.git ../upstream-parano1d
git -C ../upstream-parano1d -c advice.detachedHead=false checkout d29b8016c3c120312814f52d7f8a8ffef5523b80
rm -rf ../upstream-parano1d/.git ../upstream-parano1d/research
diff -r -q --strip-trailing-cr ../upstream-parano1d vendor/parano1d && echo identical
```

Do not run `scripts/fetch-vendor.sh` on a checkout whose `vendor/parano1d` you want to keep: it deletes that folder and
replaces it with a full clone.

**Linux (Debian or Ubuntu)**

```sh
sudo apt-get update
sudo apt-get install -y --no-install-recommends build-essential clang libclang-dev cmake pkg-config
rustup toolchain install 1.96.0 --profile minimal
cd swap-cli
RUSTUP_TOOLCHAIN=1.96.0 cargo build --release --locked
RUSTUP_TOOLCHAIN=1.96.0 cargo test --locked --no-fail-fast
sha256sum target/release/swap-cli
```

**macOS**

```sh
xcode-select --install
brew install cmake llvm
export LIBCLANG_PATH="$(brew --prefix llvm)/lib"
rustup toolchain install 1.96.0 --profile minimal
cd swap-cli
RUSTUP_TOOLCHAIN=1.96.0 cargo build --release --locked
RUSTUP_TOOLCHAIN=1.96.0 cargo test --locked --no-fail-fast
shasum -a 256 target/release/swap-cli
```

**Windows (PowerShell)**

Install, once: Visual Studio Build Tools with the C++ workload, CMake, LLVM (for libclang) and Git for Windows.

```powershell
$env:LIBCLANG_PATH = "C:\Program Files\LLVM\bin"
$env:RUSTUP_TOOLCHAIN = "1.96.0"
rustup toolchain install 1.96.0 --profile minimal
cd swap-cli
cargo build --release --locked
cargo test --locked --no-fail-fast
Get-FileHash -Algorithm SHA256 .\target\release\swap-cli.exe
```

The operator console's tests (Node 22 or later, from the repository root):

```sh
node --test "ui/app/test/*.test.js"
```

The Ethereum side's tests:

```sh
cd eth
npm ci
npx hardhat test
```

`RUSTUP_TOOLCHAIN` matters: `swap-cli` has no toolchain file of its own, so without it `rustup` picks whatever default you
have. If a build stops with "couldn't find libclang", set `LIBCLANG_PATH` to the folder that holds the libclang library.
