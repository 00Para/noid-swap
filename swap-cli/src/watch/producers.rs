//! Producer reader (threat T21, `docs/bob-concentration-gate.md` section 3): who produced the recent Parano1d blocks, read from the
//! node's OWN headers, never from a third party.
//!
//! Plain words. Every Parano1d block header names the address that received the block reward (`miner`). If one address produced
//! most of the recent blocks, a swap in which Bob locks Ethereum second is exposed to that miner (`docs/miner-concentration.md`).
//! Before Bob locks, this module reads the headers of the last 2,880 blocks (about 24 hours), keeps them in a small cache file
//! beside the swap file so that the next tick reads only the new ones, and reduces them to counts: how many blocks the largest
//! producer made, how many the two largest made together, in a long and a short window. The engine decides what the counts mean
//! (`crate::producer_gate`); this module only reads and counts.
//!
//! Three rules shape the code:
//!
//! - **The address never leaves the cache file.** The cache holds the miner address of every block (it has to, to count), and that
//!   file stays on this machine. Everything that is printed or put in the observation shows a producer as the first 8 hex characters
//!   of the SHA-256 of its address ([`producer_id`]).
//! - **A tick never waits long.** A read stops after one wall-clock budget (40 s by default, the second node's header included) and
//!   goes on at the next tick; a call already under way when the budget ends can overrun it by at most [`PER_CALL_TIMEOUT`]. With a
//!   warm cache a tick reads one to three headers.
//! - **Anything doubtful is an error, never a pass.** A call that failed, a reply that does not decode, a missing height, a header
//!   that does not link to the one below it (its `prev_hash` is not the hash of the header below), a chain shorter than the window:
//!   each leaves the summary incomplete with the reason, and the engine fails closed on that.
//!
//! The cache is one line per height: `height hash prev_hash timestamp miner`, separated by single spaces, ascending and gap-free.
//! A cache that does not parse, has a gap, or does not start where it should is discarded and the window is read again. Each tick
//! first re-reads the header at the cache's highest height: if its hash is not the cached one a reorg happened, and the reader walks
//! down (eight heights at a time, at most 64 deep) to the highest height whose hash still matches, drops everything above it and
//! reads on from there. The depth of that mismatch is kept in the summary (log only; no decision reads it).
//!
//! Batching: headers are asked for in JSON-RPC batches of up to [`BATCH_SIZE`] calls. If the node's answer is not an array of the
//! right length (or the transport fails on the batch), the reader asks for the same heights with single calls.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

use super::{JsonRpc, RpcError};

/// Headers per JSON-RPC batch.
pub const BATCH_SIZE: usize = 250;
/// Headers per batch while walking down below a hash mismatch.
pub const WALK_STEP: usize = 8;
/// How far below the cache's top the reader looks for a header that still matches after a reorg.
pub const MAX_MISMATCH_DEPTH: u64 = 64;
/// Heights kept in the cache below the window's first height.
pub const KEEP_BELOW_WINDOW: u64 = 64;
/// Default wall-clock budget of one tick's reading (the first node and the second node's one header together).
pub const DEFAULT_BUDGET: Duration = Duration::from_secs(40);
/// The longest a single call may take (the transport timeout of the reader). A call that starts just before the budget ends can overrun it by this much.
pub const PER_CALL_TIMEOUT: Duration = Duration::from_secs(10);
/// Time kept back from the budget for the second node's one header when a second node is configured.
pub const SECOND_RESERVE: Duration = Duration::from_secs(5);
/// The second node is asked for the header this many blocks below the lower of the two tips (so that a block still being settled does not
/// make two honest nodes disagree).
pub const SECOND_ANCHOR_BACK: u64 = 3;

/// The first 8 hex characters of the SHA-256 of a miner address: how a producer is shown. Never the address itself.
pub fn producer_id(miner: &str) -> String {
    hex::encode(Sha256::digest(miner.as_bytes()))[..8].to_string()
}

/// The first 8 characters of a block hash, for a note.
pub fn short_hash(hash: &str) -> String {
    hash.chars().take(8).collect()
}

