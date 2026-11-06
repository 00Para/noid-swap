// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Paranoid Zero.

use std::{
    fs,
    path::Path,
    process::{Command, Output},
};

use noid_poseidon2b::primitives::Address;
use serde_json::json;

fn run(directory: &Path, arguments: &[&str]) -> Output {
    Command::new(env!("CARGO_BIN_EXE_pruv"))
        .current_dir(directory)
        .args(arguments)
        .output()
        .unwrap()
}

fn fixture(directory: &Path) {
    fs::write(
        directory.join("budget.pruv"),
        include_str!("../examples/budget.pruv"),
    )
    .unwrap();
    fs::write(directory.join("params.json"), serde_json::to_vec(&json!({
        "spending_key": Address([1; 32]).to_bech32(), "recovery_key": Address([2; 32]).to_bech32(),
        "recipient": Address([3; 32]).to_bech32(), "recover_at": "1000", "budget": "1000000",
        "max_fee": "100", "max_payment": "10000",
    })).unwrap()).unwrap();
}

#[test]
fn cli_checks_builds_exports_and_preserves_existing_outputs() {
    let directory = tempfile::tempdir().unwrap();
    let root = directory.path();
    fixture(root);
    let checked = run(root, &["check", "budget.pruv", "--params", "params.json"]);
    assert!(
        checked.status.success(),
        "{}",
        String::from_utf8_lossy(&checked.stderr)
    );
    assert!(String::from_utf8_lossy(&checked.stdout).contains("3/16 instructions"));
    let built = run(
        root,
        &[
            "build",
            "budget.pruv",
            "--params",
            "params.json",
            "--out",
            "budget.json",
        ],
    );
    assert!(
        built.status.success(),
        "{}",
        String::from_utf8_lossy(&built.stderr)
    );
    let original = fs::read(root.join("budget.json")).unwrap();
    let definition: serde_json::Value = serde_json::from_slice(&original).unwrap();
    assert_eq!(definition["kind"], "custom_program");
    assert_eq!(definition["definition"]["state"][0], "1000000");
    let repeat = run(
        root,
        &[
            "build",
            "budget.pruv",
            "--params",
            "params.json",
            "--out",
            "budget.json",
        ],
    );
    assert!(!repeat.status.success());
    assert_eq!(fs::read(root.join("budget.json")).unwrap(), original);
    let stdout = run(root, &["build", "budget.pruv", "--params", "params.json"]);
    assert!(stdout.status.success());
    assert_eq!(
        serde_json::from_slice::<serde_json::Value>(&stdout.stdout).unwrap(),
        definition
    );
    let smt = run(
        root,
        &[
            "smt",
            "budget.pruv",
            "--params",
            "params.json",
            "--out",
            "budget.smt2",
        ],
    );
    assert!(smt.status.success());
    let query = fs::read_to_string(root.join("budget.smt2")).unwrap();
    assert_eq!(query.matches("(check-sat)").count(), 2);
}

#[test]
fn cli_rejects_invalid_inputs_without_creating_artifacts() {
    let directory = tempfile::tempdir().unwrap();
    let root = directory.path();
    fixture(root);
    fs::write(root.join("broken.pruv"), "contract Broken { call {").unwrap();
    let syntax = run(root, &["build", "broken.pruv", "--out", "broken.json"]);
    assert!(!syntax.status.success());
    assert!(String::from_utf8_lossy(&syntax.stderr).contains("broken.pruv:1:"));
    assert!(!root.join("broken.json").exists());
    let missing = run(root, &["check", "budget.pruv"]);
    assert!(!missing.status.success());
    assert!(String::from_utf8_lossy(&missing.stderr).contains("missing parameter"));
    fs::write(
        root.join("duplicate.json"),
        r#"{"budget":"1","budget":"2"}"#,
    )
    .unwrap();
    let duplicate = run(
        root,
        &[
            "build",
            "budget.pruv",
            "--params",
            "duplicate.json",
            "--out",
            "duplicate-out.json",
        ],
    );
    assert!(!duplicate.status.success());
    assert!(String::from_utf8_lossy(&duplicate.stderr).contains("duplicate parameter"));
    assert!(!root.join("duplicate-out.json").exists());
    fs::write(
        root.join("large.json"),
        " ".repeat(noid_pruv::MAX_SOURCE_BYTES + 1),
    )
    .unwrap();
    let large = run(
        root,
        &[
            "build",
            "budget.pruv",
            "--params",
            "large.json",
            "--out",
            "large-out.json",
        ],
    );
    assert!(!large.status.success());
    assert!(!root.join("large-out.json").exists());
    let solver = run(
        root,
        &[
            "verify",
            "budget.pruv",
            "--params",
            "params.json",
            "--z3",
            "./missing-z3",
        ],
    );
    assert!(!solver.status.success());
    assert!(String::from_utf8_lossy(&solver.stderr).contains("start Z3"));
}

#[test]
#[ignore = "requires Z3; set PRUV_TEST_Z3 to its executable"]
fn cli_verifies_postconditions_with_z3() {
    let directory = tempfile::tempdir().unwrap();
    fixture(directory.path());
    let z3 = std::env::var("PRUV_TEST_Z3").expect("PRUV_TEST_Z3");
    let result = run(
        directory.path(),
        &[
            "verify",
            "budget.pruv",
            "--params",
            "params.json",
            "--z3",
            &z3,
        ],
    );
    assert!(
        result.status.success(),
        "{}",
        String::from_utf8_lossy(&result.stderr)
    );
    assert!(String::from_utf8_lossy(&result.stdout).contains("2 postconditions verified"));
}
