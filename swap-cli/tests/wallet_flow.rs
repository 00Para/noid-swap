//! Funding, recovery and sweep of the swap wallet, end to end against the vendor-checked node double (swap wallet, piece 2a).
//!
//! What is under test: the refusals, the record that is written before a send, the re-send of the same bytes, the rebuild on exactly the same coins
//! (amendment B), the stop rules, the unknown-outcome reports, and that every transaction is one the vendor's admission takes.

#[path = "common/wallet_node.rs"]
mod wallet_node;

use swap_cli::engine::{Action, Executor};
use swap_cli::params::ContractVersion;
use swap_cli::state::{AlicePhase, Event, Phase};
use swap_cli::wallet::chain::NodeReads;
use swap_cli::wallet::contract::{build_recovery, RecoveryInputs};
use swap_cli::wallet::flow::{self, FlowEnv, Outcome, WalletExecutor};
use swap_cli::wallet::persist::{record_path, SendKind, SendRecord};
use swap_cli::wallet::{fee_ceiling, WalletError, WalletKey};
use swap_cli::watch::NoidInstance;
use wallet_node::*;

const TIP: u64 = 299_300;

/// The deposit: the wallet holds the coin, the first real `fund` sees it and waits, two blocks pass.
fn deposit(fx: &Fx, slot: u32, amount: u64) {
    fx.node.seed(slot, &fx.key.address(), amount);
    let first = fx.fund(true);
    assert_eq!(first.outcome, Outcome::Hold, "{}", first.summary);
    assert!(first.summary.contains("first seen"), "{}", first.summary);
    fx.node.mine(2);
}

fn record(fx: &Fx, kind: SendKind) -> SendRecord {
    SendRecord::load(&record_path(&fx.path, kind), &fx.file.public.digest()).unwrap().expect("a record")
}

fn record_bytes(fx: &Fx, kind: &str) -> Vec<u8> {
    std::fs::read(format!("{}.wallet-{kind}.json", fx.path.display())).unwrap()
}

// ---------------------------------------------------------------- funding

#[test]
fn funding_pays_exactly_the_swaps_amount_to_the_contract_root() {
    let fx = Fx::new(TIP);
    fx.node.seed(5, &fx.key.address(), 20_000_000);
    let files_before: Vec<_> = std::fs::read_dir(fx.dir.path()).unwrap().map(|e| e.unwrap().file_name()).collect();
    // A dry run builds, proves and verifies, and writes and sends nothing.
    let dry = fx.fund(false);
    assert_eq!(dry.outcome, Outcome::DryRun, "{}", dry.summary);
    assert_eq!(dry.target.as_deref(), Some(fx.root.to_bech32().as_str()));
    assert_eq!((dry.amount, dry.fee, dry.change), (Some(AMOUNT), Some(9_000), Some(20_000_000 - AMOUNT - 9_000)));
    assert_eq!(fx.node.received_count(), 0);
    let files_after: Vec<_> = std::fs::read_dir(fx.dir.path()).unwrap().map(|e| e.unwrap().file_name()).collect();
    assert_eq!(files_before, files_after, "a dry run writes nothing");
    // The real one first waits for the deposit to be seen for two blocks.
    let first = fx.fund(true);
    assert_eq!(first.outcome, Outcome::Hold);
    assert_eq!(fx.node.received_count(), 0);
    fx.node.mine(2);
    let rep = fx.fund(true);
    assert_eq!(rep.outcome, Outcome::Sent, "{}", rep.summary);
    assert!(rep.built_now);
    fx.node.mine(1);
    let at_root = fx.node.coins_of(&fx.root);
    assert_eq!(at_root.len(), 1);
    assert_eq!(at_root[0].1, AMOUNT, "exactly the swap's amount, nothing more");
    assert_eq!(fx.node.balance_of(&fx.key.address()), 20_000_000 - AMOUNT - 9_000);
    // The record is what was sent.
    let rec = record(&fx, SendKind::Fund);
    assert_eq!(rec.txid, rep.txid.clone().unwrap());
    assert_eq!(rec.target, fx.root.to_bech32());
    assert_eq!(rec.amount, AMOUNT);
    assert_eq!(rec.inputs.len(), 1);
    assert_eq!(hex::encode(rec.intent_bytes().unwrap()), fx.node.state().received[0]);
    // The wallet is done: a second call does not fund again.
    let again = fx.fund(true);
    assert_eq!(again.outcome, Outcome::Done, "{}", again.summary);
    assert_eq!(fx.node.received_count(), 1);
}

#[test]
fn a_funding_is_refused_unless_the_swap_file_says_the_same_root_and_amount() {
    let mut fx = Fx::new(TIP);
    fx.node.seed(5, &fx.key.address(), 20_000_000);
    // a swap file whose contract root is not the root of its opening
    fx.file.public.contract_root = fx.payout.to_bech32();
    let r = fx.step(false, flow::fund);
    assert!(matches!(&r, Err(WalletError::Refused(m)) if m.contains("contract root")), "{r:?}");
    // a wallet that is not the swap's
    let mut fx = Fx::new(TIP);
    fx.node.seed(5, &fx.key.address(), 20_000_000);
    let other = WalletKey::from_secret(swap_cli::secret::Secret::from_bytes(htlc_harness::seq_bytes(0x44)));
    let env = FlowEnv { swap_path: &fx.path, file: &fx.file, key: &other, rpc: &fx.node, nodes: &[], submit: false, now: 1 };
    assert!(matches!(flow::fund(&env), Err(WalletError::Refused(m)) if m.contains("not the swap wallet")));
    // a file of another role / phase
    fx.file.phase = Phase::Alice(AlicePhase::Aborted { reason: "x".into() });
    assert!(matches!(fx.step(false, flow::fund), Err(WalletError::Refused(m)) if m.contains("aborted")));
    assert_eq!(fx.node.received_count(), 0);
}

