"use strict";
// The icons of the page (actions.js): one frozen table, built with createElementNS, no text inside, hidden from a screen reader. Display only.
const test = require("node:test");
const assert = require("node:assert/strict");
const { loadPage, textOf } = require("./program-page-dom");
const F = require("./program-page-fixtures");

const boot = () => loadPage({ fetch: async (url) => (url.startsWith("/api/program") ? { status: 200, body: F.prog({ swaps: [] }) } : { status: 404, body: {} }) });

test("the seventeen icons of the table each build an svg with the page's class, no text and no listener", async () => {
  const pg = await boot();
  const A = pg.window.NoidActions;
  const names = [...A.ICON_NAMES];
  assert.equal(names.length, 17);
  assert.deepEqual(names.slice().sort(), ["alert", "arrowR", "check", "chevL", "chevR", "clock", "copy", "file", "hand", "info", "key", "menu", "open", "plus", "refresh", "save", "sliders"]);
  for (const n of names) {
    const svg = A.icon(n);
    assert.ok(svg, n);
    assert.equal(svg.tag, "svg", n);
    assert.equal(svg.className, "ic", n);
    assert.equal(svg.getAttribute("aria-hidden"), "true", n);
    assert.equal(svg.getAttribute("focusable"), "false", n);
    assert.equal(svg.getAttribute("viewBox"), "0 0 16 16", n);
    assert.ok(svg.children.length >= 1, n);
    assert.equal(textOf(svg).trim(), "", `${n} holds no text`);
    assert.equal(svg.textContent, "", n);
    assert.equal(Object.keys(svg.listeners).length, 0, n);
    for (const c of svg.children) {
      assert.ok(["path", "circle", "rect"].includes(c.tag), `${n}: ${c.tag}`);
      assert.equal(c.children.length, 0, n);
    }
  }
});

test("an unknown name gives null, a name of the object's own prototype too, and an extra class is only added", async () => {
  const pg = await boot();
  const A = pg.window.NoidActions;
  for (const bad of ["", "nope", "toString", "__proto__", "constructor", null, undefined, 3, {}]) assert.equal(A.icon(bad), null, String(bad));
  assert.equal(A.icon("check", "go").className, "ic go");
});

test("the two coin glyphs are 20-unit svgs with one arc each; any other name gives null", async () => {
  const pg = await boot();
  const A = pg.window.NoidActions;
  for (const c of ["noid", "eth"]) {
    const g = A.coinGlyph(c);
    assert.equal(g.tag, "svg");
    assert.equal(g.className, `coin ${c}`);
    assert.equal(g.getAttribute("viewBox"), "0 0 20 20");
    assert.equal(g.getAttribute("aria-hidden"), "true");
    assert.equal(g.children.length, 1);
    assert.equal(textOf(g).trim(), "");
  }
  assert.notEqual(A.coinGlyph("noid").children[0].getAttribute("d"), A.coinGlyph("eth").children[0].getAttribute("d"));
  for (const bad of ["", "btc", "NOID", null, undefined]) assert.equal(A.coinGlyph(bad), null, String(bad));
});

test("the table cannot be changed from the page: the names list is frozen", async () => {
  const pg = await boot();
  assert.ok(Object.isFrozen(pg.window.NoidActions.ICON_NAMES));
});
