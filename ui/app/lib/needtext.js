"use strict";
/**
 * The three-part texts of a "needs you" entry (R7): what happened, what that means for the person's coins, and until when. Pure; the swap page draws the result as `dl.need3`.
 * Loaded by node (`require`) and by the page (`window.NoidNeedText`).
 *
 *   parts(entry, view, now, hhmm?) -> { id, level, what, coins, coins_level, until, until_unix, steps, said, tone }
 *
 *   entry   one entry of an autopilot's `needs_you`: { spend, label, reason, need_kind?, retrying? }. `need_kind` is the entry's kind (outcome, stuck, refused, statements, cannot_end and the engine's
 *           own stop codes); an entry without one reads as a refusal. The short-deposit entries (`kind: "deposit"`) have their own words and are not handled here (parts returns null).
 *   view    the view model of the swap page (its `deadlines` rows, its `lock_by_note` and its `tick.at`): every time comes from a row or from the engine's own note, never counted anew.
 *   now     the page's clock in unix seconds (a deadline row that is stale, not relevant or has no count is not used).
 *   hhmm    how a unix time is written ("HH:MM", local); the default is the page's 24-hour local clock.
 *
 * A time that is missing leaves its clause out: the text never guesses one. Display only: nothing here decides or sends.
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.NoidNeedText = factory();
})(typeof self !== "undefined" ? self : this, function () {
  const BLOCK_S = 30; // the nominal Parano1d block, as the page counts
  const BLOCK_S_FAST = 20; // the engine's own count of blocks left in its notes
  const AFTER_D_BLOCKS = 20; // 19 for finality and 1 for the sweep: "back in your own address"

  // the step as a phrase inside a sentence, by spend id (replace variants and the three sweeps are folded in `base`)
  const STEP = {
    "send-fund": "the funding",
    "send-lock": "your lock",
    "send-reveal": "the reveal",
    "send-claim": "your NOID claim",
    "send-refund-eth": "your ETH refund",
    "send-recover": "taking your NOID back",
    "send-sweep": "the sweep",
  };
  const base = (id) => {
    const s = String(id || "");
    if (/^send-reveal(-replace)?$/.test(s)) return "send-reveal";
    if (/^send-refund-eth(-replace)?$/.test(s)) return "send-refund-eth";
    if (/^send-sweep-/.test(s)) return "send-sweep";
    return s;
  };
  const upFirst = (t) => t.charAt(0).toUpperCase() + t.slice(1);

  // What happened, by spend, when the program refused, stopped or asked for the statements again (the first column of the spec's table)
  const WHAT = {
    "send-fund": "The funding was not sent.",
    "send-lock": "Your lock was not sent.",
    "send-reveal": "Taking the ETH did not go through yet.",
    "send-claim": "Your NOID claim was not sent.",
    "send-refund-eth": "Your ETH refund did not go through yet.",
    "send-recover": "Taking your NOID back did not go through yet.",
    "send-sweep": "Sending what is left to your own address did not go through.",
  };
  const KIND_WORDS = {
    outcome: (step) => `The program cannot tell whether ${step} was sent.`,
    stuck: (step) => `${upFirst(step)} was sent but is stuck.`,
    cutoff: (step) => `${upFirst(step)} is past its last moment.`,
  };

  const STEPS = {
    plain: ["Read what the program said, below.", "Check that both chains say connected in the top bar.", "Press I have dealt with it to let the program try again."],
    outcome: ["Do not send it again by hand.", "Open Details, Receipts, and look the step up on its chain.", "When you know, press I have dealt with it."],
    stuck: ["The program never re-sends a stuck transaction.", "Re-send it from the box on this page (the same step at a higher fee).", "Press I have dealt with it after it is mined."],
    cutoff: ["Do not send this step.", "The program goes on with the safe path by itself.", "Press I have dealt with it."],
  };
  // M1 (fix round 2): a reveal that is stuck gets its own steps: the secret may already be public, so the re-send is the urgent act (the box asks for a higher cap, and maybe for more ETH in the swap key)
  const REVEAL_STUCK_STEPS = ["Re-send it now from the box on this page, at a higher fee cap.", "If the box asks for more ETH in the swap key, send it first.", "Press I have dealt with it after it is mined."];
  const stepsOf = (kind) => (kind === "outcome" ? STEPS.outcome : kind === "stuck" ? STEPS.stuck : kind === "engine_cutoff" || kind === "engine_do_not_send" ? STEPS.cutoff : STEPS.plain);

  // the spec's "This swap cannot end by itself ..." text (autopilot.js CANNOT_END_TEXT) in its three parts
  const CANNOT_END = {
    what: "This swap cannot end by itself: a funding (or lock) was prepared and never sent.",
    coins: "Safe. Its coins are safe in the swap wallet.",
    steps: ["See 'If a swap cannot end' in the help."],
  };

  const pad = (n) => String(n).padStart(2, "0");
  const defaultHhmm = (unix) => {
    const d = new Date(unix * 1000);
    return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  };

  /** A moment from the view model's own deadline row: `{ unix, passed }`, or null when the row is missing, stale, not relevant or has no count (the page's `rowTime`). */
  function rowTime(view, id, now) {
    const r = view && Array.isArray(view.deadlines) ? view.deadlines.find((d) => d && d.id === id) : null;
    if (!r || r.stale || r.relevant === false || r.no_countdown || !["far", "closing", "passed"].includes(r.state) || typeof r.target !== "number") return null;
    if (r.kind === "time") return { unix: r.target, passed: r.state === "passed" };
    if (typeof r.seconds_left === "number" && typeof now === "number") return { unix: now + r.seconds_left, passed: r.state === "passed" };
    return null;
  }

  /**
   * The moment the engine's own funding-window or lock margin note runs out: tick time plus its count of blocks at 20 s. Only for the notes whose count is the real limit ("funding window",
   * "lock margin", and "lock-by margin" with an exact last lock height); null for a stale note or any other form.
   */
  function noteTime(view) {
    const lb = view && view.lock_by_note && !view.lock_by_note.stale ? view.lock_by_note : null;
    const at = view && view.tick && typeof view.tick.at === "number" ? view.tick.at : null;
    if (!lb || typeof lb.text !== "string" || at === null) return null;
    const t = lb.text.trim();
    if (/\bhas passed\b|\bis closed\b/.test(t) && !/; the lock is still allowed until /.test(t)) return null;
    const firm = /^(?:funding window\b|lock margin\b)/.test(t) || (/^lock-by margin\b/.test(t) && /; the last lock height is \d+/.test(t));
    const m = /: (\d+) blocks\b/.exec(t);
    if (!firm || !m || !Number.isSafeInteger(Number(m[1]))) return null;
    return { unix: at + Number(m[1]) * BLOCK_S_FAST, passed: false };
  }

  /** Alice's "back in your own address" moment: the deadline row plus 20 blocks at 30 s. */
  function aliceBack(view, now) {
    const d = rowTime(view, "d", now);
    return d ? { unix: d.unix + AFTER_D_BLOCKS * BLOCK_S, passed: d.passed } : null;
  }

  const BACK_EXTRA_S = 60; // after Alice's last moment to take the ETH plus Ethereum's finality: one more minute
  /** Bob's "back in your own wallet" moment: Alice's last moment (the t_reveal row) plus Ethereum's finality (the profile's own figure) and a minute. null without the row or the figure. */
  function bobBack(view, now, ethFinalityS) {
    const t = rowTime(view, "t_reveal", now);
    return t && Number.isFinite(ethFinalityS) ? { unix: t.unix + ethFinalityS + BACK_EXTRA_S, passed: t.passed } : null;
  }
  /** The list's version of both: from the moment the coins stay in play until (Alice: D; Bob: T_reveal) to the moment they are back, so that every screen says the same time. */
  function backFrom(role, untilUnix, ethFinalityS) {
    if (!Number.isFinite(untilUnix)) return null;
    if (role === "alice") return untilUnix + AFTER_D_BLOCKS * BLOCK_S;
    return role === "bob" && Number.isFinite(ethFinalityS) ? untilUnix + ethFinalityS + BACK_EXTRA_S : null;
  }

  /** The three parts of one entry; null for a short-deposit entry, which has its own words, and for an entry without a spend id. */
  function parts(entry, view, now, hhmm) {
    if (!entry || typeof entry !== "object" || typeof entry.spend !== "string" || entry.kind === "deposit") return null;
    const fmt = typeof hhmm === "function" ? hhmm : defaultHhmm;
    const id = base(entry.spend);
    if (!Object.prototype.hasOwnProperty.call(STEP, id)) return null;
    const kind = typeof entry.need_kind === "string" ? entry.need_kind : "refused";
    const step = STEP[id];
    const at = (t) => (t ? `about ${fmt(t.unix)}` : null);
    const out = { id: entry.spend, kind, what: "", coins: "", coins_level: "safe", until: null, until_unix: null, steps: stepsOf(kind), said: typeof entry.reason === "string" ? entry.reason : "" };

    // ---- what happened
    if (kind === "cannot_end") {
      out.what = CANNOT_END.what;
      out.steps = CANNOT_END.steps;
    } else if (kind === "outcome") out.what = KIND_WORDS.outcome(step);
    else if (kind === "stuck") out.what = KIND_WORDS.stuck(step);
    else if (kind === "engine_cutoff") out.what = KIND_WORDS.cutoff(step);
    else out.what = WHAT[id];

    // ---- your coins, and until when
    let t = null;
    switch (id) {
      case "send-fund": {
        out.coins = kind === "outcome" ? "Safe. Your NOID is either in this swap's own wallet or locked in the contract; both can come back to you." : "Safe. Your NOID is in this swap's own wallet; nothing is locked yet.";
        t = noteTime(view);
        if (t) out.until = `The swap can start until about ${fmt(t.unix)}; after that the program sends your NOID back to your own address.`;
        break;
      }
      case "send-lock": {
        out.coins = kind === "outcome" ? "Safe. Your ETH is either in this swap's own key or locked in the contract; both can come back to you." : "Safe. Your ETH is in this swap's own key; nothing is locked yet.";
        t = noteTime(view);
        if (t) out.until = `Your program can lock until about ${fmt(t.unix)}; after that the swap does not start and your ETH goes back to your own address.`;
        break;
      }
      case "send-reveal": {
        if (kind === "stuck" || kind === "outcome") {
          // M1: the secret may already be public. Until the claim is mined before T_reveal, Bob can take his ETH back and close the NOID contract to himself: not safe, and the time is T_reveal, not the cutoff
          t = rowTime(view, "t_reveal", now);
          out.coins = t ? `Not safe yet. The secret may already be public. Your reveal must be in a block before ${at(t)}, or Bob can take the NOID as well as his ETH back.` : "Not safe yet. The secret may already be public. Your reveal must be in a block in time, or Bob can take the NOID as well as his ETH back.";
          out.coins_level = "danger";
          // the coins sentence already carries the time (until_unix is still set below): no second line that says it again
          // an unknown outcome has no transaction to replace, so its steps stay the outcome steps (look it up first)
          if (kind === "stuck") out.steps = REVEAL_STUCK_STEPS;
          break;
        }
        const back = aliceBack(view, now);
        out.coins = `Safe. Your NOID is locked${back ? `, and if the ETH is not taken in time it is back by ${at(back)}` : ""}.`;
        t = rowTime(view, "reveal_cutoff", now);
        if (t) out.until = `The ETH can be taken until about ${fmt(t.unix)}.`;
        break;
      }
      case "send-claim": {
        t = rowTime(view, "claim_target", now);
        out.coins = `Not safe yet. Alice has the ETH${t ? `; your claim must be in a block before ${at(t)}` : ""}.`;
        out.coins_level = "danger";
        if (t) out.until = `The claim has to be in a block before about ${fmt(t.unix)}.`;
        break;
      }
      case "send-refund-eth":
        out.coins = "Safe. Only you can take this ETH back now, and it stays in the contract until you do.";
        break;
      case "send-recover":
        out.coins = "Safe. Only you can take this NOID back now, and it stays in the contract until you do.";
        break;
      default:
        out.coins = "Safe. It stays in this swap's own wallet or key until it is sent.";
    }
    if (kind === "cannot_end") {
      out.coins = CANNOT_END.coins;
      out.coins_level = "safe";
    }
    if (t) out.until_unix = t.unix;
    // the tone of the entry: the claim's and the stuck or unknown reveal's "not safe yet" are the dangers
    out.tone = out.coins_level === "danger" ? "danger" : "needs";
    return out;
  }

  return { parts, rowTime, noteTime, aliceBack, bobBack, backFrom, STEP, WHAT, STEPS, CANNOT_END };
});
