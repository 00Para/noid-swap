//! M2.3 crash/restart tests: the swap file is written before any on-chain
//! action, a party reloaded from its file continues correctly, and a pending
//! action recorded before a crash is resolved without doing anything twice.

mod common;

use common::*;
use swap_cli::params::W_A_S;
use swap_cli::secret::Variant;
use swap_cli::state::{AlicePhase, BobPhase, Phase};
use swap_cli::swapfile::SwapFile;

#[test]
fn swap_file_is_written_before_any_on_chain_action() {
    let s = Scenario::new(Variant::Raw);
    for (path, role) in [(&s.alice.path, "alice"), (&s.bob.path, "bob")] {
        let f = SwapFile::load(path).unwrap();
        assert_eq!(f.role.to_string(), role);
        assert!(f.pending_action.is_none() && f.history.is_empty());
    }
    let w = s.world.borrow();
    assert!(w.instance.is_none() && w.funding_pending.is_none() && w.lock.is_none());
    // Alice's file holds the secret sealed; Bob's holds none.
    let a = SwapFile::load(&s.alice.path).unwrap();
    assert!(a.secret.is_some());
    assert!(SwapFile::load(&s.bob.path).unwrap().secret.is_none());
    let text = std::fs::read_to_string(&s.alice.path).unwrap();
    assert!(!text.contains(&hex::encode(s.secret.bytes())));
}

#[test]
fn restarting_both_parties_before_every_tick_reaches_the_same_outcome() {
    let mut s = Scenario::new(Variant::Raw);
    macro_rules! tick_both_fresh {
        () => {{
            s.restart_alice();
            s.restart_bob();
            s.tick_both()
        }};
    }
    tick_both_fresh!(); // Alice funds
    s.world.borrow_mut().advance_noid(1);
    tick_both_fresh!(); // both see the instance
    s.world.borrow_mut().advance_noid(18);
    tick_both_fresh!(); // final; Bob locks
    assert_eq!(s.bob_phase(), "lock_submitted");
    s.world.borrow_mut().advance_eth(4);
    tick_both_fresh!(); // lock seen (final for Alice on the next tick)
    tick_both_fresh!();
    assert_eq!(s.alice_phase(), "reveal_submitted");
    tick_both_fresh!(); // Bob sees the preimage and claims
    assert_eq!(s.bob_phase(), "claim_submitted");
    s.world.borrow_mut().advance_eth(4);
    s.world.borrow_mut().advance_noid(19);
    tick_both_fresh!();
    tick_both_fresh!();
    assert!(matches!(s.alice.file.phase, Phase::Alice(AlicePhase::Done { .. })), "{}", s.alice_phase());
    assert!(matches!(s.bob.file.phase, Phase::Bob(BobPhase::Done { .. })), "{}", s.bob_phase());
    let w = s.world.borrow();
    assert_eq!(w.noid_payout.as_ref().unwrap().0, s.public.params.bob_noid);
    assert_eq!(w.eth_payout.unwrap().0, s.public.params.eth.alice_receiver);
    assert_eq!(w.lock_count, 1);
    // The history on disk tells the whole story.
    let a = SwapFile::load(&s.alice.path).unwrap();
    let names: Vec<_> = a.history.iter().map(|h| h.to.as_str()).collect();
    assert_eq!(
        names,
        ["funding_submitted", "funded", "funding_final", "lock_seen", "lock_final", "reveal_submitted", "revealed", "done"]
    );
}

