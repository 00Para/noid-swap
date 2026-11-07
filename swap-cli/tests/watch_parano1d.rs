//! M2.4 (Parano1d side): `NoidWatcher` against recorded fixtures only.
//!
//! No test here touches a node or a network. The fixtures in `fixtures/parano1d/` are of two kinds:
//!
//! * RECORDED: the real replies of the owner's Parano1d v2.1.0 node (mainnet), captured 2026-11-04.
//!   `idle` (height 280,517, an unfunded opening) and `recorded_misc` (one-off read-only script, incl. the
//!   error replies) came first; then LIVE RUN 1, the first real swap, left one recording per state
//!   (`recorded_funded_*`, `recorded_claim_*`: each is one `swap-cli tick --record-noid` call). Those use the
//!   run's real 699-byte opening (read from the recordings themselves), instance slot 9,750,400 /
//!   creation id 736,337 / 10,000,000 uNOID, and our claim `d50743e3...1324` (call height 280,658, in the
//!   mempool at 280,657, included at 280,659, final at 280,676).
//! * SYNTHESIZED (`funded`, `pending_claim`, `malformed`): shaped from the type definitions vendored at
//!   `vendor/parano1d/noid_rpc/src/{types,object_types}.rs`. They are kept for what no recording contains:
//!   `funded` drives the `cli.rs` tick test, `pending_claim` has a mempool entry of ANOTHER contract (a
//!   second real opening) next to ours, `malformed` is a negative fixture. Only the opening hex and its root
//!   address are real (built by the code under test); heights, hashes and fees are invented.
//!
//! The drift guard at the bottom re-reads the vendored sources and fails if a fixture key stops being a
//! declared field, if a field the watcher requires disappears, or if a method we call is no longer
//! declared in the `paranoid` RPC namespace.

use std::collections::BTreeSet;
use std::path::{Path, PathBuf};

use serde_json::{json, Value};
use swap_cli::htlc_harness::seq_bytes;
use swap_cli::params;
use swap_cli::secret::{Secret, Variant};
use swap_cli::swapfile::example_public;
use swap_cli::watch::parano1d::NoidWatcher;
use swap_cli::watch::{JsonRpc,
    ConfirmedTx, Fixture, FixtureRpc, NoidInstance, NoidInstanceStatus, NoidObservation, PendingCall, RpcError,
    ScriptedRpc,
};

const FIXTURES: [&str; 10] = [
    "idle",
    "funded",
    "pending_claim",
    "malformed",
    "recorded_funded_unfinal",
    "recorded_funded_final",
    "recorded_funded_first_seen",
    "recorded_claim_pending",
    "recorded_claim_included",
    "recorded_claim_final",
];
/// LIVE RUN 1 recordings: they carry the real opening of the first swap (not the seed-0x33 example).
const LIVE: [&str; 6] = [
    "recorded_funded_unfinal",
    "recorded_funded_final",
    "recorded_funded_first_seen",
    "recorded_claim_pending",
    "recorded_claim_included",
    "recorded_claim_final",
];
/// Recorded from the real node (the rest is synthesized).
const RECORDED: [&str; 8] = [
    "idle",
    "recorded_misc",
    "recorded_funded_unfinal",
    "recorded_funded_final",
    "recorded_funded_first_seen",
    "recorded_claim_pending",
    "recorded_claim_included",
    "recorded_claim_final",
];
// LIVE RUN 1 facts (2026-11-04). Heights: funding included 280,638; claim built for call height 280,658,
// pending at 280,657, included 280,659; finality = tip >= inclusion + 17.
const LIVE_ROOT: &str = "o1qjnr505ua8gg63enxsjq9a4rsvlfg3nkx7zy5pfsdudy9ktuajlq786367";
const LIVE_CLAIM_AUTHORITY: &str = "o1myesz750uxepkx3hfekln7pp7h0f7prn2lu5taswn940g3mws0yqedcswg";
const LIVE_CLAIM_RECIPIENT: &str = "o1xpyc7ar25emv3tyvlphettpw43fec66q2agnd86r3g8fu5x6tg2s8w8q9r";
const LIVE_DEADLINE: u64 = 281_286;
const LIVE_SLOT: u32 = 9_750_400;
const LIVE_CREATION_ID: u64 = 736_337;
const LIVE_AMOUNT: u64 = 10_000_000;
const LIVE_FUNDING_HEIGHT: u64 = 280_638;
const LIVE_CLAIM_HEIGHT: u64 = 280_659;
const LIVE_CLAIM_TXID: &str = "d50743e3ead6c3870ec7e9b1322113a956a034cf6fc259753743ecd49f3e1324";
/// Epoch anchors of the run: the 144-block epoch rotated at 280,656 (= 1,949 * 144).
const LIVE_ANCHOR_BEFORE: &str = "5339dc8eeeb085b5b86a1d22adf5550fd6c4c834a6ed401ae7a4621506943ae1";
const LIVE_ANCHOR_AFTER: &str = "28931e56442916500aa93d58394a7d024aee9afeae746d32bd176b8099d7a02d";
/// What `idle.json` recorded: the real tip, relay floor, estimate and epoch anchor at capture time.
const IDLE_TIP: u64 = 280_517;
const IDLE_ANCHOR_HEX: &str = "5339dc8eeeb085b5b86a1d22adf5550fd6c4c834a6ed401ae7a4621506943ae1";
const ANCHOR_HEX: &str = "484a5297d36a889310afee7ffa2c52a7ebdb94631b43a534d6ffbbb0d4d0987d";
const CLAIM_AUTHORITY: &str = "o1u84ctv65ejndntjprj0fv4350l2h59wdj8gsx7553vare499mmksk6kf5s";
const OURS_TXID: &str = "27d5ff31f695faebec1977999e9677c742a68f802961c58a4ddc15801a764a10";
const OTHER_TXID: &str = "81634183ab42a8e9661ea98b0055aa4f3a4c6ee7a3bba581c6093c6f412a7740";
const BIG_TXID: &str = "9e8ba49345176079b28bfc509453ada06dee3a7f1045fd15b79a976edc38366c";
const ORDINARY_TXID: &str = "cd132fd192f68217219adf5a9a9449c32a9c7ea8d36310823ce3a8fdfdcd7069";
const MULTI_TXID: &str = "c6da8aecb746336cc0000572671508dfc9c4d6361c8396052e3de155db5de216";
const CLAIM_TXID: &str = "f3acb3cb78fd2703bea357f556a22c895c2d97e95f7adf37de96522a33f37d39";

fn fixture_path(name: &str) -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("fixtures/parano1d").join(format!("{name}.json"))
}

fn load(name: &str) -> Fixture {
    let text = std::fs::read_to_string(fixture_path(name)).expect("fixture file");
    serde_json::from_str(&text).expect("fixture parses")
}

fn opening_of(seed: u8) -> (String, String) {
    let p = example_public(&Secret::from_bytes(seq_bytes(seed)), Variant::Raw);
    (p.opening_hex, p.contract_root)
}

/// The real 699-byte opening of LIVE RUN 1, hex: read from the params the recordings pinned.
fn live_opening() -> String {
    let fx = load("recorded_funded_final");
    let c = fx.calls.iter().find(|c| c.method == "paranoid_getObjectInstances").unwrap();
    c.params.as_ref().unwrap()[0].as_str().unwrap().to_string()
}

/// The opening the fixture `name` was recorded or shaped for.
fn opening_for(name: &str) -> String {
    if LIVE.contains(&name) {
        live_opening()
    } else {
        opening_of(0x33).0
    }
}

/// The watcher stamps `observed_at` from its clock; the tests pin it so observations compare equal.
const OBSERVED_AT: u64 = 1_794_312_000;

