//! The record of a built transaction, and the rules for sending it again.
//!
//! Plain words. A transaction that spends the wallet's coins is a few kilobytes of bytes with a proof inside. If the program dies after sending
//! it, or the connection drops with no answer, nobody knows whether it went. The one dangerous mistake is to build a SECOND transaction for the
//! same purpose (a second funding of the contract): the first may still land, and then the contract holds twice the amount. So every send
//! writes its full bytes, its id, its anchor and the list of coins it spends to a file beside the swap file BEFORE it is submitted (a temporary
//! file, `fsync`, a rename, a sync of the directory, the way the swap file is saved). From then on:
//!
//! - **Sending again is safe.** The same bytes have the same id; a node that has them says "already admitted", a node that does not takes them.
//!   A transaction carries an epoch anchor `a` and is valid only in the 144 blocks `a+1 ..= a+144`; sent again inside that window it can only
//!   ever land once (amendment B).
//! - **Building again spends exactly the same coins, or does not happen.** After the window has passed and every recorded coin is still unspent
//!   the first transaction can no longer land, and a new one on the same coins is safe: at most one of the two can ever be in a block.
//!   If ANY recorded coin is gone the first transaction may have landed: nothing is built, and nothing is judged, until the chain is final for
//!   everything the first transaction could have done (`tip >= a + 144 + 18`); then only the contract's own coins at its address decide.
//! - **Sending stops** once the last funding height has passed or the swap file is aborted.
//!
//! The decision is a pure function of the record and what the node shows ([`next_step`]), so every branch is tested without a node.

use noid_tx::experimental_object::ObjectIntent;
use noid_tx::PagedSpendIntent;
use serde::{Deserialize, Serialize};

use super::chain::WalletSlot;
use super::contract::RecoveryPlan;
use super::send::SendPlan;
use super::WalletError;
use crate::client::IntentSubmitter;
use crate::params;
use crate::swapfile::atomic_write;
use crate::watch::{hexbytes, NoidInstance, RpcError};

pub const RECORD_VERSION: u32 = 1;

/// What the recorded transaction is for. One record file per kind and swap.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SendKind {
    /// The funding: a plain payment of exactly the swap's amount to the contract's address.
    Fund,
    /// The recovery close after the deadline.
    Recover,
    /// The sweep of what is left to the payout address.
    Sweep,
}

impl SendKind {
    pub fn name(self) -> &'static str {
        match self {
            SendKind::Fund => "fund",
            SendKind::Recover => "recover",
            SendKind::Sweep => "sweep",
        }
    }
}

/// `<swap file>.wallet-<kind>.json`
pub fn record_path(swap_file: &std::path::Path, kind: SendKind) -> std::path::PathBuf {
    let mut s = swap_file.as_os_str().to_os_string();
    s.push(format!(".wallet-{}.json", kind.name()));
    std::path::PathBuf::from(s)
}

/// The persisted transaction. It holds no secret.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct SendRecord {
    pub version: u32,
    pub kind: SendKind,
    /// `SwapPublic::digest()` of the swap file it was made for: a record cannot be used for another swap.
    #[serde(with = "hexbytes")]
    pub swap_digest: [u8; 32],
    pub created_at: u64,
    /// The logical transaction id, hex.
    pub txid: String,
    /// The wire bytes: a `PagedSpendIntent` (fund, sweep) or an `ObjectIntent` (recover), hex.
    pub intent_hex: String,
    #[serde(with = "hexbytes")]
    pub epoch_anchor: [u8; 32],
    /// The height of the anchor's block: the transaction is valid in the blocks `anchor_height + 1 ..= anchor_height + 144`.
    pub anchor_height: u64,
    /// The height it was built for.
    pub child_height: u64,
    /// The coins it spends (for a recovery: the contract's instance).
    pub inputs: Vec<WalletSlot>,
    /// Where the payment goes (bech32) and how much.
    pub target: String,
    pub amount: u64,
    pub fee: u64,
}

impl SendRecord {
    pub fn from_send(kind: SendKind, swap_digest: [u8; 32], plan: &SendPlan, target: &str, now: u64) -> Self {
        Self {
            version: RECORD_VERSION,
            kind,
            swap_digest,
            created_at: now,
            txid: plan.txid_hex(),
            intent_hex: plan.intent_hex(),
            epoch_anchor: plan.epoch_anchor,
            anchor_height: params::epoch_anchor_height_for_child(plan.child_height),
            child_height: plan.child_height,
            inputs: plan.inputs.clone(),
            target: target.to_string(),
            amount: plan.amount,
            fee: plan.fee,
        }
    }

