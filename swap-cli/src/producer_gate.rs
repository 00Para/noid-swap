//! Bob's producer-concentration screen (threat T21, `docs/bob-concentration-gate.md`): what the engine makes of a
//! `ProducerSummary` before Bob locks his Ethereum leg.
//!
//! Plain words. The watcher (`watch::producers`) counts who produced the recent blocks. This module decides what the counts mean
//! and writes the notes:
//!
//! SINCE 0.2.0 (the owner's decision) THE SHARE NEVER REFUSES. The screen measures and warns; the risk stays and is stated plainly.
//!
//! - **The share, a warning in every profile:** one address produced more than the profile's warning limit (35 % production, 28 % sepolia and
//!   rehearsal) of the last 2,880 blocks or of the last 720: a milder warning; above 50 % a loud one (no time window protects Bob from a
//!   majority miner who is Alice). The comparison is on integers, `count * 1000 > limit * window`. The lock is offered either way.
//! - **A share that cannot be read** (the summary is missing, incomplete or built for other windows, a header could not be read, the chain
//!   of headers does not link, the data is stale): reported as unknown, with a warning, never a refusal.
//! - **Hard under `production` (a lying-node check, not a share rule):** the second Parano1d node disagrees or could not be read for
//!   the cross-check, or the second node is missing.
//! - **A remembered detection, hard under `production` (lying-node check):** an earlier tick saw evidence that cannot come from two honest nodes, either two
//!   different producers named for a block with equal hashes, or a different hash at a sampled height below an anchor block that the second
//!   node named again after the sample, and wrote the marker `<swap file>.producer-differs` and, with `tick --apply`, the history entry
//!   `producer_differs_seen` (`crate::producer_marker`); while the marker exists (or cannot be read), or the history holds the entry, the screen
//!   refuses, whatever the later ticks say. Removing the marker does not reopen it: the ways on are the override flag below, or a new swap file.
//! - **Top two above 50 %: a warning in every profile**, never a refusal.
//! - Under `sepolia` and `rehearsal` the same evaluation runs and everything above is a warning; the lock is offered as before.
//! - `--accept-producer-concentration` waives the hard refusals under `production` (and nothing else): every tick that uses it
//!   prints an `OVERRIDDEN` warning, and the first one is written to the swap file's history.
//!
//! It is a screen, not a defence: it stops a swap against a producer that is visibly large and nothing else. A producer is shown
//! as 8 hex characters of the SHA-256 of its address; the address itself is never printed.

use crate::engine::{MAX_NOID_TIP_DIFF, MAX_OBSERVATION_AGE_S};
use crate::params::Gates;
use crate::producer_marker::{MarkerKind, MarkerState};
use crate::watch::producers::{ProducerSummary, SecondCheck, WindowShare};
use crate::watch::NoidObservation;

/// The command-line flag that waives the refusals under `production`.
pub const OVERRIDE_FLAG: &str = "--accept-producer-concentration";
/// History entry written once when the override waives a refusal and the lock is offered.
pub const OVERRIDE_HISTORY: &str = "producer_concentration_overridden";
/// D2 (2026-11-20): the narrow acknowledgement. Waives, under `production` only, "no second Parano1d node" for a loopback node; nothing else. Since 0.2.0 the
/// share part is a no-op (the share never refuses); the flag and its value are still accepted for compatibility with existing programs and swap files.
pub const ACK_FLAG: &str = "--acknowledge-producer-share";
/// The compiled hard maximum of the ceiling, in permille (65 %). A larger value is refused at parse time.
pub const ACK_HARD_MAX_PERMILLE: u64 = 650;
/// History entry written once when the acknowledgement is the reason a lock is offered. `live.js lock` does NOT count it as an override.
pub const ACK_HISTORY: &str = "producer_share_acknowledged";

const HEADLINE_CANNOT: &str = "producer concentration cannot be checked";
const HEADLINE_STALE: &str = "producer concentration data is stale";
const HEADLINE_DISAGREE: &str = "the two Parano1d nodes disagree about the producers";
const HEADLINE_ONE_NODE: &str = "producer check needs a second Parano1d node";
const HEADLINE_MARKER: &str = "an earlier tick saw the two Parano1d nodes name different producers for one block";
const HEADLINE_MARKER_HASH: &str = "an earlier tick saw the two Parano1d nodes hold different blocks below a block they agree on";
const HEADLINE_MARKER_UNREADABLE: &str = "the record of a producer disagreement between the two Parano1d nodes cannot be read";
const HEADLINE_MARKER_REMEMBERED: &str = "the swap file's history records a producer disagreement between the two Parano1d nodes";

/// The sentence that says what can be done after a remembered detection. There is no way to clear it for a swap file: removing the marker does not
/// reopen the screen.
fn ways_on() -> String {
    format!(
        "It cannot be cleared for this swap file. The ways on are to pass {OVERRIDE_FLAG} (printed as OVERRIDDEN on every tick and recorded in the history), or to end this swap (if no lock was sent there is nothing to refund) and start a new one with a new swap file"
    )
}

