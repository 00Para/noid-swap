/* noid-swap operator console, program mode: the card of one swap, one stage at a time (window.NoidStage).
   The card shows a progress line, ONE headline, ONE status line and at most one action. Everything else of the swap page (today's page, whole) is drawn as before into the
   closed "Details" fold below it. Folding is drawing only: this file sends nothing, decides nothing and adds no request; its boxes are the page's own builders
   (autopilotBlock, handoverBlock and checkLineBlock, depositCompact, spendBlock), so the statements, the typed amount, the dry run and the gates are the ones the server checks.
   The card never calls a stage calm on data it cannot place (an unknown phase, a stale reading, two nodes that disagree, a held step it cannot explain): it says "Something
   needs a look", gives the plain reason and opens Details. No inline styles or handlers (CSP). plan() is data only (no DOM), draw() builds the elements. */
(() => {
  "use strict";
  let H = null; // helpers handed over by operator.js
  const A = () => window.NoidActions;
  const V = () => window.NoidView;

  const PROGRESS = ["Set up", "Check", "Approve", "Deposit", "Swap", "Done"];
  const STAGE_AT = { setup: 0, check: 1, approve: 2, deposit: 3, swap: 4, done: 5, refund: 5, abort: 5 };

  // the phases of each role by what the card says of them
  const PHASES = {
    alice: { before: ["created"], flight: ["funding_submitted", "funded", "funding_final", "lock_seen", "lock_final", "reveal_submitted", "revealed"], refund: ["refund_submitted", "refund_included", "refunded"] },
    bob: { before: ["received", "funded", "funding_final"], flight: ["lock_submitted", "locked", "secret_seen", "claim_submitted", "claim_included"], refund: ["refund_submitted", "refund_mined", "refunded"] },
  };

  // The alarms of the view model that are a reason to say "needs a look": the ones that mean the page cannot trust what it shows. An alarm of level "danger" is always one. The
  // engine's own caution notes ("fail closed", "stale": a step that is not offered yet) and the warnings about a single node are in Details only.
  const LOOK_ATTN = /^(tick-stale|stale-|second-|noid-disagree|noid-instance-disagree|eth-lag|eth-head-old|noid-head-old|file-behind-chain|event-)/;

  const trimFrac = (s) => (String(s).includes(".") ? String(s).replace(/0+$/, "").replace(/\.$/, "") : String(s));
  const noidOf = (micro) => {
    try {
      return micro === null || micro === undefined ? null : `${trimFrac(V().noidText(micro))} NOID`;
    } catch {
      return null;
    }
  };
  const ethOf = (wei) => {
    try {
      const t = wei === null || wei === undefined ? null : V().ethText(wei);
      return t === null ? null : `${trimFrac(t)} ETH`;
    } catch {
      return null;
    }
  };

  /** The two amounts of the swap as words ("5 NOID", "0.001 ETH"): from the view when there is one, else from the terms of the payload. */
  function amounts(payload, view) {
    const t = (payload && payload.terms) || {};
    const h = view && view.header;
    const noid = h && h.amount_noid ? `${trimFrac(h.amount_noid)} NOID` : noidOf(t.amount_micronoid);
    const eth = h && h.amount_eth ? `${trimFrac(h.amount_eth)} ETH` : ethOf(t.eth && t.eth.amount_wei);
    return { noid, eth };
  }

  /** The two amounts of the swap from the list's summary of it (the program's own give and get, read from run.json): the fallback before the first reading. */
  function summaryAmounts() {
    const out = { noid: null, eth: null };
    const st = H && H.state;
    const s = st && st.program && Array.isArray(st.program.swaps) ? st.program.swaps.find((x) => x && x.swap === st.swap) : null;
    for (const h of s ? [s.give, s.get] : []) {
      if (h && (h.coin === "noid" || h.coin === "eth") && typeof h.text === "string" && /^[0-9][0-9.]*$/.test(h.text)) out[h.coin] = `${trimFrac(h.text)} ${h.coin === "noid" ? "NOID" : "ETH"}`;
    }
    return out;
  }

  /** A moment from the view model's own deadline row, never counted anew: `{ unix, passed }`, or null when the row is missing, stale, not relevant or has no countdown. */
  function rowTime(view, id, now) {
    const r = view && Array.isArray(view.deadlines) ? view.deadlines.find((d) => d.id === id) : null;
    if (!r || r.stale || r.relevant === false || r.no_countdown || !["far", "closing", "passed"].includes(r.state) || typeof r.target !== "number") return null;
    if (r.kind === "time") return { unix: r.target, passed: r.state === "passed" };
    if (typeof r.seconds_left === "number") return { unix: now + r.seconds_left, passed: r.state === "passed" };
    return null;
  }
  const about = (t) => (t ? `about ${A().card.hhmm(t.unix)}` : null);

  const clean = (list) => list.filter(Boolean);

  const upFirst = (t) => (t ? t.charAt(0).toUpperCase() + t.slice(1) : t);
  /**
   * The engine's words as the main view says them (display only; Details keeps the engine's own text): the level word the box already shows ("ALERT:", "ALARM:", "ANOMALY:") is dropped, the
   * heights of the lock-by margin "(lock-by N, tip M)" are left to Details, and "before D" says "before the deadline" (the name the card uses everywhere). Every other fact stays in the sentence.
   */
  function plainEngine(text) {
    const raw = String(text === null || text === undefined ? "" : text);
    const lead = /^\s*(?:ALERT|ALARM|ANOMALY):\s*/;
    const t = raw
      .replace(lead, "")
      .replace(/\s*\(lock-by \d+, tip \d+\)/g, "")
      .replace(/\b(before|after|until|by|at) D\b(?!\s*[-+\u2212])/g, "$1 the deadline")
      .trim();
    // once the level word is gone the sentence starts with its next word, in capitals; any other text keeps its first letter
    return lead.test(raw) ? upFirst(t) : t;
  }
  /** What a send step is called when the program has no record's label for it: the board's own plain words ("locking your ETH"), else the id as it is. */
  function stepName(id) {
    const W = typeof window !== "undefined" && window.NoidBoardView ? window.NoidBoardView.SPEND_WORDS : null;
    return W && Object.prototype.hasOwnProperty.call(W, id) ? upFirst(W[id]) : String(id || "A step");
  }

  // ------------------------------------------------------------------ plan (data only)
  /**
   * What the card says. input: { payload, role, view, error, now }. `view` is the view model of the swap page (null before its first reading, or when there is none).
   * Returns { drawn, kind, stage, headline, status, reasons, action, safety, claims, forceOpen, lookSig, view }:
   *   drawn      false when the card is not this page's (a production run, a board run, no actions): today's page is then shown as it is, with no fold
   *   kind       "setup" | "check" | "approve" | "deposit" | "swap" | "done" | "refund" | "abort" | "look"
   *   stage      the index in PROGRESS of the current stage, or -1 (a "look" never marks one)
   *   action     { kind: "none" | "button" | "invitation" | "handover" | "approval" | "deposit" | "spend", ... }
   *   tone       "act" (the swap waits on the person), "done", "look", or null for a calm stage: it only chooses the card's frame
   *   picture    { act } when the two locks are drawn on the main view (the Swap stage, a lock seen on either chain, or a lapsed approval), else null
   *   foot       the card's last line: { doing, stopped, read_age_s } (words from data the page already has), or null when the card says "needs a look"
   *   safety     the boxes that are always open above the headline (data; draw() builds them)
   *   claims     the boxes the card draws itself: { handover, autopilot, spend, step }; today's page does not draw them a second time (they carry element ids)
   */
  function plan(input) {
    const m = { drawn: false, kind: null, tone: null, foot: null, picture: null, stage: -1, headline: "", status: "", reasons: [], action: { kind: "none" }, safety: { loud: [], alarms: [], held: null, heldIntent: null, job: null, autopilot: false, lockBy: null }, claims: {}, forceOpen: false, lookSig: "", view: null, role: input.role };
    const Ac = A();
    if (!Ac || !Ac.card) return m;
    const payload = input.payload || null;
    const role = input.role === "alice" || input.role === "bob" ? input.role : null;
    const a = payload && payload.actions;
    if (a && (!a.enabled || a.production)) return m;
    if (a && role && Ac.card.isBoardRun(payload, role)) return m;
    m.drawn = true;
    const now = typeof input.now === "number" ? input.now : 0;
    const look = (...why) => {
      m.kind = "look";
      m.stage = -1;
      for (const w of why) if (w && !m.reasons.includes(w)) m.reasons.push(w);
    };
    if (input.error || !payload || !a || payload.readable === false || !role) {
      look(input.error ? `The program did not give this swap: ${input.error}` : !role ? "The role of this swap is not known." : "This swap's folder cannot be read.");
      m.headline = "Something needs a look";
      m.tone = "look";
      m.forceOpen = true;
      m.lookSig = JSON.stringify(m.reasons);
      return m;
    }

    const pre = Ac.program.startKind(payload, role);
    const view = pre ? null : input.view || null;
    const x = (a.autopilot && a.autopilot[role]) || null;
    const lineHex = Ac.card.checkLineOf(a, role).hex;
    const confirmed = !!(a.line_match && lineHex && a.line_match.hex === lineHex);
    const on = !!(x && x.on === true);
    const phaseId = pre ? (role === "alice" ? "created" : "received") : view && view.phase ? view.phase.id : null;
    // the page's own builders take a view; before the first reading it is the synthetic one the first screen uses
    const boxView = pre ? { role, phase: { id: phaseId } } : view;
    m.view = boxView;
    const amt = amounts(payload, view);
    const funded = role === "alice" && Ac.card.fundingRecorded(a);
    const own = payload.program && typeof payload.program.own_noid === "string" && payload.program.own_noid ? payload.program.own_noid : null;
    const w = Ac.wallet.walletOf(a);
    const swept = (w && w.swept) || {};
    const ethPayout = w && w.eth_payout ? H.short(w.eth_payout) : null;

    // ---- safety: what is always open above the headline
    // the engine's note on the lock-by or the funding window, with the view model's own level ("has passed", "is closed": danger; "is short": warn)
    const lb = view && view.lock_by_note && !view.lock_by_note.stale ? view.lock_by_note : null;
    // The engine's "nominal lock-by N has passed (tip T); the lock is still allowed until [at most] the hard limit H" is printed only while it still offers Bob's lock: the words
    // "has passed" rate it danger, but it is a warning (Bob can still save the swap by topping up), so the card keeps the deposit stage and shows the note in a box. The forms that say
    // the lock is no longer possible ("lock-by N has passed: tip T is K blocks beyond it", "the last lock height H has passed") stay danger.
    const lbLevel = lb ? (lb.level === "danger" && /; the lock is still allowed until /.test(lb.text) ? "warn" : lb.level) : null;
    if (view) {
      const loudList = view.action && view.action.loud_notes ? view.action.loud_notes : [];
      for (const n of loudList) m.safety.loud.push(n);
      const loud = new Set(loudList);
      // danger alarms are copied whether or not the tick has an action (an unreadable tick has none)
      for (const al of view.alarms || []) if (al.level === "danger" && !loud.has(al.text)) m.safety.alarms.push(al.text);
      if (view.action && view.action.held_not_offered) m.safety.held = { reason: view.action.reason || null };
      else if (view.action && view.action.intent && view.action.intent.status === "held") m.safety.heldIntent = { kind: view.action.intent.kind || null };
      if (lb && lbLevel === "warn") m.safety.lockBy = lb.text;
    }
    m.safety.job = lastSendJob(a);
    const needs = x && Array.isArray(x.needs_you) ? x.needs_you.length > 0 : false;
    const changed = !!(x && x.terms_changed === true);

    // ---- what the card cannot place: it says so and never guesses a calm stage
    const unplaced = [];
    if (!w) unplaced.push("This swap does not use the program's own wallets, so the card cannot place it. Open Details.");
    if (!pre && w) {
      if (!view) unplaced.push("The program could not read this swap's state.");
      else if (!view.phase) {
        if (!funded) unplaced.push("There is no reading of the chains for this swap yet, so the program cannot say where it is.");
      } else if (!view.phase.known) unplaced.push(`The program does not know this swap's state ("${view.phase.id}"). Read the engine's reason in Details.`);
      else if (view.phase.id === "lost") unplaced.push("Both legs of this swap are gone: the reveal was still pending when the other side refunded and took the NOID. Nothing can be recovered on a chain; keep the files.");
      // a funding that was sent has its marker: the card says only that, before the first reading after it
      const onlyMarker = !!(view && !view.phase && funded);
      if (view && !onlyMarker && ["stale", "waiting-stale", "act-stale", "no-data", "unknown", "remote"].includes(view.status) && !(view.phase && view.phase.terminal)) {
        // with no reading at all (no-data) the age of the tick file's mtime says nothing: the sentence about the missing reading stands alone
        const age = view.status === "no-data" ? null : view.header && view.header.tick && view.header.tick.age_s;
        unplaced.push(typeof age === "number" ? `The last reading of the chains is ${V().fmtDur(age)} old. The program only acts on fresh readings.` : "The program has no fresh reading of the chains.");
      }
      if (view) {
        for (const al of view.alarms || []) {
          if (al.level === "attn" && LOOK_ATTN.test(al.id || "")) unplaced.push(al.text);
          else if (al.level === "danger" && !unplaced.includes("The engine raised an alarm: it is shown above.")) unplaced.push("The engine raised an alarm: it is shown above.");
        }
        if (lb && lbLevel === "danger") unplaced.push(lb.text);
        if (m.safety.held) unplaced.push("The engine froze a step earlier and does not offer it now. Do not send it: read the engine's reason in Details.");
      }
    }

    // ---- the stage
    const set = (kind, headline, status, action) => {
      m.kind = kind;
      m.stage = STAGE_AT[kind];
      m.headline = headline;
      m.status = status;
      m.action = action || { kind: "none" };
      // the card holds the step's button (or the two files of an invitation): the technical page under Details does not draw it a second time
      m.claims.step = m.action.kind === "button" || m.action.kind === "invitation";
    };
    const ph = PHASES[role];
    const needApprove = () => {
      // the approval box of this role, or the reason it cannot be drawn (the page never invents one)
      if (!x || x.available !== true || !Ac.autopilotFacts(boxView, payload)) {
        unplaced.push("The program cannot offer its approval for this swap now. Open Details to act by hand.");
        return false;
      }
      return true;
    };

    if (unplaced.length) look(...unplaced);
    else if (pre && !payloadHasSwapFile(payload, role, Ac)) placeSetup();
    else placeFromPhase();

    function placeSetup() {
      const f = Ac.program.startFacts(payload, role);
      const steps = Ac.program.steps(f);
      const next = steps.find((s) => s.state === "now") || null;
      if (!next) {
        if (!Ac.card.haveSwapFile(payload, role)) {
          set("setup", "Setting up this swap", "The swap file is made. The program is reading it.");
          return null;
        }
        return placeFromPhase();
      }
      if (next.id === "make") {
        if (f.make.failed) {
          const jobId = f.make.failed === "setup" ? "setup" : `wallet-setup-${role}`;
          const rec = [...(a.jobs || [])].filter((j) => j && j.id === jobId).slice(-1)[0];
          const why = rec ? firstLine(rec.error || rec.stderr || rec.stdout) : null;
          set("setup", "Setting up this swap did not finish", `${Ac.card.PROGRAM_SAY.make_failed}${why ? ` The last result says: ${why}` : ""}`, { kind: "button", id: jobId, label: "Try again", primary: true });
          m.forceOpen = true;
          return null;
        }
        set("setup", "Setting up this swap", `${role === "alice" ? "Making this swap's own wallet." : "Making this swap's own Ethereum key."} Nothing is sent.${f.make.waiting ? ` Waiting: ${f.make.waiting}.` : ""}`);
        return null;
      }
      if (role === "alice") {
        if (next.rec === "failed") {
          set("setup", "Preparing the swap did not finish", "The last run did not end cleanly. Its result is in Details: read it before you run the step again.", { kind: "button", id: "prepare", label: "Prepare the swap file", primary: true });
          m.forceOpen = true;
        } else if (next.rec === "running") set("setup", "Preparing the swap", "Running now. The result shows here when it ends.");
        else set("setup", "Prepare the swap when Bob is ready", "From then on you have about 25 minutes to deposit, or the swap does not start. Nothing is lost then.", { kind: "button", id: "prepare", label: "Prepare the swap file", primary: true });
        return null;
      }
      // Bob: his invitation, then Alice's file; both stay reachable (the invitation file is made again at any time)
      if (next.rec === "failed") {
        set("check", "Checking Alice's file did not finish", "The last run did not end cleanly. Its result is in Details: read it before you run the step again.", { kind: "invitation", first: "join" });
        m.forceOpen = true;
      } else if (next.rec === "running") set("check", "Checking Alice's file", "Running now. The result shows here when it ends.");
      else {
        const saved = Ac.card.noteOf("invitation");
        if (saved && saved.ok === true) set("check", "Choose Alice's swap file", "The program checks it against your own terms. Nothing is sent.", { kind: "invitation", first: "join" });
        else set("setup", "Send Alice your invitation", "Then wait for her swap file and choose it here. Do not send coins yet.", { kind: "invitation", first: "invitation" });
      }
      return null;
    }

    function placeFromPhase() {
      const id = phaseId;
      // a phase that is over or going back first: it does not depend on the approval
      if (view && view.phase) {
        if (id === "done" && view.leftover) {
          set("swap", "The swap is settled, one step is left", "The engine shows a leg that still has to be taken back. The program does it when it can. Read the engine's reason in Details.");
          return null;
        }
        if (id === "done") {
          if (role === "alice") set("done", "Swap complete", swept.eth_alice ? `${amt.eth || "Your ETH"} was sent to ${ethPayout || "your own address"}.` : `${amt.eth || "Your ETH"} arrived in this swap's own key. It goes to ${ethPayout ? "your own address " + ethPayout : "your own address"} when the swap is swept.`);
          else set("done", "Swap complete", `${amt.noid || "Your NOID"} was sent to ${own ? H.short(own) : "your Parano1d address"}.`);
          return finishTerminal();
        }
        if (ph.refund.includes(id)) {
          if (role === "alice") set("refund", "The swap did not go through", id === "refunded" ? "Your NOID is back in this swap's wallet. The program sends it to your own address." : id === "refund_included" ? "Your NOID is being taken back: the recovery is in a block, and the program waits until it is final." : "Your NOID is being taken back: the recovery was sent, and the program waits for it to be mined.");
          else set("refund", "The swap did not go through", id === "refunded" ? "Your ETH is back in this swap's key. The program sends it to your own address." : "Your ETH is being refunded to this swap's key, then to your own address.");
          return finishTerminal();
        }
        if (id === "aborted") {
          const coins = view.coins_at_contract && view.coins_at_contract.instances ? view.coins_at_contract.instances.length : 0;
          const lockOpen = role === "bob" && openEthLock(payload, role);
          if (lockOpen) {
            look("Your ETH may still be locked on Ethereum: the engine ended this swap file. Read its reason and the contract in Details.");
            return null;
          }
          const reason = view.action && view.action.reason ? ` The engine says: ${view.action.reason}` : "";
          if (role === "alice" && coins > 0) set("abort", "The swap did not go through", `Your NOID comes back after the deadline, then goes to your own address.${reason}`);
          else set("abort", "This swap did not start", `Nothing was locked. What you deposited goes back to your own addresses.${reason}`);
          return finishTerminal();
        }
      }
      // before the funding (Alice) or the lock (Bob): the file, the check lines, the approval, the deposit
      if (ph.before.includes(id) || (view && !view.phase && funded)) {
        if (!on && !funded) {
          if (!confirmed) {
            const hov = Ac.handoverBlock(boxView, payload);
            if (!hov) return look("The check line cannot be shown now. Open Details to read the step's result.");
            set("check", role === "alice" ? "Send Bob your file, then compare check lines" : "Compare check lines with Alice", role === "alice" ? "Bob checks your file on his machine. Then read your check lines to each other." : "You checked Alice's file. Now read your check lines to each other.", { kind: "handover" });
            m.claims.handover = true;
            return null;
          }
          if (!needApprove()) return look(...unplaced);
          set("approve", changed ? "Approve this swap again" : "Approve this swap", "Nothing is sent until you approve.", { kind: "approval" });
          m.claims.autopilot = true;
          return null;
        }
        if (funded) {
          set("swap", "Your funding was sent", "The next readings follow it. Never fund a second time.");
          return null;
        }
        if (Ac.card.depositSeen(a, role)) {
          if (pre) set("swap", "Deposit received", "Waiting for the first reading of the chains.");
          else if (role === "alice") set("swap", "Deposit received", `The program is putting ${amt.noid ? "your " + amt.noid : "your NOID"} into the swap contract.`);
          else if (id === "funding_final") set("swap", "Alice's funding is final", "Your lock goes out as soon as the engine allows it. Nothing is sent twice.");
          else if (id === "funded") set("swap", "Alice's NOID is seen", "Waiting until it is final. Nothing of yours is locked yet.");
          else set("swap", "Waiting for Alice's funding", "Deposit received. Nothing of yours is locked yet.");
          return null;
        }
        const words = Ac.card.depositWords(a, role);
        // the step waits only for this deposit when Bob's funding is final, or Alice's funding window is running: say so, with the engine's own words about the time or the margin
        const E = window.NoidEngineText;
        const lbSay = lb ? ` The engine says: ${plainEngine(lb.text)}` : "";
        let say = role === "alice" ? "The program starts as soon as both deposits are seen." : "Your lock goes out once Alice's funding is final and your deposit is seen.";
        if (role === "bob" && id === "funding_final") say = `Alice's funding is final: your lock waits only for your deposit.${lbSay}`;
        else if (role === "alice" && lb && E && typeof E.fundingBlocksLeft === "function" && E.fundingBlocksLeft(lb.text) !== null && E.fundingBlocksLeft(lb.text) >= 0) say = `The funding waits only for this deposit.${lbSay}`;
        set("deposit", words ? `Deposit ${words}` : "Wait before you deposit", say, { kind: "deposit" });
        return null;
      }
      if (view && ph.flight.includes(id)) {
        if (!on) {
          // the approval is not in force (never given, or it lapsed): the card offers it again, once it can
          if (changed || confirmed) {
            if (!needApprove()) return look(...unplaced);
            const late = timePassed(id);
            if (late) return look(late);
            // the swap is in flight: the progress line stays on Swap, and the card says by when the approval is needed
            set("approve", changed ? "Approve this swap again" : "Approve this swap", `The program is not driving this swap until you approve.${flightDeadline(id)}`, { kind: "approval" });
            m.stage = STAGE_AT.swap;
            m.claims.autopilot = true;
            return null;
          }
          return look("No approval is in force, so the program is not driving this swap. Open Details to act by hand.");
        }
        placeFlight(id);
        return null;
      }
      return look("The program cannot place this swap's state. Open Details.");
    }

    function placeFlight(id) {
      if (role === "alice") {
        if (id === "funding_submitted") set("swap", "Your funding was sent", "Waiting for it to show in a block. Never fund a second time.");
        else if (id === "funded") set("swap", "Your NOID is in the swap contract", "Waiting until it is final.");
        else if (id === "funding_final") {
          const d = rowTime(view, "d", now);
          set("swap", "Waiting for Bob to lock his ETH", `If Bob does not lock, your NOID comes back after ${d && !d.passed ? about(d) : "the deadline"}.`);
        } else if (id === "lock_seen") set("swap", "Bob's lock is seen", "Waiting until Ethereum finalizes it, usually 15 to 20 minutes. Revealing earlier would be a risk.");
        else if (id === "lock_final") {
          const late = timePassed(id);
          if (late) return look(late);
          const t = rowTime(view, "reveal_start_by", now) || rowTime(view, "reveal_cutoff", now);
          set("swap", "Bob locked. Collecting your ETH", `The program reveals the secret on Ethereum${t && !t.passed ? " before " + about(t) : ""}.`);
        } else if (id === "reveal_submitted") set("swap", "Your reveal was sent", "Waiting for it to be mined.");
        else set("swap", "Your reveal is mined", "Waiting until Ethereum finalizes it.");
        return null;
      }
      if (id === "lock_submitted") set("swap", "Your lock is being sent", "Waiting for it to be mined. It is never sent twice.");
      else if (id === "locked") {
        const t = rowTime(view, "t_reveal", now);
        if (t && t.passed) set("swap", "Your ETH is locked", "Your ETH can be refunded now. The program does it when the engine says so.");
        else set("swap", "Your ETH is locked", `Waiting for Alice to reveal the secret${t ? ", until " + about(t) : ""}. If she does not, your ETH comes back.`);
      } else if (id === "secret_seen") {
        const late = timePassed(id);
        if (late) return look(late);
        const t = rowTime(view, "claim_target", now);
        set("swap", "Collecting your NOID", `The program claims the NOID by itself${t ? " before " + about(t) : ""}.`);
      } else if (id === "claim_submitted") set("swap", "Collecting your NOID", "The claim was sent. Waiting for it to be mined.");
      else set("swap", "Collecting your NOID", "The claim is mined. Waiting until it is final.");
      return null;
    }

    /** The words of a deadline of this phase that has passed while the step is still open (a reveal that cannot start, a claim that is late), or null. */
    function timePassed(id) {
      if (role === "alice" && id === "lock_final") {
        const cut = rowTime(view, "reveal_cutoff", now);
        const startBy = rowTime(view, "reveal_start_by", now);
        if (cut && cut.passed) return "The time to reveal the secret has passed. Read the engine's reason in Details.";
        if (startBy && startBy.passed) return "The last moment to start the reveal has passed. The program's helper refuses a reveal after it. Read the engine's reason in Details.";
      }
      if (role === "bob" && id === "secret_seen") {
        const t = rowTime(view, "claim_target", now);
        if (t && t.passed) return "The time to claim the NOID is nearly over. Read the engine's reason in Details.";
      }
      return null;
    }

    /** What to add to the status of a lapsed approval: the deadline of the phase's own step, from the view model's rows. */
    function flightDeadline(id) {
      const pick = (...ids) => {
        for (const r of ids) {
          const t = rowTime(view, r, now);
          if (t && !t.passed) return t;
        }
        return null;
      };
      if (role === "alice" && id === "lock_final") {
        const t = pick("reveal_start_by", "reveal_cutoff");
        if (t) return ` Approve before ${about(t)}, or the reveal does not go out.`;
      } else if (role === "bob" && id === "secret_seen") {
        const t = pick("claim_target");
        if (t) return ` Approve before ${about(t)}, or the claim is late.`;
      } else if (role === "bob" && id === "locked") {
        const t = pick("t_reveal");
        if (t) return ` Alice can reveal until ${about(t)}; approve before then, so the claim is not late.`;
      }
      const d = pick("d");
      return d ? ` The deadline is ${about(d)}.` : "";
    }

    function finishTerminal() {
      // with no approval in force a step may be left for the person (a recovery, a sweep): its own box is the card's one action
      if (!on) {
        const sp = Ac.spendBlock(boxView, payload);
        if (sp) {
          m.action = { kind: "spend" };
          m.claims.spend = true;
        }
      }
      return null;
    }

    // the approval box is also drawn above the headline when it has something to say (a step that needs the person, terms that changed)
    // (only when the box can be drawn: with no view it cannot, and Details must keep it)
    if (!m.claims.autopilot && (needs || changed) && x && x.available === true && Ac.autopilotFacts(boxView, payload)) {
      m.safety.autopilot = true;
      m.claims.autopilot = true;
    }
    // while the approval is on, why the program is not moving is the autopilot's own "Waiting for": it belongs on the card
    if (on && x.waiting_reason && (m.kind === "deposit" || m.kind === "swap")) m.status += ` Waiting for: ${x.waiting_reason}${/[.!?]$/.test(String(x.waiting_reason)) ? "" : "."}`;
    if (m.kind === "look") {
      m.headline = "Something needs a look";
      m.status = "The program cannot say for sure where this swap is, so it shows no step. Details is open below.";
      m.forceOpen = true;
      m.lookSig = JSON.stringify(m.reasons);
      m.stage = -1;
      m.action = { kind: "none" };
      m.claims.handover = false;
      m.claims.spend = false;
      m.claims.step = false;
      if (m.claims.autopilot && !m.safety.autopilot) m.claims.autopilot = false;
    }
    // the frame: amber while the swap waits on the person (an action of the card, the approval, the deposit, or a step that needs an answer), mint when it is settled, the alarm colour for a look
    m.tone = m.kind === "look" ? "look" : m.kind === "done" ? "done" : m.action.kind !== "none" || m.kind === "approve" || m.kind === "deposit" || needs || m.safety.autopilot ? "act" : null;
    m.foot = m.kind === "look" ? null : footOf(m, a, x, view, on, needs);
    if (m.kind === "done") m.done = doneFacts(a, role, amt, swept, own);
    // "The two locks, from now" is on the main view only at the Swap stage, and only once a lock is seen on either chain (a track in a state other than "not locked yet") or while an
    // approval that lapsed in flight is asked for again (the stage stays Swap): before that it stays in Details. The view model's own picture; nothing is computed here.
    const pic = view && view.picture;
    if (m.kind !== "look" && m.stage === STAGE_AT.swap && pic && Array.isArray(pic.tracks) && (m.kind === "approve" || pic.tracks.some((t) => t.state !== "none"))) m.picture = { act: m.tone === "act" };
    return m;
  }

  /**
   * The finished swap's summary: what was given and what was got (the two amounts of the swap, each with where it went), and the rows the data supports. The only rows are from an
   * Ethereum sweep's own result file (the amount left over that it sent, and the fee of that transfer); a row with no data is not made. null when an amount is not known.
   */
  function doneFacts(a, role, amt, swept, own) {
    const G = AMOUNT_RE.exec(String((role === "alice" ? amt.noid : amt.eth) || ""));
    const T = AMOUNT_RE.exec(String((role === "alice" ? amt.eth : amt.noid) || ""));
    if (!G || !T) return null;
    const on = role === "alice" ? ["for Bob, on Parano1d", swept.eth_alice ? "sent to your own Ethereum address" : "in this swap's own Ethereum key"] : ["paid to Alice on Ethereum", own ? "sent to your own Parano1d address" : "on Parano1d"];
    const rows = [];
    const sw = ethSweepOf(a, role);
    if (sw) {
      const left = ethOf(sw.valueWei);
      const fee = ethOf(sw.feeWei);
      if (left) rows.push({ label: "Left over, sent to you", value: sw.payout ? `${left} to ${H.short(sw.payout)}` : left });
      if (fee) rows.push({ label: "Network fee of that transfer", value: fee });
    }
    return { gave: { text: G[0], num: G[1], tic: G[2], on: on[0] }, got: { text: T[0], num: T[1], tic: T[2], on: on[1] }, rows };
  }

  /** The newest clean Ethereum sweep of this role that has a result file with its own figures: { valueWei, feeWei, payout }, or null. */
  function ethSweepOf(a, role) {
    const jobs = ((a && a.jobs) || []).filter((j) => j && j.id === `send-sweep-eth-${role}` && j.state === "done" && j.ok === true);
    for (let i = jobs.length - 1; i >= 0; i--) {
      const f = Array.isArray(jobs[i].files) ? jobs[i].files[0] : null;
      const sw = f && f.summary && f.summary.sweep;
      if (sw && /^[0-9]+$/.test(String(sw.valueWei)) && /^[0-9]+$/.test(String(sw.feeWei))) return { valueWei: sw.valueWei, feeWei: sw.feeWei, payout: typeof sw.payout === "string" ? sw.payout : null };
    }
    return null;
  }

  const sentence = (t) => {
    const v = String(t || "").trim();
    return v ? v.charAt(0).toUpperCase() + v.slice(1) + (/[.!?]$/.test(v) ? "" : ".") : "";
  };

  /**
   * The card's last line, from data the page already has: what the program is doing (the approval's own words), or that it is stopped on a step that needs an answer or is still running,
   * and how old the reading of the chains is. "Nothing for you to do." is added only when the card has no action, no step that needs an answer and no safety box of any kind.
   */
  function footOf(m, a, x, view, on, needs) {
    const Ac = A();
    const out = { doing: "", stopped: null, read_age_s: null };
    const busy = a && a.busy && typeof a.busy === "object" ? a.busy : null;
    if (needs) out.stopped = "Stopped on this step until you answer";
    else if (busy) {
      const rec = (a.jobs || []).find((j) => j && j.job === busy.job);
      const label = (rec && rec.label) || stepName(busy.id);
      out.stopped = `${label}: ${Number.isFinite(busy.started_at) ? "started " + Ac.card.hhmm(busy.started_at) + ", " : ""}no result yet`;
    }
    if (m.kind === "done" || m.kind === "refund" || m.kind === "abort") out.doing = "The transaction ids are under Details, Receipts.";
    else {
      out.doing = on ? sentence(x && x.doing) || "The program is driving this swap." : "The program is not driving this swap.";
      const s = m.safety;
      const quiet = m.action.kind === "none" && !needs && !out.stopped && !s.loud.length && !s.alarms.length && !s.held && !s.heldIntent && !s.job && !s.lockBy && !s.autopilot && !!(H && H.state && H.state.token) && !Ac.card.pendingLock(a);
      // (only while the program is driving: when it is not, "nothing for you to do" would be false, the person has to approve)
      if (quiet && on) out.doing += " Nothing for you to do.";
    }
    const tick = view && view.status !== "no-data" && view.header && view.header.tick;
    if (tick && Number.isFinite(tick.age_s)) out.read_age_s = tick.age_s;
    return out;
  }

  const firstLine = (t) => {
    const l = String(t || "").split("\n").map((x) => x.trim()).filter(Boolean).slice(-1)[0];
    return l ? (l.length > 200 ? l.slice(0, 200) + "…" : l) : null;
  };

  function payloadHasSwapFile(payload, role, Ac) {
    return Ac.card.haveSwapFile(payload, role);
  }

  /** The tick's own fact that an Ethereum lock of this swap is open (not claimed, not refunded): the one thing that changes what an aborted Bob may say. */
  function openEthLock(payload, role) {
    const r = payload && payload.roles && payload.roles[role];
    const eth = r && r.tick && r.tick.eth;
    const lock = eth && eth.lock;
    return !!(lock && !lock.claimed && !lock.refunded && !eth.claimed && !eth.refunded);
  }

  /** The newest send step's result when it needs to be read: a warning, a refusal, a timeout, an exit code 1 of a send. null for a clean or a running one (the "still running" banner covers that). */
  function lastSendJob(a) {
    const C = A().card;
    const j = (a.jobs || []).filter((x) => x && C.SPEND_ORDER.includes(x.id)).slice(-1)[0];
    if (!j || j.state === "running") return null;
    const lines = [];
    if (j.warning) lines.push(j.warning);
    if (j.state === "done" && j.exit_code === 1 && C.CODE1_IDS.includes(j.id)) lines.push(C.CODE1_ADVICE);
    if (j.timed_out) lines.push("The helper timed out here but may still have sent the transaction. Do not send it again: watch the next ticks.");
    if (j.ok !== true) {
      if (j.nothing_sent) lines.push(`Refused, nothing sent (exit ${j.exit_code}).`);
      else if (!lines.length) lines.push(`This step did not end cleanly${j.exit_code !== null && j.exit_code !== undefined ? ` (exit ${j.exit_code})` : ""}.`);
    }
    if (j.error) lines.push(j.error);
    return lines.length ? { label: j.label || j.id, lines } : null;
  }

  // ------------------------------------------------------------------ draw
  const coinText = (s) => String(s).split(/\b(NOID|ETH)\b/).map((p) => (p === "NOID" ? H.el("span", { class: "c-noid", text: p }) : p === "ETH" ? H.el("span", { class: "c-eth", text: p }) : p));

  const ic = (name) => (H && H.icon ? H.icon(name) : null);

  /** "Chains read 4 s ago": the age of the newest reading, from the view model's own figure. */
  const readText = (age) => `Chains read ${V().fmtDur(age)} ago`;

  function footLine(m) {
    const f = m.foot;
    if (!f) return null;
    const p = H.el("p", { class: "sc-foot" }, H.el("span", { class: "live" + (f.stopped ? " stop" : ""), text: f.stopped || f.doing }));
    if (f.read_age_s !== null) p.appendChild(H.el("span", { class: "right", text: readText(f.read_age_s) }));
    return p;
  }

  /** Once a second, from the page's clock: only the age in the foot, so that it never shows a reading as younger than it is. */
  function tick(view) {
    if (typeof document === "undefined" || !view) return;
    const foot = document.querySelector(".sc-foot");
    const n = foot ? foot.querySelector(".right") : null;
    const t = view.status !== "no-data" && view.header && view.header.tick;
    if (n && t && Number.isFinite(t.age_s)) n.textContent = readText(t.age_s);
  }

  function progress(m) {
    const ol = H.el("ol", { class: "sc-progress", "aria-label": "Progress of this swap" });
    PROGRESS.forEach((name, i) => {
      let st = m.stage < 0 ? "todo" : i < m.stage ? "done" : i === m.stage ? (m.kind === "done" || m.kind === "refund" || m.kind === "abort" ? "done" : "now") : "todo";
      // an approval that lapsed in flight is asked for again: Approve is not done, though the swap is further on
      // (it is drawn with the "needs you" ring, not hollow, so that the line reads as one rail: the swap is on, and this is what it waits for)
      const lapsed = m.kind === "approve" && i === STAGE_AT.approve && m.stage > i;
      if (lapsed) st = "todo";
      ol.appendChild(H.el("li", { class: st, "aria-current": st === "now" ? "step" : null, dataset: lapsed ? { due: "1" } : null }, st === "done" ? H.el("span", { class: "tick", "aria-hidden": "true", text: "✓ " }) : null, name, H.el("span", { class: "sr-only", text: st === "done" ? " (done)" : st === "now" ? " (now)" : lapsed ? " (needs you)" : " (not yet)" })));
    });
    return ol;
  }

  /** The always-open boxes above the headline: the page's banners (key, lock, a step still running), the engine's loud notes and danger alarms, a held step, the last send's result, the approval's own alert. */
  function safetyBoxes(m, payload) {
    const out = [];
    const Ac = A();
    for (const b of Ac.banners(payload)) {
      // the same banner is in Details: this copy carries no id, so the page has each id once
      if (b.removeAttribute) b.removeAttribute("id");
      out.push(b);
    }
    const s = m.safety;
    if (s.loud.length) {
      const box = H.el("div", { class: "loud-notes", role: "alert", "aria-label": "The engine's loud notes, in plain words" }, ic("alert"));
      for (const n of s.loud) box.appendChild(H.el("p", { class: "loud", text: plainEngine(n) }));
      out.push(box);
    }
    for (const t of s.alarms) out.push(H.el("div", { class: "alarm danger", role: "alert" }, ic("alert"), H.el("span", { class: "lv", text: "Danger" }), H.el("span", { class: "tx", text: plainEngine(t) })));
    if (s.held) {
      out.push(
        H.el(
          "div",
          { class: "alarm warn", role: "alert" },
          ic("alert"),
          H.el("span", { class: "lv", text: "Held" }),
          H.el("span", { class: "tx" }, H.el("strong", { text: "A step is held, and the engine does not offer it now. " }), H.chip("warn", "do not send it"), " ", "This is the engine's own wording; the step it froze earlier is not offered. If the engine says to cancel it, that is done in a terminal (swap-cli intent FILE --cancel with the same chain flags as tick).", s.held.reason ? H.el("blockquote", { class: "quote lead", "aria-label": "The engine's reason, verbatim", text: s.held.reason }) : null)
        )
      );
    } else if (s.heldIntent) {
      out.push(H.el("div", { class: "alarm warn", role: "alert" }, ic("alert"), H.el("span", { class: "lv", text: "Held" }), H.el("span", { class: "tx", text: `A step${s.heldIntent.kind ? " (" + s.heldIntent.kind.replace(/_/g, " ") + ")" : ""} was already decided, and the chain does not show its effect yet. Do not send it again by hand: sending it twice pays twice. The program keeps reading.` })));
    }
    if (s.lockBy) out.push(H.el("div", { class: "alarm warn", role: "alert" }, ic("clock"), H.el("span", { class: "lv", text: "Lock-by" }), H.el("span", { class: "tx", text: plainEngine(s.lockBy) })));
    if (s.job) {
      const box = H.el("div", { class: "alarm danger", role: "alert" }, ic("alert"), H.el("span", { class: "lv", text: "Last step" }));
      const tx = H.el("span", { class: "tx" }, H.el("strong", { text: s.job.label }));
      for (const l of s.job.lines) tx.appendChild(H.el("span", { class: "sc-line", text: l }));
      box.appendChild(tx);
      out.push(box);
    }
    // a step that needs the person is its own box (the words, the reason and the button are the approval box's own); the rest of the approval box follows, drawn once, as today
    if (m.claims.autopilot && Ac.needsYouBoxes) for (const n of Ac.needsYouBoxes(m.view, payload)) out.push(n);
    if (s.autopilot && m.kind !== "approve") {
      const ap = Ac.autopilotBlock(m.view, payload, { needs: false });
      if (ap) out.push(ap);
    }
    return out;
  }

  function actionArea(m, payload) {
    const Ac = A();
    const C = Ac.card;
    const a = payload.actions;
    const act = m.action;
    const box = H.el("div", { class: "sc-act" });
    if (act.kind === "button") {
      const b = C.actionButton(a, act.id, act.label, act.primary);
      box.appendChild(b.el);
      if (b.why) box.appendChild(H.el("p", { class: "why dim", text: b.why }));
    } else if (act.kind === "invitation") {
      const join = C.actionButton(a, "join", "Choose Alice's file…", act.first === "join");
      const inv = C.fileButton("invitation", act.first === "invitation" ? "Save an invitation for Alice…" : "Save the invitation again…", act.first === "invitation");
      const note = C.fileNote("invitation");
      // the two files as two numbered parts (the invitation Alice opens, the swap file she sends back); the buttons are the same ones
      const invPart = H.el("div", { class: "sc-part" }, A().partTitle(1, "Send Alice an invitation"), A().fileRow("file", "Invitation for Alice", "It holds your terms and your two addresses, so Alice does not type them. It holds no secret. Send it to Alice as a file.", inv));
      const joinPart = H.el("div", { class: "sc-part" }, A().partTitle(2, "Choose the file Alice sends back"), A().fileRow("open", "Alice's swap file", "The program checks it against your own terms. Nothing is sent.", join.el));
      if (act.first === "join") box.append(joinPart, invPart);
      else box.append(invPart, joinPart);
      if (join.why) box.appendChild(H.el("p", { class: "why dim", text: join.why }));
      if (note) box.appendChild(note);
    } else if (act.kind === "handover") {
      const n = Ac.handoverBlock(m.view, payload);
      if (n) box.appendChild(n);
    } else if (act.kind === "approval") {
      const n = Ac.autopilotBlock(m.view, payload, { needs: false });
      if (n) box.appendChild(n);
    } else if (act.kind === "deposit") {
      const n = C.depositCompact(payload, m.role);
      if (n) box.appendChild(n);
    } else if (act.kind === "spend") {
      const n = Ac.spendBlock(m.view, payload);
      if (n) box.appendChild(n);
    }
    const msg = C.message();
    if (msg && act.kind !== "none") box.appendChild(H.el("p", { class: msg.kind === "danger" ? "attn" : "plain", role: "alert", text: msg.text }));
    return box.children.length ? box : null;
  }

  /** The done card's two blocks (for the eye; a sentence is for a screen reader) and the rows under them. */
  function doneBlock(d) {
    const side = (x, caption, c) => H.el("div", { class: `side ${c}` }, H.el("span", { class: "k", text: caption }), H.el("span", { class: "v" }, H.coinGlyph ? H.coinGlyph(c) : null, H.el("span", { class: "num", text: x.num }), H.el("span", { class: "tic", text: x.tic })), H.el("span", { class: "on", text: x.on }));
    const coinOf = (x) => (x.tic === "NOID" ? "noid" : "eth");
    const box = H.el("div", { class: "sc-act sc-done" }, H.el("p", { class: "sr-only", text: `You gave ${d.gave.text}. You got ${d.got.text}.` }), H.el("div", { class: "convert done", "aria-hidden": "true" }, side(d.gave, "You gave", coinOf(d.gave)), H.el("div", { class: "mid" }, H.el("i", {})), side(d.got, "You got", coinOf(d.got))));
    if (d.rows.length) box.appendChild(H.el("dl", { class: "facts left" }, ...d.rows.map((r) => H.el("div", {}, H.el("dt", { text: r.label }), H.el("dd", { text: r.value })))));
    return box;
  }

  /** The card of a plan, as one element, or null when the plan is not drawn. */
  function draw(m, payload) {
    if (!m || !m.drawn) return null;
    const root = H.el("div", { class: "sc-in" + (m.tone ? " " + m.tone : "") });
    const safety = payload && payload.actions ? safetyBoxes(m, payload) : [];
    if (safety.length) {
      const wrap = H.el("div", { class: "sc-safety" });
      for (const n of safety) wrap.appendChild(n);
      root.appendChild(wrap);
    }
    root.appendChild(progress(m));
    root.appendChild(H.el("h2", { class: "sc-head", id: "pg-headline" }, m.tone === "done" ? ic("check") : null, coinText(m.headline)));
    root.appendChild(H.el("p", { class: "sc-status" + (m.kind === "look" ? " look" : ""), role: "status" }, coinText(m.status)));
    if (m.kind === "look" && m.reasons.length) {
      const ul = H.el("ul", { class: "sc-reasons", "aria-label": "Why" });
      for (const r of m.reasons) ul.appendChild(H.el("li", { text: r }));
      root.appendChild(ul);
    }
    if (m.kind === "done" && m.done) root.appendChild(doneBlock(m.done));
    const act = payload && payload.actions ? actionArea(m, payload) : null;
    if (act) root.appendChild(act);
    const foot = footLine(m);
    if (foot) root.appendChild(foot);
    return root;
  }

  // ------------------------------------------------------------------ the ticket: the two legs of this swap
  const LINE_OF = { none: "none", sent: "sent", pending: "pending", final: "final", secret_public: "final", closing: "pending", closed: "settled", released: "released", unknown: "none" };
  const AMOUNT_RE = /^([0-9][0-9.,]*) (NOID|ETH)$/;
  const groupHex = (hex) => (/^[0-9a-f]{16}$/.test(hex) ? hex.match(/.{4}/g).join(" ") : String(hex));

  /**
   * The ticket beside the card: what the person gives and what they get, each with the state of its lock in words and as a line (from the view model's legsFor, which reads the same
   * track states as the picture), where the coins go, the check line once it was compared, and one line of trust. When the swap is done it is "Receipts" instead. A card that needs a look
   * shows both legs as "Not known". Returns the elements to put in #pg-ticket (an array), or null when the card is not drawn. Display only: it reads, it decides nothing.
   */
  function drawTicket(m, payload) {
    if (!m || !m.drawn || !payload || !payload.actions || !m.role) return null;
    const Ac = A();
    const role = m.role;
    const a = payload.actions;
    const now = typeof H.nowS === "function" ? H.nowS() : 0;
    const view = m.view || null;
    if (m.kind === "done" && view && Array.isArray(view.receipts)) return receiptsTicket(view, role, a);
    const aboutRow = (id) => {
      const t = rowTime(view, id, now);
      return t && !t.passed ? about(t) : null;
    };
    // a card that needs a look draws the legs as unknown, except when the view says the secret may be public (a held reveal): then the ticket must not stay silent about the NOID
    const legs = (m.kind === "look" && !(view && view.secret_may_be_public === true)) || !V().legsFor ? null : V().legsFor(view, role, { about: aboutRow });
    const L = legs || (V().legsFor ? V().legsFor(null, role) : null);
    if (!L) return null;
    const amts = amounts(payload, view && view.header ? view : null);
    // the terms are known from the start: before the first reading the swap's summary (the list's own give and get) says them; no figure is ever made up
    const sum = summaryAmounts();
    amts.noid = amts.noid || sum.noid;
    amts.eth = amts.eth || sum.eth;
    const leg = (l, caption) => {
      const c = l.coin;
      const m2 = AMOUNT_RE.exec(String((c === "noid" ? amts.noid : amts.eth) || ""));
      return H.el(
        "div",
        { class: `tk-leg ${c}` },
        H.el("p", { class: "k" }, H.el("span", { text: caption }), H.el("span", { text: c === "noid" ? "on Parano1d" : "on Ethereum" })),
        m2 ? H.el("p", { class: "v" }, H.coinGlyph ? H.coinGlyph(c) : null, H.el("span", { class: "num", text: m2[1] }), H.el("span", { class: "tic", text: m2[2] })) : null,
        H.el("div", { class: `lockline ${LINE_OF[l.state] || "none"}`, "aria-hidden": "true" }),
        H.el("p", { class: "st" }, l.state === "closed" ? ic("check") : null, H.el("span", { text: l.words })),
        l.note ? H.el("p", { class: "note", text: l.note }) : null
      );
    };
    const out = [leg(L.give, "You give"), H.el("div", { class: "tk-key" + (L.public ? " public" : "") }, H.el("i", { "aria-hidden": "true" }), L.public ? H.el("span", { text: L.maybe ? "secret may be public" : "secret revealed" }) : null), leg(L.get, "You get")];
    // where the coins go, and the check line once the two sides compared it
    const rows = [];
    const x = (a.autopilot && a.autopilot[role]) || null;
    const p = x && x.payouts;
    const mine = role === "alice" ? { label: "Your ETH goes to", addr: p && p.eth, what: "your Ethereum address" } : { label: "Your NOID goes to", addr: p && p.noid, what: "your Parano1d address" };
    if (typeof mine.addr === "string" && mine.addr) rows.push(H.el("div", {}, H.el("dt", { text: mine.label }), H.el("dd", {}, H.copyButton(mine.addr, mine.what))));
    const cl = Ac.card.checkLineOf(a, role);
    if (cl.hex && a.line_match && a.line_match.hex === cl.hex) rows.push(H.el("div", {}, H.el("dt", { text: "Check line" }), H.el("dd", {}, H.el("span", { class: "mono", text: groupHex(cl.hex) }), H.el("span", { class: "sub", text: `compared with ${role === "alice" ? "Bob" : "Alice"}` }))));
    if (rows.length) out.push(H.el("dl", { class: "facts" }, ...rows));
    out.push(H.el("p", { class: "tk-trust", text: "Non-custodial: your coins are held by this swap's own wallet and contracts, never by a third party." }));
    return out;
  }

  // what a receipt is called on the main view, by its kind and the role (the technical page under Details keeps the engine's labels)
  const RECEIPT_NAME = {
    alice: { noid_tx: "Your funding, on Parano1d", lock_id: "Bob's lock id, on Ethereum", lock_tx: "Bob's lock, on Ethereum", claim_tx: "Your reveal, on Ethereum", refund_tx: "Bob's refund, on Ethereum", claim_pending: "Your reveal (not mined yet), on Ethereum", noid_pending: "A call on Parano1d (not mined yet)", instance: "Your NOID in the swap contract" },
    bob: { noid_tx: "Your claim, on Parano1d", lock_id: "Your lock id, on Ethereum", lock_tx: "Your lock, on Ethereum", claim_tx: "Alice's claim, on Ethereum", refund_tx: "Your refund, on Ethereum", claim_pending: "Alice's claim (not mined yet), on Ethereum", noid_pending: "A call on Parano1d (not mined yet)", instance: "Alice's NOID in the swap contract" },
  };

  /** The finished swap: the transaction ids the chains showed (the page's receipts of the two chains), each under its plain name, shortened with a copy button (the ids are whole on the button). */
  function receiptsTicket(view, role, a) {
    const names = RECEIPT_NAME[role] || RECEIPT_NAME.alice;
    const items = view.receipts.filter((r) => r && r.chain && !r.plain && (r.group === "Parano1d" || r.group === "Ethereum"));
    const rows = items.map((r) => ({ label: (r.kind && Object.prototype.hasOwnProperty.call(names, r.kind) && names[r.kind]) || r.label, value: r.value }));
    // the sweep that sent what was left to the person's own address, from its own result file
    for (const j of ((a && a.jobs) || []).filter((x) => x && x.id === `send-sweep-eth-${role}` && x.state === "done" && x.ok === true)) {
      const f = Array.isArray(j.files) ? j.files[0] : null;
      const tx = f && f.summary && f.summary.txHash;
      if (typeof tx === "string" && /^0x[0-9a-fA-F]{64}$/.test(tx) && !rows.some((r) => r.value === tx)) rows.push({ label: "Sweep to your address, on Ethereum", value: tx });
    }
    const out = [H.el("h2", { text: "Receipts" })];
    if (rows.length) out.push(H.el("dl", { class: "facts" }, ...rows.map((r) => H.el("div", {}, H.el("dt", { text: r.label }), H.el("dd", {}, H.copyButton(r.value, r.label))))));
    else out.push(H.el("p", { class: "note", text: "Nothing to show yet: receipts appear as the chains show transactions." }));
    out.push(H.el("p", { class: "tk-trust", text: "Each id can be looked up on its chain. The full list, with heights, is under Details." }));
    return out;
  }

  window.NoidStage = {
    init(helpers) {
      H = helpers;
    },
    plan,
    draw,
    drawTicket,
    plainEngine,
    stepName,
    tick,
    PROGRESS,
  };
})();
