//! A node double for the swap wallet tests, whose admission is the vendor chain's own.
//!
//! The real node's admission (`noid_mempool::AsyncMempool::submit`) needs `tokio`, which is not in the offline registry, so it cannot be linked
//! into this crate's tests. This double therefore re-runs, line by line, the checks of `submit_inner` and `run_admission_checks` (read in
//! `vendor/parano1d/noid_mempool/src/pool.rs`), and every check that has a function of its own in the vendor crates calls THAT function:
//! `noid_tx::validate_paged_spend`, `noid_chain::consensus::fee_breakdown`, the exact slot comparison `SlotValue::with_owner_fields`,
//! `ObjectOpening::check_call`, `noid_gkr::wallet_authorization::verify_*_for_version` at `noid_chain::consensus::params::owner_authorization_version`,
//! and, when a block is "mined", the vendor's own state transition `noid_chain::state::apply_tx` and `validate_paged_spend_tx_page_stream` /
//! `validate_block_slot_conflicts`. What is mirrored by hand (the epoch anchor equality, the pool's slot-conflict sets, the byte-canonical match) is
//! small and named below.

#![allow(dead_code)]

use std::collections::{BTreeMap, BTreeSet};
use std::sync::{Arc, Mutex};

use noid_chain::consensus::{fee_breakdown, tx_epoch_anchor_height_for_child, validate_block_slot_conflicts, validate_paged_spend_tx_page_stream};
use noid_chain::fri_state::SlotValue;
use noid_chain::state::{apply_tx, ChainState};
use noid_gkr::wallet_authorization::{verify_experimental_object_authorization_for_version, verify_paged_spend_authorization_for_version, WalletAuthorizationBundle};
use noid_poseidon2b::primitives::Address;
use noid_tx::experimental_object::{ObjectIntent, INTENT_MAGIC};
use noid_tx::{validate_paged_spend, PagedSpendIntent, Transaction, TxPage};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

use swap_cli::client::IntentSubmitter;
use swap_cli::watch::{JsonRpc, RpcError};

/// What the next `submitTxIntent` does, for the unknown-outcome tests.
#[derive(Clone, Debug)]
pub enum Fail {
    /// Admit the transaction, then answer with a timeout (the bytes arrived; the sender cannot know).
    TimeoutAfterAdmit,
    /// Answer with a timeout without looking at it (the bytes never arrived).
    TimeoutBeforeAdmit,
    /// Refuse with this message.
    Refuse(String),
}

pub struct NodeState {
    pub tip: u64,
    pub chain: ChainState,
    /// The node's "owner index": the live slots (the real node keeps a persistent index and verifies each entry against the state).
    pub live: BTreeSet<u32>,
    pub floor: u64,
    /// Admitted transactions in arrival order: (txid, pages, opening for a call).
    pub pool: Vec<Pooled>,
    pub fail: Vec<Fail>,
    /// Every intent hex ever received, in order (for the tests that count sends).
    pub received: Vec<String>,
    /// Transactions that were mined, in order.
    pub mined: Vec<[u8; 32]>,
    /// How many `getSlotsByOwner` etc. were asked (information).
    pub calls: Vec<String>,
    /// Called with every intent hex at the moment it arrives, before anything is decided (to see what exists on disk by then).
    pub hook: Option<Box<dyn Fn(&str) + Send>>,
    /// A fee quote that replaces the node's own for `estimateFeeDetailed(n_in, n_out)` (a node that lies about its fee).
    pub quote: Option<Box<dyn Fn(u64, u64) -> u64 + Send>>,
}

#[derive(Clone)]
pub struct Pooled {
    pub txid: [u8; 32],
    pub pages: Vec<TxPage>,
    pub opening: Option<noid_tx::experimental_object::ObjectOpening>,
}

#[derive(Clone)]
pub struct Node(pub Arc<Mutex<NodeState>>);

fn sha(parts: &[&[u8]]) -> [u8; 32] {
    let mut h = Sha256::new();
    for p in parts {
        h.update(p);
    }
    h.finalize().into()
}

/// The anchor id of the epoch whose anchor block is at `anchor_height` (a stand-in for the block id).
pub fn anchor_id(anchor_height: u64) -> [u8; 32] {
    sha(&[b"anchor", &anchor_height.to_le_bytes()])
}

