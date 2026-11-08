//! The `poseidon` Ethereum lock kind (`docs/poseidon-leg.md` section 9, `docs/poseidon-v2-review.md`): the swap file, the watcher, the
//! engine gates and a full swap on the simulator. The `sha256` kind keeps its own suites; every raw-variant scenario of those suites can be
//! run against this kind too with `SWAP_TEST_LOCK_KIND=poseidon` (see `tests/common/mod.rs`).

mod common;

use common::*;
use serde_json::{json, Value};
use swap_cli::client::raw::{build_claim, client_r_selftest, verify_intent_bytes, ClaimInputs};
use swap_cli::engine::Action;
use swap_cli::params::{self, ContractVersion, ProfileName};
use swap_cli::secret::{sha256, LockKind, Secret, Variant};
use swap_cli::state::{AlicePhase, BobPhase, Phase};
use swap_cli::swapfile::{
    example_bob_file, example_bob_terms, example_public_kind, example_selftest, KdfParams, Passphrase, SwapFile, SwapFileError, SwapPublic,
};
use swap_cli::watch::eth::{compute_lock_id, EthWatcher, LockDiscovery, SELECTOR_CLAIM, TOPIC_LOCKED};
use swap_cli::watch::{NoidInstance, PendingPreimage, RevertedClaim, RpcError, ScriptedRpc, WordLock, WordScan};

fn poseidon_public(secret: &Secret) -> SwapPublic {
    example_public_kind(secret, Variant::Raw, ProfileName::Production, ContractVersion::V1, LockKind::Poseidon)
}

// ------------------------------------------------------------------------------------------------ the swap file

#[test]
fn the_poseidon_public_section_pins_the_v2_code_hash_and_the_lock_word_is_the_claim_authority() {
    let s = Secret::generate().unwrap();
    let p = poseidon_public(&s);
    assert_eq!(p.params.eth.lock_kind, LockKind::Poseidon);
    assert_eq!(p.params.eth.code_hash, Some(params::HTLC_POSEIDON_V2_CODE_HASH));
    assert_eq!(p.hashlock, s.authority(Variant::Raw).0, "the Ethereum lock word is A = Addr(s)");
    assert_eq!(p.hashlock, p.authority().unwrap().0, "... which is the claim authority of the NOID lock");
    assert_eq!(p.opening().unwrap().claim_authority.0, p.hashlock);
    assert_eq!(p.check(), Ok(()));
    // The sha256 kind is unchanged: SHA-256 of the secret, today's hash.
    let q = example_public_kind(&s, Variant::Raw, ProfileName::Production, ContractVersion::V1, LockKind::Sha256);
    assert_eq!(q.hashlock, sha256(s.bytes()));
    assert_eq!(q.params.eth.code_hash, Some(params::HTLC_CODE_HASH));
    // The journal of the equivalence proof does not exist for the poseidon kind.
    assert!(matches!(p.expected_equivalence_journal(), Err(SwapFileError::Invalid(m)) if m.contains("no equivalence proof")));
    assert!(q.expected_equivalence_journal().is_ok());
}

#[test]
fn a_sha256_bundle_does_not_mention_the_lock_kind_and_a_poseidon_one_does() {
    // The default is not written, so every existing file keeps its digest; a poseidon file says so, and the kind is digested.
    let s = Secret::generate().unwrap();
    let q = example_public_kind(&s, Variant::Raw, ProfileName::Production, ContractVersion::V1, LockKind::Sha256);
    assert!(!serde_json::to_string(&q).unwrap().contains("lock_kind"));
    let p = poseidon_public(&s);
    assert!(serde_json::to_string(&p).unwrap().contains("\"lock_kind\":\"poseidon\""));
    let mut flipped = p.clone();
    flipped.params.eth.lock_kind = LockKind::Sha256;
    assert_ne!(flipped.digest(), p.digest(), "the kind is part of the digested public section");
    // A file without the key reads as sha256.
    let back: SwapPublic = serde_json::from_str(&serde_json::to_string(&q).unwrap()).unwrap();
    assert_eq!(back.params.eth.lock_kind, LockKind::Sha256);
    let back: SwapPublic = serde_json::from_str(&serde_json::to_string(&p).unwrap()).unwrap();
    assert_eq!(back.params.eth.lock_kind, LockKind::Poseidon);
}

#[test]
fn the_stock_variant_is_refused_for_poseidon_with_a_clear_message() {
    let s = Secret::generate().unwrap();
    let cast = swap_cli::htlc_harness::Cast::new();
    let mut eth = poseidon_public(&s).params.eth.clone();
    eth.code_hash = None;
    let err = SwapPublic::build_with_options(&s, Variant::Stock, ProfileName::Production, ContractVersion::V1, &cast.alice, &cast.bob, 10_000_000, 5_800, 300_000, eth).unwrap_err();
    assert!(matches!(&err, SwapFileError::Invalid(m) if m.contains("raw variant") && m.contains("stock")), "{err:?}");
    // A bundle that was edited into a stock poseidon one is refused by `check`.
    let mut p = poseidon_public(&s);
    p.params.variant = Variant::Stock;
    assert!(matches!(p.check(), Err(SwapFileError::Invalid(m)) if m.contains("raw variant")));
}

#[test]
fn each_lock_kind_refuses_the_other_contracts_code_hash() {
    let s = Secret::generate().unwrap();
    // A poseidon file pinning HTLC.sol, and a sha256 file pinning the V2 contract.
    let mut p = poseidon_public(&s);
    p.params.eth.code_hash = Some(params::HTLC_CODE_HASH);
    assert!(matches!(p.check(), Err(SwapFileError::Invalid(m)) if m.contains("HTLCPoseidonV2") && m.contains(&hex::encode(params::HTLC_POSEIDON_V2_CODE_HASH))));
    p.params.eth.code_hash = None;
    assert!(matches!(p.check(), Err(SwapFileError::Invalid(m)) if m.contains("not pinned")));
    let mut q = example_public_kind(&s, Variant::Raw, ProfileName::Production, ContractVersion::V1, LockKind::Sha256);
    q.params.eth.code_hash = Some(params::HTLC_POSEIDON_V2_CODE_HASH);
    assert!(matches!(q.check(), Err(SwapFileError::Invalid(m)) if m.contains(&hex::encode(params::HTLC_CODE_HASH))));
    // A bundle whose kind was flipped by hand: the pin no longer fits the kind.
    let mut flipped = poseidon_public(&s);
    flipped.params.eth.lock_kind = LockKind::Sha256;
    assert!(flipped.check().is_err());
}

#[test]
fn the_poseidon_lock_word_must_be_the_claim_authority_bytes() {
    let s = Secret::generate().unwrap();
    let mut p = poseidon_public(&s);
    p.hashlock = sha256(s.bytes()); // the sha256 word where the address belongs
    assert!(matches!(p.check(), Err(SwapFileError::Invalid(m)) if m.contains("claim_authority")));
    let mut p = poseidon_public(&s);
    p.hashlock[31] ^= 1;
    assert!(p.check().is_err());
    // Bob compares the word with the claim authority of the opening HE rebuilt, in the terms check too (not only in `check`).
    let mut p = poseidon_public(&s);
    p.hashlock = Secret::generate().unwrap().authority(Variant::Raw).0; // another address
    let terms = example_bob_terms(&p);
    assert!(matches!(p.check_bob_terms(&terms), Err(SwapFileError::Invalid(m)) if m.contains("claim authority A of the NOID opening")));
}

#[test]
fn the_public_test_vector_words_are_refused_for_poseidon() {
    let cast = swap_cli::htlc_harness::Cast::new();
    let vector = Secret::from_bytes(swap_cli::htlc_harness::seq_bytes(0));
    let mut eth = poseidon_public(&Secret::generate().unwrap()).params.eth.clone();
    eth.code_hash = None;
    let err = SwapPublic::build_with_options(&vector, Variant::Raw, ProfileName::Production, ContractVersion::V1, &cast.alice, &cast.bob, 10_000_000, 5_800, 300_000, eth).unwrap_err();
    assert_eq!(err, SwapFileError::PublicTestVector);
}

