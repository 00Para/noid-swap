//! The sealed wallet field of the swap file, and the standalone wallet file (swap wallet, piece 2a, amendments J and K).

#[path = "common/wallet_node.rs"]
mod wallet_node;

use htlc_harness as h;
use swap_cli::secret::{Secret, Variant};
use swap_cli::state::Role;
use swap_cli::swapfile::{example_bob_file, example_public, KdfParams, Passphrase, SwapFile, SwapFileError};
use swap_cli::wallet::key::WalletFile;
use swap_cli::wallet::WalletKey;
use wallet_node::Fx;

fn pass() -> Passphrase {
    Passphrase::new("a passphrase of enough length")
}

#[test]
fn a_file_made_before_the_wallet_existed_loads_and_decides_as_it_always_did() {
    let s = Secret::from_bytes(h::seq_bytes(0x33));
    let file = SwapFile::new_alice(example_public(&s, Variant::Raw), &s, &pass(), &KdfParams::fast_for_tests(), 0).unwrap();
    let text = serde_json::to_string_pretty(&file).unwrap();
    assert!(!text.contains("\"wallet\""), "an Alice file without a wallet does not write the field");
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("old.swap.json");
    std::fs::write(&path, &text).unwrap();
    let loaded = SwapFile::load(&path).unwrap();
    assert!(loaded.wallet.is_none());
    assert_eq!(loaded, file);
    assert!(matches!(loaded.decrypt_wallet(&pass()), Err(SwapFileError::Invalid(m)) if m.contains("no NOID swap wallet")));
    // and the claim secret opens exactly as before
    assert_eq!(loaded.decrypt_secret(&pass()).unwrap().bytes(), s.bytes());
}

#[test]
fn the_wallet_is_sealed_under_its_own_label_and_round_trips() {
    let fx = Fx::new(299_300);
    let loaded = SwapFile::load(&fx.path).unwrap();
    assert_eq!(loaded, fx.file);
    let m = loaded.decrypt_wallet(&pass()).unwrap();
    assert_eq!(WalletKey::from_secret(m).address(), fx.key.address());
    assert_eq!(loaded.wallet.as_ref().unwrap().address, loaded.public.params.alice_noid);
    // the plain file text holds neither secret
    let text = std::fs::read_to_string(&fx.path).unwrap();
    assert!(!text.contains(&hex::encode(fx.key.master().bytes())));
    // a wrong passphrase
    assert!(matches!(loaded.decrypt_wallet(&Passphrase::new("not the passphrase at all")), Err(SwapFileError::WrongPassphrase)));
}

#[test]
fn the_two_sealed_blobs_cannot_be_moved_into_each_others_place() {
    let fx = Fx::new(299_300);
    // the wallet blob where the claim secret goes
    let mut swapped = fx.file.clone();
    swapped.secret = Some(fx.file.wallet.as_ref().unwrap().secret.clone());
    assert!(matches!(swapped.decrypt_secret(&pass()), Err(SwapFileError::WrongPassphrase)), "the wallet blob does not open as the claim secret");
    // the claim-secret blob where the wallet goes
    let mut swapped = fx.file.clone();
    swapped.wallet.as_mut().unwrap().secret = fx.file.secret.clone().unwrap();
    assert!(matches!(swapped.decrypt_wallet(&pass()), Err(SwapFileError::WrongPassphrase)), "the claim blob does not open as the wallet");
    // the untouched ones still open
    assert!(fx.file.decrypt_secret(&pass()).is_ok() && fx.file.decrypt_wallet(&pass()).is_ok());
}

#[test]
fn the_payout_and_the_address_beside_the_blob_are_bound_to_it() {
    let fx = Fx::new(299_300);
    // another payout address in the file: the blob no longer opens, so no sweep can be built to it
    let mut moved = fx.file.clone();
    moved.wallet.as_mut().unwrap().payout = Some(h::addr(h::seq_bytes(0xAA)).to_bech32());
    assert!(matches!(moved.decrypt_wallet(&pass()), Err(SwapFileError::WrongPassphrase)));
    // the payout dropped
    let mut dropped = fx.file.clone();
    dropped.wallet.as_mut().unwrap().payout = None;
    assert!(matches!(dropped.decrypt_wallet(&pass()), Err(SwapFileError::WrongPassphrase)));
    // another address: the file does not even load
    let mut other = fx.file.clone();
    other.wallet.as_mut().unwrap().address = h::addr(h::seq_bytes(0xAB)).to_bech32();
    let path = fx.dir.path().join("other.swap.json");
    std::fs::write(&path, serde_json::to_vec_pretty(&other).unwrap()).unwrap();
    assert!(matches!(SwapFile::load(&path), Err(SwapFileError::Invalid(m)) if m.contains("recovery address")));
    // a changed public section: the blob is bound to its digest
    let mut public = fx.file.clone();
    public.public.params.amount_micronoid += 1;
    assert!(public.decrypt_wallet(&pass()).is_err());
}

