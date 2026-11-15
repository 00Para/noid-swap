//! The carrier check of the bundle Alice hands to Bob (`bundle_check`).
//!
//! The bundle is the public section of Alice's swap file ([`SwapPublic`]) as JSON. It travels between two machines, sometimes
//! as pasted text, and a damaged copy must be refused for that reason and with that message, not as a side effect of a later check
//! (hex parity, the opening rebuild). So the bundle carries one more top-level field:
//!
//! ```json
//! "bundle_check": { "v": 1, "sha256": "<64 hex>", "opening_hex_len": <number of characters of opening_hex> }
//! ```
//!
//! `sha256` is the SHA-256 of the **canonical form** of the bundle without the `bundle_check` field, see [`canonical_bytes`]:
//! the JSON value with the object keys sorted bytewise at every level, no whitespace between tokens, strings and numbers as
//! `serde_json` writes them. The check therefore depends on the values only: whitespace and key order may change in transit.
//!
//! `bundle_check` belongs to the transported bundle only. It is not part of [`SwapPublic`] and is never stored in a swap file.
//! A tool that does not know the field ignores it (the type does not deny unknown fields).

use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};

use crate::swapfile::SwapPublic;

/// The only `bundle_check.v` this build writes and reads.
pub const CHECK_VERSION: u64 = 1;

/// How many leading hex digits of the digest are printed for a human to compare.
const SHORT_LEN: usize = 16;

/// The value of the top-level `bundle_check` field.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct BundleCheck {
    pub v: u64,
    /// Lowercase hex SHA-256 of [`canonical_bytes`] of the bundle without `bundle_check`.
    pub sha256: String,
    /// Number of characters of the bundle's `opening_hex` (by far its longest value, the one a damaged copy shows in).
    pub opening_hex_len: u64,
}

/// The canonical bytes of a JSON value: object keys sorted bytewise (UTF-8) at every level, no insignificant whitespace,
/// strings escaped and numbers written exactly as `serde_json` writes them in compact form.
pub fn canonical_bytes(value: &Value) -> Vec<u8> {
    let mut out = Vec::new();
    write_canonical(value, &mut out);
    out
}

fn write_canonical(value: &Value, out: &mut Vec<u8>) {
    match value {
        Value::Null => out.extend_from_slice(b"null"),
        Value::Bool(true) => out.extend_from_slice(b"true"),
        Value::Bool(false) => out.extend_from_slice(b"false"),
        Value::Number(n) => out.extend_from_slice(n.to_string().as_bytes()),
        Value::String(s) => out.extend_from_slice(&serde_json::to_vec(s).expect("a string always serialises")),
        Value::Array(items) => {
            out.push(b'[');
            for (i, item) in items.iter().enumerate() {
                if i > 0 {
                    out.push(b',');
                }
                write_canonical(item, out);
            }
            out.push(b']');
        }
        Value::Object(map) => {
            let mut keys: Vec<&String> = map.keys().collect();
            keys.sort_by(|a, b| a.as_bytes().cmp(b.as_bytes()));
            out.push(b'{');
            for (i, key) in keys.into_iter().enumerate() {
                if i > 0 {
                    out.push(b',');
                }
                out.extend_from_slice(&serde_json::to_vec(key).expect("a string always serialises"));
                out.push(b':');
                write_canonical(&map[key], out);
            }
            out.push(b'}');
        }
    }
}

/// The check of a bundle value that does not carry `bundle_check` yet.
pub fn compute_check(bundle_without_check: &Value) -> BundleCheck {
    BundleCheck {
        v: CHECK_VERSION,
        sha256: hex::encode(Sha256::digest(canonical_bytes(bundle_without_check))),
        opening_hex_len: opening_hex_len(bundle_without_check).unwrap_or(0),
    }
}

fn opening_hex_len(bundle: &Value) -> Option<u64> {
    bundle.get("opening_hex").and_then(Value::as_str).map(|s| s.chars().count() as u64)
}

fn short(sha256: &str) -> &str {
    &sha256[..SHORT_LEN.min(sha256.len())]
}

/// A bundle ready to be written: the public section plus its `bundle_check`.
#[derive(Serialize)]
pub struct CheckedBundle<'a> {
    #[serde(flatten)]
    public: &'a SwapPublic,
    bundle_check: BundleCheck,
}

impl<'a> CheckedBundle<'a> {
    pub fn new(public: &'a SwapPublic) -> Result<Self, String> {
        let value = serde_json::to_value(public).map_err(|e| e.to_string())?;
        Ok(Self { public, bundle_check: compute_check(&value) })
    }

    pub fn check(&self) -> &BundleCheck {
        &self.bundle_check
    }

