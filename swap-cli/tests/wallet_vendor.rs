//! The swap wallet's builders against the vendor's own checks (swap wallet, piece 2a).
//!
//! Every transaction built here is submitted to `wallet_node::Node`, which re-runs the vendor node's admission (the proof verification, the fee
//! rule, the exact slot comparison, the contract branch check) and, when it mines, the vendor's own state transition `apply_tx`. See that file for what is
//! the vendor's function and what is mirrored by hand.

#[path = "common/wallet_node.rs"]
mod wallet_node;

use htlc_harness as h;
use noid_poseidon2b::primitives::Address;
use noid_tx::{PagedSpendIntent, TxBody, TxPage};
use swap_cli::client::IntentSubmitter;
use swap_cli::wallet::chain::{NodeReads, WalletSlot};
use swap_cli::wallet::send::{build_send, select_for_payment, SendInputs, SendPlan};
use swap_cli::wallet::{WalletError, WalletKey};
use swap_cli::watch::RpcError;
use wallet_node::*;

fn key(seed: u8) -> WalletKey {
    WalletKey::from_secret(swap_cli::secret::Secret::from_bytes(h::seq_bytes(seed)))
}

fn target() -> Address {
    h::addr(h::seq_bytes(0xA0))
}

/// Select, ask the node for slots, anchor and height, and build: what the funding and the sweep do, without a swap file.
fn pay(node: &Node, k: &WalletKey, to: &Address, amount: u64) -> SendPlan {
    let reads = NodeReads::new(node);
    let view = reads.slots_by_owner(&k.address()).unwrap();
    let sel = select_for_payment(&view.plain, amount, &mut |i, o| reads.fee_for(i, o)).unwrap();
    let tip = reads.tip().unwrap();
    let anchor = reads.epoch_anchor().unwrap();
    let slots = reads.output_slots(&k.address(), 1 + usize::from(sel.change > 0)).unwrap();
    build_send(SendInputs { key: k, inputs: &sel.inputs, target: *to, amount, fee: sel.fee, output_slots: &slots, epoch_anchor: anchor, child_height: tip + 1 }).unwrap()
}

fn rejected(r: Result<String, RpcError>) -> String {
    match r {
        Err(RpcError::Remote { message, .. }) => message,
        other => panic!("expected a refusal, got {other:?}"),
    }
}

/// Re-encode a built intent with its pages edited and its proof bytes unchanged.
fn edited(plan: &SendPlan, edit: impl FnOnce(&mut Vec<TxBody>)) -> String {
    let intent = PagedSpendIntent::from_bytes(&plan.intent_bytes).unwrap();
    let mut bodies: Vec<TxBody> = intent.pages.iter().map(|p| p.body.clone()).collect();
    edit(&mut bodies);
    let pages: Vec<TxPage> = bodies.into_iter().map(|b| TxPage::new(b).unwrap()).collect();
    hex::encode(PagedSpendIntent::new(pages, intent.authorization_bytes.clone()).unwrap().to_bytes().unwrap())
}

const TIP: u64 = 299_300;

// ---------------------------------------------------------------- the builder, against the vendor's admission

#[test]
fn a_built_payment_is_admitted_by_the_vendor_checks_and_applied_by_the_vendor_transition() {
    let node = Node::new(TIP);
    let k = key(0x51);
    node.seed(5, &k.address(), 20_000_000);
    let supply_before = node.state().chain.circulating_supply_micronoid;
    let plan = pay(&node, &k, &target(), 5_000_000);
    assert_eq!(plan.fee, 9_000, "1 input, 2 outputs at low occupancy");
    assert_eq!(plan.change, 20_000_000 - 5_000_000 - 9_000);
    assert_eq!(node.submit_tx_intent(&plan.intent_hex()).unwrap(), plan.txid_hex());
    node.mine(1);
    assert_eq!(node.balance_of(&target()), 5_000_000);
    assert_eq!(node.balance_of(&k.address()), 20_000_000 - 5_000_000 - 9_000);
    assert_eq!(node.state().mined, vec![plan.txid]);
    // The fee left the supply (the vendor's own accounting): nothing else did.
    assert_eq!(node.state().chain.circulating_supply_micronoid, supply_before - 9_000u128);
}

