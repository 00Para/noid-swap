//! One test per fixed finding of `REVIEW-4.md` that concerns the Rust side (R4-2, R4-4, R4-6, R4-7, R4-8, R4-9, R4-10, R4-11). Each of
//! them fails on the code as it was when the review was written and passes now. Driven on the simulator of `common/`.

mod common;

use common::*;
use swap_cli::engine::{cancel_intent, expected_lock_id, tick_apply, Action, Executor, IntentStatus, MIN_CANCEL_AGE_S};
use swap_cli::secret::Variant;
use swap_cli::state::{BobPhase, Phase};
use swap_cli::swapfile::SwapFile;
use swap_cli::watch::eth::compute_lock_id;
use swap_cli::watch::{EthObservation, NoidInstance, NoidObservation};

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

/// Alice funded and final, Bob has seen the funding final: Bob's next decision is `lock_eth`.
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

fn dust(slot: u32, creation: u64, amount: u64) -> NoidInstance {
    NoidInstance { slot_index: slot, creation_id: creation, amount_micronoid: amount }
}

fn lock_of(s: &Scenario) -> (/* lock_id */ [u8; 32], /* t_reveal */ u64) {
    let w = s.world.borrow();
    let l = w.lock.as_ref().expect("a lock");
    (l.lock_id, l.timelock)
}

// ------------------------------------------------------------------------------------------------------------------------ R4-2

/// Bob decides `lock_eth`, the operator sends it, `intent --cancel` drops the intent (this tool's node sees an empty mempool), time passes.
fn bob_with_a_cancelled_lock(wait_blocks: u64) -> (Scenario, SwapFile, std::path::PathBuf, u64) {
    let s = bob_ready_to_lock();
    let path = s.dir.path().join("bob-ops.swap.json");
    let mut bob = s.bob.file.clone();
    let out = apply(&s, &mut bob, &path);
    let Action::LockEth { t_reveal, .. } = out.decision.action.clone() else { panic!("{:?}", out.decision) };
    s.world.borrow_mut().advance_eth(wait_blocks);
    let (n, e, now) = observe(&s);
    cancel_intent(&mut bob, &n, &e, now).unwrap();
    assert!(bob.pending_intent.is_none());
    (s, bob, path, t_reveal)
}

#[test]
fn r4_2_a_lock_after_a_cancelled_lock_intent_keeps_the_cancelled_t_reveal_so_the_lock_id_is_the_same() {
    // 100 blocks = 1,200 s: more than the minimum age of a cancel, and enough for a fresh `T_reveal` to differ.
    let (s, mut bob, path, t1) = bob_with_a_cancelled_lock(100);
    assert!(MIN_CANCEL_AGE_S <= 1_200);
    assert_eq!(bob.cancelled_intents.len(), 1, "the cancelled intent's parameters are kept");
    assert_eq!(bob.cancelled_intents[0].params["t_reveal"], t1);
    // The watcher keeps asking `getLock` for the cancelled lock's id (it may still land).
    let p = &bob.public.params.eth;
    assert_eq!(expected_lock_id(&bob), Some(compute_lock_id(&p.bob_sender, &p.alice_receiver, p.amount_wei, &bob.public.hashlock, t1)));
    // The next decision is a lock again, and with the SAME T_reveal (a fresh one would be `now + W_A`, 1,200 s later).
    let out = apply(&s, &mut bob, &path);
    let Action::LockEth { t_reveal, .. } = out.decision.action.clone() else { panic!("{:?}", out.decision) };
    assert_eq!(t_reveal, t1, "{:?}", out.decision.notes);
    assert!(s.now() + s.gates().w_a_s > t1, "a fresh T_reveal would have been different");
    assert!(out.decision.notes.iter().any(|n| n.contains("R4-2")), "{:?}", out.decision.notes);
    // It survives a restart from disk.
    let again = SwapFile::load(&path).unwrap();
    assert_eq!(again.cancelled_intents, bob.cancelled_intents);
}