    pub fn from_recovery(swap_digest: [u8; 32], plan: &RecoveryPlan, now: u64) -> Self {
        Self {
            version: RECORD_VERSION,
            kind: SendKind::Recover,
            swap_digest,
            created_at: now,
            txid: plan.txid_hex(),
            intent_hex: plan.intent_hex(),
            epoch_anchor: plan.epoch_anchor,
            anchor_height: params::epoch_anchor_height_for_child(plan.call_height),
            child_height: plan.call_height,
            inputs: vec![WalletSlot { slot_index: plan.instance.slot_index, amount: plan.instance.amount_micronoid, creation_id: plan.instance.creation_id }],
            target: plan.recipient.to_bech32(),
            amount: plan.amount_out,
            fee: plan.fee,
        }
    }

    /// The last height a block can include this transaction at: `anchor_height + 144`.
    pub fn last_valid_height(&self) -> u64 {
        self.anchor_height.saturating_add(params::B_EPOCH)
    }

    /// The tip from which everything the transaction could have done is final: `anchor_height + 144 + 18`.
    pub fn final_after_tip(&self) -> u64 {
        self.last_valid_height().saturating_add(params::NOID_FINALITY_DEPTH)
    }

    /// The wire bytes.
    pub fn intent_bytes(&self) -> Result<Vec<u8>, WalletError> {
        hex::decode(&self.intent_hex).map_err(|e| WalletError::Persist(format!("intent_hex: {e}")))
    }

    /// Check the record is what it says: version, the bytes decode, the id is the bytes' id, the anchor and the coins are the bytes' own, the
    /// anchor's height is the anchor of the height it was built for.
    pub fn check(&self, swap_digest: &[u8; 32]) -> Result<(), WalletError> {
        let bad = |m: &str| WalletError::Persist(m.to_string());
        if self.version != RECORD_VERSION {
            return Err(WalletError::Persist(format!("unsupported record version {}", self.version)));
        }
        if &self.swap_digest != swap_digest {
            return Err(bad("this record was made for another swap file"));
        }
        let bytes = self.intent_bytes()?;
        let pages = match self.kind {
            SendKind::Fund | SendKind::Sweep => PagedSpendIntent::from_bytes(&bytes).map_err(|e| WalletError::Persist(format!("the recorded bytes do not decode: {e:?}")))?.pages,
            SendKind::Recover => ObjectIntent::from_bytes(&bytes).map_err(|e| WalletError::Persist(format!("the recorded bytes do not decode: {e:?}")))?.spend.pages,
        };
        let txid = noid_tx::hash_paged_spend(&pages).map_err(|e| WalletError::Persist(format!("txid: {e:?}")))?;
        if hex::encode(txid.0) != self.txid.to_ascii_lowercase() {
            return Err(bad("the recorded transaction id is not the id of the recorded bytes"));
        }
        let mut coins = Vec::new();
        for page in &pages {
            if page.body.epoch_anchor != self.epoch_anchor {
                return Err(bad("the recorded anchor is not the anchor inside the recorded bytes"));
            }
            for (_, i) in page.body.live_inputs() {
                coins.push(WalletSlot { slot_index: i.slot_index, amount: i.amount, creation_id: i.creation_id });
            }
        }
        let mut recorded = self.inputs.clone();
        recorded.sort_by_key(|s| s.slot_index);
        coins.sort_by_key(|s| s.slot_index);
        if recorded != coins {
            return Err(bad("the recorded coins are not the coins inside the recorded bytes"));
        }
        if self.anchor_height != params::epoch_anchor_height_for_child(self.child_height) {
            return Err(bad("the recorded anchor height does not belong to the height it was built for"));
        }
        Ok(())
    }

    /// Write the record (temporary file, `fsync`, rename, directory sync). It is the step BEFORE the submit: if this fails, nothing is sent.
    pub fn save(&self, path: &std::path::Path) -> Result<(), WalletError> {
        let text = serde_json::to_vec_pretty(self).map_err(|e| WalletError::Persist(e.to_string()))?;
        atomic_write(path, &text).map_err(|e| WalletError::Persist(e.to_string()))
    }

