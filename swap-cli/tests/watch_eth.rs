//! Ethereum watcher against fixtures RECORDED from Hardhat's in-process network
//! (`eth/scripts/record-fixtures.js`), plus hand-edited ("synthesized") variants of those
//! recordings for the hostile-node cases. Nothing here touches a network.

use std::path::PathBuf;

use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use swap_cli::watch::eth::{compute_lock_id, EthWatcher, SELECTOR_CLAIM, SELECTOR_REFUND};
use swap_cli::watch::{EthObservation, FixtureRpc, JsonRpc, RpcError};

// Hardhat default accounts 1 (Bob, sender) and 2 (Alice, receiver); first contract of account 0.
const CONTRACT: &str = "5fbdb2315678afecb367f032d93f642f64180aa3";
const BOB: &str = "70997970c51812dc3a010c7d01b50e0d17dc79c8";
const ALICE: &str = "3c44cdddb6a900fa2b585dd299e03d12fa4293bc";
const AMOUNT_WEI: u128 = 10_000_000_000_000_000; // 0.01 ETH
const BASE_TS: u64 = 1_893_456_000; // forced timestamp of the deploy block
const PREIMAGE: [u8; 32] = {
    let mut p = [0u8; 32];
    let mut i = 0;
    while i < 32 {
        p[i] = i as u8;
        i += 1;
    }
    p
};

fn a20(hexs: &str) -> [u8; 20] {
    hex::decode(hexs).unwrap().try_into().unwrap()
}
fn h32(s: &str) -> [u8; 32] {
    hex::decode(s.strip_prefix("0x").unwrap_or(s)).unwrap().try_into().unwrap()
}
fn hashlock() -> [u8; 32] {
    Sha256::digest(PREIMAGE).into()
}
fn fixture(name: &str) -> Value {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("fixtures/eth").join(name);
    serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap()
}
fn rpc_from(v: &Value) -> FixtureRpc {
    FixtureRpc::from_json("test", &v.to_string()).unwrap()
}
/// The `n`-th recorded call of `method` (file order).
fn call_mut<'a>(fx: &'a mut Value, method: &str, n: usize) -> &'a mut Value {
    fx["calls"]
        .as_array_mut()
        .unwrap()
        .iter_mut()
        .filter(|c| c["method"] == method)
        .nth(n)
        .unwrap_or_else(|| panic!("no call {method}#{n}"))
}
fn result_of(fx: &mut Value, method: &str, n: usize) -> Value {
    call_mut(fx, method, n)["result"].clone()
}
fn qty(v: &Value) -> u64 {
    u64::from_str_radix(v.as_str().unwrap().strip_prefix("0x").unwrap(), 16).unwrap()
}
/// Our lock id as the node emitted it: topic 1 of the first log in the fixture.
fn emitted_lock_id(fx: &mut Value) -> [u8; 32] {
    h32(result_of(fx, "eth_getLogs", 0)[0]["topics"][1].as_str().unwrap())
}
fn watcher(fx: &Value, lock_id: [u8; 32]) -> EthWatcher<FixtureRpc> {
    EthWatcher::new(rpc_from(fx), a20(CONTRACT), lock_id).with_clock(|| BASE_TS)
}
fn decode_msg(r: Result<EthObservation, RpcError>) -> String {
    match r {
        Err(RpcError::Decode(m)) => m,
        other => panic!("expected a Decode error, got {other:?}"),
    }
}
fn pending_tx_hash(fx: &mut Value) -> [u8; 32] {
    h32(call_mut(fx, "eth_getTransactionByHash", 0)["params"][0].as_str().unwrap())
}

#[test]
fn compute_lock_id_reproduces_what_hardhat_emitted() {
    let mut locked = fixture("locked.json");
    let mut refunded = fixture("refunded.json");
    let id1 = emitted_lock_id(&mut locked);
    let id2 = emitted_lock_id(&mut refunded);
    // lock 1: timelock = deploy-block timestamp + 7200; lock 2: block-3 timestamp + 3600.
    let t1 = BASE_TS + 7200;
    let t2 = BASE_TS + 120 + 3600;
    assert_eq!(compute_lock_id(&a20(BOB), &a20(ALICE), AMOUNT_WEI, &hashlock(), t1), id1);
    assert_eq!(compute_lock_id(&a20(BOB), &a20(ALICE), AMOUNT_WEI, &hashlock(), t2), id2);
    assert_ne!(id1, id2);
    // The first Hardhat getLock word-for-word: hashlock and timelock round-trip.
    let out = result_of(&mut locked, "eth_call", 0);
    let out = hex::decode(&out.as_str().unwrap()[2..]).unwrap();
    assert_eq!(out[96..128], hashlock());
    assert_eq!(u64::from_be_bytes(out[152..160].try_into().unwrap()), t1);
}

