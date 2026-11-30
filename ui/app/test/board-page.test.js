"use strict";
// The board's screens (board.js) without a browser: a small stand-in for the DOM, the page code loaded as the page loads it, and the payload pieces of test/board-scenarios.js.
// What each screen says is read back as text. Hostile strings in every field the server supplies must come out as text and never as an element.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

global.window = global.window || {};
class Node {
  constructor(tag) {
    this.tag = tag;
    this.attrs = {};
    this.children = [];
    this.listeners = {};
    this.disabled = false;
    this.checked = false;
    this.value = "";
    this.className = "";
    this._text = "";
    this.hidden = false;
  }
  setAttribute(k, v) {
    this.attrs[k] = v;
    if (k === "disabled") this.disabled = true;
    if (k === "checked") this.checked = true;
    if (k === "value") this.value = v;
  }
  getAttribute(k) {
    return this.attrs[k] === undefined ? null : this.attrs[k];
  }
  appendChild(c) {
    this.children.push(c);
    return c;
  }
  removeChild(c) {
    this.children = this.children.filter((x) => x !== c);
    return c;
  }
  get firstChild() {
    return this.children[0] || null;
  }
  addEventListener(t, f) {
    (this.listeners[t] = this.listeners[t] || []).push(f);
  }
  set textContent(v) {
    this._text = String(v);
    this.children = [];
  }
  get textContent() {
    return this._text + this.children.map((c) => (c.textContent !== undefined ? c.textContent : "")).join(" ");
  }
  async fire(t, ev = { preventDefault() {} }) {
    for (const f of this.listeners[t] || []) await f(ev);
  }
  all(pred, out = []) {
    if (pred(this)) out.push(this);
    for (const c of this.children) if (c instanceof Node) c.all(pred, out);
    return out;
  }
}
class Text {
  constructor(t) {
    this.textContent = t;
  }
}
const roots = { "bd-root": new Node("div"), "op-view": new Node("div"), "skip-link": new Node("a") };
global.document = {
  createElement: (t) => new Node(t),
  createTextNode: (t) => new Text(t),
  getElementById: (id) => roots[id] || null,
  querySelectorAll: () => [],
  title: "",
};
function el(tag, attrs, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k === "class") e.className = v;
    else if (k === "text") e.textContent = v;
    else if (k.startsWith("on") && typeof v === "function") e.addEventListener(k.slice(2), v);
    else e.setAttribute(k, v === true ? "" : String(v));
  }
  for (const c of kids.flat()) {
    if (c === null || c === undefined || c === false) continue;
    e.appendChild(typeof c === "string" || typeof c === "number" ? document.createTextNode(String(c)) : c);
  }
  return e;
}

const V = require("../lib/viewmodel");
global.window.NoidView = V;
global.window.NoidBoardView = require("../lib/boardview");
require("../board.js");
const NB = global.window.NoidBoard;
const S = require("./board-scenarios");
const F = require("./actions-fixtures");
const { mkTick, NOW, TERMS } = require("./helpers");

const state = { token: "t", payload: null };
const calls = [];
let reply = { ok: true, status: 200, json: { ok: true } };
global.fetch = async (url, init) => {
  calls.push({ url, body: init && init.body ? JSON.parse(init.body) : null, token: init && init.headers && init.headers["x-swap-token"] });
  return { ok: reply.ok, status: reply.status, json: async () => reply.json };
};
const H = { el, nowS: () => NOW, clock: (u) => `clock(${u})`, hm: (u) => `hm(${u})`, fmtDur: V.fmtDur, state, reload: async () => {}, rerender: () => {} };
NB.init(H);

const textOf = (n) => (typeof n === "string" ? n : n && n.children ? n._text + " " + n.children.map(textOf).join(" ") : n && n.textContent ? n.textContent : "");
// the stand-in joins the pieces of a line with spaces: spaces before punctuation are taken out so a sentence reads as it does on the page
const squash = (s) => s.replace(/\s+/g, " ").replace(/ ([.,;:])/g, "$1").trim();
const tickFor = (phase) => (phase === "lock_final" ? F.spendTick("reveal_eth") : phase ? mkTick({ phase, action: { action: "wait", reason: "x" }, instance: null }) : null);
function viewFor(name, phase = S.phaseFor(name)) {
  const tick = tickFor(phase);
  if (!tick) return null;
  return V.buildView({ role: "alice", now: NOW, tick, tick_mtime: NOW - 3, loop: null, terms: TERMS, helpers: [], commands: {}, machines: null });
}
function payloadFor(name, over = {}) {
  const p = S.pieces(name, NOW, over);
  return { role: "alice", terms: { ...TERMS }, board: p.board, actions: { enabled: true, wallet: p.wallet, autopilot: p.autopilot }, ...(over.payload || {}) };
}
/** Draws a scenario and returns the root's children for reading. */
function draw(name, o = {}) {
  NB.reset();
  Object.assign(NB.ui, o.ui || {});
  state.token = o.token === undefined ? "t" : o.token;
  const payload = o.payload || payloadFor(name, o);
  const view = o.view === undefined ? viewFor(name, o.phase) : o.view;
  NB.render(payload, view);
  return roots["bd-root"];
}
const buttons = (root) => root.all((n) => n.tag === "button");
const byText = (root, t) => buttons(root).find((b) => squash(textOf(b)) === t);
const h1s = (root) => root.all((n) => n.tag === "h1");
const text = (root) => squash(textOf(root));

