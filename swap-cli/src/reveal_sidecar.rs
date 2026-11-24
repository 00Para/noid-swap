//! The reveal sidecar (`TASKS.md` T21-11, `swap-cli/README.md` "Residual window").
//!
//! Plain words. Alice's reveal is sent by `eth/scripts/live.js claim`, a separate program. If that program broadcasts the claim and then the
//! claim leaves the network pool (dropped, a node restart) or the process dies before any `tick` saved the fact, the swap file does not know
//! that the secret may already be public. `live.js` therefore writes a small file next to the swap file, `<swap file>.reveal-sent`, BEFORE it
//! broadcasts. This module reads it. It holds the lock id (hex), the signed transaction's hash when it was known before the broadcast, and
//! the UTC epoch seconds of the first attempt: never the secret, never a key, never anything of the swap file.
//!
//! What a sidecar of THIS swap's lock does: the next `tick` (read-only or `--apply`) records [`REVEAL_SIDECAR_SEEN`], and a re-send is
//! judged by the late cutoff `T_reveal - DE`, not by the first-publication cutoff `T_reveal - M_A`. It is evidence that a send was STARTED
//! (like `REVEAL_MAYBE_SENT`), not that the secret is public: it is NOT counted by `secret_may_be_public`, so the rules that wait for real
//! evidence (the instance must be visible, CHAOS F-13; no reveal with two fitting instances, R4-4) are not relaxed by it. It does count as
//! reveal evidence for `lost`. With `--apply` the marker is written into the swap file, so it survives the sidecar being removed. A sidecar
//! of another lock, one that is not in the format, or one that is not a regular file is ignored and said so in the notes.

use std::path::{Path, PathBuf};

use serde::Deserialize;

use crate::engine::{alice_lock_id, last_history, REVEAL_SIDECAR_SEEN};
use crate::state::Role;
use crate::swapfile::SwapFile;

/// The sidecar is the swap file's path plus this suffix.
pub const SIDECAR_SUFFIX: &str = ".reveal-sent";
/// A sidecar larger than this is not one this tool's counterpart wrote.
const MAX_BYTES: u64 = 4096;

/// `<swap file>.reveal-sent`.
pub fn path_for(swap_file: &Path) -> PathBuf {
    let mut s = swap_file.as_os_str().to_os_string();
    s.push(SIDECAR_SUFFIX);
    PathBuf::from(s)
}

#[derive(Debug, Deserialize)]
struct Raw {
    version: u64,
    lock_id: String,
    // Required (`null` or a hash): the reader in `live.js` requires the key too.
    #[serde(deserialize_with = "required_option")]
    tx_hash: Option<String>,
    at: u64,
}

fn required_option<'de, D: serde::Deserializer<'de>>(d: D) -> Result<Option<String>, D::Error> {
    Option::<String>::deserialize(d)
}

/// The largest `at` both readers accept (JavaScript's largest safe integer).
const MAX_AT: u64 = (1 << 53) - 1;

/// What the sidecar beside a swap file says about one lock.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Reading {
    /// No sidecar.
    Absent,
    /// This lock's: evidence that a reveal send was started at `at`.
    Matching { tx_hash: Option<String>, at: u64 },
    /// A sidecar of another lock, or this swap's lock id is not known yet: ignored.
    Foreign { note: String },
    /// Not a sidecar in the format (or not a regular file): ignored.
    Unreadable { note: String },
}