#[test]
fn bobs_poseidon_file_has_no_attestation_and_a_present_one_is_refused() {
    let s = Secret::generate().unwrap();
    let p = poseidon_public(&s);
    let terms = example_bob_terms(&p);
    let file = SwapFile::new_bob_with(p.clone(), &terms, None, 1).unwrap();
    assert!(file.equivalence.is_none() && file.client_r_selftest.is_none());
    // An attestation (the sha256 kind's receipt) is refused: a file does not claim a proof it does not need.
    let sha = example_public_kind(&s, Variant::Raw, ProfileName::Production, ContractVersion::V1, LockKind::Sha256);
    let att = swap_cli::swapfile::example_attestation(&sha);
    let err = SwapFile::new_bob_with(p.clone(), &terms, Some(&att), 1).unwrap_err();
    assert!(matches!(&err, SwapFileError::Invalid(m) if m.contains("needs no equivalence proof")), "{err:?}");
    assert!(SwapFile::new_bob(p.clone(), &terms, &att, 1).is_err());
    // And a sha256 file without one is still refused.
    let sha_terms = example_bob_terms(&sha);
    assert!(matches!(SwapFile::new_bob_with(sha, &sha_terms, None, 1), Err(SwapFileError::Invalid(m)) if m.contains("no equivalence attestation")));
    // A saved poseidon file loads without one; with one injected it no longer loads.
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("b.swap.json");
    file.save(&path).unwrap();
    assert_eq!(SwapFile::load(&path).unwrap().public.params.eth.lock_kind, LockKind::Poseidon);
    let mut with = file.clone();
    with.equivalence = Some(swap_cli::swapfile::example_attestation(&example_public_kind(&s, Variant::Raw, ProfileName::Production, ContractVersion::V1, LockKind::Sha256)));
    with.save(&path).unwrap();
    assert!(matches!(SwapFile::load(&path), Err(SwapFileError::Invalid(m)) if m.contains("must not carry an equivalence attestation")));
    // The self-test record is Bob's poseidon file only.
    let mut alice = SwapFile::new_alice(p.clone(), &s, &Passphrase::new("pw"), &KdfParams::fast_for_tests(), 1).unwrap();
    assert!(alice.record_client_r_selftest(example_selftest(&p, 1), 1).is_err());
    let mut ok = file.clone();
    ok.record_client_r_selftest(example_selftest(&p, 1), 1).unwrap();
    assert_eq!(ok.history.last().map(|h| h.event.as_str()), Some("client_r_selftest_passed"));
    ok.save(&path).unwrap();
    assert!(SwapFile::load(&path).unwrap().client_r_selftest.is_some());
    // REVIEW-6 R6-4: a record made for another swap (another lock word) or another contract version is not kept.
    let other = poseidon_public(&Secret::generate().unwrap());
    assert!(matches!(file.clone().record_client_r_selftest(example_selftest(&other, 1), 1), Err(SwapFileError::Invalid(m)) if m.contains("another lock word")));
    let mut wrong_version = example_selftest(&p, 1);
    wrong_version.contract_version = 2;
    assert!(file.clone().record_client_r_selftest(wrong_version, 1).is_err());
    alice.client_r_selftest = Some(example_selftest(&p, 1));
    alice.save(&path).unwrap();
    assert!(matches!(SwapFile::load(&path), Err(SwapFileError::Invalid(m)) if m.contains("self-test record belongs")));
}

#[test]
fn bobs_terms_must_name_the_same_kind_and_the_v2_code_hash() {
    let s = Secret::generate().unwrap();
    let p = poseidon_public(&s);
    let mut terms = example_bob_terms(&p);
    assert!(p.check_bob_terms(&terms).is_ok());
    terms.lock_kind = LockKind::Sha256;
    assert!(matches!(p.check_bob_terms(&terms), Err(SwapFileError::Invalid(m)) if m.contains("--eth-lock-kind")));
    let mut terms = example_bob_terms(&p);
    terms.eth_code_hash = params::HTLC_CODE_HASH;
    assert!(matches!(p.check_bob_terms(&terms), Err(SwapFileError::Invalid(m)) if m.contains("HTLCPoseidonV2")));
    // The reverse: a sha256 bundle against terms asking for poseidon.
    let q = example_public_kind(&s, Variant::Raw, ProfileName::Production, ContractVersion::V1, LockKind::Sha256);
    let mut terms = example_bob_terms(&q);
    terms.lock_kind = LockKind::Poseidon;
    assert!(q.check_bob_terms(&terms).is_err());
}

#[test]
fn alices_poseidon_file_seals_the_secret_and_opens_it_only_for_the_right_one() {
    let s = Secret::generate().unwrap();
    let p = poseidon_public(&s);
    let pass = Passphrase::new("correct horse");
    let file = SwapFile::new_alice(p.clone(), &s, &pass, &KdfParams::fast_for_tests(), 1).unwrap();
    assert_eq!(file.decrypt_secret(&pass).unwrap(), s);
    assert_eq!(SwapFile::new_alice(p, &Secret::generate().unwrap(), &pass, &KdfParams::fast_for_tests(), 1).unwrap_err(), SwapFileError::SecretMismatch);
}

// ------------------------------------------------------------------------------------------------ client R

fn claim_inputs<'a>(p: &'a SwapPublic, opening: &'a noid_tx::experimental_object::ObjectOpening, inst: &'a NoidInstance, h: u64, secret: &'a Secret) -> ClaimInputs<'a> {
    ClaimInputs {
        opening,
        instance: inst,
        output_slot: 2,
        fee_micronoid: 6_000,
        epoch_anchor: [7; 32],
        call_height: h,
        hashlock: p.hashlock,
        lock_kind: LockKind::Poseidon,
        variant: Variant::Raw,
        secret,
    }
}

#[test]
fn client_r_builds_and_verifies_a_claim_for_a_poseidon_lock_and_the_self_test_records_the_version() {
    let s = Secret::generate().unwrap();
    let p = poseidon_public(&s);
    let opening = p.opening().unwrap();
    let inst = NoidInstance { slot_index: 11, creation_id: 3, amount_micronoid: p.params.amount_micronoid };
    let h = p.params.deadline_height - 18;
    let plan = build_claim(claim_inputs(&p, &opening, &inst, h, &s)).unwrap();
    verify_intent_bytes(&plan.intent_bytes, h).unwrap();
    assert_eq!(plan.recipient.to_bech32(), p.params.bob_noid);
    // Another secret: its address is not the lock word.
    assert!(build_claim(claim_inputs(&p, &opening, &inst, h, &Secret::generate().unwrap())).is_err());
    // The self-test is the same machinery on a throwaway lock.
    let rec = client_r_selftest(h, 42, &p).unwrap();
    assert_eq!(rec.auth_version, "V4");
    assert_eq!((rec.call_height, rec.passed_at), (h, 42));
    assert_eq!(rec.auth_version, example_selftest(&p, 0).auth_version);
    // REVIEW-6 R6-4: the record names the swap it vouches for, its contract version and the build.
    assert_eq!(rec.lock_word, hex::encode(p.hashlock));
    assert_eq!((rec.contract_version, rec.build_id.as_str()), (1, swap_cli::build_id().as_str()));
    // ... and a version 2 swap gets a version 2 throwaway (the fixed-fee rule, its own program), recorded as such.
    let p2 = example_public_kind(&s, Variant::Raw, ProfileName::Production, ContractVersion::V2, LockKind::Poseidon);
    let rec2 = client_r_selftest(h, 43, &p2).unwrap();
    assert_eq!((rec2.contract_version, rec2.lock_word.as_str()), (2, hex::encode(p2.hashlock).as_str()));
}

// ------------------------------------------------------------------------------------------------ the watcher

const CONTRACT: &str = "5fbdb2315678afecb367f032d93f642f64180aa3";
const BOB: &str = "70997970c51812dc3a010c7d01b50e0d17dc79c8";
const ALICE: &str = "3c44cdddb6a900fa2b585dd299e03d12fa4293bc";
const STRANGER: &str = "90f79bf6eb2c4f870365e785982e1f101e93b906";

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

fn num(n: u128) -> [u8; 32] {
    let mut w = [0u8; 32];
    w[16..].copy_from_slice(&n.to_be_bytes());
    w
}

#[derive(Clone)]
struct Held {
    sender: [u8; 20],
    receiver: [u8; 20],
    amount: u128,
    word: [u8; 32],
    timelock: u64,
    block: u64,
    /// `getLock` says claimed with this stored preimage (and no `Claimed` log exists: the record path).
    claimed: Option<[u8; 32]>,
}

impl Held {
    fn id(&self) -> [u8; 32] {
        compute_lock_id(&self.sender, &self.receiver, self.amount, &self.word, self.timelock)
    }
}

