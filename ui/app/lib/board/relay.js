"use strict";
/*
 * The relay client: several relays at once, publish with the relay's `OK` answer, subscriptions that are sent again after a reconnect, dedupe, a
 * reconnect with growing waits, the relay's own limits (NIP-11), the URL rules of amendment H and a size cap on every incoming frame.
 *
 * Trust: a relay is not trusted with anything. Every incoming note is checked in full (id and signature, lib/board/note.js) and must match one of OUR
 * subscription filters, so a relay that sends other notes, forged notes, or notes of a subscription we never made gets nothing through. A relay can
 * still drop, delay, repeat or re-serve old (but genuine) notes: the layers above deal with that (expiry, seq, the handover state machine).
 *
 * The WebSocket class is a parameter (default: Node's built-in global `WebSocket`, which needs Node 22). Tests give it a fake. Nothing connects until
 * start() is called, and nothing here reads a file or the environment.
 *
 * Limits of this client, stated plainly:
 *   - Node's built-in WebSocket has no frame size option: a frame is buffered whole BEFORE we see it. We refuse to parse a frame over the cap and
 *     drop that connection, but cannot stop the buffering itself.
 *   - A public host name can resolve to a private address (DNS rebinding); the URL rule looks at the name only.
 *   - NIP-42 (relay authentication) is not implemented: a relay that demands it is marked and not used for publishing.
 */

const { EventEmitter } = require("events");
const crypto = require("crypto");
const { verifyEvent, isHex64 } = require("./note");
const { difficultyOf } = require("./pow");

const DEFAULTS = Object.freeze({
  maxFrameBytes: 262144,
  maxEventBytes: 131072,
  connectTimeoutMs: 10000,
  publishTimeoutMs: 10000,
  infoTimeoutMs: 5000,
  backoff: { baseMs: 1000, maxMs: 60000, factor: 2, jitter: 0.2 },
  dedupeMax: 20000,
  maxViolations: 5,
});

// ---------------------------------------------------------------------------------------------- URL rules (amendment H)
const BLOCKED_SUFFIXES = ["localhost", "local", "internal", "lan", "home", "corp", "intranet", "private", "test", "example", "invalid", "onion", "arpa", "localdomain", "home.arpa"];
const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/**
 * A relay URL from an untrusted source (an offer). Only `wss://` with a public DNS host name; no address literal, no credentials, no query, no fragment.
 * `ws://127.0.0.1[:port]` is accepted only when the caller passes allowLocalTest (a flag in code, never something an offer can set).
 * @returns {{ok:true, url:string}|{ok:false, reason:string}}
 */
function normalizeRelayUrl(input, { allowLocalTest = false } = {}) {
  if (typeof input !== "string" || input.length === 0 || input.length > 256 || !/^[\x21-\x7e]+$/.test(input)) return { ok: false, reason: "not a plain URL" };
  let u;
  try {
    u = new URL(input);
  } catch {
    return { ok: false, reason: "not a URL" };
  }
  if (u.username || u.password) return { ok: false, reason: "credentials in the URL" };
  if (u.search || u.hash) return { ok: false, reason: "query or fragment in the URL" };
  if (u.port !== "" && !(Number(u.port) >= 1 && Number(u.port) <= 65535)) return { ok: false, reason: "bad port" };
  if (!/^\/[A-Za-z0-9._~\/-]*$/.test(u.pathname)) return { ok: false, reason: "unusual path" };
  const path = u.pathname === "/" ? "" : u.pathname.replace(/\/+$/, "");
  const host = u.hostname;
  if (u.protocol === "ws:") {
    if (allowLocalTest && host === "127.0.0.1") return { ok: true, url: `ws://127.0.0.1${u.port ? ":" + u.port : ""}${path}` };
    return { ok: false, reason: "only wss:// is accepted" };
  }
  if (u.protocol !== "wss:") return { ok: false, reason: "only wss:// is accepted" };
  if (host.length > 253 || host.startsWith("[") || host.endsWith(".")) return { ok: false, reason: "not a public host name" };
  const labels = host.split(".");
  if (labels.length < 2 || !labels.every((l) => LABEL.test(l))) return { ok: false, reason: "not a public host name" };
  const tld = labels[labels.length - 1];
  if (!(/^[a-z]{2,63}$/.test(tld) || /^xn--[a-z0-9-]{2,59}$/.test(tld))) return { ok: false, reason: "not a public host name" };
  if (BLOCKED_SUFFIXES.some((s) => host === s || host.endsWith("." + s))) return { ok: false, reason: "a name that is not public" };
  return { ok: true, url: `wss://${host}${u.port ? ":" + u.port : ""}${path}` };
}

