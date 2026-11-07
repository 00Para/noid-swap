//! One scenario or unit test per fixed finding of `CHAOS.md` (F-1, F-3, F-4, F-5, F-9, F-12, F-13, F-15, F-16). Each of them fails on
//! the code as it was when the chaos test found the finding and passes now; the chaos test itself no longer lets any of these symptoms
//! through (`tests/chaos.rs`). Driven on the simulator of `common/`.

mod common;

use common::*;
use swap_cli::engine::{cancel_intent, cancel_intent_checked, tick_apply, Action, ETH_TX_GRACE_S};
use swap_cli::secret::Variant;
use swap_cli::state::{AlicePhase, BobPhase, Event, Phase};
use swap_cli::swapfile::SwapFile;
use swap_cli::watch::{EthObservation, NoidObservation, PendingPreimage};

fn observe(s: &Scenario) -> (NoidObservation, EthObservation, u64) {
    let w = s.world.borrow();
    (w.noid_obs(None), w.eth_obs(), w.eth_time)
}

fn lock_of(s: &Scenario) -> (/* lock_id */ [u8; 32], /* t_reveal */ u64) {
    let w = s.world.borrow();
    let l = w.lock.as_ref().expect("a lock");
    (l.lock_id, l.timelock)
}

/// Alice has revealed and her claim is mined (not final yet); Bob has claimed.
fn revealed() -> Scenario {
    let mut s = Scenario::new(Variant::Raw);
    s.run_to_lock_final();
    assert_eq!(s.tick_alice().action.kind(), "reveal_eth");
    s.tick_bob();
    s.world.borrow_mut().advance_eth(1);
    s.world.borrow_mut().advance_noid(1);
    s.tick_both();
    assert_eq!(s.alice_phase(), "revealed");
    s
}

/// A reorg drops Alice's mined claim: the lock is open again; the transaction is back in the mempool (and held there) or gone.
fn reorg_claim(s: &Scenario, back_to_mempool: bool) {
    let mut w = s.world.borrow_mut();
    let c = w.claimed.take().expect("a mined claim");
    w.lock.as_mut().unwrap().claimed = false;
    w.eth_payout = None;
    if back_to_mempool {
        w.claim_pending = Some(PendingPreimage { lock_id: c.lock_id, preimage: c.preimage, tx_hash: c.tx_hash });
        w.freeze_eth_claim = true;
    }
}

// ------------------------------------------------------------------------------------------------------------------------ F-9

#[test]
fn f9_a_claim_that_a_reorg_dropped_never_reaches_done() {
    let mut s = revealed();
    reorg_claim(&s, true);
    // Ethereum moves on far enough that the OLD block would be final: the old code said `done` here although the ETH is not Alice's.
    s.world.borrow_mut().advance_eth(5);
    let r = s.tick_alice();
    assert!(r.events.contains(&"eth_claim_reorged".to_string()), "{r:?}");
    assert_eq!(s.alice_phase(), "reveal_submitted", "{:?}", r.notes);
    assert!(s.world.borrow().eth_payout.is_none());
    // The transaction is mined again: revealed, and only then, once final, done.
    s.world.borrow_mut().freeze_eth_claim = false;
    s.world.borrow_mut().advance_eth(1);
    s.tick_alice();
    assert_eq!(s.alice_phase(), "revealed");
    s.world.borrow_mut().advance_eth(4);
    s.tick_alice();
    assert!(matches!(s.alice.file.phase, Phase::Alice(AlicePhase::Done { .. })), "{}", s.alice_phase());
    assert_eq!(s.world.borrow().eth_payout.map(|p| p.0), Some(s.public.params.eth.alice_receiver));
}

#[test]
fn f9_a_claim_that_moved_to_a_later_block_restarts_the_finality_count() {
    let mut s = revealed();
    s.world.borrow_mut().advance_eth(3);
    {
        // Re-included at the current block (a reorg): the recorded block would already be final, the new one is not.
        let mut w = s.world.borrow_mut();
        let b = w.eth_block;
        w.claimed.as_mut().unwrap().block_number = b;
    }
    let r = s.tick_alice();
    assert_eq!(s.alice_phase(), "revealed", "{r:?}");
    assert!(r.events.contains(&"eth_claim_mined".to_string()), "{r:?}");
    let lag = s.world.borrow().finality_lag;
    s.world.borrow_mut().advance_eth(lag);
    s.tick_alice();
    assert_eq!(s.alice_phase(), "done");
}

