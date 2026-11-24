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
//! - **A tick never waits long.** A read stops after one wall-clock budget (40 s by default, the second node's headers included) and
//!   goes on at the next tick; a call already under way when the budget ends can overrun it by at most [`PER_CALL_TIMEOUT`]. The second node
//!   is asked for the anchor block and for [`SECOND_SAMPLE_COUNT`] sampled blocks, and compared on hash and producer. With a
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
/// Default wall-clock budget of one tick's reading (the first node and the second node's headers together).
pub const DEFAULT_BUDGET: Duration = Duration::from_secs(40);
/// The longest a single call may take (the transport timeout of the reader). A call that starts just before the budget ends can overrun it by this much.
pub const PER_CALL_TIMEOUT: Duration = Duration::from_secs(10);
/// Time kept back from the budget for the second node's headers (the anchor block, then one batch of sampled blocks) when a second node is
/// configured. The total budget is unchanged by the sample, except for the asks that follow a difference: the second ask of the anchor after a
/// sample that showed a hash difference below the anchor, and the confirmation of a producer difference (the same height asked of the second
/// node again). Each has its own [`PER_CALL_TIMEOUT`], so a tick that saw a difference can be extended by at most two of them (a producer
/// difference at the anchor's second ask is confirmed after it).
pub const SECOND_RESERVE: Duration = Duration::from_secs(5);
/// The second node is asked for the header this many blocks below the lower of the two tips (so that a block still being settled does not
/// make two honest nodes disagree).
pub const SECOND_ANCHOR_BACK: u64 = 3;
/// After the anchor block agrees, the second node is also asked for blocks drawn afresh on every tick, from two ranges: this many distinct
/// heights from the short window's range up to the anchor and this many from the long window's range up to the anchor (a height drawn in both
/// is asked once), and their hashes and producers are compared with the first node's (`docs/bob-concentration-gate.md`, section 11 item 4).
/// Both windows count because the screen refuses on either. Not a command-line option. A lying first node that hides a producer of 52 % under
/// the 35 % limit in one window must relabel at least 17 points of that window; a draw of 32 from that range then misses every relabelled
/// block with chance 0.83^32, about 0.3 %. A range of fewer heights than this is sampled completely.
pub const SECOND_SAMPLE_COUNT: usize = 32;

/// Chooses the heights to ask the second node for: `(lo, hi, k)` gives up to `k` distinct heights in `lo..=hi`, or an error text. The reader
/// uses [`os_sample_heights`]; a test passes a seeded one.
pub type HeightSampler = Box<dyn Fn(u64, u64, usize) -> Result<Vec<u64>, String>>;

/// A uniform number in `0..n` (`n >= 1`) from `next`, without modulo bias: a draw at or above the largest multiple of `n` that fits in 64 bits
/// is thrown away. A generator that keeps returning such draws is cut off after 64 tries (chance below 2^-64 for a real one at `n <= 2^63`),
/// so that a broken source cannot hold a tick forever.
fn uniform_below(n: u64, next: &mut dyn FnMut() -> Result<u64, String>) -> Result<u64, String> {
    let limit = (u64::MAX / n) * n;
    for _ in 0..64 {
        let r = next()?;
        if r < limit {
            return Ok(r % n);
        }
    }
    Ok(next()? % n)
}

/// Up to `k` distinct heights chosen uniformly from `lo..=hi`, ascending. When the range holds `k` heights or fewer, every height once. Uses a
/// partial Fisher-Yates shuffle over the range (kept sparse, so the range is never allocated): every subset of `k` heights is equally likely.
/// `next` is the source of 64-bit random numbers.
pub fn sample_heights(lo: u64, hi: u64, k: usize, next: &mut dyn FnMut() -> Result<u64, String>) -> Result<Vec<u64>, String> {
    if hi < lo || k == 0 {
        return Ok(Vec::new());
    }
    let n = hi - lo; // the range holds n + 1 heights
    if n < k as u64 {
        return Ok((lo..=hi).collect());
    }
    let total = n.saturating_add(1);
    let mut moved: HashMap<u64, u64> = HashMap::new();
    let mut out: Vec<u64> = Vec::with_capacity(k);
    for i in 0..k as u64 {
        let j = i + uniform_below(total - i, next)?;
        let at_i = moved.get(&i).copied().unwrap_or(i);
        let at_j = moved.get(&j).copied().unwrap_or(j);
        moved.insert(j, at_i);
        out.push(lo + at_j);
    }
    out.sort_unstable();
    Ok(out)
}

