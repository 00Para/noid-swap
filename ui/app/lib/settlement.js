"use strict";
/*
 * R7, "done only when the coins are in your own address": the facts of the done card, read from what the program already wrote. READ-ONLY: it sends nothing, starts no step, and feeds no
 * step. It reads the swap's audit log, the report files of the wallet steps in the swap's folder, the sweep markers, and (once per transaction, kept by hash) the receipt of each of the
 * role's own Ethereum transactions from the swap's own Ethereum node.
 *
 *   createSettlement({ now?, readReceipt? }) -> { view(i), settledNote(i), receipts }
 *     view(i)         i = { dir, role, settings, audit, run, marker(name), walletStatus }   -> the object of `program.settlement` in /api/run
 *     settledNote(i)  the audit text to write once when the swap reached `done`, or null (already written, or not done): "settled at ISO" or "settled at: time not known"
 *
 * The Ethereum fee of each of the role's own transactions is gasUsed x effectiveGasPrice from its receipt; a sweep counts the same way (its gas limit is the node's
 * estimate plus a margin since 2026-11-26, so a fixed 21,000 x cap no longer describes it; the small part of the limit that was not used stays in the swap key). The NOID fee is the `fee_micronoid` of the report files of the funding, the recovery and the sweep (Alice) or of the claim (Bob). A figure that is not
 * known is not shown: `fees` is null until every part is known, and `receipts_pending` says how many are still being read. A time is never guessed.
 * Each receipt's fee is kept after its first read in `settlement.json` in the swap's folder (written beside and renamed over, owner-only; read before the node is asked again), so a restart does not
 * send the swap's transaction hashes to the endpoint again. The node is asked without following a redirect, and its answer is read at most 64 KiB.
 */

const fs = require("fs");
const path = require("path");
const L = require("./launchfacts");
const { phaseChanges } = require("./looptext");

const TX = /^0x[0-9a-f]{64}$/;
const OWN_ETH_STEPS = {
  alice: new Set(["send-reveal", "send-reveal-replace", "send-sweep-eth-alice"]),
  bob: new Set(["send-lock", "send-refund-eth", "send-refund-eth-replace", "send-sweep-eth-bob"]),
};
const SWEEP_ID = { alice: "send-sweep-eth-alice", bob: "send-sweep-eth-bob" };
const FIRST_STEP = { alice: "send-fund", bob: "send-lock" };
const SETTLED_RE = /^settled at (\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z)$/;
const SETTLED_UNKNOWN = "settled at: time not known";
const RETRY_MS = 60 * 1000;
const RECEIPT_TIMEOUT_MS = 10000;
const MAX_REPORT_BYTES = 1048576;
const MAX_FILES = 400;
const MAX_ANSWER_BYTES = 64 * 1024; // a receipt answer is a few hundred bytes
const CACHE_FILE = "settlement.json";
const MAX_CACHE_BYTES = 64 * 1024;

const hex = (x) => (typeof x === "string" && /^0x[0-9a-fA-F]{1,64}$/.test(x) ? BigInt(x) : null);

/** The body of a response as text, at most `max` bytes: a longer body is an error (checked on the declared length and again while reading). */
async function readLimited(r, max) {
  const declared = Number(r.headers && typeof r.headers.get === "function" ? r.headers.get("content-length") : NaN);
  if (Number.isFinite(declared) && declared > max) throw new Error("answer too large");
  if (!r.body || typeof r.body.getReader !== "function") {
    const t = await r.text();
    if (Buffer.byteLength(t) > max) throw new Error("answer too large");
    return t;
  }
  const reader = r.body.getReader();
  const chunks = [];
  let n = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    n += value.length;
    if (n > max) {
      try {
        await reader.cancel();
      } catch {
        /* closing */
      }
      throw new Error("answer too large");
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks).toString("utf8");
}

/** The kept fees of a swap's folder: Map hash -> fee (bigint). A file that is not a plain small file of the agreed shape is read as empty. Never throws. */
function readCache(dir) {
  const out = new Map();
  try {
    const file = path.join(dir, CACHE_FILE);
    const st = fs.lstatSync(file);
    if (!st.isFile() || st.isSymbolicLink() || st.size > MAX_CACHE_BYTES) return out;
    const j = JSON.parse(fs.readFileSync(file, "utf8"));
    if (!j || typeof j !== "object" || j.v !== 1 || !j.fees || typeof j.fees !== "object" || Array.isArray(j.fees)) return out;
    for (const [h, f] of Object.entries(j.fees)) if (TX.test(h) && typeof f === "string" && /^[0-9]{1,40}$/.test(f)) out.set(h, BigInt(f));
  } catch {
    /* no kept fees */
  }
  return out;
}

