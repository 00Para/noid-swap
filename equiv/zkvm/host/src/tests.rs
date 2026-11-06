//! Unit tests of the host CLI logic.
//!
//! * Remote-prover refusal: pure, always run.
//! * Negative tests of `verify`: need real receipts produced by this very guest. They are gated on
//!   `EQUIV_RECEIPT_DIR=<dir containing raw.receipt and stock.receipt>` and are SKIPPED (pass, with a
//!   message) when it is unset or the files are absent. The receipts are copied into a private temp dir
//!   first; the originals are never opened for writing.
//!
//!   EQUIV_RECEIPT_DIR=~/zkvm-out cargo test --release -p equiv-host -- --nocapture
//!
//! No test proves anything (a prove takes 20-75 minutes); the verifier is cheap (< 1 s per call).

use super::*;
use equiv_portable as p;
use risc0_zkvm::{InnerReceipt, Journal};
use std::collections::HashMap;
use std::path::PathBuf;

// ---------------------------------------------------------------- remote-prover refusal

fn env_of(pairs: &[(&str, &str)]) -> impl Fn(&str) -> Option<String> {
    let m: HashMap<String, String> = pairs.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect();
    move |k| m.get(k).cloned()
}

#[test]
fn prove_allowed_with_clean_or_local_environment() {
    assert_eq!(remote_prover_violation(&env_of(&[])), None);
    assert_eq!(remote_prover_violation(&env_of(&[("RISC0_PROVER", "")])), None);
    assert_eq!(remote_prover_violation(&env_of(&[("RISC0_PROVER", "ipc")])), None);
    assert_eq!(remote_prover_violation(&env_of(&[("RISC0_PROVER", "LOCAL")])), None);
    // unrelated variables the host itself uses
    assert_eq!(remote_prover_violation(&env_of(&[("EQUIV_SEGMENT_PO2", "18"), ("RISC0_SERVER_PATH", "/x/r0vm")])), None);
}

#[test]
fn prove_refused_when_bonsai_variables_set() {
    for (k, v) in [
        ("BONSAI_API_URL", "https://api.bonsai.xyz"),
        ("BONSAI_API_KEY", "abc"),
        ("BONSAI_API_KEY", ""), // set but empty still counts
        ("BONSAI_API_URL", ""),
    ] {
        let why = remote_prover_violation(&env_of(&[(k, v)])).unwrap_or_else(|| panic!("{k}={v:?} must be refused"));
        assert!(why.contains(k), "{why}");
    }
    // both set
    assert!(remote_prover_violation(&env_of(&[("BONSAI_API_URL", "u"), ("BONSAI_API_KEY", "k")])).is_some());
}

#[test]
fn prove_refused_when_remote_prover_selected() {
    for v in ["bonsai", "BONSAI", " Bonsai ", "actor", "garbage"] {
        let why = remote_prover_violation(&env_of(&[("RISC0_PROVER", v)])).unwrap_or_else(|| panic!("RISC0_PROVER={v:?} must be refused"));
        assert!(why.contains("RISC0_PROVER"), "{why}");
    }
}

// ---------------------------------------------------------------- dev mode (REVIEW-3 G1)

#[test]
fn dev_mode_variable_is_refused_whatever_its_value() {
    assert_eq!(dev_mode_violation(&env_of(&[])), None);
    assert_eq!(dev_mode_violation(&env_of(&[("RISC0_PROVER", "ipc")])), None);
    for v in ["1", "true", "yes", "0", ""] {
        let why = dev_mode_violation(&env_of(&[("RISC0_DEV_MODE", v)])).unwrap_or_else(|| panic!("RISC0_DEV_MODE={v:?} must be refused"));
        assert!(why.contains("RISC0_DEV_MODE"), "{why}");
    }
}

/// A dishonest Alice's best try: a fake receipt whose claim names our image id and whose journal is exactly
/// `variant || H || A` for the values she wants Bob to accept. It must fail as a receipt, before the journal check.
#[test]
fn fake_receipt_is_rejected_by_kind() {
    use risc0_zkvm::{FakeReceipt, ReceiptClaim};
    let journal = p::encode_public(p::VARIANT_RAW, &h(), &a_raw()).to_vec();
    let claim = ReceiptClaim::ok(EQUIV_GUEST_ID, journal.clone());
    let fake = Receipt::new(InnerReceipt::Fake(FakeReceipt::new(claim)), journal);
    match check_receipt(&fake, EQUIV_GUEST_ID, p::VARIANT_RAW, &h(), &a_raw()) {
        Err(Rejection::Receipt(why)) => assert!(why.contains("fake"), "{why}"),
        other => panic!("a fake receipt must be rejected as a receipt failure, got {other:?}"),
    }
}

