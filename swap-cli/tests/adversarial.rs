//! Seeded adversarial and property-based test suite for `swap-cli`:
//! - Dust-eclipse pagination topologies (random slot layouts, stalled/regressing cursors, root floods)
//! - Hostile Ethereum `Locked` logs (u64/u128 overflows, truncated data, corrupt hex, bad topics)
//! - Full primary vs. node-2 disagreement matrix (`eth_nodes_agree` & `noid_nodes_agree`)
//! - URL / SSRF / credential-smuggling fuzzing on `HttpUrl::parse`, `is_loopback_http`, `normalize_endpoint`
//! - Chaotic observation fuzzing of `engine::decide` (no panics, hard cutoff & finality invariants)
//! - Concurrent `HashlockRegistry::register` thread-race uniqueness under file locking

use std::path::Path;
use std::sync::{Arc, Barrier};
use std::thread;

use noid_poseidon2b::primitives::Address;
use serde_json::{json, Value};
use swap_cli::engine::{self, Action};
use swap_cli::htlc_harness::seq_bytes;
use swap_cli::params::{ContractVersion, ProfileName};
use swap_cli::secret::{sha256, LockKind, Secret, Variant};
use swap_cli::state::{AlicePhase, BobPhase, Phase};
use swap_cli::swapfile::{
    example_public, example_public_kind, BobTerms, HashlockRegistry, KdfParams, Passphrase, SwapFile,
};
use swap_cli::watch::eth::{EthWatcher, LockDiscovery};
use swap_cli::watch::http::{is_loopback_http, normalize_endpoint, HttpUrl};
use swap_cli::watch::parano1d::NoidWatcher;
use swap_cli::watch::{
    EthLock, EthObservation, Fixture, FixtureRpc, JsonRpc, NoidInstance, NoidInstanceStatus, NoidObservation, RpcError,
};

struct ClosureRpc<F>(F);

impl<F: Fn(&str, &Value) -> Result<Value, RpcError>> JsonRpc for ClosureRpc<F> {
    fn call(&self, method: &str, params: Value) -> Result<Value, RpcError> {
        (self.0)(method, &params)
    }
}

/// Deterministic xorshift64* PRNG so every adversarial run is reproducible.
struct Rng(u64);

impl Rng {
    fn new(seed: u64) -> Self {
        Self(seed.max(1))
    }
    fn next_u64(&mut self) -> u64 {
        let mut x = self.0;
        x ^= x >> 12;
        x ^= x << 25;
        x ^= x >> 27;
        self.0 = x;
        x.wrapping_mul(0x2545F4914F6CDD1D)
    }
    fn range(&mut self, lo: u64, hi_excl: u64) -> u64 {
        lo + (self.next_u64() % (hi_excl - lo).max(1))
    }
}

// ------------------------------------------------------------------ 1. Dust-eclipse pagination fuzz

