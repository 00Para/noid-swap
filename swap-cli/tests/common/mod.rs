//! A tiny two-chain simulator for the scenario and resumption tests.
//!
//! It models only what the engine looks at: a Parano1d tip, the funded
//! instance, a first-seen mempool with branch-flip eviction, inclusion and
//! finality; an Ethereum block clock, one HTLC lock, a pending claim whose
//! calldata exposes the preimage, mining and the `finalized` tag. Both
//! parties' executors share one `World`, so a scenario can check final
//! balances: who ended up with the NOID and who with the ETH.

#![allow(dead_code)]

pub mod http_node;

use std::cell::RefCell;
use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::rc::Rc;

use swap_cli::engine::{Action, ExecError, Executor, Runner, TickReport};
use swap_cli::secret::{LockKind, Secret, Variant};
use swap_cli::state::{Event, Phase};
use swap_cli::params::{ContractVersion, Gates, ProfileName};
use swap_cli::swapfile::{example_public_kind, KdfParams, Passphrase, SwapFile, SwapPublic};
use swap_cli::watch::eth::{compute_lock_id, lock_word_of};
use swap_cli::watch::{EthClaimed, EthLock, EthObservation, EthRefunded, NoidInstance, NoidInstanceStatus, NoidObservation, PendingCall, PendingPreimage, RevertedClaim, WordLock, WordScan};

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum SimKind {
    Claim { preimage: [u8; 32] },
    Refund,
}

#[derive(Clone, Debug)]
pub struct SimTx {
    pub txid: String,
    pub fee: u64,
    pub admitted: u64,
    pub call_height: u64,
    pub kind: SimKind,
}

pub struct World {
    // Parano1d
    pub tip: u64,
    pub deadline: u64,
    pub amount: u64,
    pub bob_noid: String,
    pub alice_noid: String,
    pub hashlock: [u8; 32],
    /// Which Ethereum contract the swap uses: the lock word is SHA-256 of the secret or `Addr(secret)`.
    pub lock_kind: LockKind,
    /// `poseidon` kind: `Locked` logs that carry the lock word and are NOT among the lock lists above (someone else's locks on the same A).
    pub word_locks_extra: Vec<WordLock>,
    /// `poseidon` kind: a still-pending over-long claim of our lock (the contract will revert it, the secret is public).
    pub overlong_claim: Option<PendingPreimage>,
    /// REVIEW-6 R6-3: a claim of our lock that was mined and reverted (named by `--reveal-tx`); the secret is public.
    pub reverted_claim: Option<RevertedClaim>,
    pub instance: Option<NoidInstance>,
    pub funding_pending: Option<u64>,
    /// Incarnation counter of the simulated instance (1 for the first funding, one more at every re-inclusion).
    pub creation_seq: u64,
    pub mempool: Vec<SimTx>,
    pub confirmed: HashMap<String, u64>,
    /// Every close the simulator included, with the instance it spent (so a rollback can put it back).
    pub included: HashMap<String, (SimTx, NoidInstance)>,
    pub evicted: Vec<String>,
    /// `(recipient bech32, amount)` once the instance was closed.
    pub noid_payout: Option<(String, u64)>,
    /// The fee the closing transaction paid, once the instance was closed.
    pub noid_close_fee: Option<u64>,
    /// The contract the swap uses: under v2 the simulator enforces the consensus rule `fee == max_fee` on every
    /// close (the program asserts it), exactly as the real chain would.
    pub contract_version: ContractVersion,
    pub max_fee: u64,
    pub fee_estimate: u64,
    pub fee_floor: u64,
    /// `estimateFeeDetailed.breakdown.relay_floor` as the node would report it; `None` (the default) = no breakdown.
    pub relay_floor: Option<u64>,
    pub epoch_anchor: [u8; 32],
    /// What a healthy Ethereum node reports (pinned in the swap file): the simulator's
    /// observations are complete, so only a scenario's own knob can make a field unknown.
    pub eth_chain_id: u64,
    pub eth_code_hash: Option<[u8; 32]>,
    pub claim_authority: String,
    /// Scenario knob: nothing gets included while true (congestion / stall).
    pub freeze_inclusion: bool,
    /// REVIEW-2 F10 knobs: other instances at the contract root, listed before / after the real one (slot order).
    /// They are never closed by the simulator; they only show up in the observation.
    pub instances_before: Vec<NoidInstance>,
    pub instances_after: Vec<NoidInstance>,
    /// REVIEW-2 F10 knobs: other matching locks on Ethereum, listed before / after the real one (log order).
    pub locks_before: Vec<EthLock>,
    pub locks_after: Vec<EthLock>,
    /// REVIEW-2 F9 knob: a pending `claim` is not mined while true (a stalled Ethereum inclusion); refunds still are.
    pub freeze_eth_claim: bool,
    /// REVIEW-2 F5 knobs. `tip_time_lag`: the Parano1d tip header says it is this many seconds old (`None` = the node has
    /// no header method, `tip_time` unknown: REVIEW-3 F5 makes that a blocker, so the default is a fresh time, `Some(0)`). `single_node`: no second node is configured; by default every observation
    /// carries a second node that agrees with the first, and the `second_*` knobs make it differ.
    pub tip_time_lag: Option<u64>,
    pub single_node: bool,
    pub single_node_ok: bool,
    /// The second Parano1d node's tip is this many blocks behind the first.
    pub second_tip_lag: u64,
    /// `Some(x)`: the second Parano1d node shows `x` as the instance (`Some(None)` = no instance) instead of the real one.
    pub second_instance: Option<Option<NoidInstance>>,
    /// The second Ethereum node's `finalized` height differs by this much (negative = behind).
    pub second_finalized_delta: i64,
    /// The second Ethereum node shows the lock after this edit.
    pub second_lock_tamper: Option<fn(&mut EthLock)>,
    pub second_lock_hidden: bool,
    /// A configured second node that cannot be read (the reason).
    pub second_unreadable: Option<String>,
    /// The Ethereum node's `latest` block is this many seconds older than the chain clock (a lagging node).
    pub eth_head_lag: u64,
    seq: u64,
    // Ethereum
    pub eth_block: u64,
    pub eth_time: u64,
    pub finality_lag: u64,
    pub lock: Option<EthLock>,
    pub lock_pending: Option<EthLock>,
    pub lock_count: u32,
    pub claimed: Option<EthClaimed>,
    pub refunded: Option<EthRefunded>,
    /// REVIEW-3 F7: the node's log index lags: a mined claim is visible only in the `getLock` record (no `Claimed` log).
    pub claim_log_lag: bool,
    /// REVIEW-4 R4-7: the same for Bob's refund: visible only in the `getLock` record (flag set, block = the poll's head, no tx hash).
    pub refund_log_lag: bool,
    pub claim_pending: Option<PendingPreimage>,
    pub refund_pending: bool,
    /// `(address, wei)` once the lock was closed.
    pub eth_payout: Option<([u8; 20], u128)>,
    pub log: Vec<String>,
}

