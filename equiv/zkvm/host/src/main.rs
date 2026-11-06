//! equiv-prove: produce / verify the zkVM proof that  sha256(m) = H  and  A = Addr(m) [raw]
//! or A = Addr(Derive(m,0)) [stock wallet].
//!
//!   equiv-prove prove  <raw|stock> --secret-stdin [out.receipt]   (Alice, holds m; m read from stdin)
//!   equiv-prove verify <raw|stock> <64-hex H> <A as 64-hex or o1...> <in.receipt>   (Bob)
//!   equiv-prove image-id                                        (print the guest ImageID)
//!
//! `prove` refuses to run when a remote prover is selected (BONSAI_API_URL / BONSAI_API_KEY set, or
//! RISC0_PROVER other than ipc/local): the secret m must never leave this machine.
//!
//! `prove` and `verify` both refuse to run with `RISC0_DEV_MODE` set, and `verify` rejects a dev-mode (fake)
//! receipt by kind; the binary is built with risc0's `disable-dev-mode` feature (REVIEW-3 G1).
//!
//! Bob must compare the printed ImageID with one he obtained from a reproducible build of
//! methods/guest (`cargo risczero build`), NOT with one supplied by Alice.
//!
//! `EQUIV_SEGMENT_PO2=<n>` (optional, prove only): segment size 2^n cycles instead of risc0's
//! default 20; use 18–19 on machines with < 4 GB for the prover.

use equiv_methods::{EQUIV_GUEST_ELF, EQUIV_GUEST_ID};
use equiv_portable as p;
use risc0_zkvm::{sha::Digest, InnerReceipt, Receipt};

fn die(msg: &str) -> ! {
    eprintln!("error: {msg}");
    std::process::exit(2);
}

fn hex32(s: &str) -> [u8; 32] {
    let v = hex::decode(s.trim().trim_start_matches("0x")).unwrap_or_else(|e| die(&format!("bad hex: {e}")));
    <[u8; 32]>::try_from(v.as_slice()).unwrap_or_else(|_| die("need exactly 32 bytes"))
}

/// Parse the secret from the text read on stdin: exactly one line holding 64 hex characters, with or
/// without a `0x` prefix (either case), optionally followed by a single line terminator (`\n` or `\r\n`).
/// Anything else is rejected. Error messages never include the input.
fn parse_secret_stdin(input: &str) -> Result<[u8; 32], String> {
    let line = input.strip_suffix('\n').map(|l| l.strip_suffix('\r').unwrap_or(l)).unwrap_or(input);
    if line.contains('\n') || line.contains('\r') {
        return Err("stdin must contain exactly one line (the 64-hex secret)".into());
    }
    let line = line.trim();
    let hex_part = line.strip_prefix("0x").or_else(|| line.strip_prefix("0X")).unwrap_or(line);
    if hex_part.is_empty() {
        return Err("stdin is empty: expected the 64-hex secret".into());
    }
    if hex_part.len() != 64 {
        return Err(format!("secret must be exactly 64 hex characters, got {}", hex_part.len()));
    }
    let v = hex::decode(hex_part).map_err(|_| "secret contains a non-hex character".to_string())?;
    Ok(<[u8; 32]>::try_from(v.as_slice()).expect("64 hex chars decode to 32 bytes"))
}

fn read_secret_stdin() -> [u8; 32] {
    use std::io::{IsTerminal, Read};
    // A typed secret would be echoed by the terminal (and kept in scrollback): demand a pipe or a file.
    if std::io::stdin().is_terminal() {
        die("refusing: --secret-stdin needs a pipe or a file on stdin, not a terminal (a typed secret would be echoed)");
    }
    let mut buf = String::new();
    // Bounded read: a valid input is at most ~68 bytes; 4 KiB is plenty and caps a runaway pipe.
    if let Err(e) = std::io::stdin().take(4096).read_to_string(&mut buf) {
        die(&format!("reading the secret from stdin: {e}"));
    }
    parse_secret_stdin(&buf).unwrap_or_else(|e| die(&e))
}

