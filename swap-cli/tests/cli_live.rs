//! The live-network layer of the binary, tested without any external network:
//! flag parsing for `tick`/`claim`, `tick` over a loopback mock node (and its
//! recording replayed), and Bob's `claim` dry run and `--submit` against a loopback
//! mock that decodes and re-verifies the intent exactly as a node does.
//! A real proof takes a second or two, so the claim tests build only a few.

mod common;

use std::path::{Path, PathBuf};
use std::process::Command;

use common::http_node::MockNode;
use serde_json::{json, Value};
use swap_cli::client::raw::verify_intent_bytes;
use swap_cli::htlc_harness::seq_bytes;
use swap_cli::secret::{Secret, Variant};
use swap_cli::state::{BobPhase, Event, LockSummary, Phase};
use swap_cli::swapfile::{example_bob_file, example_public, SwapFile, SwapPublic};
use swap_cli::watch::{NoidInstance, RpcError};

const ANCHOR: [u8; 32] = [7; 32];

fn bin() -> Command {
    Command::new(env!("CARGO_BIN_EXE_swap-cli"))
}

fn run(cmd: &mut Command) -> (bool, String, String) {
    let out = cmd.output().expect("run swap-cli");
    (out.status.success(), String::from_utf8_lossy(&out.stdout).into_owned(), String::from_utf8_lossy(&out.stderr).into_owned())
}

fn fixtures() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("fixtures")
}

fn s(p: &Path) -> &str {
    p.to_str().unwrap()
}

// ------------------------------------------------------------------ flag parsing

#[test]
fn source_flags_are_exactly_one_per_chain_and_recording_needs_a_live_source() {
    let dir = tempfile::tempdir().unwrap();
    let b = dir.path().join("b.swap.json");
    example_bob_file(example_public(&Secret::from_bytes(seq_bytes(0x33)), Variant::Raw), 1).unwrap().save(&b).unwrap();
    let noid = fixtures().join("parano1d/idle.json");
    let eth = fixtures().join("eth/locked.json");
    let fail = |args: Vec<&str>, want: &str| {
        let (ok, out, err) = run(bin().args(args));
        assert!(!ok && err.contains(want), "want {want:?}: ok={ok} out={out} err={err}");
    };
    // neither / both
    fail(vec!["tick", s(&b), "--eth-fixture", s(&eth)], "exactly one of --noid-fixture FILE or --noid-rpc URL");
    fail(vec!["tick", s(&b), "--noid-fixture", s(&noid)], "exactly one of --eth-fixture FILE or --eth-rpc URL");
    fail(vec!["tick", s(&b), "--noid-fixture", s(&noid), "--noid-rpc", "http://127.0.0.1:1", "--eth-fixture", s(&eth)], "exactly one of --noid-fixture");
    // recording a fixture makes no sense
    let rec = dir.path().join("rec.json");
    fail(vec!["tick", s(&b), "--noid-fixture", s(&noid), "--eth-fixture", s(&eth), "--record-noid", s(&rec)], "--record-noid needs --noid-rpc");
    fail(vec!["tick", s(&b), "--noid-fixture", s(&noid), "--eth-fixture", s(&eth), "--record-eth", s(&rec)], "--record-eth needs --eth-rpc");
    // transports
    fail(vec!["tick", s(&b), "--noid-fixture", s(&noid), "--eth-fixture", s(&eth), "--transport", "carrier-pigeon"], "expected tcp or curl");
    fail(vec!["tick", s(&b), "--noid-fixture", s(&noid), "--eth-fixture", s(&eth), "--rpc-timeout", "0"], "seconds > 0");
    fail(vec!["tick", s(&b), "--noid-rpc", "https://node.example", "--eth-fixture", s(&eth)], "--transport curl");
    fail(vec!["tick", s(&b), "--noid-rpc", "file:///etc/passwd", "--eth-fixture", s(&eth), "--transport", "curl"], "must start with http");
    // a url with a key in it is never echoed
    let (ok, _, err) = run(bin().args(["tick", s(&b), "--noid-rpc", "http://127.0.0.1:1/KEY123?x=SECRET456", "--eth-fixture", s(&eth)]));
    assert!(!ok && !err.contains("KEY123") && !err.contains("SECRET456"), "{err}");
    // the fixture path still works
    let (ok, out, err) = run(bin().args(["tick", s(&b), "--noid-fixture", s(&noid), "--eth-fixture", s(&eth), "--now", "1794312000"]));
    assert!(ok, "{err}");
    let v: Value = serde_json::from_str(&out).unwrap();
    assert!(v["sources"]["noid"].as_str().unwrap().starts_with("fixture "));
}

#[test]
fn claim_flag_errors() {
    let dir = tempfile::tempdir().unwrap();
    // Alice's file: claim is Bob's.
    let a = dir.path().join("a.swap.json");
    let secret = Secret::generate().unwrap();
    let public = example_public(&secret, Variant::Raw);
    let alice = swap_cli::swapfile::SwapFile::new_alice(public.clone(), &secret, &swap_cli::swapfile::Passphrase::new("correct horse battery staple"), &swap_cli::swapfile::KdfParams::fast_for_tests(), 1).unwrap();
    alice.save(&a).unwrap();
    let eth = fixtures().join("eth/locked.json");
    let (ok, _, err) = run(bin().args(["claim", s(&a), "--noid-rpc", "http://127.0.0.1:1", "--eth-fixture", s(&eth)]));
    assert!(!ok && err.contains("Bob only"), "{err}");
    // Bob: --submit needs a live node, wherever the flag sits on the command line.
    let b = dir.path().join("b.swap.json");
    example_bob_file(public, 1).unwrap().save(&b).unwrap();
    let noid = fixtures().join("parano1d/idle.json");
    let (ok, _, err) = run(bin().args(["claim", "--submit", s(&b), "--noid-fixture", s(&noid), "--eth-fixture", s(&eth)]));
    assert!(!ok && err.contains("--submit needs --noid-rpc"), "{err}");
    // Without a live source and without any source the same one-of rule applies.
    let (ok, _, err) = run(bin().args(["claim", s(&b), "--eth-fixture", s(&eth)]));
    assert!(!ok && err.contains("exactly one of --noid-fixture"), "{err}");
}

// ------------------------------------------------------------------ tick over a loopback node

