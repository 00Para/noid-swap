//! Tests for the NOID leg of the atomic-swap HTLC.
//!
//! Layers, from the inside out (see README.md for the full table):
//!   1. `ObjectOpening::check_call` - consensus' native preflight: root binding,
//!      mode bits, fee cap, recipient, shape. Knows nothing about secrets.
//!   2. `prove_experimental_object_authorization` - the prover refuses a witness
//!      whose `Addr(secret)` is not the authority selected by the height.
//!   3. `verify_experimental_object_authorization` - the verifier re-runs
//!      `check_call` and verifies the ZK proof against `(logical_txid, authority)`.

use htlc_harness::*;
use noid_gkr::wallet_authorization::{ProveAuthorizationError, VerifyAuthorizationError};
use noid_tx::experimental_object::{policy, ObjectError};

const ALICE_ADDR_OF_VECTOR: &str = "o1lqvrmvsyl7mkt3cptkz3c965ujt5ce6mjawxwwxe7mgn36mjzt8sn69xw2";

// ---------------------------------------------------------------- a

#[test]
fn addr_vectors() {
    // s = 00 01 02 ... 1f
    let s = seq_bytes(0x00);
    assert_eq!(hex(&s), "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f");
    let a = addr(s);
    assert_eq!(
        hex(&a.0),
        "f8183db204ffb765c7015d851c1754e4974c675b975c6738d9f6d138eb7212cf"
    );
    assert_eq!(a.to_bech32(), ALICE_ADDR_OF_VECTOR);
    // The textual form parses back to the same 32 bytes.
    assert_eq!(noid_poseidon2b::primitives::Address::parse(ALICE_ADDR_OF_VECTOR).unwrap(), a);
    // Different secrets give different addresses (sanity).
    assert_ne!(addr(seq_bytes(0x01)), a);
}

// ---------------------------------------------------------------- compiled contract

#[test]
fn compiled_policy_matches_the_spec() {
    let c = Cast::new();
    let o = standard_opening(&c);
    assert_eq!(o.claim_authority, addr(c.s));
    assert_eq!(o.claim_recipient, c.bob);
    assert_eq!(o.recovery_authority, c.alice);
    assert_eq!(o.recovery_recipient, c.alice);
    assert_eq!(o.deadline, D);
    assert_eq!(o.rules.max_fee, MAX_FEE);
    assert_eq!(o.rules.max_payout, 0);
    assert_eq!(o.rules.min_retained, 0);
    // close-only both sides, no ANY_PAYOUT_RECIPIENT
    assert_eq!(o.rules.modes, policy::CLAIM_CLOSE | policy::RECOVERY_CLOSE);
    assert_eq!(o.rules.modes & policy::ANY_PAYOUT_RECIPIENT, 0);
    // The authorities are distinct from the recipients: knowing s does not
    // let you receive the funds.
    assert_ne!(o.claim_authority, o.claim_recipient);
}

#[test]
fn example_params_reproduce_saved_definition() {
    let dir = concat!(env!("CARGO_MANIFEST_DIR"), "/../contracts/");
    // Load through the guarded loader: it parses like `pruv --params` and runs the
    // M0.6 tool guard (recipient != authority, max_fee >= 5,800) on the file.
    let params = load_params_guarded(std::path::Path::new(&format!("{dir}htlc.params.example.json"))).unwrap();
    let compiled = noid_pruv::compile(HTLC_SOURCE, &params).unwrap();
    assert_eq!(compiled.instructions(), 1);
    assert_eq!(compiled.postconditions(), 1);
    let saved: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(format!("{dir}htlc.definition.json")).unwrap())
            .unwrap();
    assert_eq!(compiled.definition(), saved);
}

// ---------------------------------------------------------------- b

#[test]
fn claim_before_deadline_pays_receiver() {
    let c = Cast::new();
    let o = standard_opening(&c);
    let h = D - 1;
    let page = close_page(&o, FEE, h).expect("build close at D-1");

    let checked = o.check_call(&page, h).expect("check_call accepts");
    assert!(checked.terminal);
    assert_eq!(checked.authority, addr(c.s), "claim branch: authority is Addr(s)");

    // The close has exactly one live output and it belongs to Bob.
    assert_eq!(page.body.outputs[0].owner, c.bob);
    assert_eq!(page.body.outputs[0].amount, AMOUNT - FEE);
    assert_eq!(page.body.fee, FEE);

    // Authorized with the raw secret s: prove + verify succeed.
    let bundle = prove(&page, &o, h, c.s).expect("prove with s");
    verify(&page, &o, h, &bundle).expect("verify");
}

