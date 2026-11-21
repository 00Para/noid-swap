//! `swap-cli`: the command line of the two-role NOID <-> ETH swap tool.
//!
//! Chain reads come from recorded fixture files (`--*-fixture`) or from a live
//! JSON-RPC node (`--*-rpc URL`, over `--transport tcp|curl`). Reads are read-only
//! RPC methods. The only command that can send anything to a chain is
//! `claim ... --submit` (Bob's NOID claim, client R); everything else only decides,
//! prints and writes local files.
//!
//! Commands:
//!   new-alice     create Alice's swap file (secret sealed) and print the bundle for Bob
//!   new-bob       create Bob's swap file from Alice's bundle (byte-for-byte rebuild check)
//!   bundle        print a swap file's public section (what the counterparty needs)
//!   status        print role, phase, history and pending action (never the secret)
//!   tick          run the watchers (fixtures or live) and print the engine's decision
//!   claim         Bob: if the engine says ClaimNoid, build+prove+verify the claim; --submit sends it
//!   alice-params  print the contract parameters/definition Alice funds with the stock wallet
//!   gates         evaluate the section 4.2 gates for given heights and times
//!
//! The passphrase that seals Alice's secret is read from the environment
//! variable named by `--passphrase-env` (default `SWAP_PASSPHRASE`), never from
//! the command line.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::exit;
use std::time::Duration;

use noid_poseidon2b::primitives::Address;
use swap_cli::client::raw::{client_r_selftest, RawClaimExecutor};
use swap_cli::bundle::{open_bundle, BundleStatus, CheckedBundle};
use swap_cli::client::{IntentSubmitter, RpcSubmitter};
use swap_cli::contract_params::{alice_commands, check_object_file, contract_params};
use swap_cli::engine::{
    cancel_intent_checked, check_external_close_phase, decide, expected_lock_id, external_close_event, normalize_txid, tick_apply, Action, IntentStatus, Runner,
    INTENT_KINDS,
};
use swap_cli::equiv::{verify_receipt, ProcessRunner, VerifyRequest};
use swap_cli::params::{self, ContractVersion, ProfileName};
use swap_cli::secret::{parse_hex32, LockKind, Secret, Variant};
use swap_cli::state::{BobPhase, Phase, Role};
use swap_cli::swapfile::{AttestationSource, BobTerms, EquivalenceAttestation, EthParams, HashlockRegistry, KdfParams, Passphrase, SwapFile, SwapLock, SwapPublic};
use swap_cli::watch::eth::{EthWatcher, LockDiscovery};
use swap_cli::watch::exec::ExecJsonRpc;
use swap_cli::watch::http::{is_loopback_http, normalize_endpoint, HttpJsonRpc};
use swap_cli::watch::parano1d::NoidWatcher;
use swap_cli::watch::record::RecordingRpc;
use swap_cli::watch::{EthObservation, FixtureRpc, JsonRpc, NoidObservation};