/// The sampler the tool uses: [`sample_heights`] over the operating system's random generator, the source the secrets come from.
pub fn os_sample_heights(lo: u64, hi: u64, k: usize) -> Result<Vec<u64>, String> {
    let mut next = || {
        let mut b = [0u8; 8];
        getrandom::getrandom(&mut b).map_err(|e| format!("the operating system's random generator failed: {e}"))?;
        Ok(u64::from_le_bytes(b))
    };
    sample_heights(lo, hi, k, &mut next)
}

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
    /// The second node holds the same block at the anchor `height` (equal hashes: the same chain below it, as far as a header's hash covers its
    /// miner) and names the same producer for it and for `sampled` heights drawn on this tick from the short and the long window (equal hashes
    /// too). `sampled` counts DISTINCT heights compared besides the anchor: 64 when the two draws of 32 do not overlap, fewer when a height was
    /// drawn in both or a range holds fewer than 32 heights. The reader does not recompute a hash, and a sample is not the whole window: see
    /// `docs/bob-concentration-gate.md`, section 2. The second-check summary is built afresh on every tick and is not stored in the swap file
    /// or the cache; `sampled` is 0 only in an older JSON output that is parsed again (`#[serde(default)]`), and the screen does not accept 0
    /// as a cross-check.
    Agrees {
        height: u64,
        #[serde(default)]
        sampled: u64,
    },
    /// The two nodes name different blocks at `height` (8-hex hashes), at the anchor or at a sampled height.
    Differs { height: u64, first: String, second: String },
    /// The two nodes hold the same block (equal hashes) at `height` but name different producers for it: one of them is misreporting. The second
    /// node was asked once more for that one height and gave the same hash and again a producer other than the first node's (a second node that
    /// takes its answer back is `Unreadable`, not this). Holds no address, only the height, so that the operator can look at both nodes.
    ProducerDiffers { height: u64 },
    /// The two nodes hold different blocks (different hashes) at the SAMPLED height `height`, which lies below the anchor block, and the second node
    /// named the same anchor block (hash and producer) before the sample and again after its answers arrived. Two honest nodes that agree on a
    /// block agree on every block below it, and an honest reorg would have moved the anchor, so this is evidence that one node misreports (a
    /// first node can give a relabelled block a made-up hash, with a matching false `prev_hash` on the block above it, because the reader
    /// recomputes no hash). Remembered like `ProducerDiffers`. A different hash AT the anchor stays a plain `Differs`. Holds no address.
    SampledDiffers { height: u64 },
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
    // A temporary name of this process: the watch loop's `tick --apply` and a read-only tick (the lock helper's check right before a send) can write
    // the cache at the same time, and one fixed name would let them interleave their bytes (review, 2026-11-10).
    let mut tmp = path.as_os_str().to_os_string();
    tmp.push(format!(".tmp.{}", std::process::id()));
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
    /// Chooses the heights the second node is asked for ([`os_sample_heights`] unless a test sets another).
    pub sampler: HeightSampler,
}

