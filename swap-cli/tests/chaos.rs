//! Seeded chaos test over the two-chain simulator (`tests/common/mod.rs`).
//!
//! Each scenario is one whole swap, both roles, driven by random interleavings of ticks while a seeded adversary
//! injects world events between them (reorgs, evictions, stalls, a third party closing to Bob, extra instances and
//! locks, stale or missing observation fields, a party offline for some action kinds, crashes before and after an
//! effect). Every tick is checked against the invariants listed in `CHAOS.md`; at the end the chaos stops, a calm
//! settling period runs, and the final state is checked against the chain.
//!
//! Replay: every failure prints its scenario seed; `CHAOS_SEED=<base> CHAOS_ONLY=<index> CHAOS_VERBOSE=1
//! cargo test --offline --test chaos -- --nocapture` reruns just that scenario with its full event log.
//! `CHAOS_N` raises the number of scenarios (default 1,000), `CHAOS_STRICT=1` also fails on documented findings.

mod common;
#[path = "common/chaos_support.rs"]
mod support;

use std::cell::RefCell;
use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};
use std::rc::Rc;
use std::time::Instant;

use common::{SimExecutor, SimKind, SimTx, World, SEPOLIA_FINALITY_LAG_BLOCKS, T0};
use support::{fail, Failure, Rng};
use swap_cli::engine::{cancel_intent, check_external_close_phase, external_close_event, tick_apply, Action, ExecError, Executor, IntentStatus, Runner, INTENT_KINDS};
use swap_cli::params::{ContractVersion, Gates, ProfileName};
use swap_cli::secret::{sha256, Secret, Variant};
use swap_cli::state::{AlicePhase, BobPhase, Event, Phase, Role};
use swap_cli::swapfile::{example_bob_file, example_public_opts, KdfParams, Passphrase, SwapFile, SwapPublic};
use swap_cli::watch::eth::compute_lock_id;
use swap_cli::watch::{EthLock, EthObservation, NoidInstance, NoidObservation, PendingPreimage};

/// Documented findings (CHAOS.md): a violation with one of these ids is reported and counted but does not fail the
/// run unless `CHAOS_STRICT=1`. Any other id fails the test. Empty on purpose.
const KNOWN_FINDINGS: &[&str] = &[];

/// The findings of CHAOS.md that are still OPEN (not fixed). Their symptoms are recorded without failing the run; under
/// `CHAOS_STRICT=1` they fail it like everything else. A finding that was fixed is NOT in this list: its symptom (a soft code, an
/// "explained" end state, a documented gate violation) no longer exists in this file, so a regression is a hard failure with its
/// own invariant id. Every soft code must start with one of these.
const OPEN_FINDINGS: &[&str] = &["F-2", "F-6", "F-7", "F-8", "F-10", "F-11", "F-14"];

/// A party's clock may be this far from the true time (below the engine's 120-s observation staleness limit).
const SKEW_TOL: u64 = 100;
const ALICE: usize = 0;
const BOB: usize = 1;
const MIN_CLOSE_FEE: u64 = 5_800;