#[test]
fn r4_2_when_the_cancelled_t_reveal_is_no_longer_safe_bob_walks_away_and_never_locks_afresh() {
    // 1,200 s, then a cancel; 700 s more: the cancelled lock would leave Alice less than W_A_min after the block it lands in.
    let (s, mut bob, path, t1) = bob_with_a_cancelled_lock(100);
    s.world.borrow_mut().advance_eth(60);
    let out = apply(&s, &mut bob, &path);
    match &out.decision.action {
        Action::Abort { reason } => assert!(reason.contains("R4-2") && reason.contains(&t1.to_string()), "{reason}"),
        other => panic!("expected abort, got {other:?} ({:?})", out.decision.notes),
    }
    assert_ne!(out.decision.action.kind(), "lock_eth");
    // Held back for an hour after the cancel (review M1), then recorded: Bob has not locked, so `aborted` is true.
    assert_eq!(bob.phase.name(), "funding_final");
    s.world.borrow_mut().advance_eth(300);
    let out = apply(&s, &mut bob, &path);
    assert_eq!(out.decision.action.kind(), "abort", "{:?}", out.decision);
    assert_eq!(bob.phase.name(), "aborted", "{:?}", out.decision.notes);
}

#[test]
fn r4_2_a_cancel_recorded_before_the_ledger_existed_cannot_be_followed_by_a_fresh_lock() {
    // A file with `intent_cancelled:lock_eth` in its history and no record of the intent: the old lock id is unknown.
    let s = bob_ready_to_lock();
    let mut bob = s.bob.file.clone();
    bob.log("intent_decided:lock_eth", s.now());
    bob.log("intent_cancelled:lock_eth", s.now() + 1);
    assert!(bob.cancelled_intents.is_empty());
    let path = s.dir.path().join("bob-old.swap.json");
    let out = apply(&s, &mut bob, &path);
    assert!(matches!(&out.decision.action, Action::Abort { reason } if reason.contains("R4-2")), "{:?}", out.decision);
}

// ------------------------------------------------------------------------------------------------------------------------ R4-4

#[test]
fn r4_4_the_re_send_of_a_public_secret_is_not_blocked_by_a_second_fitting_instance() {
    let mut s = Scenario::new(Variant::Raw);
    s.run_to_lock_final();
    let r = s.tick_alice();
    assert_eq!(r.action.kind(), "reveal_eth", "{r:?}");
    // The claim never reaches a block: dropped from the mempool. Bob funds a second instance of the agreed amount at her root.
    s.world.borrow_mut().claim_pending = None;
    let amount = s.public.params.amount_micronoid;
    s.world.borrow_mut().instances_after.push(dust(9, 2, amount));
    s.world.borrow_mut().advance_eth(swap_cli::engine::ETH_TX_GRACE_S / 12 + 5);
    let r = s.tick_alice();
    assert!(r.events.contains(&"eth_reveal_dropped".to_string()), "{r:?}");
    assert_eq!(r.action.kind(), "reveal_eth", "{r:?}");
    assert!(r.notes.iter().any(|n| n.contains("R4-4") && n.contains("slots 7, 9")), "{:?}", r.notes);
}

#[test]
fn r4_4_a_first_reveal_still_refuses_two_fitting_instances() {
    let mut s = Scenario::new(Variant::Raw);
    s.run_to_lock_final();
    let amount = s.public.params.amount_micronoid;
    s.world.borrow_mut().instances_after.push(dust(9, 2, amount));
    let r = s.tick_alice();
    assert_eq!(r.action.kind(), "wait", "{r:?}");
    assert!(r.notes.iter().any(|n| n.contains("revealing would let Bob claim every one of them")), "{:?}", r.notes);
}

// ------------------------------------------------------------------------------------------------------------------------ R4-6

