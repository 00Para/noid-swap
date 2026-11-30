//! Funding, recovery and sweep: every NOID step of the swap wallet, one function each, with every refusal, and the engine executors.
//!
//! The rule that runs through all three: **when the design is silent, send less.** A step that is not clearly allowed is refused; a step whose
//! outcome is unknown is never repeated as a NEW transaction, only as the same recorded bytes (see [`super::persist`]); a dry run builds, proves and
//! verifies the transaction and prints it, and writes and sends nothing.
//!
//! Nothing in here decides WHEN a step happens: the engine's decisions (the gates, the heights, the timeouts) are untouched. The executors only
//! perform the actions the engine already offers (`fund_noid`, `refund_noid`), and add refusals of their own.

use std::path::Path;

use htlc_harness as h;
use noid_poseidon2b::primitives::Address;
use noid_tx::experimental_object::ObjectOpening;

use super::chain::{NodeReads, SlotView, WalletSlot};
use super::contract::{build_recovery, RecoveryInputs};
use super::key::WalletKey;
use super::persist::{
    all_unspent, instance_unspent, next_step, record_path, submit_bytes, Next, SendKind, SendRecord, SubmitReport, SubmitVerdict,
};
use super::send::{build_send, check_sweep_fee, select_for_payment, select_for_sweep, shape_for_inputs, SendInputs, SendPlan};
use super::WalletError;
use crate::client::IntentSubmitter;
use crate::engine::{close_fee_for, Action, ExecError, Executor};
use crate::params::{self, RotationGuard};
use crate::state::{AlicePhase, Event, Phase, Role};
use crate::swapfile::{atomic_write, detect_contract_version, Passphrase, SwapFile};
use crate::watch::{JsonRpc, NoidInstance, NoidObservation};

/// Blocks a deposit must have been seen before it is spent (a reorg of the deposit then only makes the funding fail; nothing is lost).
pub const DEPOSIT_CONFIRMATIONS: u64 = 2;

/// Everything a step needs.
pub struct FlowEnv<'a> {
    /// The swap file's path (the records sit beside it).
    pub swap_path: &'a Path,
    pub file: &'a SwapFile,
    pub key: &'a WalletKey,
    pub rpc: &'a dyn JsonRpc,
    /// Where a transaction goes when `submit` is on; may be empty for a dry run.
    pub nodes: &'a [(&'a str, &'a dyn IntentSubmitter)],
    /// False = dry run: build, prove, verify, print; write nothing, send nothing.
    pub submit: bool,
    pub now: u64,
}

/// What a step did.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Outcome {
    /// Built and verified, not submitted, nothing written (a dry run).
    DryRun,
    /// At least one node holds the transaction.
    Sent,
    /// The transaction MAY HAVE BEEN SENT: treat it as sent.
    MaybeSent,
    /// Nothing was sent.
    NotSent,
    /// Nothing to send now: waiting (the text says for what).
    Hold,
    /// The step's purpose is already served on chain; nothing to send.
    Done,
}

/// The report of one step, printable as JSON.
#[derive(Clone, Debug)]
pub struct StepReport {
    pub kind: SendKind,
    pub outcome: Outcome,
    pub summary: String,
    pub txid: Option<String>,
    /// A new transaction was built by this call (not a resend of the recorded bytes).
    pub built_now: bool,
    pub amount: Option<u64>,
    pub fee: Option<u64>,
    pub change: Option<u64>,
    pub target: Option<String>,
    pub inputs: Option<usize>,
    pub child_height: Option<u64>,
    pub submit: Option<SubmitReport>,
    pub notes: Vec<String>,
}

impl StepReport {
    fn new(kind: SendKind, outcome: Outcome, summary: impl Into<String>) -> Self {
        Self {
            kind,
            outcome,
            summary: summary.into(),
            txid: None,
            built_now: false,
            amount: None,
            fee: None,
            change: None,
            target: None,
            inputs: None,
            child_height: None,
            submit: None,
            notes: Vec::new(),
        }
    }

    pub fn to_json(&self) -> serde_json::Value {
        let outcome = match self.outcome {
            Outcome::DryRun => "dry_run",
            Outcome::Sent => "sent",
            Outcome::MaybeSent => "maybe_sent",
            Outcome::NotSent => "not_sent",
            Outcome::Hold => "hold",
            Outcome::Done => "done",
        };
        serde_json::json!({
            "step": self.kind.name(),
            "outcome": outcome,
            "summary": self.summary,
            "txid": self.txid,
            "built_now": self.built_now,
            "amount_micronoid": self.amount,
            "fee_micronoid": self.fee,
            "change_micronoid": self.change,
            "target": self.target,
            "inputs": self.inputs,
            "child_height": self.child_height,
            "submit": self.submit.as_ref().map(|s| serde_json::json!({
                "accepted": s.accepted, "already_pending": s.already_pending, "rejected": s.rejected, "unknown": s.unknown,
            })),
            "notes": self.notes,
        })
    }
}

