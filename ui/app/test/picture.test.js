"use strict";
// The two display-only fields of the view model: view.clock (the one deadline of the step this role is asked to do now) and view.picture
// (both locks on one axis from now). Both read only finished deadline rows, the engine's phase id and the clock.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const V = require("../lib/viewmodel");
const F = require("./actions-fixtures");
const { NOW, D, mkTick, mkLock, input } = require("./helpers");

const view = (role, tick, extra) => V.buildView(input(role, tick, extra));
const row = (v, id) => v.deadlines.find((d) => d.id === id);

const revealIntent = (cutoff, late) => ({ status: "recorded", intent: { action: "reveal_eth", decided_at: NOW - 10, params: { cutoff, ...(late ? { late_cutoff: late } : {}) } } });
// T_reveal = NOW + 3000: T_reveal - 1800 = NOW + 1200, so the last moment to start is NOW + 1110 (less the 30 s send budget and the page's 60 s allowance) when the frozen cutoff is not earlier
const aliceReveal = (o = {}) => mkTick({ phase: "lock_final", lock: mkLock({ timelock: NOW + 3000 }), action: { action: "reveal_eth", reason: "lock final" }, intent: o.intent === undefined ? revealIntent(NOW + 1200, NOW + 2000) : o.intent, ...(o.tick || {}) });
const bobClaim = (o = {}) => mkTick({ phase: "secret_seen", lock: mkLock({ timelock: NOW + 3000 }), action: { action: "claim_noid", reason: "secret seen", call_height: 1, fee_micronoid: 5800 }, tip: D - 100, ...o });

// ---------------------------------------------------------------- the two constants are the helper's
test("the sender-rule constants are pinned to the reveal helper's source", () => {
  const eth = path.join(__dirname, "..", "..", "..", "eth", "scripts");
  const live = fs.readFileSync(path.join(eth, "live.js"), "utf8");
  assert.ok(live.includes("const DEFAULT_MARGIN_S = 1800;"), "eth/scripts/live.js: DEFAULT_MARGIN_S is no longer 1800");
  const bs = fs.readFileSync(path.join(eth, "bounded-send.js"), "utf8");
  const line = /const DEFAULT_TIMING = Object\.freeze\(\{([^}]*)\}\)/.exec(bs);
  assert.ok(line, "eth/scripts/bounded-send.js: DEFAULT_TIMING not found");
  const tail = Number(/tailMs:\s*(\d+)/.exec(line[1])[1]);
  const guard = Number(/guardMs:\s*(\d+)/.exec(line[1])[1]);
  assert.equal(tail + guard, 30000, "the send budget (tail + guard) is no longer 30 s");
  assert.equal(Number(/connectMs:\s*(\d+)/.exec(line[1])[1]), 15000, "the sender's connect limit is no longer 15 s");
  assert.ok(/function sendBudgetMs\(\) \{\s*const t = sendTiming\(\);\s*return t\.tailMs \+ t\.guardMs;\s*\}/.test(bs), "the send budget is no longer tail + guard only");
  assert.ok(live.includes("now + S > cutoff"), "eth/scripts/live.js no longer compares now + S > cutoff");
  const sh = fs.readFileSync(path.join(eth, "..", "..", "scripts", "live", "reveal.sh"), "utf8").split(/\r?\n/).filter((l) => !/^\s*#/.test(l));
  assert.ok(!sh.some((l) => l.includes("--margin")), "scripts/live/reveal.sh passes a --margin");
  // and the console's row is built from exactly those two numbers
  const v = view("alice", aliceReveal({ intent: revealIntent(NOW + 2500, NOW + 2900) }));
  assert.equal(row(v, "reveal_start_by").target, NOW + 3000 - 1800 - 30 - 60);
});

