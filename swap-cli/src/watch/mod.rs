//! Watchers: what the tool learns from the two chains, and the one transport
//! abstraction every chain read goes through.
//!
//! Plain words: a *watcher* polls a node and turns the answers into one plain
//! "observation" value (`NoidObservation`, `EthObservation`) that the engine can
//! reason about. The engine never talks to a node; it only looks at observations.
//!
//! `JsonRpc` is the transport trait. Implementations: `FixtureRpc` (replays
//! recorded JSON), `ScriptedRpc` (a closure, for scenario tests), `http::HttpJsonRpc`
//! (plain `http://` over `std::net::TcpStream`), `exec::ExecJsonRpc` (spawns `curl`,
//! which also reaches `https://`), and `record::RecordingRpc` (wraps any of them and
//! writes what was exchanged as a fixture file that `FixtureRpc` replays).

pub mod eth;
pub mod exec;
pub mod http;
pub mod parano1d;
pub mod record;

use std::collections::{HashMap, VecDeque};
use std::fmt;
use std::path::Path;
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use serde_json::Value;

// ---------------------------------------------------------------- transport

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RpcError {
    /// Could not reach the node (never produced offline).
    Transport(String),
    /// The node answered with a JSON-RPC error object.
    Remote { code: i64, message: String },
    /// The fixture has no (matching) recorded response for this call.
    Fixture(String),
    /// The response did not have the expected shape.
    Decode(String),
}

impl fmt::Display for RpcError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            RpcError::Transport(e) => write!(f, "transport: {e}"),
            RpcError::Remote { code, message } => write!(f, "rpc error {code}: {message}"),
            RpcError::Fixture(e) => write!(f, "fixture: {e}"),
            RpcError::Decode(e) => write!(f, "decode: {e}"),
        }
    }
}

impl std::error::Error for RpcError {}

/// One JSON-RPC endpoint. `method` is the full wire name
/// (`paranoid_getEpochAnchor`, `eth_getLogs`); `params` is the JSON array.
pub trait JsonRpc {
    fn call(&self, method: &str, params: Value) -> Result<Value, RpcError>;
}

impl<T: JsonRpc + ?Sized> JsonRpc for &T {
    fn call(&self, method: &str, params: Value) -> Result<Value, RpcError> {
        (**self).call(method, params)
    }
}

impl<T: JsonRpc + ?Sized> JsonRpc for Box<T> {
    fn call(&self, method: &str, params: Value) -> Result<Value, RpcError> {
        (**self).call(method, params)
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
struct RecordedError {
    code: i64,
    message: String,
}

/// One recorded call. `params`, when present, must equal the caller's params
/// (JSON equality) or the replay fails: a fixture then also pins the request.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct RecordedCall {
    pub method: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub params: Option<Value>,
    /// A recorded `null` result is a result (`Some(Value::Null)`), not a missing one.
    #[serde(default, deserialize_with = "some_value", skip_serializing_if = "Option::is_none")]
    pub result: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    error: Option<RecordedError>,
}

impl RecordedCall {
    /// What a recorder stores for one finished call. Only answers that came from
    /// the node are recorded (a result, or a JSON-RPC error object); a transport
    /// failure or an undecodable reply says nothing about the node and returns `None`.
    pub fn from_outcome(method: &str, params: &Value, outcome: &Result<Value, RpcError>) -> Option<Self> {
        match outcome {
            Ok(v) => Some(Self { method: method.to_string(), params: Some(params.clone()), result: Some(v.clone()), error: None }),
            Err(RpcError::Remote { code, message }) => Some(Self {
                method: method.to_string(),
                params: Some(params.clone()),
                result: None,
                error: Some(RecordedError { code: *code, message: message.clone() }),
            }),
            Err(_) => None,
        }
    }
}

// ---------------------------------------------------------------- JSON-RPC envelope

/// The JSON-RPC 2.0 request body for one call.
pub(crate) fn rpc_request(id: u64, method: &str, params: &Value) -> Vec<u8> {
    serde_json::to_vec(&serde_json::json!({"jsonrpc": "2.0", "id": id, "method": method, "params": params}))
        .expect("a JSON value serializes")
}

pub(crate) fn snippet(body: &[u8]) -> String {
    let text = String::from_utf8_lossy(&body[..body.len().min(200)]);
    text.trim().replace(['\r', '\n'], " ")
}

/// Turn a JSON-RPC response body into the `result`, or `RpcError::Remote` for an
/// `error` object. A body that is not a JSON-RPC response is `RpcError::Decode`.
pub(crate) fn parse_rpc_response(body: &[u8], id: u64) -> Result<Value, RpcError> {
    let v: Value = serde_json::from_slice(body)
        .map_err(|e| RpcError::Decode(format!("reply is not JSON ({e}): {}", snippet(body))))?;
    let obj = v.as_object().ok_or_else(|| RpcError::Decode(format!("reply is not a JSON-RPC object: {}", snippet(body))))?;
    if let Some(err) = obj.get("error").filter(|e| !e.is_null()) {
        let code = err.get("code").and_then(Value::as_i64).unwrap_or(0);
        let message = err.get("message").and_then(Value::as_str).unwrap_or("(no message)").to_string();
        return Err(RpcError::Remote { code, message });
    }
    if let Some(got) = obj.get("id").and_then(Value::as_u64) {
        if got != id {
            return Err(RpcError::Decode(format!("reply id {got} does not match request id {id}")));
        }
    }
    obj.get("result").cloned().ok_or_else(|| RpcError::Decode(format!("reply has neither result nor error: {}", snippet(body))))
}

fn some_value<'de, D: serde::Deserializer<'de>>(d: D) -> Result<Option<Value>, D::Error> {
    Value::deserialize(d).map(Some)
}

/// `#[serde(with = "u128dec")]`: u128 as a decimal string, so JSON tooling and
/// `serde_json::Value` (which has no 128-bit numbers) handle wei amounts.
pub mod u128dec {
    use serde::{Deserialize, Deserializer, Serializer};