#[test]
fn a_recorded_funding_for_another_target_or_swap_or_a_damaged_one_is_left_alone() {
    let fx = Fx::new(TIP);
    deposit(&fx, 5, 20_000_000);
    // a record that pays somebody else (the payout address)
    let reads = NodeReads::new(&fx.node);
    let view = reads.slots_by_owner(&fx.key.address()).unwrap();
    let anchor = reads.epoch_anchor().unwrap();
    let slots = reads.output_slots(&fx.key.address(), 2).unwrap();
    let plan = swap_cli::wallet::send::build_send(swap_cli::wallet::send::SendInputs {
        key: &fx.key,
        inputs: &view.plain,
        target: fx.payout,
        amount: AMOUNT,
        fee: 9_000,
        output_slots: &slots,
        epoch_anchor: anchor,
        child_height: fx.node.tip() + 1,
    })
    .unwrap();
    let path = record_path(&fx.path, SendKind::Fund);
    SendRecord::from_send(SendKind::Fund, fx.file.public.digest(), &plan, &fx.payout.to_bech32(), 1).save(&path).unwrap();
    let r = fx.step(true, flow::fund);
    assert!(matches!(&r, Err(WalletError::Refused(m)) if m.contains("not for this swap's contract root")), "{r:?}");
    // a record made for another swap file
    SendRecord::from_send(SendKind::Fund, [9; 32], &plan, &fx.root.to_bech32(), 1).save(&path).unwrap();
    assert!(matches!(fx.step(true, flow::fund), Err(WalletError::Persist(m)) if m.contains("another swap file")));
    // a record whose coins are not the coins in its bytes
    let mut bad = SendRecord::from_send(SendKind::Fund, fx.file.public.digest(), &plan, &fx.root.to_bech32(), 1);
    bad.inputs[0].slot_index += 1;
    bad.save(&path).unwrap();
    assert!(matches!(fx.step(true, flow::fund), Err(WalletError::Persist(m)) if m.contains("coins")));
    // a record whose id is not the bytes' id
    let mut bad = SendRecord::from_send(SendKind::Fund, fx.file.public.digest(), &plan, &fx.root.to_bech32(), 1);
    bad.txid = "00".repeat(32);
    bad.save(&path).unwrap();
    assert!(matches!(fx.step(true, flow::fund), Err(WalletError::Persist(m)) if m.contains("transaction id")));
    assert_eq!(fx.node.received_count(), 0, "nothing was sent from a record that is not what it says");
}

#[test]
fn the_record_exists_when_the_bytes_arrive_at_the_node() {
    let fx = Fx::new(TIP);
    deposit(&fx, 5, 20_000_000);
    let flag = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
    let (f2, path) = (flag.clone(), format!("{}.wallet-fund.json", fx.path.display()));
    fx.node.on_receive(move |_| f2.store(std::path::Path::new(&path).exists(), std::sync::atomic::Ordering::SeqCst));
    assert_eq!(fx.fund(true).outcome, Outcome::Sent);
    assert!(flag.load(std::sync::atomic::Ordering::SeqCst), "the record was on disk before the node saw the bytes");
}

#[cfg(unix)]
#[test]
fn a_record_that_cannot_be_written_means_nothing_is_sent() {
    use std::os::unix::fs::PermissionsExt;
    let fx = Fx::new(TIP);
    deposit(&fx, 5, 20_000_000);
    std::fs::set_permissions(fx.dir.path(), std::fs::Permissions::from_mode(0o500)).unwrap();
    // a root user can write anywhere: then this check proves nothing and is skipped
    if std::fs::write(fx.dir.path().join("probe"), b"x").is_ok() {
        std::fs::set_permissions(fx.dir.path(), std::fs::Permissions::from_mode(0o700)).unwrap();
        return;
    }
    let r = fx.step(true, flow::fund);
    std::fs::set_permissions(fx.dir.path(), std::fs::Permissions::from_mode(0o700)).unwrap();
    assert!(matches!(r, Err(WalletError::Persist(_))), "{r:?}");
    assert_eq!(fx.node.received_count(), 0);
}

#[test]
fn a_timeout_after_the_node_took_it_is_maybe_sent_and_the_same_bytes_finish_it() {
    let fx = Fx::new(TIP);
    deposit(&fx, 5, 20_000_000);
    fx.node.fail_next(Fail::TimeoutAfterAdmit);
    let r1 = fx.fund(true);
    assert_eq!(r1.outcome, Outcome::MaybeSent, "{}", r1.summary);
    assert!(r1.summary.contains("MAY HAVE BEEN SENT") && !r1.summary.contains("NOT sent"));
    assert!(fx.record_exists("fund"));
    assert_eq!(fx.node.pool_len(), 1, "the bytes did arrive");
    // run it again: the same bytes, the node says it has them
    let r2 = fx.fund(true);
    assert_eq!(r2.outcome, Outcome::Sent, "{}", r2.summary);
    assert!(!r2.built_now);
    assert_eq!(r2.txid, r1.txid);
    assert_eq!(fx.node.received_count(), 2);
    let rcv = fx.node.state().received.clone();
    assert_eq!(rcv[0], rcv[1], "byte for byte");
    fx.node.mine(1);
    assert_eq!(fx.node.coins_of(&fx.root).len(), 1, "one funding, not two");
    assert_eq!(fx.fund(true).outcome, Outcome::Done);
    assert_eq!(fx.node.received_count(), 2);
}

#[test]
fn a_timeout_before_the_node_saw_it_is_maybe_sent_too_and_the_same_bytes_land() {
    let fx = Fx::new(TIP);
    deposit(&fx, 5, 20_000_000);
    fx.node.fail_next(Fail::TimeoutBeforeAdmit);
    let r1 = fx.fund(true);
    assert_eq!(r1.outcome, Outcome::MaybeSent);
    assert_eq!(fx.node.pool_len(), 0);
    let r2 = fx.fund(true);
    assert_eq!(r2.outcome, Outcome::Sent);
    assert_eq!(r2.txid, r1.txid);
    fx.node.mine(1);
    assert_eq!(fx.node.coins_of(&fx.root).len(), 1);
}

#[test]
fn a_refusal_is_not_sent_and_the_record_is_kept_for_the_next_run() {
    let fx = Fx::new(TIP);
    deposit(&fx, 5, 20_000_000);
    fx.node.fail_next(Fail::Refuse("mempool full (capacity 1)".into()));
    let r1 = fx.fund(true);
    assert_eq!(r1.outcome, Outcome::NotSent);
    assert!(r1.summary.contains("NOT sent"));
    let r2 = fx.fund(true);
    assert_eq!(r2.outcome, Outcome::Sent);
    assert_eq!(r2.txid, r1.txid, "the same transaction, not a second one");
}

#[test]
fn a_crash_between_the_record_and_the_send_is_finished_by_the_next_run() {
    let fx = Fx::new(TIP);
    deposit(&fx, 5, 20_000_000);
    // the record is written, no node is reachable: nothing leaves
    let none: Vec<(&str, &dyn swap_cli::client::IntentSubmitter)> = vec![];
    let env = FlowEnv { swap_path: &fx.path, file: &fx.file, key: &fx.key, rpc: &fx.node, nodes: &none, submit: true, now: 1 };
    let r1 = flow::fund(&env).unwrap();
    assert_eq!(r1.outcome, Outcome::NotSent);
    assert!(fx.record_exists("fund"));
    assert_eq!(fx.node.received_count(), 0);
    let r2 = fx.fund(true);
    assert_eq!(r2.outcome, Outcome::Sent);
    assert_eq!(r2.txid, r1.txid);
    assert!(!r2.built_now);
}

