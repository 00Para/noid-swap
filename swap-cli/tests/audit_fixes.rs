//! Regression tests for the audit fixes in `swap-cli`:
//! 1. Critical: `paranoid_getObjectInstances` pagination + direct tracked-slot fallback against dust eclipsing.
//! 2. High: `eth_nodes_agree` checks node 2's `block_number`, `sender`, `hashlock`, and EOA flags.
//! 3. High: `EthWatcher::discover_lock_ids` skips `Locked` logs whose amount or timelock does not fit, and reports each skip.
//! 4. Medium: `NodeReads::root_instances` paginates `next_slot` and rejects non-advancing cursors.
//! 5. curl reads no `.curlrc`, speaks only http and https, and never takes the URL as an option.

use std::path::Path;

use serde_json::{json, Value};
use swap_cli::engine::{self, Action};
use swap_cli::htlc_harness::seq_bytes;
use swap_cli::params::ProfileName;
use swap_cli::secret::{sha256, Secret, Variant};
use swap_cli::state::{AlicePhase, Phase};
use swap_cli::swapfile::{example_public, KdfParams, Passphrase, SwapFile};
use swap_cli::wallet::chain::NodeReads;
use swap_cli::watch::eth::{compute_lock_id, EthWatcher, LockDiscovery, MAX_IGNORED_LOGS, TOPIC_LOCKED};
use swap_cli::watch::exec::ExecJsonRpc;
use swap_cli::watch::parano1d::NoidWatcher;
use swap_cli::watch::{EthLock, EthObservation, Fixture, FixtureRpc, JsonRpc, NoidInstance, NoidInstanceStatus, NoidObservation, RpcError, ScriptedRpc};

struct ClosureRpc<F>(F);

impl<F: Fn(&str, &Value) -> Result<Value, RpcError>> JsonRpc for ClosureRpc<F> {
    fn call(&self, method: &str, params: Value) -> Result<Value, RpcError> {
        (self.0)(method, &params)
    }
}

#[test]
fn noid_watcher_paginates_past_16_dust_slots_to_find_real_instance() {
    let pub_ = example_public(&Secret::from_bytes(seq_bytes(1)), Variant::Raw);
    let anchor = "aa".repeat(32);
    let rpc = ClosureRpc(|method: &str, params: &Value| match method {
        "paranoid_blockCount" => Ok(json!(300_020)),
        "paranoid_getEpochAnchor" => Ok(json!(anchor)),
        "paranoid_estimateFeeDetailed" => Ok(json!({"fee_micronoid": 5800})),
        "paranoid_getMempoolStats" => Ok(json!({"fee_floor": 5000})),
        "paranoid_getObjectInstances" => {
            let from_slot = params[1].as_u64().unwrap() as u32;
            if from_slot == 0 {
                let dust: Vec<Value> = (1u32..=16)
                    .map(|i| json!({"slot_index": i, "value": 1, "creation_id": i as u64, "empty": false}))
                    .collect();
                Ok(json!({"height": 300_020, "slots": dust, "next_slot": 17}))
            } else {
                Ok(json!({
                    "height": 300_020,
                    "slots": [{"slot_index": 25, "value": 10_000_000, "creation_id": 999, "empty": false}],
                    "next_slot": null
                }))
            }
        }
        "paranoid_getObjectStatus" => Ok(json!({
            "matches_opening": true,
            "active_authority": pub_.claim_authority,
            "tip_height": 300_020
        })),
        "paranoid_getMempoolInfo" => Ok(json!({"txs": []})),
        "paranoid_getBlockHeader" => Ok(json!({"timestamp": 1_700_000_000u64})),
        other => Err(RpcError::Remote { code: -32601, message: other.into() }),
    });

    let obs = NoidWatcher::new(&rpc, pub_.opening_hex.clone()).observe(None).unwrap();
    assert_eq!(obs.instances.len(), 17, "must collect both pages");
    assert!(
        obs.instances.iter().any(|i| i.instance.slot_index == 25 && i.instance.amount_micronoid == 10_000_000),
        "real instance at slot 25 must not be hidden behind 16 lower dust slots"
    );
}

