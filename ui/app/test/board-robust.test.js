"use strict";
// Hardening of the board host after an independent read (2026-11-17):
//  1. a counterparty cannot crash the console: out-of-order messages are held only when their type is allowed at that step, in one form, under a cap; no exception or rejected promise
//     raised while handling a relay message, a timer or a task callback leaves the host; a state that cannot be saved is not acted on;
//  2. a stopped board refuses a spend that has NOT started, decided from the role's OWN send evidence only ("unknown" is not started), against the host's own computation.
// Every relay and helper is a fake; none of this has been run against a real relay or the real WebSocket of Node.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const G = require("../lib/gate");
const { BoardHost } = require("../lib/board/host");
const { RelayPool } = require("../lib/board/relay");
const { writeHandover } = require("../lib/board/handoverfile");
const giftwrap = require("../lib/board/giftwrap");
const priv = require("../lib/board/privboard");
const N = require("../lib/board/note");
const { signingText, Handover } = require("../lib/board/handover");
const { Pair, ADDR, fakeSign } = require("./board-handover-harness");
const { until, FakeNetwork } = require("./board-fake-relay");
const H = require("./board-host-harness");
const { steps, refusedSync, codes } = require("./autopilot-harness");
const { makeWallet } = require("./wallet-harness");
const { mkTick } = require("./helpers");
const { makeConsole, makeShared, drive, RELAYS, HTLC, INVITE, OFFER_NOID, OFFER_WEI } = H;

const MAX_BYTES = 512 * 1024; // lib/board/handoverfile.js

// ---------------------------------------------------------------------------------------------- out-of-order messages (handover.js)
test("out-of-order messages: only a type that is allowed at that step is held, once, and the held total is capped; a message that does not fit is dropped with a note", () => {
  const pair = new Pair().begin({ nothingFunded: true });
  const { alice, bob } = pair;
  const big = (seq) => pair.forge(alice, "bundle", { bundle: "x".repeat(39000), digest: "a".repeat(64) }, seq);
  // eight oversized `bundle` messages at steps where only `done` can ever belong: nothing is held, the sender is not treated as broken, no exception
  for (let seq = 4; seq <= 11; seq++) assert.doesNotThrow(() => pair.inject(alice, bob, big(seq)));
  assert.deepEqual(Object.keys(bob.m.snapshot().pending), []);
  assert.ok(JSON.stringify(bob.m.snapshot()).length < 20000, "the snapshot stays small");
  assert.equal(bob.m.phase, "await_ready");
  assert.equal(bob.notes.filter((n) => /dropped: bundle is not expected/.test(n)).length, 8);
  // the next valid message is still processed
  pair.inject(alice, bob, pair.forge(alice, "funded", { txid: "0x" + "34".repeat(32) }, 3));
  assert.equal(bob.m.snapshot().expected, 4);
  // a small allowed message is held once, in its canonical form only
  pair.inject(alice, bob, pair.forge(alice, "done", { phase: "settled" }, 6));
  const held = bob.m.snapshot().pending[6];
  assert.deepEqual(Object.keys(held), ["canon"]);
  // the cap: a held total near 128 KB, then an allowed message that would take it over is dropped (never stored)
  const s = bob.m.snapshot();
  s.pending = { 7: { canon: "a".repeat(60000) }, 8: { canon: "b".repeat(60000) } };
  bob.m.rollbackTo(s);
  const out = bob.m.receive({ from: alice.pub, content: pair.forge(alice, "done", { phase: "settled" }, 9) + " ".repeat(0), at: pair.clock });
  assert.deepEqual(Object.keys(bob.m.snapshot().pending), ["7", "8", "9"], "a message that fits is held");
  const s2 = bob.m.snapshot();
  s2.pending = { 7: { canon: "a".repeat(60000) }, 8: { canon: "b".repeat(71500) } };
  bob.m.rollbackTo(s2);
  const out2 = bob.m.receive({ from: alice.pub, content: pair.forge(alice, "done", { phase: "settled" }, 9), at: pair.clock });
  assert.deepEqual(Object.keys(bob.m.snapshot().pending), ["7", "8"], "over the cap: not stored");
  assert.ok(out2.notes.some((n) => /over the cap/.test(n)));
  void out;
});