/// The result of looking at one summary.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Finding {
    /// Every check holds.
    Pass,
    /// One address is above the warning limit in at least one window. `detail` is the sentence about the shares. A warning only since 0.2.0.
    Concentrated { detail: String },
    /// The share could not be read (no headers, incomplete, stale). A warning only since 0.2.0: the lock is offered.
    Unknown { headline: &'static str, detail: String },
    /// The check could not be completed or the data is not trustworthy.
    Unverifiable { headline: &'static str, detail: String },
}

/// A finding with its notes.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Screen {
    pub finding: Finding,
    /// The positive line, when the finding is `Pass`.
    pub ok_note: Option<String>,
    /// The warning about the two largest addresses together, when they hold more than the top-two limit of a window (any profile).
    pub top_two_warning: Option<String>,
}

fn group(n: u64) -> String {
    let s = n.to_string();
    let mut out = String::new();
    for (i, c) in s.chars().enumerate() {
        if i > 0 && (s.len() - i) % 3 == 0 {
            out.push(',');
        }
        out.push(c);
    }
    out
}

/// `count / n` in percent with one decimal, rounded UP, so that the printed share is at or below a limit exactly when the integer
/// comparison passes (a share of 35.03 % prints 35.1 against a limit of 35, never 35.0).
fn pct(count: u64, n: u64) -> String {
    if n == 0 {
        return "0.0".into();
    }
    let tenths = (count.saturating_mul(1000)).div_ceil(n);
    format!("{}.{}", tenths / 10, tenths % 10)
}

/// A limit in permille as a percent: `350` is `35`, `335` is `33.5`.
fn limit_pct(permille: u64) -> String {
    if permille % 10 == 0 {
        (permille / 10).to_string()
    } else {
        format!("{}.{}", permille / 10, permille % 10)
    }
}

fn over(count: u64, n: u64, limit_permille: u64) -> bool {
    count.saturating_mul(1000) > limit_permille.saturating_mul(n)
}

fn shares_sentence(g: &Gates, long: &WindowShare, short: &WindowShare) -> String {
    let limit = limit_pct(g.producer_limit_permille);
    let a = format!("{} % of the last {} blocks (warning above {limit} %)", pct(long.largest, long.n), group(long.n));
    let b = format!("{} % of the last {} (warning above {limit} %)", pct(short.largest, short.n), group(short.n));
    let two = format!(
        "the two largest together {} % and {} % (warning above {} %)",
        pct(long.top_two, long.n),
        pct(short.top_two, short.n),
        limit_pct(g.producer_top_two_permille)
    );
    if long.largest_id == short.largest_id {
        format!("producer {} mined {a} and {b}; {two}", long.largest_id)
    } else {
        format!("producer {} mined {a} and producer {} mined {b}; {two}", long.largest_id, short.largest_id)
    }
}

/// Look at the observation's producer summary against the profile's numbers. Pure: no clock but `now`, no state.
pub fn evaluate(g: &Gates, noid: &NoidObservation, now: u64) -> Screen {
    evaluate_with(g, noid, now, ack_waives_single_node(g, noid))
}

/// Does the acknowledgement waive the missing second Parano1d node on this tick? Production only, one configured node, and that node is loopback.
pub fn ack_waives_single_node(g: &Gates, noid: &NoidObservation) -> bool {
    g.producer_gate_enforced && noid.acknowledge_producer_share.is_some() && noid.single_node_loopback
}

/// Can the share be read from this observation? `Ok` with the summary and its two windows, or `Err` with the reason it is unknown (a missing, other-window,
/// errored, incomplete or stale summary). Unknown is a warning only (0.2.0); it must never skip the lying-node checks, which `evaluate_with` runs first.
fn share_readable<'a>(
    g: &Gates,
    noid: &'a NoidObservation,
    now: u64,
) -> Result<(&'a ProducerSummary, &'a WindowShare, &'a WindowShare), (&'static str, String)> {
    let Some(s) = noid.producers.as_ref() else {
        return Err((HEADLINE_CANNOT, "no producer summary was read in this poll (the headers were not asked for, or the read did not run)".into()));
    };
    if s.window_long != g.producer_window_long || s.window_short != g.producer_window_short {
        return Err((HEADLINE_CANNOT, format!(
            "the summary was computed for windows of {} and {} blocks, the profile wants {} and {}",
            group(s.window_long),
            group(s.window_short),
            group(g.producer_window_long),
            group(g.producer_window_short)
        )));
    }
    if let Some(e) = &s.error {
        return Err((HEADLINE_CANNOT, e.clone()));
    }
    let (Some(long), Some(short)) = (&s.long, &s.short) else {
        return Err((HEADLINE_CANNOT, format!(
            "{} of {} headers read so far (the next tick reads on)",
            group(s.have),
            group(g.producer_window_long)
        )));
    };
    if !s.complete || long.n != g.producer_window_long || short.n != g.producer_window_short {
        return Err((HEADLINE_CANNOT, format!(
            "{} of {} headers read so far (the next tick reads on)",
            group(s.have),
            group(g.producer_window_long)
        )));
    }
    // Stale: the headers end too far below the node's tip, or the read is too old.
    let mut stale: Vec<String> = Vec::new();
    if noid.tip > s.header_tip + MAX_NOID_TIP_DIFF {
        stale.push(format!(
            "the headers end at height {} but the node's tip is {} (limit {MAX_NOID_TIP_DIFF} blocks behind)",
            s.header_tip, noid.tip
        ));
    }
    match s.read_at {
        None => stale.push("the time of the read is unknown".into()),
        Some(t) if t.abs_diff(now) > MAX_OBSERVATION_AGE_S => {
            stale.push(format!("read {} s ago (limit {MAX_OBSERVATION_AGE_S} s)", t.abs_diff(now)));
        }
        Some(_) => {}
    }
    if !stale.is_empty() {
        return Err((HEADLINE_STALE, stale.join("; ")));
    }
    Ok((s, long, short))
}

