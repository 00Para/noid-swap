//! The carrier check of the bundle (`bundle_check`) through the binary: `new-alice` and `bundle` write it and print the line both
//! machines compare, `new-bob` verifies it before anything else and refuses a bundle damaged in transit.

use std::process::Command;

#[path = "common/bundle_text.rs"]
mod bundle_text;
#[path = "common/equiv_stub.rs"]
mod equiv_stub;
#[path = "common/home.rs"]
mod home;

use serde_json::Value;

const CODE_HASH: &str = "0xa906117fc4e604bd25fcee2a6a41da8b824ec9b4a17d10137704e7da42545e2f";
const PASS: &str = "correct horse battery staple";

fn bin() -> Command {
    home::isolated_bin()
}

fn run(cmd: &mut Command) -> (bool, String, String) {
    let out = cmd.output().expect("run swap-cli");
    (out.status.success(), String::from_utf8_lossy(&out.stdout).into_owned(), String::from_utf8_lossy(&out.stderr).into_owned())
}

struct Fixture {
    dir: tempfile::TempDir,
    cast: swap_cli::htlc_harness::Cast,
    alice_file: std::path::PathBuf,
    bundle_text: String,
    alice_err: String,
    stub: Vec<String>,
}

fn fixture() -> Fixture {
    let dir = tempfile::tempdir().unwrap();
    let cast = swap_cli::htlc_harness::Cast::new();
    let alice_file = dir.path().join("a.swap.json");
    let (ok, bundle_text, alice_err) = run(bin()
        .args(["new-alice", "--out", alice_file.to_str().unwrap(), "--alice", &cast.alice.to_bech32(), "--bob", &cast.bob.to_bech32()])
        .args(["--amount", "10000000", "--fee-estimate", "5800", "--h-create", "300000", "--eth-chain-id", "31337"])
        .args(["--eth-contract", "0x5fbdb2315678afecb367f032d93f642f64180aa3", "--eth-amount-wei", "10000000000000000"])
        .args(["--eth-receiver", "0x3c44cdddb6a900fa2b585dd299e03d12fa4293bc", "--eth-sender", "0x70997970c51812dc3a010c7d01b50e0d17dc79c8"])
        .args(["--eth-code-hash", CODE_HASH, "--fast-kdf"])
        .env("SWAP_PASSPHRASE", PASS));
    assert!(ok, "{alice_err}");
    let stub = equiv_stub::receipt_flags(dir.path());
    Fixture { dir, cast, alice_file, bundle_text, alice_err, stub }
}

impl Fixture {
    /// `new-bob` on the given bundle text; the file names are unique per call.
    fn new_bob(&self, name: &str, text: &str, extra: &[&str]) -> (bool, String, String, std::path::PathBuf) {
        let bundle = self.dir.path().join(format!("{name}.bundle.json"));
        std::fs::write(&bundle, text).unwrap();
        let out = self.dir.path().join(format!("{name}.swap.json"));
        let mut cmd = bin();
        cmd.args(["new-bob", "--bundle", bundle.to_str().unwrap(), "--out", out.to_str().unwrap(), "--bob", &self.cast.bob.to_bech32()])
            .args(["--amount", "10000000", "--eth-chain-id", "31337", "--eth-contract", "0x5fbdb2315678afecb367f032d93f642f64180aa3"])
            .args(["--eth-amount-wei", "10000000000000000", "--eth-sender", "0x70997970c51812dc3a010c7d01b50e0d17dc79c8"])
            .args(["--eth-code-hash", CODE_HASH])
            .args(["--registry", self.dir.path().join(format!("{name}.registry")).to_str().unwrap()])
            .args(&self.stub)
            .args(extra);
        let (ok, stdout, stderr) = run(&mut cmd);
        (ok, stdout, stderr, out)
    }

    fn opening(&self) -> String {
        serde_json::from_str::<Value>(&self.bundle_text).unwrap()["opening_hex"].as_str().unwrap().to_string()
    }
}

