//! REVIEW-2 F2: `new-bob --receipt PATH --equiv-prove BIN` runs the verifier itself.
//!
//! Two layers. The library layer fakes the subprocess through `CommandRunner` (success, non-zero exit,
//! wrong image id, H/A in the output not matching the bundle, BIN missing). The binary layer runs the
//! real `swap-cli new-bob` against a tiny shell script standing in for `equiv-prove` (unix only).

use std::cell::RefCell;
use std::path::{Path, PathBuf};

use swap_cli::client::stock::{CommandRunner, Step, StepOutput, StockError};
use swap_cli::params::{ProfileName, EQUIV_IMAGE_ID};
use swap_cli::equiv::{parse_verify_output, verify_receipt, EquivError, ProcessRunner, VerifyRequest};
use swap_cli::secret::{sha256, Secret, Variant};
use swap_cli::swapfile::{example_bob_terms, example_public, example_public_with, AttestationSource, SwapFile, SwapPublic};

/// The image id compiled into the tool (REVIEW-3 F2).
const IMAGE: [u8; 32] = EQUIV_IMAGE_ID;

fn public(variant: Variant) -> SwapPublic {
    example_public(&Secret::generate().unwrap(), variant)
}

fn ok_text(variant: Variant, image: &[u8; 32]) -> String {
    let addr = match variant {
        Variant::Raw => "Addr(m)",
        Variant::Stock => "Addr(Derive(m,0))",
    };
    format!("OK: exists m with sha256(m) = H and {addr} = A\nimage id: {}\n", hex::encode(image))
}

/// Records the steps it was given and answers with a canned result.
struct Fake {
    seen: RefCell<Vec<Step>>,
    answer: Result<StepOutput, StockError>,
}

impl Fake {
    fn says(stdout: String) -> Self {
        Self { seen: RefCell::new(Vec::new()), answer: Ok(StepOutput::Verified { stdout }) }
    }
    fn fails(detail: &str) -> Self {
        Self { seen: RefCell::new(Vec::new()), answer: Err(StockError::Command { step: "equiv_verify".into(), detail: detail.into() }) }
    }
}

impl CommandRunner for Fake {
    fn run(&mut self, step: &Step) -> Result<StepOutput, StockError> {
        self.seen.borrow_mut().push(step.clone());
        self.answer.clone()
    }
}

fn receipt_file(dir: &Path) -> PathBuf {
    let p = dir.join("swap.receipt");
    std::fs::write(&p, b"not a real receipt: the verifier is faked").unwrap();
    p
}

fn request<'a>(bin: &'a Path, variant: Variant, receipt: &'a Path) -> VerifyRequest<'a> {
    VerifyRequest { bin, variant, receipt }
}

#[test]
fn success_passes_h_and_a_from_the_bundle_and_records_a_receipt_attestation() {
    let dir = tempfile::tempdir().unwrap();
    let rc = receipt_file(dir.path());
    for variant in [Variant::Raw, Variant::Stock] {
        let p = public(variant);
        let mut fake = Fake::says(ok_text(variant, &IMAGE));
        let att = verify_receipt(&mut fake, &p, &request(Path::new("/opt/equiv-prove"), variant, &rc), 1_794_312_000).unwrap();
        // The verifier was asked about THIS bundle's H and A, not about anything typed.
        let seen = fake.seen.borrow();
        assert_eq!(seen.len(), 1);
        match &seen[0] {
            Step::EquivVerify { variant: v, h, a, receipt, .. } => {
                assert_eq!(*v, variant);
                assert_eq!(*h, p.hashlock);
                assert_eq!(*a, p.authority().unwrap().0);
                assert_eq!(receipt, &rc);
            }
            other => panic!("{other:?}"),
        }
        let argv = seen[0].argv().unwrap();
        assert_eq!(argv[1..4], ["verify".to_string(), variant.to_string(), hex::encode(p.hashlock)]);
        assert_eq!(argv[4], hex::encode(p.authority().unwrap().0));
        // The attestation is a `receipt` one and passes the swap file's own check.
        assert_eq!(att.source, AttestationSource::Receipt);
        assert_eq!(att.image_id, IMAGE);
        assert_eq!(att.pinned_image_id, IMAGE);
        assert_eq!(att.receipt_path.as_deref(), Some(rc.to_str().unwrap()));
        assert_eq!(att.receipt_sha256, Some(sha256(&std::fs::read(&rc).unwrap())));
        assert_eq!(att.verified_at, Some(1_794_312_000));
        assert_eq!(att.journal.as_slice(), p.expected_equivalence_journal().unwrap().as_slice());
        att.check(&p).unwrap();
        // ... and Bob's file can be built from it.
        let file = SwapFile::new_bob(p.clone(), &example_bob_terms(&p), &att, 5).unwrap();
        assert_eq!(file.equivalence.as_ref().unwrap().source, AttestationSource::Receipt);
    }
}