/// A transaction built and ready to be recorded: the record (not yet written), and what to print.
struct Built {
    record: SendRecord,
    amount: u64,
    fee: u64,
    change: u64,
    target: String,
    inputs: usize,
    child_height: u64,
}

fn refuse<T>(m: impl Into<String>) -> Result<T, WalletError> {
    Err(WalletError::Refused(m.into()))
}

// ---------------------------------------------------------------- shared checks

/// The wallet must be this swap's: Alice's file, a wallet record, and the key must derive its address, which is the swap's recovery address.
fn check_wallet(env: &FlowEnv<'_>) -> Result<(), WalletError> {
    let file = env.file;
    if file.role != Role::Alice {
        return refuse("the NOID swap wallet belongs to Alice's file");
    }
    let Some(w) = &file.wallet else {
        return refuse("this swap file has no NOID swap wallet");
    };
    let own = env.key.address().to_bech32();
    if w.address != own || file.public.params.alice_noid != own {
        return refuse("the wallet key is not the swap wallet of this file (its address is not the swap's recovery address)");
    }
    Ok(())
}

/// The file's opening, checked three ways: the guard, the contract version the file says, and the root the file says.
fn checked_opening(file: &SwapFile) -> Result<ObjectOpening, WalletError> {
    let opening = file.public.opening().map_err(|e| WalletError::Refused(e.to_string()))?;
    h::check_opening(&opening).map_err(|e| WalletError::Refused(format!("tool guard: {e}")))?;
    if detect_contract_version(&opening) != Some(file.public.params.contract_version) {
        return refuse("the swap file says one contract version but its opening is not that contract");
    }
    if opening.root().to_bech32() != file.public.contract_root {
        return refuse("the swap file's contract root is not the root of its opening");
    }
    Ok(opening)
}

/// `tip + 1` and the epoch anchor that goes with it. The anchor is read between two reads of the tip, and the two must be in the same epoch, so
/// that the anchor is the one of the child block we build for.
fn height_and_anchor(reads: &NodeReads<'_>) -> Result<(u64, [u8; 32]), WalletError> {
    for _ in 0..3 {
        let before = reads.tip()?;
        let anchor = reads.epoch_anchor()?;
        let after = reads.tip()?;
        let child = before.checked_add(1).ok_or_else(|| WalletError::Decode("the tip overflows".into()))?;
        let later = after.checked_add(1).ok_or_else(|| WalletError::Decode("the tip overflows".into()))?;
        if params::epoch_anchor_height_for_child(child) == params::epoch_anchor_height_for_child(later) {
            return Ok((later, anchor));
        }
    }
    refuse("the epoch anchor rotated while it was being read; run the step again")
}

/// The T6 rotation guard: no new transaction in the last blocks of an epoch.
fn rotation_hold(file: &SwapFile, child_height: u64) -> Option<String> {
    match file.public.params.profile.gates().rotation_guard(child_height) {
        RotationGuard::ProveNow => None,
        RotationGuard::WaitForBoundary { blocks } => Some(format!(
            "the transaction epoch rotates in {blocks} block(s) (the swap's rotation guard is {} blocks): a transaction built now could miss its window; wait for the rotation and run the step again",
            file.public.params.profile.gates().rotation_guard_blocks()
        )),
    }
}

// ---------------------------------------------------------------- balance

/// What the deposit box shows.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct BalanceReport {
    pub address: String,
    pub tip: u64,
    pub plain_total: u64,
    pub plain_coins: usize,
    pub carriers: usize,
    /// The swap's amount.
    pub amount: u64,
    /// The fee of a funding with one coin and a change output, from `estimateFeeDetailed(1, 2)`.
    pub fee_reserve: u64,
    pub need: u64,
    /// The plain coins cover `need`.
    pub covers: bool,
}