fn check_line(stderr: &str, prefix: &str) -> String {
    stderr.lines().find(|l| l.starts_with(prefix)).unwrap_or_else(|| panic!("no `{prefix}` line in: {stderr}")).to_string()
}

#[test]
fn new_alice_writes_the_check_and_both_sides_print_the_same_line() {
    let f = fixture();
    let v: Value = serde_json::from_str(&f.bundle_text).unwrap();
    let check = &v["bundle_check"];
    assert_eq!(check["v"], 1);
    assert_eq!(check["sha256"].as_str().unwrap().len(), 64);
    assert_eq!(check["opening_hex_len"].as_u64().unwrap() as usize, f.opening().len());
    let sha = check["sha256"].as_str().unwrap();
    let line = check_line(&f.alice_err, "bundle check: ");
    assert_eq!(line, format!("bundle check: {} (opening_hex {} characters)", &sha[..16], f.opening().len()));
    // `bundle FILE` re-prints the same bundle from Alice's swap file with the same check and the same line.
    let (ok, again, err) = run(bin().args(["bundle", f.alice_file.to_str().unwrap()]));
    assert!(ok, "{err}");
    assert_eq!(serde_json::from_str::<Value>(&again).unwrap(), v);
    assert_eq!(check_line(&err, "bundle check: "), line);
    // `alice-params` prints it as well.
    let (ok, _, err) = run(bin().args(["alice-params", f.alice_file.to_str().unwrap()]));
    assert!(ok, "{err}");
    assert_eq!(check_line(&err, "bundle check: "), line);
    // Bob's tool prints the digest and `ok`; the swap file does not embed the check.
    let (ok, _, err, out) = f.new_bob("ok", &f.bundle_text, &[]);
    assert!(ok, "{err}");
    assert_eq!(check_line(&err, "bundle check: "), format!("bundle check: {} ok", &sha[..16]));
    assert!(!std::fs::read_to_string(out).unwrap().contains("bundle_check"));
}

#[test]
fn a_damaged_bundle_is_refused_before_anything_else_and_nothing_is_written() {
    let f = fixture();
    let opening = f.opening();
    let n = opening.len();
    let zero_run = opening.find("0000000000").expect("a long zero run in the opening");
    let first = opening.chars().find(|c| *c != 'f').unwrap();
    let cases: Vec<(&str, String, Option<String>)> = vec![
        ("flipped", f.bundle_text.replacen(&opening, &opening.replacen(first, "f", 1), 1), None),
        (
            "zeros",
            f.bundle_text.replacen(&opening, &format!("{}000{}", &opening[..zero_run], &opening[zero_run..]), 1),
            Some(format!("opening_hex has {} characters, the bundle says {n}", n + 3)),
        ),
        (
            "lost",
            f.bundle_text.replacen(&opening, &format!("{}{}", &opening[..zero_run], &opening[zero_run + 3..]), 1),
            Some(format!("opening_hex has {} characters, the bundle says {n}", n - 3)),
        ),
        ("param", f.bundle_text.replacen("\"deadline_height\": 300735", "\"deadline_height\": 300736", 1), None),
    ];
    for (name, text, length_line) in cases {
        assert_ne!(text, f.bundle_text, "{name}");
        let (ok, stdout, err, out) = f.new_bob(name, &text, &[]);
        assert!(!ok && stdout.is_empty(), "{name}: {err}");
        assert!(err.contains("damaged in transit") && err.contains("as a file"), "{name}: {err}");
        match length_line {
            Some(l) => assert!(err.contains(&l), "{name}: {err}"),
            None => assert!(!err.contains("opening_hex has"), "{name}: {err}"),
        }
        // Refused first: none of the later checks spoke, and no file and no registry entry exist.
        assert!(!err.contains("byte-for-byte") && !err.contains("equiv"), "{name}: {err}");
        assert!(!out.exists() && !f.dir.path().join(format!("{name}.registry")).exists(), "{name}");
    }
}