/// [`evaluate`], with the loopback-node waiver given. `false` shows what the screen says on its own.
fn evaluate_with(g: &Gates, noid: &NoidObservation, now: u64, waive_single_loopback: bool) -> Screen {
    let screen = |finding: Finding| Screen { finding, ok_note: None, top_two_warning: None };
    let cannot = |detail: String| screen(Finding::Unverifiable { headline: HEADLINE_CANNOT, detail });
    // Since 0.2.0 (the owner's decision): a share that cannot be read is reported as unknown with a warning, never a refusal.
    let unknown = |headline: &'static str, detail: String| screen(Finding::Unknown { headline, detail });
    // A remembered detection (`crate::producer_marker`) holds for the rest of the swap, whatever this tick's own reading says.
    match &noid.producer_marker {
        MarkerState::Absent => {}
        MarkerState::Present { height, at, kind } => {
            let (headline, seen) = match kind {
                MarkerKind::Producer => (
                    HEADLINE_MARKER,
                    format!("the two nodes named different producers for the block at height {height} although the block hashes were equal, so one of them misreports"),
                ),
                MarkerKind::Hash => (
                    HEADLINE_MARKER_HASH,
                    format!(
                        "the two nodes named different blocks (different hashes) at height {height}, below a block they had agreed on both before and after that question, which two honest nodes cannot do, so one of them misreports"
                    ),
                ),
            };
            return screen(Finding::Unverifiable {
                headline,
                detail: format!(
                    "at Unix time {at} {seen}; compare the two nodes by hand for that block. The file <swap file>{} beside the swap file records it, the tool never removes it, and with tick --apply the swap file's history records it too, which keeps this screen closed on every tick for the rest of this swap file, even if the marker file is removed or the swap file is moved. {} (the header cache <swap file>.producers may still hold what the misreporting node said)",
                    crate::producer_marker::SUFFIX,
                    ways_on()
                ),
            });
        }
        MarkerState::Unreadable { reason } => {
            return screen(Finding::Unverifiable {
                headline: HEADLINE_MARKER_UNREADABLE,
                detail: format!(
                    "{reason}; it counts as a detection (it records that two nodes once named different producers for a block with equal hashes, or held different blocks below a block they agreed on), and with tick --apply the swap file's history records it too, so removing or repairing the file does not reopen the screen. {}",
                    ways_on()
                ),
            });
        }
        MarkerState::Remembered { at } => {
            return screen(Finding::Unverifiable {
                headline: HEADLINE_MARKER_REMEMBERED,
                detail: format!(
                    "the swap file's history records, at Unix time {at}, that an earlier tick saw evidence that cannot come from two honest nodes (different producers for a block with equal hashes, or different blocks below a block they agree on); the file <swap file>{} beside the swap file is missing (it was removed, or the swap file was moved), and the history entry cannot be removed by the tool. Compare the two nodes by hand. {}",
                    crate::producer_marker::SUFFIX,
                    ways_on()
                ),
            });
        }
    }
    let readable = share_readable(g, noid, now);
    // The second Parano1d node: when one is configured it must agree on the block at the anchor height.
    // Set only when the second node was read and agreed: the over-limit note says so too.
    let mut second_agreed: Option<String> = None;
    // Without a summary the second node's cross-check cannot be read; an incomplete summary's "not checked" is part of the unknown share, not a refusal.
    let none_second = SecondCheck::NotConfigured;
    let second_ref = noid.producers.as_ref().map_or(&none_second, |s| &s.second);
    let summary_incomplete = noid.producers.as_ref().is_none_or(|s| !s.complete);
    let second_line = if noid.second_error.is_some() {
        // A configured second node that could not be read at all holds `lock_eth` through the F5 rule, with F5's own reason, whatever this screen says.
        "the second node could not be read, F5 holds the lock".to_string()
    } else if noid.second.is_some() || !matches!(second_ref, SecondCheck::NotConfigured) {
        match second_ref {
            // A record without a sample (made before the sample existed) is not a producer cross-check.
            SecondCheck::Agrees { sampled: 0, .. } => {
                return cannot("the second Parano1d node's producer cross-check recorded no sampled heights".into());
            }
            SecondCheck::Agrees { height, sampled } => {
                let clause = format!(
                    "second node holds the same block at height {height} and names the same producer for {sampled} sampled height{}",
                    if *sampled == 1 { "" } else { "s" }
                );
                // In the over-limit note the same fact is worded as a cross-check of the finding, not as a reassurance.
                second_agreed = Some(format!(
                    "the second node gives the same block at height {height} and the same producers for {sampled} sampled height{}, so this is not one node's view",
                    if *sampled == 1 { "" } else { "s" }
                ));
                clause
            }
            SecondCheck::Differs { height, first, second } => {
                return screen(Finding::Unverifiable {
                    headline: HEADLINE_DISAGREE,
                    detail: format!("the block at height {height} is {first} on the first node and {second} on the second"),
                });
            }
            SecondCheck::SampledDiffers { height } => {
                return screen(Finding::Unverifiable {
                    headline: HEADLINE_DISAGREE,
                    detail: format!(
                        "the two nodes hold different blocks (different hashes) at height {height}, below a block they agree on both before and after that question, which two honest nodes cannot do; one of them is misreporting"
                    ),
                });
            }
            SecondCheck::ProducerDiffers { height } => {
                return screen(Finding::Unverifiable {
                    headline: HEADLINE_DISAGREE,
                    detail: format!(
                        "the two nodes name different producers for the block at height {height} although the block hashes are equal; one of them is misreporting"
                    ),
                });
            }
            SecondCheck::Unreadable { .. } if summary_incomplete => "the second node's cross-check waits for complete headers".to_string(),
            SecondCheck::Unreadable { reason } => {
                return cannot(format!("the second Parano1d node could not be read for the producer cross-check ({reason})"));
            }
            SecondCheck::NotConfigured if summary_incomplete => "the second node's cross-check waits for a producer read".to_string(),
            SecondCheck::NotConfigured => {
                return cannot("a second Parano1d node is configured but the producer cross-check did not run".into());
            }
        }
    } else if waive_single_loopback {
        // D2: the person's own node on this machine is the only Parano1d node; the acknowledgement waives the second-node refusal (and nothing else).
        "single loopback node, the second-node refusal is waived by the acknowledgement".to_string()
    } else if g.producer_gate_enforced && noid.single_node_ok {
        // Production: the headers come from one node that could be lying; the cross-check against a second node is part of the check, and
        // `--single-node-ok` (which waives the F5 second-node rule) does not relax it. Only the printed concentration override does. (Without
        // `--single-node-ok` F5 itself holds the lock with its own, older reason a step later, so this screen does not speak first.)
        return screen(Finding::Unverifiable {
            headline: HEADLINE_ONE_NODE,
            detail: "this profile enforces the producer check, only one --noid-rpc was given and --single-node-ok was passed; --single-node-ok does not relax this check".into(),
        });
    } else if g.producer_gate_enforced {
        // Production without `--single-node-ok`: F5 holds the lock a step later; say that this check needs the second node as well.
        "single node, the producer cross-check is not possible (F5 holds the lock; under production this check needs the second node too, whatever --single-node-ok says)".to_string()
    } else {
        "single node, the producer cross-check is not possible".to_string()
    };
    // The lying-node checks above are done; only now does an unreadable share count (as a warning, never a refusal).
    let (s, long, short) = match readable {
        Ok(x) => x,
        Err((headline, detail)) => return unknown(headline, detail),
    };
    let mut result = screen(Finding::Pass);
    // Top two: a warning only, in every profile.
    if over(long.top_two, long.n, g.producer_top_two_permille) || over(short.top_two, short.n, g.producer_top_two_permille) {
        result.top_two_warning = Some(format!(
            "WARNING (T21): the two largest producers together hold {} % of the last {} blocks and {} % of the last {} (warning above {} %); two addresses can be one party. This is a warning only: the lock is not refused for it",
            pct(long.top_two, long.n),
            group(long.n),
            pct(short.top_two, short.n),
            group(short.n),
            limit_pct(g.producer_top_two_permille)
        ));
    }
    // R1.
    if over(long.largest, long.n, g.producer_limit_permille) || over(short.largest, short.n, g.producer_limit_permille) {
        let shares = shares_sentence(g, long, short);
        let detail = match second_agreed {
            Some(clause) => format!("{shares}; {clause}"),
            None => shares,
        };
        result.finding = Finding::Concentrated { detail };
        return result;
    }
    let age = s.read_at.map_or_else(String::new, |t| format!(", read {} s ago", now.saturating_sub(t)));
    let from = s.source.as_ref().map_or_else(String::new, |l| format!(" from {l}"));
    result.ok_note = Some(format!(
        "producer concentration ok (T21 screen, not a defence): largest producer {} % of the last {} blocks and {} % of the last {} (warning above {} %); two largest together {} % and {} % (warning above {} %); headers to height {}{age}{from}; {second_line}",
        pct(long.largest, long.n),
        group(long.n),
        pct(short.largest, short.n),
        group(short.n),
        limit_pct(g.producer_limit_permille),
        pct(long.top_two, long.n),
        pct(short.top_two, short.n),
        limit_pct(g.producer_top_two_permille),
        s.header_tip,
    ));
    result
}