pub fn balance(file: &SwapFile, key: &WalletKey, rpc: &dyn JsonRpc) -> Result<BalanceReport, WalletError> {
    let reads = NodeReads::new(rpc);
    let tip = reads.tip()?;
    let view = reads.slots_by_owner(&key.address())?;
    let plain_total = view.plain_total().ok_or_else(|| WalletError::Decode("the amounts overflow".into()))?;
    let amount = file.public.params.amount_micronoid;
    let fee_reserve = reads.fee_for(1, 2)?;
    let need = amount.checked_add(fee_reserve).ok_or_else(|| WalletError::Refused("amount plus fee overflows".into()))?;
    Ok(BalanceReport {
        address: key.address().to_bech32(),
        tip,
        plain_total,
        plain_coins: view.plain.len(),
        carriers: view.carriers,
        amount,
        fee_reserve,
        need,
        covers: plain_total >= need,
    })
}

// ---------------------------------------------------------------- the common driver

/// Run one step with a record: no record = build and (maybe) send; a record = what [`next_step`] says. `build(Some(rec))` is a rebuild on exactly
/// the record's coins. `judge` says what to report when the recorded coins are gone and the chain is final.
#[allow(clippy::too_many_arguments)]
fn drive(
    env: &FlowEnv<'_>,
    kind: SendKind,
    rpath: &Path,
    existing: Option<SendRecord>,
    tip: u64,
    unspent: bool,
    stop: Option<String>,
    judge: impl FnOnce() -> Result<(Outcome, String), WalletError>,
    build: impl FnOnce(Option<&SendRecord>) -> Result<Built, WalletError>,
) -> Result<StepReport, WalletError> {
    let finish_built = |built: Built, built_now: bool| -> Result<StepReport, WalletError> {
        let mut rep = StepReport::new(kind, Outcome::DryRun, "");
        rep.txid = Some(built.record.txid.clone());
        rep.built_now = built_now;
        rep.amount = Some(built.amount);
        rep.fee = Some(built.fee);
        rep.change = Some(built.change);
        rep.target = Some(built.target.clone());
        rep.inputs = Some(built.inputs);
        rep.child_height = Some(built.child_height);
        if !env.submit {
            rep.summary = format!("dry run: the {} transaction {} is built, proved and verified; nothing was written or sent", kind.name(), built.record.txid);
            return Ok(rep);
        }
        // The record is written BEFORE anything is submitted; if this fails, nothing is sent.
        built.record.save(rpath)?;
        let sub = submit_bytes(&built.record.txid, &built.record.intent_hex, env.nodes);
        rep.outcome = verdict_outcome(&sub);
        rep.summary = sub.describe();
        rep.submit = Some(sub);
        Ok(rep)
    };

    let Some(rec) = existing else {
        return finish_built(build(None)?, true);
    };
    match next_step(&rec, tip, unspent, stop) {
        Next::Resend => {
            let mut rep = StepReport::new(kind, Outcome::DryRun, "");
            rep.txid = Some(rec.txid.clone());
            rep.amount = Some(rec.amount);
            rep.fee = Some(rec.fee);
            rep.target = Some(rec.target.clone());
            rep.inputs = Some(rec.inputs.len());
            rep.child_height = Some(rec.child_height);
            if !env.submit {
                rep.summary = format!("dry run: the recorded {} transaction {} would be sent again, the same bytes; nothing was sent", kind.name(), rec.txid);
                return Ok(rep);
            }
            let sub = submit_bytes(&rec.txid, &rec.intent_hex, env.nodes);
            rep.outcome = verdict_outcome(&sub);
            rep.summary = sub.describe();
            rep.submit = Some(sub);
            Ok(rep)
        }
        Next::Rebuild => {
            let mut built = build(Some(&rec))?;
            built.record.created_at = env.now;
            let mut rep = finish_built(built, true)?;
            rep.notes.push(format!(
                "the recorded transaction {} had its window (anchor height {}) and every coin it spends is still unspent: this one spends exactly the same coins",
                rec.txid, rec.anchor_height
            ));
            Ok(rep)
        }
        Next::Wait { until_tip } => Ok(StepReport::new(
            kind,
            Outcome::Hold,
            format!(
                "a coin the recorded {} transaction {} spends is gone: it may have landed. Nothing is built and nothing is judged until the tip is {until_tip} (now {tip}), when everything it could have done is final",
                kind.name(),
                rec.txid
            ),
        )),
        Next::Judge => {
            let (outcome, text) = judge()?;
            Ok(StepReport::new(kind, outcome, text))
        }
        Next::Stop { reason } => Ok(StepReport::new(kind, Outcome::Hold, format!("not sending the {} transaction: {reason}", kind.name()))),
    }
}

fn verdict_outcome(sub: &SubmitReport) -> Outcome {
    match sub.verdict() {
        SubmitVerdict::Sent => Outcome::Sent,
        SubmitVerdict::MaybeSent => Outcome::MaybeSent,
        SubmitVerdict::NotSent => Outcome::NotSent,
    }
}