test("a snapshot from before this change (a held message with its parsed form) is still read back and handled in order", () => {
  const pair = new Pair().begin({ nothingFunded: true });
  const { alice, bob } = pair;
  const m = JSON.parse(pair.forge(alice, "done", { phase: "settled" }, 4));
  const s = bob.m.snapshot();
  s.pending = { 4: { canon: JSON.stringify(m), msg: m } };
  bob.m.rollbackTo(s);
  bob.take(bob.m.receive({ from: alice.pub, content: pair.forge(alice, "funded", { txid: "0x" + "34".repeat(32) }, 3), at: pair.clock }));
  assert.equal(bob.m.snapshot().expected, 5, "step 3 and the held step 4 were both taken in");
  assert.deepEqual(bob.m.snapshot().pending, {});
});

// ---------------------------------------------------------------------------------------------- a hostile counterparty against the host
function rawTaker(alice, shared) {
  const secret = N.generateSecretKey();
  const pub = N.getPublicKey(secret);
  const pool = new RelayPool({ urls: RELAYS, WebSocket: shared.net.WebSocket, fetchInfo: null });
  pool.start();
  let fixed = null; // fixed at the first use: the take names this note (the maker publishes a new one when it is taken)
  const offer = () => (fixed = fixed || { id: alice.host.hs.offer.id, pubkey: alice.host.hs.offer.pubkey });
  const self = {
    pub,
    send(seq, type, body) {
      const o = offer();
      const content = JSON.stringify({ v: 1, swap: o.id, taker: pub, seq, type, body });
      const w = giftwrap.wrap({ kind: N.KINDS.HANDOVER, content }, secret, o.pubkey, { now: Math.floor(alice.clock.ms / 1000), backdateS: 3600 }).wrap;
      return pool.publish(w);
    },
    take: () => self.send(1, "take", { offer: offer().id, proof: priv.takeProof(INVITE, offer().id, pub) }),
    addresses() {
      const b = { bob_noid: ADDR.bobNoid, bob_sender: ADDR.bobEth };
      return self.send(2, "bob_addresses", { ...b, sig: fakeSign(signingText("addresses", { offer: offer().id, take: pub, ...b }), ADDR.bobEth) });
    },
    close: () => pool.stop(),
  };
  return self;
}

test("a counterparty that sends eight oversized messages ahead of their turn cannot make the handover file grow past its limit or stop the console; its next valid message is processed", async () => {
  const shared = makeShared();
  const alice = makeConsole("alice", shared);
  const raw = rawTaker(alice, shared);
  try {
    alice.host.postOffer({ noid_micro: OFFER_NOID, wei: OFFER_WEI });
    await raw.take();
    await drive([alice], () => alice.host.m.phase === "await_addresses", { what: "the accept" });
    for (let seq = 4; seq <= 11; seq++) await raw.send(seq, "bundle", { bundle: "x".repeat(39000), digest: "a".repeat(64) });
    await until(() => alice.host.seenWraps.size >= 9, 5000, "the eight messages handled (the clock is not moved)");
    assert.equal(alice.host.error, null, "no error: nothing was held that could not be saved");
    assert.deepEqual(Object.keys(alice.host.m.snapshot().pending), []);
    assert.ok(fs.statSync(path.join(alice.f.run, "handover-alice.json")).size < MAX_BYTES / 4);
    assert.equal(alice.host.hs.stopped, null);
    await raw.addresses();
    await drive([alice], () => ["alice_setup", "preparing", "bundle_sent"].includes(alice.host.m.phase) || alice.host.hs.stopped, { what: "the next valid message" });
    assert.equal(alice.host.hs.stopped, null, JSON.stringify(alice.host.hs.stopped) + " " + JSON.stringify(alice.audit.all().slice(-6).map((r) => r.result)));
  } finally {
    raw.close();
    alice.cleanup();
  }
});

// ---------------------------------------------------------------------------------------------- nothing escapes a callback
test("a state that cannot be saved: nothing escapes the relay callback, the state is as it was, the error is recorded, the step and the autopilot still run, and the message is handled once the disk works", async () => {
  const shared = makeShared();
  let fail = false;
  const failing = (...a) => {
    if (fail) throw Object.assign(new Error("disk full"), { code: "ENOSPC" });
    return writeHandover(...a);
  };
  const alice = makeConsole("alice", shared, { deps: { writeHandover: failing } });
  const bob = makeConsole("bob", shared);
  try {
    alice.host.postOffer({ noid_micro: OFFER_NOID, wei: OFFER_WEI });
    await until(() => bob.host.offers().length === 1, 3000, "the offer on the board");
    const before = JSON.stringify(alice.host.m.snapshot());
    const peerBefore = alice.host.hs.peer_key;
    fail = true;
    bob.host.takeOffer(bob.host.offers()[0].id);
    await until(() => alice.host.error === "ENOSPC", 3000, "the error recorded");
    assert.equal(JSON.stringify(alice.host.m.snapshot()), before, "the machine is as it was");
    assert.equal(alice.host.hs.peer_key, peerBefore, "the take was not acted on");
    assert.equal(alice.host.view().error, "ENOSPC", "the board shows the error (a code only)");
    assert.ok(alice.audit.all().some((r) => r.action === "board" && /message failed/.test(r.result)));
    // the timer's pass: the host's step records its own error and the autopilot's step runs after it
    let apSteps = 0;
    const orig = alice.ap.step.bind(alice.ap);
    alice.ap.step = () => (apSteps++, orig());
    assert.doesNotThrow(() => alice.pass());
    assert.equal(apSteps, 1);
    // the disk works again: the same message is handled (it was kept for another try)
    fail = false;
    await drive([alice, bob], () => alice.host.hs.peer_key !== null && alice.host.m.phase !== "open", { what: "the take handled after the disk works" });
  } finally {
    alice.cleanup();
    bob.cleanup();
  }
});