    pub fn serialize<S: Serializer>(v: &u128, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(&v.to_string())
    }

    pub fn deserialize<'de, D: Deserializer<'de>>(d: D) -> Result<u128, D::Error> {
        let text = String::deserialize(d)?;
        text.parse::<u128>().map_err(serde::de::Error::custom)
    }
}

/// A recorded fixture file: `{"description": "...", "calls": [RecordedCall, ...]}`.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Fixture {
    #[serde(default)]
    pub description: String,
    pub calls: Vec<RecordedCall>,
}

/// Replays a `Fixture`. Responses are served per method in file order (FIFO).
/// When a method's queue runs dry, the last response is repeated (the usual
/// case for a watcher polled more often than the fixture was recorded) unless
/// `repeat_last(false)` was set, in which case the call fails with
/// `RpcError::Fixture`. Every call made is logged for assertions.
pub struct FixtureRpc {
    name: String,
    queues: Mutex<HashMap<String, VecDeque<RecordedCall>>>,
    last: Mutex<HashMap<String, RecordedCall>>,
    log: Mutex<Vec<(String, Value)>>,
    repeat_last: bool,
}

impl FixtureRpc {
    pub fn from_fixture(name: &str, fixture: Fixture) -> Self {
        let mut queues: HashMap<String, VecDeque<RecordedCall>> = HashMap::new();
        for call in fixture.calls {
            queues.entry(call.method.clone()).or_default().push_back(call);
        }
        Self {
            name: name.to_string(),
            queues: Mutex::new(queues),
            last: Mutex::new(HashMap::new()),
            log: Mutex::new(Vec::new()),
            repeat_last: true,
        }
    }

    pub fn from_json(name: &str, text: &str) -> Result<Self, RpcError> {
        let fixture: Fixture = serde_json::from_str(text)
            .map_err(|e| RpcError::Fixture(format!("{name}: cannot parse fixture: {e}")))?;
        Ok(Self::from_fixture(name, fixture))
    }

    pub fn from_file(path: &Path) -> Result<Self, RpcError> {
        let text = std::fs::read_to_string(path)
            .map_err(|e| RpcError::Fixture(format!("cannot read {}: {e}", path.display())))?;
        Self::from_json(&path.display().to_string(), &text)
    }

    /// Build from `(method, result)` pairs in test code.
    pub fn from_results(name: &str, calls: Vec<(&str, Value)>) -> Self {
        Self::from_fixture(
            name,
            Fixture {
                description: String::new(),
                calls: calls
                    .into_iter()
                    .map(|(m, r)| RecordedCall {
                        method: m.to_string(),
                        params: None,
                        result: Some(r),
                        error: None,
                    })
                    .collect(),
            },
        )
    }

    pub fn repeat_last(mut self, yes: bool) -> Self {
        self.repeat_last = yes;
        self
    }

    /// Every `(method, params)` served so far, in order.
    pub fn calls_made(&self) -> Vec<(String, Value)> {
        self.log.lock().unwrap().clone()
    }

    /// How many recorded responses are still queued for `method`.
    pub fn remaining(&self, method: &str) -> usize {
        self.queues.lock().unwrap().get(method).map_or(0, VecDeque::len)
    }

