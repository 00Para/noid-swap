"use strict";
// Shared fixtures for the operator-UI tests. Not a test file (the glob is *.test.js).
const fs = require("fs");
const os = require("os");
const path = require("path");

const NOW = 1_800_000_000;
const D = 281514;
const SENTINEL = "SENTINEL-SECRET-DO-NOT-READ-0123456789abcdef";
const FAKE_PREIMAGE = "0x" + "5e".repeat(32);

const TERMS = {
  profile: "sepolia",
  variant: "raw",
  amount_micronoid: 10000000,
  h_create: D - 302,
  deadline_height: D,
  lock_by_height: D - 252,
  w_a_s: 4200,
  alice_noid: "o1ALICE-PLACEHOLDER",
  bob_noid: "o1BOB-PLACEHOLDER",
  hashlock: "0x" + "d0".repeat(32),
  contract_root: "o1rootplaceholder",
  eth: { chain_id: 11155111, contract: "0x" + "00".repeat(18) + "c0de", amount_wei: "1000000000000000", alice_receiver: "0x" + "00".repeat(18) + "a11c", bob_sender: "0x" + "00".repeat(18) + "b0b0" },
};

/** A tick in the shape `swap-cli tick` prints, overridable per field. */
function mkTick(o = {}) {
  const now = o.now ?? NOW;
  const tip = o.tip ?? D - 302;
  const instance = o.instance === null ? null : o.instance || { slot_index: 7, creation_id: 3, amount_micronoid: 10000000 };
  const noid = {
    observed_at: o.noidObservedAt ?? now - 4,
    tip,
    next_call_height: tip + 1,
    epoch_anchor: "0x" + "ea".repeat(32),
    fee_floor: 1000,
    fee_estimate_1_1: 5800,
    relay_floor: 5000,
    instance,
    instance_matches_opening: instance ? true : null,
    active_authority: null,
    instances: instance ? [{ instance, matches_opening: true, active_authority: null }] : [],
    instance_count: instance ? 1 : 0,
    pending_calls: [],
    confirmed_tx: null,
    tracked_tx_pending: null,
    tip_time: now - 20,
    single_node_ok: o.single ?? false,
    ...(o.noid || {}),
  };
  if (!noid.single_node_ok && !("second" in noid)) noid.second = { tip, instance_count: noid.instance_count };
  const eth = {
    observed_at: o.ethObservedAt ?? now - 4,
    latest_block: 100,
    latest_timestamp: o.ethTime ?? now - 6,
    finalized_block: 70,
    chain_id: 11155111,
    lock: o.lock === undefined ? null : o.lock,
    locks: [],
    lock_count: o.lock ? 1 : 0,
    claimed: null,
    refunded: null,
    pending_preimage: null,
    single_node_ok: o.single ?? false,
    ...(o.eth || {}),
  };
  if (!eth.single_node_ok && !("second" in eth)) eth.second = { latest_block: 100, latest_timestamp: eth.latest_timestamp };
  return {
    now,
    sources: o.sources || { noid: "x", eth: "y", noid_second: "x2", eth_second: "y2" },
    noid,
    eth,
    events: o.events || [],
    closed_by: null,
    action: o.action || { action: "wait", reason: "waiting" },
    notes: o.notes || [],
    intent: o.intent || { status: "none", intent: null },
    events_applied_to_file: true,
    action_executed: false,
    phase_after: o.phase || "funding_final",
  };
}

function mkLock(o = {}) {
  return {
    lock_id: "0x" + "d1".repeat(32),
    sender: TERMS.eth.bob_sender,
    receiver: TERMS.eth.alice_receiver,
    amount_wei: "1000000000000000",
    hashlock: TERMS.hashlock,
    timelock: o.timelock ?? NOW + 3000,
    block_number: 90,
    tx_hash: "0x" + "d2".repeat(32),
    claimed: !!o.claimed,
    refunded: !!o.refunded,
    ...o.extra,
  };
}

function input(role, tick, extra = {}) {
  return { role, now: NOW, tick, tick_mtime: NOW - 3, terms: TERMS, helpers: [], loop: null, ...extra };
}

