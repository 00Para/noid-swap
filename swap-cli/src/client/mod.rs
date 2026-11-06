//! Claim clients for Bob (design section 7): R (raw secret, in-process proof)
//! and S (stock wallet in a throwaway data dir, scripted).

pub mod raw;
pub mod stock;

use crate::watch::{JsonRpc, RpcError};

/// Where a finished intent goes: mocks in the tests and the JSON-RPC adapter below,
/// which `swap-cli claim --submit` wires to `HttpJsonRpc` / `ExecJsonRpc`.
pub trait IntentSubmitter {
    /// `paranoid_submitTxIntent(hex)` -> txid hex (64 characters, no prefix).
    fn submit_tx_intent(&self, intent_hex: &str) -> Result<String, RpcError>;
}

/// Any `JsonRpc` is a submitter.
pub struct RpcSubmitter<R: JsonRpc>(pub R);

impl<R: JsonRpc> IntentSubmitter for RpcSubmitter<R> {
    fn submit_tx_intent(&self, intent_hex: &str) -> Result<String, RpcError> {
        let v = self.0.call("paranoid_submitTxIntent", serde_json::json!([intent_hex]))?;
        v.as_str()
            .map(str::to_string)
            .ok_or_else(|| RpcError::Decode("submitTxIntent: expected a hex string".into()))
    }
}
