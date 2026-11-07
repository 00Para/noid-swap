//! The automatic actions (M2.5): from (role, swap file, the two observations,
//! the clock) decide which chain facts to record and which single action to
//! perform next. The gates of `params` are applied here and nowhere else.
//!
//! Plain words: every *tick*, the engine looks at what the watchers saw,
//! records the facts that move the swap forward (funding seen, lock final,
//! secret seen, ...), and then picks one action: fund, lock, reveal, claim,
//! refund, wait or abort. `decide` is a pure function so the scenario tests
//! can drive it with scripted observations. `Runner` adds persistence: the
//! swap file is saved after the facts and again with the action recorded as
//! *pending* before the action is executed, so a crash in between can be told
//! apart from "never tried" on restart (M2.3).
//!
//! Fail closed (REVIEW-1 M2). Every field of an observation that a spending
//! action's gate reads must be *known*; an `Option` that is `None` is "the poll
//! could not tell", never a pass. `decide` therefore ends with one choke point,
//! `spend_blocker`: when an action that spends or commits (`fund_noid`,
//! `lock_eth`, `reveal_eth`, `claim_noid`, `refund_eth`, `refund_noid`) reads a
//! field that is `None`, or an observation it reads is older than
//! `MAX_OBSERVATION_AGE_S` (120 s) relative to `now`, the action becomes
//! `Wait { reason: "<field> unknown" }` (or "... observation stale ...") and a
//! note says why. Never an action, never an abort. Waiting, tracking and abort
//! decisions are left as they were.
//!
//! REVIEW-2 F5 adds a second choke point behind it, `f5_gate`: the chain's own age (the Parano1d tip header time, the
//! Ethereum head time) and, before Bob locks and before Alice reveals, the agreement of a second independent node.
//!
//! Design references: section 2.2 steps 6-13, section 2.3/2.4 abort paths,
//! section 4.2 (I1)-(I5), section 8 T2/T3/T6/T11.

use std::fmt;
use std::path::PathBuf;

use serde::{Deserialize, Serialize};

use serde_json::Value;

use crate::params::{self, ClaimHeight, ContractVersion, RotationGuard};
use crate::secret::check_preimage;
use crate::state::{transition, AlicePhase, BobPhase, Event, InvalidTransition, LockSummary, Phase, Role};
use crate::swapfile::{PendingAction, PendingIntent, SwapFile, SwapFileError};
use crate::watch::eth::compute_lock_id;
use crate::watch::{hexbytes, u128dec, EthLock, EthObservation, NoidInstance, NoidInstanceStatus, NoidObservation};

// ---------------------------------------------------------------- actions

/// The one thing the engine wants done now.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "action", rename_all = "snake_case")]
pub enum Action {
    /// Nothing to do; `reason` says what is awaited.
    Wait { reason: String },
    /// Alice: `contract fund` with the stock wallet (design step 6).
    FundNoid { amount_micronoid: u64 },
    /// Alice: broadcast `HTLC.claim(lockId, secret)`: the reveal (step 10, gated by (I2)).
    RevealEth {
        #[serde(with = "hexbytes")]
        lock_id: [u8; 32],
    },
    /// Alice: recovery close at `h >= D` (section 2.3).
    RefundNoid { call_height: u64, fee_micronoid: u64 },
    /// Bob: `HTLC.newLock{value}(hashlock, t_reveal, receiver)` (step 8, gated by (I1)).
    LockEth {
        #[serde(with = "hexbytes")]
        hashlock: [u8; 32],
        t_reveal: u64,
        #[serde(with = "hexbytes")]
        receiver: [u8; 20],
        #[serde(with = "u128dec")]
        amount_wei: u128,
    },
    /// Bob: prove and submit the close at `call_height` with the revealed secret (step 12).
    ClaimNoid {
        call_height: u64,
        fee_micronoid: u64,
        #[serde(with = "hexbytes")]
        preimage: [u8; 32],
    },
    /// Bob: `HTLC.refund(lockId)` at `block.timestamp >= T_reveal` (section 2.3).
    RefundEth {
        #[serde(with = "hexbytes")]
        lock_id: [u8; 32],
    },
    /// Stop: nothing of ours is at risk on chain, or nothing can be done any more.
    Abort { reason: String },
}

impl Action {
    pub fn kind(&self) -> &'static str {
        match self {
            Action::Wait { .. } => "wait",
            Action::FundNoid { .. } => "fund_noid",
            Action::RevealEth { .. } => "reveal_eth",
            Action::RefundNoid { .. } => "refund_noid",
            Action::LockEth { .. } => "lock_eth",
            Action::ClaimNoid { .. } => "claim_noid",
            Action::RefundEth { .. } => "refund_eth",
            Action::Abort { .. } => "abort",
        }
    }

    /// True for actions that send something to a chain.
    pub fn has_side_effect(&self) -> bool {
        !matches!(self, Action::Wait { .. } | Action::Abort { .. })
    }
}

/// The result of one `decide`: facts to record, then the action.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Decision {
    pub events: Vec<Event>,
    pub action: Action,
    /// Human-readable remarks (checks that failed, warnings).
    pub notes: Vec<String>,
}

/// Close fee for Bob's claim or Alice's refund under contract v1 (see [`close_fee_for`] for v2): the live relay minimum, never
/// below the consensus minimum, capped by the contract's `max_fee`. The `unwrap_or`
/// defaults are only a last resort: `spend_blocker` refuses `claim_noid` and
/// `refund_noid` unless both the estimate and the floor are known.
pub fn close_fee(noid: &NoidObservation, max_fee: u64) -> u64 {
    noid.fee_estimate_1_1
        .unwrap_or(params::MIN_CLOSE_FEE)
        .max(noid.fee_floor.unwrap_or(0))
        .max(params::MIN_CLOSE_FEE)
        .min(max_fee)
}

/// [`close_fee`] by contract version. v1: the clamped live estimate (above). v2 (`HashTimeLockV2`): every close
/// pays EXACTLY `max_fee` (the program asserts `fee == max_fee`; the policy ceiling rejects anything above), so the
/// live estimate and floor do not choose the fee. The `>= MIN_CLOSE_FEE` rule and the 1 % cap are enforced when
/// the swap file is built and checked (`SwapPublic::check`), not here: a `max_fee` below the minimum close fee
/// cannot exist in a checked file, and clamping it up would only produce a fee the contract rejects.
pub fn close_fee_for(version: ContractVersion, noid: &NoidObservation, max_fee: u64) -> u64 {
    match version {
        ContractVersion::V1 => close_fee(noid, max_fee),
        ContractVersion::V2 => max_fee,
    }
}

/// The conservative clock for Ethereum timestamps: the later of our clock and
/// the latest block's timestamp.
fn eth_now(eth: &EthObservation, now: u64) -> u64 {
    now.max(eth.latest_timestamp)
}

fn summary(lock: &EthLock) -> LockSummary {
    LockSummary {
        lock_id: lock.lock_id,
        t_reveal: lock.timelock,
        amount_wei: lock.amount_wei,
        block_number: lock.block_number,
        sender: lock.sender,
        receiver: lock.receiver,
    }
}

/// The checks both parties apply to a `Locked` event before trusting it
/// (design step 9 items 1-3, T11, T17). `want_t_reveal` pins Bob's own choice.
fn lock_matches(file: &SwapFile, eth: &EthObservation, lock: &EthLock, want_t_reveal: Option<u64>) -> Result<(), String> {
    let p = &file.public.params.eth;
    // REVIEW-2 F1: both must be known AND equal to the pinned values; no pin, no lock.
    match eth.chain_id {
        Some(id) if id == p.chain_id => {}
        Some(id) => return Err(format!("node is on chain {id}, the swap is on {}", p.chain_id)),
        None => return Err("eth.chain_id unknown".into()),
    }
    match (p.code_hash, eth.contract_code_hash) {
        (Some(pinned), Some(seen)) if pinned == seen => {}
        (Some(_), Some(_)) => return Err("contract code hash differs from the pinned one (T17)".into()),
        (None, _) => return Err("no HTLC code hash is pinned in the swap file (T17)".into()),
        (_, None) => return Err("eth.contract_code_hash unknown".into()),
    }
    if lock.hashlock != file.public.hashlock {
        return Err("hashlock differs".into());
    }
    if lock.receiver != p.alice_receiver {
        return Err("receiver is not A_eth".into());
    }
    if lock.sender != p.bob_sender {
        return Err("sender is not B_eth".into());
    }
    if lock.amount_wei != p.amount_wei {
        return Err(format!("amount {} wei != agreed {}", lock.amount_wei, p.amount_wei));
    }
    if let Some(t) = want_t_reveal {
        if lock.timelock != t {
            return Err(format!("timelock {} != the T_reveal we chose {t}", lock.timelock));
        }
    }
    let id = compute_lock_id(&lock.sender, &lock.receiver, lock.amount_wei, &lock.hashlock, lock.timelock);
    if id != lock.lock_id {
        return Err("lockId does not recompute".into());
    }
    if lock.receiver_is_eoa == Some(false) {
        return Err("receiver is a contract (T11: EOAs only)".into());
    }
    if lock.sender_is_eoa == Some(false) {
        return Err("sender is a contract (T11: EOAs only)".into());
    }
    Ok(())
}

/// The preimage first seen for THIS lock (pending calldata beats the mined event).
fn preimage_for(eth: &EthObservation, lock_id: [u8; 32]) -> Option<[u8; 32]> {
    preimage_candidates(eth, lock_id).first().copied()
}

/// Every preimage visible for THIS lock, the primary node's first (pending calldata before the mined event), then the second node's
/// (REVIEW-4 R4-8: a second node, when there is one, is read for the secret too, so one lagging or silent node cannot keep it from Bob).
/// The caller checks each one against `H` and `A`; a wrong one from either node never hides a right one from the other.
fn preimage_candidates(eth: &EthObservation, lock_id: [u8; 32]) -> Vec<[u8; 32]> {
    let one = |e: &EthObservation| {
        e.pending_preimage
            .as_ref()
            .filter(|p| p.lock_id == lock_id)
            .map(|p| p.preimage)
            .into_iter()
            .chain(e.claimed.as_ref().filter(|c| c.lock_id == lock_id).map(|c| c.preimage))
            .collect::<Vec<_>>()
    };
    let mut all = one(eth);
    if let Some(second) = eth.second.as_deref() {
        for p in one(second) {
            if !all.contains(&p) {
                all.push(p);
            }
        }
    }
    all
}

/// Why no instance at our root was accepted (REVIEW-2 F10).
#[derive(Clone, Debug, PartialEq, Eq)]
enum InstanceProblem {
    /// More than one instance fits the agreement: the engine does not pick one (Bob does not lock on a guess).
    Ambiguous(String),
    /// The instance there is not the agreed one (absent, other amount, other opening).
    Rejected(String),
}

impl fmt::Display for InstanceProblem {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            InstanceProblem::Ambiguous(s) | InstanceProblem::Rejected(s) => f.write_str(s),
        }
    }
}

/// An instance that fits the agreement: it matches the opening (or the node did not say it does not) and holds the
/// agreed amount.
fn instance_fits(file: &SwapFile, v: &NoidInstanceStatus) -> bool {
    v.matches_opening != Some(false) && v.instance.amount_micronoid == file.public.params.amount_micronoid
}

fn describe_instances(all: &[NoidInstanceStatus], mark: Option<&NoidInstance>) -> String {
    all.iter()
        .map(|v| {
            format!(
                "slot {} (creation {}, {} micro-NOID{}{})",
                v.instance.slot_index,
                v.instance.creation_id,
                group_thousands(v.instance.amount_micronoid),
                if v.matches_opening == Some(false) { ", does not match the opening" } else { "" },
                if mark.is_some_and(|m| m.slot_index == v.instance.slot_index && m.creation_id == v.instance.creation_id) { ", the one in use" } else { "" }
            )
        })
        .collect::<Vec<_>>()
        .join("; ")
}

/// REVIEW-2 F10: the observation as the engine reads it. When several instances sit at our root and EXACTLY ONE fits
/// the agreement, that one becomes the `instance` / `instance_matches_opening` / `active_authority` every later check
/// reads (a dust instance in a lower slot must not hide it). With none or several fitting, the observation is left as
/// it is and [`instance_ok`] says which of the two it is.
fn canonical_noid(file: &SwapFile, noid: &NoidObservation) -> Option<NoidObservation> {
    let all = noid.all_instances();
    if all.len() < 2 {
        return None;
    }
    let mut fitting = all.iter().filter(|v| instance_fits(file, v));
    let (Some(v), None) = (fitting.next(), fitting.next()) else { return None };
    if noid.instance.as_ref() == Some(&v.instance) {
        return None;
    }
    let mut n = noid.clone();
    n.instance = Some(v.instance.clone());
    n.instance_matches_opening = v.matches_opening;
    n.active_authority = v.active_authority.clone();
    Some(n)
}

fn instance_ok(file: &SwapFile, noid: &NoidObservation) -> Result<(), InstanceProblem> {
    let all = noid.all_instances();
    if all.iter().filter(|v| instance_fits(file, v)).count() > 1 {
        return Err(InstanceProblem::Ambiguous(format!(
            "{} instances at our contract root fit the agreement and the tool will not guess which one is the lock's: {}",
            all.iter().filter(|v| instance_fits(file, v)).count(),
            describe_instances(&all, None)
        )));
    }
    let inst = noid.instance.as_ref().ok_or_else(|| InstanceProblem::Rejected("no instance".into()))?;
    if noid.instance_matches_opening == Some(false) {
        return Err(InstanceProblem::Rejected("instance does not match the opening".into()));
    }
    if inst.amount_micronoid != file.public.params.amount_micronoid {
        return Err(InstanceProblem::Rejected(format!(
            "instance holds {} micro-NOID, agreed {}",
            inst.amount_micronoid, file.public.params.amount_micronoid
        )));
    }
    Ok(())
}

/// The instance this swap file recorded is no longer at our root (REVIEW-2 F10: judged by slot AND incarnation, so a
/// dust instance or a re-funded slot never makes a closed instance look alive). A file that has recorded none: no
/// instance at all is listed.
fn our_instance_gone(file: &SwapFile, noid: &NoidObservation) -> bool {
    instance_gone_in(&file.phase, noid)
}

/// [`our_instance_gone`] for a phase that is not (yet) the file's: `decide` judges the phase its events lead to.
fn instance_gone_in(phase: &Phase, noid: &NoidObservation) -> bool {
    let recorded = match phase {
        Phase::Alice(p) => p.instance(),
        Phase::Bob(p) => p.instance(),
    };
    match recorded {
        Some(i) => noid.find_instance(i).is_none(),
        None => noid.all_instances().is_empty(),
    }
}

/// CHAOS F-5: how long a submitted Ethereum transaction (lock, reveal, refund) may stay unseen before it is looked at as possibly
/// dropped: 10 minutes, fifty Ethereum blocks. Together with the nonce rule below, never the clock alone.
pub const ETH_TX_GRACE_S: u64 = params::PRODUCTION.tx_grace_s;

/// REVIEW-4 R4-11: the drop grace of the profile this file runs under ([`ETH_TX_GRACE_S`] is the production value).
fn tx_grace(file: &SwapFile) -> u64 {
    file.public.params.profile.gates().tx_grace_s
}

/// CHAOS F-5: is the transaction submitted at `since` gone? Only when ALL hold: the grace period has passed, the Ethereum
/// observation is fresh, and the signer's pending nonce equals (is not above) its latest nonce, i.e. no transaction of the signer
/// sits in the node's mempool and none can still land. The same rule `intent --cancel` applies before it lets a second send out.
/// Unknown nonces are never "dropped". The caller has already checked that the effect is not visible on chain.
fn eth_tx_dropped(eth: &EthObservation, since: u64, now: u64, grace: u64, what: &str, notes: &mut Vec<String>) -> bool {
    if now.saturating_sub(since) < grace {
        return false;
    }
    if eth.observed_at.is_none_or(|t| t.abs_diff(now) > MAX_OBSERVATION_AGE_S) {
        return false;
    }
    match (eth.signer_nonce_latest, eth.signer_nonce_pending) {
        (Some(latest), Some(pending)) if pending <= latest => {
            notes.push(format!(
                "the {what} sent at {since} is not on chain and the signer has nothing pending (nonce {latest}) after {} s: it was dropped or replaced; the action is offered again (CHAOS F-5)",
                now.saturating_sub(since)
            ));
            true
        }
        (Some(_), Some(_)) => false,
        (latest, pending) => {
            notes.push(format!(
                "the {what} sent at {since} is not on chain, but the signer's nonces are unknown (latest {latest:?}, pending {pending:?}): cannot tell a dropped transaction from a slow one"
            ));
            false
        }
    }
}

/// Position of the last history entry named `event` (`None` if there is none).
fn last_history(file: &SwapFile, event: &str) -> Option<usize> {
    file.history.iter().rposition(|h| h.event == event)
}

/// First four bytes of a lock id, for notes.
fn short_id(id: &[u8; 32]) -> String {
    format!("0x{}..", hex::encode(&id[..4]))
}

fn describe_locks(locks: &[EthLock], mark: Option<&[u8; 32]>) -> String {
    locks
        .iter()
        .map(|l| {
            format!(
                "{} ({} wei, T_reveal {}, {}{})",
                short_id(&l.lock_id),
                l.amount_wei,
                l.timelock,
                if l.claimed { "claimed" } else if l.refunded { "refunded" } else { "open" },
                if mark == Some(&l.lock_id) { ", the one in use" } else { "" }
            )
        })
        .collect::<Vec<_>>()
        .join("; ")
}

// ---------------------------------------------------------------- decide

/// Pure decision: derive the chain facts for the current phase, then choose
/// the next action from the phase those facts lead to. `now` is the caller's
/// Unix clock; each observation carries `observed_at` from the same clock.
///
/// Fail closed: an action that spends or commits is returned only if every
/// observation field its gate reads is known and the observations it reads are
/// at most `MAX_OBSERVATION_AGE_S` old; otherwise the result is
/// `Wait { reason: "<field> unknown" }` (or a staleness reason) plus a note.
/// See `spend_blocker` for the field list.
pub fn decide(file: &SwapFile, noid: &NoidObservation, eth: &EthObservation, now: u64) -> Decision {
    let mut notes = Vec::new();
    // REVIEW-2 F10: with several instances at the root, exactly one of which fits, every check reads that one.
    let canonical = canonical_noid(file, noid);
    let noid = canonical.as_ref().unwrap_or(noid);
    let mut phase = file.phase.clone();
    let mut events = Vec::new();
    // Each derived fact advances the phase; the derivation functions never
    // return a fact twice for the same observations, so this loop ends.
    for _ in 0..16 {
        let next = match &phase {
            Phase::Alice(p) => alice_fact(file, p, noid, eth, now, &mut notes),
            Phase::Bob(p) => bob_fact(file, p, noid, eth, now, &mut notes),
        };
        match next {
            Some(e) => match transition(&phase, &e) {
                Ok(np) => {
                    phase = np;
                    events.push(e);
                }
                Err(err) => {
                    notes.push(format!("internal: {err}"));
                    break;
                }
            },
            None => break,
        }
    }
    // Alice only: a log-only fact that does not move her phase, so it is taken after
    // the loop (the loop would offer it again) and keyed on the history (once only).
    if let Phase::Alice(p) = &phase {
        if let Some(e) = alice_refund_seen(file, p, eth, &mut notes) {
            match transition(&phase, &e) {
                Ok(np) => {
                    phase = np;
                    events.push(e);
                }
                Err(err) => notes.push(format!("internal: {err}")),
            }
        }
    }
    // Alice only (CHAOS F-17): the instance was alive when Bob could no longer claim it.
    if let Phase::Alice(p) = &phase {
        if let Some(e) = alice_alive_at_d(file, p, noid) {
            match transition(&phase, &e) {
                Ok(np) => {
                    phase = np;
                    events.push(e);
                }
                Err(err) => notes.push(format!("internal: {err}")),
            }
        }
    }
    // Bob only (REVIEW-2 F9): the same kind of log-only fact for his ETH refund after the secret is known.
    if let Phase::Bob(p) = &phase {
        if let Some(e) = bob_refund_seen(file, p, eth) {
            match transition(&phase, &e) {
                Ok(np) => {
                    phase = np;
                    events.push(e);
                }
                Err(err) => notes.push(format!("internal: {err}")),
            }
        }
    }
    // Bob only (CHAOS F-5): after the secret, an ETH refund he submitted that never landed is not waited for for ever.
    if let Phase::Bob(p) = &phase {
        if let Some(e) = bob_refund_dropped(file, p, eth, now, &mut notes) {
            match transition(&phase, &e) {
                Ok(np) => {
                    phase = np;
                    events.push(e);
                }
                Err(err) => notes.push(format!("internal: {err}")),
            }
        }
    }
    let action = match &phase {
        Phase::Alice(p) => alice_action(file, p, noid, eth, now, &mut notes),
        Phase::Bob(p) => bob_action(file, p, noid, eth, now, &mut notes),
    };
    // CHAOS F-4: a recovery close of an instance that is not at the contract is not offered, on either path (the node would only
    // refuse it, tick after tick, until `--closed-by` is run).
    let action = match action {
        Action::RefundNoid { .. } if instance_gone_in(&phase, noid) => {
            let why = "the instance is not visible, so there is nothing to refund (already closed? verify the contract receipts)".to_string();
            notes.push(format!("not refund_noid: {why}"));
            // Review M5: another instance at the root (the funding came back as a new incarnation) is not the recorded one; name it.
            let all = noid.all_instances();
            if !all.is_empty() {
                notes.push(format!("the recorded instance is gone but {} other instance(s) sit at the contract root and are NOT refunded by this tool (refund them with the wallet): {}", all.len(), describe_instances(&all, None)));
            }
            Action::Wait { reason: why }
        }
        other => other,
    };
    // REVIEW-2 F10: several instances or several matching locks are never normal; say so, whatever the action is.
    // REVIEW-4 R4-11: also in a `done` that still has a leftover leg to refund (the refund is the action, or the leg is still listed).
    let still_acting = !phase.is_terminal() && (!phase.is_settled() || matches!(action, Action::RefundNoid { .. } | Action::RefundEth { .. }) || has_leftover_leg(&phase, noid, eth));
    if still_acting {
        extras_notes(&phase, noid, eth, &mut notes);
    }
    // Floor watch (T5/Q6, both roles, every phase where a close may still be needed): a note, never an abort.
    if still_acting {
        if let Some(floor) = noid.relay_floor.filter(|f| *f >= file.public.params.max_fee_micronoid) {
            notes.push(format!(
                "relay floor {} >= max_fee {}: a close cannot be relayed through this node (T5/Q6)",
                group_thousands(floor),
                group_thousands(file.public.params.max_fee_micronoid)
            ));
        }
    }
    // The one choke point: nothing that spends or commits leaves here on guesswork.
    let blocked = spend_blocker(file, &action, noid, eth, now).or_else(|| f5_gate(file, &action, noid, eth, now, &mut notes));
    let action = match blocked {
        Some(why) => {
            notes.push(format!("not {}: {why} (fail closed)", action.kind()));
            Action::Wait { reason: why }
        }
        None => action,
    };
    Decision { events, action, notes }
}

