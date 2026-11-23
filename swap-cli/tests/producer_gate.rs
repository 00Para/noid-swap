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
use swap_cli::producer_marker::{MarkerKind, MarkerState};
use swap_cli::secret::{Secret, Variant};
use swap_cli::state::{BobPhase, Phase};
use swap_cli::swapfile::{example_bob_file, example_public};
use swap_cli::watch::http::HttpJsonRpc;
use swap_cli::watch::producers::{
    cache_path_for, load_cache, os_sample_heights, producer_id, read_producers, sample_heights, Header, HeightSampler, ProducerSummary,
    ReaderConfig, SecondCheck, BATCH_SIZE, SECOND_SAMPLE_COUNT,
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
    p.second = SecondCheck::Agrees { height: tip.saturating_sub(3), sampled: 64 };
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
            "second node names another producer for an equal block",
            |n| tweak(n, |p| p.second = SecondCheck::ProducerDiffers { height: 300_017 }),
            "the two Parano1d nodes disagree about the producers",
            "the two nodes name different producers for the block at height 300017 although the block hashes are equal; one of them is misreporting",
        ),
        (
            "second node holds another block below an anchor it named again",
            |n| tweak(n, |p| p.second = SecondCheck::SampledDiffers { height: 300_017 }),
            "the two Parano1d nodes disagree about the producers",
            "the two nodes hold different blocks (different hashes) at height 300017, below a block they agree on both before and after that question, which two honest nodes cannot do; one of them is misreporting",
        ),
        (
            "second node check recorded no sampled heights (an old record)",
            |n| tweak(n, |p| p.second = SecondCheck::Agrees { height: 300_017, sampled: 0 }),
            "producer concentration cannot be checked",
            "the second Parano1d node's producer cross-check recorded no sampled heights",
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
    /// Heights whose reported `miner` is another (synthetic) label, with the hash unchanged: a node that lies about producers only.
    relabel: RefCell<HashMap<u64, String>>,
    /// Heights whose reported hash is made up (the same on every ask), with the block above it naming the made-up hash as its parent: a node that
    /// gives a relabelled block a false hash as well, so that its own chain of headers still links.
    fake_hash: RefCell<std::collections::HashSet<u64>>,
    /// From the second ask of a height on, answer it differently: another hash, or an error (a node whose anchor moves between two asks).
    on_repeat: RefCell<Option<(u64, Repeat)>>,
    /// A single call for this height sleeps this many milliseconds (on top of `delay_ms`): a node that is slow for one header only.
    delay_one: Cell<Option<(u64, u64)>>,
}

#[derive(Clone, Copy)]
enum Repeat {
    OtherHash,
    Error,
    /// From the second ask on the height is answered without the `relabel` entry: a node that takes its own producer back.
    Unlabelled,
    /// From the second ask on, a third producer label.
    OtherMiner,
    /// Only the second ask has another producer label; the third and later are as usual.
    OtherMinerOnce,
    /// From the second ask on, no header at this height (a `null`).
    Null,
}

