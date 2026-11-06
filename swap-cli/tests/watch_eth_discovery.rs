//! Alice's side of the Ethereum watcher: she does not know Bob's lock id in
//! advance, so the watcher finds the `Locked` event by the agreed parties and
//! her hashlock on the recorded Hardhat fixture, then behaves exactly as with
//! a known id. Also pins the chain id / contract code hash fields.

use std::path::Path;

use swap_cli::secret::sha256;
use swap_cli::watch::eth::{keccak256, EthWatcher, LockDiscovery};
use swap_cli::watch::FixtureRpc;

const CONTRACT: &str = "5fbdb2315678afecb367f032d93f642f64180aa3";
const BOB: &str = "70997970c51812dc3a010c7d01b50e0d17dc79c8";
const ALICE: &str = "3c44cdddb6a900fa2b585dd299e03d12fa4293bc";

fn a20(h: &str) -> [u8; 20] {
    hex::decode(h).unwrap().try_into().unwrap()
}

fn fixture(name: &str) -> FixtureRpc {
    let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("fixtures/eth").join(name);
    FixtureRpc::from_file(&path).unwrap()
}

#[test]
fn alice_discovers_bobs_lock_by_parties_and_hashlock() {
    let hashlock = sha256(&swap_cli::htlc_harness::seq_bytes(0));
    let rpc = fixture("locked.json");
    let by_id = EthWatcher::new(&rpc, a20(CONTRACT), [0u8; 32]);
    // Without a rule and without an id there is nothing to look for.
    let obs = by_id.observe().unwrap();
    assert!(obs.lock.is_none());
    // REVIEW-2 F1: even then the chain id and the contract code hash are read.
    assert_eq!(obs.chain_id, Some(31_337));
    assert!(obs.contract_code_hash.is_some());
    // With the rule the recorded lock is found and fully decoded.
    let rpc = fixture("locked.json");
    let w = EthWatcher::new(&rpc, a20(CONTRACT), [0u8; 32]).with_discovery(LockDiscovery {
        sender: a20(BOB),
        receiver: a20(ALICE),
        hashlock,
    });
    let obs = w.observe().unwrap();
    let lock = obs.lock.expect("discovered");
    assert_eq!(lock.sender, a20(BOB));
    assert_eq!(lock.receiver, a20(ALICE));
    assert_eq!(lock.hashlock, hashlock);
    assert_eq!(lock.amount_wei, 10u128.pow(16));
    assert!(!lock.claimed && !lock.refunded);
    assert_eq!(lock.sender_is_eoa, Some(true));
    assert_eq!(lock.receiver_is_eoa, Some(true));
    // The discovered id is what a watcher given the id directly would use.
    let rpc2 = fixture("locked.json");
    let direct = EthWatcher::new(&rpc2, a20(CONTRACT), lock.lock_id).observe().unwrap();
    assert_eq!(direct.lock, Some(lock.clone()));
    assert_eq!(direct.contract_code_hash, obs.contract_code_hash);
    // The contract code hash is the keccak of the recorded runtime code (never empty); it is read FIRST
    // (right after eth_chainId), then the sender's and the receiver's code.
    assert_eq!(rpc.calls_made().iter().filter(|(m, _)| m == "eth_getCode").count(), 3);
    let h = obs.contract_code_hash.expect("code hash is read on every poll");
    assert_ne!(h, keccak256(b""));
    // The chain id and the code hash are read even when no lock is found (REVIEW-2 F1).
    assert_eq!(obs.chain_id, Some(31_337));
    // The rule must match: another receiver finds nothing.
    let rpc = fixture("locked.json");
    let w = EthWatcher::new(&rpc, a20(CONTRACT), [0u8; 32]).with_discovery(LockDiscovery {
        sender: a20(BOB),
        receiver: a20(BOB),
        hashlock,
    });
    assert!(w.observe().unwrap().lock.is_none());
    // Another hashlock finds nothing either.
    let rpc = fixture("locked.json");
    let w = EthWatcher::new(&rpc, a20(CONTRACT), [0u8; 32]).with_discovery(LockDiscovery {
        sender: a20(BOB),
        receiver: a20(ALICE),
        hashlock: [9; 32],
    });
    assert!(w.observe().unwrap().lock.is_none());
}