impl World {
    pub fn new(public: &SwapPublic, tip: u64, eth_time: u64) -> Rc<RefCell<World>> {
        Rc::new(RefCell::new(World {
            tip,
            deadline: public.params.deadline_height,
            amount: public.params.amount_micronoid,
            bob_noid: public.params.bob_noid.clone(),
            alice_noid: public.params.alice_noid.clone(),
            hashlock: public.hashlock,
            lock_kind: public.params.eth.lock_kind,
            word_locks_extra: Vec::new(),
            overlong_claim: None,
            reverted_claim: None,
            instance: None,
            funding_pending: None,
            creation_seq: 0,
            mempool: Vec::new(),
            confirmed: HashMap::new(),
            included: HashMap::new(),
            evicted: Vec::new(),
            noid_payout: None,
            noid_close_fee: None,
            contract_version: public.params.contract_version,
            max_fee: public.params.max_fee_micronoid,
            fee_estimate: 6_000,
            fee_floor: 5_800,
            relay_floor: None,
            epoch_anchor: [7; 32],
            eth_chain_id: public.params.eth.chain_id,
            eth_code_hash: public.params.eth.code_hash,
            claim_authority: public.claim_authority.clone(),
            freeze_inclusion: false,
            instances_before: Vec::new(),
            instances_after: Vec::new(),
            locks_before: Vec::new(),
            locks_after: Vec::new(),
            freeze_eth_claim: false,
            tip_time_lag: Some(0),
            single_node: false,
            single_node_ok: false,
            second_tip_lag: 0,
            second_instance: None,
            second_finalized_delta: 0,
            second_lock_tamper: None,
            second_lock_hidden: false,
            second_unreadable: None,
            eth_head_lag: 0,
            seq: 0,
            eth_block: 100,
            eth_time,
            finality_lag: 2,
            lock: None,
            lock_pending: None,
            lock_count: 0,
            claimed: None,
            claim_log_lag: false,
            refund_log_lag: false,
            refunded: None,
            claim_pending: None,
            refund_pending: false,
            eth_payout: None,
            log: Vec::new(),
        }))
    }

    fn next_id(&mut self) -> String {
        self.seq += 1;
        format!("{:064x}", self.seq)
    }