fn pinned_clock() -> u64 {
    OBSERVED_AT
}

fn watcher(name: &str) -> NoidWatcher<FixtureRpc> {
    NoidWatcher::new(FixtureRpc::from_file(&fixture_path(name)).expect("fixture"), opening_for(name)).with_clock(pinned_clock)
}

fn watcher_mutated(name: &str, method: &str, f: impl Fn(&mut Value)) -> NoidWatcher<FixtureRpc> {
    let mut fx = load(name);
    for c in fx.calls.iter_mut().filter(|c| c.method == method) {
        if let Some(r) = c.result.as_mut() {
            f(r);
        }
    }
    NoidWatcher::new(FixtureRpc::from_fixture(name, fx), opening_for(name)).with_clock(pinned_clock)
}

fn methods(w: &NoidWatcher<FixtureRpc>) -> Vec<String> {
    // `getBlockHeader` (REVIEW-2 F5, the tip time) is asked last on every poll and has its own tests below; the older
    // sequence assertions are about the calls that decide the observation.
    w.rpc.calls_made().into_iter().map(|(m, _)| m.trim_start_matches("paranoid_").to_string()).filter(|m| m != "getBlockHeader").collect()
}

/// Every method asked, `getBlockHeader` included.
fn all_methods(w: &NoidWatcher<FixtureRpc>) -> Vec<String> {
    w.rpc.calls_made().into_iter().map(|(m, _)| m.trim_start_matches("paranoid_").to_string()).collect()
}

fn entry_lookups(w: &NoidWatcher<FixtureRpc>) -> Vec<String> {
    w.rpc
        .calls_made()
        .into_iter()
        .filter(|(m, _)| m == "paranoid_getMempoolEntry")
        .map(|(_, p)| p[0].as_str().unwrap().to_string())
        .collect()
}

fn anchor() -> Option<[u8; 32]> {
    Some(hex::decode(ANCHOR_HEX).unwrap().try_into().unwrap())
}

fn idle_base() -> NoidObservation {
    NoidObservation {
        observed_at: Some(OBSERVED_AT),
        tip: IDLE_TIP,
        next_call_height: IDLE_TIP + 1,
        epoch_anchor: Some(hex::decode(IDLE_ANCHOR_HEX).unwrap().try_into().unwrap()),
        fee_floor: Some(5000),
        fee_estimate_1_1: Some(5800),
        relay_floor: Some(5000),
        ..Default::default()
    }
}

fn base(tip: u64, floor: u64) -> NoidObservation {
    NoidObservation {
        observed_at: Some(OBSERVED_AT),
        tip,
        next_call_height: tip + 1,
        epoch_anchor: anchor(),
        fee_floor: Some(floor),
        fee_estimate_1_1: Some(floor.max(5800)),
        relay_floor: Some(floor),
        ..Default::default()
    }
}

fn is_decode(r: Result<NoidObservation, RpcError>, method: &str) {
    match r {
        Err(RpcError::Decode(m)) => assert!(m.contains(method), "{m}"),
        other => panic!("expected Decode({method}), got {other:?}"),
    }
}

#[test]
fn fixture_openings_are_what_the_code_builds() {
    let (open, root) = opening_of(0x33);
    let (other, other_root) = opening_of(0x44);
    assert_ne!(open, other);
    assert_eq!(open.len(), 699 * 2);
    let fx = load("idle");
    let inst = fx.calls.iter().find(|c| c.method == "paranoid_getObjectInstances").unwrap();
    assert_eq!(inst.params, Some(json!([open, 0, 16])));
    assert_eq!(inst.result.as_ref().unwrap()["address"], json!(root));
    let st = load("funded");
    let st = st.calls.iter().find(|c| c.method == "paranoid_getObjectStatus").unwrap();
    let obj = &st.result.as_ref().unwrap()["object"];
    assert_eq!(obj["opening_hex"], json!(open));
    assert_eq!(obj["claim_authority"], json!(CLAIM_AUTHORITY));
    assert_eq!(obj["deadline_height"], json!(300_735));
    // The "other contract" entry in pending_claim carries the other real opening.
    let pc = load("pending_claim");
    let others: Vec<_> = pc
        .calls
        .iter()
        .filter(|c| c.method == "paranoid_getMempoolEntry")
        .map(|c| c.result.as_ref().unwrap()["contract_opening_hex"].as_str().unwrap().to_string())
        .collect();
    assert_eq!(others, vec![other, open]);
    assert_ne!(root, other_root);
}

#[test]
fn idle_has_no_instance_and_asks_no_status() {
    let w = watcher("idle");
    let obs = w.observe(None).unwrap();
    // The REAL idle state: relay floor 5000 (below the 5800 formula minimum), no instance, empty mempool.
    assert_eq!(obs, idle_base());
    assert_eq!(
        methods(&w),
        [
            "blockCount",
            "getEpochAnchor",
            "estimateFeeDetailed",
            "getMempoolStats",
            "getObjectInstances",
            "getMempoolInfo"
        ]
    );
    let calls = w.rpc.calls_made();
    assert_eq!(calls[2].1, json!([1, 1]));
    assert_eq!(calls[4].1, json!([opening_of(0x33).0, 0, 16]));
    // A second poll on the exhausted queue repeats the last answers.
    assert_eq!(w.observe(None).unwrap(), obs);
}

#[test]
fn funded_reports_instance_and_status() {
    let w = watcher("funded");
    let obs = w.observe(None).unwrap();
    assert_eq!(
        obs,
        NoidObservation {
            instance: Some(NoidInstance { slot_index: 4242, creation_id: 77_001, amount_micronoid: 10_000_000 }),
            instance_matches_opening: Some(true),
            active_authority: Some(CLAIM_AUTHORITY.to_string()),
            // REVIEW-2 F10: the list holds the same single instance, with its own status.
            instances: vec![NoidInstanceStatus {
                instance: NoidInstance { slot_index: 4242, creation_id: 77_001, amount_micronoid: 10_000_000 },
                matches_opening: Some(true),
                active_authority: Some(CLAIM_AUTHORITY.to_string()),
            }],
            instance_count: 1,
            ..base(300_100, 5800)
        }
    );
    assert!(obs.pending_calls.is_empty() && obs.confirmed_tx.is_none() && obs.tracked_tx_pending.is_none());
    assert_eq!(
        methods(&w),
        [
            "blockCount",
            "getEpochAnchor",
            "estimateFeeDetailed",
            "getMempoolStats",
            "getObjectInstances",
            "getObjectStatus",
            "getMempoolInfo",
            "getMempoolEntry"
        ]
    );
    let status_call = w.rpc.calls_made().into_iter().find(|(m, _)| m == "paranoid_getObjectStatus").unwrap();
    assert_eq!(status_call.1, json!([opening_of(0x33).0, 4242]));
    // Only the single-page tx is looked up; the 2-page tx never is.
    assert_eq!(entry_lookups(&w), [ORDINARY_TXID]);
    assert!(!entry_lookups(&w).contains(&MULTI_TXID.to_string()));
}

