//! The `swap-cli` binary, offline: gates, new-alice (secret sealed), new-bob
//! (bundle check), status, and a fixture-driven `tick` on the swap the
//! Parano1d fixtures were synthesized for.

use std::process::Command;

#[path = "common/bundle_text.rs"]
mod bundle_text;
#[path = "common/equiv_stub.rs"]
mod equiv_stub;
#[path = "common/home.rs"]
mod home;

use swap_cli::secret::{Secret, Variant};
use swap_cli::swapfile::{example_public, SwapFile};

/// `keccak256` of the HTLC runtime code compiled into the tool (`params::HTLC_CODE_HASH`, REVIEW-3 F1), as `--eth-code-hash` takes it.
const CODE_HASH: &str = "0xa906117fc4e604bd25fcee2a6a41da8b824ec9b4a17d10137704e7da42545e2f";
/// A well-formed hash that is not the compiled-in one.
const OTHER_CODE_HASH: &str = "0x2222222222222222222222222222222222222222222222222222222222222222";

fn bin() -> Command {
    home::isolated_bin()
}

fn run(cmd: &mut Command) -> (bool, String, String) {
    let out = cmd.output().expect("run swap-cli");
    (out.status.success(), String::from_utf8_lossy(&out.stdout).into_owned(), String::from_utf8_lossy(&out.stderr).into_owned())
}

#[test]
fn gates_reproduce_the_section_4_3_example() {
    let (ok, out, _) = run(bin().args(["gates", "--d", "300738", "--h-now", "300040", "--t-now", "1794312000", "--h-final", "300022"]));
    assert!(ok);
    let v: serde_json::Value = serde_json::from_str(&out).unwrap();
    assert_eq!(v["lock_by_full_window"], 300_107);
    assert_eq!(v["lock_by_min_window"], 300_197);
    assert_eq!(v["rhs_i1_full_window"], 631);
    assert_eq!(v["t_reveal"], "1794319200");
    assert_eq!(v["reveal_cutoff"], 1_794_317_400);
    assert_eq!(v["claim_target_height"], 300_719);
}

