//! Ethereum JSON-RPC watcher (M2.4): polls a node and reduces the answers to one
//! [`EthObservation`] about OUR lock in `HTLC.sol`.
//!
//! Plain words. A *log* is a record a contract writes when something happens
//! (`Locked`, `Claimed`, `Refunded`); the node stores logs by block and lets you search them.
//! A log has *topics* (searchable 32-byte words: first the event signature hash, then the
//! `indexed` arguments, left-padded) and *data* (the other arguments, one 32-byte word each).
//! A *pending* transaction is one a node has received but not yet put in a block. Its
//! *calldata* (`input`: 4-byte selector + arguments) is public, and `claim(lockId, preimage)`
//! carries the secret as a plain argument. So the secret is visible in the mempool before the
//! claim is mined; that is why the watcher reads pending calldata.
//!
//! JSON-RPC methods used by [`EthWatcher::observe`], in this order:
//! `eth_blockNumber`; `eth_getBlockByNumber ["latest", false]`;
//! `eth_getBlockByNumber ["finalized", false]` (a node error means `finalized_block = None`);
//! `eth_chainId` (mandatory: a node that cannot answer fails the poll); `eth_getCode` for the contract, ALWAYS and
//! right after the chain id (its keccak256 is `contract_code_hash`, read before any lock exists);
//! with a discovery rule, ONE `eth_getLogs` for every `Locked` event of the agreed parties and hashlock (REVIEW-2 F10:
//! all of them, also when the lock id is already pinned; both lock kinds, through the INDEXED sender and receiver topics, REVIEW-6 R6-1);
//! then, for the pinned lock first and each other match after
//! it (up to [`MAX_LOCKS_READ`]): ONE `eth_getLogs` (address = contract, topic0 in {Locked, Claimed, Refunded},
//! topic1 = that lockId), `eth_call getLock(lockId)` at `"latest"` (cross-checked with the `Locked` event, or expected
//! to revert `LockNotFound` when no event exists), then `eth_getCode` for the lock's sender and receiver and
//! `eth_getBlockByNumber` for the block that mined it; `eth_getTransactionByHash` for each pending tx hash
//! the caller supplied; with `--reveal-tx` (REVIEW-6 R6-3) `eth_getTransactionByHash`, `eth_getTransactionReceipt` for that one hash and
//! `eth_getBlockByNumber` for its block, whose hash must equal the receipt's (REVIEW-7 R7-5: the canonical chain) (a note, never an error); only when the caller asked for the `poseidon` word scan (REVIEW-6 R6-1: Bob before his lock), ONE
//! `eth_getLogs` for the `Locked` logs of Bob's own sender (topics `[Locked, null, sender]`; REVIEW-7 R7-1; in block-range chunks when the
//! node limits the range), compared with the lock word locally (its failure is [`WordScan::Failed`], never an error of the poll);
//! and, only when the caller named a signer (REVIEW-3 F3), `eth_getTransactionCount`
//! at `"latest"` and `"pending"` for it, last of all, with any failure read as "unknown". Logs and `getLock` are read at different instants, so a claim mined
//! between them shows up as a `Decode` "inconsistent" error; the next poll resolves it.

use serde_json::{json, Value};
use sha2::Sha256;
use sha3::{Digest as _, Keccak256};

use super::{EthClaimed, EthLock, EthObservation, EthRefunded, JsonRpc, PendingPreimage, RevertedClaim, RpcError, WordLock, WordScan};
use crate::secret::{LockKind, Secret};

/// `keccak256(data)`: Ethereum's native hash (NOT the hashlock hash, which is SHA-256).
pub fn keccak256(data: &[u8]) -> [u8; 32] {
    let mut h = Keccak256::new();
    h.update(data);
    h.finalize().into()
}

/// `lockId = keccak256(abi.encodePacked(sender, receiver, amount, hashlock, timelock))`
/// (`eth/contracts/HTLC.sol::computeLockId`): 20 + 20 + 32 + 32 + 32 bytes.
pub fn compute_lock_id(
    sender: &[u8; 20],
    receiver: &[u8; 20],
    amount_wei: u128,
    hashlock: &[u8; 32],
    timelock: u64,
) -> [u8; 32] {
    let mut packed = Vec::with_capacity(136);
    packed.extend_from_slice(sender);
    packed.extend_from_slice(receiver);
    packed.extend_from_slice(&[0u8; 16]);
    packed.extend_from_slice(&amount_wei.to_be_bytes());
    packed.extend_from_slice(hashlock);
    packed.extend_from_slice(&[0u8; 24]);
    packed.extend_from_slice(&timelock.to_be_bytes());
    keccak256(&packed)
}

/// Event topics and function selectors of `HTLC.sol` (keccak256 of the signatures,
/// cross-checked with ethers `id()` on 2026-11-04).
pub const TOPIC_LOCKED: [u8; 32] = hex_literal(
    "578af4d125bb96ec89cd1ade591cb196f35d15047d5b096c478e45e311d84263",
);
pub const TOPIC_CLAIMED: [u8; 32] = hex_literal(
    "38d6042dbdae8e73a7f6afbabd3fbe0873f9f5ed3cd71294591c3908c2e65fee",
);
pub const TOPIC_REFUNDED: [u8; 32] = hex_literal(
    "fe509803c09416b28ff3d8f690c8b0c61462a892c46d5430c8fb20abe472daf0",
);
/// `claim(bytes32,bytes32)`.
pub const SELECTOR_CLAIM: [u8; 4] = [0x84, 0xcc, 0x9d, 0xfb];
/// `refund(bytes32)`.
pub const SELECTOR_REFUND: [u8; 4] = [0x72, 0x49, 0xfb, 0xb6];
/// `newLock(bytes32,uint256,address)`.
pub const SELECTOR_NEW_LOCK: [u8; 4] = [0x5f, 0xa3, 0xd0, 0x50];
/// `getLock(bytes32)`.
pub const SELECTOR_GET_LOCK: [u8; 4] = [0xd6, 0xf2, 0x7b, 0x58];

const fn hex_literal(s: &str) -> [u8; 32] {
    let b = s.as_bytes();
    let mut out = [0u8; 32];
    let mut i = 0;
    while i < 32 {
        out[i] = (nibble(b[2 * i]) << 4) | nibble(b[2 * i + 1]);
        i += 1;
    }
    out
}

