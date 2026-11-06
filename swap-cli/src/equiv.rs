//! REVIEW-2 F2: Bob's tool runs the equivalence-proof verifier itself.
//!
//! Plain words. Before Bob locks ETH he needs proof that the hashlock `H` on Ethereum and the
//! NOID address `A` come from the SAME secret (otherwise Alice could lock NOID that nobody can
//! ever claim, design T10). That proof is a RISC Zero receipt; the `equiv-prove verify` program
//! checks it. Before F2 Bob ran that program by hand and typed its answers into `new-bob`, which
//! proved nothing about whether it was ever run. Now `new-bob --receipt FILE --equiv-prove BIN`
//! runs `BIN verify <variant> <H> <A> FILE` as a subprocess with H and A read from the bundle
//! (never typed), requires exit status 0, parses the image id it prints, and requires it to equal
//! the image id compiled into this tool (`params::EQUIV_IMAGE_ID`, REVIEW-3 F2). The result is stored in Bob's swap file as a `receipt` attestation.
//!
//! The subprocess goes through the [`CommandRunner`] trait (`client::stock`), so tests fake it;
//! [`ProcessRunner`] is the real implementation and runs `Step::EquivVerify` only.
//!
//! What `equiv-prove verify` prints (`equiv/zkvm/host/src/main.rs`, `fn verify`), exit 0 only on success:
//!
//! ```text
//! OK: exists m with sha256(m) = H and Addr(m) = A            (stock: Addr(Derive(m,0)))
//! image id: <64 hex>
//! ```
//!
//! It does not print H or A (it received them as arguments), so "the output names the same H and A"
//! is enforced here in two ways: the tool passes the bundle's values, and the OK line must name the
//! right variant. If a verifier ever echoes `H : <hex>` or `A : <hex>` lines (as `equiv-prove prove`
//! does) they must equal the bundle's, or the run is rejected.

use std::fmt;
use std::path::Path;
use std::process::{Command, Stdio};

use crate::child_env;
use crate::client::stock::{CommandRunner, Step, StepOutput, StockError};
use crate::params::EQUIV_IMAGE_ID;
use crate::secret::{parse_hex32, sha256, Variant};
use crate::swapfile::{AttestationSource, EquivalenceAttestation, SwapPublic};

/// Why the receipt was not accepted.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum EquivError {
    /// The bundle itself is unusable (no authority bytes).
    Bundle(String),
    /// The receipt file could not be read.
    ReceiptUnreadable(String),
    /// The verifier could not be started, or exited non-zero (INVALID receipt, wrong image id inside the
    /// verifier, missing file ...).
    Verifier(String),
    /// The runner answered with something that is not a verifier run.
    UnexpectedOutput,
    /// Exit 0 but the output is not the verifier's OK output.
    BadOutput(String),
    /// The verifier's image id is not the one compiled into this tool (`params::EQUIV_IMAGE_ID`, REVIEW-3 F2; T10).
    ImageIdMismatch { got: [u8; 32], pinned: [u8; 32] },
}

impl fmt::Display for EquivError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            EquivError::Bundle(e) => write!(f, "equivalence proof: bundle: {e}"),
            EquivError::ReceiptUnreadable(e) => write!(f, "equivalence proof: cannot read the receipt: {e}"),
            EquivError::Verifier(e) => write!(f, "equivalence proof: the verifier failed: {e}"),
            EquivError::UnexpectedOutput => write!(f, "equivalence proof: the runner returned the wrong kind of output"),
            EquivError::BadOutput(e) => write!(f, "equivalence proof: unexpected verifier output: {e}"),
            EquivError::ImageIdMismatch { got, pinned } => write!(
                f,
                "equivalence proof: the receipt was verified against image id {} but this tool pins {} (T10): refusing",
                hex::encode(got),
                hex::encode(pinned)
            ),
        }
    }
}

impl std::error::Error for EquivError {}

/// What the verifier is asked: the statement comes from the bundle.
#[derive(Debug, Clone)]
pub struct VerifyRequest<'a> {
    pub bin: &'a Path,
    pub variant: Variant,
    pub receipt: &'a Path,
}