#[test]
fn a_swap_with_a_wallet_is_refused_unless_the_pieces_agree() {
    let claim = Secret::from_bytes(h::seq_bytes(0x70));
    let wallet = Secret::from_bytes(h::seq_bytes(0x50));
    let wallet_addr = WalletKey::from_secret(wallet.clone()).address();
    let cast = h::Cast::new();
    let build = |alice: &noid_poseidon2b::primitives::Address| {
        swap_cli::swapfile::SwapPublic::build_with_options(
            &claim,
            Variant::Raw,
            swap_cli::params::ProfileName::Production,
            swap_cli::params::ContractVersion::V1,
            alice,
            &cast.bob,
            10_000_000,
            5_800,
            300_000,
            swap_cli::swapfile::EthParams {
                chain_id: 1,
                contract: [0x11; 20],
                code_hash: Some(swap_cli::params::code_hash_for(swap_cli::secret::LockKind::Sha256)),
                lock_kind: swap_cli::secret::LockKind::Sha256,
                amount_wei: 10u128.pow(16),
                alice_receiver: [0xa1; 20],
                bob_sender: [0xb0; 20],
            },
        )
        .unwrap()
    };
    let kdf = KdfParams::fast_for_tests();
    // the recovery address is not the wallet's
    let r = SwapFile::new_alice_with_wallet(build(&cast.alice), &claim, &wallet, None, &pass(), &kdf, 0);
    assert!(matches!(r, Err(SwapFileError::Invalid(m)) if m.contains("not the swap wallet's address")));
    // the wallet secret is the claim secret
    let public = build(&WalletKey::from_secret(claim.clone()).address());
    let r = SwapFile::new_alice_with_wallet(public, &claim, &claim, None, &pass(), &kdf, 0);
    assert!(matches!(r, Err(SwapFileError::Invalid(m)) if m.contains("fresh secret")));
    // the public test vector as a wallet secret
    let vector = Secret::from_bytes(h::seq_bytes(0));
    let r = SwapFile::new_alice_with_wallet(build(&WalletKey::from_secret(vector.clone()).address()), &claim, &vector, None, &pass(), &kdf, 0);
    assert!(r.is_err());
    // a payout that is the contract or the wallet itself
    let public = build(&wallet_addr);
    let root = noid_poseidon2b::primitives::Address::parse(&public.contract_root).unwrap();
    for bad in [root, wallet_addr] {
        let r = SwapFile::new_alice_with_wallet(public.clone(), &claim, &wallet, Some(&bad), &pass(), &kdf, 0);
        assert!(matches!(r, Err(SwapFileError::Invalid(m)) if m.contains("payout")), "{bad:?}");
    }
    // and the right one is accepted
    let ok = SwapFile::new_alice_with_wallet(public, &claim, &wallet, Some(&cast.mallory), &pass(), &kdf, 0).unwrap();
    assert_eq!(ok.role, Role::Alice);
}

#[test]
fn a_wallet_in_bobs_file_is_refused_at_load() {
    let s = Secret::from_bytes(h::seq_bytes(0x33));
    let mut bob = example_bob_file(example_public(&s, Variant::Raw), 0).unwrap();
    let fx = Fx::new(299_300);
    bob.wallet = fx.file.wallet.clone();
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("bob.swap.json");
    std::fs::write(&path, serde_json::to_vec_pretty(&bob).unwrap()).unwrap();
    assert!(matches!(SwapFile::load(&path), Err(SwapFileError::Invalid(m)) if m.contains("Alice's file only")));
}

#[test]
fn the_standalone_wallet_file_seals_opens_and_is_not_the_swap_files_blob() {
    let key = WalletKey::generate().unwrap();
    let kdf = KdfParams::fast_for_tests();
    let wf = WalletFile::create(&key, &pass(), &kdf).unwrap();
    assert_eq!(wf.address, key.address().to_bech32());
    let text = serde_json::to_string(&wf).unwrap();
    assert!(!text.contains(&hex::encode(key.master().bytes())));
    assert_eq!(wf.open(&pass()).unwrap().address(), key.address());
    assert!(wf.open(&Passphrase::new("not the passphrase at all")).is_err());
    // the address beside the blob is bound
    let mut moved = wf.clone();
    moved.address = h::addr(h::seq_bytes(0xAC)).to_bech32();
    assert!(moved.open(&pass()).is_err());
    // never overwritten
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("w.json");
    wf.save_new(&path).unwrap();
    assert!(wf.save_new(&path).is_err());
    assert_eq!(WalletFile::load(&path).unwrap(), wf);
    // the blob of a wallet file does not open as the swap file's wallet field (another label)
    let fx = Fx::new(299_300);
    let mut forged = fx.file.clone();
    let w = forged.wallet.as_mut().unwrap();
    w.secret = wf.secret.clone();
    assert!(forged.decrypt_wallet(&pass()).is_err());
    assert!(WalletFile::load(&dir.path().join("missing.json")).is_err());
}

#[test]
fn a_wallet_secret_never_shows_in_a_debug_print_of_the_file() {
    let fx = Fx::new(299_300);
    let m = hex::encode(fx.key.master().bytes());
    assert!(!format!("{:?}", fx.file).contains(&m));
    assert!(!format!("{:?}", fx.key).contains(&m));
}
