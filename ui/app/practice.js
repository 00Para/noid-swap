/* noid-swap operator console, program mode: the practice swap's screens (window.NoidPractice).
   The person presses the real buttons of a swap and a script plays the other side and both chains (lib/practice.js, on the server). This file draws what `GET /api/practice` says and posts the
   person's moves to the practice routes (POST /api/practice/start|act|skip|end), each with the per-start token. It is the only file that does; it has no other request, and no request that names a real swap.
   Sealing: every practice screen carries the band "Practice. Nothing here is real. No coins move." in the top bar (its own pattern, never amber) and the title of the window says Practice; there is no
   address, no copy button and no link on any practice screen; nothing is read from the program's settings, key store, run folders or nodes; nothing is saved.
   The card is the real card's own drawing (stagecard.js draw), with the person's move drawn here in the same classes. No inline styles or handlers (CSP). */
(() => {
  "use strict";
  let H = null; // helpers handed over by operator.js: { el, chip, icon, coinGlyph, state, reload, drawPicture, buildView }

  const BANNER = "Practice. Nothing here is real. No coins move.";
  const TITLE = "Practice · No1d Swap";
  const PIC_HEAD = "pr-h-picture"; // the heading of the practice's picture: its own id, never the real page's
  // the picture's countdowns come from the made-up swap's heights, not from the clock: the screen says so
  const ILLUSTRATIVE = "Practice: the times in this drawing are illustrative. They come from the made-up swap, not from a real clock.";
  const LINE_OF = { none: "none", sent: "sent", pending: "pending", final: "final", secret_public: "final", closing: "pending", closed: "settled", released: "released", unknown: "none" };

  const V = () => window.NoidView;
  const A = () => window.NoidActions;
  const ic = (name) => (H && H.icon ? H.icon(name) : null);
  const trimFrac = (s) => (String(s).includes(".") ? String(s).replace(/0+$/, "").replace(/\.$/, "") : String(s));
  const coinText = (s) => String(s).split(/\b(NOID|ETH)\b/).map((p) => (p === "NOID" ? H.el("span", { class: "c-noid", text: p }) : p === "ETH" ? H.el("span", { class: "c-eth", text: p }) : p));
  const btn = (label, onclick, o = {}) => H.el("button", { type: "button", class: (o.big ? "btn" : "btn sm") + (o.primary ? " primary" : "") + (o.ghost ? " ghost" : ""), disabled: o.disabled ? true : null, title: o.title || null, onclick }, label);

  // ------------------------------------------------------------------ transport (the practice routes only)
  async function request(method, path, body) {
    const init = { method, cache: "no-store", headers: { "x-swap-token": (H.state && H.state.token) || "", ...(body !== undefined ? { "content-type": "application/json" } : {}) } };
    if (body !== undefined) init.body = JSON.stringify(body);
    const r = await fetch(path, init);
    const j = await r.json().catch(() => ({ error: `HTTP ${r.status}` }));
    return { ok: r.ok, status: r.status, json: j };
  }
  const errorText = (r) => (r.json && typeof r.json.error === "string" && r.json.error) || `HTTP ${r.status}`;

  // what the person last pressed went wrong: shown once, under the card's move, until the next redraw that is not a poll
  let ui = { msg: null, role: "alice", scenario: "settled", ticks: {}, typed: "", matched: false, key: "" };

  async function post(path, body) {
    const r = await request("POST", path, body);
    ui.msg = r.ok ? null : errorText(r);
    if (typeof H.reload === "function") await H.reload(true);
    return r;
  }
  const startRun = (scenario, role) => post("/api/practice/start", { scenario, role });
  const act = (id, move, extra) => post("/api/practice/act", { id, act: move, ...(extra || {}) });
  const skip = (id) => post("/api/practice/skip", { id });
  const endRun = (id) => request("POST", "/api/practice/end", { id });

  // ------------------------------------------------------------------ the band
  /** The band over every practice screen: its own pattern (neutral, never amber, which means the swap waits on the person), a note for a screen reader. */
  function band() {
    return H.el("div", { class: "pr-band", role: "note", "aria-label": "You are in the practice swap" }, ic("info"), H.el("strong", { text: "Practice." }), H.el("span", { text: " Nothing here is real. No coins move." }));
  }

  // ------------------------------------------------------------------ the chooser
  function chooser(data, h) {
    const el = H.el;
    const back = el("button", { type: "button", class: "btn sm", id: "pr-back", onclick: () => h.leave() }, "Back to your swaps");
    const root = el("section", { class: "pg-form pr pr-choose", "aria-labelledby": "pr-h" }, el("div", { class: "card-head" }, el("h1", { id: "pr-h", text: "Practice swap" }), el("div", { class: "right" }, back)));
    for (const l of (data.how && data.how.lines) || []) root.appendChild(el("p", { class: "plain", text: l }));
    const roleBox = el("fieldset", { class: "pr-fs" }, el("legend", { text: "Which side do you play?" }));
    const scBox = el("fieldset", { class: "pr-fs" }, el("legend", { text: "Which scenario?" }));
    const descs = {};
    const sync = () => {
      for (const s of data.scenarios || []) if (descs[s.id]) descs[s.id].textContent = s[ui.role] || "";
    };
    for (const r of data.roles || []) {
      const input = el("input", { type: "radio", name: "pr-role", id: `pr-role-${r.id}`, value: r.id, checked: ui.role === r.id ? true : null });
      input.addEventListener("change", () => {
        ui.role = r.id;
        sync();
      });
      roleBox.appendChild(el("label", { class: "pr-opt", for: `pr-role-${r.id}` }, input, el("span", { class: "t" }, el("strong", { text: r.label }))));
    }
    for (const s of data.scenarios || []) {
      const input = el("input", { type: "radio", name: "pr-scenario", id: `pr-sc-${s.id}`, value: s.id, checked: ui.scenario === s.id ? true : null });
      input.addEventListener("change", () => {
        ui.scenario = s.id;
      });
      const d = el("span", { class: "d dim", text: s[ui.role] || "" });
      descs[s.id] = d;
      scBox.appendChild(el("label", { class: "pr-opt", for: `pr-sc-${s.id}` }, input, el("span", { class: "t" }, el("strong", { text: s.title }), d)));
    }
    root.appendChild(roleBox);
    root.appendChild(scBox);
    root.appendChild(el("div", { class: "row" }, btn("Start the practice", () => h.start(ui.scenario, ui.role), { primary: true, big: true })));
    if (ui.msg) root.appendChild(el("p", { class: "attn", role: "alert", text: ui.msg }));
    return root;
  }

  // ------------------------------------------------------------------ the person's move, in the real card's classes
  const checkLineBlock = (a) => {
    const el = H.el;
    const grouped = String(a.line).split(" ");
    const line = el("p", { class: "bundle-check grouped mono", "aria-label": a.line });
    grouped.forEach((g, i) => {
      if (i) line.appendChild(document.createTextNode(" "));
      line.appendChild(el("span", { text: g }));
    });
    return { line, box: el("div", { class: "checkline" }, el("span", { class: "k", text: "Your check line" }), line) };
  };

  function checkPart(d, a, n) {
    const el = H.el;
    const box = el("section", { class: "spend-box funding-guide check-line-box sc-part", "aria-label": "Your check line" }, A().partTitle(n, "Compare the check lines", H.chip("quiet", `with ${a.other}`)));
    box.appendChild(checkLineBlock(a).box);
    box.appendChild(el("p", { class: "plain stop-rule", text: a.say }));
    box.appendChild(el("p", { class: "plain dim", text: "Practice: both check lines are the same one, played for you." }));
    const cb = el("input", { type: "checkbox", id: "cl-match", checked: ui.matched ? true : null });
    const go = btn("Confirm", () => act(d.id, a.match.id, { matches: true }), { primary: true, disabled: !ui.matched });
    cb.addEventListener("change", () => {
      ui.matched = cb.checked === true;
      go.disabled = !ui.matched;
    });
    box.appendChild(el("label", { class: "ack", for: "cl-match" }, cb, ` ${a.match.label}`));
    box.appendChild(el("div", { class: "row" }, go));
    return box;
  }

  function fileNote(done, text) {
    return done ? H.el("p", { class: "plain", role: "status", text }) : null;
  }

  function movePart(d, kind) {
    const el = H.el;
    const a = d.action;
    const box = el("div", { class: "sc-act" });
    if (kind === "button") {
      box.appendChild(btn([ic("check"), a.label], () => act(d.id, a.id), { primary: true, big: true }));
      box.appendChild(el("p", { class: "why dim", text: "Practice: nothing is made. A real prepare makes the swap file." }));
    } else if (kind === "invitation") {
      const inv = btn([ic("save"), a.save.label], () => act(d.id, a.save.id), { primary: !a.save.done, big: !a.save.done });
      const join = btn([ic("open"), a.choose.label], () => act(d.id, a.choose.id), { primary: a.save.done, big: a.save.done });
      box.appendChild(el("div", { class: "sc-part" }, A().partTitle(1, "Send Alice an invitation"), A().fileRow("file", "Invitation for Alice", "It holds your terms and your two addresses, so Alice does not type them. It holds no secret. Send it to Alice as a file.", inv), fileNote(a.save.done, a.save.note)));
      box.appendChild(el("div", { class: "sc-part" }, A().partTitle(2, "Choose the file Alice sends back"), A().fileRow("open", "Alice's swap file", "The program checks it against your own terms. Nothing is sent.", join), el("p", { class: "dim", text: a.choose.note })));
    } else if (kind === "check") {
      if (a.save) {
        const save = btn([ic("save"), a.save.label], () => act(d.id, a.save.id), { primary: !a.save.done, big: !a.save.done });
        box.appendChild(el("div", { class: "sc-part" }, A().partTitle(1, "Give Bob your swap file"), A().fileRow("file", "Swap file for Bob", "Bob needs this file to check your swap. It holds no secret. Save a copy and send it to him as a file, not as pasted text.", save), fileNote(a.save.done, a.save.note)));
      }
      box.appendChild(checkPart(d, a, a.save ? 2 : 0));
    } else if (kind === "approval") {
      const sec = el("section", { class: "spend-box sc-part", "aria-label": "Approve this swap" });
      sec.appendChild(el("p", { class: "plain" }, "You give ", coinText(a.gives), ". You get ", coinText(a.gets), "."));
      const input = el("input", { type: "text", id: "ap-typed", autocomplete: "off", spellcheck: "false", "aria-describedby": "ap-typed-hint", placeholder: a.expected_typed, value: ui.typed });
      const go = btn(a.button.label, () => act(d.id, a.button.id, { typed: input.value, statements: Object.fromEntries(a.statements.map((s) => [s.id, ui.ticks[s.id] === true])) }), { primary: true });
      const refresh = () => {
        const typed = String(input.value || "").trim().replace(/\s+/g, " ").toUpperCase() === String(a.expected_typed).toUpperCase();
        go.disabled = !(typed && a.statements.every((s) => ui.ticks[s.id] === true));
      };
      const labels = a.statements.map((s) => {
        const cb = el("input", { type: "checkbox", id: `ap-stmt-${s.id}`, checked: ui.ticks[s.id] === true ? true : null });
        cb.addEventListener("change", () => {
          ui.ticks[s.id] = cb.checked === true;
          refresh();
        });
        return el("label", { class: "ack", for: `ap-stmt-${s.id}` }, cb, " " + s.text);
      });
      input.addEventListener("input", () => {
        ui.typed = input.value;
        refresh();
      });
      sec.appendChild(el("div", { class: "stmts" }, ...labels));
      sec.appendChild(el("div", { class: "typed" }, el("label", { for: "ap-typed", id: "ap-typed-hint", class: "typed-label" }, "To approve, type the amount and unit of your step: ", el("strong", { class: "mono", text: a.expected_typed })), el("div", { class: "row" }, input, go)));
      refresh();
      box.appendChild(sec);
    } else if (kind === "deposit") {
      const sec = el("section", { class: "spend-box sc-part", "aria-label": "Your deposit" }, A().partTitle(null, "Your deposit"));
      sec.appendChild(el("dl", { class: "facts left" }, el("div", {}, el("dt", { text: "Amount" }), el("dd", {}, coinText(a.amount))), el("div", {}, el("dt", { text: "Where it goes" }), el("dd", { text: "Practice: no address is shown, and there is nothing to send." }))));
      sec.appendChild(el("p", { class: "plain dim", text: a.note }));
      sec.appendChild(el("div", { class: "row" }, btn(a.button.label, () => act(d.id, a.button.id), { primary: true, big: true })));
      box.appendChild(sec);
    }
    if (ui.msg) box.appendChild(el("p", { class: "attn", role: "alert", text: ui.msg }));
    return box;
  }

  /** The wait: the fast clock's count, a skip, and the real time of this step. */
  function waitPart(d) {
    const el = H.el;
    const w = d.wait;
    const left = el("span", { class: "left", id: "pr-left", text: `${w.left_s} s` });
    const box = el("div", { class: "sc-act pr-wait" }, el("p", { class: "plain", role: "timer", "aria-live": "off" }, "Practice clock: the next step in ", left, "."), el("div", { class: "row" }, btn("Skip the wait", () => skip(d.id), { primary: true })), el("p", { class: "dim", text: `In a real swap: ${w.real_text}` }));
    if (ui.msg) box.appendChild(el("p", { class: "attn", role: "alert", text: ui.msg }));
    return box;
  }

  // ------------------------------------------------------------------ the card, the ticket, the explanation
  /** The plan the real card's `draw` takes, from the practice's own card (data only). */
  function planOf(d, view) {
    const c = d.card;
    return { drawn: true, kind: c.kind, tone: c.tone, stage: c.stage, headline: c.headline, status: c.status, reasons: [], action: { kind: "none" }, safety: { loud: [], alarms: [], held: null, heldIntent: null, job: null, autopilot: false, lockBy: null, late: null, noticeInfo: false }, timesNote: null, statusAddr: null, bobLock: null, claims: {}, foot: c.foot, done: c.done || null, picture: null, forceOpen: false, lookSig: "", view, role: d.role, recordClose: false, sweepPending: false };
  }

  function cardNode(d, view) {
    const el = H.el;
    let node = null;
    if (window.NoidStage && typeof window.NoidStage.draw === "function") {
      try {
        node = window.NoidStage.draw(planOf(d, view), null);
      } catch {
        node = null;
      }
    }
    if (!node) node = el("div", { class: "sc-in" + (d.card.tone ? " " + d.card.tone : "") }, el("h2", { class: "sc-head", id: "pr-headline", text: d.card.headline }), el("p", { class: "sc-status", role: "status", text: d.card.status }));
    // the practice has its own ids: the real card's headline id belongs to the real swap page, which is hidden but still in the document
    const head = node.querySelector ? node.querySelector("#pg-headline") : null;
    if (head) head.setAttribute("id", "pr-headline");
    // the person's move, or the wait, goes before the foot line, as the real card's action does
    let extra = null;
    if (d.action) extra = movePart(d, d.action.kind);
    else if (d.wait) extra = waitPart(d);
    if (extra) {
      // before the foot line, as the real card's action is: the foot is taken out and put back after it
      const foot = node.querySelector ? node.querySelector(".sc-foot") : null;
      if (foot) foot.remove();
      node.appendChild(extra);
      if (foot) node.appendChild(foot);
    }
    return node;
  }

  /** The ticket: what the person gives and gets, and the state of each lock in words (the view model's own legs), as the real ticket draws them. */
  function ticketNodes(d, view) {
    const el = H.el;
    const L = V().legsFor ? V().legsFor(view, d.role, { about: () => null }) : null;
    if (!L) return [];
    const t = (d.payload && d.payload.terms) || {};
    const noid = t.amount_micronoid !== undefined ? trimFrac(V().noidText(t.amount_micronoid)) : null;
    const eth = t.eth && t.eth.amount_wei !== undefined ? trimFrac(V().ethText(t.eth.amount_wei)) : null;
    const leg = (l, caption) => {
      const c = l.coin;
      const num = c === "noid" ? noid : eth;
      return el("div", { class: `tk-leg ${c}` }, el("p", { class: "k" }, el("span", { text: caption }), el("span", { text: c === "noid" ? "on Parano1d" : "on Ethereum" })), num ? el("p", { class: "v" }, H.coinGlyph ? H.coinGlyph(c) : null, el("span", { class: "num", text: num }), el("span", { class: "tic", text: c === "noid" ? "NOID" : "ETH" })) : null, el("div", { class: `lockline ${LINE_OF[l.state] || "none"}`, "aria-hidden": "true" }), el("p", { class: "st" }, l.state === "closed" ? ic("check") : null, el("span", { text: l.words })), l.note ? el("p", { class: "note", text: l.note }) : null);
    };
    return [leg(L.give, "You give"), el("div", { class: "tk-key" + (L.public ? " public" : "") }, el("i", { "aria-hidden": "true" }), L.public ? el("span", { text: "secret revealed" }) : null), leg(L.get, "You get"), el("p", { class: "tk-trust", text: "Practice: the amounts are made up and nothing is locked anywhere." })];
  }

  function explainNode(d) {
    const el = H.el;
    const e = d.explain;
    const sec = el("section", { class: "pr-explain", "aria-labelledby": "pr-h-explain" }, el("h2", { id: "pr-h-explain", text: "What this step shows" }));
    sec.appendChild(el("dl", { class: "facts left" }, el("div", {}, el("dt", { text: "What just happened" }), el("dd", { text: e.happened })), el("div", {}, el("dt", { text: "In a real swap" }), el("dd", { text: e.real })), el("div", {}, el("dt", { text: "How long it really takes" }), el("dd", { text: e.time }))));
    return sec;
  }

  function summaryNode(d, h) {
    const el = H.el;
    const s = d.summary;
    return el(
      "section",
      { class: "pr-summary", "aria-labelledby": "pr-h-sum" },
      el("h2", { id: "pr-h-sum", text: "What you practised" }),
      el("p", { class: "plain", text: s.title }),
      el("ul", { class: "fold-list" }, ...s.lines.map((l) => el("li", { text: l }))),
      el("p", { class: "plain dim", text: s.more }),
      el("div", { class: "row" }, btn("Practice again", () => h.start(d.scenario.id, d.role), { primary: true }), btn("Another scenario", () => h.chooser()), btn("Leave practice", () => h.leave(), { ghost: true })),
      ui.msg ? el("p", { class: "attn", role: "alert", text: ui.msg }) : null
    );
  }

  // ------------------------------------------------------------------ the screen
  /**
   * What goes into #pg-root for the practice: the chooser while no session runs, else the header, the card with the ticket beside it, the picture slot, the explanation and, at the end, the summary.
   * `h`: { leave(), start(scenario, role), chooser() }. Returns { node, picture: { slot, view } | null, title }.
   */
  function screen(data, h) {
    const el = H.el;
    if (!data || data.ok !== true) return { node: el("p", { class: "attn", role: "alert", text: "The practice could not be loaded." }), picture: null, title: TITLE };
    const d = data.session;
    if (!d) {
      ui.key = "";
      return { node: chooser(data, h), picture: null, title: TITLE };
    }
    // a new entry starts a new form: the typed amount, the ticks and the tick of the check line are forgotten; a redraw of the same entry keeps them
    const key = `${d.id}|${d.entry.id}`;
    if (ui.key !== key) {
      ui.key = key;
      ui.typed = "";
      ui.ticks = {};
      ui.matched = false;
    }
    const view = typeof H.buildView === "function" ? H.buildView(d) : null;
    const top = el("div", { class: "card-head" }, el("h1", { id: "pr-h", text: "Practice swap" }), el("div", { class: "right" }, btn("Leave practice", () => h.leave(), { ghost: true })));
    const where = el("p", { class: "plain pr-where" }, el("strong", { text: d.scenario.title }), ` · ${d.role_words} · step ${d.position.n} of ${d.position.of}`);
    const card = el("section", { class: "sc-card pr-card", id: "pr-card", tabindex: "-1", "aria-label": "This swap, step by step" }, cardNode(d, view));
    const tk = el("aside", { class: "tk pr-ticket", "aria-label": "This swap: what you give and what you get" }, ...(view ? ticketNodes(d, view) : []));
    const grid = el("div", { class: "pr-grid" }, card, tk);
    const slot = el("section", { class: "tl pr-picture", "aria-labelledby": PIC_HEAD, hidden: true });
    const root = el("section", { class: "pg pr", "aria-labelledby": "pr-h" }, top, where, grid, slot, explainNode(d));
    if (d.finished && d.summary) root.appendChild(summaryNode(d, h));
    // the two locks drawn once a lock is seen on either chain, as the real main view does
    const pic = view && view.picture && Array.isArray(view.picture.tracks) && d.card.stage === 4 && view.picture.tracks.some((t) => t.state !== "none") ? { slot, view } : null;
    return { node: root, picture: pic, title: TITLE };
  }

  /** What changes the screen, without the clock: the entry, the position, the finish and the chooser's data; never the payload's own times or the wait's count. */
  function signature(data) {
    if (!data) return "none";
    const d = data.session;
    return JSON.stringify(d ? { id: d.id, e: d.entry, p: d.position, f: d.finished, a: d.action, c: d.card, w: d.wait ? d.wait.real_text : null, m: ui.msg } : { s: data.scenarios, m: ui.msg });
  }

  /** Once a second: the wait's count, from the server's own figure and the page's clock; at zero the page asks again (the server ends the wait). */
  function tick(data, ageS) {
    const d = data && data.session;
    if (!d || !d.wait || typeof document === "undefined") return false;
    const left = Math.max(0, d.wait.left_s - Math.floor(ageS));
    const n = document.getElementById("pr-left");
    if (n) n.textContent = `${left} s`;
    return left === 0;
  }

  /** Says something plain under the chooser's button (a refusal the page made itself, e.g. a real swap needs the person): shown until the next redraw that is not a poll. */
  async function say(text) {
    ui.msg = String(text);
    if (typeof H.reload === "function") await H.reload(true);
  }

  /** The player's choice goes back to the first scenario after a run. */
  function reset() {
    ui = { msg: null, role: "alice", scenario: "settled", ticks: {}, typed: "", matched: false, key: "" };
  }

  window.NoidPractice = {
    init(helpers) {
      H = helpers;
    },
    band,
    screen,
    signature,
    tick,
    reset,
    start: startRun,
    end: endRun,
    say,
    BANNER,
    TITLE,
    PIC_HEAD,
    ILLUSTRATIVE,
  };
})();
