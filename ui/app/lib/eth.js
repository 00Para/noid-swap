"use strict";
/*
 * Ethereum observation of one HTLC lock (read-only), modelled on
 * swap-cli/src/watch/eth.rs and eth/scripts/live.js `status`.
 * Methods: eth_chainId, eth_blockNumber, eth_getBlockByNumber (latest,
 * finalized), eth_getLogs (our lock id only), eth_call getLock.
 *
 * The revealed preimage (public once claimed) is never returned: only
 * `preimage_revealed` and `preimage_matches_hashlock`.
 */

const fs = require("fs");
const path = require("path");
const { ethers } = require("../../../eth/node_modules/ethers");

const ARTIFACT = path.join(__dirname, "..", "..", "..", "eth", "artifacts", "contracts", "HTLC.sol", "HTLC.json");
// Fallback when eth/ has not been compiled: the fragments the console needs.
const FALLBACK_ABI = [
  "event Locked(bytes32 indexed lockId, address indexed sender, address indexed receiver, uint256 amount, bytes32 hashlock, uint256 timelock)",
  "event Claimed(bytes32 indexed lockId, bytes32 preimage)",
  "event Refunded(bytes32 indexed lockId)",
  "function getLock(bytes32 lockId) view returns (tuple(address sender, address receiver, uint256 amount, bytes32 hashlock, uint256 timelock, bool claimed, bool refunded, bytes32 preimage))",
];

let cachedIface = null;
function htlcInterface() {
  if (cachedIface) return cachedIface;
  let abi = FALLBACK_ABI;
  let source = "inline";
  try {
    if (fs.existsSync(ARTIFACT)) {
      abi = JSON.parse(fs.readFileSync(ARTIFACT, "utf8")).abi;
      source = "artifact";
    }
  } catch {
    /* keep the inline fragments */
  }
  cachedIface = new ethers.Interface(abi);
  cachedIface.__source = source;
  return cachedIface;
}

const EVENT_NAMES = ["Locked", "Claimed", "Refunded"];
const M_A_S = 1800; // Alice's reveal margin (design section 4 / params.rs M_A)

function qty(v, what) {
  if (typeof v === "string" && /^0x[0-9a-fA-F]+$/.test(v)) return Number(BigInt(v));
  if (typeof v === "number") return v;
  throw new Error(`eth: ${what}: expected a hex quantity, got ${JSON.stringify(v)}`);
}

function lockState(lock, chainTs) {
  if (!lock) return "not found";
  if (lock.claimed) return "claimed";
  if (lock.refunded) return "refunded";
  if (chainTs !== null && chainTs >= lock.timelock) return "expired-unclaimed (refundable)";
  return "open (claimable)";
}

/**
 * @param rpc  client with call(method, params), chain "eth"
 * @param swap { contract, lock_id, from_block? }
 */