#[test]
fn locked_fixture_full_observation() {
    let mut fx = fixture("locked.json");
    let id = emitted_lock_id(&mut fx);
    let log = result_of(&mut fx, "eth_getLogs", 0)[0].clone();
    let w = watcher(&fx, id);
    let obs = w.observe().unwrap();

    assert_eq!(obs.latest_block, 2);
    assert_eq!(obs.latest_timestamp, BASE_TS + 60);
    // Hardhat answers the `finalized` tag with the latest block.
    assert_eq!(obs.finalized_block, Some(2));
    let lock = obs.lock.as_ref().unwrap();
    assert_eq!(lock.lock_id, id);
    assert_eq!(lock.sender, a20(BOB));
    assert_eq!(lock.receiver, a20(ALICE));
    assert_eq!(lock.amount_wei, AMOUNT_WEI);
    assert_eq!(lock.hashlock, hashlock());
    assert_eq!(lock.timelock, BASE_TS + 7200);
    assert_eq!(lock.block_number, qty(&log["blockNumber"]));
    assert_eq!(lock.tx_hash, h32(log["transactionHash"].as_str().unwrap()));
    assert!(!lock.claimed && !lock.refunded);
    assert_eq!(lock.sender_is_eoa, Some(true));
    assert_eq!(lock.receiver_is_eoa, Some(true));
    assert!(obs.claimed.is_none() && obs.refunded.is_none() && obs.pending_preimage.is_none());
    assert!(obs.lock_finalized());
    assert_eq!(obs.first_preimage(), None);

    // Exactly these JSON-RPC calls, in this order.
    let calls = w.rpc.calls_made();
    let methods: Vec<&str> = calls.iter().map(|(m, _)| m.as_str()).collect();
    // (REVIEW-2 F1: `eth_chainId` and the contract's `eth_getCode` come right after the block reads, on every poll,
    // before anything about a lock; the pinned-code check, T17, reads that hash.)
    assert_eq!(
        methods,
        [
            "eth_blockNumber",
            "eth_getBlockByNumber",
            "eth_getBlockByNumber",
            "eth_chainId",
            "eth_getCode",
            "eth_getLogs",
            "eth_call",
            "eth_getCode",
            "eth_getCode",
            "eth_getBlockByNumber"
        ]
    );
    assert_eq!(obs.chain_id, Some(31_337));
    assert!(obs.contract_code_hash.is_some());
    assert_eq!(calls[4].1, json!([format!("0x{CONTRACT}"), "latest"]));
    assert_eq!(calls[1].1, json!(["latest", false]));
    assert_eq!(calls[2].1, json!(["finalized", false]));
    assert_eq!(calls[3].1, json!([]));
    let filter = &calls[5].1[0];
    assert_eq!(filter["address"], format!("0x{CONTRACT}"));
    assert_eq!(filter["toBlock"], "latest");
    assert_eq!(filter["topics"][1], format!("0x{}", hex::encode(id)));
    assert_eq!(filter["topics"][0].as_array().unwrap().len(), 3);
}

#[test]
fn pending_claim_exposes_the_preimage_before_it_is_mined() {
    let mut fx = fixture("pending_claim.json");
    let id = emitted_lock_id(&mut fx);
    let tx = pending_tx_hash(&mut fx);
    assert!(result_of(&mut fx, "eth_getTransactionByHash", 0)["blockNumber"].is_null());

    let obs = watcher(&fx, id).with_pending_txs(vec![tx]).observe().unwrap();
    let pending = obs.pending_preimage.clone().unwrap();
    assert_eq!(pending.preimage, PREIMAGE);
    assert_eq!(pending.lock_id, id);
    assert_eq!(pending.tx_hash, tx);
    assert!(obs.claimed.is_none());
    assert!(!obs.lock.as_ref().unwrap().claimed);
    assert_eq!(obs.first_preimage(), Some(PREIMAGE));

    // Without a hash to inspect there is nothing to find (and no extra node call).
    let w = watcher(&fx, id);
    assert!(w.observe().unwrap().pending_preimage.is_none());
    assert!(!w.rpc.calls_made().iter().any(|(m, _)| m == "eth_getTransactionByHash"));
}

