//! T-S3 + L9: `swap-cli verify-sealed` opens every sealed field (secret, wallet, eth_key), proves binding
//! to public terms, prints no secret bytes, and refuses a wrong passphrase; `swap-cli status` exposes
//! pending_intent and history_count for the backup safety digest.

use std::process::Command;
use tempfile::tempdir;

fn cli_bin() -> &'static str {
    env!("CARGO_BIN_EXE_swap-cli")
}

#[test]
fn verify_sealed_and_status_fields_for_alice_with_wallet_and_eth_key() {
    let dir = tempdir().unwrap();
    let home = tempdir().unwrap();
    let swap = dir.path().join("alice.swap.json");
    let wallet_file = dir.path().join("wallet.key.json");
    let eth_key_file = dir.path().join("alice.eth.key.json");
    let pass = "correct-horse-battery-staple-test-pass";
    let eth_payout = "0x3333333333333333333333333333333333333333";
    let bob_eth = "0x2222222222222222222222222222222222222222";
    let bob_noid = swap_cli::htlc_harness::addr(swap_cli::htlc_harness::seq_bytes(0x71)).to_bech32();
    let alice_payout_noid = swap_cli::htlc_harness::addr(swap_cli::htlc_harness::seq_bytes(0x91)).to_bech32();

    // Generate a fresh swap NOID wallet and Ethereum swap key.
    let w_out = Command::new(cli_bin())
        .env("SWAP_PASSPHRASE", pass)
        .args(["wallet", "new", "--out", wallet_file.to_str().unwrap()])
        .output()
        .unwrap();
    assert!(w_out.status.success(), "wallet new failed: {}", String::from_utf8_lossy(&w_out.stderr));
    let w_json: serde_json::Value = serde_json::from_slice(&w_out.stdout).unwrap();
    let wallet_addr = w_json["address"].as_str().unwrap().to_string();

    use std::io::Write as _;
    use std::process::Stdio;
    let alice_eth_addr = "0x7e5f4552091a69125d5dfcb7b8c2659029395bdf".to_string();
    let alice_eth_key = "0x0000000000000000000000000000000000000000000000000000000000000001";
    let mut e_child = Command::new(cli_bin())
        .env("SWAP_PASSPHRASE", pass)
        .args(["ethkey", "new", "--out", eth_key_file.to_str().unwrap()])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    e_child
        .stdin
        .as_mut()
        .unwrap()
        .write_all(format!("{alice_eth_addr}\n{alice_eth_key}\n").as_bytes())
        .unwrap();
    let e_out = e_child.wait_with_output().unwrap();
    assert!(e_out.status.success(), "ethkey new failed: {}", String::from_utf8_lossy(&e_out.stderr));

    // Create a poseidon Alice swap file sealing secret + wallet + eth_key.
    let out = Command::new(cli_bin())
        .env("SWAP_PASSPHRASE", pass)
        .env("HOME", home.path())
        .args([
            "new-alice",
            "--out",
            swap.to_str().unwrap(),
            "--profile",
            "sepolia",
            "--eth-lock-kind",
            "poseidon",
            "--amount",
            "5000000",
            "--fee-estimate",
            "10000",
            "--h-create",
            "300000",
            "--alice",
            &wallet_addr,
            "--bob",
            &bob_noid,
            "--wallet",
            wallet_file.to_str().unwrap(),
            "--payout",
            &alice_payout_noid,
            "--eth-key",
            eth_key_file.to_str().unwrap(),
            "--eth-payout",
            eth_payout,
            "--eth-chain-id",
            "11155111",
            "--eth-contract",
            "0x48Ce4D6cf3c175737532017e82B9261b51F8E5eF",
            "--eth-amount-wei",
            "1000000000000000",
            "--eth-receiver",
            &alice_eth_addr,
            "--eth-sender",
            bob_eth,
        ])
        .output()
        .unwrap();
    assert!(out.status.success(), "new-alice failed: {}", String::from_utf8_lossy(&out.stderr));

    // Read the actual secret hex to confirm verify-sealed never prints it.
    let sec_out = Command::new(cli_bin())
        .env("SWAP_PASSPHRASE", pass)
        .args(["secret", swap.to_str().unwrap()])
        .output()
        .unwrap();
    assert!(sec_out.status.success());
    let secret_hex = String::from_utf8(sec_out.stdout).unwrap().trim().to_string();

    // verify-sealed opens secret + wallet + eth_key, verifies all L9 bindings, prints no secret.
    let vs = Command::new(cli_bin())
        .env("SWAP_PASSPHRASE", pass)
        .args(["verify-sealed", swap.to_str().unwrap()])
        .output()
        .unwrap();
    assert!(vs.status.success(), "verify-sealed failed: {}", String::from_utf8_lossy(&vs.stderr));
    let vs_stdout = String::from_utf8(vs.stdout).unwrap();
    assert!(!vs_stdout.contains(&secret_hex), "verify-sealed must never print the secret");
    assert!(!vs_stdout.contains(pass), "verify-sealed must never print the passphrase");
    let v: serde_json::Value = serde_json::from_str(&vs_stdout).unwrap();
    assert_eq!(v["ok"], true);
    assert_eq!(v["role"], "alice");
    assert_eq!(v["opened"], serde_json::json!(["secret", "wallet", "eth_key"]));
    assert_eq!(v["wallet_address"], wallet_addr);
    assert_eq!(v["eth_address"].as_str().unwrap().to_lowercase(), alice_eth_addr.to_lowercase());

    // verify-sealed with wrong passphrase fails closed.
    let bad = Command::new(cli_bin())
        .env("SWAP_PASSPHRASE", "wrong-passphrase")
        .args(["verify-sealed", swap.to_str().unwrap()])
        .output()
        .unwrap();
    assert!(!bad.status.success(), "wrong passphrase must fail");

    // status exposes pending_intent, history_count, and eth_chain_id for the safety digest.
    let st = Command::new(cli_bin())
        .args(["status", swap.to_str().unwrap()])
        .output()
        .unwrap();
    assert!(st.status.success());
    let sj: serde_json::Value = serde_json::from_str(&String::from_utf8(st.stdout).unwrap()).unwrap();
    assert_eq!(sj["phase"], "created");
    assert!(sj["pending_intent"].is_null());
    assert_eq!(sj["history_count"], 0);
    assert_eq!(sj["eth_chain_id"], 11155111);
}
