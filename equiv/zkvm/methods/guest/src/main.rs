//! RISC Zero guest: proves  exists m: sha256(m) = H  and  A = Addr(m) | Addr(Derive(m, 0)).
//! `m` never leaves the guest; only `variant || H || A` is committed to the journal.
//!
//! A std guest (plain `fn main`, no `no_main`/`entry!`), so it also type-checks as a normal
//! crate on the host: `cargo check` in this directory.

use risc0_zkvm::guest::env;

fn main() {
    let variant: u8 = env::read();
    let m: [u8; 32] = env::read();
    let public = equiv_guest_core::run(variant, &m).expect("unknown variant");
    // raw bytes, no framing: journal == variant(1) || H(32) || A(32)
    env::commit_slice(&public);
}