const USAGE: &str = "usage:
  swap-cli new-alice --out FILE --alice o1.. --bob o1.. --amount MICRONOID --fee-estimate MICRONOID
                     --h-create HEIGHT --eth-contract 0x.. --eth-chain-id N --eth-amount-wei N
                     --eth-receiver 0x.. --eth-sender 0x.. [--variant raw|stock]
                     [--eth-code-hash 0x..] [--profile production|rehearsal|sepolia] [--contract-version 1|2]
                     [--floor-seen MICRONOID] [--passphrase-env VAR] [--registry FILE] [--eth-lock-kind sha256|poseidon]
                     (the bundle printed on stdout carries a `bundle_check`; hand it to Bob as a file and compare the `bundle check:` line on stderr on both machines)
                     (--eth-lock-kind: the Ethereum lock. sha256 (default) = HTLC.sol keyed on SHA-256(s), Bob needs the equivalence proof; poseidon =
                      HTLCPoseidonV2.sol keyed on A = Addr(s), the raw variant only, NO equivalence proof, the lock word is the NOID claim authority;
                      the bundle carries a non-default kind and Bob must ask for the same)
                     (--eth-code-hash is optional: the keccak256 of the HTLC runtime code is compiled into this tool; an ETH spend is refused
                      unless the contract on chain has exactly that code; a given value must equal it, no value pins another contract)
                     (contract version 1 = HashTimeLock, a close pays [5,800 .. max_fee], max_fee = max(50,000, 3 x --fee-estimate); 2 =
                      HashTimeLockV2, every close pays exactly max_fee = max(50,000, 5 x max(--fee-estimate, --floor-seen)); both at most
                      1 % of the amount; default 1; the bundle carries a non-default version and Bob must ask for the same;
                      --floor-seen = the highest relay floor you saw in the last 24 h, v2 only, ignored with a note for v1)
                     (rehearsal: short windows, at most 20 NOID and 0.01 ETH, Ethereum chain 31337 only; sepolia: the same caps, chain 11155111 only,
                      windows long enough for the real Sepolia finality; the bundle carries the profile)
  swap-cli new-bob --bundle FILE --out FILE --bob o1.. --amount MICRONOID --eth-chain-id N --eth-contract 0x..
                   --eth-amount-wei N --eth-sender 0x.. [--eth-code-hash 0x..] [--variant raw|stock]
                   [--profile production|rehearsal|sepolia] [--contract-version 1|2] [--pinned-image-id HEX] [--eth-lock-kind sha256|poseidon]
                   --receipt FILE --equiv-prove BIN [--registry FILE] [--allow-unchecked-bundle]
                   (new-bob verifies the bundle's `bundle_check` before anything else; a bundle without one is refused unless --allow-unchecked-bundle, for bundles made before the check existed)
                   (--eth-lock-kind poseidon: NO --receipt, --equiv-prove, --equiv-*, --pinned-image-id (refused); the tool runs the client R self-test
                    on this machine before it writes the file (a throwaway authorization, proved and verified); the lock word must be the claim
                    authority of the opening this tool rebuilds)
                   (this tool runs `BIN verify <variant> <H> <A> FILE` with H and A from the bundle and requires its
                    image id to equal the one compiled into this tool (the local build's until milestone M1.1);
                    --pinned-image-id is optional and, if given, must equal it; --variant defaults to the bundle's;
                    --profile and --contract-version must equal the bundle's)
  swap-cli new-bob ... --equiv-h 0x.. --equiv-a o1.. --equiv-image-id HEX      (REHEARSAL profile only)
                   (typed fallback without --receipt: refused under production and sepolia; with --receipt these three
                    become optional and must agree)
  swap-cli self-test FILE [--noid-rpc URL | --call-height N] [--transport tcp|curl] [--curl-path PATH] [--rpc-timeout SECS]
                (Bob, poseidon swaps: proves and verifies a throwaway owner authorization with client R on THIS machine and records it in the file;
                 the engine does not offer lock_eth without a passed self-test for the version of the next block. Nothing is sent.)
  swap-cli bundle FILE
  swap-cli status FILE
  swap-cli secret FILE [--passphrase-env VAR]   (Alice only: the 32-byte secret as 0x-hex, for equiv-prove and the Ethereum reveal)
  swap-cli tick FILE (--noid-fixture FILE | --noid-rpc URL) (--eth-fixture FILE | --eth-rpc URL)
                [--record-noid FILE] [--record-eth FILE] [--now UNIX (fixtures only)] [--pending-tx 0x..]... [--reveal-tx 0x..] [--apply]
                [--closed-by TXID] [--accept-producer-concentration] [--single-node-ok]
                (--closed-by: record a close made OUTSIDE this tool, e.g. the wallet CLI's recovery close. Needs the transaction confirmed on the node and the
                 instance gone; writes only with --apply; refuses otherwise. Alice: recovery close at h >= D, Bob: claim at h < D)
                [--eth-from-block N] [--transport tcp|curl] [--curl-path PATH] [--rpc-timeout SECS]
                (--eth-from-block: given once on a live non-local chain; `tick --apply` / `claim --submit` store it in the file, later commands reuse it (REVIEW-3 F7))
  swap-cli intent FILE [--show]                  (the spending action `tick --apply` froze: lock id, amounts, T_reveal ...)
  swap-cli intent FILE --cancel (--noid-fixture FILE | --noid-rpc URL) (--eth-fixture FILE | --eth-rpc URL) [...tick flags]
                [--i-checked-the-wallet]
                (drop an intent that was never sent; refused if the chain already shows its effect. A fund_noid intent needs --i-checked-the-wallet:
                 the node cannot list a funding in its mempool, so you vouch that the wallet shows none pending (CHAOS F-15))
  swap-cli claim FILE (--noid-rpc URL | --noid-fixture FILE) (--eth-rpc URL | --eth-fixture FILE)
                 [--submit] [--submit-rpc URL]... [--intent-out FILE] [--now UNIX] [--pending-tx 0x..]... [--reveal-tx 0x..]
                 [--record-noid FILE] [--record-eth FILE] [--eth-from-block N]
                 [--transport tcp|curl] [--curl-path PATH] [--rpc-timeout SECS]
                 (Bob only; dry run unless --submit; --submit needs a live --noid-rpc)
  swap-cli alice-params FILE [--definition-out FILE] [--params-out FILE] [--check-object FILE]
  swap-cli gates --d HEIGHT --h-now HEIGHT --t-now UNIX [--h-final HEIGHT] [--profile production|rehearsal|sepolia]
  --transport tcp   built-in http:// client (default; no TLS)
  --transport curl  spawn curl (default /mnt/c/Windows/System32/curl.exe in WSL, else `curl`); also https://
  Plain http:// is accepted only to 127.0.0.1, localhost or [::1]; any other host needs https:// with --transport curl, or --allow-plain-http.
  A second, independent node: give --noid-rpc (or --noid-fixture) twice, and/or --eth-rpc (or --eth-fixture) twice (REVIEW-2 F5). Bob's lock needs
  the two Parano1d nodes to agree (same instance, tips within 2 blocks); Alice's reveal needs the two Ethereum nodes to agree (same lock, finalized
  heights within 64). Under the production and sepolia profiles a single node blocks those two steps unless --single-node-ok; rehearsal accepts one with a note. The second endpoint must differ from the first (REVIEW-3 G3); a second node that runs on another machine and is reached through a local port (an SSH tunnel) can be declared with --noid-rpc2-is-remote / --eth-rpc2-is-remote, which changes the text of the same-host note and nothing else. An unknown tip header time blocks every NOID-side spend (REVIEW-3 F5). The same applies to declaring a swap `lost` (REVIEW-4 R4-9). With two Ethereum nodes Bob reads the secret from either one, and while he waits for it every tick compares the Ethereum head time with the clock (REVIEW-4 R4-8).
  Producer concentration (threat T21, docs/bob-concentration-gate.md): before Bob locks, `tick` reads the Parano1d block headers from his own node (--noid-rpc, never a
  fixture), keeps them in FILE.producers, and counts who produced the last 2,880 and the last 720 blocks. Under the production profile `lock_eth` is not offered while one
  address produced more than 35 % of either window, or when the headers cannot be read in full, are stale, or the second Parano1d node disagrees or is missing (under production
  --single-node-ok does not relax the second-node part of this check); under sepolia and rehearsal the same check only warns. The two largest addresses together above 50 % always only warn. --accept-producer-concentration (tick) waives the production refusals: it
  prints a warning on every tick and writes one history entry; it is never implied by a profile. It is a screen, not a defence.";

/// Flags that never take a value, so `claim --submit FILE` cannot swallow FILE.
const BOOL_FLAGS: [&str; 12] = [
    "apply",
    "submit",
    "fast-kdf",
    "cancel",
    "show",
    "single-node-ok",
    "accept-producer-concentration",
    "allow-plain-http",
    "i-checked-the-wallet",
    "allow-unchecked-bundle",
    "noid-rpc2-is-remote",
    "eth-rpc2-is-remote",
];

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if let Err(e) = run(&args) {
        eprintln!("error: {e}");
        exit(1);
    }
}

type Res<T> = Result<T, String>;

fn run(args: &[String]) -> Res<()> {
    let Some(cmd) = args.first() else {
        return Err(USAGE.into());
    };
    let (positional, flags) = parse_flags(&args[1..]);
    match cmd.as_str() {
        "new-alice" => new_alice(&flags),
        "new-bob" => new_bob(&flags),
        "bundle" => bundle(positional.first().ok_or(USAGE)?),
        "status" => status(positional.first().ok_or(USAGE)?),
        "secret" => secret(positional.first().ok_or(USAGE)?, &flags),
        "self-test" => self_test(positional.first().ok_or(USAGE)?, &flags),
        "tick" => tick(positional.first().ok_or(USAGE)?, &flags),
        "intent" => intent(positional.first().ok_or(USAGE)?, &flags),
        "claim" => claim(positional.first().ok_or(USAGE)?, &flags),
        "alice-params" => alice_params(positional.first().ok_or(USAGE)?, &flags),
        "gates" => gates(&flags),
        _ => Err(USAGE.into()),
    }
}

/// `--key value` and bare `--flag`; repeated keys accumulate.
fn parse_flags(args: &[String]) -> (Vec<String>, HashMap<String, Vec<String>>) {
    let mut positional = Vec::new();
    let mut flags: HashMap<String, Vec<String>> = HashMap::new();
    let mut i = 0;
    while i < args.len() {
        if let Some(key) = args[i].strip_prefix("--") {
            let value = if BOOL_FLAGS.contains(&key) { None } else { args.get(i + 1).filter(|v| !v.starts_with("--")).cloned() };
            match value {
                Some(v) => {
                    flags.entry(key.to_string()).or_default().push(v);
                    i += 2;
                }
                None => {
                    flags.entry(key.to_string()).or_default().push("true".into());
                    i += 1;
                }
            }
        } else {
            positional.push(args[i].clone());
            i += 1;
        }
    }
    (positional, flags)
}
// ---------------------------------------------------------------- chain sources

/// Transport settings shared by every `--*-rpc`.
struct Net {
    curl: bool,
    curl_path: Option<String>,
    timeout: Duration,
    /// `--allow-plain-http`: accept `http://` to a host that is not the local machine (REVIEW-2 F5).
    allow_plain_http: bool,
}

fn net(flags: &HashMap<String, Vec<String>>) -> Res<Net> {
    let curl = match flag(flags, "transport").unwrap_or("tcp") {
        "tcp" => false,
        "curl" => true,
        other => return Err(format!("--transport: expected tcp or curl, got {other}")),
    };
    let secs = match flags.get("rpc-timeout").and_then(|v| v.first()) {
        Some(t) => t.parse::<u64>().ok().filter(|s| *s > 0).ok_or_else(|| format!("--rpc-timeout: expected seconds > 0, got {t}"))?,
        None => 30,
    };
    Ok(Net {
        curl,
        curl_path: flags.get("curl-path").and_then(|v| v.first()).cloned(),
        timeout: Duration::from_secs(secs),
        allow_plain_http: flags.contains_key("allow-plain-http"),
    })
}

/// `scheme://host:port` only: a URL may carry an API key in its path or query.
fn redact(url: &str) -> String {
    let (scheme, rest) = url.split_once("://").unwrap_or(("", url));
    let authority = rest.split(['/', '?', '#']).next().unwrap_or("");
    // Credentials in front of an `@` are not part of the address that is shown.
    let host = authority.rsplit('@').next().unwrap_or(authority);
    format!("{scheme}://{host}")
}

/// REVIEW-2 F5: plain `http://` leaves the local machine only with `--allow-plain-http`. `https://` (curl) and loopback are unchanged.
fn check_plain_http(net: &Net, url: &str) -> Res<()> {
    let lower = url.trim().to_ascii_lowercase();
    if lower.starts_with("http://") && !net.allow_plain_http && !is_loopback_http(url) {
        return Err(format!(
            "{}: plain HTTP to a non-loopback host can be tampered with in transit; use https:// with --transport curl, or --allow-plain-http",
            redact(url)
        ));
    }
    Ok(())
}

fn open_url(net: &Net, url: &str) -> Res<Box<dyn JsonRpc>> {
    if net.curl {
        // Only web URLs: curl would also read file:// or treat a leading '-' as an option.
        let lower = url.to_ascii_lowercase();
        if !(lower.starts_with("http://") || lower.starts_with("https://")) {
            return Err(format!("{}: with --transport curl the url must start with http:// or https://", redact(url)));
        }
        check_plain_http(net, url)?;
        Ok(Box::new(ExecJsonRpc::new(url, net.curl_path.as_deref()).with_timeout(net.timeout)))
    } else {
        check_plain_http(net, url)?;
        Ok(Box::new(HttpJsonRpc::new(url).map_err(|e| e.to_string())?.with_timeout(net.timeout)))
    }
}

/// One chain source: the transport and a label for the report.
type Source = (Box<dyn JsonRpc>, String);

/// REVIEW-3 G3: the second `--<kind>-rpc` must be another node. Identical endpoints (same scheme, host and port after
/// trimming, lower-casing and the default ports; the path, query and credentials do not count: one provider's two API keys
/// are one node) are refused. A different port on the same host passes with a note: a second node on the same machine
/// shares the first one's network view, so what "agreed" is worth is less.
///
/// `declared_remote` (`--<kind>-rpc2-is-remote`) is information only: the operator says the second node runs on another machine and
/// appears on this host through a local port (for example an SSH tunnel). The tool cannot verify that. It replaces the text of the note for
/// a second endpoint on the same host; it relaxes nothing (identical endpoints are still refused, and the two-node rule is unchanged).
fn check_distinct_endpoints(kind: &str, urls: &[String], declared_remote: bool) -> Res<Option<String>> {
    let [first, second] = urls else {
        return Ok(None);
    };
    match (normalize_endpoint(first), normalize_endpoint(second)) {
        (Some(a), Some(b)) if a.origin == b.origin => Err(format!(
            "--{kind}-rpc: the second node must be a different endpoint (both are {})",
            redact(first)
        )),
        (None, _) | (_, None) if first.trim().eq_ignore_ascii_case(second.trim()) => Err(format!(
            "--{kind}-rpc: the second node must be a different endpoint (both are {})",
            redact(first)
        )),
        (Some(a), Some(b)) if a.host == b.host && declared_remote => Ok(Some(format!(
            "--{kind}-rpc: both endpoints are on the host {} ({} and {}), but --{kind}-rpc2-is-remote declares that the second node runs on another machine and is reached through this local port (for example an SSH tunnel); the tool cannot verify that. Two machines may still share one network and one upstream connection, so their agreement is a weaker check than two nodes on separate networks (G3)",
            a.host,
            redact(first),
            redact(second)
        ))),
        (Some(a), Some(b)) if a.host == b.host => Ok(Some(format!(
            "--{kind}-rpc: both nodes are on the host {} ({} and {}): a second node on the same machine shares its network view, so their agreement is a weaker check (G3)",
            a.host,
            redact(first),
            redact(second)
        ))),
        _ => Ok(None),
    }
}

/// REVIEW-3 G3: the second `--<kind>-fixture` must be another file (the same path, or the same file by another path).
fn check_distinct_fixtures(kind: &str, files: &[String]) -> Res<()> {
    let [first, second] = files else {
        return Ok(());
    };
    let same_file = match (std::fs::canonicalize(first.trim()), std::fs::canonicalize(second.trim())) {
        (Ok(a), Ok(b)) => a == b,
        _ => first.trim() == second.trim(),
    };
    if same_file {
        return Err(format!("--{kind}-fixture: the second fixture must be a different file (both are {})", first.trim()));
    }
    Ok(())
}

/// One chain's data sources from `--<kind>-fixture` XOR `--<kind>-rpc`, optionally recorded. Each flag may be given twice:
/// the second is an independent node for the F5 cross-check (never recorded; both must be of the same kind).
fn chain_source(flags: &HashMap<String, Vec<String>>, kind: &str, net: &Net) -> Res<(Source, Option<Source>, Vec<String>)> {
    let list = |k: String| flags.get(&k).cloned().unwrap_or_default();
    let fixtures = list(format!("{kind}-fixture"));
    let urls = list(format!("{kind}-rpc"));
    let record = flags.get(&format!("record-{kind}")).and_then(|v| v.first()).cloned();
    if fixtures.is_empty() == urls.is_empty() {
        return Err(format!("give exactly one of --{kind}-fixture FILE or --{kind}-rpc URL"));
    }
    if fixtures.len().max(urls.len()) > 2 {
        return Err(format!("--{kind}-fixture / --{kind}-rpc: at most two (the second is an independent node for the F5 cross-check)"));
    }
    if urls.is_empty() {
        if record.is_some() {
            return Err(format!("--record-{kind} needs --{kind}-rpc URL: a fixture is already a recording"));
        }
        let open = |f: &String| -> Res<Source> {
            let rpc = FixtureRpc::from_file(Path::new(f)).map_err(|e| e.to_string())?;
            Ok((Box::new(rpc), format!("fixture {f}")))
        };
        check_distinct_fixtures(kind, &fixtures)?;
        return Ok((open(&fixtures[0])?, fixtures.get(1).map(open).transpose()?, Vec::new()));
    }
    let mut source_notes = Vec::new();
    source_notes.extend(check_distinct_endpoints(kind, &urls, flags.contains_key(&format!("{kind}-rpc2-is-remote")))?);
    let via = if net.curl { "curl" } else { "tcp" };
    let open = |u: &String| -> Res<(Box<dyn JsonRpc>, String)> { Ok((open_url(net, u)?, redact(u))) };
    let (rpc, label) = open(&urls[0])?;
    let first: Source = match record {
        Some(path) => {
            let rec = RecordingRpc::create(rpc, path.clone(), label.clone()).map_err(|e| e.to_string())?;
            (Box::new(rec), format!("{via} {label} (recording to {path})"))
        }
        None => (rpc, format!("{via} {label}")),
    };
    let second = match urls.get(1) {
        Some(u) => {
            let (rpc, label) = open(u)?;
            Some((rpc, format!("{via} {label}")))
        }
        None => None,
    };
    Ok((first, second, source_notes))
}

struct Observed {
    noid: NoidObservation,
    eth: EthObservation,
    now: u64,
    noid_rpc: Box<dyn JsonRpc>,
    sources: serde_json::Value,
    /// REVIEW-3 G3: what the way the nodes were given says (e.g. both on one host); `tick` adds it to its notes.
    source_notes: Vec<String>,
    /// REVIEW-3 F7: the `--eth-from-block` the command line gave (the value in use may come from the swap file instead).
    eth_from_block_flag: Option<u64>,
}

/// Chain ids of local development chains (Hardhat, Ganache): a whole-chain log scan is cheap there.
const LOCAL_ETH_CHAINS: [u64; 2] = [31_337, 1_337];

/// REVIEW-3 F7: the block `eth_getLogs` starts from, and the flag value if one was given. `--eth-from-block N` wins; else the
/// swap file's stored value; else 0, but only on a local chain or with a recorded fixture (which never sends a range). A live
/// node on any other chain is refused: 0 makes a huge scan on a public node and a provider's range cap then hides the logs.
fn resolve_eth_from_block(file: &SwapFile, flags: &HashMap<String, Vec<String>>) -> Res<(u64, Option<u64>)> {
    let given = match flags.get("eth-from-block").and_then(|v| v.first()) {
        Some(b) => Some(b.replace('_', "").parse::<u64>().map_err(|e| format!("--eth-from-block: {e}"))?),
        None => None,
    };
    if let Some(n) = given.or(file.eth_from_block) {
        return Ok((n, given));
    }
    if !flags.contains_key("eth-rpc") || LOCAL_ETH_CHAINS.contains(&file.public.params.eth.chain_id) {
        return Ok((0, None));
    }
    Err("give --eth-from-block N once (the HTLC deployment block, or any block before your swap started); it is stored in the swap file on the next tick --apply".into())
}

/// REVIEW-3 F7: keep a `--eth-from-block` the command line gave in the swap file (history entry `eth_from_block_set:N`).
fn store_eth_from_block(file: &mut SwapFile, given: Option<u64>, now: u64) {
    if let Some(n) = given {
        file.set_eth_from_block(n, now);
    }
}

/// Run both watchers for `file` (the part `tick` and `claim` share).
fn observe(file: &SwapFile, flags: &HashMap<String, Vec<String>>) -> Res<Observed> {
    observe_tracking(None, file, flags, None)
}

/// [`observe`], additionally asking the node about `closed_by` (`tick --closed-by`) when the phase tracks no txid of its own.
/// `producer_cache`: the swap file's path when this command should read the producer headers (`tick` only); `None` reads none.
fn observe_tracking(producer_cache: Option<&Path>, file: &SwapFile, flags: &HashMap<String, Vec<String>>, closed_by: Option<&str>) -> Res<Observed> {
    // REVIEW-2 F12: `--now` rewrites both `observed_at` stamps, which switches the staleness rule off.
    // That is for replaying recorded fixtures only; a live RPC must be judged by the real clock.
    if flags.contains_key("now") && (flags.contains_key("noid-rpc") || flags.contains_key("eth-rpc")) {
        return Err("--now is for recorded fixtures only: it is refused together with --noid-rpc or --eth-rpc (it would disable the staleness check on a live node)".into());
    }
    let net = net(flags)?;
    let ((noid_rpc, noid_src), noid_second, mut source_notes) = chain_source(flags, "noid", &net)?;
    let ((eth_rpc, eth_src), eth_second, eth_notes) = chain_source(flags, "eth", &net)?;
    source_notes.extend(eth_notes);
    let single_node_ok = flags.contains_key("single-node-ok");
    // REVIEW-2 F6: the txid stays tracked after inclusion, until the close is final, so a rollback is noticed.
    let tracked = match &file.phase {
        Phase::Bob(BobPhase::ClaimSubmitted { txid, .. } | BobPhase::ClaimIncluded { txid, .. }) => Some(txid.clone()),
        Phase::Alice(swap_cli::state::AlicePhase::RefundSubmitted { txid, .. }) => txid.clone(),
        Phase::Alice(swap_cli::state::AlicePhase::RefundIncluded { txid, .. }) => Some(txid.clone()),
        _ => None,
    }
    .or_else(|| closed_by.map(str::to_string));
    let noid = NoidWatcher::new(&noid_rpc, file.public.opening_hex.clone())
        .observe(tracked.as_deref())
        .map_err(|e| format!("parano1d watcher: {e}"))?;
    // REVIEW-2 F5: a second Parano1d node, polled in the same tick. It answers a different question (do you agree?), so it
    // tracks no txid; if it fails, the first node's reading stands and the reason is attached for the engine to weigh.
    let mut noid = noid;
    if let Some((rpc2, _)) = &noid_second {
        match NoidWatcher::new(rpc2, file.public.opening_hex.clone()).observe(None) {
            Ok(o) => noid.second = Some(Box::new(o)),
            Err(e) => noid.second_error = Some(format!("parano1d watcher (second node): {e}")),
        }
    }
    noid.single_node_ok = single_node_ok;
    // Display only (the note that the second node agreed): `scheme://host:port` of the second `--noid-rpc`, nothing from its path.
    noid.second_label = flags.get("noid-rpc").and_then(|v| v.get(1)).map(|u| redact(u));
    // T21: the operator accepts the producer-concentration risk (never implied by a profile).
    noid.accept_producer_concentration = flags.contains_key("accept-producer-concentration");
    // T21: who produced the recent blocks, from Bob's own node's headers. Bob only, before his lock, and only against a live node.
    if let (Some(path), true) = (producer_cache, swap_cli::engine::producer_scan_wanted(file)) {
        if let Some(urls) = flags.get("noid-rpc") {
            noid.producers = Some(read_producers_for(path, file, &net, urls, &noid));
        }
    }
    // Bob knows his lock id as soon as he chose T_reveal; Alice discovers Bob's
    // lock by the agreed parties and her hashlock until she has recorded it.
    let lock_id = expected_lock_id(file).unwrap_or([0u8; 32]);
    let pending: Vec<[u8; 32]> = flags
        .get("pending-tx")
        .map(|v| v.iter().map(|h| parse_hex32(h)).collect::<Result<_, _>>())
        .transpose()
        .map_err(|e| e.to_string())?
        .unwrap_or_default();
    let (from_block, from_block_flag) = resolve_eth_from_block(file, flags)?;
    let p = &file.public.params.eth;
    // REVIEW-3 F3: the nonces of the address this role signs with (Bob: lock and refund; Alice: the reveal), for `intent --cancel`.
    let signer = if file.role == Role::Bob { p.bob_sender } else { p.alice_receiver };
    // REVIEW-6 R6-3: a claim of Alice's that was mined and may have reverted (`live.js claim` prints its hash); both nodes check it.
    let reveal_tx: Option<[u8; 32]> = match flags.get("reveal-tx") {
        None => None,
        Some(v) if v.len() == 1 => Some(parse_hex32(&v[0]).map_err(|e| format!("--reveal-tx: {e}"))?),
        Some(_) => return Err("--reveal-tx takes exactly one transaction hash".into()),
    };
    // REVIEW-6 R6-1: the all-`Locked`-logs scan of the poseidon kind is asked only while Bob can still decide to lock (before his lock is
    // seen, and for the re-send of a dropped one). After that nothing he does depends on it, so it is not asked and cannot fail a poll.
    let word_scan = swap_cli::engine::word_scan_wanted(file);
    let eth = EthWatcher::new(&eth_rpc, p.contract, lock_id)
        .with_lock_kind(p.lock_kind)
        .with_discovery(LockDiscovery { sender: p.bob_sender, receiver: p.alice_receiver, hashlock: file.public.hashlock })
        .with_from_block(from_block)
        .with_pending_txs(pending.clone())
        .with_word_scan(word_scan)
        .with_reveal_tx(reveal_tx)
        .with_signer(signer)
        .observe()
        .map_err(|e| format!("eth watcher: {e}"))?;
    let mut eth = eth;
    if let Some((rpc2, _)) = &eth_second {
        let second = EthWatcher::new(rpc2, p.contract, lock_id)
            .with_lock_kind(p.lock_kind)
            .with_discovery(LockDiscovery { sender: p.bob_sender, receiver: p.alice_receiver, hashlock: file.public.hashlock })
            .with_from_block(from_block)
            .with_pending_txs(pending)
            .with_word_scan(word_scan)
            .with_reveal_tx(reveal_tx)
            .observe();
        match second {
            Ok(o) => eth.second = Some(Box::new(o)),
            Err(e) => eth.second_error = Some(format!("eth watcher (second node): {e}")),
        }
    }
    eth.single_node_ok = single_node_ok;
    eth.second_label = flags.get("eth-rpc").and_then(|v| v.get(1)).map(|u| redact(u));
    // `--now T` pins the clock for a replay of recorded fixtures: the recordings are then
    // taken to have been observed at T, or the engine would (rightly) call them stale.
    let now = match flags.get("now").and_then(|v| v.first()) {
        Some(t) => {
            let t = t.parse::<u64>().map_err(|e| e.to_string())?;
            noid.observed_at = Some(t);
            eth.observed_at = Some(t);
            if let Some(s) = noid.second.as_mut() {
                s.observed_at = Some(t);
            }
            if let Some(s) = eth.second.as_mut() {
                s.observed_at = Some(t);
            }
            t
        }
        None => now_unix(),
    };
    let mut sources = sources(noid_src, noid_second.map(|s| s.1), eth_src, eth_second.map(|s| s.1));
    sources["eth_from_block"] = serde_json::json!(from_block);
    Ok(Observed { noid, eth, now, noid_rpc, sources, source_notes, eth_from_block_flag: from_block_flag })
}

/// T21: read the producer summary for Bob's file from his own node(s). Uses its own transports (never the recording ones, so no header or
/// miner address ends up in a recorded fixture) with a timeout no longer than the per-tick budget. The cache is `<swap file>.producers`.
/// Any failure is in the summary; this never fails the tick.
fn read_producers_for(path: &Path, file: &SwapFile, net: &Net, urls: &[String], noid: &NoidObservation) -> swap_cli::watch::producers::ProducerSummary {
    use swap_cli::watch::producers::{cache_path_for, read_producers, ProducerSummary, ReaderConfig, DEFAULT_BUDGET, PER_CALL_TIMEOUT};
    let g = file.public.params.profile.gates();
    let (long, short) = (g.producer_window_long, g.producer_window_short);
    let reader_net = Net { curl: net.curl, curl_path: net.curl_path.clone(), timeout: net.timeout.min(DEFAULT_BUDGET).min(PER_CALL_TIMEOUT), allow_plain_http: net.allow_plain_http };
    let first = match open_url(&reader_net, &urls[0]) {
        Ok(r) => r,
        Err(e) => return ProducerSummary::failed(noid.tip, long, short, now_unix(), format!("cannot open the node for the headers: {e}")),
    };
    let second = match urls.get(1) {
        Some(u) => match open_url(&reader_net, u) {
            Ok(r) => Some(r),
            Err(e) => return ProducerSummary::failed(noid.tip, long, short, now_unix(), format!("cannot open the second node for the headers: {e}")),
        },
        None => None,
    };
    let mut cfg = ReaderConfig::new(long, short);
    cfg.source = Some(redact(&urls[0]));
    // A second node whose whole poll failed (`second_error`) is left to the F5 rule, which holds the lock with its own reason; its headers are not asked for.
    let second_tip = noid.second.as_ref().map(|s| s.tip);
    let second = if noid.second_error.is_some() { None } else { second };
    read_producers(first.as_ref(), second.as_ref().map(|r| (r.as_ref(), second_tip)), &cache_path_for(path), noid.tip, &cfg)
}

/// The `sources` block of a report; a second node is listed only when there is one.
fn sources(noid: String, noid_second: Option<String>, eth: String, eth_second: Option<String>) -> serde_json::Value {
    let mut v = serde_json::json!({"noid": noid, "eth": eth});
    if let Some(s) = noid_second {
        v["noid_second"] = serde_json::json!(s);
    }
    if let Some(s) = eth_second {
        v["eth_second"] = serde_json::json!(s);
    }
    v
}

fn print_json(v: &serde_json::Value) -> Res<()> {
    println!("{}", serde_json::to_string_pretty(v).map_err(|e| e.to_string())?);
    Ok(())
}

/// How long a command waits for another `swap-cli` command that holds the swap file (REVIEW-2 F8).
const LOCK_WAIT: Duration = Duration::from_secs(10);

fn lock_swap_file(path: &Path) -> Res<SwapLock> {
    SwapLock::acquire(path, LOCK_WAIT).map_err(|e| e.to_string())
}

fn intent_json(status: &IntentStatus) -> serde_json::Value {
    let (name, intent) = match status {
        IntentStatus::None => ("none", None),
        IntentStatus::Recorded(i) => ("recorded", Some(i)),
        IntentStatus::Held(i) => ("held", Some(i)),
        IntentStatus::Resolved(i) => ("resolved", Some(i)),
    };
    serde_json::json!({"status": name, "intent": intent})
}

/// The action as printed. A spending action of the intent ledger ([`INTENT_KINDS`]) that no intent backs
/// (`backed == false`: a read-only command, or a tick that recorded none) prints its kind only (REVIEW-3 F3).
fn printable_action(action: &Action, backed: bool) -> Res<serde_json::Value> {
    if !backed && INTENT_KINDS.contains(&action.kind()) {
        return Ok(serde_json::json!({
            "kind": action.kind(),
            "parameters": "withheld",
            "note": "a read-only tick records nothing; run tick --apply to record this intent and print its parameters",
        }));
    }
    serde_json::to_value(action).map_err(|e| e.to_string())
}

fn tick(path: &str, flags: &HashMap<String, Vec<String>>) -> Res<()> {
    let path = PathBuf::from(path);
    let apply = flags.contains_key("apply");
    // Only a command that saves needs the lock (REVIEW-2 F8); a read-only tick never writes.
    let _lock = if apply { Some(lock_swap_file(&path)?) } else { None };
    let file = SwapFile::load(&path).map_err(|e| e.to_string())?;
    // M2.5d: `--closed-by TXID` records a close made outside this tool. The phase is checked first (no node needed).
    let closed_by = match flags.get("closed-by") {
        None => None,
        Some(v) => {
            let txid = normalize_txid(v.first().map(String::as_str).unwrap_or(""))?;
            check_external_close_phase(&file, &txid)?;
            Some(txid)
        }
    };
    let obs = observe_tracking(Some(&path), &file, flags, closed_by.as_deref())?;
    let (noid, eth, now) = (&obs.noid, &obs.eth, obs.now);
    // The whole `tick --apply` path is `tick_apply`: events, then the intent ledger (REVIEW-2 F3).
    // The file is saved BEFORE anything is printed, so a spending action the operator sees is
    // already on record.
    let mut work = file.clone();
    if apply {
        store_eth_from_block(&mut work, obs.eth_from_block_flag, now);
    }
    // T21-11: a reveal sidecar of this lock beside the file counts like a claim seen in the pool; read first, so this decision uses it.
    let sidecar_notes = swap_cli::reveal_sidecar::note_sidecar(&mut work, &path, now);
    let mut closed_event = None;
    if let Some(txid) = &closed_by {
        // Every refusal returns here, before anything is saved.
        let event = external_close_event(&file, noid, txid)?;
        work.apply(&event, now).map_err(|e| e.to_string())?;
        closed_event = Some(event);
    }
    let outcome = tick_apply(&mut work, noid, eth, now, apply).map_err(|e| e.to_string())?;
    if apply {
        work.save(&path).map_err(|e| e.to_string())?;
    }
    let mut decision = outcome.decision;
    decision.notes.extend(obs.source_notes.iter().cloned());
    decision.notes.extend(sidecar_notes);
    let closed_height = match &closed_event {
        Some(swap_cli::state::Event::NoidClosedExternally { height, .. }) => Some(*height),
        _ => None,
    };
    let closed_json = closed_height.map(|height| {
        let (to, branch) = if file.role == Role::Alice { ("Alice (refund)", "recovery") } else { ("Bob (claim)", "claim") };
        serde_json::json!({
            "txid": closed_by,
            "height": height,
            "deadline": file.public.params.deadline_height,
            "branch": branch,
            "payout_to": to,
            "payout_read_from_chain": false,
            "recorded": apply,
            "phase_before": file.phase.name(),
        })
    });
    if let Some(e) = closed_event.clone() {
        decision.events.insert(0, e);
        decision.notes.insert(0, format!(
            "{} the close {} (confirmed at height {}, the instance is gone) as {}. getTx exposes only the txid, height, block hash and position, never the outputs, so the payout is not read: it follows from the branch rule (h < D pays Bob, h >= D pays Alice). The tool cannot prove that this txid is the call that closed THIS instance; check it against your wallet's receipt.",
            if apply { "RECORDED" } else { "WOULD RECORD (add --apply to write it)" },
            closed_by.as_deref().unwrap_or(""),
            closed_height.unwrap_or(0),
            if file.role == Role::Alice { "Alice's recovery close" } else { "Bob's claim" },
        ));
    }
    // REVIEW-3 F3: a read-only tick records nothing, so it must not hand out the parameters of a spend. An operator who
    // acts on them and then acts again on the next tick's fresh ones sends twice (a double lock). A held intent never
    // reaches here as a spend (the ledger turned it into `wait`); `claim_noid` is not a ledger kind (`swap-cli claim`).
    let recorded = apply || !matches!(outcome.intent, IntentStatus::None | IntentStatus::Resolved(_));
    let action_json = printable_action(&decision.action, recorded)?;
    let v = serde_json::json!({
        "now": now,
        "sources": obs.sources,
        "noid": noid,
        "eth": eth,
        "events": decision.events,
        "closed_by": closed_json,
        "action": action_json,
        "notes": decision.notes,
        "intent": intent_json(&outcome.intent),
        "events_applied_to_file": apply,
        "action_executed": false,
        "phase_after": if apply { work.phase.name() } else { file.phase.name() },
    });
    print_json(&v)
}

/// `intent FILE [--show | --cancel]` (REVIEW-2 F3): the spending action `tick --apply` froze, if any.
/// `--cancel` drops an intent that was never sent; it needs the same chain flags as `tick` because it
/// refuses when the chain already shows the effect.
fn intent(path: &str, flags: &HashMap<String, Vec<String>>) -> Res<()> {
    let path = PathBuf::from(path);
    if flags.contains_key("cancel") && flags.contains_key("show") {
        return Err("give --show or --cancel, not both".into());
    }
    if !flags.contains_key("cancel") {
        let file = SwapFile::load(&path).map_err(|e| e.to_string())?;
        let log: Vec<_> = file.history.iter().filter(|h| h.event.starts_with("intent_")).collect();
        return print_json(&serde_json::json!({"pending_intent": file.pending_intent, "cancelled_intents": file.cancelled_intents, "intent_history": log}));
    }
    let _lock = lock_swap_file(&path)?;
    let mut file = SwapFile::load(&path).map_err(|e| e.to_string())?;
    let obs = observe(&file, flags)?;
    let cancelled = cancel_intent_checked(&mut file, &obs.noid, &obs.eth, obs.now, flags.contains_key("i-checked-the-wallet"))?;
    file.save(&path).map_err(|e| e.to_string())?;
    print_json(&serde_json::json!({"cancelled": cancelled, "pending_intent": file.pending_intent, "sources": obs.sources}))
}

/// Bob's NOID claim (client R). Dry run unless `--submit`.
fn claim(path: &str, flags: &HashMap<String, Vec<String>>) -> Res<()> {
    let path = PathBuf::from(path);
    // A submitting claim loads, proves for minutes, then saves: no other command may save in between (F8).
    let _lock = if flags.contains_key("submit") { Some(lock_swap_file(&path)?) } else { None };
    let mut file = SwapFile::load(&path).map_err(|e| e.to_string())?;
    if file.role != Role::Bob {
        return Err("claim is for Bob only: Alice never claims NOID (she reveals on Ethereum and refunds with the stock wallet)".into());
    }
    let submit = flags.contains_key("submit");
    if submit && !flags.contains_key("noid-rpc") {
        return Err("--submit needs --noid-rpc URL: a fixture cannot receive a transaction".into());
    }
    let obs = observe(&file, flags)?;
    let decision = decide(&file, &obs.noid, &obs.eth, obs.now);
    if !matches!(decision.action, Action::ClaimNoid { .. }) {
        return print_json(&serde_json::json!({
            "claim": "not attempted: the engine's action is not claim_noid",
            "sources": obs.sources,
            // Nothing is recorded here: a ledger spend's parameters stay withheld (REVIEW-3 F3).
            "action": printable_action(&decision.action, false)?,
            "events": decision.events,
            "notes": decision.notes,
            "submitted": false,
        }));
    }
    if !submit {
        // Dry run: pretend the tick's facts were recorded, then build, prove and self-verify. Nothing is sent or saved.
        let mut sim = file.clone();
        for e in &decision.events {
            sim.apply(e, obs.now).map_err(|e| e.to_string())?;
        }
        let executor = RawClaimExecutor::new(obs.noid_rpc, Vec::new());
        let plan = executor.plan(&sim, &decision.action).map_err(|e| e.to_string())?;
        if let Some(out) = flags.get("intent-out").and_then(|v| v.first()) {
            write_new(Path::new(out), plan.intent_hex().as_bytes())?;
        }
        return print_json(&serde_json::json!({
            "mode": "dry_run",
            "submitted": false,
            "sources": obs.sources,
            "action": decision.action,
            "plan": {
                "txid": plan.txid_hex(),
                "call_height": plan.call_height,
                "height_class": format!("{:?}", plan.height_class),
                "authorization_version": format!("{:?}", plan.version),
                "fee_micronoid": plan.fee_micronoid,
                "amount_out_micronoid": plan.amount_out,
                "recipient": plan.recipient.to_bech32(),
                "intent_bytes": plan.intent_bytes.len(),
                "self_verified": true,
            },
            "notes": decision.notes,
            "next": "re-run with --submit to send this claim",
        }));
    }
    // Live: every URL given (the primary node first, then --submit-rpc) receives the intent.
    let net = net(flags)?;
    let mut urls = vec![flags["noid-rpc"][0].clone()];
    urls.extend(flags.get("submit-rpc").cloned().unwrap_or_default());
    let mut nodes: Vec<(String, Box<dyn IntentSubmitter>)> = Vec::new();
    for u in &urls {
        nodes.push((redact(u), Box::new(RpcSubmitter(open_url(&net, u)?))));
    }
    // REVIEW-3 F7: the log-scan start the claim used is kept for the next command.
    if file.eth_from_block != obs.eth_from_block_flag.or(file.eth_from_block) {
        store_eth_from_block(&mut file, obs.eth_from_block_flag, obs.now);
        file.save(&path).map_err(|e| e.to_string())?;
    }
    eprintln!("SUBMITTING Bob's claim to {} node(s): {}", nodes.len(), nodes.iter().map(|(n, _)| n.as_str()).collect::<Vec<_>>().join(", "));
    let mut runner = Runner { file, path, executor: RawClaimExecutor::new(obs.noid_rpc, nodes) };
    let report = runner.tick(&obs.noid, &obs.eth, obs.now).map_err(|e| e.to_string())?;
    let plan = runner.executor.last_plan.as_ref().map(|p| {
        serde_json::json!({"txid": p.txid_hex(), "call_height": p.call_height, "fee_micronoid": p.fee_micronoid, "amount_out_micronoid": p.amount_out, "recipient": p.recipient.to_bech32(), "intent_bytes": p.intent_bytes.len()})
    });
    let accepted = runner.executor.last_report.as_ref().map(|r| serde_json::json!({"accepted": r.accepted, "rejected": r.rejected}));
    let v = serde_json::json!({
        "mode": "submit",
        "sources": obs.sources,
        "events": report.events,
        "action": report.action,
        "attempt": report.attempt,
        "outcome": report.outcome,
        "exec_error": report.exec_error,
        "phase": report.phase,
        "notes": report.notes,
        "plan": plan,
        "nodes": accepted,
        "submitted": report.outcome.is_some(),
    });
    print_json(&v)?;
    match report.exec_error {
        Some(e) => Err(format!("claim not submitted: {e}")),
        None => Ok(()),
    }
}

/// Write `bytes` to a NEW file; an existing file is accepted only if it already holds exactly these bytes.
fn write_new(path: &Path, bytes: &[u8]) -> Res<()> {
    match std::fs::read(path) {
        Ok(existing) if existing == bytes => return Ok(()),
        Ok(_) => return Err(format!("{} already exists with different content; never overwritten", path.display())),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(e) => return Err(format!("{}: {e}", path.display())),
    }
    std::fs::write(path, bytes).map_err(|e| format!("{}: {e}", path.display()))
}

fn alice_params(path: &str, flags: &HashMap<String, Vec<String>>) -> Res<()> {
    let file = SwapFile::load(Path::new(path)).map_err(|e| e.to_string())?;
    let c = contract_params(&file.public).map_err(|e| e.to_string())?;
    let json_text = |v: &serde_json::Value| -> Res<Vec<u8>> {
        let mut t = serde_json::to_vec_pretty(v).map_err(|e| e.to_string())?;
        t.push(b'\n');
        Ok(t)
    };
    let get = |k: &str| flags.get(k).and_then(|v| v.first()).cloned();
    if let Some(p) = get("params-out") {
        write_new(Path::new(&p), &json_text(&c.pruv_params)?)?;
        eprintln!("pruv params written: {p}");
    }
    if let Some(p) = get("definition-out") {
        write_new(Path::new(&p), &json_text(&c.definition)?)?;
        eprintln!("contract definition written: {p}");
    }
    if let Some(p) = get("check-object") {
        let text = std::fs::read_to_string(&p).map_err(|e| format!("{p}: {e}"))?;
        let object: serde_json::Value = serde_json::from_str(&text).map_err(|e| format!("{p}: {e}"))?;
        let addr = check_object_file(&file.public, &object)?;
        eprintln!("object file OK: its opening is byte-for-byte the swap file's; fund exactly this address: {addr}");
    }
    eprintln!("{}", CheckedBundle::new(&file.public)?.line());
    eprintln!(
        "Before funding: the stock wallet's ACTIVE address at refund time must be {} (a different active address cannot do the recovery close).",
        c.recovery_authority
    );
    eprintln!(
        "Fund {} NOID (not before Bob has verified the bundle and the equivalence proof); Bob must lock on Ethereum by Parano1d height {}; deadline D = {}.",
        c.fund_amount_noid, c.lock_by_height, c.deadline_height
    );
    let def = get("definition-out").unwrap_or_else(|| "swap.def.json".into());
    let mut v = serde_json::to_value(&c).map_err(|e| e.to_string())?;
    v["role_of_file"] = serde_json::json!(file.role.to_string());
    v["commands"] = alice_commands(&c, path, &def, "swap.object.json");
    print_json(&v)
}

fn flag<'a>(flags: &'a HashMap<String, Vec<String>>, key: &str) -> Res<&'a str> {
    flags.get(key).and_then(|v| v.first()).map(String::as_str).ok_or_else(|| format!("missing --{key}\n{USAGE}"))
}

