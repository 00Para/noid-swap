"use strict";
// An in-process fake of Nostr relays for the board tests. Not a test file (the glob is *.test.js). No socket, no network: `network.WebSocket` is a class
// with the browser-style surface the relay client uses (onopen, onmessage, onclose, onerror, send, close, readyState).
//
// Each relay really stores and matches notes (NIP-01 filters, addressable replacement), checks note signatures as a real relay would, answers OK and EOSE,
// and has knobs to misbehave: drop, delay, duplicate, hold and release (reorder), re-serve old notes, substitute notes, refuse, go down, cut connections.

const { verifyEvent } = require("../lib/board/note");
const { matchesAny } = require("../lib/board/relay");

const OPEN = 1;
const CLOSED = 3;

class FakeRelay {
  constructor(network, url, opts = {}) {
    this.network = network;
    this.url = url;
    this.events = new Map();
    this.conns = new Set();
    this.received = []; // every frame a client sent (parsed)
    this.down = false;
    this.delayMs = 0;
    this.info = opts.info || {};
    // knobs
    this.drop = null; // (event, kind:"deliver"|"store") => boolean : true = swallow
    this.duplicate = 0; // extra copies of every delivered event
    this.hold = false; // buffer deliveries until release()
    this.held = [];
    this.substitute = null; // (event, subId) => event|null
    this.refuse = null; // string: answer OK false with this text
    this.silentStore = false; // answer OK true but neither store nor forward
    this.silentOk = false; // do not answer EVENT at all
    this.replayOnReq = []; // old notes sent in answer to every REQ whatever it asks for
    this.flood = 0; // extra bogus frames sent after each REQ
  }

  // ---- the relay side
  accept(conn) {
    this.conns.add(conn);
  }

  frame(conn, arr) {
    this.later(() => conn.deliver(JSON.stringify(arr)));
  }

  later(fn) {
    if (this.delayMs > 0) setTimeout(fn, this.delayMs);
    else setImmediate(fn);
  }

  send(conn, subId, ev) {
    if (this.drop && this.drop(ev, "deliver")) return;
    let e = ev;
    if (this.substitute) {
      e = this.substitute(ev, subId);
      if (!e) return;
    }
    const f = ["EVENT", subId, e];
    if (this.hold) return void this.held.push([conn, f]);
    for (let i = 0; i <= this.duplicate; i++) this.frame(conn, f);
  }

  /** Delivers what was held (optionally in reverse order: a reordering relay). */
  release({ reverse = false } = {}) {
    const list = reverse ? [...this.held].reverse() : this.held;
    this.held = [];
    this.hold = false;
    for (const [conn, f] of list) this.frame(conn, f);
  }

  handle(conn, text) {
    let m;
    try {
      m = JSON.parse(text);
    } catch {
      return;
    }
    this.received.push(m);
    if (m[0] === "EVENT") return this.onPublish(conn, m[1]);
    if (m[0] === "REQ") return this.onReq(conn, m[1], m.slice(2));
    if (m[0] === "CLOSE") return void conn.subs.delete(m[1]);
    return undefined;
  }

  store(ev) {
    if (ev.kind >= 30000 && ev.kind < 40000) {
      const d = (ev.tags.find((t) => t[0] === "d") || [])[1] || "";
      for (const o of this.events.values()) {
        if (o.pubkey === ev.pubkey && o.kind === ev.kind && ((o.tags.find((t) => t[0] === "d") || [])[1] || "") === d) {
          if (o.created_at > ev.created_at || (o.created_at === ev.created_at && o.id < ev.id)) return false;
          this.events.delete(o.id);
        }
      }
    }
    this.events.set(ev.id, ev);
    return true;
  }

  onPublish(conn, ev) {
    if (this.silentOk) return;
    if (!verifyEvent(ev)) return this.frame(conn, ["OK", ev && ev.id, false, "invalid: bad signature"]);
    if (this.refuse) return this.frame(conn, ["OK", ev.id, false, this.refuse]);
    if (this.silentStore || (this.drop && this.drop(ev, "store"))) return this.frame(conn, ["OK", ev.id, true, ""]);
    if (this.events.has(ev.id)) return this.frame(conn, ["OK", ev.id, true, "duplicate: already have this event"]);
    this.store(ev);
    this.frame(conn, ["OK", ev.id, true, ""]);
    for (const c of this.conns) for (const [subId, filters] of c.subs) if (matchesAny(ev, filters)) this.send(c, subId, ev);
  }

  onReq(conn, subId, filters) {
    conn.subs.set(subId, filters);
    const stored = [...this.events.values()].filter((e) => matchesAny(e, filters)).sort((a, b) => b.created_at - a.created_at || (a.id < b.id ? -1 : 1));
    for (const e of stored) this.send(conn, subId, e);
    for (const e of this.replayOnReq) this.send(conn, subId, e);
    for (let i = 0; i < this.flood; i++) this.frame(conn, ["NOTICE", "x".repeat(10)]);
    this.frame(conn, ["EOSE", subId]);
  }

  // ---- test controls
  /** Puts a note in the store without telling anybody (an old note the relay will serve to later REQs). */
  inject(ev) {
    this.store(ev);
  }

  /** Cuts every connection from the relay's side. */
  dropConnections() {
    for (const c of [...this.conns]) c.serverClose();
  }

  /** Sends one raw frame text to every connection. */
  raw(text) {
    for (const c of this.conns) this.later(() => c.deliver(text));
  }

  get eventList() {
    return [...this.events.values()];
  }
}

class FakeNetwork {
  constructor() {
    this.relays = new Map();
    const net = this;
    this.WebSocket = class FakeWebSocket {
      constructor(url) {
        this.url = url;
        this.readyState = 0;
        this.subs = new Map();
        this.onopen = this.onmessage = this.onclose = this.onerror = null;
        this.relay = net.relays.get(url) || null;
        setImmediate(() => {
          if (this.readyState === CLOSED) return;
          if (!this.relay || this.relay.down) {
            this.readyState = CLOSED;
            this.onerror?.({});
            this.onclose?.({});
            return;
          }
          this.readyState = OPEN;
          this.relay.accept(this);
          this.onopen?.({});
        });
      }

      send(text) {
        if (this.readyState !== OPEN) throw new Error("not open");
        const r = this.relay;
        r.later(() => {
          if (this.readyState === OPEN) r.handle(this, text);
        });
      }

      deliver(text) {
        if (this.readyState === OPEN) this.onmessage?.({ data: text });
      }

      close() {
        if (this.readyState === CLOSED) return;
        this.readyState = CLOSED;
        this.relay?.conns.delete(this);
        setImmediate(() => this.onclose?.({}));
      }

      serverClose() {
        this.close();
      }
    };
    this.fetchInfo = async (url) => {
      const r = this.relays.get(url);
      return r ? r.info : null;
    };
  }

  add(url, opts) {
    const r = new FakeRelay(this, url, opts);
    this.relays.set(url, r);
    return r;
  }
}

/** Waits until `fn()` is truthy (polling every few ms), or fails after `ms`. */
async function until(fn, ms = 3000, what = "condition") {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error("timed out waiting for " + what);
    await new Promise((r) => setTimeout(r, 5));
  }
}

const settle = (ms = 40) => new Promise((r) => setTimeout(r, ms));

module.exports = { FakeNetwork, FakeRelay, until, settle };
