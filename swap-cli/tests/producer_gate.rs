//! Bob's producer-concentration screen (threat T21, `docs/bob-concentration-gate.md`): the engine's gate in front of `lock_eth`, the
//! reader that counts the producers from the node's own headers, and the alert for a claim that a reorg removed.
//!
//! Every producer in this file is a SYNTHETIC label (`synthetic-miner-A`, ...). No real address appears anywhere.

mod common;

use std::cell::{Cell, RefCell};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::Duration;

use common::http_node::{BatchMode, MockNode};
use common::*;
use serde_json::{json, Value};
use swap_cli::engine::{decide, Action, TickReport, CLAIM_REMOVED_ALERT};
use swap_cli::htlc_harness::seq_bytes;
use swap_cli::params::ProfileName;
use swap_cli::producer_gate::{OVERRIDE_FLAG, OVERRIDE_HISTORY};
use swap_cli::secret::{Secret, Variant};
use swap_cli::state::{BobPhase, Phase};
use swap_cli::swapfile::{example_bob_file, example_public};
use swap_cli::watch::http::HttpJsonRpc;
use swap_cli::watch::producers::{
    cache_path_for, load_cache, producer_id, read_producers, Header, ProducerSummary, ReaderConfig, SecondCheck, BATCH_SIZE,
};
use swap_cli::watch::{JsonRpc, NoidObservation, RpcError};

// ================================================================== the engine gate

const A: &str = "synthetic-miner-A";

/// Bob has seen the funding final and the next tick would lock.
fn at_bob_lock(s: &mut Scenario) {
    s.tick_alice();
    s.world.borrow_mut().advance_noid(1);
    s.tick_both();
    s.world.borrow_mut().advance_noid(18);
    s.tick_alice();
    assert_eq!(s.bob_phase(), "funded");
}

/// A scenario in `profile`, at the point where Bob's lock is next.
fn scenario(profile: ProfileName) -> Scenario {
    let mut s = Scenario::with_profile(Variant::Raw, profile);
    at_bob_lock(&mut s);
    s
}

/// A complete, fresh summary with the given counts (window sizes 2,880 and 720); the largest producer is `synthetic-miner-A`.
fn shape(n: &mut NoidObservation, long: u64, short: u64, two_long: u64, two_short: u64) {
    let (tip, at) = (n.tip, n.observed_at.unwrap());
    let mut p = ProducerSummary::synthetic(tip, 2_880, 720, at, 0, 0);
    p.long.as_mut().unwrap().largest = long;
    p.long.as_mut().unwrap().top_two = two_long;
    p.short.as_mut().unwrap().largest = short;
    p.short.as_mut().unwrap().top_two = two_short;
    // The simulator's second node is always there and agrees, unless a scenario says otherwise.
    p.second = SecondCheck::Agrees { height: tip.saturating_sub(3) };
    n.producers = Some(p);
}

fn tweak(n: &mut NoidObservation, f: impl FnOnce(&mut ProducerSummary)) {
    f(n.producers.as_mut().expect("a summary"));
}

fn wait_reason(r: &TickReport) -> String {
    match &r.action {
        Action::Wait { reason } => reason.clone(),
        other => panic!("expected wait, got {other:?}: {:?}", r.notes),
    }
}

fn note_starting<'a>(r: &'a TickReport, start: &str) -> Vec<&'a String> {
    r.notes.iter().filter(|n| n.starts_with(start)).collect()
}

fn no_address(text: &str) {
    assert!(!text.contains("synthetic-miner"), "an address (label) leaked into: {text}");
    // A bech32m NOID address is `o1` followed by 58 characters of letters and digits.
    for (i, _) in text.match_indices("o1") {
        let tail: String = text[i + 2..].chars().take(20).collect();
        assert!(!(tail.len() == 20 && tail.chars().all(|c| c.is_ascii_alphanumeric())), "an address leaked into: {text}");
    }
}

#[test]
fn production_a_share_exactly_at_the_limit_passes_and_one_block_over_refuses() {
    // 35 % of 2,880 is 1,008; of 720 it is 252.
    for (long, short, locks) in [(1_008, 252, true), (1_009, 252, false), (1_008, 253, false), (1_007, 251, true)] {
        let mut s = scenario(ProfileName::Production);
        let r = s.tick_bob_with(|n, _| shape(n, long, short, long * 3 / 2, short * 3 / 2));
        assert_eq!(r.action.kind() == "lock_eth", locks, "long {long} short {short}: {:?} {:?}", r.action, r.notes);
        if locks {
            assert_eq!(s.bob.executor.count("lock_eth"), 1);
            assert_eq!(note_starting(&r, "producer concentration ok").len(), 1, "{:?}", r.notes);
        } else {
            assert_eq!(s.bob.executor.count("lock_eth"), 0, "nothing is sent");
            assert_eq!(s.bob_phase(), "funding_final", "the file waits, it does not abort");
            let why = wait_reason(&r);
            assert!(why.starts_with("ALARM: producer concentration too high, not locking (T21): "), "{why}");
            assert!(r.notes.contains(&why), "the reason is also the note: {:?}", r.notes);
            no_address(&why);
        }
    }
}

#[test]
fn production_the_refusal_text_is_pinned() {
    let mut s = scenario(ProfileName::Production);
    let r = s.tick_bob_with(|n, _| shape(n, 1_009, 253, 1_600, 400));
    let id = producer_id(A);
    let want = format!(
        "ALARM: producer concentration too high, not locking (T21): producer {id} mined 35.1 % of the last 2,880 blocks (limit 35 %) and 35.2 % of the last 720 (limit 35 %); the two largest together 55.6 % and 55.6 % (warning above 50 %). A miner who is Alice can keep Bob's claim from becoming final until D and take both legs. This is a screen, not a defence. Wait for the share to fall, or pass --accept-producer-concentration to accept the risk"
    );
    assert_eq!(wait_reason(&r), want);
    assert_eq!(id.len(), 8);
    // A different producer in each window is named in each.
    let mut s = scenario(ProfileName::Production);
    let r = s.tick_bob_with(|n, _| {
        shape(n, 1_500, 100, 1_600, 300);
        tweak(n, |p| p.short.as_mut().unwrap().largest_id = "0123abcd".into());
    });
    let why = wait_reason(&r);
    assert!(why.contains(&format!("producer {id} mined 52.1 % of the last 2,880 blocks (limit 35 %) and producer 0123abcd mined 13.9 % of the last 720 (limit 35 %)")), "{why}");
}

#[test]
fn sepolia_and_rehearsal_use_28_percent_and_only_warn() {
    for profile in [ProfileName::Sepolia, ProfileName::Rehearsal] {
        // 28 % of 2,880 is 806.4: 806 passes, 807 is over; the lock is offered either way.
        for (long, over) in [(806, false), (807, true)] {
            let mut s = scenario(profile);
            let r = s.tick_bob_with(|n, _| shape(n, long, 100, long * 3 / 2, 150));
            assert_eq!(r.action.kind(), "lock_eth", "{profile:?} {long}: {:?} {:?}", r.action, r.notes);
            let warn = note_starting(&r, "WARNING: producer concentration too high");
            assert_eq!(warn.len(), usize::from(over), "{profile:?} {long}: {:?}", r.notes);
            if over {
                assert!(warn[0].contains(&format!("under the {} profile it only warns and the lock is still offered", profile.as_str())), "{}", warn[0]);
                assert!(warn[0].contains("(limit 28 %)") && warn[0].contains("This is a screen, not a defence"), "{}", warn[0]);
                no_address(warn[0]);
            } else {
                assert_eq!(note_starting(&r, "producer concentration ok").len(), 1, "{:?}", r.notes);
            }
        }
    }
}

