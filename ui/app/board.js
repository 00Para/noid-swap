/* noid-swap operator console: the offer board's screens (piece 3, step P3.7): offers, take and deposit and the one approval, progress, done and refunded.
 *
 * Everything here is a view of what the server says (/api/run -> board, actions.wallet, actions.autopilot, the view model) plus FOUR posts, each with the per-start key:
 *   /api/board {"op":"post"|"take"|"cancel"}   and   /api/autopilot {"on":true, ...}   (the one approval).
 * It adds no way to send: the server decides every step (the approval, the gate, the dry run, the latch, the audit line). The page never receives a key or a secret.
 * Every piece of text from the server is put into the page as TEXT (textContent through the `el` helper); there is no innerHTML, no document.write and no eval in this file.
 * No inline style (the page's content policy): the marks and bars are elements with classes.
 */
(() => {
  "use strict";
  let H = null; // helpers handed over by operator.js: el, nowS, clock, state, reload, rerender
  const BV = () => window.NoidBoardView;
  const ui = { tab: "auto", posting: false, taking: null, form: { noid: "", eth: "" }, ap: { typed: "", ticks: {} }, msg: null, details: false, busy: false, last: null, live: "", title: "", focus: null, shown: null };

  // ------------------------------------------------------------------ small pieces
  // children may be nested lists at any depth: flattened here, because the page's own `el` flattens one level only
  const el = (tag, attrs, ...kids) => H.el(tag, attrs, ...kids.flat(Infinity));
  const amt = (coin, text, cls) => el("span", { class: (coin === "NOID" ? "c-noid" : "c-eth") + (cls ? " " + cls : ""), text });
  /** A time of day as hours and minutes, in this computer's own time (the page's clock helper when it has no shorter one). */
  const hm = (unix) => (typeof H.hm === "function" ? H.hm(unix) : H.clock(unix));
  const mono = (text, cls) => el("span", { class: "mono" + (cls ? " " + cls : ""), text });
  const KEY_LOST = "This page lost its key. Open the start address printed in the terminal again.";
  /** A small stroked icon (the same 16-unit drawings the mock screens use): "clock", "check", "alert", "return", "stop", "info". Decorative. */
  function icon(kind) {
    if (typeof document === "undefined" || typeof document.createElementNS !== "function") return el("span", { class: "bd-ic", "aria-hidden": "true" });
    const NS = "http://www.w3.org/2000/svg";
    const mk = (tag, attrs) => {
      const n = document.createElementNS(NS, tag);
      for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
      return n;
    };
    const svg = mk("svg", { viewBox: "0 0 16 16", "aria-hidden": "true", focusable: "false", class: "bd-ic" });
    const parts = {
      clock: [["circle", { cx: 8, cy: 8, r: 6 }], ["path", { d: "M8 4.5V8l2.5 1.5" }]],
      check: [["path", { d: "M3 8.5l3 3 7-7" }]],
      alert: [["circle", { cx: 8, cy: 8, r: 6 }], ["path", { d: "M8 4.8v3.8" }], ["path", { d: "M8 11.1v.1" }]],
      info: [["circle", { cx: 8, cy: 8, r: 6 }], ["path", { d: "M8 7.2v4" }], ["path", { d: "M8 4.9v.1" }]],
      return: [["path", { d: "M6 3.5L3 6.5l3 3" }], ["path", { d: "M3 6.5h6.5a3.5 3.5 0 010 7H6" }]],
      stop: [["circle", { cx: 8, cy: 8, r: 6 }], ["path", { d: "M5.5 5.5l5 5" }]],
      run: [["circle", { cx: 8, cy: 8, r: 6 }], ["circle", { cx: 8, cy: 8, r: 2.2, class: "dotc" }]],
    }[kind] || [];
    for (const [tag, attrs] of parts) svg.appendChild(mk(tag, attrs));
    return svg;
  }

  async function post(path, body) {
    const r = await fetch(path, { method: "POST", cache: "no-store", headers: { "content-type": "application/json", "x-swap-token": H.state.token || "" }, body: JSON.stringify(body) });
    const j = await r.json().catch(() => ({ error: `HTTP ${r.status}` }));
    return { ok: r.ok, status: r.status, json: j };
  }
  const errorText = (r) => [r.json && r.json.error ? String(r.json.error) : `HTTP ${r.status}`, ...((r.json && Array.isArray(r.json.reasons) ? r.json.reasons : []).map((x) => (x && x.text ? String(x.text) : "")).filter(Boolean))].join(" ");

  function setLive(text) {
    ui.live = text;
    const n = typeof document !== "undefined" && document.getElementById ? document.getElementById("bd-live") : null;
    if (n) n.textContent = text;
  }
  function redraw() {
    if (ui.last) renderInto(ui.last.payload, ui.last.view);
  }
  async function refreshAll() {
    redraw();
    await H.reload(true);
  }

  const msgLine = () => (ui.msg ? el("p", { class: "bd-msg " + (ui.msg.kind || "danger"), role: "alert", text: ui.msg.text }) : null);

  /** An address in a box that keeps its tail and shortens in the middle; the full value is selectable and in the title. */
  const addrBox = (a) => el("span", { class: "bd-addr mono", title: a }, el("span", { class: "h", text: a.slice(0, -6) }), el("span", { class: "e", text: a.slice(-6) }));
  function copyBtn(value, label) {
    const b = el("button", { type: "button", class: "bd-btn sm", "aria-label": `Copy ${label}` }, "Copy");
    b.addEventListener("click", async () => {
      let ok = false;
      try {
        await navigator.clipboard.writeText(value);
        ok = true;
      } catch {
        ok = false;
      }
      b.textContent = ok ? "Copied" : "Not copied";
      setLive(ok ? "Copied to the clipboard" : "Could not copy: select the address and copy it by hand");
      setTimeout(() => {
        b.textContent = "Copy";
        setLive("");
      }, 1500);
    });
    return b;
  }

  // ------------------------------------------------------------------ the frame: the places and the network
  function frame(ctx, screen, body) {
    const swap = ctx.hasSwap;
    const tab = (id, label, current, disabled, why) => el("button", { type: "button", class: "bd-tab", "data-tab": id, "aria-current": current ? "page" : null, disabled: disabled ? true : null, title: disabled ? why : null, onclick: () => {
      ui.tab = id === "offers" ? "offers" : "auto";
      ui.taking = null;
      ui.posting = false;
      ui.msg = null;
      redraw();
    } }, label);
    const onOffers = screen === "offers";
    const net = el("p", { class: "bd-end" }, el("span", { text: `Ethereum side: ${ctx.network}` }), ctx.tip !== null ? el("span", {}, "Parano1d block ", mono(String(ctx.tip))) : null);
    const detailsBtn = el("button", { type: "button", class: "bd-tab bd-details-btn", "aria-expanded": String(ui.details), "aria-controls": "op-view", onclick: () => {
      ui.details = !ui.details;
      redraw();
    } }, ui.details ? "Hide details" : "Details");
    const nav = el("nav", { class: "bd-nav", "aria-label": "Board" }, tab("offers", "Offers", onOffers), tab("swap", "Your swap", !onOffers, !swap, "You have no swap yet."), detailsBtn);
    return el("div", { class: "bd-frame" }, el("div", { class: "bd-top" }, nav, net), !H.state.token ? el("p", { class: "bd-msg danger", role: "alert", text: KEY_LOST }) : null, body, el("span", { class: "bd-sr", id: "bd-live", role: "status", "aria-live": "polite", text: ui.live }));
  }

  // ------------------------------------------------------------------ the terms, every one once (used by the take review, the take screen and the approval)
  function termsSection(ctx, terms, heading) {
    const t = terms;
    const hid = "bd-terms-h";
    const arrive = t.arrive;
    return el(
      "section",
      { "aria-labelledby": hid, class: "bd-sec" },
      el("h2", { id: hid, text: heading || "The swap, every term once" }),
      el(
        "div",
        { class: "bd-terms" },
        el("div", { class: "bd-trade" }, el("div", {}, el("p", { class: "k", text: "You give" }), el("p", { class: "f" }, amt(t.give.coin, t.give.words))), el("div", {}, el("p", { class: "k", text: "You get" }), el("p", { class: "f" }, amt(t.get.coin, t.get.words)), t.price ? el("p", { class: "px", text: t.price }) : null)),
        el(
          "dl",
          { class: "bd-kv" },
          el("div", {}, el("dt", { text: `Where your ${arrive.coin} will arrive` }), el("dd", {}, arrive.address ? ["Your own address, from the app's settings: ", addrBox(arrive.address)] : el("span", { class: "bd-warn", text: "Not set. Set your own address in the app's settings first." }), el("small", { text: arrive.via_swap_key ? "The ETH is first taken by a key the app made for this swap, and the app then sends it on to this address when the swap is over. Change the address in the settings, not here. Nothing is paid to anyone else." : "Change it in the settings, not here. Nothing is paid to anyone else." }))),
          t.leftover.address ? el("div", {}, el("dt", { text: `Where any ${t.leftover.coin} left over goes` }), el("dd", {}, "Your own address: ", addrBox(t.leftover.address), el("small", { text: "If the swap does not complete, or a fee deposit is not used, the app sends it back here when the swap is over." }))) : null,
          el("div", {}, el("dt", { text: "Network" }), el("dd", {}, `Ethereum, ${t.network}`, el("small", { text: `Chain ${t.chain_id}. The ETH there is test ETH and has no value. The NOID is real.` }))),
          el("div", {}, el("dt", { text: "Settings profile" }), el("dd", {}, mono(t.profile), el("small", { text: "The timings the swap uses." }))),
          el("div", {}, el("dt", { text: "Swap contract on Ethereum" }), el("dd", {}, addrBox(t.contract), el("small", { text: "The program that holds the coins until the swap ends. The app checks it against its own list before it uses it." }))),
          el("div", {}, el("dt", { text: "Contract version" }), el("dd", {}, mono(t.contract_version), el("small", { text: "Which version of the swap contract is used." }))),
          el("div", {}, el("dt", { text: "Kind of lock" }), el("dd", {}, mono(t.lock), el("small", { text: "The proof-free lock: both sides check it without a proof." }))),
          el("div", {}, el("dt", { text: "Key variant" }), el("dd", {}, mono(t.variant), el("small", { text: "The swap's own key, made for this swap only." }))),
          t.short_id ? el("div", {}, el("dt", { text: "Offer" }), el("dd", {}, mono(t.short_id), ", posted by someone on the board. No name, no address.")) : null,
          el("div", {}, el("dt", { text: "If the swap does not complete" }), el("dd", { text: "You get your own coins back by yourself. Both sides complete, or both get their own back." }))
        )
      ),
      ctx.role === "bob" ? limitBox() : null
    );
  }

  /** The one limit a receiver of NOID reads: a fixed sentence, not a live figure (the app has no producer reading before a swap file exists). */
  function limitBox() {
    return el("div", { class: "bd-limitbox", role: "note", "aria-labelledby": "bd-lim-t" }, el("h3", { id: "bd-lim-t", text: "One limit to read before you take this offer" }), el("p", { text: "You would be the one receiving NOID. Someone who controls more than half of a network's block production can undo recent transactions on it. On the Parano1d network one address was measured producing close to half of the blocks in early November 2026, so this cannot be ruled out. If that were the person on the other side, they could take their NOID back after taking your ETH. This is why amounts stay small." }));
  }

  // ------------------------------------------------------------------ screen 1: offers
  function openFor(o, now) {
    const m = BV().minutesOpen(o.expires_at, now);
    return m <= 0 ? "under a minute" : `${m} min`;
  }

  function offerRow(ctx, o) {
    const blocked = !!ctx.takeWhy;
    return el(
      "li",
      { class: "bd-row" },
      el("div", { class: "bd-cell c-what" }, el("h2", {}, o.side === "sell-noid" ? "Sell " : "Buy ", amt("NOID", o.noid_words, "amt"), " for ", amt("ETH", o.eth_words, "amt")), el("p", { class: "who" }, "Offer ", mono(o.short_id))),
      el("div", { class: "bd-cell c-you" }, el("dl", { class: "bd-pair" }, el("div", {}, el("dt", { text: "You give" }), el("dd", {}, amt(o.give.coin, o.give.words))), el("div", {}, el("dt", { text: "You get" }), el("dd", {}, amt(o.get.coin, o.get.words))))),
      el("div", { class: "bd-cell" }, el("p", { class: "fg", text: o.price_value }), el("p", { class: "fg-n", text: "ETH for each NOID" })),
      el("div", { class: "bd-cell" }, el("p", { class: "fg", "data-expires": String(o.expires_at), text: openFor(o, ctx.now) }), el("p", { class: "fg-n", text: "still open" })),
      el("div", { class: "bd-cell c-act" }, el("button", { type: "button", class: "bd-btn", "aria-label": `Take the offer: ${o.what.charAt(0).toLowerCase()}${o.what.slice(1)}`, disabled: blocked ? true : null, title: blocked ? ctx.takeWhy : null, onclick: () => {
        ui.taking = o.id;
        ui.msg = null;
        redraw();
      } }, "Take"))
    );
  }

  function postForm(ctx) {
    const B = BV();
    const L = ctx.board.limits || {};
    const alice = ctx.role === "alice";
    const noidIn = el("input", { id: "bd-post-noid", type: "text", inputmode: "decimal", autocomplete: "off", spellcheck: "false", "aria-describedby": "bd-post-noid-h", value: ui.form.noid });
    const ethIn = el("input", { id: "bd-post-eth", type: "text", inputmode: "decimal", autocomplete: "off", spellcheck: "false", "aria-describedby": "bd-post-eth-h", value: ui.form.eth });
    const price = el("p", { class: "bd-hint", "aria-live": "polite" });
    const why = el("p", { class: "bd-hint", id: "bd-post-why" });
    const go = el("button", { type: "submit", class: "bd-go", disabled: true, "aria-describedby": "bd-post-why" }, "Post the offer");
    const read = () => {
      const noid = B.decimalToUnits(noidIn.value, 6);
      const wei = B.decimalToUnits(ethIn.value, 18);
      let reason = null;
      if (!H.state.token) reason = KEY_LOST;
      else if (!ctx.board.can_start) reason = "This app cannot start a new swap now.";
      else if (!ctx.board.payouts || !ctx.board.payouts.eth || !ctx.board.payouts.noid) reason = "Your own address is not set in the app's settings.";
      else if (!noid) reason = "Type the NOID amount as a plain number, for example 5.";
      else if (BigInt(noid) < BigInt(L.noid_min_micro || "0") || BigInt(noid) > BigInt(L.noid_max_micro || "0")) reason = `The NOID amount must be between ${B.noidWords(L.noid_min_micro)} and ${B.noidWords(L.noid_max_micro)}.`;
      else if (!wei || wei === "0") reason = "Type the ETH amount as a plain number, for example 0.001.";
      else if (BigInt(wei) > BigInt(L.wei_max || "0")) reason = `The ETH amount must be at most ${B.ethWords(L.wei_max)}.`;
      go.disabled = !!reason;
      why.textContent = reason || "";
      price.textContent = noid && wei && wei !== "0" ? `Price: ${B.priceWords(((BigInt(wei) * 1000000n) / BigInt(noid)).toString())}` : "";
      return { noid, wei, reason };
    };
    noidIn.addEventListener("input", () => {
      ui.form.noid = noidIn.value;
      read();
    });
    ethIn.addEventListener("input", () => {
      ui.form.eth = ethIn.value;
      read();
    });
    const form = el(
      "form",
      { class: "bd-post", "aria-labelledby": "bd-post-h", novalidate: true },
      el("h2", { id: "bd-post-h", text: "Post an offer" }),
      el("p", { class: "bd-hint", text: alice ? "You sell NOID and get ETH. The offer stays on the board only while this app is open." : "You buy NOID and give ETH. The offer stays on the board only while this app is open." }),
      el("div", { class: "bd-field" }, el("label", { for: "bd-post-noid", text: "NOID amount" }), el("div", { class: "bd-amt-in" }, noidIn, el("span", { class: "u c-noid", text: "NOID" })), el("p", { class: "bd-hint", id: "bd-post-noid-h", text: `From ${B.noidWords(L.noid_min_micro)} to ${B.noidWords(L.noid_max_micro)}.` })),
      el("div", { class: "bd-field" }, el("label", { for: "bd-post-eth", text: "ETH amount" }), el("div", { class: "bd-amt-in" }, ethIn, el("span", { class: "u c-eth", text: "ETH" })), el("p", { class: "bd-hint", id: "bd-post-eth-h", text: `At most ${B.ethWords(L.wei_max)}.` })),
      price,
      el("p", { class: "bd-hint", text: "Everything else, the network, the swap contract and the kind of lock, comes from the app's own settings. The offer expires after 30 minutes and the app puts it up again while it runs." }),
      el("div", { class: "bd-runrow" }, go, el("button", { type: "button", class: "bd-btn", onclick: () => {
        ui.posting = false;
        ui.msg = null;
        redraw();
      } }, "Cancel"), why)
    );
    form.addEventListener("submit", async (ev) => {
      if (ev && ev.preventDefault) ev.preventDefault();
      const r = read();
      if (r.reason || ui.busy) return;
      ui.busy = true;
      ui.msg = null;
      const res = await post("/api/board", { op: "post", noid_micro: r.noid, wei: r.wei });
      ui.busy = false;
      if (!res.ok) ui.msg = { kind: "danger", text: errorText(res) };
      else {
        ui.posting = false;
        ui.form = { noid: "", eth: "" };
        ui.tab = "auto";
      }
      await refreshAll();
    });
    read();
    return form;
  }

  function offersScreen(ctx) {
    const B = BV();
    const b = ctx.board;
    const list = ctx.offers;
    const lim = b.limits || {};
    const sub = list.length ? `${list.length} open now. An offer stays on the board only while the person who posted it keeps the app open.` : "None open now.";
    const note = el("aside", { class: "bd-note", "aria-label": "About this board" }, icon("info"), el("p", {}, el("b", { text: b.mode === "private" ? "Private test board, by invitation." : "Test board." }), " A swap is capped at ", amt("NOID", B.noidWords(lim.noid_max_micro) || "?", "mono"), " or ", amt("ETH", B.ethWords(lim.wei_max) || "?", "mono"), `. The Ethereum side is the ${ctx.network}: that ETH has no value, the NOID is real.`));
    const post = el("button", { type: "button", class: "bd-go", "aria-expanded": String(ui.posting), disabled: !b.can_start || !H.state.token ? true : null, title: !H.state.token ? KEY_LOST : !b.can_start ? ctx.startWhy : null, onclick: () => {
      ui.posting = !ui.posting;
      ui.msg = null;
      if (ui.posting) ui.focus = "bd-post-noid";
      redraw();
    } }, "Post an offer");
    const kids = [el("div", { class: "bd-lead" }, el("div", {}, el("h1", { text: "Offers" }), el("p", { class: "sub", text: sub })), post), note];
    if (!b.can_start) kids.push(el("p", { class: "bd-msg quiet", role: "note", text: ctx.startWhy }));
    const m = msgLine();
    if (m) kids.push(m);
    if (ui.posting && b.can_start) kids.push(postForm(ctx));
    if (list.length) {
      kids.push(el("ol", { class: "bd-list", "aria-label": "Open offers, smallest first" }, list.map((o) => offerRow(ctx, o))));
      kids.push(el("p", { class: "bd-sort", text: "Smallest first. Taking an offer starts nothing yet: you see every term and decide on the next page." }));
    } else {
      kids.push(el("div", { class: "bd-empty" }, el("h2", { text: "The board is empty" }), el("p", { text: "Offers appear here when someone with the app open posts one, and they leave when that app closes. Post your own, or look again in a few minutes." }), el("div", { class: "ghostrows", "aria-hidden": "true" }, el("i"), el("i"), el("i"))));
    }
    kids.push(
      el("section", { class: "bd-limits", "aria-labelledby": "bd-lim-h" }, el("h2", { id: "bd-lim-h", text: "Limits of this board" }), el("div", { class: "bd-limit" }, el("div", {}, el("p", { class: "v c-noid", text: B.noidWords(lim.noid_max_micro) || "?" }), el("p", { class: "k", text: "the most one swap may lock on the test network" })), el("div", {}, el("p", { class: "v c-eth", text: B.ethWords(lim.wei_max) || "?" }), el("p", { class: "k", text: "the same limit on the Ethereum side" })), el("div", {}, el("p", { class: "v", text: `about ${B.USUAL_MINUTES} min` }), el("p", { class: "k", text: "a normal swap, from your approval to both sides done" })))),
      el("p", { class: "bd-foot", text: "Test network only. Nothing on this page sends or locks anything. Offers carry no names and no addresses." })
    );
    return el("section", { "aria-label": "Offers", class: "bd-screen" }, kids);
  }

  /** The review of an offer before it is taken: every term, then one button. The button sends only the wish to take; nothing is locked or paid by it. */
  function reviewScreen(ctx, o) {
    const B = BV();
    const terms = o ? B.termRows(o, ctx.board.payouts, ctx.role) : null;
    const gone = !o || !terms;
    let why = null;
    if (!H.state.token) why = KEY_LOST;
    else if (gone) why = "This offer is no longer on the board.";
    else if (!ctx.board.can_start) why = ctx.startWhy;
    else if (!terms.payouts_set) why = "Your own address is not set in the app's settings.";
    const go = el("button", { type: "button", class: "bd-go", disabled: why ? true : null, "aria-describedby": "bd-take-why", onclick: async () => {
      if (why || ui.busy) return;
      ui.busy = true;
      ui.msg = null;
      const res = await post("/api/board", { op: "take", offer_id: o.id });
      ui.busy = false;
      if (!res.ok) ui.msg = { kind: "danger", text: errorText(res) };
      else {
        ui.taking = null;
        ui.tab = "auto";
      }
      await refreshAll();
    } }, "Take this offer");
    const kids = [
      el("p", { class: "bd-back" }, el("button", { type: "button", class: "bd-link", onclick: () => {
        ui.taking = null;
        ui.msg = null;
        redraw();
      } }, "Back to offers")),
      el("div", { class: "bd-lead one" }, el("h1", {}, gone ? "This offer is gone" : ["Take this offer: give ", amt(terms.give.coin, terms.give.words), ", get ", amt(terms.get.coin, terms.get.words)]), el("p", { class: "sub", text: "Check every term below. Taking the offer only tells the other side you want it. Nothing is locked or paid until you give the approval later." })),
    ];
    if (!gone) kids.push(termsSection(ctx, terms));
    const m = msgLine();
    if (m) kids.push(m);
    kids.push(el("div", { class: "bd-runrow" }, go, el("p", { id: "bd-take-why", class: "bd-hint", text: why || "" })));
    return el("section", { "aria-label": "Take an offer", class: "bd-screen" }, kids);
  }

  // ------------------------------------------------------------------ screen 2: waiting for a take (the person's own offer)
  function waitingScreen(ctx) {
    const terms = ctx.terms;
    const kids = [el("div", { class: "bd-lead one" }, el("h1", { text: "Your offer is on the board" }), el("p", { class: "sub", text: "It stays on the board only while this app is open. When someone takes it, this page moves on by itself to the deposit." }))];
    if (terms) kids.push(termsSection(ctx, terms, "Your offer, every term once"));
    const m = msgLine();
    if (m) kids.push(m);
    kids.push(el("div", { class: "bd-runrow" }, el("button", { type: "button", class: "bd-btn", disabled: !H.state.token ? true : null, onclick: async () => {
      if (ui.busy) return;
      ui.busy = true;
      const res = await post("/api/board", { op: "cancel" });
      ui.busy = false;
      ui.msg = res.ok ? null : { kind: "danger", text: errorText(res) };
      await refreshAll();
    } }, "Withdraw the offer"), el("p", { class: "bd-hint", text: "Withdrawing locks and pays nothing." })));
    return el("section", { "aria-label": "Your offer", class: "bd-screen" }, kids);
  }

  // ------------------------------------------------------------------ screen 3: take, deposit, approval
  function stepsStrip(ctx, at) {
    const items = [
      ["Offer chosen", "you, done"],
      ["Send your deposit", at === 2 ? "you, now" : at > 2 ? "you, done" : "you"],
      ["Give the one approval", at === 3 ? "you, now" : at > 3 ? "you, done" : "you"],
      ["The swap runs", "by itself, nothing for you to do"],
    ];
    return el(
      "section",
      { class: "bd-steps", "aria-labelledby": "bd-steps-h" },
      el("h2", { id: "bd-steps-h" }, "Four steps ", el("span", { text: `You are at step ${at}. Nothing is locked yet.` })),
      el("ol", {}, items.map(([what, who], i) => {
        const n = i + 1;
        const cls = n < at ? "done" : n === at ? "now" : "todo";
        return el("li", { class: cls, "aria-current": n === at ? "step" : null }, el("span", { class: "n", text: String(n) }), el("span", { class: "what" }, what, n < at ? el("span", { class: "bd-sr", text: ", done" }) : null), el("span", { class: "who", text: who }));
      }))
    );
  }

  /** The time left for the deposit, only from block heights the app has read: the window closes `fund_k` blocks after the swap's start height; 30 s a block is an estimate. */
  function windowLeft(ctx) {
    const hc = ctx.payload.terms && Number.isSafeInteger(ctx.payload.terms.h_create) ? ctx.payload.terms.h_create : null;
    const tip = ctx.view && ctx.view.header && ctx.view.header.noid && typeof ctx.view.header.noid.tip_estimate === "number" ? ctx.view.header.noid.tip_estimate : null;
    const k = Number.isSafeInteger(ctx.board.fund_k) ? ctx.board.fund_k : null;
    if (hc === null || tip === null || k === null) return null;
    const blocks = hc + k - tip;
    return { blocks, seconds: blocks * BV().BLOCK_S };
  }

  function depositRowEl(ctx, r, n, total) {
    const coin = r.coin;
    const title = coin === "NOID" ? `Deposit ${n}: NOID for the swap` : total > 1 ? `Deposit ${n}: a little ETH for the network fee` : "Deposit: ETH for the swap and the fee";
    const explain = coin === "NOID" ? `${r.amount_words || "The amount"} go into the swap.${r.reserve_words ? ` The other ${r.reserve_words} stay in your swap wallet to pay network fees.` : ""} What is not used comes back to you.` : total > 1 ? "You need it to take your ETH. What is not used comes back to you." : `${r.amount_words || "The amount"} go into the swap.${r.reserve_words ? ` The other ${r.reserve_words} stay in your swap wallet for network fees.` : ""} What is not used comes back to you.`;
    return el(
      "li",
      { class: "bd-dep" + (n > 1 && total > 1 ? " small" : "") },
      el("div", { class: "dep-h" }, el("h3", { text: title }), el("p", { class: "dst" + (r.seen ? " seen" : ""), role: "status" }, icon(r.seen ? "check" : "clock"), r.seen ? "Seen" : "Waiting for your deposit")),
      el("p", { class: "a" }, amt(coin, r.need_words || "?")),
      el("p", { class: "x", text: explain }),
      !r.seen && r.short_words ? el("p", { class: "x", text: `Short by ${r.short_words}.` }) : null,
      el("p", { class: "to", text: `Send to this ${coin === "NOID" ? "Parano1d" : "Ethereum"} address` }),
      el("div", { class: "bd-addr-row" }, addrBox(r.address), copyBtn(r.address, `the ${coin} deposit address`))
    );
  }

  function depositSection(ctx, at) {
    const B = BV();
    const d = ctx.deposit;
    const b = ctx.board;
    const kids = [];
    if (b.step !== "deposit") {
      const text = b.step === "waiting_accept" ? B.readyWords("accept") : B.readyWords(b.waiting_for);
      return el("section", { class: "bd-strip wait", "aria-labelledby": "bd-dep-h" }, el("div", { class: "bd-cell" }, el("p", { class: "state" }, icon("run"), "Getting ready"), el("h2", { class: "big", id: "bd-dep-h", text: "The app is getting the swap ready" }), el("p", { class: "by", text: text }), el("p", { class: "bd-hint", text: "Your deposit address appears here when the swap is ready. Nothing is locked yet. If the other side does not go on, nothing happens and you lose nothing." })));
    }
    const win = windowLeft(ctx);
    kids.push(el("p", { class: "state due" }, icon("clock"), at === 2 ? "Step 2: your step, due now" : "Step 2: done"));
    kids.push(el("h2", { class: "big", id: "bd-dep-h", text: "Send your deposit" }));
    kids.push(el("p", { class: "by", text: "Send the amounts below from a wallet you control." }));
    if (d.state === "ok" && d.rows.length) kids.push(el("ul", { class: "bd-deplist", "aria-label": "Deposits" }, d.rows.map((r, i) => depositRowEl(ctx, r, i + 1, d.rows.length))));
    else if (d.state === "unclean") kids.push(el("p", { class: "bd-msg danger", role: "alert", text: d.clean ? "The last reading is not about this swap's own addresses, so no address is shown. Do not deposit anywhere." : `The last reading was not clean, so no address is shown. Do not deposit anywhere until a clean reading is made.` }));
    else kids.push(el("p", { class: "bd-msg quiet", role: "status", text: d.state === "noswap" ? "The deposit address is shown once the swap's wallet exists and the app has checked that its own key opens it." : "The app has not read your deposit yet. No address is shown before it has. It reads about every 40 seconds." }));
    if (d.state === "ok" && d.rows.length) kids.push(el("p", { class: "bd-hint", text: `Read ${typeof d.age_s === "number" ? d.age_s + " s ago" : "just now"}.` }));
    kids.push(el("div", { class: "bd-late" }, el("p", {}, el("b", { text: "Nothing is locked yet." }), " A deposit that arrives after the window is not used: when the swap ends, the app sends it back to your own address, less a small network fee."), el("p", { text: "Sending from an exchange? A withdrawal can take longer than the window. Send from a wallet you control." })));
    const clock = el(
      "div",
      { class: "bd-cell timecell" },
      el("p", { class: "fg-n", text: "Time left to send both" }),
      win && win.blocks > 0 ? el("p", { class: "bd-fig", role: "timer", "aria-label": `About ${H.fmtDur ? H.fmtDur(win.seconds) : Math.round(win.seconds / 60) + " minutes"} left to deposit` }, `about ${(H.fmtDur || ((x) => Math.round(x / 60) + " min"))(win.seconds)}`) : win ? el("p", { class: "bd-fig", text: "closed" }) : el("p", { class: "bd-fig quiet", text: "not known yet" }),
      el("p", { class: "cap", text: win ? (win.blocks > 0 ? `${win.blocks} blocks, at about 30 seconds a block. An estimate from the block count; blocks can come faster or slower.` : "The window for the deposit has passed. The app does not start the swap. When it ends the swap it sends your deposits back to your own addresses.") : "The app shows the time left once it has read the latest Parano1d block and the swap's start height." })
    );
    return el("section", { class: "bd-strip due", "aria-labelledby": "bd-dep-h" }, el("div", { class: "bd-cell" }, kids), clock);
  }

  function approvalSection(ctx, at) {
    const B = BV();
    const a = ctx.approval;
    const terms = ctx.terms;
    const head = el("div", { class: "bd-cell" }, el("p", { class: "state" }, icon("clock"), at === 3 ? "Step 3: your step, now" : "Step 3: comes after the deposit"), el("h2", { id: "bd-appr-h", text: "Give the one approval" }), el("p", { class: "say", text: `After this the app does every step by itself: it locks your coins, watches the other side, completes the swap and sends the result to your address. It takes about ${B.USUAL_MINUTES} minutes. You are not asked again.` }), el("p", { class: "say", text: "Keep this app open and the computer on until the swap is over. If anything goes wrong your coins come back by themselves once the app is running." }));
    if (!a.available) return el("section", { class: "bd-appr", "aria-labelledby": "bd-appr-h" }, head, el("div", { class: "bd-cell" }, el("p", { class: "bd-msg quiet", text: a.why })));
    const typed = el("input", { id: "bd-typed", type: "text", inputmode: "decimal", autocomplete: "off", spellcheck: "false", "aria-describedby": "bd-typed-h", placeholder: a.amount || "", value: ui.ap.typed });
    const ticks = [...a.statements, a.payout_tick].map((st) => {
      const cb = el("input", { type: "checkbox", id: `bd-tick-${st.id}`, checked: ui.ap.ticks[st.id] ? true : null });
      cb.addEventListener("change", () => {
        ui.ap.ticks[st.id] = !!cb.checked;
        refresh();
      });
      return { st, cb, label: el("label", { for: `bd-tick-${st.id}` }, cb, el("span", { text: st.text })) };
    });
    const why = el("p", { id: "bd-why-off", class: "bd-hint" });
    const go = el("button", { type: "submit", class: "bd-go", disabled: true, "aria-describedby": "bd-why-off" }, "Run this swap for me");
    const typedValue = () => `${String(typed.value || "").trim()} ${a.unit || ""}`.trim();
    const refresh = () => {
      let reason = a.why;
      if (!reason && !B.typedOk(typedValue(), a.expected)) reason = "Type the amount you are giving, exactly as in the terms above.";
      if (!reason && !ticks.every((t) => t.cb.checked)) reason = "Mark all the boxes.";
      go.disabled = !!reason || ui.busy;
      why.textContent = reason || "";
    };
    typed.addEventListener("input", () => {
      ui.ap.typed = typed.value;
      refresh();
    });
    const form = el(
      "form",
      { class: "bd-cell", novalidate: true, "aria-label": "Approval" },
      el("div", { class: "bd-field" }, el("label", { for: "bd-typed", text: "Type the amount you are giving" }), el("div", { class: "bd-amt-in" }, typed, el("span", { class: "u " + (a.unit === "NOID" ? "c-noid" : "c-eth"), text: a.unit || "" })), el("p", { class: "bd-hint", id: "bd-typed-h", text: "It must match the terms above. This is so nothing is approved by accident." })),
      el("fieldset", { class: "bd-ticks" }, el("legend", { text: "Mark all the boxes" }), ticks.map((t) => t.label)),
      a.terms_changed ? el("p", { class: "bd-msg danger", role: "alert", text: "The terms changed since you approved, so the approval no longer holds. Check the terms, then approve again if they are right." }) : null,
      msgLine(),
      el("div", { class: "bd-runrow" }, go, why)
    );
    form.addEventListener("submit", async (ev) => {
      if (ev && ev.preventDefault) ev.preventDefault();
      refresh();
      if (go.disabled || ui.busy) return;
      const statements = {};
      for (const s of a.statements) statements[s.id] = true;
      ui.busy = true;
      ui.msg = null;
      const res = await post("/api/autopilot", { on: true, role: ctx.role, typed: typedValue(), statements });
      ui.busy = false;
      if (!res.ok) ui.msg = { kind: "danger", text: errorText(res) };
      else ui.ap = { typed: "", ticks: {} };
      await refreshAll();
    });
    refresh();
    return el("section", { class: "bd-appr", "aria-labelledby": "bd-appr-h" }, head, form);
  }

  function takeScreen(ctx) {
    const terms = ctx.terms;
    const at = ctx.board.step === "deposit" ? (ctx.deposit.state === "ok" && ctx.deposit.all_seen ? 3 : 2) : 2;
    const title = terms ? ["Your swap: give ", amt(terms.give.coin, terms.give.words), ", get ", amt(terms.get.coin, terms.get.words)] : "Your swap";
    const kids = [el("div", { class: "bd-lead one" }, el("h1", {}, title), el("p", { class: "sub", text: "Check the terms, send your deposit, give one approval. After that the app does the rest by itself." })), stepsStrip(ctx, at)];
    if (terms) kids.push(termsSection(ctx, terms));
    kids.push(depositSection(ctx, at));
    kids.push(approvalSection(ctx, at));
    kids.push(el("p", { class: "bd-foot", text: "Test network only. Nothing on this page sends anything by itself: the deposit comes from your own wallet, and the app sends only after your approval." }));
    return el("section", { "aria-label": "Your swap", class: "bd-screen" }, kids);
  }

  // ------------------------------------------------------------------ screen 4: progress
  const TRACK_WORDS = { none: "not locked yet", sent: "sent, not confirmed yet", pending: "placed, not settled yet", final: "settled", secret_public: "open to be taken at any moment", closing: "being closed, not final yet", closed: "closed" };

  function needsBox(ctx) {
    const items = ctx.needs;
    if (!items.length) return null;
    return el(
      "div",
      { class: "bd-need", role: "alert", "aria-label": "Needs you" },
      el("div", { class: "bd-cell" }, el("p", { class: "state alarm" }, icon("alert"), "Needs you"), items.map((n) => el("div", { class: "bd-need-item" }, el("h2", { text: n.title }), el("p", { text: n.text }), n.tool_words ? el("details", {}, el("summary", { text: "The tool's own words" }), el("p", { class: "tool", text: n.tool_words })) : null))),
      el("div", { class: "bd-cell act" }, el("p", { class: "fg-n", text: "Your coins are safe: the swap's own rules bring them back if it cannot finish." }), el("button", { type: "button", class: "bd-go", onclick: () => {
        ui.details = true;
        redraw();
      } }, "Open details"))
    );
  }

  function railEl(ctx) {
    const rail = ctx.rail;
    if (!rail) return el("div", { class: "bd-unknown" }, el("p", { class: "state" }, icon("clock"), "The app is checking"), el("p", { text: "The app is checking where your swap is. Nothing is needed from you unless it says so here. Details shows the tool's own words." }));
    return el("ol", { class: "bd-rail" }, rail.map((s) => el("li", { class: s.state }, el("span", { class: "mk", "aria-hidden": "true" }, s.state === "done" ? icon("check") : s.state === "now" ? el("i") : null), el("div", {}, el("h3", {}, s.state === "done" ? el("span", { class: "bd-sr", text: "Done: " }) : s.state === "todo" ? el("span", { class: "bd-sr", text: "Next: " }) : null, s.title, s.state === "now" ? el("span", { class: "tag", text: "Now" }) : null), s.state === "skipped" ? null : el("p", { text: s.sub })))));
  }

  function lanesEl(ctx) {
    const pic = ctx.view && ctx.view.picture;
    if (!pic || !Array.isArray(pic.tracks)) return null;
    const alice = ctx.role === "alice";
    const lane = (t) => {
      const mineLane = (t.chain === "noid") === alice;
      const coin = t.chain === "noid" ? "NOID" : "ETH";
      const amount = ctx.terms ? (t.chain === "noid" ? ctx.terms[alice ? "give" : "get"].words : ctx.terms[alice ? "get" : "give"].words) : coin;
      const owner = mineLane ? "Your" : "Their";
      const state = TRACK_WORDS[t.state] || "unknown";
      const end = typeof t.end_s === "number" && t.end_s > 0 ? ` If the swap stopped, they would go back ${mineLane ? "to you" : "to them"} at about ${hm(ctx.now + t.end_s)}.` : "";
      return el("div", { class: "bd-lane " + (t.chain === "noid" ? "n" : "e") }, el("p", { class: "nm", text: `${owner} ${amount} on ${t.chain === "noid" ? "Parano1d" : "Ethereum"}` }), el("p", { class: "ln", text: `${state.charAt(0).toUpperCase()}${state.slice(1)}.${end}` }));
    };
    return el("section", { class: "bd-pic", "aria-labelledby": "bd-pic-h" }, el("h2", { id: "bd-pic-h", text: "The two locks" }), pic.tracks.map(lane), el("p", { class: "bd-hint", text: "You do not have to watch this. The app does. The times come from the network's own block count and clock and are estimates." }));
  }

  function progressScreen(ctx) {
    const B = BV();
    const t = ctx.time;
    const terms = ctx.terms;
    const titleBy = terms ? [amt(terms.give.coin, terms.give.words), " for ", amt(terms.get.coin, terms.get.words), t.started_at ? ["; approved at ", mono(hm(t.started_at)), "."] : "."] : "";
    const lead = el(
      "section",
      { class: "bd-strip wait three", "aria-labelledby": "bd-run-h" },
      el("div", { class: "bd-cell" }, el("p", { class: "state" }, icon("run"), ctx.needs.length ? "Paused" : "Running by itself"), el("h1", { id: "bd-run-h", text: ctx.needs.length ? "Your swap needs you" : "Your swap is running" }), el("p", { class: "by" }, ctx.needs.length ? "The app is waiting for you. " : "You do not need to do anything. ", titleBy)),
      el("div", { class: "bd-cell est" }, t.elapsed_min !== null ? [el("p", { class: "fg-n up", text: "Running for" }), el("p", { class: "bd-big", "aria-label": `${t.elapsed_min} minutes since you approved` }, String(t.elapsed_min), el("small", { text: "min" })), el("p", { class: "cap", text: `A normal swap takes about ${t.usual_min} minutes. The app cannot say how long is left: it waits for the two networks, which can add time.` })] : [el("p", { class: "fg-n up", text: "Time" }), el("p", { class: "bd-big quiet", text: "not known" }), el("p", { class: "cap", text: `A normal swap takes about ${t.usual_min} minutes. The app cannot say how long is left.` })]),
      el("div", { class: "bd-cell promise" }, el("p", { text: "Keep this app open and the computer on until the swap is over. If anything goes wrong your coins come back by themselves once the app is running." }), el("p", { text: "The app asks nothing more of you unless it says so here." }))
    );
    const kids = [];
    const nb = needsBox(ctx);
    if (nb) kids.push(nb);
    kids.push(lead);
    if (ctx.board.stopped && !ctx.needs.length) kids.push(el("p", { class: "bd-msg quiet", role: "note", text: `${B.stopWords(ctx.board.stopped)} The offer board has stopped. The swap itself goes on: the app brings your coins back by itself if it cannot finish.` }));
    if (t.lock_end) {
      kids.push(el("section", { class: "bd-limits", "aria-labelledby": "bd-end-h" }, el("h2", { id: "bd-end-h", text: "The swap's own end time" }), el("div", { class: "bd-limit one" }, el("div", {}, el("p", { class: "v", text: `${t.lock_end.approx ? "about " : ""}${hm(t.lock_end.at)}` }), el("p", { class: "k", text: `If the swap stopped, your ${t.lock_end.coin} would come back to you at this time or soon after (in ${t.lock_end.approx ? "about " : ""}${H.fmtDur ? H.fmtDur(t.lock_end.seconds_left) : Math.round(t.lock_end.seconds_left / 60) + " min"}). It is not an estimate of when the swap ends.` })))));
    }
    const left = el("section", { "aria-labelledby": "bd-steps-h2" }, el("h2", { id: "bd-steps-h2", text: "Where the swap is" }), railEl(ctx));
    const right = lanesEl(ctx);
    kids.push(el("div", { class: "bd-cols" }, left, right));
    const words = [ctx.apDoing, ctx.apWaiting].filter(Boolean);
    if (words.length) kids.push(el("details", { class: "bd-fold" }, el("summary", { text: "What the app says it is doing, in the tool's own words" }), words.map((w) => el("p", { class: "tool", text: w }))));
    kids.push(el("p", { class: "bd-foot", text: "Test network only. This page changes by itself as the swap moves; there is nothing to press." }));
    return el("section", { "aria-label": "Swap in progress", class: "bd-screen" }, kids);
  }

  // ------------------------------------------------------------------ screen 5: done, refunded, stopped
  function endScreen(ctx, kind) {
    const B = BV();
    // "the other side did not lock" is said only when the tick says what Ethereum showed (a read of the Ethereum side exists) and it shows no lock
    const ethKnown = !!(ctx.view && Array.isArray(ctx.view.receipts) && ctx.view.header && ctx.view.header.eth && ctx.view.header.eth.block !== null && ctx.view.header.eth.block !== undefined);
    const f = B.endFacts({ kind, role: ctx.role, terms: ctx.terms, wallet: ctx.payload.actions && ctx.payload.actions.wallet, receipts: ctx.view && ctx.view.receipts, approvedAt: ctx.ap && ctx.ap.approved_at, board: ctx.board, coins: ctx.view && ctx.view.coins_at_contract && ctx.view.coins_at_contract.known ? ctx.view.coins_at_contract : null, ethLockSeen: ethKnown ? ctx.view.receipts.some((r) => r.group === "Ethereum" && r.label === "Lock id") : null });
    const done = kind === "done";
    const stateIcon = done ? "check" : kind === "refunded" ? "return" : kind === "board_stopped" ? "stop" : "alert";
    const title = f.title;
    const h = el("h1", {}, title.coin && title.words ? [title.lead + " ", amt(title.coin, title.words), title.tail || ""] : title.lead);
    const left = el("div", { class: "bd-cell" }, el("p", { class: "state" + (done ? " safe" : "") }, icon(stateIcon), f.state), h, el("p", { class: "by", text: f.by }), f.approved_at ? el("p", { class: "bd-hint" }, "Approved at ", mono(hm(f.approved_at)), ".") : null, f.next ? el("p", { class: "next", text: f.next }) : null, el("div", { class: "acts" }, el("button", { type: "button", class: "bd-btn", onclick: () => {
      ui.tab = "offers";
      ui.msg = null;
      redraw();
    } }, "Back to offers")));
    const facts = el("dl", { class: "bd-kv facts" }, f.facts.map((x) => el("div", {}, el("dt", { text: x.label }), el("dd", {}, x.coin ? amt(x.coin, x.text || "") : x.text || ""))));
    const rec = f.records.length ? el("dl", { class: "bd-kv facts rule3" }, el("div", {}, el("dt", { text: "Records, to look up yourself" }), f.records.map((r) => el("dd", {}, el("span", { class: "lbl", text: r.label }), el("span", { class: "rec mono", text: r.value }))))) : null;
    const right = el("div", { class: "bd-cell facts" }, facts, rec);
    return el("section", { "aria-label": "How the swap ended", class: "bd-screen" }, el("div", { class: "bd-res " + (done ? "done" : "") }, left, right), el("p", { class: "bd-foot", text: `Test network only. ${f.note}` }));
  }

  // ------------------------------------------------------------------ choosing and drawing
  function makeCtx(payload, view) {
    const B = BV();
    const board = payload.board;
    const role = board.role === "alice" || board.role === "bob" ? board.role : "alice";
    const ap = payload.actions && payload.actions.autopilot ? payload.actions.autopilot[role] || null : null;
    const now = H.nowS();
    const offer = B.boardOffer(board);
    const offers = B.offerList(board, role);
    const terms = offer ? B.termRows(offer, board.payouts, role) : null;
    const deposit = B.depositRows(payload, role);
    const approval = B.approvalFacts(payload, role, deposit, !!H.state.token, terms);
    const needs = B.needsYou({ ap, board, blind: !!(view && view.status === "stale") });
    const phaseId = view && view.phase ? view.phase.id : null;
    const chain = (terms && terms.chain_id) || (offers[0] && offers[0].chain_id) || null;
    const startWhy = { has_swap: "This app carries one swap at a time. To make another, start the app again on a fresh run folder.", board_closed: "The board is closed: it needs an invite, or the settings must allow a public board.", run_not_fresh: "This run folder already has swap files or settings. A new swap needs a fresh run folder.", not_running: "The board is not running." }[board.start_blocked] || null;
    const takeWhy = !H.state.token ? KEY_LOST : !board.can_start ? startWhy || "This app cannot start a new swap now." : null;
    return {
      payload,
      view,
      board,
      role,
      ap,
      now,
      offers,
      terms,
      deposit,
      approval,
      needs,
      hasSwap: board.state !== "no_offer" && !!board.offer,
      phaseId,
      rail: phaseId ? B.rail(role, phaseId, offer) : null,
      time: B.timeFacts({ approvedAt: ap && ap.approved_at, rows: view && view.deadlines, role, now }),
      network: B.chainName(chain === null ? 11155111 : chain),
      tip: view && view.header && view.header.noid && Number.isSafeInteger(view.header.noid.tip) ? view.header.noid.tip : null,
      startWhy,
      takeWhy,
      apDoing: ap && ap.on ? ap.doing || null : null,
      apWaiting: ap && ap.on && ap.waiting_reason ? `Waiting for: ${ap.waiting_reason}` : null,
    };
  }

  function chooseScreen(ctx) {
    const B = BV();
    const sc = B.screenOf({ board: ctx.board, role: ctx.role, phase_id: ctx.phaseId, finished: !!(ctx.view && ctx.view.finished), ap: ctx.ap, tab: ui.tab });
    return sc;
  }

  function renderInto(payload, view) {
    const root = typeof document !== "undefined" ? document.getElementById("bd-root") : null;
    const opv = typeof document !== "undefined" ? document.getElementById("op-view") : null;
    const skip = typeof document !== "undefined" ? document.getElementById("skip-link") : null;
    const b = payload && payload.board;
    if (!root || !b || b.enabled !== true) {
      if (root) {
        root.hidden = true;
        while (root.firstChild) root.removeChild(root.firstChild);
      }
      if (opv) opv.hidden = false;
      if (skip) skip.setAttribute("href", "#next-action");
      return false;
    }
    ui.last = { payload, view };
    const ctx = makeCtx(payload, view);
    const sc = chooseScreen(ctx);
    let body;
    let screen = sc.screen;
    if (screen === "offers") {
      const taking = ui.taking ? ctx.offers.find((o) => o.id === ui.taking) || null : null;
      body = ui.taking ? reviewScreen(ctx, taking) : offersScreen(ctx);
    } else if (screen === "waiting") body = waitingScreen(ctx);
    else if (screen === "take") body = takeScreen(ctx);
    else if (screen === "progress") body = progressScreen(ctx);
    else if (screen === "end") body = endScreen(ctx, sc.kind);
    else body = offersScreen(ctx);
    const frameEl = frame(ctx, screen === "offers" ? "offers" : screen, body);
    while (root.firstChild) root.removeChild(root.firstChild);
    root.appendChild(frameEl);
    root.hidden = false;
    if (opv) opv.hidden = !ui.details;
    if (skip) skip.setAttribute("href", "#bd-root");
    // keyboard users: a new screen (or the review of an offer) moves the focus to its heading, the post form to its first field; a redraw of the same screen leaves the focus alone
    if (typeof document !== "undefined") {
      const key = screen + (ui.taking ? ":review" : "") + (ui.posting ? ":post" : "");
      const act = document.activeElement;
      let target = null;
      if (ui.focus) {
        target = document.getElementById(ui.focus);
        ui.focus = null;
      } else if (key !== ui.shown && (!act || act === document.body || (typeof root.contains === "function" && root.contains(act)))) target = typeof root.querySelector === "function" ? root.querySelector("h1") : null;
      ui.shown = key;
      if (target && typeof target.focus === "function") {
        if (target.tagName === "H1") target.setAttribute("tabindex", "-1");
        target.focus();
      }
    }
    ui.title = `${{ offers: "Offers", waiting: "Your offer", take: "Your swap", progress: "Swap in progress", end: "How the swap ended" }[screen] || "Offers"}, No1d Swap`;
    if (typeof document !== "undefined") document.title = ui.title;
    return true;
  }

  /** Once a second: the "still open" minutes of the offers (nothing else is rebuilt, so focus and text selection are left alone). */
  function tick() {
    if (typeof document === "undefined" || !document.querySelectorAll || !BV()) return;
    const now = H.nowS();
    for (const n of document.querySelectorAll("[data-expires]")) {
      const at = Number(n.getAttribute("data-expires"));
      if (Number.isSafeInteger(at)) n.textContent = openFor({ expires_at: at }, now);
    }
  }

  window.NoidBoard = {
    init(helpers) {
      H = helpers;
    },
    /** Draws the board's screens (or hides them when the console has no board). Returns true when they are shown. */
    render: renderInto,
    tick,
    title: () => ui.title || "No1d Swap",
    // for the tests: the builders and the page's own state
    screens: { offersScreen, reviewScreen, waitingScreen, takeScreen, progressScreen, endScreen, makeCtx, chooseScreen, frame },
    ui,
    reset() {
      Object.assign(ui, { tab: "auto", posting: false, taking: null, form: { noid: "", eth: "" }, ap: { typed: "", ticks: {} }, msg: null, details: false, busy: false, last: null, live: "", title: "", focus: null, shown: null });
    },
  };
})();