#[test]
fn r4_6_an_abort_after_a_lock_intent_that_the_chain_showed_is_recorded() {
    let mut s = bob_ready_to_lock();
    let path = s.dir.path().join("bob-ops.swap.json");
    let mut bob = s.bob.file.clone();
    let out = apply(&s, &mut bob, &path);
    assert_eq!(out.decision.action.kind(), "lock_eth");
    let now = s.now();
    s.bob.executor.execute(&bob, &out.decision.action, now).unwrap();
    s.world.borrow_mut().advance_eth(1);
    let out = apply(&s, &mut bob, &path);
    assert!(matches!(&out.intent, IntentStatus::Resolved(h) if h.action == "lock_eth"), "{:?}", out.intent);
    assert_eq!(bob.phase.name(), "locked");
    // Alice reveals, her claim is mined; Bob sees the secret; the claim branch is closed by the time he looks (tip at D - 1).
    let lag = s.world.borrow().finality_lag;
    s.world.borrow_mut().advance_eth(lag + 1);
    let r = s.tick_alice();
    assert_eq!(r.action.kind(), "reveal_eth", "{r:?}");
    s.world.borrow_mut().advance_eth(1); // Alice's claim is mined, not final yet
    let d = s.public.params.deadline_height;
    let tip = s.world.borrow().tip;
    s.world.borrow_mut().advance_noid(d - 1 - tip);
    // The claim branch is closed, but the ETH leg is not settled for good (the claim could still be reorged out): no abort yet.
    let out = apply(&s, &mut bob, &path);
    assert_eq!(out.decision.action.kind(), "wait", "{:?}", out.decision);
    assert!(out.decision.notes.iter().any(|n| n.contains("not aborting yet") && n.contains("not final")), "{:?}", out.decision.notes);
    assert_eq!(bob.phase.name(), "secret_seen");
    // Final: the abort is recorded.
    s.world.borrow_mut().advance_eth(lag + 1);
    let out = apply(&s, &mut bob, &path);
    assert_eq!(out.decision.action.kind(), "abort", "{:?}", out.decision);
    assert_eq!(bob.phase.name(), "aborted", "the abort must be recorded: {:?}", out.decision.notes);
    assert!(!out.decision.notes.iter().any(|n| n.contains("abort not recorded")), "{:?}", out.decision.notes);
}

#[test]
fn r4_6_an_abort_is_still_held_while_a_lock_intent_may_be_in_flight() {
    // The chain has not shown the lock: the intent is pending, so no abort is recorded (CHAOS F-1 unchanged).
    let s = bob_ready_to_lock();
    let path = s.dir.path().join("bob-ops.swap.json");
    let mut bob = s.bob.file.clone();
    apply(&s, &mut bob, &path);
    let tip = s.world.borrow().tip;
    let last = s.gates().bob_lock_by_min_window(s.public.params.deadline_height);
    s.world.borrow_mut().advance_noid(last + 1 - tip);
    let out = apply(&s, &mut bob, &path);
    // An abort is shown but not recorded while the pending lock intent may have been sent.
    assert_eq!(out.decision.action.kind(), "abort", "{:?}", out.decision);
    assert_eq!(bob.phase.name(), "funding_final");
    assert!(out.decision.notes.iter().any(|n| n.contains("abort not recorded")), "{:?}", out.decision.notes);
}

// ------------------------------------------------------------------------------------------------------------------------ R4-7

#[test]
fn r4_7_a_refund_known_only_from_the_get_lock_record_still_becomes_final() {
    let mut s = Scenario::new(Variant::Raw);
    s.run_to_lock_final();
    let (_, timelock) = lock_of(&s);
    s.world.borrow_mut().warp_eth_to(timelock);
    let r = s.tick_bob();
    assert_eq!(r.action.kind(), "refund_eth", "{r:?}");
    s.world.borrow_mut().advance_eth(1);
    // The log index lags: the refund shows only in the contract's record, with the poll's head as its block.
    s.world.borrow_mut().refund_log_lag = true;
    let r = s.tick_bob();
    assert_eq!(s.bob_phase(), "refund_mined", "{r:?}");
    for _ in 0..6 {
        s.world.borrow_mut().advance_eth(1);
        s.tick_bob();
    }
    assert_eq!(s.bob_phase(), "refunded", "never final while the log is missing: {:?}", s.bob.file.history.iter().rev().take(4).collect::<Vec<_>>());
    assert!(matches!(s.bob.file.phase, Phase::Bob(BobPhase::Refunded { .. })));
}

