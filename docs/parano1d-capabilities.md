# Parano1d contract capabilities for HTLC-style atomic swaps

Source: `vendor/parano1d` at commit `d29b801` ("update libp2p", 2026-10-30). All
paths below are relative to `~/noid-swap/`. "Docs" means the claim
appears only in documentation. "Code" means I read the Rust that enforces it.
"Run" means I executed it locally.

## Executive summary

1. **An HTLC can be built on Parano1d today, but only through the native authorization, with the authority acting as the hashlock.** A contract can make its claim authority an arbitrary address `A = Addr(s)` and send the payout to a *different*, fixed `claim_recipient` (Bob). Before `deadline_height` only someone who knows `s` can close it, and the close always pays Bob. At or after the deadline, the refund authority closes it and the refund recipient gets paid.
2. **A contract cannot check a hash directly.** ABI 3 has 10 opcodes (keep, move, add, subtract, min, max, less_than, equal, assert_equal, assert_less_or_equal) spread over 16 program slots. There is no hash, byte or bitwise operation, and a call cannot pass in an argument.
3. **Parano1d cannot be the chain where the secret is revealed.** A claim is a zero-knowledge proof of knowledge of `s`, so `s` never appears on chain. The party locking NOID must therefore generate the secret, and the reveal must happen on Ethereum or Bitcoin.
4. **`Addr` is a single Poseidon2b permutation over GF(2^128) (`ADDRFIX_` IV), not SHA-256.** The swap therefore needs either (a) an off-chain ZK equivalence proof that `SHA256(m)` and the Parano1d authority commit to the same `m`, which is feasible because Addr is fully specified in source, or (b) Poseidon2b computed on the EVM side, which is expensive and not available on Bitcoin.
5. **The stock wallet can only authorize for a wallet-derived address,** `Addr(Derive(m, i))`. With stock tooling the "preimage" is a wallet master secret `m`, and the lock costs 4 permutations. A custom Rust client using the public `noid_gkr` prover API can authorize with a raw `s` (1 permutation).

## 1. Instruction set and hash operations

**Code:** `vendor/parano1d/noid_tx/src/experimental_object/integer_program.rs`
- `PROGRAM_STEPS = 16`, `OPERAND_COUNT = 24`, `OPCODE_COUNT = 10`, `PREDICATE_COUNT = 6`, with a 20-bit descriptor (L13-L17).
- Opcodes (L105-L116): `Keep, Move, Add, Subtract, Min, Max, LessThan, Equal, AssertEqual, AssertLessOrEqual`.
- Registers (L24-L29): `state0, state1` (persistent u64), `scratch0, scratch1` (zeroed on every call).
- Operands (L46-L71): the four registers, `immediate, height, fee, payout, retained, input_amount, before_deadline, terminal, has_payout, zero, one, after_deadline, payout_owner0..3, input_creation_id, input_slot, retained_slot, payout_slot`.
- Predicates (L136-L143): `always, before_deadline, terminal, has_payout, scratch0, scratch1`, plus an `inverted` bit (L156-L161).
- The interpreter (L361-L410) runs straight-line code: no jumps, uses checked add and subtract (overflow or underflow rejects the call), and rejects non-Boolean predicates.
- `Context::from_body` (L263-L286) shows that every operand comes from the transaction body or the inclusion height. **There is no caller-argument operand.**
- The in-circuit twin `vendor/parano1d/noid_recursive/src/acceptance/trace/integer_program.rs:L4-L30` imports the same constants and the same `ContextTrace` fields. No hash or argument wires exist there either.

**README claim check.** README.md:L40 says "16 instructions". In the code that means 16 program *slots* and **10 opcodes**. docs/contracts/core.md:L9-L18 and docs/contracts/pruv.md:L178-L182 ("all ten native opcodes") agree with the code.

**Hash inside a contract: none.** No opcode hashes. The only Poseidon2b uses near contracts are the commitments `CNTCODE_/CNTPOL__/CNTOBJ__` that compute the contract's own address (`vendor/parano1d/noid_tx/src/experimental_object.rs:L96-L129`). These are consensus-side, and the program cannot access them.

