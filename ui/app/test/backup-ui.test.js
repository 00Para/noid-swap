"use strict";
/* P6 UI tests: backup status rendering on stage card, restore screen + S6 node overrides, menu & guide entry, and ZERO backup controls in practice mode. */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

function makeDom() {
  class FakeEl {
    constructor(tag) {
      this.tag = tag.toLowerCase();
      this.attrs = {};
      this.dataset = {};
      this.children = [];
      this.listeners = {};
      this.value = "";
      this.checked = false;
      this.disabled = false;
      this.hidden = false;
      this.open = false;
      this._text = "";
    }
    set className(v) {
      this.attrs.class = v;
    }
    get className() {
      return this.attrs.class || "";
    }
    set id(v) {
      this.attrs.id = v;
    }
    get id() {
      return this.attrs.id || "";
    }
    set textContent(v) {
      this._text = String(v);
      this.children = [];
    }
    get textContent() {
      return this._text + this.children.map((c) => (typeof c === "string" ? c : c.textContent)).join("");
    }
    get firstChild() {
      return this.children[0] || null;
    }
    setAttribute(k, v) {
      this.attrs[k] = String(v);
      if (k === "checked") this.checked = true;
      if (k === "disabled") this.disabled = true;
    }
    removeAttribute(k) {
      delete this.attrs[k];
      if (k === "open") this.open = false;
    }
    appendChild(c) {
      this.children.push(c);
      return c;
    }
    removeChild(c) {
      const i = this.children.indexOf(c);
      if (i >= 0) this.children.splice(i, 1);
    }
    addEventListener(ev, fn) {
      (this.listeners[ev] = this.listeners[ev] || []).push(fn);
    }
    async click() {
      for (const fn of this.listeners.click || []) await fn({});
    }
    all(pred, acc = []) {
      if (pred(this)) acc.push(this);
      for (const c of this.children) if (c && typeof c.all === "function") c.all(pred, acc);
      return acc;
    }
  }
  const el = (tag, attrs, ...kids) => {
    const e = new FakeEl(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v === null || v === undefined || v === false) continue;
      if (k === "class") e.className = v;
      else if (k === "text") e.textContent = v;
      else if (k.startsWith("on") && typeof v === "function") e.addEventListener(k.slice(2), v);
      else if (k === "dataset") Object.assign(e.dataset, v);
      else e.setAttribute(k, v === true ? "" : String(v));
    }
    for (const c of kids.flat()) {
      if (c === null || c === undefined || c === false) continue;
      e.appendChild(typeof c === "string" || typeof c === "number" ? String(c) : c);
    }
    return e;
  };
  return { FakeEl, el };
}

function loadScript(relPath, sandbox) {
  const src = fs.readFileSync(path.join(__dirname, "..", relPath), "utf8");
  vm.runInNewContext(src, sandbox, { filename: relPath });
}

test("P6: program.js menu has Restore a swap…, first-start guide has backup button, restoreForm handles S6 node_unreachable and success", async () => {
  const { el } = makeDom();
  const requests = [];
  let nextResp = { ok: false, status: 503, json: async () => ({ ok: false, code: "node_unreachable", error: "No1d Swap cannot reach the Parano1d node (127.0.0.1)." }) };
  const sandbox = {
    window: {},
    document: { title: "" },
    fetch: async (url, init) => {
      requests.push({ url, body: init && init.body ? JSON.parse(init.body) : null });
      return nextResp;
    },
    URL,
    Date,
    Promise,
    JSON,
    BigInt,
  };
  loadScript("program.js", sandbox);
  const PG = sandbox.window.NoidProgram;
  PG.init({
    el,
    chip: (cls, text) => el("span", { class: `chip ${cls}`, text }),
    icon: () => null,
    coinGlyph: () => null,
    state: { token: "tok123", swap: null },
  });

  // 1. Top bar menu has "Restore a swap…"
  const went = [];
  const bar = PG.topBar({ network: "test", swaps: [], node: { noid: { state: "ok" }, eth: { state: "ok" } } }, { screen: "list" }, { go: (s) => went.push(s), open: () => {}, refresh: () => {} });
  const restoreBtn = bar.all((n) => n.tag === "button" && n.textContent === "Restore a swap\u2026")[0];
  assert.ok(restoreBtn, "Restore a swap… button in top bar menu");
  await restoreBtn.click();
  assert.deepEqual(went, ["restore"]);

  // 2. Empty swap list first-start guide has "I have a backup from another computer"
  const list = PG.swapList({ network: "test", swaps: [], new_swap_allowed: { ok: true }, vault: { ready: true, recovery_confirmed: true } }, { go: (s) => went.push(s), openSwap: () => {}, openProgram: () => {} });
  const guideBtn = list.all((n) => n.id === "pg-restore-guide")[0];
  assert.ok(guideBtn, "I have a backup from another computer button in first-start guide");
  assert.match(guideBtn.textContent, /I have a backup from another computer/);

  // 3. restoreForm: node_unreachable opens S6 node override fold and retries with node_overrides
  const openedSwaps = [];
  const rf = PG.restoreForm({}, { restored: (id) => openedSwaps.push(id), cancel: () => {} });
  const choose = rf.node.all((n) => n.id === "pg-restore-choose")[0];
  const fold = rf.node.all((n) => n.id === "pg-restore-nodes")[0];
  assert.equal(fold.open, false);
  await choose.click();
  assert.equal(fold.open, true, "S6: node override fold opens on node_unreachable");
  assert.match(rf.node.textContent, /cannot reach the Parano1d node/);

  // Fill S6 override and retry -> success
  const rpcInput = rf.node.all((n) => n.id === "restore-noid_rpc")[0];
  rpcInput.value = "http://127.0.0.1:19601";
  nextResp = { ok: true, status: 200, json: async () => ({ ok: true, swap: "a".repeat(32) }) };
  await choose.click();
  assert.deepEqual(requests[1], { url: "/api/backup/restore", body: { node_overrides: { noid_rpc: "http://127.0.0.1:19601" } } });
  assert.match(rf.node.textContent, /This swap now runs on this computer/);
  const openBtn = rf.node.all((n) => n.id === "pg-restore-open")[0];
  assert.ok(openBtn);
  await openBtn.click();
  assert.deepEqual(openedSwaps, ["a".repeat(32)]);
});

