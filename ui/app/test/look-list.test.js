"use strict";
// The list of swaps in the new look: the pair of a row (glyph, figure, arrow, glyph, figure) drawn from the summary's give and get, the label kept for a screen reader, the "Ended" divider,
// the empty state, the loading list and the two vault notices. Display only: every row still opens its swap, nothing here decides anything.
const test = require("node:test");
const assert = require("node:assert/strict");
const { loadPage, textOf } = require("./program-page-dom");
const F = require("./program-page-fixtures");

const has = (n, c) => n.className.split(/\s+/).includes(c);
const TOKEN = "ab".repeat(16);
const page = (over = {}, routes = {}) => loadPage({ fetch: F.router({ "GET /api/program": () => ({ status: 200, body: F.prog(over) }), ...routes }) });
const withHalves = (o) => F.summary({ give: { text: "5", coin: "noid" }, get: { text: "0.001", coin: "eth" }, ...o });
const rowsOf = (pg) => pg.byId("pg-root").all((n) => n.tag === "li" && n.className.split(/\s+/).includes("pg-swap"));

test("a row with give and get draws the pair: glyph, figure, arrow, glyph, figure; the label stays as a word only a screen reader gets", async () => {
  const pg = await page({ swaps: [withHalves({ active: true, phase: "created" })] });
  const row = rowsOf(pg)[0];
  const btn = row.children[0];
  assert.equal(btn.tag, "button");
  const pair = row.querySelector(".pg-pair");
  assert.ok(pair, "the pair is drawn");
  assert.equal(pair.getAttribute("aria-hidden"), "true", "the pair is for the eye; the label below is for a screen reader");
  assert.deepEqual(pair.children.map((c) => (c.tag === "svg" ? c.className : c.className)), ["coin noid sm", "amt noid", "ic", "coin eth sm", "amt eth"]);
  const amts = pair.all((n) => n.tag === "span" && has(n, "amt"));
  assert.deepEqual(amts.map((a) => [a.querySelector(".num").textContent, a.querySelector(".tic").textContent]), [["5", "NOID"], ["0.001", "ETH"]]);
  const label = row.all((n) => has(n, "sr-only"))[0];
  assert.equal(label.textContent, "You sell 5 NOID for 0.001 ETH");
  assert.equal(row.querySelector(".pg-role").textContent, "You sell NOID");
  assert.ok(row.querySelector("svg.go") || row.all((n) => n.tag === "svg" && has(n, "go"))[0], "a chevron comes last");
  assert.equal(btn.children[btn.children.length - 1].tag, "svg");
  // the row still opens its swap
  const before = pg.calls.length;
  await btn.click();
  await pg.flush();
  assert.ok(pg.calls.slice(before).some((c) => c.url === `/api/run?swap=${F.SWAP_A}`));
});

test("a row without give and get (an older answer, a folder that cannot be read) keeps today's label and role words", async () => {
  const pg = await page({ swaps: [F.summary({ active: true, phase: "created" })] });
  const row = rowsOf(pg)[0];
  assert.equal(row.querySelector(".pg-pair"), null);
  assert.equal(row.querySelector("strong").textContent, "You sell 5 NOID for 0.001 ETH");
  assert.equal(row.querySelector(".pg-role").textContent, "You sell NOID");
});

test("a half that is not a coin and a figure is not drawn: the row falls back to the label", async () => {
  for (const bad of [{ text: "5", coin: "btc" }, { text: "<b>", coin: "noid" }, { text: "", coin: "eth" }, { text: 5, coin: "noid" }, null, "5 NOID"]) {
    const pg = await page({ swaps: [F.summary({ active: true, phase: "created", give: bad, get: { text: "0.001", coin: "eth" } })] });
    const row = rowsOf(pg)[0];
    assert.equal(row.querySelector(".pg-pair"), null, JSON.stringify(bad));
    assert.ok(row.querySelector("strong"), JSON.stringify(bad));
  }
});

test("state words, the until line and the chips of a row: the words are a span (not a chip), at most the three chips of today", async () => {
  const pg = await page({ swaps: [withHalves({ active: true, in_contract: true, needs_you: true, phase: "created", until_text: "NOID comes back after about 16:20 if the swap stops" })] });
  const row = rowsOf(pg)[0];
  const st = row.querySelector(".pg-row-state");
  assert.equal(st.children[0].textContent, "File created, not funded yet");
  assert.equal(st.querySelector(".pg-until").textContent, "NOID comes back after about 16:20 if the swap stops");
  const chips = row.querySelector(".pg-row-chips").children;
  assert.deepEqual(chips.map((c) => textOf(c).trim()), ["Needs you", "Coins are in the contract"]);
  assert.ok(has(chips[0], "accent") && has(chips[1], "warn"));
  assert.ok(has(row, "needs"));
  assert.ok(!has(row, "ended"));
});

