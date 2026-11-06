//! M2.5 scenario tests: the automatic actions driven end to end on the
//! simulator in `common/`, both parties at once, with final balances checked.
//! Nothing here proves or submits anything real; `client_r.rs` covers the
//! real claim construction.

mod common;

use common::*;
use swap_cli::params::{ContractVersion, ProfileName, M_A_S, W_A_S};
use swap_cli::swapfile::SwapFile;
use swap_cli::secret::Variant;
use swap_cli::state::{AlicePhase, BobPhase, Phase};

/// Bob's `refund_eth` was sent and the next Ethereum block mines it. M2.5b: the file says `refund_mined` (not terminal)
/// until Ethereum finalizes that block, `finality_lag` blocks later in the simulator; then it says `refunded`.
fn bob_refund_mined_then_final(s: &mut Scenario) {
    s.world.borrow_mut().advance_eth(1);
    s.tick_bob();
    assert_eq!(s.bob_phase(), "refund_mined");
    assert!(!s.bob.file.phase.is_terminal());
    let lag = s.world.borrow().finality_lag;
    s.world.borrow_mut().advance_eth(lag);
    s.tick_bob();
    assert!(matches!(s.bob.file.phase, Phase::Bob(BobPhase::Refunded { .. })), "{}", s.bob_phase());
}

fn happy_path(variant: Variant) -> Scenario {
    happy_path_in(variant, ProfileName::Production)
}

fn happy_path_in(variant: Variant, profile: ProfileName) -> Scenario {
    let mut s = Scenario::with_profile(variant, profile);
    s.run_to_lock_final();
    // Alice: lock final -> reveal (inside (I2)).
    let ra = s.tick_alice();
    assert_eq!(ra.action.kind(), "reveal_eth", "{ra:?}");
    assert_eq!(s.alice_phase(), "reveal_submitted");
    // Bob sees the preimage in the pending calldata and claims at once.
    let rb = s.tick_bob();
    assert_eq!(rb.events, vec!["eth_preimage_seen", "claim_submitted"], "{rb:?}");
    assert_eq!(rb.action.kind(), "claim_noid");
    // The claim is mined on Ethereum and included on Parano1d.
    s.world.borrow_mut().advance_eth(1);
    s.world.borrow_mut().advance_noid(1);
    s.tick_both();
    assert_eq!(s.alice_phase(), "revealed");
    assert_eq!(s.bob_phase(), "claim_included");
    // Finality on both sides (Ethereum: `finality_lag` blocks after the claim's own, 3 for the short default).
    let lag = s.world.borrow().finality_lag;
    s.world.borrow_mut().advance_eth(lag + 1);
    s.world.borrow_mut().advance_noid(17);
    s.tick_both();
    assert!(matches!(s.alice.file.phase, Phase::Alice(AlicePhase::Done { .. })), "{}", s.alice_phase());
    assert!(matches!(s.bob.file.phase, Phase::Bob(BobPhase::Done { .. })), "{}", s.bob_phase());
    s
}

#[test]
fn happy_path_raw_variant_pays_bob_noid_and_alice_eth() {
    let s = happy_path(Variant::Raw);
    let w = s.world.borrow();
    let (to, amount) = w.noid_payout.clone().expect("NOID paid out");
    assert_eq!(to, s.public.params.bob_noid);
    assert_eq!(amount, s.public.params.amount_micronoid - 6_000);
    let (addr, wei) = w.eth_payout.expect("ETH paid out");
    assert_eq!(addr, s.public.params.eth.alice_receiver);
    assert_eq!(wei, s.public.params.eth.amount_wei);
    assert_eq!(w.lock_count, 1);
    // The lock Bob made used T_reveal = t_b + W_A (no Ethereum block had passed yet).
    assert_eq!(w.lock.as_ref().unwrap().timelock, T0 + W_A_S);
    // Each party acted exactly once per on-chain step.
    assert_eq!(s.alice.executor.count("fund_noid"), 1);
    assert_eq!(s.alice.executor.count("reveal_eth"), 1);
    assert_eq!(s.bob.executor.count("lock_eth"), 1);
    assert_eq!(s.bob.executor.count("claim_noid"), 1);
    assert!(s.alice.file.pending_action.is_none() && s.bob.file.pending_action.is_none());
}

#[test]
fn happy_path_stock_variant() {
    // Same flow; the claim authority is Addr(Derive(m,0)) and Bob would use client S.
    let s = happy_path(Variant::Stock);
    assert_eq!(s.public.claim_authority, s.secret.authority(Variant::Stock).to_bech32());
    assert_eq!(s.world.borrow().noid_payout.as_ref().unwrap().0, s.public.params.bob_noid);
}

#[test]
fn alice_aborts_before_funding_when_too_late_and_bob_walks_away() {
    let mut s = Scenario::new(Variant::Raw);
    // Nobody acted for a long time: tip is past lock-by - (B_fund + B_final).
    s.world.borrow_mut().advance_noid(90);
    let ra = s.tick_alice();
    assert_eq!(ra.action.kind(), "abort", "{ra:?}");
    assert!(matches!(s.alice.file.phase, Phase::Alice(AlicePhase::Aborted { .. })));
    let w = s.world.borrow();
    assert!(w.instance.is_none() && w.lock.is_none() && w.noid_payout.is_none() && w.eth_payout.is_none());
    drop(w);
    // Bob waits, then gives up once even the minimum-window lock-by height (D - 529 = 300,196) passed.
    let rb = s.tick_bob();
    assert_eq!(rb.action.kind(), "wait");
    s.world.borrow_mut().advance_noid(100); // tip 300,191: still waiting
    let rb = s.tick_bob();
    assert_eq!(rb.action.kind(), "wait");
    s.world.borrow_mut().advance_noid(6); // tip 300,197 > 300,196
    let rb = s.tick_bob();
    assert_eq!(rb.action.kind(), "abort", "{rb:?}");
    assert!(matches!(s.bob.file.phase, Phase::Bob(BobPhase::Aborted { .. })));
    assert_eq!(s.alice.executor.executed.len(), 0);
    assert_eq!(s.bob.executor.executed.len(), 0);
}

#[test]
fn alice_funded_but_bob_never_locks_alice_refunds_at_d() {
    let mut s = Scenario::new(Variant::Raw);
    s.bob.executor.offline_for.insert("lock_eth");
    s.tick_alice();
    s.world.borrow_mut().advance_noid(1);
    s.tick_both();
    s.world.borrow_mut().advance_noid(17);
    s.tick_both();
    assert_eq!(s.alice_phase(), "funding_final");
    // Bob's executor is offline: the engine decided to lock, the attempt failed and is
    // known not to have been sent, so the record is kept only as "retry" (not "unknown").
    assert_eq!(s.bob_phase(), "funding_final");
    let pending = s.bob.file.pending_action.clone().unwrap();
    assert_eq!(pending.kind, "lock_eth");
    assert!(!pending.maybe_sent);
    // Time passes; Bob's lock-by passes, he never locks. Alice waits for D.
    s.world.borrow_mut().advance_noid(200);
    let rb = s.tick_bob();
    assert_eq!(rb.action.kind(), "abort", "{rb:?}");
    let ra = s.tick_alice();
    assert_eq!(ra.action.kind(), "wait");
    // At tip = D - 1 the next call height is D: refund.
    let tip = s.world.borrow().tip;
    s.world.borrow_mut().advance_noid(s.public.params.deadline_height - 1 - tip);
    let ra = s.tick_alice();
    assert_eq!(ra.action.kind(), "refund_noid", "{ra:?}");
    assert_eq!(s.alice_phase(), "refund_submitted");
    s.world.borrow_mut().advance_noid(1);
    s.tick_alice();
    assert_eq!(s.alice_phase(), "refund_included");
    s.world.borrow_mut().advance_noid(17);
    s.tick_alice();
    assert!(matches!(s.alice.file.phase, Phase::Alice(AlicePhase::Refunded { .. })));
    let w = s.world.borrow();
    assert_eq!(w.noid_payout.as_ref().unwrap().0, s.public.params.alice_noid);
    assert!(w.eth_payout.is_none() && w.lock.is_none());
}

#[test]
fn bob_locks_but_alice_never_reveals_both_refund() {
    let mut s = Scenario::new(Variant::Raw);
    s.alice.executor.offline_for.insert("reveal_eth");
    s.run_to_lock_final();
    let ra = s.tick_alice();
    assert_eq!(ra.action.kind(), "reveal_eth");
    assert!(ra.exec_error.is_some());
    assert_eq!(s.alice_phase(), "lock_final");
    // Nothing from Alice until T_reveal: Bob refunds the ETH.
    let t_reveal = s.world.borrow().lock.as_ref().unwrap().timelock;
    s.world.borrow_mut().warp_eth_to(t_reveal);
    let rb = s.tick_bob();
    assert_eq!(rb.action.kind(), "refund_eth", "{rb:?}");
    bob_refund_mined_then_final(&mut s);
    // Alice is past her cutoff: she must NOT reveal now, and refunds NOID at D.
    let ra = s.tick_alice();
    assert_eq!(ra.action.kind(), "wait", "{ra:?}");
    assert_eq!(s.alice.executor.count("reveal_eth"), 0);
    let tip = s.world.borrow().tip;
    s.world.borrow_mut().advance_noid(s.public.params.deadline_height - 1 - tip);
    let ra = s.tick_alice();
    assert_eq!(ra.action.kind(), "refund_noid", "{ra:?}");
    s.world.borrow_mut().advance_noid(18);
    s.tick_alice();
    assert!(matches!(s.alice.file.phase, Phase::Alice(AlicePhase::Refunded { .. })));
    let w = s.world.borrow();
    assert_eq!(w.noid_payout.as_ref().unwrap().0, s.public.params.alice_noid);
    assert_eq!(w.eth_payout.unwrap().0, s.public.params.eth.bob_sender);
    assert!(w.claim_pending.is_none() && w.claimed.is_none());
}

#[test]
fn alice_reveals_exactly_at_the_cutoff_but_never_one_second_later() {
    // At T_reveal - M_A the reveal is allowed.
    let mut s = Scenario::new(Variant::Raw);
    s.run_to_lock_final();
    let t_reveal = s.world.borrow().lock.as_ref().unwrap().timelock;
    s.world.borrow_mut().warp_eth_to(t_reveal - M_A_S);
    let ra = s.tick_alice();
    assert_eq!(ra.action.kind(), "reveal_eth", "{ra:?}");

    // One second later: never.
    let mut s = Scenario::new(Variant::Raw);
    s.run_to_lock_final();
    let t_reveal = s.world.borrow().lock.as_ref().unwrap().timelock;
    s.world.borrow_mut().warp_eth_to(t_reveal - M_A_S + 1);
    let ra = s.tick_alice();
    assert_eq!(ra.action.kind(), "wait", "{ra:?}");
    assert!(ra.notes.iter().any(|n| n.contains("(I2)")), "{:?}", ra.notes);
    assert_eq!(s.alice.executor.count("reveal_eth"), 0);
    assert!(s.world.borrow().claim_pending.is_none());
}

#[test]
fn bob_claims_noid_when_the_secret_appears_while_his_refund_is_pending() {
    // Design 2.3 row 4: a late reveal is Alice's loss. Bob's tool must take the NOID
    // even though his ETH refund is already on its way.
    let mut s = Scenario::new(Variant::Raw);
    s.run_to_lock_final();
    let t_reveal = s.world.borrow().lock.as_ref().unwrap().timelock;
    s.world.borrow_mut().warp_eth_to(t_reveal);
    let rb = s.tick_bob();
    assert_eq!(rb.action.kind(), "refund_eth");
    assert_eq!(s.bob_phase(), "refund_submitted");
    // Alice's (forbidden, late) claim shows up in the mempool with the secret.
    let lock_id = s.world.borrow().lock.as_ref().unwrap().lock_id;
    s.world.borrow_mut().claim_pending = Some(swap_cli::watch::PendingPreimage { lock_id, preimage: *s.secret.bytes(), tx_hash: [0xab; 32] });
    let rb = s.tick_bob();
    assert_eq!(rb.events, vec!["eth_preimage_seen", "claim_submitted"], "{rb:?}");
    // Her claim reverts (timelock passed), his refund mines, and his NOID claim is included.
    s.world.borrow_mut().advance_eth(1);
    s.world.borrow_mut().advance_noid(18);
    s.tick_bob();
    s.tick_bob();
    assert!(matches!(s.bob.file.phase, Phase::Bob(BobPhase::Done { .. })), "{}", s.bob_phase());
    let w = s.world.borrow();
    assert_eq!(w.noid_payout.as_ref().unwrap().0, s.public.params.bob_noid);
    assert_eq!(w.eth_payout.unwrap().0, s.public.params.eth.bob_sender);
    assert!(w.claimed.is_none());
}

#[test]
fn bob_does_not_reprove_into_a_foreign_pending_close() {
    let mut s = Scenario::new(Variant::Raw);
    s.run_to_lock_final();
    s.tick_alice();
    // Someone else (Alice, a miner) already has a close pending on the instance.
    s.world.borrow_mut().mempool.push(SimTx {
        txid: "f".repeat(64),
        fee: 5_800,
        admitted: 300_019,
        call_height: 300_020,
        kind: SimKind::Claim { preimage: *s.secret.bytes() },
    });
    let rb = s.tick_bob();
    assert_eq!(rb.events, vec!["eth_preimage_seen"]);
    assert!(matches!(&rb.action, swap_cli::engine::Action::Wait { reason } if reason.contains("T2")), "{rb:?}");
    assert_eq!(s.bob.executor.count("claim_noid"), 0);
    // It gets evicted: now Bob proves.
    s.world.borrow_mut().evict_all();
    let rb = s.tick_bob();
    assert_eq!(rb.action.kind(), "claim_noid");
}

#[test]
fn bob_reproves_after_his_claim_is_evicted() {
    let mut s = Scenario::new(Variant::Raw);
    s.run_to_lock_final();
    s.tick_alice();
    let rb = s.tick_bob();
    assert_eq!(rb.action.kind(), "claim_noid");
    let first = match &s.bob.file.phase {
        Phase::Bob(BobPhase::ClaimSubmitted { txid, attempts, .. }) => {
            assert_eq!(*attempts, 1);
            txid.clone()
        }
        other => panic!("{other:?}"),
    };
    // The anchor rotates / the node drops it: evicted without inclusion.
    s.world.borrow_mut().evict_all();
    let rb = s.tick_bob();
    assert_eq!(rb.events[0], "noid_tx_evicted", "{rb:?}");
    assert_eq!(rb.action.kind(), "claim_noid");
    match &s.bob.file.phase {
        Phase::Bob(BobPhase::ClaimSubmitted { txid, attempts, .. }) => {
            assert_eq!(*attempts, 2);
            assert_ne!(*txid, first);
        }
        other => panic!("{other:?}"),
    }
    s.world.borrow_mut().advance_noid(18);
    s.tick_bob();
    assert!(matches!(s.bob.file.phase, Phase::Bob(BobPhase::Done { .. })));
    assert_eq!(s.world.borrow().evicted, vec![first]);
}

#[test]
fn bob_offline_until_d_loses_the_noid_claim_and_alice_takes_the_noid_back_ending_with_both_legs() {
    // REVIEW-2 F9 (b): Alice revealed and has the ETH; Bob never claims. Before F9 the NOID stayed in the contract
    // "until Alice refunds it manually"; now her engine says `refund_noid` at D.
    let mut s = Scenario::new(Variant::Raw);
    s.run_to_lock_final();
    s.tick_alice();
    s.world.borrow_mut().advance_eth(4); // Alice's claim mined and final: she has the ETH.
    s.bob.executor.offline_for.insert("claim_noid");
    let rb = s.tick_bob();
    assert_eq!(rb.action.kind(), "claim_noid");
    assert!(rb.exec_error.is_some());
    // Alice, still before D: the NOID is Bob's to claim; she only waits (and says so).
    let ra = s.tick_alice();
    assert_eq!(ra.action.kind(), "wait", "{ra:?}");
    assert_eq!(s.alice_phase(), "done");
    assert!(matches!(&ra.action, swap_cli::engine::Action::Wait { reason } if reason.contains("refund_noid opens")), "{ra:?}");
    // Bob stays offline until the branch flips.
    let d = s.public.params.deadline_height;
    let tip = s.world.borrow().tip;
    s.world.borrow_mut().advance_noid(d - 1 - tip);
    let rb = s.tick_bob();
    assert_eq!(rb.action.kind(), "abort", "{rb:?}"); // the lock is claimed: nothing of Bob's is refundable
    assert!(matches!(s.bob.file.phase, Phase::Bob(BobPhase::Aborted { .. })));
    // Alice: `done` is not the end while the instance is still at the contract.
    let ra = s.tick_alice();
    assert_eq!(ra.action.kind(), "refund_noid", "{ra:?}");
    assert_eq!(s.alice_phase(), "refund_submitted");
    s.world.borrow_mut().advance_noid(1);
    s.tick_alice();
    assert_eq!(s.alice_phase(), "refund_included");
    s.world.borrow_mut().advance_noid(17);
    let ra = s.tick_alice();
    assert!(matches!(s.alice.file.phase, Phase::Alice(AlicePhase::Refunded { .. })), "{}", s.alice_phase());
    assert!(matches!(&ra.action, swap_cli::engine::Action::Wait { reason } if reason.contains("both legs ended with Alice")), "{ra:?}");
    let w = s.world.borrow();
    assert_eq!(w.eth_payout.unwrap().0, s.public.params.eth.alice_receiver);
    assert_eq!(w.noid_payout.as_ref().unwrap().0, s.public.params.alice_noid);
    assert_eq!(s.alice.executor.count("refund_noid"), 1);
}

#[test]
fn f9_alice_whose_claim_is_still_pending_at_d_also_takes_the_noid_back() {
    // `reveal_submitted`: her ETH claim never landed (stalled) and Bob never claimed the NOID. She refunds the NOID at D.
    let mut s = Scenario::new(Variant::Raw);
    s.run_to_lock_final();
    s.world.borrow_mut().freeze_eth_claim = true;
    s.bob.executor.offline_for.insert("claim_noid");
    s.bob.executor.offline_for.insert("refund_eth");
    s.tick_alice();
    assert_eq!(s.alice_phase(), "reveal_submitted");
    let d = s.public.params.deadline_height;
    let tip = s.world.borrow().tip;
    s.world.borrow_mut().advance_noid(d - 1 - tip);
    let ra = s.tick_alice();
    assert_eq!(ra.action.kind(), "refund_noid", "{ra:?}");
    s.world.borrow_mut().advance_noid(1);
    s.tick_alice();
    s.world.borrow_mut().advance_noid(17);
    s.tick_alice();
    assert!(matches!(s.alice.file.phase, Phase::Alice(AlicePhase::Refunded { .. })), "{}", s.alice_phase());
    assert_eq!(s.world.borrow().noid_payout.as_ref().unwrap().0, s.public.params.alice_noid);
}

#[test]
fn f9_alice_does_not_refund_before_d_after_the_reveal_and_never_a_different_instance() {
    let mut s = Scenario::new(Variant::Raw);
    s.run_to_lock_final();
    s.tick_alice();
    s.world.borrow_mut().advance_eth(4);
    s.bob.executor.offline_for.insert("claim_noid");
    let d = s.public.params.deadline_height;
    let tip = s.world.borrow().tip;
    // One block before the refund opens: still waiting.
    s.world.borrow_mut().advance_noid(d - 2 - tip);
    let ra = s.tick_alice();
    assert_eq!(ra.action.kind(), "wait", "{ra:?}");
    // The recorded instance is gone and a different incarnation sits at the root: it is not refunded here.
    let mut s2 = Scenario::new(Variant::Raw);
    s2.run_to_lock_final();
    s2.tick_alice();
    s2.world.borrow_mut().advance_eth(4);
    s2.tick_alice();
    {
        let mut w = s2.world.borrow_mut();
        let fresh = swap_cli::watch::NoidInstance { slot_index: 99, creation_id: 500, amount_micronoid: w.amount };
        w.instance = Some(fresh);
        let tip = w.tip;
        w.advance_noid(d - 1 - tip);
    }
    let ra = s2.tick_alice();
    assert_eq!(ra.action.kind(), "wait", "{ra:?}");
    assert!(ra.notes.iter().any(|n| n.contains("another one sits at the root")), "{:?}", ra.notes);
    assert_eq!(s2.alice.executor.count("refund_noid"), 0);
}

