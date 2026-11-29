//! The decisions of the 2026-11-16 chaos batch (X1 to X4), each pinned with the neighbouring case that must stay as it was:
//!
//! - X2: the notes beside an abort that follows a cancelled `fund_noid`, and the two forms of "abort not recorded";
//! - X1: Alice's recovery close for another incarnation of her funding at and after `D` (CHAOS F-19's rule, extended);
//! - X3: closes by someone else (CHAOS F-11);
//! - X4: Bob's `locked` re-checks the lock (CHAOS F-6).

mod common;

use common::*;
use swap_cli::engine::{cancel_intent, tick_apply, Action, MIN_CANCEL_AGE_S};
use swap_cli::params::ProfileName;
use swap_cli::secret::Variant;
use swap_cli::swapfile::SwapFile;
use swap_cli::watch::{EthObservation, NoidInstance, NoidObservation};

fn observe(s: &Scenario) -> (NoidObservation, EthObservation, u64) {
    let w = s.world.borrow();
    (w.noid_obs(None), w.eth_obs(), w.eth_time)
}

fn notes_with<'a>(notes: &'a [String], needle: &str) -> Vec<&'a String> {
    notes.iter().filter(|n| n.contains(needle)).collect()
}

// ================================================================================================ X2

const CANCELLED_NOTE: &str = "a fund_noid was decided and later cancelled (taken as not sent); no instance of this contract is visible and the funding window is closed; if a funding was sent, it is no longer at the contract: check the wallet's history";

/// Alice's CLI file with a recorded (never sent) `fund_noid` intent, the Parano1d tip at the lock-by (the funding window is closed).
fn alice_with_a_decided_funding_after_the_window() -> (Scenario, SwapFile, u64) {
    let s = Scenario::new(Variant::Raw);
    let mut file = s.alice.file.clone();
    let (noid, eth, now) = observe(&s);
    let out = tick_apply(&mut file, &noid, &eth, now, true).unwrap();
    assert_eq!(out.decision.action.kind(), "fund_noid", "{:?}", out.decision);
    assert!(file.pending_intent.is_some());
    let lock_by = s.public.params.lock_by_height;
    s.world.borrow_mut().tip = lock_by;
    (s, file, now)
}

#[test]
fn x2_the_abort_note_before_any_cancel_says_never_cancelled_and_after_a_cancel_says_how_long_the_abort_is_kept_back() {
    let (s, mut file, t0) = alice_with_a_decided_funding_after_the_window();
    let hold = s.gates().abort_after_cancel_s;
    let (noid, eth, _) = observe(&s);
    // Decided and never cancelled: the old text, unchanged.
    let out = tick_apply(&mut file, &noid, &eth, t0 + 10, true).unwrap();
    assert_eq!(out.decision.action.kind(), "abort", "{:?}", out.decision);
    assert_eq!(file.phase.name(), "created");
    let never = "abort not recorded: a fund_noid was decided for this swap and never cancelled, so it may have been sent (a funding or a lock that the chain does not show yet, or that a reorg took back). Look at the wallet / the contract; `swap-cli intent FILE --cancel` records that it was not sent";
    assert!(out.decision.notes.iter().any(|n| n == never), "{:?}", out.decision.notes);
    assert!(notes_with(&out.decision.notes, "cancelled at").is_empty(), "{:?}", out.decision.notes);
    // The operator cancels (nothing visible, nothing pending, old enough).
    let tc = t0 + MIN_CANCEL_AGE_S + 1;
    cancel_intent(&mut file, &noid, &eth, tc).unwrap();
    // Inside the hold: the second form, with the cancel time and the time left; still not recorded.
    let out = tick_apply(&mut file, &noid, &eth, tc + 60, true).unwrap();
    assert_eq!(file.phase.name(), "created", "{:?}", out.decision);
    let want = format!(
        "abort not recorded yet: a fund_noid was decided for this swap and cancelled at {tc} (unix), {hold} s are kept back after a cancel ({} s left) because a cancel rests on one node's view of the mempool, so the send may still land (a funding or a lock that the chain does not show yet, or that a reorg took back). Look at the wallet / the contract; the abort is recorded then, if it still stands",
        hold - 60
    );
    assert!(out.decision.notes.iter().any(|n| *n == want), "{:?}", out.decision.notes);
    assert!(notes_with(&out.decision.notes, "never cancelled").is_empty(), "{:?}", out.decision.notes);
    assert!(notes_with(&out.decision.notes, CANCELLED_NOTE).is_empty());
    // After the hold the abort is recorded, and the note about the cancelled funding stands beside it.
    let out = tick_apply(&mut file, &noid, &eth, tc + hold, true).unwrap();
    assert_eq!(file.phase.name(), "aborted", "{:?}", out.decision);
    assert!(out.decision.notes.iter().any(|n| n == CANCELLED_NOTE), "{:?}", out.decision.notes);
    assert!(notes_with(&out.decision.notes, "abort not recorded").is_empty(), "{:?}", out.decision.notes);
}

#[test]
fn x2_the_cancelled_funding_note_is_not_printed_for_an_abort_that_has_no_such_history() {
    // The neighbour: the same window abort, recorded at once, no funding was ever decided.
    let s = Scenario::new(Variant::Raw);
    let lock_by = s.public.params.lock_by_height;
    s.world.borrow_mut().tip = lock_by;
    let mut file = s.alice.file.clone();
    let (noid, eth, now) = observe(&s);
    let out = tick_apply(&mut file, &noid, &eth, now, true).unwrap();
    assert_eq!(out.decision.action.kind(), "abort", "{:?}", out.decision);
    assert_eq!(file.phase.name(), "aborted");
    assert!(notes_with(&out.decision.notes, "later cancelled").is_empty(), "{:?}", out.decision.notes);
}

#[test]
fn x2_the_cancelled_funding_note_is_not_printed_when_an_instance_is_visible() {
    let (s, mut file, t0) = alice_with_a_decided_funding_after_the_window();
    let (noid, eth, _) = observe(&s);
    let tc = t0 + MIN_CANCEL_AGE_S + 1;
    cancel_intent(&mut file, &noid, &eth, tc).unwrap();
    // A dust instance sits at the root (it does not fit; the abandoned-instances note speaks for it).
    s.world.borrow_mut().instances_after.push(NoidInstance { slot_index: 21, creation_id: 701, amount_micronoid: 1 });
    let (noid, eth, _) = observe(&s);
    let hold = s.gates().abort_after_cancel_s;
    let out = tick_apply(&mut file, &noid, &eth, tc + hold, true).unwrap();
    assert_eq!(out.decision.action.kind(), "abort", "{:?}", out.decision);
    assert!(notes_with(&out.decision.notes, "later cancelled").is_empty(), "{:?}", out.decision.notes);
}

// ================================================================================================ X1

const TXID: &str = "ab12ab12ab12ab12ab12ab12ab12ab12ab12ab12ab12ab12ab12ab12ab12ab12";

/// Alice's funding is final; the simulated instance is then replaced by another incarnation of the same slot (reorgs re-included the funding while
/// she was not ticking): the world's creation is the recorded one plus two. Returns the scenario and the recorded creation.
fn alice_funding_final_and_a_new_incarnation() -> (Scenario, u64) {
    let mut s = Scenario::new(Variant::Raw);
    s.tick_alice();
    s.world.borrow_mut().advance_noid(1);
    s.tick_both();
    s.world.borrow_mut().advance_noid(18);
    s.tick_alice();
    assert_eq!(s.alice_phase(), "funding_final");
    let recorded = s.world.borrow().instance.as_ref().unwrap().creation_id;
    s.world.borrow_mut().instance.as_mut().unwrap().creation_id += 2;
    (s, recorded)
}

fn set_tip(s: &Scenario, tip: u64) {
    s.world.borrow_mut().tip = tip;
}

fn adoption_note(d: u64, recorded: u64, adopted_slot: u32, adopted: u64) -> String {
    format!(
        "the recorded instance (slot 7, creation {recorded}) is not at the contract and this file never saw it closed; D {d} is reached, so the recovery close (refund_noid) is for the oldest instance of the agreed amount at the root: slot {adopted_slot}, creation {adopted}, which is NOT the recorded one (every instance at this opening pays Alice on the recovery branch)"
    )
}