// ------------------------------------------------------------------------------------------------------------------------ F-5

fn bob_lock_submitted() -> Scenario {
    let mut s = Scenario::new(Variant::Raw);
    s.tick_alice();
    s.world.borrow_mut().advance_noid(1);
    s.tick_both();
    s.world.borrow_mut().advance_noid(17);
    let (_, rb) = s.tick_both();
    assert_eq!(rb.action.kind(), "lock_eth", "{rb:?}");
    assert_eq!(s.bob_phase(), "lock_submitted");
    s
}

#[test]
fn f5_a_lock_transaction_that_was_dropped_is_sent_again_only_when_nothing_of_the_signer_is_pending() {
    let mut s = bob_lock_submitted();
    let original = match &s.bob.file.phase {
        Phase::Bob(BobPhase::LockSubmitted { t_reveal, .. }) => *t_reveal,
        other => panic!("{other:?}"),
    };
    s.world.borrow_mut().lock_pending = None; // dropped from the mempool
    // Inside the grace period nothing happens.
    let r = s.tick_bob();
    assert_eq!((s.bob_phase().as_str(), r.action.kind()), ("lock_submitted", "wait"));
    s.world.borrow_mut().advance_eth(ETH_TX_GRACE_S / 12 + 5);
    // A transaction of the signer in the node's mempool (pending nonce above the latest), or nonces the node did not give: not dropped.
    let r = s.tick_bob_with(|_, e| e.signer_nonce_pending = e.signer_nonce_latest.map(|n| n + 1));
    assert_eq!((s.bob_phase().as_str(), r.action.kind()), ("lock_submitted", "wait"), "{r:?}");
    let r = s.tick_bob_with(|_, e| e.signer_nonce_pending = None);
    assert_eq!((s.bob_phase().as_str(), r.action.kind()), ("lock_submitted", "wait"), "{r:?}");
    assert!(r.notes.iter().any(|n| n.contains("nonces are unknown")), "{:?}", r.notes);
    // Nothing pending, nothing on chain, the grace period over: the drop is recorded; the NEXT tick re-sends THE SAME lock (same T_reveal,
    // hence the same lock id: a duplicate that lands anyway reverts), never a fresh one under a new id (review H2).
    let r = s.tick_bob();
    assert!(r.events.contains(&"eth_lock_dropped".to_string()), "{r:?}");
    assert_eq!(r.action.kind(), "wait", "{r:?}");
    let r = s.tick_bob();
    assert!(matches!(r.action, Action::LockEth { t_reveal, .. } if t_reveal == original), "{r:?}");
    assert_eq!(s.bob_phase(), "lock_submitted");
    assert!(s.world.borrow().lock_pending.is_some());
    // And once only: the re-send is a new submission; with it pending nothing more is offered.
    let r = s.tick_bob();
    assert_eq!(r.action.kind(), "wait", "{r:?}");
}

#[test]
fn f5_a_dropped_lock_is_not_called_dropped_while_another_lock_of_bobs_sits_on_chain() {
    // A second lock of Bob's address (other terms) is not the lock he waits for; the one he waits for is found by its id.
    let mut s = bob_lock_submitted();
    s.world.borrow_mut().lock_pending = None;
    {
        let mut w = s.world.borrow_mut();
        let other = make_other_lock(&s.public, w.eth_time);
        w.locks_after.push(other);
    }
    s.world.borrow_mut().advance_eth(ETH_TX_GRACE_S / 12 + 5);
    let r = s.tick_bob();
    assert!(r.events.contains(&"eth_lock_dropped".to_string()), "{r:?}");
    assert!(matches!(s.tick_bob().action, Action::LockEth { .. }));
}