#[test]
fn tick_over_loopback_http_matches_the_fixture_and_records_a_replayable_copy() {
    let dir = tempfile::tempdir().unwrap();
    let b = dir.path().join("b.swap.json");
    example_bob_file(example_public(&Secret::from_bytes(seq_bytes(0x33)), Variant::Raw), 1).unwrap().save(&b).unwrap();
    let noid_fx = fixtures().join("parano1d/idle.json");
    let eth_fx = fixtures().join("eth/locked.json");
    // The "node" answers from the recorded fixture, through real HTTP.
    let replay = swap_cli::watch::FixtureRpc::from_file(&noid_fx).unwrap();
    let node = MockNode::spawn(move |m, p| swap_cli::watch::JsonRpc::call(&replay, m, p.clone()));
    // `--now` is for fixtures only (REVIEW-2 F12): the live run below is judged by the real clock.
    let base = ["--eth-fixture", s(&eth_fx), "--now", "1794312000"];
    let live_base = ["--eth-fixture", s(&eth_fx)];

    let (ok, from_fixture, err) = run(bin().args(["tick", s(&b), "--noid-fixture", s(&noid_fx)]).args(base));
    assert!(ok, "{err}");
    let rec = dir.path().join("noid.rec.json");
    let (ok, live, err) = run(bin().args(["tick", s(&b), "--noid-rpc", &node.url, "--record-noid", s(&rec)]).args(live_base));
    assert!(ok, "{err}");
    let (f, l): (Value, Value) = (serde_json::from_str(&from_fixture).unwrap(), serde_json::from_str(&live).unwrap());
    // Same observations except the poll stamps (a fixed clock vs the real one).
    let strip = |mut v: Value| {
        v["noid"]["observed_at"] = Value::Null;
        v["eth"]["observed_at"] = Value::Null;
        v
    };
    let (f, l) = (strip(f), strip(l));
    for k in ["noid", "eth", "events", "action", "notes"] {
        assert_eq!(f[k], l[k], "{k}");
    }
    assert!(l["sources"]["noid"].as_str().unwrap().starts_with("tcp http://127.0.0.1:"));
    assert!(node.count("paranoid_blockCount") == 1);
    // Only read-only methods were used.
    assert!(node.methods().iter().all(|m| !m.contains("submit") && !m.contains("wallet")), "{:?}", node.methods());

    // The recording is a fixture that replays to the same decision, and says what it is.
    let text = std::fs::read_to_string(&rec).unwrap();
    let fx: Value = serde_json::from_str(&text).unwrap();
    assert!(fx["description"].as_str().unwrap().starts_with("RECORDED from http://127.0.0.1:"), "{text}");
    assert_eq!(fx["calls"].as_array().unwrap().len(), node.calls.lock().unwrap().len());
    let (ok, again, err) = run(bin().args(["tick", s(&b), "--noid-fixture", s(&rec)]).args(base));
    assert!(ok, "{err}");
    let a: Value = strip(serde_json::from_str(&again).unwrap());
    for k in ["noid", "events", "action"] {
        assert_eq!(a[k], l[k], "{k}");
    }
    // A recording is never overwritten.
    let (ok, _, err) = run(bin().args(["tick", s(&b), "--noid-rpc", &node.url, "--record-noid", s(&rec)]).args(live_base));
    assert!(!ok && err.contains("already exists"), "{err}");

    // A node that errors surfaces as a watcher error naming the method; a dead port as a connect error.
    let dead = {
        let l = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        l.local_addr().unwrap().port()
    };
    let (ok, _, err) = run(bin().args(["tick", s(&b), "--noid-rpc", &format!("http://127.0.0.1:{dead}")]).args(live_base));
    assert!(!ok && err.contains("parano1d watcher: transport: connect"), "{err}");
}

// ------------------------------------------------------------------ REVIEW-2 F5: second node, plain HTTP

