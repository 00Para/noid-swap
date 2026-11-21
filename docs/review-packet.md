# Review packet: bridge-free atomic swaps between Parano1d (NOID) and Ethereum

Status 2026-11-06. For an external cryptographer or protocol reviewer. Everything here is a summary of documents
and code in this repository; each claim names its source as `path` and section (or function). Where a claim could
not be traced it says "not verified here". Where two sources disagree, the code's value is used and the conflict is
listed in section 11. Times are UTC. Amounts in μNOID (1 NOID = 1,000,000 μNOID). Parano1d heights are blocks.

Words used throughout, once:

- A **hashlock** is a lock that opens for whoever shows a secret whose hash is written on the lock.
- The **preimage** is that secret: the input whose hash is the value on the lock.
- A **timelock** is a deadline after which the coins go back to whoever locked them.
- The **reveal** is the moment the secret is published on a chain, so that anyone can read it.
- A **zero-knowledge proof** convinces a verifier that a statement is true without showing the secret behind it.

---

## 1. What is asked of the reviewer

The protocol has run twelve times with trial amounts (section 6) and has had seven internal code reviews, a design
review, two reviews of the Solidity Poseidon port, a seeded chaos test and an explicit-state model check. None of
these is external. The milestone this packet serves is M4 (`TASKS.md` M4.1, M4.2, M4.3): no amount beyond trial
size before an external review.

The four questions that matter most, in order of what rests on them:

1. **Is `Addr` preimage resistant enough to be a hashlock?** `Addr(s)` is one Poseidon2b permutation over GF(2^128)
   with unusually small constants (section 5.1). The NOID lock opens for anyone who finds any `s'` with
   `Addr(s') = A`. With the proof-free `poseidon` lock kind, the Ethereum lock opens on the same condition. This is
   the whole security of the hashlock.
2. **Can Bob's NOID claim be stalled past the deadline?** Parano1d's mempool is first-seen per input, with no fee
   bumping. Whoever knows the secret (Alice from the start, everyone after the reveal) can send a minimum-fee close
   first (section 5.2). Is one epoch (144 blocks) of budget enough, and does the fixed-fee contract v2 remove the
   problem?
3. **Are the timeout inequalities right, and are the margins enough under reorgs and fast blocks?** Section 3.4
   gives the formulas and every number from `swap-cli/src/params.rs`. The model check says the budgets have no
   unused slack (section 5.6).
4. **For the SHA-256 lock kind only: is the RISC Zero equivalence proof sound and zero-knowledge as used?**
   (section 5.3). The `poseidon` lock kind, used in every run since run 5, needs no such proof.

How to answer in the least time:

- Read section 3 of this packet, then `docs/protocol-design.md` §1, §2.2, §4.2 and §8.
- For question 1, `docs/parano1d-capabilities.md` §10 (exact `Addr` definition, test vectors) and the constants in
  `vendor/parano1d/noid_poseidon2b/src/native/permutation.rs:L185-L206` (cited in `docs/protocol-design.md` §5.1).
- For question 2, `docs/review-1.md` R1, `docs/htlc-v2-fixed-fee.md` and `parano1d/contracts/htlc_v2.pruv`.
- For question 3, `swap-cli/src/params.rs` (the profiles and `Gates::validate`) and `docs/formal/README.md`.
- For question 4, `equiv/README.md` §6 and §7.
- A short written answer per question, with "holds", "fails, because …" or "cannot tell without …", is the most
  useful form.

---

## 2. What the protocol promises, and what it does not

### 2.1 Promises

Alice holds NOID and wants ETH. Bob holds ETH and wants NOID (`docs/protocol-design.md` §1).

- **To Alice:** if she follows her tool's rules (reveal only while `now ≤ T_reveal − M_A`, and only after Bob's lock
  is final), she either receives the ETH or gets her NOID back from height `D` on, minus fees
  (`docs/protocol-design.md` §2.3, §2.5, (I2)). Before she reveals, nobody can take her NOID except to Bob, and only
  with the secret.
- **To Bob:** if he locks only when (I1) holds and stays online from his lock until his claim is final, he either
  receives the NOID (minus at most `F_max`) or gets his ETH back from `T_reveal` on (`docs/protocol-design.md` §2.4,
  §4.2). A third party who learns the secret can close the NOID lock early, but only to Bob
  (`docs/q2-history-step.md` §1).
- **To both:** no bridge, custodian, multisig or wrapped token. Either both legs settle or both refund, "provided each
  party stays online and acts before its own deadline" (`README.md`, first paragraph).

### 2.2 Not promised

- **The free option.** Bob can wait to see the price move before locking, up to his lock-by height. Alice can wait
  before revealing, up to `T_reveal − M_A`. Mitigation is short windows and small amounts only; it is "inherent to
  HTLC swaps" (`docs/protocol-design.md` §8 T13).
- **Liquidity griefing.** Bob not locking ties up Alice's NOID until `D` (about 6 h under `production`;
  `docs/protocol-design.md` §1 item 3, §4.5). Alice always locks first, for the longer period.
- **Fee griefing.** Anyone holding the secret can close early to Bob with `fee = F_max`. Bob bears up to `F_max`
  (`docs/protocol-design.md` §8 T1). With contract v2 every close pays exactly `max_fee`
  (`parano1d/contracts/htlc_v2.pruv`).
- **Liveness of a party who goes offline.** A Bob who goes offline after the reveal loses his side
  (`docs/protocol-design.md` §2.4, last row).
- **Privacy.** Anyone can link the two legs through `Addr(x)`. With the `poseidon` kind, `A` is visible on Ethereum
  from Bob's lock on, also for swaps that are later refunded (`docs/protocol-design.md` §8 T19;
  `docs/poseidon-leg.md` §3, row T19). The opening is public in the mempool and links `A`, Bob and Alice
  (`docs/review-1.md` R9).
- **Price discovery or matching.** Not a market: the parties find each other elsewhere (`README.md`, "What it is not").
- **Smart-contract wallets on Ethereum.** Receivers must be externally owned accounts (`docs/protocol-design.md` §8 T11).
- **A secret used twice.** Once a secret is public, every other lock under the same `H` or `A` is claimable by anyone.
  The design relies on a fresh secret per swap, a refusal of a known `H` by the tool and Bob's check that
  `getSlotsByOwner(A)` is empty; it calls this user error outside the tool (`docs/protocol-design.md` §8 T9; A30).

---

## 3. The mechanism in one page

### 3.1 Roles, and why Parano1d can never be the reveal leg

Parano1d has no signatures. A wallet spends by a zero-knowledge proof of knowledge of a 256-bit secret `s` whose
address is `A = Addr(s)` (`docs/parano1d-capabilities.md` §2, executive summary item 3). So a contract whose claim
authority is `Addr(s)` is already a hashlock.

A Parano1d claim never shows `s`: the call carries no free-form data, and the only caller-chosen 256-bit field (a
payout owner on continuing calls) cannot be checked by the contract (`docs/parano1d-capabilities.md` §3). If Bob
held the secret and claimed NOID first, Alice would never learn it, and Bob could refund his ETH too. The first
claim must reveal the secret, so it must be on Ethereum or Bitcoin. Hence (`docs/protocol-design.md` §1):

| | Alice | Bob |
|---|---|---|
| Holds / receives | NOID / ETH | ETH / NOID |
| Makes the secret | yes (fresh 32 bytes from the OS random generator) | no |
| Locks | first, Parano1d, deadline `D` (blocks) | second, Ethereum, `T_reveal` (Unix time) |
| Claims | first, on Ethereum: this is the reveal | second, on Parano1d, with the revealed secret |

### 3.2 The two lock contracts

**Parano1d side**, `parano1d/contracts/htlc.pruv` (`HashTimeLock`, 1 of 16 instructions):
`claim_authority = Addr(s)`, `claim_recipient = Bob`, `recovery_authority = recovery_recipient = Alice`,
`deadline_height = D`, close-only modes, `unrestricted_payout_recipient = false`, `max_fee_micronoid = F_max`.
Below `D` only a holder of `s` can close, and the close must pay Bob; from `D` on only Alice can close, to herself
(`docs/parano1d-capabilities.md` §2; `docs/protocol-design.md` §6.1, §6.2). The program cannot hash and takes no
argument; the hashlock is the authority itself (`docs/parano1d-capabilities.md` §1). Bob rebuilds the 699-byte
opening himself from his own terms and requires a byte-for-byte match (`docs/protocol-design.md` §6.3 item 2).

