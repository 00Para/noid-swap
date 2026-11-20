//! One test per fixed finding of `REVIEW-5.md` that concerns the Rust side (R5-1, R5-3, R5-4, R5-5, R5-6, R5-7). Each of them fails on the
//! code as it was when the review was written and passes now. Driven on the simulator of `common/`. (R5-2 and R5-8 are `live.js` and
//! helper-script findings: `eth/test/live.test.js`.)

mod common;

use common::*;
use swap_cli::engine::{cancel_intent, secret_may_be_public, tick_apply, Action, Executor, IntentStatus};
use swap_cli::params::{Gates, ProfileName};
use swap_cli::secret::Variant;
use swap_cli::state::{BobPhase, Phase};
use swap_cli::swapfile::SwapFile;
use swap_cli::watch::eth::compute_lock_id;
use swap_cli::watch::{EthLock, EthObservation, NoidObservation};

fn observe(s: &Scenario) -> (NoidObservation, EthObservation, u64) {
    let w = s.world.borrow();
    (w.noid_obs(None), w.eth_obs(), w.eth_time)
}

/// One `tick --apply` on a copy of a party's file (what the CLI does): observe, decide, ledger, save.
fn apply(s: &Scenario, file: &mut SwapFile, path: &std::path::Path) -> swap_cli::engine::TickOutcome {
    let (n, e, now) = observe(s);
    let out = tick_apply(file, &n, &e, now, true).unwrap();
    file.save(path).unwrap();
    out
}

fn lock_of(s: &Scenario) -> (/* lock_id */ [u8; 32], /* t_reveal */ u64) {
    let w = s.world.borrow();
    let l = w.lock.as_ref().expect("a lock");
    (l.lock_id, l.timelock)
}

fn has(file: &SwapFile, event: &str) -> bool {
    file.history.iter().any(|h| h.event == event)
}

/// Alice's file on the CLI path with a `reveal_eth` intent recorded (Bob's lock is final).
fn alice_with_a_reveal_intent() -> (Scenario, SwapFile, std::path::PathBuf, swap_cli::engine::TickOutcome) {
    let mut s = Scenario::new(Variant::Raw);
    s.run_to_lock_final();
    let path = s.dir.path().join("alice-ops.swap.json");
    let mut alice = s.alice.file.clone();
    let out = apply(&s, &mut alice, &path);
    assert_eq!(out.decision.action.kind(), "reveal_eth", "{:?}", out.decision);
    assert!(matches!(out.intent, IntentStatus::Recorded(_)), "{:?}", out.intent);
    (s, alice, path, out)
}

// ------------------------------------------------------------------------------------------------------------------------ R5-1

#[test]
fn r5_1_the_reveal_intent_freezes_both_cutoffs_the_m_a_one_and_the_late_one() {
    let (s, alice, _, _) = alice_with_a_reveal_intent();
    let (_, t_reveal) = lock_of(&s);
    let g = s.gates();
    let params = &alice.pending_intent.as_ref().unwrap().params;
    assert_eq!(params["cutoff"], t_reveal - g.m_a_s, "a first reveal's cutoff is T_reveal - M_A");
    assert_eq!(params["late_cutoff"], t_reveal - g.de_s, "live.js claim --replace re-sends a public claim until T_reveal - DE");
}