    pub fn noid_obs(&self, tracked: Option<&str>) -> NoidObservation {
        let mut obs = self.noid_view(tracked);
        obs.single_node_ok = self.single_node_ok;
        if self.single_node {
            return obs;
        }
        if let Some(e) = &self.second_unreadable {
            obs.second_error = Some(e.clone());
            return obs;
        }
        // The second node: the same chain as seen through another provider, with the knobs applied.
        let mut second = self.noid_view(None);
        second.tip = self.tip.saturating_sub(self.second_tip_lag);
        second.next_call_height = second.tip + 1;
        if let Some(inst) = &self.second_instance {
            second.instance = inst.clone();
            second.instance_matches_opening = inst.as_ref().map(|_| true);
            second.active_authority = inst.as_ref().map(|_| self.claim_authority.clone());
            second.instances = Vec::new();
            second.instance_count = usize::from(inst.is_some());
        }
        obs.second = Some(Box::new(second));
        obs
    }

    /// One node's view of Parano1d (no second opinion attached).
    fn noid_view(&self, tracked: Option<&str>) -> NoidObservation {
        // The list of instances is filled only when a scenario added extras (a hand-built single instance reads as a list
        // of one, so the older scenarios' degrade closures keep working on the legacy fields).
        let mut listed: Vec<NoidInstance> = self.instances_before.clone();
        listed.extend(self.instance.clone());
        listed.extend(self.instances_after.clone());
        let extras = !self.instances_before.is_empty() || !self.instances_after.is_empty();
        let first = listed.first().cloned();
        NoidObservation {
            observed_at: Some(self.eth_time),
            tip: self.tip,
            next_call_height: self.tip + 1,
            epoch_anchor: Some(self.epoch_anchor),
            fee_floor: Some(self.fee_floor),
            fee_estimate_1_1: Some(self.fee_estimate),
            relay_floor: self.relay_floor,
            instance: first.clone(),
            instance_matches_opening: first.as_ref().map(|_| true),
            active_authority: first.as_ref().map(|_| self.claim_authority.clone()),
            instances: if extras {
                listed
                    .iter()
                    .map(|i| NoidInstanceStatus { instance: i.clone(), matches_opening: Some(true), active_authority: Some(self.claim_authority.clone()) })
                    .collect()
            } else {
                Vec::new()
            },
            instance_count: listed.len(),
            pending_calls: self
                .mempool
                .iter()
                .map(|t| PendingCall { txid: t.txid.clone(), fee_micronoid: t.fee, admitted_height: t.admitted })
                .collect(),
            confirmed_tx: tracked.and_then(|t| {
                self.confirmed.get(t).map(|h| swap_cli::watch::ConfirmedTx { txid: t.to_string(), height: *h })
            }),
            tracked_tx_pending: tracked.map(|t| self.mempool.iter().any(|m| m.txid == t)),
            // CHAOS F-15: the simulator can tell (a real node cannot: see `NoidObservation::funding_pending`).
            funding_pending: Some(self.funding_pending.is_some()),
            tip_time: self.tip_time_lag.map(|l| self.eth_time.saturating_sub(l)),
            second: None,
            second_error: None,
            second_label: None,
            single_node_ok: false,
        }
    }

    pub fn eth_obs(&self) -> EthObservation {
        let mut obs = self.eth_view();
        obs.single_node_ok = self.single_node_ok;
        if self.single_node {
            return obs;
        }
        if let Some(e) = &self.second_unreadable {
            obs.second_error = Some(e.clone());
            return obs;
        }
        let mut second = self.eth_view();
        second.finalized_block = second.finalized_block.map(|f| f.saturating_add_signed(self.second_finalized_delta));
        if self.second_lock_hidden {
            second.lock = None;
            second.locks = Vec::new();
            second.lock_count = 0;
        } else if let Some(tamper) = self.second_lock_tamper {
            for l in second.lock.iter_mut().chain(second.locks.iter_mut()) {
                tamper(l);
            }
        }
        obs.second = Some(Box::new(second));
        obs
    }