#[test]
fn relay_floor_comes_from_the_estimate_breakdown_and_is_none_without_one() {
    // The recordings carry `breakdown.relay_floor`: it is parsed as is.
    assert_eq!(watcher("idle").observe(None).unwrap().relay_floor, Some(5000));
    assert_eq!(watcher("pending_claim").observe(None).unwrap().relay_floor, Some(6400));
    // An answer with no breakdown at all, or a breakdown without the field: None, and nothing else changes.
    let plain = watcher("funded").observe(None).unwrap();
    let no_breakdown = watcher_mutated("funded", "paranoid_estimateFeeDetailed", |r| {
        r.as_object_mut().unwrap().remove("breakdown");
    })
    .observe(None)
    .unwrap();
    assert_eq!(no_breakdown, NoidObservation { relay_floor: None, ..plain.clone() });
    let no_field = watcher_mutated("funded", "paranoid_estimateFeeDetailed", |r| {
        r["breakdown"].as_object_mut().unwrap().remove("relay_floor");
    })
    .observe(None)
    .unwrap();
    assert_eq!(no_field, no_breakdown);
    // The relay floor is the breakdown's own number, not the mempool's `fee_floor`.
    let apart = watcher_mutated("funded", "paranoid_estimateFeeDetailed", |r| {
        r["breakdown"]["relay_floor"] = json!(61_000);
    })
    .observe(None)
    .unwrap();
    assert_eq!((apart.relay_floor, apart.fee_floor, apart.fee_estimate_1_1), (Some(61_000), plain.fee_floor, plain.fee_estimate_1_1));
}

#[test]
fn pending_claim_keeps_only_entries_with_our_opening() {
    let w = watcher("pending_claim");
    let obs = w.observe(None).unwrap();
    assert_eq!(
        obs,
        NoidObservation {
            instance: Some(NoidInstance { slot_index: 4242, creation_id: 77_001, amount_micronoid: 10_000_000 }),
            instance_matches_opening: Some(true),
            active_authority: Some(CLAIM_AUTHORITY.to_string()),
            // REVIEW-2 F10: the list holds the same single instance, with its own status.
            instances: vec![NoidInstanceStatus {
                instance: NoidInstance { slot_index: 4242, creation_id: 77_001, amount_micronoid: 10_000_000 },
                matches_opening: Some(true),
                active_authority: Some(CLAIM_AUTHORITY.to_string()),
            }],
            instance_count: 1,
            pending_calls: vec![PendingCall {
                txid: OURS_TXID.to_string(),
                fee_micronoid: 6400,
                admitted_height: 300_099
            }],
            ..base(300_100, 6400)
        }
    );
    // The relay floor (6400) beats the 5800 formula minimum.
    assert_eq!((obs.fee_floor, obs.fee_estimate_1_1), (Some(6400), Some(6400)));
    // Single-page txs only: the other contract's tx is looked up and excluded, the 4-page tx is never looked up.
    assert_eq!(entry_lookups(&w), [OTHER_TXID, OURS_TXID]);
    assert!(!entry_lookups(&w).contains(&BIG_TXID.to_string()));
    assert_eq!(methods(&w).iter().filter(|m| *m == "getObjectStatus").count(), 1);
}

#[test]
fn tracked_txid_is_looked_up_even_when_not_in_the_scan() {
    // idle fixture has an empty mempool: the tracked lookup must call getMempoolEntry itself.
    let mut fx = load("idle");
    fx.calls.push(serde_json::from_value(json!({"method": "paranoid_getTx", "result": null})).unwrap());
    fx.calls.push(serde_json::from_value(json!({"method": "paranoid_getMempoolEntry", "result": null})).unwrap());
    let w = NoidWatcher::new(FixtureRpc::from_fixture("idle+tracked", fx), opening_of(0x33).0);
    let obs = w.observe(Some(&CLAIM_TXID.to_uppercase())).unwrap();
    assert_eq!((obs.confirmed_tx, obs.tracked_tx_pending), (None, Some(false)));
    assert_eq!(entry_lookups(&w), [CLAIM_TXID.to_uppercase()]);
}

#[test]
fn malformed_fixture_is_a_decode_error() {
    let w = watcher("malformed");
    is_decode(w.observe(None), "paranoid_getObjectInstances");
}

#[test]
fn shape_mismatches_are_decode_errors_naming_the_method() {
    let idle = |m: &str, f: &dyn Fn(&mut Value)| watcher_mutated("idle", m, f).observe(None);
    is_decode(idle("paranoid_blockCount", &|v| *v = json!("tall")), "paranoid_blockCount");
    is_decode(idle("paranoid_blockCount", &|v| *v = json!(-1)), "paranoid_blockCount");
    is_decode(idle("paranoid_blockCount", &|v| *v = json!(u64::MAX)), "paranoid_blockCount");
    is_decode(idle("paranoid_getEpochAnchor", &|v| *v = json!("abcd")), "paranoid_getEpochAnchor");
    is_decode(idle("paranoid_getEpochAnchor", &|v| *v = json!("zz".repeat(32))), "paranoid_getEpochAnchor");
    is_decode(idle("paranoid_getEpochAnchor", &|v| *v = json!(7)), "paranoid_getEpochAnchor");
    is_decode(
        idle("paranoid_estimateFeeDetailed", &|v| {
            v.as_object_mut().unwrap().remove("fee_micronoid");
        }),
        "paranoid_estimateFeeDetailed",
    );
    is_decode(idle("paranoid_getMempoolStats", &|v| v["fee_floor"] = json!("high")), "paranoid_getMempoolStats");
    is_decode(idle("paranoid_getMempoolInfo", &|v| v["txs"] = json!({})), "paranoid_getMempoolInfo");
    is_decode(idle("paranoid_getObjectInstances", &|v| *v = Value::Null), "paranoid_getObjectInstances");
    let funded = |m: &str, f: &dyn Fn(&mut Value)| watcher_mutated("recorded_funded_unfinal", m, f).observe(None);
    is_decode(
        funded("paranoid_getObjectStatus", &|v| {
            v.as_object_mut().unwrap().remove("matches_opening");
        }),
        "paranoid_getObjectStatus",
    );
    is_decode(funded("paranoid_getObjectStatus", &|v| *v = Value::Null), "paranoid_getObjectStatus");
    is_decode(funded("paranoid_getMempoolEntry", &|v| *v = json!([1, 2])), "paranoid_getMempoolEntry");
    let tracked = watcher_mutated("recorded_claim_included", "paranoid_getTx", |v| *v = json!({"tx_hash": "ab"}));
    is_decode(tracked.observe(Some(LIVE_CLAIM_TXID)), "paranoid_getTx");
}

// ------------------------------------------------------------------ LIVE RUN 1 (real recordings)

fn live_anchor(hex: &str) -> Option<[u8; 32]> {
    Some(hex::decode(hex).unwrap().try_into().unwrap())
}

/// Fee floor 5000 and estimate 5800 held for the whole run; only the epoch anchor changed (at 280,656).
fn live_base(tip: u64, anchor: &str) -> NoidObservation {
    NoidObservation {
        observed_at: Some(OBSERVED_AT),
        tip,
        next_call_height: tip + 1,
        epoch_anchor: live_anchor(anchor),
        fee_floor: Some(5000),
        fee_estimate_1_1: Some(5800),
        relay_floor: Some(5000),
        ..Default::default()
    }
}

fn live_instance() -> NoidInstance {
    NoidInstance { slot_index: LIVE_SLOT, creation_id: LIVE_CREATION_ID, amount_micronoid: LIVE_AMOUNT }
}

/// The funded, unspent contract: ours, claim side active.
fn live_funded(tip: u64, anchor: &str) -> NoidObservation {
    NoidObservation {
        instance: Some(live_instance()),
        instance_matches_opening: Some(true),
        active_authority: Some(LIVE_CLAIM_AUTHORITY.to_string()),
        instances: vec![NoidInstanceStatus {
            instance: live_instance(),
            matches_opening: Some(true),
            active_authority: Some(LIVE_CLAIM_AUTHORITY.to_string()),
        }],
        instance_count: 1,
        ..live_base(tip, anchor)
    }
}

fn recorded(name: &str, method: &str) -> Value {
    let fx = load(name);
    let c = fx.calls.iter().find(|c| c.method == method).unwrap_or_else(|| panic!("{name} has no {method}"));
    c.result.clone().unwrap()
}

