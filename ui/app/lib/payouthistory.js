"use strict";
/*
 * R3, the history of the person's own payout addresses: the server's side of its views. The history itself is the desktop's (`program.payoutHistory`, a sealed file in the program's data
 * folder; the contract is in the build spec section 4.2). This module only asks it, checks what comes back, and shapes the data the pages draw. Nothing here is read by a step: the
 * history is a check against slips, not a gate, and not against malware on this computer.
 *
 *   ownAddresses(settings)                -> [{ kind: "noid"|"eth", addr }]   the person's own addresses of a swap (run.json), without duplicates
 *   record(program, runId, settings)      -> Promise<void>                    when the swap is done (swapset.noteSettled); never throws, whatever the storage does
 *   listView(program)                     -> Promise<{ state, items }>        for GET /api/settings: [{ kind, addr, first_at, count }]
 *   runView(program, runId, settings)     -> Promise<{ state, map }>          for the approval: { [addr]: { first_at, count } }, the count without this run
 *
 * state is "none" (the program has no history: the terminal console; nothing is shown), "ok", "unreadable" or "locked". An unreadable or locked history makes every address show as new:
 * the map is empty then. Anything the program's object returns that is not of the agreed shape is dropped; an answer that is not an object is "unreadable".
 */

const { groups } = require("./launchfacts");

const STATES = new Set(["ok", "unreadable", "locked"]);
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;
const MAX_ITEMS = 200;

const isEth = (a) => /^0x/.test(a);
/** The key addresses are compared by: exact for o1..., lower case for 0x... (the stored form is the first one recorded). */
const keyOf = (a) => (isEth(a) ? a.toLowerCase() : a);

/** The person's own addresses of a swap's run.json: Alice's NOID and Ethereum payouts; Bob's own NOID address, his Ethereum payout and (when given) his NOID payout. */
function ownAddresses(settings) {
  const out = [];
  const seen = new Set();
  const add = (kind, addr) => {
    if (typeof addr !== "string" || groups(addr) === null) return;
    const k = `${kind}|${keyOf(addr)}`;
    if (seen.has(k)) return;
    seen.add(k);
    out.push({ kind, addr });
  };
  if (!settings || typeof settings !== "object") return out;
  if (settings.role === "alice") {
    add("noid", settings.noid_payout);
    add("eth", settings.eth_payout);
  } else if (settings.role === "bob") {
    add("noid", settings.bob_noid);
    add("eth", settings.eth_payout);
    add("noid", settings.noid_payout);
  }
  return out;
}

const has = (program) => !!program && !!program.payoutHistory && typeof program.payoutHistory === "object";

async function record(program, runId, settings) {
  try {
    if (!has(program) || typeof program.payoutHistory.record !== "function") return;
    const entries = ownAddresses(settings);
    if (!entries.length) return;
    await program.payoutHistory.record(runId, entries);
  } catch {
    /* a history that cannot be written never undoes the swap */
  }
}

const goodStat = (x) => !!x && typeof x === "object" && typeof x.first_at === "string" && ISO.test(x.first_at) && Number.isSafeInteger(x.count) && x.count >= 0 && x.count <= 1000000;

async function listView(program) {
  if (!has(program) || typeof program.payoutHistory.list !== "function") return { state: "none", items: [] };
  let r;
  try {
    r = await program.payoutHistory.list();
  } catch {
    return { state: "unreadable", items: [] };
  }
  if (!r || typeof r !== "object" || !STATES.has(r.state)) return { state: "unreadable", items: [] };
  if (r.state !== "ok") return { state: r.state, items: [] };
  const items = [];
  for (const it of Array.isArray(r.items) ? r.items.slice(0, MAX_ITEMS) : []) {
    if (!it || typeof it !== "object" || (it.kind !== "noid" && it.kind !== "eth") || typeof it.addr !== "string" || groups(it.addr) === null || !goodStat(it) || it.count < 1) continue;
    items.push({ kind: it.kind, addr: it.addr, first_at: it.first_at, count: it.count });
  }
  return { state: "ok", items };
}

async function runView(program, runId, settings) {
  if (!has(program) || typeof program.payoutHistory.forRun !== "function") return { state: "none", map: {} };
  const addrs = ownAddresses(settings).map((e) => e.addr);
  if (!addrs.length) return { state: "ok", map: {} };
  let r;
  try {
    r = await program.payoutHistory.forRun(runId, addrs);
  } catch {
    return { state: "unreadable", map: {} };
  }
  if (!r || typeof r !== "object" || !STATES.has(r.state)) return { state: "unreadable", map: {} };
  if (r.state !== "ok") return { state: r.state, map: {} };
  const got = r.map && typeof r.map === "object" && !Array.isArray(r.map) ? r.map : {};
  const map = {};
  for (const a of addrs) {
    const hit = Object.prototype.hasOwnProperty.call(got, a) ? got[a] : Object.keys(got).find((k) => keyOf(k) === keyOf(a)) !== undefined ? got[Object.keys(got).find((k) => keyOf(k) === keyOf(a))] : undefined;
    if (hit !== undefined && goodStat(hit) && hit.count >= 1) map[a] = { first_at: hit.first_at, count: hit.count };
  }
  return { state: "ok", map };
}

module.exports = { ownAddresses, record, listView, runView, keyOf, MAX_ITEMS };
