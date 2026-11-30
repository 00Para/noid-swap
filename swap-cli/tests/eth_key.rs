//! The Ethereum swap key of one party (swap wallet, piece 2b, amendments A and K): the sealed field of the swap file, the standalone key file, and the
//! `ethkey` commands and `--eth-key` flags through the binary. Nothing here talks to a network.

#[path = "common/equiv_stub.rs"]
mod equiv_stub;
#[path = "common/home.rs"]
mod home;

use std::io::Write as _;
use std::process::{Command, Stdio};

use htlc_harness as h;
use swap_cli::ethkey::{address_hex, parse_key, EthKey, EthKeyFile};
use swap_cli::secret::{Secret, Variant};
use swap_cli::state::Role;
use swap_cli::swapfile::{example_bob_file, example_public, KdfParams, Passphrase, SwapFile, SwapFileError};

const PASS: &str = "a passphrase of enough length";
const CODE_HASH: &str = "0xa906117fc4e604bd25fcee2a6a41da8b824ec9b4a17d10137704e7da42545e2f";
/// `example_public`'s Ethereum accounts.
const ALICE_ETH: [u8; 20] = [0xa1; 20];
const BOB_ETH: [u8; 20] = [0xb0; 20];
const PAYOUT: [u8; 20] = [0xc7; 20];

fn pass() -> Passphrase {
    Passphrase::new(PASS)
}

fn key_text(byte: u8) -> String {
    format!("0x{}", hex::encode([byte; 32]))
}

fn key(byte: u8, address: [u8; 20]) -> EthKey {
    EthKey::new(parse_key(&key_text(byte)).unwrap(), address).unwrap()
}

fn alice_file() -> (SwapFile, Secret) {
    let s = Secret::from_bytes(h::seq_bytes(0x33));
    (SwapFile::new_alice(example_public(&s, Variant::Raw), &s, &pass(), &KdfParams::fast_for_tests(), 0).unwrap(), s)
}

fn bob_file() -> SwapFile {
    let s = Secret::from_bytes(h::seq_bytes(0x33));
    example_bob_file(example_public(&s, Variant::Raw), 0).unwrap()
}

fn invalid(r: Result<SwapFile, SwapFileError>, needle: &str) {
    match r {
        Err(SwapFileError::Invalid(m)) => assert!(m.contains(needle), "{m}"),
        other => panic!("expected a refusal containing `{needle}`, got {:?}", other.map(|_| "a file")),
    }
}

#[test]
fn a_file_made_before_the_eth_key_existed_loads_and_writes_no_field() {
    let (file, s) = alice_file();
    let text = serde_json::to_string_pretty(&file).unwrap();
    assert!(!text.contains("eth_key"));
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("old.swap.json");
    std::fs::write(&path, &text).unwrap();
    let loaded = SwapFile::load(&path).unwrap();
    assert!(loaded.eth_key.is_none());
    assert_eq!(loaded, file);
    assert!(matches!(loaded.decrypt_eth_key(&pass()), Err(SwapFileError::Invalid(m)) if m.contains("no Ethereum swap key")));
    assert_eq!(loaded.decrypt_secret(&pass()).unwrap().bytes(), s.bytes());
}