/// The txids the node listed with `page_count == 1` in the recording's `getMempoolInfo`, and how many it listed otherwise.
fn single_page_txids(name: &str) -> (Vec<String>, usize) {
    let info = recorded(name, "paranoid_getMempoolInfo");
    let txs = info["txs"].as_array().unwrap();
    let single: Vec<String> =
        txs.iter().filter(|t| t["page_count"] == json!(1)).map(|t| t["tx_hash"].as_str().unwrap().to_string()).collect();
    let other = txs.len() - single.len();
    (single, other)
}

#[test]
fn live_opening_is_the_699_byte_contract_the_recordings_describe() {
    let open = live_opening();
    assert_eq!(open.len(), 699 * 2);
    assert_ne!(open, opening_of(0x33).0, "the live run is not the seed-0x33 example");
    for name in LIVE {
        let fx = load(name);
        for c in fx.calls.iter().filter(|c| c.method == "paranoid_getObjectInstances" || c.method == "paranoid_getObjectStatus") {
            assert_eq!(c.params.as_ref().unwrap()[0], json!(open), "{name}/{}", c.method);
        }
        assert_eq!(recorded(name, "paranoid_getObjectInstances")["address"], json!(LIVE_ROOT), "{name}");
    }
    // The node's own description of the object it matched against our opening.
    let st = recorded("recorded_funded_final", "paranoid_getObjectStatus");
    assert_eq!(st["matches_opening"], json!(true));
    assert_eq!(st["active_authority"], json!(LIVE_CLAIM_AUTHORITY));
    assert_eq!(st["slot"]["slot_index"], json!(LIVE_SLOT));
    assert_eq!(st["slot"]["creation_id"], json!(LIVE_CREATION_ID));
    assert_eq!(st["slot"]["value"], json!(LIVE_AMOUNT));
    assert_eq!(st["slot"]["owner"], json!(LIVE_ROOT));
    let obj = &st["object"];
    assert_eq!(obj["opening_hex"], json!(open));
    assert_eq!(obj["address"], json!(LIVE_ROOT));
    assert_eq!(obj["claim_authority"], json!(LIVE_CLAIM_AUTHORITY));
    assert_eq!(obj["claim_recipient"], json!(LIVE_CLAIM_RECIPIENT));
    assert_eq!(obj["deadline_height"], json!(LIVE_DEADLINE));
    assert_eq!(obj["max_fee_micronoid"], json!(50_000));
    // Close-only HashTimeLock: the claim side may close, not continue.
    assert_eq!((obj["claim_can_close"].as_bool(), obj["claim_can_continue"].as_bool()), (Some(true), Some(false)));
    // Claim branch while `next_call_height < deadline`; the whole run stayed far below 281,286.
    assert!(st["next_call_height"].as_u64().unwrap() < LIVE_DEADLINE);
}

#[test]
fn live_funded_unfinal_instance_is_ours_and_not_yet_final() {
    let w = watcher("recorded_funded_unfinal");
    let obs = w.observe(None).unwrap();
    assert_eq!(obs, live_funded(280_644, LIVE_ANCHOR_BEFORE));
    assert!(obs.pending_calls.is_empty() && obs.confirmed_tx.is_none() && obs.tracked_tx_pending.is_none());
    // Finality is the only thing the engine reads from the tip here: included at 280,638, final at tip >= 280,655.
    assert!(!params::noid_final(obs.tip, LIVE_FUNDING_HEIGHT));
    assert_eq!(
        methods(&w),
        [
            "blockCount",
            "getEpochAnchor",
            "estimateFeeDetailed",
            "getMempoolStats",
            "getObjectInstances",
            "getObjectStatus",
            "getMempoolInfo",
            "getMempoolEntry"
        ]
    );
    let status_call = w.rpc.calls_made().into_iter().find(|(m, _)| m == "paranoid_getObjectStatus").unwrap();
    assert_eq!(status_call.1, json!([live_opening(), LIVE_SLOT]));
    // The one unrelated single-page payment was looked up and carries no opening (`null`), so it is not a call of ours.
    let (single, _) = single_page_txids("recorded_funded_unfinal");
    assert_eq!(single.len(), 1);
    assert_eq!(entry_lookups(&w), single);
    assert_eq!(recorded("recorded_funded_unfinal", "paranoid_getMempoolEntry")["contract_opening_hex"], Value::Null);
}

#[test]
fn live_funded_final_at_exactly_17_blocks_after_inclusion() {
    let w = watcher("recorded_funded_final");
    let obs = w.observe(None).unwrap();
    assert_eq!(obs, live_funded(280_655, LIVE_ANCHOR_BEFORE));
    // 280,638 + 17 = 280,655: this tick is the first final one; one block earlier is not.
    assert!(params::noid_final(obs.tip, LIVE_FUNDING_HEIGHT));
    assert!(!params::noid_final(obs.tip - 1, LIVE_FUNDING_HEIGHT));
    // Empty mempool: no entry lookups at all, but the status of the instance is still asked.
    assert_eq!(
        methods(&w),
        [
            "blockCount",
            "getEpochAnchor",
            "estimateFeeDetailed",
            "getMempoolStats",
            "getObjectInstances",
            "getObjectStatus",
            "getMempoolInfo"
        ]
    );
    // A second poll on the exhausted queue repeats the same answers.
    assert_eq!(w.observe(None).unwrap(), obs);
}

#[test]
fn live_funded_first_seen_shows_the_node_answers_are_not_one_snapshot() {
    let w = watcher("recorded_funded_first_seen");
    let obs = w.observe(None).unwrap();
    // `blockCount` still said 280,637, yet the instance (included at 280,638) is already listed.
    // The watcher raises `tip` to the page's height, so `seen_at_tip` is never below the inclusion
    // height and funding finality is not declared a block early (fix after LIVE RUN 1).
    let inst = recorded("recorded_funded_first_seen", "paranoid_getObjectInstances");
    assert_eq!(recorded("recorded_funded_first_seen", "paranoid_blockCount"), json!(280_637));
    assert_eq!(inst["height"], json!(LIVE_FUNDING_HEIGHT));
    assert_eq!(obs, live_funded(LIVE_FUNDING_HEIGHT, LIVE_ANCHOR_BEFORE));
    assert_eq!(inst["height"].as_u64().unwrap(), obs.tip);
    let st = recorded("recorded_funded_first_seen", "paranoid_getObjectStatus");
    assert_eq!(st["next_call_height"].as_u64().unwrap(), obs.next_call_height);
    assert_eq!(st["tip_height"], json!(LIVE_FUNDING_HEIGHT));
    // Only multi-page / zero-page transactions were in the mempool: nothing is looked up.
    assert!(entry_lookups(&w).is_empty());
    let (single, other) = single_page_txids("recorded_funded_first_seen");
    assert!(single.is_empty() && other > 0);
}

