"use strict";
/*
 * Bob's up-front look at the producer screen. Since 0.2.0 (the owner's decision) THE SHARE NEVER REFUSES Bob's approval: the page states it plainly, in words, and Bob ticks that he read it.
 * "One producer mined N % of recent Parano1d blocks. A Bob who faces that miner as Alice can lose his ETH: above half of the blocks, no time window protects him." When the share cannot be read
 * (no headers yet, incomplete, stale) the page says it is unknown and the approval is still allowed. The risk stays; nothing here makes it smaller.
 *
 * What still refuses is the lying-node check, not a share rule: a remembered or present disagreement between the two Parano1d nodes, a second node that cannot be read or disagrees, and a missing second
 * node when Bob's own node is not on this computer. The approval still lets his ticks and his lock step pass swap-cli's `--acknowledge-producer-share 650`, which since 0.2.0 waives only the missing second
 * node of a loopback node (the flag and its value stay for compatibility; the share part of it is a no-op in swap-cli).
 *
 * It reads ONLY structured fields of the tick (`noid.producers`, `noid.producer_marker`, `noid.second_error`, `noid.tip`; swap-cli `watch/producers.rs`, `producer_marker.rs`), never the notes
 * or any free text, and the second-node checks fail closed: a field that is of another kind or out of range is a refusal, not a pass. A summary that is missing, incomplete or old is an UNKNOWN share
 * (a warning), as in swap-cli. The numbers are swap-cli's own (engine.rs MAX_OBSERVATION_AGE_S 120, MAX_NOID_TIP_DIFF 2).
 */

const PRODUCER_CEILING_PERMILLE = 650; // the compiled hard maximum of the (compatibility) flag
const MAX_OBSERVATION_AGE_S = 120;
const MAX_TIP_DIFF = 2;
const WINDOW_LONG = 2880; // the production profile's windows (params.rs)
const WINDOW_SHORT = 720;
const WARN_LIMIT_PERMILLE = 350; // the production profile's warning limit (params.rs)
const HALF_PERMILLE = 500;

const isCount = (x) => Number.isSafeInteger(x) && x >= 0;

/** `largest / n` in tenths of a percent, rounded UP (swap-cli prints it the same way), as text "52.7". */
function pctText(largest, n) {
  const tenths = Math.ceil((largest * 1000) / n);
  return `${Math.floor(tenths / 10)}.${tenths % 10}`;
}

const SHARE_UNKNOWN_SENTENCE = "The share of one producer in recent Parano1d blocks is unknown right now.";
const UNKNOWN_WARNING = `${SHARE_UNKNOWN_SENTENCE} A Bob who faces a miner who is Alice can lose his ETH: above half of the blocks, no time window protects him. The program does not refuse the swap for this.`;

/** The plain sentence about the share, for the statement and the card. */
const shareSentence = (text) => `One producer mined ${text} % of recent Parano1d blocks.`;

/** The warning for a known share (permille, rounded up), or "" when it is at or under the warning limit. */
function warningFor(text, permille) {
  if (permille > HALF_PERMILLE) return `${shareSentence(text)} A Bob who faces that miner as Alice can lose his ETH: above half of the blocks, no time window protects him.`;
  if (permille > WARN_LIMIT_PERMILLE) return `${shareSentence(text)} The more one miner holds, the better the chance that Alice is that miner and can take both sides. This is a warning, not a refusal.`;
  return "";
}

/**
 * @param {object|null} tick the last tick Bob's program wrote (a parsed `last-tick-bob.json`)
 * @param {number} nowS now, in Unix seconds
 * @param {{ownNodeIsLoopback?:boolean}} [o] true when Bob's only Parano1d node is on this machine (run.json's noid_rpc is loopback and there is no second node)
 * @returns {{ok:true, known:boolean, share_text:string|null, share_permille:number|null, level:"none"|"mild"|"high"|"unknown", warning:string, sentence:string}|{ok:false, why:string}}
 */
