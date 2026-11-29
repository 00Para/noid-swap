//! Four corner cases in which the tool's decision is different from before, each pinned together with the neighbouring normal case that must
//! stay as it was:
//!
//! - REVIEW-7 R7-4: the poseidon pre-lock scan with a second Ethereum node that was configured and could not be read (wait, never a scan on one node);
//! - CHAOS F-14: a call on the contract that is pending in the mempool holds `refund_noid` back (a recovery close that a reorg put back);
//! - CHAOS F-10: Bob's "more than one instance fits" wait gives way to the give-up heights;
//! - the held `reveal_eth` intent whose cutoff has passed, beside a `refund_noid` that is due.
//!
//! The G1 note and the margin wording are in `hostile_gaps.rs` and `notes_only.rs`.

mod common;

use common::*;
use swap_cli::engine::{tick_apply, Action, ETH_TX_GRACE_S};
use swap_cli::params::{ContractVersion, ProfileName};
use swap_cli::secret::{LockKind, Variant};
use swap_cli::watch::{EthObservation, NoidInstance, NoidObservation, PendingCall};

fn observe(s: &Scenario) -> (NoidObservation, EthObservation, u64) {
    let w = s.world.borrow();
    (w.noid_obs(None), w.eth_obs(), w.eth_time)
}

fn wait_reason(a: &Action) -> &str {
    match a {
        Action::Wait { reason } => reason,
        other => panic!("not a wait: {other:?}"),
    }
}

fn notes_with<'a>(notes: &'a [String], needle: &str) -> Vec<&'a String> {
    notes.iter().filter(|n| n.contains(needle)).collect()
}

// ================================================================================================ R7-4

/// Bob's funding is final and the next tick would lock (the self-test of client R is in the file).
fn bob_ready(kind: LockKind) -> Scenario {
    let mut s = Scenario::with_kind(Variant::Raw, ProfileName::Production, ContractVersion::V1, kind);
    s.tick_alice();
    s.world.borrow_mut().advance_noid(1);
    s.tick_both();
    s.world.borrow_mut().advance_noid(18);
    s
}

const SECOND_DOWN: &str = "eth watcher (second node): connection refused";

fn second_down(_: &mut NoidObservation, eth: &mut EthObservation) {
    eth.second = None;
    eth.second_error = Some(SECOND_DOWN.into());
}

#[test]
fn r7_4_a_failed_second_ethereum_node_holds_the_poseidon_lock_back_and_records_no_intent() {
    let s = bob_ready(LockKind::Poseidon);
    // The command-line path: nothing is decided, nothing is recorded.
    let (noid, mut eth, now) = observe(&s);
    eth.second = None;
    eth.second_error = Some(SECOND_DOWN.into());
    let mut file = s.bob.file.clone();
    let out = tick_apply(&mut file, &noid, &eth, now, true).unwrap();
    assert_eq!(
        wait_reason(&out.decision.action),
        format!("the second Ethereum node could not be read ({SECOND_DOWN}): it must agree before this step (F5)")
    );
    assert!(out.decision.notes.iter().any(|n| n.starts_with("not lock_eth: the second Ethereum node could not be read")), "{:?}", out.decision.notes);
    assert!(file.pending_intent.is_none(), "{:?}", file.pending_intent);
    assert!(file.history.iter().all(|h| h.event != "intent_decided:lock_eth"));
    assert!(matches!(out.intent, swap_cli::engine::IntentStatus::None), "{:?}", out.intent);
    // The library path: the same wait, nothing sent.
    let mut s = bob_ready(LockKind::Poseidon);
    let r = s.tick_bob_with(second_down);
    assert_eq!(r.action.kind(), "wait", "{r:?}");
    assert!(wait_reason(&r.action).contains("the second Ethereum node could not be read"), "{r:?}");
    assert!(s.world.borrow().lock_pending.is_none());
    assert_eq!(s.bob.executor.count("lock_eth"), 0);
    // The second node comes back: the lock is offered, as before.
    let r = s.tick_bob();
    assert_eq!(r.action.kind(), "lock_eth", "{r:?}");
}

