"use strict";
/**
 * The "Limits and risks" card (R6) as data, and `card(el, facts)` that builds it with the page's own `el` builder (the pattern of the pure builders in program.js). The swap page's approval
 * (batch B) and the program's own screen (batch C) both call it, so the card is the same in both places. Display only: nothing here is a gate; the server never checks that the card was read.
 * Loaded by node (`require`) and by the page (`window.NoidLimits`, which needs `window.NoidLaunch` loaded first).
 *
 * `TRACK`, the track record, is a frozen constant with `as_of` and `version`. A test fails when `TRACK.version` is not the version of desktop/package.json, so every release has to update the
 * counts together with the version.
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory(require("./launchfacts"));
  else root.NoidLimits = factory(root.NoidLaunch);
})(typeof self !== "undefined" ? self : this, function (L) {
  const TRACK = Object.freeze({
    version: "0.1.7",
    as_of: "2026-11-24",
    settled: 1,
    refunded: 0,
    note: "both sides run by the developer, with the terminal tools, before this program",
  });

  const HEADING = "Limits and risks";
  const READ_BUTTON = "I have read this";
  const LINK_TEXT = "Limits and risks";

  const numText = (n) => (typeof n === "number" && Number.isFinite(n) ? (Number.isInteger(n) ? L.groupInt(String(n)) : String(n)) : null);

  /**
   * The card's rows. `facts`: { max_noid, max_eth } (numbers, from `prog.form.profiles.production`; a row whose figure is missing is left out) and optionally { track } to override TRACK (tests).
   * @returns {{heading:string, rows:{id:string, heading:string, verdict:string|null, text:string|null, items:string[]|null}[]}}
   */
  function rows(facts = {}) {
    const f = facts || {};
    const track = f.track || TRACK;
    const usual = L.PROFILES.production.usual_min;
    const aliceBack = L.fmtBack(L.backAfter("production", "alice"));
    const bobBack = L.fmtBack(L.backAfter("production", "bob"));
    const n = L.bobOnlineMin("production");
    const out = [];
    out.push({ id: "holds", heading: "Who holds your coins", verdict: "Nobody else.", text: "Your coins sit in this swap's own wallet on this computer, then in one contract on each chain. No company, server or person can move them. Either both sides get their coins, or both get them back.", items: null });
    out.push({ id: "admin", heading: "Admin keys", verdict: "None.", text: "The two contracts have no owner, no pause and no upgrade. Nobody can change a swap's terms once it is made. An update of this program never changes a swap that is running.", items: null });
    out.push({ id: "stop", heading: "What can stop a swap", verdict: null, text: "Either side can stop before locking; then only network fees are lost. After the locks, a computer that is off, a node that cannot be reached, Ethereum fees above your fee cap or one of the program's checks can stop it; then each side's coins come back after the deadline.", items: null });
    out.push({
      id: "lose",
      heading: "How you can lose",
      verdict: null,
      text: null,
      items: [
        `If you sell ETH and your computer is off after Alice takes the ETH: your program has at least about ${n} minutes to claim the NOID. If it misses that, Alice can take the NOID back and you have lost the ETH.`,
        "If you sell ETH to someone who controls most of Parano1d's mining: they can take both sides. One address mined between 45 % and 63 % of each day's blocks in the weeks before this release. Sell ETH only to someone you have a reason to trust.",
        "The code, and the hash function behind the NOID lock, have not been reviewed by outside experts. A flaw could cost the coins of a swap. Keep amounts small.",
      ],
    });
    const mn = numText(f.max_noid);
    const me = numText(f.max_eth);
    if (mn !== null && me !== null) out.push({ id: "caps", heading: "Limits per swap", verdict: null, text: `At most ${mn} NOID and ${me} ETH per swap. The program refuses more.`, items: null });
    out.push({ id: "time", heading: "Time", verdict: null, text: `About ${usual} minutes when both sides are online. If the swap stops, NOID can stay locked ${aliceBack} and ETH ${bobBack} before they come back.`, items: null });
    out.push({ id: "track", heading: "Track record", verdict: null, text: `On Ethereum mainnet so far: ${track.settled} settled, ${track.refunded} refunded (${track.note}). As of ${track.as_of}.`, items: null });
    return { heading: HEADING, rows: out };
  }

  /**
   * The card as a DOM node: `section.limits` with an h2 and one `div.lim-row` per row (an h3, the verdict in bold when there is one, a paragraph, or an ordered list for "How you can lose").
   * `el(tag, attrs, ...kids)` is the page's builder. `opts.headingId` sets the h2's id (the approval points `aria-labelledby` at it); `opts.level` is the heading's level (default 2).
   */
  function card(el, facts, opts = {}) {
    const d = rows(facts);
    const h = el(`h${opts.level || 2}`, { class: "lim-h", id: opts.headingId || null, text: d.heading });
    const kids = d.rows.map((r) =>
      el(
        "div",
        { class: "lim-row", dataset: { limit: r.id } },
        el("h3", { class: "lim-t", text: r.heading }),
        r.verdict ? el("p", { class: "lim-v" }, el("strong", { text: r.verdict })) : null,
        r.text ? el("p", { class: "lim-p", text: r.text }) : null,
        r.items ? el("ol", { class: "lim-list" }, r.items.map((t) => el("li", { text: t }))) : null,
      ),
    );
    return el("section", { class: "limits", "aria-label": d.heading }, h, ...kids);
  }

  return { TRACK, HEADING, READ_BUTTON, LINK_TEXT, rows, card };
});
