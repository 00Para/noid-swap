//! The gaps of `docs/hostile-run-plan.md` section 6 that can be shown offline. Each test pins what the engine does TODAY. The comment above
//! each one says whether that behaviour is the one wanted or a recorded weakness; a test whose name ends in `_current_behaviour` documents a
//! weakness (nothing is fixed here: a change of the engine is a later, reviewed step, and this file then changes with it).
//!
//! Not in this file: G7 (Alice's file after a reveal sent outside the tool; not part of this batch), G8 (`recover-noid.sh` against an
//! instance of another amount: a shell helper, not testable offline without a scripted wallet in `scripts/live/selftest.sh`), G10 (the
//! mempool stall under load: not testable offline without an isolated node and a fee override) and G11 (a consistent lie from the only node:
//! a stated limit of `--single-node-ok`, not a test gap).

mod common;
#[path = "common/bundle_text.rs"]
mod bundle_text;
#[path = "common/equiv_stub.rs"]
mod equiv_stub;

use std::path::{Path, PathBuf};
use std::process::Command;

use common::*;
use swap_cli::engine::{check_external_close_phase, external_close_event, tick_apply, Action};
use swap_cli::params::{ContractVersion, ProfileName};
use swap_cli::secret::{LockKind, Variant};
use swap_cli::state::{BobPhase, Phase};
use swap_cli::watch::eth::compute_lock_id;
use swap_cli::watch::{EthLock, PendingPreimage, RevertedClaim, WordLock};

// ------------------------------------------------------------------------------------------------ simulator helpers

fn scenario(kind: LockKind) -> Scenario {
    Scenario::with_kind(Variant::Raw, ProfileName::Production, ContractVersion::V1, kind)
}

const KINDS: [LockKind; 2] = [LockKind::Sha256, LockKind::Poseidon];

/// Alice has funded and her funding is final; Bob's file has not been ticked.
fn alice_at_funding_final(kind: LockKind) -> Scenario {
    let mut s = scenario(kind);
    assert_eq!(s.tick_alice().action.kind(), "fund_noid");
    s.world.borrow_mut().advance_noid(1);
    s.tick_alice();
    s.world.borrow_mut().advance_noid(17);
    s.tick_alice();
    assert_eq!(s.alice_phase(), "funding_final");
    s
}

/// Alice's funding is final and Bob's file has seen the funding (`funded`), but Bob has not ticked since it became final.
fn bob_ready(kind: LockKind) -> Scenario {
    let mut s = scenario(kind);
    s.tick_alice();
    s.world.borrow_mut().advance_noid(1);
    s.tick_both();
    s.world.borrow_mut().advance_noid(17);
    s.tick_alice();
    assert_eq!(s.bob_phase(), "funded");
    s
}

/// A `Locked` record made by hand (not by the tool): the terms the swap names, except what the caller changes.
fn hand_lock(s: &Scenario, sender: [u8; 20], receiver: [u8; 20], hashlock: [u8; 32], t_reveal: u64) -> EthLock {
    let amount = s.public.params.eth.amount_wei;
    EthLock {
        lock_id: compute_lock_id(&sender, &receiver, amount, &hashlock, t_reveal),
        sender,
        receiver,
        amount_wei: amount,
        hashlock,
        timelock: t_reveal,
        block_number: 0,
        tx_hash: [0xcc; 32],
        claimed: false,
        refunded: false,
        receiver_is_eoa: Some(true),
        sender_is_eoa: Some(true),
        block_timestamp: None,
    }
}

/// The agreed lock, with a reveal window of `window` seconds from the moment it is mined.
fn agreed_lock(s: &Scenario, window: u64) -> EthLock {
    let p = &s.public.params.eth;
    hand_lock(s, p.bob_sender, p.alice_receiver, s.public.hashlock, s.now() + window)
}

/// Put the lock into the next Ethereum block (its block number and timestamp are filled by the simulator).
fn mine(s: &Scenario, lock: EthLock) {
    let mut w = s.world.borrow_mut();
    w.lock_pending = Some(lock);
    w.advance_eth(1);
}

fn has_note(notes: &[String], needle: &str) -> bool {
    notes.iter().any(|n| n.contains(needle))
}

// ================================================================================================ G1

