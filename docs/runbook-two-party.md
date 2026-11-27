# Runbook: a two-party NOID <-> ETH swap, with today's tools

For Alice (holds NOID) and Bob (holds ETH) on two different machines. Flags follow `swap-cli/README.md`
and the usage text in `swap-cli/src/main.rs`, `eth/scripts/live.js`, and `equiv/README.md`. What really happened
is in `docs/live-run-1.md` and `docs/live-run-2.md` and is quoted where it helps. No swap between two separate
people has ever run: both live runs were the owner playing both roles on one PC. Read this once fully before
typing anything. Every command that spends is a go-ahead you give yourself.

## 1. Who does what, and the rules

- **Alice** holds NOID and **makes the secret** (32 random bytes `s`). The hashlock is `H = SHA-256(s)`.
  She locks NOID in a Parano1d contract (`HashTimeLock`) that only `Addr(s)` can close, and only to Bob.
- **Bob** holds ETH. Once Alice's NOID is locked and final, he locks ETH in the Ethereum contract (`HTLC.sol`)
  under the same `H`, payable to Alice.
- **The reveal.** Alice takes her ETH by publishing `s` on Ethereum. That is the only moment `s` becomes public.
  Parano1d can never be the reveal side: a NOID close is a zero-knowledge proof and does not show `s`.
  Bob reads `s` on Ethereum and closes the NOID contract to himself.
- **The receipt (a proof file).** Before Bob locks anything, Alice gives him a proof that the same `s` is behind
  `H` (Ethereum side) and `A = Addr(s)` (Parano1d side). Without it Alice could lock NOID under a different secret
  and Bob's ETH would be stuck. Alice proves; Bob only verifies.