Contract v2, `parano1d/contracts/htlc_v2.pruv` (`HashTimeLockV2`, 2 of 16 instructions), adds
`require fee == max_fee`: every close by anyone pays exactly `max_fee`, which removes the cheap close of section
5.2 (`docs/htlc-v2-fixed-fee.md`; `pruv verify` proved its 2 postconditions, `TASKS.md` M4.0b). Not run live.

**Ethereum side**, two lock kinds (`swap-cli/src/params.rs` `code_hash_for`):

| Kind | Contract | Lock word | Claim check | Pinned runtime code hash |
|---|---|---|---|---|
| `sha256` | `eth/contracts/HTLC.sol` | `H = SHA-256(s)` | `sha256(preimage) == H` | `0xa906117f…45e2f` (`params.rs` `HTLC_CODE_HASH`) |
| `poseidon` | `eth/contracts/HTLCPoseidonV2.sol` + `Poseidon2b.sol` | `A = Addr(s)` | `Poseidon2b.addr(preimage) == A` | `0xf510d2a3…43ff3` (`params.rs` `HTLC_POSEIDON_V2_CODE_HASH`) |

Both: claim only while `block.timestamp < timelock`, refund only by the sender when `block.timestamp ≥ timelock`;
fixed receiver; `lockId = keccak256(sender, receiver, amount, word, timelock)`; duplicate lock ids refused;
re-entrancy guard. `HTLCPoseidonV2` also requires exactly 68 bytes of calldata, checks the timelock before the
permutation, and refuses a claim with fewer than 540,000 gas left; it has no view that computes `Addr`, so the
secret is never sent to a remote `eth_call` (`eth/contracts/HTLCPoseidonV2.sol` header, items 1 to 5). The two
contracts have identical selectors and event shapes; only the pinned address and code hash tell them apart
(`docs/poseidon-leg.md` §3).

### 3.3 Linking the two locks: the equivalence proof, or the `poseidon` kind

With the `sha256` kind, Bob must know before locking that `SHA-256(s) = H` and `Addr(s) = A` share one `s`. Alice
proves it in RISC Zero, locally; the journal is 65 bytes `variant ‖ H ‖ A`; Bob verifies the receipt against an
image id compiled into his tool (`docs/protocol-design.md` §5; `equiv/README.md` §5, §6; `params.rs`
`EQUIV_IMAGE_ID` = `7e9d8477…6187`). This relies on the zkVM's soundness and zero knowledge (section 5.3) and on a
reproducible image id, which is not achieved yet (`TASKS.md` M1.1).

With the `poseidon` kind, both locks carry the same 32 bytes `A`. Bob compares the Ethereum lock word with the
`claim_authority` of the opening he rebuilt. Nothing is proved. This relies on one claim: the EVM computes the same
`Addr` as the Parano1d node for every 32-byte input (`docs/poseidon-leg.md` §1, §2). Evidence: 12,299 vendor-generated
vectors with 0 mismatches, a hand derivation and machine checks in an independent review, fuzz and mutation tests
(`docs/poseidon-leg.md` §7; `docs/poseidon-v2-review.md` "Verdict" item 1). Raw variant only; Bitcoin cannot use
it, so a Bitcoin leg still needs SHA-256 and the proof (`docs/poseidon-leg.md` §1).

Both kinds rest on `Addr`'s preimage resistance (section 5.1). SHA-256 was never a second line of defence: the NOID
lock opens for any `Addr`-preimage (`docs/poseidon-leg.md` §3, row T8).

### 3.4 Timeouts: the inequalities and the current numbers

From `docs/protocol-design.md` §4.2, as implemented in `swap-cli/src/params.rs` (`Gates`):

```text
(I1) Bob safety:     D − H_b ≥ ⌈(t_L − t_b + 2·P_auth) / τ_fast⌉ + B_post,   t_L = T_reveal + Δ_detect
                     B_post = B_epoch + B_fee + B_final + B_safety
(I2) Alice safety:   reveal only if now ≤ T_reveal − M_A and Bob's lock is finalized
(I3) Alice liveness: T_reveal − t_b ≥ W_A_min
(I4) Hard rule:      Bob's claim included at h ≤ D − 1; target h ≤ D − 19
(I5) Version:        no owner-authorization version change in [H_create, D + B_post]
D_offset = B_fund + B_final + B_bob + RHS(I1)(W_A) + margin,   D = H_create + D_offset
Bob's T_reveal = min(t_now + W_A, T_max), refused below W_A_min (params.rs choose_t_reveal)
```

`choose_t_reveal` (`params.rs` L685 to L692) refuses Bob's lock in two cases: `h_now` is above the minimum-window
lock-by height `D − RHS(I1)(W_A_min)`, or `h_now` is more than `B_bob` blocks after the height at which the funding is
final. The lock-by values `D − 631`, `D − 69` and `D − 252` in the table below are nominal (they belong to the full
reveal window); the hard limit is the minimum-window height together with the `B_bob` rule. If the funding is included
at about `h_create` and is final 18 blocks later (`NOID_FINALITY_DEPTH`), the `B_bob` limit comes first in every profile: about
`h_create + 38` against `D − 210` = `h_create + 92` under `sepolia`, `h_create + 78` against `D − 541` =
`h_create + 197` under `production`, and `h_create + 38` against `D − 63` = `h_create + 59` under `rehearsal`
(arithmetic from the constants, not a measurement). Section 10 has the operational consequence seen in run 13.