/// G1 (B2): Alice facing a lock of Bob's that was mined after Bob's last lock height, every other term right.
///
/// CURRENT BEHAVIOUR, A RECORDED WEAKNESS. `alice_check_lock` looks at the terms, the reveal window (I3) and the margin `M_A`; it looks at
/// neither Bob's lock-by nor `D`. So Alice's file takes the lock (`eth_lock_seen`), waits for Ethereum finality (`eth_lock_final`) and then
/// offers `reveal_eth`, with no note that Bob locked late and that his claim may not fit before `D`. It can only harm Bob, whose own tool
/// refuses to lock past that height (the contrast at the end of the test). Whether Alice should refuse or warn is a later decision.
#[test]
fn g1_alice_accepts_and_reveals_on_a_lock_made_after_bobs_lock_by_current_behaviour() {
    for kind in KINDS {
        let mut s = alice_at_funding_final(kind);
        let g = s.gates();
        let d = s.public.params.deadline_height;
        let hard = g.bob_lock_by_min_window(d);
        // The Parano1d tip moves past Bob's last possible lock height (still well before D).
        let tip = s.world.borrow().tip;
        s.world.borrow_mut().advance_noid(hard + 5 - tip);
        let tip = s.world.borrow().tip;
        assert!(tip > hard && tip + 1 < d, "tip {tip}, last lock height {hard}, D {d}");
        let lock = agreed_lock(&s, g.w_a_s);
        mine(&s, lock.clone());
        let r = s.tick_alice();
        assert_eq!(r.events, vec!["eth_lock_seen"], "{kind}: {r:?}");
        assert_eq!(s.alice_phase(), "lock_seen", "{kind}");
        assert!(matches!(&r.action, Action::Wait { reason } if reason == "waiting for Bob's lock to be finalized"), "{kind}: {r:?}");
        assert!(!has_note(&r.notes, "lock-by") && !has_note(&r.notes, "late") && !has_note(&r.notes, "after"), "{kind}: no note about the late lock: {:?}", r.notes);
        let lag = s.world.borrow().finality_lag;
        s.world.borrow_mut().advance_eth(lag + 1);
        let r = s.tick_alice();
        assert_eq!(r.events, vec!["eth_lock_final", "reveal_submitted"], "{kind}: {r:?}");
        assert_eq!(r.action.kind(), "reveal_eth", "{kind}: {r:?}");
        assert_eq!(s.alice_phase(), "reveal_submitted", "{kind}");
        assert!(!has_note(&r.notes, "lock-by"), "{kind}: {:?}", r.notes);
    }
    // The contrast: Bob's own tool, at the same height, does not lock; it ends `aborted`.
    let mut s = bob_ready(LockKind::Sha256);
    let g = s.gates();
    let hard = g.bob_lock_by_min_window(s.public.params.deadline_height);
    let tip = s.world.borrow().tip;
    s.world.borrow_mut().advance_noid(hard + 5 - tip);
    let rb = s.tick_bob();
    assert_eq!(rb.action.kind(), "abort", "{rb:?}");
    assert!(matches!(&rb.action, Action::Abort { reason } if reason.contains("not locking") && reason.contains("lock-by")), "{rb:?}");
    assert_eq!(s.bob_phase(), "aborted");
}

// ================================================================================================ G2

/// G2 (B4, B7), Alice: a lock with another receiver, and a lock with another lock word, put straight into the observation (bypassing the
/// discovery, which would not even find them).
///
/// DESIRED BEHAVIOUR. `lock_matches` refuses both: no `eth_lock_seen`, the note `lock rejected: receiver is not A_eth` or
/// `lock rejected: hashlock differs`, and the reason `Bob's lock did not pass the checks`. Alice's file stays in `funding_final`.
#[test]
fn g2_alice_does_not_take_a_lock_with_another_receiver_or_another_lock_word() {
    for kind in KINDS {
        for (what, receiver, word, note) in [
            ("receiver", Some([0xc7; 20]), None, "lock rejected: receiver is not A_eth"),
            ("lock word", None, Some([0x42; 32]), "lock rejected: hashlock differs"),
        ] {
            let mut s = alice_at_funding_final(kind);
            let p = s.public.params.eth.clone();
            let lock = hand_lock(&s, p.bob_sender, receiver.unwrap_or(p.alice_receiver), word.unwrap_or(s.public.hashlock), s.now() + 7_200);
            mine(&s, lock);
            let lag = s.world.borrow().finality_lag;
            s.world.borrow_mut().advance_eth(lag + 1);
            let r = s.tick_alice();
            assert!(r.events.is_empty(), "{kind} {what}: {r:?}");
            assert_eq!(s.alice_phase(), "funding_final", "{kind} {what}");
            assert!(matches!(&r.action, Action::Wait { reason } if reason == "Bob's lock did not pass the checks"), "{kind} {what}: {r:?}");
            assert!(has_note(&r.notes, note), "{kind} {what}: {:?}", r.notes);
        }
    }
}

