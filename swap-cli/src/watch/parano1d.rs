//! Parano1d watcher (TASKS M2.4): polls a node and reduces the answers to one
//! `NoidObservation`.
//!
//! Plain words. A Parano1d "contract instance" is a coin held at a special
//! address (the opening's *root*). The tool must know, on every poll: how tall
//! the chain is (`tip`), whether our coin exists and is the contract we built
//! (`instance`, `instance_matches_opening`), who may spend it right now
//! (`active_authority`: the claim side before the deadline, the refund side
//! after), and whether somebody already has a spend waiting in the node's
//! mempool (`pending_calls`). A *mempool* is the node's waiting room for
//! transactions that are not yet in a block; Parano1d admits one transaction
//! per input and never replaces it, so seeing a pending call matters.
//!
//! Every method name is the full wire name: the server is declared with
//! `#[rpc(server, namespace = "paranoid")]` (`vendor/parano1d/noid_rpc/src/api.rs`),
//! so `getEpochAnchor` is called `paranoid_getEpochAnchor`, exactly as the
//! stock CLI builds it (`noid_node/src/bin/noid_cli.rs:2175-2182`). (A search for the literal
//! `"paranoid_getEpochAnchor"` in the vendored sources finds nothing: the `jsonrpsee` macro adds
//! the prefix.) Every name and positional parameter list below was confirmed against the owner's
//! v2.1.0 node on 2026-11-04 with read-only calls; see the README table and the drift-guard tests.
//!
//! Result shapes are read from `noid_rpc/src/types.rs` (`SlotInfo`,
//! `FeeEstimate`, `MempoolTxInfo`, `MempoolEntryInfo`, `MempoolInfo`,
//! `MempoolStats`, `TxInfo`) and `noid_rpc/src/object_types.rs`
//! (`ObjectInstances`, `ObjectStatus`). Decoding is deliberately partial: only
//! the fields we use are required, unknown fields are ignored, and any shape
//! mismatch becomes `RpcError::Decode("<method>: ...")`. Node output never
//! causes a panic.
//!
//! Calls per poll, in order:
//! 1. `paranoid_blockCount []`
//! 2. `paranoid_getEpochAnchor []` (hex of 32 bytes, `server.rs` `get_epoch_anchor`)
//! 3. `paranoid_estimateFeeDetailed [1, 1]`
//! 4. `paranoid_getMempoolStats []` (`fee_floor`)
//! 5. `paranoid_getObjectInstances [opening, 0, 16]` (slots owned by the opening's root)
//! 6. `paranoid_getObjectStatus [opening, slot]` once for EVERY non-empty slot, in slot order (REVIEW-2 F10: one
//!    call when there is one instance, as always)
//! 7. `paranoid_getMempoolInfo []`, then `paranoid_getMempoolEntry [tx_hash]` for
//!    each tx with `page_count == 1` (only a single-page transaction can be a
//!    contract call; the bulk listing never carries the opening, only the
//!    single-entry lookup does)
//! 8. With a tracked txid: `paranoid_getTx [txid]` and `paranoid_getMempoolEntry [txid]`
//!    (the second is skipped if step 7 already looked that txid up).
//! 9. `paranoid_getBlockHeader [tip]` (REVIEW-2 F5): the tip block's timestamp, the CHAIN's age. Optional: a node or a
//!    recording without the method gives `tip_time = None`, never an error.
//!
//! The calls are not one atomic snapshot: the tip can move between them. The
//! engine treats an observation as "true as of about now", never as a lock.
//!
//! Known cost: step 7 is one RPC per single-page mempool entry. That is fine
//! for a testnet mempool; a busy mainnet mempool would want a smarter filter.

use std::collections::HashMap;

use serde::de::DeserializeOwned;
use serde::Deserialize;
use serde_json::{json, Value};

use super::{ConfirmedTx, JsonRpc, NoidInstance, NoidInstanceStatus, NoidObservation, PendingCall, RpcError};

/// How many instance slots to ask for. Our opening's root should own exactly
/// one; the page is a little larger so a double-funding is visible, not hidden: every non-empty slot is reported in
/// `NoidObservation::instances` (REVIEW-2 F10), the first one also in the legacy single-instance fields.
const INSTANCE_PAGE: u32 = 16;

// `serde` structs that mirror only the fields we read (see module docs).