#[derive(Clone, Default)]
struct Node {
    held: Vec<Held>,
    /// `(tx hash, calldata)` of pending transactions to the contract.
    pending: Vec<([u8; 32], Vec<u8>)>,
    /// The sender query (REVIEW-7 R7-1: topics `[Locked, null, sender]`) fails with this node error.
    scan_error: bool,
    /// The sender query answers without the locks the targeted query finds (a provider that silently cut the range).
    hide_from_scan: bool,
    /// The sender query is refused with a JSON-RPC error when its block range (`toBlock - fromBlock + 1`, `latest` = block 100) is larger than this.
    range_limit: Option<u64>,
    /// The sender query ignores the topic filter and answers with EVERY `Locked` log (a non-conforming provider); the watcher must filter locally.
    ignore_filter: bool,
    /// REVIEW-7 R7-5: the node's block at a numbered height has another hash than the receipts of `mined` name (a reorg, or a node on a fork).
    fork_block: bool,
    /// REVIEW-7 R7-5: the node has no block at a numbered height (it lags).
    no_block: bool,
    /// Mined transactions (for `--reveal-tx`): the node knows the transaction and its receipt.
    mined: Vec<Mined>,
}

#[derive(Clone)]
struct Mined {
    hash: [u8; 32],
    from: [u8; 20],
    to: [u8; 20],
    input: Vec<u8>,
    /// Receipt status: 1 succeeded, 0 reverted.
    status: u64,
    no_receipt: bool,
}

fn node(n: Node) -> (ScriptedRpc<impl Fn(&str, &Value) -> Result<Value, RpcError>>, std::sync::Arc<std::sync::Mutex<Vec<(String, Value)>>>) {
    let calls = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
    let log = calls.clone();
    let rpc = ScriptedRpc(move |m: &str, p: &Value| -> Result<Value, RpcError> {
        log.lock().unwrap().push((m.to_string(), p.clone()));
        let log_of = |h: &Held| {
            let mut data = Vec::new();
            data.extend_from_slice(&num(h.amount));
            data.extend_from_slice(&h.word);
            data.extend_from_slice(&num(h.timelock as u128));
            json!({
                "removed": false, "address": format!("0x{CONTRACT}"),
                "topics": [hex0x(&TOPIC_LOCKED), hex0x(&h.id()), hex0x(&pad(&h.sender)), hex0x(&pad(&h.receiver))],
                "data": hex0x(&data), "blockNumber": format!("0x{:x}", h.block), "transactionHash": hex0x(&[0xee; 32]),
            })
        };
        match m {
            "eth_blockNumber" => Ok(json!("0x64")),
            "eth_getBlockByNumber" => match p[0].as_str().unwrap() {
                "latest" => Ok(json!({"number": "0x64", "timestamp": "0x6553f100"})),
                "finalized" => Ok(json!({"number": "0x60", "timestamp": "0x6553f000"})),
                "0x65" if n.no_block => Ok(Value::Null),
                // REVIEW-7 R7-5: a numbered block has a hash; `fork_block` makes it another one than the mined transactions' receipts name.
                _ => Ok(json!({"number": p[0], "timestamp": "0x6553e000", "hash": hex0x(&[if n.fork_block { 0xb2 } else { 0xb1 }; 32])})),
            },
            "eth_chainId" => Ok(json!("0x7a69")),
            "eth_getCode" => Ok(json!(if p[0].as_str().unwrap() == format!("0x{CONTRACT}") { "0x6001" } else { "0x" })),
            "eth_getLogs" => {
                let topics = p[0]["topics"].as_array().unwrap();
                if topics[0].is_string() && topics.len() == 3 {
                    // The sender query (REVIEW-7 R7-1): topic0 = Locked, topic1 = any, topic2 = Bob's sender.
                    if n.scan_error {
                        return Err(RpcError::Remote { code: -32005, message: "query returned more than 10000 results".into() });
                    }
                    let block = |v: &Value| if v == "latest" { 100 } else { u64::from_str_radix(v.as_str().unwrap().trim_start_matches("0x"), 16).unwrap() };
                    let (from, to) = (block(&p[0]["fromBlock"]), block(&p[0]["toBlock"]));
                    if let Some(limit) = n.range_limit {
                        let span = to.saturating_sub(from) + 1;
                        if span > limit {
                            return Err(RpcError::Remote { code: -32602, message: format!("block range too large ({span} > {limit})") });
                        }
                    }
                    if n.hide_from_scan {
                        return Ok(json!([]));
                    }
                    let ws = topics[2].as_str().unwrap();
                    return Ok(Value::Array(n.held.iter().filter(|h| h.block >= from && h.block <= to && (n.ignore_filter || hex0x(&pad(&h.sender)) == ws)).map(log_of).collect()));
                }
                if topics[0].is_string() {
                    // The indexed query (REVIEW-6 R6-1): topic0 = Locked, topic2 = sender, topic3 = receiver.
                    let (ws, wr) = (topics[2].as_str().unwrap(), topics[3].as_str().unwrap());
                    return Ok(Value::Array(n.held.iter().filter(|h| hex0x(&pad(&h.sender)) == ws && hex0x(&pad(&h.receiver)) == wr).map(log_of).collect()));
                }
                let want = p[0]["topics"][1].as_str().unwrap();
                Ok(Value::Array(n.held.iter().filter(|h| hex0x(&h.id()) == want).map(log_of).collect()))
            }
            "eth_call" => {
                let data = hex::decode(p[0]["data"].as_str().unwrap().trim_start_matches("0x")).unwrap();
                match n.held.iter().find(|h| h.id()[..] == data[4..36]) {
                    Some(h) => {
                        let mut out = Vec::new();
                        out.extend_from_slice(&pad(&h.sender));
                        out.extend_from_slice(&pad(&h.receiver));
                        out.extend_from_slice(&num(h.amount));
                        out.extend_from_slice(&h.word);
                        out.extend_from_slice(&num(h.timelock as u128));
                        out.extend_from_slice(&num(u128::from(h.claimed.is_some())));
                        out.extend_from_slice(&[0u8; 32]);
                        out.extend_from_slice(&h.claimed.unwrap_or([0u8; 32]));
                        Ok(json!(hex0x(&out)))
                    }
                    None => Err(RpcError::Remote { code: 3, message: "execution reverted: LockNotFound".into() }),
                }
            }
            "eth_getTransactionByHash" => {
                let want = p[0].as_str().unwrap();
                if let Some(t) = n.mined.iter().find(|t| hex0x(&t.hash) == want) {
                    return Ok(json!({"hash": hex0x(&t.hash), "from": hex0x(&t.from), "to": hex0x(&t.to), "input": hex0x(&t.input), "blockNumber": "0x65", "blockHash": hex0x(&[0xb1; 32])}));
                }
                match n.pending.iter().find(|(h, _)| hex0x(h) == want) {
                    Some((_, input)) => Ok(json!({"to": format!("0x{CONTRACT}"), "input": hex0x(input), "blockNumber": null})),
                    None => Ok(Value::Null),
                }
            }
            "eth_getTransactionReceipt" => {
                let want = p[0].as_str().unwrap();
                match n.mined.iter().find(|t| hex0x(&t.hash) == want) {
                    Some(t) if !t.no_receipt => Ok(json!({"transactionHash": hex0x(&t.hash), "blockNumber": "0x65", "blockHash": hex0x(&[0xb1; 32]), "status": format!("0x{:x}", t.status)})),
                    _ => Ok(Value::Null),
                }
            }
            other => Err(RpcError::Remote { code: -32601, message: format!("unexpected {other}") }),
        }
    });
    (rpc, calls)
}

fn word_of(s: &Secret) -> [u8; 32] {
    s.lock_word(LockKind::Poseidon)
}

fn ours(word: [u8; 32]) -> Held {
    Held { sender: a20(BOB), receiver: a20(ALICE), amount: 10u128.pow(16), word, timelock: 1_700_007_200, block: 10, claimed: None }
}

fn rule(word: [u8; 32]) -> LockDiscovery {
    LockDiscovery { sender: a20(BOB), receiver: a20(ALICE), hashlock: word }
}

fn claim_calldata(lock_id: &[u8; 32], preimage: &[u8; 32], extra: usize) -> Vec<u8> {
    let mut d = SELECTOR_CLAIM.to_vec();
    d.extend_from_slice(lock_id);
    d.extend_from_slice(preimage);
    d.extend(std::iter::repeat_n(0xab, extra));
    d
}

/// The calls of the sender query (REVIEW-7 R7-1): `eth_getLogs` with topics `[Locked, null, sender]` (three entries).
fn sender_queries(calls: &std::sync::Arc<std::sync::Mutex<Vec<(String, Value)>>>) -> Vec<Value> {
    calls.lock().unwrap().iter().filter(|(m, p)| m == "eth_getLogs" && p[0]["topics"].as_array().is_some_and(|t| t.len() == 3)).map(|(_, p)| p.clone()).collect()
}

