//! Stale-backup restore tests covering the phase-walk cases and watcher-level
//! stuck-reveal / mined-reveal handling for Alice's fresh per-swap Ethereum key.
//!
//! Each stale-backup case saves a snapshot of the swap file at an earlier phase,
//! lets the other copy advance the chains (or leave pending transactions), restores
//! the stale snapshot, and verifies the engine's decisions and final state.
//!
//! The watcher-level tests drive the real `EthWatcher::observe()` over a mock
//! JSON-RPC server (without setting `pending_preimage` or history markers by hand).

mod common;

use std::cell::Cell;
use std::path::PathBuf;

thread_local! {
    static TEST_CLOCK: Cell<u64> = const { Cell::new(0) };
}

fn test_clock() -> u64 {
    TEST_CLOCK.with(|c| c.get())
}

fn observe_with_clock(node: MockEthNode, contract: [u8; 20], lock_id: [u8; 32], signer: [u8; 20], now: u64) -> swap_cli::watch::EthObservation {
    TEST_CLOCK.with(|c| c.set(now));
    EthWatcher::new(node, contract, lock_id)
        .with_signer(signer)
        .with_clock(test_clock)
        .observe()
        .unwrap()
}

use common::*;
use serde_json::{json, Value};
use swap_cli::engine::{external_close_event, reveal_cutoff_for, secret_may_be_public, tick_apply, IntentStatus, REVEAL_MAYBE_PENDING, REVEAL_REVERTED_SEEN};
use swap_cli::ethkey::EthKey;
use swap_cli::params::W_A_S;
use swap_cli::secret::{Secret, Variant};
use swap_cli::state::{AlicePhase, BobPhase, Event, Phase};
use swap_cli::swapfile::{KdfParams, Passphrase, SwapFile};
use swap_cli::watch::eth::{EthWatcher, TOPIC_CLAIMED, TOPIC_LOCKED};
use swap_cli::watch::{ConfirmedTx, JsonRpc, RpcError};

fn clone_file(src: &SwapFile) -> SwapFile {
    let json = serde_json::to_vec(src).unwrap();
    serde_json::from_slice(&json).unwrap()
}

fn attach_alice_eth_key(file: SwapFile) -> SwapFile {
    let addr = file.public.params.eth.alice_receiver;
    let key = EthKey::new(Secret::from_bytes([0x42; 32]), addr).unwrap();
    let payout = [0x99; 20];
    file.with_eth_key(&key, &payout, &Passphrase::new("pw"), &KdfParams::fast_for_tests())
        .unwrap()
}

fn alice_obs_and_tick(s: &Scenario, f: &mut SwapFile) -> swap_cli::engine::TickOutcome {
    let noid = s.world.borrow().noid_obs(None);
    let eth = s.world.borrow().eth_obs();
    let now = s.now();
    tick_apply(f, &noid, &eth, now, true).unwrap()
}

fn bob_obs_and_tick(s: &Scenario, f: &mut SwapFile) -> swap_cli::engine::TickOutcome {
    let noid = s.world.borrow().noid_obs(None);
    let eth = s.world.borrow().eth_obs();
    let now = s.now();
    tick_apply(f, &noid, &eth, now, true).unwrap()
}

/// Real `JsonRpc` mock backed by the compiled HTLC runtime bytecode from `fixtures/eth/locked.json`.
/// Answers the exact JSON-RPC methods `EthWatcher::observe()` calls, including
/// `eth_getTransactionCount(alice_receiver, "latest" | "pending")`, `eth_getLogs`, and `getLock`.
struct MockEthNode {
    chain_id: u64,
    contract: [u8; 20],
    contract_code: String,
    bob: [u8; 20],
    alice: [u8; 20],
    amount_wei: u128,
    hashlock: [u8; 32],
    timelock: u64,
    lock_id: [u8; 32],
    lock_block: u64,
    lock_ts: u64,
    latest_block: u64,
    latest_ts: u64,
    finalized_block: u64,
    alice_nonce_latest: u64,
    alice_nonce_pending: u64,
    claimed: Option<([u8; 32], u64)>, // (preimage, claim_block)
}

impl MockEthNode {
    fn from_swap(file: &SwapFile, lock_id: [u8; 32], timelock: u64, lock_block: u64, lock_ts: u64, latest_block: u64, latest_ts: u64, finalized_block: u64) -> Self {
        let fx_path = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("fixtures/eth/locked.json");
        let fx: Value = serde_json::from_str(&std::fs::read_to_string(&fx_path).unwrap()).unwrap();
        let contract_code = fx["calls"]
            .as_array()
            .unwrap()
            .iter()
            .find(|c| c["method"] == "eth_getCode")
            .unwrap()["result"]
            .as_str()
            .unwrap()
            .to_string();
        let p = &file.public.params.eth;
        Self {
            chain_id: p.chain_id,
            contract: p.contract,
            contract_code,
            bob: p.bob_sender,
            alice: p.alice_receiver,
            amount_wei: p.amount_wei,
            hashlock: file.public.hashlock,
            timelock,
            lock_id,
            lock_block,
            lock_ts,
            latest_block,
            latest_ts,
            finalized_block,
            alice_nonce_latest: 0,
            alice_nonce_pending: 0,
            claimed: None,
        }
    }

    fn hex0x(b: &[u8]) -> String {
        format!("0x{}", hex::encode(b))
    }

    fn pad_addr(a: &[u8; 20]) -> String {
        let mut w = [0u8; 32];
        w[12..].copy_from_slice(a);
        Self::hex0x(&w)
    }

    fn pad_u128(v: u128) -> [u8; 32] {
        let mut w = [0u8; 32];
        w[16..].copy_from_slice(&v.to_be_bytes());
        w
    }

    fn pad_u64(v: u64) -> [u8; 32] {
        let mut w = [0u8; 32];
        w[24..].copy_from_slice(&v.to_be_bytes());
        w
    }

    fn encode_get_lock(&self) -> String {
        let mut out = Vec::with_capacity(8 * 32);
        let mut sender = [0u8; 32];
        sender[12..].copy_from_slice(&self.bob);
        let mut recv = [0u8; 32];
        recv[12..].copy_from_slice(&self.alice);
        out.extend_from_slice(&sender);
        out.extend_from_slice(&recv);
        out.extend_from_slice(&Self::pad_u128(self.amount_wei));
        out.extend_from_slice(&self.hashlock);
        out.extend_from_slice(&Self::pad_u64(self.timelock));
        out.extend_from_slice(&Self::pad_u64(u64::from(self.claimed.is_some())));
        out.extend_from_slice(&Self::pad_u64(0)); // refunded = false
        out.extend_from_slice(&self.claimed.map(|(p, _)| p).unwrap_or([0u8; 32]));
        Self::hex0x(&out)
    }

