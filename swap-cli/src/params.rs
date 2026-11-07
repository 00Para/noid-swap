//! The v1 parameters of `docs/protocol-design.md` section 9.1 and the gates
//! (I1)..(I5) of section 4.2. Every number here is a design decision; change
//! the design first, then this file, then the tests that pin the worked
//! examples of section 4.3.
//!
//! Plain words. A *timeout* is the moment after which the party who locked
//! funds can take them back if the other side never acted. Bob's safety (I1)
//! says: between the latest moment Bob might first see the secret and Alice's
//! NOID refund height `D`, there must be enough Parano1d blocks for Bob to
//! prove, submit, survive a congestion wait and an epoch rotation, and be
//! final. Alice's safety (I2) says: she must publish the secret early enough
//! that her Ethereum claim is final before Bob's Ethereum refund opens.
//!
//! # Profiles (`docs/ideas.md` idea 3)
//!
//! Every timing number the gates read lives in a [`Gates`] value, and a swap
//! carries the NAME of its profile ([`ProfileName`]) in its public section, so
//! both parties' files and the bundle commit to the same numbers:
//!
//! - `production`: the section 9.1 values (`W_A` 7,200 s, `D_offset` 735 ...).
//!   The default. A file that says nothing about a profile is `production`.
//! - `rehearsal`: the SAME formulas with smaller budgets, so the "nobody shows
//!   up" paths can be rehearsed in about an hour, and with hard caps on the
//!   amounts (at most 20 NOID and 0.01 ETH) and on the Ethereum chain (31337,
//!   a local Hardhat chain, where "final" is instant). It is derived below.
//! - `sepolia`: the rehearsal budgets with the REAL Ethereum finality (1,140 s, as in production) and
//!   the production `M_A` (1,800 s), for a run whose Ethereum leg is on the public Sepolia testnet
//!   (chain 11155111) instead of a local chain. The same caps (20 NOID, 0.01 ETH), one chain only.
//!
//! The engine, the swap-file checks and the `gates` command read every gate
//! number from `file.public.params.profile.gates()`, never from a global.
//! The `pub const` values below (`W_A_S`, `M_A_S`, `B_POST` ...) are the
//! PRODUCTION numbers, kept for the tests that pin section 4.3; nothing in the
//! engine reads them. The fee rule (`F_max`) and the chain facts (Parano1d
//! finality 18, the 144-block epoch, the 5,800 minimum close fee) are the same
//! in both profiles and stay global.
//!
//! ## How the rehearsal numbers are derived
//!
//! Section 4.2 gives, for the ETH pair,
//!
//! ```text
//! RHS(I1)  = ceil((W_A + Delta_detect + 2*P_auth) / tau_fast) + B_post
//! B_post   = B_epoch + B_fee + B_final + B_safety
//! D_offset = B_fund + B_final + B_bob + RHS(I1) + margin      (D = H_create + D_offset)
//! ```
//!
//! | item | production | rehearsal | why |
//! |---|---|---|---|
//! | `W_A` | 7,200 s | 600 s | ideas idea 3 |
//! | `Delta_detect` | 300 s | 60 s | one fast poll on a local chain |
//! | `2*P_auth` | 40 s | 40 s | the same prover (M0.5 budget, 20 s each) |
//! | `B_epoch` budget | 144 | 0 | accepts the rotation risk, in a rehearsal only |
//! | `B_fee` | 60 | 10 | a local node has no relay pressure |
//! | `B_final` | 18 | 18 | Parano1d finality is a chain fact, never shortened |
//! | `B_safety` | 30 | 5 | production: one adversarial reorg of Bob's close (17 blocks) plus restarts and the T6 guard (4 blocks), `docs/formal/README.md` section 7; rehearsal: restarts only |
//! | `B_post` | 252 | 33 = 0 + 10 + 18 + 5 | |
//! | `RHS(I1)` | 629 = 377 + 252 | 68 = ceil(700/20) + 33 = 35 + 33 | |
//! | `B_fund` | 10 | 5 | |
//! | `B_bob` | 60 | 20 | |
//! | `margin` | 18 | 9 | rounding-up of `D_offset`, not an output of the formula |
//! | `D_offset` | 735 = 10+18+60+629+18 | 120 = 5+18+20+68+9 | one hour at 30 s/block |
//! | `W_A_min` | 5,400 s | 480 s | 0.8 x `W_A`; leaves Alice at least 180 s at the minimum |
//! | `M_A` | 1,800 s | 300 s | must exceed `eth_finality_s` (1,140 s vs 0 s) |
//! | `eth_finality_s` | 1,140 s (19 min) | 0 s | Hardhat mines and finalizes at once |
//! | `DE` (Ethereum inclusion delay) | 120 s | 60 s | mainnet blocks are 12 s apart: ten blocks; the local chain mines on demand and the runbook mines after every send |
//! | `RA` (Alice's rebroadcast time) | 120 s | 60 s | two polls (notice a dropped claim, resend it) |
//!
//! Lock-by heights follow: full window `D - 68` (production `D - 629`), minimum window
//! `D - (ceil(580/20) + 33) = D - 62` (production `D - 539`).
//!
//! ## How the sepolia numbers are derived
//!
//! `rehearsal` is pinned to the local Hardhat chain (31337), where Ethereum finality is instant, so its
//! `M_A` of 300 s is enough. Sepolia finalizes like mainnet (about 13 min; the budget is 1,140 s, the
//! production value), and the checker demands `M_A > eth_finality` and
//! `W_A_min - M_A >= eth_finality + Delta_detect`. Alice therefore needs a longer reveal window than in
//! the rehearsal. `M_A` stays at the production 1,800 s on purpose: `eth/scripts/live.js claim` uses 1,800 s
//! as its default `--margin-s`, so no extra flag is needed on Sepolia. Everything else is rehearsal-grade
//! (small budgets, `B_epoch` 0 accepting the rotation risk, the same caps).
//!
//! | item | rehearsal | sepolia | why |
//! |---|---|---|---|
//! | `W_A` | 600 s | 4,200 s | Alice must see Bob's lock become final (1,140 s) and still reveal before her cutoff |
//! | `Delta_detect` | 60 s | 120 s | two Sepolia blocks plus one poll of a public RPC |
//! | `2*P_auth` | 40 s | 40 s | the same prover |
//! | `B_epoch` budget | 0 | 0 | accepts the rotation risk (see the README: `D_offset` 300 > 144) |
//! | `B_fee`, `B_final`, `B_safety` | 10, 18, 5 | 10, 18, 5 | unchanged |
//! | `B_post` | 33 | 33 | |
//! | `RHS(I1)` | 68 | 251 = ceil(4,360/20) + 33 = 218 + 33 | |
//! | `B_fund`, `B_bob`, `margin` | 5, 20, 9 | 5, 20, 6 | |
//! | `D_offset` | 120 | 300 = 5+18+20+251+6 | 2 h 30 at 30 s/block |
//! | `W_A_min` | 480 s | 3,360 s | 0.8 x `W_A`; `W_A_min - M_A` = 1,560 s >= 1,140 + 120 = 1,260 s |
//! | `M_A` | 300 s | 1,800 s | production value; live.js's default `--margin-s` |
//! | `eth_finality_s` | 0 s | 1,140 s | Sepolia finalizes in about 13 min |
//! | `DE`, `RA` | 60 s, 60 s | 120 s, 120 s | public chain, 12 s blocks (as production); M_A 1,800 >= 1,140 + 240 + 120 = 1,500 and W_A_min 3,360 >= 120 + 1,140 + 120 + 1,800 = 3,180 |
//!
//! Lock-by heights: full window `D - 251`, minimum window `D - (ceil(3,520/20) + 33) = D - 209`. A full
//! "Alice never reveals" cycle takes about `300 + 17` = 317 blocks (about 2 h 40); a happy path still
//! settles in about 45 minutes. The reveal cutoff is `T_reveal - 1,800 s`.
//!
//! [`Gates::validate`] is the one checker for these relations; both profiles
//! must pass it and a hand-made broken profile must not.

use std::fmt;
use std::str::FromStr;

use noid_tx::OwnerAuthorizationVersion;
use serde::{Deserialize, Serialize};

// ---------------------------------------------------------------- the profiles

/// The name a swap file and a bundle carry. `production` is the default and is NOT written to a file
/// (a file with no `profile` field is a production file, which keeps files written before profiles
/// existed, and the digest their secrets are sealed to, unchanged); `rehearsal` and `sepolia` are written.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ProfileName {
    #[default]
    Production,
    Rehearsal,
    Sepolia,
}

impl ProfileName {
    pub fn is_production(&self) -> bool {
        matches!(self, ProfileName::Production)
    }

    /// REVIEW-3 F5: the profiles whose `lock_eth` / `reveal_eth` need a second, independent node (or `--single-node-ok`).
    /// `sepolia` counts: a stranger's swap there has real value on the NOID side. `rehearsal` (a local chain) does not.
    pub fn requires_second_node(&self) -> bool {
        matches!(self, ProfileName::Production | ProfileName::Sepolia)
    }

    /// The numbers of this profile.
    pub fn gates(self) -> &'static Gates {
        match self {
            ProfileName::Production => &PRODUCTION,
            ProfileName::Rehearsal => &REHEARSAL,
            ProfileName::Sepolia => &SEPOLIA,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            ProfileName::Production => "production",
            ProfileName::Rehearsal => "rehearsal",
            ProfileName::Sepolia => "sepolia",
        }
    }
}