/// T9 / G5: record the hashlock of a new swap file so that no second file on this machine is made for it.
///
/// With `--registry FILE` that file alone is used (as before). Without it TWO files are used and a hit in either refuses: the
/// per-machine registry (`$NOID_SWAP_HOME/hashlocks.txt`, else `$HOME/.noid-swap/hashlocks.txt`; directory mode 700 and file mode 600 on
/// Unix; one line per swap file: the hashlock and the role, never a secret) and the run folder's `hashlocks.txt`
/// next to `--out`. Both are checked before either is written, so a refusal leaves both as they were. With no home the run folder's file is
/// used alone and a warning says so. A per-machine file that cannot be read or written refuses (fail closed); `--registry FILE` is the way
/// around. The registry is written BEFORE the swap file is saved (fail closed: no swap file without a registry line). There is no retry
/// allowance: any hit in either file refuses, even for the same output path, so a run that died after registering and before saving is
/// handled by the operator (`--registry FILE`, or removing the line).
/// The per-machine registry is only ever named on stderr as `$NOID_SWAP_HOME/hashlocks.txt` or `~/.noid-swap/hashlocks.txt`, never by its
/// expanded path (the user name would end up in log files).
fn register_hashlock(flags: &HashMap<String, Vec<String>>, out: &Path, hashlock: &[u8; 32], role: &str) -> Res<()> {
    if let Some(explicit) = flags.get("registry").and_then(|v| v.first()) {
        return HashlockRegistry::new(PathBuf::from(explicit)).register(hashlock).map_err(|e| e.to_string());
    }
    let folder = HashlockRegistry::new(out.parent().unwrap_or(Path::new(".")).join("hashlocks.txt"));
    let machine = swap_cli::swapfile::machine_registry_path().map(|p| HashlockRegistry::for_machine(p, role));
    if machine.is_none() {
        eprintln!(
            "warning: no home directory (HOME is unset), so the per-machine hashlock registry is not used; only {} guards against a second swap file on this hashlock (set HOME or NOID_SWAP_HOME, or pass --registry FILE)",
            folder.path().display()
        );
    }
    let shown = swap_cli::swapfile::machine_registry_display();
    let mut to_write = Vec::new();
    for (reg, is_machine) in machine.iter().map(|m| (m, true)).chain(std::iter::once((&folder, false))) {
        let name = if is_machine { shown.to_string() } else { reg.path().display().to_string() };
        match reg.contains(hashlock) {
            Ok(false) => to_write.push(reg),
            Ok(true) => {
                return Err(format!(
                    "hashlock already used by another swap (T9): it is in {name}; if an earlier run died before saving its swap file, pass --registry FILE or remove that line yourself"
                ))
            }
            Err(e) => return Err(format!("the hashlock registry {name} cannot be read ({e}); fix it or pass --registry FILE")),
        }
    }
    for reg in to_write {
        let name = if reg.is_machine() { shown.to_string() } else { reg.path().display().to_string() };
        reg.append(hashlock).map_err(|e| format!("the hashlock registry {name} cannot be written ({e}); fix it or pass --registry FILE"))?;
    }
    if machine.is_some() {
        eprintln!("hashlock registry: recorded in {shown} (per machine) and {} (this run folder)", folder.path().display());
    }
    Ok(())
}

