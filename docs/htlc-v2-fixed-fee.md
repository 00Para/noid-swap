# HashTimeLock v2: fixed-fee close

Status 2026-11-04: program written, `pruv check/build/verify` pass, harness tests pass (9 new, the 26 old unchanged).
Not deployed, not funded, no live run. The live runs and swap-cli fixtures still use v1 (`parano1d/contracts/htlc.pruv`).
Files: `parano1d/contracts/htlc_v2.pruv`, `htlc_v2.definition.json`, `parano1d/harness/tests/htlc_v2.rs`, and
`parano1d/README.md` ("HashTimeLock v2 (fixed fee)").

**Bottom line.** v2 adds one line: a close must pay *exactly* `max_fee`. That removes the "cheap close that cannot be
outbid" stall (design T2 / Q1). It costs `max_fee` on every close instead of about 5,800 μNOID. It does not fix a
network fee floor above `max_fee` (Q6), but it is no worse than v1 there.

## 1. The attack, in plain words

Parano1d's waiting room for transactions (the mempool) is first come, first served per coin: once a node has accepted
one spend of the contract's coin, it refuses every other spend of that same coin, even a better-paying one. There is
no "replace by fee".

In the swap, Alice knows the secret `s` from the very beginning, and everybody learns it once she claims on the other
chain. Anyone who knows `s` can authorize a close of the Parano1d contract. The contract forces that close to pay Bob,
so nobody can steal. But the closer chooses the fee, anywhere from the network minimum (5,800 μNOID) up to `max_fee`.

So a dishonest Alice (or anyone with `s`) sends a close at the minimum fee right after she reveals. Nodes accept it
first. Bob's close, which offers a better fee, is rejected as a conflict. If the network is busy, the minimum-fee close
can sit unconfirmed. It cannot be replaced, and it goes away only when its epoch anchor rotates (up to 144 blocks) or
the deadline `D` flips the branch. Once past `D`, Alice refunds the NOID and also keeps the ETH/BTC she already claimed.
Bob loses. (design §8 T2, §9 Q1, review-1 R1; `noid_mempool/src/pool.rs:L1296-L1297, L1334-L1356`.)

## 2. The fix

```
call {
    require terminal;
    require fee == max_fee;     // new
}
```

Every valid close, by anyone, on either branch, pays exactly `max_fee`. There is no cheaper close for an attacker to
broadcast, so there is nothing to be stuck behind: the attacker's close and Bob's close are equally attractive to
miners.

How it is enforced:

- `fee` is a program input (`vendor/parano1d/docs/contracts/core.md`, "Operands"): it is the body's fee. The block
  proof pins it to the body's fee leaf and then executes the program (`noid_recursive/src/acceptance/block_slots.rs`,
  `CONTEXT_SOURCES` / `ContextTrace.fee` / `bind_program`), so this is consensus, not only a node-side check.
  Behaviour matched the documentation in every test.
- The program cannot read the policy's `max_fee` ceiling (there is no such operand). So `max_fee` is written twice from
  the same Pruv parameter: once as the policy ceiling (`fee > max_fee` is rejected before the program runs, as
  `ObjectError::FeeLimit`, same as v1) and once as the immediate of `assert_equal fee, immediate` (`fee < max_fee` is
  rejected as `ProgramError::Assertion { step: 1 }`). The two copies cannot differ. The saved definition shows
  `"left": "fee", "right": "immediate", "immediate": "20000"` for the example params.
- 2 of 16 instructions. `pruv verify` proves both postconditions (`terminal`, `fee == max_fee`) for every successful
  integer execution.
- Tests: `fee == max_fee` accepted before and after `D`; `fee < max_fee` (5,800, `max_fee - 1`, 1, 0) rejected by the
  builder and by `check_call`, and the prover refuses to authorize it even with the right secret; `fee > max_fee` still
  `FeeLimit`; recipient, close-only and wrong-opening rules unchanged. A real claim proof and refund proof verify, and
  the claim's proof does not verify for the cheaper page.
- v2 has a different contract address than v1 for identical parameters (different code id). A bundle must say which
  version it uses, and pin the hash of `htlc_v2.pruv` instead of `htlc.pruv`.

What v2 does **not** remove: a rival close that conflicts for another reason (it picks a different output slot, or was
authorized under an older epoch anchor) can still occupy the coin in a node's mempool. Its fee is now `max_fee`, the
same as Bob's, and it still pays Bob exactly `amount - max_fee`, so the damage is bounded to the anchor-rotation wait
that `B_epoch` already budgets. (Identical bodies are the same transaction, not a conflict.) The Q1 experiment should
be rerun with v2 to measure it. One practical consequence: the closer picks the output slot, so Bob should find his
payout by watching the contract's close, not by assuming a slot.

## 3. What Bob's engine changes

- **The cap becomes the exact fee.** `swap-cli/src/engine.rs::close_fee` today returns the estimate clamped to
  `[MIN_CLOSE_FEE, max_fee]`, and both of Bob's clients (`client/raw.rs`, `client/stock.rs`) accept any fee in that
  range. For v2 the fee must be exactly `max_fee`: `close_fee` returns `max_fee`, and the clients require
  `fee == max_fee`. The same applies to Alice's refund.