#[test]
fn f9_a_reveal_stalled_past_t_reveal_bob_refunds_the_eth_after_his_claim_and_ends_with_both_legs() {
    // (a): Alice's ETH claim is accepted by the mempool but not mined before T_reveal. Bob took the secret from its
    // calldata and claimed the NOID (final long before T_reveal); at T_reveal the lock is still open: refund_eth.
    let mut s = Scenario::new(Variant::Raw);
    s.run_to_lock_final();
    s.world.borrow_mut().freeze_eth_claim = true;
    let ra = s.tick_alice();
    assert_eq!(ra.action.kind(), "reveal_eth");
    let rb = s.tick_bob();
    assert_eq!(rb.events, vec!["eth_preimage_seen", "claim_submitted"], "{rb:?}");
    s.world.borrow_mut().advance_noid(1);
    s.world.borrow_mut().advance_eth(1);
    s.tick_bob();
    assert_eq!(s.bob_phase(), "claim_included");
    s.world.borrow_mut().advance_noid(17);
    s.tick_bob();
    assert!(matches!(s.bob.file.phase, Phase::Bob(BobPhase::Done { .. })), "{}", s.bob_phase());
    // Before T_reveal the lock is open but not refundable: Bob only says so.
    let rb = s.tick_bob();
    assert!(matches!(&rb.action, swap_cli::engine::Action::Wait { reason } if reason.contains("refund_eth opens at T_reveal")), "{rb:?}");
    // T_reveal passes with Alice's claim still pending.
    let t_reveal = s.world.borrow().lock.as_ref().unwrap().timelock;
    s.world.borrow_mut().warp_eth_to(t_reveal);
    let rb = s.tick_bob();
    assert_eq!(rb.action.kind(), "refund_eth", "{rb:?}");
    assert_eq!(rb.outcome.as_ref().map(|e| e.name()), Some("eth_refund_submitted".to_string()));
    // The refund is one-shot: the next tick does not send it again.
    let rb = s.tick_bob();
    assert_ne!(rb.action.kind(), "refund_eth", "{rb:?}");
    s.world.borrow_mut().advance_eth(1);
    let rb = s.tick_bob();
    assert_eq!(rb.events, vec!["eth_refund_mined"], "{rb:?}");
    assert_eq!(s.bob.executor.count("refund_eth"), 1);
    assert_eq!(s.bob.executor.count("claim_noid"), 1);
    // Alice's stalled claim now reverts (TimelockExpired / already refunded).
    s.world.borrow_mut().freeze_eth_claim = false;
    s.world.borrow_mut().advance_eth(1);
    let w = s.world.borrow();
    assert!(w.claimed.is_none(), "her claim must not have been mined");
    assert_eq!(w.eth_payout.unwrap().0, s.public.params.eth.bob_sender);
    assert_eq!(w.noid_payout.as_ref().unwrap().0, s.public.params.bob_noid);
    drop(w);
    // The refund is on record in the history.
    let h: Vec<_> = s.bob.file.history.iter().map(|e| e.event.as_str()).collect();
    assert!(h.contains(&"eth_refund_submitted") && h.contains(&"eth_refund_mined"), "{h:?}");
}

#[test]
fn f9_the_claim_goes_first_while_it_is_possible_then_the_eth_refund() {
    // The secret and T_reveal arrive together: one action per tick, the NOID claim first, a note naming the refund.
    let mut s = Scenario::new(Variant::Raw);
    s.run_to_lock_final();
    s.world.borrow_mut().freeze_eth_claim = true;
    s.tick_alice();
    let t_reveal = s.world.borrow().lock.as_ref().unwrap().timelock;
    s.world.borrow_mut().warp_eth_to(t_reveal);
    let rb = s.tick_bob();
    assert_eq!(rb.action.kind(), "claim_noid", "{rb:?}");
    assert!(rb.notes.iter().any(|n| n.contains("refund_eth is also due")), "{:?}", rb.notes);
    assert_eq!(s.bob_phase(), "claim_submitted");
    let rb = s.tick_bob();
    assert_eq!(rb.action.kind(), "refund_eth", "{rb:?}");
    assert_eq!(s.bob_phase(), "claim_submitted");
    // Both are on their way: the claim is included, the refund mined.
    s.world.borrow_mut().advance_noid(1);
    s.world.borrow_mut().advance_eth(1);
    s.tick_bob();
    assert_eq!(s.bob_phase(), "claim_included");
    s.world.borrow_mut().advance_noid(17);
    s.tick_bob();
    assert!(matches!(s.bob.file.phase, Phase::Bob(BobPhase::Done { .. })), "{}", s.bob_phase());
    let w = s.world.borrow();
    assert_eq!(w.eth_payout.unwrap().0, s.public.params.eth.bob_sender);
    assert_eq!(w.noid_payout.as_ref().unwrap().0, s.public.params.bob_noid);
}

#[test]
fn f9_a_closed_claim_branch_is_no_reason_to_abort_while_the_eth_lock_is_refundable() {
    // Bob saw the secret (Alice's claim is stalled in the mempool) but could not claim before D. Before F9 he aborted,
    // terminally, with his ETH still locked; now he waits for T_reveal, refunds, and only then ends.
    let mut s = Scenario::new(Variant::Raw);
    s.run_to_lock_final();
    s.world.borrow_mut().freeze_eth_claim = true;
    s.bob.executor.offline_for.insert("claim_noid");
    s.tick_alice();
    let rb = s.tick_bob();
    assert_eq!(rb.action.kind(), "claim_noid");
    assert_eq!(s.bob_phase(), "secret_seen");
    let d = s.public.params.deadline_height;
    let tip = s.world.borrow().tip;
    s.world.borrow_mut().advance_noid(d - 1 - tip);
    // T_reveal is still ahead of the Ethereum clock: wait, do not abort.
    let rb = s.tick_bob();
    assert_eq!(rb.action.kind(), "wait", "{rb:?}");
    assert!(matches!(&rb.action, swap_cli::engine::Action::Wait { reason } if reason.contains("claim branch closed") && reason.contains("T_reveal")), "{rb:?}");
    assert_eq!(s.bob_phase(), "secret_seen");
    // T_reveal passes: refund the ETH.
    let t_reveal = s.world.borrow().lock.as_ref().unwrap().timelock;
    s.world.borrow_mut().warp_eth_to(t_reveal);
    let rb = s.tick_bob();
    assert_eq!(rb.action.kind(), "refund_eth", "{rb:?}");
    assert_eq!(s.bob_phase(), "secret_seen");
    s.world.borrow_mut().advance_eth(1);
    // The lock is refunded and the claim branch is closed: now it is over for Bob (no terminal abort before this).
    let rb = s.tick_bob();
    assert_eq!(rb.events[0], "eth_refund_mined", "{rb:?}");
    assert_eq!(rb.action.kind(), "abort", "{rb:?}");
    assert!(matches!(s.bob.file.phase, Phase::Bob(BobPhase::Aborted { .. })));
    // Alice, whose claim reverted: refunds the NOID at D. Everyone is whole.
    s.world.borrow_mut().freeze_eth_claim = false;
    s.world.borrow_mut().advance_eth(1);
    let ra = s.tick_alice();
    assert_eq!(ra.action.kind(), "refund_noid", "{ra:?}");
    s.world.borrow_mut().advance_noid(18);
    s.tick_alice();
    assert!(matches!(s.alice.file.phase, Phase::Alice(AlicePhase::Refunded { .. })), "{}", s.alice_phase());
    let w = s.world.borrow();
    assert_eq!(w.eth_payout.unwrap().0, s.public.params.eth.bob_sender);
    assert_eq!(w.noid_payout.as_ref().unwrap().0, s.public.params.alice_noid);
    assert!(w.claimed.is_none());
}

#[test]
fn f9_a_lost_swap_still_aborts_when_the_lock_was_claimed() {
    // Alice's claim was mined (the lock is claimed): nothing to refund, the old abort stands (see also the engine unit
    // test for an observation without any lock).
    let mut s = Scenario::new(Variant::Raw);
    s.run_to_lock_final();
    s.tick_alice();
    s.world.borrow_mut().advance_eth(4);
    s.bob.executor.offline_for.insert("claim_noid");
    s.tick_bob();
    let d = s.public.params.deadline_height;
    let tip = s.world.borrow().tip;
    s.world.borrow_mut().advance_noid(d - 1 - tip);
    let rb = s.tick_bob();
    assert_eq!(rb.action.kind(), "abort", "{rb:?}");
    assert_eq!(s.bob.executor.count("refund_eth"), 0);
}

// ------------------------------------------------------------------ fail closed (REVIEW-1 M2)
//
// Every action that spends or commits needs each observation field its gate reads to be known
// and the observation to be fresh. The simulator's observations are complete, so each test
// blanks one field with `tick_*_with`, checks the engine only waits (never acts, never aborts,
// nothing reaches a chain, the phase does not move), then ticks on the complete observations
// and checks the action goes out.

use swap_cli::engine::{Action, TickReport, MAX_OBSERVATION_AGE_S};
use swap_cli::watch::{EthObservation, NoidObservation};

type Degrade = Box<dyn Fn(&mut NoidObservation, &mut EthObservation)>;

fn case(f: impl Fn(&mut NoidObservation, &mut EthObservation) + 'static) -> Degrade {
    Box::new(f)
}

/// A held tick: `Wait { "<field> unknown" }`, a note naming the field, no execution.
fn assert_unknown(r: &TickReport, field: &str) {
    match &r.action {
        Action::Wait { reason } => assert_eq!(reason, &format!("{field} unknown"), "{r:?}"),
        other => panic!("expected Wait({field} unknown), got {other:?}"),
    }
    assert!(r.notes.iter().any(|n| n.contains(field) && n.contains("fail closed")), "{field}: {:?}", r.notes);
    assert!(r.outcome.is_none() && r.exec_error.is_none() && r.attempt == 0, "{r:?}");
}

fn assert_stale(r: &TickReport, which: &str) {
    match &r.action {
        Action::Wait { reason } => assert!(reason.contains(&format!("{which} observation stale")), "{r:?}"),
        other => panic!("expected a stale wait, got {other:?}"),
    }
    assert!(r.notes.iter().any(|n| n.contains("stale")), "{:?}", r.notes);
    assert!(r.outcome.is_none() && r.exec_error.is_none(), "{r:?}");
}

/// Alice funded and final, Bob has seen the funding final: the next Bob tick would lock.
fn at_bob_lock(s: &mut Scenario) {
    s.tick_alice();
    s.world.borrow_mut().advance_noid(1);
    s.tick_both();
    s.world.borrow_mut().advance_noid(17);
    s.tick_alice();
    assert_eq!(s.alice_phase(), "funding_final");
    assert_eq!(s.bob_phase(), "funded");
}

#[test]
fn fund_noid_waits_on_an_unknown_epoch_anchor() {
    let mut s = Scenario::new(Variant::Raw);
    let r = s.tick_alice_with(|n, _| n.epoch_anchor = None);
    assert_unknown(&r, "noid.epoch_anchor");
    assert_eq!(s.alice_phase(), "created");
    assert_eq!(s.alice.executor.count("fund_noid"), 0);
    assert!(s.world.borrow().funding_pending.is_none());
    // A complete observation: funding goes out (once).
    let r = s.tick_alice();
    assert_eq!(r.action.kind(), "fund_noid", "{r:?}");
    assert_eq!(s.alice.executor.count("fund_noid"), 1);
}

#[test]
fn lock_eth_needs_every_field_its_gate_reads() {
    let mut s = Scenario::new(Variant::Raw);
    at_bob_lock(&mut s);
    let cases: Vec<(&str, Degrade)> = vec![
        ("noid.instance_matches_opening", case(|n, _| n.instance_matches_opening = None)),
        ("noid.active_authority", case(|n, _| n.active_authority = None)),
        ("noid.fee_estimate_1_1", case(|n, _| n.fee_estimate_1_1 = None)),
        ("eth.chain_id", case(|_, e| e.chain_id = None)),
        ("eth.latest_timestamp", case(|_, e| e.latest_timestamp = 0)),
        ("noid.observed_at", case(|n, _| n.observed_at = None)),
        ("eth.observed_at", case(|_, e| e.observed_at = None)),
    ];
    for (i, (field, degrade)) in cases.into_iter().enumerate() {
        let r = s.tick_bob_with(|n, e| degrade(n, e));
        if i == 0 {
            assert_eq!(r.events, vec!["noid_funding_final"], "{r:?}");
        }
        assert_unknown(&r, field);
        assert_eq!(s.bob.executor.count("lock_eth"), 0, "{field}");
        assert!(s.world.borrow().lock_pending.is_none() && s.world.borrow().lock.is_none(), "{field}");
        assert_eq!(s.bob_phase(), "funding_final", "{field}");
    }
    // A known chain id that is not the pinned one holds too.
    let r = s.tick_bob_with(|_, e| e.chain_id = Some(1));
    assert!(matches!(&r.action, Action::Wait { reason } if reason.contains("not the pinned chain")), "{r:?}");
    assert_eq!(s.bob.executor.count("lock_eth"), 0);
    // Complete again: the lock goes out.
    let r = s.tick_bob();
    assert_eq!(r.action.kind(), "lock_eth", "{r:?}");
    assert_eq!(s.bob_phase(), "lock_submitted");
}

#[test]
fn reveal_eth_needs_every_field_its_gate_reads() {
    let mut s = Scenario::new(Variant::Raw);
    s.run_to_lock_final();
    let cases: Vec<(&str, Degrade)> = vec![
        ("eth.chain_id", case(|_, e| e.chain_id = None)),
        ("eth.latest_timestamp", case(|_, e| e.latest_timestamp = 0)),
        ("eth.contract_code_hash", case(|_, e| e.contract_code_hash = None)),
        ("eth.lock", case(|_, e| e.lock = None)),
        ("eth.lock.receiver_is_eoa", case(|_, e| e.lock.as_mut().unwrap().receiver_is_eoa = None)),
        ("eth.lock.sender_is_eoa", case(|_, e| e.lock.as_mut().unwrap().sender_is_eoa = None)),
        ("eth.observed_at", case(|_, e| e.observed_at = None)),
    ];
    for (field, degrade) in cases {
        let r = s.tick_alice_with(|n, e| degrade(n, e));
        assert_unknown(&r, field);
        assert_eq!(s.alice.executor.count("reveal_eth"), 0, "{field}");
        assert!(s.world.borrow().claim_pending.is_none(), "{field}: the secret must not reach the chain");
        assert_eq!(s.alice_phase(), "lock_final", "{field}");
    }
    // A pinned code hash that differs holds too.
    let r = s.tick_alice_with(|_, e| e.contract_code_hash = Some([0xbb; 32]));
    assert!(matches!(&r.action, Action::Wait { reason } if reason.contains("T17")), "{r:?}");
    assert!(s.world.borrow().claim_pending.is_none());
    // The Parano1d observation is not read by the reveal gate.
    let r = s.tick_alice_with(|n, _| n.observed_at = None);
    assert_eq!(r.action.kind(), "reveal_eth", "{r:?}");
}

#[test]
fn claim_noid_needs_fee_estimate_fee_floor_and_epoch_anchor() {
    let mut s = Scenario::new(Variant::Raw);
    s.run_to_lock_final();
    assert_eq!(s.tick_alice().action.kind(), "reveal_eth");
    let cases: Vec<(&str, Degrade)> = vec![
        ("noid.fee_estimate_1_1", case(|n, _| n.fee_estimate_1_1 = None)),
        ("noid.fee_floor", case(|n, _| n.fee_floor = None)),
        ("noid.epoch_anchor", case(|n, _| n.epoch_anchor = None)),
        ("noid.observed_at", case(|n, _| n.observed_at = None)),
    ];
    for (i, (field, degrade)) in cases.into_iter().enumerate() {
        let r = s.tick_bob_with(|n, e| degrade(n, e));
        if i == 0 {
            // The fact (the secret was seen) is still recorded; only the spend is held.
            assert_eq!(r.events, vec!["eth_preimage_seen"], "{r:?}");
        }
        assert_unknown(&r, field);
        assert_eq!(s.bob.executor.count("claim_noid"), 0, "{field}");
        assert!(s.world.borrow().mempool.is_empty(), "{field}");
        assert_eq!(s.bob_phase(), "secret_seen", "{field}");
    }
    let r = s.tick_bob();
    assert_eq!(r.action.kind(), "claim_noid", "{r:?}");
    assert_eq!(s.bob_phase(), "claim_submitted");
}

#[test]
fn refund_eth_needs_a_known_chain_id() {
    let mut s = Scenario::new(Variant::Raw);
    s.run_to_lock_final();
    let t_reveal = s.world.borrow().lock.as_ref().unwrap().timelock;
    s.world.borrow_mut().warp_eth_to(t_reveal);
    for (field, degrade) in [
        ("eth.chain_id", case(|_, e| e.chain_id = None)),
        ("eth.observed_at", case(|_, e| e.observed_at = None)),
    ] {
        let r = s.tick_bob_with(|n, e| degrade(n, e));
        assert_unknown(&r, field);
        assert_eq!(s.bob.executor.count("refund_eth"), 0, "{field}");
        assert!(!s.world.borrow().refund_pending);
        assert_eq!(s.bob_phase(), "locked", "{field}");
    }
    let r = s.tick_bob();
    assert_eq!(r.action.kind(), "refund_eth", "{r:?}");
    assert_eq!(s.bob_phase(), "refund_submitted");
}

/// Alice funded and final; Bob never acts; the chain is at D - 1 (the next call is the refund).
fn alice_at_refund_time() -> Scenario {
    let mut s = Scenario::new(Variant::Raw);
    s.tick_alice();
    s.world.borrow_mut().advance_noid(1);
    s.tick_alice();
    s.world.borrow_mut().advance_noid(17);
    s.tick_alice();
    assert_eq!(s.alice_phase(), "funding_final");
    let tip = s.world.borrow().tip;
    s.world.borrow_mut().advance_noid(s.public.params.deadline_height - 1 - tip);
    s
}

#[test]
fn refund_noid_needs_fee_estimate_fee_floor_and_epoch_anchor() {
    let mut s = alice_at_refund_time();
    let cases: Vec<(&str, Degrade)> = vec![
        ("noid.fee_estimate_1_1", case(|n, _| n.fee_estimate_1_1 = None)),
        ("noid.fee_floor", case(|n, _| n.fee_floor = None)),
        ("noid.epoch_anchor", case(|n, _| n.epoch_anchor = None)),
        ("noid.observed_at", case(|n, _| n.observed_at = None)),
    ];
    for (field, degrade) in cases {
        let r = s.tick_alice_with(|n, e| degrade(n, e));
        assert_unknown(&r, field);
        assert_eq!(s.alice.executor.count("refund_noid"), 0, "{field}");
        assert!(s.world.borrow().mempool.is_empty(), "{field}");
        assert_eq!(s.alice_phase(), "funding_final", "{field}");
    }
    let r = s.tick_alice();
    assert_eq!(r.action.kind(), "refund_noid", "{r:?}");
    assert_eq!(s.alice_phase(), "refund_submitted");
}

