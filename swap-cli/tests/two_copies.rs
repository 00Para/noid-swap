//! Engine-level two-copy tests (T-S2): two live copies of the same swap file
//! ticking against one simulated chain across all 6 interleaving step orders.
//!
//! Layer boundary:
//! - Every test in this file exercises the `swap-cli` engine (`Runner`, `decide`,
//!   and `apply`) against the in-process two-chain simulator (`tests/common`).
//! - The real Ethereum fresh-key nonce refusal in `eth/scripts/live.js` (when two
//!   copies of Bob's swap file both call `live.lock` on a log-blind provider) is
//!   exercised against a real Hardhat chain in `eth/test/live-lock-nonce.test.js`.

mod common;

use common::*;
use swap_cli::engine::{Executor, Runner};
use swap_cli::params::W_A_S;
use swap_cli::secret::Variant;

fn duplicate_party(s: &Scenario, src: &std::path::Path, name: &str) -> std::path::PathBuf {
    let dst = s.dir.path().join(name);
    std::fs::copy(src, &dst).unwrap();
    dst
}

fn tick_runner<E: Executor>(s: &Scenario, r: &mut Runner<E>) -> swap_cli::engine::TickReport {
    let (noid, eth) = {
        let w = s.world.borrow();
        (w.noid_obs(None), w.eth_obs())
    };
    r.tick(&noid, &eth, s.now()).unwrap()
}

#[derive(Clone, Copy)]
enum Actor {
    A1,
    A2,
    B1,
    B2,
}

fn run_happy_path_order(order: [Actor; 4]) {
    let mut s = Scenario::new(Variant::Raw);
    let alice2_path = duplicate_party(&s, &s.alice.path, "alice2.swap.json");
    let bob2_path = duplicate_party(&s, &s.bob.path, "bob2.swap.json");

    let mut alice2 = Runner::open(
        alice2_path.clone(),
        SimExecutor::new(s.world.clone(), Some(s.secret.clone()), alice2_path),
    )
    .unwrap();
    let mut bob2 = Runner::open(
        bob2_path.clone(),
        SimExecutor::new(s.world.clone(), None, bob2_path),
    )
    .unwrap();

    // Advance one block after each tick so funding/locks/reveals/claims mine and finalize across
    // repeated interleaved rounds while both copies of Alice and both copies of Bob stay alive.
    for _round in 0..16 {
        for actor in order {
            match actor {
                Actor::A1 => {
                    s.tick_alice();
                }
                Actor::A2 => {
                    let _ = tick_runner(&s, &mut alice2);
                }
                Actor::B1 => {
                    s.tick_bob();
                }
                Actor::B2 => {
                    let _ = tick_runner(&s, &mut bob2);
                }
            }
            // Mine any submitted funding/claim/lock/reveal right after each step so competing copies
            // see both mempool and freshly-mined transitions.
            s.world.borrow_mut().advance_noid(1);
            s.world.borrow_mut().advance_eth(1);
        }
        s.world.borrow_mut().advance_noid(4);
        s.world.borrow_mut().advance_eth(2);
    }

    let w = s.world.borrow();
    assert_eq!(w.creation_seq, 1, "at most one NOID instance created");
    assert_eq!(w.lock_count, 1, "at most one ETH lock created");
    assert_eq!(w.noid_payout.as_ref().unwrap().0, s.public.params.bob_noid);
    assert_eq!(w.eth_payout.unwrap().0, s.public.params.eth.alice_receiver);
}

#[test]
fn t_s2_order1_engine_a1_a2_b1_b2_settles_with_one_instance_and_one_lock() {
    run_happy_path_order([Actor::A1, Actor::A2, Actor::B1, Actor::B2]);
}

#[test]
fn t_s2_order2_engine_a2_a1_b2_b1_restored_copies_lead_cleanly() {
    run_happy_path_order([Actor::A2, Actor::A1, Actor::B2, Actor::B1]);
}

#[test]
fn t_s2_order3_engine_a1_b1_a2_b2_interleaved_copy1_then_copy2() {
    run_happy_path_order([Actor::A1, Actor::B1, Actor::A2, Actor::B2]);
}

#[test]
fn t_s2_order4_engine_b2_a2_b1_a1_reverse_interleaving() {
    run_happy_path_order([Actor::B2, Actor::A2, Actor::B1, Actor::A1]);
}