impl fmt::Display for ProfileName {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

impl FromStr for ProfileName {
    type Err = String;
    fn from_str(s: &str) -> Result<Self, String> {
        match s {
            "production" => Ok(ProfileName::Production),
            "rehearsal" => Ok(ProfileName::Rehearsal),
            "sepolia" => Ok(ProfileName::Sepolia),
            other => Err(format!("unknown profile {other:?} (expected production, rehearsal or sepolia)")),
        }
    }
}

// ---------------------------------------------------------------- the contract version

/// Which Parano1d contract the NOID is locked in. Like [`ProfileName`], the default (`1`) is NOT written
/// to a swap file or bundle, so a file with no `contract_version` field is a v1 file and keeps its digest
/// (the value the secret is sealed to) unchanged; `2` is written.
///
/// - `1`: `HashTimeLock` (`parano1d/contracts/htlc.pruv`). A close may pay any fee in
///   `[MIN_CLOSE_FEE, max_fee]`; `max_fee` is a ceiling.
/// - `2`: `HashTimeLockV2` (`parano1d/contracts/htlc_v2.pruv`). Every close pays EXACTLY `max_fee`
///   (`docs/htlc-v2-fixed-fee.md`); `max_fee` is also the price. A different program, so a different
///   contract address for the same parameters.
///
/// The version is committed on both sides by the opening itself (the code id is part of the 699 bytes
/// and of the address): both parties rebuild the opening from the version, and a bundle whose version
/// field was changed or removed no longer rebuilds byte-for-byte.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(try_from = "u8", into = "u8")]
pub enum ContractVersion {
    #[default]
    V1,
    V2,
}

impl ContractVersion {
    pub fn is_v1(&self) -> bool {
        matches!(self, ContractVersion::V1)
    }

    pub fn number(self) -> u8 {
        match self {
            ContractVersion::V1 => 1,
            ContractVersion::V2 => 2,
        }
    }

    /// v2 closes pay exactly `max_fee`; v1 closes pay anything in `[MIN_CLOSE_FEE, max_fee]`.
    pub fn is_fixed_fee(self) -> bool {
        matches!(self, ContractVersion::V2)
    }

    /// The `F_max` headroom factor over the observed fee floor: 3 for v1 (`F_MAX_ESTIMATE_MULTIPLIER`), 5 for v2
    /// (`F_MAX_FLOOR_MULTIPLIER_V2`, `docs/htlc-v2-fixed-fee.md` section 5).
    pub fn f_max_multiplier(self) -> u64 {
        match self {
            ContractVersion::V1 => F_MAX_ESTIMATE_MULTIPLIER,
            ContractVersion::V2 => F_MAX_FLOOR_MULTIPLIER_V2,
        }
    }

    /// The Pruv source the version compiles from, relative to the repository root.
    pub fn source_path(self) -> &'static str {
        match self {
            ContractVersion::V1 => "parano1d/contracts/htlc.pruv",
            ContractVersion::V2 => "parano1d/contracts/htlc_v2.pruv",
        }
    }

    /// The contract's name in the Pruv source.
    pub fn contract_name(self) -> &'static str {
        match self {
            ContractVersion::V1 => "HashTimeLock",
            ContractVersion::V2 => "HashTimeLockV2",
        }
    }

    /// The only fee a close may pay, or the `(min, max)` range for v1.
    pub fn allowed_fee_range(self, max_fee: u64) -> (u64, u64) {
        match self {
            ContractVersion::V1 => (MIN_CLOSE_FEE, max_fee),
            ContractVersion::V2 => (max_fee, max_fee),
        }
    }
}

impl From<ContractVersion> for u8 {
    fn from(v: ContractVersion) -> u8 {
        v.number()
    }
}

impl TryFrom<u8> for ContractVersion {
    type Error = String;
    fn try_from(n: u8) -> Result<Self, String> {
        match n {
            1 => Ok(ContractVersion::V1),
            2 => Ok(ContractVersion::V2),
            other => Err(format!("unknown contract_version {other} (expected 1 or 2)")),
        }
    }
}

impl fmt::Display for ContractVersion {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}", self.number())
    }
}

impl FromStr for ContractVersion {
    type Err = String;
    fn from_str(s: &str) -> Result<Self, String> {
        match s {
            "1" => Ok(ContractVersion::V1),
            "2" => Ok(ContractVersion::V2),
            other => Err(format!("unknown contract version {other:?} (expected 1 or 2)")),
        }
    }
}

/// Every timing number the gates (I1)..(I5) read, plus the amount and chain caps of a profile.
/// Times are seconds, heights are Parano1d blocks.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Gates {
    pub name: ProfileName,
    /// Parano1d planning-fast block interval: blocks are assumed to arrive this fast.
    pub tau_fast_s: u64,
    /// Alice's reveal window after Bob's lock, and its minimum (I3).
    pub w_a_s: u64,
    pub w_a_min_s: u64,
    /// Alice's reveal margin before `T_reveal` (I2).
    pub m_a_s: u64,
    /// Reveal detection latency.
    pub delta_detect_s: u64,
    /// Authorization proving budget, spent twice in (I1).
    pub p_auth_budget_s: u64,
    /// Time for an Ethereum lock/claim to become final on the chain this profile runs on.
    pub eth_finality_s: u64,
    /// Ethereum inclusion-delay budget `DE` (seconds): how long a correctly priced transaction may take to be mined after it is sent
    /// (formal model, `docs/formal/README.md` section 7). Mainnet and Sepolia blocks are 12 s apart, so 120 s is ten blocks; the local
    /// chain mines on demand and the runbook mines after every send, so 60 s.
    pub de_s: u64,
    /// Alice's rebroadcast time `RA` (seconds): from her claim being dropped from a block to her next attempt being sent (one poll to
    /// notice, one to resend). 120 s on the public chains (two polls of 60 s); 60 s on the local chain.
    pub ra_s: u64,
    /// REVIEW-4 R4-11: how long a submitted Ethereum transaction (lock, reveal, refund) may stay unseen before the engine looks at it as
    /// possibly dropped (together with the nonce rule, never the clock alone). 600 s (fifty blocks) on the public chains; 120 s on the
    /// local chain, which mines on demand and whose whole reveal window is 600 s.
    pub tx_grace_s: u64,
    /// Budget for one epoch-anchor rotation (blocks). The CHAIN's epoch length is [`B_EPOCH`].
    pub b_epoch_budget: u64,
    pub b_fee: u64,
    /// Parano1d finality, blocks. Must equal [`B_FINAL`]: a profile cannot change the chain.
    pub b_final: u64,
    pub b_safety: u64,
    /// Blocks Alice allows for her funding to be included.
    pub b_fund: u64,
    /// Bob must lock within this many blocks after Alice's funding is final.
    pub b_bob: u64,
    /// The deliberate rounding-up in `D_offset`.
    pub margin: u64,
    /// `D = H_create + d_offset`.
    pub d_offset: u64,
    /// Refuse a swap of more than this many micro-NOID (`None` = no cap).
    pub max_noid_micro: Option<u64>,
    /// Refuse a swap of more than this many wei (`None` = no cap).
    pub max_eth_wei: Option<u128>,
    /// Refuse any Ethereum chain id not in this list (`None` = any).
    pub eth_chain_ids: Option<&'static [u64]>,
}

/// Section 9.1 as it stood on 2026-11-04.
pub const PRODUCTION: Gates = Gates {
    name: ProfileName::Production,
    tau_fast_s: 20,
    w_a_s: 7_200,
    w_a_min_s: 5_400,
    m_a_s: 1_800,
    delta_detect_s: 300,
    p_auth_budget_s: 20,
    eth_finality_s: 1_140,
    de_s: 120,
    ra_s: 120,
    tx_grace_s: 600,
    b_epoch_budget: 144,
    b_fee: 60,
    b_final: 18,
    b_safety: 30,
    b_fund: 10,
    b_bob: 60,
    margin: 18,
    d_offset: 735,
    max_noid_micro: None,
    max_eth_wei: None,
    eth_chain_ids: None,
};

/// The rehearsal profile: derivation in the module documentation. At most 20 NOID, 0.01 ETH, chain 31337.
pub const REHEARSAL: Gates = Gates {
    name: ProfileName::Rehearsal,
    tau_fast_s: 20,
    w_a_s: 600,
    w_a_min_s: 480,
    m_a_s: 300,
    delta_detect_s: 60,
    p_auth_budget_s: 20,
    eth_finality_s: 0,
    de_s: 60,
    ra_s: 60,
    tx_grace_s: 120,
    b_epoch_budget: 0,
    b_fee: 10,
    b_final: 18,
    b_safety: 5,
    b_fund: 5,
    b_bob: 20,
    margin: 9,
    d_offset: 120,
    max_noid_micro: Some(20_000_000),
    max_eth_wei: Some(10_000_000_000_000_000),
    eth_chain_ids: Some(&[31_337]),
};

/// The sepolia profile: rehearsal budgets with the real Ethereum finality (1,140 s) and the production
/// M_A (1,800 s = live.js's default --margin-s). At most 20 NOID, 0.01 ETH, chain 11155111 only.
pub const SEPOLIA: Gates = Gates {
    name: ProfileName::Sepolia,
    tau_fast_s: 20,
    w_a_s: 4_200,
    w_a_min_s: 3_360,
    m_a_s: 1_800,
    delta_detect_s: 120,
    p_auth_budget_s: 20,
    eth_finality_s: 1_140,
    de_s: 120,
    ra_s: 120,
    tx_grace_s: 600,
    b_epoch_budget: 0,
    b_fee: 10,
    b_final: 18,
    b_safety: 5,
    b_fund: 5,
    b_bob: 20,
    margin: 6,
    d_offset: 300,
    max_noid_micro: Some(20_000_000),
    max_eth_wei: Some(10_000_000_000_000_000),
    eth_chain_ids: Some(&[11_155_111]),
};