/// REVIEW-4 R4-11: a `done` file that still holds a leg the tool can refund: Alice's NOID instance still listed, Bob's Ethereum lock still
/// open. The relay-floor and "several instances" notes matter there too.
fn has_leftover_leg(phase: &Phase, noid: &NoidObservation, eth: &EthObservation) -> bool {
    match phase {
        Phase::Alice(AlicePhase::Done { instance: Some(i), .. }) => noid.find_instance(i).is_some(),
        Phase::Bob(BobPhase::Done { lock: Some(l), .. }) => eth.find_lock(&l.lock_id).is_some_and(|l| !l.claimed && !l.refunded),
        _ => false,
    }
}

/// 60000 as "60,000" for the notes.
fn group_thousands(n: u64) -> String {
    let digits = n.to_string();
    let mut out = String::new();
    for (i, c) in digits.chars().enumerate() {
        if i > 0 && (digits.len() - i) % 3 == 0 {
            out.push(',');
        }
        out.push(c);
    }
    out
}

/// REVIEW-2 F10: list every instance and every matching lock when there is more than one of either.
fn extras_notes(phase: &Phase, noid: &NoidObservation, eth: &EthObservation, notes: &mut Vec<String>) {
    let all = noid.all_instances();
    if all.len() > 1 {
        let mark = match phase {
            Phase::Alice(p) => p.instance(),
            Phase::Bob(p) => p.instance(),
        };
        notes.push(format!("{} instances at our contract root: {}", all.len(), describe_instances(&all, mark)));
    }
    let locks = eth.all_locks();
    if locks.len() > 1 || eth.lock_count > locks.len() {
        let mark = match phase {
            Phase::Alice(p) => p.lock().map(|l| l.lock_id),
            Phase::Bob(p) => p.lock().map(|l| l.lock_id).or_else(|| eth.lock.as_ref().map(|l| l.lock_id)),
        };
        notes.push(format!(
            "{} matching Ethereum locks (same hashlock, parties and contract): {}{}",
            eth.lock_count.max(locks.len()),
            describe_locks(&locks, mark.as_ref()),
            if eth.lock_count > locks.len() { format!(" (only the first {} were read)", locks.len()) } else { String::new() }
        ));
    }
}

/// An observation older than this (seconds, either direction, against the caller's
/// `now`) does not back a spending action. Four polls of a 30-s cadence.
pub const MAX_OBSERVATION_AGE_S: u64 = 120;

/// Why `action` may not go out on these observations, or `None` if every
/// observation field its gate reads is known and fresh.
///
/// Required, per action (`noid.*` / `eth.*` are the two observations):
///
/// - `fund_noid`: fresh noid; `noid.epoch_anchor`.
/// - `refund_noid`, `claim_noid`: fresh noid; `noid.fee_estimate_1_1`,
///   `noid.fee_floor`, `noid.epoch_anchor`.
/// - `lock_eth`: fresh noid and eth; `noid.instance_matches_opening`,
///   `noid.active_authority`, `noid.fee_estimate_1_1`, `eth.latest_timestamp`, and (REVIEW-2 F1)
///   `eth.chain_id` and `eth.contract_code_hash`, both EQUAL to the pinned values.
/// - `reveal_eth`: fresh eth; the same chain id and code hash, `eth.latest_timestamp`, and (F7) the
///   lock itself: visible (`getLock` + the `Locked` event agree), the one the action names, matching
///   the agreed terms (`lock_matches`), not claimed or refunded, finalized, `receiver_is_eoa` /
///   `sender_is_eoa` known.
/// - `refund_eth`: fresh eth; the same chain id and code hash, `eth.latest_timestamp`, and (F7) the
///   lock visible, the one the action names, and neither claimed nor refunded.
///
/// A chain id or code hash that differs from the pinned one blocks, and so does a swap file with
/// NO pinned code hash (old files): an ETH spend is never allowed on an unpinned contract.
/// `observed_at` itself must be known. `pending_calls` is a plain list that the watcher either
/// fills or fails on, so it cannot be "unknown".
fn spend_blocker(file: &SwapFile, action: &Action, noid: &NoidObservation, eth: &EthObservation, now: u64) -> Option<String> {
    let p = &file.public.params.eth;
    // (needs a fresh noid observation, needs a fresh eth observation, [(field, known)])
    let eth_common = |extra: Vec<(&'static str, bool)>| -> Vec<(&'static str, bool)> {
        let mut k = vec![
            ("eth.chain_id", eth.chain_id.is_some()),
            ("eth.contract_code_hash", eth.contract_code_hash.is_some()),
            ("eth.latest_timestamp", eth.latest_timestamp != 0),
        ];
        k.extend(extra);
        k
    };
    let (fresh_noid, fresh_eth, known): (bool, bool, Vec<(&str, bool)>) = match action {
        Action::Wait { .. } | Action::Abort { .. } => return None,
        Action::FundNoid { .. } => (true, false, vec![("noid.epoch_anchor", noid.epoch_anchor.is_some())]),
        Action::RefundNoid { .. } | Action::ClaimNoid { .. } => (
            true,
            false,
            vec![
                ("noid.fee_estimate_1_1", noid.fee_estimate_1_1.is_some()),
                ("noid.fee_floor", noid.fee_floor.is_some()),
                ("noid.epoch_anchor", noid.epoch_anchor.is_some()),
            ],
        ),
        Action::LockEth { .. } => (
            true,
            true,
            eth_common(vec![
                ("noid.instance_matches_opening", noid.instance_matches_opening.is_some()),
                ("noid.active_authority", noid.active_authority.is_some()),
                ("noid.fee_estimate_1_1", noid.fee_estimate_1_1.is_some()),
            ]),
        ),
        Action::RevealEth { lock_id } => {
            let named = eth.find_lock(lock_id);
            let mut extra = vec![("eth.lock", named.is_some())];
            if let Some(l) = &named {
                extra.push(("eth.lock.receiver_is_eoa", l.receiver_is_eoa.is_some()));
                extra.push(("eth.lock.sender_is_eoa", l.sender_is_eoa.is_some()));
            }
            (false, true, eth_common(extra))
        }
        Action::RefundEth { lock_id } => (false, true, eth_common(vec![("eth.lock (getLock + Locked event)", eth.find_lock(lock_id).is_some())])),
    };
    let stale = |which: &str, at: Option<u64>| -> Option<String> {
        match at {
            None => Some(format!("{which}.observed_at unknown")),
            Some(t) if t.abs_diff(now) > MAX_OBSERVATION_AGE_S => Some(format!(
                "{which} observation stale: taken at {t}, now {now} ({} s apart, limit {MAX_OBSERVATION_AGE_S} s)",
                t.abs_diff(now)
            )),
            Some(_) => None,
        }
    };
    if fresh_noid {
        if let Some(why) = stale("noid", noid.observed_at) {
            return Some(why);
        }
    }
    if fresh_eth {
        if let Some(why) = stale("eth", eth.observed_at) {
            return Some(why);
        }
    }
    if let Some((field, _)) = known.iter().find(|(_, ok)| !ok) {
        return Some(format!("{field} unknown"));
    }
    if matches!(action, Action::LockEth { .. } | Action::RevealEth { .. } | Action::RefundEth { .. }) {
        if let Some(id) = eth.chain_id.filter(|id| *id != p.chain_id) {
            return Some(format!("eth.chain_id {id} is not the pinned chain {}", p.chain_id));
        }
        match (p.code_hash, eth.contract_code_hash) {
            (None, _) => return Some("no HTLC code hash is pinned in the swap file: no ETH spend on an unpinned contract (T17)".into()),
            (Some(pinned), Some(seen)) if pinned != seen => {
                return Some("eth.contract_code_hash differs from the pinned one (T17)".into());
            }
            _ => {}
        }
    }
    // F7: the lock the action names must be visible in this very observation.
    if let Action::RevealEth { lock_id } | Action::RefundEth { lock_id } = action {
        let Some(lock) = eth.find_lock(lock_id) else {
            return Some("the lock this action names is not visible in the observation".into());
        };
        if lock.claimed || lock.refunded {
            return Some(format!("the lock is already {}", if lock.claimed { "claimed" } else { "refunded" }));
        }
        if matches!(action, Action::RevealEth { .. }) {
            if let Err(e) = lock_matches(file, eth, &lock, None) {
                return Some(format!("the lock does not match the agreed terms: {e}"));
            }
            if !eth.lock_finalized_id(lock_id) {
                return Some("the lock is not finalized".into());
            }
        }
    }
    None
}

// ---------------------------------------------------------------- REVIEW-2 F5: lag, lies and a single source

/// A Parano1d tip block whose own timestamp trails our clock by more than this (3 x the 30-s target interval) means the
/// node is behind, however quickly it answered. Seconds.
/// 10 x `TAU_NOM_S` = 300 s, not the review's "about 3 x": measured on the real node on 2026-11-05 04:15 UTC, 40 consecutive
/// blocks had a mean gap of 28 s but a maximum of 180 s (2 of 40 above 90 s), and the tip header trailed the clock by
/// 108 s and 171 s at two random readings of a healthy node. 300 s still catches a node about ten blocks behind.
pub const MAX_NOID_TIP_LAG_S: u64 = 10 * params::TAU_NOM_S;
/// An Ethereum `latest` block whose timestamp trails our clock by more than this means the node is behind (Sepolia and
/// mainnet blocks are 12 s apart; 10 minutes is generous). Seconds.
pub const MAX_ETH_HEAD_LAG_S: u64 = 600;
/// Two Parano1d nodes must report tips at most this many blocks apart before Bob locks.
pub const MAX_NOID_TIP_DIFF: u64 = 2;
/// Two Ethereum nodes must report `finalized` heights at most this many blocks apart (two epochs) before Alice reveals.
pub const MAX_ETH_FINALIZED_DIFF: u64 = 64;

/// How far the tip block's timestamp trails the clock, in seconds (0 if it is not behind).
pub fn noid_tip_lag_s(tip_time: u64, now: u64) -> u64 {
    now.saturating_sub(tip_time)
}

/// `Some(reason)` if the Parano1d tip header says the node lags (known and more than [`MAX_NOID_TIP_LAG_S`] behind) or
/// if it says nothing: REVIEW-3 F5, an unknown header time fails closed. A node that serves a frozen tip and fails
/// `paranoid_getBlockHeader` must not pass the lag rule by silence.
pub fn noid_tip_time_blocker(tip_time: Option<u64>, now: u64) -> Option<String> {
    let Some(tip_time) = tip_time else {
        return Some(
            "noid tip header time unknown: the node did not answer paranoid_getBlockHeader, so its lag cannot be told from the poll; \
             use a node that answers it (F5). A recording made before F5 has no header time and shows this blocker instead of a spend"
                .to_string(),
        );
    };
    let lag = noid_tip_lag_s(tip_time, now);
    (lag > MAX_NOID_TIP_LAG_S).then(|| format!("noid tip header time trails the clock by {lag} s (limit {MAX_NOID_TIP_LAG_S} s): the node lags (F5)"))
}

/// `Some(reason)` if the Ethereum head block is more than [`MAX_ETH_HEAD_LAG_S`] behind the clock.
pub fn eth_head_time_blocker(latest_timestamp: u64, now: u64) -> Option<String> {
    let lag = now.saturating_sub(latest_timestamp);
    (lag > MAX_ETH_HEAD_LAG_S).then(|| format!("eth latest block time trails the clock by {lag} s (limit {MAX_ETH_HEAD_LAG_S} s): the node lags (F5)"))
}

/// REVIEW-4 R4-8: is any Ethereum node Bob watches for the secret behind the clock? `Some(why)` for the first node, and for the second
/// one when there is one; the limit is [`MAX_ETH_HEAD_LAG_S`], the one `lock_eth` and `reveal_eth` apply. Not under `rehearsal` (a local
/// automine chain makes no blocks while idle). A head time the node did not report counts as lagging.
fn eth_lag_alarm(file: &SwapFile, eth: &EthObservation, now: u64) -> Option<String> {
    if file.public.params.profile == params::ProfileName::Rehearsal {
        return None;
    }
    let one = |label: &str, e: &EthObservation| -> Option<String> {
        if e.latest_timestamp == 0 {
            return Some(format!("{label}: no head block time reported"));
        }
        eth_head_time_blocker(e.latest_timestamp, now).map(|why| format!("{label}: {why}"))
    };
    let mut parts: Vec<String> = Vec::new();
    parts.extend(one("first Ethereum node", eth));
    if let Some(second) = eth.second.as_deref() {
        parts.extend(one("second Ethereum node", second));
    }
    (!parts.is_empty()).then(|| parts.join("; "))
}

fn describe_instance_opt(v: Option<&NoidInstance>) -> String {
    match v {
        Some(i) => format!("slot {} creation {} amount {}", i.slot_index, i.creation_id, i.amount_micronoid),
        None => "no instance".to_string(),
    }
}

/// Either a second node's observation, or why there is none: the single-node rule of REVIEW-2 F5.
/// `second_error` is a configured second node that could not be read.
fn second_node_policy<'a, T>(
    file: &SwapFile,
    second: Option<&'a T>,
    second_error: Option<&str>,
    single_node_ok: bool,
    notes: &mut Vec<String>,
) -> Result<Option<&'a T>, String> {
    if let Some(s) = second {
        return Ok(Some(s));
    }
    if let Some(e) = second_error {
        return Err(format!("the second node could not be read ({e}): it must agree before this step (F5)"));
    }
    // REVIEW-3 F5: `sepolia` follows the production rule (a stranger's swap there has real value on the NOID side).
    if file.public.params.profile.requires_second_node() && !single_node_ok {
        return Err("a second node is required before this step (F5); pass --noid-rpc / --eth-rpc twice, or --single-node-ok to accept the risk".into());
    }
    notes.push("single node: F5 cross-check not possible".to_string());
    Ok(None)
}

fn second_stale(which: &str, at: Option<u64>, now: u64) -> Option<String> {
    match at {
        None => Some(format!("{which}.observed_at unknown")),
        Some(t) if t.abs_diff(now) > MAX_OBSERVATION_AGE_S => Some(format!(
            "{which} observation stale: taken at {t}, now {now} ({} s apart, limit {MAX_OBSERVATION_AGE_S} s)",
            t.abs_diff(now)
        )),
        Some(_) => None,
    }
}

/// Bob's `lock_eth` against the second Parano1d node: the same instance (slot, creation id, amount) and tips within
/// [`MAX_NOID_TIP_DIFF`] blocks. `Err` carries both nodes' answers (nothing secret is in them).
fn noid_nodes_agree(file: &SwapFile, noid: &NoidObservation, second: &NoidObservation, now: u64) -> Result<(), String> {
    if let Some(why) = second_stale("noid (second node)", second.observed_at, now) {
        return Err(why);
    }
    // Both nodes are judged the way the engine judges one: a dust instance beside the real one is set aside.
    let canon_second = canonical_noid(file, second);
    let second = canon_second.as_ref().unwrap_or(second);
    if noid.instance.as_ref() != second.instance.as_ref() {
        return Err(format!(
            "the two noid nodes disagree about the instance: node 1 says {}, node 2 says {} (F5)",
            describe_instance_opt(noid.instance.as_ref()),
            describe_instance_opt(second.instance.as_ref())
        ));
    }
    let diff = noid.tip.abs_diff(second.tip);
    if diff > MAX_NOID_TIP_DIFF {
        return Err(format!(
            "the two noid nodes' tips are {diff} blocks apart (limit {MAX_NOID_TIP_DIFF}): node 1 at {}, node 2 at {} (F5)",
            noid.tip, second.tip
        ));
    }
    Ok(())
}

/// Alice's `reveal_eth` against the second Ethereum node: the same lock record (lock id, amount, receiver, timelock,
/// claimed and refunded flags) on the pinned chain and code, `finalized` heights within [`MAX_ETH_FINALIZED_DIFF`] blocks,
/// and the lock final at the LOWER of the two.
fn eth_nodes_agree(file: &SwapFile, eth: &EthObservation, second: &EthObservation, lock: &EthLock, now: u64) -> Result<(), String> {
    let p = &file.public.params.eth;
    if let Some(why) = second_stale("eth (second node)", second.observed_at, now) {
        return Err(why);
    }
    match second.chain_id {
        Some(id) if id == p.chain_id => {}
        Some(id) => return Err(format!("the second eth node is on chain {id}, the swap is on {} (F5)", p.chain_id)),
        None => return Err("second eth node: chain_id unknown (F5)".into()),
    }
    match (p.code_hash, second.contract_code_hash) {
        (Some(pinned), Some(seen)) if pinned == seen => {}
        (Some(_), Some(_)) => return Err("the second eth node shows other code at the contract address than the pinned one (F5)".into()),
        (_, None) => return Err("second eth node: contract_code_hash unknown (F5)".into()),
        (None, _) => return Err("no HTLC code hash is pinned in the swap file (T17)".into()),
    }
    let Some(other) = second.find_lock(&lock.lock_id) else {
        return Err(format!("the second eth node does not show the lock {} that the first one shows (F5)", short_id(&lock.lock_id)));
    };
    let mut differs: Vec<String> = Vec::new();
    if other.amount_wei != lock.amount_wei {
        differs.push(format!("amount (node 1 {} wei, node 2 {} wei)", lock.amount_wei, other.amount_wei));
    }
    if other.receiver != lock.receiver {
        differs.push("receiver".to_string());
    }
    if other.timelock != lock.timelock {
        differs.push(format!("timelock (node 1 {}, node 2 {})", lock.timelock, other.timelock));
    }
    if other.claimed != lock.claimed {
        differs.push(format!("claimed (node 1 {}, node 2 {})", lock.claimed, other.claimed));
    }
    if other.refunded != lock.refunded {
        differs.push(format!("refunded (node 1 {}, node 2 {})", lock.refunded, other.refunded));
    }
    if !differs.is_empty() {
        return Err(format!("the two eth nodes disagree about the lock {}: {} (F5)", short_id(&lock.lock_id), differs.join("; ")));
    }
    let (Some(a), Some(b)) = (eth.finalized_block, second.finalized_block) else {
        return Err(format!(
            "finalized height unknown on a node (node 1 {:?}, node 2 {:?}): both must report one before the reveal (F5)",
            eth.finalized_block, second.finalized_block
        ));
    };
    let diff = a.abs_diff(b);
    if diff > MAX_ETH_FINALIZED_DIFF {
        return Err(format!(
            "the two eth nodes' finalized heights are {diff} blocks apart (limit {MAX_ETH_FINALIZED_DIFF}): node 1 at {a}, node 2 at {b} (F5)"
        ));
    }
    let lower = a.min(b);
    if lower < lock.block_number {
        return Err(format!(
            "the lock is final on one node only: finalized node 1 {a}, node 2 {b}, the lock is in block {} (the lower height decides; F5)",
            lock.block_number
        ));
    }
    Ok(())
}

/// REVIEW-2 F5, applied after `spend_blocker` has passed: the chain's own age (header times) and, for the two steps
/// that cannot be taken back on a lie, the agreement of a second node.
///
/// - Parano1d tip header time: `fund_noid`, `lock_eth`, `reveal_eth`, `claim_noid`, `refund_noid` wait when the tip
///   block is known to trail the clock by more than 300 s, or its time is unknown (REVIEW-3 F5: fail closed).
///   `refund_eth` is an Ethereum action and never reads the NOID side.
/// - Ethereum head time: `lock_eth` and `reveal_eth` wait when the latest block trails the clock by more than 600 s
///   (not under the `rehearsal` profile: a local automine chain makes no blocks while idle).
/// - `lock_eth` needs a second Parano1d node that agrees, `reveal_eth` a second Ethereum node that agrees. With one node:
///   `Wait` under `production` and `sepolia` unless `--single-node-ok` (REVIEW-3 F5); a note under `rehearsal`.
/// - An unknown header time (`tip_time = None`) blocks the same NOID-side actions (REVIEW-3 F5).
fn f5_gate(file: &SwapFile, action: &Action, noid: &NoidObservation, eth: &EthObservation, now: u64, notes: &mut Vec<String>) -> Option<String> {
    let noid_side = matches!(
        action,
        Action::FundNoid { .. } | Action::LockEth { .. } | Action::RevealEth { .. } | Action::ClaimNoid { .. } | Action::RefundNoid { .. }
    );
    if noid_side {
        if let Some(why) = noid_tip_time_blocker(noid.tip_time, now) {
            return Some(why);
        }
    }
    let eth_side = matches!(action, Action::LockEth { .. } | Action::RevealEth { .. });
    if eth_side {
        if file.public.params.profile == params::ProfileName::Rehearsal {
            notes.push("rehearsal: the eth head-time rule is skipped (a local automine chain makes no blocks while idle) (F5)".to_string());
        } else if let Some(why) = eth_head_time_blocker(eth.latest_timestamp, now) {
            return Some(why);
        }
    }
    match action {
        Action::LockEth { .. } => match second_node_policy(file, noid.second.as_deref(), noid.second_error.as_deref(), noid.single_node_ok, notes) {
            Err(why) => Some(why),
            Ok(None) => None,
            Ok(Some(second)) => noid_nodes_agree(file, noid, second, now).err(),
        },
        Action::RevealEth { lock_id } => match second_node_policy(file, eth.second.as_deref(), eth.second_error.as_deref(), eth.single_node_ok, notes) {
            Err(why) => Some(why),
            Ok(None) => None,
            Ok(Some(second)) => match eth.find_lock(lock_id) {
                Some(lock) => eth_nodes_agree(file, eth, second, &lock, now).err(),
                None => Some("the lock this action names is not visible in the observation".into()),
            },
        },
        _ => None,
    }
}

/// CHAOS F-3: the node does not give the height a funding was included at (`creation_id` is an allocation counter, not a height),
/// so finality is counted from the tick that first saw the instance. That count is only sound while the instance stays in view:
/// a poll in which it is absent, or present as another incarnation, means a reorg touched it, and the count must start over.
fn funding_not_there(recorded: &NoidInstance, noid: &NoidObservation, d: u64) -> Option<String> {
    if noid.find_instance(recorded).is_some() {
        return None;
    }
    // From the height at which Alice's recovery close opens no lock can be made any more, so the count no longer protects anyone. An
    // instance that is gone with NOTHING listed at the root then was most likely closed (by her wallet), which is `--closed-by`'s
    // business, not a reorg. A different incarnation at the root is the funding that came back: it is adopted again (and counted again).
    if params::alice_refund_ready(noid.tip, d) && noid.all_instances().is_empty() {
        return None;
    }
    Some(format!(
        "the funding seen at slot {} (creation {}) is not at the contract in this poll (a reorg took it back, or it came back as another incarnation): the finality count starts over (CHAOS F-3)",
        recorded.slot_index, recorded.creation_id
    ))
}