#[test]
fn two_noid_rpc_flags_poll_both_nodes_and_attach_the_second_opinion() {
    let dir = tempfile::tempdir().unwrap();
    let b = dir.path().join("b.swap.json");
    example_bob_file(example_public(&Secret::from_bytes(seq_bytes(0x33)), Variant::Raw), 1).unwrap().save(&b).unwrap();
    let noid_fx = fixtures().join("parano1d/idle.json");
    let eth_fx = fixtures().join("eth/locked.json");
    let spawn = || {
        let replay = swap_cli::watch::FixtureRpc::from_file(&noid_fx).unwrap();
        MockNode::spawn(move |m, p| swap_cli::watch::JsonRpc::call(&replay, m, p.clone()))
    };
    let (n1, n2) = (spawn(), spawn());
    let (ok, out, err) = run(bin().args(["tick", s(&b), "--noid-rpc", &n1.url, "--noid-rpc", &n2.url, "--eth-fixture", s(&eth_fx)]));
    assert!(ok, "{err}");
    let v: Value = serde_json::from_str(&out).unwrap();
    assert!(v["sources"]["noid"].as_str().unwrap().starts_with("tcp http://127.0.0.1:"));
    assert!(v["sources"]["noid_second"].as_str().unwrap().starts_with("tcp http://127.0.0.1:"));
    assert!(v["sources"].get("eth_second").is_none());
    // REVIEW-3 G3: two ports on one machine are accepted, with a note that they share a network view.
    assert!(
        v["notes"].as_array().unwrap().iter().any(|n| {
            let n = n.as_str().unwrap_or("");
            n.contains("--noid-rpc: both nodes are on the host localhost") && n.contains("shares its network view") && n.contains(&n1.url) && n.contains(&n2.url)
        }),
        "{}",
        v["notes"]
    );
    // Each node was asked once, and the second opinion sits inside the first node's observation.
    assert_eq!(n1.count("paranoid_blockCount"), 1);
    assert_eq!(n2.count("paranoid_blockCount"), 1);
    assert_eq!(v["noid"]["second"]["tip"], v["noid"]["tip"]);
    assert!(v["noid"]["second"].get("second").is_none(), "{}", v["noid"]["second"]);
    // The second node is read-only too.
    assert!(n2.methods().iter().all(|m| !m.contains("submit") && !m.contains("wallet")), "{:?}", n2.methods());

    // A second node that is down does not fail the tick: the reason is attached for the engine to weigh.
    let dead = {
        let l = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        l.local_addr().unwrap().port()
    };
    let (ok, out, err) = run(bin().args(["tick", s(&b), "--noid-rpc", &n1.url, "--noid-rpc", &format!("http://127.0.0.1:{dead}"), "--eth-fixture", s(&eth_fx)]));
    assert!(ok, "{err}");
    let v: Value = serde_json::from_str(&out).unwrap();
    assert!(v["noid"]["second"].is_null());
    assert!(v["noid"]["second_error"].as_str().unwrap().starts_with("parano1d watcher (second node): transport: connect"), "{v}");

    // REVIEW-3 G3: the same endpoint twice is no second node, whatever the spelling; nothing is sent to it.
    let before = n1.methods().len();
    let spelled = n1.url.replace("127.0.0.1", "LocalHost").replace("http://", "HTTP://") + "/";
    for second in [n1.url.clone(), spelled] {
        let (ok, out, err) = run(bin().args(["tick", s(&b), "--noid-rpc", &n1.url, "--noid-rpc", &second, "--eth-fixture", s(&eth_fx)]));
        assert!(!ok && out.is_empty(), "{out}");
        assert!(err.contains("--noid-rpc: the second node must be a different endpoint (both are http://127.0.0.1:"), "{err}");
    }
    let (ok, _, err) = run(bin().args(["tick", s(&b), "--noid-fixture", s(&noid_fx), "--eth-rpc", "http://127.0.0.1:1/KEY9", "--eth-rpc", "http://127.0.0.1:1/KEY8"]));
    assert!(!ok && err.contains("--eth-rpc: the second node must be a different endpoint (both are http://127.0.0.1:1)") && !err.contains("KEY"), "{err}");
    assert_eq!(n1.methods().len(), before, "a refused second endpoint must not be queried");

    // At most two, and a fixture and a url cannot be mixed.
    let (ok, _, err) = run(bin().args(["tick", s(&b), "--noid-rpc", &n1.url, "--noid-rpc", &n2.url, "--noid-rpc", &n1.url, "--eth-fixture", s(&eth_fx)]));
    assert!(!ok && err.contains("at most two"), "{err}");
    let (ok, _, err) = run(bin().args(["tick", s(&b), "--noid-rpc", &n1.url, "--noid-fixture", s(&noid_fx), "--eth-fixture", s(&eth_fx)]));
    assert!(!ok && err.contains("exactly one of --noid-fixture"), "{err}");
    // Recording follows the first node only; the flag still needs a live node.
    let rec = dir.path().join("first.rec.json");
    let (ok, _, err) = run(bin().args(["tick", s(&b), "--noid-rpc", &n1.url, "--noid-rpc", &n2.url, "--record-noid", s(&rec), "--eth-fixture", s(&eth_fx)]));
    assert!(ok, "{err}");
    assert!(rec.exists());
}

#[test]
fn two_eth_fixtures_attach_a_second_ethereum_opinion_and_the_flags_are_booleans() {
    let dir = tempfile::tempdir().unwrap();
    let b = dir.path().join("b.swap.json");
    example_bob_file(example_public(&Secret::from_bytes(seq_bytes(0x33)), Variant::Raw), 1).unwrap().save(&b).unwrap();
    let noid_fx = fixtures().join("parano1d/idle.json");
    let eth_fx = fixtures().join("eth/locked.json");
    // REVIEW-3 G3: the same fixture file twice is no second node (it would agree with itself); copies are other files.
    let (ok, _, err) = run(bin().args(["tick", s(&b), "--noid-fixture", s(&noid_fx), "--noid-fixture", s(&noid_fx), "--eth-fixture", s(&eth_fx)]));
    assert!(!ok && err.contains("--noid-fixture: the second fixture must be a different file (both are "), "{err}");
    let (ok, _, err) = run(bin().args(["tick", s(&b), "--noid-fixture", s(&noid_fx), "--eth-fixture", s(&eth_fx), "--eth-fixture", s(&eth_fx)]));
    assert!(!ok && err.contains("--eth-fixture: the second fixture must be a different file (both are "), "{err}");
    let (noid_fx2, eth_fx2) = (dir.path().join("noid2.json"), dir.path().join("eth2.json"));
    std::fs::copy(&noid_fx, &noid_fx2).unwrap();
    std::fs::copy(&eth_fx, &eth_fx2).unwrap();
    // `--single-node-ok` and `--allow-plain-http` take no value, so they cannot swallow the next argument.
    let (ok, out, err) = run(bin().args([
        "tick", "--single-node-ok", "--allow-plain-http", s(&b), "--noid-fixture", s(&noid_fx), "--noid-fixture", s(&noid_fx2),
        "--eth-fixture", s(&eth_fx), "--eth-fixture", s(&eth_fx2), "--now", "1794312000",
    ]));
    assert!(ok, "{err}");
    let v: Value = serde_json::from_str(&out).unwrap();
    assert!(v["sources"]["noid_second"].as_str().unwrap().starts_with("fixture "));
    assert!(v["sources"]["eth_second"].as_str().unwrap().starts_with("fixture "));
    assert_eq!(v["eth"]["second"]["latest_block"], v["eth"]["latest_block"]);
    // `--now` pins the second opinions' stamps too, or a replay would call them stale.
    assert_eq!(v["noid"]["second"]["observed_at"], json!(1_794_312_000u64));
    assert_eq!(v["eth"]["second"]["observed_at"], json!(1_794_312_000u64));
    // The flag is recorded on the observations the engine reads.
    assert_eq!(v["noid"]["single_node_ok"], json!(true));
    assert_eq!(v["eth"]["single_node_ok"], json!(true));
}

