"use strict";
/*
 * Bob's up-front look at the producer screen (owner decision D2). On Ethereum mainnet Bob's approval carries a statement about the mining share of Parano1d ("One address mined N % ...")
 * and lets his ticks and his lock step pass swap-cli's `--acknowledge-producer-share 650`. That flag waives only a share above the profile's limit (up to the ceiling) and the missing
 * second node when his own node is on this machine; it never waives unreadable or stale headers, a second node that disagrees, a remembered disagreement or a share above the ceiling.
 * So Alice must not be asked to fund a swap whose lock the flag cannot open: Bob's approval is refused up front when the tick he last wrote shows one of those reasons.
 *
 * It reads ONLY structured fields of the tick (`noid.producers`, `noid.producer_marker`, `noid.second_error`, `noid.tip`; swap-cli `watch/producers.rs`, `producer_marker.rs`), never the notes
 * or any free text, and it fails closed: a field that is missing, of another kind or out of range is a refusal that says the reading is not complete, not a pass.
 * The numbers are swap-cli's own (engine.rs MAX_OBSERVATION_AGE_S 120, MAX_NOID_TIP_DIFF 2) and the program's ceiling (swapform-independent: PRODUCER_CEILING_PERMILLE).
 */

const PRODUCER_CEILING_PERMILLE = 650; // the compiled hard maximum of the flag
const MAX_OBSERVATION_AGE_S = 120;
const MAX_TIP_DIFF = 2;
const WINDOW_LONG = 2880; // the production profile's windows (params.rs)
const WINDOW_SHORT = 720;

const isCount = (x) => Number.isSafeInteger(x) && x >= 0;

/** `largest / n` in tenths of a percent, rounded UP (swap-cli prints it the same way), as text "52.7". */
function pctText(largest, n) {
  const tenths = Math.ceil((largest * 1000) / n);
  return `${Math.floor(tenths / 10)}.${tenths % 10}`;
}

/**
 * @param {object|null} tick the last tick Bob's program wrote (a parsed `last-tick-bob.json`)
 * @param {number} nowS now, in Unix seconds
 * @param {{ownNodeIsLoopback?:boolean}} [o] true when Bob's only Parano1d node is on this machine (run.json's noid_rpc is loopback and there is no second node)
 * @returns {{ok:true, share_text:string, share_permille:number}|{ok:false, why:string}}
 */
function producerScreen(tick, nowS, o = {}) {
  const no = (why) => ({ ok: false, why });
  // swap-cli's own verdict first (tick JSON `producer_screen`, producer_gate.rs): when it is there and says the screen is enforced and the
  // acknowledgement cannot open it, the approval is refused whatever the fields below say. The page's own reading below must then pass too.
  const ps = tick && typeof tick === "object" && tick.producer_screen && typeof tick.producer_screen === "object" ? tick.producer_screen : null;
  if (ps && ps.enforced === true && ps.waivable_by_acknowledgement !== true) {
    const WHY = {
      concentrated: `One address mined more of Parano1d's recent blocks than the ${PRODUCER_CEILING_PERMILLE / 10} % this program accepts. Do not start this swap.`,
      disagrees: "The two Parano1d nodes disagree about the producers, or the second one cannot be checked. That cannot be waived.",
      remembered: "The two Parano1d nodes once named different producers or blocks for this swap. That cannot be waived, and this swap cannot be locked: do not start it.",
      one_node: "There is no second Parano1d node, and your node is not on this computer. Give a second node in this swap's settings: the producer check needs it.",
      stale: "The producer reading is out of date. That cannot be waived: wait for the next check.",
    };
    return no(WHY[ps.state] || "The producer reading could not be completed. That cannot be waived: wait for the next check, or fix the node.");
  }
  const noid = tick && typeof tick === "object" && tick.noid && typeof tick.noid === "object" ? tick.noid : null;
  if (!noid) return no("The producer reading is not there yet: wait for the program's next check of the chains, then approve.");
  const m = noid.producer_marker;
  if (m !== undefined && m !== null) {
    if (typeof m !== "object" || m.state !== "absent") return no("The two Parano1d nodes once named different producers or blocks for this swap. That cannot be waived, and this swap cannot be locked: do not start it.");
  }
  if (typeof noid.second_error === "string" && noid.second_error !== "") return no("The second Parano1d node could not be read. That cannot be waived: fix the node, then approve.");
  const p = noid.producers && typeof noid.producers === "object" ? noid.producers : null;
  if (!p) return no("The producer reading is not there yet: wait for the program's next check of the chains, then approve.");
  if (typeof p.error === "string" && p.error !== "") return no("The producer reading could not be completed. That cannot be waived: wait for the next check, or fix the node.");
  if (p.complete !== true || p.window_long !== WINDOW_LONG || p.window_short !== WINDOW_SHORT) return no("The producer reading is not complete yet: wait for the program's next checks, then approve.");
  const w = (x, n) => !!x && typeof x === "object" && x.n === n && isCount(x.largest) && x.largest <= x.n;
  if (!w(p.long, WINDOW_LONG) || !w(p.short, WINDOW_SHORT)) return no("The producer reading is not complete yet: wait for the program's next checks, then approve.");
  const tip = isCount(noid.tip) ? noid.tip : isCount(p.tip) ? p.tip : null;
  if (tip === null || !isCount(p.header_tip) || tip > p.header_tip + MAX_TIP_DIFF) return no("The producer reading is out of date (the headers end below the node's tip). That cannot be waived: wait for the next check.");
  if (!isCount(p.read_at) || Math.abs(nowS - p.read_at) > MAX_OBSERVATION_AGE_S) return no("The producer reading is out of date. That cannot be waived: wait for the next check.");
  const s = p.second && typeof p.second === "object" ? p.second : null;
  const state = s ? s.state : "not_configured";
  if (state === "agrees") {
    if (!isCount(s.sampled) || s.sampled < 1) return no("The second Parano1d node's cross-check recorded no sampled heights. That cannot be waived: wait for the next check.");
  } else if (state === "not_configured") {
    if (o.ownNodeIsLoopback !== true) return no("There is no second Parano1d node, and your node is not on this computer. Give a second node in this swap's settings: the producer check needs it.");
  } else return no("The two Parano1d nodes disagree about the producers, or the second one cannot be checked. That cannot be waived.");
  const lp = Math.ceil((p.long.largest * 1000) / p.long.n);
  const sp = Math.ceil((p.short.largest * 1000) / p.short.n);
  const share = Math.max(lp, sp);
  if (share > PRODUCER_CEILING_PERMILLE) return no(`One address mined ${pctText(p.long.largest, p.long.n)} % and ${pctText(p.short.largest, p.short.n)} % of Parano1d's recent blocks: above the ${PRODUCER_CEILING_PERMILLE / 10} % this program accepts. Do not start this swap.`);
  const text = share === lp ? pctText(p.long.largest, p.long.n) : pctText(p.short.largest, p.short.n);
  return { ok: true, share_text: text, share_permille: share };
}

module.exports = { producerScreen, PRODUCER_CEILING_PERMILLE };
