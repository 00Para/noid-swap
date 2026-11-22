//! The producer-differs marker (threat T21, `docs/bob-concentration-gate.md` section 4, "Remembered detection").
//!
//! Plain words. Bob's producer screen compares what two Parano1d nodes say about the same recent blocks. Two honest nodes cannot hold the SAME
//! block (equal hashes) and name DIFFERENT producers for it, so one tick that sees that is evidence that one node misreports. Without a
//! memory, the next tick would draw a fresh sample, and the first tick that missed the lie would offer the lock. So the tick that sees it
//! writes this small file beside the swap file, `<swap file>.producer-differs`, and every later tick of Bob's file reads it.
//!
//! What the file holds: a version, the height of the block, the Unix seconds of the detection and, for the hash kind only, `"kind":"hash"` (a
//! record without `kind` is the producer kind, which is what the first version wrote). No address, no hash. It is created
//! exclusively (an existing marker is left exactly as it is: the first detection stays), written fully, synced, and its directory synced. The
//! tool never deletes or rewrites it; the operator may remove it by hand after finding the cause. It latches two kinds of evidence only: equal hashes with different
//! producers (`kind` producer), and a different hash at a SAMPLED height below an anchor block that the second node confirmed both before and
//! after the sample (`kind` hash; two honest nodes that agree on a block agree on every block below it, and an honest reorg would have moved
//! the anchor). A hash difference AT the anchor, a missing height or a timeout is never latched (an honest reorg near the tip can cause the
//! first). It is its own file, not part of the `.producers` cache, which may
//! be deleted and rebuilt.
//!
//! What the screen does while it exists (`producer_gate`): refuses under `production` for the rest of the swap (the printed override waives it
//! like the rest of the screen), warns under `sepolia` and `rehearsal`. A marker that cannot be read or parsed counts as present.

use std::io::Write;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::state::Role;
use crate::swapfile::SwapFile;
use crate::watch::producers::SecondCheck;

/// The marker is the swap file's path plus this suffix.
pub const SUFFIX: &str = ".producer-differs";
/// The history entry written once per swap file (with `tick --apply`) while a marker is present.
pub const HISTORY: &str = "producer_differs_seen";
const VERSION: u64 = 1;
/// A marker larger than this is not one this tool wrote.
const MAX_BYTES: u64 = 4096;
/// The largest `at` accepted (JavaScript's largest safe integer, as the other sidecar).
const MAX_AT: u64 = (1 << 53) - 1;

/// `<swap file>.producer-differs`.
pub fn path_for(swap_file: &Path) -> PathBuf {
    let mut s = swap_file.as_os_str().to_os_string();
    s.push(SUFFIX);
    PathBuf::from(s)
}

/// What the marker beside a swap file says. Holds no address and no hash.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "state", rename_all = "snake_case")]
pub enum MarkerState {
    /// No marker (the default: the library, the simulator and Alice's file).
    #[default]
    Absent,
    /// A marker seen at Unix seconds `at`: of `kind` Producer, a block at `height` whose hash the two nodes agree on and whose producer they do
    /// not; of kind Hash, a block at `height` whose hash differs between the two nodes although they agreed on the anchor block above it before
    /// and after the question.
    Present {
        height: u64,
        at: u64,
        #[serde(default, skip_serializing_if = "MarkerKind::is_producer")]
        kind: MarkerKind,
    },
    /// Something is at the marker's path but it is not a marker this tool wrote, or it cannot be read. Counts as present.
    Unreadable { reason: String },
}

impl MarkerState {
    pub fn is_absent(&self) -> bool {
        matches!(self, MarkerState::Absent)
    }
}

/// What was seen. The default is the producer kind, so that a marker written without a `kind` still reads.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MarkerKind {
    /// Equal hashes, different producers.
    #[default]
    Producer,
    /// A different hash at a sampled height below an anchor the second node confirmed before and after.
    Hash,
}

impl MarkerKind {
    pub fn is_producer(&self) -> bool {
        matches!(self, MarkerKind::Producer)
    }
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Record {
    version: u64,
    height: u64,
    at: u64,
    #[serde(default, skip_serializing_if = "MarkerKind::is_producer")]
    kind: MarkerKind,
}

/// Read the marker beside `swap_file`.
pub fn read(swap_file: &Path) -> MarkerState {
    let path = path_for(swap_file);
    let unreadable = |why: String| MarkerState::Unreadable { reason: format!("{} {why}", path.display()) };
    let meta = match std::fs::symlink_metadata(&path) {
        Ok(m) => m,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return MarkerState::Absent,
        Err(e) => return unreadable(format!("cannot be examined ({})", e.kind())),
    };
    if !meta.is_file() || meta.len() > MAX_BYTES {
        return unreadable("is not a regular file of the size this tool writes".into());
    }
    let text = match std::fs::read_to_string(&path) {
        Ok(t) => t,
        Err(e) => return unreadable(format!("cannot be read ({})", e.kind())),
    };
    match serde_json::from_str::<Record>(&text) {
        Ok(r) if r.version == VERSION && r.at <= MAX_AT => MarkerState::Present { height: r.height, at: r.at, kind: r.kind },
        _ => unreadable("is not in the producer-differs record's format".into()),
    }
}

/// What [`record`] did.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Recorded {
    /// A new marker was written and synced.
    Created,
    /// A marker was already there; it was left as it is.
    AlreadyThere,
}

