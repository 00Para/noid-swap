"use strict";
/**
 * The figures of the launch screens (R4, R5, R3 helpers). Pure: no input or output, no clock of its own, no random. Loaded by node (`require`) and by the page (`window.NoidLaunch`),
 * so the server's `/api/run` `launch` object and the new-swap form's own numbers come from the same functions and cannot differ.
 *
 * Every amount is a BigInt or a decimal string, never a float; the one float is the percentage of `share` (basis points). Display only: nothing here feeds a step, a gate or an approval.
 * The profile copies and the gas ceilings are copies of swap-cli/src/params.rs and eth/scripts/live.js; the drift tests (test/launchfacts.test.js) parse those files and fail on any difference.
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.NoidLaunch = factory();
})(typeof self !== "undefined" ? self : this, function () {
  // ---- profile copies (swap-cli/src/params.rs; `usual_min` is measured from the funding to settled: production run 8, sepolia runs 11 to 14, 19 and rehearsal 4.12; rehearsal is an estimate and is never shown in program mode)
  const PROFILES = Object.freeze({
    production: Object.freeze({ tau_fast_s: 20, block_nom_s: 30, d_offset: 738, b_post: 254, b_final: 19, w_a_s: 7200, eth_finality_s: 1140, hc_lead: 50, usual_min: 50 }),
    sepolia: Object.freeze({ tau_fast_s: 20, block_nom_s: 30, d_offset: 302, b_post: 34, b_final: 19, w_a_s: 4200, eth_finality_s: 1140, hc_lead: 50, usual_min: 50 }),
    rehearsal: Object.freeze({ tau_fast_s: 20, block_nom_s: 30, d_offset: 122, b_post: 34, b_final: 19, w_a_s: 600, eth_finality_s: 1140, hc_lead: 50, usual_min: 15 }),
  });

  // ---- gas: measured on the receipts of runs 11 to 14 (contract version 1; the refund is the dry-run estimate of runs 17 and 18) and the ceilings of eth/scripts/live.js
  const GAS = Object.freeze({
    lock: Object.freeze({ measured: 583853n, ceiling: 700000n }),
    reveal: Object.freeze({ measured: 689324n, ceiling: 1000000n }),
    refund: Object.freeze({ measured: 158608n, ceiling: 200000n }),
    sweep: Object.freeze({ measured: 21000n, ceiling: 21000n }),
  });
  // ---- NOID fees in micro-NOID, used before the node's own figure is known (runs 19 and 22; the close and the leftover sweep are the formula's minimum)
  const NOID_FEE = Object.freeze({ funding: 9000n, close: 5800n, sweep: 5800n });
  const BASE_FEE_STALE_S = 120;
  const LOUD_BP = 500;

  const big = (x) => {
    if (typeof x === "bigint") return x;
    if (typeof x === "number") return Number.isSafeInteger(x) && x >= 0 ? BigInt(x) : null;
    if (typeof x === "string" && /^[0-9]{1,60}$/.test(x)) return BigInt(x);
    return null;
  };
  const pow10 = (n) => 10n ** BigInt(n);

  /** Digits of an integer text with a comma every three digits ("5000" -> "5,000"). */
  function groupInt(s) {
    return String(s).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  }

  /**
   * n / d (BigInts, n >= 0, d > 0) to at most `digits` significant digits, rounded half up, as a plain decimal text (no exponent, no grouping).
   * `rounded` is true when the text is not exactly the value.
   * @returns {{text:string, rounded:boolean}}
   */
  function sig(n, d, digits = 6) {
    if (typeof n !== "bigint" || typeof d !== "bigint" || d <= 0n || n < 0n) return { text: "0", rounded: false };
    if (n === 0n) return { text: "0", rounded: false };
    const ge = (ex) => (ex >= 0 ? n >= d * pow10(ex) : n * pow10(-ex) >= d);
    let e = n.toString().length - d.toString().length;
    while (!ge(e)) e--;
    while (ge(e + 1)) e++;
    let shift = digits - 1 - e;
    let num = n;
    let den = d;
    if (shift >= 0) num = n * pow10(shift);
    else den = d * pow10(-shift);
    let q = num / den;
    const r = num % den;
    const rounded = r !== 0n;
    if (r * 2n >= den) q += 1n;
    if (q === pow10(digits)) {
      q /= 10n;
      shift -= 1;
    }
    let s = q.toString();
    if (shift <= 0) s += "0".repeat(-shift);
    else {
      if (s.length <= shift) s = "0".repeat(shift - s.length + 1) + s;
      s = `${s.slice(0, s.length - shift)}.${s.slice(s.length - shift)}`.replace(/0+$/, "").replace(/\.$/, "");
    }
    return { text: s, rounded };
  }

  /** A decimal text with its whole part grouped ("5000.25" -> "5,000.25"). */
  function groupDec(t) {
    const [w, f] = String(t).split(".");
    return f === undefined ? groupInt(w) : `${groupInt(w)}.${f}`;
  }

  /** An amount of NOID (micro-NOID in) to at most `digits` significant digits, grouped: { text, rounded }. `exact` keeps every decimal (at most six). */
  function fmtNoid(micro, o = {}) {
    const v = big(micro);
    if (v === null) return null;
    const r = o.exact ? sig(v, 1000000n, 40) : sig(v, 1000000n, o.digits || 6);
    return { text: groupDec(r.text), rounded: r.rounded };
  }
  /** An amount of ETH (wei in) to at most `digits` significant digits (6 by default), grouped: { text, rounded }. */
  function fmtEth(wei, o = {}) {
    const v = big(wei);
    if (v === null) return null;
    const r = sig(v, pow10(18), o.exact ? 40 : o.digits || 6);
    return { text: groupDec(r.text), rounded: r.rounded };
  }
  /** Gwei text ("0.05") to wei (BigInt), or null. At most nine decimals. */
  function gweiToWei(s) {
    if (typeof s !== "string" || !/^(0|[1-9][0-9]{0,3})(\.[0-9]{1,9})?$/.test(s)) return null;
    const [w, f = ""] = s.split(".");
    return BigInt(w) * pow10(9) + BigInt(f.padEnd(9, "0"));
  }
  /** Wei to a gwei text without trailing zeros ("350000000" -> "0.35"). */
  function weiToGwei(wei) {
    const v = big(wei);
    if (v === null) return null;
    const w = v / pow10(9);
    const f = String(v % pow10(9)).padStart(9, "0").replace(/0+$/, "");
    return f ? `${w}.${f}` : String(w);
  }

  /**
   * The rate of the two amounts: ETH for one NOID and NOID for one ETH, each to at most six significant digits.
   * @returns {{noid_in_eth:string, eth_in_noid:string, rounded:boolean}|null}
   */
  function rate(noidMicro, ethWei) {
    const n = big(noidMicro);
    const e = big(ethWei);
    if (n === null || e === null || n === 0n || e === 0n) return null;
    // 1 NOID = (e / 1e18) / (n / 1e6) ETH = e / (n * 1e12) ETH ; 1 ETH = n * 1e12 / e NOID
    const a = sig(e, n * pow10(12), 6);
    const b = sig(n * pow10(12), e, 6);
    return { noid_in_eth: a.text, eth_in_noid: b.text, rounded: a.rounded || b.rounded };
  }

  /**
   * The rate line as the two spans the page draws with a gap between them (never a dot): ["1 NOID = 0.0002 ETH", "1 ETH = 5,000 NOID"]; "about" follows the "=" when a figure was cut.
   * @returns {string[]|null}
   */
  function rateParts(r) {
    if (!r) return null;
    const ab = r.rounded ? "about " : "";
    return [`1 NOID = ${ab}${groupDec(r.noid_in_eth)} ETH`, `1 ETH = ${ab}${groupDec(r.eth_in_noid)} NOID`];
  }

  const STEPS = {
    alice: { happy: ["reveal", "sweep"], stopped: ["sweep"] },
    bob: { happy: ["lock", "sweep"], stopped: ["lock", "refund", "sweep"] },
  };

  /**
   * The Ethereum fees of one role on one path. A step's price is min(cap, base + tip) times its measured gas; the sweep always counts 21,000 gas at the cap (it sends the balance minus that,
   * so what is under the cap stays in the swap key: the honest cost to the person). `max_wei` is the sum of the ceilings at the cap. `now_wei` is null when the base fee is not known
   * (or not fresh), and both are null when there is no cap.
   * @returns {{now_wei:string|null, max_wei:string|null, steps:{id:string, gas:string, ceiling:string, wei:string|null}[]}|null}
   */
  function ethFees({ role, baseFeeWei, capWei, tipWei, path }) {
    const list = STEPS[role] && STEPS[role][path === "stopped" ? "stopped" : "happy"];
    if (!list) return null;
    const cap = big(capWei);
    const base = big(baseFeeWei);
    const tip = big(tipWei) === null ? 0n : big(tipWei);
    const price = cap !== null && base !== null ? (base + tip < cap ? base + tip : cap) : null;
    let now = cap !== null && base !== null ? 0n : null;
    let max = cap !== null ? 0n : null;
    const steps = list.map((id) => {
      const g = GAS[id];
      let wei = null;
      if (cap !== null && base !== null) wei = id === "sweep" ? g.measured * cap : g.measured * price;
      if (wei !== null && now !== null) now += wei;
      if (max !== null) max += g.ceiling * cap;
      return { id, gas: g.measured.toString(), ceiling: g.ceiling.toString(), wei: wei === null ? null : wei.toString() };
    });
    return { now_wei: now === null ? null : now.toString(), max_wei: max === null ? null : max.toString(), steps };
  }

  /**
   * The NOID fees of one role on one path, in micro-NOID (strings). Alice, happy: the funding fee (the deposit status' own figure when known, else the constant); stopped: funding plus the
   * close plus the leftover sweep (run 22 measured 20,700; the sum here is 20,600). Bob: the close fee, which comes out of the NOID he receives; `upto_micro` is the swap's `max_fee`.
   * @returns {{micro:string, upto_micro:string|null, source:"status"|"constant"}|null}
   */
  function noidFees({ role, path, fundingFeeMicro, maxFeeMicro }) {
    const given = big(fundingFeeMicro);
    const funding = given !== null && given > 0n ? given : NOID_FEE.funding;
    const source = given !== null && given > 0n ? "status" : "constant";
    if (role === "alice") {
      const micro = path === "stopped" ? funding + NOID_FEE.close + NOID_FEE.sweep : funding;
      return { micro: micro.toString(), upto_micro: null, source };
    }
    if (role === "bob") {
      const up = big(maxFeeMicro);
      return { micro: NOID_FEE.close.toString(), upto_micro: up === null || up === 0n ? null : up.toString(), source: "constant" };
    }
    return null;
  }

  /**
   * The fees as basis points of the swap: fee_eth / amount_eth + fee_noid / amount_noid. The two legs are worth the same at the agreed rate, so the sum is the share of the swap's value
   * without a price feed. A float (the one in this file). null when a figure is missing.
   */
  function share(ethFeeWei, ethWei, noidFeeMicro, noidMicro) {
    const ef = big(ethFeeWei);
    const ea = big(ethWei);
    const nf = big(noidFeeMicro);
    const na = big(noidMicro);
    if (ef === null || ea === null || nf === null || na === null || ea === 0n || na === 0n) return null;
    // exact to a millionth of a basis point before the one float
    const part = (a, b) => Number((a * 10000n * 1000000n) / b) / 1000000;
    return part(ef, ea) + part(nf, na);
  }

  /** A share in basis points as the page's percentage: 1 decimal from 1 %, two decimals under it ("0.07", "26.4"); "less than 0.01" for a smaller one. No "%" sign. */
  function pct(bp) {
    if (typeof bp !== "number" || !Number.isFinite(bp) || bp < 0) return null;
    const p = bp / 100;
    if (p >= 1) return p.toFixed(1);
    if (p < 0.005) return "less than 0.01";
    return p.toFixed(2);
  }

  /**
   * Which of the person's own sends the program would refuse at the fee cap now: "reveal" for Alice when cap < 2 x base (live.js refuses a claim under twice the base fee), "lock" for Bob
   * when cap < base, null otherwise (and when a figure is missing).
   */
  function refusedNow({ role, baseFeeWei, capWei }) {
    const base = big(baseFeeWei);
    const cap = big(capWei);
    if (base === null || cap === null) return null;
    if (role === "alice") return cap < 2n * base ? "reveal" : null;
    if (role === "bob") return cap < base ? "lock" : null;
    return null;
  }

  /**
   * Seconds from the start to "back in your own address" at the nominal 30 s a block. Alice: (hc_lead + d_offset + 20) blocks (the 20 are 19 for finality and 1 for the sweep): about 6 h 45 min
   * in production, about 3 h 5 min on Sepolia. Bob: w_a_s + eth_finality_s + 60 s: about 2 h 20 min and 1 h 30 min. `hcLead` overrides the profile's lead (the run's own hc_lead).
   */
  function backAfter(profile, role, hcLead) {
    const p = PROFILES[profile];
    if (!p) return null;
    if (role === "alice") {
      const lead = Number.isInteger(hcLead) && hcLead > 0 ? hcLead : p.hc_lead;
      return (lead + p.d_offset + 20) * p.block_nom_s;
    }
    if (role === "bob") return p.w_a_s + p.eth_finality_s + 60;
    return null;
  }

  /** "about 6 h 45 min": seconds rounded to the nearest five minutes ("about 90 min" is never used: an hour or more is "H h MM min"). */
  function fmtBack(seconds) {
    if (typeof seconds !== "number" || !Number.isFinite(seconds) || seconds < 0) return null;
    const mins = Math.round(seconds / 300) * 5;
    const h = Math.floor(mins / 60);
    const m = mins % 60;
    if (h === 0) return `about ${m} min`;
    return m === 0 ? `about ${h} h` : `about ${h} h ${m} min`;
  }

  /**
   * The fewest minutes between the reveal and the last block in which Bob's claim can be final, at the fast 20 s blocks: floor_to_5((b_post - b_final) x tau_fast / 60). Production 78 -> 75,
   * Sepolia 5. It is the engine's own budget (swap-cli/src/params.rs).
   */
  function bobOnlineMin(profile) {
    const p = PROFILES[profile];
    if (!p) return null;
    const raw = Math.floor(((p.b_post - p.b_final) * p.tau_fast_s) / 60);
    return Math.floor(raw / 5) * 5;
  }

  /** The late-claim alarm's number of blocks: min(10, floor((b_post - b_final) / 3)). Production 10, Sepolia 5. */
  function lateK(profile) {
    const p = PROFILES[profile];
    if (!p) return null;
    return Math.min(10, Math.floor((p.b_post - p.b_final) / 3));
  }

  const ETH_ADDR = /^0x[0-9a-fA-F]{40}$/;
  const NOID_ADDR = /^o1[02-9ac-hj-np-z]{20,100}$/;
  /** An address cut into groups of four: ["0x9a9a", "9a9a", ...]. The prefix stays on the first group; the last group may be shorter. null for anything that is not an address. */
  function groups(addr) {
    if (typeof addr !== "string") return null;
    let prefix;
    if (ETH_ADDR.test(addr)) prefix = "0x";
    else if (NOID_ADDR.test(addr)) prefix = "o1";
    else return null;
    const body = addr.slice(prefix.length);
    const out = [];
    for (let i = 0; i < body.length; i += 4) out.push(body.slice(i, i + 4));
    out[0] = prefix + out[0];
    return out;
  }

  /** "none" for a mixed-case 0x address (the server checked its checksum), "no_checksum" for all one case; null for anything that is not a 0x address. The page cannot compute keccak. */
  function caseNote(addr) {
    if (typeof addr !== "string" || !ETH_ADDR.test(addr)) return null;
    const body = addr.slice(2);
    return body === body.toLowerCase() || body === body.toUpperCase() ? "no_checksum" : "none";
  }

  const HISTORY_TEXT = Object.freeze({
    new: "New address: not used for a swap on this computer before.",
    unreadable: "The address history cannot be read, so every address is treated as new.",
    locked: "The address history opens with the program's key store.",
  });
  /**
   * The history line under an own address (R3). `state` is the history's ("ok", "unreadable", "locked"); `info` is { first_at, count } for the typed address, or absent; `remembered` is the
   * remembered address of the same kind when it differs from the typed one. Returns { kind, text, isNew }: the "new" and "changed" lines are the ones that ask for the compare tick.
   */
  function historyLine(state, info, remembered) {
    if (state === "unreadable") return { kind: "unreadable", text: HISTORY_TEXT.unreadable, isNew: true };
    if (state === "locked") return { kind: "locked", text: HISTORY_TEXT.locked, isNew: true };
    if (info && Number.isInteger(info.count) && info.count > 0 && typeof info.first_at === "string") {
      return { kind: "known", text: `Used for ${info.count} ${info.count === 1 ? "swap" : "swaps"} since ${info.first_at.slice(0, 10)}.`, isNew: false };
    }
    const g = typeof remembered === "string" ? groups(remembered) : null;
    if (g) return { kind: "changed", text: `Changed: your last swaps used ${g[0]} … ${g[g.length - 1]}.`, isNew: true };
    return { kind: "new", text: HISTORY_TEXT.new, isNew: true };
  }

  /**
   * The base fee read for ONE network from the node status's `eth` part: `eth.fees[profile]` when present, else `eth.fee` only when its own `profile` is that profile; never a fee read for another
   * network. { base_fee_wei, block, at } or null.
   */
  function baseFeeFor(eth, profile) {
    if (!eth || typeof eth !== "object") return null;
    const ok = (f) => (f && typeof f === "object" && big(f.base_fee_wei) !== null ? { base_fee_wei: String(f.base_fee_wei), block: Number.isInteger(f.block) ? f.block : null, at: Number.isFinite(Number(f.at)) ? Number(f.at) : null } : null);
    if (eth.fees && typeof eth.fees === "object" && Object.prototype.hasOwnProperty.call(eth.fees, profile)) return ok(eth.fees[profile]);
    if (eth.fee && typeof eth.fee === "object" && eth.fee.profile === profile) return ok(eth.fee);
    return null;
  }

  /**
   * Everything the form, the approval and the card need for one swap's numbers, from the swap's own terms. Pure; the server and the page both call it.
   * in: { profile, role, amountMicro, amountWei, capGwei|null, tipGwei|null, baseFee: { base_fee_wei, block, at(ms) }|null, nowMs, fundingFeeMicro|null, maxFeeMicro|null, hcLead|null }
   * out: the shape of the build spec section 5.1, plus cap_wei, tip_wei and the base fee's figures for the texts, and the steps of each path for the "How the fees are counted" fold.
   * @returns {object|null} null for an unknown profile, role or amount.
   */
  function launch(i) {
    const p = i && PROFILES[i.profile];
    if (!p || (i.role !== "alice" && i.role !== "bob")) return null;
    const micro = big(i.amountMicro);
    const wei = big(i.amountWei);
    if (micro === null || wei === null || micro === 0n || wei === 0n) return null;
    const capWei = typeof i.capGwei === "string" ? gweiToWei(i.capGwei) : null;
    const tipWei = typeof i.tipGwei === "string" ? gweiToWei(i.tipGwei) : null;
    const bf = i.baseFee && big(i.baseFee.base_fee_wei) !== null ? i.baseFee : null;
    const nowMs = typeof i.nowMs === "number" ? i.nowMs : null;
    const ageS = bf && nowMs !== null && Number.isFinite(Number(bf.at)) ? Math.max(0, Math.floor((nowMs - Number(bf.at)) / 1000)) : null;
    const fresh = bf !== null && ageS !== null && ageS <= BASE_FEE_STALE_S;
    const baseWei = fresh ? big(bf.base_fee_wei) : null;
    const path = (which) => {
      const e = ethFees({ role: i.role, baseFeeWei: baseWei, capWei, tipWei, path: which });
      const n = noidFees({ role: i.role, path: which, fundingFeeMicro: i.fundingFeeMicro, maxFeeMicro: i.maxFeeMicro });
      return { eth_now_wei: e.now_wei, eth_max_wei: e.max_wei, noid_micro: n.micro, noid_upto_micro: n.upto_micro, eth_steps: e.steps, noid_source: n.source };
    };
    const happy = path("happy");
    const stopped = path("stopped");
    const bp = happy.eth_now_wei === null ? null : share(happy.eth_now_wei, wei, happy.noid_micro, micro);
    const gotAlice = happy.eth_now_wei === null ? null : fmtEth(wei - BigInt(happy.eth_now_wei));
    const gotBob = fmtNoid(micro - BigInt(happy.noid_micro), { exact: true });
    return {
      profile: i.profile,
      mainnet: i.profile === "production",
      rate: rate(micro, wei),
      fees: {
        happy,
        stopped,
        share_bp: bp,
        loud: bp !== null && bp >= LOUD_BP,
        refused_now: refusedNow({ role: i.role, baseFeeWei: baseWei, capWei }),
        base_fee_age_s: ageS,
        base_fee_wei: baseWei === null ? null : baseWei.toString(),
        base_fee_block: bf && Number.isInteger(bf.block) ? bf.block : null,
        cap_wei: capWei === null ? null : capWei.toString(),
        tip_wei: tipWei === null ? null : tipWei.toString(),
      },
      times: {
        usual_min: p.usual_min,
        back_after_s: backAfter(i.profile, i.role, Number.isInteger(i.hcLead) ? i.hcLead : undefined),
        bob_online_min: bobOnlineMin(i.profile),
      },
      get_after_fees: i.role === "alice" ? (gotAlice ? gotAlice.text : null) : gotBob ? gotBob.text : null,
    };
  }

  return { PROFILES, GAS, NOID_FEE, BASE_FEE_STALE_S, LOUD_BP, HISTORY_TEXT, sig, groupInt, groupDec, fmtNoid, fmtEth, gweiToWei, weiToGwei, rate, rateParts, baseFeeFor, ethFees, noidFees, share, pct, refusedNow, backAfter, fmtBack, bobOnlineMin, lateK, groups, caseNote, historyLine, launch };
});