    fn locked_log(&self) -> Value {
        let mut data = Vec::with_capacity(96);
        data.extend_from_slice(&Self::pad_u128(self.amount_wei));
        data.extend_from_slice(&self.hashlock);
        data.extend_from_slice(&Self::pad_u64(self.timelock));
        json!({
            "address": Self::hex0x(&self.contract),
            "topics": [
                Self::hex0x(&TOPIC_LOCKED),
                Self::hex0x(&self.lock_id),
                Self::pad_addr(&self.bob),
                Self::pad_addr(&self.alice),
            ],
            "data": Self::hex0x(&data),
            "blockNumber": format!("0x{:x}", self.lock_block),
            "transactionHash": format!("0x{}", hex::encode([0x11u8; 32])),
            "removed": false,
        })
    }

    fn claimed_log(&self, preimage: [u8; 32], block: u64) -> Value {
        json!({
            "address": Self::hex0x(&self.contract),
            "topics": [
                Self::hex0x(&TOPIC_CLAIMED),
                Self::hex0x(&self.lock_id),
            ],
            "data": Self::hex0x(&preimage),
            "blockNumber": format!("0x{:x}", block),
            "transactionHash": format!("0x{}", hex::encode([0x22u8; 32])),
            "removed": false,
        })
    }
}

impl JsonRpc for MockEthNode {
    fn call(&self, method: &str, params: Value) -> Result<Value, RpcError> {
        match method {
            "eth_chainId" => Ok(json!(format!("0x{:x}", self.chain_id))),
            "eth_blockNumber" => Ok(json!(format!("0x{:x}", self.latest_block))),
            "eth_getCode" => {
                let addr = params[0].as_str().unwrap_or("").to_ascii_lowercase();
                if addr == Self::hex0x(&self.contract) {
                    Ok(json!(self.contract_code))
                } else {
                    Ok(json!("0x"))
                }
            }
            "eth_getBlockByNumber" => {
                let tag = params[0].as_str().unwrap_or("");
                let (num, ts) = match tag {
                    "latest" => (self.latest_block, self.latest_ts),
                    "finalized" => (self.finalized_block, self.latest_ts.saturating_sub(24)),
                    hex_n => {
                        let n = u64::from_str_radix(hex_n.trim_start_matches("0x"), 16).unwrap_or(self.lock_block);
                        (n, if n == self.lock_block { self.lock_ts } else { self.latest_ts })
                    }
                };
                Ok(json!({
                    "number": format!("0x{:x}", num),
                    "timestamp": format!("0x{:x}", ts),
                }))
            }
            "eth_getLogs" => {
                let mut logs = vec![self.locked_log()];
                if let Some((preimage, cblk)) = self.claimed {
                    logs.push(self.claimed_log(preimage, cblk));
                }
                Ok(Value::Array(logs))
            }
            "eth_call" => Ok(json!(self.encode_get_lock())),
            "eth_getTransactionCount" => {
                let tag = params[1].as_str().unwrap_or("latest");
                let n = if tag == "pending" { self.alice_nonce_pending } else { self.alice_nonce_latest };
                Ok(json!(format!("0x{:x}", n)))
            }
            other => Err(RpcError::Decode(format!("unexpected RPC method {other}"))),
        }
    }
}

fn setup_alice_at_lock_final_with_eth_key() -> (Scenario, SwapFile, [u8; 32], u64, u64) {
    let mut s = Scenario::new(Variant::Raw);
    s.tick_alice();
    s.world.borrow_mut().advance_noid(1);
    s.tick_both();
    s.world.borrow_mut().advance_noid(18);
    s.tick_both(); // Bob locks
    s.world.borrow_mut().advance_eth(4); // lock finalized

    // Take a backup at lock_final with NO held reveal_eth intent and NO pending markers.
    let mut backup = clone_file(&s.alice.file);
    let _ = alice_obs_and_tick(&s, &mut backup);
    backup.pending_intent = None;
    backup.pending_action = None;
    backup.history.retain(|h| h.event != "intent_decided:reveal_eth" && h.event != REVEAL_MAYBE_PENDING);
    backup = attach_alice_eth_key(backup);
    assert_eq!(backup.phase.name(), "lock_final");
    let lock = match &backup.phase {
        Phase::Alice(AlicePhase::LockFinal { lock, .. }) => lock.clone(),
        other => panic!("expected LockFinal, got {other:?}"),
    };
    let lock_block = s.world.borrow().eth_obs().lock.as_ref().unwrap().block_number;
    (s, backup, lock.lock_id, lock.t_reveal, lock_block)
}

// =========================================================================
// Watcher-level stuck-reveal and mined-reveal tests (no hand-set markers)
// =========================================================================

