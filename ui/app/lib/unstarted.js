"use strict";
/*
 * A swap that never started (R23-3, run 23): before the person's approval the program's read loop only records the chains' facts (`tick --apply --observe-only` for Bob, a plain read-only tick for
 * Alice), so nothing writes "aborted" into the swap file when the window to start passes. The file stays at `created` or `received` and the page kept saying "waiting".
 *
 * This module reads what the last tick already says and decides one thing for the page: has the window to start closed for good, with nothing of this side's on any chain? Display only: it sends
 * nothing, starts no step, records nothing, and no gate reads it. The engine stays the one that decides; when its loop records the abort the swap file says it too and this module has nothing to add.
 *
 *   unstarted(i) -> null | { ended: true, holds: "nothing" | "funds" | "unknown", held: { noid_micronoid, eth_wei } | null, reason }
 *
 * The facts, all of them from the tick, the swap's folder and the program's own records (nothing is counted or invented here):
 *   - the file is still before the person's first step: Alice `created`, Bob `received`, `funded` or `funding_final` (the phases in which the person has acted on no chain);
 *   - the tick's own action is an abort that cannot turn back (the heights of the engine's own texts; `isHeightAbort` of lib/firststeps.js, the rule the watch loop already uses): Alice "too late to
 *     fund", Bob "last lock height N passed before Alice's funding was final" or "not locking: ... is past ...";
 *   - nothing is held back or open: no intent held or recorded, no instance at the contract root seen from Alice's side, no Ethereum lock of this swap seen from Bob's, no funding marker, no send of
 *     the first step in the program's audit or in Bob's lock record, no spend that may have been sent;
 *   - the approval is not in force (with it the apply loop records the abort within two readings, as before);
 *   - the tick is fresh (at most TICK_FRESH_S old, and not from the future by more than a clock's skew): a stale tick says nothing about "nothing is held", so the card keeps its "needs a look" and its
 *     stale line;
 *   - the audit of the swap reads clean (every line is JSON and the chain of its lines verifies): a line that cannot be read could hide the send that makes it not an end;
 *   - the tick carries no alarm and no disagreement of the two nodes: such a swap stays on the page as the engine's own warning, not under "Ended".
 * `holds` says what the swap's own wallet or key holds: "nothing" only from a clean, fresh status of its own addresses with a zero balance; "funds" when any balance is there; "unknown" when no such status
 * is available. Only "nothing" is shown as quietly ended; the others stay on the page as a "needs a look" with the amounts and the way back.
 */
const { isHeightAbort } = require("./firststeps");

const STATUS_FRESH_S = 300;
const TICK_FRESH_S = 120; // the loop ticks about every 30 s; the page and the engine call a tick older than this stale (lib/viewmodel.js TICK_STALE_S)
const SKEW_S = 30; // a clock may be this far off before a reading is taken for one from the future
const BEFORE = { alice: new Set(["created"]), bob: new Set(["received", "funded", "funding_final"]) };

/** Did the program ever start a send of this step in this audit, one that may have been sent? Same reading as `lockEverSentIn` of lib/stepexec.js: a refusal that sent nothing does not count. */
function sendStartedIn(records, id) {
  let open = false;
  for (const r of Array.isArray(records) ? records : []) {
    if (!r || typeof r !== "object" || r.action !== id) continue;
    if (r.phase === "start") {
      if (open) return true;
      open = true;
    } else if (r.phase === "end" && open) {
      open = false;
      if (!/^refused, nothing sent/.test(String(r.result || ""))) return true;
    }
  }
  return open;
}

const big = (x) => {
  try {
    return typeof x === "string" && /^[0-9]{1,40}$/.test(x) ? BigInt(x) : null;
  } catch {
    return null;
  }
};

/** What the swap's own wallet or key holds, from the role's wallet status as the page gets it (`walletView().roles[role].status`). */
function holdings(role, status) {
  if (!status || status.ok !== true || status.show !== true || !status.eth) return { holds: "unknown", held: null };
  if (typeof status.age_s !== "number" || !Number.isFinite(status.age_s) || status.age_s > STATUS_FRESH_S || status.age_s < -SKEW_S) return { holds: "unknown", held: null };
  const eth = big(status.eth.balance_wei);
  const noid = role === "alice" ? (status.noid ? big(status.noid.plain_micronoid) : null) : 0n;
  if (eth === null || noid === null) return { holds: "unknown", held: null };
  if (eth === 0n && noid === 0n) return { holds: "nothing", held: null };
  return { holds: "funds", held: { noid_micronoid: role === "alice" && noid > 0n ? String(noid) : null, eth_wei: eth > 0n ? String(eth) : null } };
}

/**
 * Does the tick carry an alarm, or do the two nodes disagree? The engine's own notes (ALERT, ANOMALY, ALARM), its action reason, the instance counts and tips of the two Parano1d nodes, the chain
 * time of the two Ethereum nodes and the producer cross-check. Such a tick is shown as the engine shows it; this module does not call the swap quietly ended.
 */
