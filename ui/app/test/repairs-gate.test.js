"use strict";
// The repairs of 2026-11-16 in the gate: the held rule (a step the engine does not offer now is not offered), the alarm rule (an ALARM does not
// refuse the steps that only return coins to their owner), the ALERT rule.
const test = require("node:test");
const assert = require("node:assert/strict");
const { SPENDS, evaluateSpend, relevantFor, TICK_FRESH_S, ALARM_TOLERATED, ALARM_REFUSES, ALERT_REFUSES } = require("../lib/gate");
const { checkDryRun } = require("../lib/dryrun");
const { expectedAmount } = require("../lib/gate");
const F = require("./actions-fixtures");

const NOW_MS = F.NOW * 1000;
const DRY_OBJ = { fund_noid: F.fundDry, lock_eth: F.lockDry, reveal_eth: F.revealDry, refund_eth: F.refundDry, claim_noid: F.claimDry };
const TX = "0x" + "ab".repeat(32);

function good(spend, o = {}) {
  const evidenceEth = spend.replace && spend.kind === "reveal_eth" ? { pending_preimage: { lock_id: F.LOCK_ID, tx_hash: TX } } : undefined;
  const tick = o.tick || F.spendTick(spend.kind, { held: spend.replace || o.held, eth: evidenceEth });
  const run = F.runWith(spend.role, tick, o.runOpts);
  const raw = DRY_OBJ[spend.kind](spend.replace ? { replace: true, replacesTx: TX } : {});
  const text = typeof raw === "string" ? raw : JSON.stringify(raw);
  const check = checkDryRun(spend.kind, text, { terms: run.terms, tick, now: F.NOW, replace: spend.replace, replaceTx: spend.replace ? TX : null, objectSha: F.FUND_SHA, objectPath: F.FUND_OBJ_WIN, walletDefault: F.FUND_CLI, distro: "Ubuntu-24.04" });
  const dry = { spend: spend.id, command: "CMD", finished_ms: NOW_MS - 10 * 1000, ok: true, result: "ok", check };
  return { run, nowMs: NOW_MS, dry, expectedDryCommand: "CMD", typed: expectedAmount(spend, F.TERMS).text, requireTyped: true, latch: null, statement: true, bobCheck: true, sentHash: spend.replace && spend.kind === "refund_eth" ? TX : null };
}
const codes = (r) => r.reasons.map((x) => x.code);

test("a HELD intent is offered only when the engine's own fresh decision of the same tick was that step; otherwise the engine's reason leads and nothing is offered", () => {
  for (const id of ["send-lock", "send-reveal", "send-refund-eth", "send-fund"]) {
    const spend = SPENDS[id];
    const fresh = F.spendTick(spend.kind, { held: true });
    assert.ok(fresh.notes.includes(`held: fresh decision was ${spend.kind}`), "the fixture prints the engine's note");
    assert.equal(relevantFor(spend, fresh, null), true, `${id}: held and the fresh decision was the step`);
    assert.deepEqual(codes(evaluateSpend(spend, good(spend, { tick: fresh }))), [], id);
    // the fresh decision was a wait (the engine does not offer the step now), or another step
    for (const f of ["wait", "refund_noid"]) {
      const t = F.spendTick(spend.kind, { held: true, fresh: f });
      assert.equal(relevantFor(spend, t, null), false, `${id}: held, fresh decision ${f}`);
      const r = evaluateSpend(spend, good(spend, { tick: t }));
      assert.equal(r.ok, false, id);
      assert.ok(codes(r).includes("engine_not_offering"), `${id}: ${codes(r)}`);
      assert.match(r.reasons.find((x) => x.code === "engine_not_offering").text, /does not offer it now/);
    }
    // a held tick that does not state the fresh decision at all offers nothing
    const none = F.spendTick(spend.kind, { held: true });
    none.notes = none.notes.filter((n) => !n.startsWith("held: fresh decision"));
    assert.equal(relevantFor(spend, none, null), false, `${id}: not stated`);
    assert.ok(codes(evaluateSpend(spend, good(spend, { tick: none }))).includes("engine_not_offering"), id);
    // a note that only RESEMBLES the engine's is not it
    const lookalike = F.spendTick(spend.kind, { held: true, fresh: "wait" });
    lookalike.notes.push(`note: held: fresh decision was ${spend.kind}`, `held: fresh decision was ${spend.kind} (not really)`);
    assert.equal(relevantFor(spend, lookalike, null), false, `${id}: only the engine's exact note counts`);
  }
});

test("a RECORDED intent (the printed action is the step) is offered without any note", () => {
  for (const id of ["send-lock", "send-reveal", "send-refund-eth", "send-fund"]) {
    const spend = SPENDS[id];
    const t = F.spendTick(spend.kind);
    assert.equal(t.intent.status, "recorded");
    assert.equal(relevantFor(spend, t, null), true, id);
    assert.deepEqual(codes(evaluateSpend(spend, good(spend, { tick: t }))), [], id);
  }
});

