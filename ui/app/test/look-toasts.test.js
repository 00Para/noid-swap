"use strict";
// Toasts (operator.js toast, copiedWords): a copy, a saved file and the saved settings say what was done in a paragraph of the live region #toasts, which goes after 2.4 s. The button's own
// flash stays. A toast is a confirmation only: it holds a tick and words, no button, no link, nothing that needs an answer.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const H = require("./look-harness");
const { loadPage, textOf } = require("./program-page-dom");
const { openSwap, cardPayload, status, ON, LM, F, NOW, has, btnWith, squash } = H;

const toastsOf = (page) => page.byId("toasts").children.map((t) => squash(textOf(t)));
/** A page whose clipboard works and whose timers are kept, so a test runs them by hand. */
async function withTimers(page, writeOk = true) {
  const timers = [];
  page.window.setTimeout = (f, ms) => {
    timers.push({ f, ms });
    return timers.length;
  };
  page.window.navigator.clipboard = { writeText: async () => { if (!writeOk) throw new Error("no"); } };
  return timers;
}

test("copying an amount says Amount copied with the figure, an address says Address copied, and the button's own flash stays", async () => {
  const page = await openSwap(F.SWAP_A, (r) => cardPayload(r, { line_match: LM, autopilot: { alice: ON("alice"), bob: null }, status: status("alice", { covers: false, plain: 3000000 }) }));
  const timers = await withTimers(page);
  const buttons = page.byId("pg-card").all((n) => n.tag === "button" && /^Copy /.test(n.attrs["aria-label"] || ""));
  const amount = buttons.find((b) => /amount/.test(b.attrs["aria-label"]));
  const address = buttons.find((b) => /address/.test(b.attrs["aria-label"]));
  assert.ok(amount && address);
  await amount.click();
  await page.flush();
  assert.deepEqual(toastsOf(page), ["Amount copied: 5.009"]);
  await address.click();
  await page.flush();
  assert.deepEqual(toastsOf(page), ["Amount copied: 5.009", "Address copied"]);
  // the flash of the button itself is still there
  assert.ok(amount.all((n) => has(n, "glyph")).some((g) => /copied/.test(g.textContent)));
  // each toast is a paragraph with a tick first and no control inside
  for (const t of page.byId("toasts").children) {
    assert.equal(t.tag, "p");
    assert.equal(has(t, "toast"), true);
    assert.equal(t.children[0].tag, "svg");
    assert.equal(t.all((n) => n.tag === "button" || n.tag === "a" || n.tag === "input").length, 0);
  }
  // and each goes after 2.4 seconds
  const mine = timers.filter((t) => t.ms === 2400);
  assert.equal(mine.length, 2);
  mine[0].f();
  assert.deepEqual(toastsOf(page), ["Address copied"]);
  mine[1].f();
  assert.deepEqual(toastsOf(page), []);
});

test("a copy that failed raises no toast, and a long run of copies keeps at most three", async () => {
  const page = await openSwap(F.SWAP_A, (r) => cardPayload(r, { line_match: LM, autopilot: { alice: ON("alice"), bob: null }, status: status("alice", { covers: false, plain: 3000000 }) }));
  await withTimers(page, false);
  const b = page.byId("pg-card").all((n) => n.tag === "button" && /^Copy .*amount/.test(n.attrs["aria-label"] || ""))[0];
  await b.click();
  await page.flush();
  assert.deepEqual(toastsOf(page), []);
  page.window.navigator.clipboard = { writeText: async () => {} };
  for (let i = 0; i < 5; i++) {
    await b.click();
    await page.flush();
  }
  assert.equal(page.byId("toasts").children.length, 3);
});

test("saving the swap file for Bob says Saved a copy for Bob; a cancelled save says nothing", async () => {
  let saved = true;
  const page = await openSwap(F.SWAP_A, (r) => cardPayload(r, {}), { "POST /api/bundle/save": () => ({ status: 200, body: { ok: true, saved } }) });
  const timers = await withTimers(page);
  const btn = btnWith(page.byId("pg-card"), "Save a copy for Bob");
  assert.ok(btn);
  saved = false;
  await btn.click();
  await page.flush();
  assert.deepEqual(toastsOf(page), []);
  saved = true;
  await btnWith(page.byId("pg-card"), "Save a copy for Bob").click();
  await page.flush();
  assert.deepEqual(toastsOf(page), ["Saved a copy for Bob"]);
  assert.ok(timers.some((t) => t.ms === 2400));
});

test("saving the settings says Settings saved, and a refused save says nothing", async () => {
  let answer = { status: 200, body: { ok: true, settings: { v: 1 } } };
  const page = await loadPage({ fetch: F.router({ "GET /api/program": () => ({ status: 200, body: F.prog() }), "GET /api/settings": { ok: true, settings: { v: 1 } }, "POST /api/settings": () => answer }) });
  await withTimers(page);
  await page.byId("pg-bar").all((n) => n.tag === "button" && textOf(n).includes("Settings"))[0].click();
  await page.flush();
  const go = page.byId("pg-root").all((n) => n.attrs.id === "st-go")[0];
  answer = { status: 400, body: { ok: false, errors: { noid_rpc: "bad" } } };
  await go.click();
  await page.flush();
  assert.deepEqual(toastsOf(page), []);
  answer = { status: 200, body: { ok: true, settings: { v: 1 } } };
  await page.byId("pg-root").all((n) => n.attrs.id === "st-go")[0].click();
  await page.flush();
  assert.deepEqual(toastsOf(page), ["Settings saved"]);
});

test("the toasts' place is a polite live region, once, and its rules are in the stylesheet with the reduced-motion rule intact", () => {
  const html = fs.readFileSync(path.join(__dirname, "..", "index.html"), "utf8");
  assert.equal((html.match(/id="toasts"/g) || []).length, 1);
  assert.match(html, /<div id="toasts" class="toasts" role="status" aria-live="polite"><\/div>/);
  const css = fs.readFileSync(path.join(__dirname, "..", "operator.css"), "utf8");
  assert.match(css, /\.toast \{ display: flex;[^}]*animation: toast-in var\(--t-med\)/);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\) \{ \*, \*::before, \*::after \{ transition: none !important; animation: none !important; \} \}/);
});