#[test]
fn fuzz_noid_pagination_discovers_real_instance_across_random_dust_topologies() {
    let pub_ = example_public(&Secret::from_bytes(seq_bytes(11)), Variant::Raw);
    let anchor = "12".repeat(32);
    let mut rng = Rng::new(0xDEAD_BEEF_CAFE_0001);

    for case in 0..40u64 {
        let total_dust = rng.range(0, 120) as usize;
        let real_pos = if total_dust == 0 { 0 } else { rng.range(0, (total_dust + 1) as u64) as usize };
        let mut all_slots: Vec<(u32, u64, u64, bool)> = Vec::with_capacity(total_dust + 1);
        let mut cur_slot = 1u32;
        for i in 0..=total_dust {
            cur_slot += rng.range(1, 7) as u32;
            if i == real_pos {
                all_slots.push((cur_slot, 10_000_000, 50_000 + case, false));
            } else {
                let empty = rng.range(0, 6) == 0;
                all_slots.push((cur_slot, 1, 1 + i as u64, empty));
            }
        }
        let real_slot = all_slots[real_pos].0;
        let real_creation = all_slots[real_pos].2;
        let expected_non_empty = all_slots.iter().filter(|s| !s.3).count();

        let slots_ref = &all_slots;
        let auth = &pub_.claim_authority;
        let anc = &anchor;
        let rpc = ClosureRpc(|method: &str, params: &Value| match method {
            "paranoid_blockCount" => Ok(json!(300_020)),
            "paranoid_getEpochAnchor" => Ok(json!(anc)),
            "paranoid_estimateFeeDetailed" => Ok(json!({"fee_micronoid": 5800})),
            "paranoid_getMempoolStats" => Ok(json!({"fee_floor": 5000})),
            "paranoid_getObjectInstances" => {
                let from_slot = params[1].as_u64().unwrap() as u32;
                let limit = params[2].as_u64().unwrap() as usize;
                let matching: Vec<_> = slots_ref.iter().copied().filter(|s| s.0 >= from_slot).collect();
                let page = &matching[..matching.len().min(limit)];
                let next_slot = matching.get(limit).map(|s| s.0);
                let json_slots: Vec<Value> = page
                    .iter()
                    .map(|(idx, val, cid, empty)| json!({"slot_index": idx, "value": val, "creation_id": cid, "empty": empty}))
                    .collect();
                Ok(json!({"height": 300_020, "slots": json_slots, "next_slot": next_slot}))
            }
            "paranoid_getObjectStatus" => Ok(json!({
                "matches_opening": true,
                "active_authority": auth,
                "tip_height": 300_020
            })),
            "paranoid_getMempoolInfo" => Ok(json!({"txs": []})),
            "paranoid_getBlockHeader" => Ok(json!({"timestamp": 1_700_000_000u64})),
            other => Err(RpcError::Remote { code: -32601, message: other.into() }),
        });

        let obs = NoidWatcher::new(&rpc, pub_.opening_hex.clone())
            .observe(None)
            .unwrap_or_else(|e| panic!("case {case}: unexpected error {e}"));
        assert_eq!(obs.instances.len(), expected_non_empty, "case {case}: non-empty count mismatch");
        assert!(
            obs.instances
                .iter()
                .any(|s| s.instance.slot_index == real_slot && s.instance.creation_id == real_creation && s.instance.amount_micronoid == 10_000_000),
            "case {case}: real instance at slot {real_slot} missing"
        );
    }
}

#[test]
fn adversarial_noid_pagination_rejects_stalled_and_regressing_cursors() {
    let pub_ = example_public(&Secret::from_bytes(seq_bytes(12)), Variant::Raw);
    for (label, bad_next) in [("same_cursor_0", 0u32), ("regressing_cursor", 5u32)] {
        let rpc = ClosureRpc(|method: &str, params: &Value| match method {
            "paranoid_blockCount" => Ok(json!(300_020)),
            "paranoid_getEpochAnchor" => Ok(json!("33".repeat(32))),
            "paranoid_estimateFeeDetailed" => Ok(json!({"fee_micronoid": 5800})),
            "paranoid_getMempoolStats" => Ok(json!({"fee_floor": 5000})),
            "paranoid_getObjectInstances" => {
                let from = params[1].as_u64().unwrap() as u32;
                let next = if from == 0 && bad_next > 0 { 10 } else { bad_next };
                Ok(json!({
                    "height": 300_020,
                    "slots": [{"slot_index": from.max(1), "value": 1, "creation_id": 1, "empty": false}],
                    "next_slot": next
                }))
            }
            "paranoid_getObjectStatus" => Ok(json!({"matches_opening": true, "active_authority": pub_.claim_authority})),
            "paranoid_getMempoolInfo" => Ok(json!({"txs": []})),
            "paranoid_getBlockHeader" => Ok(json!({"timestamp": 1_700_000_000u64})),
            other => Err(RpcError::Remote { code: -32601, message: other.into() }),
        });
        let err = NoidWatcher::new(&rpc, pub_.opening_hex.clone())
            .observe(None)
            .expect_err(&format!("{label}: must fail closed on non-advancing cursor"));
        assert!(err.to_string().contains("advance"), "{label}: unexpected error {err}");
    }
}

// ------------------------------------------------------------------ 2. Hostile ETH discovery logs

