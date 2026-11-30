//! The recovery close: Alice's wallet takes the NOID back from the contract after the deadline.
//!
//! This is the claim builder of `client::raw` (`build_claim`) taken to the other branch of the same contract. A Parano1d contract has one committed
//! `deadline`: at a height below it the claim authority may close the instance and the close must pay the claim recipient (Bob); from the deadline on
//! the recovery authority may close it and the close must pay the recovery recipient. Both rules are enforced by the node's admission and inside the
//! block proof, and `ObjectOpening::build_call` / `check_call` follow the height by themselves, so the shape of the transaction is the claim's.
//! What changes is who is checked: the witness is the wallet's own `Derive(m, 0)` (it must derive `opening.recovery_authority`), the call height
//! must be at or after the deadline, and the single output must pay `opening.recovery_recipient`.
//!
//! The claim builder itself is not touched (it is Bob's load-bearing path). The pieces that do not depend on the branch are reused from it:
//! `client::raw::encode_intent` and `client::raw::verify_intent_bytes`.

use htlc_harness as h;
use noid_tx::experimental_object::{ObjectError, ObjectOpening};
use noid_tx::{OwnerAuthorizationVersion, TxInput, TxPage};
use noid_poseidon2b::primitives::Address;

use super::key::WalletKey;
use super::WalletError;
use crate::client::raw::{encode_intent, verify_intent_bytes};
use crate::params;
use crate::swapfile::detect_contract_version;
use crate::watch::NoidInstance;

/// Everything needed to build one recovery close.
pub struct RecoveryInputs<'a> {
    pub opening: &'a ObjectOpening,
    /// The contract instance to close (slot, incarnation, amount): from the swap file's phase.
    pub instance: &'a NoidInstance,
    pub key: &'a WalletKey,
    /// An empty output slot (`getSlotHintsSalted`).
    pub output_slot: u32,
    /// The close fee: `[5,800, max_fee]` under contract v1, exactly `max_fee` under v2.
    pub fee: u64,
    pub epoch_anchor: [u8; 32],
    /// `tip + 1`; must be at or after the deadline.
    pub call_height: u64,
}

/// A built, proved, self-verified recovery close.
#[derive(Clone)]
pub struct RecoveryPlan {
    pub page: TxPage,
    pub call_height: u64,
    pub version: OwnerAuthorizationVersion,
    /// The logical transaction id.
    pub txid: [u8; 32],
    /// `ObjectIntent` wire bytes (the opening and one paged spend).
    pub intent_bytes: Vec<u8>,
    pub fee: u64,
    pub recipient: Address,
    pub amount_out: u64,
    pub instance: NoidInstance,
    pub epoch_anchor: [u8; 32],
}

impl std::fmt::Debug for RecoveryPlan {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("RecoveryPlan")
            .field("txid", &hex::encode(self.txid))
            .field("call_height", &self.call_height)
            .field("version", &self.version)
            .field("fee", &self.fee)
            .field("recipient", &self.recipient.to_bech32())
            .field("amount_out", &self.amount_out)
            .finish()
    }
}

impl RecoveryPlan {
    pub fn txid_hex(&self) -> String {
        hex::encode(self.txid)
    }

    pub fn intent_hex(&self) -> String {
        hex::encode(&self.intent_bytes)
    }
}

fn page_err(e: ObjectError) -> WalletError {
    WalletError::Build(format!("{e:?}"))
}

/// Build, preflight, prove, self-verify and encode the recovery close. Nothing is sent.
pub fn build_recovery(inp: RecoveryInputs<'_>) -> Result<RecoveryPlan, WalletError> {
    let opening = inp.opening;
    h::check_opening(opening).map_err(|e| WalletError::Refused(format!("tool guard: {e}")))?;
    if inp.call_height < opening.deadline {
        return Err(WalletError::Refused(format!(
            "the recovery branch opens at the deadline {}: a close at height {} would pay the claim recipient, not the wallet",
            opening.deadline, inp.call_height
        )));
    }
    let version = detect_contract_version(opening).ok_or_else(|| WalletError::Refused("the opening is neither HashTimeLock (v1) nor HashTimeLockV2 (v2); refusing to guess its fee rule".into()))?;
    let (min, max) = version.allowed_fee_range(opening.rules.max_fee);
    if inp.fee < min || inp.fee > max {
        return Err(WalletError::Refused(if min == max {
            format!("fee {} is not {max}: a v2 (fixed-fee) contract accepts only a close that pays exactly max_fee", inp.fee)
        } else {
            format!("fee {} outside [{min}, {max}]", inp.fee)
        }));
    }
    if inp.fee >= inp.instance.amount_micronoid {
        return Err(WalletError::Refused("the close fee is not less than the instance's amount".into()));
    }
    let own = inp.key.address();
    if opening.recovery_authority != own {
        return Err(WalletError::Refused("this wallet is not the contract's recovery authority".into()));
    }
    if inp.epoch_anchor == [0u8; 32] {
        return Err(WalletError::Refused("the epoch anchor is all zero".into()));
    }

    let input = TxInput { slot_index: inp.instance.slot_index, amount: inp.instance.amount_micronoid, creation_id: inp.instance.creation_id };
    let page = opening.build_call(input, inp.output_slot, inp.fee, inp.epoch_anchor, inp.call_height, true).map_err(page_err)?;
    // The consensus preflight: what the node's admission and the block circuit enforce for a call at this height.
    let checked = opening.check_call(&page, inp.call_height).map_err(|e| WalletError::Build(format!("check_call: {e:?}")))?;
    let out = page.body.outputs[0];
    if !checked.terminal || checked.authority != opening.recovery_authority || out.owner != opening.recovery_recipient {
        return Err(WalletError::Build("the built close does not pay the committed recovery recipient under the recovery authority".into()));
    }
    let amount_out = inp.instance.amount_micronoid.checked_sub(inp.fee).ok_or_else(|| WalletError::Refused("fee above the instance".into()))?;
    if out.amount != amount_out {
        return Err(WalletError::Build("the close's output is not the instance minus the fee".into()));
    }

    let auth_version = params::auth_version_at(inp.call_height);
    let witness = inp.key.spend_secret();
    let bundle = h::prove_v(&page, opening, inp.call_height, *witness, auth_version).map_err(|e| WalletError::Prove(format!("{e:?}")))?;
    drop(witness);
    h::verify_v(&page, opening, inp.call_height, &bundle, auth_version).map_err(|e| WalletError::Verify(format!("{e:?}")))?;

    let intent_bytes = encode_intent(opening, &page, &bundle).map_err(|e| WalletError::Build(e.to_string()))?;
    let txid = noid_tx::hash_paged_spend(std::slice::from_ref(&page)).map_err(|e| WalletError::Build(format!("txid: {e:?}")))?.0;
    // What a node does on receipt, from the bytes alone.
    let (decoded, decoded_txid) = verify_intent_bytes(&intent_bytes, inp.call_height).map_err(|e| WalletError::Verify(e.to_string()))?;
    if decoded_txid != txid || decoded.opening != *opening {
        return Err(WalletError::Verify("the re-decoded close has another transaction id or opening".into()));
    }
    Ok(RecoveryPlan {
        recipient: out.owner,
        amount_out,
        page,
        call_height: inp.call_height,
        version: auth_version,
        txid,
        intent_bytes,
        fee: inp.fee,
        instance: inp.instance.clone(),
        epoch_anchor: inp.epoch_anchor,
    })
}