**Can a contract check `H(x) == stored`? No.** A program can only compare u64 values. The only 256-bit value the caller controls is the output-1 owner (`payout_owner0..3`). It exists only on continuing calls with a payout, and it can only be compared for equality with immediates, which would mean storing the preimage itself.

## 2. Authorization: is the authority the hashlock?

**Code path (verified):**
- `ObjectOpening` holds `claim_authority, recovery_authority, deadline, claim_recipient, recovery_recipient, rules` (`vendor/parano1d/noid_tx/src/experimental_object.rs:L65-L75`). All are arbitrary 32-byte `Address` values committed at creation.
- `authority_at(h)` returns the claim authority if `h < deadline`, otherwise the recovery authority (L131-L137). `recipient_at(h)` works the same way (L139-L145).
- `check_call` (L166-L223) enforces:
  - the input owner equals the opening root (L186);
  - the mode bit allows this branch and form (L189; `vendor/parano1d/noid_tx/src/experimental_object/policy.rs:L50-L58`);
  - fee is at most `max_fee` (L192);
  - **a close must pay `outputs[0].owner == recipient_at(height)`** (L210-L213);
  - a continuing call must create the exact successor root (L214).
- The authorization proof's public inputs are `(logical_txid, checked.authority)` (`vendor/parano1d/noid_gkr/src/wallet_authorization.rs:L611-L633`). Mempool admission verifies it (`vendor/parano1d/noid_mempool/src/pool.rs:L426-L439`) and re-checks after verification that the authority did not change (L478-L483).
- The proven relation is: the first two lanes of `Poseidon2b([s0, s1, IV(ADDRFIX_)])` equal the authority (`wallet_authorization.rs:L380-L410`).

**Conclusion: confirmed, with conditions.** Setting `claim_authority = Addr(s)`, `claim_recipient = Bob`, `recovery_* = Alice` and close-only modes gives:
- before the deadline, only a holder of `s` can close, and the value goes to Bob;
- from the deadline on, only Alice can close, and the value goes to Alice.

Because the recipient is enforced separately from the authority, someone who learns `s` cannot redirect the funds. The worst they can do is close early to Bob and pick any fee up to `max_fee`. The shipped `refundable_payment` template (`vendor/parano1d/noid_tx/src/experimental_object/applications.rs:L19-L40`) sets `claim_recipient = payee = claim_authority`. **Using that template with payee = Addr(s) is unsafe**, because once `s` is revealed, anyone can spend the payout. Use `custom_program` instead. The RPC builder accepts independent authority and recipient fields and adds no extra constraint (`vendor/parano1d/noid_rpc/src/server/objects.rs:L227-L247`).

**Wallet constraint (code):**
- `object_owner_witness` requires that the wallet's *active derived address* equals the authority, and it uses `spend_secret_for(active_index)` (`vendor/parano1d/noid_node/src/wallet/builder.rs:L109-L126`). The stock node or CLI can therefore only claim if `A = Addr(Derive(m, i))` for a wallet master `m` that the claimer has imported.
- Import is a hidden node flag, `parano1d --import-wallet-secret` (reads 64 hex characters on stdin; `vendor/parano1d/noid_node/src/main.rs:L1370-L1376, L1995-L2004`). **It replaces the wallet in that data directory** (`vendor/parano1d/noid_node/src/wallet/state.rs:L617-L640`), so it must not be run on a production wallet.
- With a raw `s`: `OwnerAuthWitness::new(SpendSecret::from_bytes(s))` (`wallet_authorization.rs:L45-L49`) and `prove_experimental_object_authorization_for_version` (L430-L446) are public APIs. A test exercises exactly this flow with independent claim and recovery secrets (L856-L923). The client builds the page with `ObjectOpening::build_call`, wraps it in `ObjectIntent::to_bytes` and submits it via `paranoid_submitTxIntent`, which accepts ABI 3 contract intents (docs/reference/rpc.md:L149-L151; the decoder is in `vendor/parano1d/noid_mempool/src/contracts.rs:L43-L49`). `check_call` does not bind `inputs[0].amount`/`creation_id` to State; the mempool (`check_input_slots`) and HistoryStep do. A client must take them from verified State.
- There is no `prepareObjectCall` RPC equivalent to `prepareNativeIntent`. Client-held-key preparation exists only for native token, NFT and trade operations (docs/reference/client-native-rpc.md:L3-L6; `vendor/parano1d/noid_rpc/src/api.rs`).