// ------------------------------------------------------------------------------------------------------------------------ R4-8

#[test]
fn r4_8_bob_waiting_for_the_secret_raises_an_alarm_when_the_ethereum_node_lags() {
    let mut s = Scenario::new(Variant::Raw);
    s.run_to_lock_final();
    let r = s.tick_bob();
    assert!(matches!(&r.action, Action::Wait { reason } if reason == "waiting for the secret (or T_reveal)"), "{r:?}");
    s.world.borrow_mut().eth_head_lag = 700;
    let r = s.tick_bob();
    match &r.action {
        Action::Wait { reason } => assert!(reason.contains("ALARM") && reason.contains("lags") && reason.contains("700 s"), "{reason}"),
        other => panic!("{other:?}"),
    }
    assert!(r.notes.iter().any(|n| n.starts_with("ALARM")), "{:?}", r.notes);
    // Inside the limit nothing is said.
    s.world.borrow_mut().eth_head_lag = 600;
    let r = s.tick_bob();
    assert!(matches!(&r.action, Action::Wait { reason } if reason == "waiting for the secret (or T_reveal)"), "{r:?}");
}

#[test]
fn r4_8_bob_reads_the_secret_from_the_second_ethereum_node_when_the_first_does_not_show_it() {
    let mut s = Scenario::new(Variant::Raw);
    s.run_to_lock_final();
    let r = s.tick_alice();
    assert_eq!(r.action.kind(), "reveal_eth", "{r:?}");
    s.world.borrow_mut().advance_eth(1); // the claim is mined
    // The first node is behind: it shows neither the pending call nor the Claimed event. The second one shows the mined claim.
    let r = s.tick_bob_with(|_, e| {
        e.claimed = None;
        e.pending_preimage = None;
        if let Some(l) = e.lock.as_mut() {
            l.claimed = false;
        }
        for l in e.locks.iter_mut() {
            l.claimed = false;
        }
    });
    assert!(r.events.contains(&"eth_preimage_seen".to_string()), "{r:?}");
    assert!(r.notes.iter().any(|n| n.contains("SECOND Ethereum node")), "{:?}", r.notes);
}

#[test]
fn r4_8_a_wrong_secret_on_one_node_does_not_hide_the_right_one_on_the_other() {
    let mut s = Scenario::new(Variant::Raw);
    s.run_to_lock_final();
    s.tick_alice();
    s.world.borrow_mut().advance_eth(1);
    let r = s.tick_bob_with(|_, e| {
        // The first node shows a junk preimage for our lock (a griefing claim); the second node shows the real one.
        if let Some(c) = e.claimed.as_mut() {
            c.preimage = [0x55; 32];
        }
        e.pending_preimage = None;
    });
    assert!(r.events.contains(&"eth_preimage_seen".to_string()), "{r:?}");
    assert!(r.notes.iter().any(|n| n.contains("preimage seen but rejected")), "{:?}", r.notes);
}

// ------------------------------------------------------------------------------------------------------------------------ R4-9

/// The state of `chaos_fixes::lock_final_gone`, with a closure applied to the world before Alice's last tick.
fn lost_candidate(last_look: impl FnOnce(&mut World)) -> Scenario {
    let mut s = Scenario::new(Variant::Raw);
    s.run_to_lock_final();
    s.alice.executor.offline_for.insert("reveal_eth");
    s.tick_alice();
    assert_eq!(s.alice_phase(), "lock_final");
    let now = s.now();
    s.alice.file.log("intent_decided:reveal_eth", now);
    s.alice.file.save(&s.alice.path).unwrap();
    let (_, timelock) = lock_of(&s);
    s.world.borrow_mut().warp_eth_to(timelock);
    s.tick_bob();
    s.world.borrow_mut().advance_eth(6);
    s.tick_bob();
    s.world.borrow_mut().instance.take().unwrap(); // closed before D, so by Bob's claim
    s.tick_alice(); // CHAOS F-18: the poll before D that records the instance gone
    let d = s.public.params.deadline_height;
    let need = d + 19 - s.world.borrow().tip;
    s.world.borrow_mut().advance_noid(need);
    last_look(&mut s.world.borrow_mut());
    s.tick_alice();
    s
}

