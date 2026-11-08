//! Reference implementation of the equivalence statement, built on the VENDOR crates.
//!
//! * `addr`   -- vendor `noid_poseidon2b::derive_address` (primitives.rs:L298-L305).
//! * `derive0`/`derive` -- `noid_node::wallet::keystore::MasterSecret::derive_spend_secret`
//!   (keystore.rs:L69-L93) is `pub(super)` inside a private module of a heavy
//!   crate (noid_node is not even re-exported: lib.rs exposes only `networking` and
//!   two staging modules), so it is NOT reachable. We therefore transcribe those
//!   exact lines onto the vendor `Poseidon2bSponge`, line by line, below. Equality
//!   with the independent portable implementation is tested in tests/.
//!
//! Statement: exists m: sha256(m) = H and Addr(m) = A            (raw)
//!            exists m: sha256(m) = H and Addr(Derive(m,0)) = A  (stock wallet)

use noid_core::{Block128, TowerField};
use noid_poseidon2b::native::compression::Poseidon2bSponge;
use noid_poseidon2b::primitives::{derive_address, Address, SpendSecret};
use sha2::{Digest, Sha256};

pub use equiv_portable::{PUBLIC_LEN, VARIANT_RAW, VARIANT_STOCK};

/// `Addr(m)`, via the vendor crate.
pub fn addr(m: &[u8; 32]) -> [u8; 32] {
    derive_address(&SpendSecret::from_bytes(*m)).into_bytes()
}

/// `Derive(m, index)` -- keystore.rs:L69-L93 transcribed onto the vendor sponge.
pub fn derive(m: &[u8; 32], index: u32) -> [u8; 32] {
    // keystore.rs:L79  let mut sponge = Poseidon2bSponge::with_iv([Block128::ZERO; 2]);
    let mut sponge = Poseidon2bSponge::with_iv([Block128::ZERO; 2]);
    // keystore.rs:L80-L83
    let master_fields = [
        Block128::from(u128::from_le_bytes(m[..16].try_into().unwrap())),
        Block128::from(u128::from_le_bytes(m[16..].try_into().unwrap())),
    ];
    sponge.absorb(master_fields[0]); // L84
    sponge.absorb(master_fields[1]); // L85
    sponge.absorb(Block128::from(index as u128)); // L87
    sponge.absorb(Block128::from(0x6E6F69642D64657269_u128)); // L88 "noid-deri"
    sponge.finalize() // L89 (padded finalize); L90 SpendSecret::from_bytes(digest)
}

/// `Derive(m, 0)`.
pub fn derive0(m: &[u8; 32]) -> [u8; 32] {
    derive(m, 0)
}

pub fn sha256(m: &[u8]) -> [u8; 32] {
    Sha256::digest(m).into()
}

/// (H, A) for the raw variant: H = sha256(m), A = Addr(m).
pub fn statement_raw(m: &[u8; 32]) -> ([u8; 32], [u8; 32]) {
    (sha256(m), addr(m))
}

/// (H, A) for the stock-wallet variant: H = sha256(m), A = Addr(Derive(m,0)).
pub fn statement_stock(m: &[u8; 32]) -> ([u8; 32], [u8; 32]) {
    (sha256(m), addr(&derive0(m)))
}

/// Encode a 32-byte address as the on-chain `o1...` bech32m string.
pub fn to_o1(a: &[u8; 32]) -> String {
    Address(*a).to_bech32()
}

/// Decode an `o1...` bech32m address to its 32 bytes (vendor parser).
pub fn from_o1(s: &str) -> Result<[u8; 32], String> {
    Address::parse(s).map(|a| a.into_bytes()).map_err(|e| e.to_string())
}

pub fn parse_hex32(s: &str) -> Result<[u8; 32], String> {
    let s = s.trim().trim_start_matches("0x");
    let v = hex::decode(s).map_err(|e| format!("bad hex: {e}"))?;
    <[u8; 32]>::try_from(v.as_slice()).map_err(|_| format!("need 32 bytes, got {}", v.len()))
}

// keep the TowerField import used on all cfgs
#[allow(dead_code)]
fn _uses() -> Block128 {
    Block128::ZERO
}

// ---------------------------------------------------------------------------------------------
// Differential vectors for the EVM contract (eth/contracts/Poseidon2b.sol)
// ---------------------------------------------------------------------------------------------