#[test]
fn the_poseidon_word_check_asks_the_indexed_sender_topic_and_reports_only_bobs_own_locks_on_the_word() {
    let s = Secret::generate().unwrap();
    let word = word_of(&s);
    let mine = ours(word);
    // Another lock of BOB's sender on the same A (to another receiver), someone else's lock on it, and an unrelated lock of Bob's.
    let bob_again = Held { receiver: a20(STRANGER), timelock: 1_700_009_998, block: 13, ..ours(word) };
    let foreign = Held { sender: a20(STRANGER), receiver: a20(STRANGER), timelock: 1_700_009_999, block: 11, ..ours(word) };
    let other_word = Held { word: [0x55; 32], block: 12, ..ours([0x55; 32]) };
    let (rpc, calls) = node(Node { held: vec![mine.clone(), bob_again.clone(), foreign.clone(), other_word], ..Default::default() });
    let obs = EthWatcher::new(&rpc, a20(CONTRACT), [0u8; 32]).with_lock_kind(LockKind::Poseidon).with_discovery(rule(word)).with_word_scan(true).observe().unwrap();
    // Our lock is found by the agreed parties and the word, as for sha256.
    assert_eq!(obs.lock.as_ref().map(|l| l.lock_id), Some(mine.id()));
    assert_eq!(obs.locks.len(), 1);
    assert_eq!(obs.word_scan, WordScan::Complete);
    // Bob's own locks that carry the word are reported, and only those: the stranger's lock is not read at all.
    let mut ids: Vec<[u8; 32]> = obs.word_locks.iter().map(|w| w.lock_id).collect();
    ids.sort();
    let mut want = vec![mine.id(), bob_again.id()];
    want.sort();
    assert_eq!(ids, want);
    assert!(obs.word_locks.contains(&WordLock { lock_id: bob_again.id(), sender: a20(BOB), receiver: a20(STRANGER), amount_wei: 10u128.pow(16), timelock: 1_700_009_998, block_number: 13 }));
    // The check is ONE eth_getLogs over the whole range with the sender as indexed topic2 (the word is in the data, not a topic), never a
    // query for every Locked log.
    let scan_calls = sender_queries(&calls);
    assert_eq!(scan_calls.len(), 1);
    assert_eq!(scan_calls[0][0]["topics"], json!([hex0x(&TOPIC_LOCKED), null, hex0x(&pad(&a20(BOB)))]));
    assert_eq!((scan_calls[0][0]["fromBlock"].as_str(), scan_calls[0][0]["toBlock"].as_str()), (Some("0x0"), Some("latest")));
    let unfiltered = calls.lock().unwrap().iter().filter(|(m, p)| m == "eth_getLogs" && p[0]["topics"].as_array().is_some_and(|t| t.len() == 1)).count();
    assert_eq!(unfiltered, 0, "no query for every Locked log of the contract is ever made");
    let scans = sender_queries;
    // REVIEW-6 R6-1: the swap's own locks are found by the indexed sender/receiver topics (one more eth_getLogs, four topics).
    let indexed = calls.lock().unwrap().iter().filter(|(m, p)| m == "eth_getLogs" && p[0]["topics"].as_array().is_some_and(|t| t.len() == 4 && t[0].is_string())).count();
    assert_eq!(indexed, 1);
    // Without the scan flag (every poll after Bob's lock, and Alice's) there is NO all-`Locked` query at all: the result is the same lock.
    let (rpc, calls) = node(Node { held: vec![mine.clone(), foreign.clone()], scan_error: true, ..Default::default() });
    let obs = EthWatcher::new(&rpc, a20(CONTRACT), [0u8; 32]).with_lock_kind(LockKind::Poseidon).with_discovery(rule(word)).observe().unwrap();
    assert_eq!(obs.lock.as_ref().map(|l| l.lock_id), Some(mine.id()));
    assert_eq!((obs.word_scan.clone(), obs.word_locks.len()), (WordScan::NotRun, 0));
    assert!(scans(&calls).is_empty());
    // The sha256 kind does not scan even when asked: the watcher reports no word locks.
    let (rpc, _) = node(Node { held: vec![mine.clone()], ..Default::default() });
    let obs = EthWatcher::new(&rpc, a20(CONTRACT), [0u8; 32]).with_discovery(rule(word)).with_word_scan(true).observe().unwrap();
    assert!(obs.word_locks.is_empty() && obs.lock.is_some() && obs.word_scan == WordScan::NotRun);
}

#[test]
fn a_failed_poseidon_scan_is_a_state_of_the_observation_never_an_error_of_the_poll() {
    let s = Secret::generate().unwrap();
    let word = word_of(&s);
    let mine = ours(word);
    let poll = |n: Node, pinned: [u8; 32]| {
        let (rpc, _) = node(n);
        EthWatcher::new(&rpc, a20(CONTRACT), pinned).with_lock_kind(LockKind::Poseidon).with_discovery(rule(word)).with_word_scan(true).observe()
    };
    let failed = |o: &swap_cli::watch::EthObservation| match &o.word_scan {
        WordScan::Failed(why) => why.clone(),
        other => panic!("expected a failed scan, got {other:?}"),
    };
    // A node error (the usual way a range cap shows) is a failed scan; the poll itself succeeds and shows the lock.
    let o = poll(Node { held: vec![mine.clone()], scan_error: true, ..Default::default() }, [0u8; 32]).unwrap();
    assert!(failed(&o).contains("10000"), "{o:?}");
    assert!(o.word_locks.is_empty() && o.lock.is_some());
    // REVIEW-7 R7-1: the size of the contract's log is irrelevant now. 1,000 (or 5,000, 10,000, 20,000) locks of OTHER senders pad nothing: the
    // node is asked for Bob's sender only, and the check is complete.
    for n in [1_000u64, 5_000] {
        let padding: Vec<Held> = (0..n).map(|i| Held { sender: a20(STRANGER), timelock: 1_800_000_000 + i, word: [0x77; 32], ..ours([0x77; 32]) }).collect();
        let o = poll(Node { held: padding, ..Default::default() }, [0u8; 32]).unwrap();
        assert_eq!((o.word_scan.clone(), o.word_locks.len()), (WordScan::Complete, 0), "{n} locks of strangers");
    }
    // A provider that IGNORES the topic filter and answers with all of them (exactly 1,000 foreign logs plus Bob's): every log is re-checked
    // locally, the foreign ones are dropped, and Bob's own lock on the word is still found.
    let padding: Vec<Held> = (0..999u64).map(|i| Held { sender: a20(STRANGER), timelock: 1_800_000_000 + i, ..ours(word) }).collect();
    let mut held = padding;
    held.push(mine.clone());
    let o = poll(Node { held, ignore_filter: true, ..Default::default() }, [0u8; 32]).unwrap();
    assert_eq!(o.word_scan, WordScan::Complete);
    assert_eq!(o.word_locks.iter().map(|w| w.lock_id).collect::<Vec<_>>(), vec![mine.id()], "only Bob's sender is kept");
    // A node that limits the block range refuses the whole-range call; the query is then repeated in chunks, each re-checked locally.
    let late = Held { block: 95, timelock: 1_700_008_000, ..ours(word) };
    let ranged = Node { held: vec![mine.clone(), late.clone()], range_limit: Some(30), ..Default::default() };
    let (rpc, calls) = node(ranged.clone());
    let o = EthWatcher::new(&rpc, a20(CONTRACT), [0u8; 32]).with_lock_kind(LockKind::Poseidon).with_discovery(rule(word)).with_word_scan(true).with_log_range_max(30).observe().unwrap();
    assert_eq!(o.word_scan, WordScan::Complete, "{o:?}");
    let mut ids: Vec<[u8; 32]> = o.word_locks.iter().map(|w| w.lock_id).collect();
    ids.sort();
    let mut want = vec![mine.id(), late.id()];
    want.sort();
    assert_eq!(ids, want, "a lock in the last chunk is found");
    let ranges: Vec<(String, String)> =
        sender_queries(&calls).iter().map(|q| (q[0]["fromBlock"].as_str().unwrap().to_string(), q[0]["toBlock"].as_str().unwrap().to_string())).collect();
    assert_eq!(
        ranges,
        vec![("0x0", "latest"), ("0x0", "0x1d"), ("0x1e", "0x3b"), ("0x3c", "0x59"), ("0x5a", "0x64")].into_iter().map(|(a, b)| (a.to_string(), b.to_string())).collect::<Vec<_>>(),
        "the whole range first, then chunks of 30 blocks up to the latest block"
    );
    // A chunk that the node refuses as well fails the check (never "no earlier lock" by silence).
    let (rpc, _) = node(Node { range_limit: Some(10), ..ranged });
    let o = EthWatcher::new(&rpc, a20(CONTRACT), [0u8; 32]).with_lock_kind(LockKind::Poseidon).with_discovery(rule(word)).with_word_scan(true).with_log_range_max(30).observe().unwrap();
    assert!(failed(&o).contains("block range too large") && o.word_locks.is_empty(), "{o:?}");
    // The query that does not contain a lock the targeted query finds was cut: it cannot be trusted to show an earlier lock either.
    let o = poll(Node { held: vec![mine.clone()], hide_from_scan: true, ..Default::default() }, mine.id()).unwrap();
    assert!(failed(&o).contains("truncated"), "{o:?}");
    assert!(o.word_locks.is_empty(), "a scan that cannot be trusted reports no list");
    // R6-1: AFTER the reveal Bob's claim path depends on the targeted queries alone: a pending claim is read although the scan would fail.
    let s2 = Secret::generate().unwrap();
    let word2 = word_of(&s2);
    let held = ours(word2);
    let calldata = claim_calldata(&held.id(), s2.bytes(), 0);
    let (rpc, _) = node(Node { held: vec![held.clone()], pending: vec![([3; 32], calldata)], scan_error: true, ..Default::default() });
    let o = EthWatcher::new(&rpc, a20(CONTRACT), held.id())
        .with_lock_kind(LockKind::Poseidon)
        .with_discovery(rule(word2))
        .with_pending_txs(vec![[3; 32]])
        .observe()
        .unwrap();
    assert_eq!(o.pending_preimage.as_ref().map(|p| p.preimage), Some(*s2.bytes()));
    assert_eq!(o.word_scan, WordScan::NotRun);
}