## 3. Public arguments and observability

- **A call carries no free-form data.** The call body is a fixed `Tx8x2` page plus the 699-byte opening (docs/protocol/transactions.md:L118-L124).
- In a close-only HTLC, the caller chooses only the fee (at most `max_fee`) and output 0's empty slot index (u32). Everything else is fixed by the opening and State.
- On continuing calls with `unrestricted_payout_recipient`, the payout owner is a caller-chosen 32-byte field. It is visible in the mempool, in the block body for 42 blocks, and in the receipt's `payout.address`. It is a channel the contract **cannot verify**, so it cannot force a reveal.
- The authorization capsule is a "freshly randomized and witness-hiding" proof (docs/concepts/signatureless-ownership.md:L28-L33). The docs say addresses, amounts and fees are public and the secret is hidden (L43-L49; docs/protocol/security-model.md:L88-L90). I did not audit the ZK property in code. I am relying on the docs and on the fact that the design depends on it.
- **Consequence:** a counterparty cannot learn `s` from a Parano1d claim. What observers *can* see:
  - pending calls with their opening, via `getMempoolEntry.contract_opening_hex` (docs/reference/rpc.md:L160-L168);
  - `contract: "call" | "close"` flags on retained blocks (L100-L108);
  - State occupancy of the contract address (`getObjectInstances`, `getSlotsByOwner`);
  - contract receipts with `authority`, `payout` and amounts (L386-L402).

## 4. Block height

- `height` is the inclusion height (candidate tip+1, never taken from the wire): `vendor/parano1d/noid_tx/src/experimental_object.rs:L164-L165`; docs/contracts/core.md:L58-L61.
- There is one committed `deadline` per opening. It selects both the authority and the recipient (`h < deadline` → claim branch). Extra boundaries can be compared against `height` using immediates (core.md:L58-L61). Example: `require height >= N` compiles (Run).
- **No horizon bound:** `deadline` is a raw u64. `check_call` and the RPC builder impose no maximum. `validate_schedule` applies only to the periodic templates (`applications.rs:L115-L128`).
- No timestamp or MTP operand exists. The target interval is 30 s under ASERT, so a block count is not a clock guarantee (docs/protocol/parameters.md:L7-L8; docs/contracts/templates.md:L76-L77).
- Finality is 18 blocks, with at most 17 blocks of rollback (parameters.md:L11; docs/contracts/lifecycle.md:L85-L89).
- The mempool evicts a pending call if its branch would change at the next height (`vendor/parano1d/noid_mempool/src/contracts.rs:L92-L113`). A claim that has not been included by `deadline-1` is lost. A claim included at D-1 that is reorganized out (≤17 blocks) and re-included at height ≥ D becomes invalid, and the refund becomes valid. Bob should treat a claim as safe only if it is final (18 blocks) before D.
- **Epoch anchor:** every page commits to a 144-block anchor (docs/protocol/transactions.md:L96-L107). An authorized call that misses its epoch drops out and must be re-authorized.
- **Fork boundary:** the owner-authorization version switches V3→V4 at the v2.1 height 279,370 (`vendor/parano1d/noid_chain/src/consensus/params.rs:L23, L31-L34, L47-L61`). Admission verifies with the version selected by the candidate height (`pool.rs:L429-L435`), so a proof for the other version fails (`AuthProof`). L486-L493 rejects if the version changes during verification, and `pool.rs:L753-L776` evicts pending calls when the profile switches at the boundary.

## 5. Value custody and lifecycle

- **Custody: NOID only.** An instance is a single State output whose owner is the opening root, holding a positive μNOID amount (docs/contracts/lifecycle.md:L15-L26; `experimental_object.rs:L327-L336`). Native tokens and NFTs are separate typed objects whose spending requires Owner authorization by the owner address's ADDRFIX preimage (docs/protocol/native-wire.md:L61-L82; `vendor/parano1d/noid_gkr/src/wallet_authorization.rs:L450-L467` (native authorization uses the same ADDRFIX owner statement, `L381-L397`)).
  - **Inference:** tokens sent to a contract root are unspendable, because nobody knows an ADDRFIX preimage of a `CNTOBJ__` digest. ABI 3 programs see only NOID amounts.