#[test]
fn claimed_fixture_reports_event_and_ignores_the_mined_tx() {
    let mut fx = fixture("claimed.json");
    let id = emitted_lock_id(&mut fx);
    let tx = pending_tx_hash(&mut fx);
    let logs = result_of(&mut fx, "eth_getLogs", 0);
    let claim_log = &logs[1];
    assert!(!result_of(&mut fx, "eth_getTransactionByHash", 0)["blockNumber"].is_null());

    let obs = watcher(&fx, id).with_pending_txs(vec![tx]).observe().unwrap();
    let c = obs.claimed.clone().unwrap();
    assert_eq!(c.lock_id, id);
    assert_eq!(c.preimage, PREIMAGE);
    assert_eq!(c.block_number, qty(&claim_log["blockNumber"]));
    assert_eq!(c.tx_hash, tx);
    assert_eq!(c.tx_hash, h32(claim_log["transactionHash"].as_str().unwrap()));
    assert!(obs.lock.as_ref().unwrap().claimed);
    assert!(!obs.lock.as_ref().unwrap().refunded);
    assert_eq!(obs.latest_block, 3);
    assert_eq!(obs.latest_timestamp, BASE_TS + 120);
    assert!(obs.pending_preimage.is_none(), "a mined claim is not pending");
    assert!(obs.refunded.is_none());
    assert_eq!(obs.first_preimage(), Some(PREIMAGE));
    assert!(obs.lock_finalized());
}

#[test]
fn refunded_fixture_and_foreign_lock_logs_are_ignored() {
    let mut fx = fixture("refunded.json");
    let id2 = emitted_lock_id(&mut fx);
    let obs = watcher(&fx, id2).observe().unwrap();
    let r = obs.refunded.clone().unwrap();
    assert_eq!(r.lock_id, id2);
    assert_eq!(r.block_number, 5);
    assert!(obs.claimed.is_none());
    let lock = obs.lock.clone().unwrap();
    assert!(lock.refunded && !lock.claimed);
    assert_eq!(lock.timelock, BASE_TS + 120 + 3600);
    assert_eq!(obs.first_preimage(), None);

    // A node that ignores the lockId filter also returns lock 1's Locked + Claimed (and a log of
    // another contract carrying our lockId): all are ignored, the observation is unchanged.
    let mut claimed_fx = fixture("claimed.json");
    let foreign_logs = result_of(&mut claimed_fx, "eth_getLogs", 0);
    let mut other_contract = result_of(&mut fx, "eth_getLogs", 0)[0].clone();
    other_contract["address"] = json!("0x1111111111111111111111111111111111111111");
    let mut all = foreign_logs.as_array().unwrap().clone();
    all.push(other_contract);
    all.extend(result_of(&mut fx, "eth_getLogs", 0).as_array().unwrap().iter().cloned());
    *call_mut(&mut fx, "eth_getLogs", 0)
        .get_mut("result")
        .unwrap() = Value::Array(all);
    assert_eq!(watcher(&fx, id2).observe().unwrap(), obs);

    // And watching lock 1 against that mixed answer finds nothing of lock 2.
    let id1 = emitted_lock_id(&mut claimed_fx);
    let mut mixed = fx.clone();
    // getLock must answer for lock 1 for that watcher; reuse the recorded answer from claimed.json.
    *call_mut(&mut mixed, "eth_call", 0) = call_mut(&mut claimed_fx, "eth_call", 0).clone();
    *call_mut(&mut mixed, "eth_getBlockByNumber", 2) = call_mut(&mut claimed_fx, "eth_getBlockByNumber", 2).clone(); // the Locked block of lock 1
    let o1 = watcher(&mixed, id1).observe().unwrap();
    assert!(o1.refunded.is_none());
    assert_eq!(o1.claimed.unwrap().lock_id, id1);
}

