//! `tick --apply --observe-only`: the facts of an observation are written to the swap file (Bob's `received` -> `funded` -> `funding_final`
//! from the first sighting of Alice's funding, not from the tick after his approval), and NOTHING that a decision of the engine records: no
//! intent, no recorded abort, no spend parameters in the output. A file that holds an intent is refused. The library tests drive
//! `engine::tick_observe` (what the CLI calls) next to `tick_apply`; the binary tests run the command over fixtures.

mod common;

#[path = "common/home.rs"]
mod home;

use std::path::Path;

use common::*;
use swap_cli::engine::{cancel_intent, observe_only_refusal, Executor, tick_apply, tick_observe, Action, IntentStatus, TickOutcome, MIN_CANCEL_AGE_S};
use swap_cli::producer_gate::OVERRIDE_HISTORY;
use swap_cli::secret::{Secret, Variant};
use swap_cli::state::{BobPhase, Event, Phase};
use swap_cli::swapfile::{example_public, SwapFile};
use swap_cli::watch::{EthObservation, NoidObservation};

fn observe(s: &Scenario) -> (NoidObservation, EthObservation, u64) {
    let w = s.world.borrow();
    (w.noid_obs(None), w.eth_obs(), w.eth_time)
}

/// One `tick --apply --observe-only` of `file`: observe, `tick_observe`, save (the CLI saves before it prints).
fn watch(s: &Scenario, file: &mut SwapFile, path: &Path) -> TickOutcome {
    let (n, e, now) = observe(s);
    let out = tick_observe(file, &n, &e, now).unwrap();
    file.save(path).unwrap();
    out
}

/// One full `tick --apply`.
fn apply(s: &Scenario, file: &mut SwapFile, path: &Path) -> TickOutcome {
    let (n, e, now) = observe(s);
    let out = tick_apply(file, &n, &e, now, true).unwrap();
    file.save(path).unwrap();
    out
}

fn no_ledger_trace(file: &SwapFile) {
    assert!(file.pending_intent.is_none(), "{:?}", file.pending_intent);
    assert!(file.cancelled_intents.is_empty());
    assert!(file.history.iter().all(|h| !h.event.starts_with("intent_")), "{:?}", file.history);
}

/// Alice has funded and the funding is in the chain; Bob's file has not been ticked (`received`).
fn funded_and_bob_not_ticked() -> Scenario {
    let mut s = Scenario::new(Variant::Raw);
    let r = s.tick_alice();
    assert_eq!(r.action.kind(), "fund_noid");
    s.world.borrow_mut().advance_noid(1);
    assert_eq!(s.bob_phase(), "received");
    s
}

// ------------------------------------------------------------------ what it writes

