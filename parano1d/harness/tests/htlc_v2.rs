//! HashTimeLock v2 (fixed fee): `contracts/htlc_v2.pruv` = v1 plus the rule
//! "a close must pay exactly `max_fee`" (`require fee == max_fee;`).
//!
//! Why it exists: with v1 a close may pay any fee in [network minimum, max_fee],
//! so whoever knows the secret can broadcast a minimum-fee close that still pays
//! Bob and that Bob cannot outbid in a first-seen mempool (docs/protocol-design.md
//! T2 / Q1). With v2 there is no cheaper valid close.
//!
//! Layers exercised (same as `htlc.rs`):
//!   1. `ObjectOpening::check_call`: root binding, modes, fee ceiling, THEN the
//!      integer program (`fee == max_fee` is instruction 1), then the recipient.
//!   2. the prover refuses a statement that `check_call` rejects.
//!   3. the verifier re-runs `check_call`.
//!
//! This file only reads `htlc_v2.pruv`; `lib.rs` (and with it the v1 program the
//! live runs pin) is untouched. Real `noid_gkr` proofs are used in exactly one
//! test (claim + refund + one verifier rejection), a few seconds each.

use htlc_harness::*;
use noid_gkr::wallet_authorization::{ProveAuthorizationError, VerifyAuthorizationError};
use noid_poseidon2b::primitives::Address;
use noid_tx::experimental_object::integer_program::ProgramError;
use noid_tx::experimental_object::{policy, ObjectError, ObjectOpening};

/// Source of the v2 contract, embedded so the tests cannot drift from it.
const V2_SOURCE: &str = include_str!("../../contracts/htlc_v2.pruv");
const CONTRACTS: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../contracts/");

/// `MAX_FEE` (10,000) is both the ceiling and the exact fee in v2.
const F: u64 = MAX_FEE;

// ---------------------------------------------------------------- helpers

/// Guarded compile of the v2 source from a params object: the same guard as v1
/// (`check_params_value` before, `check_opening` after), only the source differs.
fn compile_v2_params(
    params: &serde_json::Value,
) -> Result<(ObjectOpening, serde_json::Value), GuardError> {
    check_params_value(params)?;
    let compiled = noid_pruv::compile(V2_SOURCE, params).map_err(|e| {
        GuardError::BadParams(format!("htlc_v2.pruv does not compile with these params: {e:?}"))
    })?;
    let opening = compiled.opening().clone();
    check_opening(&opening)?;
    Ok((opening, compiled.definition()))
}

fn compile_v2(
    hashlock: Address,
    receiver: Address,
    sender: Address,
    timeout_height: u64,
    max_fee: u64,
) -> ObjectOpening {
    let params = htlc_params(&hashlock, &receiver, &sender, timeout_height, max_fee);
    compile_v2_params(&params).expect("v2 compiles and passes the guard").0
}

fn standard_v2(c: &Cast) -> ObjectOpening {
    compile_v2(addr(c.s), c.bob, c.alice, D, F)
}

/// The program's own assertion at instruction index `step`.
fn assertion(step: usize) -> ObjectError {
    ObjectError::Program(ProgramError::Assertion { step })
}

fn secret_for(c: &Cast, h: u64) -> [u8; 32] {
    if h < D {
        c.s
    } else {
        c.alice_secret
    }
}

// ---------------------------------------------------------------- (a) compiles, guards accept

#[test]
fn v2_compiles_and_guards_accept() {
    let c = Cast::new();
    let o = standard_v2(&c);

    // Same committed policy as v1.
    assert_eq!(o.claim_authority, addr(c.s));
    assert_eq!(o.claim_recipient, c.bob);
    assert_eq!(o.recovery_authority, c.alice);
    assert_eq!(o.recovery_recipient, c.alice);
    assert_eq!(o.deadline, D);
    assert_eq!(o.rules.max_fee, F);
    assert_eq!(o.rules.max_payout, 0);
    assert_eq!(o.rules.min_retained, 0);
    assert_eq!(o.rules.modes, policy::CLAIM_CLOSE | policy::RECOVERY_CLOSE);
    assert_eq!(o.rules.modes & policy::ANY_PAYOUT_RECIPIENT, 0);
    assert_ne!(o.claim_authority, o.claim_recipient);

    // The guard accepts the params and the compiled opening.
    assert_eq!(check_swap_params(&o.claim_authority, &o.claim_recipient, o.rules.max_fee), Ok(()));
    assert_eq!(check_opening(&o), Ok(()));

    // The v2 program is a different program: a different contract address than v1
    // for identical parameters, so a v1 opening can never be mistaken for a v2 one.
    let v1 = compile_htlc(addr(c.s), c.bob, c.alice, D, F);
    assert_ne!(o.root(), v1.root());
    let v1_page = close_page(&v1, F, D - 1).unwrap();
    assert_eq!(o.check_call(&v1_page, D - 1).err(), Some(ObjectError::OldObject));
}