fn make_other_lock(public: &swap_cli::swapfile::SwapPublic, time: u64) -> swap_cli::watch::EthLock {
    let p = &public.params.eth;
    let t_reveal = time + 3_000;
    swap_cli::watch::EthLock {
        lock_id: swap_cli::watch::eth::compute_lock_id(&p.bob_sender, &p.alice_receiver, p.amount_wei + 1, &public.hashlock, t_reveal),
        sender: p.bob_sender,
        receiver: p.alice_receiver,
        amount_wei: p.amount_wei + 1,
        hashlock: public.hashlock,
        timelock: t_reveal,
        block_number: 50,
        tx_hash: [0xdd; 32],
        claimed: false,
        refunded: false,
        receiver_is_eoa: Some(true),
        sender_is_eoa: Some(true),
        block_timestamp: Some(time),
    }
}

#[test]
fn f5_a_reveal_that_was_dropped_is_offered_again_while_the_cutoff_allows() {
    let mut s = Scenario::new(Variant::Raw);
    s.run_to_lock_final();
    assert_eq!(s.tick_alice().action.kind(), "reveal_eth");
    assert_eq!(s.alice_phase(), "reveal_submitted");
    s.world.borrow_mut().claim_pending = None; // dropped
    let r = s.tick_alice();
    assert_eq!((s.alice_phase().as_str(), r.action.kind()), ("reveal_submitted", "wait"));
    s.world.borrow_mut().advance_eth(ETH_TX_GRACE_S / 12 + 5);
    let r = s.tick_alice();
    assert!(r.events.contains(&"eth_reveal_dropped".to_string()), "{r:?}");
    assert_eq!(r.action.kind(), "reveal_eth", "{r:?}");
    assert!(s.world.borrow().claim_pending.is_some());
    s.world.borrow_mut().advance_eth(1);
    s.tick_alice();
    assert_eq!(s.alice_phase(), "revealed");
}

#[test]
fn f5_a_refund_that_was_dropped_is_sent_again() {
    let mut s = Scenario::new(Variant::Raw);
    s.run_to_lock_final();
    let (_, timelock) = lock_of(&s);
    s.world.borrow_mut().warp_eth_to(timelock);
    let r = s.tick_bob();
    assert_eq!(r.action.kind(), "refund_eth", "{r:?}");
    assert_eq!(s.bob_phase(), "refund_submitted");
    s.world.borrow_mut().refund_pending = false; // dropped
    s.world.borrow_mut().advance_eth(ETH_TX_GRACE_S / 12 + 5);
    let r = s.tick_bob();
    assert!(r.events.contains(&"eth_refund_dropped".to_string()), "{r:?}");
    assert_eq!(r.action.kind(), "refund_eth", "{r:?}");
    assert!(s.world.borrow().refund_pending);
}

#[test]
fn f5_after_the_secret_a_refund_that_never_landed_is_not_waited_for_for_ever() {
    // Bob has the secret (Alice's claim is stuck in the mempool), T_reveal passes, he sends `refund_eth` (kept in the history only), it is dropped.
    let mut s = Scenario::new(Variant::Raw);
    s.run_to_lock_final();
    assert_eq!(s.tick_alice().action.kind(), "reveal_eth");
    s.tick_bob();
    assert_eq!(s.bob_phase(), "claim_submitted");
    s.world.borrow_mut().freeze_eth_claim = true;
    let (_, timelock) = lock_of(&s);
    s.world.borrow_mut().warp_eth_to(timelock);
    let r = s.tick_bob();
    assert_eq!(r.action.kind(), "refund_eth", "{r:?}");
    s.world.borrow_mut().refund_pending = false;
    // Within the grace period the history entry holds the refund back (one refund at a time).
    let r = s.tick_bob_with(|_, e| e.signer_nonce_pending = e.signer_nonce_latest);
    assert_ne!(r.action.kind(), "refund_eth", "{r:?}");
    s.world.borrow_mut().advance_eth(ETH_TX_GRACE_S / 12 + 5);
    let r = s.tick_bob_with(|_, e| e.signer_nonce_pending = e.signer_nonce_latest);
    // The drop is recorded in this tick (the history is the memory); the refund is offered by the next one.
    assert!(r.events.contains(&"eth_refund_dropped".to_string()), "{r:?}");
    let r = s.tick_bob_with(|_, e| e.signer_nonce_pending = e.signer_nonce_latest);
    assert_eq!(r.action.kind(), "refund_eth", "{r:?}");
    assert!(s.world.borrow().refund_pending);
}

