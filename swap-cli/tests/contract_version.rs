//! Contract versions through the swap file, the bundle and the binary: `HashTimeLock` (v1, the default) and
//! `HashTimeLockV2` (v2, every close pays exactly `max_fee`). `new-alice --contract-version`, the bundle carrying
//! a non-default version, `new-bob` refusing a mismatch, `alice-params` emitting the matching definition, and
//! the guarantee that v1 files, bundles and digests are byte-for-byte what they were before versions existed.

use std::path::{Path, PathBuf};
use std::process::Command;

#[path = "common/bundle_text.rs"]
mod bundle_text;
#[path = "common/equiv_stub.rs"]
mod equiv_stub;

use serde_json::Value;
use swap_cli::htlc_harness::{self, load_params_guarded};
use swap_cli::params::ContractVersion;
use swap_cli::secret::{Secret, Variant};
use swap_cli::swapfile::{detect_contract_version, example_bob_terms, example_public, example_public_v, KdfParams, Passphrase, SwapFile, SwapPublic};

const CODE_HASH: &str = "0xa906117fc4e604bd25fcee2a6a41da8b824ec9b4a17d10137704e7da42545e2f";
const PASS: &str = "correct horse battery staple";

fn contracts() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../parano1d/contracts")
}

fn run(args: &[String]) -> (bool, String, String) {
    let out = Command::new(env!("CARGO_BIN_EXE_swap-cli")).args(args).env("SWAP_PASSPHRASE", PASS).output().expect("run swap-cli");
    (out.status.success(), String::from_utf8_lossy(&out.stdout).into_owned(), String::from_utf8_lossy(&out.stderr).into_owned())
}

fn s(v: &[&str]) -> Vec<String> {
    v.iter().map(|x| x.to_string()).collect()
}

fn alice_args(out: &Path, version: Option<&str>) -> Vec<String> {
    let cast = htlc_harness::Cast::new();
    let mut a = s(&["new-alice", "--out", out.to_str().unwrap()]);
    a.extend(s(&["--alice", &cast.alice.to_bech32(), "--bob", &cast.bob.to_bech32(), "--amount", "10000000", "--fee-estimate", "5800"]));
    a.extend(s(&["--h-create", "300000", "--eth-contract", "0x5fbdb2315678afecb367f032d93f642f64180aa3", "--eth-chain-id", "11155111"]));
    a.extend(s(&["--eth-amount-wei", "10000000000000000", "--eth-receiver", "0x3c44cdddb6a900fa2b585dd299e03d12fa4293bc"]));
    a.extend(s(&["--eth-sender", "0x70997970c51812dc3a010c7d01b50e0d17dc79c8", "--eth-code-hash", CODE_HASH, "--fast-kdf"]));
    if let Some(v) = version {
        a.extend(s(&["--contract-version", v]));
    }
    a
}

fn bob_args(public: &SwapPublic, bundle: &Path, out: &Path, version: Option<&str>) -> Vec<String> {
    let t = example_bob_terms(public);
    let p = &public.params;
    let mut a = s(&["new-bob", "--bundle", bundle.to_str().unwrap(), "--out", out.to_str().unwrap()]);
    a.extend(s(&["--bob", &t.bob_noid.to_bech32(), "--amount", &p.amount_micronoid.to_string()]));
    a.extend(s(&["--eth-chain-id", &p.eth.chain_id.to_string(), "--eth-contract", &format!("0x{}", hex::encode(p.eth.contract))]));
    a.extend(s(&["--eth-code-hash", &format!("0x{}", hex::encode(t.eth_code_hash)), "--eth-amount-wei", &p.eth.amount_wei.to_string()]));
    a.extend(s(&["--eth-sender", &format!("0x{}", hex::encode(p.eth.bob_sender))]));
    // REVIEW-3 F2: a production bundle needs a receipt verified by the tool (stand-in `equiv-prove`); the typed form is rehearsal-only.
    a.extend(equiv_stub::receipt_flags(out.parent().unwrap()));
    a.extend(s(&["--registry", out.with_extension("registry").to_str().unwrap()]));
    if let Some(v) = version {
        a.extend(s(&["--contract-version", v]));
    }
    a
}

