//! Output-only additions to the tick: the note that a second node agreed, and the lock-by margin note. Each test shows the text
//! appears when it should and not otherwise, and that the action, its reason and the recorded events are the same as without the note.
//! (The wording of the `--<kind>-rpc2-is-remote` note is tested in `main.rs`; the Ethereum log-index error in `watch_eth.rs`.)

mod common;

use common::*;
use swap_cli::engine::{decide, Action, LOCK_BY_MARGIN_WARN_BLOCKS};
use swap_cli::secret::Variant;

const NOID_LABEL: &str = "http://127.0.0.1:9602";
const ETH_LABEL: &str = "https://rpc.example.org:443";

fn notes_with<'a>(notes: &'a [String], needle: &str) -> Vec<&'a String> {
    notes.iter().filter(|n| n.contains(needle)).collect()
}

/// Bob has seen the funding final and the next tick would lock (the tip is far from the lock-by).
fn at_bob_lock(s: &mut Scenario) {
    s.tick_alice();
    s.world.borrow_mut().advance_noid(1);
    s.tick_both();
    s.world.borrow_mut().advance_noid(17);
    s.tick_alice();
    assert_eq!(s.bob_phase(), "funded");
}

// ---------------------------------------------------------------- the second node agreed

#[test]
fn bob_lock_with_a_second_parano1d_node_says_it_agreed() {
    let mut s = Scenario::new(Variant::Raw);
    at_bob_lock(&mut s);
    let (tip, inst) = {
        let w = s.world.borrow();
        (w.tip, w.instance.clone().unwrap())
    };
    let r = s.tick_bob_with(|n, _| n.second_label = Some(NOID_LABEL.into()));
    assert_eq!(r.action.kind(), "lock_eth", "{r:?}");
    let want = format!(
        "second Parano1d node agrees: {NOID_LABEL} at height {tip} (first node {tip}), slot {} creation {} amount {}",
        inst.slot_index, inst.creation_id, inst.amount_micronoid
    );
    assert!(r.notes.contains(&want), "{:?}", r.notes);
    assert_eq!(notes_with(&r.notes, "node agrees").len(), 1, "{:?}", r.notes);
}

#[test]
fn the_parano1d_agreement_note_is_not_said_when_the_nodes_disagree_or_the_rule_is_waived() {
    // Disagreement: the lock waits, and no node "agrees".
    let mut s = Scenario::new(Variant::Raw);
    at_bob_lock(&mut s);
    s.world.borrow_mut().second_tip_lag = 3;
    let r = s.tick_bob_with(|n, _| n.second_label = Some(NOID_LABEL.into()));
    assert_eq!(r.action.kind(), "wait", "{r:?}");
    assert!(notes_with(&r.notes, "node agrees").is_empty(), "{:?}", r.notes);
    // A second node that failed to read: the same.
    let mut s = Scenario::new(Variant::Raw);
    at_bob_lock(&mut s);
    s.world.borrow_mut().second_unreadable = Some("parano1d watcher (second node): transport: connect refused".into());
    let r = s.tick_bob_with(|n, _| n.second_label = Some(NOID_LABEL.into()));
    assert_eq!(r.action.kind(), "wait", "{r:?}");
    assert!(notes_with(&r.notes, "node agrees").is_empty(), "{:?}", r.notes);
    // Waived (--single-node-ok): the single-node note, nothing new.
    let mut s = Scenario::new(Variant::Raw);
    at_bob_lock(&mut s);
    s.world.borrow_mut().single_node = true;
    s.world.borrow_mut().single_node_ok = true;
    let r = s.tick_bob();
    assert_eq!(r.action.kind(), "lock_eth", "{r:?}");
    assert!(r.notes.iter().any(|n| n == "single node: F5 cross-check not possible"), "{:?}", r.notes);
    assert!(notes_with(&r.notes, "node agrees").is_empty(), "{:?}", r.notes);
    // Not evaluated (an action that needs no second node): the funding tick of Alice.
    let mut s = Scenario::new(Variant::Raw);
    let r = s.tick_alice_with(|n, _| n.second_label = Some(NOID_LABEL.into()));
    assert_eq!(r.action.kind(), "fund_noid", "{r:?}");
    assert!(notes_with(&r.notes, "node agrees").is_empty(), "{:?}", r.notes);
}