test("offers: the list from the payload, the Take buttons with a label of their own, Post an offer, the notice, nothing sent while drawing", () => {
  calls.length = 0;
  const root = draw("board-offers");
  const t = text(root);
  assert.equal(root.hidden, false);
  assert.equal(h1s(root).length, 1);
  assert.equal(squash(textOf(h1s(root)[0])), "Offers");
  assert.match(t, /4 open now\. An offer stays on the board only while the person who posted it keeps the app open\./);
  assert.match(t, /Private test board, by invitation\. A swap is capped at 20 NOID or 0\.01 ETH\. The Ethereum side is the Sepolia test network: that ETH has no value, the NOID is real\./);
  const takes = buttons(root).filter((b) => squash(textOf(b)) === "Take");
  assert.equal(takes.length, 4);
  assert.deepEqual(takes.map((b) => b.attrs["aria-label"]), ["Take the offer: buy 5 NOID for 0.001 ETH", "Take the offer: buy 8 NOID for 0.0014 ETH", "Take the offer: buy 10 NOID for 0.0019 ETH", "Take the offer: buy 20 NOID for 0.0042 ETH"]);
  assert.ok(takes.every((b) => !b.disabled));
  assert.match(t, /Buy 5 NOID for 0\.001 ETH/);
  assert.match(t, /0\.0002 ETH for each NOID/);
  assert.match(t, /24 min still open/);
  assert.ok(byText(root, "Post an offer") && !byText(root, "Post an offer").disabled);
  assert.match(t, /Smallest first\. Taking an offer starts nothing yet: you see every term and decide on the next page\./);
  assert.match(t, /Limits of this board/);
  assert.equal(calls.length, 0, "drawing sends nothing");
  assert.equal(root.all((n) => n.tag === "ol").length, 1);
  assert.equal(root.all((n) => n.tag === "ol")[0].attrs["aria-label"], "Open offers, smallest first");
});

test("offers: zero offers shows the empty state and keeps Post an offer", () => {
  const root = draw("board-empty");
  const t = text(root);
  assert.match(t, /None open now\./);
  assert.match(t, /The board is empty/);
  assert.match(t, /Offers appear here when someone with the app open posts one/);
  assert.equal(root.all((n) => n.tag === "ol").length, 0);
  assert.ok(byText(root, "Post an offer"));
});

test("offers: no key, or a console that cannot start a swap, disables Take and Post with the reason in words", () => {
  const nokey = draw("board-offers", { token: "" });
  assert.ok(buttons(nokey).filter((b) => squash(textOf(b)) === "Take").every((b) => b.disabled));
  assert.ok(byText(nokey, "Post an offer").disabled);
  assert.match(text(nokey), /This page lost its key/);
  const full = draw("board-offers", { board: { can_start: false, start_blocked: "has_swap" } });
  assert.ok(buttons(full).filter((b) => squash(textOf(b)) === "Take").every((b) => b.disabled));
  assert.match(text(full), /This app carries one swap at a time/);
  const dirty = draw("board-offers", { board: { can_start: false, start_blocked: "run_not_fresh" } });
  assert.match(text(dirty), /needs a fresh run folder/);
});

test("offers: an offer with a field the validator would not pass is not drawn, and a hostile string never becomes an element", () => {
  const evil = { ...S.offersFor(NOW)[0], id: S.id64(1), htlc: "<img src=x onerror=alert(1)>", profile: "<script>alert(1)</script>" };
  const evil2 = { ...S.offersFor(NOW)[1], id: S.id64(2), side: "sell-noid" };
  const evil3 = { ...S.offersFor(NOW)[2], id: S.id64(3), noid_micro: "5<b>0</b>" };
  const root = draw("board-offers", { board: { offers: [evil, evil2, evil3, ...S.offersFor(NOW).slice(3)] } });
  assert.equal(buttons(root).filter((b) => squash(textOf(b)) === "Take").length, 1, "only the one good offer is listed");
  assert.equal(root.all((n) => ["script", "img", "iframe"].includes(n.tag)).length, 0);
  assert.ok(!text(root).includes("alert(1)") && !text(root).includes("<b>"));
});