/// G2 (B4, B7), Bob: the same two locks seen by Bob's own check (`sha256` kind; the `poseidon` kind adds the own-word refusal, which
/// `bob_does_not_lock_on_a_word_that_his_own_sender_already_locked_but_a_strangers_lock_only_makes_a_note` covers).
///
/// DESIRED BEHAVIOUR. Bob's file does not adopt a lock that is not the agreed one: no `eth_lock_seen`, the note `a lock exists but is not
/// ours: …`. With the `sha256` kind nothing stops him from sending the real lock next, so the action is `lock_eth` with the agreed receiver.
#[test]
fn g2_bob_does_not_take_a_lock_with_another_receiver_or_another_lock_word_as_his_own() {
    for (what, receiver, word, note) in [
        ("receiver", Some([0xc7; 20]), None, "a lock exists but is not ours: receiver is not A_eth"),
        ("lock word", None, Some([0x42; 32]), "a lock exists but is not ours: hashlock differs"),
    ] {
        let mut s = bob_ready(LockKind::Sha256);
        let p = s.public.params.eth.clone();
        let lock = hand_lock(&s, p.bob_sender, receiver.unwrap_or(p.alice_receiver), word.unwrap_or(s.public.hashlock), s.now() + 7_200);
        mine(&s, lock);
        let r = s.tick_bob();
        assert!(!r.events.contains(&"eth_lock_seen".to_string()), "{what}: {r:?}");
        assert!(has_note(&r.notes, note), "{what}: {:?}", r.notes);
        assert!(matches!(&r.action, Action::LockEth { receiver, .. } if *receiver == p.alice_receiver), "{what}: {r:?}");
        assert_eq!(s.bob_phase(), "lock_submitted", "{what}");
    }
}

// ================================================================================================ the bundle through the binary

const CODE_HASH: &str = "0xa906117fc4e604bd25fcee2a6a41da8b824ec9b4a17d10137704e7da42545e2f";
const PASS: &str = "correct horse battery staple";

fn bin() -> Command {
    Command::new(env!("CARGO_BIN_EXE_swap-cli"))
}

fn run(cmd: &mut Command) -> (bool, String, String) {
    let out = cmd.output().expect("run swap-cli");
    (out.status.success(), String::from_utf8_lossy(&out.stdout).into_owned(), String::from_utf8_lossy(&out.stderr).into_owned())
}

struct Cli {
    dir: tempfile::TempDir,
    cast: swap_cli::htlc_harness::Cast,
    bundle_text: String,
    stub: Vec<String>,
}

fn new_alice_args(cast: &swap_cli::htlc_harness::Cast, out: &Path, amount: &str) -> Vec<String> {
    let alice = cast.alice.to_bech32();
    let bob = cast.bob.to_bech32();
    [
        "new-alice", "--out", out.to_str().unwrap(), "--alice", &alice, "--bob", &bob, "--amount", amount, "--fee-estimate", "5800", "--h-create", "300000",
        "--eth-chain-id", "31337", "--eth-contract", "0x5fbdb2315678afecb367f032d93f642f64180aa3", "--eth-amount-wei", "10000000000000000",
        "--eth-receiver", "0x3c44cdddb6a900fa2b585dd299e03d12fa4293bc", "--eth-sender", "0x70997970c51812dc3a010c7d01b50e0d17dc79c8", "--eth-code-hash", CODE_HASH,
        "--fast-kdf",
    ]
    .iter()
    .map(|s| s.to_string())
    .collect()
}

fn cli() -> Cli {
    let dir = tempfile::tempdir().unwrap();
    let cast = swap_cli::htlc_harness::Cast::new();
    let out = dir.path().join("a.swap.json");
    let (ok, bundle_text, err) = run(bin().args(new_alice_args(&cast, &out, "10000000")).env("SWAP_PASSPHRASE", PASS));
    assert!(ok, "{err}");
    let stub = equiv_stub::receipt_flags(dir.path());
    Cli { dir, cast, bundle_text, stub }
}