#[test]
fn noid_watcher_direct_tracked_slot_survives_root_flood_past_page_cap() {
    let pub_ = example_public(&Secret::from_bytes(seq_bytes(2)), Variant::Raw);
    let anchor = "bb".repeat(32);
    let rpc = ClosureRpc(|method: &str, params: &Value| match method {
        "paranoid_blockCount" => Ok(json!(300_020)),
        "paranoid_getEpochAnchor" => Ok(json!(anchor)),
        "paranoid_estimateFeeDetailed" => Ok(json!({"fee_micronoid": 5800})),
        "paranoid_getMempoolStats" => Ok(json!({"fee_floor": 5000})),
        "paranoid_getObjectInstances" => {
            let from_slot = params[1].as_u64().unwrap() as u32;
            let dust: Vec<Value> = (0u32..16)
                .map(|k| json!({"slot_index": from_slot + k, "value": 1, "creation_id": (from_slot + k + 1) as u64, "empty": false}))
                .collect();
            Ok(json!({"height": 300_020, "slots": dust, "next_slot": from_slot + 16}))
        }
        "paranoid_getObjectStatus" => {
            let slot = params[1].as_u64().unwrap() as u32;
            if slot == 99_999 {
                Ok(json!({
                    "matches_opening": true,
                    "active_authority": pub_.claim_authority,
                    "tip_height": 300_020,
                    "slot": {"slot_index": 99_999, "value": 10_000_000, "creation_id": 777, "empty": false}
                }))
            } else {
                Ok(json!({
                    "matches_opening": true,
                    "active_authority": pub_.claim_authority,
                    "tip_height": 300_020
                }))
            }
        }
        "paranoid_getMempoolInfo" => Ok(json!({"txs": []})),
        "paranoid_getBlockHeader" => Ok(json!({"timestamp": 1_700_000_000u64})),
        other => Err(RpcError::Remote { code: -32601, message: other.into() }),
    });

    // Without allow_truncated, hitting the page cap fails closed.
    let err = NoidWatcher::new(&rpc, pub_.opening_hex.clone())
        .with_tracked_slot(Some(99_999), false)
        .observe(None)
        .unwrap_err();
    assert!(err.to_string().contains("cannot be judged"), "unexpected error: {err}");

    // With committed tracked slot, direct paranoid_getObjectStatus recovers slot 99,999.
    let obs = NoidWatcher::new(&rpc, pub_.opening_hex.clone())
        .with_tracked_slot(Some(99_999), true)
        .observe(None)
        .unwrap();
    assert!(
        obs.instances.iter().any(|i| i.instance.slot_index == 99_999 && i.instance.creation_id == 777),
        "tracked slot 99,999 must be recovered via direct getObjectStatus under a >1024-slot flood"
    );
    // The read says it is partial, so the engine can hold what needs the whole list.
    assert!(obs.instances_truncated);
}

#[test]
fn wallet_root_instances_paginates_and_rejects_non_advancing_cursor() {
    let rpc = ClosureRpc(|method: &str, params: &Value| {
        assert_eq!(method, "paranoid_getObjectInstances");
        let from_slot = params[1].as_u64().unwrap() as u32;
        if from_slot == 0 {
            Ok(json!({
                "height": 100,
                "slots": [{"slot_index": 1, "value": 1, "creation_id": 1, "owner": "x", "empty": false}],
                "next_slot": 10
            }))
        } else {
            Ok(json!({
                "height": 101,
                "slots": [{"slot_index": 12, "value": 5_000_000, "creation_id": 2, "owner": "x", "empty": false}],
                "next_slot": null
            }))
        }
    });
    let (inst, h) = NodeReads::new(&rpc).root_instances("00").unwrap();
    assert_eq!(h, 101);
    assert_eq!(inst.len(), 2);
    assert_eq!(inst[1].slot_index, 12);

    let stuck = ClosureRpc(|_m: &str, _p: &Value| {
        Ok(json!({"height": 100, "slots": [], "next_slot": 0}))
    });
    assert!(NodeReads::new(&stuck).root_instances("00").is_err());
}

