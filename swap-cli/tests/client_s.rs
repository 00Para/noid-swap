//! Client S (stock-wallet fallback) against a recording mock runner. Nothing is executed.

use std::path::PathBuf;

use swap_cli::client::stock::*;
use swap_cli::secret::{Secret, Variant};
use swap_cli::params::ContractVersion;
use swap_cli::swapfile::{example_public, example_public_v, SwapPublic};
use swap_cli::watch::NoidInstance;

const AMOUNT: u64 = 10_000_000;
const FEE: u64 = 20_000;

/// Records every step; scripted outputs and failures.
struct MockRunner {
    log: Vec<Step>,
    claim_authority: String,
    bob: String,
    next_height: u64,
    /// Wallet address returned by `WaitWalletReady`.
    wallet_address: String,
    /// How many `Submit`s fail with `HeightChanged` before one succeeds.
    height_changes: usize,
    preview_edit: Option<Box<dyn Fn(&mut PreviewOut)>>,
    submit_txid_override: Option<String>,
    previews: u64,
}

impl MockRunner {
    fn new(public: &SwapPublic) -> Self {
        Self {
            log: Vec::new(),
            claim_authority: public.claim_authority.clone(),
            bob: public.params.bob_noid.clone(),
            next_height: public.params.deadline_height - 100,
            wallet_address: public.claim_authority.clone(),
            height_changes: 0,
            preview_edit: None,
            submit_txid_override: None,
            previews: 0,
        }
    }

    fn labels(&self) -> Vec<&'static str> {
        self.log.iter().map(Step::label).collect()
    }
}

impl CommandRunner for MockRunner {
    fn run(&mut self, step: &Step) -> Result<StepOutput, StockError> {
        self.log.push(step.clone());
        Ok(match step {
            Step::WaitWalletReady { .. } => StepOutput::Address(self.wallet_address.clone()),
            Step::Preview { .. } => {
                self.previews += 1;
                let mut pv = PreviewOut {
                    txid: format!("{:064x}", 0xabc0_0000u64 + self.previews),
                    call_height: self.next_height,
                    authority: self.claim_authority.clone(),
                    recovery: false,
                    terminal: true,
                    fee_micronoid: FEE,
                    payout: Some(PreviewPayout { address: self.bob.clone(), amount_micronoid: AMOUNT - FEE }),
                };
                if let Some(edit) = &self.preview_edit {
                    edit(&mut pv);
                }
                StepOutput::Preview(pv)
            }
            Step::Submit { expected_txid, .. } => {
                if self.height_changes > 0 {
                    self.height_changes -= 1;
                    self.next_height += 1; // the chain moved: the next preview is one block later
                    return Err(StockError::HeightChanged);
                }
                let txid = self.submit_txid_override.clone().unwrap_or_else(|| expected_txid.clone());
                StepOutput::Submitted { txid, call_height: self.next_height }
            }
            _ => StepOutput::Done,
        })
    }
}

struct Fixture {
    secret: Secret,
    req: StockClaimRequest,
    _dir: tempfile::TempDir,
}

fn fixture() -> Fixture {
    let secret = Secret::generate().unwrap();
    let public = example_public(&secret, Variant::Stock);
    let dir = tempfile::tempdir().unwrap();
    let data = dir.path().join("throwaway-wallet");
    std::fs::create_dir(&data).unwrap();
    std::fs::write(data.join(MARKER_FILE), "x").unwrap();
    let req = StockClaimRequest {
        public,
        instance: NoidInstance { slot_index: 3, creation_id: 9, amount_micronoid: AMOUNT },
        secret: secret.clone(),
        data_dir: data,
        create_marker: false,
        node_binary: PathBuf::from("/opt/parano1d/parano1d"),
        cli_binary: PathBuf::from("/opt/parano1d/noid_cli"),
        rpc_url: "http://127.0.0.1:19601".into(),
        p2p_listen: "127.0.0.1:19600".into(),
        fee_micronoid: FEE,
        out_file: dir.path().join("claim-out.json"),
    };
    Fixture { secret, req, _dir: dir }
}

fn tip(f: &Fixture) -> u64 {
    f.req.public.params.deadline_height - 120
}