#[test]
fn finalized_tag_error_or_old_block() {
    let mut fx = fixture("locked.json");
    let id = emitted_lock_id(&mut fx);
    // Node rejects the tag.
    let mut errored = fx.clone();
    let call = call_mut(&mut errored, "eth_getBlockByNumber", 1);
    call.as_object_mut().unwrap().remove("result");
    call["error"] = json!({"code": -32602, "message": "invalid block tag finalized"});
    let obs = watcher(&errored, id).observe().unwrap();
    assert_eq!(obs.finalized_block, None);
    assert!(!obs.lock_finalized());
    assert!(obs.lock.is_some());
    // Node answers null (no finalized block yet).
    let mut null = fx.clone();
    call_mut(&mut null, "eth_getBlockByNumber", 1)["result"] = Value::Null;
    assert_eq!(watcher(&null, id).observe().unwrap().finalized_block, None);
    // Finalized block older than the lock's block: not final yet.
    let mut old = fx.clone();
    call_mut(&mut old, "eth_getBlockByNumber", 1)["result"]["number"] = json!("0x1");
    let obs = watcher(&old, id).observe().unwrap();
    assert_eq!(obs.finalized_block, Some(1));
    assert!(!obs.lock_finalized());
}

#[test]
fn absent_lock_asks_get_lock_and_only_a_revert_means_no_lock() {
    // REVIEW-2 F7: with the lock id known, an empty `eth_getLogs` is never read as "no lock" on its own.
    let mut fx = fixture("locked.json");
    let id = emitted_lock_id(&mut fx);
    *call_mut(&mut fx, "eth_getLogs", 0).get_mut("result").unwrap() = json!([]);
    // getLock still answers with the lock: the logs are missing it (from-block too high, range limit, lag).
    let msg = decode_msg(watcher(&fx, id).observe());
    assert!(msg.contains("no Locked event") && msg.contains("--eth-from-block"), "{msg}");
    // Still an error (the poll fails), and it says that right after a lock was mined this is usually the provider's log index, clearing on the next poll.
    assert!(msg.contains("log index lagging") && msg.contains("clears on the next poll") && msg.contains("block-range limit"), "{msg}");
    // getLock reverts LockNotFound (an eth_call revert is a JSON-RPC error): there is no such lock.
    let call = call_mut(&mut fx, "eth_call", 0);
    call.as_object_mut().unwrap().remove("result");
    call["error"] = json!({"code": 3, "message": "execution reverted: LockNotFound"});
    let w = watcher(&fx, id);
    let obs = w.observe().unwrap();
    assert!(obs.lock.is_none() && obs.claimed.is_none() && obs.refunded.is_none());
    assert_eq!(obs.latest_block, 2);
    assert!(!obs.lock_finalized());
    assert!(w.rpc.calls_made().iter().any(|(m, _)| m == "eth_call"), "getLock is asked on every poll");
    assert!(obs.contract_code_hash.is_some() && obs.chain_id == Some(31_337));
    // Any other node error is an error, not "no lock".
    call_mut(&mut fx, "eth_call", 0)["error"] = json!({"code": -32005, "message": "rate limited"});
    assert!(matches!(watcher(&fx, id).observe(), Err(RpcError::Remote { code: -32005, .. })));
}

