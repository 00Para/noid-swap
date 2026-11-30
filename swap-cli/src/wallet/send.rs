//! The plain-payment builder of the swap wallet.
//!
//! The Parano1d wallet app builds a payment in a private module of its own binary (`vendor/parano1d/noid_node/src/wallet/builder.rs`,
//! `build_and_prove_tx_for_version`), which no other crate can call. This is the same construction written against the vendor's public types
//! (`noid_tx::{TxBody, TxPage, PagedSpendIntent}`, `noid_gkr::wallet_authorization`), following that builder line by line:
//!
//! - inputs are packed densely, 8 to a page (`TX_INPUTS`); output 0 is the payment, output 1 (only when something is left over) is the change
//!   back to the wallet; the outputs and the fee sit on the first page; the first page carries `PAGED_SPEND_START_BIT`, the last
//!   `PAGED_SPEND_END_BIT`; every page names the wallet as `input_owner` and carries the same epoch anchor; `is_coinbase` is false;
//! - one proof (`prove_paged_spend_authorization_for_version`, witness `Derive(m, 0)`) covers the whole group, and the intent is
//!   `PagedSpendIntent::new(pages, proof bytes)`, whose logical txid is what the node answers on submit.
//!
//! Coin selection follows the vendor wallet's (`WalletState::select_utxos` and `plan_send`): an exact single coin first, else the largest coins
//! first; a leftover too small to pay for a second output becomes extra fee, exactly as the vendor does. The fee for each shape comes from the node
//! (`estimateFeeDetailed`: state growth and the relay floor included, amendment H), never from a constant here.
//!
//! The result is not sent. The tests of this crate verify every built transaction with the vendor's own checks (`tests/wallet_vendor.rs`).

use noid_gkr::wallet_authorization::{
    prove_paged_spend_authorization_for_version, verify_paged_spend_authorization_for_version, OwnerAuthWitness, WalletAuthorizationBundle,
};
use noid_poseidon2b::primitives::{derive_address, Address, SpendSecret};
use noid_tx::{
    output_bitmap_bit, validate_paged_spend, OwnerAuthorizationVersion, PagedSpendIntent, TxBody, TxInput, TxOutput, TxPage, PAGED_SPEND_END_BIT,
    PAGED_SPEND_START_BIT, TX_INPUTS, TX_OUTPUTS,
};

use super::chain::{is_plain, WalletSlot};
use super::key::WalletKey;
use super::{WalletError, FEE_PER_INPUT, MAX_INPUTS};
use crate::params;

/// What to build: the inputs and the fee are decided already (see [`select_for_payment`] and [`select_for_sweep`]).
pub struct SendInputs<'a> {
    pub key: &'a WalletKey,
    /// The coins to spend, all plain coins of `key`'s address.
    pub inputs: &'a [WalletSlot],
    pub target: Address,
    /// The payment output's amount, exactly.
    pub amount: u64,
    pub fee: u64,
    /// Empty output slots: one for the payment, a second for the change when `inputs - amount - fee > 0`.
    pub output_slots: &'a [u32],
    /// `getEpochAnchor`: the anchor of the child block.
    pub epoch_anchor: [u8; 32],
    /// The height the transaction is built for (`tip + 1`); selects the owner-authorization version.
    pub child_height: u64,
}

/// One output of a built payment.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PlannedOutput {
    pub slot_index: u32,
    pub amount: u64,
    pub owner: Address,
}

/// A built, proved, self-verified payment, ready to be recorded and submitted. It holds no secret.
#[derive(Clone)]
pub struct SendPlan {
    /// The wire bytes of the `PagedSpendIntent` (what `paranoid_submitTxIntent` takes, hex-encoded).
    pub intent_bytes: Vec<u8>,
    /// The logical transaction id (`hash_paged_spend`): what the node answers.
    pub txid: [u8; 32],
    pub inputs: Vec<WalletSlot>,
    pub outputs: Vec<PlannedOutput>,
    pub amount: u64,
    pub fee: u64,
    pub change: u64,
    pub epoch_anchor: [u8; 32],
    pub child_height: u64,
    pub version: OwnerAuthorizationVersion,
}

