# NOID <-> ETH atomic swap: Ethereum side (SHA-256 HTLC)

Hardhat project containing the Ethereum half of a cross-chain atomic swap.

| File | Purpose |
|------|---------|
| `contracts/HTLC.sol` | SHA-256 HTLC for native ETH |
| `contracts/HTLCERC20.sol` | Same, for ERC20 (OpenZeppelin `SafeERC20`) |
| `contracts/test/*.sol` | Test-only mocks (ETH-rejecting receiver, re-entrancy attacker, mock/fee tokens). Never deploy these. |
| `test/HTLC.test.js` | Test suite (Hardhat + ethers v6 + chai) |
| `test/fuzz.test.js`, `contracts/test/Fuzz*.sol`, `FUZZ.md` | Seeded fuzz and invariant campaign for both contracts, with the findings; see "Fuzz campaign" below |
| `scripts/secret.js` | Generates a 32-byte secret and its SHA-256 hashlock |
| `contracts/HTLCPoseidonV2.sol`, `contracts/Poseidon2b.sol`, `test/HTLCPoseidonV2.test.js`, `test/poseidon-vectors.test.js`, `test/vectors/` | ETH locked directly on Parano1d's `Addr(s)` (Poseidon2b computed in the EVM), so no equivalence proof is needed on an EVM leg; see "Poseidon2b on the EVM" below and `../docs/poseidon-leg.md` |
| `scripts/live.js`, `scripts/rpc-proxy.js`, `test/live.test.js`, `test/live-poseidon.test.js` | Live-run CLI for Sepolia and a loopback RPC forwarder; see "Live runs (Sepolia)" below. `live.js` works with both contracts (`--lock-kind sha256|poseidon`); see "The poseidon lock kind in `live.js`" |

## Install and test

```sh
npm install
npx hardhat test
```

Fuzz campaign (`test/fuzz.test.js`, report in `FUZZ.md`): the default `npx hardhat test` runs a
quick 200 ETH + 200 ERC-20 random sequences (about a minute); the full campaign is
`FUZZ_N=2000 npx hardhat test test/fuzz.test.js` (about 6 to 10 minutes; on a machine with little free
memory run slices in separate processes with `FUZZ_START`). The seed is printed and any failing sequence
can be replayed with `FUZZ_SEED`, `FUZZ_ONLY`, `FUZZ_KIND` (see `FUZZ.md`).

Solidity 0.8.24. Hardhat normally downloads the native `solc` from
`binaries.soliditylang.org`. If that download fails (offline or firewalled),
`hardhat.config.js` automatically falls back to the pure-JS compiler from the
`solc@0.8.24` npm package (same version, slower to compile). No setup is needed.

Generate a swap secret:

```sh
node scripts/secret.js          # or: npm run secret
node scripts/secret.js --json
```

It prints the secret, the hashlock, and runs a self-check that Node `crypto`
and ethers' `sha256` agree on the same bytes.

## Poseidon2b on the EVM (`HTLCPoseidonV2`)

`contracts/HTLCPoseidonV2.sol` is `HTLC.sol` with the lock word `lockAddr = Addr(s)` (Parano1d's address function, one
Poseidon2b permutation) in place of `SHA-256(s)`. The protocol delta, gas figures, the code-hash pin and the integration
spec for `swap-cli` and `live.js` are in `../docs/poseidon-leg.md`. `contracts/HTLCPoseidon.sol` is the earlier prototype
(kept for reference, not for use). Wired into `swap-cli` (`--eth-lock-kind poseidon`) and `live.js` (`--lock-kind poseidon`): see "The poseidon lock kind in `live.js`".

* Runtime code hash of `HTLCPoseidonV2`: `0xf510d2a368c730339fa7cf5e023bcf2429d5732793f043e03025780bb7043ff3`
  (solc 0.8.24, optimizer 200, `cancun`). Pinned in `test/HTLCPoseidonV2.test.js`.
* `claim` costs 0.50 to 0.55 M gas; send it with an explicit gas limit of at least 650,000 (`RECOMMENDED_CLAIM_GAS_LIMIT`).
  There is no `addrOf` view: never send a live secret to a remote node.
* `Poseidon2b.sol` is generated (`npm run poseidon:gen`, checked by `npm run poseidon:check` and by a test).

### Vendor reference vectors

`test/vectors/addr-vectors.bin` holds 12,299 vectors of 64 bytes each: secret (32) then `Addr(secret)` (32), computed by the
**vendor** crate (`noid_poseidon2b::primitives::derive_address`) through `equiv-ref`. Layout: 299 structured secrets first
(index 0 all-zero, 1 all-ones, 2 the published `00 01 .. 1f`, 3 to 10 repeated-byte and lane patterns, 11 to 42 one `0xff` byte,
43 to 298 the 256 single-bit secrets), then 12,000 seeded-random ones (secret *i* = SHA-256 of the text
`noid-swap/poseidon2b/addr-vectors/v1|i`). SHA-256 of the file (also in `addr-vectors.bin.sha256`):

