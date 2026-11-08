# Fuzz and invariant campaign: `HTLC.sol` and `HTLCERC20.sol`

Scope: `eth/contracts/HTLC.sol` (native ETH) and `eth/contracts/HTLCERC20.sol` (ERC-20), exactly as committed.
`eth/contracts/HTLC.sol` is untouched (the swap tool pins its compiled code hash; its findings are documented in `eth/README.md`). `HTLCERC20.sol` was changed after the campaign (header comment corrected, `InvalidReceiver` check added, section 3); nothing pins it. All other new files are test code:

| File | What |
|---|---|
| `eth/test/fuzz.test.js` | the campaign (seeded, deterministic) plus 21 deterministic reproductions, one per finding or documented behaviour |
| `eth/contracts/test/FuzzActor.sol` | a contract account that can be sender, receiver or caller; its `receive()` can accept, reject, re-enter, burn all gas or return a large blob |
| `eth/contracts/test/FuzzToken.sol` | an ERC-20 whose misbehaviour is switched at run time (fee in / out / on top, reverting, returning false, lying, re-entering, paused, blacklist, negative rebase) |
| `eth/contracts/test/NoReturnToken.sol` | a USDT-style token whose functions return nothing |
| `eth/contracts/test/ForceSend.sol` | pushes ETH into a contract with no `receive()` (self-destruct) |
| `eth/contracts/test/HTLCMutant.sol` | copies of the two contracts with one planted bug each, to prove the campaign detects bugs (section 5). Test-only, not deployment candidates |

Run it:

```sh
cd eth
npx hardhat test test/fuzz.test.js                      # default: quick, 200 ETH + 200 ERC-20 sequences (~1 min)
FUZZ_N=2000 npx hardhat test test/fuzz.test.js          # the full campaign of section 4, ~6-10 min
FUZZ_N=10000 npx hardhat test test/fuzz.test.js         # more sequences
FUZZ_START=500 FUZZ_N=500 npx hardhat test test/fuzz.test.js --grep "ETH"   # low-memory machines: run slices in separate processes
FUZZ_SEED=other FUZZ_STEPS=40 npx hardhat test test/fuzz.test.js --grep "random sequences"
FUZZ_SEED=noid-swap-fuzz-1 FUZZ_ONLY=71 FUZZ_KIND=eth FUZZ_TRACE=1 npx hardhat test test/fuzz.test.js --grep reproduce
```

A failing sequence prints its seed, index and the last 40 steps, and the exact `FUZZ_ONLY` command to replay it.
Environment: `FUZZ_N` (sequences per campaign, default 200 so that a plain `npx hardhat test` stays fast; all numbers in section 4 are from `FUZZ_N=2000`), `FUZZ_SEED` (default `noid-swap-fuzz-1`, printed at the
start), `FUZZ_STEPS` (max random steps per sequence, default 16), `FUZZ_START` (first sequence index, default 0), `FUZZ_ONLY` / `FUZZ_KIND`, `FUZZ_TRACE=1`,
`FUZZ_MUTANT` / `FUZZ_MUTANT_ERC20` (section 5).

## 1. Result in one paragraph

No real bug in `HTLC.sol`. Every invariant below held in all runs (the exact counts are in section 4): no double
settlement, no wrong payee, no payment outside the timelock windows, no id collision, no re-entrancy effect, events
equal state, balances equal the sum of open locks plus force-sent surplus. `HTLCERC20.sol` had **one real (minor)
missing validation** (F-ERC20-2: `receiver == address(this)` was accepted and burned the funds into the contract; now refused with
`InvalidReceiver`) and **one over-stated claim in its header** (F-ERC20-1: "fee-on-transfer / rebasing tokens are rejected" only
holds for the inbound transfer; header corrected, as is the blocked-sender case F-ERC20-3). Everything else found is an unsafe-but-documented (or documented-but-understated) behaviour that comes
from the trust placed in the receiver address or the token, listed in section 3 with a reproducing test each. The swap
tool already gates the dangerous ETH cases (both parties must be EOAs) and does not use `HTLCERC20` yet.

## 2. What was fuzzed, and the invariants

Each sequence starts from a fresh chain snapshot (`evm_snapshot` / `evm_revert`) and performs 4 to 16 random steps
(`FUZZ_STEPS`), then a "drain" phase. A pure-JS reference model predicts for **every** transaction: success or the exact
custom error (including the order in which checks fire), the exact events, and the exact ETH / token balance of every
party. After every transaction the chain is compared with the model. The block timestamp of each transaction and a gas
price of 0 are fixed, so every run is reproducible bit for bit from the seed (plain JavaScript PRNG, `mulberry32` seeded
from a string hash of `seed:campaign:index`).