fn flag_u64(flags: &HashMap<String, Vec<String>>, key: &str) -> Res<u64> {
    flag(flags, key)?.replace('_', "").parse::<u64>().map_err(|e| format!("--{key}: {e}"))
}

const CHAIN_ID_WHY: &str = "the Ethereum chain id this swap runs on (e.g. 11155111 for Sepolia); a spend is refused on any other chain";

/// A flag that must be given, with the reason in the error (no default, no escape flag).
fn required<'a>(flags: &'a HashMap<String, Vec<String>>, key: &str, why: &str) -> Res<&'a str> {
    flags.get(key).and_then(|v| v.first()).map(String::as_str).ok_or_else(|| format!("missing --{key}: {why}"))
}

fn required_u64(flags: &HashMap<String, Vec<String>>, key: &str, why: &str) -> Res<u64> {
    required(flags, key, why)?.replace('_', "").parse::<u64>().map_err(|e| format!("--{key}: {e}"))
}

/// REVIEW-3 F1: `--eth-code-hash` is optional. Omitted -> the code hash compiled into this build
/// (`params::HTLC_CODE_HASH`); given -> it must equal that constant, else refused (no override, no escape flag).
fn eth_code_hash_flag(flags: &HashMap<String, Vec<String>>, kind: LockKind) -> Res<[u8; 32]> {
    let pin = swap_cli::params::code_hash_for(kind);
    let Some(text) = flags.get("eth-code-hash").and_then(|v| v.first()) else {
        return Ok(pin);
    };
    let given = parse_hex32(text).map_err(|e| format!("--eth-code-hash: {e}"))?;
    if given != pin {
        return Err(format!("--eth-code-hash: {}", swap_cli::swapfile::other_contract_message_for(kind, "the given value", &given)));
    }
    Ok(given)
}