/// The made-up hash of a height: a different one from every honest hash.
fn fake_hash_of(h: u64) -> String {
    hash_of(h, 7_777)
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
            relabel: RefCell::new(HashMap::new()),
            fake_hash: RefCell::new(std::collections::HashSet::new()),
            on_repeat: RefCell::new(None),
            delay_one: Cell::new(None),
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
    /// The hash this node reports for `h`: made up when the height is in `fake_hash`.
    fn reported_hash(&self, h: u64) -> String {
        if self.fake_hash.borrow().contains(&h) {
            fake_hash_of(h)
        } else {
            self.hash(h)
        }
    }
    fn header(&self, h: u64) -> Result<Value, RpcError> {
        let asked_before = self.asked.borrow().iter().filter(|x| **x == h).count();
        self.asked.borrow_mut().push(h);
        let repeat = match *self.on_repeat.borrow() {
            Some((at, Repeat::OtherMinerOnce)) if at == h && asked_before == 1 => Some(Repeat::OtherMiner),
            Some((at, Repeat::OtherMinerOnce)) if at == h => None,
            Some((at, how)) if at == h && asked_before >= 1 => Some(how),
            _ => None,
        };
        if matches!(repeat, Some(Repeat::Error)) {
            return Err(RpcError::Transport("connection reset".into()));
        }
        if matches!(repeat, Some(Repeat::Null)) {
            return Ok(Value::Null);
        }
        if self.fail_at.get() == Some(h) {
            return Err(RpcError::Transport("connection refused".into()));
        }
        if self.null_at.get() == Some(h) || h > self.top() {
            return Ok(Value::Null);
        }
        let prev = if h == 0 { "0".repeat(64) } else { self.reported_hash(h - 1) };
        let prev = if self.bad_prev_at.get() == Some(h) { "f".repeat(64) } else { prev };
        let hash = if matches!(repeat, Some(Repeat::OtherHash)) { hash_of(h, 55) } else { self.reported_hash(h) };
        let mut v = header_value(h, hash, prev);
        if let Some(label) = self.relabel.borrow().get(&h) {
            if !matches!(repeat, Some(Repeat::Unlabelled)) {
                v["miner"] = json!(label);
            }
        }
        if matches!(repeat, Some(Repeat::OtherMiner)) {
            v["miner"] = json!("synthetic-miner-Y");
        }
        Ok(v)
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
        if let Some((h, ms)) = self.delay_one.get() {
            if params[0].as_u64() == Some(h) {
                std::thread::sleep(Duration::from_millis(ms));
            }
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
    // The anchor first, then the sample: 32 heights from each window, one batch of the distinct heights of the union (a height drawn in both
    // is asked once, so 32 to 64; none above the anchor).
    let SecondCheck::Agrees { height: 9_997, sampled } = sum.second else { panic!("{sum:?}") };
    assert!((32..=64).contains(&sampled), "{sampled}");
    assert_eq!(agree.asked.borrow()[0], 9_997);
    assert_eq!(agree.asked.borrow().len() as u64, 1 + sampled);
    // The lower tip decides the anchor.
    let sum = read_producers(&first, sec(&agree, Some(9_990)), &cache_in(&dir), 10_000, &cfg());
    assert!(matches!(sum.second, SecondCheck::Agrees { height: 9_987, sampled } if (32..=64).contains(&sampled)), "{:?}", sum.second);
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

// ---------------------------------------------------------------- the producer sample of the second node (T21-13)

/// A small deterministic generator (splitmix64) for the tests.
struct SplitMix(u64);

impl SplitMix {
    fn next(&mut self) -> u64 {
        self.0 = self.0.wrapping_add(0x9e37_79b9_7f4a_7c15);
        let mut z = self.0;
        z = (z ^ (z >> 30)).wrapping_mul(0xbf58_476d_1ce4_e5b9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94d0_49bb_1331_11eb);
        z ^ (z >> 31)
    }
}

/// A sampler over a seeded generator whose state carries from one tick to the next (so a run of ticks is fixed by the seed alone).
fn seeded_sampler(seed: u64) -> HeightSampler {
    let state = Cell::new(seed);
    Box::new(move |lo, hi, k| {
        let mut next = || {
            let mut g = SplitMix(state.get());
            let r = g.next();
            state.set(g.0);
            Ok(r)
        };
        sample_heights(lo, hi, k, &mut next)
    })
}

/// The first height of the short window (720 blocks) of a tip-10,000 read.
const SHORT_LO: u64 = 9_281;

/// A sampler that returns `long` for the long window's range and `short` for the short window's range (the reader calls it once for each; the
/// ranges are told apart by their lower end).
fn fixed_pair(short: Vec<u64>, long: Vec<u64>) -> HeightSampler {
    Box::new(move |lo, _, _| Ok(if lo == SHORT_LO { short.clone() } else { long.clone() }))
}

/// A sampler whose long-window draw is `long` and whose short-window draw is the default one ([`short_with`] of the window's first height).
fn fixed_sampler(long: Vec<u64>) -> HeightSampler {
    fixed_pair(short_with(SHORT_LO), long)
}

/// 32 distinct heights of the long window of a tip-10,000 read (7,121 to 9,997 below the anchor): `must` and 31 others (8,000 to 8,030).
fn with_height(must: u64) -> Vec<u64> {
    let mut v: Vec<u64> = (8_000..8_031).collect();
    assert!(!v.contains(&must) && (7_121..=9_997).contains(&must));
    v.push(must);
    v.sort_unstable();
    v
}

/// 32 distinct heights of the short window (9,281 to 9,997): `must` and 31 others (9,300 to 9,330).
fn short_with(must: u64) -> Vec<u64> {
    let mut v: Vec<u64> = (9_300..9_331).collect();
    assert!(!v.contains(&must) && (SHORT_LO..=9_997).contains(&must));
    v.push(must);
    v.sort_unstable();
    v
}

/// The distinct heights of two draws, ascending: what the reader asks the second node for after the anchor.
fn union(a: &[u64], b: &[u64]) -> Vec<u64> {
    let mut v: Vec<u64> = a.iter().chain(b).copied().collect();
    v.sort_unstable();
    v.dedup();
    v
}

/// Read a fresh tip-10,000 window from `first`, cross-checked against `second` with `sampler`.
fn read_with(first: &FakeNode, second: &FakeNode, sampler: HeightSampler) -> ProducerSummary {
    let dir = tempfile::tempdir().unwrap();
    let mut c = cfg();
    c.sampler = sampler;
    read_producers(first, sec(second, Some(10_000)), &cache_in(&dir), 10_000, &c)
}

#[test]
fn the_sample_is_fetched_in_one_batch_after_the_anchor_and_every_producer_equal_agrees() {
    let (first, second) = (FakeNode::new(10_000), FakeNode::new(10_000));
    let chosen = with_height(7_121);
    let sum = read_with(&first, &second, fixed_sampler(chosen.clone()));
    assert_eq!(sum.second, SecondCheck::Agrees { height: 9_997, sampled: 64 }, "{sum:?}");
    let mut want = vec![9_997];
    want.extend(union(&chosen, &short_with(SHORT_LO)));
    assert_eq!(*second.asked.borrow(), want, "the anchor first, then the union of the two draws");
    assert_eq!((second.singles.get(), second.batches.get()), (1, 1), "one call for the anchor and one batch for the sample");
    // A height drawn in both ranges is asked once and counted once.
    let second = FakeNode::new(10_000);
    let sum = read_with(&first, &second, fixed_pair(short_with(9_500), { let mut v = with_height(9_500); v.sort_unstable(); v }));
    assert_eq!(sum.second, SecondCheck::Agrees { height: 9_997, sampled: 63 }, "{sum:?}");
    assert_eq!(second.asked.borrow().len(), 1 + 63);
    assert_eq!(second.asked.borrow().iter().filter(|h| **h == 9_500).count(), 1);
    no_address(&serde_json::to_string(&sum).unwrap());
}

#[test]
fn one_sampled_height_with_another_producer_and_the_same_hash_is_producer_differs() {
    let (first, second) = (FakeNode::new(10_000), FakeNode::new(10_000));
    // Another producer at 8,010, which is among the sampled heights; and at 9,500, which is not (that one changes nothing).
    second.relabel.borrow_mut().insert(9_500, "synthetic-miner-Z".into());
    let sum = read_with(&first, &second, fixed_sampler(with_height(7_500)));
    assert_eq!(sum.second, SecondCheck::Agrees { height: 9_997, sampled: 64 }, "a height outside the sample is not looked at: {sum:?}");
    second.relabel.borrow_mut().insert(8_010, "synthetic-miner-Z".into());
    let sum = read_with(&first, &second, fixed_sampler(with_height(7_500)));
    assert_eq!(sum.second, SecondCheck::ProducerDiffers { height: 8_010 }, "{sum:?}");
    // The first node's label is the false one: the same answer.
    let (first, second) = (FakeNode::new(10_000), FakeNode::new(10_000));
    first.relabel.borrow_mut().insert(7_500, "synthetic-miner-Z".into());
    let sum = read_with(&first, &second, fixed_sampler(with_height(7_500)));
    assert_eq!(sum.second, SecondCheck::ProducerDiffers { height: 7_500 }, "{sum:?}");
    // The summary holds the height and no address.
    let json = serde_json::to_string(&sum).unwrap();
    no_address(&json);
    assert!(json.contains(r#""state":"producer_differs""#) && json.contains(r#""height":7500"#), "{json}");
    assert!(!json.contains("synthetic"), "{json}");
    // At the anchor itself the producer is compared too, and the sample is not even fetched: the second node is asked for the anchor, and once more
    // to confirm the producer difference.
    let (first, second) = (FakeNode::new(10_000), FakeNode::new(10_000));
    second.relabel.borrow_mut().insert(9_997, "synthetic-miner-Z".into());
    let sum = read_with(&first, &second, fixed_sampler(with_height(7_500)));
    assert_eq!(sum.second, SecondCheck::ProducerDiffers { height: 9_997 }, "{sum:?}");
    assert_eq!(*second.asked.borrow(), vec![9_997, 9_997]);
}

/// The reading of a producer difference at 8,010 (a sampled height) with the second node scripted by `script`, for the confirmation tests below.
fn confirm_read(script: impl FnOnce(&FakeNode)) -> (SecondCheck, FakeNode, FakeNode) {
    let (first, second) = (FakeNode::new(10_000), FakeNode::new(10_000));
    second.relabel.borrow_mut().insert(8_010, "synthetic-miner-Z".into());
    script(&second);
    let sum = read_with(&first, &second, fixed_sampler(with_height(7_500)));
    (sum.second, first, second)
}

#[test]
fn a_producer_difference_is_asked_for_once_more_from_the_second_node_only_and_for_that_height_only_before_it_stands() {
    let chosen = with_height(7_500);
    let (check, first, second) = confirm_read(|_| {});
    assert_eq!(check, SecondCheck::ProducerDiffers { height: 8_010 });
    // The anchor, the union of the two draws in one batch, then exactly one more request: 8,010 again, as a single call.
    let mut want = vec![9_997];
    want.extend(union(&chosen, &short_with(SHORT_LO)));
    want.push(8_010);
    assert_eq!(*second.asked.borrow(), want);
    assert_eq!((second.singles.get(), second.batches.get()), (2, 1), "the anchor and the confirmation singly, the sample in one batch");
    // The first node is not asked again: its calls are the same as in a reading where the nodes agree.
    let (agreeing_first, agreeing_second) = (FakeNode::new(10_000), FakeNode::new(10_000));
    let sum = read_with(&agreeing_first, &agreeing_second, fixed_sampler(with_height(7_500)));
    assert!(matches!(sum.second, SecondCheck::Agrees { .. }), "{sum:?}");
    assert_eq!(*first.asked.borrow(), *agreeing_first.asked.borrow(), "the first node answers the same calls, none more");
    assert_eq!((first.singles.get(), first.batches.get()), (agreeing_first.singles.get(), agreeing_first.batches.get()));
    assert_eq!(agreeing_second.asked.borrow().len() + 1, want.len(), "exactly one request more than an agreeing reading");
    // A hash difference with no producer difference asks nothing more of 8,010 (the anchor's second ask is the other kind of follow-up).
    let (first, second) = (FakeNode::new(10_000), FakeNode::new(10_000));
    second.tags.borrow_mut()[8_010] = 1;
    read_with(&first, &second, fixed_sampler(chosen));
    assert_eq!(second.asked.borrow().iter().filter(|h| **h == 8_010).count(), 1);
}

#[test]
fn a_second_node_that_takes_its_producer_back_is_not_remembered_and_the_tick_is_unreadable() {
    // The second node named another producer at first and, asked again, names the first node's: two answers for one block, not a detection.
    let (check, ..) = confirm_read(|n| *n.on_repeat.borrow_mut() = Some((8_010, Repeat::Unlabelled)));
    assert!(
        matches!(&check, SecondCheck::Unreadable { reason } if reason.contains("two different answers for the producer of the block at height 8010")),
        "{check:?}"
    );
    assert_eq!(swap_cli::producer_marker::remembered(&check), None);
    no_address(&serde_json::to_string(&check).unwrap());
    // At the anchor itself: the first ask differs, the confirmation does not.
    let (first, second) = (FakeNode::new(10_000), FakeNode::new(10_000));
    second.relabel.borrow_mut().insert(9_997, "synthetic-miner-Z".into());
    *second.on_repeat.borrow_mut() = Some((9_997, Repeat::Unlabelled));
    let sum = read_with(&first, &second, fixed_sampler(with_height(7_500)));
    assert!(matches!(&sum.second, SecondCheck::Unreadable { reason } if reason.contains("height 9997")), "{sum:?}");
    assert_eq!(*second.asked.borrow(), vec![9_997, 9_997], "no sample is fetched after an unconfirmed anchor difference");
    // Through the anchor's second ask after a hash difference in the sample: that ask shows another producer, the confirmation does not.
    let (first, second) = (FakeNode::new(10_000), FakeNode::new(10_000));
    second.tags.borrow_mut()[8_010] = 1;
    *second.on_repeat.borrow_mut() = Some((9_997, Repeat::OtherMinerOnce));
    let sum = read_with(&first, &second, fixed_sampler(with_height(7_500)));
    assert!(matches!(&sum.second, SecondCheck::Unreadable { reason } if reason.contains("two different answers")), "{sum:?}");
    assert_eq!(second.asked.borrow().iter().filter(|h| **h == 9_997).count(), 3, "the anchor, its second ask, the confirmation");
    // ... and when the second ask AND the confirmation both show another producer, it stands.
    let (first, second) = (FakeNode::new(10_000), FakeNode::new(10_000));
    second.tags.borrow_mut()[8_010] = 1;
    *second.on_repeat.borrow_mut() = Some((9_997, Repeat::OtherMiner));
    let sum = read_with(&first, &second, fixed_sampler(with_height(7_500)));
    assert_eq!(sum.second, SecondCheck::ProducerDiffers { height: 9_997 }, "{sum:?}");
}

#[test]
fn a_confirmation_that_fails_answers_another_hash_or_has_no_header_is_unreadable_and_never_remembered() {
    for (name, how, word) in [
        ("an error", Repeat::Error, "could not be confirmed"),
        ("another hash", Repeat::OtherHash, "a different block for height 8010"),
        ("no header", Repeat::Null, "could not be confirmed"),
    ] {
        let (check, ..) = confirm_read(|n| *n.on_repeat.borrow_mut() = Some((8_010, how)));
        assert!(matches!(&check, SecondCheck::Unreadable { reason } if reason.contains(word)), "{name}: {check:?}");
        assert_eq!(swap_cli::producer_marker::remembered(&check), None, "{name}");
    }
    // A third producer on the confirmation is still another producer than the first node's: it stands.
    let (check, ..) = confirm_read(|n| *n.on_repeat.borrow_mut() = Some((8_010, Repeat::OtherMiner)));
    assert_eq!(check, SecondCheck::ProducerDiffers { height: 8_010 });
}

#[test]
fn a_failed_producer_confirmation_does_not_throw_away_a_hash_difference_seen_in_the_same_sample() {
    use swap_cli::producer_marker::remembered;
    for (name, how) in [("an error", Repeat::Error), ("no header", Repeat::Null)] {
        // Both kinds in one sample: another producer (same hash) at 8,010 and another hash at 7,500, below the anchor; both are sampled heights.
        // The confirmation of 8,010 fails, so the hash difference goes through its own anchor re-ask and is remembered.
        let (first, second) = (FakeNode::new(10_000), FakeNode::new(10_000));
        second.relabel.borrow_mut().insert(8_010, "synthetic-miner-Z".into());
        second.tags.borrow_mut()[7_500] = 1;
        *second.on_repeat.borrow_mut() = Some((8_010, how));
        let sum = read_with(&first, &second, fixed_sampler(with_height(7_500)));
        assert_eq!(sum.second, SecondCheck::SampledDiffers { height: 7_500 }, "{name}: {sum:?}");
        assert_eq!(remembered(&sum.second), Some((7_500, MarkerKind::Hash)), "{name}");
        let asked = second.asked.borrow().clone();
        assert_eq!(asked.iter().filter(|h| **h == 8_010).count(), 2, "{name}: asked in the sample and once more to confirm: {asked:?}");
        assert_eq!((asked[0], *asked.last().unwrap()), (9_997, 9_997), "{name}: the anchor is asked again after the sample: {asked:?}");
        assert_eq!(asked.iter().filter(|h| **h == 9_997).count(), 2, "{name}");
        no_address(&serde_json::to_string(&sum).unwrap());

        // Only a producer difference in the sample and its confirmation fails: still unreadable, nothing remembered.
        let (check, ..) = confirm_read(|n| *n.on_repeat.borrow_mut() = Some((8_010, how)));
        assert!(matches!(&check, SecondCheck::Unreadable { .. }), "{name}: {check:?}");
        assert_eq!(remembered(&check), None, "{name}");
    }
}

#[test]
fn the_confirmation_has_its_own_time_when_the_shared_deadline_is_already_spent() {
    // As the anchor's second ask: the first node relabels one block (a producer lie, true hash); its slow cache-top header spends the reading's
    // shared budget (2 s) right after the sample batch returns (cache-top header 1,200 ms; anchor ask, second node 500 ms, ends at 1,700; sample
    // batch 500 ms ends at 2,200). The confirmation starts there, past the shared deadline, and still gets its own time.
    let first = FakeNode::new(10_000);
    first.relabel.borrow_mut().insert(8_010, "synthetic-miner-Z".into());
    let second = FakeNode::new(10_000);
    let dir = tempfile::tempdir().unwrap();
    assert!(read_producers(&first, None, &cache_in(&dir), 10_000, &cfg()).complete, "a warm cache that holds the relabelled block");
    first.delay_one.set(Some((10_000, 1_200)));
    second.delay_ms.set(500);
    let mut c = cfg();
    c.budget = Duration::from_millis(2_000);
    c.sampler = fixed_sampler(with_height(7_500));
    let sum = read_producers(&first, sec(&second, Some(10_000)), &cache_in(&dir), 10_000, &c);
    assert!(sum.complete, "{sum:?}");
    assert_eq!(sum.second, SecondCheck::ProducerDiffers { height: 8_010 }, "{sum:?}");
    assert_eq!(second.asked.borrow().iter().filter(|h| **h == 8_010).count(), 2, "asked in the sample and once more to confirm");
}

#[test]
fn one_sampled_height_with_another_hash_below_the_anchor_is_remembered_when_the_anchor_is_named_again_and_a_producer_difference_in_the_same_sample_wins() {
    let (first, second) = (FakeNode::new(10_000), FakeNode::new(10_000));
    second.tags.borrow_mut()[8_010] = 1; // another block at one height only (the anchor is untouched); 8,010 is among the sampled heights
    let chosen = with_height(7_500);
    assert!(chosen.contains(&8_010));
    let sum = read_with(&first, &second, fixed_sampler(chosen.clone()));
    assert_eq!(sum.second, SecondCheck::SampledDiffers { height: 8_010 }, "{sum:?}");
    // The anchor was asked before the sample and once more after it: the last ask is the anchor.
    let asked = second.asked.borrow().clone();
    assert_eq!((asked[0], *asked.last().unwrap()), (9_997, 9_997), "{asked:?}");
    assert_eq!(asked.iter().filter(|h| **h == 9_997).count(), 2);
    no_address(&serde_json::to_string(&sum).unwrap());
    // A short-window height behaves the same.
    let (first, second) = (FakeNode::new(10_000), FakeNode::new(10_000));
    second.tags.borrow_mut()[9_500] = 1;
    let sum = read_with(&first, &second, fixed_pair(short_with(9_500), with_height(7_500)));
    assert_eq!(sum.second, SecondCheck::SampledDiffers { height: 9_500 }, "{sum:?}");
    // With no difference the anchor is asked once only.
    let (first, second) = (FakeNode::new(10_000), FakeNode::new(10_000));
    read_with(&first, &second, fixed_sampler(chosen.clone()));
    assert_eq!(second.asked.borrow().iter().filter(|h| **h == 9_997).count(), 1);
    // A producer difference at a lower height in the same sample: the outcome is the remembered producer kind, not an ordinary result.
    let (first, second) = (FakeNode::new(10_000), FakeNode::new(10_000));
    second.tags.borrow_mut()[8_010] = 1;
    second.relabel.borrow_mut().insert(7_500, "synthetic-miner-Z".into());
    let sum = read_with(&first, &second, fixed_sampler(chosen));
    assert_eq!(sum.second, SecondCheck::ProducerDiffers { height: 7_500 }, "{sum:?}");
    assert_eq!(swap_cli::producer_marker::remembered(&sum.second), Some((7_500, MarkerKind::Producer)));
}

#[test]
fn a_hash_difference_at_the_anchor_or_with_an_anchor_that_moves_or_cannot_be_asked_again_is_never_remembered() {
    use swap_cli::producer_marker::remembered;
    let first = FakeNode::new(10_000);
    // A different block at the anchor itself (an honest reorg near the tip can look like this): the sample is not even drawn.
    let second = FakeNode::new(10_000);
    second.reorg_from(9_997);
    let sum = read_with(&first, &second, fixed_sampler(with_height(7_500)));
    assert!(matches!(&sum.second, SecondCheck::Differs { height: 9_997, .. }), "{sum:?}");
    assert_eq!(remembered(&sum.second), None);
    assert_eq!(*second.asked.borrow(), vec![9_997]);
    // A different hash below the anchor, but the second node's anchor changed between the two asks (a reorg while the sample was asked): ordinary.
    let second = FakeNode::new(10_000);
    second.tags.borrow_mut()[8_010] = 1;
    *second.on_repeat.borrow_mut() = Some((9_997, Repeat::OtherHash));
    let sum = read_with(&first, &second, fixed_sampler(with_height(7_500)));
    assert!(matches!(&sum.second, SecondCheck::Differs { height: 9_997, .. }), "{sum:?}");
    assert_eq!(remembered(&sum.second), None);
    // The same when the anchor is among the sampled heights: its answer in the sample is the second ask.
    let second = FakeNode::new(10_000);
    *second.on_repeat.borrow_mut() = Some((9_997, Repeat::OtherHash));
    let sum = read_with(&first, &second, fixed_sampler(with_height(9_997)));
    assert!(matches!(&sum.second, SecondCheck::Differs { height: 9_997, .. }), "{sum:?}");
    assert_eq!(remembered(&sum.second), None);
    // A second node that cannot answer the second ask of the anchor: unreadable, and a difference seen in the sample is not remembered either.
    let second = FakeNode::new(10_000);
    second.tags.borrow_mut()[8_010] = 1;
    *second.on_repeat.borrow_mut() = Some((9_997, Repeat::Error));
    let sum = read_with(&first, &second, fixed_sampler(with_height(7_500)));
    assert!(matches!(&sum.second, SecondCheck::Unreadable { reason } if reason.contains("height 9997")), "{sum:?}");
    assert_eq!(remembered(&sum.second), None);
    // A missing sampled height: unreadable, not remembered.
    let second = FakeNode::new(10_000);
    second.null_at.set(Some(8_010));
    let sum = read_with(&first, &second, fixed_sampler(with_height(7_500)));
    assert!(matches!(&sum.second, SecondCheck::Unreadable { .. }), "{sum:?}");
    assert_eq!(remembered(&sum.second), None);
}

#[test]
fn a_first_node_that_uses_up_the_shared_budget_right_after_the_sample_cannot_make_a_hit_unreadable() {
    // The first node relabels one block and gives it a made-up hash; the sample hits it. The first node's cache-top header is slow, so that the
    // reading's shared budget (2 s) is spent just after the sample batch returns: the anchor ask and the sample batch fit, a second ask against
    // the SHARED deadline would not. The second ask has its own time, so the result is still the remembered `SampledDiffers`. (On the shared
    // deadline this test gets `Unreadable`.) Timeline in ms: the cache-top header returns at 1,200; the anchor ask (second node, 500) ends at
    // 1,700, with 300 ms to spare against the budget; the sample batch (500) ends at 2,200, past the budget; the second ask starts there.
    let first = FakeNode::new(10_000);
    first.relabel.borrow_mut().insert(8_010, "synthetic-miner-Z".into());
    first.fake_hash.borrow_mut().insert(8_010);
    let second = FakeNode::new(10_000);
    let dir = tempfile::tempdir().unwrap();
    assert!(read_producers(&first, None, &cache_in(&dir), 10_000, &cfg()).complete, "a warm cache that holds the made-up block");
    first.delay_one.set(Some((10_000, 1_200)));
    second.delay_ms.set(500);
    let mut c = cfg();
    c.budget = Duration::from_millis(2_000);
    c.sampler = fixed_sampler(with_height(7_500));
    let sum = read_producers(&first, sec(&second, Some(10_000)), &cache_in(&dir), 10_000, &c);
    assert!(sum.complete, "{sum:?}");
    assert_eq!(sum.second, SecondCheck::SampledDiffers { height: 8_010 }, "{sum:?}");
    assert_eq!(second.asked.borrow().iter().filter(|h| **h == 9_997).count(), 2, "the anchor was asked again after the sample");
    // A SECOND node that cannot answer the second ask is still unreadable and nothing is remembered (the error knob; the ask has its own time,
    // so slowness alone, which cannot pass a ten-second per-call timeout in a test, is not what makes it unreadable).
    let second = FakeNode::new(10_000);
    *second.on_repeat.borrow_mut() = Some((9_997, Repeat::Error));
    let sum = read_with(&first, &second, fixed_sampler(with_height(7_500)));
    assert!(matches!(sum.second, SecondCheck::Unreadable { .. }), "{sum:?}");
    assert_eq!(swap_cli::producer_marker::remembered(&sum.second), None);
}

#[test]
fn a_second_node_that_omits_a_sampled_height_errors_or_is_too_slow_is_unreadable() {
    let first = FakeNode::new(10_000);
    // An answer without the header at one sampled height.
    let second = FakeNode::new(10_000);
    second.null_at.set(Some(9_500));
    let sum = read_with(&first, &second, fixed_sampler(with_height(7_500)));
    assert_eq!(sum.second, SecondCheck::Agrees { height: 9_997, sampled: 64 }, "a null at a height that was not sampled changes nothing: {sum:?}");
    second.null_at.set(Some(7_500));
    let sum = read_with(&first, &second, fixed_sampler(with_height(7_500)));
    assert!(matches!(&sum.second, SecondCheck::Unreadable { reason } if reason.contains("height 7500") && reason.contains("no header")), "{:?}", sum.second);
    // A call that fails at one sampled height.
    let second = FakeNode::new(10_000);
    second.fail_at.set(Some(7_500));
    let sum = read_with(&first, &second, fixed_sampler(with_height(7_500)));
    assert!(matches!(&sum.second, SecondCheck::Unreadable { reason } if reason.contains("height 7500 failed")), "{:?}", sum.second);
    // A second node that refuses batches, or answers one short, is asked singly and still agrees.
    for mode in [1u8, 2] {
        let second = FakeNode::new(10_000);
        second.batch.set(mode);
        let sum = read_with(&first, &second, fixed_sampler(with_height(7_500)));
        assert_eq!(sum.second, SecondCheck::Agrees { height: 9_997, sampled: 64 }, "mode {mode}: {sum:?}");
        assert_eq!(second.singles.get(), 1 + 64, "mode {mode}: the anchor and every sampled height singly (the two draws share none)");
    }
    // A second node that runs out of the reading's budget after the anchor: the cache is warm, so the first node costs one header.
    let second = FakeNode::new(10_000);
    let dir = tempfile::tempdir().unwrap();
    assert!(read_producers(&first, None, &cache_in(&dir), 10_000, &cfg()).complete);
    // The budget is 1 s, so the first node (which gets 750 ms of it, the rest is the reserve) has ample time for one cached header even on a
    // slow machine; the second node answers its single anchor call only after 1.2 s, past the whole budget.
    second.delay_ms.set(1_200);
    let mut c = cfg();
    c.budget = Duration::from_millis(1_000);
    c.sampler = fixed_sampler(with_height(7_500));
    let sum = read_producers(&first, sec(&second, Some(10_000)), &cache_in(&dir), 10_000, &c);
    assert!(sum.complete, "the first node's part is done: {sum:?}");
    assert!(matches!(&sum.second, SecondCheck::Unreadable { reason } if reason.contains("did not answer in time")), "{:?}", sum.second);
    assert_eq!(*second.asked.borrow(), vec![9_997], "the sample was not asked for once the time was gone");
}

#[test]
fn a_sampler_that_fails_or_returns_an_unusable_choice_makes_the_check_unreadable() {
    let (first, second) = (FakeNode::new(10_000), FakeNode::new(10_000));
    let bad: Vec<(&str, HeightSampler)> = vec![
        ("an error", Box::new(|_, _, _| Err("no entropy".to_string()))),
        ("a height above the anchor", fixed_sampler({
            let mut v = with_height(7_500);
            v[31] = 9_998;
            v
        })),
        ("a height below the window", fixed_sampler({
            let mut v = with_height(7_500);
            v[0] = 7_120;
            v
        })),
        ("a repeated height", fixed_sampler({
            let mut v = with_height(7_500);
            v[1] = v[0];
            v
        })),
        ("too few heights", fixed_sampler(with_height(7_500)[..31].to_vec())),
        ("no heights", fixed_sampler(Vec::new())),
        ("a short-window height below the short window", fixed_pair({ let mut v = short_with(SHORT_LO); v[0] = SHORT_LO - 1; v }, with_height(7_500))),
        ("a short-window height above the anchor", fixed_pair({ let mut v = short_with(SHORT_LO); v[31] = 9_998; v }, with_height(7_500))),
        ("too few short-window heights", fixed_pair(short_with(SHORT_LO)[..31].to_vec(), with_height(7_500))),
    ];
    let count = bad.len();
    for (name, sampler) in bad {
        let sum = read_with(&first, &second, sampler);
        assert!(matches!(&sum.second, SecondCheck::Unreadable { .. }), "{name}: {:?}", sum.second);
    }
    assert_eq!(*second.asked.borrow(), vec![9_997; count], "only the anchor was ever asked for");
}

#[test]
fn no_sampled_height_is_above_the_anchor_or_below_the_window_and_a_short_window_samples_every_height_once() {
    // The reader, with the real sampler, over many ticks.
    let (first, second) = (FakeNode::new(10_000), FakeNode::new(10_000));
    for _ in 0..50 {
        second.asked.borrow_mut().clear();
        let sum = read_with(&first, &second, Box::new(os_sample_heights));
        let asked = second.asked.borrow();
        assert_eq!(asked[0], 9_997);
        let mut sample = asked[1..].to_vec();
        assert!(matches!(sum.second, SecondCheck::Agrees { height: 9_997, sampled } if sampled == sample.len() as u64), "{sum:?}");
        assert!(sample.iter().all(|h| (10_000 + 1 - 2_880..=9_997).contains(h)), "{sample:?}");
        sample.sort_unstable();
        sample.dedup();
        assert_eq!(sample.len(), asked.len() - 1, "distinct: a height drawn in both ranges is asked once");
        // 32 heights from each window: at least 32 in all, at most 64, and at least 32 of them in the short window.
        assert!((SECOND_SAMPLE_COUNT..=2 * SECOND_SAMPLE_COUNT).contains(&sample.len()), "{}", sample.len());
        assert!(sample.iter().filter(|h| **h >= SHORT_LO).count() >= SECOND_SAMPLE_COUNT, "the short window is drawn from too");
    }
    // A window of 20 blocks ends at 5,000: heights 4,981 to 4,997 lie at or below the anchor, 17 of them, fewer than 32: each once.
    let (first, second) = (FakeNode::new(5_000), FakeNode::new(5_000));
    let dir = tempfile::tempdir().unwrap();
    let mut c = ReaderConfig::new(20, 10);
    c.clock = || 1_700_000_000;
    let sum = read_producers(&first, sec(&second, Some(5_000)), &cache_in(&dir), 5_000, &c);
    assert_eq!(sum.second, SecondCheck::Agrees { height: 4_997, sampled: 17 }, "{sum:?}");
    let mut want = vec![4_997];
    want.extend(4_981..=4_997u64);
    assert_eq!(*second.asked.borrow(), want);
    // The function itself, over many ranges and sizes.
    let mut g = SplitMix(1);
    for (lo, hi) in [(0u64, 0u64), (5, 5), (5, 6), (10, 40), (10, 41), (10, 42), (10, 43), (100, 163), (0, 2_879), (7_121, 9_997), (u64::MAX - 100, u64::MAX)] {
        for k in [0usize, 1, 2, 31, 32, 33, 64] {
            let got = sample_heights(lo, hi, k, &mut || Ok(g.next())).unwrap();
            let n = hi - lo + 1;
            assert_eq!(got.len() as u64, n.min(k as u64), "{lo}..={hi} k {k}");
            assert!(got.windows(2).all(|w| w[0] < w[1]), "ascending and distinct: {got:?}");
            assert!(got.iter().all(|h| (lo..=hi).contains(h)), "{lo}..={hi}: {got:?}");
        }
    }
    assert!(sample_heights(9, 8, 32, &mut || Ok(1)).unwrap().is_empty(), "an empty range");
    assert_eq!(sample_heights(10, 20, 100, &mut || Ok(1)).unwrap(), (10..=20).collect::<Vec<_>>(), "a short range: every height once");
}

#[test]
fn the_sampler_is_unbiased_ends_on_a_stuck_generator_and_passes_an_error_on() {
    // One of three: each is chosen about a third of the time (the standard deviation of a count is about 82; the bound is 12 of them).
    let mut g = SplitMix(42);
    let mut counts = [0u32; 3];
    for _ in 0..30_000 {
        counts[sample_heights(0, 2, 1, &mut || Ok(g.next())).unwrap()[0] as usize] += 1;
    }
    assert!(counts.iter().all(|c| (9_000..=11_000).contains(c)), "{counts:?}");
    // Two of four: each of the six pairs is equally likely.
    let mut pairs: HashMap<Vec<u64>, u32> = HashMap::new();
    for _ in 0..60_000 {
        *pairs.entry(sample_heights(0, 3, 2, &mut || Ok(g.next())).unwrap()).or_default() += 1;
    }
    assert_eq!(pairs.len(), 6);
    assert!(pairs.values().all(|c| (9_400..=10_600).contains(c)), "{pairs:?}");
    // A source that always returns the largest number (every draw would be thrown away) cannot hold a tick forever.
    let got = sample_heights(0, 9_999, 32, &mut || Ok(u64::MAX)).unwrap();
    assert_eq!(got.len(), 32);
    // A failing source is an error, not a short sample.
    assert!(sample_heights(0, 9_999, 32, &mut || Err("down".to_string())).is_err());
    assert!(os_sample_heights(0, 9_999, 32).is_ok());
}

#[test]
fn a_fixed_sampler_gives_fixed_heights_and_the_real_sampler_gives_a_different_sample_on_each_tick() {
    let first = FakeNode::new(10_000);
    let asked_with = |sampler: HeightSampler| {
        let second = FakeNode::new(10_000);
        read_with(&first, &second, sampler);
        let v = second.asked.borrow()[1..].to_vec();
        v
    };
    // The same seed, the same heights (and a different seed, other heights).
    assert_eq!(asked_with(seeded_sampler(7)), asked_with(seeded_sampler(7)));
    assert_ne!(asked_with(seeded_sampler(7)), asked_with(seeded_sampler(8)));
    assert_eq!(asked_with(fixed_sampler(with_height(7_500))), union(&with_height(7_500), &short_with(SHORT_LO)));
    // The real sampler: two ticks. A collision of two samples of 32 from 2,877 heights has a chance of about one in 10^70 for a working generator,
    // so this cannot fail by chance; it fails only if the sample is not drawn afresh.
    let (a, b) = (asked_with(Box::new(os_sample_heights)), asked_with(Box::new(os_sample_heights)));
    assert_ne!(a, b);
    assert!(a.len() >= 32 && b.len() >= 32);
}

#[test]
fn a_first_node_that_relabels_17_percent_of_the_window_is_caught_in_at_least_99_of_100_ticks() {
    // The first node reports the true hashes beside another producer for 17 % of the window: heights from 7,121 whose distance from it, modulo
    // 100, is below 17 (493 of the 2,880 heights, 17.1 %). The second node is honest. The sampler is seeded: the seed below is fixed, so the
    // result is the same on every run. A tick misses when none of its heights is relabelled (and neither is the anchor); each draw of 32 misses with chance about
    // 0.83^32, 0.26 %, and a tick has two draws that both fall in this window, so 100 ticks miss well under 0.26 times on average; two or more would fail this test (with one draw per tick that would happen for about 3 arbitrary seeds in 100)
    // so the seed is fixed. The next test checks the rate over 2,000 ticks, with a bound that holds for any seed.
    let first = FakeNode::new(10_000);
    let second = FakeNode::new(10_000);
    for h in 7_121..=10_000u64 {
        if (h - 7_121) % 100 < 17 {
            first.relabel.borrow_mut().insert(h, "synthetic-miner-Z".into());
        }
    }
    let dir = tempfile::tempdir().unwrap();
    let mut c = cfg();
    c.sampler = seeded_sampler(0x2026_1109);
    let mut caught = 0;
    for tick in 0..100 {
        let sum = read_producers(&first, sec(&second, Some(10_000)), &cache_in(&dir), 10_000, &c);
        assert!(sum.complete, "tick {tick}: {sum:?}");
        match sum.second {
            SecondCheck::ProducerDiffers { .. } => caught += 1,
            SecondCheck::Agrees { .. } => {}
            other => panic!("tick {tick}: {other:?}"),
        }
    }
    assert!(caught >= 99, "caught in {caught} of 100 ticks");
}

#[test]
fn the_miss_rate_for_a_17_percent_relabel_is_about_a_quarter_of_one_percent() {
    // No reader here, only the sampler against the set of relabelled heights: 2,000 ticks from a fixed seed. The expected misses are
    // 2,000 * 0.83^32, about 5; a bound of 20 is more than six standard deviations away, so this does not fail by chance for any seed.
    let relabelled = |h: u64| (h - 7_121) % 100 < 17;
    let mut g = SplitMix(0x5eed);
    let mut misses = 0;
    for _ in 0..2_000 {
        let heights = sample_heights(7_121, 9_997, SECOND_SAMPLE_COUNT, &mut || Ok(g.next())).unwrap();
        if !heights.iter().any(|h| relabelled(*h)) {
            misses += 1;
        }
    }
    assert!(misses <= 20, "{misses} misses in 2,000 ticks");
}

/// 122 distinct heights spread evenly over the short window's range up to the anchor (9,281 to 9,997): with 720 blocks in the window, relabelling
/// 122 of a 52 % producer's 374 blocks leaves it exactly at the 35 % limit (252 of 720).
fn spread_122() -> Vec<u64> {
    (0..122u64).map(|i| 9_281 + i * 717 / 122).collect()
}

#[test]
fn a_first_node_that_relabels_only_the_short_window_just_enough_is_caught_in_at_least_99_of_100_ticks() {
    // The first node reports the true hashes beside another producer for 122 blocks of the last 720 (a 52 % producer brought down to the
    // 35 % limit there) and tells the truth about the rest of the long window. Without a draw from the short window this is about 4 % of
    // the range of the long draw and one tick would miss it about 26 % of the time (the next test); with the stratified draw the miss chance
    // per tick is about 0.7 per thousand. The sampler is seeded and fixed, so the result is the same on every run.
    let relabelled = spread_122();
    assert_eq!(relabelled.iter().collect::<std::collections::HashSet<_>>().len(), 122);
    assert!(relabelled.iter().all(|h| (SHORT_LO..=9_997).contains(h)));
    let first = FakeNode::new(10_000);
    let second = FakeNode::new(10_000);
    for h in &relabelled {
        first.relabel.borrow_mut().insert(*h, "synthetic-miner-Z".into());
    }
    let dir = tempfile::tempdir().unwrap();
    let mut c = cfg();
    c.sampler = seeded_sampler(0x2026_1110);
    let mut caught = 0;
    for tick in 0..100 {
        let sum = read_producers(&first, sec(&second, Some(10_000)), &cache_in(&dir), 10_000, &c);
        assert!(sum.complete, "tick {tick}: {sum:?}");
        match sum.second {
            SecondCheck::ProducerDiffers { .. } => caught += 1,
            SecondCheck::Agrees { .. } => {}
            other => panic!("tick {tick}: {other:?}"),
        }
    }
    assert!(caught >= 99, "caught in {caught} of 100 ticks");
}

#[test]
fn the_miss_rate_for_a_short_window_relabel_is_bounded_and_a_long_window_draw_alone_would_miss_about_a_quarter_of_the_time() {
    // No reader here, only the sampler against the 122 relabelled heights. 2,000 ticks from a fixed seed.
    let relabelled: std::collections::HashSet<u64> = spread_122().into_iter().collect();
    let mut g = SplitMix(0x5eed_5);
    let (mut long_only, mut both) = (0u32, 0u32);
    for _ in 0..2_000 {
        let short = sample_heights(SHORT_LO, 9_997, SECOND_SAMPLE_COUNT, &mut || Ok(g.next())).unwrap();
        let long = sample_heights(7_121, 9_997, SECOND_SAMPLE_COUNT, &mut || Ok(g.next())).unwrap();
        let hit_long = long.iter().any(|h| relabelled.contains(h));
        let hit_short = short.iter().any(|h| relabelled.contains(h));
        if !hit_long {
            long_only += 1;
        }
        if !hit_long && !hit_short {
            both += 1;
        }
    }
    // A draw from the long window alone misses with chance (1 - 122/2877)^32, about 25.6 %: the reason the short window is drawn too. The
    // bounds are about 6.8 standard deviations from the expected count on each side (at the nearer end), so this does not fail by chance for any seed.
    assert!((380..=650).contains(&long_only), "{long_only} misses of 2,000 with the long draw alone");
    // The stratified draw misses with chance about 0.07 %, so about 1.4 of 2,000; an UPPER bound of 15 (not a measured rate).
    assert!(both <= 15, "{both} misses of 2,000 with both draws");
}

/// 100 ticks of the reader against an honest second node, each with a fresh draw from a seeded sampler; how many ended in a remembered kind
/// (`ProducerDiffers` or `SampledDiffers`). Any other outcome than `Agrees` (a miss) or a remembered kind fails the test.
fn remembered_in_100_ticks(first: &FakeNode, seed: u64) -> u32 {
    let second = FakeNode::new(10_000);
    let dir = tempfile::tempdir().unwrap();
    let mut c = cfg();
    c.sampler = seeded_sampler(seed);
    let mut caught = 0;
    for tick in 0..100 {
        let sum = read_producers(first, sec(&second, Some(10_000)), &cache_in(&dir), 10_000, &c);
        assert!(sum.complete, "tick {tick}: {sum:?}");
        match sum.second {
            SecondCheck::ProducerDiffers { .. } | SecondCheck::SampledDiffers { .. } => caught += 1,
            SecondCheck::Agrees { .. } => {}
            other => panic!("tick {tick}: {other:?}"),
        }
    }
    caught
}

#[test]
fn a_first_node_that_relabels_and_gives_made_up_hashes_is_remembered_in_at_least_99_of_100_ticks_in_either_window() {
    // The same lies as in the two falsification tests above, and in addition every relabelled block gets a made-up hash, with the block above it
    // naming that hash as its parent, so the first node's own chain of headers links. The anchor and the blocks above it stay true. The seeds are
    // the same as above, so the ticks draw the same heights and the same ticks miss (the miss chance per tick is the same). A hash difference
    // below the anchor is remembered when the second node names the anchor again after the sample.
    // Long window: 17 % of the 2,880 heights.
    let first = FakeNode::new(10_000);
    for h in 7_121..=10_000u64 {
        if (h - 7_121) % 100 < 17 {
            first.relabel.borrow_mut().insert(h, "synthetic-miner-Z".into());
            first.fake_hash.borrow_mut().insert(h);
        }
    }
    assert!(!first.fake_hash.borrow().contains(&9_997), "the anchor stays true");
    let caught = remembered_in_100_ticks(&first, 0x2026_1109);
    assert!(caught >= 99, "long window: remembered in {caught} of 100 ticks");
    // Short window only: 122 of the last 720 blocks.
    let first = FakeNode::new(10_000);
    for h in spread_122() {
        first.relabel.borrow_mut().insert(h, "synthetic-miner-Z".into());
        first.fake_hash.borrow_mut().insert(h);
    }
    let caught = remembered_in_100_ticks(&first, 0x2026_1110);
    assert!(caught >= 99, "short window: remembered in {caught} of 100 ticks");
}

#[test]
fn an_older_record_of_the_second_check_without_a_sample_still_loads() {
    let old: SecondCheck = serde_json::from_str(r#"{"state":"agrees","height":9997}"#).unwrap();
    assert_eq!(old, SecondCheck::Agrees { height: 9_997, sampled: 0 });
    // Inside a whole summary, as an older JSON output parsed again would hold it (the summary is built afresh on every tick and is not stored).
    let mut sum = ProducerSummary::synthetic(10_000, 2_880, 720, 5, 300, 450);
    sum.second = SecondCheck::Agrees { height: 9_997, sampled: 64 };
    let json = serde_json::to_string(&sum).unwrap();
    assert!(json.contains(r#""second":{"state":"agrees","height":9997,"sampled":64}"#), "{json}");
    let old_json = json.replace(r#","sampled":64"#, "");
    assert!(!old_json.contains("sampled"));
    let back: ProducerSummary = serde_json::from_str(&old_json).unwrap();
    assert_eq!(back.second, SecondCheck::Agrees { height: 9_997, sampled: 0 });
    // The new variants round-trip.
    for s in [SecondCheck::ProducerDiffers { height: 8_010 }, SecondCheck::Agrees { height: 1, sampled: 17 }] {
        assert_eq!(serde_json::from_str::<SecondCheck>(&serde_json::to_string(&s).unwrap()).unwrap(), s);
    }
}

#[test]
fn the_ok_note_says_how_many_heights_were_compared_and_a_producer_difference_is_refused_with_its_own_sentence() {
    // The note on a pass.
    let mut s = scenario(ProfileName::Production);
    let r = s.tick_bob_with(|n, _| tweak(n, |p| p.second = SecondCheck::Agrees { height: 300_017, sampled: 64 }));
    assert_eq!(r.action.kind(), "lock_eth", "{:?} {:?}", r.action, r.notes);
    let note = note_starting(&r, "producer concentration ok");
    assert!(
        note.iter().any(|n| n.ends_with("second node holds the same block at height 300017 and names the same producer for 64 sampled heights")),
        "{note:?}"
    );
    let mut s = scenario(ProfileName::Production);
    let r = s.tick_bob_with(|n, _| tweak(n, |p| p.second = SecondCheck::Agrees { height: 300_017, sampled: 1 }));
    assert!(note_starting(&r, "producer concentration ok").iter().any(|n| n.ends_with("names the same producer for 1 sampled height")));
    // A producer difference: the whole refusal text is pinned, and the override waives it as it waives a hash difference.
    let mut s = scenario(ProfileName::Production);
    let r = s.tick_bob_with(|n, _| tweak(n, |p| p.second = SecondCheck::ProducerDiffers { height: 300_017 }));
    assert_eq!(
        wait_reason(&r),
        "ALARM: the two Parano1d nodes disagree about the producers, not locking (T21): the two nodes name different producers for the block at height 300017 although the block hashes are equal; one of them is misreporting"
    );
    no_address(&wait_reason(&r));
    let mut s = scenario(ProfileName::Production);
    let r = s.tick_bob_with(|n, _| {
        tweak(n, |p| p.second = SecondCheck::ProducerDiffers { height: 300_017 });
        n.accept_producer_concentration = true;
    });
    assert_eq!(r.action.kind(), "lock_eth", "{:?} {:?}", r.action, r.notes);
    assert_eq!(note_starting(&r, "WARNING: producer concentration gate OVERRIDDEN").len(), 1, "{:?}", r.notes);
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

// ================================================================== the remembered detection (T21-13)

const MARKER_HEADLINE: &str = "an earlier tick saw the two Parano1d nodes name different producers for one block";
const MARKER_UNREADABLE_HEADLINE: &str = "the record of a producer disagreement between the two Parano1d nodes cannot be read";

#[test]
fn a_remembered_producer_difference_refuses_under_production_on_a_later_tick_whose_own_check_agrees_and_only_warns_elsewhere() {
    let marker = MarkerState::Present { height: 300_017, at: 1_700_000_123, kind: MarkerKind::Producer };
    // Production: the simulator's second node agrees on every tick, and the lock is still held back.
    let mut s = scenario(ProfileName::Production);
    let r = s.tick_bob_with(|n, _| n.producer_marker = marker.clone());
    let why = wait_reason(&r);
    assert!(
        why.starts_with(&format!(
            "ALARM: {MARKER_HEADLINE}, not locking (T21): at Unix time 1700000123 the two nodes named different producers for the block at height 300017 although the block hashes were equal"
        )),
        "{why}"
    );
    assert!(why.contains("compare the two nodes by hand") && why.contains(".producer-differs") && why.contains("the tool never removes it"), "{why}");
    // Nothing tells the operator to remove the marker to reopen the screen: it cannot be cleared, and the ways on are named.
    assert!(!why.contains("remove it yourself") && !why.contains("removed by hand"), "{why}");
    assert!(
        why.contains("It cannot be cleared for this swap file") && why.contains(OVERRIDE_FLAG) && why.contains("end this swap") && why.contains("new swap file"),
        "{why}"
    );
    assert!(why.contains("with tick --apply the swap file's history records it too"), "{why}");
    assert!(r.notes.contains(&why), "{:?}", r.notes);
    no_address(&why);
    assert_eq!(s.bob.executor.count("lock_eth"), 0);
    assert_eq!(s.bob_phase(), "funding_final", "the file waits, it does not abort");
    // It holds on the next tick too, with the summary healthy and the second check agreeing.
    let r = s.tick_bob_with(|n, _| n.producer_marker = marker.clone());
    assert!(wait_reason(&r).contains(MARKER_HEADLINE));
    // Without the marker the same file locks.
    let r = s.tick_bob();
    assert_eq!(r.action.kind(), "lock_eth", "{:?} {:?}", r.action, r.notes);
    // sepolia and rehearsal: warned on every tick, the lock is offered.
    for profile in [ProfileName::Sepolia, ProfileName::Rehearsal] {
        let mut s = scenario(profile);
        let r = s.tick_bob_with(|n, _| n.producer_marker = marker.clone());
        assert_eq!(r.action.kind(), "lock_eth", "{profile:?}: {:?} {:?}", r.action, r.notes);
        assert!(
            note_starting(&r, "WARNING: ").iter().any(|t| t.contains(MARKER_HEADLINE) && t.contains("only warns and the lock is still offered")),
            "{profile:?}: {:?}",
            r.notes
        );
    }
}

#[test]
fn a_remembered_hash_difference_refuses_with_its_own_sentence_and_follows_the_same_rules() {
    const HASH_HEADLINE: &str = "an earlier tick saw the two Parano1d nodes hold different blocks below a block they agree on";
    let marker = MarkerState::Present { height: 300_017, at: 1_700_000_123, kind: MarkerKind::Hash };
    let mut s = scenario(ProfileName::Production);
    let r = s.tick_bob_with(|n, _| n.producer_marker = marker.clone());
    let why = wait_reason(&r);
    assert!(
        why.starts_with(&format!(
            "ALARM: {HASH_HEADLINE}, not locking (T21): at Unix time 1700000123 the two nodes named different blocks (different hashes) at height 300017, below a block they had agreed on both before and after that question, which two honest nodes cannot do, so one of them misreports; compare the two nodes by hand for that block."
        )),
        "{why}"
    );
    assert!(why.contains(".producer-differs") && why.contains("the tool never removes it"), "{why}");
    assert_eq!(s.bob.executor.count("lock_eth"), 0);
    for profile in [ProfileName::Sepolia, ProfileName::Rehearsal] {
        let mut s = scenario(profile);
        let r = s.tick_bob_with(|n, _| n.producer_marker = marker.clone());
        assert_eq!(r.action.kind(), "lock_eth", "{profile:?}: {:?}", r.notes);
        assert!(note_starting(&r, "WARNING: ").iter().any(|t| t.contains(HASH_HEADLINE)), "{:?}", r.notes);
    }
    let mut s = scenario(ProfileName::Production);
    let r = s.tick_bob_with(|n, _| {
        n.producer_marker = marker.clone();
        n.accept_producer_concentration = true;
    });
    assert_eq!(r.action.kind(), "lock_eth", "{:?} {:?}", r.action, r.notes);
    assert_eq!(note_starting(&r, "WARNING: producer concentration gate OVERRIDDEN").len(), 1, "{:?}", r.notes);
    assert!(s.bob.file.history.iter().any(|h| h.event == format!("{OVERRIDE_HISTORY}: {HASH_HEADLINE}")), "{:?}", s.bob.file.history);
}

#[test]
fn an_unreadable_or_malformed_marker_counts_as_present_under_production_and_warns_elsewhere() {
    let bad = MarkerState::Unreadable { reason: "b.swap.json.producer-differs is not in the producer-differs record's format".into() };
    let mut s = scenario(ProfileName::Production);
    let r = s.tick_bob_with(|n, _| n.producer_marker = bad.clone());
    let why = wait_reason(&r);
    assert!(
        why.starts_with(&format!("ALARM: {MARKER_UNREADABLE_HEADLINE}, not locking (T21): b.swap.json.producer-differs is not in the producer-differs record's format;")),
        "{why}"
    );
    assert!(why.contains("the swap file's history records it too") && why.contains("It cannot be cleared for this swap file"), "{why}");
    assert!(!why.contains("removed or repaired it yourself"), "{why}");
    assert_eq!(s.bob.executor.count("lock_eth"), 0);
    for profile in [ProfileName::Sepolia, ProfileName::Rehearsal] {
        let mut s = scenario(profile);
        let r = s.tick_bob_with(|n, _| n.producer_marker = bad.clone());
        assert_eq!(r.action.kind(), "lock_eth", "{profile:?}: {:?}", r.notes);
        assert!(note_starting(&r, "WARNING: ").iter().any(|t| t.contains(MARKER_UNREADABLE_HEADLINE)), "{:?}", r.notes);
    }
}

const REMEMBERED_HEADLINE: &str = "the swap file's history records a producer disagreement between the two Parano1d nodes";

#[test]
fn a_detection_that_only_the_swap_files_history_remembers_refuses_under_production_warns_elsewhere_and_the_override_waives_it() {
    let remembered = MarkerState::Remembered { at: 1_700_000_123 };
    // Production: no marker file, only the history entry. The simulator's second node agrees, and the lock is still held back.
    let mut s = scenario(ProfileName::Production);
    let r = s.tick_bob_with(|n, _| n.producer_marker = remembered.clone());
    let why = wait_reason(&r);
    assert!(
        why.starts_with(&format!("ALARM: {REMEMBERED_HEADLINE}, not locking (T21): the swap file's history records, at Unix time 1700000123, that an earlier tick saw evidence that cannot come from two honest nodes")),
        "{why}"
    );
    assert!(why.contains("is missing (it was removed, or the swap file was moved)") && why.contains(".producer-differs"), "{why}");
    assert!(
        why.contains("It cannot be cleared for this swap file") && why.contains(OVERRIDE_FLAG) && why.contains("end this swap") && why.contains("new swap file"),
        "{why}"
    );
    assert!(r.notes.contains(&why), "{:?}", r.notes);
    no_address(&why);
    assert_eq!(s.bob.executor.count("lock_eth"), 0);
    assert_eq!(s.bob_phase(), "funding_final", "the file waits, it does not abort");
    // sepolia and rehearsal: warned on every tick, the lock is offered.
    for profile in [ProfileName::Sepolia, ProfileName::Rehearsal] {
        let mut s = scenario(profile);
        let r = s.tick_bob_with(|n, _| n.producer_marker = remembered.clone());
        assert_eq!(r.action.kind(), "lock_eth", "{profile:?}: {:?} {:?}", r.action, r.notes);
        assert!(
            note_starting(&r, "WARNING: ").iter().any(|t| t.contains(REMEMBERED_HEADLINE) && t.contains("only warns and the lock is still offered")),
            "{profile:?}: {:?}",
            r.notes
        );
    }
    // The override waives it exactly as it waives the marker: printed, and recorded once in the history.
    let mut s = scenario(ProfileName::Production);
    let r = s.tick_bob_with(|n, _| {
        n.producer_marker = remembered.clone();
        n.accept_producer_concentration = true;
    });
    assert_eq!(r.action.kind(), "lock_eth", "{:?} {:?}", r.action, r.notes);
    let overridden = note_starting(&r, "WARNING: producer concentration gate OVERRIDDEN");
    assert_eq!(overridden.len(), 1, "{:?}", r.notes);
    assert!(overridden[0].contains(REMEMBERED_HEADLINE), "{}", overridden[0]);
    let entry = format!("{OVERRIDE_HISTORY}: {REMEMBERED_HEADLINE}");
    assert_eq!(s.bob.file.history.iter().filter(|h| h.event == entry).count(), 1, "{:?}", s.bob.file.history);
    // Through the waiting phases the same finding is information only.
    let mut s = Scenario::with_profile(Variant::Raw, ProfileName::Production);
    s.tick_alice();
    s.world.borrow_mut().advance_noid(1);
    let r = s.tick_bob_with(|n, _| n.producer_marker = remembered.clone());
    assert!(note_starting(&r, "producer concentration, not yet blocking").iter().any(|t| t.contains(REMEMBERED_HEADLINE)), "{:?}", r.notes);
}

#[test]
fn the_override_waives_a_remembered_producer_difference_prints_it_and_records_it_once() {
    let marker = MarkerState::Present { height: 300_017, at: 1_700_000_123, kind: MarkerKind::Producer };
    let mut s = scenario(ProfileName::Production);
    let r = s.tick_bob_with(|n, _| {
        n.producer_marker = marker.clone();
        n.accept_producer_concentration = true;
    });
    assert_eq!(r.action.kind(), "lock_eth", "{:?} {:?}", r.action, r.notes);
    let overridden = note_starting(&r, "WARNING: producer concentration gate OVERRIDDEN");
    assert_eq!(overridden.len(), 1, "{:?}", r.notes);
    assert!(overridden[0].contains(MARKER_HEADLINE), "{}", overridden[0]);
    let entry = format!("{OVERRIDE_HISTORY}: {MARKER_HEADLINE}");
    assert_eq!(s.bob.file.history.iter().filter(|h| h.event == entry).count(), 1, "{:?}", s.bob.file.history);
}

/// An override entry is written again when the only existing one precedes the last `producer_differs_seen` entry (an outside read,
/// 2026-11-10: the Ethereum-side lock script accepts an override only when its entry comes AFTER the last detection entry).
#[test]
fn the_override_entry_is_written_again_only_when_the_last_detection_is_newer_than_every_override() {
    use swap_cli::producer_marker::HISTORY as DETECTION;
    use swap_cli::swapfile::HistoryEntry;
    let entry = |at: u64, event: &str| HistoryEntry { at, event: event.to_string(), from: "x".into(), to: "y".into() };
    let override_entry = |at: u64| entry(at, &format!("{OVERRIDE_HISTORY}: largest 60 % of 720"));
    let detection = |at: u64| entry(at, DETECTION);
    let remembered = MarkerState::Remembered { at: 1_700_000_123 };

    // (history before the decision, a detection is remembered by the tick, a new override entry is expected)
    let cases: Vec<(&str, Vec<HistoryEntry>, bool, bool)> = vec![
        ("override, then detection: written again", vec![override_entry(5), detection(6)], true, true),
        ("detection, then override: nothing new", vec![detection(5), override_entry(6)], true, false),
        ("override only, no detection: nothing new", vec![override_entry(5)], false, false),
        ("override, detection, override: nothing new", vec![override_entry(4), detection(5), override_entry(6)], true, false),
        ("override, detection, override, detection: written again", vec![override_entry(3), detection(4), override_entry(5), detection(6)], true, true),
        ("detection only: written (the first one)", vec![detection(5)], true, true),
    ];
    for (name, history, remembers, expect_new) in cases {
        let mut s = scenario(ProfileName::Production);
        s.world.borrow_mut().accept_producer_concentration = true;
        let (noid, eth, now) = {
            let w = s.world.borrow();
            let mut n = w.noid_obs(None);
            if remembers {
                n.producer_marker = remembered.clone();
            } else {
                // No detection: the screen has something to waive through the concentration instead.
                shape(&mut n, 1_500, 400, 1_800, 500);
            }
            (n, w.eth_obs(), w.eth_time)
        };
        let mut file = s.bob.file.clone();
        file.history.extend(history);
        let d = decide(&file, &noid, &eth, now);
        assert_eq!(d.action.kind(), "lock_eth", "{name}: {:?} {:?}", d.action, d.notes);
        let new: Vec<&String> = d.log.iter().filter(|l| l.starts_with(OVERRIDE_HISTORY)).collect();
        assert_eq!(new.len(), usize::from(expect_new), "{name}: {:?}", d.log);
    }
}

/// Without `--accept-producer-concentration` no override entry is ever written, however many ticks run and whatever the history holds;
/// with the flag exactly one is written for a detection newer than the last override; afterwards, without the flag, none again.
#[test]
fn without_the_flag_no_override_entry_is_ever_written_with_the_flag_exactly_one() {
    use swap_cli::producer_marker::HISTORY as DETECTION;
    use swap_cli::swapfile::HistoryEntry;
    let entry = |at: u64, event: &str| HistoryEntry { at, event: event.to_string(), from: "x".into(), to: "y".into() };
    let overrides = |s: &Scenario| s.bob.file.history.iter().filter(|h| h.event.starts_with(OVERRIDE_HISTORY)).count();
    let remembered = MarkerState::Remembered { at: 1_700_000_123 };

    let mut s = scenario(ProfileName::Production);
    s.bob.file.history.push(entry(5, &format!("{OVERRIDE_HISTORY}: largest 60 % of 720")));
    s.bob.file.history.push(entry(6, DETECTION));
    assert_eq!(overrides(&s), 1);
    let detections = |s: &Scenario| s.bob.file.history.iter().filter(|h| h.event == DETECTION).count();

    // Several ticks without the flag: held back, no entry in the log, none in the history.
    for i in 0..4 {
        assert!(!s.world.borrow().accept_producer_concentration);
        let r = s.tick_bob_with(|n, _| n.producer_marker = remembered.clone());
        assert_eq!(r.action.kind(), "wait", "tick {i}: {:?} {:?}", r.action, r.notes);
        assert!(wait_reason(&r).contains("not locking (T21)"), "tick {i}: {:?}", r.notes);
        assert_eq!(overrides(&s), 1, "tick {i}: {:?}", s.bob.file.history);
        assert_eq!(detections(&s), 1, "tick {i}: {:?}", s.bob.file.history);
        assert_eq!(s.bob.executor.count("lock_eth"), 0);
    }
    // And the pure decision with no flag proposes nothing to log.
    {
        let w = s.world.borrow();
        let mut n = w.noid_obs(None);
        n.producer_marker = remembered.clone();
        let d = decide(&s.bob.file, &n, &w.eth_obs(), w.eth_time);
        assert!(d.log.iter().all(|l| !l.starts_with(OVERRIDE_HISTORY)), "{:?}", d.log);
    }

    // One tick with the flag: the lock goes out and exactly one new entry is written.
    s.world.borrow_mut().accept_producer_concentration = true;
    let r = s.tick_bob_with(|n, _| n.producer_marker = remembered.clone());
    assert_eq!(r.action.kind(), "lock_eth", "{:?} {:?}", r.action, r.notes);
    assert_eq!(overrides(&s), 2, "{:?}", s.bob.file.history);
    assert_eq!(s.bob.executor.count("lock_eth"), 1);

    // Further ticks without the flag: nothing more is written.
    s.world.borrow_mut().accept_producer_concentration = false;
    for i in 0..3 {
        let _ = s.tick_bob_with(|n, _| n.producer_marker = remembered.clone());
        assert_eq!(overrides(&s), 2, "later tick {i}: {:?}", s.bob.file.history);
    }
}

// ---------------------------------------------------------------- through the binary: the marker file itself

fn fixtures_dir() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("fixtures")
}

/// A loopback Parano1d node: the fixture's chain state and a synthetic header for every height up to 280,517. A `liar` names another producer
/// for every block and keeps the true hashes.
fn spawn_chain_node(liar: bool) -> MockNode {
    let replay = swap_cli::watch::FixtureRpc::from_file(&fixtures_dir().join("parano1d/idle.json")).unwrap();
    MockNode::spawn(move |m, p| {
        if m == "paranoid_getBlockHeader" {
            let h = p[0].as_u64().unwrap();
            if h > 280_517 {
                return Ok(Value::Null);
            }
            let mut v = plain_header(h);
            if liar {
                v["miner"] = json!("synthetic-miner-Z");
            }
            return Ok(v);
        }
        JsonRpc::call(&replay, m, p.clone())
    })
}

fn bob_file_in(dir: &Path) -> PathBuf {
    let b = dir.join("b.swap.json");
    example_bob_file(example_public(&Secret::from_bytes(seq_bytes(0x33)), Variant::Raw), 1).unwrap().save(&b).unwrap();
    b
}

/// `tick` of `file` against the two nodes (and `extra` flags); the parsed output.
fn tick_nodes(file: &Path, first: &MockNode, second: &MockNode, extra: &[&str]) -> Value {
    let eth_fx = fixtures_dir().join("eth/locked.json");
    let (ok, out, err) = run(bin().args(["tick", s(file)]).args(extra).args(["--eth-fixture", s(&eth_fx), "--noid-rpc", first.url.as_str(), "--noid-rpc", second.url.as_str()]));
    assert!(ok, "{err}");
    assert!(!out.contains("synthetic-miner"), "an address was printed");
    serde_json::from_str(&out).unwrap()
}

fn has_note(v: &Value, needle: &str) -> bool {
    v["notes"].as_array().unwrap().iter().any(|n| n.as_str().unwrap().contains(needle))
}

fn history_count(file: &Path, event: &str) -> usize {
    swap_cli::swapfile::SwapFile::load(file).unwrap().history.iter().filter(|h| h.event == event).count()
}

#[test]
fn a_producer_difference_writes_the_marker_on_a_read_only_tick_and_it_is_never_changed_or_removed_by_later_ticks() {
    let dir = tempfile::tempdir().unwrap();
    let b = bob_file_in(dir.path());
    let marker = swap_cli::producer_marker::path_for(&b);
    let (honest, honest2, liar) = (spawn_chain_node(false), spawn_chain_node(false), spawn_chain_node(true));
    let swap_before = std::fs::read(&b).unwrap();
    // 1. A read-only tick against a second node that lies about producers (true hashes): refused, and remembered.
    let v = tick_nodes(&b, &honest, &liar, &[]);
    assert_eq!(v["noid"]["producers"]["second"], json!({"state": "producer_differs", "height": 280_514}), "{}", v["noid"]["producers"]);
    assert!(has_note(&v, MARKER_HEADLINE), "{}", v["notes"]);
    assert_eq!(v["noid"]["producer_marker"]["state"], "present", "{}", v["noid"]);
    let first_bytes = std::fs::read(&marker).expect("the marker was written by a read-only tick");
    let text = String::from_utf8(first_bytes.clone()).unwrap();
    assert!(text.starts_with("{\"version\":1,\"height\":280514,\"at\":") && text.ends_with("}\n"), "{text}");
    assert!(!text.contains("synthetic") && text.len() < 80, "no address, no hash: {text}");
    assert_eq!(std::fs::read(&b).unwrap(), swap_before, "a read-only tick leaves the swap file alone");
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(std::fs::metadata(&marker).unwrap().permissions().mode() & 0o777, 0o600);
    }
    // 2. A later tick against two nodes that agree: the second check agrees now and the marker still holds the screen closed.
    let v = tick_nodes(&b, &honest, &honest2, &[]);
    assert_eq!(v["noid"]["producers"]["second"]["state"], "agrees", "{}", v["noid"]["producers"]);
    assert!(has_note(&v, MARKER_HEADLINE), "{}", v["notes"]);
    assert_eq!(std::fs::read(&marker).unwrap(), first_bytes, "never rewritten");
    // 3. A second detection leaves the first marker exactly as it is (a hand-written record stands in for an older detection).
    let older = b"{\"version\":1,\"height\":7,\"at\":5}\n";
    std::fs::write(&marker, older).unwrap();
    tick_nodes(&b, &honest, &liar, &[]);
    assert_eq!(std::fs::read(&marker).unwrap(), older, "the first detection stays");
    // 4. With --apply the history gets one entry, however many ticks follow.
    assert_eq!(history_count(&b, "producer_differs_seen"), 0, "read-only ticks keep it in memory only");
    for _ in 0..2 {
        tick_nodes(&b, &honest, &honest2, &["--apply"]);
        assert_eq!(history_count(&b, "producer_differs_seen"), 1);
    }
    assert_eq!(std::fs::read(&marker).unwrap(), older);
}

#[test]
fn an_unreadable_marker_file_reaches_the_screen_and_a_missing_one_changes_nothing() {
    let dir = tempfile::tempdir().unwrap();
    let b = bob_file_in(dir.path());
    let marker = swap_cli::producer_marker::path_for(&b);
    let (n1, n2) = (spawn_chain_node(false), spawn_chain_node(false));
    let v = tick_nodes(&b, &n1, &n2, &[]);
    assert!(v["noid"].get("producer_marker").is_none() && !has_note(&v, MARKER_HEADLINE) && !has_note(&v, MARKER_UNREADABLE_HEADLINE), "{}", v["notes"]);
    assert!(!marker.exists(), "no detection, no marker");
    std::fs::write(&marker, "garbage").unwrap();
    let v = tick_nodes(&b, &n1, &n2, &[]);
    assert_eq!(v["noid"]["producer_marker"]["state"], "unreadable", "{}", v["noid"]);
    assert!(has_note(&v, MARKER_UNREADABLE_HEADLINE), "{}", v["notes"]);
    // An unreadable marker counts as a detection and `--apply` records it in the history once, like a readable one.
    for _ in 0..2 {
        tick_nodes(&b, &n1, &n2, &["--apply"]);
        assert_eq!(history_count(&b, "producer_differs_seen"), 1);
    }
    assert_eq!(std::fs::read(&marker).unwrap(), b"garbage", "the tool never rewrites it");
    // Removing it afterwards reopens nothing: the history remembers.
    std::fs::remove_file(&marker).unwrap();
    let v = tick_nodes(&b, &n1, &n2, &[]);
    assert_eq!(v["noid"]["producer_marker"]["state"], "remembered", "{}", v["noid"]);
    assert!(has_note(&v, REMEMBERED_HEADLINE), "{}", v["notes"]);
    assert!(!marker.exists(), "the tool does not write the marker again for a detection it only remembers");
}

#[test]
fn after_an_apply_tick_removing_the_marker_or_copying_the_swap_file_elsewhere_does_not_reopen_the_screen() {
    let dir = tempfile::tempdir().unwrap();
    let b = bob_file_in(dir.path());
    let marker = swap_cli::producer_marker::path_for(&b);
    let (honest, honest2, liar) = (spawn_chain_node(false), spawn_chain_node(false), spawn_chain_node(true));
    // A read-only tick that sees the lie keeps the swap file out of it; the --apply tick that sees the marker records the history.
    tick_nodes(&b, &honest, &liar, &[]);
    assert!(marker.exists());
    assert_eq!(history_count(&b, "producer_differs_seen"), 0);
    tick_nodes(&b, &honest, &honest2, &["--apply"]);
    assert_eq!(history_count(&b, "producer_differs_seen"), 1);
    // 1. The marker and the header cache are removed; two honest nodes agree: the screen is still closed, on the history alone.
    std::fs::remove_file(&marker).unwrap();
    std::fs::remove_file(swap_cli::watch::producers::cache_path_for(&b)).unwrap();
    for extra in [&[][..], &["--apply"][..]] {
        let v = tick_nodes(&b, &honest, &honest2, extra);
        assert_eq!(v["noid"]["producers"]["second"]["state"], "agrees", "{}", v["noid"]["producers"]);
        assert_eq!(v["noid"]["producer_marker"]["state"], "remembered", "{}", v["noid"]);
        assert!(v["noid"]["producer_marker"]["at"].as_u64().unwrap() > 0);
        assert!(has_note(&v, REMEMBERED_HEADLINE) && has_note(&v, "It cannot be cleared for this swap file"), "{}", v["notes"]);
        assert!(!marker.exists(), "the tool writes no new marker for a detection it only remembers");
        assert_eq!(history_count(&b, "producer_differs_seen"), 1, "still one entry");
    }
    // 2. The swap file is copied to another folder (no marker, no cache there): the history travels with the file.
    let other = tempfile::tempdir().unwrap();
    let copy = other.path().join("b.swap.json");
    std::fs::copy(&b, &copy).unwrap();
    let v = tick_nodes(&copy, &honest, &honest2, &[]);
    assert_eq!(v["noid"]["producer_marker"]["state"], "remembered", "{}", v["noid"]);
    assert!(has_note(&v, REMEMBERED_HEADLINE), "{}", v["notes"]);
    assert!(!swap_cli::producer_marker::path_for(&copy).exists());
    // 3. A new swap file (the way on) starts clean: another file's history does not reach it.
    let third = tempfile::tempdir().unwrap();
    let fresh = bob_file_in(third.path());
    let v = tick_nodes(&fresh, &honest, &honest2, &["--apply"]);
    assert!(v["noid"].get("producer_marker").is_none() && !has_note(&v, REMEMBERED_HEADLINE), "{}", v["notes"]);
    assert_eq!(history_count(&fresh, "producer_differs_seen"), 0);
}

#[cfg(unix)]
#[test]
fn a_marker_that_cannot_be_written_relaxes_nothing_and_the_note_says_so() {
    use std::os::unix::fs::PermissionsExt;
    let dir = tempfile::tempdir().unwrap();
    let b = bob_file_in(dir.path());
    let (honest, liar) = (spawn_chain_node(false), spawn_chain_node(true));
    std::fs::set_permissions(dir.path(), std::fs::Permissions::from_mode(0o555)).unwrap();
    // A directory that stays writable (a user the mode does not bind) cannot make this test's point.
    let probe = dir.path().join("probe");
    let bound = std::fs::File::create(&probe).is_err();
    let _ = std::fs::remove_file(&probe);
    if bound {
        let v = tick_nodes(&b, &honest, &liar, &[]);
        std::fs::set_permissions(dir.path(), std::fs::Permissions::from_mode(0o755)).unwrap();
        assert_eq!(v["noid"]["producers"]["second"]["state"], "producer_differs", "{}", v["noid"]["producers"]);
        assert!(has_note(&v, "was not created") && has_note(&v, "permission denied"), "{}", v["notes"]);
        // A read-only tick saves nothing, and the note says so plainly and says what to do.
        assert!(has_note(&v, "read-only tick and nothing was saved to the swap file") && has_note(&v, "run `tick --apply`"), "{}", v["notes"]);
        assert!(!has_note(&v, "later ticks will not remember it"), "{}", v["notes"]);
        // This tick still refuses, on the detection of this very tick (carried in memory: no file exists, so the history is what `--apply` writes).
        assert!(has_note(&v, "named different producers for the block at height 280514"), "{}", v["notes"]);
        assert_eq!(v["noid"]["producer_marker"]["state"], "present", "{}", v["noid"]);
        assert!(!swap_cli::producer_marker::path_for(&b).exists());
        assert_eq!(history_count(&b, "producer_differs_seen"), 0, "a read-only tick saved nothing");
    } else {
        std::fs::set_permissions(dir.path(), std::fs::Permissions::from_mode(0o755)).unwrap();
        // Written straight to the stderr handle, not with `eprintln!`: the test harness captures `eprintln!` of a passing test, and a skip must be visible.
        use std::io::Write as _;
        let _ = writeln!(std::io::stderr(), "SKIPPED the assertions of a_marker_that_cannot_be_written_relaxes_nothing_and_the_note_says_so: the folder stays writable for this user (running as the superuser?), so the marker write cannot be made to fail");
    }
}

#[test]
fn alices_file_never_reads_or_writes_a_marker() {
    use swap_cli::swapfile::{KdfParams, Passphrase, SwapFile};
    let dir = tempfile::tempdir().unwrap();
    // The same swap as the fixtures' chain state (Bob's example file uses this secret's public section), so the loopback nodes answer for it.
    let secret = Secret::from_bytes(seq_bytes(0x33));
    let a = dir.path().join("a.swap.json");
    SwapFile::new_alice(example_public(&secret, Variant::Raw), &secret, &Passphrase::new("correct horse battery staple"), &KdfParams::fast_for_tests(), 1)
        .unwrap()
        .save(&a)
        .unwrap();
    let marker = swap_cli::producer_marker::path_for(&a);
    let (honest, liar) = (spawn_chain_node(false), spawn_chain_node(true));
    // Against a lying second node no marker is written; with one already there it is neither read nor changed nor recorded.
    let v = tick_nodes(&a, &honest, &liar, &["--apply"]);
    assert!(v["noid"].get("producers").is_none() && v["noid"].get("producer_marker").is_none(), "{}", v["noid"]);
    assert!(!marker.exists());
    std::fs::write(&marker, "{\"version\":1,\"height\":7,\"at\":5}\n").unwrap();
    let v = tick_nodes(&a, &honest, &liar, &["--apply"]);
    assert!(v["noid"].get("producer_marker").is_none() && !has_note(&v, MARKER_HEADLINE), "{}", v["notes"]);
    assert_eq!(history_count(&a, "producer_differs_seen"), 0);
    assert_eq!(std::fs::read(&marker).unwrap(), b"{\"version\":1,\"height\":7,\"at\":5}\n");
}

/// A loopback node that serves the fixture's chain state and, for every height at or below `cut`, a MADE-UP hash and another producer, with
/// the header above the cut naming the made-up hash as its parent (so its own chain of headers still links). Heights above `cut` are true.
fn spawn_made_up_node(cut: u64) -> MockNode {
    let replay = swap_cli::watch::FixtureRpc::from_file(&fixtures_dir().join("parano1d/idle.json")).unwrap();
    MockNode::spawn(move |m, p| {
        if m == "paranoid_getBlockHeader" {
            let h = p[0].as_u64().unwrap();
            if h > 280_517 {
                return Ok(Value::Null);
            }
            let hash = |x: u64| if x <= cut { hash_of(x, 7_777) } else { hash_of(x, 0) };
            let prev = if h == 0 { "0".repeat(64) } else { hash(h - 1) };
            let mut v = header_value(h, hash(h), prev);
            if h <= cut {
                v["miner"] = json!("synthetic-miner-Z");
            }
            return Ok(v);
        }
        JsonRpc::call(&replay, m, p.clone())
    })
}

/// A loopback node on a fork from `from` up: its blocks at and above `from` have other hashes.
fn spawn_fork_node(from: u64) -> MockNode {
    let replay = swap_cli::watch::FixtureRpc::from_file(&fixtures_dir().join("parano1d/idle.json")).unwrap();
    MockNode::spawn(move |m, p| {
        if m == "paranoid_getBlockHeader" {
            let h = p[0].as_u64().unwrap();
            if h > 280_517 {
                return Ok(Value::Null);
            }
            let hash = |x: u64| hash_of(x, u64::from(x >= from));
            let prev = if h == 0 { "0".repeat(64) } else { hash(h - 1) };
            return Ok(header_value(h, hash(h), prev));
        }
        JsonRpc::call(&replay, m, p.clone())
    })
}

/// A loopback node that has no header for the heights from `lo` up to (not including) `below`.
fn spawn_gappy_node(lo: u64, below: u64) -> MockNode {
    let replay = swap_cli::watch::FixtureRpc::from_file(&fixtures_dir().join("parano1d/idle.json")).unwrap();
    MockNode::spawn(move |m, p| {
        if m == "paranoid_getBlockHeader" {
            let h = p[0].as_u64().unwrap();
            if h > 280_517 || (lo..below).contains(&h) {
                return Ok(Value::Null);
            }
            return Ok(plain_header(h));
        }
        JsonRpc::call(&replay, m, p.clone())
    })
}

const MARKER_HASH_HEADLINE: &str = "an earlier tick saw the two Parano1d nodes hold different blocks below a block they agree on";

#[test]
fn a_first_node_with_made_up_hashes_is_remembered_in_a_hash_kind_marker_and_a_later_agreeing_tick_still_refuses() {
    let dir = tempfile::tempdir().unwrap();
    let b = bob_file_in(dir.path());
    let marker = swap_cli::producer_marker::path_for(&b);
    let (liar, honest, honest2) = (spawn_made_up_node(280_513), spawn_chain_node(false), spawn_chain_node(false));
    // The first node (the one whose headers are counted) lies about hashes AND producers below the anchor; its own chain of headers links.
    let v = tick_nodes(&b, &liar, &honest, &[]);
    let second = &v["noid"]["producers"]["second"];
    assert_eq!(second["state"], "sampled_differs", "{}", v["noid"]["producers"]);
    assert!(second["height"].as_u64().unwrap() <= 280_513, "{second}");
    assert!(has_note(&v, MARKER_HASH_HEADLINE), "{}", v["notes"]);
    let bytes = std::fs::read_to_string(&marker).expect("the marker was written");
    assert!(bytes.starts_with("{\"version\":1,\"height\":") && bytes.contains(",\"kind\":\"hash\"}"), "{bytes}");
    assert!(!bytes.contains("synthetic") && bytes.len() < 90, "no address, no hash: {bytes}");
    // A later tick against two honest nodes: its own check agrees, and the screen still refuses for the rest of the swap.
    // (The header cache beside the file still holds what the lying node said earlier; the operator who finds the cause deletes it with the marker.
    // Here the cache is deleted first, so that the honest nodes read the window afresh and agree.)
    std::fs::remove_file(swap_cli::watch::producers::cache_path_for(&b)).unwrap();
    let v = tick_nodes(&b, &honest, &honest2, &[]);
    assert_eq!(v["noid"]["producers"]["second"]["state"], "agrees", "{}", v["noid"]["producers"]);
    assert!(has_note(&v, MARKER_HASH_HEADLINE), "{}", v["notes"]);
    assert_eq!(std::fs::read_to_string(&marker).unwrap(), bytes, "never rewritten");
    // --apply records the history once.
    for _ in 0..2 {
        tick_nodes(&b, &honest, &honest2, &["--apply"]);
        assert_eq!(history_count(&b, "producer_differs_seen"), 1);
    }
}

#[test]
fn a_difference_at_the_anchor_or_a_missing_sampled_height_writes_no_marker() {
    let dir = tempfile::tempdir().unwrap();
    let b = bob_file_in(dir.path());
    let marker = swap_cli::producer_marker::path_for(&b);
    let honest = spawn_chain_node(false);
    // A second node on another block from the anchor (280,514) up: an ordinary, unremembered difference.
    let v = tick_nodes(&b, &honest, &spawn_fork_node(280_514), &[]);
    assert_eq!(v["noid"]["producers"]["second"]["state"], "differs", "{}", v["noid"]["producers"]);
    assert_eq!(v["noid"]["producers"]["second"]["height"], 280_514);
    assert!(!marker.exists());
    assert!(!has_note(&v, MARKER_HASH_HEADLINE) && !has_note(&v, MARKER_HEADLINE));
    // A second node with no header for the heights below the anchor: unreadable, fail closed for the tick, nothing remembered.
    let v = tick_nodes(&b, &honest, &spawn_gappy_node(277_638, 280_514), &[]);
    assert_eq!(v["noid"]["producers"]["second"]["state"], "unreadable", "{}", v["noid"]["producers"]);
    assert!(!marker.exists());
}

// ================================================================== a lock_eth intent that is still pending while the screen refuses (T21)

use swap_cli::engine::{cancel_intent, tick_apply, Executor, IntentStatus, TickOutcome, MIN_CANCEL_AGE_S};
use swap_cli::swapfile::SwapFile;
use swap_cli::watch::EthObservation;

fn obs_of(s: &Scenario) -> (NoidObservation, EthObservation, u64) {
    let w = s.world.borrow();
    (w.noid_obs(None), w.eth_obs(), w.eth_time)
}

fn out_notes<'a>(o: &'a TickOutcome, start: &str) -> Vec<&'a String> {
    o.decision.notes.iter().filter(|n| n.starts_with(start)).collect()
}

fn out_wait(o: &TickOutcome) -> String {
    match &o.decision.action {
        Action::Wait { reason } => reason.clone(),
        other => panic!("expected wait, got {other:?}: {:?}", o.decision.notes),
    }
}

/// Bob at the point where his lock is next, and one `tick --apply` on a healthy screen that records the `lock_eth` intent (nothing is sent).
fn with_recorded_lock(profile: ProfileName) -> (Scenario, SwapFile, NoidObservation, EthObservation, u64) {
    let s = scenario(profile);
    let mut bob = s.bob.file.clone();
    let (n, e, now) = obs_of(&s);
    let out = tick_apply(&mut bob, &n, &e, now, true).unwrap();
    assert_eq!(out.decision.action.kind(), "lock_eth", "{:?}", out.decision.notes);
    assert!(matches!(out.intent, IntentStatus::Recorded(_)), "{:?}", out.intent);
    assert!(out_notes(&out, "ALERT:").is_empty() && out_notes(&out, "WARNING: the producer screen holds").is_empty(), "{:?}", out.decision.notes);
    (s, bob, n, e, now)
}

fn detection() -> MarkerState {
    MarkerState::Present { height: 300_017, at: 1_700_000_123, kind: MarkerKind::Producer }
}

#[test]
fn a_detection_after_a_lock_eth_intent_was_recorded_raises_one_alert_that_names_the_cancel_and_the_intent_stays_held() {
    let (_s, mut bob, n, e, now) = with_recorded_lock(ProfileName::Production);
    let decided_at = bob.pending_intent.as_ref().unwrap().decided_at;
    // The next tick finds the marker (the CLI notes it into the history first, then calls `tick_apply`).
    let mut n2 = n.clone();
    n2.producer_marker = detection();
    // A read-only tick shows the alert too and saves nothing.
    let mut ro = bob.clone();
    let out = tick_apply(&mut ro, &n2, &e, now, false).unwrap();
    assert_eq!(out_notes(&out, "ALERT:").len(), 1, "{:?}", out.decision.notes);
    assert_eq!(ro.history.len(), bob.history.len(), "a read-only tick writes no latch");
    // The tick that saves.
    swap_cli::producer_marker::note_marker(&mut bob, &n2.producer_marker, now);
    let out = tick_apply(&mut bob, &n2, &e, now, true).unwrap();
    let alerts = out_notes(&out, "ALERT:");
    assert_eq!(alerts.len(), 1, "{:?}", out.decision.notes);
    let alert = alerts[0];
    assert!(
        alert.contains("the producer screen refuses to lock now") && alert.contains(MARKER_HEADLINE) && alert.contains(&format!("decided at {decided_at}")),
        "{alert}"
    );
    assert!(
        alert.contains("Do NOT send that lock") && alert.contains("lock.sh") && alert.contains("live.js lock") && alert.contains("`swap-cli intent FILE --cancel`"),
        "{alert}"
    );
    assert!(alert.contains("same chain flags as tick") && alert.contains("look at the contract"), "{alert}");
    no_address(alert);
    assert!(!alert.contains('\n'));
    // The decision: wait; the intent is still pending and held; the history holds the detection.
    let why = out_wait(&out);
    assert!(why.contains("intent lock_eth pending since") && why.contains("do NOT send it") && why.contains("--cancel"), "{why}");
    assert!(!why.contains("reuse the printed parameters"), "the usual advice would send the refused lock: {why}");
    assert!(matches!(&out.intent, IntentStatus::Held(h) if h.action == "lock_eth"), "{:?}", out.intent);
    assert!(bob.pending_intent.is_some());
    assert_eq!(bob.history.iter().filter(|h| h.event == swap_cli::producer_marker::HISTORY).count(), 1);
    // The fresh decision's own refusal note is there once; the alert did not duplicate it.
    assert_eq!(out_notes(&out, "ALARM: ").len(), 1, "{:?}", out.decision.notes);
    assert!(out.decision.notes.iter().any(|n| n.starts_with("frozen parameters of the pending lock_eth")), "{:?}", out.decision.notes);
    // Later ticks print the alert no more (the alert hook sends one message per line); the wait reason and the ALARM stay.
    for _ in 0..2 {
        let out = tick_apply(&mut bob, &n2, &e, now, true).unwrap();
        assert!(out_notes(&out, "ALERT:").is_empty(), "{:?}", out.decision.notes);
        assert!(out_wait(&out).contains("do NOT send it"));
        assert_eq!(out_notes(&out, "ALARM: ").len(), 1);
    }
    // The detection is remembered by the history alone as well (no marker file): the alert, once per intent.
    let (_s2, mut bob2, n, e, now) = with_recorded_lock(ProfileName::Production);
    bob2.log(swap_cli::producer_marker::HISTORY, now);
    let mut n3 = n.clone();
    n3.producer_marker = MarkerState::Remembered { at: now };
    let out = tick_apply(&mut bob2, &n3, &e, now, true).unwrap();
    assert_eq!(out_notes(&out, "ALERT:").len(), 1, "{:?}", out.decision.notes);
    assert!(out_notes(&out, "ALERT:")[0].contains(REMEMBERED_HEADLINE));
}

#[test]
fn the_override_waives_the_alert_and_a_concentration_refusal_raises_it_too() {
    // The override: the screen does not refuse, so the pending lock is not held back and no alert is raised; the OVERRIDDEN note says the rest.
    let (_s, mut bob, n, e, now) = with_recorded_lock(ProfileName::Production);
    let mut n2 = n.clone();
    n2.producer_marker = detection();
    n2.accept_producer_concentration = true;
    let out = tick_apply(&mut bob, &n2, &e, now, true).unwrap();
    assert!(out_notes(&out, "ALERT:").is_empty(), "{:?}", out.decision.notes);
    assert_eq!(out_notes(&out, "WARNING: producer concentration gate OVERRIDDEN").len(), 1, "{:?}", out.decision.notes);
    assert!(out_wait(&out).contains("reuse the printed parameters"), "the ordinary hold of the ledger");
    assert!(matches!(out.intent, IntentStatus::Held(_)));
    // A concentration refusal (one address above 35 %), no detection at all: the alert, with its own reason, and no history entry for a detection.
    let (_s, mut bob, mut n, e, now) = with_recorded_lock(ProfileName::Production);
    shape(&mut n, 1_009, 252, 1_500, 380);
    let out = tick_apply(&mut bob, &n, &e, now, true).unwrap();
    let alerts = out_notes(&out, "ALERT:");
    assert_eq!(alerts.len(), 1, "{:?}", out.decision.notes);
    assert!(alerts[0].contains("producer concentration too high") && alerts[0].contains("`swap-cli intent FILE --cancel`"), "{}", alerts[0]);
    assert!(bob.history.iter().all(|h| h.event != swap_cli::producer_marker::HISTORY));
    assert!(out_wait(&out).contains("do NOT send it") && out_wait(&out).contains("producer concentration too high"));
    assert!(bob.pending_intent.is_some());
    // The same with the override: nothing.
    let (_s, mut bob, mut n, e, now) = with_recorded_lock(ProfileName::Production);
    shape(&mut n, 1_009, 252, 1_500, 380);
    n.accept_producer_concentration = true;
    let out = tick_apply(&mut bob, &n, &e, now, true).unwrap();
    assert!(out_notes(&out, "ALERT:").is_empty(), "{:?}", out.decision.notes);
}

#[test]
fn under_sepolia_a_remembered_detection_is_a_warning_beside_the_pending_intent_and_nothing_else_is() {
    let (_s, mut bob, n, e, now) = with_recorded_lock(ProfileName::Sepolia);
    // A detection: the profile only warns (the fresh decision is still `lock_eth`, held by the ledger), the pending lock gets a WARNING, no ALERT.
    for marker in [detection(), MarkerState::Remembered { at: 5 }] {
        let mut n2 = n.clone();
        n2.producer_marker = marker;
        let out = tick_apply(&mut bob, &n2, &e, now, true).unwrap();
        assert!(out_notes(&out, "ALERT:").is_empty(), "{:?}", out.decision.notes);
        let warnings = out_notes(&out, "WARNING: the producer screen holds a remembered detection");
        assert_eq!(warnings.len(), 1, "{:?}", out.decision.notes);
        assert!(warnings[0].contains("Do NOT send that lock") && warnings[0].contains("`swap-cli intent FILE --cancel`"), "{}", warnings[0]);
        assert!(out_wait(&out).contains("reuse the printed parameters"), "the ledger's own hold: {}", out_wait(&out));
        assert!(matches!(out.intent, IntentStatus::Held(_)) && bob.pending_intent.is_some());
    }
    // A concentration above the sepolia limit (28 %) with no detection: the ordinary warning of the screen only, nothing of the pending-lock kind.
    let mut n3 = n.clone();
    shape(&mut n3, 900, 220, 1_000, 260);
    let out = tick_apply(&mut bob, &n3, &e, now, true).unwrap();
    assert!(out_notes(&out, "ALERT:").is_empty() && out_notes(&out, "WARNING: the producer screen holds").is_empty(), "{:?}", out.decision.notes);
    assert!(!out_notes(&out, "WARNING: producer concentration too high").is_empty(), "{:?}", out.decision.notes);
}

#[test]
fn no_alert_once_the_lock_is_seen_the_intent_is_cancelled_or_nothing_was_read() {
    // The lock is sent and seen: the intent resolves, the phase moves, no alert.
    let (mut s, mut bob, _n, _e, now) = with_recorded_lock(ProfileName::Production);
    let action = Action::LockEth {
        hashlock: bob.public.hashlock,
        t_reveal: bob.pending_intent.as_ref().unwrap().params["t_reveal"].as_u64().unwrap(),
        receiver: bob.public.params.eth.alice_receiver,
        amount_wei: bob.public.params.eth.amount_wei,
    };
    s.bob.executor.execute(&bob, &action, now).unwrap();
    s.world.borrow_mut().advance_eth(1);
    let (mut n2, e2, now2) = obs_of(&s);
    n2.producer_marker = detection();
    let out = tick_apply(&mut bob, &n2, &e2, now2, true).unwrap();
    assert!(matches!(&out.intent, IntentStatus::Resolved(h) if h.action == "lock_eth"), "{:?}", out.intent);
    assert!(out_notes(&out, "ALERT:").is_empty(), "{:?}", out.decision.notes);
    assert_eq!(bob.phase.name(), "locked");
    // A cancelled intent: nothing is pending, so nothing to alert about.
    let (s, mut bob, n, e, now) = with_recorded_lock(ProfileName::Production);
    cancel_intent(&mut bob, &n, &e, now + MIN_CANCEL_AGE_S).unwrap();
    assert!(bob.pending_intent.is_none());
    let mut n3 = n.clone();
    n3.producer_marker = detection();
    let (_, e3, now3) = obs_of(&s);
    let out = tick_apply(&mut bob, &n3, &e3, now3, true).unwrap();
    assert!(out_notes(&out, "ALERT:").is_empty(), "{:?}", out.decision.notes);
    // A tick that read neither a summary nor a marker (a fixture replay) judges nothing here.
    let (_s, mut bob, mut n, e, now) = with_recorded_lock(ProfileName::Production);
    n.producers = None;
    let out = tick_apply(&mut bob, &n, &e, now, true).unwrap();
    assert!(out_notes(&out, "ALERT:").is_empty(), "{:?}", out.decision.notes);
    // Alice's file never has a lock_eth intent, so never this alert.
    let s = scenario(ProfileName::Production);
    let mut alice = s.alice.file.clone();
    let (mut n, e, now) = obs_of(&s);
    n.producer_marker = detection();
    let out = tick_apply(&mut alice, &n, &e, now, true).unwrap();
    assert!(out_notes(&out, "ALERT:").is_empty(), "{:?}", out.decision.notes);
}