#[derive(Deserialize)]
struct SlotInfo {
    slot_index: u32,
    value: u64,
    creation_id: u64,
    #[serde(default)]
    empty: bool,
}

#[derive(Deserialize)]
struct ObjectInstances {
    slots: Vec<SlotInfo>,
    /// Height of the State snapshot the page was read from (the node identifies every page by it).
    #[serde(default)]
    height: u64,
}

#[derive(Deserialize)]
struct ObjectStatus {
    matches_opening: bool,
    active_authority: String,
    /// Height the status was computed at.
    #[serde(default)]
    tip_height: u64,
}

#[derive(Deserialize)]
struct FeeEstimate {
    fee_micronoid: u64,
    /// Optional: older nodes and some recordings have no breakdown.
    #[serde(default)]
    breakdown: Option<FeeBreakdown>,
}

#[derive(Deserialize)]
struct FeeBreakdown {
    #[serde(default)]
    relay_floor: Option<u64>,
}

#[derive(Deserialize)]
struct MempoolStats {
    fee_floor: u64,
}

#[derive(Deserialize)]
struct MempoolTxInfo {
    tx_hash: String,
    page_count: usize,
}

#[derive(Deserialize)]
struct MempoolInfo {
    txs: Vec<MempoolTxInfo>,
}

#[derive(Deserialize)]
struct MempoolEntry {
    tx_hash: String,
    fee_micronoid: u64,
    admitted_height: u64,
    #[serde(default)]
    contract_opening_hex: Option<String>,
}

#[derive(Deserialize)]
struct TxInfo {
    height: u64,
}

/// `getBlockHeader` -> `BlockHeaderInfo` (`noid_rpc/src/types.rs`); only the timestamp is read (Unix seconds).
#[derive(Deserialize)]
struct BlockHeader {
    timestamp: u64,
}

fn decode<T: DeserializeOwned>(method: &str, v: Value) -> Result<T, RpcError> {
    serde_json::from_value(v).map_err(|e| RpcError::Decode(format!("{method}: {e}")))
}

/// `"0xAB.."` and `"ab.."` compare equal.
fn norm_hex(s: &str) -> String {
    s.trim().strip_prefix("0x").unwrap_or(s.trim()).to_ascii_lowercase()
}

pub struct NoidWatcher<R: JsonRpc> {
    pub rpc: R,
    /// The canonical 699-byte opening, hex (what the node RPCs take).
    pub opening_hex: String,
    /// Clock for `observed_at` (Unix seconds); the system clock unless a test pins it.
    pub clock: fn() -> u64,
}

impl<R: JsonRpc> NoidWatcher<R> {
    pub fn new(rpc: R, opening_hex: String) -> Self {
        Self { rpc, opening_hex, clock: super::system_now }
    }

    pub fn with_clock(mut self, clock: fn() -> u64) -> Self {
        self.clock = clock;
        self
    }

    fn call<T: DeserializeOwned>(&self, method: &str, params: Value) -> Result<T, RpcError> {
        decode(method, self.rpc.call(method, params)?)
    }

    /// `getMempoolEntry` returns `null` when the txid is not pending.
    fn entry(&self, txid: &str) -> Result<Option<MempoolEntry>, RpcError> {
        self.call("paranoid_getMempoolEntry", json!([txid]))
    }