fn built_from_send(kind: SendKind, digest: [u8; 32], plan: &SendPlan, target: &Address, now: u64) -> Built {
    Built {
        record: SendRecord::from_send(kind, digest, plan, &target.to_bech32(), now),
        amount: plan.amount,
        fee: plan.fee,
        change: plan.change,
        target: target.to_bech32(),
        inputs: plan.inputs.len(),
        child_height: plan.child_height,
    }
}

// ---------------------------------------------------------------- funding

/// The last tip at which the engine still offers the funding: `tip + b_fund + b_final <= lock_by`.
pub fn last_funding_tip(file: &SwapFile) -> u64 {
    let g = file.public.params.profile.gates();
    file.public.params.lock_by_height.saturating_sub(g.b_fund.saturating_add(g.b_final))
}

fn fund_stop(file: &SwapFile, tip: u64) -> Option<String> {
    if matches!(file.phase, Phase::Alice(AlicePhase::Aborted { .. })) {
        return Some("the swap file is aborted".into());
    }
    let last = last_funding_tip(file);
    (tip > last).then(|| format!("the last funding height has passed (tip {tip}, last funding tip {last})"))
}

#[derive(serde::Serialize, serde::Deserialize)]
struct DepositSeen {
    first_seen_tip: u64,
    total_micronoid: u64,
}

/// The wallet must have been seen holding enough for [`DEPOSIT_CONFIRMATIONS`] blocks before a real funding is built. The first sighting is kept in a small file
/// beside the swap file. A dry run reads it and never writes it.
fn deposit_ready(env: &FlowEnv<'_>, tip: u64, covered: bool, total: u64) -> Result<Option<String>, WalletError> {
    let path = {
        let mut s = env.swap_path.as_os_str().to_os_string();
        s.push(".wallet-deposit.json");
        std::path::PathBuf::from(s)
    };
    let stored: Option<DepositSeen> = std::fs::read(&path).ok().and_then(|b| serde_json::from_slice(&b).ok());
    if !covered {
        if env.submit {
            // Not covered any more: forget the sighting, so that a new deposit is waited for again.
            let _ = std::fs::remove_file(&path);
        }
        return Ok(None);
    }
    let first = match stored {
        Some(d) => d.first_seen_tip,
        None => {
            if env.submit {
                let body = serde_json::to_vec(&DepositSeen { first_seen_tip: tip, total_micronoid: total }).map_err(|e| WalletError::Persist(e.to_string()))?;
                atomic_write(&path, &body).map_err(|e| WalletError::Persist(e.to_string()))?;
            }
            tip
        }
    };
    let ready_at = first.saturating_add(DEPOSIT_CONFIRMATIONS);
    if env.submit && tip < ready_at {
        return Ok(Some(format!(
            "the deposit was first seen at tip {first}; it is spent only {DEPOSIT_CONFIRMATIONS} blocks later (tip {ready_at}, now {tip}): a reorg of the deposit would only make the funding fail, but nothing is rushed"
        )));
    }
    Ok(None)
}