#[test]
fn eth_nodes_agree_refuses_reveal_when_second_node_reports_unfinalized_block_or_contract_receiver() {
    let secret = Secret::from_bytes(seq_bytes(5));
    let mut pub_ = example_public(&secret, Variant::Raw);
    pub_.params.profile = ProfileName::Production;
    pub_.params.eth.chain_id = 1;
    let code_hash = swap_cli::params::HTLC_CODE_HASH;
    pub_.params.eth.code_hash = Some(code_hash);
    let now = 1_700_000_000u64;
    let t_reveal = now + 7_200;
    let mut file = SwapFile::new_alice(pub_.clone(), &secret, &Passphrase::new("pw"), &KdfParams::fast_for_tests(), now).unwrap();
    let inst = NoidInstance { slot_index: 7, creation_id: 1, amount_micronoid: pub_.params.amount_micronoid };
    file.phase = Phase::Alice(AlicePhase::FundingFinal { instance: inst.clone(), final_at_tip: 300_020 });

    let lock_id = [0x11u8; 32];
    let primary_lock = EthLock {
        lock_id,
        sender: pub_.params.eth.bob_sender,
        receiver: pub_.params.eth.alice_receiver,
        amount_wei: pub_.params.eth.amount_wei,
        hashlock: pub_.hashlock,
        timelock: t_reveal,
        block_number: 100, // lying primary claims block 100 (appears final at 150)
        tx_hash: [0x22u8; 32],
        block_timestamp: Some(now),
        claimed: false,
        refunded: false,
        sender_is_eoa: Some(true),
        receiver_is_eoa: Some(true),
    };

    let mut second_lock = primary_lock.clone();
    second_lock.block_number = 200; // honest node 2 sees lock at unfinalized block 200

    let make_eth = |lock: EthLock| EthObservation {
        observed_at: Some(now),
        chain_id: Some(1),
        contract_code_hash: Some(code_hash),
        latest_block: 205,
        latest_timestamp: now,
        finalized_block: Some(150),
        finalized_timestamp: Some(now),
        lock: Some(lock.clone()),
        locks: vec![lock],
        lock_count: 1,
        ..Default::default()
    };

    let mut eth = make_eth(primary_lock.clone());
    eth.second = Some(Box::new(make_eth(second_lock)));

    let noid = NoidObservation {
        observed_at: Some(now),
        tip: 300_025,
        next_call_height: 300_026,
        tip_time: Some(now),
        instance: Some(inst.clone()),
        instance_matches_opening: Some(true),
        active_authority: Some(pub_.claim_authority.clone()),
        instances: vec![NoidInstanceStatus {
            instance: inst,
            matches_opening: Some(true),
            active_authority: Some(pub_.claim_authority.clone()),
        }],
        instance_count: 1,
        ..Default::default()
    };

    let d = engine::decide(&file, &noid, &eth, now);
    assert!(matches!(d.action, Action::Wait { .. }), "lying primary block_number must not bypass node 2 finality: {:?}", d.action);

    // Also test node 2 reporting receiver_is_eoa == Some(false) (contract / EIP-7702 receiver).
    let mut bad_eoa_lock = primary_lock.clone();
    bad_eoa_lock.receiver_is_eoa = Some(false);
    let mut eth2 = make_eth(primary_lock);
    eth2.second = Some(Box::new(make_eth(bad_eoa_lock)));
    let d2 = engine::decide(&file, &noid, &eth2, now);
    assert!(matches!(d2.action, Action::Wait { .. }), "node 2 non-EOA receiver must block reveal: {:?}", d2.action);
}