// ---------------------------------------------------------------- the row reveal_start_by
test("reveal_start_by: min(frozen cutoff, T_reveal - 30 min) less the 30 s send budget", () => {
  const same = view("alice", aliceReveal());
  const r = row(same, "reveal_start_by");
  assert.equal(r.source, "sender-rule");
  assert.equal(r.label, "Last moment to start the reveal");
  assert.equal(r.target, NOW + 1110);
  assert.equal(r.seconds_left, 1110);
  // a cutoff later than T_reveal - 30 min: the margin rule wins; earlier: the frozen cutoff wins
  assert.equal(row(view("alice", aliceReveal({ intent: revealIntent(NOW + 2500) })), "reveal_start_by").target, NOW + 1110);
  assert.equal(row(view("alice", aliceReveal({ intent: revealIntent(NOW + 600) })), "reveal_start_by").target, NOW + 510);
  // the row sits before reveal_cutoff, which stays as it was
  const ids = same.deadlines.map((d) => d.id);
  assert.ok(ids.indexOf("reveal_start_by") < ids.indexOf("reveal_cutoff"));
  assert.equal(row(same, "reveal_cutoff").target, NOW + 1200);
});

test("reveal_start_by: no row without a frozen cutoff or without T_reveal; relevant and met like reveal_cutoff", () => {
  assert.equal(row(view("alice", aliceReveal({ intent: { status: "none", intent: null } })), "reveal_start_by"), undefined);
  assert.equal(row(view("alice", mkTick({ phase: "funding_final", action: { action: "wait", reason: "x" } })), "reveal_start_by"), undefined);
  const claimed = view("alice", mkTick({ phase: "revealed", lock: mkLock({ timelock: NOW + 3000, claimed: true }), action: { action: "wait", reason: "x" }, intent: revealIntent(NOW + 1200) }));
  assert.equal(row(claimed, "reveal_start_by").state, row(claimed, "reveal_cutoff").state);
  const sent = view("alice", mkTick({ phase: "reveal_submitted", lock: mkLock({ timelock: NOW + 3000 }), action: { action: "wait", reason: "x" }, intent: revealIntent(NOW + 1200) }));
  assert.equal(row(sent, "reveal_start_by").state, "met");
});

test("reveal_start_by: counted against the later of the wall clock and the chain clock", () => {
  const behind = view("alice", aliceReveal({ tick: { ethTime: NOW - 500 } })); // chain time well behind: the wall clock counts
  assert.equal(row(behind, "reveal_start_by").seconds_left, 1110);
  const ahead = view("alice", aliceReveal({ tick: { ethTime: NOW + 96 } })); // chain time ahead by 100 s (96 + the 4 s since it was seen)
  assert.equal(row(ahead, "reveal_start_by").seconds_left, 1010);
  for (const v of [behind, ahead]) {
    const r = row(v, "reveal_start_by");
    assert.ok(r.seconds_left <= Math.min(NOW + 1200, NOW + 3000 - 1800) - 30 - 60 - Math.max(NOW, v.header.eth.time));
    assert.equal(v.clock.seconds_left, r.seconds_left);
  }
  // no chain time at all: the wall clock alone
  const none = view("alice", aliceReveal({ tick: { eth: { latest_timestamp: null } } }));
  assert.equal(row(none, "reveal_start_by").seconds_left, 1110);
});

// ---------------------------------------------------------------- the clock
test("clock: a reveal is clocked to the last moment to start it, never to a cutoff", () => {
  const v = view("alice", aliceReveal());
  const r = row(v, "reveal_start_by");
  assert.deepEqual(v.clock, { row_id: "reveal_start_by", label: r.label, seconds_left: 1110, approx: false, window_s: 4200, over: false, unit: "time", blocks_left: null });
  for (const o of [aliceReveal({ intent: revealIntent(NOW + 600) }), aliceReveal({ intent: revealIntent(NOW + 2500, NOW + 2900) })]) {
    const c = view("alice", o).clock;
    assert.equal(c.row_id, "reveal_start_by");
    assert.notEqual(c.row_id, "reveal_cutoff");
    assert.notEqual(c.row_id, "reveal_resend_cutoff");
  }
});

test("clock: a reveal with only the profile-table estimate has no clock", () => {
  const v = view("alice", aliceReveal({ intent: { status: "none", intent: null } }));
  assert.equal(row(v, "reveal_cutoff").source, "profile-table");
  assert.equal(v.clock, null);
});

