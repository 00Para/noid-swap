# Building the swap tool

Short version: a GitHub workflow (`.github/workflows/build.yml`) builds `swap-cli` for Windows, macOS and Linux on
GitHub's own machines, runs the offline tests, prints the sha256 of each program and attaches the programs as build
artifacts. Since step 4.8 it also packs the desktop program (an installer for Windows x64 and a disk image for macOS Apple
Silicon, both unsigned) and starts each on a clean machine (see "The desktop program" below; that part has not run yet). The point is that you can get a program whose build you can read, instead of trusting one built on a private
machine.

**Status: the workflow ran three times (run 1 at the public commit `111f72d`, run 2 at `fed3c64`, run 3 at `cbb1bf5`).**
Run 3 was the first in which every job passed: the program was built, its tests and the console's tests passed and it was
uploaded on Windows, macOS and Linux, and the Ethereum tests passed. Since then the Windows test step is strict like the
others. What each run showed is below. Read "Not verified" before relying on it.

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
6. Installs `eth/`'s locked packages (`npm ci`) and compiles the contracts (`npx hardhat compile`, solc 0.8.24), runs the
   tests `cargo test --locked --no-fail-fast` in `swap-cli`, runs the two code-hash tests of `params.rs` again with their output
   shown and fails the job if either was skipped (they pass silently when no compiled contract exists; since step 4.8 one
   exists), then runs `node --test "ui/app/test/*.test.js"` for the operator console (Node 24; its server loads `ethers` from
   `eth/`).
7. Prints the sha256 of the program, writes it to a `.sha256` file and to the job summary, and uploads the program, the
   `.sha256` file and a `BUILD-INFO.txt` (commit, chain source commit, compiler version, test results) as the artifact
   `swap-cli-windows-x86_64`, `swap-cli-macos-aarch64` or `swap-cli-linux-x86_64`.

A fourth job runs the Ethereum side's tests (`npm ci`, `npx hardhat test` in `eth`) on Linux only. It takes about nine
minutes. Two more jobs, `desktop` and `desktop-startup`, follow them (next section).

Every step is strict on every system. Until run 3 the Windows `swap-cli` test step was allowed to fail without failing the
job, because those tests had never been run there; run 3 showed them passing, and the flag `tests_may_fail` in the file is
now `false` for Windows too. `BUILD-INFO.txt` records the test result.

Sixteen console tests need a Windows host: they set the console up for helpers inside WSL and read real folders that the
console sees as `C:\...` and the helpers as `/mnt/c/...`. On Linux and macOS they are skipped with that reason
(`WSL_HOST_ONLY` in `ui/app/test/actions-fixtures.js`); they run in the Windows job.

## Run 1

- The comparison of `vendor/parano1d` with upstream at the fixed commit **passed** on Linux and on Windows.
- The native tools were found or installed on Windows as the workflow guessed (LLVM, CMake).
- **`swap-cli` built natively on Windows** (the first native Windows build) and on Linux. The Linux tests of `swap-cli`
  passed.
