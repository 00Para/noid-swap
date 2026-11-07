//! `swap-cli alice-params`: the definition and params files Alice feeds to the stock wallet
//! reproduce the swap file's own 699-byte opening, through the same library `pruv build`
//! uses (`noid_pruv`, linked into the harness) and through an independent re-implementation
//! of what the node does with a `custom_program` definition (`noid_rpc/src/server/objects.rs`
//! `custom_program`, L218-250), because the node's own crate is not buildable offline here.

use std::path::{Path, PathBuf};
use std::process::Command;

use noid_poseidon2b::primitives::Address;
use noid_tx::experimental_object::integer_program::{self, Instruction, Opcode, Operand, Predicate, Register};
use noid_tx::experimental_object::{policy, ObjectOpening, ObjectRules};
use serde::Deserialize;
use serde_json::Value;
use swap_cli::htlc_harness::{self, addr, load_params_guarded, seq_bytes};
use swap_cli::secret::{Secret, Variant};
use swap_cli::swapfile::{example_public, KdfParams, Passphrase, SwapFile, SwapPublic};

fn contracts() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../parano1d/contracts")
}

fn bin() -> Command {
    Command::new(env!("CARGO_BIN_EXE_swap-cli"))
}

fn run(cmd: &mut Command) -> (bool, String, String) {
    let out = cmd.output().expect("run swap-cli");
    (out.status.success(), String::from_utf8_lossy(&out.stdout).into_owned(), String::from_utf8_lossy(&out.stderr).into_owned())
}

#[derive(Deserialize)]
struct Step {
    opcode: Opcode,
    destination: Register,
    left: Operand,
    right: Operand,
    predicate: Predicate,
    immediate: String,
}

/// What the node's `createObject` does with a `custom_program` definition, step by step.
fn node_style_opening(definition: &Value) -> ObjectOpening {
    assert_eq!(definition["kind"], "custom_program");
    let d = &definition["definition"];
    let steps: Vec<Step> = serde_json::from_value(d["program"].clone()).expect("program steps");
    assert!(steps.len() <= integer_program::PROGRAM_STEPS);
    let mut program = integer_program::EMPTY_PROGRAM;
    for (target, step) in program.iter_mut().zip(steps) {
        *target = Instruction {
            opcode: step.opcode,
            destination: step.destination,
            left: step.left,
            right: step.right,
            predicate: step.predicate,
            immediate: step.immediate.parse().expect("canonical decimal immediate"),
        }
        .to_fields();
    }
    let flag = |k: &str| u8::from(d[k].as_bool().unwrap());
    let modes = flag("claim_can_continue") * policy::CLAIM_CONTINUE
        | flag("claim_can_close") * policy::CLAIM_CLOSE
        | flag("recovery_can_continue") * policy::RECOVERY_CONTINUE
        | flag("recovery_can_close") * policy::RECOVERY_CLOSE
        | flag("unrestricted_payout_recipient") * policy::ANY_PAYOUT_RECIPIENT;
    let st: Vec<u64> = d["state"].as_array().unwrap().iter().map(|v| v.as_str().unwrap().parse().unwrap()).collect();
    let a = |k: &str| Address::parse(d[k].as_str().unwrap()).unwrap();
    let opening = ObjectOpening {
        program,
        state: integer_program::pack_state([st[0], st[1]]),
        claim_authority: a("claim_authority"),
        recovery_authority: a("recovery_authority"),
        claim_recipient: a("claim_recipient"),
        recovery_recipient: a("recovery_recipient"),
        deadline: d["deadline_height"].as_u64().unwrap(),
        rules: ObjectRules {
            max_fee: d["max_fee_micronoid"].as_u64().unwrap(),
            max_payout: d["max_payout_micronoid"].as_u64().unwrap(),
            min_retained: d["min_retained_micronoid"].as_u64().unwrap(),
            modes,
        },
    };
    opening.validate().expect("the node validates the opening");
    opening
}

#[test]
fn example_params_through_the_new_entry_point_reproduce_the_committed_definition() {
    let params_path = contracts().join("htlc.params.example.json");
    let params = load_params_guarded(&params_path).unwrap();
    let (opening, definition) = htlc_harness::compile_htlc_params(&params).unwrap();
    let committed_text = std::fs::read_to_string(contracts().join("htlc.definition.json")).unwrap();
    let committed: Value = serde_json::from_str(&committed_text).unwrap();
    // (a) JSON-equal ...
    assert_eq!(definition, committed);
    // ... and byte-for-byte once written the way `alice-params` writes it (pretty JSON + newline).
    let written = format!("{}\n", serde_json::to_string_pretty(&definition).unwrap());
    assert_eq!(written.replace("\r\n", "\n"), committed_text.replace("\r\n", "\n"));
    // The node-style reading of that document is the compiled opening.
    assert_eq!(node_style_opening(&committed), opening);
    // The params object `alice-params` writes has exactly the committed example's shape and values.
    let rebuilt = htlc_harness::htlc_params(
        &Address::parse(params["hashlock_authority"].as_str().unwrap()).unwrap(),
        &Address::parse(params["receiver"].as_str().unwrap()).unwrap(),
        &Address::parse(params["sender"].as_str().unwrap()).unwrap(),
        300_000,
        20_000,
    );
    assert_eq!(rebuilt, params);
    let _ = (addr, seq_bytes); // the example hashlock is the public test vector: never funded
}