#[test]
fn after_the_window_a_rebuild_spends_exactly_the_recorded_coins_and_only_one_funding_lands() {
    // 299,340: the epoch anchored at 299,232 serves the children up to 299,376
    let fx = Fx::new(299_338);
    deposit(&fx, 5, 20_000_000);
    fx.node.fail_next(Fail::TimeoutAfterAdmit);
    let r1 = fx.fund(true);
    assert_eq!(r1.outcome, Outcome::MaybeSent);
    let first = record(&fx, SendKind::Fund);
    assert_eq!(first.anchor_height, 299_232);
    assert_eq!(first.last_valid_height(), 299_376);
    // still inside the window: the same bytes, not a rebuild
    fx.node.set_tip(299_375);
    let r2 = fx.fund(true);
    assert!(!r2.built_now, "{}", r2.summary);
    assert_eq!(r2.outcome, Outcome::Sent);
    // the window passes: the node's pool drops the old transaction at the rotation
    fx.node.set_tip(299_376);
    fx.node.mine(1);
    assert_eq!(fx.node.pool_len(), 0);
    assert!(fx.node.coins_of(&fx.root).is_empty());
    let r3 = fx.fund(true);
    assert_eq!(r3.outcome, Outcome::Sent, "{}", r3.summary);
    assert!(r3.built_now);
    assert_ne!(r3.txid, r1.txid, "a new anchor makes a new transaction");
    assert!(r3.notes.iter().any(|n| n.contains("exactly the same coins")));
    let second = record(&fx, SendKind::Fund);
    assert_eq!(second.inputs, first.inputs, "exactly the recorded coins");
    fx.node.mine(1);
    assert_eq!(fx.node.coins_of(&fx.root).len(), 1, "one funding");
    assert_eq!(fx.node.coins_of(&fx.root)[0].1, AMOUNT);
    assert_eq!(fx.fund(true).outcome, Outcome::Done);
}

#[test]
fn a_recorded_coin_that_is_gone_never_allows_a_rebuild_and_waits_for_a_plus_144_plus_18() {
    let fx = Fx::new(TIP);
    deposit(&fx, 5, 20_000_000);
    fx.node.fail_next(Fail::TimeoutBeforeAdmit);
    assert_eq!(fx.fund(true).outcome, Outcome::MaybeSent);
    let rec = record(&fx, SendKind::Fund);
    assert_eq!(rec.final_after_tip(), 299_232 + 144 + 18);
    let bytes_before = record_bytes(&fx, "fund");
    // the coin leaves the wallet by another way
    fx.node.spend_externally(5);
    let r = fx.fund(true);
    assert_eq!(r.outcome, Outcome::Hold, "{}", r.summary);
    assert!(r.summary.contains("may have landed"), "{}", r.summary);
    // even far past the window: no rebuild before a + 144 + 18
    fx.node.set_tip(299_393);
    let r = fx.fund(true);
    assert_eq!(r.outcome, Outcome::Hold);
    assert!(r.summary.contains("299394"), "{}", r.summary);
    assert_eq!(fx.node.received_count(), 1, "nothing was sent");
    // after it: judged by the contract's coins only; none there: unknown, and still nothing is built
    fx.node.set_tip(299_394);
    let r = fx.fund(true);
    assert_eq!(r.outcome, Outcome::Hold);
    assert!(r.summary.contains("unknown"), "{}", r.summary);
    assert_eq!(fx.node.received_count(), 1);
    assert_eq!(record_bytes(&fx, "fund"), bytes_before, "the record is untouched");
    // and when the instance is at the contract, that is what settles it
    fx.instance_at_root(77, AMOUNT);
    let r = fx.fund(true);
    assert_eq!(r.outcome, Outcome::Done);
    assert!(r.summary.contains("tick --apply"));
    assert_eq!(fx.node.received_count(), 1);
}

#[test]
fn no_funding_after_the_last_funding_height_and_a_recorded_one_is_not_sent_again() {
    // the last funding tip of this swap: lock-by 300,107 minus (b_fund 10 + b_final 19)
    let fx = Fx::new(TIP);
    assert_eq!(flow::last_funding_tip(&fx.file), 300_078);
    deposit(&fx, 5, 20_000_000);
    fx.node.fail_next(Fail::TimeoutBeforeAdmit);
    assert_eq!(fx.fund(true).outcome, Outcome::MaybeSent);
    fx.node.set_tip(300_078);
    assert_eq!(fx.fund(true).outcome, Outcome::Sent, "the last tip is still inside");
    fx.node.clear_pool();
    fx.node.set_tip(300_079);
    let r = fx.fund(true);
    assert_eq!(r.outcome, Outcome::Hold);
    assert!(r.summary.contains("last funding height"), "{}", r.summary);
    assert_eq!(fx.node.received_count(), 2, "the record is no longer sent");
    // a wallet that never funded: no new funding either
    let fx = Fx::new(300_079);
    fx.node.seed(5, &fx.key.address(), 20_000_000);
    let r = fx.fund(true);
    assert_eq!(r.outcome, Outcome::Hold);
    assert!(r.summary.contains("last funding height"));
    assert_eq!(fx.node.received_count(), 0);
}

#[test]
fn a_coin_already_at_the_contract_that_is_not_ours_blocks_a_second_funding() {
    let fx = Fx::new(TIP);
    deposit(&fx, 5, 20_000_000);
    fx.instance_at_root(9, 1_000);
    let r = fx.fund(true);
    assert_eq!(r.outcome, Outcome::Hold);
    assert!(r.summary.contains("already sit"), "{}", r.summary);
    assert_eq!(fx.node.received_count(), 0);
}

#[test]
fn a_wallet_that_holds_too_little_says_so_and_sends_nothing() {
    let fx = Fx::new(TIP);
    fx.node.seed(5, &fx.key.address(), 5_000_000);
    fx.node.seed_with_creation_id(6, &fx.key.address(), 99_000_000, (1 << 62) | 3); // a carrier: never counted
    let r = fx.fund(true);
    assert_eq!(r.outcome, Outcome::Hold);
    assert!(r.summary.contains("5000000") && r.summary.contains(&fx.key.address().to_bech32()), "{}", r.summary);
    assert!(r.notes.iter().any(|n| n.contains("native-asset carrier")));
    assert_eq!(fx.node.received_count(), 0);
}