/// `--eth-lock-kind sha256|poseidon`; `sha256` (`HTLC.sol`) when absent.
fn parse_lock_kind(flags: &HashMap<String, Vec<String>>) -> Res<LockKind> {
    match flags.get("eth-lock-kind").and_then(|v| v.first()) {
        None => Ok(LockKind::Sha256),
        Some(v) => v.parse::<LockKind>().map_err(|e| format!("--eth-lock-kind: {e}")),
    }
}

/// The strong KDF, or (test builds only) the fast one. REVIEW-2 F14: a release binary has no fast KDF.
fn kdf_params(flags: &HashMap<String, Vec<String>>) -> Res<KdfParams> {
    if flags.contains_key("fast-kdf") {
        #[cfg(any(test, feature = "dev"))]
        return Ok(KdfParams::fast_for_tests());
        #[cfg(not(any(test, feature = "dev")))]
        return Err("--fast-kdf is a test-only option and does not exist in this build".into());
    }
    Ok(KdfParams::default_strong())
}

fn addr20(text: &str) -> Res<[u8; 20]> {
    let t = text.strip_prefix("0x").unwrap_or(text);
    let v = hex::decode(t).map_err(|e| format!("{text}: {e}"))?;
    v.try_into().map_err(|_| format!("{text}: not 20 bytes"))
}

