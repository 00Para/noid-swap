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
use crate::secret::{check_preimage_for, LockKind};
use crate::state::{transition, AlicePhase, BobPhase, Event, InvalidTransition, LockSummary, Phase, Role};
use crate::producer_gate;
use crate::swapfile::{PendingAction, PendingIntent, SwapFile, SwapFileError};
use crate::watch::eth::compute_lock_id;
use crate::watch::{hexbytes, u128dec, EthLock, EthObservation, NoidInstance, NoidInstanceStatus, NoidObservation, WordScan};

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
    /// Log-only history entries to append after the events (G9: `late_lock:` markers); they never change a phase.
    pub log: Vec<String>,
    /// Internal hint, never printed, saved or read by anything but the intent ledger's wait reason: this decision is Alice's `wait` that comes from
    /// the failed reveal cutoff `(I2)` (`GateError::RevealCutoffPassed`), not from any other cause.
    pub reveal_cutoff_passed: bool,
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
            // `poseidon` kind: a pending claim with trailing calldata reverts, but it has shown `s` (docs/poseidon-leg.md 9.4).
            .chain(e.overlong_claim.as_ref().filter(|p| p.lock_id == lock_id).map(|p| p.preimage))
            // REVIEW-6 R6-3: a claim that was mined and REVERTED published the secret too (named with `--reveal-tx`, checked by the watcher).
            .chain(e.reverted_claim.as_ref().filter(|p| p.lock_id == lock_id).map(|p| p.preimage))
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

/// The helper the operator runs for instances the tool does not close: what it can and cannot do.
fn recover_helper_clause() -> String {
    format!(
        "scripts/live/recover-noid.sh closes the instances of the agreed amount; an instance not larger than the close fee (at least {} micro-NOID, more under load) cannot be recovered",
        group_thousands(params::MIN_CLOSE_FEE)
    )
}

/// CHAOS F-19, said in the reason and in the note: a funding decided by the tool is on record and several instances fit. At `D` this file
/// takes the oldest fitting instance as its own and offers `refund_noid` for it; the others are for the helper. `fitting` is sorted here.
fn f19_adoption_sentence(file: &SwapFile, fitting: &mut [NoidInstanceStatus]) -> String {
    fitting.sort_by_key(|v| (v.instance.creation_id, v.instance.slot_index));
    let mine = &fitting[0].instance;
    format!(
        "At D {} this file adopts the oldest fitting instance (slot {}, creation {}) and offers its refund itself (refund_noid); the OTHER instances need scripts/live/recover-noid.sh. If the helper is run for all of them before the tool's own refund, record the tool's instance with `tick --closed-by TXID`.",
        file.public.params.deadline_height, mine.slot_index, mine.creation_id
    )
}

/// "1 instance" / "3 instances".
fn count_instances(n: usize) -> String {
    format!("{n} instance{}", if n == 1 { "" } else { "s" })
}

/// Alice, phase `created`: instances sit at her contract root and none is accepted. The `wait` reason, or `None` when there is nothing
/// to say (no instance, or one is accepted). It comes first, whatever the tip is relative to the height at which the funding opens
/// ([`funding_opens_at`]): before it as a wait here, from it on through [`guard_fund_noid`], with the same text.
/// - More than one instance fits (live run 9, a funding made more than once): the swap cannot go on with them, nothing may be funded
///   again, and the NOID is taken back once `D` is reached.
/// - The instance there does not fit (a foreign deposit, dust, another amount): it is not counted as a funding; nothing else is claimed.
fn alice_instance_problem_text(file: &SwapFile, noid: &NoidObservation) -> Option<String> {
    let all = noid.all_instances();
    if all.is_empty() {
        return None;
    }
    match instance_ok(file, noid) {
        Ok(()) => None,
        Err(InstanceProblem::Ambiguous(_)) => {
            let d = file.public.params.deadline_height;
            let mut fitting: Vec<NoidInstanceStatus> = all.iter().filter(|v| instance_fits(file, v)).cloned().collect();
            let when = if params::alice_refund_ready(noid.tip, d) { format!("D {d} is reached, so they can be recovered now") } else { format!("they can be recovered after D {d}") };
            let mut text = format!(
                "{} at our contract root, {} of the agreed amount, and none is accepted: the swap cannot go on with them (Bob does not lock on more than one fitting instance, and Alice does not reveal). Fund NOTHING again. The instances of the agreed amount are not lost: {when}, with the wallet or with the helper ({})",
                if all.len() == 1 { "1 instance sits".to_string() } else { format!("{} instances sit", all.len()) },
                fitting.len(),
                recover_helper_clause()
            );
            // The same sentence as the abandoned note: a funding of the tool's own is on record, so at D the file takes the oldest one.
            if fitting.len() > 1 && alice_funding_on_record(file, &AlicePhase::Created) {
                text.push_str(&format!(". {}", f19_adoption_sentence(file, &mut fitting)));
            }
            Some(text)
        }
        Err(InstanceProblem::Rejected(e)) => {
            let first = noid.instance.as_ref().map(|i| group_thousands(i.amount_micronoid)).unwrap_or_else(|| "?".into());
            Some(format!(
                "an instance of {first} micro-NOID sits at our contract root; it is not the agreed one ({e}) and is not counted as a funding{}; not funding until the contract state has been checked",
                if all.len() > 1 { format!(" ({} instances in all, see the notes)", all.len()) } else { String::new() }
            ))
        }
    }
}

/// The first Parano1d height at which Alice's `created` file offers the funding (`tip + 1 >=` it), and whether the trial start sets it.
/// `H_create - D_offset`, so the NOID is never locked for more than `2 * D_offset` blocks (`D = H_create + D_offset`); and never below the trial
/// start height, which `check_i5` enforces for `H_create` itself. Saturating: an `H_create` below `D_offset` gives the trial start.
fn funding_opens_at(file: &SwapFile) -> (u64, bool) {
    let by_window = file.public.params.h_create.saturating_sub(file.public.params.profile.gates().d_offset);
    if by_window >= params::TRIAL_START_HEIGHT {
        (by_window, false)
    } else {
        (params::TRIAL_START_HEIGHT, true)
    }
}

/// The wait reason of a `created` Alice file before the funding opens.
fn too_early_to_fund_text(file: &SwapFile, tip: u64, opens_at: u64, trial_bound: bool) -> String {
    let p = &file.public.params;
    if trial_bound {
        format!("too early to fund: the funding opens at height {opens_at} (tip {tip}), the trial start; no swap starts before it")
    } else {
        format!(
            "too early to fund: the funding opens at height {opens_at} (tip {tip}); a funding before it would lock the NOID for more than twice the swap's planned length (D {} is {} blocks after H_create {})",
            p.deadline_height,
            p.profile.gates().d_offset,
            p.h_create
        )
    }
}

/// Display only: the height from which Alice's `created` file offers the funding, or that it is open now. Read by nothing; it is a note of its
/// own (the lock-by margin note keeps its wording). None beside an abort (a closed window has no opening to say), and none while an instance sits at
/// the contract root or a funding is held (an intent or a pending record of a `fund_noid`): the note is built before [`guard_fund_noid`] and the ledger
/// turn a funding into a wait, and "funding is open" must not stand beside "do not fund again".
fn funding_open_note(file: &SwapFile, phase: &Phase, action: &Action, noid: &NoidObservation) -> Option<String> {
    let tip = noid.tip;
    if !matches!(phase, Phase::Alice(AlicePhase::Created)) || matches!(action, Action::Abort { .. }) {
        return None;
    }
    let funding_held = file.pending_intent.as_ref().is_some_and(|i| i.action == "fund_noid") || file.pending_action.as_ref().is_some_and(|a| a.kind == "fund_noid");
    if !noid.all_instances().is_empty() || funding_held {
        return None;
    }
    let (opens_at, _) = funding_opens_at(file);
    Some(if tip.saturating_add(1) >= opens_at {
        format!("funding is open from height {opens_at} (tip {tip})")
    } else {
        format!("funding opens at height {opens_at} (tip {tip})")
    })
}

