//! REVIEW-2 F3: the intent ledger of the `tick --apply` path. The operator sends every spending
//! action outside the tool, so the swap file must remember "this was already decided": repeated
//! ticks never emit the same spending action twice (no double lock, no double funding), an
//! intent resolves when the chain shows its effect, can be cancelled while it does not, and
//! survives a restart. These tests drive `engine::tick_apply` (what the CLI calls) on a copy of
//! each party's file, and play the operator with the simulator's executor.

mod common;

use common::*;
use swap_cli::engine::{cancel_intent, tick_apply, Action, Executor, IntentStatus, MIN_CANCEL_AGE_S};
use swap_cli::secret::Variant;
use swap_cli::swapfile::SwapFile;
use swap_cli::watch::{EthObservation, NoidInstance, NoidObservation};

fn observe(s: &Scenario) -> (NoidObservation, EthObservation, u64) {
    let w = s.world.borrow();
    (w.noid_obs(None), w.eth_obs(), w.eth_time)
}

/// One `tick --apply`: observe, decide, apply, ledger, save (the CLI saves before printing).
fn apply(s: &Scenario, file: &mut SwapFile, path: &std::path::Path) -> swap_cli::engine::TickOutcome {
    let (n, e, now) = observe(s);
    let out = tick_apply(file, &n, &e, now, true).unwrap();
    file.save(path).unwrap();
    out
}