#[test]
fn inputs_are_packed_eight_to_a_page_and_the_whole_group_is_one_transaction() {
    let node = Node::new(TIP);
    let k = key(0x52);
    for i in 0..20u32 {
        node.seed(i, &k.address(), 1_000_000);
    }
    // 19 of the 20 coins are needed
    let plan = pay(&node, &k, &target(), 18_900_000);
    let intent = PagedSpendIntent::from_bytes(&plan.intent_bytes).unwrap();
    assert_eq!(plan.inputs.len(), 19);
    assert_eq!(intent.pages.len(), 3, "ceil(19 / 8)");
    assert_eq!(intent.pages[0].body.fee, plan.fee);
    assert!(intent.pages[1..].iter().all(|p| p.body.fee == 0));
    assert_eq!(node.submit_tx_intent(&plan.intent_hex()).unwrap(), plan.txid_hex());
    node.mine(1);
    assert_eq!(node.balance_of(&target()), 18_900_000);
    assert_eq!(node.balance_of(&k.address()), 20_000_000 - 18_900_000 - plan.fee);
}

#[test]
fn a_tampered_output_amount_target_slot_fee_or_anchor_is_rejected() {
    let node = Node::new(TIP);
    let k = key(0x53);
    node.seed(5, &k.address(), 20_000_000);
    let plan = pay(&node, &k, &target(), 5_000_000);
    // The honest bytes would be admitted; every edit below keeps the shape valid and the proof as it was.
    type Edit = Box<dyn FnOnce(&mut Vec<TxBody>)>;
    let cases: Vec<(&str, Edit, &[&str])> = vec![
        ("amount moved from the change to the payment", Box::new(|b| {
            b[0].outputs[0].amount += 1;
            b[0].outputs[1].amount -= 1;
        }), &["invalid auth"]),
        ("target replaced", Box::new(|b| b[0].outputs[0].owner = Address([0xEE; 32])), &["invalid auth"]),
        ("change redirected", Box::new(|b| b[0].outputs[1].owner = Address([0xEE; 32])), &["invalid auth"]),
        ("payment slot moved", Box::new(|b| b[0].outputs[0].slot_index = (b[0].outputs[0].slot_index + 100) % 250 + 1), &["invalid auth", "SlotConflict", "malformed intent"]),
        ("fee raised, change lowered", Box::new(|b| {
            b[0].fee += 1_000;
            b[0].outputs[1].amount -= 1_000;
        }), &["invalid auth"]),
        ("anchor changed", Box::new(|b| b[0].epoch_anchor = anchor_id(1)), &["BadEpochAnchor"]),
    ];
    for (name, edit, expect) in cases {
        let msg = rejected(node.submit_tx_intent(&edited(&plan, edit)));
        assert!(expect.iter().any(|e| msg.contains(e)), "{name}: {msg}");
        assert_eq!(node.pool_len(), 0, "{name}");
    }
    // and the honest transaction still goes in
    assert_eq!(node.submit_tx_intent(&plan.intent_hex()).unwrap(), plan.txid_hex());
}

#[test]
fn a_proof_of_another_owner_a_wrong_version_and_a_low_fee_are_rejected() {
    let node = Node::new(TIP);
    let mine = key(0x55);
    let other = key(0x56);
    let cid = node.seed(5, &mine.address(), 20_000_000);
    let reads = NodeReads::new(&node);
    let anchor = reads.epoch_anchor().unwrap();
    let coin = WalletSlot { slot_index: 5, amount: 20_000_000, creation_id: cid };
    let slots = reads.output_slots(&mine.address(), 2).unwrap();
    // another wallet builds a payment of a coin it does not own: it builds (the builder cannot know), the node's exact slot comparison refuses it
    let theft = build_send(SendInputs { key: &other, inputs: &[coin], target: target(), amount: 5_000_000, fee: 9_000, output_slots: &slots, epoch_anchor: anchor, child_height: TIP + 1 }).unwrap();
    assert!(rejected(node.submit_tx_intent(&theft.intent_hex())).contains("BadStateRoot"));
    // a proof of the old owner-authorization version, at a height that takes the new one
    let old = build_send(SendInputs { key: &mine, inputs: &[coin], target: target(), amount: 5_000_000, fee: 9_000, output_slots: &slots, epoch_anchor: anchor, child_height: 279_000 }).unwrap();
    assert!(rejected(node.submit_tx_intent(&old.intent_hex())).contains("invalid auth"));
    // a fee below the minimum
    let cheap = build_send(SendInputs { key: &mine, inputs: &[coin], target: target(), amount: 5_000_000, fee: 8_999, output_slots: &slots, epoch_anchor: anchor, child_height: TIP + 1 }).unwrap();
    assert!(rejected(node.submit_tx_intent(&cheap.intent_hex())).contains("BelowMinFee"));
    // and the right one
    let good = build_send(SendInputs { key: &mine, inputs: &[coin], target: target(), amount: 5_000_000, fee: 9_000, output_slots: &slots, epoch_anchor: anchor, child_height: TIP + 1 }).unwrap();
    assert_eq!(node.submit_tx_intent(&good.intent_hex()).unwrap(), good.txid_hex());
}