/// Fund the contract from the swap wallet: a plain payment of exactly the swap's amount to the contract's address. With a record of an earlier
/// funding, only that funding is sent again, or rebuilt on exactly its coins (amendment B); a new one is never built beside it.
pub fn fund(env: &FlowEnv<'_>) -> Result<StepReport, WalletError> {
    check_wallet(env)?;
    let file = env.file;
    match &file.phase {
        Phase::Alice(AlicePhase::Created | AlicePhase::FundingSubmitted { .. }) => {}
        other => return refuse(format!("the swap is in phase `{}`: the funding is made while it is `created` (or `funding_submitted`, to send the recorded one again)", other.name())),
    }
    let opening = checked_opening(file)?;
    let root = opening.root();
    let amount = file.public.params.amount_micronoid;
    let digest = file.public.digest();
    let rpath = record_path(env.swap_path, SendKind::Fund);
    let reads = NodeReads::new(env.rpc);
    let tip = reads.tip()?;
    let own = env.key.address();

    let existing = SendRecord::load(&rpath, &digest)?;
    if let Some(r) = &existing {
        if r.target != root.to_bech32() || r.amount != amount {
            return refuse("the recorded funding is not for this swap's contract root and amount; it is left alone");
        }
    }
    // A funding that was submitted by another path (the wallet program, the console) leaves the phase at `funding_submitted`; its pending payment is
    // invisible at the contract's address. Without a record of this wallet's own, a new funding would be a second one: nothing is built.
    if existing.is_none() && matches!(file.phase, Phase::Alice(AlicePhase::FundingSubmitted { .. })) {
        return Ok(StepReport::new(SendKind::Fund, Outcome::Hold, "this swap's funding was submitted by another path; the wallet does not fund"));
    }
    let (instances, _) = reads.root_instances(&file.public.opening_hex)?;
    let view = reads.slots_by_owner(&own)?;

    if !instances.is_empty() {
        let landed = existing.as_ref().is_some_and(|r| !all_unspent(r, &view.plain));
        let text = if landed {
            format!("the funding is at the contract ({} coin(s) at its address): there is nothing to send; run `tick --apply` so the swap file records it", instances.len())
        } else {
            format!("{} coin(s) already sit at the contract's address and this wallet's funding is not what put them there: no second funding is made; check the contract with `tick`", instances.len())
        };
        return Ok(StepReport::new(SendKind::Fund, if landed { Outcome::Done } else { Outcome::Hold }, text));
    }

    let stop = fund_stop(file, tip);
    let unspent = existing.as_ref().is_some_and(|r| all_unspent(r, &view.plain));
    let judge = || {
        Ok((
            Outcome::Hold,
            "a coin the recorded funding spends is gone and nothing sits at the contract's address: the state is unknown. Nothing is sent and nothing is built; wait and look at the chain (the funding may have landed and been closed, or the coin may have gone another way)".to_string(),
        ))
    };
    let build = |fixed: Option<&SendRecord>| -> Result<Built, WalletError> {
        let (child, anchor) = height_and_anchor(&reads)?;
        if let Some(why) = rotation_hold(file, child) {
            return refuse(why);
        }
        let mut fee_for = |i: usize, o: usize| reads.fee_for(i, o);
        let sel = match fixed {
            Some(rec) => shape_for_inputs(&rec.inputs, amount, &mut fee_for)?,
            None => select_for_payment(&view.plain, amount, &mut fee_for)?,
        };
        let slots = reads.output_slots(&own, 1 + usize::from(sel.change > 0))?;
        let plan = build_send(SendInputs { key: env.key, inputs: &sel.inputs, target: root, amount, fee: sel.fee, output_slots: &slots, epoch_anchor: anchor, child_height: child })?;
        // The funding pays exactly the opening's root, exactly the swap's amount.
        let pays = plan.outputs.first();
        if pays.map(|o| (o.owner, o.amount)) != Some((root, amount)) {
            return Err(WalletError::Build("the built funding does not pay exactly the swap's amount to the contract's address".into()));
        }
        Ok(built_from_send(SendKind::Fund, digest, &plan, &root, env.now))
    };
    // A first funding: the wallet must hold enough and have held it for a few blocks, and the window must be open. Each of these is a "not yet", not an error.
    if existing.is_none() {
        if let Some(why) = &stop {
            return Ok(StepReport::new(SendKind::Fund, Outcome::Hold, format!("not funding: {why}")));
        }
        let total = view.plain_total().unwrap_or(0);
        // A node answer that fails a sanity check (a fee above the ceiling) is an error to show, not a reason to ask for a deposit.
        let have_enough = match select_for_payment(&view.plain, amount, &mut |i, o| reads.fee_for(i, o)) {
            Ok(_) => true,
            Err(e @ WalletError::Decode(_)) => return Err(e),
            Err(_) => false,
        };
        if !have_enough {
            let _ = deposit_ready(env, tip, false, total)?;
            let mut rep = StepReport::new(
                SendKind::Fund,
                Outcome::Hold,
                format!("the wallet holds {total} micro-NOID of plain coins; the funding needs the amount {amount} and its fee. Deposit to {} and run this again", own.to_bech32()),
            );
            rep.notes.push(format!("{} native-asset carrier(s) in the wallet are never counted or spent", view.carriers));
            return Ok(rep);
        }
        if let Some(wait) = deposit_ready(env, tip, true, total)? {
            return Ok(StepReport::new(SendKind::Fund, Outcome::Hold, wait));
        }
    }
    drive(env, SendKind::Fund, &rpath, existing, tip, unspent, stop.clone(), judge, build)
}

// ---------------------------------------------------------------- recovery

fn recorded_instance(file: &SwapFile) -> Option<NoidInstance> {
    match &file.phase {
        Phase::Alice(p) => p.instance().cloned(),
        Phase::Bob(_) => None,
    }
}

