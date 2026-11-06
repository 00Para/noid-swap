//! M0.3: stock-wallet authority `Addr(Derive(m, 0))` and the two owner-authorization
//! proof versions (V3 before Parano1d height 279,370, V4 from it on).
//!
//! The harness opening uses deadline `D_REAL` so that the claim branch is open on
//! both sides of the v2.1 activation. A real swap must never straddle 279,370
//! (PROJECT.md hard rule 4); the straddle here only lets one opening exercise both
//! versions without a node.

use htlc_harness::*;
use noid_gkr::wallet_authorization::{ProveAuthorizationError, VerifyAuthorizationError};
use noid_tx::OwnerAuthorizationVersion::{V3, V4};

/// Deadline far enough after the activation that heights 279,369 and 279,370 are
/// both in the claim branch.
const D_REAL: u64 = V2_1_ACTIVATION_HEIGHT + 500;
const H_V3: u64 = V2_1_ACTIVATION_HEIGHT - 1; // 279,369
const H_V4: u64 = V2_1_ACTIVATION_HEIGHT; // 279,370

const DERIVE_VECTOR: &str = "o125qayvgtmvqnlhqmqwe08dza3acaax5mct3u5h4uen3qtrds3jfset7wlk";

fn real_opening(c: &Cast, hashlock: noid_poseidon2b::primitives::Address) -> noid_tx::experimental_object::ObjectOpening {
    compile_htlc(hashlock, c.bob, c.alice, D_REAL, MAX_FEE)
}

// ------------------------------------------------------------ Derive / stock wallet

#[test]
fn stock_wallet_derive_vector() {
    // Test vector from PROJECT.md / docs: Addr(Derive(00..1f, 0)).
    let m = seq_bytes(0x00);
    assert_eq!(addr_derived(m, 0).to_bech32(), DERIVE_VECTOR);
    // Derive is a real transformation, index-sensitive, and not the raw path.
    assert_ne!(derive_bytes(m, 0), m);
    assert_ne!(derive_bytes(m, 0), derive_bytes(m, 1));
    assert_ne!(addr_derived(m, 0), addr(m), "Addr(Derive(m,0)) differs from Addr(m)");
}

#[test]
fn stock_wallet_claim_authorizes_with_derived_secret() {
    // Stock-wallet variant: the hashlock authority is Addr(Derive(m, 0)). The
    // claimer's witness is Derive(m, 0), never m itself.
    let c = Cast::new();
    let m = c.s; // wallet master secret, throwaway
    let authority = addr_derived(m, 0);
    let o = real_opening(&c, authority);
    let h = D_REAL - 1;
    let page = close_page(&o, FEE, h).unwrap();

    let checked = o.check_call(&page, h).unwrap();
    assert_eq!(checked.authority, authority);
    assert_eq!(page.body.outputs[0].owner, c.bob, "funds still go to the pinned recipient");

    // Derived secret: prove + verify (V4 default).
    let bundle = prove_stock_wallet(&page, &o, h, m, 0).expect("prove with Derive(m,0)");
    verify(&page, &o, h, &bundle).expect("verify");

    // The raw master secret m is NOT the preimage of this authority.
    assert_eq!(
        prove(&page, &o, h, m).err(),
        Some(ProveAuthorizationError::BoundaryMismatch { input_index: 0, field: "owner_auth" })
    );
    // Another wallet index is not either (only the active index 0 is locked).
    assert_eq!(
        prove_stock_wallet(&page, &o, h, m, 1).err(),
        Some(ProveAuthorizationError::BoundaryMismatch { input_index: 0, field: "owner_auth" })
    );
    // Conversely a raw-variant contract (authority Addr(m)) cannot be opened with Derive(m,0).
    let raw = real_opening(&c, addr(m));
    let raw_page = close_page(&raw, FEE, h).unwrap();
    assert_eq!(
        prove_stock_wallet(&raw_page, &raw, h, m, 0).err(),
        Some(ProveAuthorizationError::BoundaryMismatch { input_index: 0, field: "owner_auth" })
    );

    // The recipient rule is the same: the holder of Derive(m,0) cannot redirect.
    let thief = with_body(&page, |b| b.outputs[0].owner = c.mallory);
    assert_eq!(o.check_call(&thief, h).err(), Some(noid_tx::experimental_object::ObjectError::Recipient));
    assert!(matches!(
        prove_stock_wallet(&thief, &o, h, m, 0),
        Err(ProveAuthorizationError::OwnerAuthStatement(_))
    ));

    // After the deadline the stock secret is useless: the authority is Alice.
    let refund = close_page(&o, FEE, D_REAL).unwrap();
    assert_eq!(o.check_call(&refund, D_REAL).unwrap().authority, c.alice);
    assert_eq!(
        prove_stock_wallet(&refund, &o, D_REAL, m, 0).err(),
        Some(ProveAuthorizationError::BoundaryMismatch { input_index: 0, field: "owner_auth" })
    );
}