/// What the screen means for `lock_eth`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LockGate {
    /// `Some(reason)`: `lock_eth` is not offered (the reason is also the ALARM note). Never set for the share (since 0.2.0).
    pub wait: Option<String>,
}

const RISK_SENTENCE: &str = "A miner who is Alice can keep Bob's claim from becoming final until D and take both legs. Above half of the blocks no time window protects Bob. This is a screen, not a defence";

/// The share, plainly: the warning for one reading of the summary, or `None` when the share is known and at or under the warning limit.
/// Above 50 % in either window the loud one; above the profile's limit the milder one; unreadable: the unknown one.
pub fn share_warning(g: &Gates, noid: &NoidObservation, unknown: bool) -> Option<String> {
    let measured_now = if unknown { None } else { measured(noid) };
    let Some((l, sh, ln, sn)) = measured_now else {
        return Some("WARNING (T21): the share of the largest Parano1d producer cannot be read now (unknown). A miner who is Alice can take both legs; above half of the blocks no time window protects Bob. The lock is not refused for this".into());
    };
    let top = l.max(sh);
    let both = format!("{} % of the last {} blocks and {} % of the last {}", pct_of(l), group(ln), pct_of(sh), group(sn));
    if top > 500 {
        Some(format!(
            "WARNING (T21): one producer mined {both}. That is more than half: a miner who is Alice can take both legs, and above half of the blocks no time window protects Bob (his ETH can be lost). This is a warning only: the lock is offered and the risk is yours"
        ))
    } else if top > g.producer_limit_permille {
        Some(format!(
            "WARNING (T21): one producer mined {both} (warning above {} %). A miner who is Alice has a better chance of taking both legs. This is a warning only: the lock is offered",
            limit_pct(g.producer_limit_permille)
        ))
    } else {
        None
    }
}