- **Conditional release to one of two parties:** yes, as described in section 2. Value is conserved: `input = retained + payout + fee`, and a close pays `input - fee` to the branch recipient (lifecycle.md:L73-L75).
- **Glossary:**
  - "Live right": a funded State output whose owner is the commitment to the terms (docs/concepts/proof-native-contracts.md:L5-L9).
  - "Closes the right": a terminal call that pays output 0 to the branch recipient and creates no successor (core.md:L20-L24; lifecycle.md:L55-L59).
  - "Scheduled actions require an authorized call": consensus has no timers, so refunds and claims happen only when the authority submits a transaction (core.md:L110-L114; templates.md:L59-L61).
- **Lifecycle:**
  1. `createObject` or `contract create` encodes the terms. This is free and off chain.
  2. Funding is an ordinary payment to the `o1…` root. Each deposit is an independent instance, identified by `(slot_index, creation_id)`.
  3. `previewObjectCall`, then `walletCallObject` with review guards (docs/contracts/api.md:L101-L117).
  4. A continuing call creates a successor with a new address; a close ends the instance.
  5. Pruning: bodies are kept for 42 blocks. Contract receipts (up to 1,110,624 bytes) prove past calls but not current unspentness (docs/contracts/receipts-and-recovery.md:L15-L32).
  - Openings are not recoverable from chain once they leave the mempool (api.md:L136-L138). Both parties must keep them.

## 6. Templates

Shipped constructors are in `vendor/parano1d/noid_tx/src/experimental_object/applications.rs`. The rule table is docs/contracts/templates.md:L8-L15:

| Template | Before boundary | At/after boundary | Code |
|---|---|---|---|
| `refundable_payment` | "Payee closes and collects the balance minus fee" | "Payer closes and recovers it" | L19-L40, modes `CLAIM_CLOSE\|RECOVERY_CLOSE`, empty program |
| `timelocked_vault` | "No permitted spend, even by its owner" | "Owner closes and collects" | L44-L60, `RECOVERY_CLOSE` |
| `allowance_wallet` | capped payments, reserve kept | recovery key closes | L66-L96 |
| `period_budget_wallet` | fee-inclusive budget per period | recovery closes | L154-L220 |
| `recurring_payment` | payee claims exact payment when due | payer recovers | L222-L265 |
| `tranche_vesting` | one tranche per call, catch-up allowed | beneficiary closes | L281-L323 |

No escrow, auction or hashlock template exists. `refundable_payment` is an HTLC without a hashlock. Only the custom variant with `claim_authority ≠ claim_recipient` is safe for swaps (section 2). The v2.1 native templates (create, transfer and burn token; trade; NFT mint, list, buy and cancel) are typed financial operations, not general contracts (docs/contracts/native-templates.md:L40-L54). None of them offers a time-locked conditional transfer that binds a recipient.

## 7. Pruv

- **Build and commands** (docs/contracts/pruv.md:L16-L27; `vendor/parano1d/noid_pruv/src/main.rs`):
  - `pruv check|build|smt|verify <src> --params p.json`.
  - `pruv native check|build|submit`.
  - `build` emits `{"kind":"custom_program","definition":{…}}` for `parano1d-cli contract create def.json --out x.opening.json`, followed by `contract fund`, `contract call … --preview` and `--expected-txid` (pruv.md:L56-L101).
- **Syntax** (pruv.md:L107-L159):
  - declarations: `param` (u64, bool or address), `const`, and at most two `state` u64 variables;
  - a `policy { … }` block in which all 13 fields are explicit;
  - a `call { … }` block with assignments, `+=`, `-=`, `min`, `max`, comparisons, `!`, nested `when` and `require`;
  - `ensures` postconditions using `old()`.
  - Addresses may appear only in `policy` (`vendor/parano1d/noid_pruv/src/compile.rs:L361`). The source limit is 64 KiB. There are no functions or loops.