#[test]
fn plain_http_to_a_host_that_is_not_loopback_is_refused_before_anything_is_sent() {
    let dir = tempfile::tempdir().unwrap();
    let b = dir.path().join("b.swap.json");
    example_bob_file(example_public(&Secret::from_bytes(seq_bytes(0x33)), Variant::Raw), 1).unwrap().save(&b).unwrap();
    let eth_fx = fixtures().join("eth/locked.json");
    let fail = |args: &[&str]| {
        let (ok, out, err) = run(bin().args(["tick", s(&b), "--eth-fixture", s(&eth_fx)]).args(args));
        assert!(!ok, "{args:?}: {out}");
        assert!(err.contains("plain HTTP to a non-loopback host can be tampered with in transit"), "{args:?}: {err}");
        assert!(err.contains("use https:// with --transport curl, or --allow-plain-http"), "{err}");
        // The key in the url is never echoed.
        assert!(!err.contains("KEY123") && !err.contains("SECRET456"), "{err}");
        err
    };
    // The built-in client and curl are held to the same rule; the second node and the Ethereum side too.
    let err = fail(&["--noid-rpc", "http://10.0.0.5:9601/KEY123?x=SECRET456"]);
    assert!(err.contains("http://10.0.0.5:9601"), "{err}");
    fail(&["--noid-rpc", "http://example.org:9601/KEY123", "--transport", "curl"]);
    fail(&["--noid-rpc", "http://127.0.0.1:1", "--noid-rpc", "http://192.168.1.9:9601/KEY123"]);
    // Userinfo cannot dress a foreign host up as loopback.
    fail(&["--noid-rpc", "http://127.0.0.1@example.org:9601/KEY123"]);
    let (ok, _, err) = run(bin().args(["tick", s(&b), "--noid-fixture", s(&fixtures().join("parano1d/idle.json")), "--eth-rpc", "http://10.0.0.5:8545/KEY123"]));
    assert!(!ok && err.contains("plain HTTP to a non-loopback host") && !err.contains("KEY123"), "{err}");
    // https:// is not caught by this rule (with the built-in client it is still unsupported, as before).
    let (ok, _, err) = run(bin().args(["tick", s(&b), "--noid-rpc", "https://node.example", "--eth-fixture", s(&eth_fx)]));
    assert!(!ok && err.contains("--transport curl") && !err.contains("plain HTTP"), "{err}");
}

#[test]
fn loopback_http_and_allow_plain_http_are_accepted() {
    let dir = tempfile::tempdir().unwrap();
    let b = dir.path().join("b.swap.json");
    example_bob_file(example_public(&Secret::from_bytes(seq_bytes(0x33)), Variant::Raw), 1).unwrap().save(&b).unwrap();
    let noid_fx = fixtures().join("parano1d/idle.json");
    let eth_fx = fixtures().join("eth/locked.json");
    let replay = swap_cli::watch::FixtureRpc::from_file(&noid_fx).unwrap();
    let node = MockNode::spawn(move |m, p| swap_cli::watch::JsonRpc::call(&replay, m, p.clone()));
    // Loopback needs no flag, with either transport's rule ("localhost" and a port included).
    let (ok, _, err) = run(bin().args(["tick", s(&b), "--noid-rpc", &node.url, "--eth-fixture", s(&eth_fx)]));
    assert!(ok, "{err}");
    let by_name = node.url.replace("127.0.0.1", "localhost");
    let (ok, _, err) = run(bin().args(["tick", s(&b), "--noid-rpc", &by_name, "--eth-fixture", s(&eth_fx)]));
    assert!(ok || !err.contains("plain HTTP"), "{err}");
    // `--allow-plain-http` is accepted on a loopback node too (the non-loopback acceptance is a unit test in main.rs:
    // proving it here would need a connection to a foreign host).
    let (ok, _, err) = run(bin().args(["tick", s(&b), "--allow-plain-http", "--noid-rpc", &node.url, "--eth-fixture", s(&eth_fx)]));
    assert!(ok, "{err}");
}

// ------------------------------------------------------------------ claim over a loopback node

struct ClaimWorld {
    public: SwapPublic,
    inst: NoidInstance,
    tip: u64,
    dir: tempfile::TempDir,
    bob: PathBuf,
    eth: PathBuf,
}

/// Bob has seen the secret on Ethereum (phase `SecretSeen`) and the NOID instance is funded and final.
fn claim_world() -> ClaimWorld {
    let secret = Secret::generate().unwrap();
    let public = example_public(&secret, Variant::Raw);
    let inst = NoidInstance { slot_index: 11, creation_id: 3, amount_micronoid: public.params.amount_micronoid };
    let dir = tempfile::tempdir().unwrap();
    let mut file = example_bob_file(public.clone(), 1).unwrap();
    let lock = LockSummary {
        lock_id: [1; 32],
        t_reveal: 2_000_000,
        amount_wei: public.params.eth.amount_wei,
        block_number: 5,
        sender: public.params.eth.bob_sender,
        receiver: public.params.eth.alice_receiver,
    };
    for e in [
        Event::NoidInstanceSeen { instance: inst.clone(), tip: 300_005 },
        Event::NoidFundingFinal { tip: 300_022 },
        Event::LockSubmitted { t_reveal: 2_000_000, amount_wei: public.params.eth.amount_wei, tx_hash: None, at: 1 },
        Event::EthLockSeen { lock },
        Event::EthPreimageSeen { preimage: *secret.bytes(), tip: 300_100, time: 1_000 },
    ] {
        file.apply(&e, 1).unwrap();
    }
    let bob = dir.path().join("bob.swap.json");
    file.save(&bob).unwrap();
    let eth = dir.path().join("eth.json");
    std::fs::write(
        &eth,
        json!({"description": "minimal Ethereum answers for a SecretSeen swap", "calls": [
            {"method": "eth_blockNumber", "result": "0xa"},
            {"method": "eth_getBlockByNumber", "result": {"number": "0xa", "timestamp": "0x3e8"}},
            {"method": "eth_getBlockByNumber", "result": {"number": "0x8", "timestamp": "0x3d0"}},
            {"method": "eth_chainId", "result": "0xaa36a7"},
            {"method": "eth_getCode", "result": "0x6001"},
            {"method": "eth_getLogs", "result": []},
            {"method": "eth_call", "error": {"code": 3, "message": "execution reverted: LockNotFound"}}
        ]})
        .to_string(),
    )
    .unwrap();
    let tip = public.params.deadline_height - 19; // next call height D - 18: on target, away from an epoch boundary
    ClaimWorld { public, inst, tip, dir, bob, eth }
}

