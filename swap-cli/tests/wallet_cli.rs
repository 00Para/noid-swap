//! `swap-cli wallet ...` through the binary (swap wallet, piece 2a): the wallet file, `new-alice --wallet`, the export guard, and the three
//! sending commands against the vendor-checked node double served over loopback HTTP.

#[path = "common/home.rs"]
mod home;
#[path = "common/http_node.rs"]
mod http_node;
#[path = "common/wallet_node.rs"]
mod wallet_node;

use std::process::Command;

use swap_cli::swapfile::{Passphrase, SwapFile};
use swap_cli::watch::JsonRpc;
use wallet_node::*;

const PASS: &str = "a passphrase of enough length";
const CODE_HASH: &str = "0xa906117fc4e604bd25fcee2a6a41da8b824ec9b4a17d10137704e7da42545e2f";

fn run(cmd: &mut Command) -> (bool, String, String) {
    let out = cmd.output().expect("run swap-cli");
    (out.status.success(), String::from_utf8_lossy(&out.stdout).into_owned(), String::from_utf8_lossy(&out.stderr).into_owned())
}

fn bin() -> Command {
    let mut c = home::isolated_bin();
    c.env("SWAP_PASSPHRASE", PASS);
    c
}

fn alice_args(out: &str, cast: &swap_cli::htlc_harness::Cast) -> Vec<String> {
    [
        "new-alice", "--out", out, "--bob", &cast.bob.to_bech32(), "--amount", "10000000", "--fee-estimate", "5800", "--h-create", "300000", "--eth-contract",
        "0x5fbdb2315678afecb367f032d93f642f64180aa3", "--eth-chain-id", "1", "--eth-amount-wei", "10000000000000000", "--eth-receiver",
        "0x3c44cdddb6a900fa2b585dd299e03d12fa4293bc", "--eth-sender", "0x70997970c51812dc3a010c7d01b50e0d17dc79c8", "--eth-code-hash", CODE_HASH, "--fast-kdf",
    ]
    .iter()
    .map(|s| s.to_string())
    .collect()
}