#[test]
fn chain_id_and_contract_code_are_mandatory_on_every_poll() {
    // REVIEW-2 F1: a node that cannot answer either fails the poll; there is no "unknown" observation.
    let mut fx = fixture("locked.json");
    let id = emitted_lock_id(&mut fx);
    let mut no_chain = fx.clone();
    no_chain["calls"].as_array_mut().unwrap().retain(|c| c["method"] != "eth_chainId");
    assert!(matches!(watcher(&no_chain, id).observe(), Err(RpcError::Fixture(_))));
    let mut bad_chain = fx.clone();
    call_mut(&mut bad_chain, "eth_chainId", 0)["result"] = json!("not a quantity");
    assert!(decode_msg(watcher(&bad_chain, id).observe()).contains("eth_chainId"));
    let mut no_code = fx.clone();
    let call = call_mut(&mut no_code, "eth_getCode", 0);
    call.as_object_mut().unwrap().remove("result");
    call["error"] = json!({"code": -32000, "message": "boom"});
    assert!(matches!(watcher(&no_code, id).observe(), Err(RpcError::Remote { .. })));
    // Both are read even when there is no lock id at all (before Bob's first spend).
    let w = EthWatcher::new(rpc_from(&fx), a20(CONTRACT), [0u8; 32]).with_clock(|| BASE_TS);
    let obs = w.observe().unwrap();
    assert!(obs.lock.is_none());
    assert_eq!(obs.chain_id, Some(31_337));
    assert_eq!(obs.contract_code_hash, Some(swap_cli::watch::eth::keccak256(&hex::decode(result_of(&mut fx, "eth_getCode", 0).as_str().unwrap().trim_start_matches("0x")).unwrap())));
}
#[test]
fn locked_event_whose_lock_id_does_not_recompute_is_a_decode_error() {
    let mut fx = fixture("locked.json");
    let id = emitted_lock_id(&mut fx);
    // Change the amount in the event data (word 0) but keep the topics: the id no longer matches.
    let log = &mut call_mut(&mut fx, "eth_getLogs", 0)["result"][0];
    let data = log["data"].as_str().unwrap().to_string();
    log["data"] = json!(format!("{}{}", &data[..2], data[2..].replacen("2386f26fc10000", "2386f26fc10001", 1)));
    let msg = decode_msg(watcher(&fx, id).observe());
    assert!(msg.contains("eth_getLogs") && msg.contains("recompute"), "{msg}");
}

#[test]
fn get_lock_disagreeing_with_events_is_a_decode_error() {
    let mut fx = fixture("locked.json");
    let id = emitted_lock_id(&mut fx);
    let good = result_of(&mut fx, "eth_call", 0).as_str().unwrap().to_string();

    // Different receiver in the stored record.
    let mut a = fx.clone();
    call_mut(&mut a, "eth_call", 0)["result"] = json!(good.replacen(ALICE, "000000000000000000000000000000000000dead", 1));
    assert!(decode_msg(watcher(&a, id).observe()).contains("eth_call"));

    // claimed flag set (word 5) but no Claimed event in the logs, and the stored preimage (word 7, zeros here) does not hash
    // to the hashlock: REVIEW-3 F7 takes the secret from the record only when it checks out.
    let mut b = fx.clone();
    let mut s = good.clone();
    s.replace_range(2 + 64 * 5 + 63..2 + 64 * 5 + 64, "1");
    call_mut(&mut b, "eth_call", 0)["result"] = json!(s);
    assert!(decode_msg(watcher(&b, id).observe()).contains("getLock preimage does not hash to the lock's hashlock"));

    // Non-boolean flag, wrong length.
    let mut c = fx.clone();
    let mut s = good.clone();
    s.replace_range(2 + 64 * 6 + 62..2 + 64 * 6 + 64, "02");
    call_mut(&mut c, "eth_call", 0)["result"] = json!(s);
    assert!(decode_msg(watcher(&c, id).observe()).contains("neither 0 nor 1"));
    let mut d = fx.clone();
    call_mut(&mut d, "eth_call", 0)["result"] = json!(&good[..good.len() - 64]);
    assert!(decode_msg(watcher(&d, id).observe()).contains("expected 256"));

    // Claimed event whose preimage does not hash to the hashlock.
    let mut cfx = fixture("claimed.json");
    let cid = emitted_lock_id(&mut cfx);
    let log = &mut call_mut(&mut cfx, "eth_getLogs", 0)["result"][1];
    log["data"] = json!(format!("0x{}", "ab".repeat(32)));
    assert!(decode_msg(watcher(&cfx, cid).observe()).contains("inconsistent"));
}

/// `getLock` answer of `fx` with word `n` replaced by the 32 bytes `word` (hex, 64 chars).
fn set_record_word(fx: &mut Value, n: usize, word: &str) {
    let mut s = result_of(fx, "eth_call", 0).as_str().unwrap().to_string();
    s.replace_range(2 + 64 * n..2 + 64 * (n + 1), word);
    call_mut(fx, "eth_call", 0)["result"] = json!(s);
}
fn word_of(n: u8) -> String {
    format!("{:0>64x}", n)
}

