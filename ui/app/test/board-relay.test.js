"use strict";
// P3.3: the relay client on the fake relays (test/board-fake-relay.js): several relays, OK handling, subscriptions, dedupe, reconnect, NIP-11 limits,
// the URL rules and the size cap on incoming frames.
const test = require("node:test");
const assert = require("node:assert/strict");
const N = require("../lib/board/note");
const { RelayPool, normalizeRelayUrl, matchesFilter, filterProblem } = require("../lib/board/relay");
const { FakeNetwork, until, settle } = require("./board-fake-relay");

const URL_A = "wss://a.relays.net";
const URL_B = "wss://b.relays.org";
const URL_C = "wss://c.relays.io";
const sk = N.generateSecretKey();
let tick = 1800000000;
const note = (o = {}) => N.finalizeEvent({ created_at: tick++, kind: 1, tags: [["t", "x"]], content: "n" + tick, ...o }, o.secret || sk);
const FAST = { backoff: { baseMs: 5, maxMs: 40, factor: 2, jitter: 0 }, connectTimeoutMs: 500, publishTimeoutMs: 300 };

function setup(urls = [URL_A, URL_B], opts = {}) {
  const net = new FakeNetwork();
  const relays = urls.map((u) => net.add(u, opts.relay));
  const pool = new RelayPool({ urls, WebSocket: net.WebSocket, fetchInfo: opts.fetchInfo === undefined ? net.fetchInfo : opts.fetchInfo, ...FAST, ...(opts.pool || {}) });
  const events = [];
  pool.on("event", (ev, url, sub) => events.push({ ev, url, sub }));
  return { net, relays, pool, events };
}

// ---------------------------------------------------------------------------------------------- URL rules (amendment H)
test("relay URLs: wss:// with a public host name only; the normal form is returned", () => {
  for (const u of ["wss://relay.damus.io", "wss://a.relays.net:8443/ws", "wss://a-b.c-d.relays.net", "wss://xn--bcher-kva.example.net"]) assert.equal(normalizeRelayUrl(u).ok, true, u);
  assert.equal(normalizeRelayUrl("wss://RELAY.Damus.IO/").url, "wss://relay.damus.io");
  assert.equal(normalizeRelayUrl("wss://a.relays.net/path/").url, "wss://a.relays.net/path");
  assert.equal(normalizeRelayUrl("wss://a.relays.net/%2e%2e/x").url, "wss://a.relays.net/x", "dot segments are resolved by the URL parser, never kept");
  const bad = [
    "ws://a.relays.net", "http://a.relays.net", "https://a.relays.net", "wss://localhost", "wss://localhost:8080", "wss://127.0.0.1", "wss://[::1]", "wss://[::ffff:7f00:1]",
    "wss://10.0.0.1", "wss://192.168.1.1", "wss://172.16.0.1", "wss://169.254.169.254", "wss://8.8.8.8", "wss://2130706433", "wss://0x7f.1", "wss://0177.0.0.1", "wss://printer.local",
    "wss://x.internal", "wss://x.lan", "wss://x.home.arpa", "wss://abc.onion", "wss://nodot", "wss://a..relays.net", "wss://a.relays.net.", "wss://-a.relays.net", "wss://a.relays.net:0",
    "wss://a.relays.net:70000", "wss://user:pw@a.relays.net", "wss://a.relays.net/?x=1", "wss://a.relays.net/#x", "wss://a.relays.net/a b", "wss://x.test", "wss://x.example",
    "wss://ünï.relays.net", "wss://a.relays.net\n", " wss://a.relays.net", "", "wss://", "javascript:alert(1)", "wss://a.relays.net/" + "x".repeat(300), 5, null, undefined, {}, ["wss://a.relays.net"],
  ];
  for (const u of bad) assert.equal(normalizeRelayUrl(u).ok, false, String(u));
});

