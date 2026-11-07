# Ideas: ranked improvements to the NOID ↔ ETH/BTC swap protocol and tooling

Written 2026-11-04 after live runs 1 and 2, against `docs/protocol-design.md` (the "design"), `docs/review-1.md`,
`swap-cli/REVIEW-1.md`, `docs/live-run-{1,2}.md`, `docs/parano1d-capabilities.md` and the vendored Parano1d docs and
source at `d29b801`. Vendor paths are relative to `vendor/parano1d/`. Nothing here is implemented; every idea names the
experiment that would settle it. Each section starts with two plain-words sentences for the owner, then the technical part.

Reading key: **value** = what it buys (safety, time, money, reach); **effort** S = a day, M = a week, L = more;
**risk** = what breaks if it is done wrong; **recommendation** = now (next month), later (after M2.7/M4), never.

## Summary table

| id | idea | value | effort | risk | recommendation |
|---|---|---|---|---|---|
| 12 | Act on the live-run lessons (prove before creating the file, mandatory code hash, two machines) | high | S | low | **now** |
| 3 | Rehearsal profile: same gates, short windows (`D = +120`) so an abort cycle takes 1 h | high | S–M | low if pinned and amount-capped | **now** |
| 5 | Fixed-fee close (`fee == max_fee` in the program) kills the min-fee stall; then run Q1 | high (Bob's safety) | S + M (Q1) | contract v2 changes the pinned source | **now** |
| 2 | Pre-prove π in the background; guest speed-up (M1.5); bigger RAM; dedicated circuit later | high (36 min off the critical path) | S / M / L | low | **now** (pre-prove), later (circuit) |
| 10 | Trustless watchtower for Bob; two-node tip check; batch the mempool lookups | high (liveness) | S each | low | **now** |
| 1 | Poseidon2b inside the EVM HTLC: ETH locks on `A`, no π on EVM legs | high (removes two trust assumptions) | M | Solidity bug → Alice reveals into a revert | **now** (decide on the gas number) |
| 13 | Stablecoin leg (`HTLCERC20.sol` exists): quote NOID in USDC | medium | S | low | next |
| 11 | Signed bundles (ETH keys) and a `bundle verify`; relay/order board later | medium | S / M | low | now (signatures), later (relay) |
| 14 | Escrow the 699-byte opening in the ETH lock event (recoverable forever) | medium | S | none | next |
| 6 | Fees: market-maker spread now; `feeBps` field in `HTLC.sol` v2 as a default; no NOID-side fee program | money | S / M | user flight if hidden | now (spread), later (field), never (NOID two-output) |
| 7 | Agent custody: `period_budget_wallet` as the swap agent's capped wallet, cold recipients | high (safety of automation) | M | new continuing-call code | later |
| 4 | Free option: shorter `W_A` with automated reveal; Bob-side premium in `HTLC.sol`; price it | medium | S / M | griefing surface | later |
| 9 | Privacy: keyed variant `Addr(s ⊕ k)` so the two legs are unlinkable after the reveal | low–medium | S | conflicts with idea 1 | later |
| 8 | More chains: HyperEVM/L2 (S), Solana and CosmWasm (M), XRPL escrow (M), three-way (L) | reach | S–L | per-chain finality models | next (EVM L2), later (rest) |

Top three: **12 + 3** (cheap, unblock the remaining M2.7 scenarios), **5** (one instruction removes the open Q1
attack), **1** (if the EVM Poseidon2b costs under ~1.5 M gas, the ETH leg no longer needs a zkVM at all).

---

## 1. Poseidon2b inside the Solidity HTLC: lock ETH on `A` directly

**Plain words.** Today Ethereum locks on a SHA-256 hash and Parano1d locks on a Poseidon address, and a 20–36 minute
zero-knowledge proof convinces Bob that the two hide the same secret. If the Ethereum contract can compute the Parano1d
address itself, both chains lock on the *same* value and that proof disappears for Ethereum swaps.

A parallel prototype covers the implementation (`eth/contracts/Poseidon2b.sol`, `docs/poseidon-evm.md`, not present at
the time of writing); this section covers only the protocol consequences.

- **What changes.** `newLock(A, timelock, receiver)` stores the 32 address bytes; `claim(lockId, s)` checks
  `Addr(s) == A` with `s` interpreted exactly as `noid_gkr` does (`s_lo = le128(s[0..16])`, `s_hi = le128(s[16..32])`,
  tower basis, `ADDRFIX_` IV, lanes 0–1 LE; capabilities §10). `H` and π vanish from the ETH artifacts (design §2.1 a2,
  a5). The bundle for an EVM leg carries only `A`; Bob's check becomes "`lock.hashlock == claim_authority` byte for
  byte" (§6.3 item 8 loses the receipt, image ID and journal; `EquivalenceAttestation` becomes per-leg optional).
- **What Bob still checks.** Opening rebuild, policy fields, `D` feasibility, `getSlotsByOwner(A)` empty, the pinned
  code hash (now also pinning the Poseidon2b library). Step 11's local `Addr(x)` recheck stays as a diagnostic.
- **What disappears.** Trust in RISC Zero soundness (98-bit conjectured, Q11), in its zero-knowledge (Q3 for the
  capsule is unrelated), the reproducible-ImageID problem (M1.1), the 223 KB receipt, and the whole T10 row for EVM legs.
  The 2.7 GB proving floor on the owner's 3 GB VM stops mattering for ETH swaps.
- **Security.** Both legs now rest on Poseidon2b preimage resistance (Q8/T8). That is not a *new* assumption for a NOID
  holder: every Parano1d address already rests on it, and a preimage of `A` already lets anyone close the NOID lock. Note
  what a preimage attacker gains on ETH: nothing redirectable, because `claim` pays the fixed receiver (`HTLC.sol:L172`);
  it only forces settlement. Second-preimage/collision resistance also matters now (a second `s'` with `Addr(s') = A`
  would claim on ETH *and* NOID, both to fixed recipients, still harmless for value). The one property SHA-256 bought,
  independence of the ETH leg from Poseidon2b, is worth little once the recipients are fixed.
- **Bitcoin is unchanged.** Script has `OP_SHA256` only, so BTC legs keep `H = SHA-256(s)` plus π (idea 2).
- **Stock variant.** `Addr(Derive(m,0))` is 4 permutations on chain (4× the gas); keep EVM-direct for the raw variant
  and the stock variant on the SHA-256 + π path, or accept the gas.
- **Cost.** A bit-serial GF(2^128) multiply in Solidity is roughly 128 iterations of shift/xor/branch, ~4–5 k gas;
  502 multiplications per permutation (`equiv/README.md` §6) gives ~2–2.5 M gas naive, ~0.3–1.2 M with table-driven
  constant multiplications (322 of the 502) and 4-bit windows. The claim is paid by Alice (claimant). On an L2 this is
  cents; on L1 at 2026 gas prices under 0.003 ETH. That prototype's benchmark settles Q9.
- **Hazard.** A Solidity/portable mismatch makes Alice's `claim` revert *with `s` in calldata*: Bob claims NOID, Alice
  loses both (design §2.3 row 4). Mitigations before any funded use: differential test of the Solidity against
  `equiv/portable` on ≥ 10^5 vectors (the crate is the oracle, it already has 100,000-input parity with vendor), the
  §0 test vector, a 0-value "canary" lock claimed on the deployed contract, and the existing `eth_call` dry run of
  `claim` before broadcast (T11), which catches a deterministic bug.
- **Experiment.** (1) gas number from `docs/poseidon-evm.md`; (2) differential test; (3) one local-Hardhat swap with
  the new contract through `swap-cli` (`EvmLockKind::Poseidon` variant in the swap file and `watch/eth.rs`).
- **Effort** M (contract exists in progress; swap-cli variant + tests + a Solidity audit item for M4.2). **Risk** medium
  until audited. **Design changes:** §0 (`H` only for BTC legs), §2.1 a2/a5, §2.2 steps 2 and 5, §5 scope ("BTC and
  non-programmable chains only"), §6.3 item 8, §8 T8/T10/T17, §9.2 Q9 answered, Q11 narrowed. Recommendation: now.

## 2. Make π fast where it is still needed

**Plain words.** The proof that the two locks share one secret takes 20–36 minutes on the owner's machine, mostly
because the virtual machine is short of memory. There are four ways to make that wait disappear, and one popular idea
(renting a big machine) that is not allowed, because the machine would see the secret.

- **Where it is still needed.** BTC legs, XRPL (idea 8), any chain without a programmable hash, and EVM if idea 1's gas
  is too high.
- **(a) Prove ahead of time (S, do first).** The journal is `variant ‖ H ‖ A` only; it does not depend on `D`, Bob, amounts
  or dates. So Alice can draw secrets and prove them *before* any swap exists (overnight, one proof per secret, never
  batched into one journal because a batch would reveal her future hashlocks). `swap-cli secret-new` → sealed pool
  entry `{H, A, receipt}`; `new-alice --from-pool` consumes one. This removes the 20–36 min from the critical path and
  fixes the `h_create` planning problem of run 2 (planned +40 blocks, still 22 late). The same reordering (prove, *then*
  create the file with `h_create = tip`) is lesson 12.a even without a pool.
- **(b) Guest speed-up (M1.5, M).** Table-driven constant multiplications (322/502) and 4-bit windowed variable
  multiplications: 5–10× fewer cycles (`equiv/README.md` §6). 2.75 M user cycles → ~0.3–0.6 M; the receipt stays
  223 KB; the ImageID changes (re-pin).
- **(c) RAM and GPU (S).** The 2.7 GB floor is the succinct recursion prover; the VM has 2.9 GB. `.wslconfig
  memory=6GB` on the 8 GB PC (close the browser) or any 16 GB machine. Estimate (not measured; the only measured runs
  were swapping): 2–5 min CPU on 8 cores/16 GB for the current guest, ~1 min after (b); tens of seconds with a CUDA
  `r0vm`. RISC Zero's accelerators cover SHA-256 (already used) and 256-bit modular bigint, not GF(2^128), so no further
  precompile help.
- **(d) Dedicated circuit (L, later).** Groth16/circom with bit decomposition: ~0.5–1 M constraints (Karatsuba 2.2 k AND
  per variable multiplication, linear MDS), proving 20–60 s, but a per-circuit trusted setup between adversaries
  (design §5.3 already says no). Noir/Halo2: similar size, universal setup, 1–3 min; gain over (b)+(c) is 2–5×, not
  worth a second proof system yet. Binius-style binary-field proof: Poseidon2b *is* a Binius tower-field permutation
  (vendor code "adapted from binius_poseidon2b"), ~180 non-linear multiplications per permutation, seconds; but ZK needs
  explicit blinding and the libraries are young. The right long-term answer, after M4.
- **(e) Prove on a bigger machine with the secret never leaving — not possible, and why.** A prover must execute the
  guest on `s`; whoever runs it learns `s`. A third party holding `s` before Bob locks can be Bob (or sell it to him),
  and Bob with `s` closes the NOID lock to himself without ever locking ETH (design §5.1 property 2). Collaborative
  proving (MPC-split witness, "coSNARKs") exists in research and is not available for RISC Zero. The host already refuses
  Bonsai/remote provers (M1.4a); keep it that way.
- **(f) Prove once per wallet and reuse — no.** Secret reuse is forbidden (T9): once `s` is public every lock under `A`
  is claimable by anyone. A per-wallet statement over `Derive(m,i)` would still need one proof per `i`, which is (a).
- **Experiment.** Implement (a); run (b) and re-run the 100,000-input parity; measure prove time with 6 GB and on a
  16 GB machine; record in `equiv/README.md` §6 (the M1 acceptance "≤ 15 min on 8 cores" is probably met already).
- **Effort** S (a), M (b), S (c), L (d). **Risk** low; (b) changes the ImageID. **Design changes:** §2.2 step 2 ("π may be
  pre-computed"), §5.2 measured cycles, §5.4 implementation rules (pool file format, one proof per secret).
  Recommendation: (a)+(c) now, (b) next, (d) later.

## 3. A rehearsal profile for swap-cli

**Plain words.** The safety margins make a real swap last six hours, so rehearsing the "nobody shows up" paths costs a
working day each. A second set of smaller numbers, computed by the same formula and only usable with tiny amounts, lets
the same software rehearse an abort in about an hour.

- **Problem.** `D_offset = 725`, `W_A = 7,200 s`, `B_post = 242` (at the time of writing; production is now 735 and 252, design §9.1) are constants in `swap-cli/src/params.rs`. Run 2 funded at
  15:55 UTC and `D` arrived at about 21:45 UTC. Six M2.7 scenarios remain (Alice-abort before lock, Bob-abort, rotation, `F_max`
  burn, conflicting close, stock) and each needs an abort cycle.
- **Proposal.** `Profile { w_a, w_a_min, m_a, delta_detect, p_auth, b_epoch, b_fee, b_final, b_safety, b_fund, b_bob,
  margin, d_offset }`, with `mainnet-v1` = today's §9.1 and `rehearsal` derived by the *same* (I1) arithmetic:
  `RHS(I1) = ⌈(W_A + Δ_detect + 2·P_auth)/τ_fast⌉ + B_post`. Example for a local Hardhat chain (finality = latest):
  `W_A = 600, Δ = 60, 2·P_auth = 40, B_epoch = 0, B_fee = 10, B_final = 18, B_safety = 5` → `B_post = 33`,
  `RHS = 35 + 33 = 68`; `D_offset = B_fund 5 + B_final 18 + B_bob 20 + 68 + margin 9 = 120` (1 h at 30 s). For Sepolia
  `M_A` must stay above its ~15 min finality, so `W_A ≥ 1,800` and `D_offset ≈ 200`. `B_epoch = 0` accepts the
  rotation risk *in a rehearsal*; keeping it at 144 makes `D ≥ +270`, still 2 h 15 m instead of 6 h.
- **Guards.** The profile name is in the swap file and in the bundle; `new-bob` refuses a bundle whose profile differs
  from his flag; `rehearsal` refuses `amount > 20 NOID`, ETH chain ids other than 31337/11155111 and ETH amounts above
  0.01; `gates` prints the profile. The inequalities (I1)–(I5) are unchanged code.
- **Bonus.** With `D = +120` the forced-epoch-rotation scenario becomes schedulable: choose `h_create` so a `k·144`
  boundary falls inside the claim window and prove the first claim in its last 4 blocks (T6).
- **Experiment.** `tests/scenarios.rs` under both profiles (parametrize the simulator); then the six live rehearsals in
  one or two days, each logged like `docs/live-run-2.md`.
- **Effort** S–M. **Risk** someone runs `rehearsal` with real money: the amount cap and the profile-mismatch refusal.
  **Design changes:** §9.1 gains a "rehearsal" column with the derivation above; §10 M2 scenario list says which profile.
  Recommendation: now.
- **Done 2026-11-04.** `rehearsal` (chain 31337, `D = +120`) and, the same day, a third profile `sepolia`: the same
  rehearsal budgets with the real Ethereum finality (1,140 s) and the production `M_A` (1,800 s, which is also
  `live.js claim`'s default margin), hence `W_A` 4,200 s and `D = +300` (2 h 30); chain 11155111 only, same caps.
  Derivation in `swap-cli/README.md` ("The rehearsal and sepolia profiles"); first use planned as `docs/live-run-3.md`.

## 4. The free option (T13)

**Plain words.** Between Alice's lock and Bob's lock, and again between Bob's lock and Alice's reveal, each party can
watch the price and walk away for free. That is an option someone is giving away; it can be shortened, priced, or
partly charged for, but in this protocol it cannot be removed.

- **Who holds what.** Bob: from funding-final to lock-by (`B_bob ≤ 60` blocks, ~30 min). Alice: from Bob's lock-final
  to `T_reveal − M_A` (~1.5 h of the 2 h window). Alice's is the bigger one.
- **Rough price.** An at-the-money option is worth about `0.4·σ·√T` of notional. With a placeholder 150 %/year
  volatility: 2 h → ~0.9 %, 30 min → ~0.45 %. That is the same order as the 1 % fee of idea 6, so a maker's spread must
  at least cover it.
- **Two-sided commit: not available.** Alice must lock first: if Bob locked ETH first, Alice could reveal and take the
  ETH without ever funding NOID (the ETH contract cannot see Parano1d). The design's role rule (§1) forces the order.
- **Parano1d bonds: not expressible.** A penalty needs a cross-chain condition ("Bob did not lock on ETH"). ABI 3 reads
  only its own call body and height (`integer_program.rs` operands; capabilities §1); a NOID bond can only be
  "unconditionally Bob's before `D'`", i.e. a gift.
- **Bob-side premium in `HTLC.sol` (M, later).** `depositPremium(H, lockBy)` before Alice funds; `newLock` for the same
  `H` before `lockBy` folds the premium back to Bob; after `lockBy` with no lock, Alice sweeps it. Alice can grief Bob
  for the premium by never funding, so `premium ≪ amount` (the option value above). Partially fair, as in the
  literature on HTLC premiums; worth it only once strangers trade.
- **Alice-side: shorten and automate (S, later).** `W_A_min = 5,400 s` could drop to ~2,400–3,000 s on Sepolia/L1
  (lock finality ~15 min + `M_A` sized to claim finality ~15 min + slack) and far lower on fast-finality chains
  (idea 8). The engine already executes `reveal_eth` as the only action at `lock_final`; an automated executor removes
  Alice's discretion only if she does not stop it, so the honest statement is "price it in".
- **Experiment.** Compute the option values from real NOID price series once they exist; A/B the quote with and without
  the premium. **Effort** S/M. **Risk** premium contract = more code to audit. **Design changes:** §8 T13 residual,
  §9.1 `W_A_min`, §2.2 step 8 (premium), new §11 economics. Recommendation: later.

## 5. Bob's claim can be stalled by a minimum-fee close (Q1, T2)

**Plain words.** Once the secret is public, anyone can send a cheap transaction that pays Bob but may sit unconfirmed
when the network is busy, and Bob cannot replace it with a better-paying one. One extra line in the contract makes every
such transaction pay the full fee, so there is no "cheap" version to get stuck.

- **Problem.** First-seen per input slot, no RBF (`noid_mempool/src/pool.rs:L1296-L1297, L1334-L1356`). Alice holds `s`
  from the start and can broadcast a 5,800 μNOID close the moment she reveals; nodes that saw it reject Bob's `F_max`
  close (`SlotConflict`). Under a sustained floor above 5,800 it stays pending until the anchor rotation or `D`, after
  which Alice refunds and keeps the ETH. Budgeted today as `B_epoch + B_fee = 204` blocks, unmeasured.
- **Proposal A: fixed-fee close (S).** The program sees `fee` (`docs/contracts/core.md:L53`) and runs on a close
  (`core.md:L23-L24`); add `require fee == max_fee;` (one `assert_equal fee immediate`, 2/16 instructions). Every valid
  close, by anyone, then pays `F_max`, which Bob already prices in (`V = Q_net + F_max`) and which is set at
  `max(50,000, 3 × estimate)` (§9.1). There is no cheaper competing transaction; the only remaining stall is a floor
  above `F_max` (T5, unchanged). Alice's refund also pays `F_max`, which she chose. Side effect: Alice's and Bob's
  closes now differ only by output slot; identical bodies are duplicates, not conflicts.
  Caveats: the opening changes (new pinned `htlc.pruv` hash, harness, `contract_params.rs`); `F_max` must be ≥ the
  live estimate at *close* time, so keep the `3 ×` headroom and consider `max(50,000, 5 × estimate)`.
- **Proposal B: operational (S).** Client R already fans out (`--submit-rpc`); add direct submission to miner-operated
  nodes (the operator-token scope includes `submitTxIntent`, `docs/reference/rpc.md:L66`) and keep the T6 rotation
  guard. Idea 10's watchtower submits from more vantage points.
- **Experiment.** Harness: close with `fee ≠ F_max` rejected by `check_call`, and a `pruv verify` postcondition; then the
  Q1 run as written in TASKS (two closes, 5,800 vs `F_max`, two nodes, across a rotation) under the rehearsal profile.
  With A in place, Q1 changes from "can a min-fee close stall Bob" to "how long can a floor above `F_max` last" (Q6).
- **Effort** S (contract + harness), M (Q1 on an isolated net or mainnet-tiny). **Risk** a v2 contract while v1 is in
  use: version the bundle. **Design changes:** §6.1 source, §6.2 table, §8 T1/T2/T5 rewritten, §4.1 `B_epoch`/`B_fee`
  possibly reduced after Q1 (shorter `D_offset`). Recommendation: now.

## 6. Fees and a business model (the owner's question)

**Plain words.** Open-source software cannot make anyone pay: whoever forks the code deletes the fee line. The money
that can really be enforced is the spread you earn when you are the counterparty, plus what people pay willingly for a
service they prefer (matching, watchtower, support). A fee can still be built into the contracts as the default, and 1 %
is normal for an illiquid coin with no bridge, high for anything liquid.

- **Where a fee can be enforced, honestly.**
  1. **ETH contract (default, not a lock).** `HTLC.sol` v2: `newLock(A_or_H, timelock, receiver, feeRecipient, feeBps)`;
     on `claim`, `fee = amount·feeBps/10,000` to `feeRecipient`, the rest to `receiver`; on `refund` the full amount back
     (a fee on failure invites griefing). `lockId` includes the fee fields; both engines pin the code hash and compare
     `feeRecipient`/`feeBps` in `lock_matches`. Economically Alice receives less ETH, so Bob's amount is negotiated as
     `Q_eth + fee`. Any two parties can deploy plain `HTLC.sol` and run a patched `swap-cli`; the fee holds only while
     the official tool and the official deployment are the path of least resistance. Show it in the bundle; a hidden fee
     is the fastest way to a fork.
  2. **Parano1d side.** A terminal close has exactly one output: "Close | one exact contract output | remaining value to
     the branch's closing recipient | none" (`docs/contracts/lifecycle.md:L55-L59`); "on a close, output 0 pays the
     closing recipient and output 1 is absent" (`core.md:L65-L67`); `check_call` pins `outputs[0].owner` to the committed
     recipient (`noid_tx/src/experimental_object.rs:L210-L213`). **No fee split on a close.** Two outputs exist only on a
     *continuing* call (successor + payout), the payout owner can be pinned by four `assert_equal` on
     `payout_owner0..3` (`core.md:L55, L60-L61`), and the recipients of any later close are still only Alice or Bob. A
     two-step program (continue paying Bob and retaining the fee, then a second continue paying the collector) fits in
     ~14/16 instructions but doubles Bob's claims, strands dust until `D`, and needs its own Z3 and circuit review.
     **Never** make `claim_recipient` the collector: anyone with `s` (Alice) could then close the whole `V` to the
     collector and Bob loses everything. The clean NOID-side form is a **second instance**: a tiny `HashTimeLock` with
     `claim_authority = Addr(s)`, `claim_recipient = collector`, recovery to Alice, funded in the same funding
     transaction (+700 μNOID). After the reveal the collector closes it with the public `s` (a client-R process the
     owner runs). It costs the collector 5,800 μNOID per close, so the fee must be ≥ ~0.05 NOID to be worth it. Also a
     default, not a lock.
  3. **Market-maker spread (the only enforced fee).** The owner is Bob or Alice for every swap and quotes
     `mid ± spread`. Needs inventory on both sides, carries price risk, and pays the free-option cost of idea 4
     (~0.5–1 % of notional at 150 % vol). At 1 % all-in the maker is near break-even on volatility alone; that is why
     OTC desks for illiquid assets charge 1–3 %.
  4. **Matching / relay / watchtower service.** Fee for finding the counterparty or for claiming on Bob's behalf
     (idea 10, 11): charged in ETH through the `feeBps` field or a subscription; bypassable by anyone who meets elsewhere.
- **Comparison.** DEX pools 0.05–0.3 % (Uniswap tiers; Parano1d's own native DEX takes 0.3 % of input,
  `docs/protocol/native-finance.md:L92-L101`), bridges 0.1–0.5 % plus gas, CEX taker ~0.1 %, atomic-swap services for
  BTC 0.1–0.5 % plus miner fees, OTC desks for illiquid tokens 1–3 %. NOID is illiquid and bridge-free, so 1 % is
  defensible *as a maker spread* and hard to defend *as a software fee*.
- **Recommendation.** (1) Now: act as the market maker at 1 % all-in during trials, quote it explicitly, keep the
  option-cost note. (2) Next: `feeBps` in `HTLC.sol` v2 with a visible default (0.25–0.5 %) and a documented `--fee-bps 0`,
  shipped together with idea 1's contract so there is one v2 audit. (3) Later: the NOID fee instance only if a collector
  process is running anyway. (4) Never: the two-output NOID program.
- **Experiment.** Ten swaps with strangers at 1 % spread; count acceptances. **Effort** S/M. **Risk** reputational.
  **Design changes:** §2.1 a12 (fee fields), §2.2 steps 8–9, §6.3 (optional fee instance), §9.1 `fee_bps`, new §11.

## 7. Agent wallets: a capped wallet for the swap agent

**Plain words.** Any program on the owner's PC can tell the wallet to pay, with no "are you sure". Parano1d ships two
contract templates whose whole purpose is a spending key that can only spend a capped amount, with the owner's real key
able to take everything back later; the swap agent should run on such a key.

- **The problem, cited.** Loopback connections get full owner scope with no header (`docs/reference/rpc.md:L39-L41`);
  `walletSend`, `walletFundObject`, `walletCallObject` need nothing else. The `--operator-key` scope is the only finer
  credential and it still includes `walletSend` and `submitTxIntent` (`rpc.md:L51-L74`). `walletCallObject`'s
  `expected_*` guards bind a reviewed body (`docs/contracts/api.md:L109-L117`) but are a client discipline, not a prompt.
- **What the templates enforce (code).** `allowance_wallet(spending_key, recovery_key, payout_recipient, recover_at,
  max_fee, max_payout, min_retained)` (`noid_tx/src/experimental_object/applications.rs:L66-L96`): before `recover_at`
  the spending key may only *continue* (`CLAIM_CONTINUE`, no `CLAIM_CLOSE`), each call's payout ≤ `max_payout` excluding
  fee, successor keeps ≥ `min_retained`, fee ≤ `max_fee`; `payout_recipient = None` sets `ANY_PAYOUT_RECIPIENT`
  (`policy.rs:L16`, `applications.rs:L87-L93`) so the agent can pay a fresh HTLC root; at/after `recover_at` only the
  recovery key closes. The ceiling is per call, not per day (`docs/contracts/templates.md:L34-L36`).
  `period_budget_wallet` (`applications.rs:L154-L206`) adds `state = [budget, start + period]` and, before the deadline:
  assert `start ≤ height`; if the window expired, reset `budget` and set the next boundary to `height + period`;
  `scratch1 = fee + payout`; assert `scratch1 ≤ budget`; `budget −= scratch1` (lines 185–203; semantics
  `templates.md:L38-L50`). So the agent's loss bound is one window's `budget`, fee-inclusive, to any recipient.
- **How swap-cli would use one.** Owner funds a `period_budget_wallet` instance (e.g. 50 NOID per 2,880 blocks) from the
  cold wallet. The agent holds the *spending key* only: either a raw secret proved with `noid_gkr` (client R already
  proves; it needs a new 2-output continuing page builder, `build_call` with a payout) or a second stock data dir whose
  index-0 is the spending key. `swap-cli agent fund` pays `V` from the budget instance to the HTLC root and records the
  successor opening (`walletListObjectStates`; every call creates a successor at a new address, `lifecycle.md:L9-L13`).
  The HTLC is built with `recovery_recipient = cold`, and on Bob's side `claim_recipient = cold`, so settled funds never
  touch the agent's key; `recovery_authority` may be the agent's key so unattended refunds still go to cold. The owner's
  wallet node is never reachable from the agent (run it in WSL: the WSL→Windows loopback is already blocked except
  through `curl.exe`, which the agent simply does not get for port 9601). Remainder swept by the cold key at `recover_at`.
- **Limits.** Not a whitelist (the agent can pay itself up to the budget); per instance (two deposits are two budgets,
  `lifecycle.md:L21-L24`); the stock wallet cannot sign for an arbitrary spending key (`builder.rs:L109-L126`).
- **Experiment.** Harness: build the budget opening, continuing call with payout to an HTLC root, `check_call`
  pass/fail on over-budget, under-reserve and expired-window; then a 1 NOID live budget. **Effort** M. **Risk** new
  consensus-adjacent page code; a mistake locks the budget until `recover_at` (recoverable). **Design changes:** §6.2
  (`recovery_recipient ≠ recovery_authority` allowed), §7 new "agent custody" subsection, §8 new row "compromised agent
  host". Recommendation: later (after M2.7, before any unattended operation).

## 8. More chains

**Plain words.** The Parano1d half of the swap never changes; only the other chain's lock, the way the secret becomes
visible, and how long to wait for finality differ. Chains that can run a small program could even use idea 1 and skip
the proof.

- **Shared:** roles (§1), the whole Parano1d side (lock, watcher, client R, (I1)/(I4)/(I5), `B_post`), the swap file and
  state machine, the gate structure (`t_L`, `Δ_detect`, `M_A`, `W_A_min`). **Per chain:** lock primitive, reveal
  extraction, finality model and timebase (seconds / heights / slots / ledger index), hashlock available (SHA-256
  everywhere; Poseidon2b only where programmable), stuck-transaction handling, RPC quirks.
- **EVM L2s / HyperEVM (S, next).** `HTLC.sol` unchanged. HyperEVM: ~1 s blocks, fast finality, small-block gas limit
  (check that a Poseidon2b claim fits; otherwise big-block). L2s: `finalized` means posted to L1 (10–20 min) while
  sequencer confirmation is seconds; pick `M_A` per chain. Gas for idea 1 becomes negligible.
- **Solana (M, later).** Program with a PDA escrow seeded by `(hashlock, sender, receiver)`; `claim(preimage)` uses the
  `sol_sha256` syscall (or Poseidon2b in BPF: ~502 multiplications fit the 1.4 M CU budget); `Clock::get().unix_timestamp`
  for the timelock; the preimage sits in the instruction data, read via `getTransaction` (no public mempool, so
  `Δ_detect` is after confirmation, ~1 s). Finality ~13 s → `M_A ≈ 60 s`, `W_A ≈ 10 min`.
- **XRPL (M, later).** Native `EscrowCreate` with a PREIMAGE-SHA-256 crypto-condition (fingerprint = SHA-256 of the
  32-byte preimage, cost 32) and `CancelAfter`; `EscrowFinish` carries the fulfillment on ledger. No programmability →
  SHA-256 + π like Bitcoin. Ledgers close every ~4 s and are final; Ripple epoch offset 946,684,800.
- **Cosmos/CosmWasm (M, later).** A CW contract with `sha2` and `env.block.time`, or compile `equiv/portable` (no_std,
  zero deps) to wasm and check `Addr(s)` directly with zero re-implementation risk.
- **Three-way with one secret (L, never for now).** A→B→C→A, every hop under the same `H`, timeouts strictly nested
  (`D_NOID > T_hop2 > T_hop1` with budgets); Parano1d still the last-claim leg; the engine needs a hop abstraction.
- **Experiment.** Deploy `HTLC.sol` on one L2 testnet and replay the rehearsal profile. **Design changes:** new §3.x
  per chain and a per-chain budget table in §4.5.

## 9. Privacy and linkability (T19)

**Plain words.** Until the secret is published, nobody can tell which Ethereum lock belongs to which Parano1d lock.
Afterwards anyone can compute the Parano1d address from the published secret and connect the two, including both
parties' addresses on both chains.

- **What is linkable after the reveal.** `Addr(s)` → the NOID instance → the 699-byte opening seen in the mempool
  (`getMempoolEntry.contract_opening_hex`, review-1 R9) → Bob's `claim_recipient` and Alice's recovery address, tied to
  Bob's and Alice's ETH addresses from the lock. The ETH `Claimed` event stores `s` forever.
- **Does it matter?** For trial-size self-swaps, no. For a maker doing many swaps, the chain becomes a public ledger of
  who traded with whom and when; amounts and timing correlate even with fresh addresses.
- **Stock variant.** Reveals the throwaway wallet master `m`, hence every `Addr(Derive(m,i))`; harmless only if the
  wallet is truly throwaway (hard rule 3). Raw is strictly better for privacy.
- **Keyed variant (S, later).** Lock NOID under `A = Addr(s ⊕ k)` with `k` a per-swap value exchanged privately; ETH
  still reveals `s`. π's statement becomes `sha256(s) = H ∧ Addr(s ⊕ k) = A` with `k` in the journal (Bob keeps the
  receipt private). On-chain nothing changes; observers without `k` cannot link. Conflicts with idea 1 (the EVM
  contract would need `k`, making it public); choose per leg. Fresh ETH keys and fresh NOID indices per swap remain
  the baseline.
- **Experiment.** Guest variant `raw-keyed`, parity tests, one rehearsal. **Design changes:** §5.1 (third variant),
  §8 T19 mitigation.

## 10. Operational: watchtower, second node, finality, staleness

**Plain words.** Bob's claim needs nothing secret: the secret is public by then and the contract can only pay Bob. So
anyone, including a machine Bob does not trust, can submit his claim for him. The tool should also stop trusting a single
node's view of the chain.

- **Trustless watchtower for Bob (S, now).** Claim authority = `Addr(s)` with `s` public after the reveal, recipient
  pinned to Bob: a watchtower needs only Bob's *public* swap file, watches ETH for the reveal and runs
  `claim --submit` from its own vantage points. Worst case it chooses the fee (bounded by `F_max`; zero discretion with
  idea 5). `swap-cli watch bob.public.json` = the `tick` + `claim` loop without a passphrase. This is also a service the
  owner can run for every Bob (idea 6.4) and the answer to "Bob offline past `D`" (§2.4 row 3).
- **Alice's side.** The reveal needs her ETH key; a pre-signed `claim` handed to a watchtower reveals `s` to it before
  broadcast (it could then force-settle, not steal). Her refund at `D` needs the wallet (or idea 7's agent key).
- **Second node (S, now; REVIEW-1 M2).** `--noid-rpc` accepted twice: require the two tips within 2 blocks and the same
  tip hash at the lower height, else `Wait`; require the tip header's timestamp within ~5 blocks of the local clock
  (L1 clock-skew item). Two ETH providers likewise. The always-on node was switched off on 2026-11-04 (the wallet app
  is the only node); a cheap second node is this item's cost.
- **Finality and reorgs.** Parano1d: add `claim_included → reorged_out → re-submit` (needs Q14: are removed calls
  re-admitted?); treat `getTx == null` after `claim_included` as a reorg, not as "verify manually". ETH: Alice's lock
  check already uses `finalized`; Bob's refund on `latest` is fine (a reverted refund now leads to the claim, H1).
- **The 120 s staleness rule under slow RPC.** A tick can be 20+ RPCs (one `getMempoolEntry` per single-page entry;
  19 seen in run 1) and public ETH RPCs rate-limit; a slow poll makes every spending action `Wait` forever. Fix: JSON-RPC
  batches for the mempool lookups (`api.md:L155-L156`), skip entries with `page_count 0` or `fee 0`, stamp `observed_at`
  per chain at the end of its poll, and express freshness as "tip moved ≤ N blocks" for Parano1d and "latest block
  timestamp" for ETH, with 120 s as the wall-clock backstop.
- **Experiment.** Run the watchtower on a second machine during the next rehearsal; inject a lagging node fixture.
  **Design changes:** §7 (watchtower subsection), §9.1 (two-node rule), §2.5 (reorg row for the claim).

## 11. Counterparty discovery and what must be authenticated

**Plain words.** Two strangers need to swap a few kilobytes of public terms and then watch the chains; the only things
that must be protected are *who gets paid* on each side, and those are already checked by each party against its own
settings. A signature with the Ethereum key that gets paid ties the terms to the right person.

- **What is exchanged.** Bundle (terms, 699-byte opening, `H`/`A`, π receipt ~223 KB for non-EVM legs, contract address,
  chain id, amounts, addresses), then funding `(txid, slot, creation_id)`, then the lock id. Everything is public except
  `s`; confidentiality is not needed, integrity and binding to the negotiating party are.
- **What must be authenticated.** Bob's `B_noid` and `B_eth` (Bob supplies them himself, C1 fixed), Alice's `A_eth`
  (she checks the lock's receiver), the HTLC address and code hash (pinned, T17; a wrong address is the realistic
  phishing). Parano1d has no signatures, so sign with the ETH keys: Alice signs the bundle hash with `A_eth`
  (EIP-191), Bob signs his terms with `B_eth`; `swap-cli bundle verify` checks both. A substituted address breaks the
  signature or changes who is paid, which the existing checks catch.
- **Transport.** Now: a JSON file over any channel. Next: a relay or RFQ board (Nostr relays are free, pubkey-identified
  and public; or the owner's own relay as the paid service of idea 6.4). NOID holders post offers `(amount, price, A, H,
  pre-proven π from idea 2a)`; takers pick. A relay holds no secret and cannot steal; it can censor or front-run offers,
  which is the taker's free option anyway (idea 4).
- **Effort** S (signatures), M (relay). **Design changes:** §2.1 (signed bundle, a2'), §2.2 step 0/4, §8 T17.
  Recommendation: signatures now, relay later.

## 12. What the live runs exposed

**Plain words.** Two real swaps taught a handful of small, cheap lessons; each is a line of code or a line in the
runbook. Doing them first makes every later rehearsal faster and safer.

- **a. Prove first, then create the file (S).** The journal does not depend on `D`, so the 20–36 min proof should run
  before `new-alice`; today `h_create` is guessed ahead (run 2: +40 planned, 22 blocks late). Split `secret-new` from
  `new-alice`, or adopt idea 2a's pool. Design §2.2: swap steps 2 and 3.
- **b. Mandatory `--eth-code-hash` on both sides (S).** Run 1 rewrote Bob's file without the pin; REVIEW-1 H3 asked
  for mandatory. Make `new-alice` refuse without it.
- **c. Poll skew (done).** `tip` is now the highest height any answer reflects. Keep the recorded `first_seen` fixture
  as the regression test.
- **d. Memory.** π proving peaked at 2.7–2.9 GB on a 2.9 GB VM (1,180 / 2,090 / 2,194 s). Set `.wslconfig` to 6 GB when
  proving, or pre-prove (idea 2).
- **e. Timings to keep.** 18-block finality took 8.5 min (30 s/block) and 7 min (25 s/block); claim proof 3 s; claim
  included 1 block after its call height; refund 80 s after `T_reveal`, almost all poll interval. `τ_fast = 20 s` was
  not challenged; Q13 still wants the 10,000-header distribution.
- **f. Self-swap blind spots.** One machine, one node, one clock, no bundle transport: the next run should be two
  machines (or Windows + WSL as two parties with separate files), two RPC endpoints, and a real Sepolia leg (find a
  faucet that accepts the owner's address, or an L2 testnet).
- **g. Secret hygiene.** Fixed (`--secret-stdin`); keep "never list processes with arguments during a proof" in the
  runbook; add the `ps` negative test from M2.7a to CI.
- **h. Logging.** Alice's engine now records `eth_refund_mined`; also log `D − tip` and `T_reveal − now` on every tick
  so a human sees the clocks.
- **Design changes:** §2.2 step order, §9.3 add run 2's numbers (refund latency), `docs/live-run-*.md` checklist.

## 13. Stablecoin leg (own addition)

**Plain words.** Quoting NOID against a dollar stablecoin instead of ETH removes most of the price risk during the
swap window, which is also most of the free-option cost. The contract for it already exists.

`eth/contracts/HTLCERC20.sol` is tested but not wired into swap-cli. Add an `EvmAsset::Erc20 { token }` variant to the
swap file and watcher (`Locked` event shape, `allowance` + `newLock` two-step on Bob's side, `claim` pays tokens).
Idea 1 and idea 6's fee field apply unchanged. USDC on an L2 makes the quote stable, the gas trivial and the window
short. Effort S; risk low (fee-on-transfer tokens must be refused); design: §2.1 a12 and §9.1 ETH-contract row.

## 14. Escrow the opening in the ETH lock (own addition)

**Plain words.** If both parties lose the 699-byte contract description, the NOID is stuck until nobody can reach it:
the Parano1d chain forgets it after it leaves the mempool. Storing those bytes in the Ethereum lock makes them
recoverable from Ethereum forever, for a few cents.

T15: the opening is not recoverable from Parano1d (`api.md:L136-L138`); both parties keep it, and the wallet app keeps it
only locally. `newLock(..., bytes opening)` emits it in the `Locked` event (~700 bytes of calldata, ~11 k gas) or stores
`keccak(opening)` and the bytes go in the event. Bob's lock then doubles as a public backup; `swap-cli` can rebuild a lost
swap file from the chain. Effort S; risk none (public data); design: §2.1 a7/a12, §8 T15 mitigation.

---

## Recommended order for the next month

1. **Week 1 — cheap and unblocking.** Idea 12 (prove-first runbook, mandatory code hash, two-party setup), idea 3
   (rehearsal profile with the amount cap), idea 2a/2c (secret pool with pre-proved receipts; 6 GB for the VM).
2. **Week 2 — finish M2.7 under the rehearsal profile.** Alice-abort before lock, Bob-abort, `F_max` burn, conflicting
   close, forced rotation, stock variant, each in about an hour, logged like run 2; Sepolia leg once a faucet works.
   In parallel: idea 5A in the harness (fixed-fee close, `pruv verify`), idea 10 watchtower mode and the two-node rule.
3. **Week 3 — contract v2 decision.** With the gas number from `docs/poseidon-evm.md`: idea 1 (EVM-direct) + idea 6.2
   (`feeBps`) + idea 14 (opening in the event) + idea 13 (ERC-20) as *one* v2 of the ETH contract and one v2 of
   `htlc.pruv` (fixed fee), so M4.2 audits one set. Idea 11 signatures in `swap-cli bundle`.
4. **Week 4 — measure.** Q1 with the fixed-fee contract (two closes across a rotation), Q6 floor polling started
   (≥ 2 weeks), Q13 header distribution, idea 4's option values from whatever price data exists; write §11 "economics"
   with the maker-spread model and the comparison table. Then scope M4 (cryptographer: Q8 now carries both legs if
   idea 1 ships).

Deferred on purpose: idea 7 (agent custody) until unattended operation is actually planned; ideas 8 and 9 until there
is a second real counterparty; the NOID-side fee program never.