test("clock: a claim is clocked in blocks, to the claim target", () => {
  const v = view("bob", bobClaim());
  const r = row(v, "claim_target");
  assert.equal(r.state, "far");
  assert.equal(v.clock.row_id, "claim_target");
  assert.equal(v.clock.unit, "blocks");
  assert.equal(v.clock.blocks_left, r.blocks_left);
  assert.equal(v.clock.seconds_left, r.seconds_left);
  assert.equal(v.clock.approx, true);
  assert.equal(v.clock.window_s, null);
  assert.equal(v.clock.over, false);
  // past the target: zero blocks, over
  const late = view("bob", bobClaim({ tip: D - 10 }));
  assert.equal(row(late, "claim_target").state, "passed");
  assert.equal(late.clock.over, true);
  assert.equal(late.clock.blocks_left, 0);
  assert.equal(late.clock.seconds_left, 0);
});

test("clock: no other step has one (lock, refund, fund, wait)", () => {
  const lock = view("bob", mkTick({ phase: "funding_final", action: { action: "lock_eth", reason: "x" } }));
  const refund = view("bob", mkTick({ phase: "locked", lock: mkLock({ timelock: NOW - 50 }), action: { action: "refund_eth", reason: "x" } }));
  const fund = view("alice", mkTick({ phase: "created", action: { action: "fund_noid", reason: "x" } }));
  const wait = view("alice", mkTick({ phase: "funding_final", action: { action: "wait", reason: "x" } }));
  for (const v of [lock, refund, fund, wait]) assert.equal(v.clock, null);
});

test("clock: a stale tick has none, and neither has a row that is met, not relevant or unknown", () => {
  assert.equal(view("alice", aliceReveal({ tick: { now: NOW - 1000, noidObservedAt: NOW - 1000, ethObservedAt: NOW - 1000 } })).clock, null);
  const done = view("alice", mkTick({ phase: "revealed", lock: mkLock({ timelock: NOW + 3000, claimed: true }), action: { action: "reveal_eth", reason: "x" }, intent: revealIntent(NOW + 1200) }));
  assert.ok(["na", "met"].includes(row(done, "reveal_start_by").state));
  assert.equal(done.clock, null);
  assert.equal(view("alice", null).clock, null);
  assert.equal(view("alice", aliceReveal({ tick: { now: NOW - 5000 } })).clock, null);
});

test("clock: past the last moment to start the reveal the clock is over, at zero, and the picture has no band", () => {
  const v = view("alice", aliceReveal({ intent: revealIntent(NOW - 100, NOW + 500) }));
  assert.equal(row(v, "reveal_start_by").state, "passed");
  assert.equal(v.clock.over, true);
  assert.equal(v.clock.seconds_left, 0);
  assert.equal(v.clock.row_id, "reveal_start_by");
  assert.equal(v.picture.band, null);
});

test("clock: a held reveal the tick still offers has the clock (and no picture); one it does not offer has neither clock nor band", () => {
  const offered = view("alice", F.spendTick("reveal_eth", { held: true }));
  assert.equal(offered.action.kind, "wait"); // a held intent prints as wait: the offer is the command kind
  assert.equal(offered.action.command_kind, "reveal_eth");
  assert.equal(offered.clock.row_id, "reveal_start_by");
  assert.equal(offered.picture, null); // a held reveal: the secret may already be public
  const notOffered = view("alice", F.spendTick("reveal_eth", { held: true, fresh: "wait", cutoffPassed: true, notes: ["not revealing: (I2) reveal cutoff passed"] }));
  assert.ok(notOffered.action.held_not_offered);
  assert.equal(notOffered.clock, null);
  assert.equal(notOffered.picture, null);
});