#[test]
fn happy_path_runs_the_exact_step_sequence() {
    let f = fixture();
    let mut m = MockRunner::new(&f.req.public);
    let report = run_stock_claim(&f.req, &mut m, || tip(&f)).unwrap();
    assert_eq!(
        m.labels(),
        ["write_object_file", "stop_node", "import_secret", "start_node", "wait_wallet_ready", "preview", "submit"]
    );
    assert_eq!(report.steps, m.labels());
    assert_eq!(report.attempts, 1);
    assert!(report.retries.is_empty());
    assert!(!report.late_but_valid);

    // The import reads exactly the 64 hex characters (no 0x) plus a newline.
    let Step::ImportSecret { stdin, data_dir, .. } = &m.log[2] else { panic!("step 3 is the import") };
    assert_eq!(stdin.expose(), format!("{}\n", f.secret.stock_import_hex().as_str()));
    assert_eq!(stdin.expose().len(), 65);
    assert_eq!(data_dir, &f.req.data_dir);

    // The object file carries the opening.
    let Step::WriteObjectFile { opening_hex, .. } = &m.log[0] else { panic!() };
    assert_eq!(opening_hex, &f.req.public.opening_hex);

    // Submit is bound to the preview.
    let Step::Preview { slot, creation_id, .. } = &m.log[5] else { panic!() };
    assert_eq!((*slot, *creation_id), (3, 9));
    let Step::Submit { expected_txid, out, .. } = &m.log[6] else { panic!() };
    assert_eq!(expected_txid, &format!("{:064x}", 0xabc0_0001u64));
    assert_eq!(out, &f.req.out_file);
    assert_eq!(report.txid, *expected_txid);
    assert_eq!(report.call_height, m.next_height);
    assert_eq!(report.call_height, f.req.public.params.deadline_height - 100);
}

#[test]
fn command_lines_follow_the_vendored_cli() {
    let f = fixture();
    let mut m = MockRunner::new(&f.req.public);
    run_stock_claim(&f.req, &mut m, || tip(&f)).unwrap();
    let dd = f.req.data_dir.to_string_lossy().into_owned();
    let obj = f.req.data_dir.join("swap-object.json").to_string_lossy().into_owned();
    assert_eq!(
        m.log[2].argv().unwrap(),
        ["/opt/parano1d/parano1d", "--import-wallet-secret", "--data-dir", dd.as_str()]
    );
    assert_eq!(
        m.log[3].argv().unwrap(),
        ["/opt/parano1d/parano1d", "--data-dir", dd.as_str(), "--rpc-listen", "127.0.0.1:19601", "--p2p-listen", "127.0.0.1:19600"]
    );
    let base = ["/opt/parano1d/noid_cli", "--json", "--rpc", "http://127.0.0.1:19601", "contract", "call", obj.as_str(), "3", "9", "--close", "--fee", "0.020000"];
    let mut preview: Vec<String> = base.iter().map(|s| s.to_string()).collect();
    preview.push("--preview".into());
    assert_eq!(m.log[5].argv().unwrap(), preview);
    let mut submit: Vec<String> = base.iter().map(|s| s.to_string()).collect();
    let out = f.req.out_file.to_string_lossy().into_owned();
    submit.extend(["--expected-txid".into(), format!("{:064x}", 0xabc0_0001u64), "--out".into(), out, "--wait-seconds".into(), "0".into()]);
    assert_eq!(m.log[6].argv().unwrap(), submit);
    // The secret is never on any command line.
    let hex = f.secret.stock_import_hex();
    for s in &m.log {
        assert!(!s.argv().unwrap_or_default().join(" ").contains(hex.as_str()));
    }
    assert_eq!(format_noid(5_800), "0.005800");
    assert_eq!(format_noid(12_345_678), "12.345678");
}

#[test]
fn protected_data_dirs_are_refused_before_any_step() {
    for bad in [
        "C:\\Parano1d\\data",
        "c:/parano1d/data/",
        "C:\\Users\\00\\.parano1d\\data",
        "/mnt/c/Users/00/.parano1d/data",
        "/mnt/c/Parano1d/data/wallet",
        "/home/user/.parano1d/data",
        "/mnt/c/Users/00/.parano1d",
        "C:\\Parano1d",
    ] {
        let mut f = fixture();
        f.req.data_dir = PathBuf::from(bad);
        let mut m = MockRunner::new(&f.req.public);
        let err = run_stock_claim(&f.req, &mut m, || tip(&f)).unwrap_err();
        assert!(matches!(err, StockError::ProtectedDataDir(_)), "{bad}: {err}");
        assert!(m.log.is_empty(), "{bad}: a step ran");
    }
}