#[test]
fn alice_and_bob_files_through_the_binary() {
    let dir = tempfile::tempdir().unwrap();
    let a = dir.path().join("a.swap.json");
    let cast = swap_cli::htlc_harness::Cast::new();
    let common = [
        "--alice", &cast.alice.to_bech32(), "--bob", &cast.bob.to_bech32(), "--amount", "10000000", "--fee-estimate", "5800",
        "--h-create", "300000", "--eth-contract", "0x5fbdb2315678afecb367f032d93f642f64180aa3", "--eth-chain-id", "31337",
        "--eth-amount-wei", "10000000000000000", "--eth-receiver", "0x3c44cdddb6a900fa2b585dd299e03d12fa4293bc",
        "--eth-sender", "0x70997970c51812dc3a010c7d01b50e0d17dc79c8", "--eth-code-hash", CODE_HASH, "--fast-kdf",
    ];
    // No passphrase in the environment: refused before anything is written.
    let (ok, _, err) = run(bin().args(["new-alice", "--out", a.to_str().unwrap()]).args(common).env_remove("SWAP_PASSPHRASE"));
    assert!(!ok && err.contains("SWAP_PASSPHRASE"));
    assert!(!a.exists());
    // With one: the file is written and the bundle printed.
    let (ok, bundle, err) = run(bin().args(["new-alice", "--out", a.to_str().unwrap()]).args(common).env("SWAP_PASSPHRASE", "correct horse battery staple"));
    assert!(ok, "{err}");
    let public: swap_cli::swapfile::SwapPublic = serde_json::from_str(&bundle).unwrap();
    assert_eq!(public.params.deadline_height, 300_738);
    let file = SwapFile::load(&a).unwrap();
    assert!(file.secret.is_some());
    assert_eq!(file.decrypt_secret(&swap_cli::swapfile::Passphrase::new("correct horse battery staple")).unwrap().hashlock(), public.hashlock);
    assert!(dir.path().join("hashlocks.txt").exists());
    // The same hashlock cannot be registered twice; a second file is refused by the registry.
    let (ok, _, err) = run(bin().args(["new-alice", "--out", a.to_str().unwrap()]).args(common).env("SWAP_PASSPHRASE", "correct horse battery staple"));
    assert!(!ok && err.contains("already exists"));
    // Bob checks the bundle against HIS terms and the proof he verified, then writes his file.
    let bundle_path = dir.path().join("bundle.json");
    std::fs::write(&bundle_path, &bundle).unwrap();
    let bob_dir = tempfile::tempdir().unwrap();
    // REVIEW-3 F2: production is not a rehearsal, so the receipt goes through a stand-in `equiv-prove` (the typed form is refused).
    let stub = equiv_stub::receipt_flags(bob_dir.path());
    let bob_args = |out: &std::path::Path| {
        let mut args = vec![
            "new-bob".to_string(), "--bundle".into(), bundle_path.to_str().unwrap().into(), "--out".into(), out.to_str().unwrap().into(),
            "--bob".into(), cast.bob.to_bech32(), "--amount".into(), "10000000".into(), "--eth-chain-id".into(), "31337".into(),
            "--eth-contract".into(), "0x5fbdb2315678afecb367f032d93f642f64180aa3".into(), "--eth-amount-wei".into(), "10000000000000000".into(),
            "--eth-sender".into(), "0x70997970c51812dc3a010c7d01b50e0d17dc79c8".into(), "--eth-code-hash".into(), CODE_HASH.into(),
        ];
        args.extend(stub.clone());
        args
    };
    let b = bob_dir.path().join("b.swap.json");
    let (ok, out, err) = run(bin().args(bob_args(&b)));
    assert!(ok, "{err}");
    assert!(out.contains("\"phase\": \"received\""));
    assert!(err.contains("verified by this tool"), "{err}");
    let bob_file = SwapFile::load(&b).unwrap();
    assert!(bob_file.secret.is_none());
    assert!(bob_file.equivalence.is_some());
    assert!(bob_dir.path().join("hashlocks.txt").exists());
    // REVIEW-3 F2: --pinned-image-id is optional; the compiled-in id is accepted, any other value is refused and nothing is written.
    let reg = |n: &str| ["--registry".to_string(), bob_dir.path().join(n).to_str().unwrap().into()];
    let mut with_pin = bob_args(&bob_dir.path().join("pin-ok.swap.json"));
    with_pin.extend(["--pinned-image-id".to_string(), hex::encode(swap_cli::params::EQUIV_IMAGE_ID)]);
    with_pin.extend(reg("pin-ok.txt"));
    let (ok, _, err) = run(bin().args(with_pin));
    assert!(ok, "{err}");
    let mut other_pin = bob_args(&bob_dir.path().join("pin-bad.swap.json"));
    other_pin.extend(["--pinned-image-id".to_string(), "7e".repeat(32)]);
    other_pin.extend(reg("pin-bad.txt"));
    let (ok, _, err) = run(bin().args(other_pin));
    assert!(!ok && err.contains("--pinned-image-id") && err.contains("compiled into this tool"), "{err}");
    assert!(!bob_dir.path().join("pin-bad.swap.json").exists());
    // REVIEW-3 F2: the typed form is refused under production (this bundle's profile), whatever the values, and nothing is written.
    let mut typed = bob_args(&bob_dir.path().join("typed.swap.json"));
    typed.truncate(typed.len() - 4);
    typed.extend(["--equiv-h".to_string(), format!("0x{}", hex::encode(public.hashlock)), "--equiv-a".into(), public.claim_authority.clone()]);
    typed.extend(["--equiv-image-id".to_string(), hex::encode(swap_cli::params::EQUIV_IMAGE_ID)]);
    typed.extend(reg("typed.txt"));
    let (ok, _, err) = run(bin().args(typed));
    assert!(!ok && err.contains("rehearsal profile") && err.contains("--receipt"), "{err}");
    assert!(!bob_dir.path().join("typed.swap.json").exists());
    // REVIEW-3 F1: without --eth-code-hash Bob's terms use the compiled-in constant and the same bundle is accepted.
    let mut omitted = bob_args(&bob_dir.path().join("f.swap.json"));
    let i = omitted.iter().position(|a| a == "--eth-code-hash").unwrap();
    omitted.drain(i..i + 2);
    omitted.extend(["--registry".to_string(), bob_dir.path().join("other-hashlocks.txt").to_str().unwrap().into()]);
    let (ok, _, err) = run(bin().args(omitted));
    assert!(ok, "{err}");
    assert_eq!(SwapFile::load(&bob_dir.path().join("f.swap.json")).unwrap().public.params.eth.code_hash, Some(swap_cli::params::HTLC_CODE_HASH));
    // A payout address that is not Bob's own is refused even though the bundle is self-consistent.
    let mut wrong = bob_args(&bob_dir.path().join("c.swap.json"));
    let i = wrong.iter().position(|a| a == "--bob").unwrap();
    wrong[i + 1] = cast.alice.to_bech32();
    let (ok, _, err) = run(bin().args(wrong));
    assert!(!ok && err.contains("bob_noid"), "{err}");
    // A pin that is not the tool's image id is refused (REVIEW-3 F2).
    let mut wrong = bob_args(&bob_dir.path().join("d.swap.json"));
    wrong.extend(["--pinned-image-id".to_string(), "11".repeat(32)]);
    let (ok, _, err) = run(bin().args(wrong));
    assert!(!ok && err.contains("image id"), "{err}");
    // A tampered bundle is refused.
    let tampered = bundle.replace("\"max_fee_micronoid\": 50000", "\"max_fee_micronoid\": 60000");
    assert_ne!(tampered, bundle);
    std::fs::write(&bundle_path, bundle_text::reseal(&tampered)).unwrap();
    let (ok, _, err) = run(bin().args(bob_args(&bob_dir.path().join("e.swap.json"))));
    assert!(!ok && err.contains("byte-for-byte"), "{err}");
    // status never shows the secret.
    let (ok, out, _) = run(bin().args(["status", a.to_str().unwrap()]));
    assert!(ok && out.contains("\"secret_sealed\": true") && !out.contains("ciphertext"));
}