fn passphrase(flags: &HashMap<String, Vec<String>>) -> Res<Passphrase> {
    let var = flag(flags, "passphrase-env").unwrap_or("SWAP_PASSPHRASE");
    let text = std::env::var(var).map_err(|_| format!("set the passphrase in the environment variable {var}"))?;
    if text.len() < 12 {
        return Err("passphrase must be at least 12 characters".into());
    }
    Ok(Passphrase::new(text))
}

fn new_alice(flags: &HashMap<String, Vec<String>>) -> Res<()> {
    let out = PathBuf::from(flag(flags, "out")?);
    if out.exists() {
        return Err(format!("{} already exists; never overwrite a swap file", out.display()));
    }
    let variant = match flag(flags, "variant").unwrap_or("raw") {
        "raw" => Variant::Raw,
        "stock" => Variant::Stock,
        other => return Err(format!("unknown variant {other}")),
    };
    let alice = Address::parse(flag(flags, "alice")?).map_err(|e| format!("--alice: {e}"))?;
    let bob = Address::parse(flag(flags, "bob")?).map_err(|e| format!("--bob: {e}"))?;
    let lock_kind = parse_lock_kind(flags)?;
    if lock_kind == LockKind::Poseidon && variant != Variant::Raw {
        return Err(format!("--eth-lock-kind poseidon: {}", swap_cli::swapfile::poseidon_raw_only_message()));
    }
    let eth = EthParams {
        chain_id: required_u64(flags, "eth-chain-id", CHAIN_ID_WHY)?,
        contract: addr20(flag(flags, "eth-contract")?)?,
        code_hash: Some(eth_code_hash_flag(flags, lock_kind)?),
        lock_kind,
        amount_wei: flag(flags, "eth-amount-wei")?.parse::<u128>().map_err(|e| format!("--eth-amount-wei: {e}"))?,
        alice_receiver: addr20(flag(flags, "eth-receiver")?)?,
        bob_sender: addr20(flag(flags, "eth-sender")?)?,
    };
    let pass = passphrase(flags)?;
    let kdf = kdf_params(flags)?;
    let secret = Secret::generate().map_err(|e| e.to_string())?;
    let contract_version = parse_contract_version(flags)?;
    // F_max input: v1 = the live estimate; v2 = max(estimate, --floor-seen) (docs/htlc-v2-fixed-fee.md section 5).
    let fee_estimate = flag_u64(flags, "fee-estimate")?;
    let floor_seen = if flags.contains_key("floor-seen") { Some(flag_u64(flags, "floor-seen")?) } else { None };
    if floor_seen.is_some() && !contract_version.is_fixed_fee() {
        eprintln!("note: --floor-seen is ignored for contract v1 (F_max = max(50,000, 3 x --fee-estimate)); it applies to --contract-version 2 only");
    }
    let fee_input = swap_cli::params::floor_seen_for(contract_version, fee_estimate, floor_seen);
    let public = SwapPublic::build_with_options(
        &secret,
        variant,
        parse_profile(flags)?,
        contract_version,
        &alice,
        &bob,
        flag_u64(flags, "amount")?,
        fee_input,
        flag_u64(flags, "h-create")?,
        eth,
    )
    .map_err(|e| e.to_string())?;
    // T9: never two swaps under one hashlock on this machine.
    register_hashlock(flags, &out, &public.hashlock, "alice")?;
    let file = SwapFile::new_alice(public, &secret, &pass, &kdf, now_unix()).map_err(|e| e.to_string())?;
    file.save(&out).map_err(|e| e.to_string())?;
    eprintln!("swap file written: {} (phase created; nothing on chain)", out.display());
    if let Some(fee) = file.public.params.fixed_close_fee() {
        eprintln!(
            "contract v2 (HashTimeLockV2): every close pays exactly {fee} micro-NOID; Bob receives {} micro-NOID; tell Bob to pass --contract-version 2",
            file.public.params.bob_payout_for_fee(fee)
        );
    }
    if file.public.params.eth.lock_kind == LockKind::Poseidon {
        eprintln!(
            "ethereum lock kind poseidon (HTLCPoseidonV2): the Ethereum lock word is your NOID address A = Addr(s); Bob needs NO equivalence proof; tell Bob to pass --eth-lock-kind poseidon. Your ETH reveal costs about 517,000 gas on Ethereum mainnet (run 8) and about 689,000 on Sepolia (runs 5 and 11), as measured live (docs/poseidon-leg.md section 5)"
        );
    }
    let bundle = CheckedBundle::new(&file.public)?;
    eprintln!("{}", bundle.line());
    eprintln!("send Bob the bundle below as a file, not as pasted text (it contains no secret); Bob's new-bob prints the same `bundle check:` line:");
    println!("{}", bundle.to_pretty_json()?);
    Ok(())
}

fn new_bob(flags: &HashMap<String, Vec<String>>) -> Res<()> {
    let out = PathBuf::from(flag(flags, "out")?);
    if out.exists() {
        return Err(format!("{} already exists; never overwrite a swap file", out.display()));
    }
    // Bob's own terms (design 6.3 item 2): never read from the bundle, and demanded before the bundle is read.
    let explicit_variant = flags.get("variant").and_then(|v| v.first()).map(|v| parse_variant(v)).transpose()?;
    let profile = parse_profile(flags)?;
    let contract_version = parse_contract_version(flags)?;
    let bob_noid = Address::parse(flag(flags, "bob")?).map_err(|e| format!("--bob: {e}"))?;
    let amount_micronoid = flag_u64(flags, "amount")?;
    let eth_chain_id = required_u64(flags, "eth-chain-id", CHAIN_ID_WHY)?;
    let eth_contract = addr20(flag(flags, "eth-contract")?)?;
    let lock_kind = parse_lock_kind(flags)?;
    let eth_code_hash = eth_code_hash_flag(flags, lock_kind)?;
    let eth_amount_wei = flag(flags, "eth-amount-wei")?.parse::<u128>().map_err(|e| format!("--eth-amount-wei: {e}"))?;
    let bob_sender = addr20(flag(flags, "eth-sender")?)?;
    let text = std::fs::read_to_string(flag(flags, "bundle")?).map_err(|e| e.to_string())?;
    // The carrier check comes before any other use of the bundle: a copy damaged in transit is refused here, with that message.
    let (public, bundle_status) = open_bundle(&text, flags.contains_key("allow-unchecked-bundle"))?;
    eprintln!("{}", bundle_status.line());
    if bundle_status == BundleStatus::Unchecked {
        eprintln!("(--allow-unchecked-bundle: every other check below still runs)");
    }
    let receipt = flags.get("receipt").and_then(|v| v.first()).cloned();
    // With `--receipt` the variant defaults to the bundle's (the receipt is verified for exactly that
    // variant); without it the historical default `raw` stays.
    let variant = match explicit_variant {
        Some(v) => v,
        None if receipt.is_some() => public.params.variant,
        None => Variant::Raw,
    };
    let terms = BobTerms { variant, profile, contract_version, lock_kind, bob_noid, amount_micronoid, eth_chain_id, eth_contract, eth_code_hash, eth_amount_wei, bob_sender };
    // Bob names the lock kind himself (like the profile and the contract version); a bundle of another kind is refused before anything
    // that belongs to either kind (a receipt, a self-test) is looked at.
    if public.params.eth.lock_kind != lock_kind {
        return Err(format!(
            "bundle disagrees with your terms: the bundle locks the Ethereum leg as `{}`, you asked for `{}` (--eth-lock-kind); the two use different contracts, lock words and checks",
            public.params.eth.lock_kind, lock_kind
        ));
    }
    // The poseidon kind has no equivalence proof: the attestation is ABSENT, not typed (a present one is refused), and every option that
    // belongs to the proof is refused with it.
    let equivalence = if lock_kind == LockKind::Poseidon {
        for f in ["receipt", "equiv-prove", "equiv-h", "equiv-a", "equiv-image-id", "pinned-image-id"] {
            if flags.contains_key(f) {
                return Err(format!(
                    "--{f} belongs to the equivalence proof, which a poseidon swap does not have: both locks carry the same A = Addr(s) (docs/poseidon-leg.md). Drop it, or use --eth-lock-kind sha256"
                ));
            }
        }
        None
    } else {
        Some(equivalence_attestation(flags, &public, terms.variant, receipt.as_deref())?)
    };
    // Design step 5: rebuild the opening byte-for-byte, run the guard and the gates,
    // compare with Bob's terms, and tie the verified proof (or, for poseidon, the lock word) to this bundle.
    let mut file = SwapFile::new_bob_with(public, &terms, equivalence.as_ref(), now_unix()).map_err(|e| e.to_string())?;
    // Review V2-10: with a lock on A = Addr(s) only client R can claim; Bob sees it work on this machine before the file exists.
    let mut selftest_note = None;
    if lock_kind == LockKind::Poseidon {
        let call_height = file.public.params.deadline_height.saturating_sub(1);
        eprintln!("client R self-test (a throwaway authorization, proved and verified here; nothing is sent) ...");
        let rec = client_r_selftest(call_height, now_unix(), &file.public).map_err(|e| format!("the client R self-test failed, so no file is written and Bob must not lock: {e}"))?;
        selftest_note = Some(format!("{} ms, owner-authorization {}", rec.proof_ms, rec.auth_version));
        file.record_client_r_selftest(rec, now_unix()).map_err(|e| e.to_string())?;
    }
    register_hashlock(flags, &out, &file.public.hashlock, "bob")?;
    file.save(&out).map_err(|e| e.to_string())?;
    eprintln!("bundle checked: opening rebuilt byte-for-byte, tool guard and (I5) pass, your terms match,");
    if let Some(note) = &selftest_note {
        eprintln!("and the Ethereum lock word equals the claim authority A of the opening you rebuilt (poseidon lock: no equivalence proof exists or is needed).");
        eprintln!("client R self-test passed ({note}); re-run it with `swap-cli self-test FILE` if the owner-authorization version changes.");
    } else {
        eprintln!("and the equivalence proof you verified is for this bundle's (variant, H, A) and your pinned image id.");
    }
    match equivalence.as_ref().map(|e| e.source) {
        None => {}
        Some(AttestationSource::Receipt) => eprintln!("The receipt was verified by this tool (equiv-prove exited 0, its image id equals your pinned id); Alice's funding is checked every tick."),
        Some(AttestationSource::Typed) => {
            eprintln!("REHEARSAL ONLY: the typed form is refused under production and sepolia.");
            eprintln!("NOT checked here: the receipt itself (that is `equiv-prove verify`) and Alice's funding (checked every tick).");
            eprintln!("(You typed the proof values by hand; prefer `--receipt FILE --equiv-prove BIN`, which makes this tool run the verifier.)");
        }
    }
    eprintln!("The Ethereum contract code hash (compiled into this tool, per lock kind) and the chain id you gave are checked on every poll, before any ETH spend (lock, reveal, refund).");
    eprintln!("swap file written: {}", out.display());
    println!("{}", summary_json(&file)?);
    Ok(())
}

fn parse_variant(text: &str) -> Res<Variant> {
    match text {
        "raw" => Ok(Variant::Raw),
        "stock" => Ok(Variant::Stock),
        other => Err(format!("unknown variant {other}")),
    }
}