#[test]
fn v1_files_do_not_mention_the_version_and_v2_files_do() {
    let secret = Secret::generate().unwrap();
    let v1 = example_public(&secret, Variant::Raw);
    let v2 = example_public_v(&secret, Variant::Raw, ContractVersion::V2);
    let (j1, j2) = (serde_json::to_string(&v1).unwrap(), serde_json::to_string(&v2).unwrap());
    // v1 stays byte-compatible with files written before versions existed: same JSON, same digest, same sealed secrets.
    assert!(!j1.contains("contract_version"), "{j1}");
    assert!(j2.contains("\"contract_version\":2"), "{j2}");
    let back: SwapPublic = serde_json::from_str(&j1).unwrap();
    assert_eq!(back.params.contract_version, ContractVersion::V1);
    assert_eq!(back.digest(), v1.digest());
    assert_eq!(v1, example_public_v(&secret, Variant::Raw, ContractVersion::V1));
    assert_ne!(v1.digest(), v2.digest());
    // Same everything else, a different program: a different opening and a different address.
    assert_ne!(v1.opening_hex, v2.opening_hex);
    assert_ne!(v1.contract_root, v2.contract_root);
    assert_eq!(v1.opening_hex.len(), v2.opening_hex.len());
    assert_eq!(v1.params.max_fee_micronoid, v2.params.max_fee_micronoid);
    // An unknown number is refused when the bundle is parsed.
    let mut v: Value = serde_json::to_value(&v2).unwrap();
    v["params"]["contract_version"] = serde_json::json!(3);
    assert!(serde_json::from_value::<SwapPublic>(v).is_err());
}

#[test]
fn a_bundle_cannot_be_moved_between_versions() {
    let secret = Secret::generate().unwrap();
    let v2 = example_public_v(&secret, Variant::Raw, ContractVersion::V2);
    v2.check().unwrap();
    // Relabel it v1: the opening no longer rebuilds byte-for-byte.
    let mut as_v1 = v2.clone();
    as_v1.params.contract_version = ContractVersion::V1;
    assert!(as_v1.check().unwrap_err().to_string().contains("byte-for-byte"));
    // Strip the field (what an old tool would produce): the same result, so an old tool fails closed.
    let mut v: Value = serde_json::to_value(&v2).unwrap();
    v["params"].as_object_mut().unwrap().remove("contract_version").unwrap();
    let stripped: SwapPublic = serde_json::from_value(v).unwrap();
    assert_eq!(stripped.params.contract_version, ContractVersion::V1);
    assert!(stripped.check().is_err());
    // And the other way round.
    let v1 = example_public(&secret, Variant::Raw);
    let mut as_v2 = v1.clone();
    as_v2.params.contract_version = ContractVersion::V2;
    assert!(as_v2.check().is_err());
    // A sealed secret is bound to the public section: relabelling the version is detected too.
    let mut file = SwapFile::new_alice(v2.clone(), &secret, &Passphrase::new("pw"), &KdfParams::fast_for_tests(), 1).unwrap();
    assert!(file.decrypt_secret(&Passphrase::new("pw")).is_ok());
    file.public = v1;
    assert!(file.decrypt_secret(&Passphrase::new("pw")).is_err());
}

#[test]
fn the_opening_says_which_contract_it_is() {
    let secret = Secret::generate().unwrap();
    for version in [ContractVersion::V1, ContractVersion::V2] {
        for variant in [Variant::Raw, Variant::Stock] {
            let p = example_public_v(&secret, variant, version);
            assert_eq!(detect_contract_version(&p.opening().unwrap()), Some(version));
        }
    }
    // An opening that is neither (its max_fee edited after the fact) is not recognised.
    let mut o = example_public_v(&secret, Variant::Raw, ContractVersion::V2).opening().unwrap();
    o.rules.max_fee += 1;
    assert_eq!(detect_contract_version(&o), None);
}

