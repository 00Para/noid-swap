//! The NOID swap wallet (swap wallet, piece 2a): a fresh, throwaway Parano1d wallet for ONE swap, held by this tool.
//!
//! Plain words. Today Alice funds the contract from her own wallet app, by hand. The swap wallet replaces that: for each swap the tool makes a
//! brand-new wallet (a random 32-byte master secret `m`, whose first stock-wallet address `Addr(Derive(m, 0))` is the address the user deposits
//! to), and does every NOID step from it: the funding (a plain payment of exactly the swap's amount to the contract's address), the recovery
//! close after the deadline (the contract pays the wallet back), and a final sweep of whatever is left to an address the user gave when the swap
//! was made. The user's own wallet is never used by the tool. Because the address is the stock wallet's first address, `m` can be imported into
//! the stock wallet (`parano1d --import-wallet-secret`) if this tool is gone: nobody is locked in.
//!
//! What is in here, in the order the pieces depend on each other:
//! - [`key`]: the master secret, `Derive(m, 0)` and the address, pinned by a known vector.
//! - [`chain`]: the read-only questions to a node (`getSlotsByOwner`, the fee, the epoch anchor, slot hints, the contract's instances).
//! - [`send`]: the plain-payment builder (coin selection, pages, proof, intent bytes), written against the vendor wallet's private builder.
//! - [`contract`]: the recovery close (the claim builder of `client::raw`, generalized to the branch after the deadline).
//! - [`persist`]: the record of a built transaction, written before it is submitted, and the rules for sending it again.
//! - [`flow`]: funding, recovery and sweep as one function each, with every refusal, plus the engine executors.
//!
//! Nothing here sends anything by itself: a transaction leaves this process only through an `IntentSubmitter`, and only the `--submit` path of
//! `swap-cli wallet ...` and the engine executors hand one in.

use std::fmt;

pub mod chain;
pub mod contract;
pub mod flow;
pub mod key;
pub mod persist;
pub mod send;

pub use key::WalletKey;

/// Why a wallet step did not happen, or could not be completed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum WalletError {
    /// The OS random generator failed.
    Entropy(String),
    /// A node could not be reached or answered with an error (nothing of ours was sent by this call).
    Rpc(String),
    /// A node's answer did not have the expected shape or failed a sanity check.
    Decode(String),
    /// A rule of this tool refused the step. Nothing was built or sent.
    Refused(String),
    /// The wallet holds less than the step needs.
    Funds { need: u64, have: u64 },
    /// The transaction could not be built.
    Build(String),
    /// The proof could not be made.
    Prove(String),
    /// Our own check of the built transaction failed: it is never submitted.
    Verify(String),
    /// The record beside the swap file could not be read or written.
    Persist(String),
}

impl fmt::Display for WalletError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            WalletError::Entropy(e) => write!(f, "OS random generator failed: {e}"),
            WalletError::Rpc(e) => write!(f, "node: {e}"),
            WalletError::Decode(e) => write!(f, "node answer: {e}"),
            WalletError::Refused(e) => write!(f, "refused: {e}"),
            WalletError::Funds { need, have } => write!(f, "the wallet holds {have} micro-NOID of plain coins and this step needs {need}"),
            WalletError::Build(e) => write!(f, "build: {e}"),
            WalletError::Prove(e) => write!(f, "prove: {e}"),
            WalletError::Verify(e) => write!(f, "self-verification failed: {e}"),
            WalletError::Persist(e) => write!(f, "record: {e}"),
        }
    }
}

impl std::error::Error for WalletError {}

impl From<crate::watch::RpcError> for WalletError {
    fn from(e: crate::watch::RpcError) -> Self {
        WalletError::Rpc(e.to_string())
    }
}

/// `fee` per live input in a plain payment (`noid_chain::consensus::params::FEE_PER_INPUT`, pinned by a test): a coin worth no more than this costs
/// more to spend than it is worth, so selection and the sweep skip it (amendment E).
pub const FEE_PER_INPUT: u64 = 100;

/// At most this many inputs in one canonical paged spend (`noid_tx::MAX_PAGED_SPEND_INPUTS`).
pub const MAX_INPUTS: usize = noid_tx::MAX_PAGED_SPEND_INPUTS;

// The ceiling on a fee quoted by a node: a local copy of the chain's fee rule at its maximum (`noid_chain::consensus::fees::fee_breakdown`:
// `MIN_FEE_BASE + FEE_PER_INPUT * inputs + FEE_PER_OUTPUT * outputs + state_growth_fee_per_slot * max(outputs - inputs, 0)`, where the
// per-slot state-growth fee is `STATE_GROWTH_FEE_BASE` times a pressure multiplier of at most 8), times a fixed factor for the relay floor.
// Every constant is pinned to the vendored source by a test in `send.rs`.
/// `noid_chain::consensus::params::MIN_FEE_BASE`.
pub const FEE_BASE: u64 = 5_000;
/// `noid_chain::consensus::params::FEE_PER_OUTPUT`.
pub const FEE_PER_OUTPUT: u64 = 700;
/// `noid_chain::consensus::params::STATE_GROWTH_FEE_BASE`.
pub const FEE_STATE_GROWTH_PER_SLOT: u64 = 2_500;
/// The largest value of `noid_chain::consensus::fees::pressure_multiplier` (occupancy of 90 % or more).
pub const FEE_PRESSURE_MAX: u64 = 8;
/// A fixed allowance for the node's relay floor above the consensus minimum.
pub const FEE_RELAY_FACTOR: u64 = 4;

/// The most this tool pays as the fee of a payment with `n_inputs` live inputs and `n_outputs` live outputs, whatever a node quotes:
/// the chain's fee rule at the highest state pressure, times [`FEE_RELAY_FACTOR`]. Checked arithmetic.
pub fn fee_ceiling(n_inputs: usize, n_outputs: usize) -> Result<u64, WalletError> {
    let overflow = || WalletError::Refused("the fee ceiling overflows".into());
    let n_in = u64::try_from(n_inputs).map_err(|_| overflow())?;
    let n_out = u64::try_from(n_outputs).map_err(|_| overflow())?;
    let growth = FEE_STATE_GROWTH_PER_SLOT
        .checked_mul(FEE_PRESSURE_MAX)
        .and_then(|per_slot| per_slot.checked_mul(n_out.saturating_sub(n_in)))
        .ok_or_else(overflow)?;
    FEE_BASE
        .checked_add(FEE_PER_INPUT.checked_mul(n_in).ok_or_else(overflow)?)
        .and_then(|t| t.checked_add(FEE_PER_OUTPUT.checked_mul(n_out)?))
        .and_then(|t| t.checked_add(growth))
        .and_then(|t| t.checked_mul(FEE_RELAY_FACTOR))
        .ok_or_else(overflow)
}