#[test]
fn r7_4_with_a_second_node_that_answers_or_with_no_second_node_the_lock_is_offered_as_before() {
    // A second Ethereum node that answers (the simulator attaches one): the lock is offered and the intent is recorded.
    let s = bob_ready(LockKind::Poseidon);
    let (noid, eth, now) = observe(&s);
    assert!(eth.second.is_some() && eth.second_error.is_none());
    let mut file = s.bob.file.clone();
    let out = tick_apply(&mut file, &noid, &eth, now, true).unwrap();
    assert_eq!(out.decision.action.kind(), "lock_eth", "{:?}", out.decision);
    assert!(file.pending_intent.as_ref().is_some_and(|i| i.action == "lock_eth"));
    // No second Ethereum node configured (the single-node mode): nothing about the second node is said and the lock is offered.
    let (noid, mut eth, now) = observe(&s);
    eth.second = None;
    assert!(eth.second_error.is_none());
    let mut file = s.bob.file.clone();
    let out = tick_apply(&mut file, &noid, &eth, now, true).unwrap();
    assert_eq!(out.decision.action.kind(), "lock_eth", "{:?}", out.decision);
    assert!(notes_with(&out.decision.notes, "second Ethereum node").is_empty(), "{:?}", out.decision.notes);
}

#[test]
fn r7_4_a_dropped_poseidon_lock_is_not_re_sent_while_the_second_ethereum_node_is_down() {
    let mut s = bob_ready(LockKind::Poseidon);
    assert_eq!(s.tick_bob().action.kind(), "lock_eth");
    s.world.borrow_mut().lock_pending = None;
    s.world.borrow_mut().advance_eth(ETH_TX_GRACE_S / 12 + 5);
    let r = s.tick_bob();
    assert!(r.events.contains(&"eth_lock_dropped".to_string()), "{r:?}");
    let r = s.tick_bob_with(second_down);
    assert_eq!(r.action.kind(), "wait", "{r:?}");
    assert!(wait_reason(&r.action).starts_with("the lock was dropped, but the second Ethereum node could not be read"), "{r:?}");
    assert!(r.notes.iter().any(|n| n.starts_with("not re-sending the lock: the second Ethereum node could not be read")), "{:?}", r.notes);
    let r = s.tick_bob();
    assert_eq!(r.action.kind(), "lock_eth", "{r:?}");
}

#[test]
fn r7_4_the_sha256_kind_has_no_scan_and_is_not_held_back_by_the_second_ethereum_node() {
    // Recorded, not changed: the sha256 lock has no pre-lock scan to protect, so a failed second Ethereum node does not hold the lock back.
    let mut s = bob_ready(LockKind::Sha256);
    let r = s.tick_bob_with(second_down);
    assert_eq!(r.action.kind(), "lock_eth", "{r:?}");
    assert!(notes_with(&r.notes, "second Ethereum node").is_empty(), "{:?}", r.notes);
}

// ================================================================================================ F-14

fn pending(txid: &str, tip: u64) -> PendingCall {
    PendingCall { txid: txid.into(), fee_micronoid: 5_800, admitted_height: tip }
}

/// The call sits in the mempool of every node that is asked (a re-queued close is in the pool of both).
fn pend_everywhere(noid: &mut NoidObservation) {
    let call = pending(TXID, noid.tip);
    noid.pending_calls = vec![call.clone()];
    if let Some(second) = noid.second.as_mut() {
        second.pending_calls = vec![call];
    }
}

/// Alice's funding is final and the Parano1d tip is `D - 1`, so the recovery close is due.
fn alice_at_refund_time() -> Scenario {
    let mut s = Scenario::new(Variant::Raw);
    s.tick_alice();
    s.world.borrow_mut().advance_noid(1);
    s.tick_both();
    s.world.borrow_mut().advance_noid(18);
    s.tick_alice();
    assert_eq!(s.alice_phase(), "funding_final");
    let d = s.public.params.deadline_height;
    s.world.borrow_mut().tip = d - 1;
    s
}

const TXID: &str = "ab12ab12ab12ab12ab12ab12ab12ab12ab12ab12ab12ab12ab12ab12ab12ab12";