// ------------------------------------------------------------------------------------------------ configuration

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Regime {
    /// Every disturbance stays inside the design budget (short outages, ticks at least every 4 minutes, no stall past
    /// the margins): swap atomicity is REQUIRED here.
    Budgeted,
    /// Anything goes (long outages, long stalls, parties that vanish, lying nodes): only the safety invariants are
    /// required; a lost leg must be explained by an adversity that was actually in force.
    Hostile,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Mode {
    /// `Runner::tick` with the simulator's executor (the library's own automatic path).
    Runner,
    /// The CLI path: `tick_apply` + intent ledger, a simulated operator sends what is printed (or forgets, or cancels).
    Cli,
}

fn kinds_of(i: usize) -> [&'static str; 3] {
    if i == ALICE {
        ["fund_noid", "reveal_eth", "refund_noid"]
    } else {
        ["lock_eth", "claim_noid", "refund_eth"]
    }
}

// ------------------------------------------------------------------------------------------------ executor

/// The simulator's executor, except that a close of an instance that is not at the contract is refused (the node has
/// nothing to build the call on) and counted: the simulator itself would queue the ghost call forever.
struct ChaosExec {
    inner: SimExecutor,
    world: Rc<RefCell<World>>,
    closed_instance_attempts: u32,
}

impl ChaosExec {
    fn new(world: Rc<RefCell<World>>, secret: Option<Secret>, path: std::path::PathBuf) -> Self {
        ChaosExec { inner: SimExecutor::new(world.clone(), secret, path), world, closed_instance_attempts: 0 }
    }
}

impl std::ops::Deref for ChaosExec {
    type Target = SimExecutor;
    fn deref(&self) -> &SimExecutor {
        &self.inner
    }
}

impl std::ops::DerefMut for ChaosExec {
    fn deref_mut(&mut self) -> &mut SimExecutor {
        &mut self.inner
    }
}

impl Executor for ChaosExec {
    fn execute(&mut self, file: &SwapFile, action: &Action, now: u64) -> Result<Option<Event>, ExecError> {
        if matches!(action, Action::ClaimNoid { .. } | Action::RefundNoid { .. }) && self.world.borrow().instance.is_none() {
            self.closed_instance_attempts += 1;
            return Err(ExecError::not_sent("no instance at the contract: the node refuses a close of nothing"));
        }
        self.inner.execute(file, action, now)
    }
}

// ------------------------------------------------------------------------------------------------ degraded observations

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Degrade {
    None,
    EpochAnchorNone,
    FeeEstimateNone,
    FeeFloorNone,
    NoidStale,
    EthStale,
    ChainIdNone,
    ChainIdWrong,
    CodeHashNone,
    CodeHashWrong,
    TipTimeNone,
    TipTimeLag,
    EthHeadLag,
    SecondNoidDown,
    SecondNoidTipLag,
    SecondNoidNoInstance,
    SecondEthDown,
    SecondEthTamper,
}

const ALL_DEGRADES: [Degrade; 17] = [
    Degrade::EpochAnchorNone,
    Degrade::FeeEstimateNone,
    Degrade::FeeFloorNone,
    Degrade::NoidStale,
    Degrade::EthStale,
    Degrade::ChainIdNone,
    Degrade::ChainIdWrong,
    Degrade::CodeHashNone,
    Degrade::CodeHashWrong,
    Degrade::TipTimeNone,
    Degrade::TipTimeLag,
    Degrade::EthHeadLag,
    Degrade::SecondNoidDown,
    Degrade::SecondNoidTipLag,
    Degrade::SecondNoidNoInstance,
    Degrade::SecondEthDown,
    Degrade::SecondEthTamper,
];

impl Degrade {
    fn apply(self, n: &mut NoidObservation, e: &mut EthObservation, now: u64) {
        match self {
            Degrade::None => {}
            Degrade::EpochAnchorNone => n.epoch_anchor = None,
            Degrade::FeeEstimateNone => n.fee_estimate_1_1 = None,
            Degrade::FeeFloorNone => n.fee_floor = None,
            Degrade::NoidStale => n.observed_at = Some(now.saturating_sub(200)),
            Degrade::EthStale => e.observed_at = Some(now.saturating_sub(200)),
            Degrade::ChainIdNone => e.chain_id = None,
            Degrade::ChainIdWrong => e.chain_id = Some(1),
            Degrade::CodeHashNone => e.contract_code_hash = None,
            Degrade::CodeHashWrong => e.contract_code_hash = Some([9; 32]),
            Degrade::TipTimeNone => n.tip_time = None,
            Degrade::TipTimeLag => n.tip_time = Some(now.saturating_sub(400)),
            Degrade::EthHeadLag => e.latest_timestamp = e.latest_timestamp.saturating_sub(700),
            Degrade::SecondNoidDown => {
                n.second = None;
                n.second_error = Some("second node down".into());
            }
            Degrade::SecondNoidTipLag => {
                if let Some(s) = n.second.as_mut() {
                    s.tip = s.tip.saturating_sub(5);
                }
            }
            Degrade::SecondNoidNoInstance => {
                if let Some(s) = n.second.as_mut() {
                    s.instance = None;
                    s.instances = Vec::new();
                    s.instance_count = 0;
                }
            }
            Degrade::SecondEthDown => {
                e.second = None;
                e.second_error = Some("second node down".into());
            }
            Degrade::SecondEthTamper => {
                if let Some(s) = e.second.as_mut() {
                    for l in s.lock.iter_mut().chain(s.locks.iter_mut()) {
                        l.amount_wei += 1;
                    }
                }
            }
        }
    }

    /// The action kinds this degradation must keep from going out (the fail-closed rule, `engine::spend_blocker` and
    /// `f5_gate`). A kind absent here is not promised to be blocked; a kind present here must never be emitted.
    fn blocks(self, kind: &str, profile: ProfileName) -> bool {
        const NOID_SIDE: [&str; 5] = ["fund_noid", "lock_eth", "reveal_eth", "claim_noid", "refund_noid"];
        match self {
            Degrade::None => false,
            Degrade::EpochAnchorNone => matches!(kind, "fund_noid" | "refund_noid" | "claim_noid"),
            Degrade::FeeEstimateNone => matches!(kind, "refund_noid" | "claim_noid" | "lock_eth"),
            Degrade::FeeFloorNone => matches!(kind, "refund_noid" | "claim_noid"),
            Degrade::NoidStale => matches!(kind, "fund_noid" | "refund_noid" | "claim_noid" | "lock_eth"),
            Degrade::EthStale => matches!(kind, "lock_eth" | "reveal_eth" | "refund_eth"),
            Degrade::ChainIdNone | Degrade::ChainIdWrong | Degrade::CodeHashNone | Degrade::CodeHashWrong => {
                matches!(kind, "lock_eth" | "reveal_eth" | "refund_eth")
            }
            Degrade::TipTimeNone | Degrade::TipTimeLag => NOID_SIDE.contains(&kind),
            Degrade::EthHeadLag => profile != ProfileName::Rehearsal && matches!(kind, "lock_eth" | "reveal_eth"),
            Degrade::SecondNoidDown | Degrade::SecondNoidTipLag | Degrade::SecondNoidNoInstance => kind == "lock_eth",
            Degrade::SecondEthDown | Degrade::SecondEthTamper => kind == "reveal_eth",
        }
    }
}

// ------------------------------------------------------------------------------------------------ run state

struct Party {
    role: Role,
    runner: Runner<ChaosExec>,
    closed_seen: u32,
    next_tick: u64,
    down_until: u64,
    skew: i64,
    armed_before: HashSet<&'static str>,
    armed_after: HashSet<&'static str>,
    offline_until: HashMap<&'static str, u64>,
    exec_seen: usize,
    terminal: Option<Phase>,
    /// CLI mode: an executed action of the pending intent's kind since the intent was recorded.
    sent_since_intent: bool,
    /// The last action this party printed or performed was `abort`.
    last_abort: bool,
    prev_phase: Option<Phase>,
    /// CLI mode: kinds the simulated operator really sent (cleared when the ledger prints that kind with nothing in flight).
    sent_kinds: HashSet<&'static str>,
    last_action: String,
    ticks: u64,
}

#[derive(Default)]
struct Truth {
    funded_height: Option<u64>,
    funded_ever: bool,
    lock_ever: bool,
    /// `(Parano1d tip, Ethereum time)` when the real secret first appeared on Ethereum (pending calldata or mined).
    secret_public: Option<(u64, u64)>,
    /// Ethereum time of Alice's (first) executed reveal.
    reveal_at: Option<u64>,
}

#[derive(Default)]
struct Episodes {
    freeze_noid_until: u64,
    freeze_claim_until: u64,
    head_lag_until: u64,
    head_lag: u64,
}

#[derive(Default)]
struct Counts {
    funds: u32,
    lock_t_reveals: HashSet<u64>,
    by_kind: BTreeMap<&'static str, u32>,
}

#[derive(Clone)]
struct Snap {
    tip: u64,
    time: u64,
    instance: bool,
    funding_pending: bool,
    lock_pending_t: Option<u64>,
    claim_pending: bool,
    refund_pending: bool,
    refund_in_mempool: bool,
    funding_in_flight: bool,
    mempool_len: usize,
    lock: Option<EthLock>,
    finalized: u64,
    funded_height: Option<u64>,
    secret_public: bool,
    fitting: usize,
}

struct Run {
    rng: Rng,
    regime: Regime,
    mode: Mode,
    profile: ProfileName,
    variant: Variant,
    version: ContractVersion,
    gates: &'static Gates,
    public: SwapPublic,
    secret: Secret,
    world: Rc<RefCell<World>>,
    _dir: tempfile::TempDir,
    parties: [Party; 2],
    truth: Truth,
    ep: Episodes,
    counts: Counts,
    next_noid_at: u64,
    noid_lo: u64,
    noid_hi: u64,
    gap_hi: u64,
    event_pm: u64,
    calm: bool,
    bogus: bool,
    tx_seq: u64,
    log: Vec<String>,
    excuse_bob: BTreeSet<&'static str>,
    excuse_alice: BTreeSet<&'static str>,
    events: BTreeMap<&'static str, u32>,
    degrades: BTreeMap<String, u32>,
    alice_done_to_refund: u32,
    closed_by_recorded: u32,
    cancels_ok: u32,
    cancels_refused: u32,
    restarts: u32,
    intents_recorded: u32,
    foreign_adopted: u32,
    soft: Vec<(&'static str, String)>,
    lock_vanished: bool,
    last_msg: String,
    repeats: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
enum Outcome {
    Swapped,
    BothRefunded,
    NothingLocked,
    NothingFunded,
    Unresolved,
    AliceLoses,
    BobLoses,
}

struct Summary {
    outcome: Outcome,
    ticks: u64,
    excused: Vec<&'static str>,
}

fn tracked_of(phase: &Phase) -> Option<String> {
    match phase {
        Phase::Alice(AlicePhase::RefundSubmitted { txid, .. }) => txid.clone(),
        Phase::Alice(AlicePhase::RefundIncluded { txid, .. }) => Some(txid.clone()),
        Phase::Bob(BobPhase::ClaimSubmitted { txid, .. } | BobPhase::ClaimIncluded { txid, .. }) => Some(txid.clone()),
        _ => None,
    }
}

fn make_lock(public: &SwapPublic, t_reveal: u64, amount_wei: u128, block_ts: u64) -> EthLock {
    let p = &public.params.eth;
    EthLock {
        lock_id: compute_lock_id(&p.bob_sender, &p.alice_receiver, amount_wei, &public.hashlock, t_reveal),
        sender: p.bob_sender,
        receiver: p.alice_receiver,
        amount_wei,
        hashlock: public.hashlock,
        timelock: t_reveal,
        block_number: 1,
        tx_hash: [0xdd; 32],
        claimed: false,
        refunded: false,
        receiver_is_eoa: Some(true),
        sender_is_eoa: Some(true),
        block_timestamp: Some(block_ts),
    }
}

impl Run {
    // -------------------------------------------------------------------------------------------- construction

    fn new(seed: u64) -> Run {
        let mut rng = Rng::new(seed);
        let profile = match rng.below(4) {
            0 | 1 => ProfileName::Production,
            2 => ProfileName::Rehearsal,
            _ => ProfileName::Sepolia,
        };
        let variant = if rng.chance(500) { Variant::Raw } else { Variant::Stock };
        let version = if rng.chance(300) { ContractVersion::V2 } else { ContractVersion::V1 };
        let regime = if rng.chance(450) { Regime::Budgeted } else { Regime::Hostile };
        let mode = if rng.chance(350) { Mode::Cli } else { Mode::Runner };
        let secret = Secret::from_bytes(rng.bytes32());
        let public = example_public_opts(&secret, variant, profile, version);
        let world = World::new(&public, 300_001, T0);
        if profile == ProfileName::Sepolia {
            world.borrow_mut().finality_lag = SEPOLIA_FINALITY_LAG_BLOCKS;
        }
        let dir = tempfile::tempdir().unwrap();
        let pa = dir.path().join("alice.swap.json");
        let pb = dir.path().join("bob.swap.json");
        let alice_file = SwapFile::new_alice(public.clone(), &secret, &Passphrase::new("pw"), &KdfParams::fast_for_tests(), T0).unwrap();
        let bob_file = example_bob_file(public.clone(), T0).unwrap();
        let alice = Runner::create(alice_file, pa.clone(), ChaosExec::new(world.clone(), Some(secret.clone()), pa)).unwrap();
        let bob = Runner::create(bob_file, pb.clone(), ChaosExec::new(world.clone(), None, pb)).unwrap();
        let noid_lo = rng.range(20, 30);
        let noid_hi = noid_lo + rng.range(0, 20);
        let (gap_hi, event_pm) = match regime {
            Regime::Budgeted => (240, 6),
            Regime::Hostile => (1_500, 12),
        };
        // Start times: mostly inside the funding window (Alice must fund, and Bob must see it, before lock-by), sometimes
        // far too late (the "too late to fund" and "last lock height passed" aborts).
        let avail_s = public.params.lock_by_height.saturating_sub(300_001 + 30) * noid_lo;
        let mut start = |rng: &mut Rng| {
            if rng.chance(850) {
                rng.range(0, avail_s * 7 / 10)
            } else {
                rng.range(0, avail_s * 4)
            }
        };
        let (alice_start, bob_start) = (start(&mut rng), start(&mut rng));
        let mk = |role: Role, runner: Runner<ChaosExec>, rng: &mut Rng, start: u64| Party {
            closed_seen: 0,
            role,
            runner,
            next_tick: T0 + start,
            down_until: 0,
            skew: rng.range(0, 2 * SKEW_TOL) as i64 - SKEW_TOL as i64,
            armed_before: HashSet::new(),
            armed_after: HashSet::new(),
            offline_until: HashMap::new(),
            exec_seen: 0,
            terminal: None,
            sent_since_intent: false,
            last_abort: false,
            prev_phase: None,
            sent_kinds: HashSet::new(),
            last_action: String::new(),
            ticks: 0,
        };
        let pa = mk(Role::Alice, alice, &mut rng, alice_start);
        let pb = mk(Role::Bob, bob, &mut rng, bob_start);
        let gates = public.params.profile.gates();
        Run {
            rng,
            regime,
            mode,
            profile,
            variant,
            version,
            gates,
            public,
            secret,
            world,
            _dir: dir,
            parties: [pa, pb],
            truth: Truth::default(),
            ep: Episodes::default(),
            counts: Counts::default(),
            next_noid_at: T0 + 30,
            noid_lo,
            noid_hi,
            gap_hi,
            event_pm,
            calm: false,
            bogus: false,
            tx_seq: 0,
            log: Vec::new(),
            excuse_bob: BTreeSet::new(),
            excuse_alice: BTreeSet::new(),
            events: BTreeMap::new(),
            degrades: BTreeMap::new(),
            alice_done_to_refund: 0,
            closed_by_recorded: 0,
            cancels_ok: 0,
            cancels_refused: 0,
            restarts: 0,
            intents_recorded: 0,
            foreign_adopted: 0,
            soft: Vec::new(),
            lock_vanished: false,
            last_msg: String::new(),
            repeats: 0,
        }
    }

    fn d(&self) -> u64 {
        self.public.params.deadline_height
    }

    fn say(&mut self, msg: impl AsRef<str>) {
        // A tick that repeats the previous one word for word (a party retrying a refused call) is logged once.
        if self.last_msg == msg.as_ref() {
            self.repeats += 1;
            return;
        }
        if self.repeats > 0 {
            self.log.push(format!("    (the previous line repeated {} more times)", self.repeats));
            self.repeats = 0;
        }
        self.last_msg = msg.as_ref().to_string();
        if self.log.len() < 30_000 {
            let (tip, time) = {
                let w = self.world.borrow();
                (w.tip, w.eth_time)
            };
            self.log.push(format!("[+{:>6}s tip {} eth {}] {}", time - T0, tip, self.world.borrow().eth_block, msg.as_ref()));
        }
    }

    fn snap(&self) -> Snap {
        let w = self.world.borrow();
        let amount = self.public.params.amount_micronoid;
        let mut fitting = usize::from(w.instance.as_ref().is_some_and(|i| i.amount_micronoid == amount));
        fitting += w.instances_before.iter().chain(w.instances_after.iter()).filter(|i| i.amount_micronoid == amount).count();
        Snap {
            tip: w.tip,
            time: w.eth_time,
            instance: w.instance.is_some(),
            funding_pending: w.funding_pending.is_some(),
            lock_pending_t: w.lock_pending.as_ref().map(|l| l.timelock),
            claim_pending: w.claim_pending.as_ref().is_some_and(|p| p.preimage == *self.secret.bytes()),
            refund_pending: w.refund_pending,
            refund_in_mempool: w.mempool.iter().any(|t| matches!(t.kind, SimKind::Refund)),
            funding_in_flight: w.funding_pending.is_some(),
            mempool_len: w.mempool.len(),
            lock: w.lock.clone(),
            finalized: w.eth_block.saturating_sub(w.finality_lag),
            funded_height: self.truth.funded_height,
            secret_public: self.truth.secret_public.is_some(),
            fitting,
        }
    }

    // -------------------------------------------------------------------------------------------- time and chains

    fn after_noid_block(&mut self) -> Result<(), Failure> {
        let (tip, has_instance, payout_to_bob, closed) = {
            let w = self.world.borrow();
            (
                w.tip,
                w.instance.is_some(),
                w.noid_payout.as_ref().is_some_and(|(to, _)| *to == self.public.params.bob_noid),
                w.noid_payout.is_some(),
            )
        };
        if has_instance && self.truth.funded_height.is_none() {
            self.truth.funded_height = Some(tip);
            self.truth.funded_ever = true;
        }
        if closed && payout_to_bob && self.truth.secret_public.is_none() {
            return fail("bob-paid-without-public-secret", "the NOID was paid to Bob but the secret was never public on Ethereum");
        }
        if closed {
            let w = self.world.borrow();
            let fee = w.noid_close_fee.unwrap_or(0);
            if fee < MIN_CLOSE_FEE || fee > self.public.params.max_fee_micronoid {
                return fail("close-fee-out-of-range", format!("close fee {fee} outside [{MIN_CLOSE_FEE}, {}]", self.public.params.max_fee_micronoid));
            }
        }
        Ok(())
    }

    fn note_secret(&mut self) {
        if self.truth.secret_public.is_some() {
            return;
        }
        let w = self.world.borrow();
        let real = *self.secret.bytes();
        let public = w.claim_pending.as_ref().is_some_and(|p| p.preimage == real) || w.claimed.is_some();
        if public {
            self.truth.secret_public = Some((w.tip, w.eth_time));
        }
        drop(w);
        if self.truth.secret_public.is_some() {
            self.say("the secret is now public on Ethereum");
        }
    }

    fn sync_episodes(&mut self) {
        let now = self.world.borrow().eth_time;
        {
            let mut w = self.world.borrow_mut();
            w.freeze_inclusion = now < self.ep.freeze_noid_until;
            w.freeze_eth_claim = now < self.ep.freeze_claim_until;
            w.eth_head_lag = if now < self.ep.head_lag_until { self.ep.head_lag } else { 0 };
        }
        for p in self.parties.iter_mut() {
            p.offline_until.retain(|_, until| *until > now);
            p.runner.executor.offline_for = p.offline_until.keys().copied().collect();
        }
    }

    /// Records which adversities were in force while the outcome could still be decided.
    fn note_windows(&mut self) {
        let (tip, time, claim_pending, freeze_inc, freeze_claim) = {
            let w = self.world.borrow();
            (w.tip, w.eth_time, w.claim_pending.is_some(), w.freeze_inclusion, w.freeze_eth_claim)
        };
        if self.truth.secret_public.is_some() && tip < self.d() {
            if freeze_inc {
                self.excuse_bob.insert("noid inclusion frozen");
            }
            let b = &self.parties[BOB];
            if b.down_until > time {
                self.excuse_bob.insert("bob not ticking");
            }
            if b.offline_until.contains_key("claim_noid") {
                self.excuse_bob.insert("bob offline for claim_noid");
            }
        }
        if claim_pending && freeze_claim {
            self.excuse_alice.insert("ethereum claim stalled");
        }
    }

    /// Advance the world by one Ethereum block (12 s) and the Parano1d blocks that fall due in that time.
    fn block(&mut self) -> Result<(), Failure> {
        if self.bogus {
            let real = *self.secret.bytes();
            let mut w = self.world.borrow_mut();
            if w.claim_pending.as_ref().is_some_and(|p| p.preimage != real) {
                w.claim_pending = None;
            }
            self.bogus = false;
        }
        self.sync_episodes();
        self.world.borrow_mut().advance_eth(1);
        self.note_secret();
        loop {
            let t = self.world.borrow().eth_time;
            if t < self.next_noid_at {
                break;
            }
            self.world.borrow_mut().advance_noid(1);
            self.next_noid_at += self.rng.range(self.noid_lo, self.noid_hi);
            self.after_noid_block()?;
        }
        self.note_windows();
        Ok(())
    }

    // -------------------------------------------------------------------------------------------- adversary

    fn excuse_both(&mut self, tag: &'static str) {
        let (tip, d) = (self.world.borrow().tip, self.d());
        if self.truth.secret_public.is_some() && tip < d {
            self.excuse_bob.insert(tag);
        }
        if self.world.borrow().claim_pending.is_some() {
            self.excuse_alice.insert(tag);
        }
    }

    fn event(&mut self) -> Result<(), Failure> {
        let budgeted = self.regime == Regime::Budgeted;
        // (name, weight)
        let menu: [(&'static str, u64); 22] = [
            ("evict_all", 8),
            ("freeze_noid", 6),
            ("freeze_eth_claim", 5),
            ("offline", 10),
            ("down", if budgeted { 0 } else { 5 }),
            ("arm_crash", 10),
            ("noid_reorg_drop", 7),
            ("noid_reinclude", 4),
            ("eth_refund_reorg", 4),
            ("eth_claim_reorg", 4),
            ("eth_lock_reorg", 4),
            ("lock_vanish", if budgeted { 0 } else { 2 }),
            ("third_party_stalled_claim", 4),
            ("third_party_close", 6),
            ("alice_wallet_refund", 3),
            ("dust_instance", 5),
            ("fitting_instance", if budgeted { 2 } else { 4 }),
            ("clear_extras", 3),
            ("side_lock", 6),
            ("bogus_preimage", 4),
            ("funding_reorg", if budgeted { 0 } else { 4 }),
            ("head_lag", 3),
        ];
        let total: u64 = menu.iter().map(|(_, w)| w).sum();
        let mut roll = self.rng.below(total);
        let mut name = menu[0].0;
        for (n, w) in menu {
            if roll < w {
                name = n;
                break;
            }
            roll -= w;
        }
        let (tip, time) = {
            let w = self.world.borrow();
            (w.tip, w.eth_time)
        };
        let d = self.d();
        let long = |rng: &mut Rng, budget: u64, hostile_max: u64, budgeted: bool| if budgeted { rng.range(budget / 4 + 1, budget) } else { rng.log_uniform(budget / 4 + 1, hostile_max) };
        let applied = match name {
            "evict_all" => {
                if budgeted && tip + 40 >= d {
                    false
                } else {
                    self.excuse_both("mempool eviction");
                    self.world.borrow_mut().evict_all();
                    true
                }
            }
            "freeze_noid" => {
                let blocks = long(&mut self.rng, 25, 400, budgeted);
                self.ep.freeze_noid_until = time + blocks * 30;
                self.say(format!("freeze Parano1d inclusion for {blocks} blocks"));
                true
            }
            "freeze_eth_claim" => {
                let secs = long(&mut self.rng, 400, 10_800, budgeted);
                self.ep.freeze_claim_until = time + secs;
                self.say(format!("stall Ethereum claims for {secs} s"));
                true
            }
            "offline" => {
                let i = self.rng.below(2) as usize;
                let kind = self.rng.pick(&kinds_of(i));
                let secs = long(&mut self.rng, 600, 10_800, budgeted);
                self.parties[i].offline_until.insert(kind, time + secs);
                self.say(format!("{} offline for {kind} for {secs} s", self.parties[i].role));
                true
            }
            "down" => {
                let i = self.rng.below(2) as usize;
                let secs = self.rng.log_uniform(300, 14_400);
                self.parties[i].down_until = time + secs;
                self.say(format!("{} stops ticking for {secs} s", self.parties[i].role));
                true
            }
            "arm_crash" => {
                let i = self.rng.below(2) as usize;
                let kind = self.rng.pick(&kinds_of(i));
                if self.rng.chance(500) {
                    self.parties[i].armed_before.insert(kind);
                } else {
                    self.parties[i].armed_after.insert(kind);
                }
                self.say(format!("arm a crash of {} around {kind}", self.parties[i].role));
                true
            }
            "noid_reorg_drop" => self.ev_noid_reorg(budgeted, tip, d),
            "noid_reinclude" => self.ev_noid_reinclude(tip, d),
            "eth_refund_reorg" => self.ev_eth_refund_reorg(),
            "eth_claim_reorg" => self.ev_eth_claim_reorg(budgeted),
            "eth_lock_reorg" => self.ev_eth_lock_reorg(false),
            "lock_vanish" => self.ev_eth_lock_reorg(true),
            "third_party_stalled_claim" => self.ev_third_party(false, budgeted)?,
            "third_party_close" => self.ev_third_party(true, budgeted)?,
            "alice_wallet_refund" => self.ev_alice_wallet_refund()?,
            // The simulator closes only its own real instance, so a foreign instance is injected only once the real one
            // exists (before that the parties would take it for the funding and the simulator could not close it).
            "dust_instance" | "fitting_instance" if self.world.borrow().instance.is_none() || !self.truth.funded_height.is_some_and(|h| tip >= h + 17) => false,
            "dust_instance" => {
                self.tx_seq += 1;
                let inst = NoidInstance { slot_index: 3 + (self.tx_seq % 5) as u32, creation_id: 500 + self.tx_seq, amount_micronoid: 1_000 };
                let mut w = self.world.borrow_mut();
                if self.rng.chance(500) {
                    w.instances_before.push(inst);
                } else {
                    w.instances_after.push(inst);
                }
                drop(w);
                self.say("a dust instance appears at the contract root");
                true
            }
            "fitting_instance" => {
                self.tx_seq += 1;
                let amount = self.public.params.amount_micronoid;
                let inst = NoidInstance { slot_index: 20 + (self.tx_seq % 5) as u32, creation_id: 700 + self.tx_seq, amount_micronoid: amount };
                let mut w = self.world.borrow_mut();
                if self.rng.chance(500) {
                    w.instances_before.push(inst);
                } else {
                    w.instances_after.push(inst);
                }
                drop(w);
                self.say("a second instance with the AGREED amount appears at the contract root");
                true
            }
            "clear_extras" => {
                let mut w = self.world.borrow_mut();
                let any = !w.instances_before.is_empty() || !w.instances_after.is_empty() || !w.locks_before.is_empty() || !w.locks_after.is_empty();
                w.instances_before.clear();
                w.instances_after.clear();
                w.locks_before.clear();
                w.locks_after.clear();
                drop(w);
                if any {
                    self.say("extra instances and locks disappear");
                }
                any
            }
            "side_lock" => {
                self.tx_seq += 1;
                // A lock with the agreed terms except one is Bob's own earlier attempt; the simulator can only hold ONE real
                // lock, so such a phantom is injected only once the real one exists (before that Bob would adopt it).
                let both_recorded = |ph: &Phase| match ph {
                    Phase::Alice(p) => p.lock().is_some(),
                    Phase::Bob(p) => p.lock().is_some(),
                };
                let real_lock = self.world.borrow().lock.is_some()
                    && both_recorded(&self.parties[ALICE].runner.file.phase)
                    && both_recorded(&self.parties[BOB].runner.file.phase);
                let variant = if real_lock { self.rng.below(4) } else { 0 };
                let amount = self.public.params.eth.amount_wei;
                let lock = match variant {
                    0 => make_lock(&self.public, time + 3_000 + self.tx_seq, amount + 1, time),
                    1 => make_lock(&self.public, time + 3_600 + self.tx_seq, amount, time),
                    2 => make_lock(&self.public, time + 600 + self.tx_seq, amount, time),
                    _ => {
                        let mut l = make_lock(&self.public, time + 5_000 + self.tx_seq, amount, time);
                        l.refunded = true;
                        l
                    }
                };
                let mut w = self.world.borrow_mut();
                if self.rng.chance(500) {
                    w.locks_before.push(lock);
                } else {
                    w.locks_after.push(lock);
                }
                drop(w);
                self.say(format!("a second lock of Bob's address appears (variant {variant})"));
                true
            }
            "bogus_preimage" => self.ev_bogus_preimage(),
            "funding_reorg" => self.ev_funding_reorg(tip),
            "head_lag" if self.profile == ProfileName::Rehearsal => false,
            "head_lag" => {
                let secs = self.rng.log_uniform(120, 3_600);
                self.ep.head_lag = self.rng.range(30, if budgeted { 400 } else { 1_500 });
                self.ep.head_lag_until = time + secs;
                self.say(format!("the Ethereum node lags by {} s for {secs} s", self.ep.head_lag));
                true
            }
            _ => false,
        };
        if applied {
            *self.events.entry(name).or_insert(0) += 1;
        }
        Ok(())
    }

    fn ev_alice_wallet_refund(&mut self) -> Result<bool, Failure> {
        let d = self.d();
        let ok = {
            let w = self.world.borrow();
            w.tip + 1 >= d && w.instance.is_some()
        };
        if ok {
            let txid = self.world.borrow_mut().close_outside(true, None);
            self.world.borrow_mut().evict_all();
            self.say(format!("Alice closes with her wallet (recovery) {txid}"));
            self.after_noid_block()?;
        }
        Ok(ok)
    }

    fn ev_bogus_preimage(&mut self) -> bool {
        let bogus = self.rng.bytes32();
        let mut w = self.world.borrow_mut();
        let id = w.lock.as_ref().filter(|l| !l.claimed && !l.refunded).map(|l| l.lock_id);
        match id {
            Some(lock_id) if w.claim_pending.is_none() => {
                w.claim_pending = Some(PendingPreimage { lock_id, preimage: bogus, tx_hash: [0xbb; 32] });
                drop(w);
                self.bogus = true;
                self.say("a bogus preimage sits in the Ethereum mempool for one block");
                true
            }
            _ => false,
        }
    }

    fn ev_funding_reorg(&mut self, tip: u64) -> bool {
        let mut w = self.world.borrow_mut();
        let young = self.truth.funded_height.is_some_and(|h| tip.saturating_sub(h) < 17);
        let no_extras = w.instances_before.is_empty() && w.instances_after.is_empty();
        if w.instance.is_some() && young && no_extras && w.mempool.is_empty() && w.noid_payout.is_none() {
            let amount = w.instance.as_ref().unwrap().amount_micronoid;
            w.instance = None;
            w.funding_pending = Some(amount);
            drop(w);
            self.truth.funded_height = None;
            self.say("a reorg takes the funding back; it is re-included in the next block");
            true
        } else {
            false
        }
    }

    /// Events that need a particular moment (a young close, a public secret, a young lock): rolled once per block while
    /// their precondition holds, so that the reorg cases are actually reached.
    fn opportunities(&mut self) -> Result<(), Failure> {
        let budgeted = self.regime == Regime::Budgeted;
        let (tip, d) = (self.world.borrow().tip, self.d());
        macro_rules! opp {
            ($pm:expr, $name:expr, $call:expr) => {
                if self.rng.chance($pm) && $call {
                    *self.events.entry($name).or_insert(0) += 1;
                }
            };
        }
        opp!(25, "noid_reorg_drop", self.ev_noid_reorg(budgeted, tip, d));
        opp!(15, "noid_reinclude", self.ev_noid_reinclude(tip, d));
        opp!(30, "eth_refund_reorg", self.ev_eth_refund_reorg());
        opp!(30, "eth_claim_reorg", self.ev_eth_claim_reorg(budgeted));
        opp!(30, "eth_lock_reorg", self.ev_eth_lock_reorg(false));
        if !budgeted {
            opp!(6, "lock_vanish", self.ev_eth_lock_reorg(true));
            opp!(20, "funding_reorg", self.ev_funding_reorg(tip));
        }
        opp!(10, "bogus_preimage", self.ev_bogus_preimage());
        opp!(20, "alice_wallet_refund", self.ev_alice_wallet_refund()?);
        opp!(12, "third_party_close", self.ev_third_party(true, budgeted)?);
        opp!(12, "third_party_stalled_claim", self.ev_third_party(false, budgeted)?);
        if !budgeted {
            opp!(8, "stall_reveal", self.ev_stall_reveal());
            opp!(8, "stall_claim", self.ev_stall_claim());
        }
        Ok(())
    }

    /// Alice's reveal is in the Ethereum mempool: congestion keeps it there for a long time (the (I2) margin is 30 min).
    fn ev_stall_reveal(&mut self) -> bool {
        let real = *self.secret.bytes();
        let (pending, time) = {
            let w = self.world.borrow();
            (w.claim_pending.as_ref().is_some_and(|p| p.preimage == real) && !w.freeze_eth_claim, w.eth_time)
        };
        if !pending {
            return false;
        }
        let secs = self.rng.log_uniform(300, 10_800);
        self.ep.freeze_claim_until = time + secs;
        self.say(format!("Alice's reveal is stuck in the Ethereum mempool for {secs} s"));
        true
    }

    /// The secret is public and the instance is still there: Parano1d inclusion stalls (congestion, a starved call).
    fn ev_stall_claim(&mut self) -> bool {
        let (tip, d) = (self.world.borrow().tip, self.d());
        let (live, frozen, time) = {
            let w = self.world.borrow();
            (w.instance.is_some(), w.freeze_inclusion, w.eth_time)
        };
        if !live || frozen || self.truth.secret_public.is_none() || tip + 2 >= d {
            return false;
        }
        let blocks = self.rng.log_uniform(5, 400);
        self.ep.freeze_noid_until = time + blocks * 30;
        self.say(format!("Parano1d inclusion stalls for {blocks} blocks while the instance is still claimable"));
        true
    }

    fn ev_noid_reorg(&mut self, budgeted: bool, tip: u64, d: u64) -> bool {
        if budgeted && tip + 60 >= d {
            return false;
        }
        let pick = {
            let w = self.world.borrow();
            if w.instance.is_some() {
                None
            } else {
                w.confirmed.iter().find(|(_, h)| tip.saturating_sub(**h) < 17).map(|(t, _)| t.clone())
            }
        };
        let Some(txid) = pick else { return false };
        let back = self.rng.chance(500);
        self.excuse_both("Parano1d reorg");
        self.world.borrow_mut().drop_close(&txid, back);
        self.say(format!("Parano1d reorg drops the close {txid} (back to mempool: {back})"));
        true
    }

    fn ev_noid_reinclude(&mut self, tip: u64, d: u64) -> bool {
        let pick = {
            let w = self.world.borrow();
            w.confirmed
                .iter()
                .find(|(_, h)| tip.saturating_sub(**h) < 17 && **h < tip)
                .map(|(t, h)| (t.clone(), *h, matches!(w.included[t].0.kind, SimKind::Claim { .. })))
        };
        let Some((txid, h, is_claim)) = pick else { return false };
        let new_h = self.rng.range(h + 1, tip);
        if (is_claim && new_h >= d) || (!is_claim && new_h < d) {
            return false;
        }
        self.world.borrow_mut().move_close(&txid, new_h);
        self.say(format!("the close {txid} is re-included at height {new_h} (was {h})"));
        true
    }

    fn ev_eth_refund_reorg(&mut self) -> bool {
        let ok = {
            let w = self.world.borrow();
            w.refunded.as_ref().is_some_and(|r| r.block_number > w.eth_block.saturating_sub(w.finality_lag))
        };
        if !ok {
            return false;
        }
        let back = self.rng.chance(500);
        let mut w = self.world.borrow_mut();
        w.drop_eth_refund();
        w.refund_pending = back;
        drop(w);
        self.say(format!("Ethereum reorg drops Bob's refund (transaction back in the mempool: {back})"));
        true
    }

    fn ev_eth_claim_reorg(&mut self, budgeted: bool) -> bool {
        let mut w = self.world.borrow_mut();
        let young = w.claimed.as_ref().is_some_and(|c| c.block_number > w.eth_block.saturating_sub(w.finality_lag));
        let roomy = w.lock.as_ref().is_some_and(|l| l.timelock > w.eth_time + 120);
        if !young || (budgeted && !roomy) {
            return false;
        }
        let c = w.claimed.take().unwrap();
        w.lock.as_mut().unwrap().claimed = false;
        w.eth_payout = None;
        w.claim_pending = Some(PendingPreimage { lock_id: c.lock_id, preimage: c.preimage, tx_hash: c.tx_hash });
        drop(w);
        self.excuse_both("Ethereum claim reorg");
        self.say("Ethereum reorg drops Alice's mined claim (transaction back in the mempool)");
        true
    }

    fn ev_eth_lock_reorg(&mut self, vanish: bool) -> bool {
        let mut w = self.world.borrow_mut();
        let young = w.lock.as_ref().is_some_and(|l| !l.claimed && !l.refunded && l.block_number > w.eth_block.saturating_sub(w.finality_lag));
        if !young || w.claim_pending.is_some() || w.refund_pending || w.claimed.is_some() || w.refunded.is_some() {
            return false;
        }
        let l = w.lock.take().unwrap();
        w.lock_count = w.lock_count.saturating_sub(1);
        if !vanish {
            w.lock_pending = Some(l);
        }
        drop(w);
        self.lock_vanished |= vanish;
        self.say(if vanish { "Ethereum reorg drops Bob's lock for good" } else { "Ethereum reorg drops Bob's lock block; the transaction is mined again" });
        true
    }

    /// A third party that knows the secret (it is public on Ethereum) closes the instance to Bob at the minimum fee:
    /// either straight into a block (`included`) or into the mempool where it can be starved.
    fn ev_third_party(&mut self, included: bool, budgeted: bool) -> Result<bool, Failure> {
        let (tip, d) = (self.world.borrow().tip, self.d());
        let ok = {
            let w = self.world.borrow();
            self.truth.secret_public.is_some() && w.instance.is_some() && w.mempool.is_empty() && tip + 3 < d
        };
        if !ok {
            return Ok(false);
        }
        let preimage = *self.secret.bytes();
        if included {
            let txid = self.world.borrow_mut().close_outside(false, Some(preimage));
            self.world.borrow_mut().evict_all();
            self.say(format!("a third party closes to Bob at the minimum fee: {txid}"));
            // `close_outside` mines a block of its own.
            self.after_noid_block()?;
            Ok(true)
        } else {
            self.tx_seq += 1;
            let mut w = self.world.borrow_mut();
            let fee = if w.contract_version.is_fixed_fee() { w.max_fee } else { w.fee_floor.max(MIN_CLOSE_FEE) };
            let txid = format!("{:064x}", 0xe000_0000u64 + self.tx_seq);
            let admitted = w.tip;
            w.mempool.push(SimTx { txid: txid.clone(), fee, admitted, call_height: tip + 1, kind: SimKind::Claim { preimage } });
            drop(w);
            // Starved: held back from blocks for a while (a minimum-fee call nobody outbids, first-seen mempool).
            if !budgeted && self.rng.chance(600) {
                let blocks = self.rng.log_uniform(5, 400);
                let t = self.world.borrow().eth_time;
                self.ep.freeze_noid_until = t + blocks * 30;
            }
            self.excuse_both("foreign pending close");
            self.say(format!("a third party puts a minimum-fee close to Bob into the mempool: {txid}"));
            Ok(true)
        }
    }

    // -------------------------------------------------------------------------------------------- ticks

    fn pick_degrade(&mut self, i: usize) -> Degrade {
        let pm = match self.regime {
            Regime::Budgeted => 60,
            Regime::Hostile => 140,
        };
        if self.calm || !self.rng.chance(pm) {
            return Degrade::None;
        }
        // The lying-node degradations of the hostile regime only; the budgeted regime keeps to missing/stale fields.
        let mut d = self.rng.pick(&ALL_DEGRADES);
        if d == Degrade::EthHeadLag && self.profile == ProfileName::Rehearsal {
            d = Degrade::None; // the engine skips the head-time rule under the rehearsal profile on purpose
        }
        let _ = i;
        d
    }

    fn operator_closed_by(&mut self, i: usize, now: u64) -> Result<(), Failure> {
        let candidate = {
            let w = self.world.borrow();
            if w.instance.is_some() {
                None
            } else {
                w.confirmed.iter().max_by_key(|(_, h)| **h).map(|(t, _)| t.clone())
            }
        };
        let Some(txid) = candidate else { return Ok(()) };
        let pm = if self.calm { 1000 } else { 450 };
        let file = self.parties[i].runner.file.clone();
        if check_external_close_phase(&file, &txid).is_err() || !self.rng.chance(pm) {
            return Ok(());
        }
        let noid = self.world.borrow().noid_obs(Some(&txid));
        match external_close_event(&file, &noid, &txid) {
            Ok(ev) => {
                let p = &mut self.parties[i];
                p.runner.file.apply(&ev, now).map_err(|e| Failure { id: "engine-error", msg: format!("closed-by event refused: {e}") })?;
                p.runner.file.save(&p.runner.path).unwrap();
                self.closed_by_recorded += 1;
                self.say(format!("{} records the close {txid} with --closed-by", self.parties[i].role));
            }
            Err(_) => {}
        }
        Ok(())
    }

    fn restart(&mut self, i: usize) {
        let secret = if i == ALICE { Some(self.secret.clone()) } else { None };
        let p = &mut self.parties[i];
        let path = p.runner.path.clone();
        let mut exec = ChaosExec::new(self.world.clone(), secret, path.clone());
        exec.offline_for = p.runner.executor.offline_for.clone();
        exec.crash_before_effect = p.armed_before.clone();
        exec.crash_after_effect = p.armed_after.clone();
        p.runner = Runner::open(path, exec).unwrap();
        p.exec_seen = 0;
        p.closed_seen = 0;
        self.restarts += 1;
    }

    fn party_tick(&mut self, i: usize) -> Result<(), Failure> {
        let role = self.parties[i].role;
        let now_true = self.world.borrow().eth_time;
        let now = (now_true as i64 + self.parties[i].skew) as u64;
        let deg = self.pick_degrade(i);
        if deg != Degrade::None {
            *self.degrades.entry(format!("{deg:?}")).or_insert(0) += 1;
            if deg.blocks("claim_noid", self.profile) {
                self.excuse_both("degraded observation");
            }
        }
        // Crashes armed for this party go into its executor (they stay until they fire).
        {
            let p = &mut self.parties[i];
            p.runner.executor.crash_before_effect = p.armed_before.clone();
            p.runner.executor.crash_after_effect = p.armed_after.clone();
        }
        let snap = self.snap();
        self.operator_closed_by(i, now)?;
        let before = self.parties[i].runner.file.phase.clone();
        let tracked = tracked_of(&before);
        let (mut noid, mut eth) = {
            let w = self.world.borrow();
            (w.noid_obs(tracked.as_deref()), w.eth_obs())
        };
        deg.apply(&mut noid, &mut eth, now);

        let (action, exec_error, events) = match self.mode {
            Mode::Runner => {
                let rep = self.parties[i]
                    .runner
                    .tick(&noid, &eth, now)
                    .map_err(|e| Failure { id: "engine-error", msg: format!("{role} Runner::tick returned {e}") })?;
                (rep.action, rep.exec_error, rep.events)
            }
            Mode::Cli => self.tick_cli(i, &noid, &eth, now, &snap)?,
        };
        self.parties[i].ticks += 1;
        self.parties[i].last_abort = matches!(action, Action::Abort { .. });
        self.parties[i].last_action = format!("{action:?}");

        // Effects: every action the executor really performed this tick (read BEFORE any restart replaces the executor).
        let new_actions: Vec<Action> = {
            let p = &mut self.parties[i];
            let seen = p.exec_seen.min(p.runner.executor.executed.len());
            let v = p.runner.executor.executed[seen..].to_vec();
            p.exec_seen = p.runner.executor.executed.len();
            v
        };
        let foreign = self.foreign_recorded(i);
        {
            let p = &mut self.parties[i];
            let n = p.runner.executor.closed_instance_attempts;
            if n > p.closed_seen {
                p.closed_seen = n;
                // A party that adopted a foreign instance of the agreed amount (F-7/F-10) cannot be run to the end here: the simulator
                // can only close its one real instance. Counted by the foreign-adoption bookkeeping, not judged.
                if foreign {
                    // (fall through)
                } else {
                let (wi, wtip) = { let w = self.world.borrow(); (w.instance.clone(), w.tip) };
                return fail(
                    "closes-a-gone-instance",
                    format!(
                        "{role} tried to close an instance that is no longer at the contract (the node refused): CHAOS F-4; action {action:?}, phase {}, observed instances {:?}, world instance {wi:?}, tip {wtip}, degrade {deg:?}",
                        self.parties[i].runner.file.phase.name(),
                        noid.all_instances().iter().map(|v| v.instance.clone()).collect::<Vec<_>>()
                    ),
                );
                }
            }
        }

        // A crash that fired is spent; a restart may follow (a fresh process reading the file).
        if let Some(err) = &exec_error {
            if err.contains("simulated crash") {
                let kind = action.kind();
                let p = &mut self.parties[i];
                p.armed_before.remove(kind);
                p.armed_after.remove(kind);
                p.runner.executor.crash_before_effect.remove(kind);
                p.runner.executor.crash_after_effect.remove(kind);
                if self.rng.chance(750) {
                    self.restart(i);
                }
            }
        }
        if self.rng.chance(if self.calm { 0 } else { 15 }) {
            self.restart(i);
        }

        for a in &new_actions {
            if let Err(f) = self.check_action(i, a, &snap, deg, now_true) {
                let phase = self.parties[i].runner.file.phase.name();
                self.say(format!("{role} (phase before {}, now {phase}, clock skew {}): performed {a:?} -> VIOLATION [{}] {}", before.name(), self.parties[i].skew, f.id, f.msg));
                return Err(f);
            }
        }
        self.note_secret();

        // Phase invariants.
        let after = self.parties[i].runner.file.phase.clone();
        self.check_terminal(i, &after)?;
        if !events.is_empty() || action.has_side_effect() || exec_error.is_some() || new_actions.len() > 0 || before != after {
            let degs = if deg == Degrade::None { String::new() } else { format!(" [degrade {deg:?}]") };
            let err = exec_error.map(|e| format!(" ERR {e}")).unwrap_or_default();
            self.say(format!("{role}: {} -> {} action {}{} events {:?}{err}", before.name(), after.name(), action.kind(), degs, events));
        }
        Ok(())
    }

    /// The CLI path: one `tick_apply`, an operator who sends what is printed (or forgets, or cancels).
    fn tick_cli(&mut self, i: usize, noid: &NoidObservation, eth: &EthObservation, now: u64, snap: &Snap) -> Result<(Action, Option<String>, Vec<String>), Failure> {
        let role = self.parties[i].role;
        let cancel_roll = self.rng.below(100);
        let send_roll = self.rng.below(100);
        // The operator may drop an intent that he did not send (`swap-cli intent FILE --cancel`).
        if self.parties[i].runner.file.pending_intent.is_some() && cancel_roll < 25 {
            let mut work = self.parties[i].runner.file.clone();
            match cancel_intent(&mut work, noid, eth, now) {
                Ok(intent) => {
                    // (A party that adopted a foreign instance cannot see the simulator's real close as its effect: not judged.)
                    if self.parties[i].sent_since_intent && self.effect_in_world(&intent.action) && !self.foreign_recorded(i) {
                        return fail(
                            "ledger-cancel-after-send",
                            {
                                let w = self.world.borrow();
                                format!(
                                    "{role}: `intent --cancel` dropped the {} intent (decided at {}, phase {}) although the operator had sent it; world: instance {:?}, payout {:?}, mempool {}, observed instances {}, pending calls {}, tip {}; funding_pending {:?}; observation: eth locks {}, latest block {}, observed_at {:?} (now {now}), nonces {:?}/{:?}, chain id {:?}, code hash known {}; sim log tail {:?}",
                                    intent.action,
                                    intent.decided_at,
                                    self.parties[i].runner.file.phase.name(),
                                    w.instance,
                                    w.noid_payout,
                                    w.mempool.len(),
                                    noid.all_instances().len(),
                                    noid.pending_calls.len(),
                                    w.tip,
                                    w.funding_pending,
                                    eth.all_locks().len(),
                                    eth.latest_block,
                                    eth.observed_at,
                                    eth.signer_nonce_latest,
                                    eth.signer_nonce_pending,
                                    eth.chain_id,
                                    eth.contract_code_hash.is_some(),
                                    w.log.iter().rev().take(6).collect::<Vec<_>>()
                                )
                            },
                        );
                    }
                    let p = &mut self.parties[i];
                    work.save(&p.runner.path).unwrap();
                    p.runner.file = work;
                    self.cancels_ok += 1;
                    self.parties[i].sent_since_intent = false;
                    self.say(format!("{role} cancels the pending {} intent", intent.action));
                }
                Err(_) => self.cancels_refused += 1,
            }
        }
        let had_intent = self.parties[i].runner.file.pending_intent.clone();
        let mut work = self.parties[i].runner.file.clone();
        let out = tick_apply(&mut work, noid, eth, now, true).map_err(|e| Failure { id: "engine-error", msg: format!("{role} tick_apply returned {e}") })?;
        {
            let p = &mut self.parties[i];
            work.save(&p.runner.path).unwrap();
            p.runner.file = work;
        }
        if let IntentStatus::Recorded(intent) = &out.intent {
            self.intents_recorded += 1;
            let _ = &had_intent;
            self.parties[i].sent_since_intent = false;
            // The ledger must not print a spend the world already shows as done: the gate check covers it.
            self.check_printed(i, &out.decision.action, snap)?;
            let _ = intent;
        }
        if self.parties[i].runner.file.pending_intent.is_none() {
            self.parties[i].sent_since_intent = false;
        }
        let action = out.decision.action.clone();
        let mut exec_error = None;
        let printed_spend = INTENT_KINDS.contains(&action.kind()) && !matches!(out.intent, IntentStatus::None);
        if printed_spend || action.kind() == "claim_noid" {
            if send_roll < 88 {
                let before_len = self.parties[i].runner.executor.executed.len();
                let file_snapshot = self.parties[i].runner.file.clone();
                let res = self.parties[i].runner.executor.execute(&file_snapshot, &action, now);
                let sent = self.parties[i].runner.executor.executed.len() > before_len;
                let pending_kind = self.parties[i].runner.file.pending_intent.as_ref().map(|it| it.action.clone());
                if sent && printed_spend {
                    self.parties[i].sent_kinds.insert(action.kind());
                }
                if sent && printed_spend && pending_kind.as_deref() == Some(action.kind()) {
                    self.parties[i].sent_since_intent = true;
                }
                match res {
                    Ok(Some(ev)) if action.kind() == "claim_noid" => {
                        let p = &mut self.parties[i];
                        p.runner.file.apply(&ev, now).map_err(|e| Failure { id: "engine-error", msg: format!("claim outcome refused: {e}") })?;
                        p.runner.file.save(&p.runner.path).unwrap();
                    }
                    Ok(_) => {}
                    Err(e) => exec_error = Some(e.to_string()),
                }
            } else {
                self.say(format!("{role}'s operator does not send the printed {}", action.kind()));
            }
        }
        let events = out.decision.events.iter().map(|e| e.name()).collect();
        Ok((action, exec_error, events))
    }

    /// A gate violation that is a documented finding (CHAOS.md) under the conditions that produce it: it is recorded and the
    /// scenario goes on. The same id under other conditions stays a hard failure.
    fn documented(&self, f: &Failure) -> Option<&'static str> {
        match f.id {
            // F-8 (still open): a resent lock keeps its recorded T_reveal; only M_A is rechecked, not W_A_min.
            // F-3, F-4, F-13, F-15 were fixed: their gate violations are hard failures again.
            "gate-i3" if f.msg.contains("reveal window") => Some("F-8 lock window can end up below W_A_min (resend, clock skew, node lag)"),
            _ => None,
        }
    }

    /// The party's file recorded an instance that is not the simulator's one real instance (an attacker's deposit of the
    /// agreed amount, adopted as the funding): the simulator cannot answer for it, so the instance gates do not apply.
    fn foreign_recorded(&self, i: usize) -> bool {
        match &self.parties[i].runner.file.phase {
            Phase::Alice(p) => p.instance(),
            Phase::Bob(p) => p.instance(),
        }
        .is_some_and(|inst| inst.slot_index != 7)
    }

    /// Is the effect of a sent `kind` still in the world (in a mempool or on the chain)? A send that a reorg erased for
    /// good is no reason to keep an intent.
    fn effect_in_world(&self, kind: &str) -> bool {
        let w = self.world.borrow();
        match kind {
            "fund_noid" => w.instance.is_some() || w.funding_pending.is_some() || w.noid_payout.is_some(),
            "lock_eth" => w.lock.is_some() || w.lock_pending.is_some(),
            "reveal_eth" => w.claim_pending.is_some() || w.claimed.is_some(),
            "refund_eth" => w.refund_pending || w.refunded.is_some(),
            "refund_noid" => w.noid_payout.is_some() || w.mempool.iter().any(|t| matches!(t.kind, SimKind::Refund)),
            _ => true,
        }
    }

    /// The same gates, applied to a spend the ledger printed (before the operator decides to send it).
    fn check_printed(&mut self, i: usize, a: &Action, s: &Snap) -> Result<(), Failure> {
        if !a.has_side_effect() {
            return Ok(());
        }
        let role = self.parties[i].role;
        // The intent ledger must never print a spend whose first copy is still in flight (not yet mined, not cancelled).
        let in_flight = match a {
            Action::FundNoid { .. } => s.funding_in_flight,
            Action::LockEth { .. } => s.lock_pending_t.is_some(),
            Action::RevealEth { .. } => s.claim_pending,
            Action::RefundEth { .. } => s.refund_pending,
            Action::RefundNoid { .. } => s.refund_in_mempool,
            _ => false,
        };
        let sent_before = self.parties[i].sent_kinds.contains(a.kind());
        if !in_flight {
            self.parties[i].sent_kinds.remove(a.kind());
        }
        if in_flight && sent_before && matches!(a, Action::RefundNoid { .. }) {
            // F-14: a reorg put the already-resolved refund back into the mempool; the ledger forgot it and prints it again.
            self.soft.push(("F-14 ledger prints refund_noid again after a reorg re-queued it", format!("{role}: refund_noid printed again while the first copy is back in the mempool")));
        } else if in_flight && sent_before {
            return fail("ledger-duplicate-print", format!("{role}: the ledger printed a second {} while the first is still in flight", a.kind()));
        }
        if let Err(f) = self.gates_for(i, a, s) {
            match self.documented(&f) {
                Some(code) => self.soft.push((code, format!("{role} (printed): {}", f.msg))),
                None => return Err(f),
            }
        }
        Ok(())
    }

    fn check_action(&mut self, i: usize, a: &Action, s: &Snap, deg: Degrade, _now_true: u64) -> Result<(), Failure> {
        let role = self.parties[i].role;
        let kind = a.kind();
        if deg.blocks(kind, self.profile) {
            return fail("fail-closed", format!("{role} performed {kind} while the observation was degraded by {deg:?}"));
        }
        if let Err(f) = self.gates_for(i, a, s) {
            match self.documented(&f) {
                Some(code) => self.soft.push((code, format!("{role}: {}", f.msg))),
                None => return Err(f),
            }
        }
        // Duplicate spends.
        *self.counts.by_kind.entry(kind).or_insert(0) += 1;
        match a {
            Action::FundNoid { .. } => {
                self.counts.funds += 1;
                if self.counts.funds > 1 {
                    return fail("dup-fund", "fund_noid was performed twice (two instances)");
                }
            }
            Action::LockEth { .. } => {}
            Action::RevealEth { .. } => {
                if self.truth.reveal_at.is_none() {
                    self.truth.reveal_at = Some(s.time);
                }
            }
            _ => {}
        }
        Ok(())
    }

    /// The gates, judged against the TRUE state of the world just before the tick (not against the observation the
    /// engine read): a party never spends outside its gates.
    fn gates_for(&mut self, i: usize, a: &Action, s: &Snap) -> Result<(), Failure> {
        let p = self.public.params.clone();
        let g = self.gates;
        let d = p.deadline_height;
        let role = self.parties[i].role;
        let need_role = |want: Role| -> Result<(), Failure> {
            if role != want {
                fail("wrong-role", format!("{role} performed {}", a.kind()))
            } else {
                Ok(())
            }
        };
        let range_ok = |fee: u64| -> bool { fee >= MIN_CLOSE_FEE && fee <= p.max_fee_micronoid && (!p.contract_version.is_fixed_fee() || fee == p.max_fee_micronoid) };
        match a {
            Action::Wait { .. } | Action::Abort { .. } => Ok(()),
            Action::FundNoid { amount_micronoid } => {
                need_role(Role::Alice)?;
                if *amount_micronoid != p.amount_micronoid {
                    return fail("gate-fund", "fund_noid with another amount");
                }
                if s.instance || s.funding_pending {
                    return fail("gate-fund", "fund_noid while an instance already exists or is pending");
                }
                if s.tip + g.b_fund + g.b_final > p.lock_by_height {
                    return fail("gate-fund", format!("fund_noid at tip {} is too late for lock-by {}", s.tip, p.lock_by_height));
                }
                Ok(())
            }
            Action::LockEth { hashlock, t_reveal, receiver, amount_wei } => {
                need_role(Role::Bob)?;
                if *hashlock != self.public.hashlock || *receiver != p.eth.alice_receiver || *amount_wei != p.eth.amount_wei {
                    return fail("gate-lock", "lock_eth with other terms than the agreed ones");
                }
                let funded = s.funded_height.is_some_and(|h| s.tip >= h + 17);
                if !s.instance || !funded {
                    return fail("gate-lock-funding-not-final", format!("lock_eth at tip {} but the funding (height {:?}) is not final in the world", s.tip, s.funded_height));
                }
                if s.tip + 1 >= d {
                    return fail("gate-lock", "lock_eth when the claim branch is closed");
                }
                if g.check_i1_eth(d, s.tip, *t_reveal, s.time + SKEW_TOL).is_err() {
                    return fail("gate-i1", format!("lock_eth violates (I1): D {d}, tip {}, T_reveal {t_reveal}, time {}", s.tip, s.time));
                }
                if t_reveal + SKEW_TOL < s.time + g.w_a_min_s {
                    return fail("gate-i3", format!("lock_eth with a reveal window of {} s, below W_A_min {}", t_reveal.saturating_sub(s.time), g.w_a_min_s));
                }
                if s.lock.is_some() {
                    return fail("dup-lock", "lock_eth although Bob's lock is already on Ethereum");
                }
                if s.lock_pending_t.is_some_and(|t| t != *t_reveal) {
                    return fail("dup-lock", "lock_eth with another T_reveal while Bob's first lock transaction is still pending");
                }
                if s.mempool_len > 0 {
                    return fail("gate-lock-pending-call", "lock_eth while a call on the instance is pending");
                }
                if s.fitting > 1 {
                    return fail("gate-lock-two-instances", format!("lock_eth with {} instances of the agreed amount at the root", s.fitting));
                }
                Ok(())
            }
            Action::RevealEth { lock_id } => {
                need_role(Role::Alice)?;
                let Some(l) = s.lock.as_ref().filter(|l| l.lock_id == *lock_id) else {
                    return fail("gate-reveal", "reveal_eth for a lock that is not on Ethereum");
                };
                if l.claimed || l.refunded {
                    return fail("gate-reveal", "reveal_eth for a lock that is already closed");
                }
                if s.finalized < l.block_number {
                    return fail("gate-reveal-not-final", "reveal_eth before Bob's lock is final");
                }
                // Once the secret is public (a reveal of hers was sent) a re-send is allowed until T_reveal - DE (review H1).
                let cutoff = if s.secret_public { l.timelock.saturating_sub(g.de_s) } else { g.reveal_cutoff(l.timelock) };
                if s.time > cutoff + SKEW_TOL {
                    return fail("gate-i2", format!("reveal_eth at {} after the cutoff {}", s.time, cutoff));
                }
                if l.amount_wei != p.eth.amount_wei || l.receiver != p.eth.alice_receiver || l.sender != p.eth.bob_sender || l.hashlock != self.public.hashlock {
                    return fail("gate-reveal", "reveal_eth for a lock with other terms");
                }
                if !s.instance && !self.foreign_recorded(i) {
                    return fail("gate-reveal", "reveal_eth although the NOID instance is not at the contract");
                }
                if s.fitting > 1 {
                    return fail("gate-reveal-two-instances", format!("reveal_eth with {} instances of the agreed amount at the root", s.fitting));
                }
                Ok(())
            }
            Action::ClaimNoid { call_height, fee_micronoid, preimage } => {
                need_role(Role::Bob)?;
                if !s.instance && !self.foreign_recorded(i) {
                    return fail("gate-claim", "claim_noid although the instance is not at the contract");
                }
                if *call_height != s.tip + 1 || s.tip + 1 >= d {
                    return fail("gate-claim", format!("claim_noid at call height {call_height} (tip {}, D {d})", s.tip));
                }
                if sha256(preimage) != self.public.hashlock || !s.secret_public {
                    return fail("gate-claim", "claim_noid with a secret that is not the published one");
                }
                if !range_ok(*fee_micronoid) {
                    return fail("gate-fee", format!("claim_noid fee {fee_micronoid} outside the contract's range"));
                }
                Ok(())
            }
            Action::RefundNoid { call_height, fee_micronoid } => {
                need_role(Role::Alice)?;
                if !s.instance && !self.foreign_recorded(i) {
                    return fail("gate-refund-noid", "refund_noid although the instance is not at the contract");
                }
                if *call_height != s.tip + 1 || s.tip + 1 < d {
                    return fail("gate-refund-noid", format!("refund_noid at call height {call_height} before D {d} (tip {})", s.tip));
                }
                if !range_ok(*fee_micronoid) {
                    return fail("gate-fee", format!("refund_noid fee {fee_micronoid} outside the contract's range"));
                }
                Ok(())
            }
            Action::RefundEth { lock_id } => {
                need_role(Role::Bob)?;
                let Some(l) = s.lock.as_ref().filter(|l| l.lock_id == *lock_id) else {
                    return fail("gate-refund-eth", "refund_eth for a lock that is not on Ethereum");
                };
                if l.claimed || l.refunded {
                    return fail("gate-refund-eth", "refund_eth for a lock that is already closed");
                }
                if s.time < l.timelock {
                    return fail("gate-refund-eth", format!("refund_eth at {} before T_reveal {}", s.time, l.timelock));
                }
                Ok(())
            }
        }
    }

    fn check_terminal(&mut self, i: usize, after: &Phase) -> Result<(), Failure> {
        let role = self.parties[i].role;
        let prev = self.parties[i].terminal.clone();
        match prev {
            Some(t) if t != *after => {
                return fail("terminal-changed", format!("{role}: terminal phase {} became {}", t.name(), after.name()));
            }
            Some(_) => {}
            None => {
                if after.is_terminal() {
                    self.parties[i].terminal = Some(after.clone());
                }
                // CHAOS F-16: `done` is not terminal; Alice's `done -> refund_submitted` is the leftover refund, counted.
                if matches!((&self.parties[i].prev_phase, after), (Some(Phase::Alice(AlicePhase::Done { .. })), Phase::Alice(AlicePhase::RefundSubmitted { .. }))) {
                    self.alice_done_to_refund += 1;
                }
            }
        }
        self.parties[i].prev_phase = Some(after.clone());
        Ok(())
    }

    // -------------------------------------------------------------------------------------------- the run

    fn quiescent(&self) -> bool {
        let w = self.world.borrow();
        let lock_closed = w.lock.as_ref().map_or(true, |l| l.claimed || l.refunded);
        self.parties.iter().all(|p| p.runner.file.phase.is_settled())
            && w.instance.is_none()
            && w.funding_pending.is_none()
            && w.mempool.is_empty()
            && lock_closed
            && w.lock_pending.is_none()
            && w.claim_pending.is_none()
    }

    fn drive(&mut self, until_calm_horizon: bool) -> Result<(), Failure> {
        let d = self.d();
        let tail = self.rng.range(0, 80);
        let mut guard = 0u64;
        loop {
            guard += 1;
            if guard > 60_000 {
                return fail("runaway", "the run did not end within 60,000 Ethereum blocks");
            }
            let (tip, time) = {
                let w = self.world.borrow();
                (w.tip, w.eth_time)
            };
            if !until_calm_horizon {
                if tip >= d + tail {
                    return Ok(());
                }
            } else {
                let lock_t = self.world.borrow().lock.as_ref().map_or(0, |l| l.timelock);
                let past_everything = tip >= d + 300 && time >= lock_t + 2 * self.gates.eth_finality_s + 3_600;
                if self.quiescent() || past_everything {
                    return Ok(());
                }
            }
            if !self.calm {
                self.opportunities()?;
            }
            if !self.calm && self.rng.chance(self.event_pm) {
                self.event()?;
            }
            self.block()?;
            let order = if self.rng.chance(500) { [ALICE, BOB] } else { [BOB, ALICE] };
            for i in order {
                let (due, down) = {
                    let p = &self.parties[i];
                    let t = self.world.borrow().eth_time;
                    (t >= p.next_tick, p.down_until > t)
                };
                if !due {
                    continue;
                }
                let gap_hi = if self.calm { 90 } else { self.gap_hi };
                let gap = self.rng.log_uniform(5, gap_hi);
                let t = self.world.borrow().eth_time;
                self.parties[i].next_tick = t + gap;
                if down {
                    continue;
                }
                self.party_tick(i)?;
            }
        }
    }

    /// Stop the adversary: every episode over, nobody offline, nobody armed, ticks every 5-90 s.
    fn go_calm(&mut self) {
        self.calm = true;
        self.ep = Episodes::default();
        {
            let mut w = self.world.borrow_mut();
            w.freeze_inclusion = false;
            w.freeze_eth_claim = false;
            w.eth_head_lag = 0;
        }
        for p in self.parties.iter_mut() {
            p.down_until = 0;
            p.offline_until.clear();
            p.armed_before.clear();
            p.armed_after.clear();
            p.runner.executor.offline_for.clear();
            p.runner.executor.crash_before_effect.clear();
            p.runner.executor.crash_after_effect.clear();
        }
        let t = self.world.borrow().eth_time;
        for p in self.parties.iter_mut() {
            p.next_tick = t;
        }
        self.say("--- the adversary stops: calm settling period ---");
    }

    fn go(&mut self) -> Result<Summary, Failure> {
        self.drive(false)?;
        self.go_calm();
        self.drive(true)?;
        self.final_checks()
    }

    // -------------------------------------------------------------------------------------------- end of run

    fn final_checks(&mut self) -> Result<Summary, Failure> {
        let p = self.public.params.clone();
        let d = p.deadline_height;
        let w = self.world.borrow();
        let funded = self.truth.funded_ever;
        // Documented gaps that explain a file or a contract left open (CHAOS.md): the engine never re-checks a transaction
        // it believes is submitted, nor a lock it believes is on chain.
        let mut explained: Vec<String> = Vec::new();
        {
            let ph = |i: usize| self.parties[i].runner.file.phase.clone();
            // F-5 and F-9 were fixed (a dropped transaction is noticed; `revealed` re-checks its claim): a file waiting on a
            // transaction that is gone, or an ETH lock left open, is a hard failure below.
            if self.lock_vanished && matches!(ph(BOB), Phase::Bob(BobPhase::Locked { .. } | BobPhase::RefundSubmitted { .. } | BobPhase::RefundMined { .. })) && w.lock.is_none() {
                explained.push(format!("F-6 Bob stays in `{}` although his lock left the chain for good", ph(BOB).name()));
            }
        }
        let noid_left = funded && (w.instance.is_some() || w.funding_pending.is_some() || !w.mempool.is_empty());
        // Nothing stuck.
        if noid_left {
            let alice_hold = self.parties[ALICE].runner.file.pending_action.as_ref().is_some_and(|a| a.maybe_sent);
            let alice_ph = self.parties[ALICE].runner.file.phase.name();
            if w.instance.is_some() && alice_ph == "funding_submitted" && w.instances_before.iter().chain(w.instances_after.iter()).any(|i| i.amount_micronoid == p.amount_micronoid) && !alice_hold {
                explained.push("F-7 Alice never accepts her funding while a second instance of the agreed amount sits at the root, so the tool never offers her recovery close".into());
            } else {
                return fail(
                    "noid-stuck",
                    format!(
                        "the NOID is still at the contract at the end (tip {}, D {d}): instance {:?}, mempool {}; Alice {} Bob {}",
                        w.tip,
                        w.instance,
                        w.mempool.len(),
                        alice_ph,
                        self.parties[BOB].runner.file.phase.name()
                    ),
                );
            }
        }
        if let Some(l) = w.lock.as_ref() {
            if !l.claimed && !l.refunded {
                return fail(
                    "eth-stuck",
                    format!(
                        "Bob's ETH lock is still open at the end (eth time {}, T_reveal {}); Alice {} Bob {}",
                        w.eth_time,
                        l.timelock,
                        self.parties[ALICE].runner.file.phase.name(),
                        self.parties[BOB].runner.file.phase.name()
                    ),
                );
            }
        }
        if w.lock_pending.is_some() {
            return fail("eth-stuck", "a lock transaction is still pending at the end");
        }
        // Both files terminal.
        for pt in &self.parties {
            // CHAOS F-16: `done` is settled but not terminal; a `done` file with a leftover leg is caught by the "stuck" checks above.
            if !pt.runner.file.phase.is_settled() {
                let foreign = match &pt.runner.file.phase {
                    Phase::Alice(p) => p.instance(),
                    Phase::Bob(p) => p.instance(),
                }
                .is_some_and(|i| i.slot_index != 7);
                if foreign {
                    // The party adopted a foreign instance of the agreed amount as its own (an attacker's deposit, F-7/F-10): the
                    // simulator can only close its one real instance, so this file cannot end here. Not an engine finding.
                    self.foreign_adopted += 1;
                    continue;
                }
                // Alice's own wallet (or anyone) closed the instance before this file learned of it and nothing records it (F-11's
                // Alice side: `--closed-by` exists on the CLI only). NOT an F-12 case: a lock_final / reveal_submitted file whose
                // reveal was decided must reach `lost` (or, with Bob's refund not final, is still waiting) and is never explained here.
                let reveal_decided = pt.runner.file.history.iter().any(|h| matches!(h.event.as_str(), "reveal_submitted" | "eth_reveal_dropped" | "intent_decided:reveal_eth"));
                let alice_closed_unrecorded = pt.role == Role::Alice
                    && pt.last_action.contains("nothing to refund")
                    // With a reveal on record `lost` is the right end ONLY when the instance was never seen alive once Bob's claim had
                    // become impossible (F-17); if it was, the close that removed it was a recovery close nobody recorded (`--closed-by`).
                    // A reveal that was sent, reverted and then cancelled in the ledger (the cancel is allowed once nothing of it is
                    // pending or mined) is not counted as evidence either: the file stays `lock_final`, stuck but never wrong.
                    && (!reveal_decided
                        || pt.runner.file.history.iter().any(|h| h.event == "noid_instance_alive_at_d")
                        || pt.runner.file.history.iter().rposition(|h| h.event == "intent_cancelled:reveal_eth")
                            > pt.runner.file.history.iter().rposition(|h| h.event == "intent_decided:reveal_eth"))
                    && matches!(pt.runner.file.phase.name().as_str(), "funded" | "funding_submitted" | "funding_final" | "lock_seen" | "lock_final");
                // Alice never ticked while the instance was visible and her wallet closed it: `funding_submitted` has nothing to go on.
                let alice_funding_closed_unseen = pt.role == Role::Alice
                    && pt.runner.file.phase.name() == "funding_submitted"
                    && w.instance.is_none()
                    && w.noid_payout.is_some();
                // CHAOS F-1: the CLI records an abort, except while a funding or lock decided for this swap was never cancelled (it may
                // have been sent and the chain not shown it): then the file keeps printing `abort` by design, for the operator to look.
                if self.mode == Mode::Cli && pt.last_abort && ["fund_noid", "lock_eth"].iter().any(|k| {
                    let decided = pt.runner.file.history.iter().rposition(|h| h.event == format!("intent_decided:{k}"));
                    let cancelled = pt.runner.file.history.iter().rposition(|h| h.event == format!("intent_cancelled:{k}"));
                    decided.is_some() && decided > cancelled
                }) {
                    continue;
                }
                if pt.last_action.contains("verify the contract receipts manually") || alice_closed_unrecorded || alice_funding_closed_unseen {
                    explained.push(format!("F-11 {} stays in `{}` after the instance was closed by someone else; the file has no way to end", pt.role, pt.runner.file.phase.name()));
                    continue;
                }
                if pt.last_action.contains("more than one instance") {
                    explained.push(format!("F-10 {} waits for ever on \"more than one instance at the contract root\", also after D, and is never terminal", pt.role));
                    continue;
                }
                if pt.runner.file.pending_action.as_ref().is_some_and(|a| a.maybe_sent) {
                    explained.push(format!(
                        "F-2 {}'s file holds a pending {} of unknown outcome for ever",
                        pt.role,
                        pt.runner.file.pending_action.as_ref().map(|a| a.kind.clone()).unwrap_or_default()
                    ));
                    continue;
                }
                if !explained.is_empty() && explained.iter().any(|e| e.contains(&format!("{} ", if pt.role == Role::Bob { "Bob" } else { "Alice" }))) {
                    continue;
                }
                return fail(
                    "not-terminal",
                    format!("{}'s file is in phase `{}` at the end (tip {}, D {d}); the chain is quiet; its last action: {}", pt.role, pt.runner.file.phase.name(), w.tip, pt.last_action),
                );
            }
        }
        let had_explained = !explained.is_empty();
        for e in explained {
            let code: &'static str = match e.split(' ').next().unwrap_or("") {
                "F-2" => "F-2 pending action of unknown outcome never resolves",
                "F-6" => "F-6 locked phase never re-checks the lock",
                "F-10" => "F-10 ambiguous instances: the party waits for ever, also after D",
                "F-11" => "F-11 a close by someone else leaves the file without a way to end",
                _ => "F-7 ambiguous funding never accepted, no recovery offered",
            };
            self.soft.push((code, e));
        }
        let noid_to_bob = w.noid_payout.as_ref().map(|(to, _)| *to == p.bob_noid);
        let eth_to_alice = w.eth_payout.map(|(a, _)| a == p.eth.alice_receiver);
        // The secret rule.
        let published_before_d = self.truth.secret_public.is_some_and(|(tip, _)| tip < d);
        if noid_to_bob == Some(true) && !published_before_d {
            return fail("noid-to-bob-without-secret", "the NOID went to Bob but the secret was not published before D");
        }
        if let Some((_, amt)) = &w.noid_payout {
            let fee = w.noid_close_fee.unwrap_or(0);
            if *amt + fee != p.amount_micronoid {
                return fail("payout-amount", format!("NOID payout {amt} + fee {fee} != amount {}", p.amount_micronoid));
            }
        }
        // The ETH rule.
        if eth_to_alice == Some(true) {
            let cutoff = w.lock.as_ref().map(|l| self.gates.reveal_cutoff(l.timelock)).unwrap_or(0);
            match self.truth.reveal_at {
                Some(t) if t <= cutoff + SKEW_TOL => {}
                other => return fail("eth-to-alice-without-timely-reveal", format!("the ETH went to Alice, reveal executed at {other:?}, cutoff {cutoff}")),
            }
        }
        if eth_to_alice == Some(false) {
            let l = w.lock.as_ref().unwrap();
            if !l.refunded {
                return fail("eth-to-bob-without-refund", "the ETH went to Bob but the lock is not marked refunded");
            }
        }
        // The files agree with the chain.
        let alice = &self.parties[ALICE].runner.file.phase;
        let bob = &self.parties[BOB].runner.file.phase;
        let bad = |who: &str, ph: &Phase, why: &str| -> Result<(), Failure> {
            fail("terminal-vs-chain", format!("{who}'s file says `{}` but the chain says: {why}", ph.name()))
        };
        match alice {
            Phase::Alice(AlicePhase::Done { .. }) if eth_to_alice != Some(true) => bad("Alice", alice, "the ETH did not go to Alice")?,
            Phase::Alice(AlicePhase::Refunded { .. }) if noid_to_bob != Some(false) => bad("Alice", alice, "the NOID did not go back to Alice")?,
            Phase::Alice(AlicePhase::Lost { .. }) if !(noid_to_bob == Some(true) && eth_to_alice == Some(false)) => bad("Alice", alice, "she did not lose both legs")?,
            Phase::Alice(AlicePhase::Aborted { .. }) if funded => bad("Alice", alice, "the NOID was funded")?,
            _ => {}
        }
        match bob {
            Phase::Bob(BobPhase::Done { .. }) if noid_to_bob != Some(true) => bad("Bob", bob, "the NOID did not go to Bob")?,
            Phase::Bob(BobPhase::Refunded { .. }) if eth_to_alice != Some(false) => bad("Bob", bob, "the ETH did not go back to Bob")?,
            Phase::Bob(BobPhase::Aborted { .. }) if noid_to_bob == Some(true) => bad("Bob", bob, "the NOID went to Bob")?,
            _ => {}
        }
        // The outcome and atomicity.
        let locked = self.truth.lock_ever || w.lock.is_some();
        let outcome = match (funded, locked, noid_to_bob, eth_to_alice) {
            (false, _, _, _) => Outcome::NothingFunded,
            (true, false, _, _) => Outcome::NothingLocked,
            (true, true, Some(true), Some(true)) => Outcome::Swapped,
            (true, true, Some(false), Some(false)) => Outcome::BothRefunded,
            (true, true, Some(true), Some(false)) => Outcome::AliceLoses,
            (true, true, Some(false), Some(true)) => Outcome::BobLoses,
            _ if had_explained => Outcome::Unresolved,
            _ => return fail("outcome-unknown", format!("funded and locked but payouts are {noid_to_bob:?} / {eth_to_alice:?}")),
        };
        let mut excused: Vec<&'static str> = Vec::new();
        match outcome {
            Outcome::BobLoses => excused.extend(self.excuse_bob.iter().copied()),
            Outcome::AliceLoses => excused.extend(self.excuse_alice.iter().copied()),
            _ => {}
        }
        if matches!(outcome, Outcome::AliceLoses | Outcome::BobLoses) {
            let who = if outcome == Outcome::BobLoses { "Bob" } else { "Alice" };
            if self.regime == Regime::Budgeted {
                return fail("atomicity-budgeted", format!("{who} lost a leg in a budgeted-regime run: {outcome:?} (excuses in force: {excused:?})"));
            }
            if excused.is_empty() {
                return fail("atomicity-unexplained", format!("{who} lost a leg and no adversity was in force that explains it: {outcome:?}"));
            }
        }
        let ticks = self.parties[ALICE].ticks + self.parties[BOB].ticks;
        Ok(Summary { outcome, ticks, excused })
    }
}

// ------------------------------------------------------------------------------------------------ the test

#[derive(Default)]
struct Stats {
    scenarios: u64,
    ticks: u64,
    outcomes: BTreeMap<String, u64>,
    by_regime: BTreeMap<String, u64>,
    by_mode: BTreeMap<String, u64>,
    by_profile: BTreeMap<String, u64>,
    by_variant: BTreeMap<String, u64>,
    by_version: BTreeMap<String, u64>,
    events: BTreeMap<&'static str, u64>,
    degrades: BTreeMap<String, u64>,
    actions: BTreeMap<&'static str, u64>,
    excuses: BTreeMap<&'static str, u64>,
    failures: BTreeMap<&'static str, Vec<(u64, u64, String, Vec<String>)>>,
    alice_done_to_refund: u64,
    closed_by: u64,
    cancels_ok: u64,
    cancels_refused: u64,
    restarts: u64,
    intents: u64,
    soft: BTreeMap<&'static str, Vec<(u64, u64, String)>>,
}

fn env_u64(name: &str, default: u64) -> u64 {
    match std::env::var(name) {
        Ok(v) => {
            let v = v.trim();
            if let Some(hex) = v.strip_prefix("0x") {
                u64::from_str_radix(hex, 16).unwrap_or(default)
            } else {
                v.parse().unwrap_or(default)
            }
        }
        Err(_) => default,
    }
}

fn scenario_seed(base: u64, idx: u64) -> u64 {
    let mut r = Rng::new(base ^ idx.wrapping_mul(0xA24B_AED4_963E_E407));
    r.next_u64()
}

#[test]
fn chaos_the_swap_survives_random_interleavings_and_adversaries() {
    // Swap files are fsynced on every save: keep them on a RAM disk where there is one.
    if std::path::Path::new("/dev/shm").is_dir() && std::env::var_os("TMPDIR").is_none() {
        std::env::set_var("TMPDIR", "/dev/shm");
    }
    let n = env_u64("CHAOS_N", 1_000);
    let base = env_u64("CHAOS_SEED", 0xC4A0_5EED);
    let only = std::env::var("CHAOS_ONLY").ok().and_then(|v| v.trim().parse::<u64>().ok());
    let verbose = std::env::var("CHAOS_VERBOSE").is_ok();
    let strict = std::env::var("CHAOS_STRICT").is_ok();
    println!("chaos: {n} scenarios, base seed {base:#x} (CHAOS_SEED), replay one with CHAOS_ONLY=<index> CHAOS_VERBOSE=1");

    let started = Instant::now();
    let mut stats = Stats::default();
    let prev_hook = std::panic::take_hook();
    std::panic::set_hook(Box::new(|_| {}));
    let range: Vec<u64> = match only {
        Some(i) => vec![i],
        None => (0..n).collect(),
    };
    for idx in range {
        let seed = scenario_seed(base, idx);
        let mut run = Run::new(seed);
        let res = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| run.go()));
        stats.scenarios += 1;
        *stats.by_regime.entry(format!("{:?}", run.regime)).or_insert(0) += 1;
        *stats.by_mode.entry(format!("{:?}", run.mode)).or_insert(0) += 1;
        *stats.by_profile.entry(format!("{:?}", run.profile)).or_insert(0) += 1;
        *stats.by_variant.entry(format!("{:?}", run.variant)).or_insert(0) += 1;
        *stats.by_version.entry(format!("{:?}", run.version)).or_insert(0) += 1;
        for (k, v) in &run.events {
            *stats.events.entry(k).or_insert(0) += *v as u64;
        }
        for (k, v) in &run.degrades {
            *stats.degrades.entry(k.clone()).or_insert(0) += *v as u64;
        }
        for (k, v) in &run.counts.by_kind {
            *stats.actions.entry(k).or_insert(0) += *v as u64;
        }
        stats.alice_done_to_refund += run.alice_done_to_refund as u64;
        stats.closed_by += run.closed_by_recorded as u64;
        stats.cancels_ok += run.cancels_ok as u64;
        stats.cancels_refused += run.cancels_refused as u64;
        stats.restarts += run.restarts as u64;
        stats.intents += run.intents_recorded as u64;
        let mut seen_codes: BTreeSet<&'static str> = BTreeSet::new();
        for (code, msg) in &run.soft {
            if seen_codes.insert(code) {
                stats.soft.entry(code).or_default().push((idx, seed, msg.clone()));
            }
        }
        let failure = match res {
            Ok(Ok(summary)) => {
                stats.ticks += summary.ticks;
                *stats.outcomes.entry(format!("{:?}", summary.outcome)).or_insert(0) += 1;
                for e in summary.excused {
                    *stats.excuses.entry(e).or_insert(0) += 1;
                }
                if verbose {
                    for l in &run.log {
                        println!("{l}");
                    }
                    println!("scenario {idx}: {:?} regime {:?} mode {:?} {:?} {:?} {:?}", summary.outcome, run.regime, run.mode, run.profile, run.variant, run.version);
                }
                None
            }
            Ok(Err(f)) => Some(f),
            Err(payload) => {
                let msg = payload
                    .downcast_ref::<String>()
                    .cloned()
                    .or_else(|| payload.downcast_ref::<&str>().map(|s| s.to_string()))
                    .unwrap_or_else(|| "panic".into());
                Some(Failure { id: "sim-panic", msg })
            }
        };
        if let Some(f) = failure {
            *stats.outcomes.entry(format!("FAILED:{}", f.id)).or_insert(0) += 1;
            let header = format!(
                "scenario {idx} seed {seed:#x} (CHAOS_SEED={base:#x} CHAOS_ONLY={idx}) regime {:?} mode {:?} {:?} {:?} {:?}: [{}] {}",
                run.regime, run.mode, run.profile, run.variant, run.version, f.id, f.msg
            );
            let tail: Vec<String> = run.log.iter().rev().take(120).rev().cloned().collect();
            stats.failures.entry(f.id).or_default().push((idx, seed, header, tail));
        }
    }
    std::panic::set_hook(prev_hook);

    let elapsed = started.elapsed();
    println!("chaos: {} scenarios, {} ticks, {:.1} s ({:.1} ms per scenario)", stats.scenarios, stats.ticks, elapsed.as_secs_f64(), elapsed.as_secs_f64() * 1000.0 / stats.scenarios.max(1) as f64);
    println!("chaos: regime {:?}", stats.by_regime);
    println!("chaos: mode {:?} profile {:?} variant {:?} contract {:?}", stats.by_mode, stats.by_profile, stats.by_variant, stats.by_version);
    println!("chaos: outcomes {:?}", stats.outcomes);
    println!("chaos: events {:?}", stats.events);
    println!("chaos: degraded observations {:?}", stats.degrades);
    println!("chaos: actions performed {:?}", stats.actions);
    println!("chaos: losses excused by {:?}", stats.excuses);
    println!(
        "chaos: restarts {}, --closed-by recorded {}, intents recorded {}, cancels accepted {} refused {}, Alice done->refund {}",
        stats.restarts, stats.closed_by, stats.intents, stats.cancels_ok, stats.cancels_refused, stats.alice_done_to_refund
    );
    let mut unexpected = 0;
    for (code, list) in &stats.soft {
        let open = OPEN_FINDINGS.iter().any(|f| code.starts_with(f));
        println!("chaos: {} finding `{code}`: {} scenario(s)", if open { "open" } else { "UNLISTED" }, list.len());
        for (idx, seed, msg) in list.iter().take(2) {
            println!("  scenario {idx} seed {seed:#x} (CHAOS_SEED={base:#x} CHAOS_ONLY={idx}): {msg}");
        }
        // A symptom of a finding that was fixed (not in OPEN_FINDINGS) is a regression; an open one fails only under STRICT.
        if !open || strict {
            unexpected += list.len();
        }
    }
    for (id, list) in &stats.failures {
        let known = KNOWN_FINDINGS.contains(id);
        println!("chaos: violation `{id}`: {} scenario(s){}", list.len(), if known { " (documented finding)" } else { "" });
        for (k, (_, _, header, tail)) in list.iter().enumerate() {
            if k < 4 {
                println!("  {header}");
                if k == 0 {
                    for l in tail {
                        println!("    {l}");
                    }
                }
            }
        }
        if !known || strict {
            unexpected += list.len();
        }
    }
    assert_eq!(unexpected, 0, "{unexpected} scenario(s) violated an invariant or showed a fixed finding again (or, under CHAOS_STRICT, an open one); see the output above (seed and index are printed)");
}

