"use strict";
// The display of amounts (actions.js `trimZeros` and `groupAmt`): only trailing zeros and a trailing literal dot are cut. The old `trimZeros` ended with a regex whose dot matched any character,
// so "5.009000" showed as "5.00", "0.500000" as "0." and "1.250000" as "1.2" (found by an outside audit). The page is loaded as the other page tests load it.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { loadPage } = require("./program-page-dom");
const F = require("./program-page-fixtures");

async function amounts() {
  const page = await loadPage({ fetch: F.router({ "GET /api/program": () => ({ status: 200, body: F.prog() }), "GET /api/run": () => ({ status: 200, body: F.runPayload("alice", {}) }) }) });
  return page.window.NoidActions.amount;
}

test("trimZeros: only trailing zeros and a trailing dot are cut", async () => {
  const { trimZeros } = await amounts();
  const cases = [
    ["5.009000", "5.009"],
    ["0.500000", "0.5"],
    ["1.250000", "1.25"],
    ["5.000000", "5"],
    ["5", "5"],
    ["10", "10"],
    ["100.000000", "100"],
    ["0.000001", "0.000001"],
    ["12.340000", "12.34"],
    ["0.001", "0.001"],
  ];
  for (const [from, want] of cases) assert.equal(trimZeros(from), want, from);
});

test("groupAmt: the dot of an amount is a literal dot (a letter or a symbol in its place is not an amount)", async () => {
  const { groupAmt } = await amounts();
  assert.equal(groupAmt("2000 NOID"), "2,000 NOID");
  assert.equal(groupAmt("5000.25 NOID"), "5,000.25 NOID");
  assert.equal(groupAmt("0.001 ETH"), "0.001 ETH");
  // a character other than a dot between the digits used to pass the shape check and was grouped as if it were one
  for (const bad of ["5x250000 NOID", "5,25 NOID", "5 25 NOID", "5-25 ETH"]) assert.equal(groupAmt(bad), bad, bad);
});

test("no regex of the page's own scripts ends an amount with an unescaped dot, and no cut of the last character is made by a regex", () => {
  const dir = path.join(__dirname, "..");
  const src = fs.readFileSync(path.join(dir, "actions.js"), "utf8");
  assert.ok(!/\.replace\(\/\.\$\//.test(src), "trimZeros must not cut the last character whatever it is");
  assert.ok(!/\(\?:\.\[0-9\]\+\)\?/.test(src), "groupAmt's fraction must be a literal dot");
});
