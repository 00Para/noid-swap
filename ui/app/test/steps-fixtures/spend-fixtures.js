"use strict";
// Fixtures of the spend-step tests (4.4): the fresh-tick vector of the lock approval (the same one scripts/live/selftest.sh section 15 and eth/test use), canned
// answers of the two stub tools, and the helpers the registry and the tests share. Not a test file.
const crypto = require("crypto");
const { ALICE_NOID, ALICE_ETH, BOB_ETH, NOID_PAYOUT, ETH_PAYOUT, CONTRACT } = require("./settings");

const hexn = (n, d) => `0x${d.repeat(n)}`;
const V_CONTRACT = hexn(20, "11");
const V_CODE = hexn(32, "22");
const V_SENDER = hexn(20, "33");
const V_RECV = hexn(20, "44");
const V_WORD = hexn(32, "55");
const V_HASH = "c49c5c1f57ed1e347403ffa1e4ea25167b0132aa7b6f705d5996acaf8cb09761"; // sha256 kind; the shared vector
const V_GO = `go 1762000000 ${V_HASH} 1762000010`;

/** A tick of Bob's file as the fresh read-only tick prints it, with the lock offered (the vector above). `over` replaces top-level keys. */
function tickGo(over = {}) {
  return JSON.stringify({
    action: { action: "wait", reason: "intent lock_eth pending since 1 (unix): the chain does not show it yet; reuse the printed parameters" },
    now: 1762000010,
    notes: ["producer concentration ok", "held: fresh decision was lock_eth", "frozen parameters of the pending lock_eth: {}"],
    swap_terms: { eth: { chain_id: 11155111, contract: V_CONTRACT, code_hash: V_CODE, lock_kind: "sha256", bob_sender: V_SENDER }, hashlock: V_WORD },
    intent: { status: "held", intent: { action: "lock_eth", params: { action: "lock_eth", hashlock: V_WORD, t_reveal: 1762007200, receiver: V_RECV, amount_wei: "1000000000000000" }, decided_at: 1762000000 } },
    ...over,
  });
}

const TX = "ef".repeat(32);
const TXH = `0x${TX}`;
const LIVE_SENT_ERR = `sent: ${TXH} nonce 1 maxFeePerGas 2 gwei maxPriorityFeePerGas 1 gwei (waiting for the receipt)\n`;
const LIVE_OK = JSON.stringify({ txHash: TXH, blockNumber: 123 }, null, 2);
const NOID_TX = "ab".repeat(32);

const ROOT = "o1selftestcontractrootxxxxxxxxxxx";

/** `swap-cli wallet address` output of the sealed record. */
const walletAddr = (o = {}) => JSON.stringify({ address: ALICE_NOID, payout: NOID_PAYOUT, contract_root: ROOT, ...o }, null, 2);
/** `swap-cli ethkey address` output. */
const ethkeyAddr = (role, o = {}) => JSON.stringify({ address: role === "alice" ? ALICE_ETH : BOB_ETH, payout: ETH_PAYOUT, role, ...o }, null, 2);
/** live.js reserve output. */
const reserve = (address, covered = true) =>
  JSON.stringify({ role: "alice", address, chainId: "11155111", lockKind: "poseidon", reserveWei: "1000", requiredWei: "1000", balanceWei: covered ? "5000" : "10", shortfallWei: covered ? "0" : "990", covered, keyChecked: true }, null, 2);
/** swap-cli wallet fund|recover|sweep output. */
const step = (sub, outcome, o = {}) =>
  JSON.stringify(
    { step: sub, outcome, summary: `stub summary for ${outcome}`, txid: outcome === "hold" ? null : NOID_TX, built_now: true, amount_micronoid: 5000000, fee_micronoid: 6000, change_micronoid: 0, target: ROOT, inputs: 1, child_height: 280600, submit: null, notes: [], ...o },
    null,
    2
  );

const SIG = `0x${"77".repeat(65)}`;
const OFFER = "a1".repeat(32);
const TAKE = "b2".repeat(32);
const DIGEST = "de".repeat(32);

const sha = (s) => crypto.createHash("sha256").update(s).digest("hex");

module.exports = { V_CONTRACT, V_CODE, V_SENDER, V_RECV, V_WORD, V_HASH, V_GO, tickGo, TX, TXH, LIVE_SENT_ERR, LIVE_OK, NOID_TX, ROOT, walletAddr, ethkeyAddr, reserve, step, SIG, OFFER, TAKE, DIGEST, sha, CONTRACT };