- **Z3:** `pruv verify` pipes SMT-LIB2 (`QF_BV`, `:timeout 10000`) to `z3 -in -smt2` (`vendor/parano1d/noid_pruv/src/verify.rs:L157, L267-L279`). It expects `sat` then `unsat`. This is a per-call property only (pruv.md:L188-L226). `verify` refuses a source with no `ensures` (Run).
- **Run.** I built `noid_pruv` with rustc 1.97.0 stable; the pinned 1.96.0 could not be downloaded behind the proxy. Results:
  - `budget.pruv` uses 3/16 instructions;
  - `instructions.pruv` uses 13/16;
  - this HTLC compiles to 1/16:

```text
contract HashTimeLock {
    param hashlock_authority: address;   // Addr(s) or Addr(Derive(m,0))
    param receiver: address;             // Bob
    param sender: address;               // Alice
    param timeout_height: u64;
    param max_fee: u64;
    policy {
        claim_authority = hashlock_authority;
        recovery_authority = sender;
        claim_recipient = receiver;
        recovery_recipient = sender;
        deadline_height = timeout_height;
        max_fee_micronoid = max_fee;
        max_payout_micronoid = 0;
        min_retained_micronoid = 0;
        claim_can_continue = false;
        claim_can_close = true;
        recovery_can_continue = false;
        recovery_can_close = true;
        unrestricted_payout_recipient = false;
    }
    call { require terminal; }   // redundant with the modes; belt-and-braces
}
```

- **Wallet and RPC calls:**
  - CLI: `contract instances`, then `contract call <opening> <slot> <creation-id> --close --preview`, then `… --expected-txid <txid> --out closing.json` (docs/contracts/api.md:L158-L184).
  - RPC: `paranoid_walletCallObject` with `{opening_hex, slot_index, creation_id, terminal:true, payout:null, fee_micronoid, expected_*}`.
  - The Pruv docs mention a `noid_pruv/README.md:L158` qualification link that points to a missing file (`docs/contracts/pruv-qualification.md`).

## 8. Development tooling

- **Toolchain:** `rust-toolchain.toml` pins `1.96.0`, profile minimal, with `rustfmt`. You also need build-essential, clang, libclang-dev, cmake and pkg-config (docs/developers/build.md:L3-L22).
- **No regtest flag on the mainnet binary.** There is an `isolated_v2_node` example behind the `isolated-v2-fork-testnet` feature (`vendor/parano1d/noid_node/Cargo.toml:L16-L19`), with v2 active at height 10 and v2.1 at 24 (`params.rs:L24-L29, L70-L77`).
  - It needs a **matching isolated proof bank (matrix pack)** built separately, via `bench_prover` tools such as `noid_matrix_gen`. That bank is not in the repo, and debug or pack-free nodes are not block producers (build.md:L53-L80; docs/developers/testing.md:L29-L33, L113-L114).
  - Live scripts: `scripts/live_v2_contract_scenario.py`, `live_v2_contract_wallet_scenario.py`, `live_pruv_contract_scenario.py`, `live_pruv_cli_scenario.py` (testing.md:L22-L49, L176-L193).
- **Pure-Rust harness (no node needed):** `ObjectOpening::build_call` and `check_call` plus `noid_gkr` prove and verify, as in the test at `wallet_authorization.rs:L856-L923`. `cargo test -p noid_pruv -p noid_tx`.
- **RPC for watching:**
  - `getContractProtocol`, `getObjectStatus`, `getObjectInstances`, `getSlotsByOwner`;
  - `getMempoolInfo`/`getMempoolEntry` (opening capture);
  - `getBlockDetails` (call and close flags);
  - `walletWatchObject`, `walletListObjectReceipts`, `exportObjectReceipt`, `verifyObjectReceipt` (docs/reference/rpc.md:L252-L287).
  - All contract methods require local owner scope (docs/contracts/api.md:L3-L6).

## 9. Limits and costs