#[test]
fn v2_example_params_reproduce_saved_definition() {
    let params =
        load_params_guarded(std::path::Path::new(&format!("{CONTRACTS}htlc.params.example.json"))).unwrap();
    let compiled = noid_pruv::compile(V2_SOURCE, &params).unwrap();
    assert_eq!(compiled.instructions(), 2, "terminal + fee == max_fee");
    assert_eq!(compiled.postconditions(), 2);
    let saved: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(format!("{CONTRACTS}htlc_v2.definition.json")).unwrap())
            .unwrap();
    assert_eq!(compiled.definition(), saved);

    // The fee constant embedded in the program is exactly the params' max_fee
    // (20,000 in the example file), and so is the policy ceiling.
    let def = &saved["definition"];
    assert_eq!(def["max_fee_micronoid"], 20_000);
    assert_eq!(def["program"][1]["opcode"], "assert_equal");
    assert_eq!(def["program"][1]["left"], "fee");
    assert_eq!(def["program"][1]["right"], "immediate");
    assert_eq!(def["program"][1]["immediate"], "20000");

    // The v1 definition is untouched and still a 1-instruction program.
    let v1: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(format!("{CONTRACTS}htlc.definition.json")).unwrap())
            .unwrap();
    assert_eq!(v1["definition"]["program"][0]["left"], "terminal");
    assert_eq!(v1["definition"]["program"].as_array().unwrap().len(), 1);
    assert_ne!(v1, saved);
}

#[test]
fn v2_guard_still_refuses_unsafe_params() {
    let c = Cast::new();
    let a = addr(c.s);
    // claim_recipient == claim_authority
    let unsafe_params = htlc_params(&a, &a, &c.alice, D, F);
    assert_eq!(
        compile_v2_params(&unsafe_params).err(),
        Some(GuardError::ClaimRecipientIsClaimAuthority)
    );
    // max_fee < 5,800: with a fixed fee this is even worse (the exact fee could
    // never reach the chain's required minimum).
    for bad in [0u64, 1, 5_799] {
        let p = htlc_params(&a, &c.bob, &c.alice, D, bad);
        assert_eq!(
            compile_v2_params(&p).err(),
            Some(GuardError::MaxFeeBelowMinimumCloseFee { max_fee: bad, minimum: MIN_CLOSE_FEE })
        );
    }
    // max_fee == 5,800 is the smallest accepted value (and then the fixed fee is 5,800).
    let edge = compile_v2(a, c.bob, c.alice, D, MIN_CLOSE_FEE);
    assert_eq!(edge.rules.max_fee, MIN_CLOSE_FEE);
    for h in [D - 1, D] {
        assert!(close_page(&edge, MIN_CLOSE_FEE, h).is_ok());
        assert_eq!(close_page(&edge, MIN_CLOSE_FEE - 1, h).err(), Some(assertion(1)));
    }
}

// ---------------------------------------------------------------- (b) fee < max_fee rejected, fee == max_fee accepted

#[test]
fn v2_fee_equal_to_max_fee_accepted_on_both_branches() {
    let c = Cast::new();
    let o = standard_v2(&c);
    for (h, recipient) in [(D - 1, c.bob), (D, c.alice), (D + 123_456, c.alice)] {
        let page = close_page(&o, F, h).expect("builder accepts fee == max_fee");
        let checked = o.check_call(&page, h).expect("check_call accepts fee == max_fee");
        assert!(checked.terminal);
        assert_eq!(page.body.fee, F);
        assert_eq!(page.body.outputs[0].owner, recipient);
        assert_eq!(page.body.outputs[0].amount, AMOUNT - F);
    }
}

#[test]
fn v2_fee_below_max_fee_rejected_on_both_branches() {
    let c = Cast::new();
    let o = standard_v2(&c);
    let v1 = standard_opening(&c); // same MAX_FEE; the control group

    for h in [D - 1, D, D + 123_456] {
        // The honest builder runs the program: instruction 1 (fee == max_fee) fires.
        for fee in [MIN_CLOSE_FEE, F - 1, 1, 0] {
            assert_eq!(close_page(&o, fee, h).err(), Some(assertion(1)), "builder, fee {fee}, height {h}");
        }

        // A hand-made page: take the valid fee == max_fee page and lower the fee by
        // one (value conserved) - what a minimum-fee attacker would broadcast.
        let good = close_page(&o, F, h).unwrap();
        let cheap = with_body(&good, |b| {
            b.fee = F - 1;
            b.outputs[0].amount += 1;
        });
        assert_eq!(o.check_call(&cheap, h).err(), Some(assertion(1)), "check_call, height {h}");
        // ... and the prover refuses to authorize it, even with the right secret.
        assert!(
            matches!(
                prove(&cheap, &o, h, secret_for(&c, h)),
                Err(ProveAuthorizationError::OwnerAuthStatement(_))
            ),
            "prover must refuse the cheap close at {h}"
        );

        // Control: v1 (same max_fee, no fixed-fee rule) accepts exactly the
        // minimum-fee close that v2 rejects. This is the Q1/T2 stall transaction.
        let v1_cheap = close_page(&v1, FEE, h).expect("v1 builder accepts the 5,800 close");
        assert!(v1.check_call(&v1_cheap, h).is_ok(), "v1 accepts the 5,800 close at {h}");
    }
}