test("P6: stagecard.backupBlock renders all 5 backup states and renders NOTHING when program.backup is absent (practice mode)", async () => {
  const { el } = makeDom();
  const posts = [];
  const sandbox = {
    window: { NoidActions: { icon: () => null }, NoidView: {} },
    document: { createElement: (t) => el(t, {}) },
    fetch: async (url, init) => {
      posts.push({ url, body: JSON.parse(init.body) });
      return { ok: true, status: 200, json: async () => ({ ok: true, status: "saved" }) };
    },
    URL,
    Date,
    Promise,
    JSON,
    BigInt,
  };
  loadScript("program.js", sandbox);
  sandbox.window.NoidProgram.init({ el, chip: (c, t) => el("span", { text: t }), state: { token: "tok", swap: "b".repeat(32) } });
  loadScript("stagecard.js", sandbox);
  const SC = sandbox.window.NoidStage;
  SC.init({ el, chip: (c, t) => el("span", { text: t }), state: { token: "tok", swap: "b".repeat(32) }, reload: async () => {} });

  // Practice mode payload has no program.backup -> null (zero backup controls!)
  assert.equal(SC.backupBlock({ program: {} }), null);
  assert.equal(SC.backupBlock({}), null);

  // State: none
  const bNone = SC.backupBlock({ program: { backup: { state: "none", keep_updated: true } } });
  assert.match(bNone.textContent, /Save a backup of this swap/);
  assert.match(bNone.textContent, /Keep this file up to date/);
  assert.match(bNone.textContent, /Keep the code on paper/);
  const saveBtn = bNone.all((n) => n.id === "bk-save")[0];
  await saveBtn.click();
  assert.deepEqual(posts[0], { url: "/api/backup/save", body: { swap: "b".repeat(32), keep_updated: true } });

  // An unticked box posts keep_updated false
  const bNone2 = SC.backupBlock({ program: { backup: { state: "none", keep_updated: true } } });
  const cb = bNone2.all((n) => n.id === "bk-auto-refresh")[0];
  cb.checked = false;
  await bNone2.all((n) => n.id === "bk-save")[0].click();
  assert.deepEqual(posts[posts.length - 1], { url: "/api/backup/save", body: { swap: "b".repeat(32), keep_updated: false } });
  // "Save elsewhere" carries the saved choice back from the status payload (keep_updated), unticked stays unticked
  const bOut0 = SC.backupBlock({ program: { backup: { state: "out_of_date", keep_updated: false } } });
  await bOut0.all((n) => n.id === "bk-save-elsewhere")[0].click();
  assert.deepEqual(posts[posts.length - 1], { url: "/api/backup/save", body: { swap: "b".repeat(32), keep_updated: false } });
  posts.length = 1;

  // State: up_to_date
  const bUp = SC.backupBlock({ program: { backup: { state: "up_to_date", saved_at: "2026-11-25T14:03:00Z", keep_updated: true } } });
  assert.match(bUp.textContent, /Backup up to date/);

  // State: out_of_date
  const bOut = SC.backupBlock({ program: { backup: { state: "out_of_date", keep_updated: false } } });
  assert.match(bOut.textContent, /Update backup/);
  const updBtn = bOut.all((n) => n.id === "bk-update")[0];
  await updBtn.click();
  assert.deepEqual(posts[1], { url: "/api/backup/update", body: { swap: "b".repeat(32) } });

  // State: cannot_write
  const bErr = SC.backupBlock({ program: { backup: { state: "cannot_write", keep_updated: true } } });
  assert.match(bErr.textContent, /USB stick taken out/);
  assert.ok(bErr.all((n) => n.id === "bk-retry")[0]);
  assert.ok(bErr.all((n) => n.id === "bk-save-elsewhere")[0]);

  // State: not_needed
  const bDone = SC.backupBlock({ program: { backup: { state: "not_needed" } } });
  assert.match(bDone.textContent, /This swap is over\. You can delete its backup file once your coins have reached your own payout addresses/);

  // Verify practice.js itself contains zero references to /api/backup
  const practiceSrc = fs.readFileSync(path.join(__dirname, "..", "practice.js"), "utf8");
  assert.equal(/\/api\/backup|backupBlock|no1dbackup/.test(practiceSrc), false, "practice.js has zero backup controls");
});