#[test]
fn missing_marker_is_refused_and_marker_creation_is_only_for_empty_dirs() {
    let mut f = fixture();
    std::fs::remove_file(f.req.data_dir.join(MARKER_FILE)).unwrap();
    let mut m = MockRunner::new(&f.req.public);
    assert!(matches!(run_stock_claim(&f.req, &mut m, || tip(&f)), Err(StockError::MissingMarker(_))));
    assert!(m.log.is_empty());

    // Asking for the marker in an empty directory works (and the directory may not exist yet).
    f.req.create_marker = true;
    f.req.data_dir = f.req.data_dir.join("fresh");
    run_stock_claim(&f.req, &mut MockRunner::new(&f.req.public), || tip(&f)).unwrap();
    assert!(f.req.data_dir.join(MARKER_FILE).is_file());

    // ... but never in a directory that already holds something (a possible real wallet).
    let mut g = fixture();
    std::fs::remove_file(g.req.data_dir.join(MARKER_FILE)).unwrap();
    std::fs::write(g.req.data_dir.join("wallet.key"), "pretend wallet").unwrap();
    g.req.create_marker = true;
    let mut m = MockRunner::new(&g.req.public);
    assert!(matches!(run_stock_claim(&g.req, &mut m, || tip(&g)), Err(StockError::MarkerNotCreatable(_))));
    assert!(m.log.is_empty());
    assert!(!g.req.data_dir.join(MARKER_FILE).exists());
}

#[test]
fn wrong_variant_or_wrong_secret_is_refused() {
    // A raw-variant swap cannot use the stock wallet.
    let mut f = fixture();
    f.req.public = example_public(&f.secret, Variant::Raw);
    let mut m = MockRunner::new(&f.req.public);
    assert_eq!(run_stock_claim(&f.req, &mut m, || tip(&f)).unwrap_err(), StockError::WrongVariant);
    assert!(m.log.is_empty());

    // Another secret: the hashlock does not match.
    let mut f = fixture();
    f.req.secret = Secret::generate().unwrap();
    let mut m = MockRunner::new(&f.req.public);
    assert_eq!(run_stock_claim(&f.req, &mut m, || tip(&f)).unwrap_err(), StockError::HashlockMismatch);
    assert!(m.log.is_empty());

    // Right hashlock, but the authority was built from another secret (equivalence failure).
    let mut f = fixture();
    let other = Secret::generate().unwrap();
    let mut public = example_public(&other, Variant::Stock);
    public.hashlock = f.secret.hashlock();
    f.req.public = public;
    let mut m = MockRunner::new(&f.req.public);
    assert_eq!(run_stock_claim(&f.req, &mut m, || tip(&f)).unwrap_err(), StockError::SecretMismatch);
    assert!(m.log.is_empty());

    // The public test vector is never acceptable.
    let mut f = fixture();
    f.req.secret = Secret::from_bytes(htlc_harness_seq());
    assert_eq!(
        run_stock_claim(&f.req, &mut MockRunner::new(&f.req.public), || tip(&f)).unwrap_err(),
        StockError::PublicTestVector
    );
}

fn htlc_harness_seq() -> [u8; 32] {
    swap_cli::htlc_harness::seq_bytes(0)
}

#[test]
fn fee_and_endpoint_guards() {
    let mut f = fixture();
    f.req.fee_micronoid = 5_799;
    assert!(matches!(
        run_stock_claim(&f.req, &mut MockRunner::new(&f.req.public), || tip(&f)),
        Err(StockError::FeeOutOfRange { fee: 5_799, min: 5_800, .. })
    ));
    f.req.fee_micronoid = f.req.public.params.max_fee_micronoid + 1;
    assert!(matches!(
        run_stock_claim(&f.req, &mut MockRunner::new(&f.req.public), || tip(&f)),
        Err(StockError::FeeOutOfRange { .. })
    ));
    let mut f = fixture();
    f.req.rpc_url = "http://10.0.0.5:19601".into();
    assert!(matches!(
        run_stock_claim(&f.req, &mut MockRunner::new(&f.req.public), || tip(&f)),
        Err(StockError::RpcNotLoopback(_))
    ));
    let mut f = fixture();
    f.req.rpc_url = "http://127.0.0.1:9601".into();
    assert_eq!(
        run_stock_claim(&f.req, &mut MockRunner::new(&f.req.public), || tip(&f)).unwrap_err(),
        StockError::ReservedPort(9601)
    );
}

#[test]
fn nothing_is_wiped_when_the_deadline_is_already_reached() {
    let f = fixture();
    let d = f.req.public.params.deadline_height;
    let mut m = MockRunner::new(&f.req.public);
    let err = run_stock_claim(&f.req, &mut m, || d - 1).unwrap_err();
    assert_eq!(err, StockError::AlreadyTooLate { tip: d - 1, deadline: d });
    assert!(m.log.is_empty());
}