#[test]
fn eth_watcher_discovery_skips_overlarge_timelock_log_without_bricking() {
    let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("fixtures/eth/locked.json");
    let mut fx: Fixture = serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
    let contract: [u8; 20] = hex::decode("5fbdb2315678afecb367f032d93f642f64180aa3").unwrap().try_into().unwrap();
    let bob: [u8; 20] = hex::decode("70997970c51812dc3a010c7d01b50e0d17dc79c8").unwrap().try_into().unwrap();
    let alice: [u8; 20] = hex::decode("3c44cdddb6a900fa2b585dd299e03d12fa4293bc").unwrap().try_into().unwrap();
    let hashlock = sha256(&seq_bytes(0));

    // Prepend a hostile 1-wei Locked log with timelock = 2^64 (does not fit in u64) to eth_getLogs.
    let mut poisoned = false;
    for call in &mut fx.calls {
        if call.method == "eth_getLogs" {
            if let Some(arr) = call.result.as_mut().and_then(Value::as_array_mut) {
                if let Some(first) = arr.first().cloned() {
                    let mut hostile = first;
                    // Distinct lockId (a real 1-wei lock with timelock = 2^64 has its own lockId).
                    hostile["topics"][1] = json!(format!("0x{}", "99".repeat(32)));
                    // data = amount (32 bytes = 1) || hashlock (32 bytes) || timelock (32 bytes = 1 << 64)
                    let amount = format!("{:064x}", 1u64);
                    let hl = hex::encode(hashlock);
                    let timelock = format!("{:0>64}", "10000000000000000"); // 2^64
                    hostile["data"] = json!(format!("0x{amount}{hl}{timelock}"));
                    arr.insert(0, hostile);
                    poisoned = true;
                    break;
                }
            }
        }
    }
    assert!(poisoned, "fixture must contain a Locked log to poison");

    let rpc = FixtureRpc::from_fixture("poisoned-locked", fx);
    let obs = EthWatcher::new(&rpc, contract, [0u8; 32])
        .with_discovery(LockDiscovery { sender: bob, receiver: alice, hashlock })
        .observe()
        .expect("watcher must skip timelock >= 2^64 log instead of bricking");
    assert!(obs.lock.is_some(), "valid lock must still be discovered");
}

const SKIP_CONTRACT: &str = "5fbdb2315678afecb367f032d93f642f64180aa3";
const BOB: &str = "70997970c51812dc3a010c7d01b50e0d17dc79c8";
const ALICE: &str = "3c44cdddb6a900fa2b585dd299e03d12fa4293bc";

fn a20(h: &str) -> [u8; 20] {
    hex::decode(h).unwrap().try_into().unwrap()
}

fn hex0x(b: &[u8]) -> String {
    format!("0x{}", hex::encode(b))
}

fn pad(a: &[u8; 20]) -> [u8; 32] {
    let mut w = [0u8; 32];
    w[12..].copy_from_slice(a);
    w
}

fn word_u128(n: u128) -> [u8; 32] {
    let mut w = [0u8; 32];
    w[16..].copy_from_slice(&n.to_be_bytes());
    w
}