/// Default seed of the random part of the vectors file. Changing it changes the file.
pub const VECTOR_SEED: &str = "noid-swap/poseidon2b/addr-vectors/v1";
/// Default number of seeded-random secrets.
pub const VECTOR_RANDOM: usize = 12_000;
/// Number of structured secrets that start the file (see `structured_secrets`).
pub const VECTOR_STRUCTURED: usize = 3 + 6 + 2 + 32 + 256;

/// The structured secrets, in file order:
///   0 all-zero, 1 all-ones, 2 the published vector 00 01 .. 1f,
///   3..9 every byte equal to 0x80, 0xe0, 0x01, 0x7f, 0xaa, 0x55,
///   9..11 low lane all-ones / high lane all-ones (the other lane zero),
///   11..43 byte i = 0xff and every other byte zero (i = 0..31),
///   43..299 the single-bit secrets: bit k (k = 0..255) is bit (k mod 8) of byte (k div 8).
pub fn structured_secrets() -> Vec<[u8; 32]> {
    let mut v: Vec<[u8; 32]> = Vec::with_capacity(VECTOR_STRUCTURED);
    v.push([0u8; 32]);
    v.push([0xffu8; 32]);
    let mut published = [0u8; 32];
    for (i, b) in published.iter_mut().enumerate() {
        *b = i as u8;
    }
    v.push(published);
    for b in [0x80u8, 0xe0, 0x01, 0x7f, 0xaa, 0x55] {
        v.push([b; 32]);
    }
    let mut lo = [0u8; 32];
    lo[..16].fill(0xff);
    let mut hi = [0u8; 32];
    hi[16..].fill(0xff);
    v.push(lo);
    v.push(hi);
    for i in 0..32 {
        let mut s = [0u8; 32];
        s[i] = 0xff;
        v.push(s);
    }
    for k in 0..256 {
        let mut s = [0u8; 32];
        s[k / 8] = 1u8 << (k % 8);
        v.push(s);
    }
    assert_eq!(v.len(), VECTOR_STRUCTURED);
    v
}

/// The i-th seeded-random secret: SHA-256 of the ASCII text "<seed>|<i>" (i in decimal).
pub fn random_secret(seed: &str, i: usize) -> [u8; 32] {
    sha256(format!("{seed}|{i}").as_bytes())
}

/// All vector secrets: the structured ones, then `n_random` seeded-random ones.
pub fn vector_secrets(seed: &str, n_random: usize) -> Vec<[u8; 32]> {
    let mut v = structured_secrets();
    v.extend((0..n_random).map(|i| random_secret(seed, i)));
    v
}

/// The vectors file: for each secret 64 bytes = secret (32) || Addr(secret) (32), with
/// `Addr` computed by the VENDOR crate (`noid_poseidon2b::primitives::derive_address`).
/// Panics if the vendor address of the published vector is not the documented one, or if the
/// independent portable implementation disagrees on any vector.
pub fn addr_vectors_bytes(seed: &str, n_random: usize) -> Vec<u8> {
    const PUBLISHED_ADDR: &str = "f8183db204ffb765c7015d851c1754e4974c675b975c6738d9f6d138eb7212cf";
    let secrets = vector_secrets(seed, n_random);
    let mut out = Vec::with_capacity(secrets.len() * 64);
    for (i, s) in secrets.iter().enumerate() {
        let a = addr(s);
        assert_eq!(a, equiv_portable::addr(s), "vendor and portable disagree on vector {i}");
        if i == 2 {
            assert_eq!(hex::encode(a), PUBLISHED_ADDR, "published vector");
        }
        out.extend_from_slice(s);
        out.extend_from_slice(&a);
    }
    out
}

#[cfg(test)]
mod vector_tests {
    use super::*;

    #[test]
    fn structured_layout_and_published_vector() {
        let s = structured_secrets();
        assert_eq!(s.len(), VECTOR_STRUCTURED);
        assert_eq!(s[0], [0u8; 32]);
        assert_eq!(s[1], [0xffu8; 32]);
        assert_eq!(s[2][31], 31);
        assert_eq!(s[43][0], 1); // single bit 0
        assert_eq!(s[43 + 255][31], 0x80); // single bit 255
        let b = addr_vectors_bytes(VECTOR_SEED, 4);
        assert_eq!(b.len(), (VECTOR_STRUCTURED + 4) * 64);
    }
}
