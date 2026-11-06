# Q2: does the block proof force a contract close to pay the committed recipient?

Question Q2 / task M2.1 (`TASKS.md`). Source: `vendor/parano1d` at `d29b801` (v2.1.0), read on 2026-11-04.
Paths below are relative to `vendor/parano1d/` unless they start with `docs/` or `parano1d/`.
Nothing under `vendor/` was changed. No network, no node.

## 1. Verdict

**CONFIRMED end-to-end by source reading. No gap found. Test evidence: component level, N2 run and
passed (2026-11-04). The full block / devnet tests (N1, N3) have not been run.**

Every link from the committed contract opening to the paid output is a constraint inside the block
proof. The links are: opening → contract address → spent State slot → close output → header. None of
them is enforced only by Rust admission. A prover cannot build a valid block proof for a block in which
a close of our `HashTimeLock` pays anyone except `recipient_at(height)` unless it breaks one of two
things: Poseidon2b (forging a contract address) or the proof system itself.

The three decisive places:

1. **The recipient rule.** `noid_recursive/src/acceptance/block_slots.rs:1044-1051` and `:1061-1067`:
   `terminal × (output0_owner + select(height < deadline, claim_recipient, refund_recipient)) = 0`.
   The same function enforces the mode bits, the `max_fee` cap and the fixed payout recipient
   (`:1094-1140`). It runs in every production profile (`:2963-2984`).
2. **The recipient values are tied to the funded address.**
   `noid_recursive/src/acceptance/trace/region_source_binding.rs:1143-1251` pins `claim_recipient`,
   `refund_recipient`, `deadline`, both authorities, the rules and the program into the rows of a
   Poseidon2b sponge region. These rows recompute
   `root = CNTOBJ(CNTPOL(code, deadline, …, recipients, version, rules), state)`, in exactly the order
   used by `noid_tx/src/experimental_object.rs:104-129`. `block_slots.rs:1513-1520` then requires that
   root to equal the body's `input_owner`.
3. **`input_owner` is the owner of the State slot being spent.**
   `noid_recursive/src/acceptance/trace/exact_state.rs:226-275` plus the Merkle walks to the parent
   State root, at `block_slots.rs:641-723`, `:2441-2454` and `:3244-3250`.

Test evidence so far:
- Review-1 ran a component-level negative test with the opening wires allocated directly (route A:
  true opening, close pays a stranger).
- **N2 (§7.2) has been run and passed.** It tests the link in point 2: a *forged opening* that claims a
  different recipient. With the full proof-and-verify path of the object hash table, all four forgery
  variants were **rejected by the verifier**, and the honest case was accepted. A control run confirms
  that this table and its side proof are what stop the forgery: the main equations alone accept it.
- Not run: upstream's full-block negative case N1 (too much RAM for this machine) and a real devnet
  block, N3 (needs the proof bank, Q7).

What it means for the swap: once `s` is public on ETH/BTC, a stranger can still close the NOID
contract, but the proof forces the payment to Bob. The only loss is the fee, at most `max_fee`, and it
goes to the miner. This is the property the design relies on (decision 2, threat T14).

## 2. Terms used here

- **Circuit / constraint.** The block proof proves that a long list of equations holds. Each equation
  is a *constraint*. A rule is "in the circuit" if breaking it makes some constraint false, so that no
  valid proof exists. Parano1d writes most of these as an *R1CS*: equations of the form
  `a × b = c` over the field GF(2^128). In this field, `x + y = 0` means `x = y`.
- **Prover / verifier / witness.** The *prover* (the miner) builds the proof. The *witness* is all the
  private values it plugs into the equations, and the prover chooses them freely. The *verifier* (every
  node) checks the proof against public data, mainly the block header. A value "taken from the witness"
  is safe only if some constraint ties it to something public.
- **HistoryStep.** Parano1d's recursive block proof. Each step proves "this block is valid and extends a
  valid history". The block part is assembled by `build_selected_zk_block_slots_core`
  (`block_slots.rs:2262`).
- **Opening.** The 699-byte description of a contract (program, state, authorities, `deadline`,
  recipients, rules). It is **not** in the block body
  (`noid_recursive/src/acceptance/history_step.rs:176-177`). Only its hash, the contract *root*
  (address), is on chain as the owner of the funded State slot.