#[test]
fn two_observe_ticks_move_bob_to_funding_final_and_record_no_intent_even_when_the_decision_is_lock_eth() {
    let s = funded_and_bob_not_ticked();
    let path = s.dir.path().join("bob-obs.swap.json");
    let mut bob = s.bob.file.clone();
    bob.save(&path).unwrap();

    // First sighting: `funded`, counted from this tip.
    let out = watch(&s, &mut bob, &path);
    let tip1 = s.world.borrow().tip;
    assert!(out.decision.events.iter().any(|e| e.name() == "noid_instance_seen"), "{:?}", out.decision.events);
    assert!(matches!(&bob.phase, Phase::Bob(BobPhase::Funded { seen_at_tip, .. }) if *seen_at_tip == tip1), "{:?}", bob.phase);
    assert_eq!(out.decision.action.kind(), "wait");
    assert_eq!(out.intent, IntentStatus::None);
    no_ledger_trace(&bob);
    assert_eq!(SwapFile::load(&path).unwrap(), bob, "what was applied is on disk");

    // Eighteen blocks later: `funding_final` from the instance's own count, and the engine's decision is the lock.
    s.world.borrow_mut().advance_noid(18);
    let out = watch(&s, &mut bob, &path);
    let tip2 = s.world.borrow().tip;
    assert!(out.decision.events.iter().any(|e| e.name() == "noid_funding_final"), "{:?}", out.decision.events);
    assert!(matches!(&bob.phase, Phase::Bob(BobPhase::FundingFinal { final_at_tip, .. }) if *final_at_tip == tip2), "{:?}", bob.phase);
    assert!(matches!(out.decision.action, Action::LockEth { .. }), "{:?}", out.decision.action);
    assert_eq!(out.intent, IntentStatus::None, "the lock is decided, never recorded");
    no_ledger_trace(&bob);
    assert_eq!(SwapFile::load(&path).unwrap(), bob);

    // The next observe-only tick has nothing to add: still no intent, the same phase.
    let out = watch(&s, &mut bob, &path);
    assert!(out.decision.events.is_empty(), "{:?}", out.decision.events);
    assert!(matches!(out.decision.action, Action::LockEth { .. }));
    no_ledger_trace(&bob);

    // The full tick that follows decides the lock and freezes it at once: the funding was counted from the first sighting, no new wait.
    let out = apply(&s, &mut bob, &path);
    assert!(matches!(out.decision.action, Action::LockEth { .. }), "{:?}", out.decision);
    assert!(out.decision.events.is_empty(), "no new 18-block count: {:?}", out.decision.events);
    let IntentStatus::Recorded(intent) = &out.intent else { panic!("{:?}", out.intent) };
    assert_eq!(intent.action, "lock_eth");
    assert_eq!(intent.phase_at_decision, "funding_final");
    assert_eq!(SwapFile::load(&path).unwrap().pending_intent.as_ref(), Some(intent));
    assert!(matches!(&bob.phase, Phase::Bob(BobPhase::FundingFinal { final_at_tip, .. }) if *final_at_tip == tip2));
}

#[test]
fn a_full_apply_on_a_file_advanced_by_observe_ticks_equals_one_advanced_by_full_apply_ticks_that_only_waited() {
    let s = funded_and_bob_not_ticked();
    let (pa, pb) = (s.dir.path().join("a.swap.json"), s.dir.path().join("b.swap.json"));
    let (mut obs, mut full) = (s.bob.file.clone(), s.bob.file.clone());
    obs.save(&pa).unwrap();
    full.save(&pb).unwrap();

    for blocks in [0u64, 5, 5] {
        s.world.borrow_mut().advance_noid(blocks);
        let o = watch(&s, &mut obs, &pa);
        let f = apply(&s, &mut full, &pb);
        assert_eq!(f.decision.action.kind(), "wait", "the full ticks decided only waits: {:?}", f.decision);
        assert_eq!(f.intent, IntentStatus::None);
        assert_eq!(o.decision.events, f.decision.events);
        assert_eq!(obs, full, "after {blocks} more blocks");
    }
    // The last tick of the series: both full, both lock at once, and the two files end identical.
    s.world.borrow_mut().advance_noid(8);
    let (a, b) = (apply(&s, &mut obs, &pa), apply(&s, &mut full, &pb));
    assert!(matches!(a.decision.action, Action::LockEth { .. }), "{:?}", a.decision);
    assert_eq!(a.decision.action, b.decision.action);
    assert_eq!(a.intent, b.intent);
    assert!(matches!(a.intent, IntentStatus::Recorded(_)));
    assert_eq!(obs, full);
    assert_eq!(std::fs::read(&pa).unwrap(), std::fs::read(&pb).unwrap());
}