impl Node {
    pub fn new(tip: u64) -> Self {
        Node(Arc::new(Mutex::new(NodeState {
            tip,
            chain: ChainState::with_log_slots(8),
            live: BTreeSet::new(),
            floor: 0,
            pool: Vec::new(),
            fail: Vec::new(),
            received: Vec::new(),
            mined: Vec::new(),
            calls: Vec::new(),
            hook: None,
            quote: None,
        })))
    }

    pub fn state(&self) -> std::sync::MutexGuard<'_, NodeState> {
        self.0.lock().unwrap()
    }

    pub fn tip(&self) -> u64 {
        self.state().tip
    }

    /// Put a live coin in the state directly (a deposit, a mined coin): returns its creation id.
    pub fn seed(&self, slot: u32, owner: &Address, amount: u64) -> u64 {
        let mut s = self.state();
        s.chain.alloc_counter += 1;
        let cid = s.chain.alloc_counter;
        s.chain.state.set_slot(slot, SlotValue::with_owner_fields(amount, cid, owner.as_fields())).unwrap();
        s.chain.active_slot_count += 1;
        s.chain.circulating_supply_micronoid += u128::from(amount);
        s.live.insert(slot);
        cid
    }

    /// Put a coin with an explicit creation id (a native-asset carrier, a coinbase coin).
    pub fn seed_with_creation_id(&self, slot: u32, owner: &Address, amount: u64, creation_id: u64) {
        let mut s = self.state();
        s.chain.state.set_slot(slot, SlotValue::with_owner_fields(amount, creation_id, owner.as_fields())).unwrap();
        s.chain.active_slot_count += 1;
        s.chain.circulating_supply_micronoid += u128::from(amount);
        s.live.insert(slot);
    }

    /// Jump the tip (time passing without blocks that matter); the state does not change.
    pub fn set_tip(&self, tip: u64) {
        self.state().tip = tip;
    }

    /// A coin leaves the state by a path the wallet did not take (a spend of its own by another program).
    pub fn spend_externally(&self, slot: u32) {
        let mut s = self.state();
        let v = s.chain.state.slot(slot);
        assert!(v != SlotValue::EMPTY, "no coin there");
        s.chain.circulating_supply_micronoid -= u128::from(v.amount());
        s.chain.state.set_slot(slot, SlotValue::EMPTY).unwrap();
        s.chain.active_slot_count -= 1;
        s.live.remove(&slot);
    }

    pub fn on_receive(&self, f: impl Fn(&str) + Send + 'static) {
        self.state().hook = Some(Box::new(f));
    }

    pub fn set_floor(&self, floor: u64) {
        self.state().floor = floor;
    }

    /// From now on `estimateFeeDetailed(n_in, n_out)` answers `f(n_in, n_out)`, whatever the chain's rule says.
    pub fn set_fee_quote(&self, f: impl Fn(u64, u64) -> u64 + Send + 'static) {
        self.state().quote = Some(Box::new(f));
    }

    /// The node's own answers again.
    pub fn clear_fee_quote(&self) {
        self.state().quote = None;
    }

    pub fn fail_next(&self, f: Fail) {
        self.state().fail.push(f);
    }

    /// The live coins of `owner`: (slot, amount, creation id).
    pub fn coins_of(&self, owner: &Address) -> Vec<(u32, u64, u64)> {
        let s = self.state();
        s.live
            .iter()
            .filter_map(|i| {
                let v = s.chain.state.slot(*i);
                (SlotValue::with_owner_fields(v.amount(), v.creation_id(), owner.as_fields()) == v).then(|| (*i, v.amount(), v.creation_id()))
            })
            .collect()
    }

    pub fn balance_of(&self, owner: &Address) -> u64 {
        self.coins_of(owner).iter().map(|c| c.1).sum()
    }

    pub fn pool_len(&self) -> usize {
        self.state().pool.len()
    }

    pub fn received_count(&self) -> usize {
        self.state().received.len()
    }

    /// Mine `n` blocks. Each block includes the pool's transactions in arrival order, as the vendor's state transition accepts them; a transaction whose anchor is not the
    /// block's, or a call whose branch no longer fits the block's height, is evicted (the mempool's own rules).
    pub fn mine(&self, n: u64) {
        for _ in 0..n {
            self.mine_one();
        }
    }

    fn mine_one(&self) {
        let mut s = self.state();
        let child = s.tip + 1;
        let anchor = anchor_id(tx_epoch_anchor_height_for_child(child));
        let pool = std::mem::take(&mut s.pool);
        let mut bodies: Vec<Transaction> = Vec::new();
        let mut included: Vec<Pooled> = Vec::new();
        for p in pool {
            if p.pages[0].body.epoch_anchor != anchor {
                continue; // evicted: wrong anchor
            }
            if let Some(op) = &p.opening {
                match op.check_call(&p.pages[0], child) {
                    Ok(c) if c.authority == op.authority_at(child) => {}
                    _ => continue, // evicted: the branch flipped
                }
            }
            included.push(p);
        }
        for p in &included {
            for page in &p.pages {
                bodies.push(Transaction { body: page.body.clone() });
            }
        }
        // The block-facing checks of the vendor: the page stream is a canonical set of paged spends, and no slot is touched twice in the block.
        let stream: Vec<TxPage> = included.iter().flat_map(|p| p.pages.iter().cloned()).collect();
        if !stream.is_empty() {
            validate_paged_spend_tx_page_stream(&stream).expect("the vendor's page-stream validation");
        }
        validate_block_slot_conflicts(&bodies).expect("no slot touched twice in one block");
        for p in included {
            // Apply on a scratch copy first, so a transaction the state refuses is dropped whole (the pool already rejected conflicts).
            let mut scratch = s.chain.clone();
            let mut ok = true;
            for page in &p.pages {
                if apply_tx(&mut scratch, &page.body).is_err() {
                    ok = false;
                    break;
                }
            }
            if !ok {
                continue;
            }
            // Keep the owner index in step with what the vendor's transition did.
            for page in &p.pages {
                for (_, i) in page.body.live_inputs() {
                    s.live.remove(&i.slot_index);
                }
                for (_, o) in page.body.live_outputs() {
                    s.live.insert(o.slot_index);
                }
            }
            s.chain = scratch;
            s.mined.push(p.txid);
        }
        s.tip = child;
    }

    /// Drop everything in the pool (a restart of the node, an eviction).
    pub fn clear_pool(&self) {
        self.state().pool.clear();
    }

    fn admit(&self, hex_intent: &str) -> Result<String, RpcError> {
        let rej = |m: String| RpcError::Remote { code: -32000, message: m };
        let mut s = self.state();
        s.received.push(hex_intent.to_string());
        if let Some(h) = &s.hook {
            h(hex_intent);
        }
        let fail = if s.fail.is_empty() { None } else { Some(s.fail.remove(0)) };
        if let Some(Fail::TimeoutBeforeAdmit) = fail {
            return Err(RpcError::Transport("timed out waiting for the reply".into()));
        }
        if let Some(Fail::Refuse(m)) = fail {
            return Err(rej(m));
        }
        let bytes = hex::decode(hex_intent).map_err(|e| rej(format!("malformed intent: {e}")))?;
        let (pages, auth, opening, canonical): (Vec<TxPage>, Vec<u8>, Option<noid_tx::experimental_object::ObjectOpening>, Vec<u8>) = if bytes.starts_with(INTENT_MAGIC) {
            let i = ObjectIntent::from_bytes(&bytes).map_err(|e| rej(format!("malformed intent: {e:?}")))?;
            let canon = i.to_bytes().map_err(|e| rej(format!("malformed intent: {e:?}")))?;
            (i.spend.pages.clone(), i.spend.authorization_bytes.clone(), Some(i.opening.clone()), canon)
        } else {
            let i = PagedSpendIntent::from_bytes(&bytes).map_err(|e| rej(format!("malformed intent: {e:?}")))?;
            let canon = i.to_bytes().map_err(|e| rej(format!("malformed intent: {e:?}")))?;
            (i.pages.clone(), i.authorization_bytes.clone(), None, canon)
        };
        // `canonical_intent_bytes_match`: the retained bytes are the canonical encoding.
        if canonical != bytes {
            return Err(rej("malformed intent: decoded intent does not match retained canonical wire bytes".into()));
        }
        let spend = validate_paged_spend(&pages).map_err(|e| rej(format!("malformed intent: PagedSpend: {e}")))?;
        if opening.is_none() && pages.iter().any(|p| p.body.validity_bitmap & noid_tx::PAGED_SPEND_V2_CONTRACT_MASK != 0) {
            return Err(rej("malformed intent: contract call requires its opening envelope".into()));
        }
        if auth.is_empty() {
            return Err(rej("missing auth authorization for non-coinbase transaction".into()));
        }
        if s.pool.iter().any(|p| p.txid == spend.logical_txid.0) {
            if let Some(Fail::TimeoutAfterAdmit) = fail {
                return Err(RpcError::Transport("timed out waiting for the reply".into()));
            }
            return Err(rej(format!("already admitted: {:?}", spend.logical_txid)));
        }
        let height = s.tip + 1;
        // run_admission_checks: fee, shape, anchor, slot conflicts, live inputs, empty outputs.
        let consensus_required = fee_breakdown(u64::from(spend.live_inputs), u64::from(spend.live_outputs), s.chain.active_slot_count, 8).required_total;
        let required = s.floor.max(consensus_required);
        if spend.fee < required {
            return Err(rej(format!("consensus: BelowMinFee {{ required: {required}, actual: {} }}", spend.fee)));
        }
        if spend.epoch_anchor == [0u8; 32] || spend.epoch_anchor != anchor_id(tx_epoch_anchor_height_for_child(height)) {
            return Err(rej("consensus: BadEpochAnchor".into()));
        }
        let pool_in: BTreeSet<u32> = s.pool.iter().flat_map(|p| p.pages.iter().flat_map(|g| g.body.live_inputs().map(|(_, i)| i.slot_index))).collect();
        let pool_out: BTreeSet<u32> = s.pool.iter().flat_map(|p| p.pages.iter().flat_map(|g| g.body.live_outputs().map(|(_, o)| o.slot_index))).collect();
        for page in &pages {
            for (_, i) in page.body.live_inputs() {
                if pool_in.contains(&i.slot_index) {
                    return Err(rej("consensus: SlotConflict".into()));
                }
            }
            for (_, o) in page.body.live_outputs() {
                if pool_out.contains(&o.slot_index) {
                    return Err(rej("consensus: SlotConflict".into()));
                }
            }
        }
        for page in &pages {
            for (_, i) in page.body.live_inputs() {
                if i.creation_id & noid_tx::native_assets::NATIVE_CREATION_TAG != 0 && i.creation_id & (1 << 63) == 0 {
                    return Err(rej("malformed intent: typed input requires a native envelope".into()));
                }
                if u64::from(i.slot_index) >= s.chain.num_slots() {
                    return Err(rej("consensus: ShapeMismatch(input slot out of range)".into()));
                }
                let expected = SlotValue::with_owner_fields(i.amount, i.creation_id, spend.input_owner.as_fields());
                if s.chain.state.slot(i.slot_index) != expected {
                    return Err(rej("consensus: BadStateRoot".into()));
                }
            }
            for (_, o) in page.body.live_outputs() {
                if u64::from(o.slot_index) >= s.chain.num_slots() {
                    return Err(rej("consensus: ShapeMismatch(output slot out of range)".into()));
                }
                if s.chain.state.slot(o.slot_index) != SlotValue::EMPTY {
                    return Err(rej("consensus: SlotConflict".into()));
                }
            }
        }
        // The contract branch, then the proof, with the version the chain says for this height.
        let bundle = WalletAuthorizationBundle::from_bytes(&auth).map_err(|e| rej(format!("invalid auth authorization: authorization decode: {e}")))?;
        let version = noid_chain::consensus::params::owner_authorization_version(height);
        if let Some(op) = &opening {
            let [page] = pages.as_slice() else {
                return Err(rej("malformed intent: a contract call must contain exactly one page".into()));
            };
            op.check_call(page, height).map_err(|e| rej(format!("malformed intent: {e}")))?;
            verify_experimental_object_authorization_for_version(page, op, height, &bundle, version).map_err(|e| rej(format!("invalid auth authorization: {e:?}")))?;
        } else {
            verify_paged_spend_authorization_for_version(&pages, &bundle, version).map_err(|e| rej(format!("invalid auth authorization: authorization verify: {e:?}")))?;
        }
        s.pool.push(Pooled { txid: spend.logical_txid.0, pages, opening });
        if let Some(Fail::TimeoutAfterAdmit) = fail {
            return Err(RpcError::Transport("timed out waiting for the reply".into()));
        }
        Ok(hex::encode(spend.logical_txid.0))
    }

    fn slot_json(&self, i: u32, owner: &Address) -> Value {
        let s = self.state();
        let v = s.chain.state.slot(i);
        json!({"slot_index": i, "value": v.amount(), "creation_id": v.creation_id(), "owner": owner.to_bech32(), "empty": false})
    }
}

