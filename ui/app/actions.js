/* noid-swap operator console — the actions mode (only drawn when the server was started with --allow-actions).
   Everything here is a view of what the server says (/api/run -> actions) plus four POSTs, each with the per-start token:
   /api/action, /api/spend, /api/funded, /api/newswap (and /api/autopilot). The server re-checks everything; nothing in this file decides that a
   spend is allowed. No inline styles or handlers (CSP). The tool's own wallets (a "wallet run", swap wallet piece 2c, not run against a real node or a public
   network): this file only draws what the server says in actions.wallet (the mode, the payout addresses of the settings, and per role the newest clean deposit
   status); no key, secret or sealed file ever reaches it. */
(() => {
  "use strict";
  let H = null; // helpers handed over by operator.js
  const ui = { form: null, dialog: null, lastSig: "", msg: null, formMsg: null, sending: false, ack: false, folded: false, termsOpened: false, trade: null, tradeTerms: null, roleTouched: false, ap: { typed: "", ticks: {} } };
  const $ = (id) => document.getElementById(id);

  const SPEND_ORDER = ["send-fund", "send-lock", "send-reveal", "send-reveal-replace", "send-claim", "send-refund-eth", "send-refund-eth-replace", "send-recover", "send-sweep-noid", "send-sweep-eth-alice", "send-sweep-eth-bob"];

  /** The wallet run's facts from the payload: `{ on, ambiguous, ... }`, or null for a classic run (the payload of a classic run has none). */
  function walletOf(a) {
    const w = a && a.wallet;
    return w && w.on === true ? w : null;
  }

  function enabled(p) {
    return !!(p && p.actions && p.actions.enabled);
  }

  /** The signature of the actions part of a payload without anything that changes every second (ages, clocks). */
  function signature(a) {
    if (!a || !a.enabled) return "off";
    const spends = {};
    for (const [id, s] of Object.entries(a.spends || {})) {
      spends[id] = s.relevant ? { e: s.eligible, r: (s.reasons || []).map((x) => x.code), d: s.dry ? [s.dry.hash, s.dry.ok, s.dry.all_ok, s.dry.at, (s.dry.rows || []).map((r) => r.ok)] : null, t: s.expected_typed, c: s.command, tx: s.replace_tx, n: (s.notices || []).map((x) => x.text), sn: s.statements_needed || null } : 0;
    }
    return JSON.stringify([a.production && a.production.text, a.busy && a.busy.id, (a.jobs || []).map((j) => [j.job, j.state, j.ok, j.finished_at]), a.watch && [a.watch.started_here, a.watch.some_loop_running, a.watch.pid, a.watch.mode], a.first_steps, a.check_line, a.line_match, spends, a.funding, (a.audit && a.audit.tail ? a.audit.tail.map((r) => r.seq) : []), a.audit && a.audit.chain && a.audit.chain.ok, autopilotSignature(a), a.form && [a.form.env_local, a.form.run_number], a.lock && [a.lock.held, a.lock.folder_missing], a.join, walletSignature(a), ui.msg, ui.formMsg, !!H.state.token, ui.sending, ui.folded]);
  }

  /** What is drawn of the wallet part of a payload, without the ages and clocks that change every second. */
  function walletSignature(a) {
    const w = a && a.wallet;
    if (!w || !w.on) return w ? [w.on, !!w.ambiguous] : null;
    const role = (r) => (r ? [r.swap_file, r.addresses_file, r.key_address, r.status ? [r.status.at, r.status.ok, r.status.show, (r.status.problems || []).join("|"), r.status.noid && [r.status.noid.covers, r.status.noid.plain_micronoid], r.status.eth && [r.status.eth.covered, r.status.eth.balance_wei]] : null] : null);
    return [w.on, !!w.ambiguous, w.noid_payout, w.eth_payout, w.funded_marker, w.swept, w.recovered_txid, role(w.roles && w.roles.alice), role(w.roles && w.roles.bob)];
  }

  /** The autopilot's part of the signature: what is drawn, without the clocks. While it is off, what it is doing is not drawn, so it is not in the signature. */
  function autopilotSignature(a) {
    const ap = a && a.autopilot;
    if (!ap) return null;
    return ["alice", "bob"].map((r) => {
      const x = ap[r];
      if (!x) return null;
      return [x.available, x.on, x.terms_changed, x.expected_typed, x.gets_text, x.board, x.funding_offered, !!x.funding_statements_valid_until, (x.needs_you || []).map((n) => [n.spend, n.reason, n.retrying]), x.on ? [x.doing, x.waiting_reason, x.finished_notes] : null];
    });
  }

  // ------------------------------------------------------------------ transport
  async function post(path, body) {
    // program mode: every request names its swap (the server looks the id up in its own set; it never builds a path from it)
    const sent = H.state.swap ? { ...body, swap: H.state.swap } : body;
    const r = await fetch(path, { method: "POST", cache: "no-store", headers: { "content-type": "application/json", "x-swap-token": H.state.token || "" }, body: JSON.stringify(sent) });
    const j = await r.json().catch(() => ({ error: `HTTP ${r.status}` }));
    return { ok: r.ok, status: r.status, json: j };
  }

  function forceRender() {
    ui.lastSig = "";
    H.rerender();
  }

  async function startAction(id) {
    if (!H.state.token) return;
    ui.msg = null;
    const r = await post("/api/action", { id });
    if (!r.ok) ui.msg = { kind: "danger", text: `${id}: ${r.json.error || "HTTP " + r.status}` };
    forceRender();
    await H.reload(true);
    pollWhileBusy();
  }

  let polling = false;
  async function pollWhileBusy() {
    if (polling) return;
    polling = true;
    try {
      for (let i = 0; i < 4000; i++) {
        const a = H.state.payload && H.state.payload.actions;
        if (!a || !a.busy) break;
        await new Promise((r) => setTimeout(r, 1500));
        await H.reload(false);
      }
    } finally {
      polling = false;
    }
  }

  // ------------------------------------------------------------------ banners and notes
  const KEY_LOST_TERMINAL = "This page lost its key (a reload drops it). Open the start URL printed in the console's terminal again.";
  const KEY_LOST_PROGRAM = "This page lost its key (a reload drops it). Close this window and open the program again.";
  let KEY_LOST = KEY_LOST_TERMINAL;

  /** True when this console started before its run folder existed (or cannot take the folder's lock): it holds no lock and runs nothing but the install step. */
  function pendingLock(a) {
    return !!(a && a.lock && !a.lock.held);
  }
  function lockNote(a) {
    return a.lock.folder_missing ? "The run folder does not exist yet: run \"1. Install helpers\". Until it exists nothing else runs from here." : `This console does not hold the run folder's lock: ${a.lock.why || "unknown"}. Nothing runs from here.`;
  }

  /** The banners at the top of the page (inside the alarms area): the lost key, the missing run folder or lock. Nothing outside the actions mode. */
  function banners(payload) {
    const out = [];
    if (!enabled(payload)) return out;
    if (!H.state.token) out.push(H.el("div", { class: "alarm danger big", id: "banner-key" }, H.el("span", { class: "lv", text: "key" }), H.el("span", { class: "tx", text: KEY_LOST })));
    const a = payload.actions;
    if (pendingLock(a)) out.push(H.el("div", { class: "alarm " + (a.lock.folder_missing ? "warn" : "danger") + " big", id: "banner-lock" }, H.el("span", { class: "lv", text: a.lock.folder_missing ? "folder" : "lock" }), H.el("span", { class: "tx", text: lockNote(a) + (a.lock.folder_missing ? " The console takes the run folder's lock as soon as the folder exists." : "") })));
    // program mode: a step that can send is never abandoned, so a long one is said out loud (the program keeps it running until it ends)
    const hung = isProgram() ? hungWarning(a) : null;
    if (hung) out.push(H.el("div", { class: "alarm danger big", role: "alert", id: "banner-hung" }, H.el("span", { class: "lv", text: "still running" }), H.el("span", { class: "tx", text: hung })));
    return out;
  }

  /** Program mode only (a terminal console never sets state.program). */
  const isProgram = () => !!(H && H.state && H.state.program);

  /** The sentence for a step that is still running past its time, or null: the server's own text when it sends one, else the fixed sentence with the minutes. */
  function hungWarning(a) {
    const b = a && a.busy;
    if (!b || typeof b !== "object") return null;
    if (typeof b.warning === "string" && b.warning) return b.warning.charAt(0).toUpperCase() + b.warning.slice(1) + (/[.!?]$/.test(b.warning) ? "" : ".");
    let minutes = null;
    if (Number.isFinite(b.overdue_minutes) && b.overdue_minutes > 0) minutes = Math.floor(b.overdue_minutes);
    else if (Number.isFinite(b.minutes) && b.minutes > 0) minutes = Math.floor(b.minutes);
    else if (Number.isFinite(b.timeout_s) && Number.isFinite(b.started_at) && H.nowS() - b.started_at > b.timeout_s) minutes = Math.max(1, Math.floor((H.nowS() - b.started_at) / 60));
    if (minutes === null) return null;
    return `Still running after ${minutes} ${minutes === 1 ? "minute" : "minutes"}: do not start another action. Quitting now counts as "may have been sent".`;
  }

  /** What a result of the lock, the reveal or the Ethereum refund with exit 1 means (program mode; the step cannot tell a failed key hand-over from a send that failed half way). */
  const CODE1_IDS = ["send-lock", "send-reveal", "send-reveal-replace", "send-refund-eth", "send-refund-eth-replace"];
  const CODE1_ADVICE = "Look at the result. A missing `sent:` line does not prove that nothing was sent: wait for the next status update, and look at the swap's phase and the contract, before you try again.";

  /** The visible form of a disabled button's title, next to a group of buttons (a hover title alone is not seen). */
  const keyNote = () => (H.state.token ? null : H.el("p", { class: "keynote", text: KEY_LOST }));

  // ------------------------------------------------------------------ small pieces
  const btn = (label, onclick, opts = {}) => H.el("button", { type: "button", class: (opts.big ? "btn" : "btn sm") + (opts.primary ? " primary" : "") + (opts.danger ? " danger" : ""), disabled: opts.disabled ? true : null, title: opts.title || null, onclick }, label);

  /** HH:MM in the person's own time zone, from unix seconds (the page shows no seconds where a rough time is meant). */
  function hhmm(sec) {
    const d = new Date(Number(sec) * 1000);
    return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  }

  /** An amount with its unit ("5 NOID", "0.001 ETH") in the coin's colour; any other text stays plain. */
  function coinSpan(text) {
    const t = String(text);
    return /\bNOID$/.test(t) ? H.el("span", { class: "c-noid", text: t }) : /\bETH$/.test(t) ? H.el("span", { class: "c-eth", text: t }) : t;
  }

  /** A 16-digit check line in four groups of four ("b427 1c7f 3ea5 1fe7"): easy to read aloud. Anything else is returned as it is. */
  const groupHex = (hex) => (/^[0-9a-f]{16}$/.test(hex) ? hex.match(/.{4}/g).join(" ") : String(hex));

  /** True for a board run (program mode): the board hands the terms and the file over by itself, so the first card keeps today's boxes and words. */
  function isBoardRun(payload, role) {
    const ap = payload && payload.actions && payload.actions.autopilot && payload.actions.autopilot[role];
    return !!((payload && payload.board) || (ap && ap.board === true));
  }

  /** Why the button of a table action is disabled, as words, or null: the key, the table's own block, the run folder's lock, a running job. The start screen's buttons use it too. */
  function actionWhy(a, id) {
    const entry = (a.table || []).find((e) => e.id === id);
    const lockWhy = pendingLock(a) && id !== "install" ? lockNote(a) : null;
    return !H.state.token ? KEY_LOST : entry && entry.blocked ? entry.blocked : entry && entry.mode_blocked ? entry.mode_blocked : lockWhy ? lockWhy : a.busy ? `Busy: ${a.busy.id} is running` : null;
  }

  function actionButton(a, id, label, note) {
    const entry = (a.table || []).find((e) => e.id === id);
    const why = actionWhy(a, id);
    return btn(label, () => startAction(id), { disabled: !!why, title: why || (entry ? `${note || entry.note}\n\n${entry.command || ""}` : note) });
  }

  function rowsList(rows) {
    const ul = H.el("ul", { class: "checks dry-rows", "aria-label": "Dry-run fields against the terms" });
    for (const r of rows) {
      const cls = r.ok === true ? "ok" : r.ok === false ? "bad" : "info";
      const glyph = r.ok === true ? "✓" : r.ok === false ? "✗" : "·";
      const detail = r.expected !== null && r.expected !== undefined && r.ok !== true ? ` — expected ${shorten(r.expected)}, got ${shorten(r.actual)}` : r.actual !== null && r.actual !== undefined ? ` — ${shorten(r.actual)}` : "";
      ul.appendChild(H.el("li", { class: cls }, H.el("span", { class: "g", "aria-hidden": "true", text: glyph }), " ", H.el("strong", { text: r.label }), H.el("span", { class: "dim mono", text: detail }), H.el("span", { class: "sr-only", text: r.ok === true ? " (matches)" : r.ok === false ? " (DOES NOT MATCH)" : " (information)" })));
    }
    return ul;
  }
  function shorten(v) {
    const s = String(v === null || v === undefined ? "—" : v);
    return s.length > 96 ? s.slice(0, 44) + "…" + s.slice(-44) : s;
  }

  // ------------------------------------------------------------------ the spend block (inside "Next action")
  function jobOf(a, id) {
    return (a.jobs || []).filter((j) => j.id === id).slice(-1)[0] || null;
  }

  function jobBox(j, expectNext) {
    const box = H.el("div", { class: "runbox job" }, H.el("div", { class: "row" }, H.el("strong", { text: j.label }), j.state === "running" ? H.chip("accent", "running…") : H.chip(j.ok ? "ok" : j.nothing_sent ? "attn" : "danger", j.ok ? "exit 0" : j.nothing_sent ? `refused, nothing sent (exit ${j.exit_code})` : j.timed_out ? "timed out" : j.exit_code !== null ? `exit ${j.exit_code}` : "failed"), H.el("span", { class: "dim", text: j.finished_at ? `${H.clock(j.started_at)} → ${H.clock(j.finished_at)}` : `since ${H.clock(j.started_at)}` })));
    if (j.tx) box.appendChild(H.el("div", { class: "row" }, H.el("span", { class: "label", text: "transaction" }), H.copyButton(j.tx, "transaction hash")));
    for (const f of j.files || []) {
      box.appendChild(H.el("details", {}, H.el("summary", { class: "mono", text: `result file ${f.name} (${f.size} B)` }), H.el("pre", { text: f.summary ? JSON.stringify(f.summary, null, 2) : "(not JSON)" })));
    }
    if (j.warning) box.appendChild(H.el("p", { class: "alarm danger", role: "alert", text: j.warning }));
    if (isProgram() && j.state === "done" && j.exit_code === 1 && CODE1_IDS.includes(j.id)) box.appendChild(H.el("p", { class: "attn", role: "alert", text: CODE1_ADVICE }));
    if (j.error) box.appendChild(H.el("p", { class: "attn", text: j.error }));
    const out = (j.stdout || "") + (j.stderr ? "\n--- stderr ---\n" + j.stderr : "");
    if (out.trim()) box.appendChild(H.el("pre", { text: out }));
    if (expectNext && j.state === "done" && j.next) box.appendChild(H.el("p", { class: "plain" }, H.el("strong", { text: "What to expect next: " }), j.next));
    if (expectNext && j.state === "done" && j.timed_out) box.appendChild(H.el("p", { class: "attn", text: "The helper timed out here but may still have sent the transaction. Do not send it again: watch the next ticks." }));
    return box;
  }

  function spendBlock(view, payload) {
    const a = payload && payload.actions;
    if (!a || !a.enabled || !view || !view.action) return null;
    const mine = SPEND_ORDER.map((id) => (a.spends || {})[id]).filter((s) => s && s.relevant && s.role === view.role);
    if (!mine.length) return null;
    const wrap = H.el("div", { class: "spend" });
    for (const sp of mine) {
      const dry = sp.dry;
      const box = H.el("section", { class: "spend-box", "aria-label": sp.plain.title }, H.el("div", { class: "row" }, H.el("strong", { text: sp.replace ? "Re-send from here" : "Do it from here" }), H.chip("warn", "actions mode, moves funds"), H.el("span", { class: "dim", text: sp.plain.title })));
      if (sp.kind === "fund_noid") box.appendChild(H.el("p", { class: "plain", text: walletOf(a) ? "This funds from this swap's own wallet, once: the wallet writes its transaction before it sends, and running it again sends the same bytes, never a second funding." : "Use this button only if you have NOT already funded (fund.sh in a terminal, or the wallet)." }));
      if (sp.kind === "refund_noid" || sp.kind === "sweep_noid" || sp.kind === "sweep_eth") box.appendChild(H.el("p", { class: "plain", text: sp.kind === "refund_noid" ? "The deadline has passed and the NOID is still at the contract: this takes it back to this swap's own wallet. The console records the close in the swap file once it is confirmed." : "The swap is over: this sends what is left to the payout address you gave when the swap was made, and to no other address." }));
      box.appendChild(H.el("p", { class: "dim", text: `Two steps: a dry run of ${sp.dry_id.replace(/^dry-/, "")} (valid 90 s), then the confirmation. The server checks both again.` }));
      const dryRow = H.el("div", { class: "row" }, actionButton(a, sp.dry_id, dry ? "Run the dry run again" : "1. Run the dry run", "Sends nothing"));
      if (dry) {
        dryRow.appendChild(H.chip(dry.ok && dry.all_ok ? "ok" : "danger", dry.ok && dry.all_ok ? "all fields match" : dry.ok ? "a field does not match" : `dry run failed (${dry.result})`));
        dryRow.appendChild(H.el("span", { class: "dim mono", dataset: { dryAt: String(dry.at) }, text: "" }));
        dryRow.appendChild(H.el("span", { class: "dim mono", text: `sha256 ${dry.hash ? dry.hash.slice(0, 12) : "—"}` }));
      }
      box.appendChild(dryRow);
      if (!H.state.token) box.appendChild(keyNote());
      if (dry) {
        if (dry.stderr && !dry.ok) box.appendChild(H.el("pre", { class: "mono", text: dry.stderr }));
        if (dry.rows && dry.rows.length) box.appendChild(rowsList(dry.rows));
        if (dry.shown) box.appendChild(H.el("details", {}, H.el("summary", { text: "The dry run's result file (secrets and call data stripped)" }), H.el("pre", { text: JSON.stringify(dry.shown, null, 2) })));
      }
      const reasons = (sp.reasons || []).filter((r) => r.code !== "typed");
      // An engine ALARM does not stop a step that only returns coins to their owner (the ETH refund); its whole text is shown beside the send box.
      for (const n of sp.notices || []) box.appendChild(H.el("div", { class: "alarm danger", role: "alert" }, H.el("span", { class: "lv", text: "engine alarm" }), H.el("span", { class: "tx", text: n.text })));
      if ((sp.notices || []).length) box.appendChild(H.el("p", { class: "dim", text: "The engine's alarm does not stop this step: it only returns your own coins and the engine offers it. Read the alarm before you send." }));
      const sendRow = H.el("div", { class: "row" }, btn("2. Send…", () => openConfirm(sp, a), { primary: true, disabled: !sp.eligible || !H.state.token || !!a.busy, title: sp.eligible ? sp.command : "Not yet: " + (reasons.map((r) => r.text).join(" ") || "see below") }), H.el("code", { class: "mono dim", text: sp.command || "" }));
      box.appendChild(sendRow);
      if (!sp.eligible && reasons.length) {
        const ul = H.el("ul", { class: "blocked", "aria-label": "Why sending is not possible yet" });
        for (const r of reasons) ul.appendChild(H.el("li", { text: r.text }));
        box.appendChild(H.el("div", {}, H.el("div", { class: "label", text: "blocked because" }), ul));
      }
      const j = jobOf(a, sp.id);
      if (j) box.appendChild(jobBox(j, true));
      wrap.appendChild(box);
    }
    return wrap;
  }

  // ------------------------------------------------------------------ the confirmation dialog
  function closeDialog() {
    if (ui.dialog) {
      try {
        ui.dialog.close();
      } catch {
        /* already closed */
      }
      ui.dialog.remove();
      ui.dialog = null;
    }
  }

  function openConfirm(sp, a) {
    closeDialog();
    const dlg = document.createElement("dialog");
    dlg.className = "confirm";
    dlg.setAttribute("aria-labelledby", "confirm-title");
    const err = H.el("div", { class: "attn", role: "alert" });
    const input = H.el("input", { type: "text", id: "confirm-typed", autocomplete: "off", spellcheck: "false", "aria-describedby": "confirm-hint", placeholder: sp.expected_typed || "" });
    // the funding needs two explicit statements (the server requires both and records them)
    const needsStatement = sp.kind === "fund_noid";
    // a wallet run does not ask "no funding of this contract is pending" (the wallet holds one funding and the tool refuses one submitted by another path); Bob's check line is still asked
    const wallet = !!walletOf(a);
    const stmt = needsStatement && !wallet ? H.el("input", { type: "checkbox", id: "confirm-stmt" }) : null;
    // program mode: the line match of the run folder pre-ticks the line statement (it is still asked, and still required)
    const lineMatched = !!(a && a.line_match);
    const stmtBob = needsStatement ? H.el("input", { type: "checkbox", id: "confirm-stmt-bob", checked: lineMatched ? true : null }) : null;
    // Bob's lock also needs "Alice's check line matches mine" (the server says so in statements_needed, program mode outside a board run)
    const needsAlice = sp.kind === "lock_eth" && Array.isArray(sp.statements_needed) && sp.statements_needed.includes("alice_check_matches");
    const stmtAlice = needsAlice ? H.el("input", { type: "checkbox", id: "confirm-stmt-alice", checked: lineMatched ? true : null }) : null;
    const lineHex = a && a.check_line && typeof a.check_line.hex === "string" && /^[0-9a-f]{16}$/.test(a.check_line.hex) ? a.check_line.hex : null;
    const myLine = needsStatement ? bundleCheckLine(a.jobs) : null;
    const send = btn("Send for real", async () => {
      send.disabled = true;
      clear(err);
      const body = needsStatement ? { id: sp.id, typed: input.value, no_pending_funding: !!(stmt && stmt.checked), bob_check_matches: !!(stmtBob && stmtBob.checked) } : needsAlice ? { id: sp.id, typed: input.value, alice_check_matches: !!(stmtAlice && stmtAlice.checked) } : { id: sp.id, typed: input.value };
      const r = await post("/api/spend", body);
      if (r.ok) {
        closeDialog();
        ui.msg = null;
        forceRender();
        await H.reload(true);
        pollWhileBusy();
      } else {
        err.appendChild(H.el("p", { text: r.json.error || `HTTP ${r.status}` }));
        if (r.json.reasons) {
          const ul = H.el("ul");
          for (const x of r.json.reasons) ul.appendChild(H.el("li", { text: x.text }));
          err.appendChild(ul);
        }
        send.disabled = !matches();
        await H.reload(true);
      }
    }, { primary: true, disabled: true });
    const clear = (n) => {
      while (n.firstChild) n.removeChild(n.firstChild);
    };
    const matches = () => {
      const m = /^\s*(\d{1,12})(?:\.(\d{1,18}))?\s*([A-Za-z]{3,4})\s*$/.exec(input.value);
      const e = /^(\d+)(?:\.(\d+))?\s+([A-Z]+)$/.exec(sp.expected_typed || "");
      if (!m || !e || m[3].toUpperCase() !== e[3]) return false;
      const norm = (w, f) => `${BigInt(w)}.${(f || "").padEnd(18, "0")}`;
      return norm(m[1], m[2]) === norm(e[1], e[2]);
    };
    const refresh = () => {
      send.disabled = !matches() || (needsStatement && !((wallet || (stmt && stmt.checked)) && stmtBob && stmtBob.checked)) || (needsAlice && !(stmtAlice && stmtAlice.checked)) || !!(H.state.payload && H.state.payload.actions && H.state.payload.actions.busy);
    };
    input.addEventListener("input", refresh);
    if (stmt) stmt.addEventListener("change", refresh);
    if (stmtBob) stmtBob.addEventListener("change", refresh);
    if (stmtAlice) stmtAlice.addEventListener("change", refresh);
    const dryRows = sp.dry && sp.dry.rows ? sp.dry.rows.filter((r) => r.ok !== null) : [];
    dlg.appendChild(
      H.el(
        "div",
        { class: "confirm-body" },
        H.el("h2", { id: "confirm-title", text: `Confirm: ${sp.plain.title}` }),
        H.el("p", { class: "plain strong", text: "This sends a real transaction. It cannot be undone from here." }),
        ...sp.plain.lines.map((l) => H.el("p", { class: "plain", text: l })),
        dryRows.length ? H.el("div", {}, H.el("div", { class: "label", text: `checked against the terms (${dryRows.filter((r) => r.ok).length} of ${dryRows.length} match)` }), rowsList(dryRows)) : null,
        H.el("div", {}, H.el("div", { class: "label", text: "the exact command" }), H.el("pre", { text: sp.command || "" })),
        H.el("label", { for: "confirm-typed", id: "confirm-hint", class: "typed-label" }, "To confirm, type the amount and unit: ", H.el("strong", { class: "mono", text: sp.expected_typed || "?" })),
        input,
        stmt ? H.el("label", { class: "ack", for: "confirm-stmt" }, stmt, " No funding of this contract is pending: I have not run the wallet's fund command or fund.sh for it anywhere else") : null,
        needsStatement ? H.el("label", { class: "ack", for: "confirm-stmt-bob" }, stmtBob, " Bob's check line matches mine: the 16 digits of his bundle check line are the ones of my line, compared over a second channel") : null,
        needsAlice ? H.el("label", { class: "ack", for: "confirm-stmt-alice" }, stmtAlice, " Alice's check line matches mine: the 16 digits of her bundle check line are the ones of my line, compared over a second channel") : null,
        (needsStatement || needsAlice) && lineHex ? H.el("div", {}, H.el("div", { class: "label", text: "Your check line" }), H.el("p", { class: "bundle-check grouped mono", text: groupHex(lineHex) })) : null,
        needsStatement && !lineHex ? (myLine ? H.el("div", {}, H.el("div", { class: "label", text: "Your line, as Prepare printed it" }), H.el("p", { class: "bundle-check mono", text: myLine })) : H.el("p", { class: "dim", text: "Your bundle check line is the one Prepare printed (it is also in new-alice.err in the run folder)." })) : null,
        err,
        H.el("div", { class: "row end" }, btn("Cancel", closeDialog), send)
      )
    );
    dlg.addEventListener("cancel", () => {
      ui.dialog = null;
    });
    document.body.appendChild(dlg);
    ui.dialog = dlg;
    if (typeof dlg.showModal === "function") dlg.showModal();
    else dlg.setAttribute("open", "");
    input.focus();
  }

  // ------------------------------------------------------------------ funding (Alice's step)
  /** A small confirmation dialog (title, plain lines, a confirm button): nothing is done before the button is pressed. */
  function openSimpleConfirm({ title, lines, confirmLabel, onConfirm, onCancel }) {
    closeDialog();
    const dlg = document.createElement("dialog");
    dlg.className = "confirm neutral"; // not a send: its button is not amber
    dlg.setAttribute("aria-labelledby", "confirm-title");
    const err = H.el("div", { class: "attn", role: "alert" });
    const cancel = () => {
      closeDialog();
      if (onCancel) onCancel();
    };
    const go = btn(
      confirmLabel,
      async () => {
        go.disabled = true;
        while (err.firstChild) err.removeChild(err.firstChild);
        const msg = await onConfirm();
        if (msg) {
          err.appendChild(H.el("p", { text: msg }));
          go.disabled = false;
        } else closeDialog();
      },
      { primary: true }
    );
    dlg.appendChild(H.el("div", { class: "confirm-body" }, H.el("h2", { id: "confirm-title", text: title }), ...lines.map((l) => H.el("p", { class: "plain", text: l })), err, H.el("div", { class: "row end" }, btn("Cancel", cancel), go)));
    dlg.addEventListener("cancel", () => {
      ui.dialog = null;
      if (onCancel) onCancel();
    });
    document.body.appendChild(dlg);
    ui.dialog = dlg;
    if (typeof dlg.showModal === "function") dlg.showModal();
    else dlg.setAttribute("open", "");
    go.focus();
  }

  // ------------------------------------------------------------------ the deposit (a wallet run)
  /** The swap page shows the deposit box while the step it pays for has not been sent: Alice while her file is at "created", Bob before his lock. */
  function depositNeeded(view, a) {
    const w = walletOf(a);
    if (!w || !view || !view.phase) return false;
    if (view.role === "alice") return view.phase.id === "created" && !w.funded_marker;
    if (view.role === "bob") return ["received", "funded", "funding_final"].includes(view.phase.id);
    return false;
  }

  /** Atomic amounts as words: micro-NOID as NOID, wei as ETH (the page's own reading beside the exact figures). */
  const noidWords = (micro) => {
    try {
      return `${trimZeros(window.NoidView.noidText(micro))} NOID`;
    } catch {
      return null;
    }
  };
  const ethWords = (wei) => {
    try {
      return `${window.NoidView.ethText(wei)} ETH`;
    } catch {
      return null;
    }
  };

  /** One deposit line: the address with a copy button, the exact amount, and whether it has been seen. */
  function depositRow(coin, address, exact, words, seen, why) {
    const row = H.el("div", { class: "deposit-row" }, H.el("div", { class: "label", text: `${coin} deposit address` }), H.el("div", { class: "row" }, H.copyButton(address, `the ${coin} deposit address`, address)));
    row.appendChild(H.el("p", { class: "plain" }, "Send at least ", H.el("strong", { class: coin === "NOID" ? "c-noid mono" : "c-eth mono", text: exact }), words ? H.el("span", { class: "dim", text: ` (${words})` }) : null, `: ${why}`));
    row.appendChild(H.el("div", { class: "row" }, seen ? H.chip("ok", "seen") : H.chip("attn", "not yet")));
    return row;
  }

  // The program-mode deposit box (opts.plain): the figures a person types into a wallet. NOID exact (six places, trailing zeros removed); ETH wei rounded UP to six
  // decimals, so the figure is never below what is needed. BigInt only; the exact figures stay on the line beneath.
  const trimFrac = (whole, frac) => {
    const f = frac.replace(/0+$/, "");
    return f ? `${whole}.${f}` : String(whole);
  };
  function noidFigure(micro) {
    try {
      const v = BigInt(micro);
      return v < 0n ? null : trimFrac(v / 1000000n, String(v % 1000000n).padStart(6, "0"));
    } catch {
      return null;
    }
  }
  function ethFigure(wei) {
    try {
      const v = BigInt(wei);
      if (v < 0n) return null;
      const u = (v + 10n ** 12n - 1n) / 10n ** 12n;
      return trimFrac(u / 1000000n, String(u % 1000000n).padStart(6, "0"));
    } catch {
      return null;
    }
  }

  /** One deposit line in plain units: what to send (with a button that copies the figure alone), where to, and the exact figures beneath. */
  function depositRowPlain(coin, address, figure, exact, seen) {
    const cls = coin === "NOID" ? "noid" : "eth";
    const row = H.el("div", { class: "deposit-row" }, H.el("div", { class: "label", text: `${coin} to deposit` }));
    row.appendChild(H.el("div", { class: "row" }, "Send at least", H.el("span", { class: `leg ${cls}` }, H.el("span", { class: "amt", text: figure }), H.el("span", { class: "unit", text: coin })), H.copyButton(figure, `the ${coin} amount`, "Copy amount")));
    row.appendChild(H.el("div", { class: "row" }, "to this address", H.copyButton(address, `the ${coin} deposit address`, address)));
    row.appendChild(H.el("p", { class: "dim", text: exact }));
    row.appendChild(H.el("div", { class: "row" }, seen ? H.chip("ok", "seen") : H.chip("attn", "not yet")));
    return row;
  }

  /** Alice's clock: how long her deposit has, from the engine's funding-window note on the last tick (display only: the engine decides). Twenty seconds a block, four blocks kept back. */
  function depositClock(payload) {
    const r = payload && payload.roles && payload.roles.alice;
    const tick = r && r.tick;
    const E = typeof window !== "undefined" ? window.NoidEngineText : null;
    let n = null;
    if (tick && Array.isArray(tick.notes) && E && typeof E.fundingBlocksLeft === "function") {
      for (const t of tick.notes) {
        const k = E.fundingBlocksLeft(t);
        if (k !== null) {
          n = k;
          break;
        }
      }
    }
    if (n === null || !tick || !Number.isFinite(tick.now)) return H.el("p", { class: "dim", text: "The time left shows at the first reading of the chain." });
    const m = n - 4;
    if (n < 0) return H.el("p", { class: "attn", text: "The funding window has closed: this swap will not start. Do not deposit." });
    if (m <= 0) return H.el("p", { class: "attn", text: "The funding window is about to close. A deposit now may be too late; then the swap does not start. Anything deposited can then be sent back to your own addresses from this swap's page; while the program runs this swap for you, it does that by itself." });
    return H.el("p", { class: m <= 5 ? "attn" : "dim", text: `Deposit before about ${hhmm(tick.now + m * 20)}, so the funding can go in on time. Blocks come at random, so earlier is safer.` });
  }

  /**
   * The deposit box of a wallet run for one role: the address to deposit to and the exact amount, from the newest CLEAN status of this run only (the helper's reserve check proves the
   * key owns the Ethereum address before any amount is shown; the console shows an address only from a status about this swap's own addresses), "seen" or "not yet", and the warning
   * that an exchange withdrawal may arrive later than the swap's window. null outside a wallet run. `withButton`: a button that reads the deposit again now.
   */
  function depositBlock(payload, role, opts = {}) {
    const plain = !!(opts && opts.plain);
    const a = payload && payload.actions;
    const w = walletOf(a);
    if (!w) return null;
    const r = (w.roles || {})[role] || {};
    const s = r.status || null;
    const box = H.el("section", { class: "spend-box deposit-box", "aria-label": "The deposit" }, H.el("div", { class: "row" }, H.el("strong", { text: "Deposit" }), H.chip("quiet", "this swap's own wallet")));
    const check = actionButton(a, `wallet-status-${role}`, s ? "Read the deposit again" : "Read the deposit now", "Read-only: asks the nodes what the swap's wallet holds. The console also does it about every 40 seconds.");
    if (!r.swap_file) {
      box.appendChild(H.el("p", { class: "plain", text: "The deposit address is shown after the swap file is made: it is the address of a wallet the tool made for this swap, and it is shown only once the tool has checked that its own key opens it." }));
      return box;
    }
    if (!s) {
      box.appendChild(H.el("p", { class: "plain", text: "Not read yet. The console reads the deposit about every 40 seconds; no address is shown before it has." }));
      box.appendChild(H.el("div", { class: "row" }, check));
      return box;
    }
    if (!s.ok || !s.show) {
      box.appendChild(H.el("p", { class: "attn", role: "alert", text: s.ok ? "The last status is not about this swap's own addresses, so no address is shown. Do not deposit anywhere." : `The last status was not clean (${(s.problems || []).join("; ") || "unknown reason"}), so no address is shown. Do not deposit anywhere until a clean status is read.` }));
      box.appendChild(H.el("div", { class: "row" }, check));
      return box;
    }
    if (role === "alice" && s.noid && plain && noidFigure(s.noid.need_micronoid) !== null) {
      const n = s.noid;
      const amt = noidFigure(n.amount_micronoid);
      box.appendChild(depositRowPlain("NOID", n.address, noidFigure(n.need_micronoid), `At least exactly ${n.need_micronoid} micro-NOID: the swap's ${amt !== null ? amt + " NOID" : n.amount_micronoid + " micro-NOID"} and the funding's fee. The wallet holds ${n.plain_micronoid} micro-NOID now.`, n.covers === true));
    } else if (role === "alice" && s.noid) {
      const n = s.noid;
      box.appendChild(depositRow("NOID", n.address, `${n.need_micronoid} micro-NOID`, noidWords(n.need_micronoid), n.covers === true, `the swap's amount (${noidWords(n.amount_micronoid) || n.amount_micronoid + " micro-NOID"}) and the funding's fee reserve. The wallet holds ${n.plain_micronoid} micro-NOID of plain coins now.`));
    }
    if (s.eth && plain && ethFigure(s.eth.required_wei) !== null) {
      const e = s.eth;
      const short = e.covered === true ? "" : `, short by ${e.shortfall_wei} wei`;
      const exact = role === "alice" ? `At least exactly ${e.required_wei} wei: the fee of the reveal, paid from this swap's own key. The ETH you get arrives there too, and goes to your own address at the end. The key holds ${e.balance_wei} wei now${short}.` : `At least exactly ${e.required_wei} wei: the ${ethWords(e.amount_wei) || e.amount_wei + " wei"} and the fees of the lock and of a refund. The key holds ${e.balance_wei} wei now${short}.`;
      box.appendChild(depositRowPlain("ETH", e.address, ethFigure(e.required_wei), exact, e.covered === true));
    } else if (s.eth) {
      const e = s.eth;
      const why = role === "alice" ? "the fee of the reveal, paid from the swap's own Ethereum key; the ETH you buy arrives there too" : `the amount (${ethWords(e.amount_wei) || e.amount_wei + " wei"}) and the fee of the lock and of a refund, in the swap's own Ethereum key`;
      box.appendChild(depositRow("ETH", e.address, `${e.required_wei} wei`, ethWords(e.required_wei), e.covered === true, `${why}. The key holds ${e.balance_wei} wei now${e.covered === true ? "" : `, short by ${e.shortfall_wei} wei`}.`));
    }
    if (plain) {
      box.appendChild(H.el("p", { class: "dim", text: `Read ${typeof s.age_s === "number" ? s.age_s + " s ago" : "just now"}.` }));
      if (role === "alice") box.appendChild(depositClock(payload));
      else box.appendChild(H.el("p", { class: "dim", text: "Deposit now: your lock is sent as soon as Alice's funding is final, and only once your deposit is seen." }));
      box.appendChild(H.el("p", { class: "dim", text: "Send from a wallet you control, not from an exchange: an exchange withdrawal can arrive late. A deposit that arrives too late only means the swap does not start; nothing is locked before the funding." }));
    } else box.appendChild(H.el("p", { class: "dim", text: `Read ${typeof s.age_s === "number" ? s.age_s + " s ago" : "just now"}. An exchange withdrawal can arrive later than this swap's window: send from a wallet you control, and early. A deposit that arrives too late only means the swap does not start; nothing is locked before the funding.` }));
    if (w.noid_payout || w.eth_payout) box.appendChild(H.el("p", { class: "dim", text: `What is left when the swap is over is sent to your own addresses: ${role === "alice" && w.noid_payout ? "NOID to " + w.noid_payout + ", " : ""}ETH to ${w.eth_payout || "(not set)"}.` }));
    box.appendChild(H.el("div", { class: "row" }, check));
    if (!H.state.token) box.appendChild(keyNote());
    return box;
  }

  /** True when the deposit this role must make has been seen (a clean status that covers it), else false. */
  function depositSeen(a, role) {
    const w = walletOf(a);
    const s = w && w.roles && w.roles[role] && w.roles[role].status;
    if (!s || !s.ok || !s.show || !s.eth || s.eth.covered !== true) return false;
    return role === "bob" || !!(s.noid && s.noid.covers === true);
  }

  /** Alice's funding in a wallet run: the order (Bob's check, the deposit, then the autopilot or the Send box), no object file, no "I have funded" box. */
  function walletFundingBlock(view, payload, g) {
    const a = payload.actions;
    const w = walletOf(a);
    const box = H.el("section", { class: "spend-box funding-guide", "aria-label": "Funding: the order" }, H.el("div", { class: "row" }, H.el("strong", { text: g.done || w.funded_marker ? "Funding: recorded" : "Funding from this swap's own wallet" }), g.done || w.funded_marker ? H.chip("ok", "recorded") : H.chip("accent", "after Bob's check and the deposit")));
    if (g.done || w.funded_marker) {
      box.appendChild(H.el("p", { class: "plain", text: w.funded_marker ? `The wallet's funding was sent (${w.funded_marker}). The next ticks follow it; never fund a second time.` : g.done_text }));
      return box;
    }
    const ol = H.el("ol", {});
    for (const t of ["Bob checks the bundle on his machine, and the two bundle check lines are compared over a second channel.", "The deposit below is seen (the NOID for the swap and its fee, and the fee of the reveal in Ethereum).", "Turn on \"Run this swap for me\" below, or use the Send box once. The funding is made from this swap's own wallet: its transaction is written to disk before it is sent, and running it again sends the same bytes, never a second funding."]) ol.appendChild(H.el("li", { text: t }));
    box.appendChild(ol);
    box.appendChild(H.el("p", { class: "alt", text: "There is no object file and no wallet program in this kind of run, and no \"I have funded\" box: the funding is made here." }));
    return box;
  }

  /**
   * The funding box at the top of Alice's first card (while the file is at "created", also before the engine offers the funding): the order in which
   * it is done now (Bob's check, then the console's own button), the object check, and the "I have funded" box with a confirmation before anything is written.
   */
  function fundingBlock(view, payload) {
    const a = payload && payload.actions;
    const g = a && a.enabled ? window.NoidView.fundingGuide(view, a) : null;
    if (!g) return null;
    if (walletOf(a)) {
      const wb = walletFundingBlock(view, payload, g);
      const dep = depositNeeded(view, a) ? depositBlock(payload, "alice") : null;
      if (!dep) return wb;
      const wrap = H.el("div", { class: "wallet-funding" });
      wrap.appendChild(wb);
      wrap.appendChild(dep);
      return wrap;
    }
    const f = a.funding || {};
    const box = H.el("section", { class: "spend-box funding-guide", "aria-label": "Funding: the order" }, H.el("div", { class: "row" }, H.el("strong", { text: g.done ? "Funding: recorded" : g.title }), g.done ? H.chip("ok", "recorded") : H.chip("accent", "after Bob's check")));
    if (g.done) {
      box.appendChild(H.el("p", { class: "plain", text: g.done_text }));
      return box;
    }
    const ol = H.el("ol", {});
    for (const t of g.steps) ol.appendChild(H.el("li", { text: t }));
    box.appendChild(ol);
    box.appendChild(H.el("p", { class: "alt", text: g.alternative }));
    box.appendChild(H.el("div", { class: "row" }, actionButton(a, "check-object", f.object_check_ok ? "Check the object file again" : "Check the object file (needed before step 3)", "The wallet's object file must be the swap file's opening"), f.object_check_ok ? H.chip("ok", "object file OK") : H.chip("attn", "not checked in this session")));
    const cb = H.el("input", { type: "checkbox", id: "funded-ack", checked: f.acknowledged_at ? true : null, disabled: !f.object_check_ok || !!f.acknowledged_at || !!f.marker_at || !H.state.token ? true : null });
    cb.addEventListener("change", () => {
      if (!cb.checked) return;
      // a click must not write markers by itself: say what it does first
      openSimpleConfirm({
        title: "Record that you funded",
        lines: [
          "This writes two markers (funded.marker in the run folder and funded-<contract root>.marker next to the object file) and a line in the audit log.",
          "It closes this console's funding button for good and makes fund.sh refuse for this run folder and this object folder. It does not fund anything and cannot be undone from here.",
          "Confirm only if you ran fund.sh (or the wallet's fund command) outside this console and it was accepted. A funding sent with this console's own button needs no tick here.",
        ],
        confirmLabel: "Yes, I have funded",
        onCancel: () => {
          cb.checked = false;
        },
        onConfirm: async () => {
          const r = await post("/api/funded", { checked: true });
          if (!r.ok) {
            ui.msg = { kind: "danger", text: r.json.error || `HTTP ${r.status}` };
            cb.checked = false;
          } else if (r.json && r.json.note) ui.msg = { kind: "ok", text: r.json.note };
          forceRender();
          await H.reload(true);
          return null;
        },
      });
    });
    box.appendChild(H.el("label", { class: "ack", for: "funded-ack" }, cb, " 3. I have funded the contract outside this console (fund.sh in a terminal, or the wallet). It blocks fund.sh for this run folder and this object folder only, not a COPY of the object file in another folder", f.acknowledged_at ? H.el("span", { class: "dim", text: ` (logged ${H.clock(f.acknowledged_at)})` }) : null));
    if (!H.state.token) box.appendChild(keyNote());
    return box;
  }

  // ------------------------------------------------------------------ the autopilot ("Run this swap for me")
  // One box on the first card of the swap page, for the role of the page. It posts to /api/autopilot only; the server decides everything (the terms the approval
  // is bound to, the statements, the stop rules). The manual boxes stay as they are.

  /** The amount a person types, compared as numbers like the server does ("0.0010 eth" is 0.001 ETH). */
  function typedOk(typed, expected) {
    const m = /^\s*(\d{1,12})(?:\.(\d{1,18}))?\s*([A-Za-z]{3,4})\s*$/.exec(String(typed || ""));
    const e = /^(\d+)(?:\.(\d+))?\s+([A-Z]+)$/.exec(expected || "");
    if (!m || !e || m[3].toUpperCase() !== e[3]) return false;
    const norm = (w, f) => `${BigInt(w)}.${(f || "").padEnd(18, "0")}`;
    return norm(m[1], m[2]) === norm(e[1], e[2]);
  }

  /**
   * What the autopilot box needs, from the payload only: null when the box is not drawn (actions mode off, a production run, a role that runs on another
   * machine, or a finished swap that was never switched on), else the facts. Nothing here decides anything.
   */
  function autopilotFacts(view, payload) {
    const a = payload && payload.actions;
    if (!a || !a.enabled || a.production || !view || !view.role) return null;
    const x = a.autopilot && a.autopilot[view.role];
    if (!x || x.available !== true) return null;
    const needs = Array.isArray(x.needs_you) ? x.needs_you : [];
    const finished = !!(view.phase && (view.phase.terminal || view.phase.id === "aborted"));
    if (!x.on && !needs.length && !x.terms_changed && finished) return null;
    const alice = view.role === "alice";
    return {
      role: view.role,
      on: x.on === true,
      terms_changed: x.terms_changed === true,
      // program mode: why the approval went out of force (the server's `version_changed`; only the program version has words of its own)
      terms_changed_why: x.version_changed === true ? "program_version" : typeof x.terms_changed_why === "string" ? x.terms_changed_why : x.terms_changed_why && typeof x.terms_changed_why.code === "string" ? x.terms_changed_why.code : null,
      expected_typed: x.expected_typed || null,
      // what the person gets for what they give (the approval is bound to both amounts)
      gets_text: typeof x.gets_text === "string" && x.gets_text ? x.gets_text : null,
      // program mode: the line match of the run folder (the two sides' check lines were compared); it pre-ticks the line statement, which is still required
      line_match: !!a.line_match,
      statements: Array.isArray(x.statements) ? x.statements : [],
      needs_you: needs,
      doing: x.doing || null,
      waiting_reason: x.waiting_reason || null,
      finished_notes: Array.isArray(x.finished_notes) ? x.finished_notes.filter((t) => typeof t === "string") : [],
      approved_at: x.approved_at || null,
      valid_until: x.funding_statements_valid_until || null,
      funding_offered: alice ? x.funding_offered === true : null,
      wallet: x.wallet === true,
      payouts: x.wallet === true && x.payouts ? x.payouts : null,
      // Alice can approve only while the engine offers her funding (a wallet run's Alice may approve earlier: the gate waits for the deposit and for Bob's turn)
      can_turn_on: !alice || x.wallet === true || x.funding_offered === true,
    };
  }

  const AP_INTRO_WALLET = {
    alice: "Once you approve, this console funds the NOID from this swap's own wallet and reveals the secret by itself, each step with the same dry run and the same checks as the buttons below. If the swap does not go through it takes the NOID back after the deadline, records that in the swap file, and when the swap is over it sends what is left to YOUR own addresses. It waits for your deposit and for the fee reserve, and stops and asks you when anything is unclear. It never re-sends a stuck transaction. Test networks only.",
    bob: "Once you approve, this console locks the ETH from this swap's own key, claims the NOID and refunds the ETH if the swap does not go through, and when the swap is over it sends what is left of the key to YOUR own address. It waits for your deposit and for the fee reserve, and stops and asks you when anything is unclear. It never re-sends a stuck transaction. Test networks only.",
  };
  const AP_INTRO = {
    alice: "Once you approve, this console funds the NOID and reveals the secret by itself, each step with the same dry run and the same checks as the buttons below. It stops and asks you when anything is unclear. It never re-sends a stuck transaction and never takes NOID back. Test networks only.",
    bob: "Once you approve, this console locks the ETH, claims the NOID and refunds the ETH if the swap does not go through, each step with the same dry run and the same checks as the buttons below. It stops and asks you when anything is unclear. It never re-sends a stuck transaction. Test networks only.",
  };

  function autopilotBlock(view, payload) {
    const f = autopilotFacts(view, payload);
    if (!f) return null;
    const box = H.el("section", { class: "spend-box autopilot-box", "aria-label": "Run this swap for me" }, H.el("div", { class: "row" }, H.el("strong", { text: "Run this swap for me" }), f.on ? H.chip("ok", "on") : H.chip("quiet", "off"), H.chip("warn", "moves funds")));
    if (f.needs_you.length) {
      const al = H.el("div", { class: "alarm danger big", role: "alert", "aria-label": "The autopilot needs you" }, H.el("span", { class: "lv", text: "needs you" }));
      const tx = H.el("span", { class: "tx" });
      for (const n of f.needs_you) {
        const row = H.el("div", { class: "row" }, H.el("strong", { text: n.label || n.spend }), H.el("span", { text: " " + n.reason }));
        if (n.retrying) row.appendChild(H.el("span", { class: "dim", text: " The autopilot is still trying this step on later ticks." }));
        row.appendChild(
          btn(
            "I have dealt with it",
            () => {
              openSimpleConfirm({
                title: "Let the autopilot go on",
                lines: [`Confirm only when you have looked at "${n.label || n.spend}" yourself (the audit log, the contract, the wallet) and know what state it is in.`, "The autopilot then goes on from what the engine and the gate say now, and it can stop this step again."],
                confirmLabel: "Yes, I have dealt with it",
                onConfirm: async () => {
                  const r = await post("/api/autopilot", { clear_needs_you: n.spend, role: f.role });
                  if (!r.ok) return r.json.error || `HTTP ${r.status}`;
                  forceRender();
                  await H.reload(true);
                  return null;
                },
              });
            },
            { disabled: !H.state.token, title: H.state.token ? null : KEY_LOST }
          )
        );
        tx.appendChild(row);
      }
      al.appendChild(tx);
      box.appendChild(al);
    }
    if (f.on) {
      box.appendChild(H.el("p", { class: "plain", text: f.doing || "Starting." }));
      if (f.waiting_reason) box.appendChild(H.el("p", { class: "dim", text: `Waiting for: ${f.waiting_reason}` }));
      for (const t of f.finished_notes) box.appendChild(H.el("p", { class: "dim", text: t }));
      if (f.approved_at) box.appendChild(H.el("p", { class: "dim", text: `Approved ${H.clock(f.approved_at)}. ${isProgram() ? "A change of the terms, of this swap's settings, of the program or of its tools turns it off by itself." : "A change of the terms, of env.local.sh or of the helpers turns it off by itself."}` }));
      if (f.valid_until) box.appendChild(H.el("p", { class: "dim", text: `The two funding statements are good for one automatic funding, until ${H.clock(f.valid_until)}.` }));
      box.appendChild(
        H.el(
          "div",
          { class: "row" },
          btn(
            "Turn off",
            async () => {
              const r = await post("/api/autopilot", { on: false, role: f.role });
              ui.msg = r.ok ? null : { kind: "danger", text: r.json.error || `HTTP ${r.status}` };
              forceRender();
              await H.reload(true);
            },
            { disabled: !H.state.token, title: H.state.token ? "Stops the autopilot. A step that is already running goes on." : KEY_LOST }
          )
        )
      );
      if (!H.state.token) box.appendChild(keyNote());
      return box;
    }
    if (f.terms_changed) box.appendChild(H.el("p", { class: "attn", role: "alert", text: isProgram() && f.terms_changed_why === "program_version" ? "The program was updated since you approved, so the autopilot is off. Approve again after an update, once the terms look right." : isProgram() ? "The terms, the settings of this swap, the program or one of its tools changed since you approved, so the autopilot is off. Check the terms, then approve again if they are right." : "The terms changed since you approved (or a file they are bound to did), so the autopilot is off. Check the terms, then approve again if they are right." }));
    if (f.expected_typed && f.gets_text) box.appendChild(H.el("p", { class: "plain" }, "You give ", coinSpan(f.expected_typed), ". You get ", coinSpan(f.gets_text), "."));
    box.appendChild(H.el("p", { class: "plain", text: (f.wallet ? AP_INTRO_WALLET : AP_INTRO)[f.role] }));
    if (f.wallet) box.appendChild(H.el("p", { class: "plain dim", text: f.role === "alice" ? "A wallet run does not ask the classic funding statement (the wallet holds one funding and the tool refuses a funding another path submitted). It still asks whether Bob's check line matches yours." : f.statements.some((st) => st.id === "alice_check_matches") ? "A wallet run asks three statements: that this computer stays on, that you send no step by hand, and that Alice's check line matches yours." : "A wallet run asks the same two statements as before." }));
    if (!f.can_turn_on) box.appendChild(H.el("p", { class: "attn", text: "The engine does not offer your funding yet. You can turn the autopilot on when it does (after Bob's check)." }));
    // the ticks and the typed amount belong to one swap and one role: another swap (or the other role) opens with an empty form
    const apKey = `${H.state.swap || ""}|${f.role}`;
    if (ui.ap.key !== apKey) ui.ap = { key: apKey, typed: "", ticks: {} };
    const input = H.el("input", { type: "text", id: "ap-typed", autocomplete: "off", spellcheck: "false", "aria-describedby": "ap-typed-hint", placeholder: f.expected_typed || "", value: ui.ap.typed });
    const ticks = f.statements.map((st) => {
      // the line match of the run folder pre-ticks the line statement (still asked, still required); a person's own un-tick is kept
      if (f.line_match && (st.id === "bob_check_matches" || st.id === "alice_check_matches") && ui.ap.ticks[st.id] === undefined) ui.ap.ticks[st.id] = true;
      const cb = H.el("input", { type: "checkbox", id: `ap-stmt-${st.id}`, checked: ui.ap.ticks[st.id] ? true : null });
      cb.addEventListener("change", () => {
        ui.ap.ticks[st.id] = cb.checked;
        refresh();
      });
      return { st, cb, label: H.el("label", { class: "ack", for: `ap-stmt-${st.id}` }, cb, " " + st.text) };
    });
    const go = btn(
      "Turn on…",
      () => {
        const statements = {};
        for (const t of ticks) statements[t.st.id] = !!t.cb.checked;
        const typed = input.value;
        openSimpleConfirm({
          title: "Run this swap for me",
          lines: [
            ...(f.expected_typed && f.gets_text ? [`You give ${f.expected_typed}. You get ${f.gets_text}.`] : []),
            f.wallet
              ? `From now on this console does every step of this swap by itself, from this swap's own wallet${f.payouts ? `, and when it is over it sends what is left to ${f.role === "alice" && f.payouts.noid ? "NOID address " + f.payouts.noid + " and " : ""}ETH address ${f.payouts.eth}` : ""}. The approval is bound to those addresses.`
              : f.role === "alice"
              ? "From now on this console funds the NOID and reveals the secret by itself. The funding goes soon: the two funding statements you ticked are good for ONE automatic funding within 5 minutes."
              : "From now on this console locks the ETH, claims the NOID and refunds the ETH by itself.",
            "Every step is sent through the same dry run and the same checks as the buttons below, and written to the audit log. It stops and asks you when anything is unclear. You can turn it off at any time.",
            isProgram() ? "The approval is bound to these terms, to this swap's settings, to the program's version and to its tools: a change of any of them turns it off." : "The approval is bound to these terms, to env.local.sh and to the helpers in bin/: a change of any of them turns it off.",
          ],
          confirmLabel: "Yes, turn it on",
          onConfirm: async () => {
            const r = await post("/api/autopilot", { on: true, role: f.role, typed, statements });
            if (!r.ok) return [r.json.error || `HTTP ${r.status}`, ...(r.json.reasons || []).map((x) => x.text)].join(" ");
            ui.ap = { key: apKey, typed: "", ticks: {} };
            ui.msg = null;
            forceRender();
            await H.reload(true);
            return null;
          },
        });
      },
      { primary: true, disabled: true }
    );
    const refresh = () => {
      go.disabled = !H.state.token || !f.can_turn_on || !typedOk(input.value, f.expected_typed) || !ticks.every((t) => t.cb.checked);
    };
    input.addEventListener("input", () => {
      ui.ap.typed = input.value;
      refresh();
    });
    box.appendChild(H.el("label", { for: "ap-typed", id: "ap-typed-hint", class: "typed-label" }, "To approve, type the amount and unit of your step: ", H.el("strong", { class: "mono", text: f.expected_typed || "?" })));
    box.appendChild(input);
    for (const t of ticks) box.appendChild(t.label);
    box.appendChild(H.el("div", { class: "row" }, go));
    refresh();
    if (!H.state.token) box.appendChild(keyNote());
    return box;
  }

  // ------------------------------------------------------------------ Bob's check line, kept until his lock
  // Bob's phases before his lock is sent. From "lock_submitted" on the comparison can no longer change anything.
  const BOB_BEFORE_LOCK = ["received", "funded", "funding_final"];

  /** What Bob's swap page says about his bundle check line while he has not locked: `{ line }` with the line of the newest clean join record (exactly as
   *  joinResult reads it), or `{ line: null }` when this console has no such record (the check was made in a terminal, or the record is gone). null for Alice,
   *  outside actions mode, without a tick, and from the lock on. */
  function bobCheck(view, a) {
    if (!view || view.role !== "bob" || !a || !a.enabled) return null;
    const phase = view.phase && view.phase.id;
    if (!BOB_BEFORE_LOCK.includes(phase)) return null;
    const r = joinResult(a.jobs);
    return { line: r && r.line ? r.line : null };
  }

  /** The box on Bob's first card, above his lock's send box: the check line and the one thing to do with it. */
  function bobCheckBlock(view, payload) {
    const a = payload && payload.actions;
    const b = bobCheck(view, a);
    if (!b) return null;
    const box = H.el("section", { class: "spend-box funding-guide", "aria-label": "Your bundle check line" }, H.el("div", { class: "row" }, H.el("strong", { text: "Before you lock: the check line" }), H.chip("quiet", "compare with Alice")));
    if (b.line) box.appendChild(H.el("div", {}, H.el("div", { class: "label", text: "Your line, as the tool printed it" }), H.el("p", { class: "bundle-check mono", text: b.line })));
    else box.appendChild(H.el("p", { class: "dim", text: "This console has no clean record of the bundle check. Your line is the one the join step printed (join.sh in a terminal run)." }));
    box.appendChild(H.el("p", { class: "plain", text: "Its 16 digits must be the ones of the bundle check line on Alice's side, compared over a second channel. If they differ, or you have not compared them, do not lock." }));
    return box;
  }

  // ------------------------------------------------------------------ the start screen ("Start a swap")
  // Shown instead of the swap page while Alice has no tick yet. It adds no action and no request: its buttons are the table's own actions
  // (install, setup, prepare, check-object) and the settings form's own save. What it marks as done is only what the page can read:
  // a file that exists, a finished job with a clean result in this console's own records, the saved settings.

  /** The empty-state test: the console drives Alice, Alice is selected, nothing of Alice's swap exists yet (no tick, tick error or loop file of hers: `roles.alice` is null,
   *  and with the console on both roles no tick of Bob's either: the bundle was handed over), no funding of the run is recorded (a marker or an acknowledgement says a swap
   *  started), the run is not a read-only production run, and every folder the console reads was read without an error (a share that dropped must not look like "nothing yet").
   *  The one exception to the last rule is the run folder that does not exist yet (the lazy lock says so). As soon as a tick exists the normal swap page shows. */
  function noSwapStarted(payload, role) {
    if (role !== "alice") return false;
    if (!payload || (payload.role !== "alice" && payload.role !== "both")) return false;
    if (payload.roles && payload.roles.alice) return false;
    if (payload.role === "both" && payload.roles && payload.roles.bob) return false;
    return quietRun(payload);
  }

  /** What both first screens need before they may show, whatever the role: actions mode, not a production run, every folder the console reads read without an error
   *  (the lazily missing run folder excused), and no funding of the run recorded. */
  function quietRun(payload) {
    const a = payload && payload.actions;
    if (!a || !a.enabled || a.production) return false;
    // the missing run folder (the first one) is the only folder excused, with its one error; every other folder must have been read
    const missing = !!(a.lock && a.lock.folder_missing);
    const dirs = payload.dirs;
    if (!Array.isArray(dirs) || !dirs.length) {
      if (!missing) return false;
    } else if (!dirs.every((d, i) => (missing && i === 0) || (d && d.readable === true))) return false;
    const errs = Array.isArray(payload.errors) ? payload.errors.length : payload.errors ? 1 : 0;
    if (errs > (missing ? 1 : 0)) return false;
    const f = a.funding || {};
    return !(f.marker_at || f.acknowledged_at || f.blocked_by);
  }

  const START_STEPS = [
    { id: "install", action: "install", title: "Install the helpers" },
    { id: "terms", action: null, title: "Enter the terms" },
    { id: "setup", action: "setup", title: "Set up" },
    { id: "prepare", action: "prepare", title: "Prepare the swap files" },
    { id: "check", action: "check-object", title: "Check the object file" },
    { id: "send", action: null, title: "Send Bob the bundle file" },
  ];
  // a later step's own fact shows that an earlier one ran: prepare and the object check need the helpers, the passphrase and the settings
  const IMPLIED_BY = { install: ["setup", "prepare", "check"], terms: ["prepare", "check"], setup: ["prepare", "check"], prepare: ["check"] };
  // a wallet run (the tool's own wallets): no object file and no wallet program; the tool makes the swap's wallets before Prepare, and the deposit is a step of its own
  const START_STEPS_WALLET = [
    { id: "install", action: "install", title: "Install the helpers" },
    { id: "terms", action: null, title: "Enter the terms" },
    { id: "setup", action: "setup", title: "Set up" },
    { id: "wallet", action: "wallet-setup-alice", title: "Make this swap's own wallets" },
    { id: "prepare", action: "prepare", title: "Prepare the swap file" },
    { id: "deposit", action: "wallet-status-alice", title: "Deposit the coins" },
    { id: "send", action: null, title: "Send Bob the bundle file" },
  ];
  const IMPLIED_BY_WALLET = { install: ["setup", "wallet", "prepare"], terms: ["wallet", "prepare"], setup: ["wallet", "prepare"], wallet: ["prepare"] };

  /** The NEWEST record of a table action in this console's records decides: "clean" (done, exit 0), "running", "failed", or null (no record). */
  function newestState(jobs, id) {
    const j = (jobs || []).filter((x) => x && x.id === id).slice(-1)[0];
    if (!j) return null;
    if (j.state === "running") return "running";
    return j.state === "done" && j.ok === true ? "clean" : "failed";
  }
  /** The newest record's finish time when that record is clean, else null: a clean run followed by a failed or a running one is not a fact. */
  function cleanJob(jobs, id) {
    if (newestState(jobs, id) !== "clean") return null;
    const j = (jobs || []).filter((x) => x && x.id === id).slice(-1)[0];
    return { at: typeof j.finished_at === "number" ? j.finished_at : null };
  }

  /** The facts the start screen reads from the payload (nothing else is read). */
  function startFacts(p) {
    const a = (p && p.actions) || {};
    const env = a.form && a.form.env_local && a.form.env_local.exists === true ? { bytes: typeof a.form.env_local.bytes === "number" ? a.form.env_local.bytes : null, mtime: typeof a.form.env_local.mtime === "number" ? a.form.env_local.mtime : null } : null;
    const f = a.funding || {};
    // no run folder: nothing of this run has been done, whatever a file elsewhere (a public copy folder) holds
    if (a.lock && a.lock.folder_missing) return { folder_missing: true, install: null, env: null, setup: null, bundle: null, object_file: false, check: null, states: {} };
    return {
      folder_missing: false,
      install: cleanJob(a.jobs, "install"),
      env,
      setup: cleanJob(a.jobs, "setup"),
      // what the newest record of each helper step says (null: no record); a running or failed prepare means the bundle file is not the end of it
      states: { install: newestState(a.jobs, "install"), setup: newestState(a.jobs, "setup"), prepare: newestState(a.jobs, "prepare") },
      bundle: p && p.bundle && p.bundle_file ? { path: p.bundle_file.path || null, name: p.bundle_file.name || null } : null,
      object_file: !!(p && p.object_file),
      check: f.object_check_ok === true ? { at: typeof f.object_check_at === "number" ? f.object_check_at : null } : null,
      // a wallet run: the wallets are made when the setup helper ran clean (or its addresses file exists), the deposit is seen when a clean status covers it
      wallet: walletOf(a) ? { setup: cleanJob(a.jobs, "wallet-setup-alice"), addresses_file: !!(((a.wallet.roles || {}).alice || {}).addresses_file), deposit: depositSeen(a, "alice") } : null,
    };
  }

  /**
   * The six steps with their state: done (with the fact that shows it: `done_by` job, file or implied), now (the first one that is not done) or todo.
   * Step 6 (give Bob the file) is never done: the page cannot see it. `known` is false where the page has no fact either way about a step that is not
   * done (no record of a run, as against a missing file).
   */
  function startSteps(f) {
    const wallet = !!f.wallet;
    const list = wallet ? START_STEPS_WALLET : START_STEPS;
    const impliedBy = wallet ? IMPLIED_BY_WALLET : IMPLIED_BY;
    const rec = f.states || {};
    // prepare.sh writes the bundle BEFORE the proof, Bob's file and the definition: the bundle file alone is a fact only while no record says the run is going on or failed
    const prepareBad = rec.prepare === "running" || rec.prepare === "failed";
    const own = {
      install: f.install ? { by: "job", at: f.install.at } : null,
      terms: f.env ? { by: "file", at: f.env.mtime, bytes: f.env.bytes } : null,
      setup: f.setup ? { by: "job", at: f.setup.at } : null,
      prepare: f.bundle && !prepareBad ? { by: "file", path: f.bundle.path } : null,
      check: wallet ? null : f.check ? { by: "job", at: f.check.at } : null,
      wallet: wallet ? (f.wallet.setup ? { by: "job", at: f.wallet.setup.at } : f.wallet.addresses_file ? { by: "file" } : null) : null,
      deposit: wallet && f.wallet.deposit ? { by: "status" } : null,
    };
    // what a later step's fact may imply: the object check implies nothing while a prepare is running or failed
    const implier = (l) => !!own[l] && !(l === "check" && prepareBad);
    const known = { install: !!f.folder_missing, terms: true, setup: false, prepare: true, check: false, wallet: false, deposit: true, send: false };
    const steps = list.map((s, i) => {
      const fact = own[s.id] || null;
      const from = fact || (s.id === "prepare" && prepareBad) ? null : (impliedBy[s.id] || []).find(implier) || null;
      return { id: s.id, n: i + 1, title: s.title, action: s.action, state: fact || from ? "done" : "todo", done_by: fact ? fact.by : from ? "implied" : null, at: fact && fact.at !== undefined ? fact.at : null, bytes: fact && fact.bytes !== undefined ? fact.bytes : null, path: fact && fact.path ? fact.path : null, from, known: known[s.id], rec: rec[s.id] || null };
    });
    const first = steps.find((s) => s.state !== "done" && s.id !== "send");
    const now = first || steps[steps.length - 1];
    now.state = "now";
    return steps;
  }

  // a wallet run's own words for the steps that differ (the tool makes the swap's wallets; the deposit is read by the console)
  const START_SAY_WALLET = {
    terms: "What you and Bob agreed: the two amounts, Bob's addresses, the Ethereum contract and the profile, and YOUR OWN payout addresses (where what is left of the swap's wallets goes). The tool makes this swap's own wallets for you, so your own wallet addresses are not asked. Saving writes one settings file in the run folder. Sends nothing.",
    wallet: "Makes a fresh NOID wallet and a fresh Ethereum key for this one swap, sealed with this run's passphrase, and checks that the key opens the Ethereum address it will show. Nothing is deposited or sent. Your own wallets are never used.",
    prepare: "Makes your swap file with a fresh secret and this swap's wallet and key sealed in it, and the bundle file for Bob. The swap file is the only place the keys live: back it up. Sends nothing. With the proof-free lock kind (poseidon) it takes seconds, otherwise 20 to 36 minutes.",
    deposit: "Deposit the NOID and the fee reserve to the addresses below. The console reads the deposit about every 40 seconds; this step is done when it is seen. You can send Bob the bundle file now.",
  };
  const START_SAY = {
    install: "Makes this run's folder and puts a fixed copy of the helper scripts in it, so every later step runs the same code. Sends nothing.",
    terms: "What you and Bob agreed: the two amounts, the four wallet addresses, the Ethereum contract and the profile. Saving writes one settings file in the run folder. Sends nothing.",
    setup: "Creates the passphrase file (kept if there is one), the folders and the Ethereum log start, read from the node. Sends nothing.",
    prepare: "Makes your swap file with a fresh secret sealed in it, the bundle file for Bob, Bob's own file and the contract definition. Sends nothing. With the proof-free lock kind (poseidon) it takes seconds, otherwise 20 to 36 minutes.",
    check: "The wallet's object file must hold exactly the opening your swap file holds. This checks it and prints the address to fund. Reads only.",
    send: "Hand Bob the bundle file. It holds no secret.",
  };
  // what Bob does with it (the README's order: his new-bob, then the two bundle check lines compared) and how it travels (the sentence prepare.sh prints)
  const START_BOB = "Bob runs new-bob on the bundle file, and then the two of you compare the two bundle check lines. Send it as a file, not as pasted text.";
  const START_NOT_KNOWN = {
    install: "Not known whether this ran: this console has no record of it. The helper refuses what it must not repeat, so you can run it again if you are not sure.",
    setup: "Not known whether this ran: this console has no record of it. The helper keeps an existing passphrase.",
    check: "Not known whether the file was checked: this console has no record of a clean check since it started.",
    send: "The page cannot see whether Bob has the file.",
  };
  const START_LOCKS_NOTHING = "These steps lock nothing and send nothing to either chain.";
  const START_FUNDED = "If you have already funded, from a terminal or with the wallet, this page cannot see it until the tool's first tick: start the watch loop above.";
  const START_WALLET = ["No object file is visible yet. Prepare's own next step is to make it with the wallet: ", "parano1d-cli contract create swap.def.json --out swap.object.json", ", on the swap.def.json that Prepare wrote, then put swap.object.json in the public copy folder."];

  const empty = (n) => {
    while (n.firstChild) n.removeChild(n.firstChild);
    return n;
  };

  /** One short line under a step in the sequence: the fact behind a check mark, or what is missing. */
  function stepLine(s) {
    const t = (u) => (typeof u === "number" ? ` at ${H.clock(u)}` : "");
    if (s.id === "wallet" || s.id === "deposit") {
      if (s.state === "done") return s.id === "deposit" ? "the deposit is seen" : s.done_by === "job" ? `ran${t(s.at)}, exit 0` : s.done_by === "implied" ? "seen from the swap file that exists" : "the addresses file exists";
      if (s.state === "now" && s.rec === "running") return "running now";
      return s.id === "deposit" ? "not seen yet" : "the wallets are not made yet";
    }
    if (s.state === "done") {
      if (s.done_by === "implied") return s.from === "check" ? "seen from the object check that passed" : "seen from the bundle file that exists";
      if (s.id === "terms") return `env.local.sh saved${s.bytes !== null ? `, ${s.bytes} B` : ""}`;
      if (s.id === "prepare") return s.rec === "clean" ? "bundle file found, Prepare ended clean" : "bundle file found; this console has no record that Prepare finished";
      if (s.id === "check") return `object file OK${t(s.at)}`;
      return `ran${t(s.at)}, exit 0`;
    }
    if (s.state === "now" && s.id === "send") return "the page cannot see whether Bob has it";
    if (s.state === "now" && s.rec === "running") return "running now";
    if (s.state === "now" && s.rec === "failed") return "the last run did not end cleanly";
    if (s.state === "now" && !s.known) return "not known: the page has no record";
    if (s.state === "now") return s.id === "install" ? "the run folder does not exist yet" : s.id === "terms" ? "no settings file yet" : "no bundle file yet";
    return s.id === "send" ? "the page cannot see this" : "";
  }

  function stepList(steps) {
    const ol = H.el("ol", { class: "start-steps", "aria-label": "The steps of starting a swap" });
    for (const s of steps) {
      const word = s.state === "done" ? "done" : s.state === "now" ? "next" : "not yet";
      ol.appendChild(H.el("li", { class: s.state, "aria-current": s.state === "now" ? "step" : null }, H.el("span", { class: "n", text: String(s.n) }), H.el("span", { class: "what", text: s.title }), H.el("span", { class: "st" }, s.state === "done" ? H.el("span", { class: "tick", "aria-hidden": "true", text: "✓ " }) : null, word), H.el("span", { class: "line", text: stepLine(s) })));
    }
    return ol;
  }

  /** "5.000000" -> "5", "0.500000" -> "0.5" (only after a decimal point). */
  const trimZeros = (v) => { const x = String(v); return x.includes(".") ? x.replace(/0+$/, "").replace(/.$/, "") : x; };

  /** The amounts as the swap's own terms say them, else as typed in the form: NOID lime, ETH periwinkle. */
  function updateTrade() {
    if (!ui.trade) return;
    const input = (k) => (ui.form ? ui.form.querySelector(`#f-${k}`) : null);
    const ok = (v) => (v && /^\d+(\.\d+)?$/.test(v.trim()) ? v.trim() : null);
    const n = ui.tradeTerms ? ui.tradeTerms.noid : ok(input("noid_amount") && input("noid_amount").value);
    const e = ui.tradeTerms ? ui.tradeTerms.eth : ok(input("eth_amount") && input("eth_amount").value);
    empty(ui.trade);
    ui.trade.appendChild(H.el("span", { class: "c-noid", text: `${n || "—"} NOID` }));
    ui.trade.appendChild(H.el("span", { class: "for", text: " for " }));
    ui.trade.appendChild(H.el("span", { class: "c-eth", text: `${e || "—"} ETH` }));
  }

  /**
   * Alice's own "bundle check:" line, as prepare.sh printed it, or null. Only the line that carries "bundle copied to" counts (prepare.sh prints it from new-alice's output;
   * another "bundle check:" in the output can be the local new-bob's), taken from the newest clean prepare record. If that cannot be told, null.
   */
  function bundleCheckLine(jobs) {
    const j = (jobs || []).filter((x) => x && x.id === "prepare" && x.state === "done" && x.ok === true).slice(-1)[0];
    const m = j ? /bundle copied to [^\n]*? -- (bundle check:[^\n]*)/.exec(`${j.stdout || ""}\n${j.stderr || ""}`) : null;
    return m ? m[1].trim() : null;
  }

  /** The strip's one button: the table's own action, the form's own save, or (the last step) the copy of the bundle file's path. */
  function stepButton(a, s, payload) {
    if (s.id === "terms") {
      const why = H.state.token ? null : KEY_LOST;
      return { el: btn("Save the terms", () => ensureForm(a).save(), { primary: true, big: true, disabled: !!why, title: why || "Writes env.local.sh from the form below: the same save as the form's own button" }), why };
    }
    if (s.id === "send") {
      const path = payload.bundle_file && (payload.bundle_file.path || payload.bundle_file.name);
      const b = H.copyButton(path || "", "the bundle file's path", "Copy the file path");
      b.className = "btn primary";
      return { el: b, why: null };
    }
    const entry = (a.table || []).find((e) => e.id === s.action);
    const why = actionWhy(a, s.action);
    return { el: btn(s.id === "deposit" ? "Read the deposit now" : s.button || s.title, () => startAction(s.action), { primary: true, big: true, disabled: !!why, title: why || (entry ? `${entry.note}\n\n${entry.command || ""}` : "") }), why };
  }

  /** The form is built once; until the person picks a role by hand it shows the role of the screen it is on (a console started with --role has only that one valid). */
  function ensureForm(a, role) {
    if (!ui.form) ui.form = buildForm(a);
    if (role && !ui.roleTouched) {
      const sel = ui.form.querySelector("#f-role");
      if (sel && [...sel.options].some((o) => o.value === role)) sel.value = role;
    }
    return ui.form;
  }

  /** Draws the start screen: the strip into #next-action, the rest into #start. The caller has emptied the other sections. */
  function renderStart(payload) {
    const a = payload.actions;
    const facts = startFacts(payload);
    const steps = startSteps(facts);
    const next = steps.find((s) => s.state === "now");
    // the deposit does not hold back the file for Bob: he needs it to start, and the deposit can be made meanwhile
    const allDone = steps.filter((s) => s.id !== "send" && s.id !== "deposit").every((s) => s.state === "done");
    const form = ensureForm(a, "alice");
    const termsNext = next.id === "terms";
    const wallet = !!facts.wallet;
    if (termsNext && !ui.termsOpened) {
      form.open = true;
      ui.termsOpened = true;
    }

    // ---- the strip
    const strip = empty($("next-action"));
    strip.classList.remove("warn-rail", "attn-rail", "danger-rail", "ok-rail");
    strip.classList.add("act", "two");
    const run = (a.jobs || []).filter((j) => j.state === "running" && j.id === next.action).slice(-1)[0];
    const say = H.el("div", { class: "due-say" }, H.el("div", { class: "card-head" }, H.el("h2", { id: "h-action" }, next.title, " ", H.chip("accent", `Step ${next.n} of ${steps.length}, your step`))));
    say.appendChild(H.el("p", { class: "plain", text: (wallet && START_SAY_WALLET[next.id]) || START_SAY[next.id] }));
    if (next.id === "prepare" && facts.bundle && next.rec === "running") say.appendChild(H.el("p", { class: "plain", text: "The bundle file already exists, but Prepare has not finished: Bob's file and the definition come after it." }));
    if (next.id === "prepare" && facts.bundle && next.rec === "failed") say.appendChild(H.el("p", { class: "plain", text: "The bundle file exists, but the last Prepare run did not end cleanly: the files after it may be missing. Read its result below." }));
    if (next.id === "check" && !wallet && !facts.object_file) say.appendChild(H.el("p", { class: "plain" }, START_WALLET[0], H.el("code", { class: "mono", text: START_WALLET[1] }), START_WALLET[2]));
    if (!next.known && START_NOT_KNOWN[next.id] && !(next.id === "install" && facts.folder_missing)) say.appendChild(H.el("p", { class: "plain dim", text: START_NOT_KNOWN[next.id] }));
    if (run) say.appendChild(H.el("p", { class: "plain", text: "Running now. The result shows here when it ends." }));
    if (termsNext) say.appendChild(H.el("p", { class: "plain dim", text: "Fill in the form below, then save." }));
    strip.appendChild(say);
    const b = stepButton(a, next, payload);
    const doBox = H.el("div", { class: "due-do start-go" }, b.el);
    if (b.why) doBox.appendChild(H.el("p", { class: "why", text: b.why }));
    if (ui.msg) doBox.appendChild(H.el("p", { class: ui.msg.kind === "danger" ? "attn" : "plain", role: "alert", text: ui.msg.text }));
    if (ui.formMsg && ui.formMsg.kind === "danger" && termsNext) doBox.appendChild(H.el("p", { class: "attn", role: "alert", text: ui.formMsg.text }));
    strip.appendChild(doBox);
    const lastJob = next.action ? (a.jobs || []).filter((j) => j.id === next.action).slice(-1)[0] : null;
    if (lastJob) strip.appendChild(H.el("div", { class: "due-more" }, jobBox(lastJob, false)));

    // ---- the rest
    const start = empty($("start"));
    start.hidden = false;
    start.appendChild(H.el("section", { class: "block", "aria-labelledby": "h-steps" }, H.el("div", { class: "card-head" }, H.el("h2", { id: "h-steps", text: "Start a swap" }), H.el("div", { class: "right" }, H.chip("quiet", START_LOCKS_NOTHING))), stepList(steps)));

    // the terms: the settings form itself, opened here while it is the step
    const t = payload.terms;
    ui.tradeTerms = t && t.amount_micronoid !== null && t.amount_micronoid !== undefined && t.eth && t.eth.amount_wei !== null && t.eth.amount_wei !== undefined ? { noid: trimZeros(window.NoidView.noidText(t.amount_micronoid)), eth: window.NoidView.ethText(t.eth.amount_wei) } : null;
    if (!ui.trade) ui.trade = H.el("p", { class: "trade", "aria-label": "The trade" });
    updateTrade();
    const termsBox = H.el("section", { class: "block start-terms" + (termsNext ? " is-next" : ""), "aria-labelledby": "h-terms" }, H.el("div", { class: "card-head" }, H.el("h2", { id: "h-terms", text: "The terms" })), ui.trade);
    if (!termsNext && a.form && a.form.env_local && a.form.env_local.exists) termsBox.appendChild(H.el("p", { class: "dim", text: `env.local.sh exists in the run folder (${a.form.env_local.bytes} B, ${H.dayClock(a.form.env_local.mtime)}). It is never shown here.` }));
    if (!H.state.token) termsBox.appendChild(keyNote());
    termsBox.appendChild(form);
    if (ui.formMsg) termsBox.appendChild(H.el("p", { class: ui.formMsg.kind === "danger" ? "attn" : "plain", role: "alert", text: ui.formMsg.text }));
    start.appendChild(termsBox);

    // a wallet run: the deposit, from the swap file's own wallet, once the swap file exists
    if (wallet && a.wallet && a.wallet.roles && a.wallet.roles.alice && a.wallet.roles.alice.swap_file) start.appendChild(H.el("section", { class: "block", "aria-labelledby": "h-deposit" }, H.el("div", { class: "card-head" }, H.el("h2", { id: "h-deposit", text: "Your deposit" })), depositBlock(payload, "alice")));

    // after the object check (a wallet run: after Prepare): the file for Bob, and where the funding comes
    if (allDone) {
      const path = payload.bundle_file && payload.bundle_file.path;
      const box = H.el("section", { class: "block start-send", "aria-labelledby": "h-send" }, H.el("div", { class: "card-head" }, H.el("h2", { id: "h-send", text: "Send Bob the bundle file" })));
      if (path) box.appendChild(H.el("div", { class: "row" }, H.copyButton(path, "the bundle file's path", path)));
      box.appendChild(H.el("p", { class: "plain", text: START_BOB }));
      const line = bundleCheckLine(a.jobs);
      if (line) box.appendChild(H.el("div", {}, H.el("div", { class: "label", text: "Your line, as Prepare printed it" }), H.el("p", { class: "bundle-check mono", text: line })));
      else box.appendChild(H.el("p", { class: "dim", text: "Your bundle check line is the one Prepare printed (it is also in new-alice.err in the run folder)." }));
      const g = window.NoidView.fundingGuide({ role: "alice", phase: { id: "created" }, action: null }, a);
      if (g) box.appendChild(H.el("p", { class: "plain", text: `Funding comes later, on the swap page: ${g.title.charAt(0).toLowerCase()}${g.title.slice(1)}.` }));
      // the page cannot see a funding made elsewhere, and nothing here makes the first tick: the table's own watch-start, the same button and reasons as in the panel
      const w = a.watch || {};
      const watch = H.el("div", { class: "watch row" }, H.el("strong", { text: "Watch loop" }), w.started_here ? H.chip("ok", `running (started here${w.pid ? ", pid " + w.pid : ""})`) : w.some_loop_running ? H.chip("attn", "a loop is updating the files, not started here") : H.chip("danger", "not running"), actionButton(a, "watch-start", "Start the watch loop", "Detached; keeps running when this page is closed"));
      box.appendChild(H.el("p", { class: "plain", text: "The swap page appears at the tool's first tick, which the watch loop makes." }));
      box.appendChild(watch);
      if (!H.state.token) box.appendChild(keyNote());
      start.appendChild(box);
    }

    start.appendChild(H.el("section", { class: "block", "aria-labelledby": "h-stops" }, H.el("div", { class: "card-head" }, H.el("h2", { id: "h-stops", text: "What happens if it stops here" })), H.el("p", { class: "plain", text: facts.bundle ? `${START_LOCKS_NOTHING} Nothing is locked before the funding.` : `${START_LOCKS_NOTHING} Nothing is locked before the funding, so stopping now costs nothing.` }), wallet ? H.el("p", { class: "plain", text: "Coins you deposited stay in this swap's own wallet. If the swap does not go through, the NOID comes back to it after the deadline, and what is left is sent to your own addresses when the swap is over." }) : facts.bundle ? H.el("p", { class: "plain", text: START_FUNDED }) : null));
    start.classList.toggle("terms-next", termsNext);
  }

  /** Empties the start screen's own section (the swap page is showing). */
  function clearStart() {
    // leaving a swap forgets its autopilot form (ticks and typed amount)
    ui.ap = { typed: "", ticks: {} };
    const s = $("start");
    if (s) {
      empty(s);
      s.hidden = true;
    }
    const strip = $("next-action");
    if (strip) strip.classList.remove("act", "two");
  }

  // ------------------------------------------------------------------ the join screen ("Join a swap", Bob's first screen)
  // The mirror of the start screen for the ETH side: shown while Bob has no tick yet. It adds no action and no request either: its buttons are the table's own
  // install, setup, join and watch-start, the settings form's own save, and a copy of the run folder's path. Done is only what the page can read: a clean newest
  // job record of this console, the saved settings, a bundle file of that exact name in the run folder (or in the public copy folder, where the console
  // can name it to the helper), Bob's swap file next to a clean newest join record. The terms it shows are the ones the helper printed.

  /** The test for Bob's screen: the console drives Bob and Bob is selected, nothing of Bob's swap exists (no tick, tick error or loop file of his; with both roles none of Alice's either:
   *  one owner prepared both files), no helper result file, no funding recorded, no swap file of Alice's, the run is not a production run, every folder was read without an error,
   *  and Bob's swap file is not there unless this console's own join made it (a clean or a running newest `join` record). Without the server's `join` facts it does not show. */
  function noJoinStarted(payload, role) {
    if (role !== "bob") return false;
    if (!payload || (payload.role !== "bob" && payload.role !== "both")) return false;
    if (payload.roles && payload.roles.bob) return false;
    if (payload.role === "both" && payload.roles && payload.roles.alice) return false;
    if (!quietRun(payload)) return false;
    if (Array.isArray(payload.helpers) && payload.helpers.length) return false;
    const a = payload.actions;
    const j = a.join;
    if (!j || typeof j !== "object") return false;
    if (j.alice_file) return false;
    const rec = newestState(a.jobs, "join");
    if (j.bob_file && rec !== "clean" && rec !== "running") return false;
    return true;
  }

  const JOIN_STEPS = [
    { id: "install", action: "install", title: "Install the helpers" },
    { id: "terms", action: null, title: "Enter your terms" },
    { id: "setup", action: "setup", title: "Set up" },
    { id: "file", action: null, title: "Put Alice's file in the folder" },
    { id: "check", action: "join", title: "Check Alice's file" },
    { id: "watch", action: "watch-start", title: "Start the watch loop" },
  ];
  // a later step's own fact shows that an earlier one ran: the check needs the helpers, the settings, the passphrase and the file
  const JOIN_IMPLIED = { install: ["setup", "check"], terms: ["check"], setup: ["check"], file: ["check"] };
  // a wallet run: the tool makes Bob's Ethereum key before the check, and the deposit is the last step (the watch loop can start before it)
  const JOIN_STEPS_WALLET = [
    { id: "install", action: "install", title: "Install the helpers" },
    { id: "terms", action: null, title: "Enter your terms" },
    { id: "setup", action: "setup", title: "Set up" },
    { id: "wallet", action: "wallet-setup-bob", title: "Make this swap's own Ethereum key" },
    { id: "file", action: null, title: "Put Alice's file in the folder" },
    { id: "check", action: "join", title: "Check Alice's file" },
    { id: "watch", action: "watch-start", title: "Start the watch loop" },
    { id: "deposit", action: "wallet-status-bob", title: "Deposit the ETH" },
  ];
  const JOIN_IMPLIED_WALLET = { install: ["setup", "wallet", "check"], terms: ["wallet", "check"], setup: ["wallet", "check"], wallet: ["check"], file: ["check"] };

  const TERM_LABELS = ["your Parano1d address", "your Ethereum address", "the contract", "the NOID amount", "the ETH amount", "the chain", "the profile", "the contract version", "the lock kind", "the variant"];
  const TERMS_HEAD = "Your terms, as this machine will state them (check them against what you agreed):";

  /** The "Your terms" block and the one `bundle check:` line of the newest `join` record, when that record is clean: exactly as the helper printed them. The check line must be a
   *  whole line `bundle check: <16 hex> ok` and the only one, else null; the terms must be the ten lines in the helper's order, else null. */
  function joinResult(jobs) {
    const j = (jobs || []).filter((x) => x && x.id === "join").slice(-1)[0];
    if (!j || j.state !== "done" || j.ok !== true) return null;
    const lines = String(j.stdout || "").replace(/\r/g, "").split("\n");
    const checks = lines.filter((l) => /^bundle check: [0-9a-fA-F]{16} ok$/.test(l));
    const at = lines.indexOf(TERMS_HEAD);
    let terms = null;
    if (at >= 0) {
      const rows = [];
      for (let i = 0; i < TERM_LABELS.length; i++) {
        const m = /^ {2}([^:]+):\s+(\S.*)$/.exec(lines[at + 1 + i] || "");
        if (!m || m[1] !== TERM_LABELS[i]) {
          rows.length = 0;
          break;
        }
        rows.push({ label: m[1], value: m[2] });
      }
      if (rows.length === TERM_LABELS.length) terms = rows;
    }
    return { line: checks.length === 1 ? checks[0] : null, terms, finished_at: typeof j.finished_at === "number" ? j.finished_at : null };
  }

  /** The facts of Bob's screen (nothing else is read). */
  function joinFacts(p) {
    const a = (p && p.actions) || {};
    const j = a.join || {};
    const env = a.form && a.form.env_local && a.form.env_local.exists === true ? { bytes: typeof a.form.env_local.bytes === "number" ? a.form.env_local.bytes : null, mtime: typeof a.form.env_local.mtime === "number" ? a.form.env_local.mtime : null } : null;
    // no run folder: nothing of this run has been done, whatever a file elsewhere (a public copy folder) holds
    if (a.lock && a.lock.folder_missing) return { folder_missing: true, install: null, env: null, setup: null, file: { where: null, problem: null }, check: null, watch: null, folder: null, states: {}, bob_file: false, receipt_in_run: false };
    // where the file is: the run folder's own (a good one), else the public copy's when the console can name it to the helper; a bad one is a problem the step names
    const run = j.run_bundle || null;
    const pub = j.public_bundle || null;
    let where = null;
    let problem = null;
    if (run) {
      if (run.ok) where = "run";
      else problem = `alice.bundle.json in the run folder is ${run.problem || "not usable"}`;
    } else if (pub) {
      if (pub.ok && j.public_arg) where = "public";
      else if (pub.ok) problem = "alice.bundle.json is in the public copy folder, but its path cannot be given to the helper: put it in the run folder";
      else problem = `alice.bundle.json in the public copy folder is ${pub.problem || "not usable"}`;
    }
    const joined = cleanJob(a.jobs, "join");
    const w = a.watch || {};
    const d0 = Array.isArray(p && p.dirs) && p.dirs[0] && typeof p.dirs[0].path === "string" ? p.dirs[0].path : null;
    return {
      folder_missing: false,
      install: cleanJob(a.jobs, "install"),
      env,
      setup: cleanJob(a.jobs, "setup"),
      file: { where, problem },
      // a clean newest join is a fact about the swap file only while the file is there
      check: joined && j.bob_file === true ? { at: joined.at } : null,
      watch: w.started_here === true ? { pid: w.pid || null } : null,
      folder: d0,
      states: { install: newestState(a.jobs, "install"), setup: newestState(a.jobs, "setup"), join: newestState(a.jobs, "join") },
      bob_file: j.bob_file === true,
      receipt_in_run: j.receipt_in_run === true,
      wallet: walletOf(a) ? { setup: cleanJob(a.jobs, "wallet-setup-bob"), addresses_file: !!(((a.wallet.roles || {}).bob || {}).addresses_file), deposit: depositSeen(a, "bob") } : null,
    };
  }

  /** The six steps of Bob's screen: done (with the fact), next (the first that is not done) or not yet. When every step is done there is no next step. */
  function joinSteps(f) {
    const wallet = !!f.wallet;
    const list = wallet ? JOIN_STEPS_WALLET : JOIN_STEPS;
    const impliedBy = wallet ? JOIN_IMPLIED_WALLET : JOIN_IMPLIED;
    const rec = f.states || {};
    const own = {
      install: f.install ? { by: "job", at: f.install.at } : null,
      terms: f.env ? { by: "file", at: f.env.mtime, bytes: f.env.bytes } : null,
      setup: f.setup ? { by: "job", at: f.setup.at } : null,
      file: f.file && f.file.where ? { by: "file", where: f.file.where } : null,
      check: f.check ? { by: "job", at: f.check.at } : null,
      watch: f.watch ? { by: "loop", pid: f.watch.pid } : null,
      wallet: wallet ? (f.wallet.setup ? { by: "job", at: f.wallet.setup.at } : f.wallet.addresses_file ? { by: "file" } : null) : null,
      deposit: wallet && f.wallet.deposit ? { by: "status" } : null,
    };
    const known = { install: !!f.folder_missing, terms: true, setup: false, wallet: false, file: true, check: true, watch: true, deposit: true };
    const steps = list.map((s, i) => {
      const fact = own[s.id] || null;
      const from = fact ? null : (impliedBy[s.id] || []).find((l) => !!own[l]) || null;
      const recId = s.id === "check" ? "join" : s.id;
      return { id: s.id, n: i + 1, title: s.title, action: s.action, state: fact || from ? "done" : "todo", done_by: fact ? fact.by : from ? "implied" : null, at: fact && fact.at !== undefined ? fact.at : null, bytes: fact && fact.bytes !== undefined ? fact.bytes : null, where: fact && fact.where ? fact.where : null, pid: fact && fact.pid ? fact.pid : null, from, known: known[s.id], rec: rec[recId] || null };
    });
    const first = steps.find((s) => s.state !== "done");
    if (first) first.state = "now";
    return steps;
  }

  const JOIN_SAY_WALLET = {
    terms: "What you and Alice agreed, as you state it: the two amounts, the contract, the profile, the lock kind, the variant, the contract version, your own Parano1d address (where the NOID you buy goes) and YOUR OWN Ethereum payout address (where what is left of the swap's key goes). The tool makes this swap's own Ethereum key, so your own Ethereum address is not asked. Saving writes one settings file in the run folder. Sends nothing.",
    wallet: "Makes a fresh Ethereum key for this one swap, sealed with this run's passphrase, and checks that the key opens the address it will show. Tell Alice this address when she asks for Bob's Ethereum address: it is the sender of your lock. Nothing is deposited or sent. Your own wallet is never used.",
    check: "The tool rebuilds the swap from Alice's file, compares it with your own terms and writes your swap file with this swap's key sealed in it (back the file up: it is the only place the key lives). Nothing is sent to any chain. If it refuses, its reason shows below and nothing is written.",
    deposit: "Deposit the ETH to the address below: the amount you lock and the fee reserve. The console reads the deposit about every 40 seconds; the tool locks only when it is seen.",
  };
  const JOIN_SAY = {
    install: "Makes this run's folder and puts a fixed copy of the helper scripts in it, so every later step runs the same code. Sends nothing.",
    terms: "What you and Alice agreed, as you state it: the two amounts, the contract, the profile, the lock kind, the variant, the contract version and the wallet addresses. These must be what YOU agreed: the check compares Alice's file against them, and a file that differs is refused. The form also asks for Alice's addresses: enter what she told you. Saving writes one settings file in the run folder. Sends nothing.",
    setup: "Creates the passphrase file (kept if there is one), the folders and the Ethereum log start, read from the node. Sends nothing.",
    file: "Alice sends you her bundle file, named alice.bundle.json. Put it in the run folder shown below. It holds no secret. Send and receive it as a file, not as pasted text.",
    check: "The tool rebuilds the swap from Alice's file, compares it with your own terms and writes your swap file. Nothing is sent to any chain and no key is touched. If it refuses, its reason shows below and nothing is written.",
    watch: "Starts the loop that makes the tool's ticks; the swap page appears at the first tick. Start it only once the check line below is the same as the one Alice's side shows. It records facts and sends nothing.",
  };
  const JOIN_LOCKS_NOTHING = "These steps lock nothing and send nothing to either chain.";
  const JOIN_NOTHING_LOCKED = "Nothing of yours is locked until you lock ETH, which the tool offers only after Alice's funding is final.";

  /** One short line under a step of Bob's screen: the fact behind a check mark, or what is missing. */
  function joinLine(s, f) {
    const t = (u) => (typeof u === "number" ? ` at ${H.clock(u)}` : "");
    if (s.id === "wallet" || s.id === "deposit") {
      if (s.state === "done") return s.id === "deposit" ? "the deposit is seen" : s.done_by === "job" ? `ran${t(s.at)}, exit 0` : s.done_by === "implied" ? "seen from the check that passed" : "the addresses file exists";
      if (s.state === "now" && s.rec === "running") return "running now";
      return s.id === "deposit" ? "not seen yet" : "the key is not made yet";
    }
    if (s.state === "done") {
      if (s.done_by === "implied") return "seen from the check that passed";
      if (s.id === "terms") return `env.local.sh saved${s.bytes !== null ? `, ${s.bytes} B` : ""}`;
      if (s.id === "file") return s.where === "public" ? "found in the public copy folder" : "found in the run folder";
      if (s.id === "check") return `Alice's file accepted${t(s.at)}`;
      if (s.id === "watch") return `loop running (started here${s.pid ? ", pid " + s.pid : ""})`;
      return `ran${t(s.at)}, exit 0`;
    }
    if (s.state === "now") {
      if (s.rec === "running") return "running now";
      if (s.rec === "failed") return "the last run did not end cleanly";
      if (s.id === "check" && s.rec === "clean") return "the last run ended clean, but your swap file is not in the folder";
      if (s.id === "file") return f.file.problem || "no alice.bundle.json in the folder yet";
      if (s.id === "terms") return "no settings file yet";
      if (s.id === "install") return s.known ? "the run folder does not exist yet" : "not known: the page has no record";
      if (s.id === "watch") return "not started here";
      return s.known ? "" : "not known: the page has no record";
    }
    return "";
  }

  function joinList(steps, f) {
    const ol = H.el("ol", { class: "start-steps", "aria-label": "The steps of joining a swap" });
    for (const s of steps) {
      const word = s.state === "done" ? "done" : s.state === "now" ? "next" : "not yet";
      ol.appendChild(H.el("li", { class: s.state, "aria-current": s.state === "now" ? "step" : null }, H.el("span", { class: "n", text: String(s.n) }), H.el("span", { class: "what", text: s.title }), H.el("span", { class: "st" }, s.state === "done" ? H.el("span", { class: "tick", "aria-hidden": "true", text: "✓ " }) : null, word), H.el("span", { class: "line", text: joinLine(s, f) })));
    }
    return ol;
  }

  /** The two amounts of the "Your terms" block in words, next to the helper's own figures (the figures themselves are shown as printed), or null. */
  function amountWords(label, value) {
    try {
      if (label === "the NOID amount") {
        const m = /^(\d{1,20}) micro-NOID$/.exec(value);
        return m ? `${trimZeros(window.NoidView.noidText(m[1]))} NOID` : null;
      }
      if (label === "the ETH amount") {
        const m = /^(\d{1,30}) wei$/.exec(value);
        return m ? `${window.NoidView.ethText(m[1])} ETH` : null;
      }
    } catch {
      /* the figures stand alone */
    }
    return null;
  }

  function termsRows(rows) {
    const dl = H.el("dl", { class: "join-terms", "aria-label": "Your terms, as the helper printed them" });
    for (const r of rows) {
      const cls = r.label === "the NOID amount" ? "c-noid" : r.label === "the ETH amount" ? "c-eth" : "";
      const words = amountWords(r.label, r.value);
      dl.appendChild(H.el("dt", { text: r.label }));
      dl.appendChild(H.el("dd", {}, H.el("span", { class: "mono" + (cls ? " " + cls : ""), text: r.value }), words ? H.el("span", { class: "dim", text: ` (${words})` }) : null));
    }
    return dl;
  }

  /** The loop's state as a row of chips (no button: the strip's own button starts it). */
  function watchChips(a) {
    const w = a.watch || {};
    return H.el("div", { class: "watch row" }, H.el("strong", { text: "Watch loop" }), w.started_here ? H.chip("ok", isProgram() ? "running in the program" : `running (started here${w.pid ? ", pid " + w.pid : ""})`) : w.some_loop_running ? H.chip("attn", "a loop is updating the files, not started here") : H.chip("danger", "not running"));
  }

  /** Program mode: what the watch loop does, in words (the page reads `watch.mode`; null when no loop runs or the program does not say). */
  const WATCH_MODE_WORDS = { read: ["quiet", "Watch: reading only (records nothing)"], apply: ["ok", "Watch: recording"] };
  const watchModeChip = (w) => (isProgram() && w && w.started_here && Object.prototype.hasOwnProperty.call(WATCH_MODE_WORDS, w.mode) ? WATCH_MODE_WORDS[w.mode] : null);

  /** The strip's one button for Bob's step: the table's own action, the form's own save, or the copy of the run folder's path. */
  function joinButton(a, s, f) {
    if (s.id === "file") {
      const b = H.copyButton(f.folder || "", "the run folder's path", "Copy the folder path");
      b.className = "btn primary";
      if (!f.folder) b.disabled = true;
      return { el: b, why: f.folder ? null : "The run folder's path is not known to the page." };
    }
    return stepButton(a, s, {});
  }

  /** Draws Bob's first screen: the strip into #next-action, the rest into #start. The caller has emptied the other sections. */
  function renderJoin(payload) {
    const a = payload.actions;
    const f = joinFacts(payload);
    const steps = joinSteps(f);
    const next = steps.find((s) => s.state === "now") || null;
    const form = ensureForm(a, "bob");
    const wallet = !!f.wallet;
    const termsNext = !!next && next.id === "terms";
    if (termsNext && !ui.termsOpened) {
      form.open = true;
      ui.termsOpened = true;
    }
    const result = f.check ? joinResult(a.jobs) : null;

    // ---- the strip
    const strip = empty($("next-action"));
    strip.classList.remove("warn-rail", "attn-rail", "danger-rail", "ok-rail");
    strip.classList.add("act", "two");
    const say = H.el("div", { class: "due-say" }, H.el("div", { class: "card-head" }, H.el("h2", { id: "h-action" }, next ? next.title : wallet ? "All eight steps are done" : "All six steps are done", " ", next ? H.chip("accent", `Step ${next.n} of ${steps.length}, your step`) : H.chip("ok", "done"))));
    if (next) {
      say.appendChild(H.el("p", { class: "plain", text: (wallet && JOIN_SAY_WALLET[next.id]) || JOIN_SAY[next.id] }));
      if (next.id === "check" && next.rec === "failed") say.appendChild(H.el("p", { class: "plain", text: "The last check did not end cleanly. The helper's own words are below. No step after this one has started." }));
      if (next.id === "watch" && result && result.line) say.appendChild(H.el("p", { class: "plain", text: "Have you compared the check line below with Alice's, over a second channel? If the two differ, stop here." }));
      if (next.id === "install" && !f.folder_missing && !next.rec) say.appendChild(H.el("p", { class: "plain dim", text: "Not known whether this ran: this console has no record of it. The helper refuses what it must not repeat, so you can run it again if you are not sure." }));
      if (next.id === "setup" && !next.rec) say.appendChild(H.el("p", { class: "plain dim", text: "Not known whether this ran: this console has no record of it. The helper keeps an existing passphrase." }));
      if (next.rec === "running") say.appendChild(H.el("p", { class: "plain", text: "Running now. The result shows here when it ends." }));
      if (termsNext) say.appendChild(H.el("p", { class: "plain dim", text: "Fill in the form below, then save." }));
    } else say.appendChild(H.el("p", { class: "plain", text: "The watch loop is running. The swap page appears at the tool's first tick." }));
    strip.appendChild(say);
    if (next) {
      const b = joinButton(a, next, f);
      const doBox = H.el("div", { class: "due-do start-go" }, b.el);
      if (b.why) doBox.appendChild(H.el("p", { class: "why", text: b.why }));
      if (ui.msg) doBox.appendChild(H.el("p", { class: ui.msg.kind === "danger" ? "attn" : "plain", role: "alert", text: ui.msg.text }));
      if (ui.formMsg && ui.formMsg.kind === "danger" && termsNext) doBox.appendChild(H.el("p", { class: "attn", role: "alert", text: ui.formMsg.text }));
      strip.appendChild(doBox);
      const lastJob = next.action ? (a.jobs || []).filter((j) => j.id === next.action).slice(-1)[0] : null;
      if (lastJob) strip.appendChild(H.el("div", { class: "due-more" }, jobBox(lastJob, false)));
    }

    // ---- the rest
    const start = empty($("start"));
    start.hidden = false;
    start.appendChild(H.el("section", { class: "block", "aria-labelledby": "h-steps" }, H.el("div", { class: "card-head" }, H.el("h2", { id: "h-steps", text: "Join a swap" }), H.el("div", { class: "right" }, H.chip("quiet", JOIN_LOCKS_NOTHING))), joinList(steps, f)));

    // the terms: the settings form itself; the trade line shows what is typed in it (never Alice's file: these are YOUR terms)
    // after a clean check the amounts are the ones the helper printed as this machine's own; before it, what is typed in the form
    const amt = (label) => (result && result.terms ? (result.terms.find((r) => r.label === label) || {}).value : null);
    const nW = /^(\d{1,20}) micro-NOID$/.exec(amt("the NOID amount") || "");
    const eW = /^(\d{1,30}) wei$/.exec(amt("the ETH amount") || "");
    ui.tradeTerms = nW && eW ? { noid: trimZeros(window.NoidView.noidText(nW[1])), eth: window.NoidView.ethText(eW[1]) } : null;
    if (!ui.trade) ui.trade = H.el("p", { class: "trade", "aria-label": "The trade, as typed in the form or as the helper stated your terms" });
    updateTrade();
    const termsBox = H.el("section", { class: "block start-terms" + (termsNext ? " is-next" : ""), "aria-labelledby": "h-terms" }, H.el("div", { class: "card-head" }, H.el("h2", { id: "h-terms", text: "Your terms" })), H.el("p", { class: "plain", text: "These must be what you agreed with Alice. The check compares her file against them: it takes none of them from her file." }), ui.trade);
    if (!termsNext && a.form && a.form.env_local && a.form.env_local.exists) termsBox.appendChild(H.el("p", { class: "dim", text: `env.local.sh exists in the run folder (${a.form.env_local.bytes} B, ${H.dayClock(a.form.env_local.mtime)}). It is never shown here.` }));
    if (!H.state.token) termsBox.appendChild(keyNote());
    termsBox.appendChild(form);
    if (ui.formMsg) termsBox.appendChild(H.el("p", { class: ui.formMsg.kind === "danger" ? "attn" : "plain", role: "alert", text: ui.formMsg.text }));
    start.appendChild(termsBox);

    // Alice's file: where it goes (the folder's path and the exact name, each with a copy button), and what was found
    const fileBox = H.el("section", { class: "block start-send join-file" + (next && next.id === "file" ? " is-next" : ""), "aria-labelledby": "h-file" }, H.el("div", { class: "card-head" }, H.el("h2", { id: "h-file", text: "Alice's file" })));
    if (f.folder) fileBox.appendChild(H.el("div", {}, H.el("div", { class: "label", text: "the run folder" }), H.el("div", { class: "row" }, H.copyButton(f.folder, "the run folder's path", f.folder))));
    fileBox.appendChild(H.el("div", {}, H.el("div", { class: "label", text: "the file's exact name" }), H.el("div", { class: "row" }, H.copyButton("alice.bundle.json", "the file name", "alice.bundle.json"))));
    fileBox.appendChild(H.el("p", { class: "plain", text: "If your lock kind is sha256, Alice also sends her receipt, named alice.receipt: put it in the same folder. The proof-free lock kind (poseidon) needs no receipt." }));
    fileBox.appendChild(H.el("p", { class: f.file.problem ? "attn" : "plain dim", text: f.file.where === "run" ? "Found in the run folder." : f.file.where === "public" ? "Not in the run folder, but found in this console's public copy folder: the check takes it from there (a receipt must still be in the run folder)." : f.file.problem || "No alice.bundle.json is visible in the folder yet." }));
    start.appendChild(fileBox);

    // a wallet run: Bob's deposit, once his swap file exists
    if (wallet && a.wallet && a.wallet.roles && a.wallet.roles.bob && a.wallet.roles.bob.swap_file) start.appendChild(H.el("section", { class: "block", "aria-labelledby": "h-deposit" }, H.el("div", { class: "card-head" }, H.el("h2", { id: "h-deposit", text: "Your deposit" })), depositBlock(payload, "bob")));

    // after a clean check: what the helper printed, as it printed it, and the line to compare
    if (f.check) {
      const box = H.el("section", { class: "block join-result", "aria-labelledby": "h-result" }, H.el("div", { class: "card-head" }, H.el("h2", { id: "h-result", text: "The check" }), H.el("div", { class: "right" }, H.chip("ok", `Alice's file accepted${typeof f.check.at === "number" ? ", " + H.clock(f.check.at) : ""}`))));
      box.appendChild(H.el("p", { class: "plain", text: "The tool accepted Alice's file against your terms and wrote your swap file. Your terms, as this machine stated them:" }));
      if (result && result.terms) box.appendChild(termsRows(result.terms));
      else box.appendChild(H.el("p", { class: "attn", text: "The block of your terms was not found in the helper's output. Read the job's output in the run controls before you go on." }));
      if (result && result.line) {
        box.appendChild(H.el("div", {}, H.el("div", { class: "label", text: "The bundle check line, as the tool printed it" }), H.el("p", { class: "bundle-check mono", text: result.line })));
        box.appendChild(H.el("p", { class: "plain", text: "Compare this line with the one Alice's side shows, over a second channel such as a call. If they differ, stop: do not start the watch loop and lock nothing." }));
      } else box.appendChild(H.el("p", { class: "attn", text: "The helper's output has no single line of the form \"bundle check: 16 hex digits ok\". Do not go on until you have read its output in the run controls." }));
      box.appendChild(watchChips(a));
      if (!H.state.token) box.appendChild(keyNote());
      start.appendChild(box);
    }

    start.appendChild(H.el("section", { class: "block", "aria-labelledby": "h-stops" }, H.el("div", { class: "card-head" }, H.el("h2", { id: "h-stops", text: "What happens if it stops here" })), H.el("p", { class: "plain", text: `${JOIN_LOCKS_NOTHING} ${JOIN_NOTHING_LOCKED}` })));
    start.classList.toggle("terms-next", termsNext);
  }

  // ------------------------------------------------------------------ program mode: the first screen of a swap
  // Shown instead of the swap page while the swap has no tick yet. The swap was made by the new-swap form (its terms are in run.json), so there is no install step and no terms
  // step. The program makes the swap's own wallets by itself ("Make"); the person's own steps are Prepare (Alice) and Choose and check Alice's file (Bob). Under it the same
  // boxes as the swap page's first card (programFirstCard), in the order of the work: the file and the check line, the approval, then the deposit.
  const PROGRAM_BACKUP = "Back up the whole run folder (the swap file and run.json are in it) and keep your recovery code. The swap file alone is not enough.";
  const PROGRAM_STEPS = {
    alice: [
      { id: "make", action: null, title: "Make this swap's own wallets", auto: true },
      { id: "prepare", action: "prepare", title: "Prepare the swap file" },
    ],
    bob: [
      { id: "make", action: null, title: "Make this swap's own Ethereum key", auto: true },
      { id: "join", action: "join", title: "Choose and check Alice's file", button: "Choose Alice's file…" },
    ],
  };
  // what a later step shows about an earlier one (a later step cannot have run without it)
  const PROGRAM_IMPLIED = { make: ["prepare", "join"] };
  const PROGRAM_SAY = {
    make_alice: "The program does this by itself: a fresh NOID wallet and a fresh Ethereum key for this one swap, sealed in the swap's folder, and a check that the key opens the address it will show. Nothing is sent.",
    make_bob: "The program does this by itself: a fresh Ethereum key for this one swap, sealed in the swap's folder, and a check that the key opens the address it will show. Nothing is sent.",
    make_failed: "The last run did not end cleanly. Its result is below; read it before you try again. If it stops again because some of the wallet files already exist, make a new swap instead: nothing was sent.",
    prepare: "Makes your swap file with a fresh secret, and the file for Bob. Press it when Bob is ready to check that file: from then on the clock runs, and your deposit and the funding must go in within about 25 minutes, or the swap does not start (nothing is lost then). Sends nothing.",
    join: "First save the invitation below and send it to Alice. When her file (alice.bundle.json) arrives, choose it here: the program rebuilds the swap from it and refuses it if it differs from your own terms. Nothing is sent.",
  };

  /** True while the first screen applies: actions on, not a production run, no tick of this role yet, and no funding recorded. */
  function programStartKind(payload, role) {
    const a = payload && payload.actions;
    if (!a || !a.enabled || a.production || (role !== "alice" && role !== "bob")) return false;
    if (payload.roles && payload.roles[role]) return false;
    const w = walletOf(a);
    const f = a.funding || {};
    return !(f.marker_at || (w && w.funded_marker));
  }

  /** What the screen reads from the payload (nothing else): clean job records, files, and what the program says about its own first steps. */
  function programStartFacts(p, role) {
    const a = (p && p.actions) || {};
    const w = (walletOf(a) && a.wallet.roles && a.wallet.roles[role]) || {};
    const prepareRec = newestState(a.jobs, "prepare");
    const prepareBad = prepareRec === "running" || prepareRec === "failed";
    const walletId = `wallet-setup-${role}`;
    const setupRec = newestState(a.jobs, "setup");
    const walletRec = newestState(a.jobs, walletId);
    const fsv = a.first_steps && typeof a.first_steps === "object" ? a.first_steps : null;
    // the two automatic steps are one line: running while either is; failed (until the person says "Try again") when the program or the newest record says so
    const running = !!(fsv && fsv.running) || setupRec === "running" || walletRec === "running";
    const failed = running ? null : fsv && (fsv.failed === "setup" || fsv.failed === "wallet") ? fsv.failed : setupRec === "failed" ? "setup" : walletRec === "failed" ? "wallet" : null;
    return {
      role,
      setup: cleanJob(a.jobs, "setup"),
      make: { running, failed, waiting: fsv && typeof fsv.waiting === "string" && fsv.waiting ? fsv.waiting : null },
      states: { make: running ? "running" : failed ? "failed" : null, prepare: prepareRec, join: newestState(a.jobs, "join") },
      wallet: cleanJob(a.jobs, walletId) || (w.addresses_file ? { at: null } : null),
      prepare: role === "alice" && p && p.bundle_file && !prepareBad ? { at: null } : null,
      join: role === "bob" ? cleanJob(a.jobs, "join") || (w.swap_file === true ? { at: null } : null) : null,
    };
  }

  /** The steps with their state: done, now (the first that is not done) or todo. When every step is done none is "now". */
  function programSteps(f) {
    const list = PROGRAM_STEPS[f.role] || [];
    const own = { make: f.wallet, prepare: f.prepare, join: f.join };
    const steps = list.map((s, i) => {
      const fact = own[s.id] || null;
      const from = fact ? null : (PROGRAM_IMPLIED[s.id] || []).find((l) => !!own[l]) || null;
      return { id: s.id, n: i + 1, title: s.title, button: s.button || null, auto: !!s.auto, action: s.action, state: fact || from ? "done" : "todo", done_by: fact ? "fact" : from ? "implied" : null, at: fact && typeof fact.at === "number" ? fact.at : null, rec: (f.states || {})[s.id] || null, make: s.id === "make" ? f.make : null };
    });
    const first = steps.find((s) => s.state !== "done");
    if (first) first.state = "now";
    return steps;
  }

  function programStepLine(s) {
    const t = (u) => (typeof u === "number" ? ` at ${H.clock(u)}` : "");
    if (s.state === "done") return s.done_by === "implied" ? "seen from a later step that ran" : `done${t(s.at)}`;
    if (s.id === "make") {
      const m = s.make || {};
      return m.running ? "running by itself" : m.failed ? "did not end cleanly" : m.waiting ? `waiting: ${m.waiting}` : "starts by itself";
    }
    if (s.state === "now" && s.rec === "running") return "running now";
    if (s.state === "now" && s.rec === "failed") return "the last run did not end cleanly";
    return "";
  }

  function programStepList(steps) {
    const ol = H.el("ol", { class: "start-steps pg-steps", "aria-label": "The steps of this swap" });
    for (const s of steps) {
      const word = s.state === "done" ? "done" : s.state === "now" ? "next" : "not yet";
      ol.appendChild(H.el("li", { class: s.state, "aria-current": s.state === "now" ? "step" : null }, H.el("span", { class: "n", text: String(s.n) }), H.el("span", { class: "what", text: s.title }), H.el("span", { class: "st" }, s.state === "done" ? H.el("span", { class: "tick", "aria-hidden": "true", text: "✓ " }) : null, word), H.el("span", { class: "line", text: programStepLine(s) })));
    }
    return ol;
  }

  // ------------------------------------------------------------------ the boxes of the first card (program mode)
  /** The newest save or confirm message of a box: kept across redraws, for the swap on show only. */
  const noteOf = (kind) => (ui.file && ui.file.swap === (H.state.swap || "") && ui.file.kind === kind ? ui.file : null);

  /** One of the two "save a file" buttons (the swap file for Bob, the invitation for Alice): the program's own dialog opens; the answer is "saved", "cancelled" or the server's words. */
  async function saveFile(kind) {
    if (!H.state.token) return;
    const path = kind === "bundle" ? "/api/bundle/save" : "/api/invitation/save";
    ui.file = { swap: H.state.swap || "", kind, busy: true, ok: null, text: null };
    forceRender();
    const r = await post(path, {});
    if (r.ok) ui.file = { swap: H.state.swap || "", kind, busy: false, ok: r.json && r.json.saved === true, text: r.json && r.json.saved === true ? (kind === "bundle" ? "Saved. Send that file to Bob." : "Saved. Send that file to Alice.") : "Nothing was saved." };
    else ui.file = { swap: H.state.swap || "", kind, busy: false, ok: false, error: true, text: r.json.error || `HTTP ${r.status}` };
    forceRender();
    await H.reload(true);
  }

  /** The line under a save button: the result of the last press (nothing before the first). */
  function fileNote(kind) {
    const n = noteOf(kind);
    return n && n.text ? H.el("p", { class: n.error ? "attn" : "plain", role: n.error ? "alert" : "status", text: n.text }) : null;
  }

  /** What the page can show of this role's check line: `{ hex, recorded }`. `recorded` only when the program has written check-line.json (the confirm box needs that); else the line of the step's own result, for display. */
  function checkLineOf(a, role) {
    const cl = a && a.check_line && typeof a.check_line.hex === "string" && /^[0-9a-f]{16}$/.test(a.check_line.hex) ? a.check_line.hex : null;
    if (cl) return { hex: cl, recorded: true };
    const line = role === "alice" ? bundleCheckLine(a && a.jobs) : (joinResult(a && a.jobs) || {}).line;
    const m = line ? /bundle check: ([0-9a-fA-F]{16})\b/.exec(line) : null;
    return m ? { hex: m[1].toLowerCase(), recorded: false } : { hex: null, recorded: false };
  }

  const CHECK_LINE_SAY = {
    alice: "Read it to Bob over a call or another channel, and let him read his to you. All 16 digits must be the same. If they differ, or his program refused your file, stop: do not approve and do not deposit.",
    bob: "Read it to Alice over a call or another channel, and let her read hers to you. All 16 digits must be the same. If they differ, stop: do not approve and do not deposit.",
  };

  /** The check line in four groups of four to read aloud, and the one thing to do with it: say that the other side's line matches. Nothing is approved before that. */
  function checkLineBlock(view, payload) {
    const a = payload && payload.actions;
    const role = view && view.role;
    if (!a || (role !== "alice" && role !== "bob")) return null;
    const other = role === "alice" ? "Bob" : "Alice";
    const cl = checkLineOf(a, role);
    const box = H.el("section", { class: "spend-box funding-guide check-line-box", "aria-label": "Your check line" }, H.el("div", { class: "row" }, H.el("strong", { text: "Compare the check lines" }), H.chip("quiet", `with ${other}`)));
    if (!cl.hex) {
      box.appendChild(H.el("p", { class: "attn", role: "alert", text: "The check line could not be read from the step's result. Do not go on until you have read the step's output in the run controls." }));
      return box;
    }
    box.appendChild(H.el("div", {}, H.el("div", { class: "label", text: "Your check line" }), H.el("p", { class: "bundle-check grouped mono", text: groupHex(cl.hex) })));
    box.appendChild(H.el("p", { class: "plain", text: CHECK_LINE_SAY[role] }));
    if (!cl.recorded) return box;
    const lm = a.line_match;
    if (lm && lm.hex === cl.hex) {
      box.appendChild(H.chip("ok", `Confirmed at ${typeof lm.at === "number" ? hhmm(lm.at) : "--:--"}: the lines match.`));
      return box;
    }
    const word = role === "alice" ? "Bob read me his" : "Alice read me her";
    const key = `${H.state.swap || ""}|${cl.hex}`;
    if (!ui.cl || ui.cl.key !== key) ui.cl = { key, ticked: false, error: null };
    const cb = H.el("input", { type: "checkbox", id: "cl-match", checked: ui.cl.ticked ? true : null });
    const go = btn(
      "Confirm",
      async () => {
        go.disabled = true;
        ui.cl.error = null;
        const r = await post("/api/checkline/confirm", { matches: true, hex: cl.hex });
        if (!r.ok) ui.cl.error = r.json.error || `HTTP ${r.status}`;
        forceRender();
        await H.reload(true);
      },
      { primary: true, disabled: !ui.cl.ticked || !H.state.token, title: H.state.token ? null : KEY_LOST }
    );
    cb.addEventListener("change", () => {
      ui.cl.ticked = cb.checked;
      go.disabled = !cb.checked || !H.state.token;
    });
    box.appendChild(H.el("label", { class: "ack", for: "cl-match" }, cb, ` ${word} line and all 16 digits match`));
    box.appendChild(H.el("div", { class: "row" }, go));
    if (ui.cl.error) box.appendChild(H.el("p", { class: "attn", role: "alert", text: ui.cl.error }));
    if (!H.state.token) box.appendChild(keyNote());
    return box;
  }

  /** True once this role's own swap file exists (a tick, the bundle file, or the wallet's swap file say so). */
  function haveSwapFile(payload, role) {
    const w = walletOf(payload.actions);
    const r = w && w.roles && w.roles[role];
    return !!((r && r.swap_file === true) || (role === "alice" && payload.bundle_file) || (payload.roles && payload.roles[role]));
  }

  /** True when this role's funding is recorded (Alice) or its lock was sent (Bob): the file and the check line are no longer drawn. */
  function fundingRecorded(a) {
    const w = walletOf(a);
    const f = a.funding || {};
    return !!(f.marker_at || (w && w.funded_marker));
  }

  /**
   * The box that hands the check line over: Alice first has a button that saves a copy of her swap file for Bob, then both sides see the check line and its confirmation.
   * Alice's while her file is at "created" and no funding is recorded; Bob's until his lock. null outside program mode, in a board run and outside those phases.
   */
  function handoverBlock(view, payload) {
    const a = payload && payload.actions;
    if (!isProgram() || !a || !a.enabled || !view || !view.phase || isBoardRun(payload, view.role)) return null;
    const role = view.role;
    if (role === "alice" ? view.phase.id !== "created" || fundingRecorded(a) : !BOB_BEFORE_LOCK.includes(view.phase.id)) return null;
    if (!haveSwapFile(payload, role)) return null;
    const wrap = H.el("div", { class: "wallet-funding handover" });
    if (role === "alice") {
      const busy = !!(noteOf("bundle") && noteOf("bundle").busy);
      const box = H.el("section", { class: "spend-box handover-box", "aria-label": "Give Bob your swap file" }, H.el("div", { class: "row" }, H.el("strong", { text: "Give Bob your swap file" }), H.chip("quiet", "holds no secret")));
      box.appendChild(H.el("p", { class: "plain", text: "Bob needs this file to check your swap. It holds no secret. Save a copy and send it to him as a file, not as pasted text." }));
      box.appendChild(H.el("div", { class: "row" }, btn("Save a copy for Bob…", () => saveFile("bundle"), { primary: true, disabled: !H.state.token || busy, title: H.state.token ? null : KEY_LOST })));
      const note = fileNote("bundle");
      if (note) box.appendChild(note);
      wrap.appendChild(box);
    }
    const cl = checkLineBlock(view, payload);
    if (cl) wrap.appendChild(cl);
    return wrap;
  }

  /** Bob's invitation: his terms and his two addresses in a file Alice's program opens, so she does not type them. Drawn while his key exists and his swap file does not. */
  function invitationBlock(payload) {
    const a = payload && payload.actions;
    const w = walletOf(a);
    const r = w && w.roles && w.roles.bob;
    if (!isProgram() || !r || !r.key_address || r.swap_file === true || (payload.roles && payload.roles.bob) || isBoardRun(payload, "bob")) return null;
    const own = payload.program && typeof payload.program.own_noid === "string" && payload.program.own_noid ? payload.program.own_noid : null;
    const busy = !!(noteOf("invitation") && noteOf("invitation").busy);
    const box = H.el("section", { class: "spend-box invitation-box", "aria-label": "Send Alice an invitation" }, H.el("div", { class: "row" }, H.el("strong", { text: "Send Alice an invitation" }), H.chip("quiet", "holds no secret")));
    box.appendChild(H.el("p", { class: "plain", text: "The invitation holds your terms and your two addresses, so Alice does not type them. It holds no secret. Send it to Alice as a file." }));
    if (own) box.appendChild(H.el("div", {}, H.el("div", { class: "label", text: "Your Parano1d address (the NOID comes here)" }), H.el("div", { class: "row" }, H.copyButton(own, "your Parano1d address", own))));
    box.appendChild(H.el("div", {}, H.el("div", { class: "label", text: "This swap's Ethereum key (the sender of your lock)" }), H.el("div", { class: "row" }, H.copyButton(r.key_address, "this swap's Ethereum key address", r.key_address)), H.el("p", { class: "dim", text: "Do not send coins to it yet: the deposit box shows when the swap is ready." })));
    box.appendChild(H.el("div", { class: "row" }, btn("Save an invitation for Alice…", () => saveFile("invitation"), { primary: true, disabled: !H.state.token || busy, title: H.state.token ? null : KEY_LOST })));
    const note = fileNote("invitation");
    if (note) box.appendChild(note);
    return box;
  }

  const READ_PHASE_SAY = "The program reads both chains every 30 seconds and records nothing yet. It starts acting once you have approved and your deposit is seen.";

  /**
   * The boxes of the first card in program mode outside a board run, in the order of the work: the file and the check line, the read-phase line, the approval (only once the
   * check lines are confirmed, or while it is in force), the deposit while it is needed, the funding once it is recorded, then the engine's send boxes. One element, or null when
   * the card is not this one (the terminal console, a board run): the caller then draws today's boxes.
   */
  function programFirstCard(view, payload) {
    const a = payload && payload.actions;
    if (!isProgram() || !a || !a.enabled || a.production || !view || !view.role || isBoardRun(payload, view.role)) return null;
    const wrap = H.el("div", { class: "wallet-funding first-card" });
    const add = (n) => {
      if (n) wrap.appendChild(n);
    };
    add(handoverBlock(view, payload));
    if (a.watch && a.watch.mode === "read") add(H.el("p", { class: "plain", text: READ_PHASE_SAY }));
    const x = a.autopilot && a.autopilot[view.role];
    if (x && (a.line_match || x.on === true || x.terms_changed === true || (Array.isArray(x.needs_you) && x.needs_you.length))) add(autopilotBlock(view, payload));
    // the deposit comes after the comparison of the check lines: only once the line match exists or the approval is in force
    if (depositNeeded(view, a) && haveSwapFile(payload, view.role) && (a.line_match || (x && x.on === true))) add(depositBlock(payload, view.role, { plain: true }));
    if (view.role === "alice" && fundingRecorded(a)) add(fundingBlock(view, payload));
    add(spendBlock(view, payload));
    return wrap.children.length ? wrap : null;
  }

  /** Draws the first screen of a swap: the strip into #next-action, the rest into #start. The caller has emptied the other sections. */
  function renderProgramStart(payload, role) {
    const a = payload.actions;
    const f = programStartFacts(payload, role);
    const steps = programSteps(f);
    const next = steps.find((s) => s.state === "now") || null;
    const board = isBoardRun(payload, role);

    const strip = empty($("next-action"));
    strip.classList.remove("warn-rail", "attn-rail", "danger-rail", "ok-rail");
    strip.classList.add("act", "two");
    const say = H.el("div", { class: "due-say" }, H.el("div", { class: "card-head" }, H.el("h2", { id: "h-action" }, next ? next.title : "The swap is made", " ", next ? H.chip("accent", next.auto ? `Step ${next.n} of ${steps.length}, by itself` : `Step ${next.n} of ${steps.length}, your step`) : H.chip("ok", "done"))));
    let jobId = null;
    let doBox = null;
    if (next && next.id === "make") {
      say.appendChild(H.el("p", { class: "plain", text: PROGRAM_SAY[`make_${role}`] }));
      const line = programStepLine(next);
      if (!f.make.failed) say.appendChild(H.el("p", { class: "plain dim", text: line.charAt(0).toUpperCase() + line.slice(1) + "." }));
      if (f.make.failed) {
        say.appendChild(H.el("p", { class: "plain", text: PROGRAM_SAY.make_failed }));
        jobId = f.make.failed === "setup" ? "setup" : `wallet-setup-${role}`;
        const again = jobId;
        const why = actionWhy(a, again);
        doBox = H.el("div", { class: "due-do start-go" }, btn("Try again", () => startAction(again), { primary: true, big: true, disabled: !!why, title: why || "Runs the step again. It sends nothing." }));
        if (why) doBox.appendChild(H.el("p", { class: "why", text: why }));
      }
    } else if (next) {
      say.appendChild(H.el("p", { class: "plain", text: PROGRAM_SAY[next.id] }));
      if (next.rec === "running") say.appendChild(H.el("p", { class: "plain", text: "Running now. The result shows here when it ends." }));
      if (next.rec === "failed") say.appendChild(H.el("p", { class: "plain", text: "The last run did not end cleanly. Its result is below; read it before you run the step again." }));
      jobId = next.action;
      const b = stepButton(a, next, payload);
      doBox = H.el("div", { class: "due-do start-go" }, b.el);
      if (b.why) doBox.appendChild(H.el("p", { class: "why", text: b.why }));
    } else say.appendChild(H.el("p", { class: "plain", text: "The program is reading both chains. The swap page shows at its first reading; what to do next is below." }));
    strip.appendChild(say);
    if (!doBox) doBox = H.el("div", { class: "due-do start-go" });
    if (ui.msg) doBox.appendChild(H.el("p", { class: ui.msg.kind === "danger" ? "attn" : "plain", role: "alert", text: ui.msg.text }));
    if (doBox.children.length) strip.appendChild(doBox);
    const lastJob = jobId ? (a.jobs || []).filter((j) => j.id === jobId).slice(-1)[0] : null;
    if (lastJob) strip.appendChild(H.el("div", { class: "due-more" }, jobBox(lastJob, false)));

    const start = empty($("start"));
    start.hidden = false;
    start.appendChild(H.el("section", { class: "block", "aria-labelledby": "h-steps" }, H.el("div", { class: "card-head" }, H.el("h2", { id: "h-steps", text: role === "alice" ? "Start a swap" : "Join a swap" }), H.el("div", { class: "right" }, H.chip("quiet", "These steps lock nothing and send nothing to either chain."))), programStepList(steps)));

    // Bob: his invitation, while his key exists and Alice's file has not been checked yet
    if (role === "bob") {
      const inv = invitationBlock(payload);
      if (inv) start.appendChild(H.el("section", { class: "block", "aria-labelledby": "h-invite" }, H.el("div", { class: "card-head" }, H.el("h2", { id: "h-invite", text: "Your invitation" })), inv));
    }

    // Bob: what the check printed
    if (role === "bob" && f.join) {
      const result = joinResult(a.jobs);
      const box = H.el("section", { class: "block join-result", "aria-labelledby": "h-result" }, H.el("div", { class: "card-head" }, H.el("h2", { id: "h-result", text: "The check" }), H.el("div", { class: "right" }, H.chip("ok", "Alice's file accepted"))));
      if (result && result.terms) box.appendChild(termsRows(result.terms));
      start.appendChild(box);
    }

    // the boxes of the swap page's first card, in the same order (the file and the check line, the approval, the deposit); a board run keeps its own boxes
    const view = { role, phase: { id: role === "alice" ? "created" : "received" } };
    const card = board ? null : programFirstCard(view, payload);
    if (card) start.appendChild(H.el("section", { class: "block", "aria-label": "What to do next" }, card));
    const w = walletOf(a);
    if (board && w && w.roles && w.roles[role] && w.roles[role].swap_file) start.appendChild(H.el("section", { class: "block", "aria-labelledby": "h-deposit" }, H.el("div", { class: "card-head" }, H.el("h2", { id: "h-deposit", text: "Your deposit" })), depositBlock(payload, role)));

    start.appendChild(H.el("section", { class: "block", "aria-labelledby": "h-stops" }, H.el("div", { class: "card-head" }, H.el("h2", { id: "h-stops", text: "What happens if it stops here" })), H.el("p", { class: "plain", text: "These steps lock nothing and send nothing to either chain. Nothing is locked before the funding, so stopping now costs nothing." }), H.el("p", { class: "plain", text: PROGRAM_BACKUP }), role === "alice" ? H.el("p", { class: "plain", text: "Coins you deposited stay in this swap's own wallet. If the swap does not go through, the NOID comes back to it after the deadline, and what is left can then be sent to your own addresses from this swap's page; while the program runs this swap for you, it does both by itself." }) : null));
  }

  // ------------------------------------------------------------------ the panel
  function auditTable(a) {
    const t = (a.audit && a.audit.tail) || [];
    const box = H.el("div", { class: "audit" });
    box.appendChild(H.el("div", { class: "row" }, H.el("h3", { text: "Audit log" }), H.chip(a.audit && a.audit.chain && a.audit.chain.ok ? "ok" : "danger", a.audit && a.audit.chain && a.audit.chain.ok ? "hash chain intact" : "hash chain BROKEN"), H.el("span", { class: "dim mono", text: a.audit ? a.audit.file : "" })));
    if (!t.length) {
      box.appendChild(H.el("p", { class: "plain", text: "Nothing logged yet." }));
      return box;
    }
    const ul = H.el("ul", { class: "hist audit-rows", "aria-label": "Audit log, newest first" });
    for (const r of t.slice().reverse().slice(0, 25)) {
      ul.appendChild(H.el("li", {}, H.el("span", { class: "mono", text: r.t }), H.el("span", { text: `${r.action}${r.role ? ", " + r.role : ""}, ${r.phase}` }), H.el("span", { class: "rs", text: [r.result, r.tx ? "tx " + H.short(r.tx) : "", r.dry_hash ? "dry " + r.dry_hash.slice(0, 12) : "", r.detail || ""].filter(Boolean).join(", ") })));
    }
    box.appendChild(ul);
    return box;
  }

  function watchBox(a) {
    const w = a.watch || {};
    const alive = w.started_here;
    const mode = watchModeChip(w);
    const box = H.el("div", { class: "watch row" }, mode ? null : H.el("strong", { text: "Watch loop" }), mode ? H.chip(mode[0], mode[1]) : alive ? H.chip("ok", isProgram() ? "running in the program" : `running (started here${w.pid ? ", pid " + w.pid : ""})`) : w.some_loop_running ? H.chip("attn", "a loop is updating the files, not started here") : H.chip("danger", "not running"));
    // program mode: the button starts the recording loop (or switches the reading one to it); the table's own note says what that means and is shown, not only in a hover title
    const startNote = isProgram() ? ((a.table || []).find((e) => e.id === "watch-start") || {}).note : null;
    box.appendChild(actionButton(a, "watch-start", "Start", isProgram() ? startNote || "Records what the engine decides" : "Detached; keeps running when this page is closed"));
    if (startNote) box.appendChild(H.el("span", { class: "dim", text: startNote }));
    box.appendChild(actionButton(a, "watch-stop", "Stop", "Stops only the loop started here"));
    // a console started with --role does not offer the other role's tick at all
    for (const [id, label] of [["tick-alice", "Tick Alice (read-only)"], ["tick-bob", "Tick Bob (read-only)"]]) {
      const entry = (a.table || []).find((e) => e.id === id);
      // program mode: a swap has one role; the other role's tick is refused by the server and not offered
      if (isProgram() && H.state.role && id !== `tick-${H.state.role}`) continue;
      if (!entry || !entry.blocked) box.appendChild(actionButton(a, id, label, ""));
    }
    return box;
  }

  /** Table entries a program-mode page never lists (they are terminal-only there: the server answers 409 if one is asked). */
  const TERMINAL_ONLY = ["install", "check-object"];
  const PROGRAM_PANEL_INTRO = "Fixed buttons only: each runs one step of the program and is written to this swap's audit log. Sending anything to a chain needs the checks and the typed confirmation shown in the next-action card. The funding, the recovery and the sweeps are made from this swap's own wallet and key; the keys are sealed and never shown here.";

  /** Program mode: the steps of a swap in order, as buttons (the same table actions as the first screen). */
  function programSetupBox(a) {
    const box = H.el("div", { class: "setup" });
    box.appendChild(H.el("div", { class: "label", text: "the steps of this swap, in this order" }));
    const row = H.el("div", { class: "row" });
    const role = H.state.role;
    const has = (id) => (a.table || []).some((e) => e.id === id && !e.blocked);
    const add = (id, label) => {
      if (has(id)) row.appendChild(actionButton(a, id, label));
    };
    add("setup", "Set up");
    add(`wallet-setup-${role}`, role === "bob" ? "Make the Ethereum key" : "Make the wallets");
    if (role === "alice") add("prepare", "Prepare the swap file");
    if (role === "bob") add("join", "Check Alice's file…");
    if (walletOf(a) && a.wallet.recovered_txid) add("wallet-record-close", "Record the recovery close");
    box.appendChild(row);
    box.appendChild(H.el("p", { class: "dim", text: PROGRAM_BACKUP }));
    return box;
  }

  function setupBox(a) {
    const box = H.el("div", { class: "setup" });
    box.appendChild(H.el("div", { class: "label", text: "one run, in this order" }));
    const row = H.el("div", { class: "row" });
    row.appendChild(actionButton(a, "install", "1. Install helpers"));
    row.appendChild(H.el("span", { class: "dim", text: "→ settings form →" }));
    row.appendChild(actionButton(a, "setup", "2. Setup"));
    const walletRun = !!walletOf(a);
    // a wallet run: the tool makes the swap's wallets before Prepare; there is no object file to check
    if (walletRun) for (const id of ["wallet-setup-alice", "wallet-setup-bob"]) if ((a.table || []).some((e) => e.id === id && !e.blocked)) row.appendChild(actionButton(a, id, id === "wallet-setup-alice" ? "2b. Make the wallets (Alice)" : "2b. Make the Ethereum key (Bob)"));
    row.appendChild(actionButton(a, "prepare", walletRun ? "3. Prepare the swap file" : "3. Prepare both files"));
    if (!walletRun) row.appendChild(actionButton(a, "check-object", "4. Check object file"));
    // a wallet run's recovery close, once it is sent: the swap file records it when the tool takes it (the autopilot tries this about once a minute; this is the same step by hand)
    if (walletRun && a.wallet.recovered_txid && (a.table || []).some((e) => e.id === "wallet-record-close" && !e.blocked)) row.appendChild(actionButton(a, "wallet-record-close", "Record the recovery close"));
    // Bob's first step (a console started with --role alice does not offer it at all)
    const joinEntry = (a.table || []).find((e) => e.id === "join");
    if (joinEntry && !joinEntry.blocked) row.appendChild(actionButton(a, "join", "Join: check Alice's file"));
    box.appendChild(row);
    return box;
  }

  function buildForm(a) {
    const f = a.form || {};
    const names = {};
    const field = (key, label, el, hint, cls) => {
      const err = H.el("span", { class: "ferr", id: `err-${key}`, role: "alert" });
      names[key] = { el, err };
      return H.el("div", { class: "field" + (cls ? " " + cls : "") }, H.el("label", { for: `f-${key}` }, label), el, hint ? H.el("span", { class: "dim hint", text: hint }) : null, err);
    };
    const text = (key, ph) => H.el("input", { type: "text", id: `f-${key}`, name: key, autocomplete: "off", spellcheck: "false", placeholder: ph || "" });
    const select = (key, opts) => {
      const s = H.el("select", { id: `f-${key}`, name: key });
      for (const o of opts) s.appendChild(H.el("option", { value: o }, o));
      return s;
    };
    const run = H.el("input", { type: "text", id: "f-run", name: "run", value: String(f.run_number || ""), readonly: true });
    const profile = select("profile", Object.keys(f.profiles || { sepolia: 1 }));
    const caps = H.el("span", { class: "dim hint" });
    const showCaps = () => {
      const p = (f.profiles || {})[profile.value];
      caps.textContent = p ? `chain ${p.chain}; caps ${p.max_noid} NOID and ${p.max_eth} ETH` : "";
    };
    profile.addEventListener("change", showCaps);
    showCaps();
    const single = H.el("input", { type: "checkbox", id: "f-single_node_ok" });
    const replace = H.el("input", { type: "checkbox", id: "f-replace" });
    // the tool's own wallets: one tick, on for a new run (no settings file yet), fixed for the run once the swap file exists
    const useWallet = H.el("input", { type: "checkbox", id: "f-use_swap_wallet", checked: !(f.env_local && f.env_local.exists) ? true : null });
    const grid = H.el(
      "div",
      { class: "form-grid" },
      field("role", "Role of this machine", select("role", f.roles || ["both"])),
      field("run", "Run number", run, "fixed: this console was started for this run"),
      field("profile", "Profile", profile),
      H.el("div", { class: "field" }, caps),
      field("lock_kind", "Lock kind", select("lock_kind", f.lock_kinds || ["sha256"]), "poseidon: no proof, raw variant only"),
      field("variant", "Variant", select("variant", f.variants || ["raw"]), "raw: the only variant this form writes"),
      field("contract_version", "Contract version", select("contract_version", f.contract_versions || ["1", "2"]), "the Parano1d contract version you agreed"),
      field("noid_amount", "NOID amount", text("noid_amount", "10"), "e.g. 10", "amt amt-noid"),
      field("eth_amount", "ETH amount", text("eth_amount", "0.001"), "e.g. 0.001", "amt amt-eth"),
      field("alice_noid", "Alice's Parano1d address", text("alice_noid", "o1…")),
      field("bob_noid", "Bob's Parano1d address", text("bob_noid", "o1…")),
      field("alice_eth", "Alice's Ethereum address", text("alice_eth", "0x…")),
      field("bob_eth", "Bob's Ethereum address", text("bob_eth", "0x…")),
      field("noid_payout", "Your own Parano1d address for what is left (NOID_PAYOUT)", text("noid_payout", "o1…"), "the leftover NOID is sent here when the swap is over (Alice; optional for Bob)", "wallet-only"),
      field("eth_payout", "Your own Ethereum address for what is left (ETH_PAYOUT)", text("eth_payout", "0x…"), "the leftover ETH is sent here when the swap is over; use your own wallet, not an exchange deposit address (a transfer from a contract-free account may not be credited there)", "wallet-only"),
      field("contract", "HTLC contract address", text("contract", "0x…"), "the deployment on this profile's chain")
    );
    // a wallet run: the addresses the tool makes are not asked; the payouts are
    const syncWallet = () => {
      const on = useWallet.checked;
      const role = names.role.el.value;
      const hide = (k, yes) => {
        const box = names[k].el.closest(".field");
        if (box) box.hidden = !!yes;
        if (yes) names[k].el.value = "";
      };
      hide("alice_noid", on && role === "alice");
      hide("alice_eth", on && role === "alice");
      hide("bob_eth", on && role === "bob");
      hide("noid_payout", !on || role === "bob" ? !on : false);
      hide("eth_payout", !on);
    };
    const platform = H.el("select", { id: "f-live_platform", name: "live_platform" });
    for (const [v, t] of [["", "default (wsl when WSL is there)"], ["wsl", "wsl"], ["native", "native"]]) platform.appendChild(H.el("option", { value: v }, t));
    const optGrid = H.el(
      "div",
      { class: "form-grid" },
      field("deploy_block", "Log start block (DEPLOY_BLOCK)", text("deploy_block", ""), "optional: first block eth_getLogs scans; leave empty and setup.sh picks a recent finalized block from the node. Never a block after the lock"),
      field("hc_lead", "Blocks before h_create (HC_LEAD)", text("hc_lead", "50"), "prepare.sh; 1 to 1000, default 50"),
      field("bob_key", "Bob's key file (BOB_KEY)", text("bob_key", "keys/bob.key"), "relative to eth/"),
      field("alice_key", "Alice's key file (ALICE_KEY)", text("alice_key", "keys/alice.key"), "relative to eth/"),
      field("gas_price_gwei", "Test-chain gas price, gwei (GAS_PRICE_GWEI)", text("gas_price_gwei", "20"), "sepolia / rehearsal"),
      field("priority_fee_gwei", "Tip, gwei (PRIORITY_FEE_GWEI)", text("priority_fee_gwei", "0.01"), "needs the gas price above; not above it; a lock cannot be replaced, so give it a generous tip"),
      field("live_platform", "Platform (LIVE_PLATFORM)", platform)
    );
    const optional = H.el("details", { class: "newswap-opt" }, H.el("summary", { text: "Optional settings (empty = the helpers' default)" }), H.el("p", { class: "plain", text: "Written only when filled in. When you replace an existing file that sets one of these, fill it in again: the file is replaced, not merged." }), optGrid);
    const save = async () => {
      for (const n of Object.values(names)) n.err.textContent = "";
      const fields = {};
      for (const [k, n] of Object.entries(names)) fields[k] = n.el.value;
      fields.single_node_ok = single.checked;
      fields.use_swap_wallet = useWallet.checked;
      ui.formMsg = null;
      const r = await post("/api/newswap", { fields, replace: replace.checked });
      if (r.ok) {
        ui.formMsg = { kind: "ok", text: `env.local.sh written (${r.json.bytes} bytes${r.json.backup ? "; the old file was kept under a dated name" : ""}). Next: setup, prepare.` };
        replace.checked = false;
      } else if (r.json.errors) {
        for (const [k, m] of Object.entries(r.json.errors)) if (names[k]) names[k].err.textContent = m;
        ui.formMsg = { kind: "danger", text: "The form has errors; nothing was written." };
      } else ui.formMsg = { kind: "danger", text: r.json.error || `HTTP ${r.status}` };
      forceRender();
      await H.reload(true);
    };
    const submit = btn("Write env.local.sh", save, { primary: true, disabled: !H.state.token });
    const node = H.el(
      "details",
      { class: "newswap" },
      H.el("summary", { text: "Settings for this run (writes env.local.sh)" }),
      H.el("p", { class: "plain", text: "A fixed template; every value is checked against a strict pattern first (checksum for Parano1d addresses, 0x plus 40 hex for Ethereum, amounts within the profile's caps). Run the install step first: it creates the folder." }),
      H.el("label", { class: "ack", for: "f-use_swap_wallet" }, useWallet, " Use the tool's own wallets (recommended): the tool makes a fresh NOID wallet (Alice) and a fresh Ethereum key for this one swap, you only deposit to the addresses it shows, and what is left goes to your own addresses. No object file, no wallet program, no key file. Fixed for this run."),
      grid,
      optional,
      H.el("label", { class: "ack", for: "f-single_node_ok" }, single, " One person controls both roles (SINGLE_NODE_OK=1: waives the second-node rule; never for a swap with a stranger)"),
      H.el("div", { class: "row" }, submit),
      H.el("label", { class: "ack", for: "f-replace" }, replace, " replace the existing env.local.sh (the old one is kept under a dated name)")
    );
    names.role.el.addEventListener("change", () => {
      ui.roleTouched = true;
      syncWallet();
    });
    useWallet.addEventListener("change", syncWallet);
    syncWallet();
    node.syncWallet = syncWallet;
    node.dataset.names = "1";
    // the start screen's "Save the terms" button runs this same handler (the same POST, the same checks)
    node.save = save;
    // the trade as typed: the start screen shows it in the coins' colours
    for (const k of ["noid_amount", "eth_amount"]) names[k].el.addEventListener("input", updateTrade);
    return node;
  }

  /** The technical panel. With `opts.folded` (the start screen is showing) it sits in a closed <details>, and the settings form is not in it: the form is the start screen's own step. */
  function renderPanel(payload, opts = {}) {
    const root = $("actions");
    if (!root) return;
    if (!enabled(payload)) {
      root.hidden = true;
      return;
    }
    root.hidden = false;
    const a = payload.actions;
    ui.folded = !!opts.folded && !a.production;
    const sig = signature(a);
    if (sig === ui.lastSig) return;
    ui.lastSig = sig;
    const prog = isProgram();
    // program mode has no settings form here: the new-swap form and run.json replace it
    const form = prog ? null : ensureForm(a);
    const keepOpen = form ? form.open : false;
    const wasFolded = !!(root.firstChild && root.firstChild.tagName === "DETAILS");
    const foldOpen = wasFolded && root.firstChild.open;
    while (root.firstChild) root.removeChild(root.firstChild);
    root.classList.toggle("is-folded", ui.folded);
    const wl = a.watch || {};
    const head = H.el("div", { class: "card-head" }, H.el("h2", { id: "h-actions", text: prog ? "Run controls" : `Run controls, run ${a.run_number}` }), H.el("div", { class: "right" }, a.busy ? H.chip("accent", `running: ${a.busy.id}`) : H.chip("quiet", "idle"), ui.folded ? (wl.started_here ? H.chip("ok", "watch loop running") : wl.some_loop_running ? H.chip("attn", "watch loop not started here") : H.chip("danger", "watch loop not running")) : null, a.role && a.role !== "both" ? H.chip("quiet", `role: ${a.role} only`) : null, H.chip("warn", "actions mode")));
    // folded: the head is the summary of a closed <details> and everything else is its body
    const body = ui.folded ? H.el("div", { class: "fold-body" }) : root;
    if (ui.folded) root.appendChild(H.el("details", { class: "fold run-fold", open: foldOpen ? true : null }, H.el("summary", {}, head), body));
    else root.appendChild(head);
    const mount = (n) => body.appendChild(n);
    if (a.production) {
      mount(H.el("p", { class: "attn", role: "alert", text: a.production.text }));
      mount(auditTable(a));
      return;
    }
    mount(H.el("p", { class: "plain", text: prog ? PROGRAM_PANEL_INTRO : walletOf(a) ? "Fixed buttons only: each runs one helper of scripts/live through WSL and is written to the audit log. Sending anything to a chain needs the checks and the typed confirmation shown in the next-action card. This is a wallet run: the funding, the recovery and the sweeps are made from this swap's own wallet and key (wallet-fund.sh, wallet-recover.sh, wallet-sweep.sh); the keys are sealed in the swap file and never shown here." : "Fixed buttons only: each runs one helper of scripts/live through WSL and is written to the audit log. Sending anything to a chain needs the checks and the typed confirmation shown in the next-action card. Funding NOID goes through fund.sh (once per run folder), which calls the wallet." }));
    if (!H.state.token) mount(H.el("p", { class: "attn", text: KEY_LOST }));
    if (pendingLock(a)) mount(H.el("p", { class: "attn", text: lockNote(a) }));
    if (ui.msg && !ui.folded) mount(H.el("p", { class: ui.msg.kind === "danger" ? "attn" : "plain", role: "alert", text: ui.msg.text }));
    mount(prog ? programSetupBox(a) : setupBox(a));
    if (!H.state.token) mount(keyNote());
    // the form is one element: on the start screen it is that screen's step, here it is a step of the panel
    if (prog) {
      /* the terms were written when the swap was made, into run.json: nothing to fill in here */
    } else if (ui.folded) mount(H.el("p", { class: "dim", text: "The settings form is step 2 of the first screen above." }));
    else {
      form.open = keepOpen;
      mount(form);
      if (ui.formMsg) mount(H.el("p", { class: ui.formMsg.kind === "danger" ? "attn" : "plain", role: "alert", text: ui.formMsg.text }));
    }
    if (!prog && a.form && a.form.env_local && a.form.env_local.exists) mount(H.el("p", { class: "dim", text: `env.local.sh exists in the run folder (${a.form.env_local.bytes} B, ${H.dayClock(a.form.env_local.mtime)}). It is never shown here.` }));
    mount(watchBox(a));
    if (!H.state.token) mount(keyNote());
    // the newest job of any kind stays here: after a send the engine no longer offers the spend, so its result would vanish from the next-action card
    const last = (a.jobs || []).slice(-1)[0];
    if (last) mount(jobBox(last, SPEND_ORDER.includes(last.id)));
    mount(auditTable(a));
    mount(
      H.el(
        "details",
        {},
        H.el("summary", { text: "Every command this console can run" }),
        H.el(
          "ul",
          { class: "cmdlist" },
          ...(a.table || []).filter((e) => !prog || !TERMINAL_ONLY.includes(e.id)).map((e) => H.el("li", {}, H.el("strong", { text: e.label }), " ", H.el("span", { class: "dim", text: `[${e.group}]` }), H.el("code", { class: "mono", text: e.command || "" })))
        )
      )
    );
  }

  /** Once a second: the countdown of a dry run's 90 s. */
  function tick() {
    for (const n of document.querySelectorAll("[data-dry-at]")) {
      const at = Number(n.dataset.dryAt);
      const left = 90 - (H.nowS() - at);
      n.textContent = left > 0 ? `valid for ${left} s` : "expired: run it again";
    }
  }

  window.NoidActions = {
    init(helpers) {
      H = helpers;
      KEY_LOST = H.state && H.state.program ? KEY_LOST_PROGRAM : KEY_LOST_TERMINAL;
    },
    enabled,
    signature,
    renderPanel,
    renderStart,
    renderJoin,
    clearStart,
    start: { noSwapStarted, startFacts, startSteps, START_STEPS, START_STEPS_WALLET, bundleCheckLine },
    join: { noJoinStarted, joinFacts, joinSteps, joinResult, JOIN_STEPS, JOIN_STEPS_WALLET, bobCheck, BOB_BEFORE_LOCK },
    wallet: { walletOf, depositBlock, depositNeeded, depositSeen, walletSignature, SPEND_ORDER },
    spendBlock,
    autopilotBlock,
    autopilotFacts,
    typedOk,
    bobCheckBlock,
    fundingBlock,
    banners,
    tick,
    program: { isProgram, startKind: programStartKind, startFacts: programStartFacts, steps: programSteps, renderStart: renderProgramStart, hungWarning, TERMINAL_ONLY, PROGRAM_STEPS, PROGRAM_BACKUP, CODE1_ADVICE, firstCard: programFirstCard },
    programFirstCard,
    handoverBlock,
    checkLineBlock,
    invitationBlock,
    depositFigures: { noid: noidFigure, eth: ethFigure },
  };
})();
