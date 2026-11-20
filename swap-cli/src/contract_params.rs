//! The Parano1d contract parameters of one swap, in the forms the stock wallet and
//! the Pruv tooling take (`swap-cli alice-params`).
//!
//! Plain words. Alice locks her NOID in a custom contract (`HashTimeLock`,
//! `parano1d/contracts/htlc.pruv`). The stock wallet does not know the swap file; it
//! knows *definition* JSON (`parano1d-cli contract create DEF.json --out OBJECT.json`).
//! This module derives that definition, and the Pruv params file it comes from, from
//! the swap file's public section through the same library `pruv build` uses, and
//! refuses to hand out anything whose compiled opening differs from the 699 bytes the
//! swap file committed to. Whatever the wallet then creates can be compared with
//! [`check_object_file`] before a single micro-NOID is funded.

use noid_poseidon2b::primitives::Address;
use serde::Serialize;
use serde_json::{json, Value};

use crate::client::stock::format_noid;
use crate::params::{self, ContractVersion};
use crate::swapfile::{SwapFileError, SwapPublic};

#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct ContractParams {
    pub contract: String,
    /// `1` = `HashTimeLock`, `2` = `HashTimeLockV2` (every close pays exactly `max_fee`).
    pub contract_version: u8,
    /// The Pruv source this version compiles from (repository-relative).
    pub contract_source: &'static str,
    /// What a close may pay, in words (the stock wallet is told the number with `--fee`).
    pub fee_rule: String,
    /// v2 only: the one fee every close pays (= `max_fee`).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fixed_close_fee_micronoid: Option<u64>,
    /// v2 only: what Bob receives, `amount - max_fee`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub expected_bob_payout_micronoid: Option<u64>,
    /// `Addr(s)` (raw variant) or `Addr(Derive(m,0))` (stock variant): who may close before `deadline_height`.
    pub claim_authority: String,
    /// Bob: where a pre-deadline close must pay.
    pub claim_recipient: String,
    /// Alice's stock-wallet address that must be ACTIVE when she does the recovery close.
    pub recovery_authority: String,
    pub recovery_recipient: String,
    pub deadline_height: u64,
    /// Bob must lock on Ethereum at or before this Parano1d height (design gate I1).
    pub lock_by_height: u64,
    pub max_fee_micronoid: u64,
    pub max_fee_noid: String,
    pub max_payout_micronoid: u64,
    pub min_retained_micronoid: u64,
    /// `rules.modes`: CLAIM_CLOSE | RECOVERY_CLOSE = 10 (no continuing call, no foreign payout recipient).
    pub modes_byte: u8,
    pub claim_can_close: bool,
    pub claim_can_continue: bool,
    pub recovery_can_close: bool,
    pub recovery_can_continue: bool,
    pub unrestricted_payout_recipient: bool,
    pub opening_hex: String,
    pub opening_bytes: usize,
    /// The address the funding payment goes to (`opening.root()`).
    pub contract_root: String,
    pub fund_amount_micronoid: u64,
    /// What `parano1d-cli contract fund OBJECT <AMOUNT>` takes (decimal NOID, 6 places).
    pub fund_amount_noid: String,
    /// The `pruv --params` file for this swap.
    pub pruv_params: Value,
    /// The SDK definition JSON for `parano1d-cli contract create`.
    pub definition: Value,
}