#[test]
fn alices_key_round_trips_and_the_blob_is_bound_to_everything_beside_it() {
    let (file, s) = alice_file();
    let k = key(0x11, ALICE_ETH);
    let file = file.with_eth_key(&k, &PAYOUT, &pass(), &KdfParams::fast_for_tests()).unwrap();
    assert_eq!(file.eth_account(), ALICE_ETH);
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("a.swap.json");
    file.save(&path).unwrap();
    let text = std::fs::read_to_string(&path).unwrap();
    assert!(text.contains("\"eth_key\"") && !text.contains(&hex::encode([0x11u8; 32])), "the plain text holds the address and the payout, never the key");
    let loaded = SwapFile::load(&path).unwrap();
    assert_eq!(loaded, file);
    let opened = loaded.decrypt_eth_key(&pass()).unwrap();
    assert_eq!(opened.secret().bytes(), &[0x11u8; 32]);
    assert_eq!(address_hex(&opened.address()), address_hex(&ALICE_ETH));
    assert!(matches!(loaded.decrypt_eth_key(&Passphrase::new("not the passphrase at all")), Err(SwapFileError::WrongPassphrase)));
    // the claim secret still opens, untouched
    assert_eq!(loaded.decrypt_secret(&pass()).unwrap().bytes(), s.bytes());

    // the payout beside the blob is bound to it
    let mut moved = loaded.clone();
    moved.eth_key.as_mut().unwrap().payout = address_hex(&[0xd8; 20]);
    assert!(matches!(moved.decrypt_eth_key(&pass()), Err(SwapFileError::WrongPassphrase)));
    // another address in the file: the file does not even load
    let mut other = loaded.clone();
    other.eth_key.as_mut().unwrap().address = address_hex(&[0xe9; 20]);
    let p2 = dir.path().join("other.swap.json");
    std::fs::write(&p2, serde_json::to_vec_pretty(&other).unwrap()).unwrap();
    assert!(matches!(SwapFile::load(&p2), Err(SwapFileError::Invalid(m)) if m.contains("not this role's account")));
    // a payout that is the contract, the key's own address or zero: the file does not load
    for bad in [loaded.public.params.eth.contract, ALICE_ETH, [0u8; 20]] {
        let mut f = loaded.clone();
        f.eth_key.as_mut().unwrap().payout = address_hex(&bad);
        let p3 = dir.path().join("bad.swap.json");
        std::fs::write(&p3, serde_json::to_vec_pretty(&f).unwrap()).unwrap();
        assert!(matches!(SwapFile::load(&p3), Err(SwapFileError::Invalid(m)) if m.contains("payout")));
    }
    // a changed public section: the blob is bound to its digest
    let mut public = loaded.clone();
    public.public.params.amount_micronoid += 1;
    assert!(public.decrypt_eth_key(&pass()).is_err());
}

#[test]
fn bobs_file_may_hold_a_key_and_the_blobs_are_not_interchangeable() {
    let k = key(0x22, BOB_ETH);
    let bob = bob_file().with_eth_key(&k, &PAYOUT, &pass(), &KdfParams::fast_for_tests()).unwrap();
    assert_eq!(bob.role, Role::Bob);
    assert_eq!(bob.eth_account(), BOB_ETH);
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("b.swap.json");
    bob.save(&path).unwrap();
    let loaded = SwapFile::load(&path).unwrap();
    assert_eq!(loaded.decrypt_eth_key(&pass()).unwrap().secret().bytes(), &[0x22u8; 32]);
    assert!(loaded.secret.is_none(), "Bob's claim secret field stays empty");

    // Alice: the eth blob in the claim secret's place, and the claim blob in the eth blob's place
    let (alice, _) = alice_file();
    let alice = alice.with_eth_key(&key(0x11, ALICE_ETH), &PAYOUT, &pass(), &KdfParams::fast_for_tests()).unwrap();
    let mut swapped = alice.clone();
    swapped.secret = Some(alice.eth_key.as_ref().unwrap().secret.clone());
    assert!(matches!(swapped.decrypt_secret(&pass()), Err(SwapFileError::WrongPassphrase)), "the eth blob does not open as the claim secret");
    let mut swapped = alice.clone();
    swapped.eth_key.as_mut().unwrap().secret = alice.secret.clone().unwrap();
    assert!(matches!(swapped.decrypt_eth_key(&pass()), Err(SwapFileError::WrongPassphrase)), "the claim blob does not open as the eth key");
    // the standalone key file's blob does not open in the swap file either
    let kf = EthKeyFile::create(&key(0x11, ALICE_ETH), &pass(), &KdfParams::fast_for_tests()).unwrap();
    let mut forged = alice.clone();
    forged.eth_key.as_mut().unwrap().secret = kf.secret.clone();
    assert!(forged.decrypt_eth_key(&pass()).is_err());
    // an address-only difference between the two files' blobs: Bob's key blob does not open in Alice's file
    let mut crossed = alice.clone();
    crossed.eth_key.as_mut().unwrap().secret = loaded.eth_key.as_ref().unwrap().secret.clone();
    assert!(crossed.decrypt_eth_key(&pass()).is_err());
    // nothing prints the key
    assert!(!format!("{alice:?}").contains(&hex::encode([0x11u8; 32])));
    assert!(!format!("{:?}", key(0x11, ALICE_ETH)).contains("1111"));
}

