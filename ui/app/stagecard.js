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

  // ------------------------------------------------------------------ plan (data only)
  /**
   * What the card says. input: { payload, role, view, error, now }. `view` is the view model of the swap page (null before its first reading, or when there is none).
   * Returns { drawn, kind, stage, headline, status, reasons, action, safety, claims, forceOpen, lookSig, view }:
   *   drawn      false when the card is not this page's (a production run, a board run, no actions): today's page is then shown as it is, with no fold
   *   kind       "setup" | "check" | "approve" | "deposit" | "swap" | "done" | "refund" | "abort" | "look"
   *   stage      the index in PROGRESS of the current stage, or -1 (a "look" never marks one)
   *   action     { kind: "none" | "button" | "invitation" | "handover" | "approval" | "deposit" | "spend", ... }
   *   safety     the boxes that are always open above the headline (data; draw() builds them)
   *   claims     the boxes the card draws itself: { handover, autopilot, spend }; today's page does not draw them a second time (they carry element ids)
   */
  function plan(input) {
    const m = { drawn: false, kind: null, stage: -1, headline: "", status: "", reasons: [], action: { kind: "none" }, safety: { loud: [], alarms: [], held: null, heldIntent: null, job: null, autopilot: false, lockBy: null }, claims: {}, forceOpen: false, lookSig: "", view: null, role: input.role };
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
        const lbSay = lb ? ` The engine says: ${lb.text}` : "";
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
      if (m.claims.autopilot && !m.safety.autopilot) m.claims.autopilot = false;
    }
    return m;
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

  function progress(m) {
    const ol = H.el("ol", { class: "sc-progress", "aria-label": "Progress of this swap" });
    PROGRESS.forEach((name, i) => {
      let st = m.stage < 0 ? "todo" : i < m.stage ? "done" : i === m.stage ? (m.kind === "done" || m.kind === "refund" || m.kind === "abort" ? "done" : "now") : "todo";
      // an approval that lapsed in flight is asked for again: Approve is not done, though the swap is further on
      if (m.kind === "approve" && i === STAGE_AT.approve && m.stage > i) st = "todo";
      ol.appendChild(H.el("li", { class: st, "aria-current": st === "now" ? "step" : null }, st === "done" ? H.el("span", { class: "tick", "aria-hidden": "true", text: "✓ " }) : null, name, H.el("span", { class: "sr-only", text: st === "done" ? " (done)" : st === "now" ? " (now)" : " (not yet)" })));
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
      const box = H.el("div", { class: "loud-notes", role: "alert", "aria-label": "The engine's loud notes, whole" });
      for (const n of s.loud) box.appendChild(H.el("p", { class: "loud", text: n }));
      out.push(box);
    }
    for (const t of s.alarms) out.push(H.el("div", { class: "alarm danger", role: "alert" }, H.el("span", { class: "lv", text: "danger" }), H.el("span", { class: "tx", text: t })));
    if (s.held) {
      out.push(
        H.el(
          "div",
          { class: "alarm warn", role: "alert" },
          H.el("span", { class: "lv", text: "held" }),
          H.el("span", { class: "tx" }, H.el("strong", { text: "A step is held, and the engine does not offer it now. " }), H.chip("warn", "do not send it"), " ", "This is the engine's own wording; the step it froze earlier is not offered. If the engine says to cancel it, that is done in a terminal (swap-cli intent FILE --cancel with the same chain flags as tick).", s.held.reason ? H.el("blockquote", { class: "quote lead", "aria-label": "The engine's reason, verbatim", text: s.held.reason }) : null)
        )
      );
    } else if (s.heldIntent) {
      out.push(H.el("div", { class: "alarm warn", role: "alert" }, H.el("span", { class: "lv", text: "held" }), H.el("span", { class: "tx", text: `A step${s.heldIntent.kind ? " (" + s.heldIntent.kind.replace(/_/g, " ") + ")" : ""} was already decided, and the chain does not show its effect yet. Do not send it again by hand: sending it twice pays twice. The program keeps reading.` })));
    }
    if (s.lockBy) out.push(H.el("div", { class: "alarm warn", role: "alert" }, H.el("span", { class: "lv", text: "lock-by" }), H.el("span", { class: "tx", text: s.lockBy })));
    if (s.job) {
      const box = H.el("div", { class: "alarm danger", role: "alert" }, H.el("span", { class: "lv", text: "last step" }));
      const tx = H.el("span", { class: "tx" }, H.el("strong", { text: s.job.label }));
      for (const l of s.job.lines) tx.appendChild(H.el("span", { class: "sc-line", text: l }));
      box.appendChild(tx);
      out.push(box);
    }
    if (s.autopilot && m.kind !== "approve") {
      const ap = Ac.autopilotBlock(m.view, payload);
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
      const row = H.el("div", { class: "row" });
      if (act.first === "join") row.append(join.el, inv);
      else row.append(inv, join.el);
      box.appendChild(row);
      if (join.why) box.appendChild(H.el("p", { class: "why dim", text: join.why }));
      if (note) box.appendChild(note);
    } else if (act.kind === "handover") {
      const n = Ac.handoverBlock(m.view, payload);
      if (n) box.appendChild(n);
    } else if (act.kind === "approval") {
      const n = Ac.autopilotBlock(m.view, payload);
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

  /** The card of a plan, as one element, or null when the plan is not drawn. */
  function draw(m, payload) {
    if (!m || !m.drawn) return null;
    const root = H.el("div", { class: "sc-in" + (m.kind === "look" ? " look" : "") });
    const safety = payload && payload.actions ? safetyBoxes(m, payload) : [];
    if (safety.length) {
      const wrap = H.el("div", { class: "sc-safety" });
      for (const n of safety) wrap.appendChild(n);
      root.appendChild(wrap);
    }
    root.appendChild(progress(m));
    root.appendChild(H.el("h2", { class: "sc-head", id: "pg-headline" }, coinText(m.headline)));
    root.appendChild(H.el("p", { class: "sc-status" + (m.kind === "look" ? " look" : ""), role: "status" }, coinText(m.status)));
    if (m.kind === "look" && m.reasons.length) {
      const ul = H.el("ul", { class: "sc-reasons", "aria-label": "Why" });
      for (const r of m.reasons) ul.appendChild(H.el("li", { text: r }));
      root.appendChild(ul);
    }
    const act = payload && payload.actions ? actionArea(m, payload) : null;
    if (act) root.appendChild(act);
    return root;
  }

  window.NoidStage = {
    init(helpers) {
      H = helpers;
    },
    plan,
    draw,
    PROGRESS,
  };
})();