// ------------------------------------------------------------------------------------------------------------------------ F-12

#[test]
fn f12_alice_on_the_cli_path_reaches_lost_without_a_recorded_reveal() {
    // The operator sends the reveal (the tool only decided it), the reveal reverts after T_reveal, Bob took the NOID with the exposed
    // secret and refunded his ETH: both legs are gone. Alice's phase is still `lock_final`.
    let mut s = Scenario::new(Variant::Raw);
    s.run_to_lock_final();
    s.alice.executor.offline_for.insert("reveal_eth");
    s.tick_alice();
    assert_eq!(s.alice_phase(), "lock_final");
    let now = s.now();
    s.alice.file.log("intent_decided:reveal_eth", now);
    s.alice.file.save(&s.alice.path).unwrap();
    let (lock_id, timelock) = lock_of(&s);
    s.world.borrow_mut().claim_pending = Some(PendingPreimage { lock_id, preimage: *s.secret.bytes(), tx_hash: [0xaa; 32] });
    // Bob sees the secret in the mempool and claims the NOID.
    for _ in 0..10 {
        s.tick_bob();
        if s.bob_phase() == "claim_submitted" {
            break;
        }
        s.world.borrow_mut().advance_noid(1);
    }
    assert_eq!(s.bob_phase(), "claim_submitted");
    s.world.borrow_mut().advance_noid(1);
    s.tick_bob();
    assert_eq!(s.bob_phase(), "claim_included");
    // The reveal is mined only after T_reveal: it reverts. Bob refunds, the refund becomes final.
    s.world.borrow_mut().warp_eth_to(timelock);
    let r = s.tick_bob();
    assert_eq!(r.action.kind(), "refund_eth", "{r:?}");
    s.world.borrow_mut().advance_eth(1);
    let lag = s.world.borrow().finality_lag;
    s.world.borrow_mut().advance_eth(lag + 1);
    s.tick_bob();
    // The tip is past D plus finality.
    let d = s.public.params.deadline_height;
    let need = d + 18 + 1 - s.world.borrow().tip;
    s.world.borrow_mut().advance_noid(need);
    s.tick_alice();
    assert_eq!(s.alice_phase(), "lost", "{:?}", s.alice.file.history.last());
}

/// Alice stays in `lock_final` (the reveal never leaves the tool), Bob refunds his ETH and it is final, the NOID instance is closed by
/// somebody (her wallet) and the tip is past `D + 18`. `logs` are history entries written to Alice's file before.
fn lock_final_with_bob_refunded_and_instance_gone(logs: &[&str]) -> Scenario {
    lock_final_gone(logs, false)
}

/// `second_still_lists`: the second Parano1d node still shows the instance (one node lying or lagging).
fn lock_final_gone(logs: &[&str], second_still_lists: bool) -> Scenario {
    let mut s = Scenario::new(Variant::Raw);
    s.run_to_lock_final();
    s.alice.executor.offline_for.insert("reveal_eth");
    s.tick_alice();
    assert_eq!(s.alice_phase(), "lock_final");
    for (k, l) in logs.iter().enumerate() {
        let now = s.now() + k as u64;
        s.alice.file.log(*l, now);
    }
    s.alice.file.save(&s.alice.path).unwrap();
    let (_, timelock) = lock_of(&s);
    s.world.borrow_mut().warp_eth_to(timelock);
    s.tick_bob();
    s.world.borrow_mut().advance_eth(1);
    s.world.borrow_mut().advance_eth(5);
    s.tick_bob();
    let inst = s.world.borrow_mut().instance.take().unwrap(); // closed by somebody (her wallet)
    if second_still_lists {
        s.world.borrow_mut().second_instance = Some(Some(inst));
    }
    let d = s.public.params.deadline_height;
    let need = d + 19 - s.world.borrow().tip;
    s.world.borrow_mut().advance_noid(need);
    s.tick_alice();
    s
}

