//! Client S: the scripted stock-wallet fallback for Bob (design section 7, "Option S").
//!
//! Plain words. Bob learns the swap secret `m` on Ethereum. The stock Parano1d
//! wallet can only spend from addresses it derived itself, so Bob *imports* `m`
//! into a wallet. That import **replaces** the wallet in a data directory
//! (`state.rs` L620-700 `import_generated_master_secret`: whitespace stripped,
//! exactly 64 hex characters, active index reset to 0). Run on a real wallet it
//! would destroy it, so this module only ever targets a *throwaway* directory
//! that carries a marker file, never `C:\Parano1d\data` or `C:\Users\00\.parano1d\data`.
//!
//! The import is a node-binary action (`main.rs` L1371-1376 flag, L1995-2005
//! reads <= 4,097 bytes of stdin then exits; L1863-1880 forbids combining it with
//! mining or other actions; the wallet file is `<data-dir>/wallet.key`, L1988).
//! The claim itself is two stock CLI calls (`contracts.rs` L100-160 arguments,
//! L335-392 flow, `bind_review` L413-440): `--preview` prints the exact call, then
//! the real call repeats it with `--expected-txid`, and the node refuses if the
//! height or active address changed (`objects.rs` `prepare_call` L460-590). That
//! refusal is `StockError::HeightChanged` here: re-preview and try again, at most
//! `MAX_ATTEMPTS` times. The CLI's `--rpc`/`--json` are global flags (`noid_cli.rs` L146-160).
//!
//! Nothing in this file executes anything: `run_stock_claim` builds `Step`s and
//! hands them to a `CommandRunner`. The only implementation in this crate that spawns anything is
//! [`crate::equiv::ProcessRunner`], and it runs `Step::EquivVerify` alone (REVIEW-2 F2); every
//! other implementation is a test mock.

use std::fmt;
use std::path::{Path, PathBuf};

use serde::Deserialize;
use zeroize::Zeroizing;

use crate::params::{classify_claim_height, ClaimHeight};
use crate::secret::{Secret, Variant};
use crate::swapfile::SwapPublic;
use crate::watch::NoidInstance;