/// A scripted Ethereum node holding the real lock and `junk` logs of the same parties and hashlock whose amount or timelock words do not fit
/// (`(lock id, amount word, timelock word)`: `newLock` takes any uint256, so Bob's address can make such a lock for 1 wei).
fn eth_node(
    hashlock: [u8; 32],
    real: ([u8; 32], u64, u128),
    junk: Vec<([u8; 32], [u8; 32], [u8; 32])>,
) -> ScriptedRpc<impl Fn(&str, &Value) -> Result<Value, RpcError>> {
    ScriptedRpc(move |m: &str, p: &Value| -> Result<Value, RpcError> {
        let log = |id: &[u8; 32], amount: &[u8; 32], timelock: &[u8; 32], blk: u64| {
            let mut data = Vec::new();
            data.extend_from_slice(amount);
            data.extend_from_slice(&hashlock);
            data.extend_from_slice(timelock);
            json!({
                "removed": false, "address": format!("0x{SKIP_CONTRACT}"),
                "topics": [hex0x(&TOPIC_LOCKED), hex0x(id), hex0x(&pad(&a20(BOB))), hex0x(&pad(&a20(ALICE)))],
                "data": hex0x(&data), "blockNumber": format!("0x{blk:x}"), "transactionHash": hex0x(&[0xee; 32]),
            })
        };
        let real_log = log(&real.0, &word_u128(real.2), &word_u128(u128::from(real.1)), 10);
        match m {
            "eth_blockNumber" => Ok(json!("0x64")),
            "eth_getBlockByNumber" => match p[0].as_str().unwrap() {
                "latest" => Ok(json!({"number": "0x64", "timestamp": "0x6553f100"})),
                "finalized" => Ok(json!({"number": "0x60", "timestamp": "0x6553f000"})),
                _ => Ok(json!({"number": p[0], "timestamp": "0x6553e000"})),
            },
            "eth_chainId" => Ok(json!("0x7a69")),
            "eth_getCode" => Ok(json!(if p[0].as_str().unwrap() == format!("0x{SKIP_CONTRACT}") { "0x6001" } else { "0x" })),
            "eth_getLogs" => {
                let topics = &p[0]["topics"];
                if topics[1].is_null() {
                    // Discovery: the junk first (as if Bob's address made them earlier), then the real lock.
                    let mut all: Vec<Value> = junk.iter().enumerate().map(|(i, (id, a, t))| log(id, a, t, 5 + i as u64)).collect();
                    all.push(real_log);
                    return Ok(Value::Array(all));
                }
                Ok(Value::Array(if topics[1].as_str().unwrap() == hex0x(&real.0) { vec![real_log] } else { Vec::new() }))
            }
            "eth_call" => {
                let data = hex::decode(p[0]["data"].as_str().unwrap().trim_start_matches("0x")).unwrap();
                if data[4..36] != real.0[..] {
                    return Err(RpcError::Remote { code: 3, message: "execution reverted: LockNotFound".into() });
                }
                let mut out = Vec::new();
                out.extend_from_slice(&pad(&a20(BOB)));
                out.extend_from_slice(&pad(&a20(ALICE)));
                out.extend_from_slice(&word_u128(real.2));
                out.extend_from_slice(&hashlock);
                out.extend_from_slice(&word_u128(u128::from(real.1)));
                out.extend_from_slice(&[0u8; 96]);
                Ok(json!(hex0x(&out)))
            }
            other => Err(RpcError::Remote { code: -32601, message: format!("unexpected {other}") }),
        }
    })
}

#[test]
fn oversize_locked_logs_beside_the_real_lock_are_skipped_and_reported() {
    let hashlock = [0x42; 32];
    let (timelock, amount) = (1_700_007_200u64, 10u128.pow(16));
    let real_id = compute_lock_id(&a20(BOB), &a20(ALICE), amount, &hashlock, timelock);
    let mut huge_timelock = [0u8; 32];
    huge_timelock[23] = 1; // 2^64
    let mut huge_amount = [0u8; 32];
    huge_amount[15] = 1; // 2^128 wei
    let junk = vec![([0x11; 32], word_u128(1), huge_timelock), ([0x12; 32], huge_amount, word_u128(u128::from(timelock))), ([0x13; 32], huge_amount, huge_timelock)];
    let rpc = eth_node(hashlock, (real_id, timelock, amount), junk);
    let rule = LockDiscovery { sender: a20(BOB), receiver: a20(ALICE), hashlock };
    let obs = EthWatcher::new(&rpc, a20(SKIP_CONTRACT), [0u8; 32]).with_discovery(rule).observe().expect("the poll does not fail on them");
    let lock = obs.lock.expect("the real lock is found");
    assert_eq!(lock.lock_id, real_id);
    assert_eq!((lock.amount_wei, lock.timelock), (amount, timelock));
    assert_eq!(obs.lock_count, 1);
    assert_eq!(obs.ignored_logs.len(), 3, "{:?}", obs.ignored_logs);
    assert!(obs.ignored_logs[0].contains("its timelock does not fit in 64 bits") && obs.ignored_logs[0].contains("block 5"), "{:?}", obs.ignored_logs);
    assert!(obs.ignored_logs[1].contains("its amount does not fit in 128 bits"), "{:?}", obs.ignored_logs);
    assert!(obs.ignored_logs[2].contains("its amount and its timelock do not fit"), "{:?}", obs.ignored_logs);
}