#[test]
fn f12_lost_needs_the_second_node_to_agree_that_the_instance_is_gone() {
    // Review M2: a terminal `lost` must not rest on one node's word.
    let s = lock_final_gone(&["intent_decided:reveal_eth"], true);
    assert_eq!(s.alice_phase(), "lock_final");
    let s = lock_final_gone(&["intent_decided:reveal_eth"], false);
    assert_eq!(s.alice_phase(), "lost");
}

#[test]
fn f12_without_any_trace_of_a_reveal_lock_final_does_not_become_lost() {
    // The same end state, but no reveal was ever decided: the secret is not public, so the instance cannot have been closed by Bob.
    let s = lock_final_with_bob_refunded_and_instance_gone(&[]);
    assert_eq!(s.alice_phase(), "lock_final");
}

#[test]
fn f12_a_reveal_intent_that_was_cancelled_is_no_trace_of_a_reveal() {
    // `intent --cancel` is refused while the claim is pending or mined, so a cancelled reveal was never sent.
    let s = lock_final_with_bob_refunded_and_instance_gone(&["intent_decided:reveal_eth", "intent_cancelled:reveal_eth"]);
    assert_eq!(s.alice_phase(), "lock_final");
    let s = lock_final_with_bob_refunded_and_instance_gone(&["intent_decided:reveal_eth"]);
    assert_eq!(s.alice_phase(), "lost");
}

// ------------------------------------------------------------------------------------------------------------------------ F-17

#[test]
fn f17_an_instance_that_was_alive_when_bobs_claim_branch_closed_is_never_called_lost() {
    // The reveal was sent (evidence) and Bob refunded his ETH, but he never claimed the NOID: at D the instance is still there. Alice's
    // wallet then closes it (recovery), outside the tool. Gone + Bob's refund final + tip past D + 18 looked like "both legs lost".
    let mut s = Scenario::new(Variant::Raw);
    s.run_to_lock_final();
    s.alice.executor.offline_for.insert("reveal_eth");
    s.alice.executor.offline_for.insert("refund_noid");
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
    // The tip reaches D - 1: the instance is alive in this poll, and the claim branch is closed for good.
    let d = s.public.params.deadline_height;
    let need = d - 1 - s.world.borrow().tip;
    s.world.borrow_mut().advance_noid(need);
    let r = s.tick_alice();
    assert!(r.events.contains(&"noid_instance_alive_at_d".to_string()), "{r:?}");
    // Her wallet closes it; the chain goes on past D + 18.
    s.world.borrow_mut().close_outside(true, None);
    let need = d + 19 - s.world.borrow().tip;
    s.world.borrow_mut().advance_noid(need);
    let r = s.tick_alice();
    assert_eq!(s.alice_phase(), "lock_final", "{r:?}");
    assert!(r.notes.iter().any(|n| n.contains("F-17")), "{:?}", r.notes);
}

// ------------------------------------------------------------------------------------------------------------------------ F-13

#[test]
fn f13_alice_does_not_reveal_while_her_instance_is_not_in_the_poll() {
    let mut s = Scenario::new(Variant::Raw);
    s.run_to_lock_final();
    let inst = s.world.borrow_mut().instance.take().unwrap(); // a one-block funding reorg
    let r = s.tick_alice();
    assert_eq!(r.action.kind(), "wait", "{r:?}");
    assert!(s.world.borrow().claim_pending.is_none());
    assert!(r.notes.iter().any(|n| n.contains("F-13")), "{:?}", r.notes);
    s.world.borrow_mut().instance = Some(inst);
    assert_eq!(s.tick_alice().action.kind(), "reveal_eth");
}

// ------------------------------------------------------------------------------------------------------------------------ F-4