#[test]
fn discovery_sees_the_claim_once_mined() {
    let hashlock = sha256(&swap_cli::htlc_harness::seq_bytes(0));
    let rpc = fixture("claimed.json");
    let w = EthWatcher::new(&rpc, a20(CONTRACT), [0u8; 32]).with_discovery(LockDiscovery {
        sender: a20(BOB),
        receiver: a20(ALICE),
        hashlock,
    });
    let obs = w.observe().unwrap();
    assert_eq!(obs.first_preimage(), Some(swap_cli::htlc_harness::seq_bytes(0)));
    let lock = obs.lock.expect("lock");
    assert!(lock.claimed);
    let claimed = obs.claimed.expect("Claimed event");
    assert_eq!(claimed.lock_id, lock.lock_id);
    assert_eq!(claimed.preimage, swap_cli::htlc_harness::seq_bytes(0));
}

// ------------------------------------------------------------------ REVIEW-2 F10: every matching lock is reported

use serde_json::{json, Value};
use swap_cli::watch::eth::{compute_lock_id, MAX_LOCKS_READ, TOPIC_LOCKED};
use swap_cli::watch::{RpcError, ScriptedRpc};

fn hex0x(b: &[u8]) -> String {
    format!("0x{}", hex::encode(b))
}

fn pad(a: &[u8; 20]) -> [u8; 32] {
    let mut w = [0u8; 32];
    w[12..].copy_from_slice(a);
    w
}

fn num(n: u128) -> [u8; 32] {
    let mut w = [0u8; 32];
    w[16..].copy_from_slice(&n.to_be_bytes());
    w
}

/// (lock id, timelock, amount, block) of the locks a scripted node holds, all by BOB to ALICE with `hashlock`.
fn locks_of(hashlock: &[u8; 32], specs: &[(u64, u128)]) -> Vec<([u8; 32], u64, u128, u64)> {
    specs
        .iter()
        .enumerate()
        .map(|(i, (timelock, amount))| (compute_lock_id(&a20(BOB), &a20(ALICE), *amount, hashlock, *timelock), *timelock, *amount, 10 + i as u64))
        .collect()
}

/// A scripted Ethereum node that holds several unclaimed, unrefunded locks of the agreed parties and hashlock.
fn node(hashlock: [u8; 32], held: Vec<([u8; 32], u64, u128, u64)>) -> ScriptedRpc<impl Fn(&str, &Value) -> Result<Value, RpcError>> {
    ScriptedRpc(move |m: &str, p: &Value| -> Result<Value, RpcError> {
        let log_of = |(id, tl, amt, blk): &([u8; 32], u64, u128, u64)| {
            let mut data = Vec::new();
            data.extend_from_slice(&num(*amt));
            data.extend_from_slice(&hashlock);
            data.extend_from_slice(&num(*tl as u128));
            json!({
                "removed": false, "address": format!("0x{CONTRACT}"),
                "topics": [hex0x(&TOPIC_LOCKED), hex0x(id), hex0x(&pad(&a20(BOB))), hex0x(&pad(&a20(ALICE)))],
                "data": hex0x(&data), "blockNumber": format!("0x{blk:x}"), "transactionHash": hex0x(&[0xee; 32]),
            })
        };
        match m {
            "eth_blockNumber" => Ok(json!("0x64")),
            "eth_getBlockByNumber" => match p[0].as_str().unwrap() {
                "latest" => Ok(json!({"number": "0x64", "timestamp": "0x6553f100"})),
                "finalized" => Ok(json!({"number": "0x60", "timestamp": "0x6553f000"})),
                _ => Ok(json!({"number": p[0], "timestamp": "0x6553e000"})),
            },
            "eth_chainId" => Ok(json!("0x7a69")),
            "eth_getCode" => Ok(json!(if p[0].as_str().unwrap() == format!("0x{CONTRACT}") { "0x6001" } else { "0x" })),
            "eth_getLogs" => {
                let topics = &p[0]["topics"];
                if topics[1].is_null() {
                    return Ok(Value::Array(held.iter().map(log_of).collect())); // discovery
                }
                let want = topics[1].as_str().unwrap();
                Ok(Value::Array(held.iter().filter(|l| hex0x(&l.0) == want).map(log_of).collect()))
            }
            "eth_call" => {
                let data = hex::decode(p[0]["data"].as_str().unwrap().trim_start_matches("0x")).unwrap();
                match held.iter().find(|l| l.0[..] == data[4..36]) {
                    Some((_, tl, amt, _)) => {
                        let mut out = Vec::new();
                        out.extend_from_slice(&pad(&a20(BOB)));
                        out.extend_from_slice(&pad(&a20(ALICE)));
                        out.extend_from_slice(&num(*amt));
                        out.extend_from_slice(&hashlock);
                        out.extend_from_slice(&num(*tl as u128));
                        out.extend_from_slice(&[0u8; 96]);
                        Ok(json!(hex0x(&out)))
                    }
                    None => Err(RpcError::Remote { code: 3, message: "execution reverted: LockNotFound".into() }),
                }
            }
            other => Err(RpcError::Remote { code: -32601, message: format!("unexpected {other}") }),
        }
    })
}

