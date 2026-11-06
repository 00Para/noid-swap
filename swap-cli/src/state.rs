//! The swap state machine: one phase enum per role, one event enum, and the
//! allowed transitions. Pure data, no I/O: `swapfile` persists it, `engine`
//! drives it.
//!
//! Plain words: a *phase* is "where this swap is" (nothing on chain yet, NOID
//! funded, ETH locked, secret revealed, ...). An *event* is one fact that moves
//! it forward (an instance was seen, a lock became final, a claim was mined).
//! A transition that makes no sense for the current phase is refused, never
//! silently accepted.

use std::fmt;

use serde::{Deserialize, Serialize};

use crate::watch::{hexbytes, hexbytes_opt, u128dec, NoidInstance};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Role {
    /// The NOID holder: generates the secret, locks first, reveals on Ethereum.
    Alice,
    /// The ETH holder: locks second, claims NOID on first sight of the secret.
    Bob,
}

impl fmt::Display for Role {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(match self {
            Role::Alice => "alice",
            Role::Bob => "bob",
        })
    }
}

/// What both parties record about Bob's Ethereum lock once it is seen.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct LockSummary {
    #[serde(with = "hexbytes")]
    pub lock_id: [u8; 32],
    /// `T_reveal` (absolute Unix seconds).
    pub t_reveal: u64,
    #[serde(with = "u128dec")]
    pub amount_wei: u128,
    pub block_number: u64,
    #[serde(with = "hexbytes")]
    pub sender: [u8; 20],
    #[serde(with = "hexbytes")]
    pub receiver: [u8; 20],
}

/// Alice's phases, in protocol order (design section 2.2 steps 3, 6, 7, 8, 9, 10, 14
/// and the abort paths of section 2.3).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "phase", rename_all = "snake_case")]
pub enum AlicePhase {
    /// Secret drawn, opening built, swap file written. Nothing on chain.
    Created,
    /// `contract fund` submitted.
    FundingSubmitted { txid: Option<String> },
    /// The instance exists at the opening's root; first seen at `seen_at_tip`.
    Funded { instance: NoidInstance, seen_at_tip: u64 },
    /// Funding is final: `tip >= seen_at_tip + 17`.
    FundingFinal { instance: NoidInstance, final_at_tip: u64 },
    /// Bob's lock passed the step-9 checks.
    LockSeen { instance: NoidInstance, lock: LockSummary },
    /// Bob's lock is finalized: Alice may reveal while (I2) holds.
    LockFinal { instance: NoidInstance, lock: LockSummary },
    /// `HTLC.claim` broadcast at `submitted_at` (the reveal).
    RevealSubmitted {
        instance: NoidInstance,
        lock: LockSummary,
        #[serde(default, with = "hexbytes_opt")]
        tx_hash: Option<[u8; 32]>,
        submitted_at: u64,
    },
    /// `Claimed` mined at `block_number`.
    Revealed { instance: NoidInstance, lock: LockSummary, block_number: u64 },
    /// The ETH claim is finalized. Terminal for the swap itself, but NOT for the NOID (REVIEW-2 F9): while the instance is
    /// still at the contract at `D` (Bob never claimed), `refund_noid` is still offered from here. `instance` is the one
    /// recorded when she revealed; `None` only in a file written before F9 (a normal tick then fills it in from the
    /// node, see `Event::NoidInstanceSeen`).
    Done {
        lock: LockSummary,
        block_number: u64,
        #[serde(default)]
        instance: Option<NoidInstance>,
    },
    /// Recovery close submitted at `h >= D`.
    RefundSubmitted { instance: NoidInstance, txid: Option<String>, call_height: u64 },
    /// Recovery close included at `height`.
    RefundIncluded { instance: NoidInstance, txid: String, height: u64 },
    /// Refund final. Terminal.
    Refunded { txid: String, height: u64 },
    /// M2.5b: both legs are gone. Her reveal was still pending when Bob's ETH refund was mined (the reveal reverted), the
    /// calldata of that reveal had published the secret, Bob closed the NOID instance with it, and his refund is final.
    /// Terminal; `reason` names both facts. `instance` is the one recorded at the reveal (now closed).
    Lost { lock: LockSummary, instance: NoidInstance, refund_block: u64, reason: String },
    /// Given up before anything was funded. Terminal.
    Aborted { reason: String },
}

/// Bob's phases (design section 2.2 steps 5, 7, 8, 11, 12, 13 and section 2.4).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "phase", rename_all = "snake_case")]
pub enum BobPhase {
    /// Alice's bundle checked (opening rebuilt, parameters, (I1) achievable). Waiting for funding.
    Received,
    Funded { instance: NoidInstance, seen_at_tip: u64 },
    FundingFinal { instance: NoidInstance, final_at_tip: u64 },
    /// `HTLC.newLock` broadcast.
    LockSubmitted {
        instance: NoidInstance,
        t_reveal: u64,
        #[serde(with = "u128dec")]
        amount_wei: u128,
        #[serde(default, with = "hexbytes_opt")]
        tx_hash: Option<[u8; 32]>,
        submitted_at: u64,
    },
    /// `Locked` mined.
    Locked { instance: NoidInstance, lock: LockSummary },
    /// The secret is public (pending calldata or `Claimed`); checked against `H` and `A`.
    /// `attempts` counts claims already submitted and evicted (0 before the first).
    SecretSeen {
        instance: NoidInstance,
        lock: LockSummary,
        #[serde(with = "hexbytes")]
        preimage: [u8; 32],
        seen_at_tip: u64,
        seen_at_time: u64,
        #[serde(default)]
        attempts: u32,
    },
    /// Bob's close submitted for inclusion at `call_height`; `attempts` counts re-proofs.
    ClaimSubmitted {
        instance: NoidInstance,
        lock: LockSummary,
        #[serde(with = "hexbytes")]
        preimage: [u8; 32],
        txid: String,
        call_height: u64,
        attempts: u32,
    },
    /// Bob's close was seen confirmed at `height`. The watcher keeps asking about `txid` until it is final
    /// (REVIEW-2 F6): if a rollback drops it the phase goes back to `claim_submitted` / `secret_seen`, which is why the
    /// secret and the re-proof counter are carried here. `preimage` is `None` only in a file written before F6.
    ClaimIncluded {
        instance: NoidInstance,
        lock: LockSummary,
        txid: String,
        height: u64,
        #[serde(default, with = "hexbytes_opt")]
        preimage: Option<[u8; 32]>,
        #[serde(default)]
        attempts: u32,
    },
    /// Claim final. Terminal for the NOID; the ETH lock may still be open (REVIEW-2 F9): if Alice's claim never
    /// landed and the chain passes `T_reveal`, `refund_eth` is still offered from here. `lock` is `None` only in a
    /// file written before F9 (then nothing is offered).
    Done {
        txid: String,
        height: u64,
        #[serde(default)]
        lock: Option<LockSummary>,
    },
    /// `HTLC.refund` broadcast at `block.timestamp >= T_reveal`.
    RefundSubmitted {
        instance: NoidInstance,
        lock: LockSummary,
        #[serde(default, with = "hexbytes_opt")]
        tx_hash: Option<[u8; 32]>,
        submitted_at: u64,
    },
    /// `Refunded` mined at `block_number`, not yet final: the F6 rule applied to the ETH leg (M2.5b). A reorg can
    /// still drop the refund (back to `locked`) or replace it by Alice's claim (`secret_seen`). Not terminal.
    RefundMined { instance: NoidInstance, lock: LockSummary, block_number: u64 },
    /// `Refunded` final on Ethereum. Terminal.
    Refunded { lock: LockSummary, block_number: u64 },
    /// Never locked (checks failed, (I1) failed, lock-by passed, Alice aborted). Terminal.
    Aborted { reason: String },
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "role", rename_all = "lowercase")]
pub enum Phase {
    Alice(AlicePhase),
    Bob(BobPhase),
}