// ---------------------------------------------------------------------------------------------- filters (NIP-01)
function matchesFilter(ev, f) {
  if (!f || typeof f !== "object") return false;
  if (f.ids && !f.ids.includes(ev.id)) return false;
  if (f.authors && !f.authors.includes(ev.pubkey)) return false;
  if (f.kinds && !f.kinds.includes(ev.kind)) return false;
  if (typeof f.since === "number" && ev.created_at < f.since) return false;
  if (typeof f.until === "number" && ev.created_at > f.until) return false;
  for (const k of Object.keys(f)) {
    if (k.length === 2 && k[0] === "#") {
      const want = f[k];
      if (!Array.isArray(want) || !ev.tags.some((t) => t[0] === k[1] && want.includes(t[1]))) return false;
    }
  }
  return true;
}
const matchesAny = (ev, filters) => filters.some((f) => matchesFilter(ev, f));

function filterProblem(filters) {
  if (!Array.isArray(filters) || filters.length < 1 || filters.length > 8) return "one to eight filters";
  for (const f of filters) {
    if (!f || typeof f !== "object" || Array.isArray(f)) return "a filter is an object";
    for (const [k, v] of Object.entries(f)) {
      if (["ids", "authors"].includes(k)) {
        if (!Array.isArray(v) || v.length < 1 || v.length > 100 || !v.every(isHex64)) return `${k} must be a short list of 64-hex values`;
      } else if (k === "kinds") {
        if (!Array.isArray(v) || v.length < 1 || v.length > 20 || !v.every((x) => Number.isInteger(x) && x >= 0 && x <= 65535)) return "kinds must be a short list of kind numbers";
      } else if (["since", "until", "limit"].includes(k)) {
        if (!Number.isSafeInteger(v) || v < 0) return `${k} must be a whole number`;
      } else if (/^#[a-zA-Z]$/.test(k)) {
        if (!Array.isArray(v) || v.length < 1 || v.length > 100 || !v.every((x) => typeof x === "string" && x.length <= 256)) return `${k} must be a short list of strings`;
      } else return `unknown filter attribute ${k.slice(0, 20)}`;
    }
  }
  return null;
}

async function defaultFetchInfo(url, timeoutMs) {
  const http = url.replace(/^wss:/, "https:").replace(/^ws:/, "http:");
  const res = await fetch(http, { headers: { Accept: "application/nostr+json" }, signal: AbortSignal.timeout(timeoutMs), redirect: "error" });
  if (!res.ok) return null;
  let text;
  if (res.body && typeof res.body.getReader === "function") {
    const reader = res.body.getReader();
    const chunks = [];
    let total = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const buf = Buffer.from(value);
        total += buf.length;
        if (total > 65536) {
          try { await reader.cancel(); } catch { /* ignore */ }
          return null;
        }
        chunks.push(buf);
      }
    } finally {
      try { reader.releaseLock(); } catch { /* ignore */ }
    }
    text = Buffer.concat(chunks, total).toString("utf8");
  } else {
    text = await res.text();
    if (Buffer.byteLength(text, "utf8") > 65536) return null;
  }
  return JSON.parse(text);
}

/** The limits of a NIP-11 document that this client acts on; anything else in it is ignored, and a wrong type is dropped. */
function readLimits(info) {
  const out = {};
  const l = info && typeof info === "object" && info.limitation && typeof info.limitation === "object" ? info.limitation : {};
  for (const k of ["max_message_length", "max_subscriptions", "max_subid_length", "max_event_tags", "max_content_length", "min_pow_difficulty", "created_at_lower_limit", "created_at_upper_limit"]) {
    if (Number.isSafeInteger(l[k]) && l[k] >= 0) out[k] = l[k];
  }
  for (const k of ["auth_required", "payment_required", "restricted_writes"]) if (l[k] === true) out[k] = true;
  return out;
}