// ---------------------------------------------------------------- c

#[test]
fn claim_with_wrong_secret_rejected() {
    let c = Cast::new();
    let o = standard_opening(&c);
    let h = D - 1;
    let page = close_page(&o, FEE, h).unwrap();

    // Layer 1: check_call cannot see secrets; the call itself is well-formed.
    assert!(o.check_call(&page, h).is_ok());

    // Layer 2: the prover refuses a witness with Addr(s') != authority.
    let err = prove(&page, &o, h, c.s_wrong).err().expect("prover must refuse s'");
    assert_eq!(
        err,
        ProveAuthorizationError::BoundaryMismatch { input_index: 0, field: "owner_auth" }
    );
    // Alice's refund secret does not work on the claim branch either.
    assert!(prove(&page, &o, h, c.alice_secret).is_err());

    // Layer 3: a proof made by an attacker for a *decoy* contract whose claim
    // authority is Addr(s') (same page shape, same Bob payout) does not verify
    // against the real contract: it binds a different txid and authority.
    let decoy = compile_htlc(addr(c.s_wrong), c.bob, c.alice, D, MAX_FEE);
    let decoy_page = close_page(&decoy, FEE, h).unwrap();
    let decoy_proof = prove(&decoy_page, &decoy, h, c.s_wrong).expect("decoy proof is valid for the decoy");
    verify(&decoy_page, &decoy, h, &decoy_proof).expect("decoy verifies against the decoy");
    let err = verify(&page, &o, h, &decoy_proof).err().expect("must not verify for the real contract");
    assert_eq!(err, VerifyAuthorizationError::AuthProof);

    // Replaying the real proof (made with s) on a different page is rejected too.
    let good = prove(&page, &o, h, c.s).unwrap();
    let other_page = with_body(&page, |b| b.epoch_anchor[0] ^= 1);
    assert!(o.check_call(&other_page, h).is_ok());
    assert_eq!(verify(&other_page, &o, h, &good).err(), Some(VerifyAuthorizationError::AuthProof));
}

// ---------------------------------------------------------------- d

#[test]
fn claim_after_deadline_rejected() {
    let c = Cast::new();
    let o = standard_opening(&c);

    // The Bob-paying page valid at D-1 ...
    let bob_page = close_page(&o, FEE, D - 1).unwrap();
    assert!(o.check_call(&bob_page, D - 1).is_ok());
    // ... is rejected from height D on: the recipient flips to Alice.
    assert_eq!(o.check_call(&bob_page, D).err(), Some(ObjectError::Recipient));
    assert_eq!(o.check_call(&bob_page, D + 10_000).err(), Some(ObjectError::Recipient));
    // so no authorization (even with the right secret s) can be proven or verified for it
    assert!(matches!(
        prove(&bob_page, &o, D, c.s),
        Err(ProveAuthorizationError::OwnerAuthStatement(_))
    ));
    let early = prove(&bob_page, &o, D - 1, c.s).unwrap();
    assert!(matches!(
        verify(&bob_page, &o, D, &early),
        Err(VerifyAuthorizationError::OwnerAuthStatement(_))
    ));

    // The only call that is well-formed at height D pays Alice, and its
    // authority is Alice's, not Addr(s): s is useless.
    let alice_page = close_page(&o, FEE, D).unwrap();
    let checked = o.check_call(&alice_page, D).unwrap();
    assert_eq!(checked.authority, c.alice);
    assert_ne!(checked.authority, addr(c.s));
    assert_eq!(
        prove(&alice_page, &o, D, c.s).err(),
        Some(ProveAuthorizationError::BoundaryMismatch { input_index: 0, field: "owner_auth" })
    );

    // Boundary exactness: authority at D-1 is Addr(s), at D it is Alice.
    assert_eq!(o.authority_at(D - 1), addr(c.s));
    assert_eq!(o.authority_at(D), c.alice);
}