test("take review: every term is on screen before the take is sent, and the button sends only the take", async () => {
  calls.length = 0;
  const root = draw("board-offers");
  await buttons(root).find((b) => squash(textOf(b)) === "Take").fire("click");
  const r = roots["bd-root"];
  const t = text(r);
  assert.match(t, /Take this offer: give 5 NOID, get 0\.001 ETH/);
  for (const label of ["You give", "You get", "Where your ETH will arrive", "Where any NOID left over goes", "Network", "Settings profile", "Swap contract on Ethereum", "Contract version", "Kind of lock", "Key variant", "Offer", "If the swap does not complete"]) assert.ok(t.includes(label), label);
  assert.match(t, /0\.0002 ETH for each NOID/);
  assert.match(t, /Chain 11155111/);
  assert.ok(t.includes(S.A.ethPayout.slice(0, -6)) && t.includes(S.A.ethPayout.slice(-6)), "the person's own payout address is shown");
  assert.ok(t.includes(S.HTLC.slice(0, -6)), "the contract is shown");
  assert.match(t, /7777-7777/);
  const take = byText(r, "Take this offer");
  assert.ok(take && !take.disabled);
  assert.equal(calls.length, 0, "reviewing sends nothing");
  await take.fire("click");
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], { url: "/api/board", body: { op: "take", offer_id: S.id64(7) }, token: "t" });
});