#[test]
fn the_top_two_rule_is_a_warning_in_every_profile_never_a_refusal() {
    for profile in [ProfileName::Production, ProfileName::Sepolia, ProfileName::Rehearsal] {
        // The largest alone is fine (20 %), the two largest hold 50.0 % + 1 block of the long window.
        let mut s = scenario(profile);
        let r = s.tick_bob_with(|n, _| shape(n, 576, 144, 1_441, 360));
        assert_eq!(r.action.kind(), "lock_eth", "{profile:?}: {:?} {:?}", r.action, r.notes);
        let w = note_starting(&r, "WARNING (T21): the two largest producers together");
        assert_eq!(w.len(), 1, "{profile:?}: {:?}", r.notes);
        assert_eq!(
            w[0].as_str(),
            "WARNING (T21): the two largest producers together hold 50.1 % of the last 2,880 blocks and 50.0 % of the last 720 (warning above 50 %); two addresses can be one party. This is a warning only: the lock is not refused for it"
        );
        // Exactly 50 % passes without the warning; the short window alone also draws it.
        let mut s = scenario(profile);
        let r = s.tick_bob_with(|n, _| shape(n, 576, 144, 1_440, 360));
        assert!(note_starting(&r, "WARNING (T21)").is_empty(), "{profile:?}: {:?}", r.notes);
        let mut s = scenario(profile);
        let r = s.tick_bob_with(|n, _| shape(n, 576, 144, 1_000, 361));
        assert_eq!(note_starting(&r, "WARNING (T21)").len(), 1, "{profile:?}: {:?}", r.notes);
        assert_eq!(r.action.kind(), "lock_eth");
    }
}

/// Each way the screen cannot be completed: production waits with an ALARM reason, every other profile offers the lock and warns.
#[test]
fn production_fails_closed_and_the_other_profiles_only_warn_when_the_data_cannot_be_trusted() {
    type Mutator = fn(&mut NoidObservation);
    let cases: Vec<(&str, Mutator, &str, &str)> = vec![
        ("no summary", |n| n.producers = None, "producer concentration cannot be checked", "no producer summary was read in this poll"),
        (
            "headers incomplete",
            |n| {
                let at = n.observed_at.unwrap();
                let mut p = ProducerSummary::synthetic(n.tip, 2_880, 720, at, 300, 450);
                p.complete = false;
                p.long = None;
                p.short = None;
                p.have = 1_420;
                n.producers = Some(p);
            },
            "producer concentration cannot be checked",
            "1,420 of 2,880 headers read so far (the next tick reads on)",
        ),
        (
            "a header failed",
            |n| tweak(n, |p| {
                p.complete = false;
                p.long = None;
                p.short = None;
                p.error = Some("paranoid_getBlockHeader at height 291203 failed: transport: connection refused".into());
            }),
            "producer concentration cannot be checked",
            "paranoid_getBlockHeader at height 291203 failed: transport: connection refused",
        ),
        (
            "other windows",
            |n| tweak(n, |p| p.window_long = 2_000),
            "producer concentration cannot be checked",
            "the summary was computed for windows of 2,000 and 720 blocks, the profile wants 2,880 and 720",
        ),
        (
            "tip three blocks ahead of the headers",
            |n| {
                let tip = n.tip;
                tweak(n, |p| p.header_tip = tip - 3)
            },
            "producer concentration data is stale",
            "(limit 2 blocks behind)",
        ),
        (
            "read 121 s ago",
            |n| {
                let at = n.observed_at.unwrap();
                tweak(n, |p| p.read_at = Some(at - 121))
            },
            "producer concentration data is stale",
            "read 121 s ago (limit 120 s)",
        ),
        (
            "read time unknown",
            |n| tweak(n, |p| p.read_at = None),
            "producer concentration data is stale",
            "the time of the read is unknown",
        ),
        (
            "second node disagrees",
            |n| tweak(n, |p| p.second = SecondCheck::Differs { height: 300_017, first: "3c1d85aa".into(), second: "9a02e4f1".into() }),
            "the two Parano1d nodes disagree about the producers",
            "the block at height 300017 is 3c1d85aa on the first node and 9a02e4f1 on the second",
        ),
        (
            "second node unreadable for the headers",
            |n| tweak(n, |p| p.second = SecondCheck::Unreadable { reason: "paranoid_getBlockHeader at height 300017 failed: transport: timed out".into() }),
            "producer concentration cannot be checked",
            "the second Parano1d node could not be read for the producer cross-check (paranoid_getBlockHeader at height 300017 failed: transport: timed out)",
        ),
        (
            "second node configured but the check did not run",
            |n| tweak(n, |p| p.second = SecondCheck::NotConfigured),
            "producer concentration cannot be checked",
            "a second Parano1d node is configured but the producer cross-check did not run",
        ),
    ];
    for (name, mutate, headline, detail) in cases {
        // production: the lock is held back
        let mut s = scenario(ProfileName::Production);
        let r = s.tick_bob_with(|n, _| mutate(n));
        let why = wait_reason(&r);
        assert!(why.starts_with(&format!("ALARM: {headline}, not locking (T21): ")), "{name}: {why}");
        assert!(why.contains(detail), "{name}: {why}");
        assert_eq!(s.bob.executor.count("lock_eth"), 0, "{name}");
        assert_eq!(s.bob_phase(), "funding_final", "{name}");
        no_address(&why);
        // sepolia and rehearsal: warned, offered
        for profile in [ProfileName::Sepolia, ProfileName::Rehearsal] {
            let mut s = scenario(profile);
            let r = s.tick_bob_with(|n, _| mutate(n));
            assert_eq!(r.action.kind(), "lock_eth", "{name} {profile:?}: {:?} {:?}", r.action, r.notes);
            let w = note_starting(&r, "WARNING: ");
            assert!(w.iter().any(|t| t.contains(headline) && t.contains(detail) && t.contains("only warns and the lock is still offered")), "{name} {profile:?}: {:?}", r.notes);
        }
    }
}

#[test]
fn the_cannot_read_text_is_pinned_and_the_stale_limits_have_their_boundaries() {
    let mut s = scenario(ProfileName::Production);
    let r = s.tick_bob_with(|n, _| {
        tweak_none(n);
    });
    assert_eq!(
        wait_reason(&r),
        "ALARM: producer concentration cannot be checked, not locking (T21): 1,420 of 2,880 headers read so far (the next tick reads on). The gate fails closed: no lock until the last 2,880 headers have been read from the node itself"
    );
    // Two blocks behind and 120 s old still pass; three blocks and 121 s do not.
    for (behind, age, locks) in [(2, 120, true), (3, 120, false), (2, 121, false), (0, 0, true)] {
        let mut s = scenario(ProfileName::Production);
        let r = s.tick_bob_with(|n, _| {
            let (tip, at) = (n.tip, n.observed_at.unwrap());
            tweak(n, |p| {
                p.header_tip = tip - behind;
                p.read_at = Some(at - age);
            })
        });
        assert_eq!(r.action.kind() == "lock_eth", locks, "behind {behind} age {age}: {:?} {:?}", r.action, r.notes);
    }
    // The pinned stale text.
    let mut s = scenario(ProfileName::Production);
    let r = s.tick_bob_with(|n, _| {
        let (tip, at) = (n.tip, n.observed_at.unwrap());
        tweak(n, |p| {
            p.header_tip = tip - 4;
            p.read_at = Some(at - 140);
        })
    });
    let tip = s.world.borrow().tip;
    assert_eq!(
        wait_reason(&r),
        format!("ALARM: producer concentration data is stale, not locking (T21): the headers end at height {} but the node's tip is {tip} (limit 2 blocks behind); read 140 s ago (limit 120 s)", tip - 4)
    );
}

fn tweak_none(n: &mut NoidObservation) {
    let at = n.observed_at.unwrap();
    let mut p = ProducerSummary::synthetic(n.tip, 2_880, 720, at, 300, 450);
    p.complete = false;
    p.long = None;
    p.short = None;
    p.have = 1_420;
    n.producers = Some(p);
}