impl IntentSubmitter for Node {
    fn submit_tx_intent(&self, intent_hex: &str) -> Result<String, RpcError> {
        self.admit(intent_hex)
    }
}

impl JsonRpc for Node {
    fn call(&self, method: &str, params: Value) -> Result<Value, RpcError> {
        self.state().calls.push(method.to_string());
        let arg = |i: usize| params.get(i).cloned().unwrap_or(Value::Null);
        match method {
            "paranoid_blockCount" => Ok(json!(self.tip())),
            "paranoid_getEpochAnchor" => Ok(json!(hex::encode(anchor_id(tx_epoch_anchor_height_for_child(self.tip() + 1))))),
            "paranoid_estimateFeeDetailed" => {
                let (n_in, n_out) = (arg(0).as_u64().unwrap_or(0), arg(1).as_u64().unwrap_or(0));
                let s = self.state();
                let b = fee_breakdown(n_in, n_out, s.chain.active_slot_count, 8);
                let fee = match &s.quote {
                    Some(q) => q(n_in, n_out),
                    None => b.required_total.max(s.floor),
                };
                Ok(json!({"n_inputs": n_in, "n_outputs": n_out, "fee_micronoid": fee}))
            }
            "paranoid_getSlotHintsSalted" => {
                let count = arg(0).as_u64().unwrap_or(0) as usize;
                let salt = hex::decode(arg(1).as_str().unwrap_or("")).unwrap_or_default();
                let s = self.state();
                let reserved: BTreeSet<u32> = s.pool.iter().flat_map(|p| p.pages.iter().flat_map(|g| g.body.live_outputs().map(|(_, o)| o.slot_index))).collect();
                let n = s.chain.num_slots();
                let mut out = Vec::new();
                let mut k = 0u64;
                while out.len() < count && k < 10_000 {
                    let h = sha(&[&salt, &k.to_le_bytes()]);
                    let idx = (u64::from_le_bytes(h[..8].try_into().unwrap()) % n) as u32;
                    k += 1;
                    if s.chain.state.slot(idx) == SlotValue::EMPTY && !reserved.contains(&idx) && !out.contains(&idx) {
                        out.push(idx);
                    }
                }
                Ok(json!(out))
            }
            "paranoid_getSlotsByOwner" => {
                let owner = Address::parse(arg(0).as_str().unwrap_or("")).map_err(|e| RpcError::Remote { code: -32000, message: format!("invalid address: {e}") })?;
                let list: Vec<Value> = self.coins_of(&owner).iter().map(|c| self.slot_json(c.0, &owner)).collect();
                Ok(json!(list))
            }
            "paranoid_getObjectInstances" => {
                let bytes = hex::decode(arg(0).as_str().unwrap_or("")).map_err(|e| RpcError::Remote { code: -32000, message: e.to_string() })?;
                let opening = noid_tx::experimental_object::ObjectOpening::from_bytes(&bytes).map_err(|e| RpcError::Remote { code: -32000, message: format!("{e:?}") })?;
                let root = opening.root();
                let list: Vec<Value> = self.coins_of(&root).iter().map(|c| self.slot_json(c.0, &root)).collect();
                Ok(json!({"address": root.to_bech32(), "height": self.tip(), "tip_hash": "", "slots": list, "next_slot": null}))
            }
            "paranoid_submitTxIntent" => self.admit(arg(0).as_str().unwrap_or("")).map(Value::String),
            other => Err(RpcError::Remote { code: -32601, message: format!("method not found: {other}") }),
        }
    }
}