#[test]
fn the_carrier_stays_in_the_wallet_when_the_funding_is_paid_from_the_plain_coins() {
    let fx = Fx::new(TIP);
    fx.node.seed_with_creation_id(6, &fx.key.address(), 99_000_000, (1 << 62) | 3);
    deposit(&fx, 5, 20_000_000);
    assert_eq!(fx.fund(true).outcome, Outcome::Sent);
    fx.node.mine(1);
    assert!(fx.node.coins_of(&fx.key.address()).iter().any(|c| c.0 == 6 && c.1 == 99_000_000), "the carrier was not spent");
    assert_eq!(fx.node.coins_of(&fx.root)[0].1, AMOUNT);
}

#[test]
fn the_balance_report_counts_plain_coins_and_the_funding_reserve() {
    let fx = Fx::new(TIP);
    fx.node.seed(5, &fx.key.address(), 4_000_000);
    fx.node.seed(6, &fx.key.address(), 6_000_000);
    fx.node.seed_with_creation_id(7, &fx.key.address(), 50_000_000, (1 << 62) | 9);
    let b = flow::balance(&fx.file, &fx.key, &fx.node).unwrap();
    assert_eq!((b.plain_total, b.plain_coins, b.carriers), (10_000_000, 2, 1));
    assert_eq!(b.amount, AMOUNT);
    assert_eq!(b.fee_reserve, 9_000);
    assert_eq!(b.need, AMOUNT + 9_000);
    assert!(!b.covers, "10,000,000 does not cover the amount plus the fee");
    fx.node.seed(8, &fx.key.address(), 9_000);
    assert!(flow::balance(&fx.file, &fx.key, &fx.node).unwrap().covers);
}

// ---------------------------------------------------------------- the engine executor: funding

fn executor(fx: &Fx) -> WalletExecutor<Node> {
    WalletExecutor::new(fx.path.clone(), fx.node.clone(), vec![("n".into(), Box::new(fx.node.clone()))], swap_cli::swapfile::Passphrase::new("a passphrase of enough length"))
}

#[test]
fn the_executor_performs_fund_noid_and_returns_the_funding_event() {
    let fx = Fx::new(TIP);
    deposit(&fx, 5, 20_000_000);
    let mut ex = executor(&fx);
    // a different amount than the swap's is refused
    let e = ex.execute(&fx.file, &Action::FundNoid { amount_micronoid: AMOUNT + 1 }, 1).unwrap_err();
    assert!(!e.maybe_sent);
    // other actions are not this executor's
    assert!(!ex.execute(&fx.file, &Action::Wait { reason: "x".into() }, 1).unwrap_err().maybe_sent);
    assert_eq!(fx.node.received_count(), 0);
    let ev = ex.execute(&fx.file, &Action::FundNoid { amount_micronoid: AMOUNT }, 1).unwrap().expect("an event");
    let Event::FundingSubmitted { txid: Some(txid) } = &ev else { panic!("{ev:?}") };
    assert_eq!(Some(txid.clone()), ex.last_report.as_ref().and_then(|r| r.txid.clone()));
    // the engine records it as the funding, and the file then follows that transaction
    let mut file = fx.file.clone();
    file.apply(&ev, 2).unwrap();
    assert!(matches!(file.phase, Phase::Alice(AlicePhase::FundingSubmitted { txid: Some(_) })));
}

#[test]
fn the_executor_reports_an_unknown_outcome_as_unknown_and_a_wrong_passphrase_as_not_sent() {
    let fx = Fx::new(TIP);
    deposit(&fx, 5, 20_000_000);
    fx.node.fail_next(Fail::TimeoutAfterAdmit);
    let mut ex = executor(&fx);
    let e = ex.execute(&fx.file, &Action::FundNoid { amount_micronoid: AMOUNT }, 1).unwrap_err();
    assert!(e.maybe_sent, "{e}");
    assert!(e.to_string().contains("outcome unknown"));
    // run again: the same bytes, now a clean answer
    let ev = ex.execute(&fx.file, &Action::FundNoid { amount_micronoid: AMOUNT }, 2).unwrap();
    assert!(matches!(ev, Some(Event::FundingSubmitted { .. })));
    fx.node.mine(1);
    assert_eq!(fx.node.coins_of(&fx.root).len(), 1);
    // wrong passphrase
    let mut bad = WalletExecutor::new(fx.path.clone(), fx.node.clone(), vec![("n".into(), Box::new(fx.node.clone()))], swap_cli::swapfile::Passphrase::new("not the passphrase at all"));
    let e = bad.execute(&fx.file, &Action::FundNoid { amount_micronoid: AMOUNT }, 3).unwrap_err();
    assert!(!e.maybe_sent);
}

// ---------------------------------------------------------------- recovery

/// Alice's file after a final funding, the instance at the contract, the chain at `tip`.
fn recovery_fx(tip: u64, version: ContractVersion) -> (Fx, NoidInstance) {
    let mut fx = Fx::with_version(tip, version);
    let inst = fx.instance_at_root(40, AMOUNT);
    fx.set_funded(&inst);
    (fx, inst)
}

fn recover(fx: &Fx, submit: bool) -> swap_cli::wallet::flow::StepReport {
    let reads = NodeReads::new(&fx.node);
    let fee = flow::recovery_fee(&fx.file, &reads).unwrap();
    fx.step(submit, |env| flow::recover(env, fee)).expect("recover")
}

#[test]
fn the_recovery_after_the_deadline_pays_the_wallet_and_the_vendor_branch_check_takes_it() {
    let (fx, inst) = recovery_fx(D - 1, ContractVersion::V1); // the next block is D: the recovery branch
    let dry = recover(&fx, false);
    assert_eq!(dry.outcome, Outcome::DryRun, "{}", dry.summary);
    assert_eq!(fx.node.received_count(), 0);
    assert!(!fx.record_exists("recover"));
    let rep = recover(&fx, true);
    assert_eq!(rep.outcome, Outcome::Sent, "{}", rep.summary);
    assert_eq!(rep.amount, Some(AMOUNT - 5_800));
    assert_eq!(rep.target.as_deref(), Some(fx.key.address().to_bech32().as_str()));
    fx.node.mine(1);
    assert!(fx.node.coins_of(&fx.root).is_empty(), "the instance is closed");
    assert_eq!(fx.node.balance_of(&fx.key.address()), AMOUNT - 5_800);
    assert_eq!(record(&fx, SendKind::Recover).inputs[0].creation_id, inst.creation_id);
    // a second call does not close anything again
    let again = recover(&fx, true);
    assert_eq!(again.outcome, Outcome::Hold, "{}", again.summary);
}