- **Two timeouts.** Parano1d `D` (a block height, `h_create + 738` blocks, about 6 h): from `D` on, Alice can take
  her NOID back. Ethereum `T_reveal` (a time, Bob's lock time + 7,200 s): from `T_reveal` on, Bob can take his ETH
  back. Alice must reveal at least 1,800 s before `T_reveal`, or Bob could refund the ETH and still claim the
  NOID. Bob must lock by Parano1d height `D - 631` and have his NOID claim final before `D` (target `D - 19`, hard
  limit `D - 1`). Miss your window and the other side keeps your money.
- **Real money.** Parano1d has no test network: every NOID amount is mainnet. The ETH side runs on Sepolia or a
  Hardhat chain by default; `live.js` refuses Ethereum mainnet unless the command carries `--mainnet` together with
  `--max-fee-gwei N`, and under `--mainnet` `lock`, `claim` and `refund` also need `--swap FILE` (a chain-1 `production`
  swap file). See `eth/README.md` ("Mainnet") and `docs/live-run-mainnet-plan.md`. Use amounts you can lose until the external review (M4).

The five hard rules (`PROJECT.md`):
1. Never fund `parano1d/contracts/htlc.params.example.json`: its secret is the public test vector `00 01 ... 1f`.
2. Never use Parano1d's `refundable_payment` template: once the secret is public anyone takes the funds. Only the
   custom `HashTimeLock` with the claim recipient pinned to Bob (what `alice-params` writes).
3. Fresh secret per swap from the OS random generator (`new-alice` does it). Stock-wallet variant: a throwaway
   wallet per swap. Never print the secret, never put it on a command line, never list processes with their
   arguments while a proof runs (run 1 leaked 20 of 32 bytes that way).
4. No swap window may straddle Parano1d height 279,370 (v2.1 activation). The chain is already past it (about
   281,000 on 2026-11-04) and the tools still check it.
5. `max_fee` at least 5,800 uNOID or claim and refund are both locked forever. `new-alice` sets
   `max(50,000, 3 x fee estimate)`; the 1 % rule means at least 5 NOID per swap.

## 2. Machine setup

### Alice (Windows + WSL2, as today)
- Parano1d wallet app running and synced; its node answers on `http://127.0.0.1:9601`. The tool is
  `C:\Parano1d\bin\parano1d-cli.exe` (`parano1d-cli` below). The wallet's **active address must be the `--alice`
  address** (it funds the contract and must be the active one to refund).
- WSL Ubuntu: Rust, `swap-cli` and `equiv-prove` built, RISC Zero `rzup`/`r0vm` 3.0.x, a VM with 3 GB or more (the
  proof peaks near 2.8 GB). WSL cannot reach the Windows loopback over TCP, so WSL commands use `--transport curl`
  (it uses `/mnt/c/Windows/System32/curl.exe`).
- Windows with Node >= 21: `cd eth && npm install && npx hardhat compile`. Alice's Ethereum key:
  `node scripts/live.js keygen --out keys/alice.key` (prints only the address; never share the file).
- In the WSL shell: `export SWAP_PASSPHRASE='a long passphrase'` (12+ characters; it seals the secret inside her
  swap file; never on the command line) and `BIN=$HOME/noid-target/release/swap-cli`.

### Bob (Mac, Apple silicon) - every step here is untested on macOS
1. Tools: Xcode command line tools (`xcode-select --install`), Homebrew `cmake pkg-config llvm`, Git, Node >= 21
   (the vendor build notes ask for a C/C++ compiler, CMake, libclang, Git).
2. Rust: `curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh`. The vendored code pins Rust 1.96.0; if
   the default toolchain fails to build, `rustup toolchain install 1.96.0` and `export RUSTUP_TOOLCHAIN=1.96.0`.
3. Clone the repo at exactly the commit Alice names (compare `git rev-parse HEAD`), with `vendor/parano1d` present
   (the `swap-cli` build reaches it by path). Never edit `vendor/`.
4. Build: `cd swap-cli && cargo build --release` and `cd equiv/zkvm && cargo build --release -p equiv-host` (the
   binary is called `equiv-prove`). Then `BIN=<repo>/swap-cli/target/release/swap-cli` (or your target dir).
5. RISC Zero, verifier side only: `curl -L https://risczero.com/install | bash`, then `rzup install`; `r0vm --version`
   should say 3.0.x. You still need it because building `equiv-prove` compiles the proof program, and its **image id**
   (the fingerprint of that program) is what the tool compares against (it is compiled into `swap-cli`, REVIEW-3 F2). Bob never runs `prove`, only `equiv-prove verify`. Print your
   build's id with `cd equiv/zkvm && cargo run --release -p equiv-host -- image-id`. Alice's local-build id on
   2026-11-04 was `7e9d8477...6187`, and that is the id compiled into `swap-cli` until the reproducible build exists. Tested 2026-11-06: a second
   machine's local build gives a **different** id, because the proof program carries paths under the builder's home
   folder (`docs/mac-setup.md` 3.4). So for the `sha256` lock kind `new-bob` refuses on a second machine (fail closed,
   nothing is lost) until the reproducible docker build (`EQUIV_REPRODUCIBLE=1`, M1.1) exists. The `poseidon` lock kind
   needs no proof and no `equiv-prove` on Bob's side, so this whole step can be skipped for it.
6. Bob's **own** Parano1d node, and a second one if he can: since 2026-11-04 `swap-cli` takes `--noid-rpc` and `--eth-rpc` twice and
   requires the two nodes to agree before `lock_eth` and `reveal_eth`; under `production` and `sepolia` a single node is refused unless
   `--single-node-ok` (a stranger's swap on Sepolia has real value on the NOID side), under `rehearsal` it is accepted with a note. The two
   endpoints must differ: the same URL twice (any spelling, any path or key) is refused, another port on the same machine is accepted with a
   note (it shares the first node's network view), so take the second node from another operator. Every Parano1d node must answer
   `paranoid_getBlockHeader`: without a header time the tool holds every NOID-side spend. A pending close the first node shows but the
   second does not no longer stalls Bob's claim. Plain `http://` is accepted only to loopback
   (`--allow-plain-http` otherwise). Do not use Alice's node, and do not rely on one remote node: `swap-cli/REVIEW-2.md` F5
   (single-source trust) says a lagging or lying node is not detected. The two-node path has run live once, in run 12
   (`docs/live-run-12.md`): each machine's own node plus the other's through one SSH tunnel (`docs/mac-setup.md` section 6), and two
   Sepolia endpoints per side; both machines were on one private network. Download from the release page named in
   `vendor/parano1d/docs/getting-started/core.md` (`parano1d-core-vVERSION-macos-aarch64.tar.gz`, v2.1.0 or later)
   or take the wallet app (`parano1d-gui-vVERSION-macos-aarch64.dmg`, `getting-started/wallet.md`). Check the
   download against `SHA256SUMS` with `shasum -a 256`. Core: `./parano1d --check-hardware` must end with
   `NODE READY`, then `./parano1d`, and wait until `./parano1d-cli status` shows the current chain tip. The wallet
   app runs the same node; either way RPC is `http://127.0.0.1:9601` on loopback, and that is what `swap-cli`
   talks to. Run only one of them at a time (one port). macOS may block an unsigned app: Control-click, Open.
   Disk and RAM planning: `vendor/parano1d/docs/operate/hardware.md`.
7. Bob's NOID receiving address: create or read one (`parano1d-cli address --list`); this `o1...` is `--bob`.
8. Bob's Ethereum access: his own node is best. A public RPC works for a first Sepolia run but is a single source
   (`eth/README.md` lists endpoints, none tested by us): `export ETH_RPC_URL=https://...` for `live.js`. `swap-cli`
   reads https only with `--transport curl` (macOS ships `curl`; use it for both chains), or run
   `node scripts/rpc-proxy.js --listen 127.0.0.1:8546 --upstream <https url>` and give `swap-cli` the loopback URL.
   Public RPCs cap `eth_getLogs` at 50,000 blocks, so give `--eth-from-block N` (any block before your swap's lock; `scripts/live/setup.sh` writes a recent finalized block at setup, and public endpoints prune old logs, so the contract's deployment block can fail with `pruned history unavailable`) once, on the first `tick --apply`: it is stored in the swap file and every later command reuses it (a live node on a public chain is refused without it). Bob's key:
   `node scripts/live.js keygen --out keys/bob.key`. Check the endpoint: `node scripts/live.js balance 0xADDR` must
   print the chain id you expect.

## 3. The exchange (before any money moves)

Agree in writing: NOID amount (uNOID, at least 5 NOID), ETH amount (wei), profile (`production`, `rehearsal` or `sepolia`),
chain and chain id, Alice's `o1` (the wallet address that will fund and refund), Bob's `o1`, Alice's Ethereum
address (receiver), Bob's Ethereum address (sender). Both Ethereum addresses must be ordinary wallets, not contracts.

**Bob sends Alice (public):**
1. The HTLC contract, which Bob deploys himself:
   ```sh
   cd eth && node scripts/live.js deploy --key-file keys/bob.key --dry-run
   node scripts/live.js deploy --key-file keys/bob.key
   ```
   Keep `contract`, `chainId`, `blockNumber`; check `"matchesArtifact": true`. Send Alice the contract address and the
   chain id. Nobody types a code hash (REVIEW-3 F1): the keccak-256 of the HTLC's code is compiled into `swap-cli`
   (`0xa906117f...45e2f`, the build of `eth/contracts/HTLC.sol`) and `live.js` reads it from your own compiled artifact
   (`eth/artifacts`, `npx hardhat compile`). A contract with any other code is refused by both tools, so a hash sent by
   the other side, from a deploy output or anywhere else, changes nothing. If `matchesArtifact` is `false`, Alice must not
   proceed: it is another contract.
2. Alice can look at what is on chain herself: `node scripts/live.js status --contract 0xC --lock-id 0x<64 zeros>` prints
   `chainId` and `codeHash` (a zero lock id is untested); it must equal the constant above. This is informational: every
   spend re-checks it.
3. Bob's two addresses (`o1...` and Ethereum), and 0.01 ETH of gas for Alice:
   `node scripts/live.js send --key-file keys/bob.key --to 0xALICEETH --amount-wei 10000000000000000`

**Alice sends Bob (public; there is no secret in either file):**
```sh
# WSL. --h-create = current tip (parano1d-cli status) + 40: the proof takes 20-36 min; run 2 funded 22 blocks late, fine.
$BIN new-alice --out alice.swap.json --alice o1ALICE --bob o1BOB --amount 10000000 --fee-estimate 5800 \
   --h-create TIP_PLUS_40 --eth-contract 0xC --eth-chain-id 11155111 --eth-amount-wei 1000000000000000 \
   --eth-receiver 0xALICEETH --eth-sender 0xBOBETH > bundle.json
# the secret goes from her sealed file straight into the prover: never into the terminal, never into ps output
$BIN secret alice.swap.json | equiv-prove prove raw --secret-stdin alice.receipt        # 20-36 min
equiv-prove verify raw 0xH A_AS_O1 alice.receipt        # self-check: prints OK and "image id: ..." (H, A are in bundle.json)
```
`--fee-estimate` is `estimateFeeDetailed(1,1).fee_micronoid` (5800 today). `--eth-chain-id` is mandatory on both sides.
`--eth-code-hash` is optional on both sides (the hash is compiled into `swap-cli`) and only accepted when equal to it; any other
value is refused with nothing written, and a bundle or file that pins another contract is refused by `new-bob` and `load`. Send
Bob `bundle.json` and `alice.receipt` (public; the receipt is about 223 KB) **as files, not as pasted text**. `swap-cli bundle alice.swap.json` reprints the bundle.
`new-alice` printed (on stderr) a line `bundle check: <16 hex> (opening_hex <N> characters)`; the bundle carries the matching `bundle_check`, and Bob's `new-bob` verifies it before anything else and prints `bundle check: <16 hex> ok`. Compare the 16 digits on both machines. A bundle damaged in transit is refused with *the bundle was damaged in transit*, naming `opening_hex has N characters, the bundle says M` when the length differs: hand it over again as a file. A bundle made before this check existed needs `--allow-unchecked-bundle`.
`--contract-version 1|2` (default 1) picks the Parano1d program: 1 is today's `HashTimeLock`; 2 is `HashTimeLockV2`, where
every close pays exactly `max_fee` (no min-fee stall; `docs/htlc-v2-fixed-fee.md`). Both sides must pass the same value,
`new-bob` refuses a mismatch, and all live runs so far used version 1. For v2, `alice-params` prints the recovery-close
command with `--fee` set to `max_fee`; a `--fee 0` close would be rejected.

**Ethereum lock kind `poseidon` (no proof step).** If both sides prefer the Ethereum lock keyed on Parano1d's own address `A = Addr(s)`
(`docs/poseidon-leg.md`; raw variant only), there is **no equivalence proof, no receipt and no `equiv-prove`** on either machine. Bob deploys
`HTLCPoseidonV2` instead (`node scripts/live.js deploy --key-file keys/bob.key --contract-kind poseidon`; check `"matchesArtifact": true` and that
`codeHash` is `0xf510d2a3...3ff3`, the constant compiled into `swap-cli`), and both pass the kind:
```sh
$BIN new-alice --out alice.swap.json ... --eth-lock-kind poseidon > bundle.json         # Alice (no `secret | equiv-prove` step)
$BIN new-bob --bundle bundle.json --out bob.swap.json --bob o1BOB --amount 10000000 \
   --eth-chain-id 11155111 --eth-contract 0xC --eth-amount-wei 1000000000000000 \
   --eth-sender 0xBOBETH --eth-lock-kind poseidon                                        # Bob (no --receipt, no --equiv-prove)
```
`new-bob` refuses and writes nothing unless the bundle's Ethereum lock word equals the claim authority `A` of the NOID opening it rebuilds byte for byte,
the V2 code hash is the one pinned, and the **client R self-test passes on Bob's machine** (a throwaway authorization is proved and verified, a few seconds; Bob
needs client R because the stock wallet import cannot open a lock on `Addr(s)`). `swap-cli self-test bob.swap.json` re-runs it. Everything else in this
runbook is the same, with three differences to plan for: Alice's reveal costs about 0.5 M gas (517,084 on mainnet in run 8, 689,324 on Sepolia in runs 5 and 11; `live.js` sends it with a 1,000,000 limit, so her Ethereum address
must hold `1,000,000 × fee cap`: 0.02 ETH at 20 gwei, not the 0.01 ETH of "gas money" above for a sha256 swap); small swaps are uneconomic on L1 (the reveal fee is about
half of a 0.001 ETH leg at 1 gwei); and the helper scripts take `LOCK_KIND=poseidon` (`scripts/live/env.sh`, `prepare.sh` skips the proof and the receipt).

**Bob checks. This is the only moment he can say no. He types his own terms; nothing comes from the bundle (the first thing the tool does with it is its `bundle check`):**
```sh
$BIN new-bob --bundle bundle.json --out bob.swap.json --bob o1BOB --amount 10000000 \
   --eth-chain-id 11155111 --eth-contract 0xC --eth-amount-wei 1000000000000000 \
   --eth-sender 0xBOBETH --receipt alice.receipt --equiv-prove /path/to/equiv-prove
```
It refuses and writes nothing unless: `equiv-prove verify` exits 0 for the bundle's own `H` and `A`; the printed image
id equals the one compiled into `swap-cli` (the local build's `7e9d8477...6187` until the reproducible build, M1.1, is done; `--pinned-image-id` is optional and, if given, must equal it); the 699-byte opening is rebuilt byte for byte; your terms equal the bundle's; the profile matches;
and the (I5) window rule passes. Success prints `bundle checked: opening rebuilt byte-for-byte ...` and, with
`--receipt`, says the receipt was verified by this tool. `--receipt` and `--equiv-prove` are the only form: the typed fallback (`--equiv-h --equiv-a
--equiv-image-id`) is accepted under the rehearsal profile only and `new-bob` refuses it under production and sepolia (REVIEW-3 F2). Then read `swap-cli status
bob.swap.json`: `D`, the amount, your `o1` as recipient, `max_fee`. **Bob tells Alice "my checks passed".**

> **Do not fund before Bob says his checks passed.** Funding first only locks Alice's NOID for about 6 hours.

> **Then fund at once; do not wait for `h_create`.** Bob's lock-by is fixed at `h_create` + 50 (`sepolia` profile) and the funding needs 18 blocks to
> be final, so every block the funding comes earlier is a block more for Bob's lock. Funded about 30 blocks before `h_create` (runs 10, 11, 12), Bob had
> about 60 blocks when his lock was offered; funded 22 blocks after it (run 13), he had 6. The order is: Bob runs `new-bob`, the two `bundle check`
> lines are compared and Bob says OK; Alice runs `fund.sh` (dry run first); only then anything else. In a run driven from the operator console the
> console's own funding step opens only at `h_create`: fund with `fund.sh` from a terminal right after Bob's OK and mark the funding as done in the
> console.

## 4. The run, side by side

Each side polls every ~30 s in its own terminal. `--apply` records facts in the swap file and freezes the next
spending step (section 4, ledger); without it `tick` only reads. Alice (WSL) shown; Bob on the Mac uses the same
flags with `--transport curl` and his own node and RPC:
```sh
$BIN tick alice.swap.json --transport curl --noid-rpc http://127.0.0.1:9601 --eth-rpc $ETH_RPC_URL --eth-from-block N --apply
while true; do $BIN tick alice.swap.json --transport curl ... --apply > last-tick.json; sleep 30; done
```
Read four fields of the JSON: `action` (and its `reason`), `notes`, `intent`, `phase_after`. `tick` never sends
anything; it prints the one step due. Node URLs are shown only as `scheme://host:port`.

| # | Alice | Bob | Engine says |
|---|---|---|---|
| 1 | Checks the object, then funds (below). | `tick`. | Bob: `waiting for Alice's funding` |
| 2 | `tick` until funding is final (18 blocks, 8.5 min in run 1). | `tick`. | `funding not yet visible`, `waiting for funding finality` |
| 3 | `tick`. | At final: `lock_eth` with `t_reveal`, hashlock, receiver, `amount_wei`. He runs `scripts/live/lock.sh` (it takes them from his file). | Bob: `lock_eth`, then `lock not yet visible`, `waiting for the secret (or T_reveal)` |
| 4 | Sees Bob's lock; waits until Ethereum calls it `finalized`; then `reveal_eth` with the `lock_id`. | `tick`. | Alice: `reveal_eth`, only before `T_reveal - 1800 s` |
| 5 | Reveals (below). | `tick`. | Alice: `ETH claim pending`, `waiting for ETH claim finality`, `done: ETH received` |
| 6 | Idle. | Engine reads `s` from the `Claimed` log (`eth_preimage_seen`) and says `claim_noid`: dry run, then `--submit`. | Bob: `claim_noid`, `NOID claim pending`, `waiting for NOID claim finality`, `done: NOID received` |

**Step 1, Alice builds, checks and funds** (`parano1d-cli` on Windows; `alice-params` in WSL). Go only if: Bob said
OK, the check prints "object file OK", the wallet's active address is the `--alice` address.
```sh
$BIN alice-params alice.swap.json --definition-out swap.def.json
parano1d-cli contract create swap.def.json --out swap.object.json        # local: no fee, no broadcast
$BIN alice-params alice.swap.json --check-object swap.object.json        # must print "object file OK"; root = bundle's contract_root
parano1d-cli contract fund swap.object.json 10.000000                    # REAL NOID: the fund_amount_noid alice-params printed
parano1d-cli contract instances swap.object.json                         # after inclusion: "Slot <S> incarnation <C> ..."
parano1d-cli contract status swap.object.json <S>                        # "Opening matches State: true"
```
Keep `swap.object.json` and `alice.swap.json`: the opening cannot be recovered from the chain. Fund once; if the
answer was lost, run `contract instances` before funding again. Tell Bob the funding went out.

**Step 3, Bob locks ETH.** Send the lock through `scripts/live/lock.sh` (`lock.sh --dry-run`, then `lock.sh`): it runs a fresh read-only tick right before the
send and hands `live.js lock` the approval of that tick: three values from the tick's own output (`--approved-intent`, the `decided_at` of the intent it held; `--approved-terms`, the
SHA-256 of the lock's terms; `--approved-at`, the tick's own time). `live.js lock --swap FILE` refuses a real send when any is missing or different, or when the tick is older than 120 s, so
do not call `live.js lock` by hand against a swap file. The approval is not single-use: the duplicate rule, the lock lock `FILE.lock-lock`, the pending-nonce check, the lock record
`FILE.lock-sent` and the per-user lock record (one file per chain, sender and lock word in `.noid-swap/lock-sent/` of the account's home, the one the operating system gives the user that runs `live.js`, not the `HOME` (Linux, macOS) or `USERPROFILE` (Windows) of the environment, which is refused when it differs, as is a run under `sudo`) are meant to prevent a second send of the same lock while the first is unresolved, whatever the swap file is called (tested offline only). A lock without `--swap` meets the per-user record of an earlier lock and writes that record itself, by the same rules; it has no record beside a swap file, no approval, no lock lock and no pending-nonce check. Another machine or another user account has neither record: it has the duplicate rule, which reads mined locks only, and with a swap file the node-local pending-nonce check; send the lock from one machine and one account. See "Clearing a FILE.lock-sent record" below. A `FILE.lock-lock` that a killed process left behind is never taken over: when you are sure no lock is running, delete it by hand. The commands below are the form without a swap file (a hostile-counterparty test, a rehearsal
by hand), which makes no producer check and no fresh check; copy `--hashlock`, `--t-reveal`, `--receiver`, `--amount-wei` from the tick (from `eth/`):
```sh
node scripts/live.js lock --key-file keys/bob.key --contract 0xC --chain-id 11155111 \
   --hashlock 0xH --t-reveal T_REVEAL --receiver 0xALICEETH --amount-wei 1000000000000000 --dry-run
node scripts/live.js lock ...same flags, without --dry-run        # note lockId, blockNumber, blockTimestamp; tell Alice
```
`--t-reveal` must be the tick's value, not a fresh one: the lock id is derived from it, and Alice only accepts the
lock if `T_reveal` minus the lock block's time is at least 5,400 s.

**What the operator sees when the lock helper refuses (`scripts/live/lock.sh`).** A send first asks the engine again, with a fresh
read-only `tick`, whether Bob's lock is still wanted. If the producer screen now refuses (a share over the limit, data that cannot be
verified, a second node missing or differing, a remembered detection), or the tick fails or cannot be read, the helper prints
`lock REFUSED, nothing sent`, the tick's own reason, and exits 3; `live.js` is not run. `live.js lock` itself also refuses, before any
network read, when the swap file's history holds the alert latch `producer_alert_lock_pending:...` of this intent with no
`producer_concentration_overridden` entry after it, or a remembered detection (the marker file, or `producer_differs_seen`); with the
marker file but no detection entry yet it tells you to run `tick --apply` first. What to do: do not send; if nothing was sent, cancel the
intent (`swap-cli intent FILE --cancel`, same chain flags as `tick`); the ways on are `--accept-producer-concentration` on a `tick --apply`
(printed and recorded, trial amounts only) or a new swap file. Even after the screen passes again, a latch on record keeps `live.js lock`
refusing for that intent until you cancel the intent (the flag writes no override on a pass); while the screen still refuses, the flag does work. `live.js lock` without `--swap` makes no producer check and says so.