#[test]
fn fuzz_eth_discovery_skips_mixed_hostile_logs_and_finds_valid_lock() {
    let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("fixtures/eth/locked.json");
    let base_fx: Fixture = serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
    let contract: [u8; 20] = hex::decode("5fbdb2315678afecb367f032d93f642f64180aa3").unwrap().try_into().unwrap();
    let bob: [u8; 20] = hex::decode("70997970c51812dc3a010c7d01b50e0d17dc79c8").unwrap().try_into().unwrap();
    let alice: [u8; 20] = hex::decode("3c44cdddb6a900fa2b585dd299e03d12fa4293bc").unwrap().try_into().unwrap();
    let hashlock = sha256(&seq_bytes(0));
    let hl_hex = hex::encode(hashlock);

    let hostile_payloads: Vec<(&str, Value)> = vec![
        ("timelock_u64_max_plus_1", json!(format!("0x{:064x}{}{:0>64}", 1u64, hl_hex, "10000000000000000"))),
        ("timelock_2_pow_255", json!(format!("0x{:064x}{}{}", 1u64, hl_hex, "80".to_string() + &"00".repeat(31)))),
        ("amount_u128_max_plus_1", json!(format!("0x{:0>64}{}{:064x}", "100000000000000000000000000000000", hl_hex, 1_700_000_000u64))),
        ("wrong_hashlock", json!(format!("0x{:064x}{}{:064x}", 1_000_000u64, "ff".repeat(32), 1_700_000_000u64))),
    ];

    let mut fx = base_fx.clone();
    let mut injected = false;
    for call in &mut fx.calls {
        if call.method == "eth_getLogs" {
            if let Some(arr) = call.result.as_mut().and_then(Value::as_array_mut) {
                if let Some(valid_log) = arr.first().cloned() {
                    let mut mixed = Vec::new();
                    for (idx, (_, data)) in hostile_payloads.iter().enumerate() {
                        let mut h = valid_log.clone();
                        h["topics"][1] = json!(format!("0x{:064x}", idx + 100));
                        h["data"] = data.clone();
                        mixed.push(h);
                    }
                    let mid = mixed.len() / 2;
                    mixed.insert(mid, valid_log);
                    *arr = mixed;
                    injected = true;
                    break;
                }
            }
        }
    }
    assert!(injected);

    let rpc = FixtureRpc::from_fixture("hostile-mixed-logs", fx);
    let obs = EthWatcher::new(&rpc, contract, [0u8; 32])
        .with_discovery(LockDiscovery { sender: bob, receiver: alice, hashlock })
        .observe()
        .expect("discovery must skip out-of-range u64/u128 and wrong-hashlock logs");
    assert!(obs.lock.is_some(), "valid lock buried among overflow logs must still be found");

    // Conversely, a matching-hashlock log whose lockId does not recompute from its fields must fail closed.
    let mut forged_fx = base_fx;
    for call in &mut forged_fx.calls {
        if call.method == "eth_getLogs" {
            if let Some(arr) = call.result.as_mut().and_then(Value::as_array_mut) {
                if let Some(first) = arr.first_mut() {
                    first["topics"][1] = json!(format!("0x{}", "ee".repeat(32)));
                    break;
                }
            }
        }
    }
    let forged_rpc = FixtureRpc::from_fixture("forged-lock-id", forged_fx);
    assert!(
        EthWatcher::new(&forged_rpc, contract, [0u8; 32])
            .with_discovery(LockDiscovery { sender: bob, receiver: alice, hashlock })
            .observe()
            .is_err(),
        "forged lockId with matching hashlock must fail closed"
    );
}

// ------------------------------------------------------------------ 3. Primary vs. Node-2 disagreement matrix