/// Why [`record`] failed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RecordError {
    /// The marker file was created (and may be empty or partial). Then it exists, an incomplete one reads as unreadable, and that counts as
    /// present; when `false`, nothing was left behind and later ticks will not remember the detection.
    pub created: bool,
    /// The error kind and what failed.
    pub what: String,
}

/// The remembered kind of a second check, if it is one: the height to write and the kind. `ProducerDiffers` and `SampledDiffers` only; a
/// plain `Differs` (at the anchor, or at a sampled height whose anchor was not confirmed again), `Unreadable` and `Agrees` are never latched.
pub fn remembered(second: &SecondCheck) -> Option<(u64, MarkerKind)> {
    match second {
        SecondCheck::ProducerDiffers { height } => Some((*height, MarkerKind::Producer)),
        SecondCheck::SampledDiffers { height } => Some((*height, MarkerKind::Hash)),
        _ => None,
    }
}

/// Write the marker for a detection at `height` of `kind`, seen at `at`. Exclusive: an existing marker is never touched. `Err` says whether
/// the file was created before the failure ([`RecordError::created`]); a marker that was created and then could not be completed is left in
/// place (it then reads as unreadable, which counts as present).
pub fn record(swap_file: &Path, height: u64, at: u64, kind: MarkerKind) -> Result<Recorded, RecordError> {
    let path = path_for(swap_file);
    let mut opts = std::fs::OpenOptions::new();
    opts.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt as _;
        opts.mode(0o600);
    }
    let mut f = match opts.open(&path) {
        Ok(f) => f,
        Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => return Ok(Recorded::AlreadyThere),
        Err(e) => return Err(RecordError { created: false, what: format!("{} (create)", e.kind()) }),
    };
    let after = |what: String| RecordError { created: true, what };
    let mut text = serde_json::to_string(&Record { version: VERSION, height, at, kind }).map_err(|e| after(e.to_string()))?;
    text.push('\n');
    f.write_all(text.as_bytes()).map_err(|e| after(format!("{} (write)", e.kind())))?;
    f.sync_all().map_err(|e| after(format!("{} (sync)", e.kind())))?;
    drop(f);
    #[cfg(unix)]
    crate::swapfile::sync_dir(crate::swapfile::parent_dir(&path)).map_err(|e| after(format!("{} (sync of the directory)", e.kind())))?;
    Ok(Recorded::Created)
}