#[test]
fn pending_lock_recorded_before_a_crash_is_resent_with_the_same_t_reveal() {
    let mut s = Scenario::new(Variant::Raw);
    s.tick_alice();
    s.world.borrow_mut().advance_noid(1);
    s.tick_both();
    s.world.borrow_mut().advance_noid(18);
    s.tick_alice();
    // Bob decides to lock; the process dies right after recording the intent (outcome unknown).
    s.bob.executor.crash_before_effect.insert("lock_eth");
    let rb = s.tick_bob();
    assert_eq!(rb.action.kind(), "lock_eth");
    assert!(rb.exec_error.is_some());
    let pending = SwapFile::load(&s.bob.path).unwrap().pending_action.expect("pending recorded on disk");
    assert_eq!(pending.kind, "lock_eth");
    assert!(pending.maybe_sent);
    let t0 = pending.detail["t_reveal"].as_u64().unwrap();
    assert_eq!(t0, s.now() + W_A_S);
    // Ten minutes later Bob restarts: same T_reveal, not a fresh now + W_A.
    s.world.borrow_mut().advance_eth(50);
    s.restart_bob();
    let rb = s.tick_bob();
    assert_eq!(rb.attempt, 2);
    match rb.action {
        swap_cli::engine::Action::LockEth { t_reveal, .. } => assert_eq!(t_reveal, t0),
        other => panic!("{other:?}"),
    }
    assert!(rb.notes.iter().any(|n| n.contains("resending")), "{:?}", rb.notes);
    assert!(s.bob.file.pending_action.is_none());
    s.world.borrow_mut().advance_eth(1);
    assert_eq!(s.world.borrow().lock.as_ref().unwrap().timelock, t0);
    assert_eq!(s.world.borrow().lock_count, 1);
}

#[test]
fn lock_that_took_effect_before_the_crash_is_recognized_not_repeated() {
    let mut s = Scenario::new(Variant::Raw);
    s.tick_alice();
    s.world.borrow_mut().advance_noid(1);
    s.tick_both();
    s.world.borrow_mut().advance_noid(18);
    s.tick_alice();
    s.bob.executor.crash_after_effect.insert("lock_eth");
    let rb = s.tick_bob();
    assert!(rb.exec_error.unwrap().contains("simulated crash"));
    assert_eq!(s.bob_phase(), "funding_final");
    assert_eq!(SwapFile::load(&s.bob.path).unwrap().pending_action.unwrap().kind, "lock_eth");
    s.world.borrow_mut().advance_eth(1); // the lock lands anyway
    s.restart_bob();
    let rb = s.tick_bob();
    assert_eq!(rb.events, vec!["eth_lock_seen"]);
    assert_eq!(rb.action.kind(), "wait");
    assert_eq!(s.bob_phase(), "locked");
    assert!(s.bob.file.pending_action.is_none());
    assert_eq!(s.bob.executor.count("lock_eth"), 0);
    assert_eq!(s.world.borrow().lock_count, 1);
}

#[test]
fn unresolved_pending_lock_is_never_dropped_or_turned_into_an_abort() {
    let mut s = Scenario::new(Variant::Raw);
    s.tick_alice();
    s.world.borrow_mut().advance_noid(1);
    s.tick_both();
    s.world.borrow_mut().advance_noid(18);
    s.tick_alice();
    // The lock was sent but the outcome never recorded.
    s.bob.executor.crash_after_effect.insert("lock_eth");
    s.tick_bob();
    assert_eq!(SwapFile::load(&s.bob.path).unwrap().pending_action.unwrap().kind, "lock_eth");
    // Long after his lock window: without the pending record Bob would abort. He must not.
    s.world.borrow_mut().advance_noid(300);
    s.restart_bob();
    let rb = s.tick_bob();
    assert_eq!(rb.action.kind(), "wait", "{rb:?}");
    assert!(matches!(&rb.action, swap_cli::engine::Action::Wait { reason } if reason.contains("unknown")));
    assert_eq!(s.bob_phase(), "funding_final");
    assert!(s.bob.file.pending_action.is_some(), "the record survives");
    assert_eq!(s.bob.executor.count("lock_eth"), 0);
    // The lock lands: the fact resolves the record and Bob carries on with THAT lock.
    s.world.borrow_mut().advance_eth(1);
    let rb = s.tick_bob();
    assert_eq!(rb.events, vec!["eth_lock_seen"]);
    assert_eq!(s.bob_phase(), "locked");
    assert!(s.bob.file.pending_action.is_none());
    assert_eq!(s.world.borrow().lock_count, 1);
}