    fn serve(&self, rec: &RecordedCall, params: &Value) -> Result<Value, RpcError> {
        if let Some(expected) = &rec.params {
            if expected != params {
                return Err(RpcError::Fixture(format!(
                    "{}: {} called with params {} but the fixture recorded {}",
                    self.name, rec.method, params, expected
                )));
            }
        }
        if let Some(err) = &rec.error {
            return Err(RpcError::Remote { code: err.code, message: err.message.clone() });
        }
        rec.result.clone().ok_or_else(|| {
            RpcError::Fixture(format!("{}: {} has neither result nor error", self.name, rec.method))
        })
    }
}

impl JsonRpc for FixtureRpc {
    fn call(&self, method: &str, params: Value) -> Result<Value, RpcError> {
        self.log.lock().unwrap().push((method.to_string(), params.clone()));
        let next = self.queues.lock().unwrap().get_mut(method).and_then(VecDeque::pop_front);
        let rec = match next {
            Some(rec) => {
                self.last.lock().unwrap().insert(method.to_string(), rec.clone());
                rec
            }
            None => {
                let last = self.last.lock().unwrap().get(method).cloned();
                match (last, self.repeat_last) {
                    (Some(rec), true) => rec,
                    _ => {
                        return Err(RpcError::Fixture(format!(
                            "{}: no recorded response for {method}",
                            self.name
                        )))
                    }
                }
            }
        };
        self.serve(&rec, &params)
    }
}

/// A closure-backed transport for scenario tests.
pub struct ScriptedRpc<F>(pub F)
where
    F: Fn(&str, &Value) -> Result<Value, RpcError>;

impl<F> JsonRpc for ScriptedRpc<F>
where
    F: Fn(&str, &Value) -> Result<Value, RpcError>,
{
    fn call(&self, method: &str, params: Value) -> Result<Value, RpcError> {
        (self.0)(method, &params)
    }
}

// ---------------------------------------------------------------- hex serde helpers

/// `#[serde(with = "hexbytes")]` for fixed byte arrays: `0x` + hex in JSON.
pub mod hexbytes {
    use serde::{Deserialize, Deserializer, Serializer};

    pub fn serialize<S: Serializer, const N: usize>(b: &[u8; N], s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(&format!("0x{}", hex::encode(b)))
    }

    pub fn deserialize<'de, D: Deserializer<'de>, const N: usize>(d: D) -> Result<[u8; N], D::Error> {
        let text = String::deserialize(d)?;
        let t = text.strip_prefix("0x").unwrap_or(&text);
        let v = hex::decode(t).map_err(serde::de::Error::custom)?;
        v.try_into()
            .map_err(|v: Vec<u8>| serde::de::Error::custom(format!("expected {N} bytes, got {}", v.len())))
    }
}

/// `#[serde(with = "hexbytes_opt")]` for `Option<[u8; N]>`.
pub mod hexbytes_opt {
    use serde::{Deserialize, Deserializer, Serializer};

    pub fn serialize<S: Serializer, const N: usize>(
        b: &Option<[u8; N]>,
        s: S,
    ) -> Result<S::Ok, S::Error> {
        match b {
            Some(b) => s.serialize_some(&format!("0x{}", hex::encode(b))),
            None => s.serialize_none(),
        }
    }

    pub fn deserialize<'de, D: Deserializer<'de>, const N: usize>(
        d: D,
    ) -> Result<Option<[u8; N]>, D::Error> {
        let text: Option<String> = Option::deserialize(d)?;
        match text {
            None => Ok(None),
            Some(text) => {
                let t = text.strip_prefix("0x").unwrap_or(&text);
                let v = hex::decode(t).map_err(serde::de::Error::custom)?;
                v.try_into().map(Some).map_err(|v: Vec<u8>| {
                    serde::de::Error::custom(format!("expected {N} bytes, got {}", v.len()))
                })
            }
        }
    }
}

// ---------------------------------------------------------------- Parano1d observation

/// Our contract's funded instance: the State slot owned by the opening's root.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct NoidInstance {
    pub slot_index: u32,
    pub creation_id: u64,
    pub amount_micronoid: u64,
}

/// One non-empty slot of our contract root, with what `getObjectStatus` said about it (REVIEW-2 F10).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct NoidInstanceStatus {
    pub instance: NoidInstance,
    /// `getObjectStatus(opening, slot).matches_opening` for THIS slot.
    pub matches_opening: Option<bool>,
    /// `getObjectStatus.active_authority` (bech32) for THIS slot.
    pub active_authority: Option<String>,
}

/// A mempool entry whose admitted opening is ours: a pending call on the instance.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct PendingCall {
    /// Logical transaction id, 64 hex characters, no prefix (as the node prints it).
    pub txid: String,
    pub fee_micronoid: u64,
    pub admitted_height: u64,
}

/// A confirmed transaction we asked about (`getTx`).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ConfirmedTx {
    pub txid: String,
    pub height: u64,
}