#[test]
fn f4_the_runner_does_not_try_to_close_an_instance_that_is_gone() {
    let mut s = Scenario::new(Variant::Raw);
    s.tick_alice();
    s.world.borrow_mut().advance_noid(1);
    s.tick_both();
    s.world.borrow_mut().advance_noid(17);
    s.tick_alice();
    assert_eq!(s.alice_phase(), "funding_final");
    let d = s.public.params.deadline_height;
    {
        let mut w = s.world.borrow_mut();
        w.instance = None; // closed by somebody else
        w.tip = d - 1;
    }
    let r = s.tick_alice();
    assert_eq!(r.action.kind(), "wait", "{r:?}");
    assert_eq!(s.alice.executor.count("refund_noid"), 0);
    assert!(r.notes.iter().any(|n| n.contains("nothing to refund")), "{:?}", r.notes);
}

// ------------------------------------------------------------------------------------------------------------------------ F-3

#[test]
fn f3_a_funding_that_left_the_chain_and_came_back_is_counted_from_its_return() {
    let mut s = Scenario::new(Variant::Raw);
    s.tick_alice();
    s.world.borrow_mut().advance_noid(1);
    s.tick_both();
    assert_eq!((s.alice_phase().as_str(), s.bob_phase().as_str()), ("funded", "funded"));
    // A reorg takes the funding back for a while; ten blocks pass; it returns as another incarnation.
    let inst = s.world.borrow_mut().instance.take().unwrap();
    s.world.borrow_mut().tip += 10;
    s.tick_both();
    assert_eq!((s.alice_phase().as_str(), s.bob_phase().as_str()), ("funding_submitted", "received"));
    {
        let mut w = s.world.borrow_mut();
        w.creation_seq += 1;
        w.instance = Some(swap_cli::watch::NoidInstance { creation_id: w.creation_seq, ..inst });
    }
    s.tick_both();
    assert_eq!((s.alice_phase().as_str(), s.bob_phase().as_str()), ("funded", "funded"));
    // The first sight was 10 blocks ago: 7 more blocks would have made it "final" by the old count. It is not.
    s.world.borrow_mut().advance_noid(7);
    s.tick_both();
    assert_eq!((s.alice_phase().as_str(), s.bob_phase().as_str()), ("funded", "funded"));
    s.world.borrow_mut().advance_noid(10);
    s.tick_both();
    assert_eq!((s.alice_phase().as_str(), s.bob_phase().as_str()), ("funding_final", "lock_submitted"));
}

#[test]
fn f3_a_silent_reincarnation_between_two_polls_is_noticed_too() {
    let mut s = Scenario::new(Variant::Raw);
    s.tick_alice();
    s.world.borrow_mut().advance_noid(1);
    s.tick_both();
    {
        // Gone and back between two polls: only the incarnation tells.
        let mut w = s.world.borrow_mut();
        w.creation_seq += 1;
        let c = w.creation_seq;
        w.instance.as_mut().unwrap().creation_id = c;
    }
    s.world.borrow_mut().advance_noid(17);
    s.tick_both();
    assert_eq!(s.alice_phase(), "funded", "the count restarted at the poll that saw the new incarnation");
}

// ------------------------------------------------------------------------------------------------------------------------ F-1

fn too_late_world(s: &Scenario) {
    // Alice's funding would not be final in time for Bob's lock-by height.
    s.world.borrow_mut().tip = s.public.params.lock_by_height - 10;
}

#[test]
fn f1_the_cli_path_records_the_abort() {
    let s = Scenario::new(Variant::Raw);
    too_late_world(&s);
    let (n, e, now) = observe(&s);
    // A read-only tick records nothing.
    let mut ro = s.alice.file.clone();
    let out = tick_apply(&mut ro, &n, &e, now, false).unwrap();
    assert!(matches!(out.decision.action, Action::Abort { .. }), "{:?}", out.decision);
    assert_eq!(ro.phase.name(), "created");
    // `tick --apply` does.
    let mut alice = s.alice.file.clone();
    let out = tick_apply(&mut alice, &n, &e, now, true).unwrap();
    assert!(matches!(out.decision.action, Action::Abort { .. }));
    assert!(out.decision.events.iter().any(|ev| matches!(ev, Event::Abort { .. })));
    assert_eq!(alice.phase.name(), "aborted");
    assert!(alice.phase.is_terminal());
    // Bob, after the last lock height, before anything is funded.
    let mut bob = s.bob.file.clone();
    s.world.borrow_mut().tip = s.public.params.deadline_height;
    let (n, e, now) = observe(&s);
    let out = tick_apply(&mut bob, &n, &e, now, true).unwrap();
    assert!(matches!(out.decision.action, Action::Abort { .. }), "{:?}", out.decision);
    assert_eq!(bob.phase.name(), "aborted");
}

