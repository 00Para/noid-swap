//! Bob's producer-concentration screen (threat T21, `docs/bob-concentration-gate.md`): what the engine makes of a
//! [`ProducerSummary`] before Bob locks his Ethereum leg.
//!
//! Plain words. The watcher (`watch::producers`) counts who produced the recent blocks. This module decides what the counts mean
//! and writes the notes:
//!
//! - **R1, hard under `production`:** one address produced more than the profile's limit (35 % production, 28 % sepolia and
//!   rehearsal) of the last 2,880 blocks or of the last 720. The comparison is on integers, `count * 1000 > limit * window`, so a
//!   share exactly at the limit passes.
//! - **Cannot be checked, hard under `production`:** the summary is missing, incomplete or built for other windows, a header could
//!   not be read, the chain of headers does not link, the data is stale, or the second Parano1d node disagrees or could not be read.
//!   The screen fails closed.
//! - **A remembered detection, hard under `production`:** an earlier tick saw evidence that cannot come from two honest nodes, either two
//!   different producers named for a block with equal hashes, or a different hash at a sampled height below an anchor block that the second
//!   node named again after the sample, and wrote the marker `<swap file>.producer-differs` (`crate::producer_marker`); while it exists (or cannot be read) the
//!   screen refuses, whatever the later ticks say.
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

const HEADLINE_CANNOT: &str = "producer concentration cannot be checked";
const HEADLINE_STALE: &str = "producer concentration data is stale";
const HEADLINE_DISAGREE: &str = "the two Parano1d nodes disagree about the producers";
const HEADLINE_ONE_NODE: &str = "producer check needs a second Parano1d node";
const HEADLINE_MARKER: &str = "an earlier tick saw the two Parano1d nodes name different producers for one block";
const HEADLINE_MARKER_HASH: &str = "an earlier tick saw the two Parano1d nodes hold different blocks below a block they agree on";
const HEADLINE_MARKER_UNREADABLE: &str = "the record of a producer disagreement between the two Parano1d nodes cannot be read";