// ---------------------------------------------------------------- chain facts and production values

/// Parano1d planning-fast block interval (seconds), production.
pub const TAU_FAST_S: u64 = PRODUCTION.tau_fast_s;
/// Parano1d nominal block interval (seconds), for display only.
pub const TAU_NOM_S: u64 = 30;
/// Finality: a Parano1d inclusion is final once the tip is 17 blocks past it. A chain fact: every profile.
pub const B_FINAL: u64 = 18;
/// One transaction-epoch anchor rotation (`noid_tx::TX_EPOCH_BLOCKS`): the chain's epoch length, not a budget.
pub const B_EPOCH: u64 = 144;
/// Relay-floor / congestion wait budget (blocks), production.
pub const B_FEE: u64 = PRODUCTION.b_fee;
/// Operational slack (blocks), production.
pub const B_SAFETY: u64 = PRODUCTION.b_safety;
/// `B_post = B_epoch + B_fee + B_final + B_safety`, production.
pub const B_POST: u64 = PRODUCTION.b_post();
/// Authorization proving budget (seconds), spent twice in (I1). M0.5 measured
/// p50 1.5 s and a worst p99 of 6.0 s on the owner's 3 GB VM; budget = 3 x 6.0, rounded.
pub const P_AUTH_BUDGET_S: u64 = PRODUCTION.p_auth_budget_s;
/// Ethereum reveal detection latency (seconds), production.
pub const DELTA_DETECT_S: u64 = PRODUCTION.delta_detect_s;
/// Alice's reveal margin before `T_reveal` (seconds), production.
pub const M_A_S: u64 = PRODUCTION.m_a_s;
/// Alice's reveal window after Bob's lock (seconds) and its minimum, production.
pub const W_A_S: u64 = PRODUCTION.w_a_s;
pub const W_A_MIN_S: u64 = PRODUCTION.w_a_min_s;
/// Blocks Alice allows for her funding to be included, production.
pub const B_FUND: u64 = PRODUCTION.b_fund;
/// Bob must lock within this many blocks after Alice's funding is final, production.
pub const B_BOB: u64 = PRODUCTION.b_bob;
/// ETH pair: `D = H_create + 735` (about 6 h at 30 s/block), production.
pub const ETH_D_OFFSET: u64 = PRODUCTION.d_offset;
/// Hard rule: Bob's claim must be included at `h <= D - 1`; target `h <= D - 18`.
pub const CLAIM_TARGET_MARGIN: u64 = B_FINAL;

/// `F_max = max(50,000, 3 x estimateFeeDetailed(1,1))`, and at most 1 % of `V`. Fee policy, the
/// same in every profile.
pub const F_MAX_FLOOR_MICRONOID: u64 = 50_000;
pub const F_MAX_ESTIMATE_MULTIPLIER: u64 = 3;
/// Contract v2 (`HashTimeLockV2`): `max_fee` is both the ceiling and the exact price of every close, so it is
/// chosen once with more headroom: `F_max = max(50,000, 5 x floor_seen)` where `floor_seen` is the larger of the live
/// `estimateFeeDetailed(1,1)` and the highest relay floor the operator saw in the last 24 h
/// (`docs/htlc-v2-fixed-fee.md` section 5). Still at most 1 % of `V` (`F_MAX_MAX_PERCENT_OF_V`).
pub const F_MAX_FLOOR_MULTIPLIER_V2: u64 = 5;
pub const F_MAX_MAX_PERCENT_OF_V: u64 = 1;

/// Smallest fee the chain accepts for a 1-in/1-out close (harness `MIN_CLOSE_FEE`).
pub const MIN_CLOSE_FEE: u64 = htlc_harness::MIN_CLOSE_FEE;

/// v2.1 activation height: owner-authorization V3 -> V4 (harness mirror of
/// `noid_chain::consensus::params`).
pub const V2_1_ACTIVATION_HEIGHT: u64 = htlc_harness::V2_1_ACTIVATION_HEIGHT;
/// Trials start only at `activation + B_final` (PROJECT.md decision 8).
pub const TRIAL_START_HEIGHT: u64 = V2_1_ACTIVATION_HEIGHT + B_FINAL;

/// T6, production: do not start a proof in the last `ceil(P_auth / tau_fast) + 3` blocks of
/// an epoch; wait for the boundary instead. With `P_auth` = 20 s that is 4.
pub const ROTATION_GUARD_BLOCKS: u64 = PRODUCTION.rotation_guard_blocks();

/// REVIEW-3 F1: `keccak256` of the runtime code of `eth/contracts/HTLC.sol` (the artifact's `deployedBytecode`, 2,633 bytes,
/// Hardhat with solc 0.8.24), `0xa906117f..45e2f`. It is a constant of this build, not something an operator types: the local
/// run-1 deployment and the Sepolia deployment both reported exactly this
/// value. A contract with any other code hash is a different contract and every ETH spend against it is refused; there is no
/// override. A unit test compares it with the local artifact whenever `eth/artifacts` has been compiled.
pub const HTLC_CODE_HASH: [u8; 32] = [
    0xa9, 0x06, 0x11, 0x7f, 0xc4, 0xe6, 0x04, 0xbd, 0x25, 0xfc, 0xee, 0x2a, 0x6a, 0x41, 0xda, 0x8b,
    0x82, 0x4e, 0xc9, 0xb4, 0xa1, 0x7d, 0x10, 0x13, 0x77, 0x04, 0xe7, 0xda, 0x42, 0x54, 0x5e, 0x2f,
];

/// REVIEW-3 F2: the image id of the equivalence-proof guest (`equiv/zkvm/methods/guest`), `7e9d8477..6187`: the id of the LOCAL
/// build at this commit (RISC Zero 3.0.6, WSL), not yet the reproducible docker build (milestone M1.1). It is a constant of
/// this build, not something Bob types: `new-bob` pins it, `EquivalenceAttestation::check` requires the file to pin exactly it,
/// and `verify_receipt` requires the verifier to print it. When M1.1 is done this constant is replaced by the docker id, and a
/// swap file pinned to the old id then stops loading on purpose. There is no override.
pub const EQUIV_IMAGE_ID: [u8; 32] = [
    0x7e, 0x9d, 0x84, 0x77, 0xc6, 0x7a, 0x99, 0x71, 0xbf, 0x38, 0xbd, 0x6a, 0x3e, 0xb2, 0x17, 0xcf,
    0xb0, 0xa4, 0xb2, 0x24, 0x06, 0x2b, 0x2f, 0x20, 0x59, 0xd5, 0x78, 0xc6, 0x1d, 0x1c, 0x61, 0x87,
];

// ---------------------------------------------------------------- errors

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum GateError {
    /// (I1) fails: `D - H_b` is smaller than the blocks Bob needs.
    BobUnsafe { d: u64, h_b: u64, needed: u64, available: u64 },
    /// `T_reveal - t_now < W_A_min`: Alice would not reveal, so Bob should not lock.
    RevealWindowTooShort { t_reveal: u64, t_now: u64, minimum: u64 },
    /// `D` is already too close for any reveal window.
    NoRevealWindow { d: u64, h_now: u64 },
    /// Bob is past his lock-by height.
    PastLockBy { h_now: u64, lock_by: u64 },
    /// Bob is more than `B_bob` blocks past Alice's funding finality.
    PastBobWindow { h_now: u64, h_final: u64, b_bob: u64 },
    /// (I2) fails: `now > T_reveal - M_A`.
    RevealCutoffPassed { now: u64, cutoff: u64 },
    /// (I2): Bob's lock is not finalized yet.
    LockNotFinalized,
    /// (I5) fails: the window `[H_create, D + B_post]` contains the activation height.
    VersionBoundaryInWindow { h_create: u64, d: u64, window_end: u64, boundary: u64 },
    /// Trials start at `activation + 18`.
    BeforeTrialStart { h_create: u64, start: u64 },
    /// `F_max` would exceed 1 % of the locked amount.
    FeeCapTooLarge { f_max: u64, amount: u64 },
    /// Arithmetic overflow in a height or time computation.
    Overflow,
    /// A profile's numbers break one of the section 4 relations ([`Gates::validate`]).
    BadProfile(String),
    /// The profile caps the NOID amount.
    NoidAmountAboveCap { profile: ProfileName, amount: u64, cap: u64 },
    /// The profile caps the ETH amount.
    EthAmountAboveCap { profile: ProfileName, wei: u128, cap: u128 },
    /// The profile only runs on certain Ethereum chains.
    ChainNotAllowed { profile: ProfileName, chain_id: u64, allowed: Vec<u64> },
}