class RelayPool extends EventEmitter {
  /**
   * @param {object} o
   * @param {string[]} o.urls relay URLs (each goes through normalizeRelayUrl; a bad one is reported and skipped)
   * @param {Function} [o.WebSocket] the WebSocket class
   * @param {(url:string)=>Promise<object|null>} [o.fetchInfo] NIP-11 reader; `null` disables it
   * @param {boolean} [o.allowLocalTest]
   */
  constructor(o) {
    super();
    this.cfg = { ...DEFAULTS, ...o, backoff: { ...DEFAULTS.backoff, ...(o.backoff || {}) } };
    this.WS = o.WebSocket || globalThis.WebSocket;
    if (typeof this.WS !== "function") throw new Error("no WebSocket available: Node 22 or newer has one built in, or pass one in");
    this.random = o.random || Math.random;
    this.fetchInfo = o.fetchInfo === null ? null : o.fetchInfo || ((u) => defaultFetchInfo(u, this.cfg.infoTimeoutMs));
    this.relays = new Map();
    this.subs = new Map();
    this.seen = new Set();
    this.stopped = true;
    this.listenerErrors = 0;
    this.rejected = [];
    for (const raw of o.urls || []) {
      const n = normalizeRelayUrl(raw, { allowLocalTest: o.allowLocalTest === true });
      if (!n.ok) this.rejected.push({ url: String(raw).slice(0, 80), reason: n.reason });
      else if (!this.relays.has(n.url)) this.relays.set(n.url, this.newRelay(n.url));
    }
  }

  /** A listener that throws never reaches the caller (the socket's handler, a timer): the error is counted and the next listener runs. */
  emit(name, ...args) {
    const list = this.rawListeners(name);
    if (!list.length) return false;
    for (const fn of list) {
      try {
        fn.apply(this, args);
      } catch {
        this.listenerErrors++;
      }
    }
    return true;
  }

  newRelay(url) {
    return { url, ws: null, state: "idle", attempts: 0, timer: null, connectTimer: null, limits: {}, infoDone: false, eose: new Set(), closedSubs: new Set(), pending: new Map(), waiters: [], violations: 0, authRequested: false, messages: 0 };
  }

  start() {
    this.stopped = false;
    for (const r of this.relays.values()) if (r.state === "idle") this.connect(r);
  }

  stop() {
    this.stopped = true;
    for (const r of this.relays.values()) {
      clearTimeout(r.timer);
      clearTimeout(r.connectTimer);
      this.failPending(r, "stopped");
      const waiting = r.waiters;
      r.waiters = [];
      for (const w of waiting) w.fail("stopped");
      this.detach(r);
      r.state = "idle";
    }
  }

  status() {
    return [...this.relays.values()].map((r) => ({ url: r.url, state: r.state, attempts: r.attempts, limits: { ...r.limits }, authRequested: r.authRequested, violations: r.violations }));
  }

  openCount() {
    return [...this.relays.values()].filter((r) => r.state === "open").length;
  }

  /** Resolves true when at least `n` relays are open, false after the timeout. */
  ready(n = 1, timeoutMs = 5000) {
    if (this.openCount() >= n) return Promise.resolve(true);
    return new Promise((resolve) => {
      const t = setTimeout(() => done(false), timeoutMs);
      const check = () => {
        if (this.openCount() >= n) done(true);
      };
      const done = (v) => {
        clearTimeout(t);
        this.off("status", check);
        resolve(v);
      };
      this.on("status", check);
    });
  }

  // ---- connection
  detach(r) {
    const ws = r.ws;
    r.ws = null;
    if (ws) {
      ws.onopen = ws.onmessage = ws.onclose = ws.onerror = null;
      try {
        ws.close();
      } catch {
        /* already closed */
      }
    }
  }

  connect(r) {
    if (this.stopped) return;
    r.state = "connecting";
    r.eose.clear();
    r.closedSubs.clear();
    let ws;
    try {
      ws = new this.WS(r.url);
    } catch {
      this.scheduleReconnect(r, "could not start");
      return;
    }
    r.ws = ws;
    r.connectTimer = setTimeout(() => this.lost(r, "connect timeout"), this.cfg.connectTimeoutMs);
    r.connectTimer.unref?.();
    ws.onopen = () => {
      if (r.ws !== ws) return;
      clearTimeout(r.connectTimer);
      r.state = "open";
      this.emit("status", { url: r.url, state: "open" });
      if (this.fetchInfo && !r.infoDone) this.readInfo(r).catch(() => {});
      else r.infoDone = true;
      for (const s of this.subs.values()) this.sendReq(r, s);
      this.flushWaiters(r, true);
    };
    ws.onmessage = (m) => {
      // in Node's WebSocket an exception in a handler ends the process: whatever a listener or a frame raises is counted and dropped here
      try {
        if (r.ws === ws) this.onFrame(r, m && m.data);
      } catch {
        this.listenerErrors++;
      }
    };
    ws.onerror = () => {};
    ws.onclose = () => {
      if (r.ws === ws) this.lost(r, "closed");
    };
  }