#[test]
fn other_whitespace_and_key_order_are_accepted() {
    let f = fixture();
    let v: Value = serde_json::from_str(&f.bundle_text).unwrap();
    let compact = serde_json::to_string(&v).unwrap();
    assert_ne!(compact, f.bundle_text);
    let (ok, _, err, _) = f.new_bob("compact", &compact, &[]);
    assert!(ok, "{err}");
    // The top-level keys in the opposite order, CRLF line ends.
    let Value::Object(map) = &v else { panic!() };
    let mut keys: Vec<&String> = map.keys().collect();
    keys.sort();
    keys.reverse();
    let body: Vec<String> = keys.iter().map(|k| format!("  {:?}: {}", k, serde_json::to_string_pretty(&map[*k]).unwrap())).collect();
    let reordered = format!("{{\r\n{}\r\n}}\r\n", body.join(",\r\n"));
    let (ok, _, err, _) = f.new_bob("reordered", &reordered, &[]);
    assert!(ok, "{err}");
}

#[test]
fn a_bundle_without_the_check_needs_the_flag_and_the_other_checks_still_run() {
    let f = fixture();
    let mut v: Value = serde_json::from_str(&f.bundle_text).unwrap();
    v.as_object_mut().unwrap().remove("bundle_check");
    let old = serde_json::to_string_pretty(&v).unwrap();
    let (ok, stdout, err, out) = f.new_bob("old", &old, &[]);
    assert!(!ok && stdout.is_empty() && err.contains("--allow-unchecked-bundle"), "{err}");
    assert!(!out.exists());
    let (ok, _, err, out) = f.new_bob("old-flag", &old, &["--allow-unchecked-bundle"]);
    assert!(ok, "{err}");
    assert!(err.contains("warning: this bundle carries no bundle_check"), "{err}");
    assert!(out.exists());
    // With the flag the opening rebuild still refuses a tampered old-style bundle.
    let tampered = old.replacen("\"max_fee_micronoid\": 50000", "\"max_fee_micronoid\": 60000", 1);
    assert_ne!(tampered, old);
    let (ok, _, err, _) = f.new_bob("old-tampered", &tampered, &["--allow-unchecked-bundle"]);
    assert!(!ok && err.contains("byte-for-byte"), "{err}");
    // The flag does not excuse a check that is present and wrong.
    let wrong = f.bundle_text.replacen("\"deadline_height\": 300735", "\"deadline_height\": 300736", 1);
    let (ok, _, err, _) = f.new_bob("wrong-flag", &wrong, &["--allow-unchecked-bundle"]);
    assert!(!ok && err.contains("damaged in transit"), "{err}");
}

#[test]
fn another_check_version_is_refused() {
    let f = fixture();
    let two = f.bundle_text.replacen("\"v\": 1", "\"v\": 2", 1);
    assert_ne!(two, f.bundle_text);
    let (ok, _, err, out) = f.new_bob("v2", &two, &["--allow-unchecked-bundle"]);
    assert!(!ok && err.contains("v 2") && err.contains("reads v 1 only"), "{err}");
    assert!(!out.exists());
}

#[test]
fn a_resealed_bundle_reaches_the_later_checks() {
    // The test helper that recomputes the check (used by tests that tamper on purpose) produces what the verifier accepts,
    // so the opening rebuild is what refuses the changed fee cap.
    let f = fixture();
    let tampered = bundle_text::reseal(&f.bundle_text.replacen("\"max_fee_micronoid\": 50000", "\"max_fee_micronoid\": 60000", 1));
    let (ok, _, err, _) = f.new_bob("resealed", &tampered, &[]);
    assert!(!ok && err.contains("byte-for-byte") && err.contains("bundle check: "), "{err}");
}