- **Sponge.** A way to hash several values with the Poseidon2b permutation: absorb two values, permute,
  repeat. A fixed starting value (*IV*) separates uses. Here the IVs are `CNTCODE_`, `CNTPOL__` and
  `CNTOBJ__`.
- **Meta-A region / sidecar.** The prover also commits to a table of Poseidon2b permutation rows. A
  separate proof, the *Walk-A region sidecar*, shows that every row is a correct permutation, chained
  as the verifier's fixed pattern dictates. *Cell pins* are R1CS equations that set a circuit value
  equal to one cell of that table. That is how the main circuit uses a hash.
- **Rust admission.** The ordinary Rust checks a node runs before it accepts a transaction into its
  mempool (`check_call`). They protect honest nodes but bind no one: a dishonest miner can skip them.

## 3. Constraint path, with citations

`[R1CS]` means an equation in the block circuit. `[sidecar]` means a relation proven by the Meta-A
sidecar and checked by the verifier. `[native]` means the reference Rust definition.

| # | Hop | What is enforced | Where | Kind |
|---|---|---|---|---|
| 0 | Definition of the address | `root = CNTOBJ(CNTPOL(code, [deadline, claim_auth₀], [claim_auth₁, rec_auth₀], [rec_auth₁, claim_rcpt₀], [claim_rcpt₁, refund_rcpt₀], [refund_rcpt₁, version 3], [max_fee, min_retained], [max_payout, modes]), [state, 0])` | `noid_tx/src/experimental_object.rs:96-129` | [native] |
| 1 | Opening enters the circuit | Every opening field arrives from the prover in a `V2ContractComponentInput` and becomes a fresh wire. At this point nothing is checked yet. | `history_step.rs:123-141`; `block_slots.rs:1444-1512` | witness |
| 2 | Opening wires → sponge table cells | Each wire is pinned to the Meta-A input cell at its sponge position, in the order of hop 0: program rows `CODE_BASE..+15`, policy rows `POLICY_BASE..+7` (claim recipient in rows +3/+4, refund recipient in rows +4/+5), object rows. The code digest, policy digest and old/new object roots are pinned to the output cells. | `trace/region_source_binding.rs:1143-1251`; the pins become R1CS equalities in `pin_stage2_cells` `:520-528`, called at `:1751` | [R1CS] |
| 3 | The sponge table really is that hash | The verifier-fixed patterns put the `CNTCODE_/CNTPOL__/CNTOBJ__` IVs at chain starts (slots 1, 17, 25, 27) and chain the other rows. Each row absorbs: rate = input + previous output, capacity = IV or previous output. Each row is a correct Poseidon2b permutation. The object layout is chosen from the VK descriptor, not from the prover. | `noid_ivc_core/src/deep_chain/spine.rs:46-59`, `:254-273`, `:296-389` (honest layout), `:462-497` (patterns); `noid_ivc_core/src/deep_chain/leaf_hash.rs:590-616`; `noid_recursive/src/region_sidecar/walk_a.rs:946-955`, `:1141-1150`; object VK chosen at `region_source_binding.rs:1798-1811` | [sidecar] |
| 3b | The sidecar is actually verified | The tip proof verifies the joint region sidecar. Each recursive step verifies its child's sidecar inside the circuit. | `noid_recursive/src/acceptance/history_step/relation.rs:1646-1675`; `history_step/v2/banked/assembly.rs:199-206` | verifier / [R1CS] |
| 4 | Computed old root = body `input_owner` | `live × (old_object_root + input_owner) = 0` per lane | `block_slots.rs:1513-1520` | [R1CS] |
| 5 | "This page is a contract call / a close" comes from the body | CONTRACT and TERMINAL are bits of the body's flags leaf (L15). `terminal ⇒ contract`. The view's `live` and `terminal` are pinned to them. A contract page must be a one-page group with exactly input 0 and output 0, and a close has no output 1. Pages outside the contract window must have CONTRACT = 0. | `trace/action_surface.rs:192-206`; `block_slots.rs:779-780`, `:786-803`, `:811-812`; view selection (payout shift) `:835-913`, `:849-853` | [R1CS] |
| 6 | `input_owner` is the owner of the spent State slot | The input action row carries `input_owner`, slot, amount and creation id. A spend requires the old State leaf to hold exactly that owner and packed value. The leaves are walked to the parent State root (= start accumulator) and the child root (= header `STATE_ROOT`). | `trace/action_surface.rs:251-259`; `trace/exact_state.rs:226-257`; `block_slots.rs:641-723`, `:2441-2454`, `:3244-3250` | [R1CS] |
| 7 | Which branch applies | `height` comes from the header field. `before_deadline = height < deadline` (strict), with `deadline` taken from the pinned opening wire. | `block_slots.rs:2456-2471` → `trace/scheduled_allocation.rs:92`; `block_slots.rs:921-952` (`:929-930`) | [R1CS] |
| 8 | **Recipient rule** | `expected = select(before_deadline, claim_recipient, refund_recipient)`; `terminal × (output0_owner + expected) = 0` | `block_slots.rs:1044-1051`, `:1061-1067` | [R1CS] |
| 9 | Mode bits, fee cap, other limits | Modes range-checked to 5 bits. A close needs mode bit 1 (before D) or bit 3 (after). A continue needs bit 0 or 2. `fee ≤ max_fee` on every call. `retained ≥ min_retained` and `payout ≤ max_payout` on continuing calls. Output 1 pays `expected` unless mode bit 4. | `block_slots.rs:1094-1140` | [R1CS] |
| 10 | Continuing call keeps the money in the contract | For a non-terminal call, `output0_owner` = new root, computed in the same sponge table from the same policy digest and the next state. | `block_slots.rs:1521-1528`; `region_source_binding.rs:1170-1178`, `:1225-1250` | [R1CS]+[sidecar] |
| 11 | The checked `output0_owner` is the owner written into the new State | The output action row uses the same `OUTPUT0_OWNER` body leaf. A mint writes exactly that owner and value into the new leaf. | `trace/action_surface.rs:260-269`; `trace/exact_state.rs:255-273` | [R1CS] |
| 12 | No value leaks elsewhere | At the end of the group, `inputs = outputs + fee`, and the input amount is the State amount (hop 6). | `trace/paged_spend.rs:661-663` | [R1CS] |
| 13 | The body is the one the header commits to | The body leaves are pinned into the body-hash tree. The wrap output is the tx hash. Page hashes feed the logical txid. Txids form the tx root, pinned to the header `TX_ROOT`. | `region_source_binding.rs:1258-1277`; `trace/paged_spend.rs:664-681`; `block_slots.rs:2889` | [R1CS]+[sidecar] |
| 14 | Authority (for completeness) | A contract page's authorization statement uses `select(before_deadline, claim_authority, recovery_authority)` from the same pinned wires. Otherwise it uses `input_owner`. | `block_slots.rs:931-938`, `:1780-1865` (`:1822`); v2.1 sequential profile: `trace/native_assets/sequential_trade/authorization.rs:117-138` | [R1CS] |
| 15 | Always in the production matrix | `bind_v2_contract_partition` and `bind_v2_contract_execution` run whenever the profile is not `LegacyV1`. Production uses `ScheduledV2(config)`. The rows do not depend on block content (one matrix per class). | `block_slots.rs:151-153`, `:2963-2984`; `history_step/v2/banked/assembly.rs:122-133`; `history_step/v2/capacity_banked/assembly.rs:148-160` | — |

