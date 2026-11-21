//! T21-11: the reveal sidecar `live.js claim` writes beside the swap file just before it broadcasts Alice's reveal, and how `tick` reads it.
//! Driven on the simulator of `common/`. The writer side is `eth/test/live.test.js`.

mod common;

use common::*;
use swap_cli::engine::{cancel_intent, reveal_cutoff_for, secret_may_be_public, tick_apply, IntentStatus, REVEAL_SIDECAR_SEEN};
use swap_cli::reveal_sidecar::{note_sidecar, path_for};
use swap_cli::secret::Variant;
use swap_cli::swapfile::SwapFile;
use swap_cli::watch::{EthObservation, NoidObservation};

fn observe(s: &Scenario) -> (NoidObservation, EthObservation, u64) {
    let w = s.world.borrow();
    (w.noid_obs(None), w.eth_obs(), w.eth_time)
}

/// One `tick --apply` as the binary does it: the sidecar first, then the decision, then the save.
fn tick(s: &Scenario, file: &mut SwapFile, path: &std::path::Path) -> (swap_cli::engine::TickOutcome, Vec<String>) {
    let (n, e, now) = observe(s);
    let notes = note_sidecar(file, path, now);
    let out = tick_apply(file, &n, &e, now, true).unwrap();
    file.save(path).unwrap();
    (out, notes)
}

fn lock_of(s: &Scenario) -> ([u8; 32], u64) {
    let w = s.world.borrow();
    let l = w.lock.as_ref().expect("a lock");
    (l.lock_id, l.timelock)
}

fn has(file: &SwapFile, event: &str) -> bool {
    file.history.iter().any(|h| h.event == event)
}

fn count(file: &SwapFile, event: &str) -> usize {
    file.history.iter().filter(|h| h.event == event).count()
}

fn sidecar_body(lock_id: &[u8; 32], tx_hash: Option<[u8; 32]>, at: u64) -> String {
    let h = tx_hash.map(|h| format!("\"{}\"", hex::encode(h))).unwrap_or_else(|| "null".into());
    format!("{{\"version\":1,\"lock_id\":\"{}\",\"tx_hash\":{h},\"at\":{at}}}\n", hex::encode(lock_id))
}

/// Alice on the CLI path with Bob's lock final; her file is at `path` (a name of its own, so the sidecar sits beside it).
fn alice_at_lock_final() -> (Scenario, SwapFile, std::path::PathBuf) {
    let mut s = Scenario::new(Variant::Raw);
    s.run_to_lock_final();
    let path = s.dir.path().join("alice-ops.swap.json");
    let alice = s.alice.file.clone();
    alice.save(&path).unwrap();
    (s, alice, path)
}

#[test]
fn a_sidecar_of_this_lock_counts_once_survives_its_removal_and_moves_the_cutoff_to_the_late_one() {
    let (s, mut alice, path) = alice_at_lock_final();
    let (lock_id, t_reveal) = lock_of(&s);
    let strict = reveal_cutoff_for(&alice, t_reveal);
    assert!(!secret_may_be_public(&alice));
    // No sidecar: nothing is recorded, no note, the first-publication cutoff.
    let (_, notes) = tick(&s, &mut alice, &path);
    assert!(notes.is_empty() && !has(&alice, REVEAL_SIDECAR_SEEN), "{notes:?}");
    assert_eq!(reveal_cutoff_for(&alice, t_reveal), strict);
    // The sidecar appears (live.js wrote it before a broadcast that nobody saw).
    std::fs::write(path_for(&path), sidecar_body(&lock_id, Some([7; 32]), 1_700_000_000)).unwrap();
    let (_, notes) = tick(&s, &mut alice, &path);
    assert!(notes.iter().any(|n| n.contains("reveal sidecar") && n.contains("late cutoff")), "{notes:?}");
    assert!(has(&alice, REVEAL_SIDECAR_SEEN));
    assert!(!secret_may_be_public(&alice), "a started send is not proof that the secret is public: the other rules keep waiting for evidence");
    assert!(reveal_cutoff_for(&alice, t_reveal) > strict, "the late cutoff T_reveal - DE leaves more time than T_reveal - M_A");
    // Once; the marker is in the saved file; removing the sidecar later does not undo it.
    tick(&s, &mut alice, &path);
    assert_eq!(count(&alice, REVEAL_SIDECAR_SEEN), 1);
    std::fs::remove_file(path_for(&path)).unwrap();
    tick(&s, &mut alice, &path);
    let reloaded = SwapFile::load(&path).unwrap();
    assert_eq!(count(&reloaded, REVEAL_SIDECAR_SEEN), 1);
    assert!(!secret_may_be_public(&reloaded) && has(&reloaded, REVEAL_SIDECAR_SEEN));
    assert!(reveal_cutoff_for(&reloaded, t_reveal) > strict);
}