fn alice_fact(
    file: &SwapFile,
    p: &AlicePhase,
    noid: &NoidObservation,
    eth: &EthObservation,
    now: u64,
    notes: &mut Vec<String>,
) -> Option<Event> {
    use AlicePhase as A;
    match p {
        A::Created | A::FundingSubmitted { .. } => match instance_ok(file, noid) {
            Ok(()) => Some(Event::NoidInstanceSeen { instance: noid.instance.clone()?, tip: noid.tip }),
            Err(e) if noid.instance.is_some() => {
                notes.push(format!("instance seen but not accepted: {e}"));
                None
            }
            Err(_) => None,
        },
        A::Funded { instance, seen_at_tip } => {
            if let Some(why) = funding_not_there(instance, noid, file.public.params.deadline_height) {
                notes.push(why);
                return Some(Event::NoidInstanceGone);
            }
            params::noid_final(noid.tip, *seen_at_tip).then_some(Event::NoidFundingFinal { tip: noid.tip })
        }
        A::FundingFinal { .. } => {
            // REVIEW-4 (found by the chaos test, seed 0xc4a05eed scenario 2633): a file that already RECEIVED its ETH (`eth_claim_final`)
            // comes back to `funding_final` only when a reorg took its NOID recovery close back. It must not adopt another lock then and
            // reveal again; the NOID is all that is left.
            if last_history(file, "eth_claim_final").is_some() {
                return None;
            }
            // REVIEW-2 F10: every matching lock is judged on its own. Bob's first lock may fail Alice's checks (a wrong
            // amount, a short window) and must not hide a correct second one; two that both pass are not guessed between.
            let locks = eth.all_locks();
            let multi = locks.len() > 1;
            let mut acceptable: Vec<&EthLock> = Vec::new();
            for lock in &locks {
                match alice_check_lock(file, eth, lock, now) {
                    Ok(()) => acceptable.push(lock),
                    Err(why) => notes.push(if multi { format!("lock {}: {why}", short_id(&lock.lock_id)) } else { why }),
                }
            }
            match acceptable.as_slice() {
                [] => None,
                [one] => Some(Event::EthLockSeen { lock: summary(one) }),
                many => {
                    notes.push(format!(
                        "{} Ethereum locks pass every check ({}): accepting none until exactly one is left (REVIEW-2 F10)",
                        many.len(),
                        describe_locks(&many.iter().map(|l| (*l).clone()).collect::<Vec<_>>(), None)
                    ));
                    None
                }
            }
        }
        A::LockSeen { lock, .. } => eth.lock_finalized_id(&lock.lock_id).then_some(Event::EthLockFinal),
        A::LockFinal { instance, lock } => match eth.claimed.as_ref().filter(|c| c.lock_id == lock.lock_id) {
            Some(c) => Some(Event::EthClaimMined { block_number: c.block_number }),
            // CHAOS F-12: on the CLI path the operator sends the reveal, so the phase stays `lock_final`; a reveal that was decided
            // (or recorded, or dropped and not re-sent) is the evidence that the secret may be public.
            None if reveal_evidence(file) => alice_both_legs_lost(file, instance, lock, noid, eth, now, notes),
            None => None,
        },
        A::RevealSubmitted { instance, lock, submitted_at, .. } => match eth.claimed.as_ref().filter(|c| c.lock_id == lock.lock_id) {
            Some(c) => Some(Event::EthClaimMined { block_number: c.block_number }),
            None => alice_both_legs_lost(file, instance, lock, noid, eth, now, notes).or_else(|| {
                // CHAOS F-5: a reveal that is no longer pending and not mined is offered again (while (I2) allows).
                let pending_for_us = eth.pending_preimage.as_ref().is_some_and(|p| p.lock_id == lock.lock_id);
                let refunded = eth.refunded.as_ref().is_some_and(|r| r.lock_id == lock.lock_id);
                (!pending_for_us && !refunded && eth_tx_dropped(eth, *submitted_at, now, tx_grace(file), "reveal (HTLC.claim)", notes)).then_some(Event::EthRevealDropped)
            }),
        },
        // CHAOS F-9: `revealed` is not `done`. The claim must still be on the chain when it becomes final; a reorg that dropped it
        // sends Alice back to waiting for her reveal, a reorg that moved it restarts the finality count.
        A::Revealed { block_number, lock, .. } => match eth.claimed.as_ref().filter(|c| c.lock_id == lock.lock_id) {
            Some(c) => {
                // A claim read from the `getLock` record carries an upper bound for its block (the poll's head), which only grows.
                let moved = c.block_number != *block_number && !(eth.claim_state_from_record && c.block_number > *block_number);
                if moved {
                    notes.push(format!(
                        "the claim recorded at ETH block {block_number} is now at block {} (re-included after a reorg); the finality count starts over",
                        c.block_number
                    ));
                    return Some(Event::EthClaimMined { block_number: c.block_number });
                }
                (eth.finalized_block? >= *block_number).then_some(Event::EthClaimFinal)
            }
            None if eth.latest_block >= *block_number => {
                notes.push(format!(
                    "REORG: our claim was mined at ETH block {block_number} and is no longer on the chain (head {}); back to waiting for the reveal (CHAOS F-9)",
                    eth.latest_block
                ));
                // `at` is back-dated by the grace period: a claim that was MINED proves the node had it, so the signer's nonces alone
                // decide whether it is still pending (Review H1: no 600-s wait before a re-send).
                Some(Event::EthClaimReorged { block_number: *block_number, at: now.saturating_sub(tx_grace(file)) })
            }
            None => {
                notes.push(format!("the node's head {} is below the block {block_number} of our claim: it is behind; not judging the claim", eth.latest_block));
                None
            }
        },
        A::RefundSubmitted { txid: Some(txid), .. } => tracked_outcome(noid, txid),
        A::RefundSubmitted { txid: None, .. } => None,
        A::RefundIncluded { txid, height, .. } => match included_outcome(noid, txid, *height) {
            Included::Final => Some(Event::NoidTxFinal { tip: noid.tip }),
            Included::Waiting => None,
            Included::Reincluded(h) => Some(Event::NoidTxReincluded { txid: txid.clone(), was_height: *height, height: h }),
            Included::Reorged { still_pending } => {
                notes.push(reorg_note("refund", txid, *height, still_pending));
                Some(Event::NoidTxReorged { txid: txid.clone(), was_height: *height, still_pending, preimage: None })
            }
            Included::Unchecked => {
                notes.push(unchecked_note("refund", txid, *height));
                None
            }
        },
        // REVIEW-2 F9: a file from before `done` kept the instance: take it from the node (only an instance that fits).
        A::Done { instance: None, .. } => match instance_ok(file, noid) {
            Ok(()) => Some(Event::NoidInstanceSeen { instance: noid.instance.clone()?, tip: noid.tip }),
            Err(_) => None,
        },
        A::Done { .. } | A::Refunded { .. } | A::Lost { .. } | A::Aborted { .. } => None,
    }
}

/// CHAOS F-12: this file shows that Alice's reveal was decided, sent or dropped (CLI path: `intent_decided:reveal_eth`; Runner path:
/// `reveal_submitted`, `eth_reveal_dropped`), so her secret may be public although no claim of hers is mined.
/// Review H1: this file shows that Alice's claim reached the Ethereum network (sent through the tool, mined, reorged, dropped): the
/// secret may be public. A reveal merely DECIDED on the CLI path is not enough (it may never have been sent).
pub fn secret_may_be_public(file: &SwapFile) -> bool {
    file.history.iter().any(|h| matches!(h.event.as_str(), "reveal_submitted" | "eth_claim_mined" | "eth_claim_reorged" | "eth_reveal_dropped"))
}

/// The latest time Alice's reveal may still be sent under this file's profile: the `M_A` cutoff, or `T_reveal - DE` once the secret may
/// be public (Review H1).
pub fn reveal_cutoff_for(file: &SwapFile, t_reveal: u64) -> u64 {
    let g = file.public.params.profile.gates();
    if secret_may_be_public(file) {
        t_reveal.saturating_sub(g.de_s)
    } else {
        g.reveal_cutoff(t_reveal)
    }
}

fn reveal_evidence(file: &SwapFile) -> bool {
    // A reveal intent that was later cancelled is no evidence: the cancel is refused while the claim is pending or mined.
    let decided = last_history(file, "intent_decided:reveal_eth");
    let cancelled = last_history(file, "intent_cancelled:reveal_eth");
    (decided.is_some() && decided > cancelled)
        || file.history.iter().any(|h| matches!(h.event.as_str(), "reveal_submitted" | "eth_reveal_dropped"))
}

/// CHAOS F-17: once the recorded instance has been seen at the contract in a poll where Bob's claim could no longer be included
/// (`tip + 1 >= D`), its later disappearance is Alice's own recovery close (outside this tool, perhaps not final), never Bob's claim, so
/// the file must not call it `lost`. A log-only fact, once.
fn alice_alive_at_d(file: &SwapFile, p: &AlicePhase, noid: &NoidObservation) -> Option<Event> {
    if last_history(file, "noid_instance_alive_at_d").is_some() || !params::alice_refund_ready(noid.tip, file.public.params.deadline_height) {
        return None;
    }
    if !matches!(p, AlicePhase::FundingFinal { .. } | AlicePhase::LockSeen { .. } | AlicePhase::LockFinal { .. } | AlicePhase::RevealSubmitted { .. } | AlicePhase::Revealed { .. } | AlicePhase::Done { .. }) {
        return None;
    }
    let seen = p.instance().and_then(|i| noid.find_instance(i)).is_some();
    seen.then_some(Event::NoidInstanceAliveAtD)
}

/// M2.5b: Alice's reveal was still pending when Bob's refund of the same lock was mined, so the reveal reverted (claim and
/// refund exclude each other in `HTLC.sol`) while its calldata had already published the secret. Both legs are lost only
/// when ALL of these hold: the refund of our lock is final on Ethereum, no claim of ours is mined (the caller checked),
/// the tip is `B_FINAL` blocks past `D` (the claim branch is closed for good and a claim of Bob's would be final) and the
/// instance this file recorded is gone. A `refund_noid` that was sent from outside this tool (a decided intent) could
/// also explain a missing instance; that case is left for `tick --closed-by`, never declared lost. REVIEW-4 R4-9: `lost` ends the watch
/// loop, so where the profile asks for a second node (and `--single-node-ok` was not given) that node must be read, fresh, past `D + B_FINAL`
/// itself and agree that the instance is gone.
fn alice_both_legs_lost(
    file: &SwapFile,
    instance: &NoidInstance,
    lock: &LockSummary,
    noid: &NoidObservation,
    eth: &EthObservation,
    now: u64,
    notes: &mut Vec<String>,
) -> Option<Event> {
    let r = eth.refunded.as_ref().filter(|r| r.lock_id == lock.lock_id)?;
    if eth.finalized_block? < r.block_number {
        return None;
    }
    let d = file.public.params.deadline_height;
    if noid.tip < d.saturating_add(params::B_FINAL) || noid.find_instance(instance).is_some() {
        return None;
    }
    if noid.second.as_deref().is_some_and(|s| s.find_instance(instance).is_some()) {
        notes.push("the second node still lists the NOID instance: not declaring both legs lost on one node's word (Review M2)".to_string());
        return None;
    }
    // REVIEW-4 R4-9: `lost` ends the watch loop, so it needs more than one node's word where the profile asks for two: a second node that
    // is read, fresh and past `D + B_FINAL` itself and does not list the instance. A second node that was configured but could not be read
    // blocks too (as everywhere else, whatever `--single-node-ok` says).
    let why_not_second = match noid.second.as_deref() {
        Some(s) => second_stale("noid (second node)", s.observed_at, now)
            .or_else(|| (s.tip < d.saturating_add(params::B_FINAL)).then(|| format!("the second node's tip {} is below D {d} + {}", s.tip, params::B_FINAL))),
        None => match noid.second_error.as_deref() {
            Some(e) => Some(format!("the second node could not be read ({e})")),
            None if file.public.params.profile.requires_second_node() && !noid.single_node_ok => {
                Some("this profile asks for a second node and none was given (--single-node-ok was not passed)".to_string())
            }
            None => None,
        },
    };
    if let Some(why) = why_not_second {
        notes.push(format!(
            "the NOID instance looks gone and the ETH refund is final, but {why}: not declaring both legs lost on one node's word (REVIEW-4 R4-9). Check the contract on another node; if the instance is still listed there, recover it with the wallet (the recovery branch pays only Alice)"
        ));
        return None;
    }
    if last_history(file, "noid_instance_alive_at_d").is_some() {
        notes.push(
            "the NOID instance is gone and the ETH refund is final, but the instance was still at the contract when Bob's claim branch had closed: it went by a recovery close (hers), not by Bob's claim; not declaring both legs lost (CHAOS F-17); if the close confirmed, record it with `tick --closed-by`"
                .to_string(),
        );
        return None;
    }
    if file.pending_intent.as_ref().is_some_and(|i| i.action == "refund_noid")
        || file.history.iter().any(|h| h.event == "intent_decided:refund_noid")
    {
        notes.push(
            "the NOID instance is gone and the ETH refund is final, but a refund_noid was decided for this swap: not declaring both legs lost; if the recovery close confirmed, record it with `tick --closed-by`"
                .to_string(),
        );
        return None;
    }
    Some(Event::BothLegsLost {
        refund_block: r.block_number,
        reason: format!(
            "the ETH went back to Bob at block {} (final); the NOID instance (slot {}, creation {}) was closed after the secret was published; both legs are lost",
            r.block_number, instance.slot_index, instance.creation_id
        ),
    })
}

/// Alice's acceptance of one `Locked` event (design step 9, T11, T17, REVIEW-2 F11): `Ok` or the note saying why not.
fn alice_check_lock(file: &SwapFile, eth: &EthObservation, lock: &EthLock, now: u64) -> Result<(), String> {
    let g = file.public.params.profile.gates();
    lock_matches(file, eth, lock, None).map_err(|e| format!("lock rejected: {e}"))?;
    if lock.claimed || lock.refunded {
        return Err("Bob's lock is already closed".into());
    }
    // REVIEW-2 F11, (I3): Bob's reveal window, measured from the block that mined his
    // lock, must be at least W_A_min; else Alice could not use it and he holds a free option.
    match lock.block_timestamp {
        Some(ts) if g.check_i3(lock.timelock, ts) => {}
        Some(ts) => {
            return Err(format!(
                "lock rejected: T_reveal {} is only {} s after its block (timestamp {ts}), less than W_A_min {} s (I3)",
                lock.timelock,
                lock.timelock.saturating_sub(ts),
                g.w_a_min_s
            ));
        }
        None => return Err("lock not accepted yet: the timestamp of its block is unknown (I3, fail closed)".into()),
    }
    let t_now = eth_now(eth, now);
    if !g.alice_accepts_t_reveal(t_now, lock.timelock) {
        return Err(format!("lock rejected: T_reveal {} leaves less than M_A before the cutoff", lock.timelock));
    }
    Ok(())
}

/// Alice: the ETH observation shows Bob's lock (her lock id) refunded. Recorded once
/// as `eth_refund_mined`, the event Bob uses for the same chain fact; it changes no phase
/// and no action (she keeps the secret and waits for D). "Once" is the swap file's own
/// history: the first such entry silences it, across ticks and restarts.
fn alice_refund_seen(file: &SwapFile, p: &AlicePhase, eth: &EthObservation, notes: &mut Vec<String>) -> Option<Event> {
    use AlicePhase as A;
    if file.history.iter().any(|h| h.event == "eth_refund_mined") {
        return None;
    }
    let refunded = eth.refunded.as_ref()?;
    let ours = match p {
        A::LockSeen { lock, .. } | A::LockFinal { lock, .. } | A::RevealSubmitted { lock, .. } | A::Revealed { lock, .. } => {
            lock.lock_id == refunded.lock_id
        }
        // No lock accepted yet: it is ours only if it passes the same checks as a fresh lock.
        A::FundingFinal { .. } => {
            eth.all_locks().iter().any(|l| l.lock_id == refunded.lock_id && lock_matches(file, eth, l, None).is_ok())
        }
        _ => false,
    };
    if !ours {
        return None;
    }
    if matches!(p, A::Revealed { .. }) {
        notes.push(format!(
            "ANOMALY: our lock was refunded at ETH block {} after the reveal was sent; claim and refund exclude each other in HTLC.sol, so check the watcher and the chain by hand",
            refunded.block_number
        ));
    } else if matches!(p, A::RevealSubmitted { .. }) {
        // M2.5b: her claim was NOT mined (else the phase would be `revealed`), so there is no contradiction: the refund won.
        notes.push(format!(
            "Bob's refund of our lock was mined at ETH block {} while our reveal was pending: the reveal reverted; the secret was published by its calldata",
            refunded.block_number
        ));
    }
    Some(Event::EthRefundMined { block_number: refunded.block_number })
}

/// Included, evicted, or still pending for the transaction we are tracking.
fn tracked_outcome(noid: &NoidObservation, txid: &str) -> Option<Event> {
    if let Some(c) = noid.confirmed_tx.as_ref().filter(|c| c.txid.eq_ignore_ascii_case(txid)) {
        return Some(Event::NoidTxIncluded { txid: c.txid.clone(), height: c.height });
    }
    if noid.tracked_tx_pending == Some(false) {
        return Some(Event::NoidTxEvicted { txid: txid.to_string() });
    }
    None
}

// ---------------------------------------------------------------- a close made outside the tool (M2.5d)

/// A txid as `tick --closed-by` takes it: 64 hex characters, with or without `0x`, any case. Returned lower-case.
pub fn normalize_txid(s: &str) -> Result<String, String> {
    let t = s.trim();
    let t = t.strip_prefix("0x").or_else(|| t.strip_prefix("0X")).unwrap_or(t);
    if t.len() == 64 && t.bytes().all(|b| b.is_ascii_hexdigit()) {
        Ok(t.to_ascii_lowercase())
    } else {
        Err(format!("--closed-by: expected a 64-hex-character transaction id, got {} character(s)", t.chars().count()))
    }
}

/// The phase half of the `--closed-by` check, which needs no node: may a close of the instance be recorded in
/// this phase? Alice: any phase that still holds the NOID and has not revealed (`funded` ... `lock_final`,
/// `refund_submitted`; since REVIEW-2 F9 also `reveal_submitted`, `revealed` and `done`, where Bob never claimed and the
/// recovery close was made at `h >= D`, which [`external_close_event`] checks). Bob: `secret_seen` and
/// `claim_submitted`. Every other phase is refused with the reason.
pub fn check_external_close_phase(file: &SwapFile, txid: &str) -> Result<(), String> {
    use AlicePhase as A;
    use BobPhase as B;
    let tracked = |t: &Option<String>| match t {
        Some(own) if !own.eq_ignore_ascii_case(txid) => Err(format!(
            "this swap file already tracks the transaction {own}; --closed-by {txid} is a different one. Let the normal tick finish {own} first"
        )),
        _ => Ok(()),
    };
    match &file.phase {
        Phase::Alice(A::Funded { .. } | A::FundingFinal { .. } | A::LockSeen { .. } | A::LockFinal { .. }) => Ok(()),
        Phase::Alice(A::RevealSubmitted { .. } | A::Revealed { .. } | A::Done { instance: Some(_), .. }) => Ok(()),
        Phase::Alice(A::Done { instance: None, .. }) => Err(
            "Alice is in phase `done` and this file (written before F9) did not record the instance, so a recovery close cannot be recorded against it; run a normal tick while the instance is still visible, or verify the receipts by hand".into(),
        ),
        Phase::Alice(A::RefundSubmitted { txid: t, .. }) => tracked(t),
        Phase::Bob(B::SecretSeen { .. }) => Ok(()),
        Phase::Bob(B::ClaimSubmitted { txid: t, .. }) => tracked(&Some(t.clone())),
        other => {
            let name = other.name();
            Err(match name.as_str() {
                "created" | "funding_submitted" | "received" => format!("the swap is in phase `{name}`: the instance was never seen funded, so there is no close to record"),
                "done" | "refunded" | "lost" | "aborted" => format!("the swap is already `{name}` (terminal): there is nothing to record"),
                "claim_included" | "refund_included" => format!("a close is already recorded (phase `{name}`); the normal tick follows it to final"),
                "locked" | "lock_submitted" | "refund_submitted" | "refund_mined" | "funding_final" | "funded" => format!(
                    "in phase `{name}` the secret is not known to this swap file yet, so a close cannot be Bob's claim; run the normal tick first"
                ),
                _ => format!("in phase `{name}` a close of the instance makes no sense; not recording"),
            })
        }
    }
}

/// `tick --closed-by TXID`: may the instance's disappearance be recorded as the close `txid`? `noid` must have been
/// observed with `txid` as the tracked transaction (the watcher asked `getTx` and `getMempoolEntry` about it).
///
/// Refuses, with a plain message and nothing recorded, when: the phase does not fit ([`check_external_close_phase`]);
/// the instance is still visible; `txid` is not confirmed on the node (unknown, or still only in the mempool);
/// or the inclusion height is on the wrong side of the deadline for this role. `getTx` returns only
/// `{tx_hash, height, block_hash, tx_position}`, never the outputs, so the payout is NOT read: it follows from the
/// branch rule (a close at `h < D` pays Bob, at `h >= D` pays Alice), which the block proof enforces.
/// It cannot prove that `txid` is the call that closed THIS instance (it only proves that it is confirmed and
/// that the instance is gone); the caller prints that caveat.
pub fn external_close_event(file: &SwapFile, noid: &NoidObservation, txid: &str) -> Result<Event, String> {
    let txid = normalize_txid(txid)?;
    check_external_close_phase(file, &txid)?;
    // REVIEW-2 F10: the instance this file recorded (slot and incarnation), not "any instance at the root": a dust
    // instance left behind must not make a closed instance look alive.
    let recorded = match &file.phase {
        Phase::Alice(p) => p.instance(),
        Phase::Bob(p) => p.instance(),
    };
    let visible = match recorded {
        Some(r) => noid.find_instance(r).map(|v| v.instance),
        None => noid.instance.clone(),
    };
    if let Some(i) = visible {
        return Err(format!(
            "the instance is still visible at our contract root (slot {}, {} micro-NOID): it has not been closed as far as this node can tell, so nothing is recorded",
            i.slot_index, i.amount_micronoid
        ));
    }
    let Some(c) = noid.confirmed_tx.as_ref().filter(|c| c.txid.eq_ignore_ascii_case(&txid)) else {
        return Err(if noid.tracked_tx_pending == Some(true) {
            format!("transaction {txid} is only in the mempool, not confirmed; run again once it is in a block")
        } else if noid.tracked_tx_pending.is_none() {
            format!("the node was not asked about transaction {txid}; nothing is recorded")
        } else {
            format!("transaction {txid} was not found on this node (getTx returned nothing, and it is not in the mempool); not confirmed, nothing is recorded")
        });
    };
    let d = file.public.params.deadline_height;
    match file.role {
        Role::Alice if c.height < d => {
            return Err(format!(
                "transaction {txid} was included at height {}, before the deadline D {d}: a close then pays Bob (the claim branch), so it is not Alice's recovery; nothing is recorded",
                c.height
            ))
        }
        Role::Bob if c.height >= d => {
            return Err(format!(
                "transaction {txid} was included at height {}, at or after the deadline D {d}: a close then pays Alice (the recovery branch), not Bob; nothing is recorded",
                c.height
            ))
        }
        _ => {}
    }
    Ok(Event::NoidClosedExternally { txid, height: c.height })
}