#[test]
fn r5_1_a_reveal_that_the_operator_sent_leaves_a_marker_that_the_secret_may_be_public() {
    let (mut s, mut alice, path, out) = alice_with_a_reveal_intent();
    // Decided, not sent: the signer has nothing pending, so no marker (a reveal that never left must still be a first reveal).
    let o = apply(&s, &mut alice, &path);
    assert!(matches!(o.intent, IntentStatus::Held(_)), "{:?}", o.intent);
    assert!(!has(&alice, "reveal_pending_seen") && !secret_may_be_public(&alice));
    // The operator sends the claim (it sits in the mempool: the signer's pending nonce is above its latest).
    let now = s.now();
    s.alice.executor.execute(&alice, &out.decision.action, now).unwrap();
    let o = apply(&s, &mut alice, &path);
    assert!(matches!(o.intent, IntentStatus::Held(_)), "{:?}", o.intent);
    assert!(has(&alice, "reveal_pending_seen"), "{:?}", alice.history);
    assert!(secret_may_be_public(&alice));
    // Once, and it stays after the claim is gone from the pool.
    s.world.borrow_mut().claim_pending = None;
    apply(&s, &mut alice, &path);
    apply(&s, &mut alice, &path);
    assert_eq!(alice.history.iter().filter(|h| h.event == "reveal_pending_seen").count(), 1);
    assert!(secret_may_be_public(&alice));
}

#[test]
fn r5_1_a_dropped_claim_is_re_sent_past_the_m_a_cutoff_once_the_marker_is_there() {
    let (mut s, mut alice, path, out) = alice_with_a_reveal_intent();
    let (_, t_reveal) = lock_of(&s);
    let g = s.gates();
    let now = s.now();
    s.alice.executor.execute(&alice, &out.decision.action, now).unwrap();
    apply(&s, &mut alice, &path);
    assert!(has(&alice, "reveal_pending_seen"));
    // The claim falls out of the pool; the M_A cutoff passes; the operator cancels the (unsent-looking) intent after the minimum age.
    s.world.borrow_mut().claim_pending = None;
    s.world.borrow_mut().warp_eth_to(t_reveal - g.m_a_s + 100);
    let (n, e, now) = observe(&s);
    let decided_at = alice.pending_intent.as_ref().unwrap().decided_at;
    cancel_intent(&mut alice, &n, &e, now.max(decided_at + g.min_cancel_age_s)).unwrap();
    // The secret may be public, so the re-send is allowed until T_reveal - DE and its intent says so.
    let out = apply(&s, &mut alice, &path);
    assert_eq!(out.decision.action.kind(), "reveal_eth", "{:?}", out.decision);
    let IntentStatus::Recorded(i) = &out.intent else { panic!("{:?}", out.intent) };
    assert_eq!(i.params["cutoff"], t_reveal - g.de_s);
}

#[test]
fn r5_1_a_reveal_that_was_never_sent_keeps_the_strict_m_a_cutoff() {
    let (s, mut alice, path, _) = alice_with_a_reveal_intent();
    let (_, t_reveal) = lock_of(&s);
    let g = s.gates();
    s.world.borrow_mut().warp_eth_to(t_reveal - g.m_a_s + 100);
    let (n, e, now) = observe(&s);
    let decided_at = alice.pending_intent.as_ref().unwrap().decided_at;
    cancel_intent(&mut alice, &n, &e, now.max(decided_at + g.min_cancel_age_s)).unwrap();
    let out = apply(&s, &mut alice, &path);
    assert_ne!(out.decision.action.kind(), "reveal_eth", "a first publication past M_A is refused: {:?}", out.decision);
    assert!(out.decision.notes.iter().any(|n| n.contains("not revealing")), "{:?}", out.decision.notes);
}