/// What the window counts say about one window of recent blocks.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct WindowShare {
    /// Window size in blocks.
    pub n: u64,
    /// Blocks produced by the largest producer.
    pub largest: u64,
    /// That producer as [`producer_id`].
    pub largest_id: String,
    /// Blocks produced by the two largest producers together (the largest alone when there is only one).
    pub top_two: u64,
    /// Number of distinct producers in the window.
    pub distinct: u64,
}

/// The cross-check of the headers against the second Parano1d node.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "state", rename_all = "snake_case")]
pub enum SecondCheck {
    /// No second node was configured (F5 decides whether that is allowed).
    #[default]
    NotConfigured,
    /// The second node holds the same block at `height` (equal hashes: the same chain below it, as far as a header's hash covers its miner;
    /// the reader does not recompute a hash, so this does not catch a node that reports a true hash beside a false producer).
    Agrees { height: u64 },
    /// The two nodes name different blocks at `height` (8-hex hashes).
    Differs { height: u64, first: String, second: String },
    /// A second node is configured and could not be read, or the check could not be made.
    Unreadable { reason: String },
}

/// One tick's reading, reduced to what the engine needs. Holds no address.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ProducerSummary {
    /// Where the headers were read, `scheme://host:port` (display only).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source: Option<String>,
    /// The node tip the read was aimed at (the observation's tip).
    pub tip: u64,
    /// The highest height the reader holds contiguously (0 when none).
    pub header_tip: u64,
    /// Unix seconds when the read finished.
    #[serde(default)]
    pub read_at: Option<u64>,
    /// The windows this summary was computed for (blocks).
    pub window_long: u64,
    pub window_short: u64,
    /// Headers of the long window held so far.
    pub have: u64,
    /// The counts; `None` while the window is incomplete.
    #[serde(default)]
    pub long: Option<WindowShare>,
    #[serde(default)]
    pub short: Option<WindowShare>,
    /// Both windows are complete and end at the tip.
    pub complete: bool,
    /// Headers fetched from the node in this tick.
    #[serde(default)]
    pub headers_read: u64,
    #[serde(default)]
    pub second: SecondCheck,
    /// Log only: how deep below the cache's top the hashes stopped matching after a reorg (65 = nothing matched within 64).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mismatch_depth: Option<u64>,
    /// Why the reading is not complete, when something went wrong (a budget that ran out is not an error).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

impl ProducerSummary {
    /// An empty, incomplete summary with a reason.
    pub fn failed(tip: u64, window_long: u64, window_short: u64, now: u64, why: impl Into<String>) -> Self {
        Self {
            source: None,
            tip,
            header_tip: 0,
            read_at: Some(now),
            window_long,
            window_short,
            have: 0,
            long: None,
            short: None,
            complete: false,
            headers_read: 0,
            second: SecondCheck::NotConfigured,
            mismatch_depth: None,
            error: Some(why.into()),
        }
    }
}

impl ProducerSummary {
    /// A complete summary of SYNTHETIC producers (labels `synthetic-miner-A`, `-B`, ...), for tests and recorded fixtures: the largest
    /// producer made `largest_permille` thousandths of each window (rounded down), the two largest together `top_two_permille`, over
    /// eight distinct producers. Read at `now`, ending at `tip`, no second node. Never a real address.
    pub fn synthetic(tip: u64, window_long: u64, window_short: u64, now: u64, largest_permille: u64, top_two_permille: u64) -> Self {
        let share = |n: u64| WindowShare {
            n,
            largest: n * largest_permille / 1000,
            largest_id: producer_id("synthetic-miner-A"),
            top_two: n * top_two_permille / 1000,
            distinct: 8,
        };
        Self {
            source: None,
            tip,
            header_tip: tip,
            read_at: Some(now),
            window_long,
            window_short,
            have: window_long,
            long: Some(share(window_long)),
            short: Some(share(window_short)),
            complete: true,
            headers_read: 0,
            second: SecondCheck::NotConfigured,
            mismatch_depth: None,
            error: None,
        }
    }
}

/// One block header as the cache holds it.
#[derive(Clone, PartialEq, Eq)]
pub struct Header {
    pub height: u64,
    pub hash: String,
    pub prev: String,
    pub time: u64,
    /// The miner address. Stays in the cache file; never printed.
    pub miner: String,
}

