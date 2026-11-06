//! The swap secret and everything derived from it.
//!
//! Plain words: the *secret* is 32 random bytes that only Alice knows at the
//! start of a swap. Its SHA-256 is the *hashlock* published on Ethereum. Its
//! Parano1d address `Addr(secret)` is the *claim authority* of the NOID lock,
//! because on Parano1d an address is already a hash of a secret. Publishing the
//! secret on Ethereum (the *reveal*) is what lets Bob claim the NOID.
//!
//! Encoding rules (design section 0, normative): the secret is exactly 32 raw
//! bytes; `H = SHA-256(secret)` over those bytes only; on Ethereum it travels
//! as `0x` + 64 hex characters; the stock Parano1d wallet import reads the same
//! 64 characters **without** `0x`.

use std::fmt;

use noid_poseidon2b::primitives::Address;
use serde::{Deserialize, Serialize};
use sha2::{Digest as _, Sha256};
use zeroize::{Zeroize, ZeroizeOnDrop, Zeroizing};

/// Which secret form the swap uses (design section 7).
///
/// `Raw`: the claim authority is `Addr(s)`; Bob claims with client R.
/// `Stock`: the claim authority is `Addr(Derive(m, 0))`, the address a stock
/// wallet shows after importing `m`; Bob claims with client S.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Variant {
    Raw,
    Stock,
}

impl Variant {
    /// The byte the equivalence-proof journal uses (`equiv/portable`: raw = 0, stock = 1).
    pub fn journal_byte(self) -> u8 {
        match self {
            Variant::Raw => 0,
            Variant::Stock => 1,
        }
    }
}

impl fmt::Display for Variant {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(match self {
            Variant::Raw => "raw",
            Variant::Stock => "stock",
        })
    }
}

/// The 32-byte swap secret (`s` in the raw variant, `m` in the stock one).
/// Zeroized on drop; never printed by `Debug`.
#[derive(Clone, Zeroize, ZeroizeOnDrop)]
pub struct Secret([u8; 32]);

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SecretError {
    /// The OS random generator failed or returned something implausible.
    Entropy(String),
    BadHex(String),
    /// Hex text of the wrong length (after stripping `0x`).
    BadLength(usize),
}

impl fmt::Display for SecretError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            SecretError::Entropy(e) => write!(f, "OS random generator failed: {e}"),
            SecretError::BadHex(e) => write!(f, "secret is not valid hex: {e}"),
            SecretError::BadLength(n) => {
                write!(f, "secret must be exactly 64 hex characters (32 bytes), got {n}")
            }
        }
    }
}

impl std::error::Error for SecretError {}

impl Secret {
    /// A fresh secret from the OS CSPRNG (PROJECT.md hard rule 3: fresh per swap).
    pub fn generate() -> Result<Self, SecretError> {
        let mut bytes = Zeroizing::new([0u8; 32]);
        getrandom::getrandom(&mut *bytes).map_err(|e| SecretError::Entropy(e.to_string()))?;
        if *bytes == [0u8; 32] {
            return Err(SecretError::Entropy("all-zero output".into()));
        }
        Ok(Self(*bytes))
    }

    pub const fn from_bytes(bytes: [u8; 32]) -> Self {
        Self(bytes)
    }

    /// Parse 64 hex characters, with or without a `0x` prefix, surrounding whitespace ignored.
    pub fn from_hex(text: &str) -> Result<Self, SecretError> {
        let bytes = parse_hex32(text)?;
        Ok(Self(bytes))
    }

    pub fn bytes(&self) -> &[u8; 32] {
        &self.0
    }

    /// `H = SHA-256(secret)` over the 32 raw bytes: the Ethereum/Bitcoin hashlock.
    pub fn hashlock(&self) -> [u8; 32] {
        sha256(&self.0)
    }

    /// The bytes the Parano1d prover takes as witness: `s` itself (raw) or
    /// `Derive(m, 0)` (stock), the spend secret of the stock wallet's address 0.
    pub fn witness_bytes(&self, variant: Variant) -> Zeroizing<[u8; 32]> {
        match variant {
            Variant::Raw => Zeroizing::new(self.0),
            Variant::Stock => Zeroizing::new(htlc_harness::derive_bytes(self.0, 0)),
        }
    }