impl std::fmt::Debug for SendPlan {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("SendPlan")
            .field("txid", &hex::encode(self.txid))
            .field("inputs", &self.inputs.len())
            .field("amount", &self.amount)
            .field("fee", &self.fee)
            .field("change", &self.change)
            .field("child_height", &self.child_height)
            .field("version", &self.version)
            .finish()
    }
}

impl SendPlan {
    pub fn txid_hex(&self) -> String {
        hex::encode(self.txid)
    }

    pub fn intent_hex(&self) -> String {
        hex::encode(&self.intent_bytes)
    }
}

fn pages_for(inp: &SendInputs<'_>, outputs: &[PlannedOutput], change: u64) -> Result<Vec<TxPage>, WalletError> {
    let owner = inp.key.address();
    let mut out_records = [TxOutput::dummy(); TX_OUTPUTS];
    let mut validity_bitmap = 0u16;
    for (i, o) in outputs.iter().enumerate() {
        out_records[i] = TxOutput { slot_index: o.slot_index, amount: o.amount, owner: o.owner };
        validity_bitmap |= output_bitmap_bit(i);
    }
    debug_assert_eq!(outputs.len(), 1 + usize::from(change > 0));

    let page_count = inp.inputs.len().div_ceil(TX_INPUTS).max(1);
    let mut pages = Vec::with_capacity(page_count);
    for page_index in 0..page_count {
        let mut page_inputs = [TxInput::dummy(); TX_INPUTS];
        let mut page_outputs = [TxOutput::dummy(); TX_OUTPUTS];
        let mut page_bitmap = 0u16;
        for (lane, input) in page_inputs.iter_mut().enumerate() {
            if let Some(utxo) = inp.inputs.get(page_index * TX_INPUTS + lane) {
                *input = TxInput { slot_index: utxo.slot_index, amount: utxo.amount, creation_id: utxo.creation_id };
                page_bitmap |= 1u16 << lane;
            }
        }
        if page_index == 0 {
            page_outputs = out_records;
            page_bitmap |= validity_bitmap;
            page_bitmap |= PAGED_SPEND_START_BIT;
        }
        if page_index + 1 == page_count {
            page_bitmap |= PAGED_SPEND_END_BIT;
        }
        pages.push(
            TxPage::new(TxBody {
                epoch_anchor: inp.epoch_anchor,
                fee: if page_index == 0 { inp.fee } else { 0 },
                input_owner: owner,
                inputs: page_inputs,
                outputs: page_outputs,
                validity_bitmap: page_bitmap,
                is_coinbase: false,
            })
            .map_err(|e| WalletError::Build(format!("page: {e}")))?,
        );
    }
    Ok(pages)
}