/// The Parano1d node of that world. `reject`: answer every submission with that error;
/// otherwise verify the intent like a node would and keep the accepted claim in its mempool.
fn claim_node(w: &ClaimWorld, reject: Option<&'static str>) -> MockNode {
    let (public, inst, tip) = (w.public.clone(), w.inst.clone(), w.tip);
    let mempool: std::sync::Mutex<Option<String>> = std::sync::Mutex::new(None);
    MockNode::spawn(move |m, p| match m {
        "paranoid_blockCount" => Ok(json!(tip)),
        "paranoid_getEpochAnchor" => Ok(json!(hex::encode(ANCHOR))),
        "paranoid_estimateFeeDetailed" => Ok(json!({"fee_micronoid": 6000})),
        "paranoid_getMempoolStats" => Ok(json!({"fee_floor": 5800})),
        // REVIEW-3 F5: an unknown header time blocks the claim, so this node's tip is as young as the clock.
        "paranoid_getBlockHeader" => {
            let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_secs();
            Ok(json!({"height": tip, "timestamp": now}))
        }
        "paranoid_getObjectInstances" => {
            assert_eq!(p[0], json!(public.opening_hex), "the watcher must ask about OUR opening");
            Ok(json!({"slots": [{"slot_index": inst.slot_index, "value": inst.amount_micronoid, "creation_id": inst.creation_id, "owner": "", "empty": false}]}))
        }
        "paranoid_getObjectStatus" => Ok(json!({"matches_opening": true, "active_authority": public.claim_authority})),
        "paranoid_getMempoolInfo" => {
            let txs: Vec<Value> = mempool.lock().unwrap().iter().map(|t| json!({"tx_hash": t, "page_count": 1})).collect();
            Ok(json!({"txs": txs}))
        }
        "paranoid_getMempoolEntry" => Ok(match mempool.lock().unwrap().as_deref() {
            Some(t) if p[0] == json!(t) => {
                json!({"tx_hash": t, "fee_micronoid": 6000, "admitted_height": tip, "contract_opening_hex": public.opening_hex})
            }
            _ => Value::Null,
        }),
        "paranoid_getTx" => Ok(Value::Null),
        "paranoid_getSlotHints" => Ok(json!([2])),
        "paranoid_submitTxIntent" => match reject {
            Some(msg) => Err(RpcError::Remote { code: -32000, message: msg.into() }),
            None => {
                let bytes = hex::decode(p[0].as_str().unwrap()).unwrap();
                let (_, txid) = verify_intent_bytes(&bytes, tip + 1).map_err(|e| RpcError::Remote { code: -32000, message: e.to_string() })?;
                let txid = hex::encode(txid);
                *mempool.lock().unwrap() = Some(txid.clone());
                Ok(json!(txid))
            }
        },
        other => Err(RpcError::Remote { code: -32601, message: format!("Method not found: {other}") }),
    })
}

fn claim_cmd(w: &ClaimWorld, url: &str, extra: &[&str]) -> (bool, String, String) {
    run(bin().args(["claim", s(&w.bob), "--noid-rpc", url, "--eth-fixture", s(&w.eth)]).args(extra))
}

#[test]
fn claim_dry_run_builds_proves_and_verifies_but_sends_and_saves_nothing() {
    let w = claim_world();
    let node = claim_node(&w, None);
    let before = std::fs::read(&w.bob).unwrap();
    let intent_out = w.dir.path().join("intent.hex");
    let (ok, out, err) = claim_cmd(&w, &node.url, &["--intent-out", s(&intent_out)]);
    assert!(ok, "{err}");
    let v: Value = serde_json::from_str(&out).unwrap();
    assert_eq!(v["mode"], "dry_run");
    assert_eq!(v["submitted"], false);
    assert_eq!(v["plan"]["self_verified"], true);
    assert_eq!(v["plan"]["call_height"], w.tip + 1);
    assert_eq!(v["plan"]["recipient"], w.public.params.bob_noid);
    assert_eq!(v["plan"]["amount_out_micronoid"], w.inst.amount_micronoid - 6000);
    assert_eq!(v["plan"]["txid"].as_str().unwrap().len(), 64);
    assert_eq!(v["plan"]["height_class"], "OnTarget");
    // The saved intent is the node-verifiable bytes behind that txid.
    let bytes = hex::decode(std::fs::read_to_string(&intent_out).unwrap()).unwrap();
    assert_eq!(v["plan"]["intent_bytes"], bytes.len());
    let (_, txid) = verify_intent_bytes(&bytes, w.tip + 1).unwrap();
    assert_eq!(hex::encode(txid), v["plan"]["txid"].as_str().unwrap());
    // Nothing was submitted, and the swap file is byte-for-byte unchanged.
    assert_eq!(node.count("paranoid_submitTxIntent"), 0);
    assert_eq!(std::fs::read(&w.bob).unwrap(), before);
}

#[test]
fn claim_submit_goes_through_the_runner_and_persists() {
    let w = claim_world();
    let node = claim_node(&w, None);
    let (ok, dry, err) = claim_cmd(&w, &node.url, &[]);
    assert!(ok, "{err}");
    let dry_txid = serde_json::from_str::<Value>(&dry).unwrap()["plan"]["txid"].as_str().unwrap().to_string();

    // A second node that nobody listens on: the claim is accepted by the first, the second is reported as unreachable.
    let dead = {
        let l = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        l.local_addr().unwrap().port()
    };
    let dead_url = format!("http://127.0.0.1:{dead}");
    let (ok, out, err) = claim_cmd(&w, &node.url, &["--submit", "--submit-rpc", &dead_url]);
    assert!(ok, "{err}\n{out}");
    assert!(err.contains("SUBMITTING"), "{err}");
    let v: Value = serde_json::from_str(&out).unwrap();
    assert_eq!(v["mode"], "submit");
    assert_eq!(v["submitted"], true);
    assert_eq!(v["exec_error"], Value::Null);
    assert_eq!(v["plan"]["txid"], json!(dry_txid), "the txid does not depend on the proof, so dry run and submit agree");
    assert_eq!(v["nodes"]["accepted"].as_array().unwrap().len(), 1);
    let rejected = v["nodes"]["rejected"].as_array().unwrap();
    assert_eq!(rejected.len(), 1);
    assert!(rejected[0][1].as_str().unwrap().contains("transport: connect"), "{rejected:?}");
    assert_eq!(node.count("paranoid_submitTxIntent"), 1);
    // Persisted: the phase tracks the txid, no pending action is left.
    let file = SwapFile::load(&w.bob).unwrap();
    match &file.phase {
        Phase::Bob(BobPhase::ClaimSubmitted { txid, call_height, .. }) => {
            assert_eq!(txid, &dry_txid);
            assert_eq!(*call_height, w.tip + 1);
        }
        other => panic!("{other:?}"),
    }
    assert!(file.pending_action.is_none());
    // A second run is not a claim any more: the engine waits for the tracked transaction.
    let (ok, out, err) = claim_cmd(&w, &node.url, &["--submit"]);
    assert!(ok, "{err}");
    let v: Value = serde_json::from_str(&out).unwrap();
    assert_eq!(v["submitted"], false);
    assert_eq!(v["action"]["action"], "wait");
    assert_eq!(node.count("paranoid_submitTxIntent"), 1);
}