The native root order (hop 0) and the circuit's sponge order (hops 2–3) agree. An upstream test pins
`body.input_owner = opening.root()` and requires the R1CS to be satisfied
(`block_slots.rs:185-299`). Review-1 R7 and hop 7 agree that the comparison is strict `<` everywhere.

## 4. Checks that are only in Rust (not in the circuit)

None of them concerns the recipient, the mode bits or the fee cap.

| Check | Where | Circuit counterpart / why it does not matter here |
|---|---|---|
| `check_call` as a whole (shape, root, policy, fee cap, reserve, payout, recipient, successor) | `noid_tx/src/experimental_object.rs:166-223`; run by mempool `noid_mempool/src/contracts.rs:88`, miner template `noid_miner/src/template.rs:467`, prover witness builder `noid_block/src/candidate_history.rs:170-189`, wallet/RPC/receipts | Each clause has a circuit twin: shape §3 #5; root #4; policy and fee #9; recipient #8; successor #10. Openings are not in the block body (`history_step.rs:176-177`), so a node receiving a block **cannot** re-run `check_call`. I found no block-import code that does. The proof is the only consensus check. |
| `ObjectOpening::validate()` (opcodes valid, `modes ≤ 31`) | `experimental_object.rs:86-95` | Opcodes: in-circuit program binding (review-1 claim 1). Modes: 5-bit range check (`block_slots.rs:1097`). |
| Relay fee floor, first-seen / no replacement, branch-flip eviction, epoch-anchor equality at admission | `noid_mempool/src/pool.rs`, `contracts.rs:92-113` | Mempool policy only (liveness risk Q1, not theft). The circuit evaluates the branch at the real inclusion height, so a call that crosses `D` is simply invalid. Epoch anchors are also bound in-circuit (`block_slots.rs:1567`, called at `:2521`). |
| Consensus minimum fee (≥ 5,800) | admission `pool.rs:1256-1270` | Also in the circuit's fee arithmetic (`block_slots.rs:2909-2937`). Not part of `check_call` (review-1 claim 9). |
| Builder-side `assert!`s (contract position, prefix order, tx-hash match) | `block_slots.rs:1397-1418`; `region_source_binding.rs:1255-1258` | Prover conveniences only. The binding versions are the constraints in §3 #5 and #13. |