#[test]
fn f14_a_reorged_recovery_close_in_the_mempool_is_not_offered_a_second_time() {
    let s = alice_at_refund_time();
    let mut file = s.alice.file.clone();
    // The normal refund, nothing pending: offered and recorded (unchanged).
    let (noid, eth, now) = observe(&s);
    let out = tick_apply(&mut file, &noid, &eth, now, true).unwrap();
    assert_eq!(out.decision.action.kind(), "refund_noid", "{:?}", out.decision);
    assert!(file.pending_intent.as_ref().is_some_and(|i| i.action == "refund_noid"));
    // The close is included: the instance is gone and the intent resolves.
    let inst = s.world.borrow_mut().instance.take().unwrap();
    let (noid, eth, now) = observe(&s);
    let out = tick_apply(&mut file, &noid, &eth, now, true).unwrap();
    assert!(file.pending_intent.is_none(), "{:?}", out.intent);
    assert_eq!(out.decision.action.kind(), "wait", "{:?}", out.decision);
    // A reorg: the instance is back and the close is in the mempool again. No second recovery close is offered, and no second intent is recorded.
    s.world.borrow_mut().instance = Some(inst);
    let (mut noid, eth, now) = observe(&s);
    pend_everywhere(&mut noid);
    let out = tick_apply(&mut file, &noid, &eth, now, true).unwrap();
    assert_eq!(out.decision.action.kind(), "wait", "{:?}", out.decision);
    let reason = wait_reason(&out.decision.action);
    assert!(reason.contains(TXID) && reason.contains("pending in the node's mempool") && reason.contains("CHAOS F-14"), "{reason}");
    assert!(file.pending_intent.is_none());
    assert_eq!(file.history.iter().filter(|h| h.event == "intent_decided:refund_noid").count(), 1);
    assert!(out.decision.notes.iter().any(|n| n.starts_with("not refund_noid: a call on this contract (one of its instances) is pending in the node's mempool")), "{:?}", out.decision.notes);
    assert_eq!(
        reason,
        format!("a call on this contract (one of its instances) is pending in the node's mempool ({TXID}); it may be the recovery close sent earlier, put back by a reorg; refund_noid is offered again only if it is evicted and the instance is still there (CHAOS F-14)")
    );
    // The call is evicted (or expired) and the instance is still there: the refund is offered again.
    let (noid, eth, now) = observe(&s);
    let out = tick_apply(&mut file, &noid, &eth, now, true).unwrap();
    assert_eq!(out.decision.action.kind(), "refund_noid", "{:?}", out.decision);
    assert_eq!(file.history.iter().filter(|h| h.event == "intent_decided:refund_noid").count(), 2);
}

#[test]
fn f14_the_library_path_does_not_send_a_recovery_close_while_a_call_is_pending() {
    let mut s = alice_at_refund_time();
    let r = s.tick_alice_with(|noid, _| pend_everywhere(noid));
    assert_eq!(r.action.kind(), "wait", "{r:?}");
    assert_eq!(s.alice.executor.count("refund_noid"), 0);
    assert_eq!(s.alice_phase(), "funding_final");
    // Nothing pending: the recovery close goes out as before.
    let r = s.tick_alice();
    assert_eq!(r.action.kind(), "refund_noid", "{r:?}");
    assert_eq!(s.alice.executor.count("refund_noid"), 1);
}

#[test]
fn f14_a_second_node_that_is_level_and_sees_no_pending_call_lets_the_refund_go_on_as_for_bobs_claim() {
    let s = alice_at_refund_time();
    // The primary shows a pending call, the second (fresh, level) shows none: the refund is offered, with the note.
    let (mut noid, eth, now) = observe(&s);
    assert!(noid.second.is_some());
    noid.pending_calls = vec![pending(TXID, noid.tip)];
    let mut file = s.alice.file.clone();
    let out = tick_apply(&mut file, &noid, &eth, now, true).unwrap();
    assert_eq!(out.decision.action.kind(), "refund_noid", "{:?}", out.decision);
    assert!(out.decision.notes.iter().any(|n| n.contains("not waiting on it (F5)")), "{:?}", out.decision.notes);
    // Both nodes show it: the wait stands.
    let (mut noid, eth, now) = observe(&s);
    pend_everywhere(&mut noid);
    let mut file = s.alice.file.clone();
    let out = tick_apply(&mut file, &noid, &eth, now, true).unwrap();
    assert_eq!(out.decision.action.kind(), "wait", "{:?}", out.decision);
    assert!(wait_reason(&out.decision.action).contains("CHAOS F-14"), "{:?}", out.decision.action);
    // A second node that could not be read does not lift it.
    let (mut noid, eth, now) = observe(&s);
    pend_everywhere(&mut noid);
    noid.second = None;
    noid.second_error = Some("second node down".into());
    let mut file = s.alice.file.clone();
    let out = tick_apply(&mut file, &noid, &eth, now, true).unwrap();
    assert_eq!(out.decision.action.kind(), "wait", "{:?}", out.decision);
    assert!(wait_reason(&out.decision.action).contains("CHAOS F-14"), "{:?}", out.decision.action);
    // (The two wait cases above carry the same reason.)
}