#[test]
fn chaos_rng_is_deterministic() {
    let mut a = Rng::new(7);
    let mut b = Rng::new(7);
    for _ in 0..100 {
        assert_eq!(a.next_u64(), b.next_u64());
    }
    assert_ne!(scenario_seed(1, 0), scenario_seed(1, 1));
    let mut r = Rng::new(3);
    for _ in 0..1000 {
        let v = r.log_uniform(5, 1500);
        assert!((5..=1500).contains(&v));
    }
}

/// The oracles must not be vacuous: a planted violation of each gate, and the terminal-phase rule, is caught.
#[test]
fn chaos_oracles_catch_planted_violations() {
    let mut run = Run::new(11);
    let g = run.gates;
    let p = run.public.params.clone();
    let d = p.deadline_height;
    let lock = make_lock(&run.public, T0 + 9_000, p.eth.amount_wei, T0 + 9_000 - g.w_a_s);
    let base = Snap {
        tip: 300_100,
        time: lock.timelock - g.m_a_s - 60,
        instance: true,
        funding_pending: false,
        lock_pending_t: None,
        claim_pending: false,
        refund_pending: false,
        refund_in_mempool: false,
        funding_in_flight: false,
        mempool_len: 0,
        lock: Some(lock.clone()),
        finalized: 1_000,
        funded_height: Some(300_001),
        secret_public: true,
        fitting: 1,
    };
    let reveal = Action::RevealEth { lock_id: lock.lock_id };
    // In time: allowed. After the cutoff: refused.
    assert!(run.gates_for(ALICE, &reveal, &base).is_ok());
    let late = Snap { time: lock.timelock - g.m_a_s + SKEW_TOL + 1, secret_public: false, ..base.clone() };
    assert_eq!(run.gates_for(ALICE, &reveal, &late).unwrap_err().id, "gate-i2");
    // With the secret already public (her claim was sent) a re-send is allowed past the cutoff, until T_reveal - DE (review H1).
    let resend = Snap { time: lock.timelock - g.m_a_s + SKEW_TOL + 1, secret_public: true, ..base.clone() };
    assert!(run.gates_for(ALICE, &reveal, &resend).is_ok());
    let too_late = Snap { time: lock.timelock - g.de_s + SKEW_TOL + 1, secret_public: true, ..base.clone() };
    assert_eq!(run.gates_for(ALICE, &reveal, &too_late).unwrap_err().id, "gate-i2");
    // Not final, two fitting instances, wrong role.
    let young = Snap { finalized: 0, ..base.clone() };
    assert_eq!(run.gates_for(ALICE, &reveal, &young).unwrap_err().id, "gate-reveal-not-final");
    let two = Snap { fitting: 2, ..base.clone() };
    assert_eq!(run.gates_for(ALICE, &reveal, &two).unwrap_err().id, "gate-reveal-two-instances");
    assert_eq!(run.gates_for(BOB, &reveal, &base).unwrap_err().id, "wrong-role");
    // Closes on the wrong side of D, of a missing instance, with a secret nobody published.
    let fee_ok = if p.contract_version.is_fixed_fee() { p.max_fee_micronoid } else { MIN_CLOSE_FEE };
    let secret = *run.secret.bytes();
    let claim_at = move |h: u64| Action::ClaimNoid { call_height: h, fee_micronoid: fee_ok, preimage: secret };
    assert!(run.gates_for(BOB, &claim_at(base.tip + 1), &base).is_ok());
    let at_d = Snap { tip: d - 1, ..base.clone() };
    assert_eq!(run.gates_for(BOB, &claim_at(d), &at_d).unwrap_err().id, "gate-claim");
    let gone = Snap { instance: false, ..base.clone() };
    assert_eq!(run.gates_for(BOB, &claim_at(base.tip + 1), &gone).unwrap_err().id, "gate-claim");
    let unpublished = Snap { secret_public: false, ..base.clone() };
    assert_eq!(run.gates_for(BOB, &claim_at(base.tip + 1), &unpublished).unwrap_err().id, "gate-claim");
    let refund = |h: u64| Action::RefundNoid { call_height: h, fee_micronoid: fee_ok };
    assert_eq!(run.gates_for(ALICE, &refund(base.tip + 1), &base).unwrap_err().id, "gate-refund-noid");
    assert!(run.gates_for(ALICE, &refund(d), &at_d).is_ok());
    // Bob's ETH refund before T_reveal, and a lock that violates (I1).
    let early = Action::RefundEth { lock_id: lock.lock_id };
    assert_eq!(run.gates_for(BOB, &early, &base).unwrap_err().id, "gate-refund-eth");
    let bad_lock = Action::LockEth { hashlock: run.public.hashlock, t_reveal: base.time + 400_000, receiver: p.eth.alice_receiver, amount_wei: p.eth.amount_wei };
    let no_lock = Snap { lock: None, ..base.clone() };
    assert!(run.gates_for(BOB, &bad_lock, &no_lock).is_err());
    // Funding twice.
    let fund = Action::FundNoid { amount_micronoid: p.amount_micronoid };
    assert_eq!(run.gates_for(ALICE, &fund, &base).unwrap_err().id, "gate-fund");
    // The fail-closed table: a degradation blocks what it must, and only that.
    assert!(Degrade::EpochAnchorNone.blocks("claim_noid", run.profile));
    assert!(!Degrade::EpochAnchorNone.blocks("reveal_eth", run.profile));
    assert!(Degrade::TipTimeNone.blocks("reveal_eth", run.profile));
    // A terminal phase may not change, except Alice's `done` (REVIEW-2 F9).
    run.parties[ALICE].terminal = Some(Phase::Alice(AlicePhase::Refunded { txid: "x".into(), height: 1 }));
    assert_eq!(run.check_terminal(ALICE, &Phase::Alice(AlicePhase::Created)).unwrap_err().id, "terminal-changed");
}
