//! Test support for the NOID leg of the atomic-swap HTLC (`contracts/htlc.pruv`).
//!
//! Everything here is pure Rust on top of the vendored Parano1d crates. No node,
//! no network, no mining.

use noid_gkr::wallet_authorization::{
    prove_experimental_object_authorization_for_version,
    verify_experimental_object_authorization_for_version,
    prove_experimental_object_authorization, verify_experimental_object_authorization,
    OwnerAuthWitness, ProveAuthorizationError, VerifyAuthorizationError, WalletAuthorizationBundle,
};
use noid_poseidon2b::primitives::{derive_address, Address, SpendSecret};
use noid_tx::experimental_object::{ObjectError, ObjectOpening};
use noid_tx::{OwnerAuthorizationVersion, TxInput, TxPage};

/// Source of the contract under test, embedded so tests cannot drift from it.
pub const HTLC_SOURCE: &str = include_str!("../../contracts/htlc.pruv");

/// Deadline used by the tests: claims are valid for heights < D, refunds for >= D.
pub const D: u64 = 1_000;
pub const MAX_FEE: u64 = 10_000;
pub const FEE: u64 = 5_800; // minimum 1-in/1-out fee per docs/protocol/transactions.md
pub const AMOUNT: u64 = 1_000_000;
pub const EPOCH_ANCHOR: [u8; 32] = [7; 32];

/// 32 bytes `start, start+1, ...` (wrapping).
pub fn seq_bytes(start: u8) -> [u8; 32] {
    let mut b = [0u8; 32];
    for (i, x) in b.iter_mut().enumerate() {
        *x = start.wrapping_add(i as u8);
    }
    b
}

/// `Addr(s)`: the exact function consensus uses to turn a secret into an
/// address (`noid_poseidon2b::primitives::derive_address`).
pub fn addr(secret: [u8; 32]) -> Address {
    derive_address(&SpendSecret::from_bytes(secret))
}

pub fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

pub fn witness(secret: [u8; 32]) -> OwnerAuthWitness {
    OwnerAuthWitness::new(SpendSecret::from_bytes(secret))
}

/// The cast. Alice sells NOID and generates the swap secret; Bob receives NOID
/// if he learns the secret in time.
pub struct Cast {
    /// Swap secret `s`; the hashlock address is `Addr(s)`.
    pub s: [u8; 32],
    /// A different secret an attacker might try.
    pub s_wrong: [u8; 32],
    /// Alice's recovery secret (refund authority).
    pub alice_secret: [u8; 32],
    pub bob: Address,
    pub alice: Address,
    pub mallory: Address,
}

impl Cast {
    pub fn new() -> Self {
        let s = seq_bytes(0x00);
        let alice_secret = seq_bytes(0x40);
        Cast {
            s,
            s_wrong: seq_bytes(0x20),
            alice_secret,
            // Bob's payout address: nobody in the tests holds its secret.
            bob: addr(seq_bytes(0x60)),
            alice: addr(alice_secret),
            mallory: Address([0xEE; 32]),
        }
    }
}

impl Default for Cast {
    fn default() -> Self {
        Self::new()
    }
}

/// Compile `contracts/htlc.pruv` with the given parameters and return the
/// resulting `ObjectOpening` (so the tests exercise the real compiled program,
/// not a hand-built look-alike).
/// Same as [`try_compile_htlc`] but panics when the tool guard refuses the
/// parameters (test convenience; the guard itself is [`check_swap_params`]).
pub fn compile_htlc(
    hashlock: Address,
    receiver: Address,
    sender: Address,
    timeout_height: u64,
    max_fee: u64,
) -> ObjectOpening {
    try_compile_htlc(hashlock, receiver, sender, timeout_height, max_fee)
        .unwrap_or_else(|e| panic!("tool guard refused the swap parameters: {e}"))
}

/// Guarded compile: runs [`check_swap_params`] BEFORE compiling and
/// [`check_opening`] on the compiled result, so an unsafe contract is never
/// produced by this crate.
pub fn try_compile_htlc(
    hashlock: Address,
    receiver: Address,
    sender: Address,
    timeout_height: u64,
    max_fee: u64,
) -> Result<ObjectOpening, GuardError> {
    check_swap_params(&hashlock, &receiver, max_fee)?;
    let params = serde_json::json!({
        "hashlock_authority": hashlock.to_bech32(),
        "receiver": receiver.to_bech32(),
        "sender": sender.to_bech32(),
        "timeout_height": timeout_height.to_string(),
        "max_fee": max_fee.to_string(),
    });
    let opening = noid_pruv::compile(HTLC_SOURCE, &params)
        .expect("htlc.pruv compiles")
        .opening()
        .clone();
    check_opening(&opening)?;
    Ok(opening)
}

