"use strict";
/*
 * Parano1d observation (read-only), modelled on swap-cli/src/watch/parano1d.rs
 * but restricted to the console's allowlist: blockCount, getEpochAnchor,
 * estimateFeeDetailed, getObjectInstances, getObjectStatus, getMempoolInfo, getTx.
 * (`getMempoolEntry` is not allowed, so a pending call cannot be attributed to
 * our opening; the mempool size is reported as-is.)
 *
 * Like the Rust watcher, `tip` is raised to the highest height any answer of
 * the poll reflects (the calls are not one snapshot).
 */

const INSTANCE_PAGE = 16;
const FINALITY_BLOCKS = 18; // final iff tip >= inclusion + 18 (the chain's is_final rule)

function normHex(s) {
  return String(s || "").trim().replace(/^0x/i, "").toLowerCase();
}

function num(v, what) {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && /^\d+$/.test(v)) return Number(v);
  throw new Error(`paranoid: ${what}: expected a number, got ${JSON.stringify(v)}`);
}

async function getTxOrNull(rpc, txid) {
  if (!txid) return null;
  const tx = await rpc.call("paranoid_getTx", [txid]);
  if (tx === null || tx === undefined) return { txid, confirmed: false, height: null, block_hash: null, tx_position: null };
  return {
    txid,
    confirmed: true,
    height: num(tx.height, "getTx.height"),
    block_hash: tx.block_hash || null,
    tx_position: tx.tx_position === undefined ? null : tx.tx_position,
  };
}

/**
 * @param rpc  a client with `call(method, params)` (HttpJsonRpc or FixtureRpc, chain "noid")
 * @param swap { opening_hex, fund_txid?, close_txid? }
 * @param clock () => unix seconds
 */
async function observeNoid(rpc, swap, clock = () => Math.floor(Date.now() / 1000)) {
  const observed_at = clock();
  const opening = normHex(swap.opening_hex);
  if (!opening) throw new Error("paranoid: swap has no opening_hex");

  let tip = num(await rpc.call("paranoid_blockCount", []), "blockCount");

  const anchorRaw = await rpc.call("paranoid_getEpochAnchor", []);
  const epoch_anchor = normHex(anchorRaw);
  if (!/^[0-9a-f]{64}$/.test(epoch_anchor)) throw new Error("paranoid: getEpochAnchor: expected 32 bytes of hex");

  const fee = await rpc.call("paranoid_estimateFeeDetailed", [1, 1]);
  const fee_estimate_1_1 = num(fee && fee.fee_micronoid, "estimateFeeDetailed.fee_micronoid");
  const relay_floor =
    fee && fee.breakdown && fee.breakdown.relay_floor !== undefined ? num(fee.breakdown.relay_floor, "relay_floor") : null;

  const page = await rpc.call("paranoid_getObjectInstances", [opening, 0, INSTANCE_PAGE]);
  if (!page || !Array.isArray(page.slots)) throw new Error("paranoid: getObjectInstances: no slots array");
  if (page.height !== undefined) tip = Math.max(tip, num(page.height, "getObjectInstances.height"));
  const live = page.slots.filter((s) => !s.empty);
  const instance = live.length
    ? {
        slot_index: num(live[0].slot_index, "slot_index"),
        creation_id: num(live[0].creation_id, "creation_id"),
        amount_micronoid: num(live[0].value, "value"),
        owner: live[0].owner || null,
      }
    : null;
  const instance_count = live.length;

  let matches_opening = null;
  let active_authority = null;
  let next_call_height = null;
  let object = null;
  if (instance) {
    const st = await rpc.call("paranoid_getObjectStatus", [opening, instance.slot_index]);
    if (!st || typeof st.matches_opening !== "boolean") throw new Error("paranoid: getObjectStatus: no matches_opening");
    matches_opening = st.matches_opening;
    active_authority = st.active_authority || null;
    if (st.tip_height !== undefined) tip = Math.max(tip, num(st.tip_height, "getObjectStatus.tip_height"));
    if (st.next_call_height !== undefined) next_call_height = num(st.next_call_height, "next_call_height");
    const o = st.object || {};
    object = {
      address: o.address || null,
      claim_authority: o.claim_authority || null,
      claim_recipient: o.claim_recipient || null,
      deadline_height: o.deadline_height === undefined ? null : num(o.deadline_height, "deadline_height"),
      max_fee_micronoid: o.max_fee_micronoid === undefined ? null : num(o.max_fee_micronoid, "max_fee"),
      code_id: o.code_id || null,
      state: o.state === undefined ? null : o.state,
    };
  }

  const mp = await rpc.call("paranoid_getMempoolInfo", []);
  const txs = (mp && Array.isArray(mp.txs) && mp.txs) || [];
  const mempool = {
    size: mp && mp.size !== undefined ? num(mp.size, "mempool.size") : txs.length,
    fee_floor: mp && mp.fee_floor !== undefined ? num(mp.fee_floor, "mempool.fee_floor") : null,
    single_page_entries: txs.filter((t) => t.page_count === 1).length,
  };

  const fund_tx = await getTxOrNull(rpc, swap.fund_txid);
  const close_tx = await getTxOrNull(rpc, swap.close_txid);

  const fund_final = fund_tx && fund_tx.confirmed ? tip >= fund_tx.height + FINALITY_BLOCKS : null;
  const close_final = close_tx && close_tx.confirmed ? tip >= close_tx.height + FINALITY_BLOCKS : null;

  return {
    observed_at,
    tip,
    next_call_height: next_call_height === null ? tip + 1 : next_call_height,
    epoch_anchor,
    fee_estimate_1_1,
    relay_floor,
    mempool,
    contract_root: page.address || null,
    instance,
    instance_count,
    matches_opening,
    active_authority,
    object,
    fund_tx,
    fund_final,
    close_tx,
    close_final,
  };
}

module.exports = { observeNoid, normHex, FINALITY_BLOCKS, INSTANCE_PAGE };
