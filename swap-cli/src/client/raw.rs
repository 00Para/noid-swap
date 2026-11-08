//! Client R (design section 7, option R): Bob's primary claim path.
//!
//! Plain words: once the secret is public on Ethereum, Bob must *close* the
//! NOID contract to himself before Alice's refund height `D`. On Parano1d a
//! close is authorized by a zero-knowledge proof that the sender knows the
//! secret behind the claim authority. This client builds that one-input,
//! one-output closing transaction exactly as the node's wallet does
//! (`vendor/parano1d/noid_node/src/wallet/mod.rs::build_object_call`,
//! `noid_rpc/src/server/objects.rs::prepare_call`), preflights it with the
//! same consensus check (`ObjectOpening::check_call`), proves it with
//! `noid_gkr`, verifies its own proof, and encodes an `ObjectIntent` for
//! `paranoid_submitTxIntent`. Submission goes through `IntentSubmitter`, which
//! this crate only ever implements as a mock.

use std::fmt;

use htlc_harness as h;
use noid_gkr::wallet_authorization::WalletAuthorizationBundle;
use noid_poseidon2b::primitives::Address;
use noid_tx::experimental_object::{ObjectIntent, ObjectOpening};
use noid_tx::{OwnerAuthorizationVersion, PagedSpendIntent, TxInput, TxPage};
use serde_json::Value;

use super::IntentSubmitter;
use crate::engine::{Action, ExecError, Executor};
use crate::params::{self, ClaimHeight, ContractVersion};
use crate::secret::{check_preimage_for, LockKind, PreimageError, Secret, Variant};
use crate::state::Event;
use crate::swapfile::{detect_contract_version, ClientRSelfTest, SwapFile, SwapPublic};
use crate::watch::{JsonRpc, NoidInstance, RpcError};

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ClaimError {
    /// The opening fails the M0.6 tool guard.
    Guard(String),
    /// `call_height >= deadline`: the claim branch is closed.
    BranchClosed { call_height: u64, deadline: u64 },
    /// Fee outside the allowed range: `[MIN_CLOSE_FEE, max_fee]` for contract v1; exactly `max_fee` for v2
    /// (then `min == max`).
    Fee { fee: u64, min: u64, max: u64 },
    /// The opening is neither `HashTimeLock` (v1) nor `HashTimeLockV2` (v2): the fee rule is unknown.
    UnknownContract,
    /// The secret is not the one behind `claim_authority`.
    Preimage(PreimageError),
    /// The built page does not pay the committed recipient (should be impossible).
    Recipient,
    Page(String),
    Prove(String),
    /// Our own proof did not verify: never submit it.
    SelfVerify(String),
    Encode(String),
    /// Every node refused the intent.
    AllNodesRejected(Vec<(String, String)>),
    Rpc(String),
}

impl fmt::Display for ClaimError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            ClaimError::Guard(e) => write!(f, "tool guard: {e}"),
            ClaimError::BranchClosed { call_height, deadline } => {
                write!(f, "claim branch closed: call height {call_height} >= deadline {deadline}")
            }
            ClaimError::Fee { fee, min, max } => {
                if min == max {
                    write!(f, "fee {fee} is not {max}: a v2 (fixed-fee) contract accepts only a close that pays exactly max_fee")
                } else {
                    write!(f, "fee {fee} outside [{min}, {max}]")
                }
            }
            ClaimError::UnknownContract => write!(f, "the opening is neither HashTimeLock (v1) nor HashTimeLockV2 (v2); refusing to guess its fee rule"),
            ClaimError::Preimage(e) => write!(f, "secret: {e}"),
            ClaimError::Recipient => write!(f, "built page does not pay the claim recipient"),
            ClaimError::Page(e) => write!(f, "page: {e}"),
            ClaimError::Prove(e) => write!(f, "prove: {e}"),
            ClaimError::SelfVerify(e) => write!(f, "self-verification failed: {e}"),
            ClaimError::Encode(e) => write!(f, "encode: {e}"),
            ClaimError::AllNodesRejected(v) => write!(f, "all {} node(s) rejected the intent: {v:?}", v.len()),
            ClaimError::Rpc(e) => write!(f, "rpc: {e}"),
        }
    }
}