#[test]
fn x1_at_d_a_new_incarnation_of_the_funding_is_recovered_and_the_file_ends_refunded() {
    let (mut s, recorded) = alice_funding_final_and_a_new_incarnation();
    let d = s.public.params.deadline_height;
    set_tip(&s, d - 1);
    let r = s.tick_alice();
    assert_eq!(r.action.kind(), "refund_noid", "{r:?}");
    assert!(r.notes.contains(&adoption_note(d, recorded, 7, recorded + 2)), "{:?}", r.notes);
    assert_eq!(s.alice.executor.count("refund_noid"), 1);
    assert_eq!(s.alice_phase(), "refund_submitted");
    s.world.borrow_mut().advance_noid(1);
    s.tick_alice();
    assert_eq!(s.alice_phase(), "refund_included");
    s.world.borrow_mut().advance_noid(18);
    s.tick_alice();
    assert_eq!(s.alice_phase(), "refunded");
    assert_eq!(s.world.borrow().noid_payout.as_ref().unwrap().0, s.public.params.alice_noid);
}

#[test]
fn x1_before_d_nothing_changes_the_other_incarnation_is_not_the_funded_instance() {
    let (s, _) = alice_funding_final_and_a_new_incarnation();
    let d = s.public.params.deadline_height;
    set_tip(&s, d - 2);
    let (noid, eth, now) = observe(&s);
    let out = swap_cli::engine::decide(&s.alice.file, &noid, &eth, now);
    assert_ne!(out.action.kind(), "refund_noid", "{out:?}");
    assert!(notes_with(&out.notes, "NOT the recorded one").is_empty(), "{:?}", out.notes);
    // Alice at `lock_final` with the new incarnation in view: no reveal on the strength of it, before D or at D.
    let mut s = Scenario::new(Variant::Raw);
    s.run_to_lock_final();
    s.world.borrow_mut().instance.as_mut().unwrap().creation_id += 2;
    let r = s.tick_alice();
    assert_eq!(r.action.kind(), "wait", "{r:?}");
    assert!(r.notes.iter().any(|n| n.starts_with("not revealing: the recorded NOID instance is not at the contract")), "{:?}", r.notes);
    assert_eq!(s.alice.executor.count("reveal_eth"), 0);
    assert_eq!(s.alice_phase(), "lock_final");
    assert!(notes_with(&r.notes, "NOT the recorded one").is_empty(), "{:?}", r.notes);
}

#[test]
fn x1_at_d_in_lock_final_the_recovery_is_offered_for_the_new_incarnation_and_never_a_reveal() {
    let mut s = Scenario::new(Variant::Raw);
    s.run_to_lock_final();
    let recorded = s.world.borrow().instance.as_ref().unwrap().creation_id;
    s.world.borrow_mut().instance.as_mut().unwrap().creation_id += 2;
    let d = s.public.params.deadline_height;
    set_tip(&s, d - 1);
    let r = s.tick_alice();
    assert_eq!(r.action.kind(), "refund_noid", "{r:?}");
    assert!(r.notes.contains(&adoption_note(d, recorded, 7, recorded + 2)), "{:?}", r.notes);
    assert_eq!(s.alice.executor.count("reveal_eth"), 0);
}

#[test]
fn x1_a_reorg_that_takes_the_tip_back_below_d_leaves_every_earlier_decision_as_it_was() {
    let (s, recorded) = alice_funding_final_and_a_new_incarnation();
    let d = s.public.params.deadline_height;
    let file = s.alice.file.clone();
    let decide_at = |tip: u64| {
        set_tip(&s, tip);
        let (noid, eth, now) = observe(&s);
        swap_cli::engine::decide(&file, &noid, &eth, now)
    };
    let before = decide_at(d - 3);
    let at_d = decide_at(d - 1);
    assert_eq!(at_d.action.kind(), "refund_noid", "{at_d:?}");
    assert!(at_d.notes.contains(&adoption_note(d, recorded, 7, recorded + 2)), "{:?}", at_d.notes);
    // The tip falls back (a reorg): the decision is the one made before, with no trace of the adoption (it is written nowhere).
    let back = decide_at(d - 3);
    assert_eq!(back.action, before.action);
    assert_eq!(back.notes, before.notes);
    assert_eq!(back.events, before.events);
    assert_eq!(file.phase, s.alice.file.phase);
    // And it is offered again once the tip is back at D.
    assert_eq!(decide_at(d - 1).action.kind(), "refund_noid");
}

#[test]
fn x1_the_recovery_goes_through_the_f14_wait_and_the_intent_ledger() {
    let (s, recorded) = alice_funding_final_and_a_new_incarnation();
    let d = s.public.params.deadline_height;
    set_tip(&s, d - 1);
    // F-14: a call pending on the contract holds it back, as for the recorded instance.
    let (mut noid, eth, now) = observe(&s);
    noid.pending_calls = vec![swap_cli::watch::PendingCall { txid: TXID.into(), fee_micronoid: 5_800, admitted_height: noid.tip }];
    if let Some(second) = noid.second.as_mut() {
        second.pending_calls = noid.pending_calls.clone();
    }
    let mut file = s.alice.file.clone();
    let out = tick_apply(&mut file, &noid, &eth, now, true).unwrap();
    assert_eq!(out.decision.action.kind(), "wait", "{:?}", out.decision);
    assert!(matches!(&out.decision.action, swap_cli::engine::Action::Wait { reason } if reason.contains("CHAOS F-14")), "{:?}", out.decision.action);
    assert!(file.pending_intent.is_none());
    // Nothing pending: one intent, naming the instance it is for.
    let (noid, eth, now) = observe(&s);
    let out = tick_apply(&mut file, &noid, &eth, now, true).unwrap();
    assert_eq!(out.decision.action.kind(), "refund_noid", "{:?}", out.decision);
    let intent = file.pending_intent.clone().expect("recorded");
    assert_eq!(intent.params["recovery_instance"], serde_json::json!({ "slot_index": 7, "creation_id": recorded + 2 }));
    // Held on the next tick (the recorded instance is gone already, but the one it is for is still there): not printed a second time.
    let out = tick_apply(&mut file, &noid, &eth, now + 30, true).unwrap();
    assert_eq!(out.decision.action.kind(), "wait", "{:?}", out.decision);
    assert!(matches!(out.intent, swap_cli::engine::IntentStatus::Held(_)), "{:?}", out.intent);
    assert_eq!(file.history.iter().filter(|h| h.event == "intent_decided:refund_noid").count(), 1);
    // The close lands: that instance is gone and the intent resolves.
    s.world.borrow_mut().instance = None;
    let (noid, eth, now) = observe(&s);
    let out = tick_apply(&mut file, &noid, &eth, now + 60, true).unwrap();
    assert!(matches!(out.intent, swap_cli::engine::IntentStatus::Resolved(_)), "{:?}", out.intent);
    assert!(file.pending_intent.is_none());
}

#[test]
fn x1_several_instances_one_is_recovered_per_round_and_the_rest_are_named() {
    let (s, recorded) = alice_funding_final_and_a_new_incarnation();
    let d = s.public.params.deadline_height;
    let amount = s.public.params.amount_micronoid;
    // An OLDER instance of the agreed amount and a dust instance beside the new incarnation.
    s.world.borrow_mut().instances_before.push(NoidInstance { slot_index: 3, creation_id: 1, amount_micronoid: amount });
    s.world.borrow_mut().instances_after.push(NoidInstance { slot_index: 21, creation_id: 701, amount_micronoid: 1 });
    set_tip(&s, d - 1);
    let (noid, eth, now) = observe(&s);
    let out = swap_cli::engine::decide(&s.alice.file, &noid, &eth, now);
    assert_eq!(out.action.kind(), "refund_noid", "{out:?}");
    let note = out.notes.iter().find(|n| n.starts_with("the recorded instance (slot 7")).expect("adoption note");
    let want = adoption_note(d, recorded, 3, 1);
    assert!(note.starts_with(&want), "{note}");
    assert!(note.contains("; 2 other instance(s) sit at the contract root and are not covered by this close:"), "{note}");
    assert!(note.contains(&format!("slot 7 (creation {}", recorded + 2)) && note.contains("slot 21 (creation 701"), "{note}");
}