    /// The bundle as pretty JSON (the text `new-alice` and `bundle` print).
    pub fn to_pretty_json(&self) -> Result<String, String> {
        serde_json::to_string_pretty(self).map_err(|e| e.to_string())
    }

    /// The line both machines compare: `bundle check: <first 16 hex of sha256> (opening_hex <len> characters)`.
    pub fn line(&self) -> String {
        format!("bundle check: {} (opening_hex {} characters)", short(&self.bundle_check.sha256), self.bundle_check.opening_hex_len)
    }
}

/// What [`open_bundle`] found.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum BundleStatus {
    /// `bundle_check` present and matching; the first 16 hex digits of the digest.
    Verified(String),
    /// No `bundle_check` and the caller allowed it (`--allow-unchecked-bundle`).
    Unchecked,
}

impl BundleStatus {
    /// The line `new-bob` prints.
    pub fn line(&self) -> String {
        match self {
            BundleStatus::Verified(short) => format!("bundle check: {short} ok"),
            BundleStatus::Unchecked => {
                "warning: this bundle carries no bundle_check (made before the check existed), so nothing shows that it arrived intact; compare the hashlock and the contract root with Alice by another route".into()
            }
        }
    }
}

const DAMAGED: &str = "the bundle was damaged in transit; ask Alice to hand it over again as a file (not as pasted text) and compare the `bundle check:` line on both machines";

/// Verify the carrier check of a bundle's text, then read it. Nothing else of the bundle is used before the check passes.
///
/// - `bundle_check` present and matching: `Ok`, with [`BundleStatus::Verified`].
/// - present and not matching, of another `v`, or malformed: `Err`.
/// - absent: `Err` naming `--allow-unchecked-bundle`, or with `allow_unchecked` `Ok` and [`BundleStatus::Unchecked`].
pub fn open_bundle(text: &str, allow_unchecked: bool) -> Result<(SwapPublic, BundleStatus), String> {
    let mut value: Value = serde_json::from_str(text)
        .map_err(|e| format!("bundle: {e} (a damaged copy often does not parse; ask Alice to hand the bundle over again as a file)"))?;
    let Some(object) = value.as_object_mut() else {
        return Err("bundle: not a JSON object".into());
    };
    let status = match object.remove("bundle_check") {
        None => {
            if !allow_unchecked {
                return Err("bundle: carries no `bundle_check`, so nothing shows that it arrived intact. Ask Alice for a bundle made by a current swap-cli (`swap-cli bundle FILE` prints one); \
for a bundle made before the check existed, pass --allow-unchecked-bundle"
                    .into());
            }
            BundleStatus::Unchecked
        }
        Some(raw) => BundleStatus::Verified(verify_check(&value, raw)?),
    };
    // A key written twice is refused, as before the check existed: the generic value above silently keeps the last copy, the typed
    // parser of the text does not (a reader of the first copy would otherwise see another value than the one that is used).
    serde_json::from_str::<SwapPublic>(text).map_err(|e| format!("bundle: {e}"))?;
    let public: SwapPublic = serde_json::from_value(value).map_err(|e| format!("bundle: {e}"))?;
    Ok((public, status))
}