## 5. Values taken from the prover's witness, and what ties each one down

| Witness value | Allocated at | Tied down by |
|---|---|---|
| Opening fields: program, state, authorities, `deadline`, recipients, rules | `block_slots.rs:1444-1512` | Cell pins → sponge (§3 #2–3) → old root = `input_owner` (#4) → State (#6) |
| `old_object_root`, `new_object_root`, code digest, policy digest | `block_slots.rs:1491-1496`, `:1513-1524` (fresh wires, value computed natively by the honest builder) | **Only** the Meta-A cell pins and the sidecar. In the R1CS alone they are free. This is why review-1's component test could not cover this link (§7, N2). |
| `live`, `terminal` (per contract view) | `block_slots.rs:1476-1479` | Pinned to body flag bits (#5) |
| `contexts` (8 body fields the program reads) | `block_slots.rs:1497-1500` | Pinned to body leaves in `bind_v2_contract_execution` (`:997-1001`) |
| `next` state | `block_slots.rs:1484` | Program execution (`bind_program`, `:1029-1041`) and, for continuing calls, the new root (#10) |
| Meta-A table cells and permutation rows | region witness | Sidecar relation (#3), verified per #3b |
| State leaves and Merkle siblings | `trace/exact_state.rs` | Paired Merkle walks to header-bound roots (#6) |

## 6. Can a block proof exist for a block whose close pays a third address?

No, under the assumptions in §8. Every route a dishonest miner could try fails at a named constraint:

- **A. True opening, output to Mallory.** Recipient pin #8 fails. This is review-1's component test and
  upstream's `wrong-terminal-recipient` case.
- **B. Lie about the opening (claim `claim_recipient = Mallory`).**
  - If the sponge table is computed honestly, the old root comes out different and #4 fails against
    the real `input_owner`.
  - If the prover writes the real root into the output cell anyway, the table no longer matches a
    Poseidon2b sponge with the fixed IVs and chaining (#3), and the sidecar does not verify.
  - The only escape is a Poseidon2b second preimage/collision on the `CNTPOL__`/`CNTOBJ__` sponge, or a
    broken sidecar or proof system.
- **C. Lie about the State slot** (use a fake root as `input_owner`). The spend must match the real
  State leaf (#6), whose owner is the real root.
- **D. Do not flag the page as a contract call.** It is then an ordinary wallet spend, whose
  authorization statement is `input_owner` = the contract root (#14). That needs `s'` with
  `Addr(s') = root`, which is a Poseidon2b preimage.
- **E. Flag it as a continuing call.** Modes `CLAIM_CLOSE|RECOVERY_CLOSE` forbid it (#9). In any case
  the funds would stay in a contract with the same policy (#10).
- **F. Place it outside the contract window.** CONTRACT is pinned to 0 (#5), which reduces to D. In the
  v2.1 sequential profile, contract pages need not be a prefix (`block_slots.rs:2972`), but every slot
  still gets the same recipient rule.
- **G. Include it at a height on the wrong side of `D`.** The branch comes from the header height (#7),
  so the expected recipient follows the real height.

## 7. Negative tests: specification

### 7.1 N1: full direct-block relation, close pays a stranger (upstream case, recommended first)

- **What.** A B25 block with 2 contract calls. Call 1 is a close whose `outputs[0].owner` is replaced
  by an unrelated address. The opening components are honest.
- **Where.** `bench_prover/src/lib.rs:1114-1117` (`V2ResearchMutation::WrongTerminalRecipient`). The
  driver is `bench_prover/src/bin/noid_pack_pins.rs:151-260`. It calls
  `assemble_frozen_direct_block_research`
  (`noid_recursive/src/acceptance/history_step/relation.rs:742-782`, profile `V2`) and then
  `matrix.satisfies(witness)`.
- **Run.** From a scratch copy of the vendor workspace (never `vendor/` itself):
  `NOID_V2_DIRECT_ONLY=1 cargo run --release -p bench_prover --bin noid_pack_pins`. No proof bank is
  needed (synthetic fixture chain, `noid_pack_pins.rs:309-318`).
- **Expected.** The line
  `v2-negative case=wrong-terminal-recipient contracts=2 rows=<R> digest=<D> satisfied=false`, where
  `R` and `D` equal the honest cases' row count and matrix digest. The process exits 0. It returns
  `Err("negative case … unexpectedly satisfied")` if the constraint were missing.
- **Limits.** Profile `V2`, not the v2.1 `ScheduledV2` bank. The recipient code is the same function
  (`bind_v2_contract_execution`); only the program-arithmetic flavour differs. The test also covers
  only route A, and it needs several GB of RAM.

### 7.2 N2: forged opening cannot reach the funded root (new; covers the untested link B)

Add a test to a scratch copy of `noid_recursive`, in the `tests` module of
`src/region_sidecar/walk_a.rs` (`:1490`). It reuses `meta_fixture_profile` (`:1638`) and
`field_trace_case` (`:1892`).

1. Build two `SpineContractInstanceFlat` values from an HTLC-shaped `ObjectOpening`: honest (claim
   recipient Bob) and lying (claim recipient Mallory). Use `EMPTY_PROGRAM`, `deadline = 300`,
   close-only modes 10 and `max_fee = 50_000`. Convert each `Block128` to the flat basis as
   `block_slots.rs:1444-1469` does.
2. Make an object fixture: `meta_fixture_profile(true, true, true)`, but call
   `build_spine_instance_columns_with_contract(&instance, Some(&flat))` instead of `None`. Wrap rows
   start at `wrap = base + SPINE_TREE_SLOTS` (`base = protocol.spine_region_base`). The cells that
   matter:
   - old root: `META_C0`, `META_C0+1` at `wrap + 26` (`OLD_OBJECT_BASE + 1`);
   - claim recipient lane 0: `META_IN0+1` at `wrap + 20`;
   - claim recipient lane 1: `META_IN0` at `wrap + 21`.
3. Run three cases through the PCS-bound path of `field_trace_case`, using
   `WalkARegionVk::new_object_meta` instead of `new_meta`:
   - **(a) Honest Bob.** Must verify. The `META_C0..+1` cells at `wrap+26` must equal the flat lanes
     of `opening_bob.root()`.
   - **(b) Lying policy, real root.** Use the Mallory columns, then overwrite the old-root output cells
     (`committed[META_C0+l][wrap+26]` for l = 0, 1) with Bob's root. Keep `s0/s_out` from the Mallory
     trace.
   - **(c) Real policy rows, Mallory in the recipient inputs.** Use the Bob columns, then overwrite
     the two claim-recipient input cells with Mallory's lanes.
4. **Expected for (b) and (c).** `verify_field_deferred_matrix_with_post_commit_context(...)` returns
   `Err` (sidecar `VerifyError::Auxiliary`, or a claim/commitment mismatch). Run with
   `cargo test --release` so that `debug_assert!`s do not stop the prover early. If the prover itself
   returns `Err` or panics, record that too, wrapped in `std::panic::catch_unwind`. But that is only
   prover refusal, and it is weaker evidence than a verifier rejection.
5. **Add one control case** to the R1CS component, like review-1's test but going through
   `spine_region_data_from_wires`. Build the lying component and, after `b.build()`, overwrite the
   `old_object_root` witness wires with Bob's root. `matrix.satisfies` should then be **true**. This is
   the expected and correct result: it shows that the R1CS alone does not bind the opening, and that
   the binding is (a)–(c) above.

#### 7.2.1 N2 result (run 2026-11-04 on the owner's PC: WSL Ubuntu-24.04, rustc stable 1.99, `--release`)

**Both tests passed: `test result: ok. 2 passed; 0 failed` (16.7 s).** Every forgery was rejected by
the **verifier**, not merely refused by the prover.

**Setup.**
- A scratch copy of `noid_recursive` only, with path dependencies into the unmodified `vendor/`, its own
  empty `[workspace]` and the vendor `Cargo.lock`. One `cargo fetch` was the only network step.
- **Fixture.** An HTLC-shaped `ObjectOpening`:
  - `EMPTY_PROGRAM`, state 0;
  - claim authority `[0xA5;32]` (stands for `Addr(s)`), recovery authority and recovery recipient
    `[0xA1;32]` (Alice);
  - `deadline = 300`, `max_fee = 50_000`, modes 10 (close-only);
  - claim recipient Bob `[0xB0;32]` in the honest opening, Mallory `[0x3A;32]` in the lying one.
- The object Meta-A table is the `meta_fixture_profile(true, true, true)` layout, filled by
  `build_spine_instance_columns_with_contract(.., Some(opening))`.
- Sanity check: the table's old-root cell equals `ObjectOpening::root()` for both openings.
- **Path.** Each case goes through the commitment-bound path (`prove_field_with_public_io_and_post_commit_context`
  with the Walk-A sidecar in the post-commit callback, then `verify_field_deferred_matrix_with_post_commit_context`
  with `WalkARegionVk::new_object_meta`). The prover is wrapped in `catch_unwind`; it never panicked.
- **Rows.** With `wrap = 96`: old-root output = row 122, claim-recipient inputs = rows 116 (lane 0,
  column `META_IN0+1`) and 117 (lane 1, column `META_IN0`).

| Case | What was forged | Observed |
|---|---|---|
| (a) | nothing (honest Bob opening) | `Ok(())`: accepted |
| (b1) | Mallory policy rows; committed old-root cells (`META_C0`, `META_C0+1`, row 122) := funded (Bob) root | `VERIFIER REJECTED: Auxiliary` |
| (b2) | (b1) + the prover's internal permutation-output trace `s_out` at row 122 := funded root | `VERIFIER REJECTED: Auxiliary` |
| (c1) | funded-root table; the two claim-recipient input cells (rows 116/117) := Mallory | `VERIFIER REJECTED: Auxiliary` |
| (c2) | (c1) + the internal permutation input `s0` at rows 116/117 absorbs Mallory consistently | `VERIFIER REJECTED: Auxiliary` |

`Auxiliary` is the error the Walk-A sidecar verifier raises when the table is not a valid chain of
Poseidon2b permutations with the fixed `CNTPOL__/CNTOBJ__` starts.

**Control** (`acceptance::block_slots::q2_n2_control`). This is the main-circuit component:
`spine_region_data_from_wires` → views → policy → partition → execution, for one close at
height 299 < D = 300, using profile `ScheduledV2`.

| Case | Main equations satisfied? |
|---|---|
| 1. honest opening, pays Bob | **true** |
| 2. honest opening, pays Mallory (route A) | **false** (recipient pin) |
| 3. lying opening (claim recipient Mallory), old-root wire computed honestly, pays Mallory | **false** (old root ≠ `input_owner`) |
| 4. as 3, but the old-root witness wire is forced to the funded root | **true** |

All four matrices are identical (same structural digest). Rust `check_call` agrees: honest `Ok`,
route A `Err(Recipient)`, lying opening `Err(OldObject)`. Case 4 is the expected result. It shows that
the main equations alone would accept a forged opening, so the defence is exactly the hash table and
side proof tested above.

To force case 4, the scratch copy adds one `#[cfg(test)]` hook in `spine_region_data_from_wires`. The
hook changes only the witness *value* of that wire; it adds no row, and the identical digest confirms
it.

**Conclusion.** A miner who claims the contract's recipient is someone other than Bob has two ways
to make the claimed opening match the funded contract address, and both fail:
- writing the funded address into the hash table's output cell;
- writing the false recipient into its input cells, even with an internally consistent trace.

In both cases the side-proof verifier rejects the proof. Without the forgery, the main equations
reject the close at the recipient pin or at the address check. N2 therefore confirms by test the one
link that was previously confirmed by reading only.

Two limits remain:
- This is a component test: one transaction, `tx_log 0`, the Meta-A side proof alone. It is not a
  full HistoryStep block proof.
- It relies on the soundness of the PCS and side-proof machinery (§8.3); it does not test that.

**Reproduce.**
- The scratch tree is `<scratch>`.
- The added code is the `mod q2_n2` at the end of `src/region_sidecar/walk_a.rs`, plus
  `mod q2_n2_control` and the hook in `src/acceptance/block_slots.rs`.
- The added module texts are in `<scratch>\q2\walk_a_module.rs.txt` and `control_module.rs.txt`.
- The scratchpad is temporary; copy these files elsewhere if they must be kept.
- In WSL, from the scratch `noid_recursive` directory:
  ```sh
  . ~/.cargo/env
  CARGO_TARGET_DIR=$HOME/noid-target CARGO_BUILD_JOBS=2 \
    cargo test --offline --release -p noid_recursive --lib q2_n2 -- --nocapture --test-threads=1

The test code is kept in the repository as `parano1d/patches/q2-n2-tests.patch` (test-only; see `parano1d/README.md`, "Patches").
  ```
  First build about 4 min, then 1.5 min for an incremental rebuild; the test itself runs in 17 s.

### 7.3 N3: real end-to-end (M2, isolated devnet)

This needs a v2.1 proof bank (Q7) and real proving hardware.

1. Patch a scratch miner so that `noid_block/src/candidate_history.rs:170-189` skips `check_call`
   for one close.
2. Mine and prove a block whose close pays a third address. Try both an honest component (route A)
   and a lying one (route B, with the root cells forced).
3. **Expected.** Proving fails (unsatisfied matrix or sidecar). If a proof is emitted at all, a stock
   node's `verify_history_step_pending` (`relation.rs:1646`) rejects it, and the block is not
   accepted.

### 7.4 What was and was not run

- **N2: run and passed** (§7.2.1). The owner allowed one `cargo fetch` from crates.io. It fetched
  `zstd 0.13.3`, `libmdbx 0.6.6`, `mdbx-sys 13.11.0`, `memmap2 0.9.11` and their dependencies. No
  Parano1d node and no other host was contacted.
- **N1: not run.** WSL is limited to 3 GB RAM (`.wslconfig`), which is too small for the full B25
  direct-block matrix.
- **N3: not run.** It needs the v2.1 proof bank (Q7) and proving hardware.

## 8. Open doubts and assumptions

1. **The forged-opening link (route B) is tested at component level only.** N2 passed (§7.2.1). It is
   not yet tested inside a full HistoryStep block proof (N1/N3).
2. **Frozen matrix = this source.** Nodes verify against matrices identified by a release-time bank
   digest. `noid_node/build.rs:170-225` and `noid_miner/src/v21_artifacts.rs:65-82` check the bytes
   against the pinned digest; they do not rebuild from source. I did not regenerate the v2.1 class
   matrices from `d29b801` and compare digests. That needs the pack (Q7); see
   `.github/RELEASING.md:9,37`.
3. **Proof-system soundness is assumed, not audited.** This covers the Walk-A sidecar (sumcheck/walk
   relations), the PCS, the recursion and the in-circuit authorization capsule. I read which relations
   are imposed, not why they are sound.
4. **Poseidon2b strength.** Routes B and D reduce to Poseidon2b preimage/second-preimage resistance
   on the `CNTPOL__/CNTOBJ__` sponges and `ADDRFIX_`. This is the same assumption as Q8 (small round
   constants).
5. **Exact-State soundness is general, not contract-specific.** `trace/exact_state.rs:295-300`
   describes a "preparation-only" structural carrier that is "not a proved topology relation yet".
   Production closes the transition through the paired Merkle cells (`block_slots.rs:641-723`). I did
   not audit that relation; a flaw there would break every address, not only contracts.
6. **v2.1 native-asset pages (out of scope).** These are financial/trade groups, some with "zero
   authority" public groups (`trace/paged_spend.rs:341-343`). I did not check that a native or public
   group can never consume an NOID slot owned by a contract root. Native and contract flags are
   mutually exclusive on one page (`trace/action_surface.rs:214-215`), but a native group spending a
   contract-owned slot is a separate question for the v2.1 reviewers.
7. **Residual loss under the rule.** Anyone holding `s` can close early to Bob and choose any fee up
   to `max_fee`, which the miner keeps (#9, #12). Keep `max_fee` small relative to the amount
   (decision 7).