#[test]
fn a_second_node_without_an_address_still_agrees_without_naming_one() {
    // A fixture or a hand-built observation has no address to show.
    let mut s = Scenario::new(Variant::Raw);
    at_bob_lock(&mut s);
    let r = s.tick_bob();
    assert_eq!(r.action.kind(), "lock_eth", "{r:?}");
    assert!(r.notes.iter().any(|n| n.starts_with("second Parano1d node agrees: at height ")), "{:?}", r.notes);
}

#[test]
fn alice_reveal_with_a_second_ethereum_node_says_it_agreed() {
    let mut s = Scenario::new(Variant::Raw);
    s.run_to_lock_final();
    let r = s.tick_alice_with(|_, e| e.second_label = Some(ETH_LABEL.into()));
    assert_eq!(r.action.kind(), "reveal_eth", "{r:?}");
    let agrees = notes_with(&r.notes, "second Ethereum node agrees");
    assert_eq!(agrees.len(), 1, "{:?}", r.notes);
    let note = agrees[0];
    assert!(note.starts_with(&format!("second Ethereum node agrees: {ETH_LABEL} finalized ")), "{note}");
    assert!(note.contains("(first node finalized ") && note.contains(", lock 0x") && note.ends_with("final at the lower of the two"), "{note}");
    // Only compared values: the latest block numbers are not printed.
    assert!(!note.contains("at block"), "{note}");
}

#[test]
fn the_ethereum_agreement_note_is_not_said_when_the_nodes_disagree_or_the_rule_is_waived() {
    // The lock is final on one node only: the reveal waits.
    let mut s = Scenario::new(Variant::Raw);
    s.run_to_lock_final();
    s.world.borrow_mut().second_finalized_delta = -2;
    let r = s.tick_alice_with(|_, e| e.second_label = Some(ETH_LABEL.into()));
    assert_eq!(r.action.kind(), "wait", "{r:?}");
    assert!(notes_with(&r.notes, "node agrees").is_empty(), "{:?}", r.notes);
    // The second node does not show the lock.
    let mut s = Scenario::new(Variant::Raw);
    s.run_to_lock_final();
    s.world.borrow_mut().second_lock_hidden = true;
    let r = s.tick_alice();
    assert_eq!(r.action.kind(), "wait", "{r:?}");
    assert!(notes_with(&r.notes, "node agrees").is_empty(), "{:?}", r.notes);
    // Waived: no second node configured and --single-node-ok.
    let mut s = Scenario::new(Variant::Raw);
    s.run_to_lock_final();
    s.world.borrow_mut().single_node = true;
    s.world.borrow_mut().single_node_ok = true;
    let r = s.tick_alice();
    assert_eq!(r.action.kind(), "reveal_eth", "{r:?}");
    assert!(notes_with(&r.notes, "node agrees").is_empty(), "{:?}", r.notes);
}

/// The guard that no decision changed: the same file and the same observations, with and without the address of the second node, give
/// the same action (and so the same reason), the same events, and notes that differ only in the agreement note.
#[test]
fn the_agreement_notes_change_no_decision() {
    // Bob's lock.
    let mut s = Scenario::new(Variant::Raw);
    at_bob_lock(&mut s);
    let (noid, eth, now) = {
        let w = s.world.borrow();
        (w.noid_obs(None), w.eth_obs(), w.eth_time)
    };
    let plain = decide(&s.bob.file, &noid, &eth, now);
    let mut labelled = noid.clone();
    labelled.second_label = Some(NOID_LABEL.into());
    let named = decide(&s.bob.file, &labelled, &eth, now);
    assert!(matches!(plain.action, Action::LockEth { .. }), "{:?}", plain.action);
    assert_eq!(plain.action, named.action);
    assert_eq!(plain.events, named.events);
    assert_eq!(plain.notes.len(), named.notes.len());
    let rest = |notes: &[String]| notes.iter().filter(|n| !n.contains("node agrees")).cloned().collect::<Vec<_>>();
    assert_eq!(rest(&plain.notes), rest(&named.notes));
    // Alice's reveal.
    let mut s = Scenario::new(Variant::Raw);
    s.run_to_lock_final();
    let (noid, eth, now) = {
        let w = s.world.borrow();
        (w.noid_obs(None), w.eth_obs(), w.eth_time)
    };
    let plain = decide(&s.alice.file, &noid, &eth, now);
    let mut labelled = eth.clone();
    labelled.second_label = Some(ETH_LABEL.into());
    let named = decide(&s.alice.file, &noid, &labelled, now);
    assert!(matches!(plain.action, Action::RevealEth { .. }), "{:?}", plain.action);
    assert_eq!(plain.action, named.action);
    assert_eq!(plain.events, named.events);
    assert_eq!(rest(&plain.notes), rest(&named.notes));
}

