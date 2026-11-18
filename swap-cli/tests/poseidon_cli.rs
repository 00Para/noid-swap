//! The `poseidon` Ethereum lock kind through the `swap-cli` binary: `new-alice --eth-lock-kind poseidon`, `new-bob` (no receipt, the lock word
//! checked against the opening, the client R self-test run before the file is written), `self-test`, `status`.

use std::process::Command;

#[path = "common/equiv_stub.rs"]
mod equiv_stub;
#[path = "common/home.rs"]
mod home;

use swap_cli::secret::LockKind;
use swap_cli::swapfile::{Passphrase, SwapFile, SwapPublic};

const OTHER_CODE_HASH: &str = "0x2222222222222222222222222222222222222222222222222222222222222222";
const HTLC_CODE_HASH_HEX: &str = "0xa906117fc4e604bd25fcee2a6a41da8b824ec9b4a17d10137704e7da42545e2f";
const V2_CODE_HASH_HEX: &str = "0xf510d2a368c730339fa7cf5e023bcf2429d5732793f043e03025780bb7043ff3";

fn bin() -> Command {
    home::isolated_bin()
}

fn run(cmd: &mut Command) -> (bool, String, String) {
    let out = cmd.output().expect("run swap-cli");
    (out.status.success(), String::from_utf8_lossy(&out.stdout).into_owned(), String::from_utf8_lossy(&out.stderr).into_owned())
}

fn alice_args(out: &std::path::Path, cast: &swap_cli::htlc_harness::Cast) -> Vec<String> {
    let mut v: Vec<String> = [
        "new-alice", "--out", out.to_str().unwrap(), "--alice", &cast.alice.to_bech32(), "--bob", &cast.bob.to_bech32(), "--amount", "10000000",
        "--fee-estimate", "5800", "--h-create", "300000", "--eth-contract", "0x5fbdb2315678afecb367f032d93f642f64180aa3", "--eth-chain-id", "31337",
        "--eth-amount-wei", "10000000000000000", "--eth-receiver", "0x3c44cdddb6a900fa2b585dd299e03d12fa4293bc", "--eth-sender",
        "0x70997970c51812dc3a010c7d01b50e0d17dc79c8", "--fast-kdf",
    ]
    .iter()
    .map(|s| s.to_string())
    .collect();
    v.extend(["--eth-lock-kind".to_string(), "poseidon".to_string()]);
    v
}

fn bob_args(bundle: &std::path::Path, out: &std::path::Path, cast: &swap_cli::htlc_harness::Cast) -> Vec<String> {
    [
        "new-bob", "--bundle", bundle.to_str().unwrap(), "--out", out.to_str().unwrap(), "--bob", &cast.bob.to_bech32(), "--amount", "10000000",
        "--eth-chain-id", "31337", "--eth-contract", "0x5fbdb2315678afecb367f032d93f642f64180aa3", "--eth-amount-wei", "10000000000000000",
        "--eth-sender", "0x70997970c51812dc3a010c7d01b50e0d17dc79c8",
    ]
    .iter()
    .map(|s| s.to_string())
    .collect()
}