#[test]
fn the_override_waives_the_production_refusals_prints_every_tick_and_writes_one_history_entry() {
    let mut s = scenario(ProfileName::Production);
    s.world.borrow_mut().accept_producer_concentration = true;
    let id = producer_id(A);
    // Read-only decisions: the warning is there on every one of them.
    let (noid, eth, now) = {
        let w = s.world.borrow();
        let mut n = w.noid_obs(None);
        shape(&mut n, 1_500, 400, 1_800, 500);
        (n, w.eth_obs(), w.eth_time)
    };
    for _ in 0..3 {
        let d = decide(&s.bob.file, &noid, &eth, now);
        assert_eq!(d.action.kind(), "lock_eth", "{:?}", d.notes);
        let warn = note_starting_vec(&d.notes, "WARNING: producer concentration gate OVERRIDDEN by --accept-producer-concentration (T21): ");
        assert_eq!(warn.len(), 1, "{:?}", d.notes);
        assert_eq!(
            warn[0],
            &format!(
                "WARNING: producer concentration gate OVERRIDDEN by {OVERRIDE_FLAG} (T21): producer {id} mined 52.1 % of the last 2,880 blocks (limit 35 %) and 55.6 % of the last 720 (limit 35 %); the two largest together 62.5 % and 69.5 % (warning above 50 %). This is the exposure the gate exists to prevent. Amounts must stay trial-sized"
            )
        );
        no_address(warn[0]);
        assert_eq!(d.log.len(), 1, "{:?}", d.log);
        assert!(d.log[0].starts_with(&format!("{OVERRIDE_HISTORY}: largest 52.1 % of 2880 and 55.6 % of 720")), "{:?}", d.log);
    }
    // The tick that sends it writes the entry, once.
    let r = s.tick_bob_with(|n, _| shape(n, 1_500, 400, 1_800, 500));
    assert_eq!(r.action.kind(), "lock_eth");
    let entries = |s: &Scenario| s.bob.file.history.iter().filter(|h| h.event.starts_with(OVERRIDE_HISTORY)).count();
    assert_eq!(entries(&s), 1);
    // Once it is on record no further entry is proposed.
    let d = decide(&s.bob.file, &noid, &eth, now);
    assert!(d.log.is_empty(), "{:?}", d.log);
    assert_eq!(entries(&s), 1);
    assert_eq!(s.bob.executor.count("lock_eth"), 1);
}

fn note_starting_vec<'a>(notes: &'a [String], start: &str) -> Vec<&'a String> {
    notes.iter().filter(|n| n.starts_with(start)).collect()
}

#[test]
fn the_override_waives_an_incomplete_screen_too_but_never_the_f5_rules() {
    // Owner decision D4: the production refusals of the screen, the fail-closed ones included.
    let mut s = scenario(ProfileName::Production);
    s.world.borrow_mut().accept_producer_concentration = true;
    s.world.borrow_mut().producers = SimProducers::Absent;
    let r = s.tick_bob();
    assert_eq!(r.action.kind(), "lock_eth", "{:?}", r.notes);
    let w = note_starting(&r, "WARNING: producer concentration gate OVERRIDDEN");
    assert_eq!(w.len(), 1, "{:?}", r.notes);
    assert!(w[0].contains("the check could not be completed (producer concentration cannot be checked: no producer summary was read in this poll"), "{}", w[0]);
    assert!(s.bob.file.history.iter().any(|h| h.event == format!("{OVERRIDE_HISTORY}: producer concentration cannot be checked")));
    // The F5 rules are another gate: a second node that cannot be read still holds the lock, flag or not.
    let mut s = scenario(ProfileName::Production);
    s.world.borrow_mut().accept_producer_concentration = true;
    s.world.borrow_mut().second_unreadable = Some("parano1d watcher (second node): transport: connect 10.0.0.9:9601".into());
    let r = s.tick_bob_with(|n, _| shape(n, 1_500, 400, 1_800, 500));
    assert!(wait_reason(&r).contains("the second node could not be read"), "{:?}", r.action);
    assert_eq!(s.bob.executor.count("lock_eth"), 0);
    // A single node still needs --single-node-ok (F5), the screen's flag does not stand in for it.
    let mut s = scenario(ProfileName::Production);
    s.world.borrow_mut().accept_producer_concentration = true;
    s.world.borrow_mut().single_node = true;
    let r = s.tick_bob();
    assert!(wait_reason(&r).contains("a second node is required before this step (F5)"), "{:?}", r.action);
}

#[test]
fn without_the_flag_nothing_is_waived_and_no_profile_implies_it() {
    assert!(!NoidObservation::default().accept_producer_concentration);
    for (profile, enforced) in [(ProfileName::Production, true), (ProfileName::Sepolia, false), (ProfileName::Rehearsal, false)] {
        assert_eq!(profile.gates().producer_gate_enforced, enforced, "{profile:?}");
    }
    // Absent flag: refused (the world's default is false).
    let mut s = scenario(ProfileName::Production);
    assert!(!s.world.borrow().accept_producer_concentration);
    let r = s.tick_bob_with(|n, _| shape(n, 2_000, 700, 2_100, 710));
    assert!(wait_reason(&r).contains("pass --accept-producer-concentration to accept the risk"));
    // The flag has no effect under sepolia: the warning is the ordinary one, no OVERRIDDEN text, no history entry.
    let mut s = scenario(ProfileName::Sepolia);
    s.world.borrow_mut().accept_producer_concentration = true;
    let r = s.tick_bob_with(|n, _| shape(n, 2_000, 700, 2_100, 710));
    assert_eq!(r.action.kind(), "lock_eth");
    assert!(note_starting(&r, "WARNING: producer concentration gate OVERRIDDEN").is_empty(), "{:?}", r.notes);
    assert_eq!(note_starting(&r, "WARNING: producer concentration too high").len(), 1);
    assert!(s.bob.file.history.iter().all(|h| !h.event.starts_with(OVERRIDE_HISTORY)));
}

#[test]
fn while_bob_waits_the_screen_is_said_as_information_and_decides_nothing() {
    for profile in [ProfileName::Production, ProfileName::Sepolia] {
        let mut s = Scenario::with_profile(Variant::Raw, profile);
        s.tick_alice();
        s.world.borrow_mut().advance_noid(1);
        // Over the limit while Bob only waits for the funding: a note, the same wait.
        let r = s.tick_bob_with(|n, _| shape(n, 2_000, 700, 2_100, 710));
        assert_eq!(r.action.kind(), "wait", "{r:?}");
        let n = note_starting(&r, "producer concentration, not yet blocking (the lock is decided when the funding is final; T21): producer concentration too high: ");
        assert_eq!(n.len(), 1, "{:?}", r.notes);
        assert_eq!(s.bob_phase(), "funded");
        // No summary read (a phase or a command that asks for none): silent.
        let r = s.tick_bob_with(|n, _| n.producers = None);
        assert!(note_starting(&r, "producer concentration").is_empty(), "{:?}", r.notes);
    }
}

// ---------------------------------------------------------------- nothing else changes

/// One complete swap, tick by tick: `(who, action kind, phase after)` for every tick of both roles.
fn trace(profile: ProfileName, variant: Variant, producers: SimProducers, accept: bool) -> Vec<(String, String, String)> {
    let mut s = Scenario::with_profile(variant, profile);
    {
        let mut w = s.world.borrow_mut();
        w.producers = producers;
        w.accept_producer_concentration = accept;
    }
    let mut out: Vec<(String, String, String)> = Vec::new();
    let both = |s: &mut Scenario, out: &mut Vec<(String, String, String)>| {
        let a = s.tick_alice();
        out.push(("alice".into(), a.action.kind().into(), s.alice_phase()));
        let b = s.tick_bob();
        out.push(("bob".into(), b.action.kind().into(), s.bob_phase()));
    };
    both(&mut s, &mut out);
    s.world.borrow_mut().advance_noid(1);
    both(&mut s, &mut out);
    s.world.borrow_mut().advance_noid(18);
    both(&mut s, &mut out);
    s.world.borrow_mut().advance_eth(1);
    both(&mut s, &mut out);
    let lag = s.world.borrow().finality_lag;
    s.world.borrow_mut().advance_eth(lag + 1);
    both(&mut s, &mut out);
    s.world.borrow_mut().advance_eth(1);
    s.world.borrow_mut().advance_noid(1);
    both(&mut s, &mut out);
    s.world.borrow_mut().advance_eth(lag + 1);
    s.world.borrow_mut().advance_noid(18);
    both(&mut s, &mut out);
    both(&mut s, &mut out);
    out
}