// ---------------------------------------------------------------- the lock-by margin

#[test]
fn bob_before_his_lock_sees_the_margin_to_the_lock_by() {
    let mut s = Scenario::new(Variant::Raw);
    let lock_by = s.public.params.lock_by_height;
    // Received (waiting for Alice's funding), a long way before the lock-by.
    let tip = s.world.borrow().tip;
    assert!(lock_by - tip >= LOCK_BY_MARGIN_WARN_BLOCKS);
    let r = s.tick_bob();
    assert_eq!(r.action.kind(), "wait", "{r:?}");
    assert!(r.notes.contains(&format!("lock-by margin: {} blocks (lock-by {lock_by}, tip {tip})", lock_by - tip)), "{:?}", r.notes);
    // Funding final, the lock is offered: the margin is still said.
    let mut s = Scenario::new(Variant::Raw);
    at_bob_lock(&mut s);
    let tip = s.world.borrow().tip;
    let r = s.tick_bob();
    assert_eq!(r.action.kind(), "lock_eth", "{r:?}");
    assert!(r.notes.contains(&format!("lock-by margin: {} blocks (lock-by {lock_by}, tip {tip})", lock_by - tip)), "{:?}", r.notes);
}

/// What Bob's engine decides on the world as it is now, without executing it (a tick that locks moves him past the margin note).
fn bob_decision(s: &Scenario) -> swap_cli::engine::Decision {
    let (noid, eth, now) = {
        let w = s.world.borrow();
        (w.noid_obs(None), w.eth_obs(), w.eth_time)
    };
    decide(&s.bob.file, &noid, &eth, now)
}

#[test]
fn a_short_margin_is_a_warning_and_the_boundary_is_the_named_constant() {
    let mut s = Scenario::new(Variant::Raw);
    at_bob_lock(&mut s);
    let lock_by = s.public.params.lock_by_height;
    // At the warning limit: still the plain form.
    let tip = s.world.borrow().tip;
    s.world.borrow_mut().advance_noid(lock_by - LOCK_BY_MARGIN_WARN_BLOCKS - tip);
    let d = bob_decision(&s);
    let tip = s.world.borrow().tip;
    assert_eq!(lock_by - tip, LOCK_BY_MARGIN_WARN_BLOCKS);
    assert!(matches!(d.action, Action::LockEth { .. }), "{:?}", d.action);
    assert!(d.notes.contains(&format!("lock-by margin: {LOCK_BY_MARGIN_WARN_BLOCKS} blocks (lock-by {lock_by}, tip {tip})")), "{:?}", d.notes);
    assert!(notes_with(&d.notes, "margin is short").is_empty(), "{:?}", d.notes);
    // One block below it: the warning, which points at the action; the action is the same lock.
    s.world.borrow_mut().advance_noid(1);
    let d2 = bob_decision(&s);
    let tip = s.world.borrow().tip;
    let left = lock_by - tip;
    assert_eq!(left, LOCK_BY_MARGIN_WARN_BLOCKS - 1);
    assert!(matches!(d2.action, Action::LockEth { .. }), "{:?}", d2.action);
    assert!(d2.notes.contains(&format!("lock-by margin is short: {left} blocks (lock-by {lock_by}, tip {tip}); see the action")), "{:?}", d2.notes);
}