#[test]
fn observe_only_keeps_the_history_entries_that_go_with_an_offered_action_for_the_full_tick() {
    // Production, the screen cannot be completed and the operator accepted the risk: the full tick writes the override entry when it offers the
    // lock; an observe-only tick does not (it offers nothing).
    let mut s = Scenario::new(Variant::Raw);
    s.tick_alice();
    s.world.borrow_mut().advance_noid(1);
    s.tick_both();
    s.world.borrow_mut().advance_noid(18);
    s.tick_alice();
    s.world.borrow_mut().accept_producer_concentration = true;
    s.world.borrow_mut().producers = SimProducers::Absent;
    let path = s.dir.path().join("bob-override.swap.json");
    let mut bob = s.bob.file.clone();
    bob.save(&path).unwrap();
    let overrides = |f: &SwapFile| f.history.iter().filter(|h| h.event.starts_with(OVERRIDE_HISTORY)).count();

    let out = watch(&s, &mut bob, &path);
    assert!(matches!(out.decision.action, Action::LockEth { .. }), "{:?}", out.decision);
    assert!(!out.decision.log.is_empty(), "the decision proposes the entry");
    assert_eq!(overrides(&bob), 0, "{:?}", bob.history);
    no_ledger_trace(&bob);
    let out = apply(&s, &mut bob, &path);
    assert!(matches!(out.intent, IntentStatus::Recorded(_)));
    assert_eq!(overrides(&bob), 1, "{:?}", bob.history);
}

// ------------------------------------------------------------------ what it never writes

#[test]
fn observe_only_never_records_an_abort_and_leaves_the_phase() {
    // Bob at `funding_final`, the tip then runs past his last lock height: the engine's decision is `abort`.
    let s = funded_and_bob_not_ticked();
    let path = s.dir.path().join("bob-abort.swap.json");
    let mut bob = s.bob.file.clone();
    bob.save(&path).unwrap();
    watch(&s, &mut bob, &path);
    s.world.borrow_mut().advance_noid(18);
    watch(&s, &mut bob, &path);
    assert_eq!(bob.phase.name(), "funding_final");
    let lock_by = s.public.params.lock_by_height;
    s.world.borrow_mut().tip = lock_by + 40;
    let before = bob.clone();
    let out = watch(&s, &mut bob, &path);
    assert!(matches!(out.decision.action, Action::Abort { .. }), "{:?}", out.decision);
    assert!(out.decision.events.iter().all(|e| !matches!(e, Event::Abort { .. })), "{:?}", out.decision.events);
    assert_eq!(bob.phase.name(), "funding_final", "the phase is left");
    assert_eq!(bob, before, "nothing at all was written by a tick that only waited for a decision");
    assert_eq!(SwapFile::load(&path).unwrap(), before);
    // The full tick records the abort (so the test above is not vacuous).
    let mut full = before.clone();
    let out = apply(&s, &mut full, &s.dir.path().join("bob-abort-full.swap.json"));
    assert!(matches!(out.decision.action, Action::Abort { .. }));
    assert_eq!(full.phase.name(), "aborted", "{:?}", full.phase);

    // Alice before her funding, too late to fund: the same.
    let s = Scenario::new(Variant::Raw);
    let path = s.dir.path().join("alice-abort.swap.json");
    let mut alice = s.alice.file.clone();
    alice.save(&path).unwrap();
    s.world.borrow_mut().tip = s.public.params.lock_by_height + 40;
    let out = watch(&s, &mut alice, &path);
    assert!(matches!(&out.decision.action, Action::Abort { reason } if reason.starts_with("too late to fund")), "{:?}", out.decision.action);
    assert_eq!(alice.phase.name(), "created");
    assert_eq!(alice, s.alice.file);
    let mut full = s.alice.file.clone();
    apply(&s, &mut full, &s.dir.path().join("alice-abort-full.swap.json"));
    assert_eq!(full.phase.name(), "aborted");
}

#[test]
fn observe_only_never_records_a_funding_intent_for_alice() {
    let s = Scenario::new(Variant::Raw);
    let path = s.dir.path().join("alice.swap.json");
    let mut alice = s.alice.file.clone();
    alice.save(&path).unwrap();
    let out = watch(&s, &mut alice, &path);
    assert!(matches!(out.decision.action, Action::FundNoid { .. }), "{:?}", out.decision.action);
    assert_eq!(out.intent, IntentStatus::None);
    no_ledger_trace(&alice);
    assert_eq!(alice, s.alice.file);
}