    /// One node's view of Ethereum (no second opinion attached).
    fn eth_view(&self) -> EthObservation {
        let mut all: Vec<EthLock> = self.locks_before.clone();
        all.extend(self.lock.clone());
        all.extend(self.locks_after.clone());
        let extras = !self.locks_before.is_empty() || !self.locks_after.is_empty();
        EthObservation {
            observed_at: Some(self.eth_time),
            latest_block: self.eth_block,
            latest_timestamp: self.eth_time.saturating_sub(self.eth_head_lag),
            finalized_block: Some(self.eth_block.saturating_sub(self.finality_lag)),
            chain_id: Some(self.eth_chain_id),
            contract_code_hash: self.eth_code_hash,
            lock: if extras { all.first().cloned() } else { self.lock.clone() },
            locks: if extras { all.clone() } else { Vec::new() },
            lock_count: all.len(),
            claimed: if self.claim_log_lag {
                self.claimed.as_ref().map(|c| EthClaimed { block_number: self.eth_block, tx_hash: [0; 32], ..c.clone() })
            } else {
                self.claimed.clone()
            },
            refunded: if self.refund_log_lag {
                self.refunded.as_ref().map(|r| EthRefunded { block_number: self.eth_block, tx_hash: [0; 32], ..r.clone() })
            } else {
                self.refunded.clone()
            },
            claim_state_from_record: (self.claim_log_lag && self.claimed.is_some()) || (self.refund_log_lag && self.refunded.is_some()),
            pending_preimage: self.claim_pending.clone(),
            overlong_claim: self.overlong_claim.clone(),
            word_locks: if self.lock_kind == LockKind::Poseidon {
                all.iter()
                    .map(|l| WordLock { lock_id: l.lock_id, sender: l.sender, receiver: l.receiver, amount_wei: l.amount_wei, timelock: l.timelock, block_number: l.block_number })
                    .chain(self.word_locks_extra.iter().cloned())
                    .collect()
            } else {
                Vec::new()
            },
            // REVIEW-3 F3: the signer's nonce; a send the operator made that is not mined yet (lock, reveal, refund) is
            // one transaction in the node's mempool, so `pending` is one above `latest`.
            // REVIEW-6 R6-1: the simulator's scan is always complete (the watcher tests cover the failing ones).
            word_scan: if self.lock_kind == LockKind::Poseidon { WordScan::Complete } else { WordScan::NotRun },
            reverted_claim: self.reverted_claim.clone(),
            reveal_tx_note: None,
            signer_nonce_latest: Some(7),
            signer_nonce_pending: Some(7 + u64::from(self.lock_pending.is_some() || self.claim_pending.is_some() || self.refund_pending)),
            second: None,
            second_error: None,
            second_label: None,
            single_node_ok: false,
        }
    }

    /// Mine `blocks` Parano1d blocks: funding lands, valid pending calls are
    /// included (unless frozen), calls whose branch flips next are evicted.
    pub fn advance_noid(&mut self, blocks: u64) {
        for _ in 0..blocks {
            self.tip += 1;
            let h = self.tip;
            if let Some(amount) = self.funding_pending.take() {
                // A (re-)minted funding gets a fresh incarnation, as the chain's allocation counter would give it.
                self.creation_seq += 1;
                self.instance = Some(NoidInstance { slot_index: 7, creation_id: self.creation_seq, amount_micronoid: amount });
                self.log.push(format!("noid {h}: funded"));
            }
            if !self.freeze_inclusion && self.instance.is_some() {
                let valid = self.mempool.iter().position(|t| match t.kind {
                    SimKind::Claim { .. } => h < self.deadline,
                    SimKind::Refund => h >= self.deadline,
                });
                if let Some(i) = valid {
                    let tx = self.mempool.remove(i);
                    let inst = self.instance.take().unwrap();
                    let (to, amount) = match tx.kind {
                        SimKind::Claim { preimage } => {
                            assert_eq!(lock_word_of(self.lock_kind, &preimage), self.hashlock, "simulator: claim with a wrong preimage");
                            (self.bob_noid.clone(), inst.amount_micronoid - tx.fee)
                        }
                        SimKind::Refund => (self.alice_noid.clone(), inst.amount_micronoid - tx.fee),
                    };
                    if self.contract_version.is_fixed_fee() {
                        assert_eq!(tx.fee, self.max_fee, "simulator: a v2 close must pay exactly max_fee");
                    }
                    self.confirmed.insert(tx.txid.clone(), h);
                    self.included.insert(tx.txid.clone(), (tx.clone(), inst.clone()));
                    self.noid_payout = Some((to, amount));
                    self.noid_close_fee = Some(tx.fee);
                    self.log.push(format!("noid {h}: included {} paying {}", tx.txid, self.noid_payout.as_ref().unwrap().0));
                    // The slot is gone: everything else is now invalid.
                    for other in self.mempool.drain(..) {
                        self.evicted.push(other.txid);
                    }
                }
            }
            // Eviction at the branch flip (`contracts.rs`): a claim pending when the next height is D.
            let d = self.deadline;
            let (keep, gone): (Vec<_>, Vec<_>) = self.mempool.drain(..).partition(|t| match t.kind {
                SimKind::Claim { .. } => h + 1 < d,
                SimKind::Refund => true,
            });
            self.mempool = keep;
            for t in gone {
                self.log.push(format!("noid {h}: evicted {}", t.txid));
                self.evicted.push(t.txid);
            }
        }
    }

    /// F6 knob: a rollback drops the confirmed close `txid`. The instance is live again and the payout is undone.
    /// With `back_to_mempool` the transaction is pending again (the node re-admitted it); otherwise it is gone.
    /// The tip does not move (the scenario advances it as it likes).
    pub fn drop_close(&mut self, txid: &str, back_to_mempool: bool) {
        let (tx, inst) = self.included.remove(txid).expect("drop_close: that transaction was not included by the simulator");
        assert!(self.confirmed.remove(txid).is_some(), "drop_close: not confirmed");
        assert!(self.instance.is_none(), "drop_close: the instance is not spent");
        self.instance = Some(inst);
        self.noid_payout = None;
        self.noid_close_fee = None;
        if back_to_mempool {
            self.mempool.push(tx);
        }
        self.log.push(format!("noid: rollback dropped {txid} (back to mempool: {back_to_mempool})"));
    }