- **Amounts:** u64 μNOID (6 decimals). Counters and immediates are u64. The opening is 699 bytes. The program has 16 slots, 2 state registers and 2 scratch registers. Blocks hold up to 63 calls and 504 inputs (docs/contracts/core.md:L86-L99; docs/protocol/parameters.md:L14-L17).
- **Fee formula:** `5000 + 100·in + 700·out + growth·max(0,out−in)`, where `growth` = 2,500 μNOID × {1,2,4,8} by occupancy (docs/protocol/transactions.md:L78-L94).
  - An HTLC close (1 input, 1 output) costs at least **5,800 μNOID**, paid from the contract balance and capped by `max_fee`.
  - The local relay floor can rise to 90% of the median of the last 50 admitted fees under pressure (docs/protocol/economics.md:L107-L113; `vendor/parano1d/noid_mempool/src/floor.rs:L4-L11`).
  - **Liveness risk:** if `max_fee` is below the floor at claim time, the claim cannot be submitted.
  - If `max_fee` < 5,800, neither the claim nor the refund can ever pay the consensus minimum fee, and the funds are locked permanently. Nothing (Pruv, `check_call`, RPC builder) rejects such an opening.
  - **Griefing bound:** anyone who knows `s` can burn up to `max_fee` of Bob's payout as a miner fee.
- **Every live output must be non-zero.** A close needs `input > fee`.
- **No deadline horizon limit** (section 4). Calls are one page with exactly one contract input. One funded instance is consumed per call.

## 10. Addr(s): exact definition

- **Code:**
  - `derive_address`: `sponge(TAG_ADDRFIX)`, `absorb_pair(s_lo, s_hi)`, `finalize_no_pad()` (`vendor/parano1d/noid_poseidon2b/src/primitives.rs:L298-L305`).
  - The secret limbs are `u128::from_le_bytes(s[0..16])` and `u128::from_le_bytes(s[16..32])` as tower-basis `Block128` (L226-L239).
  - The IV comes from the label `"ADDRFIX_"` as a big-endian u64 `L`: `state[2] = L<<64`, `state[3] = L` (`vendor/parano1d/noid_poseidon2b/src/native/domain.rs:L27-L40, L56`).
  - The sponge has t=4, rate 2, capacity 2. A full 32-byte block is XORed into lanes 0 and 1 and then permuted. The output is lanes 0 and 1 as 16 little-endian bytes each (`vendor/parano1d/noid_poseidon2b/src/native/compression.rs:L13-L27, L67-L104, L139-L145, L198-L216`).
  - **So `Addr(s) = (P([s_lo, s_hi, L<<64, L]))[0..2]`: a single permutation, truncated.**
  - The doc comment at primitives.rs:L72-L73 says `ADDRESS_`, which drifts from the code. `CRYPTO.md`, which the code comments reference, is not in the repo.
- **Permutation** (`vendor/parano1d/noid_poseidon2b/src/native/permutation.rs`):
  - Poseidon2b over GF(2^128) with an x^7 S-box, 8 full and 58 partial rounds (L5-L21).
  - Round constants are at L185-L190, `MDS_FULL` at L193-L198 and `MDS_PARTIAL` at L201-L206, all in tower basis.
  - It is computed in the flat (GCM) basis through `tower_to_flat_u128` and `clmul_gcm` (`vendor/parano1d/noid_core/src/hardware.rs:L458, L500`).
- **Wallet derivation:** `spend_secret_i = Poseidon2bSponge(IV = 0)`, absorbing `m_lo, m_hi, i as u128, 0x6E6F69642D64657269 ("noid-deri")`, with padded `finalize` (0x80…0x01 block) (`vendor/parano1d/noid_node/src/wallet/keystore.rs:L69-L93`; compression.rs:L293-L298). That is 3 permutations, then Addr adds 1.
- **Test vectors.** I ran them through the repo crate (`/tmp/addrvec`, not committed). With `s = 00 01 02 … 1f`:
  - `SHA256(s) = 630dcd2966c4336691125448bbb25b4ff412a49c732db2c8abc1b8581bd710dd`
  - `Addr(s) = f8183db204ffb765c7015d851c1754e4974c675b975c6738d9f6d138eb7212cf` (`o1lqvrmvsyl7mkt3cptkz3c965ujt5ce6mjawxwwxe7mgn36mjzt8sn69xw2`)
  - `Addr(Derive(s,0)) = o125qayvgtmvqnlhqmqwe08dza3acaax5mct3u5h4uen3qtrds3jfset7wlk`