/// A share in permille (already rounded up) as a percent with one decimal.
fn pct_of(permille: u64) -> String {
    format!("{}.{}", permille / 10, permille % 10)
}

/// Is this finding one of the soft ones (a share finding that only warns, in every profile)?
fn is_soft(f: &Finding) -> bool {
    matches!(f, Finding::Pass | Finding::Concentrated { .. } | Finding::Unknown { .. })
}

/// The notes and the decision at the point where `bob_action` would offer `lock_eth`.
///
/// The share (known, high or unknown) is a warning note and never a wait, in every profile (0.2.0). Enforced (production): a failing lying-node check is
/// an ALARM note and a wait, unless the operator passed `--accept-producer-concentration`, which turns it into an `OVERRIDDEN` warning and no wait.
/// Not enforced (sepolia, rehearsal): a warning note and no wait.
pub fn lock_gate(g: &Gates, noid: &NoidObservation, now: u64, notes: &mut Vec<String>) -> LockGate {
    let screen = evaluate(g, noid, now);
    notes.extend(screen.top_two_warning.clone());
    let profile = g.name.as_str();
    if is_soft(&screen.finding) {
        match &screen.finding {
            Finding::Pass => notes.extend(screen.ok_note.clone()),
            Finding::Concentrated { detail } => notes.push(format!(
                "WARNING: producer concentration too high (T21 screen; under the {profile} profile it only warns and the lock is still offered): {detail}. {RISK_SENTENCE}"
            )),
            Finding::Unknown { headline, detail } => notes.push(format!(
                "WARNING: {headline} (T21 screen; under the {profile} profile it only warns and the lock is still offered): {detail}"
            )),
            _ => {}
        }
        notes.extend(share_warning(g, noid, matches!(screen.finding, Finding::Unknown { .. })));
        if !noid.accept_producer_concentration && ack_used(g, noid, &screen.finding) {
            notes.push(acknowledged_note(noid, noid.acknowledge_producer_share.unwrap_or(0)));
        }
        return LockGate { wait: None };
    }
    let (headline, detail, tail) = describe(g, &screen.finding);
    if !g.producer_gate_enforced {
        notes.push(format!("WARNING: {headline} (T21 screen; under the {profile} profile it only warns and the lock is still offered): {detail}"));
        return LockGate { wait: None };
    }
    if noid.accept_producer_concentration {
        notes.push(overridden_note(&screen.finding));
        return LockGate { wait: None };
    }
    let text = format!("ALARM: {headline}, not locking (T21): {detail}{tail}");
    notes.push(text.clone());
    LockGate { wait: Some(text) }
}

/// `count / n` in permille, rounded UP (so a printed share is at or below a ceiling exactly when the integer comparison passes).
fn permille_up(count: u64, n: u64) -> u64 {
    if n == 0 {
        0
    } else {
        count.saturating_mul(1000).div_ceil(n)
    }
}

/// The two measured shares (long, short window) in permille and the window sizes, when the summary holds them.
fn measured(noid: &NoidObservation) -> Option<(u64, u64, u64, u64)> {
    let s = noid.producers.as_ref()?;
    let (l, sh) = (s.long.as_ref()?, s.short.as_ref()?);
    Some((permille_up(l.largest, l.n), permille_up(sh.largest, sh.n), l.n, sh.n))
}

/// Is the acknowledgement the reason a lock is offered on a passing screen: the second-node waiver was used (one loopback node, no cross-check)?
fn ack_used(g: &Gates, noid: &NoidObservation, finding: &Finding) -> bool {
    matches!(finding, Finding::Pass | Finding::Concentrated { .. })
        && ack_waives_single_node(g, noid)
        && noid.second.is_none()
        && noid.second_error.is_none()
        && matches!(noid.producers.as_ref().map(|p| &p.second), Some(SecondCheck::NotConfigured))
}

fn acknowledged_note(noid: &NoidObservation, ceiling: u64) -> String {
    let (l, s, ln, sn) = measured(noid).unwrap_or((0, 0, 0, 0));
    format!(
        "ACKNOWLEDGED ({ACK_FLAG} {ceiling}): producer share {} permille ({l} permille of the last {} blocks and {s} permille of the last {}){}. A miner who is Alice can take both legs; Bob accepted this risk for this swap. This is a screen, not a defence",
        l.max(s),
        group(ln),
        group(sn),
        if noid.single_node_loopback && noid.second.is_none() { "; one loopback Parano1d node, no second node" } else { "" }
    )
}