const fn nibble(c: u8) -> u8 {
    match c {
        b'0'..=b'9' => c - b'0',
        b'a'..=b'f' => c - b'a' + 10,
        b'A'..=b'F' => c - b'A' + 10,
        _ => panic!("bad hex digit"),
    }
}

/// How Alice finds Bob's lock before she knows its id: the `Locked` event of
/// our contract whose indexed `sender`/`receiver` are the agreed parties and
/// whose `hashlock` is ours (the id is then recomputed from the terms).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LockDiscovery {
    pub sender: [u8; 20],
    pub receiver: [u8; 20],
    pub hashlock: [u8; 32],
}

/// The word an Ethereum lock of kind `kind` is keyed on for a given preimage: `SHA-256(x)` (`HTLC.sol`) or `Addr(x)`
/// (`HTLCPoseidonV2.sol`, `docs/poseidon-leg.md` section 9.4). The watchers use it for every "does this preimage open this lock" test.
pub fn lock_word_of(kind: LockKind, preimage: &[u8; 32]) -> [u8; 32] {
    match kind {
        LockKind::Sha256 => sha256(preimage),
        LockKind::Poseidon => Secret::from_bytes(*preimage).lock_word(LockKind::Poseidon),
    }
}

/// Blocks per `eth_getLogs` request when a node refuses the whole range of the `poseidon` sender query (public Sepolia RPCs cap a request at this
/// size; REVIEW-7 R7-1). The old rule that read a result of exactly 1,000 / 5,000 / 10,000 / 20,000 logs as truncated is gone: the query is for
/// Bob's own sender, so its size does not depend on the other users of the contract.
pub const DEFAULT_LOG_RANGE_MAX: u64 = 50_000;

/// How many matching locks are read in full (events, `getLock`, code, block timestamp) per poll; the rest are only
/// counted in `EthObservation::lock_count`.
pub const MAX_LOCKS_READ: usize = 8;

/// Polls one Ethereum node for one lock (`lock_id`) of the HTLC at `contract`, and for every other lock that
/// matches the `discover` rule (REVIEW-2 F10). With `lock_id == [0; 32]` the first match is taken as the lock.
pub struct EthWatcher<R: JsonRpc> {
    pub rpc: R,
    pub contract: [u8; 20],
    pub lock_id: [u8; 32],
    /// First block searched by `eth_getLogs`; must be at or before the block of the `Locked`
    /// event (0 = whole chain; set it to the deployment block on a public node).
    pub from_block: u64,
    /// Hashes of pending transactions to inspect (the CLI gathers them from
    /// `eth_newPendingTransactionFilter` / `eth_getFilterChanges`).
    pub pending_txs: Vec<[u8; 32]>,
    pub discover: Option<LockDiscovery>,
    /// Which Ethereum contract this watcher reads (`sha256`: `HTLC.sol`, the default; `poseidon`: `HTLCPoseidonV2.sol`). The ABI shape is the
    /// same, so the kind changes only what a preimage is tested against and how the lock word is scanned.
    pub lock_kind: LockKind,
    /// `poseidon` kind (REVIEW-6 R6-1, REVIEW-7 R7-1): also read the `Locked` logs of Bob's own sender (the "has this word been locked before from
    /// Bob's address" check). Set by the
    /// caller only while Bob has not locked yet; off, the poll uses the indexed sender/receiver query alone, exactly as the `sha256` kind does,
    /// and its result depends on nothing else. A failing scan never fails the poll (it becomes [`WordScan::Failed`]).
    pub word_scan: bool,
    /// REVIEW-7 R7-1: block span of one `eth_getLogs` request of the sender query, used only after a node refused the whole range.
    pub log_range_max: u64,
    /// REVIEW-6 R6-3: the hash of a claim transaction of ours that the operator says was mined (`--reveal-tx`). When the receipt shows it
    /// REVERTED and it matches the lock, the secret in its calldata is returned as `reverted_claim`.
    pub reveal_tx: Option<[u8; 32]>,
    /// REVIEW-3 F3: the address this role signs Ethereum transactions with. When set, the poll ends with two
    /// `eth_getTransactionCount` calls (`"latest"`, `"pending"`) for it; a failed call is "unknown", never an error.
    pub signer: Option<[u8; 20]>,
    /// Clock for `observed_at` (Unix seconds); the system clock unless a test pins it.
    pub clock: fn() -> u64,
}

impl<R: JsonRpc> EthWatcher<R> {
    pub fn new(rpc: R, contract: [u8; 20], lock_id: [u8; 32]) -> Self {
        Self { rpc, contract, lock_id, from_block: 0, pending_txs: Vec::new(), discover: None, lock_kind: LockKind::Sha256, word_scan: false, log_range_max: DEFAULT_LOG_RANGE_MAX, reveal_tx: None, signer: None, clock: super::system_now }
    }

    /// REVIEW-7 R7-1: the block span of one request of the sender query when a node limits the range (default [`DEFAULT_LOG_RANGE_MAX`]).
    pub fn with_log_range_max(mut self, blocks: u64) -> Self {
        self.log_range_max = blocks;
        self
    }

    /// `poseidon` kind: also run the all-`Locked`-logs scan in this poll (see [`EthWatcher::word_scan`]). Ignored for the `sha256` kind.
    pub fn with_word_scan(mut self, on: bool) -> Self {
        self.word_scan = on;
        self
    }

    /// REVIEW-6 R6-3: inspect this transaction as a possibly mined-and-reverted claim of our lock.
    pub fn with_reveal_tx(mut self, hash: Option<[u8; 32]>) -> Self {
        self.reveal_tx = hash;
        self
    }

    /// REVIEW-3 F3: also read the nonces (`latest`, `pending`) of `signer`, the address the operator signs with.
    pub fn with_signer(mut self, signer: [u8; 20]) -> Self {
        self.signer = Some(signer);
        self
    }

    /// `eth_getTransactionCount(signer, tag)`; any failure (a node or recording without the call, a bad answer) is `None`.
    fn signer_nonce(&self, signer: &[u8; 20], tag: &str) -> Option<u64> {
        let v = self.rpc.call("eth_getTransactionCount", json!([hex0x(signer), tag])).ok()?;
        quantity("eth_getTransactionCount", &v).ok()
    }