function producerScreen(tick, nowS, o = {}) {
  const no = (why) => ({ ok: false, why });
  const unknown = () => ({ ok: true, known: false, share_text: null, share_permille: null, level: "unknown", warning: UNKNOWN_WARNING, sentence: SHARE_UNKNOWN_SENTENCE });
  // swap-cli's own verdict first (tick JSON `producer_screen`, producer_gate.rs): when it is there and says the screen is enforced and the acknowledgement cannot open it, the approval is refused
  // whatever the fields below say. Since 0.2.0 that is only a second-node problem or a remembered disagreement, never the share.
  const ps = tick && typeof tick === "object" && tick.producer_screen && typeof tick.producer_screen === "object" ? tick.producer_screen : null;
  if (ps && ps.enforced === true && ps.waivable_by_acknowledgement !== true) {
    const WHY = {
      disagrees: "The two Parano1d nodes disagree about the producers, or the second one cannot be checked. That cannot be waived.",
      remembered: "The two Parano1d nodes once named different producers or blocks for this swap. That cannot be waived, and this swap cannot be locked: do not start it.",
      one_node: "There is no second Parano1d node, and your node is not on this computer. Give a second node in this swap's settings: the producer check needs it.",
    };
    return no(WHY[ps.state] || "The second Parano1d node could not be checked. That cannot be waived: wait for the next check, or fix the node.");
  }
  const noid = tick && typeof tick === "object" && tick.noid && typeof tick.noid === "object" ? tick.noid : null;
  if (!noid) return unknown();
  const m = noid.producer_marker;
  if (m !== undefined && m !== null) {
    if (typeof m !== "object" || m.state !== "absent") return no("The two Parano1d nodes once named different producers or blocks for this swap. That cannot be waived, and this swap cannot be locked: do not start it.");
  }
  if (typeof noid.second_error === "string" && noid.second_error !== "") return no("The second Parano1d node could not be read. That cannot be waived: fix the node, then approve.");
  const p = noid.producers && typeof noid.producers === "object" ? noid.producers : null;
  if (!p) return unknown();
  // The lying-node checks come BEFORE the share: an unreadable share (error, incomplete, stale) is only a warning and must never let a second-node problem through.
  const hasError = typeof p.error === "string" && p.error !== "";
  const w = (x, n) => !!x && typeof x === "object" && x.n === n && isCount(x.largest) && x.largest <= x.n;
  const complete = p.complete === true && p.window_long === WINDOW_LONG && p.window_short === WINDOW_SHORT && w(p.long, WINDOW_LONG) && w(p.short, WINDOW_SHORT);
  const tip = isCount(noid.tip) ? noid.tip : isCount(p.tip) ? p.tip : null;
  const fresh = tip !== null && isCount(p.header_tip) && tip <= p.header_tip + MAX_TIP_DIFF && isCount(p.read_at) && Math.abs(nowS - p.read_at) <= MAX_OBSERVATION_AGE_S;
  const shareReadable = !hasError && complete && fresh;
  const s = p.second && typeof p.second === "object" ? p.second : null;
  const state = s ? s.state : "not_configured";
  const twoNodes = !!noid.second && typeof noid.second === "object";
  if (state === "agrees") {
    if (!isCount(s.sampled) || s.sampled < 1) return no("The second Parano1d node's cross-check recorded no sampled heights. That cannot be waived: wait for the next check.");
  } else if (state === "not_configured") {
    // An incomplete or failed read cannot say whether a second node was asked; with two nodes in the tick it is only a wait.
    if (o.ownNodeIsLoopback !== true && !(twoNodes && !complete)) return no("There is no second Parano1d node, and your node is not on this computer. Give a second node in this swap's settings: the producer check needs it.");
  } else if (state === "unreadable" && !complete) {
    // "not checked: the first node's headers are not complete": part of the unknown share.
  } else return no("The two Parano1d nodes disagree about the producers, or the second one cannot be checked. That cannot be waived.");
  if (!shareReadable) return unknown();
  const lp = Math.ceil((p.long.largest * 1000) / p.long.n);
  const sp = Math.ceil((p.short.largest * 1000) / p.short.n);
  const share = Math.max(lp, sp);
  const text = share === lp ? pctText(p.long.largest, p.long.n) : pctText(p.short.largest, p.short.n);
  const level = share > HALF_PERMILLE ? "high" : share > WARN_LIMIT_PERMILLE ? "mild" : "none";
  return { ok: true, known: true, share_text: text, share_permille: share, level, warning: warningFor(text, share), sentence: shareSentence(text) };
}

module.exports = { producerScreen, PRODUCER_CEILING_PERMILLE, shareSentence, SHARE_UNKNOWN_SENTENCE };