#[test]
fn unresolved_pending_funding_is_never_retried_blindly() {
    let mut s = Scenario::new(Variant::Raw);
    s.alice.executor.crash_after_effect.insert("fund_noid");
    let ra = s.tick_alice();
    assert_eq!(ra.action.kind(), "fund_noid");
    assert!(ra.exec_error.unwrap().contains("unknown"));
    assert_eq!(s.alice_phase(), "created");
    // Restart: the engine wants to fund again, but a second funding would create a
    // second instance (anyone could close it to Bob after the reveal). It waits.
    s.restart_alice();
    let ra = s.tick_alice();
    assert_eq!(ra.action.kind(), "wait", "{ra:?}");
    assert_eq!(s.alice.executor.count("fund_noid"), 0);
    assert!(s.alice.file.pending_action.is_some());
    // The funding lands: resolved.
    s.world.borrow_mut().advance_noid(1);
    let ra = s.tick_alice();
    assert_eq!(ra.events, vec!["noid_instance_seen"]);
    assert_eq!(s.alice_phase(), "funded");
    assert!(s.alice.file.pending_action.is_none());
    assert_eq!(s.alice.executor.count("fund_noid"), 0);
    // By contrast, a funding the executor KNOWS it did not send is retried at once.
    let mut s2 = Scenario::new(Variant::Raw);
    s2.alice.executor.offline_for.insert("fund_noid");
    let ra = s2.tick_alice();
    assert!(ra.exec_error.is_some());
    assert!(!SwapFile::load(&s2.alice.path).unwrap().pending_action.unwrap().maybe_sent);
    s2.alice.executor.offline_for.clear();
    let ra = s2.tick_alice();
    assert_eq!(ra.action.kind(), "fund_noid");
    assert_eq!(ra.attempt, 2);
    assert_eq!(ra.outcome.as_ref().map(|e| e.name()), Some("funding_submitted".into()));
}

#[test]
fn claim_submitted_before_a_crash_keeps_being_tracked() {
    let mut s = Scenario::new(Variant::Raw);
    s.run_to_lock_final();
    s.tick_alice();
    s.tick_bob();
    let txid = match &s.bob.file.phase {
        Phase::Bob(BobPhase::ClaimSubmitted { txid, .. }) => txid.clone(),
        other => panic!("{other:?}"),
    };
    s.restart_bob();
    s.world.borrow_mut().advance_noid(1);
    let rb = s.tick_bob();
    assert_eq!(rb.events, vec!["noid_tx_included"]);
    assert_eq!(s.bob.executor.count("claim_noid"), 0);
    let w = s.world.borrow();
    assert_eq!(w.confirmed.get(&txid).copied(), Some(w.tip), "included in the block just mined");
    drop(w);
    s.world.borrow_mut().advance_noid(18);
    s.tick_bob();
    assert!(matches!(s.bob.file.phase, Phase::Bob(BobPhase::Done { .. })));
}

#[test]
fn claim_that_took_effect_before_the_crash_is_not_reproved_into_and_not_looped() {
    let mut s = Scenario::new(Variant::Raw);
    s.run_to_lock_final();
    s.tick_alice();
    s.bob.executor.crash_after_effect.insert("claim_noid");
    let rb = s.tick_bob();
    assert!(rb.exec_error.is_some());
    assert_eq!(s.bob_phase(), "secret_seen");
    assert_eq!(s.world.borrow().mempool.len(), 1, "the first submission is pending");
    // Restart: the file never learned the txid, so the watcher reports a pending close it
    // does not own. The engine does not burn a proof into it (first-seen would refuse the
    // second spend anyway, T2) and holds the unknown-outcome record.
    s.restart_bob();
    let rb = s.tick_bob();
    assert_eq!(rb.action.kind(), "wait", "{rb:?}");
    assert_eq!(s.bob.executor.count("claim_noid"), 0);
    assert_eq!(s.world.borrow().mempool.len(), 1);
    // The first submission is included: Bob is paid, but his file never learned its txid.
    s.world.borrow_mut().advance_noid(1);
    let rb = s.tick_bob();
    assert_eq!(rb.action.kind(), "wait");
    assert!(
        matches!(&rb.action, swap_cli::engine::Action::Wait { reason } if reason.contains("verify") || reason.contains("unknown")),
        "{rb:?}"
    );
    assert_eq!(s.world.borrow().noid_payout.as_ref().unwrap().0, s.public.params.bob_noid);
    assert_eq!(s.bob.executor.count("claim_noid"), 0, "no re-proof, no loop");
}