#[test]
fn before_the_deadline_nothing_is_built_and_the_builder_itself_refuses() {
    let (fx, inst) = recovery_fx(D - 2, ContractVersion::V1); // the next block is D - 1: the claim branch
    let r = recover(&fx, true);
    assert_eq!(r.outcome, Outcome::Hold);
    assert!(r.summary.contains("opens at the deadline"), "{}", r.summary);
    assert_eq!(fx.node.received_count(), 0);
    let opening = fx.opening();
    let err = build_recovery(RecoveryInputs { opening: &opening, instance: &inst, key: &fx.key, output_slot: 7, fee: 5_800, epoch_anchor: [7; 32], call_height: D - 1 }).unwrap_err();
    assert!(matches!(&err, WalletError::Refused(m) if m.contains("deadline")), "{err:?}");
    assert!(build_recovery(RecoveryInputs { opening: &opening, instance: &inst, key: &fx.key, output_slot: 7, fee: 5_800, epoch_anchor: [7; 32], call_height: D }).is_ok());
}

#[test]
fn another_wallet_cannot_build_the_recovery_and_the_fee_rule_is_the_contracts() {
    let (fx, inst) = recovery_fx(D - 1, ContractVersion::V1);
    let opening = fx.opening();
    let other = WalletKey::from_secret(swap_cli::secret::Secret::from_bytes(htlc_harness::seq_bytes(0x45)));
    let r = |key: &WalletKey, fee: u64, anchor: [u8; 32]| build_recovery(RecoveryInputs { opening: &opening, instance: &inst, key, output_slot: 7, fee, epoch_anchor: anchor, call_height: D });
    assert!(matches!(r(&other, 5_800, [7; 32]), Err(WalletError::Refused(m)) if m.contains("recovery authority")));
    assert!(matches!(r(&fx.key, 5_799, [7; 32]), Err(WalletError::Refused(m)) if m.contains("outside")));
    assert!(matches!(r(&fx.key, 50_001, [7; 32]), Err(WalletError::Refused(m)) if m.contains("outside")));
    assert!(matches!(r(&fx.key, 5_800, [0; 32]), Err(WalletError::Refused(m)) if m.contains("anchor")));
    assert!(r(&fx.key, 50_000, [7; 32]).is_ok(), "the cap itself is allowed under v1");
}

#[test]
fn a_fixed_fee_contract_is_closed_with_exactly_its_fee() {
    let (fx, _inst) = recovery_fx(D - 1, ContractVersion::V2);
    let fee = flow::recovery_fee(&fx.file, &NodeReads::new(&fx.node)).unwrap();
    assert_eq!(fee, fx.file.public.params.max_fee_micronoid);
    let rep = recover(&fx, true);
    assert_eq!(rep.outcome, Outcome::Sent, "{}", rep.summary);
    assert_eq!(rep.fee, Some(fee));
    fx.node.mine(1);
    assert_eq!(fx.node.balance_of(&fx.key.address()), AMOUNT - fee);
    // any other fee is refused by the builder before the node could
    let (fx2, inst) = recovery_fx(D - 1, ContractVersion::V2);
    let opening = fx2.opening();
    let e = build_recovery(RecoveryInputs { opening: &opening, instance: &inst, key: &fx2.key, output_slot: 7, fee: 5_800, epoch_anchor: [7; 32], call_height: D }).unwrap_err();
    assert!(matches!(&e, WalletError::Refused(m) if m.contains("exactly max_fee")), "{e:?}");
}

#[test]
fn a_timeout_on_the_recovery_is_maybe_sent_and_the_same_bytes_finish_it() {
    let (fx, _inst) = recovery_fx(D - 1, ContractVersion::V1);
    fx.node.fail_next(Fail::TimeoutAfterAdmit);
    let r1 = recover(&fx, true);
    assert_eq!(r1.outcome, Outcome::MaybeSent, "{}", r1.summary);
    let r2 = recover(&fx, true);
    assert_eq!(r2.outcome, Outcome::Sent);
    assert_eq!(r2.txid, r1.txid);
    assert!(!r2.built_now);
    let rcv = fx.node.state().received.clone();
    assert_eq!(rcv[0], rcv[1]);
    fx.node.mine(1);
    assert_eq!(fx.node.balance_of(&fx.key.address()), AMOUNT - 5_800);
    // the instance is gone: nothing more to send; once everything is final it says Done
    let r3 = recover(&fx, true);
    assert_eq!(r3.outcome, Outcome::Hold, "{}", r3.summary);
    assert_eq!(fx.node.received_count(), 2);
    let rec = record(&fx, SendKind::Recover);
    fx.node.set_tip(rec.final_after_tip());
    assert_eq!(recover(&fx, true).outcome, Outcome::Done);
    assert_eq!(fx.node.received_count(), 2);
}

#[test]
fn the_recovery_rebuilds_on_the_same_instance_after_its_window_and_never_beside_a_closed_one() {
    // D - 1 = 300,737 is in the epoch anchored at 300,672 (children up to 300,816)
    let (fx, _inst) = recovery_fx(D - 1, ContractVersion::V1);
    fx.node.fail_next(Fail::TimeoutBeforeAdmit);
    assert_eq!(recover(&fx, true).outcome, Outcome::MaybeSent);
    let first = record(&fx, SendKind::Recover);
    assert_eq!(first.last_valid_height(), 300_816);
    fx.node.set_tip(300_816);
    let r = recover(&fx, true);
    assert_eq!(r.outcome, Outcome::Sent, "{}", r.summary);
    assert!(r.built_now);
    assert_ne!(Some(first.txid.clone()), r.txid);
    assert_eq!(record(&fx, SendKind::Recover).inputs, first.inputs);
    fx.node.mine(1);
    assert!(fx.node.coins_of(&fx.root).is_empty());
}

#[test]
fn the_executor_performs_refund_noid_and_the_close_is_tracked_by_its_txid() {
    let (fx, inst) = recovery_fx(D - 1, ContractVersion::V1);
    let mut ex = executor(&fx);
    let action = Action::RefundNoid { call_height: D, fee_micronoid: 5_800 };
    let ev = ex.execute(&fx.file, &action, 1).unwrap().expect("an event");
    let Event::NoidRefundSubmitted { txid: Some(txid), call_height } = &ev else { panic!("{ev:?}") };
    assert_eq!(*call_height, D);
    // the file now tracks that transaction: the phase carries it, and the engine's own watch (tick) follows it to inclusion and finality
    let mut file = fx.file.clone();
    file.apply(&ev, 2).unwrap();
    assert!(matches!(&file.phase, Phase::Alice(AlicePhase::RefundSubmitted { txid: Some(t), instance, .. }) if t == txid && *instance == inst));
    // a timeout is "outcome unknown"
    let (fx2, _) = recovery_fx(D - 1, ContractVersion::V1);
    fx2.node.fail_next(Fail::TimeoutAfterAdmit);
    let mut ex2 = executor(&fx2);
    let e = ex2.execute(&fx2.file, &action, 1).unwrap_err();
    assert!(e.maybe_sent);
    // a fee other than the engine's rule is the executor's refusal, not a send
    let (fx3, _) = recovery_fx(D - 1, ContractVersion::V1);
    let mut ex3 = executor(&fx3);
    assert!(!ex3.execute(&fx3.file, &Action::RefundNoid { call_height: D, fee_micronoid: 4_000 }, 1).unwrap_err().maybe_sent);
    assert_eq!(fx3.node.received_count(), 0);
}