// ================================================================================================ F-10

fn lookalike(s: &Scenario) {
    let amount = s.public.params.amount_micronoid;
    s.world.borrow_mut().instances_after.push(NoidInstance { slot_index: 21, creation_id: 701, amount_micronoid: amount });
}

/// Bob has seen the funding final and the next tick decides on the lock. Returns the scenario and the tip at which the funding was final.
fn bob_funding_final_with_two_instances() -> (Scenario, u64) {
    let mut s = Scenario::new(Variant::Raw);
    s.tick_alice();
    s.world.borrow_mut().advance_noid(1);
    s.tick_both();
    s.world.borrow_mut().advance_noid(18);
    s.tick_alice();
    assert_eq!(s.bob_phase(), "funded");
    let f = s.world.borrow().tip;
    lookalike(&s);
    (s, f)
}

#[test]
fn f10_two_fitting_instances_before_the_give_up_heights_are_still_a_wait_and_nothing_is_locked() {
    let (mut s, f) = bob_funding_final_with_two_instances();
    let limit = s.gates().bob_lock_by_min_window(s.public.params.deadline_height).min(f + s.gates().b_bob);
    let r = s.tick_bob();
    assert_eq!(s.bob_phase(), "funding_final", "{r:?}");
    assert!(wait_reason(&r.action).starts_with("more than one instance at the contract root:"), "{r:?}");
    assert!(r.notes.iter().any(|n| n.starts_with("not lock_eth: 2 instances at our contract root fit the agreement")), "{:?}", r.notes);
    // Up to and including the last lock height: the same wait.
    let tip = s.world.borrow().tip;
    s.world.borrow_mut().advance_noid(limit - tip);
    let r = s.tick_bob();
    assert!(wait_reason(&r.action).starts_with("more than one instance at the contract root:"), "{r:?}");
    assert_eq!(s.bob.executor.count("lock_eth"), 0);
    // It clears up: the lock goes out as before.
    s.world.borrow_mut().instances_after.clear();
    let r = s.tick_bob();
    assert_eq!(r.action.kind(), "lock_eth", "{r:?}");
}

#[test]
fn f10_two_fitting_instances_after_the_give_up_height_end_the_file_as_one_instance_would() {
    // Past F + b_bob (the funding window; the nearer limit): the same abort text as without the lookalike.
    let (mut s, f) = bob_funding_final_with_two_instances();
    s.tick_bob();
    let b_bob = s.gates().b_bob;
    let tip = s.world.borrow().tip;
    s.world.borrow_mut().advance_noid(f + b_bob + 1 - tip);
    let r = s.tick_bob();
    assert!(matches!(&r.action, Action::Abort { reason } if reason.starts_with("not locking: height ") && reason.contains("B_bob")), "{r:?}");
    assert_eq!(s.bob_phase(), "aborted");
    // Past the last lock height (the lock-by with the minimum window), and past D: the lock-by text.
    for past_d in [false, true] {
        let (mut s, _) = bob_funding_final_with_two_instances();
        s.tick_bob();
        let d = s.public.params.deadline_height;
        let hard = s.gates().bob_lock_by_min_window(d);
        let target = if past_d { d + 5 } else { hard + 1 };
        let tip = s.world.borrow().tip;
        s.world.borrow_mut().advance_noid(target - tip);
        let r = s.tick_bob();
        assert!(matches!(&r.action, Action::Abort { reason } if reason.starts_with("not locking: height ") && reason.contains("past Bob's lock-by height")), "{past_d}: {r:?}");
        assert_eq!(s.bob_phase(), "aborted", "{past_d}");
        assert_eq!(s.bob.executor.count("lock_eth"), 0);
    }
    // The same file with ONE instance (the lock is decided and not sent, so the phase stays) gives the very same abort: the lookalike changes
    // nothing about when Bob gives up or what he says.
    let mut one = Scenario::new(Variant::Raw);
    one.bob.executor.offline_for.insert("lock_eth");
    one.tick_alice();
    one.world.borrow_mut().advance_noid(1);
    one.tick_both();
    one.world.borrow_mut().advance_noid(18);
    one.tick_alice();
    one.tick_bob();
    assert_eq!(one.bob_phase(), "funding_final");
    let tip = one.world.borrow().tip;
    one.world.borrow_mut().advance_noid(f + b_bob + 1 - tip);
    let r1 = one.tick_bob();
    let (mut two, f2) = bob_funding_final_with_two_instances();
    assert_eq!(f2, f);
    two.tick_bob();
    let tip = two.world.borrow().tip;
    two.world.borrow_mut().advance_noid(f + b_bob + 1 - tip);
    let r2 = two.tick_bob();
    assert!(matches!(&r1.action, Action::Abort { reason } if reason.contains("B_bob")), "{r1:?}");
    assert_eq!(r1.action, r2.action);
}