#[test]
fn a_claimed_poseidon_lock_is_accepted_only_for_a_preimage_whose_address_is_the_word() {
    let s = Secret::generate().unwrap();
    let word = word_of(&s);
    let mut claimed = ours(word);
    claimed.claimed = Some(*s.bytes());
    let (rpc, _) = node(Node { held: vec![claimed.clone()], ..Default::default() });
    let obs = EthWatcher::new(&rpc, a20(CONTRACT), claimed.id()).with_lock_kind(LockKind::Poseidon).with_discovery(rule(word)).observe().unwrap();
    assert_eq!(obs.claimed.as_ref().map(|c| c.preimage), Some(*s.bytes()));
    assert!(obs.claim_state_from_record);
    // A stored preimage that is not the address preimage is a lie of the node: the poll fails (SHA-256 is irrelevant for this kind).
    let mut lie = ours(word);
    lie.claimed = Some([0x99; 32]);
    let (rpc, _) = node(Node { held: vec![lie.clone()], ..Default::default() });
    assert!(EthWatcher::new(&rpc, a20(CONTRACT), lie.id()).with_lock_kind(LockKind::Poseidon).with_discovery(rule(word)).observe().is_err());
    // The sha256 kind on the same data would accept nothing here either (word is not SHA-256 of the secret): the check is per kind.
    let (rpc, _) = node(Node { held: vec![claimed.clone()], ..Default::default() });
    assert!(EthWatcher::new(&rpc, a20(CONTRACT), claimed.id()).with_discovery(rule(word)).observe().is_err());
}

fn observe_pending(kind: LockKind, word: [u8; 32], pending: Vec<([u8; 32], Vec<u8>)>) -> swap_cli::watch::EthObservation {
    let mine = ours(word);
    let id = mine.id();
    let hashes: Vec<[u8; 32]> = pending.iter().map(|(t, _)| *t).collect();
    let (rpc, _) = node(Node { held: vec![mine], pending, ..Default::default() });
    EthWatcher::new(&rpc, a20(CONTRACT), id).with_lock_kind(kind).with_discovery(rule(word)).with_pending_txs(hashes).observe().unwrap()
}

#[test]
fn a_pending_poseidon_claim_is_a_reveal_only_at_exactly_68_bytes_and_a_longer_one_still_shows_the_secret() {
    let s = Secret::generate().unwrap();
    let word = word_of(&s);
    let id = ours(word).id();
    let h = |b: u8| [b; 32];
    // A junk preimage reverts and shows nothing; the right secret with one trailing byte reverts (BadCalldataLength) but the secret is out.
    let junk = (h(1), claim_calldata(&id, &[0x99; 32], 0));
    let long = (h(2), claim_calldata(&id, s.bytes(), 1));
    let exact = (h(3), claim_calldata(&id, s.bytes(), 0));
    let obs = observe_pending(LockKind::Poseidon, word, vec![junk.clone(), long.clone()]);
    assert!(obs.pending_preimage.is_none(), "a claim that will revert is no reveal of Alice's");
    assert_eq!(obs.overlong_claim, Some(PendingPreimage { lock_id: id, preimage: *s.bytes(), tx_hash: h(2) }));
    // Exactly 68 bytes: the reveal.
    let obs = observe_pending(LockKind::Poseidon, word, vec![junk, long, exact]);
    assert_eq!(obs.pending_preimage.as_ref().map(|p| (p.preimage, p.tx_hash)), Some((*s.bytes(), h(3))));
    // The sha256 kind keeps its rule (exactly 68 bytes, SHA-256): the over-long claim is not looked at.
    let sha = sha256(s.bytes());
    let sha_id = ours(sha).id();
    let obs = observe_pending(LockKind::Sha256, sha, vec![(h(2), claim_calldata(&sha_id, s.bytes(), 1))]);
    assert!(obs.pending_preimage.is_none() && obs.overlong_claim.is_none());
    let obs = observe_pending(LockKind::Sha256, sha, vec![(h(3), claim_calldata(&sha_id, s.bytes(), 0))]);
    assert_eq!(obs.pending_preimage.as_ref().map(|p| p.preimage), Some(*s.bytes()));
}

// ------------------------------------------------------------------------------------------------ the engine

fn funded_bob_ready_to_lock() -> Scenario {
    let mut s = Scenario::poseidon();
    s.tick_alice();
    s.world.borrow_mut().advance_noid(1);
    s.tick_both();
    s.world.borrow_mut().advance_noid(17);
    s
}

#[test]
fn a_full_poseidon_swap_settles_and_pays_both_sides_without_any_equivalence_proof() {
    let mut s = Scenario::poseidon();
    assert!(s.bob.file.equivalence.is_none(), "the attestation is absent, not typed");
    s.run_to_lock_final();
    let ra = s.tick_alice();
    assert_eq!(ra.action.kind(), "reveal_eth", "{ra:?}");
    let rb = s.tick_bob();
    assert_eq!(rb.events, vec!["eth_preimage_seen", "claim_submitted"], "{rb:?}");
    s.world.borrow_mut().advance_eth(1);
    s.world.borrow_mut().advance_noid(1);
    s.tick_both();
    let lag = s.world.borrow().finality_lag;
    s.world.borrow_mut().advance_eth(lag + 1);
    s.world.borrow_mut().advance_noid(17);
    s.tick_both();
    assert!(matches!(s.alice.file.phase, Phase::Alice(AlicePhase::Done { .. })), "{}", s.alice_phase());
    assert!(matches!(s.bob.file.phase, Phase::Bob(BobPhase::Done { .. })), "{}", s.bob_phase());
    let w = s.world.borrow();
    assert_eq!(w.lock_kind, LockKind::Poseidon);
    assert_eq!(w.noid_payout.as_ref().unwrap().0, s.public.params.bob_noid);
    assert_eq!(w.eth_payout.unwrap().0, s.public.params.eth.alice_receiver);
    // The lock word on Ethereum is the claim authority bytes of the NOID opening.
    assert_eq!(w.lock.as_ref().unwrap().hashlock, s.public.opening().unwrap().claim_authority.0);
}