/** Keeps `fees` (Map hash -> bigint) in the folder: written beside and renamed over, owner-only. Never throws; a failed write only means the node is asked again after a restart. */
function writeCache(dir, fees) {
  try {
    const obj = { v: 1, fees: {} };
    for (const [h, f] of fees) obj.fees[h] = f.toString();
    const tmp = path.join(dir, `${CACHE_FILE}.tmp-${process.pid}`);
    fs.writeFileSync(tmp, `${JSON.stringify(obj)}
`, { mode: 0o600 });
    fs.renameSync(tmp, path.join(dir, CACHE_FILE));
  } catch {
    /* tried again at the next read */
  }
}

/** The default receipt reader: eth_getTransactionReceipt on the swap's own node (the one run.json names). Answers { fee_wei } or null (not mined yet); throws on a failure. */
async function fetchReceipt(rpcUrl, hash) {
  if (typeof rpcUrl !== "string" || !/^https?:\/\//.test(rpcUrl) || typeof fetch !== "function") throw new Error("no node");
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), RECEIPT_TIMEOUT_MS);
  try {
    // a redirect is an error: the hash is never sent on to a host the endpoint did not name
    const r = await fetch(rpcUrl, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_getTransactionReceipt", params: [hash] }), signal: ac.signal, redirect: "error" });
    if (!r.ok) throw new Error("node answered an error");
    const j = JSON.parse(await readLimited(r, MAX_ANSWER_BYTES));
    if (!j || typeof j !== "object" || j.error) throw new Error("node refused");
    const rc = j.result;
    if (rc === null || rc === undefined) return null;
    const gas = hex(rc.gasUsed);
    const price = hex(rc.effectiveGasPrice);
    if (gas === null || price === null || rc.status !== "0x1") throw new Error("receipt not usable");
    return { fee_wei: (gas * price).toString() };
  } finally {
    clearTimeout(timer);
  }
}

/** The role's own Ethereum transactions of the audit log: the `tx` of the clean end lines of lock, reveal, refund and sweep, in order, without duplicates. */
function ethTxs(records, role) {
  const out = [];
  for (const r of records) {
    if (!r || r.phase !== "end" || !OWN_ETH_STEPS[role].has(r.action) || typeof r.tx !== "string" || !TX.test(r.tx)) continue;
    if (!/^ok \(exit 0\)/.test(String(r.result || ""))) continue;
    if (!out.some((x) => x.hash === r.tx)) out.push({ hash: r.tx, sweep: r.action === SWEEP_ID[role], at: r.t });
  }
  return out;
}