Random actors: four EOAs, four `FuzzActor` contracts (usable as sender, receiver or caller; their mode changes during the
sequence), two outsider addresses (one is the SHA-256 precompile), the zero address and the HTLC itself as receivers.
Random amounts (0, 1, small, huge), random timelocks around `block.timestamp` (in the past, equal, +1 to +3 h), time
warps that land exactly on `timelock - 1`, `timelock` and `timelock + 1` about 35 % of the time, hashlocks drawn from a
small pool (so locks share hashlocks) or zero or random, duplicate and near-duplicate parameter tuples, preimages that
are right, wrong, all-zero, the hashlock itself, 31 bytes, 33 bytes (right first, or shifted by one byte) and empty
(raw calldata), dirty upper address bits, plain ETH sends, force-sent ETH. ERC-20 side: three tokens (two `FuzzToken`,
one `NoReturnToken`), runtime modes and blacklists, approvals that are exact, unlimited, zero or missing, donations and
negative rebases of the contract's balance.

Invariants checked (A = after every transaction, S = at the end of every sequence):

| # | Invariant | When |
|---|---|---|
| I1 | ETH conservation: contract balance == sum of open (unclaimed, unrefunded) locks + force-sent surplus | A |
| I2 | Token conservation: for a token that never misbehaved, balance == sum of open locks + donations; for a misbehaving token the balance still equals the model exactly, and every case of balance < sum(open) is counted by cause | A |
| I3 | Exact balance of every party and of the contract equals the model (so a payment can only go to the stored receiver / sender, once) | A |
| I4 | A lock is claimed or refunded, never both, never twice (state flags, error priority, and the event log replayed independently: at most one of `Claimed` / `Refunded` per `Locked`) | A, S |
| I5 | A claim succeeds only with the right 32-byte preimage and only while `ts < timelock`; a refund succeeds only for the sender and only when `ts >= timelock` (boundaries `timelock - 1`, `timelock`, `timelock + 1` are hit thousands of times, section 4) | A |
| I6 | Lock ids never collide: a JS map from id to parameter tuple asserts that an id never belongs to two tuples; the contract's id equals the JS keccak of the packed fields | A |
| I7 | Events equal state: every receipt carries exactly the expected events with the expected arguments; at the end the whole log of the sequence equals the model's event list, and `Locked` / `Claimed` / `Refunded` sets match the final lock flags | A, S |
| I8 | No re-entrancy effect: hostile receivers (ETH) and hostile tokens (ERC-20) try `claim`, `refund` and `newLock` from inside the payment, on the lock being paid and on every other known lock; the count of successful re-entrant calls must be 0, and balances must still match the model | A, S |
| I9 | A receiver that rejects ETH makes `claim` revert with `TransferFailed` and leaves the lock claimable later (if the receiver recovers before the timelock) or refundable after it | A, S (drain) |
| I10 | Liveness of the sender's refund: after every actor is cooperative again and time has passed, every open lock refunds, and the contract keeps only the force-sent surplus (ETH) or the donated tokens (untainted ERC-20) | S |
| I11 | Gas of `claim` / `refund` per receiver class (max reported in section 6) | A |

Lock ids (asked explicitly): the contract **refuses** a second lock with identical (sender, receiver, amount, hashlock,
timelock) with `LockAlreadyExists`, also after the first lock was claimed (state is never deleted). The id is
`keccak256(abi.encodePacked(...))` of fixed-width fields only (20 + 20 + 32 + 32 + 32 bytes, or 20 + 20 + 20 + 32 + 32 + 32
for ERC-20) so it is injective; locks that differ in any single field, including the same hashlock with another
receiver, are distinct and distinguishable. Nobody can create a lock in another account's name (the sender is `msg.sender`),
so ids cannot be squatted. Consequence: a retried swap must change the timelock or the amount (reproduced in
`I-ETH-1`).

## 3. Findings

Severity scale: **Real bug** = contract behaviour that should be corrected; **Unsafe, documented** = behaviour the
contract's own notes describe; **Unsafe, not (fully) documented** = true behaviour the notes do not state or understate;
**Info** = behaviour worth knowing, no action. None is a theft or double-spend; none is exploitable by a third party
against an honest EOA sender and EOA receiver. Each id is the prefix of the test title in `eth/test/fuzz.test.js`.