/// The result of looking at one summary.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Finding {
    /// Every check holds.
    Pass,
    /// R1: one address is above the limit in at least one window. `detail` is the sentence about the shares.
    Concentrated { detail: String },
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
    let a = format!("{} % of the last {} blocks (limit {limit} %)", pct(long.largest, long.n), group(long.n));
    let b = format!("{} % of the last {} (limit {limit} %)", pct(short.largest, short.n), group(short.n));
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
    let screen = |finding: Finding| Screen { finding, ok_note: None, top_two_warning: None };
    let cannot = |detail: String| screen(Finding::Unverifiable { headline: HEADLINE_CANNOT, detail });
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
                    "at Unix time {at} {seen}; compare the two nodes by hand for that block. The file <swap file>{} beside the swap file records it, the tool never removes it, and it keeps this screen closed on every tick until you remove it yourself after finding the cause (delete the header cache <swap file>.producers beside it too: it may still hold what the misreporting node said)",
                    crate::producer_marker::SUFFIX
                ),
            });
        }
        MarkerState::Unreadable { reason } => {
            return screen(Finding::Unverifiable {
                headline: HEADLINE_MARKER_UNREADABLE,
                detail: format!(
                    "{reason}; it counts as a detection until you have looked at it (it records that two nodes once named different producers for a block with equal hashes, or held different blocks below a block they agreed on) and removed or repaired it yourself"
                ),
            });
        }
    }
    let Some(s) = noid.producers.as_ref() else {
        return cannot("no producer summary was read in this poll (the headers were not asked for, or the read did not run)".into());
    };
    if s.window_long != g.producer_window_long || s.window_short != g.producer_window_short {
        return cannot(format!(
            "the summary was computed for windows of {} and {} blocks, the profile wants {} and {}",
            group(s.window_long),
            group(s.window_short),
            group(g.producer_window_long),
            group(g.producer_window_short)
        ));
    }
    if let Some(e) = &s.error {
        return cannot(e.clone());
    }
    let (Some(long), Some(short)) = (&s.long, &s.short) else {
        return cannot(format!(
            "{} of {} headers read so far (the next tick reads on)",
            group(s.have),
            group(g.producer_window_long)
        ));
    };
    if !s.complete || long.n != g.producer_window_long || short.n != g.producer_window_short {
        return cannot(format!(
            "{} of {} headers read so far (the next tick reads on)",
            group(s.have),
            group(g.producer_window_long)
        ));
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
        return screen(Finding::Unverifiable { headline: HEADLINE_STALE, detail: stale.join("; ") });
    }
    // The second Parano1d node: when one is configured it must agree on the block at the anchor height.
    let second_line = if noid.second_error.is_some() {
        // A configured second node that could not be read at all holds `lock_eth` through the F5 rule, with F5's own reason, whatever this screen says.
        "the second node could not be read, F5 holds the lock".to_string()
    } else if noid.second.is_some() || !matches!(s.second, SecondCheck::NotConfigured) {
        match &s.second {
            // A record without a sample (made before the sample existed) is not a producer cross-check.
            SecondCheck::Agrees { sampled: 0, .. } => {
                return cannot("the second Parano1d node's producer cross-check recorded no sampled heights".into());
            }
            SecondCheck::Agrees { height, sampled } => format!(
                "second node holds the same block at height {height} and names the same producer for {sampled} sampled height{}",
                if *sampled == 1 { "" } else { "s" }
            ),
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
            SecondCheck::Unreadable { reason } => {
                return cannot(format!("the second Parano1d node could not be read for the producer cross-check ({reason})"));
            }
            SecondCheck::NotConfigured => {
                return cannot("a second Parano1d node is configured but the producer cross-check did not run".into());
            }
        }
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
        result.finding = Finding::Concentrated { detail: shares_sentence(g, long, short) };
        return result;
    }
    let age = s.read_at.map_or_else(String::new, |t| format!(", read {} s ago", now.saturating_sub(t)));
    let from = s.source.as_ref().map_or_else(String::new, |l| format!(" from {l}"));
    result.ok_note = Some(format!(
        "producer concentration ok (T21 screen, not a defence): largest producer {} % of the last {} blocks and {} % of the last {} (limit {} %); two largest together {} % and {} % (warning above {} %); headers to height {}{age}{from}; {second_line}",
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
    /// `Some(reason)`: `lock_eth` is not offered (the reason is also the ALARM note).
    pub wait: Option<String>,
}

const RISK_SENTENCE: &str = "A miner who is Alice can keep Bob's claim from becoming final until D and take both legs. This is a screen, not a defence";

/// The notes and the decision at the point where `bob_action` would offer `lock_eth`.
///
/// Enforced (production): a failing screen is an ALARM note and a wait, unless the operator passed `--accept-producer-concentration`, which turns
/// it into an `OVERRIDDEN` warning and no wait. Not enforced (sepolia, rehearsal): a warning note and no wait.
pub fn lock_gate(g: &Gates, noid: &NoidObservation, now: u64, notes: &mut Vec<String>) -> LockGate {
    let screen = evaluate(g, noid, now);
    notes.extend(screen.top_two_warning.clone());
    let profile = g.name.as_str();
    match &screen.finding {
        Finding::Pass => {
            notes.extend(screen.ok_note);
            LockGate { wait: None }
        }
        finding => {
            let (headline, detail, tail) = describe(g, finding);
            if !g.producer_gate_enforced {
                notes.push(format!(
                    "WARNING: {headline} (T21 screen; under the {profile} profile it only warns and the lock is still offered): {detail}{}",
                    if matches!(finding, Finding::Concentrated { .. }) { format!(". {RISK_SENTENCE}") } else { String::new() }
                ));
                return LockGate { wait: None };
            }
            if noid.accept_producer_concentration {
                notes.push(overridden_note(finding));
                return LockGate { wait: None };
            }
            let text = match finding {
                Finding::Concentrated { .. } => format!(
                    "ALARM: producer concentration too high, not locking (T21): {detail}. {RISK_SENTENCE}. Wait for the share to fall, or pass {OVERRIDE_FLAG} to accept the risk"
                ),
                _ => format!("ALARM: {headline}, not locking (T21): {detail}{tail}"),
            };
            notes.push(text.clone());
            LockGate { wait: Some(text) }
        }
    }
}

fn describe(g: &Gates, finding: &Finding) -> (&'static str, String, String) {
    match finding {
        Finding::Pass => ("", String::new(), String::new()),
        Finding::Concentrated { detail } => ("producer concentration too high", detail.clone(), String::new()),
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
        Finding::Unverifiable { headline, detail } => format!("the check could not be completed ({headline}: {detail})"),
    };
    format!(
        "WARNING: producer concentration gate OVERRIDDEN by {OVERRIDE_FLAG} (T21): {what}. This is the exposure the gate exists to prevent. Amounts must stay trial-sized"
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
    let s: Option<&ProducerSummary> = noid.producers.as_ref();
    match screen.finding {
        Finding::Pass => None,
        Finding::Concentrated { .. } => {
            let (l, sh) = (s?.long.as_ref()?, s?.short.as_ref()?);
            Some(format!(
                "{OVERRIDE_HISTORY}: largest {} % of {} and {} % of {}",
                pct(l.largest, l.n),
                l.n,
                pct(sh.largest, sh.n),
                sh.n
            ))
        }
        Finding::Unverifiable { headline, .. } => Some(format!("{OVERRIDE_HISTORY}: {headline}")),
    }
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