    pub fn with_clock(mut self, clock: fn() -> u64) -> Self {
        self.clock = clock;
        self
    }

    pub fn with_discovery(mut self, rule: LockDiscovery) -> Self {
        self.discover = Some(rule);
        self
    }

    /// The lock kind of the contract (see [`EthWatcher::lock_kind`]).
    pub fn with_lock_kind(mut self, kind: LockKind) -> Self {
        self.lock_kind = kind;
        self
    }

    pub fn with_from_block(mut self, from_block: u64) -> Self {
        self.from_block = from_block;
        self
    }

    pub fn with_pending_txs(mut self, txs: Vec<[u8; 32]>) -> Self {
        self.pending_txs = txs;
        self
    }

    pub fn observe(&self) -> Result<EthObservation, RpcError> {
        const M_NUM: &str = "eth_blockNumber";
        const M_BLK: &str = "eth_getBlockByNumber";
        // Stamped when the poll STARTS: the observation is no fresher than its first answer.
        let observed_at = Some((self.clock)());
        let latest_block = quantity(M_NUM, &self.rpc.call(M_NUM, json!([]))?)?;
        let latest = self.rpc.call(M_BLK, json!(["latest", false]))?;
        let latest_timestamp = quantity(M_BLK, field(M_BLK, &latest, "timestamp")?)?;
        // Not every node knows the `finalized` tag (or has one yet): that is "unknown", not fatal.
        let finalized_block = match self.rpc.call(M_BLK, json!(["finalized", false])) {
            Ok(Value::Null) | Err(RpcError::Remote { .. }) => None,
            Ok(b) => Some(quantity(M_BLK, field(M_BLK, &b, "number")?)?),
            Err(e) => return Err(e),
        };

        // REVIEW-2 F1: the chain id and the contract's code hash are read on EVERY poll, before
        // any lock exists, so a spend that precedes the lock (Bob's `newLock`) is checked too.
        // A node that cannot answer either makes the whole poll fail: unknown is never a pass.
        let chain_id = quantity("eth_chainId", &self.rpc.call("eth_chainId", json!([]))?)?;
        let contract_code_hash = Some(keccak256(&self.code(&self.contract)?));

        // REVIEW-2 F10: every matching `Locked` event is found, even when the lock id is already known, so a second
        // lock is never hidden behind the first. The pinned lock (or, without a pin, the first match) comes first.
        // REVIEW-6 R6-1: both kinds find the swap's own locks the same way, through the INDEXED sender and receiver topics. The poseidon
        // kind's all-`Locked` scan is separate (below), asked only when the caller says Bob is deciding to lock, and it cannot fail the poll.
        let discovered: Vec<[u8; 32]> = match &self.discover {
            Some(rule) => self.discover_lock_ids(rule)?,
            None => Vec::new(),
        };
        let mut ids: Vec<[u8; 32]> = Vec::new();
        if self.lock_id != [0u8; 32] {
            ids.push(self.lock_id);
        }
        for d in &discovered {
            if !ids.contains(d) {
                ids.push(*d);
            }
        }
        let lock_id = ids.first().copied();
        let (mut lock, mut claimed, mut refunded, mut pending_preimage) = (None, None, None, None);
        let mut claim_state_from_record = false;
        let mut locks: Vec<EthLock> = Vec::new();
        let mut lock_count = 0usize;
        for (i, id) in ids.iter().copied().enumerate() {
            if i >= MAX_LOCKS_READ {
                // Counted, not read: the cap bounds the RPC cost of a flood of look-alike locks.
                lock_count += 1;
                continue;
            }
            let (l, c, r) = self.read_logs(id)?;
            match l {
                Some(mut l) => {
                    // REVIEW-3 F7: a claimed/refunded record without its log is accepted (the secret comes from the record).
                    let (c, r, from_record) = self.cross_check_get_lock(&mut l, c, r, latest_block)?;
                    l.sender_is_eoa = Some(self.is_eoa(&l.sender)?);
                    l.receiver_is_eoa = Some(self.is_eoa(&l.receiver)?);
                    l.block_timestamp = Some(self.block_timestamp(l.block_number)?);
                    lock_count += 1;
                    if i == 0 {
                        claimed = c;
                        refunded = r;
                        claim_state_from_record = from_record;
                        lock = Some(l.clone());
                    }
                    locks.push(l);
                }
                // REVIEW-2 F7: no `Locked` log is not "no lock". With the id known, ask the contract
                // itself (`getLock`) on every poll; a lock that exists but is missing from the logs
                // (`--eth-from-block` too high, a provider's range limit, a lagging log index) fails the
                // poll loudly instead of reading as "nothing there".
                None => {
                    self.require_no_record(id)?;
                    if i == 0 {
                        claimed = c;
                        refunded = r;
                    }
                }
            }
        }
        let mut overlong_claim = None;
        if let (Some(lock_id), Some(l)) = (lock_id, &lock) {
            let (pending, overlong) = self.find_pending_claim(lock_id, &l.hashlock)?;
            pending_preimage = pending;
            overlong_claim = overlong;
        }
        // REVIEW-6 R6-3: a claim of ours the operator named, checked against the pinned lock; every outcome is a note, none an error.
        let (mut reverted_claim, mut reveal_tx_note) = (None, None);
        if let Some(hash) = self.reveal_tx {
            match &lock {
                Some(l) => match self.read_reveal_tx(hash, l) {
                    Ok((rc, note)) => {
                        reverted_claim = rc;
                        reveal_tx_note = Some(note);
                    }
                    Err(e) => reveal_tx_note = Some(format!("--reveal-tx could not be read from the node: {e}")),
                },
                None => reveal_tx_note = Some("--reveal-tx: no lock of ours is visible yet, so the transaction cannot be checked against it".to_string()),
            }
        }
        // REVIEW-6 R6-1: the all-`Locked` scan, last of the lock reads and only when asked. Its trouble is a state, never an error.
        let (mut word_locks, mut word_scan): (Vec<WordLock>, WordScan) = (Vec::new(), WordScan::NotRun);
        if let (true, LockKind::Poseidon, Some(rule)) = (self.word_scan, self.lock_kind, &self.discover) {
            match self.locked_by_own_sender(rule, latest_block) {
                Ok(all) => {
                    // Review V2-8: the sender query must show every lock of the agreed parties that the targeted query found (its sender is the
                    // same). If it does not, it was cut (a provider limit that answered without an error) and cannot be trusted to show an
                    // EARLIER lock either.
                    if let Some(missed) = locks.iter().find(|l| l.hashlock == rule.hashlock && l.sender == rule.sender && !all.iter().any(|w| w.lock_id == l.lock_id)) {
                        word_scan = WordScan::Failed(format!(
                            "the query for Bob's own sender does not contain the lock {} that the targeted query found: the node truncated the range (provider limit); lower --eth-from-block or use a node without the cap",
                            hex0x(&missed.lock_id)
                        ));
                    } else {
                        word_scan = WordScan::Complete;
                        word_locks = all;
                    }
                }
                Err(e) => word_scan = WordScan::Failed(e.to_string()),
            }
        }
        // REVIEW-3 F3: asked last, like F5's header time: unknown on any failure, so an ordinary tick never fails on it.
        let (signer_nonce_latest, signer_nonce_pending) = match &self.signer {
            Some(a) => (self.signer_nonce(a, "latest"), self.signer_nonce(a, "pending")),
            None => (None, None),
        };
        Ok(EthObservation {
            observed_at,
            latest_block,
            latest_timestamp,
            finalized_block,
            chain_id: Some(chain_id),
            contract_code_hash,
            lock,
            locks,
            lock_count,
            claimed,
            refunded,
            claim_state_from_record,
            pending_preimage,
            overlong_claim,
            word_locks,
            word_scan,
            reverted_claim,
            reveal_tx_note,
            signer_nonce_latest,
            signer_nonce_pending,
            second: None,
            second_error: None,
            single_node_ok: false,
        })
    }