// `Debug` shows the producer as its short id, never the address, so no `{:?}` of a header (or of a panic message holding one) can print it.
impl std::fmt::Debug for Header {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Header")
            .field("height", &self.height)
            .field("hash", &short_hash(&self.hash))
            .field("time", &self.time)
            .field("producer", &producer_id(&self.miner))
            .finish()
    }
}

/// The cache path beside a swap file: `<swap file>.producers`.
pub fn cache_path_for(swap_file: &Path) -> PathBuf {
    let mut name = swap_file.as_os_str().to_os_string();
    name.push(".producers");
    PathBuf::from(name)
}

fn token_ok(t: &str) -> bool {
    !t.is_empty() && t.len() <= 200 && t.bytes().all(|b| b.is_ascii_graphic())
}

/// Parse a cache file. An error means "discard it": a bad line, a gap, or heights that are not ascending.
pub fn parse_cache(text: &str) -> Result<Vec<Header>, String> {
    let mut out: Vec<Header> = Vec::new();
    for (i, line) in text.lines().enumerate() {
        let parts: Vec<&str> = line.split(' ').collect();
        if parts.len() != 5 || !parts.iter().all(|p| token_ok(p)) {
            return Err(format!("line {}: not five fields", i + 1));
        }
        let height: u64 = parts[0].parse().map_err(|_| format!("line {}: bad height", i + 1))?;
        let time: u64 = parts[3].parse().map_err(|_| format!("line {}: bad timestamp", i + 1))?;
        if let Some(prev) = out.last() {
            if height != prev.height + 1 {
                return Err(format!("line {}: height {} does not follow {}", i + 1, height, prev.height));
            }
            if parts[2] != prev.hash {
                return Err(format!("line {}: does not link to the line above", i + 1));
            }
        }
        out.push(Header { height, hash: parts[1].to_string(), prev: parts[2].to_string(), time, miner: parts[4].to_string() });
    }
    Ok(out)
}

fn render_cache(entries: &[Header]) -> String {
    let mut s = String::with_capacity(entries.len() * 200);
    for h in entries {
        s.push_str(&format!("{} {} {} {} {}\n", h.height, h.hash, h.prev, h.time, h.miner));
    }
    s
}

/// Load the cache; a missing file is an empty cache, an unreadable or bad one is an error (the caller discards it and says so).
pub fn load_cache(path: &Path) -> Result<Vec<Header>, String> {
    match std::fs::read_to_string(path) {
        Ok(text) => parse_cache(&text),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Vec::new()),
        Err(e) => Err(format!("cannot read {}: {e}", path.display())),
    }
}

/// Write the cache atomically (a temp file beside it, then a rename), readable by the owner only.
pub fn save_cache(path: &Path, entries: &[Header]) -> Result<(), String> {
    use std::io::Write;
    let mut tmp = path.as_os_str().to_os_string();
    tmp.push(".tmp");
    let tmp = PathBuf::from(tmp);
    let mut opts = std::fs::OpenOptions::new();
    opts.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        opts.mode(0o600);
    }
    let mut f = opts.open(&tmp).map_err(|e| format!("cannot write {}: {e}", tmp.display()))?;
    f.write_all(render_cache(entries).as_bytes()).map_err(|e| format!("cannot write {}: {e}", tmp.display()))?;
    drop(f);
    std::fs::rename(&tmp, path).map_err(|e| format!("cannot replace {}: {e}", path.display()))
}

/// Counts over the headers whose heights are in `lo..=hi`. `None` when a height is missing.
fn window_counts(entries: &[Header], lo: u64, hi: u64) -> Option<WindowShare> {
    let first = entries.first()?.height;
    if lo < first || hi < lo || entries.last()?.height < hi {
        return None;
    }
    let slice = &entries[(lo - first) as usize..=(hi - first) as usize];
    let mut counts: HashMap<&str, u64> = HashMap::new();
    for h in slice {
        *counts.entry(h.miner.as_str()).or_default() += 1;
    }
    let mut ranked: Vec<(u64, &str)> = counts.into_iter().map(|(m, c)| (c, m)).collect();
    // Deterministic: most blocks first, ties by address.
    ranked.sort_by(|a, b| b.0.cmp(&a.0).then(a.1.cmp(b.1)));
    let (largest, largest_miner) = *ranked.first()?;
    let top_two = largest + ranked.get(1).map_or(0, |r| r.0);
    Some(WindowShare { n: hi - lo + 1, largest, largest_id: producer_id(largest_miner), top_two, distinct: ranked.len() as u64 })
}