```
09c22287e0fbb205681b0de59fe0282240fa8f09737aebb1ff6e9d76e4a673da
```

Regenerate it (from the repository root, Linux or WSL with the Rust toolchain; the output must be byte-identical):

```sh
cd equiv && cargo build --release --offline -p equiv-ref
./target/release/equiv-ref addr-vectors ../eth/test/vectors/addr-vectors.bin     # --random N and --seed TEXT change the random part
sha256sum ../eth/test/vectors/addr-vectors.bin                                    # compare with addr-vectors.bin.sha256
```

(With a shared target directory, `CARGO_TARGET_DIR=... cargo build ...` and run the binary from there.)

```sh
npx hardhat test test/poseidon-vectors.test.js                       # default: 299 structured + 300 random (every 40th), ~1 minute
POSEIDON_VECTORS=all POSEIDON_START=0 POSEIDON_COUNT=3100 npx hardhat test test/poseidon-vectors.test.js   # a slice of the whole file
npx hardhat test test/HTLCPoseidonV2.test.js                         # unit tests, gas report, code-hash pin
npx hardhat test test/fuzz.test.js --grep HTLCPoseidonV2             # fuzz campaign against HTLCPoseidonV2 (FUZZ_PN sets the count)
FUZZ_MUTANT_P=3 npx hardhat test test/fuzz.test.js --grep HTLCPoseidonV2   # planted bug 1 to 10: must FAIL
```

The full set runs in four slices of about 3,100 (`POSEIDON_START` 0, 3100, 6200, 9300), one process each; the Hardhat runtime
keeps a trace per Poseidon call, so the tests recycle the chain every few dozen calls (`test/helpers/chain-budget.js`) and fail
with a message, never skip, when the machine cannot hold a chunk. Each vector is one `eth_call` of one permutation
(`POSEIDON_BATCH=1`, the default): an `eth_call` that ran 8 permutations at once crashed the Hardhat runtime with a
segmentation fault when it followed `live.test.js` in a full-suite run. Whole suite (`npx hardhat test`, one process):
220 passing, 0 failing, about 3 minutes.

## Preimage encoding (the Parano1d side must match exactly)

* The secret (preimage) is **exactly 32 raw bytes**.
* `hashlock = SHA-256(preimage)` over **those 32 bytes only**: no length
  prefix, no padding, no domain-separation tag, not the hex or ASCII text of
  the secret, and **not keccak256**.
* Solidity: `sha256(abi.encodePacked(preimage))` with `preimage` a `bytes32`.
  Node: `crypto.createHash("sha256").update(Buffer.from(secretHex, "hex")).digest()`.
  ethers v6: `sha256(secretHex)` (a hex string is treated as bytes).
* Hex strings are the usual big-endian rendering, `0x` + 64 hex chars. Byte 0
  of the secret is the first byte hashed; the digest's first byte is the first
  byte of the hashlock.
* Test vector: preimage = 32 zero bytes (`0x00...00`) gives hashlock
  `0x66687aadf862bd776c8fc18b8e9f8e20089714856ee233b3902a591d0d5f2925`.
  The Parano1d side should reproduce this before anything is funded.

## API

```solidity
newLock(bytes32 hashlock, uint256 timelock, address payable receiver) payable returns (bytes32 lockId)
claim(bytes32 lockId, bytes32 preimage)
refund(bytes32 lockId)
getLock(bytes32 lockId) view returns (Lock)   // sender, receiver, amount, hashlock, timelock, claimed, refunded, preimage
computeLockId(sender, receiver, amount, hashlock, timelock) pure returns (bytes32)

event Locked(bytes32 indexed lockId, address indexed sender, address indexed receiver, uint256 amount, bytes32 hashlock, uint256 timelock);
event Claimed(bytes32 indexed lockId, bytes32 preimage);
event Refunded(bytes32 indexed lockId);
```

`HTLCERC20.newLock` additionally takes `(IERC20 token, uint256 amount)`, the
sender must `approve` the contract first, and `Locked` also carries `token`.
Fee-on-transfer tokens are rejected at `newLock` (only the inbound transfer is checked; see "Token trust" under Hazards). A receiver equal to the contract itself is refused (`InvalidReceiver`).

`lockId = keccak256(abi.encodePacked(sender, receiver, amount, hashlock, timelock))`
(ERC20 variant also packs `token` after `receiver`). It is deterministic, so
the counterparty can compute it off-chain, and an identical lock cannot be
created twice (`LockAlreadyExists`).

Errors are custom errors (`InvalidPreimage`, `TimelockExpired`,
`TimelockNotExpired`, `AlreadyClaimed`, `AlreadyRefunded`, `NotSender`,
`TransferFailed`, `LockNotFound`, `ZeroAmount`, `ZeroReceiver`,
`TimelockNotInFuture`, `LockAlreadyExists`, `Reentrancy`).

## Timelock rules

* `timelock` is an absolute Unix timestamp (seconds), compared with
  `block.timestamp`.