// ---------------------------------------------------------------- sweep

fn sweep(fx: &Fx, submit: bool) -> swap_cli::wallet::flow::StepReport {
    fx.step(submit, flow::sweep).expect("sweep")
}

fn refunded(fx: &mut Fx) {
    fx.file.phase = Phase::Alice(AlicePhase::Refunded { txid: "ab".repeat(32), height: 300_800 });
    fx.file.save(&fx.path).unwrap();
}

#[test]
fn the_sweep_sends_everything_minus_the_fee_to_the_payout_address_and_skips_dust() {
    let mut fx = Fx::new(300_900);
    refunded(&mut fx);
    fx.node.seed(1, &fx.key.address(), 9_994_200);
    fx.node.seed(2, &fx.key.address(), 3_000_000);
    fx.node.seed(3, &fx.key.address(), 90); // not worth its own input fee
    fx.node.seed_with_creation_id(4, &fx.key.address(), 70_000_000, (1 << 62) | 5); // a carrier: never spent
    let dry = sweep(&fx, false);
    assert_eq!(dry.outcome, Outcome::DryRun, "{}", dry.summary);
    assert_eq!(fx.node.received_count(), 0);
    let rep = sweep(&fx, true);
    assert_eq!(rep.outcome, Outcome::Sent, "{}", rep.summary);
    let fee = 5_000 + 200 + 700;
    assert_eq!(rep.fee, Some(fee));
    assert_eq!(rep.amount, Some(9_994_200 + 3_000_000 - fee));
    assert!(rep.notes.iter().any(|n| n.contains("carrier")));
    fx.node.mine(1);
    assert_eq!(fx.node.balance_of(&fx.payout), 9_994_200 + 3_000_000 - fee);
    let left: Vec<u32> = fx.node.coins_of(&fx.key.address()).iter().map(|c| c.0).collect();
    assert_eq!(left, vec![3, 4], "the dust coin and the carrier stay");
}

#[test]
fn the_sweep_waits_for_the_swap_to_be_over_and_for_the_recorded_instance_to_be_closed() {
    // not over
    let mut fx = Fx::new(300_900);
    fx.node.seed(1, &fx.key.address(), 3_000_000);
    let r = sweep(&fx, true);
    assert_eq!(r.outcome, Outcome::Hold);
    assert!(r.summary.contains("only after the swap is over"), "{}", r.summary);
    // over (done), but our own instance is still at the contract
    let inst = fx.instance_at_root(40, AMOUNT);
    fx.file.phase = Phase::Alice(AlicePhase::Done {
        lock: swap_cli::state::LockSummary { lock_id: [1; 32], t_reveal: 5, amount_wei: 1, block_number: 1, sender: [0xb0; 20], receiver: [0xa1; 20] },
        block_number: 9,
        instance: Some(inst.clone()),
    });
    let r = sweep(&fx, true);
    assert_eq!(r.outcome, Outcome::Hold);
    assert!(r.summary.contains("still at the contract"), "{}", r.summary);
    assert_eq!(fx.node.received_count(), 0);
    // the instance is closed, a stranger's dust coin sits at the contract: the sweep goes ahead (amendment F)
    fx.node.spend_externally(40);
    fx.node.seed(41, &fx.root, 500);
    let r = sweep(&fx, true);
    assert_eq!(r.outcome, Outcome::Sent, "{}", r.summary);
    // an old `done` file that did not record the instance is not guessed at
    let mut old = Fx::new(300_900);
    old.node.seed(1, &old.key.address(), 3_000_000);
    old.file.phase = Phase::Alice(AlicePhase::Done {
        lock: swap_cli::state::LockSummary { lock_id: [1; 32], t_reveal: 5, amount_wei: 1, block_number: 1, sender: [0xb0; 20], receiver: [0xa1; 20] },
        block_number: 9,
        instance: None,
    });
    assert_eq!(sweep(&old, true).outcome, Outcome::Hold);
    assert_eq!(old.node.received_count(), 0);
}

#[test]
fn an_unsettled_funding_blocks_the_sweep_of_an_aborted_swap() {
    let mut fx = Fx::new(TIP);
    deposit(&fx, 5, 20_000_000);
    fx.node.fail_next(Fail::TimeoutAfterAdmit);
    assert_eq!(fx.fund(true).outcome, Outcome::MaybeSent);
    fx.file.phase = Phase::Alice(AlicePhase::Aborted { reason: "x".into() });
    fx.node.mine(1); // the funding lands; the file never saw it
    fx.node.seed(60, &fx.key.address(), 3_000_000);
    let r = sweep(&fx, true);
    assert_eq!(r.outcome, Outcome::Hold, "{}", r.summary);
    assert!(r.summary.contains("not settled"), "{}", r.summary);
    // a funding that can no longer land (unspent coins, window passed) does not block
    let mut fx2 = Fx::new(TIP);
    deposit(&fx2, 5, 20_000_000);
    fx2.node.fail_next(Fail::TimeoutBeforeAdmit);
    assert_eq!(fx2.fund(true).outcome, Outcome::MaybeSent);
    fx2.file.phase = Phase::Alice(AlicePhase::Aborted { reason: "x".into() });
    fx2.node.set_tip(299_376); // child 299,377: the anchor of the recorded funding is gone
    assert_eq!(sweep(&fx2, true).outcome, Outcome::Sent);
}

#[test]
fn the_sweep_needs_a_payout_address_and_never_goes_to_the_contract_or_the_wallet() {
    let mut fx = Fx::new(300_900);
    refunded(&mut fx);
    fx.node.seed(1, &fx.key.address(), 3_000_000);
    let w = fx.file.wallet.as_mut().unwrap();
    w.payout = None;
    assert!(matches!(fx.step(true, flow::sweep), Err(WalletError::Refused(m)) if m.contains("no payout address")));
    fx.file.wallet.as_mut().unwrap().payout = Some(fx.key.address().to_bech32());
    assert!(matches!(fx.step(true, flow::sweep), Err(WalletError::Refused(m)) if m.contains("wallet itself")));
    fx.file.wallet.as_mut().unwrap().payout = Some(fx.root.to_bech32());
    assert!(matches!(fx.step(true, flow::sweep), Err(WalletError::Refused(m)) if m.contains("contract's address")));
    assert_eq!(fx.node.received_count(), 0);
}

