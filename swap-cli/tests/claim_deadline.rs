//! Bob's NOID claim is pending and does not get mined while the claim branch runs out (threat T21, a censoring or slow producer). The engine can
//! do nothing about it (the mempool is first-seen, nothing can be sent instead), so it says so on every tick: past the `D - 19` target and at
//! or past `D`. Notes only: no action and no phase changes.

mod common;

use common::*;
use swap_cli::engine::{Action, TickReport};
use swap_cli::secret::Variant;
use swap_cli::state::{BobPhase, Phase};

const PENDING_ALARM: &str = "ALARM: the NOID claim is still pending";

/// Bob has seen the secret and sent his claim; nothing is mined (`freeze_inclusion`).
fn bob_with_a_stuck_claim() -> Scenario {
    let mut s = Scenario::new(Variant::Raw);
    s.run_to_lock_final();
    s.tick_alice();
    s.tick_bob();
    s.world.borrow_mut().advance_eth(1);
    s.world.borrow_mut().freeze_inclusion = true;
    s.world.borrow_mut().advance_noid(1);
    s.tick_both();
    assert!(matches!(&s.bob.file.phase, Phase::Bob(BobPhase::ClaimSubmitted { .. })), "{:?}", s.bob.file.phase);
    s
}

fn alarms(r: &TickReport) -> Vec<&String> {
    r.notes.iter().filter(|n| n.starts_with(PENDING_ALARM)).collect()
}

#[test]
fn a_pending_claim_that_is_not_mined_says_so_past_the_target_and_at_the_deadline_and_changes_nothing_else() {
    let mut s = bob_with_a_stuck_claim();
    let d = s.public.params.deadline_height;
    // On target (the next call height is at most D - 19): no alarm.
    let r = s.tick_bob();
    assert!(alarms(&r).is_empty(), "{:?}", r.notes);
    assert!(matches!(&r.action, Action::Wait { reason } if reason == "NOID claim pending"), "{:?}", r.action);
    // The next call height is D - 18, past the target: an alarm, the same wait.
    let tip = s.world.borrow().tip;
    s.world.borrow_mut().advance_noid(d - 19 - tip);
    let r = s.tick_bob();
    let a = alarms(&r);
    assert_eq!(a.len(), 1, "{:?}", r.notes);
    assert!(a[0].contains("past the D-19 target") && a[0].contains(&format!("next call height {}", d - 18)), "{}", a[0]);
    assert!(matches!(&r.action, Action::Wait { reason } if reason == "NOID claim pending"), "{:?}", r.action);
    assert_eq!(r.phase, "claim_submitted");
    // A node that still lists the pending claim when the next call height has reached D (the real node evicts it there; a stale one may not):
    // the branch is closed, and the alarm says so. The simulated node would already have dropped the claim, so the height is set in the observation.
    let r = s.tick_bob_with(|n, _| n.next_call_height = d);
    let a = alarms(&r);
    assert_eq!(a.len(), 1, "{:?}", r.notes);
    assert!(a[0].contains("the claim branch is closed") && a[0].contains(&format!("next call height {d} >= D {d}")), "{}", a[0]);
    assert!(matches!(&r.action, Action::Wait { reason } if reason == "NOID claim pending"), "{:?}", r.action);
    assert_eq!(r.phase, "claim_submitted");
}

#[test]
fn a_claim_that_is_mined_in_time_never_raises_the_alarm() {
    let mut s = Scenario::new(Variant::Raw);
    s.run_to_lock_final();
    s.tick_alice();
    s.tick_bob();
    s.world.borrow_mut().advance_eth(1);
    s.world.borrow_mut().advance_noid(1);
    let mut all: Vec<String> = Vec::new();
    for _ in 0..6 {
        let (a, b) = s.tick_both();
        all.extend(a.notes);
        all.extend(b.notes);
        s.world.borrow_mut().advance_eth(1);
        s.world.borrow_mut().advance_noid(4);
    }
    assert!(all.iter().all(|n| !n.starts_with(PENDING_ALARM)), "{all:?}");
}