#[test]
fn a_read_only_tick_uses_the_sidecar_but_leaves_the_file_as_it_was() {
    let (s, alice, path) = alice_at_lock_final();
    let (lock_id, t_reveal) = lock_of(&s);
    std::fs::write(path_for(&path), sidecar_body(&lock_id, None, 5)).unwrap();
    let before = std::fs::read(&path).unwrap();
    // What the binary does without --apply: a clone, the sidecar, the decision with record == false, no save.
    let mut work = alice.clone();
    let (n, e, now) = observe(&s);
    let notes = note_sidecar(&mut work, &path, now);
    tick_apply(&mut work, &n, &e, now, false).unwrap();
    assert!(!notes.is_empty() && has(&work, REVEAL_SIDECAR_SEEN));
    assert_eq!(std::fs::read(&path).unwrap(), before, "a read-only tick writes nothing");
    assert!(reveal_cutoff_for(&work, t_reveal) > reveal_cutoff_for(&alice, t_reveal));
}

#[test]
fn a_sidecar_of_another_lock_or_not_in_the_format_is_ignored_and_said_so() {
    let (s, mut alice, path) = alice_at_lock_final();
    let (lock_id, t_reveal) = lock_of(&s);
    let strict = reveal_cutoff_for(&alice, t_reveal);
    let mut other = lock_id;
    other[0] ^= 1;
    for (what, body) in [
        ("foreign", sidecar_body(&other, None, 5)),
        ("garbage", "this is not json".to_string()),
        ("empty", String::new()),
        ("wrong version", sidecar_body(&lock_id, None, 5).replace("\"version\":1", "\"version\":2")),
        ("short lock id", "{\"version\":1,\"lock_id\":\"ab\",\"tx_hash\":null,\"at\":1}".to_string()),
    ] {
        std::fs::write(path_for(&path), body).unwrap();
        let (_, notes) = tick(&s, &mut alice, &path);
        assert!(notes.iter().any(|n| n.contains("ignored")), "{what}: {notes:?}");
        assert!(!has(&alice, REVEAL_SIDECAR_SEEN) && !secret_may_be_public(&alice), "{what}");
        assert_eq!(reveal_cutoff_for(&alice, t_reveal), strict, "{what}");
    }
}

#[test]
fn bobs_file_never_reads_a_sidecar() {
    let mut s = Scenario::new(Variant::Raw);
    s.run_to_lock_final();
    let (lock_id, _) = lock_of(&s);
    let path = s.dir.path().join("bob-ops.swap.json");
    let mut bob = s.bob.file.clone();
    bob.save(&path).unwrap();
    std::fs::write(path_for(&path), sidecar_body(&lock_id, None, 5)).unwrap();
    assert!(note_sidecar(&mut bob, &path, 10).is_empty());
    assert!(!has(&bob, REVEAL_SIDECAR_SEEN));
}

/// The window itself: the reveal was decided, then broadcast by `live.js` (sidecar written first), then it left the pool before any tick
/// looked. The file has only `intent_decided:reveal_eth`. Past `T_reveal - M_A` the re-send must be allowed, until `T_reveal - DE`.
#[test]
fn a_reveal_sent_and_dropped_before_any_tick_saw_it_may_be_re_sent_past_the_m_a_cutoff_with_the_sidecar_and_not_without() {
    for with_sidecar in [true, false] {
        let (s, mut alice, path) = alice_at_lock_final();
        let (lock_id, t_reveal) = lock_of(&s);
        let g = *s.gates();
        let (out, _) = tick(&s, &mut alice, &path);
        assert_eq!(out.decision.action.kind(), "reveal_eth", "{:?}", out.decision);
        assert!(matches!(out.intent, IntentStatus::Recorded(_)));
        // live.js writes the sidecar, broadcasts; the claim is dropped; no tick sees a pending nonce. (Nothing is sent in the simulator.)
        if with_sidecar {
            std::fs::write(path_for(&path), sidecar_body(&lock_id, Some([9; 32]), 42)).unwrap();
        }
        s.world.borrow_mut().warp_eth_to(t_reveal - g.m_a_s + 100);
        let (n, e, now) = observe(&s);
        let decided_at = alice.pending_intent.as_ref().unwrap().decided_at;
        // The operator cancels the intent after the minimum age (the cancel guard sees no pending claim), as in the R5-1 test.
        cancel_intent(&mut alice, &n, &e, now.max(decided_at + g.min_cancel_age_s)).unwrap();
        let (out, notes) = tick(&s, &mut alice, &path);
        if with_sidecar {
            assert_eq!(out.decision.action.kind(), "reveal_eth", "{:?} {notes:?}", out.decision);
            let IntentStatus::Recorded(i) = &out.intent else { panic!("{:?}", out.intent) };
            assert_eq!(i.params["cutoff"], t_reveal - g.de_s);
        } else {
            assert_ne!(out.decision.action.kind(), "reveal_eth", "a first publication past M_A is refused: {:?}", out.decision);
            assert!(out.decision.notes.iter().any(|n| n.contains("not revealing")), "{:?}", out.decision.notes);
        }
    }
}