#[test]
fn tick_runs_the_watchers_over_fixtures_and_records_the_facts() {
    // The Parano1d fixtures were synthesized for the swap of secret 0x33.. (see fixtures/parano1d/*.json).
    let dir = tempfile::tempdir().unwrap();
    let b = dir.path().join("b.swap.json");
    let public = example_public(&Secret::from_bytes(swap_cli::htlc_harness::seq_bytes(0x33)), Variant::Raw);
    swap_cli::swapfile::example_bob_file(public, 1).unwrap().save(&b).unwrap();
    let root = concat!(env!("CARGO_MANIFEST_DIR"), "/fixtures/");
    let (ok, out, err) = run(bin().args([
        "tick", b.to_str().unwrap(),
        "--noid-fixture", &format!("{root}parano1d/funded.json"),
        "--eth-fixture", &format!("{root}eth/locked.json"),
        "--now", "1794312000", "--apply",
    ]));
    assert!(ok, "{err}");
    let v: serde_json::Value = serde_json::from_str(&out).unwrap();
    assert_eq!(v["events"][0]["event"], "noid_instance_seen", "{out}");
    assert_eq!(v["action"]["action"], "wait");
    assert_eq!(v["action_executed"], false);
    assert_eq!(v["phase_after"], "funded");
    assert_eq!(SwapFile::load(&b).unwrap().phase.name(), "funded");
    // The recorded Ethereum lock belongs to another swap: the watcher ignores it.
    assert!(v["eth"]["lock"].is_null());
    // A fixture of another swap is refused by its pinned params, not silently reused.
    let a = dir.path().join("other.swap.json");
    swap_cli::swapfile::example_bob_file(example_public(&Secret::from_bytes(swap_cli::htlc_harness::seq_bytes(0x34)), Variant::Raw), 1).unwrap().save(&a).unwrap();
    let (ok, _, err) = run(bin().args(["tick", a.to_str().unwrap(), "--noid-fixture", &format!("{root}parano1d/funded.json"), "--eth-fixture", &format!("{root}eth/locked.json")]));
    assert!(!ok && err.contains("fixture recorded"), "{err}");
}