* `newLock`: `timelock` must be **strictly greater** than the current block
  timestamp.
* `claim`: allowed only while `block.timestamp < timelock`.
* `refund`: allowed only when `block.timestamp >= timelock`, only by the
  original sender, only if not claimed.
* The windows do not overlap, so a lock is never both claimable and
  refundable. Anyone may call `claim` (the preimage is the authorization), but
  funds always go to the fixed `receiver`.
* `block.timestamp` is set by the block proposer within protocol limits (a
  few seconds of skew, one slot is 12 s). Leave generous margins between the
  two chains' timeouts (hours, not seconds).

## Hazards

* **Receiver that rejects ETH.** Payment is a low-level `call{value:}` to the
  fixed receiver, and a failed call reverts the whole `claim`. If the receiver
  is a contract without a payable `receive`/`fallback` (or one that reverts),
  `claim` can never succeed and the funds stay locked until the sender calls
  `refund` after the timelock. Use an EOA, or a contract known to accept ETH.
  Covered by a test.
* **A sender that cannot accept ETH has no refund path** (fuzz finding F-ETH-1).
  `refund` pays `sender` the same way, so a sender contract whose `receive`
  reverts (or burns gas) can never refund; after the timelock `claim` is closed
  too, and the funds are locked for good (before it, only a claim with the
  preimage can move them). Use an EOA as sender as well. `swap-cli` already
  requires both addresses to have no code.
* **A reverted `claim` still publishes the preimage** (fuzz finding F-ETH-2).
  If the receiver rejects ETH, `claim` reverts and leaves no `Claimed` event, but
  the transaction (and its mempool entry) carries the preimage in its calldata.
  The counterparty can read it there and take the other leg of the swap while
  the ETH waits for the refund, so a receiver that cannot accept ETH risks its
  principal, not only a delay. A watcher that follows events only will not see
  it. Another reason for EOA-only receivers.
* **Token trust (`HTLCERC20`).** Only the inbound transfer is measured. A token
  that charges a fee on payouts, returns true without moving tokens, or shrinks
  the contract's balance after locking (rebase, confiscation) leaves the receiver
  short or later locks of that token under-backed (their claim and refund
  revert). A token that blocks transfers to the receiver stops `claim`; one that
  blocks transfers to the sender stops `refund`; both blocked: stuck until one is
  unblocked. Use plain ERC-20s only. Details and reproducing tests: `FUZZ.md`.
* **The preimage becomes public.** `claim` takes the preimage in calldata and
  writes it to the lock and to the `Claimed` event. Anyone can read it,
  including from the mempool before inclusion. That is how the counterparty
  learns it, but it also means that once it is visible on Ethereum, any other
  lock on any chain using the same hashlock can be claimed by whoever sees it.
  Never reuse a secret or hashlock across swaps.
* **Reorgs.** Wait for adequate confirmations before acting on a `Locked` or
  `Claimed` event from this chain.
* The contracts are unaudited and have no admin, pause, or upgrade path.

## How this fits the swap

Roles: **Alice** is the secret holder; **Bob** is the counterparty.

1. Alice generates `s` (`node scripts/secret.js`) and computes `h = sha256(s)`.
   She shares only `h`.
2. Alice locks first on her chain under `h` with the **longer** timeout `T_A`,
   receiver = Bob.
3. Bob verifies Alice's lock (amount, receiver, `h`, timeout), then locks on
   his chain under the same `h` with the **shorter** timeout `T_B < T_A`,
   receiver = Alice. `T_A - T_B` must cover Bob's time to notice the reveal,
   claim, and survive confirmation delays and clock skew.
4. Alice claims on Bob's chain, revealing `s`.
5. Bob reads `s` from the chain where Alice claimed and claims on Alice's
   chain with the same `s` before `T_A`.
6. If Alice never claims, both sides refund after their timeouts (Bob at
   `T_B`, Alice at `T_A`).

Which role maps to Ethereum is up to the deal. If ETH is on Alice's chain, she
calls `newLock` here first with the long timeout, and Bob later calls `claim`
here with the `s` he read from the Parano1d chain. If ETH is on Bob's chain,
Bob calls `newLock` here with the short timeout, and Alice's `claim` here
reveals `s`.

Watching for the reveal on Ethereum: subscribe to
`Claimed(lockId, preimage)` for the relevant `lockId`, or read
`getLock(lockId).preimage` once `claimed` is true. The preimage is also in the
`claim` transaction calldata. Verify `sha256(preimage) == hashlock` before
using it.

## Live runs (Sepolia)

Tooling for one real swap on a public testnet. **Testnet by default**: `scripts/live.js`
refuses to send on Ethereum mainnet (chainId 1) unless the command carries `--mainnet`
(see "Mainnet" below), and on any chain other than Sepolia (11155111), Holesky (17000)
and local Hardhat (31337 / 1337) unless you pass `--allow-chain-id N`. Use test ETH only
until the first mainnet swap is planned.