    /// F6 knob: the confirmed close `txid` is now reported at another height (re-included after a rollback).
    pub fn move_close(&mut self, txid: &str, new_height: u64) {
        let h = self.confirmed.get_mut(txid).expect("move_close: not confirmed");
        *h = new_height;
    }

    /// M2.5d knob: somebody closes the instance outside the engine (the wallet CLI) in the next block. Alice's
    /// recovery close if `refund`, else a claim by Bob. Returns the txid. The pending mempool is untouched.
    pub fn close_outside(&mut self, refund: bool, preimage: Option<[u8; 32]>) -> String {
        self.tip += 1;
        let h = self.tip;
        let inst = self.instance.take().expect("close_outside: no instance");
        let id = self.next_id();
        let fee = if self.contract_version.is_fixed_fee() { self.max_fee } else { self.fee_estimate };
        let kind = if refund { SimKind::Refund } else { SimKind::Claim { preimage: preimage.expect("a claim needs the preimage") } };
        let tx = SimTx { txid: id.clone(), fee, admitted: h - 1, call_height: h, kind };
        let to = if refund { self.alice_noid.clone() } else { self.bob_noid.clone() };
        self.confirmed.insert(id.clone(), h);
        self.included.insert(id.clone(), (tx, inst.clone()));
        self.noid_payout = Some((to, inst.amount_micronoid - fee));
        self.noid_close_fee = Some(fee);
        self.log.push(format!("noid {h}: closed outside the engine by {id}"));
        id
    }

    /// Drop every pending call without including it (an anchor rotation or a reorg).
    pub fn evict_all(&mut self) {
        for t in self.mempool.drain(..) {
            self.evicted.push(t.txid);
        }
    }

    /// Mine `blocks` Ethereum blocks of 12 s: a pending lock lands, a pending
    /// claim is mined (or reverts if the timelock passed), a pending refund lands.
    pub fn advance_eth(&mut self, blocks: u64) {
        for _ in 0..blocks {
            self.eth_block += 1;
            self.eth_time += 12;
            if let Some(mut l) = self.lock_pending.take() {
                l.block_number = self.eth_block;
                l.block_timestamp = Some(self.eth_time);
                self.lock_count += 1;
                self.lock = Some(l);
                self.log.push(format!("eth {}: lock mined", self.eth_block));
            }
            if self.freeze_eth_claim && self.claim_pending.is_some() {
                self.log.push(format!("eth {}: claim still pending (stalled)", self.eth_block));
            } else if let Some(p) = self.claim_pending.take() {
                let lock = self.lock.as_mut().expect("claim without a lock");
                if self.eth_time < lock.timelock && !lock.claimed && !lock.refunded {
                    lock.claimed = true;
                    self.claimed = Some(EthClaimed { lock_id: p.lock_id, preimage: p.preimage, block_number: self.eth_block, tx_hash: p.tx_hash });
                    self.eth_payout = Some((lock.receiver, lock.amount_wei));
                    self.log.push(format!("eth {}: claim mined", self.eth_block));
                } else {
                    self.log.push(format!("eth {}: claim REVERTED (TimelockExpired); preimage exposed anyway", self.eth_block));
                }
            }
            if self.refund_pending {
                if let Some(lock) = self.lock.as_mut() {
                    if self.eth_time >= lock.timelock && !lock.claimed && !lock.refunded {
                        lock.refunded = true;
                        self.refund_pending = false;
                        self.refunded = Some(EthRefunded { lock_id: lock.lock_id, block_number: self.eth_block, tx_hash: [0xfe; 32] });
                        self.eth_payout = Some((lock.sender, lock.amount_wei));
                        self.log.push(format!("eth {}: refund mined", self.eth_block));
                    }
                }
            }
        }
    }

    /// Jump the Ethereum clock (then mine one block so the timestamp is visible).
    pub fn warp_eth_to(&mut self, time: u64) {
        assert!(time >= self.eth_time);
        self.eth_time = time - 12;
        self.advance_eth(1);
    }

    /// M2.5b knob: a reorg removed the block that mined Bob's refund. The lock is open again, the payout is undone and
    /// no refund is pending (the transaction is gone; a scenario that wants it back sets `refund_pending`).
    pub fn drop_eth_refund(&mut self) {
        assert!(self.refunded.take().is_some(), "drop_eth_refund: no refund was mined");
        let lock = self.lock.as_mut().expect("drop_eth_refund: no lock");
        lock.refunded = false;
        self.eth_payout = None;
        self.refund_pending = false;
        self.log.push("eth: reorg dropped the refund".to_string());
    }