  async readInfo(r) {
    try {
      const info = await this.fetchInfo(r.url);
      r.limits = readLimits(info);
    } catch {
      r.limits = {};
    }
    r.infoDone = true;
    if (r.limits.auth_required || r.limits.payment_required) this.emit("status", { url: r.url, state: "restricted", limits: { ...r.limits } });
    this.flushWaiters(r, r.state === "open");
  }

  lost(r, why) {
    clearTimeout(r.connectTimer);
    this.detach(r);
    this.failPending(r, "connection lost");
    if (this.stopped) {
      r.state = "idle";
      return;
    }
    this.scheduleReconnect(r, why);
  }

  scheduleReconnect(r, why) {
    const b = this.cfg.backoff;
    const base = Math.min(b.maxMs, b.baseMs * b.factor ** Math.min(r.attempts, 20));
    const wait = Math.max(0, Math.round(base * (1 + b.jitter * (2 * this.random() - 1))));
    r.attempts++;
    r.state = "backoff";
    this.emit("status", { url: r.url, state: "backoff", why, waitMs: wait });
    clearTimeout(r.timer);
    r.timer = setTimeout(() => this.connect(r), wait);
    r.timer.unref?.();
  }

  failPending(r, reason) {
    for (const [id, p] of r.pending) {
      clearTimeout(p.timer);
      p.resolve({ url: r.url, accepted: false, message: reason });
      r.pending.delete(id);
    }
  }

  // ---- incoming
  violation(r, why) {
    r.violations++;
    this.emit("status", { url: r.url, state: "violation", why });
    if (r.violations >= this.cfg.maxViolations) this.lost(r, "too many bad frames");
  }

  onFrame(r, data) {
    if (typeof data !== "string") return this.violation(r, "a frame that is not text");
    if (Buffer.byteLength(data, "utf8") > this.cfg.maxFrameBytes) {
      this.violation(r, "a frame over the size cap");
      return this.lost(r, "oversize frame");
    }
    let msg;
    try {
      msg = JSON.parse(data);
    } catch {
      return this.violation(r, "a frame that is not JSON");
    }
    if (!Array.isArray(msg) || typeof msg[0] !== "string") return this.violation(r, "a frame that is not a message");
    r.messages++;
    r.attempts = 0; // a relay that talks sensibly is forgiven earlier failures
    switch (msg[0]) {
      case "EVENT":
        return this.onEvent(r, msg[1], msg[2]);
      case "OK": {
        const p = typeof msg[1] === "string" ? r.pending.get(msg[1]) : null;
        if (!p || typeof msg[2] !== "boolean") return undefined;
        clearTimeout(p.timer);
        r.pending.delete(msg[1]);
        const text = typeof msg[3] === "string" ? msg[3].slice(0, 200) : "";
        // "duplicate:" means the relay already holds the note: the aim of publishing is met
        p.resolve({ url: r.url, accepted: msg[2] || text.startsWith("duplicate:"), message: text });
        return undefined;
      }
      case "EOSE":
        if (typeof msg[1] === "string" && this.subs.has(msg[1])) {
          r.eose.add(msg[1]);
          this.emit("eose", r.url, msg[1]);
        }
        return undefined;
      case "CLOSED":
        if (typeof msg[1] === "string") {
          r.closedSubs.add(msg[1]);
          if (typeof msg[2] === "string" && /^(auth-required|restricted)/.test(msg[2])) r.authRequested = true;
          this.emit("status", { url: r.url, state: "sub-closed", sub: msg[1], message: typeof msg[2] === "string" ? msg[2].slice(0, 200) : "" });
        }
        return undefined;
      case "NOTICE":
        this.emit("notice", r.url, typeof msg[1] === "string" ? msg[1].slice(0, 200) : "");
        return undefined;
      case "AUTH":
        r.authRequested = true;
        this.emit("status", { url: r.url, state: "auth-requested" });
        return undefined;
      default:
        return undefined;
    }
  }

  onEvent(r, subId, ev) {
    const sub = typeof subId === "string" ? this.subs.get(subId) : null;
    if (!sub) return; // for a subscription we never made (or closed)
    if (ev && typeof ev.id === "string" && this.seen.has(ev.id)) return;
    if (!verifyEvent(ev)) return this.violation(r, "a note whose id or signature is not valid");
    if (JSON.stringify(ev).length > this.cfg.maxEventBytes) return;
    if (!matchesAny(ev, sub.filters)) return this.violation(r, "a note that does not match the subscription");
    this.seen.add(ev.id);
    if (this.seen.size > this.cfg.dedupeMax) this.seen.delete(this.seen.values().next().value);
    this.emit("event", ev, r.url, subId);
  }