| File | Purpose |
|------|---------|
| `scripts/live.js` | CLI + module: `keygen`, `balance`, `deploy`, `lock`, `claim`, `refund`, `send`, `status`. All output is one JSON object on stdout; errors go to stderr with exit code 1. |
| `scripts/rpc-proxy.js` | Loopback plain-HTTP to HTTPS forwarder, so the Rust `swap-cli` (no TLS) can read Ethereum. |
| `test/live.test.js` | Tests for both, over Hardhat's in-process network and 127.0.0.1 only. |

### The poseidon lock kind in `live.js` (`docs/poseidon-leg.md` section 9.6)

Every command that talks to a lock contract takes `--lock-kind sha256|poseidon` (`deploy` also reads it as `--contract-kind`; the two names are one
setting). `sha256` is `HTLC.sol` and the default; `poseidon` is `HTLCPoseidonV2.sol`. With `--swap FILE` the kind is the file's `params.eth.lock_kind` (absent =
`sha256`): a `--lock-kind` that says otherwise is refused, and the file's `code_hash` must equal the code hash of **that kind's** local artifact
(`eth/artifacts/contracts/HTLCPoseidonV2.sol/…`; the hash is `0xf510d2a3…3ff3`). The artifact, the ABI (`lockAddr` instead of `hashlock`), the code-hash check against
`eth_getCode`, the `Locked` scan and the revert decoding all follow the kind.