/// Settings of one reading.
pub struct ReaderConfig {
    pub window_long: u64,
    pub window_short: u64,
    /// Wall-clock budget of this tick's reading.
    pub budget: Duration,
    /// Headers per batch ([`BATCH_SIZE`]).
    pub batch: usize,
    /// Clock for `read_at` (Unix seconds).
    pub clock: fn() -> u64,
    /// Display label of the node read (`scheme://host:port`).
    pub source: Option<String>,
}

impl ReaderConfig {
    pub fn new(window_long: u64, window_short: u64) -> Self {
        Self { window_long, window_short, budget: DEFAULT_BUDGET, batch: BATCH_SIZE, clock: super::system_now, source: None }
    }
}

#[derive(Deserialize)]
struct HeaderReply {
    height: u64,
    hash: String,
    prev_hash: String,
    timestamp: u64,
    miner: String,
}

fn decode_header(want: u64, answer: Result<Value, RpcError>) -> Result<Header, String> {
    let fail = |why: String| format!("paranoid_getBlockHeader at height {want} failed: {why}");
    let v = answer.map_err(|e| fail(e.to_string()))?;
    if v.is_null() {
        return Err(fail("the node has no header at this height".into()));
    }
    let r: HeaderReply = serde_json::from_value(v).map_err(|e| fail(format!("decode: {e}")))?;
    if r.height != want {
        return Err(fail(format!("the node answered for height {}", r.height)));
    }
    for t in [&r.hash, &r.prev_hash, &r.miner] {
        if !token_ok(t) {
            return Err(fail("a field is empty or not plain text".into()));
        }
    }
    Ok(Header { height: want, hash: r.hash.to_ascii_lowercase(), prev: r.prev_hash.to_ascii_lowercase(), time: r.timestamp, miner: r.miner })
}

enum Stop {
    /// The wall-clock budget ran out; what was read before it is kept.
    Budget,
    Error(String),
}

struct Fetcher<'a> {
    rpc: &'a dyn JsonRpc,
    deadline: Instant,
    /// Headers fetched in this reading (counted when decoded).
    fetched: u64,
}

impl Fetcher<'_> {
    fn out_of_time(&self) -> bool {
        Instant::now() >= self.deadline
    }

    /// The headers at `heights`, in order, stopping at the first problem. Tries one batch; when the batch is refused (the answer is not
    /// an array of the right length, or the transport fails) or an item of it failed, the heights concerned are asked again singly.
    fn fetch(&mut self, heights: &[u64]) -> (Vec<Header>, Option<Stop>) {
        let mut out: Vec<Header> = Vec::with_capacity(heights.len());
        if heights.is_empty() {
            return (out, None);
        }
        if self.out_of_time() {
            return (out, Some(Stop::Budget));
        }
        let params: Vec<Value> = heights.iter().map(|h| json!([h])).collect();
        let batch: Option<Vec<Result<Value, RpcError>>> = if heights.len() > 1 {
            match self.rpc.call_batch("paranoid_getBlockHeader", &params) {
                Ok(a) if a.len() == heights.len() => Some(a),
                _ => None,
            }
        } else {
            None
        };
        for (i, h) in heights.iter().enumerate() {
            let answer = match &batch {
                Some(a) if a[i].is_ok() => a[i].clone(),
                _ => {
                    if self.out_of_time() {
                        return (out, Some(Stop::Budget));
                    }
                    self.rpc.call("paranoid_getBlockHeader", json!([h]))
                }
            };
            match decode_header(*h, answer) {
                Ok(header) => {
                    self.fetched += 1;
                    out.push(header);
                }
                Err(e) => return (out, Some(Stop::Error(e))),
            }
        }
        (out, None)
    }
}