/** A temp run folder shaped like scripts/live's $L, with secret-bearing files that must never be opened. */
function makeRunFolder(opts = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "noid-run-"));
  const w = (name, text) => {
    const p = path.join(dir, name);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, text);
    return p;
  };
  const tick = mkTick({ phase: "lock_final", lock: mkLock(), eth: { claimed: { lock_id: "0x" + "d1".repeat(32), preimage: FAKE_PREIMAGE, block_number: 99, tx_hash: "0x" + "d3".repeat(32) } }, events: [{ event: "eth_preimage_seen", preimage: FAKE_PREIMAGE, tip: 1, time: 2 }], action: { action: "claim_noid", call_height: 5, fee_micronoid: 5800, preimage: FAKE_PREIMAGE } });
  w("last-tick-alice.json", JSON.stringify(tick));
  w("last-tick-alice.err", "warning: one node per chain\nERROR something refused\nsecret 0x" + "ef".repeat(32) + "\n");
  w("loop-alice.txt", [`18:25:14 [alice] tick exit 0 at 18:25:14 noid: tip 1 ACTION: {"action": "wait", "reason": "waiting for funding finality"} notes: [] applied: True phase_after: funded`, `18:25:44 [alice] tick exit 0 at 18:25:44 noid: tip 2 ACTION: {"action": "wait", "reason": "x"} applied: True phase_after: funding_final`].join("\n") + "\n");
  w("alice.bundle.json", JSON.stringify({ hashlock: TERMS.hashlock, claim_authority: "o1AUTH", contract_root: "o1rootplaceholder", opening_hex: "4e4f49444f424a33" + "00".repeat(40), params: { profile: "sepolia", variant: "raw", amount_micronoid: 10000000, h_create: D - 302, deadline_height: D, lock_by_height: D - 252, w_a_s: 4200, alice_noid: TERMS.alice_noid, bob_noid: TERMS.bob_noid, eth: { chain_id: 11155111, contract: TERMS.eth.contract, amount_wei: "1000000000000000", alice_receiver: TERMS.eth.alice_receiver, bob_sender: TERMS.eth.bob_sender } } }));
  w("swap.object.json", JSON.stringify({ address: "o1rootplaceholder", claim_authority: "o1AUTH", deadline_height: D, opening_hex: "4e4f49444f424a33" + "00".repeat(40), program: [{ opcode: "keep" }] }));
  w("eth-claim-dry-120001.json", JSON.stringify({ dryRun: true, sent: false, chainId: "11155111", lockId: "0x" + "d1".repeat(32), receiver: TERMS.eth.alice_receiver, valueWei: "0", gasEstimate: null, revealCutoff: "1", feeCheck: { ratio: 3 }, data: "0x" + "ab".repeat(100) }));
  w("eth-lock-120002.json", JSON.stringify({ txHash: "0x" + "d2".repeat(32), blockNumber: 90, lockId: "0x" + "d1".repeat(32) }));
  w("claim-120003.out", JSON.stringify({ mode: "dry_run", submitted: false, action: { action: "claim_noid", preimage: FAKE_PREIMAGE, call_height: 5 }, plan: { txid: "ab".repeat(32), call_height: 5, fee_micronoid: 5800, amount_out_micronoid: 9994200, recipient: TERMS.bob_noid, self_verified: true }, opening_hex: "00", notes: [] }));
  w("verify.out", "OK: exists m with sha256(m) = H and Addr(m) = A\n");
  // never to be opened:
  w("alice.swap.json", JSON.stringify({ secret: SENTINEL, sealed: SENTINEL }));
  w("bob/bob.swap.json", JSON.stringify({ secret: SENTINEL }));
  w("passphrase.txt", SENTINEL);
  w("keys/alice.key", SENTINEL);
  w("alice.receipt", SENTINEL);
  w("env.local.sh", "ALICE_NOID=o1xxx\n" + SENTINEL);
  w("claim-intent-120000.hex", SENTINEL);
  w("rec/alice-noid-1.json", SENTINEL);
  w("alice.swap.json.lock", SENTINEL);
  return { dir, tick, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

/** Records every path opened through fs while fn runs. */
function spyOpens(fn) {
  const opened = [];
  const orig = {};
  for (const k of ["readFileSync", "openSync", "readdirSync", "statSync"]) {
    orig[k] = fs[k];
    fs[k] = function (p, ...rest) {
      opened.push([k, String(p)]);
      return orig[k].call(fs, p, ...rest);
    };
  }
  try {
    return { result: fn(), opened };
  } finally {
    for (const k of Object.keys(orig)) fs[k] = orig[k];
  }
}

// Every /api request needs the server's per-start token (GET too): tests register the token of the servers they start, by port.
const TOKENS = new Map();
function registerToken(server) {
  TOKENS.set(server.address().port, server.runToken);
  return server.address().port;
}
/** The headers a GET of the page's own would carry: the token, unless the test names the header itself (an explicit undefined omits it). */
function withToken(port, method, headers) {
  const tk = TOKENS.get(port);
  return tk && !("x-swap-token" in headers) && (method === "GET" || method === "HEAD") ? { ...headers, "x-swap-token": tk } : headers;
}

module.exports = { TOKENS, registerToken, withToken, NOW, D, SENTINEL, FAKE_PREIMAGE, TERMS, mkTick, mkLock, input, makeRunFolder, spyOpens };