#[test]
fn a_key_is_refused_unless_it_is_this_roles_account_and_the_payout_is_the_users_own() {
    let kdf = KdfParams::fast_for_tests();
    let (alice, _) = alice_file();
    // the key's address is Bob's account, not Alice's
    invalid(alice.clone().with_eth_key(&key(0x11, BOB_ETH), &PAYOUT, &pass(), &kdf), "alice_receiver");
    invalid(bob_file().with_eth_key(&key(0x11, ALICE_ETH), &PAYOUT, &pass(), &kdf), "bob_sender");
    // payouts that are not the user's own
    for bad in [[0u8; 20], ALICE_ETH, BOB_ETH, alice.public.params.eth.contract] {
        invalid(alice.clone().with_eth_key(&key(0x11, ALICE_ETH), &bad, &pass(), &kdf), "payout");
    }
    for bad in [[0u8; 20], ALICE_ETH, BOB_ETH, alice.public.params.eth.contract] {
        invalid(bob_file().with_eth_key(&key(0x22, BOB_ETH), &bad, &pass(), &kdf), "payout");
    }
    // Alice's key must not be her claim secret (it is revealed on Ethereum)
    let (alice, s) = alice_file();
    let same = EthKey::new(Secret::from_bytes(*s.bytes()), ALICE_ETH).unwrap();
    invalid(alice.clone().with_eth_key(&same, &PAYOUT, &pass(), &kdf), "claim secret");
    // a second key in the same file
    let once = alice.with_eth_key(&key(0x11, ALICE_ETH), &PAYOUT, &pass(), &kdf).unwrap();
    invalid(once.with_eth_key(&key(0x12, ALICE_ETH), &PAYOUT, &pass(), &kdf), "already holds");
    // a wrong passphrase cannot seal an Alice key (the claim secret must open for the comparison)
    let (alice, _) = alice_file();
    assert!(alice.with_eth_key(&key(0x11, ALICE_ETH), &PAYOUT, &Passphrase::new("not the passphrase at all"), &kdf).is_err());
}

#[test]
fn the_standalone_key_file_seals_opens_and_is_never_overwritten() {
    let k = key(0x33, [0x44; 20]);
    let kdf = KdfParams::fast_for_tests();
    let f = EthKeyFile::create(&k, &pass(), &kdf).unwrap();
    assert_eq!(f.address, address_hex(&[0x44; 20]));
    assert!(!serde_json::to_string(&f).unwrap().contains(&hex::encode([0x33u8; 32])));
    assert_eq!(f.open(&pass()).unwrap().secret().bytes(), &[0x33u8; 32]);
    assert!(f.open(&Passphrase::new("not the passphrase at all")).is_err());
    let mut moved = f.clone();
    moved.address = address_hex(&[0x45; 20]);
    assert!(moved.open(&pass()).is_err(), "the address beside the blob is bound");
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("k.json");
    f.save_new(&path).unwrap();
    assert!(f.save_new(&path).is_err());
    assert_eq!(EthKeyFile::load(&path).unwrap(), f);
    assert!(EthKeyFile::load(&dir.path().join("missing.json")).is_err());
    // an invalid secret (zero, or not below the group order) cannot be made into a key
    assert!(parse_key(&format!("0x{}", "00".repeat(32))).is_err());
    assert!(parse_key(&format!("0x{}", "ff".repeat(32))).is_err());
}

// ---------------------------------------------------------------- the binary

fn bin() -> Command {
    let mut c = home::isolated_bin();
    c.env("SWAP_PASSPHRASE", PASS);
    c
}

/// Run with `input` on stdin (a pipe). Returns (success, stdout, stderr).
fn run_with(cmd: &mut Command, input: &str) -> (bool, String, String) {
    let mut child = cmd.stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped()).spawn().expect("spawn swap-cli");
    // The child may refuse before it reads (a short passphrase): a closed pipe is not a test failure.
    let mut stdin = child.stdin.take().unwrap();
    let _ = stdin.write_all(input.as_bytes());
    drop(stdin);
    let out = child.wait_with_output().unwrap();
    (out.status.success(), String::from_utf8_lossy(&out.stdout).into_owned(), String::from_utf8_lossy(&out.stderr).into_owned())
}

fn run(cmd: &mut Command) -> (bool, String, String) {
    run_with(cmd, "")
}

const ALICE_HEX: &str = "0x3c44cdddb6a900fa2b585dd299e03d12fa4293bc";
const BOB_HEX: &str = "0x70997970c51812dc3a010c7d01b50e0d17dc79c8";
const PAYOUT_HEX: &str = "0x9c4e2f1a0b3d5c6e7f8091a2b3c4d5e6f7081920";