#[test]
fn a_receipt_attestation_survives_a_save_and_load() {
    let dir = tempfile::tempdir().unwrap();
    let rc = receipt_file(dir.path());
    let p = public(Variant::Raw);
    let att = verify_receipt(&mut Fake::says(ok_text(Variant::Raw, &IMAGE)), &p, &request(Path::new("equiv-prove"), Variant::Raw, &rc), 9).unwrap();
    let file = SwapFile::new_bob(p.clone(), &example_bob_terms(&p), &att, 5).unwrap();
    let path = dir.path().join("bob.swap.json");
    file.save(&path).unwrap();
    let text = std::fs::read_to_string(&path).unwrap();
    assert!(text.contains("\"source\": \"receipt\"") && text.contains("receipt_path") && text.contains("verified_at"), "{text}");
    assert_eq!(SwapFile::load(&path).unwrap().equivalence, Some(att));
}

#[test]
fn a_non_zero_exit_is_a_refusal() {
    let dir = tempfile::tempdir().unwrap();
    let rc = receipt_file(dir.path());
    let p = public(Variant::Raw);
    let mut fake = Fake::fails("/opt/equiv-prove returned exit status 1: INVALID: receipt does not verify");
    let err = verify_receipt(&mut fake, &p, &request(Path::new("/opt/equiv-prove"), Variant::Raw, &rc), 1).unwrap_err();
    assert!(matches!(&err, EquivError::Verifier(d) if d.contains("INVALID")), "{err:?}");
    assert!(err.to_string().contains("the verifier failed"));
}

#[test]
fn an_image_id_other_than_the_compiled_in_one_is_a_refusal() {
    // REVIEW-3 F2: verify_receipt compares the id the verifier printed with params::EQUIV_IMAGE_ID.
    let dir = tempfile::tempdir().unwrap();
    let rc = receipt_file(dir.path());
    let p = public(Variant::Raw);
    let other = [0x11; 32];
    let mut fake = Fake::says(ok_text(Variant::Raw, &other));
    let err = verify_receipt(&mut fake, &p, &request(Path::new("equiv-prove"), Variant::Raw, &rc), 1).unwrap_err();
    assert_eq!(err, EquivError::ImageIdMismatch { got: other, pinned: IMAGE });
    assert!(err.to_string().contains("this tool pins") && err.to_string().contains(&hex::encode(IMAGE)));
}