// ---------------------------------------------------------------- e

#[test]
fn refund_after_deadline_pays_sender() {
    let c = Cast::new();
    let o = standard_opening(&c);
    for h in [D, D + 1, D + 123_456] {
        let page = close_page(&o, FEE, h).expect("build refund");
        let checked = o.check_call(&page, h).expect("check_call accepts refund");
        assert!(checked.terminal);
        assert_eq!(checked.authority, c.alice);
        assert_eq!(page.body.outputs[0].owner, c.alice);
        assert_eq!(page.body.outputs[0].amount, AMOUNT - FEE);
        let bundle = prove(&page, &o, h, c.alice_secret).expect("prove with Alice's secret");
        verify(&page, &o, h, &bundle).expect("verify refund");
    }
}

// ---------------------------------------------------------------- f

#[test]
fn refund_before_deadline_rejected() {
    let c = Cast::new();
    let o = standard_opening(&c);
    let h = D - 1;

    // A page paying Alice at D-1 (what a refund would look like) is rejected by
    // check_call: the committed recipient before the deadline is Bob.
    let refund_page = close_page(&o, FEE, D).unwrap();
    assert_eq!(refund_page.body.outputs[0].owner, c.alice);
    assert_eq!(o.check_call(&refund_page, h).err(), Some(ObjectError::Recipient));
    assert!(matches!(
        prove(&refund_page, &o, h, c.alice_secret),
        Err(ProveAuthorizationError::OwnerAuthStatement(_))
    ));

    // The well-formed (Bob-paying) page cannot be authorized by Alice: the
    // authority at D-1 is Addr(s), not Alice.
    let page = close_page(&o, FEE, h).unwrap();
    assert_eq!(
        prove(&page, &o, h, c.alice_secret).err(),
        Some(ProveAuthorizationError::BoundaryMismatch { input_index: 0, field: "owner_auth" })
    );

    // A proof Alice made for the refund page at D does not verify at D-1.
    let proof = prove(&refund_page, &o, D, c.alice_secret).unwrap();
    verify(&refund_page, &o, D, &proof).unwrap();
    assert!(matches!(
        verify(&refund_page, &o, h, &proof),
        Err(VerifyAuthorizationError::OwnerAuthStatement(_))
    ));
}

// ---------------------------------------------------------------- g

#[test]
fn close_must_pay_committed_recipient() {
    let c = Cast::new();
    let o = standard_opening(&c);
    let h = D - 1;
    let good = close_page(&o, FEE, h).unwrap();

    // Someone who learned s tries to redirect the payout.
    for thief in [c.mallory, c.alice, addr(c.s)] {
        let bad = with_body(&good, |b| b.outputs[0].owner = thief);
        assert_eq!(
            o.check_call(&bad, h).err(),
            Some(ObjectError::Recipient),
            "payout to {} must be rejected",
            thief.to_bech32()
        );
        // Even the holder of s cannot get an authorization for it.
        match prove(&bad, &o, h, c.s) {
            Err(ProveAuthorizationError::OwnerAuthStatement(msg)) => {
                assert!(msg.contains("Recipient"), "{msg}")
            }
            other => panic!("expected OwnerAuthStatement(Recipient), got {:?}", other.err()),
        }
    }

    // Same on the refund side: after the deadline the payout must go to Alice.
    let refund = close_page(&o, FEE, D).unwrap();
    let bad = with_body(&refund, |b| b.outputs[0].owner = c.mallory);
    assert_eq!(o.check_call(&bad, D).err(), Some(ObjectError::Recipient));
    let bad_bob = with_body(&refund, |b| b.outputs[0].owner = c.bob);
    assert_eq!(o.check_call(&bad_bob, D).err(), Some(ObjectError::Recipient));

    // The worst a holder of s can do is the intended thing: close to Bob.
    let bundle = prove(&good, &o, h, c.s).unwrap();
    verify(&good, &o, h, &bundle).unwrap();
}