// ------------------------------------------------------------ V3 / V4

#[test]
fn auth_version_boundary() {
    assert_eq!(V2_1_ACTIVATION_HEIGHT, 279_370);
    assert_eq!(auth_version_at(0), V3);
    assert_eq!(auth_version_at(H_V3), V3);
    assert_eq!(auth_version_at(H_V4), V4);
    assert_eq!(auth_version_at(H_V4 + 1_000_000), V4);
    assert_eq!(V3.construction_version(), 3);
    assert_eq!(V4.construction_version(), 4);
    // Mirrors the vendor's own rule: noid_chain::consensus::params::owner_authorization_version_with.
}

/// For one authority/witness pair: each version proves and verifies under itself,
/// and a proof built for one version is rejected under the other.
fn check_both_versions(c: &Cast, opening: &noid_tx::experimental_object::ObjectOpening, witness_bytes: [u8; 32]) {
    // Pages built at the heights where each version is the consensus rule.
    let page_v3 = close_page(opening, FEE, H_V3).unwrap();
    let page_v4 = close_page(opening, FEE, H_V4).unwrap();
    assert_eq!(auth_version_at(H_V3), V3);
    assert_eq!(auth_version_at(H_V4), V4);

    let b3 = prove_v(&page_v3, opening, H_V3, witness_bytes, V3).expect("V3 prove");
    let b4 = prove_v(&page_v4, opening, H_V4, witness_bytes, V4).expect("V4 prove");

    // Each verifies under its own version, which is the consensus version at its height.
    verify_v(&page_v3, opening, H_V3, &b3, auth_version_at(H_V3)).expect("V3 proof verifies under V3");
    verify_v(&page_v4, opening, H_V4, &b4, auth_version_at(H_V4)).expect("V4 proof verifies under V4");

    // Cross-version: rejected by the verifier, both directions.
    assert_eq!(
        verify_v(&page_v3, opening, H_V3, &b3, V4).err(),
        Some(VerifyAuthorizationError::AuthProof),
        "V3 proof must not verify under V4"
    );
    assert_eq!(
        verify_v(&page_v4, opening, H_V4, &b4, V3).err(),
        Some(VerifyAuthorizationError::AuthProof),
        "V4 proof must not verify under V3"
    );

    // Same page, same witness, other version: also a different proof that fails the other way.
    let b3_on_v4_page = prove_v(&page_v4, opening, H_V4, witness_bytes, V3).expect("V3 prove on the V4-height page");
    assert_eq!(
        verify_v(&page_v4, opening, H_V4, &b3_on_v4_page, auth_version_at(H_V4)).err(),
        Some(VerifyAuthorizationError::AuthProof),
        "a V3 proof presented at a V4 height (what the activation evicts) is rejected"
    );
    verify_v(&page_v4, opening, H_V4, &b3_on_v4_page, V3).expect("... but it is a valid V3 proof");

    // The default helpers (`prove` / `verify`) are V4.
    let default_proof = prove(&page_v4, opening, H_V4, witness_bytes).unwrap();
    verify_v(&page_v4, opening, H_V4, &default_proof, V4).expect("default prover output verifies under V4");
    assert_eq!(
        verify_v(&page_v4, opening, H_V4, &default_proof, V3).err(),
        Some(VerifyAuthorizationError::AuthProof)
    );

    // The serialized proofs differ between versions.
    assert_ne!(b3.to_bytes().unwrap(), b4.to_bytes().unwrap());
    let _ = c;
}

#[test]
fn raw_secret_v3_v4_roundtrip_and_cross_rejected() {
    let c = Cast::new();
    let o = real_opening(&c, addr(c.s));
    check_both_versions(&c, &o, c.s);
}

#[test]
fn stock_wallet_v3_v4_roundtrip_and_cross_rejected() {
    let c = Cast::new();
    let m = c.s;
    let o = real_opening(&c, addr_derived(m, 0));
    check_both_versions(&c, &o, derive_bytes(m, 0));
}