/// `value` is the bundle without `bundle_check`; `raw` is the field. Returns the short digest when it matches.
fn verify_check(value: &Value, raw: Value) -> Result<String, String> {
    let Some(fields) = raw.as_object() else {
        return Err("bundle: `bundle_check` is malformed (not an object)".into());
    };
    match fields.get("v").and_then(Value::as_u64) {
        Some(CHECK_VERSION) => {}
        Some(other) => return Err(format!("bundle: `bundle_check` has v {other}; this build reads v {CHECK_VERSION} only")),
        None => return Err("bundle: `bundle_check` is malformed (v is missing or not a number)".into()),
    }
    let claimed: BundleCheck = serde_json::from_value(raw).map_err(|e| format!("bundle: `bundle_check` is malformed ({e})"))?;
    if claimed.sha256.len() != 64 || !claimed.sha256.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err("bundle: `bundle_check` is malformed (sha256 is not 64 hex digits)".into());
    }
    let actual = compute_check(value);
    let digest_ok = claimed.sha256.eq_ignore_ascii_case(&actual.sha256);
    let length_ok = claimed.opening_hex_len == actual.opening_hex_len;
    if digest_ok && length_ok {
        return Ok(short(&actual.sha256).to_string());
    }
    let mut message = format!("bundle: {DAMAGED}.");
    if !length_ok {
        message.push_str(&format!(" opening_hex has {} characters, the bundle says {}.", actual.opening_hex_len, claimed.opening_hex_len));
    }
    if !digest_ok {
        message.push_str(&format!(" The content hashes to {}, the bundle says {}.", short(&actual.sha256), short(&claimed.sha256.to_ascii_lowercase())));
    }
    Err(message)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::secret::{Secret, Variant};
    use crate::swapfile::example_public;

    /// A fixed small example, so another implementation can be checked against this one.
    fn small_example() -> Value {
        serde_json::from_str(r#"{ "params" : { "deadline_height" : 300735 }, "opening_hex" : "00000000", "hashlock" : "0x01" }"#).unwrap()
    }

    #[test]
    fn the_canonical_bytes_are_pinned() {
        // Keys sorted at every level, no whitespace, strings as serde_json writes them (non-ASCII raw, `"` escaped), integers plain.
        let v: Value = serde_json::from_str("{\"b\": [1, \"x\\\"y\", null, true, -3], \"a\": {\"z\": 2, \"y\": \"\u{2192}\"}}").unwrap();
        let canonical = canonical_bytes(&v);
        assert_eq!(std::str::from_utf8(&canonical).unwrap(), "{\"a\":{\"y\":\"\u{2192}\",\"z\":2},\"b\":[1,\"x\\\"y\",null,true,-3]}");
        assert_eq!(hex::encode(Sha256::digest(&canonical)), "c8e992bcfffe48c4a2aae559a3478cf42802e02f930e46f851ea410a3028f18c");
        // Keys sort bytewise: uppercase before lowercase, a prefix before its extensions.
        let v: Value = serde_json::from_str(r#"{"b":1,"a2":2,"a":3,"B":4}"#).unwrap();
        assert_eq!(std::str::from_utf8(&canonical_bytes(&v)).unwrap(), r#"{"B":4,"a":3,"a2":2,"b":1}"#);
    }

    #[test]
    fn the_check_of_a_small_example_is_pinned() {
        let v = small_example();
        assert_eq!(std::str::from_utf8(&canonical_bytes(&v)).unwrap(), r#"{"hashlock":"0x01","opening_hex":"00000000","params":{"deadline_height":300735}}"#);
        let check = compute_check(&v);
        assert_eq!(check, BundleCheck { v: 1, sha256: "9729820d1a6a0ad55bd3873c364bd449367e1291839620c3b346cf9c112f41f5".into(), opening_hex_len: 8 });
        assert_eq!(serde_json::to_string(&check).unwrap(), r#"{"v":1,"sha256":"9729820d1a6a0ad55bd3873c364bd449367e1291839620c3b346cf9c112f41f5","opening_hex_len":8}"#);
    }

    fn example_text() -> String {
        let public = example_public(&Secret::from_bytes(htlc_harness::seq_bytes(0x33)), Variant::Raw);
        CheckedBundle::new(&public).unwrap().to_pretty_json().unwrap()
    }

    fn open(text: &str) -> Result<(SwapPublic, BundleStatus), String> {
        open_bundle(text, false)
    }

    #[test]
    fn a_matching_bundle_is_accepted_and_the_check_is_not_part_of_the_public_section() {
        let public = example_public(&Secret::from_bytes(htlc_harness::seq_bytes(0x33)), Variant::Raw);
        let checked = CheckedBundle::new(&public).unwrap();
        let (read, status) = open(&checked.to_pretty_json().unwrap()).unwrap();
        assert_eq!(read, public);
        let BundleStatus::Verified(short) = status else { panic!("not verified") };
        assert!(checked.line().starts_with(&format!("bundle check: {short} (opening_hex ")), "{}", checked.line());
        assert!(!serde_json::to_string(&public).unwrap().contains("bundle_check"));
    }

    #[test]
    fn a_flipped_digit_in_the_opening_is_refused() {
        let text = example_text();
        let public: SwapPublic = serde_json::from_str(&text).unwrap();
        let first = public.opening_hex.chars().find(|c| *c != 'f').unwrap();
        let tampered = text.replacen(&public.opening_hex, &public.opening_hex.replacen(first, "f", 1), 1);
        assert_ne!(tampered, text);
        let err = open(&tampered).unwrap_err();
        assert!(err.contains("damaged in transit") && err.contains("again as a file"), "{err}");
        assert!(!err.contains("opening_hex has"), "the length did not change: {err}");
    }

    #[test]
    fn zeros_added_to_a_run_or_characters_removed_are_refused_with_the_length() {
        let text = example_text();
        let public: SwapPublic = serde_json::from_str(&text).unwrap();
        let n = public.opening_hex.chars().count();
        let run = public.opening_hex.find("0000000000").expect("a long zero run");
        let mut longer = public.opening_hex.clone();
        longer.insert_str(run, "000");
        let err = open(&text.replacen(&public.opening_hex, &longer, 1)).unwrap_err();
        assert!(err.contains(&format!("opening_hex has {} characters, the bundle says {n}", n + 3)), "{err}");
        let mut shorter = public.opening_hex.clone();
        shorter.replace_range(run..run + 3, "");
        let err = open(&text.replacen(&public.opening_hex, &shorter, 1)).unwrap_err();
        assert!(err.contains(&format!("opening_hex has {} characters, the bundle says {n}", n - 3)), "{err}");
        assert!(err.contains("damaged in transit"), "{err}");
    }

    #[test]
    fn a_changed_parameter_is_refused() {
        let text = example_text();
        let public: SwapPublic = serde_json::from_str(&text).unwrap();
        let needle = format!("\"lock_by_height\": {}", public.params.lock_by_height);
        assert!(text.contains(&needle));
        let err = open(&text.replace(&needle, &format!("\"lock_by_height\": {}", public.params.lock_by_height + 1))).unwrap_err();
        assert!(err.contains("damaged in transit") && !err.contains("opening_hex has"), "{err}");
    }

    #[test]
    fn other_whitespace_and_key_order_with_the_same_values_are_accepted() {
        let text = example_text();
        let value: Value = serde_json::from_str(&text).unwrap();
        let Value::Object(map) = &value else { panic!() };
        // Keys in reverse order at the top level, compact; then pretty with tabs-free single-space indentation of another shape.
        let mut reversed = String::from("{");
        let mut keys: Vec<&String> = map.keys().collect();
        keys.sort();
        keys.reverse();
        for (i, k) in keys.iter().enumerate() {
            if i > 0 {
                reversed.push_str(" ,\n\n");
            }
            reversed.push_str(&format!("  {:?}   :\t{}", k, serde_json::to_string(&map[*k]).unwrap()));
        }
        reversed.push_str("\n}\r\n");
        let (a, sa) = open(&text).unwrap();
        let (b, sb) = open(&reversed).unwrap();
        assert_eq!(a, b);
        assert_eq!(sa, sb);
        let (c, sc) = open(&serde_json::to_string(&value).unwrap()).unwrap();
        assert_eq!((a, sa), (c, sc));
    }

    #[test]
    fn an_absent_check_needs_the_flag() {
        let public = example_public(&Secret::from_bytes(htlc_harness::seq_bytes(0x33)), Variant::Raw);
        let old = serde_json::to_string_pretty(&public).unwrap();
        let err = open_bundle(&old, false).unwrap_err();
        assert!(err.contains("--allow-unchecked-bundle") && err.contains("bundle_check"), "{err}");
        let (read, status) = open_bundle(&old, true).unwrap();
        assert_eq!(read, public);
        assert_eq!(status, BundleStatus::Unchecked);
        assert!(status.line().starts_with("warning: this bundle carries no bundle_check"));
        // The flag does not excuse a check that is present and wrong.
        let wrong = example_text().replace("\"opening_hex_len\": ", "\"opening_hex_len\": 1");
        assert!(open_bundle(&wrong, true).is_err());
    }

    #[test]
    fn a_key_written_twice_is_refused_even_when_the_check_matches() {
        let text = example_text();
        // The first copy differs, the last copy is the real one: the check (computed over the last copy) matches.
        let twice = text.replacen('{', "{\n  \"contract_root\": \"o1first\",", 1);
        assert_ne!(twice, text);
        let err = open(&twice).unwrap_err();
        assert!(err.contains("duplicate field") && err.contains("contract_root"), "{err}");
    }

    #[test]
    fn another_version_and_a_malformed_check_are_refused() {
        let text = example_text();
        let err = open(&text.replacen("\"v\": 1", "\"v\": 2", 1)).unwrap_err();
        assert!(err.contains("v 2") && err.contains("reads v 1 only"), "{err}");
        for (from, to) in [("\"v\": 1", "\"v\": \"1\""), ("\"v\": 1,", ""), ("\"opening_hex_len\"", "\"extra\": 1, \"opening_hex_len\"")] {
            let bad = text.replacen(from, to, 1);
            assert_ne!(bad, text);
            let err = open(&bad).unwrap_err();
            assert!(err.contains("`bundle_check` is malformed"), "{from}: {err}");
        }
        let value: Value = serde_json::from_str(&text).unwrap();
        let sha = value["bundle_check"]["sha256"].as_str().unwrap().to_string();
        let err = open(&text.replacen(&sha, &sha[..60], 1)).unwrap_err();
        assert!(err.contains("not 64 hex digits"), "{err}");
        let mut not_object = value.clone();
        not_object["bundle_check"] = Value::String("x".into());
        assert!(open(&not_object.to_string()).unwrap_err().contains("malformed"));
        assert!(open("[]").unwrap_err().contains("not a JSON object"));
        assert!(open("{").unwrap_err().starts_with("bundle: "));
    }
}