#[test]
fn live_claim_pending_is_seen_in_the_mempool_with_our_opening() {
    let w = watcher("recorded_claim_pending");
    let obs = w.observe(Some(LIVE_CLAIM_TXID)).unwrap();
    assert_eq!(
        obs,
        NoidObservation {
            pending_calls: vec![PendingCall {
                txid: LIVE_CLAIM_TXID.to_string(),
                fee_micronoid: 5800,
                admitted_height: 280_657
            }],
            confirmed_tx: None,
            tracked_tx_pending: Some(true),
            ..live_funded(280_657, LIVE_ANCHOR_AFTER)
        }
    );
    // The node's own view of the same instant: claim branch, call height 280,658 (the height the claim was proved for).
    let st = recorded("recorded_claim_pending", "paranoid_getObjectStatus");
    assert_eq!(st["next_call_height"].as_u64().unwrap(), 280_658);
    assert_eq!(st["next_call_height"].as_u64().unwrap(), obs.next_call_height);
    // Single-page entries only are looked up (our claim first, as listed), the multi-page and zero-page ones never.
    let (single, other) = single_page_txids("recorded_claim_pending");
    assert_eq!(single.len(), 3);
    assert!(other >= 4, "the recording must contain entries the scan skips ({other})");
    assert_eq!(entry_lookups(&w), single);
    assert_eq!(single[0], LIVE_CLAIM_TXID);
    // The scan already looked the tracked txid up: no second getMempoolEntry for it, one getTx (still unknown: null).
    let get_tx: Vec<_> = w.rpc.calls_made().into_iter().filter(|(m, _)| m == "paranoid_getTx").collect();
    assert_eq!(get_tx.len(), 1);
    assert_eq!(get_tx[0].1, json!([LIVE_CLAIM_TXID]));
    assert_eq!(recorded("recorded_claim_pending", "paranoid_getTx"), Value::Null);
    // The pending entry carries our whole opening; the other two entries carry none (`null`).
    let entry = fx_entry("recorded_claim_pending", LIVE_CLAIM_TXID);
    assert_eq!(entry["contract_opening_hex"], json!(live_opening()));
    assert_eq!(entry["fee_micronoid"], json!(5800));
    // Without a tracked txid the same call is still reported, and getTx is never asked.
    let w = watcher("recorded_claim_pending");
    let untracked = w.observe(None).unwrap();
    assert_eq!(untracked.pending_calls, obs.pending_calls);
    assert_eq!((untracked.confirmed_tx, untracked.tracked_tx_pending), (None, None));
    assert!(!methods(&w).contains(&"getTx".to_string()));
}

/// The recorded `getMempoolEntry` answer for `txid`.
fn fx_entry(name: &str, txid: &str) -> Value {
    let fx = load(name);
    fx.calls
        .iter()
        .find(|c| c.method == "paranoid_getMempoolEntry" && c.params == Some(json!([txid])))
        .unwrap_or_else(|| panic!("{name}: no getMempoolEntry for {txid}"))
        .result
        .clone()
        .unwrap()
}

#[test]
fn live_claim_included_not_final_instance_gone() {
    let w = watcher("recorded_claim_included");
    let obs = w.observe(Some(LIVE_CLAIM_TXID)).unwrap();
    assert_eq!(
        obs,
        NoidObservation {
            confirmed_tx: Some(ConfirmedTx { txid: LIVE_CLAIM_TXID.to_string(), height: LIVE_CLAIM_HEIGHT }),
            tracked_tx_pending: Some(false),
            ..live_base(280_662, LIVE_ANCHOR_AFTER)
        }
    );
    // Spent: no instance, so no status call; empty mempool: the only lookup is the tracked txid (answers null).
    assert!(obs.instance.is_none() && obs.instance_matches_opening.is_none() && obs.active_authority.is_none());
    assert_eq!(
        methods(&w),
        [
            "blockCount",
            "getEpochAnchor",
            "estimateFeeDetailed",
            "getMempoolStats",
            "getObjectInstances",
            "getMempoolInfo",
            "getTx",
            "getMempoolEntry"
        ]
    );
    assert_eq!(entry_lookups(&w), [LIVE_CLAIM_TXID]);
    // The claim proved for call height 280,658 was included at 280,659 (block 59eefd12...4928, position 1).
    let tx = recorded("recorded_claim_included", "paranoid_getTx");
    assert_eq!(tx["height"], json!(LIVE_CLAIM_HEIGHT));
    assert_eq!(tx["tx_position"], json!(1));
    assert_eq!(tx["tx_hash"], json!(LIVE_CLAIM_TXID));
    let block_hash = tx["block_hash"].as_str().unwrap();
    assert!(block_hash.starts_with("59eefd12") && block_hash.ends_with("4928"), "{block_hash}");
    // Final only at tip >= 280,659 + 17 = 280,676; tip 280,662 is not.
    assert!(!params::noid_final(obs.tip, LIVE_CLAIM_HEIGHT));
    assert!(!params::noid_final(280_675, LIVE_CLAIM_HEIGHT) && params::noid_final(280_676, LIVE_CLAIM_HEIGHT));
}

#[test]
fn live_claim_final_the_instance_stays_gone_and_nothing_is_ours_in_a_busy_mempool() {
    let w = watcher("recorded_claim_final");
    // This tick did not track a txid (no getTx recorded): asking for one would be a fixture gap, not a guess.
    let obs = w.observe(None).unwrap();
    assert_eq!(obs, live_base(280_676, LIVE_ANCHOR_AFTER));
    assert!(params::noid_final(obs.tip, LIVE_CLAIM_HEIGHT));
    assert!(!params::noid_final(obs.tip - 1, LIVE_CLAIM_HEIGHT));
    assert_eq!(obs.tip, LIVE_CLAIM_HEIGHT + 17);
    // 22 entries listed; every single-page one was looked up and none carries our opening.
    let (single, other) = single_page_txids("recorded_claim_final");
    assert_eq!((single.len(), other), (19, 3));
    assert_eq!(entry_lookups(&w), single);
    assert!(!methods(&w).contains(&"getObjectStatus".to_string()));
    assert!(!methods(&w).contains(&"getTx".to_string()));
}

#[test]
fn live_run_replays_in_order_from_funding_to_final_claim() {
    // One watcher, five consecutive polls over the five recordings (FIFO per method, request params pinned).
    let mut calls = Vec::new();
    for n in [
        "recorded_funded_unfinal",
        "recorded_funded_final",
        "recorded_claim_pending",
        "recorded_claim_included",
        "recorded_claim_final",
    ] {
        calls.extend(load(n).calls);
    }
    let w = NoidWatcher::new(
        FixtureRpc::from_fixture("live-run-1", Fixture { description: String::new(), calls }),
        live_opening(),
    )
    .with_clock(pinned_clock);
    let p1 = w.observe(None).unwrap();
    let p2 = w.observe(None).unwrap();
    let p3 = w.observe(Some(LIVE_CLAIM_TXID)).unwrap();
    let p4 = w.observe(Some(LIVE_CLAIM_TXID)).unwrap();
    let p5 = w.observe(None).unwrap();

    // Each poll equals what the single recording gives on its own.
    for (obs, name, tracked) in [
        (&p1, "recorded_funded_unfinal", None),
        (&p2, "recorded_funded_final", None),
        (&p3, "recorded_claim_pending", Some(LIVE_CLAIM_TXID)),
        (&p4, "recorded_claim_included", Some(LIVE_CLAIM_TXID)),
        (&p5, "recorded_claim_final", None),
    ] {
        assert_eq!(*obs, watcher(name).observe(tracked).unwrap(), "{name}");
    }
    // Every recorded answer was consumed exactly once: nothing queued is left over and nothing was repeated.
    for m in [
        "paranoid_getObjectStatus",
        "paranoid_getTx",
        "paranoid_getMempoolEntry",
        "paranoid_getMempoolInfo",
        "paranoid_blockCount",
    ] {
        assert_eq!(w.rpc.remaining(m), 0, "{m}");
    }

    // The engine's finality arithmetic over the run (tip >= inclusion + 17).
    assert!(!params::noid_final(p1.tip, LIVE_FUNDING_HEIGHT));
    assert!(params::noid_final(p2.tip, LIVE_FUNDING_HEIGHT));
    assert!(p2.instance.is_some() && p3.instance.is_some() && p4.instance.is_none() && p5.instance.is_none());
    assert_eq!(p3.pending_calls.len(), 1);
    assert_eq!(p3.tracked_tx_pending, Some(true));
    let included = p4.confirmed_tx.clone().unwrap();
    assert_eq!((included.txid.as_str(), included.height), (LIVE_CLAIM_TXID, LIVE_CLAIM_HEIGHT));
    assert!(!params::noid_final(p4.tip, included.height));
    assert!(params::noid_final(p5.tip, included.height));
    // The epoch anchor rotated between the funded polls and the claim polls (every 144 blocks).
    assert_ne!(p2.epoch_anchor, p3.epoch_anchor);
    assert_eq!(p3.epoch_anchor, p5.epoch_anchor);
}