#[test]
fn output_that_does_not_match_the_bundle_is_a_refusal() {
    let dir = tempfile::tempdir().unwrap();
    let rc = receipt_file(dir.path());
    let p = public(Variant::Raw);
    let h = hex::encode(p.hashlock);
    let a = hex::encode(p.authority().unwrap().0);
    let wrong = hex::encode([0x42u8; 32]);
    let cases: Vec<(&str, String)> = vec![
        ("wrong H echoed", format!("H            : {wrong}\nA            : {a}\n{}", ok_text(Variant::Raw, &IMAGE))),
        ("wrong A echoed", format!("H            : {h}\nA            : {wrong}\n{}", ok_text(Variant::Raw, &IMAGE))),
        ("OK line for the other variant", ok_text(Variant::Stock, &IMAGE)),
        ("no OK line", format!("image id: {}\n", hex::encode(IMAGE))),
        ("no image id", "OK: exists m with sha256(m) = H and Addr(m) = A\n".to_string()),
        ("INVALID text with exit 0", format!("INVALID: journal does not equal variant||H||A\n{}", ok_text(Variant::Raw, &IMAGE))),
        ("two image ids", format!("{}image id: {}\n", ok_text(Variant::Raw, &IMAGE), hex::encode([0x12u8; 32]))),
        ("garbage image id", "OK: exists m with sha256(m) = H and Addr(m) = A\nimage id: zz\n".to_string()),
        ("empty", String::new()),
    ];
    for (what, stdout) in cases {
        let err = verify_receipt(&mut Fake::says(stdout), &p, &request(Path::new("equiv-prove"), Variant::Raw, &rc), 1).unwrap_err();
        assert!(matches!(err, EquivError::BadOutput(_)), "{what}: {err:?}");
    }
    // The matching echo is fine.
    let good = format!("H            : {h}\nA            : {a}\n{}", ok_text(Variant::Raw, &IMAGE));
    verify_receipt(&mut Fake::says(good), &p, &request(Path::new("equiv-prove"), Variant::Raw, &rc), 1).unwrap();
}

#[test]
fn the_runner_must_answer_with_a_verifier_run_and_the_receipt_must_exist() {
    let dir = tempfile::tempdir().unwrap();
    let rc = receipt_file(dir.path());
    let p = public(Variant::Raw);
    let mut odd = Fake { seen: RefCell::new(Vec::new()), answer: Ok(StepOutput::Done) };
    assert_eq!(
        verify_receipt(&mut odd, &p, &request(Path::new("equiv-prove"), Variant::Raw, &rc), 1).unwrap_err(),
        EquivError::UnexpectedOutput
    );
    // A missing receipt is refused before anything is spawned.
    let mut fake = Fake::says(ok_text(Variant::Raw, &IMAGE));
    let err = verify_receipt(&mut fake, &p, &request(Path::new("equiv-prove"), Variant::Raw, &dir.path().join("nope.receipt")), 1).unwrap_err();
    assert!(matches!(err, EquivError::ReceiptUnreadable(_)), "{err:?}");
    assert!(fake.seen.borrow().is_empty());
}

#[test]
fn a_missing_binary_is_a_refusal_through_the_real_runner() {
    let dir = tempfile::tempdir().unwrap();
    let rc = receipt_file(dir.path());
    let p = public(Variant::Raw);
    let missing = dir.path().join("no-such-equiv-prove");
    let err = verify_receipt(&mut ProcessRunner, &p, &request(&missing, Variant::Raw, &rc), 1).unwrap_err();
    assert!(matches!(&err, EquivError::Verifier(d) if d.contains("cannot run")), "{err:?}");
}

#[test]
fn the_process_runner_runs_the_verifier_and_nothing_else() {
    let step = Step::WaitWalletReady { rpc_url: "http://127.0.0.1:1".into(), expected_address: "o1x".into() };
    assert!(matches!(ProcessRunner.run(&step), Err(StockError::Command { .. })));
    assert_eq!(parse_verify_output(&ok_text(Variant::Raw, &IMAGE), Variant::Raw, &[0; 32], &[0; 32]), Ok(IMAGE));
}

// ---------------------------------------------------------------- the binary, with a script for equiv-prove

#[cfg(unix)]
mod binary {
    use super::*;
    use std::os::unix::fs::PermissionsExt as _;
    use std::process::Command;

    fn bin() -> Command {
        Command::new(env!("CARGO_BIN_EXE_swap-cli"))
    }