#[test]
fn r5_1_library_path_a_reveal_of_unknown_outcome_may_be_re_sent_past_the_cutoff_and_one_known_not_sent_may_not() {
    // Unknown outcome (crash around the send): the secret may be out.
    let mut s = Scenario::new(Variant::Raw);
    s.run_to_lock_final();
    let (_, t_reveal) = lock_of(&s);
    let g = *s.gates();
    s.alice.executor.crash_before_effect.insert("reveal_eth");
    let r = s.tick_alice();
    assert!(r.exec_error.is_some(), "{r:?}");
    assert!(has(&s.alice.file, "reveal_maybe_sent"), "{:?}", s.alice.file.history);
    assert!(!secret_may_be_public(&s.alice.file), "an unknown outcome relaxes the cutoff only, not the two-instances rule");
    s.alice.executor.crash_before_effect.clear();
    s.world.borrow_mut().warp_eth_to(t_reveal - g.m_a_s + 100);
    let r = s.tick_alice();
    assert_eq!(r.action.kind(), "reveal_eth", "{r:?}");
    assert!(r.notes.iter().any(|n| n.contains("past the M_A cutoff")), "{:?}", r.notes);
    // Known not sent (the executor refused before anything left): no marker, the cutoff stays.
    let mut s = Scenario::new(Variant::Raw);
    s.run_to_lock_final();
    s.alice.executor.offline_for.insert("reveal_eth");
    let r = s.tick_alice();
    assert!(r.exec_error.is_some(), "{r:?}");
    assert!(!has(&s.alice.file, "reveal_maybe_sent"));
    s.alice.executor.offline_for.clear();
    s.world.borrow_mut().warp_eth_to(t_reveal - g.m_a_s + 100);
    let r = s.tick_alice();
    assert_ne!(r.action.kind(), "reveal_eth", "{r:?}");
}

// ------------------------------------------------------------------------------------------------------------------------ R5-3

#[test]
fn r5_3_bobs_abort_over_a_close_known_only_from_the_get_lock_record_is_not_waited_for_for_ever() {
    let mut s = Scenario::new(Variant::Raw);
    s.run_to_lock_final();
    assert_eq!(s.tick_alice().action.kind(), "reveal_eth");
    s.world.borrow_mut().advance_eth(1); // Alice's claim is mined
    s.world.borrow_mut().claim_log_lag = true; // the log index lags: the claim shows only in the contract's record, at the poll's head
    let path = s.dir.path().join("bob-ops.swap.json");
    let mut bob = s.bob.file.clone();
    apply(&s, &mut bob, &path);
    assert_eq!(bob.phase.name(), "secret_seen", "{:?}", bob.history);
    // The claim branch closes while the secret is known.
    let d = s.public.params.deadline_height;
    let tip = s.world.borrow().tip;
    s.world.borrow_mut().advance_noid(d - 1 - tip);
    let lag = s.world.borrow().finality_lag;
    let mut aborted = false;
    for _ in 0..6 {
        s.world.borrow_mut().advance_eth(lag + 2);
        let out = apply(&s, &mut bob, &path);
        if bob.phase.name() == "aborted" {
            aborted = true;
            assert_eq!(out.decision.action.kind(), "abort");
            break;
        }
    }
    assert!(aborted, "the head keeps moving, but the close was first seen at a block that is final by now: {:?}", bob.history.iter().rev().take(4).collect::<Vec<_>>());
    assert!(bob.history.iter().any(|h| h.event.starts_with("eth_close_record_seen:")), "{:?}", bob.history);
}

// ------------------------------------------------------------------------------------------------------------------------ R5-4 / R5-6

fn bob_ready_to_lock() -> Scenario {
    let mut s = Scenario::new(Variant::Raw);
    s.tick_alice();
    s.world.borrow_mut().advance_noid(1);
    s.tick_both();
    s.world.borrow_mut().advance_noid(18);
    s.tick_alice();
    assert_eq!(s.alice_phase(), "funding_final");
    s
}

/// Bob decides `lock_eth`, `intent --cancel` drops it, and the cancelled `T_reveal` is no longer safe: the next decision is an abort that is held
/// back for an hour (review M1) and then recorded. Returns the world, the file, its path and the cancelled `T_reveal`.
fn bob_whose_abort_is_due() -> (Scenario, SwapFile, std::path::PathBuf, u64) {
    let s = bob_ready_to_lock();
    let path = s.dir.path().join("bob-ops.swap.json");
    let mut bob = s.bob.file.clone();
    let out = apply(&s, &mut bob, &path);
    let Action::LockEth { t_reveal, .. } = out.decision.action.clone() else { panic!("{:?}", out.decision) };
    s.world.borrow_mut().advance_eth(100);
    let (n, e, now) = observe(&s);
    cancel_intent(&mut bob, &n, &e, now).unwrap();
    s.world.borrow_mut().advance_eth(60);
    let out = apply(&s, &mut bob, &path);
    assert_eq!(out.decision.action.kind(), "abort", "{:?}", out.decision);
    assert_eq!(bob.phase.name(), "funding_final", "held back for an hour");
    s.world.borrow_mut().advance_eth(300); // the hour
    (s, bob, path, t_reveal)
}

