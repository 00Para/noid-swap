//! The Ethereum key of one swap (swap wallet, piece 2b): a fresh throwaway Ethereum key per party, sealed in the swap file.
//!
//! Plain words. A swap needs an Ethereum account for each party: Alice's pays the reveal's fee and receives the ETH she buys (it IS the swap's
//! `alice_receiver`), Bob's receives his deposit, sends the lock and receives the refund if the swap fails (it IS `bob_sender`). The tool keeps
//! that key sealed in the swap file with the same scheme as the claim secret (Argon2id and XChaCha20-Poly1305, its own associated-data label) and
//! hands it to `live.js` through a pipe (`swap-cli ethkey emit FILE | node scripts/live.js ... --key-stdin`), never through a command line or a
//! log. What is left in the key's account when the swap ends is swept to an Ethereum address the user gave when the swap was made.
//!
//! What this module does NOT do: derive the address from the key. Computing an Ethereum address needs secp256k1 point multiplication and
//! Keccak-256, and this crate has no secp256k1 implementation and must not gain a dependency for one. So the key is made by `live.js keygen
//! --stdout` (ethers, the OS random generator), which prints the address and the key; `swap-cli ethkey new` checks that the key is a valid
//! secp256k1 secret (not zero, below the group order) and seals both. The address stored beside the sealed key is therefore the caller's claim
//! until `live.js` uses the key: every use of it there recomputes the address from the key and refuses unless it equals the swap's
//! `alice_receiver` or `bob_sender`, and `live.js address --key-stdin --expect ADDRESS` is the check to run right after `ethkey new`.

use std::fmt;

use zeroize::Zeroizing;

use crate::secret::Secret;
use crate::swapfile::{EncryptedSecret, KdfParams, Passphrase};

pub const ETH_KEY_FILE_VERSION: u32 = 1;
/// The label (and associated-data domain) of a standalone key file. The swap file's own label is [`crate::swapfile::AAD_LABEL_ETH_KEY`]: the
/// two blobs are not interchangeable, and neither opens as the claim secret or the NOID wallet.
pub const AAD_LABEL_ETH_KEY_FILE: &[u8] = b"noid-swap/eth-key-file/v1";

/// The order `n` of the secp256k1 group, big-endian. A private key is valid when `1 <= k < n`.
const SECP256K1_ORDER: [u8; 32] = [
    0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFE, 0xBA, 0xAE, 0xDC, 0xE6, 0xAF, 0x48, 0xA0, 0x3B, 0xBF, 0xD2, 0x5E,
    0x8C, 0xD0, 0x36, 0x41, 0x41,
];

/// Why an Ethereum key, address or key file was refused. Never carries the key text.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum EthKeyError {
    /// The key is not `0x` and 64 hex characters, or is not a valid secp256k1 secret.
    BadKey(String),
    /// An address that is not `0x` and 40 hex characters.
    BadAddress(String),
    /// A rule of this tool refused it.
    Refused(String),
    /// The file could not be read, written or parsed.
    File(String),
}

impl fmt::Display for EthKeyError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            EthKeyError::BadKey(e) | EthKeyError::BadAddress(e) | EthKeyError::Refused(e) | EthKeyError::File(e) => f.write_str(e),
        }
    }
}

impl std::error::Error for EthKeyError {}

/// True when the 32 bytes are a valid secp256k1 private key: not zero and below the group order (big-endian compare of equal-length byte strings
/// is the numeric compare).
pub fn is_valid_secret(bytes: &[u8; 32]) -> bool {
    bytes.iter().any(|b| *b != 0) && bytes.as_slice() < SECP256K1_ORDER.as_slice()
}

/// `0x` and 40 hex characters (either case, no checksum is checked) -> 20 bytes. The text is never echoed.
pub fn parse_address(text: &str) -> Result<[u8; 20], EthKeyError> {
    let t = text.trim();
    let body = t.strip_prefix("0x").ok_or_else(|| EthKeyError::BadAddress("an Ethereum address is 0x followed by 40 hex characters".into()))?;
    if body.len() != 40 {
        return Err(EthKeyError::BadAddress("an Ethereum address is 0x followed by 40 hex characters".into()));
    }
    let v = hex::decode(body).map_err(|_| EthKeyError::BadAddress("an Ethereum address is 0x followed by 40 hex characters".into()))?;
    v.try_into().map_err(|_| EthKeyError::BadAddress("an Ethereum address is 0x followed by 40 hex characters".into()))
}

/// `0x` + 40 lower-case hex characters.
pub fn address_hex(a: &[u8; 20]) -> String {
    format!("0x{}", hex::encode(a))
}

