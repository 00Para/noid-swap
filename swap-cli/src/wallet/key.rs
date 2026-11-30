//! The swap wallet's key: a fresh master secret `m` and its first stock-wallet address.
//!
//! The stock wallet (the Parano1d wallet app) never signs with `m` itself. For its address number `i` it uses the spend secret
//! `Derive(m, i)` (three Poseidon2b permutations over `m_lo, m_hi, i, "noid-deri"`), and the address is `Addr(Derive(m, i))`. This type fixes
//! index 0: the swap wallet's address is exactly what a stock wallet imported from `m` shows first, so `m` is a way out of this tool.
//! The derivation itself is `htlc_harness::derive_bytes`, which is the same sponge as the vendor wallet's private `MasterSecret::derive_spend_secret`
//! (that type is private to the node binary and cannot be called from here; a test reads its source and compares, and a known vector pins it).

use noid_poseidon2b::primitives::Address;
use zeroize::Zeroizing;

use super::WalletError;
use crate::secret::{Secret, Variant};

/// The swap wallet's master secret. Zeroized on drop; never printed.
pub struct WalletKey {
    m: Secret,
}

impl WalletKey {
    /// A fresh master secret from the OS random generator. A secret that is all zero (a failed generator) is refused.
    pub fn generate() -> Result<Self, WalletError> {
        Secret::generate().map(|m| Self { m }).map_err(|e| WalletError::Entropy(e.to_string()))
    }

    /// Wrap an existing master secret (a swap file's sealed wallet, a test vector). Nothing is checked here: the callers that care
    /// (`SwapFile::new_alice_with_wallet`) refuse the public test vector.
    pub fn from_secret(m: Secret) -> Self {
        Self { m }
    }

    /// The master secret `m`, for sealing and for the explicit backup export only.
    pub fn master(&self) -> &Secret {
        &self.m
    }

    /// `Derive(m, 0)`: the 32-byte spend secret the stock wallet uses for its first address, and the witness of every proof this wallet makes.
    pub fn spend_secret(&self) -> Zeroizing<[u8; 32]> {
        self.m.witness_bytes(Variant::Stock)
    }

    /// `Addr(Derive(m, 0))`: where the user deposits, and the swap's recovery authority and recipient.
    pub fn address(&self) -> Address {
        self.m.authority(Variant::Stock)
    }
}

impl std::fmt::Debug for WalletKey {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("WalletKey(<redacted>)")
    }
}

// ---------------------------------------------------------------- the wallet file

/// A standalone sealed wallet (`swap-cli wallet new --out FILE`): the master secret under the swap file's scheme (Argon2id, XChaCha20-Poly1305, its
/// own associated-data label) and the address, so that the address is known BEFORE the swap file exists and can be given to `new-alice --wallet`,
/// which moves the secret into the swap file. Hold it only until then.
#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct WalletFile {
    pub version: u32,
    /// `Addr(Derive(m, 0))`, bech32.
    pub address: String,
    pub secret: crate::swapfile::EncryptedSecret,
}

pub const WALLET_FILE_VERSION: u32 = 1;
/// The label of a standalone wallet file (not the swap file's wallet label: the blobs are not interchangeable).
const WALLET_FILE_LABEL: &[u8] = b"noid-swap/wallet-file/v1";

fn wallet_file_digest(address: &Address) -> [u8; 32] {
    use sha2::{Digest, Sha256};
    let mut h = Sha256::new();
    h.update(WALLET_FILE_LABEL);
    h.update(address.0);
    h.finalize().into()
}

impl WalletFile {
    pub fn create(key: &WalletKey, pass: &crate::swapfile::Passphrase, kdf: &crate::swapfile::KdfParams) -> Result<Self, WalletError> {
        let address = key.address();
        let secret = crate::swapfile::EncryptedSecret::seal_labeled(key.master(), pass, kdf, wallet_file_digest(&address), WALLET_FILE_LABEL, &address.0)
            .map_err(|e| WalletError::Refused(e.to_string()))?;
        Ok(Self { version: WALLET_FILE_VERSION, address: address.to_bech32(), secret })
    }

    pub fn open(&self, pass: &crate::swapfile::Passphrase) -> Result<WalletKey, WalletError> {
        if self.version != WALLET_FILE_VERSION {
            return Err(WalletError::Refused(format!("unsupported wallet file version {}", self.version)));
        }
        self.secret.kdf.check_bounds().map_err(|e| WalletError::Refused(e.to_string()))?;
        let address = Address::parse(&self.address).map_err(|e| WalletError::Refused(format!("wallet address: {e}")))?;
        let m = self
            .secret
            .open_labeled(pass, wallet_file_digest(&address), WALLET_FILE_LABEL, &address.0)
            .map_err(|e| WalletError::Refused(e.to_string()))?;
        let key = WalletKey::from_secret(m);
        if key.address() != address {
            return Err(WalletError::Refused("the wallet secret does not derive the address in the file".into()));
        }
        Ok(key)
    }