/// Marker the data directory must contain before the wallet there may be replaced.
pub const MARKER_FILE: &str = "THROWAWAY-SWAP-WALLET";
/// Preview-then-submit attempts before giving up (each retry is a fresh preview).
pub const MAX_ATTEMPTS: u32 = 3;
/// Production directories on this machine (Windows and WSL spellings), compared lowercase.
const PROTECTED_DIRS: [&str; 2] = ["c:/parano1d/data", "c:/users/00/.parano1d/data"];
/// Default node ports; the owner's wallet app uses them, the throwaway node must not.
const RESERVED_PORTS: [u16; 2] = [9600, 9601];

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum StockError {
    ProtectedDataDir(String),
    DataDirNotAbsolute(String),
    MissingMarker(String),
    MarkerNotCreatable(String),
    WrongVariant,
    BadPublicSection(String),
    PublicTestVector,
    HashlockMismatch,
    /// `Addr(Derive(m, 0))` is not the swap's `claim_authority`.
    SecretMismatch,
    RecipientIsAuthority,
    /// v1: outside `[MIN_CLOSE_FEE, max_fee]`; v2: not exactly `max_fee` (then `min == max`).
    FeeOutOfRange { fee: u64, min: u64, max: u64 },
    RpcNotLoopback(String),
    ReservedPort(u16),
    /// The next block already reaches the deadline: do not wipe anything for nothing.
    AlreadyTooLate { tip: u64, deadline: u64 },
    /// After the import the wallet's active address is not the claim authority.
    WalletAddressMismatch { expected: String, actual: String },
    PreviewRejected(String),
    PreviewTooLate { call_height: u64, deadline: u64 },
    /// Runner-reported: the node refused because the inclusion height (or body) moved.
    HeightChanged,
    TooManyAttempts { attempts: u32 },
    UnexpectedOutput(&'static str),
    SubmitMismatch(String),
    /// A step failed for any other reason (spawn failure, non-zero exit, bad JSON).
    Command { step: String, detail: String },
}

impl fmt::Display for StockError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        use StockError::*;
        match self {
            ProtectedDataDir(p) => write!(f, "refusing protected/production data dir {p}"),
            DataDirNotAbsolute(p) => write!(f, "data dir must be an absolute path, got {p}"),
            MissingMarker(p) => write!(f, "{p} has no {MARKER_FILE} marker: not a throwaway wallet dir"),
            MarkerNotCreatable(e) => write!(f, "cannot create the marker: {e}"),
            WrongVariant => write!(f, "client S needs a stock-variant swap"),
            BadPublicSection(e) => write!(f, "swap public section invalid: {e}"),
            PublicTestVector => write!(f, "refusing the public test vector secret"),
            HashlockMismatch => write!(f, "SHA-256(secret) != hashlock"),
            SecretMismatch => write!(f, "Addr(Derive(m,0)) != claim_authority"),
            RecipientIsAuthority => write!(f, "claim_recipient == claim_authority (design 6.4)"),
            FeeOutOfRange { fee, min, max } if min == max => {
                write!(f, "fee {fee} is not {max}: a v2 (fixed-fee) contract accepts only a close that pays exactly max_fee")
            }
            FeeOutOfRange { fee, min, max } => write!(f, "fee {fee} outside [{min}, {max}]"),
            RpcNotLoopback(u) => write!(f, "rpc url {u} is not loopback http"),
            ReservedPort(p) => write!(f, "port {p} is a default node port; use another"),
            AlreadyTooLate { tip, deadline } => write!(f, "tip {tip}: next height reaches deadline {deadline}"),
            WalletAddressMismatch { expected, actual } => {
                write!(f, "wallet address {actual} after import, expected {expected}")
            }
            PreviewRejected(e) => write!(f, "preview rejected: {e}"),
            PreviewTooLate { call_height, deadline } => {
                write!(f, "preview call height {call_height} >= deadline {deadline}")
            }
            HeightChanged => write!(f, "inclusion height changed between preview and submit"),
            TooManyAttempts { attempts } => write!(f, "gave up after {attempts} preview/submit attempts"),
            UnexpectedOutput(s) => write!(f, "runner returned the wrong output for step {s}"),
            SubmitMismatch(e) => write!(f, "submit result differs from the preview: {e}"),
            Command { step, detail } => write!(f, "step {step} failed: {detail}"),
        }
    }
}

impl std::error::Error for StockError {}

/// The 64-hex-plus-newline text piped to the import; its Debug never shows it.
#[derive(Clone)]
pub struct RedactedStdin(Zeroizing<String>);

impl RedactedStdin {
    /// The exact bytes to write to the child's stdin.
    pub fn expose(&self) -> &str {
        &self.0
    }
}

impl fmt::Debug for RedactedStdin {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "<redacted {} bytes>", self.0.len())
    }
}

impl PartialEq for RedactedStdin {
    fn eq(&self, o: &Self) -> bool {
        self.0.as_bytes() == o.0.as_bytes()
    }
}