impl std::error::Error for ClaimError {}

/// Everything needed to build one claim.
pub struct ClaimInputs<'a> {
    pub opening: &'a ObjectOpening,
    pub instance: &'a NoidInstance,
    /// An empty output slot (`paranoid_getSlotHints(1)`).
    pub output_slot: u32,
    pub fee_micronoid: u64,
    /// `paranoid_getEpochAnchor` for the child height.
    pub epoch_anchor: [u8; 32],
    /// `tip + 1`.
    pub call_height: u64,
    /// The Ethereum lock word (SHA-256 of the secret, or `Addr(s)` for the `poseidon` kind), to run the full step-11 check again.
    pub hashlock: [u8; 32],
    /// Which lock the word belongs to.
    pub lock_kind: LockKind,
    pub variant: Variant,
    /// The revealed secret.
    pub secret: &'a Secret,
}

/// A built, proved, self-verified claim ready for submission.
pub struct ClaimPlan {
    pub page: TxPage,
    pub call_height: u64,
    pub version: OwnerAuthorizationVersion,
    pub height_class: ClaimHeight,
    /// Logical transaction id (`hash_paged_spend`), what the node returns on submit.
    pub txid: [u8; 32],
    pub intent_bytes: Vec<u8>,
    pub fee_micronoid: u64,
    pub recipient: Address,
    pub amount_out: u64,
}

impl fmt::Debug for ClaimPlan {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("ClaimPlan")
            .field("txid", &self.txid_hex())
            .field("call_height", &self.call_height)
            .field("version", &self.version)
            .field("height_class", &self.height_class)
            .field("fee_micronoid", &self.fee_micronoid)
            .field("recipient", &self.recipient.to_bech32())
            .field("amount_out", &self.amount_out)
            .field("intent_bytes", &self.intent_bytes.len())
            .finish()
    }
}

impl ClaimPlan {
    pub fn txid_hex(&self) -> String {
        hex::encode(self.txid)
    }

    pub fn intent_hex(&self) -> String {
        hex::encode(&self.intent_bytes)
    }
}

/// Build, preflight, prove, self-verify and encode Bob's claim.
pub fn build_claim(inp: ClaimInputs<'_>) -> Result<ClaimPlan, ClaimError> {
    let opening = inp.opening;
    h::check_opening(opening).map_err(|e| ClaimError::Guard(e.to_string()))?;
    let height_class = params::classify_claim_height(inp.call_height, opening.deadline);
    if height_class == ClaimHeight::TooLate {
        return Err(ClaimError::BranchClosed { call_height: inp.call_height, deadline: opening.deadline });
    }
    // The fee rule depends on the contract: v1 accepts [MIN_CLOSE_FEE, max_fee], v2 exactly max_fee. The version is
    // read off the opening itself (rebuilt from its policy fields with each program and compared whole).
    let version = detect_contract_version(opening).ok_or(ClaimError::UnknownContract)?;
    let (min, max) = version.allowed_fee_range(opening.rules.max_fee);
    if inp.fee_micronoid < min || inp.fee_micronoid > max {
        return Err(ClaimError::Fee { fee: inp.fee_micronoid, min, max });
    }
    // Step 11 again, on the exact bytes we are about to use.
    check_preimage_for(inp.lock_kind, inp.secret.bytes(), &inp.hashlock, &opening.claim_authority, inp.variant)
        .map_err(ClaimError::Preimage)?;

    let input = TxInput {
        slot_index: inp.instance.slot_index,
        amount: inp.instance.amount_micronoid,
        creation_id: inp.instance.creation_id,
    };
    let page = opening
        .build_call(input, inp.output_slot, inp.fee_micronoid, inp.epoch_anchor, inp.call_height, true)
        .map_err(|e| ClaimError::Page(format!("{e:?}")))?;
    // The consensus preflight (what the mempool and the block circuit enforce).
    let checked = opening.check_call(&page, inp.call_height).map_err(|e| ClaimError::Page(format!("check_call: {e:?}")))?;
    let out = &page.body.outputs[0];
    if !checked.terminal || checked.authority != opening.claim_authority || out.owner != opening.claim_recipient {
        return Err(ClaimError::Recipient);
    }

    let version = params::auth_version_at(inp.call_height);
    let witness = inp.secret.witness_bytes(inp.variant);
    let bundle = h::prove_v(&page, opening, inp.call_height, *witness, version).map_err(|e| ClaimError::Prove(format!("{e:?}")))?;
    h::verify_v(&page, opening, inp.call_height, &bundle, version).map_err(|e| ClaimError::SelfVerify(format!("{e:?}")))?;

    let intent_bytes = encode_intent(opening, &page, &bundle)?;
    let txid = noid_tx::hash_paged_spend(std::slice::from_ref(&page))
        .map_err(|e| ClaimError::Encode(format!("txid: {e:?}")))?
        .0;
    Ok(ClaimPlan {
        amount_out: out.amount,
        recipient: out.owner,
        page,
        call_height: inp.call_height,
        version,
        height_class,
        txid,
        intent_bytes,
        fee_micronoid: inp.fee_micronoid,
    })
}