fn is_hex64(s: &str) -> bool {
    s.len() == 64 && s.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

/// Read the sidecar of `swap_file` against `lock_id` (the lock of the file's own phase; `None` when the phase has none yet).
pub fn read(swap_file: &Path, lock_id: Option<[u8; 32]>) -> Reading {
    // `live.js` names the sidecar from the REAL path of the swap file (an outside read, 2026-11-10: the same file through a link must share one
    // sidecar). So the sidecar beside the real path is looked at first; when the swap file was given by another name (a link), the sidecar beside
    // that name is looked at too (an older `live.js` wrote it there). Either one counts as evidence (a matching one wins).
    if let Ok(real) = std::fs::canonicalize(swap_file) {
        let real = strip_verbatim(real);
        if real != swap_file {
            let first = read_at(&path_for(&real), lock_id);
            if matches!(first, Reading::Matching { .. }) {
                return first;
            }
            let second = read_at(&path_for(swap_file), lock_id);
            return if matches!(second, Reading::Matching { .. }) || matches!(first, Reading::Absent) { second } else { first };
        }
    }
    read_at(&path_for(swap_file), lock_id)
}

/// Windows `canonicalize` returns a verbatim path (`\\?\C:\...`); a plain path is what the rest of the tool prints and compares.
pub(crate) fn strip_verbatim(p: PathBuf) -> PathBuf {
    match p.to_str().and_then(|s| s.strip_prefix(r"\\?\")) {
        Some(rest) if !rest.starts_with("UNC\\") => PathBuf::from(rest),
        _ => p,
    }
}

fn read_at(path: &Path, lock_id: Option<[u8; 32]>) -> Reading {
    let path = path.to_path_buf();
    let meta = match std::fs::symlink_metadata(&path) {
        Ok(m) => m,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Reading::Absent,
        Err(e) => return Reading::Unreadable { note: format!("the reveal sidecar {} cannot be examined ({}); it is ignored", path.display(), e.kind()) },
    };
    if !meta.is_file() || meta.len() > MAX_BYTES {
        return Reading::Unreadable { note: format!("{} is not a reveal sidecar written by live.js (not a regular file, or too large); it is ignored", path.display()) };
    }
    let text = match std::fs::read_to_string(&path) {
        Ok(t) => t,
        Err(e) => return Reading::Unreadable { note: format!("{} cannot be read ({}); it is ignored", path.display(), e.kind()) },
    };
    let raw: Raw = match serde_json::from_str(&text) {
        Ok(r) => r,
        Err(_) => return Reading::Unreadable { note: format!("{} is not in the reveal sidecar's format; it is ignored", path.display()) },
    };
    if raw.version != 1 || raw.at > MAX_AT || !is_hex64(&raw.lock_id) || raw.tx_hash.as_deref().is_some_and(|h| !is_hex64(h)) {
        return Reading::Unreadable { note: format!("{} does not have the reveal sidecar's fields; it is ignored", path.display()) };
    }
    match lock_id {
        Some(id) if hex::encode(id) == raw.lock_id => Reading::Matching { tx_hash: raw.tx_hash, at: raw.at },
        Some(_) => Reading::Foreign { note: format!("{} belongs to another lock ({}), not this swap's; it is ignored", path.display(), raw.lock_id) },
        None => Reading::Foreign { note: format!("{} exists but this swap's file has no lock yet, so it cannot be matched and is ignored", path.display()) },
    }
}

/// Alice's file only: read the sidecar beside `swap_file` and, for a sidecar of THIS lock, record [`REVEAL_SIDECAR_SEEN`] once in `file` (in
/// memory; the caller saves it with `--apply`). Returns the notes to show. Call it before the decision, so this very decision already judges
/// a re-send by the late cutoff.
pub fn note_sidecar(file: &mut SwapFile, swap_file: &Path, now: u64) -> Vec<String> {
    if file.role != Role::Alice {
        return Vec::new();
    }
    match read(swap_file, alice_lock_id(file)) {
        Reading::Absent => Vec::new(),
        Reading::Matching { tx_hash, at } => {
            let first = last_history(file, REVEAL_SIDECAR_SEEN).is_none();
            if first {
                file.log(REVEAL_SIDECAR_SEEN, now);
            }
            vec![format!(
                "the reveal sidecar {} shows a reveal send was started at {at}{}: the secret may already be public, so a re-send is judged by the late cutoff T_reveal - DE (a send that started need not have reached the network){}",
                path_for(swap_file).display(),
                tx_hash.map(|h| format!(" (transaction 0x{h})")).unwrap_or_default(),
                if first { "" } else { " (already recorded in the file)" }
            )]
        }
        Reading::Foreign { note } | Reading::Unreadable { note } => vec![note],
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write(dir: &Path, body: &str) -> PathBuf {
        let swap = dir.join("a.swap.json");
        std::fs::write(path_for(&swap), body).unwrap();
        swap
    }

    #[test]
    fn name_is_the_swap_file_name_plus_suffix() {
        assert_eq!(path_for(Path::new("/x/y/a.swap.json")), PathBuf::from("/x/y/a.swap.json.reveal-sent"));
    }

    #[test]
    fn absent_matching_foreign_and_unreadable() {
        let dir = tempfile::tempdir().unwrap();
        let id = [0xabu8; 32];
        let swap = dir.path().join("a.swap.json");
        assert_eq!(read(&swap, Some(id)), Reading::Absent);
        let good = format!(r#"{{"version":1,"lock_id":"{}","tx_hash":null,"at":1700000000}}"#, hex::encode(id));
        write(dir.path(), &good);
        assert_eq!(read(&swap, Some(id)), Reading::Matching { tx_hash: None, at: 1_700_000_000 });
        let with_hash = format!(r#"{{"version":1,"lock_id":"{}","tx_hash":"{}","at":5}}"#, hex::encode(id), hex::encode([1u8; 32]));
        write(dir.path(), &with_hash);
        assert_eq!(read(&swap, Some(id)), Reading::Matching { tx_hash: Some(hex::encode([1u8; 32])), at: 5 });
        assert!(matches!(read(&swap, Some([0xcdu8; 32])), Reading::Foreign { .. }), "another lock id");
        assert!(matches!(read(&swap, None), Reading::Foreign { .. }), "no lock in the file yet");
        for bad in ["", "not json", "{}", r#"{"version":2,"lock_id":"00","tx_hash":null,"at":1}"#, &good.replace("\"version\":1", "\"version\":9"), &good.replace("\"at\":1700000000", "\"at\":-1"), &good.replace("\"tx_hash\":null,", ""), &good.replace("\"at\":1700000000", "\"at\":9007199254740992")] {
            write(dir.path(), bad);
            assert!(matches!(read(&swap, Some(id)), Reading::Unreadable { .. }), "{bad}");
        }
        let upper = good.replace(&hex::encode(id), &hex::encode(id).to_uppercase());
        write(dir.path(), &upper);
        assert!(matches!(read(&swap, Some(id)), Reading::Unreadable { .. }), "the format is lower-case hex");
        write(dir.path(), &" ".repeat(5000));
        assert!(matches!(read(&swap, Some(id)), Reading::Unreadable { .. }), "too large");
    }

    #[cfg(unix)]
    #[test]
    fn a_swap_file_given_by_a_link_finds_the_sidecar_beside_the_real_file_and_beside_the_link() {
        let dir = tempfile::tempdir().unwrap();
        let id = [0xabu8; 32];
        let good = format!(r#"{{"version":1,"lock_id":"{}","tx_hash":null,"at":7}}"#, hex::encode(id));
        let real = dir.path().join("real.swap.json");
        std::fs::write(&real, "{}").unwrap();
        let link = dir.path().join("link.swap.json");
        std::os::unix::fs::symlink(&real, &link).unwrap();
        assert_eq!(read(&link, Some(id)), Reading::Absent, "no sidecar anywhere");
        // live.js wrote it beside the real path: a tick given the link name still sees it.
        std::fs::write(path_for(&std::fs::canonicalize(&real).unwrap()), &good).unwrap();
        assert_eq!(read(&link, Some(id)), Reading::Matching { tx_hash: None, at: 7 });
        std::fs::remove_file(path_for(&std::fs::canonicalize(&real).unwrap())).unwrap();
        // an older live.js wrote it beside the link name: still seen.
        std::fs::write(path_for(&link), &good).unwrap();
        assert_eq!(read(&link, Some(id)), Reading::Matching { tx_hash: None, at: 7 });
        // a good one beside the link beats an unreadable one beside the real path.
        std::fs::write(path_for(&std::fs::canonicalize(&real).unwrap()), "not json").unwrap();
        assert_eq!(read(&link, Some(id)), Reading::Matching { tx_hash: None, at: 7 });
    }

    #[test]
    fn the_verbatim_prefix_of_a_windows_path_is_removed_and_a_unc_path_is_left_alone() {
        assert_eq!(strip_verbatim(PathBuf::from(r"\\?\C:\Users\x\a.json")), PathBuf::from(r"C:\Users\x\a.json"));
        assert_eq!(strip_verbatim(PathBuf::from(r"\\?\UNC\host\share\a.json")), PathBuf::from(r"\\?\UNC\host\share\a.json"));
        assert_eq!(strip_verbatim(PathBuf::from("/x/y/a.json")), PathBuf::from("/x/y/a.json"));
    }

    #[test]
    fn a_directory_is_not_a_sidecar() {
        let dir = tempfile::tempdir().unwrap();
        let swap = dir.path().join("a.swap.json");
        std::fs::create_dir(path_for(&swap)).unwrap();
        assert!(matches!(read(&swap, Some([1; 32])), Reading::Unreadable { .. }));
    }
}