#[test]
fn expected_payout_is_known_up_front_only_for_v2() {
    let secret = Secret::generate().unwrap();
    let v1 = example_public(&secret, Variant::Raw);
    let v2 = example_public_v(&secret, Variant::Raw, ContractVersion::V2);
    assert_eq!(v1.params.fixed_close_fee(), None);
    assert_eq!(v1.params.expected_bob_payout(), None);
    assert_eq!(v2.params.fixed_close_fee(), Some(50_000));
    assert_eq!(v2.params.expected_bob_payout(), Some(10_000_000 - 50_000));
}

#[test]
fn new_alice_contract_version_through_the_binary() {
    let dir = tempfile::tempdir().unwrap();
    // v2: the bundle carries it, status shows it and the fixed payout.
    let a2 = dir.path().join("a2.swap.json");
    let (ok, bundle, err) = run(&alice_args(&a2, Some("2")));
    assert!(ok, "{err}");
    assert!(bundle.contains("\"contract_version\": 2"), "{bundle}");
    assert!(err.contains("every close pays exactly 50000") && err.contains("--contract-version 2"), "{err}");
    let public: SwapPublic = serde_json::from_str(&bundle).unwrap();
    assert_eq!(public.params.contract_version, ContractVersion::V2);
    assert_eq!(SwapFile::load(&a2).unwrap().public.params.contract_version, ContractVersion::V2);
    let (ok, out, _) = run(&s(&["status", a2.to_str().unwrap()]));
    let v: Value = serde_json::from_str(&out).unwrap();
    assert!(ok && v["contract_version"] == 2 && v["fixed_close_fee_micronoid"] == 50_000 && v["expected_bob_payout_micronoid"] == 9_950_000, "{out}");
    // default and explicit 1: the bundle has no version field, and status says 1 without a fixed fee.
    let a1 = dir.path().join("a1.swap.json");
    let (ok, bundle, err) = run(&alice_args(&a1, None));
    assert!(ok, "{err}");
    assert!(!bundle.contains("contract_version"), "{bundle}");
    let (_, out, _) = run(&s(&["status", a1.to_str().unwrap()]));
    let v: Value = serde_json::from_str(&out).unwrap();
    assert!(v["contract_version"] == 1 && v.get("fixed_close_fee_micronoid").is_none(), "{out}");
    let a1b = dir.path().join("a1b.swap.json");
    let (ok, bundle, err) = run(&alice_args(&a1b, Some("1")));
    assert!(ok && !bundle.contains("contract_version"), "{err}");
    // Not a version.
    for bad in ["3", "0", "v2"] {
        let f = dir.path().join(format!("bad{bad}.swap.json"));
        let (ok, _, err) = run(&alice_args(&f, Some(bad)));
        assert!(!ok && err.contains("--contract-version"), "{bad:?}: {err}");
        assert!(!f.exists());
    }
}

#[test]
fn new_bob_refuses_a_contract_version_mismatch() {
    let dir = tempfile::tempdir().unwrap();
    let v2 = example_public_v(&Secret::generate().unwrap(), Variant::Raw, ContractVersion::V2);
    let v1 = example_public(&Secret::generate().unwrap(), Variant::Raw);
    let (b2, b1) = (dir.path().join("v2.json"), dir.path().join("v1.json"));
    std::fs::write(&b2, bundle_text::checked_text(&v2)).unwrap();
    std::fs::write(&b1, bundle_text::checked_text(&v1)).unwrap();
    // A v2 bundle with Bob's default (v1): refused, with both versions in the message.
    let out1 = dir.path().join("1.swap.json");
    let (ok, _, err) = run(&bob_args(&v2, &b2, &out1, None));
    assert!(!ok && err.contains("contract v2") && err.contains("v1") && err.contains("--contract-version"), "{err}");
    assert!(!out1.exists());
    // A v2 bundle with an explicit --contract-version 1: refused.
    let (ok, _, err) = run(&bob_args(&v2, &b2, &dir.path().join("1b.swap.json"), Some("1")));
    assert!(!ok && err.contains("--contract-version"), "{err}");
    // A v1 bundle with --contract-version 2: refused.
    let out2 = dir.path().join("2.swap.json");
    let (ok, _, err) = run(&bob_args(&v1, &b1, &out2, Some("2")));
    assert!(!ok && err.contains("contract v1") && err.contains("v2"), "{err}");
    assert!(!out2.exists());
    // Matching versions work, and the file keeps the version.
    let out3 = dir.path().join("3.swap.json");
    let (ok, _, err) = run(&bob_args(&v2, &b2, &out3, Some("2")));
    assert!(ok, "{err}");
    assert_eq!(SwapFile::load(&out3).unwrap().public.params.contract_version, ContractVersion::V2);
    let (ok, _, err) = run(&bob_args(&v1, &b1, &dir.path().join("4.swap.json"), Some("1")));
    assert!(ok, "{err}");
    let (ok, _, err) = run(&bob_args(&v1, &b1, &dir.path().join("5.swap.json"), None));
    assert!(ok, "{err}");
}