    /// The Parano1d claim authority `A`: `Addr(s)` (raw) or `Addr(Derive(m, 0))` (stock).
    pub fn authority(&self, variant: Variant) -> Address {
        htlc_harness::addr(*self.witness_bytes(variant))
    }

    /// `0x` + 64 hex: the form `HTLC.claim(lockId, preimage)` takes.
    pub fn eth_hex(&self) -> Zeroizing<String> {
        Zeroizing::new(format!("0x{}", hex::encode(self.0)))
    }

    /// 64 hex characters, no prefix: what `parano1d --import-wallet-secret` reads on stdin.
    pub fn stock_import_hex(&self) -> Zeroizing<String> {
        Zeroizing::new(hex::encode(self.0))
    }

    /// True for the public test vector `00 01 .. 1f` whose contract must never be
    /// funded (PROJECT.md hard rule 1), and for the all-zero vector.
    pub fn is_public_test_vector(&self) -> bool {
        self.0 == htlc_harness::seq_bytes(0) || self.0 == [0u8; 32]
    }
}

impl fmt::Debug for Secret {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("Secret(<redacted>)")
    }
}

impl PartialEq for Secret {
    /// Constant-time comparison (no early exit on the first differing byte).
    fn eq(&self, other: &Self) -> bool {
        let mut diff = 0u8;
        for (a, b) in self.0.iter().zip(other.0.iter()) {
            diff |= a ^ b;
        }
        diff == 0
    }
}

impl Eq for Secret {}

pub fn sha256(data: &[u8]) -> [u8; 32] {
    let mut h = Sha256::new();
    h.update(data);
    h.finalize().into()
}

/// `0x` + 64 hex for a 32-byte value (hashlocks, lock ids, tx hashes).
pub fn hex32(bytes: &[u8; 32]) -> String {
    format!("0x{}", hex::encode(bytes))
}

/// Parse a 32-byte hex value with or without `0x`.
pub fn parse_hex32(text: &str) -> Result<[u8; 32], SecretError> {
    let t = text.trim();
    let t = t.strip_prefix("0x").or_else(|| t.strip_prefix("0X")).unwrap_or(t);
    if t.len() != 64 {
        return Err(SecretError::BadLength(t.len()));
    }
    let mut out = [0u8; 32];
    hex::decode_to_slice(t, &mut out).map_err(|e| SecretError::BadHex(e.to_string()))?;
    Ok(out)
}

/// Why a preimage seen on the counter-chain is not the one this swap expects.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PreimageError {
    /// `SHA-256(preimage) != H`: not this swap's secret at all.
    HashlockMismatch,
    /// `SHA-256` matched but the Parano1d authority does not: the equivalence
    /// proof was wrong or the variant is wrong. Do not try to claim with it.
    AuthorityMismatch,
}

impl fmt::Display for PreimageError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            PreimageError::HashlockMismatch => write!(f, "SHA-256(preimage) != hashlock"),
            PreimageError::AuthorityMismatch => {
                write!(f, "Addr(preimage) != claim_authority (equivalence failure)")
            }
        }
    }
}

impl std::error::Error for PreimageError {}

