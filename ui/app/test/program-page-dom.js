"use strict";
// A small stand-in for the browser, enough to load the console page as index.html loads it (the scripts in the same order, in one fresh context per call) and to read back what it
// drew as text. Not a test file (the glob is *.test.js). It has no network: `fetch` is a function the test gives it.
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const APP = path.join(__dirname, "..");

class Text {
  constructor(t) {
    this.textContent = String(t);
    this.parent = null;
  }
}

function matchOne(node, sel) {
  // one compound selector: tag, #id, .class (any number), [attr] or [attr="v"]
  const re = /^([a-zA-Z][a-zA-Z0-9]*)?((?:[#.][\w-]+|\[[\w-]+(?:="[^"]*")?\])*)$/;
  const m = re.exec(sel.trim());
  if (!m) throw new Error("unsupported selector in the test DOM: " + sel);
  if (m[1] && node.tag !== m[1].toLowerCase()) return false;
  const parts = m[2].match(/[#.][\w-]+|\[[\w-]+(?:="[^"]*")?\]/g) || [];
  for (const p of parts) {
    if (p[0] === "#") {
      if (node.attrs.id !== p.slice(1)) return false;
    } else if (p[0] === ".") {
      if (!node.className.split(/\s+/).includes(p.slice(1))) return false;
    } else {
      const a = /^\[([\w-]+)(?:="([^"]*)")?\]$/.exec(p);
      const name = a[1];
      const has = name === "open" ? node.open === true : Object.prototype.hasOwnProperty.call(node.attrs, name);
      if (!has) return false;
      if (a[2] !== undefined && String(node.attrs[name]) !== a[2]) return false;
    }
  }
  return true;
}

class Node {
  constructor(tag) {
    this.tag = String(tag).toLowerCase();
    this.tagName = this.tag.toUpperCase();
    this.attrs = {};
    this.children = [];
    this.parent = null;
    this.listeners = {};
    this.dataset = {};
    this.className = "";
    this.hidden = false;
    this.disabled = false;
    this.checked = false;
    this.open = false;
    this.value = "";
    this.clientWidth = 1000;
    this._text = "";
    this.classList = {
      add: (...c) => {
        for (const x of c) if (!this.className.split(/\s+/).includes(x)) this.className = (this.className + " " + x).trim();
      },
      remove: (...c) => {
        this.className = this.className.split(/\s+/).filter((x) => x && !c.includes(x)).join(" ");
      },
      contains: (c) => this.className.split(/\s+/).includes(c),
      toggle: (c, force) => {
        const on = force === undefined ? !this.classList.contains(c) : !!force;
        if (on) this.classList.add(c);
        else this.classList.remove(c);
      },
    };
  }
  setAttribute(k, v) {
    this.attrs[k] = String(v);
    if (k === "hidden") this.hidden = true;
    else if (k === "disabled") this.disabled = true;
    else if (k === "checked") this.checked = true;
    else if (k === "open") this.open = true;
    else if (k === "value") this.value = String(v);
    else if (k === "class") this.className = String(v);
  }
  getAttribute(k) {
    return this.attrs[k] === undefined ? null : this.attrs[k];
  }
  removeAttribute(k) {
    delete this.attrs[k];
    if (k === "open") this.open = false;
    if (k === "hidden") this.hidden = false;
    if (k === "disabled") this.disabled = false;
  }
  appendChild(c) {
    if (c.parent) c.parent.removeChild(c);
    c.parent = this;
    this.children.push(c);
    // a select's value is its selected option's (the first one when none is marked), as in a browser
    if (this.tag === "select" && c.tag === "option" && (c.attrs.selected !== undefined || this.children.length === 1)) this.value = c.attrs.value === undefined ? "" : c.attrs.value;
    return c;
  }
  append(...cs) {
    for (const c of cs) this.appendChild(typeof c === "string" ? new Text(c) : c);
  }
  removeChild(c) {
    this.children = this.children.filter((x) => x !== c);
    c.parent = null;
    return c;
  }
  remove() {
    if (this.parent) this.parent.removeChild(this);
  }
  get firstChild() {
    return this.children[0] || null;
  }
  get textContent() {
    return this._text + this.children.map((c) => c.textContent).join("");
  }
  set textContent(v) {
    for (const c of this.children) c.parent = null;
    this.children = [];
    this._text = String(v);
  }
  addEventListener(t, f) {
    (this.listeners[t] = this.listeners[t] || []).push(f);
  }
  removeEventListener(t, f) {
    this.listeners[t] = (this.listeners[t] || []).filter((x) => x !== f);
  }
  async fire(t, ev) {
    const e = { preventDefault() {}, stopPropagation() {}, currentTarget: this, target: this, ...(ev || {}) };
    for (const f of this.listeners[t] || []) await f(e);
  }
  /** What a click does: the listeners (the `onclick` attributes of the page's `el` helper are listeners too). Disabled controls do nothing, as in a browser. */
  async click() {
    if (this.disabled) return;
    await this.fire("click");
  }
  focus() {
    this.ownerDocument.activeElement = this;
  }
  select() {}
  showModal() {
    this.open = true;
  }
  close() {
    this.open = false;
  }
  contains(n) {
    for (let x = n; x; x = x.parent) if (x === this) return true;
    return false;
  }
  all(pred, out = []) {
    if (pred(this)) out.push(this);
    for (const c of this.children) if (c instanceof Node) c.all(pred, out);
    return out;
  }
  querySelectorAll(sel) {
    const sels = sel.split(",");
    return this.all((n) => n !== this && sels.some((s) => matchOne(n, s)));
  }
  querySelector(sel) {
    return this.querySelectorAll(sel)[0] || null;
  }
  closest(sel) {
    for (let x = this; x; x = x.parent) if (x instanceof Node && matchOne(x, sel)) return x;
    return null;
  }
}

/** The text of a tree, with a space between element children so a chip and a word do not run together. */
function textOf(n) {
  if (n instanceof Text) return n.textContent;
  if (!n) return "";
  return (n._text || "") + n.children.map(textOf).join(" ");
}

/** The ids and tags of index.html, as an element each (no nesting: the page only looks things up by id). */
function skeleton(doc) {
  const html = fs.readFileSync(path.join(APP, "index.html"), "utf8");
  const root = new Node("html");
  root.ownerDocument = doc;
  const body = new Node("body");
  body.ownerDocument = doc;
  root.appendChild(body);
  for (const m of html.matchAll(/<(\w+)([^>]*)\bid="([^"]+)"([^>]*)>/g)) {
    const n = new Node(m[1]);
    n.ownerDocument = doc;
    n.setAttribute("id", m[3]);
    const all = m[2] + " " + m[4];
    const cls = /class="([^"]*)"/.exec(all);
    if (cls) n.className = cls[1];
    if (/\shidden(\s|$|>)/.test(all + ">")) n.hidden = true;
    body.appendChild(n);
  }
  return { root, body };
}

/**
 * Loads the page's scripts in index.html's order into one fresh context and lets operator.js boot.
 * opts: { fetch(url, init) -> { status, body } | Promise of it, hash, search, time }.
 * Returns { window, document, calls, intervals, flush(), byId(id), text(id) }.
 */
async function loadPage(opts = {}) {
  const calls = [];
  const intervals = [];
  const doc = {
    title: "",
    hidden: false,
    activeElement: null,
    createElement: (t) => {
      const n = new Node(t);
      n.ownerDocument = doc;
      return n;
    },
    createElementNS: (ns, t) => doc.createElement(t),
    createTextNode: (t) => new Text(t),
    execCommand: () => false,
  };
  const sk = skeleton(doc);
  doc.body = sk.body;
  doc.getElementById = (id) => sk.root.all((n) => n.attrs.id === id)[0] || null;
  doc.querySelector = (s) => sk.root.querySelector(s);
  doc.querySelectorAll = (s) => sk.root.querySelectorAll(s);
  const sandbox = {
    document: doc,
    location: { hash: opts.hash === undefined ? "#token=" + "ab".repeat(16) : opts.hash, search: opts.search || "", pathname: "/" },
    history: { replaceState() {} },
    navigator: {},
    URLSearchParams,
    console,
    Date: opts.Date || Date,
    JSON,
    Math,
    Promise,
    setTimeout: () => 0,
    clearTimeout() {},
    setInterval: (f, ms) => {
      intervals.push({ f, ms });
      return intervals.length;
    },
    fetch: async (url, init = {}) => {
      calls.push({ url, method: init.method || "GET", headers: init.headers || {}, body: init.body === undefined ? null : JSON.parse(init.body) });
      const r = await opts.fetch(url, init);
      return { ok: r.status >= 200 && r.status < 300, status: r.status, json: async () => (r.body === undefined ? {} : JSON.parse(JSON.stringify(r.body))) };
    },
  };
  sandbox.window = sandbox;
  sandbox.self = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  for (const f of ["lib/phases.js", "lib/enginetext.js", "lib/viewmodel.js", "actions.js", "program.js", "lib/boardview.js", "board.js", "operator.js"]) vm.runInContext(fs.readFileSync(path.join(APP, f), "utf8"), sandbox, { filename: f });
  const flush = async (n = 30) => {
    for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r));
  };
  await flush();
  return { window: sandbox, document: doc, calls, intervals, flush, byId: (id) => doc.getElementById(id), text: (id) => textOf(doc.getElementById(id)) };
}

module.exports = { Node, Text, textOf, loadPage, APP };