impl Phase {
    pub fn role(&self) -> Role {
        match self {
            Phase::Alice(_) => Role::Alice,
            Phase::Bob(_) => Role::Bob,
        }
    }

    pub fn is_terminal(&self) -> bool {
        match self {
            Phase::Alice(p) => p.is_terminal(),
            Phase::Bob(p) => p.is_terminal(),
        }
    }

    /// Short name for logs and history, without the payload.
    pub fn name(&self) -> String {
        let v = match self {
            Phase::Alice(p) => serde_json::to_value(p),
            Phase::Bob(p) => serde_json::to_value(p),
        };
        v.ok()
            .and_then(|v| v.get("phase").and_then(|p| p.as_str()).map(str::to_string))
            .unwrap_or_else(|| "?".into())
    }
}

impl AlicePhase {
    pub fn is_terminal(&self) -> bool {
        matches!(self, AlicePhase::Done { .. } | AlicePhase::Refunded { .. } | AlicePhase::Lost { .. } | AlicePhase::Aborted { .. })
    }

    pub fn instance(&self) -> Option<&NoidInstance> {
        match self {
            AlicePhase::Funded { instance, .. }
            | AlicePhase::FundingFinal { instance, .. }
            | AlicePhase::LockSeen { instance, .. }
            | AlicePhase::LockFinal { instance, .. }
            | AlicePhase::RevealSubmitted { instance, .. }
            | AlicePhase::Revealed { instance, .. }
            | AlicePhase::RefundSubmitted { instance, .. }
            | AlicePhase::RefundIncluded { instance, .. }
            | AlicePhase::Lost { instance, .. } => Some(instance),
            AlicePhase::Done { instance, .. } => instance.as_ref(),
            _ => None,
        }
    }

    pub fn lock(&self) -> Option<&LockSummary> {
        match self {
            AlicePhase::LockSeen { lock, .. }
            | AlicePhase::LockFinal { lock, .. }
            | AlicePhase::RevealSubmitted { lock, .. }
            | AlicePhase::Revealed { lock, .. }
            | AlicePhase::Lost { lock, .. }
            | AlicePhase::Done { lock, .. } => Some(lock),
            _ => None,
        }
    }
}

impl BobPhase {
    pub fn is_terminal(&self) -> bool {
        matches!(self, BobPhase::Done { .. } | BobPhase::Refunded { .. } | BobPhase::Aborted { .. })
    }

    pub fn instance(&self) -> Option<&NoidInstance> {
        match self {
            BobPhase::Funded { instance, .. }
            | BobPhase::FundingFinal { instance, .. }
            | BobPhase::LockSubmitted { instance, .. }
            | BobPhase::Locked { instance, .. }
            | BobPhase::SecretSeen { instance, .. }
            | BobPhase::ClaimSubmitted { instance, .. }
            | BobPhase::ClaimIncluded { instance, .. }
            | BobPhase::RefundSubmitted { instance, .. }
            | BobPhase::RefundMined { instance, .. } => Some(instance),
            _ => None,
        }
    }

    pub fn lock(&self) -> Option<&LockSummary> {
        match self {
            BobPhase::Locked { lock, .. }
            | BobPhase::SecretSeen { lock, .. }
            | BobPhase::ClaimSubmitted { lock, .. }
            | BobPhase::ClaimIncluded { lock, .. }
            | BobPhase::RefundSubmitted { lock, .. }
            | BobPhase::RefundMined { lock, .. }
            | BobPhase::Refunded { lock, .. } => Some(lock),
            BobPhase::Done { lock, .. } => lock.as_ref(),
            _ => None,
        }
    }

    pub fn preimage(&self) -> Option<&[u8; 32]> {
        match self {
            BobPhase::SecretSeen { preimage, .. } | BobPhase::ClaimSubmitted { preimage, .. } => {
                Some(preimage)
            }
            _ => None,
        }
    }
}

