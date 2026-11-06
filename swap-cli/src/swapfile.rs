//! The persisted swap file (M2.3): everything a party needs to finish or
//! unwind a swap after a crash, written **before** any on-chain action.
//!
//! Plain words: the file holds the public facts both sides share (the contract
//! *opening*, the parameters, the hashlock), the current phase and its history,
//! any action that was about to be performed, and for Alice the secret,
//! encrypted with a passphrase. Losing the opening makes the NOID lock
//! unspendable by either side (threat T15), so the file is written first and
//! replaced atomically on every change.
//!
//! Secret at rest: Argon2id(passphrase, salt) -> 32-byte key;
//! XChaCha20-Poly1305 with a random 24-byte nonce; the associated data binds
//! the ciphertext to a digest of the public section, so a swapped public
//! section is detected before the secret is used.

use std::fmt;
use std::io::Write as _;
use std::path::{Path, PathBuf};

use argon2::{Algorithm, Argon2, Params, Version};
use chacha20poly1305::aead::{Aead, KeyInit, Payload};
use chacha20poly1305::{Key, XChaCha20Poly1305, XNonce};
use noid_poseidon2b::primitives::Address;
use noid_tx::experimental_object::ObjectOpening;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use zeroize::Zeroizing;

use crate::params::{self, ContractVersion, ProfileName};
use crate::secret::{sha256, Secret, Variant};
use crate::state::{transition, Event, InvalidTransition, Phase, Role};
use crate::watch::{hexbytes, hexbytes_opt, u128dec};

pub const SWAP_FILE_VERSION: u32 = 1;
/// Files end in `.swap.json`, which the repository's `.gitignore` excludes.
pub const SWAP_FILE_SUFFIX: &str = ".swap.json";
const AAD_DOMAIN: &[u8] = b"noid-swap/swapfile/v1";

// ---------------------------------------------------------------- errors

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SwapFileError {
    Io(String),
    Json(String),
    /// The file was written by another version of this tool.
    Version(u32),
    /// The public section is inconsistent (opening, params, guard, gates).
    Invalid(String),
    /// Key derivation or AEAD failure other than a wrong key.
    Crypto(String),
    /// Decryption failed: wrong passphrase or tampered ciphertext.
    WrongPassphrase,
    /// The public section no longer matches what the secret was sealed to.
    PublicSectionModified,
    /// The secret does not belong to this swap (hashlock or authority mismatch).
    SecretMismatch,
    /// PROJECT.md hard rule 1: the public test vector must never be used.
    PublicTestVector,
    /// T9: this hashlock was already used by another swap on this machine.
    HashlockReused,
    /// Bob's file has no secret.
    NoSecret,
}

impl fmt::Display for SwapFileError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            SwapFileError::Io(e) => write!(f, "io: {e}"),
            SwapFileError::Json(e) => write!(f, "json: {e}"),
            SwapFileError::Version(v) => write!(f, "unsupported swap file version {v}"),
            SwapFileError::Invalid(e) => write!(f, "invalid swap file: {e}"),
            SwapFileError::Crypto(e) => write!(f, "crypto: {e}"),
            SwapFileError::WrongPassphrase => write!(f, "wrong passphrase (or tampered secret blob)"),
            SwapFileError::PublicSectionModified => {
                write!(f, "the public section changed since the secret was sealed")
            }
            SwapFileError::SecretMismatch => write!(f, "secret does not match this swap's hashlock/authority"),
            SwapFileError::PublicTestVector => {
                write!(f, "refusing the public test vector secret (PROJECT.md hard rule 1)")
            }
            SwapFileError::HashlockReused => write!(f, "hashlock already used by another swap (T9)"),
            SwapFileError::NoSecret => write!(f, "this swap file holds no secret"),
        }
    }
}

impl std::error::Error for SwapFileError {}

fn io_err(e: std::io::Error) -> SwapFileError {
    SwapFileError::Io(e.to_string())
}

// ---------------------------------------------------------------- public section

/// Ethereum-side parameters pinned at negotiation (design step 0 and step 9).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct EthParams {
    pub chain_id: u64,
    /// Pinned HTLC deployment address.
    #[serde(with = "hexbytes")]
    pub contract: [u8; 20],
    /// `keccak256(eth_getCode(contract))`. REVIEW-3 F1: always `params::HTLC_CODE_HASH` in a file this build accepts
    /// (`check` refuses anything else, `None` included; the field stays optional only so an old file still parses).
    #[serde(default, with = "hexbytes_opt")]
    pub code_hash: Option<[u8; 32]>,
    /// The ETH amount Bob locks (JSON: decimal string).
    #[serde(with = "u128dec")]
    pub amount_wei: u128,
    /// `A_eth`: Alice's receiving EOA.
    #[serde(with = "hexbytes")]
    pub alice_receiver: [u8; 20],
    /// `B_eth`: Bob's sending EOA (the lock's `sender`).
    #[serde(with = "hexbytes")]
    pub bob_sender: [u8; 20],
}

/// Negotiated and derived swap parameters.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct SwapParams {
    pub variant: Variant,
    /// The timing profile (`params::ProfileName`): every gate number is read from it. `production` is the
    /// default and is not written, so a file without the field is a production file and keeps its digest.
    #[serde(default, skip_serializing_if = "ProfileName::is_production")]
    pub profile: ProfileName,
    /// Which Parano1d contract holds the NOID (`params::ContractVersion`): `1` = `HashTimeLock`, `2` =
    /// `HashTimeLockV2` (every close pays exactly `max_fee`). `1` is the default and is not written, so a file
    /// without the field is a v1 file and keeps its digest. The opening commits to it (the code id is in the
    /// 699 bytes), so changing or dropping the field in a v2 bundle makes the rebuild mismatch.
    #[serde(default, skip_serializing_if = "ContractVersion::is_v1")]
    pub contract_version: ContractVersion,
    /// `V`, the NOID funded into the lock (micro-NOID).
    pub amount_micronoid: u64,
    /// `F_max`.
    pub max_fee_micronoid: u64,
    /// `H_create`: the Parano1d height the deadline was computed from.
    pub h_create: u64,
    /// `D`.
    pub deadline_height: u64,
    /// `D - RHS(I1)(W_A)`: Bob must lock at or before this height.
    pub lock_by_height: u64,
    /// `W_A` in seconds.
    pub w_a_s: u64,
    /// `A_noid`: Alice's stock-wallet active address (recovery authority and recipient).
    pub alice_noid: String,
    /// `B_noid`: Bob's payout address (claim recipient).
    pub bob_noid: String,
    pub eth: EthParams,
}

impl SwapParams {
    /// The fee every close pays under this contract: `Some(max_fee)` for v2, `None` for v1 (anything in
    /// `[MIN_CLOSE_FEE, max_fee]`).
    pub fn fixed_close_fee(&self) -> Option<u64> {
        self.contract_version.is_fixed_fee().then_some(self.max_fee_micronoid)
    }

    /// What Bob's claim pays him when the close fee is `fee` (`amount - fee`; never wraps).
    pub fn bob_payout_for_fee(&self, fee: u64) -> u64 {
        self.amount_micronoid.saturating_sub(fee)
    }

    /// Bob's exact payout, known up front only under v2: `amount - max_fee`.
    pub fn expected_bob_payout(&self) -> Option<u64> {
        self.fixed_close_fee().map(|f| self.bob_payout_for_fee(f))
    }
}

/// What both parties know: the a2-a7 bundle Alice sends Bob (design step 4).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct SwapPublic {
    #[serde(with = "hexbytes")]
    pub hashlock: [u8; 32],
    /// `A`, bech32.
    pub claim_authority: String,
    /// The canonical 699-byte opening, hex (what the node RPCs take).
    pub opening_hex: String,
    /// `opening.root()`, bech32: the address the NOID is funded to.
    pub contract_root: String,
    pub params: SwapParams,
}

impl SwapPublic {
    /// Build the public section for a new swap, through the M0.6 tool guard.
    /// `fee_estimate_1_1` is `estimateFeeDetailed(1,1).fee_micronoid` at creation.
    #[allow(clippy::too_many_arguments)]
    pub fn build(
        secret: &Secret,
        variant: Variant,
        alice_noid: &Address,
        bob_noid: &Address,
        amount_micronoid: u64,
        fee_estimate_1_1: u64,
        h_create: u64,
        eth: EthParams,
    ) -> Result<Self, SwapFileError> {
        Self::build_with_profile(secret, variant, ProfileName::Production, alice_noid, bob_noid, amount_micronoid, fee_estimate_1_1, h_create, eth)
    }

    /// [`SwapPublic::build`] under a named timing profile (`production`, `rehearsal` or `sepolia`), contract v1.
    #[allow(clippy::too_many_arguments)]
    pub fn build_with_profile(
        secret: &Secret,
        variant: Variant,
        profile: ProfileName,
        alice_noid: &Address,
        bob_noid: &Address,
        amount_micronoid: u64,
        fee_estimate_1_1: u64,
        h_create: u64,
        eth: EthParams,
    ) -> Result<Self, SwapFileError> {
        Self::build_with_options(secret, variant, profile, ContractVersion::V1, alice_noid, bob_noid, amount_micronoid, fee_estimate_1_1, h_create, eth)
    }

