//! Read-only questions to a Parano1d node, for the swap wallet.
//!
//! Every answer is checked before it is used and no answer can make this module panic. Method names and shapes are the ones the vendor RPC
//! declares (`vendor/parano1d/noid_rpc`): `paranoid_getSlotsByOwner` (confirmed state only: no height, no pending view), `paranoid_blockCount`,
//! `paranoid_getEpochAnchor`, `paranoid_estimateFeeDetailed`, `paranoid_getSlotHintsSalted` and `paranoid_getObjectInstances`.

use noid_poseidon2b::primitives::Address;
use serde::de::DeserializeOwned;
use serde::Deserialize;
use serde_json::{json, Value};

use super::{fee_ceiling, WalletError};
use crate::watch::{JsonRpc, NoidInstance};

/// One plain NOID coin of the wallet: exactly what a `TxInput` needs.
#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize, Deserialize)]
pub struct WalletSlot {
    pub slot_index: u32,
    pub amount: u64,
    pub creation_id: u64,
}

/// `NATIVE_CREATION_TAG` (`noid_tx::native_assets`): a coin whose creation id carries bit 62 and not bit 63 is a native-asset carrier (a token or
/// an NFT holder), which a plain payment must never spend and which is no NOID to count. Bit 63 marks a coinbase (mined) coin: plain NOID.
const NATIVE_TAG: u64 = noid_tx::native_assets::NATIVE_CREATION_TAG;

/// Is this coin plain NOID (amendment E)? The mempool's own rule: a coin is typed (native) when bit 62 is set and bit 63 is not.
pub fn is_plain(creation_id: u64) -> bool {
    !(creation_id & NATIVE_TAG != 0 && creation_id & (1 << 63) == 0)
}

/// What `getSlotsByOwner` showed for one address: the plain NOID coins, and how many native-asset carriers were left out.
#[derive(Clone, Debug, PartialEq, Eq, Default)]
pub struct SlotView {
    /// Plain coins, ascending by slot index.
    pub plain: Vec<WalletSlot>,
    /// Native-asset carriers: never counted, never spent.
    pub carriers: usize,
}

impl SlotView {
    /// The sum of the plain coins; `None` on overflow (a node that lies, never a real wallet).
    pub fn plain_total(&self) -> Option<u64> {
        self.plain.iter().try_fold(0u64, |acc, s| acc.checked_add(s.amount))
    }

    pub fn contains(&self, slot: &WalletSlot) -> bool {
        self.plain.iter().any(|s| s == slot)
    }
}

#[derive(Deserialize)]
struct SlotRaw {
    slot_index: u32,
    value: u64,
    creation_id: u64,
    owner: String,
    #[serde(default)]
    empty: bool,
}

#[derive(Deserialize)]
struct FeeRaw {
    fee_micronoid: u64,
}

/// The first page keeps the size the tool always asked for (so every recorded fixture still answers); the next ones use the node's maximum.
const INSTANCE_FIRST_PAGE: u32 = 16;
const INSTANCE_PAGE: u32 = 256;
const MAX_INSTANCE_PAGES: usize = 64;
/// The most coins one read lists (the first page plus the later ones).
const MAX_ROOT_COINS: u32 = INSTANCE_FIRST_PAGE + (MAX_INSTANCE_PAGES as u32 - 1) * INSTANCE_PAGE;

#[derive(Deserialize)]
struct InstancesRaw {
    #[serde(default)]
    height: u64,
    slots: Vec<SlotRaw>,
    #[serde(default)]
    next_slot: Option<u32>,
}

#[derive(Deserialize)]
struct ObjectStatusRaw {
    matches_opening: bool,
    #[serde(default)]
    tip_height: u64,
    #[serde(default)]
    slot: Option<SlotRaw>,
}

fn decode<T: DeserializeOwned>(method: &str, v: Value) -> Result<T, WalletError> {
    serde_json::from_value(v).map_err(|e| WalletError::Decode(format!("{method}: {e}")))
}