    /// Poll the node once. `tracked_txid` is our own claim/refund, if one was sent.
    pub fn observe(&self, tracked_txid: Option<&str>) -> Result<NoidObservation, RpcError> {
        // Stamped when the poll STARTS: the observation is no fresher than its first answer.
        let observed_at = (self.clock)();
        // The poll is several RPCs, not one snapshot (LIVE RUN 1: `blockCount` said 280,637 while the
        // instance page was read at 280,638). `tip` is raised to the highest height any answer
        // reflects, so a funding first seen "at tip" is never recorded below its inclusion height
        // and finality is never declared a block early.
        let mut tip: u64 = self.call("paranoid_blockCount", json!([]))?;

        let anchor: String = self.call("paranoid_getEpochAnchor", json!([]))?;
        let epoch_anchor = hex::decode(norm_hex(&anchor))
            .ok()
            .and_then(|b| <[u8; 32]>::try_from(b).ok())
            .ok_or_else(|| RpcError::Decode("paranoid_getEpochAnchor: expected 32 bytes of hex".into()))?;

        let fee: FeeEstimate = self.call("paranoid_estimateFeeDetailed", json!([1, 1]))?;
        let stats: MempoolStats = self.call("paranoid_getMempoolStats", json!([]))?;

        let page: ObjectInstances =
            self.call("paranoid_getObjectInstances", json!([self.opening_hex, 0, INSTANCE_PAGE]))?;
        tip = tip.max(page.height);
        // REVIEW-2 F10: EVERY non-empty slot of the page, each with its own status. The first one is mirrored in the
        // legacy single-instance fields, exactly as before; the engine decides which one is ours.
        let mut instances: Vec<NoidInstanceStatus> = Vec::new();
        for s in page.slots.into_iter().filter(|s| !s.empty) {
            let instance = NoidInstance { slot_index: s.slot_index, creation_id: s.creation_id, amount_micronoid: s.value };
            let st: ObjectStatus = self.call("paranoid_getObjectStatus", json!([self.opening_hex, instance.slot_index]))?;
            tip = tip.max(st.tip_height);
            instances.push(NoidInstanceStatus {
                instance,
                matches_opening: Some(st.matches_opening),
                active_authority: Some(st.active_authority),
            });
        }
        let instance_count = instances.len();
        let first = instances.first().cloned();
        let instance = first.as_ref().map(|v| v.instance.clone());
        let instance_matches_opening = first.as_ref().and_then(|v| v.matches_opening);
        let active_authority = first.and_then(|v| v.active_authority);

        // Pending calls: single-page mempool entries that carry our opening.
        let info: MempoolInfo = self.call("paranoid_getMempoolInfo", json!([]))?;
        let ours = norm_hex(&self.opening_hex);
        let mut looked_up: HashMap<String, Option<MempoolEntry>> = HashMap::new();
        let mut pending_calls = Vec::new();
        for tx in info.txs.iter().filter(|t| t.page_count == 1) {
            let entry = self.entry(&tx.tx_hash)?;
            if let Some(e) = &entry {
                if e.contract_opening_hex.as_deref().map(norm_hex).as_deref() == Some(ours.as_str()) {
                    pending_calls.push(PendingCall {
                        txid: e.tx_hash.to_ascii_lowercase(),
                        fee_micronoid: e.fee_micronoid,
                        admitted_height: e.admitted_height,
                    });
                }
            }
            looked_up.insert(tx.tx_hash.to_ascii_lowercase(), entry);
        }

        let (confirmed_tx, tracked_tx_pending) = match tracked_txid {
            None => (None, None),
            Some(txid) => {
                let key = txid.trim().to_ascii_lowercase();
                let tx: Option<TxInfo> = self.call("paranoid_getTx", json!([txid]))?;
                let confirmed = tx.map(|t| ConfirmedTx { txid: key.clone(), height: t.height });
                let pending = match looked_up.remove(&key) {
                    Some(entry) => entry.is_some(),
                    None => self.entry(txid)?.is_some(),
                };
                (confirmed, Some(pending))
            }
        };

        let next_call_height = tip
            .checked_add(1)
            .ok_or_else(|| RpcError::Decode("paranoid_blockCount: height overflows u64".into()))?;

        // REVIEW-2 F5: the tip block's own timestamp. It is asked last, for the final `tip`. Any failure (an older node
        // without the method, a recording that has no such call, a block it cannot show) is "unknown", never an error:
        // the engine then keeps the poll-age rule and says so.
        let tip_time = self
            .rpc
            .call("paranoid_getBlockHeader", json!([tip]))
            .ok()
            .and_then(|v| decode::<Option<BlockHeader>>("paranoid_getBlockHeader", v).ok().flatten())
            .map(|h| h.timestamp);

        Ok(NoidObservation {
            observed_at: Some(observed_at),
            tip,
            next_call_height,
            epoch_anchor: Some(epoch_anchor),
            fee_floor: Some(stats.fee_floor),
            fee_estimate_1_1: Some(fee.fee_micronoid),
            relay_floor: fee.breakdown.and_then(|b| b.relay_floor),
            instance,
            instance_matches_opening,
            active_authority,
            instances,
            instance_count,
            pending_calls,
            confirmed_tx,
            tracked_tx_pending,
            funding_pending: None,
            tip_time,
            second: None,
            second_error: None,
            second_label: None,
            single_node_ok: false,
            producers: None,
            accept_producer_concentration: false,
            producer_marker: Default::default(),
        })
    }
}