    /// `getLock(lockId)` for a lock the logs did not show. The contract reverts `LockNotFound`
    /// for an unknown id (an `eth_call` revert reaches us as a JSON-RPC error): that is the
    /// only answer that means "no such lock". Any lock record is an inconsistency with the logs.
    fn require_no_record(&self, lock_id: [u8; 32]) -> Result<(), RpcError> {
        const M: &str = "eth_call";
        let mut calldata = SELECTOR_GET_LOCK.to_vec();
        calldata.extend_from_slice(&lock_id);
        match self.rpc.call(M, json!([{ "to": hex0x(&self.contract), "data": hex0x(&calldata) }, "latest"])) {
            Err(RpcError::Remote { code, message }) if code == 3 || message.to_ascii_lowercase().contains("revert") => Ok(()),
            Err(e) => Err(e),
            Ok(_) => Err(dec(
                M,
                "getLock shows this lock but eth_getLogs returned no Locked event for it (--eth-from-block above the lock's block, a provider block-range limit, or a lagging log index); fix that and poll again",
            )),
        }
    }

    /// Alice's lookup: EVERY `Locked(_, sender, receiver, ...)` of our contract whose `hashlock` is ours, in log
    /// order (REVIEW-2 F10: the first is not necessarily the right one). Each id must recompute from its own terms.
    fn discover_lock_ids(&self, rule: &LockDiscovery) -> Result<Vec<[u8; 32]>, RpcError> {
        const M: &str = "eth_getLogs";
        let filter = json!([{
            "address": hex0x(&self.contract),
            "fromBlock": format!("0x{:x}", self.from_block),
            "toBlock": "latest",
            "topics": [hex0x(&TOPIC_LOCKED), Value::Null, hex0x(&pad32(&rule.sender)), hex0x(&pad32(&rule.receiver))],
        }]);
        let logs = self.rpc.call(M, filter)?;
        let logs = logs.as_array().ok_or_else(|| dec(M, "result is not an array"))?;
        let mut found: Vec<[u8; 32]> = Vec::new();
        for log in logs {
            if log.get("removed").and_then(Value::as_bool) == Some(true) {
                continue;
            }
            let topics: Vec<[u8; 32]> = field(M, log, "topics")?
                .as_array()
                .ok_or_else(|| dec(M, "topics is not an array"))?
                .iter()
                .map(|t| word32(M, t))
                .collect::<Result<_, _>>()?;
            let addr = bytes(M, field(M, log, "address")?)?;
            if addr != self.contract
                || topics.len() != 4
                || topics[0] != TOPIC_LOCKED
                || topics[2] != pad32(&rule.sender)
                || topics[3] != pad32(&rule.receiver)
            {
                continue;
            }
            let data = bytes(M, field(M, log, "data")?)?;
            if data.len() != 96 || word_at(M, &data, 1)? != rule.hashlock {
                continue;
            }
            let amount_wei = u128_word(M, &word_at(M, &data, 0)?)?;
            let timelock = u64_word(M, &word_at(M, &data, 2)?)?;
            if compute_lock_id(&rule.sender, &rule.receiver, amount_wei, &rule.hashlock, timelock) != topics[1] {
                return Err(dec(M, "Locked event: lockId does not recompute from its own fields"));
            }
            if !found.contains(&topics[1]) {
                found.push(topics[1]);
            }
        }
        Ok(found)
    }