/// `--contract-version 1|2`; 1 (`HashTimeLock`) when absent.
fn parse_contract_version(flags: &HashMap<String, Vec<String>>) -> Res<ContractVersion> {
    match flags.get("contract-version").and_then(|v| v.first()) {
        None => Ok(ContractVersion::V1),
        Some(v) => v.parse::<ContractVersion>().map_err(|e| format!("--contract-version: {e}")),
    }
}

/// `--profile production|rehearsal|sepolia`; production when absent.
fn parse_profile(flags: &HashMap<String, Vec<String>>) -> Res<ProfileName> {
    match flags.get("profile").and_then(|v| v.first()) {
        None => Ok(ProfileName::Production),
        Some(p) => p.parse::<ProfileName>().map_err(|e| format!("--profile: {e}")),
    }
}

/// Bob's equivalence attestation (REVIEW-2 F2).
///
/// With `--receipt FILE --equiv-prove BIN` this tool runs `BIN verify <variant> <H> <A> FILE` itself,
/// with H and A taken from the bundle, and takes the image id from its output; the typed flags
/// `--equiv-h`, `--equiv-a`, `--equiv-image-id` are then optional and, if given, must agree.
/// Without `--receipt` it is the typed fallback: all three are required and believed, and it is accepted under the
/// `rehearsal` profile only (REVIEW-3 F2): under `production` and `sepolia` the receipt must be verified by this tool.
/// `--pinned-image-id` is optional (REVIEW-3 F2): omitted, the image id compiled into this tool
/// (`params::EQUIV_IMAGE_ID`) is used; given, it must equal that constant, else refused (no override).
fn equivalence_attestation(
    flags: &HashMap<String, Vec<String>>,
    public: &SwapPublic,
    variant: Variant,
    receipt: Option<&str>,
) -> Res<EquivalenceAttestation> {
    let pinned = params::EQUIV_IMAGE_ID;
    if let Some(text) = flags.get("pinned-image-id").and_then(|v| v.first()) {
        let given = parse_hex32(text).map_err(|e| format!("--pinned-image-id: {e}"))?;
        if given != pinned {
            return Err(format!(
                "--pinned-image-id {} is not the equivalence-guest image id compiled into this tool ({}); there is no override (the id is replaced when the reproducible build, milestone M1.1, is done)",
                hex::encode(given),
                hex::encode(pinned)
            ));
        }
    }
    let typed_h = flags.get("equiv-h").and_then(|v| v.first());
    let typed_a = flags.get("equiv-a").and_then(|v| v.first());
    let typed_image = flags.get("equiv-image-id").and_then(|v| v.first());
    let parse_a = |text: &str| -> Res<[u8; 32]> {
        match Address::parse(text) {
            Ok(addr) => Ok(addr.0),
            Err(_) => parse_hex32(text).map_err(|e| format!("--equiv-a: {e}")),
        }
    };
    let Some(receipt) = receipt else {
        if flags.contains_key("equiv-prove") {
            return Err("--equiv-prove only makes sense with --receipt FILE".into());
        }
        if public.params.profile != ProfileName::Rehearsal {
            return Err(format!(
                "the typed equivalence form (--equiv-h/--equiv-a/--equiv-image-id) is accepted only under the rehearsal profile, not {}: the receipt must be verified by this tool (--receipt FILE --equiv-prove BIN)",
                public.params.profile
            ));
        }
        // The typed fallback: what `equiv-prove verify <variant> <H> <A> <receipt>` (equiv/README.md
        // section 5) checked, and the image id it printed, exactly as Bob supplies them.
        let h = parse_hex32(flag(flags, "equiv-h")?).map_err(|e| format!("--equiv-h: {e}"))?;
        let a = parse_a(flag(flags, "equiv-a")?)?;
        let mut journal = vec![variant.journal_byte()];
        journal.extend_from_slice(&h);
        journal.extend_from_slice(&a);
        let image_id = parse_hex32(flag(flags, "equiv-image-id")?).map_err(|e| format!("--equiv-image-id: {e}"))?;
        return Ok(EquivalenceAttestation::typed(journal, image_id, pinned));
    };
    let bin = required(flags, "equiv-prove", "the path of the `equiv-prove` binary that verifies the receipt (equiv/README.md section 5)")?;
    // The bundle must be sound before anything is spawned for it.
    public.check().map_err(|e| e.to_string())?;
    if let Some(h) = typed_h {
        if parse_hex32(h).map_err(|e| format!("--equiv-h: {e}"))? != public.hashlock {
            return Err("--equiv-h disagrees with the bundle's hashlock".into());
        }
    }
    if let Some(a) = typed_a {
        if parse_a(a)? != public.authority().map_err(|e| e.to_string())?.0 {
            return Err("--equiv-a disagrees with the bundle's claim authority".into());
        }
    }
    let req = VerifyRequest { bin: Path::new(bin), variant, receipt: Path::new(receipt) };
    let attestation = verify_receipt(&mut ProcessRunner, public, &req, now_unix()).map_err(|e| e.to_string())?;
    if let Some(id) = typed_image {
        if parse_hex32(id).map_err(|e| format!("--equiv-image-id: {e}"))? != attestation.image_id {
            return Err("--equiv-image-id disagrees with the image id the verifier printed".into());
        }
    }
    Ok(attestation)
}

fn bundle(path: &str) -> Res<()> {
    let file = SwapFile::load(Path::new(path)).map_err(|e| e.to_string())?;
    let bundle = CheckedBundle::new(&file.public)?;
    eprintln!("{}", bundle.line());
    println!("{}", bundle.to_pretty_json()?);
    Ok(())
}

fn summary_json(file: &SwapFile) -> Res<String> {
    let p = &file.public.params;
    let mut v = serde_json::json!({
        "role": file.role.to_string(),
        "phase": file.phase.name(),
        "phase_detail": file.phase,
        "pending_action": file.pending_action,
        "history": file.history,
        "hashlock": format!("0x{}", hex::encode(file.public.hashlock)),
        "claim_authority": file.public.claim_authority,
        "contract_root": file.public.contract_root,
        "variant": p.variant.to_string(),
        "profile": p.profile.as_str(),
        "contract_version": p.contract_version.number(),
        "amount_micronoid": p.amount_micronoid,
        "max_fee_micronoid": p.max_fee_micronoid,
        "h_create": p.h_create,
        "deadline_height": p.deadline_height,
        "lock_by_height": p.lock_by_height,
        "secret_sealed": file.secret.is_some(),
    });
    if p.eth.lock_kind == LockKind::Poseidon {
        v["eth_lock_kind"] = serde_json::json!(p.eth.lock_kind.as_str());
        v["eth_lock_word"] = serde_json::json!(format!("0x{}", hex::encode(file.public.hashlock)));
        v["client_r_selftest"] = serde_json::json!(file.client_r_selftest);
    }
    if let Some(fee) = p.fixed_close_fee() {
        // Contract v2: every close pays exactly max_fee, so Bob's payout is known up front. v1 output is unchanged.
        v["close_fee_rule"] = serde_json::json!("fixed: every close (claim and recovery) pays exactly max_fee");
        v["fixed_close_fee_micronoid"] = serde_json::json!(fee);
        v["expected_bob_payout_micronoid"] = serde_json::json!(p.bob_payout_for_fee(fee));
    }
    serde_json::to_string_pretty(&v).map_err(|e| e.to_string())
}

fn status(path: &str) -> Res<()> {
    let file = SwapFile::load(Path::new(path)).map_err(|e| e.to_string())?;
    println!("{}", summary_json(&file)?);
    Ok(())
}

/// Alice's secret as 0x-hex, piped into `equiv-prove prove raw --secret-stdin …` (the equivalence proof Bob
/// requires before locking) and for the Ethereum reveal (`HTLC.claim(lockId, preimage)`).
/// Stdout only; the passphrase comes from the environment like everywhere else. Bob's
/// file has no secret, so this fails for him.
fn secret(path: &str, flags: &HashMap<String, Vec<String>>) -> Res<()> {
    let file = SwapFile::load(Path::new(path)).map_err(|e| e.to_string())?;
    let pass = passphrase(flags)?;
    let s = file.decrypt_secret(&pass).map_err(|e| e.to_string())?;
    if file.public.params.eth.lock_kind == LockKind::Poseidon {
        // REVIEW-6 R6-7: no equivalence proof exists for this kind, so the advice to pipe the secret into `equiv-prove` is not given.
        eprintln!("poseidon swap: there is no equivalence proof to make; this secret is for the Ethereum reveal only (live.js claim --swap FILE reads it on stdin). Never send it to a remote node before the reveal itself (no eth_call, no estimateGas).");
        eprintln!("WARNING: this is the swap secret. Whoever has it can trigger the Ethereum reveal; give it only to the reveal command. Pipe it, never paste it into a command line.");
    } else {
        eprintln!("WARNING: this is the swap secret. Whoever has it can trigger the Ethereum reveal; give it only to equiv-prove and the reveal command. Pipe it, never paste it into a command line: swap-cli secret FILE | equiv-prove prove raw --secret-stdin OUT.receipt");
    }
    println!("{}", swap_cli::secret::hex32(s.bytes()));
    Ok(())
}

/// `self-test FILE`: Bob's check that client R works on this machine (review V2-10). Builds, proves and verifies an owner authorization for a
/// throwaway lock (nothing is sent, no real secret is read), and records the pass in the swap file. The engine requires the record, for the
/// owner-authorization version of the next block, before it offers `lock_eth` in a poseidon swap.
fn self_test(path: &str, flags: &HashMap<String, Vec<String>>) -> Res<()> {
    let path = PathBuf::from(path);
    let _lock = lock_swap_file(&path)?;
    let mut file = SwapFile::load(&path).map_err(|e| e.to_string())?;
    if file.role != Role::Bob || file.public.params.eth.lock_kind != LockKind::Poseidon {
        return Err("self-test is for Bob's file of a poseidon swap (--eth-lock-kind poseidon): only there does Bob depend on client R alone".into());
    }
    // The height whose owner-authorization version the proof is made for: the live tip + 1 when a node is given, else just before D
    // (where Bob's claim will be built).
    let (call_height, from) = if let Some(h) = flags.get("call-height").and_then(|v| v.first()) {
        (h.replace('_', "").parse::<u64>().map_err(|e| format!("--call-height: {e}"))?, "--call-height".to_string())
    } else if flags.contains_key("noid-rpc") {
        let net = net(flags)?;
        let ((rpc, label), _second, _notes) = chain_source(flags, "noid", &net)?;
        let obs = NoidWatcher::new(&rpc, file.public.opening_hex.clone()).observe(None).map_err(|e| format!("parano1d watcher: {e}"))?;
        (obs.tip + 1, format!("the tip of {label} + 1"))
    } else {
        (file.public.params.deadline_height.saturating_sub(1), "D - 1 (no node given)".to_string())
    };
    // REVIEW-7 R7-2: an earlier passing record is cleared and the file saved BEFORE anything is proved. The passing record is written only on
    // success, so a self-test that fails (or is interrupted) leaves no valid record: the engine would otherwise keep accepting a pass of up to
    // 24 hours ago for a client R the operator has just seen fail.
    if file.clear_client_r_selftest(now_unix()) {
        file.save(&path).map_err(|e| format!("could not clear the earlier self-test record before proving: {e}"))?;
        eprintln!("the earlier client R self-test record was cleared; a new pass must be recorded before Bob can lock");
    }
    eprintln!("client R self-test for height {call_height} ({from}): a throwaway authorization is built, proved and verified here; nothing is sent ...");
    let rec = match client_r_selftest(call_height, now_unix(), &file.public) {
        Ok(rec) => rec,
        Err(e) => {
            file.log("client_r_selftest_failed", now_unix());
            // Best effort: the record is already gone from the file; this only adds the failure to the history.
            let _ = file.save(&path);
            return Err(format!("the client R self-test FAILED, so Bob must not lock (no record is kept): {e}"));
        }
    };
    file.record_client_r_selftest(rec.clone(), now_unix()).map_err(|e| e.to_string())?;
    file.save(&path).map_err(|e| e.to_string())?;
    print_json(&serde_json::json!({
        "client_r_selftest": "passed",
        "auth_version": rec.auth_version,
        "call_height": rec.call_height,
        "proof_ms": rec.proof_ms,
        "recorded_in": path.display().to_string(),
    }))
}