#[test]
fn guard_every_decision_of_a_whole_swap_is_the_same_with_the_screen_healthy_absent_or_failing_where_it_does_not_bite() {
    for variant in [Variant::Raw, Variant::Stock] {
        // Under the warning profiles the screen decides nothing: healthy, absent and over the limit give one and the same trace.
        for profile in [ProfileName::Rehearsal, ProfileName::Sepolia] {
            let base = trace(profile, variant, SimProducers::Healthy, false);
            assert!(base.iter().any(|(_, a, _)| a == "lock_eth") && base.iter().any(|(_, a, _)| a == "reveal_eth") && base.iter().any(|(_, a, _)| a == "claim_noid"), "{base:?}");
            assert_eq!(base, trace(profile, variant, SimProducers::Absent, false), "{profile:?} {variant:?}: absent");
            let mut over = ProducerSummary::synthetic(0, 2_880, 720, 0, 900, 950);
            over.complete = false;
            // (the Fixed summary is stale against every tick of the swap; it still must not change one decision)
            assert_eq!(base, trace(profile, variant, SimProducers::Fixed(over), false), "{profile:?} {variant:?}: stale and over");
            assert_eq!(base, trace(profile, variant, SimProducers::Healthy, true), "{profile:?} {variant:?}: the flag");
        }
        // Under production a healthy screen changes nothing, and the override with no data at all gives the same trace.
        let base = trace(ProfileName::Production, variant, SimProducers::Healthy, false);
        assert_eq!(base, trace(ProfileName::Production, variant, SimProducers::Absent, true), "{variant:?}: override, no data");
        assert_eq!(base, trace(ProfileName::Production, variant, SimProducers::Healthy, true), "{variant:?}: flag, healthy");
        // Alice never reads headers: her ticks are the same even where the screen holds Bob back.
        let blocked = trace(ProfileName::Production, variant, SimProducers::Absent, false);
        let alice = |t: &[(String, String, String)]| t.iter().filter(|(w, _, _)| w == "alice").take(3).cloned().collect::<Vec<_>>();
        assert_eq!(alice(&base), alice(&blocked));
        assert!(blocked.iter().all(|(w, a, _)| !(w == "bob" && a == "lock_eth")), "production fails closed without data: {blocked:?}");
    }
}

// ---------------------------------------------------------------- the alert for a removed claim

fn bob_claim_included_unticked() -> (Scenario, String) {
    let mut s = Scenario::new(Variant::Raw);
    s.run_to_lock_final();
    s.tick_alice();
    s.tick_bob();
    s.world.borrow_mut().advance_eth(1);
    s.world.borrow_mut().advance_noid(1);
    s.tick_both();
    let txid = match &s.bob.file.phase {
        Phase::Bob(BobPhase::ClaimIncluded { txid, .. }) => txid.clone(),
        other => panic!("{other:?}"),
    };
    s.world.borrow_mut().advance_noid(18);
    (s, txid)
}

#[test]
fn the_removed_claim_alert_is_on_the_reorg_path_and_nowhere_else() {
    // Nowhere else: a whole happy swap, both roles, every tick.
    let mut s = Scenario::new(Variant::Raw);
    s.run_to_lock_final();
    let mut all: Vec<String> = Vec::new();
    for _ in 0..6 {
        let (a, b) = s.tick_both();
        all.extend(a.notes);
        all.extend(b.notes);
        s.world.borrow_mut().advance_eth(1);
        s.world.borrow_mut().advance_noid(6);
    }
    assert!(all.iter().all(|n| !n.starts_with("ALERT:")), "{all:?}");
    // The reorg path: the claim is gone and not pending.
    let (mut s, txid) = bob_claim_included_unticked();
    s.world.borrow_mut().drop_close(&txid, false);
    let rb = s.tick_bob();
    assert_eq!(rb.events, vec!["noid_tx_reorged", "claim_submitted"], "{rb:?}");
    let alerts = note_starting(&rb, "ALERT:");
    assert_eq!(alerts, vec![&CLAIM_REMOVED_ALERT.to_string()], "{:?}", rb.notes);
    assert!(CLAIM_REMOVED_ALERT.contains("bash $L/bin/claim.sh") && CLAIM_REMOVED_ALERT.contains("--submit"));
    assert!(!CLAIM_REMOVED_ALERT.contains('\n'));
    // No address, amount or txid in it.
    assert!(!CLAIM_REMOVED_ALERT.contains(&txid) && !CLAIM_REMOVED_ALERT.contains("o1"));
    // The next tick has none (the transition was taken).
    s.world.borrow_mut().advance_noid(1);
    let next = s.tick_bob();
    assert!(note_starting(&next, "ALERT:").is_empty(), "{:?}", next.notes);
    // Pending again: the file goes to claim_submitted and nothing needs sending; no alert.
    let (mut s, txid) = bob_claim_included_unticked();
    s.world.borrow_mut().drop_close(&txid, true);
    let rb = s.tick_bob();
    assert_eq!(rb.events, vec!["noid_tx_reorged"], "{rb:?}");
    assert!(note_starting(&rb, "ALERT:").is_empty(), "{:?}", rb.notes);
    assert!(rb.notes.iter().any(|n| n.contains("REORG")), "the old note stays: {:?}", rb.notes);
}

// ================================================================== the reader

/// A synthetic Parano1d chain served as headers: heights `0..=top`, a fork tag per height so a reorg changes every hash from some height up.
struct FakeNode {
    tags: RefCell<Vec<u64>>,
    /// `Cell`s: the knobs and the counters.
    batch: Cell<u8>, // 0 = array, 1 = refuse (Err), 2 = one answer short
    fail_at: Cell<Option<u64>>,
    null_at: Cell<Option<u64>>,
    bad_prev_at: Cell<Option<u64>>,
    delay_ms: Cell<u64>,
    singles: Cell<usize>,
    batches: Cell<usize>,
    asked: RefCell<Vec<u64>>,
}

fn miner(h: u64) -> String {
    // 30 % A, 15 % B, the rest spread over six more: deterministic, so the expected counts can be computed independently.
    let r = h % 100;
    match r {
        0..=29 => A.to_string(),
        30..=44 => "synthetic-miner-B".to_string(),
        _ => format!("synthetic-miner-{}", (b'C' + (r % 6) as u8) as char),
    }
}

fn hash_of(h: u64, tag: u64) -> String {
    format!("{:016x}{:016x}{:016x}{:016x}", h, tag, h ^ 0xabcdef, tag.wrapping_mul(7919))
}

/// The reply of `paranoid_getBlockHeader`: the fields of `BlockHeaderInfo`, with a synthetic miner.
fn header_value(h: u64, hash: String, prev_hash: String) -> Value {
    json!({
        "height": h, "hash": hash, "prev_hash": prev_hash, "state_root": "00", "tx_root": "00",
        "timestamp": 1_700_000_000u64 + h * 30, "miner": miner(h), "nonce_hex": "00", "difficulty_target": "00",
        "log_slots": 1, "active_slot_count": 1, "alloc_counter": 1
    })
}

/// A header of the one-fork chain (every fork tag 0), without a node object.
fn plain_header(h: u64) -> Value {
    header_value(h, hash_of(h, 0), if h == 0 { "0".repeat(64) } else { hash_of(h - 1, 0) })
}

fn sec(n: &FakeNode, tip: Option<u64>) -> Option<(&dyn JsonRpc, Option<u64>)> {
    Some((n, tip))
}