/// The node reads of the wallet, over any [`JsonRpc`].
pub struct NodeReads<'a> {
    rpc: &'a dyn JsonRpc,
}

impl<'a> NodeReads<'a> {
    pub fn new(rpc: &'a dyn JsonRpc) -> Self {
        Self { rpc }
    }

    /// `paranoid_blockCount`: the tip height.
    pub fn tip(&self) -> Result<u64, WalletError> {
        let v = self.rpc.call("paranoid_blockCount", json!([]))?;
        decode("paranoid_blockCount", v)
    }

    /// `paranoid_getBlockHeader [tip]`: the tip block's own timestamp; `None` when the node cannot show it (a lagging or frozen node is told from it).
    pub fn tip_time(&self, tip: u64) -> Option<u64> {
        let v = self.rpc.call("paranoid_getBlockHeader", json!([tip])).ok()?;
        v.get("timestamp").and_then(Value::as_u64)
    }

    /// `paranoid_getEpochAnchor`: the 32-byte anchor a transaction included in the next block must carry.
    pub fn epoch_anchor(&self) -> Result<[u8; 32], WalletError> {
        let v = self.rpc.call("paranoid_getEpochAnchor", json!([]))?;
        let text: String = decode("paranoid_getEpochAnchor", v)?;
        let bytes = hex::decode(text.trim().strip_prefix("0x").unwrap_or(text.trim())).map_err(|e| WalletError::Decode(format!("paranoid_getEpochAnchor: {e}")))?;
        <[u8; 32]>::try_from(bytes).map_err(|_| WalletError::Decode("paranoid_getEpochAnchor: not 32 bytes".into()))
    }

    /// `paranoid_estimateFeeDetailed [n_in, n_out]`: the fee this node accepts for that shape (state growth and the relay floor included).
    /// This is the only place the wallet takes a fee from a node (the funding, the sweep and both rebuilds, the balance and the recovery fee all
    /// come through here): a fee of zero, or above [`fee_ceiling`] for that shape, is refused, never clamped.
    pub fn fee_for(&self, n_inputs: usize, n_outputs: usize) -> Result<u64, WalletError> {
        let v = self.rpc.call("paranoid_estimateFeeDetailed", json!([n_inputs, n_outputs]))?;
        let fee: FeeRaw = decode("paranoid_estimateFeeDetailed", v)?;
        if fee.fee_micronoid == 0 {
            return Err(WalletError::Decode("paranoid_estimateFeeDetailed: a fee of zero".into()));
        }
        let ceiling = fee_ceiling(n_inputs, n_outputs)?;
        if fee.fee_micronoid > ceiling {
            return Err(WalletError::Decode(format!(
                "the node quotes a fee of {}, above the ceiling {ceiling}; nothing was built",
                fee.fee_micronoid
            )));
        }
        Ok(fee.fee_micronoid)
    }

    /// `paranoid_getSlotHintsSalted [count, salt]`: empty output slots. The salt is the wallet address and fresh random bytes, so two requests
    /// (two attempts) do not get the same hints (amendment I). The hints must be distinct and there must be `count` of them.
    pub fn output_slots(&self, address: &Address, count: usize) -> Result<Vec<u32>, WalletError> {
        let mut salt = address.0.to_vec();
        let mut rnd = [0u8; 16];
        getrandom::getrandom(&mut rnd).map_err(|e| WalletError::Entropy(e.to_string()))?;
        salt.extend_from_slice(&rnd);
        let v = self.rpc.call("paranoid_getSlotHintsSalted", json!([count, hex::encode(salt)]))?;
        let hints: Vec<u32> = decode("paranoid_getSlotHintsSalted", v)?;
        let mut seen = std::collections::BTreeSet::new();
        for h in &hints {
            if !seen.insert(*h) {
                return Err(WalletError::Decode("paranoid_getSlotHintsSalted: the same slot twice".into()));
            }
        }
        if hints.len() < count {
            return Err(WalletError::Decode(format!("paranoid_getSlotHintsSalted: asked for {count} slots, got {}", hints.len())));
        }
        Ok(hints.into_iter().take(count).collect())
    }