#[test]
fn r4_9_lost_needs_the_second_node_where_the_profile_asks_for_one() {
    // Two nodes that agree: lost (unchanged).
    assert_eq!(lost_candidate(|_| {}).alice_phase(), "lost");
    // One node, no --single-node-ok (production): not lost, and the note says what to do.
    let s = lost_candidate(|w| w.single_node = true);
    assert_eq!(s.alice_phase(), "lock_final");
    // One node and --single-node-ok: the operator accepted the risk for this swap.
    let s = lost_candidate(|w| {
        w.single_node = true;
        w.single_node_ok = true;
    });
    assert_eq!(s.alice_phase(), "lost");
    // A second node that was configured but cannot be read blocks, whatever --single-node-ok says.
    let s = lost_candidate(|w| {
        w.second_unreadable = Some("timeout".into());
        w.single_node_ok = true;
    });
    assert_eq!(s.alice_phase(), "lock_final");
    // A second node that is behind (its tip below D + 19) cannot vouch.
    let s = lost_candidate(|w| w.second_tip_lag = 5);
    assert_eq!(s.alice_phase(), "lock_final");
}

#[test]
fn r4_9_the_reason_says_to_recover_with_the_wallet() {
    let mut s = lost_candidate(|w| w.single_node = true);
    let r = s.tick_alice();
    assert!(r.notes.iter().any(|n| n.contains("R4-9") && n.contains("wallet")), "{:?}", r.notes);
}

// ------------------------------------------------------------------------------------------------------------------------ R4-10

#[test]
fn r4_10_a_second_ledger_spend_beside_a_held_intent_is_not_printed() {
    let mut s = Scenario::new(Variant::Raw);
    s.run_to_lock_final();
    let path = s.dir.path().join("alice-ops.swap.json");
    let mut alice = s.alice.file.clone();
    let out = apply(&s, &mut alice, &path);
    assert_eq!(out.decision.action.kind(), "reveal_eth", "{:?}", out.decision);
    assert!(matches!(out.intent, IntentStatus::Recorded(_)));
    // The operator never sent it. The cutoff passes and D comes: a refund_noid is due beside the held reveal_eth.
    let (_, timelock) = lock_of(&s);
    let g = s.gates();
    s.world.borrow_mut().warp_eth_to(timelock - g.m_a_s + 100);
    let d = s.public.params.deadline_height;
    let tip = s.world.borrow().tip;
    s.world.borrow_mut().advance_noid(d - 1 - tip);
    for _ in 0..3 {
        let out = apply(&s, &mut alice, &path);
        assert_eq!(out.decision.action.kind(), "wait", "{:?}", out.decision);
        let Action::Wait { reason } = &out.decision.action else { unreachable!() };
        assert!(reason.contains("refund_noid is due") && reason.contains("reveal_eth"), "{reason}");
        assert!(matches!(out.intent, IntentStatus::Held(_)));
    }
    // Cancelling the held intent (nothing was sent: the nonces show nothing pending) lets the refund through, recorded once.
    let (n, e, now) = observe(&s);
    let decided_at = alice.pending_intent.as_ref().unwrap().decided_at;
    cancel_intent(&mut alice, &n, &e, now.max(decided_at + MIN_CANCEL_AGE_S)).unwrap();
    let out = apply(&s, &mut alice, &path);
    assert_eq!(out.decision.action.kind(), "refund_noid", "{:?}", out.decision);
    assert!(matches!(out.intent, IntentStatus::Recorded(_)));
    let out = apply(&s, &mut alice, &path);
    assert_eq!(out.decision.action.kind(), "wait", "{:?}", out.decision);
}