impl Cli {
    /// Bob's own folder (a separate one: `new-alice` registers the hashlock in the folder of ITS output, see G4).
    fn bob_dir(&self) -> PathBuf {
        let d = self.dir.path().join("bob");
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    fn write_bundle(&self, name: &str, text: &str) -> PathBuf {
        let path = self.dir.path().join(format!("{name}.bundle.json"));
        std::fs::write(&path, text).unwrap();
        path
    }

    /// `new-bob` with Bob's own terms (`amount` is the NOID amount he types). No `--registry`: the default location is used.
    fn new_bob(&self, bundle: &Path, out: &Path, amount: &str) -> (bool, String, String) {
        run(bin()
            .args(["new-bob", "--bundle", bundle.to_str().unwrap(), "--out", out.to_str().unwrap(), "--bob", &self.cast.bob.to_bech32()])
            .args(["--amount", amount, "--eth-chain-id", "31337", "--eth-contract", "0x5fbdb2315678afecb367f032d93f642f64180aa3"])
            .args(["--eth-amount-wei", "10000000000000000", "--eth-sender", "0x70997970c51812dc3a010c7d01b50e0d17dc79c8", "--eth-code-hash", CODE_HASH])
            .args(&self.stub))
    }
}

// ================================================================================================ G3

/// G3 (A4), the deadline: a bundle that is internally consistent (its `bundle_check` verifies, its opening rebuilds byte-for-byte from its own
/// parameters, `lock_by_height` follows from its `D`) but whose deadline is `h_create` + 835, not `h_create` + the profile's 735.
///
/// DESIRED BEHAVIOUR. `new-bob` refuses it with `deadline 300835 != h_create 300000 + 735 (the production profile's D_offset)` and writes no
/// file. (A bundle whose deadline was changed without rebuilding the opening is refused earlier, by the carrier check or the rebuild:
/// `bundle_check.rs`.)
#[test]
fn g3_new_bob_refuses_a_consistent_bundle_whose_deadline_is_not_h_create_plus_the_profile_offset() {
    let f = cli();
    let (mut public, _) = swap_cli::bundle::open_bundle(&f.bundle_text, false).unwrap();
    assert_eq!(public.params.deadline_height, 300_735);
    let d = public.params.deadline_height + 100;
    public.params.deadline_height = d;
    public.params.lock_by_height = public.params.profile.gates().bob_lock_by(d);
    let opening = swap_cli::htlc_harness::try_compile_htlc(public.authority().unwrap(), f.cast.bob, f.cast.alice, d, public.params.max_fee_micronoid).unwrap();
    public.opening_hex = hex::encode(opening.to_bytes().unwrap());
    public.contract_root = opening.root().to_bech32();
    // The carrier check is the one `new-alice` would have written for these values.
    let text = bundle_text::checked_text(&public);
    assert!(swap_cli::bundle::open_bundle(&text, false).is_ok());
    let err = public.check().unwrap_err().to_string();
    assert!(err.contains("deadline 300835 != h_create 300000 + 735 (the production profile's D_offset)"), "{err}");
    let bundle = f.write_bundle("late-d", &text);
    let out = f.bob_dir().join("late-d.swap.json");
    let (ok, stdout, stderr) = f.new_bob(&bundle, &out, "10000000");
    assert!(!ok && stdout.is_empty(), "{stderr}");
    assert!(stderr.contains("deadline 300835 != h_create 300000 + 735 (the production profile's D_offset)"), "{stderr}");
    assert!(stderr.contains("bundle check: ") && stderr.contains(" ok"), "the carrier check passed before the refusal: {stderr}");
    assert!(!out.exists() && !f.bob_dir().join("hashlocks.txt").exists());
}

/// G3 (A5), the NOID amount: a valid bundle for 10 NOID offered to a Bob who typed another amount.
///
/// DESIRED BEHAVIOUR. `new-bob` refuses it: `bundle disagrees with your terms: amount_micronoid`; no file, no registry entry.
///
/// Also pinned here: the desk check L0 (b) of the plan, `new-alice --amount 4000000`, cannot be run as written. The close-fee cap
/// (50,000 micro-NOID) is more than 1 % of 4 NOID, so `new-alice` itself refuses before any bundle exists; a bundle for another amount has to
/// be made at 5 NOID or more (a cap of 50,000 is exactly 1 % of 5 NOID) and Bob types another figure.
#[test]
fn g3_new_bob_refuses_a_bundle_whose_noid_amount_is_not_the_one_bob_typed() {
    let f = cli();
    let bundle = f.write_bundle("ok", &f.bundle_text);
    let out = f.bob_dir().join("b.swap.json");
    let (ok, stdout, stderr) = f.new_bob(&bundle, &out, "9000000");
    assert!(!ok && stdout.is_empty(), "{stderr}");
    assert!(stderr.contains("bundle disagrees with your terms: amount_micronoid"), "{stderr}");
    assert!(!out.exists() && !f.bob_dir().join("hashlocks.txt").exists());
    // The same bundle with the amount Bob agreed is accepted (the refusal above is the amount alone).
    let (ok, _, stderr) = f.new_bob(&bundle, &out, "10000000");
    assert!(ok, "{stderr}");
    // The plan's L0 (b) as written.
    let a = f.dir.path().join("four.swap.json");
    let (ok, stdout, stderr) = run(bin().args(new_alice_args(&f.cast, &a, "4000000")).env("SWAP_PASSPHRASE", PASS));
    assert!(!ok && stdout.is_empty() && !a.exists(), "{stderr}");
    assert!(stderr.contains("1 %"), "{stderr}");
}

// ================================================================================================ G4

/// G4 (D2): the same bundle given to `new-bob` twice.
///
/// DESIRED BEHAVIOUR. Into the same output path: `… already exists; never overwrite a swap file`. Into another file of the same folder (the
/// default registry is `hashlocks.txt` next to the output): `hashlock already used by another swap (T9)`; no second file. Both refusals leave
/// the first file and the registry as they were. (A replay across folders is G5.)
#[test]
fn g4_a_bundle_given_to_new_bob_twice_into_one_folder_is_refused_the_second_time() {
    let f = cli();
    let bundle = f.write_bundle("ok", &f.bundle_text);
    let first = f.bob_dir().join("bob1.swap.json");
    let (ok, _, stderr) = f.new_bob(&bundle, &first, "10000000");
    assert!(ok, "{stderr}");
    let registry = f.bob_dir().join("hashlocks.txt");
    let before = std::fs::read_to_string(&registry).unwrap();
    assert_eq!(before.lines().count(), 1);
    let file_before = std::fs::read(&first).unwrap();
    // Same output path.
    let (ok, stdout, stderr) = f.new_bob(&bundle, &first, "10000000");
    assert!(!ok && stdout.is_empty(), "{stderr}");
    assert!(stderr.contains("already exists; never overwrite a swap file"), "{stderr}");
    // Another file name, same folder: the registry.
    let second = f.bob_dir().join("bob2.swap.json");
    let (ok, stdout, stderr) = f.new_bob(&bundle, &second, "10000000");
    assert!(!ok && stdout.is_empty(), "{stderr}");
    assert!(stderr.contains("hashlock already used by another swap (T9)"), "{stderr}");
    assert!(!second.exists());
    assert_eq!(std::fs::read_to_string(&registry).unwrap(), before);
    assert_eq!(std::fs::read(&first).unwrap(), file_before);
    // Alice's own `new-alice` registered the hashlock in the folder of ITS output, so a Bob file made in Alice's folder is refused the same
    // way on the first try (the helper scripts keep Bob's file in `$L/bob/` for that reason).
    let in_alices_folder = f.dir.path().join("bob-here.swap.json");
    let (ok, _, stderr) = f.new_bob(&bundle, &in_alices_folder, "10000000");
    assert!(!ok && stderr.contains("hashlock already used by another swap (T9)") && !in_alices_folder.exists(), "{stderr}");
}

/// G4 (D2), the first tick after the replay: a Bob file made from a finished swap's bundle (`received`), a Parano1d tip past `D`, and an old
/// `Locked` log of Bob's own sender on the word (`poseidon` kind).
///
/// DESIRED BEHAVIOUR. The file is accepted by `new-bob` (the bundle is valid, see the test above) and its first tick is `abort`
/// (`last lock height … passed before Alice's funding was final`); the old lock does not change that, and nothing is locked.
#[test]
fn g4_the_first_tick_of_a_replayed_bundle_is_an_abort_not_a_lock() {
    let mut s = scenario(LockKind::Poseidon);
    let d = s.public.params.deadline_height;
    let tip = s.world.borrow().tip;
    s.world.borrow_mut().advance_noid(d + 10 - tip);
    let bob = s.public.params.eth.bob_sender;
    s.world.borrow_mut().word_locks_extra.push(WordLock { lock_id: [0xdd; 32], sender: bob, receiver: [0xa1; 20], amount_wei: 7, timelock: 1_700_000_000, block_number: 3 });
    let last = s.gates().bob_lock_by_min_window(d);
    let r = s.tick_bob();
    assert_eq!(r.events, vec!["abort"], "{r:?}");
    assert!(matches!(&r.action, Action::Abort { reason } if *reason == format!("last lock height {last} passed before Alice's funding was final")), "{r:?}");
    assert_eq!(s.bob_phase(), "aborted");
    assert!(s.world.borrow().lock_pending.is_none());
}

// ================================================================================================ G5

/// G5 (D3): two `new-bob` runs on one bundle into two DIFFERENT folders, with the default registry location. (`new-alice` always draws a
/// fresh secret, so it cannot produce the same hashlock twice; the reuse that matters is a bundle offered again.)
///
/// CURRENT BEHAVIOUR, A RECORDED WEAKNESS (defence in depth). The registry defaults to `hashlocks.txt` next to the output file, and the helper
/// scripts make a new folder per run, so the second run is NOT caught: both files are written, each folder gets its own registry holding the
/// same hashlock. The other lines of defence stand (Bob's own-word check on the chain for the `poseidon` kind, the fresh secret of every
/// `new-alice`). The fix is a per-machine default registry.
#[test]
fn g5_the_same_bundle_into_two_folders_is_not_caught_by_the_default_registry_current_behaviour() {
    let f = cli();
    let bundle = f.write_bundle("ok", &f.bundle_text);
    let a = tempfile::tempdir().unwrap();
    let b = tempfile::tempdir().unwrap();
    let out_a = a.path().join("bob.swap.json");
    let out_b = b.path().join("bob.swap.json");
    let (ok_a, _, err_a) = f.new_bob(&bundle, &out_a, "10000000");
    let (ok_b, _, err_b) = f.new_bob(&bundle, &out_b, "10000000");
    assert!(ok_a, "{err_a}");
    assert!(ok_b, "the second run is accepted today: {err_b}");
    assert!(out_a.exists() && out_b.exists());
    let (reg_a, reg_b) = (std::fs::read_to_string(a.path().join("hashlocks.txt")).unwrap(), std::fs::read_to_string(b.path().join("hashlocks.txt")).unwrap());
    assert_eq!(reg_a, reg_b, "each folder holds its own copy of the same hashlock");
    assert_eq!(reg_a.lines().count(), 1);
}

// ================================================================================================ G6

/// A poseidon swap with Alice's claim mined and REVERTED after `T_reveal`: the secret is in a block's calldata, not in a `Claimed` event and not
/// in the pending pool. Bob has locked; his file is `locked`.
fn reverted_claim_world() -> Scenario {
    let mut s = scenario(LockKind::Poseidon);
    s.run_to_lock_final();
    let (lock_id, timelock) = {
        let w = s.world.borrow();
        let l = w.lock.as_ref().unwrap();
        (l.lock_id, l.timelock)
    };
    let preimage = *s.secret.bytes();
    {
        let mut w = s.world.borrow_mut();
        w.claim_pending = Some(PendingPreimage { lock_id, preimage, tx_hash: [0xaa; 32] });
        w.warp_eth_to(timelock + 12);
        assert!(w.log.iter().any(|l| l.contains("claim REVERTED")), "{:?}", w.log);
        assert!(w.claim_pending.is_none() && w.claimed.is_none() && w.lock.as_ref().unwrap().claimed == false);
    }
    s
}

/// G6 (A8): the secret appears only in a mined, reverted claim. Without `--reveal-tx` the watcher does not look (`poseidon_kind.rs`:
/// "No flag, no read"), so the observation carries no `reverted_claim`; with the hash it does.
///
/// CURRENT BEHAVIOUR, A RECORDED WEAKNESS (low impact). Bob's file sees no secret: no event, and since `T_reveal` has passed the action is
/// `refund_eth`; he keeps his ETH and misses the NOID, which Alice can take back at `D`. With the hash (`--reveal-tx`, the observation of the
/// second half) the file records `eth_preimage_seen` and the action is `claim_noid`; the `refund_eth` that is also due waits behind it
/// (note `refund_eth is also due …`). Whether Bob's tool should look for a reverted claim by itself is a later decision.
#[test]
fn g6_bob_misses_a_secret_that_is_only_in_a_reverted_claim_unless_given_its_hash_current_behaviour() {
    // Without the hash.
    let mut s = reverted_claim_world();
    assert_eq!(s.bob_phase(), "locked");
    let r = s.tick_bob();
    assert_eq!(r.events, vec!["eth_refund_submitted"], "no eth_preimage_seen; the only event is the refund the tick itself sent: {r:?}");
    assert_eq!(r.action.kind(), "refund_eth", "{r:?}");
    assert_eq!(s.bob_phase(), "refund_submitted");
    assert!(!has_note(&r.notes, "preimage") && !has_note(&r.notes, "secret"), "{:?}", r.notes);
    // With the hash: the watcher reports the verified reverted claim.
    let mut s = reverted_claim_world();
    let (lock_id, preimage) = (s.world.borrow().lock.as_ref().unwrap().lock_id, *s.secret.bytes());
    s.world.borrow_mut().reverted_claim = Some(RevertedClaim { lock_id, preimage, tx_hash: [0xcd; 32], block_number: 9 });
    let r = s.tick_bob();
    assert_eq!(r.events, vec!["eth_preimage_seen", "claim_submitted"], "{r:?}");
    assert_eq!(r.action.kind(), "claim_noid", "{r:?}");
    assert!(has_note(&r.notes, "refund_eth is also due"), "{:?}", r.notes);
}

// ================================================================================================ G9

/// G9 (B5): Bob's file at `funding_final` (reached in the same tick) while Ethereum shows a lock from Bob's own sender on the agreed terms with a
/// `T_reveal` six hours above the engine's own upper bound (`Gates::t_max_eth`, the bound `choose_t_reveal` applies).
///
/// CURRENT BEHAVIOUR, A RECORDED WEAKNESS. `bob_fact` takes any lock of his sender on the agreed terms whatever its `T_reveal` (`lock_matches`
/// is called without a wanted `T_reveal`): the file adopts it (`eth_lock_seen`), is `locked` with that `T_reveal`, and the tick says `waiting for
/// the secret (or T_reveal)` with no note and no alarm. `refund_eth` opens only at that `T_reveal`, hours after `D`. Alice's check has no upper
/// bound either: her file takes the lock and offers `reveal_eth` once it is final (she can reveal at once, which is harmless; she can also keep
/// the secret until her cutoff, past the time Bob can still get a claim final before `D`). Only Bob can make such a lock (it needs his key), so
/// the harm is self-inflicted, but the tool should refuse to adopt it or raise an alarm. The fix (compare the adopted `T_reveal` with the bound)
/// is a later, reviewed engine change.
#[test]
fn g9_bob_adopts_a_hand_made_lock_with_a_t_reveal_far_beyond_the_engines_bound_current_behaviour() {
    for kind in KINDS {
        let mut s = bob_ready(kind);
        let (d, tip, t_now) = {
            let w = s.world.borrow();
            (s.public.params.deadline_height, w.tip, w.eth_time)
        };
        let g = s.gates();
        let t_max = g.t_max_eth(d, tip + 18, t_now).unwrap();
        let normal = g.choose_t_reveal(d, tip + 18, t_now, tip + 18).unwrap();
        assert!(normal <= t_max);
        let long = t_max + 6 * 3_600;
        let p = s.public.params.eth.clone();
        mine(&s, hand_lock(&s, p.bob_sender, p.alice_receiver, s.public.hashlock, long));
        assert!(g.check_i1_eth(d, tip + 18, long, t_now).is_err(), "the engine itself would refuse to lock with this T_reveal");
        let r = s.tick_bob();
        assert!(r.events.contains(&"eth_lock_seen".to_string()), "{kind}: {r:?}");
        assert_eq!(s.bob_phase(), "locked", "{kind}");
        assert!(matches!(&r.action, Action::Wait { reason } if reason == "waiting for the secret (or T_reveal)"), "{kind}: {r:?}");
        match &s.bob.file.phase {
            Phase::Bob(BobPhase::Locked { lock, .. }) => assert_eq!(lock.t_reveal, long, "{kind}"),
            other => panic!("{kind}: {other:?}"),
        }
        assert!(!has_note(&r.notes, "T_reveal") && !has_note(&r.notes, "ALARM"), "{kind}: no note and no alarm: {:?}", r.notes);
        // Alice, on the same chain: no upper bound either.
        let mut alice = bob_ready(kind);
        let p = alice.public.params.eth.clone();
        mine(&alice, hand_lock(&alice, p.bob_sender, p.alice_receiver, alice.public.hashlock, long));
        let ra = alice.tick_alice();
        assert_eq!(ra.events, vec!["eth_lock_seen"], "{kind}: {ra:?}");
        let lag = alice.world.borrow().finality_lag;
        alice.world.borrow_mut().advance_eth(lag + 1);
        let ra = alice.tick_alice();
        assert_eq!(ra.action.kind(), "reveal_eth", "{kind}: {ra:?}");
    }
}

// ================================================================================================ G12

/// G12 (T1, L4): `tick --closed-by TXID --apply` on a Bob file in `secret_seen` whose decision is `claim_noid` (the claim was not sent from
/// this machine). The binary does, in this order: `check_external_close_phase`, `external_close_event` on an observation that asked about the
/// txid, `SwapFile::apply` of the event, `tick_apply`; this test runs those four calls. (`claim_noid` is not an intent kind: the ledger holds
/// `fund_noid`, `lock_eth`, `reveal_eth`, `refund_eth` and `refund_noid`, so no intent is held for it and nothing has to be cancelled first.
/// The binary itself, over a mock node, is `cli_live.rs`: `tick_closed_by_records_an_outside_claim_only_with_apply_and_refuses_everything_doubtful`.)
///
/// DESIRED BEHAVIOUR. The phase is accepted, the close is recorded (`claim_included`, at the height the node confirms, before `D`), and the
/// next tick that sees the transaction 17 blocks deep ends the file in `done`. A file that has not seen the secret refuses the close by its phase.
#[test]
fn g12_closed_by_is_accepted_for_a_bob_file_whose_decision_is_claim_noid() {
    let mut s = scenario(LockKind::Sha256);
    s.run_to_lock_final();
    assert_eq!(s.tick_alice().action.kind(), "reveal_eth");
    s.world.borrow_mut().advance_eth(1);
    // Bob sees the secret but his claim is not sent from this machine.
    s.bob.executor.offline_for.insert("claim_noid");
    let rb = s.tick_bob();
    assert_eq!(rb.events, vec!["eth_preimage_seen"], "{rb:?}");
    assert_eq!(rb.action.kind(), "claim_noid", "{rb:?}");
    assert_eq!(s.bob_phase(), "secret_seen");
    let file = s.bob.file.clone();
    assert!(file.pending_intent.is_none(), "claim_noid is not an intent kind");
    // Somebody else (the wallet CLI) closes the instance to Bob, and the node confirms the transaction.
    let txid = s.world.borrow_mut().close_outside(false, Some(*s.secret.bytes()));
    let (noid, eth, now) = {
        let w = s.world.borrow();
        (w.noid_obs(Some(&txid)), w.eth_obs(), w.eth_time)
    };
    assert!(noid.instance.is_none() && noid.confirmed_tx.is_some());
    check_external_close_phase(&file, &txid).unwrap();
    let event = external_close_event(&file, &noid, &txid).unwrap();
    let mut work = file.clone();
    work.apply(&event, now).unwrap();
    assert_eq!(work.phase.name(), "claim_included");
    let out = tick_apply(&mut work, &noid, &eth, now, true).unwrap();
    assert!(matches!(out.decision.action, Action::Wait { .. }), "{:?}", out.decision);
    assert_eq!(work.phase.name(), "claim_included", "{:?}", out.decision);
    // Seventeen blocks later the file follows the recorded close to `done`.
    s.world.borrow_mut().advance_noid(17);
    let (noid, eth, now) = {
        let w = s.world.borrow();
        (w.noid_obs(Some(&txid)), w.eth_obs(), w.eth_time)
    };
    tick_apply(&mut work, &noid, &eth, now, true).unwrap();
    assert_eq!(work.phase.name(), "done");
    // The same close offered for a file that has not seen the secret is refused by the phase check (nothing is recorded).
    let fresh = bob_ready(LockKind::Sha256).bob.file.clone();
    assert!(check_external_close_phase(&fresh, &txid).is_err());
}