/// Derive everything from a swap's public section. Fails if the library's compile
/// of the params file disagrees with the committed opening.
pub fn contract_params(public: &SwapPublic) -> Result<ContractParams, SwapFileError> {
    let inv = |m: String| SwapFileError::Invalid(m);
    public.check()?;
    let p = &public.params;
    let opening = public.opening()?;
    let authority = public.authority()?;
    let alice = Address::parse(&p.alice_noid).map_err(|e| inv(format!("alice_noid: {e}")))?;
    let bob = Address::parse(&p.bob_noid).map_err(|e| inv(format!("bob_noid: {e}")))?;
    let pruv_params = htlc_harness::htlc_params(&authority, &bob, &alice, p.deadline_height, p.max_fee_micronoid);
    let version = p.contract_version;
    let compiled = match version {
        ContractVersion::V1 => htlc_harness::compile_htlc_params(&pruv_params),
        ContractVersion::V2 => htlc_harness::compile_htlc_v2_params(&pruv_params),
    };
    let (rebuilt, definition) = compiled.map_err(|e| inv(format!("compile: {e}")))?;
    if rebuilt != opening {
        return Err(inv("the params file compiles to a different opening than the swap file's".into()));
    }
    let modes = opening.rules.modes;
    // The definition is what the wallet will turn into an opening: it must say what the swap file says.
    let d = &definition["definition"];
    let same = definition["kind"] == "custom_program"
        && d["claim_authority"] == public.claim_authority
        && d["claim_recipient"] == p.bob_noid
        && d["recovery_authority"] == p.alice_noid
        && d["recovery_recipient"] == p.alice_noid
        && d["deadline_height"] == p.deadline_height
        && d["max_fee_micronoid"] == p.max_fee_micronoid
        && d["max_payout_micronoid"] == 0
        && d["min_retained_micronoid"] == 0
        && d["unrestricted_payout_recipient"] == false
        && d["claim_can_continue"] == false
        && d["recovery_can_continue"] == false
        && d["claim_can_close"] == true
        && d["recovery_can_close"] == true;
    if !same {
        return Err(inv("the definition JSON does not match the swap file's policy fields".into()));
    }
    // The program the wallet will commit, per version: v1 is the single `terminal` assertion; v2 adds
    // `assert_equal fee, immediate(max_fee)` (docs/htlc-v2-fixed-fee.md section 2).
    if version.is_fixed_fee() {
        let prog = d["program"].as_array().ok_or_else(|| inv("the definition has no program".into()))?;
        let fee_step = prog.get(1);
        let shape = prog.len() == 2
            && prog[0]["opcode"] == "assert_equal"
            && prog[0]["left"] == "terminal"
            && prog[0]["right"] == "one"
            && fee_step.is_some_and(|s| {
                s["opcode"] == "assert_equal"
                    && s["left"] == "fee"
                    && s["right"] == "immediate"
                    && s["immediate"] == p.max_fee_micronoid.to_string()
                    && s["predicate"]["source"] == "always"
                    && s["predicate"]["inverted"] == false
            });
        if !shape {
            return Err(inv("the v2 definition does not carry the program `terminal; fee == max_fee`".into()));
        }
    }
    Ok(ContractParams {
        contract: format!("{} ({})", version.contract_name(), version.source_path()),
        contract_version: version.number(),
        contract_source: version.source_path(),
        fee_rule: if version.is_fixed_fee() {
            format!("every close (Bob's claim and Alice's recovery) pays exactly max_fee = {} micro-NOID; pass --fee {} to the stock wallet", p.max_fee_micronoid, format_noid(p.max_fee_micronoid))
        } else {
            format!("a close pays any fee in [{}, max_fee = {}] micro-NOID", params::MIN_CLOSE_FEE, p.max_fee_micronoid)
        },
        fixed_close_fee_micronoid: p.fixed_close_fee(),
        expected_bob_payout_micronoid: p.expected_bob_payout(),
        claim_authority: public.claim_authority.clone(),
        claim_recipient: p.bob_noid.clone(),
        recovery_authority: p.alice_noid.clone(),
        recovery_recipient: p.alice_noid.clone(),
        deadline_height: p.deadline_height,
        lock_by_height: p.lock_by_height,
        max_fee_micronoid: p.max_fee_micronoid,
        max_fee_noid: format_noid(p.max_fee_micronoid),
        max_payout_micronoid: 0,
        min_retained_micronoid: 0,
        modes_byte: modes,
        claim_can_close: true,
        claim_can_continue: false,
        recovery_can_close: true,
        recovery_can_continue: false,
        unrestricted_payout_recipient: false,
        opening_hex: public.opening_hex.clone(),
        opening_bytes: public.opening_hex.len() / 2,
        contract_root: public.contract_root.clone(),
        fund_amount_micronoid: p.amount_micronoid,
        fund_amount_noid: format_noid(p.amount_micronoid),
        pruv_params,
        definition,
    })
}

fn norm(hex_text: &str) -> String {
    hex_text.trim().strip_prefix("0x").unwrap_or(hex_text.trim()).to_ascii_lowercase()
}