#[test]
fn f1_watcher_pending_nonce_1_records_reveal_maybe_pending_before_and_after_m_a_cutoff() {
    let (s, backup, lock_id, t_reveal, lock_block) = setup_alice_at_lock_final_with_eth_key();
    let g = backup.public.params.profile.gates();
    let now_before = s.now();
    assert!(now_before + g.m_a_s < t_reveal, "must start before M_A cutoff");

    // Primary node fixture reports latest nonce 0, pending nonce 1 for Alice's swap key (NO pending_preimage).
    let mut node_before = MockEthNode::from_swap(&backup, lock_id, t_reveal, lock_block, now_before - 60, lock_block + 4, now_before, lock_block + 2);
    node_before.alice_nonce_latest = 0;
    node_before.alice_nonce_pending = 1;
    let eth_before = observe_with_clock(node_before, backup.public.params.eth.contract, lock_id, backup.public.params.eth.alice_receiver, now_before);
    assert!(eth_before.pending_preimage.is_none(), "watcher did not see pending_preimage");
    assert_eq!((eth_before.signer_nonce_latest, eth_before.signer_nonce_pending), (Some(0), Some(1)));

    // Case A: BEFORE M_A cutoff in lock_final -> records reveal_maybe_pending, late cutoff applies, waits with --replace note (no new reveal intent).
    let mut before = clone_file(&backup);
    let noid = s.world.borrow().noid_obs(None);
    let out_before = tick_apply(&mut before, &noid, &eth_before, now_before, true).unwrap();
    assert!(before.history.iter().any(|h| h.event == REVEAL_MAYBE_PENDING), "must record reveal_maybe_pending: {:?}", before.history);
    assert!(secret_may_be_public(&before));
    assert_eq!(reveal_cutoff_for(&before, t_reveal), t_reveal - g.de_s);
    assert_eq!(out_before.decision.action.kind(), "wait", "must not auto-offer plain reveal while nonce 0 is pending");
    assert!(before.pending_intent.is_none(), "must not record a fresh reveal_eth intent");
    assert!(out_before.decision.notes.iter().any(|n| n.contains("--replace")), "notes: {:?}", out_before.decision.notes);

    // Case B: AFTER M_A cutoff (before T_reveal - DE) -> records reveal_maybe_pending, late cutoff applies (not refused!).
    let past_ma_now = t_reveal - g.m_a_s + 60;
    assert!(past_ma_now + g.de_s < t_reveal);
    let mut node_after = MockEthNode::from_swap(&backup, lock_id, t_reveal, lock_block, now_before - 60, lock_block + 10, past_ma_now, lock_block + 8);
    node_after.alice_nonce_latest = 0;
    node_after.alice_nonce_pending = 1;
    let eth_after = observe_with_clock(node_after, backup.public.params.eth.contract, lock_id, backup.public.params.eth.alice_receiver, past_ma_now);
    let mut noid_after = s.world.borrow().noid_obs(None);
    noid_after.observed_at = Some(past_ma_now);
    noid_after.tip_time = Some(past_ma_now);
    if let Some(sec) = noid_after.second.as_deref_mut() {
        sec.observed_at = Some(past_ma_now);
        sec.tip_time = Some(past_ma_now);
    }

    let mut after = clone_file(&backup);
    let out_after = tick_apply(&mut after, &noid_after, &eth_after, past_ma_now, true).unwrap();
    assert!(after.history.iter().any(|h| h.event == REVEAL_MAYBE_PENDING));
    assert!(!out_after.decision.reveal_cutoff_passed, "late cutoff T_reveal - DE must apply past M_A");
    assert!(out_after.decision.notes.iter().any(|n| n.contains("past the M_A cutoff")), "notes: {:?}", out_after.decision.notes);
    assert!(out_after.decision.notes.iter().any(|n| n.contains("--replace")), "notes: {:?}", out_after.decision.notes);

    // If the pending tx later drops from the mempool (latest 0, pending 0) while still before T_reveal - DE,
    // reveal_maybe_pending stays in history and the engine offers reveal_eth with the late cutoff T_reveal - DE.
    let mut node_dropped = MockEthNode::from_swap(&after, lock_id, t_reveal, lock_block, now_before - 60, lock_block + 12, past_ma_now + 10, lock_block + 10);
    node_dropped.alice_nonce_latest = 0;
    node_dropped.alice_nonce_pending = 0;
    let mut eth_dropped = observe_with_clock(node_dropped, after.public.params.eth.contract, lock_id, after.public.params.eth.alice_receiver, past_ma_now + 10);
    let mut node_dropped2 = MockEthNode::from_swap(&after, lock_id, t_reveal, lock_block, now_before - 60, lock_block + 12, past_ma_now + 10, lock_block + 10);
    node_dropped2.alice_nonce_latest = 0;
    node_dropped2.alice_nonce_pending = 0;
    eth_dropped.second = Some(Box::new(observe_with_clock(
        node_dropped2,
        after.public.params.eth.contract,
        lock_id,
        after.public.params.eth.alice_receiver,
        past_ma_now + 10,
    )));
    let mut noid_dropped = noid_after.clone();
    noid_dropped.observed_at = Some(past_ma_now + 10);
    noid_dropped.tip_time = Some(past_ma_now + 10);
    if let Some(sec) = noid_dropped.second.as_deref_mut() {
        sec.observed_at = Some(past_ma_now + 10);
        sec.tip_time = Some(past_ma_now + 10);
    }
    let out_dropped = tick_apply(&mut after, &noid_dropped, &eth_dropped, past_ma_now + 10, true).unwrap();
    assert_eq!(out_dropped.decision.action.kind(), "reveal_eth");
    let IntentStatus::Recorded(intent) = &out_dropped.intent else { panic!("expected Recorded reveal_eth intent") };
    assert_eq!(intent.params["cutoff"], t_reveal - g.de_s);

    // Case C: lock_seen phase also records reveal_maybe_pending.
    let mut in_lock_seen = clone_file(&backup);
    if let Phase::Alice(AlicePhase::LockFinal { instance, lock }) = in_lock_seen.phase.clone() {
        in_lock_seen.phase = Phase::Alice(AlicePhase::LockSeen { instance, lock });
    }
    let mut node_seen = MockEthNode::from_swap(&in_lock_seen, lock_id, t_reveal, lock_block, now_before - 60, lock_block + 1, now_before, lock_block - 1);
    node_seen.alice_nonce_latest = 0;
    node_seen.alice_nonce_pending = 1;
    let eth_seen = observe_with_clock(node_seen, in_lock_seen.public.params.eth.contract, lock_id, in_lock_seen.public.params.eth.alice_receiver, now_before);
    let _ = tick_apply(&mut in_lock_seen, &noid, &eth_seen, now_before, true).unwrap();
    assert!(in_lock_seen.history.iter().any(|h| h.event == REVEAL_MAYBE_PENDING), "must also record in lock_seen");

    // Case D: Classic mode (no per-swap eth_key) must NOT record reveal_maybe_pending.
    let mut classic = clone_file(&backup);
    classic.eth_key = None;
    let _ = tick_apply(&mut classic, &noid, &eth_before, now_before, true).unwrap();
    assert!(!classic.history.iter().any(|h| h.event == REVEAL_MAYBE_PENDING), "classic mode must not use fresh-key nonce signal");
}

