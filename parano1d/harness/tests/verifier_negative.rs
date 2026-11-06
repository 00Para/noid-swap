//! M0.4: verifier-side negative tests.
//!
//! Every assertion here is on `verify_experimental_object_authorization` (the
//! function the mempool and the block verifier run) returning an error for a
//! proof that EXISTS: a genuine proof, tampered with or rebound. Nothing here
//! relies on the prover refusing to build something. Each test also runs the
//! untampered control through the same verifier so a rejection cannot be a
//! side effect of a broken setup.
//!
//! What this does not show: a proof forged WITHOUT the secret. The public prover
//! API cannot produce one, so soundness against a malicious prover stays assumed
//! (docs/review-1.md). These tests show that the verifier binds the proof to the
//! exact transaction, branch, and bytes it was made for.

use htlc_harness::*;
use noid_gkr::wallet_authorization::{
    AuthorizationDecodeError, VerifyAuthorizationError, WalletAuthorizationBundle,
};
use noid_tx::experimental_object::ObjectError;

/// One honest claim: contract, page at D-1, genuine proof with `s`.
fn honest() -> (
    Cast,
    noid_tx::experimental_object::ObjectOpening,
    noid_tx::TxPage,
    WalletAuthorizationBundle,
) {
    let c = Cast::new();
    let o = standard_opening(&c);
    let h = D - 1;
    let page = close_page(&o, FEE, h).unwrap();
    let bundle = prove(&page, &o, h, c.s).expect("honest proof");
    verify(&page, &o, h, &bundle).expect("control: honest proof verifies");
    (c, o, page, bundle)
}

#[test]
fn verifier_rejects_flipped_proof_bytes() {
    let (_c, o, page, bundle) = honest();
    let h = D - 1;
    let bytes = bundle.to_bytes().unwrap();

    // Control: the wire form round-trips and still verifies.
    let again = WalletAuthorizationBundle::from_bytes(&bytes).expect("round trip");
    verify(&page, &o, h, &again).expect("round-tripped proof verifies");

    // Flip one bit at positions spread over the whole bundle. Header/length bytes
    // are rejected by the decoder; everything else must reach the VERIFIER, and the
    // verifier must say no. We require that most of the cases reach it.
    let n = bytes.len();
    let mut offsets: Vec<usize> = (1..=12).map(|i| n * i / 13).collect();
    offsets.extend([16, 64, 256, n - 256, n - 64, n - 1].into_iter().filter(|&o| o < n));
    let (mut decode_rejected, mut verifier_rejected) = (0usize, 0usize);
    for off in offsets {
        let mut bad = bytes.clone();
        bad[off] ^= 0x01;
        match WalletAuthorizationBundle::from_bytes(&bad) {
            Err(_) => decode_rejected += 1,
            Ok(tampered) => {
                let result = verify(&page, &o, h, &tampered);
                assert!(
                    result.is_err(),
                    "verifier ACCEPTED a proof with bit 0 of byte {off}/{n} flipped"
                );
                verifier_rejected += 1;
            }
        }
    }
    println!("flipped bytes: {decode_rejected} rejected by decoder, {verifier_rejected} rejected by verifier");
    assert!(
        verifier_rejected >= 10,
        "too few cases reached the verifier ({verifier_rejected}); the test would not exercise it"
    );
}

#[test]
fn verifier_rejects_tampered_proof_fields() {
    // Edit decoded proof fields directly so the decoder is bypassed: these always
    // reach the verifier.
    let (_c, o, page, bundle) = honest();
    let h = D - 1;

    let mut t = bundle.clone();
    t.proof.grind_nonce = t.proof.grind_nonce.wrapping_add(1);
    assert_eq!(verify(&page, &o, h, &t).err(), Some(VerifyAuthorizationError::AuthProof), "grind_nonce");

    let mut t = bundle.clone();
    t.proof.phase_b_value = noid_core::Block256::default();
    assert_ne!(t.proof.phase_b_value, bundle.proof.phase_b_value, "tamper really changed the field");
    assert_eq!(verify(&page, &o, h, &t).err(), Some(VerifyAuthorizationError::AuthProof), "phase_b_value");

    let mut t = bundle.clone();
    t.proof.sigma = noid_core::Block256::default();
    assert_ne!(t.proof.sigma, bundle.proof.sigma, "tamper really changed the field");
    assert_eq!(verify(&page, &o, h, &t).err(), Some(VerifyAuthorizationError::AuthProof), "sigma");

    // Swapping in the proof of an unrelated statement keeps every field well-formed
    // but is still the wrong statement.
    let other = Cast::new();
    let decoy = compile_htlc(addr(other.s_wrong), other.bob, other.alice, D, MAX_FEE);
    let decoy_page = close_page(&decoy, FEE, h).unwrap();
    let decoy_proof = prove(&decoy_page, &decoy, h, other.s_wrong).unwrap();
    verify(&decoy_page, &decoy, h, &decoy_proof).expect("control: decoy proof verifies for the decoy");
    assert_eq!(verify(&page, &o, h, &decoy_proof).err(), Some(VerifyAuthorizationError::AuthProof));
}

