//! The rehearsal and sepolia profiles through the binary and the swap-file checks (ideas idea 3): `new-alice --profile
//! rehearsal|sepolia`, the caps, the bundle carrying the profile, `new-bob` refusing a profile mismatch, `gates --profile`.

use std::process::Command;

#[path = "common/equiv_stub.rs"]
mod equiv_stub;

use swap_cli::params::ProfileName;
use swap_cli::secret::{Secret, Variant};
use swap_cli::swapfile::{example_bob_terms, example_public, example_public_with, SwapFile, SwapPublic};

const CODE_HASH: &str = "0xa906117fc4e604bd25fcee2a6a41da8b824ec9b4a17d10137704e7da42545e2f";
const PASS: &str = "correct horse battery staple";

fn bin() -> Command {
    Command::new(env!("CARGO_BIN_EXE_swap-cli"))
}

fn run(args: &[String]) -> (bool, String, String) {
    let out = bin().args(args).env("SWAP_PASSPHRASE", PASS).output().expect("run swap-cli");
    (out.status.success(), String::from_utf8_lossy(&out.stdout).into_owned(), String::from_utf8_lossy(&out.stderr).into_owned())
}

fn s(v: &[&str]) -> Vec<String> {
    v.iter().map(|x| x.to_string()).collect()
}

/// `new-alice` arguments with every value overridable.
fn alice_args(out: &std::path::Path, profile: Option<&str>, amount: &str, wei: &str, chain: &str) -> Vec<String> {
    let cast = swap_cli::htlc_harness::Cast::new();
    let mut a = s(&["new-alice", "--out", out.to_str().unwrap()]);
    a.extend(s(&["--alice", &cast.alice.to_bech32(), "--bob", &cast.bob.to_bech32(), "--amount", amount, "--fee-estimate", "5800"]));
    a.extend(s(&["--h-create", "300000", "--eth-contract", "0x5fbdb2315678afecb367f032d93f642f64180aa3", "--eth-chain-id", chain]));
    a.extend(s(&["--eth-amount-wei", wei, "--eth-receiver", "0x3c44cdddb6a900fa2b585dd299e03d12fa4293bc"]));
    a.extend(s(&["--eth-sender", "0x70997970c51812dc3a010c7d01b50e0d17dc79c8", "--eth-code-hash", CODE_HASH, "--fast-kdf"]));
    if let Some(p) = profile {
        a.extend(s(&["--profile", p]));
    }
    a
}

#[test]
fn production_files_do_not_mention_the_profile_and_rehearsal_files_do() {
    let secret = Secret::generate().unwrap();
    let prod = example_public(&secret, Variant::Raw);
    let reh = example_public_with(&secret, Variant::Raw, ProfileName::Rehearsal);
    let (pj, rj) = (serde_json::to_string(&prod).unwrap(), serde_json::to_string(&reh).unwrap());
    // Production is byte-compatible with files written before profiles existed (same digest, same sealed secrets).
    assert!(!pj.contains("profile"), "{pj}");
    assert!(rj.contains("\"profile\":\"rehearsal\""), "{rj}");
    let back: SwapPublic = serde_json::from_str(&pj).unwrap();
    assert_eq!(back.params.profile, ProfileName::Production);
    assert_eq!(back.digest(), prod.digest());
    assert_ne!(prod.digest(), reh.digest());
    // The two share nothing but the secret: different deadline, lock-by, chain.
    assert_eq!(prod.params.deadline_height, 300_735);
    assert_eq!(reh.params.deadline_height, 300_120);
    assert_eq!(reh.params.lock_by_height, 300_052);
    assert_eq!(reh.params.eth.chain_id, 31_337);
}

#[test]
fn a_bundle_cannot_be_moved_between_profiles() {
    let secret = Secret::generate().unwrap();
    let reh = example_public_with(&secret, Variant::Raw, ProfileName::Rehearsal);
    reh.check().unwrap();
    // Relabel it production: D is no longer h_create + 735.
    let mut as_prod = reh.clone();
    as_prod.params.profile = ProfileName::Production;
    let e = as_prod.check().unwrap_err().to_string();
    assert!(e.contains("735"), "{e}");
    // Strip the profile field from the JSON (what an old tool would produce): the same result.
    let mut v: serde_json::Value = serde_json::to_value(&reh).unwrap();
    v["params"].as_object_mut().unwrap().remove("profile").unwrap();
    let stripped: SwapPublic = serde_json::from_value(v).unwrap();
    assert!(stripped.check().is_err());
    // And the other way: a production bundle relabelled rehearsal fails (D, lock-by, chain, caps).
    let prod = example_public(&secret, Variant::Raw);
    let mut as_reh = prod.clone();
    as_reh.params.profile = ProfileName::Rehearsal;
    assert!(as_reh.check().is_err());
}