#[test]
fn f1_watcher_second_node_disagreement_records_nothing() {
    let (s, backup, lock_id, t_reveal, lock_block) = setup_alice_at_lock_final_with_eth_key();
    let g = backup.public.params.profile.gates();
    let past_ma_now = t_reveal - g.m_a_s + 60;
    let lock_ts = s.now() - 60;

    // Primary node sees latest=0, pending=1.
    let mut node1 = MockEthNode::from_swap(&backup, lock_id, t_reveal, lock_block, lock_ts, lock_block + 10, past_ma_now, lock_block + 8);
    node1.alice_nonce_latest = 0;
    node1.alice_nonce_pending = 1;
    let mut eth1 = observe_with_clock(node1, backup.public.params.eth.contract, lock_id, backup.public.params.eth.alice_receiver, past_ma_now);

    // Second node disagrees: latest=0, pending=0.
    let mut node2 = MockEthNode::from_swap(&backup, lock_id, t_reveal, lock_block, lock_ts, lock_block + 10, past_ma_now, lock_block + 8);
    node2.alice_nonce_latest = 0;
    node2.alice_nonce_pending = 0;
    let eth2 = observe_with_clock(node2, backup.public.params.eth.contract, lock_id, backup.public.params.eth.alice_receiver, past_ma_now);
    eth1.second = Some(Box::new(eth2));

    let mut noid_after = s.world.borrow().noid_obs(None);
    noid_after.observed_at = Some(past_ma_now);
    noid_after.tip_time = Some(past_ma_now);
    if let Some(sec) = noid_after.second.as_deref_mut() {
        sec.observed_at = Some(past_ma_now);
        sec.tip_time = Some(past_ma_now);
    }

    let mut file = clone_file(&backup);
    let out = tick_apply(&mut file, &noid_after, &eth1, past_ma_now, true).unwrap();
    assert!(!file.history.iter().any(|h| h.event == REVEAL_MAYBE_PENDING), "disagreement between nodes must record nothing");
    assert!(out.decision.reveal_cutoff_passed, "without agreement, strict M_A cutoff must still hold");
    assert_ne!(out.decision.action.kind(), "reveal_eth");
}

#[test]
fn f1_watcher_latest_nonce_1_mined_reveal_reverted_vs_claimed() {
    let (s, backup, lock_id, t_reveal, lock_block) = setup_alice_at_lock_final_with_eth_key();
    let g = backup.public.params.profile.gates();
    let now = s.now();
    let past_ma_now = t_reveal - g.m_a_s + 60;
    assert!(past_ma_now + g.de_s < t_reveal);

    // Helper: two agreeing Ethereum nodes reporting latest=1, pending=1, lock STILL OPEN (reverted reveal).
    let make_reverted_eth = |ts: u64, head: u64| {
        let mut n1 = MockEthNode::from_swap(&backup, lock_id, t_reveal, lock_block, now - 60, head, ts, head - 2);
        n1.alice_nonce_latest = 1;
        n1.alice_nonce_pending = 1;
        let mut e1 = observe_with_clock(n1, backup.public.params.eth.contract, lock_id, backup.public.params.eth.alice_receiver, ts);
        let mut n2 = MockEthNode::from_swap(&backup, lock_id, t_reveal, lock_block, now - 60, head, ts, head - 2);
        n2.alice_nonce_latest = 1;
        n2.alice_nonce_pending = 1;
        let e2 = observe_with_clock(n2, backup.public.params.eth.contract, lock_id, backup.public.params.eth.alice_receiver, ts);
        e1.second = Some(Box::new(e2));
        e1
    };

    let mut noid_past_ma = s.world.borrow().noid_obs(None);
    noid_past_ma.observed_at = Some(past_ma_now);
    noid_past_ma.tip_time = Some(past_ma_now);
    if let Some(sec) = noid_past_ma.second.as_deref_mut() {
        sec.observed_at = Some(past_ma_now);
        sec.tip_time = Some(past_ma_now);
    }

    // Subcase A (reverted reveal, restored / no held intent, past M_A cutoff before T_reveal - DE):
    // Both nodes report latest=1 while getLock shows lock still open -> treats as reverted reveal,
    // records REVEAL_REVERTED_SEEN, and offers reveal_eth under the late cutoff T_reveal - DE.
    let eth_rev_late = make_reverted_eth(past_ma_now, lock_block + 10);
    assert!(eth_rev_late.claimed.is_none());
    let mut restored_rev = clone_file(&backup);
    let out_rev = tick_apply(&mut restored_rev, &noid_past_ma, &eth_rev_late, past_ma_now, true).unwrap();
    assert!(
        restored_rev.history.iter().any(|h| h.event == REVEAL_REVERTED_SEEN),
        "must record reveal_reverted_seen when mined send left lock open: {:?}",
        restored_rev.history
    );
    assert!(secret_may_be_public(&restored_rev));
    assert_eq!(out_rev.decision.action.kind(), "reveal_eth", "must offer re-send after reverted reveal: {:?}", out_rev.decision);
    let IntentStatus::Recorded(intent) = &out_rev.intent else { panic!("expected Recorded reveal_eth intent") };
    assert_eq!(intent.params["cutoff"], t_reveal - g.de_s);

    // Subcase B (reverted reveal on a normal non-restored program-mode swap with a held reveal_eth intent):
    // First attempt recorded a reveal_eth intent and then reverted (latest=1, lock still open).
    // Next tick must record REVEAL_REVERTED_SEEN and keep fresh decision = reveal_eth (not Wait!).
    let mut normal_prog = clone_file(&backup);
    let eth_initial = {
        let mut n1 = MockEthNode::from_swap(&normal_prog, lock_id, t_reveal, lock_block, now - 60, lock_block + 4, now, lock_block + 2);
        n1.alice_nonce_latest = 0;
        n1.alice_nonce_pending = 0;
        let mut e1 = observe_with_clock(n1, normal_prog.public.params.eth.contract, lock_id, normal_prog.public.params.eth.alice_receiver, now);
        let mut n2 = MockEthNode::from_swap(&normal_prog, lock_id, t_reveal, lock_block, now - 60, lock_block + 4, now, lock_block + 2);
        n2.alice_nonce_latest = 0;
        n2.alice_nonce_pending = 0;
        let e2 = observe_with_clock(n2, normal_prog.public.params.eth.contract, lock_id, normal_prog.public.params.eth.alice_receiver, now);
        e1.second = Some(Box::new(e2));
        e1
    };
    let noid_now = s.world.borrow().noid_obs(None);
    let out_first = tick_apply(&mut normal_prog, &noid_now, &eth_initial, now, true).unwrap();
    assert_eq!(out_first.decision.action.kind(), "reveal_eth");
    assert!(normal_prog.pending_intent.is_some());

    // Now attempt 1 was mined and reverted (latest=1, lock still open), even past M_A cutoff.
    let out_held = tick_apply(&mut normal_prog, &noid_past_ma, &eth_rev_late, past_ma_now, true).unwrap();
    assert!(normal_prog.history.iter().any(|h| h.event == REVEAL_REVERTED_SEEN));
    assert!(!out_held.decision.reveal_cutoff_passed);
    assert!(
        out_held.decision.notes.iter().any(|n| n == "held: fresh decision was reveal_eth"),
        "held reveal_eth must stay offered for re-send after revert: {:?}",
        out_held.decision.notes
    );

    // Subcase C (two-node disagreement: primary sees latest=1 open, second sees latest=0):
    // Must record NOTHING and hold (never send a second reveal while nodes disagree).
    let mut eth_disagree = make_reverted_eth(now, lock_block + 5);
    eth_disagree.second.as_deref_mut().unwrap().signer_nonce_latest = Some(0);
    eth_disagree.second.as_deref_mut().unwrap().signer_nonce_pending = Some(0);
    let mut disagree_file = clone_file(&backup);
    let out_dis = tick_apply(&mut disagree_file, &noid_now, &eth_disagree, now, true).unwrap();
    assert!(!disagree_file.history.iter().any(|h| h.event == REVEAL_REVERTED_SEEN));
    assert_eq!(out_dis.decision.action.kind(), "wait");
    assert!(disagree_file.pending_intent.is_none());

    // Subcase D (mined successful reveal: latest=1 AND getLock + Claimed log show claimed & finalized):
    // Advances to revealed -> done, NEVER sends a second reveal.
    let mut node_claimed = MockEthNode::from_swap(&backup, lock_id, t_reveal, lock_block, now - 60, lock_block + 8, now + 24, lock_block + 7);
    node_claimed.alice_nonce_latest = 1;
    node_claimed.alice_nonce_pending = 1;
    node_claimed.claimed = Some((*s.secret.bytes(), lock_block + 5));
    let eth_claimed = observe_with_clock(node_claimed, backup.public.params.eth.contract, lock_id, backup.public.params.eth.alice_receiver, now + 24);
    assert!(eth_claimed.claimed.is_some());

    let mut noid2 = noid_now.clone();
    noid2.observed_at = Some(now + 24);
    noid2.tip_time = Some(now + 24);
    if let Some(sec) = noid2.second.as_deref_mut() {
        sec.observed_at = Some(now + 24);
        sec.tip_time = Some(now + 24);
    }
    let mut claimed_file = clone_file(&backup);
    let out1 = tick_apply(&mut claimed_file, &noid2, &eth_claimed, now + 24, true).unwrap();
    assert!(matches!(claimed_file.phase, Phase::Alice(AlicePhase::Revealed { .. } | AlicePhase::Done { .. })), "{}", claimed_file.phase.name());
    assert_ne!(out1.decision.action.kind(), "reveal_eth");
    let out2 = tick_apply(&mut claimed_file, &noid2, &eth_claimed, now + 24, true).unwrap();
    assert!(matches!(claimed_file.phase, Phase::Alice(AlicePhase::Done { .. })), "{}", claimed_file.phase.name());
    assert_ne!(out2.decision.action.kind(), "reveal_eth");
}

