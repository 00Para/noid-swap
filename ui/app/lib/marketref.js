"use strict";
/**
 * The market reference rate (display only): the validation of the project's own site snapshot, the age bands, the comparison of a swap's rate with the reference, and the lines the page draws.
 * Pure: no input or output, no clock of its own. Loaded by node (`require`, the fetcher and the server) and by the page (`window.NoidMarket`).
 *
 * The rules are ported from the site's own loader (a copy, not shared code): a snapshot is `{ v: 1, generated_at, eth_usd, noid_usd, noid_usd_venue, noid_volume_24h_usd, noid_price_ts, noid_price_stale }`
 * and anything else that is wrong fails the whole read. Age bands (the older of the file's time and the NOID price's time): up to 30 minutes normal; 30 minutes to 6 hours greyed, "stale", no comparison;
 * over 6 hours, a missing price, a NOID price the source calls stale or a NOID volume under 10,000 USD in 24 hours: "Reference rate unavailable", no comparison.
 *
 * It decides nothing: no function here feeds a step, a gate, an approval, run.json, an invitation or a backup.
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.NoidMarket = factory();
})(typeof self !== "undefined" ? self : this, function () {
  const MAX_BYTES = 64 * 1024;
  const STALE_MS = 30 * 60 * 1000;
  const EXPIRE_MS = 6 * 60 * 60 * 1000;
  const SKEW_MS = 5 * 60 * 1000;
  const LOW_VOLUME_USD = 10000;
  const FAR_PCT = 20;
  const MIN_POSITIVE = 1e-12;
  const MAX_USD = 1e9;
  const MAX_VOLUME = 1e15;
  const UTC_ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;
  const VENUE = /^[A-Za-z0-9][A-Za-z0-9 .,()&'+-]{0,59}$/;

  const isObj = (o) => o !== null && typeof o === "object" && !Array.isArray(o) && Object.getPrototypeOf(o) === Object.prototype;
  const posNum = (v, max) => typeof v === "number" && Number.isFinite(v) && v >= MIN_POSITIVE && v <= max;

  /** A strict UTC time (`YYYY-MM-DDTHH:MM:SS(.sss)Z`, no rollover, at most five minutes ahead of `now`) as milliseconds, or null. */
  function utcMs(s, now) {
    if (typeof s !== "string" || !UTC_ISO.test(s)) return null;
    const ms = Date.parse(s);
    if (!Number.isFinite(ms)) return null;
    const dot = s.indexOf(".");
    const want = dot === -1 ? `${s.slice(0, -1)}.000Z` : `${s.slice(0, dot)}.${s.slice(dot + 1, -1).padEnd(3, "0")}Z`;
    if (new Date(ms).toISOString() !== want) return null;
    return ms > now + SKEW_MS ? null : ms;
  }

  /**
   * Validates a snapshot (a JSON string or an object). Unknown keys are ignored.
   * @returns {{ok:true, ref:{eth_usd:number|null, noid_usd:number|null, venue:string|null, volume:number|null, generated_ms:number, noid_ts_ms:number|null, noid_stale:boolean}}|{ok:false, why:string}}
   */
  function parse(raw, nowMs) {
    const now = Number.isFinite(nowMs) ? nowMs : Date.now();
    let o = raw;
    if (typeof raw === "string") {
      if (raw.length > MAX_BYTES || raw.charCodeAt(0) === 0xfeff) return { ok: false, why: "bad_file" };
      try {
        o = JSON.parse(raw);
      } catch {
        return { ok: false, why: "bad_json" };
      }
    }
    if (!isObj(o) || o.v !== 1) return { ok: false, why: "bad_schema" };
    if (o.sample === true) return { ok: false, why: "sample" };
    const generated = utcMs(o.generated_at, now);
    if (generated === null) return { ok: false, why: "bad_time" };
    if (o.eth_usd !== null && !posNum(o.eth_usd, MAX_USD)) return { ok: false, why: "bad_eth" };
    if (o.noid_usd !== null && !posNum(o.noid_usd, MAX_USD)) return { ok: false, why: "bad_noid" };
    const hasNoid = o.noid_usd !== null;
    let venue = null;
    if (o.noid_usd_venue === null) {
      if (hasNoid) return { ok: false, why: "bad_venue" };
    } else if (typeof o.noid_usd_venue === "string" && VENUE.test(o.noid_usd_venue.trim()) && !/^sample\b/i.test(o.noid_usd_venue.trim())) venue = o.noid_usd_venue.trim();
    else return { ok: false, why: "bad_venue" };
    let volume = null;
    if (o.noid_volume_24h_usd === null) {
      if (hasNoid) return { ok: false, why: "bad_volume" };
    } else if (typeof o.noid_volume_24h_usd === "number" && Number.isFinite(o.noid_volume_24h_usd) && o.noid_volume_24h_usd >= 0 && o.noid_volume_24h_usd <= MAX_VOLUME) volume = o.noid_volume_24h_usd;
    else return { ok: false, why: "bad_volume" };
    let noidTs = null;
    if (o.noid_price_ts === null) {
      if (hasNoid) return { ok: false, why: "bad_time" };
    } else {
      noidTs = utcMs(o.noid_price_ts, now);
      if (noidTs === null) return { ok: false, why: "bad_time" };
    }
    if (hasNoid ? typeof o.noid_price_stale !== "boolean" : o.noid_price_stale !== undefined && typeof o.noid_price_stale !== "boolean") return { ok: false, why: "bad_stale" };
    return { ok: true, ref: { eth_usd: o.eth_usd, noid_usd: o.noid_usd, venue, volume, generated_ms: generated, noid_ts_ms: noidTs, noid_stale: o.noid_price_stale === true } };
  }

  const groupInt = (s) => s.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  /** A rate to `digits` significant digits, with grouped thousands (a plain string, never a locale call). */
  function fmtRate(n, digits) {
    if (!Number.isFinite(n) || n <= 0) return null;
    const r = Number(n.toPrecision(digits));
    const fixed = r >= 1000 ? String(Math.round(r)) : r.toFixed(Math.max(0, digits - 1 - Math.floor(Math.log10(r)))).replace(/\.?0+$/, "");
    const [w, f] = fixed.split(".");
    return groupInt(w) + (f ? `.${f}` : "");
  }
  function ageText(ms) {
    const m = Math.max(0, Math.floor(ms / 60000));
    if (m < 60) return `${m} min`;
    const h = Math.floor(m / 60);
    return m % 60 === 0 ? `${h} h` : `${h} h ${m % 60} min`;
  }

  /**
   * What to draw. `ref`: parse()'s `ref` (or null: the read failed). `swapEthInNoid`: the swap's rate, NOID for one ETH, a positive number or null (nothing typed yet).
   * @returns {{state:"ok"|"stale"|"unavailable", grey:boolean, far:boolean, ref_line:string, swap_line:string|null, pct:number|null, reason:string|null}}
   */
  function view(ref, nowMs, swapEthInNoid) {
    const now = Number.isFinite(nowMs) ? nowMs : Date.now();
    const none = (reason) => ({ state: "unavailable", grey: true, far: false, ref_line: reason ? `Reference rate unavailable (${reason}).` : "Reference rate unavailable.", swap_line: null, pct: null, reason: reason || null });
    if (!ref || typeof ref !== "object") return none(null);
    if (!posNum(ref.eth_usd, MAX_USD)) return none("no ETH price");
    if (!posNum(ref.noid_usd, MAX_USD)) return none("no NOID price");
    const age = Math.max(Math.max(0, now - ref.generated_ms), ref.noid_ts_ms === null ? 0 : Math.max(0, now - ref.noid_ts_ms));
    if (age > EXPIRE_MS) return none("too old");
    if (ref.noid_stale === true) return none("the NOID price is stale at its source");
    if (typeof ref.volume !== "number" || ref.volume < LOW_VOLUME_USD) return none("the NOID volume is too low to trust");
    const rate = ref.eth_usd / ref.noid_usd;
    const stale = age > STALE_MS;
    const venue = typeof ref.venue === "string" && VENUE.test(ref.venue) ? ref.venue : "an exchange";
    const refLine = `Market reference${stale ? " (stale)" : ""}: 1 ETH ≈ ${fmtRate(rate, 4)} NOID (${ageText(age)} old; NOID price from one small exchange, ${venue}).`;
    if (stale) return { state: "stale", grey: true, far: false, ref_line: refLine, swap_line: null, pct: null, reason: null };
    if (!(typeof swapEthInNoid === "number" && Number.isFinite(swapEthInNoid) && swapEthInNoid > 0)) return { state: "ok", grey: false, far: false, ref_line: refLine, swap_line: null, pct: null, reason: null };
    const pct = (swapEthInNoid / rate - 1) * 100;
    const whole = Math.round(Math.abs(pct));
    const far = whole > FAR_PCT;
    const gap = whole === 0 ? "at the reference" : `${whole} % ${pct > 0 ? "above" : "below"} the reference`;
    return { state: "ok", grey: false, far, ref_line: refLine, swap_line: `This swap: 1 ETH = ${fmtRate(swapEthInNoid, 6)} NOID, ${gap}.${far ? " Far from the reference." : ""}`, pct, reason: null };
  }

  /** The decimal string of an amount (digits and at most one dot) as a number; anything else is null. */
  function amountNumber(text) {
    if (typeof text !== "string" || !/^\d{1,30}(?:\.\d{1,18})?$/.test(text.trim())) return null;
    const n = Number(text.trim());
    return Number.isFinite(n) && n > 0 ? n : null;
  }
  /** NOID for one ETH from the two amounts typed (NOID and ETH, as text), or null. */
  function swapRateOf(noidText, ethText) {
    const n = amountNumber(noidText);
    const e = amountNumber(ethText);
    return n !== null && e !== null ? n / e : null;
  }

  /** The block the page draws: one `div.market-ref` with one or two lines of plain text (`el` is the page's element builder). Neutral: the only colour is the "far" note. */
  function node(el, v) {
    if (!v) return null;
    const cls = ["market-ref"];
    if (v.grey) cls.push("grey");
    if (v.far) cls.push("far");
    const kids = [el("p", { class: "market-line", text: v.ref_line })];
    if (v.swap_line) kids.push(el("p", { class: "market-line swap", text: v.swap_line }));
    return el("div", { class: cls.join(" "), role: "note", "aria-label": "Market reference rate" }, ...kids);
  }

  return { MAX_BYTES, STALE_MS, EXPIRE_MS, LOW_VOLUME_USD, FAR_PCT, parse, view, fmtRate, ageText, amountNumber, swapRateOf, node };
});