impl FakeNode {
    fn new(top: u64) -> Self {
        Self {
            tags: RefCell::new(vec![0; top as usize + 1]),
            batch: Cell::new(0),
            fail_at: Cell::new(None),
            null_at: Cell::new(None),
            bad_prev_at: Cell::new(None),
            delay_ms: Cell::new(0),
            singles: Cell::new(0),
            batches: Cell::new(0),
            asked: RefCell::new(Vec::new()),
        }
    }
    fn top(&self) -> u64 {
        self.tags.borrow().len() as u64 - 1
    }
    fn extend(&self, n: u64) {
        for _ in 0..n {
            self.tags.borrow_mut().push(0);
        }
    }
    fn reorg_from(&self, h: u64) {
        for t in self.tags.borrow_mut().iter_mut().skip(h as usize) {
            *t += 1;
        }
    }
    fn hash(&self, h: u64) -> String {
        hash_of(h, self.tags.borrow()[h as usize])
    }
    fn header(&self, h: u64) -> Result<Value, RpcError> {
        self.asked.borrow_mut().push(h);
        if self.fail_at.get() == Some(h) {
            return Err(RpcError::Transport("connection refused".into()));
        }
        if self.null_at.get() == Some(h) || h > self.top() {
            return Ok(Value::Null);
        }
        let prev = if h == 0 { "0".repeat(64) } else { self.hash(h - 1) };
        let prev = if self.bad_prev_at.get() == Some(h) { "f".repeat(64) } else { prev };
        Ok(header_value(h, self.hash(h), prev))
    }
    fn expected(&self, tip: u64, window: u64) -> (u64, u64, u64) {
        let mut counts: HashMap<String, u64> = HashMap::new();
        for h in tip + 1 - window..=tip {
            *counts.entry(miner(h)).or_default() += 1;
        }
        let mut v: Vec<u64> = counts.values().copied().collect();
        v.sort_unstable_by(|a, b| b.cmp(a));
        (v[0], v[0] + v.get(1).copied().unwrap_or(0), v.len() as u64)
    }
}

impl JsonRpc for FakeNode {
    fn call(&self, method: &str, params: Value) -> Result<Value, RpcError> {
        assert_eq!(method, "paranoid_getBlockHeader");
        self.singles.set(self.singles.get() + 1);
        if self.delay_ms.get() > 0 {
            std::thread::sleep(Duration::from_millis(self.delay_ms.get()));
        }
        self.header(params[0].as_u64().unwrap())
    }
    fn call_batch(&self, method: &str, params: &[Value]) -> Result<Vec<Result<Value, RpcError>>, RpcError> {
        assert_eq!(method, "paranoid_getBlockHeader");
        assert!(params.len() <= BATCH_SIZE, "a batch of {} calls", params.len());
        self.batches.set(self.batches.get() + 1);
        if self.delay_ms.get() > 0 {
            std::thread::sleep(Duration::from_millis(self.delay_ms.get()));
        }
        match self.batch.get() {
            1 => Err(RpcError::Decode("batch reply is not an array".into())),
            mode => {
                let mut out: Vec<Result<Value, RpcError>> = params.iter().map(|p| self.header(p[0].as_u64().unwrap())).collect();
                if mode == 2 {
                    out.pop();
                }
                Ok(out)
            }
        }
    }
}

fn cfg() -> ReaderConfig {
    let mut c = ReaderConfig::new(2_880, 720);
    c.source = Some("http://127.0.0.1:9601".into());
    c.clock = || 1_700_000_000;
    c
}

fn cache_in(dir: &tempfile::TempDir) -> PathBuf {
    cache_path_for(&dir.path().join("bob.swap.json"))
}

#[test]
fn a_cold_read_uses_batches_checks_the_links_and_counts_both_windows() {
    let node = FakeNode::new(10_000);
    let dir = tempfile::tempdir().unwrap();
    let sum = read_producers(&node, None, &cache_in(&dir), 10_000, &cfg());
    assert!(sum.complete && sum.error.is_none(), "{sum:?}");
    assert_eq!((sum.tip, sum.header_tip, sum.have, sum.headers_read), (10_000, 10_000, 2_880, 2_880));
    assert_eq!(node.batches.get(), 12, "2,880 headers in batches of 250");
    assert_eq!(node.singles.get(), 0);
    assert_eq!(sum.read_at, Some(1_700_000_000));
    assert_eq!(sum.source.as_deref(), Some("http://127.0.0.1:9601"));
    for (share, n) in [(sum.long.as_ref().unwrap(), 2_880u64), (sum.short.as_ref().unwrap(), 720)] {
        let (largest, two, distinct) = node.expected(10_000, n);
        assert_eq!((share.n, share.largest, share.top_two, share.distinct), (n, largest, two, distinct), "{share:?}");
        assert_eq!(share.largest_id, producer_id(A));
    }
    // The cache holds the window, one line per height, readable only by the owner.
    let cache = load_cache(&cache_in(&dir)).unwrap();
    assert_eq!(cache.first().unwrap().height, 10_000 + 1 - 2_880, "only the window is read");
    assert_eq!(cache.last().unwrap().height, 10_000);
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(std::fs::metadata(cache_in(&dir)).unwrap().permissions().mode() & 0o777, 0o600);
    }
}

#[test]
fn a_warm_tick_reads_only_the_new_headers() {
    let node = FakeNode::new(10_000);
    let dir = tempfile::tempdir().unwrap();
    let first = read_producers(&node, None, &cache_in(&dir), 10_000, &cfg());
    assert!(first.complete);
    // Same tip: only the check of the cache's top header (one).
    node.asked.borrow_mut().clear();
    let again = read_producers(&node, None, &cache_in(&dir), 10_000, &cfg());
    assert!(again.complete, "{again:?}");
    assert_eq!(again.headers_read, 1);
    assert_eq!(*node.asked.borrow(), vec![10_000]);
    assert_eq!(again.long, first.long);
    // Two new blocks: the top check and the two new heights, and nothing else.
    node.extend(2);
    node.asked.borrow_mut().clear();
    let next = read_producers(&node, None, &cache_in(&dir), 10_002, &cfg());
    assert!(next.complete, "{next:?}");
    assert!(next.headers_read <= 3, "{}", next.headers_read);
    assert_eq!(*node.asked.borrow(), vec![10_000, 10_001, 10_002]);
    let (largest, _, _) = node.expected(10_002, 2_880);
    assert_eq!(next.long.as_ref().unwrap().largest, largest);
    assert_eq!(next.long.as_ref().unwrap().n, 2_880, "the window slid with the tip");
}

#[test]
fn a_hash_mismatch_rereads_from_the_match_and_gives_the_same_counts_as_a_fresh_read() {
    let node = FakeNode::new(10_000);
    let dir = tempfile::tempdir().unwrap();
    assert!(read_producers(&node, None, &cache_in(&dir), 10_000, &cfg()).complete);
    // A reorg replaces the last five blocks (10,996 to 10,000 here: heights 9,996..=10,000) and the chain grows by two.
    node.reorg_from(9_996);
    node.extend(2);
    node.asked.borrow_mut().clear();
    let sum = read_producers(&node, None, &cache_in(&dir), 10_002, &cfg());
    assert!(sum.complete && sum.error.is_none(), "{sum:?}");
    assert_eq!(sum.mismatch_depth, Some(5), "the highest height that still matched is 9,995");
    // It read the top, walked down, then the six new heights 9,996..=10,002; not the whole window.
    assert!(sum.headers_read < 40, "{}", sum.headers_read);
    // The same chain read from nothing gives the same answer.
    let fresh_dir = tempfile::tempdir().unwrap();
    let fresh = read_producers(&node, None, &cache_in(&fresh_dir), 10_002, &cfg());
    assert_eq!((sum.long.clone(), sum.short.clone()), (fresh.long, fresh.short));
    let (a, b) = (load_cache(&cache_in(&dir)).unwrap(), load_cache(&cache_in(&fresh_dir)).unwrap());
    let from = a[0].height.max(b[0].height);
    let pick = |v: &[Header]| v.iter().filter(|h| h.height >= from).cloned().collect::<Vec<_>>();
    assert_eq!(pick(&a), pick(&b), "the repaired cache holds the new chain");
}

#[test]
fn a_mismatch_deeper_than_64_discards_the_cache_and_reads_in_full() {
    let node = FakeNode::new(10_000);
    let dir = tempfile::tempdir().unwrap();
    assert!(read_producers(&node, None, &cache_in(&dir), 10_000, &cfg()).complete);
    node.reorg_from(9_900);
    let sum = read_producers(&node, None, &cache_in(&dir), 10_000, &cfg());
    assert!(sum.complete, "{sum:?}");
    assert_eq!(sum.mismatch_depth, Some(65), "nothing matched within 64");
    assert!(sum.headers_read >= 2_880, "{}", sum.headers_read);
}