fn make_key_file(dir: &std::path::Path, name: &str, address: &str, key: &str) -> std::path::PathBuf {
    let out = dir.join(name);
    let (ok, stdout, err) = run_with(bin().args(["ethkey", "new", "--out", out.to_str().unwrap(), "--fast-kdf"]), &format!("{address}\n{key}\n"));
    assert!(ok, "{err}");
    let v: serde_json::Value = serde_json::from_str(&stdout).unwrap();
    assert_eq!(v["address"].as_str().unwrap(), address);
    for text in [&stdout, &err] {
        assert!(!text.contains(&key[2..]), "the key is never printed");
    }
    out
}

#[test]
fn ethkey_new_checks_the_framing_and_the_key_prints_only_the_address_and_never_overwrites() {
    let dir = tempfile::tempdir().unwrap();
    let key = key_text(0x11);
    let kf = make_key_file(dir.path(), "a.key.json", ALICE_HEX, &key);
    let text = std::fs::read_to_string(&kf).unwrap();
    assert!(text.contains(ALICE_HEX) && !text.contains(&key[2..]));
    // never overwritten
    let (ok, _, err) = run_with(bin().args(["ethkey", "new", "--out", kf.to_str().unwrap(), "--fast-kdf"]), &format!("{ALICE_HEX}\n{key}\n"));
    assert!(!ok && err.contains("already exists"), "{err}");
    // every other framing, and invalid keys, are refused before a file exists; no error shows the key
    let bad_key_zero = format!("0x{}", "00".repeat(32));
    let bad_key_big = format!("0x{}", "ff".repeat(32));
    for (n, input) in [
        ("empty", String::new()),
        ("key only", format!("{key}\n")),
        ("swapped", format!("{key}\n{ALICE_HEX}\n")),
        ("three lines", format!("{ALICE_HEX}\n{key}\n{key}\n")),
        ("blank between", format!("{ALICE_HEX}\n\n{key}\n")),
        ("one line", format!("{ALICE_HEX} {key}\n")),
        ("zero key", format!("{ALICE_HEX}\n{bad_key_zero}\n")),
        ("key above the order", format!("{ALICE_HEX}\n{bad_key_big}\n")),
        ("zero address", format!("0x{}\n{key}\n", "00".repeat(20))),
        ("short key", format!("{ALICE_HEX}\n0x1234\n")),
    ] {
        let out = dir.path().join(format!("bad-{n}.json"));
        let (ok, stdout, err) = run_with(bin().args(["ethkey", "new", "--out", out.to_str().unwrap(), "--fast-kdf"]), &input);
        assert!(!ok, "{n}");
        assert!(!out.exists(), "{n}");
        for text in [&stdout, &err] {
            assert!(!text.contains(&key[2..]) && !text.contains(&bad_key_big[2..]), "{n}: {text}");
        }
    }
    // a missing or short passphrase is refused before stdin is read
    let (ok, _, err) = run_with(bin().env("SWAP_PASSPHRASE", "short").args(["ethkey", "new", "--out", dir.path().join("p.json").to_str().unwrap(), "--fast-kdf"]), &format!("{ALICE_HEX}\n{key}\n"));
    assert!(!ok && err.contains("12 characters"), "{err}");
}

#[test]
fn ethkey_address_and_emit_work_on_a_key_file_and_a_swap_file_and_emit_is_for_a_pipe() {
    let dir = tempfile::tempdir().unwrap();
    let key = key_text(0x11);
    let kf = make_key_file(dir.path(), "a.key.json", ALICE_HEX, &key);
    let (ok, out, err) = run(bin().args(["ethkey", "address", kf.to_str().unwrap()]));
    assert!(ok, "{err}");
    assert_eq!(serde_json::from_str::<serde_json::Value>(&out).unwrap()["address"], ALICE_HEX);
    // emit: the raw key, a line, on a pipe (the captured stdout is not a terminal)
    let (ok, out, err) = run(bin().args(["ethkey", "emit", kf.to_str().unwrap()]));
    assert!(ok, "{err}");
    assert_eq!(out, format!("{key}\n"));
    assert!(!err.contains(&key[2..]), "stderr never carries the key: {err}");
    // a wrong passphrase prints nothing on stdout
    let (ok, out, err) = run(bin().env("SWAP_PASSPHRASE", "not the passphrase at all").args(["ethkey", "emit", kf.to_str().unwrap()]));
    assert!(!ok && out.is_empty(), "{out}");
    assert!(!err.contains(&key[2..]));
    // a file that is not a key file
    let junk = dir.path().join("junk.json");
    std::fs::write(&junk, "{\"hello\": 1}").unwrap();
    assert!(!run(bin().args(["ethkey", "emit", junk.to_str().unwrap()])).0);
    assert!(!run(bin().args(["ethkey", "address", junk.to_str().unwrap()])).0);
}