    /// `paranoid_getSlotsByOwner [address]`: the coins of `address` in the node's confirmed state, split into plain coins and carriers. Every
    /// entry must name `address` as its owner, be live, and appear once.
    pub fn slots_by_owner(&self, address: &Address) -> Result<SlotView, WalletError> {
        let bech = address.to_bech32();
        let v = self.rpc.call("paranoid_getSlotsByOwner", json!([bech]))?;
        let raw: Vec<SlotRaw> = decode("paranoid_getSlotsByOwner", v)?;
        let mut view = SlotView::default();
        let mut seen = std::collections::BTreeSet::new();
        for s in raw {
            if s.empty {
                continue;
            }
            match Address::parse(&s.owner) {
                Ok(a) if a == *address => {}
                _ => return Err(WalletError::Decode("paranoid_getSlotsByOwner: a coin of another owner in the answer".into())),
            }
            if !seen.insert(s.slot_index) {
                return Err(WalletError::Decode("paranoid_getSlotsByOwner: the same slot twice".into()));
            }
            if s.value == 0 {
                return Err(WalletError::Decode("paranoid_getSlotsByOwner: a live coin of value zero".into()));
            }
            if is_plain(s.creation_id) {
                view.plain.push(WalletSlot { slot_index: s.slot_index, amount: s.value, creation_id: s.creation_id });
            } else {
                view.carriers += 1;
            }
        }
        view.plain.sort_by_key(|s| s.slot_index);
        if view.plain_total().is_none() {
            return Err(WalletError::Decode("paranoid_getSlotsByOwner: the amounts overflow".into()));
        }
        Ok(view)
    }

    /// `paranoid_getObjectInstances`: paginated live coins at the contract's address, and the highest height observed.
    pub fn root_instances(&self, opening_hex: &str) -> Result<(Vec<NoidInstance>, u64), WalletError> {
        self.root_instances_for_slot(opening_hex, None)
    }