#[test]
fn f1_an_abort_is_not_recorded_over_a_funding_that_may_have_been_sent() {
    let s = Scenario::new(Variant::Raw);
    too_late_world(&s);
    let mut alice = s.alice.file.clone();
    alice.log("intent_decided:fund_noid", s.now());
    let (n, e, now) = observe(&s);
    let out = tick_apply(&mut alice, &n, &e, now, true).unwrap();
    assert!(matches!(out.decision.action, Action::Abort { .. }));
    assert_eq!(alice.phase.name(), "created", "a funding was decided and never cancelled");
    assert!(out.decision.notes.iter().any(|x| x.contains("abort not recorded")), "{:?}", out.decision.notes);
    // Cancelled: the abort is held back for an hour more (review M1: a cancel rests on one node's view of the mempool), then recorded.
    alice.log("intent_cancelled:fund_noid", s.now() + 1);
    let out = tick_apply(&mut alice, &n, &e, now + 2, true).unwrap();
    assert!(matches!(out.decision.action, Action::Abort { .. }));
    assert_eq!(alice.phase.name(), "created");
    let out = tick_apply(&mut alice, &n, &e, now + 2 + swap_cli::engine::ABORT_AFTER_CANCEL_S, true).unwrap();
    assert!(matches!(out.decision.action, Action::Abort { .. }));
    assert_eq!(alice.phase.name(), "aborted");
}

// ------------------------------------------------------------------------------------------------------------------------ F-15

#[test]
fn f15_a_fund_noid_intent_cannot_be_cancelled_while_a_funding_sits_in_the_mempool() {
    let s = Scenario::new(Variant::Raw);
    let mut alice = s.alice.file.clone();
    let (n, e, now) = observe(&s);
    let out = tick_apply(&mut alice, &n, &e, now, true).unwrap();
    assert_eq!(out.decision.action.kind(), "fund_noid");
    let later = now + 3_600;
    // The funding is in the node's mempool (a reorg put it back): the node says so.
    s.world.borrow_mut().funding_pending = Some(s.public.params.amount_micronoid);
    let (n, e, _) = observe(&s);
    let err = cancel_intent(&mut alice.clone(), &n, &e, later).unwrap_err();
    assert!(err.contains("funding transaction") && err.contains("mempool"), "{err}");
    let err = cancel_intent_checked(&mut alice.clone(), &n, &e, later, true).unwrap_err();
    assert!(err.contains("funding transaction"), "the operator's word does not override the node: {err}");
    // The node says nothing is pending: the cancel goes through.
    s.world.borrow_mut().funding_pending = None;
    let (n, e, _) = observe(&s);
    cancel_intent(&mut alice.clone(), &n, &e, later).unwrap();
    // A node that cannot say (every real one): refused, unless the operator vouches for the wallet.
    let mut blind = n.clone();
    blind.funding_pending = None;
    let err = cancel_intent(&mut alice.clone(), &blind, &e, later).unwrap_err();
    assert!(err.contains("--i-checked-the-wallet"), "{err}");
    cancel_intent_checked(&mut alice, &blind, &e, later, true).unwrap();
    assert!(alice.pending_intent.is_none());
}

// ------------------------------------------------------------------------------------------------------------------------ F-16

#[test]
fn f16_done_is_settled_but_not_terminal() {
    let mut s = Scenario::new(Variant::Raw);
    s.run_to_lock_final();
    s.tick_alice();
    s.tick_bob();
    s.world.borrow_mut().advance_eth(1);
    s.world.borrow_mut().advance_noid(1);
    s.tick_both();
    s.world.borrow_mut().advance_eth(4);
    s.world.borrow_mut().advance_noid(17);
    s.tick_both();
    for f in [&s.alice.file, &s.bob.file] {
        assert!(matches!(f.phase, Phase::Alice(AlicePhase::Done { .. }) | Phase::Bob(BobPhase::Done { .. })), "{}", f.phase.name());
        assert!(f.phase.is_settled() && !f.phase.is_terminal(), "{}", f.phase.name());
    }
    let fresh: &SwapFile = &s.alice.file;
    assert!(!fresh.phase.is_terminal());
}