/// Review V2-10: does client R work on THIS machine, now? Builds a throwaway lock (a fresh random secret `s`, claim authority
/// `Addr(s)`, the harness cast as parties, a made-up 10 NOID instance), then builds, proves and self-verifies the claim exactly as
/// [`build_claim`] does for the real one, and re-verifies the encoded intent the way a node does (`verify_intent_bytes`). Nothing is
/// sent anywhere and no real secret is touched. `call_height` selects the owner-authorization version (the real tip + 1; the proof of
/// one version does not do for the other). With the `poseidon` lock only this client can claim, so Bob runs it before he locks ETH.
///
/// REVIEW-6 R6-4. The record is bound to what it vouches for: the swap file's lock word, the contract version of THIS swap (the throwaway is
/// compiled with that version's opening and fee rule, the swap's `max_fee`, and must be recognised as that contract exactly as the real
/// claim's opening is), the build string of this binary and the time. The submit path is run as far as it goes without a node: the claim is
/// built by the same `build_claim`, the intent is hex-encoded as `submit_claim` sends it, a mock node decodes it, re-verifies the proof and
/// answers its txid, and the answer must be the txid we computed.
pub fn client_r_selftest(call_height: u64, now: u64, public: &SwapPublic) -> Result<ClientRSelfTest, ClaimError> {
    let started = std::time::Instant::now();
    let version = public.params.contract_version;
    let max_fee = public.params.max_fee_micronoid;
    let secret = Secret::generate().map_err(|e| ClaimError::Guard(e.to_string()))?;
    let authority = secret.authority(Variant::Raw);
    let cast = h::Cast::new();
    let deadline = call_height.checked_add(1_000).ok_or_else(|| ClaimError::Guard("call height overflows".into()))?;
    let compiled = std::panic::catch_unwind(|| match version {
        ContractVersion::V1 => h::try_compile_htlc(authority, cast.bob, cast.alice, deadline, max_fee),
        ContractVersion::V2 => h::try_compile_htlc_v2(authority, cast.bob, cast.alice, deadline, max_fee),
    });
    let opening = match compiled {
        Ok(r) => r.map_err(|e| ClaimError::Guard(format!("{e:?}")))?,
        Err(_) => return Err(ClaimError::Guard("the contract compiler panicked on the self-test parameters".into())),
    };
    if detect_contract_version(&opening) != Some(version) {
        return Err(ClaimError::UnknownContract);
    }
    // The fee the real claim pays: exactly max_fee under v2, the floor (within [MIN, max_fee]) under v1.
    let (fee_min, fee_max) = version.allowed_fee_range(max_fee);
    let fee = params::F_MAX_FLOOR_MICRONOID.clamp(fee_min, fee_max);
    let instance = NoidInstance { slot_index: 11, creation_id: 3, amount_micronoid: 10_000_000 };
    let plan = build_claim(ClaimInputs {
        opening: &opening,
        instance: &instance,
        output_slot: 2,
        fee_micronoid: fee,
        epoch_anchor: [7; 32],
        call_height,
        hashlock: secret.lock_word(LockKind::Poseidon),
        lock_kind: LockKind::Poseidon,
        variant: Variant::Raw,
        secret: &secret,
    })?;
    // What a node does on `submitTxIntent`: decode, check, verify the proof, at the same height.
    let (decoded, txid) = verify_intent_bytes(&plan.intent_bytes, call_height)?;
    if txid != plan.txid || decoded.opening != opening {
        return Err(ClaimError::SelfVerify("the re-decoded intent has another transaction id or opening".into()));
    }
    // And through `submit_claim`, the function the real claim uses: hex on the wire, a node that verifies and answers the txid.
    let mock = MockSubmitter::new(MockAnswer::VerifyAt(call_height));
    let report = submit_claim(&plan, &[("self-test", &mock)])?;
    if report.accepted.len() != 1 || !report.rejected.is_empty() || !report.txid_hex.eq_ignore_ascii_case(&plan.txid_hex()) {
        return Err(ClaimError::SelfVerify("the mock node did not accept the self-test intent under its own txid".into()));
    }
    Ok(ClientRSelfTest {
        passed_at: now,
        auth_version: format!("{:?}", plan.version),
        call_height,
        proof_ms: u64::try_from(started.elapsed().as_millis()).unwrap_or(u64::MAX),
        lock_word: hex::encode(public.hashlock),
        contract_version: version.number(),
        build_id: crate::build_id(),
    })
}

