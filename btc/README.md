# NOID <-> BTC atomic swap: Bitcoin side (P2WSH SHA-256 HTLC)

Library, tests, an offline demo, and a **signet-only live-run CLI** for the
Bitcoin half of the swap. No bitcoind is needed: the library and tests are fully
offline, and `scripts/live.js` talks to a public block-explorer REST API.
Defaults to testnet/signet parameters; mainnet and regtest are a switch away
in the library, and `scripts/live.js` refuses anything but signet.

| File | Purpose |
|------|---------|
| `src/htlc.js` | Redeem script (the design's section 3.1 script, with `OP_SIZE 32 OP_EQUALVERIFY`), P2WSH address, strict decoder (rejects the old layout without the size check), claim and refund tx builders |
| `src/verify.js` | Minimal script-logic checker for claim/refund spends, and `extractPreimage` for the watcher |
| `src/secret.js` | Mirror of `../eth/scripts/secret.js` (32 random bytes, `sha256` hashlock) |
| `src/network.js` | Network selection (`testnet` default, `signet`, `regtest`, `mainnet`) |
| `src/fund.js` | Bob's funding tx: P2WPKH inputs -> P2WSH HTLC output + change; largest-first coin selection; dust handling |
| `src/esplora.js` | Esplora-style REST client for **signet only** (mempool.space primary, blockstream.info fallback), fee clamp 1..50 sat/vB |
| `scripts/live.js` | Live-run CLI: `keygen address balance tip lock status claim refund broadcast watch`; see "Live run (signet)" |
| `test/*.test.js` | 66 tests (`node:test`): 32 script/claim/refund, 4 secret, 7 funding builder, 5 REST client (mocked `fetch`, fixtures recorded from the real signet API), 18 CLI commands against a mocked chain |
| `scripts/demo.js` | Prints keys, `s`, `H`, address, and example claim/refund hex. Offline, no broadcast |

## Install and test

```sh
npm install
npm test            # node --test "test/*.test.js"  (66 passing, offline)
node scripts/demo.js
node src/secret.js [--json]
```

Dependencies: `bitcoinjs-lib` 7.x, `ecpair` 3.x, `tiny-secp256k1` 2.x. Node 22+ (tested on v22.23.4; `npm test` uses the `node --test` glob form, which needs Node 21+).

## The script

```
OP_IF
  OP_SIZE 32 OP_EQUALVERIFY
  OP_SHA256 <H> OP_EQUALVERIFY <alicePubkey>
OP_ELSE
  <locktime> OP_CHECKLOCKTIMEVERIFY OP_DROP <bobPubkey>
OP_ENDIF
OP_CHECKSIG
```

This is exactly the script of `docs/protocol-design.md` section 3.1. Serialized:

```
63 82 01 20 88 a8 20 <H:32> 88 21 <alice:33> 67 <push locktime> b1 75 21 <bob:33> 68 ac
```

`OP_SIZE` pushes the length of the preimage without removing it, so
`32 OP_EQUALVERIFY` checks the length and leaves the preimage for `OP_SHA256`.
The number 32 is the data push `01 20` (`OP_1..OP_16` stop at 16).

Funded as native P2WSH (`OP_0 <sha256(script)>`, bech32 `tb1q...` / `bc1q...`
/ `bcrt1q...`). 117 bytes with a 3-byte locktime.

Test vector (`test/htlc.test.js`; alice = pubkey of private key 1, bob = pubkey of
private key 2, `H = sha256(32 zero bytes)`, locktime 2,500,000), witness script:

```
63820120 88a820 66687aadf862bd776c8fc18b8e9f8e20089714856ee233b3902a591d0d5f2925 88
21 0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798
67 03a02526 b175
21 02c6047f9441ed7d6d3045406e95c07cd85c778e4b8cef3ca7abac09b95c709ee5 68ac
```

(one line, no spaces: `6382012088a82066687aadf862bd776c8fc18b8e9f8e20089714856ee233b3902a591d0d5f292588210279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f817986703a02526b1752102c6047f9441ed7d6d3045406e95c07cd85c778e4b8cef3ca7abac09b95c709ee568ac`). Its signet/testnet address is `tb1q050pzk5rhgck75kyvymgeva80pka5g005mh6fz7vv6qxhaml3ajscrlwxt`; its P2WSH scriptPubKey is `00207d1e115a83ba316f52c461368cb3a7786dda21efa6efa48bcc66806bf77f8f65`.

**Not compatible with the earlier layout.** Before 2026-11-04 the library built the
same script *without* `OP_SIZE 32 OP_EQUALVERIFY` (113 bytes). `decodeRedeemScript`,
`verifyLock`, `checkHtlcSpend`, `extractPreimage` and the CLI reject that layout
("legacy layout without OP_SIZE"), so an address derived by the old code is never
mistaken for a valid HTLC. (Nothing has ever been broadcast from this library.)

* **Claim (Alice)**, witness `[ <sig> <s> 0x01 <redeemScript> ]`. `0x01` is the
  `OP_TRUE` that selects the IF branch. `s` must be exactly 32 bytes. No time
  limit on this path.
* **Refund (Bob)**, witness `[ <sig> <empty> <redeemScript> ]`. The empty
  vector is `OP_FALSE` (ELSE branch). Tx must have `nLockTime >= locktime`
  (same kind) and the input `nSequence = 0xfffffffd` (design section 3.1; opts in
  to BIP125 RBF so Bob can fee-bump a stuck refund).
* Signatures: DER, low-S, `SIGHASH_ALL`, BIP143 digest, scriptCode = the whole
  redeem script (no `OP_CODESEPARATOR`). Public keys must be 33-byte
  compressed (segwit standardness).
* The IF argument must be exactly `0x01` or empty (MINIMALIF policy); the
  builders and the checker enforce that.

```js
const { buildRedeemScript, p2wshAddress, decodeRedeemScript, verifyLock,
        buildClaimTx, buildRefundTx, checkHtlcSpend, extractPreimage } = require('./src');

const redeemScript = buildRedeemScript({ hashlock, alicePubkey, bobPubkey, locktime });
const address = p2wshAddress(redeemScript, 'signet');          // Bob funds this

// Counterparty (Alice) verifies what Bob shows her before locking on NOID:
verifyLock({ redeemScript, address, network: 'signet',
             expected: { hashlock, alicePubkey, bobPubkey, minLocktime, maxLocktime } });

// Alice claims (reveals s):
const claim = buildClaimTx({ redeemScript, utxo: { txid, vout, value }, destination: aliceAddr,
                             network: 'signet', preimage: s, keyPair: aliceKey, feeRate: 5 });
// Bob refunds after the timeout:
const refund = buildRefundTx({ redeemScript, utxo: { txid, vout, value }, destination: bobAddr,
                               network: 'signet', keyPair: bobKey, feeRate: 5 });
// claim.hex / refund.hex, .txid, .vsize, .fee, .outputValue

// Bob's watcher, on any tx seen spending the lock:
const s = extractPreimage(txHex, { hashlock });   // Buffer(32) or null; always re-checks sha256(s) == H
```

`decodeRedeemScript` is strict: it only accepts the exact bytes
`buildRedeemScript` would produce for the fields it extracts (non-minimal
pushes, PUSHDATA forms, extra opcodes, trailing bytes are all rejected). Show a
counterparty the script, not just the address.

### Network switch

`network` is a name (`'testnet'` default, `'signet'`, `'regtest'`, `'mainnet'`)
or a bitcoinjs-lib network object. The default can also come from
`BTC_NETWORK`. `signet` and `testnet4` use the same address and WIF
parameters as testnet (`tb1...`), so they are aliases. Mainnet is never
selected implicitly, and `scripts/demo.js` refuses it.

## Locktime semantics

* `locktime < 500,000,000` is an absolute **block height**; `>= 500,000,000` is
  a **UNIX time** in seconds, compared with median-time-past (BIP113), which
  lags wall-clock by about an hour. **Use block heights.**
* A height-`N` refund is mineable in block `N+1`; it is relayable once the tip
  is at height `>= N` (`isLocktimeReached(N, { tipHeight })`). A time-`N` refund
  needs `N <` MTP of the tip.
* The refund tx's `nLockTime` must be `>= locktime` and of the **same kind**
  (a height script cannot be satisfied by a time `nLockTime`, or vice versa).
* **Refund inputs must set `nSequence < 0xffffffff`.** A final sequence
  disables `nLockTime`, and `OP_CHECKLOCKTIMEVERIFY` then fails. We use
  `0xfffffffd` (the builder refuses `0xffffffff`).
* CLTV only gates the refund. Alice can claim at any time until a refund is
  actually mined. The swap's safety margin therefore comes from choosing this
  locktime **earlier** than the NOID-side timeout (see below).

## Roles and timeouts

Alice holds NOID and generated `s`; Bob holds BTC.

1. Alice runs `node src/secret.js`, shares only `H`, keeps `s`.
2. Alice locks NOID under `H` with the **longer** timeout `T_A`.
3. Bob verifies it, then funds the P2WSH address above (same `H`, Alice's and
   Bob's pubkeys) with the **shorter** timeout `T_B` (this `locktime`).
4. Alice verifies the script and the funding (`verifyLock`, confirmations,
   amount), then claims the BTC. The witness publishes `s`.
5. Bob's watcher calls `extractPreimage` on the claim (mempool or block) and
   claims on the NOID side before `T_A`.
6. If Alice never claims, Bob refunds at `T_B`; Alice reclaims NOID at `T_A`.

Margins: `T_A - T_B` must cover Bob noticing the reveal and claiming on NOID,
plus confirmation and clock-skew slack (hours, not minutes). Bitcoin block
intervals are exponentially distributed, so 144 blocks is "about a day", not
exactly. Alice should claim well before `locktime` with a generous fee: if the
claim is still unconfirmed when Bob's refund becomes valid, Bob can confirm the
refund, keep his BTC, and also use the `s` he saw in the mempool on NOID.

## How `s` becomes public

The claim witness contains `s` in the clear (32 raw bytes, second stack item).
It is visible to everyone as soon as the claim hits the mempool, before it
confirms. It cannot be stolen on Bitcoin: the claim also needs Alice's
signature, so seeing `s` does not let anyone else spend this output. It *can*
be used on any other lock that uses the same `H` on any chain, so **never reuse
`s` or `H`** across swaps.

Encoding is identical to the Ethereum leg (see `../eth/README.md`): `s` is 32
raw bytes, `H = SHA-256(s)` over exactly those bytes (not hex text, not
keccak256). The test vector `s = 00..00` gives
`0x66687aadf862bd776c8fc18b8e9f8e20089714856ee233b3902a591d0d5f2925`.
`src/secret.js` asserts, per generated secret, that this hashlock equals the
eth encoding, and `test/secret.test.js` also runs the real `eth/scripts/secret.js`
and compares.

The script constrains the *length* of the witness item: `OP_SIZE 32
OP_EQUALVERIFY` makes the claim fail unless `s` is exactly 32 bytes, like the
Ethereum and Parano1d legs. So even if you accept an `H` produced by someone
else, a revealed preimage is always the 32-byte value the other chains expect
(`H` taken from a longer or shorter preimage can never be claimed here).
`buildClaimTx` also refuses anything but 32 bytes, `checkHtlcSpend` flags a
claim whose preimage is not 32 bytes, and `extractPreimage` never returns one.

## Fees, RBF/CPFP, dust

* **The claim pays its own fee.** There is a single input (the HTLC) and a
  single output, so `output = amount - fee`. Measured: claim to a P2WPKH
  address is about 139 vB, refund about 131 vB (the claim carries the 32-byte
  preimage). Give `feeRate` (sat/vB, sized with a worst-case 73-byte signature
  so the real rate is slightly higher) or an absolute `fee`.
* **Dust.** The output must be above the dust threshold or it will not relay:
  294 sats (P2WPKH), 330 (P2WSH, P2TR), 546 (P2PKH) at the default 3 sat/vB
  dust rate. The builders throw below it. A lock that is too small relative to
  fee rates may be uneconomic to claim or refund, so lock well above
  `~150 vB * expected feeRate + dust`.
* **RBF.** Both inputs use `nSequence = 0xfffffffd` (design section 3.1; opts in to
  BIP125). Alice can re-sign the same claim at a higher fee (the replacement
  reveals the same `s`), and Bob can re-sign a refund stuck in the mempool at a
  higher fee (`nLockTime` and the script's CLTV are unchanged, and `0xfffffffd`
  is still below `0xffffffff`, so CLTV stays enforced). Only the key holder can create a
  conflicting spend of a given branch, but the *two branches conflict with each
  other* near the locktime, and whichever confirms first wins.
* **CPFP.** The claim output pays Alice directly, so she can spend the
  unconfirmed output in a child with a high fee to pull the parent in. Bob
  cannot do this for Alice, and the HTLC itself has no anchor output. Fee
  bumping the claim is Alice's job; do it before the locktime, not after.
* There are no additional inputs, so a claim cannot be fee-bumped by adding
  inputs (that would need `SIGHASH_ANYONECANPAY`, not used here).
* Always run `testmempoolaccept` on a real node before broadcasting. The
  checker in `src/verify.js` is a minimal re-implementation of this one script
  and is not a substitute.

## Taproot alternative (out of scope for v1)

A P2TR output with two tapleaf scripts (hash-and-sig leaf; CLTV-and-sig leaf)
would hide whichever branch is not used, shrinking the footprint and making the
swap look like an ordinary spend until a leaf is revealed.

## Live run (signet)

Tooling for one real swap leg on Bitcoin **signet**, without a local node. All
reads and the broadcast go through a public explorer REST API. **Signet only**:
`scripts/live.js` refuses mainnet keys (WIF prefix `5`/`K`/`L`), mainnet or
regtest addresses (`bc1…`, `1…`, `3…`, `bcrt1…`), and any API base whose path
does not contain `/signet/`, with an error that says why (real BTC must never
touch this before milestone M4). Signet coins have no value, but they are the
rehearsal for real ones, so the same discipline applies: fresh secret per swap,
dry run first, go-ahead before every `--send`.

Plain words: on Bitcoin there is no contract, only a *script*. Bob pays signet
coins to an address that is the hash of the script above. The coins can leave
that address in exactly two ways: Alice signs **and** shows the secret `s` (the
*claim*, which is the *reveal*), or Bob signs after block height `T_b` (the
*refund*). The explorer API is a window onto the chain: it tells us the tip
height, whether the address is funded, and whether (and how) the coins left.

### API

| Variable | Default | Meaning |
|---|---|---|
| `BTC_API_URL` | `https://mempool.space/signet/api` | primary Esplora-style base (must contain `/signet/`) |
| `BTC_API_FALLBACK_URL` | `https://blockstream.info/signet/api` | used only on transport errors / 5xx (never for a 4xx, so a tx is never posted twice); `""` disables |

Endpoints used (`src/esplora.js`): `GET /blocks/tip/height`, `GET /address/:addr/utxo`,
`GET /tx/:txid`, `GET /tx/:txid/hex`, `GET /tx/:txid/status`, `GET /tx/:txid/outspend/:vout`,
`GET /fee-estimates`, `POST /tx` (body = raw hex, answer = txid). Fee rate = the
API's estimate for a 2-block target, rounded up, **floor 1 sat/vB, cap 50 sat/vB**
(on 2026-11-04 blockstream's signet `fee-estimates` returned 3,901 sat/vB for
some targets; the cap is not optional). `--fee-rate N` overrides within the same bounds.

Verified live on 2026-11-04 (read-only): tip height, address utxo, tx, tx hex,
tx status, outspend (spent and unspent), fee-estimates on both hosts, the 404
shape, and the fallback (primary pointed at a dead host, blockstream answered).
The only `POST /tx` ever made was a deliberate 1-byte invalid body to record the
error shape (`400`, "TX decode failed"); **no transaction has been broadcast.**

### Commands

All output is one JSON object on stdout; errors go to stderr with exit code 1.
`lock`, `claim`, `refund` and `broadcast` are **dry runs by default** (build,
sign, self-check with `src/verify.js`, print the hex, send nothing); add
`--send` to broadcast. Keys live in `btc/keys/` (git-ignored at the repo root)
and are never printed. The secret is read from `--secret-file` or stdin, never
from argv (`--secret` / `--preimage` are rejected).

| Command | Flags | Output (main fields) |
|---|---|---|
| `keygen` | `--out FILE` | `address` (P2WPKH `tb1q…`), `pubkey`, `keyFile`. Refuses to overwrite |
| `address` | `--hashlock H --alice-pubkey P --bob-pubkey P --locktime N`, or `--witness-script HEX` | `address` (P2WSH), `witnessScript`, `scriptPubKey`, decoded terms |
| `balance ADDRESS` | | `confirmedSats`, `unconfirmedSats`, `utxos[]`, `tipHeight` |
| `tip` | | `tipHeight`, `api`, `apiAnswered` |
| `lock` | `--key-file BOB --hashlock H --alice-pubkey P --locktime N --amount-sats S [--bob-pubkey P] [--fee-rate N] [--allow-unconfirmed] [--send]` | `txid`, `vout`, `outpoint`, `address`, `witnessScript`, `fee`, `feeRate`, `changeSats`, `hex`, `blocksToLocktime`, `claimCutoffHeight`, `warnings[]`, `sent` |
| `status` | `--txid T --vout V` + script (`--witness-script` or the four terms) | `funded`, `valueSats`, `confirmed`, `confirmations`, `refundableAtTip`, `spent`, `spend{txid, branch, scriptCheck}`, `preimage`, `state` |
| `claim` | `--key-file ALICE --txid T --vout V --to ADDR [--secret-file F] [--fee-rate N] [--ignore-cutoff] [--allow-unconfirmed] [--send]` + script | `txid`, `outputSats`, `fee`, `nSequence 0xfffffffd`, `hex` (**contains `s`**), `warnings[]`, `sent` |
| `refund` | `--key-file BOB --txid T --vout V --to ADDR [--fee-rate N] [--send]` + script | `txid`, `nLockTime = T_b`, `nSequence 0xfffffffd`, `hex`, `sent` |
| `broadcast HEX` | `[--send]` | decoded `txid`, `inputs[]`, `outputs[]`; posts only with `--send` |
| `watch` | `--txid T --vout V [--interval-seconds 30] [--until-height N] [--max-polls N]` + script | the `status` object plus `watch{polls, stoppedBecause}`; `preimage` once a claim is seen |

Guards built into the commands (design §3.3): `lock` refuses the two public
test-vector hashlocks, a locktime at or below the tip, a time-based locktime,
and more than 4,320 blocks (typo guard); it warns below 12 blocks. `claim`
refuses to broadcast once the tip is past `T_b − 6` (`--ignore-cutoff` to
override, with a warning: Bob's refund could confirm first and he would keep
the BTC *and* learn `s`). `refund` refuses before the tip reaches `T_b`.
Every spend is re-checked with `checkHtlcSpend` and, for a claim, with
`extractPreimage`, before the hex is printed.

### Getting signet coins

Signet coins have no value and come from faucets. Bob needs them (he funds the
lock); Alice needs none (the claim pays its own fee out of the lock).

* `https://signetfaucet.com` and `https://alt.signetfaucet.com`: paste Bob's
  `tb1q…` address from `keygen`. Both are rate-limited and **may refuse some network
  addresses**; if refused, ask someone on signet to send a few thousand sats.
* Amount: a rehearsal needs the lock amount plus ~1,000 sats of fees;
  100,000 sats is comfortable.
* Check with `node scripts/live.js balance BOB_ADDR` and wait for `confirmedSats`.

### Command sequence (one swap, BTC leg)

Mirrors `docs/live-run-1.md` with the ETH leg replaced. Alice holds NOID and
makes the secret; Bob holds signet BTC. Run everything from `btc/`.

```sh
cd btc

# 0. Keys (writes btc/keys/*.key, prints address + pubkey only; refuses to overwrite)
node scripts/live.js keygen --out keys/bob.key      # -> BOB_ADDR, BOB_PUB
node scripts/live.js keygen --out keys/alice.key    # -> ALICE_PUB (Alice sends it to Bob in step 0 of the design)
#    Fund BOB_ADDR from a faucet, then:
node scripts/live.js balance BOB_ADDR

# 1-4. NOID side exactly as in docs/live-run-1.md: Alice's secret and hashlock H
#    (swap-cli new-alice, or `node src/secret.js --json`), the equivalence proof,
#    Bob's checks, Alice funds the Parano1d lock with deadline D, 18-block finality.

# 5. Bob locks BTC (design §3.3 step 8'): T_b = current signet tip + 24
node scripts/live.js tip                                    # -> TIP
node scripts/live.js lock --key-file keys/bob.key --hashlock H --alice-pubkey ALICE_PUB \
    --locktime $((TIP + 24)) --amount-sats 100000           # dry run: hex, address, witnessScript, txid
node scripts/live.js lock --key-file keys/bob.key --hashlock H --alice-pubkey ALICE_PUB \
    --locktime $((TIP + 24)) --amount-sats 100000 --send    # GO-AHEAD NEEDED
#    Bob -> Alice: outpoint (txid:vout), witnessScript, T_b. Bob keeps the JSON.

# 6. Alice checks the lock (design step 9'): rebuild the script from (H, ALICE_PUB, T_b, BOB_PUB)
node scripts/live.js address --hashlock H --alice-pubkey ALICE_PUB --bob-pubkey BOB_PUB --locktime T_B
#    -> address and witnessScript must equal what Bob sent; then
node scripts/live.js status --txid TXID --vout 0 --witness-script WS
#    -> funded: true, valueSats = amount, confirmations >= 3, state "funded (claimable)",
#       and tipHeight <= claimCutoffHeight (T_b - 6) with margin (T_b - tip >= 12).

# 7a. Happy path: Alice claims (the reveal). The secret comes from a file or stdin, never argv.
node scripts/live.js claim --key-file keys/alice.key --txid TXID --vout 0 --witness-script WS \
    --to ALICE_PAYOUT_ADDR --secret-file keys/alice.secret            # dry run; the hex IS the reveal
node scripts/live.js claim --key-file keys/alice.key --txid TXID --vout 0 --witness-script WS \
    --to ALICE_PAYOUT_ADDR --secret-file keys/alice.secret --send     # GO-AHEAD NEEDED
#    Bob watches and learns s as soon as the claim is in the explorer's mempool:
node scripts/live.js watch --txid TXID --vout 0 --witness-script WS --until-height T_B   # -> "preimage": "0x..."
#    then Bob closes the NOID contract to himself (swap-cli claim) before D - 18.

# 7b. Failure path: nobody claimed. Once tip >= T_b, Bob refunds (refused locally before then).
node scripts/live.js refund --key-file keys/bob.key --txid TXID --vout 0 --witness-script WS --to BOB_ADDR
node scripts/live.js refund --key-file keys/bob.key --txid TXID --vout 0 --witness-script WS --to BOB_ADDR --send
#    Alice recovers her NOID at D.
```

Notes:

* Alice should claim early: her cutoff is `T_b − 6` blocks (design step 10').
  Signet blocks come every ~10 min on average with a wide spread; 24 blocks is
  "about 4 hours", not exactly. A claim still unconfirmed at `T_b` can lose the
  race to Bob's refund, and Bob then has both the BTC and `s`.
* `claim` and `refund` compare against the explorer's **tip**, not your clock.
  A refund says "too early" until the tip is at `T_b`; the node is the judge.
* The claim hex contains the secret as witness item 2. Treat a dry-run claim
  JSON as the secret itself until you broadcast it.
* To fee-bump an unconfirmed claim, run `claim` again with a higher
  `--fee-rate`; the input signals RBF (`0xfffffffd`). (`status` will say the
  outpoint is "already spent" by the first claim once the explorer sees it, so
  build the bump with the library if that happens.) The refund signals RBF too
  (`0xfffffffd`), so Bob can bump a stuck refund the same way.
* `status` / `watch` need the witness script (or its four terms) so they can
  check that the outpoint really pays *this* HTLC and so `extractPreimage` can
  re-check `sha256(s) == H`; a spend of someone else's script never yields a preimage.

### How `swap-cli` would consume this (not implemented in `swap-cli/`)

`swap-cli` has no Bitcoin watcher yet (TASKS M3.1). The JSON above carries
exactly the §3 artifacts, so the hand-off would be:

* **Bob, after `lock --send`**: `txid`, `vout`, `amountSats`, `witnessScript`,
  `locktime` (= `T_b`) and `bobPubkey` go into his swap file as the BTC-leg
  record; the same values are what he sends Alice (she rebuilds the script herself).
* **Alice's gate before revealing** (step 9'): the `status` output (`funded`,
  `valueSats`, `confirmations ≥ 3`, `tipHeight ≤ claimCutoffHeight`) is what
  the engine's reveal gate would read, plus equality of her own `address`
  output with Bob's.
* **Bob's reveal detection** (step 11'): `watch` (or `status` inside his `tick`)
  returns `preimage` with `preimageMatchesHashlock: true` as soon as the claim
  is in the explorer's mempool; that is the value his `claim_noid` step needs.
  A Rust port would call the same six GET endpoints; the fixtures in
  `test/fixtures/signet/` show the exact response shapes.
* **Abort**: `refund` at `tipHeight ≥ locktime` mirrors `refund_eth`.

### Regtest alternative

For a local loop without public infrastructure use `-regtest`
(`generatetoaddress` mines blocks, so the refund timeout is reachable instantly);
pass `network: 'regtest'` to the library (addresses start with `bcrt1`).
`scripts/live.js` does not support regtest; use the library directly and
`bitcoin-cli -regtest testmempoolaccept '["<hex>"]'` on the hex it prints.

## bitcoinjs-lib 7.x notes

* v7 uses `bigint` for satoshi values (`addOutput`, `hashForWitnessV0`) and
  `Uint8Array` rather than `Buffer`; it still ships a CommonJS build, used here.
  This library accepts numbers or bigints and hex or bytes, returns `Buffer`s.
* There is no `signet` network object; use `testnet`.
* `script.number.encode` returns a `Uint8Array` (wrap in `Buffer` before
  printing or hex-ing), and `script.compile` turns a lone byte 1..16 into
  `OP_1..OP_16`; `decompile` then returns the opcode number, not a buffer
  (handled in `decodeRedeemScript`).
* `script.toASM` renders `OP_CHECKLOCKTIMEVERIFY` (0xb1) as `OP_NOP2`.
* `Psbt` is not used: its finalizer assumes standard templates, so witnesses
  are built by hand with `Transaction.hashForWitnessV0` and `setWitness`. That
  digest is checked in the tests against both the official BIP143 vector and an
  independent hand-rolled implementation.
* There is no script interpreter. `src/verify.js` covers just this template.