#[test]
fn a_broken_cache_file_is_discarded_and_rewritten() {
    for garbage in [
        "not a cache\n".to_string(),
        "1 2 3\n".to_string(),
        "7 aa bb cc dd\n".to_string(),
        // a gap, and a line that does not link to the one above
        format!("100 {} {} 5 m\n102 {} {} 6 m\n", hash_of(100, 0), hash_of(99, 0), hash_of(102, 0), hash_of(101, 0)),
        format!("100 {} {} 5 m\n101 {} {} 6 m\n", hash_of(100, 0), hash_of(99, 0), hash_of(101, 0), hash_of(55, 0)),
    ] {
        let node = FakeNode::new(10_000);
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(cache_in(&dir), garbage).unwrap();
        let sum = read_producers(&node, None, &cache_in(&dir), 10_000, &cfg());
        assert!(sum.complete && sum.error.is_none(), "{sum:?}");
        assert_eq!(sum.headers_read, 2_880, "read in full");
        assert!(load_cache(&cache_in(&dir)).is_ok(), "rewritten as a good cache");
    }
}

#[test]
fn a_batch_the_node_refuses_or_answers_short_falls_back_to_single_calls() {
    for mode in [1u8, 2] {
        let node = FakeNode::new(10_000);
        node.batch.set(mode);
        let dir = tempfile::tempdir().unwrap();
        let sum = read_producers(&node, None, &cache_in(&dir), 10_000, &cfg());
        assert!(sum.complete && sum.error.is_none(), "mode {mode}: {sum:?}");
        assert_eq!(node.singles.get(), 2_880, "mode {mode}: every height was asked singly");
        let (largest, _, _) = node.expected(10_000, 2_880);
        assert_eq!(sum.long.as_ref().unwrap().largest, largest);
    }
}

#[test]
fn every_failure_is_an_incomplete_summary_with_its_reason() {
    let dir = tempfile::tempdir().unwrap();
    // A failed call.
    let node = FakeNode::new(10_000);
    node.fail_at.set(Some(9_000));
    let sum = read_producers(&node, None, &cache_in(&dir), 10_000, &cfg());
    assert!(!sum.complete && sum.long.is_none());
    let e = sum.error.clone().unwrap();
    assert!(e.starts_with("paranoid_getBlockHeader at height 9000 failed: "), "{e}");
    // A null header.
    let node = FakeNode::new(10_000);
    node.null_at.set(Some(9_100));
    let dir = tempfile::tempdir().unwrap();
    let e = read_producers(&node, None, &cache_in(&dir), 10_000, &cfg()).error.unwrap();
    assert!(e.contains("height 9100") && e.contains("no header"), "{e}");
    // A header that does not link to the one below it: nothing from that chunk is kept.
    let node = FakeNode::new(10_000);
    node.bad_prev_at.set(Some(9_500));
    let dir = tempfile::tempdir().unwrap();
    let sum = read_producers(&node, None, &cache_in(&dir), 10_000, &cfg());
    assert!(!sum.complete);
    assert_eq!(
        sum.error.as_deref(),
        Some("the header at height 9500 does not link to the header below it (a reorg during the read; the next tick reads again)")
    );
    // A chain shorter than the window.
    let node = FakeNode::new(1_000);
    let dir = tempfile::tempdir().unwrap();
    let sum = read_producers(&node, None, &cache_in(&dir), 1_000, &cfg());
    assert!(!sum.complete && sum.error.unwrap().contains("shorter than the long window"));
    // A node that has no header at the tip itself (the tip was raised past the chain).
    let node = FakeNode::new(10_000);
    let dir = tempfile::tempdir().unwrap();
    let sum = read_producers(&node, None, &cache_in(&dir), 10_001, &cfg());
    assert!(!sum.complete && sum.error.unwrap().contains("height 10001"));
}

#[test]
fn the_budget_stops_a_tick_and_the_next_one_goes_on_without_rereading() {
    let node = FakeNode::new(10_000);
    node.delay_ms.set(30);
    let dir = tempfile::tempdir().unwrap();
    let mut c = cfg();
    c.batch = 100;
    c.budget = Duration::from_millis(100);
    let mut have = 0;
    let mut ticks = 0;
    loop {
        let sum = read_producers(&node, None, &cache_in(&dir), 10_000, &c);
        ticks += 1;
        assert!(sum.error.is_none(), "running out of time is not an error: {sum:?}");
        assert!(sum.have >= have, "progress is kept");
        have = sum.have;
        if sum.complete {
            break;
        }
        assert!(!sum.complete && sum.long.is_none() && sum.have < 2_880);
        assert!(ticks < 100, "it must finish");
    }
    assert!(ticks > 1, "the first tick could not finish in its budget");
    // Every height of the window was fetched once; the extra asks are the cache-top checks, one per later tick.
    let asked = node.asked.borrow();
    assert!(asked.len() <= 2_880 + ticks, "{} asks in {ticks} ticks", asked.len());
}

#[test]
fn the_second_node_agrees_differs_or_cannot_be_read() {
    let first = FakeNode::new(10_000);
    let dir = tempfile::tempdir().unwrap();
    let agree = FakeNode::new(10_000);
    let sum = read_producers(&first, sec(&agree, Some(10_000)), &cache_in(&dir), 10_000, &cfg());
    assert_eq!(sum.second, SecondCheck::Agrees { height: 9_997 }, "{sum:?}");
    assert_eq!(*agree.asked.borrow(), vec![9_997]);
    // The lower tip decides the anchor.
    let sum = read_producers(&first, sec(&agree, Some(9_990)), &cache_in(&dir), 10_000, &cfg());
    assert_eq!(sum.second, SecondCheck::Agrees { height: 9_987 });
    // Another block at the anchor: different hashes.
    let other = FakeNode::new(10_000);
    other.reorg_from(9_990);
    let sum = read_producers(&first, sec(&other, Some(10_000)), &cache_in(&dir), 10_000, &cfg());
    match &sum.second {
        SecondCheck::Differs { height, first: a, second: b } => {
            assert_eq!(*height, 9_997);
            assert_eq!(a, &hash_of(9_997, 0)[..8]);
            assert_eq!(b, &hash_of(9_997, 1)[..8]);
        }
        other => panic!("{other:?}"),
    }
    // A second node that fails, one whose tip is unknown, and a first node whose data is incomplete.
    let broken = FakeNode::new(10_000);
    broken.fail_at.set(Some(9_997));
    let sum = read_producers(&first, sec(&broken, Some(10_000)), &cache_in(&dir), 10_000, &cfg());
    assert!(matches!(&sum.second, SecondCheck::Unreadable { reason } if reason.contains("height 9997")), "{:?}", sum.second);
    let sum = read_producers(&first, sec(&agree, None), &cache_in(&dir), 10_000, &cfg());
    assert!(matches!(&sum.second, SecondCheck::Unreadable { reason } if reason.contains("tip is unknown")), "{:?}", sum.second);
    let sum = read_producers(&first, None, &cache_in(&dir), 10_000, &cfg());
    assert_eq!(sum.second, SecondCheck::NotConfigured);
}

#[test]
fn the_summary_and_its_json_never_hold_an_address_but_the_cache_file_does() {
    let node = FakeNode::new(10_000);
    let dir = tempfile::tempdir().unwrap();
    let sum = read_producers(&node, None, &cache_in(&dir), 10_000, &cfg());
    let json = serde_json::to_string(&sum).unwrap();
    no_address(&json);
    let obs = NoidObservation { producers: Some(sum), ..Default::default() };
    no_address(&serde_json::to_string(&obs).unwrap());
    // The observation round-trips, and an old one without the field still loads.
    let back: NoidObservation = serde_json::from_str(&serde_json::to_string(&obs).unwrap()).unwrap();
    assert_eq!(back, obs);
    let plain = serde_json::to_string(&NoidObservation::default()).unwrap();
    assert!(!plain.contains("producers") && !plain.contains("accept_producer_concentration"), "{plain}");
    let old: NoidObservation = serde_json::from_str(&plain).unwrap();
    assert!(old.producers.is_none() && !old.accept_producer_concentration);
    // The cache keeps the address (it must, to count), locally.
    assert!(std::fs::read_to_string(cache_in(&dir)).unwrap().contains(A));
}

// ---------------------------------------------------------------- batches over the real HTTP client