/// What Alice's engine decides on the world as it is now, without executing it.
fn alice_decision(s: &Scenario) -> swap_cli::engine::Decision {
    let (noid, eth, now) = {
        let w = s.world.borrow();
        (w.noid_obs(None), w.eth_obs(), w.eth_time)
    };
    decide(&s.alice.file, &noid, &eth, now)
}

/// Move Alice's world to `left` blocks before the engine stops offering the funding (`tip + b_fund + b_final <= lock-by` still holds).
fn alice_with_funding_window(left: u64) -> Scenario {
    let s = Scenario::new(Variant::Raw);
    let lock_by = s.public.params.lock_by_height;
    let g = s.gates();
    let tip = s.world.borrow().tip;
    s.world.borrow_mut().advance_noid(lock_by - g.b_fund - g.b_final - left - tip);
    s
}

#[test]
fn alice_with_a_long_funding_window_sees_the_blocks_left() {
    let s = Scenario::new(Variant::Raw);
    let lock_by = s.public.params.lock_by_height;
    let g = s.gates();
    let tip = s.world.borrow().tip;
    let left = lock_by - g.b_fund - g.b_final - tip;
    assert!(left >= LOCK_BY_MARGIN_WARN_BLOCKS);
    let d = alice_decision(&s);
    assert!(matches!(d.action, Action::FundNoid { .. }), "{:?}", d.action);
    assert!(d.notes.contains(&format!("funding window: {left} blocks left before it is too late to fund (lock-by {lock_by}, tip {tip})")), "{:?}", d.notes);
    assert!(notes_with(&d.notes, "at once").is_empty(), "{:?}", d.notes);
}

#[test]
fn alice_funding_offered_with_a_short_window_gets_the_short_form_without_an_instruction() {
    let s = alice_with_funding_window(3);
    let lock_by = s.public.params.lock_by_height;
    let tip = s.world.borrow().tip;
    let d = alice_decision(&s);
    assert!(matches!(d.action, Action::FundNoid { .. }), "{:?}", d.action);
    assert!(
        d.notes.contains(&format!("funding window is short: 3 blocks left before it is too late to fund (lock-by {lock_by}, tip {tip}); see the action")),
        "{:?}",
        d.notes
    );
    // The boundary is the named constant: at it the plain form, one block below it the short one.
    let s = alice_with_funding_window(LOCK_BY_MARGIN_WARN_BLOCKS);
    let d = alice_decision(&s);
    assert!(matches!(d.action, Action::FundNoid { .. }), "{:?}", d.action);
    assert_eq!(notes_with(&d.notes, "funding window").len(), 1, "{:?}", d.notes);
    assert!(notes_with(&d.notes, "funding window is short").is_empty() && notes_with(&d.notes, "at once").is_empty(), "{:?}", d.notes);
    let s = alice_with_funding_window(LOCK_BY_MARGIN_WARN_BLOCKS - 1);
    assert!(notes_with(&alice_decision(&s).notes, "funding window is short").len() == 1);
}

#[test]
fn alice_too_late_to_fund_gets_no_instruction_and_the_abort_stays_what_it_was() {
    let mut s = alice_with_funding_window(0);
    // Still fundable at the last height, the short form ...
    let d = alice_decision(&s);
    assert!(matches!(d.action, Action::FundNoid { .. }), "{:?}", d.action);
    assert!(notes_with(&d.notes, "0 blocks left").len() == 1, "{:?}", d.notes);
    // ... and one block later the abort the engine always gave, with no urgency wording at all.
    s.world.borrow_mut().advance_noid(1);
    let (lock_by, tip) = (s.public.params.lock_by_height, s.world.borrow().tip);
    let g = s.gates();
    let r = s.tick_alice();
    assert_eq!(r.action.kind(), "abort", "{r:?}");
    assert!(
        r.notes.contains(&format!("funding window is closed: the last height to fund was {} (lock-by {lock_by}, tip {tip})", lock_by - g.b_fund - g.b_final)),
        "{:?}",
        r.notes
    );
    assert!(notes_with(&r.notes, "at once").is_empty() && notes_with(&r.notes, "is short").is_empty(), "{:?}", r.notes);
}