/// The recovery close fee of this swap: exactly `max_fee` under contract v2, the node's current fee clamped to `[5,800, max_fee]` under v1
/// (the engine's own rule, [`close_fee_for`]).
pub fn recovery_fee(file: &SwapFile, reads: &NodeReads<'_>) -> Result<u64, WalletError> {
    let est = reads.fee_for(1, 1)?;
    let obs = NoidObservation { fee_estimate_1_1: Some(est), fee_floor: Some(0), ..Default::default() };
    Ok(close_fee_for(file.public.params.contract_version, &obs, file.public.params.max_fee_micronoid))
}

/// Take the NOID back from the contract at or after the deadline (the contract pays its committed recovery recipient: the wallet). `fee` is the close fee
/// (the engine's `refund_noid` fee, or [`recovery_fee`]).
pub fn recover(env: &FlowEnv<'_>, fee: u64) -> Result<StepReport, WalletError> {
    check_wallet(env)?;
    let file = env.file;
    let opening = checked_opening(file)?;
    let instance = match &file.phase {
        Phase::Alice(AlicePhase::Refunded { .. } | AlicePhase::Aborted { .. } | AlicePhase::Created | AlicePhase::FundingSubmitted { .. }) => {
            return refuse(format!("the swap is in phase `{}`: there is no instance of ours to recover", file.phase.name()))
        }
        Phase::Alice(p) => p.instance().cloned().ok_or_else(|| WalletError::Refused(format!("the swap file records no instance in phase `{}`", file.phase.name())))?,
        Phase::Bob(_) => return refuse("recovery belongs to Alice's file"),
    };
    let digest = file.public.digest();
    let rpath = record_path(env.swap_path, SendKind::Recover);
    let reads = NodeReads::new(env.rpc);
    let tip = reads.tip()?;
    let own = env.key.address();
    let deadline = file.public.params.deadline_height;
    let existing = SendRecord::load(&rpath, &digest)?;
    if let Some(r) = &existing {
        let same = r.inputs.len() == 1
            && r.inputs[0] == WalletSlot { slot_index: instance.slot_index, amount: instance.amount_micronoid, creation_id: instance.creation_id };
        if !same {
            return refuse("the recorded recovery is for another instance than the one this swap file records; it is left alone");
        }
    }
    let (at_root, _) = reads.root_instances(&file.public.opening_hex)?;
    let listed = at_root.iter().any(|r| r.slot_index == instance.slot_index && r.creation_id == instance.creation_id && r.amount_micronoid == instance.amount_micronoid);
    if existing.is_none() && !listed {
        return Ok(StepReport::new(SendKind::Recover, Outcome::Hold, "the swap's instance is not at the contract's address (closed, or not visible on this node): nothing to recover from here; run `tick` to see what happened"));
    }
    if tip.saturating_add(1) < deadline {
        return Ok(StepReport::new(
            SendKind::Recover,
            Outcome::Hold,
            format!("the recovery branch opens at the deadline {deadline}; the next block is {}", tip.saturating_add(1)),
        ));
    }
    let unspent = existing.as_ref().map_or(listed, |r| instance_unspent(r, &at_root));
    let judge = || {
        Ok((
            Outcome::Done,
            "the instance is no longer at the contract and the recorded recovery is final on every block it could have been in: look at the wallet's coins with `wallet balance`".to_string(),
        ))
    };
    let build = |_fixed: Option<&SendRecord>| -> Result<Built, WalletError> {
        let (child, anchor) = height_and_anchor(&reads)?;
        if let Some(why) = rotation_hold(file, child) {
            return refuse(why);
        }
        let slots = reads.output_slots(&own, 1)?;
        let plan = build_recovery(RecoveryInputs { opening: &opening, instance: &instance, key: env.key, output_slot: slots[0], fee, epoch_anchor: anchor, call_height: child })?;
        let rec = SendRecord::from_recovery(digest, &plan, env.now);
        Ok(Built { amount: plan.amount_out, fee: plan.fee, change: 0, target: plan.recipient.to_bech32(), inputs: 1, child_height: plan.call_height, record: rec })
    };
    drive(env, SendKind::Recover, &rpath, existing, tip, unspent, None, judge, build)
}

// ---------------------------------------------------------------- sweep

