/* noid-swap operator console, program mode: the top bar, the list of swaps, the new-swap form and the settings screen.
   Pure builders (data and handlers in, element trees out); operator.js mounts them. The only requests made here are the ones of the program API
   (POST /api/newswap, POST /api/settings, POST /api/program/open, POST /api/board/slot, GET /api/settings), each with the per-start token.
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
  const ETH_WORDS = { ok: "connected", unreachable: "not reachable", wrong_chain: "not the expected network", behind: "behind: still catching up", error: "cannot be checked" };
  const LEVEL = { ok: "ok", behind: "attn", error: "attn", not_running: "danger", unreachable: "danger", wrong_chain: "danger" };

  /** `{ noid: {word, level}, eth: {word, level} }` from a NodeStatus; anything not in the fixed tables reads as "cannot be checked". */
  function nodeWords(node) {
    const one = (obj, words) => {
      const st = obj && typeof obj.state === "string" && Object.prototype.hasOwnProperty.call(words, obj.state) ? obj.state : "error";
      const out = { state: st, word: words[st], level: LEVEL[st] || "attn" };
      // the Parano1d chain identity is checked against a pinned block once the program has one; until then it says so
      if (words === NOID_WORDS && st === "ok" && obj && obj.chain_checked === false) out.word += " (the chain is not verified yet)";
      return out;
    };
    return { noid: one(node && node.noid, NOID_WORDS), eth: one(node && node.eth, ETH_WORDS) };
  }

  const UPDATE_WORDS = { not_configured: "Update check: not set up in this version", off: "Update check: off", none: "You have the newest version", current: "You have the newest version", available: "A new version is available", checking: "Checking for a new version", error: "The update check did not work", unknown: "Not checked yet", ask: "Not checked yet", newer: "A new version is available", never: "Not checked yet", skipped_active: "Not checked: a swap was active" };
  function updateWords(update) {
    const st = update && typeof update.state === "string" && Object.prototype.hasOwnProperty.call(UPDATE_WORDS, update.state) ? update.state : "unknown";
    const latest = update && typeof update.latest === "string" && /^[0-9A-Za-z.+-]{1,32}$/.test(update.latest) ? update.latest : null;
    const url = update && typeof update.url === "string" && /^https:\/\/[A-Za-z0-9\-._~:/?#@!$&'()*+,;=%]{1,200}$/.test(update.url) ? update.url : null;
    // the program's checker says "newer" (desktop/lib/updatecheck.js); "available" is the same
    const isNew = st === "available" || st === "newer";
    return { state: st, text: UPDATE_WORDS[st] + (isNew && latest ? `: ${latest}` : "") + (isNew ? ". Check its sha256 and build provenance on its release page before installing." : ""), url: isNew ? url : null };
  }

  /** The chip of one node in words (the top bar and the first-start guide draw the same one). */
  const nodeChip = (name, w) => H.chip(w.level === "ok" ? "ok" : w.level === "danger" ? "danger" : "attn", `${name}: ${w.word}`);

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
    return JSON.stringify({ v: prog.version, n: prog.network, node, vault: prog.vault, ns: prog.new_swap_allowed, swaps: prog.swaps, board: prog.board, update: prog.update, token: !!(H && H.state.token) });
  }

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
    const net = prog && prog.network === "test" ? H.chip("quiet", "Test network") : H.chip("danger", "Network not recognised");
    const summary = el("summary", { class: "btn sm", "aria-label": "Menu" }, "Menu");
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
    item("Settings", () => h.go("settings"));
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
      el("button", { type: "button", class: "pg-swaps-btn", "aria-current": ui && ui.screen === "list" ? "page" : null, onclick: () => h.go("list") }, "Your swaps", el("span", { class: "pg-count", text: n === 1 ? "1 active" : `${n} active` })),
      el("div", { class: "pg-status", "aria-label": "Network and nodes" }, net, nodeChip("Parano1d", nodes.noid), nodeChip("Ethereum", nodes.eth)),
      el("div", { class: "pg-tools" }, el("button", { type: "button", class: "btn ghost sm", onclick: () => h.refresh() }, "Refresh"), menu)
    );
  }

  // ------------------------------------------------------------------ the list of swaps
  function phaseWord(role, phase) {
    if (!phase) return "not started";
    return H.phaseLabel ? H.phaseLabel(role, phase) : String(phase);
  }

  function swapRow(s, h) {
    const el = H.el;
    const chips = [];
    if (!s.refused) chips.push(H.chip("quiet", phaseWord(s.role, s.phase)));
    if (s.needs_you) chips.push(H.chip("accent", "Needs you"));
    if (s.in_contract) chips.push(H.chip("warn", "Coins are in the contract"));
    if (s.refused) chips.push(H.chip("danger", "Read only"));
    else if (!s.active && s.phase) chips.push(H.chip("quiet", "Ended"));
    return el(
      "li",
      { class: "pg-swap" + (s.needs_you ? " needs" : "") },
      el(
        "button",
        { type: "button", class: "pg-row", onclick: () => h.openSwap(s.swap) },
        el("span", { class: "pg-row-main" }, el("strong", { class: "pg-label", text: s.label || "A swap" }), el("span", { class: "dim", text: ` ${roleWords(s.role)}` })),
        el("span", { class: "pg-row-chips" }, ...chips),
        s.until_text ? el("span", { class: "dim pg-until", text: s.until_text }) : null,
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
        li("An Ethereum wallet that works on Sepolia, the test network, and its address. The ETH you get, or what is left, goes there. Use your own wallet, not an exchange."),
        li("Sepolia test ETH in that wallet. It has no value and is free from a Sepolia faucet; search for \"Sepolia faucet\", as they change often. If you sell NOID, a little is enough: it pays one fee."),
        li("If you sell NOID: the NOID to swap and a little more for the fee, in the Parano1d wallet app. If you sell ETH: the ETH to swap and a little more for two fees."),
        li("The amounts, agreed with the other person. The one who sells ETH makes the swap first and sends the other an invitation file."),
        li("About an hour with both computers on and awake.")
      )
    );
  }

  /** `h`: { openSwap(swapId), go(screen), openProgram(what), board(role), openBoard(slotId) }. */
  function swapList(prog, h) {
    const el = H.el;
    const swaps = sortSwaps(prog && prog.swaps);
    const ns = (prog && prog.new_swap_allowed) || { ok: false, why: "The program did not say." };
    const v = vaultNotes(prog);
    const noKey = !(H.state && H.state.token);
    const root = el("section", { class: "pg-list", "aria-labelledby": "pg-h-swaps" });
    root.appendChild(el("div", { class: "card-head" }, el("h1", { id: "pg-h-swaps", text: "Your swaps" }), el("div", { class: "right" }, el("button", { type: "button", class: "btn primary", id: "pg-new", disabled: ns.ok && !noKey ? null : true, onclick: () => h.go("new") }, "New swap"))));
    if (noKey) root.appendChild(el("p", { class: "pg-why", id: "pg-new-why", text: KEY_LOST_PROGRAM }));
    else if (!ns.ok) root.appendChild(el("p", { class: "pg-why", id: "pg-new-why", text: ns.why || "A new swap cannot start now." }));
    if (v.not_ready) root.appendChild(el("div", { class: "alarm danger big", role: "alert" }, el("span", { class: "lv", text: "key store" }), el("span", { class: "tx" }, "The program's key store is not open, so no swap can act. Restore from your recovery code, or close the program and open it again. ", el("button", { type: "button", class: "btn sm", onclick: () => h.openProgram("restore") }, "Restore from a recovery code"))));
    if (v.unconfirmed) root.appendChild(el("div", { class: "alarm warn big", role: "note" }, el("span", { class: "lv", text: "recovery code" }), el("span", { class: "tx" }, "Your recovery code is not confirmed yet. Without it a swap cannot be restored on another machine, so no new swap starts until you have written it down and typed it back. ", el("button", { type: "button", class: "btn sm", onclick: () => h.openProgram("recovery-code") }, "Show my recovery code"))));
    if (!swaps.length) {
      root.appendChild(firstStartGuide(prog));
      root.appendChild(el("p", { class: "plain", text: "No swaps yet. Make one with New swap, or use the offer board if it is on." }));
    } else {
      const ul = el("ul", { class: "pg-swaps", "aria-label": "Your swaps" });
      for (const s of swaps) ul.appendChild(swapRow(s, h));
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
    for (const k of Object.keys(byKey)) byKey[k].err.textContent = "";
    if (general) general.textContent = "";
    if (Array.isArray(errors)) for (const e of errors) left.push(String(e));
    else if (errors && typeof errors === "object") {
      for (const [k, m] of Object.entries(errors)) {
        const f = byKey[k] || null;
        if (f) f.err.textContent = String(m);
        else left.push(`${k}: ${m}`);
      }
    }
    if (general && left.length) general.textContent = left.join(" ");
    return left;
  }

  // ------------------------------------------------------------------ the new-swap form
  /** The test profiles the form offers: nothing for mainnet or production. */
  const NEW_PROFILES = [["sepolia", "Sepolia (the public test network of Ethereum)"], ["rehearsal", "Rehearsal (a test chain on this machine)"]];
  const PIN_HINT = "The program's own contract on this network. Change it only if you and the other person agreed on another one; the program checks the contract's code before any lock.";
  const NO_PIN_HINT = "This network has no contract of the program's own: type the one you agreed on.";
  const INVITATION_NOTE = "Filled from Bob's invitation. Check every value against what you agreed with Bob; nothing is made until you press Make the swap.";
  const CONTRACT_NOTE = "This contract is not the program's own for this network. Use it only if you agreed on it with Bob.";
  const ETH_PAYOUT_HINT = {
    alice: "The ETH you get is sent here at the end, with anything left over. Use your own wallet, not an exchange deposit address.",
    bob: "What is left of this swap's ETH is sent here at the end. Use your own wallet, not an exchange deposit address.",
  };
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
    const noid = reg("noid_amount", field(F, "noid_amount", "NOID amount", textInput(F, "noid_amount", "", "5"), "The program refuses more than its test limit and says how much that is.", "amt amt-noid"));
    const eth = reg("eth_amount", field(F, "eth_amount", "ETH amount", textInput(F, "eth_amount", "", "0.001"), "Same limit rule.", "amt amt-eth"));
    const bobNoid = reg("bob_noid", field(F, "bob_noid", BOB_NOID_LABEL.alice, textInput(F, "bob_noid", "", "o1…"), "Where the NOID goes when the swap completes."));
    const bobEth = reg("bob_eth", field(F, "bob_eth", "Bob's Ethereum address", textInput(F, "bob_eth", "", "0x…"), "The address Bob's tool shows after it makes his key for this swap."));
    const noidPay = reg("noid_payout", field(F, "noid_payout", "Your Parano1d address for what is left", textInput(F, "noid_payout", S.noid_payout, "o1…"), "If the swap does not go through, your NOID comes back to this address."));
    const ethPay = reg("eth_payout", field(F, "eth_payout", "Your Ethereum address", textInput(F, "eth_payout", S.eth_payout, "0x…"), ETH_PAYOUT_HINT.alice));
    const remember = checkInput(F, "remember", true);
    const single = checkInput(F, "single_node_ok", false);
    // the optional settings: the defaults are right for most swaps
    const profile = reg("profile", field(F, "profile", "Network", selectInput(F, "profile", NEW_PROFILES, "sepolia"), "Test networks only: the Ethereum side has no value, the NOID is real."));
    const version = reg("contract_version", field(F, "contract_version", "Parano1d contract version", selectInput(F, "contract_version", [["1", "1"], ["2", "2"]], "1"), "1 unless you and the other person agreed on 2."));
    const contract = reg("contract", field(F, "contract", "Ethereum contract", textInput(F, "contract", pinOf("sepolia"), "0x…"), pinOf("sepolia") ? PIN_HINT : NO_PIN_HINT));
    const optBlock = reg("deploy_block", field(F, "deploy_block", "Log start block", textInput(F, "deploy_block", "", ""), "Optional. The first Ethereum block the tool scans for this swap's contract events; empty lets the tool pick a recent one. Never a block after the lock."));
    const hcLead = reg("hc_lead", field(F, "hc_lead", "Blocks before the funding block", textInput(F, "hc_lead", "", "50"), "Optional, 1 to 1000. Empty uses 50."));
    const gas = reg("gas_price_gwei", field(F, "gas_price_gwei", "Ethereum gas price, gwei", textInput(F, "gas_price_gwei", "", "20"), "Optional, for the test networks."));
    const tip = reg("priority_fee_gwei", field(F, "priority_fee_gwei", "Ethereum tip, gwei", textInput(F, "priority_fee_gwei", "", "0.01"), "Optional, needs the gas price above and not above it. A lock cannot be replaced, so give it a generous tip."));
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

    let curRole = "alice";
    let bobTyped = false; // the person typed in "Bob's Parano1d address" (a fill by the program does not count)
    let invitation = false; // the form holds values filled from an invitation
    let lastPin = pinOf("sepolia");
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
    const applyRole = (r) => {
      bobEth.box.hidden = r !== "alice";
      noidPay.box.hidden = r !== "alice";
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
      syncContractHint();
      syncContractNote();
    };
    const clearInvitation = () => {
      invitation = false;
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
      syncContractHint();
      syncContractNote();
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
      lastPin = pinOf(profile.control.value);
      invNote.textContent = INVITATION_NOTE;
      invNote.hidden = false;
      syncContractHint();
      syncContractNote();
      const pin = pinOf(profile.control.value);
      if (version.control.value !== "1" || !pin || !sameAddr(val(contract.control), pin)) optional.open = true;
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
      go.disabled = true;
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
        go.disabled = !H.state.token;
      }
    };
    go.addEventListener("click", submit);

    const node = el(
      "section",
      { class: "pg-form", "aria-labelledby": "ns-h" },
      el("div", { class: "card-head" }, el("h1", { id: "ns-h", text: "New swap" }), el("div", { class: "right" }, el("button", { type: "button", class: "btn sm", onclick: () => h && h.cancel && h.cancel() }, "Cancel"))),
      el("p", { class: "plain", text: "Every value is checked by the program before anything is made. A new swap sends nothing to any chain; coins move only after you approve and deposit." }),
      el("div", { class: "field" }, invButton, invHint),
      invNote,
      el("div", { class: "form-grid" }, role.box, noid.box, eth.box, bobNoid.box, bobEth.box, noidPay.box, ethPay.box),
      el("label", { class: "ack", for: `${F}-remember` }, remember, el("span", { text: " Use these addresses for my next swaps" })),
      el("label", { class: "ack", for: `${F}-single_node_ok` }, single, el("span", {}, " I accept a single node per chain for this swap. ", el("strong", { text: "Never tick this for a swap with someone you do not know:" }), " one node that lies can make the program act on a false chain. Leave it empty unless you control both sides.")),
      optional,
      general,
      el("div", { class: "row" }, go)
    );
    return { node, collect, setErrors, submit, controls: { role, profile, version, noid, eth, contract, bobNoid, bobEth, noidPay, ethPay, remember, single, optBlock, hcLead, gas, tip, optional, invButton } };
  }

  // ------------------------------------------------------------------ the settings screen
  const T = (path, label, hint, extra) => ({ path, label, hint, kind: "text", ...extra });
  /** The fields of settings.json (never `v`, never a secret). `alert_url` is write-only (below). */
  const SETTINGS_FIELDS = [
    { group: "Parano1d node" },
    T(["noid_rpc"], "Parano1d node address", "This machine only (http://127.0.0.1:…): the node of the Parano1d wallet app."),
    T(["noid_rpc2"], "Second Parano1d node (optional)", "A second opinion on the chain.", { nullable: true }),
    { path: ["noid_rpc2_remote"], label: "The second Parano1d node is on another machine", kind: "check" },
    { group: "Ethereum node (Sepolia)" },
    T(["eth", "sepolia", "rpc"], "Sepolia node", "An https:// address."),
    T(["eth", "sepolia", "rpc2"], "Sepolia, second node (optional)", "", { nullable: true }),
    { path: ["eth_rpc2_remote"], label: "The second Ethereum node is on another machine", kind: "check" },
    { path: ["rpc_timeout_s"], label: "Seconds to wait for a node", kind: "int" },
    { group: "Your addresses (they fill the form of a new swap)" },
    T(["noid_payout"], "Your Parano1d address (when you sell NOID: what is left comes back here)", "", { nullable: true }),
    T(["eth_payout"], "Your Ethereum address (the ETH you get, or what is left, goes here)", "", { nullable: true }),
    T(["bob_noid"], "Your Parano1d address for the NOID you buy (when you sell ETH)", "", { nullable: true }),
    { group: "Updates" },
    { path: ["update_check"], label: "Check for a new version", kind: "select", options: [["ask", "Ask me"], ["daily", "Once a day"], ["off", "Never"]] },
    // the closed fold "Advanced": the rehearsal chain and the offer board
    { group: "Rehearsal chain", advanced: true },
    T(["eth", "rehearsal", "rpc"], "Rehearsal node", "The test chain on this machine."),
    T(["eth", "rehearsal", "rpc2"], "Rehearsal, second node (optional)", "", { nullable: true }),
    { group: "Offer board", advanced: true },
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
        sect = { title: spec.group, advanced: spec.advanced === true, grid: el("div", { class: "form-grid" }) };
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
    const advanced = el("details", { class: "fold", id: "st-advanced" }, el("summary", { text: "Advanced: the rehearsal chain and the offer board" }), ...sections.filter((s) => s.advanced).map((s) => el("fieldset", { class: "pg-set" }, el("legend", { text: s.title }), s.grid)));
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
      { class: "pg-form", "aria-labelledby": "st-h" },
      el("div", { class: "card-head" }, el("h1", { id: "st-h", text: "Settings" }), el("div", { class: "right" }, el("button", { type: "button", class: "btn sm", onclick: () => h && h.cancel && h.cancel() }, "Back to your swaps"))),
      el("p", { class: "plain", text: "These are the program's own settings. Each new swap copies the ones it needs when it is made; changing them later does not change a swap that exists. Nothing secret is kept here." }),
      ...sections.filter((s) => !s.advanced).map((s) => el("fieldset", { class: "pg-set" }, el("legend", { text: s.title }), s.grid)),
      el("fieldset", { class: "pg-set" }, el("legend", { text: "Alerts" }), el("p", { class: "plain", text: alertSet ? "An alert address is set. It is not shown." : "No alert address is set." }), el("div", { class: "form-grid" }, alertF.box), alertSet ? el("label", { class: "ack", for: `${F}-alert_remove` }, alertOff, " Remove the alert address") : null),
      advanced,
      general,
      note,
      el("div", { class: "row" }, go)
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
    newSwapForm,
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