test("F1 (rehearsal 2026-11-26): an unticked 'Keep this file up to date' stays unticked when the card is drawn again, per swap; Save posts the person's choice", async () => {
  const { el } = makeDom();
  const posts = [];
  const sandbox = {
    window: { NoidActions: { icon: () => null }, NoidView: {} },
    document: { createElement: (t) => el(t, {}) },
    fetch: async (url, init) => {
      posts.push({ url, body: JSON.parse(init.body) });
      return { ok: true, status: 200, json: async () => ({ ok: true, status: "saved" }) };
    },
    URL,
    Date,
    Promise,
    JSON,
    BigInt,
  };
  const state = { token: "tok", swap: "c".repeat(32) };
  loadScript("program.js", sandbox);
  sandbox.window.NoidProgram.init({ el, chip: (c, t) => el("span", { text: t }), state });
  loadScript("stagecard.js", sandbox);
  const SC = sandbox.window.NoidStage;
  SC.init({ el, chip: (c, t) => el("span", { text: t }), state, reload: async () => {} });
  const box = () => SC.backupBlock({ program: { backup: { state: "none", keep_updated: true } } });
  const cbOf = (b) => b.all((n) => n.id === "bk-auto-refresh")[0];
  const first = box();
  assert.equal(cbOf(first).checked, true, "ticked by default");
  const cb = cbOf(first);
  cb.checked = false;
  for (const fn of cb.listeners.change || []) await fn({});
  // the 15 s redraw builds the block again
  for (let i = 0; i < 3; i++) assert.equal(cbOf(box()).checked, false, `redraw ${i + 1}: the person's choice stays`);
  const again = box();
  await again.all((n) => n.id === "bk-save")[0].click();
  assert.deepEqual(posts[posts.length - 1], { url: "/api/backup/save", body: { swap: "c".repeat(32), keep_updated: false } });
  // ticked again by the person: stays ticked
  const cb2 = cbOf(again);
  cb2.checked = true;
  for (const fn of cb2.listeners.change || []) await fn({});
  assert.equal(cbOf(box()).checked, true);
  // another swap is not touched by this swap's choice
  cb2.checked = false;
  for (const fn of cb2.listeners.change || []) await fn({});
  state.swap = "d".repeat(32);
  assert.equal(cbOf(box()).checked, true, "another swap starts ticked");
});

test("backup save reloads card", async () => {
  const { el } = makeDom();
  const sandbox = {
    window: { NoidActions: { icon: () => null }, NoidView: {} },
    document: { createElement: (t) => el(t, {}) },
    // the server answers { ok: true, saved: true, backup } (backupmgr.js), not a "status" field
    fetch: async () => ({ ok: true, status: 200, json: async () => ({ ok: true, saved: true, backup: { state: "current" } }) }),
    URL,
    Date,
    Promise,
    JSON,
    BigInt,
  };
  const state = { token: "tok", swap: "e".repeat(32) };
  let reloads = 0;
  loadScript("program.js", sandbox);
  sandbox.window.NoidProgram.init({ el, chip: (c, t) => el("span", { text: t }), state });
  loadScript("stagecard.js", sandbox);
  const SC = sandbox.window.NoidStage;
  SC.init({ el, chip: (c, t) => el("span", { text: t }), state, reload: async () => { reloads += 1; } });
  const b = SC.backupBlock({ program: { backup: { state: "none", keep_updated: true } } });
  await b.all((n) => n.id === "bk-save")[0].click();
  assert.equal(reloads, 1, "the card is reloaded after a saved backup");
});