/// Bob's file only: while a marker is present (readable), record [`HISTORY`] once in `file` (in memory; `tick --apply` saves it, a read-only
/// tick does not). An unreadable marker is not recorded here: the screen says so on every tick.
pub fn note_marker(file: &mut SwapFile, state: &MarkerState, now: u64) {
    if file.role != Role::Bob || !matches!(state, MarkerState::Present { .. }) {
        return;
    }
    if !file.history.iter().any(|h| h.event == HISTORY) {
        file.log(HISTORY, now);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_name_is_the_swap_file_name_plus_suffix() {
        assert_eq!(path_for(Path::new("/x/y/b.swap.json")), PathBuf::from("/x/y/b.swap.json.producer-differs"));
    }

    #[test]
    fn written_once_read_back_and_never_changed_by_a_second_detection() {
        let dir = tempfile::tempdir().unwrap();
        let swap = dir.path().join("b.swap.json");
        assert_eq!(read(&swap), MarkerState::Absent);
        assert_eq!(record(&swap, 9_997, 1_700_000_000, MarkerKind::Producer), Ok(Recorded::Created));
        assert_eq!(read(&swap), MarkerState::Present { height: 9_997, at: 1_700_000_000, kind: MarkerKind::Producer });
        let bytes = std::fs::read(path_for(&swap)).unwrap();
        assert_eq!(record(&swap, 5, 6, MarkerKind::Hash), Ok(Recorded::AlreadyThere));
        assert_eq!(std::fs::read(path_for(&swap)).unwrap(), bytes, "the first detection stays");
        let text = String::from_utf8(bytes).unwrap();
        assert_eq!(text, "{\"version\":1,\"height\":9997,\"at\":1700000000}\n");
    }

    #[test]
    fn the_hash_kind_is_written_and_read_back_and_a_marker_without_a_kind_is_the_producer_kind() {
        let dir = tempfile::tempdir().unwrap();
        let swap = dir.path().join("b.swap.json");
        assert_eq!(record(&swap, 8_010, 77, MarkerKind::Hash), Ok(Recorded::Created));
        assert_eq!(std::fs::read_to_string(path_for(&swap)).unwrap(), "{\"version\":1,\"height\":8010,\"at\":77,\"kind\":\"hash\"}\n");
        assert_eq!(read(&swap), MarkerState::Present { height: 8_010, at: 77, kind: MarkerKind::Hash });
        std::fs::write(path_for(&swap), "{\"version\":1,\"height\":3,\"at\":4}\n").unwrap();
        assert_eq!(read(&swap), MarkerState::Present { height: 3, at: 4, kind: MarkerKind::Producer });
        std::fs::write(path_for(&swap), "{\"version\":1,\"height\":3,\"at\":4,\"kind\":\"other\"}\n").unwrap();
        assert!(matches!(read(&swap), MarkerState::Unreadable { .. }), "an unknown kind is not a marker this tool wrote");
    }

    #[test]
    fn only_the_two_remembered_kinds_are_latched() {
        assert_eq!(remembered(&SecondCheck::ProducerDiffers { height: 5 }), Some((5, MarkerKind::Producer)));
        assert_eq!(remembered(&SecondCheck::SampledDiffers { height: 6 }), Some((6, MarkerKind::Hash)));
        for other in [
            SecondCheck::NotConfigured,
            SecondCheck::Agrees { height: 1, sampled: 64 },
            SecondCheck::Differs { height: 1, first: "aa".into(), second: "bb".into() },
            SecondCheck::Unreadable { reason: "x".into() },
        ] {
            assert_eq!(remembered(&other), None, "{other:?}");
        }
    }

    #[test]
    fn a_marker_that_is_not_one_reads_as_unreadable() {
        let dir = tempfile::tempdir().unwrap();
        let swap = dir.path().join("b.swap.json");
        for bad in ["", "not json", "{}", "{\"version\":2,\"height\":1,\"at\":1}", "{\"version\":1,\"height\":1,\"at\":1,\"extra\":2}", "{\"version\":1,\"height\":-1,\"at\":1}"] {
            std::fs::write(path_for(&swap), bad).unwrap();
            assert!(matches!(read(&swap), MarkerState::Unreadable { .. }), "{bad}");
        }
        std::fs::write(path_for(&swap), " ".repeat(5_000)).unwrap();
        assert!(matches!(read(&swap), MarkerState::Unreadable { .. }), "too large");
        std::fs::remove_file(path_for(&swap)).unwrap();
        std::fs::create_dir(path_for(&swap)).unwrap();
        assert!(matches!(read(&swap), MarkerState::Unreadable { .. }), "a directory");
    }

    #[test]
    fn the_history_entry_is_written_once_for_bobs_file_only_and_only_for_a_readable_marker() {
        use crate::secret::{Secret, Variant};
        use crate::swapfile::{example_bob_file, example_public, KdfParams, Passphrase};
        let secret = Secret::generate().unwrap();
        let mut bob = example_bob_file(example_public(&secret, Variant::Raw), 1).unwrap();
        let present = MarkerState::Present { height: 9, at: 8, kind: MarkerKind::Producer };
        note_marker(&mut bob, &MarkerState::Absent, 10);
        note_marker(&mut bob, &MarkerState::Unreadable { reason: "x".into() }, 10);
        assert!(bob.history.iter().all(|h| h.event != HISTORY));
        note_marker(&mut bob, &present, 11);
        note_marker(&mut bob, &present, 12);
        assert_eq!(bob.history.iter().filter(|h| h.event == HISTORY).count(), 1);
        let mut alice = SwapFile::new_alice(example_public(&secret, Variant::Raw), &secret, &Passphrase::new("pw"), &KdfParams::fast_for_tests(), 1).unwrap();
        note_marker(&mut alice, &present, 11);
        assert!(alice.history.iter().all(|h| h.event != HISTORY), "Alice's file never records it");
    }

    #[test]
    fn a_missing_directory_is_an_error_with_its_kind() {
        let dir = tempfile::tempdir().unwrap();
        let swap = dir.path().join("gone").join("b.swap.json");
        let e = record(&swap, 1, 2, MarkerKind::Producer).unwrap_err();
        assert!(!e.created, "nothing was left behind");
        assert!(e.what.contains("entity not found") || e.what.contains("not found"), "{e:?}");
    }
}