test("onWrap never throws, whatever the handler raises; a message dropped after three failed saves leaves a note", async () => {
  const shared = makeShared();
  const alice = makeConsole("alice", shared);
  try {
    alice.host.postOffer({ noid_micro: OFFER_NOID, wei: OFFER_WEI });
    alice.host.onWrapNow = () => {
      throw new Error("boom");
    };
    assert.doesNotThrow(() => alice.host.onWrap({ id: "ab".repeat(32) }));
    assert.equal(alice.host.error, "error");
    // three failed saves of one message: it is dropped, not kept for ever
    alice.host.error = null;
    const m = { from: "cd".repeat(32), content: "{}", tries: 0 };
    alice.host.guarded = () => false;
    for (let i = 0; i < 3; i++) alice.host.deliverMessage(m);
    assert.equal(alice.host.inbox.filter((x) => x === m).length, 2, "kept twice, dropped the third time");
    assert.ok(alice.audit.all().some((r) => /message dropped/.test(r.result)));
  } finally {
    alice.cleanup();
  }
});

test("the tip read: a promise that rejects, and a callback whose state cannot be saved, leave no unhandled rejection and no change of state", async () => {
  const seen = [];
  const onRej = (e) => seen.push(e);
  process.on("unhandledRejection", onRej);
  try {
    // 1. the read rejects: the board is cancelled (as before), nothing is unhandled
    const c1 = makeConsole("alice", makeShared(), { deps: { readTip: () => Promise.reject(new Error("node down")) } });
    c1.host.postOffer({ noid_micro: OFFER_NOID, wei: OFFER_WEI });
    c1.host.taskTip();
    await new Promise((r) => setTimeout(r, 30));
    assert.ok(c1.host.hs.stopped, "the board was cancelled, as before");
    c1.cleanup();
    // 2. the read rejects and the save of the cancel fails: nothing escapes, the state is as it was
    let fail = false;
    const c2 = makeConsole("alice", makeShared(), { deps: { readTip: () => Promise.reject(new Error("node down")), writeHandover: (...a) => (fail ? (() => { throw Object.assign(new Error("x"), { code: "EIO" }); })() : writeHandover(...a)) } });
    c2.host.postOffer({ noid_micro: OFFER_NOID, wei: OFFER_WEI });
    fail = true;
    c2.host.taskTip();
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(c2.host.hs.stopped, null, "the cancel could not be saved: not applied");
    assert.equal(c2.host.m.phase, "open");
    assert.equal(c2.host.error, "EIO");
    c2.cleanup();
    // 3. the read answers and the save of the fact fails
    let fail3 = false;
    const c3 = makeConsole("alice", makeShared(), { deps: { readTip: async () => 123456, writeHandover: (...a) => (fail3 ? (() => { throw Object.assign(new Error("x"), { code: "EIO" }); })() : writeHandover(...a)) } });
    c3.host.postOffer({ noid_micro: OFFER_NOID, wei: OFFER_WEI });
    const snap = JSON.stringify(c3.host.m.snapshot());
    fail3 = true;
    c3.host.taskTip();
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(JSON.stringify(c3.host.m.snapshot()), snap);
    assert.equal(c3.host.error, "EIO");
    c3.cleanup();
    await new Promise((r) => setTimeout(r, 10));
    assert.deepEqual(seen, [], "no unhandled rejection");
  } finally {
    process.off("unhandledRejection", onRej);
  }
});