The fresh tick has a time limit (`LOCK_PRECHECK_TIMEOUT`, default 3 x `RPC_TIMEOUT` cut to 90 s; a larger value is refused, because `live.js` accepts the approval of a tick for 120 s only); one that does not finish is stopped and refuses the same way (exit 3, nothing sent). A swap file with more than one hard link is refused by `live.js` for `lock` and `claim` (keep one name).

**`ACCEPT_PRODUCER_CONCENTRATION=1` is a standing waiver.** It waives the refusal for the concentration you looked at and also a LATER finding that a node is misreporting the producers. Set it for one command only, on the command line, never as a line in `env.local.sh` (every call prints a warning while it is on).

**Clearing a FILE.lock-sent record.**

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

**Step 5, Alice reveals** (only when `tick` says `reveal_eth`; the dry run needs no secret):
```sh
cd eth && node scripts/live.js claim --key-file keys/alice.key --contract 0xC --lock-id 0xLOCKID \
   --chain-id 11155111 --dry-run
$BIN secret ../alice.swap.json | node scripts/live.js claim --key-file keys/alice.key --contract 0xC \
   --lock-id 0xLOCKID --chain-id 11155111 --secret-stdin
```
`live.js` itself refuses unless now <= `T_reveal - 1800 s`, the lock exists and is final, and `sha256(secret) == H`.
`--secret-stdin` must be a pipe; `swap-cli secret` alone prints the secret, so never run it bare. Untested: piping from
WSL's `swap-cli` into Windows Node; if it fails, run both ends in one place (Node installed in WSL).