#[test]
fn live_claim_is_matched_by_opening_not_by_txid_and_other_contracts_are_ignored() {
    let open = live_opening();
    // Case and 0x are ignored; the reported txid is lower-cased.
    let w = watcher_mutated("recorded_claim_pending", "paranoid_getMempoolEntry", |v| {
        if v["contract_opening_hex"] == json!(open) {
            v["contract_opening_hex"] = json!(format!("0x{}", open.to_uppercase()));
            v["tx_hash"] = json!(LIVE_CLAIM_TXID.to_uppercase());
        }
    });
    let obs = w.observe(Some(LIVE_CLAIM_TXID)).unwrap();
    assert_eq!(obs.pending_calls.len(), 1);
    assert_eq!(obs.pending_calls[0].txid, LIVE_CLAIM_TXID);
    assert_eq!(obs.tracked_tx_pending, Some(true));
    // The very same mempool entry, but for ANOTHER contract's opening: not our pending call. The tracked txid
    // is still reported as pending (it IS in the mempool), which is what the engine needs to hold.
    let other = opening_of(0x44).0;
    let w = watcher_mutated("recorded_claim_pending", "paranoid_getMempoolEntry", |v| {
        if v["contract_opening_hex"] == json!(open) {
            v["contract_opening_hex"] = json!(other);
        }
    });
    let obs = w.observe(Some(LIVE_CLAIM_TXID)).unwrap();
    assert!(obs.pending_calls.is_empty());
    assert_eq!(obs.tracked_tx_pending, Some(true));
}


#[test]
fn opening_match_ignores_case_and_0x_and_txids_are_lowercased() {
    let (open, _) = opening_of(0x33);
    let w = watcher_mutated("pending_claim", "paranoid_getMempoolEntry", |v| {
        if v["contract_opening_hex"] == json!(open) {
            v["contract_opening_hex"] = json!(format!("0x{}", open.to_uppercase()));
            v["tx_hash"] = json!(OURS_TXID.to_uppercase());
        }
    });
    let obs = w.observe(None).unwrap();
    assert_eq!(obs.pending_calls.len(), 1);
    assert_eq!(obs.pending_calls[0].txid, OURS_TXID);
}

#[test]
fn node_errors_and_fixture_gaps_propagate_unchanged() {
    let remote = ScriptedRpc(|m: &str, _p: &Value| match m {
        "paranoid_blockCount" => Ok(json!(10)),
        _ => Err(RpcError::Remote { code: -32000, message: "busy".into() }),
    });
    let w = NoidWatcher::new(remote, opening_of(0x33).0);
    assert_eq!(w.observe(None), Err(RpcError::Remote { code: -32000, message: "busy".into() }));
    // A rpc with no recorded responses is a Fixture error, not a panic.
    let empty = NoidWatcher::new(FixtureRpc::from_results("empty", vec![]), "00".into());
    assert!(matches!(empty.observe(None), Err(RpcError::Fixture(_))));
    // A different opening than the fixture pinned is also reported, not papered over.
    let wrong = NoidWatcher::new(
        FixtureRpc::from_file(&fixture_path("idle")).unwrap(),
        opening_of(0x44).0,
    );
    assert!(matches!(wrong.observe(None), Err(RpcError::Fixture(_))));
}

/// `idle` plus one recorded answer to `getBlockHeader` (REVIEW-2 F5), as the real method would give it.
fn idle_with_header(answer: Value) -> NoidWatcher<FixtureRpc> {
    let mut fx = load("idle");
    fx.calls.push(serde_json::from_value(json!({"method": "paranoid_getBlockHeader", "result": answer})).unwrap());
    NoidWatcher::new(FixtureRpc::from_fixture("idle+header", fx), opening_of(0x33).0).with_clock(pinned_clock)
}

#[test]
fn tip_time_is_the_timestamp_of_the_tip_block_header() {
    let w = idle_with_header(json!({
        "height": IDLE_TIP, "hash": "00", "prev_hash": "00", "state_root": "00", "tx_root": "00",
        "timestamp": 1_794_311_950u64, "miner": "o1x", "nonce_hex": "00", "difficulty_target": "00",
        "log_slots": 23, "active_slot_count": 5
    }));
    let obs = w.observe(None).unwrap();
    assert_eq!(obs.tip_time, Some(1_794_311_950));
    // Asked once per poll, last, for the final tip height.
    let calls = w.rpc.calls_made();
    let (m, p) = calls.last().unwrap();
    assert_eq!((m.as_str(), p), ("paranoid_getBlockHeader", &json!([IDLE_TIP])));
    // Everything else in the observation is what it was without the call.
    assert_eq!(NoidObservation { tip_time: None, ..obs }, idle_base());
}

#[test]
fn a_node_or_recording_without_the_header_method_gives_unknown_tip_time_not_an_error() {
    // The recorded fixtures have no such call: the replay says "no recorded response", read as unknown.
    let obs = watcher("idle").observe(None).unwrap();
    assert_eq!(obs.tip_time, None);
    assert_eq!(obs, idle_base());
    // A real node that does not know the method (JSON-RPC "method not found").
    let mut fx = load("idle");
    fx.calls.push(
        serde_json::from_value(json!({"method": "paranoid_getBlockHeader", "error": {"code": -32601, "message": "Method not found"}})).unwrap(),
    );
    let w = NoidWatcher::new(FixtureRpc::from_fixture("old node", fx), opening_of(0x33).0).with_clock(pinned_clock);
    assert_eq!(w.observe(None).unwrap().tip_time, None);
    // `null` (no such block) and a header without a timestamp are unknown too.
    assert_eq!(idle_with_header(Value::Null).observe(None).unwrap().tip_time, None);
    assert_eq!(idle_with_header(json!({"height": 1})).observe(None).unwrap().tip_time, None);
}

#[test]
fn watcher_only_uses_declared_methods() {
    let api = std::fs::read_to_string(vendor("api.rs")).expect("vendored api.rs");
    let mut seen = BTreeSet::new();
    for name in FIXTURES.iter().filter(|n| **n != "malformed") {
        let w = watcher(name);
        let tracked = matches!(*name, "recorded_claim_pending" | "recorded_claim_included").then_some(LIVE_CLAIM_TXID);
        w.observe(tracked).unwrap();
        for m in all_methods(&w) {
            seen.insert(m);
        }
    }
    assert_eq!(seen.len(), 10, "{seen:?}");
    assert!(seen.contains("getBlockHeader"));
    for m in &seen {
        assert!(api.contains(&format!("#[method(name = \"{m}\")]")), "{m} is not declared in api.rs");
    }
}

// ------------------------------------------------------------------ drift guard

fn vendor(file: &str) -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../vendor/parano1d/noid_rpc/src").join(file)
}

/// `pub` field names of `pub struct <name> {` by a plain line scan (no regex).
fn declared_fields(src: &str, name: &str) -> Option<BTreeSet<String>> {
    let header = format!("pub struct {name} ");
    let mut lines = src.lines();
    while let Some(l) = lines.next() {
        if l.trim_start().starts_with(&header) && l.trim_end().ends_with('{') {
            let mut out = BTreeSet::new();
            for l in lines.by_ref() {
                let t = l.trim();
                if t == "}" {
                    return Some(out);
                }
                if t.starts_with("//") || t.starts_with("#[") {
                    continue;
                }
                if let Some(rest) = t.strip_prefix("pub ") {
                    if let Some((field, _)) = rest.split_once(':') {
                        out.insert(field.trim().to_string());
                    }
                }
            }
        }
    }
    None
}