/// Parse the verifier's standard output for `(variant, h, a)`; returns the image id it printed.
pub fn parse_verify_output(stdout: &str, variant: Variant, h: &[u8; 32], a: &[u8; 32]) -> Result<[u8; 32], EquivError> {
    let ok_line = format!(
        "OK: exists m with sha256(m) = H and {} = A",
        match variant {
            Variant::Raw => "Addr(m)",
            Variant::Stock => "Addr(Derive(m,0))",
        }
    );
    let mut saw_ok = false;
    let mut image: Option<[u8; 32]> = None;
    for line in stdout.lines() {
        let line = line.trim();
        if line.starts_with("INVALID") {
            return Err(EquivError::BadOutput(format!("the verifier reported: {line}")));
        }
        if line.starts_with("OK:") {
            if line != ok_line {
                return Err(EquivError::BadOutput(format!("OK line {line:?} does not name the {variant} variant")));
            }
            saw_ok = true;
            continue;
        }
        let Some((key, value)) = line.split_once(':') else { continue };
        let (key, value) = (key.trim(), value.trim());
        match key {
            "image id" => {
                let id = parse_hex32(value).map_err(|e| EquivError::BadOutput(format!("image id {value:?}: {e}")))?;
                if image.is_some_and(|prev| prev != id) {
                    return Err(EquivError::BadOutput("two different image ids were printed".into()));
                }
                image = Some(id);
            }
            "H" | "A" => {
                let want = if key == "H" { h } else { a };
                let got = parse_hex32(value).map_err(|e| EquivError::BadOutput(format!("{key} {value:?}: {e}")))?;
                if &got != want {
                    return Err(EquivError::BadOutput(format!("the verifier names a different {key} than the bundle's")));
                }
            }
            _ => {}
        }
    }
    if !saw_ok {
        return Err(EquivError::BadOutput("no OK line".into()));
    }
    image.ok_or_else(|| EquivError::BadOutput("no `image id:` line".into()))
}

/// Run the verifier on `req.receipt` for THIS bundle's `(variant, H, A)` and build the attestation.
/// `now` is recorded as `verified_at`.
pub fn verify_receipt<R: CommandRunner + ?Sized>(
    runner: &mut R,
    public: &SwapPublic,
    req: &VerifyRequest<'_>,
    now: u64,
) -> Result<EquivalenceAttestation, EquivError> {
    let h = public.hashlock;
    let a = public.authority().map_err(|e| EquivError::Bundle(e.to_string()))?.0;
    // Read the receipt first: a missing file is a plain error, not a verifier failure, and the digest
    // stored in Bob's file is of the bytes we saw.
    let bytes = std::fs::read(req.receipt).map_err(|e| EquivError::ReceiptUnreadable(format!("{}: {e}", req.receipt.display())))?;
    let step = Step::EquivVerify { bin: req.bin.to_path_buf(), variant: req.variant, h, a, receipt: req.receipt.to_path_buf() };
    let stdout = match runner.run(&step) {
        Ok(StepOutput::Verified { stdout }) => stdout,
        Ok(_) => return Err(EquivError::UnexpectedOutput),
        Err(StockError::Command { detail, .. }) => return Err(EquivError::Verifier(detail)),
        Err(e) => return Err(EquivError::Verifier(e.to_string())),
    };
    let image_id = parse_verify_output(&stdout, req.variant, &h, &a)?;
    if image_id != EQUIV_IMAGE_ID {
        return Err(EquivError::ImageIdMismatch { got: image_id, pinned: EQUIV_IMAGE_ID });
    }
    let mut journal = vec![req.variant.journal_byte()];
    journal.extend_from_slice(&h);
    journal.extend_from_slice(&a);
    Ok(EquivalenceAttestation {
        source: AttestationSource::Receipt,
        journal,
        image_id,
        pinned_image_id: EQUIV_IMAGE_ID,
        receipt_path: Some(req.receipt.display().to_string()),
        receipt_sha256: Some(sha256(&bytes)),
        verified_at: Some(now),
    })
}

/// The real runner for `Step::EquivVerify`: spawns the program directly (no shell), stdin closed,
/// both output streams captured. Every other step is refused: this crate never runs a wallet or a
/// node from here.
#[derive(Debug, Default, Clone, Copy)]
pub struct ProcessRunner;

impl CommandRunner for ProcessRunner {
    fn run(&mut self, step: &Step) -> Result<StepOutput, StockError> {
        let Step::EquivVerify { bin, .. } = step else {
            return Err(StockError::Command { step: step.label().into(), detail: "ProcessRunner only runs equiv_verify".into() });
        };
        let argv = step.argv().expect("equiv_verify has an argv");
        let fail = |detail: String| StockError::Command { step: "equiv_verify".into(), detail };
        let bin = bin.display();
        // REVIEW-3 F4 / G1: the child gets only the allow-listed environment (never SWAP_PASSPHRASE or RISC0_DEV_MODE).
        let mut cmd = Command::new(&argv[0]);
        child_env::apply(&mut cmd);
        let out = cmd
            .args(&argv[1..])
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .output()
            .map_err(|e| fail(format!("cannot run {bin}: {e}")))?;
        if !out.status.success() {
            let err = String::from_utf8_lossy(&out.stderr);
            let std = String::from_utf8_lossy(&out.stdout);
            let msg = [err.trim(), std.trim()].into_iter().filter(|s| !s.is_empty()).collect::<Vec<_>>().join(" | ");
            let code = out.status.code().map_or_else(|| "was killed by a signal".to_string(), |c| format!("returned exit status {c}"));
            return Err(fail(format!("{bin} {code}: {}", if msg.is_empty() { "(no output)" } else { &msg })));
        }
        Ok(StepOutput::Verified { stdout: String::from_utf8_lossy(&out.stdout).into_owned() })
    }
}