    /// [`SwapPublic::build_with_profile`] with an explicit contract version (`new-alice --contract-version`).
    /// `fee_estimate_1_1` is the `floor_seen` of `params::fee_cap_for` (see `params::floor_seen_for`).
    #[allow(clippy::too_many_arguments)]
    pub fn build_with_options(
        secret: &Secret,
        variant: Variant,
        profile: ProfileName,
        contract_version: ContractVersion,
        alice_noid: &Address,
        bob_noid: &Address,
        amount_micronoid: u64,
        fee_estimate_1_1: u64,
        h_create: u64,
        eth: EthParams,
    ) -> Result<Self, SwapFileError> {
        let g = profile.gates();
        g.validate().map_err(|e| SwapFileError::Invalid(e.to_string()))?;
        g.check_caps(amount_micronoid, eth.amount_wei, eth.chain_id).map_err(|e| SwapFileError::Invalid(e.to_string()))?;
        if secret.is_public_test_vector() {
            return Err(SwapFileError::PublicTestVector);
        }
        // REVIEW-3 F1: the pin is the constant of this build. A caller that leaves it unset gets the constant; any other
        // value is refused (no override).
        let mut eth = eth;
        match eth.code_hash {
            None => eth.code_hash = Some(params::HTLC_CODE_HASH),
            Some(h) if h == params::HTLC_CODE_HASH => {}
            Some(h) => return Err(SwapFileError::Invalid(other_contract_message("eth.code_hash", &h))),
        }
        let d = g.alice_deadline_eth(h_create).map_err(|e| SwapFileError::Invalid(e.to_string()))?;
        g.check_i5(h_create, d).map_err(|e| SwapFileError::Invalid(e.to_string()))?;
        // v1: `fee_estimate_1_1` is the live estimate; v2: the caller passes the larger of the estimate and the operator's
        // highest relay floor of the last 24 h (`params::floor_seen_for`), and the 5x rule applies.
        let max_fee = params::fee_cap_for(contract_version, fee_estimate_1_1, amount_micronoid)
            .map_err(|e| SwapFileError::Invalid(e.to_string()))?;
        let authority = secret.authority(variant);
        let opening = compile_guarded(contract_version, authority, *bob_noid, *alice_noid, d, max_fee)?;
        let bytes = opening.to_bytes().map_err(|e| SwapFileError::Invalid(format!("opening: {e:?}")))?;
        let public = SwapPublic {
            hashlock: secret.hashlock(),
            claim_authority: authority.to_bech32(),
            opening_hex: hex::encode(bytes),
            contract_root: opening.root().to_bech32(),
            params: SwapParams {
                variant,
                profile,
                contract_version,
                amount_micronoid,
                max_fee_micronoid: max_fee,
                h_create,
                deadline_height: d,
                lock_by_height: g.bob_lock_by(d),
                w_a_s: g.w_a_s,
                alice_noid: alice_noid.to_bech32(),
                bob_noid: bob_noid.to_bech32(),
                eth,
            },
        };
        public.check()?;
        Ok(public)
    }

    /// Decode the opening from `opening_hex`.
    pub fn opening(&self) -> Result<ObjectOpening, SwapFileError> {
        let bytes = hex::decode(&self.opening_hex)
            .map_err(|e| SwapFileError::Invalid(format!("opening_hex: {e}")))?;
        ObjectOpening::from_bytes(&bytes).map_err(|e| SwapFileError::Invalid(format!("opening: {e:?}")))
    }

    /// Bob's pre-checks (design section 6.3 items 1-8) and Alice's self-check:
    /// the opening decodes, rebuilds byte-for-byte from the parameters, passes
    /// the tool guard, and the heights satisfy the gates.
    pub fn check(&self) -> Result<(), SwapFileError> {
        let inv = |m: String| SwapFileError::Invalid(m);
        let opening = self.opening()?;
        let p = &self.params;
        let authority = Address::parse(&self.claim_authority)
            .map_err(|e| inv(format!("claim_authority: {e}")))?;
        let alice = Address::parse(&p.alice_noid).map_err(|e| inv(format!("alice_noid: {e}")))?;
        let bob = Address::parse(&p.bob_noid).map_err(|e| inv(format!("bob_noid: {e}")))?;
        if self.hashlock == [0u8; 32] {
            return Err(inv("hashlock is zero".into()));
        }
        // Byte-for-byte rebuild (design step 5), which also runs the guard.
        let rebuilt = compile_guarded(p.contract_version, authority, bob, alice, p.deadline_height, p.max_fee_micronoid)
            .map_err(|e| inv(e.to_string()))?;
        if rebuilt != opening {
            return Err(inv(format!(
                "opening does not rebuild byte-for-byte from the parameters (as a contract v{} HashTimeLock{})",
                p.contract_version,
                if p.contract_version.is_fixed_fee() { " with the fixed fee" } else { "" }
            )));
        }
        htlc_harness::check_opening(&opening).map_err(|e| inv(format!("tool guard: {e}")))?;
        if opening.root().to_bech32() != self.contract_root {
            return Err(inv("contract_root does not match the opening".into()));
        }
        if opening.claim_authority != authority
            || opening.claim_recipient != bob
            || opening.recovery_authority != alice
            || opening.recovery_recipient != alice
            || opening.deadline != p.deadline_height
            || opening.rules.max_fee != p.max_fee_micronoid
        {
            return Err(inv("opening policy fields disagree with the parameters".into()));
        }
        // Every gate number comes from the profile the file names (never from a global).
        let g = p.profile.gates();
        g.validate().map_err(|e| inv(e.to_string()))?;
        g.check_caps(p.amount_micronoid, p.eth.amount_wei, p.eth.chain_id).map_err(|e| inv(e.to_string()))?;
        // REVIEW-2 F13: bundle data, so a checked add.
        if p.h_create.checked_add(g.d_offset) != Some(p.deadline_height) {
            return Err(inv(format!(
                "deadline {} != h_create {} + {} (the {} profile's D_offset)",
                p.deadline_height, p.h_create, g.d_offset, g.name
            )));
        }
        if p.lock_by_height != g.bob_lock_by(p.deadline_height) {
            return Err(inv("lock_by_height is not D - RHS(I1)".into()));
        }
        if p.w_a_s != g.w_a_s {
            return Err(inv(format!("W_A {} is not the {} profile's value {}", p.w_a_s, g.name, g.w_a_s)));
        }
        g.check_i5(p.h_create, p.deadline_height).map_err(|e| inv(e.to_string()))?;
        // Checked: a huge max_fee must not wrap around the 1 % rule (T1).
        let hundred_fees = p.max_fee_micronoid.checked_mul(100).ok_or_else(|| inv("max_fee overflows".into()))?;
        let budget = p.amount_micronoid.checked_mul(params::F_MAX_MAX_PERCENT_OF_V).ok_or_else(|| inv("amount overflows".into()))?;
        if hundred_fees > budget {
            return Err(inv("max_fee exceeds 1 % of the amount".into()));
        }
        if p.max_fee_micronoid < params::F_MAX_FLOOR_MICRONOID {
            return Err(inv(format!("max_fee {} is below the F_max floor {} (T5)", p.max_fee_micronoid, params::F_MAX_FLOOR_MICRONOID)));
        }
        if authority == alice {
            return Err(inv("claim authority equals Alice's address (design 6.3 item 3)".into()));
        }
        if self.hashlock == PUBLIC_TEST_VECTOR_HASHLOCK || self.hashlock == ZERO_VECTOR_HASHLOCK {
            return Err(inv("hashlock is a public test vector: its secret is known to everyone".into()));
        }
        if p.eth.amount_wei == 0 || p.eth.alice_receiver == [0u8; 20] || p.eth.bob_sender == [0u8; 20] {
            return Err(inv("eth params incomplete".into()));
        }
        // REVIEW-3 F1: one contract only. The pin must be the code hash compiled into this build (a missing pin included),
        // so a bundle or a file from a counterparty or another build that names a look-alike HTLC is refused here, on
        // `build`, `new-bob` and `load` alike.
        match p.eth.code_hash {
            Some(h) if h == params::HTLC_CODE_HASH => {}
            Some(h) => return Err(inv(other_contract_message("eth.code_hash", &h))),
            None => return Err(inv(format!("eth.code_hash is not pinned; this build pins 0x{} (REVIEW-3 F1)", hex::encode(params::HTLC_CODE_HASH)))),
        }
        if p.eth.alice_receiver == p.eth.bob_sender {
            return Err(inv("A_eth equals B_eth".into()));
        }
        Ok(())
    }