#[test]
fn a_replay_is_refused_pending_and_after_inclusion() {
    let node = Node::new(TIP);
    let k = key(0x57);
    node.seed(5, &k.address(), 20_000_000);
    let plan = pay(&node, &k, &target(), 5_000_000);
    node.submit_tx_intent(&plan.intent_hex()).unwrap();
    assert!(rejected(node.submit_tx_intent(&plan.intent_hex())).contains("already admitted"));
    node.mine(1);
    assert!(rejected(node.submit_tx_intent(&plan.intent_hex())).contains("BadStateRoot"), "the coin is spent");
    assert_eq!(node.balance_of(&target()), 5_000_000, "the replay paid nothing more");
}

#[test]
fn the_fee_follows_the_chains_rule_at_every_occupancy_and_the_relay_floor() {
    let node = Node::new(TIP);
    let k = key(0x58);
    node.seed(5, &k.address(), 20_000_000);
    let reads = NodeReads::new(&node);
    assert_eq!(reads.fee_for(1, 1).unwrap(), 5_800);
    assert_eq!(reads.fee_for(1, 2).unwrap(), 9_000);
    // half the 256 slots are live: the state growth of a net-new slot costs double
    let stranger = key(0x59);
    for i in 10..140u32 {
        node.seed(i, &stranger.address(), 1_000);
    }
    assert_eq!(reads.fee_for(1, 2).unwrap(), 5_000 + 100 + 1_400 + 2 * 2_500);
    let plan = pay(&node, &k, &target(), 5_000_000);
    assert_eq!(plan.fee, 11_500);
    assert_eq!(node.submit_tx_intent(&plan.intent_hex()).unwrap(), plan.txid_hex());
    node.mine(1);
    // a relay floor above the consensus minimum is honoured too, up to the ceiling (4 x the consensus fee of the shape: 23,200 for 1 in, 1 out)
    node.set_floor(20_000);
    node.seed(200, &k.address(), 20_000_000);
    let plan = pay(&node, &k, &target(), 5_000_000);
    assert_eq!(plan.fee, 20_000);
    assert_eq!(node.submit_tx_intent(&plan.intent_hex()).unwrap(), plan.txid_hex());
    // a floor above the ceiling is refused, not paid
    node.set_floor(30_000);
    assert!(matches!(reads.fee_for(1, 1), Err(WalletError::Decode(m)) if m.contains("above the ceiling 23200")));
}

#[test]
fn a_pending_payment_does_not_survive_an_epoch_rotation_and_a_stale_anchor_is_refused() {
    let node = Node::new(299_340);
    let k = key(0x5A);
    node.seed(5, &k.address(), 20_000_000);
    let plan = pay(&node, &k, &target(), 5_000_000);
    node.submit_tx_intent(&plan.intent_hex()).unwrap();
    // the epoch anchored at 299,232 serves the children up to 299,376; the next child has another anchor
    node.set_tip(299_376);
    node.mine(1);
    assert_eq!(node.pool_len(), 0, "evicted at the rotation, never mined");
    assert!(node.state().mined.is_empty());
    assert_eq!(node.balance_of(&k.address()), 20_000_000, "the coin is still there");
    assert!(rejected(node.submit_tx_intent(&plan.intent_hex())).contains("BadEpochAnchor"));
}