    /// Read a record, if there is one, and check it against `swap_digest`.
    pub fn load(path: &std::path::Path, swap_digest: &[u8; 32]) -> Result<Option<Self>, WalletError> {
        let bytes = match std::fs::read(path) {
            Ok(b) => b,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(e) => return Err(WalletError::Persist(format!("{}: {e}", path.display()))),
        };
        let rec: SendRecord = serde_json::from_slice(&bytes).map_err(|e| WalletError::Persist(format!("{}: {e}", path.display())))?;
        rec.check(swap_digest)?;
        Ok(Some(rec))
    }
}

/// What to do with a recorded transaction, given what the node shows now.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Next {
    /// Send these exact bytes again: every recorded coin is still unspent and the anchor is still current.
    Resend,
    /// The anchor has rotated and every recorded coin is still unspent: the first transaction can no longer land, and a new one that spends exactly
    /// these coins is safe.
    Rebuild,
    /// A recorded coin is gone: the transaction may have landed. Nothing is built; wait until the tip reaches `until_tip` (`a + 144 + 18`).
    Wait { until_tip: u64 },
    /// A recorded coin is gone and the chain is final for everything the transaction could have done: only the contract's own coins decide.
    Judge,
    /// Sending is over (the last funding height has passed, or the swap file is aborted): `reason`.
    Stop { reason: String },
}

/// The decision. `inputs_unspent` is whether EVERY recorded coin is still unspent now (the wallet's plain coins, or for a recovery the contract's
/// instance); `stop` is why no new send may be made (an aborted file, a last funding height passed), if so.
pub fn next_step(rec: &SendRecord, tip: u64, inputs_unspent: bool, stop: Option<String>) -> Next {
    if inputs_unspent {
        if let Some(reason) = stop {
            return Next::Stop { reason };
        }
        // The next child block is `tip + 1`; the anchor serves children up to `a + 144`.
        return if tip.saturating_add(1) <= rec.last_valid_height() { Next::Resend } else { Next::Rebuild };
    }
    let until = rec.final_after_tip();
    if tip < until {
        Next::Wait { until_tip: until }
    } else {
        Next::Judge
    }
}

/// Are all of the record's coins in `current`? (`current` = the wallet's plain coins from `getSlotsByOwner`.) Compares slot, amount and incarnation.
pub fn all_unspent(rec: &SendRecord, current: &[WalletSlot]) -> bool {
    rec.inputs.iter().all(|i| current.contains(i))
}

/// For a recovery record: is the recorded instance still at the contract?
pub fn instance_unspent(rec: &SendRecord, at_root: &[NoidInstance]) -> bool {
    rec.inputs.iter().all(|i| at_root.iter().any(|r| r.slot_index == i.slot_index && r.creation_id == i.creation_id && r.amount_micronoid == i.amount))
}

// ---------------------------------------------------------------- submitting

/// What happened to a submit, node by node.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SubmitReport {
    pub txid_hex: String,
    /// Nodes that took the transaction and answered its id.
    pub accepted: Vec<String>,
    /// Nodes that already had it ("already admitted"): the same bytes sent again, which is the point.
    pub already_pending: Vec<String>,
    /// Nodes that answered with a refusal (the node looked at it and said no).
    pub rejected: Vec<(String, String)>,
    /// Nodes whose answer is unknown: a timeout or a broken connection after the bytes may have left, or an answer that could not be read.
    pub unknown: Vec<(String, String)>,
}

/// The verdict of a submit.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum SubmitVerdict {
    /// At least one node holds the transaction.
    Sent,
    /// No node took it and at least one answer is unknown: the transaction MAY HAVE BEEN SENT. It must be treated as sent.
    MaybeSent,
    /// Every node answered with a refusal or could not be reached before anything was sent: the transaction was NOT sent.
    NotSent,
}

impl SubmitReport {
    pub fn verdict(&self) -> SubmitVerdict {
        if !self.accepted.is_empty() || !self.already_pending.is_empty() {
            SubmitVerdict::Sent
        } else if !self.unknown.is_empty() {
            SubmitVerdict::MaybeSent
        } else {
            SubmitVerdict::NotSent
        }
    }