/// The wall clock the watchers stamp their observations with (Unix seconds).
/// Watchers hold it as a plain `fn() -> u64` so tests can pin it.
pub fn system_now() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

/// One poll of the Parano1d node, reduced to what the engine needs.
///
/// Every `Option` field means "the poll could not tell". The engine treats an
/// unknown field as unknown, never as a pass: see `engine::decide`.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct NoidObservation {
    /// Unix seconds, local clock, when the poll started (set by the watcher or the
    /// simulator). `None` = unknown, which the engine treats as stale.
    #[serde(default)]
    pub observed_at: Option<u64>,
    /// `blockCount` / `getChainInfo.height`.
    pub tip: u64,
    /// `tip + 1`: the height a call built now would be included at.
    pub next_call_height: u64,
    /// `getEpochAnchor`, 32 bytes.
    #[serde(default, with = "hexbytes_opt")]
    pub epoch_anchor: Option<[u8; 32]>,
    /// `getMempoolStats.fee_floor` (or `getMempoolInfo.fee_floor`).
    pub fee_floor: Option<u64>,
    /// `estimateFeeDetailed(1, 1).fee_micronoid`.
    pub fee_estimate_1_1: Option<u64>,
    /// `estimateFeeDetailed(1, 1).breakdown.relay_floor`: the node's relay floor for a 1-in/1-out close. `None` when the
    /// answer carries no breakdown (then the per-tick floor-versus-`max_fee` note is skipped).
    #[serde(default)]
    pub relay_floor: Option<u64>,
    /// The FIRST instance funded at the opening's root, if any (`getObjectInstances`). Kept for compatibility:
    /// `instances` below lists every non-empty slot (REVIEW-2 F10), and the engine chooses among them.
    pub instance: Option<NoidInstance>,
    /// `getObjectStatus(opening, slot).matches_opening` for that first instance.
    pub instance_matches_opening: Option<bool>,
    /// `getObjectStatus.active_authority` (bech32) for `next_call_height`, for that first instance.
    pub active_authority: Option<String>,
    /// REVIEW-2 F10: every non-empty slot of the page the node returned, in slot order, each with its own status. The
    /// first entry is the one mirrored in `instance` / `instance_matches_opening` / `active_authority`. A hand-built
    /// observation may leave this empty, which means "just `instance`" (see [`NoidObservation::all_instances`]).
    #[serde(default)]
    pub instances: Vec<NoidInstanceStatus>,
    /// Number of non-empty slots seen (`instances.len()` from a watcher). A count above 1 is never normal.
    #[serde(default)]
    pub instance_count: usize,
    /// Mempool entries whose `contract_opening_hex` equals our opening.
    #[serde(default)]
    pub pending_calls: Vec<PendingCall>,
    /// `getTx` for the txid the engine is tracking (our own claim or refund), if confirmed.
    pub confirmed_tx: Option<ConfirmedTx>,
    /// Whether the tracked txid is still in the mempool (`getMempoolEntry` non-null).
    pub tracked_tx_pending: Option<bool>,
    /// CHAOS F-15: is a funding transaction for our contract root waiting in the node's mempool? `None` = the node cannot say. A
    /// real Parano1d node does not: a mempool entry exposes the opening only for a CALL on an existing instance, never for a funding
    /// (`getMempoolEntry.contract_opening_hex`), so the watcher always leaves this `None` and `intent --cancel` of a `fund_noid`
    /// needs the operator's word that the wallet shows nothing pending (`--i-checked-the-wallet`). A simulator or a future node that
    /// can answer sets `Some(true)` / `Some(false)`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub funding_pending: Option<bool>,
    /// REVIEW-2 F5: `getBlockHeader(tip).timestamp` (Unix seconds): the CHAIN's age, not the poll's. `None` = the node has
    /// no such method (or the call failed); the engine then keeps the old rule and says so in a note.
    #[serde(default)]
    pub tip_time: Option<u64>,
    /// REVIEW-2 F5: what a second, independent node said in the same tick (`--noid-rpc` given twice). Always `None` inside
    /// a second opinion itself.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub second: Option<Box<NoidObservation>>,
    /// REVIEW-2 F5: the second node was configured but could not be read (the reason, no secret in it).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub second_error: Option<String>,
    /// REVIEW-2 F5: the operator accepts a single node for the steps that need two (`--single-node-ok`).
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub single_node_ok: bool,
}

impl NoidObservation {
    /// Every instance at our root: `instances`, or (an observation built by hand that left it empty) the single
    /// `instance` with its legacy status fields.
    pub fn all_instances(&self) -> Vec<NoidInstanceStatus> {
        if !self.instances.is_empty() {
            return self.instances.clone();
        }
        match &self.instance {
            Some(i) => vec![NoidInstanceStatus {
                instance: i.clone(),
                matches_opening: self.instance_matches_opening,
                active_authority: self.active_authority.clone(),
            }],
            None => Vec::new(),
        }
    }