#[test]
fn x1_unchanged_neighbours_nothing_fitting_the_recorded_instance_still_there_or_closed_before_d() {
    let (s, _) = alice_funding_final_and_a_new_incarnation();
    let d = s.public.params.deadline_height;
    set_tip(&s, d - 1);
    // Only a dust instance at the root (nothing of the agreed amount): the old wait and the old note stand.
    s.world.borrow_mut().instance.as_mut().unwrap().amount_micronoid = 1;
    let (noid, eth, now) = observe(&s);
    let out = swap_cli::engine::decide(&s.alice.file, &noid, &eth, now);
    assert_eq!(out.action.kind(), "wait", "{out:?}");
    assert!(matches!(&out.action, swap_cli::engine::Action::Wait { reason } if reason.starts_with("the instance is not visible, so there is nothing to refund")), "{:?}", out.action);
    assert!(notes_with(&out.notes, "NOT the recorded one").is_empty(), "{:?}", out.notes);
    // The recorded instance is still there: the normal refund, no adoption note.
    let mut s = Scenario::new(Variant::Raw);
    s.tick_alice();
    s.world.borrow_mut().advance_noid(1);
    s.tick_both();
    s.world.borrow_mut().advance_noid(18);
    s.tick_alice();
    let d = s.public.params.deadline_height;
    set_tip(&s, d - 1);
    let (noid, eth, now) = observe(&s);
    let out = swap_cli::engine::decide(&s.alice.file, &noid, &eth, now);
    assert_eq!(out.action.kind(), "refund_noid", "{out:?}");
    assert!(notes_with(&out.notes, "NOT the recorded one").is_empty(), "{:?}", out.notes);
    // A file that saw the recorded instance gone in a poll before D (only Bob's claim closes then) never adopts another instance.
    let mut s = Scenario::new(Variant::Raw);
    s.run_to_lock_final();
    s.tick_alice();
    let mut file = s.alice.file.clone();
    file.log("noid_instance_gone_before_d", s.now());
    s.world.borrow_mut().instance.as_mut().unwrap().creation_id += 2;
    let d = s.public.params.deadline_height;
    set_tip(&s, d - 1);
    let (noid, eth, now) = observe(&s);
    let out = swap_cli::engine::decide(&file, &noid, &eth, now);
    assert_ne!(out.action.kind(), "refund_noid", "{out:?}");
    assert!(notes_with(&out.notes, "NOT the recorded one").is_empty(), "{:?}", out.notes);
}

/// Alice has revealed, the ETH claim is mined (`final_claim`: and final), Bob never claims.
fn alice_after_reveal(final_claim: bool) -> Scenario {
    let mut s = Scenario::new(Variant::Raw);
    s.run_to_lock_final();
    s.tick_alice();
    s.world.borrow_mut().advance_eth(if final_claim { 4 } else { 1 });
    s.bob.executor.offline_for.insert("claim_noid");
    s.tick_alice();
    s
}

const NOT_KNOWN: &str = "whether Bob claimed the recorded instance before D is not known to this file; the instance at the root can be recovered with the wallet";

#[test]
fn m1_after_a_reveal_without_evidence_a_lookalike_is_not_adopted_and_the_note_says_what_is_not_known() {
    for (final_claim, phase) in [(true, "done"), (false, "revealed")] {
        let mut s = alice_after_reveal(final_claim);
        assert_eq!(s.alice_phase(), phase);
        s.world.borrow_mut().instance.as_mut().unwrap().creation_id += 2;
        let d = s.public.params.deadline_height;
        set_tip(&s, d - 1);
        let r = s.tick_alice();
        assert_eq!(r.action.kind(), "wait", "{phase}: {r:?}");
        assert_eq!(s.alice_phase(), phase);
        assert!(r.notes.iter().any(|n| n == NOT_KNOWN), "{phase}: {:?}", r.notes);
        assert!(r.notes.iter().any(|n| n.contains("another one sits at the root")), "{phase}: {:?}", r.notes);
        assert_eq!(s.alice.executor.count("refund_noid"), 0);
        assert!(s.alice.file.history.iter().all(|h| !h.event.starts_with("noid_recovery_adopted:")));
    }
}

/// `done`: Bob claimed the recorded instance before D (the swap completed), Alice did not poll after the claim, and a lookalike of the agreed amount
/// sits at the root at D.
fn alice_done_after_bobs_claim_with_a_lookalike_at_d() -> Scenario {
    let mut s = Scenario::new(Variant::Raw);
    s.run_to_lock_final();
    s.tick_alice();
    s.world.borrow_mut().advance_eth(4);
    s.tick_alice();
    assert_eq!(s.alice_phase(), "done");
    s.tick_bob();
    s.world.borrow_mut().advance_noid(19);
    assert!(s.world.borrow().instance.is_none(), "Bob's claim closed the instance");
    let amount = s.public.params.amount_micronoid;
    s.world.borrow_mut().instances_after.push(NoidInstance { slot_index: 99, creation_id: 500, amount_micronoid: amount });
    let d = s.public.params.deadline_height;
    set_tip(&s, d - 1);
    s
}

#[test]
fn m1_a_done_file_whose_swap_completed_is_never_relabelled_by_a_lookalike_at_d() {
    let mut s = alice_done_after_bobs_claim_with_a_lookalike_at_d();
    let r = s.tick_alice();
    assert_eq!(r.action.kind(), "wait", "{r:?}");
    assert_eq!(s.alice_phase(), "done");
    assert_eq!(s.alice.executor.count("refund_noid"), 0);
    assert!(r.notes.iter().any(|n| n == NOT_KNOWN), "{:?}", r.notes);
    // And it stays so on every later tick.
    let r = s.tick_alice();
    assert_eq!(s.alice_phase(), "done", "{r:?}");
}

#[test]
fn m1_lock_final_with_a_reveal_sent_bobs_refund_won_and_bobs_claim_before_d_gets_the_honest_wait() {
    let (mut s, _txid) = alice_reveal_lost_without_a_poll_before_d();
    let amount = s.public.params.amount_micronoid;
    s.world.borrow_mut().instances_after.push(NoidInstance { slot_index: 99, creation_id: 500, amount_micronoid: amount });
    let r = s.tick_alice();
    assert_eq!(r.action.kind(), "wait", "{r:?}");
    assert_eq!(s.alice_phase(), "lock_final", "{r:?}");
    assert!(r.notes.iter().any(|n| n == NOT_KNOWN), "{:?}", r.notes);
    assert_eq!(s.alice.executor.count("refund_noid"), 0);
    assert!(s.alice.file.history.iter().all(|h| !h.event.starts_with("noid_recovery_adopted:")));
}

#[test]
fn m1_a_close_recorded_before_d_forbids_the_adoption_even_with_the_alive_marker() {
    let mut s = alice_after_reveal(true);
    let now = s.now();
    s.alice.file.log("noid_instance_alive_at_d", now);
    s.alice.file.log("noid_closed_before_deadline", now);
    s.world.borrow_mut().instance.as_mut().unwrap().creation_id += 2;
    let d = s.public.params.deadline_height;
    set_tip(&s, d - 1);
    let (noid, eth, now) = observe(&s);
    let out = swap_cli::engine::decide(&s.alice.file, &noid, &eth, now);
    assert_ne!(out.action.kind(), "refund_noid", "{out:?}");
    assert!(notes_with(&out.notes, "NOT the recorded one").is_empty(), "{:?}", out.notes);
}

#[test]
fn s1_after_a_reveal_there_is_no_adoption_even_with_the_alive_marker_on_record() {
    for (final_claim, phase) in [(true, "done"), (false, "revealed")] {
        let mut s = alice_after_reveal(final_claim);
        assert_eq!(s.alice_phase(), phase);
        let d = s.public.params.deadline_height;
        // The poll at D with the recorded instance still there writes the marker (a pending call holds the recovery close back that tick).
        set_tip(&s, d - 1);
        let r = s.tick_alice_with(pend_everywhere_degrade);
        assert!(r.events.contains(&"noid_instance_alive_at_d".to_string()), "{phase}: {r:?}");
        // The funding then comes back as another incarnation: still not adopted (a one-block reorg at D can have put Bob's claim into a block
        // after the marker was written, so no marker proves he did not claim).
        s.world.borrow_mut().instance.as_mut().unwrap().creation_id += 2;
        let r = s.tick_alice();
        assert_eq!(r.action.kind(), "wait", "{phase}: {r:?}");
        assert_eq!(s.alice_phase(), phase);
        assert!(r.notes.iter().any(|n| n == NOT_KNOWN), "{phase}: {:?}", r.notes);
        assert_eq!(s.alice.executor.count("refund_noid"), 0);
        assert!(s.alice.file.history.iter().all(|h| !h.event.starts_with("noid_recovery_adopted:")));
        assert!(swap_cli::engine::recovery_target(&s.alice.file).is_none());
    }
}