#[test]
fn f7_a_claimed_record_without_a_claimed_log_yields_the_preimage_from_the_record() {
    // REVIEW-3 F7: the log index lags (or the range is capped): the Locked log is there, the Claimed log is not.
    let preimage_hex = hex::encode(PREIMAGE);
    let mut fx = fixture("locked.json");
    let id = emitted_lock_id(&mut fx);
    set_record_word(&mut fx, 5, &word_of(1));
    set_record_word(&mut fx, 7, &preimage_hex);
    let obs = watcher(&fx, id).observe().unwrap();
    let c = obs.claimed.clone().expect("claimed from the record");
    assert_eq!((c.lock_id, c.preimage, c.tx_hash), (id, PREIMAGE, [0u8; 32]));
    assert_eq!(c.block_number, obs.latest_block, "the block is unknown: the latest block is the upper bound");
    assert!(obs.lock.as_ref().unwrap().claimed && obs.claim_state_from_record);
    assert_eq!(obs.first_preimage(), Some(PREIMAGE));

    // The same from the recorded claimed fixture with its Claimed log removed.
    let mut cfx = fixture("claimed.json");
    let cid = emitted_lock_id(&mut cfx);
    call_mut(&mut cfx, "eth_getLogs", 0)["result"].as_array_mut().unwrap().truncate(1);
    let obs = watcher(&cfx, cid).observe().unwrap();
    assert_eq!(obs.claimed.as_ref().map(|c| c.preimage), Some(PREIMAGE));
    assert!(obs.claim_state_from_record);
    // With the log present the flag stays off (the recording of the claimed fixture is unchanged).
    assert!(!watcher(&fixture("claimed.json"), cid).observe().unwrap().claim_state_from_record);

    // A refunded record without a Refunded log is accepted too (no secret involved).
    let mut rfx = fixture("locked.json");
    let rid = emitted_lock_id(&mut rfx);
    set_record_word(&mut rfx, 6, &word_of(1));
    let obs = watcher(&rfx, rid).observe().unwrap();
    assert!(obs.refunded.is_some() && obs.claimed.is_none() && obs.claim_state_from_record);
    assert!(obs.lock.as_ref().unwrap().refunded);
}

#[test]
fn f7_real_contradictions_between_the_record_and_the_logs_still_fail() {
    let mut cfx = fixture("claimed.json");
    let cid = emitted_lock_id(&mut cfx);
    // A Claimed log, but the record says not claimed.
    let mut a = cfx.clone();
    set_record_word(&mut a, 5, &word_of(0));
    assert!(decode_msg(watcher(&a, cid).observe()).contains("inconsistent"));
    // The record's stored preimage differs from the log's.
    let mut b = cfx.clone();
    set_record_word(&mut b, 7, &"ab".repeat(32));
    assert!(decode_msg(watcher(&b, cid).observe()).contains("inconsistent"));
    // The record says refunded while a Claimed log exists.
    let mut c = cfx.clone();
    set_record_word(&mut c, 6, &word_of(1));
    assert!(decode_msg(watcher(&c, cid).observe()).contains("inconsistent"));
    // A record claimed AND refunded cannot happen.
    let mut d = fixture("locked.json");
    let did = emitted_lock_id(&mut d);
    set_record_word(&mut d, 5, &word_of(1));
    set_record_word(&mut d, 6, &word_of(1));
    set_record_word(&mut d, 7, &hex::encode(PREIMAGE));
    assert!(decode_msg(watcher(&d, did).observe()).contains("inconsistent"));
}

#[test]
fn contract_code_marks_non_eoa_parties() {
    let mut fx = fixture("locked.json");
    let id = emitted_lock_id(&mut fx);
    call_mut(&mut fx, "eth_getCode", 2)["result"] = json!("0x6080604052"); // 0 = contract, 1 = sender, 2 = receiver
    let lock = watcher(&fx, id).observe().unwrap().lock.unwrap();
    assert_eq!(lock.sender_is_eoa, Some(true));
    assert_eq!(lock.receiver_is_eoa, Some(false));
}

