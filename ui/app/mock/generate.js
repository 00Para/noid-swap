#!/usr/bin/env node
"use strict";
/*
 * Writes mock/run-1.json and mock/run-2.json: synthetic node answers (in the
 * swap-cli fixture format, one list per chain) plus the engine's loop text,
 * shaped from docs/live-run-1.md and docs/live-run-2.md.
 *
 *   node ui/app/mock/generate.js
 *
 * Everything in the mocks is public (heights, txids, addresses from the two
 * logs; the two object/bundle files). Run 1's Claimed event needs a preimage,
 * and the real secret is not known here, so run 1 uses a SYNTHETIC secret
 * (0x11 x 32) and the hashlock in its mock terms is sha256 of that. Txids the
 * logs only show truncated are synthesised deterministically (see `synthTx`).
 */
const fs = require("fs");
const path = require("path");
const { ethers } = require("../../../eth/node_modules/ethers");
const { htlcInterface } = require("../lib/eth");

const iface = htlcInterface();
const hex = (n) => "0x" + BigInt(n).toString(16);
const synthTx = (label) => ethers.keccak256(ethers.toUtf8Bytes("noid-swap mock " + label));
const synthHash32 = (label) => ethers.keccak256(ethers.toUtf8Bytes("noid-swap mock hash " + label)).slice(2);

const CONTRACT = "0x489228d5b89ec1b2e441fc5fff5517cb79c6ec48";
const BOB_ETH = "0x6f8560ec1185f50104f5b64df21e858dbd592883";
const ALICE_ETH = "0x49877dace5b72f4e8768fbf5cb7ee1573c9ff9ea";
const AMOUNT_WEI = 1000000000000000n;
const CHAIN_ID = 31337;

