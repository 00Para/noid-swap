"use strict";
// The technical page under Details, restyled as hairline tables (operator.css, program mode only): the rules are scoped to the fold so that the terminal console keeps its own look, the hint
// beside "Details" is CSS (the summary stays exactly "Details"), the advice about the run folder opens the fold, and the receipts' copy buttons are icons.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const H = require("./look-harness");
const { openSwap, cardPayload, status, ON, LM, F, NOW, mkLock, has, squash } = H;

const CSS = fs.readFileSync(path.join(__dirname, "..", "operator.css"), "utf8");
const HTML = fs.readFileSync(path.join(__dirname, "..", "index.html"), "utf8");
const from = CSS.indexOf("/* ---- the technical page under Details: hairline tables");
const block = CSS.slice(from, CSS.indexOf("/* ---- the forms:", from) > 0 ? CSS.indexOf("/* ---- the forms:", from) : undefined);

test("the rules of the technical page are all scoped to the Details fold, so the terminal console is untouched", () => {
  assert.ok(block.length > 500);
  const rules = block.replace(/\/\*[\s\S]*?\*\//g, "").split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("@media") && l !== "}");
  for (const l of rules) {
    const sel = l.slice(0, l.indexOf("{")).trim();
    for (const one of sel.split(",")) assert.match(one.trim(), /^\.pg-details(-body)?\b/, `not scoped: ${one.trim()}`);
  }
});

test("the hint beside Details is CSS; the summary is still exactly Details with no class and no child", () => {
  assert.match(block, /\.pg-details > summary::after \{ content: "block heights, the engine's words, receipts, the audit log";/);
  assert.match(HTML, /<summary id="pg-details-sum">Details<\/summary>/);
  // the chevron is a data URI whose namespace is written so that no "//name.tld" is left in the sheet
  assert.doesNotMatch(CSS.replace(/\/\*[\s\S]*?\*\//g, ""), /[^:]\/\/[a-z0-9-]+\.[a-z]{2,}/i);
  assert.doesNotMatch(CSS, /url\(["']?https?:/);
});

test("the three pinned lines of the stylesheet are still there, byte for byte", () => {
  assert.ok(CSS.split("\n").some((l) => l === ".spend-box p, .confirm-body p { overflow-wrap: anywhere; }"));
  assert.ok(CSS.split("\n").some((l) => l === ".bundle-check.grouped { font: 400 22px/1.2 var(--mono); letter-spacing: .06em; color: var(--text); }"));
  assert.ok(CSS.split("\n").some((l) => /\.spend-box, \.wallet-funding, \.confirm-body \{ grid-template-columns: minmax\(0, 1fr\); \}/.test(l)));
});

test("under Details the receipts' copy buttons are icons with the value shortened and the full value on the button", async () => {
  const page = await openSwap(F.SWAP_A, (r) => cardPayload(r, { phase: "lock_final", line_match: LM, autopilot: { alice: ON("alice"), bob: null }, status: status("alice"), tick: { lock: mkLock({ timelock: NOW + 9000 }) } }));
  const rc = page.byId("receipts").all((n) => has(n, "rc"));
  assert.ok(rc.length >= 3);
  const buttons = page.byId("receipts").all((n) => n.tag === "button");
  assert.ok(buttons.length >= 3);
  for (const b of buttons) {
    assert.equal(has(b, "copy-txt"), true);
    assert.equal(b.children[0].tag, "svg", "the icon comes first");
    assert.match(b.attrs["aria-label"], /^Copy .*: \S+$/);
  }
});

test("the advice about the run folder is the first thing of Details, once, and not a safety box", async () => {
  const page = await openSwap(F.SWAP_A, (r) => cardPayload(r, { phase: "funding_final", line_match: LM, autopilot: { alice: ON("alice"), bob: null }, status: status("alice") }));
  const first = page.byId("pg-details-body").children[0];
  assert.equal(first.tag, "p");
  assert.equal(has(first, "alarm"), false);
  assert.equal(page.byId("pg-swapbar").all((n) => /Back up the whole run folder/.test(n.textContent || "")).length, 0);
  assert.match(squash(first.textContent), /^Back up the whole run folder \(the swap file and run\.json are in it\) and keep your recovery code\./);
});
