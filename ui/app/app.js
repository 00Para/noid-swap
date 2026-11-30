/* noid-swap read-only console — vanilla, no build. Polls /api/swaps every 15 s.
   Components of the first design (swap card, phase stepper, dual-chain strip,
   countdown chips, action panel, sealed-secret chip, receipts list, fail-closed states)
   with the read-only restriction: there is never a button that acts on a chain. */
(() => {
  "use strict";
  const POLL_MS = 15000;
  const $ = (sel, root = document) => root.querySelector(sel);
  const state = { data: null, selected: null, lastFetch: null, error: null };
  // Every /api request needs the per-start key. It comes from the URL fragment (#token=...), which this page leaves in the address bar so a reload keeps it.
  const TOKEN = (/(?:^|[#&])token=([0-9a-f]{16,})/.exec(location.hash || "") || [])[1] || null;

  // ------------------------------------------------------------ formatting
  const short = (h) => (typeof h === "string" && h.length > 18 ? h.slice(0, 8) + "…" + h.slice(-6) : h);
  const n = (v) => (typeof v === "number" ? v.toLocaleString("en-US") : v === null || v === undefined ? "—" : String(v));
  const ts = (unix) => (typeof unix === "number" ? new Date(unix * 1000).toLocaleString(undefined, { hour12: false }) : "—");
  const hms = (unix) => (typeof unix === "number" ? new Date(unix * 1000).toLocaleTimeString(undefined, { hour12: false }) : "—");
  function dur(s) {
    if (typeof s !== "number" || !Number.isFinite(s)) return "—";
    const a = Math.abs(Math.round(s));
    const h = Math.floor(a / 3600);
    const m = Math.floor((a % 3600) / 60);
    const parts = [];
    if (h) parts.push(h + " h");
    if (h || m) parts.push(m + " min");
    if (!h) parts.push((a % 60) + " s");
    return parts.join(" ");
  }
  const noid = (micro) => (typeof micro === "number" ? (micro / 1e6).toFixed(6) + " NOID" : "—");
  const ethAmt = (wei) => (wei ? Number(BigInt(wei)) / 1e18 + " ETH" : "—");
  const nowS = () => Math.floor(Date.now() / 1000);

  // ------------------------------------------------------------ DOM helpers
  function el(tag, attrs = {}, ...children) {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (v === null || v === undefined || v === false) continue;
      if (k === "class") e.className = v;
      else if (k === "text") e.textContent = v;
      else if (k.startsWith("on")) e.addEventListener(k.slice(2), v);
      else e.setAttribute(k, v === true ? "" : v);
    }
    for (const c of children.flat(Infinity)) {
      if (c === null || c === undefined || c === false) continue;
      e.appendChild(typeof c === "string" || typeof c === "number" ? document.createTextNode(String(c)) : c);
    }
    return e;
  }
  const chip = (text, kind = "neutral", title) => el("span", { class: `chip chip-${kind}`, title: title || null, text });

  function copyButton(value, label = "value") {
    const b = el("button", { type: "button", class: "btn btn-copy", title: `Copy ${value}`, "aria-label": `Copy ${label}` }, "copy");
    b.addEventListener("click", async (ev) => {
      ev.stopPropagation();
      try {
        if (navigator.clipboard && window.isSecureContext) await navigator.clipboard.writeText(value);
        else {
          const ta = el("textarea", { class: "sr-only" });
          ta.value = value;
          document.body.appendChild(ta);
          ta.select();
          document.execCommand("copy");
          ta.remove();
        }
        b.textContent = "copied";
      } catch {
        b.textContent = "failed";
      }
      setTimeout(() => (b.textContent = "copy"), 1200);
    });
    return b;
  }
  const hash = (value, label) => (value ? el("span", { class: "hash" }, el("code", { class: "mono", title: value, text: short(value) }), copyButton(value, label || value)) : el("span", { class: "muted", text: "—" }));

  // freshness: ok <= 60 s, warn 60–120 s, attn > 120 s (stale, engine fails closed), danger unreachable
  function freshness(obs) {
    if (!obs || !obs.ok) return { kind: "danger", label: "Node unreachable", detail: (obs && (obs.error || obs.reason)) || "" };
    const age = typeof obs.observed_at === "number" ? nowS() - obs.observed_at : null;
    if (age === null || obs.stale || age > 120) return { kind: "attn", label: "Observation stale — engine fails closed", detail: obs.reason || "" , age };
    if (age > 60) return { kind: "warn", label: `observed ${age} s ago`, age };
    return { kind: "ok", label: `observed ${age} s ago`, age };
  }
  const dot = (kind) => el("span", { class: `dot dot-${kind}`, "aria-hidden": "true" });

  // ------------------------------------------------------------ dual-chain strip
  function renderStrip() {
    const strip = $("#chain-strip");
    strip.replaceChildren();
    if (!state.data) return;
    const s = state.data.swaps.find((x) => x.id === state.selected) || state.data.swaps[0];
    if (!s) return;
    const nd = s.noid || {};
    const et = s.eth || {};
    const fn = freshness(nd);
    const fe = freshness(et);
    strip.append(
      el("div", { class: `capsule capsule-noid capsule-${fn.kind}`, title: fn.detail || "" }, dot(fn.kind), el("b", { text: "Parano1d" }), el("span", { class: "muted", text: " · mainnet · " }), el("span", { text: `height ${n(nd.tip)}` }), el("span", { class: "muted", text: " · " }), el("span", { "data-observed": nd.ok && typeof nd.observed_at === "number" ? nd.observed_at : "", "data-stale": nd.stale ? "1" : "", text: fn.label })),
      el("div", { class: `capsule capsule-eth capsule-${fe.kind}`, title: fe.detail || "" }, dot(fe.kind), el("b", { text: "Ethereum" }), el("span", { class: "muted", text: ` · ${et.chain_id === 31337 ? "Hardhat 31337" : et.chain_id === 11155111 ? "Sepolia" : et.chain_id ? "chain " + et.chain_id : "chain ?"} · ` }), el("span", { text: `block ${n(et.latest && et.latest.number)}` }), et.latest ? el("span", { class: "muted", text: ` · ${hms(et.latest.timestamp)}` }) : null, el("span", { class: "muted", text: " · " }), el("span", { "data-observed": et.ok && typeof et.observed_at === "number" ? et.observed_at : "", "data-stale": et.stale ? "1" : "", text: fe.label })),
      el("div", { class: "capsule capsule-plain" }, el("span", { class: "muted", text: `${state.data.mode === "mock" ? "mock data" : "live"} · sources ${s.sources && s.sources.noid_rpc ? s.sources.noid_rpc : "?"} / ${s.sources && s.sources.eth_rpc ? s.sources.eth_rpc : "?"}` }))
    );
    const banner = $("#banner");
    if (state.error) {
      banner.className = "banner banner-danger";
      banner.textContent = `Console server unreachable (${state.error}) — everything shown is old.`;
      banner.hidden = false;
    } else if (fn.kind === "danger" || fe.kind === "danger") {
      banner.className = "banner banner-danger";
      banner.textContent = `Node unreachable: ${fn.kind === "danger" ? "Parano1d " + (fn.detail || "") : ""} ${fe.kind === "danger" ? "Ethereum " + (fe.detail || "") : ""}`.trim();
      banner.hidden = false;
    } else if (fn.kind === "attn" || fe.kind === "attn") {
      banner.className = "banner banner-attn";
      banner.textContent = "Observation stale — the engine will not act on old data.";
      banner.hidden = false;
    } else banner.hidden = true;
  }

  // ------------------------------------------------------------ swap card
  function cardState(s) {
    const v = (s.phase && s.phase.value) || "";
    if (s.phase && s.phase.stale) return "fails-closed";
    if (/settled|^done$/.test(v)) return "settled";
    if (/refunded|closed/.test(v)) return "refunded";
    if (/abort/.test(v)) return "aborted";
    if (/not_funded|created|received/.test(v)) return "draft";
    const tm = s.timers || {};
    if (typeof tm.blocks_to_lock_by === "number" && tm.blocks_to_lock_by > 0 && tm.blocks_to_lock_by < 60) return "attention";
    return "waiting";
  }
  const STATE_CHIP = { draft: ["not funded", "neutral"], active: ["active", "info"], waiting: ["waiting", "info"], attention: ["attention", "warn"], "fails-closed": ["stale — fails closed", "attn"], settled: ["Settled", "ok"], refunded: ["Refunded", "dim"], aborted: ["Aborted", "danger"] };

  function countdownChip(label, value, opts = {}) {
    // states: far (neutral), closing (warn-soft), passed (struck, dim), unknown (—)
    const kind = opts.unknown ? "unknown" : opts.passed ? "passed" : opts.closing ? "closing" : "far";
    return el("span", { class: `cd cd-${kind}`, title: opts.title || null }, el("span", { class: "cd-label", text: label }), el("span", { class: "cd-value", text: value }));
  }
  function dChip(s) {
    const tm = s.timers || {};
    if (typeof tm.blocks_to_D !== "number") return countdownChip("to D", "—", { unknown: true, title: "no Parano1d tip" });
    if (tm.blocks_to_D <= 0) return countdownChip("to D", `passed · ${n(-tm.blocks_to_D)} blocks ago`, { passed: true });
    return countdownChip("to D", `${n(tm.blocks_to_D)} blocks · ≈ ${dur(tm.eta_D_s)}`, { closing: tm.blocks_to_D < 30, title: `D = ${n(s.terms.deadline_height)} ≈ ${ts(tm.eta_D_at)} at 30 s/block` });
  }

  function swapCard(s, compact) {
    const t = s.terms || {};
    const st = cardState(s);
    const [stText, stKind] = STATE_CHIP[st] || STATE_CHIP.waiting;
    return el(
      "article",
      { class: `card card-${st}` + (compact ? "" : " card-wide") },
      el(
        "div",
        { class: "legs" },
        el("div", { class: "leg leg-noid" }, el("div", { class: "leg-amount" }, el("span", { class: "amount", text: t.amount_noid || "—" }), el("span", { class: "unit", text: " NOID" })), el("div", { class: "leg-party muted", text: `Bob · ${short(t.bob_noid || t.claim_recipient || "?")}` })),
        el("div", { class: "leg-arrow muted", text: "⇄" }),
        el("div", { class: "leg leg-eth" }, el("div", { class: "leg-amount" }, el("span", { class: "amount", text: t.amount_eth || "—" }), el("span", { class: "unit", text: " ETH" })), el("div", { class: "leg-party muted", text: `Alice · ${short((t.eth && t.eth.alice_receiver) || "?")}` }))
      ),
      el("div", { class: "card-meta" }, chip(s.role === "alice" ? "You are Alice" : "You are Bob", "proof", s.role === "alice" ? "you hold NOID and made the secret" : "you hold ETH and locked second"), chip(stText, stKind), dChip(s)),
      el("div", { class: "card-phase" }, chip(s.phase.source === "engine" ? "engine" : "chain-only", s.phase.source === "engine" ? "proof" : "info", s.phase.source === "engine" ? "the engine's own phase from its loop file" : "derived by this console from the two chains only"), el("span", { class: "mono", text: s.phase.value || "unknown" }), el("span", { class: "muted", text: " — " + (s.phase.label || "") })),
      compact ? el("div", { class: "card-title muted", text: s.label }) : null
    );
  }

  function renderList() {
    const ul = $("#swap-list");
    ul.replaceChildren();
    if (!state.data) return;
    for (const s of state.data.swaps) {
      ul.appendChild(el("li", { class: "card-wrap" + (state.selected === s.id ? " selected" : ""), role: "button", tabindex: "0", "aria-pressed": state.selected === s.id ? "true" : "false", onclick: () => select(s.id), onkeydown: (e) => (e.key === "Enter" || e.key === " ") && select(s.id) }, swapCard(s, true)));
    }
  }

  function select(id) {
    state.selected = id;
    history.replaceState(null, "", "#swap=" + id);
    renderList();
    renderStrip();
    renderDetail();
  }

  // ------------------------------------------------------------ detail
  const section = (title, cls, ...children) => el("section", { class: "panel " + (cls || "") }, el("h3", { class: "panel-title", text: title }), ...children);
  const kv = (rows) => el("dl", { class: "kv" }, rows.filter(Boolean).map(([k, v, title]) => [el("dt", { text: k, title: title || null }), el("dd", {}, v === null || v === undefined ? "—" : v)]));

  const GLOSS = {
    wait: (s) => (s.engine.reason && /waiting for D/.test(s.engine.reason) ? `Nothing to do. At height ${n(s.terms.deadline_height)} you can take your NOID back (the recovery close).` : "Nothing to do right now; the engine polls and will say when something is due."),
    fund_noid: () => "Fund the Parano1d HashTimeLock from the wallet (real NOID leaves the wallet).",
    lock_eth: () => "Lock the ETH in the HTLC with the committed hashlock and T_reveal.",
    reveal_eth: () => "Claim the ETH on Ethereum with the secret: this publishes it, after which Bob can claim the NOID.",
    claim_noid: () => "Close the NOID contract to Bob with the revealed secret; it must be final before D.",
    refund_noid: () => "Close the NOID contract back to Alice: the deadline D has passed.",
    refund_eth: () => "Take the ETH back: T_reveal has passed and the secret was never published.",
    abort: () => "The engine stopped this swap; see the reason.",
  };

  function stepNode(st) {
    return el("li", { class: `step step-${st.state}` }, el("span", { class: "step-dot", "aria-hidden": "true" }), el("span", { class: "step-label", text: st.label }), el("span", { class: "step-evidence mono", text: st.detail || (st.state === "pending" ? "—" : "") }));
  }

  function renderDetail() {
    const root = $("#detail");
    if (!state.data) return;
    const s = state.data.swaps.find((x) => x.id === state.selected);
    if (!s) return root.replaceChildren(el("p", { class: "muted", text: "Select a swap." }));
    const t = s.terms || {};
    const tm = s.timers || {};
    const nd = s.noid || {};
    const et = s.eth || {};
    const en = s.engine || {};

    const head = el("header", { class: "detail-head" }, el("h2", { class: "detail-title", text: s.label }), swapCard(s, false));

    const timeline = section("Timeline", "", el("ol", { class: "steps" }, (s.steps || []).map(stepNode)));

    // Action panel: read-only, so never a button; the engine's reason verbatim, then the gloss.
    let actionBody;
    if (!en.connected) {
      actionBody = el("div", {}, el("div", { class: "action-title" }, chip("engine view not connected", "attn"), " ", el("span", { class: "muted small", text: en.reason || "" })), el("p", { class: "muted", text: "No loop file for this swap, so there is no engine decision to show. The phase above is derived from the chains only. Point status_file in swaps.json at the engine's loop text to see its action and reason." }));
    } else {
      const act = en.action || "—";
      const isDone = /^done/.test(en.reason || "") || /done|refunded/.test(en.phase || "");
      const kind = en.stale ? "attn" : isDone ? "ok" : act === "wait" ? "neutral" : act === "abort" ? "danger" : "warn";
      actionBody = el(
        "div",
        {},
        el("div", { class: "action-title" }, el("span", { class: "action-next", text: "Next: " }), chip(en.action_label || act, kind), en.stale ? chip("blocked: observation stale", "attn", en.stale_reason) : null),
        en.reason ? el("blockquote", { class: "reason", text: en.reason }) : el("p", { class: "muted", text: "(no reason given)" }),
        el("p", { class: "gloss", text: (GLOSS[act] || (() => ""))(s) }),
        act !== "wait" && !isDone ? el("p", { class: "muted small", text: "This console does not execute actions. Run the swap-cli / live.js command of the runbook (docs/live-run-*.md) after your own check." }) : null,
        en.action_details && Object.keys(en.action_details).some((k) => k !== "action" && k !== "reason") ? el("code", { class: "mono small block", text: JSON.stringify(Object.fromEntries(Object.entries(en.action_details).filter(([k]) => k !== "action" && k !== "reason"))) }) : null,
        el("div", { class: "muted small engine-meta" }, `engine phase `, el("span", { class: "mono", text: en.phase || "—" }), ` · tick ${en.tick_at || "?"} (exit ${en.exit_code ?? "?"}) · loop file `, el("span", { "data-age-base": en.age_s ?? "", "data-age-at": nowS(), text: `${en.age_s ?? "?"} s old` }), en.stale ? chip("stale", "attn", en.stale_reason) : chip("fresh", "ok"), ` · tips NOID ${n(en.noid_tip)} / ETH #${n(en.eth_latest)}`),
        en.notes && en.notes.length ? el("div", {}, el("div", { class: "panel-sub", text: "Notes" }), el("ul", { class: "notes" }, en.notes.map((x) => el("li", { text: typeof x === "string" ? x : JSON.stringify(x) })))) : null,
        en.events && en.events.length ? el("div", {}, el("div", { class: "panel-sub", text: "Events this tick" }), el("ul", { class: "notes" }, en.events.map((x) => el("li", { class: "mono small", text: typeof x === "string" ? x : JSON.stringify(x) })))) : null
      );
    }
    const action = section("Next step (engine)", "panel-action", actionBody);

    // Gates: the few the console can read from public state.
    const gateRow = (st, name, sentence, numbers) => el("li", { class: `gate gate-${st}` }, dot(st === "pass" ? "ok" : st === "closing" ? "warn" : st === "unknown" ? "attn" : "dim"), el("b", { text: name }), el("span", { class: "muted", text: " — " + sentence }), numbers ? el("span", { class: "mono small", text: " " + numbers }) : null);
    const gates = section(
      "Safety gates (as far as public state shows)",
      "",
      el(
        "ul",
        { class: "gates" },
        gateRow(nd.fund_final === true ? "pass" : nd.fund_final === false ? "closing" : nd.ok ? "unknown" : "unknown", "Finality", "18 blocks after inclusion, a Parano1d transaction cannot be rolled back.", nd.fund_tx && nd.fund_tx.confirmed ? `included ${n(nd.fund_tx.height)}, final at ${n(tm.fund_final_height)}` : "funding height not derivable from the chain alone"),
        gateRow(typeof tm.blocks_to_lock_by !== "number" ? "unknown" : tm.blocks_to_lock_by < 0 ? "passed" : tm.blocks_to_lock_by < 60 ? "closing" : "pass", "Lock-by", "Bob must lock before this height to have time to claim.", typeof t.lock_by_height === "number" ? `${n(t.lock_by_height)} (${typeof tm.blocks_to_lock_by === "number" ? (tm.blocks_to_lock_by >= 0 ? n(tm.blocks_to_lock_by) + " blocks left" : "passed") : "?"})` : ""),
        gateRow(typeof tm.seconds_to_reveal_cutoff !== "number" ? "unknown" : tm.t_reveal_relevant === false ? "passed" : tm.seconds_to_reveal_cutoff <= 0 ? "passed" : tm.seconds_to_reveal_cutoff < 1800 ? "closing" : "pass", "Reveal cutoff (I2)", "Alice must reveal at least 30 min before Bob's refund opens, so her ETH claim is final first.", typeof tm.reveal_cutoff === "number" ? `${hms(tm.reveal_cutoff)} (${tm.t_reveal_relevant === false ? "lock closed" : tm.seconds_to_reveal_cutoff > 0 ? dur(tm.seconds_to_reveal_cutoff) + " left" : "passed"})` : ""),
        gateRow(typeof t.max_fee_micronoid === "number" && typeof nd.fee_estimate_1_1 === "number" ? (t.max_fee_micronoid >= 3 * nd.fee_estimate_1_1 ? "pass" : "closing") : "unknown", "Fee cap (T5)", "The contract's call fee limit must cover three times today's fee estimate.", typeof nd.fee_estimate_1_1 === "number" ? `max_fee ${n(t.max_fee_micronoid)} vs 3 × ${n(nd.fee_estimate_1_1)}` : ""),
        gateRow(typeof t.h_create === "number" && typeof t.deadline_height === "number" ? (t.h_create >= 279388 && !(t.h_create <= 279370 && t.deadline_height + 242 >= 279370) ? "pass" : "passed") : "unknown", "Activation (I5)", "No swap may straddle height 279,370.", typeof t.h_create === "number" ? `window ${n(t.h_create)} … ${n(t.deadline_height)}` : "")
      )
    );

    // Right column: countdown chips, sealed secret, terms, sources.
    const timers = section(
      "Timers",
      "",
      el(
        "div",
        { class: "cds" },
        dChip(s),
        typeof tm.t_reveal === "number"
          ? tm.t_reveal_relevant === false
            ? countdownChip("T_reveal (Bob's refund opens)", `${hms(tm.t_reveal)} · lock closed`, { passed: true, title: ts(tm.t_reveal) })
            : tm.seconds_to_t_reveal <= 0
              ? countdownChip("T_reveal (Bob's refund opens)", `passed ${hms(tm.t_reveal)}`, { passed: true, title: `${ts(tm.t_reveal)}; chain clock ${ts(tm.chain_ts)}` })
              : countdownChip("T_reveal (Bob's refund opens)", `${dur(tm.seconds_to_t_reveal)} · ${hms(tm.t_reveal)}`, { closing: tm.seconds_to_t_reveal < 1800, title: "by the chain clock (latest block timestamp)" })
          : countdownChip("T_reveal (Bob's refund opens)", "—", { unknown: true, title: "no ETH lock" }),
        typeof tm.reveal_cutoff === "number"
          ? tm.t_reveal_relevant === false
            ? countdownChip("reveal cutoff", "moot · lock closed", { passed: true })
            : tm.seconds_to_reveal_cutoff <= 0
              ? countdownChip("reveal cutoff", `passed ${hms(tm.reveal_cutoff)} · do not reveal`, { passed: true })
              : countdownChip("reveal cutoff", `${dur(tm.seconds_to_reveal_cutoff)} · ${hms(tm.reveal_cutoff)}`, { closing: tm.seconds_to_reveal_cutoff < 1800 })
          : countdownChip("reveal cutoff", "—", { unknown: true }),
        typeof t.lock_by_height === "number" ? (typeof tm.blocks_to_lock_by === "number" ? (tm.blocks_to_lock_by < 0 ? countdownChip("lock by", `${n(t.lock_by_height)} · passed`, { passed: true }) : countdownChip("lock by", `${n(t.lock_by_height)} · ${n(tm.blocks_to_lock_by)} blocks`, { closing: tm.blocks_to_lock_by < 60 })) : countdownChip("lock by", `${n(t.lock_by_height)} · —`, { unknown: true })) : null,
        typeof tm.fund_final_height === "number" ? (tm.blocks_to_fund_final <= 0 ? countdownChip("funding final", `${n(tm.fund_final_height)} · reached`, { passed: true }) : countdownChip("funding final", `${n(tm.blocks_to_fund_final)} blocks · ≈ ${dur(tm.blocks_to_fund_final * 30)}`, { closing: true })) : null
      ),
      el("p", { class: "muted small", text: "Blocks are converted to time at 30 s/block and labelled ≈. T_reveal and the cutoff count on the chain clock (latest block timestamp), which is what the contract uses." })
    );

    const secretChip = s.role === "bob"
      ? chip("No secret on this side", "dim")
      : et.preimage_revealed
        ? chip(`Public since block ${n((et.events || []).filter((e) => e.name === "Claimed").map((e) => e.block_number)[0])}`, "dim", "the secret was published by the ETH claim")
        : chip("Secret sealed · in the swap file (not read by this console)", "proof");
    const secret = section("Secret", "", el("div", { class: "secret-row" }, el("span", { class: "lock-glyph", "aria-hidden": "true", text: "🔒" }), secretChip), el("p", { class: "muted small", text: "This console never opens a *.swap.json and never shows a preimage, even once it is public." }));

    const terms = section(
      "Terms",
      "",
      kv([
        ["Expiry block (D)", n(t.deadline_height)],
        ["Call fee limit", typeof t.max_fee_micronoid === "number" ? `${n(t.max_fee_micronoid)} μNOID` : "—"],
        ["h_create / lock by", `${n(t.h_create)} / ${n(t.lock_by_height)}`],
        ["Contract root", hash(t.contract_root, "contract root")],
        ["Hashlock", hash(t.hashlock, "hashlock")],
        ["Claim authority Addr(s)", hash(t.claim_authority, "claim authority")],
        ["Claim recipient (Bob)", hash(t.claim_recipient || t.bob_noid, "Bob's address")],
        ["Recovery (Alice)", hash(t.alice_noid, "Alice's address")],
        ["Lock id", hash(s.receipts && (s.receipts.find((r) => r.label === "ETH lock id") || {}).value, "lock id")],
        ["HTLC contract", hash(t.eth && t.eth.contract, "HTLC contract")],
        ["ETH chain / amount", `${n(t.eth && t.eth.chain_id)} / ${ethAmt(t.eth && t.eth.amount_wei)}`],
        ["HTLC code-hash pin", t.eth && t.eth.code_hash ? hash(t.eth.code_hash, "code hash") : el("span", { class: "muted", text: "not pinned in this swap" })],
        ["Opening", t.opening_len_bytes ? el("span", {}, `${t.opening_len_bytes} bytes `, t.consistent ? chip("object = bundle", "ok") : chip("object ≠ bundle", "danger")) : "—"],
      ])
    );

    // Chain panels.
    const noidPanel = section(
      "Parano1d",
      "panel-noid",
      kv([
        ["Height", el("span", {}, n(nd.tip), nd.ok ? el("span", { class: "muted small", text: ` · next call ${n(nd.next_call_height)}` }) : null)],
        ["Instance", nd.instance ? el("span", {}, `slot ${n(nd.instance.slot_index)} · creation ${n(nd.instance.creation_id)} · ${noid(nd.instance.amount_micronoid)}`, nd.instance_count > 1 ? chip(`${nd.instance_count} instances`, "danger", "double funding?") : null) : nd.ok ? "none (not funded, or already closed)" : "—"],
        ["Matches our opening", nd.matches_opening === null || nd.matches_opening === undefined ? "—" : nd.matches_opening ? chip("yes", "ok") : chip("NO", "danger")],
        ["Active authority", nd.active_authority ? el("span", {}, hash(nd.active_authority, "active authority"), nd.active_authority === t.claim_authority ? chip("claim side · Addr(s)", "proof") : nd.active_authority === t.alice_noid ? chip("recovery side · Alice", "warn") : null) : "—"],
        ["Funding tx", nd.fund_tx ? el("span", {}, hash(nd.fund_tx.txid, "funding txid"), nd.fund_tx.confirmed ? ` included at ${n(nd.fund_tx.height)} ` : el("span", { class: "muted small", text: " not returned by getTx (pending, or pruned: bodies are kept 42 blocks) " }), nd.fund_final === true ? chip("final", "ok") : nd.fund_final === false ? chip(`${n(tm.blocks_to_fund_final)} to final`, "warn") : null) : el("span", { class: "muted", text: "no txid configured" })],
        nd.close_tx ? ["Close tx", el("span", {}, hash(nd.close_tx.txid, "close txid"), nd.close_tx.confirmed ? ` included at ${n(nd.close_tx.height)} ` : el("span", { class: "muted small", text: " not returned by getTx (pending, or pruned: bodies are kept 42 blocks) " }), nd.close_final === true ? chip("final", "ok") : nd.close_final === false ? chip(`${n(tm.blocks_to_close_final)} to final`, "warn") : null)] : null,
        ["Fee estimate (1 in / 1 out)", typeof nd.fee_estimate_1_1 === "number" ? `${n(nd.fee_estimate_1_1)} μNOID · relay floor ${n(nd.relay_floor)}` : "—"],
        ["Mempool", nd.mempool ? `${n(nd.mempool.size)} entries · ${n(nd.mempool.single_page_entries)} single-page · fee floor ${n(nd.mempool.fee_floor)}` : "—"],
        ["Epoch anchor", nd.epoch_anchor ? hash(nd.epoch_anchor, "epoch anchor") : "—"],
        nd.error ? ["Error", chip(nd.error, "danger")] : null,
      ])
    );
    const ethPanel = section(
      "Ethereum",
      "panel-eth",
      kv([
        ["Chain id", et.chain_id === null || et.chain_id === undefined ? "— (unknown)" : n(et.chain_id)],
        ["Latest block", et.latest ? `#${n(et.latest.number)} · ${ts(et.latest.timestamp)} (chain clock, ${dur(tm.eth_block_age_s || 0)} behind wall clock)` : "—"],
        ["Finalized block", et.finalized ? `#${n(et.finalized.number)}` : "— (node reports none)"],
        ["Lock state", et.ok ? el("span", {}, chip(et.state || "?", /claimed|refunded/.test(et.state || "") ? "ok" : /expired/.test(et.state || "") ? "warn" : /not found/.test(et.state || "") ? "neutral" : "info"), et.lock_finalized === true ? chip("lock final", "ok") : et.lock_block !== null && et.lock_block !== undefined ? chip("lock not final", "warn") : null) : "—"],
        et.lock ? ["Lock", `${ethAmt(et.lock.amount_wei)} · from ${short(et.lock.sender)} (Bob) · to ${short(et.lock.receiver)} (Alice)`] : null,
        et.lock ? ["T_reveal (timelock)", `${n(et.lock.timelock)} · ${ts(et.lock.timelock)}`] : null,
        et.preimage_revealed ? ["Preimage", el("span", {}, "revealed on chain ", et.preimage_matches_hashlock ? chip("hashes to H", "ok") : chip("does NOT hash to H", "danger"), el("span", { class: "muted small", text: " (bytes not shown)" }))] : null,
        et.lock_error ? ["getLock", chip("error: " + et.lock_error, "danger")] : null,
        ["Events", et.events && et.events.length ? el("ul", { class: "events" }, et.events.map((e) => el("li", {}, chip(e.name, e.name === "Locked" ? "info" : e.name === "Claimed" ? "ok" : "warn"), ` block ${n(e.block_number)} `, hash(e.tx_hash, e.name + " tx")))) : et.ok ? "none for this lock id" : "—"],
        et.error ? ["Error", chip(et.error, "danger")] : null,
      ])
    );

    const checks = section(
      "Checks",
      "",
      s.checks && s.checks.length ? el("ul", { class: "checks" }, s.checks.map((c) => el("li", {}, c.ok ? chip("ok", "ok") : chip("MISMATCH", "danger"), " " + c.name, c.detail ? el("span", { class: "muted small", text: " (" + c.detail + ")" }) : null))) : el("p", { class: "muted", text: "nothing to check yet" })
    );

    // Log & receipts: reverse-chronological rows (chain dot, name, sentence, hash with copy).
    const rows = [];
    for (const e of et.events || []) rows.push({ when: `block ${n(e.block_number)}`, chain: "eth", name: `eth_${e.name.toLowerCase()}`, text: e.name === "Locked" ? "Bob locked the ETH" : e.name === "Claimed" ? "Alice claimed the ETH and published the secret" : "Bob took his ETH back", hashv: e.tx_hash, order: e.block_number });
    if (nd.fund_tx) rows.push({ when: nd.fund_tx.confirmed ? `height ${n(nd.fund_tx.height)}` : "height ?", chain: "noid", name: "noid_funded", text: nd.fund_tx.confirmed ? "Alice funded the HashTimeLock" : "funding txid (getTx returned nothing: pending or pruned)", hashv: nd.fund_tx.txid, order: nd.fund_tx.height || 0 });
    if (nd.close_tx) rows.push({ when: nd.close_tx.confirmed ? `height ${n(nd.close_tx.height)}` : "height ?", chain: "noid", name: "noid_closed", text: nd.close_tx.confirmed ? (nd.close_final ? "the NOID contract was closed (final)" : "the NOID contract was closed (not yet final)") : "close txid (getTx returned nothing: pending or pruned)", hashv: nd.close_tx.txid, order: nd.close_tx.height || 0 });
    if (en.connected && en.events) for (const ev of en.events) rows.push({ when: en.tick_at, chain: "engine", name: typeof ev === "string" ? ev : ev.event || JSON.stringify(ev), text: "engine event", hashv: null, order: Infinity });
    rows.sort((a, b) => b.order - a.order);
    const ids = (s.receipts || []).filter((r) => ["noid_address", "hex32", "eth_address"].includes(r.kind) && !/^Hashlock|^Claim authority|^NOID contract root|^ETH HTLC/.test(r.label));
    const log = section(
      "Log & receipts",
      "",
      rows.length ? el("ul", { class: "log" }, rows.map((r) => el("li", { class: "log-row" }, el("span", { class: "log-when mono", text: r.when }), dot(r.chain === "noid" ? "noid" : r.chain === "eth" ? "eth" : "proof"), el("code", { class: "mono log-name", text: r.name }), el("span", { class: "log-text", text: r.text }), r.hashv ? hash(r.hashv, r.name) : null))) : el("p", { class: "muted", text: "Nothing recorded yet — the first tick writes here." }),
      ids.length ? el("div", {}, el("div", { class: "panel-sub", text: "Identifiers" }), kv(ids.map((r) => [r.label, hash(r.value, r.label)]))) : null,
      el("p", { class: "muted small", text: "Receipt files (claim.receipt etc.) stay on disk; this console does not read or save them." })
    );

    root.replaceChildren(head, el("div", { class: "grid-main" }, el("div", { class: "col-wide" }, timeline, action, gates, el("div", { class: "two" }, noidPanel, ethPanel), checks), el("div", { class: "col-side" }, timers, secret, terms)), log);
  }

  // ------------------------------------------------------------ polling
  async function refresh() {
    $("#poll").textContent = "refreshing…";
    try {
      const res = await fetch("/api/swaps", { cache: "no-store", headers: TOKEN ? { "x-swap-token": TOKEN } : {} });
      if (res.status === 401) throw new Error("no key: open the start URL printed in the console's terminal (it ends in #token=...)");
      if (!res.ok) throw new Error("HTTP " + res.status);
      state.data = await res.json();
      state.lastFetch = Date.now();
      state.error = null;
      const m = $("#mode");
      m.textContent = state.data.mode === "mock" ? "mock data" : "live · read-only";
      m.className = "chip " + (state.data.mode === "mock" ? "chip-warn" : "chip-ok");
      if (!state.selected && state.data.swaps.length) {
        const fromHash = /swap=([a-z0-9-]+)/.exec(location.hash);
        state.selected = fromHash && state.data.swaps.some((s) => s.id === fromHash[1]) ? fromHash[1] : state.data.swaps[0].id;
      }
    } catch (e) {
      state.error = e.message;
    }
    try {
      renderList();
      renderStrip();
      renderDetail();
    } catch (e) {
      const b = $("#banner");
      b.className = "banner banner-danger";
      b.textContent = "Render error: " + e.message;
      b.hidden = false;
    }
    updateLive();
  }
  function updateLive() {
    const p = $("#poll");
    if (!state.lastFetch) p.textContent = state.error ? "no data yet · " + state.error : "connecting…";
    else {
      const age = Math.round((Date.now() - state.lastFetch) / 1000);
      p.textContent = `updated ${hms(state.lastFetch / 1000)} · ${age} s ago` + (state.error ? " · last refresh failed" : "");
      p.className = age > 60 || state.error ? "attn" : "muted";
    }
    for (const e of document.querySelectorAll("[data-observed]")) {
      const at = Number(e.dataset.observed);
      if (!at) continue;
      const age = nowS() - at;
      if (e.dataset.stale || age > 120) {
        e.textContent = "Observation stale — engine fails closed";
        const cap = e.closest(".capsule");
        if (cap) cap.className = cap.className.replace(/capsule-(ok|warn|attn)/, "capsule-attn");
      } else e.textContent = `observed ${age} s ago`;
    }
    for (const e of document.querySelectorAll("[data-age-base]")) {
      const base = Number(e.dataset.ageBase);
      if (!Number.isFinite(base) || e.dataset.ageBase === "") continue;
      e.textContent = `${base + (nowS() - Number(e.dataset.ageAt))} s old`;
    }
  }

  $("#refresh").addEventListener("click", refresh);
  $("#theme").addEventListener("click", () => {
    const h = document.documentElement;
    h.dataset.theme = h.dataset.theme === "light" ? "dark" : "light";
    try {
      localStorage.setItem("noid-swap-theme", h.dataset.theme);
    } catch {
      /* ignore */
    }
  });
  try {
    const saved = localStorage.getItem("noid-swap-theme");
    if (saved) document.documentElement.dataset.theme = saved;
  } catch {
    /* ignore */
  }
  window.addEventListener("hashchange", () => {
    const m = /swap=([a-z0-9-]+)/.exec(location.hash);
    if (m && state.data && state.data.swaps.some((s) => s.id === m[1])) select(m[1]);
  });

  const backLink = document.querySelector('a[href="/"]');
  if (backLink && TOKEN) backLink.href = "/#token=" + TOKEN;
  refresh();
  setInterval(refresh, POLL_MS);
  setInterval(updateLive, 1000);
})();