test("relay URLs: ws://127.0.0.1 only when the code passes the test flag, and nothing else local even then", () => {
  assert.equal(normalizeRelayUrl("ws://127.0.0.1:7777").ok, false);
  assert.deepEqual(normalizeRelayUrl("ws://127.0.0.1:7777", { allowLocalTest: true }), { ok: true, url: "ws://127.0.0.1:7777" });
  for (const u of ["ws://localhost:7777", "ws://127.0.0.2", "ws://10.0.0.1", "ws://a.relays.net", "wss://127.0.0.1"]) assert.equal(normalizeRelayUrl(u, { allowLocalTest: true }).ok, false, u);
  // a pool that is not given the flag skips such an address, and says so
  const p = new RelayPool({ urls: ["ws://127.0.0.1:7777", URL_A], WebSocket: class {} });
  assert.deepEqual([...p.relays.keys()], [URL_A]);
  assert.equal(p.rejected.length, 1);
});

// ---------------------------------------------------------------------------------------------- publish and subscribe
test("publish: every relay answers OK; the note is stored; a second publish is a duplicate and still counts", async () => {
  const { pool, relays } = setup();
  pool.start();
  const ev = note();
  const r = await pool.publish(ev);
  assert.equal(r.accepted, 2);
  assert.deepEqual(r.results.map((x) => x.accepted), [true, true]);
  for (const rl of relays) assert.equal(rl.events.has(ev.id), true);
  const again = await pool.publish(ev);
  assert.equal(again.accepted, 2);
  assert.ok(again.results[0].message.startsWith("duplicate"));
  await assert.rejects(pool.publish({ ...ev, content: "x" }), /not valid/);
  pool.stop();
});

test("subscribe: a note from two relays is delivered once; a note the relay stored before is delivered too", async () => {
  const { pool, relays, events } = setup();
  const old = note();
  for (const r of relays) r.inject(old);
  pool.start();
  const sub = pool.subscribe([{ kinds: [1], "#t": ["x"] }]);
  await until(() => events.length >= 1, 2000, "the stored note");
  const fresh = note();
  await pool.publish(fresh);
  await until(() => events.length >= 2, 2000, "the fresh note");
  await settle(80);
  assert.deepEqual(events.map((e) => e.ev.id).sort(), [old.id, fresh.id].sort(), "each note once, though two relays hold and serve it");
  sub.close();
  await settle(40);
  assert.ok(relays[0].received.some((m) => m[0] === "CLOSE" && m[1] === sub.id));
  const later = note();
  await pool.publish(later);
  await settle(60);
  assert.equal(events.length, 2, "nothing after the subscription was closed");
  pool.stop();
});

test("dedupe: relays that repeat every note, and a relay that sends the same note again later, give the app one copy", async () => {
  const { pool, relays, events } = setup([URL_A, URL_B]);
  relays[0].duplicate = 3;
  pool.start();
  pool.subscribe([{ kinds: [1] }]);
  const ev = note();
  await pool.publish(ev);
  await settle(100);
  assert.equal(events.length, 1);
  relays[1].raw(JSON.stringify(["EVENT", [...pool.subs.keys()][0], ev])); // the same note again, by hand
  await settle(60);
  assert.equal(events.length, 1);
  pool.stop();
});

test("dropped, delayed and reordered deliveries: what a relay holds back reaches the app by another relay, or later, in any order", async () => {
  const { pool, relays, events } = setup([URL_A, URL_B, URL_C]);
  pool.start();
  pool.subscribe([{ kinds: [1] }]);
  await pool.ready(3);
  relays[0].drop = () => true; // never forwards
  relays[1].delayMs = 40; // slow
  const e1 = note();
  await pool.publish(e1);
  await until(() => events.length >= 1, 2000, "delivery by the relays that forward");
  assert.equal(events.length, 1);
  assert.notEqual(events[0].url, URL_A);
  // a reordering relay: two notes held, released newest first
  relays[0].drop = null;
  relays[1].delayMs = 0;
  relays[2].hold = true;
  relays[0].silentStore = true;
  relays[1].silentStore = true;
  const e2 = note();
  const e3 = note();
  await pool.publish(e2);
  await pool.publish(e3);
  await settle(40);
  assert.equal(events.length, 1);
  relays[2].release({ reverse: true });
  await until(() => events.length >= 3, 2000, "released notes");
  assert.deepEqual(events.slice(1).map((e) => e.ev.id), [e3.id, e2.id], "arrival order is the relay's, not the author's: the layers above must not rely on it");
  pool.stop();
});

