/* noid-swap operator console — vanilla, no build. Renders the view model of lib/viewmodel.js.
   Reads /api/run (a run folder) or /api/demo (fixtures). It never sends anything to a chain; the only POST it can
   make is /api/helper (a read-only helper), and only when the server was started with --allow-run-readonly and the
   page was opened with the printed #token=… URL. With --allow-actions, actions.js adds the fixed action buttons and the
   confirmed spends (see README: the actions mode).
   Program mode (the desktop program): the page asks /api/program first; when it answers, the page shows the top bar, the list of swaps, the new-swap form, the settings screen and,
   for one swap, today's swap page with every request carrying that swap's id. A 404 means the terminal console and nothing below changes. */
(() => {
  "use strict";
  const V = window.NoidView;
  const P = window.NoidPhases;
  const POLL_MS = 4000;
  const $ = (id) => document.getElementById(id);

  const state = {
    mode: null, // "run" | "demo"
    payload: null,
    role: null,
    roleChosen: false,
    demo: { scenario: "happy", step: 0, flags: [] },
    fetchedAt: 0, // Date.now() of the last successful fetch
    skew: 0, // server clock - browser clock, seconds
    error: null,
    token: null,
    health: null,
    runResult: null,
    running: null,
    view: null,
    // program mode (null in the terminal console)
    program: null, // the /api/program answer
    swap: null, // the swap id of the page shown (sent with every request)
    screen: "list", // "list" | "swap" | "new" | "settings"
    pgForm: null, // the form of the new-swap or settings screen, built once per visit
    pgMsg: null, // a line above the list: { kind, text }
    barSig: "",
  };

  // ------------------------------------------------------------ DOM helpers
  function el(tag, attrs, ...kids) {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v === null || v === undefined || v === false) continue;
      if (k === "class") e.className = v;
      else if (k === "text") e.textContent = v;
      else if (k.startsWith("on") && typeof v === "function") e.addEventListener(k.slice(2), v);
      else if (k === "dataset") Object.assign(e.dataset, v);
      else e.setAttribute(k, v === true ? "" : String(v));
    }
    for (const c of kids.flat()) {
      if (c === null || c === undefined || c === false) continue;
      e.appendChild(typeof c === "string" || typeof c === "number" ? document.createTextNode(String(c)) : c);
    }
    return e;
  }
  const clear = (n) => {
    while (n.firstChild) n.removeChild(n.firstChild);
    return n;
  };
  const nowS = () => Math.floor(Date.now() / 1000) + state.skew;
  const group = (n) => (typeof n === "number" ? n.toLocaleString("en-US") : String(n));
  const clock = (unix) => (typeof unix === "number" ? new Date(unix * 1000).toLocaleTimeString([], { hour12: false }) : "—");
  const dayClock = (unix) => (typeof unix === "number" ? new Date(unix * 1000).toLocaleString([], { hour12: false, month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }) : "—");
  const fmtDur = V.fmtDur;

  function short(h) {
    if (typeof h !== "string") return String(h);
    const m = /^(0x|o1)?(.*)$/.exec(h);
    const body = m[2];
    if (body.length <= 18) return h;
    return (m[1] || "") + body.slice(0, 8) + "…" + body.slice(-6);
  }

  function copyButton(full, label, text) {
    const shown = text || short(full);
    const b = el("button", { type: "button", class: "copy", title: String(full), "aria-label": `Copy ${label || "value"}: ${full}` }, el("span", { class: "txt", text: shown }), el("span", { class: "glyph", "aria-hidden": "true", text: "⧉" }));
    b.addEventListener("click", () => copyText(String(full), b));
    return b;
  }

  async function copyText(text, btn) {
    let ok = false;
    try {
      await navigator.clipboard.writeText(text);
      ok = true;
    } catch {
      const ta = el("textarea", { class: "sr-only", "aria-hidden": "true" });
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      try {
        ok = document.execCommand("copy");
      } catch {
        ok = false;
      }
      ta.remove();
    }
    const g = btn.querySelector(".glyph");
    if (g) {
      g.textContent = ok ? "✓ copied" : "✗ copy failed";
      g.classList.add("flash");
      setTimeout(() => {
        g.textContent = "⧉";
        g.classList.remove("flash");
      }, 1400);
    }
  }

  const chip = (cls, text, title) => el("span", { class: "chip " + cls, title: title || null }, text);
  /** The page's own sentences with the coin names in their coin's colour (the text itself is unchanged); the engine's words are never passed through this. */
  const coin = (s) => String(s).split(/\b(NOID|ETH)\b/).map((p) => (p === "NOID" ? el("span", { class: "c-noid", text: p }) : p === "ETH" ? el("span", { class: "c-eth", text: p }) : p));

  // ------------------------------------------------------------ data
  async function getJson(url, init) {
    // every /api request carries the per-start key (the server answers 401 without it, GETs included)
    const r = await fetch(url, { cache: "no-store", ...init, headers: { ...(state.token ? { "x-swap-token": state.token } : {}), ...((init && init.headers) || {}) } });
    const j = await r.json().catch(() => ({ error: `HTTP ${r.status}` }));
    if (!r.ok) {
      const err = new Error(j.error || `HTTP ${r.status}`);
      err.status = r.status;
      throw err;
    }
    return j;
  }

  function signature() {
    const p = state.payload || {};
    const { server_now, generated_at, actions, ...rest } = p;
    void server_now;
    void generated_at;
    rest.actions_sig = window.NoidActions ? window.NoidActions.signature(actions) : "";
    return [state.mode, state.role, state.token ? "t" : "-", state.running || "", state.runResult ? state.runResult.started_at : "", JSON.stringify(rest)].join("|");
  }

  async function load(force) {
    if (state.program) return loadProgram(force);
    try {
      if (state.mode === "demo") {
        const q = new URLSearchParams({ scenario: state.demo.scenario, role: state.role || "alice", step: String(state.demo.step), flags: state.demo.flags.join(",") });
        state.payload = await getJson("/api/demo?" + q.toString());
      } else {
        state.payload = await getJson("/api/run");
      }
      state.skew = (state.payload.server_now || state.payload.generated_at || 0) - Math.floor(Date.now() / 1000);
      state.fetchedAt = Date.now();
      state.error = null;
      chooseRole();
    } catch (e) {
      state.error = e.message || String(e);
    }
    // A poll that changed nothing must not rebuild the page (it would drop keyboard focus and text selection).
    const sig = state.error ? "error:" + state.error : signature();
    if (!force && sig === state.lastSig) return;
    state.lastSig = sig;
    render();
  }

  // ------------------------------------------------------------ program mode: data
  /** The role of the swap on show: the program's own word for it (the swap's run.json), never a guess and never a switch. */
  function chooseProgramRole() {
    const s = ((state.program && state.program.swaps) || []).find((x) => x && x.swap === state.swap);
    const fromPayload = state.payload && (state.payload.role === "alice" || state.payload.role === "bob") ? state.payload.role : null;
    const r = fromPayload || (s && (s.role === "alice" || s.role === "bob") ? s.role : null);
    state.role = r;
    state.roleChosen = true;
    return r;
  }

  async function loadProgram(force) {
    try {
      state.program = await getJson("/api/program");
      state.error = null;
    } catch (e) {
      state.error = e.message || String(e);
    }
    if (state.screen === "swap" && state.swap) {
      try {
        state.payload = await getJson("/api/run?swap=" + encodeURIComponent(state.swap));
        state.skew = (state.payload.server_now || state.payload.generated_at || 0) - Math.floor(Date.now() / 1000);
        state.fetchedAt = Date.now();
        state.error = null;
        if (!chooseProgramRole()) state.error = "The role of this swap is not known, so nothing of it is shown or run.";
      } catch (e) {
        state.error = e.message || String(e);
      }
    }
    const sig = [window.NoidProgram.signature(state.program), state.screen, state.swap || "", state.error || "", state.pgMsg ? state.pgMsg.text : "", state.screen === "swap" && state.payload && !state.error ? signature() : ""].join("|");
    if (!force && sig === state.lastSig) return;
    state.lastSig = sig;
    render();
  }

  function chooseRole() {
    const roles = (state.payload && state.payload.roles) || {};
    if (state.mode === "demo") {
      state.role = state.payload.demo.role;
      return;
    }
    // a console started with --role alice|bob drives ONE role: that tab is the only active one
    const serverRole = state.payload && state.payload.role;
    if (serverRole === "alice" || serverRole === "bob") {
      state.role = serverRole;
      return;
    }
    if (state.roleChosen && state.role) return;
    const withTick = ["alice", "bob"].filter((r) => roles[r] && (roles[r].tick || roles[r].loop));
    const hash = new URLSearchParams(location.search).get("role");
    if (hash === "alice" || hash === "bob") state.role = hash;
    else if (withTick.length === 1) state.role = withTick[0];
    else if (!state.role) state.role = withTick[0] || "alice";
  }

  function viewInput() {
    const p = state.payload || {};
    const r = (p.roles && p.roles[state.role]) || {};
    return {
      role: state.role,
      now: nowS(),
      tick: r.tick || null,
      tick_mtime: r.tick_mtime || null,
      tick_error: r.tick_error || null,
      tick_writing: !!r.tick_writing,
      err_text: r.err_text || null,
      loop: r.loop || null,
      machines: state.mode === "run" ? V.machineStatus(p.role, p.roles) : null,
      terms: p.terms || null,
      helpers: p.helpers || [],
      verify: p.verify || null,
      commands: p.commands || {},
      demo: state.mode === "demo",
    };
  }

  // ------------------------------------------------------------ render: header
  const STATUS_CHIP = {
    act: ["accent", "Your move"],
    waiting: ["quiet", "Waiting"],
    "waiting-stale": ["attn", "Waiting, data stale"],
    "act-stale": ["attn", "Your move? data stale"],
    stale: ["danger", "Stale: loop stopped?"],
    held: ["warn", "Intent held"],
    settled: ["ok", "Settled"],
    refunded: ["quiet", "Refunded"],
    aborted: ["danger", "Aborted"],
    lost: ["danger", "Lost"],
    "no-data": ["attn", "No data"],
    remote: ["quiet", "Runs on another machine"],
    unknown: ["attn", "Unknown"],
  };

  function renderHead(view) {
    const h = view.header;
    const root = clear($("swap-head"));
    const leg = (cls, chainName, verb, amount, unit, sub) => el("div", { class: "leg " + cls }, el("div", { class: "label" }, el("span", { class: "dot " + cls, "aria-hidden": "true" }), el("span", { text: chainName }), el("span", { class: "dim", text: verb })), el("div", { class: "amt" }, amount || "—", el("span", { class: "unit", text: unit })), el("div", { class: "dim mono sub", text: sub }));
    const legNoid = leg("noid", "Parano1d", view.role === "alice" ? "you give" : "you get", h.amount_noid, "NOID", h.alice_noid && view.role === "bob" ? `from Alice ${short(h.alice_noid)}` : h.bob_noid && view.role === "alice" ? `to Bob ${short(h.bob_noid)}` : "");
    const legEth = leg("eth", "Ethereum", view.role === "alice" ? "you get" : "you give", h.amount_eth, "ETH", h.eth.chain_id ? `chain ${h.eth.chain_id}` : "");
    const st = STATUS_CHIP[view.status] || STATUS_CHIP.unknown;
    const phaseChip = view.phase ? chip("", view.phase.label, "engine phase: " + view.phase.id) : null;
    const headline = el("div", { class: "headline" }, el("h1", { text: view.role_label }), chip(st[0], st[1]), phaseChip, h.profile ? chip(h.profile_known ? "quiet" : "attn", `profile ${h.profile}${h.profile_known ? "" : " (assumed: no bundle)"}`) : null, h.variant ? chip("quiet", `${h.variant} variant`) : null, view.demo ? chip("proof", "demo, fixtures") : null);

    const caps = el("div", { class: "capsules", id: "caps" });
    root.appendChild(el("div", { class: "head" }, headline, el("div", { class: "legs" }, view.role === "alice" ? legNoid : legEth, el("div", { class: "arrow", "aria-hidden": "true", text: "⇄" }), view.role === "alice" ? legEth : legNoid), caps));
    renderCapsules(view);
  }

  function ageText(s) {
    return s === null || s === undefined ? "unobserved" : `${fmtDur(s)} ago`;
  }

  function renderCapsules(view) {
    const caps = $("caps");
    if (!caps) return;
    const h = view.header;
    clear(caps);
    const part = (...kids) => el("span", { class: "cp" }, ...kids);
    const noidCls = h.noid.state === "attn" ? "stale" : "";
    caps.appendChild(
      el("span", { class: "capsule " + noidCls, title: "Parano1d tip as last observed by the tick" }, el("span", { class: "dot " + (h.noid.state === "unknown" ? "unknown" : h.noid.state) }), part(el("strong", { text: "Parano1d" }), " height ", h.noid.tip === null ? "—" : group(h.noid.tip), h.noid.tip_estimate !== null && h.noid.tip_estimate !== h.noid.tip && h.tick.age_s !== null && h.tick.age_s <= V.TICK_DEAD_S ? ` (≈ ${group(h.noid.tip_estimate)} now)` : ""), part("observed ", ageText(h.noid.age_s)), h.noid.single ? part("1 node") : h.noid.second ? part("2 nodes") : null)
    );
    caps.appendChild(
      el("span", { class: "capsule " + (h.eth.state === "attn" ? "stale" : ""), title: "Ethereum head as last observed by the tick" }, el("span", { class: "dot " + (h.eth.state === "unknown" ? "unknown" : h.eth.state) }), part(el("strong", { text: "Ethereum" }), " block ", h.eth.block === null || h.eth.block === undefined ? "—" : group(h.eth.block), h.eth.finalized ? ` (final ${group(h.eth.finalized)})` : ""), part("chain clock ", clock(h.eth.time)), part("observed ", ageText(h.eth.age_s)), h.eth.single ? part("1 node") : h.eth.second ? part("2 nodes") : null)
    );
    const t = h.tick;
    caps.appendChild(
      el("span", { class: "capsule " + (t.state === "danger" ? "dead" : t.state === "attn" ? "stale" : ""), title: "Age of the last tick file" }, el("span", { class: "dot " + (t.state === "unknown" ? "unknown" : t.state) }), part(el("strong", { text: "Last tick" }), " ", t.at === null ? "never" : `${clock(t.at)}`), t.at === null ? null : part(ageText(t.age_s)), t.applied === true ? part("applied") : t.applied === false ? part("read-only tick") : null)
    );
  }

  // ------------------------------------------------------------ render: alarms
  /** The page-level banners of the actions mode (lost key, run folder missing, no lock): above every other alarm. */
  function addBanners(root) {
    if (window.NoidActions && window.NoidActions.banners) for (const b of window.NoidActions.banners(state.payload)) root.appendChild(b);
  }

  function renderAlarms(view) {
    const root = clear($("alarms"));
    addBanners(root);
    if (!view.alarms.length) {
      root.appendChild(el("div", { class: "alarm-none" }, el("span", { class: "dot ok", "aria-hidden": "true" }), " No alarms: observations are fresh, the engine flags nothing."));
      return;
    }
    // the strip renders its loud-notes box whenever the view has an action with loud notes (renderAction): an alarm whose text is exactly one of them is not shown twice
    const inStrip = new Set(view.action && view.action.loud_notes ? view.action.loud_notes : []);
    const alarms = view.alarms.filter((a) => !inStrip.has(a.text));
    if (!alarms.length) {
      root.appendChild(el("div", { class: "alarm-none" }, el("span", { class: "dot ok", "aria-hidden": "true" }), " No other alarms: observations are fresh, the engine flags nothing else."));
      return;
    }
    for (const a of alarms) {
      root.appendChild(el("div", { class: "alarm " + a.level, role: a.level === "danger" ? "alert" : null, dataset: { id: a.id || "" } }, el("span", { class: "lv", text: a.level === "attn" ? "stale/attn" : a.level }), el("span", { class: "tx", text: a.text })));
    }
  }

  // ------------------------------------------------------------ render: next action
  const HELPER_FOR = { lock_eth: "dry-lock", reveal_eth: "dry-reveal", refund_eth: "dry-refund-eth", claim_noid: "dry-claim", fund_noid: "check-object" };

  function paramRows(a) {
    const rows = [];
    const p = a.params || {};
    const add = (k, v, node) => rows.push([k, node || String(v)]);
    for (const [k, v] of Object.entries(p)) {
      if (v === "[withheld]") continue;
      if (k === "amount_micronoid") add("amount", "", el("span", {}, coin(`${V.noidText(v)} NOID`)));
      else if (k === "amount_wei") add("amount", "", el("span", {}, coin(`${V.ethText(v)} ETH`)));
      else if (k === "t_reveal") add("T_reveal", "", el("span", {}, `${v} `, el("span", { class: "dim", text: `(${dayClock(v)})` })));
      else if (/hash|lock_id|receiver|txid/.test(k) && typeof v === "string") add(k.replace(/_/g, " "), "", copyButton(v, k));
      else if (k === "call_height" || k === "fee_micronoid") add(k.replace(/_/g, " "), typeof v === "number" ? group(v) : v);
      else add(k.replace(/_/g, " "), typeof v === "object" ? JSON.stringify(v) : v);
    }
    return rows;
  }

  /** The engine's own note about Bob's lock-by / last lock height / funding window, whole, as a line (the console counts nothing itself). */
  function lockByLine(view) {
    const m = view.lock_by_note;
    if (!m) return null;
    return el("p", { class: "margin-line lockby " + m.level }, chip(m.level === "danger" ? "danger" : m.level === "warn" ? "warn" : "quiet", "the engine's note on Bob's lock-by"), " ", el("span", { text: m.text }), m.stale ? el("span", { class: "dim", text: " (from an old tick)" }) : null);
  }

  function renderAction(view) {
    const detailsWasOpen = !!$("next-action").querySelector("details.due-details[open]");
    const root = clear($("next-action"));
    root.classList.remove("act", "warn-rail", "attn-rail", "danger-rail", "ok-rail", "two");
    const a = view.action;
    const aborted = !!(view.phase && view.phase.id === "aborted");
    const actionsOn = !!(window.NoidActions && window.NoidActions.enabled(state.payload));
    const actions = actionsOn ? state.payload.actions : null;
    // The spend of this role the console has a button for LEADS the card: its title, then the engine's reason, then the box with the buttons.
    const lead = actionsOn && a ? V.leadAction(view, actions) : null;
    const guide = actionsOn && a ? V.fundingGuide(view, actions) : null;
    const guideOpen = !!(guide && !guide.done);
    let title;
    let titleChip = null;
    const hn = a && a.held_not_offered;
    if (!a) title = "Next action";
    else if (hn) {
      // A step was decided on an earlier tick but the engine's fresh decision of this tick is not that step: no send box, the engine's reason leads.
      title = "A step is held, and the engine does not offer it now";
      titleChip = chip("warn", "do not send it");
    } else if (aborted) {
      title = "The engine ended this swap file";
      titleChip = chip("danger", "aborted");
    } else if (lead) {
      title = lead.heading;
      titleChip = lead.kind === "move" && a.stale ? chip("attn", "stale tick") : lead.kind === "move" ? chip("accent", lead.chip) : lead.kind === "decided" ? chip("warn", lead.chip) : guideOpen ? chip("quiet", "after Bob's check") : null;
    } else if (guideOpen) {
      title = "Next: fund the NOID";
      titleChip = chip("quiet", "after Bob's check");
    } else {
      title = `Next: ${a.label.toLowerCase()}`;
      titleChip = a.actionable ? chip("accent", "your move") : a.spending && a.withheld ? chip("attn", "parameters withheld") : null;
    }
    const head = el("div", { class: "card-head" }, el("h2", { id: "h-action" }, title, titleChip ? " " : null, titleChip), el("div", { class: "right" }, a && state.payload.runner && state.payload.runner.enabled && !actionsOn ? tickRunButton() : null));
    if (!a) {
      root.appendChild(el("div", { class: "due-say" }, head, el("p", { class: "plain", text: "There is no tick yet, so there is no engine decision to show. Start the watch loop (scripts/live/watch.sh) or run tick.sh once; this page reads the file it writes." })));
      return;
    }
    // the strip is read in this order: the loud notes across its top, then what is due (title, reason, plain words), then the buttons beside it, then the folded detail
    const say = el("div", { class: "due-say" }, head);
    const doBox = el("div", { class: "due-do" });
    const more = el("div", { class: "due-more" });
    const folded = !!(lead || guideOpen);
    if (hn || aborted) root.classList.add("warn-rail");
    else if (lead ? lead.kind === "move" && !a.stale : a.actionable) root.classList.add("act");
    else if (view.status === "stale" || view.status === "waiting-stale" || view.status === "no-data") root.classList.add("attn-rail");
    else if (a.intent && a.intent.status === "held") root.classList.add("warn-rail");

    // the loud notes of the engine (ALARM / ANOMALY / ALERT:), whole, above everything else of the card
    if (a.loud_notes && a.loud_notes.length) {
      const box = el("div", { class: "loud-notes", role: "alert", "aria-label": "The engine's loud notes, whole" });
      for (const n of a.loud_notes) box.appendChild(el("p", { class: "loud", text: n }));
      root.appendChild(box);
    }
    root.appendChild(say);
    // the clock is drawn while the strip is "your move" (class act, amber), and, calm (no amber), while a held step is still offered; the view model names the deadline
    const cm = clockMode(view);
    if (cm) {
      const cb = el("div", { class: "due-clock" });
      fillClock(cb, view.clock, cm === "calm");
      say.appendChild(cb);
    }
    if (a.reason) say.appendChild(el("blockquote", { class: "quote" + (hn || aborted ? " lead" : ""), "aria-label": "The engine's reason, verbatim" }, a.reason));
    if (hn) say.appendChild(el("p", { class: "plain", text: "This is the engine's own wording. The step it froze earlier is not offered here: no send box and no command is shown for it (the engine's notes below are shown as it printed them). If the engine says to cancel it, that is done in a terminal (swap-cli intent FILE --cancel with the same chain flags as tick)." }));
    // "Nothing to do now" would contradict a step that is waiting for the operator
    if (!lead && !guideOpen && !hn) say.appendChild(el("p", { class: "plain" }, coin(aborted ? "The engine ended this swap file. Read its reason and notes: they say why, and the \"Coins at the contract\" box in \"If the swap stops now\" lists what the last tick shows at the contract." : a.plain)));

    // the buttons come first, directly under the reason; the funding order (Bob's check first) is above the button that sends it
    if (actionsOn) {
      // the autopilot's box leads the card: it says whether the console does the steps itself, and what stopped it
      const apb = window.NoidActions.autopilotBlock(view, state.payload);
      if (apb) doBox.appendChild(apb);
      const f = window.NoidActions.fundingBlock(view, state.payload);
      if (f) doBox.appendChild(f);
      // Bob's check line stays on his page until his lock is sent, above the lock's send box
      const bc = window.NoidActions.bobCheckBlock(view, state.payload);
      if (bc) doBox.appendChild(bc);
      const sb = window.NoidActions.spendBlock(view, state.payload);
      if (sb) doBox.appendChild(sb);
    }

    if (a.stale && a.kind !== "wait") say.appendChild(el("p", { class: "plain" }, chip("attn", "stale tick"), " This decision comes from an old tick. Do not act on it until a fresh tick (watch loop, or Refresh tick) shows the same step."));
    if (a.withheld) say.appendChild(el("p", { class: "plain" }, chip("attn", "withheld"), " ", a.withheld_note));

    const rows = a.actionable ? paramRows(a) : [];
    let paramsDl = null;
    if (rows.length) {
      paramsDl = el("dl", { class: "kv" });
      for (const [k, v] of rows) paramsDl.append(el("dt", { text: k }), el("dd", {}, v));
    }

    if (a.intent) {
      const i = a.intent;
      const box = el("div", { class: "dry" }, el("div", { class: "row" }, chip(i.status === "held" ? "warn" : "accent", i.status === "held" ? "intent held" : "intent recorded"), el("strong", { text: i.kind || "?" }), i.decided_at ? el("span", { class: "dim", text: `decided ${clock(i.decided_at)} (${fmtDur(nowS() - i.decided_at)} ago)` }) : null));
      const held = i.status === "held";
      if (hn) box.appendChild(el("p", { class: "plain", text: "Frozen on an earlier tick. The engine does not offer it now, so its parameters are not listed here." }));
      else box.appendChild(el("p", { class: "plain" + (held && lead ? " held-note" : ""), text: held ? (lead ? "The engine froze this step in your swap file on an earlier tick, and the chain does not show its effect yet. Use the box above only if you have NOT already sent it from a terminal. If you did, wait and keep ticking: sending it twice pays twice." : "This step was already decided and frozen in your swap file. If you ran it, wait and keep ticking. Sending it again is how you pay twice.") : "The engine froze this step in your swap file before printing it. Use these exact parameters, once." }));
      const pr = !hn && i.params && (i.status === "held" || !a.actionable) ? Object.entries(i.params).filter(([k, v]) => k !== "action" && v !== "[withheld]") : [];
      if (pr.length) {
        const dl = el("dl", { class: "kv" });
        for (const [k, v] of pr) dl.append(el("dt", { text: k.replace(/_/g, " ") }), el("dd", {}, typeof v === "string" && /^(0x)?[0-9a-f]{40,}$/i.test(v) ? copyButton(v, k) : String(v)));
        box.appendChild(dl);
      }
      say.appendChild(box);
    }

    // a note that the loud-notes box above shows whole is not listed again; with nothing left there is no list and no label
    const loudSet = new Set(a.loud_notes || []);
    const rest = a.notes.filter((n) => !loudSet.has(n));
    if (rest.length) {
      const ul = el("ul", { class: "notes" + (aborted ? " prominent" : ""), "aria-label": "Engine notes" });
      for (const n of rest) ul.appendChild(el("li", { text: n }));
      say.appendChild(el("div", {}, el("div", { class: "label", text: "notes" }), ul));
    }
    if (view.producers) {
      const det = el("details", { class: "producers" }, el("summary", { text: "Producer screen: what the node's headers say (figures only)" }));
      const ul = el("ul", { class: "notes" });
      for (const l of view.producers.lines) ul.appendChild(el("li", { text: l }));
      det.appendChild(ul);
      say.appendChild(det);
    }
    if (a.events && a.events.length) {
      say.appendChild(el("p", { class: "dim", text: "Facts recorded by this tick: " + a.events.map((e) => e.event + (e.detail ? ` (${e.detail})` : "")).join(", ") }));
    }

    // the same step as terminal commands: folded away (with the parameters and the dry-run rows) while the console has the button; the only way to act otherwise, so open
    const cmds = el("div", { class: "cmds" });
    for (const c of a.commands) cmds.appendChild(commandBlock(c));
    if (a.commands.length && a.commands.some((c) => c.kind === "send")) {
      cmds.appendChild(el("p", { class: "dim", text: actionsOn ? "These commands are for your own terminal; the same step can be done with the buttons of this page, after a dry run and a typed confirmation. Funding NOID is fund.sh, once, with its own dry run." : "Commands that move funds are for your own terminal, after the dry run and your explicit go-ahead. This page never runs them." }));
    }
    const dryNode = a.dry_run ? dryBlock(a.dry_run) : null;
    const dryHint = !a.dry_run && !actionsOn && a.command_kind && HELPER_FOR[a.command_kind] ? el("p", { class: "dim", text: "No dry-run file in the run folder yet. Run the dry-run command above, or start this page with --allow-run-readonly to run it from here." }) : null;
    const detail = [paramsDl, a.commands.length && folded ? el("div", { class: "label", text: "The same step as terminal commands" }) : null, a.commands.length ? cmds : null, dryNode, dryHint];
    if (folded && detail.some(Boolean)) more.appendChild(el("details", { class: "due-details", open: detailsWasOpen ? true : null }, el("summary", { text: "Details" }), el("div", { class: "due-details-body" }, ...detail)));
    else for (const n of detail) if (n) more.appendChild(n);
    if (!actionsOn && a.command_kind && HELPER_FOR[a.command_kind] && state.payload.runner && state.payload.runner.enabled) more.appendChild(runBox(HELPER_FOR[a.command_kind]));
    if (state.runResult) more.appendChild(resultBox());
    if (doBox.firstChild) {
      root.appendChild(doBox);
      root.classList.add("two");
    }
    if (more.firstChild) root.appendChild(more);
  }

  function commandBlock(c) {
    const cls = c.kind === "send" ? "send" : c.kind === "manual" ? "manual" : "dry";
    const tag = c.kind === "send" ? chip("warn", "moves funds, your go-ahead") : c.kind === "manual" ? chip("quiet", "manual step") : chip("ok", "sends nothing");
    return el("div", { class: "cmd " + cls }, el("div", { class: "cmd-head" }, el("strong", { text: c.label }), tag, el("button", { type: "button", class: "btn sm", "aria-label": `Copy command: ${c.label}`, onclick: (ev) => copyText(c.cmd, ev.currentTarget) }, el("span", { class: "glyph", text: "⧉ Copy" }))), el("pre", { text: c.cmd }), c.note ? el("div", { class: "note", text: c.note }) : null);
  }

  function dryBlock(d) {
    const box = el("div", { class: "dry" });
    box.appendChild(el("div", { class: "row" }, el("strong", { text: "Latest dry run" }), chip(d.error ? "danger" : d.ok ? "ok" : "attn", d.error ? "failed" : "found"), el("span", { class: "dim mono", text: d.file }), el("span", { class: "dim mono", text: `${fmtDur(d.age_s)} old` }), d.older_than_decision ? chip("attn", "older than the engine's decision: run it again") : d.old ? chip("warn", "over 10 min old") : null));
    if (d.error) box.appendChild(el("p", { class: "plain", text: d.error }));
    if (d.err_text) box.appendChild(el("pre", { class: "mono", text: d.err_text }));
    if (d.facts.length) {
      const dl = el("dl", { class: "kv" });
      for (const f of d.facts) dl.append(el("dt", { text: f.label }), el("dd", {}, /^(0x)?[0-9a-fA-F]{40,}$/.test(f.value) || /^o1/.test(f.value) ? copyButton(f.value, f.label) : f.value));
      box.appendChild(dl);
    }
    if (d.checks.length) {
      const ul = el("ul", { class: "checks", "aria-label": "Cross-checks of the dry run against the terms" });
      for (const c of d.checks) ul.appendChild(el("li", { class: c.ok ? "ok" : "bad" }, c.ok ? "✓" : "✗", " ", c.name));
      box.appendChild(ul);
    }
    return box;
  }

  function tickRunButton() {
    return runButton(`tick-${state.role}`, "Refresh tick (read-only)");
  }
  function runBox(id) {
    return el("div", { class: "runbox" }, runButton(id, "Run this dry run here"), el("span", { class: "dim", text: "  read-only helper; sends nothing" }));
  }
  function runButton(id, label) {
    const disabled = !state.token || state.running;
    return el("button", { type: "button", class: "btn sm", disabled: disabled ? true : null, title: !state.token ? "Open the URL printed when the server started (it carries #token=…)" : label, onclick: () => runHelper(id) }, state.running === id ? "Running…" : label);
  }
  function resultBox() {
    const r = state.runResult;
    return el("div", { class: "runbox" }, el("div", { class: "row" }, el("strong", { text: r.label || r.id }), chip(r.ok ? "ok" : "danger", r.ok ? "exit 0" : r.error ? "failed" : `exit ${r.exit_code}`), el("span", { class: "dim", text: `${(r.duration_ms / 1000).toFixed(1)} s` })), el("pre", { text: (r.stdout || "") + (r.stderr ? "\n--- stderr ---\n" + r.stderr : "") + (r.error ? "\n" + r.error : "") }));
  }

  async function runHelper(id) {
    if (!state.token || state.running) return;
    state.running = id;
    state.lastSig = null;
    render();
    try {
      state.runResult = await getJson("/api/helper", { method: "POST", headers: { "content-type": "application/json", "x-swap-token": state.token }, body: JSON.stringify({ id }) });
    } catch (e) {
      state.runResult = { id, label: id, ok: false, exit_code: null, duration_ms: 0, stdout: "", stderr: "", error: e.message };
    }
    state.running = null;
    await load(true);
  }

  // ------------------------------------------------------------ the clock (strip) and the two-lock picture
  // Both draw numbers the Deadlines list already shows (view.clock and view.picture are rows of it); the only arithmetic here is a position on an axis.
  const fmtClock = (sec) => {
    const t = Math.max(0, Math.floor(sec));
    const h = Math.floor(t / 3600);
    const m = Math.floor((t % 3600) / 60);
    const r = t % 60;
    const p2 = (n) => String(n).padStart(2, "0");
    return h ? `${h}:${p2(m)}:${p2(r)}` : `${p2(m)}:${p2(r)}`;
  };

  /** "act" (amber) while the strip is "your move", "calm" while a held step is still offered, else null (no box). view.clock is already null where the engine does not offer the step. */
  function clockMode(view) {
    if (!view.clock) return null;
    if ($("next-action").classList.contains("act")) return "act";
    return view.action && view.action.intent && view.action.intent.status === "held" ? "calm" : null;
  }

  /** The big figure with one mark per minute left (at most 60), or per block for a block clock. Redrawn every second into the same box. */
  function fillClock(box, c, calm) {
    clear(box);
    box.classList.toggle("over", !!c.over);
    box.classList.toggle("calm", !!calm);
    const byBlocks = c.unit === "blocks";
    const left = c.over ? 0 : c.seconds_left;
    const marks = el("div", { class: "clock-marks", "aria-hidden": "true" });
    let more = null;
    let figure;
    let words;
    if (byBlocks) {
      const n = c.over ? 0 : c.blocks_left;
      for (let i = 0; i < Math.min(60, n); i++) marks.appendChild(el("i", { class: "live" }));
      if (n > 60) more = "more than 60 blocks";
      figure = [c.over ? null : el("span", { class: "approx", "aria-hidden": "true", text: "≈" }), String(n), el("span", { class: "unit", text: n === 1 ? " block" : " blocks" })];
      words = `${n} ${n === 1 ? "block" : "blocks"}`;
    } else {
      const leftMarks = Math.min(60, Math.ceil(left / 60));
      const total = left > 3600 ? 60 : c.window_s ? Math.min(60, Math.max(leftMarks, Math.ceil(c.window_s / 60))) : leftMarks;
      for (let i = 0; i < total; i++) marks.appendChild(el("i", { class: i < total - leftMarks ? "gone" : "live" }));
      if (left > 3600) more = "more than an hour";
      figure = [c.approx && !c.over ? el("span", { class: "approx", "aria-hidden": "true", text: "≈" }) : null, c.over ? "0:00" : fmtClock(left)];
      const m = Math.ceil(left / 60); // words change at most once a minute
      const h = Math.floor(m / 60);
      const pl = (n, w) => `${n} ${w}${n === 1 ? "" : "s"}`;
      words = c.over ? "none" : `${c.approx ? "about " : ""}${h ? pl(h, "hour") + (m % 60 ? " " + pl(m % 60, "minute") : "") : pl(m, "minute")}`;
    }
    box.appendChild(el("p", { class: "clock-fig" }, ...figure));
    box.appendChild(el("div", { class: "clock-row" }, marks, more ? el("span", { class: "more", text: more }) : null));
    if (c.over) box.appendChild(el("p", { class: "clock-cap over-say", text: byBlocks ? "Past the claim target: a claim sent now is still valid until D − 1, but a rollback could undo it." : "Too late to start the reveal: the helper refuses it." }));
    else if (byBlocks) box.appendChild(el("p", { class: "clock-cap" }, `about ${fmtDur(left)} at 30 s a block, counted from the tip the last tick saw; blocks can come faster. Until: `, el("strong", { text: c.label })));
    else box.appendChild(el("p", { class: "clock-cap" }, el("strong", { text: "Time left to start the reveal" })));
    box.appendChild(el("p", { class: "clock-cap dim", text: `The same number as "${c.label}" in Deadlines below.` }));
    if (calm) box.appendChild(el("p", { class: "clock-cap calm-say", text: "If your reveal is already out, do not send it again." }));
    // a timer that is never announced by itself (aria-live off); its label is words and the caption, and changes at most once a minute (or a block)
    const cap = c.over ? (byBlocks ? "Past the claim target" : "Too late to start the reveal") : byBlocks ? c.label : "Time left to start the reveal";
    const label = c.over ? `${cap}: the clock is at zero` : `${cap}: ${words} left`;
    box.setAttribute("role", "timer");
    box.setAttribute("aria-live", "off");
    box.setAttribute("aria-atomic", "true");
    if (box.getAttribute("aria-label") !== label) box.setAttribute("aria-label", label);
  }

  const SVGNS = "http://www.w3.org/2000/svg";
  function svgEl(tag, attrs, ...kids) {
    const e = document.createElementNS(SVGNS, tag);
    for (const [k, v] of Object.entries(attrs || {})) if (v !== null && v !== undefined && v !== false) e.setAttribute(k, String(v));
    for (const c of kids.flat()) if (c !== null && c !== undefined && c !== false) e.appendChild(typeof c === "string" || typeof c === "number" ? document.createTextNode(String(c)) : c);
    return e;
  }
  const CHAIN_NAME = { noid: "Parano1d", eth: "Ethereum" };
  const TRACK_WORD = { none: "not locked yet", sent: "sent, not confirmed yet", pending: "locked, not final", final: "locked and final", secret_public: "the secret is public: this lock can be claimed at any moment", closing: "being closed, not final yet", closed: "closed" };
  const TICK_STEPS = [60, 120, 300, 600, 900, 1800, 3600, 7200, 10800, 21600, 43200, 86400, 172800];
  const tickText = (s) => (s < 3600 ? `+${s / 60} min` : `+${Math.floor(s / 3600)} h${s % 3600 ? ` ${(s % 3600) / 60} min` : ""}`);

  function renderPicture(view) {
    const root = clear($("picture"));
    const p = view.picture;
    if (!p) return;
    const act = $("next-action").classList.contains("act");
    const rowOf = (id) => view.deadlines.find((d) => d.id === id);
    const countdown = (id) => {
      const r = rowOf(id);
      return r ? dlValue(r)[0] : "";
    };
    const mname = (m) => `${m.short}${m.estimate ? " (expected)" : ""}`;
    const mtext = (m) => `${mname(m)}  ${countdown(m.row_id)}`; // two spaces (the CSS keeps them), not a dot
    const endId = (t) => (t.chain === "noid" ? "d" : "t_reveal");
    const endName = (t) => (t.chain === "noid" ? "D" : "T_reveal");
    const endWord = (t) => {
      const r = rowOf(endId(t));
      return r && r.state === "passed" ? `${endName(t)} passed` : "no end ahead";
    };

    root.appendChild(el("div", { class: "card-head" }, el("h2", { id: "h-picture", text: "The two locks, from now" }), el("div", { class: "right" }, p.stale ? chip("attn", "from an old tick") : null)));

    // the sentence of the SVG's label
    const trackSentence = (t) => `${CHAIN_NAME[t.chain]}: ${TRACK_WORD[t.state]}${t.end_s !== null ? `, until ${endName(t)} (${countdown(endId(t))})` : ""}`;
    const sentence = `Two locks from now${p.stale ? ", from an old tick" : ""}. ${p.tracks.map(trackSentence).join(". ")}. ${p.marks.map((m) => `${mname(m)} ${countdown(m.row_id)}`).join("; ")}.`;

    // ---- wide: the SVG, built at the width it is shown at so its text stays 12 px
    const W = Math.max(640, Math.min(1180, root.clientWidth || 1000));
    const plotL = W < 800 ? 100 : 130;
    const plotR = W - (W < 800 ? 120 : 150);
    const x = (s) => plotL + (s / p.span_s) * (plotR - plotL);
    const CW = 7.3; // mono 12 px, per character
    const placed = [];
    for (const m of p.marks) {
      const mx = x(m.at_s);
      const w = mtext(m).length * CW;
      const cands = [
        { x0: mx + 5, x1: mx + 5 + w },
        { x0: mx - 5 - w, x1: mx - 5 },
      ].filter((c) => c.x0 >= 0 && c.x1 <= W);
      const clamped = Math.max(0, Math.min(mx + 5, W - w));
      cands.push({ x0: clamped, x1: clamped + w });
      let pick = null;
      for (let r = 0; r < 14 && !pick; r++) {
        for (const c of cands) {
          const clashRow = placed.some((q) => q.row === r && c.x0 - 18 < q.x1 && c.x1 + 18 > q.x0);
          const crossedBelow = placed.some((q) => q.row > r && mx > q.x0 - 3 && mx < q.x1 + 3); // this leader would run through a label below it
          const crossedAbove = placed.some((q) => q.row < r && q.mx > c.x0 - 3 && q.mx < c.x1 + 3); // a leader above would run through this label
          if (!clashRow && !crossedBelow && !crossedAbove) {
            pick = { ...c, row: r };
            break;
          }
        }
      }
      if (!pick) pick = { ...cands[0], row: placed.length };
      placed.push({ ...pick, mx, m });
    }
    const rows = placed.reduce((n, q) => Math.max(n, q.row + 1), 1);
    const rowY = (r) => 16 + r * 18;
    const y1 = rowY(rows - 1) + 34;
    const y2 = y1 + 46;
    const axisY = y2 + 30;
    const H = axisY + 30;
    const svg = svgEl("svg", { class: "pic-svg", width: W, height: H, viewBox: `0 0 ${W} ${H}`, role: "img", "aria-label": sentence });
    // the send band (amber only while the strip is "your move") sits behind everything
    if (act && p.band) svg.appendChild(svgEl("rect", { class: "band", x: plotL, y: y1 - 18, width: Math.max(2, x(p.band.to_s) - plotL), height: y2 - y1 + 36 }));
    // axis with relative ticks (no wall-clock time)
    const step = TICK_STEPS.find((s) => p.span_s / s <= 6) || TICK_STEPS[TICK_STEPS.length - 1];
    const axis = svgEl("g", { class: "axis" }, svgEl("line", { x1: plotL, y1: axisY, x2: plotR, y2: axisY }));
    for (let s = step, n = 0; s <= p.span_s && n < 12; s += step, n++) axis.append(svgEl("line", { class: "tick", x1: x(s), y1: axisY, x2: x(s), y2: axisY + 5 }), svgEl("text", { class: "sub", x: x(s), y: axisY + 20, "text-anchor": "middle" }, tickText(s)));
    svg.appendChild(axis);
    // the two tracks
    p.tracks.forEach((t, i) => {
      const y = i === 0 ? y1 : y2;
      svg.appendChild(svgEl("text", { class: "name c-" + t.chain, x: 0, y: y + 5 }, CHAIN_NAME[t.chain]));
      const ex = t.end_s !== null ? x(t.end_s) : null;
      if (t.state === "none" || t.state === "sent") {
        svg.appendChild(svgEl("rect", { class: "lock none", x: plotL, y: y - 7, width: ex !== null ? Math.max(2, ex - plotL) : 80, height: 14, rx: 2 }));
        svg.appendChild(svgEl("text", { class: "sub", x: plotL + 4, y: y + 24 }, TRACK_WORD[t.state]));
      } else if (t.state === "secret_public" || t.state === "closing" || t.state === "closed") {
        svg.appendChild(svgEl("text", { class: "sub", x: plotL + 6, y: y + 4 }, TRACK_WORD[t.state]));
      } else if (ex === null) {
        svg.appendChild(svgEl("text", { class: "sub", x: plotL + 6, y: y + 4 }, endWord(t)));
      } else {
        svg.appendChild(svgEl("line", { class: `lock ${t.state === "final" ? "fin" : "pend"} ${t.chain}`, x1: plotL, y1: y, x2: ex, y2: y }));
      }
    });
    // marks: a leader from the label down to the axis, then the label
    for (const q of placed) svg.appendChild(svgEl("line", { class: "mk" + (q.m.estimate ? " est" : ""), x1: q.mx, y1: rowY(q.row) + 4, x2: q.mx, y2: axisY }));
    for (const q of placed) {
      const anchorEnd = q.x1 < q.mx;
      svg.appendChild(svgEl("text", { class: "ml" + (q.m.estimate ? " est" : ""), x: anchorEnd ? q.x1 : q.x0, y: rowY(q.row), "text-anchor": anchorEnd ? "end" : "start" }, mtext(q.m)));
    }
    // the now cursor, labelled under the axis
    svg.appendChild(svgEl("line", { class: "cursor", x1: plotL, y1: y1 - 22, x2: plotL, y2: axisY }));
    svg.appendChild(svgEl("text", { class: "now", x: plotL, y: axisY + 20, "text-anchor": "middle" }, "now"));

    // ---- narrow: the same marks and track ends as a list in time order
    const list = el("ol", { class: "pic-list" });
    list.appendChild(el("li", {}, el("span", { class: "t", text: "now" }), p.stale ? el("span", { text: "from an old tick" }) : null));
    for (const t of p.tracks) list.appendChild(el("li", { class: "track " + t.chain }, el("span", { class: "t", text: CHAIN_NAME[t.chain] }), el("span", { text: `${TRACK_WORD[t.state]}${t.end_s !== null ? `, until ${endName(t)}` : ""}` })));
    for (const m of p.marks) list.appendChild(el("li", { class: m.estimate ? "est" : null }, el("span", { class: "t", text: countdown(m.row_id) }), el("span", { text: mname(m) })));

    root.appendChild(el("div", { class: "pic" }, svg, list));
    root.appendChild(el("p", { class: "dim pic-key", text: "Solid: locked and final. Dotted: locked, not final. Dashed: not locked yet, sent but not confirmed, or expected. No line: the secret is public, or the lock is being closed or closed (the words say which). Every figure is the one in Deadlines below; the axis only places it." }));
  }

  // ------------------------------------------------------------ render: timeline & explainers
  function renderTimeline(view) {
    const root = clear($("timeline"));
    // the steps take the colour of the strip above them: the current one is amber only while that strip is "your move"
    root.classList.toggle("act", $("next-action").classList.contains("act"));
    root.appendChild(el("div", { class: "card-head" }, el("h2", { id: "h-timeline", text: "Where this swap is" }), el("div", { class: "right" }, view.phase ? chip("quiet", `phase: ${view.phase.id}${view.phase.source === "loop" ? " (from loop file)" : ""}`) : null)));
    if (!view.timeline) {
      root.appendChild(el("p", { class: "plain", text: "The phase is unknown until the first tick." }));
      return;
    }
    const list = (nodes, cls) => {
      const ol = el("ol", { class: "timeline " + (cls || "") });
      nodes.forEach((n, i) => {
        const glyph = n.state === "done" ? "✓" : n.state === "skipped" ? "–" : String(i + 1);
        ol.appendChild(el("li", { class: n.state, "aria-current": n.state === "current" ? "step" : null }, el("span", { class: "node", "aria-hidden": "true", text: glyph }), el("span", { class: "nl" }, n.label, el("span", { class: "sr-only", text: ` (${n.state})` }))));
      });
      return ol;
    };
    root.appendChild(list(view.timeline.main));
    root.appendChild(el("div", { class: "label track-label", text: view.timeline.on_recovery ? "Recovery path: where you are" : "If the swap stops: the recovery path" }));
    root.appendChild(list(view.timeline.recovery, "recovery"));
    if (view.timeline.extra) root.appendChild(el("p", { class: "plain" }, chip(view.timeline.extra === "lost" ? "danger" : "quiet", view.timeline.extra === "lost" ? "Lost: both legs gone" : "Aborted")));
  }

  function renderExplain(view) {
    // a folded block: its summary is the heading; the root element is kept, so an open block stays open
    const root = clear($("explain"));
    root.appendChild(el("summary", {}, el("h2", { id: "h-explain", text: view.phase ? view.phase.label : "Plain words" })));
    if (!view.phase) {
      root.appendChild(el("p", { class: "plain", text: "Waiting for the first tick." }));
      return;
    }
    const sec = (cls, label, text) => el("section", { class: cls }, el("span", { class: "label", text: label }), el("p", {}, coin(text)));
    root.appendChild(el("div", { class: "explain" }, sec("happening", "What is happening", view.phase.happening), sec("next", "What you do next", view.phase.next), sec("nothing", "What happens if you do nothing", view.phase.nothing)));
  }

  // ------------------------------------------------------------ render: deadlines, abort, receipts, history
  /** The countdown of a deadline as [figure, small print]: the figure first, the block count (when there is one) as the small print. */
  function dlValue(d) {
    if (d.no_countdown) return [d.state === "met" ? (state.role === "bob" ? "your lock is in" : "Bob's lock is in") : d.target === null ? "—" : "not counted here: see the engine's note"];
    if (d.state === "na") return ["not relevant any more"];
    if (d.state === "met") return [d.id === "lock_by" ? (state.role === "bob" ? "your lock is in" : "Bob's lock is in") : d.id === "reveal_cutoff" ? "revealed in time" : "done"];
    if (d.target === null) return ["—"];
    if (d.state === "unknown" && d.seconds_left === null) return ["—"];
    const left = d.seconds_left;
    if (left === null || left === undefined) return ["—"];
    const abs = fmtDur(Math.abs(left));
    if (d.kind === "height") {
      const blocks = Math.abs(d.blocks_left);
      return left > 0 ? [`≈ ${abs}`, `${group(blocks)} blocks`] : [`passed ≈ ${abs} ago`, `${group(blocks)} blocks`];
    }
    return [left > 0 ? abs : `passed ${abs} ago`];
  }
  /** Where the deadline sits, as separate readings (a clock time, a day, the unix second) rather than one dotted string. */
  function dlTarget(d) {
    if (d.target === null) return [d.note || ""];
    if (d.kind === "height") return [`height ${group(d.target)}`];
    return [clock(d.target), dayClock(d.target), String(d.target)];
  }
  const DL_TAG = { far: "open", closing: "closing", passed: "passed", met: "met", unknown: "unknown", na: "" };

  function renderDeadlines(view) {
    const root = clear($("deadlines"));
    root.appendChild(el("div", { class: "card-head" }, el("h2", { id: "h-deadlines", text: "Deadlines" }), el("div", { class: "right" }, view.deadlines_stale ? chip("attn", "estimates: the last tick is stale") : chip("quiet", "blocks ≈ 30 s each"))));
    const lb = lockByLine(view);
    if (lb) root.appendChild(lb);
    const list = el("ul", { class: "dl-list" });
    for (const d of view.deadlines) {
      const val = dlValue(d);
      const tags = [DL_TAG[d.state], d.stale && d.state !== "na" && d.state !== "met" ? "stale" : ""].filter(Boolean);
      list.appendChild(el("li", { class: `dl ${d.state}` }, el("div", { class: "top" }, el("strong", {}, coin(d.label)), el("span", { class: "val" + (d.no_countdown || d.state === "na" || d.state === "met" || val.length === 1 && val[0] === "—" ? " word" : "") }, val[0], val[1] ? el("span", { class: "sub", text: val[1] }) : null)), el("div", { class: "tg" }, ...dlTarget(d).filter(Boolean).map((t) => el("span", { text: t })), ...tags.map((t) => el("span", { text: t }))), el("div", { class: "pl" }, coin(d.plain)), d.engine_note ? el("div", { class: "en", text: d.engine_note }) : null));
    }
    root.appendChild(list);
  }

  function renderAbort(view) {
    const root = clear($("abort"));
    root.appendChild(el("div", { class: "card-head" }, el("h2", { id: "h-abort", text: "If the swap stops now" })));
    root.appendChild(el("div", { class: "abort-head" }, coin(view.abort.headline)));
    const rows = el("div", { class: "abort-rows" });
    for (const r of view.abort.rows) rows.appendChild(el("div", { class: "abort-row" }, el("div", { class: "who", text: r.who }), el("div", {}, el("div", {}, coin(r.where)), el("div", { class: "fate" }, coin(r.fate)))));
    root.appendChild(rows);
    const rec = view.abort.recovery;
    if (rec) {
      const box = el("div", { class: "coins", role: "group", "aria-label": "Coins at the contract" }, el("div", { class: "label", text: "Coins at the contract" }));
      const ul = el("ul", { class: "notes prominent" });
      for (const i of rec.instances) ul.appendChild(el("li", { class: "inst" }, el("span", {}, coin(`${i.amount_text} NOID`)), el("span", { text: `slot ${i.slot}` }), el("span", { text: `creation ${i.creation}` }), i.matches_opening === false ? el("span", { class: "bad", text: "the node says it does not match the opening" }) : null));
      box.appendChild(ul);
      box.appendChild(el("p", { class: "plain", text: "These are what the last tick lists at the contract root. They are taken back after D with the recovery helper in a terminal; this console cannot start it yet. Preview first, then the real run, then tell the engine about each close." }));
      for (const c of rec.commands) box.appendChild(commandBlock(c));
      root.appendChild(box);
    }
    if (view.abort.you.length) {
      const ul = el("ul", { class: "you" });
      for (const y of view.abort.you) ul.appendChild(el("li", {}, coin(y)));
      root.appendChild(ul);
    }
  }

  function renderReceipts(view) {
    const root = clear($("receipts"));
    root.appendChild(el("div", { class: "card-head" }, el("h2", { id: "h-receipts", text: "Receipts" }), el("div", { class: "right" }, chip("quiet", "txids, ids, addresses"))));
    if (!view.receipts.length) {
      root.appendChild(el("p", { class: "plain", text: "Nothing to show yet: receipts appear as the chains show transactions." }));
      return;
    }
    const groups = new Map();
    for (const r of view.receipts) {
      if (!groups.has(r.group)) groups.set(r.group, []);
      groups.get(r.group).push(r);
    }
    for (const [g, items] of groups) {
      const box = el("div", { class: "rc-group" }, el("div", { class: "label", text: g }));
      for (const r of items) box.appendChild(el("div", { class: "rc" }, el("span", { class: "l", text: r.label }), r.plain ? el("span", { class: r.ok === false ? "attn" : "", text: r.value }) : copyButton(r.value, r.label)));
      root.appendChild(box);
    }
  }

  function renderHistory(view) {
    // a folded block: its summary is the heading; the root element is kept, so an open block stays open
    const root = clear($("history"));
    root.appendChild(el("summary", {}, el("h2", { id: "h-history", text: "Loop history" }), view.history ? chip("quiet", `${view.history.total} ticks in the loop file`) : null));
    if (!view.history || !view.history.entries.length) {
      root.appendChild(el("p", { class: "plain", text: "No loop file yet (scripts/live/watch.sh writes loop-ROLE.txt)." }));
      return;
    }
    if (view.history.changes.length) {
      root.appendChild(el("p", { class: "dim", text: "Phase changes: " + view.history.changes.map((c) => `${c.time} ${c.from} → ${c.to}`).join(", ") }));
    }
    const ul = el("ul", { class: "hist" });
    for (const e of view.history.entries.slice().reverse()) {
      ul.appendChild(el("li", {}, el("span", { text: e.time }), el("span", { class: e.exit_code !== 0 ? "attn" : "", text: (e.action || "?") + (e.exit_code ? ` (exit ${e.exit_code})` : "") }), el("span", { class: "rs", text: (e.phase_after ? e.phase_after + (e.reason ? ", " : "") : e.truncated ? "(line cut) " : "") + (e.reason || "") })));
    }
    root.appendChild(ul);
  }

  function renderFiles() {
    const p = state.payload;
    const body = clear($("files-body"));
    if (!p) return;
    if (state.mode === "demo") {
      body.appendChild(el("p", { text: "Demo mode: synthetic fixtures generated by the server, no files are read." }));
      return;
    }
    body.appendChild(el("p", {}, "Folders: ", (p.dirs || []).map((d) => `${d.path}${d.readable ? "" : " (unreadable: " + d.error + ")"}`).join(", ")));
    const ul = el("ul");
    for (const f of p.files || []) ul.appendChild(el("li", { text: `${f.name}, ${f.size} B, ${dayClock(f.mtime)}${f.error ? ", " + f.error : ""}` }));
    body.appendChild(ul);
    body.appendChild(el("p", { class: "dim", text: `${p.withheld || 0} other entries in the folder were deliberately not opened (swap files, passphrase, keys, receipts, recordings, helpers).` }));
    for (const e of p.errors || []) body.appendChild(el("p", { class: "attn", text: e }));
  }

  // ------------------------------------------------------------ render: strip + demo bar + empty state
  function renderStrip() {
    const mc = $("mode-chip");
    mc.className = "chip " + (state.mode === "demo" ? "proof" : "quiet");
    mc.textContent = state.mode === "demo" ? "demo, fixtures" : "run folder";
    mc.title = state.mode === "demo" ? "Synthetic data: nothing here is your swap" : "Read from the run folder";
    const sw = clear($("role-switch"));
    const roles = (state.payload && state.payload.roles) || {};
    const serverRole = state.mode === "run" && state.payload ? state.payload.role : null;
    const machines = state.mode === "run" && state.payload ? V.machineStatus(serverRole, roles) : null;
    for (const r of ["alice", "bob"]) {
      const has = state.mode === "demo" || (roles[r] && (roles[r].tick || roles[r].loop));
      const name = r === "alice" ? "Alice" : "Bob";
      // started with --role: the other tab is off, not just empty
      if (serverRole === "alice" || serverRole === "bob") {
        const off = serverRole !== r;
        sw.appendChild(el("button", { type: "button", "aria-pressed": String(state.role === r), disabled: off ? true : null, title: off ? "this console was started with --role " + serverRole + ": " + name + " runs on another machine" : "", onclick: () => setRole(r) }, name, off ? " (other machine)" : ""));
        continue;
      }
      const other = machines && machines[r] === "other";
      sw.appendChild(el("button", { type: "button", "aria-pressed": String(state.role === r), title: other ? "no files for this side here: it probably runs on another machine" : has ? "" : "no files for this side in the run folder", onclick: () => setRole(r) }, name, other ? " (other machine)" : has ? "" : " (no files)"));
    }
  }

  function setRole(r) {
    state.role = r;
    state.roleChosen = true;
    if (state.mode === "demo") {
      state.demo.step = 0;
      load();
    } else render();
  }

  function renderDemoBar() {
    const bar = $("demo-bar");
    if (state.mode !== "demo" || !state.payload || !state.payload.demo) {
      bar.hidden = true;
      return;
    }
    bar.hidden = false;
    const d = state.payload.demo;
    const inner = clear(bar);
    const scenarioSel = el("select", { id: "d-scenario", "aria-label": "Scenario", onchange: (e) => {
      state.demo.scenario = e.target.value;
      state.demo.step = 0;
      load();
    } });
    for (const s of d.scenarios) scenarioSel.appendChild(el("option", { value: s.id, selected: s.id === d.scenario ? true : null }, s.title));
    const stepSel = el("select", { id: "d-step", "aria-label": "Step", onchange: (e) => {
      state.demo.step = Number(e.target.value);
      load();
    } });
    d.steps.forEach((s, i) => stepSel.appendChild(el("option", { value: String(i), selected: i === d.step ? true : null }, `${i + 1}. ${s.label}, ${s.phase}`)));
    const go = (delta) => {
      const n = Math.min(d.steps.length - 1, Math.max(0, d.step + delta));
      state.demo.step = n;
      load();
    };
    const flags = el("fieldset", {}, el("legend", { class: "sr-only", text: "Pretend that…" }));
    const FLAG_LABEL = { stale: "the tick is old", single: "one node per chain", lag: "a node lags", anomaly: "the engine reports an ANOMALY", held: "the step is already held", withheld: "a read-only tick (params withheld)", reorg: "a reorg event" };
    for (const f of d.available_flags) {
      flags.appendChild(el("label", {}, el("input", { type: "checkbox", checked: d.flags.includes(f) ? true : null, onchange: (e) => {
        const set = new Set(state.demo.flags);
        if (e.target.checked) set.add(f);
        else set.delete(f);
        state.demo.flags = [...set];
        load();
      } }), FLAG_LABEL[f] || f));
    }
    const scen = d.scenarios.find((s) => s.id === d.scenario);
    inner.appendChild(
      el("div", { class: "inner" }, el("div", { class: "row" }, el("span", { class: "banner", text: "Demo: synthetic fixtures, not your swap." }), scenarioSel, stepSel, el("button", { type: "button", class: "btn sm", disabled: d.step === 0 ? true : null, onclick: () => go(-1) }, "← Back"), el("button", { type: "button", class: "btn sm", disabled: d.step >= d.steps.length - 1 ? true : null, onclick: () => go(1) }, "Next step →"), state.health && state.health.operator && state.health.operator.run_dirs.length ? el("button", { type: "button", class: "btn sm", onclick: () => setMode("run") }, "Leave the demo") : null), el("div", { class: "dim", text: scen ? scen.description : "" }), flags)
    );
  }

  function setMode(m) {
    state.mode = m;
    state.payload = null;
    state.roleChosen = false;
    state.runResult = null;
    load();
  }

  function renderEmpty() {
    const p = state.payload;
    if (state.program) {
      for (const id of ["swap-head", "next-action", "timeline", "picture", "explain", "deadlines", "abort", "receipts", "history"]) clear($(id));
      clear($("alarms"));
      addBanners($("alarms"));
      if (window.NoidActions) window.NoidActions.renderPanel(null);
      $("swap-head").appendChild(el("div", { class: "empty" }, el("h2", { text: "This swap cannot be shown" }), el("p", { class: "plain", text: state.error ? `The program did not give it: ${state.error}` : "The swap's folder cannot be read." }), el("button", { type: "button", class: "btn", onclick: () => goScreen("list") }, "Back to your swaps")));
      return;
    }
    for (const id of ["swap-head", "next-action", "timeline", "picture", "explain", "deadlines", "abort", "receipts", "history"]) clear($(id));
    clear($("alarms"));
    addBanners($("alarms"));
    const lockPending = p && p.actions && p.actions.lock && p.actions.lock.folder_missing;
    const msg = state.error ? `The server did not answer: ${state.error}` : lockPending ? "The run folder does not exist yet: run \"1. Install helpers\" (in the Run controls below). Nothing else can run until it exists." : p && p.readable === false ? "The run folder cannot be read." : "";
    if (window.NoidActions) window.NoidActions.renderPanel(p);
    $("swap-head").appendChild(el("div", { class: "empty" }, el("h2", { text: "No run folder to show" }), el("p", { class: "plain", text: msg || "Start the server with --run FOLDER (the folder scripts/live writes: last-tick-alice.json, loop-alice.txt, alice.bundle.json …)." }), (p && p.errors ? p.errors : []).map((e) => el("p", { class: "attn", text: e })), el("button", { type: "button", class: "btn", onclick: () => setMode("demo") }, "Open the demo")));
  }

  // ------------------------------------------------------------ the start screen (actions mode, before any swap exists)
  /** Which first screen applies, from the payload only (actions.js decides): "start" while the console drives Alice and nothing of her swap exists yet, "join" for Bob in the
   *  same state, else null. */
  function startKind() {
    if (state.program) return null; // program mode has its own first screen (renderProgramStartScreen)
    if (!(state.mode === "run" && !state.error && state.payload && window.NoidActions)) return null;
    const A = window.NoidActions;
    if (A.start && A.start.noSwapStarted(state.payload, state.role)) return "start";
    if (A.join && A.join.noJoinStarted(state.payload, state.role)) return "join";
    return null;
  }

  function renderStartScreen(kind) {
    state.view = null;
    for (const id of ["swap-head", "timeline", "picture", "explain", "deadlines", "abort", "receipts", "history"]) clear($(id));
    // Before a bundle exists the screen IS the "no tick yet" state, so that alarm is not repeated; once a bundle exists the engine should be ticking, and the alarms stay (the banners are among them)
    if (state.payload.bundle_file) renderAlarms(V.buildView(viewInput()));
    else addBanners(clear($("alarms")));
    if (kind === "join") window.NoidActions.renderJoin(state.payload);
    else window.NoidActions.renderStart(state.payload);
    window.NoidActions.renderPanel(state.payload, { folded: true });
    document.title = kind === "join" ? "Join a swap, No1d Swap" : "Start a swap, No1d Swap";
  }

  // ------------------------------------------------------------ program mode: screens
  function renderProgramStartScreen() {
    state.view = null;
    for (const id of ["swap-head", "timeline", "picture", "explain", "deadlines", "abort", "receipts", "history"]) clear($(id));
    addBanners(clear($("alarms")));
    window.NoidActions.program.renderStart(state.payload, state.role);
    window.NoidActions.renderPanel(state.payload, { folded: true });
    document.title = "Your swap, No1d Swap";
  }

  const phaseLabel = (role, id) => {
    const i = P && P.phaseInfo ? P.phaseInfo(role, id) : null;
    return i && i.label ? i.label : String(id);
  };

  /** What the bar's menu and the list's buttons ask for. */
  function progHandlers() {
    return {
      go: goScreen,
      refresh: () => load(true),
      open: (what) => askProgram(what),
      openSwap,
      openBoard: openSwap,
      board: makeBoardSlot,
      openProgram: askProgram,
    };
  }

  async function askProgram(what) {
    const r = await window.NoidProgram.openProgram(what);
    state.pgMsg = r.ok ? null : { kind: "danger", text: `The program did not open that: ${r.error}` };
    state.lastSig = null;
    render();
  }

  async function makeBoardSlot(role) {
    const r = await window.NoidProgram.makeSlot(role);
    if (r.ok) {
      await load(true);
      await openSwap(r.swap);
    } else {
      state.pgMsg = { kind: "danger", text: `The board swap was not made: ${r.error}` };
      state.lastSig = null;
      render();
    }
  }

  function leaveSwap() {
    state.swap = null;
    state.payload = null;
    state.view = null;
    state.error = null;
    state.runResult = null;
    if (window.NoidActions && window.NoidActions.clearStart) window.NoidActions.clearStart();
    if (window.NoidBoard && window.NoidBoard.reset) window.NoidBoard.reset();
  }

  async function openSwap(id) {
    state.pgForm = null;
    state.pgMsg = null;
    leaveSwap();
    state.swap = id;
    state.screen = "swap";
    await load(true);
  }

  async function goScreen(screen) {
    state.pgMsg = null;
    state.pgForm = null;
    leaveSwap();
    const PG = window.NoidProgram;
    if (screen === "new") {
      const ns = (state.program && state.program.new_swap_allowed) || { ok: false };
      if (ns.ok) {
        const st = await PG.loadSettings(); // only to fill the form: a failure leaves the fields empty
        state.pgForm = PG.newSwapForm(state.program, st.ok ? st.settings : null, {
          created: async (id) => {
            await load(true);
            await openSwap(id);
          },
          cancel: () => goScreen("list"),
        });
        state.screen = "new";
      } else state.screen = "list";
    } else if (screen === "settings") {
      const st = await PG.loadSettings();
      if (st.ok) {
        state.pgForm = PG.settingsForm(st.settings, { saved: async () => load(true), cancel: () => goScreen("list") });
        state.screen = "settings";
      } else {
        state.pgMsg = { kind: "danger", text: `The settings could not be read: ${st.error}` };
        state.screen = "list";
      }
    } else state.screen = "list";
    state.lastSig = null;
    render();
    const h = $("pg-root").querySelector("h1");
    if (h && h.focus) {
      h.setAttribute("tabindex", "-1");
      h.focus();
    }
  }

  function renderProgramBar() {
    const bar = $("pg-bar");
    if (!bar) return;
    const sig = window.NoidProgram.signature(state.program) + "|" + state.screen;
    if (sig === state.barSig) return;
    state.barSig = sig;
    const old = bar.querySelector(".pg-menu");
    const wasOpen = !!(old && old.open);
    clear(bar);
    bar.hidden = !state.program;
    if (!state.program) return;
    bar.appendChild(window.NoidProgram.topBar(state.program, { screen: state.screen }, progHandlers()));
    const m = bar.querySelector(".pg-menu");
    if (m && wasOpen) m.open = true;
  }

  function renderSwapBar() {
    const bar = clear($("pg-swapbar"));
    const s = ((state.program && state.program.swaps) || []).find((x) => x && x.swap === state.swap) || null;
    bar.hidden = false;
    const row = el("div", { class: "pg-swapbar-in" }, el("button", { type: "button", class: "btn sm", onclick: () => goScreen("list") }, "← Your swaps"), s ? el("strong", { class: "pg-label", text: s.label || "A swap" }) : null, s ? chip("quiet", window.NoidProgram.roleWords(s.role)) : null);
    bar.appendChild(row);
    if (s && s.refused) bar.appendChild(el("div", {}, el("p", { class: "alarm danger", role: "alert" }, el("span", { class: "lv", text: "read only" }), el("span", { class: "tx", text: `This swap's folder is read only: ${s.refused}. Nothing can be run from here.` }))));
    bar.appendChild(el("div", {}, el("p", { class: "margin-line dim", text: "Back up the whole run folder (the swap file and run.json are in it) and keep your recovery code. The swap file alone is not enough." })));
  }

  function renderProgramScreen() {
    const root = $("pg-root");
    if (state.pgForm && state.screen !== "list") {
      // a form is built once per visit and kept in place: a poll must not drop what is being typed
      if (root.firstChild !== state.pgForm.node) {
        clear(root);
        root.appendChild(state.pgForm.node);
      }
      document.title = state.screen === "new" ? "New swap, No1d Swap" : "Settings, No1d Swap";
      return;
    }
    clear(root);
    if (state.pgMsg) root.appendChild(el("p", { class: state.pgMsg.kind === "danger" ? "attn" : "plain", role: "alert", text: state.pgMsg.text }));
    if (!state.program) {
      root.appendChild(el("p", { class: "attn", role: "alert", text: `The program did not answer: ${state.error || "no answer"}` }));
      return;
    }
    if (state.error) root.appendChild(el("p", { class: "attn", role: "alert", text: `The last read failed: ${state.error}` }));
    root.appendChild(window.NoidProgram.swapList(state.program, progHandlers()));
    document.title = "Your swaps, No1d Swap";
  }

  function renderProgram() {
    renderProgramBar();
    const swapScreen = state.screen === "swap";
    $("pg-root").hidden = swapScreen;
    $("pg-swapbar").hidden = !swapScreen;
    $("swap-head").hidden = !swapScreen;
    $("files").hidden = true;
    if (!swapScreen) {
      $("op-view").hidden = true;
      $("bd-root").hidden = true;
      $("board-line").hidden = true;
      state.view = null;
      renderProgramScreen();
      return;
    }
    $("op-view").hidden = false;
    renderSwapBar();
    renderBoardLine();
    const boardShown = renderBoardScreens();
    renderOperatorPage();
    if (boardShown && window.NoidBoard.title) document.title = window.NoidBoard.title();
  }

  // ------------------------------------------------------------ main render
  // The offer board's one status line (piece 3): the words below are fixed here for the codes the payload's `board` object carries; nothing from a message is shown.
  const BOARD_WAIT = { take: "waiting for someone to take the offer", accept: "waiting for the maker to answer the take", bob_addresses: "waiting for Bob's signed addresses", bob_wallet: "making Bob's own wallet", alice_wallet: "making Alice's own wallets", signature: "signing", bundle: "waiting for Alice's bundle", prepare: "Alice is preparing the swap", bob_check: "waiting for Bob's signed check answer", tip: "reading the tip of the Parano1d node", join: "Bob's tool is checking the bundle against his terms", deposit_and_approval: "waiting for Bob's deposit and his approval", engine: "the engine and the chains carry the swap" };
  const BOARD_STOP = { declined: "the maker declined", cancelled_here: "cancelled here", cancelled_by_peer: "the other side cancelled", time_limit: "a time limit passed", bad_signature: "a signature was not valid", refused: "the bundle was refused", h_create_range: "the bundle's h_create is out of range", bad_bundle: "the bundle was not usable", digest_mismatch: "the digests did not match", helper_failed: "a helper step failed", bad_addresses: "the addresses were not acceptable", bad_message: "a message broke the rules", other: "stopped" };
  function renderBoardLine() {
    const node = $("board-line");
    if (!node) return;
    const b = state.payload && state.payload.board;
    if (!b || !b.enabled) {
      node.hidden = true;
      return;
    }
    node.hidden = false;
    let text;
    if (b.stopped) text = `Offer board: stopped (${BOARD_STOP[b.stopped] || "stopped"}); ${b.nothing_funded === true ? "nothing was funded" : "the chains decide: refunds and recovery run as usual"}.`;
    else if (b.finished) text = "Offer board: this swap is over.";
    else if (b.state === "no_offer") text = `Offer board: no offer yet (${b.shown_offers || 0} on the board).`;
    else text = `Offer board: ${BOARD_WAIT[b.waiting_for] || "working"}.`;
    if (b.error) text += " The board hit an error and went on: see the audit log.";
    node.textContent = text;
  }

  /** The offer board's screens (piece 3, board.js): drawn when the console runs with --board, above the operator page, which stays reachable as "Details". Never throws into render(). */
  function renderBoardScreens() {
    if (!window.NoidBoard) return false;
    try {
      const p = state.payload;
      const usable = state.mode === "run" && p && !state.error && p.board && p.board.enabled === true;
      let view = null;
      if (usable) {
        try {
          view = V.buildView(viewInput());
        } catch {
          view = null;
        }
      }
      return window.NoidBoard.render(usable ? p : null, view);
    } catch (e) {
      const root = $("bd-root");
      if (root) {
        clear(root);
        root.appendChild(el("p", { class: "attn", role: "alert", text: "The board's screens could not be drawn. Open Details for the tool's own view." }));
        root.hidden = false;
      }
      const opv = $("op-view");
      if (opv) opv.hidden = false;
      return false;
    }
  }

  function render() {
    if (state.program) {
      renderProgram();
      return;
    }
    renderBoardLine();
    const boardShown = renderBoardScreens();
    renderOperatorPage();
    // the board's screen names the tab; the operator page's own title would otherwise win
    if (boardShown && window.NoidBoard.title) document.title = window.NoidBoard.title();
  }

  function renderOperatorPage() {
    if (!state.program) {
      renderStrip();
      renderDemoBar();
      renderFiles();
    }
    if (state.program && state.payload && !state.error && window.NoidActions && window.NoidActions.program.startKind(state.payload, state.role)) {
      renderProgramStartScreen();
      return;
    }
    const kind = startKind();
    if (kind) {
      renderStartScreen(kind);
      return;
    }
    if (window.NoidActions && window.NoidActions.clearStart) window.NoidActions.clearStart();
    if (!state.payload || state.error || (state.mode === "run" && state.payload.readable === false)) {
      renderEmpty();
      return;
    }
    const view = V.buildView(viewInput());
    state.view = view;
    renderHead(view);
    renderAlarms(view);
    renderAction(view);
    renderTimeline(view);
    renderPicture(view);
    renderExplain(view);
    renderDeadlines(view);
    renderAbort(view);
    renderReceipts(view);
    renderHistory(view);
    if (window.NoidActions) window.NoidActions.renderPanel(state.payload);
    document.title = `${view.role === "alice" ? "Alice" : "Bob"}, ${view.phase ? view.phase.id : "no data"}, No1d Swap`;
  }

  /** Once a second: only the parts that show a clock, so focus and text selection elsewhere are left alone. */
  function clockTick() {
    if (!state.payload || state.error || !state.view || (state.mode === "run" && state.payload.readable === false)) return;
    const view = V.buildView(viewInput());
    state.view = view;
    renderCapsules(view);
    renderAlarms(view);
    renderDeadlines(view);
    const cb = $("next-action").querySelector(".due-clock");
    if (cb) {
      const cm = clockMode(view);
      if (cm) fillClock(cb, view.clock, cm === "calm");
      else cb.remove();
    }
    renderPicture(view);
    if (window.NoidActions) window.NoidActions.tick();
    if (window.NoidBoard) window.NoidBoard.tick();
  }

  // ------------------------------------------------------------ boot
  async function boot() {
    // The runner token comes only from the URL fragment (never sent to the server), is kept in memory, and is removed from the address bar.
    const m = /(?:^|[#&])token=([0-9a-f]{16,})/.exec(location.hash || "");
    if (m) {
      state.token = m[1];
      history.replaceState(null, "", location.pathname + location.search);
      // the chain-polling console is another page: its link carries the key too
      const cl = document.querySelector('a[href="/console"]');
      if (cl) cl.href = "/console#token=" + state.token;
    }
    const qs = new URLSearchParams(location.search);
    $("refresh").addEventListener("click", () => load(true));
    // Program mode is decided by the program's own answer: /api/program answers 200 with the list of swaps. Any other answer (the terminal console says 404) is the terminal console.
    try {
      const prog = await getJson("/api/program");
      if (prog && typeof prog === "object" && Array.isArray(prog.swaps)) state.program = prog;
    } catch {
      /* the terminal console: nothing changes */
    }
    if (state.program) {
      document.body.classList.add("program");
      window.NoidProgram.init({ el, chip, copyButton, state, phaseLabel });
    } else {
      try {
        state.health = await getJson("/api/health");
      } catch (e) {
        state.error = e.message;
      }
    }
    const op = (state.health && state.health.operator) || {};
    state.mode = !state.program && (qs.has("demo") || op.start_in_demo) ? "demo" : "run";
    if (state.program) {
      // no demo and no role switch in program mode: every swap has its own role
    } else if (qs.get("scenario")) state.demo.scenario = qs.get("scenario");
    if (!state.program && qs.get("step")) state.demo.step = Number(qs.get("step")) || 0;
    if (!state.program && qs.get("flags")) state.demo.flags = qs.get("flags").split(",").filter(Boolean);
    if (!state.program && (qs.get("role") === "alice" || qs.get("role") === "bob")) {
      state.role = qs.get("role");
      state.roleChosen = true;
    }
    if (window.NoidBoard) window.NoidBoard.init({ el, nowS, clock, hm: (u) => (typeof u === "number" ? new Date(u * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false }) : "—"), fmtDur, state, reload: load, rerender: () => { state.lastSig = null; render(); } });
    if (window.NoidActions) {
      window.NoidActions.init({ el, chip, copyButton, short, clock, dayClock, nowS, state, reload: load, rerender: () => { state.lastSig = null; render(); } });
      const foot = $("foot-note");
      if (foot && state.program) foot.textContent = "This page shows what the program reads from a swap's run folder and from the chains. It never shows a secret, a key, a passphrase or a recovery code: those are shown and typed only in the program's own windows. Everything that moves coins needs a dry run, the engine's decision and a typed confirmation, and every action is written to the swap's audit log.";
      else if (foot && op.actions_enabled) foot.textContent = "Actions mode: this page can run the fixed helpers of scripts/live through WSL. Anything that sends to a chain needs a fresh dry run, the engine's tick naming that step and a typed confirmation, and every action is written to the audit log. It still never opens a *.swap.json, a key file or a passphrase, and never shows the secret or a transaction opening.";
    }
    await load();
    setInterval(() => {
      if (!document.hidden && state.mode === "run") load();
    }, POLL_MS);
    setInterval(clockTick, 1000);
  }

  boot();
})();