#[test]
fn the_caps_are_enforced_when_the_file_is_built_and_when_it_is_checked() {
    let secret = Secret::generate().unwrap();
    let cast = swap_cli::htlc_harness::Cast::new();
    let base = example_public_with(&secret, Variant::Raw, ProfileName::Rehearsal);
    let build = |amount: u64, wei: u128, chain: u64| {
        let mut eth = base.params.eth.clone();
        eth.amount_wei = wei;
        eth.chain_id = chain;
        SwapPublic::build_with_profile(&secret, Variant::Raw, ProfileName::Rehearsal, &cast.alice, &cast.bob, amount, 5_800, 300_000, eth)
    };
    assert!(build(20_000_000, 10u128.pow(16), 31_337).is_ok());
    assert!(build(20_000_001, 10u128.pow(16), 31_337).unwrap_err().to_string().contains("micro-NOID"));
    assert!(build(10_000_000, 10u128.pow(16) + 1, 31_337).unwrap_err().to_string().contains("wei"));
    assert!(build(10_000_000, 10u128.pow(16), 11_155_111).unwrap_err().to_string().contains("chain id"));
    assert!(build(10_000_000, 10u128.pow(16), 1).unwrap_err().to_string().contains("chain id"));
    // A file edited by hand to carry more than the cap is refused by check() (and so by load and new-bob).
    let mut big = base.clone();
    big.params.eth.amount_wei = 10u128.pow(17);
    assert!(big.check().unwrap_err().to_string().contains("wei"));
    // Production has no caps.
    let mut eth = base.params.eth.clone();
    eth.chain_id = 1;
    eth.amount_wei = 10u128.pow(20);
    assert!(SwapPublic::build(&secret, Variant::Raw, &cast.alice, &cast.bob, 5_000_000_000, 5_800, 300_000, eth).is_ok());
}

#[test]
fn new_alice_profile_rehearsal_through_the_binary() {
    let dir = tempfile::tempdir().unwrap();
    let a = dir.path().join("a.swap.json");
    let (ok, bundle, err) = run(&alice_args(&a, Some("rehearsal"), "10000000", "10000000000000000", "31337"));
    assert!(ok, "{err}");
    let public: SwapPublic = serde_json::from_str(&bundle).unwrap();
    assert_eq!(public.params.profile, ProfileName::Rehearsal);
    assert_eq!(public.params.deadline_height, 300_120);
    assert!(bundle.contains("\"profile\": \"rehearsal\""));
    assert_eq!(SwapFile::load(&a).unwrap().public.params.profile, ProfileName::Rehearsal);
    // `status` shows it.
    let (ok, out, _) = run(&s(&["status", a.to_str().unwrap()]));
    assert!(ok && out.contains("\"profile\": \"rehearsal\""), "{out}");
    // The default is production, and says so.
    let d = dir.path().join("d.swap.json");
    let (ok, bundle, err) = run(&alice_args(&d, None, "10000000", "10000000000000000", "31337"));
    assert!(ok, "{err}");
    assert!(!bundle.contains("profile"));
    let (_, out, _) = run(&s(&["status", d.to_str().unwrap()]));
    assert!(out.contains("\"profile\": \"production\""), "{out}");
    // Refusals, each leaving no file behind.
    for (what, amount, wei, chain, needle) in [
        ("more than 20 NOID", "20000001", "10000000000000000", "31337", "micro-NOID"),
        ("more than 0.01 ETH", "10000000", "10000000000000001", "31337", "wei"),
        ("Sepolia", "10000000", "10000000000000000", "11155111", "chain id"),
        ("mainnet", "10000000", "10000000000000000", "1", "chain id"),
    ] {
        let f = dir.path().join(format!("{}.swap.json", what.replace(' ', "_")));
        let (ok, _, err) = run(&alice_args(&f, Some("rehearsal"), amount, wei, chain));
        assert!(!ok && err.contains(needle) && err.contains("rehearsal"), "{what}: {err}");
        assert!(!f.exists(), "{what}");
    }
    let f = dir.path().join("typo.swap.json");
    let (ok, _, err) = run(&alice_args(&f, Some("rehersal"), "10000000", "10000000000000000", "31337"));
    assert!(!ok && err.contains("unknown profile"), "{err}");
}