#[test]
fn bob_does_not_lock_before_his_client_r_self_test_has_passed_and_the_record_must_fit_the_version() {
    let mut s = funded_bob_ready_to_lock();
    s.bob.file.client_r_selftest = None;
    let r = s.tick_bob();
    assert_eq!(r.action.kind(), "wait", "{r:?}");
    assert!(matches!(&r.action, Action::Wait { reason } if reason.contains("self-test")), "{r:?}");
    assert_eq!(s.bob_phase(), "funding_final");
    assert!(s.world.borrow().lock_pending.is_none());
    // A record for the other owner-authorization version does not do.
    let good = example_selftest(&s.public, T0);
    let mut stale = good.clone();
    stale.auth_version = "V3".into();
    s.bob.file.client_r_selftest = Some(stale);
    let r = s.tick_bob();
    assert!(matches!(&r.action, Action::Wait { reason } if reason.contains("V3") && reason.contains("V4")), "{r:?}");
    // REVIEW-6 R6-4: a record is bound to the swap, the contract version, the build and the clock.
    let waits_with = |s: &mut Scenario, rec: swap_cli::swapfile::ClientRSelfTest, needle: &str| {
        s.bob.file.client_r_selftest = Some(rec);
        let r = s.tick_bob();
        assert!(matches!(&r.action, Action::Wait { reason } if reason.contains(needle)), "{needle}: {r:?}");
        assert!(s.world.borrow().lock_pending.is_none());
    };
    let mut other_swap = good.clone();
    other_swap.lock_word = hex::encode([0x42u8; 32]); // copied from another file
    waits_with(&mut s, other_swap, "not for this swap");
    let mut other_version = good.clone();
    other_version.contract_version = 2;
    waits_with(&mut s, other_version, "contract v2 but this swap uses v1");
    let mut other_build = good.clone();
    other_build.build_id = "swap-cli 0.0.1".into();
    waits_with(&mut s, other_build, "another build");
    let mut old_format = good.clone();
    old_format.lock_word = String::new();
    old_format.contract_version = 0;
    old_format.build_id = String::new(); // a record written before R6-4 carries none of the three
    waits_with(&mut s, old_format, "not for this swap");
    let now = s.world.borrow().eth_time;
    let mut aged = good.clone();
    aged.passed_at = now - swap_cli::engine::SELFTEST_MAX_AGE_S - 1;
    waits_with(&mut s, aged, "old (limit");
    let mut future = good.clone();
    future.passed_at = now + 10_000;
    waits_with(&mut s, future, "dated in the future");
    // The right one: Bob locks.
    s.bob.file.client_r_selftest = Some(good);
    let r = s.tick_bob();
    assert_eq!(r.action.kind(), "lock_eth", "{r:?}");
    assert_eq!(s.bob_phase(), "lock_submitted");
}

#[test]
fn bob_never_locks_in_a_poseidon_swap_that_has_no_self_test_and_alice_takes_the_noid_back_at_d() {
    let mut s = funded_bob_ready_to_lock();
    s.bob.file.client_r_selftest = None;
    s.tick_bob();
    s.world.borrow_mut().advance_noid(200);
    let rb = s.tick_bob();
    assert_eq!(rb.action.kind(), "abort", "{rb:?}");
    let tip = s.world.borrow().tip;
    s.world.borrow_mut().advance_noid(s.public.params.deadline_height - 1 - tip);
    let ra = s.tick_alice();
    assert_eq!(ra.action.kind(), "refund_noid", "{ra:?}");
    s.world.borrow_mut().advance_noid(1);
    s.tick_alice();
    s.world.borrow_mut().advance_noid(17);
    s.tick_alice();
    assert!(matches!(s.alice.file.phase, Phase::Alice(AlicePhase::Refunded { .. })), "{}", s.alice_phase());
    assert!(s.world.borrow().lock.is_none() && s.world.borrow().eth_payout.is_none());
}

#[test]
fn bob_does_not_lock_on_a_word_that_his_own_sender_already_locked_but_a_strangers_lock_only_makes_a_note() {
    let mut s = funded_bob_ready_to_lock();
    let bob = s.public.params.eth.bob_sender;
    let by_bob = WordLock { lock_id: [0xdd; 32], sender: bob, receiver: [0x02; 20], amount_wei: 7, timelock: 1_800_000_000, block_number: 3 };
    let by_stranger = WordLock { lock_id: [0xee; 32], sender: [0x01; 20], receiver: [0x02; 20], amount_wei: 7, timelock: 1_800_000_001, block_number: 4 };
    s.world.borrow_mut().word_locks_extra.push(by_bob.clone());
    let r = s.tick_bob();
    assert_eq!(r.action.kind(), "wait", "{r:?}");
    assert!(matches!(&r.action, Action::Wait { reason } if reason.contains("made by Bob's own sender")), "{r:?}");
    assert!(s.world.borrow().lock_pending.is_none());
    // The second node counts too: a lock only it shows is enough.
    s.world.borrow_mut().word_locks_extra.clear();
    let r = s.tick_bob_with(|_, eth| {
        let mut second = eth.clone();
        second.word_locks.push(by_bob.clone());
        eth.second = Some(Box::new(second));
    });
    assert_eq!(r.action.kind(), "wait", "{r:?}");
    // REVIEW-6 R6-2: somebody else's lock on the same word is reported and does NOT block (a 1-wei lock is no veto).
    s.world.borrow_mut().word_locks_extra.push(by_stranger.clone());
    let r = s.tick_bob();
    assert_eq!(r.action.kind(), "lock_eth", "{r:?}");
    assert!(r.notes.iter().any(|n| n.contains("other senders") && n.contains("not blocking")), "{:?}", r.notes);
}

#[test]
fn bob_does_not_lock_without_a_complete_scan_on_every_node_and_a_failed_scan_is_only_a_wait() {
    let mut s = funded_bob_ready_to_lock();
    // The scan did not run (a hand-built or older observation): no lock on a guess.
    let r = s.tick_bob_with(|_, eth| eth.word_scan = WordScan::NotRun);
    assert!(matches!(&r.action, Action::Wait { reason } if reason.contains("did not run")), "{r:?}");
    // The primary node's scan failed (a provider cap): wait, with the reason; nothing is locked.
    let r = s.tick_bob_with(|_, eth| eth.word_scan = WordScan::Failed("returned exactly 1000 entries".into()));
    assert!(matches!(&r.action, Action::Wait { reason } if reason.contains("could not be completed") && reason.contains("exactly 1000")), "{r:?}");
    assert!(r.notes.iter().any(|n| n.contains("not lock_eth")), "{:?}", r.notes);
    // The second node's failed scan holds Bob back as well.
    let r = s.tick_bob_with(|_, eth| {
        if let Some(second) = eth.second.as_mut() {
            second.word_scan = WordScan::Failed("range cap".into());
        }
    });
    assert!(matches!(&r.action, Action::Wait { reason } if reason.contains("second node")), "{r:?}");
    assert!(s.world.borrow().lock_pending.is_none());
    // A complete scan on both: Bob locks.
    let r = s.tick_bob();
    assert_eq!(r.action.kind(), "lock_eth", "{r:?}");
    // A dropped lock is not re-sent on a failed scan either (the re-send is a lock decision).
    s.world.borrow_mut().lock_pending = None;
    s.world.borrow_mut().advance_eth(swap_cli::engine::ETH_TX_GRACE_S / 12 + 5);
    let r = s.tick_bob();
    assert!(r.events.contains(&"eth_lock_dropped".to_string()), "{r:?}");
    let r = s.tick_bob_with(|_, eth| eth.word_scan = WordScan::Failed("range cap".into()));
    assert_eq!(r.action.kind(), "wait", "{r:?}");
    assert!(r.notes.iter().any(|n| n.contains("not re-sending the lock")), "{:?}", r.notes);
    let r = s.tick_bob();
    assert_eq!(r.action.kind(), "lock_eth", "{r:?}");
}

#[test]
fn the_full_scan_is_asked_only_while_bob_can_still_decide_to_lock() {
    use swap_cli::engine::word_scan_wanted;
    let fresh = Scenario::poseidon();
    assert!(word_scan_wanted(&fresh.bob.file), "received");
    assert!(!word_scan_wanted(&fresh.alice.file), "Alice never needs it");
    let mut s = funded_bob_ready_to_lock();
    assert_eq!(s.bob_phase(), "funded");
    assert!(word_scan_wanted(&s.bob.file));
    assert_eq!(s.tick_bob().action.kind(), "lock_eth");
    assert_eq!(s.bob_phase(), "lock_submitted");
    assert!(word_scan_wanted(&s.bob.file), "a dropped lock may be re-sent");
    let mut l = Scenario::poseidon();
    l.run_to_lock_final();
    assert_eq!(l.bob_phase(), "locked");
    assert!(!word_scan_wanted(&l.bob.file), "after the lock nothing rests on the scan");
    assert!(!word_scan_wanted(&l.alice.file));
    // The sha256 kind never scans.
    let sha = Scenario::with_kind(Variant::Raw, ProfileName::Production, ContractVersion::V1, LockKind::Sha256);
    assert!(!word_scan_wanted(&sha.bob.file));
}