test("the relay client: a listener that throws never leaves the socket's handler; the error is counted, the other listeners run, and the next note still arrives", async () => {
  const net = new FakeNetwork();
  net.add("wss://a.relays.net");
  const pool = new RelayPool({ urls: ["wss://a.relays.net"], WebSocket: net.WebSocket, fetchInfo: null, backoff: { baseMs: 5, maxMs: 40, factor: 2, jitter: 0 } });
  const got = [];
  pool.on("event", () => {
    throw new Error("a listener that fails");
  });
  pool.on("event", (ev) => got.push(ev.id));
  pool.start();
  await pool.ready(1, 2000);
  pool.subscribe([{ kinds: [1] }]);
  const sk = N.generateSecretKey();
  const mk = (n) => N.finalizeEvent({ created_at: 1800000000 + n, kind: 1, tags: [], content: "n" + n }, sk);
  await pool.publish(mk(1));
  await pool.publish(mk(2));
  await until(() => got.length === 2, 3000, "both notes delivered to the second listener");
  assert.ok(pool.listenerErrors >= 2);
  assert.equal(pool.openCount(), 1, "the connection is still open");
  pool.stop();
});

// ---------------------------------------------------------------------------------------------- a stopped board and what has started (fix 2)
const PEER = "b2".repeat(32);
const OFFER = "a1".repeat(32);
const STOPPED = { code: "cancelled_here", at: 1, revoked: true, ends_swap: false };

/** A wallet run of the role that is a board run, with a REAL board host on it (no relay, no machine): the host computes the facts from the folder and the audit log. */
function runWithHost(role, { stopped = true } = {}) {
  const h = makeWallet({ role, envExtra: ["HANDOVER='board'"] });
  const host = new BoardHost({
    actions: h.runner,
    autopilot: h.ap,
    role,
    settings: { profile: "sepolia", relays: RELAYS, pinned_htlc: { 11155111: HTLC }, noid_payout: role === "alice" ? ADDR.aliceNoidPayout : null, bob_noid: ADDR.bobNoid, eth_payout: role === "alice" ? ADDR.aliceEthPayout : H.BOB_ETH_PAYOUT, lead_blocks: 60, invite_secret: INVITE.toString("hex") },
    deps: { now: () => h.clock.ms },
  });
  host.hs = { role, stopped: stopped ? { ...STOPPED } : null, peer_key: PEER, swap_id: OFFER, check: null, flags: {}, results: {}, outbox: [], offer: { terms: {} }, verified: {} };
  return { h, host };
}
const gateCodes = (h, id) => {
  const ctx = h.runner.spendContext(G.ALL_SPENDS[id], h.run(), h.clock.ms);
  return G.factsReady(G.ALL_SPENDS[id], ctx.gate).reasons.map((r) => r.code);
};
const BOB_ST = { stay_on: true, no_manual_steps: true };
const realLocks = (h) => h.log.filter((l) => l.script === "lock.sh" && !l.dry).length;

test("Bob stops after Alice's funding is seen and before his lock: nothing_funded turns false for the state machine, yet the lock is refused with board_stopped, by hand and by the autopilot", () => {
  const { h, host } = runWithHost("bob", { stopped: false });
  try {
    h.runner.walletPoll();
    h.tick("bob", "lock_eth"); // Bob's tick: the funding is final, his lock is offered
    h.loop("bob");
    assert.equal(h.approve("bob", { statements: BOB_ST }).status, 200);
    host.hs.stopped = { ...STOPPED }; // his cancel was lost or ignored by the other side; Alice funded anyway
    assert.equal(host.nothingFunded(), false, "the state machine's fact: Alice's funding is seen (kept as it was)");
    assert.deepEqual(host.gateFacts("bob").started, { fund_noid: false, lock_eth: false }, "but his own lock has not started");
    assert.ok(gateCodes(h, "send-lock").includes("board_stopped"));
    const e = refusedSync(() => h.runner.startSpend("send-lock", "0.001 ETH", {}));
    assert.ok(codes(e).includes("board_stopped"));
    steps(h, 4);
    assert.equal(realLocks(h), 0, "the autopilot did not lock under an approval the stop revoked");
    assert.equal(h.audit.all().some((r) => r.action === "send-lock" && r.phase === "start"), false);
  } finally {
    h.cleanup();
  }
  // the control: the same run without the stop does lock (the set-up is able to)
  const c = runWithHost("bob", { stopped: false });
  try {
    c.h.runner.walletPoll();
    c.h.tick("bob", "lock_eth");
    c.h.loop("bob");
    assert.equal(c.h.approve("bob", { statements: BOB_ST }).status, 200);
    steps(c.h, 3);
    assert.equal(realLocks(c.h), 1);
  } finally {
    c.h.cleanup();
  }
});

