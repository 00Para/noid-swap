"use strict";
// The top bar in the new look: Refresh is an icon button that keeps its name, the menu button carries an icon before its word, the network stays a chip (drawn as a tag by the stylesheet),
// and the label of "Your swaps" is its own span so a narrow window can hide it. Display only: nothing here changes what a control does.
const test = require("node:test");
const assert = require("node:assert/strict");
const { loadPage, textOf } = require("./program-page-dom");
const F = require("./program-page-fixtures");

const has = (n, c) => n.className.split(/\s+/).includes(c);

test("top bar: Refresh is a ghost icon button named Refresh, and it still reads the program again", async () => {
  const page = await loadPage({ fetch: F.router({ "GET /api/program": () => ({ status: 200, body: F.prog({ swaps: [] }) }) }) });
  const bar = page.byId("pg-bar");
  const btn = bar.all((n) => n.tag === "button" && n.attrs["aria-label"] === "Refresh")[0];
  assert.ok(btn, "a button named Refresh");
  assert.ok(has(btn, "btn") && has(btn, "ghost") && has(btn, "icon"), btn.className);
  assert.equal(textOf(btn).replace(/\s+/g, " ").trim(), "Refresh", "its words are there for a screen reader");
  const svg = btn.children.find((c) => c.tag === "svg");
  assert.ok(svg && has(svg, "ic") && svg.getAttribute("aria-hidden") === "true", "the icon comes first and is hidden");
  assert.ok(btn.children.some((c) => c.tag === "span" && has(c, "sr-only") && c.textContent === "Refresh"));
  const before = page.calls.length;
  await btn.click();
  await page.flush();
  assert.ok(page.calls.slice(before).some((c) => c.url.startsWith("/api/program")), "Refresh asks the program again");
});

test("top bar: the menu button has an icon and its word in a span, and Settings is still the item the shell clicks", async () => {
  const page = await loadPage({ fetch: F.router({ "GET /api/program": () => ({ status: 200, body: F.prog({ swaps: [] }) }) }) });
  const bar = page.byId("pg-bar");
  const sum = bar.querySelector("summary");
  assert.equal(sum.attrs["aria-label"], "Menu");
  assert.ok(has(sum, "btn") && has(sum, "ghost"));
  assert.equal(sum.children[0].tag, "svg");
  assert.ok(sum.children[1].tag === "span" && sum.children[1].textContent === "Menu");
  const items = bar.all((n) => n.tag === "button" && n.parent && n.parent.tag === "li");
  const settings = items.filter((b) => b.textContent === "Settings");
  assert.equal(settings.length, 1, "exactly one item whose text is exactly Settings, with no icon text in it");
});

test("top bar: the network and the two node states keep their chips; the swaps button keeps its words and its count", async () => {
  const page = await loadPage({ fetch: F.router({ "GET /api/program": () => ({ status: 200, body: F.prog({ swaps: [F.summary({ active: true })] }) }) }) });
  const bar = page.byId("pg-bar");
  const chips = bar.all((n) => has(n, "chip"));
  assert.deepEqual(chips.map((c) => textOf(c).trim()), ["Test network", "Parano1d: connected", "Ethereum: connected"]);
  assert.ok(has(chips[0], "quiet"), "the network is the quiet chip the stylesheet draws as a tag");
  assert.ok(has(chips[1], "ok") && has(chips[2], "ok"));
  const swaps = bar.querySelector(".pg-swaps-btn");
  assert.equal(swaps.querySelector(".lbl").textContent, "Your swaps");
  assert.equal(swaps.querySelector(".pg-count").textContent, "1 active");
  assert.equal(swaps.attrs["aria-current"], "page");
});