    /// Bob's side of design 6.3 item 2: the terms that are HIS (his payout address,
    /// the amounts, the chain, the contract, his sending address, the variant) must
    /// equal what he agreed off-chain, not what the bundle says.
    pub fn check_bob_terms(&self, terms: &BobTerms) -> Result<(), SwapFileError> {
        let p = &self.params;
        let bad = |what: &str| SwapFileError::Invalid(format!("bundle disagrees with your terms: {what}"));
        if p.variant != terms.variant {
            return Err(bad("variant"));
        }
        if p.profile != terms.profile {
            return Err(SwapFileError::Invalid(format!(
                "bundle disagrees with your terms: the bundle is a {} swap, you asked for {} (--profile); the two profiles use different timeouts and amount caps",
                p.profile, terms.profile
            )));
        }
        if p.contract_version != terms.contract_version {
            return Err(SwapFileError::Invalid(format!(
                "bundle disagrees with your terms: the bundle locks the NOID in contract v{} ({}), you asked for v{} ({}) (--contract-version); \
                 the two contracts have different programs, close fees and addresses",
                p.contract_version,
                p.contract_version.contract_name(),
                terms.contract_version,
                terms.contract_version.contract_name()
            )));
        }
        if p.bob_noid != terms.bob_noid.to_bech32() {
            return Err(bad("bob_noid (your NOID payout address)"));
        }
        if p.amount_micronoid != terms.amount_micronoid {
            return Err(bad("amount_micronoid"));
        }
        if p.eth.chain_id != terms.eth_chain_id {
            return Err(bad("eth.chain_id"));
        }
        if p.eth.contract != terms.eth_contract {
            return Err(bad("eth.contract (pinned HTLC deployment)"));
        }
        // REVIEW-3 F1: Bob's own terms must name the contract compiled into this build, and the bundle must pin the same.
        if terms.eth_code_hash != params::HTLC_CODE_HASH {
            return Err(SwapFileError::Invalid(other_contract_message("your eth.code_hash", &terms.eth_code_hash)));
        }
        if p.eth.code_hash != Some(terms.eth_code_hash) {
            return Err(bad("eth.code_hash (the bundle pins another contract than the HTLC compiled into this build)"));
        }
        if p.eth.amount_wei != terms.eth_amount_wei {
            return Err(bad("eth.amount_wei"));
        }
        if p.eth.bob_sender != terms.bob_sender {
            return Err(bad("eth.bob_sender (your Ethereum address)"));
        }
        Ok(())
    }

    /// SHA-256 of the canonical JSON of this section: what the secret is sealed to.
    pub fn digest(&self) -> [u8; 32] {
        let canonical = serde_json::to_vec(self).expect("SwapPublic serializes");
        sha256(&canonical)
    }

    pub fn authority(&self) -> Result<Address, SwapFileError> {
        Address::parse(&self.claim_authority).map_err(|e| SwapFileError::Invalid(e.to_string()))
    }

    /// The 65-byte journal the equivalence proof commits to: `variant ‖ H ‖ A`
    /// (`equiv/portable::encode_public`). Bob verifies the receipt against his
    /// own image id with `equiv-prove verify`; this is what that command checked.
    pub fn expected_equivalence_journal(&self) -> Result<[u8; 65], SwapFileError> {
        let a = self.authority()?;
        let mut out = [0u8; 65];
        out[0] = self.params.variant.journal_byte();
        out[1..33].copy_from_slice(&self.hashlock);
        out[33..].copy_from_slice(&a.0);
        Ok(out)
    }
}

/// REVIEW-3 F1: the refusal for a code hash other than the one compiled into this build.
pub fn other_contract_message(what: &str, got: &[u8; 32]) -> String {
    format!(
        "{what} 0x{} is not the HTLC code hash compiled into this build, 0x{}: a different value means a different contract, and no option accepts one (REVIEW-3 F1)",
        hex::encode(got),
        hex::encode(params::HTLC_CODE_HASH)
    )
}

/// `SHA-256(00 01 .. 1f)`: the hashlock of the public test vector (design section 0).
pub const PUBLIC_TEST_VECTOR_HASHLOCK: [u8; 32] = [
    0x63, 0x0d, 0xcd, 0x29, 0x66, 0xc4, 0x33, 0x66, 0x91, 0x12, 0x54, 0x48, 0xbb, 0xb2, 0x5b, 0x4f,
    0xf4, 0x12, 0xa4, 0x9c, 0x73, 0x2d, 0xb2, 0xc8, 0xab, 0xc1, 0xb8, 0x58, 0x1b, 0xd7, 0x10, 0xdd,
];
/// `SHA-256(32 zero bytes)`.
pub const ZERO_VECTOR_HASHLOCK: [u8; 32] = [
    0x66, 0x68, 0x7a, 0xad, 0xf8, 0x62, 0xbd, 0x77, 0x6c, 0x8f, 0xc1, 0x8b, 0x8e, 0x9f, 0x8e, 0x20,
    0x08, 0x97, 0x14, 0x85, 0x6e, 0xe2, 0x33, 0xb3, 0x90, 0x2a, 0x59, 0x1d, 0x0d, 0x5f, 0x29, 0x25,
];

/// What Bob agreed off-chain (design step 0), supplied by Bob, never read from the bundle.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct BobTerms {
    pub variant: Variant,
    /// The timing profile Bob expects (`--profile`, default production); the bundle must carry the same one.
    pub profile: ProfileName,
    /// The contract version Bob expects (`--contract-version`, default 1); the bundle must carry the same one.
    pub contract_version: ContractVersion,
    pub bob_noid: Address,
    pub amount_micronoid: u64,
    pub eth_chain_id: u64,
    pub eth_contract: [u8; 20],
    /// REVIEW-3 F1: the keccak256 of the HTLC runtime code, never read from the bundle; it must equal
    /// `params::HTLC_CODE_HASH` (the CLI fills it in when `--eth-code-hash` is omitted).
    pub eth_code_hash: [u8; 32],
    pub eth_amount_wei: u128,
    pub bob_sender: [u8; 20],
}

/// How the equivalence proof was checked (REVIEW-2 F2).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AttestationSource {
    /// `new-bob --receipt P --equiv-prove BIN`: this tool ran `BIN verify <variant> <H> <A> P`
    /// itself, with H and A taken from the bundle, and parsed the image id it printed.
    Receipt,
    /// The fallback: Bob ran `equiv-prove verify` by hand and typed what it checked and printed
    /// (`--equiv-h`, `--equiv-a`, `--equiv-image-id`). The tool believes the values it is given.
    /// (The default, so a file written before F2 loads as `typed`.)
    #[default]
    Typed,
}

/// Bob's record of the equivalence proof check (`equiv-prove verify <variant> <H> <A> <receipt>`,
/// equiv/README.md section 5). With `source = receipt` this tool ran the verifier itself on the
/// receipt file and the values below come from its output; with `source = typed` they are values
/// Bob supplied. Either way the tool checks that what was verified is THIS swap's `(variant, H, A)`
/// and that the image id is the one compiled into this tool (`params::EQUIV_IMAGE_ID`, REVIEW-3 F2). A `typed` attestation is
/// accepted under the `rehearsal` profile only (`check` refuses it elsewhere, so a file written by an older build fails closed). It cannot verify a RISC Zero receipt on its own
/// (that needs the `equiv-host` workspace, i.e. the `equiv-prove` binary).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct EquivalenceAttestation {
    #[serde(default)]
    pub source: AttestationSource,
    /// The 65-byte journal `variant ‖ H ‖ A` that was verified.
    pub journal: Vec<u8>,
    /// The guest image id `equiv-prove verify` printed.
    #[serde(with = "hexbytes")]
    pub image_id: [u8; 32],
    /// The image id pinned in this file; `check` requires it to equal `params::EQUIV_IMAGE_ID` (REVIEW-3 F2).
    #[serde(with = "hexbytes")]
    pub pinned_image_id: [u8; 32],
    /// `receipt` source: the receipt file that was verified, as Bob named it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub receipt_path: Option<String>,
    /// `receipt` source: SHA-256 of that file's bytes at verification time.
    #[serde(default, skip_serializing_if = "Option::is_none", with = "hexbytes_opt")]
    pub receipt_sha256: Option<[u8; 32]>,
    /// `receipt` source: Unix time of the verification.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub verified_at: Option<u64>,
}

impl EquivalenceAttestation {
    /// An attestation of values Bob typed (rehearsal only, REVIEW-3 F2: `check` refuses it under any other profile).
    pub fn typed(journal: Vec<u8>, image_id: [u8; 32], pinned_image_id: [u8; 32]) -> Self {
        Self {
            source: AttestationSource::Typed,
            journal,
            image_id,
            pinned_image_id,
            receipt_path: None,
            receipt_sha256: None,
            verified_at: None,
        }
    }