/// Build, prove, self-verify and encode one plain payment. Nothing is sent.
pub fn build_send(inp: SendInputs<'_>) -> Result<SendPlan, WalletError> {
    let refuse = |m: &str| WalletError::Refused(m.to_string());
    if inp.inputs.is_empty() {
        return Err(refuse("a payment needs at least one coin"));
    }
    if inp.inputs.len() > MAX_INPUTS {
        return Err(WalletError::Refused(format!("a payment spends at most {MAX_INPUTS} coins, got {}", inp.inputs.len())));
    }
    let mut slots = std::collections::BTreeSet::new();
    for s in inp.inputs {
        if !slots.insert(s.slot_index) {
            return Err(refuse("the same coin twice in the inputs"));
        }
        if !is_plain(s.creation_id) {
            return Err(refuse("a native-asset carrier is not a plain coin and is never spent"));
        }
        if s.amount == 0 {
            return Err(refuse("a coin of value zero"));
        }
    }
    if inp.amount == 0 {
        return Err(refuse("the amount of a payment cannot be zero"));
    }
    if inp.fee == 0 {
        return Err(refuse("a fee of zero"));
    }
    let own = inp.key.address();
    if inp.target == own {
        return Err(refuse("the payment's target is the wallet itself"));
    }
    if inp.epoch_anchor == [0u8; 32] {
        return Err(refuse("the epoch anchor is all zero"));
    }
    let total = inp.inputs.iter().try_fold(0u64, |a, s| a.checked_add(s.amount)).ok_or_else(|| refuse("the inputs' amounts overflow"))?;
    let need = inp.amount.checked_add(inp.fee).ok_or_else(|| refuse("amount plus fee overflows"))?;
    let change = total.checked_sub(need).ok_or(WalletError::Funds { need, have: total })?;
    let expected_outputs = 1 + usize::from(change > 0);
    if inp.output_slots.len() != expected_outputs {
        return Err(WalletError::Refused(format!("the payment has {expected_outputs} output(s) and {} output slot(s) were given", inp.output_slots.len())));
    }
    let mut seen = std::collections::BTreeSet::new();
    for slot in inp.output_slots {
        if !seen.insert(*slot) || slots.contains(slot) {
            return Err(refuse("an output slot is used twice or is also an input slot"));
        }
    }
    let mut outputs = vec![PlannedOutput { slot_index: inp.output_slots[0], amount: inp.amount, owner: inp.target }];
    if change > 0 {
        outputs.push(PlannedOutput { slot_index: inp.output_slots[1], amount: change, owner: own });
    }

    let pages = pages_for(&inp, &outputs, change)?;
    let facts = validate_paged_spend(&pages).map_err(|e| WalletError::Build(format!("the built group is not a canonical paged spend: {e}")))?;
    if facts.fee != inp.fee || usize::from(facts.live_inputs) != inp.inputs.len() || usize::from(facts.live_outputs) != expected_outputs {
        return Err(WalletError::Build("the built group does not say what it was built to say".into()));
    }

    // The witness is `Derive(m, 0)`; the prover consumes and zeroizes it. A witness that is not the owner's secret is a bug caught before proving.
    let witness_bytes = inp.key.spend_secret();
    if derive_address(&SpendSecret::from_bytes(*witness_bytes)) != own {
        return Err(WalletError::Build("the wallet's witness does not derive its address".into()));
    }
    let version = params::auth_version_at(inp.child_height);
    let bundle = prove_paged_spend_authorization_for_version(&pages, OwnerAuthWitness::new(SpendSecret::from_bytes(*witness_bytes)), version)
        .map_err(|e| WalletError::Prove(format!("{e:?}")))?;
    drop(witness_bytes);
    verify_paged_spend_authorization_for_version(&pages, &bundle, version).map_err(|e| WalletError::Verify(format!("{e:?}")))?;

    let auth = bundle.to_bytes().map_err(|e| WalletError::Build(format!("bundle: {e:?}")))?;
    let intent = PagedSpendIntent::new(pages.clone(), auth).map_err(|e| WalletError::Build(format!("intent: {e:?}")))?;
    let intent_bytes = intent.to_bytes().map_err(|e| WalletError::Build(format!("intent: {e:?}")))?;
    let txid = noid_tx::hash_paged_spend(&pages).map_err(|e| WalletError::Build(format!("txid: {e:?}")))?.0;
    if intent.logical_txid().0 != txid {
        return Err(WalletError::Build("the intent's transaction id differs from the group's".into()));
    }
    // What a node does on receipt: decode the bytes, verify the proof, derive the id. It must give back what we built.
    let (_, decoded_txid) = verify_plain_intent_bytes(&intent_bytes, inp.child_height)?;
    if decoded_txid != txid {
        return Err(WalletError::Verify("the re-decoded intent has another transaction id".into()));
    }
    Ok(SendPlan {
        intent_bytes,
        txid,
        inputs: inp.inputs.to_vec(),
        outputs,
        amount: inp.amount,
        fee: inp.fee,
        change,
        epoch_anchor: inp.epoch_anchor,
        child_height: inp.child_height,
        version,
    })
}

/// What a node does on `submitTxIntent` for a plain payment, as far as this crate can: decode the bytes, verify the proof at `child_height`'s
/// version and derive the logical id.
pub fn verify_plain_intent_bytes(bytes: &[u8], child_height: u64) -> Result<(PagedSpendIntent, [u8; 32]), WalletError> {
    let intent = PagedSpendIntent::from_bytes(bytes).map_err(|e| WalletError::Verify(format!("decode: {e:?}")))?;
    let bundle = WalletAuthorizationBundle::from_bytes(&intent.authorization_bytes).map_err(|e| WalletError::Verify(format!("bundle: {e:?}")))?;
    verify_paged_spend_authorization_for_version(&intent.pages, &bundle, params::auth_version_at(child_height)).map_err(|e| WalletError::Verify(format!("{e:?}")))?;
    let txid = noid_tx::hash_paged_spend(&intent.pages).map_err(|e| WalletError::Verify(format!("txid: {e:?}")))?.0;
    Ok((intent, txid))
}