#[test]
fn native_carriers_are_never_spent_and_a_mined_coin_is_plain() {
    let node = Node::new(TIP);
    let k = key(0x5B);
    node.seed_with_creation_id(1, &k.address(), 90_000_000, (1 << 62) | 5); // a token carrier
    node.seed_with_creation_id(2, &k.address(), 7_000_000, (1 << 63) | 123); // a coinbase coin
    let view = NodeReads::new(&node).slots_by_owner(&k.address()).unwrap();
    assert_eq!(view.carriers, 1);
    assert_eq!(view.plain_total(), Some(7_000_000));
    let plan = pay(&node, &k, &target(), 5_000_000);
    assert_eq!(plan.inputs.iter().map(|s| s.slot_index).collect::<Vec<_>>(), vec![2]);
    assert_eq!(node.submit_tx_intent(&plan.intent_hex()).unwrap(), plan.txid_hex());
    node.mine(1);
    assert_eq!(node.coins_of(&k.address()).iter().map(|c| c.1).collect::<Vec<_>>().len(), 2);
    // the carrier is the one the vendor admission would refuse: building a payment that names it is stopped by the builder itself
    let carrier = WalletSlot { slot_index: 1, amount: 90_000_000, creation_id: (1 << 62) | 5 };
    let r = build_send(SendInputs { key: &k, inputs: &[carrier], target: target(), amount: 1_000_000, fee: 9_000, output_slots: &[10, 11], epoch_anchor: [7; 32], child_height: TIP + 1 });
    assert!(matches!(r, Err(WalletError::Refused(_))));
}

#[test]
fn builder_refusals() {
    let k = key(0x5C);
    let coin = WalletSlot { slot_index: 5, amount: 20_000_000, creation_id: 3 };
    let ok = |inputs: &[WalletSlot], amount: u64, fee: u64, slots: &[u32], to: Address| {
        build_send(SendInputs { key: &k, inputs, target: to, amount, fee, output_slots: slots, epoch_anchor: [7; 32], child_height: TIP + 1 })
    };
    assert!(matches!(ok(&[], 1, 9_000, &[10], target()), Err(WalletError::Refused(_))), "no coin");
    assert!(matches!(ok(&[coin, coin], 1, 9_000, &[10, 11], target()), Err(WalletError::Refused(_))), "a coin twice");
    assert!(matches!(ok(&[coin], 0, 9_000, &[10, 11], target()), Err(WalletError::Refused(_))), "zero amount");
    assert!(matches!(ok(&[coin], 5, 0, &[10, 11], target()), Err(WalletError::Refused(_))), "zero fee");
    assert!(matches!(ok(&[coin], 5, 9_000, &[10, 11], k.address()), Err(WalletError::Refused(_))), "to itself");
    assert!(matches!(ok(&[coin], 5, 9_000, &[10], target()), Err(WalletError::Refused(_))), "change without a slot");
    assert!(matches!(ok(&[coin], 5, 9_000, &[10, 10], target()), Err(WalletError::Refused(_))), "the same output slot twice");
    assert!(matches!(ok(&[coin], 5, 9_000, &[5, 10], target()), Err(WalletError::Refused(_))), "an output slot that is an input slot");
    assert!(matches!(ok(&[coin], 20_000_000, 9_000, &[10], target()), Err(WalletError::Funds { .. })), "more than the coin");
    assert!(matches!(ok(&[coin], u64::MAX, 9_000, &[10], target()), Err(WalletError::Refused(_))), "overflow");
}

#[test]
fn nothing_in_a_plan_or_its_debug_text_shows_the_wallet_secret() {
    let node = Node::new(TIP);
    let k = key(0x5D);
    node.seed(5, &k.address(), 20_000_000);
    let plan = pay(&node, &k, &target(), 5_000_000);
    let text = format!("{plan:?} {k:?}");
    let secret_hex = hex::encode(k.master().bytes());
    let spend_hex = hex::encode(*k.spend_secret());
    assert!(!text.contains(&secret_hex) && !text.contains(&spend_hex));
    // and the wire bytes do not contain either secret (the proof is zero-knowledge; the page holds only the address)
    for needle in [k.master().bytes().as_slice(), k.spend_secret().as_slice()] {
        assert!(!plan.intent_bytes.windows(32).any(|w| w == needle));
    }
}