// ---------------------------------------------------------------- the picture
test("picture: null with no phase, on a terminal phase, aborted, dead data, no future row, an unknown phase, and on the refund path", () => {
  assert.equal(view("alice", null).picture, null);
  assert.equal(view("alice", mkTick({ phase: "refunded" })).picture, null);
  assert.equal(view("alice", mkTick({ phase: "lost" })).picture, null);
  assert.equal(view("alice", mkTick({ phase: "aborted" })).picture, null);
  assert.equal(view("bob", mkTick({ phase: "aborted" })).picture, null);
  assert.equal(view("alice", mkTick({ phase: "funding_final", now: NOW - 5000 })).picture, null); // dead: every row unknown
  assert.equal(view("alice", mkTick({ phase: "funding_final", tip: D + 10 })).picture, null); // D is past: no positive row
  for (const ph of ["refund_submitted", "refund_mined", "refunded"]) assert.equal(view("bob", mkTick({ phase: ph, lock: mkLock({ timelock: NOW - 5 }) })).picture, null);
  for (const ph of ["refund_submitted", "refund_included"]) assert.equal(view("alice", mkTick({ phase: ph })).picture, null);
  const weird = view("alice", mkTick({ phase: "not_a_phase" }));
  assert.equal(weird.phase.known, false);
  assert.equal(weird.picture, null);
  const rows = [{ id: "d", state: "far", seconds_left: 600 }];
  assert.equal(V.pictureFor(rows, { role: "alice", phase: { id: "funding_final", known: false, terminal: false }, clock: null }), null);
});

test("picture: span above seven days gives none", () => {
  const rows = (s) => [{ id: "d", state: "far", seconds_left: s, kind: "height" }];
  const ctx = { role: "alice", phase: { id: "funding_final", known: true, terminal: false }, clock: null };
  assert.equal(V.pictureFor(rows(8 * 86400), ctx), null);
  assert.equal(V.pictureFor(rows(6 * 86400), ctx).span_s, 6 * 86400);
});

test("picture: marks only for far or closing rows with positive seconds; every position is a row's seconds_left", () => {
  const v = view("alice", aliceReveal());
  const p = v.picture;
  assert.deepEqual(p.marks.map((m) => m.row_id), ["reveal_start_by", "reveal_cutoff", "reveal_resend_cutoff", "t_reveal", "d"]);
  assert.equal(p.marks[0].short, "Start the reveal by");
  for (const m of p.marks) {
    const r = row(v, m.row_id);
    assert.ok(["far", "closing"].includes(r.state));
    assert.ok(m.at_s > 0);
    assert.equal(m.at_s, r.seconds_left);
    assert.equal(m.estimate, false);
  }
  assert.equal(p.span_s, Math.max(...p.marks.map((m) => m.at_s)));
  assert.equal(p.span_s, row(v, "d").seconds_left);
  for (const t of p.tracks) if (t.end_s !== null) assert.ok(p.marks.some((m) => m.at_s === t.end_s));
  assert.equal(p.tracks[0].end_s, row(v, "d").seconds_left);
  assert.equal(p.tracks[1].end_s, row(v, "t_reveal").seconds_left);
  assert.equal(p.stale, false);
  assert.deepEqual(p.marks.map((m) => m.at_s), p.marks.map((m) => m.at_s).slice().sort((a, b) => a - b));
  const late = view("alice", aliceReveal({ intent: revealIntent(NOW - 100, NOW + 500) }));
  assert.ok(!late.picture.marks.some((m) => m.row_id === "reveal_start_by" || m.row_id === "reveal_cutoff"));
  assert.ok(late.picture.marks.some((m) => m.row_id === "reveal_resend_cutoff"));
});

test("picture: a mark from the profile table is flagged as an estimate", () => {
  const v = view("alice", aliceReveal({ intent: { status: "none", intent: null } }));
  const m = v.picture.marks.find((x) => x.row_id === "reveal_cutoff");
  assert.equal(m.estimate, true);
  assert.equal(m.at_s, row(v, "reveal_cutoff").seconds_left);
  assert.equal(v.picture.marks.find((x) => x.row_id === "d").estimate, false);
});

test("picture: the band exists only with a clock and ends at the clock's row", () => {
  const withClock = view("alice", aliceReveal());
  assert.deepEqual(withClock.picture.band, { to_s: withClock.clock.seconds_left });
  assert.equal(withClock.picture.band.to_s, row(withClock, "reveal_start_by").seconds_left);
  const noClock = view("alice", mkTick({ phase: "funding_final", action: { action: "wait", reason: "x" } }));
  assert.equal(noClock.clock, null);
  assert.equal(noClock.picture.band, null);
  const claim = view("bob", bobClaim());
  assert.equal(claim.picture.band.to_s, row(claim, "claim_target").seconds_left);
});