/// `0x` and 64 hex characters -> a valid secp256k1 secret. Nothing of the text is echoed in an error.
pub fn parse_key(text: &str) -> Result<Secret, EthKeyError> {
    let bad = || EthKeyError::BadKey("an Ethereum key is 0x followed by 64 hex characters, and must be a valid secp256k1 secret (not zero, below the group order); its text is not shown".into());
    let text = Zeroizing::new(text.trim().to_string());
    let body = text.strip_prefix("0x").ok_or_else(bad)?;
    if body.len() != 64 {
        return Err(bad());
    }
    let v = Zeroizing::new(hex::decode(body).map_err(|_| bad())?);
    let bytes: [u8; 32] = v.as_slice().try_into().map_err(|_| bad())?;
    let bytes = Zeroizing::new(bytes);
    if !is_valid_secret(&bytes) {
        return Err(bad());
    }
    Ok(Secret::from_bytes(*bytes))
}

/// An Ethereum key with the address it is said to have. Zeroized on drop; never printed.
pub struct EthKey {
    secret: Secret,
    address: [u8; 20],
}

impl EthKey {
    /// `secret` must be a valid secp256k1 secret and `address` a non-zero address. That the address belongs to the key is NOT checked here (see the
    /// module text): `live.js` recomputes it on every use.
    pub fn new(secret: Secret, address: [u8; 20]) -> Result<Self, EthKeyError> {
        if !is_valid_secret(secret.bytes()) {
            return Err(EthKeyError::BadKey("not a valid secp256k1 secret (zero or not below the group order)".into()));
        }
        if address == [0u8; 20] {
            return Err(EthKeyError::BadAddress("the zero address cannot be a swap's Ethereum account".into()));
        }
        Ok(Self { secret, address })
    }

    pub fn address(&self) -> [u8; 20] {
        self.address
    }

    pub fn secret(&self) -> &Secret {
        &self.secret
    }

    /// `0x` + 64 hex: the form `live.js` reads on `--key-stdin`. For `ethkey emit` only.
    pub fn emit_hex(&self) -> Zeroizing<String> {
        self.secret.eth_hex()
    }
}

impl fmt::Debug for EthKey {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "EthKey({}, <redacted>)", address_hex(&self.address))
    }
}

/// The input of `ethkey new`, read from a pipe: exactly two lines, the address and then the key, as `live.js keygen --stdout` writes them. Any
/// other shape (a third line, a missing one, an empty one) is refused, and an error never shows the text.
pub fn parse_keygen_output(text: &str) -> Result<EthKey, EthKeyError> {
    let text = Zeroizing::new(text.to_string());
    let body = text.strip_suffix('\n').map(|t| t.strip_suffix('\r').unwrap_or(t)).unwrap_or(&text);
    let lines: Vec<&str> = body.split('\n').map(|l| l.strip_suffix('\r').unwrap_or(l)).collect();
    if lines.len() != 2 || lines.iter().any(|l| l.trim().is_empty()) {
        return Err(EthKeyError::Refused("stdin must be exactly two lines: the address, then the key (what `live.js keygen --stdout` writes); nothing else is accepted".into()));
    }
    let address = parse_address(lines[0])?;
    let key = parse_key(lines[1])?;
    EthKey::new(key, address)
}

// ---------------------------------------------------------------- the standalone key file

/// A standalone sealed Ethereum key (`swap-cli ethkey new --out FILE`): the key under the swap file's scheme and its own label, and the address, so
/// the address is known BEFORE the swap file exists (it is what `--eth-receiver` or `--eth-sender` and the deposit go to). `new-alice --eth-key` and
/// `new-bob --eth-key` move the key into the swap file; hold this file only until then.
#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct EthKeyFile {
    pub version: u32,
    /// `0x` + 40 lower-case hex.
    pub address: String,
    pub secret: EncryptedSecret,
}

fn key_file_digest(address: &[u8; 20]) -> [u8; 32] {
    use sha2::{Digest, Sha256};
    let mut h = Sha256::new();
    h.update(AAD_LABEL_ETH_KEY_FILE);
    h.update(address);
    h.finalize().into()
}

impl EthKeyFile {
    pub fn create(key: &EthKey, pass: &Passphrase, kdf: &KdfParams) -> Result<Self, EthKeyError> {
        let address = key.address();
        let secret = EncryptedSecret::seal_labeled(key.secret(), pass, kdf, key_file_digest(&address), AAD_LABEL_ETH_KEY_FILE, &address)
            .map_err(|e| EthKeyError::File(e.to_string()))?;
        Ok(Self { version: ETH_KEY_FILE_VERSION, address: address_hex(&address), secret })
    }