#[test]
fn f10_alice_with_two_fitting_instances_does_not_reveal_before_d() {
    // What matters for Alice (REVIEW-3 F10, untouched by the Bob-side fix): with a second instance of the agreed amount at her root, a first reveal
    // would let Bob claim both, so nothing is revealed and nothing is sent; the reason says so.
    let mut s = Scenario::new(Variant::Raw);
    s.run_to_lock_final();
    lookalike(&s);
    let r = s.tick_alice();
    assert_eq!(r.action.kind(), "wait", "{r:?}");
    assert!(wait_reason(&r.action).starts_with("not revealing: 2 instances with the agreed amount sit at the contract root"), "{r:?}");
    assert_eq!(s.alice_phase(), "lock_final");
    assert_eq!(s.alice.executor.count("reveal_eth"), 0);
    assert!(s.world.borrow().claim_pending.is_none());
    // Again a few blocks later, still before D: the same.
    s.world.borrow_mut().advance_noid(3);
    let r = s.tick_alice();
    assert_eq!(r.action.kind(), "wait", "{r:?}");
    assert_eq!(s.alice.executor.count("reveal_eth"), 0);
    // It clears up (the lookalike is gone): the reveal is offered as before.
    s.world.borrow_mut().instances_after.clear();
    let r = s.tick_alice();
    assert_eq!(r.action.kind(), "reveal_eth", "{r:?}");
}

#[test]
fn f10_alice_with_two_fitting_instances_is_offered_the_recovery_close_of_her_own_instance_at_d() {
    let mut s = Scenario::new(Variant::Raw);
    s.run_to_lock_final();
    lookalike(&s);
    let d = s.public.params.deadline_height;
    let tip = s.world.borrow().tip;
    s.world.borrow_mut().advance_noid(d - 1 - tip);
    let r = s.tick_alice();
    assert_eq!(r.action.kind(), "refund_noid", "{r:?}");
    assert_eq!(s.alice.executor.count("reveal_eth"), 0);
    assert!(r.notes.iter().any(|n| n.contains("not revealing: 2 instances with the agreed amount")), "{:?}", r.notes);
}

// ================================================================================================ more pins (F-10, R7-4, F-14)

#[test]
fn r7_4_the_second_node_wait_gives_way_to_the_abort_past_the_last_lock_height() {
    // Poseidon kind, the second Ethereum node down at every tick. The timing gates come before the scan: up to and including the last lock height
    // (F + b_bob) the wait stands; one block later, and past the lock-by with the minimum window, it is an abort and nothing is locked.
    let mut s = bob_ready(LockKind::Poseidon);
    let f = {
        let r = s.tick_bob_with(second_down);
        assert!(wait_reason(&r.action).contains("the second Ethereum node could not be read"), "{r:?}");
        assert_eq!(s.bob_phase(), "funding_final");
        s.world.borrow().tip
    };
    let b_bob = s.gates().b_bob;
    let hard = s.gates().bob_lock_by_min_window(s.public.params.deadline_height);
    assert!(f + b_bob < hard);
    s.world.borrow_mut().advance_noid(b_bob);
    assert_eq!(s.world.borrow().tip, f + b_bob);
    let r = s.tick_bob_with(second_down);
    assert!(wait_reason(&r.action).contains("the second Ethereum node could not be read"), "at F + b_bob: {r:?}");
    s.world.borrow_mut().advance_noid(1);
    let r = s.tick_bob_with(second_down);
    assert!(matches!(&r.action, Action::Abort { reason } if reason.starts_with("not locking: height ") && reason.contains("B_bob")), "at F + b_bob + 1: {r:?}");
    assert_eq!(s.bob_phase(), "aborted");
    assert_eq!(s.bob.executor.count("lock_eth"), 0);
    // Past the last lock height of the lock-by (and past D): the same, with the lock-by text.
    for past_d in [false, true] {
        let mut s = bob_ready(LockKind::Poseidon);
        s.tick_bob_with(second_down);
        let d = s.public.params.deadline_height;
        let target = if past_d { d + 5 } else { hard + 1 };
        let tip = s.world.borrow().tip;
        s.world.borrow_mut().advance_noid(target - tip);
        let r = s.tick_bob_with(second_down);
        assert!(matches!(&r.action, Action::Abort { reason } if reason.starts_with("not locking: height ")), "{past_d}: {r:?}");
        assert_eq!(s.bob_phase(), "aborted", "{past_d}");
        assert_eq!(s.bob.executor.count("lock_eth"), 0);
    }
}