// =========================================================================
// T-S1: Stale-backup phase walk — Alice (all 10 rows of design §4.2)
// =========================================================================

#[test]
fn t_s1_alice_row01_created_nothing_offers_fund_noid() {
    let s = Scenario::new(Variant::Raw);
    let mut restored = clone_file(&s.alice.file);
    assert_eq!(restored.phase.name(), "created");

    let out = alice_obs_and_tick(&s, &mut restored);
    assert_eq!(restored.phase.name(), "created");
    assert_eq!(out.decision.action.kind(), "fund_noid");
}

#[test]
fn t_s1_alice_row02_created_old_funding_pending_waits_and_adopts_once_mined() {
    let mut s = Scenario::new(Variant::Raw);
    let mut restored = clone_file(&s.alice.file);
    assert_eq!(restored.phase.name(), "created");

    // Old copy submitted funding, currently unmined in the Parano1d mempool (the UI's restore quiet
    // hold waits 10 blocks while it mines; here we verify that once it lands on chain on the next block,
    // the restored copy adopts `funded` and never issues a second funding).
    s.tick_alice();
    assert!(s.world.borrow().funding_pending.is_some());
    assert!(s.world.borrow().instance.is_none());

    // Once the old copy's funding mines, restored copy adopts `funded` and never double-funds.
    s.world.borrow_mut().advance_noid(1);
    let out_mined = alice_obs_and_tick(&s, &mut restored);
    assert_eq!(restored.phase.name(), "funded");
    assert_eq!(out_mined.decision.action.kind(), "wait");
}

#[test]
fn t_s1_alice_row03_created_already_funded_adopts_funded_and_does_not_refound() {
    let mut s = Scenario::new(Variant::Raw);
    let mut restored = clone_file(&s.alice.file);
    assert_eq!(restored.phase.name(), "created");

    // Old copy funds and it lands on chain.
    s.tick_alice();
    s.world.borrow_mut().advance_noid(1);

    let out = alice_obs_and_tick(&s, &mut restored);
    assert_eq!(restored.phase.name(), "funded");
    assert_eq!(out.decision.action.kind(), "wait");
}

#[test]
fn t_s1_alice_row04_funded_sees_bob_lock_and_offers_reveal_once_final() {
    let mut s = Scenario::new(Variant::Raw);
    s.tick_alice();
    s.world.borrow_mut().advance_noid(1);
    s.tick_both();
    let mut restored = clone_file(&s.alice.file);
    assert_eq!(restored.phase.name(), "funded");

    s.world.borrow_mut().advance_noid(18);
    s.tick_bob(); // Bob locks
    s.world.borrow_mut().advance_eth(4); // lock finalized

    let out = alice_obs_and_tick(&s, &mut restored);
    assert_eq!(restored.phase.name(), "lock_final");
    assert_eq!(out.decision.action.kind(), "reveal_eth");
}