/// One inspectable action of the fallback, in execution order.
#[derive(Debug, Clone, PartialEq)]
pub enum Step {
    /// JSON `{"opening_hex": ...}`, the file `read_opening` reads (`contracts.rs` L174-181).
    WriteObjectFile { path: PathBuf, opening_hex: String },
    /// Stop whatever node uses `data_dir` (the import must not race a running node).
    StopNode { data_dir: PathBuf },
    /// `parano1d --import-wallet-secret --data-dir D` with `stdin` on its standard input.
    ImportSecret { node_binary: PathBuf, data_dir: PathBuf, stdin: RedactedStdin },
    StartNode { node_binary: PathBuf, data_dir: PathBuf, rpc_url: String, p2p_listen: String },
    /// RPC `walletActiveAddress` must return `expected_address`.
    WaitWalletReady { rpc_url: String, expected_address: String },
    Preview { cli_binary: PathBuf, rpc_url: String, object_file: PathBuf, slot: u32, creation_id: u64, fee: u64 },
    Submit {
        cli_binary: PathBuf,
        rpc_url: String,
        object_file: PathBuf,
        slot: u32,
        creation_id: u64,
        fee: u64,
        expected_txid: String,
        out: PathBuf,
    },
    /// REVIEW-2 F2: `BIN verify <raw|stock> <H hex> <A hex> <receipt>` (the `equiv-prove` command of
    /// `equiv/zkvm/host`). Run by `swap-cli new-bob --receipt` through [`crate::equiv::ProcessRunner`];
    /// it touches no wallet and no chain.
    EquivVerify { bin: PathBuf, variant: Variant, h: [u8; 32], a: [u8; 32], receipt: PathBuf },
}

/// micro-NOID as the CLI's `--fee` text (`parse_noid_amount`: up to 6 decimals).
pub fn format_noid(micro: u64) -> String {
    format!("{}.{:06}", micro / 1_000_000, micro % 1_000_000)
}

fn text(p: &Path) -> String {
    p.to_string_lossy().into_owned()
}

fn call_argv(cli: &Path, rpc: &str, obj: &Path, slot: u32, cid: u64, fee: u64) -> Vec<String> {
    let mut v = vec![text(cli), "--json".into(), "--rpc".into(), rpc.into(), "contract".into(), "call".into()];
    v.extend([text(obj), slot.to_string(), cid.to_string(), "--close".into(), "--fee".into(), format_noid(fee)]);
    v
}

impl Step {
    pub fn label(&self) -> &'static str {
        match self {
            Step::WriteObjectFile { .. } => "write_object_file",
            Step::StopNode { .. } => "stop_node",
            Step::ImportSecret { .. } => "import_secret",
            Step::StartNode { .. } => "start_node",
            Step::WaitWalletReady { .. } => "wait_wallet_ready",
            Step::Preview { .. } => "preview",
            Step::Submit { .. } => "submit",
            Step::EquivVerify { .. } => "equiv_verify",
        }
    }

    /// The program and arguments a real runner would spawn; `None` for steps that
    /// are not a single command. The stdin of `ImportSecret` is never part of it.
    pub fn argv(&self) -> Option<Vec<String>> {
        match self {
            Step::ImportSecret { node_binary, data_dir, .. } => Some(vec![
                text(node_binary),
                "--import-wallet-secret".into(),
                "--data-dir".into(),
                text(data_dir),
            ]),
            Step::StartNode { node_binary, data_dir, rpc_url, p2p_listen } => Some(vec![
                text(node_binary),
                "--data-dir".into(),
                text(data_dir),
                "--rpc-listen".into(),
                rpc_url.trim_start_matches("http://").trim_end_matches('/').into(),
                "--p2p-listen".into(),
                p2p_listen.clone(),
            ]),
            Step::Preview { cli_binary, rpc_url, object_file, slot, creation_id, fee } => {
                let mut v = call_argv(cli_binary, rpc_url, object_file, *slot, *creation_id, *fee);
                v.push("--preview".into());
                Some(v)
            }
            Step::Submit { cli_binary, rpc_url, object_file, slot, creation_id, fee, expected_txid, out } => {
                let mut v = call_argv(cli_binary, rpc_url, object_file, *slot, *creation_id, *fee);
                v.extend(["--expected-txid".into(), expected_txid.clone(), "--out".into(), text(out)]);
                v.extend(["--wait-seconds".into(), "0".into()]);
                Some(v)
            }
            Step::EquivVerify { bin, variant, h, a, receipt } => Some(vec![
                text(bin),
                "verify".into(),
                variant.to_string(),
                hex::encode(h),
                hex::encode(a),
                text(receipt),
            ]),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct PreviewPayout {
    pub address: String,
    pub amount_micronoid: u64,
}

/// The fields of the CLI's `--preview` JSON (`ObjectCallPreview`, `object_types.rs` L227-237) that matter here.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct PreviewOut {
    pub txid: String,
    pub call_height: u64,
    pub authority: String,
    pub recovery: bool,
    pub terminal: bool,
    pub fee_micronoid: u64,
    pub payout: Option<PreviewPayout>,
}

/// What a step returned.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum StepOutput {
    Done,
    /// `WaitWalletReady`: the wallet's active address.
    Address(String),
    Preview(PreviewOut),
    /// `Submit`: the transaction id and call height the node reported.
    Submitted { txid: String, call_height: u64 },
    /// `EquivVerify`: the standard output of a run that exited 0.
    Verified { stdout: String },
}