/// A recorded cancel of Bob's `lock_eth` intent: `known` gives its `T_reveal` (the intent is kept), otherwise only the history entry exists (a file from
/// before cancelled intents were recorded).
fn cancel_lock_eth_on_record(s: &mut Scenario, known: bool) {
    let now = s.now();
    let tip = s.world.borrow().tip;
    s.bob.file.log("intent_decided:lock_eth", now);
    s.bob.file.log("intent_cancelled:lock_eth", now + 1);
    if known {
        s.bob.file.cancelled_intents.push(swap_cli::swapfile::PendingIntent {
            action: "lock_eth".into(),
            params: serde_json::json!({ "t_reveal": now + 4_000 }),
            decided_at: now,
            phase_at_decision: "funding_final".into(),
            noid_tip: tip,
            eth_block: 0,
        });
    }
}

#[test]
fn f10_with_a_cancelled_lock_eth_intent_only_the_lock_by_height_ends_the_wait() {
    // After a cancelled `lock_eth` the `F + b_bob` window is not the limit (`bob_last_lock_height` says "at most"): the wait on two instances stands
    // between F + b_bob + 1 and the last lock height of the lock-by, and past that height Bob gives up as he always did.
    for known in [true, false] {
        let (mut s, f) = bob_funding_final_with_two_instances();
        s.tick_bob();
        assert_eq!(s.bob_phase(), "funding_final");
        cancel_lock_eth_on_record(&mut s, known);
        let b_bob = s.gates().b_bob;
        let hard = s.gates().bob_lock_by_min_window(s.public.params.deadline_height);
        let tip = s.world.borrow().tip;
        s.world.borrow_mut().advance_noid(f + b_bob + 1 - tip);
        let r = s.tick_bob();
        assert!(wait_reason(&r.action).starts_with("more than one instance at the contract root:"), "known {known}, past F + b_bob: {r:?}");
        assert_eq!(s.bob_phase(), "funding_final");
        let tip = s.world.borrow().tip;
        s.world.borrow_mut().advance_noid(hard - tip);
        let r = s.tick_bob();
        assert!(wait_reason(&r.action).starts_with("more than one instance at the contract root:"), "known {known}, at the last lock height: {r:?}");
        s.world.borrow_mut().advance_noid(1);
        let r = s.tick_bob();
        assert!(matches!(&r.action, Action::Abort { reason } if reason.starts_with("not locking: height ") && reason.contains("past Bob's lock-by height")), "known {known}: {r:?}");
        assert_eq!(s.bob_phase(), "aborted", "known {known}");
        assert_eq!(s.bob.executor.count("lock_eth"), 0);
    }
}

#[test]
fn f10_on_the_command_line_path_with_a_decided_lock_eth_intent_the_abort_is_printed_and_not_recorded() {
    // F-1's rule, unchanged: while a `lock_eth` that was decided for this swap is not cancelled (it may have been sent and the chain not shown it),
    // the CLI prints `abort` at every tick and does not record it. With two instances at the root the same holds past the give-up height.
    let mut s = Scenario::new(Variant::Raw);
    s.tick_alice();
    s.world.borrow_mut().advance_noid(1);
    s.tick_both();
    s.world.borrow_mut().advance_noid(18);
    s.tick_alice();
    let mut file = s.bob.file.clone();
    let out = apply(&s, &mut file);
    assert_eq!(out.decision.action.kind(), "lock_eth", "{:?}", out.decision);
    assert!(file.pending_intent.as_ref().is_some_and(|i| i.action == "lock_eth"));
    let f = s.world.borrow().tip;
    lookalike(&s);
    let b_bob = s.gates().b_bob;
    s.world.borrow_mut().advance_noid(b_bob + 1);
    assert_eq!(s.world.borrow().tip, f + b_bob + 1);
    let out = apply(&s, &mut file);
    // PINNED: the abort is the decision that is printed (the give-up height comes before the ambiguity wait), the lock_eth intent is still held, and the
    // file is not changed to `aborted`.
    assert!(matches!(&out.decision.action, Action::Abort { reason } if reason.starts_with("not locking: height ") && reason.contains("B_bob")), "{:?}", out.decision);
    assert!(matches!(out.intent, swap_cli::engine::IntentStatus::Held(_)), "{:?}", out.intent);
    assert_eq!(file.phase.name(), "funding_final", "the abort is not recorded while the decided lock_eth is not cancelled");
    assert!(file.history.iter().all(|h| h.event != "abort"), "{:?}", file.history.iter().map(|h| h.event.as_str()).collect::<Vec<_>>());
    assert!(file.pending_intent.as_ref().is_some_and(|i| i.action == "lock_eth"), "the intent stays");
}