/// The coins chosen for a payment, with its fee and change.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Selection {
    pub inputs: Vec<WalletSlot>,
    /// The fee the transaction pays (the node's fee for its shape, or a little more when the leftover is too small to make change).
    pub fee: u64,
    /// What goes back to the wallet; 0 means a one-output payment.
    pub change: u64,
}

/// Largest coin first, ties by slot index; a coin worth no more than the per-input fee is skipped (amendment E).
fn spendable_sorted(plain: &[WalletSlot]) -> Vec<WalletSlot> {
    let mut v: Vec<WalletSlot> = plain.iter().copied().filter(|s| is_plain(s.creation_id) && s.amount > FEE_PER_INPUT).collect();
    v.sort_by_key(|s| (std::cmp::Reverse(s.amount), s.slot_index));
    v
}

/// Choose the coins to pay exactly `amount`, following the vendor wallet: a single coin that equals `amount + fee(1, 1)` exactly, else the largest
/// coins first until the total covers `amount` and either a change output worth making (`total > amount + fee(n, 2)`) or the leftover covers
/// `fee(n, 1)` (the leftover then all goes to the fee). `fee_for(n_inputs, n_outputs)` asks the node.
pub fn select_for_payment(plain: &[WalletSlot], amount: u64, fee_for: &mut dyn FnMut(usize, usize) -> Result<u64, WalletError>) -> Result<Selection, WalletError> {
    if amount == 0 {
        return Err(WalletError::Refused("the amount of a payment cannot be zero".into()));
    }
    let coins = spendable_sorted(plain);
    let have = coins.iter().try_fold(0u64, |a, s| a.checked_add(s.amount)).ok_or_else(|| WalletError::Refused("the wallet's amounts overflow".into()))?;
    if coins.is_empty() {
        return Err(WalletError::Funds { need: amount, have: 0 });
    }
    // An exact single coin: no change, no extra output.
    let fee11 = fee_for(1, 1)?;
    let exact = amount.checked_add(fee11).ok_or_else(|| WalletError::Refused("amount plus fee overflows".into()))?;
    if let Some(c) = coins.iter().filter(|s| s.amount == exact).min_by_key(|s| s.slot_index) {
        return Ok(Selection { inputs: vec![*c], fee: fee11, change: 0 });
    }
    let mut total = 0u64;
    for (k, c) in coins.iter().enumerate().take(MAX_INPUTS) {
        let n = k + 1;
        total = total.checked_add(c.amount).ok_or_else(|| WalletError::Refused("the wallet's amounts overflow".into()))?;
        if total < amount {
            continue;
        }
        if total > amount {
            let fee2 = fee_for(n, 2)?;
            let need2 = amount.checked_add(fee2).ok_or_else(|| WalletError::Refused("amount plus fee overflows".into()))?;
            if total > need2 {
                return Ok(Selection { inputs: coins[..n].to_vec(), fee: fee2, change: total - need2 });
            }
        }
        let fee1 = fee_for(n, 1)?;
        if total - amount >= fee1 {
            // The leftover pays the fee: at most the difference between the one- and two-output fees more than the minimum.
            return Ok(Selection { inputs: coins[..n].to_vec(), fee: total - amount, change: 0 });
        }
    }
    let need = amount.checked_add(fee11).unwrap_or(u64::MAX);
    if coins.len() > MAX_INPUTS && have >= need {
        return Err(WalletError::Refused(format!("the payment needs more than {MAX_INPUTS} coins; sweep the wallet first to merge them")));
    }
    Err(WalletError::Funds { need, have })
}