test("a relay that re-serves an old note in answer to a request: delivered (it is genuine) but only once; one that serves a note the filter did not ask for is a violation", async () => {
  const { pool, relays, events } = setup([URL_A]);
  const oldNote = N.finalizeEvent({ created_at: 1000, kind: 1, tags: [["t", "x"]], content: "ancient" }, sk);
  relays[0].replayOnReq = [oldNote];
  pool.start();
  pool.subscribe([{ kinds: [1] }]);
  await until(() => events.length === 1, 2000, "the old note");
  assert.equal(events[0].ev.id, oldNote.id);
  // a note of another kind than asked for
  const wrongKind = note({ kind: 7 });
  relays[0].replayOnReq = [wrongKind];
  pool.subscribe([{ kinds: [1], authors: [N.getPublicKey(sk)] }]);
  await settle(80);
  assert.equal(events.length, 1, "not delivered");
  assert.ok(pool.status()[0].violations >= 1);
  pool.stop();
});

test("a substituted or tampered note is dropped; a good one still arrives; a relay that keeps sending bad ones is cut off and reconnected", async () => {
  const { pool, relays, events } = setup([URL_A]);
  pool.cfg.maxViolations = 3;
  relays[0].substitute = (ev) => ({ ...ev, content: ev.content + "!" }); // content changed, id and signature left: invalid
  pool.start();
  pool.subscribe([{ kinds: [1] }]);
  const status = [];
  pool.on("status", (s) => status.push(s.state));
  await pool.publish(note());
  await pool.publish(note());
  await pool.publish(note());
  await until(() => status.includes("backoff"), 2000, "the relay is dropped");
  assert.equal(events.length, 0);
  relays[0].substitute = null;
  await until(() => pool.openCount() === 1, 2000, "a reconnect");
  const good = note();
  await pool.publish(good);
  await until(() => events.some((e) => e.ev.id === good.id), 2000, "the good note after the reconnect");
  pool.stop();
});

test("frames over the size cap are not parsed and the connection is dropped; so are frames that are not text or not JSON, after a few", async () => {
  const { pool, relays } = setup([URL_A], { pool: { maxFrameBytes: 2000 } });
  pool.start();
  await pool.ready(1);
  const dropped = [];
  pool.on("status", (s) => dropped.push(s));
  relays[0].raw(JSON.stringify(["NOTICE", "x".repeat(5000)]));
  await until(() => dropped.some((s) => s.state === "backoff"), 2000, "the oversize frame drops the connection");
  assert.ok(dropped.some((s) => s.state === "violation" && /size cap/.test(s.why)));
  await until(() => pool.openCount() === 1, 2000, "reconnected");
  const noticed = [];
  pool.on("notice", (u, t) => noticed.push(t));
  relays[0].raw("not json");
  relays[0].raw(JSON.stringify({ a: 1 }));
  relays[0].raw(JSON.stringify(["NOTICE", "fine"]));
  await until(() => noticed.length === 1, 2000, "a sensible frame after bad ones");
  assert.equal(pool.status()[0].violations, 3, "the oversize frame and the two bad ones");
  pool.stop();
});