#[test]
fn a_stale_or_future_observation_holds_every_spending_action_that_reads_it() {
    let max = MAX_OBSERVATION_AGE_S;
    assert_eq!(max, 120);

    // fund_noid reads the Parano1d observation.
    let mut s = Scenario::new(Variant::Raw);
    let now = s.now();
    assert_stale(&s.tick_alice_with(move |n, _| n.observed_at = Some(now - max - 1)), "noid");
    assert_eq!(s.alice.executor.count("fund_noid"), 0);
    assert_stale(&s.tick_alice_with(move |n, _| n.observed_at = Some(now + max + 1)), "noid"); // from the future
    // Exactly at the limit is still fresh.
    let r = s.tick_alice_with(move |n, _| n.observed_at = Some(now - max));
    assert_eq!(r.action.kind(), "fund_noid", "{r:?}");

    // lock_eth reads both.
    let mut s = Scenario::new(Variant::Raw);
    at_bob_lock(&mut s);
    let now = s.now();
    assert_stale(&s.tick_bob_with(move |n, _| n.observed_at = Some(now - 1_000)), "noid");
    assert_stale(&s.tick_bob_with(move |_, e| e.observed_at = Some(now - max - 1)), "eth");
    assert_eq!(s.bob.executor.count("lock_eth"), 0);
    assert_eq!(s.bob_phase(), "funding_final");
    assert_eq!(s.tick_bob_with(move |_, e| e.observed_at = Some(now - max)).action.kind(), "lock_eth");

    // reveal_eth reads the Ethereum observation only.
    let mut s = Scenario::new(Variant::Raw);
    s.run_to_lock_final();
    let now = s.now();
    assert_stale(&s.tick_alice_with(move |_, e| e.observed_at = Some(now - 600)), "eth");
    assert!(s.world.borrow().claim_pending.is_none());
    assert_eq!(s.tick_alice_with(move |n, _| n.observed_at = Some(now - 600)).action.kind(), "reveal_eth");

    // refund_eth too.
    let mut s = Scenario::new(Variant::Raw);
    s.run_to_lock_final();
    let t_reveal = s.world.borrow().lock.as_ref().unwrap().timelock;
    s.world.borrow_mut().warp_eth_to(t_reveal);
    let now = s.now();
    assert_stale(&s.tick_bob_with(move |_, e| e.observed_at = Some(now - 600)), "eth");
    assert!(!s.world.borrow().refund_pending);
    assert_eq!(s.tick_bob().action.kind(), "refund_eth");

    // claim_noid reads the Parano1d observation.
    let mut s = Scenario::new(Variant::Raw);
    s.run_to_lock_final();
    s.tick_alice();
    let now = s.now();
    assert_stale(&s.tick_bob_with(move |n, _| n.observed_at = Some(now - 600)), "noid");
    assert!(s.world.borrow().mempool.is_empty());
    assert_eq!(s.bob_phase(), "secret_seen");
    assert_eq!(s.tick_bob().action.kind(), "claim_noid");

    // refund_noid reads the Parano1d observation.
    let mut s = alice_at_refund_time();
    let now = s.now();
    assert_stale(&s.tick_alice_with(move |n, _| n.observed_at = Some(now - 600)), "noid");
    assert!(s.world.borrow().mempool.is_empty());
    assert_eq!(s.tick_alice().action.kind(), "refund_noid");
}

#[test]
fn a_pure_wait_is_not_touched_by_unknown_or_stale_observations() {
    // Nothing is spent here, so nothing is held back and no note is added.
    let mut s = Scenario::new(Variant::Raw);
    let now = s.now();
    let r = s.tick_bob_with(move |n, e| {
        n.observed_at = Some(now - 10_000);
        e.observed_at = None;
        n.fee_estimate_1_1 = None;
    });
    assert_eq!(r.action.kind(), "wait");
    assert!(r.notes.is_empty(), "{:?}", r.notes);
    assert_eq!(s.bob_phase(), "received");
}

// ---------------------------------------------------------------- Alice logs Bob's refund

/// Live run 2: Alice never reveals, Bob refunds at T_reveal. Bob logged `eth_refund_mined`;
/// Alice saw the same refund in her observation and logged nothing. She now records it,
/// once, and her phase and action stay exactly as they were.
#[test]
fn alice_logs_bobs_eth_refund_once_and_changes_nothing_else() {
    let mut s = Scenario::new(Variant::Raw);
    s.alice.executor.offline_for.insert("reveal_eth");
    s.run_to_lock_final();
    let ra = s.tick_alice();
    assert_eq!(ra.action.kind(), "reveal_eth", "{ra:?}");
    assert_eq!(s.alice_phase(), "lock_final");

    // T_reveal passes without a reveal; Bob refunds his ETH.
    let t_reveal = s.world.borrow().lock.as_ref().unwrap().timelock;
    s.world.borrow_mut().warp_eth_to(t_reveal);
    assert_eq!(s.tick_bob().action.kind(), "refund_eth");
    s.world.borrow_mut().advance_eth(1);
    let rb = s.tick_bob();
    assert_eq!(rb.events, vec!["eth_refund_mined"], "{rb:?}");
    // M2.5b: mined is not final; Bob's file says `refunded` once Ethereum finalized the block.
    assert_eq!(s.bob_phase(), "refund_mined");
    let lag = s.world.borrow().finality_lag;
    s.world.borrow_mut().advance_eth(lag);
    let rb = s.tick_bob();
    assert_eq!(rb.events, vec!["eth_refund_final"], "{rb:?}");
    assert_eq!(s.bob_phase(), "refunded");
    let refund_block = s.world.borrow().refunded.as_ref().unwrap().block_number;

    // Alice: the event once; the decision is the one she made before.
    let ra = s.tick_alice();
    assert_eq!(ra.events, vec!["eth_refund_mined"], "{ra:?}");
    assert_eq!(ra.action.kind(), "wait", "{ra:?}");
    assert!(matches!(&ra.action, Action::Wait { reason } if reason.contains("waiting for D")), "{ra:?}");
    assert!(ra.notes.iter().any(|n| n.contains("(I2)")), "{:?}", ra.notes);
    assert!(!ra.notes.iter().any(|n| n.contains("ANOMALY")), "{:?}", ra.notes);
    assert_eq!(s.alice_phase(), "lock_final");
    assert_eq!(s.alice.executor.count("reveal_eth"), 0);
    let logged = |s: &Scenario| s.alice.file.history.iter().filter(|h| h.event == "eth_refund_mined").count();
    assert_eq!(logged(&s), 1);
    let entry = s.alice.file.history.last().unwrap();
    assert_eq!((entry.from.as_str(), entry.to.as_str()), ("lock_final", "lock_final"));
    assert!(matches!(
        &s.alice.file.phase,
        Phase::Alice(AlicePhase::LockFinal { lock, .. }) if lock.block_number < refund_block
    ));

    // A further tick: nothing new.
    let ra = s.tick_alice();
    assert!(ra.events.is_empty(), "{ra:?}");
    assert_eq!(ra.action.kind(), "wait");
    assert_eq!(logged(&s), 1);

    // Resume from the persisted file: still nothing new.
    s.restart_alice();
    assert_eq!(logged(&s), 1);
    let ra = s.tick_alice();
    assert!(ra.events.is_empty(), "{ra:?}");
    assert_eq!(ra.action.kind(), "wait");
    assert_eq!(s.alice_phase(), "lock_final");
    assert_eq!(logged(&s), 1);

    // She still refunds her NOID at D.
    let tip = s.world.borrow().tip;
    s.world.borrow_mut().advance_noid(s.public.params.deadline_height - 1 - tip);
    let ra = s.tick_alice();
    assert_eq!(ra.action.kind(), "refund_noid", "{ra:?}");
    assert!(!ra.events.contains(&"eth_refund_mined".to_string()), "{ra:?}");
    s.world.borrow_mut().advance_noid(18);
    s.tick_alice();
    assert!(matches!(s.alice.file.phase, Phase::Alice(AlicePhase::Refunded { .. })));
    assert_eq!(logged(&s), 1);
}

/// Alice has not ticked since before the lock was final when the refund is already
/// on chain: both facts are recorded in order, still once, and she does not reveal.
#[test]
fn alice_coming_back_after_the_refund_records_lock_final_then_the_refund() {
    let mut s = Scenario::new(Variant::Raw);
    s.run_to_lock_final();
    assert_eq!(s.alice_phase(), "lock_seen");
    let t_reveal = s.world.borrow().lock.as_ref().unwrap().timelock;
    s.world.borrow_mut().warp_eth_to(t_reveal);
    s.tick_bob();
    bob_refund_mined_then_final(&mut s);
    let ra = s.tick_alice();
    assert_eq!(ra.events, vec!["eth_lock_final", "eth_refund_mined"], "{ra:?}");
    assert_eq!(ra.action.kind(), "wait", "{ra:?}");
    assert_eq!(s.alice_phase(), "lock_final");
    assert_eq!(s.alice.executor.count("reveal_eth"), 0);
    assert!(s.tick_alice().events.is_empty());
}


// ---------------------------------------------------------------- the rehearsal profile (ideas idea 3)
//
// The same simulator, the same engine, the same formulas; only the numbers of the profile the two swap
// files carry differ (W_A 600 s, D_offset 120). Nothing in the engine may read a production constant.

#[test]
fn rehearsal_files_commit_to_the_profile_and_use_its_numbers() {
    let s = Scenario::with_profile(Variant::Raw, ProfileName::Rehearsal);
    let g = s.gates();
    assert_eq!(s.alice.file.public.params.profile, ProfileName::Rehearsal);
    assert_eq!(s.bob.file.public.params.profile, ProfileName::Rehearsal);
    assert_eq!(s.public.params.deadline_height, s.public.params.h_create + 120);
    assert_eq!(s.public.params.lock_by_height, s.public.params.deadline_height - 68);
    assert_eq!(s.public.params.w_a_s, 600);
    assert_eq!((g.d_offset, g.w_a_s, g.m_a_s, g.b_post()), (120, 600, 300, 33));
    // The profile is written into the file and read back from it.
    let reloaded = SwapFile::load(&s.alice.path).unwrap();
    assert_eq!(reloaded.public.params.profile, ProfileName::Rehearsal);
}

#[test]
fn rehearsal_happy_path_raw_and_stock_pay_bob_noid_and_alice_eth() {
    for variant in [Variant::Raw, Variant::Stock] {
        let s = happy_path_in(variant, ProfileName::Rehearsal);
        let g = s.gates();
        let w = s.world.borrow();
        let (to, amount) = w.noid_payout.clone().expect("NOID paid out");
        assert_eq!(to, s.public.params.bob_noid);
        assert_eq!(amount, s.public.params.amount_micronoid - 6_000);
        let (addr, wei) = w.eth_payout.expect("ETH paid out");
        assert_eq!(addr, s.public.params.eth.alice_receiver);
        assert_eq!(wei, s.public.params.eth.amount_wei);
        assert_eq!(w.lock_count, 1);
        // The lock Bob made used the rehearsal window, not the production one.
        assert_eq!(w.lock.as_ref().unwrap().timelock, T0 + g.w_a_s);
        assert_ne!(g.w_a_s, W_A_S);
        // The whole swap settled well inside the rehearsal deadline.
        assert!(w.tip < s.public.params.deadline_height, "tip {} D {}", w.tip, s.public.params.deadline_height);
        assert_eq!(s.alice.executor.count("fund_noid"), 1);
        assert_eq!(s.alice.executor.count("reveal_eth"), 1);
        assert_eq!(s.bob.executor.count("lock_eth"), 1);
        assert_eq!(s.bob.executor.count("claim_noid"), 1);
    }
}

#[test]
fn rehearsal_alice_never_reveals_both_refund_in_about_120_blocks() {
    let mut s = Scenario::with_profile(Variant::Raw, ProfileName::Rehearsal);
    let h_create = s.public.params.h_create;
    let d = s.public.params.deadline_height;
    s.alice.executor.offline_for.insert("reveal_eth");
    s.run_to_lock_final();
    let ra = s.tick_alice();
    assert_eq!(ra.action.kind(), "reveal_eth");
    assert!(ra.exec_error.is_some());
    // Nothing from Alice until T_reveal = t_b + 600 s: Bob refunds the ETH.
    let t_reveal = s.world.borrow().lock.as_ref().unwrap().timelock;
    assert_eq!(t_reveal, T0 + 600);
    s.world.borrow_mut().warp_eth_to(t_reveal);
    let rb = s.tick_bob();
    assert_eq!(rb.action.kind(), "refund_eth", "{rb:?}");
    bob_refund_mined_then_final(&mut s);
    // Alice is past her cutoff (T_reveal - 300 s): she must NOT reveal now.
    let ra = s.tick_alice();
    assert_eq!(ra.action.kind(), "wait", "{ra:?}");
    assert_eq!(s.alice.executor.count("reveal_eth"), 0);
    // She refunds as soon as the next call height is D.
    let tip = s.world.borrow().tip;
    s.world.borrow_mut().advance_noid(d - 1 - tip);
    let ra = s.tick_alice();
    assert_eq!(ra.action.kind(), "refund_noid", "{ra:?}");
    assert_eq!(s.world.borrow().tip, d - 1, "the refund goes out at D - 1");
    s.world.borrow_mut().advance_noid(1);
    s.tick_alice();
    s.world.borrow_mut().advance_noid(17);
    s.tick_alice();
    assert!(matches!(s.alice.file.phase, Phase::Alice(AlicePhase::Refunded { .. })));
    // The full abort cycle, from the creation height to Alice's final refund: D_offset + 17 blocks
    // (about 120 blocks to the refund, 137 to its finality; one hour at 30 s per block to D).
    let used = s.world.borrow().tip - h_create;
    assert_eq!(used, 120 + 17, "abort cycle took {used} blocks");
    let w = s.world.borrow();
    assert_eq!(w.noid_payout.as_ref().unwrap().0, s.public.params.alice_noid);
    assert_eq!(w.eth_payout.unwrap().0, s.public.params.eth.bob_sender);
    assert!(w.claim_pending.is_none() && w.claimed.is_none());
}

#[test]
fn rehearsal_alice_funded_but_bob_never_locks_alice_refunds_at_d() {
    let mut s = Scenario::with_profile(Variant::Raw, ProfileName::Rehearsal);
    s.bob.executor.offline_for.insert("lock_eth");
    s.tick_alice();
    s.world.borrow_mut().advance_noid(1);
    s.tick_both();
    s.world.borrow_mut().advance_noid(17);
    s.tick_both();
    assert_eq!(s.alice_phase(), "funding_final");
    // Bob's lock-by with the minimum window is D - 62 = h_create + 58; past it he aborts.
    let tip = s.world.borrow().tip;
    assert!(tip < s.public.params.h_create + 58);
    s.world.borrow_mut().advance_noid(s.public.params.h_create + 59 - tip);
    let rb = s.tick_bob();
    assert_eq!(rb.action.kind(), "abort", "{rb:?}");
    let tip = s.world.borrow().tip;
    s.world.borrow_mut().advance_noid(s.public.params.deadline_height - 1 - tip);
    let ra = s.tick_alice();
    assert_eq!(ra.action.kind(), "refund_noid", "{ra:?}");
    s.world.borrow_mut().advance_noid(1);
    s.tick_alice();
    s.world.borrow_mut().advance_noid(17);
    s.tick_alice();
    assert!(matches!(s.alice.file.phase, Phase::Alice(AlicePhase::Refunded { .. })));
    assert_eq!(s.world.borrow().tip - s.public.params.h_create, 120 + 17);
    assert!(s.world.borrow().eth_payout.is_none());
}

#[test]
fn rehearsal_reveal_cutoff_is_t_reveal_minus_its_own_m_a() {
    let m_a = ProfileName::Rehearsal.gates().m_a_s;
    assert_ne!(m_a, M_A_S);
    // At T_reveal - 300 s the reveal is allowed ...
    let mut s = Scenario::with_profile(Variant::Raw, ProfileName::Rehearsal);
    s.run_to_lock_final();
    let t_reveal = s.world.borrow().lock.as_ref().unwrap().timelock;
    s.world.borrow_mut().warp_eth_to(t_reveal - m_a);
    assert_eq!(s.tick_alice().action.kind(), "reveal_eth");
    // ... one second later never.
    let mut s = Scenario::with_profile(Variant::Raw, ProfileName::Rehearsal);
    s.run_to_lock_final();
    let t_reveal = s.world.borrow().lock.as_ref().unwrap().timelock;
    s.world.borrow_mut().warp_eth_to(t_reveal - m_a + 1);
    let ra = s.tick_alice();
    assert_eq!(ra.action.kind(), "wait", "{ra:?}");
    assert!(ra.notes.iter().any(|n| n.contains("(I2)")), "{:?}", ra.notes);
    assert_eq!(s.alice.executor.count("reveal_eth"), 0);
}

/// The engine reads the profile from the file, not from a global: the same funding timeline gives a
/// lock under one profile's lock-by and an abort under another's.
#[test]
fn the_engine_reads_the_profile_from_the_file() {
    fn bob_after_funding(profile: ProfileName, extra_blocks: u64) -> String {
        let mut s = Scenario::with_profile(Variant::Raw, profile);
        s.tick_alice();
        s.world.borrow_mut().advance_noid(1);
        s.tick_both();
        s.world.borrow_mut().advance_noid(17);
        // Bob sees the funding become final now (his B_bob window starts here) but cannot send yet.
        s.bob.executor.offline_for.insert("lock_eth");
        s.tick_both();
        assert_eq!(s.bob_phase(), "funding_final");
        s.bob.executor.offline_for.clear();
        s.world.borrow_mut().advance_noid(extra_blocks);
        s.tick_bob().action.kind().to_string()
    }
    // Funding is final at h_create + 19. Rehearsal: B_bob = 20, so Bob may lock up to h_create + 39 (and
    // not past lock-by(min) = h_create + 58): 15 more blocks is h_create + 34, fine; 25 more is
    // h_create + 44, past his B_bob window: abort. Production (B_bob = 60) still locks at h_create + 44.
    assert_eq!(bob_after_funding(ProfileName::Rehearsal, 15), "lock_eth");
    assert_eq!(bob_after_funding(ProfileName::Rehearsal, 25), "abort");
    assert_eq!(bob_after_funding(ProfileName::Production, 25), "lock_eth");
    let p = Scenario::with_profile(Variant::Raw, ProfileName::Production);
    let r = Scenario::with_profile(Variant::Raw, ProfileName::Rehearsal);
    assert_eq!(p.public.params.deadline_height - p.public.params.h_create, 725);
    assert_eq!(r.public.params.deadline_height - r.public.params.h_create, 120);
}

// ---------------------------------------------------------------- the sepolia profile
//
// The rehearsal budgets with the real Ethereum finality: the simulator is put on a finality lag of 95
// blocks (95 x 12 s = 1,140 s, `SEPOLIA_FINALITY_LAG_BLOCKS`), because it has no time-based finality. The
// swap files name the profile and carry chain 11155111, W_A 4,200 s, D_offset 300.

#[test]
fn sepolia_files_commit_to_the_profile_and_use_its_numbers() {
    let s = Scenario::with_profile(Variant::Raw, ProfileName::Sepolia);
    let g = s.gates();
    assert_eq!(s.alice.file.public.params.profile, ProfileName::Sepolia);
    assert_eq!(s.bob.file.public.params.profile, ProfileName::Sepolia);
    assert_eq!(s.public.params.eth.chain_id, 11_155_111);
    assert_eq!(s.public.params.deadline_height, s.public.params.h_create + 300);
    assert_eq!(s.public.params.lock_by_height, s.public.params.deadline_height - 251);
    assert_eq!(s.public.params.w_a_s, 4_200);
    assert_eq!((g.d_offset, g.w_a_s, g.m_a_s, g.b_post(), g.eth_finality_s), (300, 4_200, 1_800, 33, 1_140));
    // The simulator's finality lag is the profile's 1,140 s in 12 s blocks.
    assert_eq!(s.world.borrow().finality_lag * 12, g.eth_finality_s);
    // The profile is written into the file and read back from it.
    let reloaded = SwapFile::load(&s.alice.path).unwrap();
    assert_eq!(reloaded.public.params.profile, ProfileName::Sepolia);
}