/// `new-bob` arguments from a bundle: the typed attestation for a rehearsal bundle, a stand-in verifier otherwise (REVIEW-3 F2).
fn bob_args(public: &SwapPublic, bundle: &std::path::Path, out: &std::path::Path, profile: Option<&str>) -> Vec<String> {
    let t = example_bob_terms(public);
    let p = &public.params;
    let mut a = s(&["new-bob", "--bundle", bundle.to_str().unwrap(), "--out", out.to_str().unwrap()]);
    a.extend(s(&["--bob", &t.bob_noid.to_bech32(), "--amount", &p.amount_micronoid.to_string()]));
    a.extend(s(&["--eth-chain-id", &p.eth.chain_id.to_string(), "--eth-contract", &format!("0x{}", hex::encode(p.eth.contract))]));
    a.extend(s(&["--eth-code-hash", &format!("0x{}", hex::encode(t.eth_code_hash)), "--eth-amount-wei", &p.eth.amount_wei.to_string()]));
    a.extend(s(&["--eth-sender", &format!("0x{}", hex::encode(p.eth.bob_sender))]));
    if public.params.profile == ProfileName::Rehearsal {
        // The typed form is accepted under the rehearsal profile only (REVIEW-3 F2).
        let h = format!("0x{}", hex::encode(public.hashlock));
        a.extend(s(&["--equiv-h", &h, "--equiv-a", &public.claim_authority, "--equiv-image-id", &hex::encode(swap_cli::params::EQUIV_IMAGE_ID)]));
    } else {
        // production and sepolia: the receipt goes through a stand-in `equiv-prove`.
        a.extend(equiv_stub::receipt_flags(out.parent().unwrap()));
    }
    // One hashlock registry per output file: the same bundle is tried several times.
    a.extend(s(&["--registry", out.with_extension("registry").to_str().unwrap()]));
    if let Some(profile) = profile {
        a.extend(s(&["--profile", profile]));
    }
    a
}


/// `bob_args` with the typed form (`--equiv-h/-a/-image-id`) in place of the receipt flags.
fn typed_bob_args(public: &SwapPublic, bundle: &std::path::Path, out: &std::path::Path, profile: Option<&str>) -> Vec<String> {
    let mut a = bob_args(public, bundle, out, profile);
    if let Some(i) = a.iter().position(|x| x == "--receipt") {
        a.drain(i..i + 4);
        let h = format!("0x{}", hex::encode(public.hashlock));
        a.extend(s(&["--equiv-h", &h, "--equiv-a", &public.claim_authority, "--equiv-image-id", &hex::encode(swap_cli::params::EQUIV_IMAGE_ID)]));
    }
    a
}