test("ended swaps follow one 'Ended' line, are marked ended, and a swap that cannot be read stays above it; row indexes of the live ones do not move", async () => {
  const swaps = [
    withHalves({ swap: "c3".repeat(16), active: false, phase: "done", created_at: 3 }),
    withHalves({ swap: "d4".repeat(16), role: "bob", label: "You sell 0.002 ETH for 10 NOID", give: { text: "0.002", coin: "eth" }, get: { text: "10", coin: "noid" }, active: false, phase: "refunded", created_at: 2 }),
    F.summary({ swap: "e5".repeat(16), refused: "made by another installation", created_at: 9 }),
    withHalves({ swap: F.SWAP_A, active: true, phase: "funding_final", created_at: 5 }),
  ];
  const pg = await page({ swaps });
  const ul = pg.byId("pg-root").querySelector("ul");
  const kids = ul.children;
  const kinds = kids.map((k) => (has(k, "pg-group") ? "divider" : has(k, "ended") ? "ended" : "live"));
  assert.deepEqual(kinds, ["live", "live", "divider", "ended", "ended"]);
  assert.equal(kids[2].textContent, "Ended");
  assert.equal(kids[2].all((n) => has(n, "pg-row")).length, 0, "the divider is not a row");
  assert.equal(rowsOf(pg).length, 4, "four rows, as before");
  // the divider and the rows both have a name for a screen reader
  assert.match(textOf(kids[3]), /Ended/);
  // the chip of a swap that finished is the mint one, any other end is the plain one
  const endChip = (li) => li.all((n) => has(n, "chip") && /Ended/.test(textOf(n)))[0];
  assert.ok(has(endChip(kids[3]), "ok"), "done");
  assert.ok(has(endChip(kids[4]), "quiet"), "refunded");
  // with nothing live, the divider comes first
  const only = await page({ swaps: [swaps[0]] });
  assert.deepEqual(only.byId("pg-root").querySelector("ul").children.map((k) => (has(k, "pg-group") ? "divider" : "row")), ["divider", "row"]);
  // with nothing ended there is no divider
  const none = await page({ swaps: [swaps[3]] });
  assert.equal(none.byId("pg-root").all((n) => has(n, "pg-group")).length, 0);
});

test("the empty list: the mark, a heading and one sentence, above the guide; New swap has a plus before its words", async () => {
  const pg = await page({ swaps: [] });
  const root = pg.byId("pg-root");
  const box = root.all((n) => has(n, "pg-empty"))[0];
  assert.ok(box);
  assert.equal(box.children[0].tag, "img");
  assert.equal(box.children[0].getAttribute("alt"), "", "decoration");
  assert.equal(box.querySelector("h2").textContent, "No swaps yet");
  const kids = root.querySelector("section").children;
  assert.ok(kids.indexOf(box) >= 0 && kids.indexOf(box) < kids.findIndex((k) => has(k, "pg-guide")), "the empty state comes before the guide");
  const nb = pg.byId("pg-new");
  assert.equal(nb.children[0].tag, "svg");
  assert.equal(nb.textContent, "New swap");
});

test("the two vault notices: an icon first, sentence-case labels, the unconfirmed code asks (needs) and its button is the primary one", async () => {
  const closed = await page({ swaps: [], vault: { ready: false, recovery_confirmed: false }, new_swap_allowed: { ok: false, why: "The key store is not open." } });
  const danger = closed.byId("pg-root").all((n) => has(n, "alarm"))[0];
  assert.ok(has(danger, "danger"));
  assert.equal(danger.attrs.role, "alert", "a closed key store is announced at once");
  assert.equal(danger.children[0].tag, "svg");
  assert.equal(danger.querySelector(".lv").textContent, "Key store");
  assert.match(danger.querySelector(".tx").textContent, /The program's key store is not open, so no swap can act\./);
  const unconfirmed = await page({ swaps: [], vault: { ready: true, recovery_confirmed: false }, new_swap_allowed: { ok: false, why: "Confirm your recovery code." } });
  const needs = unconfirmed.byId("pg-root").all((n) => has(n, "alarm"))[0];
  assert.ok(has(needs, "needs"));
  assert.equal(needs.children[0].tag, "svg");
  assert.equal(needs.querySelector(".lv").textContent, "Recovery code");
  const btn = needs.querySelector("button");
  assert.equal(btn.textContent, "Show my recovery code");
  assert.ok(has(btn, "primary") && has(btn, "due"));
  // the words of the notice are the same as before
  assert.match(needs.querySelector(".tx").textContent, /Your recovery code is not confirmed yet\. Without it a swap cannot be restored on another machine, so no new swap starts until you have written it down and typed it back\./);
});

test("the loading list: three skeleton rows, busy, no button but a New swap that cannot be pressed, and nothing a person could act on", async () => {
  const pg = await page({ swaps: [] });
  const box = pg.window.NoidProgram.loadingList();
  const ul = box.querySelector("ul");
  assert.equal(ul.getAttribute("aria-busy"), "true");
  assert.equal(ul.children.length, 3);
  assert.equal(box.all((n) => n.tag === "button").length, 1);
  assert.equal(box.querySelector("button").disabled, true);
  assert.equal(box.all((n) => n.tag === "a" || n.tag === "input").length, 0);
  assert.equal(textOf(ul).trim(), "", "no words in the skeleton");
  void TOKEN;
});

test("the summary's halves reach the page as the server gives them: a figure that is not numbers is never drawn", async () => {
  const pg = await page({ swaps: [withHalves({ active: true, phase: "created", give: { text: "5.25", coin: "noid" } })] });
  // a figure of digits and one dot is drawn as it is (the server makes it); anything with a letter is not
  assert.ok(rowsOf(pg)[0].querySelector(".pg-pair"));
  const bad = await page({ swaps: [withHalves({ active: true, phase: "created", give: { text: "5e18", coin: "noid" } })] });
  assert.equal(rowsOf(bad)[0].querySelector(".pg-pair"), null);
});