fn alice_args(out: &str, cast: &h::Cast) -> Vec<String> {
    [
        "new-alice", "--out", out, "--alice", &cast.alice.to_bech32(), "--bob", &cast.bob.to_bech32(), "--amount", "10000000", "--fee-estimate", "5800", "--h-create",
        "300000", "--eth-contract", "0x5fbdb2315678afecb367f032d93f642f64180aa3", "--eth-chain-id", "31337", "--eth-amount-wei", "10000000000000000", "--eth-receiver",
        ALICE_HEX, "--eth-sender", BOB_HEX, "--eth-code-hash", CODE_HASH, "--fast-kdf",
    ]
    .iter()
    .map(|s| s.to_string())
    .collect()
}

#[test]
fn new_alice_seals_the_key_refuses_a_foreign_address_and_never_prints_it() {
    let dir = tempfile::tempdir().unwrap();
    let cast = h::Cast::new();
    let key = key_text(0x11);
    let kf = make_key_file(dir.path(), "a.key.json", ALICE_HEX, &key);
    let swap = dir.path().join("a.swap.json");
    let s = swap.to_str().unwrap();
    // --eth-key and --eth-payout belong together
    let (ok, _, err) = run(bin().args(alice_args(s, &cast)).args(["--eth-key", kf.to_str().unwrap()]));
    assert!(!ok && err.contains("belong together"), "{err}");
    let (ok, _, err) = run(bin().args(alice_args(s, &cast)).args(["--eth-payout", PAYOUT_HEX]));
    assert!(!ok && err.contains("belong together"), "{err}");
    assert!(!swap.exists());
    // a key that is Bob's account, not --eth-receiver
    let bobs = make_key_file(dir.path(), "b.key.json", BOB_HEX, &key_text(0x22));
    let (ok, _, err) = run(bin().args(alice_args(s, &cast)).args(["--eth-key", bobs.to_str().unwrap(), "--eth-payout", PAYOUT_HEX]));
    assert!(!ok && err.contains("not --eth-receiver"), "{err}");
    assert!(!swap.exists());
    // a bad payout: the contract, the zero address, the key itself
    for bad in ["0x5fbdb2315678afecb367f032d93f642f64180aa3", &format!("0x{}", "00".repeat(20)), ALICE_HEX, BOB_HEX, "0x1234"] {
        let (ok, _, err) = run(bin().args(alice_args(s, &cast)).args(["--eth-key", kf.to_str().unwrap(), "--eth-payout", bad]));
        assert!(!ok, "{bad}");
        assert!(!swap.exists(), "{bad}: {err}");
    }
    assert!(!dir.path().join("hashlocks.txt").exists(), "a refused swap registers no hashlock");
    // a wrong passphrase for the key file
    let (ok, _, err) = run(bin().env("SWAP_PASSPHRASE", "not the passphrase at all").args(alice_args(s, &cast)).args(["--eth-key", kf.to_str().unwrap(), "--eth-payout", PAYOUT_HEX]));
    assert!(!ok && err.contains("--eth-key"), "{err}");
    // the real one
    let (ok, bundle, err) = run(bin().args(alice_args(s, &cast)).args(["--eth-key", kf.to_str().unwrap(), "--eth-payout", PAYOUT_HEX]));
    assert!(ok, "{err}");
    for text in [&bundle, &err] {
        assert!(!text.contains(&key[2..]), "the key is never printed");
    }
    assert!(err.contains("delete it once this swap file is saved"));
    let file = SwapFile::load(&swap).unwrap();
    let rec = file.eth_key.as_ref().unwrap();
    assert_eq!(rec.address, ALICE_HEX);
    assert_eq!(rec.payout, PAYOUT_HEX);
    assert_eq!(file.decrypt_eth_key(&pass()).unwrap().secret().bytes(), &[0x11u8; 32]);
    assert!(file.decrypt_secret(&pass()).is_ok(), "the claim secret is there beside it");
    // the public bundle Bob gets holds neither the key nor the payout
    let public_text = bundle;
    assert!(!public_text.contains("eth_key") && !public_text.contains(PAYOUT_HEX));
    // ethkey address and emit read the swap file
    let (ok, out, err) = run(bin().args(["ethkey", "address", s]));
    assert!(ok, "{err}");
    let v: serde_json::Value = serde_json::from_str(&out).unwrap();
    assert_eq!((v["address"].as_str().unwrap(), v["payout"].as_str().unwrap(), v["role"].as_str().unwrap()), (ALICE_HEX, PAYOUT_HEX, "alice"));
    let (ok, out, err) = run(bin().args(["ethkey", "emit", s]));
    assert!(ok, "{err}");
    assert_eq!(out, format!("{key}\n"));
    // without an Ethereum key in the file
    let plain = dir.path().join("plain.swap.json");
    let (ok, _, err) = run(bin().args(alice_args(plain.to_str().unwrap(), &cast)).args(["--registry", dir.path().join("r2.txt").to_str().unwrap()]));
    assert!(ok, "{err}");
    let (ok, out, err) = run(bin().args(["ethkey", "emit", plain.to_str().unwrap()]));
    assert!(!ok && out.is_empty() && err.contains("no Ethereum swap key"), "{err}");
}