fn aborted_reason(bob: &SwapFile) -> Option<String> {
    match &bob.phase {
        Phase::Bob(BobPhase::Aborted { reason }) => Some(reason.clone()),
        _ => None,
    }
}

#[test]
fn r5_4_an_abort_waits_for_a_fresh_ethereum_head_on_every_node() {
    let (s, mut bob, path, _) = bob_whose_abort_is_due();
    // The node stalls: its head trails the clock by 700 s, so its empty answer proves nothing about a lock on its way.
    s.world.borrow_mut().eth_head_lag = 700;
    let out = apply(&s, &mut bob, &path);
    assert_eq!(bob.phase.name(), "funding_final", "{:?}", out.decision);
    assert!(out.decision.notes.iter().any(|n| n.contains("abort not recorded") && n.contains("lags")), "{:?}", out.decision.notes);
    assert_eq!(out.decision.action.kind(), "wait");
    // The same with only the SECOND node behind.
    s.world.borrow_mut().eth_head_lag = 0;
    let (n, mut e, now) = observe(&s);
    e.second.as_mut().unwrap().latest_timestamp = now - 700;
    let out = tick_apply(&mut bob, &n, &e, now, true).unwrap();
    assert_eq!(bob.phase.name(), "funding_final", "{:?}", out.decision);
    assert!(out.decision.notes.iter().any(|n| n.contains("second Ethereum node") && n.contains("lags")), "{:?}", out.decision.notes);
    // Healthy: recorded.
    let out = apply(&s, &mut bob, &path);
    assert_eq!(bob.phase.name(), "aborted", "{:?}", out.decision.notes);
}

#[test]
fn r5_4_where_the_profile_asks_for_a_second_node_the_abort_needs_it() {
    let (s, mut bob, path, _) = bob_whose_abort_is_due();
    s.world.borrow_mut().single_node = true; // no second node configured (production: required unless --single-node-ok)
    let out = apply(&s, &mut bob, &path);
    assert_eq!(bob.phase.name(), "funding_final", "{:?}", out.decision);
    assert!(out.decision.notes.iter().any(|n| n.contains("second Ethereum node is required")), "{:?}", out.decision.notes);
    // A configured second node that cannot be read blocks too, whatever --single-node-ok says.
    {
        let mut w = s.world.borrow_mut();
        w.single_node = false;
        w.second_unreadable = Some("timeout".into());
        w.single_node_ok = true;
    }
    let out = apply(&s, &mut bob, &path);
    assert_eq!(bob.phase.name(), "funding_final", "{:?}", out.decision);
    assert!(out.decision.notes.iter().any(|n| n.contains("could not be read")), "{:?}", out.decision.notes);
    // The operator's word for one node is accepted.
    {
        let mut w = s.world.borrow_mut();
        w.second_unreadable = None;
        w.single_node = true;
    }
    s.world.borrow_mut().single_node_ok = false;
    let out = apply(&s, &mut bob, &path);
    assert_eq!(bob.phase.name(), "funding_final", "still not accepted without the flag: {:?}", out.decision);
    s.world.borrow_mut().single_node_ok = true;
    let out = apply(&s, &mut bob, &path);
    assert_eq!(bob.phase.name(), "aborted", "{:?}", out.decision.notes);
}

