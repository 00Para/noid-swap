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