// ------------------------------------------------------------------ the refusal

#[test]
fn observe_only_with_a_held_intent_is_refused_and_writes_nothing() {
    let s = funded_and_bob_not_ticked();
    let path = s.dir.path().join("bob-held.swap.json");
    let mut bob = s.bob.file.clone();
    bob.save(&path).unwrap();
    watch(&s, &mut bob, &path);
    s.world.borrow_mut().advance_noid(18);
    let out = apply(&s, &mut bob, &path);
    assert!(matches!(out.intent, IntentStatus::Recorded(_)));
    s.world.borrow_mut().advance_noid(2);
    let before = bob.clone();
    let bytes = std::fs::read(&path).unwrap();
    let (n, e, now) = observe(&s);

    let why = observe_only_refusal(&bob).expect("an intent is held");
    assert!(why.contains("holds an intent") && why.contains("lock_eth") && why.contains("full `tick --apply`"), "{why}");
    let err = tick_observe(&mut bob, &n, &e, now).unwrap_err();
    assert_eq!(err, why);
    assert_eq!(bob, before, "the in-memory file is untouched");
    assert_eq!(std::fs::read(&path).unwrap(), bytes, "the file on disk is untouched");

    // A pending action of the library path is refused the same way.
    let mut with_action = s.bob.file.clone();
    with_action.set_pending(swap_cli::swapfile::PendingAction { kind: "lock_eth".into(), created_at: 1, attempt: 1, maybe_sent: true, detail: serde_json::Value::Null });
    let why = observe_only_refusal(&with_action).expect("an action is pending");
    assert!(why.contains("pending action (lock_eth)"), "{why}");
    assert!(tick_observe(&mut with_action, &n, &e, now).is_err());

    // A file with nothing held is not refused.
    assert!(observe_only_refusal(&s.bob.file).is_none());
}

#[test]
fn once_an_intent_was_decided_observe_only_is_refused_even_after_it_was_cancelled_or_resolved() {
    let mut s = funded_and_bob_not_ticked();
    let path = s.dir.path().join("bob-decided.swap.json");
    let mut bob = s.bob.file.clone();
    bob.save(&path).unwrap();
    watch(&s, &mut bob, &path);
    s.world.borrow_mut().advance_noid(18);
    assert!(observe_only_refusal(&bob).is_none(), "before any decision the file may be observed");
    let out = apply(&s, &mut bob, &path);
    assert!(matches!(out.intent, IntentStatus::Recorded(_)));

    // Cancelled (nothing was sent): no intent is held any more, the history still shows the decision.
    let (n, e, now) = observe(&s);
    cancel_intent(&mut bob, &n, &e, now + MIN_CANCEL_AGE_S).unwrap();
    assert!(bob.pending_intent.is_none());
    let why = observe_only_refusal(&bob).expect("a decided intent is in the history");
    assert!(why.contains("holds a decided intent (lock_eth)") && why.contains("only a full `tick --apply` writes the file"), "{why}");
    let before = bob.clone();
    assert_eq!(tick_observe(&mut bob, &n, &e, now).unwrap_err(), why);
    assert_eq!(bob, before, "nothing was written");

    // Decided again, sent, and resolved by the chain (the lock is mined): still refused.
    let out = apply(&s, &mut bob, &path);
    assert!(matches!(out.intent, IntentStatus::Recorded(_)), "{:?}", out.decision);
    let now = s.now();
    s.bob.executor.execute(&bob, &out.decision.action, now).unwrap();
    s.world.borrow_mut().advance_eth(1);
    let out = apply(&s, &mut bob, &path);
    assert!(matches!(&out.intent, IntentStatus::Resolved(h) if h.action == "lock_eth"), "{:?}", out.intent);
    assert!(bob.pending_intent.is_none());
    let why = observe_only_refusal(&bob).expect("the decision stays in the history");
    assert!(why.contains("decided intent (lock_eth)"), "{why}");
}