function alarmed(tick) {
  const noid = (tick && tick.noid) || {};
  const eth = (tick && tick.eth) || {};
  const text = (x) => String(x === null || x === undefined ? "" : x);
  for (const n of Array.isArray(tick && tick.notes) ? tick.notes : []) if (/^\s*ALERT:|ANOMALY|ALARM/.test(text(n))) return true;
  const reason = tick && tick.action && typeof tick.action.reason === "string" ? tick.action.reason : "";
  if (/ANOMALY|ALARM/.test(reason)) return true;
  const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);
  if (noid.second && typeof noid.second === "object") {
    if (num(noid.second.tip) !== null && num(noid.tip) !== null && Math.abs(noid.second.tip - noid.tip) > 2) return true;
    if (noid.second.instance_count !== undefined && noid.instance_count !== undefined && noid.second.instance_count !== noid.instance_count) return true;
  }
  if (eth.second && typeof eth.second === "object" && num(eth.second.latest_timestamp) !== null && num(eth.latest_timestamp) !== null && Math.abs(eth.second.latest_timestamp - eth.latest_timestamp) > 120) return true;
  const ps = noid.producers && typeof noid.producers === "object" && noid.producers.second && typeof noid.producers.second === "object" ? noid.producers.second.state : null;
  if (ps === "differs" || ps === "producer_differs" || ps === "sampled_differs") return true;
  const mk = noid.producer_marker && typeof noid.producer_marker === "object" ? noid.producer_marker.state : null;
  if (typeof mk === "string" && /differ/.test(mk)) return true;
  return false;
}

/** The cheap part: is the file before the person's first step and does the tick show an abort that cannot turn back? (The caller reads the rest only when this is true.) */
function candidate(role, tick) {
  try {
    return (role === "alice" || role === "bob") && !!tick && typeof tick === "object" && BEFORE[role].has(tick.phase_after) && isHeightAbort(role, tick);
  } catch {
    return false;
  }
}

/**
 * i: { role, tick, tickAgeS, approvalOn, fundedMarker, lockRecord, audit, auditOk, mayHaveSent, status }
 *   tick          the role's last tick (the whole JSON), or null
 *   tickAgeS      the age of that tick in seconds (its own clock, else its file's time); a missing age is not fresh
 *   approvalOn    the autopilot's approval of this role is in force
 *   fundedMarker  Alice: the funding's marker exists in the swap's folder
 *   lockRecord    Bob: his lock record `FILE.lock-sent` exists beside his swap file
 *   audit         the program's audit records of this swap (array), or null when they cannot be read
 *   auditOk       the audit's own verification (`verify().ok`); anything but true is not clean
 *   mayHaveSent   the number of spend steps whose last run may have been sent
 *   status        the role's wallet status as the page gets it, or null
 */
function unstarted(i) {
  try {
    if (!i || (i.role !== "alice" && i.role !== "bob")) return null;
    const role = i.role;
    const tick = i.tick;
    if (!tick || typeof tick !== "object" || !BEFORE[role].has(tick.phase_after)) return null;
    if (!isHeightAbort(role, tick)) return null;
    // the abort of a role is about ITS start: the engine's own "last lock height" and "too late to fund" texts, not the recovery branch of a contract Alice funded
    const reason = tick.action && typeof tick.action.reason === "string" ? tick.action.reason.slice(0, 300) : null;
    if (i.approvalOn === true) return null;
    // a stale tick (or one with no age, or one from the future) cannot say that nothing is held: the page keeps its stale line and "needs a look"
    if (typeof i.tickAgeS !== "number" || !Number.isFinite(i.tickAgeS) || i.tickAgeS > TICK_FRESH_S || i.tickAgeS < -SKEW_S) return null;
    if (alarmed(tick)) return null;
    if (tick.intent && tick.intent.status && tick.intent.status !== "none") return null;
    if (i.fundedMarker === true || i.lockRecord === true) return null;
    if (!Array.isArray(i.audit) || i.auditOk !== true) return null; // the audit cannot be read, or does not verify: not shown as ended
    if (i.audit.some((r) => !r || typeof r !== "object" || r.corrupt === true)) return null; // one line that is not JSON could be the send
    if (sendStartedIn(i.audit, role === "alice" ? "send-fund" : "send-lock")) return null;
    if (Number(i.mayHaveSent) > 0) return null;
    // nothing of this side on a chain: a count that is missing is not a zero
    if (role === "alice") {
      const n = tick.noid;
      if (!n || n.instance_count !== 0 || (n.instance !== null && n.instance !== undefined) || (Array.isArray(n.instances) && n.instances.length)) return null;
    } else {
      const e = tick.eth;
      if (!e || e.lock_count !== 0 || (e.lock !== null && e.lock !== undefined)) return null;
    }
    return { ended: true, ...holdings(role, i.status), reason };
  } catch {
    return null;
  }
}

module.exports = { unstarted, candidate, holdings, sendStartedIn, alarmed, STATUS_FRESH_S, TICK_FRESH_S, SKEW_S };