#[test]
fn adversarial_eth_and_noid_two_node_disagreement_matrix() {
    let secret = Secret::from_bytes(seq_bytes(21));
    let pub_ = example_public_kind(&secret, Variant::Raw, ProfileName::Production, ContractVersion::V1, LockKind::Poseidon);
    let code_hash = swap_cli::params::HTLC_POSEIDON_V2_CODE_HASH;
    let now = 1_700_000_000u64;
    let t_reveal = now + 7_200;

    let mut alice_file = SwapFile::new_alice(pub_.clone(), &secret, &Passphrase::new("pw"), &KdfParams::fast_for_tests(), now).unwrap();
    let inst = NoidInstance { slot_index: 9, creation_id: 42, amount_micronoid: pub_.params.amount_micronoid };
    alice_file.phase = Phase::Alice(AlicePhase::FundingFinal { instance: inst.clone(), final_at_tip: 300_020 });

    let lock_word = pub_.hashlock;
    let lock_id = swap_cli::watch::eth::compute_lock_id(
        &pub_.params.eth.bob_sender,
        &pub_.params.eth.alice_receiver,
        pub_.params.eth.amount_wei,
        &lock_word,
        t_reveal,
    );
    let good_lock = EthLock {
        lock_id,
        sender: pub_.params.eth.bob_sender,
        receiver: pub_.params.eth.alice_receiver,
        amount_wei: pub_.params.eth.amount_wei,
        hashlock: lock_word,
        timelock: t_reveal,
        block_number: 100,
        tx_hash: [0x55u8; 32],
        block_timestamp: Some(now),
        claimed: false,
        refunded: false,
        sender_is_eoa: Some(true),
        receiver_is_eoa: Some(true),
    };
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
    let make_noid = |tip: u64| NoidObservation {
        observed_at: Some(now),
        tip,
        next_call_height: tip + 1,
        tip_time: Some(now),
        epoch_anchor: Some([0x77u8; 32]),
        instance: Some(inst.clone()),
        instance_matches_opening: Some(true),
        active_authority: Some(pub_.claim_authority.clone()),
        instances: vec![NoidInstanceStatus {
            instance: inst.clone(),
            matches_opening: Some(true),
            active_authority: Some(pub_.claim_authority.clone()),
        }],
        instance_count: 1,
        ..Default::default()
    };

    // Baseline: both nodes agree -> Alice reveals.
    let mut baseline_eth = make_eth(good_lock.clone());
    baseline_eth.second = Some(Box::new(make_eth(good_lock.clone())));
    let mut baseline_noid = make_noid(300_025);
    baseline_noid.second = Some(Box::new(make_noid(300_025)));
    let base_dec = engine::decide(&alice_file, &baseline_noid, &baseline_eth, now);
    assert!(matches!(base_dec.action, Action::RevealEth { .. }), "baseline must reveal: {:?}", base_dec.action);

    // Every single security mutation on ETH node 2 must block RevealEth.
    let eth_mutations: Vec<(&str, Box<dyn Fn(&mut EthLock)>)> = vec![
        ("unfinalized_block_number", Box::new(|l| l.block_number = 180)),
        ("wrong_sender", Box::new(|l| l.sender[0] ^= 0xff)),
        ("wrong_receiver", Box::new(|l| l.receiver[0] ^= 0xff)),
        ("wrong_hashlock", Box::new(|l| l.hashlock[0] ^= 0xff)),
        ("wrong_amount", Box::new(|l| l.amount_wei -= 1)),
        ("wrong_timelock", Box::new(|l| l.timelock -= 60)),
        ("sender_not_eoa", Box::new(|l| l.sender_is_eoa = Some(false))),
        ("receiver_not_eoa", Box::new(|l| l.receiver_is_eoa = Some(false))),
        ("already_claimed", Box::new(|l| l.claimed = true)),
        ("already_refunded", Box::new(|l| l.refunded = true)),
    ];
    for (name, mutate) in eth_mutations {
        let mut bad_lock = good_lock.clone();
        mutate(&mut bad_lock);
        let mut eth = make_eth(good_lock.clone());
        eth.second = Some(Box::new(make_eth(bad_lock)));
        let dec = engine::decide(&alice_file, &baseline_noid, &eth, now);
        assert!(
            !matches!(dec.action, Action::RevealEth { .. }),
            "eth node-2 mutation '{name}' must block RevealEth, got {:?}",
            dec.action
        );
    }

    // Bob's lock_eth: every single security mutation on NOID node 2 must block LockEth.
    let bob_terms = BobTerms {
        variant: Variant::Raw,
        profile: ProfileName::Production,
        contract_version: ContractVersion::V1,
        lock_kind: LockKind::Poseidon,
        bob_noid: Address::parse(&pub_.params.bob_noid).unwrap(),
        amount_micronoid: pub_.params.amount_micronoid,
        eth_chain_id: 1,
        eth_contract: pub_.params.eth.contract,
        eth_code_hash: code_hash,
        eth_amount_wei: pub_.params.eth.amount_wei,
        bob_sender: pub_.params.eth.bob_sender,
    };
    let mut bob_file = SwapFile::new_bob_with(pub_.clone(), &bob_terms, None, now).unwrap();
    bob_file.phase = Phase::Bob(BobPhase::FundingFinal { instance: inst.clone(), final_at_tip: 300_020 });
    let mut empty_eth = EthObservation {
        observed_at: Some(now),
        chain_id: Some(1),
        contract_code_hash: Some(code_hash),
        latest_block: 205,
        latest_timestamp: now,
        finalized_block: Some(150),
        finalized_timestamp: Some(now),
        ..Default::default()
    };
    empty_eth.second = Some(Box::new(empty_eth.clone()));

    let noid_mutations: Vec<(&str, Box<dyn Fn(&mut NoidObservation)>)> = vec![
        ("opening_mismatch", Box::new(|n| { n.instance_matches_opening = Some(false); n.instances[0].matches_opening = Some(false); })),
        ("wrong_authority", Box::new(|n| { n.active_authority = Some("o1wrong".into()); n.instances[0].active_authority = Some("o1wrong".into()); })),
        ("missing_tip_time", Box::new(|n| n.tip_time = None)),
        ("epoch_anchor_mismatch", Box::new(|n| n.epoch_anchor = Some([0x99u8; 32]))),
        ("tip_skew_too_large", Box::new(|n| { n.tip += 10; n.next_call_height += 10; })),
        ("instance_count_mismatch", Box::new(|n| n.instance_count = 2)),
    ];
    for (name, mutate) in noid_mutations {
        let mut bad_noid2 = make_noid(300_025);
        mutate(&mut bad_noid2);
        let mut noid = make_noid(300_025);
        noid.second = Some(Box::new(bad_noid2));
        let dec = engine::decide(&bob_file, &noid, &empty_eth, now);
        assert!(
            !matches!(dec.action, Action::LockEth { .. }),
            "noid node-2 mutation '{name}' must block LockEth, got {:?}",
            dec.action
        );
    }
}