/// `prove` always reads the secret from stdin (the old positional `<hex m>` form was removed on
/// 2026-11-04: a secret in argv shows up in process listings and shell history).
#[derive(Debug, PartialEq, Eq)]
struct ProveCmd {
    variant: u8,
    out: Option<String>,
}

/// True when `s` is 64 hex characters, with or without a `0x`/`0X` prefix: almost certainly a secret
/// pasted into the receipt-path slot.
fn looks_like_secret(s: &str) -> bool {
    let h = s.strip_prefix("0x").or_else(|| s.strip_prefix("0X")).unwrap_or(s);
    h.len() == 64 && h.bytes().all(|b| b.is_ascii_hexdigit())
}

/// Parse the arguments after `prove`: only `<raw|stock> --secret-stdin [out]`. `Err` is a usage problem.
/// The error text never echoes an argument other than a fixed word, so a secret typed in the wrong
/// place cannot land in a log through it.
fn parse_prove_args(args: &[&str]) -> Result<ProveCmd, String> {
    const MUST_PIPE: &str = "the secret must be piped with --secret-stdin (a secret on the command line is not accepted)";
    let (v, rest) = args.split_first().ok_or("missing variant")?;
    let variant = match *v {
        "raw" => p::VARIANT_RAW,
        "stock" => p::VARIANT_STOCK,
        _ => return Err("variant must be 'raw' or 'stock'".into()),
    };
    match rest {
        ["--secret-stdin"] => Ok(ProveCmd { variant, out: None }),
        ["--secret-stdin", out] if looks_like_secret(out) => Err("refusing: the output path looks like a 64-hex secret; the secret must come through stdin, the receipt path is a file name".into()),
        ["--secret-stdin", out] => Ok(ProveCmd { variant, out: Some(out.to_string()) }),
        _ => Err(format!("expected --secret-stdin [out.receipt]: {MUST_PIPE}")),
    }
}

fn addr_arg(s: &str) -> [u8; 32] {
    if s.starts_with("o1") || s.starts_with("O1") {
        let (hrp, data) = bech32::decode(s).unwrap_or_else(|e| die(&format!("bad o1 address: {e}")));
        if hrp.as_str().to_ascii_lowercase() != "o" || data.len() != 32 {
            die("not a 32-byte o1 address");
        }
        let mut a = [0u8; 32];
        a.copy_from_slice(&data);
        a
    } else {
        hex32(s)
    }
}

fn variant_arg(s: &str) -> u8 {
    match s {
        "raw" => p::VARIANT_RAW,
        "stock" => p::VARIANT_STOCK,
        _ => die("variant must be 'raw' or 'stock'"),
    }
}

fn image_id_hex() -> String {
    // ImageID is [u32; 8]; print as the 32 bytes the receipt/journal tooling shows (LE words).
    let mut out = Vec::new();
    for w in EQUIV_GUEST_ID {
        out.extend_from_slice(&w.to_le_bytes());
    }
    hex::encode(out)
}

/// Why the secret must never leave this machine: `prove` hands `m` to the prover as the guest's
/// private input. A remote prover (Bonsai, a prover network) would receive it in the clear.
///
/// risc0-zkvm 3.0.6 (`src/host/client/prove/mod.rs`, `default_prover()`) selects a remote prover when
///   * `RISC0_PROVER=bonsai` (any `RISC0_PROVER` value other than `ipc` / `local` is not a prover we
///     have audited as local: `actor` spawns an r0vm cluster that may be distributed, others panic), or
///   * `BONSAI_API_URL` and `BONSAI_API_KEY` are both set (and dev mode is off).
/// We refuse if either `BONSAI_API_URL` or `BONSAI_API_KEY` is set at all (even empty, even one of the
/// two: the second may be supplied by a config file or the next shell), and if `RISC0_PROVER` is set to
/// anything but `ipc` / `local`. Variable names are matched exactly; the lookup is injected so the rule
/// is unit-testable without touching the process environment.
const REMOTE_PROVER_VARS: [&str; 2] = ["BONSAI_API_URL", "BONSAI_API_KEY"];