#[test]
fn t_s2_order5_engine_restored_copies_wake_mid_swap_before_reveal_and_claim() {
    // Exercises the engine when old Copy 1 funds and locks first, and restored Copy 2 wakes up
    // right at lock_final to race reveal and claim against Copy 1.
    let mut s = Scenario::new(Variant::Raw);
    let alice2_path = duplicate_party(&s, &s.alice.path, "alice2-mid.swap.json");
    let bob2_path = duplicate_party(&s, &s.bob.path, "bob2-mid.swap.json");

    let mut alice2 = Runner::open(
        alice2_path.clone(),
        SimExecutor::new(s.world.clone(), Some(s.secret.clone()), alice2_path),
    )
    .unwrap();
    let mut bob2 = Runner::open(
        bob2_path.clone(),
        SimExecutor::new(s.world.clone(), None, bob2_path),
    )
    .unwrap();

    // Copy 1 completes funding and locking while Copy 2 is offline.
    s.tick_alice();
    s.world.borrow_mut().advance_noid(1);
    s.tick_both();
    s.world.borrow_mut().advance_noid(18);
    s.tick_both(); // Bob 1 locks
    s.world.borrow_mut().advance_eth(4); // lock finalized

    // Copy 2 wakes up from `created` / `received` and races Copy 1 through reveal and claim.
    for _ in 0..10 {
        let _ = tick_runner(&s, &mut alice2);
        s.tick_alice();
        s.world.borrow_mut().advance_eth(2);
        let _ = tick_runner(&s, &mut bob2);
        s.tick_bob();
        s.world.borrow_mut().advance_noid(4);
    }

    let w = s.world.borrow();
    assert_eq!(w.creation_seq, 1, "Copy 2 waking mid-swap must adopt funding, never double-fund");
    assert_eq!(w.lock_count, 1, "Copy 2 waking mid-swap must adopt lock, never double-lock");
    assert_eq!(w.noid_payout.as_ref().unwrap().0, s.public.params.bob_noid);
    assert_eq!(w.eth_payout.unwrap().0, s.public.params.eth.alice_receiver);
}

#[test]
fn t_s2_order6_engine_two_copies_timeout_and_refund_race_returns_both_legs() {
    // Exercises the engine when Alice never reveals and both Bob copies race ETH refund after
    // T_reveal while both Alice copies race NOID recovery after D.
    let mut s = Scenario::new(Variant::Raw);
    let alice2_path = duplicate_party(&s, &s.alice.path, "alice2-refund.swap.json");
    let bob2_path = duplicate_party(&s, &s.bob.path, "bob2-refund.swap.json");

    let mut alice2 = Runner::open(
        alice2_path.clone(),
        SimExecutor::new(s.world.clone(), Some(s.secret.clone()), alice2_path),
    )
    .unwrap();
    let mut bob2 = Runner::open(
        bob2_path.clone(),
        SimExecutor::new(s.world.clone(), None, bob2_path),
    )
    .unwrap();

    // Fund and lock once.
    s.tick_alice();
    s.world.borrow_mut().advance_noid(1);
    s.tick_both();
    s.world.borrow_mut().advance_noid(18);
    s.tick_bob();
    s.world.borrow_mut().advance_eth(1);
    s.tick_bob();

    // Jump past T_reveal (so Alice never reveals) and race both Bob copies on ETH refund.
    s.world.borrow_mut().advance_eth((W_A_S / 12) + 50);
    for _ in 0..4 {
        let _ = tick_runner(&s, &mut bob2);
        s.tick_bob();
        s.world.borrow_mut().advance_eth(2);
    }

    // Jump past D and race both Alice copies on NOID recovery.
    let d = s.public.params.deadline_height;
    let tip = s.world.borrow().tip;
    if tip <= d {
        s.world.borrow_mut().advance_noid((d - tip) + 2);
    }
    for _ in 0..6 {
        let _ = tick_runner(&s, &mut alice2);
        s.tick_alice();
        s.world.borrow_mut().advance_noid(6);
    }

    let w = s.world.borrow();
    assert_eq!(w.creation_seq, 1);
    assert_eq!(w.lock_count, 1);
    assert_eq!(w.eth_payout.unwrap().0, s.public.params.eth.bob_sender);
    assert_eq!(w.noid_payout.as_ref().unwrap().0, s.public.params.alice_noid);
}