#[test]
fn continuing_calls_and_payout_outputs_rejected() {
    // Close-only modes: a holder of s cannot keep the contract alive or peel off
    // a payout output (this is what stops a partial drain).
    let c = Cast::new();
    let o = standard_opening(&c);

    // The honest builder computes the successor by running the program first, so
    // the program's own `require terminal` (step 0) fires before the policy check.
    for h in [D - 1, D] {
        let err = o
            .build_call(input(), 2, FEE, EPOCH_ANCHOR, h, false)
            .err()
            .expect("continuing call must fail");
        assert_eq!(
            err,
            ObjectError::Program(noid_tx::experimental_object::integer_program::ProgramError::Assertion { step: 0 }),
            "continuing call at {h}"
        );
    }

    // A hand-made continuing page (terminal bit cleared) never reaches the
    // program: check_call's policy layer rejects it because the mode bits
    // CLAIM_CONTINUE / RECOVERY_CONTINUE are off.
    for h in [D - 1, D] {
        let term = close_page(&o, FEE, h).unwrap();
        let cont = with_body(&term, |b| b.validity_bitmap &= !noid_tx::PAGED_SPEND_TERMINAL_BIT);
        assert_eq!(o.check_call(&cont, h).err(), Some(ObjectError::Policy), "continuing page at {h}");
        assert!(prove(&cont, &o, h, if h < D { c.s } else { c.alice_secret }).is_err());
    }

    // A payout output (second output) alongside a close is a shape violation.
    let term = close_page(&o, FEE, D - 1).unwrap();
    let with_payout = with_body(&term, |b| {
        b.validity_bitmap |= noid_tx::output_bitmap_bit(1);
        b.outputs[1] = noid_tx::TxOutput { slot_index: 3, amount: 100, owner: c.mallory };
        b.outputs[0].amount -= 100;
    });
    assert_eq!(o.check_call(&with_payout, D - 1).err(), Some(ObjectError::Shape));
    let payout = noid_tx::TxOutput { slot_index: 3, amount: 100, owner: c.mallory };
    assert!(o.build_payment(input(), 2, FEE, EPOCH_ANCHOR, D - 1, payout).is_err());
}

#[test]
fn wrong_opening_is_rejected() {
    // The page commits to the opening's root; an opening with any term changed
    // (here: a later deadline) is a different contract.
    let c = Cast::new();
    let o = standard_opening(&c);
    let page = close_page(&o, FEE, D - 1).unwrap();
    let longer = compile_htlc(addr(c.s), c.bob, c.alice, D + 1, MAX_FEE);
    assert_ne!(longer.root(), o.root());
    assert_eq!(longer.check_call(&page, D - 1).err(), Some(ObjectError::OldObject));
}

// ---------------------------------------------------------------- h

#[test]
fn fee_capped_by_max_fee() {
    let c = Cast::new();
    let o = standard_opening(&c);

    // fee == max_fee is fine (both branches)
    for h in [D - 1, D] {
        let p = close_page(&o, MAX_FEE, h).unwrap();
        assert!(o.check_call(&p, h).is_ok());
    }
    // fee == max_fee + 1 is not (builder runs check_call internally).
    for h in [D - 1, D] {
        assert_eq!(close_page(&o, MAX_FEE + 1, h).err(), Some(ObjectError::FeeLimit));
    }
    // A hand-edited page with the fee raised (value conserved) fails check_call
    // and cannot be authorized, even with the right secret.
    let ok = close_page(&o, MAX_FEE, D - 1).unwrap();
    let bad = with_body(&ok, |b| {
        b.fee += 1;
        b.outputs[0].amount -= 1;
    });
    assert_eq!(o.check_call(&bad, D - 1).err(), Some(ObjectError::FeeLimit));
    assert!(matches!(
        prove(&bad, &o, D - 1, c.s),
        Err(ProveAuthorizationError::OwnerAuthStatement(_))
    ));
    // The griefing bound: s-holder can burn exactly up to max_fee, no more, and
    // Bob's payout is still the full remainder.
    let p = close_page(&o, MAX_FEE, D - 1).unwrap();
    assert_eq!(p.body.outputs[0].amount, AMOUNT - MAX_FEE);
    assert_eq!(p.body.outputs[0].owner, c.bob);
}