#[test]
fn v2_continuing_and_payout_calls_still_rejected() {
    // v1's guarantees are unchanged: close-only, no payout output. The program's
    // `require terminal` is still instruction 0 and fires before the fee rule.
    let c = Cast::new();
    let o = standard_v2(&c);
    for h in [D - 1, D] {
        for fee in [F, F - 1] {
            assert_eq!(
                o.build_call(input(), 2, fee, EPOCH_ANCHOR, h, false).err(),
                Some(assertion(0)),
                "continuing call, fee {fee}, height {h}"
            );
        }
        let term = close_page(&o, F, h).unwrap();
        let cont = with_body(&term, |b| b.validity_bitmap &= !noid_tx::PAGED_SPEND_TERMINAL_BIT);
        assert_eq!(o.check_call(&cont, h).err(), Some(ObjectError::Policy));
    }
}

#[test]
fn v2_recipient_rule_unchanged() {
    // The fixed fee does not weaken the v1 recipient pin: a page with the right
    // fee but a wrong payee is rejected (after the fee rule passes).
    let c = Cast::new();
    let o = standard_v2(&c);
    let good = close_page(&o, F, D - 1).unwrap();
    for thief in [c.mallory, c.alice, addr(c.s)] {
        let bad = with_body(&good, |b| b.outputs[0].owner = thief);
        assert_eq!(o.check_call(&bad, D - 1).err(), Some(ObjectError::Recipient));
    }
    let refund = close_page(&o, F, D).unwrap();
    let bad = with_body(&refund, |b| b.outputs[0].owner = c.bob);
    assert_eq!(o.check_call(&bad, D).err(), Some(ObjectError::Recipient));
    // Boundary exactness is unchanged.
    assert_eq!(o.check_call(&good, D).err(), Some(ObjectError::Recipient));
}

// ---------------------------------------------------------------- (c) fee above max_fee rejected as before

#[test]
fn v2_fee_above_max_fee_rejected_as_before() {
    let c = Cast::new();
    let o = standard_v2(&c);
    for h in [D - 1, D] {
        // The ceiling check (policy layer) fires before the program runs, so the
        // error is the same FeeLimit as in v1, not an assertion.
        assert_eq!(close_page(&o, F + 1, h).err(), Some(ObjectError::FeeLimit));
        assert_eq!(close_page(&o, F + 1_000, h).err(), Some(ObjectError::FeeLimit));

        let ok = close_page(&o, F, h).unwrap();
        let bad = with_body(&ok, |b| {
            b.fee += 1;
            b.outputs[0].amount -= 1;
        });
        assert_eq!(o.check_call(&bad, h).err(), Some(ObjectError::FeeLimit));
        assert!(matches!(
            prove(&bad, &o, h, secret_for(&c, h)),
            Err(ProveAuthorizationError::OwnerAuthStatement(_))
        ));
    }
    // v1 behaves identically for fee > max_fee (control).
    let v1 = standard_opening(&c);
    assert_eq!(close_page(&v1, MAX_FEE + 1, D - 1).err(), Some(ObjectError::FeeLimit));
}

// ---------------------------------------------------------------- real proofs: still claimable and refundable

#[test]
fn v2_claim_and_refund_prove_and_verify_with_the_fixed_fee() {
    let c = Cast::new();
    let o = standard_v2(&c);

    // Claim at D-1 with the secret: Bob is paid AMOUNT - max_fee.
    let h = D - 1;
    let claim = close_page(&o, F, h).unwrap();
    let bundle = prove(&claim, &o, h, c.s).expect("prove claim with s");
    verify(&claim, &o, h, &bundle).expect("verify claim");
    assert_eq!(claim.body.outputs[0].owner, c.bob);
    assert_eq!(claim.body.outputs[0].amount, AMOUNT - F);

    // A proof for the valid claim does not carry over to the cheaper page: the
    // verifier re-runs check_call and rejects (the statement itself is invalid).
    let cheap = with_body(&claim, |b| {
        b.fee = F - 1;
        b.outputs[0].amount += 1;
    });
    assert!(matches!(
        verify(&cheap, &o, h, &bundle),
        Err(VerifyAuthorizationError::OwnerAuthStatement(_))
    ));

    // Refund at D with Alice's secret: Alice is paid AMOUNT - max_fee.
    let refund = close_page(&o, F, D).unwrap();
    let rb = prove(&refund, &o, D, c.alice_secret).expect("prove refund");
    verify(&refund, &o, D, &rb).expect("verify refund");
    assert_eq!(refund.body.outputs[0].owner, c.alice);
    assert_eq!(refund.body.outputs[0].amount, AMOUNT - F);
}