fn pend_everywhere_degrade(noid: &mut NoidObservation, _: &mut EthObservation) {
    let call = swap_cli::watch::PendingCall { txid: TXID.into(), fee_micronoid: 5_800, admitted_height: noid.tip };
    noid.pending_calls = vec![call.clone()];
    if let Some(second) = noid.second.as_mut() {
        second.pending_calls = vec![call];
    }
}

// ================================================================================================ X3

/// Bob in `secret_seen` (his claim is made by hand, so the file tracks none); Alice's ETH claim is held back while `ethfrozen`.
fn bob_secret_seen(ethfrozen: bool) -> Scenario {
    let mut s = Scenario::new(Variant::Raw);
    s.run_to_lock_final();
    s.world.borrow_mut().freeze_eth_claim = ethfrozen;
    s.tick_alice();
    s.bob.executor.offline_for.insert("claim_noid");
    s.tick_bob();
    assert_eq!(s.bob_phase(), "secret_seen");
    if !ethfrozen {
        s.world.borrow_mut().advance_eth(4);
    }
    s
}

const GONE_WAIT: &str = "the instance is gone but no tracked transaction closed it; verify the contract receipts manually (then `tick --closed-by TXID` records it: a close before D paid Bob, one at or after D paid Alice)";

fn operator_reason(txid: &str, height: u64, d: u64) -> String {
    format!("claim branch closed: the operator recorded the close {txid} at height {height} (at or after D {d}, the recovery branch, which pays Alice), so Bob's NOID claim can no longer happen")
}

fn alive_reason(tip: u64, d: u64) -> String {
    format!("claim branch closed: the instance was listed at tip {tip}, when the claim branch had closed (D {d}) and block D - 1 was final, and it is gone now (a recovery close, which pays Alice, took it), so Bob's NOID claim can no longer happen")
}

#[test]
fn x3_a_recovery_close_recorded_with_closed_by_ends_bobs_file_as_aborted_and_a_guess_is_never_made() {
    let mut s = bob_secret_seen(false);
    let d = s.public.params.deadline_height;
    let tip = s.world.borrow().tip;
    s.world.borrow_mut().advance_noid(d - tip);
    // Alice's recovery close lands at a height >= D while Bob was not looking.
    let txid = s.world.borrow_mut().close_outside(true, None);
    let h = s.world.borrow().tip;
    assert!(h >= d);
    // Without evidence of WHEN it closed the file does not guess who was paid: the old wait, with the hint.
    let r = s.tick_bob();
    assert!(matches!(&r.action, Action::Wait { reason } if reason == GONE_WAIT), "{r:?}");
    assert_eq!(s.bob_phase(), "secret_seen");
    // CHAOS M3: the close is not final yet: nothing is recorded.
    let obs = s.world.borrow().noid_obs(Some(&txid));
    let err = swap_cli::engine::external_close_event(&s.bob.file, &obs, &txid).unwrap_err();
    assert!(err.contains("is not final yet") && err.contains("nothing is recorded"), "{err}");
    s.world.borrow_mut().advance_noid(18);
    // Final: the operator records it. A close at or after D pays Alice, so it is no claim of Bob's; the phase does not move.
    let obs = s.world.borrow().noid_obs(Some(&txid));
    let ev = swap_cli::engine::external_close_event(&s.bob.file, &obs, &txid).unwrap();
    assert!(matches!(&ev, swap_cli::state::Event::NoidClosedAfterDeadline { txid: t, height } if *t == txid && *height == h), "{ev:?}");
    let now = s.now();
    s.bob.file.apply(&ev, now).unwrap();
    assert_eq!(s.bob_phase(), "secret_seen");
    assert!(s.bob.file.history.iter().any(|e| e.event == "noid_closed_after_deadline"));
    assert!(s.bob.file.history.iter().any(|e| e.event == format!("noid_closed_after_deadline:{txid}:{h}")));
    // The next tick ends the NOID side with an abort that names its evidence (the ETH leg is final already, so it is recorded at once).
    let r = s.tick_bob();
    assert!(matches!(&r.action, Action::Abort { reason } if *reason == operator_reason(&txid, h, d)), "{r:?}");
    assert_eq!(s.bob_phase(), "aborted");
    // Nothing about a payout to Bob: the NOID went to Alice.
    assert_eq!(s.world.borrow().noid_payout.as_ref().unwrap().0, s.public.params.alice_noid);
}

#[test]
fn x3_an_instance_seen_alive_with_block_d_minus_1_final_that_is_gone_later_ends_the_noid_side_with_its_evidence_named() {
    let mut s = bob_secret_seen(true);
    let d = s.public.params.deadline_height;
    let tip = s.world.borrow().tip;
    // Before block D - 1 is final (tip < D + 17) no marker is written, even with the instance listed and the claim branch closed (CHAOS M2).
    s.world.borrow_mut().advance_noid(d - 1 - tip);
    let r = s.tick_bob();
    assert!(!r.events.contains(&"noid_instance_alive_at_d".to_string()), "{r:?}");
    s.world.borrow_mut().advance_noid(16);
    assert_eq!(s.world.borrow().tip, d + 15);
    let r = s.tick_bob();
    assert!(!r.events.contains(&"noid_instance_alive_at_d".to_string()), "{r:?}");
    s.world.borrow_mut().advance_noid(2);
    assert_eq!(s.world.borrow().tip, d + 17);
    // A second node that is configured must list it too: one that cannot be read, or does not list it, writes nothing.
    let r = s.tick_bob_with(|noid, _| {
        noid.second = None;
        noid.second_error = Some("second node down".into());
    });
    assert!(!r.events.contains(&"noid_instance_alive_at_d".to_string()), "{r:?}");
    let r = s.tick_bob_with(|noid, _| {
        if let Some(second) = noid.second.as_mut() {
            second.instance = None;
            second.instances.clear();
        }
    });
    assert!(!r.events.contains(&"noid_instance_alive_at_d".to_string()), "{r:?}");
    // Both nodes list it at a tip where D - 1 is final: the marker is written, with the tip of that poll.
    let r = s.tick_bob();
    assert!(r.events.contains(&"noid_instance_alive_at_d".to_string()), "{r:?}");
    assert!(s.bob.file.history.iter().any(|h| h.event == format!("noid_alive_at_d_tip:{}", d + 17)));
    assert_eq!(s.bob_phase(), "secret_seen");
    // Alice's recovery close lands; the instance is gone; the evidence names itself. The ETH lock is still open (Alice's claim is held back).
    s.world.borrow_mut().close_outside(true, None);
    let r = s.tick_bob();
    assert_eq!(s.bob_phase(), "secret_seen", "{r:?}");
    assert!(matches!(&r.action, Action::Wait { reason } if reason.starts_with(&alive_reason(d + 17, d)) && reason.contains("the ETH lock is still open")), "{r:?}");
    // The ETH leg settles: now the abort is recorded.
    s.world.borrow_mut().freeze_eth_claim = false;
    s.world.borrow_mut().advance_eth(5);
    let r = s.tick_bob();
    assert!(matches!(&r.action, Action::Abort { reason } if *reason == alive_reason(d + 17, d)), "{r:?}");
    assert_eq!(s.bob_phase(), "aborted");
}

#[test]
fn x3_a_boundary_reorg_cannot_make_the_marker_lie_and_claim_submitted_never_writes_it() {
    // The marker is written only from a poll with D - 1 final, so a one-block reorg at the boundary (which can put Bob's pending claim into block
    // D - 1) happens BEFORE any marker exists: Bob's claim included, his file follows it to `done`, no abort.
    let mut s = Scenario::new(Variant::Raw);
    s.run_to_lock_final();
    s.tick_alice();
    s.world.borrow_mut().advance_eth(4);
    let d = s.public.params.deadline_height;
    let tip = s.world.borrow().tip;
    s.world.borrow_mut().advance_noid(d - 3 - tip);
    let r = s.tick_bob();
    assert_eq!(r.action.kind(), "claim_noid", "{r:?}");
    assert_eq!(s.bob_phase(), "claim_submitted");
    // Poll at D - 1: the claim is still pending (not in a block), the instance is listed, the claim branch is closed for any later inclusion.
    s.world.borrow_mut().freeze_inclusion = true;
    s.world.borrow_mut().advance_noid(2);
    assert_eq!(s.world.borrow().tip, d - 1);
    let r = s.tick_bob();
    assert!(!r.events.contains(&"noid_instance_alive_at_d".to_string()), "claim_submitted writes no marker: {r:?}");
    // (A one-block reorg then lets his claim in at D - 1.) Block D - 1 is not final, so no marker could have been written; the claim is followed.
    s.world.borrow_mut().freeze_inclusion = false;
    s.world.borrow_mut().advance_noid(1);
    let r = s.tick_bob();
    assert!(!r.events.contains(&"noid_instance_alive_at_d".to_string()), "{r:?}");
    assert!(s.bob.file.history.iter().all(|h| h.event != "noid_instance_alive_at_d"));
}