#[test]
fn a_wallet_file_becomes_the_swaps_recovery_address_and_exports_a_backup() {
    let dir = tempfile::tempdir().unwrap();
    let w = dir.path().join("w.wallet.json");
    let swap = dir.path().join("a.swap.json");
    let cast = swap_cli::htlc_harness::Cast::new();
    // a new wallet: only the address is printed, the file is sealed
    let (ok, out, err) = run(bin().args(["wallet", "new", "--out", w.to_str().unwrap(), "--fast-kdf"]));
    assert!(ok, "{err}");
    let v: serde_json::Value = serde_json::from_str(&out).unwrap();
    let address = v["address"].as_str().unwrap().to_string();
    assert!(address.starts_with("o1"));
    let wallet_text = std::fs::read_to_string(&w).unwrap();
    assert!(wallet_text.contains(&address) && !wallet_text.contains("master"));
    // never overwritten
    let (ok, _, err) = run(bin().args(["wallet", "new", "--out", w.to_str().unwrap(), "--fast-kdf"]));
    assert!(!ok && err.contains("already exists"), "{err}");
    // a short passphrase and a missing one are refused before anything is written
    let (ok, _, err) = run(bin().env("SWAP_PASSPHRASE", "short").args(["wallet", "new", "--out", dir.path().join("x.json").to_str().unwrap(), "--fast-kdf"]));
    assert!(!ok && err.contains("12 characters"));
    // new-alice: --alice and --payout rules
    let payout = swap_cli::htlc_harness::addr(swap_cli::htlc_harness::seq_bytes(0x91)).to_bech32();
    let (ok, _, err) = run(bin().args(alice_args(swap.to_str().unwrap(), &cast)).args(["--wallet", w.to_str().unwrap(), "--alice", &cast.alice.to_bech32()]));
    assert!(!ok && err.contains("not the swap wallet's address"), "{err}");
    assert!(!swap.exists());
    let (ok, _, err) = run(bin().args(alice_args(swap.to_str().unwrap(), &cast)).args(["--alice", &cast.alice.to_bech32(), "--payout", &payout]));
    assert!(!ok && err.contains("--wallet"), "{err}");
    let (ok, _, err) = run(bin().env("SWAP_PASSPHRASE", "another passphrase entirely").args(alice_args(swap.to_str().unwrap(), &cast)).args(["--wallet", w.to_str().unwrap()]));
    assert!(!ok && err.contains("--wallet"), "a wrong passphrase does not open the wallet file: {err}");
    // the real one
    let (ok, bundle, err) = run(bin().args(alice_args(swap.to_str().unwrap(), &cast)).args(["--wallet", w.to_str().unwrap(), "--payout", &payout]));
    assert!(ok, "{err}");
    assert!(err.contains("delete it once this swap file is saved"));
    assert!(!err.contains("master"));
    let public: swap_cli::swapfile::SwapPublic = serde_json::from_str(&bundle).unwrap();
    assert_eq!(public.params.alice_noid, address);
    let file = SwapFile::load(&swap).unwrap();
    assert_eq!(file.wallet.as_ref().unwrap().address, address);
    assert_eq!(file.wallet.as_ref().unwrap().payout.as_deref(), Some(payout.as_str()));
    let m = file.decrypt_wallet(&Passphrase::new(PASS)).unwrap();
    // `wallet address`
    let (ok, out, _) = run(bin().args(["wallet", "address", swap.to_str().unwrap()]));
    assert!(ok);
    let v: serde_json::Value = serde_json::from_str(&out).unwrap();
    assert_eq!((v["address"].as_str().unwrap(), v["payout"].as_str().unwrap()), (address.as_str(), payout.as_str()));
    // export: refused without the flag, nothing printed
    let (ok, out, err) = run(bin().args(["wallet", "export", swap.to_str().unwrap()]));
    assert!(!ok && out.is_empty() && err.contains("--i-understand-this-is-the-key"));
    // with it: the secret and the opening on stdout, the way to use them on stderr
    let (ok, out, err) = run(bin().args(["wallet", "export", swap.to_str().unwrap(), "--i-understand-this-is-the-key"]));
    assert!(ok, "{err}");
    let v: serde_json::Value = serde_json::from_str(&out).unwrap();
    assert_eq!(v["master_secret"].as_str().unwrap(), hex::encode(m.bytes()));
    assert_eq!(v["contract_opening_hex"].as_str().unwrap(), file.public.opening_hex);
    assert!(err.contains("import-wallet-secret") && err.contains("FRESH") && !err.contains(&hex::encode(m.bytes())));
    // a swap file made without a wallet has none to export
    let plain = dir.path().join("plain.swap.json");
    let (ok, _, err) = run(bin().args(alice_args(plain.to_str().unwrap(), &cast)).args(["--alice", &cast.alice.to_bech32()]));
    assert!(ok, "{err}");
    let (ok, _, err) = run(bin().args(["wallet", "export", plain.to_str().unwrap(), "--i-understand-this-is-the-key"]));
    assert!(!ok && err.contains("no NOID swap wallet"));
}