/// Executes steps. Test mocks, plus [`crate::equiv::ProcessRunner`] for `Step::EquivVerify` alone.
pub trait CommandRunner {
    fn run(&mut self, step: &Step) -> Result<StepOutput, StockError>;
}

/// Everything `run_stock_claim` needs.
#[derive(Debug, Clone)]
pub struct StockClaimRequest {
    pub public: SwapPublic,
    pub instance: NoidInstance,
    /// The revealed `m`.
    pub secret: Secret,
    pub data_dir: PathBuf,
    /// Create the marker, allowed only in a missing or empty directory.
    pub create_marker: bool,
    pub node_binary: PathBuf,
    pub cli_binary: PathBuf,
    /// Loopback only, e.g. `http://127.0.0.1:19601`, not a default node port.
    pub rpc_url: String,
    pub p2p_listen: String,
    pub fee_micronoid: u64,
    /// Where the CLI saves the call artifact (must not exist: the CLI creates it with create-new).
    pub out_file: PathBuf,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RetryRecord {
    pub attempt: u32,
    pub preview_txid: String,
    pub preview_call_height: u64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StockClaimReport {
    /// Labels of every step run, in order (secrets are never recorded).
    pub steps: Vec<&'static str>,
    pub txid: String,
    pub call_height: u64,
    pub attempts: u32,
    /// The attempts that ended in `HeightChanged`.
    pub retries: Vec<RetryRecord>,
    /// The accepted height is in `(D-18, D-1]`: valid but possibly reorg-exposed.
    pub late_but_valid: bool,
}

fn norm(p: &Path) -> String {
    let mut t = p.to_string_lossy().to_lowercase().replace('\\', "/");
    if let Some(rest) = t.strip_prefix("/mnt/c/") {
        t = format!("c:/{rest}");
    }
    while t.contains("//") {
        t = t.replace("//", "/");
    }
    t.trim_end_matches('/').to_string()
}

fn within(a: &str, b: &str) -> bool {
    a == b || a.starts_with(&format!("{b}/"))
}

/// Inside (or an ancestor of) a production dir, or any default `.parano1d` data dir.
fn is_protected(p: &Path) -> bool {
    let n = norm(p);
    n.ends_with("/.parano1d")
        || n.ends_with("/.parano1d/data")
        || n.contains("/.parano1d/data/")
        || PROTECTED_DIRS.iter().any(|d| within(&n, d) || within(d, &n))
}

fn port_of(addr: &str) -> Option<u16> {
    addr.trim_end_matches('/').rsplit_once(':').and_then(|(_, p)| p.parse().ok())
}

fn check_data_dir(req: &StockClaimRequest) -> Result<(), StockError> {
    let d = &req.data_dir;
    let shown = d.display().to_string();
    if is_protected(d) || std::fs::canonicalize(d).is_ok_and(|c| is_protected(&c)) {
        return Err(StockError::ProtectedDataDir(shown));
    }
    if !d.is_absolute() {
        return Err(StockError::DataDirNotAbsolute(shown));
    }
    let marker = d.join(MARKER_FILE);
    if marker.is_file() {
        return Ok(());
    }
    if !req.create_marker {
        return Err(StockError::MissingMarker(shown));
    }
    let io = |e: std::io::Error| StockError::MarkerNotCreatable(e.to_string());
    if d.exists() {
        if !d.is_dir() || std::fs::read_dir(d).map_err(io)?.next().is_some() {
            return Err(StockError::MarkerNotCreatable("directory exists and is not empty".into()));
        }
    } else {
        std::fs::create_dir_all(d).map_err(io)?;
    }
    std::fs::write(&marker, "Throwaway wallet for one atomic swap. Safe to wipe; never put a real wallet here.\n")
        .map_err(io)
}

fn preflight(req: &StockClaimRequest, tip: u64) -> Result<(), StockError> {
    let p = &req.public;
    if p.params.variant != Variant::Stock {
        return Err(StockError::WrongVariant);
    }
    p.check().map_err(|e| StockError::BadPublicSection(e.to_string()))?;
    if req.secret.is_public_test_vector() {
        return Err(StockError::PublicTestVector);
    }
    if req.secret.hashlock() != p.hashlock {
        return Err(StockError::HashlockMismatch);
    }
    if req.secret.authority(Variant::Stock).to_bech32() != p.claim_authority {
        return Err(StockError::SecretMismatch);
    }
    if p.params.bob_noid == p.claim_authority {
        return Err(StockError::RecipientIsAuthority);
    }
    // v1: any fee in [MIN_CLOSE_FEE, max_fee]; v2: exactly max_fee (the program asserts `fee == max_fee`).
    let (min, max) = p.params.contract_version.allowed_fee_range(p.params.max_fee_micronoid);
    if req.fee_micronoid < min || req.fee_micronoid > max {
        return Err(StockError::FeeOutOfRange { fee: req.fee_micronoid, min, max });
    }
    let host = req.rpc_url.strip_prefix("http://").map(|h| h.trim_end_matches('/'));
    let loopback = host.is_some_and(|h| ["127.0.0.1:", "localhost:", "[::1]:"].iter().any(|l| h.starts_with(l)));
    if !loopback {
        return Err(StockError::RpcNotLoopback(req.rpc_url.clone()));
    }
    for port in [port_of(&req.rpc_url), port_of(&req.p2p_listen)].into_iter().flatten() {
        if RESERVED_PORTS.contains(&port) {
            return Err(StockError::ReservedPort(port));
        }
    }
    check_data_dir(req)?;
    let d = p.params.deadline_height;
    if classify_claim_height(tip.saturating_add(1), d) == ClaimHeight::TooLate {
        return Err(StockError::AlreadyTooLate { tip, deadline: d });
    }
    Ok(())
}

/// Check a preview against everything the swap committed to.
fn verify_preview(req: &StockClaimRequest, pv: &PreviewOut) -> Result<ClaimHeight, StockError> {
    let bad = |m: &str| Err(StockError::PreviewRejected(m.to_string()));
    let p = &req.public;
    if pv.txid.len() != 64 || !pv.txid.bytes().all(|b| b.is_ascii_hexdigit()) {
        return bad("txid is not 64 hex characters");
    }
    if !pv.authority.eq_ignore_ascii_case(&p.claim_authority) {
        return bad("authority is not the claim authority");
    }
    if pv.recovery {
        return bad("preview is the recovery branch");
    }
    if !pv.terminal {
        return bad("preview is not a terminal close");
    }
    if pv.fee_micronoid != req.fee_micronoid {
        return bad("fee differs from the request");
    }
    match &pv.payout {
        Some(o) if o.address.eq_ignore_ascii_case(&p.params.bob_noid) => {
            if o.amount_micronoid != req.instance.amount_micronoid.saturating_sub(pv.fee_micronoid) {
                return bad("payout amount is not balance minus fee");
            }
        }
        _ => return bad("close does not pay Bob's address"),
    }
    match classify_claim_height(pv.call_height, p.params.deadline_height) {
        ClaimHeight::TooLate => {
            Err(StockError::PreviewTooLate { call_height: pv.call_height, deadline: p.params.deadline_height })
        }
        h => Ok(h),
    }
}

/// Run the whole fallback through `runner`. `tip_now` is the chain tip used for
/// the up-front deadline check. Returns only after a verified, bound submission.
pub fn run_stock_claim<R: CommandRunner + ?Sized>(
    req: &StockClaimRequest,
    runner: &mut R,
    tip_now: impl Fn() -> u64,
) -> Result<StockClaimReport, StockError> {
    preflight(req, tip_now())?;
    let mut steps: Vec<&'static str> = Vec::new();
    let mut exec = |step: Step| -> Result<StepOutput, StockError> {
        steps.push(step.label());
        runner.run(&step)
    };
    let object_file = req.data_dir.join("swap-object.json");
    let expected = req.public.claim_authority.clone();
    let mut stdin = Zeroizing::new(String::new());
    stdin.push_str(&req.secret.stock_import_hex());
    stdin.push('\n');

    exec(Step::WriteObjectFile { path: object_file.clone(), opening_hex: req.public.opening_hex.clone() })?;
    exec(Step::StopNode { data_dir: req.data_dir.clone() })?;
    exec(Step::ImportSecret {
        node_binary: req.node_binary.clone(),
        data_dir: req.data_dir.clone(),
        stdin: RedactedStdin(stdin),
    })?;
    exec(Step::StartNode {
        node_binary: req.node_binary.clone(),
        data_dir: req.data_dir.clone(),
        rpc_url: req.rpc_url.clone(),
        p2p_listen: req.p2p_listen.clone(),
    })?;
    match exec(Step::WaitWalletReady { rpc_url: req.rpc_url.clone(), expected_address: expected.clone() })? {
        StepOutput::Address(a) if a.eq_ignore_ascii_case(&expected) => {}
        StepOutput::Address(actual) => return Err(StockError::WalletAddressMismatch { expected, actual }),
        _ => return Err(StockError::UnexpectedOutput("wait_wallet_ready")),
    }

    let mut retries = Vec::new();
    for attempt in 1..=MAX_ATTEMPTS {
        let pv = match exec(Step::Preview {
            cli_binary: req.cli_binary.clone(),
            rpc_url: req.rpc_url.clone(),
            object_file: object_file.clone(),
            slot: req.instance.slot_index,
            creation_id: req.instance.creation_id,
            fee: req.fee_micronoid,
        })? {
            StepOutput::Preview(pv) => pv,
            _ => return Err(StockError::UnexpectedOutput("preview")),
        };
        let class = verify_preview(req, &pv)?;
        let submit = Step::Submit {
            cli_binary: req.cli_binary.clone(),
            rpc_url: req.rpc_url.clone(),
            object_file: object_file.clone(),
            slot: req.instance.slot_index,
            creation_id: req.instance.creation_id,
            fee: req.fee_micronoid,
            expected_txid: pv.txid.clone(),
            out: req.out_file.clone(),
        };
        match exec(submit) {
            Ok(StepOutput::Submitted { txid, call_height }) => {
                if txid != pv.txid || call_height != pv.call_height {
                    return Err(StockError::SubmitMismatch(format!(
                        "previewed {} at {}, submitted {txid} at {call_height}",
                        pv.txid, pv.call_height
                    )));
                }
                return Ok(StockClaimReport {
                    steps,
                    txid,
                    call_height,
                    attempts: attempt,
                    retries,
                    late_but_valid: class == ClaimHeight::LateButValid,
                });
            }
            Ok(_) => return Err(StockError::UnexpectedOutput("submit")),
            Err(StockError::HeightChanged) => {
                retries.push(RetryRecord { attempt, preview_txid: pv.txid, preview_call_height: pv.call_height });
            }
            Err(e) => return Err(e),
        }
    }
    Err(StockError::TooManyAttempts { attempts: MAX_ATTEMPTS })
}