#[test]
fn x3_neighbours_a_close_before_d_is_still_bobs_claim_and_no_evidence_is_still_a_wait() {
    // A close BEFORE D by Bob's own claim made outside the tool: recorded as his claim, as before.
    let s = bob_secret_seen(false);
    let txid = s.world.borrow_mut().close_outside(false, Some(*s.secret.bytes()));
    assert!(s.world.borrow().tip < s.public.params.deadline_height);
    let obs = s.world.borrow().noid_obs(Some(&txid));
    let ev = swap_cli::engine::external_close_event(&s.bob.file, &obs, &txid).unwrap();
    assert!(matches!(ev, swap_cli::state::Event::NoidClosedExternally { .. }), "{ev:?}");
    // The same close, unrecorded, before D: the file waits and never aborts (the instance may have paid Bob).
    let mut s = bob_secret_seen(false);
    s.world.borrow_mut().close_outside(false, Some(*s.secret.bytes()));
    let r = s.tick_bob();
    assert!(matches!(&r.action, Action::Wait { reason } if reason == GONE_WAIT), "{r:?}");
    // A poll at D with the instance still there is the old abort (claim branch closed), unchanged by the marker.
    let mut s = bob_secret_seen(false);
    let d = s.public.params.deadline_height;
    let tip = s.world.borrow().tip;
    s.world.borrow_mut().advance_noid(d - 1 - tip);
    let r = s.tick_bob();
    assert!(matches!(&r.action, Action::Abort { reason } if reason.starts_with("claim branch closed: next call height")), "{r:?}");
}

/// Alice at `lock_final` with a reveal on record (the CLI path's decided intent), Bob's ETH refund final, and a close by Bob's claim at a height
/// BELOW D that no poll of Alice's saw (she did not tick). The tip is then `D + B_FINAL`. Returns the scenario and the close's txid.
fn alice_reveal_lost_without_a_poll_before_d() -> (Scenario, String) {
    let mut s = Scenario::new(Variant::Raw);
    s.run_to_lock_final();
    let t_reveal = s.world.borrow().lock.as_ref().unwrap().timelock;
    s.world.borrow_mut().warp_eth_to(t_reveal);
    s.tick_bob();
    s.world.borrow_mut().advance_eth(1);
    s.tick_bob();
    let lag = s.world.borrow().finality_lag;
    s.world.borrow_mut().advance_eth(lag);
    s.tick_bob();
    assert_eq!(s.bob_phase(), "refunded");
    let now = s.now();
    s.alice.file.log("intent_decided:reveal_eth", now);
    // Bob's claim (it needs the secret; the world does not care how he got it) lands below D.
    let txid = s.world.borrow_mut().close_outside(false, Some(*s.secret.bytes()));
    let d = s.public.params.deadline_height;
    assert!(s.world.borrow().tip < d);
    let tip = s.world.borrow().tip;
    s.world.borrow_mut().advance_noid(d + swap_cli::params::B_FINAL - tip);
    (s, txid)
}

#[test]
fn x3_alice_with_a_reveal_on_record_ends_lost_when_the_operator_records_a_close_before_d() {
    let (mut s, txid) = alice_reveal_lost_without_a_poll_before_d();
    // Her first poll is after D: the file cannot tell Bob's claim from her own recovery and does not guess (CHAOS F-18).
    let r = s.tick_alice();
    assert_eq!(s.alice_phase(), "lock_final", "{r:?}");
    assert!(r.notes.iter().any(|n| n.contains("no poll made before D ever saw it gone")), "{r:?}");
    // The operator records the close: included before D, so it paid Bob. Log-only; the phase does not move.
    let obs = s.world.borrow().noid_obs(Some(&txid));
    let ev = swap_cli::engine::external_close_event(&s.alice.file, &obs, &txid).unwrap();
    assert!(matches!(&ev, swap_cli::state::Event::NoidClosedBeforeDeadline { .. }), "{ev:?}");
    let now = s.now();
    s.alice.file.apply(&ev, now).unwrap();
    assert_eq!(s.alice_phase(), "lock_final");
    assert!(s.alice.file.history.iter().any(|h| h.event == "noid_closed_before_deadline"));
    assert!(s.alice.file.history.iter().any(|h| h.event.starts_with(&format!("noid_closed_before_deadline:{txid}:"))));
    // The next tick: both legs lost, a true terminal state (the NOID went to Bob, the ETH went back to Bob).
    let r = s.tick_alice();
    assert!(r.events.contains(&"both_legs_lost".to_string()), "{r:?}");
    assert_eq!(s.alice_phase(), "lost");
    assert_eq!(s.world.borrow().noid_payout.as_ref().unwrap().0, s.public.params.bob_noid);
}

#[test]
fn x3_alice_neighbours_no_reveal_on_record_or_a_close_at_d_are_unchanged() {
    // No reveal on record in `lock_final`: a close before D is still refused (nobody can have claimed without the secret).
    let (mut s, txid) = alice_reveal_lost_without_a_poll_before_d();
    s.alice.file.history.retain(|h| h.event != "intent_decided:reveal_eth");
    let obs = s.world.borrow().noid_obs(Some(&txid));
    let err = swap_cli::engine::external_close_event(&s.alice.file, &obs, &txid).unwrap_err();
    assert!(err.contains("before the deadline") && err.contains("pays Bob"), "{err}");
    // A close at or after D is Alice's recovery, as before (an `NoidClosedExternally`, then the refund phases).
    let mut s = Scenario::new(Variant::Raw);
    s.run_to_lock_final();
    s.tick_alice();
    let d = s.public.params.deadline_height;
    let tip = s.world.borrow().tip;
    s.world.borrow_mut().advance_noid(d - 1 - tip);
    let txid = s.world.borrow_mut().close_outside(true, None);
    let obs = s.world.borrow().noid_obs(Some(&txid));
    let ev = swap_cli::engine::external_close_event(&s.alice.file, &obs, &txid).unwrap();
    assert!(matches!(ev, swap_cli::state::Event::NoidClosedExternally { .. }), "{ev:?}");
}

// ================================================================================================ X4

/// Bob's lock is mined (his file is `locked`), not yet final on Ethereum.
fn bob_locked_not_final() -> Scenario {
    let mut s = Scenario::new(Variant::Raw);
    s.tick_alice();
    s.world.borrow_mut().advance_noid(1);
    s.tick_both();
    s.world.borrow_mut().advance_noid(18);
    s.tick_both();
    s.world.borrow_mut().advance_eth(1);
    s.tick_both();
    assert_eq!(s.bob_phase(), "locked");
    let w = s.world.borrow();
    let l = w.lock.as_ref().unwrap();
    assert!(l.block_number > w.eth_block.saturating_sub(w.finality_lag), "the lock is not final yet");
    drop(w);
    s
}

/// A reorg drops the lock for good: the contract no longer knows it.
fn drop_the_lock(s: &Scenario) -> swap_cli::watch::EthLock {
    let mut w = s.world.borrow_mut();
    w.lock_count = w.lock_count.saturating_sub(1);
    w.lock.take().unwrap()
}

fn t_reveal_of(l: &swap_cli::watch::EthLock) -> u64 {
    l.timelock
}

fn gone_abort_reason(s: &Scenario, l: &swap_cli::watch::EthLock) -> String {
    format!(
        "the ETH lock 0x{}.. (recorded in block {}) is not on the chain on any node asked, and chain time is past T_reveal {} by the finality time {} s: a lock can no longer be created or claimed, so nothing of Bob's is locked and no secret can be published against it",
        hex::encode(&l.lock_id[..4]),
        l.block_number,
        l.timelock,
        s.gates().eth_finality_s
    )
}

#[test]
fn x4_a_lock_missing_before_t_reveal_is_not_gone_and_the_file_says_why_it_waits() {
    let mut s = bob_locked_not_final();
    let l = drop_the_lock(&s);
    let r = s.tick_bob();
    assert_eq!(s.bob_phase(), "locked", "{r:?}");
    assert!(matches!(&r.action, Action::Wait { reason } if reason == "waiting for the secret (or T_reveal)"), "{r:?}");
    assert!(
        r.notes.iter().any(|n| n.starts_with("the ETH lock is not visible in this poll (the contract shows no such lock): it could still land or come back until T_reveal")),
        "{:?}",
        r.notes
    );
    // It comes back (the transaction was mined again): the file is exactly as before, no note.
    s.world.borrow_mut().lock = Some(l);
    s.world.borrow_mut().lock_count += 1;
    let r = s.tick_bob();
    assert_eq!(s.bob_phase(), "locked", "{r:?}");
    assert!(notes_with(&r.notes, "not visible in this poll").is_empty(), "{:?}", r.notes);
}