test("Bob stops after his lock's start line, or with his own tick past the lock: the lock is not refused for the stop, and nothing else is refused either", () => {
  const { h, host } = runWithHost("bob", { stopped: false });
  try {
    h.runner.walletPoll();
    h.tick("bob", "lock_eth");
    h.loop("bob");
    assert.equal(h.approve("bob", { statements: BOB_ST }).status, 200);
    steps(h, 3);
    assert.equal(realLocks(h), 1);
    host.hs.stopped = { ...STOPPED };
    assert.equal(host.gateFacts("bob").started.lock_eth, true, "the start line of the lock");
    assert.ok(!gateCodes(h, "send-lock").includes("board_stopped"));
    h.adv(40000);
    h.tick("bob", "refund_eth");
    for (const id of ["send-refund-eth", "send-claim"]) assert.ok(!gateCodes(h, id).includes("board_stopped"), id);
  } finally {
    h.cleanup();
  }
  // no start line (the audit log of another folder), but the tick says the lock was sent
  const t = runWithHost("bob");
  try {
    t.h.runner.walletPoll();
    t.h.f.writeTickAt("bob", mkTick({ phase: "lock_submitted", action: { action: "wait", reason: "waiting" } }), t.h.clock.ms - 3000);
    assert.equal(t.host.gateFacts("bob").started.lock_eth, true, "the role's own tick phase is lock_submitted");
    t.h.f.writeTickAt("bob", mkTick({ phase: "funding_final", action: { action: "wait", reason: "waiting" } }), t.h.clock.ms - 2000);
    assert.equal(t.host.gateFacts("bob").started.lock_eth, false, "a phase before the lock is no evidence");
    t.h.f.writeTickAt("bob", mkTick({ phase: "received", action: { action: "wait", reason: "waiting" } }), t.h.clock.ms - 1000);
    assert.equal(t.host.gateFacts("bob").started.lock_eth, false);
  } finally {
    t.h.cleanup();
  }
});

test("Alice stops with an unreadable audit log or wallet record: her funding is refused (\"unknown\" is not started)", () => {
  const { h, host } = runWithHost("alice");
  try {
    h.runner.walletPoll();
    h.tick("alice", "fund_noid");
    const realAll = h.audit.all.bind(h.audit);
    h.audit.all = () => {
      throw new Error("unreadable");
    };
    assert.equal(host.nothingFunded(), "unknown");
    assert.equal(host.gateFacts("alice").started.fund_noid, false);
    h.audit.all = realAll;
    const realMarker = h.runner.walletMarker.bind(h.runner);
    h.runner.walletMarker = () => {
      throw new Error("unreadable");
    };
    assert.equal(host.gateFacts("alice").started.fund_noid, false, "an unreadable wallet record is not a funding");
    h.runner.walletMarker = realMarker;
    // the gate, with the log unreadable while the facts are taken
    h.audit.all = () => {
      throw new Error("unreadable");
    };
    const facts = host.gateFacts("alice");
    h.audit.all = realAll;
    const f2 = h.runner.board;
    h.runner.board = { gateFacts: () => facts, identity: () => host.identity() };
    assert.ok(gateCodes(h, "send-fund").includes("board_stopped"));
    h.runner.board = f2;
  } finally {
    h.cleanup();
  }
});

test("Alice stops after her funding's start line (or with the wallet's own funding record): the funding counts as started and her reveal and recovery are not refused", () => {
  const { h, host } = runWithHost("alice");
  try {
    h.runner.walletPoll();
    h.tick("alice", "fund_noid");
    assert.equal(host.gateFacts("alice").started.fund_noid, false);
    h.audit.append({ action: "send-fund", role: "alice", phase: "start", result: "started" });
    assert.equal(host.gateFacts("alice").started.fund_noid, true);
    assert.ok(!gateCodes(h, "send-fund").includes("board_stopped"));
    h.tick("alice", "reveal_eth");
    for (const id of ["send-reveal", "send-recover"]) assert.ok(!gateCodes(h, id).includes("board_stopped"), id);
  } finally {
    h.cleanup();
  }
  // the wallet's own record, with no start line in the audit log
  const w = runWithHost("alice");
  try {
    fs.writeFileSync(path.join(w.h.f.run, "wallet-fund-100001.json"), "{}");
    assert.equal(w.host.gateFacts("alice").started.fund_noid, true);
  } finally {
    w.h.cleanup();
  }
  // and a role never counts the other role's spend as its own
  const b = runWithHost("bob");
  try {
    assert.equal(b.host.gateFacts("bob").started.fund_noid, false);
  } finally {
    b.h.cleanup();
  }
});

void Handover;