    /// Run, retrying the rare "Text file busy" a freshly written script can hit when another test thread forks.
    fn run(args: &[String]) -> (bool, String, String) {
        for _ in 0..5 {
            let out = bin().args(args).output().expect("run swap-cli");
            let err = String::from_utf8_lossy(&out.stderr).into_owned();
            if err.contains("Text file busy") {
                std::thread::sleep(std::time::Duration::from_millis(100));
                continue;
            }
            return (out.status.success(), String::from_utf8_lossy(&out.stdout).into_owned(), err);
        }
        panic!("the script stayed busy");
    }

    /// A stand-in `equiv-prove`: records its arguments next to itself, then prints `body` and exits `code`.
    fn script(dir: &Path, body: &str, code: i32) -> PathBuf {
        let p = dir.join("equiv-prove");
        let text = format!("#!/bin/sh\necho \"$@\" > \"{}/argv.txt\"\ncat <<'EOT'\n{body}EOT\nexit {code}\n", dir.display());
        std::fs::write(&p, text).unwrap();
        std::fs::set_permissions(&p, std::fs::Permissions::from_mode(0o755)).unwrap();
        p
    }

    struct Setup {
        dir: tempfile::TempDir,
        public: SwapPublic,
        bundle: PathBuf,
        receipt: PathBuf,
    }

    fn setup(variant: Variant) -> Setup {
        setup_profile(variant, ProfileName::Production)
    }

    fn setup_profile(variant: Variant, profile: ProfileName) -> Setup {
        let dir = tempfile::tempdir().unwrap();
        let public = example_public_with(&Secret::generate().unwrap(), variant, profile);
        let bundle = dir.path().join("bundle.json");
        std::fs::write(&bundle, serde_json::to_string_pretty(&public).unwrap()).unwrap();
        let receipt = receipt_file(dir.path());
        Setup { dir, public, bundle, receipt }
    }

    /// `new-bob` arguments that are Bob's own terms (taken from the example swap), without any proof flags.
    fn bob_args(s: &Setup, out: &str) -> Vec<String> {
        let t = example_bob_terms(&s.public);
        let p = &s.public.params;
        let args: Vec<String> = vec![
            "new-bob".into(),
            "--bundle".into(), s.bundle.to_str().unwrap().into(),
            "--out".into(), s.dir.path().join(out).to_str().unwrap().into(),
            "--bob".into(), t.bob_noid.to_bech32(),
            "--amount".into(), p.amount_micronoid.to_string(),
            "--eth-chain-id".into(), p.eth.chain_id.to_string(),
            "--eth-contract".into(), format!("0x{}", hex::encode(p.eth.contract)),
            "--eth-code-hash".into(), format!("0x{}", hex::encode(t.eth_code_hash)),
            "--eth-amount-wei".into(), p.eth.amount_wei.to_string(),
            "--eth-sender".into(), format!("0x{}", hex::encode(p.eth.bob_sender)),
        ];
        args
    }

    fn with(mut args: Vec<String>, extra: &[&str]) -> Vec<String> {
        args.extend(extra.iter().map(|s| s.to_string()));
        args
    }

    fn receipt_flags(s: &Setup, bin: &Path) -> Vec<String> {
        vec!["--receipt".into(), s.receipt.to_str().unwrap().into(), "--equiv-prove".into(), bin.to_str().unwrap().into()]
    }