impl fmt::Display for GateError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            GateError::BobUnsafe { d, h_b, needed, available } => write!(
                f,
                "(I1) Bob unsafe: D - H_b = {d} - {h_b} = {available} blocks, needs >= {needed}"
            ),
            GateError::RevealWindowTooShort { t_reveal, t_now, minimum } => write!(
                f,
                "reveal window {} s < W_A_min {minimum} s (T_reveal {t_reveal}, now {t_now})",
                t_reveal.saturating_sub(*t_now)
            ),
            GateError::NoRevealWindow { d, h_now } => {
                write!(f, "D = {d} is too close to height {h_now} for any reveal window")
            }
            GateError::PastLockBy { h_now, lock_by } => {
                write!(f, "height {h_now} is past Bob's lock-by height {lock_by}")
            }
            GateError::PastBobWindow { h_now, h_final, b_bob } => write!(
                f,
                "height {h_now} is more than B_bob = {b_bob} blocks past funding finality {h_final}"
            ),
            GateError::RevealCutoffPassed { now, cutoff } => write!(
                f,
                "(I2) reveal cutoff passed: now {now} > T_reveal - M_A = {cutoff}; do NOT broadcast"
            ),
            GateError::LockNotFinalized => write!(f, "(I2) Bob's Ethereum lock is not finalized"),
            GateError::VersionBoundaryInWindow { h_create, d, window_end, boundary } => write!(
                f,
                "(I5) authorization version changes at {boundary}, inside [{h_create}, {window_end}] (D = {d} plus B_post)"
            ),
            GateError::BeforeTrialStart { h_create, start } => {
                write!(f, "height {h_create} is before the trial start {start}")
            }
            GateError::FeeCapTooLarge { f_max, amount } => write!(
                f,
                "F_max {f_max} exceeds {F_MAX_MAX_PERCENT_OF_V} % of the amount {amount}"
            ),
            GateError::Overflow => write!(f, "height/time arithmetic overflow"),
            GateError::BadProfile(why) => write!(f, "profile numbers are inconsistent: {why}"),
            GateError::NoidAmountAboveCap { profile, amount, cap } => write!(
                f,
                "the {profile} profile refuses {amount} micro-NOID: its cap is {cap} micro-NOID ({} NOID)",
                cap / 1_000_000
            ),
            GateError::EthAmountAboveCap { profile, wei, cap } => {
                write!(f, "the {profile} profile refuses {wei} wei: its cap is {cap} wei")
            }
            GateError::ChainNotAllowed { profile, chain_id, allowed } => {
                write!(f, "the {profile} profile only runs on Ethereum chain id(s) {allowed:?}, not {chain_id}")
            }
        }
    }
}

impl std::error::Error for GateError {}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct I1Report {
    pub needed: u64,
    pub available: u64,
    pub slack: u64,
}

// ---------------------------------------------------------------- the gates

impl Gates {
    /// `B_post = B_epoch + B_fee + B_final + B_safety`.
    pub const fn b_post(&self) -> u64 {
        self.b_epoch_budget + self.b_fee + self.b_final + self.b_safety
    }

    /// T6: blocks at the end of an epoch in which a proof is not started: `ceil(P_auth / tau_fast) + 3`.
    pub const fn rotation_guard_blocks(&self) -> u64 {
        self.p_auth_budget_s.div_ceil(self.tau_fast_s) + 3
    }

    /// Right-hand side of (I1) for the ETH pair:
    /// `ceil((t_L - t_b + 2 P_auth) / tau_fast) + B_post` with `t_L = T_reveal + Delta_detect`.
    pub fn rhs_i1_eth(&self, t_reveal: u64, t_b: u64) -> Result<u64, GateError> {
        let t_l = t_reveal.checked_add(self.delta_detect_s).ok_or(GateError::Overflow)?;
        let span = t_l
            .checked_sub(t_b)
            .ok_or(GateError::Overflow)?
            .checked_add(2 * self.p_auth_budget_s)
            .ok_or(GateError::Overflow)?;
        Ok(span.div_ceil(self.tau_fast_s) + self.b_post())
    }

    /// The blocks (I1) demands for a window `w_a_s`: 629 for the full production window.
    pub const fn rhs_i1_eth_for_window(&self, w_a_s: u64) -> u64 {
        (w_a_s + self.delta_detect_s + 2 * self.p_auth_budget_s).div_ceil(self.tau_fast_s) + self.b_post()
    }

    /// Bob's lock-by height for the full window: `D - RHS(I1)(W_A)` (`D - 629` in production).
    pub fn bob_lock_by(&self, d: u64) -> u64 {
        d.saturating_sub(self.rhs_i1_eth_for_window(self.w_a_s))
    }

    /// Bob's last possible lock height with the minimum window `W_A_min`.
    pub fn bob_lock_by_min_window(&self, d: u64) -> u64 {
        d.saturating_sub(self.rhs_i1_eth_for_window(self.w_a_min_s))
    }

    /// (I1) at Bob's lock time: `D - H_b >= RHS`.
    pub fn check_i1_eth(&self, d: u64, h_b: u64, t_reveal: u64, t_b: u64) -> Result<I1Report, GateError> {
        let needed = self.rhs_i1_eth(t_reveal, t_b)?;
        let available = d.saturating_sub(h_b);
        if available < needed {
            return Err(GateError::BobUnsafe { d, h_b, needed, available });
        }
        Ok(I1Report { needed, available, slack: available - needed })
    }

    /// Largest `T_reveal` that satisfies (I1) at height `h_now`, time `t_now`:
    /// `T_max = t_now + (D - h_now - B_post) * tau_fast - Delta_detect - 2 P_auth`.
    pub fn t_max_eth(&self, d: u64, h_now: u64, t_now: u64) -> Result<u64, GateError> {
        let k = d
            .checked_sub(h_now)
            .and_then(|x| x.checked_sub(self.b_post()))
            .ok_or(GateError::NoRevealWindow { d, h_now })?;
        let budget = k
            .checked_mul(self.tau_fast_s)
            .ok_or(GateError::Overflow)?
            .checked_sub(self.delta_detect_s + 2 * self.p_auth_budget_s)
            .ok_or(GateError::NoRevealWindow { d, h_now })?;
        t_now.checked_add(budget).ok_or(GateError::Overflow)
    }

    /// Bob's `T_reveal` (step 8): `min(t_now + W_A, T_max)`, refused below `W_A_min`.
    /// Also enforces the lock-by height and the `B_bob` window after funding finality.
    pub fn choose_t_reveal(&self, d: u64, h_now: u64, t_now: u64, funding_final_height: u64) -> Result<u64, GateError> {
        let lock_by = self.bob_lock_by_min_window(d);
        if h_now > lock_by {
            return Err(GateError::PastLockBy { h_now, lock_by });
        }
        if h_now > funding_final_height.saturating_add(self.b_bob) {
            return Err(GateError::PastBobWindow { h_now, h_final: funding_final_height, b_bob: self.b_bob });
        }
        let t_max = self.t_max_eth(d, h_now, t_now)?;
        let t_reveal = t_now.checked_add(self.w_a_s).ok_or(GateError::Overflow)?.min(t_max);
        if t_reveal.saturating_sub(t_now) < self.w_a_min_s {
            return Err(GateError::RevealWindowTooShort { t_reveal, t_now, minimum: self.w_a_min_s });
        }
        // Belt and braces: the chosen value must pass (I1) itself.
        self.check_i1_eth(d, h_now, t_reveal, t_now)?;
        Ok(t_reveal)
    }

    /// Alice's reveal cutoff: `T_reveal - M_A`.
    pub fn reveal_cutoff(&self, t_reveal: u64) -> u64 {
        t_reveal.saturating_sub(self.m_a_s)
    }

    /// (I2) for ETH: broadcast the claim only if `now <= T_reveal - M_A` and Bob's
    /// lock is finalized. A late claim still publishes the secret and loses both legs.
    pub fn check_i2_eth(&self, now: u64, t_reveal: u64, lock_finalized: bool) -> Result<(), GateError> {
        if !lock_finalized {
            return Err(GateError::LockNotFinalized);
        }
        let cutoff = self.reveal_cutoff(t_reveal);
        if now > cutoff {
            return Err(GateError::RevealCutoffPassed { now, cutoff });
        }
        Ok(())
    }

    /// Alice's step-9 check 5: `T_reveal - now >= M_A`.
    pub fn alice_accepts_t_reveal(&self, now: u64, t_reveal: u64) -> bool {
        t_reveal.saturating_sub(now) >= self.m_a_s
    }

    /// (I3) Alice liveness: `T_reveal - t_b >= W_A_min`.
    pub fn check_i3(&self, t_reveal: u64, t_b: u64) -> bool {
        t_reveal.saturating_sub(t_b) >= self.w_a_min_s
    }

    /// (I5): no owner-authorization version change inside `[H_create, D + B_post]`,
    /// and the trial starts at `activation + 18` or later.
    pub fn check_i5(&self, h_create: u64, d: u64) -> Result<(), GateError> {
        let end = d.checked_add(self.b_post()).ok_or(GateError::Overflow)?;
        let boundary = V2_1_ACTIVATION_HEIGHT;
        if h_create <= boundary && boundary <= end {
            return Err(GateError::VersionBoundaryInWindow { h_create, d, window_end: end, boundary });
        }
        if h_create < TRIAL_START_HEIGHT {
            return Err(GateError::BeforeTrialStart { h_create, start: TRIAL_START_HEIGHT });
        }
        Ok(())
    }

    /// Alice's deadline for the ETH pair: `D = H_create + D_offset`.
    pub fn alice_deadline_eth(&self, h_create: u64) -> Result<u64, GateError> {
        h_create.checked_add(self.d_offset).ok_or(GateError::Overflow)
    }

    /// T6: avoid proving in the last `rotation_guard_blocks` blocks of an epoch.
    pub fn rotation_guard(&self, child_height: u64) -> RotationGuard {
        let left = blocks_until_rotation(child_height);
        if left <= self.rotation_guard_blocks() {
            RotationGuard::WaitForBoundary { blocks: left }
        } else {
            RotationGuard::ProveNow
        }
    }

    /// `D_offset` as section 4.2 derives it: `B_fund + B_final + B_bob + RHS(I1)(W_A) + margin`.
    pub fn d_offset_derived(&self) -> u64 {
        self.b_fund + self.b_final + self.b_bob + self.rhs_i1_eth_for_window(self.w_a_s) + self.margin
    }