#[test]
fn the_typed_attestation_is_rehearsal_only_and_the_image_id_pin_is_a_constant() {
    // REVIEW-3 F2.
    let dir = tempfile::tempdir().unwrap();
    for (name, profile) in [("production", ProfileName::Production), ("sepolia", ProfileName::Sepolia), ("rehearsal", ProfileName::Rehearsal)] {
        let public = example_public_with(&Secret::generate().unwrap(), Variant::Raw, profile);
        let bundle = dir.path().join(format!("{name}.json"));
        std::fs::write(&bundle, serde_json::to_string_pretty(&public).unwrap()).unwrap();
        let out = dir.path().join(format!("{name}-typed.swap.json"));
        let (ok, _, err) = run(&typed_bob_args(&public, &bundle, &out, Some(name)));
        if profile == ProfileName::Rehearsal {
            assert!(ok, "{err}");
            assert!(out.exists());
        } else {
            assert!(!ok && err.contains("accepted only under the rehearsal profile") && err.contains(name) && err.contains("--receipt"), "{name}: {err}");
            assert!(!out.exists(), "{name}: nothing may be written");
        }
        // --pinned-image-id: the compiled-in value is accepted, any other is refused and nothing is written.
        let id = hex::encode(swap_cli::params::EQUIV_IMAGE_ID);
        let mut good = bob_args(&public, &bundle, &dir.path().join(format!("{name}-pin.swap.json")), Some(name));
        good.extend(s(&["--pinned-image-id", &id]));
        let (ok, _, err) = run(&good);
        assert!(ok, "{name}: {err}");
        let bad_out = dir.path().join(format!("{name}-badpin.swap.json"));
        let mut bad = bob_args(&public, &bundle, &bad_out, Some(name));
        bad.extend(s(&["--pinned-image-id", &"11".repeat(32)]));
        let (ok, _, err) = run(&bad);
        assert!(!ok && err.contains("--pinned-image-id") && err.contains(&id), "{name}: {err}");
        assert!(!bad_out.exists(), "{name}");
    }
}
#[test]
fn new_bob_refuses_a_profile_mismatch() {
    let dir = tempfile::tempdir().unwrap();
    let secret = Secret::generate().unwrap();
    let reh = example_public_with(&secret, Variant::Raw, ProfileName::Rehearsal);
    let prod = example_public(&Secret::generate().unwrap(), Variant::Raw);
    let (rb, pb) = (dir.path().join("reh.json"), dir.path().join("prod.json"));
    std::fs::write(&rb, serde_json::to_string_pretty(&reh).unwrap()).unwrap();
    std::fs::write(&pb, serde_json::to_string_pretty(&prod).unwrap()).unwrap();
    // A rehearsal bundle with Bob's default (production): refused, with both names in the message.
    let (ok, _, err) = run(&bob_args(&reh, &rb, &dir.path().join("1.swap.json"), None));
    assert!(!ok && err.contains("rehearsal") && err.contains("production") && err.contains("--profile"), "{err}");
    assert!(!dir.path().join("1.swap.json").exists());
    // A production bundle with --profile rehearsal: refused.
    let (ok, _, err) = run(&bob_args(&prod, &pb, &dir.path().join("2.swap.json"), Some("rehearsal")));
    assert!(!ok && err.contains("production") && err.contains("rehearsal"), "{err}");
    assert!(!dir.path().join("2.swap.json").exists());
    // Matching profiles work, and the file keeps the profile.
    let (ok, _, err) = run(&bob_args(&reh, &rb, &dir.path().join("3.swap.json"), Some("rehearsal")));
    assert!(ok, "{err}");
    assert_eq!(SwapFile::load(&dir.path().join("3.swap.json")).unwrap().public.params.profile, ProfileName::Rehearsal);
    let (ok, _, err) = run(&bob_args(&prod, &pb, &dir.path().join("4.swap.json"), Some("production")));
    assert!(ok, "{err}");
    let (ok, _, err) = run(&bob_args(&prod, &pb, &dir.path().join("5.swap.json"), None));
    assert!(ok, "{err}");
}

#[test]
fn gates_prints_the_rehearsal_numbers() {
    // Funding final at 300,022, Bob locks at 300,030, D = 300,120.
    let (ok, out, err) = run(&s(&[
        "gates", "--profile", "rehearsal", "--d", "300120", "--h-now", "300030", "--t-now", "1794312000", "--h-final", "300022",
    ]));
    assert!(ok, "{err}");
    let v: serde_json::Value = serde_json::from_str(&out).unwrap();
    assert_eq!(v["profile"], "rehearsal");
    assert_eq!(v["d_offset"], 120);
    assert_eq!(v["rhs_i1_full_window"], 68);
    assert_eq!(v["lock_by_full_window"], 300_052);
    assert_eq!(v["lock_by_min_window"], 300_058);
    assert_eq!(v["t_reveal"], "1794312600");
    assert_eq!(v["reveal_cutoff"], 1_794_312_300u64);
    assert_eq!(v["claim_target_height"], 300_102);
    // The default is unchanged (no profile key for production).
    let (ok, out, _) = run(&s(&["gates", "--d", "300735", "--h-now", "300040", "--t-now", "1794312000", "--h-final", "300022"]));
    assert!(ok);
    let v: serde_json::Value = serde_json::from_str(&out).unwrap();
    assert!(v.get("profile").is_none());
    assert_eq!(v["rhs_i1_full_window"], 629);
    let (ok, _, err) = run(&s(&["gates", "--profile", "nope", "--d", "1", "--h-now", "1", "--t-now", "1"]));
    assert!(!ok && err.contains("unknown profile"), "{err}");
}

// ---------------------------------------------------------------- the sepolia profile

