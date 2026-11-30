"use strict";
/*
 * THE ONE PLACE where the console reads meaning out of the engine's TEXT.
 *
 * The engine (`swap-cli tick`) prints its decision as structured fields (`action`, `intent`, `noid`, `eth`, `phase_after`, ...) plus free text
 * (`notes`, and the `reason` of a wait). Wherever a structured field exists the console uses it. Where only text exists, the match is here and
 * nowhere else, so that the day the engine prints a structured display block (note level, code, last lock height, cutoff in force, stranded
 * instances) this file is the only one to change. Every match is anchored or phrase-sized, and each says where the engine produces the text.
 * A text that is not found means "the engine did not say it": the console then shows LESS (a send box is not offered), never more.
 * `test/enginetext.test.js` fails when a phrase below disappears from `swap-cli/src/*.rs` (the engine's wording changed: change it here).
 *
 *   #  text (what is matched)                                         engine source (swap-cli/src)
 *   1  `held: fresh decision was KIND`  (a note, exact)                engine.rs `tick_apply`: decision.notes.push(format!("held: fresh decision was {}", ..))
 *        -> what the engine's own fresh decision was in a tick whose intent is HELD (the printed `action` is then always `wait`;
 *           no structured field carries the fresh decision: `Decision.reveal_cutoff_passed` is "never printed")
 *   2  `its reveal cutoff has passed, so the printed parameters are    engine.rs `reveal_cutoff_wait_reason` (the wait reason of a held reveal_eth
 *        not to be used`  (a phrase inside the wait reason)            whose reveal cutoff has passed)
 *   3  `ALARM` / `ANOMALY`  (a word anywhere in a note or a reason)   engine.rs: `ANOMALY: our lock was refunded ...` (bob/alice fact), `late_lock_note`
 *        -> the engine's loud notes; one is printed on EVERY tick while a late lock of Bob's is open, the claim-still-pending alarms, the
 *           lagging-Ethereum-node alarm, the other-lock alarms, the producer-screen refusals (producer_gate.rs)
 *   4  `ALERT:`  (a note starting with it)                             engine.rs `CLAIM_REMOVED_ALERT` (a reorg removed Bob's NOID claim: send it again),
 *        -> printed on the first tick that takes the transition      producer_gate.rs `pending_lock_note` (the producer screen refuses a pending lock)
 *   5  the lock-by / funding-window note (a note, by its opening       engine.rs `lock_by_margin_note`: "funding window ...", "funding window is
 *        words)                                                         closed ...", "lock-by margin ...", "lock margin ...", "nominal lock-by N has passed ...",
 *                                                                       "lock-by N has passed ...", "the tip is the last lock height ...", "the last lock height ..."
 *        -> the real last lock height and the margin to it; the console computes none of it
 *   6  the leftover-leg words in a wait reason                         engine.rs `alice_action` Done: "... the NOID is still at the contract, refund_noid opens ...";
 *        (`refund`, `still at the contract`, `still open`,            bob_action: "the ETH lock is still open: refund_eth opens at T_reveal ..."
 *        `open past T_reveal`)                                          (the structured facts of `has_leftover_leg` are read as well, see viewmodel.js)
 *   8  `do NOT send it`  (a phrase inside the wait reason)               producer_gate.rs `pending_lock_wait_reason` (a pending lock_eth intent that the producer screen
 *        -> the engine says outright that the held lock must not be sent                                refuses now); scripts/live/env.sh `lock_precheck` refuses on the same phrase
 *   7  `fail closed` / `fails closed` / `stale`  (a word in a note)   engine.rs `decide`: "not KIND: WHY (fail closed)", the stale-observation notes
 *        -> only to colour a note amber; nothing is offered or refused by it
 *
 * What is NOT text-matched: the amount and slots of instances at the contract root (`noid.instances`), the intent kind / parameters /
 * cutoff / late_cutoff (`intent.intent`), the producer summary (`noid.producers`), the chain ids, the phase (`phase_after`).
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.NoidEngineText = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const strings = (list) => (Array.isArray(list) ? list.map(String) : []);

  // 1
  const HELD_FRESH = /^held: fresh decision was ([a-z_]+)$/;
  /** The engine's own fresh decision of a tick whose intent is held: its action kind ("wait", "reveal_eth", ...), or null when the tick does not say. */
  function heldFreshDecision(notes) {
    for (const n of strings(notes)) {
      const m = HELD_FRESH.exec(n.trim());
      if (m) return m[1];
    }
    return null;
  }

  // 2
  const REVEAL_CUTOFF_HELD = "its reveal cutoff has passed, so the printed parameters are not to be used";
  /** True when this wait reason is the engine's "held reveal, cutoff passed: do not use the printed parameters". */
  function revealCutoffHeld(reason) {
    return typeof reason === "string" && reason.includes(REVEAL_CUTOFF_HELD);
  }

  // 3
  const ALARM_WORDS = /ALARM|ANOMALY/;
  const isAlarmText = (t) => ALARM_WORDS.test(String(t));
  /** The first ALARM / ANOMALY text of a tick (notes, then the action's reason), or null. Whole text, never cut. */
  function alarmText(tick) {
    if (!tick) return null;
    const reason = tick.action && typeof tick.action.reason === "string" ? tick.action.reason : "";
    return [...strings(tick.notes), reason].find(isAlarmText) || null;
  }

  // 4
  const isAlertNote = (t) => /^ALERT:/.test(String(t).trim());
  /** The first ALERT: note of a tick, or null. */
  function alertText(tick) {
    return (tick && strings(tick.notes).find(isAlertNote)) || null;
  }

  // 5
  const LOCK_BY_NOTE = /^(?:funding window\b|lock-by margin\b|lock margin\b|nominal lock-by \d+ has passed\b|lock-by \d+ has passed\b|the tip is the last lock height\b|the last lock height\b)/;
  /** The engine's note about Bob's lock-by / last lock height / funding window, or null. The engine prints at most one. */
  function lockByNote(notes) {
    return strings(notes).find((n) => LOCK_BY_NOTE.test(n.trim())) || null;
  }
  /** How loudly to show that note: the engine's own words decide ("is short", "has passed", "is closed"); "quiet" otherwise. */
  function lockByLevel(note) {
    if (!note) return "quiet";
    if (/\bhas passed\b|\bis closed\b/.test(note)) return "danger";
    if (/\bis short\b|see the action/.test(note)) return "warn";
    return "quiet";
  }

  // 6
  const LEFTOVER_REASON = /refund|still at the contract|still open|open past T_reveal/i;
  const leftoverReason = (reason) => typeof reason === "string" && LEFTOVER_REASON.test(reason);

  // 8
  const DO_NOT_SEND = "do NOT send it";
  /** True when the engine's wait reason says outright that the held step must not be sent. */
  const doNotSend = (reason) => typeof reason === "string" && reason.includes(DO_NOT_SEND);

  // 7
  const CAUTION_NOTE = /fail(s)? closed|stale/i;
  const isCautionNote = (t) => CAUTION_NOTE.test(String(t));

  /**
   * Every phrase this module relies on, as data: `test/enginetext.test.js` looks each one up in the engine's source, so a reworded engine
   * text fails a test here instead of silently making the console show less (or more) than it should.
   */
  const ENGINE_PHRASES = [
    { id: 1, phrase: "held: fresh decision was ", files: ["engine.rs"] },
    { id: 2, phrase: REVEAL_CUTOFF_HELD, files: ["engine.rs"] },
    { id: 3, phrase: "ALARM", files: ["engine.rs"] },
    { id: 3, phrase: "ANOMALY", files: ["engine.rs"] },
    { id: 4, phrase: "ALERT: a reorg removed", files: ["engine.rs"] },
    { id: 4, phrase: "ALERT: the producer screen refuses", files: ["producer_gate.rs"] },
    { id: 5, phrase: "funding window", files: ["engine.rs"] },
    { id: 5, phrase: "lock-by margin", files: ["engine.rs"] },
    { id: 5, phrase: "lock margin", files: ["engine.rs"] },
    { id: 5, phrase: "nominal lock-by", files: ["engine.rs"] },
    { id: 5, phrase: "the tip is the last lock height", files: ["engine.rs"] },
    { id: 5, phrase: "the last lock height", files: ["engine.rs"] },
    { id: 6, phrase: "still at the contract", files: ["engine.rs"] },
    { id: 6, phrase: "the ETH lock is still open", files: ["engine.rs"] },
    { id: 7, phrase: "(fail closed)", files: ["engine.rs"] },
    { id: 8, phrase: DO_NOT_SEND, files: ["producer_gate.rs"] },
  ];

  return { heldFreshDecision, revealCutoffHeld, isAlarmText, alarmText, isAlertNote, alertText, lockByNote, lockByLevel, leftoverReason, isCautionNote, doNotSend, ENGINE_PHRASES, REVEAL_CUTOFF_HELD };
});