async function observeEth(rpc, swap, clock = () => Math.floor(Date.now() / 1000)) {
  const observed_at = clock();
  const iface = htlcInterface();
  const contract = String(swap.contract || "").toLowerCase();
  const lockId = String(swap.lock_id || "").toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(contract)) throw new Error("eth: swap has no valid contract address");
  if (!/^0x[0-9a-f]{64}$/.test(lockId)) throw new Error("eth: swap has no valid lock_id");

  let chain_id = null;
  try {
    chain_id = qty(await rpc.call("eth_chainId", []), "eth_chainId");
  } catch {
    chain_id = null; // not every node (or fixture) answers it; unknown, not fatal
  }
  const latest_number = qty(await rpc.call("eth_blockNumber", []), "eth_blockNumber");
  const latestBlk = await rpc.call("eth_getBlockByNumber", ["latest", false]);
  if (!latestBlk) throw new Error("eth: no latest block");
  const latest = {
    number: qty(latestBlk.number, "latest.number"),
    timestamp: qty(latestBlk.timestamp, "latest.timestamp"),
    hash: latestBlk.hash || null,
  };
  let finalized = null;
  try {
    const fb = await rpc.call("eth_getBlockByNumber", ["finalized", false]);
    if (fb) finalized = { number: qty(fb.number, "finalized.number"), timestamp: qty(fb.timestamp, "finalized.timestamp"), hash: fb.hash || null };
  } catch {
    finalized = null;
  }

  const topics = EVENT_NAMES.map((n) => iface.getEvent(n).topicHash);
  const fromBlock = "0x" + Number(swap.from_block || 0).toString(16);
  const logs = await rpc.call("eth_getLogs", [{ address: contract, fromBlock, toBlock: "latest", topics: [topics, lockId] }]);
  const events = [];
  let revealedPreimage = null;
  for (const log of logs || []) {
    let parsed;
    try {
      parsed = iface.parseLog({ topics: log.topics, data: log.data });
    } catch {
      continue;
    }
    if (!parsed) continue;
    const ev = {
      name: parsed.name,
      block_number: qty(log.blockNumber, "log.blockNumber"),
      tx_hash: log.transactionHash,
      log_index: log.logIndex === undefined ? null : qty(log.logIndex, "log.logIndex"),
      removed: !!log.removed,
    };
    if (parsed.name === "Locked") {
      ev.sender = parsed.args.sender.toLowerCase();
      ev.receiver = parsed.args.receiver.toLowerCase();
      ev.amount_wei = parsed.args.amount.toString();
      ev.hashlock = parsed.args.hashlock.toLowerCase();
      ev.timelock = Number(parsed.args.timelock);
    } else if (parsed.name === "Claimed") {
      revealedPreimage = parsed.args.preimage; // kept in memory for the hash check only
    }
    events.push(ev);
  }
  events.sort((a, b) => a.block_number - b.block_number || (a.log_index || 0) - (b.log_index || 0));

  let lock = null;
  let lock_error = null;
  const lockedEv = events.find((e) => e.name === "Locked");
  if (lockedEv) {
    try {
      const data = iface.encodeFunctionData("getLock", [lockId]);
      const raw = await rpc.call("eth_call", [{ to: contract, data }, "latest"]);
      const [l] = iface.decodeFunctionResult("getLock", raw);
      lock = {
        sender: l.sender.toLowerCase(),
        receiver: l.receiver.toLowerCase(),
        amount_wei: l.amount.toString(),
        hashlock: l.hashlock.toLowerCase(),
        timelock: Number(l.timelock),
        claimed: !!l.claimed,
        refunded: !!l.refunded,
      };
      if (lock.claimed && revealedPreimage === null) revealedPreimage = l.preimage;
    } catch (e) {
      lock_error = (e && e.message) || String(e);
    }
  }

  const preimage_revealed = revealedPreimage !== null && revealedPreimage !== undefined;
  let preimage_matches_hashlock = null;
  if (preimage_revealed) {
    const h = (lock && lock.hashlock) || (lockedEv && lockedEv.hashlock) || null;
    preimage_matches_hashlock = h ? ethers.sha256(revealedPreimage).toLowerCase() === h : null;
  }

  const state = lock ? lockState(lock, latest.timestamp) : lockedEv ? "locked (getLock unavailable)" : "not found";
  const lock_block = lockedEv ? lockedEv.block_number : null;
  return {
    observed_at,
    chain_id,
    latest_number,
    latest,
    finalized,
    contract,
    lock_id: lockId,
    lock,
    lock_error,
    lock_block,
    lock_finalized: lock_block !== null && finalized !== null ? finalized.number >= lock_block : null,
    state,
    events,
    preimage_revealed,
    preimage_matches_hashlock,
    reveal_cutoff: lock ? lock.timelock - M_A_S : null,
    abi_source: iface.__source,
  };
}

module.exports = { observeEth, htlcInterface, lockState, M_A_S, EVENT_NAMES };