    #[test]
    fn new_bob_runs_the_verifier_itself_and_needs_no_typed_values() {
        for variant in [Variant::Raw, Variant::Stock] {
            let s = setup(variant);
            let eq = script(s.dir.path(), &ok_text(variant, &IMAGE), 0);
            // No --variant, no --equiv-h/-a/-image-id: the variant and the statement come from the bundle.
            let args = with(bob_args(&s, "bob.swap.json"), &[]).into_iter().chain(receipt_flags(&s, &eq)).collect::<Vec<_>>();
            let (ok, out, err) = run(&args);
            assert!(ok, "{variant}: {err}");
            assert!(out.contains("\"phase\": \"received\""));
            assert!(err.contains("verified by this tool"), "{err}");
            // What the script was asked.
            let argv = std::fs::read_to_string(s.dir.path().join("argv.txt")).unwrap();
            let want = format!(
                "verify {variant} {} {} {}",
                hex::encode(s.public.hashlock),
                hex::encode(s.public.authority().unwrap().0),
                s.receipt.display()
            );
            assert_eq!(argv.trim(), want);
            // What Bob's file records.
            let file = SwapFile::load(&s.dir.path().join("bob.swap.json")).unwrap();
            let att = file.equivalence.unwrap();
            assert_eq!(att.source, AttestationSource::Receipt);
            assert_eq!(att.image_id, IMAGE);
            assert_eq!(att.receipt_path.as_deref(), Some(s.receipt.to_str().unwrap()));
            assert_eq!(att.receipt_sha256, Some(sha256(&std::fs::read(&s.receipt).unwrap())));
            assert!(att.verified_at.unwrap() > 1_700_000_000);
        }
    }

    #[test]
    fn typed_values_are_optional_but_must_agree_with_the_bundle_and_the_verifier() {
        let s = setup(Variant::Raw);
        let eq = script(s.dir.path(), &ok_text(Variant::Raw, &IMAGE), 0);
        let h = format!("0x{}", hex::encode(s.public.hashlock));
        let agreeing = ["--equiv-h", &h, "--equiv-a", &s.public.claim_authority, "--equiv-image-id", &hex::encode(IMAGE)];
        let args = with(bob_args(&s, "ok.swap.json"), &agreeing).into_iter().chain(receipt_flags(&s, &eq)).collect::<Vec<_>>();
        let (ok, _, err) = run(&args);
        assert!(ok, "{err}");
        for (flag, value, needle) in [
            ("--equiv-h", format!("0x{}", hex::encode([0x42u8; 32])), "hashlock"),
            ("--equiv-a", hex::encode([0x42u8; 32]), "claim authority"),
            ("--equiv-image-id", hex::encode([0x42u8; 32]), "image id"),
        ] {
            let args = with(bob_args(&s, &format!("bad{}.swap.json", &flag[8..9])), &[flag, &value]).into_iter().chain(receipt_flags(&s, &eq)).collect::<Vec<_>>();
            let (ok, _, err) = run(&args);
            assert!(!ok && err.contains(needle), "{flag}: {err}");
        }
    }