fn remote_prover_violation(get: &dyn Fn(&str) -> Option<String>) -> Option<String> {
    for var in REMOTE_PROVER_VARS {
        if get(var).is_some() {
            return Some(format!(
                "{var} is set: this would send the secret m to a remote prover (Bonsai). Unset BONSAI_API_URL and BONSAI_API_KEY."
            ));
        }
    }
    if let Some(v) = get("RISC0_PROVER") {
        let v = v.trim().to_ascii_lowercase();
        if !v.is_empty() && v != "ipc" && v != "local" {
            return Some(format!(
                "RISC0_PROVER={v} is not a local prover (only 'ipc' or 'local' are allowed here): the secret m must never leave this machine."
            ));
        }
    }
    None
}

fn refuse_remote_proving() {
    let get = |k: &str| std::env::var_os(k).map(|v| v.to_string_lossy().into_owned());
    if let Some(why) = remote_prover_violation(&get) {
        die(&format!("refusing to prove: {why}"));
    }
}

/// REVIEW-3 G1: with `RISC0_DEV_MODE` set (`1`, `true` or `yes`), risc0's `VerifierContext::default()` enters dev
/// mode and a fake receipt (a claim with no seal) passes `Receipt::verify`. The binary is built with risc0's
/// `disable-dev-mode` feature, which turns that path into a panic; this check turns it into a plain refusal, for
/// `prove` and `verify` alike, whatever the variable's value (set is enough).
fn dev_mode_violation(get: &dyn Fn(&str) -> Option<String>) -> Option<String> {
    get("RISC0_DEV_MODE").map(|_| "RISC0_DEV_MODE is set: in dev mode a receipt without a proof would pass. Unset it.".to_string())
}

fn refuse_dev_mode() {
    let get = |k: &str| std::env::var_os(k).map(|v| v.to_string_lossy().into_owned());
    if let Some(why) = dev_mode_violation(&get) {
        die(&why);
    }
}

/// Where a receipt was rejected.
#[derive(Debug, PartialEq, Eq)]
enum Rejection {
    /// Deserialization failed or `Receipt::verify(image_id)` failed (bad/tampered proof, wrong ImageID,
    /// journal not the one the proof commits to).
    Receipt(String),
    /// The proof is genuine, but its journal is not `variant || H || A` for the claimed values.
    Journal,
}

/// Bob's check: the receipt verifies against `image_id` AND its journal is exactly `variant || H || A`.
fn check_receipt<I: Into<Digest>>(receipt: &Receipt, image_id: I, variant: u8, h: &[u8; 32], a: &[u8; 32]) -> Result<(), Rejection> {
    // REVIEW-3 G1: a dev-mode receipt is a claim with no seal. Refused by kind, whatever the verifier context says.
    if matches!(receipt.inner, InnerReceipt::Fake(_)) {
        return Err(Rejection::Receipt("dev-mode (fake) receipt: it carries no proof".into()));
    }
    receipt.verify(image_id).map_err(|e| Rejection::Receipt(e.to_string()))?;
    let expected = p::encode_public(variant, h, a);
    if receipt.journal.bytes != expected.to_vec() {
        return Err(Rejection::Journal);
    }
    Ok(())
}

fn load_receipt(path: &str) -> Result<Receipt, String> {
    let bytes = std::fs::read(path).map_err(|e| format!("read {path}: {e}"))?;
    bincode::deserialize(&bytes).map_err(|e| format!("bad receipt: {e}"))
}