#[test]
fn a_reorg_during_observe_ticks_starts_bobs_finality_count_over_and_a_later_full_apply_waits() {
    let s = funded_and_bob_not_ticked();
    let path = s.dir.path().join("bob-reorg.swap.json");
    let mut bob = s.bob.file.clone();
    bob.save(&path).unwrap();
    watch(&s, &mut bob, &path);
    assert_eq!(bob.phase.name(), "funded");
    s.world.borrow_mut().advance_noid(5);

    // A reorg takes the funding back before it is final: the file returns to `received`, written by the observe tick.
    let inst = s.world.borrow_mut().instance.take().unwrap();
    let out = watch(&s, &mut bob, &path);
    assert!(out.decision.events.iter().any(|e| e.name() == "noid_instance_gone"), "{:?}", out.decision.events);
    assert_eq!(bob.phase.name(), "received");
    no_ledger_trace(&bob);
    assert_eq!(SwapFile::load(&path).unwrap(), bob);

    // It comes back in a later block: seen again, and the count starts from this tip.
    s.world.borrow_mut().advance_noid(3);
    s.world.borrow_mut().instance = Some(inst);
    watch(&s, &mut bob, &path);
    let tip2 = s.world.borrow().tip;
    assert!(matches!(&bob.phase, Phase::Bob(BobPhase::Funded { seen_at_tip, .. }) if *seen_at_tip == tip2), "{:?}", bob.phase);

    // A full tick now waits for finality (it is 18 blocks from the new sighting, not from the first one) and freezes nothing.
    s.world.borrow_mut().advance_noid(17);
    let out = apply(&s, &mut bob, &path);
    assert_eq!(out.decision.action.kind(), "wait", "{:?}", out.decision);
    assert_eq!(bob.phase.name(), "funded");
    no_ledger_trace(&bob);
    s.world.borrow_mut().advance_noid(1);
    let out = apply(&s, &mut bob, &path);
    assert!(matches!(out.decision.action, Action::LockEth { .. }), "{:?}", out.decision);
    assert!(matches!(out.intent, IntentStatus::Recorded(_)));
}

// ------------------------------------------------------------------ the binary

const REAL_CODE_FIXTURE: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/fixtures/eth/locked.json");

/// Chain fixtures for a Bob who has seen the funding final at the recorded tip, as in `tests/cli.rs`: a node with the funded instance and a header,
/// Ethereum with the HTLC code and no lock. Returns `(swap file, noid fixture, eth fixture)`; the file is in phase `funding_final` when `final_phase`
/// and `received` otherwise.
fn cli_setup(dir: &Path, final_phase: bool) -> (std::path::PathBuf, String, String) {
    let b = dir.join(if final_phase { "bob-final.swap.json" } else { "bob-new.swap.json" });
    let public = example_public(&Secret::from_bytes(swap_cli::htlc_harness::seq_bytes(0x33)), Variant::Raw);
    let real_code = {
        let recorded: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(REAL_CODE_FIXTURE).unwrap()).unwrap();
        recorded["calls"].as_array().unwrap().iter().find(|c| c["method"] == "eth_getCode").unwrap()["result"].as_str().unwrap().to_string()
    };
    let mut file = swap_cli::swapfile::example_bob_file(public, 1).unwrap();
    if final_phase {
        let inst = swap_cli::watch::NoidInstance { slot_index: 4242, creation_id: 77001, amount_micronoid: 10_000_000 };
        for e in [Event::NoidInstanceSeen { instance: inst, tip: 300_063 }, Event::NoidFundingFinal { tip: 300_080 }] {
            file.apply(&e, 1).unwrap();
        }
    }
    file.save(&b).unwrap();
    let eth = dir.join("eth.json");
    std::fs::write(
        &eth,
        serde_json::json!({"description": "minimal Ethereum answers: chain 1, the HTLC runtime code, no lock", "calls": [
            {"method": "eth_blockNumber", "result": "0xa"},
            {"method": "eth_getBlockByNumber", "result": {"number": "0xa", "timestamp": "0x3e8"}},
            {"method": "eth_getBlockByNumber", "result": {"number": "0x8", "timestamp": "0x3d0"}},
            {"method": "eth_chainId", "result": "0x1"},
            {"method": "eth_getCode", "result": real_code},
            {"method": "eth_getLogs", "result": []},
            {"method": "eth_call", "error": {"code": 3, "message": "execution reverted: LockNotFound"}}
        ]})
        .to_string(),
    )
    .unwrap();
    let noid = {
        let root = concat!(env!("CARGO_MANIFEST_DIR"), "/fixtures/");
        let mut fx: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(format!("{root}parano1d/funded.json")).unwrap()).unwrap();
        fx["calls"].as_array_mut().unwrap().push(serde_json::json!({"method": "paranoid_getBlockHeader", "result": {"height": 300_100, "timestamp": 990}}));
        let path = dir.join("funded.with-header.json");
        std::fs::write(&path, fx.to_string()).unwrap();
        path.to_str().unwrap().to_string()
    };
    (b, noid, eth.to_str().unwrap().to_string())
}