#[test]
fn sepolia_happy_path_raw_and_stock_pay_bob_noid_and_alice_eth() {
    for variant in [Variant::Raw, Variant::Stock] {
        let s = happy_path_in(variant, ProfileName::Sepolia);
        let g = s.gates();
        let w = s.world.borrow();
        let (to, amount) = w.noid_payout.clone().expect("NOID paid out");
        assert_eq!(to, s.public.params.bob_noid);
        assert_eq!(amount, s.public.params.amount_micronoid - 6_000);
        let (addr, wei) = w.eth_payout.expect("ETH paid out");
        assert_eq!(addr, s.public.params.eth.alice_receiver);
        assert_eq!(wei, s.public.params.eth.amount_wei);
        assert_eq!(w.lock_count, 1);
        // The lock Bob made used the sepolia window (4,200 s), neither the production nor the rehearsal one.
        assert_eq!(w.lock.as_ref().unwrap().timelock, T0 + g.w_a_s);
        assert_ne!(g.w_a_s, W_A_S);
        assert_ne!(g.w_a_s, ProfileName::Rehearsal.gates().w_a_s);
        assert!(w.tip < s.public.params.deadline_height, "tip {} D {}", w.tip, s.public.params.deadline_height);
        // The whole swap, including two Ethereum finalities, settled before Bob's Ethereum refund opened.
        assert!(w.eth_time < T0 + g.w_a_s, "eth time {} T_reveal {}", w.eth_time, T0 + g.w_a_s);
        assert_eq!(s.alice.executor.count("fund_noid"), 1);
        assert_eq!(s.alice.executor.count("reveal_eth"), 1);
        assert_eq!(s.bob.executor.count("lock_eth"), 1);
        assert_eq!(s.bob.executor.count("claim_noid"), 1);
    }
}

/// Alice waits for Bob's lock to be FINAL (1,140 s on Sepolia), reveals right then, and that is well before
/// her cutoff `T_reveal - 1,800 s`.
#[test]
fn sepolia_alice_reveals_only_once_bobs_lock_is_final_and_before_her_cutoff() {
    let mut s = Scenario::with_profile(Variant::Raw, ProfileName::Sepolia);
    let g = s.gates();
    let lag = s.world.borrow().finality_lag;
    assert_eq!(lag, 95);
    // Funding, Bob's lock, and the block that includes it.
    let r = s.tick_alice();
    assert_eq!(r.action.kind(), "fund_noid");
    s.world.borrow_mut().advance_noid(1);
    s.tick_both();
    s.world.borrow_mut().advance_noid(17);
    let (_, rb) = s.tick_both();
    assert_eq!(rb.action.kind(), "lock_eth", "{rb:?}");
    s.world.borrow_mut().advance_eth(1);
    s.tick_both();
    assert_eq!(s.alice_phase(), "lock_seen");
    let (lock_time, lock_block, t_reveal) = {
        let w = s.world.borrow();
        let l = w.lock.as_ref().unwrap();
        (l.block_timestamp.unwrap(), l.block_number, l.timelock)
    };
    assert_eq!(t_reveal, T0 + g.w_a_s);
    let cutoff = g.reveal_cutoff(t_reveal);
    assert_eq!(cutoff, t_reveal - 1_800);
    // One block short of finality: Alice waits and has not revealed.
    s.world.borrow_mut().advance_eth(lag - 1);
    assert_eq!(s.world.borrow().eth_block, lock_block + lag - 1);
    let ra = s.tick_alice();
    assert_eq!(ra.action.kind(), "wait", "{ra:?}");
    assert_eq!(s.alice_phase(), "lock_seen");
    assert_eq!(s.alice.executor.count("reveal_eth"), 0);
    assert!(s.now() - lock_time < g.eth_finality_s, "not yet 1,140 s after the lock's block");
    // The finalizing block: now (and only now) Alice reveals, inside her cutoff.
    s.world.borrow_mut().advance_eth(1);
    let ra = s.tick_alice();
    assert_eq!(ra.action.kind(), "reveal_eth", "{ra:?}");
    assert_eq!(s.alice.executor.count("reveal_eth"), 1);
    let now = s.now();
    assert!(now - lock_time >= g.eth_finality_s, "revealed {} s after the lock's block", now - lock_time);
    assert!(now <= cutoff, "now {now} cutoff {cutoff}");
    // Plenty of room: more than the 1,140 s finality of her own claim fits between the reveal and T_reveal.
    assert!(t_reveal - now > g.eth_finality_s);
}

#[test]
fn sepolia_alice_never_reveals_both_refund_in_about_317_blocks() {
    let mut s = Scenario::with_profile(Variant::Raw, ProfileName::Sepolia);
    let h_create = s.public.params.h_create;
    let d = s.public.params.deadline_height;
    s.alice.executor.offline_for.insert("reveal_eth");
    s.run_to_lock_final();
    let ra = s.tick_alice();
    assert_eq!(ra.action.kind(), "reveal_eth");
    assert!(ra.exec_error.is_some());
    // Nothing from Alice until T_reveal = t_b + 4,200 s: Bob refunds the ETH.
    let t_reveal = s.world.borrow().lock.as_ref().unwrap().timelock;
    assert_eq!(t_reveal, T0 + 4_200);
    s.world.borrow_mut().warp_eth_to(t_reveal);
    let rb = s.tick_bob();
    assert_eq!(rb.action.kind(), "refund_eth", "{rb:?}");
    bob_refund_mined_then_final(&mut s);
    // Alice is past her cutoff (T_reveal - 1,800 s): she must NOT reveal now.
    let ra = s.tick_alice();
    assert_eq!(ra.action.kind(), "wait", "{ra:?}");
    assert_eq!(s.alice.executor.count("reveal_eth"), 0);
    // She refunds as soon as the next call height is D.
    let tip = s.world.borrow().tip;
    s.world.borrow_mut().advance_noid(d - 1 - tip);
    let ra = s.tick_alice();
    assert_eq!(ra.action.kind(), "refund_noid", "{ra:?}");
    assert_eq!(s.world.borrow().tip, d - 1, "the refund goes out at D - 1");
    s.world.borrow_mut().advance_noid(1);
    s.tick_alice();
    s.world.borrow_mut().advance_noid(17);
    s.tick_alice();
    assert!(matches!(s.alice.file.phase, Phase::Alice(AlicePhase::Refunded { .. })));
    // The full abort cycle: D_offset + 17 blocks = 317 (about 2 h 40 at 30 s per block).
    let used = s.world.borrow().tip - h_create;
    assert_eq!(used, 300 + 17, "abort cycle took {used} blocks");
    let w = s.world.borrow();
    assert_eq!(w.noid_payout.as_ref().unwrap().0, s.public.params.alice_noid);
    assert_eq!(w.eth_payout.unwrap().0, s.public.params.eth.bob_sender);
    assert!(w.claim_pending.is_none() && w.claimed.is_none());
}

#[test]
fn sepolia_alice_funded_but_bob_never_locks_alice_refunds_at_d() {
    let mut s = Scenario::with_profile(Variant::Raw, ProfileName::Sepolia);
    s.bob.executor.offline_for.insert("lock_eth");
    s.tick_alice();
    s.world.borrow_mut().advance_noid(1);
    s.tick_both();
    s.world.borrow_mut().advance_noid(17);
    s.tick_both();
    assert_eq!(s.alice_phase(), "funding_final");
    // Bob's lock-by with the minimum window is D - 209 = h_create + 91; past it he aborts.
    let tip = s.world.borrow().tip;
    assert!(tip < s.public.params.h_create + 91);
    s.world.borrow_mut().advance_noid(s.public.params.h_create + 92 - tip);
    let rb = s.tick_bob();
    assert_eq!(rb.action.kind(), "abort", "{rb:?}");
    let tip = s.world.borrow().tip;
    s.world.borrow_mut().advance_noid(s.public.params.deadline_height - 1 - tip);
    let ra = s.tick_alice();
    assert_eq!(ra.action.kind(), "refund_noid", "{ra:?}");
    s.world.borrow_mut().advance_noid(1);
    s.tick_alice();
    s.world.borrow_mut().advance_noid(17);
    s.tick_alice();
    assert!(matches!(s.alice.file.phase, Phase::Alice(AlicePhase::Refunded { .. })));
    assert_eq!(s.world.borrow().tip - s.public.params.h_create, 300 + 17);
    assert!(s.world.borrow().eth_payout.is_none());
}

#[test]
fn sepolia_reveal_cutoff_is_t_reveal_minus_1800() {
    let m_a = ProfileName::Sepolia.gates().m_a_s;
    assert_eq!(m_a, 1_800);
    assert_eq!(m_a, M_A_S, "sepolia keeps the production M_A (live.js's default --margin-s)");
    // At T_reveal - 1,800 s the reveal is allowed ...
    let mut s = Scenario::with_profile(Variant::Raw, ProfileName::Sepolia);
    s.run_to_lock_final();
    let t_reveal = s.world.borrow().lock.as_ref().unwrap().timelock;
    s.world.borrow_mut().warp_eth_to(t_reveal - m_a);
    assert_eq!(s.tick_alice().action.kind(), "reveal_eth");
    // ... one second later never.
    let mut s = Scenario::with_profile(Variant::Raw, ProfileName::Sepolia);
    s.run_to_lock_final();
    let t_reveal = s.world.borrow().lock.as_ref().unwrap().timelock;
    s.world.borrow_mut().warp_eth_to(t_reveal - m_a + 1);
    let ra = s.tick_alice();
    assert_eq!(ra.action.kind(), "wait", "{ra:?}");
    assert!(ra.notes.iter().any(|n| n.contains("(I2)")), "{:?}", ra.notes);
    assert_eq!(s.alice.executor.count("reveal_eth"), 0);
}

// ------------------------------------------------------------------------------------------
// Contract v2 (HashTimeLockV2, fixed fee): every close pays exactly max_fee. The simulator rejects any
// other fee the way the program would (`FeeRule`), so these runs also prove the engine asks for the right one.
// ------------------------------------------------------------------------------------------

fn happy_path_v(variant: Variant, version: ContractVersion) -> Scenario {
    let mut s = Scenario::with_version(variant, version);
    s.run_to_lock_final();
    let ra = s.tick_alice();
    assert_eq!(ra.action.kind(), "reveal_eth", "{ra:?}");
    let rb = s.tick_bob();
    assert_eq!(rb.events, vec!["eth_preimage_seen", "claim_submitted"], "{rb:?}");
    assert_eq!(rb.action.kind(), "claim_noid");
    s.world.borrow_mut().advance_eth(1);
    s.world.borrow_mut().advance_noid(1);
    s.tick_both();
    assert_eq!(s.alice_phase(), "revealed");
    assert_eq!(s.bob_phase(), "claim_included");
    s.world.borrow_mut().advance_eth(3);
    s.world.borrow_mut().advance_noid(17);
    s.tick_both();
    assert!(matches!(s.alice.file.phase, Phase::Alice(AlicePhase::Done { .. })), "{}", s.alice_phase());
    assert!(matches!(s.bob.file.phase, Phase::Bob(BobPhase::Done { .. })), "{}", s.bob_phase());
    s
}

#[test]
fn v2_happy_path_raw_and_stock_pay_bob_amount_minus_max_fee() {
    for variant in [Variant::Raw, Variant::Stock] {
        let s = happy_path_v(variant, ContractVersion::V2);
        let p = &s.public.params;
        assert_eq!(p.contract_version, ContractVersion::V2);
        // The live estimate is 6,000 and the floor 5,800, but v2 ignores them: the fee is max_fee.
        assert_eq!(p.max_fee_micronoid, 50_000);
        let expected = p.amount_micronoid - p.max_fee_micronoid;
        assert_eq!(p.expected_bob_payout(), Some(expected));
        let w = s.world.borrow();
        assert_eq!(w.noid_close_fee, Some(p.max_fee_micronoid), "{variant:?}");
        let (to, amount) = w.noid_payout.clone().expect("NOID paid out");
        assert_eq!(to, p.bob_noid);
        assert_eq!(amount, expected);
        let (addr, wei) = w.eth_payout.expect("ETH paid out");
        assert_eq!(addr, p.eth.alice_receiver);
        assert_eq!(wei, p.eth.amount_wei);
        assert_eq!(s.bob.executor.count("claim_noid"), 1);
        // The action Bob executed carried the fixed fee.
        let fee = s.bob.executor.executed.iter().find_map(|a| match a {
            swap_cli::engine::Action::ClaimNoid { fee_micronoid, .. } => Some(*fee_micronoid),
            _ => None,
        });
        assert_eq!(fee, Some(50_000));
    }
}

#[test]
fn v1_happy_path_still_pays_the_live_estimate_not_max_fee() {
    // The same simulator under v1: unchanged behaviour (6,000 estimate, 50,000 only a ceiling).
    let s = happy_path_v(Variant::Raw, ContractVersion::V1);
    let w = s.world.borrow();
    assert_eq!(w.noid_close_fee, Some(6_000));
    assert_eq!(w.noid_payout.as_ref().unwrap().1, s.public.params.amount_micronoid - 6_000);
    assert_eq!(s.public.params.expected_bob_payout(), None);
}

#[test]
fn v2_alice_funded_but_bob_never_locks_alice_refunds_at_d_paying_max_fee() {
    let mut s = Scenario::with_version(Variant::Raw, ContractVersion::V2);
    s.bob.executor.offline_for.insert("lock_eth");
    s.tick_alice();
    s.world.borrow_mut().advance_noid(1);
    s.tick_both();
    s.world.borrow_mut().advance_noid(17);
    s.tick_both();
    assert_eq!(s.alice_phase(), "funding_final");
    s.world.borrow_mut().advance_noid(200);
    let rb = s.tick_bob();
    assert_eq!(rb.action.kind(), "abort", "{rb:?}");
    let tip = s.world.borrow().tip;
    s.world.borrow_mut().advance_noid(s.public.params.deadline_height - 1 - tip);
    let ra = s.tick_alice();
    assert_eq!(ra.action.kind(), "refund_noid", "{ra:?}");
    assert!(matches!(ra.action, swap_cli::engine::Action::RefundNoid { fee_micronoid: 50_000, .. }), "{ra:?}");
    s.world.borrow_mut().advance_noid(1);
    s.tick_alice();
    assert_eq!(s.alice_phase(), "refund_included");
    s.world.borrow_mut().advance_noid(17);
    s.tick_alice();
    assert!(matches!(s.alice.file.phase, Phase::Alice(AlicePhase::Refunded { .. })));
    let w = s.world.borrow();
    assert_eq!(w.noid_payout.as_ref().unwrap().0, s.public.params.alice_noid);
    // Alice gets back the amount minus the fixed fee.
    assert_eq!(w.noid_payout.as_ref().unwrap().1, s.public.params.amount_micronoid - s.public.params.max_fee_micronoid);
    assert_eq!(w.noid_close_fee, Some(50_000));
    assert!(w.eth_payout.is_none() && w.lock.is_none());
}

#[test]
fn v2_bob_locks_but_alice_never_reveals_both_refund() {
    for variant in [Variant::Raw, Variant::Stock] {
        let mut s = Scenario::with_version(variant, ContractVersion::V2);
        s.alice.executor.offline_for.insert("reveal_eth");
        s.run_to_lock_final();
        let ra = s.tick_alice();
        assert_eq!(ra.action.kind(), "reveal_eth");
        assert!(ra.exec_error.is_some());
        let t_reveal = s.world.borrow().lock.as_ref().unwrap().timelock;
        s.world.borrow_mut().warp_eth_to(t_reveal);
        let rb = s.tick_bob();
        assert_eq!(rb.action.kind(), "refund_eth", "{rb:?}");
        bob_refund_mined_then_final(&mut s);
        let ra = s.tick_alice();
        assert_eq!(ra.action.kind(), "wait", "{ra:?}");
        let tip = s.world.borrow().tip;
        s.world.borrow_mut().advance_noid(s.public.params.deadline_height - 1 - tip);
        let ra = s.tick_alice();
        assert!(matches!(ra.action, swap_cli::engine::Action::RefundNoid { fee_micronoid: 50_000, .. }), "{ra:?}");
        s.world.borrow_mut().advance_noid(18);
        s.tick_alice();
        assert!(matches!(s.alice.file.phase, Phase::Alice(AlicePhase::Refunded { .. })));
        let w = s.world.borrow();
        assert_eq!(w.noid_payout.as_ref().unwrap(), &(s.public.params.alice_noid.clone(), s.public.params.amount_micronoid - 50_000));
        assert_eq!(w.eth_payout.unwrap().0, s.public.params.eth.bob_sender);
        assert!(w.claim_pending.is_none() && w.claimed.is_none());
    }
}

#[test]
fn v2_files_carry_the_version_and_the_engine_reads_it_from_the_file() {
    let s = Scenario::with_version(Variant::Raw, ContractVersion::V2);
    assert_eq!(s.alice.file.public.params.contract_version, ContractVersion::V2);
    assert_eq!(s.bob.file.public.params.contract_version, ContractVersion::V2);
    // Same secret, same everything but the version: a different contract address.
    let v1 = swap_cli::swapfile::example_public_v(&s.secret, Variant::Raw, ContractVersion::V1);
    assert_ne!(v1.contract_root, s.public.contract_root);
    assert_ne!(v1.opening_hex, s.public.opening_hex);
    // The simulator itself refuses a v2 close at any other fee (what the program asserts).
    let mut w = Scenario::with_version(Variant::Raw, ContractVersion::V2);
    w.run_to_lock_final();
    let tip = w.world.borrow().tip;
    assert!(tip > 0);
    let err = {
        use swap_cli::engine::{Action, Executor};
        let file = &w.bob.file;
        w.bob
            .executor
            .execute(file, &Action::ClaimNoid { call_height: tip + 1, fee_micronoid: 6_000, preimage: *w.secret.bytes() }, 1)
            .unwrap_err()
    };
    assert!(err.message.contains("FeeRule") && !err.maybe_sent, "{err}");
}

// ------------------------------------------------------------------------------------------
// The F_max rule by contract version (docs/htlc-v2-fixed-fee.md section 5): T5 at lock time uses 3 x the live estimate
// for v1 and 5 x for v2, and every tick compares the node's relay floor with max_fee.
// ------------------------------------------------------------------------------------------

/// Run until Bob's funding is final and hand back the scenario; the next Bob tick is the one that decides `lock_eth`.
fn to_bob_lock_decision(version: ContractVersion) -> Scenario {
    let mut s = Scenario::with_version(Variant::Raw, version);
    let r = s.tick_alice();
    assert_eq!(r.action.kind(), "fund_noid");
    s.world.borrow_mut().advance_noid(1);
    s.tick_both();
    s.world.borrow_mut().advance_noid(17);
    s.tick_alice();
    assert_eq!(s.alice_phase(), "funding_final");
    s
}

#[test]
fn t5_multiplier_is_five_for_v2_and_three_for_v1() {
    // max_fee is 50,000 in both files (the example is built at a 5,800 estimate). A live estimate of 10,001:
    // 5 x 10,001 = 50,005 > 50,000 (v2 aborts); 3 x 10,001 = 30,003 <= 50,000 (v1 locks).
    let mut v2 = to_bob_lock_decision(ContractVersion::V2);
    assert_eq!(v2.public.params.max_fee_micronoid, 50_000);
    let rb = v2.tick_bob_with(|n, _| n.fee_estimate_1_1 = Some(10_001));
    match &rb.action {
        swap_cli::engine::Action::Abort { reason } => {
            assert!(reason.contains("T5") && reason.contains("5 x estimate 10001") && reason.contains("v2") && reason.contains("50005"), "{reason}");
        }
        other => panic!("expected an abort, got {other:?}"),
    }
    let mut v1 = to_bob_lock_decision(ContractVersion::V1);
    assert_eq!(v1.public.params.max_fee_micronoid, 50_000);
    let rb = v1.tick_bob_with(|n, _| n.fee_estimate_1_1 = Some(10_001));
    assert_eq!(rb.action.kind(), "lock_eth", "{rb:?}");
    // The boundary: v2 locks at 10,000 (5 x 10,000 = 50,000), v1 aborts only past 16,666.
    let mut v2 = to_bob_lock_decision(ContractVersion::V2);
    let rb = v2.tick_bob_with(|n, _| n.fee_estimate_1_1 = Some(10_000));
    assert_eq!(rb.action.kind(), "lock_eth", "{rb:?}");
    let mut v1 = to_bob_lock_decision(ContractVersion::V1);
    let rb = v1.tick_bob_with(|n, _| n.fee_estimate_1_1 = Some(16_667));
    assert_eq!(rb.action.kind(), "abort", "{rb:?}");
}