    /// The listed instance with the same slot and incarnation as `want`.
    pub fn find_instance(&self, want: &NoidInstance) -> Option<NoidInstanceStatus> {
        self.all_instances()
            .into_iter()
            .find(|v| v.instance.slot_index == want.slot_index && v.instance.creation_id == want.creation_id)
    }
}

// ---------------------------------------------------------------- Ethereum observation

/// The `Locked` event of our lock, cross-checked with `getLock`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct EthLock {
    #[serde(with = "hexbytes")]
    pub lock_id: [u8; 32],
    #[serde(with = "hexbytes")]
    pub sender: [u8; 20],
    #[serde(with = "hexbytes")]
    pub receiver: [u8; 20],
    /// Trial amounts fit comfortably in u128 wei (JSON: decimal string).
    #[serde(with = "u128dec")]
    pub amount_wei: u128,
    #[serde(with = "hexbytes")]
    pub hashlock: [u8; 32],
    /// Absolute Unix timestamp (`T_reveal`).
    pub timelock: u64,
    pub block_number: u64,
    #[serde(with = "hexbytes")]
    pub tx_hash: [u8; 32],
    pub claimed: bool,
    pub refunded: bool,
    /// `eth_getCode(receiver) == 0x` (T11: EOAs only in v1).
    pub receiver_is_eoa: Option<bool>,
    /// `eth_getCode(sender) == 0x`.
    pub sender_is_eoa: Option<bool>,
    /// `timestamp` of the block that mined the `Locked` event (REVIEW-2 F11: Alice's (I3) check).
    #[serde(default)]
    pub block_timestamp: Option<u64>,
}

/// One `Locked` event that carries our lock word and was made by Bob's own sender (`poseidon` kind only: the sender query of `watch::eth`).
/// The word is not an indexed topic of `HTLCPoseidonV2` but the sender is (REVIEW-7 R7-1), so "has Bob's address locked on this A before" is
/// asked of the node by sender topic and the word is compared locally.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct WordLock {
    #[serde(with = "hexbytes")]
    pub lock_id: [u8; 32],
    #[serde(with = "hexbytes")]
    pub sender: [u8; 20],
    #[serde(with = "hexbytes")]
    pub receiver: [u8; 20],
    #[serde(with = "u128dec")]
    pub amount_wei: u128,
    pub timelock: u64,
    pub block_number: u64,
}

/// What happened to the word check of a poll (`poseidon` kind, REVIEW-6 R6-1, REVIEW-7 R7-1). It answers one question only, "has this word A
/// been locked before by Bob's own sender", which matters at exactly one moment: when Bob decides to put ETH into a lock. It is asked of the
/// node through the indexed sender topic (not by reading every `Locked` log of the shared contract), only while Bob has not locked yet (and for a
/// re-send of a dropped lock), and its failure is a state of the observation, never an error of the poll: the lock decision waits, everything
/// else (`tick`, Alice's reveal, Bob's `claim`) goes on.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum WordScan {
    /// Not asked in this poll (the `sha256` kind, Alice, a poll after Bob's lock). A lock decision never rests on it.
    #[default]
    NotRun,
    /// The node answered and the answer is plausible (the targeted lock, if any, is in it): `word_locks` is the complete list of Bob's own locks
    /// on the word.
    Complete,
    /// The check could not be trusted (a node error, a malformed log, a lock the targeted query found but the sender query misses). The reason
    /// is for the operator; Bob does not lock on it.
    Failed(String),
}

impl WordScan {
    pub fn is_not_run(&self) -> bool {
        matches!(self, WordScan::NotRun)
    }
}

/// A claim of OUR lock that was mined and REVERTED (receipt status 0): it published the secret in its calldata and paid nobody (REVIEW-6 R6-3).
/// Filled only from the transaction the operator named with `--reveal-tx`, after the watcher checked it against the lock.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct RevertedClaim {
    #[serde(with = "hexbytes")]
    pub lock_id: [u8; 32],
    #[serde(with = "hexbytes")]
    pub preimage: [u8; 32],
    #[serde(with = "hexbytes")]
    pub tx_hash: [u8; 32],
    pub block_number: u64,
}

/// The `Claimed` event: the preimage is public on chain.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct EthClaimed {
    #[serde(with = "hexbytes")]
    pub lock_id: [u8; 32],
    #[serde(with = "hexbytes")]
    pub preimage: [u8; 32],
    pub block_number: u64,
    #[serde(with = "hexbytes")]
    pub tx_hash: [u8; 32],
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct EthRefunded {
    #[serde(with = "hexbytes")]
    pub lock_id: [u8; 32],
    pub block_number: u64,
    #[serde(with = "hexbytes")]
    pub tx_hash: [u8; 32],
}