`Gates::validate` (`params.rs`) also requires, for every profile: `M_A > eth_finality`;
`W_A_min − M_A ≥ eth_finality + Δ_detect`; `M_A ≥ eth_finality + 2·DE + RA` and
`W_A_min ≥ DE + eth_finality + RA + M_A` (one Ethereum reorg of Alice's claim; from `docs/formal/README.md` §7);
`tx_grace ≥ 2·RA`; `tx_grace + RA + DE ≤ M_A`; `W_A < W_A_min + min_cancel_age + abort_after_cancel`;
`D_offset` equal to the derived value; the epoch-end proving guard (`⌈P_auth/τ_fast⌉ + 3` = 4 blocks) fits in
`B_safety`; `B_final` = `NOID_FINALITY_DEPTH` + 1 = 19.

Current numbers, read from `swap-cli/src/params.rs` (`PRODUCTION`, `REHEARSAL`, `SEPOLIA`); derived rows computed
from them with the formulas above:

| Item | `production` | `rehearsal` | `sepolia` |
|---|---|---|---|
| `τ_fast` (planning block interval) | 20 s | 20 s | 20 s |
| `W_A` / `W_A_min` / `M_A` | 7,200 / 5,400 / 1,800 s | 600 / 480 / 300 s | 4,200 / 3,360 / 1,800 s |
| `Δ_detect` / `P_auth` budget (used twice) | 300 s / 20 s | 60 s / 20 s | 120 s / 20 s |
| Ethereum finality assumed | 1,140 s | 0 s | 1,140 s |
| `DE` / `RA` / `tx_grace` | 120 / 120 / 600 s | 60 / 60 / 120 s | 120 / 120 / 600 s |
| `min_cancel_age` / `abort_after_cancel` | 600 / 3,600 s | 120 / 600 s | 600 / 3,600 s |
| `B_epoch` / `B_fee` / `B_final` / `B_safety` | 144 / 60 / 19 / 31 | 0 / 10 / 19 / 5 | 0 / 10 / 19 / 5 |
| `B_post` | 254 | 34 | 34 |
| RHS(I1), full / minimum window | 631 / 541 | 69 / 63 | 252 / 210 |
| `B_fund` / `B_bob` / `margin` | 10 / 60 / 18 | 5 / 20 / 9 | 5 / 20 / 6 |
| `D_offset` | 738 (about 6 h at 30 s) | 122 | 302 (about 2 h 30) |
| Bob's lock-by, full (nominal) / minimum window (the hard limit, with `B_bob`) | `D − 631` / `D − 541` | `D − 69` / `D − 63` | `D − 252` / `D − 210` |
| Alice's reveal cutoff | `T_reveal − 1,800 s` | `T_reveal − 300 s` | `T_reveal − 1,800 s` |
| Amount caps, Ethereum chain | none, any chain | 20 NOID, 0.01 ETH, chain 31337 | 20 NOID, 0.01 ETH, chain 11155111 |
| Second node required before Bob's lock and Alice's reveal (`requires_second_node`; `--single-node-ok` turns it off; under `production` Bob's lock additionally needs the second node for the producer check of threat T21, which `--single-node-ok` does not turn off, only `--accept-producer-concentration`) | yes | no | yes |

Common to all profiles (`params.rs`): `NOID_FINALITY_DEPTH` = 18 (finality: a block is final at tip ≥ height + 18) and `B_FINAL` = 19 (its budget term), `B_EPOCH` = 144 (the chain's epoch),
`MIN_CLOSE_FEE` = 5,800 μNOID, trials only from height 279,388 (`TRIAL_START_HEIGHT` = activation 279,370 + 18).
Fee cap: v1 `F_max = max(50,000, 3 × estimateFeeDetailed(1,1))`, v2 `max(50,000, 5 × floor_seen)`, and at most
1 % of the amount in both (`F_MAX_*` constants). `B_epoch` = 0 in the two small profiles accepts the risk of a
claim evicted at an epoch rotation (`docs/protocol-design.md` §9.1, after the profile table).

---

## 4. Threat model and trust assumptions

Status words: **verified by source reading** (the claim was traced in code, not executed), **verified by test** (a
test in the repository or a recorded scratch run shows it), **verified live** (seen on a real chain), **assumed**
(nobody here has shown it). Only the strongest status is given; the reference says what exactly was done.

| # | Assumption | Status | Reference |
|---|---|---|---|
| A1 | `Addr` is preimage resistant (no `s'` with `Addr(s') = A` can be found) | assumed | `docs/protocol-design.md` §8 T8; Q8 |
| A2 | SHA-256 is preimage resistant (sha256 kind and Bitcoin) | assumed | `equiv/README.md` §7 item 5 |
| A3 | `Addr` is defined as in the report; vectors `Addr(00…1f) = f8183db2…12cf` reproduce | verified by test | `docs/review-1.md` #4; `equiv/README.md` (100,000-input parity, 0 mismatches, `TASKS.md` M1.3) |
| A4 | The EVM `Addr` equals the node's `Addr` for every input | verified by test | 12,299 vectors, 0 mismatches, plus a hand proof (`docs/poseidon-leg.md` §7; `docs/poseidon-v2-review.md` "Verdict"); not machine-checked (`docs/poseidon-leg.md` §10). Only the Yul source was reviewed, not the compiled bytecode; the vector matches are the evidence for the bytecode (`docs/poseidon-v2-review.md` "Not checked") |
| A5 | A terminal close must pay `recipient_at(height)` in Rust admission (`check_call`) | verified by test | `docs/review-1.md` #2a; harness `close_must_pay_committed_recipient` |
| A6 | The same rule holds inside the block proof (HistoryStep), tied to the funded address | verified by source reading | `docs/q2-history-step.md` §1; component tests only (review-1 route A, N2 forged openings); full-block N1 and devnet N3 not run |
| A7 | No authorization proof can be made without `s` (prover soundness of `noid_gkr`) | assumed | `docs/review-1.md` #3 and harness findings; the verifier rejects tampered, replayed and cross-version proofs (`TASKS.md` M0.4), but no malicious-prover test exists |
| A8 | A Parano1d authorization proof hides `s` (witness hiding) | assumed | upstream docs only (`docs/parano1d-capabilities.md` §3; Q3). If it does not hold, Bob's claim leaks a secret that is already public, but Alice's refund may leak the spend secret of her wallet, a chain-wide issue (`docs/protocol-design.md` §8 T18) |
| A9 | The mempool evicts a pending call when its branch would flip at the next height; last inclusion `D − 1` | verified by source reading | `docs/review-1.md` #5 (`noid_mempool/src/contracts.rs:92-113`) |
| A10 | An authorization proof is bound to its branch and epoch anchor, not the exact call height | verified live, one sample | run 1: proved for 280,658, included at 280,659, a gap of one block, on a self-swap (`docs/review-1.md` "Applied" item 9; `docs/protocol-design.md` §9.3, "Limits of this evidence") |
| A11 | Finality is 18 blocks after inclusion (`is_final`: tip ≥ height + 18); the upstream documents' "at most 17 blocks of rollback" is the same rule counted from the other side | read in the vendored code; the documents and the tool counted 17 until 2026-11-08 | `consensus/header.rs` (`is_final`), `consensus/fork_choice.rs` (`reorg_allowed`) in the vendored node; `docs/parano1d-capabilities.md` §4 |
| A12 | First-seen per input slot, no replace-by-fee | verified by source reading | `docs/review-1.md` R1 (`pool.rs:1296-1297, 1334-1356`) |
| A13 | A stuck minimum-fee close blocks Bob for at most one epoch (144 blocks) | assumed | `docs/protocol-design.md` §8 T2; Q1 not run |
| A14 | `max_fee < 5,800` locks both branches forever; the tool refuses it | verified by test | `docs/review-1.md` R3 (scratch run); `TASKS.md` M0.6 (`check_swap_params`) |
| A15 | The owner-authorization version switches at 279,370 and proofs do not cross versions | verified by test | `docs/review-1.md` #6; harness (`TASKS.md` M0.3). The mainnet re-check is still open (`TASKS.md` Housekeeping) |
| A16 | The opening is deterministic; Bob's rebuild equals what the node funds | verified live | two-machine runs 9 to 13 rebuilt it byte for byte (`TASKS.md` M2.7b); the formal check M0.2 / Q10 is open |
| A17 | Planning block interval `τ_fast` = 20 s is pessimistic enough | assumed | `docs/protocol-design.md` §8 T20; Q13 |
| A18 | The local relay floor stays below `F_max` | assumed | Q6; run 1 saw a floor of 5,000 throughout (`docs/protocol-design.md` §9.3) |
| A19 | Ethereum finality within 1,140 s | assumed; measured once (1,131 s) | run 3: 1,131 s, which the design calls "a lower bound at a quiet hour, not a worst case" (`docs/protocol-design.md` §9.3) |
| A20 | RISC Zero receipts are sound (98-bit conjectured) | assumed | `equiv/README.md` §7 item 1 |
| A21 | RISC Zero succinct receipts are zero-knowledge | assumed | `equiv/README.md` §5 "Choice", §7 item 2; Q11 citation not completed (`TASKS.md` M1.2) |
| A22 | `equiv-prove verify` rejects wrong `H`, `A`, variant, seal, image id, journal and dev-mode receipts | verified by test | the table in `equiv/README.md` §6 lists 139 rejected cases (4 of them garbage files) plus 1 dev-mode receipt and 5 `RISC0_DEV_MODE` refusals, on real receipts; `PROJECT.md` says 138 (section 11, item 16) |
| A23 | Both parties build the same image id | assumed, known false today | `TASKS.md` M1.1: a second machine got another id (paths in the guest binary) |
| A24 | The Ethereum contracts enforce disjoint claim and refund windows, fixed receiver, no re-entry | verified by test | `eth/` suite and fuzz campaign (`docs/poseidon-leg.md` §7); no Solidity audit, and the audit task `TASKS.md` M4.2 names only `HTLC.sol` and `HTLCERC20.sol`, not `HTLCPoseidonV2.sol` or `Poseidon2b.sol` (section 5.7) |
| A25 | Receivers are externally owned accounts | verified by test, with a gap | REVIEW-1 H3 fix (`sender_is_eoa`, `swap-cli/REVIEW-1.md` "Applied"). Gap: a receiver that gains code after the last poll (for example by EIP-7702 delegation) makes the claim revert with the secret already public, because the pre-flight estimate was removed; REVIEW-7 R7-7 proposes a `getCode` re-check just before signing and lists it as not part of its fix (`swap-cli/REVIEW-7.md`, section 7) |
| A26 | Each party reads each chain through two independent nodes | check exercised live; independence assumed | The two-node check ran once, in run 12 (`docs/live-run-12.md`). On Parano1d each side's second node was the counterparty's own node, reached through a tunnel, and both machines were on one private network, so the nodes were not independent; on Ethereum each side used two different public endpoints. Required before Bob's lock and Alice's reveal unless `--single-node-ok` is set (`swap-cli/src/params.rs` `requires_second_node`); under `production` Bob's lock also needs the second Parano1d node for the producer-concentration check even with `--single-node-ok` (only `--accept-producer-concentration` waives it) |
| A27 | Each party is online inside its own window | assumed | `docs/protocol-design.md` §2.4, §8 T3 |
| A28 | The secret stays sealed until the reveal (Argon2id + XChaCha20-Poly1305 file, never on argv) | verified by test | `TASKS.md` M2.3, M2.7a; `SECURITY.md` rule 3 |
| A29 | The model's timeout relations hold under its bounded adversary | verified by test on scaled-down sets only | `docs/formal/README.md` §3: the model ran on a toy set and on production divided by about 10 and by 6, each with `B_safety` = `NF` + 3. The production column was checked against the inequalities only, with the zero-slack values of the model (since 2026-11-08: `NF` 18, `B_safety` 21, `B_post` 244, `RHS(I1)` 621, `D_offset` 728; before that 17, 20, 242, 619, 725). The tool's numbers (31, 254, 631, 738) are enforced in `Gates::validate` but were never run in the model. `DE` and `RA` are the model author's own assumptions, not measured. The model has not been reviewed independently |
| A30 | A secret is never reused across swaps | assumed (user discipline) | Once the secret is public, every other lock under the same `H` or `A` is claimable by anyone; the design says the tool refuses a known `H` from its local record and Bob checks that `getSlotsByOwner(A)` is empty (`docs/protocol-design.md` §8 T9). Not re-verified here |
| A31 | No party holds a majority of Parano1d's hashrate (so that a miner who is Alice cannot keep Bob's claim from becoming final until `D`) | **false at the time of measurement** (2026-11-08) | One address mined 52.7 % of the last 24 hours and between 45 % and 63 % of every 2,880-block day for 20 days, read from the node's own block headers. Above half of the hashrate no window length helps. Modelled, not tested on a chain; the review status of the model is in the header of `docs/miner-concentration.md` (threat T21, `docs/protocol-design.md` §8; section 5.9). Partly mitigated in swap-cli (2026-11-08): under the `production` profile Bob's `lock_eth` is not offered while one address produced more than 35 % of the last 2,880 or 720 blocks (a screen, not a defence: `docs/bob-concentration-gate.md`) |

---

## 5. Open questions for the reviewer

Ordered by how much rests on them.

### 5.1 Preimage margin of Poseidon2b (Q8)

- **Claim.** No one can find `s'` with `Addr(s') = A` for a random `A`. `Addr(x)` is
  `P([le128(x[0..16]), le128(x[16..32]), L<<64, L])[0..2]`, `L = u64_be("ADDRFIX_")`, P = Poseidon2b with t = 4,
  S-box `x^7`, 8 full and 58 partial rounds over GF(2^128) (`docs/protocol-design.md` §0). The constants, read for this
  packet from `vendor/parano1d/noid_poseidon2b/src/native/permutation.rs` (L184 to L206): every round constant is at
  most `0x7`; every full-round MDS entry is at most `0x7`; the partial-round matrix has the diagonal `0x20`, `0x2000`,
  `0x200`, `0x800` and `1` everywhere else.
- **Why it matters.** It is the hashlock. A preimage lets anyone claim the NOID before the reveal (still paying
  Bob), and with the `poseidon` kind also claim Bob's ETH. The same attack would break every Parano1d address
  (`docs/protocol-design.md` §8 T8).
- **What was checked.** Only implementation equality: the portable code and the Solidity port against the vendor
  crate (`equiv/README.md` §3; `docs/poseidon-leg.md` §7). No cryptanalysis.
- **Not known.** Whether the small constants inside a subfield give a Frobenius-type symmetry that lowers the margin.
  `docs/protocol-design.md` §8 T8 notes that the IV lanes are "not obviously fixed by the subfield Frobenius, but
  that is not an analysis". The sources stated the size of the constants in two ways; the vendor file settles it
  (section 11, item 1).
- **What would settle it.** A written analysis of preimage resistance of this truncated single-permutation
  construction with these constants (`TASKS.md` M4.1).

### 5.2 A claim stalled by a minimum-fee close (Q1)

- **Claim.** Bob's claim is included and final before `D`, even if someone else closes first.
- **Why it matters.** Every valid close pays Bob, but a cheap close admitted first blocks Bob's own (`SlotConflict`)
  and may sit under congestion until eviction at the branch flip or an epoch rotation. If it lasts until `D`, Alice
  refunds and Bob loses (`docs/review-1.md` R1; `docs/protocol-design.md` §8 T2). Alice gains from this after taking
  the ETH.
- **What was checked.** The first-seen rule by source reading (A12). (I1) budgets one epoch (`B_epoch` 144) plus
  `B_fee` 60 under `production`; the small profiles budget no epoch. Contract v2 makes every close cost exactly
  `max_fee`, so there is no cheaper competing close (`docs/htlc-v2-fixed-fee.md`; harness `tests/htlc_v2.rs`, 9 tests).
- **Not known.** Relay, block selection and re-submission behaviour of two conflicting closes; whether a stuck close
  is re-broadcast each epoch; whether v2 removes the stall in practice. Neither Q1 nor a v2 live run was done
  (`TASKS.md` M2.2, M4.0b).
- **What would settle it.** The Q1 experiment: two conflicting closes (5,800 against `F_max`) at two nodes, across an
  anchor rotation, on an isolated net or mainnet-tiny (`TASKS.md` Q1); then the same with v2.

### 5.3 Zero knowledge and soundness of the equivalence proof (sha256 kind only; Q3 for the zkVM side, Q11)

- **Claim.** A receipt for `(variant, H, A)` exists only if Alice knows `x` with `SHA-256(x) = H` and
  `Addr(x) = A` (or `Addr(Derive(x,0)) = A`), and it reveals nothing about `x` (`docs/protocol-design.md` §5.1).
- **Why it matters.** Unsound: Alice takes both legs. Not zero-knowledge: Bob claims the NOID without locking
  (`docs/protocol-design.md` §8 T10).
- **What was checked.** Proved and verified for both variants; 139 automated negative cases in the table of
  `equiv/README.md` §6 (`PROJECT.md` says 138); remote proving and dev mode refused (`equiv/README.md` §6). The ZK statement is the vendor README's "perfect zero-knowledgeness and 98 bits
  of conjectured security" with default parameters (`equiv/README.md` §5 "Choice").
- **Not known.** Whether that statement holds for the exact receipt kind and version pinned (risc0-zkvm 3.0.6,
  succinct receipts); whether 98 bits is enough for the swap value (`equiv/README.md` §9); a receipt from a different
  guest with its own valid proof was never tested. The image id is not reproducible across machines (`TASKS.md` M1.1).
- **What would settle it.** A citation or review of RISC Zero's ZK property for that receipt kind; the reproducible
  build of M1.1 or a reviewed change so that `verify` checks against the pinned id (`TASKS.md` M1.1 option c).
- **Note.** Every run since run 5 used the `poseidon` kind and needed no proof. This question applies to the sha256
  kind and to any future Bitcoin leg.

### 5.4 The recipient rule in the block proof (Q2)

- **Claim.** A block proof cannot include a close of the `HashTimeLock` that pays anyone except
  `recipient_at(height)` (`docs/q2-history-step.md` §1).
- **Why it matters.** Once `s` is public, a block producer could otherwise redirect Bob's NOID
  (`docs/protocol-design.md` §8 T14).
- **What was checked.** Source reading of the whole chain of constraints, opening → address → spent slot → output →
  header; review-1's component test (true opening, close pays a stranger: unsatisfied); N2 (forged openings rejected
  by the side-proof verifier) (`docs/q2-history-step.md` §1).
- **Not known.** A full-block negative test (N1, too much memory) and a devnet block (N3, needs
  the proof bank of Q7). The frozen v2.1 matrices are unchecked against `d29b801` (`PROJECT.md` "Top risks").
- **What would settle it.** N1 and N3, or a confirmation from upstream Parano1d (`TASKS.md` M4.3).

### 5.5 Relay floor under load (Q6) and the fee cap

- **Claim.** `F_max` stays above every node's relay floor until Bob's claim is final; otherwise neither the claim nor
  the refund relays (`docs/protocol-design.md` §8 T5).
- **What was checked.** The floor rule by source reading: it latches at 80 % pressure, resets below 50 %, and is
  per node (`docs/review-1.md` #9). In the runs whose fees are cited here (1, 4, 8, 11, 12, 13) each close paid the 5,800 minimum (the
  other logs not verified here), and in run 1 the floor was 5,000
  throughout (`docs/protocol-design.md` §9.3).
- **Not known.** Frequency, level and duration of the floor on mainnet under load. `B_fee` = 60 blocks has no
  measurement behind it.
- **What would settle it.** Polling `estimateFeeDetailed(1,1)` and `getMempoolInfo` every block for at least two
  weeks on several nodes (`TASKS.md` Q6, M2.8).

### 5.6 Reorg and finality margins

- **Claim.** Bob's claim, targeted at `h ≤ D − 19`, is final before `D`; Alice's reveal is final before `T_reveal`.
- **What was checked.** A claim at `D − 1` reorged out and re-included at `≥ D` becomes invalid (`docs/review-1.md` R2).
  The explicit-state model raised production `B_safety` from 20 to 30 (31 since the finality correction of 2026-11-08) because 20 "equals exactly one adversarial
  reorg of Bob's close with nothing on top" (`docs/protocol-design.md` §9.1). With all gates on, no invariant is
  violated in the model's bounds; but "the design's budgets have no unused slack against one more unit of reorg,
  eviction, detection delay, proving time or an unbounded mempool stall" (`docs/formal/README.md`, bottom line).
  The model ran on scaled-down parameter sets (a toy set and production divided by about 10 and by 6), not on the
  production numbers. The production column was checked against the inequalities only, and with the old values
  (`B_safety` 20; 242, 619 and 725; the model's zero-slack set is 21; 244, 621 and 728 since 2026-11-08). The current values (`B_safety` 31; 254, 631 and 738) are enforced in
  `Gates::validate` and were never run in the model. `DE` and `RA` are the model author's own assumptions
  (`docs/formal/README.md` §3, §7, "Applied 2026-11-05").
  The engine follows inclusion until final and goes back on a reorg (REVIEW-2 F6, closed in REVIEW-3).
- **Not known.** Whether removed contract calls are re-admitted to the mempool after a reorg (Q14; source reading says no, section 5.9); the real
  block-interval distribution (Q13); deeper Ethereum reorgs. The T21 model (`docs/formal/t21_race.py`) was reviewed independently twice on 2026-11-08 and its figures reproduced by a separate implementation; the repeated game with ASERT and timestamp manipulation are not covered.
- **What would settle it.** An isolated-net reorg test (Q14), header statistics (Q13), and a review of
  `docs/formal/model.py`.

### 5.7 The Ethereum contracts

- **Claim.** The contracts pay only the fixed receiver on a valid claim, only the sender on refund after the
  timelock, never both.
- **What was checked.** Tests, a fuzz campaign (2,000 sequences, 609 re-entry attempts, 0 successful) and ten planted
  mutants, all caught (`docs/poseidon-leg.md` §7); two reviews of the Poseidon port
  (`docs/poseidon-evm-review.md`, `docs/poseidon-v2-review.md`).
- **Known limits.** A receiver that rejects ETH makes `claim` revert after the secret is already in calldata; Bob can
  then take both legs (`docs/protocol-design.md` §8 T11). The tool requires EOAs (`eth_getCode == 0x`) and sends the claim with a fixed gas limit; it never estimates or simulates the claim, because that would send the secret to the node first. A `poseidon`
  claim costs 517,084 gas on mainnet and 689,324 on Sepolia; a claim that runs out of gas still publishes the secret
  (`eth/contracts/HTLCPoseidonV2.sol` "COST AND GAS"; `docs/live-run-8.md` "What it showed"). The reveal's fixed limit
  of 1,000,000 had 31 % headroom on Sepolia, and the cause of the higher Sepolia gas is, in the run log's words, "an
  inference from the numbers and was not checked against the networks' fork schedules" (`docs/live-run-11.md`
  finding 2). Gas constants must be re-measured after any repricing fork (`HTLCPoseidonV2.sol`, `MIN_CLAIM_GAS`).
  A receiver that gains code after the last poll makes a claim revert with the secret already public (A25, REVIEW-7
  R7-7).
- **Not done.** A Solidity audit (`TASKS.md` M4.2). The task as written names only `HTLC.sol` and `HTLCERC20.sol`: it
  does not name `HTLCPoseidonV2.sol` or `Poseidon2b.sol`, the contracts used in runs 5, 6 and 8 to 13, so a reviewer
  should ask for them to be in scope. Only the Yul source of `Poseidon2b.sol` was reviewed, not the bytecode solc
  produced; the 12,299 vector matches are the evidence for the bytecode (`docs/poseidon-v2-review.md` "Not checked").
  A symbolic check of `gmul`; the second independent Yul review is listed as open in some sources (section 11, item 7).
- **What would settle it.** M4.2.

### 5.8 Status of Q1 to Q15

From `docs/protocol-design.md` §9.2, with the later status from `TASKS.md` and the documents cited.

| Q | Question (short) | Status |
|---|---|---|
| Q1 | Conflicting closes; can a minimum-fee close stall Bob? | Open; experiment not run; contract v2 is the proposed fix (5.2) |
| Q2 | Recipient rule in the block proof | Confirmed by source reading and component tests; N1, N3 not run (5.4) |
| Q3 | Is the authorization capsule zero-knowledge in code? | Open; docs only (A8) |
| Q4 | `P_auth` on the counterparty's hardware | Measured on the owner's VM (p50 about 1.5 s, worst p99 6.0 s, budget 20 s); 3 s for the real claim of run 1; to re-measure on the counterparty's hardware (`docs/protocol-design.md` §4.1, §9.2) |
| Q5 | Stock-path latency | Open; the stock variant never ran live |
| Q6 | Relay floor under load | Open (5.5) |
| Q7 | Isolated proof bank | Open; blocks N3 and devnet tests |
| Q8 | Poseidon2b preimage margin | Open (5.1) |
| Q9 | EVM Poseidon2b gas | Answered by M4.0: `Addr` in 428,747 gas, claim 519,537 on Hardhat (`TASKS.md` M4.0); now the `poseidon` lock kind |
| Q10 | `pruv build` + `contract create` deterministic, equal to `ObjectOpening` | Byte-for-byte equal in practice (A16); task M0.2 not closed |
| Q11 | RISC Zero ZK claim, cycles, time, receipt size | Measured (2,752,498 user cycles raw, receipt 223,356 bytes; `equiv/README.md` §6); the ZK citation for the pinned version is still to add (`TASKS.md` M1.2) |
| Q12 | Bob's output slot taken before inclusion | Open |
| Q13 | Block-interval distribution | Open |
| Q14 | Reorged calls re-admitted to the mempool? | Source reading says no: the node only logs them and removes duplicates (`noid_mempool/src/pool.rs`, `readmit_after_reorg`); swap-cli proves and offers the claim again (5.9). Isolated-net test not run |
| Q15 | `--expected-txid` preview/submit window | Open; run 2 showed that preview and send must be chained (`TASKS.md` M2.7) |
| — | Is the claim proof bound to the exact call height? | Answered by run 1: no, to the branch and epoch anchor (A10) |

### 5.9 Concentrated hashrate on Parano1d (threat T21)

- **Claim (the protocol's assumption).** No party holds a majority of the hashrate. Then Bob's claim, once final (18 blocks after inclusion), cannot be
  taken back, and the abort paths hold.
- **What was measured.** From the node's own block headers (`paranoid_getBlockHeader`, field `miner`): one address mined 52.7 % of the last 24 hours
  (2,857 blocks) and between 45 % and 63 % of every 2,880-block day for the 20 days before; before that no address had more than about 31 % of a day.
  The deepest reorg seen in the node logs was 3 blocks. A miner address is where the reward goes, not who did the work, and one operator can use
  several addresses, so a measured share is a lower bound (`docs/miner-concentration.md` §1).
- **What was modelled.** The exact optimum of the repeated attack (a private lead, depth cap 18, Bob's re-send after a stated delay), checked by
  enumeration, closed forms and Monte Carlo (`docs/formal/t21_race.py`). Above half of the hashrate no window length helps. At a 53 % share and
  the production window the chance is about 55 % from a clean start (a lower bound) and about 90 % or more for a prepared attacker. Under 1 %
  at the production window needs a share of at most 0.45 (free ties) or 0.47 (strict ties). A smaller miner is limited by the window and by how
  quickly Bob re-sends: a re-send after 10 or 20 blocks (an operator who re-sends by hand needs minutes) turns 0.03 % at 0.45 into 3.6 % or 15 %.
  The victim is Bob, the Ethereum side: Alice has claimed his ETH and takes the NOID back at `D`.
- **What is done about it.** A Bob-side screen is built (2026-11-08; not yet independently reviewed): `swap-cli tick` reads who produced the last
  2,880 and 720 blocks from Bob's own node's headers, and under the `production` profile does not offer `lock_eth` while one address produced more
  than 35 % of either window or while the headers cannot be read in full, are stale, or the second Parano1d node disagrees (28 % and a warning only
  under `sepolia` and `rehearsal`; the two largest together above 50 % only warn; an explicit flag waives the production refusals). It is a screen, not
  a defence: it does not see an operator on several addresses, a pool, rented hashrate or a share that grows after the lock
  (`docs/bob-concentration-gate.md`). The recommendation stays that swaps in which Bob locks ETH against an unknown Alice are not made with more
  than tiny amounts.
- **Not known.** The share an attacker would hold at the time of a swap (hashrate can move or be rented; the gate looks backwards); whether the
  largest address is one operator or several; whether a reorg deeper than 3 blocks is possible in practice; the effect of timestamp choices on
  the work of a private branch (the repeated game was not simulated with the difficulty rule; the model's review status is in the header of the
  report).
- **What would settle it.** A reviewer's read of the model and of the node's fork-choice and depth rules; a daily record of the concentration and of
  reorg depths over time (`TASKS.md` T21-1, T21-4); an isolated-net reorg test (Q14).
- **Re-send after a reorg.** The node does not put the transactions of a reverted block back into its mempool; swap-cli goes back to the state
  `secret_seen` and offers the claim again on the next tick, and adds a note that starts with `ALERT:` (the watch loop can pass it on as a short message);
  the sending is still a step the operator runs. An automatic re-send is not built (`docs/bob-concentration-gate.md`, "Bob's re-send after a reorg").

---

## 6. What was run live

All NOID legs on Parano1d mainnet. All runs played by the same operator in both roles; no swap between two separate
people has run (`README.md` "Proof that it works"). There is no run 7 log: it was prepared at 10 NOID and never
funded (`docs/live-run-8.md`).

| Run | Date | Setting | Outcome | What it showed |
|---|---|---|---|---|
| 1 | 2026-11-04 | 10 NOID ↔ 0.001 ETH on a local Hardhat chain; sha256 kind, raw variant; one machine | Settled; close receipt verified | The full path; claim proved in 3 s; proof bound to branch, not exact height (`docs/live-run-1.md`) |
| 2 | 2026-11-04 | As run 1; Alice never reveals | Both refunded | Bob's ETH refund 80 s after `T_reveal`; Alice's recovery at 281,522 (`D` = 281,514); preview and send must be chained (`docs/live-run-2.md`) |
| 3 | 2026-11-05 | 10 NOID ↔ 0.001 ETH on public Sepolia; sha256 kind; `sepolia` profile | Settled, 44 min funding to final | Sepolia finality 18 min 51 s; 16 min 52 s of reveal margin left; reveal to Bob's submission 84 s (`docs/live-run-3.md`; `docs/protocol-design.md` §9.3) |
| 4 | 2026-11-05 | Sepolia; Alice aborts, Bob never appears | NOID recovered at `D` | Cost 14,800 μNOID; `tick --closed-by` recorded the close (`docs/live-run-4.md`) |
| 5 | 2026-11-05 | Sepolia; first `poseidon` kind; raw, contract v1 | Settled, about 47 min | No equivalence proof needed (`docs/live-run-5.md`) |
| 6 | 2026-11-05/06 | Sepolia; `poseidon`; Alice never reveals after Bob's lock | Both refunded | Bob's file `refunded` only at Sepolia finality; Alice's recovery at 284,644 (`docs/live-run-6.md`) |
| 8 | 2026-11-06 | 5 NOID ↔ 0.001 ETH on **Ethereum mainnet**; `poseidon`; `production` profile; one node per chain | Settled, 54 min | Mainnet gate of `live.js`; Bob locked 76 blocks before lock-by, claim final 647 blocks before `D`; fees 0.0148 NOID and 0.0001207 ETH (`docs/live-run-8.md`) |
| 9 | 2026-11-06 | Sepolia; `poseidon`; two machines; contract funded three times by mistake | Stopped before any lock | The more-than-one-instance rule stopped both sides; all three instances recovered at `D` (`docs/live-run-9-10.md`) |
| 10 | 2026-11-06 | As run 9, funded once | Stopped after Bob's lock | Reveal not sent before the cutoff: Bob refunded, Alice recovered, secret never published (`docs/live-run-9-10.md`) |
| 11 | 2026-11-06 | 5 NOID ↔ 0.001 Sepolia ETH; `poseidon`; two machines; one node per chain | Settled, 44 min | A hand-copied bundle arrived damaged and was refused before anything was sent (`docs/live-run-11.md`) |
| 12 | 2026-11-06 | As run 11 with two Parano1d nodes and two Sepolia endpoints per side | Settled, 45 min | The two-node check (F5) live; nodes joined by one SSH tunnel (`docs/live-run-12.md`) |
| 13 | 2026-11-06 | As run 11; Alice's steps driven from the operator console over the same `scripts/live` helpers | Settled, 50 min (Alice's side) | A damaged bundle refused again; 6 blocks were left to Bob's lock-by when his lock was offered, because funding waited for `h_create` (`docs/live-run-13.md`; `TASKS.md` M2.7b) |

Never run (`TASKS.md` M2.7, M2.7b; `docs/live-scenarios.md` §4 to §7; `README.md` "Status and warnings"):

- a hostile counterparty, or two separate people;
- the stock variant (client S, `--import-wallet-secret`);
- contract v2 (fixed fee);
- a forced epoch rotation inside a swap window (the T6 guard and the re-prove path);
- a conflicting close at minimum fee, and the `F_max` burn (Q1);
- second nodes that are independent of the counterparty (in run 12 each side's second Parano1d node was the
  counterparty's own, and both machines were on one private network);
- the Bitcoin leg (signet: nothing broadcast, `README.md` repository map);
- the abort paths on Ethereum mainnet;
- `recover-noid.sh` in its current form ("Not yet run live in this form", `scripts/live/README.md`; run 9 used a
  hand-made script, `docs/live-run-9-10.md` finding 4).

---

## 7. Earlier reviews and what became of their findings

All reviews below are internal and read-only unless noted; none is an external audit (`SECURITY.md`). Counts are as
the documents state them.

**`docs/review-1.md` (design and harness, 2026-11-03/04).** Ten claims checked: CONFIRMED, none refuted, with
citation fixes; eight wording corrections to `docs/parano1d-capabilities.md`, all applied on 2026-11-04 ("Applied"
section); nine additional risks R1 to R9 (first-seen with no RBF, reorg across `D`, `max_fee` below 5,800,
deadline sanity, instances, privacy). The open point on height binding was settled by run 1.

**`swap-cli/REVIEW-1.md` (2026-11-04).** 4 critical, 4 high, 8 medium, 8 low, 5 nit. The gates in `params.rs` were
found sound; the problems were around them. All critical and high findings (C1 to C4, H1 to H4) were applied with
tests, plus L1, L6, M3, M4 and part of M5; M1, M2, M6, M7, M8, L2 to L5, L7, L8 and the nits were left as follow-ups
("Applied 2026-11-04").

**`swap-cli/REVIEW-2.md` (2026-11-04).** Verdict "not safe against a real, possibly malicious counterparty". 14
findings: 2 critical, 3 high, 4 medium, 5 low; 8 suspected attacks refuted. All 14 had fixes in code the same day
(status note).

**`swap-cli/REVIEW-3.md` (2026-11-05, re-review of the REVIEW-2 fixes).** 7 CLOSED, 7 PARTIAL, 4 new (G1 Medium:
dev-mode receipts accepted; G2, G3, G4 Low to Low-Medium). Seven must-fix items, all fixed on 2026-11-05 ("Fix
status"). Verdict: "not yet safe to hand to a stranger" until a live run exercises the new gates and a fresh review
checks them. REVIEW-4 later found F1, F2 (M1.1 still open), F4, F7, F10 and G1 to G4 closed, F3 partial, F5 closed in
code and partial in practice (`swap-cli/REVIEW-4.md` "REVIEW-3 Fix status re-checked").

**`swap-cli/REVIEW-4.md` (2026-11-05).** 12 findings: 2 Medium, 2 Low-Medium, 5 Low, 3 Info. Verdict: owner or trusted
counterparty at trial amounts, yes; a stranger on `sepolia` only; not production or mainnet with a stranger until
R4-1, R4-2, R4-3, R4-8 and M4. REVIEW-5 found R4-1 and R4-8 PARTIAL and the other ten closed, some with stated limits (`swap-cli/REVIEW-5.md`
"REVIEW-4 findings at HEAD" and "Summary").

**`swap-cli/REVIEW-5.md` (2026-11-05).** 8 findings: 1 Medium, 1 Low-Medium, 2 Low, 4 Info. `swap-cli/README.md`
"What REVIEW-5 changed" records a fix for each, pinned by `tests/review5.rs` (14 tests). Before a stranger it asks
for R5-1, R5-2, R5-4, the R4-8 remainder and M1.1.

**`swap-cli/REVIEW-6.md` (2026-11-05, the `poseidon` kind).** Every kind-confusion and secret-exposure attack refuted;
1 Medium, 3 Low, 4 Info. REVIEW-7 found R6-1, R6-2, R6-3, R6-5, R6-8 CLOSED, R6-4 and R6-7 PARTIAL, R6-6 OPEN (Info).

**`swap-cli/REVIEW-7.md` (2026-11-05).** 2 Low, 6 Info. R7-1, R7-2, R7-5 and R7-6 fixed; R7-3, R7-4, R7-7, R7-8 not
part of the fix (`swap-cli/README.md` "What REVIEW-7 changed"); R7-7 is the lost pre-flight for a receiver that gains
code after the last poll (A25). Verdict: owner in both roles on Sepolia, yes; owner at
trial amounts on mainnet, nothing in the diff blocks it; before a stranger: R7-1, R7-2, a real build binding (R6-4),
a required second Ethereum node at Bob's lock (R7-4), the REVIEW-5 items; beyond trial size also M4, the second Yul
review and Q8.

No review document covers the changes after REVIEW-7. The bundle check, the funding helper `fund.sh` and the helper
fixes were each reviewed before commit (the commit messages say "reviewed"); no review document exists.

**`swap-cli/CHAOS.md` (seeded chaos test, 1,000 to 3,000 scenarios per seed).** Sixteen findings at first; nine fixed
on 2026-11-05 (F-1, F-3, F-4, F-5, F-9, F-12, F-13, F-15, F-16), plus F-17, F-18 and F-19 found later and fixed.
Open, per the last list in the document: F-2, F-6, F-7, F-8, F-10, F-11, F-14, all Low or Info. "Atomicity held in
every budgeted scenario of every run." Limits ("Limits of this test"): one real instance and one real lock in the simulator; no real proofs
or transports; in the hostile scenarios a lost leg is "explained" by any of nine adversity tags, which the document
itself calls generous, so atomicity is judged exactly only in the budgeted scenarios; a Parano1d chain faster than the
20 s planning figure is outside the test.

**`docs/poseidon-evm-review.md` (2026-11-04).** Field arithmetic, basis change, all rounds, sponge and byte order
confirmed by hand; "safe to keep building on, not yet for real funds", with a must-do list (`TASKS.md` M4.0).

**`docs/poseidon-v2-review.md` (2026-11-05).** No defect in `Poseidon2b.sol` or `HTLCPoseidonV2.sol`; EVM `Addr`
equals the node's for every input, "from a proof over all inputs plus machine checks". Testnet yes; trial amounts yes
once the tooling items V2-6 to V2-10 are in place. The Yul was reviewed as source; the compiled bytecode was not
("Not checked").

**`docs/formal/README.md` (model check).** No invariant violated with all gates on; every gate switched off alone
gives a counter-example; one finding on `Gates::validate`, now in the validator (section 3.4). Run on scaled-down
parameter sets, not on the production numbers (A29). Not reviewed independently.

---

## 8. A map of the code for a reviewer

Read these first. Line numbers are those at the commit that adds this packet.

**`parano1d/contracts/`**

- `htlc.pruv`, `htlc_v2.pruv`: the whole lock. Must guarantee: claim branch pays only Bob and needs `Addr(s)`;
  recovery branch pays only Alice from `D`; close-only; v2: fee equals `max_fee`.
- `parano1d/harness/src/lib.rs` `check_swap_params` (L301), `MIN_CLOSE_FEE` (L264): refuses
  `claim_recipient == claim_authority` and `max_fee < 5,800`.

**`eth/contracts/`**

- `HTLC.sol` `newLock` (L125), `claim` (L155), `refund` (L177): disjoint windows, fixed receiver, sender-only refund.
- `HTLCPoseidonV2.sol` `claim` (L167): timelock first, 68-byte calldata, gas floor, then `Poseidon2b.addr`.
- `Poseidon2b.sol` `addr` (L49), `permute` (L71), `_towerToFlat` (L118): must equal the vendor `Addr` for every
  input. `derive` and `addrStock` exist but V2 does not use them.

**`equiv/`**

- `portable/src/lib.rs` `addr` (L255), `derive` (L267), `statement` (L306), `encode_public` (L315): the statement the
  guest proves; must equal the vendor crate.
- `zkvm/methods/guest/src/main.rs`: commits only `variant ‖ H ‖ A`.
- `zkvm/host/src/main.rs` `check_receipt` (L198), `refuse_remote_proving` (L165), `refuse_dev_mode` (L180):
  verification against the image id, journal comparison, no remote prover, no dev mode.

**`swap-cli/src/`**

- `params.rs` `Gates` (L283), `PRODUCTION` / `REHEARSAL` / `SEPOLIA` (L338 to L420), `choose_t_reveal` (L685),
  `check_i2_eth` (L710), `validate` (L804), `HTLC_CODE_HASH`, `HTLC_POSEIDON_V2_CODE_HASH`, `EQUIV_IMAGE_ID`
  (L486 to L516): every timing gate and pin.
- `engine.rs` `decide` (L503) and `spend_blocker` (L740): one choke point; every spend needs fresh, known
  observations, else wait. `alice_action` (L1729) and `alice_check_lock` (L1503): no reveal outside (I2), (I3) or
  with an ambiguous instance. `bob_action` (L2517), `bob_claim_action` (L2179), `poseidon_prelock_blocker` (L2414):
  no lock outside (I1) or the lock-by; claim on first sight of the secret. `noid_nodes_agree` (L945),
  `eth_nodes_agree` (L972): the two-node check. `tick_apply` (L2850), `cancel_intent_checked` (L3074): the intent
  ledger, so no spend is emitted twice.
- `swapfile.rs` `check` (L300), `check_bob_terms` (L411), `load` (L1021): Bob's opening rebuilt from his own terms,
  kind and pin consistent; `seal` / `open` (L746, L764): the secret sealed to the public section's digest.
- `bundle.rs` `open_bundle` (L157): a damaged bundle is refused before anything else.
- `client/raw.rs` `build_claim` (L146), `submit_claim` (L303): Bob's NOID close, preflighted and self-verified.
- `equiv.rs` `verify_receipt` (L134): runs `equiv-prove verify` and requires the pinned image id.
- `watch/eth.rs`, `watch/parano1d.rs`: what each chain is believed to say; locks found by indexed sender and receiver.

**`eth/scripts/live.js`** (the Ethereum sends)

- `bindSwap` (L851), `checkLockAgainstSwap` (L909), `verifyTarget` (L943): the send matches the swap file, the
  chain id and the pinned code hash.
- `claimChecked` (L1309): the reveal cutoff and lock finality enforced again at send time; secret from stdin only.
- `mainnetFlags` (L251), `checkFeeCap` (L312): chain 1 only with `--mainnet`, a fee cap and `--swap FILE`.

**`scripts/live/`**

- `fund.sh`: funds exactly once; three markers written before the wallet call.
- `reveal.sh`, `claim.sh`, `lock.sh`, `refund-eth.sh`, `recover-noid.sh`: one spend each, nothing sent without
  `--submit` or a missing `--dry-run`.
- `env.sh`: `--single-node-ok` only when the operator sets it.

---

## 9. How to reproduce the offline suites

From `PROJECT.md` "How to run" and `README.md` "How to run the tests". For the Rust parts, Linux or WSL2 is the
route used for the suites below; native builds are possible with extra tools (`PROJECT.md` "How to run"), and the live
helpers also ran natively, not under WSL, on the second machine in runs 9 to 13 (`docs/live-run-9-10.md`). The vendor
pins Rust 1.96.0.

```sh
cd eth && npm install && npx hardhat test            # 267 passing
cd btc && npm install && npm test                    # 91 passing
cd parano1d/harness && cargo test                    # 37 tests (+1 ignored P_auth benchmark)
cd equiv && cargo test --release                     # 23 tests; EQUIV_PARITY_N=100000 for the large parity run
cd equiv/zkvm && cargo test -p equiv-guest-core      # 3 tests; proving needs rzup (equiv/README.md §5)
cd equiv/zkvm && EQUIV_RECEIPT_DIR=<dir with raw.receipt, stock.receipt> cargo test --release -p equiv-host
cd swap-cli && cargo test --offline                  # 532 tests (+1 ignored)
bash scripts/live/selftest.sh                        # 204 cases, no network
# the Pruv contract, from the vendor workspace:
cargo run -p noid_pruv --manifest-path vendor/parano1d/Cargo.toml -- \
  verify parano1d/contracts/htlc.pruv --params parano1d/contracts/htlc.params.example.json --z3 "$(which z3)"
```

The counts for `swap-cli`, `eth` and the self-test are those at the commit that adds this packet (532, 267, 218). The formal model:
`cd docs/formal && python model.py all` (`docs/formal/README.md` §1). The chaos test:
`cd swap-cli && cargo test --offline --test chaos` (`swap-cli/CHAOS.md` "Run it"). Never fund the example params:
their secret is the public test vector `00 01 … 1f` (`SECURITY.md` rule 1).

---

## 10. Known limits and things deliberately out of scope

- **Trial amounts only** until M4. `rehearsal` and `sepolia` cap at 20 NOID and 0.01 ETH; `production` has no cap
  (`params.rs`).
- **Ethereum receivers must be EOAs.** Smart-contract wallets are not supported in v1 (`docs/protocol-design.md` §8 T11).
- **The `poseidon` kind is raw-variant only.** The stock variant would need three more permutations, about 1.7 M gas
  (`HTLCPoseidonV2.sol` header).
- **Bitcoin.** Script and builders exist with tests; nothing broadcast on signet; Bitcoin needs SHA-256 and the
  equivalence proof; its claim branch never expires, so Bob's window runs to when his refund is buried
  (`docs/protocol-design.md` §3.3, §3.4).
- **Native tokens and NFTs** cannot be held by these contracts; NOID only (`docs/parano1d-capabilities.md` §5).
- **The opening cannot be recovered from chain** after it leaves the mempool; both parties must keep it
  (`docs/protocol-design.md` §8 T15).
- **Alice's active wallet address must not change** before her refund (`docs/protocol-design.md` §8 T16).
- **No version change in the swap window** (I5); the tool knows one hardcoded activation height (279,370) and reads no fork schedule from the node, so a future fork would need a code change and a new profile review
  (`docs/protocol-design.md` §8 T7).
- **Fair exchange of value** (the free option, premiums) is out of scope (`docs/protocol-design.md` §8 T13).
- **Privacy** is out of scope for v1 (T19).
- **Upstream Parano1d itself** (consensus, the GKR prover, the block proof) is taken as vendored at `d29b801` and is
  only read, never changed (`PROJECT.md` "Conventions").
- **The operator console.** Run 13's Alice steps were driven from it over the same `scripts/live` helpers
  (`docs/live-run-13.md`). It is not part of the public tree and is not offered for review.
- **Operational lessons not yet in the engine.** Funding should happen right after Bob's bundle check, not at
  `h_create`, or Bob's lock window shrinks (`TASKS.md` M2.7b, run 13 item 2; `docs/runbook-two-party.md` §3).

---

## 11. Inconsistencies found while writing this packet

Where the code exists, its value is used above. Items 1 to 6 and 12 were corrected in the documents after this packet
was first written; they are kept here so a reviewer who holds an older copy can see what changed.

1. **Size of the Poseidon2b constants.** `docs/protocol-design.md` §8 T8 says "all round constants are ≤ 0x7 and MDS
   entries ≤ 0x2000"; `docs/parano1d-capabilities.md` ("Cryptanalytic margin"), `equiv/README.md` §7 item 4 and
   `PROJECT.md` said all constants are ≤ 0x2000. Settled by reading
   `vendor/parano1d/noid_poseidon2b/src/native/permutation.rs` (L184 to L206): round constants and full-round MDS
   entries are ≤ 0x7, the partial-round diagonal is 0x20, 0x2000, 0x200, 0x800 and the rest is 1. T8's wording is
   correct; the other three documents now give the exact values. `docs/poseidon-evm.md` (about L156) still says
   "all <= 0x2000".
2. **Old production timeouts in `docs/poseidon-leg.md` §3:** `D = creation + 725`, lock-by `D − 619`.
   `swap-cli/src/params.rs` `PRODUCTION`: `D_offset` 735, lock-by `D − 629` (raised with `B_safety` 30 on 2026-11-05; 738 and `D − 631` since 2026-11-08,
   `docs/protocol-design.md` §9.1). Corrected in `docs/poseidon-leg.md`.
3. **First live use of `production`.** `docs/protocol-design.md` §9.1 profile table said `production` was "exercised
   live" in runs 1 and 2; `docs/live-run-8.md` says run 8 was "the first live use of the `production` profile".
   The table now follows the run 8 log.
4. **Mainnet refusal.** `README.md` "Status and warnings" said the `production` profile "refuses Ethereum mainnet";
   `eth/scripts/live.js` (header, L51) refuses chain 1 only without `--mainnet`, and run 8 ran on mainnet under
   `production`. Corrected in `README.md`.
5. **Run counts in `README.md`.** The opening paragraph said "nine real runs", the heading "eleven runs", the
   table lists twelve (runs 1 to 6 and 8 to 13) and the repository map omitted `docs/live-run-13.md`. All counts now
   say twelve runs, numbered 1 to 13, with no run 7 log.
6. **Review status in `SECURITY.md`.** It named two code reviews (REVIEW-2, REVIEW-3) and value "only in trial
   amounts (10 NOID against 0.001 ETH)"; the tree holds REVIEW-1 to REVIEW-7, and run 8 moved 5 NOID against
   0.001 mainnet ETH. Brought up to date.
7. **Second Yul review.** `docs/poseidon-v2-review.md` is titled "Second review" of `Poseidon2b.sol`; `docs/poseidon-leg.md`
   §7 and §10, `swap-cli/REVIEW-6.md` and `swap-cli/REVIEW-7.md` list "the second independent Yul review" as not done.
   `docs/poseidon-leg.md` §9 item 10 also says no live run of the `poseidon` kind was made; runs 5, 6 and 8 to 13 used it.
8. **Equivalence host test count.** `PROJECT.md` and `README.md` say 14 host tests; `equiv/README.md` §6 says 22 passed
   (and `TASKS.md` M2.5c says 22). The same section of `equiv/README.md` breaks the 22 down as 14 receipt and refusal
   tests at M1.4b, 6 stdin and argument tests, and 2 dev-mode tests; left as it is.
9. **Test counts in `PROJECT.md`.** Settled: `PROJECT.md`, `README.md` and this packet now give the same counts.
10. **Comment on `PRODUCTION` in `params.rs`.** It reads "Section 9.1 as it stood on 2026-11-04", but the values include
    `B_safety` 30 and `D_offset` 735, set on 2026-11-05 (31 and 738 since 2026-11-08).
11. **Sepolia finality in `params.rs` module notes:** "about 13 min"; run 3 measured 18 min 51 s
    (`docs/protocol-design.md` §9.3). The budget used (1,140 s) matches the measurement.
12. **Header of `docs/protocol-design.md`:** said "Live runs: 1 so far". Twelve are logged; corrected.
13. **Q9 in `docs/protocol-design.md` §9.2:** "not on the v1 path". The `poseidon` kind answers it and is used in every
    run since run 5 (`TASKS.md` M4.0).
14. **`TASKS.md` M0.5** says "§4.3–4.5 examples still quote the old numbers"; the same file's Housekeeping list and
    `docs/protocol-design.md` §4.3 to §4.5 say they were refreshed.
15. **The opening paragraph of `docs/runbook-two-party.md`** says no two-machine run happened ("both live runs were the owner playing both
    roles on one PC"); runs 9 to 13 used two machines.
16. **Number of negative cases for `equiv-prove verify`.** `PROJECT.md` says 138; the table in `equiv/README.md` §6 adds
    up to 139 rejected cases (counting the 4 garbage-file cases), plus 1 dev-mode receipt case and 5 `RISC0_DEV_MODE`
    refusals. This packet quotes the table.
17. **Scope of the Solidity audit task.** `TASKS.md` M4.2 reads "Solidity audit of `HTLC.sol` / `HTLCERC20.sol`". The
    contracts used in runs 5, 6 and 8 to 13 are `HTLCPoseidonV2.sol` and `Poseidon2b.sol`, which the task does not
    name.
18. **Scope of the model check.** `docs/formal/README.md` §3 lists production `B_safety` 20 (and 242, 619, 725) as
    "relations only"; the model ran on the scaled sets, which use `B_safety` = `NF` + 3. The production numbers
    changed after the run (252, 629, 735; 254, 631, 738 since 2026-11-08) and were not run (A29).
19. **Finality depth.** The documents and the tool counted a block as final at tip ≥ height + 17 and aimed Bob's claim
    at `D − 18`; the vendored node's `is_final` is tip ≥ height + 18. Fixed 2026-11-08: `B_final` 19, claim target
    `D − 19`, production `B_safety` 31, `B_post`, `RHS(I1)` and `D_offset` recomputed in every profile (tables above;
    `docs/protocol-design.md` §9.1). The earlier reviews that confirmed the 17 rule carry an erratum note.