#[test]
fn wrong_wallet_address_after_import_aborts_before_preview() {
    let f = fixture();
    let mut m = MockRunner::new(&f.req.public);
    m.wallet_address = f.req.public.params.alice_noid.clone();
    let err = run_stock_claim(&f.req, &mut m, || tip(&f)).unwrap_err();
    assert!(matches!(err, StockError::WalletAddressMismatch { .. }));
    assert_eq!(m.labels().last(), Some(&"wait_wallet_ready"));
    assert!(!m.labels().contains(&"preview"));
}

fn rejected_with(edit: impl Fn(&mut PreviewOut, &SwapPublic) + 'static) -> StockError {
    let f = fixture();
    let mut m = MockRunner::new(&f.req.public);
    let public = f.req.public.clone();
    m.preview_edit = Some(Box::new(move |pv| edit(pv, &public)));
    let err = run_stock_claim(&f.req, &mut m, || tip(&f)).unwrap_err();
    assert!(!m.labels().contains(&"submit"), "must not submit a rejected preview");
    err
}

#[test]
fn bad_previews_are_never_submitted() {
    assert!(matches!(rejected_with(|pv, _| pv.recovery = true), StockError::PreviewRejected(_)));
    assert!(matches!(rejected_with(|pv, _| pv.terminal = false), StockError::PreviewRejected(_)));
    assert!(matches!(
        rejected_with(|pv, p| pv.payout.as_mut().unwrap().address = p.params.alice_noid.clone()),
        StockError::PreviewRejected(_)
    ));
    assert!(matches!(rejected_with(|pv, _| pv.payout = None), StockError::PreviewRejected(_)));
    assert!(matches!(
        rejected_with(|pv, p| pv.authority = p.params.alice_noid.clone()),
        StockError::PreviewRejected(_)
    ));
    assert!(matches!(rejected_with(|pv, _| pv.fee_micronoid = 50_000), StockError::PreviewRejected(_)));
    assert!(matches!(rejected_with(|pv, _| pv.txid = "abcd".into()), StockError::PreviewRejected(_)));
    assert!(matches!(
        rejected_with(|pv, _| pv.payout.as_mut().unwrap().amount_micronoid -= 1),
        StockError::PreviewRejected(_)
    ));
}

#[test]
fn too_late_call_height_is_refused_and_late_but_valid_is_flagged() {
    let d = fixture().req.public.params.deadline_height;
    for h in [d, d + 5] {
        let err = rejected_with(move |pv, _| pv.call_height = h);
        assert_eq!(err, StockError::PreviewTooLate { call_height: h, deadline: d });
    }
    // D-1 is valid but inside the reorg window: accepted, flagged.
    let f = fixture();
    let mut m = MockRunner::new(&f.req.public);
    m.next_height = d - 1;
    let report = run_stock_claim(&f.req, &mut m, || tip(&f)).unwrap();
    assert!(report.late_but_valid);
    assert_eq!(report.call_height, d - 1);
}

#[test]
fn one_height_change_then_success_takes_two_attempts_with_a_fresh_preview() {
    let f = fixture();
    let mut m = MockRunner::new(&f.req.public);
    m.height_changes = 1;
    let report = run_stock_claim(&f.req, &mut m, || tip(&f)).unwrap();
    assert_eq!(report.attempts, 2);
    assert_eq!(report.retries.len(), 1);
    assert_eq!(report.retries[0].attempt, 1);
    assert_eq!(
        m.labels()[5..],
        ["preview", "submit", "preview", "submit"],
        "the retry re-previews"
    );
    // The retried submit is bound to the second preview, not the first.
    let submits: Vec<&Step> = m.log.iter().filter(|s| s.label() == "submit").collect();
    let Step::Submit { expected_txid: first, .. } = submits[0] else { panic!() };
    let Step::Submit { expected_txid: second, .. } = submits[1] else { panic!() };
    assert_ne!(first, second);
    assert_eq!(report.txid, *second);
    assert_eq!(report.retries[0].preview_txid, *first);
    // The import ran once only.
    assert_eq!(m.labels().iter().filter(|l| **l == "import_secret").count(), 1);
}

#[test]
fn four_height_changes_give_up_after_three_attempts() {
    let f = fixture();
    let mut m = MockRunner::new(&f.req.public);
    m.height_changes = 4;
    let err = run_stock_claim(&f.req, &mut m, || tip(&f)).unwrap_err();
    assert_eq!(err, StockError::TooManyAttempts { attempts: 3 });
    assert_eq!(m.labels().iter().filter(|l| **l == "preview").count(), 3);
    assert_eq!(m.labels().iter().filter(|l| **l == "submit").count(), 3);
    assert_eq!(m.height_changes, 1, "the fourth failure was never reached");
}