#[test]
fn claim_submit_rejected_by_the_node_is_a_failure_that_may_be_retried() {
    let w = claim_world();
    let node = claim_node(&w, Some("SlotConflict"));
    let (ok, out, err) = claim_cmd(&w, &node.url, &["--submit"]);
    assert!(!ok && err.contains("claim not submitted") && err.contains("SlotConflict"), "{err}");
    let v: Value = serde_json::from_str(&out).unwrap();
    assert_eq!(v["submitted"], false);
    // Every node answered with a rejection: nothing is pending anywhere, so the record says "not sent".
    let file = SwapFile::load(&w.bob).unwrap();
    assert!(matches!(file.phase, Phase::Bob(BobPhase::SecretSeen { .. })), "{:?}", file.phase);
    let pending = file.pending_action.expect("the attempt is recorded");
    assert_eq!(pending.kind, "claim_noid");
    assert!(!pending.maybe_sent);
}

/// Not a test: writes the Bob swap file that `fixtures/parano1d/idle.json` was recorded for
/// (`example_public(seq_bytes(0x33), Raw)`), so a live `tick --record-noid` can be repeated:
/// `EXAMPLE_BOB_OUT=/path/bob.swap.json cargo test --test cli_live -- --ignored write_example_bob_file`
#[test]
#[ignore]
fn write_example_bob_file() {
    let out = std::env::var("EXAMPLE_BOB_OUT").expect("set EXAMPLE_BOB_OUT");
    example_bob_file(example_public(&Secret::from_bytes(seq_bytes(0x33)), Variant::Raw), 1).unwrap().save(Path::new(&out)).unwrap();
}

#[test]
fn now_is_refused_together_with_a_live_rpc() {
    // REVIEW-2 F12: `--now` rewrites both `observed_at` stamps, which would switch the staleness rule off.
    let dir = tempfile::tempdir().unwrap();
    let b = dir.path().join("b.swap.json");
    example_bob_file(example_public(&Secret::from_bytes(seq_bytes(0x33)), Variant::Raw), 1).unwrap().save(&b).unwrap();
    let noid = fixtures().join("parano1d/idle.json");
    let eth = fixtures().join("eth/locked.json");
    for args in [
        vec!["tick", s(&b), "--noid-rpc", "http://127.0.0.1:1", "--eth-fixture", s(&eth), "--now", "1794312000"],
        vec!["tick", s(&b), "--noid-fixture", s(&noid), "--eth-rpc", "http://127.0.0.1:1", "--now", "1794312000"],
        vec!["claim", s(&b), "--noid-rpc", "http://127.0.0.1:1", "--eth-fixture", s(&eth), "--now", "1794312000"],
    ] {
        let (ok, _, err) = run(bin().args(&args));
        assert!(!ok && err.contains("--now is for recorded fixtures only"), "{args:?}: {err}");
    }
    // Fixtures on both sides: still allowed.
    let (ok, _, err) = run(bin().args(["tick", s(&b), "--noid-fixture", s(&noid), "--eth-fixture", s(&eth), "--now", "1794312000"]));
    assert!(ok, "{err}");
}

// ------------------------------------------------------------------ tick --closed-by (M2.5d)

/// A Parano1d node whose instance is `live` or gone, with at most one transaction `confirmed` at a height or `pending` in the mempool.
fn closed_node(w: &ClaimWorld, live: bool, confirmed: Option<(&str, u64)>, pending: Option<&str>) -> MockNode {
    let (public, inst, tip) = (w.public.clone(), w.inst.clone(), w.tip);
    let confirmed = confirmed.map(|(t, h)| (t.to_string(), h));
    let pending = pending.map(str::to_string);
    MockNode::spawn(move |m, p| match m {
        "paranoid_blockCount" => Ok(json!(tip)),
        "paranoid_getEpochAnchor" => Ok(json!(hex::encode(ANCHOR))),
        "paranoid_estimateFeeDetailed" => Ok(json!({"fee_micronoid": 6000})),
        "paranoid_getMempoolStats" => Ok(json!({"fee_floor": 5800})),
        "paranoid_getObjectInstances" if live => Ok(json!({"slots": [{"slot_index": inst.slot_index, "value": inst.amount_micronoid, "creation_id": inst.creation_id, "owner": "", "empty": false}]})),
        "paranoid_getObjectInstances" => Ok(json!({"slots": []})),
        "paranoid_getObjectStatus" => Ok(json!({"matches_opening": true, "active_authority": public.claim_authority})),
        "paranoid_getMempoolInfo" => Ok(json!({"txs": pending.iter().map(|t| json!({"tx_hash": t, "page_count": 1})).collect::<Vec<_>>()})),
        "paranoid_getMempoolEntry" => Ok(match &pending {
            Some(t) if p[0] == json!(t) => json!({"tx_hash": t, "fee_micronoid": 6000, "admitted_height": tip, "contract_opening_hex": public.opening_hex}),
            _ => Value::Null,
        }),
        "paranoid_getTx" => Ok(match &confirmed {
            Some((t, h)) if p[0] == json!(t) => json!({"tx_hash": t, "height": h, "block_hash": "00".repeat(32), "tx_position": 1}),
            _ => Value::Null,
        }),
        other => Err(RpcError::Remote { code: -32601, message: format!("Method not found: {other}") }),
    })
}

fn closed_by_cmd(w: &ClaimWorld, url: &str, txid: &str, extra: &[&str]) -> (bool, String, String) {
    run(bin().args(["tick", s(&w.bob), "--noid-rpc", url, "--eth-fixture", s(&w.eth), "--closed-by", txid]).args(extra))
}