pub fn standard_opening(c: &Cast) -> ObjectOpening {
    compile_htlc(addr(c.s), c.bob, c.alice, D, MAX_FEE)
}

pub fn input() -> TxInput {
    TxInput {
        slot_index: 1,
        amount: AMOUNT,
        creation_id: 1,
    }
}

/// A closing call (one input, one output) at inclusion height `height`.
pub fn close_page(
    opening: &ObjectOpening,
    fee: u64,
    height: u64,
) -> Result<TxPage, ObjectError> {
    opening.build_call(input(), 2, fee, EPOCH_ANCHOR, height, true)
}

/// Rebuild a page after editing its body (re-derives page shape/hash).
pub fn with_body(page: &TxPage, edit: impl FnOnce(&mut noid_tx::TxBody)) -> TxPage {
    let mut body = page.body.clone();
    edit(&mut body);
    TxPage::new(body).expect("edited page is still well-formed")
}

pub fn prove(
    page: &TxPage,
    opening: &ObjectOpening,
    height: u64,
    secret: [u8; 32],
) -> Result<WalletAuthorizationBundle, ProveAuthorizationError> {
    prove_experimental_object_authorization(page, opening, height, witness(secret))
}

pub fn verify(
    page: &TxPage,
    opening: &ObjectOpening,
    height: u64,
    bundle: &WalletAuthorizationBundle,
) -> Result<(), VerifyAuthorizationError> {
    verify_experimental_object_authorization(page, opening, height, bundle)
}


// ------------------------------------------------------------------------------------------
// Stock-wallet derivation: Addr(Derive(m, i))
// ------------------------------------------------------------------------------------------

/// `Derive(m, index)`: the spend secret the stock wallet uses for address index
/// `index`, as 32 bytes. Copied from the private `MasterSecret::derive_spend_secret`
/// in `vendor/parano1d/noid_node/src/wallet/keystore.rs` (that type is
/// `pub(super)`, so the harness cannot call it): a Poseidon2b sponge with IV 0
/// absorbing `m_lo, m_hi, index, "noid-deri"` and the padded finalize
/// (3 permutations). `equiv/portable::derive` is the independent no_std twin.
pub fn derive_bytes(m: [u8; 32], index: u32) -> [u8; 32] {
    use noid_core::{Block128, TowerField};
    use noid_poseidon2b::native::compression::Poseidon2bSponge;

    let mut sponge = Poseidon2bSponge::with_iv([Block128::ZERO; 2]);
    sponge.absorb(Block128::from(u128::from_le_bytes(m[..16].try_into().unwrap())));
    sponge.absorb(Block128::from(u128::from_le_bytes(m[16..].try_into().unwrap())));
    sponge.absorb(Block128::from(index as u128));
    sponge.absorb(Block128::from(0x6E6F69642D64657269_u128)); // "noid-deri"
    sponge.finalize()
}

/// `Addr(Derive(m, index))`: the address a stock wallet with master secret `m`
/// shows at `index`. This is the stock-wallet variant of the hashlock authority.
pub fn addr_derived(m: [u8; 32], index: u32) -> Address {
    addr(derive_bytes(m, index))
}

/// Authorize as the stock wallet does: the witness is `Derive(m, index)`, NOT `m`.
pub fn prove_stock_wallet(
    page: &TxPage,
    opening: &ObjectOpening,
    height: u64,
    master: [u8; 32],
    index: u32,
) -> Result<WalletAuthorizationBundle, ProveAuthorizationError> {
    prove(page, opening, height, derive_bytes(master, index))
}

// ------------------------------------------------------------------------------------------
// Owner-authorization proof versions (V3 before v2.1, V4 from v2.1)
// ------------------------------------------------------------------------------------------

/// Parano1d mainnet height at which v2.1 (and owner-authorization V4) activates
/// (`noid_chain::consensus::params::MAINNET_V2_1_ACTIVATION_HEIGHT`). The
/// harness does not depend on `noid_chain` (it pulls in libmdbx), so the
/// constant and the rule below are mirrored here; the `auth_version_boundary`
/// test pins them.
pub const V2_1_ACTIVATION_HEIGHT: u64 = 279_370;