#[test]
fn a_sweep_that_costs_more_than_it_moves_is_refused_and_an_empty_wallet_has_nothing_to_send() {
    let mut fx = Fx::new(300_900);
    refunded(&mut fx);
    fx.node.seed(1, &fx.key.address(), 8_000);
    assert!(matches!(fx.step(true, flow::sweep), Err(WalletError::Refused(m)) if m.contains("more than half")));
    let mut empty = Fx::new(300_900);
    refunded(&mut empty);
    assert!(matches!(empty.step(true, flow::sweep), Err(WalletError::Refused(_))));
    assert_eq!(empty.node.received_count(), 0);
}

#[test]
fn a_timeout_on_the_sweep_is_finished_with_the_same_bytes_and_pays_the_payout_once() {
    let mut fx = Fx::new(300_900);
    refunded(&mut fx);
    fx.node.seed(1, &fx.key.address(), 3_000_000);
    fx.node.fail_next(Fail::TimeoutAfterAdmit);
    let r1 = sweep(&fx, true);
    assert_eq!(r1.outcome, Outcome::MaybeSent);
    let r2 = sweep(&fx, true);
    assert_eq!(r2.outcome, Outcome::Sent);
    assert_eq!(r2.txid, r1.txid);
    fx.node.mine(1);
    assert_eq!(fx.node.balance_of(&fx.payout), 3_000_000 - 5_800);
    assert!(fx.node.coins_of(&fx.key.address()).is_empty());
    assert_eq!(fx.node.received_count(), 2);
}

// ---------------------------------------------------------------- the fee ceiling

/// What a lying node quotes for a payment of `n_in` inputs and `n_out` outputs: `Total` is one micro-NOID below the wallet's whole balance.
#[derive(Clone, Copy, Debug)]
enum Quote {
    TotalMinusOne(u64),
    DoubleCeiling,
    CeilingPlusOne,
    Ceiling,
}

impl Quote {
    fn apply(self, n_in: u64, n_out: u64) -> u64 {
        let ceiling = fee_ceiling(n_in as usize, n_out as usize).unwrap();
        match self {
            Quote::TotalMinusOne(total) => total - 1,
            Quote::DoubleCeiling => 2 * ceiling,
            Quote::CeilingPlusOne => ceiling + 1,
            Quote::Ceiling => ceiling,
        }
    }
}

fn quotes(total: u64) -> [(Quote, bool); 4] {
    [(Quote::TotalMinusOne(total), false), (Quote::DoubleCeiling, false), (Quote::CeilingPlusOne, false), (Quote::Ceiling, true)]
}

fn files_in(fx: &Fx) -> Vec<std::ffi::OsString> {
    let mut v: Vec<_> = std::fs::read_dir(fx.dir.path()).unwrap().map(|e| e.unwrap().file_name()).collect();
    v.sort();
    v
}

fn is_ceiling_refusal(e: &WalletError) -> bool {
    matches!(e, WalletError::Decode(m) if m.contains("the node quotes a fee of") && m.contains("above the ceiling") && m.contains("nothing was built"))
}

#[test]
fn the_fee_ceiling_is_the_chains_rule_at_its_maximum_times_four() {
    // 1 in, 1 out: (5,000 + 100 + 700) * 4; 1 in, 2 out: (5,000 + 100 + 1,400 + 2,500 * 8) * 4; no growth when outputs do not exceed inputs
    assert_eq!(fee_ceiling(1, 1).unwrap(), 23_200);
    assert_eq!(fee_ceiling(1, 2).unwrap(), 106_000);
    assert_eq!(fee_ceiling(3, 1).unwrap(), (5_000 + 300 + 700) * 4);
    assert_eq!(fee_ceiling(2, 4).unwrap(), (5_000 + 200 + 2_800 + 2 * 2_500 * 8) * 4);
}

#[test]
fn a_funding_is_refused_when_the_node_quotes_a_fee_above_the_ceiling_and_nothing_is_written_or_sent() {
    for (quote, accepted) in quotes(20_000_000) {
        // a fresh funding
        let fx = Fx::new(TIP);
        fx.node.seed(5, &fx.key.address(), 20_000_000);
        fx.node.set_fee_quote(move |i, o| quote.apply(i, o));
        let before = files_in(&fx);
        if accepted {
            let dry = fx.fund(false);
            assert_eq!(dry.outcome, Outcome::DryRun, "{quote:?}: {}", dry.summary);
            assert_eq!(dry.fee, Some(fee_ceiling(1, 2).unwrap()), "{quote:?}");
            assert_eq!(fx.fund(true).outcome, Outcome::Hold, "the deposit is seen first");
            fx.node.mine(2);
            let rep = fx.fund(true);
            assert_eq!(rep.outcome, Outcome::Sent, "{quote:?}: {}", rep.summary);
            assert!(fx.record_exists("fund"));
        } else {
            for submit in [false, true] {
                let e = fx.step(submit, flow::fund).unwrap_err();
                assert!(is_ceiling_refusal(&e), "{quote:?}: {e:?}");
            }
            assert_eq!(files_in(&fx), before, "{quote:?}: nothing was written");
            assert!(!fx.record_exists("fund"));
            assert_eq!(fx.node.received_count(), 0, "{quote:?}: nothing was submitted");
        }

        // a rebuild on the recorded coins
        let fx = Fx::new(299_338);
        deposit(&fx, 5, 20_000_000);
        fx.node.fail_next(Fail::TimeoutAfterAdmit);
        assert_eq!(fx.fund(true).outcome, Outcome::MaybeSent);
        let recorded = record_bytes(&fx, "fund");
        fx.node.set_tip(299_376);
        fx.node.mine(1);
        assert_eq!(fx.node.pool_len(), 0);
        fx.node.set_fee_quote(move |i, o| quote.apply(i, o));
        let rebuilt = fx.step(true, flow::fund);
        if accepted {
            let rep = rebuilt.unwrap();
            assert_eq!(rep.outcome, Outcome::Sent, "{quote:?}: {}", rep.summary);
            assert!(rep.built_now);
            assert_eq!(rep.fee, Some(fee_ceiling(1, 2).unwrap()));
        } else {
            let e = rebuilt.unwrap_err();
            assert!(is_ceiling_refusal(&e), "{quote:?}: {e:?}");
            assert_eq!(record_bytes(&fx, "fund"), recorded, "{quote:?}: the record is untouched");
            assert_eq!(fx.node.received_count(), 1, "{quote:?}: nothing more was submitted");
        }
    }
}