#[test]
fn secret_prints_alice_secret_only_with_the_passphrase() {
    let dir = tempfile::tempdir().unwrap();
    let a = dir.path().join("a.swap.json");
    let cast = swap_cli::htlc_harness::Cast::new();
    let common = [
        "--alice", &cast.alice.to_bech32(), "--bob", &cast.bob.to_bech32(), "--amount", "10000000", "--fee-estimate", "5800",
        "--h-create", "300000", "--eth-contract", "0x5fbdb2315678afecb367f032d93f642f64180aa3", "--eth-chain-id", "31337",
        "--eth-amount-wei", "10000000000000000", "--eth-receiver", "0x3c44cdddb6a900fa2b585dd299e03d12fa4293bc",
        "--eth-sender", "0x70997970c51812dc3a010c7d01b50e0d17dc79c8", "--eth-code-hash", CODE_HASH, "--fast-kdf",
    ];
    let (ok, bundle, err) = run(bin().args(["new-alice", "--out", a.to_str().unwrap()]).args(common).env("SWAP_PASSPHRASE", "correct horse battery staple"));
    assert!(ok, "{err}");
    let public: swap_cli::swapfile::SwapPublic = serde_json::from_str(&bundle).unwrap();
    // Wrong passphrase: refused, nothing on stdout.
    let (ok, out, _) = run(bin().args(["secret", a.to_str().unwrap()]).env("SWAP_PASSPHRASE", "not the passphrase at all"));
    assert!(!ok && out.trim().is_empty());
    // No passphrase: refused before the file is even opened.
    let (ok, out, err) = run(bin().args(["secret", a.to_str().unwrap()]).env_remove("SWAP_PASSPHRASE"));
    assert!(!ok && out.trim().is_empty() && err.contains("SWAP_PASSPHRASE"));
    // Right passphrase: the 0x-hex secret whose SHA-256 is the bundle's hashlock, with a warning on stderr.
    let (ok, out, err) = run(bin().args(["secret", a.to_str().unwrap()]).env("SWAP_PASSPHRASE", "correct horse battery staple"));
    assert!(ok, "{err}");
    let text = out.trim();
    assert!(text.starts_with("0x") && text.len() == 66, "{text}");
    let s = Secret::from_hex(text.trim_start_matches("0x")).unwrap();
    assert_eq!(s.hashlock(), public.hashlock);
    assert!(err.contains("WARNING"), "{err}");
}