#[test]
fn x4_past_t_reveal_and_the_finality_time_a_lock_that_is_not_on_the_chain_ends_the_file_as_aborted() {
    let mut s = bob_locked_not_final();
    let l = drop_the_lock(&s);
    let gate = t_reveal_of(&l) + s.gates().eth_finality_s;
    // One second short of the gate: still waiting.
    s.world.borrow_mut().warp_eth_to(gate - 1);
    let r = s.tick_bob();
    assert_eq!(s.bob_phase(), "locked", "{r:?}");
    assert!(r.notes.iter().any(|n| n.contains("it could still land or come back until T_reveal")), "{:?}", r.notes);
    // At the gate (the head block's time): the contract can no longer take this lock.
    s.world.borrow_mut().warp_eth_to(gate + 12);
    let r = s.tick_bob();
    assert!(matches!(&r.action, Action::Abort { reason } if *reason == gone_abort_reason(&s, &l)), "{r:?}");
    assert_eq!(s.bob_phase(), "aborted");
    assert_eq!(s.bob.executor.count("refund_eth"), 0);
}

#[test]
fn x4_neighbours_a_lock_that_is_there_a_second_node_that_shows_it_or_cannot_be_read_never_end_the_file() {
    // The lock is there (visible, open) far past T_reveal: refund_eth, as before.
    let mut s = bob_locked_not_final();
    let t = t_reveal_of(s.world.borrow().lock.as_ref().unwrap());
    s.world.borrow_mut().warp_eth_to(t + 60);
    let r = s.tick_bob();
    assert_eq!(r.action.kind(), "refund_eth", "{r:?}");
    // Past the gate, but the second node still shows the lock: no abort. Or it cannot be read: no abort.
    let mut s = bob_locked_not_final();
    let l = drop_the_lock(&s);
    s.world.borrow_mut().warp_eth_to(t_reveal_of(&l) + s.gates().eth_finality_s + 60);
    let shown = l.clone();
    let r = s.tick_bob_with(|_, eth| {
        let second = eth.second.as_mut().expect("the simulator attaches a second node");
        second.lock = Some(shown.clone());
        second.locks = vec![shown.clone()];
    });
    assert_eq!(s.bob_phase(), "locked", "{r:?}");
    assert!(r.notes.iter().any(|n| n.contains("the second Ethereum node shows it")), "{:?}", r.notes);
    let r = s.tick_bob_with(|_, eth| {
        eth.second = None;
        eth.second_error = Some("second node down".into());
    });
    assert_eq!(s.bob_phase(), "locked", "{r:?}");
    assert!(r.notes.iter().any(|n| n.contains("the second Ethereum node could not be read")), "{:?}", r.notes);
    // And with both nodes showing nothing it ends.
    let r = s.tick_bob();
    assert_eq!(s.bob_phase(), "aborted", "{r:?}");
}

#[test]
fn x4_a_node_on_another_chain_or_with_other_code_or_a_second_node_that_is_wrong_never_ends_the_file() {
    let mut s = bob_locked_not_final();
    let l = drop_the_lock(&s);
    s.world.borrow_mut().warp_eth_to(t_reveal_of(&l) + s.gates().eth_finality_s + 60);
    // The first node answers from another chain / another contract: "no such lock" proves nothing.
    let r = s.tick_bob_with(|_, eth| eth.chain_id = Some(1));
    assert_eq!(s.bob_phase(), "locked", "{r:?}");
    assert!(r.notes.iter().any(|n| n.contains("the first Ethereum node is on chain 1")), "{:?}", r.notes);
    let r = s.tick_bob_with(|_, eth| eth.chain_id = None);
    assert_eq!(s.bob_phase(), "locked", "{r:?}");
    assert!(r.notes.iter().any(|n| n.contains("the first Ethereum node's chain id is unknown")), "{:?}", r.notes);
    let r = s.tick_bob_with(|_, eth| eth.contract_code_hash = Some([9; 32]));
    assert_eq!(s.bob_phase(), "locked", "{r:?}");
    assert!(r.notes.iter().any(|n| n.contains("shows other code at the contract address than the pinned one")), "{:?}", r.notes);
    let r = s.tick_bob_with(|_, eth| eth.contract_code_hash = None);
    assert_eq!(s.bob_phase(), "locked", "{r:?}");
    assert!(r.notes.iter().any(|n| n.contains("contract code hash is unknown")), "{:?}", r.notes);
    // The second node is on another chain, or has other code.
    let r = s.tick_bob_with(|_, eth| eth.second.as_mut().expect("second node").chain_id = Some(5));
    assert_eq!(s.bob_phase(), "locked", "{r:?}");
    assert!(r.notes.iter().any(|n| n.contains("the second Ethereum node is on chain 5")), "{:?}", r.notes);
    let r = s.tick_bob_with(|_, eth| eth.second.as_mut().expect("second node").contract_code_hash = Some([7; 32]));
    assert_eq!(s.bob_phase(), "locked", "{r:?}");
    // Everything as pinned: it ends.
    let r = s.tick_bob();
    assert_eq!(s.bob_phase(), "aborted", "{r:?}");
}

#[test]
fn x4_the_finalized_blocks_time_holds_the_abort_back_and_production_requires_it() {
    // m6: where the node reports the finalized block's time, it must have reached T_reveal.
    let mut s = bob_locked_not_final();
    let l = drop_the_lock(&s);
    let t = t_reveal_of(&l);
    s.world.borrow_mut().warp_eth_to(t + s.gates().eth_finality_s + 60);
    let r = s.tick_bob_with(|_, eth| eth.finalized_timestamp = Some(t - 1));
    assert_eq!(s.bob_phase(), "locked", "{r:?}");
    assert!(r.notes.iter().any(|n| n.contains("the finalized block's time on the first Ethereum node") && n.contains("has not reached T_reveal")), "{:?}", r.notes);
    let r = s.tick_bob_with(|_, eth| eth.finalized_timestamp = Some(t));
    assert_eq!(s.bob_phase(), "aborted", "{r:?}");
}

#[test]
fn x4_under_production_the_finalized_blocks_time_must_be_reported() {
    let mut s = Scenario::with_profile(Variant::Raw, ProfileName::Production);
    s.tick_alice();
    s.world.borrow_mut().advance_noid(1);
    s.tick_both();
    s.world.borrow_mut().advance_noid(18);
    s.tick_both();
    s.world.borrow_mut().advance_eth(1);
    s.tick_both();
    assert_eq!(s.bob_phase(), "locked");
    let l = drop_the_lock(&s);
    s.world.borrow_mut().finalized_time_reported = false;
    s.world.borrow_mut().warp_eth_to(t_reveal_of(&l) + s.gates().eth_finality_s + 60);
    let r = s.tick_bob();
    assert_eq!(s.bob_phase(), "locked", "{r:?}");
    assert!(r.notes.iter().any(|n| n.contains("does not report the finalized block's time")), "{:?}", r.notes);
    s.world.borrow_mut().finalized_time_reported = true;
    let r = s.tick_bob();
    assert_eq!(s.bob_phase(), "aborted", "{r:?}");
}

/// A second lock of Bob's sender to Alice's receiver on this lock word (a copy of the dropped one under another id), listed besides it.
fn another_lock_of_bobs(s: &Scenario, l: &swap_cli::watch::EthLock, id: u8) {
    let mut other = l.clone();
    other.lock_id = [id; 32];
    s.world.borrow_mut().locks_after.push(other);
}