    pub fn check(&self, public: &SwapPublic) -> Result<(), SwapFileError> {
        let inv = |m: &str| SwapFileError::Invalid(format!("equivalence proof: {m}"));
        if self.source == AttestationSource::Receipt && (self.receipt_path.is_none() || self.verified_at.is_none()) {
            return Err(inv("a receipt attestation must name the receipt file and the verification time"));
        }
        // REVIEW-3 F2: a typed attestation (nothing was verified by this tool) exists for rehearsal only.
        if self.source == AttestationSource::Typed && public.params.profile != ProfileName::Rehearsal {
            return Err(inv(&format!(
                "a typed attestation is accepted only under the rehearsal profile, not {}: the receipt must be verified by this tool (--receipt FILE --equiv-prove BIN)",
                public.params.profile
            )));
        }
        // REVIEW-3 F2: the pinned image id is the one compiled into this tool; a file pinning another id is refused.
        if self.pinned_image_id != params::EQUIV_IMAGE_ID {
            return Err(inv(&format!(
                "the pinned image id {} is not the one compiled into this tool ({}): refusing",
                hex::encode(self.pinned_image_id),
                hex::encode(params::EQUIV_IMAGE_ID)
            )));
        }
        if self.image_id != self.pinned_image_id {
            return Err(inv("the receipt was verified against an image id that is not the pinned one (T10)"));
        }
        if self.journal.as_slice() != public.expected_equivalence_journal()?.as_slice() {
            return Err(inv("the verified journal is not variant || H || A of this bundle"));
        }
        Ok(())
    }
}

// ---------------------------------------------------------------- secret at rest

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct KdfParams {
    pub algorithm: String,
    pub m_cost_kib: u32,
    pub t_cost: u32,
    pub p_cost: u32,
}

impl KdfParams {
    /// 64 MiB, 3 passes: the default for real swap files.
    pub fn default_strong() -> Self {
        Self { algorithm: "argon2id".into(), m_cost_kib: 65_536, t_cost: 3, p_cost: 1 }
    }

    /// 8 MiB, 1 pass: tests only (REVIEW-2 F14: compiled only under `cfg(test)` or the `dev` feature,
    /// so a release binary has no way to ask for it).
    #[cfg(any(test, feature = "dev"))]
    pub fn fast_for_tests() -> Self {
        Self { algorithm: "argon2id".into(), m_cost_kib: 8_192, t_cost: 1, p_cost: 1 }
    }

    /// REVIEW-2 F14: the cost is read from a file, so it is bounded before it is used. The strong
    /// default (64 MiB, t=3, p=1) is far inside these limits; a crafted file cannot ask for gigabytes.
    pub const MAX_M_COST_KIB: u32 = 524_288;
    pub const MAX_T_COST: u32 = 16;
    pub const MAX_P_COST: u32 = 8;

    pub fn check_bounds(&self) -> Result<(), SwapFileError> {
        if self.algorithm != "argon2id" {
            return Err(SwapFileError::Crypto(format!("unknown kdf {}", self.algorithm)));
        }
        if self.m_cost_kib > Self::MAX_M_COST_KIB || self.t_cost > Self::MAX_T_COST || self.p_cost > Self::MAX_P_COST {
            return Err(SwapFileError::Invalid(format!(
                "kdf cost out of bounds (m={} KiB, t={}, p={}; limits {} KiB, {}, {})",
                self.m_cost_kib, self.t_cost, self.p_cost, Self::MAX_M_COST_KIB, Self::MAX_T_COST, Self::MAX_P_COST
            )));
        }
        Ok(())
    }

    fn derive(&self, pass: &Passphrase, salt: &[u8; 16]) -> Result<Zeroizing<[u8; 32]>, SwapFileError> {
        self.check_bounds()?;
        let p = Params::new(self.m_cost_kib, self.t_cost, self.p_cost, Some(32))
            .map_err(|e| SwapFileError::Crypto(e.to_string()))?;
        let argon = Argon2::new(Algorithm::Argon2id, Version::V0x13, p);
        let mut key = Zeroizing::new([0u8; 32]);
        argon
            .hash_password_into(pass.0.as_bytes(), salt, &mut *key)
            .map_err(|e| SwapFileError::Crypto(e.to_string()))?;
        Ok(key)
    }
}

/// The sealed secret.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct EncryptedSecret {
    pub kdf: KdfParams,
    #[serde(with = "hexbytes")]
    pub salt: [u8; 16],
    #[serde(with = "hexbytes")]
    pub nonce: [u8; 24],
    /// 32 bytes of secret + 16-byte tag, hex.
    pub ciphertext: String,
    /// `SwapPublic::digest()` at sealing time.
    #[serde(with = "hexbytes")]
    pub sealed_to: [u8; 32],
}

/// A passphrase, zeroized on drop.
pub struct Passphrase(Zeroizing<String>);

impl Passphrase {
    pub fn new(text: impl Into<String>) -> Self {
        Self(Zeroizing::new(text.into()))
    }
}

impl fmt::Debug for Passphrase {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("Passphrase(<redacted>)")
    }
}

fn aad(public_digest: &[u8; 32]) -> Vec<u8> {
    let mut v = AAD_DOMAIN.to_vec();
    v.extend_from_slice(public_digest);
    v
}

impl EncryptedSecret {
    pub fn seal(
        secret: &Secret,
        pass: &Passphrase,
        kdf: &KdfParams,
        public_digest: [u8; 32],
    ) -> Result<Self, SwapFileError> {
        let mut salt = [0u8; 16];
        let mut nonce = [0u8; 24];
        getrandom::getrandom(&mut salt).map_err(|e| SwapFileError::Crypto(e.to_string()))?;
        getrandom::getrandom(&mut nonce).map_err(|e| SwapFileError::Crypto(e.to_string()))?;
        let key = kdf.derive(pass, &salt)?;
        let cipher = XChaCha20Poly1305::new(Key::from_slice(&*key));
        let ct = cipher
            .encrypt(XNonce::from_slice(&nonce), Payload { msg: secret.bytes(), aad: &aad(&public_digest) })
            .map_err(|e| SwapFileError::Crypto(e.to_string()))?;
        Ok(Self { kdf: kdf.clone(), salt, nonce, ciphertext: hex::encode(ct), sealed_to: public_digest })
    }

    pub fn open(&self, pass: &Passphrase, public_digest: [u8; 32]) -> Result<Secret, SwapFileError> {
        if self.sealed_to != public_digest {
            return Err(SwapFileError::PublicSectionModified);
        }
        let ct = hex::decode(&self.ciphertext).map_err(|e| SwapFileError::Crypto(e.to_string()))?;
        let key = self.kdf.derive(pass, &self.salt)?;
        let cipher = XChaCha20Poly1305::new(Key::from_slice(&*key));
        let pt = cipher
            .decrypt(XNonce::from_slice(&self.nonce), Payload { msg: &ct, aad: &aad(&public_digest) })
            .map_err(|_| SwapFileError::WrongPassphrase)?;
        let pt = Zeroizing::new(pt);
        let bytes: [u8; 32] = pt
            .as_slice()
            .try_into()
            .map_err(|_| SwapFileError::Crypto("decrypted secret is not 32 bytes".into()))?;
        Ok(Secret::from_bytes(bytes))
    }
}

// ---------------------------------------------------------------- the file

/// An action the engine decided on, recorded before it is performed so a
/// restart can tell "about to do X" from "never considered X".
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct PendingAction {
    pub kind: String,
    pub created_at: u64,
    pub attempt: u32,
    /// Whether the action may have reached a chain (unknown outcome). Missing in
    /// an older file means "assume yes", the safe reading.
    #[serde(default = "default_true")]
    pub maybe_sent: bool,
    #[serde(default)]
    pub detail: Value,
}

/// REVIEW-2 F3: the intent ledger. When `tick --apply` decides on a spending action
/// (`fund_noid`, `lock_eth`, `reveal_eth`, `refund_eth`, `refund_noid`) it writes this record
/// BEFORE printing the action. The operator sends the action outside this tool, so the record is
/// the only memory that "this was already decided": while it is pending and the chain does not
/// show its effect, `tick` answers `wait` with these frozen parameters and never emits the same
/// action again (a second lock or a second funding is a second loss).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct PendingIntent {
    /// The action kind (`lock_eth`, ...).
    pub action: String,
    /// The whole action as `tick` printed it (what the operator must use: lock id, amounts,
    /// `T_reveal`, call height, fee ...).
    pub params: Value,
    /// Unix time of the decision.
    pub decided_at: u64,
    /// The phase name when it was decided (after that tick's own events); a different phase
    /// later means the chain showed the effect or something that supersedes it.
    pub phase_at_decision: String,
    /// Parano1d tip and Ethereum block observed at the decision.
    pub noid_tip: u64,
    pub eth_block: u64,
}