#[test]
fn http_batches_come_back_in_order_and_a_refusing_node_falls_back_to_single_calls() {
    let mk = |mode: BatchMode| {
        MockNode::spawn_with(
            |m, p| {
                assert_eq!(m, "paranoid_getBlockHeader");
                Ok(plain_header(p[0].as_u64().unwrap()))
            },
            mode,
        )
    };
    // The batch itself.
    let node = mk(BatchMode::Array);
    let rpc = HttpJsonRpc::new(&node.url).unwrap();
    let params: Vec<Value> = (100..110u64).map(|h| json!([h])).collect();
    let answers = rpc.call_batch("paranoid_getBlockHeader", &params).unwrap();
    assert_eq!(answers.len(), 10);
    for (i, a) in answers.iter().enumerate() {
        assert_eq!(a.as_ref().unwrap()["height"], 100 + i as u64);
    }
    assert_eq!(node.count("<batch>"), 1, "one request for ten calls");
    // A node without batch support (one error object) or with a short array: the transport says so.
    for mode in [BatchMode::Refuse, BatchMode::Short] {
        let node = mk(mode);
        let rpc = HttpJsonRpc::new(&node.url).unwrap();
        assert!(rpc.call_batch("paranoid_getBlockHeader", &params).is_err());
    }
    // The reader on top of it: complete in every case (small windows keep the single-call fallback quick). 300 headers are two chunks.
    for (mode, want_batches, want_header_calls) in [(BatchMode::Array, 2usize, 300usize), (BatchMode::Short, 2, 600)] {
        let node = mk(mode);
        let rpc = HttpJsonRpc::new(&node.url).unwrap();
        let dir = tempfile::tempdir().unwrap();
        let mut c = ReaderConfig::new(300, 100);
        c.clock = || 1_700_000_000;
        let sum = read_producers(&rpc, None, &cache_in(&dir), 5_000, &c);
        assert!(sum.complete && sum.error.is_none(), "{sum:?}");
        assert_eq!(node.count("<batch>"), want_batches);
        assert_eq!(node.count("paranoid_getBlockHeader"), want_header_calls, "a short answer is thrown away and every height asked again");
    }
    let node = mk(BatchMode::Refuse);
    let rpc = HttpJsonRpc::new(&node.url).unwrap();
    let dir = tempfile::tempdir().unwrap();
    let mut c = ReaderConfig::new(300, 100);
    c.clock = || 1_700_000_000;
    let sum = read_producers(&rpc, None, &cache_in(&dir), 5_000, &c);
    assert!(sum.complete && sum.error.is_none(), "{sum:?}");
    assert_eq!(node.count("<batch refused>"), 2, "each chunk tried a batch once");
    assert_eq!(node.count("paranoid_getBlockHeader"), 300, "and then every height singly");
}

// ---------------------------------------------------------------- the whole tick, through the binary

fn bin() -> Command {
    Command::new(env!("CARGO_BIN_EXE_swap-cli"))
}

fn run(cmd: &mut Command) -> (bool, String, String) {
    let out = cmd.output().expect("run swap-cli");
    (out.status.success(), String::from_utf8_lossy(&out.stdout).into_owned(), String::from_utf8_lossy(&out.stderr).into_owned())
}

fn s(p: &Path) -> &str {
    p.to_str().unwrap()
}

#[test]
fn tick_reads_the_headers_into_a_cache_beside_the_swap_file_and_prints_no_address() {
    let dir = tempfile::tempdir().unwrap();
    let b = dir.path().join("b.swap.json");
    example_bob_file(example_public(&Secret::from_bytes(seq_bytes(0x33)), Variant::Raw), 1).unwrap().save(&b).unwrap();
    let fx = Path::new(env!("CARGO_MANIFEST_DIR")).join("fixtures");
    let eth_fx = fx.join("eth/locked.json");
    // Two nodes (production needs the second node's cross-check for the producer check): each serves the fixture's chain state and a synthetic
    // header for every height up to its tip (280,517), the same chain.
    let spawn_node = || {
        let replay = swap_cli::watch::FixtureRpc::from_file(&fx.join("parano1d/idle.json")).unwrap();
        MockNode::spawn(move |m, p| {
            if m == "paranoid_getBlockHeader" {
                let h = p[0].as_u64().unwrap();
                if h > 280_517 {
                    return Ok(Value::Null);
                }
                return Ok(plain_header(h));
            }
            JsonRpc::call(&replay, m, p.clone())
        })
    };
    let (node, node2) = (spawn_node(), spawn_node());
    let flags = ["--eth-fixture", s(&eth_fx), "--noid-rpc", node.url.as_str(), "--noid-rpc", node2.url.as_str()];
    let swap_before = std::fs::read(&b).unwrap();
    let (ok, out, err) = run(bin().args(["tick", s(&b)]).args(flags));
    assert!(ok, "{err}");
    let v: Value = serde_json::from_str(&out).unwrap();
    let p = &v["noid"]["producers"];
    assert_eq!(p["complete"], true, "{p}");
    assert_eq!(p["window_long"], 2_880);
    assert_eq!(p["tip"], 280_517);
    assert_eq!(p["second"]["state"], "agrees", "{p}");
    assert!(p["headers_read"].as_u64().unwrap() >= 2_880);
    assert!(v["notes"].as_array().unwrap().iter().any(|n| n.as_str().unwrap().starts_with("producer concentration ok (T21 screen, not a defence): largest producer ")), "{}", v["notes"]);
    // No address on stdout; the cache is the local file beside the swap file.
    assert!(!out.contains("synthetic-miner"), "an address was printed");
    let cache = cache_path_for(&b);
    assert!(cache.exists() && std::fs::read_to_string(&cache).unwrap().contains("synthetic-miner"));
    // The swap file itself did not change (a read-only tick), and a second tick reads a few headers only.
    assert_eq!(std::fs::read(&b).unwrap(), swap_before);
    let (ok, out2, err) = run(bin().args(["tick", s(&b)]).args(flags));
    assert!(ok, "{err}");
    let v2: Value = serde_json::from_str(&out2).unwrap();
    assert!(v2["noid"]["producers"]["headers_read"].as_u64().unwrap() <= 3, "{}", v2["noid"]["producers"]);
    // The override flag reaches the engine and is shown in the observation.
    let (ok, out3, err) = run(bin().args(["tick", s(&b), "--accept-producer-concentration"]).args(flags));
    assert!(ok, "{err}");
    let v3: Value = serde_json::from_str(&out3).unwrap();
    assert_eq!(v3["noid"]["accept_producer_concentration"], true);
    // One node only, with --single-node-ok (which waives the F5 second-node rule): under production the producer check is not relaxed by it.
    let (ok, out5, err) = run(bin().args(["tick", s(&b)]).args(["--eth-fixture", s(&eth_fx), "--noid-rpc", node.url.as_str(), "--single-node-ok"]));
    assert!(ok, "{err}");
    let v5: Value = serde_json::from_str(&out5).unwrap();
    assert_eq!(v5["noid"]["producers"]["second"]["state"], "not_configured");
    assert!(
        v5["notes"].as_array().unwrap().iter().any(|n| n.as_str().unwrap().contains("producer check needs a second Parano1d node")),
        "{}",
        v5["notes"]
    );
    // The reader is not used for a fixture node.
    let (ok, out4, err) = run(bin().args(["tick", s(&b), "--noid-fixture", s(&fx.join("parano1d/idle.json")), "--eth-fixture", s(&eth_fx), "--now", "1794312000"]));
    assert!(ok, "{err}");
    assert!(serde_json::from_str::<Value>(&out4).unwrap()["noid"].get("producers").is_none());
}

