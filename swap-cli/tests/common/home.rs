//! Test isolation for the per-machine hashlock registry (G5). `new-alice` and `new-bob` write `$NOID_SWAP_HOME/hashlocks.txt` (else
//! `$HOME/.noid-swap/hashlocks.txt`), so a test that starts the binary must never reach the real home. Every command made here gets its own
//! empty `NOID_SWAP_HOME`, a temporary directory that is removed when the calling test (its thread) ends. A test that wants two commands to
//! share one machine registry sets `NOID_SWAP_HOME` itself afterwards (a later `.env` replaces this one).

use std::cell::RefCell;
use std::path::PathBuf;
use std::process::Command;

thread_local! {
    static HOMES: RefCell<Vec<tempfile::TempDir>> = const { RefCell::new(Vec::new()) };
}

/// A fresh, empty directory to be used as `NOID_SWAP_HOME`; it lives until the calling thread ends.
#[allow(dead_code)]
pub fn fresh_home() -> PathBuf {
    let dir = tempfile::tempdir().expect("temporary home");
    let path = dir.path().to_path_buf();
    HOMES.with(|h| h.borrow_mut().push(dir));
    path
}

/// The `swap-cli` binary with an isolated registry home.
#[allow(dead_code)]
pub fn isolated_bin() -> Command {
    let mut cmd = Command::new(env!("CARGO_BIN_EXE_swap-cli"));
    cmd.env("NOID_SWAP_HOME", fresh_home());
    cmd
}