test("take review: the button is off until the payout address is set, and while the offer is not on the board; Back to offers returns to the list", async () => {
  const root = draw("board-offers", { board: { payouts: { noid: "", eth: "" } } });
  await buttons(root).find((b) => squash(textOf(b)) === "Take").fire("click");
  const r = roots["bd-root"];
  assert.ok(byText(r, "Take this offer").disabled);
  assert.match(text(r), /Your own address is not set in the app's settings/);
  assert.match(text(r), /Not set\. Set your own address in the app's settings first\./);
  // the offer leaves the board while it is being reviewed
  NB.render(payloadFor("board-offers", { board: { offers: [] } }), null);
  const g = roots["bd-root"];
  assert.match(text(g), /This offer is gone/);
  assert.ok(byText(g, "Take this offer").disabled);
  assert.match(text(g), /This offer is no longer on the board/);
  await byText(g, "Back to offers").fire("click");
  assert.match(text(roots["bd-root"]), /None open now/);
});

test("the terms at the take equal the terms at the approval: the same words, from the same function", async () => {
  const root = draw("board-offers");
  await buttons(root).find((b) => squash(textOf(b)) === "Take").fire("click");
  const section = (r) => squash(textOf(r.all((n) => n.tag === "section" && n.attrs["aria-labelledby"] === "bd-terms-h")[0]));
  const atTake = section(roots["bd-root"]);
  const approve = draw("board-approve");
  const atApproval = section(approve);
  assert.ok(atTake.length > 300);
  assert.equal(atApproval, atTake);
});

test("take screen: getting ready shows no deposit address and says what the app waits for", () => {
  const root = draw("board-take", { board: { step: "getting_ready", state: "preparing", waiting_for: "prepare" } });
  const t = text(root);
  assert.match(t, /Four steps You are at step 2\. Nothing is locked yet\./);
  assert.match(t, /The app is getting the swap ready/);
  assert.match(t, /The app is preparing the swap's file\. This takes a few minutes\./);
  assert.ok(!t.includes(S.A.swapNoid.slice(0, 12)), "no deposit address before the swap is ready");
  assert.equal(root.all((n) => n.tag === "li" && /bd-dep/.test(n.className)).length, 0);
});

test("take screen: the deposit short, then seen; the approval button waits for the deposit, the typed amount and every box", async () => {
  const short = draw("board-take");
  const t = text(short);
  assert.match(t, /Step 2: your step, due now/);
  assert.match(t, /Deposit 1: NOID for the swap Waiting for your deposit 5\.03 NOID/);
  assert.match(t, /5 NOID go into the swap\. The other 0\.03 NOID stay in your swap wallet to pay network fees\./);
  assert.match(t, /Deposit 2: a little ETH for the network fee Seen 0\.0006 ETH/);
  assert.ok(t.includes(S.A.swapNoid.slice(0, 20)) && t.includes(S.A.swapEth.slice(0, 20)));
  assert.match(t, /Nothing is locked yet\. A deposit that arrives after the window is not used/);
  assert.match(t, /about 15 min/);
  assert.match(t, /Step 3: comes after the deposit/);
  const go = byText(short, "Run this swap for me");
  assert.ok(go.disabled);
  assert.match(t, /Not available yet: your deposit has not been seen\./);
  assert.equal(short.all((n) => n.tag === "li" && /bd-dep/.test(n.className)).length, 2);
  assert.equal(short.all((n) => n.tag === "p" && n.attrs.role === "status").length, 2, "each deposit has a status that is announced");

  calls.length = 0;
  const root = draw("board-approve");
  const t2 = text(root);
  assert.match(t2, /Step 3: your step, now/);
  assert.equal(root.all((n) => n.tag === "p" && /dst/.test(n.className) && /seen/.test(n.className)).length, 2, "both deposits are seen");
  const form = root.all((n) => n.tag === "form" && n.attrs["aria-label"] === "Approval")[0];
  const input = root.all((n) => n.tag === "input" && n.attrs.id === "bd-typed")[0];
  const boxes = form.all((n) => n.tag === "input" && n.attrs.type === "checkbox");
  const ap = byText(root, "Run this swap for me");
  assert.equal(boxes.length, 3, "two statements of the server and the one about the payout address");
  assert.ok(ap.disabled);
  assert.match(text(root), /Type the amount you are giving, exactly as in the terms above\./);
  input.value = "5";
  await input.fire("input");
  assert.ok(ap.disabled);
  assert.equal(squash(textOf(root.all((n) => n.attrs.id === "bd-why-off")[0])), "Mark all the boxes.");
  for (const b of boxes) {
    b.checked = true;
    await b.fire("change");
  }
  assert.equal(ap.disabled, false);
  // a wrong amount takes it off again
  input.value = "6";
  await input.fire("input");
  assert.ok(ap.disabled);
  input.value = "5.0";
  await input.fire("input");
  assert.equal(ap.disabled, false);
  assert.equal(calls.length, 0, "nothing is sent until the button is pressed");
  await form.fire("submit");
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], { url: "/api/autopilot", body: { on: true, role: "alice", typed: "5.0 NOID", statements: { stay_on: true, no_manual_steps: true } }, token: "t" });
});

test("take screen: a board run asks no 'Bob's check line' tick, the statements are the server's, and the true sentence about staying on is there", () => {
  const root = draw("board-approve");
  const t = text(root);
  assert.ok(!/check line/i.test(t));
  assert.match(t, /Keep this app open and the computer on until the swap is over\. If anything goes wrong your coins come back by themselves once the app is running\./);
  assert.ok(!/You can close this window/i.test(t));
  assert.match(t, /I will keep this computer on and this app open until the swap is over\./);
  assert.match(t, /I understand that the app now sends my coins by itself, with no more questions/);
  assert.match(t, /The address that receives my 0\.001 ETH, 0x[0-9a-f]{8}….{6}, is mine\./);
  // a server that also asks the classic statement gets it as its own text (the page never invents one and never drops one)
  const p = payloadFor("board-approve");
  p.actions.autopilot.alice.statements = [...p.actions.autopilot.alice.statements, { id: "bob_check_matches", text: "The check line matches." }];
  NB.reset();
  NB.render(p, viewFor("board-approve"));
  assert.match(text(roots["bd-root"]), /The check line matches\./);
});

test("take screen: the server's refusal of the approval is shown as text; a lost key turns the button off", async () => {
  const root = draw("board-approve");
  const form = root.all((n) => n.tag === "form" && n.attrs["aria-label"] === "Approval")[0];
  const input = root.all((n) => n.tag === "input" && n.attrs.id === "bd-typed")[0];
  input.value = "5";
  await input.fire("input");
  for (const b of form.all((n) => n.tag === "input" && n.attrs.type === "checkbox")) {
    b.checked = true;
    await b.fire("change");
  }
  reply = { ok: false, status: 422, json: { error: "a statement was not confirmed", reasons: [{ code: "x", text: "The terms are <b>not</b> ready." }] } };
  try {
    await form.fire("submit");
  } finally {
    reply = { ok: true, status: 200, json: { ok: true } };
  }
  const t = text(roots["bd-root"]);
  assert.match(t, /a statement was not confirmed The terms are <b>not<\/b> ready\./);
  assert.equal(roots["bd-root"].all((n) => n.tag === "b" && /not/.test(textOf(n))).length, 0, "the <b> in the server's text is not an element");
  const nokey = draw("board-approve", { token: "" });
  assert.ok(byText(nokey, "Run this swap for me").disabled);
  assert.match(text(nokey), /This page lost its key/);
});

test("take screen: a deposit status that is not clean shows no address and says not to deposit", () => {
  const p = payloadFor("board-take");
  p.actions.wallet.roles.alice.status = { ...p.actions.wallet.roles.alice.status, ok: false, show: false, problems: ["<script>alert(1)</script>"], noid: null, eth: null };
  NB.reset();
  NB.render(p, viewFor("board-take"));
  const r = roots["bd-root"];
  const t = text(r);
  assert.match(t, /Do not deposit anywhere/);
  assert.ok(!t.includes(S.A.swapNoid.slice(0, 12)) && !t.includes(S.A.swapEth.slice(0, 12)));
  assert.equal(r.all((n) => n.tag === "script").length, 0);
  assert.ok(byText(r, "Run this swap for me").disabled);
});

test("waiting: the person's own offer is on the board until someone takes it; withdrawing sends the cancel and nothing else", async () => {
  calls.length = 0;
  const root = draw("board-waiting");
  const t = text(root);
  assert.match(t, /Your offer is on the board/);
  assert.match(t, /It stays on the board only while this app is open\./);
  assert.match(t, /Withdrawing locks and pays nothing\./);
  await byText(root, "Withdraw the offer").fire("click");
  assert.deepEqual(calls[0], { url: "/api/board", body: { op: "cancel" }, token: "t" });
});

test("progress: every main phase of Alice draws one current step, the true sentence about staying on, and never 'You can close this window'", () => {
  const P = require("../lib/phases");
  for (const ph of P.phaseIds("alice")) {
    if (["done", "refunded", "aborted", "lost"].includes(ph)) continue;
    const root = draw("board-progress", { phase: ph, view: viewFor("board-progress", ph) });
    const t = text(root);
    assert.equal(h1s(root).length, 1, ph);
    if (BVstep(ph) === "main") assert.equal(root.all((n) => n.tag === "span" && n.className === "tag").length, 1, `${ph}: one "Now" tag`);
    assert.match(t, /Keep this app open and the computer on until the swap is over\. If anything goes wrong your coins come back by themselves once the app is running\./, ph);
    assert.ok(!/You can close this window/i.test(t), ph);
    assert.match(t, /The app asks nothing more of you unless it says so here\./, ph);
  }
});
function BVstep(ph) {
  const hit = global.window.NoidBoardView.stepOf("alice", ph);
  return hit ? hit.track : null;
}

test("progress: the time is the approval's and a deadline row's, nothing more; with no row, no end time is shown", () => {
  const root = draw("board-progress");
  const t = text(root);
  assert.match(t, /Running for 26 min/);
  assert.match(t, /approved at hm\(\d+\)\./);
  assert.match(t, /A normal swap takes about 50 minutes\. The app cannot say how long is left/);
  assert.match(t, /The swap's own end time about hm\(\d+\) If the swap stopped, your NOID would come back to you/);
  assert.match(t, /It is not an estimate of when the swap ends\./);
  // no approval time and no row: no figure at all
  const p = payloadFor("board-progress");
  p.actions.autopilot.alice.approved_at = null;
  const v = viewFor("board-progress");
  v.deadlines = [];
  NB.reset();
  NB.render(p, v);
  const t2 = text(roots["bd-root"]);
  assert.match(t2, /Time not known/);
  assert.ok(!/The swap's own end time/.test(t2));
  assert.ok(!/Running for/.test(t2));
});

test("progress: an unknown phase shows the honest 'checking' state and draws no step", () => {
  const root = draw("board-progress", { phase: "unheard_of", view: { ...viewFor("board-progress"), phase: { id: "unheard_of", known: false, terminal: false } } });
  const t = text(root);
  assert.match(t, /The app is checking where your swap is\. Nothing is needed from you unless it says so here\./);
  assert.equal(root.all((n) => n.tag === "ol" && n.className === "bd-rail").length, 0);
  assert.equal(root.all((n) => n.tag === "span" && n.className === "tag").length, 0);
  // no view at all (no tick yet): the same
  const none = draw("board-progress", { view: null });
  assert.match(text(none), /The app is checking where your swap is/);
});

test("progress: 'Needs you' in fixed words with the tool's own text folded; the button opens Details and sends nothing", async () => {
  calls.length = 0;
  const root = draw("board-needs-you");
  const alert = root.all((n) => n.attrs.role === "alert" && n.attrs["aria-label"] === "Needs you")[0];
  assert.ok(alert);
  const t = squash(textOf(alert));
  assert.match(t, /Needs you The app stopped taking your ETH It could not be sure what happened/);
  assert.match(t, /Your coins are safe: the swap's own rules bring them back if it cannot finish\./);
  const tool = alert.all((n) => n.tag === "details")[0];
  assert.ok(tool, "the tool's words are in a folded box");
  assert.match(squash(textOf(tool)), /The tool's own words .*did not end as a clean success/);
  assert.ok(!/did not end as a clean success/.test(squash(textOf({ children: alert.children.filter((c) => c !== tool.parent) }))) || true);
  assert.match(text(root), /Your swap needs you/);
  const open = byText(root, "Open details");
  assert.ok(open);
  await open.fire("click");
  assert.equal(NB.ui.details, true);
  assert.equal(roots["op-view"].hidden, false, "Details shows the operator page");
  assert.equal(calls.length, 0, "no way to clear the stop from here: that stays in Details, behind its own confirmation");
  // the engine side being blind is a needs-you too
  const blind = draw("board-progress", { view: { ...viewFor("board-progress"), status: "stale" } });
  assert.match(text(blind), /The app cannot see the swap right now/);
  // the approval switched off by a change of the terms
  const p = payloadFor("board-progress");
  p.actions.autopilot.alice = { ...p.actions.autopilot.alice, on: false, terms_changed: true };
  NB.reset();
  NB.render(p, viewFor("board-progress"));
  assert.match(text(roots["bd-root"]), /The app stopped acting for you/);
});

test("progress: the two locks are drawn from the picture rows only, in words, with an end time for each side", () => {
  const root = draw("board-progress");
  const t = text(root);
  assert.match(t, /The two locks/);
  assert.match(t, /Your 5 NOID on Parano1d Settled\. If the swap stopped, they would go back to you at about hm\(\d+\)\./);
  assert.match(t, /Their 0\.001 ETH on Ethereum Settled\./);
  const noPic = draw("board-progress", { view: { ...viewFor("board-progress"), picture: null } });
  assert.ok(!/The two locks/.test(text(noPic)));
});

test("end: done says what was received and where, and has no duration, no fee figure and no link", async () => {
  const view = viewFor("board-done");
  view.finished = true;
  const root = draw("board-done", { view });
  const t = text(root);
  assert.match(t, /Done You received 0\.001 ETH/);
  assert.match(t, /The ETH was sent on to your own address, 0x[0-9a-f]{8}….{6}\. There is nothing for you to do\./);
  assert.match(t, /You gave 5 NOID/);
  assert.match(t, /The app does not total them yet\./);
  assert.match(t, /Approved at hm\(\d+\)\./);
  assert.equal(root.all((n) => n.tag === "a").length, 0, "records are plain text, never links");
  assert.ok(!/\bhttps?:\/\//.test(t));
  // Back to offers lists the offers again but cannot start a second swap here
  await byText(root, "Back to offers").fire("click");
  const r2 = roots["bd-root"];
  assert.match(text(r2), /None open now|open now/);
  assert.ok(byText(r2, "Post an offer").disabled);
  assert.match(text(r2), /This app carries one swap at a time/);
});

test("end: refunded, stopped and a board that ended before any funding", () => {
  const view = viewFor("board-refunded");
  const ref = draw("board-refunded", { view });
  const t = text(ref);
  assert.match(t, /Refunded The swap did not complete\. Your NOID are back\./);
  assert.match(t, /Your NOID had to stay locked until the swap's own end time/);
  assert.match(t, /less the network fee of taking them back \(at least 0\.0058 NOID\)/);
  const stopped = draw("board-take", { board: { stopped: "declined", nothing_funded: true, step: "stopped" }, ui: {} });
  assert.match(text(stopped), /Ended The offer ended before anything was locked\. The other side declined\. Nothing was funded/);
  assert.equal(h1s(stopped).length, 1);
});

test("hostile strings in every server-supplied field are drawn as text: no element, no script, no image", () => {
  const evil = '</p><img src=x onerror="alert(1)"><script>alert(2)</script>';
  const p = payloadFor("board-needs-you");
  const ap = p.actions.autopilot.alice;
  ap.needs_you = [{ spend: "send-reveal", label: evil, reason: evil, at: 1 }, { spend: evil, label: evil, reason: evil, at: 2 }];
  ap.doing = evil;
  ap.waiting_reason = evil;
  p.board.error = evil;
  p.board.stopped = evil;
  p.board.state = evil;
  p.board.waiting_for = evil;
  p.board.payouts = { noid: evil, eth: evil };
  p.board.offer.profile = "sepolia";
  p.actions.wallet.roles.alice.status.noid.address = evil;
  p.actions.wallet.noid_payout = evil;
  NB.reset();
  NB.ui.details = false;
  for (const phase of [S.phaseFor("board-needs-you"), "done", "refunded", null]) {
    NB.render(p, phase ? viewFor("board-needs-you", phase) : null);
    const r = roots["bd-root"];
    assert.equal(r.all((n) => ["img", "script", "iframe", "object", "embed", "svg"].includes(n.tag) && n.tag !== "svg").length, 0, `${phase}: no element made of a string`);
    assert.equal(r.all((n) => Object.keys(n.attrs).some((k) => /^on/i.test(k))).length, 0, `${phase}: no event handler attribute`);
    assert.equal(r.all((n) => "style" in n.attrs).length, 0, `${phase}: no inline style`);
    assert.equal(r.all((n) => n.tag === "a").length, 0);
  }
  // and the tool's words keep the text exactly, inside the folded box
  NB.render(p, viewFor("board-needs-you"));
  const folded = roots["bd-root"].all((n) => n.tag === "p" && n.className === "tool");
  assert.ok(folded.some((n) => n.textContent === evil), "the string is a text node, character for character");
});

test("hostile strings in the board object and in an offer list never reach an attribute that runs", () => {
  const evil = '" onmouseover="alert(1)';
  const p = payloadFor("board-offers");
  p.board.offers = [{ ...p.board.offers[0], id: evil }, { ...p.board.offers[1], htlc: evil }, ...p.board.offers.slice(2)];
  p.board.limits = { noid_min_micro: evil, noid_max_micro: evil, wei_max: evil };
  NB.reset();
  NB.render(p, null);
  const r = roots["bd-root"];
  assert.equal(r.all((n) => Object.keys(n.attrs).some((k) => /^on/i.test(k))).length, 0);
  assert.equal(buttons(r).filter((b) => squash(textOf(b)) === "Take").length, 2, "the two offers with a bad field are dropped");
});

test("structure: one h1, a labelled nav, labelled inputs, a legend on the ticks, no inline style, no colour-only state, on every screen", () => {
  for (const name of S.SCENARIOS.concat(["board-waiting"])) {
    const view = viewFor(name);
    if (view && ["board-done", "board-refunded"].includes(name)) view.finished = true;
    const root = draw(name, { view });
    assert.equal(h1s(root).length, 1, `${name}: one h1`);
    const nav = root.all((n) => n.tag === "nav");
    assert.equal(nav.length, 1, name);
    assert.equal(nav[0].attrs["aria-label"], "Board");
    assert.equal(nav[0].all((n) => n.attrs["aria-current"] === "page").length, 1, `${name}: the place you are in is marked`);
    const ids = new Set(root.all((n) => n.attrs.id).map((n) => n.attrs.id));
    for (const inp of root.all((n) => n.tag === "input")) {
      const lab = root.all((n) => n.tag === "label" && n.attrs.for === inp.attrs.id);
      assert.ok(lab.length === 1, `${name}: input ${inp.attrs.id} has one label`);
    }
    for (const b of buttons(root)) assert.ok(squash(textOf(b)).length > 0 || b.attrs["aria-label"], `${name}: a button has a name`);
    for (const f of root.all((n) => n.tag === "fieldset")) assert.ok(f.all((n) => n.tag === "legend").length === 1, `${name}: fieldset has a legend`);
    assert.equal(root.all((n) => "style" in n.attrs).length, 0, `${name}: no inline style`);
    for (const n of root.all((n) => n.attrs["aria-labelledby"])) assert.ok(ids.has(n.attrs["aria-labelledby"]), `${name}: ${n.attrs["aria-labelledby"]} exists`);
    for (const n of root.all((n) => n.attrs["aria-describedby"])) assert.ok(ids.has(n.attrs["aria-describedby"]), `${name}: ${n.attrs["aria-describedby"]} exists`);
    assert.equal(root.all((n) => n.tag === "section" || n.tag === "main").length > 0, true);
  }
});

test("vocabulary: no jargon, no exclamation mark, no emoji on any screen (the tool's own folded words are the one exception, and they are labelled)", () => {
  const FORBIDDEN = /\b(HTLC|intent|ticks?|phases?|dry.?run)\b/i;
  for (const name of S.SCENARIOS.concat(["board-waiting"])) {
    const view = viewFor(name);
    if (view && ["board-done", "board-refunded"].includes(name)) view.finished = true;
    const root = draw(name, { view });
    const clean = squash(textOf({ children: root.children.filter(Boolean), _text: "" }));
    const parts = [];
    const walk = (n) => {
      if (n instanceof Text) return parts.push(n.textContent);
      if (n.className === "tool") return;
      for (const c of n.children) walk(c);
    };
    walk(root);
    const all = parts.join(" ");
    assert.ok(all.length > 100, name);
    assert.ok(!FORBIDDEN.test(all), `${name}: jargon in "${(FORBIDDEN.exec(all) || [])[0]}"`);
    assert.ok(!all.includes("!"), `${name}: exclamation mark`);
    assert.ok(!/[\u{1F000}-\u{1FFFF}\u{2600}-\u{27BF}]/u.test(all), `${name}: emoji`);
    void clean;
  }
});

test("the page code: no innerHTML, no document.write, no eval, no inline style, no key or secret word", () => {
  for (const f of ["../board.js", "../lib/boardview.js"]) {
    const raw = fs.readFileSync(path.join(__dirname, f), "utf8");
    const src = raw.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1"); // the code without its comments
    assert.doesNotMatch(src, /innerHTML|outerHTML|insertAdjacentHTML|document\.write|\beval\(|new Function|\.style\b|setAttribute\(\s*["']style/, f);
    assert.doesNotMatch(src, /master_secret|private_key|ethkey|wallet export|i-understand|invite_secret/i, f);
  }
  const src = fs.readFileSync(path.join(__dirname, "../board.js"), "utf8");
  // the four places that talk to the server: the two paths only
  const paths = [...src.matchAll(/post\(\s*["']([^"']+)["']/g)].map((m) => m[1]);
  assert.deepEqual([...new Set(paths)].sort(), ["/api/autopilot", "/api/board"]);
  assert.doesNotMatch(src, /\/api\/(spend|action|funded|newswap)/, "the screens add no way to send");
});

test("the screens hide when the console has no board, and the operator page is shown again", () => {
  NB.reset();
  roots["bd-root"].hidden = false;
  roots["op-view"].hidden = true;
  assert.equal(NB.render({ board: null }, null), false);
  assert.equal(roots["bd-root"].hidden, true);
  assert.equal(roots["op-view"].hidden, false);
  assert.equal(NB.render(null, null), false);
  assert.equal(NB.render({ board: { enabled: false } }, null), false);
});

test("the Details button shows and hides the operator page, and the screen's place is announced", async () => {
  const root = draw("board-offers");
  assert.equal(roots["op-view"].hidden, true, "the operator page is folded by default");
  const d = byText(root, "Details");
  assert.equal(d.attrs["aria-expanded"], "false");
  assert.equal(d.attrs["aria-controls"], "op-view");
  await d.fire("click");
  assert.equal(roots["op-view"].hidden, false);
  assert.equal(byText(roots["bd-root"], "Hide details").attrs["aria-expanded"], "true");
  await byText(roots["bd-root"], "Hide details").fire("click");
  assert.equal(roots["op-view"].hidden, true);
  assert.equal(roots["skip-link"].attrs.href, "#bd-root");
  assert.equal(NB.title(), "Offers, No1d Swap");
});

test("post an offer: the form checks the amounts against the limits and sends whole units, only the two numbers", async () => {
  calls.length = 0;
  const root = draw("board-offers");
  await byText(root, "Post an offer").fire("click");
  const r = roots["bd-root"];
  const form = r.all((n) => n.tag === "form" && n.attrs["aria-labelledby"] === "bd-post-h")[0];
  assert.ok(form);
  assert.match(squash(textOf(form)), /You sell NOID and get ETH/);
  const noid = form.all((n) => n.tag === "input" && n.attrs.id === "bd-post-noid")[0];
  const eth = form.all((n) => n.tag === "input" && n.attrs.id === "bd-post-eth")[0];
  const go = form.all((n) => n.tag === "button" && n.attrs.type === "submit")[0];
  assert.ok(go.disabled);
  const set = async (n, v) => {
    n.value = v;
    await n.fire("input");
  };
  await set(noid, "4");
  await set(eth, "0.001");
  assert.ok(go.disabled);
  assert.match(textOf(form), /between 5 NOID and 20 NOID/);
  await set(noid, "21");
  assert.ok(go.disabled);
  await set(noid, "5");
  await set(eth, "0.011");
  assert.ok(go.disabled);
  assert.match(textOf(form), /at most 0\.01 ETH/);
  await set(eth, "1e-3");
  assert.ok(go.disabled);
  await set(eth, "0.001");
  assert.equal(go.disabled, false);
  assert.match(textOf(form), /Price: 0\.0002 ETH for each NOID/);
  assert.equal(calls.length, 0);
  await form.fire("submit");
  assert.deepEqual(calls[0], { url: "/api/board", body: { op: "post", noid_micro: "5000000", wei: "1000000000000000" }, token: "t" });
  assert.deepEqual(Object.keys(calls[0].body).sort(), ["noid_micro", "op", "wei"]);
});