// ------------------------------------------------------------------------------------------------------------------------ cancel of a lock Bob cannot recognise

#[test]
fn a_lock_intent_is_not_cancelled_while_its_lock_is_on_chain_even_if_this_poll_does_not_trust_it() {
    // Found by the chaos test on new seeds (CHAOS.md, "after the fixes"): with a degraded chain id the mined lock fails `lock_matches`, the
    // intent looks unresolved, the signer's nonces show nothing pending (the transaction is mined), and the cancel went through.
    let mut s = Scenario::new(Variant::Raw);
    s.tick_alice();
    s.world.borrow_mut().advance_noid(1);
    s.tick_both();
    s.world.borrow_mut().advance_noid(17);
    s.tick_alice();
    let mut bob = s.bob.file.clone();
    let (n, e, now) = observe(&s);
    let out = tick_apply(&mut bob, &n, &e, now, true).unwrap();
    assert_eq!(out.decision.action.kind(), "lock_eth", "{:?}", out.decision);
    let now = s.now();
    swap_cli::engine::Executor::execute(&mut s.bob.executor, &bob, &out.decision.action, now).unwrap();
    s.world.borrow_mut().advance_eth(1);
    let (n, mut e, now) = observe(&s);
    e.chain_id = None; // a poll that cannot say which chain it is on
    let err = cancel_intent(&mut bob, &n, &e, now + swap_cli::engine::MIN_CANCEL_AGE_S).unwrap_err();
    assert!(err.contains("is on the Ethereum chain"), "{err}");
    assert!(bob.pending_intent.is_some());
}

// ------------------------------------------------------------------------------------------------------------------------ review H1

#[test]
fn h1_a_reveal_that_was_sent_near_the_cutoff_and_dropped_is_re_sent_past_the_cutoff() {
    // The model's relation `M_A >= finality + 2*DE + RA` exists so that Alice can answer one drop of her claim AFTER the cutoff. The secret is
    // already public then, and only `T_reveal - DE` limits the re-send.
    let mut s = Scenario::new(Variant::Raw);
    s.run_to_lock_final();
    let (_, timelock) = lock_of(&s);
    let g = s.gates();
    s.world.borrow_mut().warp_eth_to(timelock - g.m_a_s - 30);
    assert_eq!(s.tick_alice().action.kind(), "reveal_eth");
    s.world.borrow_mut().claim_pending = None; // dropped
    s.world.borrow_mut().advance_eth(ETH_TX_GRACE_S / 12 + 5); // now past the M_A cutoff, before T_reveal - DE
    assert!(s.now() > timelock - g.m_a_s && s.now() + g.de_s <= timelock);
    let r = s.tick_alice();
    assert!(r.events.contains(&"eth_reveal_dropped".to_string()), "{r:?}");
    assert_eq!(r.action.kind(), "reveal_eth", "{r:?}");
    // Too late for the re-send: within DE of T_reveal nothing is offered.
    let mut s2 = Scenario::new(Variant::Raw);
    s2.run_to_lock_final();
    s2.world.borrow_mut().warp_eth_to(timelock - g.m_a_s - 30);
    s2.tick_alice();
    s2.world.borrow_mut().claim_pending = None;
    s2.world.borrow_mut().warp_eth_to(timelock - g.de_s + 12);
    let r = s2.tick_alice();
    assert_eq!(r.action.kind(), "wait", "{r:?}");
}

#[test]
fn h1_a_mined_claim_that_a_reorg_dropped_without_a_trace_is_re_sent_at_once() {
    let mut s = revealed();
    reorg_claim(&s, false);
    let r = s.tick_alice();
    assert!(r.events.contains(&"eth_claim_reorged".to_string()) && r.events.contains(&"eth_reveal_dropped".to_string()), "{r:?}");
    assert_eq!(r.action.kind(), "reveal_eth", "{r:?}");
}