#[test]
fn after_bobs_lock_a_failed_scan_changes_nothing_in_the_claim_path() {
    // The engine never reads `word_scan` once Bob has locked: a failed (or absent) scan cannot hold back the NOID claim.
    let mut s = Scenario::poseidon();
    s.run_to_lock_final();
    let ra = s.tick_alice();
    assert_eq!(ra.action.kind(), "reveal_eth", "{ra:?}");
    let rb = s.tick_bob_with(|_, eth| eth.word_scan = WordScan::Failed("range cap".into()));
    assert_eq!(rb.events, vec!["eth_preimage_seen", "claim_submitted"], "{rb:?}");
}

#[test]
fn a_dropped_poseidon_lock_is_not_re_sent_while_an_earlier_lock_of_bobs_own_sender_on_the_word_sits_on_chain() {
    let mut s = funded_bob_ready_to_lock();
    assert_eq!(s.tick_bob().action.kind(), "lock_eth");
    let original = match &s.bob.file.phase {
        Phase::Bob(BobPhase::LockSubmitted { t_reveal, .. }) => *t_reveal,
        other => panic!("{other:?}"),
    };
    s.world.borrow_mut().lock_pending = None; // dropped
    s.world.borrow_mut().advance_eth(swap_cli::engine::ETH_TX_GRACE_S / 12 + 5);
    let r = s.tick_bob();
    assert!(r.events.contains(&"eth_lock_dropped".to_string()), "{r:?}");
    let bob = s.public.params.eth.bob_sender;
    s.world.borrow_mut().word_locks_extra.push(WordLock { lock_id: [0xdd; 32], sender: bob, receiver: [0x02; 20], amount_wei: 7, timelock: 1_800_000_000, block_number: 3 });
    let r = s.tick_bob();
    assert_eq!(r.action.kind(), "wait", "{r:?}");
    assert!(r.notes.iter().any(|n| n.contains("not re-sending the lock")), "{:?}", r.notes);
    s.world.borrow_mut().word_locks_extra.clear();
    let r = s.tick_bob();
    assert!(matches!(r.action, Action::LockEth { t_reveal, .. } if t_reveal == original), "{r:?}");
}

#[test]
fn bob_claims_the_noid_from_a_pending_claim_with_a_trailing_byte_that_will_revert() {
    let mut s = Scenario::poseidon();
    s.run_to_lock_final();
    let lock_id = s.world.borrow().lock.as_ref().unwrap().lock_id;
    // Somebody (not Alice's tool) sent claim(lockId, s) plus a byte: HTLCPoseidonV2 reverts it, but s is in the mempool.
    s.world.borrow_mut().overlong_claim = Some(PendingPreimage { lock_id, preimage: *s.secret.bytes(), tx_hash: [0xcd; 32] });
    let rb = s.tick_bob();
    assert_eq!(rb.events, vec!["eth_preimage_seen", "claim_submitted"], "{rb:?}");
    assert_eq!(rb.action.kind(), "claim_noid");
}

#[test]
fn a_preimage_whose_address_is_not_the_word_is_not_the_secret() {
    let mut s = Scenario::poseidon();
    s.run_to_lock_final();
    let lock_id = s.world.borrow().lock.as_ref().unwrap().lock_id;
    s.world.borrow_mut().claim_pending = Some(PendingPreimage { lock_id, preimage: [0x5a; 32], tx_hash: [0xaa; 32] });
    let rb = s.tick_bob();
    assert_eq!(rb.action.kind(), "wait", "{rb:?}");
    assert!(rb.notes.iter().any(|n| n.contains("rejected")), "{:?}", rb.notes);
    assert_eq!(s.bob_phase(), "locked");
}

#[test]
fn chaos_and_scenarios_can_run_against_either_kind() {
    // The scenario constructors take the kind from the environment for the raw variant; the stock variant is always sha256.
    assert_eq!(default_lock_kind(Variant::Stock), LockKind::Sha256);
    let s = Scenario::with_kind(Variant::Raw, ProfileName::Production, ContractVersion::V2, LockKind::Poseidon);
    assert_eq!(s.public.params.contract_version, ContractVersion::V2);
    assert_eq!(s.public.params.eth.lock_kind, LockKind::Poseidon);
    assert!(example_bob_file(s.public.clone(), 1).unwrap().client_r_selftest.is_some());
}

// ------------------------------------------------------------------------------------------------ REVIEW-6 R6-3: a mined, reverted claim

fn alice_claim_tx(hash: u8, lock_id: &[u8; 32], preimage: &[u8; 32], extra: usize, status: u64) -> Mined {
    Mined { hash: [hash; 32], from: a20(ALICE), to: a20(CONTRACT), input: claim_calldata(lock_id, preimage, extra), status, no_receipt: false }
}

fn observe_reveal_tx(word: [u8; 32], mined: Vec<Mined>, hash: u8) -> swap_cli::watch::EthObservation {
    let held = ours(word);
    let (rpc, _) = node(Node { held: vec![held.clone()], mined, ..Default::default() });
    EthWatcher::new(&rpc, a20(CONTRACT), held.id()).with_lock_kind(LockKind::Poseidon).with_discovery(rule(word)).with_reveal_tx(Some([hash; 32])).observe().unwrap()
}

#[test]
fn the_watcher_reads_a_mined_reverted_claim_by_hash_and_trusts_nothing_it_was_not_told_by_the_node() {
    let s = Secret::generate().unwrap();
    let word = word_of(&s);
    let id = ours(word).id();
    // Status 0, from Alice's receiver, claim(lockId, s), also with one trailing byte (the BadCalldataLength revert): the secret is public.
    for extra in [0usize, 1] {
        let o = observe_reveal_tx(word, vec![alice_claim_tx(7, &id, s.bytes(), extra, 0)], 7);
        let rc = o.reverted_claim.expect("a reverted claim of this lock");
        assert_eq!((rc.lock_id, rc.preimage, rc.tx_hash, rc.block_number), (id, *s.bytes(), [7; 32], 0x65));
        assert!(o.reveal_tx_note.as_deref().unwrap().contains("REVERTED"), "{:?}", o.reveal_tx_note);
        assert!(o.claimed.is_none() && o.pending_preimage.is_none());
    }
    // Status 1: an ordinary claim; the Claimed event covers it, nothing is recorded as a revert.
    let o = observe_reveal_tx(word, vec![alice_claim_tx(7, &id, s.bytes(), 0, 1)], 7);
    assert!(o.reverted_claim.is_none() && o.reveal_tx_note.as_deref().unwrap().contains("SUCCEEDED"));
    // Not Alice's address, not our lock id, a preimage that does not open the word, another contract, a transfer: each is refused with a note.
    let refused = |m: Mined, why: &str| {
        let o = observe_reveal_tx(word, vec![m], 7);
        assert!(o.reverted_claim.is_none(), "{why}");
        let note = o.reveal_tx_note.unwrap();
        assert!(note.contains("IGNORED") && note.contains(why), "{note}");
    };
    refused(Mined { from: a20(STRANGER), ..alice_claim_tx(7, &id, s.bytes(), 0, 0) }, "not sent by the receiver");
    refused(alice_claim_tx(7, &[0x11; 32], s.bytes(), 0, 0), "not claim(lockId, preimage) for this lock id");
    refused(alice_claim_tx(7, &id, &[0x99; 32], 0, 0), "does not open this lock's word");
    refused(Mined { to: a20(STRANGER), ..alice_claim_tx(7, &id, s.bytes(), 0, 0) }, "not sent to the pinned contract");
    refused(Mined { input: vec![0xa9, 0x05, 0x9c, 0xbb], ..alice_claim_tx(7, &id, s.bytes(), 0, 0) }, "not claim(lockId, preimage)");
    // A hash the node does not know, a receipt that is not there yet: notes, no revert recorded, no error.
    let o = observe_reveal_tx(word, vec![], 7);
    assert!(o.reverted_claim.is_none() && o.reveal_tx_note.unwrap().contains("does not know"));
    let o = observe_reveal_tx(word, vec![Mined { no_receipt: true, ..alice_claim_tx(7, &id, s.bytes(), 0, 0) }], 7);
    assert!(o.reverted_claim.is_none() && o.reveal_tx_note.unwrap().contains("no receipt"));
    // No flag, no read.
    let held = ours(word);
    let (rpc, calls) = node(Node { held: vec![held.clone()], mined: vec![alice_claim_tx(7, &id, s.bytes(), 0, 0)], ..Default::default() });
    let o = EthWatcher::new(&rpc, a20(CONTRACT), held.id()).with_lock_kind(LockKind::Poseidon).with_discovery(rule(word)).observe().unwrap();
    assert!(o.reverted_claim.is_none() && o.reveal_tx_note.is_none());
    assert!(calls.lock().unwrap().iter().all(|(m, _)| m != "eth_getTransactionReceipt"));
}