/// What a tick learns about a close that is recorded as included at some height (REVIEW-2 F6).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Included {
    /// Confirmed at the recorded height and the tip is 17 blocks past it.
    Final,
    /// Confirmed at the recorded height, not final yet.
    Waiting,
    /// Confirmed, but at another height: re-included after a rollback.
    Reincluded(u64),
    /// Asked, and not confirmed any more: back in the mempool or gone.
    Reorged { still_pending: bool },
    /// This poll did not ask the node about the txid (no `getTx` / `getMempoolEntry` answer): nothing can be said.
    Unchecked,
}

/// Inclusion by the node's own answer about the txid, never by the tip alone. "Asked" is `tracked_tx_pending.is_some()`
/// (the watcher sets it whenever a txid was tracked) or a matching `confirmed_tx`; an observation that never asked
/// (`confirmed_tx: None, tracked_tx_pending: None`, e.g. a recording made before F6) is `Unchecked`, not a reorg.
fn included_outcome(noid: &NoidObservation, txid: &str, recorded_height: u64) -> Included {
    if let Some(c) = noid.confirmed_tx.as_ref().filter(|c| c.txid.eq_ignore_ascii_case(txid)) {
        if c.height != recorded_height {
            return Included::Reincluded(c.height);
        }
        return if params::noid_final(noid.tip, recorded_height) { Included::Final } else { Included::Waiting };
    }
    match noid.tracked_tx_pending {
        Some(still_pending) => Included::Reorged { still_pending },
        None => Included::Unchecked,
    }
}

fn reorg_note(what: &str, txid: &str, height: u64, still_pending: bool) -> String {
    format!(
        "REORG: the {what} {txid} was included at height {height} and is no longer confirmed there; {}",
        if still_pending { "it is back in the mempool" } else { "it is not in the mempool either" }
    )
}

fn unchecked_note(what: &str, txid: &str, height: u64) -> String {
    format!("the {what} {txid} was included at height {height}, but this poll did not ask the node about it (no getTx answer): not advancing to final")
}

fn alice_action(
    file: &SwapFile,
    p: &AlicePhase,
    noid: &NoidObservation,
    eth: &EthObservation,
    now: u64,
    notes: &mut Vec<String>,
) -> Action {
    use AlicePhase as A;
    let g = file.public.params.profile.gates();
    let d = file.public.params.deadline_height;
    let lock_by = file.public.params.lock_by_height;
    let refund = |noid: &NoidObservation| Action::RefundNoid {
        call_height: noid.next_call_height,
        fee_micronoid: close_fee_for(file.public.params.contract_version, noid, file.public.params.max_fee_micronoid),
    };
    match p {
        A::Created => {
            // Funding must be final with time for Bob to lock before his lock-by height.
            // REVIEW-2 F13: the tip comes from a node, so no unchecked arithmetic on it.
            let Some(funded_final_by) = noid.tip.checked_add(g.b_fund + g.b_final) else {
                return Action::Wait { reason: "noid.tip is implausibly large; refusing to act on it".into() };
            };
            if funded_final_by > lock_by {
                return Action::Abort {
                    reason: format!("too late to fund: tip {} + {} > lock-by {lock_by}", noid.tip, g.b_fund + g.b_final),
                };
            }
            if noid.tip.saturating_add(1) < file.public.params.h_create {
                return Action::Wait { reason: "node is behind H_create".into() };
            }
            Action::FundNoid { amount_micronoid: file.public.params.amount_micronoid }
        }
        A::FundingSubmitted { .. } => Action::Wait { reason: "funding not yet visible".into() },
        A::Funded { .. } => Action::Wait { reason: "waiting for funding finality".into() },
        A::FundingFinal { .. } | A::LockSeen { .. } => {
            if params::alice_refund_ready(noid.tip, d) {
                return refund(noid);
            }
            Action::Wait {
                reason: if last_history(file, "eth_claim_final").is_some() {
                    "the ETH was already received; only the NOID recovery is left".into()
                } else if matches!(p, A::LockSeen { .. }) {
                    "waiting for Bob's lock to be finalized".into()
                } else if eth.lock.is_some() {
                    "Bob's lock did not pass the checks".into()
                } else {
                    "waiting for Bob's lock".into()
                },
            }
        }
        A::LockFinal { lock, .. } => {
            let t_now = eth_now(eth, now);
            // Review H1: once the secret may already be public (a reveal that was sent, mined, reorged or dropped), the reason for the
            // `M_A` cutoff is gone (it protects a first publication that has no time to be final); what is left is to get a claim mined
            // before `T_reveal`, so a re-send is allowed until `T_reveal - DE`.
            let i2 = g.check_i2_eth(t_now, lock.t_reveal, true).or_else(|e| {
                if secret_may_be_public(file) && t_now.saturating_add(g.de_s) <= lock.t_reveal {
                    notes.push(format!(
                        "re-sending the reveal past the M_A cutoff: the secret may already be public, so only DE {} s before T_reveal {} count ({e})",
                        g.de_s, lock.t_reveal
                    ));
                    Ok(())
                } else {
                    Err(e)
                }
            });
            match i2 {
                Ok(()) => {
                    // CHAOS F-13: the instance she would hand over must be at the contract in THIS poll (a one-block funding reorg
                    // would otherwise let her reveal while Bob has nothing to claim until it comes back).
                    let visible = p.instance().and_then(|i| noid.find_instance(i)).is_some_and(|v| instance_fits(file, &v));
                    // (Not when the secret may already be public: then nothing is protected by waiting, and the re-send can only help her.)
                    if !visible && !secret_may_be_public(file) {
                        let why = "not revealing: the recorded NOID instance is not at the contract (or no longer fits the agreement) in this poll (CHAOS F-13)".to_string();
                        notes.push(why.clone());
                        return if params::alice_refund_ready(noid.tip, d) { refund(noid) } else { Action::Wait { reason: why } };
                    }
                    // REVIEW-3 F10 (Alice): every instance at her root has the same claim authority `Addr(s)` and
                    // `claim_recipient = Bob`, so once the secret is public Bob can close each one that fits. More than one
                    // fitting instance means she would hand over more than the agreed amount: no reveal, no override.
                    let fitting: Vec<NoidInstanceStatus> = noid.all_instances().into_iter().filter(|v| instance_fits(file, v)).collect();
                    // REVIEW-4 R4-4: not once the secret may already be public. Withholding then protects nothing (Bob can close every
                    // instance with the published secret anyway, and a Bob who funded a second instance would profit from the refusal);
                    // a first reveal keeps the rule.
                    if fitting.len() > 1 && secret_may_be_public(file) {
                        let slots = fitting.iter().map(|v| v.instance.slot_index.to_string()).collect::<Vec<_>>().join(", ");
                        notes.push(format!(
                            "{} instances with the agreed amount sit at the contract root (slots {slots}; {}); the secret may already be public, so withholding the re-send protects nothing and the reveal goes ahead (REVIEW-4 R4-4); refund the other instances with the wallet at D {d}",
                            fitting.len(),
                            describe_instances(&fitting, p.instance())
                        ));
                    } else if fitting.len() > 1 {
                        let slots = fitting.iter().map(|v| v.instance.slot_index.to_string()).collect::<Vec<_>>().join(", ");
                        let why = format!(
                            "not revealing: {} instances with the agreed amount sit at the contract root (slots {slots}; {}); revealing would let Bob claim every one of them; the swap ends by refund at D {d} (refund_noid will name the recorded instance; refund the others with the wallet too)",
                            fitting.len(),
                            describe_instances(&fitting, p.instance())
                        );
                        notes.push(why.clone());
                        return if params::alice_refund_ready(noid.tip, d) { refund(noid) } else { Action::Wait { reason: why } };
                    }
                    // REVIEW-3 G2: other open locks on the agreed terms are locks whose receiver is Alice, claimable with
                    // the same secret, so they can only pay her more; they never stop the reveal (REVIEW-2 F10 did, which
                    // gave Bob a free cancel option after locking). The recorded lock being missing or closed is
                    // `spend_blocker`'s job.
                    let others: Vec<EthLock> = eth
                        .all_locks()
                        .into_iter()
                        .filter(|l| l.lock_id != lock.lock_id && !l.claimed && !l.refunded && lock_matches(file, eth, l, None).is_ok())
                        .collect();
                    if !others.is_empty() {
                        notes.push(format!(
                            "{} other open lock(s) on the agreed terms, claimable by Alice with the same secret once revealed: {}",
                            others.len(),
                            describe_locks(&others, None)
                        ));
                    }
                    Action::RevealEth { lock_id: lock.lock_id }
                }
                Err(e) => {
                    notes.push(format!("not revealing: {e}"));
                    if params::alice_refund_ready(noid.tip, d) {
                        refund(noid)
                    } else {
                        Action::Wait { reason: "reveal cutoff passed; keeping the secret and waiting for D".into() }
                    }
                }
            }
        }
        // REVIEW-2 F9: after the reveal the NOID is Bob's only if he claims it before D; if he never does, it comes back.
        A::RevealSubmitted { instance, .. } => {
            if alice_leftover_refund(file, Some(instance), noid, notes) {
                return refund(noid);
            }
            // M2.5b: Bob's refund of our lock is known and no claim of ours is mined (the phase would be `revealed`): the
            // reveal lost the race. Say so instead of "pending".
            let refunded = eth.refunded.as_ref().filter(|r| Some(r.lock_id) == p.lock().map(|l| l.lock_id));
            if refunded.is_some() || file.history.iter().any(|h| h.event == "eth_refund_mined") {
                let lock_id = p.lock().map(|l| short_id(&l.lock_id)).unwrap_or_default();
                let at = match refunded {
                    Some(r) => format!(
                        "at ETH block {} ({})",
                        r.block_number,
                        if eth.finalized_block.is_some_and(|f| f >= r.block_number) { "final" } else { "not final yet" }
                    ),
                    None => "at an ETH block this observation no longer shows".to_string(),
                };
                return Action::Wait {
                    reason: format!(
                        "our reveal lost: Bob's refund of lock {lock_id} was mined {at}; the reveal can no longer succeed, and its calldata published the secret, so Bob can still claim the NOID before D {d}; refund_noid opens when the next call height reaches D if the instance is still there"
                    ),
                };
            }
            Action::Wait { reason: "ETH claim pending".into() }
        }
        A::Revealed { instance, .. } => {
            if alice_leftover_refund(file, Some(instance), noid, notes) {
                return refund(noid);
            }
            Action::Wait { reason: "waiting for ETH claim finality".into() }
        }
        A::RefundSubmitted { .. } => Action::Wait { reason: "NOID refund pending".into() },
        A::RefundIncluded { .. } => Action::Wait { reason: "waiting for NOID refund finality".into() },
        A::Done { instance, .. } => {
            if alice_leftover_refund(file, instance.as_ref(), noid, notes) {
                return refund(noid);
            }
            let waiting = instance.as_ref().is_some_and(|i| noid.find_instance(i).is_some());
            Action::Wait {
                reason: if waiting {
                    format!("done: ETH received; the NOID is still at the contract, refund_noid opens when the next call height reaches D {d} if Bob has not claimed it")
                } else {
                    "done: ETH received".into()
                },
            }
        }
        A::Refunded { .. } => Action::Wait {
            reason: if file.history.iter().any(|h| h.event == "reveal_submitted" || h.event == "eth_claim_mined") {
                "done: NOID refunded after the reveal; Bob never claimed it, so both legs ended with Alice".into()
            } else {
                "done: NOID refunded".into()
            },
        },
        A::Lost { reason, .. } => Action::Wait { reason: format!("lost: {reason}") },
        A::Aborted { reason } => Action::Wait { reason: format!("aborted: {reason}") },
    }
}

/// REVIEW-2 F9, Alice after the reveal: should she take the NOID back? Yes when the next call height has reached `D`
/// (Bob's claim branch is closed for good) and the instance she recorded is still at the contract, still the agreed one.
/// Notes say why not otherwise (a different incarnation, an instance that no longer fits).
fn alice_leftover_refund(file: &SwapFile, recorded: Option<&NoidInstance>, noid: &NoidObservation, notes: &mut Vec<String>) -> bool {
    if !params::alice_refund_ready(noid.tip, file.public.params.deadline_height) {
        return false;
    }
    let Some(recorded) = recorded else { return false };
    let Some(v) = noid.find_instance(recorded) else {
        let all = noid.all_instances();
        if !all.is_empty() {
            // REVIEW-3 F10: name the slots so the operator can refund the others with the wallet.
            notes.push(format!(
                "the instance we recorded (slot {}, creation {}) is gone; another one sits at the root and is not refunded here: {}",
                recorded.slot_index,
                recorded.creation_id,
                describe_instances(&all, None)
            ));
        }
        return false;
    };
    if !instance_fits(file, &v) {
        notes.push("the recorded instance no longer fits the agreement (amount or opening); not refunding it".into());
        return false;
    }
    notes.push(format!(
        "REVIEW-2 F9: the secret is public but Bob never claimed the NOID and D {} is reached: taking it back (refund_noid)",
        file.public.params.deadline_height
    ));
    // REVIEW-3 F10: any other instance at the root is not covered by this refund; say which slots, for a wallet refund.
    let others: Vec<NoidInstanceStatus> = noid.all_instances().into_iter().filter(|o| o.instance.slot_index != recorded.slot_index || o.instance.creation_id != recorded.creation_id).collect();
    if !others.is_empty() {
        notes.push(format!(
            "REVIEW-3 F10: {} other instance(s) sit at the contract root and are not refunded by this call (refund them with the wallet): {}",
            others.len(),
            describe_instances(&others, None)
        ));
    }
    true
}

fn bob_fact(
    file: &SwapFile,
    p: &BobPhase,
    noid: &NoidObservation,
    eth: &EthObservation,
    now: u64,
    notes: &mut Vec<String>,
) -> Option<Event> {
    use BobPhase as B;
    match p {
        B::Received => match instance_ok(file, noid) {
            Ok(()) => Some(Event::NoidInstanceSeen { instance: noid.instance.clone()?, tip: noid.tip }),
            Err(e) if noid.instance.is_some() => {
                notes.push(format!("instance seen but not accepted: {e}"));
                None
            }
            Err(_) => None,
        },
        B::Funded { instance, seen_at_tip } => {
            if let Some(why) = funding_not_there(instance, noid, file.public.params.deadline_height) {
                notes.push(why);
                return Some(Event::NoidInstanceGone);
            }
            params::noid_final(noid.tip, *seen_at_tip).then_some(Event::NoidFundingFinal { tip: noid.tip })
        }
        B::FundingFinal { .. } | B::LockSubmitted { .. } => {
            let want = match p {
                B::LockSubmitted { t_reveal, .. } => Some(*t_reveal),
                _ => None,
            };
            // REVIEW-2 F10: every matching lock is looked at; the first that is ours is taken, the others are named.
            let locks = eth.all_locks();
            let multi = locks.len() > 1;
            let mut ours: Vec<&EthLock> = Vec::new();
            for lock in &locks {
                match lock_matches(file, eth, lock, want) {
                    Ok(()) => ours.push(lock),
                    Err(e) => notes.push(if multi {
                        format!("a lock exists but is not ours ({}): {e}", short_id(&lock.lock_id))
                    } else {
                        format!("a lock exists but is not ours: {e}")
                    }),
                }
            }
            if ours.len() > 1 {
                notes.push(format!("{} locks match what Bob chose; taking the first ({})", ours.len(), short_id(&ours[0].lock_id)));
            }
            if let (None, B::LockSubmitted { submitted_at, t_reveal, amount_wei, .. }) = (ours.first(), p) {
                // CHAOS F-5: the lock transaction is not on chain, nothing of the signer is pending, the grace period is over.
                // The lock Bob is waiting for is identified by its id: another lock of his address (a second attempt, a lock that
                // failed a check because the observation is degraded) is NOT a reason to call this one dropped.
                let pe = &file.public.params.eth;
                let mine = compute_lock_id(&pe.bob_sender, &pe.alice_receiver, *amount_wei, &file.public.hashlock, *t_reveal);
                let already = last_history(file, "eth_lock_dropped") > last_history(file, "lock_submitted");
                if !already && locks.iter().all(|l| l.lock_id != mine) && eth_tx_dropped(eth, *submitted_at, now, tx_grace(file), "lock (HTLC.newLock)", notes) {
                    return Some(Event::EthLockDropped);
                }
            }
            ours.first().map(|l| Event::EthLockSeen { lock: summary(l) })
        }
        // While the refund is unconfirmed a revealed secret still counts: if
        // Alice's claim was mined first, the refund reverted and the NOID is Bob's.
        B::Locked { lock, .. } | B::RefundSubmitted { lock, .. } => {
            if let Some(r) = eth.refunded.as_ref().filter(|r| r.lock_id == lock.lock_id) {
                return Some(Event::EthRefundMined { block_number: r.block_number });
            }
            if let Some(seen) = bob_preimage_fact(file, lock, noid, eth, now, notes) {
                return seen;
            }
            // CHAOS F-5: the refund transaction is not on chain, the lock is still open, nothing of the signer is pending.
            if let B::RefundSubmitted { submitted_at, .. } = p {
                let open = eth.find_lock(&lock.lock_id).is_some_and(|l| !l.claimed && !l.refunded);
                if open && eth_tx_dropped(eth, *submitted_at, now, tx_grace(file), "refund (HTLC.refund)", notes) {
                    return Some(Event::EthRefundDropped);
                }
            }
            None
        }
        // M2.5b: the refund is mined, not final: the F6 rule applied to the ETH leg. It becomes final with Ethereum's
        // finality; a re-inclusion at another block restarts the count; a reorg that drops it brings `locked` back, and
        // one that replaces it by Alice's claim gives Bob the secret.
        B::RefundMined { lock, block_number, .. } => {
            if let Some(r) = eth.refunded.as_ref().filter(|r| r.lock_id == lock.lock_id) {
                // REVIEW-4 R4-7: a refund read only from the `getLock` record (no `Refunded` log: a lagging index, a capped range) carries
                // the poll's head as an upper bound of its block, which only grows. It is the same refund, first seen at the block
                // recorded: finality is counted from there (as for Alice's claim), not restarted at every poll.
                let from_record_only = eth.claim_state_from_record && r.tx_hash == [0u8; 32];
                if r.block_number != *block_number && !(from_record_only && r.block_number > *block_number) {
                    notes.push(format!(
                        "the refund of our lock moved from ETH block {block_number} to {} (re-included after a reorg); the finality count starts over",
                        r.block_number
                    ));
                    return Some(Event::EthRefundMined { block_number: r.block_number });
                }
                return eth.finalized_block.filter(|f| *f >= *block_number).map(|_| Event::EthRefundFinal);
            }
            if let Some(seen) = bob_preimage_fact(file, lock, noid, eth, now, notes) {
                return seen;
            }
            match eth.find_lock(&lock.lock_id) {
                Some(l) if !l.refunded && !l.claimed => {
                    notes.push(format!(
                        "the refund of our lock mined at ETH block {block_number} is no longer on the chain (a reorg dropped it before it was final): back to `locked`, refund_eth is offered again"
                    ));
                    Some(Event::EthRefundReorged { block_number: *block_number })
                }
                Some(_) => {
                    notes.push(format!(
                        "the refund recorded at ETH block {block_number} is not in this observation but the lock is closed: not going back (fail closed); check the chain by hand"
                    ));
                    None
                }
                None => {
                    notes.push(format!(
                        "the refund recorded at ETH block {block_number} is not in this observation and the lock is not visible: staying in `refund_mined` (fail closed)"
                    ));
                    None
                }
            }
        }
        B::SecretSeen { .. } => None,
        B::ClaimSubmitted { txid, .. } => tracked_outcome(noid, txid),
        B::ClaimIncluded { txid, height, lock, preimage, .. } => match included_outcome(noid, txid, *height) {
            Included::Final => Some(Event::NoidTxFinal { tip: noid.tip }),
            Included::Waiting => None,
            Included::Reincluded(h) => Some(Event::NoidTxReincluded { txid: txid.clone(), was_height: *height, height: h }),
            Included::Reorged { still_pending } => {
                // A file written before F6 does not hold the secret here; it is public on Ethereum by now.
                let secret = (*preimage).or_else(|| preimage_for(eth, lock.lock_id));
                if secret.is_none() {
                    notes.push(format!(
                        "the claim {txid} is no longer confirmed at height {height} (rolled back), but the secret is neither in the swap file nor visible on Ethereum: cannot go back to proving; check by hand"
                    ));
                    return None;
                }
                notes.push(reorg_note("claim", txid, *height, still_pending));
                Some(Event::NoidTxReorged { txid: txid.clone(), was_height: *height, still_pending, preimage: secret })
            }
            Included::Unchecked => {
                notes.push(unchecked_note("claim", txid, *height));
                None
            }
        },
        B::Done { .. } | B::Refunded { .. } | B::Aborted { .. } => None,
    }
}