    /// M2.5b knob: a reorg removed the block that mined Bob's refund and the new chain mined Alice's claim instead (in
    /// the current block). The lock is claimed, the secret is in its `Claimed` log, the ETH goes to Alice.
    pub fn replace_eth_refund_with_claim(&mut self, preimage: [u8; 32]) {
        self.drop_eth_refund();
        let block = self.eth_block;
        let lock = self.lock.as_mut().expect("replace_eth_refund_with_claim: no lock");
        lock.claimed = true;
        let (lock_id, receiver, amount) = (lock.lock_id, lock.receiver, lock.amount_wei);
        self.claimed = Some(EthClaimed { lock_id, preimage, block_number: block, tx_hash: [0xaa; 32] });
        self.eth_payout = Some((receiver, amount));
        self.log.push("eth: reorg replaced the refund by Alice's claim".to_string());
    }
}

/// The scenario executor: applies actions to the shared world. Knobs let a
/// test make a party "offline" for some action kinds, or crash right after
/// the action took effect but before its outcome was recorded.
pub struct SimExecutor {
    pub world: Rc<RefCell<World>>,
    pub secret: Option<Secret>,
    /// Path of the swap file: the executor refuses to act if it does not exist yet.
    pub path: PathBuf,
    pub executed: Vec<Action>,
    pub offline_for: HashSet<&'static str>,
    pub crash_before_effect: HashSet<&'static str>,
    pub crash_after_effect: HashSet<&'static str>,
}

impl SimExecutor {
    pub fn new(world: Rc<RefCell<World>>, secret: Option<Secret>, path: PathBuf) -> Self {
        Self { world, secret, path, executed: Vec::new(), offline_for: HashSet::new(), crash_before_effect: HashSet::new(), crash_after_effect: HashSet::new() }
    }

    pub fn count(&self, kind: &str) -> usize {
        self.executed.iter().filter(|a| a.kind() == kind).count()
    }
}

/// Contract v2 (`HashTimeLockV2`) admits only a close that pays exactly `max_fee`: the program asserts it, and
/// a node rejects anything else before it enters the mempool. v1 has no such rule here (its range is checked by the clients).
fn reject_wrong_fee(w: &World, fee: u64) -> Result<(), ExecError> {
    if w.contract_version.is_fixed_fee() && fee != w.max_fee {
        return Err(ExecError::not_sent(format!("FeeRule: a v2 close must pay exactly max_fee {}, got {fee}", w.max_fee)));
    }
    Ok(())
}

impl Executor for SimExecutor {
    fn execute(&mut self, _file: &SwapFile, action: &Action, now: u64) -> Result<Option<Event>, ExecError> {
        assert!(self.path.exists(), "the swap file must exist before any on-chain action");
        if self.offline_for.contains(action.kind()) {
            return Err(ExecError::not_sent(format!("{} offline", action.kind())));
        }
        if self.crash_before_effect.contains(action.kind()) {
            // Died after recording the intent, before anything was sent: the file cannot know.
            return Err(ExecError::unknown(format!("simulated crash before {}", action.kind())));
        }
        self.executed.push(action.clone());
        let mut w = self.world.borrow_mut();
        let outcome = match action {
            Action::FundNoid { amount_micronoid } => {
                w.funding_pending = Some(*amount_micronoid);
                let id = w.next_id();
                Event::FundingSubmitted { txid: Some(id) }
            }
            Action::LockEth { hashlock, t_reveal, receiver, amount_wei } => {
                let sender = [0xb0; 20];
                let lock_id = compute_lock_id(&sender, receiver, *amount_wei, hashlock, *t_reveal);
                w.lock_pending = Some(EthLock {
                    lock_id,
                    sender,
                    receiver: *receiver,
                    amount_wei: *amount_wei,
                    hashlock: *hashlock,
                    timelock: *t_reveal,
                    block_number: 0,
                    tx_hash: [0xcc; 32],
                    claimed: false,
                    refunded: false,
                    receiver_is_eoa: Some(true),
                    sender_is_eoa: Some(true),
                    block_timestamp: None,
                });
                Event::LockSubmitted { t_reveal: *t_reveal, amount_wei: *amount_wei, tx_hash: Some([0xcc; 32]), at: now }
            }
            Action::RevealEth { lock_id } => {
                let s = self.secret.as_ref().ok_or_else(|| ExecError::not_sent("no secret"))?;
                w.claim_pending = Some(PendingPreimage { lock_id: *lock_id, preimage: *s.bytes(), tx_hash: [0xaa; 32] });
                Event::RevealSubmitted { tx_hash: Some([0xaa; 32]), at: now }
            }
            Action::ClaimNoid { call_height, fee_micronoid, preimage } => {
                reject_wrong_fee(&w, *fee_micronoid)?;
                // First-seen mempool: a second spend of a pending input slot is refused
                // (`SlotConflict`, pool.rs), whatever its fee.
                if !w.mempool.is_empty() {
                    return Err(ExecError::not_sent("SlotConflict: a call on this instance is already pending"));
                }
                let id = w.next_id();
                let admitted = w.tip;
                w.mempool.push(SimTx { txid: id.clone(), fee: *fee_micronoid, admitted, call_height: *call_height, kind: SimKind::Claim { preimage: *preimage } });
                Event::ClaimSubmitted { txid: id, call_height: *call_height }
            }
            Action::RefundEth { .. } => {
                w.refund_pending = true;
                Event::EthRefundSubmitted { tx_hash: Some([0xfe; 32]), at: now }
            }
            Action::RefundNoid { call_height, fee_micronoid } => {
                reject_wrong_fee(&w, *fee_micronoid)?;
                if !w.mempool.is_empty() {
                    return Err(ExecError::not_sent("SlotConflict: a call on this instance is already pending"));
                }
                let id = w.next_id();
                let admitted = w.tip;
                w.mempool.push(SimTx { txid: id.clone(), fee: *fee_micronoid, admitted, call_height: *call_height, kind: SimKind::Refund });
                Event::NoidRefundSubmitted { txid: Some(id), call_height: *call_height }
            }
            Action::Wait { .. } | Action::Abort { .. } => return Ok(None),
        };
        if self.crash_after_effect.contains(action.kind()) {
            return Err(ExecError::unknown(format!("simulated crash after {}", action.kind())));
        }
        Ok(Some(outcome))
    }
}