#[test]
fn t_s1_alice_row05_lock_final_when_old_copy_already_revealed_mined_reaches_done() {
    let mut s = Scenario::new(Variant::Raw);
    s.tick_alice();
    s.world.borrow_mut().advance_noid(1);
    s.tick_both();
    s.world.borrow_mut().advance_noid(18);
    s.tick_both(); // Bob locks
    s.world.borrow_mut().advance_eth(4); // lock finalized
    let mut restored = clone_file(&s.alice.file);
    let _ = alice_obs_and_tick(&s, &mut restored);
    assert_eq!(restored.phase.name(), "lock_final");

    // Old copy reveals and it finalizes on Ethereum.
    s.tick_alice();
    s.world.borrow_mut().advance_eth(4);

    let out = alice_obs_and_tick(&s, &mut restored);
    assert!(matches!(restored.phase, Phase::Alice(AlicePhase::Done { .. })), "{}", restored.phase.name());
    assert_ne!(out.decision.action.kind(), "reveal_eth", "must never send a second reveal");
}

// Row 06 (lock_final + old copy's reveal pending) is verified at the watcher level by
// `f1_watcher_pending_nonce_1_records_reveal_maybe_pending_before_and_after_m_a_cutoff` above.

#[test]
fn t_s1_alice_row07_lock_final_dropped_reveal_past_cutoff_residual_waits_for_d() {
    let (s, backup, _lock_id, t_reveal, _lock_block) = setup_alice_at_lock_final_with_eth_key();
    let g = backup.public.params.profile.gates();
    let past_ma_now = t_reveal - g.m_a_s + 120;

    // Residual case: old copy's reveal was dropped from every pool (latest=0, pending=0) and
    // restore happens past M_A cutoff with no on-chain or sidecar evidence.
    let mut restored = clone_file(&backup);
    let mut noid = s.world.borrow().noid_obs(None);
    noid.observed_at = Some(past_ma_now);
    noid.tip_time = Some(past_ma_now);
    if let Some(sec) = noid.second.as_deref_mut() {
        sec.observed_at = Some(past_ma_now);
        sec.tip_time = Some(past_ma_now);
    }
    let mut eth = s.world.borrow().eth_obs();
    eth.latest_timestamp = past_ma_now;
    eth.observed_at = Some(past_ma_now);
    eth.signer_nonce_latest = Some(0);
    eth.signer_nonce_pending = Some(0);
    if let Some(sec) = eth.second.as_deref_mut() {
        sec.latest_timestamp = past_ma_now;
        sec.observed_at = Some(past_ma_now);
        sec.signer_nonce_latest = Some(0);
        sec.signer_nonce_pending = Some(0);
    }

    let out = tick_apply(&mut restored, &noid, &eth, past_ma_now, true).unwrap();
    assert_eq!(out.decision.action.kind(), "wait", "must not reveal late without evidence");
    assert!(out.decision.reveal_cutoff_passed);

    // At D, Alice recovers her NOID (Ethereum clock is also past the reveal cutoff).
    let d = restored.public.params.deadline_height;
    let tip = s.world.borrow().tip;
    s.world.borrow_mut().advance_noid((d - tip) + 2);
    s.world.borrow_mut().warp_eth_to(past_ma_now + 600);
    let mut eth_d = s.world.borrow().eth_obs();
    eth_d.signer_nonce_latest = Some(0);
    eth_d.signer_nonce_pending = Some(0);
    if let Some(sec) = eth_d.second.as_deref_mut() {
        sec.signer_nonce_latest = Some(0);
        sec.signer_nonce_pending = Some(0);
    }
    let noid_d = s.world.borrow().noid_obs(None);
    let out_d = tick_apply(&mut restored, &noid_d, &eth_d, s.now(), true).unwrap();
    assert_eq!(out_d.decision.action.kind(), "refund_noid");
}

#[test]
fn alice_nonce_above_zero_lock_not_confirmed_open_offers_noid_recovery_after_d_without_an_eth_refund_read() {
    let (s, backup, lock_id, t_reveal, lock_block) = setup_alice_at_lock_final_with_eth_key();
    let d = backup.public.params.deadline_height;
    let tip = s.world.borrow().tip;
    s.world.borrow_mut().advance_noid((d - tip) + 2);
    let now = s.now();

    // The primary node shows latest nonce 1 and the second node latest nonce 0: the lock is not confirmed open
    // on all nodes, and no refund of the Ethereum lock is seen. The NOID contract only allows recovery after D.
    let mut n1 = MockEthNode::from_swap(&backup, lock_id, t_reveal, lock_block, now - 60, lock_block + 10, now, lock_block + 8);
    n1.alice_nonce_latest = 1;
    n1.alice_nonce_pending = 1;
    let mut eth = observe_with_clock(n1, backup.public.params.eth.contract, lock_id, backup.public.params.eth.alice_receiver, now);
    let mut n2 = MockEthNode::from_swap(&backup, lock_id, t_reveal, lock_block, now - 60, lock_block + 10, now, lock_block + 8);
    n2.alice_nonce_latest = 0;
    n2.alice_nonce_pending = 0;
    let e2 = observe_with_clock(n2, backup.public.params.eth.contract, lock_id, backup.public.params.eth.alice_receiver, now);
    eth.second = Some(Box::new(e2));
    assert!(eth.refunded.is_none());

    let noid = s.world.borrow().noid_obs(None);
    let mut restored = clone_file(&backup);
    let out = tick_apply(&mut restored, &noid, &eth, now, true).unwrap();
    assert_eq!(out.decision.action.kind(), "refund_noid", "an Ethereum read must not hold back the NOID recovery after D: {:?}", out.decision);
}

#[test]
fn t_s1_alice_row08_before_d_restored_after_d_offers_refund_noid() {
    let mut s = Scenario::new(Variant::Raw);
    s.tick_alice();
    s.world.borrow_mut().advance_noid(1);
    s.tick_alice();
    s.world.borrow_mut().advance_noid(18);
    s.tick_alice();
    let mut restored = clone_file(&s.alice.file);
    assert_eq!(restored.phase.name(), "funding_final");

    // Jump past D without Bob ever locking.
    let d = restored.public.params.deadline_height;
    let tip = s.world.borrow().tip;
    s.world.borrow_mut().advance_noid((d - tip) + 2);

    let out = alice_obs_and_tick(&s, &mut restored);
    assert_eq!(out.decision.action.kind(), "refund_noid");
}