#[test]
fn tick_closed_by_records_an_outside_claim_only_with_apply_and_refuses_everything_doubtful() {
    let w = claim_world();
    let txid = "ab".repeat(32);
    let h_closed = w.tip - 20; // far below D, and 20 blocks deep: final on the same tick
    let before = std::fs::read(&w.bob).unwrap();
    let unchanged = |what: &str| assert_eq!(std::fs::read(&w.bob).unwrap(), before, "{what}: the swap file must not change");

    // Refusals. Each prints a plain message, exits non-zero and leaves the file alone, with and without --apply.
    let refuse = |node: &MockNode, txid: &str, want: &str, what: &str| {
        for extra in [&[] as &[&str], &["--apply"]] {
            let (ok, out, err) = closed_by_cmd(&w, &node.url, txid, extra);
            assert!(!ok && err.contains(want), "{what} {extra:?}: want {want:?}: ok={ok} out={out} err={err}");
            unchanged(what);
        }
    };
    // An unknown txid (getTx -> null, not in the mempool), though the instance is gone.
    refuse(&closed_node(&w, false, None, None), &txid, "not found on this node", "unknown txid");
    // A txid that is only pending.
    refuse(&closed_node(&w, false, None, Some(&txid)), &txid, "only in the mempool", "pending txid");
    // The instance is still live: the close is not on this node's chain.
    refuse(&closed_node(&w, true, Some((&txid, h_closed)), None), &txid, "still visible", "live instance");
    // Not a txid at all.
    refuse(&closed_node(&w, false, None, None), "not-a-txid", "64-hex-character", "bad txid");
    // Confirmed at or after D: that was the recovery branch (it paid Alice), not Bob's claim.
    let d = w.public.params.deadline_height;
    refuse(&closed_node(&w, false, Some((&txid, d)), None), &txid, "pays Alice", "after D");

    // The good node: confirmed 20 blocks ago, the instance gone.
    let node = closed_node(&w, false, Some((&txid, h_closed)), None);
    // Without --apply: say what would be recorded, write nothing.
    let (ok, out, err) = closed_by_cmd(&w, &node.url, &txid, &[]);
    assert!(ok, "{err}");
    unchanged("dry run");
    let v: Value = serde_json::from_str(&out).unwrap();
    assert_eq!(v["events_applied_to_file"], false);
    assert_eq!(v["closed_by"]["recorded"], false);
    assert_eq!(v["closed_by"]["txid"], txid);
    assert_eq!(v["closed_by"]["height"], h_closed);
    assert_eq!(v["closed_by"]["branch"], "claim");
    assert_eq!(v["closed_by"]["payout_read_from_chain"], false);
    assert_eq!(v["events"][0]["event"], "noid_closed_externally");
    assert_eq!(v["events"][1]["event"], "noid_tx_final");
    assert!(v["notes"][0].as_str().unwrap().contains("WOULD RECORD"), "{}", v["notes"][0]);
    // It asked the node only read-only questions, and about this txid.
    assert!(node.methods().iter().all(|m| !m.contains("submit") && !m.contains("wallet")), "{:?}", node.methods());
    assert!(node.calls.lock().unwrap().iter().any(|(m, p)| m == "paranoid_getTx" && p[0] == json!(txid)));

    // With --apply: recorded, then followed to final by the same tick.
    let (ok, out, err) = closed_by_cmd(&w, &node.url, &txid, &["--apply"]);
    assert!(ok, "{err}");
    let v: Value = serde_json::from_str(&out).unwrap();
    assert_eq!(v["closed_by"]["recorded"], true);
    assert_eq!(v["phase_after"], "done");
    assert!(v["notes"][0].as_str().unwrap().starts_with("RECORDED"), "{}", v["notes"][0]);
    let file = SwapFile::load(&w.bob).unwrap();
    assert!(matches!(&file.phase, Phase::Bob(BobPhase::Done { txid: t, height, .. }) if *t == txid && *height == h_closed), "{:?}", file.phase);
    let history: Vec<_> = file.history.iter().map(|h| h.event.as_str()).collect();
    assert!(history.ends_with(&["noid_closed_externally", "noid_tx_final"]), "{history:?}");

    // A finished swap has nothing to record.
    let after = std::fs::read(&w.bob).unwrap();
    let (ok, _, err) = closed_by_cmd(&w, &node.url, &txid, &["--apply"]);
    assert!(!ok && err.contains("terminal"), "{err}");
    assert_eq!(std::fs::read(&w.bob).unwrap(), after);
}

#[test]
fn tick_closed_by_is_refused_before_any_node_is_asked_when_the_phase_makes_no_sense() {
    let dir = tempfile::tempdir().unwrap();
    let secret = Secret::generate().unwrap();
    let alice_path = dir.path().join("a.swap.json");
    let alice = SwapFile::new_alice(
        example_public(&secret, Variant::Raw),
        &secret,
        &swap_cli::swapfile::Passphrase::new("correct horse battery staple"),
        &swap_cli::swapfile::KdfParams::fast_for_tests(),
        1,
    )
    .unwrap();
    alice.save(&alice_path).unwrap();
    let before = std::fs::read(&alice_path).unwrap();
    let eth = fixtures().join("eth/locked.json");
    // A dead port: if the node were asked, the error would be a connect error, not the phase message.
    let dead = {
        let l = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        l.local_addr().unwrap().port()
    };
    let (ok, _, err) = run(bin().args(["tick", s(&alice_path), "--noid-rpc", &format!("http://127.0.0.1:{dead}"), "--eth-fixture", s(&eth), "--closed-by", &"cd".repeat(32), "--apply"]));
    assert!(!ok && err.contains("never seen funded") && !err.contains("connect"), "{err}");
    assert_eq!(std::fs::read(&alice_path).unwrap(), before);
}

// ------------------------------------------------------------------ REVIEW-3 F7: --eth-from-block is stored in the file

/// A minimal Ethereum node: an empty chain with the HTLC "deployed" (a code blob) and no logs.
fn empty_eth_node(chain_id: u64) -> MockNode {
    MockNode::spawn(move |m, _| match m {
        "eth_blockNumber" => Ok(json!("0x10")),
        "eth_getBlockByNumber" => Ok(json!({"number": "0x10", "timestamp": "0x6a000000"})),
        "eth_chainId" => Ok(json!(format!("0x{chain_id:x}"))),
        "eth_getCode" => Ok(json!("0x6000")),
        "eth_getLogs" => Ok(json!([])),
        "eth_getTransactionCount" => Ok(json!("0x1")),
        other => Err(RpcError::Fixture(format!("unexpected {other}"))),
    })
}

/// The `fromBlock` of every `eth_getLogs` the node was asked.
fn from_blocks(node: &MockNode) -> Vec<String> {
    node.calls
        .lock()
        .unwrap()
        .iter()
        .filter(|(m, _)| m == "eth_getLogs")
        .map(|(_, p)| p[0]["fromBlock"].as_str().unwrap().to_string())
        .collect()
}

