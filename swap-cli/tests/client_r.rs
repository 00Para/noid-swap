//! M2.6 client R: Bob's raw-secret claim is built, proved with `noid_gkr`,
//! self-verified and encoded exactly as the node's wallet does; submission is
//! a mock that decodes and re-verifies what it receives. Every proof here is
//! real (about 1.5 s each).

use swap_cli::client::raw::*;
use swap_cli::client::IntentSubmitter;
use swap_cli::engine::{Action, Runner};
use swap_cli::params::ClaimHeight;
use swap_cli::secret::{PreimageError, Secret, Variant};
use swap_cli::state::{BobPhase, Event, LockSummary, Phase};
use swap_cli::params::ContractVersion;
use swap_cli::swapfile::{example_public, example_public_v, SwapFile, SwapPublic};
use swap_cli::watch::{EthObservation, FixtureRpc, NoidInstance, NoidObservation, RpcError};

const ANCHOR: [u8; 32] = [7; 32];

fn setup(variant: Variant) -> (Secret, SwapPublic, NoidInstance) {
    let s = Secret::generate().unwrap();
    let p = example_public(&s, variant);
    let inst = NoidInstance { slot_index: 11, creation_id: 3, amount_micronoid: p.params.amount_micronoid };
    (s, p, inst)
}

fn inputs<'a>(s: &'a Secret, p: &'a SwapPublic, opening: &'a noid_tx::experimental_object::ObjectOpening, inst: &'a NoidInstance, height: u64, fee: u64) -> ClaimInputs<'a> {
    ClaimInputs {
        opening,
        instance: inst,
        output_slot: 2,
        fee_micronoid: fee,
        epoch_anchor: ANCHOR,
        call_height: height,
        hashlock: p.hashlock,
        variant: p.params.variant,
        secret: s,
    }
}

#[test]
fn raw_claim_builds_proves_and_encodes_a_valid_intent() {
    let (s, p, inst) = setup(Variant::Raw);
    let opening = p.opening().unwrap();
    let d = p.params.deadline_height;
    let h = d - 18;
    let plan = build_claim(inputs(&s, &p, &opening, &inst, h, 6_000)).unwrap();
    assert_eq!(plan.height_class, ClaimHeight::OnTarget);
    assert_eq!(plan.version, noid_tx::OwnerAuthorizationVersion::V4);
    assert_eq!(plan.recipient.to_bech32(), p.params.bob_noid);
    assert_eq!(plan.amount_out, inst.amount_micronoid - 6_000);
    assert_eq!(plan.call_height, h);
    // What a node does on submitTxIntent: decode, check, verify the proof.
    let (intent, txid) = verify_intent_bytes(&plan.intent_bytes, h).unwrap();
    assert_eq!(intent.opening, opening);
    assert_eq!(txid, plan.txid);
    assert_eq!(intent.spend.pages.len(), 1);
    assert_eq!(intent.spend.pages[0].body.outputs[0].owner, opening.claim_recipient);
    // The same bytes do not verify for inclusion on the recovery branch.
    assert!(matches!(verify_intent_bytes(&plan.intent_bytes, d), Err(ClaimError::SelfVerify(_))));
    // A flipped byte in the proof is caught by the verifier (or the decoder).
    let mut bad = plan.intent_bytes.clone();
    let n = bad.len();
    bad[n - 100] ^= 1;
    assert!(verify_intent_bytes(&bad, h).is_err());
}

#[test]
fn stock_variant_claim_uses_the_derived_witness() {
    let (m, p, inst) = setup(Variant::Stock);
    let opening = p.opening().unwrap();
    let h = p.params.deadline_height - 20;
    assert_eq!(opening.claim_authority, m.authority(Variant::Stock));
    let plan = build_claim(inputs(&m, &p, &opening, &inst, h, 6_000)).unwrap();
    verify_intent_bytes(&plan.intent_bytes, h).unwrap();
    // The raw witness m itself cannot authorize a stock-variant contract.
    let mut raw = inputs(&m, &p, &opening, &inst, h, 6_000);
    raw.variant = Variant::Raw;
    assert_eq!(build_claim(raw).unwrap_err(), ClaimError::Preimage(PreimageError::AuthorityMismatch));
}