#[test]
fn bob_with_a_short_margin_and_the_lock_offered_gets_the_short_form_without_an_instruction() {
    let mut s = Scenario::new(Variant::Raw);
    at_bob_lock(&mut s);
    let lock_by = s.public.params.lock_by_height;
    let tip = s.world.borrow().tip;
    s.world.borrow_mut().advance_noid(lock_by - 4 - tip);
    let d = bob_decision(&s);
    assert!(matches!(d.action, Action::LockEth { .. }), "{:?}", d.action);
    assert!(d.notes.contains(&format!("lock-by margin is short: 4 blocks (lock-by {lock_by}, tip {}); see the action", lock_by - 4)), "{:?}", d.notes);
}

#[test]
fn bob_with_a_short_margin_but_no_lock_offered_gets_the_neutral_form() {
    let mut s = Scenario::new(Variant::Raw);
    at_bob_lock(&mut s);
    let lock_by = s.public.params.lock_by_height;
    let tip = s.world.borrow().tip;
    s.world.borrow_mut().advance_noid(lock_by - 4 - tip);
    let tip = s.world.borrow().tip;
    let short = format!("lock-by margin is short: 4 blocks (lock-by {lock_by}, tip {tip}); see the action");
    let (noid, eth, now) = {
        let w = s.world.borrow();
        (w.noid_obs(None), w.eth_obs(), w.eth_time)
    };
    // A wait (no chain time to lock against).
    let mut e = eth.clone();
    e.latest_timestamp = 0;
    let d = decide(&s.bob.file, &noid, &e, now);
    assert!(matches!(d.action, Action::Wait { .. }), "{:?}", d.action);
    assert!(d.notes.contains(&short), "{:?}", d.notes);
    assert!(notes_with(&d.notes, "at once").is_empty(), "{:?}", d.notes);
    // An abort (the contract is already on the recovery branch).
    let mut n = noid.clone();
    n.active_authority = Some("not-the-claim-authority".into());
    let d = decide(&s.bob.file, &n, &eth, now);
    assert!(matches!(d.action, Action::Abort { .. }), "{:?}", d.action);
    assert!(d.notes.contains(&short), "{:?}", d.notes);
    assert!(notes_with(&d.notes, "at once").is_empty(), "{:?}", d.notes);
    // A lock_eth intent that is already held: the same text, which points at the action.
    s.bob.file.pending_intent = Some(swap_cli::swapfile::PendingIntent {
        action: "lock_eth".into(),
        params: serde_json::json!({}),
        decided_at: now,
        phase_at_decision: "funding_final".into(),
        noid_tip: tip,
        eth_block: 0,
    });
    let d = decide(&s.bob.file, &noid, &eth, now);
    assert!(d.notes.contains(&short), "{:?}", d.notes);
    assert!(notes_with(&d.notes, "at once").is_empty(), "{:?}", d.notes);
}

#[test]
fn bob_past_the_nominal_lock_by_with_the_lock_still_offered_gets_the_hard_limit() {
    let mut s = Scenario::new(Variant::Raw);
    at_bob_lock(&mut s);
    let lock_by = s.public.params.lock_by_height;
    let hard = s.gates().bob_lock_by_min_window(s.public.params.deadline_height);
    assert!(hard > lock_by + 2);
    let tip = s.world.borrow().tip;
    s.world.borrow_mut().advance_noid(lock_by + 2 - tip);
    let d = bob_decision(&s);
    assert!(matches!(d.action, Action::LockEth { .. }), "{:?}", d.action);
    let want = format!("nominal lock-by {lock_by} has passed (tip {}); the lock is still allowed until the hard limit {hard}", lock_by + 2);
    assert!(d.notes.contains(&want), "{:?}", d.notes);
    assert!(notes_with(&d.notes, "beyond it").is_empty() && notes_with(&d.notes, "at once").is_empty(), "{:?}", d.notes);
}