#[test]
fn new_bob_rebuilds_the_opening_from_the_matching_program() {
    // A v2 bundle whose opening is really the v1 program (a forged "v2" label on a v1 contract): the rebuild
    // with the v2 program differs, so even a Bob who asked for v2 refuses it.
    let secret = Secret::generate().unwrap();
    let v2 = example_public_v(&secret, Variant::Raw, ContractVersion::V2);
    let v1 = example_public_v(&secret, Variant::Raw, ContractVersion::V1);
    let mut forged = v2.clone();
    forged.opening_hex = v1.opening_hex.clone();
    forged.contract_root = v1.contract_root.clone();
    let terms = example_bob_terms(&forged);
    assert_eq!(terms.contract_version, ContractVersion::V2);
    let e = swap_cli::swapfile::example_bob_file(forged, 1).unwrap_err().to_string();
    assert!(e.contains("byte-for-byte") && e.contains("v2"), "{e}");
}

fn alice_file(dir: &Path, version: ContractVersion) -> (PathBuf, SwapPublic) {
    let secret = Secret::generate().unwrap();
    let public = example_public_v(&secret, Variant::Raw, version);
    let path = dir.join(format!("alice{version}.swap.json"));
    SwapFile::new_alice(public.clone(), &secret, &Passphrase::new(PASS), &KdfParams::fast_for_tests(), 1).unwrap().save(&path).unwrap();
    (path, public)
}

#[test]
fn alice_params_for_v2_writes_the_v2_definition_and_the_fee_flag() {
    let dir = tempfile::tempdir().unwrap();
    let (alice, public) = alice_file(dir.path(), ContractVersion::V2);
    let (def, params) = (dir.path().join("swap.def.json"), dir.path().join("swap.params.json"));
    let (ok, out, err) = run(&s(&["alice-params", alice.to_str().unwrap(), "--definition-out", def.to_str().unwrap(), "--params-out", params.to_str().unwrap()]));
    assert!(ok, "{err}");
    let v: Value = serde_json::from_str(&out).unwrap();
    assert_eq!(v["contract_version"], 2);
    assert_eq!(v["contract_source"], "parano1d/contracts/htlc_v2.pruv");
    assert!(v["contract"].as_str().unwrap().starts_with("HashTimeLockV2"), "{v}");
    assert_eq!(v["opening_hex"], public.opening_hex);
    assert_eq!(v["contract_root"], public.contract_root);
    assert_eq!(v["fixed_close_fee_micronoid"], 50_000);
    assert_eq!(v["expected_bob_payout_micronoid"], 9_950_000);
    assert!(v["fee_rule"].as_str().unwrap().contains("exactly max_fee"), "{v}");
    // The recovery close command tells the stock wallet the fixed fee.
    let call = v["commands"][6].as_str().unwrap();
    assert!(call.contains("--close --fee 0.050000 --preview"), "{call}");

    // The emitted definition is the v2 program: terminal; fee == max_fee.
    let emitted: Value = serde_json::from_str(&std::fs::read_to_string(&def).unwrap()).unwrap();
    let prog = emitted["definition"]["program"].as_array().unwrap();
    assert_eq!(prog.len(), 2, "{emitted}");
    assert_eq!((prog[1]["left"].as_str(), prog[1]["right"].as_str(), prog[1]["immediate"].as_str()), (Some("fee"), Some("immediate"), Some("50000")));
    // ... exactly what the harness' v2 compile of the params file gives, and the swap file's opening.
    let loaded = load_params_guarded(&params).unwrap();
    let (opening, definition) = htlc_harness::compile_htlc_v2_params(&loaded).unwrap();
    assert_eq!(emitted, definition);
    assert_eq!(hex::encode(opening.to_bytes().unwrap()), public.opening_hex);
    assert_eq!(opening.root().to_bech32(), public.contract_root);
    // The v1 compile of the same params file is a different contract.
    let (v1_opening, v1_definition) = htlc_harness::compile_htlc_params(&loaded).unwrap();
    assert_ne!(v1_opening, opening);
    assert_eq!(v1_definition["definition"]["program"].as_array().unwrap().len(), 1);

    // --check-object accepts the v2 object and refuses the v1 object built from the same parameters.
    let good = dir.path().join("good.object.json");
    std::fs::write(&good, serde_json::json!({"opening_hex": public.opening_hex, "address": public.contract_root}).to_string()).unwrap();
    let (ok, _, err) = run(&s(&["alice-params", alice.to_str().unwrap(), "--check-object", good.to_str().unwrap()]));
    assert!(ok && err.contains("object file OK"), "{err}");
    let wrong = dir.path().join("wrong.object.json");
    std::fs::write(
        &wrong,
        serde_json::json!({"opening_hex": hex::encode(v1_opening.to_bytes().unwrap()), "address": v1_opening.root().to_bech32()}).to_string(),
    )
    .unwrap();
    let (ok, _, err) = run(&s(&["alice-params", alice.to_str().unwrap(), "--check-object", wrong.to_str().unwrap()]));
    assert!(!ok && err.contains("MISMATCH") && err.contains("do NOT fund"), "{err}");
}