/// Mirror of `noid_chain::consensus::params::owner_authorization_version(height)`:
/// V3 for `height < 279,370`, V4 from 279,370 on.
pub fn auth_version_at(height: u64) -> OwnerAuthorizationVersion {
    if height >= V2_1_ACTIVATION_HEIGHT {
        OwnerAuthorizationVersion::V4
    } else {
        OwnerAuthorizationVersion::V3
    }
}

/// Prove with an explicit owner-authorization version (`prove` above is V4).
pub fn prove_v(
    page: &TxPage,
    opening: &ObjectOpening,
    height: u64,
    secret: [u8; 32],
    version: OwnerAuthorizationVersion,
) -> Result<WalletAuthorizationBundle, ProveAuthorizationError> {
    prove_experimental_object_authorization_for_version(page, opening, height, witness(secret), version)
}

/// Verify under an explicit owner-authorization version (`verify` above is V4).
pub fn verify_v(
    page: &TxPage,
    opening: &ObjectOpening,
    height: u64,
    bundle: &WalletAuthorizationBundle,
    version: OwnerAuthorizationVersion,
) -> Result<(), VerifyAuthorizationError> {
    verify_experimental_object_authorization_for_version(page, opening, height, bundle, version)
}

// ------------------------------------------------------------------------------------------
// Tool guard (TASKS M0.6, design section 6.4)
// ------------------------------------------------------------------------------------------

/// Smallest close fee the chain accepts for a 1-input, 1-output close:
/// `5000 + 100*in + 700*out` = 5,800 micro-NOID. A contract whose `max_fee` is
/// below this can never be closed by either branch: claim and refund are both
/// locked forever.
pub const MIN_CLOSE_FEE: u64 = 5_000 + 100 + 700;

/// Why the tool refuses to build a swap contract.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum GuardError {
    /// `claim_recipient == claim_authority`: once the secret is public on the
    /// other chain, anyone holding it could authorize AND receive the funds
    /// (the unsafe `refundable_payment` shape). The recipient must be Bob's
    /// address, which is not derived from the secret.
    ClaimRecipientIsClaimAuthority,
    /// `max_fee < 5,800`: neither branch can ever pay the minimum close fee.
    MaxFeeBelowMinimumCloseFee { max_fee: u64, minimum: u64 },
    /// A params file or value is missing a field or has a malformed one.
    BadParams(String),
}

impl std::fmt::Display for GuardError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            GuardError::ClaimRecipientIsClaimAuthority => write!(
                f,
                "claim_recipient equals claim_authority: whoever learns the secret could take the funds"
            ),
            GuardError::MaxFeeBelowMinimumCloseFee { max_fee, minimum } => write!(
                f,
                "max_fee {max_fee} is below the minimum close fee {minimum}: claim and refund would both be locked forever"
            ),
            GuardError::BadParams(msg) => write!(f, "bad swap parameters: {msg}"),
        }
    }
}

impl std::error::Error for GuardError {}

/// The guard. Rejects `claim_recipient == claim_authority` and
/// `max_fee < MIN_CLOSE_FEE`. In the Pruv contract `claim_authority` is the
/// `hashlock_authority` parameter and `claim_recipient` is `receiver` (Bob).
pub fn check_swap_params(
    claim_authority: &Address,
    claim_recipient: &Address,
    max_fee: u64,
) -> Result<(), GuardError> {
    if claim_recipient == claim_authority {
        return Err(GuardError::ClaimRecipientIsClaimAuthority);
    }
    if max_fee < MIN_CLOSE_FEE {
        return Err(GuardError::MaxFeeBelowMinimumCloseFee { max_fee, minimum: MIN_CLOSE_FEE });
    }
    Ok(())
}

/// The same guard applied to a compiled opening (defence in depth: checks what
/// will actually be committed, not what was typed).
pub fn check_opening(opening: &ObjectOpening) -> Result<(), GuardError> {
    check_swap_params(&opening.claim_authority, &opening.claim_recipient, opening.rules.max_fee)
}