/// Both parties, their files, and the world.
pub struct Scenario {
    pub dir: tempfile::TempDir,
    pub secret: Secret,
    pub public: SwapPublic,
    pub world: Rc<RefCell<World>>,
    pub alice: Runner<SimExecutor>,
    pub bob: Runner<SimExecutor>,
}

pub const T0: u64 = 1_794_312_000;

/// The Ethereum lock kind the scenario constructors use when a test does not name one: `sha256`, or `poseidon` for the raw variant when the
/// environment variable `SWAP_TEST_LOCK_KIND=poseidon` is set. That runs every raw-variant scenario of a suite against the other contract
/// (`SWAP_TEST_LOCK_KIND=poseidon cargo test --offline --test scenarios`), the cheap way to hold both kinds to the same behaviour.
pub fn default_lock_kind(variant: Variant) -> LockKind {
    match std::env::var("SWAP_TEST_LOCK_KIND").ok().as_deref() {
        Some("poseidon") if variant == Variant::Raw => LockKind::Poseidon,
        _ => LockKind::Sha256,
    }
}

/// The sepolia profile's Ethereum finality (1,140 s) in simulator blocks: the simulator mines an Ethereum
/// block every 12 s and has no time-based finality, so a lock is "final" once `finality_lag` blocks have
/// passed after its own, and 95 blocks x 12 s = 1,140 s. Production scenarios keep the short lag of 2.
pub const SEPOLIA_FINALITY_LAG_BLOCKS: u64 = 1_140 / 12;

impl Scenario {
    /// The production profile (section 9.1): every pre-existing scenario runs here.
    pub fn new(variant: Variant) -> Self {
        Self::with_profile(variant, ProfileName::Production)
    }

    /// The same simulator under a named timing profile; the swap files commit to it.
    pub fn with_profile(variant: Variant, profile: ProfileName) -> Self {
        Self::with_options(variant, profile, ContractVersion::V1)
    }

    /// The production profile on a given contract version (`HashTimeLock` v1 or `HashTimeLockV2`).
    pub fn with_version(variant: Variant, version: ContractVersion) -> Self {
        Self::with_options(variant, ProfileName::Production, version)
    }

    pub fn with_options(variant: Variant, profile: ProfileName, version: ContractVersion) -> Self {
        Self::with_kind(variant, profile, version, default_lock_kind(variant))
    }

    /// The `poseidon` Ethereum lock (raw variant only), production profile, contract v1.
    pub fn poseidon() -> Self {
        Self::with_kind(Variant::Raw, ProfileName::Production, ContractVersion::V1, LockKind::Poseidon)
    }