#[test]
fn sepolia_files_mention_the_profile_and_carry_its_numbers() {
    let secret = Secret::generate().unwrap();
    let sep = example_public_with(&secret, Variant::Raw, ProfileName::Sepolia);
    let reh = example_public_with(&secret, Variant::Raw, ProfileName::Rehearsal);
    let prod = example_public(&secret, Variant::Raw);
    let sj = serde_json::to_string(&sep).unwrap();
    assert!(sj.contains("\"profile\":\"sepolia\""), "{sj}");
    sep.check().unwrap();
    let back: SwapPublic = serde_json::from_str(&sj).unwrap();
    assert_eq!(back.params.profile, ProfileName::Sepolia);
    assert_eq!(back.digest(), sep.digest());
    assert_ne!(sep.digest(), reh.digest());
    assert_ne!(sep.digest(), prod.digest());
    // D_offset 300, lock-by D - 251, W_A 4,200 s, and the only chain the profile allows.
    assert_eq!(sep.params.deadline_height, 300_300);
    assert_eq!(sep.params.lock_by_height, 300_300 - 251);
    assert_eq!(sep.params.w_a_s, 4_200);
    assert_eq!(sep.params.eth.chain_id, 11_155_111);
    // A sepolia bundle cannot be relabelled rehearsal or production: D, lock-by and (for rehearsal) the chain disagree.
    for other in [ProfileName::Rehearsal, ProfileName::Production] {
        let mut moved = sep.clone();
        moved.params.profile = other;
        assert!(moved.check().is_err(), "relabelled {other}");
    }
    // And the other way round: a rehearsal or production bundle relabelled sepolia fails.
    for from in [&reh, &prod] {
        let mut moved = from.clone();
        moved.params.profile = ProfileName::Sepolia;
        assert!(moved.check().is_err());
    }
}

#[test]
fn the_sepolia_caps_are_enforced_when_the_file_is_built_and_when_it_is_checked() {
    let secret = Secret::generate().unwrap();
    let cast = swap_cli::htlc_harness::Cast::new();
    let base = example_public_with(&secret, Variant::Raw, ProfileName::Sepolia);
    let build = |amount: u64, wei: u128, chain: u64| {
        let mut eth = base.params.eth.clone();
        eth.amount_wei = wei;
        eth.chain_id = chain;
        SwapPublic::build_with_profile(&secret, Variant::Raw, ProfileName::Sepolia, &cast.alice, &cast.bob, amount, 5_800, 300_000, eth)
    };
    assert!(build(20_000_000, 10u128.pow(16), 11_155_111).is_ok());
    assert!(build(20_000_001, 10u128.pow(16), 11_155_111).unwrap_err().to_string().contains("micro-NOID"));
    assert!(build(10_000_000, 10u128.pow(16) + 1, 11_155_111).unwrap_err().to_string().contains("wei"));
    assert!(build(10_000_000, 10u128.pow(16), 31_337).unwrap_err().to_string().contains("chain id"));
    assert!(build(10_000_000, 10u128.pow(16), 1).unwrap_err().to_string().contains("chain id"));
    // A file edited by hand to carry more than the cap, or another chain, is refused by check().
    let mut big = base.clone();
    big.params.eth.amount_wei = 10u128.pow(17);
    assert!(big.check().unwrap_err().to_string().contains("wei"));
    let mut local = base.clone();
    local.params.eth.chain_id = 31_337;
    assert!(local.check().unwrap_err().to_string().contains("chain id"));
}

#[test]
fn new_alice_profile_sepolia_through_the_binary() {
    let dir = tempfile::tempdir().unwrap();
    let a = dir.path().join("a.swap.json");
    let (ok, bundle, err) = run(&alice_args(&a, Some("sepolia"), "10000000", "10000000000000000", "11155111"));
    assert!(ok, "{err}");
    let public: SwapPublic = serde_json::from_str(&bundle).unwrap();
    assert_eq!(public.params.profile, ProfileName::Sepolia);
    assert_eq!(public.params.deadline_height, 300_300);
    assert_eq!(public.params.lock_by_height, 300_049);
    assert!(bundle.contains("\"profile\": \"sepolia\""));
    assert_eq!(SwapFile::load(&a).unwrap().public.params.profile, ProfileName::Sepolia);
    let (ok, out, _) = run(&s(&["status", a.to_str().unwrap()]));
    assert!(ok && out.contains("\"profile\": \"sepolia\""), "{out}");
    // Refusals, each leaving no file behind (the message names the profile).
    for (what, profile, amount, wei, chain, needle) in [
        ("25 NOID under sepolia", "sepolia", "25000000", "10000000000000000", "11155111", "micro-NOID"),
        ("more than 0.01 ETH under sepolia", "sepolia", "10000000", "10000000000000001", "11155111", "wei"),
        ("local chain under sepolia", "sepolia", "10000000", "10000000000000000", "31337", "chain id"),
        ("mainnet under sepolia", "sepolia", "10000000", "10000000000000000", "1", "chain id"),
        ("Sepolia under rehearsal", "rehearsal", "10000000", "10000000000000000", "11155111", "chain id"),
    ] {
        let f = dir.path().join(format!("{}.swap.json", what.replace(' ', "_")));
        let (ok, _, err) = run(&alice_args(&f, Some(profile), amount, wei, chain));
        assert!(!ok && err.contains(needle) && err.contains(profile), "{what}: {err}");
        assert!(!f.exists(), "{what}");
    }
    // The error for an unknown profile now lists all three.
    let f = dir.path().join("typo.swap.json");
    let (ok, _, err) = run(&alice_args(&f, Some("sepoila"), "10000000", "10000000000000000", "11155111"));
    assert!(!ok && err.contains("unknown profile") && err.contains("sepolia") && err.contains("rehearsal") && err.contains("production"), "{err}");
}