fn alice_file(dir: &Path) -> (PathBuf, SwapPublic) {
    let secret = Secret::generate().unwrap();
    let public = example_public(&secret, Variant::Raw);
    let path = dir.join("alice.swap.json");
    SwapFile::new_alice(public.clone(), &secret, &Passphrase::new("correct horse battery staple"), &KdfParams::fast_for_tests(), 1)
        .unwrap()
        .save(&path)
        .unwrap();
    (path, public)
}

#[test]
fn alice_params_files_round_trip_to_the_swap_files_opening() {
    let dir = tempfile::tempdir().unwrap();
    let (alice, public) = alice_file(dir.path());
    let def = dir.path().join("swap.def.json");
    let params = dir.path().join("swap.params.json");
    let (ok, out, err) = run(bin().args(["alice-params", alice.to_str().unwrap(), "--definition-out", def.to_str().unwrap(), "--params-out", params.to_str().unwrap()]));
    assert!(ok, "{err}");
    let v: Value = serde_json::from_str(&out).unwrap();
    assert_eq!(v["opening_hex"], public.opening_hex);
    assert_eq!(v["contract_root"], public.contract_root);
    assert_eq!(v["fund_amount_noid"], "10.000000");
    assert_eq!(v["modes_byte"], 10);
    assert_eq!(v["recovery_authority"], public.params.alice_noid);
    assert_eq!(v["claim_recipient"], public.params.bob_noid);
    assert_eq!(v["deadline_height"], 300_735);
    assert!(v["commands"][0].as_str().unwrap().starts_with("parano1d-cli contract create"));
    assert!(err.contains("ACTIVE address") && err.contains(&public.params.alice_noid), "{err}");

    // (b) The params file, read the way `pruv --params` reads it, compiles in the harness to the swap file's opening.
    let loaded = load_params_guarded(&params).unwrap();
    let (opening, definition) = htlc_harness::compile_htlc_params(&loaded).unwrap();
    assert_eq!(hex::encode(opening.to_bytes().unwrap()), public.opening_hex);
    assert_eq!(opening.root().to_bech32(), public.contract_root);
    // The emitted definition file is exactly what that compile gives ...
    let emitted: Value = serde_json::from_str(&std::fs::read_to_string(&def).unwrap()).unwrap();
    assert_eq!(emitted, definition);
    // ... and read the way the node reads it, it is the same 699 bytes.
    let node_side = node_style_opening(&emitted);
    assert_eq!(node_side, public.opening().unwrap());
    assert_eq!(hex::encode(node_side.to_bytes().unwrap()), public.opening_hex);

    // Re-running with the same outputs is fine; different content under a name is never overwritten.
    let (ok, _, err) = run(bin().args(["alice-params", alice.to_str().unwrap(), "--definition-out", def.to_str().unwrap()]));
    assert!(ok, "{err}");
    std::fs::write(&def, "{}").unwrap();
    let (ok, _, err) = run(bin().args(["alice-params", alice.to_str().unwrap(), "--definition-out", def.to_str().unwrap()]));
    assert!(!ok && err.contains("never overwritten"), "{err}");
}

#[test]
fn check_object_accepts_the_wallets_matching_object_and_refuses_anything_else() {
    let dir = tempfile::tempdir().unwrap();
    let (alice, public) = alice_file(dir.path());
    let other = example_public(&Secret::generate().unwrap(), Variant::Raw);
    // What `parano1d-cli contract create` writes is an ObjectInfo with (at least) these two fields.
    let good = dir.path().join("good.object.json");
    std::fs::write(&good, serde_json::json!({"opening_hex": public.opening_hex, "address": public.contract_root, "abi_version": 3}).to_string()).unwrap();
    let (ok, _, err) = run(bin().args(["alice-params", alice.to_str().unwrap(), "--check-object", good.to_str().unwrap()]));
    assert!(ok && err.contains("object file OK") && err.contains(&public.contract_root), "{err}");
    let bad = dir.path().join("bad.object.json");
    std::fs::write(&bad, serde_json::json!({"opening_hex": other.opening_hex, "address": other.contract_root}).to_string()).unwrap();
    let (ok, _, err) = run(bin().args(["alice-params", alice.to_str().unwrap(), "--check-object", bad.to_str().unwrap()]));
    assert!(!ok && err.contains("MISMATCH") && err.contains("do NOT fund"), "{err}");
}
