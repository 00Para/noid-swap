/* noid-swap operator console, program mode: the top bar, the list of swaps, the new-swap form and the settings screen.
   Pure builders (data and handlers in, element trees out); operator.js mounts them. The only requests made here are the ones of the program API
   (POST /api/newswap, POST /api/settings, POST /api/program/open, POST /api/board/slot, GET /api/settings, GET /api/program), each with the per-start token.
   No secret ever passes through this file: the recovery code, the restore input, a passphrase, a key and the board invite are shown and typed only in a window of the
   program itself. A menu item here only asks the program to open that window (POST /api/program/open {what}); nothing secret comes back and nothing is typed here.
   No inline styles or handlers (CSP). */
(() => {
  "use strict";
  let H = null; // { el, chip, state, phaseLabel }
  const KEY_LOST_PROGRAM = "This page lost its key (a reload drops it). Close this window and open the program again.";

  // ------------------------------------------------------------------ fixed words
  const ROLE_WORDS = { alice: "You sell NOID", bob: "You sell ETH" };
  const roleWords = (role) => ROLE_WORDS[role] || "Role not known";

  // I4: the node status is states and numbers only; the page shows a fixed phrase per state and never a URL, a host or an error text
  const NOID_WORDS = { ok: "connected", not_running: "not running: start the Parano1d wallet app", wrong_chain: "not the expected chain", behind: "behind: still catching up", error: "cannot be checked" };
  const ETH_WORDS = { ok: "connected", idle: "not checked", unreachable: "not reachable", wrong_chain: "not the expected network", behind: "behind: still catching up", error: "cannot be checked" };
  const LEVEL = { ok: "ok", idle: "quiet", behind: "attn", error: "attn", not_running: "danger", unreachable: "danger", wrong_chain: "danger" };

  /** `{ noid: {word, level}, eth: {word, level} }` from a NodeStatus; anything not in the fixed tables reads as "cannot be checked". */
  function nodeWords(node) {
    const one = (obj, words) => {
      const st = obj && typeof obj.state === "string" && Object.prototype.hasOwnProperty.call(words, obj.state) ? obj.state : "error";
      const out = { state: st, word: words[st], level: LEVEL[st] || "attn" };
      // the Parano1d chain identity is checked against a pinned block once the program has one; until then it says so
      if (words === NOID_WORDS && st === "ok" && obj && obj.chain_checked === false) out.word += " (the chain is not verified yet)";
      return out;
    };
    // `eth.production` is the mainnet endpoints' own state: { state: "idle" } while no mainnet swap or form asks for them (drawn quietly, never as an error)
    const prod = node && node.eth && node.eth.production && typeof node.eth.production === "object" ? one(node.eth.production, ETH_WORDS) : null;
    return { noid: one(node && node.noid, NOID_WORDS), eth: one(node && node.eth, ETH_WORDS), mainnet: prod };
  }

  const UPDATE_WORDS = { not_configured: "Update check: not set up in this version", off: "Update check: off", none: "You have the newest version", current: "You have the newest version", available: "A new version is available", checking: "Checking for a new version", error: "The update check did not work", unknown: "Not checked yet", ask: "Not checked yet", newer: "A new version is available", never: "Not checked yet", skipped_active: "Not checked: a swap was active", unverified: "A newer release is listed but its signature does not check: do not install it.", release_check_not_configured: "This version cannot check for updates." };
  function updateWords(update) {
    const st = update && typeof update.state === "string" && Object.prototype.hasOwnProperty.call(UPDATE_WORDS, update.state) ? update.state : "unknown";
    const latest = update && typeof update.latest === "string" && /^[0-9A-Za-z.+-]{1,32}$/.test(update.latest) ? update.latest : null;
    const url = update && typeof update.url === "string" && /^https:\/\/[A-Za-z0-9\-._~:/?#@!$&'()*+,;=%]{1,200}$/.test(update.url) ? update.url : null;
    // the program's checker says "newer" (desktop/lib/updatecheck.js); "available" is the same
    const isNew = st === "available" || st === "newer";
    return { state: st, text: UPDATE_WORDS[st] + (isNew && latest ? `: ${latest}` : "") + (isNew ? ". Compare the installer's SHA-256 with the signed value in the menu's update check before installing." : ""), url: isNew ? url : null };
  }

  /** The chip of one node in words (the top bar and the first-start guide draw the same one). */
  const nodeChip = (name, w) => w.state === "idle" ? H.chip("idle", name === "Ethereum" ? "Mainnet: not checked" : `${name}: not checked`) : H.chip(w.level === "ok" ? "ok" : w.level === "danger" ? "danger" : "attn", `${name}: ${w.word}`);
  /**
   * The top bar's chip of one node: the same words, in two parts. While the node is fine (connected) or not asked for (not checked), only its name is drawn beside the
   * dot and the state stays for a screen reader and in the title; a node that needs a look keeps its words in sight. The bar then fits one row with four chips.
   */
  const barChip = (name, w) => {
    const idle = w.state === "idle";
    const level = idle ? "idle" : w.level === "ok" ? "ok" : w.level === "danger" ? "danger" : "attn";
    const label = idle && name === "Ethereum" ? "Mainnet" : name;
    const word = idle ? "not checked" : w.word;
    const calm = level === "ok" || level === "idle";
    // the name is the chip's own text and the state one span after it, so the chip's text is exactly "Name: state" (no space before the colon)
    return H.el("span", { class: `chip ${level} node-chip`, title: `${label}: ${word}`, text: label }, H.el("span", { class: calm ? "node-state sr-only" : "node-state", text: `: ${word}` }));
  };

  const activeCount = (swaps) => (Array.isArray(swaps) ? swaps.filter((s) => s && s.active === true).length : 0);

  /** The vault facts the page shows as banners (from /api/program only). */
  function vaultNotes(prog) {
    const v = (prog && prog.vault) || {};
    return { not_ready: v.ready !== true, unconfirmed: v.ready === true && v.recovery_confirmed !== true };
  }

  /** The list's order: swaps that need you first, then active ones, then newest first. */
  function sortSwaps(swaps) {
    return (Array.isArray(swaps) ? swaps.slice() : []).sort((a, b) => (b.needs_you === true) - (a.needs_you === true) || (b.active === true) - (a.active === true) || (Number(b.created_at) || 0) - (Number(a.created_at) || 0));
  }

  /** What changes the top bar or the list, without the ages that change at every read. */
  function signature(prog) {
    if (!prog) return "none";
    const node = prog.node ? { noid: { ...prog.node.noid, checked_at: 0 }, eth: { ...prog.node.eth, checked_at: 0 } } : null;
    return JSON.stringify({ v: prog.version, n: prog.network, node, vault: prog.vault, ns: prog.new_swap_allowed, swaps: prog.swaps, board: prog.board, update: prog.update, token: !!(H && H.state.token), lim: limitsOpen, prod: prog.form && prog.form.profiles && prog.form.profiles.production ? [prog.form.profiles.production.max_noid, prog.form.profiles.production.max_eth] : null }, (k, v) => (k === "age_s" || k === "base_fee_age_s" ? undefined : v));
  }

  // the "Limits and risks" screen is a state of the list screen: the page's screen switch (operator.js) knows "list", "new", "settings" and "swap", so the menu item sets this flag and asks for the list
  let limitsOpen = false;

  // ------------------------------------------------------------------ transport
  async function request(method, path, body) {
    const init = { method, cache: "no-store", headers: { "x-swap-token": H.state.token || "", ...(body !== undefined ? { "content-type": "application/json" } : {}) } };
    if (body !== undefined) init.body = JSON.stringify(body);
    const r = await fetch(path, init);
    const j = await r.json().catch(() => ({ error: `HTTP ${r.status}` }));
    return { ok: r.ok, status: r.status, json: j };
  }
  const errorText = (r) => (r.json && typeof r.json.error === "string" && r.json.error) || `HTTP ${r.status}`;

  // ------------------------------------------------------------------ the top bar
  /** What a menu item asks the program to open: its own window (never this page). */
  const OPEN_ITEMS = [
    ["recovery-code", "Recovery code"],
    ["restore", "Restore from a recovery code"],
    ["import", "Import a run folder"],
    ["invite", "Board invite"],
    ["help", "Help"],
  ];

  /**
   * The bar over every screen: the mark, "Your swaps" with the number of active ones, the network in words, the two node states in words and the menu. No Alice/Bob switch:
   * each swap has its own role. `h`: { go(screen), open(what), refresh() }.
   */
  function topBar(prog, ui, h) {
    const el = H.el;
    const nodes = nodeWords(prog && prog.node);
    const n = activeCount(prog && prog.swaps);
    // R6: Ethereum mainnet is a mode, not a danger: an inverted tag with words, so the difference never rests on colour alone. The NOID is real on every network, so a test network says it is the Ethereum side that is a test.
    const net = prog && prog.network === "mainnet" ? el("span", { class: "tag real", text: "Ethereum mainnet: real funds" }) : prog && prog.network === "test" ? H.chip("quiet", "Ethereum test network") : H.chip("danger", "Network not recognised");
    if (ui && ui.screen && ui.screen !== "list") limitsOpen = false;
    // every way out of the limits screen but its own menu item: the flag is cleared, then the screen is asked for
    const goTo = (screen) => {
      limitsOpen = false;
      return h.go(screen);
    };
    const ic = (name) => (H.icon ? H.icon(name) : null);
    const summary = el("summary", { class: "btn ghost sm", "aria-label": "Menu" }, ic("menu"), el("span", { text: "Menu" }));
    const menu = el("details", { class: "pg-menu" }, summary);
    // Escape closes the menu and gives focus back to its button (a details element does not do that by itself)
    menu.addEventListener("keydown", (ev) => {
      if (ev && ev.key === "Escape" && menu.open) {
        menu.removeAttribute("open");
        if (summary.focus) summary.focus();
      }
    });
    const list = el("ul", { class: "pg-menu-list" });
    const item = (label, fn) => list.appendChild(el("li", {}, el("button", { type: "button", class: "btn sm", onclick: async () => { menu.removeAttribute("open"); await fn(); } }, label)));
    item("Settings", () => goTo("settings"));
    item("Limits and risks", () => {
      limitsOpen = true;
      return h.go("list");
    });
    for (const [what, label] of OPEN_ITEMS) item(label, () => h.open(what));
    // the program runs the check and answers in its own dialog; the line below the menu shows the result at the next read
    item("Check for a new version", async () => {
      await h.open("update-check");
      await h.refresh();
    });
    const up = updateWords(prog && prog.update);
    menu.appendChild(el("div", { class: "pg-menu-pop" }, list, el("p", { class: "pg-update dim" }, up.text, up.url ? el("span", {}, " ", H.copyButton ? H.copyButton(up.url, "the download address", "Copy the download address") : null) : null)));
    return el(
      "div",
      { class: "wrap pg-bar-in" },
      el("div", { class: "pg-brand" }, el("img", { class: "mark", src: "/mark.svg", alt: "", width: 22, height: 22 }), el("span", { class: "wordmark", "aria-label": "No1d Swap" }, "No1d", el("i", { class: "dia", "aria-hidden": "true" }), "Swap")),
      el("button", { type: "button", class: "pg-swaps-btn", "aria-current": ui && ui.screen === "list" && !limitsOpen ? "page" : null, onclick: () => goTo("list") }, el("span", { class: "lbl", text: "Your swaps" }), el("span", { class: "pg-count", text: n === 1 ? "1 active" : `${n} active` })),
      el("div", { class: "pg-status", "aria-label": "Network and nodes" }, net, barChip("Parano1d", nodes.noid), barChip("Ethereum", nodes.eth), nodes.mainnet ? barChip("Mainnet", nodes.mainnet) : null),
      el("div", { class: "pg-tools" }, el("button", { type: "button", class: "btn ghost icon", "aria-label": "Refresh", onclick: () => h.refresh() }, ic("refresh"), el("span", { class: "sr-only", text: "Refresh" })), menu)
    );
  }

  // ------------------------------------------------------------------ the list of swaps
  function phaseWord(role, phase) {
    if (!phase) return "not started";
    return H.phaseLabel ? H.phaseLabel(role, phase) : String(phase);
  }

  const ic = (name, extra) => (H.icon ? H.icon(name, extra) : null);
  const glyph = (coin) => (H.coinGlyph ? H.coinGlyph(coin, "sm") : null);
  /** One half of the pair of a row: the coin glyph's partner, the figure in mono and the ticker in the coin's colour. `half` is { text, coin } from the summary; anything else is not drawn. */
  const validHalf = (x) => !!(x && typeof x === "object" && (x.coin === "noid" || x.coin === "eth") && typeof x.text === "string" && /^[0-9][0-9.]{0,38}$/.test(x.text));
  const amountOf = (half) => H.el("span", { class: `amt ${half.coin}` }, H.el("span", { class: "num", text: half.text }), H.el("span", { class: "tic", text: half.coin === "noid" ? "NOID" : "ETH" }));
  // a swap that ended but still needs the person (a sweep that stopped) is not under the "Ended" divider: it stays with the swaps that need attention
  const isEnded = (s) => !s.active && !!s.phase && !s.needs_you;

  function swapRow(s, h) {
    const el = H.el;
    const chips = [];
    if (s.network === "mainnet") chips.push(el("span", { class: "tag real", text: "Mainnet" }));
    if (s.needs_you) chips.push(H.chip("accent", "Needs you"));
    if (s.in_contract) chips.push(H.chip("warn", "Coins are in the contract"));
    if (s.refused) chips.push(H.chip("warn", "Read only"));
    else if (isEnded(s)) chips.push(H.chip(s.phase === "done" ? "ok" : "quiet", "Ended"));
    // the label is also the swap's name for a screen reader: with the pair drawn (which is hidden from one) it stays as a word that only a screen reader sees
    const main = validHalf(s.give) && validHalf(s.get)
      ? el("span", { class: "pg-row-main" }, el("span", { class: "sr-only", text: s.label || "A swap" }), el("span", { class: "pg-pair", "aria-hidden": "true" }, glyph(s.give.coin), amountOf(s.give), ic("arrowR"), glyph(s.get.coin), amountOf(s.get)), el("span", { class: "pg-role", text: roleWords(s.role) }))
      : el("span", { class: "pg-row-main" }, el("strong", { class: "pg-label", text: s.label || "A swap" }), el("span", { class: "pg-role", text: roleWords(s.role) }));
    return el(
      "li",
      { class: "pg-swap" + (s.needs_you ? " needs" : "") + (isEnded(s) ? " ended" : "") },
      el(
        "button",
        { type: "button", class: "pg-row", onclick: () => h.openSwap(s.swap) },
        main,
        el("span", { class: "pg-row-state" }, s.refused ? null : el("span", { text: phaseWord(s.role, s.phase) }), s.until_text ? el("span", { class: "pg-until", text: s.until_text }) : null),
        el("span", { class: "pg-row-chips" }, ...chips),
        ic("chevR", "go"),
        s.refused ? el("span", { class: "pg-refused", text: `This folder is read only: ${s.refused}` }) : null
      )
    );
  }

  /** The things a swap needs from outside the program, shown while the list is empty. The Parano1d line carries the live node word of the top bar; there is no link on it. */
  function firstStartGuide(prog) {
    const el = H.el;
    const noid = nodeWords(prog && prog.node).noid;
    const li = (...kids) => el("li", {}, ...kids);
    return el(
      "section",
      { class: "pg-guide funding-guide", "aria-labelledby": "pg-h-guide" },
      el("div", { class: "card-head" }, el("h2", { id: "pg-h-guide", text: "Before your first swap" })),
      el("p", { class: "plain", text: "A swap needs a few things outside this program. Each computer needs them for itself." }),
      el(
        "ol",
        { id: "pg-guide-list" },
        li("The Parano1d wallet app is open on this computer and in sync. ", nodeChip("Parano1d", noid)),
        li("An Ethereum wallet and its address: on Sepolia (the test network) for a test swap, on Ethereum mainnet for a real one. The ETH you get, or what is left, goes there. Use your own wallet, not an exchange."),
        li("For a real swap on Ethereum mainnet: real ETH and real NOID, at most 0.5 ETH and 2,500 NOID per swap. Start small. For a test swap: Sepolia test ETH in that wallet. It has no value and is free from a Sepolia faucet; search for \"Sepolia faucet\", as they change often. If you sell NOID, a little is enough: it pays one fee."),
        li("If you sell NOID: the NOID to swap and a little more for the fee, in the Parano1d wallet app. If you sell ETH: the ETH to swap and a little more for two fees."),
        li("The amounts, agreed with the other person. The one who sells ETH makes the swap first and sends the other an invitation file."),
        li("About an hour with both computers on and awake.")
      )
    );
  }

  /** A safety box in the page's levels (danger, needs, warn, info): the icon, a short title and the words. `body` are the children of the text span. */
  function safetyBox(level, title, ...body) {
    return H.el("div", { class: `alarm ${level}`, role: level === "danger" ? "alert" : "note" }, ic("alert"), title ? H.el("span", { class: "lv", text: title }) : null, H.el("span", { class: "tx" }, ...body));
  }

  /**
   * R2: the signed "oldest safe version" notice, above the list. `update` is prog.update: { unsafe, note, note_unreadable, url }. Drawn only while `unsafe` is true. The note is signed text and goes in
   * as text only (textContent), never as markup. The release page is a copy button: the program's windows deny every navigation, so a link would do nothing.
   */
  function noticeBox(update) {
    if (!update || update.unsafe !== true) return null;
    const el = H.el;
    const note = typeof update.note === "string" && update.note ? update.note : null;
    const url = typeof update.url === "string" && /^https:\/\/[A-Za-z0-9\-._~:/?#@!$&'()*+,;=%]{1,200}$/.test(update.url) ? update.url : null;
    return safetyBox(
      "warn",
      "A security notice for this version",
      "The signed release notice says this version should not start new swaps: ",
      note ? el("span", { class: "more", dataset: { part: "note" }, text: `“${note}”` }) : el("span", { class: "more", dataset: { part: "note" }, text: "The notice's text cannot be shown." }),
      el("span", { class: "more", text: "Your running swaps go on as usual: every step, refund, recovery and sweep still works. Update the program to start a new swap." }),
      url ? el("span", { class: "more", dataset: { part: "release" } }, "Release page: ", H.copyButton ? H.copyButton(url, "the release page address", "Copy the release page address") : null) : null
    );
  }

  /** R6: the "Limits and risks" screen: the card of lib/limitstext.js on a screen of its own (menu, "Limits and risks"). */
  function limitsFacts(prog) {
    const p = prog && prog.form && prog.form.profiles && prog.form.profiles.production;
    return p ? { max_noid: p.max_noid, max_eth: p.max_eth } : {};
  }
  function limitsScreen(prog, h) {
    const el = H.el;
    const back = el("button", { type: "button", class: "btn sm", id: "pg-limits-back", onclick: () => { limitsOpen = false; return h.go("list"); } }, "Back to your swaps");
    const root = el("section", { class: "pg-form pg-limits", "aria-labelledby": "pg-h-limits" }, el("div", { class: "card-head" }, back));
    if (window.NoidLimits) root.appendChild(window.NoidLimits.card(el, limitsFacts(prog), { level: 1, headingId: "pg-h-limits" }));
    else root.appendChild(el("h1", { id: "pg-h-limits", text: "Limits and risks" }));
    // the page sets its own title right after the list is drawn: this runs after it
    Promise.resolve().then(() => {
      if (limitsOpen && typeof document !== "undefined") document.title = "Limits and risks, No1d Swap";
    });
    return root;
  }

  /** `h`: { openSwap(swapId), go(screen), openProgram(what), board(role), openBoard(slotId) }. */
  function swapList(prog, h) {
    const el = H.el;
    if (limitsOpen) return limitsScreen(prog, h);
    const swaps = sortSwaps(prog && prog.swaps);
    const ns = (prog && prog.new_swap_allowed) || { ok: false, why: "The program did not say." };
    const v = vaultNotes(prog);
    const noKey = !(H.state && H.state.token);
    const root = el("section", { class: "pg-list", "aria-labelledby": "pg-h-swaps" });
    root.appendChild(el("div", { class: "card-head" }, el("h1", { id: "pg-h-swaps", text: "Your swaps" }), el("div", { class: "right" }, el("button", { type: "button", class: "btn primary", id: "pg-new", disabled: ns.ok && !noKey ? null : true, onclick: () => h.go("new") }, ic("plus"), "New swap"))));
    if (noKey) root.appendChild(el("p", { class: "pg-why", id: "pg-new-why", text: KEY_LOST_PROGRAM }));
    else if (!ns.ok) root.appendChild(el("p", { class: "pg-why", id: "pg-new-why", text: ns.why || "A new swap cannot start now." }));
    const notice = noticeBox(prog && prog.update);
    if (notice) root.appendChild(notice);
    if (v.not_ready) root.appendChild(el("div", { class: "alarm danger big", role: "alert" }, ic("alert"), el("span", { class: "lv", text: "Key store" }), el("span", { class: "tx" }, "The program's key store is not open, so no swap can act. Restore from your recovery code, or close the program and open it again. ", el("button", { type: "button", class: "btn sm", onclick: () => h.openProgram("restore") }, "Restore from a recovery code"))));
    if (v.unconfirmed) root.appendChild(el("div", { class: "alarm needs big", role: "note" }, ic("alert"), el("span", { class: "lv", text: "Recovery code" }), el("span", { class: "tx" }, "Your recovery code is not confirmed yet. Without it a swap cannot be restored on another machine, so no new swap starts until you have written it down and typed it back. ", el("button", { type: "button", class: "btn primary due sm", onclick: () => h.openProgram("recovery-code") }, "Show my recovery code"))));
    if (!swaps.length) {
      root.appendChild(el("div", { class: "pg-empty" }, el("img", { class: "mark", src: "/mark.svg", alt: "", width: 44, height: 44 }), el("h2", { text: "No swaps yet" }), el("p", { text: "Make one with New swap, or use the offer board if it is on." })));
      root.appendChild(firstStartGuide(prog));
    } else {
      // the swaps that are over follow a one-line "Ended"; a swap the program cannot read (no phase) stays above it
      const ul = el("ul", { class: "pg-swaps", "aria-label": "Your swaps" });
      for (const s of swaps.filter((x) => !isEnded(x))) ul.appendChild(swapRow(s, h));
      const over = swaps.filter(isEnded);
      if (over.length) ul.appendChild(el("li", { class: "pg-group", text: "Ended" }));
      for (const s of over) ul.appendChild(swapRow(s, h));
      root.appendChild(ul);
    }
    const b = prog && prog.board;
    if (b && b.enabled === true) {
      const sec = el("section", { class: "pg-board", "aria-labelledby": "pg-h-board" }, el("div", { class: "card-head" }, el("h2", { id: "pg-h-board", text: "Offer board" })));
      sec.appendChild(el("p", { class: "plain", text: "Test offers only. The program holds one board swap at a time; other swaps are made with New swap and a file." }));
      if (typeof b.slot === "string" && b.slot) sec.appendChild(el("div", { class: "row" }, el("button", { type: "button", class: "btn", onclick: () => h.openBoard(b.slot) }, "Open the offer board")));
      else {
        const why = ns.ok ? null : ns.why;
        sec.appendChild(el("div", { class: "row" }, el("button", { type: "button", class: "btn", disabled: why ? true : null, onclick: () => h.board("alice") }, "Use the board: I sell NOID"), el("button", { type: "button", class: "btn", disabled: why ? true : null, onclick: () => h.board("bob") }, "Use the board: I sell ETH")));
        if (why) sec.appendChild(el("p", { class: "pg-why", text: why }));
      }
      root.appendChild(sec);
    }
    return root;
  }

  /** The list while the program has not answered yet: the heading, a New swap that cannot be pressed, and three rows in the shape of the real ones. */
  function loadingList() {
    const el = H.el;
    const root = el("section", { class: "pg-list", "aria-labelledby": "pg-h-swaps" });
    root.appendChild(el("div", { class: "card-head" }, el("h1", { id: "pg-h-swaps", text: "Your swaps" }), el("div", { class: "right" }, el("button", { type: "button", class: "btn primary", id: "pg-new", disabled: true }, ic("plus"), "New swap"))));
    const ul = el("ul", { class: "pg-swaps", "aria-busy": "true", "aria-label": "Your swaps, loading" });
    for (const w of ["w60", "w45", "w60"]) ul.appendChild(el("li", { class: "pg-swap" }, el("div", { class: "pg-row" }, el("span", { class: "pg-row-main" }, el("span", { class: `sk h16 ${w}` }), el("span", { class: "sk h12 w30" })), el("span", { class: "pg-row-state" }, el("span", { class: "sk h12 w80" })), el("span", {}), el("span", {}))));
    root.appendChild(ul);
    return root;
  }

  // ------------------------------------------------------------------ forms (shared pieces)
  /** One labelled control: `{ box, control, err }`; the label is tied to the control by id. */
  function field(form, key, label, control, hint, cls) {
    const el = H.el;
    const err = el("span", { class: "ferr", id: `${form}-err-${key}`, role: "alert" });
    const lab = el("label", { for: `${form}-${key}` }, label);
    const hintEl = hint ? el("span", { class: "dim hint", id: `${form}-hint-${key}`, text: hint }) : null;
    // the hint and the error are read with the field by a screen reader
    if (control && control.setAttribute) control.setAttribute("aria-describedby", (hintEl ? `${form}-hint-${key} ` : "") + `${form}-err-${key}`);
    const box = el("div", { class: "field" + (cls ? " " + cls : "") }, lab, control, hintEl, err);
    return { box, control, err, label: lab, hint: hintEl };
  }
  const textInput = (form, key, value, ph) => H.el("input", { type: "text", id: `${form}-${key}`, name: key, autocomplete: "off", spellcheck: "false", placeholder: ph || "", value: value === null || value === undefined ? "" : String(value) });
  const selectInput = (form, key, options, value) => {
    const s = H.el("select", { id: `${form}-${key}`, name: key });
    for (const [v, t] of options) s.appendChild(H.el("option", { value: v, selected: v === value ? true : null }, t));
    return s;
  };
  const checkInput = (form, key, on) => H.el("input", { type: "checkbox", id: `${form}-${key}`, name: key, checked: on ? true : null });
  const val = (c) => (c && typeof c.value === "string" ? c.value.trim() : "");

  /** Shows server errors under their fields; anything it cannot place goes into `general` as words. Returns the lines that were not placed. */
  function placeErrors(errors, byKey, general) {
    const left = [];
    for (const k of Object.keys(byKey)) {
      byKey[k].err.textContent = "";
      if (byKey[k].control && byKey[k].control.removeAttribute) byKey[k].control.removeAttribute("aria-invalid");
    }
    if (general) general.textContent = "";
    if (Array.isArray(errors)) for (const e of errors) left.push(String(e));
    else if (errors && typeof errors === "object") {
      for (const [k, m] of Object.entries(errors)) {
        const f = byKey[k] || null;
        if (f) {
          f.err.textContent = String(m);
          if (f.control && f.control.setAttribute) f.control.setAttribute("aria-invalid", "true");
        }
        else left.push(`${k}: ${m}`);
      }
    }
    if (general && left.length) general.textContent = left.join(" ");
    return left;
  }

  // ------------------------------------------------------------------ the numbers of the form (R3, R4: display only)
  const NL = () => (typeof window !== "undefined" && window.NoidLaunch) || null;
  const NOID_DEC = /^(0|[1-9][0-9]{0,3})(\.[0-9]{1,6})?$/;
  const ETH_DEC = /^(0|[1-9][0-9]{0,1})(\.[0-9]{1,18})?$/;
  /** A decimal text (digits, one dot) in the smallest unit, as a BigInt; null when it is not of the form. */
  function decUnits(text, decimals, re) {
    if (typeof text !== "string" || !re.test(text)) return null;
    const [w, f = ""] = text.split(".");
    return BigInt(w) * 10n ** BigInt(decimals) + BigInt(f.padEnd(decimals, "0") || "0");
  }
  const STEP_WORDS = { lock: "the lock", reveal: "the reveal", refund: "the refund", sweep: "the sweep" };
  const gasText = (g) => NL().groupInt(String(g));

  /**
   * Every figure and sentence of the form's launch lines, from what is typed and what the program read. Pure: the form calls it at every change and draws the result; the same functions of
   * lib/launchfacts.js give the server's `launch` object, so the two cannot differ. Nothing here is sent to the program or read by a step.
   * i: { role, profile, noid, eth, gas, tip, hcLead, formProfile (prog.form.profiles[profile]), node (prog.node), nowMs }
   * Returns null when the launch facts are not loaded. Every line is a string, or null when its figures are missing (a figure that is not known is never guessed).
   */
  function launchLines(i) {
    const lf = NL();
    if (!lf || !i || !lf.PROFILES[i.profile]) return null;
    const role = i.role === "bob" ? "bob" : "alice";
    const fp = i.formProfile || {};
    const mainnet = i.profile === "production";
    const prof = lf.PROFILES[i.profile];
    // an empty gas field: mainnet starts with its own cap; a test network's estimate uses the program's default cap and says so (the real send takes the node's own suggestion, which is far below it)
    const typedGas = typeof i.gas === "string" && i.gas ? i.gas : "";
    const defaultGas = !typedGas && !mainnet && typeof fp.estimate_cap_gwei === "string" ? fp.estimate_cap_gwei : "";
    const gasTxt = typedGas || (mainnet && typeof fp.fee_cap_gwei === "string" ? fp.fee_cap_gwei : "") || defaultGas;
    const capIsDefault = defaultGas !== "" && gasTxt === defaultGas;
    let tipTxt = typeof i.tip === "string" ? i.tip : "";
    if (!tipTxt && mainnet && typeof fp.tip_gwei === "string") {
      const g = lf.gweiToWei(gasTxt);
      const t = lf.gweiToWei(fp.tip_gwei);
      if (g !== null && t !== null && g >= t) tipTxt = fp.tip_gwei;
    }
    const capWei = lf.gweiToWei(gasTxt);
    const tipWei = lf.gweiToWei(tipTxt);
    const fee = lf.baseFeeFor(i.node && i.node.eth, i.profile);
    const nowMs = typeof i.nowMs === "number" ? i.nowMs : Date.now();
    const ageS = fee && Number.isFinite(fee.at) ? Math.max(0, Math.floor((nowMs - fee.at) / 1000)) : null;
    const fresh = fee !== null && ageS !== null && ageS <= lf.BASE_FEE_STALE_S;
    const baseWei = fresh ? BigInt(fee.base_fee_wei) : null;
    const micro = decUnits(i.noid, 6, NOID_DEC);
    const wei = decUnits(i.eth, 18, ETH_DEC);
    const both = micro !== null && wei !== null && micro > 0n && wei > 0n;
    const hc = typeof i.hcLead === "string" && /^[1-9][0-9]{0,3}$/.test(i.hcLead) && Number(i.hcLead) <= 1000 ? Number(i.hcLead) : undefined;
    const L = both ? lf.launch({ profile: i.profile, role, amountMicro: micro.toString(), amountWei: wei.toString(), capGwei: gasTxt || null, tipGwei: tipTxt || null, baseFee: fee, nowMs, fundingFeeMicro: null, maxFeeMicro: null, hcLead: hc === undefined ? null : hc }) : null;
    const eth = (w) => (w === null || w === undefined ? null : lf.fmtEth(w).text);
    const noid = (m) => lf.fmtNoid(m, { exact: true }).text;
    const capText = capWei === null ? null : lf.weiToGwei(capWei);
    const out = { cap_default: capIsDefault, rate: null, get: null, fee: null, loud: null, cap_below: null, usual: null, back: null, fees_fold: [], times_fold: [], share_bp: null };

    // the times and the worst case do not need the amounts
    out.usual = `Usually about ${prof.usual_min} minutes once both deposits are in.`;
    const rel = lf.fmtBack(lf.backAfter(i.profile, role, hc));
    const stopEth = lf.ethFees({ role, baseFeeWei: baseWei, capWei, tipWei, path: "stopped" });
    const stopNoid = lf.noidFees({ role, path: "stopped", fundingFeeMicro: null, maxFeeMicro: null });
    const relText = rel ? rel.replace(/^about /, "") : null;
    if (role === "alice") {
      if (relText) out.back = `If Bob never locks: your NOID is back in your own address about ${relText} after you press Prepare, less about ${noid(stopNoid.micro)} NOID in fees.`;
    } else if (relText) {
      const tail = stopEth.now_wei !== null ? `less about ${eth(stopEth.now_wei)} ETH in fees.` : stopEth.max_wei !== null ? `less Ethereum fees of at most ${eth(stopEth.max_wei)} ETH at your fee cap.` : "less the Ethereum fees.";
      out.back = `If Alice never takes the ETH: your ETH is back in your own address about ${relText} after your lock, ${tail}`;
    }

    // the fee cap against the base fee now (the program refuses the step while it holds)
    const refused = capIsDefault ? false : lf.refusedNow({ role, baseFeeWei: baseWei, capWei });
    if (refused && baseWei !== null && capText !== null) {
      const base = lf.weiToGwei(baseWei);
      out.cap_below = role === "alice"
        ? `Your fee cap (${capText} gwei) is below twice Ethereum's base fee now (${base} gwei). While fees stay this high, the program will not send the reveal, and the swap would end with both sides refunded. Raise the cap under Optional settings, or wait for lower fees.`
        : `Your fee cap (${capText} gwei) is below Ethereum's base fee now (${base} gwei). While fees stay this high, the program will not send your lock. Raise the cap under Optional settings, or wait.`;
    }

    // the fold on the times
    out.times_fold.push("Parano1d blocks come about every 30 seconds; faster blocks bring it sooner.");
    if (role === "alice") {
      const lead = hc === undefined ? prof.hc_lead : hc;
      out.times_fold.push(`Your NOID is back ${lead + prof.d_offset + 20} blocks after you press Prepare: ${lead} blocks of lead, ${prof.d_offset} blocks to the deadline, and 20 for the finality of the funding and the sweep, at 30 seconds a block.`);
    } else out.times_fold.push(`Your ETH is back after Alice's window to take it (${Math.round(prof.w_a_s / 60)} minutes), Ethereum's finality (${Math.round(prof.eth_finality_s / 60)} minutes) and a minute for the refund, counted from your lock.`);
    out.times_fold.push(`The usual time (${prof.usual_min} minutes) is what real swaps on this network took from the funding to the end.`);

    if (!L) return out;
    out.rate = lf.rateParts(L.rate);
    out.share_bp = L.fees.share_bp;
    const f = L.fees;
    if (role === "alice") {
      if (L.get_after_fees) out.get = `You get about ${L.get_after_fees} ETH after network fees.`;
      else if (capWei !== null) out.get = `You get ${lf.fmtEth(wei).text} ETH, less the Ethereum fees below.`;
    } else if (L.get_after_fees) out.get = `You get ${L.get_after_fees} NOID after the Parano1d fee.`;

    if (f.happy.eth_max_wei !== null && capText !== null) {
      const happy = f.happy;
      const capWords = capIsDefault ? `the default cap of ${capText} gwei (you set no gas price)` : `your fee cap of ${capText} gwei`;
      if (happy.eth_now_wei === null) out.fee = `Ethereum's fee level is not read yet; at most ${eth(happy.eth_max_wei)} ETH at ${capWords}.`;
      else {
        const share = lf.pct(f.share_bp);
        const upto = happy.noid_upto_micro !== null ? ` and ${noid(happy.noid_upto_micro)} NOID` : "";
        out.fee = role === "alice"
          ? `Network fees, about: ${eth(happy.eth_now_wei)} ETH on Ethereum, ${noid(happy.noid_micro)} NOID on Parano1d (${share} % of what you swap). At most ${eth(happy.eth_max_wei)} ETH at ${capWords}.`
          : `Network fees, about: ${eth(happy.eth_now_wei)} ETH on Ethereum, ${noid(happy.noid_micro)} NOID on Parano1d, taken from the NOID you get (${share} % of what you swap). At most ${eth(happy.eth_max_wei)} ETH at ${capWords}${upto}.`;
      }
      if (f.loud && f.share_bp !== null) out.loud = `Network fees are about ${lf.pct(f.share_bp)} % of what you swap. A larger amount, or a time when Ethereum fees are lower, costs a smaller share.`;

      // the arithmetic in words
      const steps = (list) => list.map((s) => `${STEP_WORDS[s.id]} (about ${gasText(s.gas)} gas)`).join(", ");
      out.fees_fold.push("Each step costs the gas it used on real swaps, times the price of a gas: Ethereum's base fee now plus your tip, never more than your fee cap.");
      out.fees_fold.push(fresh ? `Base fee now: ${lf.weiToGwei(baseWei)} gwei (block ${fee.block === null ? "not known" : gasText(fee.block)}, read ${ageS} s ago).` : "Ethereum's base fee is not read yet, or the reading is more than two minutes old, so only the most the fees can come to is shown.");
      out.fees_fold.push(`Your tip: ${tipWei === null ? "none" : lf.weiToGwei(tipWei) + " gwei"}. ${capIsDefault ? `No fee cap is set; this estimate uses the default of ${capText} gwei.` : `Your fee cap: ${capText} gwei.`}`);
      out.fees_fold.push(`If the swap completes you send: ${steps(happy.eth_steps)}.`);
      out.fees_fold.push(`If it stops you send: ${steps(f.stopped.eth_steps)}.`);
      out.fees_fold.push("The sweep sends what is left of the swap's key to your own address. It is counted at the fee cap, because the part of the cap it does not use stays in the swap's key.");
      out.fees_fold.push(role === "alice" ? `On Parano1d the funding costs about ${noid(happy.noid_micro)} NOID, and closing and sweeping what is left about 0.0058 NOID each, as measured on real swaps.` : "On Parano1d the close costs about 0.0058 NOID, as measured on real swaps. It is taken from the locked NOID, so you get that much less.");
    }
    return out;
  }

  // the texts of the address checks (R3)
  const TICK_TEXT = "I compared every group of this address with my wallet's own screen.";
  const COMPARE_NOTE = "Compare it with your wallet's own screen.";
  const NO_CHECKSUM_NOTE = "This address has no checksum (all one case), so a wrong character would not be caught. Compare it with your wallet's own screen.";
  // the payout history GET /api/settings answered with, kept for the form that is built right after it (operator.js hands the form the settings only)
  let historySnapshot = null;

  // ------------------------------------------------------------------ the new-swap form
  /** The networks the form offers: the two test networks and Ethereum mainnet (real funds, with caps per swap). */
  const NEW_PROFILES = [["sepolia", "Sepolia (the public test network)"], ["rehearsal", "Rehearsal (a test chain on this machine)"], ["production", "Ethereum mainnet (real ETH, real NOID)"]];
  const PIN_HINT = "The program's own contract on this network. Change it only if you and the other person agreed on another one; the program checks the contract's code before any lock.";
  const NO_PIN_HINT = "This network has no contract of the program's own: type the one you agreed on.";
  const INVITATION_NOTE = "Filled from Bob's invitation. Check every value against what you agreed with Bob; nothing is made until you press Make the swap.";
  const CONTRACT_NOTE = "This contract is not the program's own for this network. Use it only if you agreed on it with Bob.";
  const ETH_MAINNET_HINT = "Enter your Ethereum mainnet address. The one saved in Settings was used on a test network, or its network is not known.";
  const ETH_PAYOUT_HINT = {
    alice: "The ETH you get is sent here at the end, with anything left over. Use your own wallet, not an exchange deposit address.",
    bob: "What is left of this swap's ETH is sent here at the end. Use your own wallet, not an exchange deposit address.",
  };
  // what the Ethereum block says under its figure, by the network chosen
  const PROFILE_ON = { sepolia: "on Ethereum Sepolia, a test network", rehearsal: "on a test chain on this machine", production: "on Ethereum mainnet" };
  const BOB_NOID_LABEL = { alice: "Bob's Parano1d address", bob: "Your Parano1d address (where the NOID you buy goes)" };

  /**
   * The form of a new swap. Returns `{ node, collect(), setErrors(errors), submit() }`; `collect()` is the body of POST /api/newswap (`{ fields, remember }`). `settings` only prefills (the
   * payout addresses and, for Bob, his Parano1d address): the person sees every value and keeps or changes it. Alice's "Bob's Parano1d address" is never filled from the settings: it is
   * Bob's. `prog.form.profiles[p].contract` is the program's own contract for a network. `h`: { created(swapId), message(text), cancel() }.
   */
  function newSwapForm(prog, settings, h) {
    const el = H.el;
    const S = settings || {};
    const F = "ns";
    const by = {};
    const reg = (key, f) => {
      by[key] = f;
      return f;
    };
    const str = (x) => (typeof x === "string" ? x : "");
    const profiles = (prog && prog.form && prog.form.profiles) || {};
    const pinOf = (p) => (profiles[p] && typeof profiles[p].contract === "string" ? profiles[p].contract : "");
    const sameAddr = (a, b) => a.toLowerCase() === b.toLowerCase();
    const prefillBobNoid = (r) => (r === "alice" ? "" : str(S.bob_noid) || str(S.noid_payout));

    const role = reg("role", field(F, "role", "Your side", selectInput(F, "role", [["alice", "I sell NOID and get ETH (Alice)"], ["bob", "I sell ETH and get NOID (Bob)"]], "alice"), "Each swap has one side, chosen here and never changed."));
    // the two amounts are the two blocks of a convert: the label says give or get by the side, the glyph and the ticker are the coin's, the chain is under the figure
    const noid = reg("noid_amount", field(F, "noid_amount", "You give", textInput(F, "noid_amount", "", "0"), "The program refuses more than its test limit and says how much that is.", "amt amt-noid"));
    const eth = reg("eth_amount", field(F, "eth_amount", "You get", textInput(F, "eth_amount", "", "0"), "Same limit rule.", "amt amt-eth"));
    const chainNoid = el("span", { class: "on", text: "on Parano1d" });
    const chainEth = el("span", { class: "on", text: PROFILE_ON.sepolia });
    // the coin sits in a sibling span: the field's accessible name is its label and the coin (it starts with the visible label), so a screen reader hears "You give NOID", not "You give" alone
    const nameAmount = (f, coin) => f.control.setAttribute("aria-label", `${f.label.textContent} ${coin === "noid" ? "NOID" : "ETH"}`);
    const amountBlock = (f, coin, chain) => {
      for (const c of [...f.box.children]) f.box.removeChild(c);
      const glyph = H.coinGlyph ? H.coinGlyph(coin) : null;
      const tic = el("span", { class: "tic", text: coin === "noid" ? "NOID" : "ETH" });
      for (const c of [f.label, glyph, f.control, tic, chain, f.hint, f.err]) if (c) f.box.appendChild(c);
      nameAmount(f, coin);
    };
    amountBlock(noid, "noid", chainNoid);
    amountBlock(eth, "eth", chainEth);
    const bobNoid = reg("bob_noid", field(F, "bob_noid", BOB_NOID_LABEL.alice, textInput(F, "bob_noid", "", "o1…"), "Where the NOID goes when the swap completes.", "code"));
    const bobEth = reg("bob_eth", field(F, "bob_eth", "Bob's Ethereum address", textInput(F, "bob_eth", "", "0x…"), "The address Bob's tool shows after it makes his key for this swap.", "code"));
    const noidPay = reg("noid_payout", field(F, "noid_payout", "Your Parano1d address for what is left", textInput(F, "noid_payout", S.noid_payout, "o1…"), "If the swap does not go through, your NOID comes back to this address.", "code"));
    const ethPay = reg("eth_payout", field(F, "eth_payout", "Your Ethereum address", textInput(F, "eth_payout", S.eth_payout, "0x…"), ETH_PAYOUT_HINT.alice, "code"));
    // R23-1: on Ethereum mainnet the saved address fills the field only when it was used on mainnet (a settings file with no network noted means "not known": never filled in)
    const ethSaved = str(S.eth_payout);
    const ethSavedUsable = (p) => ethSaved !== "" && (p !== "production" || S.eth_payout_profile === "production");
    const ethMainnetHint = el("p", { class: "hist new", id: "ns-eth_payout-mainnet-hint", role: "status", hidden: true, text: ETH_MAINNET_HINT });
    ethPay.box.appendChild(ethMainnetHint);
    ethPay.control.setAttribute("aria-describedby", `${ethPay.control.getAttribute("aria-describedby") || ""} ns-eth_payout-mainnet-hint`.trim());
    let ethFilled = ethSaved; // what the program last put in the field: a value that differs from it was typed (or pasted) by the person and stays
    const bobGrid = el("div", { class: "form-grid" }, bobNoid.box, bobEth.box);
    const ownGrid = el("div", { class: "form-grid" }, noidPay.box, ethPay.box);
    const bobSec = el("section", { class: "ns-sec", "aria-labelledby": "ns-h-bob" }, el("h2", { id: "ns-h-bob", text: "Bob's addresses" }), bobGrid);
    const ownSec = el("section", { class: "ns-sec", "aria-labelledby": "ns-h-own" }, el("h2", { id: "ns-h-own", text: "Your own addresses" }), ownGrid);
    let root = null; // the form's section, once it is made (the side's class goes on it)
    const remember = checkInput(F, "remember", true);
    const single = checkInput(F, "single_node_ok", false);
    // the optional settings: the defaults are right for most swaps
    const profile = reg("profile", field(F, "profile", "Network", selectInput(F, "profile", NEW_PROFILES, "sepolia"), "Sepolia and Rehearsal are test networks: the Ethereum side has no value, the NOID is real. Ethereum mainnet: everything is real, at most 2,500 NOID and 0.5 ETH per swap."));
    const version = reg("contract_version", field(F, "contract_version", "Parano1d contract version", selectInput(F, "contract_version", [["1", "1"], ["2", "2"]], "1"), "1 unless you and the other person agreed on 2."));
    const contract = reg("contract", field(F, "contract", "Ethereum contract", textInput(F, "contract", pinOf("sepolia"), "0x…"), pinOf("sepolia") ? PIN_HINT : NO_PIN_HINT, "code"));
    const optBlock = reg("deploy_block", field(F, "deploy_block", "Log start block", textInput(F, "deploy_block", "", ""), "Optional. The first Ethereum block the tool scans for this swap's contract events; empty lets the tool pick a recent one. Never a block after the lock."));
    const hcLead = reg("hc_lead", field(F, "hc_lead", "Blocks before the funding block", textInput(F, "hc_lead", "", "50"), "Optional, 1 to 1000. Empty uses 50."));
    const gas = reg("gas_price_gwei", field(F, "gas_price_gwei", "Ethereum gas price, gwei", textInput(F, "gas_price_gwei", "", "20"), "Optional on the test networks. On Ethereum mainnet this is the fee cap, the most you will pay per gas: empty uses 1 gwei."));
    const tip = reg("priority_fee_gwei", field(F, "priority_fee_gwei", "Ethereum tip, gwei", textInput(F, "priority_fee_gwei", "", "0.01"), "Optional, needs the gas price above and not above it. A lock cannot be replaced, so give it a generous tip. On Ethereum mainnet empty uses 0.05 gwei."));
    const optional = el("details", { class: "newswap-opt", id: "ns-optional" }, el("summary", { text: "Optional settings (the defaults are right for most swaps)" }), el("div", { class: "form-grid" }, profile.box, version.box, contract.box, optBlock.box, hcLead.box, gas.box, tip.box));
    const OPTIONAL_KEYS = ["profile", "contract_version", "contract", "deploy_block", "hc_lead", "gas_price_gwei", "priority_fee_gwei"];
    const general = el("p", { class: "attn", id: "ns-general", role: "alert" });

    // the invitation: fills the form, never a payout
    const invNote = el("p", { class: "plain", id: "ns-inv-note", role: "status", hidden: true });
    const contractNote = el("p", { class: "attn", id: "ns-inv-contract-note", role: "status", hidden: true });
    contract.box.appendChild(contractNote);
    contract.control.setAttribute("aria-describedby", `${F}-hint-contract ${F}-inv-contract-note ${F}-err-contract`);
    const invHint = el("span", { class: "dim hint", id: "ns-inv-hint", text: "Fills the form from the file Bob's program saved. You still check every value." });
    const invButton = el("button", { type: "button", class: "btn", id: "ns-open-invitation", "aria-describedby": "ns-inv-hint", disabled: !H.state.token ? true : null }, "Open Bob's invitation…");
    const inviteBox = el("div", { class: "invite-open" }, ic("open"), el("div", { class: "invite-text" }, invNote, invHint), invButton);

    let curRole = "alice";
    let bobTyped = false; // the person typed in "Bob's Parano1d address" (a fill by the program does not count)
    let invitation = false; // the form holds values filled from an invitation
    let lastPin = pinOf("sepolia");
    let refreshAll = () => {}; // set below: redraws the launch lines, the read-backs and the compare ticks
    if (!lastPin) optional.open = true; // no contract of our own on this network: the person has to see the field

    const syncContractNote = () => {
      const pin = pinOf(profile.control.value);
      const c = val(contract.control);
      contractNote.hidden = !(invitation && c && !(pin && sameAddr(c, pin)));
      contractNote.textContent = contractNote.hidden ? "" : CONTRACT_NOTE;
    };
    const syncContractHint = () => {
      if (contract.hint) contract.hint.textContent = pinOf(profile.control.value) ? PIN_HINT : NO_PIN_HINT;
    };
    const place = (grid, ...boxes) => {
      for (const b of boxes) grid.appendChild(b);
    };
    const syncChain = () => {
      chainEth.textContent = PROFILE_ON[profile.control.value] || PROFILE_ON.sepolia;
      chainEth.className = "on" + (profile.control.value === "production" ? " real" : ""); // on mainnet the words are in the ink colour, not the quiet one
    };
    // the saved Ethereum address follows the network until the person types in the field
    const syncEthPayout = (fill = true) => {
      const usable = ethSavedUsable(profile.control.value);
      if (fill && val(ethPay.control) === ethFilled) {
        ethFilled = usable ? ethSaved : "";
        ethPay.control.value = ethFilled;
      }
      const cur = val(ethPay.control);
      ethMainnetHint.hidden = !(profile.control.value === "production" && ethSaved !== "" && !usable && (cur === "" || sameAddr(cur, ethSaved)));
    };
    const applyRole = (r) => {
      bobEth.box.hidden = r !== "alice";
      noidPay.box.hidden = r !== "alice";
      bobSec.hidden = r !== "alice";
      // Alice looks at Bob's two addresses and at her own; Bob has only his own, and the Parano1d one (where the NOID he buys goes) is among them
      if (r === "alice") {
        place(bobGrid, bobNoid.box, bobEth.box);
        place(ownGrid, noidPay.box, ethPay.box);
      } else place(ownGrid, noidPay.box, bobNoid.box, ethPay.box);
      // what is given is on the left: the NOID for Alice, the ETH for Bob
      noid.label.textContent = r === "alice" ? "You give" : "You get";
      eth.label.textContent = r === "alice" ? "You get" : "You give";
      nameAmount(noid, "noid");
      nameAmount(eth, "eth");
      if (root) root.classList.toggle("is-bob", r === "bob");
      bobNoid.label.textContent = BOB_NOID_LABEL[r] || BOB_NOID_LABEL.alice;
      if (ethPay.hint) ethPay.hint.textContent = ETH_PAYOUT_HINT[r] || ETH_PAYOUT_HINT.alice;
    };
    /** A network change replaces an empty or old-pin contract by the new pin (none: empties it and opens the optional settings). */
    const onNetwork = () => {
      const pin = pinOf(profile.control.value);
      const c = val(contract.control);
      if (c === "" || (lastPin && sameAddr(c, lastPin))) {
        contract.control.value = pin;
        if (!pin) optional.open = true;
      }
      lastPin = pin;
      syncChain();
      syncContractHint();
      syncContractNote();
      syncEthPayout();
    };
    const clearInvitation = () => {
      invitation = false;
      inviteBox.classList.remove("filled");
      noid.control.value = "";
      eth.control.value = "";
      bobEth.control.value = "";
      bobNoid.control.value = "";
      bobTyped = false;
      version.control.value = "1";
      profile.control.value = "sepolia";
      contract.control.value = pinOf("sepolia");
      lastPin = pinOf("sepolia");
      invNote.hidden = true;
      invNote.textContent = "";
      syncEthPayout();
      syncChain();
      syncContractHint();
      syncContractNote();
      refreshAll();
    };
    const onRole = () => {
      const r = role.control.value;
      if (r === curRole) return;
      // fields an invitation filled go with the side; then the prefill rules run again
      if (invitation) clearInvitation();
      curRole = r;
      applyRole(r);
      if (!bobTyped) bobNoid.control.value = prefillBobNoid(r);
    };
    role.control.addEventListener("change", onRole);
    profile.control.addEventListener("change", onNetwork);
    for (const ev of ["input", "change"]) {
      ethPay.control.addEventListener(ev, () => syncEthPayout(false)); // typing only redraws the hint; the program never rewrites what is being typed
      bobNoid.control.addEventListener(ev, () => {
        bobTyped = true;
      });
      contract.control.addEventListener(ev, syncContractNote);
    }
    applyRole("alice");
    bobNoid.control.value = prefillBobNoid("alice");

    const setErrors = (errors) => {
      const left = placeErrors(errors, by, general);
      // an error inside the optional settings opens them
      if (OPTIONAL_KEYS.some((k) => by[k].err.textContent)) optional.open = true;
      return left;
    };

    /** `fields` is what the program read from the file: every value is shown for the person to check; nothing is posted. */
    const fillInvitation = (f) => {
      setErrors(null);
      general.textContent = "";
      role.control.value = "alice";
      curRole = "alice";
      applyRole("alice");
      profile.control.value = NEW_PROFILES.some(([k]) => k === f.profile) ? f.profile : "sepolia";
      version.control.value = f.contract_version === "2" ? "2" : "1";
      noid.control.value = str(f.noid_amount);
      eth.control.value = str(f.eth_amount);
      contract.control.value = str(f.contract);
      bobNoid.control.value = str(f.bob_noid);
      bobEth.control.value = str(f.bob_eth);
      bobTyped = false;
      invitation = true;
      syncEthPayout();
      lastPin = pinOf(profile.control.value);
      invNote.textContent = INVITATION_NOTE;
      invNote.hidden = false;
      inviteBox.classList.add("filled");
      syncChain();
      syncContractHint();
      syncContractNote();
      const pin = pinOf(profile.control.value);
      if (version.control.value !== "1" || !pin || !sameAddr(val(contract.control), pin)) optional.open = true;
      refreshAll();
    };
    const openInvitation = async () => {
      invButton.disabled = true;
      general.textContent = "";
      try {
        const r = await request("POST", "/api/invitation/open", {});
        if (r.ok && r.json && r.json.ok === true) {
          if (r.json.chosen === true && r.json.fields && typeof r.json.fields === "object") fillInvitation(r.json.fields);
        } else general.textContent = errorText(r);
      } catch {
        general.textContent = "The invitation could not be opened.";
      } finally {
        invButton.disabled = !H.state.token;
      }
    };
    invButton.addEventListener("click", openInvitation);

    const collect = () => {
      const bob = role.control.value === "bob";
      const f = { role: role.control.value, profile: profile.control.value, contract_version: version.control.value, noid_amount: val(noid.control), eth_amount: val(eth.control), contract: val(contract.control), bob_noid: val(bobNoid.control), noid_payout: bob ? "" : val(noidPay.control), eth_payout: val(ethPay.control), single_node_ok: !!single.checked };
      if (!bob) f.bob_eth = val(bobEth.control);
      for (const [k, c] of [["deploy_block", optBlock], ["hc_lead", hcLead], ["gas_price_gwei", gas], ["priority_fee_gwei", tip]]) if (val(c.control)) f[k] = val(c.control);
      return { fields: f, remember: !!remember.checked };
    };
    const go = H.el("button", { type: "button", class: "btn primary", id: "ns-go", disabled: !H.state.token ? true : null }, "Make the swap");
    const submit = async () => {
      busy = true;
      syncGo();
      setErrors(null);
      try {
        const r = await request("POST", "/api/newswap", collect());
        if (r.ok && r.json && r.json.ok === true && typeof r.json.swap === "string") {
          if (h && h.created) await h.created(r.json.swap);
          return r;
        }
        if (r.json && r.json.errors) {
          setErrors(r.json.errors);
          if (!general.textContent) general.textContent = "The form has errors; nothing was made.";
        } else general.textContent = errorText(r);
        return r;
      } finally {
        busy = false;
        syncGo();
      }
    };
    go.addEventListener("click", submit);

    // ---- R3 and R4: what the program can say before the first click. Display only: nothing here changes what collect() posts, the approval's bytes or a step.
    const lf = NL();
    const histIn = S.payout_history !== undefined ? { state: S.payout_history_state, items: S.payout_history } : historySnapshot;
    const histState = histIn && typeof histIn.state === "string" && histIn.state !== "none" ? histIn.state : null; // null: loading, or a program with no history (the terminal console): no line
    const histItems = histIn && Array.isArray(histIn.items) ? histIn.items : [];
    const sameAddress = (a, b) => (/^0x/i.test(a) ? a.toLowerCase() === b.toLowerCase() : a === b);
    let nodeSnap = prog && prog.node ? prog.node : null; // the node read the form was opened with; read again every 30 s while the form is on the page
    let busy = false;
    const addrWholeText = (g) => H.el("span", { class: "addr-whole" }, g.map((x) => H.el("span", { class: "g", text: x })));
    // the address fields: `own` is true for the person's own addresses (the history and the compare tick apply to them); `ticks` false for Bob's address and the contract (the case note only)
    const ADDR = [
      { key: "bob_noid", f: bobNoid, kind: "noid", own: (r) => r === "bob", active: () => true, remembered: () => str(S.bob_noid), readback: true },
      { key: "bob_eth", f: bobEth, kind: "eth", own: () => false, active: (r) => r === "alice", remembered: () => "", readback: true },
      { key: "noid_payout", f: noidPay, kind: "noid", own: () => true, active: (r) => r === "alice", remembered: () => str(S.noid_payout), readback: true },
      { key: "eth_payout", f: ethPay, kind: "eth", own: () => true, active: () => true, remembered: () => (ethSavedUsable(profile.control.value) ? ethSaved : ""), readback: true },
      { key: "contract", f: contract, kind: "eth", own: () => false, active: () => true, remembered: () => "", readback: false, noTick: true },
    ];
    for (const a of ADDR) {
      const id = (n) => `${F}-${n}-${a.key}`;
      a.rb = el("p", { class: "hist", id: id("rb"), hidden: true });
      a.hist = el("p", { class: "hist", id: id("hist"), hidden: true });
      a.note = el("p", { class: "hist new", id: id("note"), hidden: true });
      a.tick = checkInput(F, `tick-${a.key}`, false);
      a.tickLab = el("label", { class: "ack", for: `${F}-tick-${a.key}` }, a.tick, el("span", { text: TICK_TEXT })); // in the field only while the tick is asked for
      a.wanted = false;
      a.tickedFor = "";
      a.tick.addEventListener("change", () => {
        a.tickedFor = val(a.f.control);
        syncGo();
      });
      for (const n of [a.rb, a.hist, a.note]) a.f.box.appendChild(n);
      const d = a.f.control.getAttribute("aria-describedby") || "";
      a.f.control.setAttribute("aria-describedby", `${d} ${id("rb")} ${id("hist")} ${id("note")}`.trim());
    }
    const pendingTick = () => ADDR.some((a) => a.wanted && !a.tick.checked);
    // above the button, and only while a tick is missing: why the button is off
    const goWhy = el("p", { class: "hist new", id: "ns-go-why", text: "The button stays off until each address above is compared with your wallet's own screen." });
    const warnsBox = el("div", { class: "ns-warns" });
    const syncGo = () => {
      const missing = pendingTick();
      go.disabled = !H.state.token || busy || missing;
      if (missing && !goWhy.parentNode) warnsBox.appendChild(goWhy);
      if (!missing && goWhy.parentNode) goWhy.remove();
      if (missing) go.setAttribute("aria-describedby", "ns-go-why");
      else go.removeAttribute("aria-describedby");
    };
    function drawAddresses() {
      const r = role.control.value;
      const mainnet = profile.control.value === "production";
      for (const a of ADDR) {
        const v = val(a.f.control);
        const g = lf && a.active(r) ? lf.groups(v) : null;
        // the read-back: the address as typed, whole, in groups of four, once it has the form of an address
        a.rb.textContent = "";
        a.rb.hidden = !(g && a.readback);
        if (g && a.readback) {
          a.rb.appendChild(el("span", { text: "You typed: " }));
          a.rb.appendChild(addrWholeText(g));
        }
        // the history line (own addresses only; every address reads as new when the history cannot be read)
        let isNew = false;
        a.hist.textContent = "";
        a.hist.hidden = true;
        if (g && a.own(r) && histState) {
          const info = histItems.find((it) => it && it.kind === a.kind && typeof it.addr === "string" && sameAddress(it.addr, v)) || null;
          const mem = a.remembered();
          const line = lf.historyLine(histState, info, mem && !sameAddress(mem, v) ? mem : null);
          a.hist.textContent = line.text;
          a.hist.hidden = false;
          a.hist.className = "hist" + (line.isNew ? " new" : "");
          isNew = line.isNew;
        }
        // all one case: a wrong character would not be caught by a checksum; on a test network a new own address gets a plain note
        const noCheck = !!g && a.kind === "eth" && lf.caseNote(v) === "no_checksum";
        const text = noCheck ? NO_CHECKSUM_NOTE : isNew && !mainnet ? COMPARE_NOTE : "";
        a.note.textContent = text;
        a.note.hidden = !text;
        // the compare tick: Ethereum mainnet only, for a new or changed own address and for an address with no checksum; reset when the address changes
        a.wanted = mainnet && !a.noTick && !!g && ((a.own(r) && isNew) || noCheck);
        if (a.tick.checked && a.tickedFor !== v) a.tick.checked = false;
        if (!a.wanted) a.tick.checked = false;
        if (a.wanted && !a.tickLab.parentNode) a.f.box.appendChild(a.tickLab);
        if (!a.wanted && a.tickLab.parentNode) a.tickLab.remove();
      }
      syncGo();
    }

    const factP = (id) => el("p", { class: "facts-line", id, hidden: true });
    const rateP = el("p", { class: "facts-line", id: "ns-rate", hidden: true }, el("span", { class: "fig" }), el("span", { class: "fig" }));
    const getP = factP("ns-get");
    const feeP = factP("ns-fees");
    const usualP = factP("ns-usual");
    const backP = factP("ns-back");
    const foldOf = (id, title) => {
      const body = el("div", { class: "fold-body" });
      return { node: el("details", { class: "newswap-opt", id, hidden: true }, el("summary", { text: title }), body), body };
    };
    const feesFold = foldOf("ns-fees-fold", "How the fees are counted");
    const timesFold = foldOf("ns-times-fold", "How the times are counted");
    const loudBox = safetyBox("warn", "Network fees", "");
    loudBox.setAttribute("id", "ns-loud");
    loudBox.hidden = true;
    const capBox = safetyBox("warn", "Fee cap", "");
    capBox.setAttribute("id", "ns-cap-below");
    capBox.hidden = true;
    const setLine = (p, text) => {
      p.textContent = text || "";
      p.hidden = !text;
    };
    const setBox = (box, text) => {
      box.querySelector(".tx").textContent = text || "";
      box.hidden = !text;
    };
    const setFold = (fold, lines) => {
      fold.body.textContent = "";
      for (const t of lines) fold.body.appendChild(el("p", { class: "facts-line", text: t }));
      fold.node.hidden = !lines.length;
    };
    warnsBox.appendChild(loudBox);
    warnsBox.appendChild(capBox);
    const mainnetTag = el("span", { class: "tag real", id: "ns-mainnet-tag", hidden: true, text: "Ethereum mainnet: real ETH and real NOID" });
    const limitsFold = window.NoidLimits ? el("details", { class: "newswap-opt", id: "ns-limits", hidden: true }, el("summary", { text: "Limits and risks" }), window.NoidLimits.card(el, limitsFacts(prog), { level: 3 })) : null;
    function drawFacts() {
      const lines = launchLines({ role: role.control.value, profile: profile.control.value, noid: val(noid.control), eth: val(eth.control), gas: val(gas.control), tip: val(tip.control), hcLead: val(hcLead.control), formProfile: profiles[profile.control.value], node: nodeSnap, nowMs: Date.now() });
      const l = lines || { rate: null, get: null, fee: null, loud: null, cap_below: null, usual: null, back: null, fees_fold: [], times_fold: [] };
      rateP.hidden = !l.rate;
      for (let k = 0; k < 2; k++) rateP.children[k].textContent = l.rate ? l.rate[k] : "";
      setLine(getP, l.get);
      setLine(feeP, l.fee);
      setLine(usualP, l.usual);
      setLine(backP, l.back);
      setFold(feesFold, l.fees_fold);
      setFold(timesFold, l.times_fold);
      setBox(loudBox, l.loud);
      setBox(capBox, l.cap_below);
      const mainnet = profile.control.value === "production";
      mainnetTag.hidden = !mainnet;
      if (limitsFold) limitsFold.hidden = !mainnet;
    }
    refreshAll = () => {
      drawFacts();
      drawAddresses();
    };
    for (const c of [role, noid, eth, gas, tip, hcLead, profile, bobNoid, bobEth, noidPay, ethPay, contract]) for (const ev of ["input", "change"]) c.control.addEventListener(ev, () => refreshAll());
    // the node read is a snapshot of when the form opened: read it again while the form is on the page, so the base fee does not go stale under a person who is typing
    const rereadNode = async () => {
      if (root && root.isConnected === false) return;
      try {
        if (H.state.token) {
          // while the network is Ethereum mainnet the read asks the program to read the mainnet endpoints (for ten minutes); otherwise no request goes to them
          const r = await request("GET", profile.control.value === "production" ? "/api/program?want=mainnet-fee" : "/api/program");
          if (r.ok && r.json && r.json.node && typeof r.json.node === "object") {
            nodeSnap = r.json.node;
            drawFacts();
          }
        }
      } catch {
        /* the old reading stays; it goes stale by itself */
      }
    };
    const loop = async () => {
      if (root && root.isConnected === false) return;
      await rereadNode();
      setTimeout(loop, 30000);
    };
    if (typeof setTimeout === "function") setTimeout(loop, 30000);
    // Ethereum mainnet chosen (by hand or by an invitation): read at once (the answer has no fee yet) and again a few seconds later, when the program has read the endpoints
    let askedMainnet = false;
    const baseRefresh = refreshAll;
    refreshAll = () => {
      baseRefresh();
      const prod = profile.control.value === "production";
      if (prod && !askedMainnet) {
        rereadNode();
        if (typeof setTimeout === "function") setTimeout(rereadNode, 4000);
      }
      askedMainnet = prod;
    };

    root = el(
      "section",
      { class: "pg-form ns", "aria-labelledby": "ns-h" },
      el("div", { class: "card-head" }, el("h1", { id: "ns-h", text: "New swap" }), el("div", { class: "right" }, mainnetTag, el("button", { type: "button", class: "btn sm", onclick: () => h && h.cancel && h.cancel() }, "Cancel"))),
      inviteBox,
      role.box,
      el("div", { class: "convert" }, noid.box, el("div", { class: "mid", "aria-hidden": "true" }, el("i")), eth.box),
      el("div", { class: "ns-facts" }, rateP, getP, feeP, feesFold.node, usualP, backP, timesFold.node),
      bobSec,
      ownSec,
      el("label", { class: "ack", for: `${F}-remember` }, remember, el("span", { text: " Use these addresses for my next swaps" })),
      el("label", { class: "ack", for: `${F}-single_node_ok` }, single, el("span", {}, " I accept a single node per chain for this swap. ", el("strong", { text: "Never tick this for a swap with someone you do not know:" }), " one node that lies can make the program act on a false chain. Leave it empty unless you control both sides.")),
      optional,
      limitsFold,
      general,
      warnsBox,
      el("div", { class: "form-end" }, go, el("p", { class: "plain", text: "Every value is checked by the program before anything is made. A new swap sends nothing to any chain; coins move only after you approve and deposit." }))
    );
    const node = root;
    refreshAll();
    return { node, collect, setErrors, submit, launch: () => launchLines({ role: role.control.value, profile: profile.control.value, noid: val(noid.control), eth: val(eth.control), gas: val(gas.control), tip: val(tip.control), hcLead: val(hcLead.control), formProfile: profiles[profile.control.value], node: nodeSnap, nowMs: Date.now() }), controls: { role, profile, version, noid, eth, contract, bobNoid, bobEth, noidPay, ethPay, remember, single, optBlock, hcLead, gas, tip, optional, invButton } };
  }

  // ------------------------------------------------------------------ the settings screen
  const T = (path, label, hint, extra) => ({ path, label, hint, kind: "text", ...extra });
  /** The fields of settings.json (never `v`, never a secret). `alert_url` is write-only (below). */
  const SETTINGS_FIELDS = [
    { group: "Parano1d node", line: "This machine only: the node of the Parano1d wallet app." },
    T(["noid_rpc"], "Parano1d node address", "An http://127.0.0.1:… address."),
    T(["noid_rpc2"], "Second Parano1d node (optional)", "A second opinion on the chain.", { nullable: true }),
    { path: ["noid_rpc2_remote"], label: "The second Parano1d node is on another machine", kind: "check" },
    { group: "Ethereum node (Sepolia)", line: "Sepolia, the public test network." },
    T(["eth", "sepolia", "rpc"], "Sepolia node", "An https:// address."),
    T(["eth", "sepolia", "rpc2"], "Sepolia, second node (optional)", "", { nullable: true }),
    { group: "Ethereum node (mainnet)", line: "Ethereum mainnet, real funds. Two public endpoints from two operators. Each one sees this computer's IP address together with the swap key's address, the contract, the lock id, the timing and, at the sweep, your payout address." },
    T(["eth", "production", "rpc"], "Mainnet node", "An https:// address."),
    T(["eth", "production", "rpc2"], "Mainnet, second node (needed for a swap)", "A different operator from the first.", { nullable: true }),
    { path: ["eth_rpc2_remote"], label: "The second Ethereum node is on another machine", kind: "check" },
    { path: ["rpc_timeout_s"], label: "Seconds to wait for a node", kind: "int" },
    { group: "Your addresses", line: "They fill the form of a new swap.", one: true },
    T(["noid_payout"], "Your Parano1d address (when you sell NOID: what is left comes back here)", "", { nullable: true }),
    T(["eth_payout"], "Your Ethereum address (the ETH you get, or what is left, goes here)", "", { nullable: true }),
    T(["bob_noid"], "Your Parano1d address for the NOID you buy (when you sell ETH)", "", { nullable: true }),
    { group: "Updates", line: "The program never installs anything by itself." },
    { path: ["update_check"], label: "Check for a new version", kind: "select", options: [["ask", "Ask me"], ["daily", "Once a day"], ["off", "Never"]] },
    // the closed fold "Advanced": the rehearsal chain and the offer board
    { group: "Rehearsal chain", line: "The test chain on this machine.", advanced: true },
    T(["eth", "rehearsal", "rpc"], "Rehearsal node", "The test chain on this machine."),
    T(["eth", "rehearsal", "rpc2"], "Rehearsal, second node (optional)", "", { nullable: true }),
    { group: "Offer board", line: "Test offers only.", advanced: true },
    { path: ["board", "relays"], label: "Relays, one address per line", kind: "lines", hint: "wss:// addresses." },
    { path: ["board", "lead_blocks"], label: "Blocks of lead before the funding block", kind: "int" },
    { path: ["board", "fund_k"], label: "Funding limit k (optional)", kind: "int", nullable: true },
    T(["board", "reserve_wei"], "Ethereum fee reserve in wei (optional)", "", { nullable: true }),
    { path: ["board", "allow_public"], label: "Allow public relays", kind: "check" },
    { path: ["board", "allow_local_test"], label: "Allow a relay on this machine (tests)", kind: "check" },
    { path: ["board", "min_pow_bits"], label: "Minimum proof-of-work bits of a message", kind: "int" },
  ];

  const getPath = (o, path) => path.reduce((x, k) => (x && typeof x === "object" ? x[k] : undefined), o);
  function setPath(o, path, v) {
    let x = o;
    for (let i = 0; i < path.length - 1; i++) {
      if (!x[path[i]] || typeof x[path[i]] !== "object") x[path[i]] = {};
      x = x[path[i]];
    }
    x[path[path.length - 1]] = v;
  }

  /**
   * The settings screen: the fields of settings.json except `v`, with the server's errors shown per field. `settings` is what GET /api/settings answered. The alert address is write-only:
   * the page says whether one is set and never shows it; a new one is typed in a field of its own, and "Remove it" clears it. `h`: { saved(settings), cancel() }.
   */
  function settingsForm(settings, h) {
    const el = H.el;
    const S = settings || {};
    const F = "st";
    const by = {};
    const ctl = [];
    const grid = el("div", { class: "form-grid" });
    let sect = null;
    const sections = [];
    for (const spec of SETTINGS_FIELDS) {
      if (spec.group) {
        sect = { title: spec.group, line: spec.line || "", advanced: spec.advanced === true, grid: el("div", { class: "form-grid" + (spec.one ? " one" : "") }) };
        sections.push(sect);
        continue;
      }
      const key = spec.path.join("_");
      const cur = getPath(S, spec.path);
      let control;
      if (spec.kind === "check") control = checkInput(F, key, cur === true);
      else if (spec.kind === "select") control = selectInput(F, key, spec.options, typeof cur === "string" ? cur : spec.options[0][0]);
      else if (spec.kind === "lines") control = el("textarea", { id: `${F}-${key}`, name: key, rows: 3, autocomplete: "off", spellcheck: "false", value: Array.isArray(cur) ? cur.join("\n") : "" });
      else control = textInput(F, key, cur);
      if (spec.kind === "lines" && Array.isArray(cur)) control.value = cur.join("\n");
      const f = field(F, key, spec.label, control, spec.hint, spec.kind === "check" ? "check" : "");
      for (const k of [spec.path.join("."), key, spec.path.length === 1 ? spec.path[0] : null]) if (k) by[k] = f;
      ctl.push({ spec, control, f, advanced: sect.advanced === true });
      sect.grid.appendChild(f.box);
    }
    // the alert address: write-only
    const alertSet = typeof S.alert_url === "string" ? S.alert_url.length > 0 : S.alert_url === true;
    const alertNew = textInput(F, "alert_url", "", "https://…");
    const alertOff = checkInput(F, "alert_remove", false);
    const alertF = field(F, "alert_url", "Replace the alert address", alertNew, "Where the program posts alerts. It is never shown again after you save it.");
    by.alert_url = alertF;
    const general = el("p", { class: "attn", id: "st-general", role: "alert" });
    const note = el("p", { class: "plain", id: "st-note" });

    const collect = () => {
      const out = JSON.parse(JSON.stringify(S));
      delete out.v;
      for (const { spec, control } of ctl) {
        let v;
        if (spec.kind === "check") v = !!control.checked;
        else if (spec.kind === "select") v = control.value;
        else if (spec.kind === "lines") v = String(control.value || "").split(/\r?\n/).map((x) => x.trim()).filter(Boolean);
        else {
          const t = val(control);
          if (spec.kind === "int") v = t === "" ? (spec.nullable ? null : "") : /^\d+$/.test(t) ? Number(t) : t;
          else v = t === "" ? (spec.nullable ? null : "") : t;
        }
        setPath(out, spec.path, v);
      }
      if (alertOff.checked) out.alert_url = null;
      else if (val(alertNew)) out.alert_url = val(alertNew);
      out.v = 1;
      return out;
    };
    const go = el("button", { type: "button", class: "btn primary", id: "st-go", disabled: !H.state.token ? true : null }, "Save settings");
    // a section: its title and one line on the left, its fields on the right (one column under 900 px)
    let secN = 0;
    const secOf = (title, line, ...body) => {
      const id = `st-sec-${++secN}`;
      return el("section", { class: "set-sec", "aria-labelledby": id }, el("div", { class: "set-head" }, el("h2", { id, text: title }), line ? el("p", { class: "dim", text: line }) : null), el("div", { class: "set-body" }, ...body));
    };
    const advanced = el("details", { class: "fold", id: "st-advanced" }, el("summary", { text: "Advanced: the rehearsal chain and the offer board" }), ...sections.filter((s) => s.advanced).map((s) => secOf(s.title, s.line, s.grid)));
    const setErrors = (errors) => {
      const left = placeErrors(errors, by, general);
      // an error inside the fold opens it
      if (ctl.some((c) => c.advanced && c.f.err.textContent)) advanced.open = true;
      return left;
    };
    const submit = async () => {
      go.disabled = true;
      setErrors(null);
      note.textContent = "";
      try {
        const r = await request("POST", "/api/settings", collect());
        if (r.ok && r.json && r.json.ok === true) {
          note.textContent = "Saved. A swap that is already made keeps the settings it was made with.";
          if (H.toast) H.toast("Settings saved");
          if (h && h.saved) await h.saved(r.json.settings || null);
          return r;
        }
        if (r.json && r.json.errors) {
          setErrors(r.json.errors);
          if (!general.textContent) general.textContent = "The settings have errors; nothing was saved.";
        } else general.textContent = errorText(r);
        return r;
      } finally {
        go.disabled = !H.state.token;
      }
    };
    go.addEventListener("click", submit);

    const node = el(
      "section",
      { class: "pg-form st", "aria-labelledby": "st-h" },
      el("div", { class: "card-head" }, el("h1", { id: "st-h", text: "Settings" }), el("div", { class: "right" }, el("button", { type: "button", class: "btn sm", onclick: () => h && h.cancel && h.cancel() }, "Back to your swaps"))),
      el("p", { class: "plain", text: "These are the program's own settings. Each new swap copies the ones it needs when it is made; changing them later does not change a swap that exists. Nothing secret is kept here." }),
      ...sections.filter((s) => !s.advanced).map((s) => secOf(s.title, s.line, s.grid)),
      secOf("Alerts", alertSet ? "An alert address is set. It is not shown." : "No alert address is set.", el("div", { class: "form-grid one" }, alertF.box), alertSet ? el("label", { class: "ack", for: `${F}-alert_remove` }, alertOff, " Remove the alert address") : null),
      advanced,
      general,
      el("div", { class: "form-end" }, go, note)
    );
    return { node, collect, setErrors, submit };
  }

  // ------------------------------------------------------------------ the requests of the menu and the board slot
  /** Asks the program to open one of its own windows; nothing comes back that the page shows except the word that it was asked. */
  async function openProgram(what) {
    const r = await request("POST", "/api/program/open", { what });
    return r.ok && r.json && r.json.ok === true ? { ok: true } : { ok: false, error: errorText(r) };
  }
  async function makeSlot(role) {
    const r = await request("POST", "/api/board/slot", { role });
    return r.ok && r.json && r.json.ok === true && typeof r.json.swap === "string" ? { ok: true, swap: r.json.swap } : { ok: false, error: errorText(r) };
  }
  async function loadSettings() {
    const r = await request("GET", "/api/settings");
    // R3: the payout history comes beside the settings; it is kept here for the new-swap form that is built next (it is never part of the settings, so it is never posted back)
    if (r.ok && r.json && r.json.ok === true) historySnapshot = typeof r.json.payout_history_state === "string" ? { state: r.json.payout_history_state, items: Array.isArray(r.json.payout_history) ? r.json.payout_history : [] } : null;
    return r.ok && r.json && r.json.ok === true && r.json.settings && typeof r.json.settings === "object" ? { ok: true, settings: r.json.settings } : { ok: false, error: errorText(r) };
  }

  window.NoidProgram = {
    init(helpers) {
      H = helpers;
    },
    roleWords,
    nodeWords,
    updateWords,
    activeCount,
    sortSwaps,
    signature,
    vaultNotes,
    topBar,
    swapList,
    loadingList,
    newSwapForm,
    launchLines,
    noticeBox,
    limitsScreen,
    settingsForm,
    openProgram,
    makeSlot,
    loadSettings,
    request,
    SETTINGS_FIELDS,
    NEW_PROFILES,
    OPEN_ITEMS,
  };
})();