    /// The `poseidon` word check (review V2-8, REVIEW-6 R6-1, REVIEW-7 R7-1). `Locked` has the lock word in its DATA, not as a topic, but
    /// the only question left is "has BOB'S OWN SENDER already locked on this word, to anyone" (a lock by another sender costs Bob nothing,
    /// REVIEW-6 R6-2), and the sender IS an indexed topic. So the node is asked for `[Locked, any lockId, Bob's sender]` only, from
    /// `from_block`: the answer is bounded by Bob's own activity, not by how busy the shared contract is, and nobody else can pad it (the sender
    /// topic is `msg.sender`). The lock word is compared here, and every log is re-checked locally (contract, event, sender, lock id
    /// recomputed). A range-limited node is asked in chunks of [`EthWatcher::log_range_max`] blocks. There is NO "exact provider cap size" rule
    /// any more: the result does not grow with other people's locks. A node error, a malformed log and a lock id that does not recompute are
    /// errors (never "no earlier lock" by silence). The CALLER turns an error into [`WordScan::Failed`] (it never fails the poll) and runs
    /// the check only while Bob is deciding to lock.
    fn locked_by_own_sender(&self, rule: &LockDiscovery, latest_block: u64) -> Result<Vec<WordLock>, RpcError> {
        const M: &str = "eth_getLogs";
        let sender_topic = pad32(&rule.sender);
        // `HTLCPoseidonV2.sol`: `Locked(bytes32 indexed lockId, address indexed sender, address indexed receiver, uint256 amount, bytes32 lockAddr,
        // uint256 timelock)` (checked in the contract source, REVIEW-7 R7-1): the sender is an indexed topic, topic2, the lock word is in the data.
        let query = |from: &str, to: &str| -> Result<Vec<Value>, RpcError> {
            let filter = json!([{
                "address": hex0x(&self.contract),
                "fromBlock": from,
                "toBlock": to,
                "topics": [hex0x(&TOPIC_LOCKED), Value::Null, hex0x(&sender_topic)],
            }]);
            let logs = self.rpc.call(M, filter)?;
            logs.as_array().cloned().ok_or_else(|| dec(M, "result is not an array"))
        };
        // One call over the whole range first. A node that limits the block range answers it with a JSON-RPC error; only then is the range
        // cut into chunks of `log_range_max` blocks (a transport error is not retried this way). A chunk that still fails fails the scan.
        let logs: Vec<Value> = match query(&format!("0x{:x}", self.from_block), "latest") {
            Ok(l) => l,
            Err(RpcError::Remote { .. }) => {
                let step = self.log_range_max.max(1);
                let mut all = Vec::new();
                let mut start = self.from_block;
                while start <= latest_block {
                    let end = start.saturating_add(step - 1).min(latest_block);
                    all.extend(query(&format!("0x{start:x}"), &format!("0x{end:x}"))?);
                    if end == u64::MAX {
                        break;
                    }
                    start = end + 1;
                }
                all
            }
            Err(e) => return Err(e),
        };
        // Every log is checked again here, so a provider that ignores the topic filter cannot slip another sender's lock in.
        let mut all: Vec<WordLock> = Vec::new();
        for log in logs {
            if log.get("removed").and_then(Value::as_bool) == Some(true) {
                continue;
            }
            let topics: Vec<[u8; 32]> = field(M, &log, "topics")?
                .as_array()
                .ok_or_else(|| dec(M, "topics is not an array"))?
                .iter()
                .map(|t| word32(M, t))
                .collect::<Result<_, _>>()?;
            let addr = bytes(M, field(M, &log, "address")?)?;
            if addr != self.contract || topics.len() != 4 || topics[0] != TOPIC_LOCKED || topics[2] != sender_topic {
                continue;
            }
            let data = bytes(M, field(M, &log, "data")?)?;
            if data.len() != 96 {
                return Err(dec(M, "malformed Locked event"));
            }
            if word_at(M, &data, 1)? != rule.hashlock {
                continue;
            }
            let sender = addr_word(M, &topics[2])?;
            let receiver = addr_word(M, &topics[3])?;
            let amount_wei = u128_word(M, &word_at(M, &data, 0)?)?;
            let timelock = u64_word(M, &word_at(M, &data, 2)?)?;
            if compute_lock_id(&sender, &receiver, amount_wei, &rule.hashlock, timelock) != topics[1] {
                return Err(dec(M, "Locked event: lockId does not recompute from its own fields"));
            }
            let block_number = quantity(M, field(M, &log, "blockNumber")?)?;
            if !all.iter().any(|w| w.lock_id == topics[1]) {
                all.push(WordLock { lock_id: topics[1], sender, receiver, amount_wei, timelock, block_number });
            }
        }
        Ok(all)
    }

    fn code(&self, addr: &[u8; 20]) -> Result<Vec<u8>, RpcError> {
        const M: &str = "eth_getCode";
        let code = self.rpc.call(M, json!([hex0x(addr), "latest"]))?;
        bytes(M, &code)
    }

    /// One `eth_getLogs`, decoded into at most one event of each kind for OUR lock id.
    #[allow(clippy::type_complexity)]
    fn read_logs(&self, lock_id: [u8; 32]) -> Result<(Option<EthLock>, Option<EthClaimed>, Option<EthRefunded>), RpcError> {
        const M: &str = "eth_getLogs";
        let filter = json!([{
            "address": hex0x(&self.contract),
            "fromBlock": format!("0x{:x}", self.from_block),
            "toBlock": "latest",
            "topics": [[hex0x(&TOPIC_LOCKED), hex0x(&TOPIC_CLAIMED), hex0x(&TOPIC_REFUNDED)], hex0x(&lock_id)],
        }]);
        let logs = self.rpc.call(M, filter)?;
        let logs = logs.as_array().ok_or_else(|| dec(M, "result is not an array"))?;
        let (mut locked, mut claimed, mut refunded) = (None, None, None);
        for log in logs {
            if log.get("removed").and_then(Value::as_bool) == Some(true) {
                continue; // dropped by a reorg
            }
            let topics: Vec<[u8; 32]> = field(M, log, "topics")?
                .as_array()
                .ok_or_else(|| dec(M, "topics is not an array"))?
                .iter()
                .map(|t| word32(M, t))
                .collect::<Result<_, _>>()?;
            // Defensive: a sloppy node may ignore the filter. Other contracts and other locks are not ours.
            let addr = bytes(M, field(M, log, "address")?)?;
            if addr != self.contract || topics.get(1) != Some(&lock_id) {
                continue;
            }
            let data = bytes(M, field(M, log, "data")?)?;
            let block_number = quantity(M, field(M, log, "blockNumber")?)?;
            let tx_hash = word32(M, field(M, log, "transactionHash")?)?;
            match topics.first() {
                Some(t) if *t == TOPIC_LOCKED => {
                    if locked.is_some() {
                        return Err(dec(M, "two Locked events for our lock id"));
                    }
                    locked = Some(self.decode_locked(lock_id, &topics, &data, block_number, tx_hash)?);
                }
                Some(t) if *t == TOPIC_CLAIMED => {
                    if claimed.is_some() || topics.len() != 2 || data.len() != 32 {
                        return Err(dec(M, "duplicate or malformed Claimed event"));
                    }
                    let preimage = word_at(M, &data, 0)?;
                    claimed = Some(EthClaimed { lock_id, preimage, block_number, tx_hash });
                }
                Some(t) if *t == TOPIC_REFUNDED => {
                    if refunded.is_some() || topics.len() != 2 || !data.is_empty() {
                        return Err(dec(M, "duplicate or malformed Refunded event"));
                    }
                    refunded = Some(EthRefunded { lock_id, block_number, tx_hash });
                }
                _ => {} // some other event of this contract
            }
        }
        Ok((locked, claimed, refunded))
    }