function readJson(file) {
  try {
    const st = fs.lstatSync(file);
    if (!st.isFile() || st.isSymbolicLink() || st.size > MAX_REPORT_BYTES) return null;
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

/**
 * The NOID fees of the run folder's report files, in micro-NOID: the funding, the recovery and the leftover sweep (Alice: `wallet-fund-*`, `wallet-recover-*`, `wallet-sweep-noid-*`; no dry
 * run) or the claim (Bob: `claim-*.out` with `submitted: true`). A transaction counts once (its txid), even when a rerun reported it again.
 * @returns {{micro:bigint, known:boolean}} `known` is false when no sent transaction has a fee yet, or one has none.
 */
function noidFeeOf(dir, role) {
  let names = [];
  try {
    names = fs.readdirSync(dir).slice(0, 5000);
  } catch {
    return { micro: 0n, known: false };
  }
  const seen = new Map(); // txid -> fee (bigint) | null
  let n = 0;
  let any = false;
  if (role === "alice") {
    for (const name of names.sort()) {
      if (!/^wallet-(?:fund|recover|sweep-noid)-(?!dry-)[0-9A-Za-z]+\.json$/.test(name)) continue;
      if (++n > MAX_FILES) break;
      const j = readJson(path.join(dir, name));
      if (!j || typeof j !== "object" || (j.outcome !== "sent" && j.outcome !== "done")) continue;
      const tx = typeof j.txid === "string" && /^[0-9a-f]{64}$/.test(j.txid) ? j.txid : name;
      const fee = Number.isSafeInteger(j.fee_micronoid) && j.fee_micronoid >= 0 ? BigInt(j.fee_micronoid) : null;
      if (!seen.has(tx) || (seen.get(tx) === null && fee !== null)) seen.set(tx, fee);
      any = true;
    }
  } else {
    for (const name of names.sort()) {
      if (!/^claim-[0-9A-Za-z]+\.out$/.test(name)) continue;
      if (++n > MAX_FILES) break;
      const j = readJson(path.join(dir, name));
      if (!j || typeof j !== "object" || j.submitted !== true || !j.plan || typeof j.plan !== "object") continue;
      const tx = typeof j.plan.txid === "string" && /^[0-9a-f]{64}$/.test(j.plan.txid) ? j.plan.txid : name;
      const fee = Number.isSafeInteger(j.plan.fee_micronoid) && j.plan.fee_micronoid >= 0 ? BigInt(j.plan.fee_micronoid) : null;
      if (!seen.has(tx) || (seen.get(tx) === null && fee !== null)) seen.set(tx, fee);
      any = true;
    }
  }
  if (!any) return { micro: 0n, known: false };
  let sum = 0n;
  for (const f of seen.values()) {
    if (f === null) return { micro: 0n, known: false };
    sum += f;
  }
  return { micro: sum, known: true };
}

const parseT = (iso) => {
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : null;
};

/** The time the loop history changed to `done` (ms), or null when that change is not in the tail. */
function doneTimeFromLoop(run, role) {
  const r = run && run.roles ? run.roles[role] : null;
  const entries = r && r.loop && Array.isArray(r.loop.entries) ? r.loop.entries : [];
  const ch = phaseChanges(entries).filter((c) => c.to === "done");
  if (!ch.length) return null;
  const time = String(ch[ch.length - 1].time || "");
  const mtime = r && typeof r.loop_mtime === "number" ? r.loop_mtime * 1000 : null;
  if (/^\d{4}-\d{2}-\d{2}T/.test(time)) return parseT(time);
  const m = /^(\d{2}):(\d{2}):(\d{2})$/.exec(time);
  if (!m || mtime === null) return null;
  const d = new Date(mtime);
  d.setHours(Number(m[1]), Number(m[2]), Number(m[3]), 0);
  let t = d.getTime();
  if (t > mtime + 120000) t -= 86400000;
  return t;
}

function createSettlement(o = {}) {
  const now = typeof o.now === "function" ? o.now : Date.now;
  const readReceipt = typeof o.readReceipt === "function" ? o.readReceipt : fetchReceipt;
  const receipts = new Map(); // hash -> { state: "pending"|"ok"|"fail"|"unmined", fee, retryAt }

  function ask(rpc, hash, dir) {
    let e = receipts.get(hash);
    if (e && (e.state === "ok" || e.state === "pending")) return e;
    if (e && now() < e.retryAt) return e;
    // the fee kept after the first read: no new request
    if (typeof dir === "string" && dir) {
      const kept = readCache(dir).get(hash);
      if (kept !== undefined) {
        e = { state: "ok", fee: kept, retryAt: 0 };
        receipts.set(hash, e);
        return e;
      }
    }
    e = { state: "pending", fee: null, retryAt: 0 };
    receipts.set(hash, e);
    Promise.resolve()
      .then(() => readReceipt(rpc, hash))
      .then(
        (r) => {
          if (r && typeof r.fee_wei === "string" && /^[0-9]{1,40}$/.test(r.fee_wei)) {
            Object.assign(e, { state: "ok", fee: BigInt(r.fee_wei) });
            if (typeof dir === "string" && dir) {
              const kept = readCache(dir);
              kept.set(hash, e.fee);
              writeCache(dir, kept);
            }
          } else Object.assign(e, { state: "unmined", retryAt: now() + RETRY_MS });
        },
        () => Object.assign(e, { state: "fail", retryAt: now() + RETRY_MS }),
      );
    return e;
  }

  function view(i) {
    const out = { state: "none", complete: false, sweep_done: false, sweep_sent: false, fees: null, receipts_pending: 0, receipts_failed: false, time_min: null, settled_at: null, left_wei: null };
    try {
      const role = i.role;
      if (role !== "alice" && role !== "bob") return out;
      const records = i.audit.all();
      const markerName = `wallet-swept-eth-${role}.marker`;
      out.sweep_done = !!(i.marker && i.marker(markerName));
      // the sweep is started and has no clean end yet: "sending to your own address now"
      const sweepRecs = records.filter((r) => r && r.action === SWEEP_ID[role]);
      const last = sweepRecs[sweepRecs.length - 1];
      out.sweep_sent = !out.sweep_done && !!last && (last.phase === "start" || (last.phase === "end" && !/^refused, nothing sent\b/.test(String(last.result || ""))));
      // time: from the first deposit step to the settled note
      const start = records.find((r) => r && r.action === FIRST_STEP[role] && r.phase === "start");
      let settledMs = null;
      for (const r of records) {
        const m = r && r.action === "settlement" && r.phase === "note" ? SETTLED_RE.exec(String(r.result || "")) : null;
        if (m) settledMs = parseT(m[1]);
      }
      if (settledMs !== null) out.settled_at = new Date(settledMs).toISOString().replace(/\.\d{3}Z$/, "Z");
      const startMs = start ? parseT(start.t) : null;
      if (startMs !== null && settledMs !== null && settledMs >= startMs) out.time_min = Math.max(1, Math.round((settledMs - startMs) / 60000));
      const phase = i.run && i.run.roles && i.run.roles[role] && i.run.roles[role].tick ? i.run.roles[role].tick.phase_after : null;
      if (phase !== "done") return out;
      out.state = "reading";
      out.complete = role === "bob" ? true : out.sweep_done;
      // fees
      const s = i.settings;
      const txs = ethTxs(records, role);
      const rpc = s && s.eth_rpc;
      let pending = 0;
      let ethFee = 0n;
      for (const t of txs) {
        const e = ask(rpc, t.hash, i.dir);
        if (e.state === "ok") ethFee += e.fee;
        else {
          pending++;
          if (e.state === "fail") out.receipts_failed = true;
        }
      }
      out.receipts_pending = pending;
      const noid = noidFeeOf(i.dir, role);
      // every part known: the receipts are read, the NOID fee is known and, for the role's own sweep, it has been made
      if (pending === 0 && noid.known && out.sweep_done && s) {
        const bp = L.share(ethFee, s.amount_wei, noid.micro, s.amount_micronoid);
        out.fees = { eth_wei: ethFee.toString(), noid_micro: noid.micro.toString(), share_bp: bp };
        out.state = "ready";
      }
      // what is left in the swap's key after the sweep: only from a wallet status read after it
      const ws = i.walletStatus || null;
      const sweepEnd = sweepRecs.filter((r) => r.phase === "end" && /^ok \(exit 0\)/.test(String(r.result || ""))).pop();
      const sweepAt = sweepEnd ? parseT(sweepEnd.t) : null;
      if (out.sweep_done && ws && ws.ok === true && ws.eth && typeof ws.at_ms === "number" && sweepAt !== null && ws.at_ms > sweepAt && /^[0-9]{1,40}$/.test(String(ws.eth.balance_wei)) && BigInt(ws.eth.balance_wei) > 0n) out.left_wei = String(ws.eth.balance_wei);
    } catch {
      /* what could not be read stays out of the answer */
    }
    return out;
  }

  /** The audit text to write once when the swap is `done`: the time of the loop history's change to done, or that the time is not known. null when it is already written or the swap is not done. */
  function settledNote(i) {
    try {
      const role = i.role;
      const phase = i.run && i.run.roles && i.run.roles[role] && i.run.roles[role].tick ? i.run.roles[role].tick.phase_after : null;
      if (phase !== "done") return null;
      for (const r of i.audit.all()) if (r && r.action === "settlement" && r.phase === "note" && (SETTLED_RE.test(String(r.result || "")) || r.result === SETTLED_UNKNOWN)) return null;
      const t = doneTimeFromLoop(i.run, role);
      if (t === null) return SETTLED_UNKNOWN;
      return `settled at ${new Date(t).toISOString().replace(/\.\d{3}Z$/, "Z")}`;
    } catch {
      return null;
    }
  }

  return { view, settledNote, receipts };
}

module.exports = { createSettlement, ethTxs, noidFeeOf, doneTimeFromLoop, fetchReceipt, readLimited, readCache, CACHE_FILE, SETTLED_UNKNOWN };