#[test]
fn raw_claim_refuses_bad_inputs_before_proving() {
    let (s, p, inst) = setup(Variant::Raw);
    let opening = p.opening().unwrap();
    let d = p.params.deadline_height;
    let other = Secret::generate().unwrap();
    assert_eq!(
        build_claim(inputs(&other, &p, &opening, &inst, d - 18, 6_000)).unwrap_err(),
        ClaimError::Preimage(PreimageError::HashlockMismatch)
    );
    assert_eq!(
        build_claim(inputs(&s, &p, &opening, &inst, d, 6_000)).unwrap_err(),
        ClaimError::BranchClosed { call_height: d, deadline: d }
    );
    assert_eq!(
        build_claim(inputs(&s, &p, &opening, &inst, d - 18, 5_799)).unwrap_err(),
        ClaimError::Fee { fee: 5_799, min: 5_800, max: p.params.max_fee_micronoid }
    );
    assert_eq!(
        build_claim(inputs(&s, &p, &opening, &inst, d - 18, p.params.max_fee_micronoid + 1)).unwrap_err(),
        ClaimError::Fee { fee: p.params.max_fee_micronoid + 1, min: 5_800, max: p.params.max_fee_micronoid }
    );
    // D - 1 is valid but flagged.
    let plan = build_claim(inputs(&s, &p, &opening, &inst, d - 1, p.params.max_fee_micronoid)).unwrap();
    assert_eq!(plan.height_class, ClaimHeight::LateButValid);
    assert_eq!(plan.fee_micronoid, p.params.max_fee_micronoid);
}

#[test]
fn submit_fans_out_to_every_node_and_reports_each_answer() {
    let (s, p, inst) = setup(Variant::Raw);
    let opening = p.opening().unwrap();
    let h = p.params.deadline_height - 30;
    let plan = build_claim(inputs(&s, &p, &opening, &inst, h, 6_000)).unwrap();
    let good = MockSubmitter::new(MockAnswer::VerifyAt(h));
    let busy = MockSubmitter::new(MockAnswer::Reject("SlotConflict".into()));
    let liar = MockSubmitter::new(MockAnswer::Txid("00".repeat(32)));
    let report = submit_claim(&plan, &[("a", &good), ("b", &busy), ("c", &liar)]).unwrap();
    assert_eq!(report.txid_hex, plan.txid_hex());
    assert_eq!(report.accepted, vec!["a"]);
    assert_eq!(report.rejected.len(), 2);
    assert!(report.rejected[0].1.contains("SlotConflict"));
    assert!(report.rejected[1].1.contains("txid mismatch"));
    assert_eq!(good.received.lock().unwrap()[0], plan.intent_hex());
    // A node verifying at the wrong height rejects (the proof is bound to the branch).
    let wrong = MockSubmitter::new(MockAnswer::VerifyAt(p.params.deadline_height));
    assert!(matches!(submit_claim(&plan, &[("w", &wrong)]), Err(ClaimError::AllNodesRejected(_))));
}