#[test]
fn chain_id_is_mandatory_and_the_code_hash_is_the_compiled_in_constant_for_both_roles() {
    // REVIEW-2 F1 (chain id: no default, no escape flag) and REVIEW-3 F1 (code hash: a constant of the build).
    let dir = tempfile::tempdir().unwrap();
    let a = dir.path().join("a.swap.json");
    let cast = swap_cli::htlc_harness::Cast::new();
    let all: Vec<(&str, String)> = vec![
        ("--alice", cast.alice.to_bech32()), ("--bob", cast.bob.to_bech32()), ("--amount", "10000000".into()), ("--fee-estimate", "5800".into()),
        ("--h-create", "300000".into()), ("--eth-contract", "0x5fbdb2315678afecb367f032d93f642f64180aa3".into()), ("--eth-chain-id", "31337".into()),
        ("--eth-amount-wei", "10000000000000000".into()), ("--eth-receiver", "0x3c44cdddb6a900fa2b585dd299e03d12fa4293bc".into()),
        ("--eth-sender", "0x70997970c51812dc3a010c7d01b50e0d17dc79c8".into()), ("--eth-code-hash", CODE_HASH.into()), ("--fast-kdf", "".into()),
    ];
    let alice_args = |omit: &str, code_hash: Option<&str>| {
        let mut args = vec!["new-alice".to_string(), "--out".into(), a.to_str().unwrap().into()];
        for (k, v) in all.iter().filter(|(k, _)| *k != omit && *k != "--eth-code-hash") {
            args.push(k.to_string());
            if !v.is_empty() {
                args.push(v.clone());
            }
        }
        if let Some(h) = code_hash {
            args.extend(["--eth-code-hash".to_string(), h.to_string()]);
        }
        args
    };
    let pass = "correct horse battery staple";
    // The chain id has no default.
    let (ok, _, err) = run(bin().args(alice_args("--eth-chain-id", Some(CODE_HASH))).env("SWAP_PASSPHRASE", pass));
    assert!(!ok && err.contains("missing --eth-chain-id"), "{err}");
    assert!(!a.exists(), "nothing is written when --eth-chain-id is missing");
    // A code hash other than the compiled-in one is refused, whatever it is, and nothing is written (no file, no registry entry).
    for wrong in [OTHER_CODE_HASH, "0xa906117fc4e604bd25fcee2a6a41da8b824ec9b4a17d10137704e7da42545e2e", "0x0000000000000000000000000000000000000000000000000000000000000000"] {
        let (ok, out, err) = run(bin().args(alice_args("", Some(wrong))).env("SWAP_PASSPHRASE", pass));
        assert!(!ok && out.trim().is_empty(), "{wrong}: {err}");
        assert!(err.contains("--eth-code-hash") && err.contains(&CODE_HASH[2..]) && err.contains("different contract"), "{wrong}: {err}");
        assert!(!a.exists() && !dir.path().join("hashlocks.txt").exists(), "nothing is written for a wrong code hash ({wrong})");
    }
    // Omitted: accepted, and the file pins the constant. Given and equal: accepted too (checked in the other tests).
    let (ok, bundle, err) = run(bin().args(alice_args("", None)).env("SWAP_PASSPHRASE", pass));
    assert!(ok, "{err}");
    let public: swap_cli::swapfile::SwapPublic = serde_json::from_str(&bundle).unwrap();
    assert_eq!(public.params.eth.code_hash, Some(swap_cli::params::HTLC_CODE_HASH));
    assert_eq!(SwapFile::load(&a).unwrap().public.params.eth.code_hash, Some(swap_cli::params::HTLC_CODE_HASH));
    // Bob: the chain id still comes from HIS terms, before the bundle is read.
    let bundle_path = dir.path().join("bundle.json");
    std::fs::write(&bundle_path, "{}").unwrap();
    let b = dir.path().join("b.swap.json");
    let bob_args = |chain_id: bool, code_hash: Option<&str>| {
        let mut args = vec![
            "new-bob".to_string(), "--bundle".into(), bundle_path.to_str().unwrap().into(), "--out".into(), b.to_str().unwrap().into(),
            "--bob".into(), cast.bob.to_bech32(), "--amount".into(), "10000000".into(),
            "--eth-contract".into(), "0x5fbdb2315678afecb367f032d93f642f64180aa3".into(), "--eth-amount-wei".into(), "10000000000000000".into(),
            "--eth-sender".into(), "0x70997970c51812dc3a010c7d01b50e0d17dc79c8".into(),
        ];
        if chain_id {
            args.extend(["--eth-chain-id".to_string(), "31337".into()]);
        }
        if let Some(h) = code_hash {
            args.extend(["--eth-code-hash".to_string(), h.to_string()]);
        }
        args
    };
    let (ok, _, err) = run(bin().args(bob_args(false, Some(CODE_HASH))));
    assert!(!ok && err.contains("missing --eth-chain-id"), "{err}");
    // A wrong code hash is refused before the bundle is even parsed; an omitted or equal one gets as far as the (empty) bundle.
    let (ok, _, err) = run(bin().args(bob_args(true, Some(OTHER_CODE_HASH))));
    assert!(!ok && err.contains("different contract") && err.contains(&CODE_HASH[2..]) && !err.contains("bundle:"), "{err}");
    for given in [None, Some(CODE_HASH)] {
        let (ok, _, err) = run(bin().args(bob_args(true, given)));
        assert!(!ok && err.contains("bundle:") && !err.contains("code hash") && !err.contains("--eth-code-hash"), "{given:?}: {err}");
    }
    assert!(!b.exists());
}