#[test]
fn a_reverted_claim_whose_block_is_not_on_the_canonical_chain_is_not_recorded() {
    // REVIEW-7 R7-5: the receipt's block hash must be the hash of the node's block at that height.
    let s = Secret::generate().unwrap();
    let word = word_of(&s);
    let id = ours(word).id();
    let observe = |n: Node| {
        let held = ours(word);
        let (rpc, calls) = node(Node { held: vec![held.clone()], mined: vec![alice_claim_tx(7, &id, s.bytes(), 0, 0)], ..n });
        let o = EthWatcher::new(&rpc, a20(CONTRACT), held.id()).with_lock_kind(LockKind::Poseidon).with_discovery(rule(word)).with_reveal_tx(Some([7; 32])).observe().unwrap();
        let block_reads = calls.lock().unwrap().iter().filter(|(m, p)| m == "eth_getBlockByNumber" && p[0] == "0x65").count();
        (o, block_reads)
    };
    let (o, block_reads) = observe(Node::default());
    assert!(o.reverted_claim.is_some(), "{:?}", o.reveal_tx_note);
    assert_eq!(block_reads, 1, "the block of the transaction is read to compare hashes");
    let (o, _) = observe(Node { fork_block: true, ..Default::default() });
    assert!(o.reverted_claim.is_none(), "a receipt from a block the node does not have at that height proves nothing");
    let note = o.reveal_tx_note.unwrap();
    assert!(note.contains("NOT on the canonical chain") && note.contains("nothing was recorded"), "{note}");
    let (o, _) = observe(Node { no_block: true, ..Default::default() });
    assert!(o.reverted_claim.is_none() && o.reveal_tx_note.unwrap().contains("has no block"), "a lagging node records nothing");
}

#[test]
fn alices_file_learns_from_a_reverted_claim_that_the_secret_is_public_and_judges_a_resend_by_the_late_cutoff() {
    let mut s = Scenario::poseidon();
    s.run_to_lock_final();
    let lock = s.world.borrow().lock.clone().unwrap();
    let (noid, mut eth, now) = {
        let w = s.world.borrow();
        (w.noid_obs(None), w.eth_obs(), w.eth_time)
    };
    // The simulator attaches an agreeing second node to every observation; the first part is the single-node case, the second node comes back below.
    eth.second = None;
    let mut file = s.alice.file.clone();
    let before = swap_cli::engine::reveal_cutoff_for(&file, lock.timelock);
    assert!(!swap_cli::engine::secret_may_be_public(&file));
    // A reverted claim of ANOTHER lock id marks nothing.
    eth.reverted_claim = Some(RevertedClaim { lock_id: [0x44; 32], preimage: *s.secret.bytes(), tx_hash: [9; 32], block_number: 5 });
    swap_cli::engine::tick_apply(&mut file, &noid, &eth, now, true).unwrap();
    assert!(!swap_cli::engine::secret_may_be_public(&file));
    // This lock's: recorded once, and the cutoff moves from T_reveal - M_A to T_reveal - DE.
    eth.reverted_claim = Some(RevertedClaim { lock_id: lock.lock_id, preimage: *s.secret.bytes(), tx_hash: [9; 32], block_number: 5 });
    swap_cli::engine::tick_apply(&mut file, &noid, &eth, now, true).unwrap();
    swap_cli::engine::tick_apply(&mut file, &noid, &eth, now, true).unwrap();
    let marks = file.history.iter().filter(|h| h.event == swap_cli::engine::REVEAL_REVERTED_SEEN).count();
    assert_eq!(marks, 1);
    assert!(swap_cli::engine::secret_may_be_public(&file));
    assert!(swap_cli::engine::reveal_cutoff_for(&file, lock.timelock) > before, "the late cutoff leaves more time than the first-publication one");
    // REVIEW-7 R7-5: with a SECOND Ethereum node configured, both must report the same reverted claim.
    let rc = eth.reverted_claim.clone().unwrap();
    let mut both = eth.clone();
    both.second = Some(Box::new(eth.clone()));
    let mut file2 = s.alice.file.clone();
    swap_cli::engine::tick_apply(&mut file2, &noid, &both, now, true).unwrap();
    assert!(swap_cli::engine::secret_may_be_public(&file2), "both nodes agree");
    // Only one of them reports it (either one): nothing is recorded, and the notes say why.
    for (first_has, second_has) in [(true, false), (false, true)] {
        let mut one = eth.clone();
        let mut other = eth.clone();
        if !first_has {
            one.reverted_claim = None;
        }
        if !second_has {
            other.reverted_claim = None;
        }
        one.second = Some(Box::new(other));
        let mut f = s.alice.file.clone();
        let out = swap_cli::engine::tick_apply(&mut f, &noid, &one, now, true).unwrap();
        assert!(!swap_cli::engine::secret_may_be_public(&f), "one node alone ({first_has}, {second_has}) records nothing");
        assert!(out.decision.notes.iter().any(|n| n.contains("both must agree") && n.contains("NOT recorded")), "{:?}", out.decision.notes);
    }
    // The two nodes report different transactions: not recorded.
    let mut differ = eth.clone();
    let mut other = eth.clone();
    other.reverted_claim = Some(RevertedClaim { tx_hash: [0x77; 32], ..rc.clone() });
    differ.second = Some(Box::new(other));
    let mut f = s.alice.file.clone();
    let out = swap_cli::engine::tick_apply(&mut f, &noid, &differ, now, true).unwrap();
    assert!(!swap_cli::engine::secret_may_be_public(&f));
    assert!(out.decision.notes.iter().any(|n| n.contains("different reverted claims")), "{:?}", out.decision.notes);
    // A second node that was configured but failed: the first node alone is not enough.
    let mut failed = eth.clone();
    failed.second_error = Some("eth watcher (second node): connection refused".into());
    let mut f = s.alice.file.clone();
    let out = swap_cli::engine::tick_apply(&mut f, &noid, &failed, now, true).unwrap();
    assert!(!swap_cli::engine::secret_may_be_public(&f));
    assert!(out.decision.notes.iter().any(|n| n.contains("the second node failed")), "{:?}", out.decision.notes);
    // No second node at all (single-node setup): the one node's verified reading stands, as before.
    let mut single = s.alice.file.clone();
    swap_cli::engine::tick_apply(&mut single, &noid, &eth, now, true).unwrap();
    assert!(swap_cli::engine::secret_may_be_public(&single));
    // Bob's file never takes the marker (it is Alice's cutoff).
    let mut bob = s.bob.file.clone();
    swap_cli::engine::tick_apply(&mut bob, &noid, &eth, now, true).unwrap();
    assert!(bob.history.iter().all(|h| h.event != swap_cli::engine::REVEAL_REVERTED_SEEN));
    // A read-only tick (`record == false`) works on a copy in the CLI; the library call above wrote its own file only.
}

#[test]
fn bob_takes_the_secret_from_a_reverted_claim_and_checks_it_like_any_other_candidate() {
    let mut s = Scenario::poseidon();
    s.run_to_lock_final();
    let lock_id = s.world.borrow().lock.as_ref().unwrap().lock_id;
    s.world.borrow_mut().reverted_claim = Some(RevertedClaim { lock_id, preimage: *s.secret.bytes(), tx_hash: [0xcd; 32], block_number: 9 });
    let rb = s.tick_bob();
    assert_eq!(rb.events, vec!["eth_preimage_seen", "claim_submitted"], "{rb:?}");
    assert_eq!(rb.action.kind(), "claim_noid");
    // A reverted claim whose preimage does not open the lock is just a rejected candidate.
    let mut s = Scenario::poseidon();
    s.run_to_lock_final();
    let lock_id = s.world.borrow().lock.as_ref().unwrap().lock_id;
    s.world.borrow_mut().reverted_claim = Some(RevertedClaim { lock_id, preimage: [0x5a; 32], tx_hash: [0xcd; 32], block_number: 9 });
    let rb = s.tick_bob();
    assert_eq!(rb.action.kind(), "wait", "{rb:?}");
    assert!(rb.notes.iter().any(|n| n.contains("rejected")), "{:?}", rb.notes);
}