    /// The caps of a profile on one swap: NOID amount, ETH amount, Ethereum chain id.
    pub fn check_caps(&self, amount_micronoid: u64, amount_wei: u128, chain_id: u64) -> Result<(), GateError> {
        if let Some(cap) = self.max_noid_micro {
            if amount_micronoid > cap {
                return Err(GateError::NoidAmountAboveCap { profile: self.name, amount: amount_micronoid, cap });
            }
        }
        if let Some(cap) = self.max_eth_wei {
            if amount_wei > cap {
                return Err(GateError::EthAmountAboveCap { profile: self.name, wei: amount_wei, cap });
            }
        }
        if let Some(allowed) = self.eth_chain_ids {
            if !allowed.contains(&chain_id) {
                return Err(GateError::ChainNotAllowed { profile: self.name, chain_id, allowed: allowed.to_vec() });
            }
        }
        Ok(())
    }

    /// The section 4.2/4.3 relations between a profile's numbers. The production, rehearsal and
    /// sepolia profiles are all accepted by this one checker, and a profile that breaks any of
    /// them is not:
    ///
    /// 1. `tau_fast`, `W_A`, `W_A_min`, `M_A`, `P_auth` are non-zero and `W_A_min <= W_A` (I3).
    /// 2. `B_final` equals the Parano1d finality (18): a profile cannot shorten the chain.
    /// 3. (I2) `M_A > eth_finality`: a claim broadcast at the cutoff is final before `T_reveal`.
    /// 4. (I2)+(I3) `W_A_min - M_A >= eth_finality + Delta_detect`: even at the minimum window Alice has
    ///    time to see Bob's lock become final and to act before her cutoff.
    /// 4a. (formal model, `docs/formal/README.md` section 7) `M_A >= eth_finality + 2*DE + RA` and
    ///    `W_A_min >= DE + eth_finality + RA + M_A`, with `DE` (Ethereum inclusion delay) and `RA` (Alice's rebroadcast
    ///    time) per profile: one Ethereum reorg of Alice's claim can still be answered before `T_reveal`.
    /// 5. `D_offset = B_fund + B_final + B_bob + RHS(I1)(W_A) + margin` (section 4.2, "Alice picks D").
    ///    Then a Bob who locks as late as `B_bob` blocks after funding finality still satisfies (I1) with
    ///    `margin` blocks to spare, and the lock-by height is after Alice's funding is final.
    /// 6. The T6 rotation guard fits in `B_safety`.
    /// 7. Every non-production profile (`rehearsal`, `sepolia`) has all three caps; the production one has none.
    pub fn validate(&self) -> Result<(), GateError> {
        let bad = |why: String| Err(GateError::BadProfile(format!("{}: {why}", self.name)));
        if self.tau_fast_s == 0 || self.w_a_s == 0 || self.w_a_min_s == 0 || self.m_a_s == 0 || self.p_auth_budget_s == 0 {
            return bad("tau_fast, W_A, W_A_min, M_A and P_auth must be non-zero".into());
        }
        if self.w_a_min_s > self.w_a_s {
            return bad(format!("(I3) W_A_min {} > W_A {}", self.w_a_min_s, self.w_a_s));
        }
        if self.b_final != B_FINAL {
            return bad(format!("B_final {} is not the Parano1d finality {B_FINAL}", self.b_final));
        }
        if self.m_a_s <= self.eth_finality_s {
            return bad(format!("(I2) M_A {} s does not exceed the Ethereum finality {} s", self.m_a_s, self.eth_finality_s));
        }
        let alice_time = self.w_a_min_s.saturating_sub(self.m_a_s);
        if alice_time < self.eth_finality_s + self.delta_detect_s {
            return bad(format!(
                "(I2)/(I3) W_A_min - M_A = {alice_time} s is less than eth_finality + Delta_detect = {} s",
                self.eth_finality_s + self.delta_detect_s
            ));
        }
        // Formal model (docs/formal/README.md section 7, finding 2): one Ethereum reorg of Alice's claim needs
        // `M_A >= FE + 2*DE + RA` (claim mined at the cutoff plus DE, dropped just before final, rebroadcast after RA, mined again
        // within DE, still before T_reveal) and `W_A_min >= DE + FE + RA + M_A`.
        let reorg_margin = self.eth_finality_s + 2 * self.de_s + self.ra_s;
        if self.m_a_s < reorg_margin {
            return bad(format!(
                "(I2) M_A {} s < eth_finality {} + 2*DE {} + RA {} = {reorg_margin} s: one Ethereum reorg of Alice's claim could not be re-sent in time",
                self.m_a_s,
                self.eth_finality_s,
                2 * self.de_s,
                self.ra_s
            ));
        }
        let min_window = self.de_s + self.eth_finality_s + self.ra_s + self.m_a_s;
        if self.w_a_min_s < min_window {
            return bad(format!(
                "(I3) W_A_min {} s < DE {} + eth_finality {} + RA {} + M_A {} = {min_window} s: Alice has no time to see the lock final and still survive one claim reorg",
                self.w_a_min_s, self.de_s, self.eth_finality_s, self.ra_s, self.m_a_s
            ));
        }
        // REVIEW-4 R4-11: the drop grace is at least two rebroadcast times (one poll to see the transaction, one to send again).
        if self.tx_grace_s < 2 * self.ra_s {
            return bad(format!("tx_grace {} s < 2*RA {} s: a submitted transaction would be called dropped before two polls could see it", self.tx_grace_s, 2 * self.ra_s));
        }
        let derived = self.d_offset_derived();
        if self.d_offset != derived {
            return bad(format!(
                "D_offset {} != B_fund {} + B_final {} + B_bob {} + RHS(I1) {} + margin {} = {derived}",
                self.d_offset,
                self.b_fund,
                self.b_final,
                self.b_bob,
                self.rhs_i1_eth_for_window(self.w_a_s),
                self.margin
            ));
        }
        if self.rotation_guard_blocks() > self.b_safety {
            return bad(format!("the T6 guard ({} blocks) does not fit in B_safety {}", self.rotation_guard_blocks(), self.b_safety));
        }
        let capped = self.max_noid_micro.is_some() && self.max_eth_wei.is_some() && self.eth_chain_ids.is_some();
        let uncapped = self.max_noid_micro.is_none() && self.max_eth_wei.is_none() && self.eth_chain_ids.is_none();
        match self.name {
            ProfileName::Rehearsal | ProfileName::Sepolia if !capped => {
                bad("a non-production profile (rehearsal, sepolia) must cap the NOID amount, the ETH amount and the chain".into())
            }
            ProfileName::Production if !uncapped => bad("the production profile has no caps".into()),
            _ => Ok(()),
        }
    }
}

// ---------------------------------------------------------------- (I4) claim inclusion (chain facts)

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ClaimHeight {
    /// `h <= D - 18`: on target.
    OnTarget,
    /// `D - 18 < h <= D - 1`: valid but may be reorged across `D`; last resort.
    LateButValid,
    /// `h >= D`: the claim branch is closed; the call would be rejected/evicted.
    TooLate,
}

/// (I4): classify a candidate inclusion height for Bob's claim. Parano1d finality is 18 blocks in
/// every profile ([`Gates::validate`] insists), so this does not take a profile.
pub fn classify_claim_height(h: u64, d: u64) -> ClaimHeight {
    if h >= d {
        ClaimHeight::TooLate
    } else if h + CLAIM_TARGET_MARGIN <= d {
        ClaimHeight::OnTarget
    } else {
        ClaimHeight::LateButValid
    }
}

/// Alice's refund opens when the next call height reaches `D`.
pub fn alice_refund_ready(tip: u64, d: u64) -> bool {
    tip.saturating_add(1) >= d
}

/// Bob's Ethereum refund opens at `block.timestamp >= T_reveal`.
pub fn bob_eth_refund_ready(block_timestamp: u64, t_reveal: u64) -> bool {
    block_timestamp >= t_reveal
}

/// Parano1d finality: an inclusion at `h` is final once `tip >= h + 17`.
pub fn noid_final(tip: u64, inclusion_height: u64) -> bool {
    tip >= inclusion_height.saturating_add(B_FINAL - 1)
}

/// The owner-authorization version a proof must use for inclusion height `h`.
pub fn auth_version_at(height: u64) -> OwnerAuthorizationVersion {
    htlc_harness::auth_version_at(height)
}

// ---------------------------------------------------------------- the fee cap

/// `F_max = max(50,000, 3 x estimate)`, at most 1 % of the locked amount `V` (the contract v1 rule).
pub fn fee_cap(estimate_1_1: u64, amount_v: u64) -> Result<u64, GateError> {
    fee_cap_for(ContractVersion::V1, estimate_1_1, amount_v)
}

/// `F_max` by contract version, at most 1 % of the locked amount `V`, never below [`MIN_CLOSE_FEE`].
///
/// - v1: `max(50,000, 3 x estimate)`; `floor_seen` is the live `estimateFeeDetailed(1,1)`.
/// - v2: `max(50,000, 5 x floor_seen)`; `floor_seen` is the larger of that estimate and the highest relay floor
///   the operator saw in the last 24 h (`docs/htlc-v2-fixed-fee.md` section 5). With v2 the number is the exact price
///   of every close, so the 1 % rule is the real cost and a swap too small to pay it is refused.
pub fn fee_cap_for(version: ContractVersion, floor_seen: u64, amount_v: u64) -> Result<u64, GateError> {
    let f_max = F_MAX_FLOOR_MICRONOID.max(floor_seen.checked_mul(version.f_max_multiplier()).ok_or(GateError::Overflow)?);
    let budget = amount_v.checked_mul(F_MAX_MAX_PERCENT_OF_V).ok_or(GateError::Overflow)?;
    if f_max.checked_mul(100).ok_or(GateError::Overflow)? > budget {
        return Err(GateError::FeeCapTooLarge { f_max, amount: amount_v });
    }
    debug_assert!(f_max >= MIN_CLOSE_FEE);
    Ok(f_max)
}