    pub fn address(&self) -> Result<[u8; 20], EthKeyError> {
        parse_address(&self.address)
    }

    pub fn open(&self, pass: &Passphrase) -> Result<EthKey, EthKeyError> {
        if self.version != ETH_KEY_FILE_VERSION {
            return Err(EthKeyError::File(format!("unsupported Ethereum key file version {}", self.version)));
        }
        self.secret.kdf.check_bounds().map_err(|e| EthKeyError::File(e.to_string()))?;
        let address = self.address()?;
        let secret = self
            .secret
            .open_labeled(pass, key_file_digest(&address), AAD_LABEL_ETH_KEY_FILE, &address)
            .map_err(|e| EthKeyError::File(e.to_string()))?;
        EthKey::new(secret, address)
    }

    /// Write a NEW file (an existing one is never overwritten).
    pub fn save_new(&self, path: &std::path::Path) -> Result<(), EthKeyError> {
        if path.exists() {
            return Err(EthKeyError::File(format!("{} already exists; never overwrite a key file", path.display())));
        }
        let text = serde_json::to_vec_pretty(self).map_err(|e| EthKeyError::File(e.to_string()))?;
        crate::swapfile::atomic_write_new(path, &text).map_err(|e| EthKeyError::File(e.to_string()))
    }

    pub fn load(path: &std::path::Path) -> Result<Self, EthKeyError> {
        let bytes = std::fs::read(path).map_err(|e| EthKeyError::File(format!("{}: {e}", path.display())))?;
        serde_json::from_slice(&bytes).map_err(|e| EthKeyError::File(format!("{}: not an Ethereum key file: {e}", path.display())))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_range_of_a_valid_secret_is_one_up_to_the_order_minus_one() {
        assert!(!is_valid_secret(&[0u8; 32]));
        let mut one = [0u8; 32];
        one[31] = 1;
        assert!(is_valid_secret(&one));
        assert!(!is_valid_secret(&SECP256K1_ORDER));
        let mut below = SECP256K1_ORDER;
        below[31] -= 1;
        assert!(is_valid_secret(&below));
        let mut above = SECP256K1_ORDER;
        above[31] += 1;
        assert!(!is_valid_secret(&above));
        assert!(!is_valid_secret(&[0xFF; 32]));
    }

    #[test]
    fn a_key_text_is_checked_and_never_echoed() {
        let good = format!("0x{}", "11".repeat(32));
        assert!(parse_key(&good).is_ok());
        for bad in [
            "11".repeat(32),
            format!("0x{}", "11".repeat(31)),
            format!("0x{}", "zz".repeat(32)),
            format!("0x{}", "00".repeat(32)),
            format!("0x{}", "ff".repeat(32)),
            String::new(),
        ] {
            let e = parse_key(&bad).unwrap_err().to_string();
            assert!(e.contains("text is not shown"), "{e}");
            if !bad.is_empty() {
                assert!(!e.contains(&bad), "{e}");
            }
        }
    }

    #[test]
    fn the_keygen_framing_is_exactly_two_lines() {
        let addr = format!("0x{}", "ab".repeat(20));
        let key = format!("0x{}", "11".repeat(32));
        let ok = parse_keygen_output(&format!("{addr}\n{key}\n")).unwrap();
        assert_eq!(address_hex(&ok.address()), addr);
        assert!(parse_keygen_output(&format!("{addr}\r\n{key}\r\n")).is_ok());
        assert!(parse_keygen_output(&format!("{addr}\n{key}")).is_ok());
        for bad in [
            String::new(),
            format!("{key}\n"),
            format!("{key}\n{addr}\n"),
            format!("{addr}\n{key}\n{key}\n"),
            format!("{addr}\n\n{key}\n"),
            format!("{addr}\n{key}\n\n"),
            format!("{addr} {key}\n"),
            format!("0x{}\n{key}\n", "00".repeat(20)),
        ] {
            let e = parse_keygen_output(&bad).unwrap_err().to_string();
            assert!(!e.contains(&key[2..]), "{e}");
        }
    }

    #[test]
    fn debug_never_shows_the_key() {
        let key = EthKey::new(parse_key(&format!("0x{}", "11".repeat(32))).unwrap(), [0xab; 20]).unwrap();
        let text = format!("{key:?}");
        assert!(!text.contains("1111"));
        assert!(text.contains("redacted"));
    }
}