#[cfg(unix)]
#[test]
fn new_bob_seals_his_key_and_refuses_a_foreign_address() {
    let dir = tempfile::tempdir().unwrap();
    let cast = h::Cast::new();
    let akey = make_key_file(dir.path(), "a.key.json", ALICE_HEX, &key_text(0x11));
    let a = dir.path().join("a.swap.json");
    let (ok, bundle, err) = run(bin().args(alice_args(a.to_str().unwrap(), &cast)).args(["--eth-key", akey.to_str().unwrap(), "--eth-payout", PAYOUT_HEX]));
    assert!(ok, "{err}");
    let bundle_path = dir.path().join("bundle.json");
    std::fs::write(&bundle_path, &bundle).unwrap();

    let bob_dir = tempfile::tempdir().unwrap();
    let stub = equiv_stub::receipt_flags(bob_dir.path());
    let bob_key = key_text(0x22);
    let bkf = make_key_file(bob_dir.path(), "b.key.json", BOB_HEX, &bob_key);
    let bob_args = |out: &std::path::Path| {
        let mut args = vec![
            "new-bob".to_string(), "--bundle".into(), bundle_path.to_str().unwrap().into(), "--out".into(), out.to_str().unwrap().into(), "--bob".into(),
            cast.bob.to_bech32(), "--amount".into(), "10000000".into(), "--eth-chain-id".into(), "31337".into(), "--eth-contract".into(),
            "0x5fbdb2315678afecb367f032d93f642f64180aa3".into(), "--eth-amount-wei".into(), "10000000000000000".into(), "--eth-sender".into(), BOB_HEX.into(),
            "--eth-code-hash".into(), CODE_HASH.into(), "--fast-kdf".into(),
        ];
        args.extend(stub.clone());
        args
    };
    // Alice's key file is not Bob's account
    let b = bob_dir.path().join("b.swap.json");
    let (ok, _, err) = run(bin().args(bob_args(&b)).args(["--eth-key", akey.to_str().unwrap(), "--eth-payout", PAYOUT_HEX]));
    assert!(!ok && err.contains("not --eth-sender"), "{err}");
    assert!(!b.exists());
    // only one of the two flags
    let (ok, _, err) = run(bin().args(bob_args(&b)).args(["--eth-key", bkf.to_str().unwrap()]));
    assert!(!ok && err.contains("belong together"), "{err}");
    // the payout is Alice's account: refused, nothing written
    let (ok, _, err) = run(bin().args(bob_args(&b)).args(["--eth-key", bkf.to_str().unwrap(), "--eth-payout", ALICE_HEX]));
    assert!(!ok && !b.exists(), "{err}");
    // the real one
    let (ok, out, err) = run(bin().args(bob_args(&b)).args(["--eth-key", bkf.to_str().unwrap(), "--eth-payout", PAYOUT_HEX]));
    assert!(ok, "{err}");
    for text in [&out, &err] {
        assert!(!text.contains(&bob_key[2..]));
    }
    let file = SwapFile::load(&b).unwrap();
    assert_eq!(file.role, Role::Bob);
    assert!(file.secret.is_none());
    assert_eq!(file.eth_key.as_ref().unwrap().address, BOB_HEX);
    assert_eq!(file.decrypt_eth_key(&pass()).unwrap().secret().bytes(), &[0x22u8; 32]);
    let (ok, out, _) = run(bin().args(["ethkey", "emit", b.to_str().unwrap()]));
    assert!(ok);
    assert_eq!(out, format!("{bob_key}\n"));
}