#[test]
fn fund_through_the_binary_is_a_dry_run_unless_told_to_submit_and_never_sends_twice() {
    let fx = Fx::new(299_300);
    fx.node.seed(5, &fx.key.address(), 20_000_000);
    let node = fx.node.clone();
    let mock = http_node::MockNode::spawn(move |m, p| node.call(m, p.clone()));
    let path = fx.path.to_str().unwrap().to_string();
    let go = |extra: &[&str]| run(bin().args(["wallet", "fund", &path, "--noid-rpc", &mock.url]).args(extra));
    // nothing said = a dry run: built, proved, verified; nothing sent, nothing written
    let (ok, out, err) = go(&[]);
    assert!(ok, "{err}");
    let v: serde_json::Value = serde_json::from_str(&out).unwrap();
    assert_eq!(v["outcome"], "dry_run");
    assert_eq!(v["amount_micronoid"], AMOUNT);
    assert_eq!(v["target"], fx.root.to_bech32());
    assert_eq!(fx.node.received_count(), 0);
    assert!(!fx.record_exists("fund"));
    // both flags: refused
    let (ok, _, err) = go(&["--dry-run", "--submit"]);
    assert!(!ok && err.contains("opposite"), "{err}");
    // --submit: the first run sees the deposit and waits for two blocks
    let (ok, out, err) = go(&["--submit"]);
    assert!(ok, "{err}");
    assert_eq!(serde_json::from_str::<serde_json::Value>(&out).unwrap()["outcome"], "hold");
    assert_eq!(fx.node.received_count(), 0);
    fx.node.mine(2);
    let (ok, out, err) = go(&["--submit"]);
    assert!(ok, "{err}");
    let v: serde_json::Value = serde_json::from_str(&out).unwrap();
    assert_eq!(v["outcome"], "sent", "{out}");
    assert!(err.contains("SUBMITTING from the swap wallet to 1 node(s)"));
    assert_eq!(fx.node.received_count(), 1);
    assert!(fx.record_exists("fund"));
    fx.node.mine(1);
    assert_eq!(fx.node.coins_of(&fx.root)[0].1, AMOUNT);
    // run again: no second funding
    let (ok, out, err) = go(&["--submit"]);
    assert!(ok, "{err}");
    assert_eq!(serde_json::from_str::<serde_json::Value>(&out).unwrap()["outcome"], "done");
    assert_eq!(fx.node.received_count(), 1);
    // the balance report
    let (ok, out, err) = run(bin().args(["wallet", "balance", &path, "--noid-rpc", &mock.url]));
    assert!(ok, "{err}");
    let v: serde_json::Value = serde_json::from_str(&out).unwrap();
    assert_eq!(v["plain_micronoid"], 20_000_000 - AMOUNT - 9_000);
    assert_eq!(v["address"], fx.key.address().to_bech32());
    // a wrong passphrase: refused, nothing sent
    let (ok, _, err) = run(Command::new(env!("CARGO_BIN_EXE_swap-cli")).env("SWAP_PASSPHRASE", "not the passphrase at all").args(["wallet", "fund", &path, "--noid-rpc", &mock.url, "--submit"]));
    assert!(!ok && err.contains("passphrase"), "{err}");
    assert_eq!(fx.node.received_count(), 1);
}

#[test]
fn recover_and_sweep_through_the_binary() {
    let mut fx = Fx::new(D - 1);
    let inst = fx.instance_at_root(40, AMOUNT);
    fx.set_funded(&inst);
    let node = fx.node.clone();
    let mock = http_node::MockNode::spawn(move |m, p| node.call(m, p.clone()));
    let path = fx.path.to_str().unwrap().to_string();
    // the sweep is not allowed while the swap is open
    let (ok, out, err) = run(bin().args(["wallet", "sweep", &path, "--noid-rpc", &mock.url, "--submit"]));
    assert!(ok, "{err}");
    assert_eq!(serde_json::from_str::<serde_json::Value>(&out).unwrap()["outcome"], "hold");
    // the recovery at the deadline
    let (ok, out, err) = run(bin().args(["wallet", "recover", &path, "--noid-rpc", &mock.url, "--submit"]));
    assert!(ok, "{err}");
    let v: serde_json::Value = serde_json::from_str(&out).unwrap();
    assert_eq!(v["outcome"], "sent", "{out}");
    assert_eq!(v["amount_micronoid"], AMOUNT - 5_800);
    fx.node.mine(1);
    assert_eq!(fx.node.balance_of(&fx.key.address()), AMOUNT - 5_800);
    // the swap file follows the chain (tick records the close); here the phase is set to what the engine would reach
    fx.file.phase = swap_cli::state::Phase::Alice(swap_cli::state::AlicePhase::Refunded { txid: "ab".repeat(32), height: D });
    fx.file.save(&fx.path).unwrap();
    let (ok, out, err) = run(bin().args(["wallet", "sweep", &path, "--noid-rpc", &mock.url, "--submit"]));
    assert!(ok, "{err}");
    let v: serde_json::Value = serde_json::from_str(&out).unwrap();
    assert_eq!(v["outcome"], "sent", "{out}");
    fx.node.mine(1);
    assert_eq!(fx.node.balance_of(&fx.payout), AMOUNT - 5_800 - (5_000 + 100 + 700));
}
