"use strict";
// The first-start guide on the empty list of swaps: what a swap needs from outside the program, with the live word of the Parano1d node, and no link. With a swap on the list it is not there.
const test = require("node:test");
const assert = require("node:assert/strict");
const { loadPage, textOf } = require("./program-page-dom");
const F = require("./program-page-fixtures");

async function listPage(over = {}) {
  return loadPage({ fetch: F.router({ "GET /api/program": () => ({ status: 200, body: F.prog({ swaps: [], ...over }) }) }) });
}

const ITEMS = [
  /^The Parano1d wallet app is open on this computer and in sync\./,
  /^An Ethereum wallet and its address: on Sepolia \(the test network\) for a test swap, on Ethereum mainnet for a real one\. The ETH you get, or what is left, goes there\. Use your own wallet, not an exchange\.$/,
  /^For a real swap on Ethereum mainnet: real ETH and real NOID, at most 0\.5 ETH and 2,500 NOID per swap\. Start small\. For a test swap: Sepolia test ETH in that wallet\. It has no value and is free from a Sepolia faucet; search for "Sepolia faucet", as they change often\. If you sell NOID, a little is enough: it pays one fee\.$/,
  /^If you sell NOID: the NOID to swap and a little more for the fee, in the Parano1d wallet app\. If you sell ETH: the ETH to swap and a little more for two fees\.$/,
  /^The amounts, agreed with the other person\. The one who sells ETH makes the swap first and sends the other an invitation file\.$/,
  /^About an hour with both computers on and awake\.$/,
];

test("guide: an empty list shows the heading, the intro, six numbered steps and the closing line", async () => {
  const page = await listPage();
  const root = page.byId("pg-root");
  const guide = root.all((n) => n.className.split(/\s+/).includes("pg-guide"))[0];
  assert.ok(guide, "the guide is drawn");
  assert.equal(guide.querySelector("h2").textContent, "Before your first swap");
  assert.match(textOf(guide), /A swap needs a few things outside this program\. Each computer needs them for itself\./);
  const ol = guide.querySelector("ol");
  assert.ok(ol, "a real ordered list");
  const items = ol.children.map((li) => textOf(li).replace(/\s+/g, " ").trim());
  assert.equal(items.length, 6);
  ITEMS.forEach((re, i) => assert.match(items[i], re, `step ${i + 1}`));
  const emptyBox = root.all((n) => n.className.split(/\s+/).includes("pg-empty"))[0];
  assert.ok(emptyBox, "the empty state is drawn above the guide");
  assert.equal(emptyBox.querySelector("h2").textContent, "No swaps yet");
  assert.equal(emptyBox.querySelector("p").textContent, "Make one with New swap, or use the offer board if it is on.");
  // the heading names the section
  assert.equal(guide.attrs["aria-labelledby"], "pg-h-guide");
  assert.equal(guide.querySelector("h2").attrs.id, "pg-h-guide");
});

test("guide: the first step carries the live Parano1d word, the same one as the top bar", async () => {
  const states = [
    ["ok", /Parano1d: connected$/, "ok"],
    ["not_running", /Parano1d: not running: start the Parano1d wallet app$/, "danger"],
    ["behind", /Parano1d: behind: still catching up$/, "attn"],
    ["wrong_chain", /Parano1d: not the expected chain$/, "danger"],
  ];
  for (const [state, re, level] of states) {
    const page = await listPage({ node: { noid: { state, tip: 1, chain_checked: true, ok_since_start: true, checked_at: 1 }, eth: { state: "ok", chain_id: 11155111, endpoints: 1, checked_at: 1 } } });
    const first = page.byId("pg-root").querySelector("ol").children[0];
    const chip = first.all((n) => n.className.split(/\s+/).includes("chip"))[0];
    assert.ok(chip, state);
    assert.match(textOf(chip).trim(), re, state);
    assert.ok(chip.className.split(/\s+/).includes(level), `${state}: ${chip.className}`);
    assert.ok(textOf(page.byId("pg-bar")).includes(textOf(chip).trim()), "the top bar says the same");
  }
  // an unknown state reads as "cannot be checked", never as a raw value
  const odd = await listPage({ node: { noid: { state: "<b>x</b>" }, eth: null } });
  assert.match(textOf(odd.byId("pg-root").querySelector("ol").children[0]), /Parano1d: cannot be checked/);
  assert.doesNotMatch(textOf(odd.byId("pg-root")), /<b>/);
});

test("guide: the live word follows the next poll without leaving the page", async () => {
  let state = "not_running";
  const page = await loadPage({ fetch: F.router({ "GET /api/program": () => ({ status: 200, body: F.prog({ swaps: [], node: { noid: { state, tip: 1, chain_checked: true, ok_since_start: true, checked_at: 1 }, eth: { state: "ok", chain_id: 11155111, endpoints: 1, checked_at: 1 } } }) }) }) });
  assert.match(textOf(page.byId("pg-root").querySelector("ol")), /not running/);
  state = "ok";
  await page.intervals[0].f();
  await page.flush();
  assert.match(textOf(page.byId("pg-root").querySelector("ol")), /Parano1d: connected/);
  assert.doesNotMatch(textOf(page.byId("pg-root").querySelector("ol")), /not running/);
});

test("guide: no link anywhere in it (no anchor, no address)", async () => {
  const page = await listPage();
  const guide = page.byId("pg-root").all((n) => n.className.split(/\s+/).includes("pg-guide"))[0];
  assert.equal(guide.all((n) => n.tag === "a" || Object.prototype.hasOwnProperty.call(n.attrs, "href")).length, 0);
  assert.doesNotMatch(textOf(guide), /https?:\/\/|www\./i);
});

test("guide: a list with a swap on it has no guide and no empty-list line", async () => {
  const page = await loadPage({ fetch: F.router({ "GET /api/program": () => ({ status: 200, body: F.prog() }) }) });
  const root = page.byId("pg-root");
  assert.equal(root.all((n) => n.className.split(/\s+/).includes("pg-guide")).length, 0);
  assert.doesNotMatch(textOf(root), /Before your first swap|No swaps yet/);
});

test("guide: the guide leaves the New swap button and the banners where they were", async () => {
  const why = "Write down your recovery code first: it is not confirmed yet.";
  const page = await listPage({ new_swap_allowed: { ok: false, why }, vault: { ready: true, recovery_confirmed: false } });
  assert.equal(page.byId("pg-new").disabled, true);
  assert.equal(textOf(page.byId("pg-new-why")).trim(), why);
  assert.match(textOf(page.byId("pg-root")), /Before your first swap/);
  assert.match(textOf(page.byId("pg-root")), /recovery code is not confirmed yet/i);
});