/// Bob's step-11 checks on a preimage `x` seen on Ethereum: `SHA-256(x) == H`
/// and `Addr(x)` (or `Addr(Derive(x,0))`) `== claim_authority`.
pub fn check_preimage(
    preimage: &[u8; 32],
    hashlock: &[u8; 32],
    claim_authority: &Address,
    variant: Variant,
) -> Result<(), PreimageError> {
    if sha256(preimage) != *hashlock {
        return Err(PreimageError::HashlockMismatch);
    }
    let candidate = Secret::from_bytes(*preimage);
    if candidate.authority(variant) != *claim_authority {
        return Err(PreimageError::AuthorityMismatch);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    const VECTOR_HASHLOCK: &str =
        "630dcd2966c4336691125448bbb25b4ff412a49c732db2c8abc1b8581bd710dd";
    const VECTOR_ADDR_RAW: &str = "o1lqvrmvsyl7mkt3cptkz3c965ujt5ce6mjawxwwxe7mgn36mjzt8sn69xw2";
    const VECTOR_ADDR_STOCK: &str = "o125qayvgtmvqnlhqmqwe08dza3acaax5mct3u5h4uen3qtrds3jfset7wlk";

    #[test]
    fn design_section_0_test_vectors() {
        let zero = Secret::from_bytes([0u8; 32]);
        assert_eq!(
            hex::encode(zero.hashlock()),
            "66687aadf862bd776c8fc18b8e9f8e20089714856ee233b3902a591d0d5f2925"
        );
        let s = Secret::from_bytes(htlc_harness::seq_bytes(0));
        assert_eq!(hex::encode(s.hashlock()), VECTOR_HASHLOCK);
        assert_eq!(s.authority(Variant::Raw).to_bech32(), VECTOR_ADDR_RAW);
        assert_eq!(s.authority(Variant::Stock).to_bech32(), VECTOR_ADDR_STOCK);
        assert_eq!(
            hex::encode(s.authority(Variant::Raw).0),
            "f8183db204ffb765c7015d851c1754e4974c675b975c6738d9f6d138eb7212cf"
        );
        assert!(s.is_public_test_vector());
        assert!(zero.is_public_test_vector());
    }

    #[test]
    fn hex_forms_follow_the_cross_chain_rules() {
        let s = Secret::from_bytes(htlc_harness::seq_bytes(0));
        let eth = s.eth_hex();
        assert_eq!(
            eth.as_str(),
            "0x000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f"
        );
        let stock = s.stock_import_hex();
        assert_eq!(stock.len(), 64);
        assert_eq!(&eth[2..], stock.as_str());
        assert_eq!(Secret::from_hex(&eth).unwrap(), s);
        assert_eq!(Secret::from_hex(&stock).unwrap(), s);
        assert_eq!(Secret::from_hex(&format!("  {}\n", stock.as_str())).unwrap(), s);
        assert_eq!(Secret::from_hex("0x00").unwrap_err(), SecretError::BadLength(2));
        assert!(matches!(
            Secret::from_hex(&"zz".repeat(32)).unwrap_err(),
            SecretError::BadHex(_)
        ));
    }

    #[test]
    fn generate_is_fresh_and_never_the_test_vector() {
        let a = Secret::generate().unwrap();
        let b = Secret::generate().unwrap();
        assert_ne!(a, b);
        assert!(!a.is_public_test_vector());
        assert_eq!(format!("{a:?}"), "Secret(<redacted>)");
    }

    #[test]
    fn preimage_checks_distinguish_the_two_failures() {
        let s = Secret::from_bytes(htlc_harness::seq_bytes(0));
        let h = s.hashlock();
        let a_raw = s.authority(Variant::Raw);
        let a_stock = s.authority(Variant::Stock);
        assert_eq!(check_preimage(s.bytes(), &h, &a_raw, Variant::Raw), Ok(()));
        assert_eq!(check_preimage(s.bytes(), &h, &a_stock, Variant::Stock), Ok(()));
        // Right hashlock, wrong variant: the authority does not match.
        assert_eq!(
            check_preimage(s.bytes(), &h, &a_raw, Variant::Stock),
            Err(PreimageError::AuthorityMismatch)
        );
        // Another secret: the hashlock does not match.
        let other = htlc_harness::seq_bytes(1);
        assert_eq!(
            check_preimage(&other, &h, &a_raw, Variant::Raw),
            Err(PreimageError::HashlockMismatch)
        );
    }

    #[test]
    fn hex32_round_trips() {
        let h = [0xabu8; 32];
        assert_eq!(parse_hex32(&hex32(&h)).unwrap(), h);
        assert_eq!(parse_hex32(&hex32(&h)[2..]).unwrap(), h);
    }
}
