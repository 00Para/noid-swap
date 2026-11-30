"use strict";
// The autopilot box of the page, without a browser: what it needs from the payload, and that the box is built for each state with the controls the design asks for
// (a labelled input and ticks, a Turn on button that waits for them, Turn off, and a Needs you box with a button per stopped step). A tiny stand-in for the DOM.
const test = require("node:test");
const assert = require("node:assert/strict");

global.window = global.window || {};
// the pieces of the DOM the box touches
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
  }
  setAttribute(k, v) {
    this.attrs[k] = v;
    if (k === "disabled") this.disabled = true;
    if (k === "checked") this.checked = true;
    if (k === "value") this.value = v;
  }
  appendChild(c) {
    this.children.push(c);
    return c;
  }
  addEventListener(t, f) {
    (this.listeners[t] = this.listeners[t] || []).push(f);
  }
  set textContent(v) {
    this._text = String(v);
  }
  get textContent() {
    return this._text + this.children.map((c) => (c.textContent !== undefined ? c.textContent : "")).join("");
  }
  fire(t) {
    for (const f of this.listeners[t] || []) f();
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
global.document = { createElement: (t) => new Node(t), createTextNode: (t) => new Text(t), getElementById: () => null };
function el(tag, attrs, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k === "class") e.className = v;
    else if (k === "text") e.textContent = v;
    else if (k.startsWith("on") && typeof v === "function") e.addEventListener(k.slice(2), v);
    else if (k === "dataset") Object.assign(e.dataset || (e.dataset = {}), v);
    else e.setAttribute(k, v === true ? "" : String(v));
  }
  for (const c of kids.flat()) {
    if (c === null || c === undefined || c === false) continue;
    e.appendChild(typeof c === "string" || typeof c === "number" ? document.createTextNode(String(c)) : c);
  }
  return e;
}

require("../actions.js");
const NA = global.window.NoidActions;
const state = { token: "t", payload: null };
NA.init({ el, chip: (kind, text) => el("span", { class: "chip " + kind, text }), copyButton: () => el("span"), short: String, clock: (u) => "12:00:00", dayClock: String, nowS: () => 0, state, reload: async () => {}, rerender: () => {} });

const STMT = [{ id: "stay_on", text: "This computer stays on and awake until the swap is over." }, { id: "no_manual_steps", text: "No step of this swap is sent by hand outside this console while the autopilot is on." }];
const AP = (o = {}) => ({ available: true, on: false, approved_at: null, terms_changed: false, doing: null, waiting_reason: null, needs_you: [], funding_statements_valid_until: null, expected_typed: "0.001 ETH", statements: STMT, funding_offered: null, ...o });
const payload = (alice, bob, extra = {}) => ({ actions: { enabled: true, production: null, autopilot: { alice, bob }, ...extra } });
const bobView = (o = {}) => ({ role: "bob", phase: { id: "funding_final", terminal: false }, ...o });
const texts = (n) => n.textContent;
const buttons = (box) => box.all((x) => x.tag === "button");

test("facts: only in the actions mode, not on production, not for a role of another machine, not for a finished swap that was never switched on", () => {
  assert.equal(NA.autopilotFacts(bobView(), { actions: { enabled: false } }), null);
  assert.equal(NA.autopilotFacts(bobView(), null), null);
  assert.equal(NA.autopilotFacts(bobView(), payload(AP(), AP(), { production: { text: "prod" } })), null);
  assert.equal(NA.autopilotFacts(bobView(), payload(AP(), AP({ available: false }))), null);
  assert.equal(NA.autopilotFacts(bobView({ phase: { id: "done", terminal: true } }), payload(AP(), AP())), null);
  // but a finished swap that still has something for the person, or is on, shows it
  assert.ok(NA.autopilotFacts(bobView({ phase: { id: "done", terminal: true } }), payload(AP(), AP({ needs_you: [{ spend: "send-claim", reason: "x" }] }))));
  assert.ok(NA.autopilotFacts(bobView({ phase: { id: "done", terminal: true } }), payload(AP(), AP({ on: true }))));
  const f = NA.autopilotFacts(bobView(), payload(AP(), AP()));
  assert.equal(f.role, "bob");
  assert.equal(f.can_turn_on, true);
  // Alice can approve only while the engine offers her funding
  assert.equal(NA.autopilotFacts({ role: "alice", phase: { id: "created" } }, payload(AP({ funding_offered: false }), AP())).can_turn_on, false);
  assert.equal(NA.autopilotFacts({ role: "alice", phase: { id: "created" } }, payload(AP({ funding_offered: true }), AP())).can_turn_on, true);
});

test("the typed amount is compared as a number, like the server does", () => {
  assert.equal(NA.typedOk("0.001 ETH", "0.001 ETH"), true);
  assert.equal(NA.typedOk(" 0.0010 eth ", "0.001 ETH"), true);
  assert.equal(NA.typedOk("0.01 ETH", "0.001 ETH"), false);
  assert.equal(NA.typedOk("0.001 NOID", "0.001 ETH"), false);
  assert.equal(NA.typedOk("0.001", "0.001 ETH"), false);
  assert.equal(NA.typedOk("10 NOID", null), false);
});