    /// One line for a person; says "may have been sent" whenever that is possible.
    pub fn describe(&self) -> String {
        match self.verdict() {
            SubmitVerdict::Sent => format!("sent: transaction {} is held by {} node(s)", self.txid_hex, self.accepted.len() + self.already_pending.len()),
            SubmitVerdict::MaybeSent => format!(
                "the transaction {} MAY HAVE BEEN SENT: {} node(s) gave no usable answer ({}); treat it as sent, do not build another, and run this command again to send the same bytes",
                self.txid_hex,
                self.unknown.len(),
                self.unknown.iter().map(|(n, m)| format!("{n}: {m}")).collect::<Vec<_>>().join("; ")
            ),
            SubmitVerdict::NotSent => format!(
                "the transaction {} was NOT sent: {}",
                self.txid_hex,
                self.rejected.iter().map(|(n, m)| format!("{n}: {m}")).collect::<Vec<_>>().join("; ")
            ),
        }
    }
}

/// A transport failure that proves nothing left this machine: the connection could not be opened, or the address was unusable.
fn surely_not_sent(e: &RpcError) -> bool {
    match e {
        RpcError::Transport(m) => m.starts_with("connect") || m.starts_with("unsupported url"),
        RpcError::Remote { .. } | RpcError::Fixture(_) => true,
        RpcError::Decode(_) => false,
    }
}

