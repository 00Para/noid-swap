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
- **Two timeouts.** Parano1d `D` (a block height, `h_create + 735` blocks, about 6 h): from `D` on, Alice can take
  her NOID back. Ethereum `T_reveal` (a time, Bob's lock time + 7,200 s): from `T_reveal` on, Bob can take his ETH
  back. Alice must reveal at least 1,800 s before `T_reveal`, or Bob could refund the ETH and still claim the
  NOID. Bob must lock by Parano1d height `D - 629` and have his NOID claim final before `D` (target `D - 18`, hard
  limit `D - 1`). Miss your window and the other side keeps your money.
- **Real money.** Parano1d has no test network: every NOID amount is mainnet. The ETH side runs on Sepolia or a
  Hardhat chain by default; `live.js` refuses Ethereum mainnet unless the command carries `--mainnet` together with
  `--max-fee-gwei N`, and under `--mainnet` `lock`, `claim` and `refund` also need `--swap FILE` (a chain-1 `production`
  swap file). See `eth/README.md` ("Mainnet") and `docs/live-run-4.md`. Use amounts you can lose until the external review (M4).

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
   2026-11-04 was `7e9d8477...6187`, and that is the id compiled into `swap-cli` until the reproducible build exists. Untested: that a Mac build gives the same id as Alice's WSL build. If it
   differs, `new-bob` refuses (fail closed) and nothing is lost; the fix is the reproducible docker build
   (`EQUIV_REPRODUCIBLE=1`), which does not exist yet (M1.1). Stop and tell Alice.
6. Bob's **own** Parano1d node, and a second one if he can: since 2026-11-04 `swap-cli` takes `--noid-rpc` and `--eth-rpc` twice and
   requires the two nodes to agree before `lock_eth` and `reveal_eth`; under `production` and `sepolia` a single node is refused unless
   `--single-node-ok` (a stranger's swap on Sepolia has real value on the NOID side), under `rehearsal` it is accepted with a note. The two
   endpoints must differ: the same URL twice (any spelling, any path or key) is refused, another port on the same machine is accepted with a
   note (it shares the first node's network view), so take the second node from another operator. Every Parano1d node must answer
   `paranoid_getBlockHeader`: without a header time the tool holds every NOID-side spend. A pending close the first node shows but the
   second does not no longer stalls Bob's claim. Plain `http://` is accepted only to loopback
   (`--allow-plain-http` otherwise). Do not use Alice's node, and do not rely on one remote node: `swap-cli/REVIEW-2.md` F5
   (single-source trust) says a lagging or lying node is not detected. Download from the release page named in
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
   Public RPCs cap `eth_getLogs` at 50,000 blocks, so give `--eth-from-block N` (the HTLC deployment block, or any block before your swap started) once, on the first `tick --apply`: it is stored in the swap file and every later command reuses it (a live node on a public chain is refused without it). Bob's key:
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
Bob `bundle.json` and `alice.receipt` (public; the receipt is about 223 KB). `swap-cli bundle alice.swap.json` reprints the bundle.
`--contract-version 1|2` (default 1) picks the Parano1d program: 1 is today's `HashTimeLock`; 2 is `HashTimeLockV2`, where
every close pays exactly `max_fee` (no min-fee stall; `docs/htlc-v2-fixed-fee.md`). Both sides must pass the same value,
`new-bob` refuses a mismatch, and all live runs so far used version 1. For v2, `alice-params` prints the recovery-close
command with `--fee` set to `max_fee`; a `--fee 0` close would be rejected.

**Bob checks. This is the only moment he can say no. He types his own terms; nothing comes from the bundle:**
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
| 3 | `tick`. | At final: `lock_eth` with `t_reveal`, hashlock, receiver, `amount_wei`. He runs `live.js lock` with exactly those. | Bob: `lock_eth`, then `lock not yet visible`, `waiting for the secret (or T_reveal)` |
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

**Step 3, Bob locks ETH** (from `eth/`; copy `--hashlock`, `--t-reveal`, `--receiver`, `--amount-wei` from the tick):
```sh
node scripts/live.js lock --key-file keys/bob.key --contract 0xC --chain-id 11155111 \
   --hashlock 0xH --t-reveal T_REVEAL --receiver 0xALICEETH --amount-wei 1000000000000000 --dry-run
node scripts/live.js lock ...same flags, without --dry-run        # note lockId, blockNumber, blockTimestamp; tell Alice
```
`--t-reveal` must be the tick's value, not a fresh one: the lock id is derived from it, and Alice only accepts the
lock if `T_reveal` minus the lock block's time is at least 5,400 s.

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

**Step 6, Bob claims the NOID** (client R: needs only his node; proving takes about 3 s):
```sh
$BIN claim bob.swap.json --transport curl --noid-rpc http://127.0.0.1:9601 --eth-rpc $ETH_RPC_URL     # --eth-from-block comes from the file
#   dry run: txid, call_height, fee_micronoid (5800), amount_out_micronoid, recipient. The recipient MUST be Bob's o1.
$BIN claim bob.swap.json --transport curl --noid-rpc http://127.0.0.1:9601 --eth-rpc $ETH_RPC_URL --submit
```
Keep running `tick --apply` until `done: NOID received` (about 18 blocks after inclusion, 7 min). "Included" is not
safe: a rollback of up to 17 blocks can undo it. Run 1: proved for call height 280,658, included at 280,659, final
at 280,676, Bob received 9,994,200 uNOID (10 NOID minus the 5,800 close fee). Check by Bob's `o1` balance.

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
  stops offering `lock_eth` once the lock-by limit (`D - 629`, hard `D - 539`) has passed. Alice keeps `s` secret.
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
  between the reveal and `D - 18`.
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
| `D - h_create` | 735 blocks (about 6 h) | 120 blocks (1 h at 30 s) | 300 blocks (2 h 30 at 30 s) |
| Bob's lock-by (hard limit) | `D - 629` (`D - 539`) | `D - 68` (`D - 62`) | `D - 251` (`D - 209`) |
| `W_A` / reveal cutoff before `T_reveal` | 7,200 s / 1,800 s | 600 s / 300 s | 4,200 s / 1,800 s |
| Bob's claim target / hard limit | `D - 18` / `D - 1` | same | same |
| finality, close fee | 18 blocks, 5,800 uNOID | same | same |
| a full "Alice never reveals" cycle | about 6 h | 137 blocks to final (about 70 min) | 317 blocks to final (about 2 h 40) |

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
  The window is only 120 blocks: funding must be final and Bob's lock in before `D - 62`, so fund within roughly 15
  minutes of Bob's OK. If the proof overran, discard the files and start over; a rehearsal costs only fees.
- Under `sepolia` the window is 300 blocks. Bob's lock-by is `D - 251` = `h_create + 49` with the full reveal window
  (`D - 209` = `h_create + 91` at the minimum window), and the funding must be final (18 blocks) before he locks, so fund
  within about 15 minutes of `h_create` (roughly 30 blocks) to keep the full window, 35 minutes at the latest. Alice may
  reveal only once Bob's Sepolia lock is finalized (13-19 min after it is mined) and not after `T_reveal - 1,800 s`.
- Run two: the happy path, then "Alice never reveals" (section 5). Epoch rotation is not covered by either profile
  (budget 0; with the `sepolia` window of 300 blocks a rotation will fall inside it, and a claim evicted at a rotation
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
online from the reveal until `D - 18`.

| Symptom | Meaning | Do |
|---|---|---|
| `tick` fails: connection error or `Transport` | node or RPC unreachable (in WSL: wrong transport) | Nothing was sent or decided. Check `parano1d-cli status`, `--transport curl`, the URL, the network. Do not act from memory. |
| action `wait`, reason `noid observation stale ...` or `eth observation stale ...` | the poll is older than 120 s | Tick again. If it persists, the node or the clock is wrong. There is no override. |
| reason `<field> unknown`, e.g. `noid.epoch_anchor unknown`, `eth.latest_timestamp unknown` | the node did not answer a field the gate needs | Fail closed: it will not spend. Retry; change node if it repeats. |
| `eth_getLogs` error naming a range, or `exceed maximum block range` | public RPC cap | Pass `--eth-from-block N` just before the lock or deploy block on one `tick --apply`; it is stored in the swap file. |
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