#[test]
fn pending_tx_that_is_not_our_claim_yields_nothing() {
    let base = fixture("pending_claim.json");
    let mut base_m = base.clone();
    let id = emitted_lock_id(&mut base_m);
    let tx = pending_tx_hash(&mut base_m);
    let input = result_of(&mut base_m, "eth_getTransactionByHash", 0)["input"].as_str().unwrap().to_string();
    let sel = hex::encode(SELECTOR_CLAIM);
    assert!(input.starts_with(&format!("0x{sel}")));

    let variants: Vec<(&str, Box<dyn Fn(&mut Value)>)> = vec![
        ("other contract", Box::new(|t| t["to"] = json!("0x2222222222222222222222222222222222222222"))),
        ("contract creation", Box::new(|t| t["to"] = Value::Null)),
        ("other selector", {
            let input = input.clone();
            Box::new(move |t| {
                t["input"] = json!(input.replacen(&sel, &hex::encode(SELECTOR_REFUND), 1));
            })
        }),
        ("other lock id", {
            let input = input.clone();
            Box::new(move |t| {
                let id_hex = &input[10..74];
                t["input"] = json!(input.replacen(id_hex, &"cd".repeat(32), 1));
            })
        }),
        ("junk preimage (does not hash to the hashlock)", {
            let input = input.clone();
            Box::new(move |t| t["input"] = json!(format!("{}{}", &input[..74], "ee".repeat(32))))
        }),
        ("truncated calldata", {
            let input = input.clone();
            Box::new(move |t| t["input"] = json!(&input[..input.len() - 2]))
        }),
        ("already mined", Box::new(|t| t["blockNumber"] = json!("0x3"))),
        ("unknown tx (null)", Box::new(|_| {})),
    ];
    for (name, edit) in variants {
        let mut fx = base.clone();
        let call = call_mut(&mut fx, "eth_getTransactionByHash", 0);
        if name.starts_with("unknown") {
            call["result"] = Value::Null;
        } else {
            edit(&mut call["result"]);
        }
        let obs = watcher(&fx, id).with_pending_txs(vec![tx]).observe().unwrap();
        assert!(obs.pending_preimage.is_none(), "{name}: unexpected pending preimage");
        assert_eq!(obs.first_preimage(), None, "{name}");
        assert!(obs.lock.is_some(), "{name}");
    }
}

#[test]
fn hostile_node_output_is_a_decode_error_never_a_panic() {
    let mut fx = fixture("locked.json");
    let id = emitted_lock_id(&mut fx);
    let cases: Vec<(&str, usize, &str, Value)> = vec![
        ("eth_blockNumber", 0, "eth_blockNumber", json!(5)),
        ("eth_blockNumber", 0, "eth_blockNumber", json!("0x")),
        ("eth_blockNumber", 0, "eth_blockNumber", json!("12")),
        ("eth_getBlockByNumber", 0, "eth_getBlockByNumber", Value::Null),
        ("eth_getBlockByNumber", 0, "eth_getBlockByNumber", json!({"number": "0x1"})),
        ("eth_getLogs", 0, "eth_getLogs", json!({"not": "an array"})),
        ("eth_getLogs", 0, "eth_getLogs", json!(["garbage"])),
        ("eth_call", 0, "eth_call", json!("0xzz")),
        ("eth_call", 0, "eth_call", Value::Null),
        ("eth_getCode", 0, "eth_getCode", json!("6080")),
    ];
    for (method, n, expect, bad) in cases {
        let mut broken = fx.clone();
        call_mut(&mut broken, method, n)["result"] = bad.clone();
        let msg = decode_msg(watcher(&broken, id).observe());
        assert!(msg.contains(expect), "{method} <- {bad}: {msg}");
    }
    // Truncated / over-wide event fields.
    let mut short = fx.clone();
    call_mut(&mut short, "eth_getLogs", 0)["result"][0]["data"] = json!("0x00");
    assert!(decode_msg(watcher(&short, id).observe()).contains("malformed Locked"));
    let mut wide = fx.clone();
    // amount word with a non-zero high half: does not fit in u128.
    let d = call_mut(&mut wide, "eth_getLogs", 0)["result"][0]["data"].as_str().unwrap().to_string();
    call_mut(&mut wide, "eth_getLogs", 0)["result"][0]["data"] = json!(format!("0x01{}", &d[4..]));
    assert!(decode_msg(watcher(&wide, id).observe()).contains("u128"));
    let mut pad = fx.clone();
    call_mut(&mut pad, "eth_getLogs", 0)["result"][0]["topics"][2] = json!(format!("0x{}", "11".repeat(32)));
    assert!(decode_msg(watcher(&pad, id).observe()).contains("padding"));
    // A transport-level problem is passed through unchanged, not relabelled as Decode.
    let empty = FixtureRpc::from_results("empty", vec![]);
    assert!(matches!(EthWatcher::new(empty, a20(CONTRACT), id).observe(), Err(RpcError::Fixture(_))));
}