/// Read (or finish reading) the producers of the last `window_long` blocks ending at `tip`, and the cross-check against `second`.
///
/// `second` is the second node's transport with its tip (`None` = no second node configured). The cache at `cache_path` is read,
/// repaired after a reorg, extended and written back. Never panics and never returns an error: every problem is in the summary.
pub fn read_producers(
    first: &dyn JsonRpc,
    second: Option<(&dyn JsonRpc, Option<u64>)>,
    cache_path: &Path,
    tip: u64,
    cfg: &ReaderConfig,
) -> ProducerSummary {
    let mut summary = ProducerSummary::failed(tip, cfg.window_long, cfg.window_short, 0, "");
    summary.error = None;
    summary.source = cfg.source.clone();
    let finish = |mut s: ProducerSummary| {
        s.read_at = Some((cfg.clock)());
        s
    };
    if cfg.window_long == 0 || cfg.window_short == 0 || cfg.window_short > cfg.window_long {
        summary.error = Some("the producer windows are not set sensibly".into());
        return finish(summary);
    }
    if tip + 1 < cfg.window_long {
        summary.error = Some(format!("the chain (tip {tip}) is shorter than the long window of {} blocks", cfg.window_long));
        return finish(summary);
    }
    let lo = tip + 1 - cfg.window_long;
    // One deadline for the whole reading. With a second node configured the first node stops a little earlier, so that its one header still fits.
    let deadline = Instant::now() + cfg.budget;
    let reserve = if second.is_some() { SECOND_RESERVE.min(cfg.budget / 4) } else { Duration::ZERO };
    let mut fetcher = Fetcher { rpc: first, deadline: deadline - reserve, fetched: 0 };

    // 1. The cache: loaded, trimmed to the tip, and kept only if it can still be part of this window.
    let mut entries = match load_cache(cache_path) {
        Ok(e) => e,
        Err(_) => Vec::new(), // a broken cache is discarded; the window is read again
    };
    entries.retain(|h| h.height <= tip);
    if let (Some(a), Some(b)) = (entries.first(), entries.last()) {
        if a.height > lo || b.height + 1 < lo {
            entries.clear();
        }
    }

    // 2. Is the cache's top still the node's block at that height? If not, walk down to the highest height that still matches.
    // `top_verified`: the cache can be trusted as far as it goes (empty, or its top matched, or the repair after a reorg finished). A budget
    // that ran out before that leaves it false, and a window counted from an unchecked cache is never reported as complete.
    let mut stop: Option<Stop> = None;
    let mut top_verified = entries.is_empty();
    if let Some(top) = entries.last().cloned() {
        let (got, st) = fetcher.fetch(&[top.height]);
        match (got.first(), st) {
            (Some(h), None) if h.hash == top.hash => top_verified = true,
            (Some(_), None) => {
                let mut matched: Option<u64> = None;
                let mut h = top.height;
                'walk: while top.height - h < MAX_MISMATCH_DEPTH && h > 0 {
                    let heights: Vec<u64> = (0..WALK_STEP as u64).map_while(|i| h.checked_sub(1 + i)).take_while(|x| top.height - x <= MAX_MISMATCH_DEPTH).collect();
                    if heights.is_empty() {
                        break;
                    }
                    let (got, st) = fetcher.fetch(&heights);
                    for g in &got {
                        let cached = entries.iter().find(|e| e.height == g.height);
                        if cached.is_some_and(|c| c.hash == g.hash) {
                            matched = Some(g.height);
                            break 'walk;
                        }
                    }
                    if let Some(s) = st {
                        stop = Some(s);
                        break;
                    }
                    h = *heights.last().expect("non-empty");
                }
                if stop.is_none() {
                    match matched {
                        Some(m) => {
                            summary.mismatch_depth = Some(top.height - m);
                            entries.retain(|e| e.height <= m);
                        }
                        None => {
                            summary.mismatch_depth = Some(MAX_MISMATCH_DEPTH + 1);
                            entries.clear();
                        }
                    }
                    top_verified = true;
                }
            }
            (_, st) => stop = st.or(Some(Stop::Error("the cache top could not be checked".into()))),
        }
    }
    if let Some(Stop::Error(e)) = &stop {
        summary.error = Some(e.clone());
    }

    // 3. Read what is missing, oldest first, one batch at a time, until the tip or the budget.
    if stop.is_none() {
        let mut next = entries.last().map_or(lo, |h| h.height + 1);
        while next <= tip {
            let end = tip.min(next + cfg.batch as u64 - 1);
            let heights: Vec<u64> = (next..=end).collect();
            let (got, st) = fetcher.fetch(&heights);
            // Link check: every header names the hash of the one below it. A break discards this chunk.
            let mut linked: Vec<Header> = Vec::with_capacity(got.len());
            let mut broken: Option<u64> = None;
            for g in got {
                let below = linked.last().or(entries.last()).map(|b| b.hash.clone());
                if below.is_some_and(|b| b != g.prev) {
                    broken = Some(g.height);
                    break;
                }
                linked.push(g);
            }
            if let Some(h) = broken {
                summary.error = Some(format!(
                    "the header at height {h} does not link to the header below it (a reorg during the read; the next tick reads again)"
                ));
                break;
            }
            entries.extend(linked);
            match st {
                None => {}
                Some(Stop::Budget) => {
                    stop = Some(Stop::Budget);
                    break;
                }
                Some(Stop::Error(e)) => {
                    summary.error = Some(e);
                    break;
                }
            }
            next = end + 1;
        }
    }
    summary.headers_read = fetcher.fetched;

    // 4. Keep the cache: from a little below the window up.
    let keep_from = lo.saturating_sub(KEEP_BELOW_WINDOW);
    entries.retain(|h| h.height >= keep_from);
    // A cache that cannot be written costs only time (the next tick reads again), unless the reading is not finished: then it never will be.
    let save_error = save_cache(cache_path, &entries).err();

    // 5. Counts.
    summary.header_tip = entries.last().map_or(0, |h| h.height);
    let contiguous_from_lo = entries.first().is_some_and(|h| h.height <= lo);
    summary.have = entries.last().map_or(0, |last| if contiguous_from_lo { (last.height + 1).saturating_sub(lo) } else { 0 }).min(cfg.window_long);
    if top_verified && contiguous_from_lo && summary.header_tip == tip && summary.error.is_none() {
        summary.long = window_counts(&entries, lo, tip);
        summary.short = window_counts(&entries, tip + 1 - cfg.window_short, tip);
        summary.complete = summary.long.is_some() && summary.short.is_some();
    }
    if !summary.complete && summary.error.is_none() && !matches!(stop, Some(Stop::Budget)) {
        if let Some(e) = save_error {
            summary.error = Some(format!("the producer cache could not be written and the read is not finished ({e})"));
        }
    }

    // 6. The second node: the same block at the anchor height means the same chain below it, producers included.
    if let Some((rpc2, tip2)) = second {
        summary.second = if !summary.complete {
            SecondCheck::Unreadable { reason: "not checked: the first node's headers are not complete".into() }
        } else if let Some(tip2) = tip2 {
            let anchor = tip.min(tip2).saturating_sub(SECOND_ANCHOR_BACK);
            match entries.iter().find(|h| h.height == anchor) {
                None => SecondCheck::Unreadable { reason: format!("the anchor height {anchor} is not in the first node's headers") },
                Some(mine) => {
                    let mut f2 = Fetcher { rpc: rpc2, deadline, fetched: 0 };
                    match f2.fetch(&[anchor]) {
                        (g, None) if g.len() == 1 => {
                            if g[0].hash == mine.hash {
                                SecondCheck::Agrees { height: anchor }
                            } else {
                                SecondCheck::Differs { height: anchor, first: short_hash(&mine.hash), second: short_hash(&g[0].hash) }
                            }
                        }
                        (_, Some(Stop::Error(e))) => SecondCheck::Unreadable { reason: e },
                        _ => SecondCheck::Unreadable { reason: "the second node did not answer in time".into() },
                    }
                }
            }
        } else {
            SecondCheck::Unreadable { reason: "the second node's tip is unknown".into() }
        };
    }
    finish(summary)
}
