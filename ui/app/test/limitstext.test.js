"use strict";
// The "Limits and risks" card (lib/limitstext.js): its rows, its numbers from the program's own figures, the TRACK constant tied to the release version, and the card built with the page's builder.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const LT = require("../lib/limitstext");
const L = require("../lib/launchfacts");
const { Node, Text, textOf } = require("./program-page-dom");

const ROOT = path.resolve(__dirname, "..", "..", "..");

/** The page's own `el` builder (operator.js), over the test DOM. */
function makeEl() {
  return function el(tag, attrs, ...kids) {
    const e = new Node(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v === null || v === undefined || v === false) continue;
      if (k === "class") e.className = v;
      else if (k === "text") e.textContent = v;
      else if (k === "dataset") Object.assign(e.dataset, v);
      else e.setAttribute(k, v === true ? "" : String(v));
    }
    for (const c of kids.flat()) {
      if (c === null || c === undefined || c === false) continue;
      e.appendChild(typeof c === "string" || typeof c === "number" ? new Text(String(c)) : c);
    }
    return e;
  };
}

test("TRACK.version is the version of desktop/package.json: a release has to update the counts with the version", () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "desktop", "package.json"), "utf8"));
  assert.equal(LT.TRACK.version, pkg.version);
  assert.ok(Object.isFrozen(LT.TRACK));
  assert.match(LT.TRACK.as_of, /^\d{4}-\d{2}-\d{2}$/);
  assert.ok(Number.isInteger(LT.TRACK.settled) && Number.isInteger(LT.TRACK.refunded));
});

test("the rows: the heading order of the spec, the caps from the program's figures, the times from the profile, the track record from TRACK", () => {
  const d = LT.rows({ max_noid: 20000, max_eth: 1 });
  assert.equal(d.heading, "Limits and risks");
  assert.deepEqual(d.rows.map((r) => r.heading), ["Who holds your coins", "Admin keys", "What can stop a swap", "How you can lose", "Limits per swap", "Time", "Track record"]);
  const by = (id) => d.rows.find((r) => r.id === id);
  assert.equal(by("holds").verdict, "Nobody else.");
  assert.equal(by("admin").verdict, "None.");
  assert.equal(by("caps").text, "At most 20,000 NOID and 1 ETH per swap. The program refuses more.");
  assert.equal(by("time").text, "About 50 minutes when both sides are online. If the swap stops, NOID can stay locked about 6 h 45 min and ETH about 2 h 20 min before they come back.");
  assert.equal(by("track").text, `On Ethereum mainnet so far: ${LT.TRACK.settled} settled, ${LT.TRACK.refunded} refunded (${LT.TRACK.note}). As of ${LT.TRACK.as_of}.`);
  assert.equal(by("lose").items.length, 3);
});

test("the first 'how you can lose' entry reads 'at least about N minutes' with N from launchfacts (75 in production), never a guess", () => {
  const d = LT.rows({});
  const first = d.rows.find((r) => r.id === "lose").items[0];
  assert.match(first, /has at least about 75 minutes to claim the NOID/);
  assert.equal(L.bobOnlineMin("production"), 75);
  assert.match(first, /^If you sell ETH and your computer is off after Alice takes the ETH:/);
  assert.match(d.rows.find((r) => r.id === "lose").items[1], /about three quarters of recent blocks/);
});

test("a row whose figure is not known is left out (the caps), and the track record can be replaced for a test", () => {
  assert.equal(LT.rows({}).rows.some((r) => r.id === "caps"), false);
  assert.equal(LT.rows({ max_noid: 20000 }).rows.some((r) => r.id === "caps"), false);
  const d = LT.rows({ max_noid: 1, max_eth: 2, track: { settled: 4, refunded: 2, note: "x", as_of: "2027-01-01" } });
  assert.match(d.rows.find((r) => r.id === "track").text, /4 settled, 2 refunded \(x\)\. As of 2027-01-01\./);
});

test("card: a section.limits with an h2 and one row per entry, built with the page's el; the list is an ol; texts are text nodes", () => {
  const node = LT.card(makeEl(), { max_noid: 20000, max_eth: 1 }, { headingId: "lim-h" });
  assert.equal(node.tag, "section");
  assert.ok(node.className.split(" ").includes("limits"));
  const h2 = node.querySelector("h2");
  assert.equal(h2.attrs.id, "lim-h");
  assert.equal(textOf(h2), "Limits and risks");
  const rows = node.querySelectorAll(".lim-row");
  assert.equal(rows.length, 7);
  assert.equal(rows[3].dataset.limit, "lose");
  assert.equal(rows[3].querySelector("ol").children.length, 3);
  assert.match(textOf(node), /Nobody else\./);
  assert.match(textOf(node), /At most 20,000 NOID and 1 ETH per swap/);
  assert.equal(node.querySelectorAll("button").length, 0, "the card has no button: the approval adds 'I have read this' itself");
});