/// A secret visible for Bob's lock, checked against `H` and `A`. `None`: no preimage is visible. `Some(None)`: one is, and
/// it was rejected (a note says why) or cannot be checked. `Some(Some(event))`: `EthPreimageSeen`.
fn bob_preimage_fact(
    file: &SwapFile,
    lock: &LockSummary,
    noid: &NoidObservation,
    eth: &EthObservation,
    now: u64,
    notes: &mut Vec<String>,
) -> Option<Option<Event>> {
    let candidates = preimage_candidates(eth, lock.lock_id);
    if candidates.is_empty() {
        return None;
    }
    let Ok(authority) = file.public.authority() else { return Some(None) };
    for x in &candidates {
        match check_preimage(x, &file.public.hashlock, &authority, file.public.params.variant) {
            Ok(()) => {
                let on_primary = eth.pending_preimage.as_ref().is_some_and(|p| p.lock_id == lock.lock_id && p.preimage == *x)
                    || eth.claimed.as_ref().is_some_and(|c| c.lock_id == lock.lock_id && c.preimage == *x);
                if !on_primary {
                    notes.push(
                        "REVIEW-4 R4-8: the secret was read from the SECOND Ethereum node; the first one does not show it (lagging or silent). It is checked against the hashlock and the NOID address"
                            .to_string(),
                    );
                }
                if on_primary && eth.claim_state_from_record && eth.pending_preimage.is_none() {
                    notes.push(
                        "REVIEW-3 F7: the secret was read from the contract's getLock record, not from a Claimed log (the log index lags or the --eth-from-block range misses it); the preimage is checked against the hashlock and the NOID address"
                            .to_string(),
                    );
                }
                return Some(Some(Event::EthPreimageSeen { preimage: *x, tip: noid.tip, time: eth_now(eth, now) }));
            }
            Err(e) => notes.push(format!("preimage seen but rejected: {e}")),
        }
    }
    Some(None)
}

/// REVIEW-3 F5: the primary node shows a pending call on the instance. `true` (with a note) only if a second node is
/// present, its poll is fresh, its tip is within [`MAX_NOID_TIP_DIFF`] blocks of the first and it shows NO pending call:
/// then Bob does not wait on it. With no second node, a second that could not be read, a stale or lagging one, or one that
/// shows a pending call too, the wait stands (a lagging node has not seen the call yet; that proves nothing).
fn second_node_sees_no_pending_call(noid: &NoidObservation, notes: &mut Vec<String>) -> bool {
    let Some(second) = noid.second.as_deref() else {
        return false;
    };
    let reference = noid.observed_at.unwrap_or(0);
    if let Some(why) = second_stale("noid (second node)", second.observed_at, reference) {
        notes.push(format!("the second node's view is not usable against the pending call: {why}; waiting on it (F5)"));
        return false;
    }
    let apart = noid.tip.abs_diff(second.tip);
    if apart > MAX_NOID_TIP_DIFF {
        notes.push(format!(
            "the second node's tip is {apart} blocks from the first (limit {MAX_NOID_TIP_DIFF}): its view is not usable against the pending call; waiting on it (F5)"
        ));
        return false;
    }
    if !second.pending_calls.is_empty() {
        return false;
    }
    notes.push("the primary node reports a pending call the second node does not see: not waiting on it (F5)".to_string());
    true
}

/// The NOID side of Bob's `secret_seen`: claim, wait, or (claim branch closed) abort. Unchanged by F9 except that the
/// instance is judged gone by slot and incarnation, and that the caller may turn a wait or an abort into `refund_eth`.
fn bob_claim_action(file: &SwapFile, preimage: &[u8; 32], noid: &NoidObservation, notes: &mut Vec<String>) -> Action {
    let params_ = &file.public.params;
    let g = params_.profile.gates();
    let d = params_.deadline_height;
    if our_instance_gone(file, noid) {
        // Closed by a transaction we did not track (a lost submission of
        // ours after a crash, or a third party paying Bob): a human must
        // check the receipts; re-proving would only burn time.
        return Action::Wait {
            reason: "the instance is gone but no tracked transaction closed it; verify the contract receipts manually".into(),
        };
    }
    if !noid.pending_calls.is_empty() {
        // T2: a close is already pending (any valid one pays Bob). The
        // first-seen mempool would refuse ours, so do not burn a proof.
        // REVIEW-3 F5: unless a second node, fresh and level with the first, sees none. A lying primary could
        // otherwise keep Bob waiting until TooLate while Alice refunds at D.
        if !second_node_sees_no_pending_call(noid, notes) {
            return Action::Wait {
                reason: format!(
                    "a close by someone else is pending on the instance ({}); it pays B_noid if valid; proving again only after it is evicted (T2)",
                    noid.pending_calls[0].txid
                ),
            };
        }
    }
    let h = noid.next_call_height;
    match params::classify_claim_height(h, d) {
        ClaimHeight::TooLate => Action::Abort {
            reason: format!("claim branch closed: next call height {h} >= D {d}; Alice can refund"),
        },
        ClaimHeight::LateButValid => {
            notes.push(format!("claim at {h} is past the D-18 target; proving anyway"));
            Action::ClaimNoid { call_height: h, fee_micronoid: close_fee_for(params_.contract_version, noid, params_.max_fee_micronoid), preimage: *preimage }
        }
        ClaimHeight::OnTarget => match g.rotation_guard(h) {
            RotationGuard::WaitForBoundary { blocks } => Action::Wait {
                reason: format!("epoch anchor rotates in {blocks} block(s); proving after the boundary (T6)"),
            },
            RotationGuard::ProveNow => {
                Action::ClaimNoid { call_height: h, fee_micronoid: close_fee_for(params_.contract_version, noid, params_.max_fee_micronoid), preimage: *preimage }
            }
        },
    }
}

/// REVIEW-2 F9: Bob's lock was refunded while he is past the secret (his claim of the NOID is, or was, going on). A
/// log-only fact, once: the history is the memory, as for Alice's `eth_refund_mined`.
fn bob_refund_seen(file: &SwapFile, p: &BobPhase, eth: &EthObservation) -> Option<Event> {
    use BobPhase as B;
    if file.history.iter().any(|h| h.event == "eth_refund_mined") {
        return None;
    }
    let lock = match p {
        B::SecretSeen { lock, .. } | B::ClaimSubmitted { lock, .. } | B::ClaimIncluded { lock, .. } => lock,
        B::Done { lock: Some(lock), .. } => lock,
        _ => return None,
    };
    let r = eth.refunded.as_ref().filter(|r| r.lock_id == lock.lock_id)?;
    Some(Event::EthRefundMined { block_number: r.block_number })
}

/// CHAOS F-5: after the secret Bob's ETH refund is tracked by the history only (`eth_refund_submitted`). If the last such entry is
/// old, the lock is still open and the signer has nothing pending, record `eth_refund_dropped` (log-only) so the refund is offered
/// again. Once per submission: the entry must be newer than the last `eth_refund_dropped`.
fn bob_refund_dropped(file: &SwapFile, p: &BobPhase, eth: &EthObservation, now: u64, notes: &mut Vec<String>) -> Option<Event> {
    use BobPhase as B;
    let lock = match p {
        B::SecretSeen { lock, .. } | B::ClaimSubmitted { lock, .. } | B::ClaimIncluded { lock, .. } => lock,
        B::Done { lock: Some(lock), .. } => lock,
        _ => return None,
    };
    let sub = last_history(file, "eth_refund_submitted")?;
    if last_history(file, "eth_refund_dropped").is_some_and(|d| d > sub) {
        return None;
    }
    let open = eth.find_lock(&lock.lock_id).is_some_and(|l| !l.claimed && !l.refunded);
    let since = file.history[sub].at;
    (open && eth_tx_dropped(eth, since, now, tx_grace(file), "refund (HTLC.refund)", notes)).then_some(Event::EthRefundDropped)
}

/// REVIEW-4 R4-2: what the swap file knows about a `lock_eth` intent that `intent --cancel` dropped.
enum CancelledLock {
    /// None was cancelled: Bob chooses `T_reveal` afresh.
    None,
    /// The `T_reveal` of the first cancelled `lock_eth` intent (its lock id is the one that may still land).
    Known(u64),
    /// The history shows a cancel but the file holds no record of the intent (written before R4-2): the lock id is unknown.
    Unrecorded,
}

fn cancelled_lock(file: &SwapFile) -> CancelledLock {
    let first = file.cancelled_intents.iter().filter(|i| i.action == "lock_eth").find_map(|i| i.params.get("t_reveal").and_then(Value::as_u64));
    match first {
        Some(t0) => CancelledLock::Known(t0),
        None if file.history.iter().any(|h| h.event == "intent_cancelled:lock_eth") => CancelledLock::Unrecorded,
        None => CancelledLock::None,
    }
}

/// REVIEW-4 R4-2: may the cancelled lock (`T_reveal` `t0`) still be sent? The re-send rule of Review H2 (`I1`, `M_A`, `W_A_min` measured
/// to the block it is likely mined in) and Bob's lock-by height.
fn lock_reuse_safe(file: &SwapFile, noid: &NoidObservation, eth: &EthObservation, t0: u64, now: u64) -> bool {
    let g = file.public.params.profile.gates();
    let d = file.public.params.deadline_height;
    let t_now = now.min(eth.latest_timestamp.max(1));
    let chain_now = eth_now(eth, now);
    noid.tip <= g.bob_lock_by_min_window(d)
        && g.check_i1_eth(d, noid.tip, t0, t_now).is_ok()
        && t0.saturating_sub(chain_now) >= g.m_a_s
        && t0.saturating_sub(chain_now.saturating_add(g.de_s)) >= g.w_a_min_s
}

/// REVIEW-4 R4-6: why Bob's Ethereum leg is not settled for good yet, or `None` when the lock is closed in a final block (a refund of his, or
/// Alice's claim).
fn eth_leg_not_settled(lock: &LockSummary, eth: &EthObservation) -> Option<String> {
    let Some(l) = eth.find_lock(&lock.lock_id) else {
        return Some("the ETH lock is not visible in this poll".to_string());
    };
    if !l.claimed && !l.refunded {
        return Some("the ETH lock is still open".to_string());
    }
    let closed_at = eth
        .refunded
        .as_ref()
        .filter(|r| r.lock_id == lock.lock_id)
        .map(|r| r.block_number)
        .or_else(|| eth.claimed.as_ref().filter(|c| c.lock_id == lock.lock_id).map(|c| c.block_number));
    match (closed_at, eth.finalized_block) {
        (Some(b), Some(f)) if f >= b => None,
        (Some(b), f) => Some(format!("the ETH lock was closed at block {b}, which is not final yet (finalized block {})", f.map_or_else(|| "unknown".to_string(), |f| f.to_string()))),
        (None, _) => Some("the block that closed the ETH lock is unknown".to_string()),
    }
}

/// What is left of Bob's Ethereum lock once the secret is known (REVIEW-2 F9).
enum EthLeft {
    /// Open, past `T_reveal`, no refund sent yet: `refund_eth`.
    Offer(Action),
    /// Open but not refundable yet (or a refund is on its way): say so.
    Waiting(String),
    /// Closed (claimed or refunded), not visible, or not known to this file.
    Nothing,
}

fn bob_eth_left(file: &SwapFile, lock: &LockSummary, eth: &EthObservation) -> EthLeft {
    let Some(l) = eth.find_lock(&lock.lock_id) else { return EthLeft::Nothing };
    if l.claimed || l.refunded {
        return EthLeft::Nothing;
    }
    // CHAOS F-5: a submission that was later recorded as dropped does not count.
    if last_history(file, "eth_refund_submitted") > last_history(file, "eth_refund_dropped") {
        return EthLeft::Waiting("the ETH refund was already submitted; waiting for it to be mined".into());
    }
    if params::bob_eth_refund_ready(eth.latest_timestamp, lock.t_reveal) {
        EthLeft::Offer(Action::RefundEth { lock_id: lock.lock_id })
    } else {
        EthLeft::Waiting(format!(
            "the ETH lock is still open: refund_eth opens at T_reveal {} (chain time {})",
            lock.t_reveal, eth.latest_timestamp
        ))
    }
}

/// REVIEW-2 F9: put the NOID side (`base`: what the phase decided about the claim) and the ETH side together, one
/// action per tick. The claim goes first while it is still possible; the refund follows on the next tick (the claim's
/// phase moves on once it is submitted). A claim branch that closed is no reason to abort while the lock is refundable.
fn bob_with_eth_left(base: Action, left: EthLeft, notes: &mut Vec<String>) -> Action {
    match (base, left) {
        (claim @ Action::ClaimNoid { .. }, EthLeft::Offer(_)) => {
            notes.push("refund_eth is also due (the ETH lock is open past T_reveal); it is offered once the claim has been submitted".into());
            claim
        }
        (Action::Abort { reason }, EthLeft::Offer(refund)) => {
            notes.push(format!("{reason}; not aborting: the ETH lock is still open past T_reveal, so refund_eth first"));
            refund
        }
        (Action::Abort { reason }, EthLeft::Waiting(w)) => {
            notes.push(format!("not aborting: {reason}; but {w}"));
            Action::Wait { reason: format!("{reason}; {w}") }
        }
        (Action::Wait { reason }, EthLeft::Offer(refund)) => {
            notes.push(format!("the NOID side is waiting ({reason}); the ETH lock is open past T_reveal, so refund_eth"));
            refund
        }
        (base, _) => base,
    }
}

fn bob_action(
    file: &SwapFile,
    p: &BobPhase,
    noid: &NoidObservation,
    eth: &EthObservation,
    now: u64,
    notes: &mut Vec<String>,
) -> Action {
    use BobPhase as B;
    let params_ = &file.public.params;
    let g = params_.profile.gates();
    let d = params_.deadline_height;
    match p {
        B::Received => {
            // The hard limit is the lock-by height with the minimum reveal window
            // (design step 8 lets Bob shrink W_A down to W_A_min); `lock_by_height`
            // in the file is the nominal one for the full window.
            let last = g.bob_lock_by_min_window(d);
            if noid.tip > last {
                return Action::Abort {
                    reason: format!("last lock height {last} passed before Alice's funding was final"),
                };
            }
            Action::Wait { reason: "waiting for Alice's funding".into() }
        }
        B::Funded { .. } => Action::Wait { reason: "waiting for funding finality".into() },
        B::FundingFinal { instance, final_at_tip } => {
            // Step 7: the instance is ours, final, unspent, and we are in time.
            match instance_ok(file, noid) {
                Ok(()) => {}
                // REVIEW-2 F10: several instances fit; the tool does not lock on a guess. Not an abort: it may clear up.
                Err(InstanceProblem::Ambiguous(why)) => {
                    notes.push(format!("not lock_eth: {why}"));
                    return Action::Wait { reason: format!("more than one instance at the contract root: {why}") };
                }
                Err(InstanceProblem::Rejected(e)) => return Action::Abort { reason: format!("funding check failed: {e}") },
            }
            if let Some(active) = &noid.active_authority {
                if active != &file.public.claim_authority {
                    return Action::Abort { reason: "the contract is already on the recovery branch".into() };
                }
            }
            if !noid.pending_calls.is_empty() {
                return Action::Wait {
                    reason: format!("{} pending call(s) spend the instance; not locking", noid.pending_calls.len()),
                };
            }
            // T5: F_max must still clear m x the live fee estimate (m = 3 for contract v1, 5 for v2), or a
            // relay floor could strand Bob's claim.
            if let Some(est) = noid.fee_estimate_1_1 {
                let m = params_.contract_version.f_max_multiplier();
                let needed = est.saturating_mul(m).max(params::F_MAX_FLOOR_MICRONOID);
                if params_.max_fee_micronoid < needed {
                    return Action::Abort {
                        reason: format!(
                            "F_max {} is below max(50,000, {m} x estimate {est}) = {needed}: the contract v{} rule (multiplier {m}) (T5)",
                            params_.max_fee_micronoid,
                            params_.contract_version.number()
                        ),
                    };
                }
            }
            // Without a chain timestamp (I1) cannot be evaluated: wait, do not let the
            // missing clock turn into an abort or into a lock with a bogus T_reveal.
            if eth.latest_timestamp == 0 {
                notes.push("not lock_eth: eth.latest_timestamp unknown (fail closed)".into());
                return Action::Wait { reason: "eth.latest_timestamp unknown".into() };
            }
            // Bob's clock for (I1): the EARLIER of our clock and the chain's, so a
            // lagging node or a slow clock can only shorten the window he grants.
            let t_now = now.min(eth.latest_timestamp.max(1));
            // REVIEW-4 R4-2: after `intent --cancel` of a `lock_eth` the dropped send may still be in some node's mempool. A lock
            // chosen afresh would get a NEW `T_reveal`, hence a new lock id, and both could land. So the cancelled lock's own
            // `T_reveal` is used again (the same lock id: a duplicate reverts in `HTLC.sol`) while the gates still hold for it;
            // otherwise Bob walks away. Never a fresh `T_reveal` after a cancel.
            let chosen: Result<u64, String> = match cancelled_lock(file) {
                CancelledLock::None => g.choose_t_reveal(d, noid.tip, t_now, *final_at_tip).map_err(|e| format!("not locking: {e}")),
                CancelledLock::Known(t0) => {
                    if lock_reuse_safe(file, noid, eth, t0, now) {
                        notes.push(format!(
                            "a lock_eth intent was cancelled earlier: locking with ITS T_reveal {t0} (the same lock id; a duplicate of the cancelled send reverts), never a fresh one (REVIEW-4 R4-2)"
                        ));
                        Ok(t0)
                    } else {
                        Err(format!(
                            "not locking: the lock of the cancelled lock_eth intent (T_reveal {t0}) is no longer safe to send, and a fresh T_reveal would be a second lock id while the cancelled send may still land; Bob walks away (REVIEW-4 R4-2). If that lock does land, refund it at T_reveal from the wallet"
                        ))
                    }
                }
                CancelledLock::Unrecorded => Err(
                    "not locking: a lock_eth intent was cancelled before this file recorded cancelled intents, so its T_reveal is unknown and a new lock could get a second lock id while the cancelled send may still land; Bob walks away (REVIEW-4 R4-2). If a lock of his lands, refund it at T_reveal from the wallet"
                        .to_string(),
                ),
            };
            match chosen {
                Ok(t_reveal) => {
                    if noid.instance.as_ref().map(|i| i.creation_id) != Some(instance.creation_id) {
                        return Action::Abort { reason: "instance incarnation changed".into() };
                    }
                    Action::LockEth {
                        hashlock: file.public.hashlock,
                        t_reveal,
                        receiver: params_.eth.alice_receiver,
                        amount_wei: params_.eth.amount_wei,
                    }
                }
                Err(e) => Action::Abort { reason: e },
            }
        }
        B::LockSubmitted { t_reveal, .. } => {
            // Review H2: a dropped lock is re-sent with the SAME terms (same `T_reveal`, same lock id, so a duplicate that lands
            // anyway reverts) and only while (I1) and `M_A` still hold; never as a fresh lock under a new id.
            if last_history(file, "eth_lock_dropped") > last_history(file, "lock_submitted") {
                let t_now = now.min(eth.latest_timestamp.max(1));
                // (I1), and a reveal window that stays >= W_A_min measured to the block the re-sent lock is likely mined in (CHAOS F-8's rule,
                // applied here): Alice's (I3) check measures from that block, so a lock that would come up short is not worth sending.
                let ok = g.check_i1_eth(d, noid.tip, *t_reveal, t_now).is_ok()
                    && t_reveal.saturating_sub(eth_now(eth, now)) >= g.m_a_s
                    && t_reveal.saturating_sub(eth_now(eth, now).saturating_add(g.de_s)) >= g.w_a_min_s;
                // The lock was dropped and its terms are no longer safe: once chain time has reached its `T_reveal` even a late landing
                // would be refundable at once and no longer a swap, so Bob stops (`aborted`) instead of waiting for ever.
                if !ok && eth_now(eth, now) >= *t_reveal {
                    return Action::Abort {
                        reason: format!("the lock with T_reveal {t_reveal} was dropped, is not safe to re-send and its T_reveal has passed; if it still lands, refund it from the wallet"),
                    };
                }
                return if ok {
                    notes.push(format!("the lock transaction was dropped: re-sending the same lock (T_reveal {t_reveal})"));
                    Action::LockEth { hashlock: file.public.hashlock, t_reveal: *t_reveal, receiver: params_.eth.alice_receiver, amount_wei: params_.eth.amount_wei }
                } else {
                    Action::Wait {
                        reason: format!("the lock with T_reveal {t_reveal} was dropped and is no longer safe to re-send ((I1) or the M_A margin fails); check Ethereum, it may still land")
                    }
                };
            }
            Action::Wait { reason: "lock not yet visible".into() }
        }
        B::Locked { lock, .. } => {
            if params::bob_eth_refund_ready(eth.latest_timestamp, lock.t_reveal) {
                return Action::RefundEth { lock_id: lock.lock_id };
            }
            // REVIEW-4 R4-8: while Bob waits for the secret his only eyes are the Ethereum node. One that lags (or stalls) can show him
            // Alice's reveal after `D` has closed his claim branch. The same limit as before the lock, checked on every tick, said loudly.
            match eth_lag_alarm(file, eth, now) {
                Some(alarm) => {
                    notes.push(format!("ALARM: {alarm}"));
                    Action::Wait {
                        reason: format!(
                            "waiting for the secret (or T_reveal); ALARM, THE ETHEREUM NODE LAGS: {alarm}. Bob cannot see Alice's reveal through it, and the NOID claim branch closes at D {d}; switch --eth-rpc to a healthy node now (REVIEW-4 R4-8)"
                        ),
                    }
                }
                None => Action::Wait { reason: "waiting for the secret (or T_reveal)".into() },
            }
        }
        B::SecretSeen { lock, preimage, .. } => {
            let base = bob_claim_action(file, preimage, noid, notes);
            let action = bob_with_eth_left(base, bob_eth_left(file, lock, eth), notes);
            // REVIEW-4 R4-6 (found by the chaos test): an `abort` ends the file, so it is given only once the Ethereum leg is settled for good:
            // the lock is closed (claimed or refunded) in a block that is final. A refund that a reorg can still take back, or a lock this poll
            // does not show, would leave Bob `aborted` over an ETH lock that is open again (scenario 2425 of seed 0xc4a05eed).
            if let Action::Abort { reason } = &action {
                if let Some(why) = eth_leg_not_settled(lock, eth) {
                    notes.push(format!("not aborting yet: {why}"));
                    return Action::Wait { reason: format!("{reason}; not aborting yet: {why}") };
                }
            }
            action
        }
        B::ClaimSubmitted { lock, .. } => {
            bob_with_eth_left(Action::Wait { reason: "NOID claim pending".into() }, bob_eth_left(file, lock, eth), notes)
        }
        B::ClaimIncluded { lock, .. } => {
            bob_with_eth_left(Action::Wait { reason: "waiting for NOID claim finality".into() }, bob_eth_left(file, lock, eth), notes)
        }
        B::RefundSubmitted { .. } => Action::Wait { reason: "ETH refund pending".into() },
        B::RefundMined { block_number, .. } => Action::Wait {
            reason: format!(
                "ETH refund mined at block {block_number}; waiting for Ethereum finality (finalized block {})",
                eth.finalized_block.map_or_else(|| "unknown".to_string(), |f| f.to_string())
            ),
        },
        B::Done { lock, .. } => {
            let base = Action::Wait { reason: "done: NOID received".into() };
            match lock.as_ref().map(|l| bob_eth_left(file, l, eth)) {
                Some(EthLeft::Waiting(w)) => Action::Wait { reason: format!("done: NOID received; {w}") },
                Some(left) => bob_with_eth_left(base, left, notes),
                None => base,
            }
        }
        B::Refunded { .. } => Action::Wait { reason: "done: ETH refunded".into() },
        B::Aborted { reason } => Action::Wait { reason: format!("aborted: {reason}") },
    }
}