/// The `floor_seen` input of [`fee_cap_for`]: v1 uses the live estimate only (an operator-supplied floor is ignored);
/// v2 uses the larger of the estimate and the operator's highest floor of the last 24 h.
pub fn floor_seen_for(version: ContractVersion, estimate_1_1: u64, operator_floor: Option<u64>) -> u64 {
    match version {
        ContractVersion::V1 => estimate_1_1,
        ContractVersion::V2 => estimate_1_1.max(operator_floor.unwrap_or(0)),
    }
}

// ---------------------------------------------------------------- epochs (T6)

/// Anchor height for a child block `c`: `((c - 1) / 144) * 144`
/// (`noid_chain::consensus::epoch_anchor::tx_epoch_anchor_height_for_child`).
pub fn epoch_anchor_height_for_child(child_height: u64) -> u64 {
    if child_height == 0 {
        return 0;
    }
    ((child_height - 1) / B_EPOCH) * B_EPOCH
}

/// Blocks from child height `c` until the anchor rotates (the first child
/// height with a different anchor is `k * 144 + 1`).
pub fn blocks_until_rotation(child_height: u64) -> u64 {
    let anchor = epoch_anchor_height_for_child(child_height);
    anchor + B_EPOCH + 1 - child_height
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RotationGuard {
    ProveNow,
    /// Too close to the boundary: wait this many blocks, then re-anchor and prove.
    WaitForBoundary { blocks: u64 },
}

#[cfg(test)]
mod tests {
    use super::*;

    const P: &Gates = &PRODUCTION;
    const R: &Gates = &REHEARSAL;
    const S: &Gates = &SEPOLIA;

    /// REVIEW-3 F1: the compiled-in code hash is the keccak256 of the local artifact's `deployedBytecode`.
    /// Skipped (with a note) when `eth/artifacts` has not been compiled on this machine.
    #[test]
    fn htlc_code_hash_is_the_local_artifacts_runtime_code_hash() {
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../eth/artifacts/contracts/HTLC.sol/HTLC.json");
        let Ok(text) = std::fs::read_to_string(&path) else {
            eprintln!("SKIPPED: {} does not exist (run `npx hardhat compile` in eth/)", path.display());
            return;
        };
        let artifact: serde_json::Value = serde_json::from_str(&text).expect("artifact is JSON");
        let code = artifact["deployedBytecode"].as_str().expect("artifact has deployedBytecode");
        let bytes = hex::decode(code.trim_start_matches("0x")).expect("deployedBytecode is hex");
        assert_eq!(crate::watch::eth::keccak256(&bytes), HTLC_CODE_HASH, "HTLC_CODE_HASH is stale: eth/contracts/HTLC.sol was recompiled to other code");
    }

    #[test]
    fn section_9_1_constants() {
        assert_eq!(B_POST, 252);
        assert_eq!(P.rhs_i1_eth_for_window(W_A_S), 629);
        assert_eq!(P.rhs_i1_eth_for_window(W_A_MIN_S), 539);
        assert_eq!(ROTATION_GUARD_BLOCKS, 4);
        assert_eq!(TRIAL_START_HEIGHT, 279_388);
        assert_eq!(MIN_CLOSE_FEE, 5_800);
        assert_eq!(B_EPOCH, noid_tx::TX_EPOCH_BLOCKS);
        assert_eq!(ProfileName::Production.gates(), P);
        assert_eq!(ProfileName::default(), ProfileName::Production);
    }

    /// The one checker validates both profiles (section 4.2 / 4.3 relations) ...
    #[test]
    fn both_profiles_satisfy_the_section_4_relations() {
        P.validate().unwrap();
        R.validate().unwrap();
        S.validate().unwrap();
        // Formal model finding 2: the reorg-of-Alice's-claim relations hold with room in every profile, and the numbers are pinned.
        for g in [P, R, S] {
            assert!(g.m_a_s >= g.eth_finality_s + 2 * g.de_s + g.ra_s, "{}", g.name);
            assert!(g.w_a_min_s >= g.de_s + g.eth_finality_s + g.ra_s + g.m_a_s, "{}", g.name);
        }
        assert_eq!((P.de_s, P.ra_s, S.de_s, S.ra_s, R.de_s, R.ra_s), (120, 120, 120, 120, 60, 60));
        assert_eq!((P.b_safety, P.b_post(), P.d_offset), (30, 252, 735));
        // ... and `D_offset` really is the section 4.2 formula for each.
        assert_eq!(P.d_offset_derived(), 735);
        assert_eq!(R.d_offset_derived(), 120);
        assert_eq!(R.b_post(), 33);
        assert_eq!(R.rhs_i1_eth_for_window(R.w_a_s), 68);
        assert_eq!(R.rhs_i1_eth_for_window(R.w_a_min_s), 62);
        assert_eq!(R.bob_lock_by(300_120), 300_052);
        assert_eq!(R.bob_lock_by_min_window(300_120), 300_058);
        assert_eq!(R.rotation_guard_blocks(), 4);
        // The rehearsal D_offset is one hour at 30 s/block.
        assert_eq!(R.d_offset * TAU_NOM_S, 3_600);
    }

    /// ... and rejects hand-made broken ones, one relation at a time.
    #[test]
    fn a_broken_profile_is_rejected() {
        let broken: Vec<(&str, Gates)> = vec![
            ("D_offset too small", Gates { d_offset: 119, ..REHEARSAL }),
            ("D_offset too large", Gates { d_offset: 121, ..REHEARSAL }),
            ("production D_offset off by one", Gates { d_offset: 724, ..PRODUCTION }),
            ("W_A_min above W_A", Gates { w_a_min_s: 700, ..REHEARSAL }),
            ("M_A not above the ETH finality", Gates { eth_finality_s: 300, ..REHEARSAL }),
            ("Alice has no time at the minimum window", Gates { w_a_min_s: 350, ..REHEARSAL }),
            ("B_final shortened", Gates { b_final: 10, d_offset: 112, ..REHEARSAL }),
            ("T6 guard does not fit in B_safety", Gates { b_safety: 3, d_offset: 118, ..REHEARSAL }),
            ("rehearsal without caps", Gates { max_noid_micro: None, ..REHEARSAL }),
            ("rehearsal on any chain", Gates { eth_chain_ids: None, ..REHEARSAL }),
            ("production with a cap", Gates { max_noid_micro: Some(1), ..PRODUCTION }),
            ("zero tau", Gates { tau_fast_s: 0, ..REHEARSAL }),
            ("tx grace below two rebroadcast times", Gates { tx_grace_s: 119, ..REHEARSAL }),
            ("sepolia: M_A not above the ETH finality", Gates { m_a_s: 1_000, ..SEPOLIA }),
            ("sepolia: D_offset one short", Gates { d_offset: 299, ..SEPOLIA }),
            ("sepolia without caps", Gates { max_noid_micro: None, max_eth_wei: None, eth_chain_ids: None, ..SEPOLIA }),
            ("sepolia without a chain pin", Gates { eth_chain_ids: None, ..SEPOLIA }),
            ("sepolia with the rehearsal window", Gates { w_a_s: 600, w_a_min_s: 480, d_offset: 120, ..SEPOLIA }),
            // Formal model finding 2: the two reorg-of-Alice's-claim relations, each failing alone.
            ("production: M_A below eth_finality + 2*DE + RA", Gates { de_s: 400, ..PRODUCTION }),
            ("rehearsal: M_A below 2*DE + RA", Gates { ra_s: 250, tx_grace_s: 600, ..REHEARSAL }),
            ("sepolia: W_A_min below DE + eth_finality + RA + M_A (M_A relation still holds)", Gates { de_s: 220, ra_s: 220, ..SEPOLIA }),
        ];
        for (what, g) in broken {
            assert!(matches!(g.validate(), Err(GateError::BadProfile(_))), "{what}: {:?}", g.validate());
        }
        // Sanity of the "off by one" cases above: the margin is what absorbs a change.
        Gates { margin: 10, d_offset: 121, ..REHEARSAL }.validate().unwrap();
        Gates { margin: 7, d_offset: 301, ..SEPOLIA }.validate().unwrap();
        // The two relations are tight at their boundary and no tighter: M_A = 1,140 + 2*220 + 220 = 1,800; W_A_min = 220 + 1,140 + 220 + 1,800 = 3,380.
        Gates { de_s: 220, ra_s: 220, w_a_min_s: 3_380, ..SEPOLIA }.validate().unwrap();
        assert!(Gates { de_s: 221, ra_s: 220, w_a_min_s: 3_380, ..SEPOLIA }.validate().is_err());
        assert!(Gates { de_s: 220, ra_s: 220, w_a_min_s: 3_379, ..SEPOLIA }.validate().is_err());
    }

    /// The sepolia numbers of the module documentation, pinned.
    #[test]
    fn sepolia_derived_numbers() {
        assert_eq!(S.name, ProfileName::Sepolia);
        assert_eq!(ProfileName::Sepolia.gates(), S);
        assert_eq!(ProfileName::Sepolia.as_str(), "sepolia");
        assert_eq!(S.b_post(), 33);
        assert_eq!(S.rhs_i1_eth_for_window(S.w_a_s), 251);
        assert_eq!(S.rhs_i1_eth_for_window(S.w_a_min_s), 209);
        assert_eq!(S.d_offset_derived(), 300);
        assert_eq!(S.d_offset, 300);
        assert_eq!(S.rotation_guard_blocks(), 4);
        assert_eq!(S.bob_lock_by(300_300), 300_300 - 251);
        assert_eq!(S.bob_lock_by_min_window(300_300), 300_300 - 209);
        // Alice's time between the minimum window and her cutoff covers the Sepolia finality plus detection.
        assert_eq!(S.w_a_min_s - S.m_a_s, 1_560);
        assert!(S.w_a_min_s - S.m_a_s >= S.eth_finality_s + S.delta_detect_s);
        // D_offset is 2 h 30 at 30 s/block; the production finality and M_A are kept.
        assert_eq!(S.d_offset * TAU_NOM_S, 9_000);
        assert_eq!((S.eth_finality_s, S.m_a_s), (PRODUCTION.eth_finality_s, PRODUCTION.m_a_s));
        assert_eq!(S.reveal_cutoff(10_000), 8_200);
    }

    #[test]
    fn sepolia_parses_and_round_trips() {
        assert_eq!("sepolia".parse::<ProfileName>(), Ok(ProfileName::Sepolia));
        assert_eq!(ProfileName::Sepolia.to_string(), "sepolia");
        assert!(!ProfileName::Sepolia.is_production());
        // REVIEW-3 F5: sepolia follows the production rule for a second node; rehearsal does not.
        assert!(ProfileName::Sepolia.requires_second_node() && ProfileName::Production.requires_second_node());
        assert!(!ProfileName::Rehearsal.requires_second_node());
        assert_eq!(serde_json::to_string(&ProfileName::Sepolia).unwrap(), "\"sepolia\"");
        assert_eq!(serde_json::from_str::<ProfileName>("\"sepolia\"").unwrap(), ProfileName::Sepolia);
        let e = "mainnet".parse::<ProfileName>().unwrap_err();
        assert!(e.contains("production") && e.contains("rehearsal") && e.contains("sepolia"), "{e}");
    }

    #[test]
    fn rehearsal_caps() {
        assert_eq!(R.check_caps(20_000_000, 10_000_000_000_000_000, 31_337), Ok(()));
        assert!(matches!(R.check_caps(20_000_001, 1, 31_337), Err(GateError::NoidAmountAboveCap { .. })));
        assert!(matches!(R.check_caps(1, 10_000_000_000_000_001, 31_337), Err(GateError::EthAmountAboveCap { .. })));
        assert!(matches!(R.check_caps(1, 1, 1), Err(GateError::ChainNotAllowed { .. })));
        assert!(matches!(R.check_caps(1, 1, 11_155_111), Err(GateError::ChainNotAllowed { .. })));
        // Production has no caps.
        assert_eq!(P.check_caps(u64::MAX, u128::MAX, 1), Ok(()));
    }

    #[test]
    fn sepolia_caps() {
        assert_eq!(S.check_caps(20_000_000, 10_000_000_000_000_000, 11_155_111), Ok(()));
        assert!(matches!(S.check_caps(20_000_001, 1, 11_155_111), Err(GateError::NoidAmountAboveCap { .. })));
        assert!(matches!(S.check_caps(1, 10_000_000_000_000_001, 11_155_111), Err(GateError::EthAmountAboveCap { .. })));
        assert!(matches!(S.check_caps(1, 1, 31_337), Err(GateError::ChainNotAllowed { .. })));
        assert!(matches!(S.check_caps(1, 1, 1), Err(GateError::ChainNotAllowed { .. })));
        // And the rehearsal profile refuses Sepolia (and sepolia refuses the local chain, above).
        assert!(matches!(R.check_caps(1, 1, 11_155_111), Err(GateError::ChainNotAllowed { .. })));
    }

    /// The sepolia walk-through: D_offset 300, finality 1,140 s, cutoff T_reveal - 1,800 s.
    #[test]
    fn sepolia_worked_example() {
        let h_create = 300_000;
        let d = S.alice_deadline_eth(h_create).unwrap();
        assert_eq!(d, 300_300);
        // Funding final by 300,022; Bob locks at 300,030.
        let (h_b, t_b) = (300_030, 1_794_312_000);
        let t_reveal = t_b + 4_200;
        // RHS(I1) = ceil((4,200 + 120 + 40)/20) + 33 = 251; available 270; 19 blocks of slack.
        let r = S.check_i1_eth(d, h_b, t_reveal, t_b).unwrap();
        assert_eq!((r.needed, r.available, r.slack), (251, 270, 19));
        assert_eq!(S.choose_t_reveal(d, h_b, t_b, 300_022).unwrap(), t_reveal);
        // The last Bob can lock (B_bob = 20 after final funding) still passes (I1).
        assert!(300_022 + S.b_bob <= S.bob_lock_by(d));
        // Alice: cutoff T_reveal - 1,800 s = t_b + 2,400; a lock is final about 1,140 s after inclusion.
        assert_eq!(S.reveal_cutoff(t_reveal), t_b + 2_400);
        assert_eq!(S.check_i2_eth(t_b + 2_400, t_reveal, true), Ok(()));
        assert!(matches!(S.check_i2_eth(t_b + 2_401, t_reveal, true), Err(GateError::RevealCutoffPassed { .. })));
        assert!(S.check_i3(t_b + 3_360, t_b) && !S.check_i3(t_b + 3_359, t_b));
        assert!(S.alice_accepts_t_reveal(t_b, t_b + 1_800) && !S.alice_accepts_t_reveal(t_b + 1, t_b + 1_800));
        // At the minimum-window lock-by height the window shrinks to the minimum; one block later Bob is refused.
        assert!(matches!(S.choose_t_reveal(d, d - 208, t_b, d - 220), Err(GateError::PastLockBy { .. })));
        let t = S.choose_t_reveal(d, d - 209, t_b, d - 220).unwrap();
        assert!(t - t_b >= S.w_a_min_s && t - t_b < S.w_a_s);
        // The rehearsal window (600 s) would be shorter than the Sepolia finality plus Alice's margin.
        assert!(R.w_a_s < S.eth_finality_s + S.delta_detect_s + S.m_a_s);
    }

    /// Design section 4.3, re-derived 2026-11-04.
    #[test]
    fn section_4_3_worked_example_eth() {
        let h_create = 300_000;
        let d = P.alice_deadline_eth(h_create).unwrap();
        assert_eq!(d, 300_735);
        let h_b = 300_040;
        let t_b = 1_794_312_000;
        let t_reveal = t_b + 7_200;
        let r = P.check_i1_eth(d, h_b, t_reveal, t_b).unwrap();
        assert_eq!(r.needed, 629);
        assert_eq!(r.available, 695);
        assert_eq!(r.slack, 66);
        assert_eq!(P.bob_lock_by(d), 300_106);
        assert_eq!(P.bob_lock_by_min_window(d), 300_196);
        // T_max at H_b: 443 blocks of budget -> t_b + 8,520; min with W_A gives t_b + 7,200.
        assert_eq!(P.t_max_eth(d, h_b, t_b).unwrap(), t_b + 8_520);
        assert_eq!(P.choose_t_reveal(d, h_b, t_b, 300_022).unwrap(), t_reveal);
        // Alice must broadcast by T_reveal - M_A (13:30 UTC in the example).
        assert_eq!(P.reveal_cutoff(t_reveal), t_b + 5_400);
        assert_eq!(P.check_i2_eth(t_b + 5_400, t_reveal, true), Ok(()));
        assert_eq!(
            P.check_i2_eth(t_b + 5_401, t_reveal, true),
            Err(GateError::RevealCutoffPassed { now: t_b + 5_401, cutoff: t_b + 5_400 })
        );
        assert_eq!(P.check_i2_eth(t_b, t_reveal, false), Err(GateError::LockNotFinalized));
    }

    /// The same walk-through under the rehearsal profile (ideas idea 3): `D_offset` 120.
    #[test]
    fn rehearsal_worked_example() {
        let h_create = 300_000;
        let d = R.alice_deadline_eth(h_create).unwrap();
        assert_eq!(d, 300_120);
        // Funding included by 300,005, final by 300,022; Bob locks at 300,030.
        let (h_b, t_b) = (300_030, 1_794_312_000);
        let t_reveal = t_b + 600;
        // RHS(I1) = ceil((600 + 60 + 40)/20) + 33 = 68; available 90; 22 blocks of slack.
        let r = R.check_i1_eth(d, h_b, t_reveal, t_b).unwrap();
        assert_eq!((r.needed, r.available, r.slack), (68, 90, 22));
        assert_eq!(R.choose_t_reveal(d, h_b, t_b, 300_022).unwrap(), t_reveal);
        // The lock-by heights: D - 68 with the full window, D - 62 with the minimum one.
        assert_eq!(R.bob_lock_by(d), 300_052);
        assert_eq!(R.bob_lock_by_min_window(d), 300_058);
        // The last Bob can lock (B_bob = 20 after final funding) still passes (I1), with margin to spare.
        let last = 300_022 + R.b_bob;
        assert!(last <= R.bob_lock_by(d));
        assert_eq!(R.bob_lock_by(d) - last, 10);
        // Alice: cutoff T_reveal - 300 s; a lock with a shorter window than 480 s is not accepted (I3).
        assert_eq!(R.reveal_cutoff(t_reveal), t_b + 300);
        assert!(R.check_i3(t_b + 480, t_b) && !R.check_i3(t_b + 479, t_b));
        assert_eq!(R.check_i2_eth(t_b + 300, t_reveal, true), Ok(()));
        assert!(matches!(R.check_i2_eth(t_b + 301, t_reveal, true), Err(GateError::RevealCutoffPassed { .. })));
        // The same height is NOT safe in production terms: the profiles do not mix.
        assert!(P.check_i1_eth(d, h_b, t_reveal, t_b).is_err());
    }

    #[test]
    fn i1_fails_when_bob_locks_too_late() {
        let d = 300_735;
        // At the lock-by height the full window still fits exactly.
        assert!(P.check_i1_eth(d, 300_106, 1_000_000 + 7_200, 1_000_000).is_ok());
        assert_eq!(
            P.check_i1_eth(d, 300_107, 1_000_000 + 7_200, 1_000_000),
            Err(GateError::BobUnsafe { d, h_b: 300_107, needed: 629, available: 628 })
        );
        // choose_t_reveal shrinks the window down to W_A_min, then refuses.
        let t = P.choose_t_reveal(d, 300_150, 1_000_000, 300_100).unwrap();
        assert!(t - 1_000_000 < W_A_S && t - 1_000_000 >= W_A_MIN_S);
        assert!(P.check_i1_eth(d, 300_150, t, 1_000_000).is_ok());
        assert!(matches!(
            P.choose_t_reveal(d, 300_197, 1_000_000, 300_150),
            Err(GateError::PastLockBy { .. })
        ));
        // Bob is allowed only B_bob blocks after funding finality.
        assert!(matches!(
            P.choose_t_reveal(d, 300_100, 1_000_000, 300_020),
            Err(GateError::PastBobWindow { .. })
        ));
        assert!(matches!(
            P.choose_t_reveal(d, 300_600, 1_000_000, 300_590),
            Err(GateError::PastLockBy { .. })
        ));
    }

    #[test]
    fn i1_under_rehearsal_shrinks_then_refuses() {
        let d = 300_120;
        let t = R.choose_t_reveal(d, 300_055, 1_000_000, 300_040).unwrap();
        assert!(t - 1_000_000 < R.w_a_s && t - 1_000_000 >= R.w_a_min_s, "{}", t - 1_000_000);
        assert!(R.check_i1_eth(d, 300_055, t, 1_000_000).is_ok());
        assert!(matches!(R.choose_t_reveal(d, 300_059, 1_000_000, 300_040), Err(GateError::PastLockBy { .. })));
        assert!(matches!(R.choose_t_reveal(d, 300_041, 1_000_000, 300_015), Err(GateError::PastBobWindow { b_bob: 20, .. })));
    }

    #[test]
    fn i4_claim_height_classes() {
        let d = 1_000;
        assert_eq!(classify_claim_height(982, d), ClaimHeight::OnTarget);
        assert_eq!(classify_claim_height(983, d), ClaimHeight::LateButValid);
        assert_eq!(classify_claim_height(999, d), ClaimHeight::LateButValid);
        assert_eq!(classify_claim_height(1_000, d), ClaimHeight::TooLate);
        assert!(!alice_refund_ready(998, d));
        assert!(alice_refund_ready(999, d));
        assert!(noid_final(117, 100));
        assert!(!noid_final(116, 100));
    }

    #[test]
    fn i5_version_window() {
        assert_eq!(P.check_i5(300_000, 300_735), Ok(()));
        assert!(matches!(
            P.check_i5(279_000, 279_735),
            Err(GateError::VersionBoundaryInWindow { .. })
        ));
        // The window end is D + B_post, so D just below the boundary still straddles it.
        assert!(matches!(
            P.check_i5(279_000, 279_200),
            Err(GateError::VersionBoundaryInWindow { .. })
        ));
        assert!(matches!(
            P.check_i5(279_380, 280_105),
            Err(GateError::BeforeTrialStart { .. })
        ));
        assert_eq!(P.check_i5(279_388, 280_113), Ok(()));
        assert_eq!(auth_version_at(279_369), OwnerAuthorizationVersion::V3);
        assert_eq!(auth_version_at(279_370), OwnerAuthorizationVersion::V4);
        // The rehearsal window is shorter (B_post 33), so it can end closer to the boundary.
        assert!(matches!(R.check_i5(279_240, 279_360), Err(GateError::VersionBoundaryInWindow { .. })));
        assert!(matches!(R.check_i5(279_200, 279_320), Err(GateError::BeforeTrialStart { .. })));
        assert!(matches!(R.check_i5(279_300, 279_420), Err(GateError::VersionBoundaryInWindow { .. })));
        assert_eq!(R.check_i5(279_388, 279_508), Ok(()));
    }

    #[test]
    fn fee_cap_rule() {
        assert_eq!(fee_cap(5_800, 10_000_000).unwrap(), 50_000);
        assert_eq!(fee_cap(20_000, 10_000_000).unwrap(), 60_000);
        assert_eq!(
            fee_cap(5_800, 4_999_999),
            Err(GateError::FeeCapTooLarge { f_max: 50_000, amount: 4_999_999 })
        );
        assert_eq!(fee_cap(5_800, 5_000_000).unwrap(), 50_000);
    }

    #[test]
    fn fee_cap_for_v1_is_the_old_rule() {
        let v1 = ContractVersion::V1;
        assert_eq!(fee_cap_for(v1, 5_800, 10_000_000).unwrap(), 50_000);
        assert_eq!(fee_cap_for(v1, 20_000, 10_000_000).unwrap(), 60_000);
        assert_eq!(fee_cap_for(v1, 16_667, 10_000_000).unwrap(), 50_001);
        assert_eq!(
            fee_cap_for(v1, 5_800, 4_999_999),
            Err(GateError::FeeCapTooLarge { f_max: 50_000, amount: 4_999_999 })
        );
        assert_eq!(v1.f_max_multiplier(), 3);
    }

    #[test]
    fn fee_cap_for_v2_uses_five_times_the_floor_seen() {
        let v2 = ContractVersion::V2;
        assert_eq!(v2.f_max_multiplier(), F_MAX_FLOOR_MULTIPLIER_V2);
        assert_eq!(fee_cap_for(v2, 5_800, 10_000_000).unwrap(), 50_000);
        assert_eq!(fee_cap_for(v2, 10_000, 10_000_000).unwrap(), 50_000);
        assert_eq!(fee_cap_for(v2, 10_001, 10_000_000).unwrap(), 50_005);
        assert_eq!(fee_cap_for(v2, 12_000, 10_000_000).unwrap(), 60_000);
        // The same 10,001 under v1 stays at the 50,000 floor (3 x 10,001 = 30,003).
        assert_eq!(fee_cap_for(ContractVersion::V1, 10_001, 10_000_000).unwrap(), 50_000);
        // V = 5 NOID, floor 12,000: 5 x 12,000 = 60,000 > 1 % of 5,000,000 = 50,000, so refused.
        assert_eq!(
            fee_cap_for(v2, 12_000, 5_000_000),
            Err(GateError::FeeCapTooLarge { f_max: 60_000, amount: 5_000_000 })
        );
        // The 50,000 minimum alone needs V >= 5 NOID.
        assert_eq!(fee_cap_for(v2, 5_800, 5_000_000).unwrap(), 50_000);
        assert!(matches!(fee_cap_for(v2, 5_800, 4_999_999), Err(GateError::FeeCapTooLarge { f_max: 50_000, .. })));
    }

    #[test]
    fn fee_cap_for_overflow_paths() {
        for v in [ContractVersion::V1, ContractVersion::V2] {
            // floor x multiplier overflows.
            assert_eq!(fee_cap_for(v, u64::MAX, u64::MAX), Err(GateError::Overflow));
            // f_max x 100 overflows.
            assert_eq!(fee_cap_for(v, u64::MAX / v.f_max_multiplier(), u64::MAX), Err(GateError::Overflow));
            // A zero amount can never pay the minimum fee.
            assert!(matches!(fee_cap_for(v, 5_800, 0), Err(GateError::FeeCapTooLarge { .. })));
        }
    }

    #[test]
    fn floor_seen_is_the_larger_of_estimate_and_operator_floor_for_v2_only() {
        assert_eq!(floor_seen_for(ContractVersion::V2, 5_800, Some(11_000)), 11_000);
        assert_eq!(floor_seen_for(ContractVersion::V2, 12_000, Some(11_000)), 12_000);
        assert_eq!(floor_seen_for(ContractVersion::V2, 5_800, None), 5_800);
        assert_eq!(floor_seen_for(ContractVersion::V1, 5_800, Some(11_000)), 5_800);
        let seen = floor_seen_for(ContractVersion::V2, 5_800, Some(11_000));
        assert_eq!(fee_cap_for(ContractVersion::V2, seen, 10_000_000).unwrap(), 55_000);
    }

    #[test]
    fn epoch_anchor_and_rotation_guard() {
        assert_eq!(epoch_anchor_height_for_child(1), 0);
        assert_eq!(epoch_anchor_height_for_child(144), 0);
        assert_eq!(epoch_anchor_height_for_child(145), 144);
        assert_eq!(epoch_anchor_height_for_child(289), 288);
        assert_eq!(blocks_until_rotation(145), 144);
        assert_eq!(blocks_until_rotation(288), 1);
        // 284 is 5 blocks before the rotation at 289: outside the 4-block guard.
        assert_eq!(blocks_until_rotation(284), 5);
        for g in [P, R] {
            assert_eq!(g.rotation_guard(284), RotationGuard::ProveNow);
            assert_eq!(g.rotation_guard(285), RotationGuard::WaitForBoundary { blocks: 4 });
            assert_eq!(g.rotation_guard(288), RotationGuard::WaitForBoundary { blocks: 1 });
            assert_eq!(g.rotation_guard(289), RotationGuard::ProveNow);
        }
    }

    #[test]
    fn profile_names_round_trip() {
        assert_eq!("rehearsal".parse::<ProfileName>(), Ok(ProfileName::Rehearsal));
        assert_eq!("production".parse::<ProfileName>(), Ok(ProfileName::Production));
        assert!("Production".parse::<ProfileName>().is_err());
        assert_eq!(serde_json::to_string(&ProfileName::Rehearsal).unwrap(), "\"rehearsal\"");
        assert_eq!(serde_json::from_str::<ProfileName>("\"production\"").unwrap(), ProfileName::Production);
        assert!(serde_json::from_str::<ProfileName>("\"mainnet-v1\"").is_err());
    }
}