fn pend_on_alice_tick(noid: &mut NoidObservation, _: &mut EthObservation) {
    pend_everywhere(noid);
}

#[test]
fn f14_the_wait_stands_beside_a_held_reveal_eth_intent_and_records_nothing_new() {
    let mut s = Scenario::new(Variant::Raw);
    s.run_to_lock_final();
    let mut file = s.alice.file.clone();
    assert_eq!(apply(&s, &mut file).decision.action.kind(), "reveal_eth");
    assert!(file.pending_intent.as_ref().is_some_and(|i| i.action == "reveal_eth"));
    // The cutoff passes and D is reached: the recovery close would be due beside the held reveal (see the test below), but a call is pending.
    let t_reveal = s.world.borrow().lock.as_ref().unwrap().timelock;
    s.world.borrow_mut().warp_eth_to(t_reveal - s.gates().m_a_s + 60);
    let d = s.public.params.deadline_height;
    s.world.borrow_mut().tip = d - 1;
    let (mut noid, eth, now) = observe(&s);
    pend_everywhere(&mut noid);
    let out = tick_apply(&mut file, &noid, &eth, now, true).unwrap();
    // PINNED: the wait that is printed is the held reveal's own (its cutoff has passed, so its printed parameters are not to be used); the F-14 reason
    // is in the notes. No `refund_noid` intent is recorded, and the held reveal stays for the operator to cancel.
    assert_eq!(out.decision.action.kind(), "wait", "{:?}", out.decision);
    let reason = wait_reason(&out.decision.action);
    assert!(reason.starts_with("intent reveal_eth pending since ") && reason.contains("its reveal cutoff has passed"), "{reason}");
    assert!(!reason.contains("refund_noid is due"), "{reason}");
    assert!(out.decision.notes.iter().any(|n| n.starts_with("not refund_noid: a call on this contract") && n.ends_with("(CHAOS F-14)")), "{:?}", out.decision.notes);
    assert!(out.decision.notes.iter().any(|n| n == "held: fresh decision was wait"), "{:?}", out.decision.notes);
    assert!(file.pending_intent.as_ref().is_some_and(|i| i.action == "reveal_eth"), "the held reveal stays: {:?}", file.pending_intent);
    assert_eq!(file.history.iter().filter(|h| h.event == "intent_decided:refund_noid").count(), 0);
    assert!(matches!(out.intent, swap_cli::engine::IntentStatus::Held(_)), "{:?}", out.intent);
}

/// Alice has revealed, the ETH claim is mined (`final_claim`: and final), Bob never claims, the Parano1d tip is `D - 1`.
fn alice_after_reveal_at_refund_time(final_claim: bool) -> Scenario {
    let mut s = Scenario::new(Variant::Raw);
    s.run_to_lock_final();
    s.tick_alice();
    s.world.borrow_mut().advance_eth(if final_claim { 4 } else { 1 });
    s.bob.executor.offline_for.insert("claim_noid");
    s.tick_alice();
    let d = s.public.params.deadline_height;
    s.world.borrow_mut().tip = d - 1;
    s
}

#[test]
fn f14_the_wait_stands_in_done_and_in_revealed_with_a_leftover_refund() {
    for (final_claim, phase) in [(true, "done"), (false, "revealed")] {
        let mut s = alice_after_reveal_at_refund_time(final_claim);
        assert_eq!(s.alice_phase(), phase);
        let r = s.tick_alice_with(pend_on_alice_tick);
        assert_eq!(r.action.kind(), "wait", "{phase}: {r:?}");
        assert!(wait_reason(&r.action).contains("CHAOS F-14") && wait_reason(&r.action).contains(TXID), "{phase}: {r:?}");
        assert_eq!(s.alice.executor.count("refund_noid"), 0, "{phase}");
        assert_eq!(s.alice_phase(), phase);
        // The call is gone and the instance is still there: the recovery close is offered (and the note says it is due, in plain facts).
        let r = s.tick_alice();
        assert_eq!(r.action.kind(), "refund_noid", "{phase}: {r:?}");
        assert!(
            r.notes.iter().any(|n| n.starts_with("REVIEW-2 F9: the secret is public but Bob never claimed the NOID; D ") && n.ends_with("is reached and the instance is still at the contract; refund_noid is due")),
            "{phase}: {:?}",
            r.notes
        );
        assert_eq!(s.alice.executor.count("refund_noid"), 1, "{phase}");
    }
}