#[test]
fn other_submit_failures_are_not_retried_and_mismatched_results_are_caught() {
    let f = fixture();
    let mut m = MockRunner::new(&f.req.public);
    m.submit_txid_override = Some("ff".repeat(32));
    assert!(matches!(run_stock_claim(&f.req, &mut m, || tip(&f)), Err(StockError::SubmitMismatch(_))));

    struct Failing;
    impl CommandRunner for Failing {
        fn run(&mut self, step: &Step) -> Result<StepOutput, StockError> {
            match step {
                Step::ImportSecret { .. } => {
                    Err(StockError::Command { step: "import_secret".into(), detail: "exit 1".into() })
                }
                _ => Ok(StepOutput::Done),
            }
        }
    }
    let err = run_stock_claim(&f.req, &mut Failing, || tip(&f)).unwrap_err();
    assert!(matches!(err, StockError::Command { .. }));
}

#[test]
fn debug_output_never_shows_the_secret() {
    let f = fixture();
    let mut m = MockRunner::new(&f.req.public);
    run_stock_claim(&f.req, &mut m, || tip(&f)).unwrap();
    let hex = f.secret.stock_import_hex();
    let step = &m.log[2];
    let shown = format!("{step:?} {step:#?}");
    assert!(shown.contains("ImportSecret"));
    assert!(shown.contains("redacted"));
    assert!(!shown.contains(hex.as_str()));
    let all = format!("{:?}", m.log);
    assert!(!all.contains(hex.as_str()));
    assert!(!all.contains(&hex.as_str()[..16]));
    let req = format!("{:?}", f.req);
    assert!(!req.contains(hex.as_str()));
}

// ------------------------------------------------------------------------------------------
// Contract v2 (HashTimeLockV2): the stock-wallet claim must pay exactly max_fee.
// ------------------------------------------------------------------------------------------

fn fixture_v2() -> Fixture {
    let mut f = fixture();
    f.req.public = example_public_v(&f.secret, Variant::Stock, ContractVersion::V2);
    f.req.fee_micronoid = f.req.public.params.max_fee_micronoid;
    f
}

/// A mock whose previews report the fee the request asked for, as the real CLI does.
fn mock_for_fee(f: &Fixture) -> MockRunner {
    let mut m = MockRunner::new(&f.req.public);
    let fee = f.req.fee_micronoid;
    m.preview_edit = Some(Box::new(move |pv: &mut PreviewOut| {
        pv.fee_micronoid = fee;
        if let Some(p) = pv.payout.as_mut() {
            p.amount_micronoid = AMOUNT - fee;
        }
    }));
    m
}

#[test]
fn v2_claim_with_fee_equal_to_max_fee_runs_the_same_steps_and_passes_the_fee_to_the_wallet() {
    let f = fixture_v2();
    assert_eq!(f.req.public.params.contract_version, ContractVersion::V2);
    assert_eq!(f.req.fee_micronoid, 50_000);
    let mut m = mock_for_fee(&f);
    let report = run_stock_claim(&f.req, &mut m, || tip(&f)).unwrap();
    assert_eq!(
        m.labels(),
        ["write_object_file", "stop_node", "import_secret", "start_node", "wait_wallet_ready", "preview", "submit"]
    );
    assert_eq!(report.attempts, 1);
    // Both the preview and the submit carry the fixed fee (the CLI's `--fee 0.050000`).
    let Step::Preview { fee, .. } = &m.log[5] else { panic!("step 6 is the preview") };
    let Step::Submit { fee: submit_fee, .. } = &m.log[6] else { panic!("step 7 is the submit") };
    assert_eq!((*fee, *submit_fee), (50_000, 50_000));
    // The open-ended v1 fee (20,000, fine for a v1 contract) is not enough for v2.
    let v1 = fixture();
    assert!(run_stock_claim(&v1.req, &mut MockRunner::new(&v1.req.public), || tip(&v1)).is_ok());
}

#[test]
fn v2_claim_refuses_any_fee_other_than_max_fee_before_touching_the_wallet() {
    for bad in [5_800u64, 20_000, 49_999, 50_001] {
        let mut f = fixture_v2();
        f.req.fee_micronoid = bad;
        let mut m = mock_for_fee(&f);
        let err = run_stock_claim(&f.req, &mut m, || tip(&f)).unwrap_err();
        assert_eq!(err, StockError::FeeOutOfRange { fee: bad, min: 50_000, max: 50_000 }, "fee {bad}");
        assert!(err.to_string().contains("exactly max_fee"), "{err}");
        assert!(m.log.is_empty(), "no wallet step may run for fee {bad}: {:?}", m.labels());
    }
}