#[test]
fn raw_executor_drives_bobs_claim_through_the_runner() {
    let (s, p, inst) = setup(Variant::Raw);
    let d = p.params.deadline_height;
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("bob.swap.json");
    // Bob already saw the secret on Ethereum.
    let mut file = swap_cli::swapfile::example_bob_file(p.clone(), 1).unwrap();
    let lock = LockSummary { lock_id: [1; 32], t_reveal: 2_000_000, amount_wei: p.params.eth.amount_wei, block_number: 5, sender: p.params.eth.bob_sender, receiver: p.params.eth.alice_receiver };
    for e in [
        Event::NoidInstanceSeen { instance: inst.clone(), tip: 300_005 },
        Event::NoidFundingFinal { tip: 300_022 },
        Event::LockSubmitted { t_reveal: 2_000_000, amount_wei: p.params.eth.amount_wei, tx_hash: None, at: 1 },
        Event::EthLockSeen { lock },
        Event::EthPreimageSeen { preimage: *s.bytes(), tip: 300_100, time: 1_000 },
    ] {
        file.apply(&e, 1).unwrap();
    }
    let call_height = d - 18;
    let rpc = FixtureRpc::from_results(
        "node",
        vec![("paranoid_getEpochAnchor", serde_json::json!(hex::encode(ANCHOR))), ("paranoid_getSlotHints", serde_json::json!([2]))],
    );
    let node: Box<dyn IntentSubmitter> = Box::new(MockSubmitter::new(MockAnswer::VerifyAt(call_height)));
    let executor = RawClaimExecutor::new(rpc, vec![("node-1".into(), node)]);
    let mut runner = Runner::create(file, path.clone(), executor).unwrap();
    let noid = NoidObservation {
        observed_at: Some(1_000),
        tip: call_height - 1,
        next_call_height: call_height,
        epoch_anchor: Some(ANCHOR),
        fee_estimate_1_1: Some(6_000),
        fee_floor: Some(5_800),
        instance: Some(inst.clone()),
        instance_matches_opening: Some(true),
        tip_time: Some(1_000), // REVIEW-3 F5: an unknown header time blocks every NOID-side spend
        ..Default::default()
    };
    let eth = EthObservation { observed_at: Some(1_000), latest_block: 10, latest_timestamp: 1_000, ..Default::default() };
    let report = runner.tick(&noid, &eth, 1_000).unwrap();
    assert!(matches!(report.action, Action::ClaimNoid { call_height: h, fee_micronoid: 6_000, .. } if h == call_height), "{report:?}");
    assert_eq!(report.exec_error, None);
    let txid = match &runner.file.phase {
        Phase::Bob(BobPhase::ClaimSubmitted { txid, call_height: h, attempts, .. }) => {
            assert_eq!(*h, call_height);
            assert_eq!(*attempts, 1);
            txid.clone()
        }
        other => panic!("{other:?}"),
    };
    let plan = runner.executor.last_plan.as_ref().unwrap();
    assert_eq!(plan.txid_hex(), txid);
    assert_eq!(runner.executor.last_report.as_ref().unwrap().accepted, vec!["node-1"]);
    assert!(runner.file.pending_action.is_none());
    // Persisted: a restart would track the same txid.
    let on_disk = SwapFile::load(&path).unwrap();
    assert_eq!(on_disk.phase, runner.file.phase);
    // The executor refuses actions that are not its job.
    let err = swap_cli::engine::Executor::execute(&mut runner.executor, &runner.file, &Action::RefundEth { lock_id: [1; 32] }, 1).unwrap_err();
    assert!(err.message.contains("does not perform") && !err.maybe_sent);
    // And an RPC failure surfaces as an execution error, leaving the file untouched.
    let dead = FixtureRpc::from_results("dead", vec![]);
    let mut e2 = RawClaimExecutor::new(dead, Vec::new());
    let err = swap_cli::engine::Executor::execute(&mut e2, &on_disk, &report.action, 1).unwrap_err();
    assert!((err.message.contains("getSlotHints") || err.message.contains("fixture")) && !err.maybe_sent, "{err}");
    let _ = RpcError::Fixture(String::new());
}

// ------------------------------------------------------------------------------------------
// Contract versions. v1 (HashTimeLock): any fee in [5,800, max_fee]. v2 (HashTimeLockV2): exactly max_fee.
// ------------------------------------------------------------------------------------------