fn describe(g: &Gates, finding: &Finding) -> (&'static str, String, String) {
    match finding {
        Finding::Pass => ("", String::new(), String::new()),
        Finding::Concentrated { detail } => ("producer concentration too high", detail.clone(), String::new()),
        Finding::Unknown { headline, detail } => (headline, detail.clone(), String::new()),
        Finding::Unverifiable { headline, detail } => {
            let tail = if *headline == HEADLINE_CANNOT {
                format!(
                    ". The gate fails closed: no lock until the last {} headers have been read from the node itself",
                    group(g.producer_window_long)
                )
            } else if *headline == HEADLINE_ONE_NODE {
                format!(". Give a second, independent Parano1d node as a second --noid-rpc (another machine or provider), or pass {OVERRIDE_FLAG} to accept the risk")
            } else {
                String::new()
            };
            (headline, detail.clone(), tail)
        }
    }
}

fn overridden_note(finding: &Finding) -> String {
    let what = match finding {
        Finding::Pass => String::new(),
        Finding::Concentrated { detail } => detail.clone(),
        Finding::Unknown { headline, detail } => format!("the share could not be read ({headline}: {detail})"),
        Finding::Unverifiable { headline, detail } => format!("the check could not be completed ({headline}: {detail})"),
    };
    format!(
        "WARNING: producer concentration gate OVERRIDDEN by {OVERRIDE_FLAG} (T21): {what}. This is the exposure the gate exists to prevent. Amounts must stay trial-sized"
    )
}

/// What the screen says about a `lock_eth` intent that was recorded earlier and is still pending (not yet seen on chain).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PendingLockFinding {
    /// `true`: the screen refuses the lock now (enforced profile, no override), so the pending lock must not be sent (an `ALERT:`). `false`: the
    /// profile only warns, and the cause is a remembered detection (a `WARNING:`).
    pub hard: bool,
    /// The short reason, the headline of the finding. Never an address.
    pub headline: &'static str,
    /// A short fixed slug of the kind of finding (`concentration`, `cannot-be-checked`, `stale`, `disagree`, `one-node`, `remembered`). It keys the
    /// history latch together with the intent, so that a later finding of ANOTHER kind (a remembered detection after a transient timeout) alerts again.
    pub kind: &'static str,
}

/// The history entry that latches the `ALERT:` of a pending `lock_eth` intent decided at `decided_at`, for one kind of finding. `live.js lock` refuses
/// while the history holds `producer_alert_lock_pending:<decided_at>` or `producer_alert_lock_pending:<decided_at>:<kind>` for the intent it is about to
/// send, with no override entry after it, so the prefix and the decided-at must stay as they are.
pub fn pending_lock_latch(decided_at: u64, kind: &str) -> String {
    format!("{LOCK_LATCH_PREFIX}{decided_at}:{kind}")
}

/// The start of every latch entry (read by `eth/scripts/live.js`).
pub const LOCK_LATCH_PREFIX: &str = "producer_alert_lock_pending:";