#[test]
fn s2_another_lock_of_bobs_open_blocks_the_abort_and_its_t_reveal_passed_raises_an_alarm_naming_it() {
    let mut s = bob_locked_not_final();
    let l = drop_the_lock(&s);
    let t = t_reveal_of(&l);
    // The other lock's own T_reveal is later than the swap lock's: open, not yet refundable.
    another_lock_of_bobs(&s, &l, 0xee);
    s.world.borrow_mut().locks_after[0].timelock = t + 100_000;
    s.world.borrow_mut().warp_eth_to(t + s.gates().eth_finality_s + 60);
    let r = s.tick_bob();
    assert_eq!(s.bob_phase(), "locked", "{r:?}");
    assert!(r.notes.iter().any(|n| n.contains("lists another open lock of Bob's on this swap's lock word (0xeeeeeeee..), so ETH may still be locked")), "{:?}", r.notes);
    assert!(notes_with(&r.notes, "ALARM").is_empty(), "{:?}", r.notes);
    // Its own T_reveal has passed: an alarm that names it and says what is possible (a statement; the tool offers no action).
    s.world.borrow_mut().locks_after[0].timelock = t + 10;
    let r = s.tick_bob();
    assert_eq!(s.bob_phase(), "locked", "{r:?}");
    assert!(
        r.notes.iter().any(|n| n.starts_with("ALARM: another lock of Bob's on this lock word (0xeeeeeeee..) is still open on the first Ethereum node and its T_reveal")
            && n.contains("it can be refunded by hand with `live.js refund`")),
        "{:?}",
        r.notes
    );
    // REFUNDED: closed, it counts for nothing: the file ends.
    s.world.borrow_mut().locks_after[0].refunded = true;
    let r = s.tick_bob();
    assert_eq!(s.bob_phase(), "aborted", "{r:?}");
}

#[test]
fn s2_a_lock_that_is_not_bobs_to_alice_on_this_lock_word_is_not_counted() {
    for what in ["sender", "receiver", "hashlock"] {
        let mut s = bob_locked_not_final();
        let l = drop_the_lock(&s);
        s.world.borrow_mut().warp_eth_to(t_reveal_of(&l) + s.gates().eth_finality_s + 60);
        another_lock_of_bobs(&s, &l, 0xdd);
        match what {
            "sender" => s.world.borrow_mut().locks_after[0].sender = [0x55; 20],
            "receiver" => s.world.borrow_mut().locks_after[0].receiver = [0x66; 20],
            _ => s.world.borrow_mut().locks_after[0].hashlock = [0x77; 32],
        }
        let r = s.tick_bob();
        assert_eq!(s.bob_phase(), "aborted", "a lock with another {what} is no lock of Bob's on this lock word: {r:?}");
    }
}

#[test]
fn s2_a_claimed_other_lock_means_the_secret_is_public_and_is_never_gone_for_good() {
    // (b) the preimage is not in the observation: not yet, with an ALARM that names what it means.
    let mut s = bob_locked_not_final();
    let l = drop_the_lock(&s);
    s.world.borrow_mut().warp_eth_to(t_reveal_of(&l) + s.gates().eth_finality_s + 60);
    another_lock_of_bobs(&s, &l, 0xcc);
    s.world.borrow_mut().locks_after[0].claimed = true;
    let r = s.tick_bob();
    assert_eq!(s.bob_phase(), "locked", "{r:?}");
    assert!(
        r.notes.iter().any(|n| n.starts_with("ALARM: another lock of Bob's on this lock word (0xcccccccc..) was CLAIMED (on the first Ethereum node), so the secret is public")
            && n.contains("claim the NOID before D")),
        "{:?}",
        r.notes
    );
    // The observation carries that claim (the watcher reads it): Bob's file reads the preimage, verifies it like any candidate, and moves to
    // `secret_seen`, from which the NOID claim is offered.
    let secret = *s.secret.bytes();
    let r = s.tick_bob_with(|_, eth| {
        eth.other_claims = vec![swap_cli::watch::EthClaimed { lock_id: [0xcc; 32], preimage: secret, block_number: 1, tx_hash: [3; 32] }];
    });
    assert!(r.events.contains(&"eth_preimage_seen".to_string()), "{r:?}");
    assert_eq!(r.action.kind(), "claim_noid", "{r:?}");
    assert!(r.notes.iter().any(|n| n.contains("read from a CLAIMED lock of Bob's other than the one in this file")), "{:?}", r.notes);
    // A wrong preimage on that claim is rejected like any other candidate: Bob stays where he is.
    let mut s = bob_locked_not_final();
    let l = drop_the_lock(&s);
    s.world.borrow_mut().warp_eth_to(t_reveal_of(&l) + s.gates().eth_finality_s + 60);
    another_lock_of_bobs(&s, &l, 0xcb);
    s.world.borrow_mut().locks_after[0].claimed = true;
    let r = s.tick_bob_with(|_, eth| {
        eth.other_claims = vec![swap_cli::watch::EthClaimed { lock_id: [0xcb; 32], preimage: [9; 32], block_number: 1, tx_hash: [3; 32] }];
    });
    assert_eq!(s.bob_phase(), "locked", "{r:?}");
    assert!(r.notes.iter().any(|n| n.starts_with("preimage seen but rejected")), "{:?}", r.notes);
}

#[test]
fn x4_exactly_at_the_gate_it_ends_and_a_lagging_head_never_does() {
    let mut s = bob_locked_not_final();
    let l = drop_the_lock(&s);
    let gate = t_reveal_of(&l) + s.gates().eth_finality_s;
    // A head that lags far behind (its block time is below the gate although the clock is past it): not yet.
    s.world.borrow_mut().warp_eth_to(gate + 600);
    s.world.borrow_mut().eth_head_lag = 5_000;
    let r = s.tick_bob();
    assert_eq!(s.bob_phase(), "locked", "{r:?}");
    assert!(!matches!(r.action, Action::Abort { .. }), "{r:?}");
    // The head is level again and its block time is EXACTLY the gate: it ends.
    s.world.borrow_mut().eth_head_lag = 0;
    s.world.borrow_mut().eth_time = gate - 12;
    s.world.borrow_mut().advance_eth(1);
    assert_eq!(s.world.borrow().eth_obs().latest_timestamp, gate);
    let r = s.tick_bob();
    assert!(matches!(r.action, Action::Abort { .. }), "{r:?}");
    assert_eq!(s.bob_phase(), "aborted");
}

#[test]
fn x4_a_pending_refund_eth_intent_is_resolved_by_the_abort_from_locked() {
    // Command-line path (`tick --apply`): the refund is decided and recorded while the lock is still listed past T_reveal; then the lock turns out to be
    // gone for good. The ledger resolves the intent at the abort (CHAOS m11): the abort and the intent do not end up contradicting each other.
    let s = bob_locked_not_final();
    let t = t_reveal_of(s.world.borrow().lock.as_ref().unwrap());
    let gate = t + s.gates().eth_finality_s;
    s.world.borrow_mut().warp_eth_to(gate + 60);
    let mut file = s.bob.file.clone();
    let (noid, eth, now) = observe(&s);
    let out = tick_apply(&mut file, &noid, &eth, now, true).unwrap();
    assert_eq!(out.decision.action.kind(), "refund_eth", "{:?}", out.decision);
    assert!(file.pending_intent.as_ref().is_some_and(|i| i.action == "refund_eth"));
    drop_the_lock(&s);
    let (noid, eth, now) = observe(&s);
    let out = tick_apply(&mut file, &noid, &eth, now + 30, true).unwrap();
    assert!(matches!(out.decision.action, Action::Abort { .. }), "{:?}", out.decision);
    assert_eq!(file.phase.name(), "aborted");
    assert!(file.pending_intent.is_none());
    assert!(file.history.iter().any(|h| h.event == "intent_resolved:refund_eth"));
    assert!(matches!(out.intent, swap_cli::engine::IntentStatus::Resolved(_)), "{:?}", out.intent);
    assert!(out.decision.notes.iter().any(|n| n.starts_with("the pending refund_eth intent is resolved")), "{:?}", out.decision.notes);
}

#[test]
fn x3_command_line_path_bob_after_d_records_the_close_with_apply_and_the_next_tick_aborts() {
    // The order the binary uses for `tick --closed-by TXID --apply`: the event is applied to the file, then `tick_apply` decides and records.
    let s = bob_secret_seen(false);
    let d = s.public.params.deadline_height;
    let tip = s.world.borrow().tip;
    s.world.borrow_mut().advance_noid(d - tip);
    let txid = s.world.borrow_mut().close_outside(true, None);
    let h = s.world.borrow().tip;
    s.world.borrow_mut().advance_noid(18);
    let mut file = s.bob.file.clone();
    let obs = s.world.borrow().noid_obs(Some(&txid));
    let ev = swap_cli::engine::external_close_event(&file, &obs, &txid).unwrap();
    file.apply(&ev, s.now()).unwrap();
    let (noid, eth, now) = observe(&s);
    let out = tick_apply(&mut file, &noid, &eth, now, true).unwrap();
    assert!(matches!(&out.decision.action, Action::Abort { reason } if *reason == operator_reason(&txid, h, d)), "{:?}", out.decision);
    assert_eq!(file.phase.name(), "aborted");
    // A read-only tick (`record == false`) records nothing.
    let mut again = s.bob.file.clone();
    again.apply(&ev, s.now()).unwrap();
    let out = tick_apply(&mut again, &noid, &eth, now, false).unwrap();
    assert!(matches!(out.decision.action, Action::Abort { .. }));
    assert_eq!(again.phase.name(), "secret_seen");
}