#[test]
fn relay_floor_at_or_above_max_fee_is_a_note_for_both_roles_and_the_action_is_unchanged() {
    const NOTE: &str = "relay floor 60,000 >= max_fee 50,000: a close cannot be relayed through this node (T5/Q6)";
    for version in [ContractVersion::V1, ContractVersion::V2] {
        // Baseline: no relay floor in the observation (a node answer without a breakdown): no note.
        let mut s = to_bob_lock_decision(version);
        let rb = s.tick_bob();
        assert_eq!(rb.action.kind(), "lock_eth", "{rb:?}");
        assert!(!rb.notes.iter().any(|n| n.contains("relay floor")), "{:?}", rb.notes);

        // Alice, before she funds: the note appears and she still funds.
        let mut s = Scenario::with_version(Variant::Raw, version);
        let ra = s.tick_alice_with(|n, _| n.relay_floor = Some(60_000));
        assert_eq!(ra.action.kind(), "fund_noid", "{ra:?}");
        assert!(ra.notes.iter().any(|n| n == NOTE), "{:?}", ra.notes);

        // Bob, at the lock decision: the floor does not stop him (only the T5 estimate rule does); the note is there.
        let mut s = to_bob_lock_decision(version);
        let rb = s.tick_bob_with(|n, _| n.relay_floor = Some(60_000));
        assert_eq!(rb.action.kind(), "lock_eth", "{rb:?}");
        assert!(rb.notes.iter().any(|n| n == NOTE), "{:?}", rb.notes);

        // Exactly max_fee counts; one below does not.
        let mut s = to_bob_lock_decision(version);
        let rb = s.tick_bob_with(|n, _| n.relay_floor = Some(50_000));
        assert!(rb.notes.iter().any(|n| n.contains("relay floor 50,000 >= max_fee 50,000")), "{:?}", rb.notes);
        let mut s = to_bob_lock_decision(version);
        let rb = s.tick_bob_with(|n, _| n.relay_floor = Some(49_999));
        assert!(!rb.notes.iter().any(|n| n.contains("relay floor")), "{:?}", rb.notes);
    }
}

#[test]
fn relay_floor_note_stops_once_the_swap_is_over() {
    let mut s = happy_path_v(Variant::Raw, ContractVersion::V2);
    let ra = s.tick_alice_with(|n, _| n.relay_floor = Some(60_000));
    let rb = s.tick_bob_with(|n, _| n.relay_floor = Some(60_000));
    assert!(!ra.notes.iter().any(|n| n.contains("relay floor")), "{:?}", ra.notes);
    assert!(!rb.notes.iter().any(|n| n.contains("relay floor")), "{:?}", rb.notes);
}

// ---------------------------------------------------------------- F6: a reorg after inclusion is noticed (REVIEW-2)
//
// An included close used to become final from the tip height alone. Now the txid stays tracked: the node must keep
// confirming it at the recorded height, or the phase goes back.

/// Bob's claim is included, then the tip runs on 17 blocks WITHOUT a tick (the tip alone would say "final").
fn bob_claim_included_unticked() -> (Scenario, String, u64) {
    let mut s = Scenario::new(Variant::Raw);
    s.run_to_lock_final();
    s.tick_alice();
    s.tick_bob();
    assert_eq!(s.bob_phase(), "claim_submitted");
    s.world.borrow_mut().advance_eth(1);
    s.world.borrow_mut().advance_noid(1);
    s.tick_both();
    let (txid, height) = match &s.bob.file.phase {
        Phase::Bob(BobPhase::ClaimIncluded { txid, height, preimage, .. }) => {
            assert!(preimage.is_some(), "the included phase keeps the secret so a reorg can go back to proving");
            (txid.clone(), *height)
        }
        other => panic!("{other:?}"),
    };
    s.world.borrow_mut().advance_noid(17);
    (s, txid, height)
}

#[test]
fn f6_a_claim_reorged_out_but_back_in_the_mempool_returns_to_claim_submitted_then_finishes() {
    let (mut s, txid, height) = bob_claim_included_unticked();
    s.world.borrow_mut().drop_close(&txid, true);
    let rb = s.tick_bob();
    assert_eq!(rb.events, vec!["noid_tx_reorged"], "{rb:?}");
    assert!(rb.notes.iter().any(|n| n.contains("REORG") && n.contains("back in the mempool")), "{rb:?}");
    assert_eq!(s.bob_phase(), "claim_submitted", "never `done` from the tip alone");
    assert_eq!(rb.action.kind(), "wait");
    // The same transaction, tracked again; no second proof.
    assert!(matches!(&s.bob.file.phase, Phase::Bob(BobPhase::ClaimSubmitted { txid: t, .. }) if *t == txid));
    assert_eq!(s.bob.executor.count("claim_noid"), 1);
    // Re-included in the next block, at a later height; the count starts again.
    s.world.borrow_mut().advance_noid(1);
    s.tick_bob();
    assert_eq!(s.bob_phase(), "claim_included");
    let new_height = match &s.bob.file.phase {
        Phase::Bob(BobPhase::ClaimIncluded { height, .. }) => *height,
        other => panic!("{other:?}"),
    };
    assert!(new_height > height + 17, "{new_height} vs {height}");
    s.world.borrow_mut().advance_noid(16);
    s.tick_bob();
    assert_eq!(s.bob_phase(), "claim_included", "16 blocks after the re-inclusion is not final");
    s.world.borrow_mut().advance_noid(1);
    s.tick_bob();
    assert!(matches!(&s.bob.file.phase, Phase::Bob(BobPhase::Done { height, .. }) if *height == new_height), "{}", s.bob_phase());
    let w = s.world.borrow();
    assert_eq!(w.noid_payout.as_ref().unwrap().0, s.public.params.bob_noid);
    assert_eq!(s.bob.executor.count("claim_noid"), 1);
}

#[test]
fn f6_a_claim_reorged_out_and_gone_goes_back_to_secret_seen_and_is_proved_again() {
    let (mut s, txid, _) = bob_claim_included_unticked();
    s.world.borrow_mut().drop_close(&txid, false);
    let rb = s.tick_bob();
    assert_eq!(rb.events, vec!["noid_tx_reorged", "claim_submitted"], "{rb:?}");
    assert!(rb.notes.iter().any(|n| n.contains("not in the mempool either")), "{rb:?}");
    // The history shows the step through secret_seen; the engine then asked for a new claim.
    let step = s.bob.file.history.iter().find(|h| h.event == "noid_tx_reorged").expect("history");
    assert_eq!((step.from.as_str(), step.to.as_str()), ("claim_included", "secret_seen"));
    assert_eq!(rb.action.kind(), "claim_noid", "{rb:?}");
    assert_eq!(s.bob.executor.count("claim_noid"), 2);
    match &s.bob.file.phase {
        Phase::Bob(BobPhase::ClaimSubmitted { txid: t, attempts, .. }) => {
            assert_ne!(*t, txid);
            assert_eq!(*attempts, 2);
        }
        other => panic!("{other:?}"),
    }
    s.world.borrow_mut().advance_noid(18);
    s.tick_bob();
    assert!(matches!(s.bob.file.phase, Phase::Bob(BobPhase::Done { .. })), "{}", s.bob_phase());
    assert_eq!(s.world.borrow().noid_payout.as_ref().unwrap().0, s.public.params.bob_noid);
}

#[test]
fn f6_a_reinclusion_at_another_height_restarts_the_finality_count() {
    let (mut s, txid, height) = bob_claim_included_unticked();
    // The tip is at height + 17: the old count would be final. The node now reports it 5 blocks later.
    let tip = s.world.borrow().tip;
    assert!(swap_cli::params::noid_final(tip, height));
    s.world.borrow_mut().move_close(&txid, height + 5);
    let rb = s.tick_bob();
    assert_eq!(rb.events, vec!["noid_tx_reincluded"], "{rb:?}");
    assert_eq!(s.bob_phase(), "claim_included", "not final at the old count");
    assert!(matches!(&s.bob.file.phase, Phase::Bob(BobPhase::ClaimIncluded { height: h, .. }) if *h == height + 5));
    // Final exactly 17 blocks after the NEW height (the tip is already height + 17: 5 more blocks, minus the last one).
    s.world.borrow_mut().advance_noid(4);
    s.tick_bob();
    assert_eq!(s.bob_phase(), "claim_included");
    s.world.borrow_mut().advance_noid(1);
    s.tick_bob();
    assert!(matches!(&s.bob.file.phase, Phase::Bob(BobPhase::Done { height: h, .. }) if *h == height + 5), "{}", s.bob_phase());
}

#[test]
fn f6_an_observation_that_never_asked_about_the_txid_is_not_a_reorg_and_not_final() {
    let (mut s, _, _) = bob_claim_included_unticked();
    // As an older recording would be: no getTx / getMempoolEntry was made for the tracked txid.
    let rb = s.tick_bob_with(|noid, _| {
        noid.confirmed_tx = None;
        noid.tracked_tx_pending = None;
    });
    assert!(rb.events.is_empty(), "{rb:?}");
    assert_eq!(s.bob_phase(), "claim_included");
    assert!(rb.notes.iter().any(|n| n.contains("did not ask the node")), "{rb:?}");
    // The next, complete poll finishes it.
    s.tick_bob();
    assert!(matches!(s.bob.file.phase, Phase::Bob(BobPhase::Done { .. })));
}

/// Alice funded and final, Bob never locks; her refund is included at D and the tip runs on 17 blocks unticked.
fn alice_refund_included_unticked() -> (Scenario, String, u64) {
    let mut s = alice_at_refund_time();
    let ra = s.tick_alice();
    assert_eq!(ra.action.kind(), "refund_noid", "{ra:?}");
    s.world.borrow_mut().advance_noid(1);
    s.tick_alice();
    let (txid, height) = match &s.alice.file.phase {
        Phase::Alice(AlicePhase::RefundIncluded { txid, height, .. }) => (txid.clone(), *height),
        other => panic!("{other:?}"),
    };
    s.world.borrow_mut().advance_noid(17);
    (s, txid, height)
}

#[test]
fn f6_alice_refund_reorged_out_returns_to_refund_submitted_then_to_refunded() {
    let (mut s, txid, height) = alice_refund_included_unticked();
    s.world.borrow_mut().drop_close(&txid, true);
    let ra = s.tick_alice();
    assert_eq!(ra.events, vec!["noid_tx_reorged"], "{ra:?}");
    assert_eq!(s.alice_phase(), "refund_submitted", "never `refunded` from the tip alone");
    assert_eq!(ra.action.kind(), "wait");
    assert_eq!(s.alice.executor.count("refund_noid"), 1);
    s.world.borrow_mut().advance_noid(1);
    s.tick_alice();
    assert_eq!(s.alice_phase(), "refund_included");
    s.world.borrow_mut().advance_noid(16);
    s.tick_alice();
    assert_eq!(s.alice_phase(), "refund_included");
    s.world.borrow_mut().advance_noid(1);
    s.tick_alice();
    assert!(matches!(&s.alice.file.phase, Phase::Alice(AlicePhase::Refunded { height: h, .. }) if *h > height), "{}", s.alice_phase());
    assert_eq!(s.world.borrow().noid_payout.as_ref().unwrap().0, s.public.params.alice_noid);
}

#[test]
fn f6_alice_refund_reorged_out_and_gone_is_offered_and_sent_again() {
    let (mut s, txid, _) = alice_refund_included_unticked();
    s.world.borrow_mut().drop_close(&txid, false);
    let ra = s.tick_alice();
    assert_eq!(ra.events, vec!["noid_tx_reorged", "noid_refund_submitted"], "{ra:?}");
    assert_eq!(ra.action.kind(), "refund_noid", "{ra:?}");
    assert_eq!(s.alice.executor.count("refund_noid"), 2);
    assert_eq!(s.alice_phase(), "refund_submitted");
    s.world.borrow_mut().advance_noid(1);
    s.tick_alice();
    s.world.borrow_mut().advance_noid(17);
    s.tick_alice();
    assert!(matches!(s.alice.file.phase, Phase::Alice(AlicePhase::Refunded { .. })), "{}", s.alice_phase());
}

#[test]
fn f6_alice_reinclusion_at_another_height_restarts_the_count() {
    let (mut s, txid, height) = alice_refund_included_unticked();
    s.world.borrow_mut().move_close(&txid, height + 3);
    let ra = s.tick_alice();
    assert_eq!(ra.events, vec!["noid_tx_reincluded"], "{ra:?}");
    assert_eq!(s.alice_phase(), "refund_included");
    s.world.borrow_mut().advance_noid(2);
    s.tick_alice();
    assert_eq!(s.alice_phase(), "refund_included", "tip is 16 past the new height");
    s.world.borrow_mut().advance_noid(1);
    s.tick_alice();
    assert!(matches!(s.alice.file.phase, Phase::Alice(AlicePhase::Refunded { height: h, .. }) if h == height + 3), "{}", s.alice_phase());
}

// ---------------------------------------------------------------- M2.5d: a close made outside the tool is recorded

/// Alice ends where live run 2 left her: Bob refunded his ETH, her file says `lock_final`, and the tip has reached D - 1.
fn alice_lock_final_after_bobs_refund() -> Scenario {
    let mut s = Scenario::new(Variant::Raw);
    s.run_to_lock_final();
    let t_reveal = s.world.borrow().lock.as_ref().unwrap().timelock;
    s.world.borrow_mut().warp_eth_to(t_reveal);
    s.tick_bob();
    bob_refund_mined_then_final(&mut s);
    let ra = s.tick_alice();
    assert_eq!(ra.events, vec!["eth_lock_final", "eth_refund_mined"], "{ra:?}");
    assert_eq!(s.alice_phase(), "lock_final");
    let tip = s.world.borrow().tip;
    s.world.borrow_mut().advance_noid(s.public.params.deadline_height - 1 - tip);
    s
}

#[test]
fn m25d_alices_close_made_with_the_wallet_cli_is_recorded_then_follows_to_refunded() {
    use swap_cli::engine::external_close_event;
    let mut s = alice_lock_final_after_bobs_refund();
    let d = s.public.params.deadline_height;
    // Before anything closed it: the instance is visible, so nothing can be recorded.
    let unknown = format!("{:064x}", 0xdead_u64);
    let obs = s.world.borrow().noid_obs(Some(&unknown));
    let err = external_close_event(&s.alice.file, &obs, &unknown).unwrap_err();
    assert!(err.contains("still visible"), "{err}");
    // The wallet CLI closes (a recovery close in block D).
    let txid = s.world.borrow_mut().close_outside(true, None);
    assert_eq!(s.world.borrow().tip, d);
    // An unknown txid is refused.
    let obs = s.world.borrow().noid_obs(Some(&unknown));
    let err = external_close_event(&s.alice.file, &obs, &unknown).unwrap_err();
    assert!(err.contains("not found"), "{err}");
    // The real one is accepted: confirmed at D, instance gone.
    let obs = s.world.borrow().noid_obs(Some(&txid));
    let event = external_close_event(&s.alice.file, &obs, &txid).unwrap();
    assert_eq!(event.name(), "noid_closed_externally");
    let now = s.now();
    s.alice.file.apply(&event, now).unwrap();
    assert_eq!(s.alice_phase(), "refund_included");
    assert!(matches!(&s.alice.file.phase, Phase::Alice(AlicePhase::RefundIncluded { txid: t, height, .. }) if *t == txid && *height == d));
    // Finality as usual, now by the tracked txid.
    s.world.borrow_mut().advance_noid(16);
    s.tick_alice();
    assert_eq!(s.alice_phase(), "refund_included");
    s.world.borrow_mut().advance_noid(1);
    let ra = s.tick_alice();
    assert_eq!(ra.events, vec!["noid_tx_final"], "{ra:?}");
    assert!(matches!(&s.alice.file.phase, Phase::Alice(AlicePhase::Refunded { height, .. }) if *height == d));
    assert_eq!(s.alice.executor.count("refund_noid"), 0);
    // The same file is now terminal: a second record is refused.
    let obs = s.world.borrow().noid_obs(Some(&txid));
    assert!(external_close_event(&s.alice.file, &obs, &txid).unwrap_err().contains("terminal"));
}

/// Bob has seen the secret on Ethereum but does the NOID claim by hand elsewhere (his executor never sends).
fn bob_secret_seen_claiming_by_hand() -> Scenario {
    let mut s = Scenario::new(Variant::Raw);
    s.run_to_lock_final();
    s.tick_alice();
    s.bob.executor.offline_for.insert("claim_noid");
    s.tick_bob();
    assert_eq!(s.bob_phase(), "secret_seen");
    s
}

#[test]
fn m25d_bobs_claim_made_elsewhere_is_recorded_then_follows_to_done() {
    use swap_cli::engine::external_close_event;
    let mut s = bob_secret_seen_claiming_by_hand();
    let txid = s.world.borrow_mut().close_outside(false, Some(*s.secret.bytes()));
    let obs = s.world.borrow().noid_obs(Some(&txid));
    let event = external_close_event(&s.bob.file, &obs, &txid).unwrap();
    let now = s.now();
    s.bob.file.apply(&event, now).unwrap();
    assert_eq!(s.bob_phase(), "claim_included");
    s.world.borrow_mut().advance_noid(17);
    s.tick_bob();
    assert!(matches!(s.bob.file.phase, Phase::Bob(BobPhase::Done { .. })), "{}", s.bob_phase());
    assert_eq!(s.world.borrow().noid_payout.as_ref().unwrap().0, s.public.params.bob_noid);
}

#[test]
fn m25d_a_close_on_the_wrong_side_of_the_deadline_or_in_the_wrong_phase_is_refused() {
    use swap_cli::engine::{check_external_close_phase, external_close_event};
    let other = format!("{:064x}", 0xbeef_u64);
    // Phases: nothing funded yet, secret not known, already revealed, a different txid already tracked.
    let fresh = Scenario::new(Variant::Raw);
    assert!(check_external_close_phase(&fresh.alice.file, &other).unwrap_err().contains("never seen funded"));
    assert!(check_external_close_phase(&fresh.bob.file, &other).unwrap_err().contains("never seen funded"));
    let mut s = Scenario::new(Variant::Raw);
    s.run_to_lock_final();
    s.tick_alice(); // reveals
    assert_eq!(s.alice_phase(), "reveal_submitted");
    // REVIEW-2 F9: after the reveal a recovery close is Alice's refund too (Bob never claimed); the deadline rule
    // below (`external_close_event`) is what keeps an early close, which paid Bob, from being recorded as hers.
    assert!(check_external_close_phase(&s.alice.file, &other).is_ok());
    s.tick_bob(); // claims through the engine: claim_submitted with its own txid
    assert_eq!(s.bob_phase(), "claim_submitted");
    assert!(check_external_close_phase(&s.bob.file, &other).unwrap_err().contains("already tracks"));
    // Alice: a close at h < D paid Bob; it is not her refund.
    let s = alice_lock_final_after_bobs_refund();
    let txid = s.world.borrow_mut().close_outside(true, None);
    let obs = s.world.borrow().noid_obs(Some(&txid));
    assert!(external_close_event(&s.alice.file, &obs, &txid).is_ok());
    let mut early = s.alice.file.clone();
    early.public.params.deadline_height += 1;
    let err = external_close_event(&early, &obs, &txid).unwrap_err();
    assert!(err.contains("before the deadline") && err.contains("pays Bob"), "{err}");
    // Bob: a close at h >= D paid Alice; it is not his claim.
    let s = bob_secret_seen_claiming_by_hand();
    let txid = s.world.borrow_mut().close_outside(false, Some(*s.secret.bytes()));
    let h = s.world.borrow().tip;
    let obs = s.world.borrow().noid_obs(Some(&txid));
    assert!(external_close_event(&s.bob.file, &obs, &txid).is_ok());
    let mut late = s.bob.file.clone();
    late.public.params.deadline_height = h;
    let err = external_close_event(&late, &obs, &txid).unwrap_err();
    assert!(err.contains("pays Alice"), "{err}");
}

// ------------------------------------------------------------------ REVIEW-2 F10: every lock and every instance

fn dust(slot: u32, creation: u64, amount: u64) -> swap_cli::watch::NoidInstance {
    swap_cli::watch::NoidInstance { slot_index: slot, creation_id: creation, amount_micronoid: amount }
}