| Command | What changes for `poseidon` |
|---------|-----------------------------|
| `deploy --contract-kind poseidon` | deploys the V2 artifact (about 3.4 M gas, 15,300 bytes); `matchesArtifact` compares with it |
| `lock` | `--lock-addr 0x…` (the NOID claim authority `A`) replaces `--hashlock`; each is refused for the other kind. REVIEW-7 R7-1: the pre-lock check asks the node only for the `Locked` logs of **your own sender** (`eth_getLogs` with the indexed sender as topic2, in 50,000-block chunks from the from-block; `HTLCPoseidonV2`'s `Locked` has `sender` indexed, the lock word is in the data and is compared locally, every log re-checked locally), and refuses an earlier lock of your own sender on that address (any receiver). It no longer reads every `Locked` log of the shared contract, so there is no provider-cap size rule any more (nobody can hold your lock back by padding the contract). A lock of another sender on the same address does not block (REVIEW-6 R6-2: Bob's lock pays only the fixed receiver, for an `x` with `Addr(x) = A`, so a stranger's 1-wei lock must not be able to veto the swap) and, for this kind, is not read: `foreignLocksSameHashlock` stays `[]`, `lockedEventsQuery` is `"sender"` and `lockedEventsScanned` counts your own sender's logs |
| `claim` | compares `Addr(secret)` with the lock **locally** (`scripts/poseidon/poseidon2b.js`, the port the vector test ties to the vendor crate); builds the calldata itself and **refuses to sign anything but exactly 68 bytes** that equal selector + lock id + secret (V2-7); sends it with a **fixed gas limit of 1,000,000** (V2-6; the contract's own floor is 540,000 and recommendation 650,000, both read from the pinned contract and checked), and requires the balance to cover `limit × fee cap`; **never simulates**: no `eth_estimateGas`, no `eth_call` carries the secret, only the signed `eth_sendRawTransaction` does (tested by recording every JSON-RPC request); `--dry-run` therefore reports `gasLimit` and `gasEstimate: null`, and a dry run **with** the secret is refused when `ETH_RPC_URL` is not on this machine (run it without `--secret-stdin`: every gate is checked without the secret); `--replace` re-sends with the same limit |
| `refund` | as before, against the V2 ABI |
| `status` | detects the kind from the contract's code hash when no flag is given; output keeps the key `hashlock` (it holds the lock word), adds `lockKind`, and `preimageMatchesHashlock` is the local `Addr` comparison |

A claim that reverts (`TimelockExpired`, `BadCalldataLength`, `InsufficientGas`, `TransferFailed`) is decoded by name with a note that the claim transaction carried the secret.
A claim that is **mined and reverts** (either kind; for example it was mined after the timelock) is no longer a bare "failed" (REVIEW-6 R6-3): `claim` prints a JSON
result with `reverted: true`, `secretPublic: true`, the `txHash`, `blockNumber`, `lockId`, a note and `swapCliFlag: "--reveal-tx HASH"`, and exits with status 3.
Give the hash to `swap-cli tick --reveal-tx HASH --apply` (`scripts/live/reveal.sh` saves it for the helpers): swap-cli reads the transaction and its receipt from the
node, checks that it is this lock's `claim` from `alice_receiver`, and records that the secret is public (the late re-send cutoff `T_reveal - DE` then applies;
the swap-file history marker is `reveal_reverted_seen`, which `live.js --swap` reads like the other public-secret markers). Bob's `tick` / `claim` can take the secret
from the same hash. For the poseidon kind the revert is not decoded by name (ethers gives a status-0 receipt no reason), so this result is the only notice.
Tests: `test/live-poseidon.test.js` (real V2 contract on Hardhat; three real claims, then the chain is reset to give the retained trace memory back).
Alice's ETH address must hold `1,000,000 × fee cap` at the reveal (0.02 ETH at 20 gwei), not the 89 k of the sha256 kind.

### Environment

| Variable | Meaning |
|----------|---------|
| `ETH_RPC_URL` | JSON-RPC endpoint used by `live.js` (default `http://127.0.0.1:8545`). For Sepolia, set it to a public HTTPS endpoint (below). |

Run everything from `eth/`. The HTLC artifact must exist: `npx hardhat compile` once.
Common flags on every state-changing command: `--confirmations N` (default 1),
`--dry-run` (run every check below, estimate gas where possible, print what would be sent, send nothing),
`--gas-price-gwei X` (sets `maxFeePerGas` to X gwei, tip capped at 1 gwei).
Keys live in `eth/keys/` (git-ignored at the repo root). `live.js` never prints a private key;
back the key files up yourself. A lost key file means lost testnet funds, nothing more.

### What `live.js` checks by itself (REVIEW-2 F1, F3, F4, F7)

Every check below is a refusal with a plain message, **also under `--dry-run`**, and happens before
anything is signed. They do not replace the `swap-cli` gates; they are the last line if a command is
typed by hand or repeated.

| Command | Required flags | Refuses unless |
|---------|----------------|----------------|
| `lock`, `claim`, `refund` | `--chain-id N` (mandatory); `--code-hash 0x…` (optional) | `eth_chainId` equals `--chain-id`, the chain is an allowed test chain (chainId 1 is refused unless `--mainnet` is given, see "Mainnet"), and `keccak256(eth_getCode(CONTRACT))` equals `keccak256(deployedBytecode)` of this repo's compiled artifact (REVIEW-3 F1; run `npx hardhat compile` first). `--code-hash` defaults to that value and, when given, must equal it. With `--swap FILE` the file's `code_hash` must equal it too. A contract address with no code is refused too. |
| `lock` | | no `Locked` event with the same hashlock from your own sender address (the key file's) exists in the contract's logs, and the exact lockId is unused. There is no override flag: a second lock of yours under one hashlock means you pay twice. A lock by another sender under the same hashlock does not block you (a third party who knows the public hashlock could otherwise grief the swap); it is listed in the JSON as `foreignLocksSameHashlock: [{sender, lockId, blockNumber}]` and noted on stderr, because whoever reveals the secret can claim those too. |
| `claim` | `--secret-stdin` or `--secret-file PATH` (not needed for `--dry-run`) | `now <= timelock - --margin-s` (default 1800 s = `M_A`, design §4.3; `now` is the later of your clock and the latest block's timestamp), the lock exists, is unclaimed and unrefunded, `sha256(secret)` equals its hashlock, and the `Locked` event's block is at or below the node's `finalized` block (a node that does not answer the `finalized` tag is refused; on a local Hardhat node it equals `latest`). `--confirmations` still decides how long to wait after sending. With `--swap FILE` the key must be the file's `alice_receiver` (REVIEW-4 R4-5). |
| `refund` | | the lock exists, this key is its sender (with `--swap FILE`: the file's `bob_sender`, checked first, R4-5), it is unclaimed and unrefunded, and the latest block's timestamp is at or past the timelock. |
| `lock`, `claim`, `refund` | | the fee cap is not outrun by the base fee (REVIEW-4 R4-1, next section). |

#### Fee cap, stuck transactions, `--replace` (REVIEW-4 R4-1)

Whenever a fee cap is chosen (`--max-fee-gwei` under `--mainnet`, `--gas-price-gwei` on a test chain), the latest block's
base fee is read before signing, **also under `--dry-run`**. A `claim` is refused when `cap < 2 x base fee` (it publishes the
secret, so it must not get stuck when the base fee climbs 12.5 % a block); `lock` and `refund` are refused when `cap < base fee`.
The output carries `feeCheck`: `baseFeeGwei`, `maxFeeGwei`, `ratio` (cap / base fee) and `minRatio`. With no cap chosen (test
chain, no flag) the node prices the transaction itself and nothing is checked.

`claim --replace` and `refund --replace` re-send the same call when the first one is stuck. They use the signer's **oldest pending
nonce** (never a second nonce), raise `maxFeePerGas` and the tip by at least 12.5 % over the old transaction and the cap to at
least 2 x the latest base fee. A refund replacement estimates gas against the `latest` state (a pool-aware estimate would see the stuck
refund and revert); a claim replacement uses the claim's fixed gas limit and estimates nothing (R6-8). On mainnet `--max-fee-gwei` is the new cap and must clear that minimum; on a test chain without a cap the fees are
chosen. Refused: nothing pending for the signer, a pending transaction that is not this very `claim` / `refund` of this lock (it
would cancel something else), `--replace-tx` naming a mined or foreign transaction, a lock already claimed or refunded.
The old transaction is found with `--replace-tx HASH` (the hash the command line prints on stderr as `sent: 0x… nonce N …`
right after sending, before it waits for the receipt) or, if omitted, in the node's pending block and (geth-style nodes) its
`txpool_contentFrom`. **It must be found and identified** (REVIEW-5 R5-2): a transaction priced under the base fee is usually
absent from the pending block, and a node that cannot show it makes the command refuse and ask for `--replace-tx`; it never
replaces whatever sits at the oldest nonce (with a key shared across swaps that could cancel another swap's claim or lock).
`--dry-run` shows the plan (`replace: { nonce, replacesTx, old/new fee and tip }`) and sends nothing. `--replace` does not exist
for `lock`.

**A stuck first reveal can be replaced past the `M_A` cutoff** (REVIEW-5 R5-1). A claim in the public mempool has already
published the secret, so `M_A` (which protects a first publication) no longer applies: with `--swap FILE`, a `claim --replace`
that found and identified the signer's pending claim of this lock uses the late cutoff `T_reveal - DE` (the intent's
`late_cutoff`, which `swap-cli` freezes in every `reveal_eth` intent; an older intent gets the profile's `DE`), whether or not the
file's history has a marker. The plan prints `revealCutoffRule`. A first claim, which has no pending transaction, keeps the strict
`M_A` rule, and an explicit `--margin-s` still tightens either.

#### Late re-send (REVIEW-4 R4-3)

With `--swap FILE`, the reveal cutoff is the earlier of `timelock - --margin-s` and the cutoff the `reveal_eth` intent froze. One
exception: when the file's `history` shows the secret may already be public (`reveal_submitted`, `eth_claim_mined`,
`eth_claim_reorged`, `eth_reveal_dropped` or, since REVIEW-5, `reveal_pending_seen` (`swap-cli` writes it when it sees the receiver key's
claim in the mempool while a `reveal_eth` intent is held); the same events as `swap-cli`'s `secret_may_be_public`), a re-send publishes nothing
new, and the intent's own cutoff (`T_reveal - DE`, which `swap-cli` froze for exactly that case) rules even when it is later than
`timelock - 1800 s`. An explicit `--margin-s` still tightens it. The plan prints `revealCutoffRule`.

`--chain-id` comes from your own records, not from the counterparty: the chain id of the network you mean
to use. The code hash is not typed at all (REVIEW-3 F1): it is the hash of this repo's compiled artifact, so a
look-alike contract deployed by the other side is refused whatever hash they send. `deploy` reports
`matchesArtifact`; `status` prints `chainId` and `codeHash` for the contract it is asked about, for information.

Log scans (`lock` and `claim`) start at `--from-block` if given, otherwise at the contract's deployment
block when the node can answer `eth_getCode` for old blocks (a binary search, about 25 calls), otherwise at
block 0. They issue `eth_getLogs` in ranges of at most 50,000 blocks. A `--from-block` above the real
deployment block can hide an earlier `Locked` event and weakens the duplicate-lock check, so pass the
`blockNumber` printed by `deploy`, or nothing. With `--swap FILE`, `--from-block` may be omitted and is then the swap file's
`eth_from_block` (REVIEW-3 F7; `swap-cli tick --apply --eth-from-block N` stores it); a given `--from-block` wins.

The secret is never accepted on the command line. `claim` reads it as one line of `0x` + 64 hex from
stdin (`--secret-stdin`, refused if stdin is a terminal) or from a file (`--secret-file PATH`). It is
never printed: not in the JSON, not in errors, not in the dry-run calldata (only its length is shown), and any
error text that happens to contain it is scrubbed. `--dry-run` works without it and prints the plan; it
shows `"gasEstimate": null` and the fixed `gasLimit`. **The claim is never estimated, for either lock kind** (REVIEW-6 R6-8): an `eth_estimateGas`
request carries the calldata, i.e. the secret, to the node before the claim itself. The sha256 claim is sent with a fixed gas limit of
200,000 (the fuzz maximum in `FUZZ.md` is 120,993 gas; the balance must cover `limit x fee cap`, unused gas is not charged), the poseidon claim with
1,000,000. A dry run WITH the secret is refused when `ETH_RPC_URL` is not on this machine, for both kinds (run it without `--secret-stdin`).
Test: `R6-8` in `test/live.test.js` records every JSON-RPC request.

### Mainnet

Ethereum mainnet (chainId 1) is refused by default, as before. Two flags open it, on the five signing
commands only (`deploy`, `send`, `lock`, `claim`, `refund`); `balance`, `status` and `keygen` do not take them.

| Flag | Rule |
|------|------|
| `--mainnet` | Chain 1 is accepted, and **only** chain 1: a node on any other chain is refused (no mixing), `--chain-id` must be `1` (lock, claim, refund), and `--allow-chain-id` is refused. The command line prints one warning line on stderr. |
| `--max-fee-gwei N` | **Required with `--mainnet`, refused without it.** `N` is the `maxFeePerGas` of the transaction (decimal gwei, up to 9 decimals; the tip is at most 1 gwei and never above `N`). `--gas-price-gwei` is refused with `--mainnet`: the cap is the only fee setting. |

`--dry-run` prints, besides the usual plan, `maxFeeGwei`, the worst-case cost (`worstCaseFeeWei` / `worstCaseFeeEth` =
gas estimate x cap), `requiredWei` / `requiredEth` (value + worst case) and the sender's balance
(`senderBalanceWei` / `senderBalanceEth`). The command refuses, dry run and real send alike, when the balance is
below value + worst case. (`claim --dry-run` without the secret has no gas estimate: it shows the cap and the balance, and
`worstCaseFeeWei: null`; pipe the real secret in for the figure.)

**Under `--mainnet`, `lock`, `claim` and `refund` require `--swap FILE`** (the `swap-cli` swap file): without it they refuse, also
with `--dry-run`, and there is no warn-and-continue path. The swap file must say `chain_id` 1 and the `production` profile (a file with no
`profile` field is production; `sepolia`, `rehearsal` or any other value is refused). A file with `chain_id` 1 is also
refused when `--mainnet` is not given, so a swap file never unlocks mainnet by itself.

**The first mainnet swap uses 0.001 ETH** (`--amount-wei 1000000000000000`), against 10 NOID, and nothing larger until it has settled
and been looked at. The plan is in `docs/live-run-mainnet-plan.md`. The production profile of `swap-cli` has no amount cap of its
own, so this limit is a rule of the operator, not a gate.

```sh
# dry run first, always; the cap is an upper bound, not a price (the network charges base fee + tip)
node scripts/live.js lock --mainnet --max-fee-gwei 20 --swap ../path/bob.swap.json --chain-id 1 --dry-run
```

### Roles on the ETH side

Alice (NOID holder, makes the secret) locks NOID first. **Bob** (ETH holder) locks ETH second
under Alice's hashlock with receiver = Alice's Ethereum address. **Alice claims the ETH**,
which publishes the secret in the `Claimed` event; Bob reads it and claims the NOID. If Alice
never claims, Bob refunds after `--t-reveal`. Alice needs a little ETH for the claim gas, so
Bob sends her some.

### Command sequence (one swap, ETH leg)

```sh
cd eth
npx hardhat compile                          # once, if artifacts/ is missing
export ETH_RPC_URL=https://ethereum-sepolia-rpc.publicnode.com   # any Sepolia endpoint, see below

# 1. Keys (writes eth/keys/*.key, prints only the address; refuses to overwrite)
node scripts/live.js keygen --out keys/bob.key       # -> BOB_ADDR
node scripts/live.js keygen --out keys/alice.key     # -> ALICE_ADDR

# 2. Fund Bob from a Sepolia faucet (by hand, in a browser), then check
node scripts/live.js balance BOB_ADDR

# 3. Bob sends gas money to Alice (0.01 ETH = 10000000000000000 wei is plenty)
node scripts/live.js send --key-file keys/bob.key --to ALICE_ADDR --amount-wei 10000000000000000 --dry-run
node scripts/live.js send --key-file keys/bob.key --to ALICE_ADDR --amount-wei 10000000000000000

# 4. Bob deploys the HTLC (once per network; record "contract", "codeHash" and "matchesArtifact": true)
node scripts/live.js deploy --key-file keys/bob.key --dry-run
node scripts/live.js deploy --key-file keys/bob.key
#    -> CONTRACT, codeHash, chainId, deployer, blockNumber. Anyone can re-check: keccak256(eth_getCode(CONTRACT)) == codeHash.
#    Write down CHAIN_ID (11155111 on Sepolia) and CODE_HASH: lock, claim and refund require both.
CHAIN_ID=11155111
CODE_HASH=0xCODEHASH

# 5. Alice (on her side) generated the secret and gave Bob ONLY the hashlock:
#      node scripts/secret.js --json      -> secret (private), hashlock (public)
#    Bob locks ETH for Alice. --t-reveal is an absolute UNIX time in seconds: the end of
#    Alice's reveal window W_A (design: 7200 s after Bob's lock). Compute it just before locking.
#    Refused if you already locked under this hashlock, or if chain id / code hash differ.
T_REVEAL=$(( $(date +%s) + 7200 ))
node scripts/live.js lock --key-file keys/bob.key --contract CONTRACT --chain-id $CHAIN_ID --code-hash $CODE_HASH \
    --hashlock 0xHASHLOCK --t-reveal $T_REVEAL --receiver ALICE_ADDR --amount-wei 1000000000000000 --dry-run
node scripts/live.js lock --key-file keys/bob.key --contract CONTRACT --chain-id $CHAIN_ID --code-hash $CODE_HASH \
    --hashlock 0xHASHLOCK --t-reveal $T_REVEAL --receiver ALICE_ADDR --amount-wei 1000000000000000
#    -> lockId, blockNumber, blockTimestamp (lockId is also recomputed locally and asserted equal)
#    Optional on lock/claim: --from-block N (default: the contract's deployment block, else 0).

# 6. Anyone can watch the lock; this also prints chainId and codeHash for the contract
node scripts/live.js status --contract CONTRACT --lock-id 0xLOCKID --from-block BLOCKNUMBER

# 7a. Happy path: Alice claims ETH before T_REVEAL - 1800 s. This publishes the secret on Sepolia.
#     Dry run first: needs no secret; prints the plan (cutoff, lock and finalized blocks) and "gasEstimate": null.
node scripts/live.js claim --key-file keys/alice.key --contract CONTRACT --lock-id 0xLOCKID \
    --chain-id $CHAIN_ID --code-hash $CODE_HASH --dry-run
#     The real send reads the secret from stdin (one line, 0x + 64 hex); it is never put on the command line:
swap-cli secret ALICE.swap | node scripts/live.js claim --key-file keys/alice.key --contract CONTRACT --lock-id 0xLOCKID \
    --chain-id $CHAIN_ID --code-hash $CODE_HASH --secret-stdin
#     ...or from a file you created with owner-only permissions and delete afterwards:
node scripts/live.js claim --key-file keys/alice.key --contract CONTRACT --lock-id 0xLOCKID \
    --chain-id $CHAIN_ID --code-hash $CODE_HASH --secret-file SECRET_FILE
#     Add --margin-s N to change the 1800 s reveal margin (only if you know what a late reveal costs).
#     Bob (or swap-cli) then reads the secret:
node scripts/live.js status --contract CONTRACT --lock-id 0xLOCKID --from-block BLOCKNUMBER   # "preimage": "0x..."

# 7b. Failure path: nobody claimed. At or after T_REVEAL, Bob refunds (refused locally before then).
node scripts/live.js refund --key-file keys/bob.key --contract CONTRACT --lock-id 0xLOCKID \
    --chain-id $CHAIN_ID --code-hash $CODE_HASH
```

Notes:

* `status` needs no key. Its `--from-block` defaults like `lock`/`claim` (deployment block, else 0);
  `eth_getLogs` is issued in chunks of at most 50,000 blocks. Pass the lock's block number to keep it short.
* `refund` compares against the **latest block's** timestamp (not your clock), so it can say "too
  early" for a few seconds after the timelock; just retry. The contract is the real judge.
* `--preimage` no longer exists (a secret on argv lands in shell history and process listings; the
  parser says so if you try). Use a fresh secret per swap (never reuse one, never use the public test vector).
  `swap-cli secret` prints the secret to stdout, so run it only in the pipe above, never on its own in a logged terminal.
* `claim --secret-stdin` has to be the receiving end of a pipe (or `< file`); with a terminal on stdin it refuses.
* A third party who locks dust under your hashlock does not block `lock` (only your own earlier lock does). It is
  reported as `foreignLocksSameHashlock` (sha256 kind; the poseidon kind asks the node for your own sender's locks only and does not read it);
  whoever reveals the secret can claim it too, so treat it as a donation.
* The ETH receiver must be an EOA (see Hazards above); `keygen` produces one.

### The proxy for `swap-cli`

`swap-cli` speaks plain HTTP JSON-RPC only. Run the proxy next to it and point `swap-cli` at it:

```sh
node scripts/rpc-proxy.js --listen 127.0.0.1:8546 --upstream https://ethereum-sepolia-rpc.publicnode.com
# swap-cli then uses http://127.0.0.1:8546  (live.js can too: ETH_RPC_URL=http://127.0.0.1:8546)
```

It forwards each JSON-RPC POST body unchanged to the upstream (HTTP or HTTPS, Node's built-in
`fetch`), returns the upstream's status and body, logs one line per request to stderr
(`eth_blockNumber 200 83ms`; the upstream path, which may hold an API key, is never logged), binds
to 127.0.0.1 only (any other `--listen` host is refused), and has no auth and no caching.
Upstream failure becomes a 502 with a JSON-RPC error body; non-POST requests get 405.
Do not expose it beyond loopback: anyone who can reach it can spend your endpoint's rate limit.

### Public Sepolia JSON-RPC endpoints (no API key)

**We have not tested any of these.** Names are from memory; they come and go, rate-limit, and
some drop `eth_getLogs` over large ranges. Try one, fall back to another:

* `https://ethereum-sepolia-rpc.publicnode.com` (PublicNode)
* `https://sepolia.drpc.org` (dRPC public tier)
* `https://1rpc.io/sepolia` (1RPC)
* `https://rpc.sepolia.org` (long-standing community endpoint, often overloaded)
* `https://sepolia.gateway.tenderly.co` (Tenderly gateway)

Always confirm the chain before sending anything: `node scripts/live.js balance ADDR` prints
`"chainId": "11155111"` on Sepolia. Faucets (also unverified): search for "Sepolia faucet" from
Google Cloud Web3, Alchemy, or the proof-of-work faucet at sepolia-faucet.pk910.de; most limit
requests per day or want a small mainnet balance or account.