test("a held reveal whose cutoff has passed: no first send, no re-send, and the gate quotes the engine's reason", () => {
  const first = SPENDS["send-reveal"];
  const t = F.spendTick("reveal_eth", { held: true, fresh: "wait", cutoffPassed: true });
  assert.equal(t.action.action, "wait");
  assert.match(t.action.reason, /its reveal cutoff has passed, so the printed parameters are not to be used/);
  assert.equal(relevantFor(first, t, null), false);
  const r = evaluateSpend(first, good(first, { tick: t }));
  assert.ok(codes(r).includes("engine_not_offering"));
  assert.match(r.reasons.find((x) => x.code === "engine_not_offering").text, /printed parameters are not to be used/, "the engine's own reason is quoted");
  // the re-send: a pending claim and a held intent, but the engine says the cutoff has passed
  const pending = { pending_preimage: { tx_hash: TX } };
  const rs = SPENDS["send-reveal-replace"];
  const withClaim = F.spendTick("reveal_eth", { held: true, fresh: "wait", cutoffPassed: true, eth: pending });
  assert.equal(relevantFor(rs, withClaim, null), false);
  assert.ok(codes(evaluateSpend(rs, good(rs, { tick: withClaim }))).includes("engine_cutoff"));
  // without the cutoff sentence the re-send stays (the engine's fresh decision beside a pending claim is a wait, and the re-send is the step)
  const ok = F.spendTick("reveal_eth", { held: true, fresh: "wait", eth: pending });
  assert.equal(relevantFor(rs, ok, null), true);
  assert.deepEqual(codes(evaluateSpend(rs, good(rs, { tick: ok }))), []);
});

const ALARM_LATE_LOCK = "ALARM: this lock's T_reveal 1800000000 is 120 s beyond the engine's own bound 1799999880 (D 281514): if Alice reveals late, the NOID claim may not be final before D; claim the moment the secret is seen; do not make another lock (lock d1d1d1d1)";

test("an ALARM note (the engine prints one on every tick while a late lock is open) refuses fund, lock, reveal and claim, but not the ETH refund or its re-send", () => {
  assert.deepEqual([...ALARM_REFUSES].sort(), ["claim_noid", "fund_noid", "lock_eth", "reveal_eth"]);
  assert.deepEqual([...ALARM_TOLERATED].sort(), ["refund_eth", "refund_noid"]);
  for (const spend of Object.values(SPENDS)) {
    const c = good(spend);
    c.run.roles[spend.role].tick.notes.push(ALARM_LATE_LOCK);
    const r = evaluateSpend(spend, c);
    if (ALARM_TOLERATED.has(spend.kind)) {
      assert.deepEqual(codes(r), [], `${spend.id}: the alarm does not refuse a refund`);
      assert.equal(r.ok, true, spend.id);
      assert.deepEqual(r.notices, [{ code: "engine_alarm", text: ALARM_LATE_LOCK }], `${spend.id}: the whole alarm text goes to the page, beside the send box`);
    } else {
      assert.equal(r.ok, false, spend.id);
      assert.ok(codes(r).includes("engine_alarm"), spend.id);
      assert.ok(r.reasons.find((x) => x.code === "engine_alarm").text.includes(ALARM_LATE_LOCK), `${spend.id}: the refusal quotes the whole alarm`);
    }
  }
  // every other gate stays for a refund: no dry run, a wrong amount, a stale tick, a latch, a tick that was not applied, a terminal phase
  const refund = SPENDS["send-refund-eth"];
  for (const [name, mutate, code] of [
    ["no dry run", (c) => (c.dry = null), "dry_missing"],
    ["typed", (c) => (c.typed = "1 ETH"), "typed"],
    ["stale", (c) => (c.run.roles.bob.tick_mtime = F.NOW - TICK_FRESH_S - 1), "tick_stale"],
    ["latched", (c) => (c.latch = { tickNow: 0, intentAt: F.INTENT_AT }), "latched"],
    ["not applied", (c) => (c.run.roles.bob.tick.events_applied_to_file = false), "tick_not_applied"],
    ["terminal", (c) => (c.run.roles.bob.tick.phase_after = "refunded"), "terminal_phase"],
  ]) {
    const c = good(refund);
    c.run.roles.bob.tick.action.reason = "ANOMALY: x";
    c.run.roles.bob.tick.notes.push(ALARM_LATE_LOCK);
    mutate(c);
    const r = evaluateSpend(refund, c);
    assert.equal(r.ok, false, name);
    assert.ok(codes(r).includes(code), `${name}: ${codes(r)}`);
  }
});

test("an ALERT: note additionally refuses the steps that put coins in or publish the secret, never the claim or a refund", () => {
  assert.deepEqual([...ALERT_REFUSES].sort(), ["fund_noid", "lock_eth", "reveal_eth"]);
  const ALERT = "ALERT: the producer screen refuses to lock now (T21: one address made 40 % of the recent blocks), but a lock_eth intent decided at 1799999980 (Unix time) is still pending.";
  for (const spend of Object.values(SPENDS)) {
    const c = good(spend);
    c.run.roles[spend.role].tick.notes.push(ALERT);
    const r = evaluateSpend(spend, c);
    if (ALERT_REFUSES.has(spend.kind)) assert.ok(codes(r).includes("engine_alert"), spend.id);
    else assert.ok(!codes(r).includes("engine_alert"), spend.id);
  }
});

test("the ALARM notice is attached only to an offered refund (the alarm does not hide the refund the engine offers)", () => {
  const refund = SPENDS["send-refund-eth"];
  const t = F.spendTick("refund_eth", { notes: [ALARM_LATE_LOCK] });
  assert.equal(relevantFor(refund, t, null), true);
  assert.deepEqual(evaluateSpend(refund, good(refund, { tick: t })).notices.map((n) => n.text), [ALARM_LATE_LOCK]);
});

test("a tick whose notes are not a list refuses every spend (its alarms cannot be read)", () => {
  for (const spend of Object.values(SPENDS)) {
    for (const bad of ["ALARM: something", { 0: "ALARM: something" }, 7]) {
      const c = good(spend);
      c.run.roles[spend.role].tick.notes = bad;
      const r = evaluateSpend(spend, c);
      assert.equal(r.ok, false, `${spend.id} / ${typeof bad}`);
      assert.ok(codes(r).includes("tick_malformed"), `${spend.id}: ${codes(r).join()}`);
    }
  }
});