    /// `Locked(lockId indexed, sender indexed, receiver indexed, amount, hashlock, timelock)`.
    fn decode_locked(&self, lock_id: [u8; 32], topics: &[[u8; 32]], data: &[u8], block_number: u64, tx_hash: [u8; 32]) -> Result<EthLock, RpcError> {
        const M: &str = "eth_getLogs";
        if topics.len() != 4 || data.len() != 96 {
            return Err(dec(M, "malformed Locked event"));
        }
        let sender = addr_word(M, &topics[2])?;
        let receiver = addr_word(M, &topics[3])?;
        let amount_wei = u128_word(M, &word_at(M, data, 0)?)?;
        let hashlock = word_at(M, data, 1)?;
        let timelock = u64_word(M, &word_at(M, data, 2)?)?;
        // The lock id is a hash of the terms: an event whose id does not recompute is a lie.
        if compute_lock_id(&sender, &receiver, amount_wei, &hashlock, timelock) != lock_id {
            return Err(dec(M, "Locked event: lockId does not recompute from its own fields"));
        }
        Ok(EthLock {
            lock_id,
            sender,
            receiver,
            amount_wei,
            hashlock,
            timelock,
            block_number,
            tx_hash,
            claimed: false,
            refunded: false,
            receiver_is_eoa: None,
            sender_is_eoa: None,
            block_timestamp: None,
        })
    }

    /// `getLock(lockId)` returns 8 static words: sender, receiver, amount, hashlock, timelock,
    /// claimed, refunded, preimage. Fill the flags and refuse any contradiction with the events.
    ///
    /// REVIEW-3 F7: a record that says claimed (or refunded) while the logs show no such event is NOT an error: a log index
    /// may lag, or the range may be capped. The secret is then taken from the record's stored preimage, after
    /// `sha256(preimage) == hashlock`. The returned `EthClaimed`/`EthRefunded` is then synthesized (`tx_hash` zero,
    /// `block_number` = `latest_block`, an upper bound) and the third value is `true`. Still an error: a log that says
    /// claimed/refunded while the record does not, two different preimages, a record refunded while a `Claimed` log exists.
    #[allow(clippy::type_complexity)]
    fn cross_check_get_lock(
        &self,
        lock: &mut EthLock,
        claimed: Option<EthClaimed>,
        refunded: Option<EthRefunded>,
        latest_block: u64,
    ) -> Result<(Option<EthClaimed>, Option<EthRefunded>, bool), RpcError> {
        const M: &str = "eth_call";
        let mut calldata = SELECTOR_GET_LOCK.to_vec();
        calldata.extend_from_slice(&lock.lock_id);
        let out = self.rpc.call(M, json!([{ "to": hex0x(&self.contract), "data": hex0x(&calldata) }, "latest"]))?;
        let out = bytes(M, &out)?;
        if out.len() != 256 {
            return Err(dec(M, format!("getLock returned {} bytes, expected 256", out.len())));
        }
        let same = addr_word(M, &word_at(M, &out, 0)?)? == lock.sender
            && addr_word(M, &word_at(M, &out, 1)?)? == lock.receiver
            && u128_word(M, &word_at(M, &out, 2)?)? == lock.amount_wei
            && word_at(M, &out, 3)? == lock.hashlock
            && u64_word(M, &word_at(M, &out, 4)?)? == lock.timelock;
        if !same {
            return Err(dec(M, "getLock record disagrees with the Locked event"));
        }
        lock.claimed = bool_word(M, &word_at(M, &out, 5)?)?;
        lock.refunded = bool_word(M, &word_at(M, &out, 6)?)?;
        let stored_preimage = word_at(M, &out, 7)?;
        let inconsistent = || {
            dec(
                M,
                "getLock flags/preimage inconsistent with the logs (a block may have been mined between the two calls; poll again)",
            )
        };
        // A log that the record does not back is a contradiction, whichever way the node got there.
        if (claimed.is_some() && !lock.claimed) || (refunded.is_some() && !lock.refunded) {
            return Err(inconsistent());
        }
        if lock.claimed && lock.refunded {
            return Err(inconsistent());
        }
        // A record that says refunded next to a Claimed log (or claimed next to a Refunded log) is a contradiction.
        if (claimed.is_some() && lock.refunded) || (refunded.is_some() && lock.claimed) {
            return Err(inconsistent());
        }
        if let Some(c) = &claimed {
            if c.preimage != stored_preimage || lock_word_of(self.lock_kind, &c.preimage) != lock.hashlock {
                return Err(inconsistent());
            }
        }
        let mut from_record = false;
        let claimed = match claimed {
            Some(c) => Some(c),
            None if lock.claimed => {
                if lock_word_of(self.lock_kind, &stored_preimage) != lock.hashlock {
                    return Err(dec(M, "getLock preimage does not hash to the lock's hashlock (lock word)"));
                }
                from_record = true;
                Some(EthClaimed { lock_id: lock.lock_id, preimage: stored_preimage, block_number: latest_block, tx_hash: [0u8; 32] })
            }
            None => None,
        };
        let refunded = match refunded {
            Some(r) => Some(r),
            None if lock.refunded => {
                from_record = true;
                Some(EthRefunded { lock_id: lock.lock_id, block_number: latest_block, tx_hash: [0u8; 32] })
            }
            None => None,
        };
        Ok((claimed, refunded, from_record))
    }

    /// `timestamp` of block `number` (the block that mined the `Locked` event).
    fn block_timestamp(&self, number: u64) -> Result<u64, RpcError> {
        const M: &str = "eth_getBlockByNumber";
        let b = self.rpc.call(M, json!([format!("0x{number:x}"), false]))?;
        if b.is_null() {
            return Err(dec(M, "the block of the Locked event is unknown to the node"));
        }
        quantity(M, field(M, &b, "timestamp")?)
    }

