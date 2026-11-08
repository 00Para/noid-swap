//! Review V2-9 (`docs/poseidon-v2-review.md`): the prover accepts every 32-byte secret.
//!
//! With the Ethereum lock on `A = Addr(s)` (`docs/poseidon-leg.md`), Alice chooses `s` and the EVM accepts every 32-byte value. If the prover
//! refused some `s` (a value-dependent failure in the proof built from the state table), Alice could pick that `s`: Bob's ETH claim would
//! succeed for her while Bob could never close the NOID. The code that was read has no value check from `SpendSecret::from_bytes` to the
//! state table; this test closes the rest for the three secrets the review names:
//!
//! * `00..00` and `ff..ff`: the extremes;
//! * `35c1cecbc73c3c3f13b6b3b0b4141415 ++ 00 * 16`: constructed so that the first S-box input of the address permutation is zero.
//!
//! For each: build the closing call of the real HashTimeLock whose claim authority is `Addr(s)`, prove the owner authorization, verify it
//! under both owner-authorization versions (V3 below Parano1d height 279,370, V4 from it on), and check that a proof for another secret
//! fails. The all-zero and all-ones addresses are also compared with the vendor vectors the EVM contract is tested against
//! (`eth/test/vectors/addr-vectors.bin`, entries 0 and 1).

use htlc_harness::*;
use noid_gkr::wallet_authorization::ProveAuthorizationError;
use noid_tx::OwnerAuthorizationVersion::{V3, V4};

/// Deadline far enough after the activation that both 279,369 (V3) and 279,370 (V4) are in the claim branch (as in `auth_versions.rs`).
const D_REAL: u64 = V2_1_ACTIVATION_HEIGHT + 500;
const H_V3: u64 = V2_1_ACTIVATION_HEIGHT - 1;
const H_V4: u64 = V2_1_ACTIVATION_HEIGHT;

fn edge_secrets() -> Vec<(&'static str, [u8; 32])> {
    let mut zero_sbox = [0u8; 32];
    let head = hex_decode("35c1cecbc73c3c3f13b6b3b0b4141415");
    zero_sbox[..16].copy_from_slice(&head);
    vec![("all zero", [0u8; 32]), ("all ones", [0xffu8; 32]), ("zero first S-box input", zero_sbox)]
}

fn hex_decode(s: &str) -> Vec<u8> {
    (0..s.len()).step_by(2).map(|i| u8::from_str_radix(&s[i..i + 2], 16).unwrap()).collect()
}

#[test]
fn the_prover_authorizes_the_edge_secrets_under_both_owner_authorization_versions() {
    let c = Cast::new();
    for (name, s) in edge_secrets() {
        let authority = addr(s);
        let opening = compile_htlc(authority, c.bob, c.alice, D_REAL, MAX_FEE);
        for (h, v) in [(H_V3, V3), (H_V4, V4)] {
            assert_eq!(auth_version_at(h), v);
            let page = close_page(&opening, FEE, h).unwrap();
            // The consensus preflight accepts the call and the funds can only go to the committed recipient.
            let checked = opening.check_call(&page, h).unwrap();
            assert_eq!(checked.authority, authority, "{name}: the claim branch is keyed on Addr(s)");
            assert_eq!(page.body.outputs[0].owner, c.bob);
            // The prover authorizes for this secret ...
            let bundle = prove_v(&page, &opening, h, s, v).unwrap_or_else(|e| panic!("{name} ({v:?}): the prover refused a 32-byte secret: {e:?}"));
            // ... and the verifier of the same version accepts the proof.
            verify_v(&page, &opening, h, &bundle, v).unwrap_or_else(|e| panic!("{name} ({v:?}): the verifier rejected the prover's own proof: {e:?}"));
            // A proof is bound to its secret: another secret does not authorize this contract.
            let other = if s == [0xffu8; 32] { [0xfeu8; 32] } else { [0xffu8; 32] };
            assert_eq!(
                prove_v(&page, &opening, h, other, v).err(),
                Some(ProveAuthorizationError::BoundaryMismatch { input_index: 0, field: "owner_auth" }),
                "{name} ({v:?})"
            );
        }
    }
}

#[test]
fn the_edge_secret_addresses_equal_the_vendor_vectors_the_ethereum_contract_is_tested_against() {
    // Entry i of addr-vectors.bin is secret (32 bytes) ++ Addr(secret) (32 bytes), made by the vendor crate (equiv-ref addr-vectors).
    // Entry 0 is the all-zero secret and entry 1 the all-ones secret (docs/poseidon-leg.md section 7).
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../eth/test/vectors/addr-vectors.bin");
    let Ok(bytes) = std::fs::read(&path) else {
        eprintln!("SKIPPED: {} does not exist", path.display());
        return;
    };
    for (i, (name, s)) in edge_secrets().into_iter().take(2).enumerate() {
        let entry = &bytes[i * 64..i * 64 + 64];
        assert_eq!(&entry[..32], &s, "{name}: the vectors file lists this secret at entry {i}");
        assert_eq!(&entry[32..], &addr(s).0, "{name}: Addr(s) of the prover's crate equals the vector the EVM is compared with");
    }
}