impl ReaderConfig {
    pub fn new(window_long: u64, window_short: u64) -> Self {
        Self {
            window_long,
            window_short,
            budget: DEFAULT_BUDGET,
            batch: BATCH_SIZE,
            clock: super::system_now,
            source: None,
            sampler: Box::new(os_sample_heights),
        }
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

/// The second node named another producer than the first node's entry for the block at `height`, under an equal hash. Before that is
/// remembered for good (a marker, a history entry, a screen that stays closed), the SECOND node is asked once more for that one height, with its
/// own fresh time (`now + PER_CALL_TIMEOUT`), for the reason given at the anchor's second ask in [`sample_check`]: the first node, whose calls
/// spend the reading's shared deadline, must not be able to make this ask unreadable. The answer decides:
///
/// - the same hash and a producer that is still not the first node's: [`SecondCheck::ProducerDiffers`] (remembered);
/// - the same hash and now the SAME producer as the first node's (the second node gave two different producers for one block): not remembered,
///   [`SecondCheck::Unreadable`] saying so (the screen fails closed for this tick only);
/// - another hash, an error, no answer in time or not exactly one header: `Unreadable` with its reason, never remembered.
///
/// Why the second node and not the first, and what that leaves. The first node's entry is deliberately not read again: a lying first node
/// would answer that one call truthfully and be forgotten. The node that matters for the latch is the first one (its headers are what the
/// screen counts), and an honest second node gives the same answer twice, so a lying first node is still remembered. A second node that takes
/// back its own answer is refused for the tick and not remembered. That lets a lying SECOND node avoid the latch, but a lying second node
/// beside an honest first node cannot hide anything (the counts come from the first node), and two lying nodes defeat the screen anyway. The
/// producers are compared byte for byte, as everywhere in the reader.
///
/// Cost: at most one more per-call timeout on a tick that saw a producer difference.
fn confirm_producer_differs(rpc2: &dyn JsonRpc, entries: &[Header], height: u64) -> SecondCheck {
    let unreadable = |reason: String| SecondCheck::Unreadable { reason };
    let Some(mine) = entries.iter().find(|e| e.height == height) else {
        return unreadable(format!("the height {height} is not in the first node's headers"));
    };
    let mut again = Fetcher { rpc: rpc2, deadline: Instant::now() + PER_CALL_TIMEOUT, fetched: 0 };
    match again.fetch(&[height]) {
        (g, None) if g.len() == 1 => {
            if g[0].hash != mine.hash {
                unreadable(format!(
                    "the second node gave a different block for height {height} when it was asked again to confirm a producer difference, so the difference is not confirmed"
                ))
            } else if g[0].miner == mine.miner {
                unreadable(format!(
                    "the second node gave two different answers for the producer of the block at height {height}, so the producer difference is not confirmed"
                ))
            } else {
                SecondCheck::ProducerDiffers { height }
            }
        }
        (_, None) => unreadable(format!("the second node did not return exactly one header when asked again about height {height}")),
        (_, Some(Stop::Error(e))) => unreadable(format!("the producer difference at height {height} could not be confirmed: {e}")),
        (_, Some(Stop::Budget)) => unreadable(format!("the second node did not answer in time when asked again about height {height}")),
    }
}

/// The second half of the cross-check, run only after the anchor block agreed in hash and producer: two samples are drawn by `cfg.sampler`,
/// afresh on every tick, each of up to [`SECOND_SAMPLE_COUNT`] distinct heights: one from the SHORT window's range up to the anchor
/// (`short_lo..=anchor`) and one from the LONG window's range (`lo..=anchor`). Never above the anchor, where the two tips may differ; never
/// below the window. The union (a height drawn in both is asked once) goes to the second node in one batch (the fetcher falls back to single
/// calls) under the reading's own deadline, and the hash and the producer of each height are compared with the first node's entry. A
/// different hash AT the anchor is `Differs` (never remembered); the same hash with another producer is `ProducerDiffers` (remembered) once the
/// second node, asked for that one height again, still names another producer ([`confirm_producer_differs`]; if it takes its answer back, or the
/// ask fails, the result is `Unreadable` and nothing is remembered); a different
/// hash at a sampled height BELOW the anchor is `SampledDiffers` (remembered) when the second node names the same anchor block again after the
/// sampled answers, otherwise `Differs` at the anchor or `Unreadable` (ordinary); a second node that does not return every height in time,
/// or answers with an error, is `Unreadable`. If one sample shows both a producer difference and a hash difference the outcome is the remembered
/// `ProducerDiffers`, when it is confirmed; when the confirmation cannot be completed the hash difference goes on through its own anchor re-ask (`SampledDiffers` or an ordinary result), and a producer difference alone is `Unreadable`. A range of fewer heights than the count is sampled completely.
fn sample_check(f2: &mut Fetcher<'_>, entries: &[Header], lo: u64, short_lo: u64, anchor: u64, cfg: &ReaderConfig) -> SecondCheck {
    let unreadable = |reason: String| SecondCheck::Unreadable { reason };
    if anchor < short_lo {
        return unreadable(format!("the anchor height {anchor} is below the short window's first height {short_lo}"));
    }
    // The reader does not trust its sampler blindly: the right number of distinct heights, all inside the range and not above the anchor.
    let draw = |from: u64, what: &str| -> Result<Vec<u64>, String> {
        let want = (anchor - from + 1).min(SECOND_SAMPLE_COUNT as u64) as usize;
        let heights = (cfg.sampler)(from, anchor, SECOND_SAMPLE_COUNT)
            .map_err(|e| format!("no heights could be chosen for the producer cross-check ({e})"))?;
        let mut checked = heights.clone();
        checked.sort_unstable();
        checked.dedup();
        if heights.len() != want || checked.len() != want || checked.iter().any(|h| *h < from || *h > anchor) {
            return Err(format!("the height sampler returned an unusable choice of heights for the {what} window"));
        }
        Ok(heights)
    };
    let mut heights = match draw(short_lo, "short") {
        Ok(h) => h,
        Err(e) => return unreadable(e),
    };
    match draw(lo, "long") {
        Ok(h) => heights.extend(h),
        Err(e) => return unreadable(e),
    }
    heights.sort_unstable();
    heights.dedup();
    let (got, stop) = f2.fetch(&heights);
    match stop {
        Some(Stop::Error(e)) => return unreadable(e),
        Some(Stop::Budget) => return unreadable("the second node did not answer in time".into()),
        None => {}
    }
    if got.len() != heights.len() {
        return unreadable(format!("the second node returned {} of {} sampled headers", got.len(), heights.len()));
    }
    // Classify the answers. Three things can be seen: a producer difference under an equal hash (evidence by itself: equal hashes are the same
    // block), a hash difference at the anchor height itself (the second node's anchor moved since it was first asked, which an honest reorg near
    // the tip can cause: never remembered), and a hash difference at a sampled height below the anchor.
    let mut producer_differs: Option<u64> = None;
    let mut anchor_moved: Option<SecondCheck> = None;
    let mut below_differs: Option<u64> = None;
    for (h, theirs) in heights.iter().zip(&got) {
        let Some(mine) = entries.iter().find(|e| e.height == *h) else {
            return unreadable(format!("the sampled height {h} is not in the first node's headers"));
        };
        if theirs.hash != mine.hash {
            if *h == anchor {
                anchor_moved.get_or_insert(SecondCheck::Differs { height: *h, first: short_hash(&mine.hash), second: short_hash(&theirs.hash) });
            } else if below_differs.is_none() {
                below_differs = Some(*h);
            }
        } else if theirs.miner != mine.miner && producer_differs.is_none() {
            producer_differs = Some(*h);
        }
    }
    // A remembered kind never loses to an ordinary result: a producer difference under an equal hash stands whatever else was seen, once the
    // second node has been asked for that one height again and still names another producer (`confirm_producer_differs`).
    if let Some(height) = producer_differs {
        match confirm_producer_differs(f2.rpc, entries, height) {
            // A confirmation that could not be completed must not throw away a hash difference seen in the same sample: that one still goes
            // through its own anchor re-ask below (an outside read, 2026-11-10).
            SecondCheck::Unreadable { .. } if below_differs.is_some() && anchor_moved.is_none() => {}
            confirmed => return confirmed,
        }
    }
    if let Some(moved) = anchor_moved {
        return moved;
    }
    let Some(height) = below_differs else {
        return SecondCheck::Agrees { height: anchor, sampled: heights.len() as u64 };
    };
    // A different hash below the anchor is evidence of a misreporting node only if the second node still names the same anchor block now that its
    // sampled answers have arrived: honest nodes that agree on a block agree on every block below it, and an honest reorg would have moved the
    // anchor. So ask for the anchor once more, AFTER the sample. If that cannot be read in time, or the anchor changed, the result is ordinary for
    // this tick (`Unreadable` / `Differs` at the anchor), never remembered.
    //
    // Why the first node's entries below the anchor are not stale after a reorg (checked in `read_producers`): every entry in `lo..=anchor` is one
    // chain of headers each naming the hash of the one below it (checked when read, and when a cache file is parsed), and its top was fetched in
    // this tick (the cache top is read again and its hash must equal the cached one; a mismatch walks down to a matching height and drops what is
    // above it). For an honest first node, equal hashes at the top mean the same chain below it. What the cache cannot do is forget a lie: a lower
    // entry written by a source that lied earlier survives while the top hash matches. That can only make a difference show (a refusal, never a
    // wrongly allowed lock), and the entry is deliberately NOT re-read from the first node before remembering: a lying node would simply answer
    // that one call truthfully and never be remembered. (A swap that is started again after a detection has a new swap file, hence a new cache.)
    let Some(anchor_entry) = entries.iter().find(|e| e.height == anchor) else {
        return unreadable(format!("the anchor height {anchor} is not in the first node's headers"));
    };
    // This one call gets its OWN time, a fresh `now + PER_CALL_TIMEOUT`, not the reading's shared deadline. The shared deadline is spent by the
    // FIRST node too (its calls, and the walk-down of a faked reorg, take what they take), so a lying first node could otherwise time its last
    // answer so that the anchor ask and the sample batch fit and this second ask does not: a sample that hit would then be `Unreadable` (not
    // remembered) while a sample that missed is `Agrees`, and the chance would compound over the ticks again. With its own time only the second
    // node's own failure or slowness can make this ask unreadable. Cost: this call can extend a tick beyond its budget by at most one per-call
    // timeout, and only on a tick whose sample showed a hash difference below the anchor. Nothing else between "the sample answers arrived with a
    // difference" and "remembered" depends on the shared deadline: the classification above is pure, and this is the only further call. (If the
    // sample batch itself did not finish in time the tick is `Unreadable`; the first node cannot choose that AFTER seeing whether the sample hit,
    // because it never sees the sample.)
    let mut again = Fetcher { rpc: f2.rpc, deadline: Instant::now() + PER_CALL_TIMEOUT, fetched: 0 };
    match again.fetch(&[anchor]) {
        (g, None) if g.len() == 1 => {
            if g[0].hash != anchor_entry.hash {
                SecondCheck::Differs { height: anchor, first: short_hash(&anchor_entry.hash), second: short_hash(&g[0].hash) }
            } else if g[0].miner != anchor_entry.miner {
                confirm_producer_differs(f2.rpc, entries, anchor)
            } else {
                SecondCheck::SampledDiffers { height }
            }
        }
        (_, Some(Stop::Error(e))) => unreadable(e),
        _ => unreadable("the second node did not answer in time".into()),
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

    // 6. The second node: the same block at the anchor height means the same chain below it, producers included, if each node reports the real
    // hash of its header. The reader does not recompute a hash, so a first node could report true hashes beside false producers: the anchor
    // block and a fresh sample of other heights of the window are therefore compared on the producer too (`sample_check`).
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
                            if g[0].hash != mine.hash {
                                SecondCheck::Differs { height: anchor, first: short_hash(&mine.hash), second: short_hash(&g[0].hash) }
                            } else if g[0].miner != mine.miner {
                                confirm_producer_differs(rpc2, &entries, anchor)
                            } else {
                                sample_check(&mut f2, &entries, lo, tip + 1 - cfg.window_short, anchor, cfg)
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