// ------------------------------------------------------------------ 4. URL / SSRF / credential-smuggling fuzz

#[test]
fn adversarial_http_url_and_loopback_guards() {
    let must_reject_parse = [
        "",
        "   ",
        "ftp://127.0.0.1:9601",
        "file:///etc/passwd",
        "http://user:pass@127.0.0.1:9601/",
        "http://127.0.0.1@evil.example/",
        "http:///",
        "http://:9601/",
        "http://[::1:9601/",
        "http://[::1]junk/",
        "http://127.0.0.1:99999/",
        "http://127.0.0.1:abc/",
    ];
    for u in must_reject_parse {
        assert!(HttpUrl::parse(u).is_err(), "HttpUrl::parse must reject {u:?}");
    }

    let must_not_be_loopback = [
        "",
        "https://127.0.0.1:9601",
        "http://127.0.0.1@evil.example:9601",
        "http://127.0.0.1.evil.example:9601",
        "http://localhost.evil.example:9601",
        "http://0.0.0.0:9601",
        "http://169.254.169.254/latest/meta-data",
        "http://10.0.0.1:9601",
        "http://[::ffff:127.0.0.1]:9601",
    ];
    for u in must_not_be_loopback {
        assert!(!is_loopback_http(u), "is_loopback_http must be false for {u:?}");
    }

    assert!(is_loopback_http("http://127.0.0.1:9601"));
    assert!(is_loopback_http("http://[::1]:9601/"));
    assert!(is_loopback_http("HTTP://LOCALHOST:8545"));

    assert_eq!(
        normalize_endpoint("https://RPC.Example.COM:443/"),
        normalize_endpoint("https://rpc.example.com")
    );
}

// ------------------------------------------------------------------ 5. Chaotic decide() invariant fuzz