#[test]
fn both_sides_of_the_late_cutoff_with_a_sidecar() {
    let (s, mut alice, path) = alice_at_lock_final();
    let (lock_id, t_reveal) = lock_of(&s);
    let g = *s.gates();
    std::fs::write(path_for(&path), sidecar_body(&lock_id, None, 1)).unwrap();
    // Inside T_reveal - DE: the reveal is still offered although T_reveal - M_A has passed.
    s.world.borrow_mut().warp_eth_to(t_reveal - g.de_s - 60);
    let (out, _) = tick(&s, &mut alice, &path);
    assert_eq!(out.decision.action.kind(), "reveal_eth", "{:?}", out.decision);
    // Past T_reveal - DE: the sidecar relaxes nothing further.
    let (s2, mut alice2, path2) = alice_at_lock_final();
    std::fs::write(path_for(&path2), sidecar_body(&lock_of(&s2).0, None, 1)).unwrap();
    s2.world.borrow_mut().warp_eth_to(t_reveal - g.de_s + 60);
    let (out, _) = tick(&s2, &mut alice2, &path2);
    assert_ne!(out.decision.action.kind(), "reveal_eth", "{:?}", out.decision);
}

fn dust(slot: u32, creation: u64, amount: u64) -> swap_cli::watch::NoidInstance {
    swap_cli::watch::NoidInstance { slot_index: slot, creation_id: creation, amount_micronoid: amount }
}

/// The sidecar relaxes the CUTOFF only. A started send (a node that refused the claim leaves one too) must not switch off the rule that
/// withholds the reveal while a second fitting instance sits at Alice's root (R4-4): Bob could claim both.
#[test]
fn a_sidecar_does_not_relax_the_two_instances_rule() {
    let (s, mut alice, path) = alice_at_lock_final();
    let (lock_id, _) = lock_of(&s);
    std::fs::write(path_for(&path), sidecar_body(&lock_id, None, 1)).unwrap();
    let amount = s.public.params.amount_micronoid;
    s.world.borrow_mut().instances_after.push(dust(9, 2, amount));
    let (out, notes) = tick(&s, &mut alice, &path);
    assert_eq!(out.decision.action.kind(), "wait", "{:?} {notes:?}", out.decision);
    assert!(out.decision.notes.iter().any(|n| n.contains("revealing would let Bob claim every one of them")), "{:?}", out.decision.notes);
    assert!(has(&alice, REVEAL_SIDECAR_SEEN), "the marker is recorded all the same");
}

/// The binary reads the sidecar beside the file it ticks (the wiring in `main.rs`): a sidecar that cannot be matched is reported in the notes
/// of the tick, and a read-only tick leaves the swap file byte for byte as it was. Alice's file here is at `created`, with no lock yet.
#[test]
fn the_binary_tick_reads_the_sidecar_beside_the_swap_file() {
    use swap_cli::secret::Secret;
    use swap_cli::swapfile::{example_public, KdfParams, Passphrase};
    let dir = tempfile::tempdir().unwrap();
    let a = dir.path().join("a.swap.json");
    let secret = Secret::from_bytes(swap_cli::htlc_harness::seq_bytes(0x33));
    let public = example_public(&secret, Variant::Raw);
    SwapFile::new_alice(public, &secret, &Passphrase::new("pw"), &KdfParams::fast_for_tests(), 1).unwrap().save(&a).unwrap();
    let root = concat!(env!("CARGO_MANIFEST_DIR"), "/fixtures/");
    let run = |apply: bool| {
        let mut cmd = std::process::Command::new(env!("CARGO_BIN_EXE_swap-cli"));
        cmd.args(["tick", a.to_str().unwrap(), "--noid-fixture", &format!("{root}parano1d/idle.json"), "--eth-fixture", &format!("{root}eth/locked.json"), "--now", "1794312000"]);
        if apply {
            cmd.arg("--apply");
        }
        let out = cmd.output().expect("run swap-cli");
        assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));
        serde_json::from_slice::<serde_json::Value>(&out.stdout).unwrap()
    };
    let notes_of = |v: &serde_json::Value| v["notes"].as_array().unwrap().iter().map(|n| n.as_str().unwrap().to_string()).collect::<Vec<_>>();
    assert!(!notes_of(&run(false)).iter().any(|n| n.contains("reveal sidecar") || n.contains("reveal-sent")));
    std::fs::write(path_for(&a), sidecar_body(&[0x55; 32], None, 5)).unwrap();
    let before = std::fs::read(&a).unwrap();
    let notes = notes_of(&run(false));
    assert!(notes.iter().any(|n| n.contains(".reveal-sent") && n.contains("ignored")), "{notes:?}");
    assert_eq!(std::fs::read(&a).unwrap(), before, "a read-only tick writes nothing");
    let notes = notes_of(&run(true));
    assert!(notes.iter().any(|n| n.contains(".reveal-sent") && n.contains("ignored")), "{notes:?}");
    assert!(!has(&SwapFile::load(&a).unwrap(), REVEAL_SIDECAR_SEEN));
}