/// A preimage read from the calldata of a *pending* `claim(lockId, preimage)`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct PendingPreimage {
    #[serde(with = "hexbytes")]
    pub lock_id: [u8; 32],
    #[serde(with = "hexbytes")]
    pub preimage: [u8; 32],
    #[serde(with = "hexbytes")]
    pub tx_hash: [u8; 32],
}

/// One poll of the Ethereum node, reduced to what the engine needs.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct EthObservation {
    /// Unix seconds, local clock, when the poll started (set by the watcher or the
    /// simulator). `None` = unknown, which the engine treats as stale.
    #[serde(default)]
    pub observed_at: Option<u64>,
    pub latest_block: u64,
    /// `block.timestamp` of the latest block: the chain's clock for `T_reveal`.
    pub latest_timestamp: u64,
    /// Number of the `finalized` block, when the node reports one.
    pub finalized_block: Option<u64>,
    /// `eth_chainId`, when the node answers it (T17: the pinned chain).
    #[serde(default)]
    pub chain_id: Option<u64>,
    /// `keccak256(eth_getCode(contract))`, read once a lock is found (T17: the pinned code).
    #[serde(default, with = "hexbytes_opt")]
    pub contract_code_hash: Option<[u8; 32]>,
    /// Our lock: the pinned one when the lock id is known, else the first match of the discovery rule.
    pub lock: Option<EthLock>,
    /// REVIEW-2 F10: every `Locked` event of the contract that matches the agreed parties and the hashlock, `lock`
    /// first, at most [`eth::MAX_LOCKS_READ`] of them. A hand-built observation may leave this empty, which means
    /// "just `lock`" (see [`EthObservation::all_locks`]).
    #[serde(default)]
    pub locks: Vec<EthLock>,
    /// How many matching locks exist on chain (may exceed `locks.len()` when the cap was reached).
    #[serde(default)]
    pub lock_count: usize,
    pub claimed: Option<EthClaimed>,
    pub refunded: Option<EthRefunded>,
    /// REVIEW-3 F7: `claimed` and/or `refunded` was read from the contract's `getLock` record because the logs showed no
    /// matching event (a lagging log index, a capped range). Such an entry has `tx_hash` all zero and `block_number` set to
    /// `latest_block`, an upper bound (the real block is unknown), so finality is waited for conservatively.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub claim_state_from_record: bool,
    pub pending_preimage: Option<PendingPreimage>,
    /// `poseidon` kind: a still-pending `claim` of our lock whose calldata is LONGER than 68 bytes and carries the secret. The contract
    /// reverts it (`BadCalldataLength`), so it pays nobody and is no reveal of Alice's, but the secret is public: Bob claims the NOID from
    /// it (`docs/poseidon-leg.md` 9.4). Only Bob's preimage candidates read it; Alice's side does not treat it as a reveal or a leak.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub overlong_claim: Option<PendingPreimage>,
    /// `poseidon` kind: every `Locked` event of the contract that carries our lock word and was made by Bob's OWN sender (any receiver), from
    /// the indexed-sender query (REVIEW-7 R7-1: `[Locked, null, sender]`, not a scan of every log); empty for the `sha256` kind and whenever
    /// the query did not run or failed (see [`EthObservation::word_scan`]). Bob does not lock while any exists that is not his lock
    /// (REVIEW-6 R6-2). Locks of other senders are not read at all (they cannot hurt him and the query for them is the one anyone could pad).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub word_locks: Vec<WordLock>,
    /// `poseidon` kind (REVIEW-6 R6-1): what became of the scan behind `word_locks`. Only asked while Bob has not locked yet; a failure is
    /// recorded here and never fails the poll. Bob's lock decision (first lock and re-send) needs `Complete` on every node it asks.
    #[serde(default, skip_serializing_if = "WordScan::is_not_run")]
    pub word_scan: WordScan,
    /// REVIEW-6 R6-3: the claim named by `--reveal-tx` was mined and reverted: it carries the secret and paid nobody. Checked by the watcher
    /// against this lock (contract, selector, lock id, sender = Alice's receiver, preimage matches the lock word).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reverted_claim: Option<RevertedClaim>,
    /// REVIEW-6 R6-3: what the watcher made of the `--reveal-tx` hash (not found, still pending, mined and fine, does not match this lock, ...).
    /// Informational; the engine copies it into the notes.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reveal_tx_note: Option<String>,
    /// REVIEW-3 F3: `eth_getTransactionCount(signer, "latest")` for the address this file's role signs Ethereum
    /// transactions with (Bob: `bob_sender`; Alice: `alice_receiver`). `None` = not asked, or the node could not
    /// answer: unknown, never an error. `intent --cancel` reads it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub signer_nonce_latest: Option<u64>,
    /// REVIEW-3 F3: the same with `"pending"`. A value above `signer_nonce_latest` means a transaction of the signer sits
    /// in the node's mempool: a send of the intent may be on its way.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub signer_nonce_pending: Option<u64>,
    /// REVIEW-2 F5: what a second, independent node said in the same tick (`--eth-rpc` given twice). Always `None`
    /// inside a second opinion itself.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub second: Option<Box<EthObservation>>,
    /// REVIEW-2 F5: the second node was configured but could not be read (the reason, no secret in it).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub second_error: Option<String>,
    /// REVIEW-2 F5: the operator accepts a single node for the steps that need two (`--single-node-ok`).
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub single_node_ok: bool,
}