#[test]
fn f14_with_a_pending_call_the_due_note_is_a_statement_that_is_true_beside_the_wait() {
    // The note is pushed before the F-14 wait replaces the action: it must read true beside that wait (no "taking it back").
    let mut s = alice_after_reveal_at_refund_time(true);
    let r = s.tick_alice_with(pend_on_alice_tick);
    assert_eq!(r.action.kind(), "wait", "{r:?}");
    assert!(r.notes.iter().any(|n| n.contains("refund_noid is due")), "{:?}", r.notes);
    assert!(r.notes.iter().all(|n| !n.contains("taking it back")), "{:?}", r.notes);
}

// ================================================================================================ the held reveal and a due refund

fn apply(s: &Scenario, file: &mut swap_cli::swapfile::SwapFile) -> swap_cli::engine::TickOutcome {
    let (noid, eth, now) = observe(s);
    tick_apply(file, &noid, &eth, now, true).unwrap()
}

const REUSE: &str = "reuse the printed parameters";

#[test]
fn a_held_reveal_whose_cutoff_has_passed_beside_a_due_refund_does_not_say_to_reuse_the_printed_parameters() {
    let mut s = Scenario::new(Variant::Raw);
    s.run_to_lock_final();
    let t_reveal = s.world.borrow().lock.as_ref().unwrap().timelock;
    let cutoff = t_reveal - s.gates().m_a_s;
    let mut file = s.alice.file.clone();
    assert_eq!(apply(&s, &mut file).decision.action.kind(), "reveal_eth");
    assert!(file.pending_intent.as_ref().is_some_and(|i| i.action == "reveal_eth"));
    // The cutoff passes, and D is reached: the recovery close is due beside the held reveal.
    s.world.borrow_mut().warp_eth_to(cutoff + 60);
    let d = s.public.params.deadline_height;
    s.world.borrow_mut().tip = d - 1;
    let out = apply(&s, &mut file);
    let reason = wait_reason(&out.decision.action);
    let at = file.pending_intent.as_ref().expect("the intent stays held").decided_at;
    assert_eq!(
        reason,
        format!("refund_noid is due but intent reveal_eth pending since {at} (unix): the chain does not show it yet and its reveal cutoff has passed, so the printed parameters are not to be used; if nothing was sent, cancel it with `swap-cli intent FILE --cancel` (with the same chain flags as tick); if a reveal may have been sent, look at the contract")
    );
    assert!(!reason.contains(REUSE), "{reason}");
    assert!(out.decision.notes.iter().any(|n| n.starts_with("held: a refund_noid is due, but a reveal_eth intent is still pending")), "{:?}", out.decision.notes);
    assert!(matches!(out.intent, swap_cli::engine::IntentStatus::Held(_)), "{:?}", out.intent);
}

#[test]
fn a_held_reveal_beside_a_due_refund_for_another_cause_keeps_the_reuse_wording() {
    // The cutoff has NOT passed (the refund is due because two instances fit, a reason that is not the cutoff): the ledger's usual reason stays.
    let mut s = Scenario::new(Variant::Raw);
    s.run_to_lock_final();
    let mut file = s.alice.file.clone();
    assert_eq!(apply(&s, &mut file).decision.action.kind(), "reveal_eth");
    let amount = s.public.params.amount_micronoid;
    s.world.borrow_mut().instances_after.push(NoidInstance { slot_index: 21, creation_id: 701, amount_micronoid: amount });
    let d = s.public.params.deadline_height;
    s.world.borrow_mut().tip = d - 1;
    let out = apply(&s, &mut file);
    let reason = wait_reason(&out.decision.action);
    assert!(reason.starts_with("refund_noid is due but intent reveal_eth pending since ") && reason.contains(REUSE), "{reason}");
    assert!(!reason.contains("reveal cutoff has passed"), "{reason}");
}