/// May the wallet's coins be swept now? Only after the swap is settled and the instance the swap file RECORDED is closed (amendment F): a dust coin
/// left at the contract's address by a stranger does not block it, a recorded instance still there does. A funding that was sent and is not settled
/// in the swap file blocks it.
fn sweep_blocker(file: &SwapFile, at_root: &[NoidInstance], fund_rec: Option<&SendRecord>, view: &SlotView, tip: u64) -> Option<String> {
    if !file.phase.is_settled() {
        return Some(format!("the swap is in phase `{}`: the wallet is swept only after the swap is over", file.phase.name()));
    }
    if let Phase::Alice(AlicePhase::Done { instance: None, .. }) = &file.phase {
        return Some("the swap file (made before the instance was recorded in `done`) does not say which instance was ours; recover by hand".into());
    }
    if matches!(file.phase, Phase::Alice(AlicePhase::Refunded { .. })) {
        // The recovery close is final: the instance is closed by definition.
    } else if let Some(i) = recorded_instance(file) {
        if at_root.iter().any(|r| r.slot_index == i.slot_index && r.creation_id == i.creation_id) {
            return Some(format!("the swap's own instance (slot {}) is still at the contract: it is recovered first (`wallet recover`), and swept after it is closed", i.slot_index));
        }
    } else if let Some(r) = fund_rec {
        // No instance was ever recorded, but a funding was sent: it must be settled one way or the other.
        let cannot_land = all_unspent(r, &view.plain) && tip.saturating_add(1) > r.last_valid_height();
        if !cannot_land {
            return Some("a funding was sent and the swap file records no instance for it: it is not settled; run `tick --apply`, or wait until the funding can no longer land".into());
        }
    }
    None
}

/// Sweep everything spendable, minus the fee, to the payout address stored (and sealed) in the swap file.
pub fn sweep(env: &FlowEnv<'_>) -> Result<StepReport, WalletError> {
    check_wallet(env)?;
    let file = env.file;
    let payout = match file.wallet.as_ref().and_then(|w| w.payout.as_deref()) {
        Some(p) => Address::parse(p).map_err(|e| WalletError::Refused(format!("the payout address: {e}")))?,
        None => return refuse("this swap has no payout address: the sweep is refused"),
    };
    let own = env.key.address();
    if payout == own {
        return refuse("the payout address is the swap wallet itself");
    }
    let opening = checked_opening(file)?;
    if payout == opening.root() {
        return refuse("the payout address is the contract's address");
    }
    let digest = file.public.digest();
    let rpath = record_path(env.swap_path, SendKind::Sweep);
    let fund_rec = SendRecord::load(&record_path(env.swap_path, SendKind::Fund), &digest)?;
    let existing = SendRecord::load(&rpath, &digest)?;
    if let Some(r) = &existing {
        if r.target != payout.to_bech32() {
            return refuse("the recorded sweep goes to another address than this swap's payout address; it is left alone");
        }
    }
    let reads = NodeReads::new(env.rpc);
    let tip = reads.tip()?;
    let (at_root, _) = reads.root_instances(&file.public.opening_hex)?;
    let view = reads.slots_by_owner(&own)?;
    if let Some(why) = sweep_blocker(file, &at_root, fund_rec.as_ref(), &view, tip) {
        return Ok(StepReport::new(SendKind::Sweep, Outcome::Hold, why));
    }
    let unspent = existing.as_ref().is_some_and(|r| all_unspent(r, &view.plain));
    let judge = || Ok((Outcome::Done, "the recorded sweep's coins are spent and final: the payout address has them".to_string()));
    let build = |fixed: Option<&SendRecord>| -> Result<Built, WalletError> {
        let (child, anchor) = height_and_anchor(&reads)?;
        if let Some(why) = rotation_hold(file, child) {
            return refuse(why);
        }
        let mut fee_for = |i: usize, o: usize| reads.fee_for(i, o);
        let (inputs, fee, amount) = match fixed {
            Some(rec) => {
                let n = rec.inputs.len();
                let total = rec.inputs.iter().try_fold(0u64, |a, s| a.checked_add(s.amount)).ok_or_else(|| WalletError::Refused("overflow".into()))?;
                let fee = fee_for(n, 1)?;
                let amount = total.checked_sub(fee).filter(|a| *a > 0).ok_or(WalletError::Funds { need: fee.saturating_add(1), have: total })?;
                check_sweep_fee(fee, total)?;
                (rec.inputs.clone(), fee, amount)
            }
            None => {
                let s = select_for_sweep(&view.plain, &mut fee_for)?;
                (s.inputs, s.fee, s.amount)
            }
        };
        let slots = reads.output_slots(&own, 1)?;
        let plan = build_send(SendInputs { key: env.key, inputs: &inputs, target: payout, amount, fee, output_slots: &slots, epoch_anchor: anchor, child_height: child })?;
        if plan.change != 0 || plan.outputs.len() != 1 || plan.outputs[0].owner != payout {
            return Err(WalletError::Build("the built sweep is not one output to the payout address".into()));
        }
        Ok(built_from_send(SendKind::Sweep, digest, &plan, &payout, env.now))
    };
    let mut rep = drive(env, SendKind::Sweep, &rpath, existing, tip, unspent, None, judge, build)?;
    if view.carriers > 0 {
        rep.notes.push(format!("{} native-asset carrier(s) are left in the wallet: the tool never spends them (import the wallet secret into the stock wallet to move them)", view.carriers));
    }
    Ok(rep)
}