// ---------------------------------------------------------------------------------------------- OK handling
test("OK handling: a refusal is reported with its text; a silent relay times out; the others still count", async () => {
  const { pool, relays } = setup([URL_A, URL_B, URL_C], { pool: { publishTimeoutMs: 120 } });
  relays[0].refuse = "blocked: not on the list";
  relays[1].silentOk = true;
  pool.start();
  await pool.ready(3);
  const r = await pool.publish(note());
  assert.equal(r.accepted, 1);
  const by = Object.fromEntries(r.results.map((x) => [x.url, x]));
  assert.deepEqual([by[URL_A].accepted, by[URL_A].message], [false, "blocked: not on the list"]);
  assert.deepEqual([by[URL_B].accepted, by[URL_B].message], [false, "timeout"]);
  assert.equal(by[URL_C].accepted, true);
  pool.stop();
});

test("a publish waits for a relay that is not open yet, and fails cleanly for one that never opens", async () => {
  const { pool, relays } = setup([URL_A, URL_B], { pool: { publishTimeoutMs: 150 } });
  relays[1].down = true;
  pool.start(); // nothing is open yet at this instant
  const p = pool.publish(note());
  const r = await p;
  assert.equal(r.accepted, 1);
  assert.equal(r.results.find((x) => x.url === URL_B).accepted, false);
  relays[1].down = false;
  await until(() => pool.openCount() === 2, 2000, "the late relay is reached by the backoff");
  const r2 = await pool.publish(note());
  assert.equal(r2.accepted, 2);
  pool.stop();
});

// ---------------------------------------------------------------------------------------------- reconnect
test("reconnect: after the relay cuts the connection the client reconnects with a growing wait and sends the subscription again", async () => {
  const { pool, relays, events } = setup([URL_A]);
  const waits = [];
  pool.on("status", (s) => s.state === "backoff" && waits.push(s.waitMs));
  pool.start();
  pool.subscribe([{ kinds: [1] }]);
  await pool.ready(1);
  await settle(30); // the first REQ reaches the relay
  relays[0].down = true;
  relays[0].dropConnections();
  await until(() => waits.length >= 3, 3000, "several attempts while the relay is down");
  assert.ok(waits[1] >= waits[0] && waits[2] >= waits[1], "the waits do not shrink: " + waits.join(","));
  assert.ok(waits.every((w) => w <= 40), "and stay under the cap");
  relays[0].down = false;
  await until(() => pool.openCount() === 1, 2000, "reconnected");
  await until(() => relays[0].received.filter((m) => m[0] === "REQ").length === 2, 2000, "the subscription sent again");
  const ev = note();
  relays[0].inject(ev);
  relays[0].dropConnections();
  await until(() => events.some((e) => e.ev.id === ev.id), 3000, "a note stored while we were away arrives after the next reconnect");
  pool.stop();
  assert.equal(pool.openCount(), 0);
  relays[0].dropConnections();
  await settle(60);
  assert.equal(pool.status()[0].state, "idle", "no reconnect after stop()");
});

test("stop(): publishes in flight are resolved, nothing reconnects", async () => {
  const { pool, relays } = setup([URL_A]);
  relays[0].silentOk = true;
  pool.start();
  await pool.ready(1);
  const p = pool.publish(note(), { timeoutMs: 5000 });
  await settle(20);
  pool.stop();
  const r = await p;
  assert.equal(r.accepted, 0);
  assert.equal(r.results[0].message, "stopped");
});

// ---------------------------------------------------------------------------------------------- NIP-11
test("NIP-11: a note larger than the relay accepts, or below its proof of work, or for a relay that wants authentication or payment, is not sent there", async () => {
  const { pool, relays } = setup([URL_A, URL_B, URL_C, "wss://d.relays.dev"]);
  relays[0].info = { limitation: { max_message_length: 200 } };
  relays[1].info = { limitation: { min_pow_difficulty: 30 } };
  relays[2].info = { limitation: { auth_required: true } };
  pool.start();
  await pool.ready(4);
  await settle(30);
  const r = await pool.publish(note({ content: "y".repeat(400) }));
  const by = Object.fromEntries(r.results.map((x) => [x.url, x]));
  assert.match(by[URL_A].message, /larger/);
  assert.match(by[URL_B].message, /proof of work/);
  assert.match(by[URL_C].message, /authentication/);
  assert.equal(by["wss://d.relays.dev"].accepted, true);
  for (const rl of relays.slice(0, 3)) assert.equal(rl.received.filter((m) => m[0] === "EVENT").length, 0, "nothing was sent to " + rl.url);
  assert.equal(pool.status().find((s) => s.url === URL_A).limits.max_message_length, 200);
  pool.stop();
});