    #[test]
    fn refusals_write_no_swap_file() {
        let s = setup(Variant::Raw);
        let nothing_written = |name: &str| assert!(!s.dir.path().join(name).exists(), "{name} must not exist");
        // Non-zero exit, even though the text on stdout looks like success.
        let eq = script(s.dir.path(), &ok_text(Variant::Raw, &IMAGE), 3);
        let args = with(bob_args(&s, "a.swap.json"), &[]).into_iter().chain(receipt_flags(&s, &eq)).collect::<Vec<_>>();
        let (ok, _, err) = run(&args);
        assert!(!ok && err.contains("exit status 3"), "{err}");
        nothing_written("a.swap.json");
        // The verifier printed another image id than the pinned one.
        let eq = script(s.dir.path(), &ok_text(Variant::Raw, &[0x11; 32]), 0);
        let args = with(bob_args(&s, "b.swap.json"), &[]).into_iter().chain(receipt_flags(&s, &eq)).collect::<Vec<_>>();
        let (ok, _, err) = run(&args);
        assert!(!ok && err.contains("this tool pins"), "{err}");
        nothing_written("b.swap.json");
        // The binary does not exist.
        let args = with(bob_args(&s, "c.swap.json"), &[]).into_iter().chain(receipt_flags(&s, &s.dir.path().join("missing-bin"))).collect::<Vec<_>>();
        let (ok, _, err) = run(&args);
        assert!(!ok && err.contains("cannot run"), "{err}");
        nothing_written("c.swap.json");
        // The receipt does not exist.
        let eq = script(s.dir.path(), &ok_text(Variant::Raw, &IMAGE), 0);
        let args = with(bob_args(&s, "d.swap.json"), &["--receipt", "/nonexistent/x.receipt", "--equiv-prove", eq.to_str().unwrap()]);
        let (ok, _, err) = run(&args);
        assert!(!ok && err.contains("cannot read the receipt"), "{err}");
        nothing_written("d.swap.json");
        // --receipt without --equiv-prove, and --equiv-prove without --receipt.
        let args = with(bob_args(&s, "e.swap.json"), &["--receipt", s.receipt.to_str().unwrap()]);
        let (ok, _, err) = run(&args);
        assert!(!ok && err.contains("missing --equiv-prove"), "{err}");
        let args = with(bob_args(&s, "f.swap.json"), &["--equiv-prove", eq.to_str().unwrap()]);
        let (ok, _, err) = run(&args);
        assert!(!ok && err.contains("only makes sense with --receipt"), "{err}");
        // --pinned-image-id is optional (REVIEW-3 F2): the compiled-in value is accepted, any other is refused.
        let args = with(bob_args(&s, "g.swap.json"), &["--pinned-image-id", &hex::encode(IMAGE)]).into_iter().chain(receipt_flags(&s, &eq)).collect::<Vec<_>>();
        let (ok, _, err) = run(&args);
        assert!(ok, "{err}");
        let args = with(bob_args(&s, "g2.swap.json"), &["--pinned-image-id", &"7e".repeat(32)]).into_iter().chain(receipt_flags(&s, &eq)).collect::<Vec<_>>();
        let (ok, _, err) = run(&args);
        assert!(!ok && err.contains("compiled into this tool") && err.contains(&hex::encode(IMAGE)), "{err}");
        nothing_written("g2.swap.json");
        // A tampered bundle never reaches the verifier.
        let bad = std::fs::read_to_string(&s.bundle).unwrap().replace("\"max_fee_micronoid\": 50000", "\"max_fee_micronoid\": 60000");
        std::fs::write(&s.bundle, bad).unwrap();
        let _ = std::fs::remove_file(s.dir.path().join("argv.txt"));
        let args = with(bob_args(&s, "h.swap.json"), &[]).into_iter().chain(receipt_flags(&s, &eq)).collect::<Vec<_>>();
        let (ok, _, err) = run(&args);
        assert!(!ok, "{err}");
        assert!(!s.dir.path().join("argv.txt").exists(), "the verifier must not run on a bundle that fails its own checks");
        nothing_written("h.swap.json");
    }

