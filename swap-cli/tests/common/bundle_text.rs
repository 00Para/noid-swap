//! Helpers for the tests that edit a bundle's text on purpose and still want the carrier check (`bundle_check`) to pass, so the
//! check that is under test is a later one. Include with `#[path = "common/bundle_text.rs"] mod bundle_text;`.

#![allow(dead_code)]

use serde_json::Value;

/// The bundle text with its `bundle_check` recomputed over the current values.
pub fn reseal(text: &str) -> String {
    let mut value: Value = serde_json::from_str(text).expect("a bundle");
    value.as_object_mut().unwrap().remove("bundle_check");
    value["bundle_check"] = serde_json::to_value(swap_cli::bundle::compute_check(&value)).unwrap();
    serde_json::to_string_pretty(&value).unwrap()
}

/// The text `new-alice` would print for this public section (with its `bundle_check`).
pub fn checked_text(public: &swap_cli::swapfile::SwapPublic) -> String {
    swap_cli::bundle::CheckedBundle::new(public).unwrap().to_pretty_json().unwrap()
}