/// The shape of a payment of `amount` that spends EXACTLY `inputs` (a rebuild of a recorded transaction): the node's fee for it, and the change.
/// The same rule as [`select_for_payment`], with the coins fixed: a change output when `total > amount + fee(n, 2)`, else the leftover pays the
/// fee when it covers `fee(n, 1)`, else the coins do not cover the payment.
pub fn shape_for_inputs(inputs: &[WalletSlot], amount: u64, fee_for: &mut dyn FnMut(usize, usize) -> Result<u64, WalletError>) -> Result<Selection, WalletError> {
    if amount == 0 || inputs.is_empty() || inputs.len() > MAX_INPUTS {
        return Err(WalletError::Refused("a payment needs an amount and between 1 and the input limit of coins".into()));
    }
    let n = inputs.len();
    let total = inputs.iter().try_fold(0u64, |a, s| a.checked_add(s.amount)).ok_or_else(|| WalletError::Refused("the inputs' amounts overflow".into()))?;
    let fee2 = fee_for(n, 2)?;
    let need2 = amount.checked_add(fee2).ok_or_else(|| WalletError::Refused("amount plus fee overflows".into()))?;
    if total > need2 {
        return Ok(Selection { inputs: inputs.to_vec(), fee: fee2, change: total - need2 });
    }
    let fee1 = fee_for(n, 1)?;
    match total.checked_sub(amount) {
        Some(left) if left >= fee1 => Ok(Selection { inputs: inputs.to_vec(), fee: left, change: 0 }),
        _ => Err(WalletError::Funds { need: amount.saturating_add(fee1), have: total }),
    }
}

/// The coins and the fee of a sweep: every spendable plain coin (the largest `MAX_INPUTS` when there are more) and one output.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SweepSelection {
    pub inputs: Vec<WalletSlot>,
    pub fee: u64,
    /// `inputs - fee`: what the payout address receives.
    pub amount: u64,
    /// Spendable coins left for the next sweep because of the input limit.
    pub left_over: usize,
}

/// Choose a sweep. Refused when the fee would be more than half of what is swept (not worth it) or there is nothing to sweep.
pub fn select_for_sweep(plain: &[WalletSlot], fee_for: &mut dyn FnMut(usize, usize) -> Result<u64, WalletError>) -> Result<SweepSelection, WalletError> {
    let coins = spendable_sorted(plain);
    if coins.is_empty() {
        return Err(WalletError::Refused("the wallet holds no plain coin worth more than the fee of spending it".into()));
    }
    let n = coins.len().min(MAX_INPUTS);
    let inputs = coins[..n].to_vec();
    let total = inputs.iter().try_fold(0u64, |a, s| a.checked_add(s.amount)).ok_or_else(|| WalletError::Refused("the wallet's amounts overflow".into()))?;
    let fee = fee_for(n, 1)?;
    let amount = total.checked_sub(fee).filter(|a| *a > 0).ok_or(WalletError::Funds { need: fee.saturating_add(1), have: total })?;
    check_sweep_fee(fee, total)?;
    Ok(SweepSelection { inputs, fee, amount, left_over: coins.len() - n })
}