fn prove(variant: u8, m: [u8; 32], out: Option<&str>) {
    use risc0_zkvm::{default_prover, ExecutorEnv, ProverOpts};
    use std::time::Instant;

    refuse_remote_proving();
    refuse_dev_mode();
    let mut builder = ExecutorEnv::builder();
    builder.write(&variant).unwrap().write(&m).unwrap();
    // Memory knob for small machines: smaller segments need less RAM per segment proof
    // (risc0 default 20 = 1 Mi cycles). Changes neither the ImageID nor the statement.
    if let Some(po2) = std::env::var("EQUIV_SEGMENT_PO2").ok().and_then(|s| s.parse::<u32>().ok()) {
        builder.segment_limit_po2(po2);
    }
    let env = builder.build().unwrap();
    let t = Instant::now();
    // Succinct receipt: constant-size-ish STARK-in-STARK; zero-knowledge is preserved.
    let info = default_prover()
        .prove_with_opts(env, EQUIV_GUEST_ELF, &ProverOpts::succinct())
        .unwrap_or_else(|e| die(&format!("proving failed: {e}")));
    let dt = t.elapsed();
    let receipt = info.receipt;
    receipt.verify(EQUIV_GUEST_ID).unwrap_or_else(|e| die(&format!("self-verify failed: {e}")));

    let (h, a) = p::statement(variant, &m).unwrap();
    let expected = p::encode_public(variant, &h, &a);
    assert_eq!(receipt.journal.bytes, expected.to_vec(), "journal != natively computed statement");

    let bytes = bincode::serialize(&receipt).unwrap();
    println!("variant      : {}", if variant == 0 { "raw" } else { "stock" });
    println!("H            : {}", hex::encode(h));
    println!("A            : {}", hex::encode(a));
    println!("image id     : {}", image_id_hex());
    println!("prove time   : {:.2?}", dt);
    println!("cycles       : user {} / total {}", info.stats.user_cycles, info.stats.total_cycles);
    println!("segments     : {}", info.stats.segments);
    println!("receipt size : {} bytes (bincode)", bytes.len());
    if let Some(path) = out {
        std::fs::write(path, &bytes).unwrap_or_else(|e| die(&format!("write {path}: {e}")));
        println!("receipt      : {path}");
    }
}

fn verify(variant: u8, h: [u8; 32], a: [u8; 32], path: &str) {
    refuse_dev_mode();
    let receipt = load_receipt(path).unwrap_or_else(|e| die(&e));
    match check_receipt(&receipt, EQUIV_GUEST_ID, variant, &h, &a) {
        Ok(()) => {}
        Err(Rejection::Receipt(e)) => die(&format!("INVALID: receipt does not verify against this guest ImageID: {e}")),
        Err(Rejection::Journal) => die("INVALID: journal does not equal variant||H||A for the claimed (H, A)"),
    }
    println!("OK: exists m with sha256(m) = H and {} = A", if variant == 0 { "Addr(m)" } else { "Addr(Derive(m,0))" });
    println!("image id: {}", image_id_hex());
}

const USAGE: &str = "usage: <secret as 64-hex on one line> | equiv-prove prove <raw|stock> --secret-stdin [out.receipt]   (stdin must be a pipe or file, not a terminal)
       equiv-prove verify <raw|stock> <hex H> <A hex or o1...> <receipt>
       equiv-prove image-id";

fn main() {
    let a: Vec<String> = std::env::args().skip(1).collect();
    match a.iter().map(String::as_str).collect::<Vec<_>>().as_slice() {
        ["prove", rest @ ..] => {
            let cmd = parse_prove_args(rest).unwrap_or_else(|e| die(&format!("{e}\n{USAGE}")));
            // Refuse a remote prover or dev mode before the secret is even read from the pipe.
            refuse_remote_proving();
            refuse_dev_mode();
            prove(cmd.variant, read_secret_stdin(), cmd.out.as_deref())
        }
        ["verify", v, h, addr, f] => verify(variant_arg(v), hex32(h), addr_arg(addr), f),
        ["image-id"] => println!("{}", image_id_hex()),
        _ => die(USAGE),
    }
}

#[cfg(test)]
mod tests;