/// Group a coins list for assertions.
pub fn amounts(coins: &[(u32, u64, u64)]) -> BTreeMap<u32, u64> {
    coins.iter().map(|c| (c.0, c.1)).collect()
}

// ---------------------------------------------------------------- a swap with a wallet, for the flow tests

use std::path::PathBuf;

use htlc_harness as h;
use swap_cli::params::{self, ContractVersion, ProfileName};
use swap_cli::secret::{LockKind, Secret, Variant};
use swap_cli::state::{AlicePhase, Phase};
use swap_cli::swapfile::{EthParams, KdfParams, Passphrase, SwapFile, SwapPublic};
use swap_cli::wallet::flow::{FlowEnv, StepReport};
use swap_cli::wallet::WalletKey;
use swap_cli::watch::NoidInstance;

/// Alice's swap with a fresh wallet: production profile, 10 NOID, `H_create` 300,000 (so `D` 300,738, the last funding tip 300,078).
pub struct Fx {
    pub node: Node,
    pub key: WalletKey,
    pub file: SwapFile,
    pub dir: tempfile::TempDir,
    pub path: PathBuf,
    pub pass: Passphrase,
    pub payout: Address,
    pub root: Address,
}

pub const AMOUNT: u64 = 10_000_000;
pub const D: u64 = 300_738;