fn rule(hashlock: [u8; 32]) -> LockDiscovery {
    LockDiscovery { sender: a20(BOB), receiver: a20(ALICE), hashlock }
}

#[test]
fn f10_discovery_reports_every_matching_lock_and_the_first_is_the_lock() {
    let hashlock = [0x42; 32];
    let held = locks_of(&hashlock, &[(1_700_007_200, 10u128.pow(16)), (1_700_007_300, 10u128.pow(16) + 5)]);
    let rpc = node(hashlock, held.clone());
    let obs = EthWatcher::new(&rpc, a20(CONTRACT), [0u8; 32]).with_discovery(rule(hashlock)).observe().unwrap();
    assert_eq!(obs.lock_count, 2);
    assert_eq!(obs.locks.len(), 2);
    assert_eq!(obs.lock.as_ref(), obs.locks.first());
    assert_eq!(obs.locks[0].lock_id, held[0].0);
    assert_eq!(obs.locks[1].lock_id, held[1].0);
    // The second is read as fully as the first (code of both parties, the timestamp of its block, the contract's flags).
    for l in &obs.locks {
        assert_eq!((l.sender_is_eoa, l.receiver_is_eoa), (Some(true), Some(true)));
        assert_eq!(l.block_timestamp, Some(0x6553e000));
        assert!(!l.claimed && !l.refunded);
    }
    assert_eq!(obs.locks[1].amount_wei, 10u128.pow(16) + 5);
    assert_eq!(obs.all_locks().len(), 2);
    assert_eq!(obs.find_lock(&held[1].0).map(|l| l.timelock), Some(1_700_007_300));
}

#[test]
fn f10_a_pinned_lock_stays_the_lock_and_the_others_follow_it() {
    let hashlock = [0x42; 32];
    let held = locks_of(&hashlock, &[(1_700_007_200, 10u128.pow(16)), (1_700_007_300, 10u128.pow(16))]);
    let rpc = node(hashlock, held.clone());
    let obs = EthWatcher::new(&rpc, a20(CONTRACT), held[1].0).with_discovery(rule(hashlock)).observe().unwrap();
    assert_eq!(obs.lock.as_ref().map(|l| l.lock_id), Some(held[1].0), "the pinned lock, not the first in the log");
    assert_eq!(obs.locks.iter().map(|l| l.lock_id).collect::<Vec<_>>(), vec![held[1].0, held[0].0]);
    assert_eq!(obs.lock_count, 2);
    // Without a rule, a pinned watcher sees exactly its own lock (what it always did).
    let rpc = node(hashlock, held.clone());
    let obs = EthWatcher::new(&rpc, a20(CONTRACT), held[1].0).observe().unwrap();
    assert_eq!((obs.locks.len(), obs.lock_count), (1, 1));
    assert_eq!(obs.lock.as_ref().map(|l| l.lock_id), Some(held[1].0));
    // A pinned lock that is not on chain yet does not hide the ones that are: `lock` stays empty.
    let rpc = node(hashlock, held.clone());
    let obs = EthWatcher::new(&rpc, a20(CONTRACT), [0x77; 32]).with_discovery(rule(hashlock)).observe().unwrap();
    assert!(obs.lock.is_none());
    assert_eq!((obs.locks.len(), obs.lock_count), (2, 2));
}

#[test]
fn f10_a_flood_of_matching_locks_is_counted_but_only_the_first_few_are_read() {
    let hashlock = [0x42; 32];
    let specs: Vec<(u64, u128)> = (0..MAX_LOCKS_READ as u64 + 3).map(|i| (1_700_007_200 + i, 10u128.pow(16))).collect();
    let rpc = node(hashlock, locks_of(&hashlock, &specs));
    let obs = EthWatcher::new(&rpc, a20(CONTRACT), [0u8; 32]).with_discovery(rule(hashlock)).observe().unwrap();
    assert_eq!(obs.locks.len(), MAX_LOCKS_READ);
    assert_eq!(obs.lock_count, MAX_LOCKS_READ + 3);
}

#[test]
fn f10_no_matching_lock_is_an_empty_list() {
    let hashlock = [0x42; 32];
    let rpc = node(hashlock, Vec::new());
    let obs = EthWatcher::new(&rpc, a20(CONTRACT), [0u8; 32]).with_discovery(rule(hashlock)).observe().unwrap();
    assert!(obs.lock.is_none() && obs.locks.is_empty() && obs.lock_count == 0);
}