/// One fact that may move a phase forward. Chain facts come from observations;
/// `*Submitted` facts come from the executor after an action was performed.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "event", rename_all = "snake_case")]
pub enum Event {
    // Parano1d facts
    NoidInstanceSeen { instance: NoidInstance, tip: u64 },
    NoidFundingFinal { tip: u64 },
    NoidTxIncluded { txid: String, height: u64 },
    NoidTxFinal { tip: u64 },
    /// The tracked pending call vanished from the mempool without inclusion.
    NoidTxEvicted { txid: String },
    /// REVIEW-2 F6: the tracked transaction was recorded as included at `was_height` and is no longer confirmed
    /// there (a rollback). `still_pending`: it is back in the mempool (-> `claim_submitted` / `refund_submitted`);
    /// otherwise it is gone (Bob -> `secret_seen`, Alice -> back to waiting for `refund_noid`). `preimage` is only
    /// used by Bob, when his file predates F6 and the phase does not hold the secret.
    NoidTxReorged {
        txid: String,
        was_height: u64,
        still_pending: bool,
        #[serde(default, with = "hexbytes_opt")]
        preimage: Option<[u8; 32]>,
    },
    /// REVIEW-2 F6: the tracked transaction is confirmed again, at a different height than recorded (re-included
    /// after a rollback). The recorded height changes and the 18-block finality count starts over.
    NoidTxReincluded { txid: String, was_height: u64, height: u64 },
    /// M2.5d: the instance was closed OUTSIDE this tool (the wallet CLI) by `txid`, confirmed at `height`
    /// (`tick --closed-by`). Alice: her recovery close; Bob: his claim.
    NoidClosedExternally { txid: String, height: u64 },
    // Ethereum facts
    EthLockSeen { lock: LockSummary },
    EthLockFinal,
    EthPreimageSeen {
        #[serde(with = "hexbytes")]
        preimage: [u8; 32],
        tip: u64,
        time: u64,
    },
    EthClaimMined { block_number: u64 },
    EthClaimFinal,
    EthRefundMined { block_number: u64 },
    /// M2.5b: the refund is final on Ethereum (the F6 rule applied to Bob's ETH leg).
    EthRefundFinal,
    /// M2.5b: the refund recorded as mined at `block_number` is no longer on the chain (a reorg dropped it).
    EthRefundReorged { block_number: u64 },
    /// M2.5b, Alice: her reveal lost to Bob's refund and the NOID instance is gone too. `refund_block` is the ETH block
    /// of the final refund; `reason` names both facts.
    BothLegsLost { refund_block: u64, reason: String },
    // Action outcomes
    FundingSubmitted { txid: Option<String> },
    LockSubmitted {
        t_reveal: u64,
        #[serde(with = "u128dec")]
        amount_wei: u128,
        #[serde(default, with = "hexbytes_opt")]
        tx_hash: Option<[u8; 32]>,
        at: u64,
    },
    RevealSubmitted {
        #[serde(default, with = "hexbytes_opt")]
        tx_hash: Option<[u8; 32]>,
        at: u64,
    },
    ClaimSubmitted { txid: String, call_height: u64 },
    EthRefundSubmitted {
        #[serde(default, with = "hexbytes_opt")]
        tx_hash: Option<[u8; 32]>,
        at: u64,
    },
    NoidRefundSubmitted { txid: Option<String>, call_height: u64 },
    Abort { reason: String },
}

impl Event {
    pub fn name(&self) -> String {
        serde_json::to_value(self)
            .ok()
            .and_then(|v| v.get("event").and_then(|p| p.as_str()).map(str::to_string))
            .unwrap_or_else(|| "?".into())
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InvalidTransition {
    pub phase: String,
    pub event: String,
}

impl fmt::Display for InvalidTransition {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "event `{}` is not allowed in phase `{}`", self.event, self.phase)
    }
}

impl std::error::Error for InvalidTransition {}

fn invalid(phase: &Phase, event: &Event) -> InvalidTransition {
    InvalidTransition { phase: phase.name(), event: event.name() }
}

/// Apply one event. Returns the new phase or refuses.
pub fn transition(phase: &Phase, event: &Event) -> Result<Phase, InvalidTransition> {
    match phase {
        Phase::Alice(p) => alice(p, event).map(Phase::Alice).ok_or_else(|| invalid(phase, event)),
        Phase::Bob(p) => bob(p, event).map(Phase::Bob).ok_or_else(|| invalid(phase, event)),
    }
}

/// Txids compare as the node prints them: case-insensitively.
fn same_txid(a: &str, b: &str) -> bool {
    a.eq_ignore_ascii_case(b)
}

fn alice(p: &AlicePhase, e: &Event) -> Option<AlicePhase> {
    use AlicePhase as A;
    use Event as E;
    Some(match (p, e) {
        (A::Created, E::Abort { reason }) => A::Aborted { reason: reason.clone() },
        (A::Created, E::FundingSubmitted { txid }) => A::FundingSubmitted { txid: txid.clone() },
        // The instance may be seen directly (funding done out of band or after a restart).
        (A::Created | A::FundingSubmitted { .. }, E::NoidInstanceSeen { instance, tip }) => {
            A::Funded { instance: instance.clone(), seen_at_tip: *tip }
        }
        (A::Funded { instance, .. }, E::NoidFundingFinal { tip }) => {
            A::FundingFinal { instance: instance.clone(), final_at_tip: *tip }
        }
        (A::FundingFinal { instance, .. }, E::EthLockSeen { lock }) => {
            A::LockSeen { instance: instance.clone(), lock: lock.clone() }
        }
        (A::LockSeen { instance, lock }, E::EthLockFinal) => {
            A::LockFinal { instance: instance.clone(), lock: lock.clone() }
        }
        (A::LockFinal { instance, lock }, E::RevealSubmitted { tx_hash, at }) => A::RevealSubmitted {
            instance: instance.clone(),
            lock: lock.clone(),
            tx_hash: *tx_hash,
            submitted_at: *at,
        },
        // A claim mined by someone else with our preimage counts the same (funds go to Alice anyway).
        (A::LockFinal { instance, lock } | A::RevealSubmitted { instance, lock, .. }, E::EthClaimMined { block_number }) => {
            A::Revealed { instance: instance.clone(), lock: lock.clone(), block_number: *block_number }
        }
        (A::Revealed { instance, lock, block_number }, E::EthClaimFinal) => {
            A::Done { lock: lock.clone(), block_number: *block_number, instance: Some(instance.clone()) }
        }
        // REVIEW-2 F9: a file written before `done` kept the instance learns it from the node.
        (A::Done { lock, block_number, instance: None }, E::NoidInstanceSeen { instance, .. }) => {
            A::Done { lock: lock.clone(), block_number: *block_number, instance: Some(instance.clone()) }
        }
        // Refund at D from any phase that still holds the NOID and has not revealed.
        (
            A::FundingFinal { instance, .. }
            | A::LockSeen { instance, .. }
            | A::LockFinal { instance, .. }
            | A::Funded { instance, .. },
            E::NoidRefundSubmitted { txid, call_height },
        ) => A::RefundSubmitted { instance: instance.clone(), txid: txid.clone(), call_height: *call_height },
        // REVIEW-2 F9: Bob never claimed. The secret is public and Alice has (or tried to get) the ETH, but at `D` the
        // NOID is hers again: the same recovery close, from the phases after the reveal.
        (
            A::RevealSubmitted { instance, .. } | A::Revealed { instance, .. } | A::Done { instance: Some(instance), .. },
            E::NoidRefundSubmitted { txid, call_height },
        ) => A::RefundSubmitted { instance: instance.clone(), txid: txid.clone(), call_height: *call_height },
        (A::RefundSubmitted { instance, .. }, E::NoidTxIncluded { txid, height }) => {
            A::RefundIncluded { instance: instance.clone(), txid: txid.clone(), height: *height }
        }
        (A::RefundSubmitted { instance, .. }, E::NoidTxEvicted { .. }) => {
            // Back to waiting: the engine will re-submit at the next tick.
            A::FundingFinal { instance: instance.clone(), final_at_tip: 0 }
        }
        (A::RefundIncluded { txid, height, .. }, E::NoidTxFinal { .. }) => {
            A::Refunded { txid: txid.clone(), height: *height }
        }
        // REVIEW-2 F6: a rollback dropped the refund. Still in the mempool: wait for it again. Gone: the same
        // phase an eviction leads to, from which `refund_noid` is offered again.
        (A::RefundIncluded { instance, txid, height }, E::NoidTxReorged { txid: ev, still_pending, .. }) if same_txid(txid, ev) => {
            if *still_pending {
                A::RefundSubmitted { instance: instance.clone(), txid: Some(txid.clone()), call_height: *height }
            } else {
                A::FundingFinal { instance: instance.clone(), final_at_tip: 0 }
            }
        }
        (A::RefundIncluded { instance, txid, .. }, E::NoidTxReincluded { txid: ev, height, .. }) if same_txid(txid, ev) => {
            A::RefundIncluded { instance: instance.clone(), txid: txid.clone(), height: *height }
        }
        // M2.5d: the recovery close was made outside this tool.
        (
            A::Funded { instance, .. }
            | A::FundingFinal { instance, .. }
            | A::LockSeen { instance, .. }
            | A::LockFinal { instance, .. }
            | A::RefundSubmitted { instance, .. }
            // REVIEW-2 F9: also after the reveal (the engine's height check keeps this to a close at `h >= D`).
            | A::RevealSubmitted { instance, .. }
            | A::Revealed { instance, .. }
            | A::Done { instance: Some(instance), .. },
            E::NoidClosedExternally { txid, height },
        ) => A::RefundIncluded { instance: instance.clone(), txid: txid.clone(), height: *height },
        // M2.5b: the reveal never landed, Bob's refund is final and the NOID instance is closed: nothing is left.
        (A::RevealSubmitted { instance, lock, .. }, E::BothLegsLost { refund_block, reason }) => A::Lost {
            lock: lock.clone(),
            instance: instance.clone(),
            refund_block: *refund_block,
            reason: reason.clone(),
        },
        // Log-only fact: Bob's ETH lock was refunded. Alice's phase does not move
        // (she still waits for D and never reveals); the engine emits it once.
        (
            A::FundingFinal { .. } | A::LockSeen { .. } | A::LockFinal { .. } | A::RevealSubmitted { .. } | A::Revealed { .. },
            E::EthRefundMined { .. },
        ) => p.clone(),
        _ => return None,
    })
}

