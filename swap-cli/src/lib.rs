//! `swap_cli`: the offline, test-driven skeleton of the two-role NOID <-> ETH
//! atomic-swap tool (design `docs/protocol-design.md` section 7 and section 10
//! M2; TASKS M2.3-M2.6).
//!
//! Chain interaction goes through
//! a trait (`watch::JsonRpc`, `client::IntentSubmitter`, `client::stock::CommandRunner`,
//! `engine::Executor`). `watch::JsonRpc` has fixture, scripted, live-HTTP (`watch::http`), curl
//! (`watch::exec`) and recording (`watch::record`) implementations; nothing in the library sends a
//! transaction unless the caller hands it a live `IntentSubmitter` (only `swap-cli claim --submit` does).
//!
//! Module map:
//! - `secret`   : the 32-byte swap secret, its SHA-256 hashlock and Parano1d authority.
//! - `params`   : the section 9.1 constants and the (I1)..(I5) gates, hard-coded.
//! - `swapfile` : the persisted swap file (opening, parameters, secret encrypted at rest).
//! - `state`    : the swap state machine (phases, events, allowed transitions).
//! - `watch`    : Parano1d and Ethereum watchers producing `NoidObservation` / `EthObservation`.
//! - `child_env`: the environment allow-list of spawned children (REVIEW-3 F4).
//! - `equiv`    : runs the equivalence-proof verifier (`equiv-prove verify`) for `new-bob --receipt`.
//! - `engine`   : the automatic actions: decide from (role, swap file, observations, now).
//! - `contract_params` : the Parano1d contract definition/params of a swap, for the stock wallet.
//! - `client`   : client R (raw secret, `noid_gkr` + `ObjectIntent`) and client S (stock wallet script).

pub mod child_env;
pub mod client;
pub mod contract_params;
pub mod engine;
pub mod equiv;
pub mod params;
pub mod secret;
pub mod state;
pub mod swapfile;
pub mod watch;

pub use htlc_harness;