struct Vendored(String);

impl Vendored {
    fn load() -> Self {
        let mut all = std::fs::read_to_string(vendor("types.rs")).expect("vendored types.rs");
        all.push('\n');
        all.push_str(&std::fs::read_to_string(vendor("object_types.rs")).expect("vendored object_types.rs"));
        Vendored(all)
    }
    fn fields(&self, name: &str) -> BTreeSet<String> {
        declared_fields(&self.0, name).unwrap_or_else(|| panic!("struct {name} not found in vendored sources"))
    }
}

fn keys_declared(ctx: &str, v: &Value, declared: &BTreeSet<String>) {
    let obj = v.as_object().unwrap_or_else(|| panic!("{ctx}: expected an object, got {v}"));
    for k in obj.keys() {
        assert!(declared.contains(k), "{ctx}: fixture key `{k}` is not a declared field ({declared:?})");
    }
}

#[test]
fn fixture_keys_are_declared_vendor_fields_and_required_fields_still_exist() {
    let v = Vendored::load();
    // Fields the watcher requires must still exist upstream.
    for (s, req) in [
        ("SlotInfo", &["slot_index", "value", "creation_id", "empty"][..]),
        ("ObjectInstances", &["slots"]),
        ("ObjectStatus", &["matches_opening", "active_authority"]),
        ("FeeEstimate", &["fee_micronoid"]),
        ("MempoolStats", &["fee_floor"]),
        ("MempoolTxInfo", &["tx_hash", "page_count", "fee_micronoid", "admitted_height"]),
        ("MempoolEntryInfo", &["contract_opening_hex"]),
        ("MempoolInfo", &["txs"]),
        ("TxInfo", &["height"]),
        ("BlockHeaderInfo", &["height", "timestamp"]),
    ] {
        let f = v.fields(s);
        for r in req {
            assert!(f.contains(*r), "{s}.{r} no longer declared upstream");
        }
    }
    // MempoolEntryInfo flattens MempoolTxInfo: its wire keys are both sets minus the `tx` carrier.
    let mut entry_keys = v.fields("MempoolTxInfo");
    entry_keys.extend(v.fields("MempoolEntryInfo").into_iter().filter(|k| k != "tx"));

    for name in FIXTURES {
        for c in &load(name).calls {
            let Some(r) = c.result.as_ref().filter(|r| !r.is_null()) else { continue };
            let ctx = format!("{name}/{}", c.method);
            match c.method.as_str() {
                "paranoid_estimateFeeDetailed" => {
                    keys_declared(&ctx, r, &v.fields("FeeEstimate"));
                    keys_declared(&format!("{ctx}.breakdown"), &r["breakdown"], &v.fields("FeeBreakdownInfo"));
                }
                "paranoid_getMempoolStats" => keys_declared(&ctx, r, &v.fields("MempoolStats")),
                "paranoid_getMempoolInfo" => {
                    keys_declared(&ctx, r, &v.fields("MempoolInfo"));
                    for t in r["txs"].as_array().unwrap() {
                        keys_declared(&format!("{ctx}.txs"), t, &v.fields("MempoolTxInfo"));
                    }
                }
                "paranoid_getMempoolEntry" => keys_declared(&ctx, r, &entry_keys),
                "paranoid_getObjectInstances" => {
                    keys_declared(&ctx, r, &v.fields("ObjectInstances"));
                    if let Some(slots) = r["slots"].as_array() {
                        for s in slots {
                            keys_declared(&format!("{ctx}.slots"), s, &v.fields("SlotInfo"));
                        }
                    }
                }
                "paranoid_getObjectStatus" => {
                    keys_declared(&ctx, r, &v.fields("ObjectStatus"));
                    keys_declared(&format!("{ctx}.slot"), &r["slot"], &v.fields("SlotInfo"));
                    keys_declared(&format!("{ctx}.object"), &r["object"], &v.fields("ObjectInfo"));
                }
                "paranoid_getTx" => keys_declared(&ctx, r, &v.fields("TxInfo")),
                _ => {}
            }
        }
    }
}

#[test]
fn fixture_descriptions_say_what_they_are() {
    for name in FIXTURES {
        let d = load(name).description;
        if RECORDED.contains(&name) {
            assert!(d.starts_with("RECORDED from http://127.0.0.1:9601 at unix time"), "{name}: {d}");
            assert!(d.contains("chain height 280"), "{name}: {d}");
            assert!(!d.contains("SYNTHESIZED"), "{name}");
            if LIVE.contains(&name) {
                assert!(d.contains("LIVE RUN 1") && d.contains("2026-11-04"), "{name}: {d}");
            }
        } else {
            assert!(d.starts_with("SYNTHESIZED"), "{name}: {d}");
            assert!(d.contains("no node was contacted"), "{name}");
        }
    }
    let d = load("recorded_misc").description;
    assert!(d.starts_with("RECORDED from http://127.0.0.1:9601") && d.contains("2026-11-04"), "{d}");
}

/// The text of a declared method from its `#[method(name = ..)]` line to the closing `;`.
fn signature(api: &str, name: &str) -> String {
    let at = api.find(&format!("#[method(name = \"{name}\")]")).unwrap_or_else(|| panic!("{name} is not declared in api.rs"));
    let rest = &api[at..];
    rest[..rest.find(';').unwrap()].split_whitespace().collect::<Vec<_>>().join(" ")
}

#[test]
fn every_method_the_tool_calls_is_declared_in_the_paranoid_namespace_with_the_params_we_send() {
    // The wire names do not appear as literals in the vendored sources: the jsonrpsee macro
    // `#[rpc(server, namespace = "paranoid")]` prefixes each `#[method(name = "x")]` with `paranoid_`
    // (the live node answers `paranoid_x`, confirmed on 2026-11-04).
    let api = std::fs::read_to_string(vendor("api.rs")).expect("vendored api.rs");
    assert!(api.contains("#[rpc(server, namespace = \"paranoid\")]"));
    for (name, params) in [
        ("blockCount", "(&self)"),
        ("getEpochAnchor", "(&self)"),
        ("getMempoolStats", "(&self)"),
        ("getMempoolInfo", "(&self)"),
        ("getMempoolEntry", "txhash: String"),
        ("getTx", "txhash: String"),
        ("getBlockHeader", "height: u64"),
        ("estimateFeeDetailed", "n_inputs: u32, n_outputs: u32"),
        ("getObjectInstances", "opening_hex: String, from_slot: u32, limit: u32"),
        ("getObjectStatus", "opening_hex: String, slot_index: u32"),
        ("getSlotHints", "count: u32"),
        ("submitTxIntent", "hex: String"),
    ] {
        let sig = signature(&api, name);
        assert!(sig.contains(params), "{name}: {sig}");
    }
}