fn bob(p: &BobPhase, e: &Event) -> Option<BobPhase> {
    use BobPhase as B;
    use Event as E;
    Some(match (p, e) {
        // Before locking: Bob simply walks away. After the secret is seen: the
        // claim branch closed on him (he lost); the phase records why.
        (
            B::Received | B::Funded { .. } | B::FundingFinal { .. } | B::SecretSeen { .. } | B::ClaimSubmitted { .. },
            E::Abort { reason },
        ) => B::Aborted { reason: reason.clone() },
        (B::Received, E::NoidInstanceSeen { instance, tip }) => {
            B::Funded { instance: instance.clone(), seen_at_tip: *tip }
        }
        (B::Funded { instance, .. }, E::NoidFundingFinal { tip }) => {
            B::FundingFinal { instance: instance.clone(), final_at_tip: *tip }
        }
        (B::FundingFinal { instance, .. }, E::LockSubmitted { t_reveal, amount_wei, tx_hash, at }) => {
            B::LockSubmitted {
                instance: instance.clone(),
                t_reveal: *t_reveal,
                amount_wei: *amount_wei,
                tx_hash: *tx_hash,
                submitted_at: *at,
            }
        }
        (B::LockSubmitted { instance, .. } | B::FundingFinal { instance, .. }, E::EthLockSeen { lock }) => {
            B::Locked { instance: instance.clone(), lock: lock.clone() }
        }
        // A secret seen while Bob's refund is still unconfirmed counts too: if Alice's
        // claim was mined first his refund reverted, and the NOID is his to take.
        (
            B::Locked { instance, lock } | B::RefundSubmitted { instance, lock, .. } | B::RefundMined { instance, lock, .. },
            E::EthPreimageSeen { preimage, tip, time },
        ) => {
            B::SecretSeen {
                instance: instance.clone(),
                lock: lock.clone(),
                preimage: *preimage,
                seen_at_tip: *tip,
                seen_at_time: *time,
                attempts: 0,
            }
        }
        (B::SecretSeen { instance, lock, preimage, attempts, .. }, E::ClaimSubmitted { txid, call_height }) => {
            B::ClaimSubmitted {
                instance: instance.clone(),
                lock: lock.clone(),
                preimage: *preimage,
                txid: txid.clone(),
                call_height: *call_height,
                attempts: attempts + 1,
            }
        }
        // Re-proof after an eviction or an anchor rotation: same phase, one more attempt.
        (B::ClaimSubmitted { instance, lock, preimage, attempts, .. }, E::ClaimSubmitted { txid, call_height }) => {
            B::ClaimSubmitted {
                instance: instance.clone(),
                lock: lock.clone(),
                preimage: *preimage,
                txid: txid.clone(),
                call_height: *call_height,
                attempts: attempts + 1,
            }
        }
        (B::ClaimSubmitted { instance, lock, preimage, attempts, .. }, E::NoidTxEvicted { .. }) => B::SecretSeen {
            instance: instance.clone(),
            lock: lock.clone(),
            preimage: *preimage,
            seen_at_tip: 0,
            seen_at_time: 0,
            attempts: *attempts,
        },
        (B::ClaimSubmitted { instance, lock, preimage, attempts, .. }, E::NoidTxIncluded { txid, height }) => B::ClaimIncluded {
            instance: instance.clone(),
            lock: lock.clone(),
            txid: txid.clone(),
            height: *height,
            preimage: Some(*preimage),
            attempts: *attempts,
        },
        (B::ClaimIncluded { txid, height, lock, .. }, E::NoidTxFinal { .. }) => {
            B::Done { txid: txid.clone(), height: *height, lock: Some(lock.clone()) }
        }
        // REVIEW-2 F6: a rollback dropped the claim. Still in the mempool: wait for it again. Gone: Bob must prove again.
        (
            B::ClaimIncluded { instance, lock, txid, height, preimage, attempts },
            E::NoidTxReorged { txid: ev, still_pending, preimage: from_eth, .. },
        ) if same_txid(txid, ev) => {
            let preimage = (*preimage).or(*from_eth)?;
            if *still_pending {
                B::ClaimSubmitted {
                    instance: instance.clone(),
                    lock: lock.clone(),
                    preimage,
                    txid: txid.clone(),
                    call_height: *height,
                    attempts: *attempts,
                }
            } else {
                B::SecretSeen {
                    instance: instance.clone(),
                    lock: lock.clone(),
                    preimage,
                    seen_at_tip: 0,
                    seen_at_time: 0,
                    attempts: *attempts,
                }
            }
        }
        (B::ClaimIncluded { instance, lock, txid, preimage, attempts, .. }, E::NoidTxReincluded { txid: ev, height, .. })
            if same_txid(txid, ev) =>
        {
            B::ClaimIncluded {
                instance: instance.clone(),
                lock: lock.clone(),
                txid: txid.clone(),
                height: *height,
                preimage: *preimage,
                attempts: *attempts,
            }
        }
        // M2.5d: the claim was made outside this tool.
        (
            B::SecretSeen { instance, lock, preimage, attempts, .. } | B::ClaimSubmitted { instance, lock, preimage, attempts, .. },
            E::NoidClosedExternally { txid, height },
        ) => B::ClaimIncluded {
            instance: instance.clone(),
            lock: lock.clone(),
            txid: txid.clone(),
            height: *height,
            preimage: Some(*preimage),
            attempts: *attempts,
        },
        (B::Locked { instance, lock }, E::EthRefundSubmitted { tx_hash, at }) => B::RefundSubmitted {
            instance: instance.clone(),
            lock: lock.clone(),
            tx_hash: *tx_hash,
            submitted_at: *at,
        },
        // M2.5b: a mined refund is not final. It stays `refund_mined` until Ethereum finalizes its block; a re-inclusion at
        // another height restarts the count (like `NoidTxReincluded`); a reorg that drops it goes back to `locked`.
        (
            B::Locked { instance, lock } | B::RefundSubmitted { instance, lock, .. } | B::RefundMined { instance, lock, .. },
            E::EthRefundMined { block_number },
        ) => B::RefundMined { instance: instance.clone(), lock: lock.clone(), block_number: *block_number },
        (B::RefundMined { lock, block_number, .. }, E::EthRefundFinal) => {
            B::Refunded { lock: lock.clone(), block_number: *block_number }
        }
        (B::RefundMined { instance, lock, .. }, E::EthRefundReorged { .. }) => {
            B::Locked { instance: instance.clone(), lock: lock.clone() }
        }
        // REVIEW-2 F9: once the secret is known the NOID claim and the ETH refund are independent. The refund of
        // Bob's still-open lock after `T_reveal` is recorded without moving the claim's phase (the claim, if any,
        // goes on in its own phase); the engine keys on these history entries to offer it once.
        (
            B::SecretSeen { .. } | B::ClaimSubmitted { .. } | B::ClaimIncluded { .. } | B::Done { .. },
            E::EthRefundSubmitted { .. } | E::EthRefundMined { .. },
        ) => p.clone(),
        _ => return None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn inst() -> NoidInstance {
        NoidInstance { slot_index: 5, creation_id: 77, amount_micronoid: 1_000_000 }
    }

    fn lock() -> LockSummary {
        LockSummary {
            lock_id: [1; 32],
            t_reveal: 1_000_000,
            amount_wei: 10u128.pow(16),
            block_number: 100,
            sender: [2; 20],
            receiver: [3; 20],
        }
    }

    #[test]
    fn alice_happy_path() {
        let mut p = Phase::Alice(AlicePhase::Created);
        let steps = [
            Event::FundingSubmitted { txid: Some("aa".into()) },
            Event::NoidInstanceSeen { instance: inst(), tip: 10 },
            Event::NoidFundingFinal { tip: 27 },
            Event::EthLockSeen { lock: lock() },
            Event::EthLockFinal,
            Event::RevealSubmitted { tx_hash: Some([9; 32]), at: 5 },
            Event::EthClaimMined { block_number: 120 },
            Event::EthClaimFinal,
        ];
        for e in steps {
            p = transition(&p, &e).unwrap();
        }
        assert_eq!(p, Phase::Alice(AlicePhase::Done { lock: lock(), block_number: 120, instance: Some(inst()) }));
        assert!(p.is_terminal());
        assert_eq!(p.name(), "done");
    }

    #[test]
    fn alice_refund_path_and_refusals() {
        let mut p = Phase::Alice(AlicePhase::Created);
        // Revealing before the lock is final is refused.
        assert!(transition(&p, &Event::RevealSubmitted { tx_hash: None, at: 1 }).is_err());
        p = transition(&p, &Event::NoidInstanceSeen { instance: inst(), tip: 10 }).unwrap();
        p = transition(&p, &Event::NoidFundingFinal { tip: 27 }).unwrap();
        // Alice cannot "abort" once funded: she must refund.
        assert!(transition(&p, &Event::Abort { reason: "x".into() }).is_err());
        p = transition(&p, &Event::NoidRefundSubmitted { txid: Some("bb".into()), call_height: 800 }).unwrap();
        // Eviction sends her back to waiting, then she resubmits.
        let evicted = transition(&p, &Event::NoidTxEvicted { txid: "bb".into() }).unwrap();
        assert!(matches!(evicted, Phase::Alice(AlicePhase::FundingFinal { .. })));
        p = transition(&p, &Event::NoidTxIncluded { txid: "bb".into(), height: 801 }).unwrap();
        p = transition(&p, &Event::NoidTxFinal { tip: 818 }).unwrap();
        assert_eq!(p, Phase::Alice(AlicePhase::Refunded { txid: "bb".into(), height: 801 }));
        assert!(transition(&p, &Event::EthLockSeen { lock: lock() }).is_err());
    }

    #[test]
    fn alice_logs_a_refund_of_bobs_lock_without_moving() {
        let mut p = Phase::Alice(AlicePhase::Created);
        // Nothing to log before she knows of a lock.
        assert!(transition(&p, &Event::EthRefundMined { block_number: 5 }).is_err());
        p = transition(&p, &Event::NoidInstanceSeen { instance: inst(), tip: 10 }).unwrap();
        p = transition(&p, &Event::NoidFundingFinal { tip: 27 }).unwrap();
        p = transition(&p, &Event::EthLockSeen { lock: lock() }).unwrap();
        p = transition(&p, &Event::EthLockFinal).unwrap();
        assert_eq!(transition(&p, &Event::EthRefundMined { block_number: 5 }).unwrap(), p);
        let r = transition(&p, &Event::NoidRefundSubmitted { txid: None, call_height: 800 }).unwrap();
        assert!(transition(&r, &Event::EthRefundMined { block_number: 5 }).is_err());
    }

    #[test]
    fn bob_happy_path_with_a_reproof() {
        let mut p = Phase::Bob(BobPhase::Received);
        p = transition(&p, &Event::NoidInstanceSeen { instance: inst(), tip: 10 }).unwrap();
        p = transition(&p, &Event::NoidFundingFinal { tip: 27 }).unwrap();
        p = transition(&p, &Event::LockSubmitted { t_reveal: 1_000_000, amount_wei: 1, tx_hash: None, at: 3 }).unwrap();
        p = transition(&p, &Event::EthLockSeen { lock: lock() }).unwrap();
        p = transition(&p, &Event::EthPreimageSeen { preimage: [7; 32], tip: 40, time: 4 }).unwrap();
        p = transition(&p, &Event::ClaimSubmitted { txid: "c1".into(), call_height: 41 }).unwrap();
        p = transition(&p, &Event::ClaimSubmitted { txid: "c2".into(), call_height: 60 }).unwrap();
        match &p {
            Phase::Bob(BobPhase::ClaimSubmitted { attempts, txid, .. }) => {
                assert_eq!(*attempts, 2);
                assert_eq!(txid, "c2");
            }
            other => panic!("{other:?}"),
        }
        p = transition(&p, &Event::NoidTxIncluded { txid: "c2".into(), height: 61 }).unwrap();
        p = transition(&p, &Event::NoidTxFinal { tip: 78 }).unwrap();
        assert_eq!(p, Phase::Bob(BobPhase::Done { txid: "c2".into(), height: 61, lock: Some(lock()) }));
        assert!(p.is_terminal());
    }

    #[test]
    fn bob_refund_path_and_refusals() {
        let mut p = Phase::Bob(BobPhase::Received);
        // Bob never claims before a lock exists, never locks before funding is final.
        assert!(transition(&p, &Event::ClaimSubmitted { txid: "x".into(), call_height: 1 }).is_err());
        assert!(transition(&p, &Event::LockSubmitted { t_reveal: 1, amount_wei: 1, tx_hash: None, at: 1 }).is_err());
        p = transition(&p, &Event::NoidInstanceSeen { instance: inst(), tip: 10 }).unwrap();
        assert!(transition(&p, &Event::LockSubmitted { t_reveal: 1, amount_wei: 1, tx_hash: None, at: 1 }).is_err());
        p = transition(&p, &Event::NoidFundingFinal { tip: 27 }).unwrap();
        p = transition(&p, &Event::LockSubmitted { t_reveal: 1_000_000, amount_wei: 1, tx_hash: None, at: 3 }).unwrap();
        p = transition(&p, &Event::EthLockSeen { lock: lock() }).unwrap();
        // Once locked, Bob cannot abort; he refunds.
        assert!(transition(&p, &Event::Abort { reason: "x".into() }).is_err());
        p = transition(&p, &Event::EthRefundSubmitted { tx_hash: None, at: 1_000_001 }).unwrap();
        // A preimage seen while the refund is unconfirmed moves Bob to claiming (his refund may have reverted).
        let late = transition(&p, &Event::EthPreimageSeen { preimage: [7; 32], tip: 1, time: 1 }).unwrap();
        assert!(matches!(late, Phase::Bob(BobPhase::SecretSeen { .. })));
        // M2.5b: mined is not final.
        p = transition(&p, &Event::EthRefundMined { block_number: 200 }).unwrap();
        assert_eq!(p, Phase::Bob(BobPhase::RefundMined { instance: inst(), lock: lock(), block_number: 200 }));
        assert!(!p.is_terminal());
        p = transition(&p, &Event::EthRefundFinal).unwrap();
        assert_eq!(p, Phase::Bob(BobPhase::Refunded { lock: lock(), block_number: 200 }));
        assert!(p.is_terminal());
        assert!(transition(&p, &Event::EthPreimageSeen { preimage: [7; 32], tip: 1, time: 1 }).is_err());
        assert!(transition(&p, &Event::EthRefundReorged { block_number: 200 }).is_err());
    }

    #[test]
    fn m25b_bobs_mined_refund_follows_a_reorg() {
        let locked = Phase::Bob(BobPhase::Locked { instance: inst(), lock: lock() });
        // The refund can be mined straight from `locked` (the submission was not seen) and again at another height.
        let mined = transition(&locked, &Event::EthRefundMined { block_number: 200 }).unwrap();
        assert_eq!(mined.name(), "refund_mined");
        let again = transition(&mined, &Event::EthRefundMined { block_number: 203 }).unwrap();
        assert_eq!(again, Phase::Bob(BobPhase::RefundMined { instance: inst(), lock: lock(), block_number: 203 }));
        // Dropped before it was final: back to `locked`, from which `refund_eth` is offered again.
        assert_eq!(transition(&again, &Event::EthRefundReorged { block_number: 203 }).unwrap(), locked);
        // Replaced by Alice's claim: the secret is public and the NOID is Bob's to take.
        let seen = transition(&again, &Event::EthPreimageSeen { preimage: [7; 32], tip: 9, time: 10 }).unwrap();
        assert!(matches!(seen, Phase::Bob(BobPhase::SecretSeen { .. })));
        // Final only through `EthRefundFinal`; the claim events do not apply.
        assert!(transition(&again, &Event::ClaimSubmitted { txid: "x".into(), call_height: 1 }).is_err());
    }

    #[test]
    fn m25b_alice_loses_both_legs_only_from_a_pending_reveal() {
        let mut p = Phase::Alice(AlicePhase::Created);
        p = transition(&p, &Event::NoidInstanceSeen { instance: inst(), tip: 10 }).unwrap();
        p = transition(&p, &Event::NoidFundingFinal { tip: 27 }).unwrap();
        p = transition(&p, &Event::EthLockSeen { lock: lock() }).unwrap();
        p = transition(&p, &Event::EthLockFinal).unwrap();
        let lost = Event::BothLegsLost { refund_block: 150, reason: "both".into() };
        assert!(transition(&p, &lost).is_err(), "no reveal sent yet");
        p = transition(&p, &Event::RevealSubmitted { tx_hash: Some([9; 32]), at: 5 }).unwrap();
        let gone = transition(&p, &lost).unwrap();
        assert_eq!(
            gone,
            Phase::Alice(AlicePhase::Lost { lock: lock(), instance: inst(), refund_block: 150, reason: "both".into() })
        );
        assert!(gone.is_terminal());
        assert_eq!(gone.name(), "lost");
        let revealed = transition(&p, &Event::EthClaimMined { block_number: 120 }).unwrap();
        assert!(transition(&revealed, &lost).is_err(), "her claim landed: the ETH is hers");
    }

    #[test]
    fn phases_round_trip_through_json() {
        let p = Phase::Bob(BobPhase::SecretSeen {
            instance: inst(),
            lock: lock(),
            preimage: [7; 32],
            seen_at_tip: 1,
            seen_at_time: 2,
            attempts: 0,
        });
        let text = serde_json::to_string(&p).unwrap();
        assert!(text.contains("\"role\":\"bob\""));
        assert!(text.contains("\"phase\":\"secret_seen\""));
        assert!(text.contains("\"preimage\":\"0x0707"));
        assert_eq!(serde_json::from_str::<Phase>(&text).unwrap(), p);
    }

    fn bob_claim_included() -> Phase {
        let mut p = Phase::Bob(BobPhase::Received);
        for e in [
            Event::NoidInstanceSeen { instance: inst(), tip: 10 },
            Event::NoidFundingFinal { tip: 27 },
            Event::LockSubmitted { t_reveal: 1_000_000, amount_wei: 1, tx_hash: None, at: 3 },
            Event::EthLockSeen { lock: lock() },
            Event::EthPreimageSeen { preimage: [7; 32], tip: 40, time: 4 },
            Event::ClaimSubmitted { txid: "c1".into(), call_height: 41 },
            Event::NoidTxIncluded { txid: "c1".into(), height: 42 },
        ] {
            p = transition(&p, &e).unwrap();
        }
        p
    }

    #[test]
    fn f6_bob_claim_included_carries_the_secret_and_goes_back_on_a_reorg() {
        let p = bob_claim_included();
        assert!(matches!(&p, Phase::Bob(BobPhase::ClaimIncluded { preimage: Some(x), attempts: 1, height: 42, .. }) if *x == [7; 32]));
        // Still in the mempool: back to claim_submitted, same txid, same attempts.
        let reorg = |pending| Event::NoidTxReorged { txid: "C1".into(), was_height: 42, still_pending: pending, preimage: None };
        let back = transition(&p, &reorg(true)).unwrap();
        assert!(matches!(&back, Phase::Bob(BobPhase::ClaimSubmitted { txid, attempts: 1, preimage, .. }) if txid == "c1" && *preimage == [7; 32]));
        // Gone: secret_seen, attempts kept, the secret kept.
        let gone = transition(&p, &reorg(false)).unwrap();
        assert!(matches!(&gone, Phase::Bob(BobPhase::SecretSeen { attempts: 1, preimage, .. }) if *preimage == [7; 32]));
        // Another txid is not ours to rewind.
        assert!(transition(&p, &Event::NoidTxReorged { txid: "c9".into(), was_height: 42, still_pending: true, preimage: None }).is_err());
        // Re-inclusion changes only the recorded height.
        let re = transition(&p, &Event::NoidTxReincluded { txid: "c1".into(), was_height: 42, height: 55 }).unwrap();
        assert!(matches!(&re, Phase::Bob(BobPhase::ClaimIncluded { height: 55, txid, .. }) if txid == "c1"));
        // Only the included phase can be reorged.
        assert!(transition(&back, &reorg(true)).is_err());
    }

    #[test]
    fn f6_a_claim_included_from_before_f6_has_no_secret_and_needs_the_event_to_bring_it() {
        let Phase::Bob(BobPhase::ClaimIncluded { instance, lock, txid, height, .. }) = bob_claim_included() else { panic!() };
        let old = Phase::Bob(BobPhase::ClaimIncluded { instance, lock, txid, height, preimage: None, attempts: 0 });
        let reorg = |preimage| Event::NoidTxReorged { txid: "c1".into(), was_height: 42, still_pending: false, preimage };
        assert!(transition(&old, &reorg(None)).is_err());
        let back = transition(&old, &reorg(Some([7; 32]))).unwrap();
        assert!(matches!(back, Phase::Bob(BobPhase::SecretSeen { preimage, .. }) if preimage == [7; 32]));
        // A file written before F6 (no `preimage`, no `attempts` key) still loads.
        let text = r#"{"role":"bob","phase":"claim_included","instance":{"slot_index":5,"creation_id":77,"amount_micronoid":1000000},"lock":{"lock_id":"0x0101010101010101010101010101010101010101010101010101010101010101","t_reveal":1000000,"amount_wei":"10000000000000000","block_number":100,"sender":"0x0202020202020202020202020202020202020202","receiver":"0x0303030303030303030303030303030303030303"},"txid":"c1","height":42}"#;
        assert!(matches!(serde_json::from_str::<Phase>(text).unwrap(), Phase::Bob(BobPhase::ClaimIncluded { preimage: None, attempts: 0, .. })));
    }

    #[test]
    fn f6_alice_refund_included_goes_back_on_a_reorg() {
        let mut p = Phase::Alice(AlicePhase::Created);
        for e in [
            Event::NoidInstanceSeen { instance: inst(), tip: 10 },
            Event::NoidFundingFinal { tip: 27 },
            Event::NoidRefundSubmitted { txid: Some("bb".into()), call_height: 800 },
            Event::NoidTxIncluded { txid: "bb".into(), height: 801 },
        ] {
            p = transition(&p, &e).unwrap();
        }
        let reorg = |pending| Event::NoidTxReorged { txid: "bb".into(), was_height: 801, still_pending: pending, preimage: None };
        let back = transition(&p, &reorg(true)).unwrap();
        assert!(matches!(&back, Phase::Alice(AlicePhase::RefundSubmitted { txid: Some(t), .. }) if t == "bb"));
        let gone = transition(&p, &reorg(false)).unwrap();
        assert!(matches!(gone, Phase::Alice(AlicePhase::FundingFinal { .. })));
        let re = transition(&p, &Event::NoidTxReincluded { txid: "bb".into(), was_height: 801, height: 810 }).unwrap();
        assert!(matches!(re, Phase::Alice(AlicePhase::RefundIncluded { height: 810, .. })));
    }

    #[test]
    fn m25d_an_external_close_is_recorded_only_where_it_makes_sense() {
        let close = Event::NoidClosedExternally { txid: "ee".into(), height: 900 };
        // Alice: from any phase that holds the NOID and has not revealed.
        for steps in [
            vec![Event::NoidInstanceSeen { instance: inst(), tip: 10 }],
            vec![Event::NoidInstanceSeen { instance: inst(), tip: 10 }, Event::NoidFundingFinal { tip: 27 }],
            vec![
                Event::NoidInstanceSeen { instance: inst(), tip: 10 },
                Event::NoidFundingFinal { tip: 27 },
                Event::EthLockSeen { lock: lock() },
                Event::EthLockFinal,
            ],
        ] {
            let mut p = Phase::Alice(AlicePhase::Created);
            for e in steps {
                p = transition(&p, &e).unwrap();
            }
            assert!(matches!(transition(&p, &close).unwrap(), Phase::Alice(AlicePhase::RefundIncluded { height: 900, .. })));
        }
        assert!(transition(&Phase::Alice(AlicePhase::Created), &close).is_err());
        assert!(transition(&Phase::Alice(AlicePhase::Refunded { txid: "x".into(), height: 1 }), &close).is_err());
        // Bob: from secret_seen (and claim_submitted), never before he knows the secret.
        let Phase::Bob(BobPhase::ClaimIncluded { instance, lock, .. }) = bob_claim_included() else { panic!() };
        let seen = Phase::Bob(BobPhase::SecretSeen { instance, lock, preimage: [7; 32], seen_at_tip: 1, seen_at_time: 2, attempts: 0 });
        assert!(matches!(
            transition(&seen, &close).unwrap(),
            Phase::Bob(BobPhase::ClaimIncluded { height: 900, preimage: Some(_), .. })
        ));
        assert!(transition(&Phase::Bob(BobPhase::Received), &close).is_err());
    }

    fn alice_revealed() -> Phase {
        let mut p = Phase::Alice(AlicePhase::Created);
        for e in [
            Event::NoidInstanceSeen { instance: inst(), tip: 10 },
            Event::NoidFundingFinal { tip: 27 },
            Event::EthLockSeen { lock: lock() },
            Event::EthLockFinal,
            Event::RevealSubmitted { tx_hash: None, at: 5 },
        ] {
            p = transition(&p, &e).unwrap();
        }
        p
    }

    #[test]
    fn f9_alice_can_refund_the_noid_from_every_phase_after_the_reveal() {
        let refund = Event::NoidRefundSubmitted { txid: Some("bb".into()), call_height: 800 };
        let sub = alice_revealed();
        let rev = transition(&sub, &Event::EthClaimMined { block_number: 120 }).unwrap();
        let done = transition(&rev, &Event::EthClaimFinal).unwrap();
        assert!(matches!(&done, Phase::Alice(AlicePhase::Done { instance: Some(i), .. }) if *i == inst()));
        for from in [sub, rev, done] {
            let name = from.name();
            let p = transition(&from, &refund).unwrap_or_else(|e| panic!("{name}: {e}"));
            assert!(matches!(&p, Phase::Alice(AlicePhase::RefundSubmitted { instance, .. }) if *instance == inst()), "{name}");
            let p = transition(&p, &Event::NoidTxIncluded { txid: "bb".into(), height: 801 }).unwrap();
            let p = transition(&p, &Event::NoidTxFinal { tip: 818 }).unwrap();
            assert_eq!(p, Phase::Alice(AlicePhase::Refunded { txid: "bb".into(), height: 801 }), "{name}");
            // A close made with the wallet CLI is recorded the same way.
            let q = transition(&from, &Event::NoidClosedExternally { txid: "ee".into(), height: 900 }).unwrap();
            assert!(matches!(q, Phase::Alice(AlicePhase::RefundIncluded { height: 900, .. })), "{name}");
        }
    }

    #[test]
    fn f9_a_done_file_from_before_f9_has_no_instance_and_learns_it_from_the_node() {
        let text = r#"{"role":"alice","phase":"done","lock":{"lock_id":"0x0101010101010101010101010101010101010101010101010101010101010101","t_reveal":1000000,"amount_wei":"10000000000000000","block_number":100,"sender":"0x0202020202020202020202020202020202020202","receiver":"0x0303030303030303030303030303030303030303"},"block_number":120}"#;
        let old: Phase = serde_json::from_str(text).unwrap();
        assert!(matches!(&old, Phase::Alice(AlicePhase::Done { instance: None, .. })));
        // It cannot refund what it does not know ...
        assert!(transition(&old, &Event::NoidRefundSubmitted { txid: None, call_height: 800 }).is_err());
        assert!(transition(&old, &Event::NoidClosedExternally { txid: "ee".into(), height: 900 }).is_err());
        // ... until the instance is seen.
        let filled = transition(&old, &Event::NoidInstanceSeen { instance: inst(), tip: 700 }).unwrap();
        assert!(matches!(&filled, Phase::Alice(AlicePhase::Done { instance: Some(_), .. })));
        assert!(transition(&filled, &Event::NoidRefundSubmitted { txid: None, call_height: 800 }).is_ok());
        // A bob file from before F9 has no lock in `done`.
        let bob_old = r#"{"role":"bob","phase":"done","txid":"c1","height":42}"#;
        assert!(matches!(serde_json::from_str::<Phase>(bob_old).unwrap(), Phase::Bob(BobPhase::Done { lock: None, .. })));
    }

    #[test]
    fn f9_bob_records_an_eth_refund_after_the_secret_without_moving_the_claim() {
        let seen = Phase::Bob(match bob_claim_included() {
            Phase::Bob(BobPhase::ClaimIncluded { instance, lock, .. }) => {
                BobPhase::SecretSeen { instance, lock, preimage: [7; 32], seen_at_tip: 1, seen_at_time: 2, attempts: 0 }
            }
            other => panic!("{other:?}"),
        });
        let claim_sub = transition(&seen, &Event::ClaimSubmitted { txid: "c1".into(), call_height: 41 }).unwrap();
        let claim_inc = transition(&claim_sub, &Event::NoidTxIncluded { txid: "c1".into(), height: 42 }).unwrap();
        let done = transition(&claim_inc, &Event::NoidTxFinal { tip: 60 }).unwrap();
        assert!(matches!(&done, Phase::Bob(BobPhase::Done { lock: Some(_), .. })));
        for from in [seen, claim_sub, claim_inc, done] {
            let name = from.name();
            for e in [Event::EthRefundSubmitted { tx_hash: None, at: 1_000_001 }, Event::EthRefundMined { block_number: 200 }] {
                assert_eq!(transition(&from, &e).unwrap(), from, "{name} {}", e.name());
            }
        }
        // Before the secret is known the old rule stands: a refund moves the phase.
        let locked = Phase::Bob(BobPhase::Locked { instance: inst(), lock: lock() });
        assert!(matches!(
            transition(&locked, &Event::EthRefundSubmitted { tx_hash: None, at: 1 }).unwrap(),
            Phase::Bob(BobPhase::RefundSubmitted { .. })
        ));
    }
}