fn kind_of(headline: &'static str) -> &'static str {
    match headline {
        HEADLINE_CANNOT => "cannot-be-checked",
        HEADLINE_STALE => "stale",
        HEADLINE_DISAGREE => "disagree",
        HEADLINE_ONE_NODE => "one-node",
        HEADLINE_MARKER | HEADLINE_MARKER_HASH | HEADLINE_MARKER_UNREADABLE | HEADLINE_MARKER_REMEMBERED => "remembered",
        _ => "other",
    }
}

/// Does the screen, asked now, refuse (or, under a profile that only warns, hold a remembered detection against) the `lock_eth` that an
/// earlier tick recorded as an intent? The decision is the one [`lock_gate`] makes (`wait.is_some()`), asked with a scratch note list so that
/// the notes it pushes are not printed twice. `None` when the screen passes, when the override waives a refusal, when a warning-only profile
/// has no remembered detection (its ordinary warning is already in the notes). A tick that read no summary and no marker still counts: under an
/// enforced profile the screen refuses it ("cannot be checked"), so the pending lock gets its alert and its latch too (review, 2026-11-10).
pub fn pending_lock_finding(g: &Gates, noid: &NoidObservation, now: u64) -> Option<PendingLockFinding> {
    let mut scratch: Vec<String> = Vec::new();
    let hard = lock_gate(g, noid, now, &mut scratch).wait.is_some();
    if !hard && (g.producer_gate_enforced || noid.producer_marker.is_absent()) {
        return None;
    }
    let (headline, kind) = match evaluate(g, noid, now).finding {
        // The share never refuses (0.2.0): nothing to alert about.
        Finding::Pass | Finding::Concentrated { .. } | Finding::Unknown { .. } => return None,
        Finding::Unverifiable { headline, .. } => (headline, kind_of(headline)),
    };
    Some(PendingLockFinding { hard, headline, kind })
}

const PENDING_LOCK_WHAT_TO_DO: &str = "Do NOT send that lock (do not run lock.sh or live.js lock). If nothing was sent, cancel the intent with `swap-cli intent FILE --cancel` (with the same chain flags as tick). If it may already have been sent, look at the contract";

/// The note for a pending `lock_eth` intent (decided at `decided_at`, Unix time). Starts with `ALERT:` when the screen refuses now (the
/// engine prints it on one tick only, as `scripts/live` expects of an alert), with `WARNING:` when the profile only warns.
pub fn pending_lock_note(f: &PendingLockFinding, decided_at: u64) -> String {
    if f.hard {
        format!(
            "ALERT: the producer screen refuses to lock now (T21: {}), but a lock_eth intent decided at {decided_at} (Unix time) is still pending. {PENDING_LOCK_WHAT_TO_DO}",
            f.headline
        )
    } else {
        format!(
            "WARNING: the producer screen holds a remembered detection (T21: {}); this profile only warns, but production would refuse, and a lock_eth intent decided at {decided_at} (Unix time) is still pending. {PENDING_LOCK_WHAT_TO_DO}",
            f.headline
        )
    }
}

/// The reason of the `wait` that holds a pending `lock_eth` intent while the screen refuses it: the usual "reuse the printed parameters" advice
/// of the intent ledger would send the lock the screen has just refused.
pub fn pending_lock_wait_reason(f: &PendingLockFinding, decided_at: u64) -> String {
    format!(
        "intent lock_eth pending since {decided_at} (unix) but the producer screen refuses to lock now ({}): do NOT send it; if nothing was sent, `swap-cli intent FILE --cancel` (with the same chain flags as tick)",
        f.headline
    )
}

/// A note for the waiting states (`received`, `funded`), when a summary was read: the same finding, said as information, because the
/// lock is decided only once the funding is final. `None` without a summary (nothing was asked for) so a state that needs none stays silent.
pub fn waiting_notes(g: &Gates, noid: &NoidObservation, now: u64) -> Vec<String> {
    if noid.producers.is_none() && noid.producer_marker.is_absent() {
        return Vec::new();
    }
    let screen = evaluate(g, noid, now);
    let mut out: Vec<String> = screen.top_two_warning.clone().into_iter().collect();
    match &screen.finding {
        Finding::Pass => out.extend(screen.ok_note),
        Finding::Concentrated { .. } | Finding::Unknown { .. } => {
            let (headline, detail, _) = describe(g, &screen.finding);
            out.push(format!("producer concentration, a warning, it does not block the lock (T21): {headline}: {detail}"));
            out.extend(share_warning(g, noid, matches!(screen.finding, Finding::Unknown { .. })));
        }
        finding => {
            let (headline, detail, _) = describe(g, finding);
            out.push(format!("producer concentration, not yet blocking (the lock is decided when the funding is final; T21): {headline}: {detail}"));
        }
    }
    out
}

/// The history entry to write when the override waives a refusal and `lock_eth` is offered: `None` unless the profile enforces the screen, the
/// flag is set and the screen did not pass. Carries counts or the reason, never an address.
pub fn override_history_entry(g: &Gates, noid: &NoidObservation, now: u64) -> Option<String> {
    if !g.producer_gate_enforced || !noid.accept_producer_concentration {
        return None;
    }
    let screen = evaluate(g, noid, now);
    match screen.finding {
        // The share never refuses (0.2.0), so the override has nothing to waive there.
        Finding::Pass | Finding::Concentrated { .. } | Finding::Unknown { .. } => None,
        Finding::Unverifiable { headline, .. } => Some(format!("{OVERRIDE_HISTORY}: {headline}")),
    }
}

/// D2: the history entry to write when the acknowledgement is the reason `lock_eth` is offered: `None` unless the profile enforces the screen, the flag is
/// set, `--accept-producer-concentration` is not (its own entry applies), and the acknowledgement waived the share or the loopback single node.
pub fn ack_history_entry(g: &Gates, noid: &NoidObservation, now: u64) -> Option<String> {
    if !g.producer_gate_enforced || noid.accept_producer_concentration {
        return None;
    }
    let c = noid.acknowledge_producer_share?;
    let screen = evaluate(g, noid, now);
    let used = match &screen.finding {
        Finding::Pass | Finding::Concentrated { .. } => ack_used(g, noid, &screen.finding),
        Finding::Unknown { .. } | Finding::Unverifiable { .. } => false,
    };
    if !used {
        return None;
    }
    let (l, s, ln, sn) = measured(noid)?;
    Some(format!("{ACK_HISTORY}: largest {l} permille of {ln} and {s} permille of {sn}, ceiling {c} permille, at {now}"))
}

/// The structured form of the screen for the page (`producer_screen` in the tick JSON).
#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize)]
pub struct ProducerScreenReport {
    /// `pass`, `concentrated` (a share above the warning limit: a warning), `share_unknown` (the share cannot be read: a warning), `cannot_check`,
    /// `stale`, `disagrees`, `one_node`, `remembered`. Only the last five (the lying-node and second-node checks) can refuse the lock.
    pub state: &'static str,
    /// The share was measured in both windows.
    pub share_known: bool,
    /// The plain warning about the share (above 50 %: the loud one; above the warning limit: the milder one; unknown: the unknown one), `None` when
    /// the share is known and at or under the warning limit. Never a refusal.
    pub warning: Option<String>,
    /// The share never refuses (0.2.0): always `false` for the share. Kept so that a page can state it.
    pub share_refuses: bool,
    /// The profile enforces the screen (`production`).
    pub enforced: bool,
    pub share_permille_long: Option<u64>,
    pub share_permille_short: Option<u64>,
    pub limit_permille: u64,
    /// `ok`, `missing`, `disagrees`, `remembered`, `unreadable`.
    pub second_node: &'static str,
    pub single_node_loopback: bool,
    /// `true`: the screen does not refuse, or (production) refuses only for a reason `--acknowledge-producer-share` can waive (one loopback node and no second
    /// node). Always `true` under the profiles that do not enforce, and for every share finding.
    pub waivable_by_acknowledgement: bool,
    pub hard_max_permille: u64,
    /// The value of `--acknowledge-producer-share` on this tick, if given.
    pub acknowledged_ceiling_permille: Option<u64>,
    /// The flag on this tick waives something that would otherwise refuse the lock.
    pub waived_by_acknowledgement: bool,
}

/// The structured form of the screen, computed WITHOUT the acknowledgement so that it shows the reason the screen refuses on its own. Never an address.
pub fn report(g: &Gates, noid: &NoidObservation, now: u64) -> ProducerScreenReport {
    let raw = evaluate_with(g, noid, now, false);
    let second_node = if !noid.producer_marker.is_absent() {
        "remembered"
    } else if noid.second_error.is_some() {
        "unreadable"
    } else {
        match noid.producers.as_ref().map(|p| &p.second) {
            Some(SecondCheck::Agrees { sampled, .. }) if *sampled > 0 => "ok",
            Some(SecondCheck::Differs { .. } | SecondCheck::SampledDiffers { .. } | SecondCheck::ProducerDiffers { .. }) => "disagrees",
            Some(SecondCheck::NotConfigured) | None if noid.second.is_none() => "missing",
            _ => "unreadable",
        }
    };
    let state = match &raw.finding {
        Finding::Unknown { .. } => "share_unknown",
        Finding::Pass if g.producer_gate_enforced && second_node == "unreadable" => "cannot_check",
        Finding::Pass if g.producer_gate_enforced && second_node == "missing" => "one_node",
        Finding::Pass => "pass",
        Finding::Concentrated { .. } => "concentrated",
        Finding::Unverifiable { headline, .. } => match kind_of(headline) {
            "stale" => "stale",
            "disagree" => "disagrees",
            "one-node" => "one_node",
            "remembered" => "remembered",
            _ => "cannot_check",
        },
    };
    let (long, short) = match measured(noid) {
        Some((l, s, _, _)) => (Some(l), Some(s)),
        None => (None, None),
    };
    let second_ok = second_node == "ok" || (second_node == "missing" && noid.single_node_loopback);
    let waivable = !g.producer_gate_enforced || matches!(state, "pass" | "concentrated" | "share_unknown") || (state == "one_node" && second_ok);
    let c = noid.acknowledge_producer_share;
    // Only the missing second node of a loopback node is waived by the flag now; the share is never a reason to refuse.
    let waived = g.producer_gate_enforced && state == "one_node" && waivable && c.is_some();
    ProducerScreenReport {
        state,
        share_known: long.is_some() && short.is_some() && !matches!(raw.finding, Finding::Unknown { .. }),
        warning: share_warning(g, noid, matches!(raw.finding, Finding::Unknown { .. })),
        share_refuses: false,
        enforced: g.producer_gate_enforced,
        share_permille_long: long,
        share_permille_short: short,
        limit_permille: g.producer_limit_permille,
        second_node,
        single_node_loopback: noid.single_node_loopback,
        waivable_by_acknowledgement: waivable,
        hard_max_permille: ACK_HARD_MAX_PERMILLE,
        acknowledged_ceiling_permille: c,
        waived_by_acknowledgement: waived,
    }
}

/// Parse the value of `--acknowledge-producer-share`: a whole number of permille from 1 to [`ACK_HARD_MAX_PERMILLE`].
pub fn parse_ack_value(v: &str) -> Result<u64, String> {
    let n: u64 = v.trim().parse().map_err(|_| format!("{ACK_FLAG} needs a whole number of permille from 1 to {ACK_HARD_MAX_PERMILLE}, not '{v}'"))?;
    if n == 0 || n > ACK_HARD_MAX_PERMILLE {
        return Err(format!("{ACK_FLAG} {n}: the value must be from 1 to {ACK_HARD_MAX_PERMILLE} permille (a compiled maximum)"));
    }
    Ok(n)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn shares_print_rounded_up_so_the_printed_share_is_over_a_limit_exactly_when_the_integer_test_is() {
        assert_eq!(pct(1008, 2880), "35.0");
        assert_eq!(pct(1009, 2880), "35.1");
        assert_eq!(pct(252, 720), "35.0");
        assert_eq!(pct(253, 720), "35.2");
        assert_eq!(pct(0, 2880), "0.0");
        assert_eq!(pct(2880, 2880), "100.0");
        assert_eq!(pct(5, 0), "0.0");
        for (count, n, limit) in [(1008u64, 2880u64, 350u64), (1009, 2880, 350), (806, 2880, 280), (807, 2880, 280), (252, 720, 350), (253, 720, 350)] {
            let printed: f64 = pct(count, n).parse().unwrap();
            assert_eq!(over(count, n, limit), printed > limit as f64 / 10.0, "{count}/{n} vs {limit}");
        }
    }

    #[test]
    fn limits_and_counts_are_written_plainly() {
        assert_eq!(limit_pct(350), "35");
        assert_eq!(limit_pct(280), "28");
        assert_eq!(limit_pct(500), "50");
        assert_eq!(limit_pct(335), "33.5");
        assert_eq!(group(2880), "2,880");
        assert_eq!(group(720), "720");
        assert_eq!(group(1_420), "1,420");
        assert_eq!(group(1_234_567), "1,234,567");
    }

    #[test]
    fn the_comparison_is_integer_and_a_share_exactly_at_the_limit_passes() {
        assert!(!over(1008, 2880, 350));
        assert!(over(1009, 2880, 350));
        assert!(!over(0, 0, 350));
        assert!(!over(u64::MAX, 1, u64::MAX));
    }
}