/// A sweep whose fee is more than half of what it moves is not worth sending (the same rule for a fresh sweep and for a rebuild of a recorded one).
pub fn check_sweep_fee(fee: u64, total: u64) -> Result<(), WalletError> {
    if fee > total / 2 {
        return Err(WalletError::Refused(format!("the fee {fee} would be more than half of the {total} micro-NOID swept; not worth sending")));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn slot(i: u32, v: u64) -> WalletSlot {
        WalletSlot { slot_index: i, amount: v, creation_id: u64::from(i) + 1 }
    }

    /// The vendor's rule at low occupancy: 5,000 + 100 per input + 700 per output + 2,500 per net-new slot.
    fn rule(n_in: usize, n_out: usize) -> u64 {
        5_000 + 100 * n_in as u64 + 700 * n_out as u64 + 2_500 * n_out.saturating_sub(n_in) as u64
    }

    fn fee(n_in: usize, n_out: usize) -> Result<u64, WalletError> {
        Ok(rule(n_in, n_out))
    }

    #[test]
    fn the_per_input_fee_constant_is_the_chains() {
        assert_eq!(FEE_PER_INPUT, noid_chain::consensus::params::FEE_PER_INPUT);
        assert_eq!(MAX_INPUTS, noid_tx::MAX_PAGED_SPEND_INPUTS);
    }

    /// The fee ceiling is the chain's fee rule at its highest pressure, times the relay factor: the constants equal the vendor's, the vendor's
    /// source still says what this copy says (the pressure steps and the formula), and `fee_breakdown` at full occupancy gives the same number.
    #[test]
    fn the_fee_ceiling_is_pinned_to_the_vendored_fee_rule() {
        use noid_chain::consensus::params as p;
        assert_eq!(super::super::FEE_BASE, p::MIN_FEE_BASE);
        assert_eq!(super::super::FEE_PER_OUTPUT, p::FEE_PER_OUTPUT);
        assert_eq!(super::super::FEE_STATE_GROWTH_PER_SLOT, p::STATE_GROWTH_FEE_BASE);
        assert_eq!(FEE_PER_INPUT, p::FEE_PER_INPUT);

        // `vendor/parano1d/noid_chain/src/consensus/fees.rs`: the pressure multiplier's top step is 8, and the formula is the one copied here.
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../vendor/parano1d/noid_chain/src/consensus/fees.rs");
        let text = std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("the fee ceiling test must read the vendored source {}: {e} (this test never skips)", path.display()));
        let compact: String = text.split_whitespace().collect();
        for needle in [
            "bpsifbps>=PRESSURE_EXTREME_BPS=>8,bpsifbps>=PRESSURE_HIGH_BPS=>4,bpsifbps>=PRESSURE_LOW_BPS=>2,_=>1,",
            "STATE_GROWTH_FEE_BASE.saturating_mul(pressure_multiplier(active_slot_count,log_slots))",
            "letnet_new_slots=n_outputs.saturating_sub(n_inputs);",
            "letbase=MIN_FEE_BASE;",
            "letinput=FEE_PER_INPUT.saturating_mul(n_inputs);",
            "letoutput=FEE_PER_OUTPUT.saturating_mul(n_outputs);",
            "letio=input.saturating_add(output);",
            "letstate_growth=state_growth_fee_per_slot(active_slot_count,log_slots).saturating_mul(net_new_slots);",
            "letrequired_total=base.saturating_add(io).saturating_add(state_growth);",
        ] {
            assert!(compact.contains(needle), "the vendored fee rule no longer contains `{needle}`: re-derive the fee ceiling");
        }
        assert_eq!(super::super::FEE_PRESSURE_MAX, 8);

        // A full state (occupancy 100 %) is the highest pressure step.
        for n_in in 0..=12u64 {
            for n_out in 0..=12u64 {
                let at_max = noid_chain::consensus::fee_breakdown(n_in, n_out, 1 << 8, 8).required_total;
                assert_eq!(super::super::fee_ceiling(n_in as usize, n_out as usize).unwrap(), at_max * super::super::FEE_RELAY_FACTOR, "{n_in} in, {n_out} out");
            }
        }
        // checked arithmetic: an absurd shape is an error, never a wrap
        assert!(super::super::fee_ceiling(usize::MAX, usize::MAX).is_err());
    }

    #[test]
    fn one_coin_with_change_pays_the_two_output_fee() {
        let sel = select_for_payment(&[slot(1, 20_000_000)], 5_000_000, &mut fee).unwrap();
        assert_eq!(sel.inputs, vec![slot(1, 20_000_000)]);
        assert_eq!(sel.fee, 9_000);
        assert_eq!(sel.change, 20_000_000 - 5_000_000 - 9_000);
    }

    #[test]
    fn an_exact_single_coin_is_preferred_and_has_no_change() {
        let sel = select_for_payment(&[slot(3, 5_005_800), slot(1, 90_000_000)], 5_000_000, &mut fee).unwrap();
        assert_eq!(sel.inputs, vec![slot(3, 5_005_800)]);
        assert_eq!((sel.fee, sel.change), (5_800, 0));
    }

    #[test]
    fn a_leftover_too_small_for_change_becomes_extra_fee() {
        // total - amount = 7,000: more than fee(1,1) = 5,800, not more than fee(1,2) = 9,000
        let sel = select_for_payment(&[slot(1, 5_007_000)], 5_000_000, &mut fee).unwrap();
        assert_eq!((sel.fee, sel.change), (7_000, 0));
    }

    #[test]
    fn the_largest_coins_come_first_and_many_coins_are_added_until_covered() {
        let coins = [slot(1, 1_000_000), slot(2, 3_000_000), slot(3, 2_000_000), slot(4, 500)];
        let sel = select_for_payment(&coins, 5_500_000, &mut fee).unwrap();
        assert_eq!(sel.inputs.iter().map(|s| s.slot_index).collect::<Vec<_>>(), vec![2, 3, 1]);
        assert_eq!(sel.fee, rule(3, 2));
        assert_eq!(sel.change, 6_000_000 - 5_500_000 - rule(3, 2));
    }

    #[test]
    fn a_coin_worth_no_more_than_the_per_input_fee_is_never_selected() {
        let coins = [slot(1, 100), slot(2, 60)];
        assert!(matches!(select_for_payment(&coins, 50, &mut fee), Err(WalletError::Funds { have: 0, .. })));
        let sel = select_for_sweep(&[slot(1, 100), slot(2, 101), slot(3, 1_000_000)], &mut fee).unwrap();
        assert_eq!(sel.inputs.iter().map(|s| s.slot_index).collect::<Vec<_>>(), vec![3, 2]);
    }

    #[test]
    fn not_enough_funds_says_what_is_needed_and_what_is_there() {
        let e = select_for_payment(&[slot(1, 4_000_000)], 5_000_000, &mut fee).unwrap_err();
        assert!(matches!(e, WalletError::Funds { need: 5_005_800, have: 4_000_000 }), "{e:?}");
        let e = select_for_payment(&[], 1, &mut fee).unwrap_err();
        assert!(matches!(e, WalletError::Funds { .. }));
        // enough for the amount, not for the amount plus the fee
        let e = select_for_payment(&[slot(1, 5_000_100)], 5_000_000, &mut fee).unwrap_err();
        assert!(matches!(e, WalletError::Funds { .. }), "{e:?}");
    }

    #[test]
    fn carriers_are_never_chosen() {
        let carrier = WalletSlot { slot_index: 5, amount: 99_000_000, creation_id: (1 << 62) | 7 };
        assert!(matches!(select_for_payment(&[carrier], 1_000_000, &mut fee), Err(WalletError::Funds { .. })));
        assert!(select_for_sweep(&[carrier], &mut fee).is_err());
    }

    #[test]
    fn a_sweep_takes_everything_minus_the_fee_and_splits_at_the_input_limit() {
        let few = [slot(1, 1_000_000), slot(2, 2_000_000)];
        let sel = select_for_sweep(&few, &mut fee).unwrap();
        assert_eq!(sel.fee, rule(2, 1));
        assert_eq!(sel.amount, 3_000_000 - rule(2, 1));
        assert_eq!(sel.left_over, 0);

        let many: Vec<WalletSlot> = (0..(MAX_INPUTS as u32 + 5)).map(|i| slot(i, 10_000 + u64::from(i))).collect();
        let sel = select_for_sweep(&many, &mut fee).unwrap();
        assert_eq!(sel.inputs.len(), MAX_INPUTS);
        assert_eq!(sel.left_over, 5);
        // the largest ones went first
        assert!(sel.inputs.iter().all(|s| s.amount >= 10_005));
    }

    #[test]
    fn a_sweep_that_costs_more_than_half_is_refused() {
        // total 10,000, fee 5,800 + 100 + 700 = 6,600 > half
        assert!(matches!(select_for_sweep(&[slot(1, 10_000)], &mut fee), Err(WalletError::Refused(_))));
        // nothing left after the fee
        assert!(select_for_sweep(&[slot(1, 6_000)], &mut fee).is_err());
    }

    #[test]
    fn a_node_that_cannot_give_a_fee_stops_the_selection() {
        let mut broken = |_: usize, _: usize| -> Result<u64, WalletError> { Err(WalletError::Rpc("down".into())) };
        assert!(matches!(select_for_payment(&[slot(1, 10_000_000)], 1_000_000, &mut broken), Err(WalletError::Rpc(_))));
    }
}