// ---------------------------------------------------------------- export

/// The backup of the wallet: `m` and the 699-byte opening (amendment D). The caller prints them once and only on an explicit flag.
pub struct Export {
    pub address: String,
    pub master_secret_hex: zeroize::Zeroizing<String>,
    pub opening_hex: String,
}

pub fn export(file: &SwapFile, pass: &Passphrase) -> Result<Export, WalletError> {
    let m = file.decrypt_wallet(pass).map_err(|e| WalletError::Refused(e.to_string()))?;
    let key = WalletKey::from_secret(m);
    if key.address().to_bech32() != file.public.params.alice_noid {
        return refuse("the wallet secret does not derive the swap's recovery address");
    }
    Ok(Export {
        address: key.address().to_bech32(),
        master_secret_hex: zeroize::Zeroizing::new(hex::encode(key.master().bytes())),
        opening_hex: file.public.opening_hex.clone(),
    })
}

// ---------------------------------------------------------------- the engine executors

/// Performs the engine's `fund_noid` and `refund_noid` from the swap wallet. Every other action is refused. The decisions are the engine's; this adds
/// refusals only. A submit whose outcome is unknown is reported as such (the runner then holds a funding and retries a recovery with the same bytes).
pub struct WalletExecutor<R: JsonRpc> {
    pub swap_path: std::path::PathBuf,
    pub rpc: R,
    pub nodes: Vec<(String, Box<dyn IntentSubmitter>)>,
    pub passphrase: Passphrase,
    /// The report of the last step, for the operator.
    pub last_report: Option<StepReport>,
}

impl<R: JsonRpc> WalletExecutor<R> {
    pub fn new(swap_path: std::path::PathBuf, rpc: R, nodes: Vec<(String, Box<dyn IntentSubmitter>)>, passphrase: Passphrase) -> Self {
        Self { swap_path, rpc, nodes, passphrase, last_report: None }
    }

    fn run(&mut self, file: &SwapFile, now: u64, step: impl FnOnce(&FlowEnv<'_>) -> Result<StepReport, WalletError>) -> Result<StepReport, ExecError> {
        let m = file.decrypt_wallet(&self.passphrase).map_err(|e| ExecError::not_sent(e.to_string()))?;
        let key = WalletKey::from_secret(m);
        let refs: Vec<(&str, &dyn IntentSubmitter)> = self.nodes.iter().map(|(n, s)| (n.as_str(), s.as_ref())).collect();
        let env = FlowEnv { swap_path: &self.swap_path, file, key: &key, rpc: &self.rpc, nodes: &refs, submit: true, now };
        step(&env).map_err(|e| ExecError::not_sent(e.to_string()))
    }
}

impl<R: JsonRpc> Executor for WalletExecutor<R> {
    fn execute(&mut self, file: &SwapFile, action: &Action, now: u64) -> Result<Option<Event>, ExecError> {
        let rep = match action {
            Action::FundNoid { amount_micronoid } => {
                if *amount_micronoid != file.public.params.amount_micronoid {
                    return Err(ExecError::not_sent("the engine's funding amount is not the swap file's amount"));
                }
                self.run(file, now, fund)?
            }
            Action::RefundNoid { fee_micronoid, .. } => {
                let fee = *fee_micronoid;
                self.run(file, now, move |env| recover(env, fee))?
            }
            other => return Err(ExecError::not_sent(format!("the swap wallet does not perform {}", other.kind()))),
        };
        let txid = rep.txid.clone();
        let height = rep.child_height;
        let outcome = rep.outcome;
        let summary = rep.summary.clone();
        self.last_report = Some(rep);
        match (outcome, action) {
            (Outcome::Sent, Action::FundNoid { .. }) => Ok(Some(Event::FundingSubmitted { txid })),
            (Outcome::Sent, Action::RefundNoid { call_height, .. }) => Ok(Some(Event::NoidRefundSubmitted { txid, call_height: height.unwrap_or(*call_height) })),
            (Outcome::MaybeSent, _) => Err(ExecError::unknown(summary)),
            (Outcome::Done, _) => Ok(None),
            _ => Err(ExecError::not_sent(summary)),
        }
    }
}