impl Fx {
    pub fn new(tip: u64) -> Fx {
        Self::with_version(tip, ContractVersion::V1)
    }

    pub fn with_version(tip: u64, version: ContractVersion) -> Fx {
        let node = Node::new(tip);
        let key = WalletKey::from_secret(Secret::from_bytes(h::seq_bytes(0x50)));
        let claim_secret = Secret::from_bytes(h::seq_bytes(0x70));
        let cast = h::Cast::new();
        let payout = h::addr(h::seq_bytes(0x90));
        let public = SwapPublic::build_with_options(
            &claim_secret,
            Variant::Raw,
            ProfileName::Production,
            version,
            &key.address(),
            &cast.bob,
            AMOUNT,
            5_800,
            300_000,
            EthParams {
                chain_id: 1,
                contract: [0x11; 20],
                code_hash: Some(params::code_hash_for(LockKind::Sha256)),
                lock_kind: LockKind::Sha256,
                amount_wei: 10u128.pow(16),
                alice_receiver: [0xa1; 20],
                bob_sender: [0xb0; 20],
            },
        )
        .expect("public section");
        let pass = Passphrase::new("a passphrase of enough length");
        let file = SwapFile::new_alice_with_wallet(public, &claim_secret, key.master(), Some(&payout), &pass, &KdfParams::fast_for_tests(), 0).expect("alice file");
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("a.swap.json");
        file.save(&path).unwrap();
        let root = Address::parse(&file.public.contract_root).unwrap();
        Fx { node, key, file, dir, path, pass, payout, root }
    }