#[test]
fn fuzz_engine_decide_never_panics_and_respects_cutoff_invariants() {
    let secret = Secret::from_bytes(seq_bytes(33));
    let pub_ = example_public_kind(&secret, Variant::Raw, ProfileName::Sepolia, ContractVersion::V1, LockKind::Poseidon);
    let code_hash = swap_cli::params::HTLC_POSEIDON_V2_CODE_HASH;
    let now_base = 1_700_000_000u64;

    let mut alice = SwapFile::new_alice(pub_.clone(), &secret, &Passphrase::new("pw"), &KdfParams::fast_for_tests(), now_base).unwrap();
    let inst = NoidInstance { slot_index: 3, creation_id: 7, amount_micronoid: pub_.params.amount_micronoid };
    alice.phase = Phase::Alice(AlicePhase::FundingFinal { instance: inst.clone(), final_at_tip: 300_020 });

    let mut rng = Rng::new(0x5A17_C0DE_1234_5678);
    for _ in 0..200 {
        let now = now_base.saturating_add(rng.range(0, 20_000));
        let tip = rng.range(299_900, 301_500);
        let latest_block = rng.range(10, 500);
        let finalized = if rng.range(0, 5) == 0 { None } else { Some(latest_block.saturating_sub(rng.range(0, 80))) };
        let lock_block = rng.range(1, 500);
        let timelock = now_base + rng.range(0, 15_000);
        let claimed = rng.range(0, 6) == 0;
        let refunded = !claimed && rng.range(0, 6) == 0;

        let lock = EthLock {
            lock_id: [0x22; 32],
            sender: pub_.params.eth.bob_sender,
            receiver: pub_.params.eth.alice_receiver,
            amount_wei: pub_.params.eth.amount_wei,
            hashlock: pub_.hashlock,
            timelock,
            block_number: lock_block,
            tx_hash: [0x33; 32],
            block_timestamp: Some(now),
            claimed,
            refunded,
            sender_is_eoa: Some(rng.range(0, 5) != 0),
            receiver_is_eoa: Some(rng.range(0, 5) != 0),
        };
        let mut eth = EthObservation {
            observed_at: Some(now),
            chain_id: Some(if rng.range(0, 8) == 0 { 1 } else { 11_155_111 }),
            contract_code_hash: Some(code_hash),
            latest_block,
            latest_timestamp: now,
            finalized_block: finalized,
            finalized_timestamp: finalized.map(|_| now),
            lock: Some(lock.clone()),
            locks: vec![lock.clone()],
            lock_count: 1,
            ..Default::default()
        };
        if rng.range(0, 2) == 0 {
            eth.second = Some(Box::new(eth.clone()));
        }
        let noid = NoidObservation {
            observed_at: Some(now),
            tip,
            next_call_height: tip + 1,
            tip_time: Some(now),
            instance: Some(inst.clone()),
            instance_matches_opening: Some(rng.range(0, 7) != 0),
            active_authority: Some(pub_.claim_authority.clone()),
            instances: vec![NoidInstanceStatus {
                instance: inst.clone(),
                matches_opening: Some(true),
                active_authority: Some(pub_.claim_authority.clone()),
            }],
            instance_count: 1,
            ..Default::default()
        };

        let dec = engine::decide(&alice, &noid, &eth, now);
        if matches!(dec.action, Action::RevealEth { .. }) {
            assert_eq!(eth.chain_id, Some(11_155_111));
            assert!(finalized.unwrap_or(0) >= lock_block, "revealed on unfinalized lock");
            assert!(!claimed && !refunded, "revealed on already closed lock");
            let margin = pub_.params.profile.gates().m_a_s;
            assert!(now + margin <= timelock, "revealed past cutoff: now={now} margin={margin} timelock={timelock}");
        }
    }
}

// ------------------------------------------------------------------ 6. Concurrent HashlockRegistry locking

#[test]
fn adversarial_hashlock_registry_concurrent_race_allows_exactly_one_winner() {
    let dir = tempfile::tempdir().unwrap();
    let reg_path = dir.path().join("hashlocks.txt");
    let hl = [0xABu8; 32];
    let threads = 8usize;
    let barrier = Arc::new(Barrier::new(threads));
    let mut handles = Vec::with_capacity(threads);

    for _ in 0..threads {
        let p = reg_path.clone();
        let b = Arc::clone(&barrier);
        handles.push(thread::spawn(move || {
            let reg = HashlockRegistry::new(p);
            b.wait();
            reg.register(&hl).is_ok()
        }));
    }

    let winners: usize = handles.into_iter().map(|h| usize::from(h.join().unwrap())).sum();
    assert_eq!(winners, 1, "exactly one thread may register a given hashlock");
    let reg = HashlockRegistry::new(reg_path);
    assert!(reg.contains(&hl).unwrap());
}