/// Compare an object file written by `parano1d-cli contract create` (or `restore`) with
/// the swap: the opening hex must be identical and, when present, so must the address.
/// Returns the opening's address on success.
pub fn check_object_file(public: &SwapPublic, object: &Value) -> Result<String, String> {
    let opening = object["opening_hex"]
        .as_str()
        .or_else(|| object["successor"]["opening_hex"].as_str())
        .ok_or("the object file has no `opening_hex`")?;
    if norm(opening) != norm(&public.opening_hex) {
        return Err(format!(
            "MISMATCH: the wallet built a different opening ({} bytes) than the swap file's ({} bytes); do NOT fund it",
            norm(opening).len() / 2,
            public.opening_hex.len() / 2
        ));
    }
    if let Some(addr) = object["address"].as_str() {
        if addr != public.contract_root {
            return Err(format!("MISMATCH: object address {addr} is not the swap's contract root {}", public.contract_root));
        }
    }
    Ok(public.contract_root.clone())
}

/// The commands Alice runs, with this swap's real values filled in (Windows paths as given).
pub fn alice_commands(c: &ContractParams, swap_file: &str, def_file: &str, object_file: &str) -> Value {
    // v2: the close must pay exactly max_fee, so the wallet is told the fee instead of choosing its own.
    let fee_flag = if c.fixed_close_fee_micronoid.is_some() { format!(" --fee {}", c.max_fee_noid) } else { String::new() };
    json!([
        format!("parano1d-cli contract create {def_file} --out {object_file}"),
        format!("swap-cli alice-params {swap_file} --check-object {object_file}"),
        format!("parano1d-cli contract fund {object_file} {}", c.fund_amount_noid),
        format!("parano1d-cli contract instances {object_file}"),
        format!("swap-cli tick {swap_file} --noid-rpc http://127.0.0.1:9601 --eth-rpc <URL> --transport curl"),
        format!("parano1d-cli address --use <INDEX of {}>   (before the recovery close)", c.recovery_authority),
        format!("parano1d-cli contract call {object_file} <SLOT> <CREATION_ID> --close{fee_flag} --preview   (at height >= {})", c.deadline_height),
    ])
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::secret::{Secret, Variant};
    use crate::swapfile::example_public;
    use serde_json::json;

    #[test]
    fn derives_the_forms_the_wallet_takes() {
        let s = Secret::generate().unwrap();
        let public = example_public(&s, Variant::Raw);
        let c = contract_params(&public).unwrap();
        assert_eq!(c.modes_byte, 10);
        assert_eq!(c.opening_bytes, 699);
        assert_eq!(c.fund_amount_noid, "10.000000");
        assert_eq!(c.max_fee_noid, "0.050000");
        assert_eq!(c.pruv_params["timeout_height"], json!("300738"));
        assert_eq!(c.pruv_params["max_fee"], json!("50000"));
        assert_eq!(c.definition["kind"], "custom_program");
        assert_eq!(c.definition["definition"]["program"].as_array().unwrap().len(), 1);
    }

    #[test]
    fn object_file_check_accepts_the_same_opening_and_refuses_any_other() {
        let s = Secret::generate().unwrap();
        let public = example_public(&s, Variant::Raw);
        let other = example_public(&Secret::generate().unwrap(), Variant::Raw);
        let ok = json!({"opening_hex": public.opening_hex.to_uppercase(), "address": public.contract_root});
        assert_eq!(check_object_file(&public, &ok), Ok(public.contract_root.clone()));
        let bad = json!({"opening_hex": other.opening_hex, "address": other.contract_root});
        assert!(check_object_file(&public, &bad).unwrap_err().starts_with("MISMATCH"));
        let wrong_addr = json!({"opening_hex": public.opening_hex, "address": other.contract_root});
        assert!(check_object_file(&public, &wrong_addr).unwrap_err().contains("contract root"));
        assert!(check_object_file(&public, &json!({})).is_err());
        // A `contract call` artifact keeps the candidate successor's opening: also accepted by shape.
        assert!(check_object_file(&public, &json!({"successor": {"opening_hex": public.opening_hex}})).is_ok());
    }
}