#[test]
fn r4_10_bobs_noid_claim_is_still_offered_beside_a_pending_ledger_intent() {
    // `claim_noid` is not a ledger kind: a pending refund_eth intent must not hold it back (REVIEW-2 F9, unchanged).
    let mut s = Scenario::new(Variant::Raw);
    s.run_to_lock_final();
    s.tick_alice();
    s.world.borrow_mut().advance_eth(1);
    let path = s.dir.path().join("bob-ops.swap.json");
    let mut bob = s.bob.file.clone();
    bob.pending_intent = Some(swap_cli::swapfile::PendingIntent {
        action: "refund_eth".into(),
        params: serde_json::json!({"action": "refund_eth"}),
        decided_at: s.now(),
        phase_at_decision: "locked".into(),
        noid_tip: 0,
        eth_block: 0,
    });
    let out = apply(&s, &mut bob, &path);
    assert_eq!(out.decision.action.kind(), "claim_noid", "{:?}", out.decision);
}

// ------------------------------------------------------------------------------------------------------------------------ R4-11

#[test]
fn r4_11_the_drop_grace_is_a_profile_value_short_on_the_local_chain() {
    use swap_cli::params::ProfileName;
    assert_eq!(ProfileName::Production.gates().tx_grace_s, 600);
    assert_eq!(ProfileName::Sepolia.gates().tx_grace_s, 600);
    assert!(ProfileName::Rehearsal.gates().tx_grace_s < 600);
    let dropped_after = |profile: ProfileName, blocks: u64| {
        let mut s = Scenario::with_profile(Variant::Raw, profile);
        s.tick_alice();
        s.world.borrow_mut().advance_noid(1);
        s.tick_both();
        s.world.borrow_mut().advance_noid(18);
        s.tick_alice();
        let rb = s.tick_bob();
        assert_eq!(rb.action.kind(), "lock_eth", "{rb:?}");
        assert_eq!(s.bob_phase(), "lock_submitted");
        s.world.borrow_mut().lock_pending = None; // dropped from the mempool
        s.world.borrow_mut().advance_eth(blocks);
        let r = s.tick_bob();
        r.events.contains(&"eth_lock_dropped".to_string())
    };
    // 132 s (11 blocks): past the rehearsal grace (120 s), far inside the production one (600 s).
    assert!(dropped_after(ProfileName::Rehearsal, 11));
    assert!(!dropped_after(ProfileName::Rehearsal, 9));
    assert!(!dropped_after(ProfileName::Production, 11));
    assert!(dropped_after(ProfileName::Production, 51));
}

#[test]
fn r4_11_a_done_that_still_needs_a_refund_shows_the_relay_floor_note() {
    let mut s = Scenario::new(Variant::Raw);
    s.run_to_lock_final();
    assert_eq!(s.tick_alice().action.kind(), "reveal_eth");
    s.world.borrow_mut().advance_eth(1);
    s.tick_alice();
    let lag = s.world.borrow().finality_lag;
    s.world.borrow_mut().advance_eth(lag + 2);
    s.tick_alice();
    assert_eq!(s.alice_phase(), "done");
    // Bob never claims; the NOID is still at the contract and the relay floor is above max_fee: refund_noid cannot be relayed.
    let max_fee = s.public.params.max_fee_micronoid;
    s.world.borrow_mut().relay_floor = Some(max_fee);
    let r = s.tick_alice();
    assert!(r.notes.iter().any(|n| n.contains("relay floor") && n.contains("cannot be relayed")), "{:?}", r.notes);
    // A finished swap with nothing left stays quiet.
    let d = s.public.params.deadline_height;
    let tip = s.world.borrow().tip;
    s.world.borrow_mut().advance_noid(d - 1 - tip);
    s.world.borrow_mut().relay_floor = None;
    let r = s.tick_alice();
    assert_eq!(r.action.kind(), "refund_noid", "{r:?}");
}

// ------------------------------------------------------------------------------------------------------------------------ chaos finding after R4-6