    /// The simulator for either Ethereum lock kind.
    pub fn with_kind(variant: Variant, profile: ProfileName, version: ContractVersion, kind: LockKind) -> Self {
        let dir = tempfile::tempdir().unwrap();
        let secret = Secret::generate().unwrap();
        let public = example_public_kind(&secret, variant, profile, version, kind);
        let world = World::new(&public, 300_001, T0);
        if profile == ProfileName::Sepolia {
            world.borrow_mut().finality_lag = SEPOLIA_FINALITY_LAG_BLOCKS;
        }
        let pa = dir.path().join("alice.swap.json");
        let pb = dir.path().join("bob.swap.json");
        let alice_file = SwapFile::new_alice(public.clone(), &secret, &Passphrase::new("pw"), &KdfParams::fast_for_tests(), T0).unwrap();
        let bob_file = swap_cli::swapfile::example_bob_file(public.clone(), T0).unwrap();
        let alice = Runner::create(alice_file, pa.clone(), SimExecutor::new(world.clone(), Some(secret.clone()), pa)).unwrap();
        let bob = Runner::create(bob_file, pb.clone(), SimExecutor::new(world.clone(), None, pb)).unwrap();
        Scenario { dir, secret, public, world, alice, bob }
    }

    pub fn now(&self) -> u64 {
        self.world.borrow().eth_time
    }

    /// The gate numbers of the profile both swap files carry.
    pub fn gates(&self) -> &'static Gates {
        self.public.params.profile.gates()
    }

    fn tracked(phase: &Phase) -> Option<String> {
        use swap_cli::state::{AlicePhase, BobPhase};
        match phase {
            Phase::Alice(AlicePhase::RefundSubmitted { txid, .. }) => txid.clone(),
            Phase::Alice(AlicePhase::RefundIncluded { txid, .. }) => Some(txid.clone()),
            Phase::Bob(BobPhase::ClaimSubmitted { txid, .. } | BobPhase::ClaimIncluded { txid, .. }) => Some(txid.clone()),
            _ => None,
        }
    }

    pub fn tick_alice(&mut self) -> TickReport {
        self.tick_alice_with(|_, _| {})
    }

    pub fn tick_bob(&mut self) -> TickReport {
        self.tick_bob_with(|_, _| {})
    }

    /// A tick on observations the closure has degraded (a field made unknown, a timestamp aged).
    pub fn tick_alice_with(&mut self, degrade: impl FnOnce(&mut NoidObservation, &mut EthObservation)) -> TickReport {
        let tracked = Self::tracked(&self.alice.file.phase);
        let (mut noid, mut eth, now) = {
            let w = self.world.borrow();
            (w.noid_obs(tracked.as_deref()), w.eth_obs(), w.eth_time)
        };
        degrade(&mut noid, &mut eth);
        self.alice.tick(&noid, &eth, now).unwrap()
    }

    pub fn tick_bob_with(&mut self, degrade: impl FnOnce(&mut NoidObservation, &mut EthObservation)) -> TickReport {
        let tracked = Self::tracked(&self.bob.file.phase);
        let (mut noid, mut eth, now) = {
            let w = self.world.borrow();
            (w.noid_obs(tracked.as_deref()), w.eth_obs(), w.eth_time)
        };
        degrade(&mut noid, &mut eth);
        self.bob.tick(&noid, &eth, now).unwrap()
    }

    pub fn tick_both(&mut self) -> (TickReport, TickReport) {
        (self.tick_alice(), self.tick_bob())
    }

    pub fn alice_phase(&self) -> String {
        self.alice.file.phase.name()
    }

    pub fn bob_phase(&self) -> String {
        self.bob.file.phase.name()
    }

    /// Reload a party from its file with a fresh executor (a restart).
    pub fn restart_alice(&mut self) {
        let path = self.alice.path.clone();
        let exec = SimExecutor::new(self.world.clone(), Some(self.secret.clone()), path.clone());
        self.alice = Runner::open(path, exec).unwrap();
    }

    pub fn restart_bob(&mut self) {
        let path = self.bob.path.clone();
        let exec = SimExecutor::new(self.world.clone(), None, path.clone());
        self.bob = Runner::open(path, exec).unwrap();
    }

    /// Drive the happy path up to (not including) Alice's reveal.
    pub fn run_to_lock_final(&mut self) {
        let r = self.tick_alice();
        assert_eq!(r.action.kind(), "fund_noid");
        self.world.borrow_mut().advance_noid(1);
        self.tick_both();
        assert_eq!(self.alice_phase(), "funded");
        assert_eq!(self.bob_phase(), "funded");
        self.world.borrow_mut().advance_noid(17);
        let (_, rb) = self.tick_both();
        assert_eq!(self.alice_phase(), "funding_final");
        assert_eq!(rb.action.kind(), "lock_eth", "{:?}", rb);
        assert_eq!(self.bob_phase(), "lock_submitted");
        self.world.borrow_mut().advance_eth(1);
        self.tick_both();
        assert_eq!(self.alice_phase(), "lock_seen");
        assert_eq!(self.bob_phase(), "locked");
        // Bob's lock becomes final `finality_lag` blocks after its own (3 blocks for the short default lag).
        let lag = self.world.borrow().finality_lag;
        self.world.borrow_mut().advance_eth(lag + 1);
    }
}