/// The guard applied to a parsed params object (`htlc.params.example.json`
/// shape: `hashlock_authority`, `receiver`, `max_fee`; u64 as decimal string).
pub fn check_params_value(params: &serde_json::Value) -> Result<(), GuardError> {
    let address = |key: &str| {
        let text = params
            .get(key)
            .and_then(|v| v.as_str())
            .ok_or_else(|| GuardError::BadParams(format!("missing string field `{key}`")))?;
        Address::parse(text)
            .map_err(|e| GuardError::BadParams(format!("`{key}` is not a valid address: {e}")))
    };
    let max_fee = match params.get("max_fee") {
        Some(serde_json::Value::String(s)) => s
            .parse::<u64>()
            .map_err(|_| GuardError::BadParams("`max_fee` is not a u64 decimal string".into()))?,
        Some(serde_json::Value::Number(n)) => n
            .as_u64()
            .ok_or_else(|| GuardError::BadParams("`max_fee` is not a u64".into()))?,
        _ => return Err(GuardError::BadParams("missing field `max_fee`".into())),
    };
    check_swap_params(&address("hashlock_authority")?, &address("receiver")?, max_fee)
}

/// Load a params file the way `pruv --params` does (`noid_pruv::parse_parameters`)
/// and run the guard on it before returning the value. Use this instead of
/// reading params files directly.
pub fn load_params_guarded(path: &std::path::Path) -> Result<serde_json::Value, GuardError> {
    let text = std::fs::read_to_string(path)
        .map_err(|e| GuardError::BadParams(format!("cannot read {}: {e}", path.display())))?;
    let params = noid_pruv::parse_parameters(&text)
        .map_err(|e| GuardError::BadParams(format!("{}: {e:?}", path.display())))?;
    check_params_value(&params)?;
    Ok(params)
}

/// The `pruv --params` object for a swap contract (the `htlc.params.example.json`
/// shape: addresses in bech32m, u64 as decimal strings).
pub fn htlc_params(
    hashlock: &Address,
    receiver: &Address,
    sender: &Address,
    timeout_height: u64,
    max_fee: u64,
) -> serde_json::Value {
    serde_json::json!({
        "hashlock_authority": hashlock.to_bech32(),
        "receiver": receiver.to_bech32(),
        "sender": sender.to_bech32(),
        "timeout_height": timeout_height.to_string(),
        "max_fee": max_fee.to_string(),
    })
}

/// Compile `contracts/htlc.pruv` from a params object (as loaded from a params
/// file by [`load_params_guarded`]) and return the opening together with the
/// SDK definition JSON, i.e. what `pruv build ... --out` writes and
/// `parano1d-cli contract create` reads. The tool guard runs on the params
/// before compiling and on the compiled opening after.
pub fn compile_htlc_params(
    params: &serde_json::Value,
) -> Result<(ObjectOpening, serde_json::Value), GuardError> {
    check_params_value(params)?;
    let compiled = noid_pruv::compile(HTLC_SOURCE, params)
        .map_err(|e| GuardError::BadParams(format!("htlc.pruv does not compile with these params: {e:?}")))?;
    let opening = compiled.opening().clone();
    check_opening(&opening)?;
    Ok((opening, compiled.definition()))
}

// ------------------------------------------------------------------------------------------
// HashTimeLock v2 (fixed fee): added for swap-cli's contract-version support. Nothing above changes.
// ------------------------------------------------------------------------------------------

/// Source of `contracts/htlc_v2.pruv` (v1 plus `require fee == max_fee;`), embedded like [`HTLC_SOURCE`].
pub const HTLC_V2_SOURCE: &str = include_str!("../../contracts/htlc_v2.pruv");

/// Compile `contracts/htlc_v2.pruv` from a params object (same shape as for v1) and return the
/// opening together with the SDK definition JSON. The tool guard runs before and after, exactly as
/// in [`compile_htlc_params`]. A v2 contract has a different code id, so the same parameters give a
/// different address than v1.
pub fn compile_htlc_v2_params(
    params: &serde_json::Value,
) -> Result<(ObjectOpening, serde_json::Value), GuardError> {
    check_params_value(params)?;
    let compiled = noid_pruv::compile(HTLC_V2_SOURCE, params)
        .map_err(|e| GuardError::BadParams(format!("htlc_v2.pruv does not compile with these params: {e:?}")))?;
    let opening = compiled.opening().clone();
    check_opening(&opening)?;
    Ok((opening, compiled.definition()))
}

/// Guarded v2 compile from typed arguments (the v2 twin of [`try_compile_htlc`]).
pub fn try_compile_htlc_v2(
    hashlock: Address,
    receiver: Address,
    sender: Address,
    timeout_height: u64,
    max_fee: u64,
) -> Result<ObjectOpening, GuardError> {
    let params = htlc_params(&hashlock, &receiver, &sender, timeout_height, max_fee);
    compile_htlc_v2_params(&params).map(|(opening, _)| opening)
}