    /// Paginated `paranoid_getObjectInstances`, plus a direct `paranoid_getObjectStatus` lookup for `tracked_slot`
    /// if it was not present in the paginated response (so a root dust flood cannot hide a tracked instance).
    pub fn root_instances_for_slot(&self, opening_hex: &str, tracked_slot: Option<u32>) -> Result<(Vec<NoidInstance>, u64), WalletError> {
        let mut from_slot: u32 = 0;
        let mut pages: usize = 0;
        let mut truncated = false;
        let mut height: u64 = 0;
        let mut seen = std::collections::BTreeSet::new();
        let mut instances = Vec::new();
        loop {
            let v = self.rpc.call("paranoid_getObjectInstances", json!([opening_hex, from_slot, if pages == 0 { INSTANCE_FIRST_PAGE } else { INSTANCE_PAGE }]))?;
            let page: InstancesRaw = decode("paranoid_getObjectInstances", v)?;
            height = height.max(page.height);
            for s in page.slots.into_iter().filter(|s| !s.empty) {
                if seen.insert(s.slot_index) {
                    instances.push(NoidInstance { slot_index: s.slot_index, creation_id: s.creation_id, amount_micronoid: s.value });
                }
            }
            match page.next_slot {
                None => break,
                Some(next) => {
                    if next <= from_slot {
                        return Err(WalletError::Decode("paranoid_getObjectInstances: next_slot did not advance".into()));
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
        if truncated {
            // More coins than `MAX_ROOT_COINS`: the swap's own slot is asked for directly and any definite answer (live, empty, another
            // incarnation) stands for it; without a tracked slot, or without a definite answer, the list cannot be judged.
            let cannot_judge = || {
                WalletError::Decode(format!(
                    "paranoid_getObjectInstances: more than {MAX_ROOT_COINS} coins at the contract root and the node gave no definite answer for the swap's own slot: the list cannot be judged"
                ))
            };
            let tracked = tracked_slot.ok_or_else(cannot_judge)?;
            if !seen.contains(&tracked) {
                let v = self.rpc.call("paranoid_getObjectStatus", json!([opening_hex, tracked]))?;
                let st: ObjectStatusRaw = decode("paranoid_getObjectStatus", v)?;
                height = height.max(st.tip_height);
                match st.slot {
                    Some(s) if s.slot_index == tracked => {
                        if !s.empty && st.matches_opening {
                            instances.push(NoidInstance { slot_index: s.slot_index, creation_id: s.creation_id, amount_micronoid: s.value });
                        }
                    }
                    _ => return Err(cannot_judge()),
                }
            }
        }
        Ok((instances, height))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::watch::FixtureRpc;

    fn owner() -> Address {
        htlc_harness::addr(htlc_harness::seq_bytes(9))
    }

    fn slot(i: u32, v: u64, c: u64, o: &Address) -> Value {
        json!({"slot_index": i, "value": v, "creation_id": c, "owner": o.to_bech32(), "empty": false})
    }

    #[test]
    fn plain_means_not_a_native_carrier() {
        assert!(is_plain(1));
        assert!(is_plain(12_345));
        assert!(!is_plain(NATIVE_TAG | 5));
        // a coinbase coin has bit 63 (and any bit 62): plain NOID
        assert!(is_plain((1 << 63) | 77));
        assert!(is_plain((1 << 63) | NATIVE_TAG));
    }

    #[test]
    fn slots_split_into_plain_and_carriers_and_sum_only_the_plain_ones() {
        let o = owner();
        let rpc = FixtureRpc::from_results(
            "n",
            vec![("paranoid_getSlotsByOwner", json!([slot(9, 500, 3, &o), slot(4, 700, NATIVE_TAG | 1, &o), slot(2, 100, (1 << 63) | 40, &o)]))],
        );
        let view = NodeReads::new(&rpc).slots_by_owner(&o).unwrap();
        assert_eq!(view.carriers, 1);
        assert_eq!(view.plain.iter().map(|s| s.slot_index).collect::<Vec<_>>(), vec![2, 9]);
        assert_eq!(view.plain_total(), Some(600));
    }

    #[test]
    fn a_lying_slot_answer_is_refused() {
        let o = owner();
        let other = htlc_harness::addr(htlc_harness::seq_bytes(10));
        let r = |v: Value| NodeReads::new(&FixtureRpc::from_results("n", vec![("paranoid_getSlotsByOwner", v)])).slots_by_owner(&o);
        assert!(r(json!([slot(1, 5, 1, &other)])).is_err(), "another owner");
        assert!(r(json!([slot(1, 5, 1, &o), slot(1, 6, 2, &o)])).is_err(), "the same slot twice");
        assert!(r(json!([slot(1, 0, 1, &o)])).is_err(), "a live coin of value zero");
        assert!(r(json!([slot(1, u64::MAX, 1, &o), slot(2, 1, 1, &o)])).is_err(), "overflow");
        assert!(r(json!("nope")).is_err(), "wrong shape");
        assert!(r(json!([{"slot_index": 1}])).is_err(), "missing fields");
    }

    #[test]
    fn empty_entries_are_skipped_and_an_empty_wallet_is_an_empty_view() {
        let o = owner();
        let rpc = FixtureRpc::from_results("n", vec![("paranoid_getSlotsByOwner", json!([{"slot_index": 3, "value": 0, "creation_id": 0, "owner": o.to_bech32(), "empty": true}]))]);
        let view = NodeReads::new(&rpc).slots_by_owner(&o).unwrap();
        assert!(view.plain.is_empty());
        assert_eq!(view.plain_total(), Some(0));
    }

    #[test]
    fn anchor_fee_tip_and_hints_decode_and_are_checked() {
        let o = owner();
        let rpc = FixtureRpc::from_results(
            "n",
            vec![
                ("paranoid_blockCount", json!(300_000)),
                ("paranoid_getEpochAnchor", json!(hex::encode([7u8; 32]))),
                ("paranoid_estimateFeeDetailed", json!({"fee_micronoid": 9_000, "n_inputs": 1, "n_outputs": 2})),
                ("paranoid_getSlotHintsSalted", json!([5, 6])),
            ],
        );
        let n = NodeReads::new(&rpc);
        assert_eq!(n.tip().unwrap(), 300_000);
        assert_eq!(n.epoch_anchor().unwrap(), [7u8; 32]);
        assert_eq!(n.fee_for(1, 2).unwrap(), 9_000);
        assert_eq!(n.output_slots(&o, 2).unwrap(), vec![5, 6]);
        // the salt is the address plus fresh random bytes
        let log = rpc.calls_made();
        let salted = log.iter().find(|(m, _)| m == "paranoid_getSlotHintsSalted").unwrap();
        let salt = hex::decode(salted.1[1].as_str().unwrap()).unwrap();
        assert_eq!(&salt[..32], &o.0);
        assert_eq!(salt.len(), 48);
    }

    #[test]
    fn bad_anchor_fee_and_hints_are_refused() {
        let o = owner();
        let bad = |m: &str, v: Value| FixtureRpc::from_results("n", vec![(m, v)]);
        assert!(NodeReads::new(&bad("paranoid_getEpochAnchor", json!("abcd"))).epoch_anchor().is_err());
        assert!(NodeReads::new(&bad("paranoid_getEpochAnchor", json!(5))).epoch_anchor().is_err());
        assert!(NodeReads::new(&bad("paranoid_estimateFeeDetailed", json!({"fee_micronoid": 0}))).fee_for(1, 1).is_err());
        assert!(NodeReads::new(&bad("paranoid_getSlotHintsSalted", json!([5, 5]))).output_slots(&o, 2).is_err(), "the same slot twice");
        assert!(NodeReads::new(&bad("paranoid_getSlotHintsSalted", json!([5]))).output_slots(&o, 2).is_err(), "too few");
        assert!(NodeReads::new(&bad("paranoid_blockCount", json!("x"))).tip().is_err());
    }

    #[test]
    fn a_fee_above_the_ceiling_is_refused_and_one_at_the_ceiling_is_taken() {
        let quote = |fee: u64| FixtureRpc::from_results("n", vec![("paranoid_estimateFeeDetailed", json!({"fee_micronoid": fee}))]);
        let ceiling = fee_ceiling(1, 1).unwrap();
        assert_eq!(NodeReads::new(&quote(ceiling)).fee_for(1, 1).unwrap(), ceiling);
        for fee in [ceiling + 1, 2 * ceiling, u64::MAX] {
            let e = NodeReads::new(&quote(fee)).fee_for(1, 1).unwrap_err();
            assert!(matches!(&e, WalletError::Decode(m) if m.contains(&format!("quotes a fee of {fee}, above the ceiling {ceiling}; nothing was built"))), "{e:?}");
        }
    }

    #[test]
    fn root_instances_lists_only_live_coins() {
        let o = owner();
        let rpc = FixtureRpc::from_results(
            "n",
            vec![("paranoid_getObjectInstances", json!({"address": "x", "height": 77, "tip_hash": "", "slots": [slot(8, 900, 4, &o), {"slot_index": 9, "value": 0, "creation_id": 0, "owner": "x", "empty": true}], "next_slot": null}))],
        );
        let (inst, height) = NodeReads::new(&rpc).root_instances("00").unwrap();
        assert_eq!(height, 77);
        assert_eq!(inst, vec![NoidInstance { slot_index: 8, creation_id: 4, amount_micronoid: 900 }]);
    }
}