- macOS did not run: GitHub had no Apple Silicon machine free ("not acquired by a runner even after multiple attempts").
- The console's tests failed on Linux, for two reasons, both fixed: `eth/`'s packages were not installed before them; and
  the sixteen Windows-host tests above ran on Linux. Under Node 22 the test runner also ended eight relay tests early (the
  relay pool's timers do not hold the process open; in the console the HTTP server does), so the workflow uses Node 24.
- The Ethereum tests had two failures on Linux, in `bounded-send.js` (the claim's time-bounded send), cases 5 and 21c:
  at the deadline the test relay saw a plain end of the connection instead of a reset. Linux reports a reset that arrives
  while unread data waits as an end of stream once that data is read. The checks that prove the reset (the relay received
  less than the whole request, and not one byte more later; a graceful close would have delivered the rest) passed. On
  Linux those two cases now accept either report; everywhere else, and in cases 6, 20, 20b and 21d on every system, a
  reset is still required to be seen as one.
- On Windows the `swap-cli` tests **failed** (cargo's exit code 101, after 51 minutes, so they compiled and ran) and the
  console's tests failed (the same two causes as on Linux). Both steps were allowed to fail, so the Windows program was
  built and uploaded. Which `swap-cli` tests fail on Windows is not known: a run's log can be read only when logged in.
  The workflow now writes the names of failing tests and the first lines of each failure as annotations of the run, which
  anyone can read (`https://api.github.com/repos/00Para/noid-swap/check-runs/<job id>/annotations`).
- Not verified either way: whether the Windows program runs at all. It was built; nothing more.

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

## Run 2

- Linux and **macOS** (its first run): `swap-cli` built, its tests and the console's tests passed, the program was uploaded.
  The macOS native tool step worked as written.
- The Ethereum tests passed on Linux.
- Windows: `swap-cli` built again. Its tests still failed, and this time the annotations named them: every failure was a
  test that gives `new-bob` a stand-in for the prover, which was a shell script, and Windows cannot run one ("not a valid
  Win32 application"). The stand-in is now a `.cmd` file on Windows with the same output. Three console tests failed on
  the hosted Windows machine only: its temp folder is a short name with `~` (`RUNNER~1`), which the console rightly cannot
  pass to a helper as a plain path; the tests now make their folders under the long form of that path. The console step is
  strict, so the job failed and the Windows program of run 2 was not uploaded.

## Run 3

- **Every job passed**, the first run to do so. On Windows the `swap-cli` tests passed (47 minutes), with the prover
  stand-in as a `.cmd` file; so did the console's tests, with their folders under the long form of the temp path. The
  step that names failing tests did not run (nothing failed), and the run's only annotation is GitHub's notice that the
  three pinned actions are built for Node 20 and were run on Node 24.
- Linux and macOS built and tested again; the Ethereum tests passed on Linux.
- The three programs were uploaded. A downloaded program is checked against the sha256 printed in its job (see "Check a
  downloaded program"); the digest GitHub lists for each artifact is that of the zip archive, not of the program.
- After this run the Windows test step was made strict (`tests_may_fail: false`).

## The desktop program (step 4.8; written, not run yet)

Written 2026-11-18 from the build specification and tested offline only (`node --test "desktop/test/*.test.js"`). **No hosted run
has executed these two jobs.** The first run will show what the notes under "Not verified" could not.

Two jobs, each on Windows (`windows-latest`, x64) and macOS (`macos-14`, Apple Silicon). Nothing is signed, notarized or
published: the jobs use no secret and upload build artifacts only; the build-provenance step is the one place with write
permissions (`id-token`, `attestations`, on that job only).

**`desktop`** (needs the `swap-cli` and `eth` jobs, so nothing is packed from a commit whose tests failed). In order:

1. Checks out, sets up Node 24, installs `eth/`'s locked packages, compiles the contracts.
2. Runs `node --test "desktop/test/*.test.js"` (strict).
3. Downloads this run's `swap-cli` artifact (program, `.sha256`, `BUILD-INFO.txt`).
4. `make-runtime-lock.js --check`: `desktop/runtime/package-lock.json` is exactly what `eth/package-lock.json` gives for `ethers` 6.17.0
   (same versions, same `resolved` addresses and `integrity` hashes; made offline).
5. `codehash-check.js`: keccak256 of each compiled contract equals the constant compiled into `swap-cli/src/params.rs` of the same
   commit; the poseidon constant is the recorded `f510d2a3...3ff3`; `BUILD-INFO.txt` names this commit.
6. Installs the build tools (`npm ci --ignore-scripts` in `desktop/`; see the lock note below).
7. `stage.js stage`: lays the program out in `desktop/stage/` (the layout mirrors the repository, so `live.js` and the console find
   their files unchanged): the desktop modules, the console without tests, `live.js` and every local file it requires, the two
   compiled contracts, the three Rust files `poseidon2b.js` reads, and `swap-cli` (checked against its `.sha256` file) beside it.
8. `npm ci --omit=dev --ignore-scripts` in `stage/eth`, then `stage.js check`: `ethers` resolves for `live.js` and for the console, and
   exactly the locked packages are installed. The code-hash check runs again on the staged copy.
9. Packs twice with `electron-builder` (`--publish never`). Pass 1 only unpacks; `stage.js manifest` then hashes every file under
   `app.asar.unpacked/` and `bin/` of what the builder really placed and writes `runtime-manifest.json`; pass 2 stores it inside
   `app.asar` and makes the installer. (Two passes, because the builder may leave out files such as READMEs or type files, and the
   manifest must list what is really there.)
10. Checks the packed program: `stage.js verify-packed` (the unpacked files equal the manifest, and the manifest inside `app.asar` is
    the one written), the code-hash check on the unpacked contracts, and `fuses-check.js` on the program's binary.
11. Writes `SHA256SUMS.txt` and `DESKTOP-BUILD-INFO.txt`, attests the installer's build provenance, and uploads the artifact
    `desktop-windows-x86_64` or `desktop-macos-aarch64` (installer, sha256 file, build info, manifest).

**`desktop-startup`** (needs `desktop`; a fresh machine of each kind): checks the installer against its sha256 file; installs it
(Windows: `/S`, per user, to `%LOCALAPPDATA%\Programs\No1d Swap`; macOS: attaches the disk image and copies the app); starts the
program with `--self-test` (a hidden window on a temporary data folder, no vault, nothing can act) and requires its JSON line
(`startup-check.js selftest`: page loaded, no Parano1d node, 401 without the token, hardened web preferences, exit code 0);
reads the fuses of the installed binary; checks the installed files against the manifest; runs offline `live.js` commands (an
address from a key on the stdin pipe, a message signature, a verification, a `keygen --stdout` piped back in) once under the
program's own binary with `ELECTRON_RUN_AS_NODE=1` and once under Node 24 and requires equal answers; on Windows plants
`%LOCALAPPDATA%\No1d Swap\runs\x\run.json`, runs the uninstaller and requires that the program is gone and the planted file is not.

Fuses required (`fuses-check.js` reads the fuse wire out of the binary itself, no package): RunAsNode on, EnableCookieEncryption
on, EnableNodeOptionsEnvironmentVariable off, EnableNodeCliInspectArguments off, EnableEmbeddedAsarIntegrityValidation on,
OnlyLoadAppFromAsar on, LoadBrowserProcessSpecificV8Snapshot off, GrantFileProtocolExtraPrivileges off.

Download names: `No1d-Swap-<version>-win-x64.exe` and `No1d-Swap-<version>-mac-arm64.dmg`. To check one: compare its sha256 with
`SHA256SUMS.txt` (and with the value in the run's job summary), and verify the provenance with
`gh attestation verify <installer> --repo <owner>/<repo>`. The programs are not signed: Windows shows "Windows protected your PC"
(More info, Run anyway); macOS refuses to open it until Privacy and Security, "Open Anyway". The asar integrity fuse and the runtime
manifest are damage checks, not a defence against a program running as the same user.

**`desktop/package-lock.json` is not committed.** Nothing could make it without the network, so until it exists the job runs
`npm install --ignore-scripts` on the exactly pinned build tools (their own dependencies are not locked), warns, and uploads the
lock it made as the artifact `desktop-lock-<platform>`. Commit that file (either one); from then on the job runs `npm ci`.

**The runtime lock** (`desktop/runtime/package-lock.json`) is made offline by `node desktop/scripts/make-runtime-lock.js` from
`eth/package-lock.json`; after any change of `eth/package-lock.json` run it again and commit the result (the job and a test check it).

## What is not built

- The zkVM prover and its proofs (`equiv/`). The proof-free lock kind (`poseidon`) needs neither a proof nor a receipt, so
  nothing here builds the guest, the host or the receipts. The `sha256` lock kind needs them and is outside this workflow.
- A signed or notarized program, and a package for Linux. The desktop program has a Windows x64 installer and a macOS Apple
  Silicon disk image only (Electron's key store on Linux may fall back to basic text, which the program refuses).
- The chain's own node and wallet (`vendor/parano1d` is built only as far as `swap-cli` depends on it).
- Bitcoin tests (`btc/`) and the Rust harness (`parano1d/harness`) are not run separately. The harness is compiled as a
  dependency of `swap-cli`.

## Not verified

- **The native Windows program has not been run against a node or a chain.** It was built (runs 1 to 3) and its offline
  tests pass on Windows (run 3); nothing more. The tests that need `sh`, symlinks, file modes or a folder sync do not run
  there (see the table below).
- The three actions (checkout, setup-node, upload-artifact) are pinned to full commit ids, looked up on 2026-11-17; that
  each id is the release its comment names was not checked a second way.
- The two actions added with the desktop jobs were looked up on 2026-11-18 through GitHub's public API: the tag `v4.3.0` of
  `actions/download-artifact` is commit `d3f86a106a0bac45b974a628896c90dbdf5c8093` and the tag `v4.2.2` of `actions/attest-build-provenance`
  is commit `4d101475d8b20a2381f78447822ac1eab6504dd8`, the ids pinned in the workflow.
- Each platform's desktop jobs go ahead on their own (since run 4): a swap-cli job of another platform that failed or never got a
  machine no longer holds them back. Run 4's macOS swap-cli job was never given a machine ("not acquired", GitHub's capacity), and the
  desktop jobs of both platforms were skipped because of it.
- Run 5 was the first to start a desktop job. macOS again had no machine. On Windows the step "Test the desktop program's modules
  and scripts" failed, after `eth/`'s packages were installed and the contracts compiled; no installer was made, and the start-up job
  stopped at its download. Which test failed is not known: the step did not write annotations then, and the log needs a login. It
  now writes them, as the swap-cli job does. Six runs of the suite at once on one machine made two self-test tests fail. They
  compared every `no1d-selftest-` folder in the shared temporary folder, and another run's folder was there. Those tests now check
  only their own folder, and the self-test's removal of its folder tries again if a scanner briefly holds a file. That this was
  run 5's cause is not proved.
- Run 6 (`356d595`) named the failure in its annotation: one test, `stage.test.js` "command line: stage, check, manifest and
  verify-packed". It expects `stage.js manifest` without `--commit` to fail, but on GitHub's machines `GITHUB_SHA` is set, and the
  script takes the commit from it, as written. The test now runs the script without `GITHUB_SHA`, and it checks a good and a bad
  `GITHUB_SHA` as well. Run 5 most likely failed on the same test, which it had too. The whole desktop suite passes here with
  GitHub's usual build variables set. macOS again had no machine.
- A scheduled run once a day at 03:17 UTC, a quiet hour, gives the Mac program a hosted build without anyone starting one. GitHub
  gave the macOS jobs a machine in runs 2 and 3 and none in runs 4 to 6 ("not acquired", its capacity).
- The two desktop jobs (above) have not run to the end. Only a hosted run can show: that `electron-builder` 26.18.0 accepts
  `electron-builder.yml` (the `electronFuses` keys, `publish: null`); that the packed tree matches the manifest; that the fuses are
  flipped as asked and the asar integrity check passes; that the contracts compile to the recorded code hashes on every system; that the
  program starts on a clean machine; that the Windows binary (a GUI-subsystem program) shows its output to `Start-Process` redirection
  and passes its stdin and stdout pipes under `ELECTRON_RUN_AS_NODE`; that the macOS app starts after the fuses change (the builder is
  expected to reset the ad-hoc signature on arm64; if the app is killed at start, add an ad-hoc `codesign` step); and that the
  uninstaller behaves as written.

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
| Tests using `sh`, symlinks, file modes or stub scripts (`child_env.rs`, `swapfile.rs`, `reveal_sidecar.rs`, `producer_marker.rs`, `watch/exec.rs`, and in `tests/`: `equiv.rs`, `hostile_gaps.rs`, `eth_key.rs`, `producer_gate.rs`; the prover stand-in in `common/equiv_stub.rs` is a `.cmd` file on Windows since run 2) | run | not compiled, so not run: the checks they make (modes, symlink handling, directory sync, the stub prover) have no Windows test |

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

The operator console's tests (Node 24, from the repository root, after `npm ci` in `eth`):

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