fn default_true() -> bool {
    true
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct HistoryEntry {
    pub at: u64,
    pub event: String,
    pub from: String,
    pub to: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct SwapFile {
    pub version: u32,
    pub role: Role,
    pub created_at: u64,
    pub public: SwapPublic,
    pub phase: Phase,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pending_action: Option<PendingAction>,
    /// REVIEW-2 F3: the spending action `tick --apply` decided on and printed, until the chain shows it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pending_intent: Option<PendingIntent>,
    /// REVIEW-3 F7: the first block `eth_getLogs` searches (the HTLC deployment block, or any block before this swap
    /// started). Given once with `--eth-from-block`, stored by `tick --apply` / `claim --submit`, then used without the flag.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub eth_from_block: Option<u64>,
    #[serde(default)]
    pub history: Vec<HistoryEntry>,
    /// Alice only.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub secret: Option<EncryptedSecret>,
    /// Bob only: what equivalence proof was verified before this file was created.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub equivalence: Option<EquivalenceAttestation>,
}

impl SwapFile {
    /// Alice's file: the secret is checked against the public section, then sealed.
    pub fn new_alice(
        public: SwapPublic,
        secret: &Secret,
        pass: &Passphrase,
        kdf: &KdfParams,
        now: u64,
    ) -> Result<Self, SwapFileError> {
        public.check()?;
        if secret.is_public_test_vector() {
            return Err(SwapFileError::PublicTestVector);
        }
        if secret.hashlock() != public.hashlock
            || secret.authority(public.params.variant).to_bech32() != public.claim_authority
        {
            return Err(SwapFileError::SecretMismatch);
        }
        let sealed = EncryptedSecret::seal(secret, pass, kdf, public.digest())?;
        Ok(Self {
            version: SWAP_FILE_VERSION,
            role: Role::Alice,
            created_at: now,
            public,
            phase: Phase::Alice(crate::state::AlicePhase::Created),
            pending_action: None,
            pending_intent: None,
            eth_from_block: None,
            history: Vec::new(),
            secret: Some(sealed),
            equivalence: None,
        })
    }

    /// Bob's file: no secret. The bundle must pass the structural checks, agree
    /// with Bob's own terms, and the equivalence proof must have been verified
    /// for exactly this bundle (design step 5, section 6.3).
    pub fn new_bob(
        public: SwapPublic,
        terms: &BobTerms,
        equivalence: &EquivalenceAttestation,
        now: u64,
    ) -> Result<Self, SwapFileError> {
        public.check()?;
        public.check_bob_terms(terms)?;
        equivalence.check(&public)?;
        Ok(Self {
            version: SWAP_FILE_VERSION,
            role: Role::Bob,
            created_at: now,
            public,
            phase: Phase::Bob(crate::state::BobPhase::Received),
            pending_action: None,
            pending_intent: None,
            eth_from_block: None,
            history: Vec::new(),
            secret: None,
            equivalence: Some(equivalence.clone()),
        })
    }

    /// `dir/<first 16 hex of the hashlock>.swap.json`.
    pub fn path_for(dir: &Path, hashlock: &[u8; 32]) -> PathBuf {
        dir.join(format!("{}{}", &hex::encode(hashlock)[..16], SWAP_FILE_SUFFIX))
    }

    /// Atomic replace: write a uniquely named temporary file (`<path>.<pid>.<random>.tmp`, created
    /// new, so two writers can never share one), fsync, rename over `path`. REVIEW-2 F8.
    pub fn save(&self, path: &Path) -> Result<(), SwapFileError> {
        let text = serde_json::to_vec_pretty(self).map_err(|e| SwapFileError::Json(e.to_string()))?;
        let tmp = tmp_path(path)?;
        let written = (|| -> Result<(), SwapFileError> {
            let mut opts = std::fs::OpenOptions::new();
            opts.write(true).create_new(true);
            #[cfg(unix)]
            {
                use std::os::unix::fs::OpenOptionsExt as _;
                opts.mode(0o600);
            }
            let mut f = opts.open(&tmp).map_err(io_err)?;
            f.write_all(&text).map_err(io_err)?;
            f.sync_all().map_err(io_err)?;
            Ok(())
        })();
        if let Err(e) = written.and_then(|()| std::fs::rename(&tmp, path).map_err(io_err)) {
            let _ = std::fs::remove_file(&tmp);
            return Err(e);
        }
        #[cfg(unix)]
        if let Some(dir) = path.parent() {
            if let Ok(d) = std::fs::File::open(dir) {
                let _ = d.sync_all();
            }
        }
        Ok(())
    }

    pub fn load(path: &Path) -> Result<Self, SwapFileError> {
        let text = std::fs::read(path).map_err(io_err)?;
        let file: SwapFile = serde_json::from_slice(&text).map_err(|e| SwapFileError::Json(e.to_string()))?;
        if file.version != SWAP_FILE_VERSION {
            return Err(SwapFileError::Version(file.version));
        }
        if file.phase.role() != file.role {
            return Err(SwapFileError::Invalid("phase role does not match file role".into()));
        }
        file.public.check()?;
        if let Some(sealed) = &file.secret {
            sealed.kdf.check_bounds()?;
        }
        if file.role == Role::Bob {
            match &file.equivalence {
                Some(att) => att.check(&file.public)?,
                None => return Err(SwapFileError::Invalid("Bob's file has no equivalence attestation".into())),
            }
        }
        Ok(file)
    }

    pub fn decrypt_secret(&self, pass: &Passphrase) -> Result<Secret, SwapFileError> {
        let sealed = self.secret.as_ref().ok_or(SwapFileError::NoSecret)?;
        let secret = sealed.open(pass, self.public.digest())?;
        if secret.hashlock() != self.public.hashlock {
            return Err(SwapFileError::SecretMismatch);
        }
        Ok(secret)
    }

    /// Apply one event and append it to the history.
    pub fn apply(&mut self, event: &Event, now: u64) -> Result<(), InvalidTransition> {
        let next = transition(&self.phase, event)?;
        self.history.push(HistoryEntry {
            at: now,
            event: event.name(),
            from: self.phase.name(),
            to: next.name(),
        });
        self.phase = next;
        Ok(())
    }

    /// REVIEW-3 F7: remember `block` as the log-scan start. Returns `true` (and logs `eth_from_block_set:N`) only if it changed.
    pub fn set_eth_from_block(&mut self, block: u64, now: u64) -> bool {
        if self.eth_from_block == Some(block) {
            return false;
        }
        self.eth_from_block = Some(block);
        self.log(format!("eth_from_block_set:{block}"), now);
        true
    }

    pub fn set_pending(&mut self, action: PendingAction) {
        self.pending_action = Some(action);
    }

    pub fn clear_pending(&mut self) {
        self.pending_action = None;
    }

    /// Append a log-only history entry (no phase change), e.g. `intent_decided:lock_eth`.
    pub fn log(&mut self, event: impl Into<String>, now: u64) {
        let name = self.phase.name();
        self.history.push(HistoryEntry { at: now, event: event.into(), from: name.clone(), to: name });
    }
}

/// `<path>.<pid>.<8 random hex>.tmp`: unique per writer (REVIEW-2 F8).
fn tmp_path(path: &Path) -> Result<PathBuf, SwapFileError> {
    let mut rnd = [0u8; 4];
    getrandom::getrandom(&mut rnd).map_err(|e| SwapFileError::Crypto(e.to_string()))?;
    let mut s = path.as_os_str().to_os_string();
    s.push(format!(".{}.{}.tmp", std::process::id(), hex::encode(rnd)));
    Ok(PathBuf::from(s))
}

/// An exclusive advisory lock on one swap file for the duration of a command (REVIEW-2 F8):
/// `<swap file>.lock` is opened (created if needed) and locked with the operating system's
/// file lock (`File::try_lock`: `flock` on Unix, `LockFileEx` on Windows). The lock dies with
/// the process, so a crash leaves no stale lock; the `.lock` file itself is harmless and stays.
/// Taken by every command that may save the file (`tick --apply`, `claim`, `intent --cancel`).
#[derive(Debug)]
pub struct SwapLock {
    _file: std::fs::File,
    path: PathBuf,
}

impl SwapLock {
    /// Wait up to `wait` for the lock, then fail with a plain message.
    pub fn acquire(swap_file: &Path, wait: std::time::Duration) -> Result<Self, SwapFileError> {
        let mut s = swap_file.as_os_str().to_os_string();
        s.push(".lock");
        let path = PathBuf::from(s);
        let file = std::fs::OpenOptions::new().read(true).write(true).create(true).truncate(false).open(&path).map_err(io_err)?;
        let start = std::time::Instant::now();
        loop {
            match file.try_lock() {
                Ok(()) => return Ok(Self { _file: file, path }),
                Err(std::fs::TryLockError::WouldBlock) => {
                    if start.elapsed() >= wait {
                        return Err(SwapFileError::Io(format!(
                            "{} is in use by another swap-cli command (lock file {}); wait for it to finish, then run this again",
                            swap_file.display(),
                            path.display()
                        )));
                    }
                    std::thread::sleep(std::time::Duration::from_millis(100));
                }
                Err(std::fs::TryLockError::Error(e)) => return Err(io_err(e)),
            }
        }
    }

    pub fn path(&self) -> &Path {
        &self.path
    }
}

/// `try_compile_htlc` (v1) or `try_compile_htlc_v2` (v2) with a panic turned into an error (REVIEW-2 F13).
/// The harness (outside this crate) still has an `expect` on the Pruv compile; parameters here come from a
/// bundle, so a panic there must never take the tool down mid-command.
fn compile_guarded(
    version: ContractVersion,
    hashlock: Address,
    receiver: Address,
    sender: Address,
    deadline: u64,
    max_fee: u64,
) -> Result<ObjectOpening, SwapFileError> {
    let r = std::panic::catch_unwind(|| match version {
        ContractVersion::V1 => htlc_harness::try_compile_htlc(hashlock, receiver, sender, deadline, max_fee),
        ContractVersion::V2 => htlc_harness::try_compile_htlc_v2(hashlock, receiver, sender, deadline, max_fee),
    });
    match r {
        Ok(Ok(opening)) => Ok(opening),
        Ok(Err(e)) => Err(SwapFileError::Invalid(format!("tool guard: {e}"))),
        Err(_) => Err(SwapFileError::Invalid("the contract compiler panicked on these parameters".into())),
    }
}

/// Which of the two contracts `opening` is: rebuilt from its own policy fields (claim authority, claim
/// recipient, recovery authority, deadline, `max_fee`) with each version's program and compared whole.
/// `None` when it is neither (a foreign program, or a policy that does not fit the swap shape). The
/// client builders use this so that a caller who hands them a bare opening still gets the right fee rule.
pub fn detect_contract_version(opening: &ObjectOpening) -> Option<ContractVersion> {
    [ContractVersion::V1, ContractVersion::V2].into_iter().find(|v| {
        opening.recovery_recipient == opening.recovery_authority
            && compile_guarded(*v, opening.claim_authority, opening.claim_recipient, opening.recovery_authority, opening.deadline, opening.rules.max_fee)
                .is_ok_and(|rebuilt| &rebuilt == opening)
    })
}

/// T9: a per-machine registry of hashlocks already used, so a secret is never
/// reused across swaps. One hex hashlock per line.
pub struct HashlockRegistry {
    path: PathBuf,
}

impl HashlockRegistry {
    pub fn new(path: PathBuf) -> Self {
        Self { path }
    }

    pub fn contains(&self, hashlock: &[u8; 32]) -> Result<bool, SwapFileError> {
        let h = hex::encode(hashlock);
        match std::fs::read_to_string(&self.path) {
            Ok(text) => Ok(text.lines().any(|l| l.trim() == h)),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(false),
            Err(e) => Err(io_err(e)),
        }
    }

    /// Record `hashlock`; refuse if it was already recorded.
    pub fn register(&self, hashlock: &[u8; 32]) -> Result<(), SwapFileError> {
        if self.contains(hashlock)? {
            return Err(SwapFileError::HashlockReused);
        }
        let mut f = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&self.path)
            .map_err(io_err)?;
        writeln!(f, "{}", hex::encode(hashlock)).map_err(io_err)?;
        f.sync_all().map_err(io_err)?;
        Ok(())
    }
}

// ---------------------------------------------------------------- test support

/// A complete, guard-passing public section for tests: fresh secret, Alice
/// and Bob addresses from the harness cast, `h_create` after the trial start.
pub fn example_public(secret: &Secret, variant: Variant) -> SwapPublic {
    example_public_with(secret, variant, ProfileName::Production)
}

/// [`example_public`] under a named profile. The rehearsal one runs on chain id 31337 (the only chain
/// that profile allows), production and sepolia on 11155111 (the only chain the sepolia profile allows); all use
/// 10 NOID and 0.01 ETH, which the caps accept.
pub fn example_public_with(secret: &Secret, variant: Variant, profile: ProfileName) -> SwapPublic {
    let cast = htlc_harness::Cast::new();
    SwapPublic::build_with_profile(
        secret,
        variant,
        profile,
        &cast.alice,
        &cast.bob,
        10_000_000,
        5_800,
        300_000,
        EthParams {
            chain_id: if profile == ProfileName::Rehearsal { 31_337 } else { 11_155_111 },
            contract: [0x11; 20],
            code_hash: Some(params::HTLC_CODE_HASH),
            amount_wei: 10u128.pow(16),
            alice_receiver: [0xa1; 20],
            bob_sender: [0xb0; 20],
        },
    )
    .expect("example public section builds")
}

/// [`example_public_with`] for a given contract version (production profile unless `profile` says otherwise).
pub fn example_public_v(secret: &Secret, variant: Variant, contract_version: ContractVersion) -> SwapPublic {
    example_public_opts(secret, variant, ProfileName::Production, contract_version)
}

/// [`example_public`] under a named profile and contract version.
pub fn example_public_opts(secret: &Secret, variant: Variant, profile: ProfileName, contract_version: ContractVersion) -> SwapPublic {
    let cast = htlc_harness::Cast::new();
    SwapPublic::build_with_options(
        secret,
        variant,
        profile,
        contract_version,
        &cast.alice,
        &cast.bob,
        10_000_000,
        5_800,
        300_000,
        EthParams {
            chain_id: if profile == ProfileName::Rehearsal { 31_337 } else { 11_155_111 },
            contract: [0x11; 20],
            code_hash: Some(params::HTLC_CODE_HASH),
            amount_wei: 10u128.pow(16),
            alice_receiver: [0xa1; 20],
            bob_sender: [0xb0; 20],
        },
    )
    .expect("example public section builds")
}

/// Bob's terms matching [`example_public`].
pub fn example_bob_terms(public: &SwapPublic) -> BobTerms {
    BobTerms {
        variant: public.params.variant,
        profile: public.params.profile,
        contract_version: public.params.contract_version,
        bob_noid: Address::parse(&public.params.bob_noid).expect("bob address"),
        amount_micronoid: public.params.amount_micronoid,
        eth_chain_id: public.params.eth.chain_id,
        eth_contract: public.params.eth.contract,
        eth_code_hash: public.params.eth.code_hash.expect("example_public pins a code hash"),
        eth_amount_wei: public.params.eth.amount_wei,
        bob_sender: public.params.eth.bob_sender,
    }
}

/// An attestation that matches [`example_public`] (tests only: no receipt was really verified; it is shaped like the
/// `receipt` one so it passes `check` under every profile, REVIEW-3 F2).
pub fn example_attestation(public: &SwapPublic) -> EquivalenceAttestation {
    let journal = public.expected_equivalence_journal().expect("journal").to_vec();
    EquivalenceAttestation {
        source: AttestationSource::Receipt,
        journal,
        image_id: params::EQUIV_IMAGE_ID,
        pinned_image_id: params::EQUIV_IMAGE_ID,
        receipt_path: Some("example.receipt".into()),
        receipt_sha256: Some([0x5a; 32]),
        verified_at: Some(1_794_312_000),
    }
}

/// Bob's file for tests: terms and attestation derived from the bundle itself.
pub fn example_bob_file(public: SwapPublic, now: u64) -> Result<SwapFile, SwapFileError> {
    let terms = example_bob_terms(&public);
    let att = example_attestation(&public);
    SwapFile::new_bob(public, &terms, &att, now)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::state::{AlicePhase, BobPhase};
    use crate::watch::NoidInstance;

    fn fresh() -> Secret {
        Secret::generate().unwrap()
    }

    #[test]
    fn build_and_check_public_section() {
        let s = fresh();
        let p = example_public(&s, Variant::Raw);
        assert_eq!(p.params.deadline_height, 300_725);
        assert_eq!(p.params.lock_by_height, 300_106);
        assert_eq!(p.params.max_fee_micronoid, 50_000);
        assert_eq!(p.opening_hex.len(), 2 * noid_tx::experimental_object::OPENING_BYTES);
        assert_eq!(p.claim_authority, s.authority(Variant::Raw).to_bech32());
        assert_eq!(p.check(), Ok(()));
        // Stock variant: the authority is Addr(Derive(m, 0)).
        let ps = example_public(&s, Variant::Stock);
        assert_eq!(ps.claim_authority, s.authority(Variant::Stock).to_bech32());
        assert_ne!(ps.opening_hex, p.opening_hex);
        // Tampering with a committed field is caught by the byte-for-byte rebuild.
        let mut bad = p.clone();
        bad.params.max_fee_micronoid = 60_000;
        assert!(matches!(bad.check(), Err(SwapFileError::Invalid(_))));
        let mut bad = p.clone();
        bad.params.bob_noid = p.params.alice_noid.clone();
        assert!(matches!(bad.check(), Err(SwapFileError::Invalid(_))));
        // The public test vector is refused at build time.
        let cast = htlc_harness::Cast::new();
        let r = SwapPublic::build(
            &Secret::from_bytes(htlc_harness::seq_bytes(0)),
            Variant::Raw,
            &cast.alice,
            &cast.bob,
            10_000_000,
            5_800,
            300_000,
            p.params.eth.clone(),
        );
        assert_eq!(r.unwrap_err(), SwapFileError::PublicTestVector);
        // A creation height before the trial start is refused (I5).
        let r = SwapPublic::build(&s, Variant::Raw, &cast.alice, &cast.bob, 10_000_000, 5_800, 279_000, p.params.eth.clone());
        assert!(matches!(r, Err(SwapFileError::Invalid(_))));
    }

    #[test]
    fn secret_seals_and_opens_only_with_the_right_passphrase_and_public_section() {
        let s = fresh();
        let p = example_public(&s, Variant::Raw);
        let pass = Passphrase::new("correct horse");
        let kdf = KdfParams::fast_for_tests();
        let file = SwapFile::new_alice(p.clone(), &s, &pass, &kdf, 1).unwrap();
        assert_eq!(file.decrypt_secret(&pass).unwrap(), s);
        assert_eq!(file.decrypt_secret(&Passphrase::new("wrong")).unwrap_err(), SwapFileError::WrongPassphrase);
        // A different (valid) public section under the same ciphertext is refused.
        let mut swapped = file.clone();
        swapped.public = example_public(&fresh(), Variant::Raw);
        assert_eq!(swapped.decrypt_secret(&pass).unwrap_err(), SwapFileError::PublicSectionModified);
        // A flipped ciphertext byte fails authentication.
        let mut tampered = file.clone();
        let sealed = tampered.secret.as_mut().unwrap();
        let mut ct = hex::decode(&sealed.ciphertext).unwrap();
        ct[3] ^= 1;
        sealed.ciphertext = hex::encode(ct);
        assert_eq!(tampered.decrypt_secret(&pass).unwrap_err(), SwapFileError::WrongPassphrase);
        // The wrong secret for this public section is refused at creation.
        let other = fresh();
        assert_eq!(
            SwapFile::new_alice(p, &other, &pass, &kdf, 1).unwrap_err(),
            SwapFileError::SecretMismatch
        );
        // The file text never contains the secret in clear.
        let text = serde_json::to_string(&file).unwrap();
        assert!(!text.contains(&hex::encode(s.bytes())));
    }

    #[test]
    fn save_is_atomic_and_load_round_trips() {
        let dir = tempfile::tempdir().unwrap();
        let s = fresh();
        let p = example_public(&s, Variant::Raw);
        let pass = Passphrase::new("pw");
        let mut file = SwapFile::new_alice(p, &s, &pass, &KdfParams::fast_for_tests(), 1).unwrap();
        let path = SwapFile::path_for(dir.path(), &file.public.hashlock);
        assert!(path.to_string_lossy().ends_with(".swap.json"));
        file.save(&path).unwrap();
        let leftovers = std::fs::read_dir(dir.path()).unwrap().filter_map(|e| e.ok()).filter(|e| e.file_name().to_string_lossy().ends_with(".tmp")).count();
        assert_eq!(leftovers, 0, "no temp file left behind");
        let loaded = SwapFile::load(&path).unwrap();
        assert_eq!(loaded, file);
        assert_eq!(loaded.decrypt_secret(&pass).unwrap(), s);
        // Phase changes are persisted with their history.
        let inst = NoidInstance { slot_index: 1, creation_id: 1, amount_micronoid: 10_000_000 };
        file.apply(&Event::NoidInstanceSeen { instance: inst.clone(), tip: 300_005 }, 2).unwrap();
        file.set_pending(PendingAction { kind: "wait".into(), created_at: 2, attempt: 1, maybe_sent: true, detail: Value::Null });
        file.save(&path).unwrap();
        let loaded = SwapFile::load(&path).unwrap();
        assert_eq!(loaded.phase, Phase::Alice(AlicePhase::Funded { instance: inst, seen_at_tip: 300_005 }));
        assert_eq!(loaded.history.len(), 1);
        assert_eq!(loaded.history[0].to, "funded");
        assert_eq!(loaded.pending_action.as_ref().unwrap().kind, "wait");
        // An unsupported version is refused.
        let mut v = serde_json::to_value(&loaded).unwrap();
        v["version"] = Value::from(99);
        std::fs::write(&path, serde_json::to_vec(&v).unwrap()).unwrap();
        assert_eq!(SwapFile::load(&path).unwrap_err(), SwapFileError::Version(99));
    }

    #[test]
    fn bob_file_has_no_secret_and_checks_the_bundle() {
        let s = fresh();
        let p = example_public(&s, Variant::Raw);
        let file = example_bob_file(p.clone(), 5).unwrap();
        assert_eq!(file.phase, Phase::Bob(BobPhase::Received));
        assert_eq!(file.decrypt_secret(&Passphrase::new("x")).unwrap_err(), SwapFileError::NoSecret);
        assert!(file.equivalence.is_some());
        let mut bad = p.clone();
        bad.contract_root = "o1qqqq".into();
        assert!(matches!(example_bob_file(bad, 5), Err(SwapFileError::Invalid(_))));
        // A file saved without the attestation is refused on load.
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("b.swap.json");
        let mut stripped = file.clone();
        stripped.equivalence = None;
        stripped.save(&path).unwrap();
        assert!(matches!(SwapFile::load(&path), Err(SwapFileError::Invalid(_))));
    }

    #[test]
    fn bob_refuses_a_bundle_that_disagrees_with_his_terms() {
        let s = fresh();
        let p = example_public(&s, Variant::Raw);
        let att = example_attestation(&p);
        let ok = example_bob_terms(&p);
        assert!(SwapFile::new_bob(p.clone(), &ok, &att, 1).is_ok());
        // Alice swapped the payout address for her own: the bundle is self-consistent but not Bob's deal.
        let cast = htlc_harness::Cast::new();
        let mut terms = ok.clone();
        terms.bob_noid = cast.alice;
        assert!(matches!(SwapFile::new_bob(p.clone(), &terms, &att, 1), Err(SwapFileError::Invalid(m)) if m.contains("bob_noid")));
        let mut terms = ok.clone();
        terms.eth_amount_wei += 1;
        assert!(matches!(SwapFile::new_bob(p.clone(), &terms, &att, 1), Err(SwapFileError::Invalid(m)) if m.contains("amount_wei")));
        let mut terms = ok.clone();
        terms.eth_contract = [0xdd; 20];
        assert!(matches!(SwapFile::new_bob(p.clone(), &terms, &att, 1), Err(SwapFileError::Invalid(m)) if m.contains("contract")));
        let mut terms = ok.clone();
        terms.bob_sender = [0xdd; 20];
        assert!(matches!(SwapFile::new_bob(p.clone(), &terms, &att, 1), Err(SwapFileError::Invalid(m)) if m.contains("bob_sender")));
        let mut terms = ok.clone();
        terms.variant = Variant::Stock;
        assert!(matches!(SwapFile::new_bob(p.clone(), &terms, &att, 1), Err(SwapFileError::Invalid(m)) if m.contains("variant")));
        let mut terms = ok.clone();
        terms.eth_chain_id = 1;
        assert!(matches!(SwapFile::new_bob(p.clone(), &terms, &att, 1), Err(SwapFileError::Invalid(m)) if m.contains("chain_id")));
        // The equivalence attestation must be for THIS bundle and the pinned image id.
        let mut wrong_journal = att.clone();
        wrong_journal.journal[1] ^= 1;
        assert!(matches!(SwapFile::new_bob(p.clone(), &ok, &wrong_journal, 1), Err(SwapFileError::Invalid(m)) if m.contains("journal")));
        let mut wrong_image = att.clone();
        wrong_image.image_id = [0x11; 32];
        assert!(matches!(SwapFile::new_bob(p.clone(), &ok, &wrong_image, 1), Err(SwapFileError::Invalid(m)) if m.contains("image id")));
        // The journal is variant || H || A.
        let j = p.expected_equivalence_journal().unwrap();
        assert_eq!(j[0], 0);
        assert_eq!(&j[1..33], &p.hashlock);
        assert_eq!(&j[33..], &p.authority().unwrap().0);
    }


    #[test]
    fn check_refuses_a_typed_attestation_outside_rehearsal_and_a_pin_that_is_not_the_constant() {
        // REVIEW-3 F2.
        for profile in [ProfileName::Production, ProfileName::Sepolia, ProfileName::Rehearsal] {
            let p = example_public_with(&fresh(), Variant::Raw, profile);
            let journal = p.expected_equivalence_journal().unwrap().to_vec();
            let typed = EquivalenceAttestation::typed(journal, params::EQUIV_IMAGE_ID, params::EQUIV_IMAGE_ID);
            match profile {
                ProfileName::Rehearsal => typed.check(&p).unwrap(),
                _ => assert!(
                    matches!(typed.check(&p), Err(SwapFileError::Invalid(m)) if m.contains("rehearsal profile") && m.contains("--receipt")),
                    "{profile}"
                ),
            }
            // The receipt-shaped example passes under every profile, with the constant image id.
            let receipt = example_attestation(&p);
            assert_eq!(receipt.pinned_image_id, params::EQUIV_IMAGE_ID);
            receipt.check(&p).unwrap();
            // A pin that is not the constant is refused even when image_id == pinned (a file from another build).
            let mut other = receipt.clone();
            other.image_id = [0x11; 32];
            other.pinned_image_id = [0x11; 32];
            assert!(
                matches!(other.check(&p), Err(SwapFileError::Invalid(m)) if m.contains("pinned image id") && m.contains("compiled into this tool")),
                "{profile}"
            );
            // ... and so is `new_bob` and a Bob file on disk carrying it.
            assert!(SwapFile::new_bob(p.clone(), &example_bob_terms(&p), &other, 1).is_err());
        }
    }

    #[test]
    fn load_refuses_a_bob_file_with_a_typed_attestation_outside_rehearsal() {
        // REVIEW-3 F2: a file written by an older build (typed, production) fails closed on load.
        let dir = tempfile::tempdir().unwrap();
        let p = example_public(&fresh(), Variant::Raw);
        let mut file = example_bob_file(p.clone(), 5).unwrap();
        file.equivalence = Some(EquivalenceAttestation::typed(
            p.expected_equivalence_journal().unwrap().to_vec(),
            params::EQUIV_IMAGE_ID,
            params::EQUIV_IMAGE_ID,
        ));
        let path = dir.path().join("old.swap.json");
        file.save(&path).unwrap();
        assert!(matches!(SwapFile::load(&path), Err(SwapFileError::Invalid(m)) if m.contains("rehearsal profile")));
        // The same file under the 7e..7e pin of the old tests is refused for its pin too.
        file.equivalence = Some(example_attestation(&p));
        file.equivalence.as_mut().unwrap().image_id = [0x7e; 32];
        file.equivalence.as_mut().unwrap().pinned_image_id = [0x7e; 32];
        file.save(&path).unwrap();
        assert!(matches!(SwapFile::load(&path), Err(SwapFileError::Invalid(m)) if m.contains("compiled into this tool")));
    }
    #[test]
    fn check_refuses_test_vector_hashlocks_and_fee_overflow() {
        let s = fresh();
        let mut p = example_public(&s, Variant::Raw);
        p.hashlock = PUBLIC_TEST_VECTOR_HASHLOCK;
        assert!(matches!(p.check(), Err(SwapFileError::Invalid(m)) if m.contains("test vector")));
        let mut p = example_public(&s, Variant::Raw);
        p.params.max_fee_micronoid = u64::MAX / 100 + 1;
        assert!(matches!(p.check(), Err(SwapFileError::Invalid(_))));
    }


    #[test]
    fn swap_lock_is_exclusive_and_temp_names_are_unique() {
        // REVIEW-2 F8.
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("x.swap.json");
        let first = SwapLock::acquire(&path, std::time::Duration::from_millis(0)).unwrap();
        let err = SwapLock::acquire(&path, std::time::Duration::from_millis(200)).unwrap_err();
        assert!(matches!(&err, SwapFileError::Io(m) if m.contains("in use by another swap-cli command")), "{err}");
        assert!(first.path().to_string_lossy().ends_with("x.swap.json.lock"));
        drop(first);
        let _again = SwapLock::acquire(&path, std::time::Duration::from_millis(0)).unwrap();
        let (a, b) = (tmp_path(&path).unwrap(), tmp_path(&path).unwrap());
        assert_ne!(a, b);
        assert!(a.to_string_lossy().contains(&format!(".{}.", std::process::id())));
    }

    #[test]
    fn kdf_cost_read_from_a_file_is_bounded() {
        // REVIEW-2 F14.
        let dir = tempfile::tempdir().unwrap();
        let s = fresh();
        let mut file = SwapFile::new_alice(example_public(&s, Variant::Raw), &s, &Passphrase::new("pw"), &KdfParams::fast_for_tests(), 1).unwrap();
        let path = dir.path().join("a.swap.json");
        file.save(&path).unwrap();
        assert!(SwapFile::load(&path).is_ok());
        file.secret.as_mut().unwrap().kdf.m_cost_kib = 4_000_000; // ~4 GiB
        file.save(&path).unwrap();
        assert!(matches!(SwapFile::load(&path), Err(SwapFileError::Invalid(m)) if m.contains("out of bounds")));
        assert!(matches!(file.decrypt_secret(&Passphrase::new("pw")), Err(SwapFileError::Invalid(_))));
        let mut kdf = KdfParams::default_strong();
        assert!(kdf.check_bounds().is_ok());
        kdf.t_cost = 1_000;
        assert!(kdf.check_bounds().is_err());
    }

    #[test]
    fn bundle_arithmetic_is_checked_and_the_code_hash_is_the_compiled_in_constant() {
        // REVIEW-2 F13: a huge h_create must be an error, not a wrap or a panic.
        let s = fresh();
        let mut p = example_public(&s, Variant::Raw);
        p.params.h_create = u64::MAX - 10;
        assert!(matches!(p.check(), Err(SwapFileError::Invalid(_))));
        // REVIEW-3 F1: the pin is the constant of this build. Unset -> the constant; another value -> refused.
        let cast = htlc_harness::Cast::new();
        let mut eth = example_public(&s, Variant::Raw).params.eth;
        eth.code_hash = None;
        let built = SwapPublic::build(&s, Variant::Raw, &cast.alice, &cast.bob, 10_000_000, 5_800, 300_000, eth.clone()).unwrap();
        assert_eq!(built.params.eth.code_hash, Some(params::HTLC_CODE_HASH));
        eth.code_hash = Some([0x22; 32]);
        let r = SwapPublic::build(&s, Variant::Raw, &cast.alice, &cast.bob, 10_000_000, 5_800, 300_000, eth);
        assert!(matches!(r, Err(SwapFileError::Invalid(m)) if m.contains("eth.code_hash") && m.contains("different contract")));
        // A bundle that pins another contract (or none) is refused by `check`, by `new_bob` and, as a file, by `load`.
        let p = example_public(&s, Variant::Raw);
        let mut other = p.clone();
        other.params.eth.code_hash = Some([0x22; 32]);
        assert!(matches!(other.check(), Err(SwapFileError::Invalid(m)) if m.contains("eth.code_hash") && m.contains(&hex::encode(params::HTLC_CODE_HASH))));
        let mut terms = example_bob_terms(&other);
        assert!(matches!(SwapFile::new_bob(other.clone(), &terms, &example_attestation(&other), 1), Err(SwapFileError::Invalid(m)) if m.contains("eth.code_hash")));
        let mut unpinned = p.clone();
        unpinned.params.eth.code_hash = None;
        assert!(matches!(unpinned.check(), Err(SwapFileError::Invalid(m)) if m.contains("code_hash")));
        assert!(matches!(unpinned.check_bob_terms(&example_bob_terms(&p)), Err(SwapFileError::Invalid(m)) if m.contains("code_hash")));
        // Bob's own terms must name the compiled-in contract too, even against a bundle that pins the same other hash.
        terms = example_bob_terms(&p);
        terms.eth_code_hash = [0x99; 32];
        assert!(matches!(SwapFile::new_bob(p.clone(), &terms, &example_attestation(&p), 1), Err(SwapFileError::Invalid(m)) if m.contains("code_hash") && m.contains("different contract")));
        let mut same_other = other.clone();
        same_other.params.eth.code_hash = Some([0x99; 32]);
        assert!(same_other.check_bob_terms(&terms).is_err());
    }

    #[test]
    fn a_saved_file_pinning_another_contract_does_not_load() {
        // REVIEW-3 F1: fail closed. A file written by another build (a different pin) cannot be used by this one.
        let dir = tempfile::tempdir().unwrap();
        let s = fresh();
        let mut file = example_bob_file(example_public(&s, Variant::Raw), 1).unwrap();
        let ok = dir.path().join("ok.swap.json");
        file.save(&ok).unwrap();
        assert!(SwapFile::load(&ok).is_ok());
        file.public.params.eth.code_hash = Some([0x22; 32]);
        let bad = dir.path().join("bad.swap.json");
        file.save(&bad).unwrap();
        assert!(matches!(SwapFile::load(&bad), Err(SwapFileError::Invalid(m)) if m.contains("eth.code_hash") && m.contains("different contract")));
        file.public.params.eth.code_hash = None;
        let none = dir.path().join("none.swap.json");
        file.save(&none).unwrap();
        assert!(SwapFile::load(&none).is_err());
    }
    #[test]
    fn hashlock_registry_refuses_reuse() {
        let dir = tempfile::tempdir().unwrap();
        let reg = HashlockRegistry::new(dir.path().join("hashlocks.txt"));
        let h = fresh().hashlock();
        assert!(!reg.contains(&h).unwrap());
        reg.register(&h).unwrap();
        assert!(reg.contains(&h).unwrap());
        assert_eq!(reg.register(&h).unwrap_err(), SwapFileError::HashlockReused);
        reg.register(&fresh().hashlock()).unwrap();
    }
}