test("NIP-11: a document with wrong types, or none, is ignored; a failing reader does not stop the relay being used", async () => {
  const { pool } = setup([URL_A], { fetchInfo: async () => ({ limitation: { max_message_length: "huge", min_pow_difficulty: -1, auth_required: "yes" } }) });
  pool.start();
  await pool.ready(1);
  await settle(20);
  assert.deepEqual(pool.status()[0].limits, {});
  assert.equal((await pool.publish(note())).accepted, 1);
  pool.stop();
  const b = setup([URL_A], { fetchInfo: async () => { throw new Error("no document"); } });
  b.pool.start();
  assert.equal((await b.pool.publish(note())).accepted, 1);
  b.pool.stop();
  const c = setup([URL_A], { fetchInfo: null });
  c.pool.start();
  assert.equal((await c.pool.publish(note())).accepted, 1);
  c.pool.stop();
});

// ---------------------------------------------------------------------------------------------- filters
test("filters: the local match follows NIP-01, and a malformed filter is refused before anything is sent", () => {
  const ev = N.finalizeEvent({ created_at: 100, kind: 5, tags: [["t", "x"], ["p", "a".repeat(64)]], content: "" }, sk);
  const m = (f) => matchesFilter(ev, f);
  assert.equal(m({}), true);
  assert.equal(m({ kinds: [5] }), true);
  assert.equal(m({ kinds: [6] }), false);
  assert.equal(m({ authors: [ev.pubkey] }), true);
  assert.equal(m({ authors: ["b".repeat(64)] }), false);
  assert.equal(m({ ids: [ev.id] }), true);
  assert.equal(m({ since: 100, until: 100 }), true);
  assert.equal(m({ since: 101 }), false);
  assert.equal(m({ until: 99 }), false);
  assert.equal(m({ "#t": ["x", "y"] }), true);
  assert.equal(m({ "#t": ["y"] }), false);
  assert.equal(m({ "#p": ["a".repeat(64)], kinds: [5] }), true);
  assert.equal(m({ "#e": ["a".repeat(64)] }), false);
  for (const f of [[], [5], [{ kinds: [] }], [{ authors: ["xyz"] }], [{ kinds: ["1"] }], [{ since: -1 }], [{ "#t": [] }], [{ nonsense: 1 }], [{ limit: 1.5 }], Array(9).fill({})]) assert.ok(filterProblem(f), JSON.stringify(f).slice(0, 40));
  assert.equal(filterProblem([{ kinds: [1], "#t": ["a"], since: 5, limit: 10 }]), null);
  const { pool } = setup([URL_A]);
  assert.throws(() => pool.subscribe([{ kinds: [] }]), /filter/);
  assert.throws(() => pool.subscribe([{ kinds: [1] }], { id: "bad id!" }), /subscription id/);
  pool.subscribe([{ kinds: [1] }], { id: "s1" });
  assert.throws(() => pool.subscribe([{ kinds: [1] }], { id: "s1" }), /in use/);
});

test("a note for a subscription that does not exist (or no longer) is ignored", async () => {
  const { pool, relays, events } = setup([URL_A]);
  pool.start();
  await pool.ready(1);
  relays[0].raw(JSON.stringify(["EVENT", "nobody-asked", note()]));
  await settle(60);
  assert.equal(events.length, 0);
  assert.equal(pool.status()[0].violations, 0);
  pool.stop();
});