/// Submit `intent_hex` to every node. Never panics; a failure never hides a possible send.
pub fn submit_bytes(txid_hex: &str, intent_hex: &str, nodes: &[(&str, &dyn IntentSubmitter)]) -> SubmitReport {
    let mut report = SubmitReport { txid_hex: txid_hex.to_string(), accepted: Vec::new(), already_pending: Vec::new(), rejected: Vec::new(), unknown: Vec::new() };
    for (name, node) in nodes {
        match node.submit_tx_intent(intent_hex) {
            Ok(id) if id.trim().trim_start_matches("0x").eq_ignore_ascii_case(txid_hex) => report.accepted.push(name.to_string()),
            // A node that answers with another id has taken something: whatever it is, it is not ours, but it may be in its pool.
            Ok(id) => report.unknown.push((name.to_string(), format!("answered the transaction id {id}, ours is {txid_hex}"))),
            Err(RpcError::Remote { message, .. }) if message.to_ascii_lowercase().contains("already admitted") => report.already_pending.push(name.to_string()),
            Err(e) if surely_not_sent(&e) => report.rejected.push((name.to_string(), e.to_string())),
            Err(e) => report.unknown.push((name.to_string(), e.to_string())),
        }
    }
    report
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rec(anchor_height: u64) -> SendRecord {
        SendRecord {
            version: RECORD_VERSION,
            kind: SendKind::Fund,
            swap_digest: [1; 32],
            created_at: 5,
            txid: "00".repeat(32),
            intent_hex: String::new(),
            epoch_anchor: [7; 32],
            anchor_height,
            child_height: anchor_height + 10,
            inputs: vec![WalletSlot { slot_index: 4, amount: 9, creation_id: 3 }],
            target: "o1x".into(),
            amount: 1,
            fee: 1,
        }
    }

    #[test]
    fn inside_the_window_with_every_coin_unspent_the_same_bytes_are_sent_again() {
        let r = rec(1_000); // valid for children 1,001 ..= 1,144
        assert_eq!(next_step(&r, 1_010, true, None), Next::Resend);
        assert_eq!(next_step(&r, 1_143, true, None), Next::Resend, "child 1,144 is the last one");
        assert_eq!(next_step(&r, 1_144, true, None), Next::Rebuild, "child 1,145 has another anchor");
        assert_eq!(next_step(&r, 5_000, true, None), Next::Rebuild);
    }

    #[test]
    fn a_missing_coin_never_allows_a_rebuild_and_waits_for_a_plus_144_plus_18() {
        let r = rec(1_000);
        assert_eq!(r.final_after_tip(), 1_162);
        assert_eq!(next_step(&r, 1_020, false, None), Next::Wait { until_tip: 1_162 });
        assert_eq!(next_step(&r, 1_161, false, None), Next::Wait { until_tip: 1_162 });
        assert_eq!(next_step(&r, 1_162, false, None), Next::Judge);
        assert_eq!(next_step(&r, 9_999, false, None), Next::Judge);
    }

    #[test]
    fn a_stop_blocks_every_send_but_not_the_wait_and_the_judgement() {
        let r = rec(1_000);
        assert_eq!(next_step(&r, 1_010, true, Some("aborted".into())), Next::Stop { reason: "aborted".into() });
        assert_eq!(next_step(&r, 1_500, true, Some("last funding height passed".into())), Next::Stop { reason: "last funding height passed".into() });
        assert_eq!(next_step(&r, 1_010, false, Some("aborted".into())), Next::Wait { until_tip: 1_162 });
        assert_eq!(next_step(&r, 2_000, false, Some("aborted".into())), Next::Judge);
    }

    #[test]
    fn unspent_is_judged_by_slot_amount_and_incarnation() {
        let r = rec(0);
        let coin = WalletSlot { slot_index: 4, amount: 9, creation_id: 3 };
        assert!(all_unspent(&r, &[coin]));
        assert!(!all_unspent(&r, &[]));
        assert!(!all_unspent(&r, &[WalletSlot { creation_id: 4, ..coin }]), "the slot was spent and used again");
        assert!(!all_unspent(&r, &[WalletSlot { amount: 8, ..coin }]));
        let inst = NoidInstance { slot_index: 4, creation_id: 3, amount_micronoid: 9 };
        assert!(instance_unspent(&r, &[inst.clone()]));
        assert!(!instance_unspent(&r, &[NoidInstance { creation_id: 9, ..inst }]));
    }

    struct Node(Result<String, RpcError>);
    impl IntentSubmitter for Node {
        fn submit_tx_intent(&self, _hex: &str) -> Result<String, RpcError> {
            self.0.clone()
        }
    }

    fn verdict(answers: Vec<Result<String, RpcError>>) -> SubmitReport {
        let nodes: Vec<(String, Node)> = answers.into_iter().enumerate().map(|(i, a)| (format!("n{i}"), Node(a))).collect();
        let refs: Vec<(&str, &dyn IntentSubmitter)> = nodes.iter().map(|(n, s)| (n.as_str(), s as &dyn IntentSubmitter)).collect();
        submit_bytes(&"ab".repeat(32), "00", &refs)
    }

    #[test]
    fn a_submit_is_sent_not_sent_or_maybe_sent_and_never_confuses_the_last_two() {
        let id = "ab".repeat(32);
        let remote = |m: &str| Err(RpcError::Remote { code: -32000, message: m.into() });
        assert_eq!(verdict(vec![Ok(id.clone())]).verdict(), SubmitVerdict::Sent);
        assert_eq!(verdict(vec![remote("already admitted: TxBodyHash(..)")]).verdict(), SubmitVerdict::Sent);
        assert_eq!(verdict(vec![remote("consensus: BadEpochAnchor")]).verdict(), SubmitVerdict::NotSent);
        assert_eq!(verdict(vec![Err(RpcError::Transport("connect 127.0.0.1:1: refused".into()))]).verdict(), SubmitVerdict::NotSent);
        // a timeout after the bytes were written: it may have been sent
        let timeout = Err(RpcError::Transport("timed out waiting for the reply".into()));
        assert_eq!(verdict(vec![timeout.clone()]).verdict(), SubmitVerdict::MaybeSent);
        assert_eq!(verdict(vec![Err(RpcError::Decode("junk".into()))]).verdict(), SubmitVerdict::MaybeSent);
        // another id answered: not ours, and unknown
        assert_eq!(verdict(vec![Ok("cd".repeat(32))]).verdict(), SubmitVerdict::MaybeSent);
        // one node refused, one timed out: still maybe sent; one node took it: sent
        assert_eq!(verdict(vec![remote("full"), timeout.clone()]).verdict(), SubmitVerdict::MaybeSent);
        assert_eq!(verdict(vec![timeout, Ok(id)]).verdict(), SubmitVerdict::Sent);
        let text = verdict(vec![Err(RpcError::Transport("timed out waiting for the reply".into()))]).describe();
        assert!(text.contains("MAY HAVE BEEN SENT") && !text.contains("NOT sent"));
    }

    #[test]
    fn a_record_path_sits_beside_the_swap_file_by_kind() {
        let p = std::path::Path::new("/x/a.swap.json");
        assert_eq!(record_path(p, SendKind::Fund).to_str().unwrap(), "/x/a.swap.json.wallet-fund.json");
        assert_eq!(record_path(p, SendKind::Recover).to_str().unwrap(), "/x/a.swap.json.wallet-recover.json");
        assert_eq!(record_path(p, SendKind::Sweep).to_str().unwrap(), "/x/a.swap.json.wallet-sweep.json");
    }
}
