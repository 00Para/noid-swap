"use strict";
// A complete, valid run.json object for the step tests (spec section 6): every key, in the table's order. Not a test file.
// `makeSettings(overrides)` returns a frozen copy with the overrides applied; the overrides are NOT validated (a test may need an invalid mix on purpose).
const { decodeBech32m } = require("../../lib/bech32");

const CHARSET = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";
const GEN = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];

function polymod(values) {
  let chk = 1;
  for (const v of values) {
    const top = chk >>> 25;
    chk = ((chk & 0x1ffffff) << 5) ^ v;
    for (let i = 0; i < 5; i++) if ((top >>> i) & 1) chk ^= GEN[i];
  }
  return chk >>> 0;
}

/** A Parano1d address (bech32m, HRP o) of 32 bytes: `byte` repeated, for fixtures. */
function noidAddress(byte) {
  const bytes = Array(32).fill(byte);
  const data = [];
  let acc = 0;
  let bits = 0;
  for (const b of bytes) {
    acc = (acc << 8) | b;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      data.push((acc >> bits) & 31);
    }
    acc &= (1 << bits) - 1;
  }
  if (bits > 0) data.push((acc << (5 - bits)) & 31);
  const hrpExp = [0x6f >> 5, 0, 0x6f & 31];
  const mod = polymod([...hrpExp, ...data, 0, 0, 0, 0, 0, 0]) ^ 0x2bc830a3;
  const check = [];
  for (let i = 0; i < 6; i++) check.push((mod >>> (5 * (5 - i))) & 31);
  return `o1${[...data, ...check].map((v) => CHARSET[v]).join("")}`;
}

const ALICE_NOID = noidAddress(0xa1);
const BOB_NOID = noidAddress(0xb2);
const NOID_PAYOUT = noidAddress(0xc3);
for (const a of [ALICE_NOID, BOB_NOID, NOID_PAYOUT]) if (!decodeBech32m(a).ok) throw new Error("the fixture address does not decode");

const ALICE_ETH = `0x${"a1".repeat(20)}`;
const BOB_ETH = `0x${"b2".repeat(20)}`;
const ETH_PAYOUT = `0x${"c3".repeat(20)}`;
const CONTRACT = `0x${"d4".repeat(20)}`;

const ORDER = ["v", "run_id", "role", "profile", "chain_id", "contract", "lock_kind", "variant", "contract_version", "amount_micronoid", "amount_wei", "alice_noid", "bob_noid", "alice_eth", "bob_eth", "noid_payout", "eth_payout", "noid_rpc", "noid_rpc2", "noid_rpc2_remote", "eth_rpc2_remote", "single_node_ok", "eth_rpc", "eth_rpc2", "rpc_timeout_s", "gas_price_gwei", "priority_fee_gwei", "deploy_block", "eth_start_margin", "hc_lead", "lock_precheck_timeout_s", "handover", "alert_url"];

function makeSettings(overrides = {}) {
  const base = {
    v: 1,
    run_id: "0123456789abcdef0123456789abcdef",
    role: "alice",
    profile: "sepolia",
    chain_id: 11155111,
    contract: CONTRACT,
    lock_kind: "poseidon",
    variant: "raw",
    contract_version: 1,
    amount_micronoid: "5000000",
    amount_wei: "1000000000000000",
    alice_noid: ALICE_NOID,
    bob_noid: BOB_NOID,
    alice_eth: ALICE_ETH,
    bob_eth: BOB_ETH,
    noid_payout: NOID_PAYOUT,
    eth_payout: ETH_PAYOUT,
    noid_rpc: "http://127.0.0.1:9601",
    noid_rpc2: null,
    noid_rpc2_remote: false,
    eth_rpc2_remote: false,
    single_node_ok: false,
    eth_rpc: "https://ethereum-sepolia-rpc.publicnode.com",
    eth_rpc2: null,
    rpc_timeout_s: 60,
    gas_price_gwei: null,
    priority_fee_gwei: null,
    deploy_block: null,
    eth_start_margin: 2400,
    hc_lead: 50,
    lock_precheck_timeout_s: null,
    handover: null,
    alert_url: null,
  };
  const o = { ...base, ...overrides };
  const out = {};
  for (const k of ORDER) out[k] = o[k];
  for (const k of Object.keys(o)) if (!ORDER.includes(k)) throw new Error(`makeSettings: unknown key ${k}`);
  return Object.freeze(out);
}

module.exports = { makeSettings, noidAddress, ALICE_NOID, BOB_NOID, NOID_PAYOUT, ALICE_ETH, BOB_ETH, ETH_PAYOUT, CONTRACT, ORDER };