impl EthObservation {
    /// Bob's lock is finalized when the finalized block number has reached its block.
    pub fn lock_finalized(&self) -> bool {
        match (&self.lock, self.finalized_block) {
            (Some(lock), Some(fin)) => fin >= lock.block_number,
            _ => false,
        }
    }

    /// Every matching lock: `locks`, or the single `lock` when a hand-built observation left `locks` empty.
    pub fn all_locks(&self) -> Vec<EthLock> {
        if !self.locks.is_empty() {
            return self.locks.clone();
        }
        self.lock.iter().cloned().collect()
    }

    /// The lock with this id among the matching ones.
    pub fn find_lock(&self, lock_id: &[u8; 32]) -> Option<EthLock> {
        self.all_locks().into_iter().find(|l| l.lock_id == *lock_id)
    }

    /// The lock `lock_id` is finalized when the finalized block number has reached its block.
    pub fn lock_finalized_id(&self, lock_id: &[u8; 32]) -> bool {
        match (self.find_lock(lock_id), self.finalized_block) {
            (Some(lock), Some(fin)) => fin >= lock.block_number,
            _ => false,
        }
    }

    /// First sight of the secret: the pending calldata beats the mined event.
    pub fn first_preimage(&self) -> Option<[u8; 32]> {
        self.pending_preimage
            .as_ref()
            .map(|p| p.preimage)
            .or_else(|| self.claimed.as_ref().map(|c| c.preimage))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn fixture_replays_in_order_then_repeats_last() {
        let rpc = FixtureRpc::from_results(
            "t",
            vec![("paranoid_blockCount", json!(10)), ("paranoid_blockCount", json!(11))],
        );
        assert_eq!(rpc.call("paranoid_blockCount", json!([])).unwrap(), json!(10));
        assert_eq!(rpc.call("paranoid_blockCount", json!([])).unwrap(), json!(11));
        assert_eq!(rpc.call("paranoid_blockCount", json!([])).unwrap(), json!(11));
        assert_eq!(rpc.calls_made().len(), 3);
        assert!(matches!(rpc.call("eth_blockNumber", json!([])), Err(RpcError::Fixture(_))));
        let strict = FixtureRpc::from_results("s", vec![("m", json!(1))]).repeat_last(false);
        assert_eq!(strict.call("m", json!([])).unwrap(), json!(1));
        assert!(matches!(strict.call("m", json!([])), Err(RpcError::Fixture(_))));
    }

    #[test]
    fn fixture_pins_params_and_serves_errors() {
        let text = r#"{"description":"x","calls":[
            {"method":"paranoid_getTx","params":["ab"],"result":null},
            {"method":"paranoid_submitTxIntent","error":{"code":-32000,"message":"SlotConflict"}}
        ]}"#;
        let rpc = FixtureRpc::from_json("t", text).unwrap();
        assert!(matches!(
            rpc.call("paranoid_getTx", json!(["cd"])),
            Err(RpcError::Fixture(_))
        ));
        assert_eq!(rpc.call("paranoid_getTx", json!(["ab"])).unwrap(), Value::Null);
        assert_eq!(
            rpc.call("paranoid_submitTxIntent", json!(["00"])),
            Err(RpcError::Remote { code: -32000, message: "SlotConflict".into() })
        );
    }

    #[test]
    fn observations_round_trip_as_json_with_hex_bytes() {
        let obs = EthObservation {
            observed_at: Some(1_700_000_001),
            latest_block: 5,
            latest_timestamp: 1_700_000_000,
            finalized_block: Some(3),
            chain_id: Some(31_337),
            contract_code_hash: Some([8; 32]),
            lock: Some(EthLock {
                lock_id: [1; 32],
                sender: [2; 20],
                receiver: [3; 20],
                amount_wei: 10u128.pow(18),
                hashlock: [4; 32],
                timelock: 1_700_007_200,
                block_number: 4,
                tx_hash: [5; 32],
                claimed: false,
                refunded: false,
                receiver_is_eoa: Some(true),
                sender_is_eoa: Some(true),
                block_timestamp: Some(1_700_000_000),
            }),
            locks: Vec::new(),
            lock_count: 1,
            claimed: None,
            refunded: None,
            claim_state_from_record: false,
            pending_preimage: Some(PendingPreimage { lock_id: [1; 32], preimage: [9; 32], tx_hash: [6; 32] }),
            overlong_claim: Some(PendingPreimage { lock_id: [1; 32], preimage: [9; 32], tx_hash: [7; 32] }),
            word_locks: vec![WordLock { lock_id: [1; 32], sender: [2; 20], receiver: [3; 20], amount_wei: 5, timelock: 9, block_number: 2 }],
            word_scan: WordScan::Failed("x".into()),
            reverted_claim: Some(RevertedClaim { lock_id: [1; 32], preimage: [9; 32], tx_hash: [8; 32], block_number: 6 }),
            reveal_tx_note: Some("n".into()),
            signer_nonce_latest: Some(4),
            signer_nonce_pending: Some(5),
            second: None,
            second_error: None,
            single_node_ok: false,
        };
        let text = serde_json::to_string(&obs).unwrap();
        assert!(text.contains("\"lock_id\":\"0x0101"));
        assert!(text.contains("\"amount_wei\":\"1000000000000000000\""));
        // `Value` has no 128-bit numbers; the decimal-string form keeps it usable.
        assert!(serde_json::to_value(&obs).is_ok());
        let back: EthObservation = serde_json::from_str(&text).unwrap();
        assert_eq!(back, obs);
        assert!(!back.lock_finalized());
        assert_eq!(back.first_preimage(), Some([9; 32]));
        let noid = NoidObservation { observed_at: Some(1_700_000_001), tip: 7, next_call_height: 8, epoch_anchor: Some([7; 32]), ..Default::default() };
        let back: NoidObservation = serde_json::from_str(&serde_json::to_string(&noid).unwrap()).unwrap();
        assert_eq!(back, noid);
        let none: NoidObservation = serde_json::from_str(r#"{"tip":1,"next_call_height":2}"#).unwrap();
        // F5: a recording written before the second opinion and the header time existed still loads, with them unknown.
        assert!(none.tip_time.is_none() && none.second.is_none() && none.second_error.is_none() && !none.single_node_ok);
        let plain = serde_json::to_string(&none).unwrap();
        assert!(!plain.contains("second") && !plain.contains("single_node_ok"), "{plain}");
        let with_second = NoidObservation { tip_time: Some(5), second: Some(Box::new(none.clone())), single_node_ok: true, ..none.clone() };
        let back: NoidObservation = serde_json::from_str(&serde_json::to_string(&with_second).unwrap()).unwrap();
        assert_eq!(back, with_second);
        assert_eq!(none.epoch_anchor, None);
        assert_eq!(none.observed_at, None);
        // F10: a recording written before the lists existed still loads, with the lists empty.
        assert!(none.instances.is_empty() && none.instance_count == 0);
        assert!(none.all_instances().is_empty());
        let old_eth: EthObservation = serde_json::from_str(r#"{"latest_block":1,"latest_timestamp":2,"finalized_block":null,"lock":null,"claimed":null,"refunded":null,"pending_preimage":null}"#).unwrap();
        assert!(old_eth.locks.is_empty() && old_eth.lock_count == 0 && old_eth.all_locks().is_empty());
        // REVIEW-3 F3: a recording written before the signer nonces existed still loads, with them unknown.
        assert!(old_eth.signer_nonce_latest.is_none() && old_eth.signer_nonce_pending.is_none());
        // A hand-built observation with only `lock` / `instance` reads as a list of one.
        assert_eq!(obs.all_locks().len(), 1);
        assert_eq!(obs.find_lock(&[1; 32]).map(|l| l.timelock), Some(1_700_007_200));
        assert!(obs.find_lock(&[9; 32]).is_none());
        let one = NoidObservation {
            instance: Some(NoidInstance { slot_index: 3, creation_id: 8, amount_micronoid: 5 }),
            instance_matches_opening: Some(true),
            ..Default::default()
        };
        assert_eq!(one.all_instances().len(), 1);
        assert_eq!(one.find_instance(&NoidInstance { slot_index: 3, creation_id: 8, amount_micronoid: 99 }).map(|v| v.matches_opening), Some(Some(true)));
        assert!(one.find_instance(&NoidInstance { slot_index: 3, creation_id: 9, amount_micronoid: 5 }).is_none());
    }
}