fn setup_v(variant: Variant, version: ContractVersion) -> (Secret, SwapPublic, NoidInstance) {
    let s = Secret::generate().unwrap();
    let p = example_public_v(&s, variant, version);
    let inst = NoidInstance { slot_index: 11, creation_id: 3, amount_micronoid: p.params.amount_micronoid };
    (s, p, inst)
}

#[test]
fn v2_claim_pays_exactly_max_fee_and_the_proof_verifies() {
    let (s, p, inst) = setup_v(Variant::Raw, ContractVersion::V2);
    assert_eq!(p.params.contract_version, ContractVersion::V2);
    let opening = p.opening().unwrap();
    let max_fee = p.params.max_fee_micronoid;
    let h = p.params.deadline_height - 18;
    // One real proof: fee == max_fee.
    let plan = build_claim(inputs(&s, &p, &opening, &inst, h, max_fee)).unwrap();
    assert_eq!(plan.fee_micronoid, max_fee);
    assert_eq!(plan.amount_out, inst.amount_micronoid - max_fee);
    assert_eq!(Some(plan.amount_out), p.params.expected_bob_payout());
    assert_eq!(plan.recipient.to_bech32(), p.params.bob_noid);
    assert_eq!(plan.page.body.fee, max_fee);
    let (intent, txid) = verify_intent_bytes(&plan.intent_bytes, h).unwrap();
    assert_eq!(intent.opening, opening);
    assert_eq!(txid, plan.txid);
    assert!(opening.check_call(&plan.page, h).is_ok());
}

#[test]
fn v2_claim_refuses_every_other_fee_before_proving() {
    let (s, p, inst) = setup_v(Variant::Raw, ContractVersion::V2);
    let opening = p.opening().unwrap();
    let max_fee = p.params.max_fee_micronoid;
    let h = p.params.deadline_height - 18;
    for fee in [5_800, 6_000, max_fee - 1, max_fee + 1] {
        let err = build_claim(inputs(&s, &p, &opening, &inst, h, fee)).unwrap_err();
        assert_eq!(err, ClaimError::Fee { fee, min: max_fee, max: max_fee }, "fee {fee}");
        assert!(err.to_string().contains("exactly max_fee"), "{err}");
    }
}

#[test]
fn v1_claim_keeps_its_range_and_v1_openings_are_detected_as_v1() {
    let (s, p, inst) = setup_v(Variant::Raw, ContractVersion::V1);
    let opening = p.opening().unwrap();
    assert_eq!(swap_cli::swapfile::detect_contract_version(&opening), Some(ContractVersion::V1));
    let v2 = example_public_v(&s, Variant::Raw, ContractVersion::V2);
    assert_eq!(swap_cli::swapfile::detect_contract_version(&v2.opening().unwrap()), Some(ContractVersion::V2));
    let h = p.params.deadline_height - 18;
    // Range errors exactly as before; no proof is built for them.
    assert_eq!(
        build_claim(inputs(&s, &p, &opening, &inst, h, 5_799)).unwrap_err(),
        ClaimError::Fee { fee: 5_799, min: 5_800, max: p.params.max_fee_micronoid }
    );
    // A fee strictly inside the range is a valid v1 close but not a v2 one: the v2 program asserts `fee == max_fee`,
    // and the builder (which runs the same program) refuses it.
    let v2_opening = v2.opening().unwrap();
    let input = noid_tx::TxInput { slot_index: inst.slot_index, amount: inst.amount_micronoid, creation_id: inst.creation_id };
    let page = opening.build_call(input, 2, 6_000, ANCHOR, h, true).unwrap();
    assert!(opening.check_call(&page, h).is_ok());
    assert!(v2_opening.build_call(input, 2, 6_000, ANCHOR, h, true).is_err());
    assert!(v2_opening.build_call(input, 2, v2.params.max_fee_micronoid, ANCHOR, h, true).is_ok());
}

