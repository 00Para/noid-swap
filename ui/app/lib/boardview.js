"use strict";
/*
 * DOM-free logic of the board's screens (offers, take and deposit, progress, done and refunded). Pure: input is the run payload (`board`, `actions`, `terms`, the view model)
 * and the current time; output is plain objects the page (board.js) draws and the tests read. Loaded by the browser (window.NoidBoardView, after viewmodel.js) and by node.
 *
 * Rules kept here, once:
 *   - a field of an offer is shown only if it is exactly what the offer validator passes (digits, a fixed word, a hex address); anything else drops the offer, it is never cleaned;
 *   - every amount is formatted from an integer in its smallest unit (micro-NOID, wei) by the view model's own formatters;
 *   - a deposit address is shown only from a wallet status that proved the key owns it (the same rule as the deposit box of the operator page);
 *   - an engine phase that this table does not know is "unknown": the page says the app is checking, it never guesses a step;
 *   - no time is invented: the only times are the approval's, and the lock end rows the view model already has.
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory(require("./viewmodel"));
  else root.NoidBoardView = factory(root.NoidView);
})(typeof self !== "undefined" ? self : this, function (V) {
  "use strict";

  const BLOCK_S = 30; // Parano1d nominal block time, as the view model uses it
  const USUAL_MINUTES = 50; // a normal swap, as the live runs measured it (README: runs 14 and 19)
  const INT = /^(0|[1-9][0-9]{0,29})$/;
  const isInt = (s) => typeof s === "string" && INT.test(s);
  const own = (o, k) => Object.prototype.hasOwnProperty.call(o || {}, k);

  // ------------------------------------------------------------------------------------------------ amounts and words
  const trimDec = (t) => (String(t).includes(".") ? String(t).replace(/0+$/, "").replace(/\.$/, "") : String(t));
  /** micro-NOID (an integer as text) as "5 NOID"; null when it is not an integer. */
  function noidWords(micro) {
    const s = typeof micro === "number" && Number.isSafeInteger(micro) && micro >= 0 ? String(micro) : micro;
    if (!isInt(s)) return null;
    return `${trimDec(V.noidText(s))} NOID`;
  }
  /** wei (an integer as text) as "0.001 ETH"; null when it is not an integer. */
  function ethWords(wei) {
    if (!isInt(wei)) return null;
    const t = V.ethText(wei);
    return t === null ? null : `${trimDec(t)} ETH`;
  }
  /** The price: wei for one whole NOID, as ETH. */
  const priceWords = (p) => (isInt(p) ? `${trimDec(V.ethText(p))} ETH for each NOID` : null);
  const shortId = (id) => (typeof id === "string" && /^[0-9a-f]{64}$/.test(id) ? `${id.slice(0, 4)}-${id.slice(4, 8)}` : null);
  const shortAddr = (a) => (typeof a === "string" && a.length > 20 ? `${a.slice(0, 10)}…${a.slice(-6)}` : a);

  /** A decimal the person typed, as an integer in the smallest unit (text), or null. Strict: digits, one optional point, no sign, no exponent, no separators. */
  function decimalToUnits(text, decimals) {
    const m = /^(0|[1-9][0-9]{0,11})(?:\.([0-9]{1,18}))?$/.exec(String(text === undefined || text === null ? "" : text).trim());
    if (!m) return null;
    const frac = m[2] || "";
    if (frac.length > decimals) return null;
    const v = BigInt(m[1]) * 10n ** BigInt(decimals) + BigInt(frac.padEnd(decimals, "0") || "0");
    return v.toString();
  }

  const CHAIN_NAMES = { 11155111: "Sepolia test network", 31337: "a local test chain" };
  const chainName = (id) => (Number.isInteger(id) && own(CHAIN_NAMES, id) ? CHAIN_NAMES[id] : Number.isInteger(id) ? `chain ${id}` : "an unknown network");

  /** The amount a person types to approve, compared as numbers (the server's rule): "20 NOID" against "20.0 noid". */
  function typedOk(typed, expected) {
    const m = /^\s*(\d{1,12})(?:\.(\d{1,18}))?\s*([A-Za-z]{3,4})\s*$/.exec(String(typed || ""));
    const e = /^(\d+)(?:\.(\d+))?\s+([A-Z]+)$/.exec(String(expected || ""));
    if (!m || !e || m[3].toUpperCase() !== e[3]) return false;
    const norm = (w, f) => `${BigInt(w)}.${(f || "").padEnd(18, "0")}`;
    return norm(m[1], m[2]) === norm(e[1], e[2]);
  }
  const expectedUnit = (expected) => {
    const e = /^(\d+(?:\.\d+)?)\s+([A-Z]+)$/.exec(String(expected || ""));
    return e ? { amount: e[1], unit: e[2] } : null;
  };

  // ------------------------------------------------------------------------------------------------ offers
  const SIDES = ["sell-noid", "buy-noid"];
  const PROFILE_RE = /^[a-z]{3,16}$/;
  const HTLC_RE = /^0x[0-9a-fA-F]{40}$/;

  /**
   * One offer of the payload, checked field by field against what the validator passes, as the person sees it. null when anything is off (the offer is dropped, never repaired).
   * `role` is this console's own role: an Alice takes offers that buy NOID, a Bob takes offers that sell NOID.
   */
  function offerOf(o, role) {
    if (!o || typeof o !== "object") return null;
    if (typeof o.id !== "string" || !/^[0-9a-f]{64}$/.test(o.id)) return null;
    if (!SIDES.includes(o.side)) return null;
    if (!isInt(o.noid_micro) || o.noid_micro === "0" || !isInt(o.wei) || o.wei === "0") return null;
    if (!Number.isSafeInteger(o.chain_id) || o.chain_id < 1) return null;
    if (typeof o.profile !== "string" || !PROFILE_RE.test(o.profile)) return null;
    if (typeof o.htlc !== "string" || !HTLC_RE.test(o.htlc)) return null;
    if (o.contract_version !== "1" && o.contract_version !== "2") return null;
    if (o.lock !== "poseidon" || o.variant !== "raw") return null;
    if (!isInt(o.price_wei_per_noid)) return null;
    if (!Number.isSafeInteger(o.expires_at) || o.expires_at < 0) return null;
    const wants = role === "bob" ? "sell-noid" : role === "alice" ? "buy-noid" : null;
    if (o.side !== wants) return null;
    const noid = noidWords(o.noid_micro);
    const eth = ethWords(o.wei);
    if (!noid || !eth) return null;
    const sells = o.side === "sell-noid";
    return {
      id: o.id,
      short_id: shortId(o.id),
      side: o.side,
      what: sells ? `Sell ${noid} for ${eth}` : `Buy ${noid} for ${eth}`,
      noid_words: noid,
      eth_words: eth,
      // the poster sells NOID: the taker (Bob) gives ETH and gets NOID; the poster buys NOID: the taker (Alice) gives NOID and gets ETH
      give: sells ? { coin: "ETH", words: eth } : { coin: "NOID", words: noid },
      get: sells ? { coin: "NOID", words: noid } : { coin: "ETH", words: eth },
      price: priceWords(o.price_wei_per_noid),
      price_value: trimDec(V.ethText(o.price_wei_per_noid)),
      price_wei_per_noid: o.price_wei_per_noid,
      noid_micro: o.noid_micro,
      wei: o.wei,
      chain_id: o.chain_id,
      profile: o.profile,
      htlc: o.htlc,
      contract_version: o.contract_version,
      lock: o.lock,
      variant: o.variant,
      expires_at: o.expires_at,
    };
  }

  /** The offers the page lists: only the ones that pass offerOf, at most 50, in the order the server gave (smallest first). */
  function offerList(board, role) {
    const out = [];
    for (const o of Array.isArray(board && board.offers) ? board.offers : []) {
      const x = offerOf(o, role);
      if (x) out.push(x);
      if (out.length >= 50) break;
    }
    return out;
  }

  /** Minutes (rounded up) an offer stays on the board, from its expiry; 0 when it is over. */
  const minutesOpen = (expiresAt, now) => Math.max(0, Math.ceil((expiresAt - now) / 60));

  // ------------------------------------------------------------------------------------------------ the terms, every one once
  /**
   * What the swap is, from the offer and the person's own settings. These are exactly the terms the approval is bound to (amounts, chain, contract, contract version, lock kind,
   * variant, profile, payout addresses): the take screen and the approval screen call this one function with the same two inputs.
   * `offer` is a checked offer (offerOf) or the board's `offer` object (checked here by the same rules, with the side taken from the role).
   */
  function termRows(offer, payouts, role) {
    if (!offer) return null;
    const alice = role === "alice";
    const noid = noidWords(offer.noid_micro);
    const eth = ethWords(offer.wei);
    if (!noid || !eth) return null;
    const p = payouts && typeof payouts === "object" ? payouts : {};
    const arriveAddr = alice ? p.eth : p.noid;
    return {
      role: alice ? "alice" : "bob",
      give: alice ? { coin: "NOID", words: noid, units: offer.noid_micro } : { coin: "ETH", words: eth, units: offer.wei },
      get: alice ? { coin: "ETH", words: eth, units: offer.wei } : { coin: "NOID", words: noid, units: offer.noid_micro },
      price: priceWords(offer.price_wei_per_noid),
      arrive: { coin: alice ? "ETH" : "NOID", address: typeof arriveAddr === "string" && arriveAddr ? arriveAddr : null, via_swap_key: alice },
      leftover: { coin: alice ? "NOID" : "ETH", address: typeof (alice ? p.noid : p.eth) === "string" && (alice ? p.noid : p.eth) ? (alice ? p.noid : p.eth) : null },
      chain_id: offer.chain_id,
      network: chainName(offer.chain_id),
      profile: offer.profile,
      contract: offer.htlc,
      contract_version: offer.contract_version,
      lock: offer.lock,
      variant: offer.variant,
      offer_id: typeof offer.id === "string" ? offer.id : null,
      short_id: shortId(offer.id),
      payouts_set: !!arriveAddr,
    };
  }

  /** The offer the board carries now (after a take or a post), in the shape offerOf makes, without the side check (the role decides what is given and got). */
  function boardOffer(board) {
    const o = board && board.offer;
    if (!o || typeof o !== "object") return null;
    if (!isInt(o.noid_micro) || !isInt(o.wei) || !isInt(o.price_wei_per_noid)) return null;
    if (!Number.isSafeInteger(o.chain_id) || typeof o.profile !== "string" || !PROFILE_RE.test(o.profile)) return null;
    if (typeof o.htlc !== "string" || !HTLC_RE.test(o.htlc) || (o.contract_version !== "1" && o.contract_version !== "2")) return null;
    if (o.lock !== "poseidon" || o.variant !== "raw") return null;
    return { id: typeof board.offer_id === "string" ? board.offer_id : null, noid_micro: o.noid_micro, wei: o.wei, price_wei_per_noid: o.price_wei_per_noid, chain_id: o.chain_id, profile: o.profile, htlc: o.htlc, contract_version: o.contract_version, lock: o.lock, variant: o.variant };
  }

  // ------------------------------------------------------------------------------------------------ the board's own step
  // The machine's states (lib/board/handover.js) as a step of the screens. Alice's deposit and approval open once the bundle exists (she may approve before Bob's check: the funding
  // waits for it); Bob's open when his own check of the bundle is done.
  const STATE_STEP = {
    no_offer: "choose",
    idle: "getting_ready",
    open: "waiting_take",
    taking: "waiting_accept",
    await_addresses: "getting_ready",
    bob_setup: "getting_ready",
    bob_signing_addresses: "getting_ready",
    addresses_sent: "getting_ready",
    alice_setup: "getting_ready",
    preparing: "getting_ready",
    bundle_wait_tip: "deposit",
    bundle_sent: "deposit",
    joining: "getting_ready",
    await_ready: "deposit",
    bob_signing_checked: "running",
    checked_sent: "running",
    checked: "running",
    funded_sent: "running",
    watching: "running",
    stopped: "stopped",
    finished: "over",
    settled: "over",
    refunded: "over",
    recovered: "over",
    aborted: "over",
  };
  /** The step enum of the board, from its `state`; "unknown" for a state this table does not have. Alice's `checked` (Bob's verified answer, before her funding) is a deposit step too. */
  function handoverStep(state, role) {
    if (typeof state !== "string") return "unknown";
    if (role === "alice" && state === "checked") return "deposit";
    return own(STATE_STEP, state) ? STATE_STEP[state] : "unknown";
  }

  // Words for what the board waits for while the swap is being made ready (the `waiting_for` codes of lib/board/host.js PHASE_WAIT), in plain words.
  const READY_WORDS = {
    take: "Waiting for someone to take the offer.",
    accept: "Waiting for the other side to accept the take.",
    bob_addresses: "Waiting for the other side's address.",
    bob_wallet: "The app is making the wallet it uses for this swap.",
    alice_wallet: "The app is making the wallets it uses for this swap.",
    signature: "The app is signing an answer with this swap's key.",
    bundle: "Waiting for the swap's file from the other side.",
    prepare: "The app is preparing the swap's file. This takes a few minutes.",
    bob_check: "Waiting for the other side to check the swap's file.",
    tip: "The app is reading the latest Parano1d block.",
    join: "The app is checking the swap's file against your own terms.",
    deposit_and_approval: "Waiting for your deposit and your approval.",
    engine: "The app has taken over.",
  };
  const readyWords = (code) => (typeof code === "string" && own(READY_WORDS, code) ? READY_WORDS[code] : "The app is getting the swap ready.");

  const STOP_WORDS = {
    declined: "The other side declined.",
    cancelled_here: "You cancelled.",
    cancelled_by_peer: "The other side cancelled.",
    time_limit: "A time limit passed before the other side answered.",
    bad_signature: "An answer from the other side could not be verified.",
    refused: "The swap's file did not match your terms, so the app refused it.",
    h_create_range: "The swap's start time was out of range, so the app refused it.",
    digest_mismatch: "The files did not match each other.",
    bad_bundle: "The swap's file could not be used.",
    helper_failed: "A step of the app failed.",
    bad_addresses: "The addresses the other side sent were not acceptable.",
    bad_message: "A message from the other side broke the rules.",
    other: "The offer ended.",
  };
  const stopWords = (code) => (typeof code === "string" && own(STOP_WORDS, code) ? STOP_WORDS[code] : STOP_WORDS.other);

  // ------------------------------------------------------------------------------------------------ the engine's phases as steps in the person's words
  /*
   * Every phase id of both roles (lib/phases.js) maps to exactly ONE step: `step` is the step that is current while the engine is in that phase, `track` where the swap is
   * ("main", "recovery" for the coins coming back, "end" for a result), `say` one plain sentence about now. The steps before the current one are done, the ones after are to do.
   * A phase that is not in this table is unknown: nothing is guessed.
   */
  const MAIN_STEPS = {
    alice: ["approved", "locked_yours", "locked_theirs", "completing", "arrived"],
    bob: ["approved", "locked_theirs", "locked_yours", "completing", "arrived"],
  };
  const PHASE_STEP = {
    alice: {
      created: { step: "locked_yours", track: "main", say: "Your approval is saved. The app locks your NOID as soon as it has checked everything once more." },
      funding_submitted: { step: "locked_yours", track: "main", say: "Your NOID were sent to the swap. The app is waiting to see them arrive." },
      funded: { step: "locked_yours", track: "main", say: "Your NOID are in the swap. The network needs about 18 blocks, roughly 9 minutes, to settle them." },
      funding_final: { step: "locked_theirs", track: "main", say: "Your NOID are settled in the swap. Waiting for the other side to lock their ETH." },
      lock_seen: { step: "locked_theirs", track: "main", say: "The other side locked their ETH. Ethereum needs about 15 to 20 minutes to settle it, and the app waits for that." },
      lock_final: { step: "completing", track: "main", say: "The other side's ETH is settled. The app takes it for you now." },
      reveal_submitted: { step: "completing", track: "main", say: "The app sent the step that takes your ETH and is waiting for it to be mined." },
      revealed: { step: "completing", track: "main", say: "The step that takes your ETH is mined. Waiting for Ethereum to settle it. The other side can now take your NOID." },
      done: { step: "arrived", track: "main", say: "Your ETH is yours. The swap is complete." },
      refund_submitted: { step: "returning", track: "recovery", say: "The swap did not complete. The app sent the step that brings your NOID back." },
      refund_included: { step: "returning", track: "recovery", say: "The step that brings your NOID back is in a block. Waiting for about 18 blocks to settle it." },
      refunded: { step: "returned", track: "end", say: "Your NOID are back." },
      lost: { step: "lost", track: "end", say: "The swap did not end as planned." },
      aborted: { step: "stopped", track: "end", say: "The swap stopped." },
    },
    bob: {
      received: { step: "locked_theirs", track: "main", say: "The swap's file is checked. Waiting for the other side's NOID to go into the swap." },
      funded: { step: "locked_theirs", track: "main", say: "The other side's NOID are in the swap. Waiting for the network to settle them." },
      funding_final: { step: "locked_yours", track: "main", say: "The other side's NOID are settled. The app locks your ETH now." },
      lock_submitted: { step: "locked_yours", track: "main", say: "The app sent your ETH into the swap and is waiting for it to be mined." },
      locked: { step: "completing", track: "main", say: "Your ETH is held by the swap. Waiting for the other side to take it. Then the app takes your NOID." },
      secret_seen: { step: "completing", track: "main", say: "The other side took your ETH. The app takes your NOID now. This step has a deadline." },
      claim_submitted: { step: "completing", track: "main", say: "The app sent the step that takes your NOID and is waiting for it to be mined." },
      claim_included: { step: "completing", track: "main", say: "The step that takes your NOID is in a block. Waiting for about 18 blocks to settle it." },
      done: { step: "arrived", track: "main", say: "Your NOID is yours. The swap is complete." },
      refund_submitted: { step: "returning", track: "recovery", say: "The swap did not complete. The app sent the step that brings your ETH back." },
      refund_mined: { step: "returning", track: "recovery", say: "The step that brings your ETH back is in a block. Waiting for Ethereum to settle it." },
      refunded: { step: "returned", track: "end", say: "Your ETH is back." },
      aborted: { step: "stopped", track: "end", say: "The swap stopped." },
    },
  };

  /** `{step, track, say}` for a phase of a role, or null when the table does not know it. */
  function stepOf(role, phaseId) {
    if (role !== "alice" && role !== "bob") return null;
    if (typeof phaseId !== "string" || !own(PHASE_STEP[role], phaseId)) return null;
    return PHASE_STEP[role][phaseId];
  }

  /** The words of each main step, in the states "done", "now" and "todo", from the amounts the person agreed. */
  function stepTitles(role, offer) {
    const noid = offer && noidWords(offer.noid_micro);
    const eth = offer && ethWords(offer.wei);
    const alice = role === "alice";
    const mine = alice ? noid : eth; // what this person gives
    const theirs = alice ? eth : noid; // what this person gets
    return {
      approved: { done: "You approved the swap", now: "You approved the swap", todo: "You approve the swap", sub: "Your approval is saved. From here the app works by itself." },
      locked_yours: { done: `Your ${mine || "coins"} are locked in`, now: `Your ${mine || "coins"} are being locked in`, todo: `Your ${mine || "coins"} get locked in`, sub: "They are held by the swap. They can only go to the other side, or back to you." },
      locked_theirs: { done: "The other side locked theirs", now: "The other side is locking theirs", todo: "The other side locks theirs", sub: `${alice ? "ETH" : "NOID"} ${theirs ? "(" + theirs + ") " : ""}is held by the swap for you.` },
      completing: { done: "The swap is complete", now: "The swap is completing", todo: "The swap completes", sub: "Both sides take their coins. Each waits for its network to settle." },
      arrived: { done: `Your ${theirs || "coins"} arrived`, now: `Your ${theirs || "coins"} are arriving`, todo: `Your ${theirs || "coins"} arrive`, sub: alice ? "The ETH is taken by a key the app made for this swap, and the app then sends it on to your own address." : "The NOID is paid to your own address." },
    };
  }

  /** The rail of the progress screen: the main steps with their state, from the phase. `unknown` phases give no rail. */
  function rail(role, phaseId, offer) {
    const hit = stepOf(role, phaseId);
    if (!hit) return null;
    const order = MAIN_STEPS[role];
    const titles = stepTitles(role, offer);
    // on the recovery track the swap got as far as its funding; the steps the swap never reached are not drawn as to do
    const cur = hit.track === "main" ? order.indexOf(hit.step) : -1;
    const done = hit.track === "main" && hit.step === "arrived";
    return order.map((id, i) => {
      let state;
      if (hit.track !== "main") state = id === "approved" ? "done" : "skipped";
      else if (done) state = "done";
      else state = i < cur ? "done" : i === cur ? "now" : "todo";
      return { id, state, title: titles[id][state === "skipped" ? "todo" : state], sub: state === "now" ? hit.say : titles[id].sub };
    });
  }

  /** Which ending a phase is, or null while the swap is still going: "done" (only once nothing is left to do: `finished`), "refunded", "stopped" or "lost". */
  function endKind(role, phaseId, finished) {
    const hit = stepOf(role, phaseId);
    if (!hit) return null;
    if (phaseId === "done") return finished === true ? "done" : null;
    if (hit.step === "returned") return "refunded";
    if (hit.step === "stopped") return "stopped";
    if (hit.step === "lost") return "lost";
    return null;
  }

  /** True once the swap's coins are in play on a chain (the phase is past the first one): from then on the approval is not what the screen is about. */
  const START_PHASE = { alice: "created", bob: "received" };
  const phaseStarted = (role, phaseId) => !!stepOf(role, phaseId) && phaseId !== START_PHASE[role];

  // ------------------------------------------------------------------------------------------------ the deposit
  /**
   * What the deposit rows say, from the wallet status the server kept: `state` "noswap" (no swap file yet: nothing is shown), "unread" (no status yet), "unclean" (a status that is not
   * clean or not about this swap's own addresses: no address is shown, "do not deposit anywhere") or "ok" with the rows. An address appears ONLY in the "ok" case, from a status that
   * said `show` (the helper proved the key owns the Ethereum address; the console checked the addresses against the swap's own).
   */
  function depositRows(payload, role) {
    const a = payload && payload.actions;
    const w = a && a.wallet && a.wallet.on === true ? a.wallet : null;
    if (!w) return { state: "none", rows: [] };
    const r = (w.roles || {})[role] || {};
    const s = r.status || null;
    if (!r.swap_file) return { state: "noswap", rows: [] };
    if (!s) return { state: "unread", rows: [] };
    if (!s.ok || !s.show) return { state: "unclean", rows: [], problems: Array.isArray(s.problems) ? s.problems.map(String).slice(0, 4) : [], clean: !!s.ok };
    const rows = [];
    const addr = (x) => (typeof x === "string" && x ? x : null);
    if (role === "alice" && s.noid && addr(s.noid.address) && isInt(String(s.noid.need_micronoid)) && isInt(String(s.noid.amount_micronoid))) {
      const n = s.noid;
      const fee = BigInt(n.need_micronoid) - BigInt(n.amount_micronoid);
      rows.push({ coin: "NOID", address: n.address, need_words: noidWords(String(n.need_micronoid)), amount_words: noidWords(String(n.amount_micronoid)), reserve_words: fee >= 0n ? noidWords(fee.toString()) : null, seen: n.covers === true, holds_words: isInt(String(n.plain_micronoid)) ? noidWords(String(n.plain_micronoid)) : null });
    }
    if (s.eth && addr(s.eth.address) && isInt(String(s.eth.required_wei))) {
      const e = s.eth;
      const amount = isInt(String(e.amount_wei)) ? String(e.amount_wei) : "0";
      const reserve = BigInt(e.required_wei) - BigInt(amount);
      rows.push({ coin: "ETH", address: e.address, need_words: ethWords(String(e.required_wei)), amount_words: amount !== "0" ? ethWords(amount) : null, reserve_words: reserve >= 0n ? ethWords(reserve.toString()) : null, seen: e.covered === true, holds_words: isInt(String(e.balance_wei)) ? ethWords(String(e.balance_wei)) : null, short_words: isInt(String(e.shortfall_wei)) && e.shortfall_wei !== "0" ? ethWords(String(e.shortfall_wei)) : null });
    }
    return { state: "ok", rows, age_s: typeof s.age_s === "number" ? s.age_s : null, all_seen: rows.length > 0 && rows.every((x) => x.seen) };
  }

  // ------------------------------------------------------------------------------------------------ the approval
  // The two statements the server asks for in a board run (lib/autopilot.js), in plain words; the server's own text is used for any other id.
  const STATEMENT_WORDS = {
    stay_on: "I will keep this computer on and this app open until the swap is over.",
    no_manual_steps: "I understand that the app now sends my coins by itself, with no more questions, and that I will not send any step of this swap by hand.",
  };

  /**
   * The approval's facts, from `actions.autopilot[role]` and the deposit: what to type, the ticks (the server's statements, then the one the page asks for the payout address),
   * and why the button is off. The page never decides that an approval is valid: the server does, and its answer is shown.
   */
  function approvalFacts(payload, role, deposit, token, terms) {
    const x = payload && payload.actions && payload.actions.autopilot && payload.actions.autopilot[role];
    if (!x || x.available !== true) return { available: false, why: "The app cannot give an approval on this console." };
    const statements = (Array.isArray(x.statements) ? x.statements : []).filter((s) => s && typeof s.id === "string" && /^[a-z_]{1,40}$/.test(s.id)).map((s) => ({ id: s.id, text: own(STATEMENT_WORDS, s.id) ? STATEMENT_WORDS[s.id] : String(s.text || "") }));
    const unit = expectedUnit(x.expected_typed);
    const arrive = terms && terms.arrive && terms.arrive.address ? terms.arrive : null;
    const payoutText = terms ? `The address that receives my ${terms.get.words}, ${arrive ? shortAddr(arrive.address) : "(not set)"}, is mine.` : "The address that receives my coins is mine.";
    let why = null;
    if (!token) why = "This page lost its key. Open the start address printed in the terminal again.";
    else if (x.on === true) why = "The swap is already approved.";
    else if (!unit) why = "Not available yet: the swap's terms are not ready.";
    else if (!terms || !terms.payouts_set) why = "Not available yet: your own address is not set.";
    else if (deposit && deposit.state !== "ok") why = deposit.state === "unclean" ? "Not available yet: the app cannot show a safe deposit address, so nothing was read." : "Not available yet: your deposit has not been read.";
    else if (deposit && !deposit.all_seen) why = "Not available yet: your deposit has not been seen.";
    return {
      available: true,
      on: x.on === true,
      terms_changed: x.terms_changed === true,
      expected: x.expected_typed || null,
      unit: unit ? unit.unit : null,
      amount: unit ? unit.amount : null,
      statements,
      payout_tick: { id: "payout_mine", text: payoutText },
      why,
      board_run: x.board === true,
      funding_offered: x.funding_offered,
    };
  }

  // ------------------------------------------------------------------------------------------------ "needs you"
  // Plain words for the step an autopilot entry is about (the ids of lib/autopilot.js); the server's own text goes to a folded "the tool's words".
  const SPEND_WORDS = {
    "send-fund": "locking your NOID",
    "send-lock": "locking your ETH",
    "send-reveal": "taking your ETH",
    "send-reveal-replace": "taking your ETH again",
    "send-claim": "taking your NOID",
    "send-refund-eth": "getting your ETH back",
    "send-refund-eth-replace": "getting your ETH back again",
    "send-recover": "getting your NOID back",
    "send-sweep-noid": "sending what is left of your NOID to your address",
    "send-sweep-eth-alice": "sending what is left of your ETH to your address",
    "send-sweep-eth-bob": "sending what is left of your ETH to your address",
  };
  /**
   * The reasons the swap needs the person, as fixed words (never the tool's text): an autopilot entry (a step it stopped), the approval that is off by itself, a page that
   * cannot see the swap, an error the board caught. Each has `code`, `title`, `text`; `tool_words` is the server's own sentence (shown only folded, as text).
   */
  function needsYou(f) {
    const out = [];
    const ap = f.ap || {};
    for (const n of Array.isArray(ap.needs_you) ? ap.needs_you : []) {
      const spend = n && typeof n.spend === "string" ? n.spend : "";
      // a short deposit (or the engine's "too late"): the console's own sentence, which goes away by itself; nothing was stopped and there is no "will not try again"
      if (n && n.kind === "deposit") {
        out.push({ code: spend === "deposit-closed" ? "deposit_closed" : "deposit_short", title: spend === "deposit-closed" ? "It is too late for this swap" : "Your deposit is short", text: typeof n.reason === "string" ? n.reason : "", tool_words: null });
        continue;
      }
      out.push({
        code: "step_stopped",
        title: `The app stopped ${own(SPEND_WORDS, spend) ? SPEND_WORDS[spend] : "a step"}`,
        text: "It could not be sure what happened, so it will not try again by itself. Nothing more is sent for it until you have looked. Open Details to see the tool's own words.",
        tool_words: typeof n.reason === "string" ? n.reason : null,
      });
    }
    if (ap.terms_changed === true) out.push({ code: "approval_off", title: "The app stopped acting for you", text: "The terms, or a file they are bound to, changed after you approved, so the approval no longer holds. Check the terms in Details, then approve again if they are right.", tool_words: null });
    if (f.blind === true) out.push({ code: "blind", title: "The app cannot see the swap right now", text: "It has not heard from the part that watches the networks for some time. Your coins stay where they are, and they come back by themselves if the swap cannot finish in time. Open Details to see why.", tool_words: null });
    if (f.board && typeof f.board.error === "string" && f.board.error) out.push({ code: "board_error", title: "The board hit an error and went on", text: "The swap itself is not affected. The error is in the audit log, in Details.", tool_words: null });
    return out;
  }

  // ------------------------------------------------------------------------------------------------ time
  /**
   * The time facts of the progress screen. Only what is known: the approval's time (so minutes since it), and the end of the person's own lock from the deadline rows the view model
   * already has (Alice's coins come back at D, a Parano1d height counted at 30 s a block; Bob's ETH at T_reveal, an Ethereum time). No estimate of the time left is made.
   */
  function timeFacts({ approvedAt, rows, role, now }) {
    const out = { started_at: null, elapsed_min: null, usual_min: USUAL_MINUTES, lock_end: null };
    if (Number.isSafeInteger(approvedAt) && approvedAt > 0) {
      out.started_at = approvedAt;
      out.elapsed_min = Math.max(0, Math.floor((now - approvedAt) / 60));
    }
    const row = (Array.isArray(rows) ? rows : []).find((r) => r && r.id === (role === "alice" ? "d" : "t_reveal"));
    if (row && typeof row.seconds_left === "number" && Number.isFinite(row.seconds_left) && row.seconds_left > 0 && row.state !== "na" && row.state !== "unknown" && row.stale !== true && !row.no_countdown) {
      out.lock_end = { coin: role === "alice" ? "NOID" : "ETH", seconds_left: row.seconds_left, at: now + row.seconds_left, approx: row.approx === true };
    }
    return out;
  }

  // ------------------------------------------------------------------------------------------------ the end screens
  const TX_ETH = /^0x[0-9a-f]{64}$/;
  const TX_NOID = /^[0-9a-f]{64}$/;
  /**
   * The transaction hashes the swap's record holds, from the view model's receipts rows (the engine's own tracked transactions), each only when it has the exact form of a hash.
   * Plain text for the person to look up; never a link.
   */
  function recordsOf(receipts, chainId) {
    const out = [];
    const where = chainId === 11155111 ? "on the Ethereum Sepolia explorer (sepolia.etherscan.io)" : "on an Ethereum explorer for this test network";
    for (const r of Array.isArray(receipts) ? receipts : []) {
      if (!r || typeof r.value !== "string" || typeof r.label !== "string") continue;
      let label = null;
      if (r.group === "Ethereum" && TX_ETH.test(r.value)) {
        if (/^Lock transaction/.test(r.label)) label = "The lock on Ethereum";
        else if (/^Claim transaction/.test(r.label)) label = "The step that took the ETH";
        else if (/^Refund transaction/.test(r.label)) label = "The refund on Ethereum";
        if (label) out.push({ label: `${label}, ${where}`, value: r.value });
      } else if (r.group === "Parano1d" && TX_NOID.test(r.value) && /^Tracked transaction/.test(r.label)) {
        out.push({ label: "A Parano1d transaction the app tracked, on the Parano1d explorer", value: r.value });
      }
    }
    return out.slice(0, 6);
  }

  /**
   * What the end screen says, from the ending, the role, the terms and the facts the app recorded (the wallet's sweep markers, the receipts, the approval's time). Nothing is
   * computed that the app does not know: no duration, no fee total (the fees are not in any file the page reads), no reason beyond what the tick shows.
   */
  function endFacts({ kind, role, terms, wallet, receipts, approvedAt, board, coins, ethLockSeen }) {
    const alice = role === "alice";
    const t = terms || null;
    const swept = (wallet && wallet.swept) || {};
    const payoutOf = (coin) => (t && t.arrive && t.arrive.coin === coin ? t.arrive.address : t && t.leftover && t.leftover.coin === coin ? t.leftover.address : null);
    const noidTo = payoutOf("NOID");
    const ethTo = payoutOf("ETH");
    const out = { kind, state: null, title: null, by: null, facts: [], next: null, records: recordsOf(receipts, t ? t.chain_id : null), approved_at: Number.isSafeInteger(approvedAt) && approvedAt > 0 ? approvedAt : null, note: "The explorers are public pages anyone can open. This app does not send your records anywhere." };
    const fees = { label: "Network fees", text: "Paid to the networks, not to anyone on the board. The app does not total them yet." };
    if (kind === "done") {
      out.state = "Done";
      if (alice) {
        const sent = !!swept.eth_alice;
        out.title = { lead: "You received", coin: "ETH", words: t ? t.get.words : null };
        out.by = `The swap is complete. ${sent ? `The ETH was sent on to your own address, ${shortAddr(ethTo) || "(not set)"}.` : `The ETH is in the key the app made for this swap. The app sends it on to your own address, ${shortAddr(ethTo) || "(not set)"}, when it can.`} There is nothing for you to do.`;
        out.facts = [{ label: "You gave", coin: "NOID", text: t ? t.give.words : null }, { label: "You received", coin: "ETH", text: t ? t.get.words : null }, fees];
      } else {
        out.title = { lead: "You received", coin: "NOID", words: t ? t.get.words : null, tail: ", less the network fee" };
        out.by = `The swap is complete. The NOID was paid to your own address, ${shortAddr(noidTo) || "(not set)"}. The network fee of taking it, at least 0.0058 NOID, is taken out of the coins. There is nothing for you to do.`;
        out.facts = [{ label: "You gave", coin: "ETH", text: t ? t.give.words : null }, { label: "Agreed amount", coin: "NOID", text: t ? t.get.words : null }, fees];
      }
    } else if (kind === "refunded") {
      out.state = "Refunded";
      const coin = alice ? "NOID" : "ETH";
      const sent = alice ? !!swept.noid : !!swept.eth_bob;
      const to = alice ? noidTo : ethTo;
      out.title = { lead: alice ? "The swap did not complete. Your NOID are back." : "The swap did not complete. Your ETH is back.", coin: null };
      out.by = alice
        ? `${ethLockSeen === false ? "The other side did not lock their ETH, so nothing was swapped." : "The swap did not complete, so nothing was swapped."} Swaps can stop for ordinary reasons, such as a computer going offline. No one is blamed.`
        : "The swap did not complete, so the app took your ETH back from the swap. Swaps can stop for ordinary reasons, such as a computer going offline. No one is blamed.";
      out.facts = [
        { label: "Back with you", coin, text: `${t ? t.give.words : coin}${alice ? ", less the network fee of taking them back (at least 0.0058 NOID)" : ", less a network fee"}. ${sent ? `Sent on to your own address, ${shortAddr(to) || "(not set)"}.` : `The app sends it on to your own address, ${shortAddr(to) || "(not set)"}, when it can.`}` },
        fees,
      ];
      out.next = alice ? "Your NOID had to stay locked until the swap's own end time. Nobody, not even you, can release them sooner. That is what keeps the swap safe for both sides." : null;
    } else if (kind === "stopped") {
      out.state = "Stopped";
      out.title = { lead: "The swap stopped.", coin: null };
      const n = coins && Array.isArray(coins.instances) ? coins.instances.length : null;
      out.by = `The app ended this swap. ${n ? `The last reading shows ${n} amount${n === 1 ? "" : "s"} still held by the swap: ${coins.instances.map((i) => i.amount_text + " NOID").join(", ")}. They come back to you after the swap's end time. ` : ""}Open Details to see the tool's own words about why.`;
    } else if (kind === "lost") {
      out.state = "Needs a look";
      out.title = { lead: "The swap did not end as planned.", coin: null };
      out.by = "Open Details to see the tool's own account of what happened. Nothing more is sent for this swap.";
    } else if (kind === "board_stopped") {
      out.state = "Ended";
      out.title = { lead: "The offer ended before anything was locked.", coin: null };
      out.by = `${stopWords(board && board.stopped)} Nothing was funded: no coins of yours were locked or paid.`;
    }
    return out;
  }

  // ------------------------------------------------------------------------------------------------ which screen
  /**
   * The screen from the payload's facts: `{board, role, phase_id, finished, ap, tab}`.
   *   offers   no swap yet (or the person asked for the list), the list, "Post an offer", the notice
   *   waiting  the person's own offer is posted and nobody took it yet
   *   take     a swap exists: its terms, getting ready, the deposit, the approval (until the approval holds)
   *   progress the approval holds (or the swap's coins are in play): the steps, the time, "Needs you"
   *   end      the swap ended: done, refunded, stopped, lost, or the board ended before anything was funded
   * Unknown phases never end a swap and never pick a step.
   */
  function screenOf(f) {
    const b = f && f.board;
    if (!b || b.enabled !== true) return { screen: null };
    const role = f.role;
    const apOn = !!(f.ap && f.ap.on === true);
    const needs = !!(f.ap && Array.isArray(f.ap.needs_you) && f.ap.needs_you.length);
    const hasSwap = b.state !== "no_offer" && !!b.offer;
    if (f.tab === "offers" || !hasSwap) return { screen: "offers", swap: hasSwap };
    const end = endKind(role, f.phase_id, f.finished);
    if (end) return { screen: "end", kind: end };
    const started = phaseStarted(role, f.phase_id);
    if (b.stopped && b.nothing_funded === true && !started && !apOn) return { screen: "end", kind: "board_stopped" };
    if (!started && !apOn && !needs) {
      if (b.step === "waiting_take") return { screen: "waiting" };
      return { screen: "take", step: b.step };
    }
    return { screen: "progress" };
  }

  return {
    BLOCK_S,
    USUAL_MINUTES,
    MAIN_STEPS,
    PHASE_STEP,
    STATE_STEP,
    STATEMENT_WORDS,
    SPEND_WORDS,
    noidWords,
    ethWords,
    priceWords,
    shortId,
    shortAddr,
    decimalToUnits,
    chainName,
    typedOk,
    expectedUnit,
    offerOf,
    offerList,
    minutesOpen,
    termRows,
    boardOffer,
    handoverStep,
    readyWords,
    stopWords,
    stepOf,
    stepTitles,
    rail,
    endKind,
    phaseStarted,
    depositRows,
    approvalFacts,
    needsYou,
    timeFacts,
    recordsOf,
    endFacts,
    screenOf,
  };
});