**Right after every reveal that was sent, run `tick --apply`** (the watch loop does it on its next pass, so keep it running). `live.js claim --swap` writes `<swap file>.reveal-sent` just before it broadcasts, and `tick` (and `live.js`) read it as evidence that the secret may be public, so a claim that is sent and then leaves the pool before any tick saw it no longer leaves the file believing the reveal was only decided: a re-send past `T_reveal - 1800 s` is judged by the late cutoff `T_reveal - DE` (`swap-cli/README.md`, "Residual window"; `TASKS.md` T21-11). The sidecar exists only for a reveal sent by `live.js claim --swap` (`reveal.sh` does that); a reveal sent any other way still depends on a tick seeing it, so run the tick at once in every case. Leave the sidecar where it is. If `live.js` wrote one and the send then failed in a way that never left the machine, `swap-cli` still treats a re-send as a late one (`T_reveal - DE`), which also lets a first reveal go out that late: re-send with `live.js claim --swap FILE ... --margin-s 1800` run by hand (`reveal.sh` has no such flag) to keep the strict rule, or delete the sidecar before the next tick (after a tick the marker is in the file for good). Details: `swap-cli/README.md`, "Residual window".

**Step 6, Bob claims the NOID** (client R: needs only his node; proving takes about 3 s):
```sh
$BIN claim bob.swap.json --transport curl --noid-rpc http://127.0.0.1:9601 --eth-rpc $ETH_RPC_URL     # --eth-from-block comes from the file
#   dry run: txid, call_height, fee_micronoid (5800), amount_out_micronoid, recipient. The recipient MUST be Bob's o1.
$BIN claim bob.swap.json --transport curl --noid-rpc http://127.0.0.1:9601 --eth-rpc $ETH_RPC_URL --submit
```
**Re-sending a claim (T21-16).** A claim can leave the pool without being mined: a reorg took it out of the chain, or the node dropped it. The tick loop keeps offering `claim_noid` while the claim is not seen, and a removed claim also draws an `ALERT:` note. Re-send it (dry run, then `--submit`), **then check on the next tick that it is in the pool or included, and repeat if it is gone**: the Parano1d node does not re-admit orphaned transactions after a reorg and removes any copy of the same transaction already in its pool when it handles one, so a claim re-sent just before the node handles a reorg can vanish again. A claim or refund built near the end of a 144-block epoch can expire unconfirmed (its proof is bound to the epoch anchor) and must be built again; the tool waits out the last blocks before a boundary for this reason (design T6). Only a claim that is final before `D` is safe.
Keep running `tick --apply` until `done: NOID received` (about 18 blocks after inclusion, 7 min). "Included" is not
safe: a rollback can undo it until the tip is 18 blocks past the inclusion height (`is_final`: tip >= height + 18). Run 1: proved for call height 280,658, included at 280,659, final
at 280,676 by the rule the tool used then (the chain's rule makes it 280,677; the outcome did not change), Bob received 9,994,200 uNOID (10 NOID minus the 5,800 close fee). Check by Bob's `o1` balance.

**The intent ledger.** `tick --apply` writes each spending step (`fund_noid`, `lock_eth`, `reveal_eth`, `refund_eth`,
`refund_noid`) into the swap file before printing it, so it can never print the same step twice. Until the chain
shows the effect, tick answers: `intent <action> pending since <unix> (unix): the chain does not show it yet; reuse
the printed parameters, or swap-cli intent FILE --cancel (with the same chain flags as tick) if nothing was sent`.
```sh
$BIN intent bob.swap.json --show              # the frozen parameters (amounts, t_reveal, lock id ...)
$BIN intent bob.swap.json --cancel --transport curl --noid-rpc http://127.0.0.1:9601 --eth-rpc $ETH_RPC_URL
```
- The command ran, or you are not sure: wait and keep ticking. Sending it again is how you pay twice.
- The command failed before sending (typo, a refusal from `live.js`): repeat it with the **frozen** values, or
  `--cancel` so the engine decides afresh. `--cancel` refuses if the chain already shows the effect. `live.js`
  does not read the ledger itself (REVIEW-2 F3, second half still open): the discipline is yours.

## 5. When it goes wrong (abort paths)

- **Bob never locks.** Alice does nothing until `D`; at tip + 1 >= `D` her engine says `refund_noid`. Bob's engine
  stops offering `lock_eth` once the lock-by limit (`D - 631`, hard `D - 541`) has passed. Alice keeps `s` secret.
- **Alice never reveals (run 2).** At `T_reveal - 1800 s` Alice's engine switches to `wait` with the reason `reveal
  cutoff passed; keeping the secret and waiting for D` and will not reveal even if asked. At `T_reveal` Bob's engine
  goes from `locked` to `refund_eth` (run 2: about 80 s later, mostly the poll interval):
  ```sh
  node scripts/live.js refund --key-file keys/bob.key --contract 0xC --lock-id 0xLOCKID --chain-id 11155111
  ```
  Bob's next tick logs `eth_refund_mined` and says `done: ETH refunded`. Alice waits for `D` and recovers her NOID
  with the stock wallet; its *active* address must be the `--alice` address or the node refuses:
  ```sh
  parano1d-cli address --list ; parano1d-cli address --use INDEX_OF_ALICE_ADDRESS
  parano1d-cli contract call swap.object.json S C --close --preview
  #   check: "recovery": true, "terminal": true, "authority": <Alice>, "call_height" >= D, fee <= max_fee; note "txid"
  parano1d-cli contract call swap.object.json S C --close --expected-txid TXID --out refund.json     # refund.json must be new
  ```
  Do not do this before `D` (the preview then shows `"recovery": false`). If the node says the height changed between
  preview and submit, preview again. Alice keeps `s` secret until her refund is final.
- **Alice reveals, Bob goes offline.** Bob's loss: Alice keeps the ETH and refunds her NOID at `D`. Bob must be online
  between the reveal and `D - 19`.
- **The reveal cutoff.** Never reveal after `T_reveal - 1800 s`. Even a failed late `claim` publishes `s` in its data,
  and then Bob can refund the ETH and also claim the NOID. `live.js` refuses; do not use `--margin-s` to get around it.

## 6. Rehearsal first (about an hour, 20 NOID at most)

Do this once for each pair of machines before any `production` swap. The `rehearsal` profile uses the same rules with
short windows. It is still **real NOID** (caps: 20 NOID, 0.01 ETH, Ethereum chain 31337 only; anything else is
refused). Add `--profile rehearsal` to both `new-alice` and `new-bob`; the bundle carries it.

The `sepolia` profile is the same idea for a run whose Ethereum leg is on the public Sepolia testnet instead of a local
Hardhat chain (the local chain finalizes at once, Sepolia takes 13-19 min, so Alice needs a longer reveal window).
Same caps (20 NOID, 0.01 ETH) but Ethereum chain **11155111 only**. Use `--profile sepolia` on both `new-alice` and
`new-bob`, with `--eth-chain-id 11155111`; `eth/scripts/live.js claim`'s default `--margin-s` (1,800 s) already matches
the profile's reveal cutoff, so no extra flag is needed.

| item | production | rehearsal | sepolia |
|---|---|---|---|
| `D - h_create` | 738 blocks (about 6 h) | 122 blocks (about 1 h at 30 s) | 302 blocks (about 2 h 30 at 30 s) |
| Bob's lock-by (hard limit) | `D - 631` (`D - 541`) | `D - 69` (`D - 63`) | `D - 252` (`D - 210`) |
| `W_A` / reveal cutoff before `T_reveal` | 7,200 s / 1,800 s | 600 s / 300 s | 4,200 s / 1,800 s |
| Bob's claim target / hard limit | `D - 19` / `D - 1` | same | same |
| finality, close fee | 18 blocks, 5,800 uNOID | same | same |
| a full "Alice never reveals" cycle | 756 blocks to final (about 6 h 18) | 140 blocks to final (about 70 min) | 320 blocks to final (about 2 h 40) |

Measured on the real chain (design §9.3): funding included in 2 blocks and final 8.5 min later; claim proof 3 s; claim
included 1 block after submission and final 7 min later; the chain-bound part of run 1 was 22 min; the equivalence
proof 20-36 min (35 on a busy 3 GB VM); `P_auth` budget 20 s. Sepolia's Ethereum finality wait (about 13 min before
Alice may reveal) is what the `sepolia` profile is built for: the profile exists and is tested on the simulator
(a lock-finality lag of 1,140 s), and run 3 settled under it on 2026-11-04 (`docs/live-run-3.md`): 44 minutes of chain
time from funding to Bob's final NOID, of which Sepolia finality 18.9 min. The 2 h 30 `D` only matters if somebody does not show up.

Practical points (derived from the README table, not run):
- Both machines must reach the same Ethereum chain. Simplest: Bob hosts it, e.g.
  `cd eth && HARDHAT_INTERVAL_MINING_MS=12000 npx hardhat node --hostname 0.0.0.0 --port 8545` (run 1 used 12 s empty
  blocks on loopback); Alice then uses `--eth-rpc http://BOBHOST:8545`. Untested on macOS and
  across two machines; keep it on a private network or VPN. Fund both rehearsal addresses from one of Hardhat's
  prefunded accounts (run 1 did; the exact command is not in the log). A first alternative: one person plays both
  roles on one PC, as in runs 1 and 2.
- Set `--h-create` to the tip at the moment the proof should finish (about 2 blocks per minute of proof), not tip + 40.
  The window is only 122 blocks: funding must be final and Bob's lock in before `D - 63`, so fund within roughly 15
  minutes of Bob's OK. If the proof overran, discard the files and start over; a rehearsal costs only fees.
- Under `sepolia` the window is 302 blocks. Bob's lock-by is `D - 252` = `h_create + 50` with the full reveal window
  (`D - 210` = `h_create + 92` at the minimum window), and the funding must be final (18 blocks) before he locks, so fund
  within about 15 minutes of `h_create` (roughly 30 blocks) to keep the full window, 35 minutes at the latest. Alice may
  reveal only once Bob's Sepolia lock is finalized (13-19 min after it is mined) and not after `T_reveal - 1,800 s`.
- Run two: the happy path, then "Alice never reveals" (section 5). Epoch rotation is not covered by either profile
  (budget 0; with the `sepolia` window of 302 blocks a rotation will fall inside it, and a claim evicted at a rotation
  must be re-proved).

**Helpers.** `scripts/live/` holds the versioned helpers for a run on this machine (`install.sh`, `setup.sh`, `prepare.sh`,
`check-object.sh`, `tick.sh`, `watch.sh`, `lock.sh`, `reveal.sh`, `claim.sh`, `refund-eth.sh`; the step-by-step is in its
README). None of them sends anything without an explicit `--submit` or a missing `--dry-run`; `watch.sh` only observes
and records. Checked read-only on 2026-11-05 against the finished run-3 files: the ticks (single node, `--single-node-ok`,
stored from-block), the three `live.js --swap` wrappers (each refused for the right reason: no intent in a finished file)
and the object check all run from WSL, the swap file reaching Windows `node` through its `\wsl.localhost` path.

## 7. Checklists and troubleshooting

**Alice, before funding:** wallet synced, tip >= 279,388, active address = `--alice`, enough NOID (amount + about
9,000 uNOID fee), `SWAP_PASSPHRASE` set; `eth/artifacts` is compiled (`npx hardhat compile`; `live.js` takes its code hash from it, `swap-cli` has it built in) and the contract's code matches; the bundle holds no
secret; `alice.swap.json` and `swap.object.json` backed up; Bob said OK; `--check-object` printed "object file OK";
`tick` is running.

**Bob, before locking:** own node synced, tip agrees with the clock; `new-bob` printed `bundle checked` and used
`--receipt`; `D`, amount, recipient and `max_fee` read and agreed; chain id checked with `live.js balance`; enough ETH
for the lock and gas; `tick --apply` has said `lock_eth` (not before) and `live.js lock --swap` takes its `t_reveal` from the file; you can be
online from the reveal until `D - 19`.

**Bob, once before the first run with two Parano1d nodes (and again after either node's build changes):** a read-only `tick` against the two REAL nodes must show the producer cross-check agreeing with all the sampled heights: `"second":{"state":"agrees",...,"sampled":64}` in the `noid.producers` part of the JSON (or `names the same producer for 64 sampled heights` in the `producer concentration ok` note; a number below 64 is fine only when the two draws overlapped, never 0). Do it on a COPY of the swap file in a scratch folder (`mkdir scratch && cp bob.swap.json scratch/ && swap-cli tick scratch/bob.swap.json ...` with the same two `--noid-rpc` URLs, no `--apply`), never on the real file: the second node's `miner` strings are compared byte for byte with the first node's, so a difference in how two builds write the same address would be read as a node misreporting, and the tick that sees it writes the marker `<swap file>.producer-differs` (`docs/bob-concentration-gate.md` section 4), which then holds the screen closed for the rest of that swap file. On a copy, the marker and the header cache land in the scratch folder and the real file stays clean. The screen runs only while Bob's file is in the phase `received`, `funded` or `funding_final` (`producer_scan_wanted` in the engine); in any other phase, and for Alice's file, the tick reads no headers and shows no `producers` at all, so run the check with a copy made in one of those phases (a fresh `new-bob` file is in `received`). If the check shows `producer_differs`, `sampled_differs` or the refusal "an earlier tick saw the two Parano1d nodes ...": do not lock and do not override. Compare the two nodes by hand for the block at the height the refusal names (`paranoid_getBlockHeader`, the `miner` and `hash` fields of each); find the cause (a formatting difference between builds, a proxy or tunnel in front of a node, or a node that misreports). If it ever happens on the real file, the detection cannot be cleared for that swap file: once a `tick --apply` has written the history entry `producer_differs_seen` into the swap file, removing the marker `<swap file>.producer-differs` (or moving the swap file without it) does not reopen the screen. After finding the cause the two ways on are `--accept-producer-concentration` (printed as OVERRIDDEN on every tick and recorded in the history) or ending that swap (if no lock was sent there is nothing to refund) and starting a new one with a new swap file; delete the old header cache `<swap file>.producers` if the file name is reused (it may still hold what the misreporting node said). The check is about which blocks the nodes hold and who is named as their producer; it does not replace the rest of this checklist.

| Symptom | Meaning | Do |
|---|---|---|
| `tick` fails: connection error or `Transport` | node or RPC unreachable (in WSL: wrong transport) | Nothing was sent or decided. Check `parano1d-cli status`, `--transport curl`, the URL, the network. Do not act from memory. |
| action `wait`, reason `noid observation stale ...` or `eth observation stale ...` | the poll is older than 120 s | Tick again. If it persists, the node or the clock is wrong. There is no override. |
| reason `<field> unknown`, e.g. `noid.epoch_anchor unknown`, `eth.latest_timestamp unknown` | the node did not answer a field the gate needs | Fail closed: it will not spend. Retry; change node if it repeats. |
| `eth_getLogs` error naming a range, or `exceed maximum block range` | public RPC cap | Pass `--eth-from-block N` just before the lock or deploy block on one `tick --apply`; it is stored in the swap file. |
| `rpc error 4444: pruned history unavailable` (or `history has been pruned`) on every tick | the log start is older than the endpoint keeps (run 14) | Put a recent block in `$L/eth-deploy-block.txt` or pass `--eth-from-block N` on one `tick --apply`: before the lock, a few thousand below the head; after the lock, the lock's block number minus a margin (never a block after it). `setup.sh` already picks a recent finalized block; this happens only when the folder was set up long before the swap. |
| `intent <action> pending since ...` | a spending step is frozen and not yet seen on chain | See the ledger in section 4. Do not repeat blindly. |
| `new-bob` refuses | proof, image id, opening, terms, profile or window failed | Read the message (usually a wrong flag or a different image id). There is no typed fallback outside rehearsal; ask Alice to resend and compare. |
| `equiv-prove verify` fails, or its image id differs from the one compiled into `swap-cli` | receipt is not for this `H`/`A`, or a different build of the proof program | Do not lock. Recheck the build (section 2). There is no pin to edit: the id is a constant of the `swap-cli` build. |
| code hash or chain id mismatch (`live.js`: `code hash mismatch: --code-hash is ... but keccak256(code at ...) is ...; refusing`, or `--code-hash ... is not the code hash of this repo's compiled artifact`; `swap-cli`: `... is not the HTLC code hash compiled into this build`; `tick` just waits) | wrong contract, wrong chain, or a hash that is not this repo's build | Stop. The only accepted code hash is the one compiled into `swap-cli` and the artifact's; there is no override. Never spend. |
| reason `the instance is gone but no tracked transaction closed it; verify the contract receipts manually` | the NOID contract was closed by something the file did not record | Look at the receipts and Bob's balance. Do not claim again. |
| reason `a close by someone else is pending on the instance (...); it pays B_noid if valid` | someone holding `s` sent a minimum-fee close; it still pays Bob | Wait; the tool does not re-prove. If it never confirms it is evicted near `D` and Alice refunds (Q1, known risk). |
| reason `epoch anchor rotates in N block(s); proving after the boundary (T6)` | Parano1d's 144-block anchor changes soon | Wait N blocks; the claim is then built. |
| `claim` dry run fails (proof or `check_call`), or `--submit` reports "not sent" | build problem or node rejection | A rejected submit leaves a "not sent" record that the next run retries; a timeout leaves "outcome unknown" and the next run repeats it (the same close is harmless). Read the `claim` output first. |
| `done: ...` / `aborted: ...` | terminal | `aborted` gives its reason; funds follow the timeouts of section 5. |
| anything with real money you do not understand | - | Stop sending. Keep both swap files, the object file and the receipts. Ask. |