// the table of track states by the engine's phase id: [Parano1d, Ethereum]
const TABLE = {
  alice: { created: ["none", "none"], funding_submitted: ["sent", "none"], funded: ["pending", "none"], funding_final: ["final", "none"], lock_seen: ["final", "pending"], lock_final: ["final", "final"], reveal_submitted: ["secret_public", "secret_public"], revealed: ["secret_public", "closing"], done: ["secret_public", "closed"] },
  bob: { received: ["none", "none"], funded: ["pending", "none"], funding_final: ["final", "none"], lock_submitted: ["final", "sent"], locked: ["final", "pending"], secret_seen: ["final", "secret_public"], claim_submitted: ["final", "secret_public"], claim_included: ["closing", "secret_public"], done: ["closed", "closed"] },
};
const ALL_ROWS = [
  { id: "reveal_start_by", state: "far", seconds_left: 100 },
  { id: "t_reveal", state: "far", seconds_left: 600 },
  { id: "reveal_cutoff", state: "far", seconds_left: 300, source: "intent" },
  { id: "claim_target", state: "far", seconds_left: 3000 },
  { id: "d", state: "far", seconds_left: 4000 },
];

test("picture: the track states of every phase of both roles, from the phase id", () => {
  for (const role of ["alice", "bob"]) {
    for (const [phase, want] of Object.entries(TABLE[role])) {
      const p = V.pictureFor(ALL_ROWS, { role, phase: { id: phase, known: true, terminal: false }, clock: null });
      assert.deepEqual(p.tracks.map((t) => t.state), want, `${role} ${phase}`);
      // a track whose lock is claimable, being closed or closed has no end and its end row is not drawn
      const endless = ["secret_public", "closing", "closed"];
      assert.equal(p.tracks[0].end_s === null, endless.includes(want[0]) || false, `${role} ${phase} noid end`);
      assert.equal(p.tracks[1].end_s === null, endless.includes(want[1]), `${role} ${phase} eth end`);
      assert.equal(p.marks.some((m) => m.row_id === "d"), !endless.includes(want[0]), `${role} ${phase} d mark`);
      assert.equal(p.marks.some((m) => m.row_id === "t_reveal"), !endless.includes(want[1]), `${role} ${phase} t_reveal mark`);
    }
  }
  // any phase that is not in the table has no picture
  for (const [role, ph] of [["alice", "lost"], ["alice", "aborted"], ["alice", "refund_submitted"], ["alice", "refunded"], ["bob", "refund_mined"], ["bob", "aborted"], ["bob", "nonsense"]]) {
    assert.equal(V.pictureFor(ALL_ROWS, { role, phase: { id: ph, known: true, terminal: false }, clock: null }), null, `${role} ${ph}`);
  }
});

test("picture: tracks of real views (Alice before and after the reveal, Bob with the secret public)", () => {
  const lock = mkLock({ timelock: NOW + 3000 });
  const states = (role, tick) => view(role, tick).picture.tracks.map((t) => t.state);
  assert.deepEqual(states("alice", mkTick({ phase: "funding_final", tip: D - 302 })), ["final", "none"]);
  assert.deepEqual(states("alice", mkTick({ phase: "lock_seen", lock })), ["final", "pending"]);
  const sent = view("alice", mkTick({ phase: "reveal_submitted", lock, intent: revealIntent(NOW + 1200, NOW + 2000), action: { action: "wait", reason: "x" } }));
  assert.deepEqual(sent.picture.tracks.map((t) => t.state), ["secret_public", "secret_public"]);
  assert.ok(!sent.picture.marks.some((m) => m.row_id === "d" || m.row_id === "t_reveal" || m.row_id === "reveal_cutoff" || m.row_id === "reveal_start_by"));
  assert.ok(sent.picture.marks.some((m) => m.row_id === "reveal_resend_cutoff"), "the re-send cutoff is still drawn for Alice");
  const claimed = view("bob", mkTick({ phase: "secret_seen", tip: D - 100, lock: mkLock({ timelock: NOW + 3000, claimed: true }), eth: { claimed: { preimage: "0x1" } }, action: { action: "claim_noid", reason: "x", call_height: 1 } }));
  assert.deepEqual(claimed.picture.tracks.map((t) => t.state), ["final", "secret_public"]);
  assert.ok(!claimed.picture.marks.some((m) => m.row_id === "t_reveal" || m.row_id === "reveal_cutoff" || m.row_id === "reveal_start_by"), "no deadline of a first reveal once the secret is public");
  assert.ok(claimed.picture.marks.some((m) => m.row_id === "claim_target"));
  assert.ok(claimed.picture.tracks.every((t) => t.state !== "secret_public" || t.end_s === null));
});