#[test]
fn a_flood_of_oversize_logs_is_listed_up_to_the_cap_and_counted() {
    let hashlock = [0x42; 32];
    let (timelock, amount) = (1_700_007_200u64, 10u128.pow(16));
    let real_id = compute_lock_id(&a20(BOB), &a20(ALICE), amount, &hashlock, timelock);
    let mut huge = [0u8; 32];
    huge[0] = 0xff;
    let junk: Vec<_> = (0..20u8).map(|i| ([i; 32], word_u128(1), huge)).collect();
    let rpc = eth_node(hashlock, (real_id, timelock, amount), junk);
    let rule = LockDiscovery { sender: a20(BOB), receiver: a20(ALICE), hashlock };
    let obs = EthWatcher::new(&rpc, a20(SKIP_CONTRACT), [0u8; 32]).with_discovery(rule).observe().unwrap();
    assert_eq!(obs.lock.map(|l| l.lock_id), Some(real_id));
    assert_eq!(obs.ignored_logs.len(), MAX_IGNORED_LOGS + 1);
    assert_eq!(obs.ignored_logs.last().unwrap(), "and 12 more such log(s), not listed");
}

// ---- curl

#[test]
fn curl_reads_no_curlrc_speaks_only_http_and_never_takes_the_url_as_an_option() {
    let rpc = ExecJsonRpc::new("-K/tmp/evil", Some("curl"));
    let args = rpc.args();
    assert_eq!(args.first().map(String::as_str), Some("-q"), "-q must be the first argument: {args:?}");
    let pos = |a: &str| args.iter().position(|x| x == a).unwrap_or_else(|| panic!("{a} missing: {args:?}"));
    assert_eq!(args[pos("--proto") + 1], "=http,https");
    assert_eq!(args[pos("--proto-redir") + 1], "=http,https");
    // `--` is the last option and the URL comes right after it, last: a URL that starts with `-` is still a URL.
    assert_eq!(args[args.len() - 2], "--");
    assert_eq!(args.last().map(String::as_str), Some("-K/tmp/evil"));
    assert_eq!(args.iter().filter(|a| *a == "-K/tmp/evil").count(), 1);
}

// ---- a closed instance under a flood above the page cap is a usable partial read

/// A root that never ends (every page has more coins) and answers the direct lookup of slot 99,999 with `status_slot` (`None`: no `slot` at all).
fn flooded_root(status_slot: Option<Value>) -> impl JsonRpc {
    let anchor = "cc".repeat(32);
    ClosureRpc(move |method: &str, params: &Value| match method {
        "paranoid_blockCount" => Ok(json!(300_020)),
        "paranoid_getEpochAnchor" => Ok(json!(anchor)),
        "paranoid_estimateFeeDetailed" => Ok(json!({"fee_micronoid": 5800})),
        "paranoid_getMempoolStats" => Ok(json!({"fee_floor": 5000})),
        "paranoid_getObjectInstances" => {
            let from_slot = params[1].as_u64().unwrap() as u32;
            let dust: Vec<Value> = (0u32..16)
                .map(|k| json!({"slot_index": from_slot + k, "value": 1, "creation_id": (from_slot + k + 1) as u64, "owner": "x", "empty": false}))
                .collect();
            Ok(json!({"height": 300_020, "slots": dust, "next_slot": from_slot + 16}))
        }
        "paranoid_getObjectStatus" => {
            let mut v = json!({"matches_opening": true, "active_authority": "o1x", "tip_height": 300_020});
            if params[1].as_u64() == Some(99_999) {
                if let Some(s) = &status_slot {
                    v["slot"] = s.clone();
                }
            }
            Ok(v)
        }
        "paranoid_getMempoolInfo" => Ok(json!({"txs": []})),
        "paranoid_getBlockHeader" => Ok(json!({"timestamp": 1_700_000_000u64})),
        other => Err(RpcError::Remote { code: -32601, message: other.into() }),
    })
}