  // ---- subscriptions
  sendReq(r, s) {
    if (r.state !== "open" || !r.ws) return;
    const idMax = r.limits.max_subid_length || 64;
    if (s.id.length > idMax) return;
    if (r.limits.max_subscriptions !== undefined && this.subs.size > r.limits.max_subscriptions) return;
    try {
      r.ws.send(JSON.stringify(["REQ", s.id, ...s.filters]));
    } catch {
      /* the close handler reconnects */
    }
  }

  /**
   * A subscription that survives reconnects (the REQ is sent again each time a relay opens). Returns { id, close }.
   * Delivered notes arrive on the pool's "event" (ev, relayUrl, subId).
   */
  subscribe(filters, { id } = {}) {
    const why = filterProblem(filters);
    if (why) throw new Error("filter: " + why);
    const subId = id || crypto.randomBytes(8).toString("hex");
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(subId)) throw new Error("subscription id: 1 to 64 plain characters");
    if (this.subs.has(subId)) throw new Error("subscription id already in use");
    const sub = { id: subId, filters: JSON.parse(JSON.stringify(filters)) };
    this.subs.set(subId, sub);
    for (const r of this.relays.values()) this.sendReq(r, sub);
    return {
      id: subId,
      close: () => {
        if (!this.subs.delete(subId)) return;
        for (const r of this.relays.values()) {
          r.eose.delete(subId);
          if (r.state === "open" && r.ws) {
            try {
              r.ws.send(JSON.stringify(["CLOSE", subId]));
            } catch {
              /* ignore */
            }
          }
        }
      },
    };
  }

  // ---- publishing
  /** Runs the publishes that were waiting for this relay to open (and for its limits to be read). The others stay until their own timeout. */
  flushWaiters(r, open) {
    if (!open || !(r.infoDone || !this.fetchInfo)) return;
    const list = r.waiters;
    r.waiters = [];
    for (const w of list) w.go();
  }

  /**
   * Sends a note to every relay (or the given subset) and waits for each relay's OK, or the timeout.
   * @returns {Promise<{accepted:number, results:{url:string, accepted:boolean, message:string}[]}>}
   */
  publish(ev, { timeoutMs = this.cfg.publishTimeoutMs, urls } = {}) {
    if (!verifyEvent(ev)) return Promise.reject(new Error("publish: the note is not valid"));
    const frame = JSON.stringify(["EVENT", ev]);
    const targets = [...this.relays.values()].filter((r) => !urls || urls.includes(r.url));
    return Promise.all(targets.map((r) => this.publishTo(r, ev, frame, timeoutMs))).then((results) => ({ accepted: results.filter((x) => x.accepted).length, results }));
  }

  publishTo(r, ev, frame, timeoutMs) {
    return new Promise((resolve) => {
      let settled = false;
      const finish = (res) => {
        if (settled) return;
        settled = true;
        clearTimeout(overall);
        resolve({ url: r.url, accepted: res.accepted, message: res.message });
      };
      const overall = setTimeout(() => {
        r.pending.delete(ev.id);
        r.waiters = r.waiters.filter((w) => w !== waiter);
        finish({ accepted: false, message: "timeout" });
      }, timeoutMs);
      overall.unref?.();
      const waiter = {
        fail: (m) => finish({ accepted: false, message: m }),
        go: () => {
          const L = r.limits;
          if (L.auth_required || L.payment_required || L.restricted_writes) return finish({ accepted: false, message: "the relay needs authentication or payment" });
          if (Buffer.byteLength(frame) > Math.min(this.cfg.maxFrameBytes, L.max_message_length ?? Infinity)) return finish({ accepted: false, message: "larger than the relay accepts" });
          if (L.min_pow_difficulty > 0 && difficultyOf(ev) < L.min_pow_difficulty) return finish({ accepted: false, message: "below the relay's proof of work" });
          if (r.ws === null || r.state !== "open") {
            r.waiters.push(waiter);
            return undefined;
          }
          r.pending.set(ev.id, { resolve: finish, timer: null });
          try {
            r.ws.send(frame);
          } catch {
            r.pending.delete(ev.id);
            finish({ accepted: false, message: "send failed" });
          }
          return undefined;
        },
      };
      if (r.state === "open" && (r.infoDone || !this.fetchInfo)) waiter.go();
      else r.waiters.push(waiter);
    });
  }
}

module.exports = { RelayPool, normalizeRelayUrl, matchesFilter, matchesAny, filterProblem, readLimits, DEFAULTS };