#[test]
fn real_replies_recorded_from_the_node_have_the_declared_shapes_and_error_codes() {
    let v = Vendored::load();
    let fx = load("recorded_misc");
    let first = |m: &str| fx.calls.iter().find(|c| c.method == m).unwrap_or_else(|| panic!("no {m}"));
    let result = |m: &str| first(m).result.clone().unwrap();
    // chain info and protocol: declared keys, plus the facts the design relies on.
    let info = result("paranoid_getChainInfo");
    keys_declared("getChainInfo", &info, &v.fields("ChainInfo"));
    assert!(info["height"].as_u64().unwrap() >= IDLE_TIP);
    assert_eq!(info["best_hash"].as_str().unwrap().len(), 64);
    let proto = result("paranoid_getContractProtocol");
    keys_declared("getContractProtocol", &proto, &v.fields("ObjectProtocolInfo"));
    assert_eq!((proto["abi_version"].as_u64(), proto["instructions"].as_u64(), proto["runtime_available"].as_bool()), (Some(3), Some(16), Some(true)));
    // Status of an EMPTY slot is an answer, not an error: matches_opening false, but the active authority is shown.
    let st = result("paranoid_getObjectStatus");
    keys_declared("getObjectStatus", &st, &v.fields("ObjectStatus"));
    keys_declared("getObjectStatus.slot", &st["slot"], &v.fields("SlotInfo"));
    keys_declared("getObjectStatus.object", &st["object"], &v.fields("ObjectInfo"));
    assert_eq!((st["matches_opening"].as_bool(), st["slot"]["empty"].as_bool()), (Some(false), Some(true)));
    assert_eq!(st["active_authority"], json!(CLAIM_AUTHORITY));
    // The recording was made against the seed-0x33 example opening of its day (deadline 300,725; the example's D has since moved with
    // B_safety 30 to 300,735, which no real node was asked about): the reply must echo the opening it was asked, whatever that was.
    let asked = first("paranoid_getObjectStatus").params.as_ref().unwrap()[0].clone();
    assert_eq!(st["object"]["opening_hex"], asked);
    assert!(st["object"]["address"].as_str().unwrap().starts_with("o1"));
    // An unknown txid is JSON null from both lookups (read by the watcher as "not confirmed / not pending").
    assert_eq!(result("paranoid_getTx"), Value::Null);
    assert_eq!(result("paranoid_getMempoolEntry"), Value::Null);
    // Slot hints are a plain array of u32 (what client R takes as its output slot).
    let hints = result("paranoid_getSlotHints");
    assert!(hints.as_array().map_or(false, |a| a.len() == 1 && a[0].as_u64().map_or(false, |s| u32::try_from(s).is_ok())), "{hints}");
    // The error replies replay as RpcError::Remote with the node's own codes and texts.
    let rpc = FixtureRpc::from_fixture("misc", fx);
    match rpc.call("paranoid_getMempoolEntry", json!(["0000000000000000000000000000000000000000000000000000000000000001"])) {
        Ok(Value::Null) => {}
        other => panic!("{other:?}"),
    }
    match rpc.call("paranoid_getMempoolEntry", json!(["zz"])) {
        Err(RpcError::Remote { code: -32000, message }) => assert!(message.contains("expected 64-char hex"), "{message}"),
        other => panic!("{other:?}"),
    }
    match rpc.call("paranoid_getObjectInstances", json!(["00", 0, 16])) {
        Err(RpcError::Remote { code: -32000, message }) => assert!(message.contains("Encoding"), "{message}"),
        other => panic!("{other:?}"),
    }
    assert_eq!(rpc.call("paranoid_noSuchMethod", json!([])), Err(RpcError::Remote { code: -32601, message: "Method not found".into() }));
}

#[test]
fn observations_are_stamped_when_the_poll_starts_with_the_watchers_clock() {
    // The pinned clock is what the other tests compare against; the default is the system clock.
    assert_eq!(watcher("idle").observe(None).unwrap().observed_at, Some(OBSERVED_AT));
    let before = swap_cli::watch::system_now();
    let obs = NoidWatcher::new(FixtureRpc::from_file(&fixture_path("idle")).expect("fixture"), opening_for("idle")).observe(None).unwrap();
    let at = obs.observed_at.expect("stamped");
    assert!(at >= before && at <= swap_cli::watch::system_now(), "{at} vs {before}");
}

// ------------------------------------------------------------------ REVIEW-2 F10: every instance is reported

/// The `funded` recording with the instance page and the status answers replaced: `slots` is `(slot, value,
/// creation_id, matches_opening)` in the order the node lists them. The recorded request parameters are dropped so
/// that one status call per slot is served (in order), the last answer repeating.
fn watcher_with_slots(slots: &[(u32, u64, u64, bool)]) -> NoidWatcher<FixtureRpc> {
    let mut fx = load("funded");
    let status_template = fx.calls.iter().find(|c| c.method == "paranoid_getObjectStatus").unwrap().clone();
    fx.calls.retain(|c| c.method != "paranoid_getObjectStatus");
    for c in fx.calls.iter_mut().filter(|c| c.method == "paranoid_getObjectInstances") {
        let r = c.result.as_mut().unwrap();
        r["slots"] = Value::Array(
            slots
                .iter()
                .map(|(slot, value, creation, _)| json!({"slot_index": slot, "value": value, "creation_id": creation, "owner": "", "empty": false}))
                .collect(),
        );
    }
    for (_, _, _, matches) in slots {
        let mut c = status_template.clone();
        c.params = None;
        let r = c.result.as_mut().unwrap();
        r["matches_opening"] = json!(matches);
        fx.calls.push(c);
    }
    NoidWatcher::new(FixtureRpc::from_fixture("funded-with-slots", fx), opening_for("funded")).with_clock(pinned_clock)
}

#[test]
fn f10_every_non_empty_slot_is_reported_with_its_own_status_and_the_first_fills_the_legacy_fields() {
    // Dust first, the real instance second: the order the node lists them is the order reported.
    let w = watcher_with_slots(&[(3, 1_000, 5, false), (4242, 10_000_000, 77_001, true)]);
    let obs = w.observe(None).unwrap();
    assert_eq!(obs.instance_count, 2);
    assert_eq!(obs.instances.len(), 2);
    assert_eq!(obs.instances[0].instance, NoidInstance { slot_index: 3, creation_id: 5, amount_micronoid: 1_000 });
    assert_eq!(obs.instances[0].matches_opening, Some(false));
    assert_eq!(obs.instances[1].instance, NoidInstance { slot_index: 4242, creation_id: 77_001, amount_micronoid: 10_000_000 });
    assert_eq!(obs.instances[1].matches_opening, Some(true));
    // The legacy fields describe the FIRST entry, exactly as before.
    assert_eq!(obs.instance.as_ref(), Some(&obs.instances[0].instance));
    assert_eq!(obs.instance_matches_opening, Some(false));
    assert_eq!(obs.active_authority, obs.instances[0].active_authority);
    // One status call per slot, in slot order, each for its own slot.
    let status_calls: Vec<Value> =
        w.rpc.calls_made().into_iter().filter(|(m, _)| m == "paranoid_getObjectStatus").map(|(_, p)| p[1].clone()).collect();
    assert_eq!(status_calls, vec![json!(3), json!(4242)]);
    assert_eq!(obs.all_instances().len(), 2);
    assert_eq!(obs.find_instance(&NoidInstance { slot_index: 4242, creation_id: 77_001, amount_micronoid: 0 }).map(|v| v.matches_opening), Some(Some(true)));
}

#[test]
fn f10_empty_slots_are_not_instances_and_no_slot_is_an_empty_list() {
    let mut fx = load("funded");
    for c in fx.calls.iter_mut().filter(|c| c.method == "paranoid_getObjectInstances") {
        c.result.as_mut().unwrap()["slots"] = json!([{"slot_index": 1, "value": 0, "creation_id": 0, "owner": "", "empty": true}]);
    }
    let w = NoidWatcher::new(FixtureRpc::from_fixture("empty", fx), opening_for("funded")).with_clock(pinned_clock);
    let obs = w.observe(None).unwrap();
    assert!(obs.instance.is_none() && obs.instances.is_empty() && obs.instance_count == 0);
    assert!(!methods(&w).contains(&"getObjectStatus".to_string()), "no status call without an instance");
}
