"use strict";
/*
 * DOM-free view model of the operator UI. Input: a run payload for ONE role (sanitized tick JSON, loop history,
 * public terms, dry-run files) and the current time. Output: plain objects the page renders and the tests check.
 * Loaded by the browser (window.NoidView, after phases.js) and by node (require).
 *
 * Fail-closed display rules: unknown stays "unknown", a stale observation is labelled stale and never upgraded, and a
 * spending action whose parameters were withheld (read-only tick) is never turned into a command.
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory(require("./phases"), require("./enginetext"));
  else root.NoidView = factory(root.NoidPhases, root.NoidEngineText);
})(typeof self !== "undefined" ? self : this, function (P, E) {
  "use strict";

  const BLOCK_S = 30; // Parano1d nominal block time; shown as "≈"
  const FINAL_BLOCKS = 19; // claim target margin: final at inclusion + 18 and the recovery opens at D, so include by D − 19
  const TICK_STALE_S = 120; // the loop ticks every ~30 s; the engine treats older observations as stale
  const TICK_DEAD_S = 600;
  const OBS_OK_S = 60;
  const OBS_WARN_S = 120;
  const CLOSING_BLOCKS = 30;
  const CLOSING_S = 900;
  const ETH_HEAD_LAG_S = 600; // swap-cli's limit for the Ethereum head time (REVIEW-4 R4-8)
  // The reveal helper's own rule for a FIRST reveal (copies, pinned to the helper's source by test/picture.test.js): it refuses when
  // now + S > cutoff, with cutoff = min(T_reveal - margin, the intent's frozen cutoff). margin = DEFAULT_MARGIN_S of eth/scripts/live.js (reveal.sh
  // never passes another); S = the send budget of eth/scripts/bounded-send.js (answer window tailMs + guard guardMs of DEFAULT_TIMING).
  const SENDER_MARGIN_S = 1800;
  const SENDER_SEND_BUDGET_S = 30;
  // the page's own allowance for the helper's preparation before its last check (unsealing the secret, reading the lock, connecting: the sender's
  // connect limit alone is 15 s); not a rule of the helper
  const REVEAL_PREP_ALLOWANCE_S = 60;

  // Per profile: M_A (reveal margin before T_reveal). A COPY of swap-cli's table, used only as the labelled FALLBACK for the reveal cutoff while no
  // reveal intent exists: once the engine records the intent, its own `cutoff` / `late_cutoff` are shown instead.
  const PROFILES = {
    production: { name: "production", m_a_s: 1800, w_a_s: 7200 },
    rehearsal: { name: "rehearsal", m_a_s: 300, w_a_s: 600 },
    sepolia: { name: "sepolia", m_a_s: 1800, w_a_s: 4200 },
  };

  // ------------------------------------------------------------ formatting (locale-free)
  function fmtDur(sec) {
    if (typeof sec !== "number" || !Number.isFinite(sec)) return "—";
    const a = Math.abs(Math.round(sec));
    const h = Math.floor(a / 3600);
    const m = Math.floor((a % 3600) / 60);
    const s = a % 60;
    if (h) return `${h} h ${String(m).padStart(2, "0")} min`;
    if (m) return `${m} min${a < 600 ? " " + String(s).padStart(2, "0") + " s" : ""}`;
    return `${s} s`;
  }
  function group(n) {
    return typeof n === "number" ? n.toLocaleString("en-US") : String(n);
  }
  function noidText(micro) {
    if (typeof micro !== "number" && typeof micro !== "string") return null;
    const v = BigInt(micro);
    const whole = v / 1000000n;
    const frac = String(v % 1000000n).padStart(6, "0");
    return `${whole}.${frac}`;
  }
  function ethText(wei) {
    if (wei === null || wei === undefined) return null;
    let v;
    try {
      v = BigInt(wei);
    } catch {
      return null;
    }
    const whole = v / 10n ** 18n;
    let frac = String(v % 10n ** 18n).padStart(18, "0").replace(/0+$/, "");
    if (frac.length < 3) frac = frac.padEnd(3, "0");
    return `${whole}.${frac}`;
  }
  const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);

  // ------------------------------------------------------------ clocks
  function tickTime(tick, mtime) {
    return num(tick && tick.now) !== null ? tick.now : num(mtime);
  }
  function ageState(ageS) {
    if (ageS === null || ageS === undefined) return "unknown";
    if (ageS <= OBS_OK_S) return "ok";
    if (ageS <= OBS_WARN_S) return "warn";
    return "attn";
  }
  /** Estimated current Parano1d height and Ethereum chain time, from the last observation and the wall clock. */
  function nowEstimates(tick, now) {
    const noid = tick && tick.noid;
    const eth = tick && tick.eth;
    const out = { tip: null, tip_observed: null, eth_time: null, eth_block: null, noid_age_s: null, eth_age_s: null };
    if (noid && num(noid.tip) !== null) {
      const at = num(noid.observed_at) !== null ? noid.observed_at : num(tick.now);
      out.tip_observed = noid.tip;
      out.noid_age_s = at !== null ? Math.max(0, now - at) : null;
      out.tip = noid.tip + (out.noid_age_s === null ? 0 : Math.floor(out.noid_age_s / BLOCK_S));
    }
    if (eth && num(eth.latest_timestamp) !== null) {
      const at = num(eth.observed_at) !== null ? eth.observed_at : num(tick.now);
      out.eth_age_s = at !== null ? Math.max(0, now - at) : null;
      out.eth_time = eth.latest_timestamp + (out.eth_age_s === null ? 0 : out.eth_age_s);
      out.eth_block = eth.latest_block;
    }
    return out;
  }

  // ------------------------------------------------------------ inputs
  function termsOf(input) {
    const t = input.terms || {};
    const eth = t.eth || {};
    return {
      profile: t.profile || null,
      profile_explicit: t.profile_explicit !== false,
      variant: t.variant || null,
      amount_micronoid: num(t.amount_micronoid),
      d: num(t.deadline_height),
      lock_by: num(t.lock_by_height),
      h_create: num(t.h_create),
      w_a_s: num(t.w_a_s),
      alice_noid: t.alice_noid || null,
      bob_noid: t.bob_noid || null,
      hashlock: t.hashlock || null,
      contract_root: t.contract_root || null,
      chain_id: num(eth.chain_id),
      eth_contract: eth.contract || null,
      amount_wei: eth.amount_wei !== undefined && eth.amount_wei !== null ? String(eth.amount_wei) : null,
      alice_receiver: eth.alice_receiver || null,
      bob_sender: eth.bob_sender || null,
    };
  }

  function lockOf(tick) {
    return (tick && tick.eth && tick.eth.lock) || null;
  }

  /**
   * A copy of gate.js revealMaybePending (this file runs in the page and cannot require gate.js; a test keeps the two equal): the tick shows Alice's swap
   * key with latest nonce 0 and a send waiting, so a reveal of hers may be pending and the secret may be public.
   */
  function revealMaybePendingCopy(tick) {
    if (!tick || typeof tick !== "object") return false;
    if (tick.phase_after !== "lock_seen" && tick.phase_after !== "lock_final") return false;
    const eth = tick.eth || {};
    const nodePendingAtZero = (obs) => {
      if (!obs || typeof obs !== "object" || obs.claimed) return false;
      if (obs.signer_nonce_latest === 0 && obs.signer_nonce_pending === 1) return true;
      return tick.reveal_maybe_pending === true && obs.signer_nonce_latest === 0 && typeof obs.signer_nonce_pending === "number" && obs.signer_nonce_pending > 0;
    };
    if (!nodePendingAtZero(eth)) return false;
    if (eth.second_error) return false;
    if (eth.second !== undefined && eth.second !== null) {
      if (typeof eth.second !== "object" || !nodePendingAtZero(eth.second)) return false;
    }
    return true;
  }

  function actionOf(tick) {
    const a = tick && tick.action;
    if (!a || typeof a !== "object") return null;
    const kind = a.action || a.kind || null;
    const withheld = a.parameters === "withheld";
    const params = {};
    for (const [k, v] of Object.entries(a)) if (!["action", "kind", "reason", "parameters", "note"].includes(k)) params[k] = v;
    return { kind, withheld, reason: typeof a.reason === "string" ? a.reason : null, note: a.note || null, params };
  }

  // ------------------------------------------------------------ deadlines
  function stateOf(blocksLeft, secondsLeft, windowS, stale, dead) {
    if (dead) return "unknown";
    if (secondsLeft === null) return "unknown";
    if (secondsLeft <= 0) return "passed";
    const closing = (blocksLeft !== null && blocksLeft < CLOSING_BLOCKS) || secondsLeft < CLOSING_S || (windowS && secondsLeft < windowS * 0.1);
    return closing ? "closing" : "far";
  }

  function deadlinesFor(role, tick, terms, profile, now, tickAge, phaseId, finished) {
    const est = nowEstimates(tick, now);
    const stale = tickAge !== null && tickAge > TICK_STALE_S;
    const dead = tickAge === null || tickAge > TICK_DEAD_S;
    const gates = PROFILES[profile] || PROFILES.production;
    const lock = lockOf(tick);
    const eth = (tick && tick.eth) || {};
    const lockClosed = !!(eth.claimed || eth.refunded || (lock && (lock.claimed || lock.refunded)));
    const out = [];

    const heightRow = (id, label, plain, target, extra = {}) => {
      if (target === null || target === undefined) {
        out.push({ id, kind: "height", label, plain, target: null, state: "unknown", note: "not in the terms", ...extra });
        return;
      }
      const blocks = est.tip === null ? null : target - est.tip;
      const secs = blocks === null ? null : blocks * BLOCK_S;
      let state = extra.relevant === false ? "na" : extra.met ? "met" : stateOf(blocks, secs, extra.window_s, stale, dead);
      out.push({ id, kind: "height", label, plain, target, blocks_left: blocks, seconds_left: secs, approx: true, state, stale, ...extra });
    };
    const timeRow = (id, label, plain, target, extra = {}) => {
      if (target === null || target === undefined) {
        out.push({ id, kind: "time", label, plain, target: null, state: "unknown", note: "no Ethereum lock seen yet", ...extra });
        return;
      }
      const secs = est.eth_time === null ? null : target - est.eth_time;
      const state = extra.relevant === false ? "na" : extra.met ? "met" : stateOf(null, secs, extra.window_s, stale, dead);
      out.push({ id, kind: "time", label, plain, target, seconds_left: secs, state, stale, ...extra });
    };

    const lockSeen = !!lock;
    const pastLock = ["lock_seen", "lock_final", "reveal_submitted", "revealed", "done", "lock_submitted", "locked", "secret_seen", "claim_submitted", "claim_included"].includes(phaseId);
    // The nominal lock-by is the number the bundle states. The height the engine really gives up at (Bob's last lock height, or the funding window)
    // is the engine's to compute and it prints it in a note: the console shows that note and counts nothing down to the nominal number.
    {
      const nominal = terms.lock_by;
      const engineNote = E.lockByNote(tick && tick.notes);
      if (nominal === null) out.push({ id: "lock_by", kind: "height", label: "Lock-by height (nominal)", plain: "Not in the terms.", target: null, state: "unknown", note: "not in the terms", engine_note: engineNote, no_countdown: true });
      else
        out.push({
          id: "lock_by",
          kind: "height",
          label: "Lock-by height (nominal)",
          plain: "The lock-by height the bundle states. The console does not count down to it: the real last lock height is the engine's, and its note (below, or in the notes list) names it.",
          target: nominal,
          state: lockSeen || pastLock ? "met" : "info",
          met: lockSeen || pastLock,
          engine_note: engineNote,
          no_countdown: true,
          stale,
        });
    }

    let tReveal = lock ? num(lock.timelock) : null;
    if (tReveal === null && tick && tick.intent && tick.intent.intent && tick.intent.intent.params) tReveal = num(tick.intent.intent.params.t_reveal);
    if (tReveal === null && tick && tick.action && num(tick.action.t_reveal) !== null) tReveal = tick.action.t_reveal;
    const revealRelevant = !lockClosed && !P.isTerminal(role, phaseId);
    timeRow(
      "t_reveal",
      "T_reveal (Ethereum time)",
      "Until this moment only the secret can claim Bob's ETH; from then on Bob can refund it.",
      tReveal,
      { relevant: revealRelevant, window_s: gates.w_a_s }
    );
    const revealedAlready = ["reveal_submitted", "revealed", "done"].includes(phaseId);
    // The engine freezes the cutoffs into the reveal intent (`cutoff` for a first reveal, `late_cutoff` for a re-send once the secret may be public);
    // those numbers are shown when the intent has them. The profile table is only the labelled fallback while no reveal intent exists.
    const ip = tick && tick.intent && tick.intent.intent && tick.intent.intent.action === "reveal_eth" && tick.intent.intent.params ? tick.intent.intent.params : null;
    const frozenCutoff = ip ? num(ip.cutoff) : null;
    const frozenLate = ip ? num(ip.late_cutoff) : null;
    // The last moment the reveal HELPER accepts a first reveal (see the constants): counted against the later of this machine's clock and the chain's
    // clock, as the helper does. This, not the engine's cutoff, is the number a person has to act by.
    if (frozenCutoff !== null && tReveal !== null) {
      const startBy = Math.min(frozenCutoff, tReveal - SENDER_MARGIN_S) - SENDER_SEND_BUDGET_S - REVEAL_PREP_ALLOWANCE_S;
      const secs = startBy - Math.max(now, est.eth_time === null ? now : est.eth_time);
      const relevant = revealRelevant;
      const met = role === "alice" && revealedAlready;
      out.push({
        id: "reveal_start_by",
        kind: "time",
        label: "Last moment to start the reveal",
        plain: "The reveal helper checks once more right before it sends and refuses when less than 30 s are left before the earlier of the engine's frozen cutoff and T_reveal minus 30 min. This line is that moment less the 60 s this page allows for the helper's preparation (unsealing the secret, reading the lock, connecting). The helper decides, not this page: on a slow connection it can still refuse. Counted against the later of this machine's clock and the chain's clock.",
        target: startBy,
        seconds_left: secs,
        state: relevant === false ? "na" : met ? "met" : stateOf(null, secs, gates.w_a_s, stale, dead),
        stale,
        relevant,
        met,
        window_s: gates.w_a_s,
        source: "sender-rule",
      });
    }
    if (frozenCutoff !== null) {
      timeRow(
        "reveal_cutoff",
        "Reveal cutoff (frozen in the engine's intent)",
        "The engine froze this cutoff into the reveal intent, from the lock's T_reveal. A first reveal is not meant to be sent after it.",
        frozenCutoff,
        { relevant: revealRelevant, met: role === "alice" && revealedAlready, window_s: gates.w_a_s, source: "intent" }
      );
      if (frozenLate !== null) {
        timeRow(
          "reveal_resend_cutoff",
          "Re-send cutoff (frozen in the engine's intent)",
          "The later cutoff the engine froze for a re-send of a reveal that may already be public (a claim that was sent, mined, reorged or dropped).",
          frozenLate,
          { relevant: revealRelevant, met: role === "alice" && ["revealed", "done"].includes(phaseId), window_s: gates.w_a_s, source: "intent" }
        );
      }
    } else {
      timeRow(
        "reveal_cutoff",
        "Reveal cutoff (estimate from the profile table)",
        `No reveal intent exists yet, so this is T_reveal minus ${fmtDur(gates.m_a_s)}, the margin of the ${PROFILES[profile] ? profile : "production"} profile as this page knows it (a copy of the engine's table). The engine's own number appears once it records the reveal intent.`,
        tReveal === null ? null : tReveal - gates.m_a_s,
        { relevant: revealRelevant, met: role === "alice" && revealedAlready, window_s: gates.w_a_s, source: "profile-table" }
      );
    }

    const dRelevant = !P.isTerminal(role, phaseId) && phaseId !== "aborted" && !finished;
    heightRow(
      "d",
      role === "alice" ? "D: your refund opens" : "D: your claim closes",
      role === "alice"
        ? "From this Parano1d height on, you can take your NOID back (and Bob can no longer claim)."
        : "At this Parano1d height Alice can take the NOID back and your claim branch closes. Your claim must be final before it.",
      terms.d,
      { relevant: dRelevant, window_s: terms.h_create !== null && terms.d !== null ? (terms.d - terms.h_create) * BLOCK_S : null }
    );
    if (role === "bob") {
      heightRow(
        "claim_target",
        "Claim target (D − 19)",
        "A claim included by this height is final before D. Later is still valid until D − 1, but a rollback could undo it.",
        terms.d === null ? null : terms.d - FINAL_BLOCKS,
        { relevant: dRelevant, met: phaseId === "done" }
      );
    }
    return { rows: out, estimates: est, stale, dead };
  }

  // ------------------------------------------------------------ timeline
  function timelineFor(role, phaseId) {
    const tl = P.TIMELINE[role];
    if (!tl) return { main: [], recovery: [], extra: null, on_recovery: false };
    const idx = (list) => list.findIndex((n) => n.phases.includes(phaseId));
    const mainIdx = idx(tl.main);
    const recIdx = idx(tl.recovery);
    const extra = tl.extra.includes(phaseId) ? phaseId : null;
    const onRecovery = recIdx >= 0 || phaseId === "lost" || phaseId === "aborted";
    const finalIdx = tl.main.findIndex((n) => n.id === "funding_final");
    const main = tl.main.map((n, i) => {
      let state;
      if (mainIdx >= 0) state = i < mainIdx ? "done" : i === mainIdx ? "current" : "pending";
      else if (recIdx >= 0 || extra) state = i <= finalIdx ? "done" : "skipped";
      else state = "pending";
      if (phaseId === "done" && i === mainIdx) state = "done";
      if (extra === "aborted") state = "skipped";
      if (extra === "lost") state = i <= tl.main.findIndex((x) => x.id === (role === "alice" ? "reveal_sent" : "secret_seen")) ? "done" : "skipped";
      return { id: n.id, label: n.label, state };
    });
    const recovery = tl.recovery.map((n, i) => {
      let state = "pending";
      if (recIdx >= 0) state = i < recIdx ? "done" : i === recIdx ? "current" : "pending";
      if (phaseId === "refunded" && i === recIdx) state = "done";
      return { id: n.id, label: n.label, state };
    });
    return { main, recovery, extra, on_recovery: onRecovery };
  }

  // ------------------------------------------------------------ coins already in, while the file still says "before" (a restored stale copy)
  /**
   * Are this role's own coins already in the swap although the file's phase still says they are not? This happens when a swap is restored from a backup made before the
   * funding (Alice) or before the lock (Bob): the deposit was spent into the funding or the lock, so the wallet no longer shows it, and the file has not caught up yet.
   *   Alice: the file is at `created` and the tick's own events show the instance that matches the opening (`noid_instance_seen`, which the engine derives only for an
   *          instance that fits the opening: amount, contract, terms).
   *   Bob:   the file is before his lock (received, funded, funding_final) and his swap key, which is fresh per swap and sends nothing before the lock, has sent something
   *          (a latest or pending nonce above 0 on the primary Ethereum node, and on the second one too when one is configured: one wrong answer is not enough). The engine
   *          adopts his own lock by itself once Alice's funding is final.
   * The tick alone does not say the copy was restored: every caller also asks for the restore marker (the autopilot's `restoredCoinsIn`, its view's `coins_in`), so a normal
   * swap keeps every rule it had (the independent read of 2026-11-26: the downtime rule must not be switched off by this). Fail-closed: anything unreadable is false.
   */
  function coinsAlreadyIn(role, tick) {
    if (!tick || typeof tick !== "object") return false;
    const phase = typeof tick.phase_after === "string" ? tick.phase_after : null;
    if (role === "alice") return phase === "created" && Array.isArray(tick.events) && tick.events.some((e) => e && typeof e === "object" && e.event === "noid_instance_seen");
    if (role !== "bob" || !["received", "funded", "funding_final"].includes(phase)) return false;
    const sent = (o) => !!o && typeof o === "object" && [o.signer_nonce_latest, o.signer_nonce_pending].some((n) => Number.isSafeInteger(n) && n > 0);
    const eth = tick.eth && typeof tick.eth === "object" ? tick.eth : null;
    if (!eth || !sent(eth) || eth.second_error) return false;
    return eth.second === undefined || eth.second === null ? true : sent(eth.second);
  }

  // ------------------------------------------------------------ what the tick lists at the contract / which network
  /**
   * The instances at the contract root, as the LAST TICK lists them (`noid.instances`, or the single `noid.instance`). `known` is false when the tick
   * carries no instance information at all: then the console says it does not know, not "nothing".
   */
  function coinsAtContract(tick) {
    const noid = tick && tick.noid && typeof tick.noid === "object" ? tick.noid : null;
    if (!noid) return { known: false, instances: [], count: null };
    const has = Array.isArray(noid.instances) || noid.instance !== undefined || typeof noid.instance_count === "number";
    if (!has) return { known: false, instances: [], count: null };
    let list = Array.isArray(noid.instances) ? noid.instances : [];
    if (!list.length && noid.instance) list = [{ instance: noid.instance, matches_opening: noid.instance_matches_opening }];
    const instances = list
      .filter((x) => x && x.instance && num(x.instance.amount_micronoid) !== null)
      .map((x) => ({ slot: x.instance.slot_index, creation: x.instance.creation_id, amount_micronoid: x.instance.amount_micronoid, amount_text: noidText(x.instance.amount_micronoid), matches_opening: x.matches_opening === undefined ? null : x.matches_opening }));
    return { known: true, instances, count: instances.length };
  }

  /**
   * What the tick carries about who produced the recent Parano1d blocks (Bob's producer screen, threat T21): `noid.producers`, the producer-differs
   * marker and the accept flag, restated as plain figures, one line each. No judgement of the console's own: whether the screen refuses a lock is
   * the engine's (its ALARM / ALERT notes and its wait reason say so). null when the tick carries none of it.
   */
  function producerFigures(tick) {
    const noid = tick && tick.noid && typeof tick.noid === "object" ? tick.noid : null;
    if (!noid) return null;
    const p = noid.producers && typeof noid.producers === "object" ? noid.producers : null;
    const marker = noid.producer_marker && typeof noid.producer_marker === "object" && noid.producer_marker.state ? noid.producer_marker : null;
    const accept = noid.accept_producer_concentration === true;
    if (!p && !marker && !accept) return null;
    const lines = [];
    if (p) {
      const win = (name, w, size) => {
        if (!w || num(w.n) === null) lines.push(`${name} (${size} blocks): not complete yet.`);
        else lines.push(`${name}: the largest producer (${w.largest_id}) made ${w.largest} of ${w.n} blocks (${w.n ? ((100 * w.largest) / w.n).toFixed(1) : "0.0"} %); the two largest together ${w.top_two}; ${w.distinct} distinct producer${w.distinct === 1 ? "" : "s"}.`);
      };
      win("Long window", p.long, p.window_long);
      win("Short window", p.short, p.window_short);
      lines.push(`Read at tip ${p.tip}${num(p.header_tip) !== null ? `, headers held up to ${p.header_tip}` : ""}; ${p.have} header${p.have === 1 ? "" : "s"} of the long window held${p.complete ? " (complete)" : " (not complete)"}${num(p.headers_read) !== null ? `; ${p.headers_read} read this tick` : ""}${p.source ? `; from ${p.source}` : ""}.`);
      const s = p.second && typeof p.second === "object" ? p.second : null;
      if (s) {
        const text = {
          not_configured: () => "No second node was asked about the headers.",
          agrees: () => `The second node agrees at height ${s.height}${num(s.sampled) !== null ? ` and on ${s.sampled} sampled heights` : ""}.`,
          differs: () => `The two nodes name different blocks at height ${s.height} (${s.first} against ${s.second}).`,
          producer_differs: () => `The two nodes hold the same block at height ${s.height} but name different producers for it.`,
          sampled_differs: () => `The two nodes hold different blocks at the sampled height ${s.height}.`,
          unreadable: () => `The second node could not be checked: ${String(s.reason || "no reason given")}.`,
        }[s.state];
        lines.push(text ? text() : `Second node: ${String(s.state || "unknown")}.`);
      }
      if (p.error) lines.push(`The reading says: ${String(p.error)}`);
    }
    if (marker) {
      const m = marker;
      lines.push(
        m.state === "present"
          ? `A producer-differs marker is present beside the swap file (height ${m.height}${m.kind ? ", " + m.kind : ""}, seen at ${m.at}).`
          : m.state === "unreadable"
            ? `Something is at the producer-differs marker's path but it cannot be read (${String(m.reason || "no reason")}); the engine counts it as present.`
            : m.state === "remembered"
              ? `The swap file's history remembers a producer detection (at ${m.at}) although the marker file is gone.`
              : `Producer-differs marker: ${m.state}.`
      );
    }
    if (accept) lines.push("--accept-producer-concentration is on for this tick.");
    return { lines, has_summary: !!p };
  }

  /**
   * The console never acts on a production swap (Ethereum mainnet): a bundle or a swap file that says so shows it read-only. `terms.profile` is the
   * bundle's profile (the server defaults it to "production" when the bundle does not say); the chain id is read from the terms, from the tick's
   * Ethereum observation and from the swap file's own terms (`swap_terms.eth.chain_id`, copied by the engine from the swap file).
   */
  function isProduction(terms, tick) {
    if (terms && ((terms.profile === "production" && terms.profile_explicit !== false) || num(terms.chain_id) === 1)) return true;
    const eth = (tick && tick.eth) || {};
    const st = (tick && tick.swap_terms && tick.swap_terms.eth) || {};
    return num(eth.chain_id) === 1 || num(st.chain_id) === 1;
  }
  const PRODUCTION_TEXT = "This swap is on the production profile (Ethereum mainnet). This console does not act on a production swap: it only shows it, and every action is refused. Use the terminal and the engine's own commands.";

  // ------------------------------------------------------------ abort paths
  function abortPanel(role, phaseId, ctx) {
    const d = ctx.d;
    const toD = ctx.blocks_to_d;
    const dTxt = d === null ? "D" : `height ${group(d)}`;
    const inD = toD === null ? "" : toD > 0 ? ` (in about ${group(toD)} blocks, ≈ ${fmtDur(toD * BLOCK_S)})` : " (that height has passed)";
    const trTxt = "T_reveal";
    const rows = [];
    const you = [];
    const row = (who, where, fate) => rows.push({ who, where, fate });
    const A = "Alice's NOID";
    const B = "Bob's ETH";
    const aliceBackAtD = `Alice takes it back with her wallet from ${dTxt}${inD}.`;
    const bobRefund = "Bob refunds it once Ethereum time passes T_reveal.";
    let headline = "";
    switch (phaseId) {
      case "created":
      case "received":
      case "aborted": {
        // The console says only what the last tick lists. An instance at the contract root is Alice's NOID: it comes back after D with the
        // recovery helper (a terminal; the console cannot start it). No instance listed is not "nothing is there": it is what the node said then.
        const c = ctx.coins || { known: false, instances: [] };
        const n = c.instances.length;
        if (n) {
          headline = `Coins at the contract: the last tick lists ${n} instance${n === 1 ? "" : "s"} at the contract root.`;
          for (const i of c.instances) row(A, `${i.amount_text} NOID at the contract root (slot ${i.slot}, creation ${i.creation}${i.matches_opening === false ? "; the node says it does not match the opening" : ""}).`, `It comes back to Alice from ${dTxt}${inD}, with the recovery helper in a terminal (the console cannot start it yet). The engine's notes say which instances it counts as recoverable.`);
        } else if (c.known) {
          headline = "The last tick lists no instance at the contract root. That is what the node said then; the console does not claim more.";
          row(A, "Not at the contract, as far as the last tick shows.", "The console does not see wallets: if you funded and the tick does not show it, look at the wallet and at the contract.");
        } else {
          headline = "The console does not know whether anything is at the contract: the last tick has no instance information.";
          row(A, "Unknown to the console.", "Look at the wallet's contract instances and at the engine's notes.");
        }
        if (ctx.lock) row(B, "A matching Ethereum lock is listed by the last tick.", "See the engine's reason and notes for what happens to it.");
        else if (ctx.eth_known) row(B, "The last tick lists no matching lock on Ethereum.", "That is what the node said then; the console does not claim more.");
        else row(B, "Unknown to the console.", "The last tick has no Ethereum information.");
        break;
      }
      case "funding_submitted":
        headline = "Alice's funding is on its way; Bob has locked nothing.";
        row(A, "Sent to the contract, not yet seen.", `If it lands it is Alice's again from ${dTxt}${inD}; the contract can only pay Bob if he learns the secret, and he cannot.`);
        row(B, "Still in Bob's wallet.", "Stays there.");
        break;
      case "funded":
      case "funding_final":
        headline = "Only Alice's NOID is committed. Bob has locked nothing, so Bob risks nothing.";
        row(A, "In the Parano1d contract. Only the secret can close it before D, and only Alice has the secret.", aliceBackAtD);
        row(B, "Still in Bob's wallet.", "Stays there. Bob stops being able to lock after the lock-by height.");
        break;
      case "lock_submitted":
      case "lock_seen":
      case "lock_final":
      case "locked":
        if (ctx.secret_may_be_public === true && (phaseId === "lock_seen" || phaseId === "lock_final")) {
          // A reveal of Alice's may be waiting to be mined (a restored copy, a dropped send): the secret may be public, so this is not the quiet picture.
          headline = "A reveal of Alice's may already be on its way, so the secret may be public. Do not treat this swap as one that can simply be left.";
          row(A, "In the Parano1d contract. Bob can close it to himself with the public secret.", `If Bob does not, Alice takes it back from ${dTxt}${inD}.`);
        } else {
          headline = "Both legs are committed. If nobody finishes the swap, both sides refund and nobody loses.";
          row(A, "In the Parano1d contract. Alice has not revealed the secret.", aliceBackAtD);
        }
        row(B, "In the Ethereum contract.", bobRefund + (ctx.t_reveal_s_left !== null ? ` That is ${ctx.t_reveal_s_left > 0 ? "in about " + fmtDur(ctx.t_reveal_s_left) : "now possible"}.` : ""));
        break;
      case "reveal_submitted":
        headline = "The secret is already public in Alice's pending claim. Watch this closely.";
        row(B, "In the Ethereum contract. If Alice's claim is mined, it is hers.", "If her claim never lands, Bob refunds it after " + trTxt + ".");
        row(A, "In the Parano1d contract. Bob can now close it to himself with the public secret.", `If Bob does not, Alice takes it back from ${dTxt}${inD}. If her claim fails AND Bob both refunds and claims, she loses both legs.`);
        break;
      case "revealed":
      case "secret_seen":
      case "claim_submitted":
      case "claim_included":
        headline = role === "bob" ? "The secret is public. Alice's ETH is gone from the contract; the NOID is yours only if your claim is final before D." : "The secret is public. The ETH is yours; Bob decides whether the NOID is his.";
        row(B, "Claimed by Alice on Ethereum (or about to be).", "Stays Alice's.");
        row(A, "In the Parano1d contract until Bob's close is final.", `If Bob's claim is final before ${dTxt}${inD}, it is his. If not, Alice takes it back from ${dTxt}, so Bob would lose both.`);
        break;
      case "done":
        headline = "The swap is settled from this side. A leftover leg, if any, is refundable.";
        row(A, "Paid to Bob (if his claim is final), or still in the contract.", `If it is still in the contract, Alice takes it back from ${dTxt}${inD}.`);
        row(B, "Paid to Alice (if her claim is final), or still locked.", "If it is still locked, Bob refunds it after T_reveal.");
        break;
      case "refund_submitted":
      case "refund_included":
      case "refund_mined":
        headline = "A refund is on its way.";
        if (role === "alice") {
          row(A, "Your recovery close is sent or included.", "Back in your wallet once 18 blocks old. Keep the secret private until then.");
          row(B, "Bob refunds it after T_reveal (or already did).", "Back in Bob's wallet.");
        } else {
          row(B, "Your refund is sent or mined.", "Back in your wallet once Ethereum finalizes it.");
          row(A, "In the Parano1d contract.", aliceBackAtD);
        }
        break;
      case "refunded":
        headline = "The swap ended with refunds. Nothing is owed.";
        row(role === "alice" ? A : B, "Back in your wallet.", "Final.");
        row(role === "alice" ? B : A, "Back with its owner (or on its way).", "Their own refund path.");
        break;
      case "lost":
        headline = "Both legs are gone.";
        row(B, "Refunded to Bob.", "Final.");
        row(A, "Claimed by Bob with the public secret.", "Final.");
        break;
      default:
        headline = "The phase is not recognised, so no abort statement is made. Read the engine's reason and the files.";
    }
    if (role === "alice") {
      if (!["reveal_submitted", "revealed", "done", "refunded", "lost"].includes(phaseId)) you.push("Keep the secret sealed. Do not reveal after the reveal cutoff.");
      if (ctx.secret_may_be_public === true && (phaseId === "lock_seen" || phaseId === "lock_final")) you.push("The secret may already be public. If you stop now you can lose both legs.");
      else if (!["revealed", "done", "refunded", "lost", "aborted", "created", "received"].includes(phaseId)) you.push(`If the swap stops, do nothing until ${dTxt}${inD}, then take the NOID back with the wallet.`);
      if (["created", "aborted"].includes(phaseId) && ctx.coins && ctx.coins.instances.length) you.push(`Nothing is done for these coins before ${dTxt}${inD}. After it: the recovery helper in a terminal, the preview first (commands below). This console cannot start it yet.`);
    } else {
      if (!["done", "refunded", "aborted"].includes(phaseId)) you.push("Stay online until your claim is final.");
      if (["locked", "lock_submitted"].includes(phaseId)) you.push("If the secret never appears, refund your ETH after T_reveal.");
    }
    const recovery = role === "alice" && ["created", "aborted"].includes(phaseId) && ctx.coins && ctx.coins.instances.length ? { instances: ctx.coins.instances, d, blocks_to_d: toD, commands: commandsFor("alice", "refund_noid", { bin: ctx.bin }) } : null;
    return { headline, rows, you, recovery };
  }

  // ------------------------------------------------------------ commands
  function commandsFor(role, kind, ctx) {
    const bin = ctx.bin || "$L/bin";
    const out = [];
    const sh = (script, args) => `bash ${bin}/${script}${args ? " " + args : ""}`;
    switch (kind) {
      case "lock_eth":
        out.push({ id: "dry", label: "Dry run", cmd: sh("lock.sh", "--dry-run"), kind: "dry", note: "Checks every term against your swap file; sends nothing." });
        out.push({ id: "send", label: "Lock for real", cmd: sh("lock.sh"), kind: "send", note: "Locks real ETH. Needs your go-ahead; use only after the dry run is clean and still fresh." });
        break;
      case "reveal_eth":
        out.push({ id: "dry", label: "Dry run", cmd: sh("reveal.sh", "--dry-run"), kind: "dry", note: "Needs no secret; checks the lock, the fee cap and the cutoff." });
        out.push({ id: "send", label: "Reveal for real", cmd: sh("reveal.sh"), kind: "send", note: "Publishes the secret on Ethereum. Needs your go-ahead; inside the window only." });
        out.push({ id: "replace", label: "If the claim is stuck", cmd: sh("reveal.sh", "--replace"), kind: "send", note: "Re-sends the same claim at the same nonce with a higher fee. Raise MAX_FEE_GWEI first." });
        break;
      case "claim_noid":
        out.push({ id: "dry", label: "Dry run", cmd: sh("claim.sh"), kind: "dry", note: "Proves and prints the close (txid, height, fee, recipient). Sends nothing. The recipient must be your address." });
        out.push({ id: "send", label: "Submit the claim", cmd: sh("claim.sh", "--submit"), kind: "send", note: "Sends the close to the node. Needs your go-ahead." });
        break;
      case "refund_eth":
        out.push({ id: "dry", label: "Dry run", cmd: sh("refund-eth.sh", "--dry-run"), kind: "dry", note: "Checks the lock against your swap file; sends nothing." });
        out.push({ id: "send", label: "Refund for real", cmd: sh("refund-eth.sh"), kind: "send", note: "Sends the refund. Needs your go-ahead." });
        break;
      case "refund_noid":
        // recover-noid.sh (run 9 and 10 lesson): every instance of the contract, each close previewed, checked and sent chained to that very preview, once per instance
        out.push({ id: "preview", label: "Preview every recovery close", cmd: sh("recover-noid.sh", "--dry-run"), kind: "dry", note: 'Lists the instances and previews each recovery close; it must say "preview ok" (a recovery, terminal, payout to your own address, fee within the cap). Sends nothing. Before D it says "not a recovery".' });
        out.push({ id: "send", label: "Close every instance", cmd: sh("recover-noid.sh"), kind: "send", note: "Real NOID comes back to you. Needs your go-ahead, after D, with the wallet's active address set to yours (parano1d-cli address). It will not send the same close twice." });
        out.push({ id: "record", label: "Tell the engine", cmd: sh("tick.sh", "alice --closed-by <TXID> --apply"), kind: "manual", note: "For each txid in $L/recovered-txids.txt: records the close in your swap file so the phase follows." });
        break;
      case "fund_noid": {
        out.push({ id: "check", label: "Check the object", cmd: sh("check-object.sh"), kind: "dry", note: 'Must print "object file OK". Fund exactly that address and nothing else.' });
        out.push({ id: "dry", label: "Dry run of the funding", cmd: sh("fund.sh", "--dry-run"), kind: "dry", note: "Checks the object again, refuses when the contract already has an instance or this run folder was funded before. Sends nothing." });
        out.push({ id: "send", label: "Fund, once", cmd: sh("fund.sh"), kind: "send", note: `Real NOID (${ctx.amount_text || "<AMOUNT>"}). Needs your go-ahead, and only after Bob has verified the bundle. Run it ONCE: a second funding makes a second instance and stops the swap (run 9); the helper refuses a second run.` });
        break;
      }
      default:
    }
    return out;
  }

  // ------------------------------------------------------------ dry-run attachment
  const HELPER_KIND = { lock_eth: "eth_lock", reveal_eth: "eth_claim", refund_eth: "eth_refund", claim_noid: "claim_out" };

  function pickFacts(kind, s) {
    const facts = [];
    const add = (label, v) => {
      if (v !== undefined && v !== null && v !== "") facts.push({ label, value: typeof v === "object" ? JSON.stringify(v) : String(v) });
    };
    if (!s) return facts;
    if (kind === "claim_out") {
      const p = s.plan || {};
      add("mode", s.mode || s.claim);
      add("txid", p.txid);
      add("call height", p.call_height);
      add("fee (μNOID)", p.fee_micronoid);
      add("pays out (μNOID)", p.amount_out_micronoid);
      add("recipient", p.recipient);
      add("self-verified", p.self_verified);
      add("height class", p.height_class);
      return facts;
    }
    add("dry run", s.dryRun);
    add("sent", s.sent);
    add("from", s.from);
    add("to", s.to);
    add("value (wei)", s.valueWei);
    add("expected lock id", s.expectedLockId);
    add("lock id", s.lockId);
    add("receiver", s.receiver);
    add("amount (wei)", s.amountWei);
    add("T_reveal", s.timelock);
    add("reveal cutoff", s.revealCutoff);
    add("seconds to cutoff", s.secondsToCutoff);
    add("cutoff rule", s.revealCutoffRule);
    add("gas estimate", s.gasEstimate);
    if (s.feeCheck && typeof s.feeCheck === "object") for (const [k, v] of Object.entries(s.feeCheck).slice(0, 5)) add("fee check: " + k, v);
    add("locked in block", s.lockedBlock);
    add("finalized block", s.finalizedBlock);
    add("tx hash", s.txHash);
    add("block", s.blockNumber);
    return facts;
  }

  function dryRunFor(kind, helpers, tick, terms, act, now) {
    const want = HELPER_KIND[kind];
    if (!want) return null;
    const list = (helpers || []).filter((h) => h.kind === want && h.dry === true);
    if (!list.length) return null;
    const h = list.sort((a, b) => b.mtime - a.mtime)[0];
    const decided = tick && tick.intent && tick.intent.intent ? num(tick.intent.intent.decided_at) : null;
    const checks = [];
    const s = h.summary || {};
    const eq = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();
    if (kind === "reveal_eth" && act && act.params.lock_id && (s.lockId || s.expectedLockId)) checks.push({ name: "lock id matches the engine's", ok: eq(s.lockId || s.expectedLockId, act.params.lock_id) });
    if (kind === "reveal_eth" && terms.alice_receiver && s.receiver) checks.push({ name: "receiver is Alice's address in the terms", ok: eq(s.receiver, terms.alice_receiver) });
    if (kind === "lock_eth" && act && act.params.amount_wei && s.valueWei) checks.push({ name: "value matches the engine's amount", ok: String(s.valueWei) === String(act.params.amount_wei) });
    if (kind === "lock_eth" && terms.eth_contract && s.to) checks.push({ name: "target is the HTLC contract in the terms", ok: eq(s.to, terms.eth_contract) });
    if (kind === "lock_eth" && terms.bob_sender && s.from) checks.push({ name: "sender is Bob's address in the terms", ok: eq(s.from, terms.bob_sender) });
    if (kind === "claim_noid" && s.plan && terms.bob_noid) checks.push({ name: "recipient is Bob's address in the terms", ok: eq(s.plan.recipient || "", terms.bob_noid) });
    if (kind === "claim_noid" && s.plan) checks.push({ name: "proof verified itself", ok: s.plan.self_verified === true });
    if (kind === "refund_eth" && act && act.params.lock_id && s.lockId) checks.push({ name: "lock id matches the engine's", ok: eq(s.lockId, act.params.lock_id) });
    const age = now - h.mtime;
    const older = decided !== null && h.mtime < decided;
    return {
      file: h.file,
      mtime: h.mtime,
      age_s: age,
      older_than_decision: older,
      old: age > 600,
      ok: h.ok,
      error: h.error || null,
      err_text: h.err_text || null,
      facts: pickFacts(want, s),
      checks,
      all_checks_ok: checks.every((c) => c.ok),
    };
  }

  // ------------------------------------------------------------ alarms
  function alarmsFor(role, tick, loop, tickAge, errText, tickError, terms, deadlines, now, finished, tickWriting, restored) {
    const al = [];
    const add = (level, id, text) => al.push({ level, id, text });
    if (tickError) add("danger", "tick-unreadable", `The last tick file cannot be read: ${tickError}`);
    // The loop's helper empties the tick file and writes it again 10 to 20 s later: the server then keeps the last complete tick. Not a fault.
    if (tickWriting) add("info", "tick-writing", tick ? "The tick file is being rewritten right now. This page shows the last complete tick (see its age above); a spend waits for the new one." : "The tick file is being rewritten right now and no complete tick has been read yet: wait a few seconds.");
    if (!tick) {
      if (!tickError && !tickWriting) add("attn", "no-tick", "No tick file yet. The engine has not run, or the run folder is wrong.");
      return al;
    }
    if (tickAge !== null) {
      if (finished && tickAge > TICK_STALE_S) add("info", "tick-old-finished", `The last tick is ${fmtDur(tickAge)} old. The swap is finished, so a stopped loop is expected.`);
      else if (tickAge > TICK_DEAD_S) add("danger", "tick-stale", `The last tick is ${fmtDur(tickAge)} old. The loop may have stopped; nothing below is current.`);
      else if (tickAge > TICK_STALE_S) add("attn", "tick-stale", `The last tick is ${fmtDur(tickAge)} old (the loop ticks about every 30 s). The engine only acts on fresh data.`);
    }
    const ev = (n) => (n && (num(n.observed_at) !== null ? (num(tick.now) !== null ? tick.now - n.observed_at : null) : null));
    const noid = tick.noid || {};
    const eth = tick.eth || {};
    // observations inside the tick
    for (const [name, o] of [["Parano1d", noid], ["Ethereum", eth]]) {
      const a = ev(o);
      if (a !== null && a > OBS_WARN_S) add("attn", `stale-${name}`, `The ${name} observation was already ${fmtDur(a)} old when the tick ran (stale: the engine fails closed).`);
      if (o.second_error) add("attn", `second-${name}`, `The second ${name} node could not be read: ${String(o.second_error).slice(0, 160)}`);
      else if (o.single_node_ok) add("warn", `single-${name}`, `Single ${name} node (--single-node-ok): the second-node cross-checks are off.`);
      else if (!o.second && tick.sources && !tick.sources[name === "Parano1d" ? "noid_second" : "eth_second"]) add("warn", `single-${name}`, `Only one ${name} node is configured. The engine's notes say whether the next step needs a second one (the production profile does, and a second Ethereum node that cannot be read holds Bob's lock).`);
    }
    // node lag
    if (noid.second && num(noid.second.tip) !== null && num(noid.tip) !== null && Math.abs(noid.second.tip - noid.tip) > 2) add("attn", "noid-disagree", `The two Parano1d nodes disagree on the tip: ${group(noid.tip)} vs ${group(noid.second.tip)}.`);
    if (noid.second && noid.second.instance_count !== undefined && noid.instance_count !== undefined && noid.second.instance_count !== noid.instance_count) add("attn", "noid-instance-disagree", "The two Parano1d nodes disagree about the contract instances.");
    if (eth.second && num(eth.second.latest_timestamp) !== null && num(eth.latest_timestamp) !== null && Math.abs(eth.second.latest_timestamp - eth.latest_timestamp) > 120) add("attn", "eth-lag", `The two Ethereum nodes differ in chain time by ${fmtDur(Math.abs(eth.second.latest_timestamp - eth.latest_timestamp))}: one lags.`);
    if (num(tick.now) !== null && num(eth.latest_timestamp) !== null && tick.now - eth.latest_timestamp > ETH_HEAD_LAG_S) add("attn", "eth-head-old", `The Ethereum head is ${fmtDur(tick.now - eth.latest_timestamp)} behind the clock: the node lags, so nothing it says about T_reveal is safe.`);
    if (num(tick.now) !== null && num(noid.tip_time) !== null && tick.now - noid.tip_time > ETH_HEAD_LAG_S) add("attn", "noid-head-old", `The Parano1d tip block is ${fmtDur(tick.now - noid.tip_time)} old: the node may be stuck or the chain slow.`);
    // engine flags
    for (const n of tick.notes || []) {
      const t = String(n);
      // The whole text, never cut: an ALERT: is the engine's most urgent instruction (a reorg removed Bob's claim; a pending lock the producer screen now refuses).
      if (E.isAlertNote(t)) add("danger", "alert-" + al.length, t);
      else if (/ANOMALY/.test(t)) add("danger", "anomaly", t);
      else if (/ALARM/.test(t)) add("danger", "alarm", t);
      else if (E.isCautionNote(t)) add("attn", "note-" + al.length, t);
    }
    const act = actionOf(tick);
    if (act && act.reason) {
      if (/ANOMALY/.test(act.reason)) add("danger", "anomaly-reason", act.reason);
      else if (/ALARM/.test(act.reason)) add("danger", "alarm-reason", act.reason);
    }
    // held / recorded intent
    const intent = tick.intent;
    if (intent && (intent.status === "held" || intent.status === "recorded") && intent.intent) {
      const k = intent.intent.action;
      add(intent.status === "held" ? "warn" : "info", "intent", intent.status === "held" ? `Intent "${k}" is held: it was decided and the chain does not show its effect yet. If you ran it, wait; running it again pays twice.` : `Intent "${k}" was just recorded. Use these exact parameters; do not run it twice.`);
    }
    // chain surprises
    if (noid.instance_count > 1) add("danger", "many-instances", `${noid.instance_count} instances at the contract root. Never normal.`);
    if (noid.instance_matches_opening === false) add("danger", "opening-mismatch", "The funded instance does not match your opening.");
    if (eth.lock_count > 1) add("danger", "many-locks", `${eth.lock_count} matching Ethereum locks.`);
    // A file that never saw the lock while the chain shows it settled: this role ran on another machine (the unused copy that prepare.sh makes
    // for the other role ticks on, and ends up "waiting" or "aborted"), or the copy is old. What this page says for it is not about the swap.
    const PRE_LOCK = { alice: ["created", "funding_submitted", "funded", "funding_final"], bob: ["received", "funded", "funding_final", "aborted"] };
    const lk = eth.lock;
    if (lk && (lk.claimed === true || lk.refunded === true) && (PRE_LOCK[role] || []).includes(tick.phase_after)) {
      // a copy restored here from an older backup (the restore marker, rehearsal run 24 F9): the chains moved on while it was away, and this machine is the one that runs it
      if (restored === true) add("attn", "file-behind-chain", `This copy was restored from a backup made at "${tick.phase_after}", and the chains have moved on: the Ethereum lock of this swap is already ${lk.claimed ? "claimed" : "refunded"}. The program reads the chains and catches up by itself (after the approval, if it is not given yet); until then this page shows no step. Do not deposit again.`);
      else add("attn", "file-behind-chain", `This role's file is at "${tick.phase_after}", but the Ethereum lock of this swap is already ${lk.claimed ? "claimed" : "refunded"}. ${role === "alice" ? "Alice" : "Bob"} was probably driven from another machine, or this copy is old: what this page shows for this role is not the state of the swap. Look at the machine that ran it.`);
    }
    for (const e of tick.events || []) {
      const n = e && e.event;
      if (/reorged|dropped|instance_gone|evicted/.test(n || "")) add("attn", "event-" + n, `Engine event: ${n}${e.block_number ? " (block " + e.block_number + ")" : ""}.`);
    }
    // terms vs chain
    const lock = eth.lock;
    if (lock && terms.hashlock && lock.hashlock && String(lock.hashlock).toLowerCase() !== String(terms.hashlock).toLowerCase()) add("danger", "hashlock-mismatch", "The Ethereum lock's hashlock differs from the bundle's.");
    if (num(eth.chain_id) !== null && terms.chain_id !== null && eth.chain_id !== terms.chain_id) add("danger", "chain-mismatch", `The node reports chain id ${eth.chain_id}, the terms say ${terms.chain_id}.`);
    if (num(tick.exit_code) === null && loop && loop.entries && loop.entries.length) {
      const last = loop.entries[loop.entries.length - 1];
      if (last.exit_code !== 0) add("attn", "loop-exit", `The last loop tick exited with code ${last.exit_code}.`);
    }
    if (errText && /error|refus|fail/i.test(errText)) add("attn", "tick-err", `The tick's stderr says: ${errText.split("\n")[0].slice(0, 200)}`);
    // deadlines
    for (const d of deadlines || []) {
      if (d.state === "closing" && (d.id === "reveal_cutoff" || d.id === "d" || d.id === "claim_target")) add("warn", "closing-" + d.id, `${d.label}: closing (${d.kind === "height" ? "≈ " + fmtDur(d.seconds_left) : fmtDur(d.seconds_left)} left).`);
    }
    const order = { danger: 0, attn: 1, warn: 2, info: 3 };
    al.sort((a, b) => order[a.level] - order[b.level]);
    return al;
  }

  // ------------------------------------------------------------ receipts
  function receiptsFor(tick, terms, helpers, verify) {
    const r = [];
    const add = (group, label, value, extra = {}) => {
      if (value !== undefined && value !== null && value !== "") r.push({ group, label, value: String(value), ...extra });
    };
    if (terms.hashlock) add("Terms", "Hashlock H", terms.hashlock);
    if (terms.contract_root) add("Terms", "Parano1d contract root", terms.contract_root, { chain: "noid" });
    if (terms.eth_contract) add("Terms", "Ethereum HTLC contract", terms.eth_contract, { chain: "eth" });
    if (terms.chain_id !== null) add("Terms", "Ethereum chain id", terms.chain_id);
    if (terms.alice_noid) add("Terms", "Alice's Parano1d address", terms.alice_noid, { chain: "noid" });
    if (terms.bob_noid) add("Terms", "Bob's Parano1d address", terms.bob_noid, { chain: "noid" });
    if (terms.alice_receiver) add("Terms", "Alice's Ethereum address", terms.alice_receiver, { chain: "eth" });
    if (terms.bob_sender) add("Terms", "Bob's Ethereum address", terms.bob_sender, { chain: "eth" });
    if (verify) add("Proof", "Equivalence receipt", verify.ok ? "verified (sha256(m) = H and Addr(m) = A)" : "verifier output has no OK line", { plain: true, ok: verify.ok });
    const noid = (tick && tick.noid) || {};
    const eth = (tick && tick.eth) || {};
    if (noid.instance) add("Parano1d", "Contract instance", `slot ${noid.instance.slot_index}, incarnation ${noid.instance.creation_id}, ${noidText(noid.instance.amount_micronoid)} NOID`, { plain: true, chain: "noid", kind: "instance" });
    // `kind` names what a receipt is, so that the main view can call it by its plain name (the ticket's Receipts); the labels here are the technical page's
    if (noid.confirmed_tx) add("Parano1d", `Tracked transaction (confirmed at ${group(noid.confirmed_tx.height)})`, noid.confirmed_tx.txid, { chain: "noid", kind: "noid_tx" });
    for (const p of noid.pending_calls || []) add("Parano1d", "Pending call in the mempool", p.txid, { chain: "noid", kind: "noid_pending" });
    if (eth.lock) {
      add("Ethereum", "Lock id", eth.lock.lock_id, { chain: "eth", kind: "lock_id" });
      add("Ethereum", `Lock transaction (block ${group(eth.lock.block_number)})`, eth.lock.tx_hash, { chain: "eth", kind: "lock_tx" });
    }
    if (eth.claimed) add("Ethereum", `Claim transaction (block ${group(eth.claimed.block_number)})`, eth.claimed.tx_hash, { chain: "eth", kind: "claim_tx" });
    if (eth.refunded) add("Ethereum", `Refund transaction (block ${group(eth.refunded.block_number)})`, eth.refunded.tx_hash, { chain: "eth", kind: "refund_tx" });
    if (eth.pending_preimage) add("Ethereum", "Pending claim transaction", eth.pending_preimage.tx_hash, { chain: "eth", kind: "claim_pending" });
    for (const h of helpers || []) {
      const s = h.summary || {};
      if (h.dry === false && s.txHash) add("Helper output", `${h.kind.replace("eth_", "").replace("_out", "")} result${s.blockNumber ? " (block " + group(s.blockNumber) + ")" : ""}`, s.txHash, { chain: "eth" });
    }
    return r;
  }

  // ------------------------------------------------------------ actions mode: what leads the first card
  // The spends of lib/gate.js in the order the page offers them. `actions` is the server's `payload.actions` (undefined or disabled: no lead).
  const SPEND_ORDER = ["send-fund", "send-lock", "send-reveal", "send-reveal-replace", "send-claim", "send-refund-eth", "send-refund-eth-replace"];

  /**
   * The spend of THIS role the console offers a button for right now (`spends[id].relevant`), with the title of the first card: "fund 5 NOID",
   * "lock 0.001 ETH", "reveal the secret". null when there is none: the card then keeps the engine's own words.
   * `kind` says how the card may speak: "move" (the intent is fresh, or there is none: "Next: ... your move"), "decided" (the intent is HELD: decided on an
   * earlier tick, the operator may already have sent it, so no command and no "your move") and "funding" (never "your move": the funding may have been
   * done outside the console, which it cannot see until the operator says so). `heading` is the card's title, `chip` the words of its chip (or null).
   */
  function leadAction(view, actions) {
    if (!view || !view.action || !actions || !actions.enabled || !actions.spends) return null;
    for (const id of SPEND_ORDER) {
      const s = actions.spends[id];
      if (!s || !s.relevant || s.role !== view.role) continue;
      const t = (s.plain && s.plain.title) || s.label || id;
      const title = s.kind === "reveal_eth" && !s.replace ? "reveal the secret" : t.charAt(0).toLowerCase() + t.slice(1);
      const held = !!(view.action.intent && view.action.intent.status === "held");
      if (s.kind === "fund_noid") return { id, spend: s, title, kind: "funding", heading: "Funding", chip: null };
      if (held) {
        const step = { lock_eth: "Lock", reveal_eth: s.replace ? "Re-send the reveal" : "Reveal", claim_noid: "Claim", refund_eth: s.replace ? "Re-send the refund" : "Refund" }[s.kind] || "This step";
        return { id, spend: s, title, kind: "decided", heading: `${step}: decided earlier`, chip: "decided earlier: send only if you have not" };
      }
      return { id, spend: s, title, kind: "move", heading: `Next: ${title}`, chip: "your move" };
    }
    return null;
  }

  /**
   * Alice's funding is done with the console's own button right after Bob's check: the engine offers it from H_create - D_offset on (its wait reason
   * "too early to fund: the funding opens at height X" says from which height), so there is no wait for h_create. fund.sh in a terminal is the
   * alternative. While the file is at "created", from the very start and before the engine offers the funding, the first card says the order. null for
   * Bob, outside actions mode and once the file is past "created". `done` is true when a marker or an acknowledgement exists: the order is then
   * replaced by a line saying so.
   */
  function fundingGuide(view, actions) {
    if (!view || view.role !== "alice" || !actions || !actions.enabled) return null;
    const phase = view.phase && view.phase.id;
    const kind = view.action && view.action.command_kind;
    if (phase !== "created" && kind !== "fund_noid") return null;
    const f = actions.funding || {};
    const done = !!(f.marker_at || f.acknowledged_at || f.blocked_by);
    const what = f.acknowledged_at || f.marker_acknowledged ? "You told this console that the funding was done." : f.marker_at ? `funded.marker exists in the run folder (${f.marker_at}).` : f.blocked_by ? `Funding is closed: ${f.blocked_by}.` : "";
    return {
      done,
      done_text: done ? `${what} The console's funding button is gone for good and funding is never offered again; the engine confirms the funding from the chain. Do not fund a second time.` : null,
      title: "Fund from here, right after Bob's check",
      steps: [
        'Bob has checked the bundle on his machine (join.sh, or new-bob) and the two "bundle check" lines were compared: the 16 digits are the same.',
        'Here, in the box "Do it from here": the dry run, then Send, once. The box appears as soon as the tool offers the funding, before h_create (its reason says from which height).',
        'Only if you funded outside this console: tick "I have funded" (it writes the markers and closes the funding button for good).',
      ],
      alternative: "fund.sh in a terminal (fund.sh --dry-run, then fund.sh, once) is the alternative, followed by the box \"I have funded\" here. Use one way, not both. Fund soon after Bob's check: every block earlier is a block more for his lock.",
    };
  }

  /**
   * The engine's own note about Bob's lock-by / last lock height / funding window (see lib/enginetext.js), with how loudly to show it. The console
   * computes no margin: the real last lock height depends on when the funding became final, which only the engine knows. null when the tick has no
   * such note (the engine prints it only while Bob's lock is not yet seen) or the swap is over.
   */
  function lockByNote(tick, over, stale) {
    if (over || !tick) return null;
    const text = E.lockByNote(tick.notes);
    if (!text) return null;
    return { text, level: E.lockByLevel(text), stale: !!stale };
  }

  // ------------------------------------------------------------ the clock and the two-lock picture (display only)
  // Both read the FINISHED deadline rows above, and nothing else of the tick: no note text, no profile table, no arithmetic on heights or times.
  // The only number made here is a position on an axis, and that is the renderer's scaling of a row's `seconds_left`.
  const live = (r) => !!r && !r.stale && !r.no_countdown && (r.state === "far" || r.state === "closing" || r.state === "passed") && num(r.seconds_left) !== null;

  /**
   * The one deadline that belongs to the step this role is asked to do now, or null. A reveal is clocked to the row `reveal_start_by` only: the last
   * moment the reveal helper accepts (never the engine's cutoff, never the profile-table estimate, never the later re-send cutoff, which is a different
   * rule); a claim to the claim target (a height row: `unit` "blocks", with its block count). Every other step has no clock on this page (the lock has none by design).
   */
  function clockFor(rows, actionKind) {
    let row = null;
    if (actionKind === "reveal_eth") {
      row = rows.find((r) => r.id === "reveal_start_by") || null;
      if (row && row.source !== "sender-rule") row = null;
    } else if (actionKind === "claim_noid") row = rows.find((r) => r.id === "claim_target") || null;
    if (!live(row)) return null;
    const over = row.state === "passed" || row.seconds_left <= 0;
    const blocks = row.kind === "height" && num(row.blocks_left) !== null;
    return { row_id: row.id, label: row.label, seconds_left: over ? 0 : row.seconds_left, approx: !!row.approx, window_s: num(row.window_s), over, unit: blocks ? "blocks" : "time", blocks_left: blocks ? (over ? 0 : row.blocks_left) : null };
  }

  // Which state a lock's track is drawn in, from the ENGINE'S PHASE ID (the table is by phase; anything not in it gives no picture):
  //   none = not locked yet; sent = a send is out, not confirmed; pending = locked, not final; final;
  //   secret_public = the secret is public, the lock can be claimed at any moment; closing = its close is in a block, not final yet; closed.
  const TRACK_STATE = {
    alice: {
      created: ["none", "none"],
      funding_submitted: ["sent", "none"],
      funded: ["pending", "none"],
      funding_final: ["final", "none"],
      lock_seen: ["final", "pending"],
      lock_final: ["final", "final"],
      reveal_submitted: ["secret_public", "secret_public"],
      revealed: ["secret_public", "closing"],
      done: ["secret_public", "closed"],
    },
    bob: {
      received: ["none", "none"],
      funded: ["pending", "none"],
      funding_final: ["final", "none"],
      lock_submitted: ["final", "sent"],
      locked: ["final", "pending"],
      secret_seen: ["final", "secret_public"],
      claim_submitted: ["final", "secret_public"],
      claim_included: ["closing", "secret_public"],
      done: ["closed", "closed"],
    },
  };
  const ENDLESS = ["secret_public", "closing", "closed"]; // a track in one of these draws no end mark
  const MAX_SPAN_S = 7 * 86400;
  const MARKS = [
    ["reveal_start_by", "Start the reveal by"],
    ["t_reveal", "Bob can refund (T_reveal)"],
    ["reveal_cutoff", "Reveal cutoff"],
    ["reveal_resend_cutoff", "Re-send cutoff"],
    ["claim_target", "Claim target"],
    ["d", "D"],
  ];
  // the chain a mark belongs to (the track it sits on): the reveal rows are Ethereum time, the claim target and D are Parano1d heights
  const MARK_CHAIN = { reveal_start_by: "eth", t_reveal: "eth", reveal_cutoff: "eth", reveal_resend_cutoff: "eth", claim_target: "noid", d: "noid" };

  /** Both locks on one axis that starts at now, or null. Positions are rows' `seconds_left` as they are; the scale is the renderer's. */
  function pictureFor(rows, ctx) {
    const phase = ctx.phase;
    if (!phase || phase.terminal || phase.id === "aborted" || phase.known === false) return null;
    if (ctx.secret_may_be_public) return null; // the phase does not say so yet, but the secret may be public: the forward picture would mislead
    const states = (TRACK_STATE[ctx.role] || {})[phase.id];
    if (!states) return null; // unknown, recovery, lost, aborted: no forward picture
    const shown = (r) => !!r && !r.no_countdown && (r.state === "far" || r.state === "closing") && num(r.seconds_left) !== null && r.seconds_left > 0;
    const endOf = { noid: "d", eth: "t_reveal" };
    const hidden = new Set();
    if (ENDLESS.includes(states[0])) hidden.add("d");
    // once the secret is public (or the ETH lock is being closed or closed) the deadlines of a FIRST reveal say nothing about what happens next: not drawn (they stay in the Deadlines list; the re-send cutoff is still drawn)
    if (ENDLESS.includes(states[1])) for (const id of ["t_reveal", "reveal_start_by", "reveal_cutoff"]) hidden.add(id);
    const marks = [];
    for (const [id, short] of MARKS) {
      const r = rows.find((x) => x.id === id);
      if (!hidden.has(id) && shown(r)) marks.push({ row_id: id, short, chain: MARK_CHAIN[id], at_s: r.seconds_left, approx: !!r.approx, estimate: r.source === "profile-table" });
    }
    if (!marks.length) return null;
    marks.sort((a, b) => a.at_s - b.at_s);
    const span_s = Math.max(...marks.map((m) => m.at_s));
    if (span_s > MAX_SPAN_S) return null; // an absurd deadline must not stretch the page
    const track = (chain, state) => {
      const r = rows.find((x) => x.id === endOf[chain]);
      return { chain, state, end_s: !ENDLESS.includes(state) && shown(r) ? r.seconds_left : null };
    };
    const tracks = [track("noid", states[0]), track("eth", states[1])];
    const band = ctx.clock && !ctx.clock.over && ctx.clock.seconds_left > 0 ? { to_s: ctx.clock.seconds_left } : null;
    return { span_s, marks, tracks, band: ctx.stale ? null : band, stale: !!ctx.stale };
  }

  // ------------------------------------------------------------ where the labels of the picture go (display only)
  /** The width in px of a label at 12 px: Space Grotesk averages about 6.3 px a character, 6.9 in the medium weight. Wider on purpose: a box may be too wide, never too narrow. */
  const labelWidth = (text, medium) => Math.ceil(String(text).length * (medium ? 6.9 : 6.3)) + 4;

  /**
   * Places the labels of the marks around the two tracks so that no two boxes overlap and no leader line runs through a box. items: [{ id, x, w, track }] in time order (x the position
   * of the mark, w the width of its box, track "noid" | "eth"); geom: { left, right } the limits of a box; fixed: [{ track, x0, x1 }] the words that already sit in row 0 of the inner side of
   * their track (a track that is not locked says so there). A label goes on the outer side of its track (away from the other track) or the inner side (between them), in a row (0 is the
   * nearest to the line), starting at its mark or ending at it; the cheapest arrangement with no clash wins (near rows, the outer side and the start first). A leader runs from the line to
   * a label in a later row, and may not run through a nearer box. Returns { places: [{ id, track, lane, row, anchor, x0, x1, stem }], rows: { noid: { outer, inner }, eth: { outer, inner } } }:
   * lane "outer" | "inner", anchor "start" | "end" | "clamp" (a box that had to be moved to fit), stem the x of the leader or null. Only positions: it reads no time and decides nothing.
   */
  function placeMarks(items, geom, fixed) {
    const GAP = 8;
    const REACH = 3;
    const MAXROW = 6;
    const BUDGET = 40000;
    const CROSS = 25;
    const placed = [];
    const rows = { noid: { outer: 0, inner: 0 }, eth: { outer: 0, inner: 0 } };
    for (const f of fixed || []) {
      placed.push({ band: f.track + "inner", row: 0, x0: f.x0, x1: f.x1, stem: null });
      rows[f.track].inner = 1;
    }
    // null when the box would overlap another in its row (never allowed); else how many leaders would run through a box (allowed only as a last resort, at a high price)
    const crossings = (c) => {
      let n = 0;
      for (const q of placed) {
        if (q.band !== c.band) continue;
        if (q.row === c.row && c.x0 < q.x1 + GAP && c.x1 + GAP > q.x0) return null;
        if (c.stem !== null && q.row < c.row && c.stem > q.x0 - REACH && c.stem < q.x1 + REACH) n++;
        if (q.stem !== null && q.row > c.row && q.stem > c.x0 - REACH && q.stem < c.x1 + REACH) n++;
      }
      return n;
    };
    const optionsOf = (it) => {
      const fit = (x0) => x0 >= geom.left && x0 + it.w <= geom.right;
      const anchors = [];
      if (fit(it.x)) anchors.push(["start", it.x, 0]);
      if (fit(it.x - it.w)) anchors.push(["end", it.x - it.w, 0.5]);
      anchors.push(["clamp", Math.max(geom.left, Math.min(it.x - it.w / 2, geom.right - it.w)), 6]);
      const out = [];
      for (let row = 0; row < MAXROW; row++) for (const lane of ["outer", "inner"]) for (const [anchor, x0, extra] of anchors) out.push({ row, lane, anchor, x0, cost: row * 3 + (lane === "inner" ? 1 : 0) + extra });
      return out.sort((p, q) => p.cost - q.cost);
    };
    const opts = items.map(optionsOf);
    let best = null;
    let bestCost = Infinity;
    let bestCrossed = 0;
    let nodes = 0;
    const cur = [];
    const boxOf = (it, o) => ({ band: it.track + o.lane, row: o.row, x0: o.x0, x1: o.x0 + it.w, stem: o.row > 0 || o.anchor === "clamp" ? it.x : null });
    const rec = (i, cost, crossed) => {
      if (i === items.length) {
        best = cur.slice();
        bestCost = cost;
        bestCrossed = crossed;
        return;
      }
      for (const o of opts[i]) {
        if (cost + o.cost >= bestCost || nodes > BUDGET) break;
        nodes++;
        const c = boxOf(items[i], o);
        const x = crossings(c);
        if (x === null || cost + o.cost + x * CROSS >= bestCost) continue;
        placed.push(c);
        cur.push(o);
        rec(i + 1, cost + o.cost + x * CROSS, crossed + x);
        cur.pop();
        placed.pop();
      }
    };
    rec(0, 0, 0);
    // no arrangement within the budget (not expected with a handful of marks): one row each, so that no two boxes share a row
    if (!best) {
      bestCrossed = 1;
      best = items.map((it, i) => ({ row: i, lane: "outer", anchor: optionsOf(it)[0].anchor, x0: optionsOf(it)[0].x0 }));
    }
    const places = items.map((it, i) => {
      const o = best[i];
      const c = boxOf(it, o);
      rows[it.track][o.lane] = Math.max(rows[it.track][o.lane], o.row + 1);
      return { id: it.id, track: it.track, lane: o.lane, row: o.row, anchor: o.anchor, x0: c.x0, x1: c.x1, stem: c.stem };
    });
    return { places, rows, clean: bestCrossed === 0 };
  }

  // ------------------------------------------------------------ the two legs of a swap (the ticket)
  // For each phase of each role: the state of the leg the person gives and of the leg they get, with fixed words and one optional note. The states are the track states of
  // TRACK_STATE above (the table the picture uses: the first track is NOID, the second ETH), and the refund phases, which the picture does not draw, are added here.
  // A note that needs a time names the deadline row it comes from ("@back_d" = the NOID's deadline D, "@reveal_by", "@t_reveal"); the caller gives the words of that time.
  // States: none, sent, pending, final, secret_public, closing, closed, released (back with its owner), unknown. A phase that is not in the table gives "unknown" for both legs.
  const LEG_WORDS = {
    alice: {
      created: [["In your own wallet", "Nothing is locked yet."], ["With Bob", null]],
      funding_submitted: [["Being locked", "The funding may have been sent. The next readings show it."], ["With Bob", null]],
      funded: [["Locked, not final yet", "Waiting until it is final."], ["With Bob", null]],
      funding_final: [["Locked in the swap contract", "@back_d"], ["Bob has not locked yet", null]],
      lock_seen: [["Locked in the swap contract", "@back_d"], ["Locked by Bob, not final yet", "Waiting until Ethereum finalizes it."]],
      lock_final: [["Locked in the swap contract", "@back_d"], ["Locked by Bob, final", "@reveal_by"]],
      reveal_submitted: [["Bob can take it", "The secret is revealed."], ["Your reveal was sent", "Waiting for it to be mined."]],
      revealed: [["Bob can take it", "The secret is revealed."], ["Paid to you, not final yet", "Waiting until Ethereum finalizes it."]],
      done: [["Bob can take it", "The secret is revealed."], ["Paid to you", null]],
      refund_submitted: [["Coming back to you", "The recovery was sent. Waiting for it to be mined."], ["Stayed with Bob", null]],
      refund_included: [["Coming back to you", "The recovery is in a block. Waiting until it is final."], ["Stayed with Bob", null]],
      refunded: [["Back with you", "In this swap's wallet, then your own address."], ["Stayed with Bob", null]],
    },
    bob: {
      received: [["In your own wallet", "Nothing is locked yet."], ["With Alice", null]],
      funded: [["In this swap's own key", "Not locked yet."], ["Locked by Alice, not final yet", "Waiting until it is final."]],
      funding_final: [["In this swap's own key", "Not locked yet."], ["Locked by Alice, final", "@alice_back"]],
      lock_submitted: [["Being locked", "Your lock may have been sent. The next readings show it."], ["Locked by Alice, final", "@alice_back"]],
      locked: [["Locked for Alice", "@bob_back"], ["Locked by Alice, final", "The program collects it once the secret is revealed."]],
      secret_seen: [["Taken by Alice", "She revealed the secret on Ethereum."], ["Being collected for you", "It can only be paid to your address."]],
      claim_submitted: [["Taken by Alice", "She revealed the secret on Ethereum."], ["Being collected for you", "Your claim was sent. Waiting for it to be mined."]],
      claim_included: [["Taken by Alice", "She revealed the secret on Ethereum."], ["Being paid to you", "Your claim is mined. Waiting until it is final."]],
      done: [["Taken by Alice", null], ["Paid to you", null]],
      refund_submitted: [["Coming back to you", "The refund was sent. Waiting for it to be mined."], ["Stays with Alice", "@alice_back"]],
      refund_mined: [["Coming back to you", "The refund is mined, not final yet."], ["Stays with Alice", "@alice_back"]],
      refunded: [["Back with you", "In this swap's key, then your own address."], ["Stays with Alice", null]],
    },
  };
  // the refund phases are not in TRACK_STATE: the leg that comes back, and the leg that never moved (the first is the one the person gives)
  const REFUND_STATE = {
    alice: { refund_submitted: ["pending", "none"], refund_included: ["pending", "none"], refunded: ["released", "none"] },
    bob: { refund_submitted: ["pending", "final"], refund_mined: ["pending", "final"], refunded: ["released", "final"] },
  };
  const UNKNOWN_LEG = Object.freeze({ state: "unknown", words: "Not known", note: null });

  /**
   * The two legs of this swap as the ticket draws them: { give, get, public } where each leg is { coin, state, words, note } and `public` says whether the secret is public. `view` is a view
   * (or anything with `phase.id`); a view with no phase, a phase that is not in the tables, or `null` gives "unknown" for both legs, never a locked state. `opts.about(rowId)` returns the
   * words of a time from a deadline row ("about 16:22") or null; a note whose time is missing says "the deadline" instead of inventing one.
   */
  function legsFor(view, role, opts) {
    const r = role === "bob" ? "bob" : "alice";
    const about = opts && typeof opts.about === "function" ? opts.about : () => null;
    const coins = r === "alice" ? ["noid", "eth"] : ["eth", "noid"]; // [give, get]
    const unknown = () => ({ give: { coin: coins[0], ...UNKNOWN_LEG }, get: { coin: coins[1], ...UNKNOWN_LEG }, public: false });
    const id = view && view.phase && typeof view.phase.id === "string" ? view.phase.id : null;
    if (!id || (view.phase && view.phase.known === false)) return unknown();
    const own = (o, k) => (o && Object.prototype.hasOwnProperty.call(o, k) ? o[k] : undefined);
    const words = own(LEG_WORDS[r], id);
    const track = own(TRACK_STATE[r], id) || own(REFUND_STATE[r], id);
    if (id === "aborted" ? !(view.coins_at_contract && typeof view.coins_at_contract === "object") : !words || !track) return unknown(); // an aborted swap is told only from the view's own coins at the contract
    // Alice's secret may be public although the phase does not say so yet (a reveal in the mempool, a held reveal, a claim seen on Ethereum): the NOID leg is then open to Bob and the
    // calming note "comes back to you" is never drawn; what the ETH leg is cannot be told from here
    if (r === "alice" && view.secret_may_be_public === true && (id === "lock_seen" || id === "lock_final")) {
      return {
        give: { coin: coins[0], state: "secret_public", words: "Bob can take it", note: "The secret may already be public. If you stop now you can lose both legs." },
        get: { coin: coins[1], ...UNKNOWN_LEG },
        public: true,
        maybe: true,
      };
    }
    // the states are by track (NOID first, ETH second) in TRACK_STATE; the refund table is by leg (given first)
    const given = id === "aborted" ? null : own(REFUND_STATE[r], id) ? track : r === "alice" ? [track[0], track[1]] : [track[1], track[0]];
    const note = (n) => {
      if (n === null) return null;
      // the time is the card's own "back by about" (the deadline plus the blocks of the recovery); without it the note says "the deadline" and no time is invented
      if (n === "@back_d") return about("alice_back") ? `If the swap stops, it is back by ${about("alice_back")}.` : "Comes back to you after the deadline if the swap stops.";
      if (n === "@alice_back") return `Alice can take it back after ${about("d") || "the deadline"}.`;
      if (n === "@bob_back") return about("bob_back") ? `If she does not reveal, it is back by ${about("bob_back")}.` : "Comes back to you after the deadline if she does not reveal.";
      if (n === "@reveal_by") {
        const t = about("reveal_start_by") || about("reveal_cutoff");
        return t ? `The reveal is due before ${t}.` : null;
      }
      return n;
    };
    // an aborted swap, in the card's own words: Alice's NOID at the contract comes back after the deadline; with nothing locked, nothing is at stake
    if (id === "aborted") {
      const n = view.coins_at_contract && Array.isArray(view.coins_at_contract.instances) ? view.coins_at_contract.instances.length : 0;
      if (r === "alice" && n > 0) return { give: { coin: coins[0], state: "pending", words: "Coming back to you", note: note("@back_d") }, get: { coin: coins[1], state: "none", words: "Never locked", note: null }, public: false };
      return { give: { coin: coins[0], state: "none", words: "In your own wallet", note: "Nothing was locked." }, get: { coin: coins[1], state: "none", words: "Never locked", note: null }, public: false };
    }
    const leg = (i) => ({ coin: coins[i], state: given[i], words: words[i][0], note: note(words[i][1]) });
    const out = { give: leg(0), get: leg(1), public: false };
    // a restored stale copy whose own coins are already in (opts.coins_in, the autopilot view's restored coins_in): the leg the person gives is never drawn as "Nothing is locked yet" (rehearsal F2/F4)
    const coinsIn = !!(opts && opts.coins_in === true);
    if (coinsIn && r === "alice" && id === "created") out.give = { coin: coins[0], state: "pending", words: "Locked, being recorded", note: "Your NOID is at the swap contract. The program records it from the chain." };
    if (coinsIn && r === "bob" && (id === "received" || id === "funded" || id === "funding_final")) out.give = { coin: coins[0], state: "sent", words: "Your lock was sent", note: "The program finds it once Alice's funding is final." };
    // Alice's NOID after the swap is over: with the contract read and empty (the same facts that make the swap finished) Bob has taken it
    if (r === "alice" && id === "done" && view.finished === true && !view.leftover && view.coins_at_contract && view.coins_at_contract.known === true && view.coins_at_contract.count === 0) {
      out.give = { coin: coins[0], state: "closed", words: "Taken by Bob", note: null };
    }
    // Alice's ETH is paid to the swap's own key and swept to her address after: until the sweep is done it is not "Paid to you" (opts.sweep_pending), and it carries no mark of done
    if (r === "alice" && id === "done" && opts && opts.sweep_pending === true) {
      out.get = { coin: coins[1], state: "final", words: "In this swap's key, sending to you", note: null };
    }
    out.public = [out.give.state, out.get.state].some((x) => x === "secret_public" || x === "closing" || x === "closed");
    return out;
  }

  // ------------------------------------------------------------ the model
  /**
   * @param {object} input {role, now, tick, tick_mtime, tick_error, err_text, loop, terms, helpers, verify, commands:{bin}, demo}
   */
  function buildView(input) {
    const role = input.role === "bob" ? "bob" : "alice";
    const now = input.now;
    const tick = input.tick || null;
    const terms = termsOf(input);
    const loop = input.loop || null;
    const lastLoop = loop && loop.entries && loop.entries.length ? loop.entries[loop.entries.length - 1] : null;
    const profileId = terms.profile && PROFILES[terms.profile] ? terms.profile : terms.profile ? terms.profile : null;
    const gatesProfile = PROFILES[profileId] ? profileId : "production";

    const tTick = tickTime(tick, input.tick_mtime);
    const tickAge = tTick === null ? null : Math.max(0, now - tTick);
    const phaseId = (tick && tick.phase_after) || (lastLoop && lastLoop.phase_after) || null;
    const phaseSource = tick && tick.phase_after ? "tick" : lastLoop && lastLoop.phase_after ? "loop" : null;
    const info = phaseId ? P.phaseInfo(role, phaseId) : null;

    const act = actionOf(tick);
    const kind = act ? act.kind : lastLoop ? lastLoop.action : null;
    const actInfo = P.actionInfo(kind);
    const intent = tick && tick.intent && tick.intent.status && tick.intent.status !== "none" ? tick.intent : null;

    // A `done` swap with a leg left to refund is not "finished". Structured facts first (the engine's own `has_leftover_leg` reads the same two), the reason's words second.
    const ethFacts = (tick && tick.eth) || {};
    const leftoverFact = phaseId === "done" && (role === "alice" ? coinsAtContract(tick).instances.length > 0 : !!(ethFacts.lock && !ethFacts.lock.claimed && !ethFacts.lock.refunded && !ethFacts.claimed && !ethFacts.refunded));
    const leftover = leftoverFact || (act && act.reason ? E.leftoverReason(act.reason) : false);
    const finished = !!phaseId && (P.isTerminal(role, phaseId) || (phaseId === "done" && act && act.kind === "wait" && !leftover && !(intent && intent.status === "held")));
    const dl = deadlinesFor(role, tick, terms, gatesProfile, now, tickAge, phaseId, finished);
    const d = terms.d;
    const est = dl.estimates;
    const trRow = dl.rows.find((r) => r.id === "t_reveal");

    const noid = (tick && tick.noid) || {};
    const instance = noid.instance || null;

    // Which spending action is actually actionable now.
    const spending = !!(act && actInfo.spending && !act.withheld);
    // A HELD intent prints as `wait` (the ledger turns it into one), so the engine's fresh decision of the same tick is only in the note
    // "held: fresh decision was KIND" (lib/enginetext.js). The step is offered (commands, dry run, buttons) only when that fresh decision is the
    // held step itself: the engine's own wait reason otherwise leads, and nothing is offered. A reveal whose cutoff has passed is one such case.
    const heldIntentKind = intent && intent.status === "held" && intent.intent ? intent.intent.action : null;
    const heldFresh = heldIntentKind ? E.heldFreshDecision(tick.notes) : null;
    const heldOffered = !!heldIntentKind && heldFresh === heldIntentKind && !E.doNotSend(act && act.reason);
    const heldKind = heldOffered ? heldIntentKind : null;
    const heldNotOffered = heldIntentKind && !heldOffered ? { kind: heldIntentKind, fresh: heldFresh, cutoff_passed: E.revealCutoffHeld(act && act.reason) } : null;
    const cmdCtx = {
      bin: (input.commands && input.commands.bin) || "$L/bin",
      slot: instance ? instance.slot_index : null,
      creation: instance ? instance.creation_id : null,
      amount_text: terms.amount_micronoid !== null ? noidText(terms.amount_micronoid) : null,
    };
    const commandKind = spending ? kind : heldKind;
    const commands = commandKind ? commandsFor(role, commandKind, cmdCtx) : [];
    const dry = commandKind ? dryRunFor(commandKind, input.helpers, tick, terms, spending ? act : { params: (intent && intent.intent && intent.intent.params) || {} }, now) : null;

    // Status chip
    let status = "unknown";
    if (!tick) status = "no-data";
    else if (info && P.isTerminal(role, phaseId)) status = phaseId === "refunded" ? "refunded" : phaseId === "lost" ? "lost" : "aborted";
    else if (phaseId === "done") status = "settled";
    else if (spending) status = "act";
    else if (heldIntentKind) status = "held";
    else status = "waiting";
    if (tickAge !== null && tickAge > TICK_STALE_S && status !== "settled" && status !== "refunded" && status !== "aborted" && status !== "lost") {
      if (status === "act") status = "act-stale";
      else status = tickAge > TICK_DEAD_S ? "stale" : "waiting-stale";
    }

    const amountNoid = terms.amount_micronoid !== null ? terms.amount_micronoid : instance ? instance.amount_micronoid : null;
    const lock = lockOf(tick);
    const amountWei = terms.amount_wei !== null ? terms.amount_wei : lock ? lock.amount_wei : null;

    const coins = coinsAtContract(tick);
    // Alice's secret may be public before the phase says so (a dropped reveal goes back to lock_final): structured tick fields only, no text
    const ethTick = (tick && tick.eth) || {};
    const secretMayBePublic = role === "alice" && (phaseId === "lock_seen" || phaseId === "lock_final") && !!(ethTick.pending_preimage || ethTick.claimed || (tick && tick.reveal_maybe_pending === true) || revealMaybePendingCopy(tick) || (ethTick.lock && ethTick.lock.claimed) || (intent && intent.status === "held" && intent.intent && intent.intent.action === "reveal_eth"));
    const abort = abortPanel(role, phaseId, {
      secret_may_be_public: secretMayBePublic,
      d,
      blocks_to_d: est.tip !== null && d !== null ? d - est.tip : null,
      t_reveal: trRow ? trRow.target : null,
      t_reveal_s_left: trRow && trRow.seconds_left !== undefined ? trRow.seconds_left : null,
      coins,
      lock: lockOf(tick),
      eth_known: !!(tick && tick.eth && typeof tick.eth === "object"),
      bin: cmdCtx.bin,
    });
    // program mode (input.program) takes the network from run.json: the server refuses a swap whose files name another network (actions.production), and a production run.json is acted on
    const production = input.program === true ? false : isProduction(terms, tick);

    let alarms = alarmsFor(role, tick, loop, tickAge, input.err_text, input.tick_error, terms, dl.rows, now, finished, !!input.tick_writing, input.restored === true);
    // Which machine drives which role (machineStatus): the role that runs elsewhere has no file here, and that is not a problem.
    const machines = input.machines || null;
    const nameOf = (r) => (r === "alice" ? "Alice" : "Bob");
    const otherRole = role === "alice" ? "bob" : "alice";
    const note = (r) => (machines.inferred ? "There are no tick or loop files for " + nameOf(r) + " in this run folder, so " + nameOf(r) + " probably runs on another machine. That is not a problem. If this machine drives both roles, start the watch loop." : nameOf(r) + " runs on another machine: this console does not tick or spend for " + nameOf(r) + ", and what is missing here for that role is not a problem.");
    if (machines && machines[role] === "other" && !tick) {
      alarms = [{ level: "info", id: "other-machine", text: note(role) }];
      status = "remote";
    } else if (machines && machines[otherRole] === "other") {
      alarms = alarms.concat([{ level: "info", id: "other-machine", text: "The other role (" + nameOf(otherRole) + ") " + (machines.inferred ? "probably runs on another machine (no tick or loop files for it here)" : "runs on another machine") + ": its file and ticks are not used here, and nothing it is missing is a problem." }]);
    }

    if (tick && coins.instances.length && (phaseId === "aborted" || (role === "alice" && phaseId === "created" && act && act.kind === "abort"))) {
      alarms = alarms.concat([{ level: "attn", id: "coins-after-abort", text: `Aborted with coins at the contract: the last tick lists ${coins.instances.length} instance${coins.instances.length === 1 ? "" : "s"} (${coins.instances.map((i) => i.amount_text + " NOID").join(", ")}). See "Coins at the contract" below and the engine's notes.` }]);
    }
    if (production) alarms = [{ level: "danger", id: "production", text: PRODUCTION_TEXT }].concat(alarms);
    const heldParams = intent && intent.intent && intent.intent.params ? intent.intent.params : null;
    const timeline = phaseId ? timelineFor(role, phaseId) : null;
    const clock = clockFor(dl.rows, commandKind);
    const phaseView = phaseId ? { id: phaseId, known: !!info, terminal: P.isTerminal(role, phaseId) } : null;
    return {
      role,
      role_label: role === "alice" ? "Alice (NOID holder)" : "Bob (ETH holder)",
      demo: !!input.demo,
      now,
      header: {
        profile: profileId || (terms.hashlock || terms.d !== null ? "production" : null),
        profile_known: !!profileId,
        variant: terms.variant,
        amount_noid: amountNoid !== null ? noidText(amountNoid) : null,
        amount_eth: amountWei !== null ? ethText(amountWei) : null,
        alice_noid: terms.alice_noid,
        bob_noid: terms.bob_noid,
        noid: {
          tip: est.tip_observed,
          tip_estimate: est.tip,
          age_s: est.noid_age_s,
          state: tick ? ageState(est.noid_age_s) : "unknown",
          second: !!(noid.second),
          single: !!noid.single_node_ok,
        },
        eth: {
          block: est.eth_block,
          finalized: tick && tick.eth ? tick.eth.finalized_block : null,
          time: est.eth_time,
          chain_id: tick && tick.eth ? tick.eth.chain_id : terms.chain_id,
          age_s: est.eth_age_s,
          state: tick ? ageState(est.eth_age_s) : "unknown",
          second: !!(tick && tick.eth && tick.eth.second),
          single: !!(tick && tick.eth && tick.eth.single_node_ok),
        },
        tick: { at: tTick, age_s: tickAge, state: tickAge === null ? "unknown" : tickAge <= OBS_WARN_S ? "ok" : tickAge <= TICK_DEAD_S ? "attn" : "danger", applied: tick ? !!tick.events_applied_to_file && tick.observe_only !== true : null },
      },
      status,
      // nothing left to do: a terminal phase, or `done` with no leg left and no step on offer (the board's end screens read this, nothing else decides "over")
      finished,
      leftover: !!leftover,
      phase: phaseId
        ? {
            id: phaseId,
            label: info ? info.label : `Unrecognised phase "${phaseId}"`,
            known: !!info,
            terminal: P.isTerminal(role, phaseId),
            source: phaseSource,
            happening: info ? info.happening : "The UI does not know this phase. Read the engine's reason and the notes.",
            next: info ? info.next : "Follow the engine's reason; do not act on a phase you do not understand.",
            nothing: info ? info.nothing : "Unknown.",
          }
        : null,
      timeline,
      action: tick
        ? {
            kind,
            label: actInfo.label,
            plain: actInfo.plain,
            spending: !!actInfo.spending,
            actionable: spending,
            stale: tickAge !== null && tickAge > TICK_STALE_S,
            withheld: !!(act && act.withheld),
            withheld_note: act && act.withheld ? (tick.observe_only === true ? "Observing only: the program records what happens on the chains but decides nothing until you have approved and deposited." : "A read-only tick withholds a spend's parameters. The watch loop (tick --apply) records the intent first and prints them; wait for the next loop tick.") : null,
            reason: act ? act.reason : lastLoop ? lastLoop.reason : null,
            params: act ? act.params : {},
            notes: (tick.notes || []).map(String),
            intent: intent
              ? { status: intent.status, kind: intent.intent ? intent.intent.action : null, decided_at: intent.intent ? intent.intent.decided_at : null, params: heldParams, phase_at_decision: intent.intent ? intent.intent.phase_at_decision : null }
              : null,
            commands,
            command_kind: commandKind,
            dry_run: dry,
            events: (tick.events || []).map((e) => ({ event: e.event, detail: eventDetail(e) })),
            closed_by: tick.closed_by || null,
            // set when the intent is held and the engine's fresh decision of this tick is NOT that step: nothing of it is offered, the engine's reason leads
            held_not_offered: heldNotOffered,
            // the engine's loud notes, whole: ALARM / ANOMALY / ALERT: (shown with emphasis, never cut)
            // (the same note twice in one tick is shown once)
            loud_notes: [...new Set((tick.notes || []).map(String).filter((n) => E.isAlertNote(n) || E.isAlarmText(n)))],
          }
        : null,
      deadlines: dl.rows,
      deadlines_stale: dl.stale,
      clock,
      secret_may_be_public: secretMayBePublic,
      picture: pictureFor(dl.rows, { role, phase: phaseView, timeline, clock, stale: dl.stale, secret_may_be_public: secretMayBePublic }),
      lock_by_note: lockByNote(tick, !!phaseId && (P.isTerminal(role, phaseId) || phaseId === "aborted" || finished), tickAge !== null && tickAge > TICK_STALE_S),
      coins_at_contract: coins,
      producers: producerFigures(tick),
      production: production ? { read_only: true, text: PRODUCTION_TEXT } : null,
      abort,
      receipts: receiptsFor(tick, terms, input.helpers, input.verify),
      alarms,
      history: loop && loop.entries ? { entries: loop.entries.slice(-14), total: loop.total, changes: phaseChangesOf(loop.entries) } : null,
      sources: tick ? tick.sources || null : null,
      explain_cutoff_profile: gatesProfile,
    };
  }

  function eventDetail(e) {
    const parts = [];
    for (const k of ["height", "tip", "block_number", "was_height", "txid", "reason", "call_height"]) if (e[k] !== undefined && e[k] !== null) parts.push(`${k.replace("_", " ")} ${typeof e[k] === "string" && e[k].length > 20 ? e[k].slice(0, 8) + "…" + e[k].slice(-6) : e[k]}`);
    return parts.join(", ");
  }

  function phaseChangesOf(entries) {
    const out = [];
    let prev = null;
    for (const e of entries) {
      if (!e.phase_after) continue;
      if (prev !== null && e.phase_after !== prev) out.push({ time: e.time, from: prev, to: e.phase_after });
      prev = e.phase_after;
    }
    return out;
  }

  /**
   * Which machine drives which role: "here" | "other" | "unknown". A console started with --role alice|bob says so itself; a console on both
   * roles infers it: when only ONE role has tick or loop data in the run folder, the other one runs elsewhere (inferred: true).
   */
  function machineStatus(serverRole, roles) {
    if (serverRole === "alice") return { alice: "here", bob: "other", inferred: false };
    if (serverRole === "bob") return { alice: "other", bob: "here", inferred: false };
    const has = (r) => !!(roles && roles[r] && (roles[r].tick || roles[r].loop));
    if (has("alice") && !has("bob")) return { alice: "here", bob: "other", inferred: true };
    if (has("bob") && !has("alice")) return { alice: "other", bob: "here", inferred: true };
    return { alice: "unknown", bob: "unknown", inferred: false };
  }

  return {
    machineStatus,
    leadAction,
    fundingGuide,
    lockByNote,
    coinsAtContract,
    producerFigures,
    isProduction,
    PRODUCTION_TEXT,
    buildView,
    deadlinesFor,
    revealMaybePendingCopy,
    timelineFor,
    clockFor,
    pictureFor,
    placeMarks,
    labelWidth,
    legsFor,
    coinsAlreadyIn,
    abortPanel,
    commandsFor,
    alarmsFor,
    nowEstimates,
    ageState,
    fmtDur,
    noidText,
    ethText,
    PROFILES,
    BLOCK_S,
    TICK_STALE_S,
    TICK_DEAD_S,
  };
});