fn tick_args(b: &Path, noid: &str, eth: &str, extra: &[&str]) -> Vec<String> {
    let mut v: Vec<String> = vec![
        "tick".into(),
        b.to_str().unwrap().into(),
        "--noid-fixture".into(),
        noid.into(),
        "--eth-fixture".into(),
        eth.into(),
        "--now".into(),
        "1000".into(),
        "--single-node-ok".into(),
        "--accept-producer-concentration".into(),
    ];
    v.extend(extra.iter().map(|s| s.to_string()));
    v
}

fn run(args: Vec<String>) -> (bool, String, String) {
    let out = home::isolated_bin().args(args).output().expect("run swap-cli");
    (out.status.success(), String::from_utf8_lossy(&out.stdout).into_owned(), String::from_utf8_lossy(&out.stderr).into_owned())
}

#[test]
fn the_binary_refuses_observe_only_without_apply_and_with_closed_by_and_writes_nothing() {
    let dir = tempfile::tempdir().unwrap();
    let (b, noid, eth) = cli_setup(dir.path(), true);
    let before = std::fs::read(&b).unwrap();
    let (ok, out, err) = run(tick_args(&b, &noid, &eth, &["--observe-only"]));
    assert!(!ok && out.is_empty() && err.contains("--observe-only is a mode of --apply"), "ok={ok} out={out} err={err}");
    let txid = "ab".repeat(32);
    let (ok, out, err) = run(tick_args(&b, &noid, &eth, &["--apply", "--observe-only", "--closed-by", &txid]));
    assert!(!ok && out.is_empty() && err.contains("cannot be combined with --closed-by"), "ok={ok} out={out} err={err}");
    // Placing the flag before the file does not make it swallow the file name.
    let (ok, _, err) = run(vec!["tick".into(), "--observe-only".into(), b.to_str().unwrap().into(), "--noid-fixture".into(), noid.clone(), "--eth-fixture".into(), eth.clone(), "--now".into(), "1000".into()]);
    assert!(!ok && err.contains("--observe-only is a mode of --apply"), "{err}");
    assert_eq!(std::fs::read(&b).unwrap(), before);
}