/// A lock by Bob's address to Alice's, on the agreed terms except for what the caller changes.
fn side_lock(s: &Scenario, t_reveal: u64, amount_wei: u128) -> swap_cli::watch::EthLock {
    let p = &s.public.params.eth;
    swap_cli::watch::EthLock {
        lock_id: swap_cli::watch::eth::compute_lock_id(&p.bob_sender, &p.alice_receiver, amount_wei, &s.public.hashlock, t_reveal),
        sender: p.bob_sender,
        receiver: p.alice_receiver,
        amount_wei,
        hashlock: s.public.hashlock,
        timelock: t_reveal,
        block_number: 1,
        tx_hash: [0xdd; 32],
        claimed: false,
        refunded: false,
        receiver_is_eoa: Some(true),
        sender_is_eoa: Some(true),
        block_timestamp: Some(t_reveal - W_A_S),
    }
}

#[test]
fn f10_dust_alone_is_still_not_accepted() {
    let mut s = Scenario::new(Variant::Raw);
    s.world.borrow_mut().instances_before.push(dust(3, 5, 1_000));
    let rb = s.tick_bob();
    assert_eq!(s.bob_phase(), "received", "{rb:?}");
    assert!(rb.notes.iter().any(|n| n.contains("instance seen but not accepted") && n.contains("1000")), "{:?}", rb.notes);
}

#[test]
fn f10_a_dust_instance_in_a_lower_slot_does_not_hide_the_real_one_and_the_swap_settles() {
    let mut s = Scenario::new(Variant::Raw);
    let r = s.tick_alice();
    assert_eq!(r.action.kind(), "fund_noid");
    // Somebody dusts the root with a lower slot number than Alice's instance, before the funding lands.
    s.world.borrow_mut().instances_before.push(dust(3, 5, 1_000));
    s.world.borrow_mut().advance_noid(1);
    let (ra, rb) = s.tick_both();
    assert_eq!(s.alice_phase(), "funded", "{ra:?}");
    assert_eq!(s.bob_phase(), "funded", "{rb:?}");
    // Both recorded the REAL instance (slot 7), not the first one listed.
    for p in [&s.alice.file.phase, &s.bob.file.phase] {
        let slot = match p {
            Phase::Alice(a) => a.instance().map(|i| i.slot_index),
            Phase::Bob(b) => b.instance().map(|i| i.slot_index),
        };
        assert_eq!(slot, Some(7), "{p:?}");
    }
    assert!(ra.notes.iter().chain(rb.notes.iter()).any(|n| n.contains("2 instances at our contract root") && n.contains("slot 3")), "{:?} {:?}", ra.notes, rb.notes);
    s.world.borrow_mut().advance_noid(17);
    let (_, rb) = s.tick_both();
    assert_eq!(rb.action.kind(), "lock_eth", "{rb:?}");
    assert!(rb.notes.iter().any(|n| n.contains("2 instances")), "{:?}", rb.notes);
    s.world.borrow_mut().advance_eth(1);
    s.tick_both();
    assert_eq!(s.bob_phase(), "locked");
    let lag = s.world.borrow().finality_lag;
    s.world.borrow_mut().advance_eth(lag + 1);
    let ra = s.tick_alice();
    assert_eq!(ra.action.kind(), "reveal_eth", "{ra:?}");
    let rb = s.tick_bob();
    assert_eq!(rb.action.kind(), "claim_noid", "{rb:?}");
    s.world.borrow_mut().advance_eth(1);
    s.world.borrow_mut().advance_noid(1);
    s.tick_both();
    let lag = s.world.borrow().finality_lag;
    s.world.borrow_mut().advance_eth(lag + 1);
    s.world.borrow_mut().advance_noid(17);
    s.tick_both();
    assert!(matches!(s.alice.file.phase, Phase::Alice(AlicePhase::Done { .. })), "{}", s.alice_phase());
    assert!(matches!(s.bob.file.phase, Phase::Bob(BobPhase::Done { .. })), "{}", s.bob_phase());
    let w = s.world.borrow();
    assert_eq!(w.noid_payout.as_ref().unwrap().0, s.public.params.bob_noid);
    assert_eq!(w.eth_payout.unwrap().0, s.public.params.eth.alice_receiver);
    assert_eq!(w.instances_before.len(), 1, "the dust is still there and nobody touched it");
}

#[test]
fn f10_two_instances_that_both_fit_make_bob_refuse_to_lock_until_one_is_left() {
    let mut s = Scenario::new(Variant::Raw);
    s.tick_alice();
    s.world.borrow_mut().advance_noid(1);
    s.tick_both();
    assert_eq!(s.bob_phase(), "funded");
    // A second instance of the agreed amount appears (a gift, a double funding): which one is "the" lock's is not guessed.
    let amount = s.public.params.amount_micronoid;
    s.world.borrow_mut().instances_after.push(dust(9, 2, amount));
    s.world.borrow_mut().advance_noid(17);
    let (_, rb) = s.tick_both();
    assert_eq!(s.bob_phase(), "funding_final", "{rb:?}");
    assert_eq!(rb.action.kind(), "wait", "{rb:?}");
    assert!(matches!(&rb.action, swap_cli::engine::Action::Wait { reason } if reason.contains("more than one instance")), "{rb:?}");
    assert!(rb.notes.iter().any(|n| n.contains("not lock_eth") && n.contains("will not guess")), "{:?}", rb.notes);
    assert!(rb.notes.iter().any(|n| n.contains("2 instances at our contract root") && n.contains("slot 7") && n.contains("slot 9")), "{:?}", rb.notes);
    assert_eq!(s.bob.executor.count("lock_eth"), 0);
    // It may clear up: with one left he locks.
    s.world.borrow_mut().instances_after.clear();
    let rb = s.tick_bob();
    assert_eq!(rb.action.kind(), "lock_eth", "{rb:?}");
}

#[test]
fn f10_a_bad_first_lock_does_not_hide_the_correct_second_one() {
    let mut s = Scenario::new(Variant::Raw);
    // Bob (or anyone using his address) put a lock with the wrong amount first.
    let wrong = side_lock(&s, T0 + W_A_S, s.public.params.eth.amount_wei + 1);
    s.world.borrow_mut().locks_before.push(wrong.clone());
    s.run_to_lock_final();
    // Alice recorded the CORRECT lock (the one Bob's tool made), noting why the first one was passed over.
    let w_lock = s.world.borrow().lock.clone().unwrap();
    match &s.alice.file.phase {
        Phase::Alice(AlicePhase::LockSeen { lock, .. }) | Phase::Alice(AlicePhase::LockFinal { lock, .. }) => assert_eq!(lock.lock_id, w_lock.lock_id),
        other => panic!("{other:?}"),
    }
    let ra = s.tick_alice();
    assert_eq!(ra.action.kind(), "reveal_eth", "the wrong-amount lock is not a second matching lock: {ra:?}");
    assert!(ra.notes.iter().any(|n| n.contains("2 matching Ethereum locks") && n.contains("the one in use")), "{:?}", ra.notes);
    let rb = s.tick_bob();
    assert_eq!(rb.action.kind(), "claim_noid", "{rb:?}");
    s.world.borrow_mut().advance_eth(1);
    s.world.borrow_mut().advance_noid(1);
    s.tick_both();
    let lag = s.world.borrow().finality_lag;
    s.world.borrow_mut().advance_eth(lag + 1);
    s.world.borrow_mut().advance_noid(17);
    s.tick_both();
    assert!(matches!(s.alice.file.phase, Phase::Alice(AlicePhase::Done { .. })), "{}", s.alice_phase());
    assert!(matches!(s.bob.file.phase, Phase::Bob(BobPhase::Done { .. })), "{}", s.bob_phase());
    let w = s.world.borrow();
    assert_eq!(w.eth_payout.unwrap().0, s.public.params.eth.alice_receiver);
    assert_eq!(w.noid_payout.as_ref().unwrap().0, s.public.params.bob_noid);
}

#[test]
fn f10_two_correct_locks_before_alice_accepts_either_she_waits_and_says_why() {
    let mut s = Scenario::new(Variant::Raw);
    s.bob.executor.offline_for.insert("lock_eth");
    s.tick_alice();
    s.world.borrow_mut().advance_noid(1);
    s.tick_both();
    s.world.borrow_mut().advance_noid(17);
    s.tick_both();
    assert_eq!(s.alice_phase(), "funding_final");
    let a = side_lock(&s, T0 + W_A_S, s.public.params.eth.amount_wei);
    let b = side_lock(&s, T0 + W_A_S + 60, s.public.params.eth.amount_wei);
    s.world.borrow_mut().locks_before.push(a.clone());
    s.world.borrow_mut().locks_after.push(b.clone());
    let ra = s.tick_alice();
    assert_eq!(s.alice_phase(), "funding_final", "{ra:?}");
    assert!(ra.notes.iter().any(|n| n.contains("2 Ethereum locks pass every check")), "{:?}", ra.notes);
    assert!(ra.notes.iter().any(|n| n.contains("2 matching Ethereum locks")), "{:?}", ra.notes);
    assert_eq!(s.alice.executor.count("reveal_eth"), 0);
    // One of them goes away: she accepts the other.
    s.world.borrow_mut().locks_after.clear();
    let ra = s.tick_alice();
    assert_eq!(ra.events[0], "eth_lock_seen", "{ra:?}");
    match &s.alice.file.phase {
        Phase::Alice(AlicePhase::LockSeen { lock, .. } | AlicePhase::LockFinal { lock, .. } | AlicePhase::RevealSubmitted { lock, .. }) => {
            assert_eq!(lock.lock_id, a.lock_id)
        }
        other => panic!("{other:?}"),
    }
}

/// REVIEW-3 G2 (replaces the REVIEW-2 F10 rule "another open lock on the agreed terms stops the reveal"): a second open
/// lock on the agreed terms is Alice's to claim with the same secret, so it never stops the reveal on the recorded lock;
/// it is listed in a note. Bob gets no free cancel option by sending a second lock.
#[test]
fn g2_a_second_correct_open_lock_after_alice_accepted_the_first_does_not_stop_her_reveal() {
    let mut s = Scenario::new(Variant::Raw);
    s.run_to_lock_final();
    assert_eq!(s.alice_phase(), "lock_seen");
    let extra = side_lock(&s, T0 + W_A_S + 60, s.public.params.eth.amount_wei);
    s.world.borrow_mut().locks_after.push(extra.clone());
    let recorded = s.world.borrow().lock.clone().unwrap();
    let ra = s.tick_alice();
    assert_eq!(ra.action.kind(), "reveal_eth", "{ra:?}");
    assert_eq!(s.alice_phase(), "reveal_submitted", "{ra:?}");
    assert!(matches!(&ra.action, swap_cli::engine::Action::RevealEth { lock_id } if *lock_id == recorded.lock_id), "reveal is on the recorded lock: {ra:?}");
    assert!(
        ra.notes.iter().any(|n| n.contains("1 other open lock(s) on the agreed terms") && n.contains("claimable by Alice") && n.contains(&short_hex(&extra.lock_id))),
        "{:?}",
        ra.notes
    );
    assert_eq!(s.alice.executor.count("reveal_eth"), 1);
}

/// REVIEW-3 G2: a refunded or claimed extra lock is not "open" and is not listed.
#[test]
fn g2_a_closed_extra_lock_is_not_listed() {
    let mut s = Scenario::new(Variant::Raw);
    s.run_to_lock_final();
    let mut extra = side_lock(&s, T0 + W_A_S + 60, s.public.params.eth.amount_wei);
    extra.refunded = true;
    s.world.borrow_mut().locks_after.push(extra);
    let ra = s.tick_alice();
    assert_eq!(ra.action.kind(), "reveal_eth", "{ra:?}");
    assert!(!ra.notes.iter().any(|n| n.contains("other open lock(s)")), "{:?}", ra.notes);
}

fn short_hex(id: &[u8; 32]) -> String {
    format!("0x{}..", hex::encode(&id[..4]))
}

/// REVIEW-3 F10 (Alice): a second instance of the agreed amount at her root, mined after Bob locked. Both would be
/// Bob's to claim once the secret is public, so she does not reveal; the swap ends by refund at D.
#[test]
fn f10_alice_two_fitting_instances_at_the_root_stop_her_reveal_and_the_swap_ends_by_refund_at_d() {
    let mut s = Scenario::new(Variant::Raw);
    s.run_to_lock_final();
    assert_eq!(s.alice_phase(), "lock_seen");
    // `parano1d-cli contract fund` run twice: a second instance of the same amount lands at the same root.
    let amount = s.public.params.amount_micronoid;
    s.world.borrow_mut().instances_after.push(dust(9, 2, amount));
    let ra = s.tick_alice();
    assert_eq!(s.alice_phase(), "lock_final", "{ra:?}");
    assert_eq!(ra.action.kind(), "wait", "{ra:?}");
    assert!(
        matches!(&ra.action, swap_cli::engine::Action::Wait { reason } if reason.contains("not revealing") && reason.contains("2 instances with the agreed amount") && reason.contains("slots 7, 9")),
        "{ra:?}"
    );
    assert!(
        ra.notes.iter().any(|n| n.contains("not revealing") && n.contains("revealing would let Bob claim every one of them") && n.contains("refund the others with the wallet")),
        "{:?}",
        ra.notes
    );
    assert_eq!(s.alice.executor.count("reveal_eth"), 0);
    // Still waiting a few ticks later; no override.
    s.world.borrow_mut().advance_eth(1);
    let ra = s.tick_alice();
    assert_eq!(ra.action.kind(), "wait", "{ra:?}");
    assert_eq!(s.alice.executor.count("reveal_eth"), 0);
    // At D she takes the recorded instance back; the notes name the others for a wallet refund.
    let d = s.public.params.deadline_height;
    let tip = s.world.borrow().tip;
    s.world.borrow_mut().advance_noid(d - 1 - tip);
    let ra = s.tick_alice();
    assert_eq!(ra.action.kind(), "refund_noid", "{ra:?}");
    assert_eq!(s.alice.executor.count("reveal_eth"), 0);
    assert!(ra.notes.iter().any(|n| n.contains("2 instances at our contract root") && n.contains("slot 9")), "{:?}", ra.notes);
}

/// REVIEW-3 F10 (Alice): if the second fitting instance goes away (or never was), the reveal goes ahead.
#[test]
fn f10_alice_the_reveal_waits_only_while_two_instances_fit() {
    let mut s = Scenario::new(Variant::Raw);
    s.run_to_lock_final();
    let amount = s.public.params.amount_micronoid;
    s.world.borrow_mut().instances_after.push(dust(9, 2, amount));
    let ra = s.tick_alice();
    assert_eq!(ra.action.kind(), "wait", "{ra:?}");
    s.world.borrow_mut().instances_after.clear();
    let ra = s.tick_alice();
    assert_eq!(ra.action.kind(), "reveal_eth", "{ra:?}");
}

/// REVIEW-3 F10 (Alice): a dust instance (another amount) is not hers to lose: Bob's claim authority covers it too,
/// but it is not the agreed amount and does not stop the reveal. The "N instances" note records it.
#[test]
fn f10_alice_one_fitting_instance_plus_dust_still_reveals_and_says_so() {
    let mut s = Scenario::new(Variant::Raw);
    s.run_to_lock_final();
    s.world.borrow_mut().instances_after.push(dust(9, 2, 1_000));
    let ra = s.tick_alice();
    assert_eq!(ra.action.kind(), "reveal_eth", "{ra:?}");
    assert!(ra.notes.iter().any(|n| n.contains("2 instances at our contract root") && n.contains("slot 9") && n.contains("1,000")), "{:?}", ra.notes);
    assert!(!ra.notes.iter().any(|n| n.contains("revealing would let Bob claim every one")), "{:?}", ra.notes);
}

#[test]
fn f9_alices_wallet_refund_after_the_reveal_is_recorded_with_closed_by_and_followed_to_refunded() {
    use swap_cli::engine::external_close_event;
    let mut s = Scenario::new(Variant::Raw);
    s.run_to_lock_final();
    s.tick_alice();
    s.world.borrow_mut().advance_eth(4);
    s.tick_alice();
    assert_eq!(s.alice_phase(), "done");
    let d = s.public.params.deadline_height;
    let tip = s.world.borrow().tip;
    s.world.borrow_mut().advance_noid(d - 2 - tip);
    // A close BEFORE D paid Bob (it would be his claim): refused as Alice's refund.
    let early = s.world.borrow_mut().close_outside(true, None);
    let h = s.world.borrow().tip;
    assert!(h < d);
    let obs = s.world.borrow().noid_obs(Some(&early));
    let err = external_close_event(&s.alice.file, &obs, &early).unwrap_err();
    assert!(err.contains("before the deadline") && err.contains("pays Bob"), "{err}");
    // Put the world back: the same instance, closed by the wallet CLI at h >= D.
    let (_, inst) = s.world.borrow_mut().included.remove(&early).unwrap();
    {
        let mut w = s.world.borrow_mut();
        w.confirmed.remove(&early);
        w.instance = Some(inst);
        w.noid_payout = None;
        w.noid_close_fee = None;
        w.advance_noid(1);
    }
    let txid = s.world.borrow_mut().close_outside(true, None);
    assert!(s.world.borrow().tip >= d);
    let obs = s.world.borrow().noid_obs(Some(&txid));
    let ev = external_close_event(&s.alice.file, &obs, &txid).unwrap();
    let now = s.now();
    s.alice.file.apply(&ev, now).unwrap();
    assert_eq!(s.alice_phase(), "refund_included");
    s.world.borrow_mut().advance_noid(17);
    let ra = s.tick_alice();
    assert!(matches!(s.alice.file.phase, Phase::Alice(AlicePhase::Refunded { .. })), "{} {ra:?}", s.alice_phase());
    assert_eq!(s.world.borrow().noid_payout.as_ref().unwrap().0, s.public.params.alice_noid);
}

// ------------------------------------------------------------------ REVIEW-2 F5: lag, lies and a single source
//
// The simulator hands every tick a second node that agrees with the first (`World::noid_obs` / `eth_obs`), so every
// scenario above already runs the two-node path; the knobs below make the second node, the header time or the
// Ethereum head differ, or take the second node away.

const NEEDS_SECOND_NODE: &str =
    "a second node is required before this step (F5); pass --noid-rpc / --eth-rpc twice, or --single-node-ok to accept the risk";

fn wait_reason(r: &TickReport) -> String {
    match &r.action {
        Action::Wait { reason } => reason.clone(),
        other => panic!("expected a Wait, got {other:?}"),
    }
}

fn amount_off_by_one(l: &mut swap_cli::watch::EthLock) {
    l.amount_wei += 1;
}

fn claimed_elsewhere(l: &mut swap_cli::watch::EthLock) {
    l.claimed = true;
}

fn later_timelock(l: &mut swap_cli::watch::EthLock) {
    l.timelock += 60;
}

#[test]
fn f5_agreeing_nodes_lock_and_reveal_and_the_swap_settles() {
    let s = happy_path(Variant::Raw);
    // Both observations carried a second node all the way, and nothing was held back by it.
    let w = s.world.borrow();
    assert!(w.noid_obs(None).second.is_some() && w.eth_obs().second.is_some());
    assert_eq!(s.bob.executor.count("lock_eth"), 1);
    assert_eq!(s.alice.executor.count("reveal_eth"), 1);
}

#[test]
fn f5_a_lagging_second_noid_node_blocks_the_lock_until_the_tips_are_within_two_blocks() {
    let mut s = Scenario::new(Variant::Raw);
    at_bob_lock(&mut s);
    s.world.borrow_mut().second_tip_lag = 3;
    let r = s.tick_bob();
    let why = wait_reason(&r);
    assert!(why.contains("tips are 3 blocks apart (limit 2)") && why.contains("node 1 at") && why.contains("node 2 at"), "{why}");
    assert!(r.notes.iter().any(|n| n.contains("fail closed")), "{:?}", r.notes);
    assert_eq!(s.bob.executor.count("lock_eth"), 0);
    assert!(s.world.borrow().lock_pending.is_none());
    // Two blocks behind is still agreement.
    s.world.borrow_mut().second_tip_lag = 2;
    let r = s.tick_bob();
    assert_eq!(r.action.kind(), "lock_eth", "{r:?}");
    assert!(r.notes.iter().all(|n| !n.contains("single node")), "{:?}", r.notes);
}