#[test]
fn new_bob_refuses_a_sepolia_bundle_under_another_profile_and_vice_versa() {
    let dir = tempfile::tempdir().unwrap();
    let sep = example_public_with(&Secret::generate().unwrap(), Variant::Raw, ProfileName::Sepolia);
    let reh = example_public_with(&Secret::generate().unwrap(), Variant::Raw, ProfileName::Rehearsal);
    let (sb, rb) = (dir.path().join("sep.json"), dir.path().join("reh.json"));
    std::fs::write(&sb, serde_json::to_string_pretty(&sep).unwrap()).unwrap();
    std::fs::write(&rb, serde_json::to_string_pretty(&reh).unwrap()).unwrap();
    // A sepolia bundle with --profile rehearsal, then with Bob's default (production): refused, both names in the message.
    let (ok, _, err) = run(&bob_args(&sep, &sb, &dir.path().join("1.swap.json"), Some("rehearsal")));
    assert!(!ok && err.contains("sepolia") && err.contains("rehearsal"), "{err}");
    let (ok, _, err) = run(&bob_args(&sep, &sb, &dir.path().join("2.swap.json"), None));
    assert!(!ok && err.contains("sepolia") && err.contains("production") && err.contains("--profile"), "{err}");
    // A rehearsal bundle with --profile sepolia: refused.
    let (ok, _, err) = run(&bob_args(&reh, &rb, &dir.path().join("3.swap.json"), Some("sepolia")));
    assert!(!ok && err.contains("rehearsal") && err.contains("sepolia"), "{err}");
    for n in ["1", "2", "3"] {
        assert!(!dir.path().join(format!("{n}.swap.json")).exists());
    }
    // Matching profiles work, and the file keeps the profile.
    let (ok, _, err) = run(&bob_args(&sep, &sb, &dir.path().join("4.swap.json"), Some("sepolia")));
    assert!(ok, "{err}");
    assert_eq!(SwapFile::load(&dir.path().join("4.swap.json")).unwrap().public.params.profile, ProfileName::Sepolia);
}

#[test]
fn gates_prints_the_sepolia_numbers() {
    let (ok, out, err) = run(&s(&["gates", "--profile", "sepolia", "--d", "1000", "--h-now", "700", "--t-now", "1700000000"]));
    assert!(ok, "{err}");
    let v: serde_json::Value = serde_json::from_str(&out).unwrap();
    assert_eq!(v["profile"], "sepolia");
    assert_eq!(v["d_offset"], 300);
    assert_eq!(v["rhs_i1_full_window"], 251);
    assert_eq!(v["lock_by_full_window"], 1_000 - 251);
    assert_eq!(v["lock_by_min_window"], 1_000 - 209);
    assert_eq!(v["t_reveal"], "1700004200");
    assert_eq!(v["reveal_cutoff"], 1_700_002_400u64);
    assert_eq!(v["claim_target_height"], 982);
    // A funding-final height that is too old for B_bob (20) is refused under sepolia too.
    let (ok, out, _) = run(&s(&["gates", "--profile", "sepolia", "--d", "1000", "--h-now", "700", "--t-now", "1700000000", "--h-final", "670"]));
    assert!(ok);
    let v: serde_json::Value = serde_json::from_str(&out).unwrap();
    assert!(v["t_reveal"].as_str().unwrap().contains("B_bob"), "{v}");
}