#[test]
fn t_s1_alice_row09_old_copy_already_recovered_recorded_via_closed_by() {
    let mut s = Scenario::new(Variant::Raw);
    s.tick_alice();
    s.world.borrow_mut().advance_noid(1);
    s.tick_alice();
    s.world.borrow_mut().advance_noid(18);
    s.tick_alice();
    let mut restored = clone_file(&s.alice.file);
    assert_eq!(restored.phase.name(), "funding_final");

    // Old copy recovers after D and the recovery close is final on chain.
    let d = restored.public.params.deadline_height;
    let tip = s.world.borrow().tip;
    s.world.borrow_mut().advance_noid((d - tip) + 2);
    s.tick_alice(); // old copy submits refund_noid
    s.world.borrow_mut().advance_noid(1);
    let rec_height = s.world.borrow().tip;
    let txid = "bb".repeat(32);
    s.world.borrow_mut().advance_noid(18); // recovery is now final, instance gone

    let mut noid = s.world.borrow().noid_obs(None);
    noid.confirmed_tx = Some(ConfirmedTx { txid: txid.clone(), height: rec_height });
    noid.tracked_tx_pending = Some(false);
    let ev = external_close_event(&restored, &noid, &txid).unwrap();
    restored.apply(&ev, s.now()).unwrap();
    assert_eq!(restored.phase.name(), "refund_included");

    let eth = s.world.borrow().eth_obs();
    let out = tick_apply(&mut restored, &noid, &eth, s.now(), true).unwrap();
    assert!(matches!(restored.phase, Phase::Alice(AlicePhase::Refunded { .. })), "{}", restored.phase.name());
    assert_eq!(out.decision.action.kind(), "wait");
}

#[test]
fn t_s1_alice_row10_before_sweeps_old_copy_swept_stays_done_no_action() {
    let mut s = Scenario::new(Variant::Raw);
    s.tick_alice();
    s.world.borrow_mut().advance_noid(1);
    s.tick_both();
    s.world.borrow_mut().advance_noid(18);
    s.tick_both(); // Bob locks
    s.world.borrow_mut().advance_eth(4);
    s.tick_alice(); // Alice reveals
    s.world.borrow_mut().advance_eth(4);
    s.tick_both(); // Alice done, Bob sees secret & claims
    s.world.borrow_mut().advance_noid(1);
    s.world.borrow_mut().advance_noid(18);
    s.tick_both();

    let mut restored = clone_file(&s.alice.file);
    assert!(matches!(restored.phase, Phase::Alice(AlicePhase::Done { .. })));

    // Old copy already swept leftovers; restored copy sees nothing left to do.
    let out = alice_obs_and_tick(&s, &mut restored);
    assert!(matches!(restored.phase, Phase::Alice(AlicePhase::Done { .. })));
    assert_eq!(out.decision.action.kind(), "wait");
    assert!(out.decision.action.reason_str().contains("done"));
}

// =========================================================================
// T-S1: Stale-backup phase walk — Bob (all 8 rows of design §4.2)
// =========================================================================

#[test]
fn t_s1_bob_row01_received_when_funding_final_offers_lock_eth() {
    let mut s = Scenario::new(Variant::Raw);
    let mut restored = clone_file(&s.bob.file);
    assert_eq!(restored.phase.name(), "received");

    s.tick_alice();
    s.world.borrow_mut().advance_noid(1);

    let _ = bob_obs_and_tick(&s, &mut restored);
    assert_eq!(restored.phase.name(), "funded");
    s.world.borrow_mut().advance_noid(18);
    let out = bob_obs_and_tick(&s, &mut restored);
    assert_eq!(restored.phase.name(), "funding_final");
    assert_eq!(out.decision.action.kind(), "lock_eth");
}

#[test]
fn t_s1_bob_row02_funding_final_old_copy_lock_pending_then_mined_adopts_locked() {
    let mut s = Scenario::new(Variant::Raw);
    s.tick_alice();
    s.world.borrow_mut().advance_noid(1);
    s.tick_both();
    s.world.borrow_mut().advance_noid(18);
    let mut restored = clone_file(&s.bob.file);
    let _ = bob_obs_and_tick(&s, &mut restored);
    assert_eq!(restored.phase.name(), "funding_final");

    // Old copy broadcast its lock; pending nonce is ahead of latest on Bob's key, lock not mined yet.
    let mut eth_pending = s.world.borrow().eth_obs();
    eth_pending.signer_nonce_latest = Some(0);
    eth_pending.signer_nonce_pending = Some(1);
    let noid = s.world.borrow().noid_obs(None);
    let _ = tick_apply(&mut restored, &noid, &eth_pending, s.now(), true).unwrap();
    // (In the real program, live.js refuses while pending nonce > latest; once the old copy's lock mines,
    // the restored engine adopts the mined lock and resolves any pending intent.)
    s.tick_bob();
    s.world.borrow_mut().advance_eth(1);

    let out_mined = bob_obs_and_tick(&s, &mut restored);
    assert_eq!(restored.phase.name(), "locked");
    assert_ne!(out_mined.decision.action.kind(), "lock_eth", "must not double-lock once old copy's lock mines");
    assert!(restored.pending_intent.is_none(), "resolved once lock adopted");
}

#[test]
fn t_s1_bob_row03_funding_final_adopts_old_copys_mined_lock_and_does_not_double_lock() {
    let mut s = Scenario::new(Variant::Raw);
    s.tick_alice();
    s.world.borrow_mut().advance_noid(1);
    s.tick_both();
    s.world.borrow_mut().advance_noid(18);
    let mut restored = clone_file(&s.bob.file);
    let _ = bob_obs_and_tick(&s, &mut restored);
    assert_eq!(restored.phase.name(), "funding_final");
    restored.pending_intent = None;

    // Old copy locks ETH and it mines.
    s.tick_bob();
    s.world.borrow_mut().advance_eth(1);

    let out = bob_obs_and_tick(&s, &mut restored);
    assert_eq!(restored.phase.name(), "locked");
    assert_ne!(out.decision.action.kind(), "lock_eth", "Bob must adopt his own mined lock, never double-lock");
}