#[test]
fn f5_a_second_noid_node_that_shows_another_instance_or_none_blocks_the_lock() {
    let mut s = Scenario::new(Variant::Raw);
    at_bob_lock(&mut s);
    // No instance at all (a node that is behind the funding, or lying).
    s.world.borrow_mut().second_instance = Some(None);
    let r = s.tick_bob();
    let why = wait_reason(&r);
    assert!(why.contains("disagree about the instance") && why.contains("node 2 says no instance") && why.contains("node 1 says slot 7 creation 1"), "{why}");
    // The same slot, another incarnation.
    let mut other = s.world.borrow().instance.clone().unwrap();
    other.creation_id += 1;
    s.world.borrow_mut().second_instance = Some(Some(other));
    let r = s.tick_bob();
    assert!(wait_reason(&r).contains("disagree about the instance"), "{r:?}");
    // Another amount.
    let mut other = s.world.borrow().instance.clone().unwrap();
    other.amount_micronoid += 1;
    s.world.borrow_mut().second_instance = Some(Some(other));
    assert!(wait_reason(&s.tick_bob()).contains("disagree about the instance"));
    assert_eq!(s.bob.executor.count("lock_eth"), 0);
    assert!(s.world.borrow().lock_pending.is_none());
    // Back in agreement: the lock goes out.
    s.world.borrow_mut().second_instance = None;
    assert_eq!(s.tick_bob().action.kind(), "lock_eth");
}

#[test]
fn f5_a_second_noid_node_that_cannot_be_read_blocks_the_lock_with_the_reason() {
    let mut s = Scenario::new(Variant::Raw);
    at_bob_lock(&mut s);
    s.world.borrow_mut().second_unreadable = Some("parano1d watcher (second node): transport: connect 10.0.0.9:9601".into());
    let r = s.tick_bob();
    let why = wait_reason(&r);
    assert!(why.contains("the second node could not be read") && why.contains("connect 10.0.0.9:9601"), "{why}");
    assert_eq!(s.bob.executor.count("lock_eth"), 0);
    // `--single-node-ok` is for a node that was never configured; it does not excuse one that failed.
    s.world.borrow_mut().single_node_ok = true;
    assert!(wait_reason(&s.tick_bob()).contains("could not be read"));
}

#[test]
fn f5_a_second_eth_node_with_another_lock_record_blocks_the_reveal() {
    let mut s = Scenario::new(Variant::Raw);
    s.run_to_lock_final();
    type Tamper = fn(&mut swap_cli::watch::EthLock);
    for (tamper, what) in [(amount_off_by_one as Tamper, "amount"), (claimed_elsewhere, "claimed"), (later_timelock, "timelock")] {
        s.world.borrow_mut().second_lock_tamper = Some(tamper);
        let r = s.tick_alice();
        let why = wait_reason(&r);
        assert!(why.contains("the two eth nodes disagree about the lock") && why.contains(what), "{what}: {why}");
        assert!(s.world.borrow().claim_pending.is_none(), "{what}: the secret must not reach the chain");
        assert_eq!(s.alice.executor.count("reveal_eth"), 0);
    }
    // The second node does not see the lock at all.
    s.world.borrow_mut().second_lock_tamper = None;
    s.world.borrow_mut().second_lock_hidden = true;
    let why = wait_reason(&s.tick_alice());
    assert!(why.contains("does not show the lock"), "{why}");
    assert!(s.world.borrow().claim_pending.is_none());
    // Agreement again: she reveals.
    s.world.borrow_mut().second_lock_hidden = false;
    assert_eq!(s.tick_alice().action.kind(), "reveal_eth");
}

#[test]
fn f5_the_reveal_uses_the_lower_of_the_two_finalized_heights() {
    // Node 2 far behind (more than two epochs): they disagree.
    let mut s = Scenario::new(Variant::Raw);
    s.run_to_lock_final();
    s.world.borrow_mut().second_finalized_delta = -65;
    let why = wait_reason(&s.tick_alice());
    assert!(why.contains("finalized heights are 65 blocks apart (limit 64)"), "{why}");
    // Node 2 two blocks behind: within the limit, but the lock is not final THERE (the lower height decides).
    s.world.borrow_mut().second_finalized_delta = -2;
    let why = wait_reason(&s.tick_alice());
    assert!(why.contains("final on one node only") && why.contains("the lower height decides"), "{why}");
    assert!(s.world.borrow().claim_pending.is_none());
    // Node 2 AHEAD: node 1 is the lower one and it is final: she reveals.
    s.world.borrow_mut().second_finalized_delta = 10;
    assert_eq!(s.tick_alice().action.kind(), "reveal_eth");
    // Node 2 exactly one block behind is still final at the lock's block: the boundary reveals.
    let mut s = Scenario::new(Variant::Raw);
    s.run_to_lock_final();
    s.world.borrow_mut().second_finalized_delta = -1;
    assert_eq!(s.tick_alice().action.kind(), "reveal_eth");
}

#[test]
fn f5_a_second_eth_node_on_another_chain_or_code_blocks_the_reveal() {
    // The simulator's second node shares the world; this one is checked on a hand-edited observation.
    let mut s = Scenario::new(Variant::Raw);
    s.run_to_lock_final();
    let r = s.tick_alice_with(|_, e| e.second.as_mut().unwrap().chain_id = Some(1));
    assert!(wait_reason(&r).contains("the second eth node is on chain 1"), "{r:?}");
    let r = s.tick_alice_with(|_, e| e.second.as_mut().unwrap().contract_code_hash = Some([0xbb; 32]));
    assert!(wait_reason(&r).contains("other code"), "{r:?}");
    let r = s.tick_alice_with(|_, e| e.second.as_mut().unwrap().observed_at = Some(1));
    assert!(wait_reason(&r).contains("second node") && wait_reason(&r).contains("stale"), "{r:?}");
    assert!(s.world.borrow().claim_pending.is_none());
}

#[test]
fn f5_a_stale_noid_header_time_blocks_every_noid_side_spend_and_the_reason_says_so() {
    let limit = |lag: u64| format!("trails the clock by {lag} s (limit 300 s): the node lags (F5)");
    // fund_noid (Alice's first action).
    let mut s = Scenario::new(Variant::Raw);
    s.world.borrow_mut().tip_time_lag = Some(301);
    let r = s.tick_alice();
    assert!(wait_reason(&r).contains(&limit(301)), "{r:?}");
    assert!(r.notes.iter().any(|n| n.contains("noid tip header time") && n.contains("fail closed")), "{:?}", r.notes);
    assert_eq!(s.alice.executor.count("fund_noid"), 0);
    s.world.borrow_mut().tip_time_lag = Some(300);
    assert_eq!(s.tick_alice().action.kind(), "fund_noid");

    // lock_eth (Bob).
    let mut s = Scenario::new(Variant::Raw);
    at_bob_lock(&mut s);
    s.world.borrow_mut().tip_time_lag = Some(301);
    assert!(wait_reason(&s.tick_bob()).contains(&limit(301)));
    assert_eq!(s.bob.executor.count("lock_eth"), 0);
    s.world.borrow_mut().tip_time_lag = Some(89);
    assert_eq!(s.tick_bob().action.kind(), "lock_eth");

    // reveal_eth (Alice), then claim_noid (Bob).
    let mut s = Scenario::new(Variant::Raw);
    s.run_to_lock_final();
    s.world.borrow_mut().tip_time_lag = Some(412);
    let r = s.tick_alice();
    assert!(wait_reason(&r).contains(&limit(412)), "{r:?}");
    assert!(s.world.borrow().claim_pending.is_none(), "the secret must not reach the chain");
    s.world.borrow_mut().tip_time_lag = Some(300);
    assert_eq!(s.tick_alice().action.kind(), "reveal_eth");
    s.world.borrow_mut().tip_time_lag = Some(301);
    let r = s.tick_bob();
    assert!(wait_reason(&r).contains(&limit(301)), "{r:?}");
    assert_eq!(s.bob.executor.count("claim_noid"), 0);
    s.world.borrow_mut().tip_time_lag = Some(0);
    assert_eq!(s.tick_bob().action.kind(), "claim_noid");

    // refund_noid (Alice, at D).
    let mut s = alice_at_refund_time();
    s.world.borrow_mut().tip_time_lag = Some(301);
    let r = s.tick_alice();
    assert!(wait_reason(&r).contains(&limit(301)), "{r:?}");
    assert_eq!(s.alice.executor.count("refund_noid"), 0);
    s.world.borrow_mut().tip_time_lag = Some(300);
    assert_eq!(s.tick_alice().action.kind(), "refund_noid");
}

/// REVIEW-3 F5: an unknown header time (the node fails `paranoid_getBlockHeader`, or a recording made before F5) fails
/// closed for every NOID-side spend; a known fresh time says nothing.
#[test]
fn f5_an_unknown_header_time_blocks_every_noid_side_spend_and_names_the_remedy() {
    let unknown = |r: &TickReport| {
        let why = wait_reason(r);
        assert!(
            why.contains("noid tip header time unknown") && why.contains("paranoid_getBlockHeader") && why.contains("(F5)") && why.contains("recording made before F5"),
            "{why}"
        );
        assert!(r.notes.iter().any(|n| n.contains("fail closed")), "{:?}", r.notes);
    };
    // fund_noid.
    let mut s = Scenario::new(Variant::Raw);
    s.world.borrow_mut().tip_time_lag = None;
    let r = s.tick_alice();
    unknown(&r);
    assert_eq!(s.alice.executor.count("fund_noid"), 0);
    // A known fresh time says nothing.
    s.world.borrow_mut().tip_time_lag = Some(5);
    let r = s.tick_alice();
    assert_eq!(r.action.kind(), "fund_noid");
    assert!(r.notes.iter().all(|n| !n.contains("tip header time")), "{:?}", r.notes);

    // lock_eth.
    let mut s = Scenario::new(Variant::Raw);
    at_bob_lock(&mut s);
    s.world.borrow_mut().tip_time_lag = None;
    unknown(&s.tick_bob());
    assert_eq!(s.bob.executor.count("lock_eth"), 0);
    s.world.borrow_mut().tip_time_lag = Some(0);
    assert_eq!(s.tick_bob().action.kind(), "lock_eth");

    // reveal_eth, then claim_noid.
    let mut s = Scenario::new(Variant::Raw);
    s.run_to_lock_final();
    s.world.borrow_mut().tip_time_lag = None;
    unknown(&s.tick_alice());
    assert!(s.world.borrow().claim_pending.is_none(), "the secret must not reach the chain");
    s.world.borrow_mut().tip_time_lag = Some(0);
    assert_eq!(s.tick_alice().action.kind(), "reveal_eth");
    s.world.borrow_mut().tip_time_lag = None;
    unknown(&s.tick_bob());
    assert_eq!(s.bob.executor.count("claim_noid"), 0);
    s.world.borrow_mut().tip_time_lag = Some(0);
    assert_eq!(s.tick_bob().action.kind(), "claim_noid");

    // refund_noid.
    let mut s = alice_at_refund_time();
    s.world.borrow_mut().tip_time_lag = None;
    unknown(&s.tick_alice());
    assert_eq!(s.alice.executor.count("refund_noid"), 0);
    s.world.borrow_mut().tip_time_lag = Some(0);
    assert_eq!(s.tick_alice().action.kind(), "refund_noid");

    // refund_eth never reads the NOID side: an unknown header time does not hold Bob's own ETH.
    let mut s = Scenario::new(Variant::Raw);
    s.run_to_lock_final();
    let t_reveal = s.world.borrow().lock.as_ref().unwrap().timelock;
    s.world.borrow_mut().warp_eth_to(t_reveal + 12);
    s.world.borrow_mut().tip_time_lag = None;
    assert_eq!(s.tick_bob().action.kind(), "refund_eth");
}

#[test]
fn f5_a_stale_ethereum_head_blocks_the_lock_and_the_reveal_outside_the_rehearsal_profile() {
    let mut s = Scenario::new(Variant::Raw);
    at_bob_lock(&mut s);
    s.world.borrow_mut().eth_head_lag = 601;
    let r = s.tick_bob();
    assert!(wait_reason(&r).contains("eth latest block time trails the clock by 601 s (limit 600 s)"), "{r:?}");
    assert_eq!(s.bob.executor.count("lock_eth"), 0);
    s.world.borrow_mut().eth_head_lag = 600;
    assert_eq!(s.tick_bob().action.kind(), "lock_eth");

    let mut s = Scenario::new(Variant::Raw);
    s.run_to_lock_final();
    s.world.borrow_mut().eth_head_lag = 601;
    let r = s.tick_alice();
    assert!(wait_reason(&r).contains("eth latest block time trails the clock by 601 s"), "{r:?}");
    assert!(s.world.borrow().claim_pending.is_none());
    s.world.borrow_mut().eth_head_lag = 0;
    assert_eq!(s.tick_alice().action.kind(), "reveal_eth");

    // Rehearsal runs on a local automine chain that makes no blocks while idle: the rule is skipped, with a note.
    let mut s = Scenario::with_profile(Variant::Raw, ProfileName::Rehearsal);
    s.world.borrow_mut().single_node = true;
    at_bob_lock(&mut s);
    s.world.borrow_mut().eth_head_lag = 3_000;
    let r = s.tick_bob();
    assert_eq!(r.action.kind(), "lock_eth", "{r:?}");
    assert!(r.notes.iter().any(|n| n.contains("eth head-time rule is skipped")), "{:?}", r.notes);
}

#[test]
fn f5_production_with_one_node_waits_before_the_lock_and_the_reveal_unless_single_node_ok() {
    let mut s = Scenario::new(Variant::Raw);
    s.world.borrow_mut().single_node = true;
    at_bob_lock(&mut s);
    let r = s.tick_bob();
    assert_eq!(wait_reason(&r), NEEDS_SECOND_NODE);
    assert_eq!(s.bob.executor.count("lock_eth"), 0);
    assert!(s.world.borrow().lock_pending.is_none());
    // The operator accepts the risk: the lock goes out, with a note.
    s.world.borrow_mut().single_node_ok = true;
    let r = s.tick_bob();
    assert_eq!(r.action.kind(), "lock_eth", "{r:?}");
    assert!(r.notes.iter().any(|n| n == "single node: F5 cross-check not possible"), "{:?}", r.notes);

    // The same for Alice's reveal.
    s.world.borrow_mut().advance_eth(1);
    s.tick_both();
    let lag = s.world.borrow().finality_lag;
    s.world.borrow_mut().advance_eth(lag + 1);
    s.world.borrow_mut().single_node_ok = false;
    let r = s.tick_alice();
    assert_eq!(wait_reason(&r), NEEDS_SECOND_NODE);
    assert!(s.world.borrow().claim_pending.is_none(), "the secret must not reach the chain");
    s.world.borrow_mut().single_node_ok = true;
    let r = s.tick_alice();
    assert_eq!(r.action.kind(), "reveal_eth", "{r:?}");
    assert!(r.notes.iter().any(|n| n == "single node: F5 cross-check not possible"), "{:?}", r.notes);
}

#[test]
fn f5_rehearsal_accepts_one_node_with_a_note() {
    let mut s = Scenario::with_profile(Variant::Raw, ProfileName::Rehearsal);
    s.world.borrow_mut().single_node = true;
    at_bob_lock(&mut s);
    let r = s.tick_bob();
    assert_eq!(r.action.kind(), "lock_eth", "{r:?}");
    assert!(r.notes.iter().any(|n| n == "single node: F5 cross-check not possible"), "{:?}", r.notes);
    s.world.borrow_mut().advance_eth(1);
    s.tick_both();
    let lag = s.world.borrow().finality_lag;
    s.world.borrow_mut().advance_eth(lag + 1);
    let r = s.tick_alice();
    assert_eq!(r.action.kind(), "reveal_eth", "{r:?}");
    assert!(r.notes.iter().any(|n| n == "single node: F5 cross-check not possible"), "{:?}", r.notes);
}

/// REVIEW-3 F5: `sepolia` follows the production rule: one node waits before the lock and the reveal unless `--single-node-ok`.
#[test]
fn f5_sepolia_with_one_node_waits_before_the_lock_and_the_reveal_unless_single_node_ok() {
    let mut s = Scenario::with_profile(Variant::Raw, ProfileName::Sepolia);
    s.world.borrow_mut().single_node = true;
    at_bob_lock(&mut s);
    let r = s.tick_bob();
    assert_eq!(wait_reason(&r), NEEDS_SECOND_NODE);
    assert_eq!(s.bob.executor.count("lock_eth"), 0);
    assert!(s.world.borrow().lock_pending.is_none());
    s.world.borrow_mut().single_node_ok = true;
    let r = s.tick_bob();
    assert_eq!(r.action.kind(), "lock_eth", "{r:?}");
    assert!(r.notes.iter().any(|n| n == "single node: F5 cross-check not possible"), "{:?}", r.notes);

    s.world.borrow_mut().advance_eth(1);
    s.tick_both();
    let lag = s.world.borrow().finality_lag;
    s.world.borrow_mut().advance_eth(lag + 1);
    s.world.borrow_mut().single_node_ok = false;
    let r = s.tick_alice();
    assert_eq!(wait_reason(&r), NEEDS_SECOND_NODE);
    assert!(s.world.borrow().claim_pending.is_none(), "the secret must not reach the chain");
    s.world.borrow_mut().single_node_ok = true;
    assert_eq!(s.tick_alice().action.kind(), "reveal_eth");
}

/// A foreign close pending on Bob's instance, as the primary node reports it.
fn bob_at_secret_seen_with_a_foreign_pending_close() -> Scenario {
    let mut s = Scenario::new(Variant::Raw);
    s.run_to_lock_final();
    s.tick_alice();
    s.world.borrow_mut().mempool.push(SimTx {
        txid: "f".repeat(64),
        fee: 5_800,
        admitted: 300_019,
        call_height: 300_020,
        kind: SimKind::Claim { preimage: *s.secret.bytes() },
    });
    s
}

/// REVIEW-3 F5: a lying primary reports a pending close; the second node sees none. Bob does not wait on it.
#[test]
fn f5_bob_does_not_wait_on_a_pending_close_the_second_node_does_not_see() {
    let mut s = bob_at_secret_seen_with_a_foreign_pending_close();
    let rb = s.tick_bob_with(|n, _| n.second.as_mut().unwrap().pending_calls.clear());
    assert_eq!(rb.action.kind(), "claim_noid", "{rb:?}");
    assert!(
        rb.notes.iter().any(|n| n == "the primary node reports a pending call the second node does not see: not waiting on it (F5)"),
        "{:?}",
        rb.notes
    );
}

/// REVIEW-3 F5: the wait stands with no second node, with a second node that cannot be read, with one that shows the
/// pending call too, and with one whose view is stale or behind (it proves nothing).
#[test]
fn f5_bob_keeps_waiting_on_a_pending_close_without_a_usable_second_opinion() {
    let waits = |r: &TickReport| {
        assert!(matches!(&r.action, Action::Wait { reason } if reason.contains("T2")), "{r:?}");
        assert!(r.notes.iter().all(|n| !n.contains("not waiting on it")), "{:?}", r.notes);
    };
    // Both nodes show the pending call (the simulator's default).
    let mut s = bob_at_secret_seen_with_a_foreign_pending_close();
    waits(&s.tick_bob());
    // No second node.
    s.world.borrow_mut().single_node = true;
    waits(&s.tick_bob());
    // A second node that cannot be read.
    s.world.borrow_mut().single_node = false;
    s.world.borrow_mut().second_unreadable = Some("down".into());
    waits(&s.tick_bob());
    s.world.borrow_mut().second_unreadable = None;
    // A stale second poll that shows nothing.
    let r = s.tick_bob_with(|n, _| {
        let second = n.second.as_mut().unwrap();
        second.pending_calls.clear();
        second.observed_at = Some(1);
    });
    waits(&r);
    assert!(r.notes.iter().any(|n| n.contains("second node") && n.contains("stale") && n.contains("waiting on it")), "{:?}", r.notes);
    // A second node three blocks behind that shows nothing (it may not have seen the call yet).
    s.world.borrow_mut().second_tip_lag = 3;
    let r = s.tick_bob_with(|n, _| n.second.as_mut().unwrap().pending_calls.clear());
    waits(&r);
    assert!(r.notes.iter().any(|n| n.contains("3 blocks from the first")), "{:?}", r.notes);
    assert_eq!(s.bob.executor.count("claim_noid"), 0);
    // The call is evicted: Bob proves.
    s.world.borrow_mut().second_tip_lag = 0;
    s.world.borrow_mut().evict_all();
    assert_eq!(s.tick_bob().action.kind(), "claim_noid");
}