fn wait_reason(out: &swap_cli::engine::TickOutcome) -> String {
    match &out.decision.action {
        Action::Wait { reason } => reason.clone(),
        other => panic!("expected wait, got {other:?}"),
    }
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

#[test]
fn repeated_apply_ticks_never_emit_a_second_lock_eth() {
    let mut s = bob_ready_to_lock();
    let path = s.dir.path().join("bob-ops.swap.json");
    let mut bob = s.bob.file.clone();
    bob.save(&path).unwrap();

    // First tick: the lock is decided, recorded BEFORE it is printed (the file on disk has it).
    let out1 = apply(&s, &mut bob, &path);
    let Action::LockEth { t_reveal, .. } = out1.decision.action.clone() else { panic!("{:?}", out1.decision) };
    let IntentStatus::Recorded(intent) = &out1.intent else { panic!("{:?}", out1.intent) };
    assert_eq!(intent.action, "lock_eth");
    assert_eq!(intent.params["t_reveal"], t_reveal);
    assert_eq!(SwapFile::load(&path).unwrap().pending_intent.as_ref(), Some(intent));
    assert!(bob.history.iter().any(|h| h.event == "intent_decided:lock_eth"));

    // The operator sends it (outside the tool). The lock is not mined yet.
    let now = s.now();
    s.bob.executor.execute(&bob, &out1.decision.action, now).unwrap();

    // Ten more ticks, a restart from disk in the middle: never a second lock, always the frozen intent.
    for i in 0..10 {
        if i == 5 {
            bob = SwapFile::load(&path).unwrap();
        }
        let out = apply(&s, &mut bob, &path);
        assert_ne!(out.decision.action.kind(), "lock_eth", "tick {i}: {:?}", out.decision);
        let reason = wait_reason(&out);
        assert!(reason.contains("intent lock_eth pending") && reason.contains("--cancel"), "{reason}");
        assert!(matches!(&out.intent, IntentStatus::Held(h) if h == intent), "{:?}", out.intent);
        assert!(out.decision.notes.iter().any(|n| n.contains("frozen parameters") && n.contains(&t_reveal.to_string())), "{:?}", out.decision.notes);
    }
    assert_eq!(s.bob.executor.count("lock_eth"), 1);
    assert_eq!(s.world.borrow().lock_count, 0);

    // The chain shows the lock: the intent resolves into the history and the phase moves.
    s.world.borrow_mut().advance_eth(1);
    let out = apply(&s, &mut bob, &path);
    assert!(matches!(&out.intent, IntentStatus::Resolved(h) if h.action == "lock_eth"), "{:?}", out.intent);
    assert!(out.decision.events.iter().any(|e| e.name() == "eth_lock_seen"), "{:?}", out.decision.events);
    assert!(bob.pending_intent.is_none());
    assert!(bob.history.iter().any(|h| h.event == "intent_resolved:lock_eth"));
    assert_eq!(bob.phase.name(), "locked");
    assert_eq!(s.world.borrow().lock_count, 1);
}

#[test]
fn a_read_only_tick_records_nothing_but_still_holds_an_existing_intent() {
    let s = bob_ready_to_lock();
    let (n, e, now) = observe(&s);
    let mut dry = s.bob.file.clone();
    let out = tick_apply(&mut dry, &n, &e, now, false).unwrap();
    assert_eq!(out.decision.action.kind(), "lock_eth");
    assert_eq!(out.intent, IntentStatus::None);
    assert!(dry.pending_intent.is_none());
    // With an intent on file, a read-only tick shows the hold.
    let mut with = s.bob.file.clone();
    tick_apply(&mut with, &n, &e, now, true).unwrap();
    let mut copy = with.clone();
    let out = tick_apply(&mut copy, &n, &e, now, false).unwrap();
    assert!(wait_reason(&out).contains("intent lock_eth pending"));
    assert!(matches!(out.intent, IntentStatus::Held(_)));
}

#[test]
fn cancel_then_re_decide_works_but_cancel_is_refused_once_the_chain_shows_the_effect() {
    let mut s = bob_ready_to_lock();
    let path = s.dir.path().join("bob-ops.swap.json");
    let mut bob = s.bob.file.clone();
    let out1 = apply(&s, &mut bob, &path);
    assert!(matches!(out1.intent, IntentStatus::Recorded(_)));
    // Nothing was sent: cancel (the chain shows nothing, the signer has nothing pending, the intent is old enough),
    // history records it, the next tick decides afresh.
    let (n, e, now) = observe(&s);
    let now = now + MIN_CANCEL_AGE_S;
    let cancelled = cancel_intent(&mut bob, &n, &e, now).unwrap();
    assert_eq!(cancelled.action, "lock_eth");
    assert!(bob.pending_intent.is_none());
    assert!(bob.history.iter().any(|h| h.event == "intent_cancelled:lock_eth"));
    assert_eq!(cancel_intent(&mut bob, &n, &e, now).unwrap_err(), "no pending intent");
    let out2 = apply(&s, &mut bob, &path);
    assert_eq!(out2.decision.action.kind(), "lock_eth");
    assert!(matches!(out2.intent, IntentStatus::Recorded(_)));
    // Now it IS sent and mined: cancelling would let a second lock out, so it is refused.
    let now = s.now();
    s.bob.executor.execute(&bob, &out2.decision.action, now).unwrap();
    s.world.borrow_mut().advance_eth(1);
    let (n, e, now) = observe(&s);
    let err = cancel_intent(&mut bob, &n, &e, now + MIN_CANCEL_AGE_S).unwrap_err();
    assert!(err.contains("already shows the effect"), "{err}");
    assert!(bob.pending_intent.is_some(), "a refused cancel leaves the intent alone");
}

#[test]
fn alice_never_funds_twice_and_a_foreign_instance_is_not_a_reason_to_fund() {
    let mut s = Scenario::new(Variant::Raw);
    let path = s.dir.path().join("alice-ops.swap.json");
    let mut alice = s.alice.file.clone();
    let out1 = apply(&s, &mut alice, &path);
    assert!(matches!(out1.decision.action, Action::FundNoid { .. }), "{:?}", out1.decision);
    assert!(matches!(out1.intent, IntentStatus::Recorded(_)));
    let now = s.now();
    s.alice.executor.execute(&alice, &out1.decision.action, now).unwrap();
    // Funding is in the mempool, not visible yet: every tick holds.
    for _ in 0..5 {
        let out = apply(&s, &mut alice, &path);
        assert!(wait_reason(&out).contains("intent fund_noid pending"));
    }
    assert_eq!(s.alice.executor.count("fund_noid"), 1);
    s.world.borrow_mut().advance_noid(1);
    let out = apply(&s, &mut alice, &path);
    assert!(matches!(&out.intent, IntentStatus::Resolved(h) if h.action == "fund_noid"));
    assert_eq!(alice.phase.name(), "funded");
    assert_eq!(out.decision.action.kind(), "wait");

    // A different swap file at "created" facing an instance it does not accept (wrong amount): no fund_noid.
    let s2 = Scenario::new(Variant::Raw);
    s2.world.borrow_mut().instance = Some(NoidInstance { slot_index: 3, creation_id: 9, amount_micronoid: 1 });
    let mut a2 = s2.alice.file.clone();
    let (n, e, now) = observe(&s2);
    let out = tick_apply(&mut a2, &n, &e, now, true).unwrap();
    assert!(wait_reason(&out).contains("is not counted as a funding"), "{:?}", out.decision);
    assert!(a2.pending_intent.is_none());
}

#[test]
fn reveal_eth_intent_holds_until_the_claim_is_mined() {
    let mut s = Scenario::new(Variant::Raw);
    s.run_to_lock_final();
    let path = s.dir.path().join("alice-ops.swap.json");
    let mut alice = s.alice.file.clone();
    let out1 = apply(&s, &mut alice, &path);
    // The first tick of this copy may only derive the lock-final fact; the next offers the reveal.
    let out1 = if out1.decision.action.kind() == "reveal_eth" { out1 } else { apply(&s, &mut alice, &path) };
    assert_eq!(out1.decision.action.kind(), "reveal_eth", "{:?}", out1.decision);
    let now = s.now();
    s.alice.executor.execute(&alice, &out1.decision.action, now).unwrap();
    for _ in 0..4 {
        let out = apply(&s, &mut alice, &path);
        assert!(wait_reason(&out).contains("intent reveal_eth pending"), "{:?}", out.decision);
    }
    assert_eq!(s.alice.executor.count("reveal_eth"), 1);
    s.world.borrow_mut().advance_eth(1);
    let out = apply(&s, &mut alice, &path);
    assert!(matches!(&out.intent, IntentStatus::Resolved(h) if h.action == "reveal_eth"), "{:?}", out.intent);
    assert_eq!(alice.phase.name(), "revealed");
}

#[test]
fn refund_eth_and_refund_noid_intents_hold_and_resolve() {
    // Bob: locked, Alice never reveals, T_reveal passes.
    let mut s = Scenario::new(Variant::Raw);
    s.run_to_lock_final();
    let t_reveal = s.world.borrow().lock.as_ref().unwrap().timelock;
    s.world.borrow_mut().warp_eth_to(t_reveal);
    let path = s.dir.path().join("bob-ops.swap.json");
    let mut bob = s.bob.file.clone();
    let out1 = apply(&s, &mut bob, &path);
    assert_eq!(out1.decision.action.kind(), "refund_eth", "{:?}", out1.decision);
    let now = s.now();
    s.bob.executor.execute(&bob, &out1.decision.action, now).unwrap();
    let out = apply(&s, &mut bob, &path);
    assert!(wait_reason(&out).contains("intent refund_eth pending"));
    s.world.borrow_mut().advance_eth(1);
    let out = apply(&s, &mut bob, &path);
    assert!(matches!(&out.intent, IntentStatus::Resolved(h) if h.action == "refund_eth"), "{:?}", out.intent);
    // M2.5b: the refund is mined, which resolves the intent; the file says `refunded` once Ethereum finalized it.
    assert_eq!(bob.phase.name(), "refund_mined");
    let lag = s.world.borrow().finality_lag;
    s.world.borrow_mut().advance_eth(lag);
    apply(&s, &mut bob, &path);
    assert_eq!(bob.phase.name(), "refunded");

    // Alice: funded and final, nobody locks, the chain reaches D.
    let mut s = Scenario::new(Variant::Raw);
    s.tick_alice();
    s.world.borrow_mut().advance_noid(1);
    s.tick_alice();
    s.world.borrow_mut().advance_noid(18);
    s.tick_alice();
    let tip = s.world.borrow().tip;
    s.world.borrow_mut().advance_noid(s.public.params.deadline_height - 1 - tip);
    let path = s.dir.path().join("alice-ops.swap.json");
    let mut alice = s.alice.file.clone();
    let out1 = apply(&s, &mut alice, &path);
    assert_eq!(out1.decision.action.kind(), "refund_noid", "{:?}", out1.decision);
    let now = s.now();
    s.alice.executor.execute(&alice, &out1.decision.action, now).unwrap();
    let out = apply(&s, &mut alice, &path);
    assert!(wait_reason(&out).contains("intent refund_noid pending"), "{:?}", out.decision);
    s.world.borrow_mut().advance_noid(1); // the recovery close is included: the instance is gone
    let out = apply(&s, &mut alice, &path);
    assert!(matches!(&out.intent, IntentStatus::Resolved(h) if h.action == "refund_noid"), "{:?}", out.intent);
    assert_eq!(out.decision.action.kind(), "wait", "no second refund_noid once the instance is gone: {:?}", out.decision);
    assert!(wait_reason(&out).contains("nothing to refund"));
}

#[test]
fn f9_alices_refund_after_the_reveal_is_one_intent_that_resolves_only_when_the_instance_is_gone() {
    let mut s = Scenario::new(Variant::Raw);
    s.run_to_lock_final();
    s.tick_alice();
    s.world.borrow_mut().advance_eth(4);
    s.tick_alice();
    assert_eq!(s.alice_phase(), "done");
    let d = s.public.params.deadline_height;
    let tip = s.world.borrow().tip;
    s.world.borrow_mut().advance_noid(d - 1 - tip);
    let path = s.dir.path().join("alice-ops.swap.json");
    let mut alice = s.alice.file.clone();
    let out1 = apply(&s, &mut alice, &path);
    assert_eq!(out1.decision.action.kind(), "refund_noid", "{:?}", out1.decision);
    assert!(matches!(&out1.intent, IntentStatus::Recorded(i) if i.action == "refund_noid" && i.phase_at_decision == "done"), "{:?}", out1.intent);
    let now = s.now();
    s.alice.executor.execute(&alice, &out1.decision.action, now).unwrap();
    for _ in 0..2 {
        let out = apply(&s, &mut alice, &path);
        assert!(wait_reason(&out).contains("intent refund_noid pending"), "{:?}", out.decision);
    }
    s.world.borrow_mut().advance_noid(1);
    let out = apply(&s, &mut alice, &path);
    assert!(matches!(&out.intent, IntentStatus::Resolved(h) if h.action == "refund_noid"), "{:?}", out.intent);
    assert_eq!(wait_reason(&out), "done: ETH received", "no second refund_noid once the instance is gone: {:?}", out.decision);
    assert_eq!(s.alice.executor.count("refund_noid"), 1);
}

#[test]
fn f9_a_pending_refund_eth_intent_neither_holds_bobs_claim_nor_resolves_before_the_lock_closes() {
    let mut s = Scenario::new(Variant::Raw);
    s.run_to_lock_final();
    s.world.borrow_mut().freeze_eth_claim = true;
    s.tick_alice(); // the reveal is pending and stalled
    let t_reveal = s.world.borrow().lock.as_ref().unwrap().timelock;
    s.world.borrow_mut().warp_eth_to(t_reveal);
    // A foreign close is pending on the instance: the NOID side only waits, so the ETH refund is the action.
    s.world.borrow_mut().mempool.push(SimTx {
        txid: "f".repeat(64),
        fee: 5_800,
        admitted: 300_019,
        call_height: 300_020,
        kind: SimKind::Claim { preimage: *s.secret.bytes() },
    });
    let path = s.dir.path().join("bob-ops.swap.json");
    let mut bob = s.bob.file.clone();
    let out1 = apply(&s, &mut bob, &path);
    assert_eq!(out1.decision.action.kind(), "refund_eth", "{:?}", out1.decision);
    assert!(matches!(&out1.intent, IntentStatus::Recorded(i) if i.action == "refund_eth" && i.phase_at_decision == "secret_seen"), "{:?}", out1.intent);
    assert_eq!(bob.phase.name(), "secret_seen");
    let out2 = apply(&s, &mut bob, &path);
    assert!(wait_reason(&out2).contains("intent refund_eth pending"), "{:?}", out2.decision);
    // The foreign close is evicted: Bob's claim is a different action and goes out while the refund intent is pending.
    s.world.borrow_mut().evict_all();
    let out3 = apply(&s, &mut bob, &path);
    assert_eq!(out3.decision.action.kind(), "claim_noid", "{:?}", out3.decision);
    assert!(matches!(&out3.intent, IntentStatus::Held(i) if i.action == "refund_eth"), "{:?}", out3.intent);
    assert!(out3.decision.notes.iter().any(|n| n.contains("refund_eth intent is still pending")), "{:?}", out3.decision.notes);
    // The operator sends the refund; it resolves when the lock is refunded, not when the phase moves.
    let now = s.now();
    s.bob.executor.execute(&bob, &out1.decision.action, now).unwrap();
    s.world.borrow_mut().advance_eth(1);
    let out4 = apply(&s, &mut bob, &path);
    assert!(matches!(&out4.intent, IntentStatus::Resolved(h) if h.action == "refund_eth"), "{:?}", out4.intent);
    assert_eq!(bob.phase.name(), "secret_seen");
    assert!(bob.history.iter().any(|h| h.event == "eth_refund_mined"));
}

// ---------------------------------------------------------------- REVIEW-3 F3: a cancel fails closed while a send may be pending

#[test]
fn f3_cancel_is_refused_while_the_intent_is_younger_than_the_minimum_age() {
    let s = bob_ready_to_lock();
    let path = s.dir.path().join("bob-ops.swap.json");
    let mut bob = s.bob.file.clone();
    let out = apply(&s, &mut bob, &path);
    let IntentStatus::Recorded(intent) = &out.intent else { panic!("{:?}", out.intent) };
    let (n, e, _) = observe(&s);
    for age in [0, 1, MIN_CANCEL_AGE_S - 1] {
        let err = cancel_intent(&mut bob, &n, &e, intent.decided_at + age).unwrap_err();
        assert!(err.contains("younger than 600 s") && err.contains(&format!("{age} s old")) && err.contains("REVIEW-3 F3"), "{err}");
        assert!(bob.pending_intent.is_some(), "a refused cancel leaves the intent alone");
    }
    // At the minimum age, with nothing pending and the nonces known, the cancel goes through.
    cancel_intent(&mut bob, &n, &e, intent.decided_at + MIN_CANCEL_AGE_S).unwrap();
    assert!(bob.pending_intent.is_none());
}

#[test]
fn f3_cancel_is_refused_while_the_signers_lock_sits_in_the_ethereum_mempool() {
    let mut s = bob_ready_to_lock();
    let path = s.dir.path().join("bob-ops.swap.json");
    let mut bob = s.bob.file.clone();
    let out1 = apply(&s, &mut bob, &path);
    assert!(matches!(out1.decision.action, Action::LockEth { .. }));
    // The operator sends the lock; it sits in the mempool (not mined): the signer's pending nonce is one above latest.
    let now = s.now();
    s.bob.executor.execute(&bob, &out1.decision.action, now).unwrap();
    assert_eq!(s.world.borrow().lock_count, 0);
    let (n, e, now) = observe(&s);
    assert_eq!((e.signer_nonce_latest, e.signer_nonce_pending), (Some(7), Some(8)));
    // An hour later (old enough), the chain shows no lock and no effect: the OLD rule alone would let this cancel through,
    // and the next tick would decide a second lock_eth with a new T_reveal.
    let err = cancel_intent(&mut bob, &n, &e, now + 3600).unwrap_err();
    assert!(err.contains("pending nonce 8 > latest nonce 7") && err.contains("lock_eth"), "{err}");
    assert!(bob.pending_intent.is_some());
    assert!(!bob.history.iter().any(|h| h.event.starts_with("intent_cancelled")));
    // Once the lock is mined the effect is on chain, which is the older rule's refusal.
    s.world.borrow_mut().advance_eth(1);
    let (n, e, now) = observe(&s);
    assert_eq!(e.signer_nonce_latest, e.signer_nonce_pending);
    let err = cancel_intent(&mut bob, &n, &e, now + 3600).unwrap_err();
    assert!(err.contains("already shows the effect"), "{err}");
}

#[test]
fn f3_cancel_is_refused_when_the_signers_nonces_are_unknown() {
    let s = bob_ready_to_lock();
    let path = s.dir.path().join("bob-ops.swap.json");
    let mut bob = s.bob.file.clone();
    apply(&s, &mut bob, &path);
    let (n, e, now) = observe(&s);
    let late = now + 3600;
    let mut gaps = vec![e.clone(), e.clone(), e.clone()];
    gaps[0].signer_nonce_latest = None;
    gaps[1].signer_nonce_pending = None;
    gaps[2].signer_nonce_latest = None;
    gaps[2].signer_nonce_pending = None;
    for g in &gaps {
        let err = cancel_intent(&mut bob, &n, g, late).unwrap_err();
        assert!(err.contains("nonces are unknown") && err.contains("REVIEW-3 F3"), "{err}");
        assert!(bob.pending_intent.is_some());
    }
    // A pending nonce at or below the latest one is "nothing in the mempool".
    cancel_intent(&mut bob, &n, &e, late).unwrap();
}

#[test]
fn f3_cancel_of_a_reveal_or_a_refund_eth_is_refused_while_the_signers_transaction_is_pending() {
    // Alice's reveal, sent and stalled in the mempool.
    let mut s = Scenario::new(Variant::Raw);
    s.run_to_lock_final();
    s.world.borrow_mut().freeze_eth_claim = true;
    let path = s.dir.path().join("alice-ops.swap.json");
    let mut alice = s.alice.file.clone();
    let out1 = apply(&s, &mut alice, &path);
    let out1 = if out1.decision.action.kind() == "reveal_eth" { out1 } else { apply(&s, &mut alice, &path) };
    assert_eq!(out1.decision.action.kind(), "reveal_eth", "{:?}", out1.decision);
    let IntentStatus::Recorded(intent) = &out1.intent else { panic!("{:?}", out1.intent) };
    // The reveal intent carries the lock's T_reveal and the cutoff the file's M_A gives (live.js claim --swap reads them).
    let t_reveal = s.world.borrow().lock.as_ref().unwrap().timelock;
    assert_eq!(intent.params["t_reveal"], t_reveal);
    assert_eq!(intent.params["cutoff"], t_reveal - swap_cli::params::M_A_S);
    let now = s.now();
    s.alice.executor.execute(&alice, &out1.decision.action, now).unwrap();
    let (n, e, now) = observe(&s);
    let err = cancel_intent(&mut alice, &n, &e, now + 3600).unwrap_err();
    assert!(err.contains("reveal_eth") && err.contains("pending nonce 8 > latest nonce 7"), "{err}");

    // Bob's refund, sent and not mined.
    let mut s = Scenario::new(Variant::Raw);
    s.run_to_lock_final();
    let t_reveal = s.world.borrow().lock.as_ref().unwrap().timelock;
    s.world.borrow_mut().warp_eth_to(t_reveal);
    let path = s.dir.path().join("bob-ops.swap.json");
    let mut bob = s.bob.file.clone();
    let out1 = apply(&s, &mut bob, &path);
    assert_eq!(out1.decision.action.kind(), "refund_eth", "{:?}", out1.decision);
    let now = s.now();
    s.bob.executor.execute(&bob, &out1.decision.action, now).unwrap();
    let (n, e, now) = observe(&s);
    let err = cancel_intent(&mut bob, &n, &e, now + 3600).unwrap_err();
    assert!(err.contains("refund_eth") && err.contains("pending nonce 8 > latest nonce 7"), "{err}");
    assert!(bob.pending_intent.is_some());
}

#[test]
fn f3_cancel_of_a_refund_noid_is_refused_while_a_call_sits_in_the_parano1d_mempool() {
    let mut s = Scenario::new(Variant::Raw);
    s.tick_alice();
    s.world.borrow_mut().advance_noid(1);
    s.tick_alice();
    s.world.borrow_mut().advance_noid(18);
    s.tick_alice();
    let tip = s.world.borrow().tip;
    s.world.borrow_mut().advance_noid(s.public.params.deadline_height - 1 - tip);
    let path = s.dir.path().join("alice-ops.swap.json");
    let mut alice = s.alice.file.clone();
    let out1 = apply(&s, &mut alice, &path);
    assert_eq!(out1.decision.action.kind(), "refund_noid", "{:?}", out1.decision);
    let now = s.now();
    s.alice.executor.execute(&alice, &out1.decision.action, now).unwrap();
    // The recovery close sits in the mempool: not included, instance still there.
    let (n, e, now) = observe(&s);
    assert!(!n.pending_calls.is_empty());
    let err = cancel_intent(&mut alice, &n, &e, now + 3600).unwrap_err();
    assert!(err.contains("Parano1d mempool") && err.contains(&n.pending_calls[0].txid), "{err}");
    assert!(alice.pending_intent.is_some());
    // Evicted: nothing pending any more, the instance is still funded, so the cancel is allowed.
    s.world.borrow_mut().evict_all();
    let (n, e, now) = observe(&s);
    assert!(n.pending_calls.is_empty());
    cancel_intent(&mut alice, &n, &e, now + 3600).unwrap();
}