test("off: a labelled amount input, one tick per statement, and a Turn on button that waits for all of them", () => {
  state.payload = payload(AP(), AP());
  const box = NA.autopilotBlock(bobView(), state.payload);
  assert.equal(box.attrs["aria-label"], "Run this swap for me");
  assert.match(texts(box), /Run this swap for me/);
  assert.match(texts(box), /same dry run and the same checks/);
  const input = box.all((x) => x.tag === "input" && x.attrs.type === "text")[0];
  assert.equal(input.attrs.id, "ap-typed");
  assert.ok(box.all((x) => x.tag === "label" && x.attrs.for === "ap-typed").length === 1, "the input has its label");
  const ticks = box.all((x) => x.tag === "input" && x.attrs.type === "checkbox");
  assert.deepEqual(ticks.map((t) => t.attrs.id), ["ap-stmt-stay_on", "ap-stmt-no_manual_steps"]);
  for (const t of ticks) assert.ok(box.all((x) => x.tag === "label" && x.attrs.for === t.attrs.id).length === 1, "each tick has its label");
  const go = buttons(box).find((b) => /Turn on/.test(b.textContent));
  assert.equal(go.disabled, true, "nothing typed, nothing ticked");
  input.value = "0.001 ETH";
  input.fire("input");
  assert.equal(go.disabled, true, "the ticks are missing");
  for (const t of ticks) {
    t.checked = true;
    t.fire("change");
  }
  assert.equal(go.disabled, false);
  input.value = "0.002 ETH";
  input.fire("input");
  assert.equal(go.disabled, true, "a wrong amount");
  // the form survives a redraw
  const again = NA.autopilotBlock(bobView(), state.payload);
  assert.equal(again.all((x) => x.tag === "input" && x.attrs.type === "text")[0].value, "0.002 ETH");
  assert.equal(again.all((x) => x.tag === "input" && x.attrs.type === "checkbox").every((c) => c.checked), true);
  input.value = "";
  input.fire("input");
  for (const t of ticks) {
    t.checked = false;
    t.fire("change");
  }
});

test("off for Alice: the button stays off until the engine offers the funding, and she is told why", () => {
  const four = [...STMT, { id: "no_pending_funding", text: "No funding of this contract is pending." }, { id: "bob_check_matches", text: "Bob's check line matches mine." }];
  state.payload = payload(AP({ expected_typed: "10 NOID", statements: four, funding_offered: false }), AP());
  const box = NA.autopilotBlock({ role: "alice", phase: { id: "created", terminal: false } }, state.payload);
  assert.match(texts(box), /does not offer your funding yet/);
  assert.equal(box.all((x) => x.tag === "input" && x.attrs.type === "checkbox").length, 4);
  const input = box.all((x) => x.tag === "input" && x.attrs.type === "text")[0];
  input.value = "10 NOID";
  input.fire("input");
  for (const t of box.all((x) => x.tag === "input" && x.attrs.type === "checkbox")) {
    t.checked = true;
    t.fire("change");
  }
  assert.equal(buttons(box).find((b) => /Turn on/.test(b.textContent)).disabled, true);
  input.value = "";
  input.fire("input");
  for (const t of box.all((x) => x.tag === "input" && x.attrs.type === "checkbox")) {
    t.checked = false;
    t.fire("change");
  }
});

test("on: one line of what it does or waits for, a Turn off button, and a loud Needs you box with a button per stopped step", () => {
  state.payload = payload(AP(), AP({ on: true, approved_at: 1800000000, doing: "waiting: Lock the ETH", waiting_reason: "The last tick file is 130 s old.", needs_you: [{ spend: "send-claim", label: "Submit the NOID claim", reason: "it may have been sent", retrying: true }, { spend: "send-lock", label: "Lock the ETH", reason: "the engine raised an ALARM" }] }));
  const box = NA.autopilotBlock(bobView(), state.payload);
  assert.match(texts(box), /waiting: Lock the ETH/);
  assert.match(texts(box), /Waiting for: The last tick file is 130 s old\./);
  assert.ok(box.all((x) => x.tag === "input" && x.attrs.type === "text").length === 0, "no approval form while it is on");
  assert.ok(buttons(box).some((b) => b.textContent === "Turn off"));
  const alarm = box.all((x) => /alarm danger/.test(x.className))[0];
  assert.equal(alarm.attrs.role, "alert");
  assert.match(texts(alarm), /needs you/);
  assert.match(texts(alarm), /Submit the NOID claim/);
  assert.match(texts(alarm), /still trying this step/);
  assert.equal(buttons(alarm).filter((b) => b.textContent === "I have dealt with it").length, 2, "one per stopped step");
});

test("terms changed: it says the autopilot is off and why, and the approval form is back", () => {
  state.payload = payload(AP(), AP({ terms_changed: true }));
  const box = NA.autopilotBlock(bobView(), state.payload);
  assert.match(texts(box), /The terms changed since you approved/);
  assert.ok(box.all((x) => x.tag === "input" && x.attrs.type === "text").length === 1);
});

test("without the key every control is disabled", () => {
  state.token = "";
  try {
    state.payload = payload(AP(), AP({ on: true, needs_you: [{ spend: "send-lock", label: "Lock the ETH", reason: "x" }] }));
    const box = NA.autopilotBlock(bobView(), state.payload);
    assert.ok(buttons(box).every((b) => b.disabled));
  } finally {
    state.token = "t";
  }
});

test("the signature changes with what is drawn and not with the clocks", () => {
  const base = { enabled: true, autopilot: { alice: AP(), bob: AP() } };
  const sig = NA.signature(base);
  assert.equal(NA.signature({ ...base, autopilot: { alice: AP(), bob: AP({ approved_at: 5 }) } }), sig, "the approval time is not drawn while it is off");
  assert.notEqual(NA.signature({ ...base, autopilot: { alice: AP(), bob: AP({ on: true }) } }), sig);
  assert.notEqual(NA.signature({ ...base, autopilot: { alice: AP(), bob: AP({ needs_you: [{ spend: "send-lock", reason: "x" }] }) } }), sig);
  const on = (doing) => NA.signature({ ...base, autopilot: { alice: AP(), bob: AP({ on: true, doing }) } });
  assert.notEqual(on("a"), on("b"), "what it is doing is drawn while it is on");
});