#[test]
fn f5_watching_claims_and_refunds_work_with_one_node_or_a_disagreeing_second() {
    // Alice's recovery close needs no second node, even under production without --single-node-ok.
    let mut s = alice_at_refund_time();
    s.world.borrow_mut().single_node = true;
    let r = s.tick_alice();
    assert_eq!(r.action.kind(), "refund_noid", "{r:?}");
    assert!(r.notes.iter().all(|n| !n.contains("single node")), "{:?}", r.notes);

    // Bob's claim does not wait for a second node that is behind, hides the instance, or is gone.
    let mut s = Scenario::new(Variant::Raw);
    s.run_to_lock_final();
    assert_eq!(s.tick_alice().action.kind(), "reveal_eth");
    {
        let mut w = s.world.borrow_mut();
        w.second_tip_lag = 50;
        w.second_instance = Some(None);
        w.second_lock_hidden = true;
        w.second_unreadable = Some("down".into());
    }
    let r = s.tick_bob();
    assert_eq!(r.action.kind(), "claim_noid", "{r:?}");

    // Bob's ETH refund (no secret ever came) needs no second node either.
    let mut s = Scenario::new(Variant::Raw);
    s.run_to_lock_final();
    let t_reveal = s.world.borrow().lock.as_ref().unwrap().timelock;
    s.world.borrow_mut().warp_eth_to(t_reveal + 12);
    s.world.borrow_mut().single_node = true;
    let r = s.tick_bob();
    assert_eq!(r.action.kind(), "refund_eth", "{r:?}");
}

#[test]
fn f7_bob_sees_the_secret_from_the_get_lock_record_when_the_claimed_log_is_missing() {
    // REVIEW-3 F7: the log index lags, so Alice's mined claim shows in the contract's `getLock` record only. Bob still moves to
    // secret_seen (and claims) on the preimage the record stores; the report says where it came from.
    let mut s = Scenario::new(Variant::Raw);
    s.run_to_lock_final();
    s.world.borrow_mut().claim_log_lag = true;
    s.bob.executor.offline_for.insert("claim_noid");
    s.tick_alice();
    s.world.borrow_mut().advance_eth(1);
    assert!(s.world.borrow().claimed.is_some(), "Alice's claim is mined");
    let rb = s.tick_bob();
    assert_eq!(rb.events[0], "eth_preimage_seen", "{rb:?}");
    assert_eq!(rb.action.kind(), "claim_noid", "{rb:?}");
    assert_eq!(s.bob_phase(), "secret_seen");
    assert!(rb.notes.iter().any(|n| n.contains("getLock record") && n.contains("not from a Claimed log")), "{rb:?}");
}

// ---------------------------------------------------------------- M2.5b: Bob's ETH refund follows Ethereum finality

/// Bob locked, Alice never reveals, `T_reveal` passed and his `refund_eth` is mined; Ethereum needs 5 blocks to finalize
/// (the simulator's `finality_lag`). Returns the scenario with Bob in `refund_mined` and the refund's block number.
fn bob_refund_mined_not_final() -> (Scenario, u64) {
    let mut s = Scenario::new(Variant::Raw);
    s.alice.executor.offline_for.insert("reveal_eth");
    s.run_to_lock_final();
    s.world.borrow_mut().finality_lag = 5;
    let t_reveal = s.world.borrow().lock.as_ref().unwrap().timelock;
    s.world.borrow_mut().warp_eth_to(t_reveal);
    let rb = s.tick_bob();
    assert_eq!(rb.action.kind(), "refund_eth", "{rb:?}");
    assert_eq!(s.bob_phase(), "refund_submitted");
    s.world.borrow_mut().advance_eth(1);
    let rb = s.tick_bob();
    assert_eq!(rb.events, vec!["eth_refund_mined"], "{rb:?}");
    assert_eq!(s.bob_phase(), "refund_mined");
    let block = s.world.borrow().refunded.as_ref().unwrap().block_number;
    (s, block)
}

#[test]
fn m25b_bobs_refund_is_terminal_only_once_final() {
    let (mut s, block) = bob_refund_mined_not_final();
    assert!(!s.bob.file.phase.is_terminal());
    assert!(matches!(&s.bob.file.phase, Phase::Bob(BobPhase::RefundMined { block_number, .. }) if *block_number == block));
    // Mined at `block`, final once the finalized block reaches it (here: 5 blocks later). Not before.
    let rb = s.tick_bob();
    assert!(rb.events.is_empty(), "{rb:?}");
    assert!(
        matches!(&rb.action, Action::Wait { reason } if reason.contains("finality") && reason.contains(&format!("block {block}"))),
        "{rb:?}"
    );
    s.world.borrow_mut().advance_eth(4);
    let rb = s.tick_bob();
    assert!(rb.events.is_empty(), "{rb:?}");
    assert_eq!(s.bob_phase(), "refund_mined");
    assert!(!s.bob.file.phase.is_terminal());
    // The next block finalizes it.
    s.world.borrow_mut().advance_eth(1);
    let rb = s.tick_bob();
    assert_eq!(rb.events, vec!["eth_refund_final"], "{rb:?}");
    assert_eq!(s.bob_phase(), "refunded");
    assert!(s.bob.file.phase.is_terminal());
    assert!(matches!(&s.bob.file.phase, Phase::Bob(BobPhase::Refunded { block_number, .. }) if *block_number == block));
    // Nothing was sent twice, at any point.
    assert_eq!(s.bob.executor.count("refund_eth"), 1);
    assert_eq!(s.bob.executor.count("claim_noid"), 0);
    let h: Vec<_> = s.bob.file.history.iter().map(|e| e.event.as_str()).collect();
    assert!(h.contains(&"eth_refund_mined") && h.contains(&"eth_refund_final"), "{h:?}");
    assert_eq!(s.world.borrow().eth_payout.unwrap().0, s.public.params.eth.bob_sender);
}

#[test]
fn m25b_bobs_refund_reorged_out_returns_to_locked_and_is_sent_again() {
    let (mut s, _) = bob_refund_mined_not_final();
    s.world.borrow_mut().drop_eth_refund();
    s.world.borrow_mut().advance_eth(1);
    // The refund is gone before it was final: back to `locked`, and `refund_eth` goes out again in the same tick.
    let rb = s.tick_bob();
    assert_eq!(rb.events, vec!["eth_refund_reorged", "eth_refund_submitted"], "{rb:?}");
    assert!(rb.notes.iter().any(|n| n.contains("no longer on the chain")), "{:?}", rb.notes);
    assert_eq!(rb.action.kind(), "refund_eth", "{rb:?}");
    assert_eq!(s.bob_phase(), "refund_submitted");
    assert_eq!(s.bob.executor.count("refund_eth"), 2);
    // It lands again, at a new block: refund_mined, then final.
    s.world.borrow_mut().advance_eth(1);
    let rb = s.tick_bob();
    assert_eq!(rb.events, vec!["eth_refund_mined"], "{rb:?}");
    let block = s.world.borrow().refunded.as_ref().unwrap().block_number;
    assert!(matches!(&s.bob.file.phase, Phase::Bob(BobPhase::RefundMined { block_number, .. }) if *block_number == block));
    s.world.borrow_mut().advance_eth(5);
    let rb = s.tick_bob();
    assert_eq!(rb.events, vec!["eth_refund_final"], "{rb:?}");
    assert!(matches!(&s.bob.file.phase, Phase::Bob(BobPhase::Refunded { block_number, .. }) if *block_number == block));
    assert_eq!(s.bob.executor.count("refund_eth"), 2);
}

#[test]
fn m25b_bobs_refund_re_included_at_another_block_restarts_the_count() {
    let (mut s, block) = bob_refund_mined_not_final();
    s.world.borrow_mut().advance_eth(3);
    // A reorg mined the same refund three blocks later.
    s.world.borrow_mut().refunded.as_mut().unwrap().block_number = block + 3;
    let rb = s.tick_bob();
    assert_eq!(rb.events, vec!["eth_refund_mined"], "{rb:?}");
    assert!(matches!(&s.bob.file.phase, Phase::Bob(BobPhase::RefundMined { block_number, .. }) if *block_number == block + 3));
    // Block + 5 would have finalized the old inclusion; the new one needs block + 8.
    s.world.borrow_mut().advance_eth(2);
    let rb = s.tick_bob();
    assert!(rb.events.is_empty(), "{rb:?}");
    assert_eq!(s.bob_phase(), "refund_mined");
    s.world.borrow_mut().advance_eth(3);
    let rb = s.tick_bob();
    assert_eq!(rb.events, vec!["eth_refund_final"], "{rb:?}");
    assert_eq!(s.bob_phase(), "refunded");
}

#[test]
fn m25b_bobs_refund_reorged_into_alices_claim_gives_him_the_secret() {
    let (mut s, _) = bob_refund_mined_not_final();
    // The reorg replaced his refund by Alice's claim: the ETH is hers, the secret is public, the NOID is his to take.
    let preimage = *s.secret.bytes();
    s.world.borrow_mut().replace_eth_refund_with_claim(preimage);
    s.world.borrow_mut().advance_eth(1);
    let rb = s.tick_bob();
    assert_eq!(rb.events, vec!["eth_preimage_seen", "claim_submitted"], "{rb:?}");
    assert_eq!(rb.action.kind(), "claim_noid", "{rb:?}");
    assert_eq!(s.bob_phase(), "claim_submitted");
    s.world.borrow_mut().advance_noid(1);
    s.tick_bob();
    s.world.borrow_mut().advance_noid(17);
    s.tick_bob();
    assert!(matches!(s.bob.file.phase, Phase::Bob(BobPhase::Done { .. })), "{}", s.bob_phase());
    let w = s.world.borrow();
    assert_eq!(w.noid_payout.as_ref().unwrap().0, s.public.params.bob_noid);
    assert_eq!(w.eth_payout.unwrap().0, s.public.params.eth.alice_receiver);
    assert_eq!(s.bob.executor.count("refund_eth"), 1);
}

#[test]
fn m25b_a_refund_that_vanished_with_the_lock_not_visible_keeps_bob_in_refund_mined() {
    let (mut s, block) = bob_refund_mined_not_final();
    s.world.borrow_mut().drop_eth_refund();
    let rb = s.tick_bob_with(|_, eth| {
        eth.lock = None;
        eth.locks = Vec::new();
        eth.lock_count = 0;
    });
    assert!(rb.events.is_empty(), "{rb:?}");
    assert_eq!(s.bob_phase(), "refund_mined");
    assert!(rb.notes.iter().any(|n| n.contains(&format!("block {block}")) && n.contains("fail closed")), "{:?}", rb.notes);
    assert_eq!(s.bob.executor.count("refund_eth"), 1);
}

#[test]
fn m25b_alice_reveal_pending_bobs_refund_first_bob_never_claims_alice_refunds_at_d() {
    let mut s = Scenario::new(Variant::Raw);
    s.run_to_lock_final();
    s.world.borrow_mut().freeze_eth_claim = true;
    let ra = s.tick_alice();
    assert_eq!(ra.action.kind(), "reveal_eth", "{ra:?}");
    assert_eq!(s.alice_phase(), "reveal_submitted");
    // Bob does not tick (his tool is down): the secret in the pending calldata goes unseen. T_reveal passes with her claim
    // still pending; his refund (sent by hand) is mined first, and her claim reverts when it is finally processed.
    let ra = s.tick_alice();
    assert!(matches!(&ra.action, Action::Wait { reason } if reason == "ETH claim pending"), "{ra:?}");
    let t_reveal = s.world.borrow().lock.as_ref().unwrap().timelock;
    s.world.borrow_mut().warp_eth_to(t_reveal);
    s.world.borrow_mut().refund_pending = true;
    s.world.borrow_mut().advance_eth(1);
    s.world.borrow_mut().freeze_eth_claim = false;
    s.world.borrow_mut().advance_eth(1);
    assert!(s.world.borrow().claimed.is_none(), "her claim must have reverted");
    let refund_block = s.world.borrow().refunded.as_ref().unwrap().block_number;

    // Alice: the refund is logged, the phase does not pretend, the message is the truth.
    let ra = s.tick_alice();
    assert_eq!(ra.events, vec!["eth_refund_mined"], "{ra:?}");
    assert_eq!(s.alice_phase(), "reveal_submitted");
    match &ra.action {
        Action::Wait { reason } => {
            assert!(reason.contains("reveal lost"), "{reason}");
            assert!(reason.contains(&format!("block {refund_block}")), "{reason}");
            assert!(!reason.contains("ETH claim pending"), "{reason}");
        }
        other => panic!("{other:?}"),
    }
    assert!(ra.notes.iter().any(|n| n.contains("while our reveal was pending") && n.contains("calldata")), "{:?}", ra.notes);
    assert!(!ra.notes.iter().any(|n| n.contains("ANOMALY")), "{:?}", ra.notes);

    // Bob never claims. At D - 1 (the next call height is D) the NOID comes back.
    let tip = s.world.borrow().tip;
    s.world.borrow_mut().advance_noid(s.public.params.deadline_height - 1 - tip);
    let ra = s.tick_alice();
    assert_eq!(ra.action.kind(), "refund_noid", "{ra:?}");
    s.world.borrow_mut().advance_noid(18);
    s.tick_alice();
    assert!(matches!(s.alice.file.phase, Phase::Alice(AlicePhase::Refunded { .. })), "{}", s.alice_phase());
    let w = s.world.borrow();
    assert_eq!(w.noid_payout.as_ref().unwrap().0, s.public.params.alice_noid);
    assert_eq!(w.eth_payout.unwrap().0, s.public.params.eth.bob_sender);
    assert!(w.claimed.is_none());
    assert_eq!(s.alice.executor.count("reveal_eth"), 1);
    assert_eq!(s.alice.executor.count("refund_noid"), 1);
}

#[test]
fn m25b_alice_loses_both_legs_when_bob_refunds_and_claims_with_the_exposed_secret() {
    let mut s = Scenario::new(Variant::Raw);
    s.run_to_lock_final();
    s.world.borrow_mut().freeze_eth_claim = true;
    let ra = s.tick_alice();
    assert_eq!(ra.action.kind(), "reveal_eth", "{ra:?}");
    // Bob takes the secret from the pending calldata and claims the NOID, final long before T_reveal.
    let rb = s.tick_bob();
    assert_eq!(rb.events, vec!["eth_preimage_seen", "claim_submitted"], "{rb:?}");
    s.world.borrow_mut().advance_noid(1);
    s.world.borrow_mut().advance_eth(1);
    s.tick_bob();
    s.world.borrow_mut().advance_noid(17);
    s.tick_bob();
    assert!(matches!(s.bob.file.phase, Phase::Bob(BobPhase::Done { .. })), "{}", s.bob_phase());
    // T_reveal passes with her claim still pending: his refund is mined, her claim reverts.
    let t_reveal = s.world.borrow().lock.as_ref().unwrap().timelock;
    s.world.borrow_mut().warp_eth_to(t_reveal);
    assert_eq!(s.tick_bob().action.kind(), "refund_eth");
    s.world.borrow_mut().advance_eth(1);
    s.world.borrow_mut().freeze_eth_claim = false;
    s.world.borrow_mut().advance_eth(1);
    assert!(s.world.borrow().claimed.is_none());
    let refund_block = s.world.borrow().refunded.as_ref().unwrap().block_number;

    // Alice, first look: the refund is mined but not final, the NOID instance is gone; nothing is declared yet.
    let ra = s.tick_alice();
    assert_eq!(ra.events, vec!["eth_refund_mined"], "{ra:?}");
    assert_eq!(s.alice_phase(), "reveal_submitted");
    assert!(matches!(&ra.action, Action::Wait { reason } if reason.contains("reveal lost") && reason.contains("not final yet")), "{ra:?}");
    // The refund becomes final, but the tip has not reached D + 18: still not declared.
    s.world.borrow_mut().advance_eth(3);
    let ra = s.tick_alice();
    assert!(ra.events.is_empty(), "{ra:?}");
    assert_eq!(s.alice_phase(), "reveal_submitted");
    assert!(matches!(&ra.action, Action::Wait { reason } if reason.contains("reveal lost") && reason.contains("(final)")), "{ra:?}");
    // The recorded instance is gone, so refund_noid is never offered, at D or after.
    let d = s.public.params.deadline_height;
    let tip = s.world.borrow().tip;
    s.world.borrow_mut().advance_noid(d + 17 - tip);
    let ra = s.tick_alice();
    assert!(ra.events.is_empty(), "{ra:?}");
    assert_eq!(ra.action.kind(), "wait", "{ra:?}");
    assert_eq!(s.alice_phase(), "reveal_submitted");
    // D + 18: both facts hold. The file reaches a terminal phase that says what happened.
    s.world.borrow_mut().advance_noid(1);
    let ra = s.tick_alice();
    assert_eq!(ra.events, vec!["both_legs_lost"], "{ra:?}");
    assert_eq!(s.alice_phase(), "lost");
    assert!(s.alice.file.phase.is_terminal());
    match &s.alice.file.phase {
        Phase::Alice(AlicePhase::Lost { reason, refund_block: rb, instance, .. }) => {
            assert_eq!(*rb, refund_block);
            assert!(reason.contains(&format!("block {refund_block}")), "{reason}");
            assert!(reason.contains(&format!("slot {}", instance.slot_index)), "{reason}");
            assert!(reason.contains(&format!("creation {}", instance.creation_id)), "{reason}");
        }
        other => panic!("{other:?}"),
    }
    assert!(matches!(&ra.action, Action::Wait { reason } if reason.starts_with("lost:")), "{ra:?}");
    assert_eq!(s.alice.executor.count("reveal_eth"), 1);
    assert_eq!(s.alice.executor.count("refund_noid"), 0);
    // Terminal means terminal: a further tick changes nothing.
    let ra = s.tick_alice();
    assert!(ra.events.is_empty(), "{ra:?}");
    assert_eq!(s.alice_phase(), "lost");
    let w = s.world.borrow();
    assert_eq!(w.noid_payout.as_ref().unwrap().0, s.public.params.bob_noid);
    assert_eq!(w.eth_payout.unwrap().0, s.public.params.eth.bob_sender);
}

#[test]
fn m25b_alice_is_not_declared_lost_while_a_refund_noid_was_decided_for_her() {
    // The same ending, but her recovery close was decided (and so possibly sent from outside this tool): an instance that
    // is gone proves nothing about who closed it, so the file waits for `tick --closed-by` instead of saying "lost".
    let mut s = Scenario::new(Variant::Raw);
    s.run_to_lock_final();
    s.world.borrow_mut().freeze_eth_claim = true;
    s.tick_alice();
    let t_reveal = s.world.borrow().lock.as_ref().unwrap().timelock;
    s.world.borrow_mut().warp_eth_to(t_reveal);
    s.world.borrow_mut().refund_pending = true;
    s.world.borrow_mut().advance_eth(1);
    s.world.borrow_mut().freeze_eth_claim = false;
    s.world.borrow_mut().advance_eth(4);
    let d = s.public.params.deadline_height;
    let tip = s.world.borrow().tip;
    s.world.borrow_mut().advance_noid(d - 1 - tip);
    s.alice.file.log("intent_decided:refund_noid", 1);
    s.world.borrow_mut().close_outside(true, None);
    s.world.borrow_mut().advance_noid(20);
    let ra = s.tick_alice();
    assert!(ra.events.iter().all(|e| e != "both_legs_lost"), "{ra:?}");
    assert_eq!(s.alice_phase(), "reveal_submitted");
    assert!(ra.notes.iter().any(|n| n.contains("closed-by")), "{:?}", ra.notes);
}
