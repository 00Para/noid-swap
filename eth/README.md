# NOID <-> ETH atomic swap: Ethereum side (SHA-256 HTLC)

Hardhat project containing the Ethereum half of a cross-chain atomic swap.

| File | Purpose |
|------|---------|
| `contracts/HTLC.sol` | SHA-256 HTLC for native ETH |
| `contracts/HTLCERC20.sol` | Same, for ERC20 (OpenZeppelin `SafeERC20`) |
| `contracts/test/*.sol` | Test-only mocks (ETH-rejecting receiver, re-entrancy attacker, mock/fee tokens). Never deploy these. |
| `test/HTLC.test.js` | Test suite (Hardhat + ethers v6 + chai) |
| `scripts/secret.js` | Generates a 32-byte secret and its SHA-256 hashlock |
| `scripts/live.js`, `scripts/rpc-proxy.js`, `test/live.test.js` | Live-run CLI for Sepolia and a loopback RPC forwarder; see "Live runs (Sepolia)" below |

## Install and test

```sh
npm install
npx hardhat test
```

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
Fee-on-transfer tokens are rejected.

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

Tooling for one real swap on a public testnet. **Testnet only**: `scripts/live.js`
refuses to send on Ethereum mainnet (chainId 1) and on any chain other than
Sepolia (11155111), Holesky (17000) and local Hardhat (31337 / 1337) unless you
pass `--allow-chain-id N`. Use test ETH only.

| File | Purpose |
|------|---------|
| `scripts/live.js` | CLI + module: `keygen`, `balance`, `deploy`, `lock`, `claim`, `refund`, `send`, `status`. All output is one JSON object on stdout; errors go to stderr with exit code 1. |
| `scripts/rpc-proxy.js` | Loopback plain-HTTP to HTTPS forwarder, so the Rust `swap-cli` (no TLS) can read Ethereum. |
| `test/live.test.js` | Tests for both, over Hardhat's in-process network and 127.0.0.1 only. |

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
| `lock`, `claim`, `refund` | `--chain-id N` (mandatory); `--code-hash 0x…` (optional) | `eth_chainId` equals `--chain-id`, the chain is not mainnet (chainId 1 is always refused) and is an allowed test chain, and `keccak256(eth_getCode(CONTRACT))` equals `keccak256(deployedBytecode)` of this repo's compiled artifact (REVIEW-3 F1; run `npx hardhat compile` first). `--code-hash` defaults to that value and, when given, must equal it. With `--swap FILE` the file's `code_hash` must equal it too. A contract address with no code is refused too. |
| `lock` | | no `Locked` event with the same hashlock from your own sender address (the key file's) exists in the contract's logs, and the exact lockId is unused. There is no override flag: a second lock of yours under one hashlock means you pay twice. A lock by another sender under the same hashlock does not block you (a third party who knows the public hashlock could otherwise grief the swap); it is listed in the JSON as `foreignLocksSameHashlock: [{sender, lockId, blockNumber}]` and noted on stderr, because whoever reveals the secret can claim those too. |
| `claim` | `--secret-stdin` or `--secret-file PATH` (not needed for `--dry-run`) | `now <= timelock - --margin-s` (default 1800 s = `M_A`, design §4.3; `now` is the later of your clock and the latest block's timestamp), the lock exists, is unclaimed and unrefunded, `sha256(secret)` equals its hashlock, and the `Locked` event's block is at or below the node's `finalized` block (a node that does not answer the `finalized` tag is refused; on a local Hardhat node it equals `latest`). `--confirmations` still decides how long to wait after sending. |
| `refund` | | the lock exists, this key is its sender, it is unclaimed and unrefunded, and the latest block's timestamp is at or past the timelock. |

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
then shows `"gasEstimate": null` (gas cannot be estimated without the real preimage, since a wrong one
reverts). Pipe the secret in for a dry run only if you want the gas figure.

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
  reported as `foreignLocksSameHashlock`; whoever reveals the secret can claim it too, so treat it as a donation.
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