#[test]
fn alice_params_for_v1_is_unchanged() {
    let dir = tempfile::tempdir().unwrap();
    let (alice, public) = alice_file(dir.path(), ContractVersion::V1);
    let def = dir.path().join("swap.def.json");
    let (ok, out, err) = run(&s(&["alice-params", alice.to_str().unwrap(), "--definition-out", def.to_str().unwrap()]));
    assert!(ok, "{err}");
    let v: Value = serde_json::from_str(&out).unwrap();
    assert_eq!(v["contract_version"], 1);
    assert_eq!(v["contract_source"], "parano1d/contracts/htlc.pruv");
    assert!(v["contract"].as_str().unwrap().starts_with("HashTimeLock (parano1d/contracts/htlc.pruv)"), "{v}");
    assert!(v.get("fixed_close_fee_micronoid").is_none() && v.get("expected_bob_payout_micronoid").is_none());
    assert_eq!(v["opening_hex"], public.opening_hex);
    let call = v["commands"][6].as_str().unwrap();
    assert!(call.contains("--close --preview") && !call.contains("--fee"), "{call}");
    let emitted: Value = serde_json::from_str(&std::fs::read_to_string(&def).unwrap()).unwrap();
    assert_eq!(emitted["definition"]["program"].as_array().unwrap().len(), 1);
}

#[test]
fn the_harness_v2_compile_reproduces_the_committed_v2_definition() {
    // The same cross-check alice_params.rs does for v1: the example params through the v2 entry point give
    // exactly `parano1d/contracts/htlc_v2.definition.json` (the pruv build output of the v2 contract).
    let params = load_params_guarded(&contracts().join("htlc.params.example.json")).unwrap();
    let (_, definition) = htlc_harness::compile_htlc_v2_params(&params).unwrap();
    let committed: Value = serde_json::from_str(&std::fs::read_to_string(contracts().join("htlc_v2.definition.json")).unwrap()).unwrap();
    assert_eq!(definition, committed);
}

// ------------------------------------------------------------------------------------------
// The F_max rule by version (docs/htlc-v2-fixed-fee.md section 5): v1 = max(50,000, 3 x estimate); v2 =
// max(50,000, 5 x max(estimate, --floor-seen)); both at most 1 % of the amount.
// ------------------------------------------------------------------------------------------