    pub fn opening(&self) -> noid_tx::experimental_object::ObjectOpening {
        self.file.public.opening().unwrap()
    }

    /// Run a flow step against the node, with the node as the only submitter when `submit`.
    pub fn step(&self, submit: bool, f: impl FnOnce(&FlowEnv<'_>) -> Result<StepReport, swap_cli::wallet::WalletError>) -> Result<StepReport, swap_cli::wallet::WalletError> {
        let node = self.node.clone();
        let nodes: Vec<(&str, &dyn IntentSubmitter)> = if submit { vec![("n", &node as &dyn IntentSubmitter)] } else { vec![] };
        let env = FlowEnv { swap_path: &self.path, file: &self.file, key: &self.key, rpc: &self.node, nodes: &nodes, submit, now: 1_000 };
        f(&env)
    }

    pub fn fund(&self, submit: bool) -> StepReport {
        self.step(submit, swap_cli::wallet::flow::fund).expect("fund")
    }

    /// The swap file's phase as if the funding had been seen and was final.
    pub fn set_funded(&mut self, instance: &NoidInstance) {
        self.file.phase = Phase::Alice(AlicePhase::FundingFinal { instance: instance.clone(), final_at_tip: 300_000 });
        self.file.save(&self.path).unwrap();
    }

    /// Put the contract's instance at its address (what the funding does) and return it.
    pub fn instance_at_root(&self, slot: u32, amount: u64) -> NoidInstance {
        let cid = self.node.seed(slot, &self.root, amount);
        NoidInstance { slot_index: slot, creation_id: cid, amount_micronoid: amount }
    }

    pub fn record_exists(&self, kind: &str) -> bool {
        PathBuf::from(format!("{}.wallet-{kind}.json", self.path.display())).exists()
    }
}