- **Equivalence proof:** buildable. The function is fully specified, deterministic, and depends on nothing in the node.
  - Statement: `∃m: SHA256(m)=H ∧ Addr(m)=A`, or `Addr(Derive(m,0))=A` for the stock wallet.
  - It only needs **off-chain** verification by the counterparty before they lock.
  - Size estimate (mine, not measured): 90 S-boxes per permutation × 2 GF(2^128) multiplications ≈ 180 multiplications, roughly 0.4 M AND gates with Karatsuba (MDS and squaring are linear). That is about 0.4 M for the raw path and 1.6 M for the stock path, plus about 22 k for one SHA-256 block.
  - Suitable proof systems: Boolean-circuit or binary-field systems (Binius-style, ZKBoo/Ligero), or R1CS with bit decomposition.

## What we could NOT determine

- **Whether the authorization capsule is actually zero-knowledge or witness-hiding.** Only the docs claim it. Settle it by auditing `vendor/parano1d/noid_gkr/src/zk_auth_capsule.rs` and `zk_authorization.rs`, plus the linked cryptographic review.
- The HistoryStep relation enforces the terminal recipient (`noid_recursive/src/acceptance/block_slots.rs:L1044-L1067`), mode bits, fee cap and the fixed payout recipient (`L1083-L1141`), with `before_deadline = height < deadline` (`L929-L930`). A component-level negative test confirms this (review-1). The end-to-end root binding was read (`region_source_binding.rs:L1180-L1239`, `block_slots.rs:L1513-L1520`), not tested.
- **An isolated proof bank:** how long it takes to generate, and whether a prebuilt one is published. Settle it with `bench_prover` `noid_matrix_gen`/`noid_v2_capacity` docs, or by asking upstream. This decides whether a private devnet is practical, as opposed to testing on mainnet with small amounts.
- **Cryptanalytic margin of Poseidon2b with small constants:** the round constants and the full-round MDS entries are ≤ 0x7 and the partial-round MDS diagonal is 0x20, 0x2000, 0x200, 0x800 with 1 elsewhere (`permutation.rs:L184-L206`), inside a small subfield, which suggests a Frobenius-type symmetry. This is out of scope here. Flag it for cryptographer review, since the hashlock's security is Addr's preimage resistance.
- **Gas cost of an EVM Poseidon2b (GF(2^128) without carry-less multiply)** if equivalence proofs are rejected. This needs a benchmark.
- The mempool is strict first-seen per input slot, with no replace-by-fee (`noid_mempool/src/pool.rs:L1296-L1297, L1334-L1356`). A conflicting close from any holder of `s` is rejected as `SlotConflict` if it arrives second, and it blocks Bob's if it arrives first. It still pays Bob, but at a fee the attacker chooses (see review-1, R1).
- **Relay-floor behavior on mainnet under load,** which determines how much `max_fee` headroom is needed.

## Implications for the swap design

1. **Roles.** The NOID seller (Alice) generates `m`. The Parano1d lock is the "second-claim" leg. Ethereum or Bitcoin is the reveal leg: Alice claims there with `m`, and Bob reads `m` and claims NOID. Set `T_parano1d` well above `T_eth/btc` + reveal latency + 18-block finality + one epoch-anchor rotation.
2. **Parano1d lock** = the `custom_program` above: `claim_authority = A(m)`, `claim_recipient = Bob`, `recovery_* = Alice`, close-only modes. **Never** use `refundable_payment` with payee = A, and use a fresh `m` per swap.
3. **Binding.** Before locking, Bob verifies:
   - the equivalence proof for (H, A);
   - that the opening hashes to the funded `o1` address (`getObjectInstances`);
   - every policy field, the deadline and `max_fee`.
4. **Claim tooling.** Either an isolated wallet data directory with `--import-wallet-secret` (stock, Derive path), or a small Rust client using `noid_gkr` + `noid_tx` + `submitTxIntent` (raw `s`, a cheaper equivalence circuit).
5. **Timing.** Avoid swaps that straddle v2.1 activation at height 279,370 (about 2026-11-04 04:00 UTC), because the authorization version switches there. Calls pending at the boundary are evicted and must be re-proved with V4. Until 279,370 the mempool verifies V3, so a harness-built (V4-default) proof submitted before then would be rejected.
