"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const D = require("../lib/demo");
const V = require("../lib/viewmodel");
const P = require("../lib/phases");
const { hasSecretField } = require("../lib/secrets");

function render(sc, role, i, flags = []) {
  const p = D.demoPayload({ scenario: sc, role, step: i, flags });
  const r = p.roles[role];
  const v = V.buildView({ role, now: p.server_now, tick: r.tick, tick_mtime: r.tick_mtime, loop: r.loop, terms: p.terms, helpers: p.helpers, verify: p.verify, commands: p.commands, demo: true });
  return { p, v };
}

test("demo: every phase of both roles can be reached, and renders", () => {
  for (const role of ["alice", "bob"]) {
    assert.deepEqual(D.coveredPhases(role).sort(), P.phaseIds(role).sort(), `${role}: demo covers exactly the phase catalogue`);
    const seen = new Set();
    for (const sc of D.SCENARIOS) {
      for (let i = 0; i < sc[role].length; i++) {
        const { v } = render(sc.id, role, i);
        assert.equal(v.phase.known, true, `${sc.id}/${role}/${i}`);
        assert.equal(v.phase.id, sc[role][i].phase);
        assert.ok(v.timeline.main.length > 0);
        seen.add(v.phase.id);
      }
    }
    assert.equal(seen.size, P.phaseIds(role).length);
  }
});

test("demo: both abort paths are there and end in refunds", () => {
  const ids = D.SCENARIOS.map((s) => s.id);
  assert.ok(ids.includes("abort-a") && ids.includes("abort-b"));
  const a = D.SCENARIOS.find((s) => s.id === "abort-a");
  assert.equal(a.alice[a.alice.length - 1].phase, "refunded", "Bob never locks: Alice refunded");
  assert.equal(a.bob[a.bob.length - 1].phase, "aborted", "Bob never locks: Bob aborted, nothing locked");
  const b = D.SCENARIOS.find((s) => s.id === "abort-b");
  assert.equal(b.alice[b.alice.length - 1].phase, "refunded", "Alice never reveals: Alice refunded");
  assert.equal(b.bob[b.bob.length - 1].phase, "refunded", "Alice never reveals: Bob refunded");
  // the step that matters: the cutoff passed and the engine refuses to reveal
  const cut = render("abort-b", "alice", 2).v;
  assert.match(cut.action.reason, /reveal cutoff passed/);
  assert.equal(cut.deadlines.find((d) => d.id === "reveal_cutoff").state, "passed");
  assert.equal(cut.status, "waiting");
  // D reached: the engine offers the recovery with a command
  const d = render("abort-b", "alice", 4).v;
  assert.equal(d.action.kind, "refund_noid");
  assert.equal(d.action.commands.length, 3);
  assert.equal(d.deadlines.find((x) => x.id === "d").state, "passed");
  // Bob after T_reveal
  const br = render("abort-b", "bob", 1).v;
  assert.equal(br.action.kind, "refund_eth");
  assert.equal(br.deadlines.find((x) => x.id === "t_reveal").state, "passed");
  const lost = render("worst", "alice", 2).v;
  assert.equal(lost.phase.id, "lost");
  assert.equal(lost.status, "lost");
});

test("demo: the fixtures carry a marker preimage on purpose, and the payload never serves it", () => {
  const raw = D.buildTick("bob", D.SCENARIOS[0].bob[5], 1800000000, {}).tick;
  assert.ok(hasSecretField(raw), "the raw demo tick contains a preimage (so the strip is exercised)");
  for (const sc of D.SCENARIOS) {
    for (const role of ["alice", "bob"]) {
      for (let i = 0; i < sc[role].length; i++) {
        const { p } = render(sc.id, role, i, ["held", "anomaly", "reorg"]);
        const text = JSON.stringify(p);
        assert.ok(!text.includes(D.FAKE_SECRET.slice(2)), `${sc.id}/${role}/${i}: preimage served`);
        assert.ok(!hasSecretField(p));
      }
    }
  }
});

test("demo: placeholders only, no real addresses", () => {
  const text = JSON.stringify(D.TERMS);
  assert.match(text, /PLACEHOLDER/);
  assert.match(D.TERMS.eth.alice_receiver, /^0x0{36}[0-9a-f]{4}$/);
  assert.match(D.TERMS.eth.bob_sender, /^0x0{36}[0-9a-f]{4}$/);
  assert.match(D.TERMS.eth.contract, /^0x0{36}[0-9a-f]{4}$/);
  assert.ok(!/o1[a-z0-9]{50,}/.test(text), "no bech32-looking address");
});

test("demo flags switch the states the page must show", () => {
  const base = (f) => render("happy", "alice", 5, f).v;
  assert.equal(base([]).alarms.filter((a) => a.level !== "info").length, 0, "no flag: nothing but the recorded-intent note");
  assert.ok(base(["stale"]).alarms.some((a) => a.id === "tick-stale"));
  assert.equal(base(["stale"]).status, "act-stale");
  assert.ok(base(["single"]).alarms.some((a) => a.id === "single-Parano1d"));
  assert.ok(base(["lag"]).alarms.some((a) => a.id === "eth-head-old" || a.id === "noid-disagree"));
  assert.ok(base(["anomaly"]).alarms.some((a) => a.id === "anomaly"));
  assert.ok(base(["reorg"]).alarms.some((a) => a.id === "event-noid_tx_reorged"));
  const held = base(["held"]);
  assert.equal(held.status, "held");
  assert.equal(held.action.intent.status, "held");
  const wh = base(["withheld"]);
  assert.equal(wh.action.withheld, true);
  assert.deepEqual(wh.action.commands, []);
  assert.equal(wh.header.tick.applied, false);
  // unknown flags are ignored
  assert.deepEqual(D.demoPayload({ scenario: "happy", role: "alice", step: 0, flags: ["nope", "stale"] }).demo.flags, ["stale"]);
});

test("demo payload: step by id or index, clamped; unknown scenario falls back; the loop history follows the steps", () => {
  const p = D.demoPayload({ scenario: "abort-b", role: "bob", step: "refund_mined" });
  assert.equal(p.demo.step, 3);
  assert.equal(p.roles.bob.tick.phase_after, "refund_mined");
  assert.equal(p.roles.alice, null);
  assert.equal(D.demoPayload({ scenario: "abort-b", role: "bob", step: 99 }).demo.step, 4);
  assert.equal(D.demoPayload({ scenario: "abort-b", role: "bob", step: -3 }).demo.step, 0);
  assert.equal(D.demoPayload({ scenario: "nope", role: "alice", step: 0 }).demo.scenario, "happy");
  const loop = p.roles.bob.loop.entries;
  assert.equal(loop[loop.length - 1].phase_after, "refund_mined");
  assert.deepEqual(loop.map((e) => e.phase_after), ["locked", "locked", "refund_submitted", "refund_mined"]);
  assert.equal(p.mode, "demo");
  assert.equal(p.terms.hashlock, D.TERMS.hashlock);
});

test("demo countdowns move with the clock", () => {
  const p = D.demoPayload({ scenario: "happy", role: "alice", step: 5, now: 1800000000 });
  const r = p.roles.alice;
  const at = (now) => V.buildView({ role: "alice", now, tick: r.tick, tick_mtime: r.tick_mtime, terms: p.terms, helpers: [] }).deadlines.find((d) => d.id === "reveal_cutoff").seconds_left;
  assert.equal(at(1800000000) - at(1800000060), 60);
});