#[test]
fn bob_aborts_only_when_the_ethereum_leg_is_settled_for_good() {
    // Found by the chaos test (seed 0xc4a05eed, scenario 2425) once R4-6 let an abort be recorded after the lock was seen: the lock was
    // closed in a block that a reorg could still take back (or was not shown by the poll), `aborted` was written, and the ETH lock was open
    // again later with no one to refund it. The abort waits until the lock is closed in a final block.
    use swap_cli::engine::decide;
    let mut s = Scenario::new(Variant::Raw);
    s.run_to_lock_final();
    assert_eq!(s.tick_alice().action.kind(), "reveal_eth");
    s.world.borrow_mut().advance_eth(1); // Alice's claim is mined
    let d = s.public.params.deadline_height;
    let look = |s: &Scenario, hide_lock: bool| {
        let (mut n, mut e, now) = observe(s);
        n.tip = d - 1; // the claim branch is closed for Bob
        n.next_call_height = d;
        if hide_lock {
            e.lock = None;
            e.locks = Vec::new();
        }
        decide(&s.bob.file, &n, &e, now)
    };
    // Mined, not final: wait.
    let r = look(&s, false);
    assert_eq!(r.action.kind(), "wait", "{r:?}");
    assert!(r.notes.iter().any(|n| n.contains("not aborting yet") && n.contains("not final")), "{:?}", r.notes);
    // The poll does not show the lock at all: wait.
    let r = look(&s, true);
    assert_eq!(r.action.kind(), "wait", "{r:?}");
    assert!(r.notes.iter().any(|n| n.contains("not aborting yet") && n.contains("not visible")), "{:?}", r.notes);
    // Final: the claim branch is closed and the ETH is Alice's for good: abort.
    let lag = s.world.borrow().finality_lag;
    s.world.borrow_mut().advance_eth(lag + 1);
    let r = look(&s, false);
    assert_eq!(r.action.kind(), "abort", "{r:?}");
}

// ------------------------------------------------------------------------------------------------------------------------ chaos finding after R4-4

#[test]
fn a_done_file_whose_noid_close_was_reorged_does_not_adopt_another_lock_and_reveal_again() {
    // Found by the chaos test (seed 0xc4a05eed, scenario 2633): `done` -> recovery close recorded -> reorg -> `funding_final`, where a second matching
    // lock of Bob's address was adopted and a second reveal printed. The ETH was already received: only the NOID is left.
    use swap_cli::state::Event;
    let mut s = Scenario::new(Variant::Raw);
    s.run_to_lock_final();
    assert_eq!(s.tick_alice().action.kind(), "reveal_eth");
    s.world.borrow_mut().advance_eth(1);
    s.tick_alice();
    let lag = s.world.borrow().finality_lag;
    s.world.borrow_mut().advance_eth(lag + 2);
    s.tick_alice();
    assert_eq!(s.alice_phase(), "done");
    let now = s.now();
    let txid = "0000000000000000000000000000000000000000000000000000000000000009".to_string();
    s.alice.file.apply(&Event::NoidClosedExternally { txid: txid.clone(), height: 300_800 }, now).unwrap();
    s.alice.file.apply(&Event::NoidTxReorged { txid, was_height: 300_800, still_pending: false, preimage: None }, now).unwrap();
    assert_eq!(s.alice_phase(), "funding_final");
    // Bob's address makes a second lock on the agreed terms.
    let p = &s.public.params.eth;
    let t_reveal = s.now() + s.gates().w_a_s;
    s.world.borrow_mut().locks_after.push(swap_cli::watch::EthLock {
        lock_id: compute_lock_id(&p.bob_sender, &p.alice_receiver, p.amount_wei, &s.public.hashlock, t_reveal),
        sender: p.bob_sender,
        receiver: p.alice_receiver,
        amount_wei: p.amount_wei,
        hashlock: s.public.hashlock,
        timelock: t_reveal,
        block_number: 1,
        tx_hash: [0xdd; 32],
        claimed: false,
        refunded: false,
        receiver_is_eoa: Some(true),
        sender_is_eoa: Some(true),
        block_timestamp: Some(t_reveal - s.gates().w_a_s),
    });
    let r = s.tick_alice();
    assert!(!r.events.contains(&"eth_lock_seen".to_string()), "{r:?}");
    assert_ne!(r.action.kind(), "reveal_eth", "{r:?}");
    assert_eq!(s.alice_phase(), "funding_final");
}