#[test]
fn a_poseidon_swap_is_started_without_any_proof_step() {
    let cast = swap_cli::htlc_harness::Cast::new();
    let dir = tempfile::tempdir().unwrap();
    let a = dir.path().join("a.swap.json");
    // Alice: stock variant and the poseidon lock do not go together; a code hash that is another contract is refused; nothing is written.
    let mut stock = alice_args(&a, &cast);
    stock.extend(["--variant".to_string(), "stock".to_string()]);
    let (ok, _, err) = run(bin().args(&stock).env("SWAP_PASSPHRASE", "correct horse battery staple"));
    assert!(!ok && err.contains("raw variant"), "{err}");
    for wrong in [HTLC_CODE_HASH_HEX, OTHER_CODE_HASH] {
        let mut args = alice_args(&a, &cast);
        args.extend(["--eth-code-hash".to_string(), wrong.to_string()]);
        let (ok, _, err) = run(bin().args(&args).env("SWAP_PASSPHRASE", "correct horse battery staple"));
        assert!(!ok && err.contains("HTLCPoseidonV2") && err.contains("--eth-code-hash"), "{err}");
    }
    assert!(!a.exists());
    // The right one (given or omitted) writes the file; the bundle says poseidon and carries the V2 pin.
    let mut args = alice_args(&a, &cast);
    args.extend(["--eth-code-hash".to_string(), V2_CODE_HASH_HEX.to_string()]);
    let (ok, bundle, err) = run(bin().args(&args).env("SWAP_PASSPHRASE", "correct horse battery staple"));
    assert!(ok, "{err}");
    assert!(err.contains("Bob needs NO equivalence proof"), "{err}");
    let public: SwapPublic = serde_json::from_str(&bundle).unwrap();
    assert_eq!(public.params.eth.lock_kind, LockKind::Poseidon);
    assert_eq!(public.params.eth.code_hash, Some(swap_cli::params::HTLC_POSEIDON_V2_CODE_HASH));
    assert_eq!(public.hashlock, public.authority().unwrap().0, "the Ethereum lock word is the NOID claim authority");
    let file = SwapFile::load(&a).unwrap();
    let secret = file.decrypt_secret(&Passphrase::new("correct horse battery staple")).unwrap();
    assert_eq!(secret.lock_word(LockKind::Poseidon), public.hashlock);
    let (ok, status, _) = run(bin().args(["status", a.to_str().unwrap()]));
    assert!(ok);
    let v: serde_json::Value = serde_json::from_str(&status).unwrap();
    assert_eq!(v["eth_lock_kind"], "poseidon");
    assert_eq!(v["eth_lock_word"], format!("0x{}", hex::encode(public.hashlock)));

    // Bob.
    let bundle_path = dir.path().join("bundle.json");
    std::fs::write(&bundle_path, &bundle).unwrap();
    let bob_dir = tempfile::tempdir().unwrap();
    let b = bob_dir.path().join("b.swap.json");
    // Not asking for the poseidon kind is a disagreement with the bundle, written nowhere.
    let (ok, _, err) = run(bin().args(bob_args(&bundle_path, &b, &cast)));
    assert!(!ok && err.contains("--eth-lock-kind"), "{err}");
    assert!(!b.exists());
    // Every option of the equivalence proof is refused for this kind.
    let stub = equiv_stub::receipt_flags(bob_dir.path());
    let mut with_receipt = bob_args(&bundle_path, &b, &cast);
    with_receipt.extend(["--eth-lock-kind".to_string(), "poseidon".to_string()]);
    with_receipt.extend(stub);
    let (ok, _, err) = run(bin().args(&with_receipt));
    assert!(!ok && err.contains("equivalence proof") && err.contains("--receipt"), "{err}");
    let mut with_typed = bob_args(&bundle_path, &b, &cast);
    with_typed.extend(["--eth-lock-kind".to_string(), "poseidon".to_string(), "--equiv-h".to_string(), "0x00".to_string()]);
    let (ok, _, err) = run(bin().args(&with_typed));
    assert!(!ok && err.contains("--equiv-h"), "{err}");
    assert!(!b.exists());
    // The right terms: the file is written, with NO attestation, and the client R self-test has passed on this machine (a real proof).
    let mut good = bob_args(&bundle_path, &b, &cast);
    good.extend(["--eth-lock-kind".to_string(), "poseidon".to_string()]);
    let (ok, out, err) = run(bin().args(&good));
    assert!(ok, "{err}");
    assert!(err.contains("client R self-test passed") && err.contains("no equivalence proof exists"), "{err}");
    let bob = SwapFile::load(&b).unwrap();
    assert!(bob.equivalence.is_none());
    let t = bob.client_r_selftest.clone().expect("the self-test is recorded in Bob's file");
    assert_eq!(t.auth_version, "V4");
    assert!(out.contains("client_r_selftest"), "{out}");
    // REVIEW-6 R6-4: the record is bound to this file's lock word, this swap's contract version and the binary's build string.
    assert_eq!(t.lock_word, hex::encode(public.hashlock));
    assert_eq!(t.contract_version, 1);
    assert_eq!(t.build_id, swap_cli::build_id());
    // `self-test` runs it again and records the new pass; it is Bob's poseidon file only.
    let before = t.passed_at;
    let (ok, out, err) = run(bin().args(["self-test", b.to_str().unwrap(), "--call-height", "300500"]));
    assert!(ok, "{err}");
    let v: serde_json::Value = serde_json::from_str(&out).unwrap();
    assert_eq!((v["client_r_selftest"].as_str(), v["auth_version"].as_str(), v["call_height"].as_u64()), (Some("passed"), Some("V4"), Some(300_500)));
    let after = SwapFile::load(&b).unwrap().client_r_selftest.unwrap();
    assert_eq!(after.call_height, 300_500);
    assert!(after.passed_at >= before);
    let (ok, _, err) = run(bin().args(["self-test", a.to_str().unwrap(), "--call-height", "300500"]));
    assert!(!ok && err.contains("Bob's file of a poseidon swap"), "{err}");

    // REVIEW-7 R7-2: a self-test that FAILS must not leave the earlier passing record valid. The height below overflows the throwaway's
    // deadline, so the run fails at once (no proof); the file must then carry no record, and say so in its history.
    assert!(SwapFile::load(&b).unwrap().client_r_selftest.is_some(), "a passing record is in the file before the failing run");
    let (ok, _, err) = run(bin().args(["self-test", b.to_str().unwrap(), "--call-height", "18446744073709551615"]));
    assert!(!ok && err.contains("FAILED") && err.contains("no record is kept"), "{err}");
    let failed = SwapFile::load(&b).unwrap();
    assert!(failed.client_r_selftest.is_none(), "a failed self-test leaves no record");
    let events: Vec<&str> = failed.history.iter().map(|h| h.event.as_str()).collect();
    assert!(events.contains(&"client_r_selftest_cleared") && events.last() == Some(&"client_r_selftest_failed"), "{events:?}");
    // A later pass records again.
    let (ok, _, err) = run(bin().args(["self-test", b.to_str().unwrap(), "--call-height", "300500"]));
    assert!(ok, "{err}");
    assert!(SwapFile::load(&b).unwrap().client_r_selftest.is_some());
}