    /// Write a NEW file (an existing one is never overwritten).
    pub fn save_new(&self, path: &std::path::Path) -> Result<(), WalletError> {
        if path.exists() {
            return Err(WalletError::Refused(format!("{} already exists; never overwrite a wallet file", path.display())));
        }
        let text = serde_json::to_vec_pretty(self).map_err(|e| WalletError::Persist(e.to_string()))?;
        crate::swapfile::atomic_write(path, &text).map_err(|e| WalletError::Persist(e.to_string()))
    }

    pub fn load(path: &std::path::Path) -> Result<Self, WalletError> {
        let bytes = std::fs::read(path).map_err(|e| WalletError::Refused(format!("{}: {e}", path.display())))?;
        serde_json::from_slice(&bytes).map_err(|e| WalletError::Refused(format!("{}: not a wallet file: {e}", path.display())))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use htlc_harness as h;
    use noid_core::{Block128, TowerField};
    use noid_poseidon2b::native::compression::Poseidon2bSponge;

    /// The public vector of PROJECT.md: `m = 00 01 .. 1f` has the stock wallet's first address `o125qay...`.
    const VECTOR_ADDRESS: &str = "o125qayvgtmvqnlhqmqwe08dza3acaax5mct3u5h4uen3qtrds3jfset7wlk";

    fn vector_m() -> Secret {
        Secret::from_bytes(h::seq_bytes(0))
    }

    #[test]
    fn the_known_vector_gives_the_stock_wallets_first_address() {
        let key = WalletKey::from_secret(vector_m());
        assert_eq!(key.address().to_bech32(), VECTOR_ADDRESS);
    }

    /// A transcription of the vendor wallet's `MasterSecret::derive_spend_secret` (noid_node/src/wallet/keystore.rs), written out here with
    /// the vendor's own primitives: zero IV, absorb `m_lo`, `m_hi`, the index and "noid-deri", finalize.
    fn vendor_derive(m: [u8; 32], index: u32) -> [u8; 32] {
        let mut sponge = Poseidon2bSponge::with_iv([Block128::ZERO; 2]);
        sponge.absorb(Block128::from(u128::from_le_bytes(m[..16].try_into().unwrap())));
        sponge.absorb(Block128::from(u128::from_le_bytes(m[16..].try_into().unwrap())));
        sponge.absorb(Block128::from(index as u128));
        sponge.absorb(Block128::from(0x6E6F69642D64657269_u128));
        sponge.finalize()
    }

    #[test]
    fn derive_agrees_with_the_vendor_sponge_for_many_secrets_and_indices() {
        for seed in 0..40u8 {
            let m = h::seq_bytes(seed.wrapping_mul(7));
            for index in [0u32, 1, 2, 17, u32::MAX] {
                assert_eq!(h::derive_bytes(m, index), vendor_derive(m, index), "seed {seed} index {index}");
            }
            let key = WalletKey::from_secret(Secret::from_bytes(m));
            assert_eq!(*key.spend_secret(), vendor_derive(m, 0));
            assert_eq!(key.address(), h::addr(vendor_derive(m, 0)));
        }
    }

    /// The vendor's derivation is private to a binary crate, so this test reads its source and pins the lines that define it: if the vendor
    /// changes the derivation, this fails before a stock wallet and this tool disagree about an address.
    #[test]
    fn the_vendor_derivation_source_still_reads_the_same() {
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../vendor/parano1d/noid_node/src/wallet/keystore.rs");
        let Ok(text) = std::fs::read_to_string(&path) else {
            eprintln!("note: the vendor source is not here; the drift guard was skipped");
            return;
        };
        let start = text.find("fn derive_spend_secret").expect("the vendor derivation exists");
        let body = &text[start..start + 1200.min(text.len() - start)];
        for needle in [
            "Poseidon2bSponge::with_iv([Block128::ZERO; 2])",
            "u128::from_le_bytes(self.0[..16].try_into().unwrap())",
            "u128::from_le_bytes(self.0[16..].try_into().unwrap())",
            "sponge.absorb(Block128::from(index as u128));",
            "sponge.absorb(Block128::from(0x6E6F69642D64657269_u128)); // \"noid-deri\"",
            "sponge.finalize()",
        ] {
            assert!(body.contains(needle), "the vendor derivation no longer contains `{needle}`");
        }
        // The order of the absorbs is the definition: m_lo, m_hi, index, tag.
        let positions: Vec<usize> = ["self.0[..16]", "self.0[16..]", "index as u128", "0x6E6F69642D64657269"]
            .iter()
            .map(|n| body.find(n).expect("present"))
            .collect();
        assert!(positions.windows(2).all(|w| w[0] < w[1]));
    }

    #[test]
    fn a_generated_key_is_fresh_and_never_the_public_vector() {
        let a = WalletKey::generate().unwrap();
        let b = WalletKey::generate().unwrap();
        assert_ne!(a.master().bytes(), b.master().bytes());
        assert!(!a.master().is_public_test_vector());
        assert_ne!(a.address(), b.address());
    }

    #[test]
    fn debug_never_shows_the_secret() {
        let key = WalletKey::from_secret(vector_m());
        let text = format!("{key:?}");
        assert!(!text.contains("00010203"));
        assert!(text.contains("redacted"));
    }
}