// ---------------------------------------------------------------- secret on stdin / prove args

const HEX64: &str = "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f";

fn m_bytes() -> [u8; 32] {
    let mut m = [0u8; 32];
    for (i, b) in m.iter_mut().enumerate() {
        *b = i as u8;
    }
    m
}

#[test]
fn stdin_secret_accepts_bare_and_0x_hex_any_case_with_one_newline() {
    let up = HEX64.to_uppercase();
    for input in [
        HEX64.to_string(),
        format!("0x{HEX64}"),
        format!("0X{HEX64}"),
        format!("{HEX64}
"),
        format!("{HEX64}
"),
        format!("0x{HEX64}
"),
        up.clone(),
        format!("0x{up}
"),
        format!("  {HEX64}  
"),
    ] {
        assert_eq!(parse_secret_stdin(&input), Ok(m_bytes()), "input {input:?}");
    }
}

#[test]
fn stdin_secret_rejects_empty_extra_lines_and_wrong_length() {
    for input in ["", "
", "0x", "0x
", "   
"] {
        assert!(parse_secret_stdin(input).unwrap_err().contains("empty"), "input {input:?}");
    }
    // a second line, even a blank one or a second secret
    for input in [format!("{HEX64}

"), format!("{HEX64}
{HEX64}
"), format!("{HEX64}
x"), format!("{HEX64}

"), format!("a
{HEX64}")] {
        assert!(parse_secret_stdin(&input).unwrap_err().contains("exactly one line"), "input {input:?}");
    }
    // wrong length (and the error never contains the input)
    for input in [&HEX64[..62], &HEX64[..63], "00", &format!("{HEX64}00"), &format!("0x{}", &HEX64[..62])] {
        let e = parse_secret_stdin(input).unwrap_err();
        assert!(e.contains("64 hex characters"), "{e}");
        assert!(!e.contains(&HEX64[..8]), "error must not echo the secret: {e}");
    }
    // non-hex of the right length
    let bad = format!("zz{}", &HEX64[2..]);
    let e = parse_secret_stdin(&bad).unwrap_err();
    assert!(e.contains("non-hex") && !e.contains(&HEX64[2..10]), "{e}");
}

#[test]
fn prove_args_stdin_form_is_accepted() {
    let c = parse_prove_args(&["raw", "--secret-stdin", "alice.receipt"]).unwrap();
    assert_eq!(c, ProveCmd { variant: p::VARIANT_RAW, out: Some("alice.receipt".into()) });
    let c = parse_prove_args(&["stock", "--secret-stdin"]).unwrap();
    assert_eq!(c, ProveCmd { variant: p::VARIANT_STOCK, out: None });
}

#[test]
fn prove_args_positional_secret_is_refused_without_echo() {
    // the removed form `prove <raw|stock> <hex m> [out]`, with and without an output path, both variants
    for args in [
        vec!["raw", HEX64],
        vec!["raw", HEX64, "out.receipt"],
        vec!["stock", HEX64],
        vec!["stock", HEX64, "out.receipt"],
        vec!["raw", "0x000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f"],
    ] {
        let e = parse_prove_args(&args).expect_err("the positional secret form must be refused");
        assert!(e.contains("--secret-stdin") && e.contains("piped"), "{e}");
        assert!(!e.contains("0001") && !e.contains(&HEX64[..8]) && !e.contains("1e1f"), "the error must not echo the argument: {e}");
        assert!(!e.contains('\n'), "one-line error");
    }
    // a secret typed in the variant slot is not echoed either
    let e = parse_prove_args(&[HEX64, "--secret-stdin"]).unwrap_err();
    assert!(!e.contains("0001"), "{e}");
}

#[test]
fn prove_args_secret_looking_output_path_is_refused_without_echo() {
    let up = HEX64.to_uppercase();
    let with_0x = format!("0x{HEX64}");
    let with_0x_up = format!("0X{up}");
    for variant in ["raw", "stock"] {
        for out in [HEX64, up.as_str(), with_0x.as_str(), with_0x_up.as_str()] {
            let e = parse_prove_args(&[variant, "--secret-stdin", out]).expect_err("a secret-looking output path must be refused");
            assert!(e.contains("output path looks like a 64-hex secret") && e.contains("stdin"), "{e}");
            assert!(!e.contains("0001") && !e.contains("0001".to_uppercase().as_str()) && !e.contains("1e1f") && !e.contains("1E1F"), "the error must not echo the argument: {e}");
        }
    }
    // ordinary file names, including ones that are merely hex-ish or the wrong length, stay accepted
    for ok in ["alice.receipt", "00.receipt", &HEX64[..63], &format!("{HEX64}0"), &format!("{}zz", &HEX64[..62]), "0x"] {
        assert!(parse_prove_args(&["raw", "--secret-stdin", ok]).is_ok(), "{ok}");
    }
}

#[test]
fn prove_args_rejects_bad_usage() {
    assert!(parse_prove_args(&[]).is_err());
    assert!(parse_prove_args(&["other", "--secret-stdin"]).is_err());
    assert!(parse_prove_args(&["raw"]).is_err());
    assert!(parse_prove_args(&["raw", "--secret-stdin", "out", "extra"]).is_err());
    assert!(parse_prove_args(&["raw", HEX64, "out", "extra"]).is_err());
}

// ---------------------------------------------------------------- receipts (gated)

const H: &str = "630dcd2966c4336691125448bbb25b4ff412a49c732db2c8abc1b8581bd710dd";
const A_RAW: &str = "f8183db204ffb765c7015d851c1754e4974c675b975c6738d9f6d138eb7212cf";
const A_STOCK_O1: &str = "o125qayvgtmvqnlhqmqwe08dza3acaax5mct3u5h4uen3qtrds3jfset7wlk";
const IMAGE_ID_HEX: &str = "7e9d8477c67a9971bf38bd6a3eb217cfb0a4b224062b2f2059d578c61d1c6187";

struct Fixture {
    dir: PathBuf,
    raw_path: PathBuf,
    stock_path: PathBuf,
    raw: Receipt,
    stock: Receipt,
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

/// Copy the real receipts into a private temp dir and load them from the copies.
fn fixture(test: &str) -> Option<Fixture> {
    let Some(src) = std::env::var_os("EQUIV_RECEIPT_DIR") else {
        println!("SKIPPED {test}: EQUIV_RECEIPT_DIR not set");
        return None;
    };
    let src = PathBuf::from(src);
    let (sr, ss) = (src.join("raw.receipt"), src.join("stock.receipt"));
    if !sr.is_file() || !ss.is_file() {
        println!("SKIPPED {test}: raw.receipt / stock.receipt not found in {}", src.display());
        return None;
    }
    let dir = std::env::temp_dir().join(format!("equiv-negtest-{}-{test}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    let (raw_path, stock_path) = (dir.join("raw.receipt"), dir.join("stock.receipt"));
    std::fs::copy(&sr, &raw_path).unwrap();
    std::fs::copy(&ss, &stock_path).unwrap();
    let raw = load_receipt(raw_path.to_str().unwrap()).expect("raw receipt deserializes");
    let stock = load_receipt(stock_path.to_str().unwrap()).expect("stock receipt deserializes");
    Some(Fixture { dir, raw_path, stock_path, raw, stock })
}

fn h() -> [u8; 32] {
    hex32(H)
}
fn a_raw() -> [u8; 32] {
    hex32(A_RAW)
}
fn a_stock() -> [u8; 32] {
    addr_arg(A_STOCK_O1)
}

fn check(r: &Receipt, variant: u8, h: &[u8; 32], a: &[u8; 32]) -> Result<(), Rejection> {
    check_receipt(r, EQUIV_GUEST_ID, variant, h, a)
}

fn is_receipt_rejection(r: Result<(), Rejection>) -> bool {
    matches!(r, Err(Rejection::Receipt(_)))
}

/// Offset of `needle` inside `hay`.
fn find(hay: &[u8], needle: &[u8]) -> usize {
    hay.windows(needle.len()).position(|w| w == needle).expect("needle present in serialization")
}

fn seal_of(r: &Receipt) -> &Vec<u32> {
    match &r.inner {
        InnerReceipt::Succinct(s) => &s.seal,
        _ => panic!("expected a succinct receipt"),
    }
}

fn seal_mut(r: &mut Receipt) -> &mut Vec<u32> {
    match &mut r.inner {
        InnerReceipt::Succinct(s) => &mut s.seal,
        _ => panic!("expected a succinct receipt"),
    }
}

#[test]
fn image_id_is_the_pinned_one() {
    // The receipts only verify while the guest is unchanged.
    assert_eq!(image_id_hex(), IMAGE_ID_HEX);
}

#[test]
fn positive_control_real_receipts_verify() {
    let Some(f) = fixture("positive_control") else { return };
    assert_eq!(check(&f.raw, p::VARIANT_RAW, &h(), &a_raw()), Ok(()));
    assert_eq!(check(&f.stock, p::VARIANT_STOCK, &h(), &a_stock()), Ok(()));
    // and through the file path used by the CLI
    let r = load_receipt(f.raw_path.to_str().unwrap()).unwrap();
    assert_eq!(check(&r, p::VARIANT_RAW, &h(), &a_raw()), Ok(()));
    let r = load_receipt(f.stock_path.to_str().unwrap()).unwrap();
    assert_eq!(check(&r, p::VARIANT_STOCK, &h(), &a_stock()), Ok(()));
    println!("NEG positive_control: raw OK, stock OK");
}

#[test]
fn neg_wrong_h() {
    let Some(f) = fixture("wrong_h") else { return };
    let mut n = 0;
    for bit in [0usize, 7, 100, 255] {
        let mut bad = h();
        bad[bit / 8] ^= 1 << (bit % 8);
        assert_eq!(check(&f.raw, p::VARIANT_RAW, &bad, &a_raw()), Err(Rejection::Journal), "raw, H bit {bit}");
        assert_eq!(check(&f.stock, p::VARIANT_STOCK, &bad, &a_stock()), Err(Rejection::Journal), "stock, H bit {bit}");
        n += 2;
    }
    println!("NEG wrong_h: {n}/{n} rejected (journal != variant||H||A)");
}

#[test]
fn neg_wrong_a() {
    let Some(f) = fixture("wrong_a") else { return };
    let mut n = 0;
    for bit in [0usize, 63, 128, 255] {
        let mut bad = a_raw();
        bad[bit / 8] ^= 1 << (bit % 8);
        assert_eq!(check(&f.raw, p::VARIANT_RAW, &h(), &bad), Err(Rejection::Journal), "raw, A bit {bit}");
        let mut bad = a_stock();
        bad[bit / 8] ^= 1 << (bit % 8);
        assert_eq!(check(&f.stock, p::VARIANT_STOCK, &h(), &bad), Err(Rejection::Journal), "stock, A bit {bit}");
        n += 2;
    }
    // the other variant's address
    assert_eq!(check(&f.raw, p::VARIANT_RAW, &h(), &a_stock()), Err(Rejection::Journal));
    assert_eq!(check(&f.stock, p::VARIANT_STOCK, &h(), &a_raw()), Err(Rejection::Journal));
    n += 2;
    println!("NEG wrong_a: {n}/{n} rejected (journal != variant||H||A)");
}

#[test]
fn neg_wrong_variant() {
    let Some(f) = fixture("wrong_variant") else { return };
    // genuine receipt, right H and A, wrong variant flag
    assert_eq!(check(&f.raw, p::VARIANT_STOCK, &h(), &a_raw()), Err(Rejection::Journal));
    assert_eq!(check(&f.stock, p::VARIANT_RAW, &h(), &a_stock()), Err(Rejection::Journal));
    // an invalid variant byte
    assert_eq!(check(&f.raw, 2, &h(), &a_raw()), Err(Rejection::Journal));
    println!("NEG wrong_variant: 3/3 rejected (raw as stock, stock as raw, variant byte 2)");
}

#[test]
fn neg_tampered_seal_structured() {
    let Some(f) = fixture("tampered_seal_structured") else { return };
    let len = seal_of(&f.raw).len();
    let mut n = 0;
    for idx in [0, 1, len / 4, len / 2, len - 2, len - 1] {
        for bit in [0u32, 31] {
            let mut r = f.raw.clone();
            seal_mut(&mut r)[idx] ^= 1 << bit;
            assert!(is_receipt_rejection(check(&r, p::VARIANT_RAW, &h(), &a_raw())), "seal word {idx} bit {bit} accepted");
            n += 1;
        }
    }
    println!("NEG tampered_seal_structured: {n}/{n} rejected (seal has {len} words; one bit flipped per case)");
}

#[test]
fn neg_tampered_receipt_bytes_in_seal() {
    let Some(f) = fixture("tampered_seal_bytes") else { return };
    let bytes = std::fs::read(&f.raw_path).unwrap();
    let seal = seal_of(&f.raw);
    let seal_le: Vec<u8> = seal.iter().flat_map(|w| w.to_le_bytes()).collect();
    let start = find(&bytes, &seal_le[..64]);
    assert_eq!(&bytes[start..start + seal_le.len()], &seal_le[..], "seal is contiguous in the bincode bytes");
    // 64 evenly spaced byte positions across the seal, plus first and last byte
    let mut offs: Vec<usize> = (0..64).map(|i| start + i * (seal_le.len() - 1) / 63).collect();
    offs.push(start);
    offs.push(start + seal_le.len() - 1);
    offs.sort();
    offs.dedup();
    let (mut rejected, mut deser_failed) = (0, 0);
    for off in &offs {
        let mut b = bytes.clone();
        b[*off] ^= 0x01; // one byte of the file, one bit of it
        match bincode::deserialize::<Receipt>(&b) {
            Err(_) => deser_failed += 1,
            Ok(r) => {
                assert!(is_receipt_rejection(check(&r, p::VARIANT_RAW, &h(), &a_raw())), "flip at file offset {off} accepted");
                rejected += 1;
            }
        }
    }
    // the same, through the CLI path (a file on disk), flipping a whole byte
    let mut b = bytes.clone();
    b[start + seal_le.len() / 2] ^= 0xff;
    let p2 = f.dir.join("tampered.receipt");
    std::fs::write(&p2, &b).unwrap();
    let r = load_receipt(p2.to_str().unwrap()).unwrap();
    assert!(is_receipt_rejection(check(&r, p::VARIANT_RAW, &h(), &a_raw())));
    println!(
        "NEG tampered_receipt_bytes_in_seal: {}/{} byte flips rejected by Receipt::verify ({} failed to deserialize); file of {} bytes, seal at offset {start}..{}; plus 1 full-byte (0xff) flip via file path rejected",
        rejected,
        offs.len(),
        deser_failed,
        bytes.len(),
        start + seal_le.len()
    );
    assert_eq!(deser_failed, 0, "flips inside the seal data should not break the framing");
}

#[test]
fn neg_tampered_journal_bytes_in_receipt() {
    let Some(f) = fixture("tampered_journal_bytes") else { return };
    let bytes = std::fs::read(&f.raw_path).unwrap();
    let j = f.raw.journal.bytes.clone();
    assert_eq!(j.len(), p::PUBLIC_LEN);
    let start = find(&bytes, &j);
    let mut n = 0;
    for i in [0usize, 1, 32, 33, 64] {
        let mut b = bytes.clone();
        b[start + i] ^= 0x01;
        let r: Receipt = bincode::deserialize(&b).unwrap();
        // the tampered journal now differs from what the proof commits to: rejected by verify itself
        assert!(is_receipt_rejection(check(&r, p::VARIANT_RAW, &h(), &a_raw())), "journal byte {i}");
        // and it is not rescued by claiming the tampered values either
        let mut hh = h();
        let mut aa = a_raw();
        let mut var = p::VARIANT_RAW;
        match i {
            0 => var ^= 1,
            1..=32 => hh[i - 1] ^= 1,
            _ => aa[i - 33] ^= 1,
        }
        assert!(is_receipt_rejection(check(&r, var, &hh, &aa)), "journal byte {i} with matching claim");
        n += 2;
    }
    println!("NEG tampered_journal_bytes_in_receipt: {n}/{n} rejected (one byte of the journal flipped inside the receipt file)");
}

#[test]
fn neg_wrong_image_id() {
    let Some(f) = fixture("wrong_image_id") else { return };
    // control: the right id passes
    assert_eq!(check_receipt(&f.raw, EQUIV_GUEST_ID, p::VARIANT_RAW, &h(), &a_raw()), Ok(()));
    let mut n = 0;
    // one bit flipped in each of the 8 words of the ImageID
    for w in 0..8 {
        let mut id = EQUIV_GUEST_ID;
        id[w] ^= 1;
        assert!(is_receipt_rejection(check_receipt(&f.raw, id, p::VARIANT_RAW, &h(), &a_raw())), "word {w}");
        assert!(is_receipt_rejection(check_receipt(&f.stock, id, p::VARIANT_STOCK, &h(), &a_stock())), "word {w} stock");
        n += 2;
    }
    // unrelated ids: all zero, all ones, and the real id with two words swapped
    let mut swapped = EQUIV_GUEST_ID;
    swapped.swap(0, 7);
    for id in [[0u32; 8], [0xffff_ffff; 8], swapped] {
        assert!(is_receipt_rejection(check_receipt(&f.raw, id, p::VARIANT_RAW, &h(), &a_raw())));
        n += 1;
    }
    println!("NEG wrong_image_id: {n}/{n} rejected (8 one-bit ids x 2 receipts, zero, 0xff.., two words swapped)");
}

#[test]
fn neg_foreign_journal() {
    let Some(f) = fixture("foreign_journal") else { return };
    let mut n = 0;

    // (a) a genuine proof, but for (H, A) values that are not the ones Bob claims: journal check.
    //     The raw receipt claimed to attest the stock address, and vice versa.
    assert_eq!(check(&f.raw, p::VARIANT_RAW, &h(), &a_stock()), Err(Rejection::Journal));
    assert_eq!(check(&f.stock, p::VARIANT_STOCK, &h(), &a_raw()), Err(Rejection::Journal));
    n += 2;

    // (b) the proof of one statement carrying the journal of another (an attacker splicing in the
    //     journal that makes his claim true): the journal no longer matches the proven claim.
    let mut spliced = f.raw.clone();
    spliced.journal = Journal::new(f.stock.journal.bytes.clone());
    assert!(is_receipt_rejection(check(&spliced, p::VARIANT_STOCK, &h(), &a_stock())), "raw proof + stock journal");
    let mut spliced = f.stock.clone();
    spliced.journal = Journal::new(f.raw.journal.bytes.clone());
    assert!(is_receipt_rejection(check(&spliced, p::VARIANT_RAW, &h(), &a_raw())), "stock proof + raw journal");
    n += 2;

    // (c) a journal of valid shape variant||H||A but for an A of the attacker's choosing, then a journal
    //     of the wrong length (truncated, extended) and an empty one
    let mut other_a = a_raw();
    other_a[0] ^= 0xa5;
    let forged = p::encode_public(p::VARIANT_RAW, &h(), &other_a).to_vec();
    let mut r = f.raw.clone();
    r.journal = Journal::new(forged);
    assert!(is_receipt_rejection(check(&r, p::VARIANT_RAW, &h(), &other_a)), "forged journal for another A");
    n += 1;
    for bad in [f.raw.journal.bytes[..64].to_vec(), [f.raw.journal.bytes.clone(), vec![0]].concat(), Vec::new()] {
        let len = bad.len();
        let mut r = f.raw.clone();
        r.journal = Journal::new(bad);
        assert!(is_receipt_rejection(check(&r, p::VARIANT_RAW, &h(), &a_raw())), "journal of {len} bytes");
        n += 1;
    }
    println!(
        "NEG foreign_journal: {n}/{n} rejected (genuine proof for other values -> journal check; spliced / forged / truncated / extended / empty journals -> Receipt::verify)"
    );
}

#[test]
fn neg_garbage_and_truncated_files() {
    let Some(f) = fixture("garbage_files") else { return };
    let bytes = std::fs::read(&f.raw_path).unwrap();
    let mut n = 0;
    for (name, content) in [
        ("empty", Vec::new()),
        ("truncated", bytes[..bytes.len() / 2].to_vec()),
        ("zeros", vec![0u8; bytes.len()]),
    ] {
        let path = f.dir.join(format!("{name}.receipt"));
        std::fs::write(&path, content).unwrap();
        match load_receipt(path.to_str().unwrap()) {
            Err(_) => {}
            Ok(r) => assert!(check(&r, p::VARIANT_RAW, &h(), &a_raw()).is_err(), "{name} accepted"),
        }
        n += 1;
    }
    assert!(load_receipt(f.dir.join("missing.receipt").to_str().unwrap()).is_err());
    n += 1;
    println!("NEG garbage_and_truncated_files: {n}/{n} rejected");
}