/// The note for an Alice file that is aborted, or whose `abort` is decided now, while instances still hold NOID at her root. It says where
/// they are, which of them are not lost and how to take them back, and who closes them. `None` when no instance is left.
/// `phase_created` / `funding_on_record`: the F-19 case (CHAOS F-19): a funding decided by this tool is on record and several instances
/// fit; the file stays `created`, and at `D` the tool adopts the oldest fitting instance and offers its refund itself.
fn alice_abandoned_instances_note(file: &SwapFile, noid: &NoidObservation, phase_created: bool, funding_on_record: bool) -> Option<String> {
    let all = noid.all_instances();
    if all.is_empty() {
        return None;
    }
    let d = file.public.params.deadline_height;
    let n = all.len();
    let mut fitting: Vec<NoidInstanceStatus> = all.iter().filter(|v| instance_fits(file, v)).cloned().collect();
    let when = if params::alice_refund_ready(noid.tip, d) { format!("D {d} is reached, so they can be recovered now") } else { format!("they can be recovered after D {d}") };
    let mut text = format!("{} hold NOID at the contract root: {}.", count_instances(n), describe_instances(&all, None));
    if fitting.is_empty() {
        text.push_str(&format!(" None fits the agreement, so none is this swap's funding; {}.", recover_helper_clause()));
    } else {
        text.push_str(&format!(" Those of the agreed amount ({}) are NOT lost: {when}, with scripts/live/recover-noid.sh ({}).", fitting.len(), recover_helper_clause()));
    }
    if phase_created && funding_on_record && fitting.len() > 1 {
        text.push_str(&format!(" {}", f19_adoption_sentence(file, &mut fitting)));
    } else {
        text.push_str(&format!(" This tool will not close {}.", if n == 1 { "it" } else { "them" }));
    }
    Some(text)
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
pub(crate) fn last_history(file: &SwapFile, event: &str) -> Option<usize> {
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
    // REVIEW-6 R6-3: what the watcher made of a `--reveal-tx` hash (on either node) is always said.
    for e in std::iter::once(eth).chain(eth.second.as_deref()) {
        if let Some(n) = &e.reveal_tx_note {
            if !notes.contains(n) {
                notes.push(n.clone());
            }
        }
        // Outside audit (2026-11-23): the `Locked` logs a node skipped because their amount or timelock does not fit.
        for n in &e.ignored_logs {
            let n = if std::ptr::eq(e, eth) { n.clone() } else { format!("{n} (second eth node)") };
            if !notes.contains(&n) {
                notes.push(n);
            }
        }
    }
    // REVIEW-7 R7-5: say so when a reverted claim is reported by one node but the evidence (two nodes, when two are configured) is not enough.
    if file.role == Role::Alice {
        if let Err(why) = reverted_claim_evidence(eth, alice_lock_id(file)) {
            if !notes.contains(&why) {
                notes.push(why);
            }
        }
    }
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
    // Alice only (CHAOS F-18): the positive evidence for `lost` and its withdrawal, also log-only.
    if let Phase::Alice(p) = &phase {
        if let Some(e) = alice_gone_trace(file, p, noid) {
            match transition(&phase, &e) {
                Ok(np) => {
                    phase = np;
                    events.push(e);
                }
                Err(err) => notes.push(format!("internal: {err}")),
            }
        }
    }
    // Bob only (CHAOS F-11): the instance was alive when his claim branch had closed; log-only, once. The tip of that poll goes into the abort reason.
    let mut bob_alive_tip: Option<u64> = None;
    if let Phase::Bob(p) = &phase {
        if let Some(e) = bob_alive_at_d(file, p, noid, now) {
            match transition(&phase, &e) {
                Ok(np) => {
                    phase = np;
                    events.push(e);
                    bob_alive_tip = Some(noid.tip);
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
    // Bob only (G9): a late lock of his own sender that the file did not send is adopted like any other and carries an ALARM note.
    let mut log = Vec::new();
    log.extend(bob_alive_tip.map(|t| format!("{BOB_ALIVE_TIP}{t}")));
    if let Phase::Bob(p) = &phase {
        let (marker, note) = bob_late_lock(file, p, &events, noid, eth, now);
        log.extend(marker);
        notes.extend(note);
    }
    // Alice only (G1): a note when Bob's lock was first recorded after his last lock height. Decides nothing.
    if let Phase::Alice(p) = &phase {
        let (marker, note) = alice_late_lock(file, p, &events, noid);
        log.extend(marker);
        notes.extend(note);
    }
    let mut reveal_cutoff_passed = false;
    let action = match &phase {
        Phase::Alice(p) => alice_action(file, p, noid, eth, now, &mut notes, &mut reveal_cutoff_passed),
        Phase::Bob(p) => bob_action(file, p, noid, eth, now, &mut notes),
    };
    // CHAOS F-4: a recovery close of an instance that is not at the contract is not offered, on either path (the node would only
    // refuse it, tick after tick, until `--closed-by` is run).
    let action = match action {
        // CHAOS X1: at and after D, the recorded instance is not at the contract (it came back as another incarnation after reorgs) but an
        // instance of the agreed amount is: the recovery close is offered for that one. Any instance at this opening pays Alice on the
        // recovery branch, so nothing is risked; nothing before D reads this.
        refund @ Action::RefundNoid { .. } if instance_gone_in(&phase, noid) && alice_recovery_adoption(file, &phase, noid, now).is_some() => {
            if let Some(a) = alice_recovery_adoption(file, &phase, noid, now) {
                notes.push(a.note(file));
                let marker = format!("{RECOVERY_ADOPTED}{}:{}:{}", a.adopted.instance.slot_index, a.adopted.instance.creation_id, a.adopted.instance.amount_micronoid);
                if recovery_target(file).as_ref() != Some(&a.adopted.instance) {
                    log.push(marker);
                }
            }
            refund
        }
        Action::RefundNoid { .. } if instance_gone_in(&phase, noid) => {
            let why = "the instance is not visible, so there is nothing to refund (already closed? verify the contract receipts)".to_string();
            notes.push(format!("not refund_noid: {why}"));
            // CHAOS S3: a recovery close for another instance was ruled out only because the second node does not back the first one's word.
            if let RecoveryCheck::Blocked(why) = alice_recovery_check(file, &phase, noid, now) {
                notes.push(format!("a recovery close for another instance of the agreed amount at the root is not offered: {why}"));
            }
            // Review M5: another instance at the root (the funding came back as a new incarnation) is not the recorded one; name it.
            let all = noid.all_instances();
            if !all.is_empty() {
                notes.push(format!("the recorded instance is gone but {} other instance(s) sit at the contract root and are NOT refunded by this tool (refund them with the wallet): {}", all.len(), describe_instances(&all, None)));
                // M1 (c): after a reveal, without evidence that the recorded instance was alive when Bob could no longer claim, the file does not
                // know whether he claimed it before D.
                if matches!(&phase, Phase::Alice(p) if alice_reveal_may_be_out(file, p)) {
                    notes.push("whether Bob claimed the recorded instance before D is not known to this file; the instance at the root can be recovered with the wallet".to_string());
                }
            }
            Action::Wait { reason: why }
        }
        other => other,
    };
    // (A second match, so that a recovery close for an adopted instance (CHAOS X1) also goes through the F-14 wait.)
    let action = match action {
        // CHAOS F-14: a call on this contract sits in the node's mempool (the watcher's `pending_calls` are all mempool calls whose contract opening
        // equals ours, so a call on any instance at the root counts; it may be a recovery close that a reorg put back). A second
        // `refund_noid` would only be refused by the first-seen mempool, and on the CLI path it would be recorded as a second intent. The same
        // wait as Bob's claim has (T2), with the same second-node exception: a second node that is fresh, level with the first and sees no
        // pending call lets the refund go on.
        Action::RefundNoid { .. } if !noid.pending_calls.is_empty() && !second_node_sees_no_pending_call(noid, &mut notes) => {
            let txids = noid.pending_calls.iter().map(|c| c.txid.as_str()).collect::<Vec<_>>().join(", ");
            let why = format!(
                "a call on this contract (one of its instances) is pending in the node's mempool ({txids}); it may be the recovery close sent earlier, put back by a reorg; refund_noid is offered again only if it is evicted and the instance is still there (CHAOS F-14)"
            );
            notes.push(format!("not refund_noid: {why}"));
            Action::Wait { reason: why }
        }
        other => other,
    };
    // CHAOS S3 (b): a recovery close for the RECORDED instance is decided again (it came back): the file no longer carries the adoption label.
    if matches!(action, Action::RefundNoid { .. })
        && recovery_target(file).is_some()
        && !(instance_gone_in(&phase, noid) && alice_recovery_adoption(file, &phase, noid, now).is_some())
    {
        log.push(format!("{RECOVERY_ADOPTED}recorded"));
    }
    // Live run 9: an Alice file that gives up (the `abort` is decided now) or has given up while instances still hold NOID at her
    // root. The file ends, the loop stops, and nothing else says where the NOID is. Alice's `aborted` only comes from `created`.
    let alice_gives_up = match &phase {
        Phase::Alice(AlicePhase::Aborted { .. }) => true,
        Phase::Alice(AlicePhase::Created) => matches!(action, Action::Abort { .. }),
        _ => false,
    };
    if alice_gives_up {
        let on_record = matches!(&phase, Phase::Alice(p) if alice_funding_on_record(file, p));
        notes.extend(alice_abandoned_instances_note(file, noid, matches!(&phase, Phase::Alice(AlicePhase::Created)), on_record));
    }
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
    // Display only, from the action as finally decided: the lock-by margin while Bob's lock is not yet seen. Read by nothing.
    notes.extend(lock_by_margin_note(file, &phase, &action, noid.tip));
    notes.extend(funding_open_note(file, &phase, &action, noid));
    // T21: the first time `--accept-producer-concentration` lets a lock through that the screen would have held back, the swap file's history
    // says so (log only; once). Nothing here changes an event or the action.
    if matches!(&action, Action::LockEth { .. }) && matches!(&phase, Phase::Bob(BobPhase::FundingFinal { .. })) {
        // Once per swap, and again after each recorded detection: the live.js lock accepts the override only when its entry comes AFTER the
        // detection entry (an outside read, 2026-11-10: an older override for a concentration must not waive a later disagreement).
        // The same for the pending-lock latch (a tick found the screen refusing a pending `lock_eth`): `live.js lock` refuses on a latch entry with no override
        // entry after it, so an override older than the newest latch entry does not count as "already written" either.
        let last_barrier = file
            .history
            .iter()
            .rposition(|h| h.event == crate::producer_marker::HISTORY || h.event.starts_with(producer_gate::LOCK_LATCH_PREFIX));
        let already = file.history.iter().enumerate().any(|(i, h)| h.event.starts_with(producer_gate::OVERRIDE_HISTORY) && last_barrier.is_none_or(|d| i > d));
        if !already {
            log.extend(producer_gate::override_history_entry(file.public.params.profile.gates(), noid, now));
        }
        // D2: the narrow acknowledgement, once per swap and again after each barrier like the entry above. `live.js lock` does not count it as an override.
        let ack_already = file.history.iter().enumerate().any(|(i, h)| h.event.starts_with(producer_gate::ACK_HISTORY) && last_barrier.is_none_or(|d| i > d));
        if !ack_already {
            log.extend(producer_gate::ack_history_entry(file.public.params.profile.gates(), noid, now));
        }
    }
    Decision { events, action, notes, log, reveal_cutoff_passed }
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

/// Below this many blocks between the tip and the nearer of Bob's lock-by height and his last lock height, the margin note is phrased as a warning. Display only: it
/// decides nothing (live run 13: Bob's lock was offered six blocks before the lock-by and nothing had said the window was short; in runs 10
/// to 12 he had 59 to 62 blocks).
pub const LOCK_BY_MARGIN_WARN_BLOCKS: u64 = 15;

/// The lock-by margin note, while Bob's lock is not yet seen: Alice's phases before `lock_seen` (`created` to `funding_final`) and Bob's before
/// his lock is sent (`received` to `funding_final`). `None` in every other phase. The note states facts (heights, blocks left) and never
/// an instruction: it is built inside `decide`, and the caller may still change the action afterwards (the intent ledger holds a spend as
/// a wait, `guard_fund_noid` turns a funding into a wait), so a command in the note could sit beside a wait. A short margin therefore ends
/// in `see the action`. The action is read only to tell whether Bob's lock is still offered past the nominal lock-by and whether an abort
/// stands beside the note (then no count of blocks left is printed: only the forms that say a height has passed). Neither the action nor its reason
/// is touched by this function.
fn lock_by_margin_note(file: &SwapFile, phase: &Phase, action: &Action, tip: u64) -> Option<String> {
    let params = &file.public.params;
    let g = params.profile.gates();
    let lock_by = params.lock_by_height;
    match phase {
        // Alice before she funds: measured the way `alice_action` measures it (it funds while `tip + b_fund + b_final <= lock-by`).
        Phase::Alice(AlicePhase::Created) => {
            let need = g.b_fund + g.b_final;
            let funded_final_by = tip.checked_add(need)?;
            if funded_final_by > lock_by {
                return Some(format!("funding window is closed: the last height to fund was {} (lock-by {lock_by}, tip {tip})", lock_by.saturating_sub(need)));
            }
            let left = lock_by - funded_final_by;
            let what = format!("{left} blocks left before it is too late to fund (lock-by {lock_by}, tip {tip})");
            if left >= LOCK_BY_MARGIN_WARN_BLOCKS {
                return Some(format!("funding window: {what}"));
            }
            Some(format!("funding window is short: {what}; see the action"))
        }
        Phase::Alice(AlicePhase::FundingSubmitted { .. } | AlicePhase::Funded { .. } | AlicePhase::FundingFinal { .. })
        | Phase::Bob(BobPhase::Received | BobPhase::Funded { .. } | BobPhase::FundingFinal { .. }) => {
            // Bob's last lock height as the engine's own gates compute it; Alice's notes do not name it.
            let last_lock = bob_last_lock_height(file, phase);
            if tip > lock_by {
                // The file's lock-by is the nominal one (the bundle states it); Bob's lock is offered up to the last lock height.
                if let (Action::LockEth { .. }, Some(last)) = (action, last_lock) {
                    return Some(format!(
                        "nominal lock-by {lock_by} has passed (tip {tip}); the lock is still allowed until {}the hard limit {}",
                        if last.exact { "" } else { "at most " },
                        last.height
                    ));
                }
                let beyond = format!("lock-by {lock_by} has passed: tip {tip} is {} blocks beyond it", tip - lock_by);
                return Some(format!("{beyond}{}", last_lock_clause(last_lock, action, tip)));
            }
            // The last lock height is the nearer limit (exact, below the nominal lock-by) and still ahead, with no abort beside the note: the margin is
            // counted to it, and so is the short-margin threshold; the number that matters is the one Bob's engine gives up at.
            if let Some(last) = last_lock {
                if last.exact && last.height < lock_by && tip <= last.height && !matches!(action, Action::Abort { .. }) {
                    let left = last.height - tip;
                    // At the last lock height itself the lock is still allowed; "0 blocks" would read as too late, so the fact is said instead.
                    if left == 0 {
                        return Some(format!("the tip is the last lock height {} (nominal lock-by {lock_by}); see the action", last.height));
                    }
                    let what = format!("{left} blocks to the last lock height {} (nominal lock-by {lock_by}, tip {tip})", last.height);
                    if left >= LOCK_BY_MARGIN_WARN_BLOCKS {
                        return Some(format!("lock margin: {what}"));
                    }
                    return Some(format!("lock margin is short: {what}; see the action"));
                }
            }
            // Beside an abort no count of blocks left is printed (a positive count beside a terminal answer reads as time to spare): with the last
            // lock height passed (Bob's `PastBobWindow` or `PastLockBy`) the note says that, with the nominal lock-by and the tip and no count; with
            // any other cause of the abort nothing is printed.
            if matches!(action, Action::Abort { .. }) {
                return last_lock.filter(|l| tip > l.height).map(|l| {
                    if l.exact {
                        format!("the last lock height {} has passed (nominal lock-by {lock_by}, tip {tip})", l.height)
                    } else {
                        format!("the last lock height, at most {}, has passed (nominal lock-by {lock_by}, tip {tip})", l.height)
                    }
                });
            }
            let margin = lock_by - tip;
            let last = last_lock_clause(last_lock, action, tip);
            if margin >= LOCK_BY_MARGIN_WARN_BLOCKS {
                return Some(format!("lock-by margin: {margin} blocks (lock-by {lock_by}, tip {tip}){last}"));
            }
            Some(format!("lock-by margin is short: {margin} blocks (lock-by {lock_by}, tip {tip}){last}; see the action"))
        }
        _ => None,
    }
}

/// Bob's last lock height for the notes. `exact`: the engine gives up at the first tip above `height`; otherwise `height` is only an upper bound
/// (the real limit is lower, or not known yet).
#[derive(Clone, Copy)]
struct LastLock {
    height: u64,
    exact: bool,
}

/// Bob's last lock height, from the conditions the engine's gates use (display only; read by nothing):
/// - `received` (no funding seen): `bob_action` aborts at `tip > g.bob_lock_by_min_window(D)`, but the limit that will apply to the lock is
///   `min(that, F + b_bob)` with `F` not known yet, so the height is only an upper bound.
/// - `funded` (funding seen, not final): the same height is only an upper bound, because `choose_t_reveal` will also stop `b_bob` blocks after the
///   funding is final, and that height is not known yet.
/// - `funding_final`: `choose_t_reveal` gives up at `tip > bob_lock_by_min_window(D)` (`PastLockBy`) and at `tip > final_at_tip + b_bob`
///   (`PastBobWindow`); exact. After a cancelled `lock_eth` intent the send is judged by `lock_reuse_safe` instead (`tip <= bob_lock_by_min_window(D)`
///   and more), so there the upper bound only.
///
/// `None` for Alice.
fn bob_last_lock_height(file: &SwapFile, phase: &Phase) -> Option<LastLock> {
    let params = &file.public.params;
    let g = params.profile.gates();
    let hard = g.bob_lock_by_min_window(params.deadline_height);
    match phase {
        Phase::Bob(BobPhase::Received) => Some(LastLock { height: hard, exact: false }),
        Phase::Bob(BobPhase::Funded { .. }) => Some(LastLock { height: hard, exact: false }),
        Phase::Bob(BobPhase::FundingFinal { final_at_tip, .. }) => match cancelled_lock(file) {
            CancelledLock::None => Some(LastLock { height: hard.min(final_at_tip.saturating_add(g.b_bob)), exact: true }),
            _ => Some(LastLock { height: hard, exact: false }),
        },
        _ => None,
    }
}

/// The sentence about the last lock height that goes after the lock-by margin note. Empty for Alice. Never printed next to an `abort` unless it
/// says that the height has passed (the abort may have another cause, and then the height says nothing about it). Statements only.
fn last_lock_clause(last: Option<LastLock>, action: &Action, tip: u64) -> String {
    let Some(last) = last else {
        return String::new();
    };
    if tip > last.height {
        return if last.exact {
            format!("; the last lock height {} has passed too", last.height)
        } else {
            format!("; the last lock height, at most {}, has passed too", last.height)
        };
    }
    if matches!(action, Action::Abort { .. }) {
        return String::new();
    }
    if last.exact {
        format!("; the last lock height is {}", last.height)
    } else {
        format!("; the last lock height is at most {}", last.height)
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
    // A root with more coins than one poll reads: the swap's own instance is in view, a second instance of the agreed amount cannot be ruled
    // out. What needs "there is exactly one" waits; a claim, a refund and a recovery do not need it and stay allowed.
    if noid.instances_truncated {
        match action {
            Action::LockEth { .. } | Action::FundNoid { .. } => {
                return Some("the contract root holds more coins than one read covers, so a second instance of the agreed amount cannot be ruled out; Bob does not lock and Alice does not fund on a partial list".into())
            }
            Action::RevealEth { .. } if !secret_may_be_public(file) => {
                return Some("the contract root holds more coins than one read covers, so a second instance of the agreed amount cannot be ruled out; Alice does not reveal on a partial list".into())
            }
            _ => {}
        }
    }
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

/// Bob's `lock_eth` against the second Parano1d node: the same valid instance (slot, creation id, amount, opening, authority),
/// fresh tip time, same epoch anchor within the same epoch, and tips within [`MAX_NOID_TIP_DIFF`] blocks.
fn noid_nodes_agree(file: &SwapFile, noid: &NoidObservation, second: &NoidObservation, now: u64) -> Result<(), String> {
    if let Some(why) = second_stale("noid (second node)", second.observed_at, now) {
        return Err(why);
    }
    if let Some(why) = noid_tip_time_blocker(second.tip_time, now) {
        return Err(format!("the second noid node's tip is not fresh: {why} (F5)"));
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
    if let Err(prob) = instance_ok(file, second) {
        let why = match prob {
            InstanceProblem::Ambiguous(w) | InstanceProblem::Rejected(w) => w,
        };
        return Err(format!("the second noid node disagrees on the contract instance: {why} (F5)"));
    }
    if second.instance_matches_opening == Some(false) {
        return Err("the second noid node reports that the instance does not match the opening (F5)".into());
    }
    if second.instances_truncated {
        return Err("the second noid node lists more coins at the contract root than one read covers, so a second instance of the agreed amount cannot be ruled out there (F5)".into());
    }
    if noid.instance_matches_opening == Some(true) && second.instance_matches_opening != Some(true) {
        return Err("the second noid node did not verify that the instance matches the opening (F5)".into());
    }
    if let (Some(a), Some(b)) = (noid.active_authority.as_deref(), second.active_authority.as_deref()) {
        if a != b {
            return Err("the two noid nodes disagree about the instance's active authority (F5)".into());
        }
    }
    if let (Some(a), Some(b)) = (noid.epoch_anchor, second.epoch_anchor) {
        if noid.tip / params::B_EPOCH == second.tip / params::B_EPOCH && a != b {
            return Err("the two noid nodes disagree on the epoch anchor in the same epoch (F5)".into());
        }
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

/// Alice's `reveal_eth` against the second Ethereum node: the same lock record (lock id, sender, receiver, hashlock, amount,
/// timelock, EOA checks, claimed and refunded flags) on the pinned chain and code, `finalized` heights within
/// [`MAX_ETH_FINALIZED_DIFF`] blocks, and the lock final at the LOWER of the two against the HIGHER reported lock block.
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
    if other.sender != lock.sender {
        differs.push("sender".to_string());
    }
    if other.hashlock != lock.hashlock {
        differs.push("hashlock".to_string());
    }
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
    if other.sender_is_eoa == Some(false) || (lock.sender_is_eoa == Some(true) && other.sender_is_eoa != Some(true)) {
        differs.push(format!("sender_is_eoa (node 1 {:?}, node 2 {:?})", lock.sender_is_eoa, other.sender_is_eoa));
    }
    if other.receiver_is_eoa == Some(false) || (lock.receiver_is_eoa == Some(true) && other.receiver_is_eoa != Some(true)) {
        differs.push(format!("receiver_is_eoa (node 1 {:?}, node 2 {:?})", lock.receiver_is_eoa, other.receiver_is_eoa));
    }
    if other.block_number != lock.block_number {
        differs.push(format!("block (node 1 {}, node 2 {})", lock.block_number, other.block_number));
    }
    if other.tx_hash != lock.tx_hash {
        differs.push("transaction".to_string());
    }
    if other.block_timestamp != lock.block_timestamp {
        differs.push(format!("block time (node 1 {:?}, node 2 {:?})", lock.block_timestamp, other.block_timestamp));
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
    let lock_block = lock.block_number.max(other.block_number);
    if lower < lock_block {
        if lock.block_number == other.block_number {
            return Err(format!(
                "the lock is final on one node only: finalized node 1 {a}, node 2 {b}, the lock is in block {lock_block} (the lower height decides; F5)"
            ));
        }
        return Err(format!(
            "the lock is final on one node only: finalized node 1 {a}, node 2 {b}, the lock is in block {} (node 1) / {} (node 2) (the lower height decides; F5)",
            lock.block_number, other.block_number
        ));
    }
    Ok(())
}

/// Display only: the second node's address as `" URL"` for a note (`scheme://host:port`, set by the command line), or nothing.
fn node_label(label: Option<&str>) -> String {
    label.map(|l| format!(" {l}")).unwrap_or_default()
}

/// The positive counterpart of `noid_nodes_agree`: said once the second Parano1d node has agreed (same instance, tips close enough), with the
/// values that were compared. Not said when the rule is waived or not evaluated. A note only; nothing reads it.
fn noid_agreement_note(noid: &NoidObservation, second: &NoidObservation) -> String {
    format!(
        "second Parano1d node agrees:{} at height {} (first node {}), {}",
        node_label(noid.second_label.as_deref()),
        second.tip,
        noid.tip,
        describe_instance_opt(noid.instance.as_ref())
    )
}

/// The positive counterpart of `eth_nodes_agree`: said once the second Ethereum node has agreed, with the values that were compared (the two
/// finalized heights and the lock, which is final at the lower of them). The latest block numbers are not compared and are not shown. A note only.
fn eth_agreement_note(eth: &EthObservation, second: &EthObservation, lock: &EthLock) -> String {
    let fin = |e: &EthObservation| e.finalized_block.map_or("unknown".to_string(), |f| f.to_string());
    format!(
        "second Ethereum node agrees:{} finalized {} (first node finalized {}), lock {} final at the lower of the two",
        node_label(eth.second_label.as_deref()),
        fin(second),
        fin(eth),
        short_id(&lock.lock_id)
    )
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
        Action::LockEth { .. } => match second_node_policy(
            file,
            noid.second.as_deref(),
            noid.second_error.as_deref(),
            // D2: `--acknowledge-producer-share` also waives the missing second node of THIS step when the one configured node is loopback (production).
            noid.single_node_ok || producer_gate::ack_waives_single_node(file.public.params.profile.gates(), noid),
            notes,
        ) {
            Err(why) => Some(why),
            Ok(None) => None,
            Ok(Some(second)) => {
                let verdict = noid_nodes_agree(file, noid, second, now).err();
                if verdict.is_none() {
                    notes.push(noid_agreement_note(noid, second));
                }
                verdict
            }
        },
        Action::RevealEth { lock_id } => match second_node_policy(file, eth.second.as_deref(), eth.second_error.as_deref(), eth.single_node_ok, notes) {
            Err(why) => Some(why),
            Ok(None) => None,
            Ok(Some(second)) => match eth.find_lock(lock_id) {
                Some(lock) => {
                    let verdict = eth_nodes_agree(file, eth, second, &lock, now).err();
                    if verdict.is_none() {
                        notes.push(eth_agreement_note(eth, second, &lock));
                    }
                    verdict
                }
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
            // CHAOS F-19 (seed 0x5eed0001, scenario 2792): her funding is on record (sent, or decided and never cancelled) and the root
            // lists several instances of the agreed amount, hers and a lookalike that someone else deposited. Until `D` nothing can be
            // done with that (Bob does not lock on a guess, she does not reveal with two); from `D` on the NOID is hers to take back,
            // and a file that never recorded an instance would print `abort` for ever and offer no recovery. She funded once, and an
            // allocation counter orders the deposits, so the oldest fitting instance is taken as hers; the others are named for the wallet.
            Err(InstanceProblem::Ambiguous(_)) if alice_funding_on_record(file, p) && params::alice_refund_ready(noid.tip, file.public.params.deadline_height) => {
                let mut fitting: Vec<NoidInstanceStatus> = noid.all_instances().into_iter().filter(|v| instance_fits(file, v)).collect();
                fitting.sort_by_key(|v| (v.instance.creation_id, v.instance.slot_index));
                let mine = fitting.first()?.instance.clone();
                notes.push(format!(
                    "{} instances of the agreed amount sit at the contract root and Alice funded once: the OLDEST (slot {}, creation {}) is taken as hers so that the NOID can be taken back at D {}; the others were deposited by someone else and are NOT refunded by this tool (refund them with the wallet): {} (CHAOS F-19)",
                    fitting.len(),
                    mine.slot_index,
                    mine.creation_id,
                    file.public.params.deadline_height,
                    describe_instances(&fitting, Some(&mine))
                ));
                Some(Event::NoidInstanceSeen { instance: mine, tip: noid.tip })
            }
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
        A::RefundIncluded { txid, height, instance } => match included_outcome(noid, txid, *height) {
            // CHAOS S3 (c): a close that took ANOTHER instance than the recorded one does not make the file `refunded` while the recorded one is at
            // the contract (it came back): the file goes back to waiting for its recovery (the event of a dropped close), and the normal path offers
            // `refund_noid` for it. Where a second node does not confirm the recorded instance absent, the file stays open and says so.
            Included::Final if recovery_target(file).is_some() => match recorded_instance_absence(file, instance, noid, now) {
                Absence::Absent => Some(Event::NoidTxFinal { tip: noid.tip }),
                Absence::Listed => {
                    notes.push(format!(
                        "the recovery close {txid} took another instance than the one this file recorded, and the recorded instance (slot {}, creation {}) is at the contract again: its recovery is due; the file is not `refunded`",
                        instance.slot_index, instance.creation_id
                    ));
                    Some(Event::NoidTxReorged { txid: txid.clone(), was_height: *height, still_pending: false, preimage: None })
                }
                Absence::Unconfirmed(why) => {
                    notes.push(format!("the recovery close {txid} is final but the file stays open: {why}"));
                    None
                }
            },
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
    file.history.iter().any(|h| {
        matches!(
            h.event.as_str(),
            "reveal_submitted"
                | "eth_claim_mined"
                | "eth_claim_reorged"
                | "eth_reveal_dropped"
                | REVEAL_PENDING_SEEN
                | REVEAL_MAYBE_PENDING
                | REVEAL_REVERTED_SEEN
        )
    })
}

/// REVIEW-6 R6-3: a claim of Alice's for this lock was MINED AND REVERTED (checked against the node from the hash the operator gave with
/// `--reveal-tx`): the secret is public although no `Claimed` event exists. `secret_may_be_public` counts it, so the re-send is judged by the
/// late cutoff `T_reveal - DE`, not by the first-publication cutoff. `live.js` reads the same name.
pub const REVEAL_REVERTED_SEEN: &str = "reveal_reverted_seen";

/// REVIEW-7 R7-5: is a reverted claim (`--reveal-tx`) established well enough to record [`REVEAL_REVERTED_SEEN`]? Each node's reading already
/// passed the watcher's checks (our contract, the lock's receiver, the claim selector and lock id, a preimage that opens the lock word, a block that
/// is on that node's canonical chain). On top of that, when a SECOND Ethereum node is configured (it answered, or it is `second_error`), both nodes
/// must report the same reverted claim: one node alone cannot flip the late-cutoff switch. `Ok(true)` = record it; `Ok(false)` = no node reports
/// one; `Err(why)` = at least one node reports one but the evidence is not enough (said in the notes; it is re-read on every poll).
fn reverted_claim_evidence(eth: &EthObservation, lock_id: Option<[u8; 32]>) -> Result<bool, String> {
    fn seen(e: &EthObservation, lock_id: Option<[u8; 32]>) -> Option<&crate::watch::RevertedClaim> {
        e.reverted_claim.as_ref().filter(|r| lock_id.is_none_or(|id| id == r.lock_id))
    }
    let first = seen(eth, lock_id);
    if eth.second.is_none() && eth.second_error.is_none() {
        return Ok(first.is_some());
    }
    let second = eth.second.as_deref().and_then(|e| seen(e, lock_id));
    match (first, second) {
        (None, None) => Ok(false),
        (Some(a), Some(b)) if a.lock_id == b.lock_id && a.preimage == b.preimage && a.tx_hash == b.tx_hash && a.block_number == b.block_number => Ok(true),
        (Some(_), Some(_)) => Err("--reveal-tx: the two Ethereum nodes report different reverted claims; the reverted claim is NOT recorded until they agree".to_string()),
        (one, _) => {
            let (who, other) = if one.is_some() { ("the first", "second") } else { ("the second", "first") };
            let why = match (&eth.second_error, eth.second.is_some()) {
                (Some(e), false) => format!("the second node failed ({e})"),
                _ => format!("the {other} node does not confirm it (see its --reveal-tx note)"),
            };
            Err(format!("--reveal-tx: {who} Ethereum node reports a mined, reverted claim but {why}; with two nodes configured both must agree, so it is NOT recorded yet"))
        }
    }
}

/// Alice's lock id as far as her phase knows it.
pub(crate) fn alice_lock_id(file: &SwapFile) -> Option<[u8; 32]> {
    match &file.phase {
        Phase::Alice(p) => p.lock().map(|l| l.lock_id),
        Phase::Bob(_) => None,
    }
}

/// Alice's file only: record [`REVEAL_REVERTED_SEEN`] once, either from an explicit reverted claim verified by the watcher
/// (and both nodes when two Ethereum nodes are configured), or in program mode (`file.eth_key.is_some()`) when Alice's
/// fresh per-swap Ethereum key already has a mined send (`latest > 0`) while the HTLC lock is still open (unclaimed and
/// unrefunded, confirmed by both nodes if a second node is configured).
fn note_reverted_reveal(file: &mut SwapFile, eth: &EthObservation, now: u64) {
    if file.role != Role::Alice || last_history(file, REVEAL_REVERTED_SEEN).is_some() {
        return;
    }
    if reverted_claim_evidence(eth, alice_lock_id(file)) == Ok(true) {
        file.log(REVEAL_REVERTED_SEEN, now);
        return;
    }
    if matches!(file.phase, Phase::Alice(AlicePhase::LockSeen { .. } | AlicePhase::LockFinal { .. }))
        && alice_lock_id(file).is_some_and(|id| eth_mined_reveal_lock_still_open(file, eth, &id, now))
    {
        file.log(REVEAL_REVERTED_SEEN, now);
    }
}

/// REVIEW-5 R5-1, library path: the reveal may have left the process ([`secret_may_be_public`], or an executor that reported an unknown
/// outcome, [`REVEAL_MAYBE_SENT`], a pending `reveal_eth` record, the reveal sidecar). Used only for the CUTOFF of a re-send (`T_reveal - DE`
/// instead of `T_reveal - M_A`): not for the two-instances rule, which waits for evidence and not for a crash that may have sent nothing.
/// The decision and the cutoff frozen into the `reveal_eth` intent ([`reveal_cutoff_for`]) both use this one predicate, so a file that the
/// library [`Runner`] left with such evidence and the command-line path then drives is offered the reveal and judged by the same cutoff.
fn reveal_may_have_been_sent(file: &SwapFile) -> bool {
    secret_may_be_public(file) || last_history(file, REVEAL_MAYBE_SENT).is_some() || reveal_pending_unknown(file) || reveal_sidecar_seen(file)
}

/// T21-11: the file carries [`REVEAL_SIDECAR_SEEN`]. Like [`REVEAL_MAYBE_SENT`] it says a reveal send was STARTED, not that it reached the network.
fn reveal_sidecar_seen(file: &SwapFile) -> bool {
    last_history(file, REVEAL_SIDECAR_SEEN).is_some()
}

/// The [`Runner`] saves a `reveal_eth` as a pending action with `maybe_sent: true` BEFORE it hands the reveal to the executor, and the marker
/// [`REVEAL_MAYBE_SENT`] is written only when the executor returns. A process that dies between the broadcast and that save leaves this pending
/// record and no marker, so the record itself counts: the reveal may be in the mempool, the secret may be public, and a re-send is judged by the
/// late cutoff (`T_reveal - DE`). A record whose executor said "nothing was sent" has `maybe_sent: false` and does not count.
fn reveal_pending_unknown(file: &SwapFile) -> bool {
    file.pending_action.as_ref().is_some_and(|p| p.kind == "reveal_eth" && p.maybe_sent)
}

/// REVIEW-5 R5-1, CLI path: Alice's receiver key had a transaction in the Ethereum mempool (pending nonce above the latest) while a
/// `reveal_eth` intent was held, so the claim was most likely sent and her secret is in the public mempool. Written once by
/// [`tick_apply`]; `secret_may_be_public` counts it, `live.js` reads the same name.
pub const REVEAL_PENDING_SEEN: &str = "reveal_pending_seen";
/// Program mode (fresh per-swap Ethereum key): in `lock_seen` or `lock_final`, the file holds no reveal evidence yet, but the node
/// reports a pending send waiting on Alice's swap key (latest nonce 0, pending nonce > 0). Because Alice's fresh swap key sends nothing
/// before the reveal, that send can only be the reveal, so the secret may already be public and the late cutoff `T_reveal - DE` applies.
/// Written once by [`tick_apply`]; `secret_may_be_public` counts it, `live.js` reads the same name.
pub const REVEAL_MAYBE_PENDING: &str = "reveal_maybe_pending";
/// T21-11: `live.js claim --swap FILE` wrote the reveal sidecar (`<swap file>.reveal-sent`) for THIS lock just before it broadcast the claim, so
/// the secret may be public although no tick saw the claim in the pool. Written once by `tick` (see `reveal_sidecar`). It is evidence that a send
/// was STARTED, like [`REVEAL_MAYBE_SENT`], so it relaxes the CUTOFF of a re-send only (`T_reveal - DE` instead of `T_reveal - M_A`, in
/// [`reveal_may_have_been_sent`] and [`reveal_cutoff_for`]) and counts as reveal evidence for `lost`; it is NOT in [`secret_may_be_public`], so the
/// instance-visible rule (CHAOS F-13) and the two-instances rule (R4-4) keep waiting for real evidence. `live.js` reads the same name.
pub const REVEAL_SIDECAR_SEEN: &str = "reveal_sidecar_seen";
/// REVIEW-5 R5-1, library path: the [`Runner`] handed the reveal to its executor and the executor said the outcome is unknown (it may have
/// been sent). Written once. A failure the executor knows sent nothing leaves no marker.
pub const REVEAL_MAYBE_SENT: &str = "reveal_maybe_sent";

fn pending_preimage_matches(file: &SwapFile, lock_id: [u8; 32], p: &crate::watch::PendingPreimage) -> bool {
    if p.lock_id != lock_id {
        return false;
    }
    let s = crate::secret::Secret::from_bytes(p.preimage);
    s.lock_word(file.public.params.eth.lock_kind) == file.public.hashlock
}

/// Program mode (fresh per-swap key): does the observation (and the second Ethereum node, if configured)
/// agree that Alice's swap key has latest nonce 0 and a pending send waiting?
fn eth_pending_at_zero_agreed(file: &SwapFile, eth: &EthObservation, now: u64) -> bool {
    if eth.observed_at.is_none_or(|t| t.abs_diff(now) > MAX_OBSERVATION_AGE_S)
        || eth.chain_id != Some(file.public.params.eth.chain_id)
        || eth.second_error.is_some()
    {
        return false;
    }
    let p1 = matches!((eth.signer_nonce_latest, eth.signer_nonce_pending), (Some(0), Some(p)) if p > 0);
    let p2 = match eth.second.as_deref() {
        Some(s) => {
            s.observed_at.is_some_and(|t| t.abs_diff(now) <= MAX_OBSERVATION_AGE_S)
                && s.chain_id == Some(file.public.params.eth.chain_id)
                && matches!((s.signer_nonce_latest, s.signer_nonce_pending), (Some(0), Some(p)) if p > 0)
        }
        None => true,
    };
    p1 && p2
}

/// Program mode (fresh per-swap key): does either configured Ethereum node already report a mined send (latest nonce > 0)?
fn eth_mined_nonce_seen(eth: &EthObservation) -> Option<u64> {
    eth.signer_nonce_latest
        .filter(|&l| l > 0)
        .or_else(|| eth.second.as_deref().and_then(|s| s.signer_nonce_latest.filter(|&l| l > 0)))
}

/// Program mode (fresh per-swap key): do all configured Ethereum nodes agree that Alice's swap key already has
/// a mined send (`latest > 0`) while this swap's HTLC lock is still open (unclaimed and unrefunded)?
/// Because Alice's swap key sends nothing before the reveal, a mined send with the lock still open can only be
/// a reverted reveal whose calldata already published the secret.
fn eth_mined_reveal_lock_still_open(file: &SwapFile, eth: &EthObservation, lock_id: &[u8; 32], now: u64) -> bool {
    if file.role != Role::Alice || file.eth_key.is_none() {
        return false;
    }
    let node_shows_reverted = |obs: &EthObservation| {
        obs.observed_at.is_some_and(|t| t.abs_diff(now) <= MAX_OBSERVATION_AGE_S)
            && obs.chain_id == Some(file.public.params.eth.chain_id)
            && obs.signer_nonce_latest.is_some_and(|l| l > 0)
            && obs.claimed.is_none()
            && obs.refunded.is_none()
            && obs.find_lock(lock_id).is_some_and(|l| !l.claimed && !l.refunded)
    };
    if eth.second_error.is_some() || !node_shows_reverted(eth) {
        return false;
    }
    match eth.second.as_deref() {
        Some(s) => node_shows_reverted(s),
        None => true,
    }
}

/// Records pending-reveal evidence once from a fresh Ethereum observation on our chain (requiring both nodes to agree whenever a second
/// Ethereum node is configured):
/// 1. [`REVEAL_PENDING_SEEN`]: a `reveal_eth` intent is held and the receiver key's pending nonce exceeds its latest nonce, OR Alice is
///    in `lock_seen`/`lock_final` and the watcher reports a pending claim of her lock carrying the valid preimage.
/// 2. [`REVEAL_MAYBE_PENDING`]: program mode only (`file.eth_key.is_some()`), Alice is in `lock_seen` or `lock_final` with no reveal
///    evidence in the file yet and no mined claim observed, and the node reports latest nonce 0 and pending nonce > 0 on Alice's swap key.
/// Once either is recorded, `secret_may_be_public` is true and the late cutoff (`T_reveal - DE`) applies immediately.
fn note_reveal_pending(file: &mut SwapFile, eth: &EthObservation, now: u64) {
    if file.role != Role::Alice {
        return;
    }
    if eth.observed_at.is_none_or(|t| t.abs_diff(now) > MAX_OBSERVATION_AGE_S) {
        return;
    }
    if eth.chain_id != Some(file.public.params.eth.chain_id) {
        return;
    }
    // When a second Ethereum node is configured, a single primary node alone cannot flip the pending-reveal markers.
    if eth.second_error.is_some() {
        return;
    }
    let second_ok = eth.second.as_deref().map(|s| {
        s.observed_at.is_some_and(|t| t.abs_diff(now) <= MAX_OBSERVATION_AGE_S)
            && s.chain_id == Some(file.public.params.eth.chain_id)
    });
    if second_ok == Some(false) {
        return;
    }

    if last_history(file, REVEAL_PENDING_SEEN).is_none() {
        // Held reveal_eth intent + receiver pending nonce > latest nonce.
        let intent_path = if file.pending_intent.as_ref().is_some_and(|i| i.action == "reveal_eth") {
            let p1 = matches!((eth.signer_nonce_latest, eth.signer_nonce_pending), (Some(l), Some(p)) if p > l);
            let p2 = match eth.second.as_deref() {
                Some(s) => matches!((s.signer_nonce_latest, s.signer_nonce_pending), (Some(l), Some(p)) if p > l),
                None => true,
            };
            p1 && p2
        } else {
            false
        };

        // Explicit pending claim of Alice's own lock carrying the valid preimage, even with no held intent.
        let pending_claim_path = if matches!(file.phase, Phase::Alice(AlicePhase::LockSeen { .. } | AlicePhase::LockFinal { .. })) {
            if let Some(lock_id) = alice_lock_id(file) {
                let p1 = eth.pending_preimage.as_ref().filter(|p| pending_preimage_matches(file, lock_id, p));
                match (p1, eth.second.as_deref()) {
                    (Some(a), Some(s)) => s.pending_preimage.as_ref().is_some_and(|b| b.lock_id == lock_id && b.preimage == a.preimage),
                    (Some(_), None) => true,
                    _ => false,
                }
            } else {
                false
            }
        } else {
            false
        };

        if intent_path || pending_claim_path {
            file.log(REVEAL_PENDING_SEEN, now);
        }
    }

    // Fresh per-swap Ethereum key (program mode): in lock_seen or lock_final with no reveal evidence in the file yet,
    // a pending send waiting on Alice's swap key (latest nonce 0, pending nonce > 0) can only be the reveal.
    if file.eth_key.is_some()
        && last_history(file, REVEAL_MAYBE_PENDING).is_none()
        && matches!(file.phase, Phase::Alice(AlicePhase::LockSeen { .. } | AlicePhase::LockFinal { .. }))
        && !reveal_evidence(file)
        && !secret_may_be_public(file)
        && eth.claimed.is_none()
        && eth_pending_at_zero_agreed(file, eth, now)
    {
        file.log(REVEAL_MAYBE_PENDING, now);
    }
}

/// The latest time Alice's reveal may still be sent under this file's profile: the `M_A` cutoff, or `T_reveal - DE` once the reveal may
/// already have been sent ([`reveal_may_have_been_sent`], the predicate the decision uses too; Review H1). The intent freezes this value.
pub fn reveal_cutoff_for(file: &SwapFile, t_reveal: u64) -> u64 {
    let g = file.public.params.profile.gates();
    if reveal_may_have_been_sent(file) {
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
        || file.history.iter().any(|h| {
            matches!(
                h.event.as_str(),
                "reveal_submitted"
                    | "eth_reveal_dropped"
                    | REVEAL_PENDING_SEEN
                    | REVEAL_MAYBE_PENDING
                    | REVEAL_REVERTED_SEEN
                    | REVEAL_SIDECAR_SEEN
            )
        })
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

/// CHAOS M3: the log-only entry `noid_alive_at_d_tip:<tip>` beside Bob's `noid_instance_alive_at_d`: the Parano1d tip of the poll that wrote it.
const BOB_ALIVE_TIP: &str = "noid_alive_at_d_tip:";

/// CHAOS F-11, Bob (the counterpart of CHAOS F-17): once the recorded instance has been seen at the contract in a poll in which his claim could no
/// longer be included, its later disappearance can only be a RECOVERY close (a close at `h >= D` pays Alice), never a claim of his. A log-only fact,
/// once, only in `secret_seen`. Because a false "alive at D" would end his file as "claim can no longer happen" although he was paid (a one-block
/// reorg at the boundary can still put his own pending claim into block `D - 1`), it is written only from a poll in which block `D - 1` is FINAL
/// (CHAOS M2), and, where a second node is configured, only when that node is fresh, level (also past the final `D - 1`) and lists the instance too
/// (the rule of `alice_gone_trace`); with a second node that could not be read, or required and absent, it is not written.
fn bob_alive_at_d(file: &SwapFile, p: &BobPhase, noid: &NoidObservation, now: u64) -> Option<Event> {
    let d = file.public.params.deadline_height;
    if last_history(file, "noid_instance_alive_at_d").is_some() || !params::alice_refund_ready(noid.tip, d) {
        return None;
    }
    if !matches!(p, BobPhase::SecretSeen { .. }) || !params::noid_final(noid.tip, d.saturating_sub(1)) {
        return None;
    }
    let instance = p.instance()?;
    noid.find_instance(instance)?;
    match noid.second.as_deref() {
        Some(second) => {
            if second_stale("noid (second node)", second.observed_at, now).is_some() || !params::noid_final(second.tip, d.saturating_sub(1)) || second.find_instance(instance).is_none() {
                return None;
            }
        }
        None => {
            if noid.second_error.is_some() || (file.public.params.profile.requires_second_node() && !noid.single_node_ok) {
                return None;
            }
        }
    }
    Some(Event::NoidInstanceAliveAtD)
}

/// CHAOS F-19: Alice's file shows that a funding of hers was sent or may have been: the phase says so (`funding_submitted`), or a
/// `fund_noid` was handed to the executor and its outcome is unknown (`pending_action`), or the CLI decided one and the operator never
/// cancelled it (`intent_decided:fund_noid`). Without such a trace an instance at the root is nobody's business of hers.
fn alice_funding_on_record(file: &SwapFile, p: &AlicePhase) -> bool {
    let decided = last_history(file, "intent_decided:fund_noid");
    matches!(p, AlicePhase::FundingSubmitted { .. })
        || file.pending_action.as_ref().is_some_and(|a| a.kind == "fund_noid")
        || file.pending_intent.as_ref().is_some_and(|i| i.action == "fund_noid")
        || (decided.is_some() && decided > last_history(file, "intent_cancelled:fund_noid"))
}

/// The phases that collect the evidence about WHEN the recorded instance went (CHAOS F-18): the ones `lost` can be declared from, and, since CHAOS
/// M1, `revealed` and `done` too (a recovery close for another instance after the reveal is offered only if the recorded one was not claimed by Bob,
/// which only a poll before `D` that saw it gone can show; a claim of Alice's that a reorg drops sends her back to `reveal_submitted`, which also
/// records it).
fn alice_tracks_instance(p: &AlicePhase) -> bool {
    matches!(p, AlicePhase::LockFinal { .. } | AlicePhase::RevealSubmitted { .. } | AlicePhase::Revealed { .. } | AlicePhase::Done { .. })
}

/// CHAOS F-18: the recorded instance is marked gone (a poll with `tip < D` did not list it) and not marked back since.
fn instance_marked_gone_before_d(file: &SwapFile) -> bool {
    let gone = last_history(file, "noid_instance_gone_before_d");
    gone.is_some() && last_history(file, "noid_instance_back_after_gone") < gone
}

/// CHAOS F-18 (found by the long chaos runs: base seed `0xc4a05eed`, scenario 1259): an instance that is gone at `D + B_FINAL` was
/// closed either by Bob's claim (included at `h < D`) or by Alice's own recovery (included at `h >= D`, outside this tool, perhaps
/// never recorded with `--closed-by`). The tool cannot tell the two apart from a poll made after `D`, and a terminal `lost` has to be
/// true. The one fact that does tell them apart: a poll with `tip < D` that did not list the instance, because nothing but the claim
/// branch can close it before `D`. This writes that fact (log-only) and takes it back when the instance is listed again (a reorg
/// that dropped the close), so an absence a reorg undid proves nothing. `alice_both_legs_lost` needs it.
fn alice_gone_trace(file: &SwapFile, p: &AlicePhase, noid: &NoidObservation) -> Option<Event> {
    if !alice_tracks_instance(p) {
        return None;
    }
    let instance = p.instance()?;
    let marked = instance_marked_gone_before_d(file);
    if noid.find_instance(instance).is_some() {
        return marked.then_some(Event::NoidInstanceBackAfterGone);
    }
    if marked || noid.tip >= file.public.params.deadline_height {
        return None;
    }
    // A second node that still lists it, or one that could not be read, takes the word of the first away.
    if noid.second_error.is_some() || noid.second.as_deref().is_some_and(|s| s.find_instance(instance).is_some()) {
        return None;
    }
    Some(Event::NoidInstanceGoneBeforeD)
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
    // CHAOS F-18: the instance being gone is not enough, nor is it enough that Bob COULD have claimed it. Positive evidence is needed that
    // it went before `D` (only the claim branch closes then): a poll with `tip < D` that did not list it. Without that poll the close
    // may be Alice's own recovery at `h >= D` that nobody recorded, and `lost` would be false (a terminal state must be true).
    // CHAOS F-11: the operator's `tick --closed-by` of a close that was included before D is the same evidence, from the chain's receipts.
    if !instance_marked_gone_before_d(file) && last_history(file, "noid_closed_before_deadline").is_none() {
        notes.push(
            "the NOID instance is gone and the ETH refund is final, but no poll made before D ever saw it gone: a close at or after D is Alice's own recovery, and from a poll after D the tool cannot tell it from Bob's claim; not declaring both legs lost (CHAOS F-18). If your wallet closed it, record that with `tick --closed-by`; if it did not, check the contract receipts: the NOID went to Bob and the file stays in this phase"
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
/// or Alice's close was included before `D` in a phase before her reveal (it paid Bob). Bob's close at or after `D` is recorded as
/// [`Event::NoidClosedAfterDeadline`] (it paid Alice, so it is no claim of his), and Alice's close before `D` in `lock_final` /
/// `reveal_submitted` as [`Event::NoidClosedBeforeDeadline`] (it paid Bob, so it is no recovery of hers); CHAOS F-11. `getTx` returns only
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
        // CHAOS F-11: where her secret may be public (`reveal_submitted`, or `lock_final` with a reveal on record), a close before D is the claim branch
        // (it paid Bob): recorded as such, log-only. Before the reveal nobody can have claimed it, so such a close is not one this file can explain.
        Role::Alice if c.height < d && (matches!(&file.phase, Phase::Alice(AlicePhase::RevealSubmitted { .. })) || (matches!(&file.phase, Phase::Alice(AlicePhase::LockFinal { .. })) && reveal_evidence(file))) => {
            require_final_close(&txid, c.height, noid)?;
            return Ok(Event::NoidClosedBeforeDeadline { txid, height: c.height });
        }
        Role::Alice if c.height < d => {
            return Err(format!(
                "transaction {txid} was included at height {}, before the deadline D {d}: a close then pays Bob (the claim branch), so it is not Alice's recovery; nothing is recorded",
                c.height
            ))
        }
        // CHAOS F-11: a close at or after D pays Alice, so it is not Bob's claim; it is recorded as what it is (log-only, the phase does not move):
        // the NOID leg of this file can no longer be claimed, and `bob_claim_action` ends it with an `abort` once the ETH leg is settled.
        Role::Bob if c.height >= d => {
            require_final_close(&txid, c.height, noid)?;
            return Ok(Event::NoidClosedAfterDeadline { txid, height: c.height });
        }
        _ => {}
    }
    Ok(Event::NoidClosedExternally { txid, height: c.height })
}

/// CHAOS M3: the two log-only closes of `tick --closed-by` end a leg of the swap file, so the close must be final (18 blocks deep) first.
fn require_final_close(txid: &str, height: u64, noid: &NoidObservation) -> Result<(), String> {
    let tip = noid.tip;
    if !params::noid_final(tip, height) {
        return Err(format!(
            "transaction {txid} was included at height {height} but is not final yet (tip {tip}, final from tip {}): a reorg can still move it; run again once it is final, nothing is recorded",
            height + params::NOID_FINALITY_DEPTH
        ));
    }
    // Where a second node is configured it must see the close final too (as the `lost` path asks of it).
    if let Some(e) = noid.second_error.as_deref() {
        return Err(format!("the second node could not be read ({e}): it must see transaction {txid} final too; nothing is recorded"));
    }
    if let Some(second) = noid.second.as_deref() {
        if !params::noid_final(second.tip, height) {
            return Err(format!(
                "transaction {txid} was included at height {height}, but the second node's tip {} is below the final height {}: it must see it final too; run again once both do, nothing is recorded",
                second.tip,
                height + params::NOID_FINALITY_DEPTH
            ));
        }
    }
    Ok(())
}

/// What a tick learns about a close that is recorded as included at some height (REVIEW-2 F6).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Included {
    /// Confirmed at the recorded height and the tip is 18 blocks past it ([`params::NOID_FINALITY_DEPTH`]).
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

/// The note that asks the operator to act when a reorg took Bob's mined NOID claim back out of the chain and it is not pending either (his
/// file goes back to `secret_seen` and the next tick offers `claim_noid` again). Nothing is sent by the tool: the dry run and the submit are
/// the operator's commands (`claim.sh` of `scripts/live`). The line starts with `ALERT:` so that `scripts/live/watch.sh` can pass it on
/// (docs/bob-concentration-gate.md section 10); it names no address, amount or transaction.
pub const CLAIM_REMOVED_ALERT: &str = "ALERT: a reorg removed Bob's NOID claim from the chain and it is not pending. Send it again: `bash $L/bin/claim.sh` is the dry run, check it, then `bash $L/bin/claim.sh --submit` ($L is the helpers' run folder). Then check on the next tick that the claim is in the pool or included, and send it again if it is gone (the node can drop a claim sent just before it handles a reorg); a claim built near the end of a 144-block epoch can expire unconfirmed and must be built again";

fn claim_removed_alert() -> String {
    CLAIM_REMOVED_ALERT.to_string()
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
    reveal_cutoff_passed: &mut bool,
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
            // The funding opens `D_offset` blocks before `H_create` (never earlier than the trial start). `H_create` itself only plans `D`:
            // the contract commits `D`, not a creation height, so a funding before it is accepted by both engines and by the chain.
            let (opens_at, trial_bound) = funding_opens_at(file);
            if noid.tip.saturating_add(1) < opens_at {
                // Instances at the root that are not accepted are the real matter, whatever the tip is (live run 9).
                let reason = alice_instance_problem_text(file, noid).unwrap_or_else(|| too_early_to_fund_text(file, noid.tip, opens_at, trial_bound));
                return Action::Wait { reason };
            }
            Action::FundNoid { amount_micronoid: file.public.params.amount_micronoid }
        }
        A::FundingSubmitted { .. } => Action::Wait { reason: "funding not yet visible".into() },
        A::Funded { .. } => Action::Wait { reason: "waiting for funding finality".into() },
        A::FundingFinal { .. } | A::LockSeen { .. } => {
            if params::alice_refund_ready(noid.tip, d) {
                return refund(noid);
            }
            if let A::LockSeen { lock, .. } = p {
                if file.eth_key.is_some() {
                    if let Some(l) = eth_mined_nonce_seen(eth) {
                        if eth_mined_reveal_lock_still_open(file, eth, &lock.lock_id, now) {
                            notes.push(format!(
                                "Alice's swap Ethereum key already has latest nonce {l} (> 0) while the lock is still open (unclaimed and unrefunded): treating this as a reverted reveal whose secret may be public"
                            ));
                        } else {
                            notes.push(format!(
                                "Alice's swap Ethereum key already has latest nonce {l} (> 0) and the lock state is not confirmed open on all configured nodes; waiting for the lock state from the chain"
                            ));
                        }
                    } else if eth_pending_at_zero_agreed(file, eth, now) {
                        notes.push(format!(
                            "Alice's swap Ethereum key has a send waiting at nonce 0 (latest 0, pending {}); the reveal may be pending and the secret may be public; re-send with --replace at a higher fee cap instead of a plain second send",
                            eth.signer_nonce_pending.unwrap_or(1)
                        ));
                    }
                }
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
            // Program mode (fresh per-swap Ethereum key): if the swap key already has a mined send (latest nonce > 0):
            // - if the lock is confirmed still open (unclaimed and unrefunded) on all configured nodes, the mined send
            //   was a reverted reveal (secret may already be public), so record REVEAL_REVERTED_SEEN and allow a re-send
            //   under the late cutoff T_reveal - DE;
            // - otherwise (lock claimed/refunded, lagging, or second node disagrees), wait and never send a second reveal.
            if file.eth_key.is_some() {
                if let Some(latest_n) = eth_mined_nonce_seen(eth) {
                    if eth_mined_reveal_lock_still_open(file, eth, &lock.lock_id, now) {
                        notes.push(format!(
                            "Alice's swap Ethereum key already has latest nonce {latest_n} (> 0) while the lock is still open (unclaimed and unrefunded): treating this as a reverted reveal whose secret may already be public; offering a re-send under the late cutoff T_reveal - DE"
                        ));
                    } else {
                        let why = format!(
                            "Alice's swap Ethereum key already has latest nonce {latest_n} (> 0) and the lock is not confirmed open on all configured nodes; waiting for the lock state from the chain and never sending a second reveal"
                        );
                        notes.push(why.clone());
                        // After D the NOID contract only allows recovery, so an Ethereum read that fails or lags must not hold it back.
                        return if params::alice_refund_ready(noid.tip, d) {
                            refund(noid)
                        } else {
                            Action::Wait { reason: why }
                        };
                    }
                }
            }
            if eth.pending_preimage.as_ref().is_some_and(|p| pending_preimage_matches(file, lock.lock_id, p)) {
                notes.push(
                    "a pending reveal of this lock carrying the secret is already in the Ethereum mempool; re-send with --replace at a higher fee cap instead of a plain second send".into(),
                );
            }
            // Review H1: once the secret may already be public (a reveal that was sent, mined, reorged or dropped), the reason for the
            // `M_A` cutoff is gone (it protects a first publication that has no time to be final); what is left is to get a claim mined
            // before `T_reveal`, so a re-send is allowed until `T_reveal - DE`.
            let i2 = g.check_i2_eth(t_now, lock.t_reveal, true).or_else(|e| {
                if reveal_may_have_been_sent(file) && t_now.saturating_add(g.de_s) <= lock.t_reveal {
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
                    // Program mode (fresh per-swap key): if latest nonce is 0 and a send is already waiting in the mempool
                    // with no held intent in this file, never offer a plain second reveal; direct the operator to re-send with --replace.
                    if file.eth_key.is_some() && file.pending_intent.is_none() && eth_pending_at_zero_agreed(file, eth, now) {
                        let pending_n = eth.signer_nonce_pending.unwrap_or(1);
                        let why = format!(
                            "Alice's swap Ethereum key has a send waiting at nonce 0 (latest 0, pending {pending_n}); the reveal may be pending and the secret may be public; re-send with --replace at a higher fee cap instead of a plain second send"
                        );
                        notes.push(why.clone());
                        return Action::Wait { reason: why };
                    }
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
                    // The cutoff text itself is a statement (it is also part of the re-send note above, beside `reveal_eth`); the sentence about the
                    // reveal is added here only, where the action is not a reveal, and it names what must not be sent.
                    notes.push(match &e {
                        params::GateError::RevealCutoffPassed { .. } => {
                            *reveal_cutoff_passed = true;
                            format!("not revealing: {e}; the reveal must not be broadcast")
                        }
                        _ => format!("not revealing: {e}"),
                    });
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
        A::RefundSubmitted { .. } => Action::Wait { reason: format!("NOID refund pending{}", adoption_suffix(file)) },
        A::RefundIncluded { .. } => Action::Wait { reason: format!("waiting for NOID refund finality{}", adoption_suffix(file)) },
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
            reason: {
                let base: String = {
                // The ETH claim counts as seen mined when it is final, or when its last `eth_claim_mined` is not followed by an
                // `eth_claim_reorged` (a claim that was mined and then taken back by a reorg is not a received claim).
                let claim_seen = last_history(file, "eth_claim_final").is_some() || last_history(file, "eth_claim_mined") > last_history(file, "eth_claim_reorged");
                if let Some(t) = recovery_target(file) {
                    // The recovery close took ANOTHER instance than the recorded one (CHAOS X1/S3): what is true for that, and no claim about the
                    // recorded one.
                    return Action::Wait {
                        reason: format!(
                            "done: NOID refunded; the recovery close took another instance of the agreed amount (slot {}, creation {}) than the one this file recorded, which this file never saw closed{}",
                            t.slot_index,
                            t.creation_id,
                            if claim_seen { "; the ETH claim was seen mined" } else { "" }
                        ),
                    };
                }
                if claim_seen {
                    "done: NOID refunded after the reveal; Bob never claimed it (as far as this tool saw, the refund closed the instance, so it was still unspent), so both legs ended with Alice".into()
                } else if reveal_evidence(file) || reveal_may_have_been_sent(file) {
                    // Every kind of reveal evidence counts here (a decided intent, a sent or dropped reveal, a reverted claim, the sidecar,
                    // an unknown outcome): the reveal was at least started, and no mined claim is on record.
                    "done: NOID refunded; this file shows a reveal that was started or sent, and this tool did not see the ETH claim mined (never, or it was removed by a reorg), so check the ETH lock yourself (if Bob refunded it, each side got its own funds back)".into()
                } else {
                    "done: NOID refunded".into()
                }
            };
                format!("{base}{}", adoption_suffix(file))
            },
        },
        A::Lost { reason, .. } => Action::Wait { reason: format!("lost: {reason}") },
        A::Aborted { reason } => Action::Wait { reason: format!("aborted: {reason}") },
    }
}

/// CHAOS X1: the instance Alice's recovery close acts on when the one her file recorded is not at the contract any more.
struct RecoveryAdoption {
    recorded: NoidInstance,
    /// The oldest instance of the agreed amount at the root (lowest creation, then slot): the one this recovery is for.
    adopted: NoidInstanceStatus,
    /// The other instances at the root (of any amount): not covered by this call.
    others: Vec<NoidInstanceStatus>,
}

impl RecoveryAdoption {
    /// A statement of what is recovered and that it is not the recorded instance; nothing that tells the operator what to do.
    fn note(&self, file: &SwapFile) -> String {
        let a = &self.adopted.instance;
        let mut text = format!(
            "the recorded instance (slot {}, creation {}) is not at the contract and this file never saw it closed; D {} is reached, so the recovery close (refund_noid) is for the oldest instance of the agreed amount at the root: slot {}, creation {}, which is NOT the recorded one (every instance at this opening pays Alice on the recovery branch)",
            self.recorded.slot_index, self.recorded.creation_id, file.public.params.deadline_height, a.slot_index, a.creation_id
        );
        if !self.others.is_empty() {
            text.push_str(&format!(
                "; {} other instance(s) sit at the contract root and are not covered by this close: {}",
                self.others.len(),
                describe_instances(&self.others, None)
            ));
        }
        text
    }
}

/// CHAOS M1: may Alice's reveal be out (the secret public) in this phase? `reveal_submitted`, `revealed`, `done`, and `lock_final` with a reveal on
/// record or possibly sent (the command-line path stays in `lock_final` after the operator sent it); and any phase whose history shows a reveal.
fn alice_reveal_may_be_out(file: &SwapFile, p: &AlicePhase) -> bool {
    match p {
        AlicePhase::RevealSubmitted { .. } | AlicePhase::Revealed { .. } | AlicePhase::Done { .. } => true,
        // Any other phase: by the history, not by the phase (a file sent back to `funding_final` by a reorged close still has its reveal on record).
        _ => reveal_evidence(file) || reveal_may_have_been_sent(file),
    }
}

/// CHAOS M1 (e): the log-only history entry written when a recovery close is offered for an instance other than the recorded one:
/// `noid_recovery_adopted:<slot>:<creation>:<amount>`. A helper or an executor reads the target from it ([`recovery_target`]).
const RECOVERY_ADOPTED: &str = "noid_recovery_adopted:";

/// The instance a recovery close is for when the file adopted another one than it recorded (the last `noid_recovery_adopted:` entry), else `None`
/// (then it is the recorded instance). For executors and helpers: the action itself names no instance.
/// The slot of the NOID instance this file is committed to, looked up directly when the root lists more coins than one poll reads, and whether
/// a read that is cut short is then usable (it is, whenever such a slot is known: the engine refuses what needs the full list, see
/// [`spend_blocker`]). `funding_slot` is the output slot of Alice's funding record, for `funding_submitted` (no instance is recorded yet).
/// Phases before any instance exists give `(None, false)`: a cut-short read is an error there.
pub fn noid_tracking(file: &SwapFile, funding_slot: Option<u32>) -> (Option<u32>, bool) {
    let slot = match &file.phase {
        Phase::Bob(p) => p.instance().map(|i| i.slot_index),
        Phase::Alice(p) => recovery_target(file)
            .map(|i| i.slot_index)
            .or_else(|| p.instance().map(|i| i.slot_index))
            .or(if matches!(p, AlicePhase::FundingSubmitted { .. }) { funding_slot } else { None }),
    };
    (slot, slot.is_some())
}

pub fn recovery_target(file: &SwapFile) -> Option<NoidInstance> {
    let e = file.history.iter().rev().find_map(|h| h.event.strip_prefix(RECOVERY_ADOPTED))?;
    // The reset entry (`noid_recovery_adopted:recorded`): a recovery close was decided for the recorded instance again.
    if e == "recorded" {
        return None;
    }
    let mut parts = e.split(':');
    Some(NoidInstance { slot_index: parts.next()?.parse().ok()?, creation_id: parts.next()?.parse().ok()?, amount_micronoid: parts.next()?.parse().ok()? })
}

/// The sentence added to every text after an adoption: the instance recovered was not the one the file recorded.
fn adoption_suffix(file: &SwapFile) -> String {
    match recovery_target(file) {
        Some(t) => format!(
            "; the instance recovered was not the one this file recorded: the oldest instance of the agreed amount at the root (slot {}, creation {}) was taken for the recovery close (history entry `{RECOVERY_ADOPTED}`)",
            t.slot_index, t.creation_id
        ),
        None => String::new(),
    }
}

/// CHAOS X1 (seed 0xfeed42, scenario 583): Alice's file recorded an instance that is not at the contract in this poll, the recovery branch is open
/// (`alice_refund_ready`), the file never saw that instance closed, and an instance of the agreed amount sits at the root (the funding came back
/// as another incarnation after reorgs, or her close was dropped by one). The oldest such instance is the one a recovery close acts on, with the
/// same choice rule as CHAOS F-19 (`created` / `funding_submitted`). It is decided afresh from the observation at every tick and written nowhere:
/// the recorded instance of the phase is never replaced, so nothing before `D` (the reveal in particular, which needs the RECORDED instance in view)
/// reads it, and a reorg that takes the tip back below `D` leaves every earlier decision exactly as it was. Only BEFORE a reveal (CHAOS S1: after
/// one the recorded instance may have been claimed by Bob, and no evidence the file can collect rules that out), only when no poll saw the instance
/// gone before `D`, and only when a configured second node backs the first (CHAOS S3).
fn alice_recovery_adoption(file: &SwapFile, phase: &Phase, noid: &NoidObservation, now: u64) -> Option<RecoveryAdoption> {
    match alice_recovery_check(file, phase, noid, now) {
        RecoveryCheck::Yes(a) => Some(a),
        _ => None,
    }
}

/// CHAOS S3: what the adoption rule says about this observation.
enum RecoveryCheck {
    /// The rule does not apply (phase, height, evidence), or no instance of the agreed amount is at the root.
    No,
    /// Everything holds but the second node does not back the first one's word that the recorded instance is gone: not adopted, and the reason.
    Blocked(String),
    Yes(RecoveryAdoption),
}

/// CHAOS S3: is the recorded instance confirmed absent? The first node does not list it, and a configured second node is fresh and does not list it
/// either (the rule of `alice_gone_trace`); a second node that could not be read, or one that the profile requires and is absent, confirms nothing.
enum Absence {
    Absent,
    /// A node lists it.
    Listed,
    Unconfirmed(String),
}

fn recorded_instance_absence(file: &SwapFile, recorded: &NoidInstance, noid: &NoidObservation, now: u64) -> Absence {
    if noid.find_instance(recorded).is_some() {
        return Absence::Listed;
    }
    match noid.second.as_deref() {
        Some(second) => {
            if let Some(why) = second_stale("noid (second node)", second.observed_at, now) {
                return Absence::Unconfirmed(why);
            }
            if second.find_instance(recorded).is_some() {
                return Absence::Listed;
            }
            Absence::Absent
        }
        None => {
            if let Some(e) = noid.second_error.as_deref() {
                return Absence::Unconfirmed(format!("the second node could not be read ({e}), so it does not confirm that the recorded instance is gone"));
            }
            if file.public.params.profile.requires_second_node() && !noid.single_node_ok {
                return Absence::Unconfirmed("this profile asks for a second node and none was given (--single-node-ok was not passed), so nothing confirms that the recorded instance is gone".to_string());
            }
            Absence::Absent
        }
    }
}

fn alice_recovery_check(file: &SwapFile, phase: &Phase, noid: &NoidObservation, now: u64) -> RecoveryCheck {
    let Phase::Alice(p) = phase else { return RecoveryCheck::No };
    // CHAOS S1: only BEFORE a reveal. After one (or where one may have been sent) Bob can have claimed the recorded instance, no marker proves he
    // did not (a one-block reorg at D can still include his claim), and a lookalike must not stand in for it: never adopted.
    if !matches!(p, AlicePhase::FundingFinal { .. } | AlicePhase::LockSeen { .. } | AlicePhase::LockFinal { .. }) || alice_reveal_may_be_out(file, p) {
        return RecoveryCheck::No;
    }
    let Some(recorded) = p.instance() else { return RecoveryCheck::No };
    if !params::alice_refund_ready(noid.tip, file.public.params.deadline_height) || noid.find_instance(recorded).is_some() || instance_marked_gone_before_d(file) {
        return RecoveryCheck::No;
    }
    // M1 (a): the operator recorded a close before D (the claim branch, which pays Bob): the recorded instance went to Bob.
    if last_history(file, "noid_closed_before_deadline").is_some() {
        return RecoveryCheck::No;
    }
    let all = noid.all_instances();
    let mut fitting: Vec<NoidInstanceStatus> = all.iter().filter(|v| instance_fits(file, v)).cloned().collect();
    fitting.sort_by_key(|v| (v.instance.creation_id, v.instance.slot_index));
    let Some(adopted) = fitting.first().cloned() else { return RecoveryCheck::No };
    match recorded_instance_absence(file, recorded, noid, now) {
        Absence::Absent => {}
        Absence::Listed => return RecoveryCheck::No,
        Absence::Unconfirmed(why) => return RecoveryCheck::Blocked(why),
    }
    let others = all.into_iter().filter(|o| o.instance.slot_index != adopted.instance.slot_index || o.instance.creation_id != adopted.instance.creation_id).collect();
    RecoveryCheck::Yes(RecoveryAdoption { recorded: recorded.clone(), adopted, others })
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
            // CHAOS M1 (c), S1: after a reveal the file cannot tell whether Bob claimed the recorded instance, whatever markers it holds.
            notes.push("whether Bob claimed the recorded instance before D is not known to this file; the instance at the root can be recovered with the wallet".to_string());
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
        "REVIEW-2 F9: the secret is public but Bob never claimed the NOID; D {} is reached and the instance is still at the contract; refund_noid is due",
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

/// G9: the largest `T_reveal` the engine itself would put on a lock of Bob's at this Parano1d tip and Ethereum time (`Gates::t_max_eth`, the
/// bound `choose_t_reveal` applies, with Bob's own clock rule: the earlier of ours and the chain's). `None`: no `T_reveal` is safe at this
/// height, or the Ethereum clock is unknown.
fn late_lock_bound(file: &SwapFile, noid: &NoidObservation, eth: &EthObservation, now: u64) -> Option<u64> {
    if eth.latest_timestamp == 0 {
        return None;
    }
    let t_now = now.min(eth.latest_timestamp.max(1));
    file.public.params.profile.gates().t_max_eth(file.public.params.deadline_height, noid.tip, t_now).ok()
}

/// G9: the start of the history entry that records, at adoption, that a lock of Bob's own sender which the file did not send had a `T_reveal`
/// above the engine's bound: `late_lock:<lock id, 64 hex>:<T_reveal>:<bound, or none>`. A log-only entry (no phase change); the note is built
/// from it on every later tick, so it does not depend on a bound that has moved since.
const LATE_LOCK_MARKER: &str = "late_lock:";

/// G9: at adoption (a lock-less phase, in practice `funding_final`, to `locked`; `lock_submitted` is the file's own send): was `lock` (it already passed [`lock_matches`]: Bob's sender, the agreed terms) sent by this
/// file? The lock the file sent is the one [`expected_lock_id`] names (the pending `lock_eth` record or intent, or a cancelled intent's
/// `T_reveal`); any other lock of Bob's sender was made by hand. A foreign lock with a `T_reveal` above the engine's bound (no bound at all
/// counts as above it, which includes an unknown Ethereum clock: the marker then carries the bound `none`) lets Alice reveal so late that Bob
/// cannot get his NOID claim final before `D`. It is still adopted, exactly like any other (refusing it would leave Bob without a claim path);
/// the returned marker makes every tick say so. `None`: no marker needed (the file's own lock, or a lock within the bound).
fn late_lock_marker(file: &SwapFile, lock: &LockSummary, noid: &NoidObservation, eth: &EthObservation, now: u64) -> Option<String> {
    if matches!(&file.phase, Phase::Bob(BobPhase::LockSubmitted { .. })) || Some(lock.lock_id) == expected_lock_id(file) {
        return None;
    }
    let bound = late_lock_bound(file, noid, eth, now);
    if bound.is_some_and(|b| lock.t_reveal <= b) {
        return None;
    }
    let bound = bound.map_or_else(|| "none".to_string(), |b| b.to_string());
    Some(format!("{LATE_LOCK_MARKER}{}:{}:{bound}", hex::encode(lock.lock_id), lock.t_reveal))
}

/// G9: the ALARM note for a late lock, from its marker (see [`LATE_LOCK_MARKER`]). The same text on every tick while the lock is open.
fn late_lock_note(marker: &str, deadline: u64) -> Option<String> {
    let mut parts = marker.strip_prefix(LATE_LOCK_MARKER)?.split(':');
    let id: [u8; 32] = hex::decode(parts.next()?).ok()?.try_into().ok()?;
    let t_reveal: u64 = parts.next()?.parse().ok()?;
    let against = match parts.next()? {
        "none" => "has no safe bound at this height (the engine's own bound does not exist)".to_string(),
        b => {
            let bound: u64 = b.parse().ok()?;
            format!("is {} s beyond the engine's own bound {bound}", t_reveal.saturating_sub(bound))
        }
    };
    Some(format!(
        "ALARM: this lock's T_reveal {t_reveal} {against} (D {deadline}): if Alice reveals late, the NOID claim may not be final before D; claim the moment the secret is seen; do not make another lock (lock {})",
        short_id(&id)
    ))
}

/// G9: for Bob's file after this tick's events: the marker to log (a lock adopted THIS tick that is late) and the ALARM note (that marker, or
/// the one in the history for a lock adopted earlier), the note only while the lock is open (`locked`, `refund_submitted`). Nothing here changes
/// an event or an action.
fn bob_late_lock(file: &SwapFile, after: &BobPhase, events: &[Event], noid: &NoidObservation, eth: &EthObservation, now: u64) -> (Option<String>, Option<String>) {
    let fresh = events.iter().find_map(|e| match e {
        Event::EthLockSeen { lock } => late_lock_marker(file, lock, noid, eth, now),
        _ => None,
    });
    let open = matches!(after, BobPhase::Locked { .. } | BobPhase::RefundSubmitted { .. });
    let Some(lock) = after.lock().filter(|_| open) else { return (fresh, None) };
    let id = hex::encode(lock.lock_id);
    let marker = fresh.clone().or_else(|| {
        file.history
            .iter()
            .rev()
            .map(|h| h.event.as_str())
            .find(|e| e.strip_prefix(LATE_LOCK_MARKER).is_some_and(|rest| rest.starts_with(&id)))
            .map(str::to_string)
    });
    let note = marker.and_then(|m| late_lock_note(&m, file.public.params.deadline_height));
    (fresh, note)
}

/// G1: the start of the history entry that records, at adoption, that Alice first recorded Bob's lock at a Parano1d tip above Bob's last lock height:
/// `lock_seen_late:<lock id, 64 hex>:<tip>:<last lock height>`. Log only (no phase change, no decision reads it); the note is built from it on every
/// later tick while she holds the lock, because the tip moves on and a note computed from the current tip would say something else.
const LOCK_SEEN_LATE_MARKER: &str = "lock_seen_late:";

/// G1 (decided: a note only, never a refusal): the marker for the lock adopted in this tick's events, or `None`. The tip is the poll's, not the
/// lock's own block (the Ethereum lock carries no Parano1d height), and a read-only tick does not save the marker, so the recorded height can be
/// later than the first sight: the note says "first recorded". The limit is the height Bob's own tool gives up
/// at ([`params::Gates::bob_lock_by_min_window`]); between the nominal lock-by and that height Bob may still lock with a shorter window, and
/// nothing is said.
fn lock_seen_late_marker(file: &SwapFile, events: &[Event], tip: u64) -> Option<String> {
    let last = file.public.params.profile.gates().bob_lock_by_min_window(file.public.params.deadline_height);
    if tip <= last {
        return None;
    }
    events.iter().find_map(|e| match e {
        Event::EthLockSeen { lock } => Some(format!("{LOCK_SEEN_LATE_MARKER}{}:{tip}:{last}", hex::encode(lock.lock_id))),
        _ => None,
    })
}

/// G1: the note for a late-seen lock, from its marker. A statement of heights only: it says neither that Alice should reveal nor that she should not.
fn lock_seen_late_note(marker: &str, lock_by: u64) -> Option<String> {
    let mut parts = marker.strip_prefix(LOCK_SEEN_LATE_MARKER)?.split(':');
    let id: [u8; 32] = hex::decode(parts.next()?).ok()?.try_into().ok()?;
    let tip: u64 = parts.next()?.parse().ok()?;
    let last: u64 = parts.next()?.parse().ok()?;
    Some(format!(
        "Bob's lock {} was first recorded at Parano1d height {tip}, after Bob's last lock height {last} (nominal lock-by {lock_by}); it may have been mined in an earlier block than that poll",
        short_id(&id)
    ))
}

/// G1, Alice's file after this tick's events: the marker to log (a lock adopted THIS tick that was first recorded above Bob's last lock height) and
/// the note (that marker, or the one in the history for the lock she holds), the note only in `lock_seen`, `lock_final` and `reveal_submitted` (the library path moves there in the tick that sends the reveal). Nothing here changes an
/// event or an action.
fn alice_late_lock(file: &SwapFile, after: &AlicePhase, events: &[Event], noid: &NoidObservation) -> (Option<String>, Option<String>) {
    let fresh = lock_seen_late_marker(file, events, noid.tip);
    let Some(lock) = after.lock().filter(|_| matches!(after, AlicePhase::LockSeen { .. } | AlicePhase::LockFinal { .. } | AlicePhase::RevealSubmitted { .. })) else {
        return (fresh, None);
    };
    let id = hex::encode(lock.lock_id);
    let marker = fresh.clone().or_else(|| {
        file.history
            .iter()
            .rev()
            .map(|h| h.event.as_str())
            .find(|e| e.strip_prefix(LOCK_SEEN_LATE_MARKER).is_some_and(|rest| rest.starts_with(&id)))
            .map(str::to_string)
    });
    let note = marker.and_then(|m| lock_seen_late_note(&m, file.public.params.lock_by_height));
    (fresh, note)
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
                // Only when the claim is gone for good (the file goes back to `secret_seen`); a claim that is pending again needs no new send.
                if !still_pending {
                    notes.push(claim_removed_alert());
                }
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
    let mut candidates = preimage_candidates(eth, lock.lock_id);
    // CHAOS S2: a CLAIMED lock of Bob's other than the one in this file, on this swap's lock word, published the secret too. It gets the same
    // verification as every candidate below (it must open the lock word and match the NOID address) before anything is done with it.
    let other_claims = |e: &EthObservation| e.other_claims.iter().map(|c| c.preimage).collect::<Vec<_>>();
    let mut from_other: Vec<[u8; 32]> = other_claims(eth);
    if let Some(second) = eth.second.as_deref() {
        from_other.extend(other_claims(second));
    }
    for x in &from_other {
        if !candidates.contains(x) {
            candidates.push(*x);
        }
    }
    if candidates.is_empty() {
        return None;
    }
    let Ok(authority) = file.public.authority() else { return Some(None) };
    for x in &candidates {
        match check_preimage_for(file.public.params.eth.lock_kind, x, &file.public.hashlock, &authority, file.public.params.variant) {
            Ok(()) => {
                let on_primary = eth.pending_preimage.as_ref().is_some_and(|p| p.lock_id == lock.lock_id && p.preimage == *x)
                    || eth.overlong_claim.as_ref().is_some_and(|p| p.lock_id == lock.lock_id && p.preimage == *x)
                    || eth.reverted_claim.as_ref().is_some_and(|p| p.lock_id == lock.lock_id && p.preimage == *x)
                    || eth.claimed.as_ref().is_some_and(|c| c.lock_id == lock.lock_id && c.preimage == *x);
                if from_other.contains(x) && !on_primary {
                    notes.push(
                        "the secret was read from a CLAIMED lock of Bob's other than the one in this file (same lock word): it is checked against the hashlock and the NOID address"
                            .to_string(),
                    );
                } else if !on_primary {
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
        // CHAOS F-11: positive evidence that the close came at or after D (the recovery branch, which pays Alice): the instance was seen alive
        // when the claim branch had closed (the file's own poll), or the operator recorded a close at or after D with `tick --closed-by`. Then
        // Bob's NOID leg is over, whoever closed it; the abort is given once his ETH leg is settled (the caller).
        if params::alice_refund_ready(noid.tip, d) {
            // The reason names the evidence (CHAOS M3): the operator's recorded close, or the poll that listed the instance.
            let operator = file.history.iter().rev().find_map(|h| h.event.strip_prefix("noid_closed_after_deadline:"));
            if let Some(detail) = operator {
                let (txid, height) = detail.split_once(':').unwrap_or((detail, "?"));
                return Action::Abort {
                    reason: format!(
                        "claim branch closed: the operator recorded the close {txid} at height {height} (at or after D {d}, the recovery branch, which pays Alice), so Bob's NOID claim can no longer happen"
                    ),
                };
            }
            if last_history(file, "noid_instance_alive_at_d").is_some() {
                let tip = file.history.iter().rev().find_map(|h| h.event.strip_prefix(BOB_ALIVE_TIP)).unwrap_or("?");
                return Action::Abort {
                    reason: format!(
                        "claim branch closed: the instance was listed at tip {tip}, when the claim branch had closed (D {d}) and block D - 1 was final, and it is gone now (a recovery close, which pays Alice, took it), so Bob's NOID claim can no longer happen"
                    ),
                };
            }
        }
        // Closed by a transaction we did not track (a lost submission of
        // ours after a crash, or a third party paying Bob): a human must
        // check the receipts; re-proving would only burn time. Without evidence of WHEN it was closed the file does not guess who was paid:
        // a close before D paid Bob, one at or after D paid Alice; `tick --closed-by TXID` records either.
        return Action::Wait {
            reason: "the instance is gone but no tracked transaction closed it; verify the contract receipts manually (then `tick --closed-by TXID` records it: a close before D paid Bob, one at or after D paid Alice)".into(),
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
            notes.push(format!("claim at {h} is past the D-19 target; proving anyway"));
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

/// Bob's claim is pending and not mined while the claim branch runs out: say so on every tick, loudly (notes only; no action changes, and there is
/// nothing Bob could send instead, the mempool being first-seen). Past the `D - 19` target a claim mined now cannot be final before Alice's
/// refund opens at `D` (a reorg can still take it out, the T21 case); at or past `D` it can no longer be mined validly at all, and the node
/// evicts it. Before this, a stuck claim looked like any other pending one until the node dropped it.
fn claim_pending_deadline_notes(file: &SwapFile, noid: &NoidObservation, notes: &mut Vec<String>) {
    let d = file.public.params.deadline_height;
    let h = noid.next_call_height;
    match params::classify_claim_height(h, d) {
        ClaimHeight::OnTarget => {}
        ClaimHeight::LateButValid => notes.push(format!(
            "ALARM: the NOID claim is still pending (not seen mined) and the next call height {h} is past the D-{} target (D {d}): if it is mined now it is not final before Alice's refund opens at D, and a reorg can still take it out; nothing can be sent instead of it (first-seen mempool)",
            params::B_FINAL
        )),
        ClaimHeight::TooLate => notes.push(format!(
            "ALARM: the NOID claim is still pending but the claim branch is closed (next call height {h} >= D {d}): it can no longer be mined validly, Alice can refund, and the node evicts the pending claim"
        )),
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
    let recorded: Vec<u64> = file.cancelled_intents.iter().filter(|i| i.action == "lock_eth").filter_map(|i| i.params.get("t_reveal").and_then(Value::as_u64)).collect();
    // REVIEW-5 R5-6: a cancel from before cancelled intents were recorded sits in the history without an entry. If any cancel is unrecorded,
    // the lock id it froze is unknown, and a recorded later one (another `T_reveal`) must not stand for both: the file is `Unrecorded`.
    let cancels_in_history = file.history.iter().filter(|h| h.event == "intent_cancelled:lock_eth").count();
    if cancels_in_history > recorded.len() {
        return CancelledLock::Unrecorded;
    }
    match recorded.first().copied() {
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

/// CHAOS F-6: is the lock of a Bob file in `locked` gone for good?
enum LockGone {
    /// The lock can never be on the chain again: the abort reason (a statement of the facts).
    ForGood(String),
    /// It may still be (or come back): why the file keeps waiting.
    NotYet(String),
}

/// CHAOS F-6: Bob's file is in `locked` and the poll shows no such lock. `newLock` reverts once `block.timestamp >= T_reveal`, and Alice's `claim`
/// reverts too, so after `T_reveal` a lock that is not on the chain cannot come into it, whatever happens to the transaction that made it. The
/// rule is therefore time-bound, not poll-bound: the lock is gone for good only when, on EVERY node asked, the contract shows no such lock, the
/// head is fresh and past `T_reveal` by the profile's Ethereum finality time (a reorg of the blocks around `T_reveal` is then impossible). (The
/// block number the lock was recorded at says nothing here: after a reorg the new chain's finalized number passes it while the lock's block is
/// in the abandoned fork.) Before that the file keeps its phase: it still watches for Alice's secret, and a lock that comes back is seen as before.
fn bob_lock_gone_for_good(file: &SwapFile, lock: &LockSummary, eth: &EthObservation, now: u64) -> LockGone {
    let g = file.public.params.profile.gates();
    if let Some(alarm) = eth_lag_alarm(file, eth, now) {
        return LockGone::NotYet(format!("the Ethereum node lags, so its answer proves nothing: {alarm}"));
    }
    let mut nodes: Vec<(&str, &EthObservation)> = vec![("first", eth)];
    match eth.second.as_deref() {
        Some(second) => {
            if let Some(why) = second_stale("eth (second node)", second.observed_at, now) {
                return LockGone::NotYet(why);
            }
            nodes.push(("second", second));
        }
        None => {
            if let Some(e) = eth.second_error.as_deref() {
                return LockGone::NotYet(format!("the second Ethereum node could not be read ({e}): it must confirm that the lock is not there"));
            }
            if file.public.params.profile.requires_second_node() && !eth.single_node_ok {
                return LockGone::NotYet("a second Ethereum node is required to confirm that the lock is not there (pass --eth-rpc twice, or --single-node-ok to accept the risk)".to_string());
            }
        }
    }
    // CHAOS M4: a node on another chain, or with other code at the contract address, answers "no such lock" for the wrong reasons.
    let pinned = &file.public.params.eth;
    for (name, e) in &nodes {
        match e.chain_id {
            Some(id) if id == pinned.chain_id => {}
            Some(id) => return LockGone::NotYet(format!("the {name} Ethereum node is on chain {id}, the swap is on {}", pinned.chain_id)),
            None => return LockGone::NotYet(format!("the {name} Ethereum node's chain id is unknown")),
        }
        match (pinned.code_hash, e.contract_code_hash) {
            (Some(a), Some(b)) if a == b => {}
            (Some(_), Some(_)) => return LockGone::NotYet(format!("the {name} Ethereum node shows other code at the contract address than the pinned one")),
            (None, _) => return LockGone::NotYet("no HTLC code hash is pinned in the swap file".to_string()),
            (_, None) => return LockGone::NotYet(format!("the {name} Ethereum node's contract code hash is unknown")),
        }
    }
    if let Some((name, _)) = nodes.iter().find(|(_, e)| e.find_lock(&lock.lock_id).is_some()) {
        return LockGone::NotYet(format!("the {name} Ethereum node shows it"));
    }
    // CHAOS S2 (m7): "nothing of Bob's is locked and no secret can be published" needs more than this lock being absent: no OTHER lock of Bob's
    // sender to Alice's receiver on this swap's lock word may be open or claimed. The filter is the engine's own, not the watcher's.
    for (name, e) in &nodes {
        let others: Vec<EthLock> = e
            .all_locks()
            .into_iter()
            .filter(|l| l.lock_id != lock.lock_id && l.sender == pinned.bob_sender && l.receiver == pinned.alice_receiver && l.hashlock == file.public.hashlock)
            .collect();
        // A CLAIMED one means the secret is public. Where the observation carries its preimage Bob's file has already moved to `secret_seen`
        // (`bob_preimage_fact`); here it did not, so the file waits and says what it means.
        if let Some(c) = others.iter().find(|l| l.claimed) {
            return LockGone::NotYet(format!(
                "ALARM: another lock of Bob's on this lock word ({}) was CLAIMED (on the {name} Ethereum node), so the secret is public although this file has not read it: claim the NOID before D {} (read the preimage from that lock's Claimed event or getLock record)",
                short_id(&c.lock_id),
                file.public.params.deadline_height
            ));
        }
        // An OPEN one: ETH may still be locked there. Once its own T_reveal has passed it can be refunded by hand.
        if let Some(o) = others.iter().find(|l| !l.refunded) {
            if e.latest_timestamp >= o.timelock {
                return LockGone::NotYet(format!(
                    "ALARM: another lock of Bob's on this lock word ({}) is still open on the {name} Ethereum node and its T_reveal {} has passed: it can be refunded by hand with `live.js refund` (this tool offers no action for a lock that is not in this file)",
                    short_id(&o.lock_id),
                    o.timelock
                ));
            }
            return LockGone::NotYet(format!("the {name} Ethereum node lists another open lock of Bob's on this swap's lock word ({}), so ETH may still be locked", short_id(&o.lock_id)));
        }
    }
    let gate = lock.t_reveal.saturating_add(g.eth_finality_s);
    if let Some((name, e)) = nodes.iter().find(|(_, e)| e.latest_timestamp < gate) {
        return LockGone::NotYet(format!(
            "it could still land or come back until T_reveal {} plus the Ethereum finality time {} s (chain time on the {name} node {})",
            lock.t_reveal, g.eth_finality_s, e.latest_timestamp
        ));
    }
    // CHAOS m6: where the node reports the FINALIZED block's time, that time must have reached T_reveal too (the head time above is the floor); under
    // `production` it must be reported.
    if file.public.params.profile == params::ProfileName::Production {
        if let Some((name, _)) = nodes.iter().find(|(_, e)| e.finalized_timestamp.is_none()) {
            return LockGone::NotYet(format!("the {name} Ethereum node does not report the finalized block's time, which the production profile requires before it says that the lock is gone"));
        }
    }
    if let Some((name, t)) = nodes.iter().find_map(|(n, e)| e.finalized_timestamp.filter(|t| *t < lock.t_reveal).map(|t| (*n, t))) {
        return LockGone::NotYet(format!("the finalized block's time on the {name} Ethereum node ({t}) has not reached T_reveal {} yet", lock.t_reveal));
    }
    LockGone::ForGood(format!(
        "the ETH lock {} (recorded in block {}) is not on the chain on any node asked, and chain time is past T_reveal {} by the finality time {} s: a lock can no longer be created or claimed, so nothing of Bob's is locked and no secret can be published against it",
        short_id(&lock.lock_id),
        lock.block_number,
        lock.t_reveal,
        g.eth_finality_s
    ))
}

/// REVIEW-4 R4-6: why Bob's Ethereum leg is not settled for good yet, or `None` when the lock is closed in a final block (a refund of his, or
/// Alice's claim).
fn eth_leg_not_settled(file: &SwapFile, lock: &LockSummary, eth: &EthObservation) -> Option<String> {
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
        .map(|r| (r.block_number, r.tx_hash == [0u8; 32]))
        .or_else(|| eth.claimed.as_ref().filter(|c| c.lock_id == lock.lock_id).map(|c| (c.block_number, c.tx_hash == [0u8; 32])));
    // REVIEW-5 R5-3: a close read only from the `getLock` record carries the poll's head as an upper bound of its block, which moves up with
    // every poll and so never reaches the finalized block. Count from the head the FIRST such poll saw (`eth_close_record_seen:N`, written by
    // [`note_record_only_close`]); the close is in a block at or below it.
    let closed_at = closed_at.map(|(b, from_record)| match (from_record && eth.claim_state_from_record, first_record_close_block(file)) {
        (true, Some(first)) => first.min(b),
        _ => b,
    });
    match (closed_at, eth.finalized_block) {
        (Some(b), Some(f)) if f >= b => None,
        (Some(b), f) => Some(format!("the ETH lock was closed at block {b}, which is not final yet (finalized block {})", f.map_or_else(|| "unknown".to_string(), |f| f.to_string()))),
        (None, _) => Some("the block that closed the ETH lock is unknown".to_string()),
    }
}

const CLOSE_RECORD_SEEN: &str = "eth_close_record_seen:";

/// The head block of the first poll that showed Bob's lock closed by the `getLock` record alone (no log), from the history.
fn first_record_close_block(file: &SwapFile) -> Option<u64> {
    file.history.iter().find_map(|h| h.event.strip_prefix(CLOSE_RECORD_SEEN).and_then(|n| n.parse::<u64>().ok()))
}

/// REVIEW-5 R5-3: Bob's file remembers, once, the head block at which his lock was first seen closed by the `getLock` record only (the log
/// index lagged or the range missed the log). [`eth_leg_not_settled`] counts the finality of that close from there. Log-only.
fn note_record_only_close(file: &mut SwapFile, eth: &EthObservation, now: u64) {
    let Phase::Bob(p) = &file.phase else { return };
    let Some(lock) = p.lock() else { return };
    if !eth.claim_state_from_record || first_record_close_block(file).is_some() {
        return;
    }
    let record_only = eth.refunded.as_ref().filter(|r| r.lock_id == lock.lock_id && r.tx_hash == [0u8; 32]).map(|r| r.block_number).or_else(|| {
        eth.claimed.as_ref().filter(|c| c.lock_id == lock.lock_id && c.tx_hash == [0u8; 32]).map(|c| c.block_number)
    });
    if let Some(block) = record_only {
        file.log(format!("{CLOSE_RECORD_SEEN}{block}"), now);
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

/// `poseidon` kind, Bob, before a lock transaction goes out (`None` for the `sha256` kind and when everything holds):
/// - (only `first`, i.e. the first lock, not a re-send) his client R passed its self-test on this machine for the owner-authorization
///   version of the next block (review V2-10: with a lock on `Addr(s)` the stock wallet import cannot claim, only client R can);
/// - a second Ethereum node that is configured answered (REVIEW-7 R7-4: its failed poll is a wait, not a scan on one node);
/// - the query for `Locked` logs of Bob's own sender (indexed topic; REVIEW-7 R7-1) ran and is complete on every node asked (review V2-8,
///   REVIEW-6 R6-1: the check is a state of the observation, and a failed or absent one holds the lock back; it never fails a poll). A check
///   that cannot be trusted is "wait", not "go";
/// - no `Locked` log with this lock word exists that BOB'S OWN SENDER made, other than his own lock (T9, REVIEW-6 R6-2). A lock by anyone
///   else on the same word does not block: Bob's lock pays only the fixed receiver, and only for an `x` with `Addr(x) = A`, so a stranger's
///   earlier lock costs Bob nothing it could not cost him anyway, and blocking would hand every observer of `A` a 1-wei veto. Such locks are
///   reported in the notes.
fn poseidon_prelock_blocker(file: &SwapFile, noid: &NoidObservation, eth: &EthObservation, first: bool, now: u64, notes: &mut Vec<String>) -> Option<String> {
    if file.public.params.eth.lock_kind != LockKind::Poseidon {
        return None;
    }
    if first {
        if let Some(why) = selftest_blocker(file, noid, now) {
            return Some(why);
        }
    }
    // REVIEW-7 R7-4: a second Ethereum node that was configured but could not be read is not dropped silently: the scan below would then rest
    // on one node, which can hide an earlier lock of Bob's own sender. Without a second node configured (`--single-node-ok`) nothing changes.
    if let Some(e) = eth.second_error.as_deref() {
        return Some(format!("the second Ethereum node could not be read ({e}): it must agree before this step (F5)"));
    }
    let nodes: Vec<(&str, &EthObservation)> = std::iter::once(("first", eth)).chain(eth.second.as_deref().map(|s| ("second", s))).collect();
    for (name, e) in &nodes {
        match &e.word_scan {
            WordScan::Complete => {}
            WordScan::NotRun => {
                return Some(format!(
                    "the query for Bob's own earlier locks on this word did not run in this poll on the {name} node (it runs only while Bob has not locked yet): no earlier lock on this word is known, so Bob does not lock on a guess; poll again"
                ))
            }
            WordScan::Failed(why) => {
                return Some(format!(
                    "the query for Bob's own earlier locks on the {name} node could not be completed, so an earlier lock on this word A could be hidden and Bob does not lock: {why}"
                ))
            }
        }
    }
    let own = expected_lock_id(file);
    let bob = file.public.params.eth.bob_sender;
    let mut by_bob: Vec<[u8; 32]> = Vec::new();
    let mut by_others: Vec<[u8; 32]> = Vec::new();
    for (_, e) in &nodes {
        for w in e.word_locks.iter().filter(|w| Some(w.lock_id) != own) {
            let list = if w.sender == bob { &mut by_bob } else { &mut by_others };
            if !list.contains(&w.lock_id) {
                list.push(w.lock_id);
            }
        }
    }
    if !by_others.is_empty() {
        notes.push(format!(
            "{} Locked log(s) of other senders already carry this lock word A (not blocking: Bob's lock pays only the fixed receiver for an x with Addr(x) = A, and the NOID lock pays only Bob; REVIEW-6 R6-2)",
            by_others.len()
        ));
    }
    if !by_bob.is_empty() {
        return Some(format!(
            "{} Locked log(s) of the pinned contract made by Bob's own sender already carry this lock word A and are not the lock this file expects: the word has been locked before from Bob's address (T9), so Bob does not lock on it again",
            by_bob.len()
        ));
    }
    None
}

/// T21: should this poll also read the recent block headers (who produced them)? Only for Bob, and only while he can still decide to lock
/// (`received`, `funded`, `funding_final`). A dropped lock's re-send is not gated, so `lock_submitted` and later phases read nothing; Alice never does.
pub fn producer_scan_wanted(file: &SwapFile) -> bool {
    file.role == Role::Bob && matches!(&file.phase, Phase::Bob(BobPhase::Received | BobPhase::Funded { .. } | BobPhase::FundingFinal { .. }))
}

/// REVIEW-6 R6-1: should this poll also run the all-`Locked`-logs scan? Only for Bob in a `poseidon` swap and only while he can still decide to
/// lock: before his lock is seen (`received`, `funded`, `funding_final`) and while a lock he sent may need a re-send (`lock_submitted`). From
/// `locked` on, and for Alice, nothing depends on the scan, so it is not asked and cannot cost the poll.
pub fn word_scan_wanted(file: &SwapFile) -> bool {
    file.role == Role::Bob
        && file.public.params.eth.lock_kind == LockKind::Poseidon
        && matches!(&file.phase, Phase::Bob(BobPhase::Received | BobPhase::Funded { .. } | BobPhase::FundingFinal { .. } | BobPhase::LockSubmitted { .. }))
}

/// How old a client R self-test record may be when Bob decides to lock (REVIEW-6 R6-4).
pub const SELFTEST_MAX_AGE_S: u64 = 86_400;

/// REVIEW-6 R6-4: the client R self-test record must be a record of THIS swap's check on THIS build: the file's lock word, the contract version
/// of this swap, the running binary's version string, the owner-authorization version of the next block, and younger than a day. Anything
/// else is "run `swap-cli self-test FILE` again" (the engine cannot prove, it can only refuse to go on a stale or foreign record).
fn selftest_blocker(file: &SwapFile, noid: &NoidObservation, now: u64) -> Option<String> {
    let again = "run `swap-cli self-test FILE` again";
    let Some(t) = &file.client_r_selftest else {
        return Some(
            "the client R self-test has not passed on this machine: run `swap-cli self-test FILE` (it proves and verifies an authorization for a throwaway instance); with a lock on A = Addr(s) only client R can claim the NOID, so Bob must have seen it work before he locks ETH (review V2-10)"
                .to_string(),
        );
    };
    let want = format!("{:?}", params::auth_version_at(noid.tip.saturating_add(1)));
    if t.auth_version != want {
        return Some(format!(
            "the client R self-test passed for owner-authorization version {} but the next block uses {want}: {again} (review V2-10)",
            t.auth_version
        ));
    }
    if t.lock_word != hex::encode(file.public.hashlock) {
        return Some(format!("the client R self-test record is not for this swap (its lock word differs from the file's): {again} (REVIEW-6 R6-4)"));
    }
    let version = file.public.params.contract_version.number();
    if t.contract_version != version {
        return Some(format!("the client R self-test ran for contract v{} but this swap uses v{version}: {again} (REVIEW-6 R6-4)", t.contract_version));
    }
    let build = crate::build_id();
    if t.build_id != build {
        return Some(format!("the client R self-test was made by another build ({:?}, this one is {build:?}): {again} (REVIEW-6 R6-4)", t.build_id));
    }
    if t.passed_at > now.saturating_add(300) {
        return Some(format!("the client R self-test record is dated in the future (passed_at {} > now {now}): {again} (REVIEW-6 R6-4)", t.passed_at));
    }
    let age = now.saturating_sub(t.passed_at);
    if age > SELFTEST_MAX_AGE_S {
        return Some(format!("the client R self-test is {age} s old (limit {SELFTEST_MAX_AGE_S} s): {again} (REVIEW-6 R6-4)"));
    }
    None
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
            // T21: said while Bob waits, when a summary was read (nothing is decided here; the screen bites at `funding_final`).
            notes.extend(producer_gate::waiting_notes(g, noid, now));
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
        B::Funded { .. } => {
            notes.extend(producer_gate::waiting_notes(g, noid, now));
            Action::Wait { reason: "waiting for funding finality".into() }
        }
        B::FundingFinal { instance, final_at_tip } => {
            // Step 7: the instance is ours, final, unspent, and we are in time.
            match instance_ok(file, noid) {
                Ok(()) => {}
                // REVIEW-2 F10: several instances fit; the tool does not lock on a guess. Not an abort: it may clear up.
                Err(InstanceProblem::Ambiguous(why)) => {
                    // CHAOS F-10: the give-up heights come before the wait. A lock that can no longer be made is not waited for for ever
                    // because the root lists a lookalike: past Bob's last lock height, or past `B_bob` blocks after funding finality (that one only
                    // while no lock_eth intent was cancelled, as in `bob_last_lock_height`), Bob gives up at the same heights as with one instance.
                    // Before those heights the wait stands, and no lock goes out on a guess. Three small differences from the one-instance path,
                    // all on the safe side: (1) that path first waits on pending calls at the instance, (2) and on an unknown Ethereum timestamp
                    // (this one aborts on the heights alone, which need neither); (3) with a cancelled lock intent (Known or Unrecorded) that path
                    // judges the send by `lock_reuse_safe` and can abort earlier than the heights used here.
                    let last = g.bob_lock_by_min_window(d);
                    let past = if noid.tip > last {
                        Some(params::GateError::PastLockBy { h_now: noid.tip, lock_by: last })
                    } else if matches!(cancelled_lock(file), CancelledLock::None) && noid.tip > final_at_tip.saturating_add(g.b_bob) {
                        Some(params::GateError::PastBobWindow { h_now: noid.tip, h_final: *final_at_tip, b_bob: g.b_bob })
                    } else {
                        None
                    };
                    if let Some(e) = past {
                        return Action::Abort { reason: format!("not locking: {e}") };
                    }
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
                            "not locking: the lock of the cancelled lock_eth intent (T_reveal {t0}) is no longer safe to send, and a fresh T_reveal would be a second lock id while the cancelled send may still land; Bob walks away (REVIEW-4 R4-2). If that lock does land: look at the contract before T_reveal; if a secret was published, claim the NOID before D; refund the ETH at T_reveal only if the lock is still unclaimed"
                        ))
                    }
                }
                CancelledLock::Unrecorded => Err(
                    "not locking: a lock_eth intent was cancelled before this file recorded cancelled intents, so its T_reveal is unknown and a new lock could get a second lock id while the cancelled send may still land; Bob walks away (REVIEW-4 R4-2). If a lock of his lands: look at the contract before T_reveal; if a secret was published, claim the NOID before D; refund the ETH at T_reveal only if the lock is still unclaimed"
                        .to_string(),
                ),
            };
            match chosen {
                Ok(t_reveal) => {
                    if noid.instance.as_ref().map(|i| i.creation_id) != Some(instance.creation_id) {
                        return Action::Abort { reason: "instance incarnation changed".into() };
                    }
                    // `poseidon` kind (docs/poseidon-leg.md 6 and review V2-8, V2-10): no earlier lock on this A, and Bob's own client R has
                    // been seen to authorize on his machine. Nothing is locked on a guess. Checked here, after the timing gates, so that a
                    // Bob who is held back still aborts once the last lock height has passed instead of waiting for ever.
                    if let Some(why) = poseidon_prelock_blocker(file, noid, eth, true, now, notes) {
                        notes.push(format!("not lock_eth: {why}"));
                        return Action::Wait { reason: why };
                    }
                    // T21 (docs/bob-concentration-gate.md): the producer screen. Since 0.2.0 the share (high or unknown) only warns and never holds the lock back;
                    // under `production` a failing second-node cross-check or a remembered disagreement still does (unless the operator accepted it).
                    // It reads the observation and changes no state; every other decision is untouched.
                    if let Some(why) = producer_gate::lock_gate(g, noid, now, notes).wait {
                        return Action::Wait { reason: why };
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
        B::LockSubmitted { instance, t_reveal, .. } => {
            // Review H2: a dropped lock is re-sent with the SAME terms (same `T_reveal`, same lock id, so a duplicate that lands
            // anyway reverts) and only while (I1) and `M_A` still hold; never as a fresh lock under a new id.
            if last_history(file, "eth_lock_dropped") > last_history(file, "lock_submitted") {
                if eth.latest_timestamp == 0 {
                    return Action::Wait { reason: "Ethereum latest timestamp unknown: waiting before deciding whether to re-send the dropped lock".into() };
                }
                let t_now = now.min(eth.latest_timestamp);
                // (I1), and a reveal window that stays >= W_A_min measured to the block the re-sent lock is likely mined in (CHAOS F-8's rule,
                // applied here): Alice's (I3) check measures from that block, so a lock that would come up short is not worth sending.
                let ok = g.check_i1_eth(d, noid.tip, *t_reveal, t_now).is_ok()
                    && t_reveal.saturating_sub(eth_now(eth, now)) >= g.m_a_s
                    && t_reveal.saturating_sub(eth_now(eth, now).saturating_add(g.de_s)) >= g.w_a_min_s;
                // The lock was dropped and its terms are no longer safe: once chain time has reached its `T_reveal` even a late landing
                // would be refundable at once and no longer a swap, so Bob stops (`aborted`) instead of waiting for ever.
                if !ok && eth_now(eth, now) >= *t_reveal {
                    return Action::Abort {
                        reason: format!("the lock with T_reveal {t_reveal} was dropped, is not safe to re-send and its T_reveal has passed; if it still lands, look at the contract: claim the NOID before D if a secret was published, refund the ETH only if the lock is unclaimed"),
                    };
                }
                // CHAOS (seed 0x5eed0001, scenario 145): the lock was chosen on ONE instance. A re-send must still see that exact valid
                // instance with no pending close and no ambiguity before re-sending.
                if ok {
                    // `poseidon` kind: a lock of someone else on this A that appeared meanwhile (it is not the one we are re-sending).
                    if let Some(why) = poseidon_prelock_blocker(file, noid, eth, false, now, notes) {
                        notes.push(format!("not re-sending the lock: {why}"));
                        return Action::Wait { reason: format!("the lock was dropped, but {why}") };
                    }
                    match instance_ok(file, noid) {
                        Ok(()) => {}
                        Err(InstanceProblem::Ambiguous(why)) => {
                            notes.push(format!("not re-sending the lock: {why}"));
                            return Action::Wait {
                                reason: format!("the lock was dropped, but more than one instance at the contract root fits the agreement: {why}"),
                            };
                        }
                        Err(InstanceProblem::Rejected(why)) => {
                            notes.push(format!("not re-sending the lock: {why}"));
                            return Action::Wait {
                                reason: format!("the lock was dropped, but the NOID instance no longer fits the agreement: {why}"),
                            };
                        }
                    }
                    if noid.instance.as_ref() != Some(instance) {
                        return Action::Wait {
                            reason: "the lock was dropped, but the recorded NOID instance is missing or changed".into(),
                        };
                    }
                    if noid.active_authority.as_deref() != Some(file.public.claim_authority.as_str()) {
                        return Action::Wait {
                            reason: "the lock was dropped, but the NOID instance's active authority is not the claim authority".into(),
                        };
                    }
                    if !noid.pending_calls.is_empty() {
                        return Action::Wait {
                            reason: "the lock was dropped, but a call on the NOID instance is already pending in the mempool".into(),
                        };
                    }
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
            // CHAOS F-6: the file holds a lock that this poll does not show. The watcher asks the contract itself (`getLock`, which reverts
            // `LockNotFound` for an unknown id) whenever the logs show nothing, so "not visible" is the contract's own answer, and a lock that
            // exists but is missing from the logs fails the poll instead. A lock missing from one poll is NOT gone (a reorg can put it back, a node can
            // lag): the file ends only when it can no longer land, and says why it keeps waiting until then.
            if eth.find_lock(&lock.lock_id).is_none() {
                match bob_lock_gone_for_good(file, lock, eth, now) {
                    LockGone::ForGood(reason) => return Action::Abort { reason },
                    LockGone::NotYet(why) if why.starts_with("ALARM") => notes.push(why),
                    LockGone::NotYet(why) => notes.push(format!("the ETH lock is not visible in this poll (the contract shows no such lock): {why}")),
                }
            }
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
                if let Some(why) = eth_leg_not_settled(file, lock, eth) {
                    notes.push(format!("not aborting yet: {why}"));
                    return Action::Wait { reason: format!("{reason}; not aborting yet: {why}") };
                }
            }
            action
        }
        B::ClaimSubmitted { lock, .. } => {
            claim_pending_deadline_notes(file, noid, notes);
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
            // CHAOS X1: a recovery close for another incarnation names it: seen when that one is gone.
            if let Some(r) = intent.params.get("recovery_instance") {
                let (slot, creation) = (r.get("slot_index").and_then(Value::as_u64), r.get("creation_id").and_then(Value::as_u64));
                let still_there = noid.all_instances().iter().any(|v| Some(u64::from(v.instance.slot_index)) == slot && Some(v.instance.creation_id) == creation);
                return !still_there || matches!(&file.phase, Phase::Alice(A::RefundSubmitted { .. } | A::RefundIncluded { .. } | A::Refunded { .. }));
            }
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
        // REVIEW-5 R5-7: the reveal is judged by its own lock as well. Once the lock it names is refunded (Bob's refund won the race and the
        // reveal reverts) or claimed, nothing of it is left to wait for: it must not hold `refund_noid` at D until a cancel that a stuck
        // claim in the mempool keeps refusing. The phase may stay `lock_final` for ever when Bob never claimed.
        "reveal_eth" => {
            let closed = intent
                .params
                .get("lock_id")
                .and_then(Value::as_str)
                .and_then(|h| hex::decode(h.trim_start_matches("0x")).ok())
                .and_then(|b| <[u8; 32]>::try_from(b).ok())
                .and_then(|id| eth.find_lock(&id))
                .is_some_and(|l| l.refunded || l.claimed);
            if closed || file.phase.name() != intent.phase_at_decision {
                return true;
            }
            return false;
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

/// The wait reason of a held `reveal_eth` intent whose reveal cutoff has passed: the printed parameters are no longer to be used.
fn reveal_cutoff_wait_reason(intent: &PendingIntent) -> String {
    format!(
        "intent {} pending since {} (unix): the chain does not show it yet and its reveal cutoff has passed, so the printed parameters are not to be used; if nothing was sent, cancel it with `swap-cli intent FILE --cancel` (with the same chain flags as tick); if a reveal may have been sent, look at the contract",
        intent.action, intent.decided_at
    )
}

/// Audit F-03: the wait reason of a funding that is not to be made because the secret is already public on Ethereum or the swap is past its funding: a claim
/// of this swap's lock or of another lock of its lock word (a claim carries the secret, so nobody can make one without it), or (with a per-swap Ethereum key) a
/// send of that key on either node, mined or waiting. A lock or a refund alone does not count: anyone can make a lock with the public lock word, and a stranger's
/// lock must not keep Alice from her first funding (scenario f10). `None` when nothing of the kind is seen.
fn eth_shows_swap_used_text(file: &SwapFile, eth: &EthObservation) -> Option<String> {
    let seen = |o: &EthObservation| {
        o.claimed.is_some()
            || !o.other_claims.is_empty()
            || (file.eth_key.is_some() && (o.signer_nonce_latest.is_some_and(|n| n > 0) || o.signer_nonce_pending.is_some_and(|n| n > 0)))
    };
    if seen(eth) || eth.second.as_deref().is_some_and(seen) {
        Some("this swap already has an Ethereum claim or a send from its swap key: a funding now could be closed to Bob with the public secret; not funding".to_string())
    } else {
        None
    }
}

/// `fund_noid` is never offered while an instance already sits at our root and was not accepted (a second funding would make a second
/// instance: live run 9). One function for the CLI path ([`tick_apply`]) and the library path ([`Runner::tick`]); `decide` itself
/// still returns the `FundNoid` that its phase leads to.
fn guard_fund_noid(file: &SwapFile, noid: &NoidObservation, eth: &EthObservation, decision: &mut Decision) {
    if !matches!(decision.action, Action::FundNoid { .. }) {
        return;
    }
    // Audit F-03: a swap whose secret already shows on Ethereum (a claim) or whose fresh swap key already sent something is
    // past its funding. A funding now could land beside a secret that is public, and anyone could close it to Bob.
    if let Some(why) = eth_shows_swap_used_text(file, eth) {
        decision.notes.push(format!("not fund_noid: {why}"));
        decision.action = Action::Wait { reason: why };
        return;
    }
    if noid.instance.is_none() {
        return;
    }
    let why = alice_instance_problem_text(file, noid)
        .unwrap_or_else(|| "an instance already exists at our contract root but was not accepted; not funding again (check its amount and the contract state)".to_string());
    decision.notes.push(format!("not fund_noid: {why}"));
    decision.action = Action::Wait { reason: why };
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
    tick_core(file, noid, eth, now, if record { TickMode::Record } else { TickMode::ReadOnly })
}

/// How far one tick may change the in-memory file; the caller decides whether to save it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum TickMode {
    /// A read-only `tick`: the same changes are made in memory (events, history entries) and the caller does not save; no intent, no recorded abort.
    ReadOnly,
    /// `tick --apply --observe-only`: the facts the observation shows are applied and the caller saves them, but nothing that a decision of the engine
    /// would record: no intent, no recorded `abort`, no entry that goes with an offered action (see [`tick_observe`]).
    Observe,
    /// `tick --apply`.
    Record,
}

/// Why `tick --apply --observe-only` must not run on this file: an intent is held, a pending action is recorded, or the history holds an
/// `intent_decided:` entry (then the caller must run a full `--apply`). Observe-only is for the time before the role has acted. `None`: the file may be observed.
pub fn observe_only_refusal(file: &SwapFile) -> Option<String> {
    if let Some(i) = &file.pending_intent {
        return Some(format!(
            "observe-only is refused: the file holds an intent ({} since {} unix); run a full `tick --apply`, which holds it or resolves it",
            i.action, i.decided_at
        ));
    }
    if let Some(a) = file.pending_action.as_ref() {
        return Some(format!("observe-only is refused: the file records a pending action ({}); run a full `tick --apply`, which holds it or resolves it", a.kind));
    }
    // An intent was decided once (resolved or cancelled since): the role has acted, and from then on the full tick is the only writer, so that the
    // entries and rules that follow a decision (the cancel hold, an abort kept back, the recovery label) are never skipped by a watch.
    file.history.iter().rev().find_map(|h| h.event.strip_prefix("intent_decided:")).map(|kind| {
        format!("observe-only is refused: the file's history holds a decided intent ({kind}); once an intent has been decided only a full `tick --apply` writes the file")
    })
}

/// The observe-only path of `tick --apply --observe-only`: what [`tick_apply`] does with `record == true`, except everything that a DECISION of the
/// engine records. The caller saves the file.
///
/// Applied, like `--apply`: the events the observation derives (phase moves such as Bob's `received` to `funded` to `funding_final`, an instance
/// that is gone, a lock seen, a reorg), the log-only facts of the decision (alive at `D`, late lock, a reverted reveal, a close known from the
/// record alone). Not written: an intent (the printed action is the one a read-only tick prints, its spend parameters withheld), an `abort`, the
/// history entries that go with an offered action (the producer-concentration override entry, the label of an
/// adopted recovery instance), the resolution of an intent. A file that holds an intent or a pending action, or whose history shows one was ever
/// decided, is refused ([`observe_only_refusal`]), so nothing of the ledger is touched.
pub fn tick_observe(file: &mut SwapFile, noid: &NoidObservation, eth: &EthObservation, now: u64) -> Result<TickOutcome, String> {
    if let Some(why) = observe_only_refusal(file) {
        return Err(why);
    }
    tick_core(file, noid, eth, now, TickMode::Observe).map_err(|e| e.to_string())
}

fn tick_core(file: &mut SwapFile, noid: &NoidObservation, eth: &EthObservation, now: u64, mode: TickMode) -> Result<TickOutcome, InvalidTransition> {
    let record = mode == TickMode::Record;
    // Record reverted or pending reveal evidence first, so this very decision already judges a re-send by the late cutoff.
    note_reverted_reveal(file, eth, now);
    note_reveal_pending(file, eth, now);
    let mut decision = decide(file, noid, eth, now);
    for e in &decision.events {
        file.apply(e, now)?;
    }
    for entry in &decision.log {
        // Observe-only: an entry that records that an action was OFFERED (a lock past the concentration screen by the operator's flag, a recovery
        // close for another instance) is written by the full `--apply` tick that offers it, not by one that only watches.
        if mode == TickMode::Observe && (entry.starts_with(producer_gate::OVERRIDE_HISTORY) || entry.starts_with(producer_gate::ACK_HISTORY) || entry.starts_with(RECOVERY_ADOPTED)) {
            continue;
        }
        file.log(entry.clone(), now);
    }
    let mut status = IntentStatus::None;
    note_reveal_pending(file, eth, now);
    note_record_only_close(file, eth, now);
    if let Some(intent) = file.pending_intent.clone() {
        if intent_effect_seen(file, &intent, noid, eth) {
            file.log(format!("intent_resolved:{}", intent.action), now);
            file.pending_intent = None;
            status = IntentStatus::Resolved(intent);
        }
    }
    // Guards that only make sense against the ledger's own kinds.
    let kind = decision.action.kind();
    if kind == "fund_noid" {
        guard_fund_noid(file, noid, eth, &mut decision);
    } else if kind == "refund_noid" && our_instance_gone(file, noid) && alice_recovery_adoption(file, &file.phase, noid, now).is_none() {
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
            if let Some((kind, cancelled_at)) = spend_may_be_in_flight(file, now) {
                decision.notes.push(match cancelled_at {
                    None => format!(
                        "abort not recorded: a {kind} was decided for this swap and never cancelled, so it may have been sent (a funding or a lock that the chain does not show yet, or that a reorg took back). Look at the wallet / the contract; `swap-cli intent FILE --cancel` records that it was not sent"
                    ),
                    Some(at) => {
                        let hold = file.public.params.profile.gates().abort_after_cancel_s;
                        let left = hold.saturating_sub(now.saturating_sub(at));
                        format!(
                            "abort not recorded yet: a {kind} was decided for this swap and cancelled at {at} (unix), {hold} s are kept back after a cancel ({left} s left) because a cancel rests on one node's view of the mempool, so the send may still land (a funding or a lock that the chain does not show yet, or that a reorg took back). Look at the wallet / the contract; the abort is recorded then, if it still stands"
                        )
                    }
                });
            } else if let Some(why) = abort_eth_blocker(file, eth, now) {
                decision.notes.push(format!("abort not recorded: {why}"));
                decision.action = Action::Wait { reason: format!("{reason}; abort not recorded yet: {why}") };
            } else {
                let reason = if matches!(&file.phase, Phase::Bob(p) if p.lock().is_none())
                    && last_history(file, "intent_decided:lock_eth").is_some()
                    && !reason.contains("claim the NOID before D")
                {
                    format!("{reason}{ABORT_LOCK_MAY_LAND}")
                } else {
                    reason.clone()
                };
                let event = Event::Abort { reason };
                if file.apply(&event, now).is_ok() {
                    decision.events.push(event);
                    file.pending_action = None;
                    // A funding that was decided and then cancelled is taken as not sent, which is the operator's word; if it was sent and then
                    // closed (by Alice's own recovery) the tool had no way to see it. Said as a fact, beside the recorded abort.
                    // CHAOS m11: Bob's `locked` ended because the lock can never exist: a pending `refund_eth` intent can never take effect, so the
                    // ledger resolves it here (as it resolves any intent whose effect is seen or superseded) instead of holding it for ever.
                    if matches!(&file.phase, Phase::Bob(BobPhase::Aborted { .. })) {
                        if let Some(i) = file.pending_intent.clone().filter(|i| i.action == "refund_eth") {
                            file.log("intent_resolved:refund_eth", now);
                            file.pending_intent = None;
                            decision.notes.push("the pending refund_eth intent is resolved: the lock is not on the chain and cannot be created or claimed any more, so there is nothing to refund".to_string());
                            status = IntentStatus::Resolved(i);
                        }
                    }
                    // (Only for the window abort, with nothing visible at the root: the other cases have their own notes, and the text says both.)
                    let window_abort = matches!(&decision.events.last(), Some(Event::Abort { reason }) if reason.starts_with("too late to fund"));
                    if matches!(file.phase, Phase::Alice(_))
                        && window_abort
                        && noid.all_instances().is_empty()
                        && last_history(file, "intent_cancelled:fund_noid") > last_history(file, "intent_decided:fund_noid")
                    {
                        decision.notes.push(ABORT_AFTER_CANCELLED_FUNDING_NOTE.to_string());
                    }
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
                // A held reveal whose cutoff has passed: its printed parameters are not to be used, so the cancel is the step that lets the refund out.
                let held = if intent.action == "reveal_eth" && decision.reveal_cutoff_passed { reveal_cutoff_wait_reason(&intent) } else { intent_wait_reason(&intent) };
                decision.action = Action::Wait { reason: format!("{due} is due but {held}") };
            } else {
                if decision.action.has_side_effect() || matches!(decision.action, Action::Wait { .. }) {
                    decision.notes.push(format!("held: fresh decision was {}", decision.action.kind()));
                }
                // T21: a `lock_eth` intent that an earlier tick recorded while the producer screen passed is still pending (Bob's file, the lock
                // not seen yet), and the screen refuses now (or, under a profile that only warns, holds a remembered detection). The operator's
                // lock helper sends the frozen parameters, so say plainly that this lock must not be sent. The fresh decision already pushed
                // its own ALARM note (when `bob_action` reached the screen); the finding is asked again here only to know whether to alert, and
                // adds no second copy of those notes. The `ALERT:` line is printed on the first tick that sees the refusal only (the alert hook of
                // `scripts/live` sends one message per line and expects one tick per alert); the latch is a log-only history entry, written
                // by `tick --apply`, per intent. Later ticks keep the changed `wait` reason and the ALARM note.
                let mut screen_refuses: Option<producer_gate::PendingLockFinding> = None;
                if intent.action == "lock_eth" && producer_scan_wanted(file) {
                    if let Some(f) = producer_gate::pending_lock_finding(file.public.params.profile.gates(), noid, now) {
                        if f.hard {
                            let latch = producer_gate::pending_lock_latch(intent.decided_at, f.kind);
                            // Written again when an override entry came after the last latch of this kind (the operator passed the flag once, then
                            // dropped it): `live.js lock` waives a latch that an override follows, so the refusal that is true now needs its own
                            // newer entry (review, 2026-11-10).
                            let last_same = file.history.iter().rposition(|h| h.event == latch);
                            let last_override = file.history.iter().rposition(|h| h.event.starts_with(producer_gate::OVERRIDE_HISTORY));
                            if last_same.is_none_or(|l| last_override.is_some_and(|o| o > l)) {
                                decision.notes.push(producer_gate::pending_lock_note(&f, intent.decided_at));
                                if record {
                                    file.log(latch, now);
                                }
                            }
                            screen_refuses = Some(f);
                        } else {
                            decision.notes.push(producer_gate::pending_lock_note(&f, intent.decided_at));
                        }
                    }
                }
                decision.notes.push(format!("frozen parameters of the pending {}: {}", intent.action, intent.params));
                decision.action = Action::Wait {
                    reason: match &screen_refuses {
                        Some(f) => producer_gate::pending_lock_wait_reason(f, intent.decided_at),
                        // A held `reveal_eth` whose fresh decision is the failed reveal cutoff (the structured hint, not the reason text).
                        None if intent.action == "reveal_eth" && decision.reveal_cutoff_passed && matches!(decision.action, Action::Wait { .. }) => {
                            reveal_cutoff_wait_reason(&intent)
                        }
                        None => intent_wait_reason(&intent),
                    },
                };
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
                // REVIEW-5 R5-1: and the cutoff for a RE-send of this very claim once it is out (`T_reveal - DE`): `live.js claim --replace`
                // uses it when it finds the pending claim, because a first reveal's intent froze the earlier `M_A` cutoff.
                params["late_cutoff"] = serde_json::json!(l.timelock.saturating_sub(file.public.params.profile.gates().de_s));
            }
        }
        // CHAOS X1: a recovery close that is for an instance other than the recorded one names it, so that the intent resolves when THAT instance is
        // gone (the recorded one is gone already) and so that a second round for another instance is a new intent.
        if matches!(decision.action, Action::RefundNoid { .. }) {
            if let Some(a) = alice_recovery_adoption(file, &file.phase, noid, now).filter(|_| instance_gone_in(&file.phase, noid)) {
                params["recovery_instance"] = serde_json::json!({ "slot_index": a.adopted.instance.slot_index, "creation_id": a.adopted.instance.creation_id });
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
fn spend_may_be_in_flight(file: &SwapFile, now: u64) -> Option<(&'static str, Option<u64>)> {
    // REVIEW-4 R4-6: the hold applies only while the spend may still be on its way. A `lock_eth` the file has already SEEN on chain (the
    // phase holds the lock: Bob is past `funding_final` / `lock_submitted`, e.g. in `secret_seen`) is not in flight any more, so an abort
    // decided then (the claim branch closed on him) is recorded. A `fund_noid` stays held: the only phase an abort can end Alice's file
    // from is `created`, which means no funding of hers was accepted, and a visible instance that did not fit (a dust instance) is not
    // proof that hers has landed (a funding that a reorg took back lands again).
    let lock_seen = match &file.phase {
        Phase::Bob(p) => p.lock().is_some(),
        Phase::Alice(_) => false,
    };
    // `None`: nothing in flight. `Some((kind, None))`: decided and never cancelled. `Some((kind, Some(at)))`: decided, cancelled at `at`, and
    // the hold after a cancel has not run out.
    ["fund_noid", "lock_eth"].into_iter().find_map(|kind| {
        if kind == "lock_eth" && lock_seen {
            return None;
        }
        let decided = last_history(file, &format!("intent_decided:{kind}"));
        let cancelled = last_history(file, &format!("intent_cancelled:{kind}"));
        decided?;
        if decided > cancelled {
            return Some((kind, None));
        }
        // Review M1: a cancel is only as good as the one node's view of the mempool behind it, so a cancelled send keeps the abort
        // back for an hour (the next ticks record it): a transaction still queued elsewhere has landed by then.
        let at = file.history[cancelled?].at;
        (now.saturating_sub(at) < file.public.params.profile.gates().abort_after_cancel_s).then_some((kind, Some(at)))
    })
}

/// REVIEW-5 R5-4: may Bob's file say `aborted` over a lock that has not been seen? A file that decided `lock_eth` (the CLI path) and holds no lock
/// yet ends the watch loop with the abort, so it must know that no lock of his is on its way up the chain:
/// - the Ethereum head time must be fresh on every node read (the `lock_eth` limit, not under `rehearsal`): a stalled node shows no lock because it
///   shows nothing;
/// - where the profile asks for a second node (and `--single-node-ok` was not given) it must be there, readable and fresh, and
///   - no node, the second one included, shows a lock under the id of any cancelled `lock_eth` intent.
/// Returns why the abort must wait, or `None`.
fn abort_eth_blocker(file: &SwapFile, eth: &EthObservation, now: u64) -> Option<String> {
    let Phase::Bob(p) = &file.phase else { return None };
    if p.lock().is_some() || last_history(file, "intent_decided:lock_eth").is_none() {
        return None;
    }
    if let Some(alarm) = eth_lag_alarm(file, eth, now) {
        return Some(format!("the Ethereum node lags, so its empty answer proves nothing about a lock of ours: {alarm}"));
    }
    let eth_params = &file.public.params.eth;
    let ids: Vec<[u8; 32]> = file
        .cancelled_intents
        .iter()
        .filter(|i| i.action == "lock_eth")
        .filter_map(|i| i.params.get("t_reveal").and_then(Value::as_u64))
        .map(|t| compute_lock_id(&eth_params.bob_sender, &eth_params.alice_receiver, eth_params.amount_wei, &file.public.hashlock, t))
        .collect();
    if let Some(id) = ids.iter().find(|id| eth.find_lock(id).is_some()) {
        return Some(format!("a lock {} of a cancelled lock_eth intent is on the chain", short_id(id)));
    }
    // A second node that was configured but could not be read blocks whatever --single-node-ok says (as for the other steps of F5).
    if let Some(e) = eth.second_error.as_deref() {
        return Some(format!("the second Ethereum node could not be read ({e}): it must confirm that no lock of ours exists (REVIEW-5 R5-4)"));
    }
    match eth.second.as_deref() {
        None if file.public.params.profile.requires_second_node() && !eth.single_node_ok => Some(
            "a second Ethereum node is required to confirm that no lock of ours exists before the file says aborted (REVIEW-5 R5-4); pass --eth-rpc twice, or --single-node-ok to accept the risk"
                .to_string(),
        ),
        None => None,
        Some(second) => {
            if let Some(why) = second_stale("eth (second node)", second.observed_at, now) {
                return Some(why);
            }
            ids.iter().find(|id| second.find_lock(id).is_some()).map(|id| format!("the second Ethereum node shows the lock {} of a cancelled lock_eth intent", short_id(id)))
        }
    }
}

/// X2: the note beside a recorded Alice `aborted` whose history shows a `fund_noid` that was decided and then cancelled.
const ABORT_AFTER_CANCELLED_FUNDING_NOTE: &str = "a fund_noid was decided and later cancelled (taken as not sent); no instance of this contract is visible and the funding window is closed; if a funding was sent, it is no longer at the contract: check the wallet's history";

/// What the recorded reason of an abort over a lock that never showed says to do if one lands after all (REVIEW-5 R5-4).
const ABORT_LOCK_MAY_LAND: &str =
    "; if a lock of Bob's lands later, check it before T_reveal: if a secret was published claim the NOID before D, and refund the ETH at T_reveal only when the lock is still unclaimed";

/// Review M1: how long after `intent --cancel` of a funding or a lock an `abort` is still not recorded.
/// The production value; the profile's own is `Gates::abort_after_cancel_s` (REVIEW-5 R5-5).
pub const ABORT_AFTER_CANCEL_S: u64 = params::PRODUCTION.abort_after_cancel_s;

/// REVIEW-3 F3: the youngest an intent may be for `intent --cancel` to drop it. A send the operator made a moment ago can
/// be in a node's mempool where this tool's reads do not see it yet; ten minutes is more than a mempool takes to show it
/// and far less than any window of the protocol.
/// The production value; the profile's own is `Gates::min_cancel_age_s` (REVIEW-5 R5-5).
pub const MIN_CANCEL_AGE_S: u64 = params::PRODUCTION.min_cancel_age_s;

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
    let min_age = file.public.params.profile.gates().min_cancel_age_s;
    if age < min_age {
        return Err(format!(
            "not cancelling: the {} intent is {age} s old, younger than {min_age} s (REVIEW-3 F3: a send made just now may not show in a mempool yet); look at the chain, wait, and try again",
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
        "lock_eth" | "refund_eth" | "reveal_eth" => {
            if eth.chain_id != Some(file.public.params.eth.chain_id) {
                return Err(format!(
                    "not cancelling: Ethereum chain id mismatch (observed {:?}, expected {})",
                    eth.chain_id, file.public.params.eth.chain_id
                ));
            }
            if let (Some(pinned), Some(seen)) = (file.public.params.eth.code_hash, eth.contract_code_hash) {
                if pinned != seen {
                    return Err("not cancelling: Ethereum contract code hash does not match the pinned contract".into());
                }
            }
            if let Some(err) = &eth.second_error {
                return Err(format!("not cancelling: the second Ethereum node could not be read ({err})"));
            }
            if let Some(second) = eth.second.as_deref() {
                // Both nodes were read in the same poll: a second reading that is missing its time, or is far from the first one's, proves nothing.
                match (eth.observed_at, second.observed_at) {
                    (_, None) => return Err("not cancelling: the second Ethereum node's observation has no time".into()),
                    (Some(a), Some(b)) if a.abs_diff(b) > MAX_OBSERVATION_AGE_S => {
                        return Err(format!("not cancelling: the two Ethereum nodes were read {} s apart (limit {MAX_OBSERVATION_AGE_S} s)", a.abs_diff(b)))
                    }
                    _ => {}
                }
                if second.chain_id != Some(file.public.params.eth.chain_id) {
                    return Err(format!(
                        "not cancelling: second Ethereum node chain id mismatch or unknown (observed {:?}, expected {})",
                        second.chain_id, file.public.params.eth.chain_id
                    ));
                }
                if let (Some(pinned), Some(seen)) = (file.public.params.eth.code_hash, second.contract_code_hash) {
                    if pinned != seen {
                        return Err("not cancelling: second Ethereum node contract code hash does not match the pinned contract".into());
                    }
                }
                if intent.action == "lock_eth" {
                    if let Some(id) = expected_lock_id(file) {
                        if second.find_lock(&id).is_some() {
                            return Err(format!("not cancelling: the second Ethereum node shows lock {} on chain", short_id(&id)));
                        }
                    }
                }
                match (second.signer_nonce_latest, second.signer_nonce_pending) {
                    (Some(latest), Some(pending)) if pending > latest => {
                        return Err(format!(
                            "not cancelling: the second Ethereum node shows a pending transaction for the {} signer (pending nonce {pending} > latest nonce {latest})",
                            intent.action
                        ));
                    }
                    (Some(_), Some(_)) => {}
                    (latest, pending) => {
                        return Err(format!(
                            "not cancelling: the second Ethereum node's signer nonces are unknown (latest {latest:?}, pending {pending:?}), so a pending send cannot be ruled out"
                        ))
                    }
                }
            }
            match (eth.signer_nonce_latest, eth.signer_nonce_pending) {
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
            }
        }
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
        let mut decision = decide(&self.file, noid, eth, now);
        // The same guard as the CLI path: no second funding beside an instance that was not accepted.
        guard_fund_noid(&self.file, noid, eth, &mut decision);
        let mut notes = decision.notes;
        let mut names = Vec::new();
        let phase_before = self.file.phase.clone();
        for e in &decision.events {
            self.file.apply(e, now)?;
            names.push(e.name());
        }
        for entry in &decision.log {
            self.file.log(entry.clone(), now);
        }
        // A log-only event (Alice's `eth_refund_mined`) leaves the phase alone and so
        // must not resolve a pending action the way a phase move does.
        let moved = self.file.phase != phase_before;
        note_record_only_close(&mut self.file, eth, now);
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
        if let Err(e) = self.file.save(&self.path) {
            // Nothing was handed to the executor, so the record must not say "outcome unknown" (it would relax the reveal cutoff, see
            // `reveal_pending_unknown`): mark it not sent, try once more to say so on disk, and report the failure.
            if let Some(p) = self.file.pending_action.as_mut() {
                p.maybe_sent = false;
            }
            let _ = self.file.save(&self.path);
            return Err(e.into());
        }
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
                // REVIEW-5 R5-1: a reveal whose outcome is unknown may be in the mempool: the secret may be public.
                if e.maybe_sent && matches!(action, Action::RevealEth { .. }) && last_history(&self.file, REVEAL_MAYBE_SENT).is_none() {
                    self.file.log(REVEAL_MAYBE_SENT, now);
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
    use crate::watch::producers::ProducerSummary;
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
        // T21: a healthy, cross-checked producer summary (largest 30 %, two largest 45 %; production needs the second node's check, which these
        // tests are not about); the producer-gate tests build their own.
        let g = file.public.params.profile.gates();
        n.producers.get_or_insert_with(|| {
            let mut p = ProducerSummary::synthetic(n.tip, g.producer_window_long, g.producer_window_short, now, 300, 450);
            p.second = crate::watch::producers::SecondCheck::Agrees { height: n.tip.saturating_sub(3), sampled: 64 };
            p
        });
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
        // Too late: Bob could not lock before his lock-by height (300,107).
        let d = decide(&file, &noid_at(300_080), &eth_at(1, 1_000), 1_000);
        assert!(matches!(d.action, Action::Abort { .. }));
    }

    const FUND: Action = Action::FundNoid { amount_micronoid: 10_000_000 };

    fn too_early(d: &Decision) -> bool {
        matches!(&d.action, Action::Wait { reason } if reason.starts_with("too early to fund"))
    }

    #[test]
    fn alice_funding_opens_d_offset_blocks_before_h_create() {
        let s = Secret::generate().unwrap();
        let file = alice_file(&s);
        let (h_create, off) = (file.public.params.h_create, file.public.params.profile.gates().d_offset);
        assert_eq!((h_create, off), (300_000, 738));
        let opens = h_create - off;
        // Inside the window, before H_create: the funding is offered (tip = H_create - 50, and the first tip whose next height is the opening).
        for tip in [h_create - 50, opens - 1] {
            let d = decide(&file, &noid_at(tip), &eth_at(1, 1_000), 1_000);
            assert_eq!(d.action, FUND, "tip {tip}");
            assert!(d.events.is_empty());
            assert!(d.notes.iter().any(|n| n == &format!("funding is open from height {opens} (tip {tip})")), "{:?}", d.notes);
        }
        // One block earlier: a wait that names the height, no event, no other note of an opening.
        let tip = opens - 2;
        let d = decide(&file, &noid_at(tip), &eth_at(1, 1_000), 1_000);
        assert!(too_early(&d), "{:?}", d.action);
        let Action::Wait { reason } = &d.action else { unreachable!() };
        assert!(reason.contains(&format!("opens at height {opens} (tip {tip})")) && reason.contains("more than twice the swap's planned length"), "{reason}");
        assert!(reason.contains(&format!("D {} is {off} blocks after H_create {h_create}", file.public.params.deadline_height)), "{reason}");
        assert!(d.events.is_empty());
        assert!(d.notes.iter().any(|n| n == &format!("funding opens at height {opens} (tip {tip})")), "{:?}", d.notes);
        // The lock-by note keeps its wording beside it.
        let lock_by = file.public.params.lock_by_height;
        assert!(d.notes.iter().any(|n| n.starts_with("funding window")), "{:?} (lock-by {lock_by})", d.notes);
        // After H_create, as before.
        assert_eq!(decide(&file, &noid_at(h_create), &eth_at(1, 1_000), 1_000).action, FUND);
        assert_eq!(decide(&file, &noid_at(300_001), &eth_at(1, 1_000), 1_000).action, FUND);
    }

    #[test]
    fn alice_too_late_to_fund_is_unchanged_at_its_boundary() {
        let s = Secret::generate().unwrap();
        let file = alice_file(&s);
        let g = file.public.params.profile.gates();
        let lock_by = file.public.params.lock_by_height;
        let last = lock_by - g.b_fund - g.b_final;
        assert_eq!(decide(&file, &noid_at(last), &eth_at(1, 1_000), 1_000).action, FUND);
        let d = decide(&file, &noid_at(last + 1), &eth_at(1, 1_000), 1_000);
        assert!(matches!(&d.action, Action::Abort { reason } if reason.starts_with("too late to fund")), "{:?}", d.action);
        // No "opens" note beside an abort.
        assert!(d.notes.iter().all(|n| !n.starts_with("funding is open") && !n.starts_with("funding opens")), "{:?}", d.notes);
    }

    #[test]
    fn alice_funding_rule_has_no_overflow_and_a_sensible_answer_at_the_extremes() {
        let s = Secret::generate().unwrap();
        let mut file = alice_file(&s);
        // tip 0: the funding is far from open.
        let d = decide(&file, &noid_at(0), &eth_at(1, 1_000), 1_000);
        assert!(too_early(&d), "{:?}", d.action);
        // A tip a node should never report: a wait, not a panic and not a funding.
        for tip in [u64::MAX - 1, u64::MAX] {
            let n = NoidObservation { next_call_height: tip.saturating_add(1), ..noid_at(0) };
            let d = decide(&file, &NoidObservation { tip, ..n }, &eth_at(1, 1_000), 1_000);
            assert!(matches!(&d.action, Action::Wait { reason } if reason.contains("implausibly large")), "{:?}", d.action);
        }
        // H_create below D_offset (not a loadable file; the arithmetic must still hold): the opening is the trial start.
        file.public.params.h_create = 100;
        let d = decide(&file, &noid_at(0), &eth_at(1, 1_000), 1_000);
        assert!(too_early(&d), "{:?}", d.action);
        let Action::Wait { reason } = &d.action else { unreachable!() };
        assert!(reason.contains(&format!("opens at height {}", params::TRIAL_START_HEIGHT)) && reason.contains("trial start"), "{reason}");
        file.public.params.h_create = 0;
        assert!(too_early(&decide(&file, &noid_at(1), &eth_at(1, 1_000), 1_000)));
        assert_eq!(decide(&file, &noid_at(params::TRIAL_START_HEIGHT - 1), &eth_at(1, 1_000), 1_000).action, FUND);
        // An H_create near the top of u64 (the file would not load; the opening arithmetic must not wrap).
        file.public.params.h_create = u64::MAX;
        let d = decide(&file, &noid_at(300_001), &eth_at(1, 1_000), 1_000);
        assert!(too_early(&d), "{:?}", d.action);
    }

    #[test]
    fn alice_funding_waits_for_the_trial_start_when_the_window_alone_would_open_it_earlier() {
        let s = Secret::generate().unwrap();
        let mut file = alice_file(&s);
        // H_create - D_offset = 278,662 is below the trial start 279,388.
        file.public.params.h_create = params::TRIAL_START_HEIGHT + 12;
        let start = params::TRIAL_START_HEIGHT;
        let d = decide(&file, &noid_at(start - 2), &eth_at(1, 1_000), 1_000);
        assert!(too_early(&d), "{:?}", d.action);
        assert!(d.notes.iter().any(|n| n == &format!("funding opens at height {start} (tip {})", start - 2)), "{:?}", d.notes);
        assert_eq!(decide(&file, &noid_at(start - 1), &eth_at(1, 1_000), 1_000).action, FUND);
    }

    #[test]
    fn an_instance_at_the_root_gives_the_same_wait_before_the_funding_opens_and_inside_its_window() {
        let s = Secret::generate().unwrap();
        let file = alice_file(&s);
        let opens = file.public.params.h_create - file.public.params.profile.gates().d_offset;
        let foreign = |tip: u64| NoidObservation {
            instance: Some(NoidInstance { slot_index: 3, creation_id: 5, amount_micronoid: 1_000 }),
            instance_matches_opening: Some(true),
            ..noid_at(tip)
        };
        let mut reasons = Vec::new();
        for tip in [opens - 50, opens - 2, opens - 1, file.public.params.h_create - 50, file.public.params.h_create + 1] {
            let n = foreign(tip);
            let mut d = decide(&file, &n, &eth_at(1, 1_000), 1_000);
            // From the opening on `decide` still returns the funding; the one guard of both paths turns it into the wait.
            guard_fund_noid(&file, &n, &eth_at(1, 1_000), &mut d);
            let Action::Wait { reason } = &d.action else { panic!("tip {tip}: {:?}", d.action) };
            reasons.push(reason.clone());
        }
        assert!(reasons.iter().all(|r| r.contains("is not counted as a funding") && !r.contains("too early")), "{reasons:?}");
        assert!(reasons.windows(2).all(|w| w[0] == w[1]), "{reasons:?}");
    }

    #[test]
    fn created_with_eth_lock_or_used_swap_key_does_not_fund() {
        let s = Secret::generate().unwrap();
        let file = alice_file(&s);
        let tip = file.public.params.h_create;
        let n = noid_at(tip);
        let guarded = |file: &SwapFile, eth: &EthObservation| {
            // `decide` gives the funding its phase leads to; the guard is what reads the Ethereum observation.
            let mut d = decide(file, &n, &eth_at(1, 1_000), 1_000);
            assert_eq!(d.action, FUND);
            guard_fund_noid(file, &n, eth, &mut d);
            d.action
        };
        // a clean observation still funds
        assert_eq!(guarded(&file, &eth_at(1, 1_000)), FUND);
        let is_wait = |a: &Action| matches!(a, Action::Wait { reason } if reason.contains("already has an Ethereum claim or a send from its swap key"));
        // a lock alone (anyone can make one with the public lock word) still funds
        let mut eth = eth_at(1, 1_000);
        eth.lock = Some(lock_for(&file, 1_000_000, 1));
        assert_eq!(guarded(&file, &eth), FUND, "a lock alone");
        // a claim was seen
        let mut eth = eth_at(1, 1_000);
        eth.claimed = Some(EthClaimed { lock_id: [3; 32], preimage: [2; 32], block_number: 1, tx_hash: [1; 32] });
        assert!(is_wait(&guarded(&file, &eth)), "claimed");
        // a nonce above 0 of the swap key, latest or pending, on the first node or the second one, counts only for a file with a swap key
        let mut with_key = alice_file(&s);
        with_key.eth_key = Some(crate::swapfile::EthKeyRecord { address: String::new(), secret: with_key.secret.clone().unwrap(), payout: String::new() });
        let mut eth = eth_at(1, 1_000);
        eth.signer_nonce_latest = Some(1);
        assert!(is_wait(&guarded(&with_key, &eth)), "latest nonce 1");
        assert_eq!(guarded(&file, &eth), FUND, "no swap key in the file: the nonce is not read");
        let mut eth = eth_at(1, 1_000);
        eth.signer_nonce_latest = Some(0);
        eth.signer_nonce_pending = Some(1);
        assert!(is_wait(&guarded(&with_key, &eth)), "pending nonce 1");
        let mut eth = eth_at(1, 1_000);
        let mut second = eth_at(1, 1_000);
        second.signer_nonce_latest = Some(1);
        eth.second = Some(Box::new(second));
        assert!(is_wait(&guarded(&with_key, &eth)), "second node nonce 1");
        // nonce 0 everywhere: still funds
        let mut eth = eth_at(1, 1_000);
        eth.signer_nonce_latest = Some(0);
        eth.signer_nonce_pending = Some(0);
        assert_eq!(guarded(&with_key, &eth), FUND);
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
        let d = decide(&file, &funded(300_023, 10_000_000), &eth_at(1, t_b), t_b);
        assert_eq!(d.events, vec![Event::NoidFundingFinal { tip: 300_023 }]);
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
        let d = decide(&file, &funded(300_737, 10_000_000), &eth_at(50, late), late);
        assert_eq!(d.action, Action::RefundNoid { call_height: 300_738, fee_micronoid: 6_000 });
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
        // Late but valid: prove anyway (D = 300,738; the target is D - 19 = 300,719; next call 300,730).
        let d = decide(&file, &funded(300_729, 10_000_000), &eth, 1);
        assert!(matches!(d.action, Action::ClaimNoid { call_height: 300_730, .. }));
        // Too late: the branch flipped; Bob lost. (The ETH lock must be closed in a final block, or the abort waits: REVIEW-4 R4-6.)
        let d = decide(&file, &funded(300_737, 10_000_000), &eth, 1);
        assert!(matches!(&d.action, Action::Wait { reason } if reason.contains("not aborting yet")), "{:?}", d.action);
        let mut closed = eth.clone();
        let mut l = lock.clone();
        l.claimed = true;
        closed.lock = Some(l);
        closed.claimed = Some(EthClaimed { lock_id: lock.lock_id, preimage: *s.bytes(), block_number: 5, tx_hash: [3; 32] });
        let d = decide(&file, &funded(300_737, 10_000_000), &closed, 1);
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
        wrong_chain.chain_id = Some(11_155_111);
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
        // T21: a healthy, cross-checked producer summary (largest 30 %, two largest 45 %).
        let g = file.public.params.profile.gates();
        n.producers.get_or_insert_with(|| {
            let mut p = ProducerSummary::synthetic(n.tip, g.producer_window_long, g.producer_window_short, now, 300, 450);
            p.second = crate::watch::producers::SecondCheck::Agrees { height: n.tip.saturating_sub(3), sampled: 64 };
            p
        });
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
        wrong_chain.chain_id = Some(11_155_111);
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
        // A second node that agrees: no single-node note, and the flag is irrelevant. (T21: the producer cross-check ran against it and agreed.)
        n.single_node_ok = false;
        n.second = Some(Box::new(NoidObservation { observed_at: Some(t), second: None, producers: None, ..n.clone() }));
        let tip = n.tip;
        n.producers.as_mut().unwrap().second = crate::watch::producers::SecondCheck::Agrees { height: tip - 3, sampled: 64 };
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