#[test]
fn verifier_rejects_malformed_bundle_bytes() {
    let (_c, _o, _page, bundle) = honest();
    let bytes = bundle.to_bytes().unwrap();

    assert!(matches!(
        WalletAuthorizationBundle::from_bytes(&bytes[..bytes.len() - 1]),
        Err(AuthorizationDecodeError::Truncated)
    ));
    let mut trailing = bytes.clone();
    trailing.push(0);
    assert!(matches!(
        WalletAuthorizationBundle::from_bytes(&trailing),
        Err(AuthorizationDecodeError::TrailingBytes { remaining: 1 })
    ));
    let mut magic = bytes.clone();
    magic[0] ^= 0xff;
    assert!(matches!(
        WalletAuthorizationBundle::from_bytes(&magic),
        Err(AuthorizationDecodeError::InvalidMagic)
    ));
    assert!(WalletAuthorizationBundle::from_bytes(&[]).is_err());
}

#[test]
fn verifier_rejects_proof_bound_to_a_different_transaction() {
    let (c, o, page, bundle) = honest();
    let h = D - 1;

    // Each variant is a page that check_call ACCEPTS (so the rejection below is the
    // proof layer, not the policy layer) but differs from the proven transaction.
    let variants: Vec<(&str, noid_tx::TxPage)> = vec![
        ("epoch anchor", with_body(&page, |b| b.epoch_anchor[31] ^= 0x80)),
        (
            "fee +1 (output -1)",
            with_body(&page, |b| {
                b.fee += 1;
                b.outputs[0].amount -= 1;
            }),
        ),
        ("output slot", with_body(&page, |b| b.outputs[0].slot_index += 1)),
    ];
    for (what, other) in &variants {
        assert!(o.check_call(other, h).is_ok(), "{what}: variant must pass check_call");
        assert_eq!(
            verify(other, &o, h, &bundle).err(),
            Some(VerifyAuthorizationError::AuthProof),
            "proof replayed on a page with a different {what}"
        );
    }

    // Same secret, different contract (recipient Carol instead of Bob): the page and
    // its opening root differ, so the proof made for Bob's contract is not valid for it.
    let carol = addr(seq_bytes(0x90));
    let o2 = compile_htlc(addr(c.s), carol, c.alice, D, MAX_FEE);
    let page2 = close_page(&o2, FEE, h).unwrap();
    assert!(o2.check_call(&page2, h).is_ok());
    assert_eq!(verify(&page2, &o2, h, &bundle).err(), Some(VerifyAuthorizationError::AuthProof));
    // ... and the proof made for Carol's contract does not verify for Bob's.
    let bundle2 = prove(&page2, &o2, h, c.s).unwrap();
    verify(&page2, &o2, h, &bundle2).expect("control: Carol's own proof verifies");
    assert_eq!(verify(&page, &o, h, &bundle2).err(), Some(VerifyAuthorizationError::AuthProof));

    // A page for a different input (other slot / amount) is a different transaction too.
    let other_input = {
        let other_in = noid_tx::TxInput { slot_index: 5, amount: AMOUNT + 1_000, creation_id: 9 };
        o.build_call(other_in, 2, FEE, EPOCH_ANCHOR, h, true).unwrap()
    };
    assert_eq!(
        verify(&other_input, &o, h, &bundle).err(),
        Some(VerifyAuthorizationError::AuthProof),
        "proof replayed on a different input"
    );
}

#[test]
fn verifier_binds_proof_to_the_branch_at_the_inclusion_height() {
    let (_c, o, page, bundle) = honest();

    // Control: verifies at D-1.
    verify(&page, &o, D - 1, &bundle).expect("control");

    // Presented for inclusion at or after the deadline, the verifier's own check_call
    // preflight flips the recipient to Alice and refuses before looking at the proof.
    for h in [D, D + 1, D + 123_456] {
        assert_eq!(
            verify(&page, &o, h, &bundle).err(),
            Some(VerifyAuthorizationError::OwnerAuthStatement(ObjectError::Recipient.to_string())),
            "Bob's proof presented at height {h}"
        );
    }

    // The height is bound only through the branch: any height on the same side of the
    // deadline is the same statement (authority and txid are unchanged). Documented so
    // nobody assumes a claim proof is pinned to one block.
    verify(&page, &o, D - 2, &bundle).expect("same branch, earlier height: same statement");
    verify(&page, &o, 1, &bundle).expect("same branch, height 1: same statement");
}