    fn is_eoa(&self, addr: &[u8; 20]) -> Result<bool, RpcError> {
        const M: &str = "eth_getCode";
        let code = self.rpc.call(M, json!([hex0x(addr), "latest"]))?;
        Ok(bytes(M, &code)?.is_empty())
    }

    /// First still-pending `claim(ourLockId, preimage)` to our contract whose preimage really hashes to `hashlock`.
    /// (Anyone can broadcast a claim with a junk preimage; it would revert, so it must not be mistaken for the secret.)
    ///
    /// `poseidon` kind: the contract demands exactly 68 bytes of calldata, so a pending claim with a longer tail will REVERT
    /// (`BadCalldataLength`) and still has shown `s`. It is returned as the second value, never as the first: it is no reveal of
    /// Alice's (nothing will pay her), but Bob must treat the secret as public and claim the NOID from it (`docs/poseidon-leg.md` 9.4).
    #[allow(clippy::type_complexity)]
    fn find_pending_claim(&self, lock_id: [u8; 32], hashlock: &[u8; 32]) -> Result<(Option<PendingPreimage>, Option<PendingPreimage>), RpcError> {
        const M: &str = "eth_getTransactionByHash";
        let mut overlong: Option<PendingPreimage> = None;
        for hash in &self.pending_txs {
            let tx = self.rpc.call(M, json!([hex0x(hash)]))?;
            if tx.is_null() {
                continue; // unknown or already dropped
            }
            if !matches!(tx.get("blockNumber"), None | Some(Value::Null)) {
                continue; // mined: the Claimed event covers it
            }
            let to = match tx.get("to") {
                Some(t @ Value::String(_)) => bytes(M, t)?,
                _ => continue, // contract creation
            };
            let input = bytes(M, field(M, &tx, "input")?)?;
            let long_ok = self.lock_kind == LockKind::Poseidon && input.len() > 68;
            if to != self.contract || (input.len() != 68 && !long_ok) || input[..4] != SELECTOR_CLAIM || input[4..36] != lock_id {
                continue;
            }
            let preimage = word_at(M, &input[4..], 1)?;
            if lock_word_of(self.lock_kind, &preimage) == *hashlock {
                let p = PendingPreimage { lock_id, preimage, tx_hash: *hash };
                if input.len() == 68 {
                    return Ok((Some(p), overlong));
                }
                overlong.get_or_insert(p);
            }
        }
        Ok((None, overlong))
    }

    /// REVIEW-6 R6-3. A claim that was MINED and REVERTED (receipt status 0) published the secret in its calldata and paid nobody; no `Claimed`
    /// event marks it and it is no longer pending, so none of the other reads sees it. The operator names its hash (`--reveal-tx`, printed by
    /// `live.js claim` when it sees the revert) and this reads the transaction and the receipt from the node. It is accepted only if it is a call
    /// to OUR contract's `claim` of THIS lock id, sent from the lock's receiver (Alice's), whose preimage opens the lock word of this kind
    /// (calldata may be longer than 68 bytes: a revert for that very reason is the case for the `poseidon` kind). Any other transaction is
    /// refused with a note, never trusted because it was typed. REVIEW-7 R7-5: its block must also be on the node's canonical chain (the
    /// receipt's block hash equals the hash of the node's block at that height); the engine additionally wants a second Ethereum node, when
    /// one is configured, to read the same. Returns the reverted claim, if it is one, and a note for the operator.
    fn read_reveal_tx(&self, hash: [u8; 32], lock: &EthLock) -> Result<(Option<RevertedClaim>, String), RpcError> {
        const M: &str = "eth_getTransactionByHash";
        let name = hex0x(&hash);
        let tx = self.rpc.call(M, json!([name]))?;
        if tx.is_null() {
            return Ok((None, format!("--reveal-tx {name}: the node does not know this transaction (never sent, dropped, or the node lags); nothing was recorded")));
        }
        let refuse = |why: &str| Ok((None, format!("--reveal-tx {name} is not a claim of this lock and is IGNORED: {why}")));
        if word32(M, field(M, &tx, "hash")?)? != hash {
            return refuse("the node answered with another transaction");
        }
        let to = match tx.get("to") {
            Some(t @ Value::String(_)) => bytes(M, t)?,
            _ => return refuse("it is a contract creation"),
        };
        if to != self.contract {
            return refuse("it is not sent to the pinned contract");
        }
        let from = bytes(M, field(M, &tx, "from")?)?;
        let sender_ok = from == lock.receiver && self.discover.as_ref().is_none_or(|d| d.receiver == lock.receiver);
        if !sender_ok {
            return refuse("it was not sent by the receiver of the lock (Alice's address)");
        }
        let input = bytes(M, field(M, &tx, "input")?)?;
        if input.len() < 68 || input[..4] != SELECTOR_CLAIM || input[4..36] != lock.lock_id {
            return refuse("it is not claim(lockId, preimage) for this lock id");
        }
        let preimage = word_at(M, &input[4..], 1)?;
        if lock_word_of(self.lock_kind, &preimage) != lock.hashlock {
            return refuse("its preimage does not open this lock's word");
        }
        let mined_at = match tx.get("blockNumber") {
            None | Some(Value::Null) => {
                return Ok((None, format!("--reveal-tx {name}: still pending (not mined). It carries the secret: pass it with --pending-tx as well; nothing was recorded as a revert")));
            }
            Some(b) => quantity(M, b)?,
        };
        const R: &str = "eth_getTransactionReceipt";
        let receipt = self.rpc.call(R, json!([name]))?;
        if receipt.is_null() {
            return Ok((None, format!("--reveal-tx {name}: mined in block {mined_at} but the node has no receipt for it yet; try again")));
        }
        if word32(R, field(R, &receipt, "transactionHash")?)? != hash || quantity(R, field(R, &receipt, "blockNumber")?)? != mined_at {
            return Err(dec(R, "the receipt does not belong to this transaction (hash or block differ from the transaction)"));
        }
        // REVIEW-7 R7-5: the block that holds the transaction must be on the node's CANONICAL chain now. A receipt from a block that a reorg
        // has dropped (or from a node that serves a fork) proves nothing: the receipt's block hash must equal the hash of the block the node
        // has at that height, and the transaction's own block hash (when it names one) must be the same block.
        let block_hash = word32(R, field(R, &receipt, "blockHash")?)?;
        if let Some(tb) = tx.get("blockHash").filter(|v| !v.is_null()) {
            if word32(M, tb)? != block_hash {
                return Err(dec(R, "the receipt's block hash differs from the transaction's block hash"));
            }
        }
        const B: &str = "eth_getBlockByNumber";
        let canonical = self.rpc.call(B, json!([format!("0x{mined_at:x}"), false]))?;
        if canonical.is_null() {
            return Ok((None, format!("--reveal-tx {name}: the node has no block {mined_at} (it lags or the block was reorged out); nothing was recorded, try again")));
        }
        if word32(B, field(B, &canonical, "hash")?)? != block_hash {
            return Ok((
                None,
                format!(
                    "--reveal-tx {name}: its receipt is from block {mined_at} with hash {}, but the node's block {mined_at} has another hash: the block is NOT on the canonical chain (reorged out, or a fork); nothing was recorded, try again later",
                    hex0x(&block_hash)
                ),
            ));
        }
        match quantity(R, field(R, &receipt, "status")?)? {
            1 => Ok((None, format!("--reveal-tx {name}: mined in block {mined_at} and it SUCCEEDED (status 1); the Claimed event covers it"))),
            0 => Ok((
                Some(RevertedClaim { lock_id: lock.lock_id, preimage, tx_hash: hash, block_number: mined_at }),
                format!("--reveal-tx {name}: mined in block {mined_at} and REVERTED (status 0): it paid nobody but its calldata published the secret. The secret is PUBLIC"),
            )),
            other => Err(dec(R, format!("receipt status {other} is neither 0 nor 1"))),
        }
    }
}