### Real bug (minor)

**F-ERC20-2, Low, FIXED in `HTLCERC20.sol`: `newLock` accepted `receiver == address(this)`; `claim` then settled the lock and the tokens
stayed in the contract for good.** The payout was a self-transfer, `claimed = true`, no later call could move the tokens
(refund reverted `AlreadyClaimed`). Found by the campaign in 21 of 2,000 sequences (the random receiver picker includes the
contract's own address). Only the sender's own mistake lost funds (nobody else can choose the receiver), but the check is
one line. The ETH contract is not affected: `claim` reverts `TransferFailed` (no `receive()`), the sender refunds. Same
family, not fixable on-chain: a token contract as receiver (`receiver == token`) usually strands the tokens in the token
contract. Applied fix (a new error, checked right after `ZeroReceiver`):

```diff
--- a/eth/contracts/HTLCERC20.sol
+++ b/eth/contracts/HTLCERC20.sol
     error ZeroReceiver();
+    error InvalidReceiver();
@@ function newLock(
         if (receiver == address(0)) revert ZeroReceiver();
+        if (receiver == address(this)) revert InvalidReceiver();
```

`sender == address(this)` is not reachable (the contract never calls itself), so only the receiver is checked. Regression test:
`REGRESSION F-ERC20-2 (fixed)`; the ERC-20 campaign model now expects `InvalidReceiver` and the 4 % of random locks that
name the contract as receiver exercise it. The ABI gained one error; `HTLCERC20` is not wired into `swap-cli` and nothing
pins its code, so no pin changed.

### Unsafe, not (fully) documented

**F-ERC20-1, Low-to-Medium (token trust): the header of `HTLCERC20` says fee-on-transfer and rebasing tokens "are rejected".
That is only true for the inbound transfer in `newLock`.** The check `balance grew by exactly amount` is never made on the
payout in `claim` / `refund`. Reproduced precisely:

* Fee charged on the payout (`FEE_OUT`): `claim` succeeds, the lock is `claimed`, the receiver gets 99 % of the amount.
* Fee charged on top, taken from the contract (`FEE_ON_TOP`): the contract pays `amount` and loses a further 1 %, so the
  last lock of that token is no longer fully backed: `claim` and `refund` of it both revert `ERC20InsufficientBalance`
  (funds stuck). Seen in 6 of 2,000 sequences.
* Token that returns `true` from `transfer` without moving anything: `claim` succeeds and the tokens stay in the contract.
* Negative rebase / confiscation of the contract's balance after locking: the last claimer or refunder is short and
  both `claim` and `refund` revert `ERC20InsufficientBalance`. Seen in 125 of 2,000 sequences.
* The inbound check does its job: a 1 % fee token is rejected (`UnsupportedToken`, whole transaction reverted, nothing
  moves) except for amounts below 100 units, where the fee rounds to 0 and the contract really did receive the full
  amount (correct behaviour).
* Tokens that return `false` revert `SafeERC20FailedOperation`; tokens that return nothing (USDT style) work; a token
  address that is an EOA, the HTLC itself or a contract without `balanceOf` makes `newLock` revert.

Tests (they assert the behaviour, which is now documented): `fee-on-transfer token`, `DOCUMENTED F-ERC20-1`,
`DOCUMENTED F-ERC20-1 (b)`, `token that returns false`, `negative rebase`. Action taken: the header comment of
`HTLCERC20.sol` now says that only the inbound transfer is checked and lists the outbound cases; the token allow-list should be
restricted off-chain to plain ERC-20s without fee switches, pausing or rebasing. An on-chain hardening exists but trades one
failure for another (a short payment becomes an unclaimable and unrefundable lock), so it is NOT applied; the diff, for a later
decision:

```diff
-        l.token.safeTransfer(l.receiver, l.amount);
+        _payOut(l.token, l.receiver, l.amount);
@@ refund
-        l.token.safeTransfer(l.sender, l.amount);
+        _payOut(l.token, l.sender, l.amount);
@@
+    /// Reverts unless exactly `amount` left this contract and exactly `amount` reached `to`.
+    function _payOut(IERC20 token, address to, uint256 amount) private {
+        uint256 c0 = token.balanceOf(address(this));
+        uint256 r0 = token.balanceOf(to);
+        token.safeTransfer(to, amount);
+        if (c0 - token.balanceOf(address(this)) != amount || token.balanceOf(to) - r0 != amount) revert UnsupportedToken();
+    }
```

**F-ETH-1, Low: a sender that cannot accept ETH has no refund path; once the timelock has passed the funds are locked for ever.**
`HTLC.sol`'s notes warn only about the receiver. `refund` pays `l.sender` with a low-level call; a sender contract whose
`receive()` reverts (or burns gas) makes `refund` revert `TransferFailed` for ever (reproduced ten years after the
timelock). After the timelock `claim` is also closed, so nobody can move the funds; before it, only a claim with the
preimage can. It is recoverable only if the sender contract can later accept ETH again. Test: `DOCUMENTED F-ETH-1`
(sender and receiver both rejecting). Mitigation already in place: `swap-cli` requires `eth_getCode(sender) == 0x` and
`eth_getCode(receiver) == 0x` (`swap-cli/src/watch/mod.rs`, T11). Action taken: written up in `eth/README.md` (Hazards); `HTLC.sol`
is not touched, not even its comments (a comment change alters the metadata hash in the bytecode, and so the pinned code hash).

**F-ETH-2, Low (Medium if the EOA gate were ever dropped): a claim that reverts still publishes the preimage.**
When the receiver rejects ETH, `claim` reverts `TransferFailed`: state is rolled back and no `Claimed` event exists, but
the transaction (and the mempool entry before it) carries the 32-byte preimage in its calldata. The documented hazard
says "the swap cannot complete and the sender can refund"; it does not say that the counterparty can read the preimage
from the failed transaction and take the other leg (on Parano1d) while the ETH waits for the refund. So the loss would be
the receiver's principal, not just a delay. Also an event-only watcher does not see it. Test:
`DOCUMENTED F-ETH-2` (asserts the preimage is in the failed transaction's data and that no `Claimed` event exists).
Mitigations in place: EOA-only receiver gate in `swap-cli`; a receiver can only hurt itself. Residual cases the gate cannot
see: an address that is empty at lock time and gets a contract later (counterfactual deployment) or a later EIP-7702
delegation; both are the receiver's own choice. Action taken: written up in `eth/README.md` (Hazards).

**F-ERC20-3, Low (token trust): a token that reverts on transfers to the sender blocks `refund`; the header only mentions
a blocked receiver.** Reproduced: blocked receiver: `claim` reverts, sender refunds after the timelock; blocked sender:
`refund` reverts, `claim` still works; both blocked: both revert until one is unblocked; paused token: both revert, both
work again after unpausing (funds not lost, only delayed). Action taken: header of `HTLCERC20.sol` now covers the sender case. Test: `DOCUMENTED F-ERC20-3`, `token whose transfer reverts`.

### Info (no action)

* **I-ETH-1 ids / duplicates**: described in section 2. Test `INFO I-ETH-1`.
* **I-ETH-2 boundaries**: claim works at `timelock - 1`, fails at `timelock` (`TimelockExpired`); refund fails at
  `timelock - 1`, works at `timelock`. The windows are disjoint and exhaustive; there is no instant at which both work or
  neither works. A lock with `timelock == block.timestamp` of its own creation block is refused. Test: `boundary:`.
* **I-ETH-3 preimage forms**: only the right 32 bytes pay. 31 bytes or none: reverts in the ABI decoder (empty revert
  data). Trailing bytes after the 32-byte preimage are ignored by the ABI decoder, so a 33-byte argument whose first 32
  bytes are right pays; one whose last 32 are right does not. Not a risk (the preimage is public once used). `keccak256(s)`
  and the hashlock itself are rejected. Dirty upper address bits in `newLock` revert. Test `INFO I-ETH-3`.
* **I-ETH-4 zero secret**: a lock whose secret is 32 zero bytes is claimed with `getLock().preimage` still 0, so
  "preimage != 0" does not mean "claimed"; use the `claimed` flag or the event. `swap-cli` uses the flag and the logs.
  Irrelevant for a CSPRNG secret. Test `INFO I-ETH-4`.
* **I-ETH-5 surplus**: ETH pushed in by `selfdestruct` cannot be withdrawn by anyone; the conservation invariant is
  `balance == sum(open) + surplus`. Plain ETH sends to the contract revert. Test `INFO I-ETH-5`.
* **I-ETH-6 gas**: honest `claim` and `refund` are cheap and bounded (section 6). `claim` / `refund` forward all
  remaining gas to the payee, so a hostile payee can burn the whole gas limit of whoever called (5.9 M gas of a 6 M limit
  in the test, and the call still reverts `TransferFailed`), and the returned data is copied into the caller's memory (a
  500,000-byte return costs the claimer 1.19 M gas against 96 k for none; the payee pays a similar amount to produce it).
  The caller chooses the gas limit, and the payee is the party that loses a claim, so this only matters for a third-party
  caller; the swap protocol has none. Test `INFO I-ETH-6`.
* **I-ETH-7 re-entrancy**: the single global `nonReentrant` guard blocks re-entry into any function, on the same lock and
  on other locks; state is final before the payment (a hook that reads `getLock` while being paid sees `claimed == true` /
  `refunded == true`), so even a view-only (read-only) re-entrancy sees consistent data. Test `re-entrancy:`.
* A receiver or sender that is the HTLC ETH contract itself, a precompile, or an address with no code behaves as expected
  (`TransferFailed` for the contract itself; plain payment for the others).

## 4. Seeds and counts run

Full run, measured before the three source changes above (`FUZZ_SEED=noid-swap-fuzz-1`, `FUZZ_N=2000`, `FUZZ_STEPS=16`), result **37 passing, 0 failing**
(2 x 8 chunks of 250 sequences, plus the 21 deterministic tests; wall time 9 min 37 s on the owner's machine while other
jobs ran):

| | ETH `HTLC` | `HTLCERC20` |
|---|---|---|
| random sequences | 2,000 | 2,000 |
| transactions (chain-checked against the model) | 46,689 | 38,274 |
| locks created | 5,927 | 4,139 |
| duplicate lock refused (`LockAlreadyExists`) | 71 | 82 |
| claims that paid | 379 (319 exact + 60 with 33 bytes, right first 32) | 444 |
| claims at `timelock - 1` that paid / at `== timelock` refused | 46 paid / 66 `TimelockExpired` | (same logic) |
| refunds at `== timelock` that paid / at `timelock - 1` refused | 60 / 61 (plus 16 `TransferFailed` at `== timelock`) | (same logic) |
| `TransferFailed` (claim 85, refund 187, rejecting or gas-burning payees) | 272 | token-side reverts (`Error`, `SafeERC20FailedOperation`, `ERC20Insufficient*`, `Panic`): 400 |
| re-entry attempts that were made / that succeeded | 1,542 / **0** in total over both campaigns (181 `receive()` hook runs on the ETH side, the rest are token hooks) | |
| lock ids that collided | **0** | **0** |
| invariant violations | **0** | **0** |

ERC-20 campaign, token-instances that misbehaved at least once, by cause: negative rebase 125, tokens that stayed after a
lying `transfer` 47, fee on the payout 29, fee on top of the payout 6, receiver == the contract itself 21. Sequences that
ended with balance < sum of open locks: negative rebase 106, fee on top 5, both 1. Every one of them matched the model
exactly (the campaign asserts the model first, then counts the cause), and the drain could not refund 116 locks, all with
`ERC20InsufficientBalance` after a rebase or a fee on top.

Additional runs (same code, other seeds):

| Seed | Steps | ETH sequences | ERC-20 sequences | Result |
|---|---|---|---|---|
| `noid-swap-fuzz-1` (above) | 16 | 2,000 | 2,000 | pass |
| `noid-swap-fuzz-1` again, split into 500-sequence processes (`FUZZ_START`) with the 21 deterministic tests | 16 | 2,000 | 2,000 | pass (9 min 32 s) |
| `noid-swap-fuzz-2` | 40 | 1,000 | 500 | pass; the process was killed by an operating-system memory failure ("memory allocation ... failed") in the next chunk, so the ERC-20 half stopped at 500 |
| `noid-swap-fuzz-3` | 16 | 2,000 | 1,000 | pass; the process was ended by a session restart during the ERC-20 chunk 1000..1249 |

Distinct sequences that passed: 8,500 (seed 1: 4,000; seed 2: 1,500; seed 3: 3,000), none failing. The two interrupted runs
were not repeated for the missing sequences. The machine had under 1 GB of free memory; a single-process run of 4,000
sequences died of an operating-system allocation failure twice (not a test failure; the same run passed once with more free
memory, and the split mode above is the robust way to run it: `FUZZ_START=500 FUZZ_N=500` per process).

The whole suite (`npx hardhat test`, fuzz file included, one process): with `FUZZ_N=2000` 195 passing, 0 failing, 9 min 24 s (before the source changes of section 3); with the new default of 200 + 200 sequences 181 passing, 0 failing, 2 min 35 s (the fuzz file alone: 23 passing, 59 s). The ERC-20 mutant check was re-run after adding `InvalidReceiver` and still fails as intended.

Reproduction: `FUZZ_SEED=<seed> FUZZ_ONLY=<index> FUZZ_KIND=eth|tok FUZZ_TRACE=1` replays one sequence step by step.

## 5. Does the campaign bite? (mutation check)

`contracts/test/HTLCMutant.sol` has a copy of each contract with one planted bug chosen by a constructor argument.
`FUZZ_MUTANT=n` (ETH) or `FUZZ_MUTANT_ERC20=n` swaps the contract under test. Every mutant was caught, in at most the first
250 (ETH) or 400 (ERC-20) sequences:

| Mutant | Planted bug | Caught as |
|---|---|---|
| ETH 1 | claim also allowed at `ts == timelock` | expected `TimelockExpired`, got `TransferFailed` (sequence 71) |
| ETH 2 | refund refused at `ts == timelock` | expected success, reverted `TimelockNotExpired` |
| ETH 3 | refund callable by anyone | expected `NotSender`, got `TimelockNotExpired` |
| ETH 4 | payment before effects, no guard | events differ from the model (re-entrant double claim) |
| ETH 5 | id omits the timelock | events differ from the model (id mismatch) |
| ETH 6 | claimed lock can be claimed again | expected `AlreadyClaimed`, got `InvalidPreimage` |
| ETH 8 | refund of a claimed lock allowed | expected `AlreadyClaimed`, got `TransferFailed` |
| ERC-20 1 | no balance-delta check at `newLock` | expected `UnsupportedToken`, tx succeeded |
| ERC-20 2 | refund pays the receiver | token balance differs from the model |
| ERC-20 3 | state written after the transfer, no guard | token conservation violated |

## 6. Gas (max over all runs; units of gas, `gasPrice` 0, optimizer 200 runs, `cancun`)

| Call | Max | Notes |
|---|---:|---|
| `HTLC.newLock` | 144,130 | EOA sender; 155,626 through a contract sender (adds the `exec` wrapper) |
| `HTLC.claim`, receiver is an EOA | 120,993 | typical 91,400 to 106,600 (cold vs warm receiver) |
| `HTLC.claim`, receiver is an accepting contract | 98,269 | |
| `HTLC.claim`, receiver returns 100,000 bytes | 162,206 | 95,780 with no return data |
| `HTLC.claim`, receiver returns 500,000 bytes | 1,190,624 | return data is copied; bounded only by the caller's gas limit |
| `HTLC.claim`, receiver re-enters (20 stored targets) | 825,949 | deterministic test; random runs max 313,168 |
| `HTLC.claim`, receiver burns all gas | 5,907,871 | of a 6,000,000 limit; reverts `TransferFailed` |
| `HTLC.refund`, sender is an EOA | 61,309 | 68,134 through an accepting contract sender |
| `HTLC.refund`, sender contract re-enters | 363,297 | hostile only |
| `HTLCERC20.newLock` | 271,394 | |
| `HTLCERC20.claim` | 125,967 | with a re-entering token 174,620 |
| `HTLCERC20.refund` | 81,266 | with a re-entering token 134,474 |

Honest-path bound asserted by a test: `claim` < 125,000 and `refund` < 80,000 gas (ETH, EOA or accepting contract).
Hostile payees are bounded only by the gas the caller supplies (see I-ETH-6).

## 7. What this does not cover

* The model checks the contracts' own behaviour on Hardhat's EVM. It does not cover mainnet gas-price dynamics,
  block-builder timestamp choice (on proof-of-stake the timestamp is fixed by the slot, so the `timelock - 1` /
  `timelock` boundary is not manipulable beyond slot granularity), or a fork test against a real USDC / USDT.
* Tokens are modelled by `FuzzToken` and `NoReturnToken`; an ERC-777-style receiver hook on the *receiver* side of a
  token transfer is not modelled separately (the token-side hook in `FuzzToken` mode 10 exercises the same guard).
* Gas numbers are from the Hardhat EVM with the project's compiler settings, not from a deployed contract.
* The campaign found one real validation gap and no state-machine bug in 8,500 sequences; that is evidence, not a proof.
  Formal verification or an external audit (milestone M4) remains the way to close the question.

## 8. `HTLCPoseidonV2` (the ETH leg locked on `Addr(s)`), 2026-11-05

The same harness runs a third campaign against `contracts/HTLCPoseidonV2.sol` (campaign title "HTLCPoseidonV2 (ETH): random
sequences"); the protocol and the contract are described in `docs/poseidon-leg.md`. It uses its own pair of environments
(`env.pv2`, four contract actors armed to the new contract) and the same random steps, actors, invariants I1 to I11 and
boundary coverage as the ETH campaign. The model differs from the `HTLC.sol` one in exactly four rules, all deliberate
contract differences:

* the lock word is `Addr(secret)`, computed by the JavaScript port `scripts/poseidon/poseidon2b.js` (which
  `test/poseidon-vectors.test.js` ties to the vendor crate on 12,299 vectors, so the model's `Addr` is the vendor's);
* `claim` with trailing calldata after the 32-byte secret (the `long33` and `shifted33` variants) reverts `BadCalldataLength`
  before anything else; a short secret fails in the ABI decoder as before;
* the timelock is checked before the hash: expired lock gives `TimelockExpired` even for a wrong secret;
* `InsufficientGas` is never expected (the harness sends 6,000,000 gas); it is covered by `test/HTLCPoseidonV2.test.js`.

Memory: each claim that reaches the permutation leaves ~30 MB in the Hardhat runtime until the provider is recreated. The
campaign counts those claims (`test/helpers/chain-budget.js`) and recycles the chain (`hardhat_reset`, forced GC, redeploy)
between sequences, never inside one. Nothing that is computed changes.

```sh
npx hardhat test test/fuzz.test.js --grep HTLCPoseidonV2                       # FUZZ_PN sequences (default = FUZZ_N = 200), ~35 s
FUZZ_N=0 FUZZ_PN=2000 npx hardhat test test/fuzz.test.js --grep HTLCPoseidonV2   # only this campaign, 2,000 sequences, ~6 min
FUZZ_ONLY=3 FUZZ_KIND=pv2 FUZZ_TRACE=1 npx hardhat test test/fuzz.test.js --grep reproduce
FUZZ_MUTANT_P=7 npx hardhat test test/fuzz.test.js --grep HTLCPoseidonV2        # a planted bug: must FAIL
```

Results (seed `noid-swap-fuzz-1`, 16 steps): default run 200 sequences pass (4,579 transactions); full run **2,000 sequences pass,
46,730 transactions, 323 right-secret claims that paid, 609 re-entry attempts by hostile receivers, 0 successful, 0 invariant violations**
(8 chunks of 250, 5 min 44 s, chain recycled 24 times in chunks of 39 permutation-sized calls). Claim gas to an EOA receiver:
mean 534,737, max 549,139 (126 claims; some sent through a contract caller); hostile contract receivers up to 741,522 (not allowed
by the swap tool).

Whole suite after adding this campaign, the V2 unit tests and the vector test: `npx hardhat test` 214 passing, 0 failing (3 min).

Mutants (`contracts/test/HTLCPoseidonV2Mutant.sol`, `FUZZ_MUTANT_P=n`): every one fails the campaign, in the first 12 sequences:

| Mutant | Planted bug | Caught as (sequence) |
|---|---|---|
| 1 | claim also allowed at `ts == timelock` | expected `TimelockExpired`, got `InvalidPreimage` (3) |
| 2 | refund refused at `ts == timelock` | expected success, reverted `TimelockNotExpired` (1) |
| 3 | refund callable by anyone | expected `NotSender`, got `TimelockNotExpired` (0) |
| 4 | payment before effects, no guard | events differ from the model (2) |
| 5 | lock id leaves out the timelock | events differ from the model (0) |
| 6 | a claimed lock can be claimed again | expected `AlreadyClaimed`, got `TimelockExpired` (11) |
| 7 | no timelock check in `claim` | expected `TimelockExpired`, got `InvalidPreimage` (3) |
| 8 | trailing calldata after the secret accepted | expected `BadCalldataLength`, got `TimelockExpired` (4) |
| 9 | the secret is hashed with SHA-256 instead of `Addr` | expected success, reverted `InvalidPreimage` (2) |
| 10 | stored preimage is not the revealed one | storage differs from the model (2) |