#[test]
fn from_block_is_sent_as_a_hex_quantity() {
    let mut fx = fixture("locked.json");
    let id = emitted_lock_id(&mut fx);
    let w = watcher(&fx, id).with_from_block(255);
    w.observe().unwrap();
    let calls = w.rpc.calls_made();
    let logs_call = calls.iter().find(|(m, _)| m == "eth_getLogs").unwrap();
    assert_eq!(logs_call.1[0]["fromBlock"], "0xff");
    // The rest of the trait surface: a `&FixtureRpc` is itself a JsonRpc.
    let rpc = rpc_from(&fx);
    assert!(EthWatcher::new(&rpc, a20(CONTRACT), id).observe().is_ok());
    assert!(rpc.call("eth_blockNumber", json!([])).is_ok());
}

#[test]
fn eth_observations_are_stamped_with_the_watchers_clock() {
    let mut fx = fixture("locked.json");
    let id = emitted_lock_id(&mut fx);
    assert_eq!(watcher(&fx, id).observe().unwrap().observed_at, Some(BASE_TS));
    let before = swap_cli::watch::system_now();
    let at = EthWatcher::new(rpc_from(&fx), a20(CONTRACT), id).observe().unwrap().observed_at.expect("stamped");
    assert!(at >= before && at <= swap_cli::watch::system_now(), "{at} vs {before}");
}

#[test]
fn f3_signer_nonces_are_read_last_for_the_named_signer_and_are_unknown_without_the_call() {
    // REVIEW-3 F3: `eth_getTransactionCount(signer, "latest")` then `"pending"`, only when a signer is named.
    let mut fx = fixture("locked.json");
    let id = emitted_lock_id(&mut fx);
    // No signer named: the calls are not made and both are unknown (the exact call list above is unchanged).
    let obs = watcher(&fx, id).observe().unwrap();
    assert_eq!((obs.signer_nonce_latest, obs.signer_nonce_pending), (None, None));
    // A signer named, but a recording without the calls (every fixture written before F3): unknown, never an error.
    let w = watcher(&fx, id).with_signer(a20(BOB));
    let obs = w.observe().unwrap();
    assert_eq!((obs.signer_nonce_latest, obs.signer_nonce_pending), (None, None));
    // With the calls recorded, the answers are read, the parameters name the signer and the tag, and they come last.
    let signer = format!("0x{BOB}");
    let calls = fx["calls"].as_array_mut().unwrap();
    calls.push(json!({"method": "eth_getTransactionCount", "params": [signer, "latest"], "result": "0x7"}));
    calls.push(json!({"method": "eth_getTransactionCount", "params": [signer, "pending"], "result": "0x8"}));
    let w = watcher(&fx, id).with_signer(a20(BOB));
    let obs = w.observe().unwrap();
    assert_eq!((obs.signer_nonce_latest, obs.signer_nonce_pending), (Some(7), Some(8)));
    let made = w.rpc.calls_made();
    let tail: Vec<(&str, &Value)> = made.iter().rev().take(2).rev().map(|(m, p)| (m.as_str(), p)).collect();
    assert_eq!(tail, [("eth_getTransactionCount", &json!([signer, "latest"])), ("eth_getTransactionCount", &json!([signer, "pending"]))]);
    // A node that answers garbage is "unknown" too; the poll still succeeds.
    let n = fx["calls"].as_array().unwrap().len();
    fx["calls"][n - 1] = json!({"method": "eth_getTransactionCount", "result": "not a quantity"});
    let obs = watcher(&fx, id).with_signer(a20(BOB)).observe().unwrap();
    assert_eq!((obs.signer_nonce_latest, obs.signer_nonce_pending), (Some(7), None));
}