// ---------------------------------------------------------------- the intent ledger (REVIEW-2 F3)

/// The actions the operator performs OUTSIDE this tool (`parano1d-cli contract fund`, `live.js lock`,
/// `live.js claim`, `live.js refund`, the stock wallet's recovery close). Each one is recorded in the
/// swap file as a [`PendingIntent`] before `tick --apply` prints it.
pub const INTENT_KINDS: [&str; 5] = ["fund_noid", "lock_eth", "reveal_eth", "refund_eth", "refund_noid"];

/// What the ledger did on one tick.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum IntentStatus {
    /// Nothing pending, nothing recorded.
    None,
    /// Decided and persisted by this tick: the printed action is the one to send.
    Recorded(PendingIntent),
    /// Pending from an earlier tick, effect not on chain yet: the action was replaced by `wait`.
    Held(PendingIntent),
    /// The chain now shows the effect (or the phase moved past it): resolved into the history.
    Resolved(PendingIntent),
}

/// The result of [`tick_apply`].
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TickOutcome {
    pub decision: Decision,
    pub intent: IntentStatus,
}

/// Does the chain show the effect of `intent` (or has the swap moved past it)? `file` already has this
/// tick's events applied. The phase moves for every effect that has a phase (instance seen, lock seen,
/// claim mined, refund mined); the two NOID effects without a phase of their own are read directly.
///
/// The two refunds are judged by their own chain, never by a phase change (REVIEW-2 F9): after the reveal Alice's phase
/// moves for reasons of its own (`revealed` -> `done`), and after the secret Bob's claim moves his, while the refund is
/// still unsent. `refund_noid` is seen when the instance this file recorded is gone (or the phase is one of the
/// refund phases); `refund_eth` when the lock it names is refunded or claimed (or the phase is `refund_submitted` /
/// `refunded`). Until then the intent holds and the same refund is not offered twice.
fn intent_effect_seen(file: &SwapFile, intent: &PendingIntent, noid: &NoidObservation, eth: &EthObservation) -> bool {
    use crate::state::{AlicePhase as A, BobPhase as B};
    match intent.action.as_str() {
        "refund_noid" => {
            return our_instance_gone(file, noid)
                || matches!(&file.phase, Phase::Alice(A::RefundSubmitted { .. } | A::RefundIncluded { .. } | A::Refunded { .. }))
        }
        "refund_eth" => {
            let closed = intent
                .params
                .get("lock_id")
                .and_then(Value::as_str)
                .and_then(|h| hex::decode(h.trim_start_matches("0x")).ok())
                .and_then(|b| <[u8; 32]>::try_from(b).ok())
                .and_then(|id| eth.find_lock(&id))
                .is_some_and(|l| l.refunded || l.claimed);
            return closed || matches!(&file.phase, Phase::Bob(B::RefundSubmitted { .. } | B::RefundMined { .. } | B::Refunded { .. }));
        }
        _ => {}
    }
    if file.phase.name() != intent.phase_at_decision {
        return true;
    }
    match intent.action.as_str() {
        // A funded instance is visible at our root (even one the engine did not accept: do not fund twice).
        "fund_noid" => noid.instance.is_some(),
        _ => false,
    }
}

fn intent_wait_reason(intent: &PendingIntent) -> String {
    format!(
        "intent {} pending since {} (unix): the chain does not show it yet; reuse the printed parameters, or `swap-cli intent FILE --cancel` (with the same chain flags as tick) if nothing was sent",
        intent.action, intent.decided_at
    )
}

/// The `tick --apply` path as one function (the CLI calls exactly this): decide, apply the derived
/// events, then run the intent ledger. `file` is changed in memory only; the CALLER saves it before
/// printing anything. With `record == false` (a read-only `tick`) an existing intent still holds and
/// resolves, but no new intent is created.
///
/// Rules:
/// - a spending action of [`INTENT_KINDS`] is recorded (when `record`) and then returned once;
/// - while an intent is pending and unresolved, the output is `wait` with the frozen parameters in a
///   note, whatever the fresh decision says (except an `abort`, which is shown);
/// - the same spending action is therefore never emitted twice;
/// - `fund_noid` is not offered while an instance already sits at our root, nor `refund_noid` when the
///   instance is gone.
pub fn tick_apply(
    file: &mut SwapFile,
    noid: &NoidObservation,
    eth: &EthObservation,
    now: u64,
    record: bool,
) -> Result<TickOutcome, InvalidTransition> {
    let mut decision = decide(file, noid, eth, now);
    for e in &decision.events {
        file.apply(e, now)?;
    }
    let mut status = IntentStatus::None;
    if let Some(intent) = file.pending_intent.clone() {
        if intent_effect_seen(file, &intent, noid, eth) {
            file.log(format!("intent_resolved:{}", intent.action), now);
            file.pending_intent = None;
            status = IntentStatus::Resolved(intent);
        }
    }
    // Guards that only make sense against the ledger's own kinds.
    let kind = decision.action.kind();
    if kind == "fund_noid" && noid.instance.is_some() {
        let why = "an instance already exists at our contract root but was not accepted; not funding again (check its amount and the contract state)".to_string();
        decision.notes.push(format!("not fund_noid: {why}"));
        decision.action = Action::Wait { reason: why };
    } else if kind == "refund_noid" && our_instance_gone(file, noid) {
        let why = "the instance is not visible, so there is nothing to refund (already closed? verify the contract receipts)".to_string();
        decision.notes.push(format!("not refund_noid: {why}"));
        decision.action = Action::Wait { reason: why };
    }
    // CHAOS F-1: the CLI path records an `abort` too (the Runner always did), so the file ends instead of printing `abort` at every
    // tick. Not while an intent is pending: the operator may have sent that spend (a funding, a lock) and the chain not shown it yet,
    // and a file that says `aborted` over a live funding or lock is worse than one that keeps saying `abort`. Cancel the intent, or
    // let the chain resolve it, and the next tick records it. A read-only tick (`record == false`) records nothing.
    if let Action::Abort { reason } = &decision.action {
        if record {
            if let Some(kind) = spend_may_be_in_flight(file, now) {
                decision.notes.push(format!(
                    "abort not recorded: a {kind} was decided for this swap and never cancelled, so it may have been sent (a funding or a lock that the chain does not show yet, or that a reorg took back). Look at the wallet / the contract; `swap-cli intent FILE --cancel` records that it was not sent"
                ));
            } else {
                let event = Event::Abort { reason: reason.clone() };
                if file.apply(&event, now).is_ok() {
                    decision.events.push(event);
                    file.pending_action = None;
                } else {
                    decision.notes.push(format!("abort not recorded: not allowed in phase `{}`", file.phase.name()));
                }
            }
        }
    }
    if let Some(intent) = file.pending_intent.clone() {
        if !matches!(decision.action, Action::Abort { .. }) {
            // `claim_noid` is not a ledger kind, yet it is a different action from any pending intent (REVIEW-2 F9: a
            // pending `refund_eth` must not hold Bob's claim of the NOID back).
            let other_spend = (INTENT_KINDS.contains(&decision.action.kind()) || decision.action.kind() == "claim_noid")
                && decision.action.kind() != intent.action;
            if other_spend && decision.action.kind() == "claim_noid" {
                decision.notes.push(format!("note: a {} intent is still pending (since {}); this {} is a different action", intent.action, intent.decided_at, decision.action.kind()));
            } else if other_spend {
                // REVIEW-4 R4-10: the ledger holds ONE intent. A different ledger spend beside it (a `refund_noid` due at D beside a
                // held `reveal_eth`) would be printed with its parameters on every tick and never recorded, the one ledger kind that
                // could go out twice. So it is refused until the held intent resolves or is cancelled. Nothing is lost by the wait:
                // after D only the recovery branch is open, so no counterparty races it.
                let due = decision.action.kind();
                decision.notes.push(format!(
                    "held: a {due} is due, but a {} intent is still pending (since {}); the ledger holds one intent, so {due} is not printed until that one resolves (the chain shows it) or is cancelled with `swap-cli intent FILE --cancel` (REVIEW-4 R4-10)",
                    intent.action, intent.decided_at
                ));
                decision.notes.push(format!("frozen parameters of the pending {}: {}", intent.action, intent.params));
                decision.action = Action::Wait { reason: format!("{due} is due but {}", intent_wait_reason(&intent)) };
            } else {
                if decision.action.has_side_effect() || matches!(decision.action, Action::Wait { .. }) {
                    decision.notes.push(format!("held: fresh decision was {}", decision.action.kind()));
                }
                decision.notes.push(format!("frozen parameters of the pending {}: {}", intent.action, intent.params));
                decision.action = Action::Wait { reason: intent_wait_reason(&intent) };
            }
        }
        if status == IntentStatus::None {
            status = IntentStatus::Held(intent);
        }
    } else if record && INTENT_KINDS.contains(&decision.action.kind()) {
        let mut params = serde_json::to_value(&decision.action).unwrap_or_default();
        // REVIEW-3 F3: the reveal intent carries the lock's `T_reveal` and the cutoff the file's `M_A` gives, so that
        // `live.js claim --swap FILE` re-checks the cutoff from the file and not from a free `--margin-s` flag.
        if let Action::RevealEth { lock_id } = &decision.action {
            if let Some(l) = eth.find_lock(lock_id) {
                params["t_reveal"] = serde_json::json!(l.timelock);
                params["cutoff"] = serde_json::json!(reveal_cutoff_for(file, l.timelock));
            }
        }
        let intent = PendingIntent {
            action: decision.action.kind().to_string(),
            params,
            decided_at: now,
            phase_at_decision: file.phase.name(),
            noid_tip: noid.tip,
            eth_block: eth.latest_block,
        };
        file.log(format!("intent_decided:{}", intent.action), now);
        file.pending_intent = Some(intent.clone());
        status = IntentStatus::Recorded(intent);
    }
    Ok(TickOutcome { decision, intent: status })
}

/// CHAOS F-1: has a `fund_noid` / `lock_eth` been decided for this swap (a ledger intent) without a later `intent_cancelled`? If so
/// it may have been sent, and a file must not say `aborted` over a funding or a lock the chain has not shown (yet). Returns its kind.
fn spend_may_be_in_flight(file: &SwapFile, now: u64) -> Option<&'static str> {
    // REVIEW-4 R4-6: the hold applies only while the spend may still be on its way. A `lock_eth` the file has already SEEN on chain (the
    // phase holds the lock: Bob is past `funding_final` / `lock_submitted`, e.g. in `secret_seen`) is not in flight any more, so an abort
    // decided then (the claim branch closed on him) is recorded. A `fund_noid` stays held: the only phase an abort can end Alice's file
    // from is `created`, which means no funding of hers was accepted, and a visible instance that did not fit (a dust instance) is not
    // proof that hers has landed (a funding that a reorg took back lands again).
    let lock_seen = match &file.phase {
        Phase::Bob(p) => p.lock().is_some(),
        Phase::Alice(_) => false,
    };
    ["fund_noid", "lock_eth"].into_iter().find(|kind| {
        if *kind == "lock_eth" && lock_seen {
            return false;
        }
        let decided = last_history(file, &format!("intent_decided:{kind}"));
        let cancelled = last_history(file, &format!("intent_cancelled:{kind}"));
        // Review M1: a cancel is only as good as the one node's view of the mempool behind it, so a cancelled send keeps the abort
        // back for an hour (the next ticks record it): a transaction still queued elsewhere has landed by then.
        let recently_cancelled = cancelled.is_some_and(|c| now.saturating_sub(file.history[c].at) < ABORT_AFTER_CANCEL_S);
        decided.is_some() && (decided > cancelled || recently_cancelled)
    })
}

/// Review M1: how long after `intent --cancel` of a funding or a lock an `abort` is still not recorded.
pub const ABORT_AFTER_CANCEL_S: u64 = 3_600;

/// REVIEW-3 F3: the youngest an intent may be for `intent --cancel` to drop it. A send the operator made a moment ago can
/// be in a node's mempool where this tool's reads do not see it yet; ten minutes is more than a mempool takes to show it
/// and far less than any window of the protocol.
pub const MIN_CANCEL_AGE_S: u64 = 600;

/// `swap-cli intent FILE --cancel`: drop a pending intent that was never sent. A cancel is the one act that lets a SECOND
/// lock or funding out, so it fails closed (REVIEW-3 F3). Refused when:
/// 1. the chain already shows the effect (the observations decide, on a copy of the file);
/// 2. the intent is younger than [`MIN_CANCEL_AGE_S`];
/// 3. for `lock_eth`, `refund_eth`, `reveal_eth`: the signer's pending nonce is above its latest nonce (a transaction
///    sits in the node's mempool), or either nonce is unknown (the node, or the recording, could not say);
/// 4. for `refund_noid`: the instance shows a pending call in the mempool;
/// 5. for `lock_eth`: a lock with the intent's id is on the chain, even one this observation does not trust;
/// 6. for `fund_noid`: the node shows a funding in its mempool, or cannot say and the operator has not vouched for the wallet
///    (CHAOS F-15, [`cancel_intent_checked`]).
pub fn cancel_intent(file: &mut SwapFile, noid: &NoidObservation, eth: &EthObservation, now: u64) -> Result<PendingIntent, String> {
    cancel_intent_checked(file, noid, eth, now, false)
}

/// [`cancel_intent`] with the operator's word (`--i-checked-the-wallet`) that the wallet shows no funding transaction pending: the
/// only way to cancel a `fund_noid` intent when the node cannot say (CHAOS F-15; `NoidObservation::funding_pending` is `None` for
/// every real node). A node that does say (`Some(true)`) is believed over the operator.
pub fn cancel_intent_checked(
    file: &mut SwapFile,
    noid: &NoidObservation,
    eth: &EthObservation,
    now: u64,
    wallet_checked: bool,
) -> Result<PendingIntent, String> {
    let Some(intent) = file.pending_intent.clone() else {
        return Err("no pending intent".into());
    };
    let mut probe = file.clone();
    let out = tick_apply(&mut probe, noid, eth, now, false).map_err(|e| e.to_string())?;
    if matches!(out.intent, IntentStatus::Resolved(_)) {
        return Err(format!(
            "the chain already shows the effect of the {} intent (phase now {}); not cancelling. Run `tick --apply` to resolve it",
            intent.action,
            probe.phase.name()
        ));
    }
    let age = now.saturating_sub(intent.decided_at);
    if age < MIN_CANCEL_AGE_S {
        return Err(format!(
            "not cancelling: the {} intent is {age} s old, younger than {MIN_CANCEL_AGE_S} s (REVIEW-3 F3: a send made just now may not show in a mempool yet); look at the chain, wait, and try again",
            intent.action
        ));
    }
    // A lock that is on chain under the id this intent froze is the effect, whether or not this observation lets Bob recognise it
    // (a degraded chain id or code hash makes `lock_matches` fail and the intent look unresolved).
    if intent.action == "lock_eth" {
        if let Some(id) = expected_lock_id(file) {
            if eth.find_lock(&id).is_some() {
                return Err(format!(
                    "not cancelling: the lock {} of this intent is on the Ethereum chain (this observation may not trust it: check its chain id and code hash). It was sent",
                    short_id(&id)
                ));
            }
        }
    }
    match intent.action.as_str() {
        "lock_eth" | "refund_eth" | "reveal_eth" => match (eth.signer_nonce_latest, eth.signer_nonce_pending) {
            (Some(latest), Some(pending)) if pending > latest => {
                return Err(format!(
                    "not cancelling: the {} signer has a transaction in the Ethereum mempool (pending nonce {pending} > latest nonce {latest}); that may be this intent's send. Wait until it is mined or dropped (REVIEW-3 F3)",
                    intent.action
                ))
            }
            (Some(_), Some(_)) => {}
            (latest, pending) => {
                return Err(format!(
                    "not cancelling: the signer's Ethereum nonces are unknown (latest {latest:?}, pending {pending:?}), so a pending send cannot be ruled out. Ask a node that answers eth_getTransactionCount, and look at the chain (REVIEW-3 F3)"
                ))
            }
        },
        // CHAOS F-15: a funding that sits in the mempool (or that a reorg put back there) is not an instance yet; cancelling would let
        // the next tick print a SECOND funding.
        "fund_noid" => match noid.funding_pending {
            Some(true) => {
                return Err(
                    "not cancelling: a funding transaction for our contract root is in the Parano1d mempool; that may be this intent's send. Wait until it is included or dropped (CHAOS F-15)"
                        .into(),
                )
            }
            Some(false) => {}
            None if wallet_checked => {}
            None => {
                return Err(
                    "not cancelling: the node cannot say whether a funding for our contract root is waiting in its mempool (it lists the opening only for calls on an existing instance). Look at the wallet's pending transactions; if nothing is pending, run again with --i-checked-the-wallet (CHAOS F-15)"
                        .into(),
                )
            }
        },
        "refund_noid" if !noid.pending_calls.is_empty() => {
            return Err(format!(
                "not cancelling: {} call(s) on our instance sit in the Parano1d mempool ({}); that may be this refund. Wait until it is included or evicted (REVIEW-3 F3)",
                noid.pending_calls.len(),
                noid.pending_calls.iter().map(|c| c.txid.as_str()).collect::<Vec<_>>().join(", ")
            ))
        }
        _ => {}
    }
    file.log(format!("intent_cancelled:{}", intent.action), now);
    // REVIEW-4 R4-2: keep the dropped intent's frozen parameters (a cancelled `lock_eth` fixes the `T_reveal` of every later lock).
    file.cancelled_intents.push(intent.clone());
    file.pending_intent = None;
    Ok(intent)
}

// ---------------------------------------------------------------- executor and runner

/// Performs actions. The only implementations in this crate are test doubles
/// and the offline clients (`client::raw` builds and proves the claim and
/// hands the bytes to an `IntentSubmitter`).
pub trait Executor {
    /// Perform `action`; return the outcome event to record (`None` for nothing to record).
    fn execute(&mut self, file: &SwapFile, action: &Action, now: u64) -> Result<Option<Event>, ExecError>;
}

/// An action failed. `maybe_sent` is the safety-critical bit: `false` means the
/// executor knows nothing reached a chain (a precondition failed, every node
/// rejected the intent), so a retry is free; `true` means the outcome is
/// unknown (a crash, a timeout after sending), so the runner must not repeat
/// an action that would create a second on-chain object.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ExecError {
    pub message: String,
    pub maybe_sent: bool,
}

impl ExecError {
    pub fn not_sent(message: impl Into<String>) -> Self {
        Self { message: message.into(), maybe_sent: false }
    }

    pub fn unknown(message: impl Into<String>) -> Self {
        Self { message: message.into(), maybe_sent: true }
    }
}

impl fmt::Display for ExecError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}{}", self.message, if self.maybe_sent { " (outcome unknown)" } else { "" })
    }
}

/// Actions whose repetition is harmless on chain: a second identical lock
/// reverts (`LockAlreadyExists`), a second close of the same slot is refused by
/// the first-seen mempool, a second claim/refund of the HTLC reverts. Funding
/// is NOT in this set: `contract fund` twice creates two instances.
fn retry_safe(kind: &str) -> bool {
    matches!(kind, "lock_eth" | "claim_noid" | "refund_noid" | "refund_eth" | "reveal_eth")
}

/// The lock id this swap expects on Ethereum, once Bob's `T_reveal` is known
/// (from his phase or from a pending `lock_eth` record). Alice learns it from the chain.
pub fn expected_lock_id(file: &SwapFile) -> Option<[u8; 32]> {
    let p = &file.public.params.eth;
    let from_terms = |t_reveal: u64| compute_lock_id(&p.bob_sender, &p.alice_receiver, p.amount_wei, &file.public.hashlock, t_reveal);
    match &file.phase {
        Phase::Alice(a) => a.lock().map(|l| l.lock_id),
        Phase::Bob(b) => match b {
            BobPhase::LockSubmitted { t_reveal, .. } => Some(from_terms(*t_reveal)),
            other => other.lock().map(|l| l.lock_id).or_else(|| {
                file.pending_action
                    .as_ref()
                    .filter(|p| p.kind == "lock_eth")
                    .and_then(|p| p.detail.get("t_reveal").and_then(Value::as_u64))
                    // REVIEW-2 F3/F7: the intent `tick --apply` froze names the lock id too, so the
                    // watcher asks `getLock` for it directly on every poll.
                    .or_else(|| {
                        file.pending_intent
                            .as_ref()
                            .filter(|i| i.action == "lock_eth")
                            .and_then(|i| i.params.get("t_reveal").and_then(Value::as_u64))
                    })
                    // REVIEW-4 R4-2: a cancelled lock's id is still the one that may land, so the watcher keeps asking `getLock` for it.
                    .or_else(|| match cancelled_lock(file) {
                        CancelledLock::Known(t0) => Some(t0),
                        _ => None,
                    })
                    .map(from_terms)
            }),
        },
    }
}

impl std::error::Error for ExecError {}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RunnerError {
    File(SwapFileError),
    Transition(InvalidTransition),
}

impl fmt::Display for RunnerError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            RunnerError::File(e) => write!(f, "swap file: {e}"),
            RunnerError::Transition(e) => write!(f, "state: {e}"),
        }
    }
}

impl std::error::Error for RunnerError {}

impl From<SwapFileError> for RunnerError {
    fn from(e: SwapFileError) -> Self {
        RunnerError::File(e)
    }
}

impl From<InvalidTransition> for RunnerError {
    fn from(e: InvalidTransition) -> Self {
        RunnerError::Transition(e)
    }
}

/// What one tick did.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TickReport {
    pub events: Vec<String>,
    pub action: Action,
    pub outcome: Option<Event>,
    pub exec_error: Option<String>,
    pub attempt: u32,
    pub phase: String,
    pub notes: Vec<String>,
}

/// Drives one swap file with one executor, persisting before and after every action.
pub struct Runner<E: Executor> {
    pub file: SwapFile,
    pub path: PathBuf,
    pub executor: E,
}