#[test]
fn t_s1_bob_row04_locked_when_secret_public_reaches_secret_seen_and_offers_claim() {
    let mut s = Scenario::new(Variant::Raw);
    s.tick_alice();
    s.world.borrow_mut().advance_noid(1);
    s.tick_both();
    s.world.borrow_mut().advance_noid(18);
    s.tick_both(); // Bob locks
    s.world.borrow_mut().advance_eth(4);
    s.tick_bob(); // Bob observes his mined lock -> locked
    let mut restored = clone_file(&s.bob.file);
    assert_eq!(restored.phase.name(), "locked");

    // Alice reveals, publishing the secret.
    s.tick_alice();
    s.world.borrow_mut().advance_eth(1);

    let out = bob_obs_and_tick(&s, &mut restored);
    assert!(matches!(restored.phase, Phase::Bob(BobPhase::SecretSeen { .. })), "{}", restored.phase.name());
    assert_eq!(out.decision.action.kind(), "claim_noid");
}

#[test]
fn t_s1_bob_row05_locked_or_secret_seen_old_copy_claim_pending_or_included_waits() {
    let mut s = Scenario::new(Variant::Raw);
    s.tick_alice();
    s.world.borrow_mut().advance_noid(1);
    s.tick_both();
    s.world.borrow_mut().advance_noid(18);
    s.tick_both(); // Bob locks
    s.world.borrow_mut().advance_eth(4);
    s.tick_bob(); // Bob observes his mined lock -> locked
    let mut restored = clone_file(&s.bob.file);
    assert_eq!(restored.phase.name(), "locked");

    // Alice reveals; old Bob copy submits claim_noid (sits in mempool).
    s.tick_alice();
    s.world.borrow_mut().advance_eth(1);
    s.tick_bob(); // old copy submits claim_noid
    assert!(!s.world.borrow().mempool.is_empty());

    // Restored Bob sees secret -> moves to secret_seen, sees pending call in mempool -> waits instead of submitting a second claim.
    let out_pending = bob_obs_and_tick(&s, &mut restored);
    assert!(matches!(restored.phase, Phase::Bob(BobPhase::SecretSeen { .. })), "{}", restored.phase.name());
    assert_eq!(out_pending.decision.action.kind(), "wait", "must wait while a claim close is already pending");

    // Once the old copy's claim mines and finalizes, recording the close completes Bob's file.
    s.world.borrow_mut().advance_noid(1);
    let claim_height = s.world.borrow().tip;
    let txid = "cc".repeat(32);
    s.world.borrow_mut().advance_noid(18);
    let mut noid = s.world.borrow().noid_obs(None);
    noid.confirmed_tx = Some(ConfirmedTx { txid: txid.clone(), height: claim_height });
    noid.tracked_tx_pending = Some(false);
    let ev = external_close_event(&restored, &noid, &txid).unwrap();
    restored.apply(&ev, s.now()).unwrap();
    let eth = s.world.borrow().eth_obs();
    let out_done = tick_apply(&mut restored, &noid, &eth, s.now(), true).unwrap();
    assert!(matches!(restored.phase, Phase::Bob(BobPhase::Done { .. })), "{}", restored.phase.name());
    assert_eq!(out_done.decision.action.kind(), "wait");
}

#[test]
fn t_s1_bob_row06_locked_after_t_reveal_offers_refund_eth() {
    let mut s = Scenario::new(Variant::Raw);
    s.tick_alice();
    s.world.borrow_mut().advance_noid(1);
    s.tick_both();
    s.world.borrow_mut().advance_noid(18);
    s.tick_both(); // Bob locks
    s.world.borrow_mut().advance_eth(1);
    s.tick_bob(); // Bob observes his mined lock -> locked
    let mut restored = clone_file(&s.bob.file);
    assert_eq!(restored.phase.name(), "locked");

    // Advance Ethereum past T_reveal with no reveal.
    s.world.borrow_mut().advance_eth((W_A_S / 12) + 50);

    let out = bob_obs_and_tick(&s, &mut restored);
    assert_eq!(out.decision.action.kind(), "refund_eth");
}

#[test]
fn t_s1_bob_row07_refund_submitted_when_refund_mined_reaches_refunded() {
    let mut s = Scenario::new(Variant::Raw);
    s.tick_alice();
    s.world.borrow_mut().advance_noid(1);
    s.tick_both();
    s.world.borrow_mut().advance_noid(18);
    s.tick_both(); // Bob locks
    s.world.borrow_mut().advance_eth(1);
    s.tick_bob(); // Bob observes his mined lock -> locked
    s.world.borrow_mut().advance_eth((W_A_S / 12) + 50);

    // Put backup into refund_submitted right before refund mines.
    let mut restored = clone_file(&s.bob.file);
    assert!(matches!(restored.phase, Phase::Bob(BobPhase::Locked { .. })));
    restored
        .apply(
            &Event::EthRefundSubmitted {
                tx_hash: Some([0x33; 32]),
                at: s.now(),
            },
            s.now(),
        )
        .unwrap();
    assert_eq!(restored.phase.name(), "refund_submitted");

    // Old copy's refund mines and finalizes on Ethereum.
    s.tick_bob();
    s.world.borrow_mut().advance_eth(4);

    let out = bob_obs_and_tick(&s, &mut restored);
    assert!(matches!(restored.phase, Phase::Bob(BobPhase::Refunded { .. })), "{}", restored.phase.name());
    assert_eq!(out.decision.action.kind(), "wait");
}

#[test]
fn t_s1_bob_row08_before_sweep_old_copy_swept_stays_done() {
    let mut s = Scenario::new(Variant::Raw);
    s.tick_alice();
    s.world.borrow_mut().advance_noid(1);
    s.tick_both();
    s.world.borrow_mut().advance_noid(18);
    s.tick_both(); // Bob locks
    s.world.borrow_mut().advance_eth(4);
    s.tick_alice(); // Alice reveals
    s.world.borrow_mut().advance_eth(4);
    s.tick_both(); // Bob claims
    s.world.borrow_mut().advance_noid(1);
    s.world.borrow_mut().advance_noid(18);
    s.tick_both();

    let mut restored = clone_file(&s.bob.file);
    assert!(matches!(restored.phase, Phase::Bob(BobPhase::Done { .. })));

    let out = bob_obs_and_tick(&s, &mut restored);
    assert!(matches!(restored.phase, Phase::Bob(BobPhase::Done { .. })));
    assert_eq!(out.decision.action.kind(), "wait");
}

trait ActionReasonExt {
    fn reason_str(&self) -> &str;
}
impl ActionReasonExt for swap_cli::engine::Action {
    fn reason_str(&self) -> &str {
        match self {
            swap_cli::engine::Action::Wait { reason } | swap_cli::engine::Action::Abort { reason } => reason,
            _ => "",
        }
    }
}