#[test]
fn past_the_lock_by_the_note_says_so() {
    let mut s = Scenario::new(Variant::Raw);
    let lock_by = s.public.params.lock_by_height;
    let tip = s.world.borrow().tip;
    s.world.borrow_mut().advance_noid(lock_by + 4 - tip);
    let r = s.tick_bob();
    // Bob has not locked and the minimum-window limit lies beyond the lock-by: his action is what it was, a wait for the funding.
    assert_eq!(r.action.kind(), "wait", "{r:?}");
    assert!(r.notes.contains(&format!("lock-by {lock_by} has passed: tip {} is 4 blocks beyond it", lock_by + 4)), "{:?}", r.notes);
}

#[test]
fn no_margin_note_once_the_lock_is_seen() {
    let mut s = Scenario::new(Variant::Raw);
    s.run_to_lock_final();
    let (ra, rb) = s.tick_both();
    assert!(notes_with(&ra.notes, "lock-by").is_empty(), "{:?}", ra.notes);
    assert!(notes_with(&rb.notes, "lock-by").is_empty(), "{:?}", rb.notes);
}

/// The guard that the margin note decides nothing: a decision on the same observations with the tip moved, so that the note changes
/// from plain to warning, is the action the rules alone give. (The phase-by-phase action tests of `scenarios.rs` and the unit tests of
/// the engine assert the actions for every fixture; they are unchanged.) Here: the same two ticks as `scenarios.rs` asserts for the
/// funding gate, with the notes ignored.
#[test]
fn the_margin_note_leaves_the_funding_gate_as_it_was() {
    let s = Scenario::new(Variant::Raw);
    let lock_by = s.public.params.lock_by_height;
    let g = s.gates();
    let tip = s.world.borrow().tip;
    // Just inside the funding gate (tip + b_fund + b_final <= lock_by): fund. One block more: abort.
    let ok_tip = lock_by - g.b_fund - g.b_final;
    let mut s = Scenario::new(Variant::Raw);
    s.world.borrow_mut().advance_noid(ok_tip - tip);
    assert_eq!(s.tick_alice().action.kind(), "fund_noid");
    let mut s = Scenario::new(Variant::Raw);
    s.world.borrow_mut().advance_noid(ok_tip + 1 - tip);
    assert_eq!(s.tick_alice().action.kind(), "abort");
}

// ---------------------------------------------------------------- the note never carries an instruction

/// The funding is offered by `decide` with a short window (3 blocks left), so the note is built beside `fund_noid`; what `tick --apply`
/// then does with the action is the caller's business.
fn alice_with_a_short_funding_window() -> Scenario {
    let s = alice_with_funding_window(3);
    assert!(matches!(alice_decision(&s).action, Action::FundNoid { .. }));
    s
}

/// No note at all may tell the operator to do something now.
fn assert_no_instruction(notes: &[String]) {
    for n in notes.iter().filter(|n| n.starts_with("funding window") || n.starts_with("lock-by")) {
        for word in ["at once", "fund now", "send the lock", "if it is not sent"] {
            assert!(!n.contains(word), "{word:?} in {n:?}");
        }
    }
}

#[test]
fn a_held_fund_noid_intent_leaves_no_instruction_beside_the_wait() {
    let s = alice_with_a_short_funding_window();
    let (tip, now) = (s.world.borrow().tip, s.now());
    let mut file = s.alice.file.clone();
    // The funding was decided on an earlier tick and the chain does not show it yet.
    file.pending_intent = Some(swap_cli::swapfile::PendingIntent {
        action: "fund_noid".into(),
        params: serde_json::json!({}),
        decided_at: now,
        phase_at_decision: "created".into(),
        noid_tip: tip,
        eth_block: 0,
    });
    let (noid, eth) = {
        let w = s.world.borrow();
        (w.noid_obs(None), w.eth_obs())
    };
    let out = swap_cli::engine::tick_apply(&mut file, &noid, &eth, now, true).unwrap();
    assert!(matches!(out.decision.action, Action::Wait { .. }), "{:?}", out.decision);
    let notes = &out.decision.notes;
    assert!(notes.iter().any(|n| n == "held: fresh decision was fund_noid"), "{notes:?}");
    assert_eq!(notes_with(notes, "funding window is short").len(), 1, "{notes:?}");
    assert!(notes_with(notes, "at once").is_empty(), "{notes:?}");
    assert_no_instruction(notes);
}