#[test]
fn intent_command_shows_and_cancels_through_the_binary() {
    // REVIEW-2 F3: `intent FILE` (show) and `intent FILE --cancel` (needs the tick chain flags).
    let dir = tempfile::tempdir().unwrap();
    let b = dir.path().join("b.swap.json");
    let public = example_public(&Secret::from_bytes(swap_cli::htlc_harness::seq_bytes(0x33)), Variant::Raw);
    let mut file = swap_cli::swapfile::example_bob_file(public, 1).unwrap();
    file.pending_intent = Some(swap_cli::swapfile::PendingIntent {
        action: "refund_eth".into(),
        params: serde_json::json!({"action": "refund_eth", "lock_id": "0x01"}),
        decided_at: 1794312000 - 7200,
        phase_at_decision: file.phase.name(),
        noid_tip: 300_030,
        eth_block: 2,
    });
    file.save(&b).unwrap();
    let (ok, out, err) = run(bin().args(["intent", b.to_str().unwrap(), "--show"]));
    assert!(ok, "{err}");
    let v: serde_json::Value = serde_json::from_str(&out).unwrap();
    assert_eq!(v["pending_intent"]["action"], "refund_eth");
    // Cancel needs a chain view (it refuses when the chain shows the effect).
    let (ok, _, err) = run(bin().args(["intent", b.to_str().unwrap(), "--cancel"]));
    assert!(!ok && err.contains("exactly one of --noid-fixture"), "{err}");
    let root = concat!(env!("CARGO_MANIFEST_DIR"), "/fixtures/");
    // REVIEW-3 F3: a recording that cannot say what the signer has pending (no eth_getTransactionCount) refuses the cancel.
    let (ok, _, err) = run(bin().args([
        "intent", b.to_str().unwrap(), "--cancel",
        "--noid-fixture", &format!("{root}parano1d/idle.json"), "--eth-fixture", &format!("{root}eth/locked.json"), "--now", "1794312000",
    ]));
    assert!(!ok && err.contains("nonces are unknown"), "{err}");
    assert!(SwapFile::load(&b).unwrap().pending_intent.is_some());
    // The same recording plus the signer's nonces (Bob's file: `bob_sender`, 0xb0..b0): a pending transaction refuses the cancel,
    // equal nonces allow it.
    let signer = format!("0x{}", hex::encode(file.public.params.eth.bob_sender));
    let with_nonces = |name: &str, latest: &str, pending: &str| {
        let mut fx: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(format!("{root}eth/locked.json")).unwrap()).unwrap();
        let calls = fx["calls"].as_array_mut().unwrap();
        calls.push(serde_json::json!({"method": "eth_getTransactionCount", "params": [signer, "latest"], "result": latest}));
        calls.push(serde_json::json!({"method": "eth_getTransactionCount", "params": [signer, "pending"], "result": pending}));
        let path = dir.path().join(name);
        std::fs::write(&path, fx.to_string()).unwrap();
        path
    };
    let busy = with_nonces("eth-busy.json", "0x5", "0x6");
    let (ok, _, err) = run(bin().args([
        "intent", b.to_str().unwrap(), "--cancel",
        "--noid-fixture", &format!("{root}parano1d/idle.json"), "--eth-fixture", busy.to_str().unwrap(), "--now", "1794312000",
    ]));
    assert!(!ok && err.contains("pending nonce 6 > latest nonce 5"), "{err}");
    assert!(SwapFile::load(&b).unwrap().pending_intent.is_some());
    let quiet = with_nonces("eth-quiet.json", "0x5", "0x5");
    let (ok, out, err) = run(bin().args([
        "intent", b.to_str().unwrap(), "--cancel",
        "--noid-fixture", &format!("{root}parano1d/idle.json"), "--eth-fixture", quiet.to_str().unwrap(), "--now", "1794312000",
    ]));
    assert!(ok, "{err}");
    assert_eq!(serde_json::from_str::<serde_json::Value>(&out).unwrap()["cancelled"]["action"], "refund_eth");
    let after = SwapFile::load(&b).unwrap();
    assert!(after.pending_intent.is_none() && after.history.iter().any(|h| h.event == "intent_cancelled:refund_eth"));
    // The lock file sits next to the swap file and a second cancel has nothing to cancel.
    assert!(dir.path().join("b.swap.json.lock").exists());
    let (ok, _, err) = run(bin().args([
        "intent", b.to_str().unwrap(), "--cancel",
        "--noid-fixture", &format!("{root}parano1d/idle.json"), "--eth-fixture", quiet.to_str().unwrap(), "--now", "1794312000",
    ]));
    assert!(!ok && err.contains("no pending intent"), "{err}");
}