/// `ObjectIntent { opening, spend: PagedSpendIntent { [page], proof bytes } }`,
/// the exact envelope `wallet/mod.rs::build_object_call` produces.
pub fn encode_intent(opening: &ObjectOpening, page: &TxPage, bundle: &WalletAuthorizationBundle) -> Result<Vec<u8>, ClaimError> {
    let auth = bundle.to_bytes().map_err(|e| ClaimError::Encode(format!("bundle: {e:?}")))?;
    let spend = PagedSpendIntent::new(vec![page.clone()], auth).map_err(|e| ClaimError::Encode(format!("spend: {e:?}")))?;
    ObjectIntent { opening: opening.clone(), spend }
        .to_bytes()
        .map_err(|e| ClaimError::Encode(format!("intent: {e:?}")))
}

/// Decode an intent the way the node will, and verify its proof (test and
/// diagnostic helper: what a node does on `submitTxIntent`).
pub fn verify_intent_bytes(bytes: &[u8], call_height: u64) -> Result<(ObjectIntent, [u8; 32]), ClaimError> {
    let intent = ObjectIntent::from_bytes(bytes).map_err(|e| ClaimError::Encode(format!("decode: {e:?}")))?;
    let page = intent.spend.pages.first().ok_or_else(|| ClaimError::Encode("no page".into()))?;
    let bundle = WalletAuthorizationBundle::from_bytes(&intent.spend.authorization_bytes)
        .map_err(|e| ClaimError::Encode(format!("bundle: {e:?}")))?;
    let version = params::auth_version_at(call_height);
    h::verify_v(page, &intent.opening, call_height, &bundle, version).map_err(|e| ClaimError::SelfVerify(format!("{e:?}")))?;
    let txid = noid_tx::hash_paged_spend(&intent.spend.pages)
        .map_err(|e| ClaimError::Encode(format!("txid: {e:?}")))?
        .0;
    Ok((intent, txid))
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SubmitReport {
    pub txid_hex: String,
    pub accepted: Vec<String>,
    pub rejected: Vec<(String, String)>,
}

/// Submit to every node (design: at least 3). A node that answers with a
/// different txid is counted as a rejection.
pub fn submit_claim(plan: &ClaimPlan, nodes: &[(&str, &dyn IntentSubmitter)]) -> Result<SubmitReport, ClaimError> {
    let want = plan.txid_hex();
    let intent_hex = plan.intent_hex();
    let mut accepted = Vec::new();
    let mut rejected = Vec::new();
    for (name, node) in nodes {
        match node.submit_tx_intent(&intent_hex) {
            Ok(txid) if txid.eq_ignore_ascii_case(&want) => accepted.push(name.to_string()),
            Ok(txid) => rejected.push((name.to_string(), format!("txid mismatch: node {txid}, ours {want}"))),
            Err(e) => rejected.push((name.to_string(), e.to_string())),
        }
    }
    if accepted.is_empty() {
        return Err(ClaimError::AllNodesRejected(rejected));
    }
    Ok(SubmitReport { txid_hex: want, accepted, rejected })
}

// ---------------------------------------------------------------- executor

/// The engine executor for Bob's `ClaimNoid` action: fetches the epoch anchor
/// and a slot hint from `rpc`, builds and proves the claim, and submits it to
/// `nodes`. Every other action is refused (the ETH side and the stock-wallet
/// steps are not this client's job).
pub struct RawClaimExecutor<R: JsonRpc> {
    pub rpc: R,
    pub nodes: Vec<(String, Box<dyn IntentSubmitter>)>,
    /// The last plan built, kept for inspection by tests and operators.
    pub last_plan: Option<ClaimPlan>,
    pub last_report: Option<SubmitReport>,
}

impl<R: JsonRpc> RawClaimExecutor<R> {
    pub fn new(rpc: R, nodes: Vec<(String, Box<dyn IntentSubmitter>)>) -> Self {
        Self { rpc, nodes, last_plan: None, last_report: None }
    }

    fn epoch_anchor(&self) -> Result<[u8; 32], ClaimError> {
        let v = self.rpc.call("paranoid_getEpochAnchor", Value::Array(vec![])).map_err(|e| ClaimError::Rpc(e.to_string()))?;
        let text = v.as_str().ok_or_else(|| ClaimError::Rpc("getEpochAnchor: expected hex string".into()))?;
        let bytes = hex::decode(text).map_err(|e| ClaimError::Rpc(format!("getEpochAnchor: {e}")))?;
        bytes.try_into().map_err(|_| ClaimError::Rpc("getEpochAnchor: not 32 bytes".into()))
    }

    fn slot_hint(&self) -> Result<u32, ClaimError> {
        let v = self.rpc.call("paranoid_getSlotHints", serde_json::json!([1])).map_err(|e| ClaimError::Rpc(e.to_string()))?;
        v.as_array()
            .and_then(|a| a.first())
            .and_then(Value::as_u64)
            .and_then(|s| u32::try_from(s).ok())
            .ok_or_else(|| ClaimError::Rpc("getSlotHints: expected [u32]".into()))
    }
}

/// True when a node's failure text proves the intent never left this machine:
/// the node answered with a rejection (no "transport" in the message) or the
/// connection could not even be opened (`transport: connect ...`). Anything else
/// (a timeout or reset after sending, an HTTP error) leaves the outcome unknown.
pub fn surely_not_delivered(message: &str) -> bool {
    !message.contains("transport") || message.contains("transport: connect")
}

impl<R: JsonRpc> RawClaimExecutor<R> {
    /// Everything `execute` does before submitting: read the epoch anchor and a
    /// slot hint, then build, preflight, prove and self-verify the claim. Used
    /// alone by the dry run (`swap-cli claim` without `--submit`). Nothing is sent.
    pub fn plan(&self, file: &SwapFile, action: &Action) -> Result<ClaimPlan, ExecError> {
        let (call_height, fee, preimage) = match action {
            Action::ClaimNoid { call_height, fee_micronoid, preimage } => (*call_height, *fee_micronoid, *preimage),
            other => return Err(ExecError::not_sent(format!("client R does not perform {}", other.kind()))),
        };
        let instance = match &file.phase {
            crate::state::Phase::Bob(p) => p.instance().cloned(),
            _ => None,
        }
        .ok_or_else(|| ExecError::not_sent("no funded instance recorded"))?;
        let opening = file.public.opening().map_err(|e| ExecError::not_sent(e.to_string()))?;
        // The opening in the file must be the contract the file says it is (the fee rule follows from it).
        if detect_contract_version(&opening) != Some(file.public.params.contract_version) {
            return Err(ExecError::not_sent(format!(
                "the swap file says contract v{} but its opening is not that contract; refusing to build a claim",
                file.public.params.contract_version
            )));
        }
        let secret = Secret::from_bytes(preimage);
        build_claim(ClaimInputs {
            opening: &opening,
            instance: &instance,
            output_slot: self.slot_hint().map_err(|e| ExecError::not_sent(e.to_string()))?,
            fee_micronoid: fee,
            epoch_anchor: self.epoch_anchor().map_err(|e| ExecError::not_sent(e.to_string()))?,
            call_height,
            hashlock: file.public.hashlock,
            lock_kind: file.public.params.eth.lock_kind,
            variant: file.public.params.variant,
            secret: &secret,
        })
        .map_err(|e| ExecError::not_sent(e.to_string()))
    }
}

impl<R: JsonRpc> Executor for RawClaimExecutor<R> {
    fn execute(&mut self, file: &SwapFile, action: &Action, _now: u64) -> Result<Option<Event>, ExecError> {
        let call_height = match action {
            Action::ClaimNoid { call_height, .. } => *call_height,
            other => return Err(ExecError::not_sent(format!("client R does not perform {}", other.kind()))),
        };
        let plan = self.plan(file, action)?;
        let refs: Vec<(&str, &dyn IntentSubmitter)> = self.nodes.iter().map(|(n, s)| (n.as_str(), s.as_ref())).collect();
        let report = submit_claim(&plan, &refs).map_err(|e| match e {
            // Every node answered with a rejection (or never connected): nothing is pending anywhere.
            ClaimError::AllNodesRejected(ref r) if r.iter().all(|(_, m)| surely_not_delivered(m)) => ExecError::not_sent(e.to_string()),
            other => ExecError::unknown(other.to_string()),
        })?;
        let txid = report.txid_hex.clone();
        self.last_plan = Some(plan);
        self.last_report = Some(report);
        Ok(Some(Event::ClaimSubmitted { txid, call_height }))
    }
}

/// A submitter that records every intent and answers with a scripted result:
/// the mock used by every test in this crate.
pub struct MockSubmitter {
    pub received: std::sync::Mutex<Vec<String>>,
    pub answer: MockAnswer,
}

#[derive(Clone, Debug)]
pub enum MockAnswer {
    /// Decode the intent, verify it at this height, and answer its real txid.
    VerifyAt(u64),
    /// Answer this txid without looking.
    Txid(String),
    /// Refuse with this message (e.g. `SlotConflict`).
    Reject(String),
}

impl MockSubmitter {
    pub fn new(answer: MockAnswer) -> Self {
        Self { received: std::sync::Mutex::new(Vec::new()), answer }
    }
}

impl IntentSubmitter for MockSubmitter {
    fn submit_tx_intent(&self, intent_hex: &str) -> Result<String, RpcError> {
        self.received.lock().unwrap().push(intent_hex.to_string());
        match &self.answer {
            MockAnswer::VerifyAt(h) => {
                let bytes = hex::decode(intent_hex).map_err(|e| RpcError::Remote { code: -32000, message: e.to_string() })?;
                let (_, txid) = verify_intent_bytes(&bytes, *h).map_err(|e| RpcError::Remote { code: -32000, message: e.to_string() })?;
                Ok(hex::encode(txid))
            }
            MockAnswer::Txid(t) => Ok(t.clone()),
            MockAnswer::Reject(m) => Err(RpcError::Remote { code: -32000, message: m.clone() }),
        }
    }
}
