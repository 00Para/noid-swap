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

use std::collections::{BTreeSet, HashMap};

use serde::de::DeserializeOwned;
use serde::Deserialize;
use serde_json::{json, Value};

use super::{ConfirmedTx, JsonRpc, NoidInstance, NoidInstanceStatus, NoidObservation, PendingCall, RpcError};

/// How many instance slots to ask for per page. `observe` follows `next_slot` up to [`MAX_INSTANCE_PAGES`]
/// so dust outputs at lower slot indices can never eclipse a funded instance.
/// The first page keeps the size the tool always asked for (so every recorded fixture still answers); the next ones use the node's maximum.
const INSTANCE_FIRST_PAGE: u32 = 16;
const INSTANCE_PAGE: u32 = 256;
const MAX_INSTANCE_PAGES: usize = 64;
/// The most coins one read lists: the first page plus the later ones (the page counter stops the read after `MAX_INSTANCE_PAGES` pages).
pub const MAX_ROOT_COINS: u32 = INSTANCE_FIRST_PAGE + (MAX_INSTANCE_PAGES as u32 - 1) * INSTANCE_PAGE;

fn too_many_coins() -> String {
    format!(
        "paranoid_getObjectInstances: more than {MAX_ROOT_COINS} coins at the contract root and the node gave no definite answer for the swap's own slot: the list cannot be judged"
    )
}

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
    /// Inclusive cursor for the next page, if more slots remain at this root.
    #[serde(default)]
    next_slot: Option<u32>,
}

#[derive(Deserialize)]
struct ObjectStatus {
    matches_opening: bool,
    active_authority: String,
    /// Height the status was computed at.
    #[serde(default)]
    tip_height: u64,
    /// Present on real nodes: lets a direct slot lookup recover a tracked instance even under a root flood.
    #[serde(default)]
    slot: Option<SlotInfo>,
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
    /// Optional already-recorded instance slot: queried directly via `paranoid_getObjectStatus` if not seen in pages.
    pub tracked_slot: Option<u32>,
    /// True once the swap is committed to claiming/recovering `tracked_slot` (so a root flood beyond `MAX_INSTANCE_PAGES` cannot stall claim/recovery).
    pub allow_truncated_with_tracked: bool,
    /// The agreed amount: with it a status is asked only for the tracked slot and for coins of this amount (one call per coin would be
    /// thousands of calls on a crowded root). Without it every coin gets one.
    pub agreed_amount: Option<u64>,
}

impl<R: JsonRpc> NoidWatcher<R> {
    pub fn new(rpc: R, opening_hex: String) -> Self {
        Self { rpc, opening_hex, clock: super::system_now, tracked_slot: None, allow_truncated_with_tracked: false, agreed_amount: None }
    }

    pub fn with_clock(mut self, clock: fn() -> u64) -> Self {
        self.clock = clock;
        self
    }

    pub fn with_tracked_slot(mut self, slot: Option<u32>, allow_truncated: bool) -> Self {
        self.tracked_slot = slot;
        self.allow_truncated_with_tracked = allow_truncated;
        self
    }

    pub fn with_agreed_amount(mut self, amount: u64) -> Self {
        self.agreed_amount = Some(amount);
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

        // Paginate `paranoid_getObjectInstances` so lower-index dust outputs cannot eclipse a live swap instance.
        let mut from_slot: u32 = 0;
        let mut pages: usize = 0;
        let mut truncated = false;
        let mut seen_slots: BTreeSet<u32> = BTreeSet::new();
        let mut raw_slots: Vec<SlotInfo> = Vec::new();
        loop {
            let page: ObjectInstances =
                self.call("paranoid_getObjectInstances", json!([self.opening_hex, from_slot, if pages == 0 { INSTANCE_FIRST_PAGE } else { INSTANCE_PAGE }]))?;
            tip = tip.max(page.height);
            for s in page.slots.into_iter().filter(|s| !s.empty) {
                if seen_slots.insert(s.slot_index) {
                    raw_slots.push(s);
                }
            }
            match page.next_slot {
                None => break,
                Some(next) => {
                    if next <= from_slot {
                        return Err(RpcError::Decode("paranoid_getObjectInstances: next_slot did not advance".into()));
                    }
                    pages += 1;
                    if pages >= MAX_INSTANCE_PAGES {
                        truncated = true;
                        break;
                    }
                    from_slot = next;
                }
            }
        }
        // REVIEW-2 F10: EVERY non-empty slot across the pages, each with its own status. The first one is mirrored in the
        // legacy single-instance fields, exactly as before; the engine decides which one is ours.
        let mut instances: Vec<NoidInstanceStatus> = Vec::new();
        for s in raw_slots {
            let instance = NoidInstance { slot_index: s.slot_index, creation_id: s.creation_id, amount_micronoid: s.value };
            // A coin that is neither of the agreed amount nor the tracked slot can never fit the agreement: it is listed without a status.
            let needs_status = self.agreed_amount.is_none_or(|a| a == instance.amount_micronoid) || self.tracked_slot == Some(instance.slot_index);
            if !needs_status {
                instances.push(NoidInstanceStatus { instance, matches_opening: None, active_authority: None });
                continue;
            }
            let st: ObjectStatus = self.call("paranoid_getObjectStatus", json!([self.opening_hex, instance.slot_index]))?;
            tip = tip.max(st.tip_height);
            instances.push(NoidInstanceStatus {
                instance,
                matches_opening: Some(st.matches_opening),
                active_authority: Some(st.active_authority),
            });
        }
        // A root with more coins than `MAX_ROOT_COINS`: the list is cut short. The swap's own slot is then asked for directly, and ANY definite
        // answer for it is a usable partial read: live (listed), empty (closed) or another incarnation. Only what needs the full list is held
        // back from such a read (`instances_truncated`, see `engine::spend_blocker`); a closed instance under a flood must not fail every tick.
        if truncated {
            let tracked = match self.tracked_slot.filter(|_| self.allow_truncated_with_tracked) {
                Some(t) => t,
                None => return Err(RpcError::Decode(too_many_coins())),
            };
            if !seen_slots.contains(&tracked) {
                let st: ObjectStatus = self.call("paranoid_getObjectStatus", json!([self.opening_hex, tracked]))?;
                tip = tip.max(st.tip_height);
                match st.slot {
                    Some(s) if s.slot_index == tracked => {
                        if !s.empty {
                            instances.push(NoidInstanceStatus {
                                instance: NoidInstance { slot_index: s.slot_index, creation_id: s.creation_id, amount_micronoid: s.value },
                                matches_opening: Some(st.matches_opening),
                                active_authority: Some(st.active_authority),
                            });
                        }
                        // empty: the instance is closed; it is simply not listed, and `instances_truncated` says the list is partial.
                    }
                    _ => return Err(RpcError::Decode(too_many_coins())),
                }
            }
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
            instances_truncated: truncated,
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
            acknowledge_producer_share: None,
            single_node_loopback: false,
            producer_marker: Default::default(),
        })
    }
}