// ================================================================================================ S3

#[test]
fn s3_a_second_node_that_lists_the_recorded_instance_or_cannot_be_read_blocks_the_adoption() {
    let (s, recorded) = alice_funding_final_and_a_new_incarnation();
    let d = s.public.params.deadline_height;
    set_tip(&s, d - 1);
    let file = s.alice.file.clone();
    // The second node still lists the RECORDED instance (the first one shows the new incarnation only): the first node's word is not enough.
    let (noid, eth, now) = observe(&s);
    let mut noid_listed = noid.clone();
    let rec = NoidInstance { slot_index: 7, creation_id: recorded, amount_micronoid: s.public.params.amount_micronoid };
    if let Some(second) = noid_listed.second.as_mut() {
        second.instance = Some(rec.clone());
        second.instances.clear();
    }
    let out = swap_cli::engine::decide(&file, &noid_listed, &eth, now);
    assert_ne!(out.action.kind(), "refund_noid", "{out:?}");
    assert!(notes_with(&out.notes, "NOT the recorded one").is_empty(), "{:?}", out.notes);
    // A second node that could not be read: no adoption, and the note says why.
    let mut down = noid.clone();
    down.second = None;
    down.second_error = Some("second node down".into());
    let out = swap_cli::engine::decide(&file, &down, &eth, now);
    assert_ne!(out.action.kind(), "refund_noid", "{out:?}");
    assert!(
        out.notes.iter().any(|n| n.starts_with("a recovery close for another instance of the agreed amount at the root is not offered: the second node could not be read (second node down)")),
        "{:?}",
        out.notes
    );
    // A stale second node: the same.
    let mut stale = noid.clone();
    if let Some(second) = stale.second.as_mut() {
        second.observed_at = Some(now.saturating_sub(10_000));
    }
    let out = swap_cli::engine::decide(&file, &stale, &eth, now);
    assert_ne!(out.action.kind(), "refund_noid", "{out:?}");
    assert!(notes_with(&out.notes, "is not offered:").len() == 1, "{:?}", out.notes);
    // Both nodes agree the recorded instance is gone: adopted (as before).
    let out = swap_cli::engine::decide(&file, &noid, &eth, now);
    assert_eq!(out.action.kind(), "refund_noid", "{out:?}");
}

#[test]
fn s3_when_the_recorded_instance_comes_back_the_adoption_label_is_reset_and_a_final_adopted_close_does_not_make_the_file_refunded_while_it_is_listed() {
    let mut s = Scenario::new(Variant::Raw);
    s.tick_alice();
    s.world.borrow_mut().advance_noid(1);
    s.tick_both();
    s.world.borrow_mut().advance_noid(18);
    s.tick_alice();
    assert_eq!(s.alice_phase(), "funding_final");
    let rec = s.world.borrow().instance.clone().unwrap();
    let d = s.public.params.deadline_height;
    // The funding is another incarnation at D: the recovery close is adopted and sent.
    s.world.borrow_mut().instance.as_mut().unwrap().creation_id += 2;
    set_tip(&s, d - 1);
    let r = s.tick_alice();
    assert_eq!(r.action.kind(), "refund_noid", "{r:?}");
    assert!(swap_cli::engine::recovery_target(&s.alice.file).is_some());
    s.world.borrow_mut().advance_noid(1);
    let r = s.tick_alice();
    assert_eq!(s.alice_phase(), "refund_included", "{r:?}");
    // The recorded instance is listed AGAIN (a reorg gave it back, or it was funded behind the file's back): the final adopted close must not end
    // the file as `refunded`.
    s.world.borrow_mut().instance = Some(rec.clone());
    s.world.borrow_mut().advance_noid(18);
    let r = s.tick_alice();
    assert_ne!(s.alice_phase(), "refunded", "{r:?}");
    assert!(
        r.notes.iter().any(|n| n.contains("took another instance than the one this file recorded, and the recorded instance (slot 7, creation 1) is at the contract again: its recovery is due; the file is not `refunded`")),
        "{:?}",
        r.notes
    );
    // The file went back to waiting for its recovery (the event of a dropped close) and, in the same tick, the normal path offers the recovery close for
    // the RECORDED instance, and the label is reset.
    assert!(r.events.contains(&"noid_tx_reorged".to_string()), "{r:?}");
    assert_eq!(r.action.kind(), "refund_noid", "{r:?}");
    assert_eq!(s.alice_phase(), "refund_submitted", "{r:?}");
    assert!(notes_with(&r.notes, "NOT the recorded one").is_empty(), "{:?}", r.notes);
    assert!(swap_cli::engine::recovery_target(&s.alice.file).is_none(), "the reset entry is the last one");
    assert!(s.alice.file.history.iter().any(|h| h.event == "noid_recovery_adopted:recorded"));
    s.world.borrow_mut().advance_noid(1);
    s.tick_alice();
    s.world.borrow_mut().advance_noid(18);
    let r = s.tick_alice();
    assert_eq!(s.alice_phase(), "refunded", "{r:?}");
    assert!(matches!(&r.action, Action::Wait { reason } if !reason.contains("the instance recovered was not the one this file recorded") && !reason.contains("than the one this file recorded")), "{r:?}");
}

#[test]
fn s3_an_adopted_close_that_is_final_with_the_recorded_instance_gone_ends_refunded_with_a_text_that_is_true_for_it() {
    let (mut s, recorded) = alice_funding_final_and_a_new_incarnation();
    let d = s.public.params.deadline_height;
    set_tip(&s, d - 1);
    s.tick_alice();
    s.world.borrow_mut().advance_noid(1);
    s.tick_alice();
    s.world.borrow_mut().advance_noid(18);
    let r = s.tick_alice();
    assert_eq!(s.alice_phase(), "refunded", "{r:?}");
    assert!(
        matches!(&r.action, Action::Wait { reason } if *reason == format!("done: NOID refunded; the recovery close took another instance of the agreed amount (slot 7, creation {}) than the one this file recorded, which this file never saw closed", recorded + 2)),
        "{r:?}"
    );
}

#[test]
fn s3_a_final_adopted_close_with_a_second_node_that_cannot_confirm_keeps_the_file_open() {
    let (mut s, _) = alice_funding_final_and_a_new_incarnation();
    let d = s.public.params.deadline_height;
    set_tip(&s, d - 1);
    s.tick_alice();
    s.world.borrow_mut().advance_noid(1);
    s.tick_alice();
    s.world.borrow_mut().advance_noid(18);
    let r = s.tick_alice_with(|noid, _| {
        noid.second = None;
        noid.second_error = Some("second node down".into());
    });
    assert_eq!(s.alice_phase(), "refund_included", "{r:?}");
    assert!(r.notes.iter().any(|n| n.contains("is final but the file stays open: the second node could not be read")), "{:?}", r.notes);
}

#[test]
fn s3_closed_by_needs_the_second_node_to_see_the_close_final_too() {
    let s = bob_secret_seen(false);
    let d = s.public.params.deadline_height;
    let tip = s.world.borrow().tip;
    s.world.borrow_mut().advance_noid(d - tip);
    let txid = s.world.borrow_mut().close_outside(true, None);
    s.world.borrow_mut().advance_noid(18);
    let obs = s.world.borrow().noid_obs(Some(&txid));
    // The second node lags: its tip is below the final height.
    let mut lag = obs.clone();
    if let Some(second) = lag.second.as_mut() {
        second.tip -= 10;
    }
    let err = swap_cli::engine::external_close_event(&s.bob.file, &lag, &txid).unwrap_err();
    assert!(err.contains("the second node's tip") && err.contains("must see it final too"), "{err}");
    let mut down = obs.clone();
    down.second = None;
    down.second_error = Some("second node down".into());
    let err = swap_cli::engine::external_close_event(&s.bob.file, &down, &txid).unwrap_err();
    assert!(err.contains("the second node could not be read"), "{err}");
    assert!(swap_cli::engine::external_close_event(&s.bob.file, &obs, &txid).is_ok());
}