#[test]
fn the_binary_observes_writes_the_phase_withholds_the_lock_and_a_later_full_apply_records_it() {
    let dir = tempfile::tempdir().unwrap();
    let (b, noid, eth) = cli_setup(dir.path(), true);

    // `funding_final`, the engine's decision is `lock_eth`: the kind only, no parameters, observe_only in the JSON, no intent on file.
    let (ok, out, err) = run(tick_args(&b, &noid, &eth, &["--apply", "--observe-only"]));
    assert!(ok, "{err}");
    let v: serde_json::Value = serde_json::from_str(&out).unwrap();
    assert_eq!(v["observe_only"], true, "{out}");
    assert_eq!(v["action"]["kind"], "lock_eth", "{out}");
    assert_eq!(v["action"]["parameters"], "withheld");
    assert_eq!(v["action"].as_object().unwrap().len(), 3, "kind, parameters, note and nothing else: {}", v["action"]);
    assert!(v["action"]["note"].as_str().unwrap().contains("observe-only tick records no intent"), "{}", v["action"]);
    assert_eq!(v["intent"]["status"], "none");
    assert_eq!(v["action_executed"], false);
    assert!(v["notes"].as_array().unwrap().iter().any(|n| n.as_str().unwrap().starts_with("observe-only:")), "{out}");
    assert!(!out.contains("\"t_reveal\"") && !out.contains("\"amount_wei\"") && !out.contains("\"receiver\""), "{out}");
    let saved = SwapFile::load(&b).unwrap();
    assert!(saved.pending_intent.is_none());
    assert!(saved.history.iter().all(|h| !h.event.starts_with("intent_")));
    assert_eq!(saved.phase.name(), "funding_final");

    // A plain read-only tick and a plain `--apply` keep their own JSON: `observe_only` is false there.
    let (ok, out, err) = run(tick_args(&b, &noid, &eth, &[]));
    assert!(ok, "{err}");
    let v: serde_json::Value = serde_json::from_str(&out).unwrap();
    assert_eq!(v["observe_only"], false);
    assert!(v["action"]["note"].as_str().unwrap().contains("a read-only tick records nothing"), "{}", v["action"]);

    // The full tick records the intent at once and prints the parameters.
    let (ok, out, err) = run(tick_args(&b, &noid, &eth, &["--apply"]));
    assert!(ok, "{err}");
    let v: serde_json::Value = serde_json::from_str(&out).unwrap();
    assert_eq!(v["observe_only"], false);
    assert_eq!(v["action"]["action"], "lock_eth", "{out}");
    assert_eq!(v["intent"]["status"], "recorded");

    // With the intent held, observe-only is refused before any node is asked, and the file is not touched.
    let bytes = std::fs::read(&b).unwrap();
    let (ok, out, err) = run(tick_args(&b, &noid, &eth, &["--apply", "--observe-only"]));
    assert!(!ok && out.is_empty() && err.contains("holds an intent") && err.contains("full `tick --apply`"), "ok={ok} out={out} err={err}");
    assert_eq!(std::fs::read(&b).unwrap(), bytes);
}

#[test]
fn the_binary_moves_a_received_file_to_the_phase_the_observation_shows() {
    let dir = tempfile::tempdir().unwrap();
    let (b, noid, eth) = cli_setup(dir.path(), false);
    assert_eq!(SwapFile::load(&b).unwrap().phase.name(), "received");
    let (ok, out, err) = run(tick_args(&b, &noid, &eth, &["--apply", "--observe-only"]));
    assert!(ok, "{err}");
    let v: serde_json::Value = serde_json::from_str(&out).unwrap();
    assert_eq!(v["events_applied_to_file"], true);
    assert_eq!(v["observe_only"], true);
    assert!(v["events"].as_array().unwrap().iter().any(|e| e["event"] == "noid_instance_seen"), "{out}");
    let after = SwapFile::load(&b).unwrap();
    assert_eq!(v["phase_after"], after.phase.name());
    assert_eq!(after.phase.name(), "funded", "{:?}", after.phase);
    assert!(after.pending_intent.is_none());
    let (ok, out, err) = run(tick_args(&b, &noid, &eth, &[]));
    assert!(ok, "{err}");
    let v: serde_json::Value = serde_json::from_str(&out).unwrap();
    assert!(v["intent"]["status"] == "none", "{out}");
}