- **Bob's payout is exact:** `amount - max_fee`. The engine can compute it up front, and "lock matches" can require
  `amount - max_fee ≥ Q_net` (`V = Q_net + F_max` already prices this in).
- **Rules that still apply:** `max_fee ≥ 5,800` (the hard guard; otherwise both branches are locked forever, and with a
  fixed fee the number is also the price), `max_fee ≥ max(50,000, 3 × estimateFeeDetailed(1,1))` at lock time (T5,
  §9.1; see §5 for a stronger rule), and the 1 % rule `max_fee ≤ 1 % × V`, which is now the real cost and not only a
  ceiling.
- **Watch the floor against the fee.** Each tick, compare `estimateFeeDetailed(1,1)` and the node's relay floor with
  `max_fee`. If the floor is at or above `max_fee`, the contract cannot help (the fee cannot go higher), so raise the
  alarm early and submit through nodes that are not under pressure (T5).
- **Bundle and pins:** the contract source hash, `contract_params.rs` (its definition check: add the two-instruction
  program shape with `fee` immediate = `max_fee`) and the opening comparison are version-specific. Keep v1 selectable
  for the existing fixtures.

## 4. The cost

Every close pays `max_fee`, claim or refund alike. v1 paid about 5,800 (live run 1: 5,800 under a 50,000 cap).

| `max_fee` (μNOID) | v1 typical close | v2 close | extra per swap | share of a 10 NOID swap (v1: 0.058 %) |
|---|---|---|---|---|
| 50,000 | 5,800 | 50,000 | 44,200 (0.0442 NOID) | 0.50 % |
| 20,000 | 5,800 | 20,000 | 14,200 | 0.20 % |
| 5,800 | 5,800 | 5,800 | 0 | 0.058 % |

The fee comes out of the contract balance, so Bob bears it on the claim path (it is already in the quote
`V = Q_net + F_max`) and Alice on the refund path. It goes to the network, not to Alice or Bob. The T1 griefing bound is
unchanged: with v1 the secret-holder could already burn up to `max_fee`; v2 makes that the only possible amount.

Small swaps get worse: with `max_fee = 50,000` the 1 % rule needs `V ≥ 5 NOID`. Below that, either the fee (and its
headroom) must fall or the swap is too small to run safely.

## 5. Q6: a relay floor above `max_fee`

Q6 is still open (mainnet floor behaviour under load is unmeasured). What the docs say, not measured here: under
pressure the local relay floor rises to 0.9 × the median of the last 50 admitted fees
(`noid_mempool/src/floor.rs:L4-L11`, `docs/protocol/economics.md:L107-L113`).

- If the floor exceeds `max_fee`, a close cannot be relayed on either branch. That is exactly the v1 situation: in v1 the
  largest fee anyone could pay was also `max_fee`. v2 loses no liveness here.
- The stall v2 removes is the one below `max_fee`. What remains is "floor > `max_fee`", which only headroom addresses.
- The feedback is mild: v2 closes enter the "last 50 fees" median, but if every one of them pays exactly `max_fee`, then
  0.9 × median ≤ 0.9 × `max_fee`. Swap closes alone cannot push the floor over `max_fee`; only other traffic paying more
  can.

**Proposed `max_fee` rule (replaces the §9.1 "F_max headroom" line once v2 is adopted):**

```
floor_seen = max(estimateFeeDetailed(1,1) now, highest relay floor the watcher saw in the last 24 h)
F_max      = max(50,000, 5 x floor_seen)
require F_max >= 5,800            # hard guard, unchanged
require F_max <= 1 % x V          # else refuse: the swap is too small for a safe fixed fee
```

Why: with v2, `F_max` is final (it is both the ceiling and the price), so it is chosen once, with more headroom (5x
instead of 3x, as ideas.md suggested) and with a memory of recent floor spikes instead of one sample, and the swap is
refused when 1 % of `V` cannot pay for it. At today's idle floor (5,000 to 6,000) this yields the 50,000 minimum.
Re-derive the factor once Q6 has two weeks of floor data. Both sides already agree on `F_max` in step 0 of the
negotiation.

**Implemented in swap-cli (2026-11-04).** The creation rule is applied by `new-alice` (`params::fee_cap_for`): v1
`max(50,000, 3 x estimate)`, v2 `max(50,000, 5 x floor_seen)` with `floor_seen = max(--fee-estimate, --floor-seen)`, both
refused above 1 % of `V`. T5 at lock time uses the same multiplier by version (3 for a v1 file, 5 for a v2 file), so Bob
aborts instead of locking when his live estimate no longer fits. Every tick, for both roles, adds a note when the node's
`breakdown.relay_floor` is at or above `max_fee` (a note, never an abort). Not implemented: the 24-hour floor memory.
`--floor-seen` is the operator's own input at creation (ignored with a stderr note for v1), nothing is stored in the swap
file, and the per-tick note and T5 only see the current reading.

## 6. Open items

- Q1 rerun with v2 on a real chain (two closes across an epoch rotation) to size `B_epoch` / `B_fee` and the shorter
  `D_offset` that ideas.md idea 5 hopes for. Not done: nothing here touches a network.
- swap-cli, the bundle format and `contract_params.rs` are not changed by this work; §3 lists what to change.
- v2 changes the pinned program, so it needs the same independent review as v1 and must be part of the M4 external review
  before real funds.