#[test]
fn r5_4_a_second_node_that_shows_the_cancelled_lock_stops_the_abort() {
    let (s, mut bob, path, t_reveal) = bob_whose_abort_is_due();
    let p = bob.public.params.eth.clone();
    let lock_id = compute_lock_id(&p.bob_sender, &p.alice_receiver, p.amount_wei, &bob.public.hashlock, t_reveal);
    let lock = EthLock {
        lock_id,
        sender: p.bob_sender,
        receiver: p.alice_receiver,
        amount_wei: p.amount_wei,
        hashlock: bob.public.hashlock,
        timelock: t_reveal,
        block_number: 1,
        tx_hash: [0xdd; 32],
        claimed: false,
        refunded: false,
        receiver_is_eoa: Some(true),
        sender_is_eoa: Some(true),
        block_timestamp: Some(t_reveal - s.gates().w_a_s),
    };
    let (n, mut e, now) = observe(&s);
    let second = e.second.as_mut().unwrap();
    second.lock = Some(lock.clone());
    second.locks = vec![lock];
    second.lock_count = 1;
    let out = tick_apply(&mut bob, &n, &e, now, true).unwrap();
    assert_eq!(bob.phase.name(), "funding_final", "{:?}", out.decision);
    assert!(out.decision.notes.iter().any(|n| n.contains("second Ethereum node shows the lock")), "{:?}", out.decision.notes);
    // Nothing shown: recorded, and the reason tells Bob what to do if a lock lands after all.
    let out = apply(&s, &mut bob, &path);
    assert_eq!(bob.phase.name(), "aborted", "{:?}", out.decision.notes);
    let reason = aborted_reason(&bob).unwrap();
    assert!(reason.contains("claim the NOID before D") && reason.contains("only if the lock is still unclaimed"), "{reason}");
    assert!(!reason.contains("refund it at T_reveal from the wallet"), "{reason}");
}

#[test]
fn r5_4_the_walk_away_text_does_not_tell_bob_to_refund_unconditionally() {
    let s = bob_ready_to_lock();
    let path = s.dir.path().join("bob-ops.swap.json");
    let mut bob = s.bob.file.clone();
    apply(&s, &mut bob, &path);
    s.world.borrow_mut().advance_eth(100);
    let (n, e, now) = observe(&s);
    cancel_intent(&mut bob, &n, &e, now).unwrap();
    s.world.borrow_mut().advance_eth(60);
    let out = apply(&s, &mut bob, &path);
    let Action::Abort { reason } = &out.decision.action else { panic!("{:?}", out.decision) };
    assert!(reason.contains("claim the NOID before D") && reason.contains("still unclaimed") && !reason.contains("refund it at T_reveal from the wallet"), "{reason}");
}

#[test]
fn r5_6_an_older_unrecorded_cancel_beside_a_recorded_one_means_bob_walks_away() {
    let s = bob_ready_to_lock();
    let path = s.dir.path().join("bob-ops.swap.json");
    let mut bob = s.bob.file.clone();
    let out = apply(&s, &mut bob, &path);
    assert_eq!(out.decision.action.kind(), "lock_eth", "{:?}", out.decision);
    s.world.borrow_mut().advance_eth(100);
    let (n, e, now) = observe(&s);
    cancel_intent(&mut bob, &n, &e, now).unwrap();
    assert_eq!(bob.cancelled_intents.len(), 1);
    // With only the recorded cancel Bob would lock again with its T_reveal.
    let out = apply(&s, &mut bob.clone(), &path);
    assert_eq!(out.decision.action.kind(), "lock_eth", "{:?}", out.decision);
    // An older cancel that this file never recorded (written before cancelled intents were kept) sits in the history too: two cancels,
    // one entry. The unrecorded one may have frozen another T_reveal, so no lock id can be trusted: Bob walks away.
    bob.log("intent_cancelled:lock_eth", now);
    let out = apply(&s, &mut bob, &path);
    assert!(matches!(&out.decision.action, Action::Abort { reason } if reason.contains("before this file recorded cancelled intents")), "{:?}", out.decision);
}

// ------------------------------------------------------------------------------------------------------------------------ R5-5

