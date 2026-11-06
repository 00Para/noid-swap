//! M0.6: the tool guard. The tool refuses to build a swap contract when
//! `claim_recipient == claim_authority` (anyone who learns the secret could take
//! the funds) or `max_fee < 5,800 micro-NOID` (neither branch can ever pay the
//! minimum close fee, so claim and refund are both locked forever).

use htlc_harness::*;
use noid_poseidon2b::primitives::Address;

fn safe() -> (Address, Address, u64) {
    let c = Cast::new();
    (addr(c.s), c.bob, MAX_FEE)
}

#[test]
fn guard_rejects_claim_recipient_equal_to_claim_authority() {
    let c = Cast::new();
    let a = addr(c.s);

    // The function itself.
    assert_eq!(
        check_swap_params(&a, &a, MAX_FEE),
        Err(GuardError::ClaimRecipientIsClaimAuthority)
    );
    // The compile path refuses before and after compiling.
    assert_eq!(
        try_compile_htlc(a, a, c.alice, D, MAX_FEE).err(),
        Some(GuardError::ClaimRecipientIsClaimAuthority)
    );
    // The params-value path.
    let params = serde_json::json!({
        "hashlock_authority": a.to_bech32(),
        "receiver": a.to_bech32(),
        "sender": c.alice.to_bech32(),
        "timeout_height": "300000",
        "max_fee": "20000",
    });
    assert_eq!(check_params_value(&params), Err(GuardError::ClaimRecipientIsClaimAuthority));

    // Defence in depth: the compiler itself happily builds the unsafe contract
    // (that is the point of the guard), and `check_opening` catches the result.
    let unsafe_opening = noid_pruv::compile(HTLC_SOURCE, &params)
        .expect("the Pruv compiler does not know this rule")
        .opening()
        .clone();
    assert_eq!(unsafe_opening.claim_recipient, unsafe_opening.claim_authority);
    assert_eq!(check_opening(&unsafe_opening), Err(GuardError::ClaimRecipientIsClaimAuthority));

    // Stock-wallet variant: the same rule for Addr(Derive(m, 0)).
    let d = addr_derived(c.s, 0);
    assert_eq!(check_swap_params(&d, &d, MAX_FEE), Err(GuardError::ClaimRecipientIsClaimAuthority));
}

#[test]
fn guard_rejects_max_fee_below_minimum_close_fee() {
    let (a, bob, _) = safe();
    let c = Cast::new();
    assert_eq!(MIN_CLOSE_FEE, 5_800);
    assert_eq!(MIN_CLOSE_FEE, 5_000 + 100 * 1 + 700 * 1, "formula for a 1-in/1-out close");

    for bad in [0u64, 1, 5_799] {
        let want = Err(GuardError::MaxFeeBelowMinimumCloseFee { max_fee: bad, minimum: 5_800 });
        assert_eq!(check_swap_params(&a, &bob, bad), want, "max_fee {bad}");
        assert_eq!(
            try_compile_htlc(a, bob, c.alice, D, bad).err(),
            want.clone().err(),
            "compile path, max_fee {bad}"
        );
        let params = serde_json::json!({
            "hashlock_authority": a.to_bech32(),
            "receiver": bob.to_bech32(),
            "sender": c.alice.to_bech32(),
            "timeout_height": "300000",
            "max_fee": bad.to_string(),
        });
        assert_eq!(check_params_value(&params), want, "params path, max_fee {bad}");

        // Compiled behind the guard's back, check_opening still refuses it.
        let opening = noid_pruv::compile(HTLC_SOURCE, &params).unwrap().opening().clone();
        assert_eq!(check_opening(&opening), want, "opening, max_fee {bad}");
    }

    // Why it matters: with max_fee 5,799 even the cheapest honest close is over the cap,
    // on both branches (claim and refund both stuck).
    let params = serde_json::json!({
        "hashlock_authority": a.to_bech32(),
        "receiver": bob.to_bech32(),
        "sender": c.alice.to_bech32(),
        "timeout_height": D.to_string(),
        "max_fee": "5799",
    });
    let stuck = noid_pruv::compile(HTLC_SOURCE, &params).unwrap().opening().clone();
    for h in [D - 1, D] {
        assert!(matches!(
            close_page(&stuck, MIN_CLOSE_FEE, h),
            Err(noid_tx::experimental_object::ObjectError::FeeLimit)
        ));
    }
}

#[test]
fn guard_accepts_safe_parameters() {
    let (a, bob, fee) = safe();
    let c = Cast::new();

    assert_eq!(check_swap_params(&a, &bob, fee), Ok(()));
    // The boundary itself is allowed: max_fee == 5,800 can pay the minimum close.
    assert_eq!(check_swap_params(&a, &bob, MIN_CLOSE_FEE), Ok(()));

    let opening = try_compile_htlc(a, bob, c.alice, D, MIN_CLOSE_FEE).expect("safe params compile");
    assert_eq!(check_opening(&opening), Ok(()));
    assert_eq!(opening.claim_authority, a);
    assert_eq!(opening.claim_recipient, bob);
    for h in [D - 1, D] {
        let page = close_page(&opening, MIN_CLOSE_FEE, h).expect("a close at exactly max_fee = 5,800 works");
        assert!(opening.check_call(&page, h).is_ok());
    }

    // The saved example params (the file the repo ships) pass, through the guarded loader.
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../contracts/htlc.params.example.json");
    let params = load_params_guarded(&path).expect("example params pass the guard");
    assert_eq!(params["max_fee"], "20000");
}

#[test]
fn guard_reports_unreadable_or_malformed_params() {
    // Fail closed: anything the guard cannot read is an error, never a silent pass.
    let missing = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("no-such-params.json");
    assert!(matches!(load_params_guarded(&missing), Err(GuardError::BadParams(_))));
    let (a, bob, _) = safe();
    let no_fee = serde_json::json!({ "hashlock_authority": a.to_bech32(), "receiver": bob.to_bech32() });
    assert!(matches!(check_params_value(&no_fee), Err(GuardError::BadParams(_))));
    let bad_addr = serde_json::json!({ "hashlock_authority": "nope", "receiver": bob.to_bech32(), "max_fee": "6000" });
    assert!(matches!(check_params_value(&bad_addr), Err(GuardError::BadParams(_))));
}