#[test]
fn read_only_tick_withholds_the_parameters_of_a_spend_and_apply_records_and_prints_them() {
    // REVIEW-3 F3: Bob has seen the funding final and would lock. A read-only tick records nothing, so it must not print
    // the lock's parameters (T_reveal, amount, receiver): an operator who acted on them and acted again on the next tick's
    // fresh ones would lock twice.
    let dir = tempfile::tempdir().unwrap();
    let b = dir.path().join("b.swap.json");
    let mut public = example_public(&Secret::from_bytes(swap_cli::htlc_harness::seq_bytes(0x33)), Variant::Raw);
    // REVIEW-3 F1: the pin is the compiled-in hash, so the node must serve the real HTLC runtime code (the recording's).
    let real_code = {
        let recorded: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/fixtures/eth/locked.json")).unwrap()).unwrap();
        let call = recorded["calls"].as_array().unwrap().iter().find(|c| c["method"] == "eth_getCode").unwrap();
        call["result"].as_str().unwrap().to_string()
    };
    assert_eq!(swap_cli::watch::eth::keccak256(&hex::decode(real_code.trim_start_matches("0x")).unwrap()), swap_cli::params::HTLC_CODE_HASH);
    let mut file = swap_cli::swapfile::example_bob_file(public, 1).unwrap();
    let inst = swap_cli::watch::NoidInstance { slot_index: 4242, creation_id: 77001, amount_micronoid: 10_000_000 };
    for e in [swap_cli::state::Event::NoidInstanceSeen { instance: inst, tip: 300_063 }, swap_cli::state::Event::NoidFundingFinal { tip: 300_080 }] {
        file.apply(&e, 1).unwrap();
    }
    file.save(&b).unwrap();
    let eth = dir.path().join("eth.json");
    std::fs::write(
        &eth,
        serde_json::json!({"description": "minimal Ethereum answers: chain 11155111, the HTLC runtime code, no lock", "calls": [
            {"method": "eth_blockNumber", "result": "0xa"},
            {"method": "eth_getBlockByNumber", "result": {"number": "0xa", "timestamp": "0x3e8"}},
            {"method": "eth_getBlockByNumber", "result": {"number": "0x8", "timestamp": "0x3d0"}},
            {"method": "eth_chainId", "result": "0xaa36a7"},
            {"method": "eth_getCode", "result": real_code},
            {"method": "eth_getLogs", "result": []},
            {"method": "eth_call", "error": {"code": 3, "message": "execution reverted: LockNotFound"}}
        ]})
        .to_string(),
    )
    .unwrap();
    let root = concat!(env!("CARGO_MANIFEST_DIR"), "/fixtures/");
    // REVIEW-3 F5: an unknown header time blocks the spend, and the shared fixture has no `getBlockHeader` call (the
    // watcher tests rely on that): this test replays a copy of it with one, fresh against `--now 1000`.
    let noid = {
        let mut fx: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(format!("{root}parano1d/funded.json")).unwrap()).unwrap();
        fx["calls"].as_array_mut().unwrap().push(serde_json::json!({"method": "paranoid_getBlockHeader", "result": {"height": 300_100, "timestamp": 990}}));
        let path = dir.path().join("funded.with-header.json");
        std::fs::write(&path, fx.to_string()).unwrap();
        path.to_str().unwrap().to_string()
    };
    let flags = |extra: &[&str]| {
        let mut v: Vec<String> = vec!["tick".into(), b.to_str().unwrap().into(), "--noid-fixture".into(), noid.clone(), "--eth-fixture".into(), eth.to_str().unwrap().into(), "--now".into(), "1000".into(), "--single-node-ok".into(), "--accept-producer-concentration".into()];
        v.extend(extra.iter().map(|s| s.to_string()));
        v
    };
    let before = std::fs::read(&b).unwrap();

    // Read-only: the kind only, nothing recorded, the file is byte-for-byte unchanged.
    let (ok, out, err) = run(bin().args(flags(&[])));
    assert!(ok, "{err}");
    let v: serde_json::Value = serde_json::from_str(&out).unwrap();
    assert_eq!(v["action"]["kind"], "lock_eth", "{out}");
    assert_eq!(v["action"]["parameters"], "withheld");
    assert_eq!(v["action"].as_object().unwrap().len(), 3, "kind, parameters, note and nothing else: {}", v["action"]);
    assert!(v["action"]["note"].as_str().unwrap().contains("tick --apply"));
    assert_eq!(v["intent"]["status"], "none");
    assert!(!out.contains("\"t_reveal\"") && !out.contains("\"amount_wei\"") && !out.contains("\"receiver\""), "{out}");
    assert_eq!(std::fs::read(&b).unwrap(), before);

    // `claim` (no --submit) names the engine's action too, and withholds it the same way.
    let (ok, out, err) = run(bin().args(["claim", b.to_str().unwrap(), "--noid-fixture", &noid, "--eth-fixture", eth.to_str().unwrap(), "--now", "1000", "--single-node-ok", "--accept-producer-concentration"]));
    assert!(ok, "{err}");
    let c: serde_json::Value = serde_json::from_str(&out).unwrap();
    assert_eq!(c["action"]["kind"], "lock_eth", "{out}");
    assert_eq!(c["action"]["parameters"], "withheld");
    assert!(!out.contains("\"t_reveal\""), "{out}");
    assert_eq!(std::fs::read(&b).unwrap(), before);

    // --apply: recorded first, then printed with its parameters.
    let (ok, out, err) = run(bin().args(flags(&["--apply"])));
    assert!(ok, "{err}");
    let v: serde_json::Value = serde_json::from_str(&out).unwrap();
    assert_eq!(v["action"]["action"], "lock_eth", "{out}");
    assert_eq!(v["action"]["t_reveal"], 1000 + 7200);
    assert_eq!(v["intent"]["status"], "recorded");
    let saved = SwapFile::load(&b).unwrap().pending_intent.expect("recorded before it was printed");
    assert_eq!(saved.action, "lock_eth");
    assert_eq!(saved.params["t_reveal"], 1000 + 7200);

    // The next read-only tick holds the intent (a wait that shows the frozen parameters, as before).
    let (ok, out, err) = run(bin().args(flags(&[])));
    assert!(ok, "{err}");
    let v: serde_json::Value = serde_json::from_str(&out).unwrap();
    assert_eq!(v["action"]["action"], "wait", "{out}");
    assert_eq!(v["intent"]["status"], "held");
}