#[test]
fn the_profile_numbers_are_the_owners_decisions() {
    for (profile, limit) in [(ProfileName::Production, 350), (ProfileName::Sepolia, 280), (ProfileName::Rehearsal, 280)] {
        let g = profile.gates();
        assert_eq!((g.producer_window_long, g.producer_window_short, g.producer_limit_permille, g.producer_top_two_permille), (2_880, 720, limit, 500), "{profile:?}");
        g.validate().unwrap();
    }
    // The sanity checks of `validate`.
    let p = *ProfileName::Production.gates();
    for bad in [
        swap_cli::params::Gates { producer_window_short: 0, ..p },
        swap_cli::params::Gates { producer_window_long: 100, producer_window_short: 200, ..p },
        swap_cli::params::Gates { producer_limit_permille: 0, ..p },
        swap_cli::params::Gates { producer_limit_permille: 1_000, ..p },
        swap_cli::params::Gates { producer_top_two_permille: 0, ..p },
        swap_cli::params::Gates { producer_gate_enforced: false, ..p },
    ] {
        assert!(bad.validate().is_err(), "{bad:?}");
    }
    let r = *ProfileName::Rehearsal.gates();
    assert!(swap_cli::params::Gates { producer_gate_enforced: true, ..r }.validate().is_err());
    assert!(swap_cli::params::Gates { producer_limit_permille: 999, producer_window_long: 720, ..p }.validate().is_ok());
}

// ---------------------------------------------------------------- review follow-ups

#[test]
fn production_held_back_by_the_screen_still_aborts_when_the_last_lock_height_passes() {
    // The screen only holds the lock back; it never keeps a file waiting past the point where the lock-by rule says to give up.
    let mut s = scenario(ProfileName::Production);
    let r = s.tick_bob_with(|n, _| shape(n, 1_500, 400, 2_000, 500));
    assert!(wait_reason(&r).starts_with("ALARM: producer concentration too high"), "{:?}", r.notes);
    let (d, tip) = (s.public.params.deadline_height, s.world.borrow().tip);
    s.world.borrow_mut().advance_noid(d - 100 - tip);
    let r = s.tick_bob_with(|n, _| shape(n, 1_500, 400, 2_000, 500));
    assert_eq!(r.action.kind(), "abort", "{:?} {:?}", r.action, r.notes);
    assert_eq!(s.bob.executor.count("lock_eth"), 0);
}

#[test]
fn a_budget_that_runs_out_before_the_cache_is_checked_never_reports_a_complete_window() {
    let node = FakeNode::new(10_000);
    let dir = tempfile::tempdir().unwrap();
    assert!(read_producers(&node, None, &cache_in(&dir), 10_000, &cfg()).complete);
    // The block at the tip is replaced (same height) and the node is slow: the top check uses up the budget, the repair never starts.
    node.reorg_from(10_000);
    node.delay_ms.set(300);
    let mut c = cfg();
    c.budget = Duration::from_millis(200);
    let sum = read_producers(&node, None, &cache_in(&dir), 10_000, &c);
    assert!(!sum.complete && sum.long.is_none() && sum.short.is_none(), "an unchecked cache must not be counted: {sum:?}");
    assert!(sum.error.is_none(), "running out of time is not an error: {sum:?}");
    // A budget of zero: the same, and nothing is read.
    c.budget = Duration::ZERO;
    let sum = read_producers(&node, None, &cache_in(&dir), 10_000, &c);
    assert!(!sum.complete && sum.long.is_none(), "{sum:?}");
    assert_eq!(sum.headers_read, 0);
    // With time, the next tick repairs the cache and counts the new chain, the same as a fresh read.
    node.delay_ms.set(0);
    let sum = read_producers(&node, None, &cache_in(&dir), 10_000, &cfg());
    assert!(sum.complete && sum.error.is_none(), "{sum:?}");
    assert_eq!(sum.mismatch_depth, Some(1));
    let fresh_dir = tempfile::tempdir().unwrap();
    let fresh = read_producers(&node, None, &cache_in(&fresh_dir), 10_000, &cfg());
    assert_eq!((sum.long, sum.short), (fresh.long, fresh.short));
}

#[test]
fn a_header_never_shows_its_miner_address_in_debug_output() {
    let h = Header { height: 7, hash: "ab".repeat(32), prev: "cd".repeat(32), time: 1, miner: A.to_string() };
    let shown = format!("{h:?} {:?}", vec![h.clone()]);
    no_address(&shown);
    assert!(shown.contains(&producer_id(A)), "{shown}");
}

// ---------------------------------------------------------------- production needs the second node for the producer check

#[test]
fn production_needs_a_second_node_for_the_producer_check_whatever_single_node_ok_says_and_only_the_override_waives_it() {
    // One node, F5 waived by --single-node-ok: under production the producer check still waits, with its own reason.
    let mut s = Scenario::new(Variant::Raw);
    s.world.borrow_mut().single_node = true;
    s.world.borrow_mut().single_node_ok = true;
    at_bob_lock(&mut s);
    let r = s.tick_bob();
    let want = "ALARM: producer check needs a second Parano1d node, not locking (T21): this profile enforces the producer check, only one --noid-rpc was given and --single-node-ok was passed; --single-node-ok does not relax this check. Give a second, independent Parano1d node as a second --noid-rpc (another machine or provider), or pass --accept-producer-concentration to accept the risk";
    assert_eq!(wait_reason(&r), want);
    assert!(r.notes.contains(&want.to_string()), "{:?}", r.notes);
    assert_eq!(s.bob.executor.count("lock_eth"), 0);
    assert_eq!(s.bob_phase(), "funding_final", "the file waits, it does not abort");
    no_address(&wait_reason(&r));
    // The printed concentration override waives it (and prints that it did); the F5 rule is waived by --single-node-ok as before.
    let r = s.tick_bob_with(|n, _| n.accept_producer_concentration = true);
    assert_eq!(r.action.kind(), "lock_eth", "{r:?}");
    let overridden = note_starting(&r, "WARNING: producer concentration gate OVERRIDDEN");
    assert_eq!(overridden.len(), 1, "{:?}", r.notes);
    assert!(overridden[0].contains("producer check needs a second Parano1d node"), "{}", overridden[0]);
    assert!(s.bob.file.history.iter().any(|h| h.event == format!("{OVERRIDE_HISTORY}: producer check needs a second Parano1d node")), "{:?}", s.bob.file.history);
    // The override alone does not make a missing second node's F5 rule go away: without --single-node-ok F5 still holds the lock.
    let mut s = Scenario::new(Variant::Raw);
    s.world.borrow_mut().single_node = true;
    at_bob_lock(&mut s);
    let r = s.tick_bob_with(|n, _| n.accept_producer_concentration = true);
    assert_ne!(r.action.kind(), "lock_eth", "{r:?}");
    // With a second node the check passes as before.
    let mut s = Scenario::new(Variant::Raw);
    at_bob_lock(&mut s);
    let r = s.tick_bob();
    assert_eq!(r.action.kind(), "lock_eth", "{r:?}");
    assert!(note_starting(&r, "producer concentration ok").iter().any(|n| n.contains("second node holds the same block")), "{:?}", r.notes);
}

#[test]
fn sepolia_and_rehearsal_still_lock_on_one_node_and_say_the_cross_check_is_not_possible() {
    // Sepolia: F5 needs --single-node-ok for one node; the producer screen only warns anyway and says it could not cross-check.
    let mut s = scenario(ProfileName::Sepolia);
    s.world.borrow_mut().single_node = true;
    s.world.borrow_mut().single_node_ok = true;
    let r = s.tick_bob_with(|n, _| {
        shape(n, 700, 170, 900, 220); // 24 % and 23.6 %, under the 28 % limit
        tweak(n, |p| p.second = SecondCheck::NotConfigured);
    });
    assert_eq!(r.action.kind(), "lock_eth", "{r:?}");
    assert!(note_starting(&r, "producer concentration ok").iter().any(|n| n.contains("single node, the producer cross-check is not possible")), "{:?}", r.notes);
    // Rehearsal accepts one node outright.
    let mut s = Scenario::with_profile(Variant::Raw, ProfileName::Rehearsal);
    s.world.borrow_mut().single_node = true;
    at_bob_lock(&mut s);
    let r = s.tick_bob_with(|n, _| {
        shape(n, 700, 170, 900, 220); // 24 % and 23.6 %, under the 28 % limit
        tweak(n, |p| p.second = SecondCheck::NotConfigured);
    });
    assert_eq!(r.action.kind(), "lock_eth", "{r:?}");
    assert!(note_starting(&r, "producer concentration ok").iter().any(|n| n.contains("single node, the producer cross-check is not possible")), "{:?}", r.notes);
}