test("picture: a finished swap has none", () => {
  const finished = view("alice", mkTick({ phase: "done", lock: mkLock({ timelock: NOW + 3000, claimed: true }), eth: { claimed: { preimage: "0x1" } }, instance: null }));
  assert.equal(finished.picture, null);
});

test("picture: stale rows are drawn without the band and flagged", () => {
  const v = view("alice", aliceReveal({ tick: { now: NOW - 300, noidObservedAt: NOW - 300, ethObservedAt: NOW - 300 } }));
  assert.ok(v.deadlines_stale);
  assert.equal(v.picture.stale, true);
  assert.equal(v.picture.band, null);
  assert.ok(v.picture.marks.length > 0);
});

test("clockFor is a pure function of the rows (no tick text)", () => {
  const rows = [{ id: "reveal_start_by", kind: "time", label: "x", seconds_left: 90, state: "closing", source: "sender-rule", stale: false, approx: false, window_s: 600 }];
  assert.deepEqual(V.clockFor(rows, "reveal_eth"), { row_id: "reveal_start_by", label: "x", seconds_left: 90, approx: false, window_s: 600, over: false, unit: "time", blocks_left: null });
  assert.equal(V.clockFor(rows, "wait"), null);
  assert.equal(V.clockFor([{ ...rows[0], id: "reveal_cutoff", source: "intent" }], "reveal_eth"), null);
  assert.equal(V.clockFor([{ ...rows[0], source: "profile-table" }], "reveal_eth"), null);
  assert.equal(V.clockFor([{ ...rows[0], stale: true }], "reveal_eth"), null);
  assert.equal(V.clockFor([{ ...rows[0], no_countdown: true }], "reveal_eth"), null);
  assert.equal(V.clockFor([{ ...rows[0], seconds_left: null }], "reveal_eth"), null);
  for (const state of ["na", "met", "unknown", "info"]) assert.equal(V.clockFor([{ ...rows[0], state }], "reveal_eth"), null);
});

test("picture: none while Alice's secret may already be public, whatever the phase says (each signal alone)", () => {
  const lock = mkLock({ timelock: NOW + 3000 });
  const base = (o = {}) => mkTick({ phase: "lock_final", lock, action: { action: "wait", reason: "x" }, intent: revealIntent(NOW + 1200, NOW + 2000), ...o });
  assert.ok(view("alice", base()).picture, "a recorded reveal intent alone does not remove the picture");
  assert.ok(view("alice", base()).picture.band === null || view("alice", base()).picture.band.to_s > 0);
  assert.equal(view("alice", base({ eth: { pending_preimage: "0x" + "5e".repeat(32) } })).picture, null);
  assert.equal(view("alice", base({ eth: { claimed: { preimage: "0x1" } } })).picture, null);
  assert.equal(view("alice", base({ lock: mkLock({ timelock: NOW + 3000, claimed: true }) })).picture, null);
  assert.equal(view("alice", base({ intent: { status: "held", intent: { action: "reveal_eth", decided_at: NOW - 10, params: { cutoff: NOW + 1200 } } } })).picture, null);
  // the same signals do not touch Bob's picture, or Alice's earlier phases
  assert.ok(view("bob", bobClaim({ eth: { pending_preimage: "0x1" } })).picture);
  assert.ok(view("alice", mkTick({ phase: "funding_final", eth: { pending_preimage: "0x1" } })).picture);
});

test("picture: a recorded reveal in lock_final has the picture with its band", () => {
  const v = view("alice", aliceReveal());
  assert.deepEqual(v.picture.band, { to_s: v.clock.seconds_left });
});