impl<E: Executor> Runner<E> {
    /// Start a new swap: the file is written before anything else happens.
    pub fn create(file: SwapFile, path: PathBuf, executor: E) -> Result<Self, RunnerError> {
        file.save(&path)?;
        Ok(Self { file, path, executor })
    }

    /// Resume from disk.
    pub fn open(path: PathBuf, executor: E) -> Result<Self, RunnerError> {
        let file = SwapFile::load(&path)?;
        Ok(Self { file, path, executor })
    }

    pub fn tick(&mut self, noid: &NoidObservation, eth: &EthObservation, now: u64) -> Result<TickReport, RunnerError> {
        let decision = decide(&self.file, noid, eth, now);
        let mut notes = decision.notes;
        let mut names = Vec::new();
        let phase_before = self.file.phase.clone();
        for e in &decision.events {
            self.file.apply(e, now)?;
            names.push(e.name());
        }
        // A log-only event (Alice's `eth_refund_mined`) leaves the phase alone and so
        // must not resolve a pending action the way a phase move does.
        let moved = self.file.phase != phase_before;
        if !names.is_empty() {
            self.file.save(&self.path)?;
        }

        // A pending action from a previous run. A chain fact that moved the
        // phase this tick resolves it (its effect, or what supersedes it, was
        // seen). Otherwise: an action known not to have been sent is simply
        // retried; one whose outcome is unknown is retried only if a repeat is
        // harmless on chain (same lock id, same close), and NEVER turned into a
        // different action, an abort, or a second funding.
        let mut action = decision.action;
        let mut attempt = 1;
        if let Some(pending) = self.file.pending_action.clone() {
            if moved {
                self.file.clear_pending();
                self.file.save(&self.path)?;
            } else if !pending.maybe_sent {
                if pending.kind == action.kind() && action.has_side_effect() {
                    attempt = pending.attempt + 1;
                    action = reuse_pending(&self.file, action, &pending, noid, eth, now, &mut notes);
                } else {
                    self.file.clear_pending();
                    self.file.save(&self.path)?;
                }
            } else if pending.kind == action.kind() && retry_safe(&pending.kind) {
                attempt = pending.attempt + 1;
                action = reuse_pending(&self.file, action, &pending, noid, eth, now, &mut notes);
            } else {
                notes.push(format!("pending {} (attempt {}) has an unknown outcome; holding", pending.kind, pending.attempt));
                action = Action::Wait {
                    reason: format!(
                        "a {} was sent at {} and its outcome is unknown; waiting for it to appear on chain (clear the pending record by hand if it never will)",
                        pending.kind, pending.created_at
                    ),
                };
            }
        }

        if !action.has_side_effect() {
            if let Action::Abort { reason } = &action {
                self.file.apply(&Event::Abort { reason: reason.clone() }, now)?;
                names.push("abort".into());
                self.file.clear_pending();
            }
            self.file.save(&self.path)?;
            return Ok(TickReport {
                events: names,
                action,
                outcome: None,
                exec_error: None,
                attempt: 0,
                phase: self.file.phase.name(),
                notes,
            });
        }

        // Record the intent, then act, then record the outcome.
        // Recorded as "outcome unknown" first: if the process dies during the
        // action, the next run must assume it may have been sent.
        self.file.set_pending(PendingAction {
            kind: action.kind().into(),
            created_at: now,
            attempt,
            maybe_sent: true,
            detail: serde_json::to_value(&action).unwrap_or_default(),
        });
        self.file.save(&self.path)?;
        let (outcome, exec_error) = match self.executor.execute(&self.file, &action, now) {
            Ok(Some(ev)) => {
                self.file.apply(&ev, now)?;
                names.push(ev.name());
                self.file.clear_pending();
                (Some(ev), None)
            }
            Ok(None) => {
                self.file.clear_pending();
                (None, None)
            }
            // Keep the pending record with what the executor knows: the next
            // tick retries a not-sent action and holds an unknown one.
            Err(e) => {
                if let Some(p) = self.file.pending_action.as_mut() {
                    p.maybe_sent = e.maybe_sent;
                }
                (None, Some(e.to_string()))
            }
        };
        self.file.save(&self.path)?;
        Ok(TickReport { events: names, action, outcome, exec_error, attempt, phase: self.file.phase.name(), notes })
    }
}