#[test]
fn a_sweep_is_refused_when_the_node_quotes_a_fee_above_the_ceiling_fresh_or_rebuilt() {
    for (quote, accepted) in quotes(20_000_000) {
        // a fresh sweep
        let mut fx = Fx::new(300_900);
        refunded(&mut fx);
        fx.node.seed(1, &fx.key.address(), 20_000_000);
        fx.node.set_fee_quote(move |i, o| quote.apply(i, o));
        let before = files_in(&fx);
        let fresh = fx.step(true, flow::sweep);
        if accepted {
            let rep = fresh.unwrap();
            assert_eq!(rep.outcome, Outcome::Sent, "{quote:?}: {}", rep.summary);
            assert_eq!(rep.fee, Some(fee_ceiling(1, 1).unwrap()));
        } else {
            let e = fresh.unwrap_err();
            assert!(is_ceiling_refusal(&e), "{quote:?}: {e:?}");
            assert_eq!(files_in(&fx), before, "{quote:?}: nothing was written");
            assert_eq!(fx.node.received_count(), 0, "{quote:?}: nothing was submitted");
        }

        // a rebuild of a recorded sweep, once its window has passed and its coins are still unspent
        let mut fx = Fx::new(300_900);
        refunded(&mut fx);
        fx.node.seed(1, &fx.key.address(), 20_000_000);
        fx.node.fail_next(Fail::TimeoutBeforeAdmit);
        assert_eq!(sweep(&fx, true).outcome, Outcome::MaybeSent);
        let recorded = record_bytes(&fx, "sweep");
        fx.node.set_tip(300_900 + 288);
        fx.node.set_fee_quote(move |i, o| quote.apply(i, o));
        let rebuilt = fx.step(true, flow::sweep);
        if accepted {
            let rep = rebuilt.unwrap();
            assert_eq!(rep.outcome, Outcome::Sent, "{quote:?}: {}", rep.summary);
            assert!(rep.built_now);
            assert_eq!(rep.fee, Some(fee_ceiling(1, 1).unwrap()));
        } else {
            let e = rebuilt.unwrap_err();
            assert!(is_ceiling_refusal(&e), "{quote:?}: {e:?}");
            assert_eq!(record_bytes(&fx, "sweep"), recorded, "{quote:?}: the record is untouched");
            assert_eq!(fx.node.received_count(), 1, "{quote:?}: nothing more was submitted");
        }
    }
}

#[test]
fn a_sweep_rebuild_that_costs_more_than_half_of_what_it_moves_is_refused_like_a_fresh_one() {
    let mut fx = Fx::new(300_900);
    refunded(&mut fx);
    fx.node.seed(1, &fx.key.address(), 12_000);
    fx.node.fail_next(Fail::TimeoutBeforeAdmit);
    // the node's own fee (5,800) is under half of 12,000: the first sweep is built and recorded
    assert_eq!(sweep(&fx, true).outcome, Outcome::MaybeSent);
    let recorded = record_bytes(&fx, "sweep");
    fx.node.set_tip(300_900 + 288);
    // 7,000 is far below the ceiling, but more than half of what the sweep moves
    fx.node.set_fee_quote(|_, _| 7_000);
    let e = fx.step(true, flow::sweep).unwrap_err();
    assert!(matches!(&e, WalletError::Refused(m) if m.contains("more than half")), "{e:?}");
    assert_eq!(record_bytes(&fx, "sweep"), recorded);
    assert_eq!(fx.node.received_count(), 1);
}

// ---------------------------------------------------------------- a funding made by another path

#[test]
fn a_swap_whose_funding_was_submitted_by_another_path_is_never_funded_again_by_the_wallet() {
    let mut fx = Fx::new(TIP);
    fx.file.phase = Phase::Alice(AlicePhase::FundingSubmitted { txid: None });
    fx.file.save(&fx.path).unwrap();
    // twice the amount: the wallet could pay a second funding
    fx.node.seed(5, &fx.key.address(), 2 * AMOUNT + 100_000);
    let before = files_in(&fx);
    let calls_before = fx.node.state().calls.len();
    for submit in [false, true] {
        let r = fx.fund(submit);
        assert_eq!(r.outcome, Outcome::Hold, "{}", r.summary);
        assert!(r.summary.contains("submitted by another path") && r.summary.contains("the wallet does not fund"), "{}", r.summary);
        assert!(!r.built_now && r.txid.is_none());
    }
    assert_eq!(fx.node.received_count(), 0, "nothing was submitted");
    assert!(!fx.record_exists("fund"), "no record was written");
    assert_eq!(files_in(&fx), before, "nothing was written");
    // nothing was built either: no output slots were asked for
    assert!(!fx.node.state().calls[calls_before..].iter().any(|c| c == "paranoid_getSlotHintsSalted"));
    // the same through the engine's executor
    let mut ex = executor(&fx);
    let e = ex.execute(&fx.file, &Action::FundNoid { amount_micronoid: AMOUNT }, 1_000).unwrap_err();
    assert!(!e.maybe_sent);
    assert_eq!(fx.node.received_count(), 0);
}

#[test]
fn with_a_record_of_its_own_a_funding_submitted_phase_still_sends_the_recorded_bytes() {
    let mut fx = Fx::new(TIP);
    deposit(&fx, 5, 20_000_000);
    fx.node.fail_next(Fail::TimeoutBeforeAdmit);
    let r1 = fx.fund(true);
    assert_eq!(r1.outcome, Outcome::MaybeSent);
    fx.file.phase = Phase::Alice(AlicePhase::FundingSubmitted { txid: r1.txid.clone() });
    fx.file.save(&fx.path).unwrap();
    let r2 = fx.fund(true);
    assert_eq!(r2.outcome, Outcome::Sent, "{}", r2.summary);
    assert_eq!(r2.txid, r1.txid);
    assert!(!r2.built_now);
}

// ---------------------------------------------------------------- export

#[test]
fn export_gives_the_master_secret_that_derives_the_wallets_address_and_the_opening() {
    let fx = Fx::new(TIP);
    let e = flow::export(&fx.file, &fx.pass).unwrap();
    let m: [u8; 32] = hex::decode(e.master_secret_hex.as_str()).unwrap().try_into().unwrap();
    assert_eq!(WalletKey::from_secret(swap_cli::secret::Secret::from_bytes(m)).address().to_bech32(), e.address);
    assert_eq!(e.address, fx.file.public.params.alice_noid);
    assert_eq!(e.opening_hex.len(), 699 * 2);
    assert_eq!(e.opening_hex, fx.file.public.opening_hex);
    // the opening's recovery authority and recipient is that address: a stock wallet imported from the secret can close the instance after D
    let opening = fx.opening();
    assert_eq!(opening.recovery_authority.to_bech32(), e.address);
    assert_eq!(opening.recovery_recipient.to_bech32(), e.address);
    // a wrong passphrase gives nothing
    assert!(flow::export(&fx.file, &swap_cli::swapfile::Passphrase::new("not the passphrase at all")).is_err());
}