#[test]
fn a_closed_tracked_instance_under_a_flood_is_a_partial_read_not_an_error() {
    let pub_ = example_public(&Secret::from_bytes(seq_bytes(3)), Variant::Raw);
    let empty = json!({"slot_index": 99_999, "value": 0, "creation_id": 777, "owner": "x", "empty": true});
    let obs = NoidWatcher::new(&flooded_root(Some(empty.clone())), pub_.opening_hex.clone()).with_tracked_slot(Some(99_999), true).observe(None).unwrap();
    assert!(obs.instances_truncated);
    assert!(!obs.instances.iter().any(|i| i.instance.slot_index == 99_999), "a closed instance is not listed");
    // Another incarnation at the slot: listed as it is, so the engine sees that the recorded one is gone.
    let other = json!({"slot_index": 99_999, "value": 5, "creation_id": 900, "owner": "x", "empty": false});
    let obs = NoidWatcher::new(&flooded_root(Some(other)), pub_.opening_hex.clone()).with_tracked_slot(Some(99_999), true).observe(None).unwrap();
    assert!(obs.instances.iter().any(|i| i.instance.slot_index == 99_999 && i.instance.creation_id == 900));
    // No definite answer (no `slot`), no tracked slot, or a flag that is off: the list cannot be judged, and the text gives the real cap.
    for (rpc, slot, allow) in [(flooded_root(None), Some(99_999), true), (flooded_root(Some(empty.clone())), None, true), (flooded_root(Some(empty)), Some(99_999), false)] {
        let err = NoidWatcher::new(&rpc, pub_.opening_hex.clone()).with_tracked_slot(slot, allow).observe(None).unwrap_err().to_string();
        assert!(err.contains("more than 16144 coins") && err.contains("cannot be judged"), "{err}");
    }
}

#[test]
fn the_wallet_reads_a_closed_tracked_instance_under_a_flood_as_absent_and_refuses_without_a_definite_answer() {
    let flood = |slot: Option<Value>| {
        ClosureRpc(move |method: &str, params: &Value| match method {
            "paranoid_getObjectInstances" => {
                let from_slot = params[1].as_u64().unwrap() as u32;
                let dust: Vec<Value> = (0u32..16).map(|k| json!({"slot_index": from_slot + k, "value": 1, "creation_id": 1, "owner": "x", "empty": false})).collect();
                Ok(json!({"height": 100, "slots": dust, "next_slot": from_slot + 16}))
            }
            "paranoid_getObjectStatus" => {
                let mut v = json!({"matches_opening": true, "active_authority": "o1x", "tip_height": 101});
                if let Some(s) = &slot {
                    v["slot"] = s.clone();
                }
                Ok(v)
            }
            other => Err(RpcError::Remote { code: -32601, message: other.into() }),
        })
    };
    let empty = json!({"slot_index": 99_999, "value": 0, "creation_id": 5, "owner": "x", "empty": true});
    let (inst, h) = NodeReads::new(&flood(Some(empty))).root_instances_for_slot("00", Some(99_999)).unwrap();
    assert!(!inst.iter().any(|i| i.slot_index == 99_999));
    assert_eq!(h, 101);
    let err = NodeReads::new(&flood(None)).root_instances_for_slot("00", Some(99_999)).unwrap_err().to_string();
    assert!(err.contains("more than 16144 coins") && err.contains("cannot be judged"), "{err}");
    assert!(NodeReads::new(&flood(None)).root_instances_for_slot("00", None).is_err());
}