function readPublic(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function block(number, ts) {
  return {
    number: hex(number),
    hash: "0x" + synthHash32("block " + number),
    parentHash: "0x" + synthHash32("block " + (number - 1)),
    timestamp: hex(ts),
    transactions: [],
  };
}

function log(name, args, blockNumber, txHash, logIndex = 0) {
  const { topics, data } = iface.encodeEventLog(iface.getEvent(name), args);
  return {
    removed: false,
    logIndex: hex(logIndex),
    transactionIndex: "0x0",
    transactionHash: txHash,
    blockHash: "0x" + synthHash32("block " + blockNumber),
    blockNumber: hex(blockNumber),
    address: CONTRACT,
    data,
    topics,
  };
}

function ethFixture({ latest, latestTs, logs, lock }) {
  const getLock = iface.encodeFunctionResult("getLock", [
    [lock.sender, lock.receiver, lock.amount, lock.hashlock, lock.timelock, lock.claimed, lock.refunded, lock.preimage],
  ]);
  return {
    description: "MOCK Ethereum answers (Hardhat-shaped, chain id 31337) for the noid-swap console; see generate.js",
    calls: [
      { method: "eth_chainId", result: hex(CHAIN_ID) },
      { method: "eth_blockNumber", result: hex(latest) },
      { method: "eth_getBlockByNumber", params: ["latest", false], result: block(latest, latestTs) },
      { method: "eth_getBlockByNumber", params: ["finalized", false], result: block(latest, latestTs) },
      { method: "eth_getLogs", result: logs },
      { method: "eth_call", result: getLock },
    ],
  };
}

function noidFixture({ tip, anchor, opening, root, instance, object, fund, close, mempoolSize }) {
  const calls = [
    { method: "paranoid_blockCount", params: [], result: tip },
    { method: "paranoid_getEpochAnchor", params: [], result: anchor },
    {
      method: "paranoid_estimateFeeDetailed",
      params: [1, 1],
      result: {
        n_inputs: 1,
        n_outputs: 1,
        net_new_slots: 0,
        active_slot_count: 106091,
        log_slots: 24,
        fee_micronoid: 5800,
        breakdown: { base: 5000, input: 100, output: 700, io: 800, state_growth: 0, burned: 0, relay_floor: 5000, relay_total: 5800, required_total: 5800, paid_total: 5800, miner_claimable: 5800 },
      },
    },
    {
      method: "paranoid_getObjectInstances",
      params: [opening, 0, 16],
      result: {
        address: root,
        height: tip,
        tip_hash: synthHash32("noid tip " + tip),
        next_slot: null,
        slots: instance ? [{ slot_index: instance.slot_index, creation_id: instance.creation_id, value: instance.amount_micronoid, owner: root, empty: false }] : [],
      },
    },
  ];
  if (instance) {
    calls.push({
      method: "paranoid_getObjectStatus",
      params: [opening, instance.slot_index],
      result: {
        matches_opening: true,
        active_authority: object.claim_authority,
        next_call_height: tip + 1,
        tip_height: tip,
        object: { ...object, state: ["0", "0"] },
        slot: { empty: false, value: instance.amount_micronoid, creation_id: instance.creation_id, owner: root },
      },
    });
  }
  const txs = [];
  for (let i = 0; i < mempoolSize; i++) {
    txs.push({ tx_hash: synthHash32("mempool " + i), fee_micronoid: 6600, fee_rate: 1650, n_inputs: 2, n_outputs: 2, page_count: 1, minimum_proof_class: "B63", requires_b255_miner: false, admitted_height: tip, has_authorization: true });
  }
  calls.push({ method: "paranoid_getMempoolInfo", params: [], result: { size: mempoolSize, fee_floor: 5000, txs } });
  if (fund) calls.push({ method: "paranoid_getTx", params: [fund.txid], result: { tx_hash: fund.txid, height: fund.height, block_hash: synthHash32("noid block " + fund.height), tx_position: 1 } });
  if (close) calls.push({ method: "paranoid_getTx", params: [close.txid], result: { tx_hash: close.txid, height: close.height, block_hash: synthHash32("noid block " + close.height), tx_position: 1 } });
  return { description: "MOCK Parano1d answers for the noid-swap console; see generate.js", calls };
}

function main() {
  const outDir = __dirname;
  const docs = "C:\\Users\\00\\Documents";

  // ---------------------------------------------------------------- run 1 (settled)
  const obj1 = readPublic(path.join(docs, "live-run-1", "swap.object.json"));
  const bun1 = readPublic(path.join(docs, "live-run-1", "alice.bundle.json"));
  const preimage1 = "0x" + "11".repeat(32); // synthetic: the real secret is not public
  const hashlock1 = ethers.sha256(preimage1);
  bun1.hashlock = hashlock1; // keep the mock self-consistent
  const lockId1 = "0x23a340a69533ae4fb235df236f6edba98a77d6413ab1c31a0f14874e6ff98c69";
  const tReveal1 = 1793810086;
  const lockTs1 = tReveal1 - 7200;
  const lockTx1 = synthTx("run1 lock tx 0xfde62e25…db24");
  const claimTx1 = synthTx("run1 claim tx 0x764db838…37ae");
  const run1 = {
    description:
      "MOCK timeline of live run 1 (settled): 10 NOID (mainnet) <-> 0.001 ETH (local Hardhat). Heights and the NOID txids are the real public ones from docs/live-run-1.md; the ETH tx hashes and the preimage/hashlock are synthetic.",
    advance: true,
    fund_txid: "267e6f1dbbfa7623d51d7acea9bcc1b78136ded8d205adbb3a3b0e88d4e67780",
    close_txid: "d50743e3ead6c3870ec7e9b1322113a956a034cf6fc259753743ecd49f3e1324",
    terms: { object: obj1, bundle: bun1 },
    noid: noidFixture({
      tip: 280700,
      anchor: "28931e56442916500aa93d58394a7d024aee9afeae746d32bd176b8099d7a02d",
      opening: obj1.opening_hex,
      root: obj1.address,
      instance: null,
      object: obj1,
      fund: { txid: "267e6f1dbbfa7623d51d7acea9bcc1b78136ded8d205adbb3a3b0e88d4e67780", height: 280638 },
      close: { txid: "d50743e3ead6c3870ec7e9b1322113a956a034cf6fc259753743ecd49f3e1324", height: 280659 },
      mempoolSize: 3,
    }),
    eth: ethFixture({
      latest: 300,
      latestTs: lockTs1 + 35 * 12,
      logs: [
        log("Locked", [lockId1, BOB_ETH, ALICE_ETH, AMOUNT_WEI, hashlock1, tReveal1], 265, lockTx1),
        log("Claimed", [lockId1, preimage1], 269, claimTx1),
      ],
      lock: { sender: BOB_ETH, receiver: ALICE_ETH, amount: AMOUNT_WEI, hashlock: hashlock1, timelock: tReveal1, claimed: true, refunded: false, preimage: preimage1 },
    }),
    status_text: null,
  };

  // ---------------------------------------------------------------- run 2 (Bob refunded, Alice waits for D)
  const obj2 = readPublic(path.join(docs, "live-run-2", "swap.object.json"));
  const bun2 = readPublic(path.join(docs, "live-run-2", "alice.bundle.json"));
  const lockId2 = "0x844f4c78d095ca6b65a01bf160c09c721ca394ca244288f6d64ada0d147e3cba";
  const tReveal2 = 1793815478;
  const lockTx2 = synthTx("run2 lock tx 0x2de640b0…067d");
  const refundTx2 = "0x6f659b4f10fd46620dad2011ff4f9aa2dffa63eea09412d724ac329e8be12682";
  const zero32 = "0x" + "00".repeat(32);
  const run2 = {
    description:
      "MOCK timeline of live run 2 (refund path): Bob refunded the ETH at T_reveal, Alice keeps the secret and waits for D = 281,514. Heights, txids and addresses are the real public ones from docs/live-run-2.md (ETH lock tx hash synthetic). The engine text is the real loop-alice.txt block of 18:25 UTC.",
    advance: true,
    fund_txid: "c47eb2270a1e4f10d01dd09c05ace351ffca3860f287697629fe16c5547ddccb",
    terms: { object: obj2, bundle: bun2 },
    noid: noidFixture({
      tip: 281108,
      anchor: "28931e56442916500aa93d58394a7d024aee9afeae746d32bd176b8099d7a02d",
      opening: obj2.opening_hex,
      root: obj2.address,
      instance: { slot_index: 9705979, creation_id: 737344, amount_micronoid: 10000000 },
      object: obj2,
      fund: { txid: "c47eb2270a1e4f10d01dd09c05ace351ffca3860f287697629fe16c5547ddccb", height: 280814 },
      close: null,
      mempoolSize: 5,
    }),
    eth: ethFixture({
      latest: 1416,
      latestTs: 1793816708,
      logs: [
        log("Locked", [lockId2, BOB_ETH, ALICE_ETH, AMOUNT_WEI, bun2.hashlock, tReveal2], 716, lockTx2),
        log("Refunded", [lockId2], 1320, refundTx2),
      ],
      lock: { sender: BOB_ETH, receiver: ALICE_ETH, amount: AMOUNT_WEI, hashlock: bun2.hashlock, timelock: tReveal2, claimed: false, refunded: true, preimage: zero32 },
    }),
    status_age_s: 45,
    status_text: [
      "[alice] tick exit 0 at 18:25:14",
      'noid: tip 281108 instance {"amount_micronoid": 10000000, "creation_id": 737344, "slot_index": 9705979} matches True pending 0 confirmed null tracked_pending None',
      `eth : latest 1416 finalized 1416 ts 1793816708 lock null claimed null pending_preimage None refunded {'block_number': 1320, 'lock_id': '${lockId2}', 'tx_hash': '${refundTx2}'}`,
      "events: []",
      'ACTION: {"action": "wait", "reason": "reveal cutoff passed; keeping the secret and waiting for D"}',
      'notes: ["not revealing: (I2) reveal cutoff passed: now 1793816714 > T_reveal - M_A = 1793813678; the reveal must not be broadcast"]',
      "applied: True phase_after: lock_final",
      "",
    ].join("\n"),
  };

  fs.writeFileSync(path.join(outDir, "run-1.json"), JSON.stringify(run1, null, 2) + "\n");
  fs.writeFileSync(path.join(outDir, "run-2.json"), JSON.stringify(run2, null, 2) + "\n");
  process.stdout.write("wrote mock/run-1.json and mock/run-2.json\n");
}

if (require.main === module) main();
module.exports = { main };