fn gates(flags: &HashMap<String, Vec<String>>) -> Res<()> {
    let d = flag_u64(flags, "d")?;
    let h_now = flag_u64(flags, "h-now")?;
    let t_now = flag_u64(flags, "t-now")?;
    let h_final = flag_u64(flags, "h-final").unwrap_or(h_now);
    let profile = parse_profile(flags)?;
    let g = profile.gates();
    let t_max = g.t_max_eth(d, h_now, t_now).map(|t| t.to_string()).unwrap_or_else(|e| e.to_string());
    let chosen = g.choose_t_reveal(d, h_now, t_now, h_final);
    let mut v = serde_json::json!({
        "D": d,
        "lock_by_full_window": g.bob_lock_by(d),
        "lock_by_min_window": g.bob_lock_by_min_window(d),
        "rhs_i1_full_window": g.rhs_i1_eth_for_window(g.w_a_s),
        "t_max": t_max,
        "t_reveal": chosen.as_ref().map(|t| t.to_string()).unwrap_or_else(|e| e.to_string()),
        "reveal_cutoff": chosen.as_ref().ok().map(|t| g.reveal_cutoff(*t)),
        "claim_target_height": d.saturating_sub(params::CLAIM_TARGET_MARGIN),
        "rotation_guard_next_call": format!("{:?}", g.rotation_guard(h_now + 1)),
        "i5": g.check_i5(h_now.min(d), d).map(|_| "ok".to_string()).unwrap_or_else(|e| e.to_string()),
    });
    if !profile.is_production() {
        // Production output is unchanged; any other profile says so and shows its D_offset.
        v["profile"] = serde_json::json!(profile.as_str());
        v["d_offset"] = serde_json::json!(g.d_offset);
    }
    println!("{}", serde_json::to_string_pretty(&v).map_err(|e| e.to_string())?);
    Ok(())
}

fn now_unix() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn net_with(curl: bool, allow: bool) -> Net {
        Net { curl, curl_path: None, timeout: Duration::from_secs(1), allow_plain_http: allow }
    }

    #[test]
    fn plain_http_leaves_the_machine_only_with_the_flag() {
        for curl in [false, true] {
            let strict = net_with(curl, false);
            for ok in ["http://127.0.0.1:9601", "http://localhost:8545/x", "http://[::1]:1", "https://node.example/KEY"] {
                assert!(check_plain_http(&strict, ok).is_ok(), "{ok}");
            }
            for bad in ["http://10.0.0.5:9601/KEY123", "http://example.org", "HTTP://Example.org:80", "http://127.0.0.1@example.org/"] {
                let err = check_plain_http(&strict, bad).unwrap_err();
                assert!(err.contains("plain HTTP to a non-loopback host can be tampered with in transit"), "{bad}: {err}");
                assert!(err.contains("use https:// with --transport curl, or --allow-plain-http"), "{err}");
                assert!(!err.contains("KEY123"), "{err}");
            }
            // With the flag every http:// url passes this check.
            let lax = net_with(curl, true);
            for url in ["http://10.0.0.5:9601", "http://example.org", "http://127.0.0.1@example.org/"] {
                assert!(check_plain_http(&lax, url).is_ok(), "{url}");
            }
        }
    }

    #[test]
    fn open_url_applies_the_plain_http_rule_to_both_transports_before_any_connection() {
        // The refusal happens while the transport is built: nothing is resolved or connected here.
        for curl in [false, true] {
            let err = open_url(&net_with(curl, false), "http://10.0.0.5:9601").err().expect("refused");
            assert!(err.contains("plain HTTP to a non-loopback host"), "{err}");
            assert!(open_url(&net_with(curl, false), "http://127.0.0.1:9601").is_ok());
        }
        // https:// is for curl; the built-in client still says so.
        assert!(open_url(&net_with(true, false), "https://node.example/KEY").is_ok());
        let err = open_url(&net_with(false, false), "https://node.example").err().expect("unsupported");
        assert!(err.contains("--transport curl") && !err.contains("plain HTTP"), "{err}");
    }

    #[test]
    fn the_second_node_must_be_another_endpoint_and_a_shared_host_is_noted() {
        let v = |a: &str, b: &str| vec![a.to_string(), b.to_string()];
        // The same node under other spellings is refused, naming it without path or key.
        for (a, b) in [
            ("http://127.0.0.1:9601", "http://127.0.0.1:9601"),
            ("http://127.0.0.1:9601", " HTTP://LOCALHOST:9601/rpc "),
            ("https://rpc.example.org/v3/KEY1", "https://RPC.example.org:443/v3/KEY2"),
        ] {
            let err = check_distinct_endpoints("noid", &v(a, b), false).unwrap_err();
            assert!(err.starts_with("--noid-rpc: the second node must be a different endpoint (both are "), "{err}");
            assert!(!err.contains("KEY"), "{err}");
        }
        let err = check_distinct_endpoints("eth", &v("https://rpc.example.org/v3/KEY1", "https://rpc.example.org/v3/KEY2"), false).unwrap_err();
        assert_eq!(err, "--eth-rpc: the second node must be a different endpoint (both are https://rpc.example.org)");
        // Not parseable and identical: still refused.
        assert!(check_distinct_endpoints("eth", &v("nonsense", " NONSENSE"), false).is_err());
        // Another port on one host passes, with a note naming the host.
        let note = check_distinct_endpoints("noid", &v("http://127.0.0.1:9601", "http://localhost:9602"), false).unwrap().unwrap();
        assert!(note.contains("both nodes are on the host localhost") && note.contains("shares its network view"), "{note}");
        // Two hosts, or only one url: nothing to say.
        assert_eq!(check_distinct_endpoints("noid", &v("https://a.example.org", "https://b.example.org"), false).unwrap(), None);
        assert_eq!(check_distinct_endpoints("noid", &["http://127.0.0.1:9601".to_string()], false).unwrap(), None);
        assert_eq!(check_distinct_endpoints("noid", &[], false).unwrap(), None);
    }

    #[test]
    fn a_declared_remote_second_node_changes_the_text_of_the_note_and_nothing_else() {
        let v = |a: &str, b: &str| vec![a.to_string(), b.to_string()];
        // Through a tunnel the second node appears on localhost: the note says what was declared, what cannot be verified, and what still holds.
        let note = check_distinct_endpoints("noid", &v("http://127.0.0.1:9601", "http://127.0.0.1:9602"), true).unwrap().unwrap();
        assert!(note.contains("--noid-rpc2-is-remote declares") && note.contains("another machine") && note.contains("local port"), "{note}");
        assert!(note.contains("cannot verify") && note.contains("share one network and one upstream connection"), "{note}");
        assert!(!note.contains("shares its network view"), "{note}");
        let eth = check_distinct_endpoints("eth", &v("http://127.0.0.1:8545", "http://localhost:8546/key"), true).unwrap().unwrap();
        assert!(eth.starts_with("--eth-rpc: ") && eth.contains("--eth-rpc2-is-remote declares") && !eth.contains("key"), "{eth}");
        // Without the flag the old note is unchanged.
        let old = check_distinct_endpoints("noid", &v("http://127.0.0.1:9601", "http://127.0.0.1:9602"), false).unwrap().unwrap();
        assert!(old.contains("shares its network view") && !old.contains("declares"), "{old}");
        // Nothing is relaxed: identical endpoints are refused whatever is declared, and two hosts still have nothing to say.
        assert!(check_distinct_endpoints("noid", &v("http://127.0.0.1:9601", "http://localhost:9601"), true).is_err());
        assert_eq!(check_distinct_endpoints("noid", &v("https://a.example.org", "https://b.example.org"), true).unwrap(), None);
        assert_eq!(check_distinct_endpoints("noid", &["http://127.0.0.1:9601".to_string()], true).unwrap(), None);
    }

    #[test]
    fn the_remote_declarations_are_boolean_flags_and_the_label_has_no_credentials() {
        let args: Vec<String> = ["--noid-rpc2-is-remote", "file.json", "--eth-rpc2-is-remote", "--eth-rpc", "A"].iter().map(|s| s.to_string()).collect();
        let (positional, flags) = parse_flags(&args);
        assert_eq!(positional, vec!["file.json".to_string()]);
        assert!(flags.contains_key("noid-rpc2-is-remote") && flags.contains_key("eth-rpc2-is-remote"));
        assert_eq!(redact("https://user:pw@rpc.example.org:8545/v3/KEY?x=1"), "https://rpc.example.org:8545");
        assert_eq!(redact("http://127.0.0.1:9602"), "http://127.0.0.1:9602");
        assert_eq!(redact("https://rpc.example.org:8545#KEY"), "https://rpc.example.org:8545");
    }

    #[test]
    fn the_second_fixture_must_be_another_file() {
        let dir = std::env::temp_dir().join(format!("swap-cli-g3-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let (a, b) = (dir.join("a.json"), dir.join("b.json"));
        std::fs::write(&a, "{}").unwrap();
        std::fs::write(&b, "{}").unwrap();
        let s = |p: &Path| p.to_string_lossy().to_string();
        let via_dots = format!("{}/./a.json", s(&dir));
        let err = check_distinct_fixtures("noid", &[s(&a), s(&a)]).unwrap_err();
        assert!(err.starts_with("--noid-fixture: the second fixture must be a different file (both are "), "{err}");
        assert!(check_distinct_fixtures("eth", &[s(&a), via_dots]).is_err());
        assert!(check_distinct_fixtures("eth", &[s(&a), s(&b)]).is_ok());
        assert!(check_distinct_fixtures("eth", &[s(&a)]).is_ok());
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn the_new_boolean_flags_take_no_value() {
        let args: Vec<String> = ["--single-node-ok", "file.json", "--allow-plain-http", "--noid-rpc", "A", "--noid-rpc", "B"].iter().map(|s| s.to_string()).collect();
        let (positional, flags) = parse_flags(&args);
        assert_eq!(positional, vec!["file.json".to_string()]);
        assert!(flags.contains_key("single-node-ok") && flags.contains_key("allow-plain-http"));
        assert_eq!(flags["noid-rpc"], vec!["A".to_string(), "B".to_string()]);
    }
}