fn bob_file_on(profile: swap_cli::params::ProfileName, path: &Path) {
    let public = swap_cli::swapfile::example_public_with(&Secret::from_bytes(seq_bytes(0x33)), Variant::Raw, profile);
    example_bob_file(public, 1).unwrap().save(path).unwrap();
}

#[test]
fn f7_eth_from_block_is_stored_by_apply_reused_without_the_flag_and_required_on_a_public_chain() {
    let dir = tempfile::tempdir().unwrap();
    let b = dir.path().join("b.swap.json");
    bob_file_on(swap_cli::params::ProfileName::Production, &b); // chain id 11155111
    let noid = fixtures().join("parano1d/idle.json");
    let node = empty_eth_node(11_155_111);
    let tick = |extra: &[&str]| run(bin().args(["tick", s(&b), "--noid-fixture", s(&noid), "--eth-rpc", &node.url]).args(extra));
    let stored = || SwapFile::load(&b).unwrap();

    // Neither the flag nor a stored value on a public chain: refused, nothing asked of the Ethereum node, nothing written.
    let (ok, _, err) = tick(&[]);
    assert!(!ok && err.contains("give --eth-from-block N once") && err.contains("stored in the swap file on the next tick --apply"), "{err}");
    assert!(from_blocks(&node).is_empty() && stored().eth_from_block.is_none());

    // A read-only tick uses the flag and stores nothing.
    let (ok, out, err) = tick(&["--eth-from-block", "5_000_000"]);
    assert!(ok, "{err}");
    assert_eq!(serde_json::from_str::<Value>(&out).unwrap()["sources"]["eth_from_block"], 5_000_000);
    assert_eq!(from_blocks(&node), vec!["0x4c4b40"]);
    assert!(stored().eth_from_block.is_none());

    // --apply stores it and logs the change.
    let (ok, _, err) = tick(&["--eth-from-block", "5000000", "--apply"]);
    assert!(ok, "{err}");
    let f = stored();
    assert_eq!(f.eth_from_block, Some(5_000_000));
    assert_eq!(f.history.iter().filter(|h| h.event == "eth_from_block_set:5000000").count(), 1);

    // Without the flag the stored value is used (and printed); the same value again adds no history entry.
    let (ok, out, err) = tick(&[]);
    assert!(ok, "{err}");
    assert_eq!(serde_json::from_str::<Value>(&out).unwrap()["sources"]["eth_from_block"], 5_000_000);
    assert_eq!(from_blocks(&node).last().unwrap(), "0x4c4b40");
    let (ok, _, err) = tick(&["--eth-from-block", "5000000", "--apply"]);
    assert!(ok, "{err}");
    assert_eq!(stored().history.iter().filter(|h| h.event.starts_with("eth_from_block_set")).count(), 1);

    // A different flag wins, and --apply replaces the stored value (second history entry).
    let (ok, out, err) = tick(&["--eth-from-block", "4000000", "--apply"]);
    assert!(ok, "{err}");
    assert_eq!(serde_json::from_str::<Value>(&out).unwrap()["sources"]["eth_from_block"], 4_000_000);
    let f = stored();
    assert_eq!(f.eth_from_block, Some(4_000_000));
    assert!(f.history.iter().any(|h| h.event == "eth_from_block_set:4000000"));
}

#[test]
fn r6_3_reveal_tx_flag_is_one_hash_and_without_a_visible_lock_it_is_only_a_note() {
    let dir = tempfile::tempdir().unwrap();
    let b = dir.path().join("b.swap.json");
    let mut public = example_public(&Secret::from_bytes(seq_bytes(0x33)), Variant::Raw);
    public.params.eth.chain_id = 31_337;
    example_bob_file(public, 1).unwrap().save(&b).unwrap();
    let noid = fixtures().join("parano1d/idle.json");
    let node = empty_eth_node(31_337);
    let tick = |extra: &[&str]| run(bin().args(["tick", s(&b), "--noid-fixture", s(&noid), "--eth-rpc", &node.url]).args(extra));
    let h = format!("0x{}", "ab".repeat(32));
    let (ok, _, err) = tick(&["--reveal-tx", "0x1234"]);
    assert!(!ok && err.contains("--reveal-tx"), "{err}");
    let (ok, _, err) = tick(&["--reveal-tx", &h, "--reveal-tx", &h]);
    assert!(!ok && err.contains("exactly one transaction hash"), "{err}");
    // A well-formed hash and no lock of ours on the node: the tick goes on, says why nothing was checked, and asks the node nothing about it.
    let (ok, out, err) = tick(&["--reveal-tx", &h]);
    assert!(ok, "{err}");
    let v: Value = serde_json::from_str(&out).unwrap();
    assert!(v["eth"]["reveal_tx_note"].as_str().unwrap().contains("no lock of ours is visible"), "{out}");
    assert!(v["notes"].as_array().unwrap().iter().any(|n| n.as_str().unwrap().contains("--reveal-tx")), "{out}");
    assert_eq!(node.count("eth_getTransactionReceipt"), 0);
    assert!(v["eth"]["reverted_claim"].is_null() || v["eth"].get("reverted_claim").is_none());
}

#[test]
fn f7_eth_from_block_defaults_to_zero_only_on_a_local_chain() {
    let dir = tempfile::tempdir().unwrap();
    let b = dir.path().join("b.swap.json");
    // The production example (the opening the idle fixture knows) re-pointed at a local chain; production allows any chain id.
    let mut public = example_public(&Secret::from_bytes(seq_bytes(0x33)), Variant::Raw);
    public.params.eth.chain_id = 31_337;
    example_bob_file(public, 1).unwrap().save(&b).unwrap();
    let noid = fixtures().join("parano1d/idle.json");
    let node = empty_eth_node(31_337);
    let (ok, out, err) = run(bin().args(["tick", s(&b), "--noid-fixture", s(&noid), "--eth-rpc", &node.url]));
    assert!(ok, "{err}");
    assert_eq!(serde_json::from_str::<Value>(&out).unwrap()["sources"]["eth_from_block"], 0);
    assert_eq!(from_blocks(&node), vec!["0x0"]);
    assert!(SwapFile::load(&b).unwrap().eth_from_block.is_none(), "a default is never stored");
}
