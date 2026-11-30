"use strict";
/*
 * swaps.json loader and the public terms of a swap.
 *
 * A swap entry:
 *   { "id"?, "label", "role": "alice"|"bob",
 *     "object_file": path (the wallet's swap.object.json: contract opening, public),
 *     "bundle_file": path (alice.bundle.json: hashlock, authority, params; public),
 *     "noid_rpc"?: url (default http://127.0.0.1:9601),
 *     "eth": { "rpc", "contract", "lock_id", "from_block"? },
 *     "status_file"?: path to the engine's loop text,
 *     "fund_txid"?, "close_txid"?: Parano1d txids to look up with getTx }
 *
 * Only the object and bundle files are read. A path ending in `.swap.json`
 * (the file that seals the secret) is refused outright.
 */

const fs = require("fs");
const path = require("path");

const DEFAULT_NOID_RPC = "http://127.0.0.1:9601";
const DEFAULT_ETH_RPC = "http://127.0.0.1:8545";

function refuseSecretFile(p, what) {
  const why = require("./secrets").secretPathReason(p);
  if (why) throw new Error(`${what}: refusing to read ${p} (${why})`);
}

function readJson(p, what) {
  refuseSecretFile(p, what);
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch (e) {
    throw new Error(`${what}: cannot read ${p}: ${e.message}`);
  }
}

function slug(s) {
  return String(s)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

function loadConfig(file) {
  const raw = readJson(file, "swaps.json");
  const list = Array.isArray(raw) ? raw : raw.swaps;
  if (!Array.isArray(list)) throw new Error("swaps.json: expected an array or { swaps: [...] }");
  const seen = new Set();
  return list.map((s, i) => {
    const id = s.id || slug(s.label || `swap-${i + 1}`);
    if (seen.has(id)) throw new Error(`swaps.json: duplicate id ${id}`);
    seen.add(id);
    if (s.role !== "alice" && s.role !== "bob") throw new Error(`swaps.json[${id}]: role must be "alice" or "bob"`);
    if (!s.eth || !s.eth.contract || !s.eth.lock_id) throw new Error(`swaps.json[${id}]: eth.contract and eth.lock_id are required`);
    refuseSecretFile(s.object_file, `swaps.json[${id}].object_file`);
    refuseSecretFile(s.bundle_file, `swaps.json[${id}].bundle_file`);
    refuseSecretFile(s.status_file, `swaps.json[${id}].status_file`);
    return {
      id,
      label: s.label || id,
      role: s.role,
      object_file: s.object_file || null,
      bundle_file: s.bundle_file || null,
      noid_rpc: s.noid_rpc || DEFAULT_NOID_RPC,
      eth: {
        rpc: s.eth.rpc || DEFAULT_ETH_RPC,
        contract: String(s.eth.contract).toLowerCase(),
        lock_id: String(s.eth.lock_id).toLowerCase(),
        from_block: s.eth.from_block || 0,
      },
      status_file: s.status_file || null,
      fund_txid: s.fund_txid || null,
      close_txid: s.close_txid || null,
      notes: s.notes || null,
    };
  });
}

/** Public terms from the object file + bundle (no secret in either). */
function termsFrom(object, bundle) {
  const p = (bundle && bundle.params) || {};
  const eth = p.eth || {};
  const o = object || {};
  const terms = {
    variant: p.variant || null,
    amount_micronoid: p.amount_micronoid ?? null,
    max_fee_micronoid: o.max_fee_micronoid ?? p.max_fee_micronoid ?? null,
    h_create: p.h_create ?? null,
    deadline_height: o.deadline_height ?? p.deadline_height ?? null,
    lock_by_height: p.lock_by_height ?? null,
    w_a_s: p.w_a_s ?? null,
    alice_noid: p.alice_noid || null,
    bob_noid: p.bob_noid || o.claim_recipient || null,
    hashlock: bundle && bundle.hashlock ? String(bundle.hashlock).toLowerCase() : null,
    claim_authority: o.claim_authority || (bundle && bundle.claim_authority) || null,
    claim_recipient: o.claim_recipient || null,
    contract_root: o.address || (bundle && bundle.contract_root) || null,
    opening_hex: o.opening_hex || (bundle && bundle.opening_hex) || null,
    code_id: o.code_id || null,
    eth: {
      chain_id: eth.chain_id ?? null,
      contract: eth.contract ? String(eth.contract).toLowerCase() : null,
      code_hash: eth.code_hash || null,
      lock_kind: eth.lock_kind || "sha256",
      amount_wei: eth.amount_wei ?? null,
      alice_receiver: eth.alice_receiver ? String(eth.alice_receiver).toLowerCase() : null,
      bob_sender: eth.bob_sender ? String(eth.bob_sender).toLowerCase() : null,
    },
    checks: [],
  };
  if (object && bundle) {
    if (object.opening_hex && bundle.opening_hex) {
      terms.checks.push({
        name: "object opening = bundle opening",
        ok: String(object.opening_hex).toLowerCase() === String(bundle.opening_hex).toLowerCase(),
      });
    }
    if (object.deadline_height !== undefined && p.deadline_height !== undefined) {
      terms.checks.push({ name: "object deadline = bundle deadline", ok: object.deadline_height === p.deadline_height });
    }
    if (object.claim_authority && bundle.claim_authority) {
      terms.checks.push({ name: "object claim authority = bundle", ok: object.claim_authority === bundle.claim_authority });
    }
    if (object.address && bundle.contract_root) {
      terms.checks.push({ name: "object address = bundle contract root", ok: object.address === bundle.contract_root });
    }
  }
  terms.consistent = terms.checks.every((c) => c.ok);
  return terms;
}

function loadTerms(cfg) {
  const object = cfg.object_file ? readJson(cfg.object_file, `${cfg.id} object_file`) : null;
  const bundle = cfg.bundle_file ? readJson(cfg.bundle_file, `${cfg.id} bundle_file`) : null;
  if (!object && !bundle) throw new Error(`${cfg.id}: neither object_file nor bundle_file is readable`);
  return termsFrom(object, bundle);
}

module.exports = { loadConfig, loadTerms, termsFrom, readJson, refuseSecretFile, DEFAULT_NOID_RPC, DEFAULT_ETH_RPC };