// ------------------------------------------------------------ defensive decoding helpers

fn dec(method: &str, msg: impl std::fmt::Display) -> RpcError {
    RpcError::Decode(format!("{method}: {msg}"))
}

fn sha256(data: &[u8]) -> [u8; 32] {
    Sha256::digest(data).into()
}

fn hex0x(b: &[u8]) -> String {
    format!("0x{}", hex::encode(b))
}

/// An address as an indexed topic: left-padded to 32 bytes.
fn pad32(addr: &[u8; 20]) -> [u8; 32] {
    let mut w = [0u8; 32];
    w[12..].copy_from_slice(addr);
    w
}

fn field<'a>(method: &str, v: &'a Value, name: &str) -> Result<&'a Value, RpcError> {
    v.get(name).ok_or_else(|| dec(method, format!("missing field `{name}`")))
}

/// `"0x1a"` -> 26. Never panics; empty or non-hex input is an error.
fn quantity(method: &str, v: &Value) -> Result<u64, RpcError> {
    let s = v.as_str().and_then(|s| s.strip_prefix("0x")).ok_or_else(|| dec(method, "expected a 0x hex quantity"))?;
    u64::from_str_radix(s, 16).map_err(|e| dec(method, format!("bad quantity {s:?}: {e}")))
}

/// `"0x..."` -> bytes (even number of hex digits required; `"0x"` is empty).
fn bytes(method: &str, v: &Value) -> Result<Vec<u8>, RpcError> {
    let s = v.as_str().and_then(|s| s.strip_prefix("0x")).ok_or_else(|| dec(method, "expected 0x hex bytes"))?;
    hex::decode(s).map_err(|e| dec(method, format!("bad hex: {e}")))
}

fn word32(method: &str, v: &Value) -> Result<[u8; 32], RpcError> {
    bytes(method, v)?.try_into().map_err(|_| dec(method, "expected exactly 32 bytes"))
}

/// The `i`-th 32-byte word of ABI-encoded `data`.
fn word_at(method: &str, data: &[u8], i: usize) -> Result<[u8; 32], RpcError> {
    data.get(32 * i..32 * i + 32)
        .and_then(|w| <[u8; 32]>::try_from(w).ok())
        .ok_or_else(|| dec(method, format!("data too short for word {i}")))
}

fn addr_word(method: &str, w: &[u8; 32]) -> Result<[u8; 20], RpcError> {
    if w[..12].iter().any(|b| *b != 0) {
        return Err(dec(method, "address word has non-zero padding"));
    }
    <[u8; 20]>::try_from(&w[12..]).map_err(|_| dec(method, "address width"))
}

fn u128_word(method: &str, w: &[u8; 32]) -> Result<u128, RpcError> {
    if w[..16].iter().any(|b| *b != 0) {
        return Err(dec(method, "amount does not fit in u128"));
    }
    let low = <[u8; 16]>::try_from(&w[16..]).map_err(|_| dec(method, "u128 width"))?;
    Ok(u128::from_be_bytes(low))
}

fn u64_word(method: &str, w: &[u8; 32]) -> Result<u64, RpcError> {
    if w[..24].iter().any(|b| *b != 0) {
        return Err(dec(method, "value does not fit in u64"));
    }
    let low = <[u8; 8]>::try_from(&w[24..]).map_err(|_| dec(method, "u64 width"))?;
    Ok(u64::from_be_bytes(low))
}

fn bool_word(method: &str, w: &[u8; 32]) -> Result<bool, RpcError> {
    if w[..31].iter().any(|b| *b != 0) || w[31] > 1 {
        return Err(dec(method, "bool word is neither 0 nor 1"));
    }
    Ok(w[31] == 1)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keccak_and_topic_constants() {
        assert_eq!(
            hex::encode(keccak256(b"")),
            "c5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470"
        );
        assert_eq!(keccak256(b"Claimed(bytes32,bytes32)"), TOPIC_CLAIMED);
        assert_eq!(
            keccak256(b"Locked(bytes32,address,address,uint256,bytes32,uint256)"),
            TOPIC_LOCKED
        );
        assert_eq!(keccak256(b"Refunded(bytes32)"), TOPIC_REFUNDED);
        assert_eq!(keccak256(b"claim(bytes32,bytes32)")[..4], SELECTOR_CLAIM);
        assert_eq!(keccak256(b"refund(bytes32)")[..4], SELECTOR_REFUND);
        assert_eq!(keccak256(b"newLock(bytes32,uint256,address)")[..4], SELECTOR_NEW_LOCK);
        assert_eq!(keccak256(b"getLock(bytes32)")[..4], SELECTOR_GET_LOCK);
    }
}