#[test]
fn r5_5_the_cancel_constants_are_profile_values_that_the_validator_relates_to_the_windows() {
    for name in [ProfileName::Production, ProfileName::Rehearsal, ProfileName::Sepolia] {
        let g = name.gates();
        g.validate().unwrap();
        assert!(g.w_a_s < g.w_a_min_s + g.min_cancel_age_s + g.abort_after_cancel_s, "{name}");
        assert!(g.tx_grace_s + g.ra_s + g.de_s <= g.m_a_s, "{name}");
    }
    // The rehearsal window is shorter than the production minimum cancel age (600 s), so rehearsal has its own.
    assert!(ProfileName::Rehearsal.gates().min_cancel_age_s < ProfileName::Rehearsal.gates().w_a_s);
    assert!(ProfileName::Rehearsal.gates().min_cancel_age_s < ProfileName::Production.gates().min_cancel_age_s);
    // A profile that breaks either relation is refused by name.
    let near_miss = Gates { abort_after_cancel_s: 700, min_cancel_age_s: 100, ..*ProfileName::Sepolia.gates() };
    assert!(near_miss.validate().unwrap_err().to_string().contains("after a recorded abort"));
    let slow_grace = Gates { tx_grace_s: 1_561, ..*ProfileName::Production.gates() };
    assert!(slow_grace.validate().unwrap_err().to_string().contains("could not be re-sent in time"));
}

#[test]
fn r5_5_the_minimum_cancel_age_follows_the_profile() {
    let age_of = |profile: ProfileName, age: u64| {
        let mut s = Scenario::with_profile(Variant::Raw, profile);
        s.tick_alice();
        s.world.borrow_mut().advance_noid(1);
        s.tick_both();
        s.world.borrow_mut().advance_noid(18);
        s.tick_alice();
        let path = s.dir.path().join("bob-ops.swap.json");
        let mut bob = s.bob.file.clone();
        let out = apply(&s, &mut bob, &path);
        assert_eq!(out.decision.action.kind(), "lock_eth", "{:?}", out.decision);
        let (n, e, _) = observe(&s);
        let decided_at = bob.pending_intent.as_ref().unwrap().decided_at;
        cancel_intent(&mut bob, &n, &e, decided_at + age)
    };
    let rehearsal = ProfileName::Rehearsal.gates().min_cancel_age_s;
    assert!(age_of(ProfileName::Rehearsal, rehearsal).is_ok());
    assert!(age_of(ProfileName::Rehearsal, rehearsal - 1).unwrap_err().contains(&format!("younger than {rehearsal} s")));
    // The same age is far too young under production.
    assert!(age_of(ProfileName::Production, rehearsal).unwrap_err().contains("younger than 600 s"));
}

// ------------------------------------------------------------------------------------------------------------------------ R5-7

#[test]
fn r5_7_a_reveal_intent_whose_lock_was_refunded_resolves_and_no_longer_holds_the_recovery() {
    let (s, mut alice, path, _) = alice_with_a_reveal_intent();
    let (_, t_reveal) = lock_of(&s);
    // The reveal was never sent (or lost the race); Bob refunds at T_reveal and never claims the NOID.
    s.world.borrow_mut().warp_eth_to(t_reveal);
    let mut s = s;
    let r = s.tick_bob();
    assert_eq!(r.action.kind(), "refund_eth", "{r:?}");
    s.world.borrow_mut().advance_eth(1);
    assert!(s.world.borrow().refunded.is_some());
    let out = apply(&s, &mut alice, &path);
    assert!(matches!(&out.intent, IntentStatus::Resolved(h) if h.action == "reveal_eth"), "{:?} / {:?}", out.intent, out.decision);
    assert!(alice.pending_intent.is_none());
    // At D the recovery is offered and recorded instead of held.
    let d = s.public.params.deadline_height;
    let tip = s.world.borrow().tip;
    s.world.borrow_mut().advance_noid(d - 1 - tip);
    let out = apply(&s, &mut alice, &path);
    assert_eq!(out.decision.action.kind(), "refund_noid", "{:?}", out.decision);
    assert!(matches!(out.intent, IntentStatus::Recorded(_)), "{:?}", out.intent);
}