/// `alice_args` with `--fee-estimate` / `--amount` replaced and extra flags appended.
fn fee_args(out: &Path, version: &str, estimate: &str, amount: &str, extra: &[&str]) -> Vec<String> {
    let mut a = alice_args(out, Some(version));
    for (flag, value) in [("--fee-estimate", estimate), ("--amount", amount)] {
        let i = a.iter().position(|x| x == flag).unwrap();
        a[i + 1] = value.to_string();
    }
    a.extend(s(extra));
    a
}

fn max_fee_of(bundle: &str) -> u64 {
    let v: Value = serde_json::from_str(bundle).unwrap();
    v["params"]["max_fee_micronoid"].as_u64().unwrap()
}

#[test]
fn new_alice_f_max_by_version_through_the_binary() {
    let dir = tempfile::tempdir().unwrap();
    let mut n = 0;
    let mut go = |version: &str, est: &str, amount: &str, extra: &[&str]| {
        n += 1;
        let f = dir.path().join(format!("f{n}.swap.json"));
        let r = run(&fee_args(&f, version, est, amount, extra));
        (r, f)
    };
    // v2 at an estimate of 12,000: 5 x 12,000 = 60,000.
    let ((ok, bundle, err), f) = go("2", "12000", "10000000", &[]);
    assert!(ok, "{err}");
    assert_eq!(max_fee_of(&bundle), 60_000);
    // The file passes check() on load, and Bob accepts that bundle (his T5 at lock time is the real guard).
    let loaded = SwapFile::load(&f).unwrap();
    assert_eq!(loaded.public.params.max_fee_micronoid, 60_000);
    loaded.public.check().unwrap();
    let public: SwapPublic = serde_json::from_str(&bundle).unwrap();
    let bundle_path = dir.path().join("bundle60.json");
    std::fs::write(&bundle_path, &bundle).unwrap();
    let (ok, _, err) = run(&bob_args(&public, &bundle_path, &dir.path().join("bob60.swap.json"), Some("2")));
    assert!(ok, "{err}");
    // v1 at the same estimate: 3 x 12,000 = 36,000 < 50,000, so 50,000.
    let ((ok, bundle, err), _) = go("1", "12000", "10000000", &[]);
    assert!(ok, "{err}");
    assert_eq!(max_fee_of(&bundle), 50_000);
    // --floor-seen 11,000 with an estimate of 5,800 under v2: 5 x 11,000 = 55,000.
    let ((ok, bundle, err), _) = go("2", "5800", "10000000", &["--floor-seen", "11000"]);
    assert!(ok, "{err}");
    assert_eq!(max_fee_of(&bundle), 55_000);
    // A floor-seen below the estimate changes nothing (the larger of the two counts).
    let ((ok, bundle, _), _) = go("2", "12000", "10000000", &["--floor-seen", "7000"]);
    assert!(ok);
    assert_eq!(max_fee_of(&bundle), 60_000);
    // Under v1 the flag is accepted, ignored, and said so on stderr.
    let ((ok, bundle, err), _) = go("1", "5800", "10000000", &["--floor-seen", "30000"]);
    assert!(ok, "{err}");
    assert_eq!(max_fee_of(&bundle), 50_000);
    assert!(err.contains("--floor-seen is ignored for contract v1"), "{err}");
    // v2, 5 NOID, floor 12,000: 60,000 > 1 % of 5,000,000, refused, and nothing is written.
    let ((ok, bundle, err), f) = go("2", "5800", "5000000", &["--floor-seen", "12000"]);
    assert!(!ok && bundle.is_empty() && err.contains("exceeds 1 % of the amount"), "{err}");
    assert!(!f.exists());
    // v2 with exactly 5 NOID and a quiet floor (50,000 = 1 %) is allowed.
    let ((ok, bundle, err), _) = go("2", "5800", "5000000", &[]);
    assert!(ok, "{err}");
    assert_eq!(max_fee_of(&bundle), 50_000);
    // A non-number floor is a usage error, nothing is written.
    let ((ok, _, err), f) = go("2", "5800", "10000000", &["--floor-seen", "abc"]);
    assert!(!ok && err.contains("--floor-seen"), "{err}");
    assert!(!f.exists());
}