/// On a restart with a recorded pending action of the same kind: a lock is
/// resent with the SAME `T_reveal` (so its lockId is the one already on its
/// way) if (I1) still holds for it; otherwise we wait for a human. Other
/// actions are recomputed (a claim needs the current call height).
fn reuse_pending(
    file: &SwapFile,
    action: Action,
    pending: &PendingAction,
    noid: &NoidObservation,
    eth: &EthObservation,
    now: u64,
    notes: &mut Vec<String>,
) -> Action {
    match action {
        Action::LockEth { hashlock, receiver, amount_wei, t_reveal: fresh } => {
            let recorded = pending.detail.get("t_reveal").and_then(|v| v.as_u64());
            match recorded {
                Some(t0) => {
                    let d = file.public.params.deadline_height;
                    let t_now = eth_now(eth, now);
                    let still_safe = file.public.params.profile.gates().check_i1_eth(d, noid.tip, t0, t_now).is_ok()
                        && t0.saturating_sub(t_now) >= file.public.params.profile.gates().m_a_s;
                    if still_safe {
                        notes.push(format!("resending the pending lock with its recorded T_reveal {t0} (attempt {})", pending.attempt + 1));
                        Action::LockEth { hashlock, receiver, amount_wei, t_reveal: t0 }
                    } else {
                        Action::Wait {
                            reason: format!(
                                "a lock with T_reveal {t0} may already be on its way but is no longer safe to resend (fresh would be {fresh}); check Ethereum before retrying"
                            ),
                        }
                    }
                }
                None => Action::LockEth { hashlock, receiver, amount_wei, t_reveal: fresh },
            }
        }
        other => {
            notes.push(format!("retrying pending {} (attempt {})", other.kind(), pending.attempt + 1));
            other
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::secret::{Secret, Variant};
    use crate::swapfile::{example_public, KdfParams, Passphrase};
    use crate::watch::{EthClaimed, NoidInstance};

    fn alice_file(secret: &Secret) -> SwapFile {
        SwapFile::new_alice(example_public(secret, Variant::Raw), secret, &Passphrase::new("pw"), &KdfParams::fast_for_tests(), 0)
            .unwrap()
    }

    fn bob_file(secret: &Secret) -> SwapFile {
        crate::swapfile::example_bob_file(example_public(secret, Variant::Raw), 0).unwrap()
    }

    fn noid_at(tip: u64) -> NoidObservation {
        NoidObservation { tip, next_call_height: tip + 1, fee_estimate_1_1: Some(6_000), fee_floor: Some(5_800), ..Default::default() }
    }

    /// `decide` on observations a healthy watcher would have produced: every field the
    /// gates read is filled in (from the file's own pinned values where the test left
    /// it `None`) and `observed_at` is `now`. The fail-closed tests call `super::decide`.
    fn decide(file: &SwapFile, noid: &NoidObservation, eth: &EthObservation, now: u64) -> Decision {
        let (mut n, mut e) = (noid.clone(), eth.clone());
        n.observed_at.get_or_insert(now);
        e.observed_at.get_or_insert(now);
        n.epoch_anchor.get_or_insert([7; 32]);
        // REVIEW-3 F5: an unknown header time blocks the NOID-side spends; these older tests are not about that.
        n.tip_time.get_or_insert(now);
        // REVIEW-2 F5: these older tests are about the gates of one node; the F5 tests below say otherwise on purpose.
        n.single_node_ok = true;
        e.single_node_ok = true;
        if n.instance.is_some() {
            n.instance_matches_opening.get_or_insert(true);
            n.active_authority.get_or_insert_with(|| file.public.claim_authority.clone());
        }
        e.chain_id.get_or_insert(file.public.params.eth.chain_id);
        if e.contract_code_hash.is_none() {
            e.contract_code_hash = file.public.params.eth.code_hash;
        }
        super::decide(file, &n, &e, now)
    }

    fn funded(tip: u64, amount: u64) -> NoidObservation {
        NoidObservation {
            instance: Some(NoidInstance { slot_index: 9, creation_id: 42, amount_micronoid: amount }),
            instance_matches_opening: Some(true),
            ..noid_at(tip)
        }
    }

    fn eth_at(block: u64, ts: u64) -> EthObservation {
        EthObservation { latest_block: block, latest_timestamp: ts, finalized_block: Some(block.saturating_sub(2)), ..Default::default() }
    }

    fn lock_for(file: &SwapFile, t_reveal: u64, block: u64) -> EthLock {
        let p = &file.public.params.eth;
        let lock_id = compute_lock_id(&p.bob_sender, &p.alice_receiver, p.amount_wei, &file.public.hashlock, t_reveal);
        EthLock {
            lock_id,
            sender: p.bob_sender,
            receiver: p.alice_receiver,
            amount_wei: p.amount_wei,
            hashlock: file.public.hashlock,
            timelock: t_reveal,
            block_number: block,
            tx_hash: [0xcc; 32],
            claimed: false,
            refunded: false,
            receiver_is_eoa: Some(true),
            sender_is_eoa: Some(true),
            block_timestamp: Some(t_reveal.saturating_sub(params::W_A_S)),
        }
    }

    #[test]
    fn alice_funds_first_and_only_in_time() {
        let s = Secret::generate().unwrap();
        let file = alice_file(&s);
        let d = decide(&file, &noid_at(300_001), &eth_at(1, 1_000), 1_000);
        assert_eq!(d.action, Action::FundNoid { amount_micronoid: 10_000_000 });
        assert!(d.events.is_empty());
        // Too late: Bob could not lock before his lock-by height (300,106).
        let d = decide(&file, &noid_at(300_080), &eth_at(1, 1_000), 1_000);
        assert!(matches!(d.action, Action::Abort { .. }));
    }

    #[test]
    fn alice_reveals_only_inside_i2_and_refunds_at_d() {
        let s = Secret::generate().unwrap();
        let mut file = alice_file(&s);
        let t_b = 1_000_000;
        let t_reveal = t_b + 7_200;
        // Funding seen and final.
        let d = decide(&file, &funded(300_005, 10_000_000), &eth_at(1, t_b), t_b);
        assert_eq!(d.events.len(), 1);
        file.apply(&d.events[0], 0).unwrap();
        let d = decide(&file, &funded(300_022, 10_000_000), &eth_at(1, t_b), t_b);
        assert_eq!(d.events, vec![Event::NoidFundingFinal { tip: 300_022 }]);
        file.apply(&d.events[0], 0).unwrap();
        assert!(matches!(d.action, Action::Wait { .. }));
        // Bob's lock appears, then becomes final: reveal.
        let mut eth = eth_at(10, t_b + 60);
        eth.lock = Some(lock_for(&file, t_reveal, 9));
        eth.finalized_block = Some(5);
        let d = decide(&file, &funded(300_040, 10_000_000), &eth, t_b + 60);
        assert_eq!(d.events.len(), 1, "{:?}", d.notes);
        assert!(matches!(d.action, Action::Wait { .. }));
        file.apply(&d.events[0], 0).unwrap();
        eth.finalized_block = Some(9);
        let d = decide(&file, &funded(300_045, 10_000_000), &eth, t_b + 120);
        assert_eq!(d.events, vec![Event::EthLockFinal]);
        file.apply(&d.events[0], 0).unwrap();
        assert!(matches!(d.action, Action::RevealEth { .. }));
        // At the cutoff + 1 s: never reveal; wait for D, then refund.
        let late = t_reveal - params::M_A_S + 1;
        let d = decide(&file, &funded(300_300, 10_000_000), &eth_at(50, late), late);
        assert!(matches!(d.action, Action::Wait { .. }), "{:?}", d.action);
        let d = decide(&file, &funded(300_734, 10_000_000), &eth_at(50, late), late);
        assert_eq!(d.action, Action::RefundNoid { call_height: 300_735, fee_micronoid: 6_000 });
        // A lock that pays someone else is rejected.
        let mut file2 = alice_file(&s);
        file2.apply(&Event::NoidInstanceSeen { instance: funded(0, 10_000_000).instance.unwrap(), tip: 300_005 }, 0).unwrap();
        file2.apply(&Event::NoidFundingFinal { tip: 300_022 }, 0).unwrap();
        let mut bad = lock_for(&file2, t_reveal, 9);
        bad.receiver = [0xee; 20];
        bad.lock_id = compute_lock_id(&bad.sender, &bad.receiver, bad.amount_wei, &bad.hashlock, bad.timelock);
        let mut eth2 = eth_at(10, t_b);
        eth2.lock = Some(bad);
        let d = decide(&file2, &funded(300_040, 10_000_000), &eth2, t_b);
        assert!(d.events.is_empty());
        assert!(d.notes.iter().any(|n| n.contains("receiver")), "{:?}", d.notes);
    }

    #[test]
    fn bob_locks_with_i1_then_claims_on_first_sight() {
        let s = Secret::generate().unwrap();
        let mut file = bob_file(&s);
        let t_b = 1_000_000;
        file.apply(&Event::NoidInstanceSeen { instance: funded(0, 10_000_000).instance.unwrap(), tip: 300_005 }, 0).unwrap();
        file.apply(&Event::NoidFundingFinal { tip: 300_022 }, 0).unwrap();
        // A pending call on the instance blocks the lock.
        let mut busy = funded(300_030, 10_000_000);
        busy.pending_calls.push(crate::watch::PendingCall { txid: "ab".into(), fee_micronoid: 5_800, admitted_height: 300_029 });
        busy.active_authority = Some(file.public.claim_authority.clone());
        let d = decide(&file, &busy, &eth_at(1, t_b), t_b);
        assert!(matches!(d.action, Action::Wait { .. }));
        // Clean: lock with T_reveal = t_b + W_A.
        let mut clean = funded(300_030, 10_000_000);
        clean.active_authority = Some(file.public.claim_authority.clone());
        let d = decide(&file, &clean, &eth_at(1, t_b), t_b);
        let t_reveal = match d.action {
            Action::LockEth { t_reveal, .. } => t_reveal,
            other => panic!("{other:?}"),
        };
        assert_eq!(t_reveal, t_b + params::W_A_S);
        file.apply(&Event::LockSubmitted { t_reveal, amount_wei: file.public.params.eth.amount_wei, tx_hash: None, at: t_b }, 0).unwrap();
        // The lock appears with our T_reveal.
        let mut eth = eth_at(10, t_b + 30);
        eth.lock = Some(lock_for(&file, t_reveal, 9));
        let d = decide(&file, &clean, &eth, t_b + 30);
        assert_eq!(d.events.len(), 1);
        file.apply(&d.events[0], 0).unwrap();
        // Secret in pending calldata: claim at tip + 1 (rotation guard permitting).
        let lock_id = eth.lock.as_ref().unwrap().lock_id;
        eth.pending_preimage = Some(crate::watch::PendingPreimage { lock_id, preimage: *s.bytes(), tx_hash: [1; 32] });
        let obs = funded(300_200, 10_000_000); // next call height 300,201: 300,201 - 1 = 300,200 = 2084*144 + 104: 41 blocks left
        let d = decide(&file, &obs, &eth, t_b + 3_600);
        assert_eq!(d.events.len(), 1);
        assert_eq!(d.action, Action::ClaimNoid { call_height: 300_201, fee_micronoid: 6_000, preimage: *s.bytes() });
        // A wrong preimage in a pending tx is ignored.
        let file2 = file.clone();
        let mut eth2 = eth.clone();
        eth2.pending_preimage = Some(crate::watch::PendingPreimage { lock_id, preimage: [5; 32], tx_hash: [1; 32] });
        let d = decide(&file2, &obs, &eth2, t_b + 3_600);
        assert!(d.events.is_empty());
        assert!(d.notes.iter().any(|n| n.contains("rejected")));
        // Without any secret, at T_reveal: refund.
        eth2.pending_preimage = None;
        eth2.latest_timestamp = t_reveal;
        let d = decide(&file2, &obs, &eth2, t_reveal);
        assert_eq!(d.action, Action::RefundEth { lock_id });
        // The mined Claimed event also counts as first sight.
        let mut eth3 = eth.clone();
        eth3.pending_preimage = None;
        eth3.claimed = Some(EthClaimed { lock_id, preimage: *s.bytes(), block_number: 12, tx_hash: [2; 32] });
        let d = decide(&file2, &obs, &eth3, t_b + 3_600);
        assert!(matches!(d.events[0], Event::EthPreimageSeen { .. }));
    }

    #[test]
    fn bob_claim_height_rules() {
        let s = Secret::generate().unwrap();
        let mut file = bob_file(&s);
        let inst = funded(0, 10_000_000).instance.unwrap();
        file.apply(&Event::NoidInstanceSeen { instance: inst, tip: 300_005 }, 0).unwrap();
        file.apply(&Event::NoidFundingFinal { tip: 300_022 }, 0).unwrap();
        file.apply(&Event::LockSubmitted { t_reveal: 1_007_200, amount_wei: file.public.params.eth.amount_wei, tx_hash: None, at: 1 }, 0).unwrap();
        let lock = lock_for(&file, 1_007_200, 9);
        file.apply(&Event::EthLockSeen { lock: summary(&lock) }, 0).unwrap();
        file.apply(&Event::EthPreimageSeen { preimage: *s.bytes(), tip: 1, time: 1 }, 0).unwrap();
        let eth = eth_at(10, 1_003_000);
        // Just before an epoch boundary: wait (T6). Child 300,241: anchor 300,096; rotation at 300,241 -> 0 blocks? compute explicitly.
        let child = 300_241; // (300_240 / 144) * 144 = 300_096; next rotation child = 300_241 -> blocks_until = 0? no: anchor+145-child
        let left = params::blocks_until_rotation(child);
        let d = decide(&file, &funded(child - 1, 10_000_000), &eth, 1);
        if left <= params::ROTATION_GUARD_BLOCKS {
            assert!(matches!(d.action, Action::Wait { .. }), "{:?}", d.action);
        } else {
            assert!(matches!(d.action, Action::ClaimNoid { .. }));
        }
        let guarded = 300_096 + 144 - 2; // child height with 3 blocks left -> wait
        assert_eq!(params::blocks_until_rotation(guarded), 3);
        let d = decide(&file, &funded(guarded - 1, 10_000_000), &eth, 1);
        assert!(matches!(d.action, Action::Wait { .. }));
        // Late but valid: prove anyway (D = 300,735; next call 300,730).
        let d = decide(&file, &funded(300_729, 10_000_000), &eth, 1);
        assert!(matches!(d.action, Action::ClaimNoid { call_height: 300_730, .. }));
        // Too late: the branch flipped; Bob lost. (The ETH lock must be closed in a final block, or the abort waits: REVIEW-4 R4-6.)
        let d = decide(&file, &funded(300_734, 10_000_000), &eth, 1);
        assert!(matches!(&d.action, Action::Wait { reason } if reason.contains("not aborting yet")), "{:?}", d.action);
        let mut closed = eth.clone();
        let mut l = lock.clone();
        l.claimed = true;
        closed.lock = Some(l);
        closed.claimed = Some(EthClaimed { lock_id: lock.lock_id, preimage: *s.bytes(), block_number: 5, tx_hash: [3; 32] });
        let d = decide(&file, &funded(300_734, 10_000_000), &closed, 1);
        assert!(matches!(d.action, Action::Abort { .. }), "{:?}", d.action);
    }

    #[test]
    fn thousands_are_grouped_in_notes() {
        for (n, s) in [(0, "0"), (999, "999"), (1_000, "1,000"), (50_000, "50,000"), (1_234_567, "1,234,567"), (u64::MAX, "18,446,744,073,709,551,615")] {
            assert_eq!(group_thousands(n), s);
        }
    }

    #[test]
    fn floor_note_needs_a_relay_floor_at_or_above_max_fee_and_a_live_swap() {
        let s = Secret::generate().unwrap();
        let file = bob_file(&s); // max_fee 50,000
        let mut obs = noid_at(300_000);
        let note = |o: &NoidObservation| decide(&file, o, &eth_at(1, 1_000_000), 1_000_000).notes.into_iter().find(|n| n.contains("relay floor"));
        assert_eq!(note(&obs), None);
        obs.relay_floor = Some(49_999);
        assert_eq!(note(&obs), None);
        obs.relay_floor = Some(50_000);
        assert_eq!(note(&obs).as_deref(), Some("relay floor 50,000 >= max_fee 50,000: a close cannot be relayed through this node (T5/Q6)"));
        // v2 reads the same max_fee.
        let v2 = crate::swapfile::example_bob_file(crate::swapfile::example_public_v(&s, Variant::Raw, ContractVersion::V2), 0).unwrap();
        obs.relay_floor = Some(60_000);
        let n = decide(&v2, &obs, &eth_at(1, 1_000_000), 1_000_000).notes;
        assert!(n.iter().any(|n| n.starts_with("relay floor 60,000 >= max_fee 50,000")), "{n:?}");
    }

    #[test]
    fn bob_refuses_to_lock_when_f_max_no_longer_covers_the_fee_estimate() {
        let s = Secret::generate().unwrap();
        let mut file = bob_file(&s);
        file.apply(&Event::NoidInstanceSeen { instance: funded(0, 10_000_000).instance.unwrap(), tip: 300_005 }, 0).unwrap();
        file.apply(&Event::NoidFundingFinal { tip: 300_022 }, 0).unwrap();
        let mut obs = funded(300_030, 10_000_000);
        obs.single_node_ok = true; // REVIEW-2 F5: this test is about the fee, not about a second node
        obs.fee_estimate_1_1 = Some(16_667); // 3x = 50,001 > F_max 50,000
        let d = decide(&file, &obs, &eth_at(1, 1_000_000), 1_000_000);
        assert!(matches!(&d.action, Action::Abort { reason } if reason.contains("T5")), "{:?}", d.action);
        obs.fee_estimate_1_1 = Some(16_666);
        let d = decide(&file, &obs, &eth_at(1, 1_000_000), 1_000_000);
        assert!(matches!(d.action, Action::LockEth { .. }));
        // A lagging chain clock shortens the window Bob grants (he uses the earlier time). 500 s behind is still inside the 600 s
        // head-time limit of REVIEW-2 F5; 601 s is not (the node is taken to lag, and nothing is locked).
        let d = decide(&file, &obs, &eth_at(1, 1_000_000 - 500), 1_000_000);
        assert!(matches!(d.action, Action::LockEth { t_reveal, .. } if t_reveal == 1_000_000 - 500 + params::W_A_S), "{:?}", d.action);
        let d = decide(&file, &obs, &eth_at(1, 1_000_000 - 601), 1_000_000);
        assert!(matches!(&d.action, Action::Wait { reason } if reason.contains("eth latest block time trails the clock by 601 s")), "{:?}", d.action);
    }

    #[test]
    fn locks_from_the_wrong_chain_contract_or_contract_sender_are_rejected() {
        let s = Secret::generate().unwrap();
        let mut file = alice_file(&s);
        file.apply(&Event::NoidInstanceSeen { instance: funded(0, 10_000_000).instance.unwrap(), tip: 300_005 }, 0).unwrap();
        file.apply(&Event::NoidFundingFinal { tip: 300_022 }, 0).unwrap();
        let t_b = 1_000_000;
        let good = lock_for(&file, t_b + 7_200, 9);
        let mut eth = eth_at(10, t_b);
        eth.lock = Some(good.clone());
        eth.chain_id = Some(file.public.params.eth.chain_id);
        eth.contract_code_hash = file.public.params.eth.code_hash;
        assert_eq!(decide(&file, &funded(300_040, 10_000_000), &eth, t_b).events.len(), 1);
        let mut wrong_chain = eth.clone();
        wrong_chain.chain_id = Some(1);
        let d = decide(&file, &funded(300_040, 10_000_000), &wrong_chain, t_b);
        assert!(d.events.is_empty() && d.notes.iter().any(|n| n.contains("chain")), "{:?}", d.notes);
        let mut wrong_code = eth.clone();
        wrong_code.contract_code_hash = Some([0xbb; 32]);
        let d = decide(&file, &funded(300_040, 10_000_000), &wrong_code, t_b);
        assert!(d.events.is_empty() && d.notes.iter().any(|n| n.contains("T17")), "{:?}", d.notes);
        let mut contract_sender = eth.clone();
        contract_sender.lock.as_mut().unwrap().sender_is_eoa = Some(false);
        let d = decide(&file, &funded(300_040, 10_000_000), &contract_sender, t_b);
        assert!(d.events.is_empty() && d.notes.iter().any(|n| n.contains("sender is a contract")), "{:?}", d.notes);
        // A lock with another id than the one recorded never counts as "our lock finalized".
        file.apply(&Event::EthLockSeen { lock: summary(&good) }, 0).unwrap();
        let mut other = eth.clone();
        other.lock = Some(lock_for(&file, t_b + 7_300, 9));
        other.finalized_block = Some(9);
        assert!(decide(&file, &funded(300_045, 10_000_000), &other, t_b).events.is_empty());
    }

    #[test]
    fn expected_lock_id_follows_bobs_t_reveal() {
        let s = Secret::generate().unwrap();
        let mut file = bob_file(&s);
        assert_eq!(expected_lock_id(&file), None);
        file.apply(&Event::NoidInstanceSeen { instance: funded(0, 10_000_000).instance.unwrap(), tip: 300_005 }, 0).unwrap();
        file.apply(&Event::NoidFundingFinal { tip: 300_022 }, 0).unwrap();
        file.set_pending(PendingAction {
            kind: "lock_eth".into(),
            created_at: 1,
            attempt: 1,
            maybe_sent: true,
            detail: serde_json::json!({ "t_reveal": 1_007_200 }),
        });
        let want = lock_for(&file, 1_007_200, 1).lock_id;
        assert_eq!(expected_lock_id(&file), Some(want));
        file.clear_pending();
        file.apply(&Event::LockSubmitted { t_reveal: 1_007_200, amount_wei: file.public.params.eth.amount_wei, tx_hash: None, at: 1 }, 0).unwrap();
        assert_eq!(expected_lock_id(&file), Some(want));
    }

    #[test]
    fn raw_defaults_never_pass_a_spending_gate_and_waits_pass_through() {
        // `super::decide`, not the completing wrapper: nothing here is filled in.
        let s = Secret::generate().unwrap();
        let file = alice_file(&s);
        let d = super::decide(&file, &noid_at(300_001), &eth_at(1, 1_000), 1_000);
        assert_eq!(d.action, Action::Wait { reason: "noid.observed_at unknown".into() });
        assert!(d.notes.iter().any(|n| n.contains("not fund_noid") && n.contains("fail closed")), "{:?}", d.notes);
        // Fresh but with the anchor missing: named.
        let mut n = noid_at(300_001);
        n.observed_at = Some(1_000);
        n.tip_time = Some(1_000); // REVIEW-3 F5: an unknown header time would block the spend; this test is about the others
        let d = super::decide(&file, &n, &eth_at(1, 1_000), 1_000);
        assert_eq!(d.action, Action::Wait { reason: "noid.epoch_anchor unknown".into() });
        n.epoch_anchor = Some([7; 32]);
        assert_eq!(super::decide(&file, &n, &eth_at(1, 1_000), 1_000).action, Action::FundNoid { amount_micronoid: 10_000_000 });
        // 121 s old (or 121 s in the future) is stale; 120 s is not.
        n.observed_at = Some(1_000 - MAX_OBSERVATION_AGE_S - 1);
        assert!(matches!(super::decide(&file, &n, &eth_at(1, 1_000), 1_000).action, Action::Wait { reason } if reason.contains("stale")));
        n.observed_at = Some(1_000 + MAX_OBSERVATION_AGE_S + 1);
        assert!(matches!(super::decide(&file, &n, &eth_at(1, 1_000), 1_000).action, Action::Wait { reason } if reason.contains("stale")));
        n.observed_at = Some(1_000 - MAX_OBSERVATION_AGE_S);
        assert_eq!(super::decide(&file, &n, &eth_at(1, 1_000), 1_000).action.kind(), "fund_noid");
        // An abort is not held back by a missing timestamp (nothing is spent).
        let late = noid_at(300_080);
        assert!(matches!(super::decide(&file, &late, &eth_at(1, 1_000), 1_000).action, Action::Abort { .. }));
        // Bob without a chain timestamp waits instead of aborting or locking.
        let b = bob_file(&s);
        let mut bf = b.clone();
        bf.apply(&Event::NoidInstanceSeen { instance: funded(0, 10_000_000).instance.unwrap(), tip: 300_005 }, 0).unwrap();
        bf.apply(&Event::NoidFundingFinal { tip: 300_022 }, 0).unwrap();
        let mut obs = funded(300_030, 10_000_000);
        obs.observed_at = Some(1_000);
        obs.active_authority = Some(bf.public.claim_authority.clone());
        let mut e = eth_at(1, 0);
        e.observed_at = Some(1_000);
        e.chain_id = Some(bf.public.params.eth.chain_id);
        let d = super::decide(&bf, &obs, &e, 1_000);
        assert_eq!(d.action, Action::Wait { reason: "eth.latest_timestamp unknown".into() }, "{:?}", d.notes);
    }


    /// Observations a healthy watcher would produce, built by hand for `super::decide`.
    fn healthy(file: &SwapFile, noid: NoidObservation, eth: EthObservation, now: u64) -> (NoidObservation, EthObservation) {
        let (mut n, mut e) = (noid, eth);
        n.observed_at = Some(now);
        e.observed_at = Some(now);
        n.epoch_anchor = Some([7; 32]);
        // REVIEW-3 F5: an unknown header time blocks every NOID-side spend, so a healthy observation has a fresh one.
        n.tip_time.get_or_insert(now);
        // REVIEW-2 F5: these tests are about the pinned chain and the lock, not about a second node.
        n.single_node_ok = true;
        e.single_node_ok = true;
        if n.instance.is_some() {
            n.instance_matches_opening = Some(true);
            n.active_authority = Some(file.public.claim_authority.clone());
        }
        e.chain_id = Some(file.public.params.eth.chain_id);
        e.contract_code_hash = file.public.params.eth.code_hash;
        (n, e)
    }

    #[test]
    fn every_eth_spend_needs_the_pinned_chain_and_code_hash_before_it_goes_out() {
        // REVIEW-2 F1, Bob's lock: checked BEFORE his ETH moves, not after the lock exists.
        let s = Secret::generate().unwrap();
        let mut file = bob_file(&s);
        file.apply(&Event::NoidInstanceSeen { instance: funded(0, 10_000_000).instance.unwrap(), tip: 300_005 }, 0).unwrap();
        file.apply(&Event::NoidFundingFinal { tip: 300_022 }, 0).unwrap();
        let t = 1_000_000;
        let (n, e) = healthy(&file, funded(300_030, 10_000_000), eth_at(1, t), t);
        assert_eq!(super::decide(&file, &n, &e, t).action.kind(), "lock_eth");
        let why = |n: &NoidObservation, e: &EthObservation, f: &SwapFile| match super::decide(f, n, e, t).action {
            Action::Wait { reason } => reason,
            other => panic!("expected wait, got {other:?}"),
        };
        let mut unknown_code = e.clone();
        unknown_code.contract_code_hash = None;
        assert_eq!(why(&n, &unknown_code, &file), "eth.contract_code_hash unknown");
        let mut wrong_code = e.clone();
        wrong_code.contract_code_hash = Some([0xbb; 32]);
        assert!(why(&n, &wrong_code, &file).contains("differs from the pinned one"));
        let mut unknown_chain = e.clone();
        unknown_chain.chain_id = None;
        assert_eq!(why(&n, &unknown_chain, &file), "eth.chain_id unknown");
        let mut wrong_chain = e.clone();
        wrong_chain.chain_id = Some(1);
        assert!(why(&n, &wrong_chain, &file).contains("not the pinned chain"));
        // An old swap file without any pinned hash can never spend ETH.
        let mut unpinned = file.clone();
        unpinned.public.params.eth.code_hash = None;
        assert!(why(&n, &e, &unpinned).contains("no HTLC code hash is pinned"));
    }

    #[test]
    fn reveal_and_refund_need_the_lock_visible_and_reveal_also_final_unclaimed_and_matching() {
        // REVIEW-2 F7.
        let s = Secret::generate().unwrap();
        let mut file = alice_file(&s);
        file.apply(&Event::NoidInstanceSeen { instance: funded(0, 10_000_000).instance.unwrap(), tip: 300_005 }, 0).unwrap();
        file.apply(&Event::NoidFundingFinal { tip: 300_022 }, 0).unwrap();
        let t_b = 1_000_000;
        let lock = lock_for(&file, t_b + 7_200, 9);
        file.apply(&Event::EthLockSeen { lock: summary(&lock) }, 0).unwrap();
        file.apply(&Event::EthLockFinal, 0).unwrap();
        let mut eth = eth_at(10, t_b);
        eth.finalized_block = Some(9);
        eth.lock = Some(lock.clone());
        let (n, e) = healthy(&file, funded(300_040, 10_000_000), eth, t_b);
        let kind = |e: &EthObservation, f: &SwapFile| super::decide(f, &n, e, t_b).action;
        assert_eq!(kind(&e, &file).kind(), "reveal_eth");
        // Lock not visible in this observation: the reveal waits, whatever the file remembers.
        let mut gone = e.clone();
        gone.lock = None;
        assert!(matches!(kind(&gone, &file), Action::Wait { reason } if reason.contains("eth.lock unknown")));
        // Visible but not finalized, or already claimed or refunded, or no longer the agreed terms.
        let mut unfinal = e.clone();
        unfinal.finalized_block = Some(8);
        assert!(matches!(kind(&unfinal, &file), Action::Wait { reason } if reason.contains("not finalized")));
        let mut claimed = e.clone();
        claimed.lock.as_mut().unwrap().claimed = true;
        assert!(matches!(kind(&claimed, &file), Action::Wait { reason } if reason.contains("already claimed")));
        let mut refunded = e.clone();
        refunded.lock.as_mut().unwrap().refunded = true;
        assert!(matches!(kind(&refunded, &file), Action::Wait { reason } if reason.contains("already refunded")));
        let mut other_amount = e.clone();
        other_amount.lock.as_mut().unwrap().amount_wei += 1;
        assert!(matches!(kind(&other_amount, &file), Action::Wait { reason } if reason.contains("does not match the agreed terms")));

        // Bob's refund: the lock must be visible and open.
        let mut bob = bob_file(&s);
        bob.apply(&Event::NoidInstanceSeen { instance: funded(0, 10_000_000).instance.unwrap(), tip: 300_005 }, 0).unwrap();
        bob.apply(&Event::NoidFundingFinal { tip: 300_022 }, 0).unwrap();
        bob.apply(&Event::LockSubmitted { t_reveal: t_b + 7_200, amount_wei: lock.amount_wei, tx_hash: None, at: t_b }, 0).unwrap();
        bob.apply(&Event::EthLockSeen { lock: summary(&lock) }, 0).unwrap();
        let late = t_b + 7_200;
        let mut eth = eth_at(20, late);
        eth.lock = Some(lock.clone());
        let (n, e) = healthy(&bob, funded(300_300, 10_000_000), eth, late);
        assert_eq!(super::decide(&bob, &n, &e, late).action.kind(), "refund_eth");
        let mut invisible = e.clone();
        invisible.lock = None;
        assert!(matches!(super::decide(&bob, &n, &invisible, late).action, Action::Wait { reason } if reason.contains("eth.lock")));
        let mut claimed = e.clone();
        claimed.lock.as_mut().unwrap().claimed = true;
        assert!(matches!(super::decide(&bob, &n, &claimed, late).action, Action::Wait { reason } if reason.contains("already claimed")));
    }

    #[test]
    fn alice_rejects_a_lock_whose_reveal_window_is_shorter_than_w_a_min() {
        // REVIEW-2 F11, (I3): T_reveal - (timestamp of the lock's block) >= W_A_min.
        let s = Secret::generate().unwrap();
        let mut file = alice_file(&s);
        file.apply(&Event::NoidInstanceSeen { instance: funded(0, 10_000_000).instance.unwrap(), tip: 300_005 }, 0).unwrap();
        file.apply(&Event::NoidFundingFinal { tip: 300_022 }, 0).unwrap();
        let t_b = 1_000_000;
        let t_reveal = t_b + 7_200;
        let mut eth = eth_at(10, t_b);
        let mut lock = lock_for(&file, t_reveal, 9);
        eth.lock = Some(lock.clone());
        let seen = |eth: &EthObservation| decide(&file, &funded(300_040, 10_000_000), eth, t_b);
        assert_eq!(seen(&eth).events.len(), 1);
        // Exactly W_A_min after the block: accepted. One second less: rejected, with the reason.
        lock.block_timestamp = Some(t_reveal - params::W_A_MIN_S);
        eth.lock = Some(lock.clone());
        assert_eq!(seen(&eth).events.len(), 1);
        lock.block_timestamp = Some(t_reveal - params::W_A_MIN_S + 1);
        eth.lock = Some(lock.clone());
        let d = seen(&eth);
        assert!(d.events.is_empty() && d.notes.iter().any(|n| n.contains("W_A_min")), "{:?}", d.notes);
        // Unknown block timestamp: not accepted (fail closed).
        lock.block_timestamp = None;
        eth.lock = Some(lock);
        let d = seen(&eth);
        assert!(d.events.is_empty() && d.notes.iter().any(|n| n.contains("timestamp of its block is unknown")), "{:?}", d.notes);
    }
    #[test]
    fn close_fee_is_clamped() {
        let mut n = noid_at(1);
        n.fee_estimate_1_1 = Some(4_000);
        n.fee_floor = Some(0);
        assert_eq!(close_fee(&n, 50_000), 5_800);
        n.fee_floor = Some(70_000);
        assert_eq!(close_fee(&n, 50_000), 50_000);
        n.fee_floor = Some(9_000);
        assert_eq!(close_fee(&n, 50_000), 9_000);
    }

    #[test]
    fn close_fee_for_v1_is_the_clamped_estimate_and_for_v2_exactly_max_fee() {
        let mut n = noid_at(1);
        // v1: identical to `close_fee` in every case above.
        n.fee_estimate_1_1 = Some(4_000);
        n.fee_floor = Some(0);
        assert_eq!(close_fee_for(ContractVersion::V1, &n, 50_000), 5_800);
        n.fee_floor = Some(70_000);
        assert_eq!(close_fee_for(ContractVersion::V1, &n, 50_000), 50_000);
        n.fee_floor = Some(9_000);
        assert_eq!(close_fee_for(ContractVersion::V1, &n, 50_000), 9_000);
        // v2: max_fee whatever the estimate and the floor say (even unknown ones).
        for (est, floor) in [(Some(4_000), Some(0)), (Some(6_000), Some(9_000)), (Some(1_000_000), Some(70_000)), (None, None)] {
            n.fee_estimate_1_1 = est;
            n.fee_floor = floor;
            assert_eq!(close_fee_for(ContractVersion::V2, &n, 50_000), 50_000, "{est:?} {floor:?}");
            assert_eq!(close_fee_for(ContractVersion::V2, &n, 20_000), 20_000);
        }
    }

    // ------------------------------------------------------------ REVIEW-2 F5

    #[test]
    fn noid_tip_header_time_rule_has_its_boundary_at_300_seconds() {
        let now = 1_794_312_000;
        assert_eq!(MAX_NOID_TIP_LAG_S, 300);
        assert_eq!(noid_tip_lag_s(now - 299, now), 299);
        assert_eq!(noid_tip_time_blocker(Some(now - 299), now), None);
        assert_eq!(noid_tip_time_blocker(Some(now - 300), now), None);
        let why = noid_tip_time_blocker(Some(now - 301), now).unwrap();
        assert_eq!(why, "noid tip header time trails the clock by 301 s (limit 300 s): the node lags (F5)");
        assert!(noid_tip_time_blocker(Some(now - 412), now).unwrap().contains("412 s"));
        // A tip stamped in the future (our clock is behind, or the miner's is ahead) is not a lagging node.
        assert_eq!(noid_tip_time_blocker(Some(now + 500), now), None);
        // Unknown: no verdict here (the caller adds the note and keeps the old rule).
        // REVIEW-3 F5: unknown fails closed, and the reason names the remedy and the old recordings.
        let why = noid_tip_time_blocker(None, now).unwrap();
        assert!(why.contains("unknown") && why.contains("paranoid_getBlockHeader") && why.contains("recording made before F5"), "{why}");
    }

    #[test]
    fn eth_head_time_rule_has_its_boundary_at_600_seconds() {
        let now = 1_794_312_000;
        assert_eq!(eth_head_time_blocker(now - 600, now), None);
        assert_eq!(eth_head_time_blocker(now, now), None);
        assert_eq!(eth_head_time_blocker(now + 12, now), None);
        assert_eq!(
            eth_head_time_blocker(now - 601, now).unwrap(),
            "eth latest block time trails the clock by 601 s (limit 600 s): the node lags (F5)"
        );
    }

    /// Bob ready to lock on a healthy production observation pair (as in the fee test above), single node accepted.
    fn bob_ready_to_lock() -> (SwapFile, NoidObservation, EthObservation, u64) {
        let s = Secret::generate().unwrap();
        let mut file = bob_file(&s);
        file.apply(&Event::NoidInstanceSeen { instance: funded(0, 10_000_000).instance.unwrap(), tip: 300_005 }, 0).unwrap();
        file.apply(&Event::NoidFundingFinal { tip: 300_022 }, 0).unwrap();
        let t = 1_000_000;
        let (n, e) = healthy(&file, funded(300_030, 10_000_000), eth_at(1, t), t);
        (file, n, e, t)
    }

    #[test]
    fn header_time_known_old_waits_unknown_notes_and_fresh_is_silent() {
        let (file, mut n, e, t) = bob_ready_to_lock();
        n.tip_time = Some(t - 301);
        let d = super::decide(&file, &n, &e, t);
        assert!(matches!(&d.action, Action::Wait { reason } if reason.contains("trails the clock by 301 s (limit 300 s)")), "{:?}", d.action);
        n.tip_time = Some(t - 90);
        let d = super::decide(&file, &n, &e, t);
        assert_eq!(d.action.kind(), "lock_eth", "{:?}", d.notes);
        assert!(d.notes.iter().all(|x| !x.contains("tip header time")), "{:?}", d.notes);
        // REVIEW-3 F5: an unknown header time fails closed.
        n.tip_time = None;
        let d = super::decide(&file, &n, &e, t);
        assert!(matches!(&d.action, Action::Wait { reason } if reason.contains("noid tip header time unknown") && reason.contains("paranoid_getBlockHeader")), "{:?}", d.action);
        // Not a spend (no instance yet, so Bob aborts): a very old tip draws no F5 note.
        n.tip_time = Some(t - 90);
        let mut idle = n.clone();
        idle.instance = None;
        idle.tip_time = Some(t - 10_000);
        let d = super::decide(&file, &idle, &e, t);
        assert!(!matches!(d.action, Action::LockEth { .. }), "{:?}", d.action);
        assert!(d.notes.iter().all(|x| !x.contains("tip header")), "{:?}", d.notes);
    }

    #[test]
    fn second_node_rules_by_profile_for_the_lock() {
        let (file, mut n, e, t) = bob_ready_to_lock();
        assert!(file.public.params.profile.is_production());
        // One node, production, no flag: wait with the full sentence.
        n.single_node_ok = false;
        let d = super::decide(&file, &n, &e, t);
        assert!(
            matches!(&d.action, Action::Wait { reason } if reason == "a second node is required before this step (F5); pass --noid-rpc / --eth-rpc twice, or --single-node-ok to accept the risk"),
            "{:?}",
            d.action
        );
        // The flag lets it through with a note.
        n.single_node_ok = true;
        let d = super::decide(&file, &n, &e, t);
        assert_eq!(d.action.kind(), "lock_eth");
        assert!(d.notes.iter().any(|x| x == "single node: F5 cross-check not possible"), "{:?}", d.notes);
        // A second node that agrees: no single-node note, and the flag is irrelevant.
        n.single_node_ok = false;
        n.second = Some(Box::new(NoidObservation { observed_at: Some(t), second: None, ..n.clone() }));
        let d = super::decide(&file, &n, &e, t);
        assert_eq!(d.action.kind(), "lock_eth", "{:?}", d.notes);
        assert!(d.notes.iter().all(|x| !x.contains("single node")), "{:?}", d.notes);
        // Tips: 2 apart agree, 3 apart do not.
        let mut s2 = (**n.second.as_ref().unwrap()).clone();
        s2.tip = n.tip - 2;
        n.second = Some(Box::new(s2.clone()));
        assert_eq!(super::decide(&file, &n, &e, t).action.kind(), "lock_eth");
        s2.tip = n.tip + 3;
        n.second = Some(Box::new(s2.clone()));
        assert!(matches!(&super::decide(&file, &n, &e, t).action, Action::Wait { reason } if reason.contains("3 blocks apart")));
        // A stale second poll does not count as agreement.
        s2.tip = n.tip;
        s2.observed_at = Some(t - 500);
        n.second = Some(Box::new(s2));
        assert!(matches!(&super::decide(&file, &n, &e, t).action, Action::Wait { reason } if reason.contains("second node") && reason.contains("stale")));
    }
}