#[test]
fn raw_executor_drives_a_v2_claim_with_the_fixed_fee_and_refuses_a_version_mix_up() {
    let (s, p, inst) = setup_v(Variant::Raw, ContractVersion::V2);
    let d = p.params.deadline_height;
    let max_fee = p.params.max_fee_micronoid;
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("bob.swap.json");
    let mut file = swap_cli::swapfile::example_bob_file(p.clone(), 1).unwrap();
    let lock = LockSummary { lock_id: [1; 32], t_reveal: 2_000_000, amount_wei: p.params.eth.amount_wei, block_number: 5, sender: p.params.eth.bob_sender, receiver: p.params.eth.alice_receiver };
    for e in [
        Event::NoidInstanceSeen { instance: inst.clone(), tip: 300_005 },
        Event::NoidFundingFinal { tip: 300_022 },
        Event::LockSubmitted { t_reveal: 2_000_000, amount_wei: p.params.eth.amount_wei, tx_hash: None, at: 1 },
        Event::EthLockSeen { lock },
        Event::EthPreimageSeen { preimage: *s.bytes(), tip: 300_100, time: 1_000 },
    ] {
        file.apply(&e, 1).unwrap();
    }
    let call_height = d - 18;
    let rpc = FixtureRpc::from_results(
        "node",
        vec![("paranoid_getEpochAnchor", serde_json::json!(hex::encode(ANCHOR))), ("paranoid_getSlotHints", serde_json::json!([2]))],
    );
    let node: Box<dyn IntentSubmitter> = Box::new(MockSubmitter::new(MockAnswer::VerifyAt(call_height)));
    let executor = RawClaimExecutor::new(rpc, vec![("node-1".into(), node)]);
    let mut runner = Runner::create(file, path, executor).unwrap();
    // The live estimate is 6,000 and the floor 5,800; v2 ignores both.
    let noid = NoidObservation {
        observed_at: Some(1_000),
        tip: call_height - 1,
        next_call_height: call_height,
        epoch_anchor: Some(ANCHOR),
        fee_estimate_1_1: Some(6_000),
        fee_floor: Some(5_800),
        instance: Some(inst.clone()),
        instance_matches_opening: Some(true),
        tip_time: Some(1_000), // REVIEW-3 F5: an unknown header time blocks every NOID-side spend
        ..Default::default()
    };
    let eth = EthObservation { observed_at: Some(1_000), latest_block: 10, latest_timestamp: 1_000, ..Default::default() };
    let report = runner.tick(&noid, &eth, 1_000).unwrap();
    assert!(matches!(report.action, Action::ClaimNoid { call_height: h, fee_micronoid, .. } if h == call_height && fee_micronoid == max_fee), "{report:?}");
    assert_eq!(report.exec_error, None);
    let plan = runner.executor.last_plan.as_ref().unwrap();
    assert_eq!(plan.fee_micronoid, max_fee);
    assert_eq!(plan.amount_out, inst.amount_micronoid - max_fee);
    assert_eq!(runner.executor.last_report.as_ref().unwrap().accepted, vec!["node-1"]);

    // A file that says v2 but holds a v1 opening is refused before anything is built (no proof, nothing sent).
    let mut mixed = SwapFile::load(&runner.path).unwrap();
    mixed.public.opening_hex = example_public_v(&s, Variant::Raw, ContractVersion::V1).opening_hex;
    let fee_action = Action::ClaimNoid { call_height, fee_micronoid: max_fee, preimage: *s.bytes() };
    let rpc = FixtureRpc::from_results(
        "node",
        vec![("paranoid_getEpochAnchor", serde_json::json!(hex::encode(ANCHOR))), ("paranoid_getSlotHints", serde_json::json!([2]))],
    );
    let mut e2 = RawClaimExecutor::new(rpc, Vec::new());
    let err = swap_cli::engine::Executor::execute(&mut e2, &mixed, &fee_action, 1).unwrap_err();
    assert!(err.message.contains("contract v2") && !err.maybe_sent, "{err}");
}