    #[test]
    fn the_typed_form_is_refused_outside_rehearsal_and_works_under_it() {
        // REVIEW-3 F2.
        for profile in [ProfileName::Production, ProfileName::Sepolia] {
            let s = setup_profile(Variant::Raw, profile);
            let h = format!("0x{}", hex::encode(s.public.hashlock));
            let typed = ["--equiv-h", &h, "--equiv-a", &s.public.claim_authority, "--equiv-image-id", &hex::encode(IMAGE), "--profile", &profile.to_string()];
            let (ok, _, err) = run(&with(bob_args(&s, "typed.swap.json"), &typed));
            assert!(!ok && err.contains("accepted only under the rehearsal profile") && err.contains("--receipt FILE --equiv-prove BIN"), "{profile}: {err}");
            assert!(!s.dir.path().join("typed.swap.json").exists(), "{profile}: nothing may be written");
            // Not even with no typed values at all: the refusal is about the form.
            let (ok, _, err) = run(&with(bob_args(&s, "none.swap.json"), &["--profile", &profile.to_string()]));
            assert!(!ok && err.contains("accepted only under the rehearsal profile"), "{profile}: {err}");
            // The receipt form works under the same profile.
            let eq = script(s.dir.path(), &ok_text(Variant::Raw, &IMAGE), 0);
            let args = with(bob_args(&s, "receipt.swap.json"), &["--profile", &profile.to_string()]).into_iter().chain(receipt_flags(&s, &eq)).collect::<Vec<_>>();
            let (ok, _, err) = run(&args);
            assert!(ok, "{profile}: {err}");
        }
        let s = setup_profile(Variant::Raw, ProfileName::Rehearsal);
        let h = format!("0x{}", hex::encode(s.public.hashlock));
        let typed = ["--equiv-h", &h, "--equiv-a", &s.public.claim_authority, "--equiv-image-id", &hex::encode(IMAGE), "--profile", "rehearsal"];
        let (ok, _, err) = run(&with(bob_args(&s, "typed.swap.json"), &typed));
        assert!(ok, "{err}");
        assert!(err.contains("NOT checked here: the receipt itself") && err.contains("REHEARSAL ONLY"), "{err}");
        let att = SwapFile::load(&s.dir.path().join("typed.swap.json")).unwrap().equivalence.unwrap();
        assert_eq!(att.source, AttestationSource::Typed);
        assert_eq!(att.pinned_image_id, IMAGE);
        assert!(att.receipt_path.is_none() && att.verified_at.is_none());
        // A typed image id other than the compiled-in one is refused, nothing written.
        let other = ["--equiv-h", &h, "--equiv-a", &s.public.claim_authority, "--equiv-image-id", &"7e".repeat(32), "--profile", "rehearsal"];
        let (ok, _, err) = run(&with(bob_args(&s, "other.swap.json"), &other));
        assert!(!ok && err.contains("image id"), "{err}");
        assert!(!s.dir.path().join("other.swap.json").exists());
        // Without the typed values and without a receipt there is nothing to attest.
        let (ok, _, err) = run(&with(bob_args(&s, "none.swap.json"), &["--profile", "rehearsal"]));
        assert!(!ok && err.contains("missing --equiv-h"), "{err}");
    }

    #[test]
    fn the_verifier_child_gets_no_passphrase_and_no_dev_mode() {
        // REVIEW-3 F4 / G1: the stand-in `equiv-prove` records its environment; `new-bob` is started WITH SWAP_PASSPHRASE
        // and RISC0_DEV_MODE set (on the child command only) and a variable on the allow-list.
        let s = setup(Variant::Raw);
        let seen = s.dir.path().join("env-seen.txt");
        let eq = script(s.dir.path(), &ok_text(Variant::Raw, &IMAGE), 0);
        // Add the environment recording to the script (after the shebang line).
        let text = std::fs::read_to_string(&eq).unwrap().replacen(
            "\n",
            &format!("\nprintf 'pass=%s\ndev=%s\nlc=%s\n' \"${{SWAP_PASSPHRASE:-unset}}\" \"${{RISC0_DEV_MODE:-unset}}\" \"${{LC_ALL:-unset}}\" > '{}'\n", seen.display()),
            1,
        );
        std::fs::write(&eq, text).unwrap();
        let args = with(bob_args(&s, "env.swap.json"), &[]).into_iter().chain(receipt_flags(&s, &eq)).collect::<Vec<_>>();
        let mut cmd = bin();
        cmd.args(&args).env("SWAP_PASSPHRASE", "f4-binary-test-passphrase-7c2e").env("RISC0_DEV_MODE", "1").env("LC_ALL", "C");
        let mut last = None;
        for _ in 0..5 {
            let out = cmd.output().expect("run swap-cli");
            let err = String::from_utf8_lossy(&out.stderr).into_owned();
            if err.contains("Text file busy") {
                std::thread::sleep(std::time::Duration::from_millis(100));
                continue;
            }
            last = Some((out.status.success(), err));
            break;
        }
        let (ok, err) = last.expect("the script stayed busy");
        assert!(ok, "{err}");
        let text = std::fs::read_to_string(&seen).unwrap();
        assert_eq!(text, "pass=unset\ndev=unset\nlc=C\n", "{text}");
    }
}