#[test]
fn an_instance_already_at_the_root_leaves_no_instruction_beside_the_wait() {
    let mut s = alice_with_a_short_funding_window();
    let amount = s.public.params.amount_micronoid;
    {
        let mut w = s.world.borrow_mut();
        w.instances_before.push(swap_cli::watch::NoidInstance { slot_index: 3, creation_id: 5, amount_micronoid: amount });
        w.instances_after.push(swap_cli::watch::NoidInstance { slot_index: 9, creation_id: 2, amount_micronoid: amount });
    }
    // The library path and the `tick --apply` path both run the guard.
    let r = s.tick_alice();
    assert_eq!(r.action.kind(), "wait", "{r:?}");
    assert!(r.notes.iter().any(|n| n.contains("not fund_noid")), "{:?}", r.notes);
    assert_eq!(notes_with(&r.notes, "funding window is short").len(), 1, "{:?}", r.notes);
    assert!(notes_with(&r.notes, "at once").is_empty(), "{:?}", r.notes);
    assert_no_instruction(&r.notes);
    let (noid, eth, now) = {
        let w = s.world.borrow();
        (w.noid_obs(None), w.eth_obs(), w.eth_time)
    };
    let mut file = s.alice.file.clone();
    let out = swap_cli::engine::tick_apply(&mut file, &noid, &eth, now, true).unwrap();
    assert!(matches!(out.decision.action, Action::Wait { .. }), "{:?}", out.decision);
    assert!(out.decision.notes.iter().any(|n| n.contains("not fund_noid")), "{:?}", out.decision.notes);
    assert_eq!(notes_with(&out.decision.notes, "funding window is short").len(), 1, "{:?}", out.decision.notes);
    assert_no_instruction(&out.decision.notes);
}

#[test]
fn a_held_lock_eth_intent_leaves_no_instruction_beside_the_wait() {
    let mut s = Scenario::new(Variant::Raw);
    at_bob_lock(&mut s);
    let lock_by = s.public.params.lock_by_height;
    let tip = s.world.borrow().tip;
    s.world.borrow_mut().advance_noid(lock_by - 4 - tip);
    let (noid, eth, now) = {
        let w = s.world.borrow();
        (w.noid_obs(None), w.eth_obs(), w.eth_time)
    };
    // First tick records the intent, the second is held.
    let mut file = s.bob.file.clone();
    let first = swap_cli::engine::tick_apply(&mut file, &noid, &eth, now, true).unwrap();
    assert_eq!(first.decision.action.kind(), "lock_eth", "{:?}", first.decision);
    assert_no_instruction(&first.decision.notes);
    let second = swap_cli::engine::tick_apply(&mut file, &noid, &eth, now, true).unwrap();
    assert_eq!(second.decision.action.kind(), "wait", "{:?}", second.decision);
    assert_eq!(notes_with(&second.decision.notes, "lock-by margin is short").len(), 1, "{:?}", second.decision.notes);
    assert_no_instruction(&second.decision.notes);
}

/// The note texts in the engine's source are checked as text: no string of the margin note, nor anything else the engine prints, says
/// "at once" (the ban is on the wording, wherever a later change would put it).
#[test]
fn no_engine_text_tells_the_operator_to_act_at_once() {
    let source = include_str!("../src/engine.rs");
    let code: Vec<&str> = source
        .lines()
        .filter(|l| {
            let t = l.trim_start();
            !(t.starts_with("//") || t.starts_with("///") || t.starts_with("//!"))
        })
        .collect();
    let hits: Vec<&&str> = code.iter().filter(|l| l.contains("at once")).collect();
    assert!(hits.is_empty(), "{hits:?}");
    // And the margin note function in particular: no instruction wording in its body, comments included.
    let from = source.find("fn lock_by_margin_note").expect("the function");
    let to = source[from..].find("fn group_thousands").expect("the next function") + from;
    let body = &source[from..to];
    for word in ["at once", "fund now", "send the lock", "not sent yet"] {
        assert!(!body.contains(word), "{word:?} in the margin note");
    }
}
