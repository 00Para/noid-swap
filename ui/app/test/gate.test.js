"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { SPENDS, evaluateSpend, describeSpend, relevantFor, typedMatches, expectedAmount, DRY_MAX_AGE_S, TICK_FRESH_S, ALARM_TOLERATED, ALARM_REFUSES, ALERT_REFUSES } = require("../lib/gate");
const { checkDryRun } = require("../lib/dryrun");
const F = require("./actions-fixtures");

const NOW_MS = F.NOW * 1000;
const DRY_OBJ = { fund_noid: F.fundDry, lock_eth: F.lockDry, reveal_eth: F.revealDry, refund_eth: F.refundDry, claim_noid: F.claimDry };
const TX = "0x" + "ab".repeat(32);
const IS_LEDGER = (spend) => spend.kind !== "claim_noid";

/** A context in which `spend` is allowed; each test then breaks exactly one thing. */
function good(spend, o = {}) {
  const evidenceEth = spend.replace && spend.kind === "reveal_eth" ? { pending_preimage: { lock_id: F.LOCK_ID, tx_hash: TX } } : undefined;
  const tick = o.tick || F.spendTick(spend.kind, { held: spend.replace || o.held, eth: evidenceEth });
  const run = F.runWith(spend.role, tick, o.runOpts);
  const raw = (o.dryObj || DRY_OBJ[spend.kind])(spend.replace ? { replace: true, replacesTx: TX } : {});
  const text = typeof raw === "string" ? raw : JSON.stringify(raw); // fund.sh --dry-run prints text
  const check = checkDryRun(spend.kind, text, { terms: run.terms, tick, now: F.NOW, replace: spend.replace, replaceTx: spend.replace ? TX : null, objectSha: F.FUND_SHA, objectPath: F.FUND_OBJ_WIN, walletDefault: F.FUND_CLI, distro: "Ubuntu-24.04" });
  const dry = { spend: spend.id, command: "CMD", finished_ms: NOW_MS - 10 * 1000, ok: true, result: "ok", check, ...(o.dry || {}) };
  return { run, nowMs: NOW_MS, dry: o.noDry ? null : dry, expectedDryCommand: "CMD", typed: o.typed === undefined ? expectedAmount(spend, F.TERMS).text : o.typed, requireTyped: true, latch: o.latch ?? null, statement: o.statement === undefined ? true : o.statement, bobCheck: o.bobCheck === undefined ? true : o.bobCheck, sentHash: spend.replace && spend.kind === "refund_eth" ? TX : null };
}
const codes = (r) => r.reasons.map((x) => x.code);

for (const spend of Object.values(SPENDS)) {
  test(`${spend.id}: allowed with every precondition met; refused when any ONE is missing`, () => {
    const ok = evaluateSpend(spend, good(spend));
    assert.deepEqual(codes(ok), [], JSON.stringify(ok.reasons));
    assert.equal(ok.ok, true);

    const T = (c) => c.run.roles[spend.role].tick;
    const breaks = {
      tick_missing: (c) => (c.run.roles[spend.role].tick = null),
      tick_not_applied: (c) => (T(c).events_applied_to_file = false),
      tick_stale: (c) => (c.run.roles[spend.role].tick_mtime = F.NOW - TICK_FRESH_S - 1),
      tick_stale_future: (c) => (c.run.roles[spend.role].tick_mtime = F.NOW + 60),
      tick_clock: (c) => (T(c).now = F.NOW - TICK_FRESH_S - 60),
      terminal_phase: (c) => (T(c).phase_after = "refunded"),
      dry_missing: (c) => (c.dry = null),
      dry_other: (c) => (c.dry = { ...c.dry, spend: "send-other" }),
      dry_command: (c) => (c.dry = { ...c.dry, command: "CMD --other-flags" }),
      dry_stale: (c) => (c.dry = { ...c.dry, finished_ms: NOW_MS - (DRY_MAX_AGE_S + 1) * 1000 }),
      dry_failed: (c) => (c.dry = { ...c.dry, ok: false, result: "exit 2" }),
      dry_unreadable: (c) => (c.dry = { ...c.dry, check: null }),
      dry_mismatch: (c) => (c.dry = { ...c.dry, check: { ...c.dry.check, all_ok: false } }),
      typed: (c) => (c.typed = "1 ETH"),
      latched: (c) => (c.latch = { tickNow: T(c).now, intentAt: null }),
      terms_missing: (c) => (c.run.terms = null),
    };
    // an engine ALARM refuses the steps that put coins in or publish the secret, and the claim; the two that only return coins are tested below
    if (!ALARM_TOLERATED.has(spend.kind)) breaks.engine_alarm = (c) => T(c).notes.push("ALARM: the Ethereum head is 20 min behind the clock");
    if (spend.replace) {
      breaks.intent_not_held = (c) => (T(c).intent = { status: "recorded", intent: T(c).intent.intent });
      if (spend.kind === "reveal_eth") breaks.no_pending_claim = (c) => (T(c).eth.pending_preimage = null);
      else breaks.no_pending_tx = (c) => (c.sentHash = null);
    } else if (IS_LEDGER(spend)) {
      breaks.engine_action = (c) => {
        T(c).action = { action: "wait", reason: "x" };
        T(c).intent = { status: "none", intent: null };
      };
      breaks.engine_action_other_kind = (c) => (T(c).intent = { status: "held", intent: { ...T(c).intent.intent, action: "refund_noid" } });
      breaks.latched_for_this_intent = (c) => (c.latch = { tickNow: 0, intentAt: F.INTENT_AT });
      breaks.already_sent = (c) => (c.sentHash = TX);
      if (spend.kind === "fund_noid") {
        breaks.statement = (c) => (c.statement = false);
        breaks.statement_bob_check = (c) => (c.bobCheck = false);
        breaks.amount_mismatch = (c) => {
          T(c).action.amount_micronoid = 1;
          T(c).intent.intent.params.amount_micronoid = 1;
        };
        breaks.already_sent_instance = (c) => (T(c).noid.instance = { slot_index: 7, creation_id: 3, amount_micronoid: F.TERMS.amount_micronoid });
        breaks.already_sent_phase = (c) => (T(c).phase_after = "funding_submitted");
      }
    } else {
      breaks.engine_action = (c) => (T(c).action = { action: "wait", reason: "x" });
      breaks.already_sent = (c) => (T(c).noid.pending_calls = [{ txid: "ab".repeat(32) }]);
    }
    for (const [name, mutate] of Object.entries(breaks)) {
      const c = good(spend);
      mutate(c);
      const r = evaluateSpend(spend, c);
      const code = { tick_stale_future: "tick_stale", latched_for_this_intent: "latched", engine_action_other_kind: "engine_action", already_sent_instance: "already_sent", already_sent_phase: "already_sent" }[name] || name;
      assert.equal(r.ok, false, `${spend.id}: must be refused when ${name}`);
      assert.ok(codes(r).includes(code), `${spend.id}: ${code} expected, got ${codes(r)}`);
    }
  });
}

test("a HELD first send (the engine turns a recorded intent into a held one on the next tick) is allowed once, until there is evidence", () => {
  const seenEth = { "send-lock": { lock: { lock_id: F.LOCK_ID } }, "send-reveal": { pending_preimage: { tx_hash: TX } }, "send-refund-eth": { refunded: { tx_hash: TX } } };
  for (const id of ["send-lock", "send-reveal", "send-refund-eth"]) {
    const spend = SPENDS[id];
    const held = good(spend, { held: true });
    assert.deepEqual(codes(evaluateSpend(spend, held)), [], id + " held, nothing seen");
    const heldTick = F.spendTick(spend.kind, { held: true });
    assert.ok(describeSpend(spend, F.TERMS, heldTick).lines.join(" ").includes("do not send it again"), "the dialog warns about a terminal send");
    const t = F.spendTick(spend.kind, { held: true, eth: seenEth[id] });
    assert.ok(codes(evaluateSpend(spend, good(spend, { tick: t }))).includes("already_sent"), id);
    assert.ok(codes(evaluateSpend(spend, { ...held, sentHash: TX })).includes("already_sent"), id + " (a sent: line)");
  }
});

test("the latch is per intent (a held first send cannot be started twice) and per tick (compared on the tick's own clock)", () => {
  const lock = SPENDS["send-lock"];
  const first = good(lock);
  assert.equal(evaluateSpend(lock, first).ok, true);
  const started = { tickNow: first.run.roles.bob.tick.now, intentAt: F.INTENT_AT };
  const next = good(lock, { held: true, latch: started });
  next.run.roles.bob.tick.now = F.NOW + 30;
  assert.ok(codes(evaluateSpend(lock, next)).includes("latched"), "a newer tick does not lift an intent latch");
  const claim = SPENDS["send-claim"];
  assert.ok(codes(evaluateSpend(claim, good(claim, { latch: { tickNow: F.NOW, intentAt: null } }))).includes("latched"), "the claim: same tick");
  assert.deepEqual(codes(evaluateSpend(claim, good(claim, { latch: { tickNow: F.NOW - 30, intentAt: null } }))), [], "the claim: a newer tick lifts it");
  const rv = SPENDS["send-reveal-replace"];
  assert.deepEqual(codes(evaluateSpend(rv, good(rv, { latch: { tickNow: F.NOW - 30, intentAt: F.INTENT_AT } }))), [], "a re-send is latched by tick only");
});

test("the wrong engine action is refused for each spend: a tick that names another step does not unlock this one", () => {
  const lock = SPENDS["send-lock"];
  const r = evaluateSpend(lock, { ...good(lock), run: F.runWith("bob", F.spendTick("reveal_eth")) });
  assert.ok(codes(r).includes("engine_action"));
  const alice = good(SPENDS["send-reveal"]);
  const swapped = { ...alice, run: { terms: F.TERMS, roles: { alice: null, bob: alice.run.roles.alice } } };
  assert.ok(codes(evaluateSpend(SPENDS["send-reveal"], swapped)).includes("tick_missing"));
  const t = F.spendTick("lock_eth");
  t.action = { kind: "lock_eth", parameters: "withheld" };
  t.intent = { status: "none", intent: null };
  t.events_applied_to_file = false;
  const w = evaluateSpend(lock, good(lock, { tick: t }));
  assert.equal(w.ok, false);
  assert.ok(codes(w).includes("engine_action") && codes(w).includes("tick_not_applied"), "a read-only tick that withholds the parameters never unlocks a spend");
  const claim = SPENDS["send-claim"];
  const ct = F.spendTick("claim_noid");
  assert.equal(ct.intent.status, "none", "a real claim tick has no intent");
  assert.deepEqual(codes(evaluateSpend(claim, good(claim, { tick: ct }))), []);
});

test("relevantFor: the page offers a spend only for the tick shapes the engine really prints", () => {
  const R = (id, tick, sent) => relevantFor(SPENDS[id], tick, sent);
  assert.equal(R("send-lock", F.spendTick("lock_eth")), true);
  assert.equal(R("send-lock", F.spendTick("lock_eth", { held: true })), true, "held, nothing seen");
  assert.equal(R("send-lock", F.spendTick("lock_eth", { held: true }), TX), false, "a sent: line");
  assert.equal(R("send-lock", F.spendTick("reveal_eth")), false);
  assert.equal(R("send-claim", F.spendTick("claim_noid")), true);
  const pending = { pending_preimage: { tx_hash: TX } };
  assert.equal(R("send-reveal", F.spendTick("reveal_eth", { held: true, eth: pending })), false, "pending claim: the re-send is the one offered");
  assert.equal(R("send-reveal-replace", F.spendTick("reveal_eth", { held: true, eth: pending })), true);
  assert.equal(R("send-reveal-replace", F.spendTick("reveal_eth")), false, "recorded: nothing to replace");
  assert.equal(R("send-refund-eth-replace", F.spendTick("refund_eth", { held: true }), TX), true);
  assert.equal(R("send-refund-eth-replace", F.spendTick("refund_eth", { held: true }), null), false);
  assert.equal(R("send-lock", null), false);
});

test("typed confirmation: the amount and the unit of what moves, nothing looser", () => {
  const eth = SPENDS["send-lock"];
  const noid = SPENDS["send-claim"];
  assert.equal(expectedAmount(eth, F.TERMS).text, "0.001 ETH");
  assert.equal(expectedAmount(noid, F.TERMS).text, "10 NOID");
  for (const t of ["0.001 ETH", "0.001 eth", " 0.0010 ETH ", "0.001ETH", "0.001000000000000000 Eth"]) assert.equal(typedMatches(eth, F.TERMS, t), true, t);
  for (const t of ["0.002 ETH", "0.001", "ETH", "0.001 NOID", "0.001 WEI", "1 ETH", "0,001 ETH", "0.001 ETH; id", "", null, undefined, 5, "0.0010000000000000001 ETH", "-0.001 ETH", "1e-3 ETH"]) assert.equal(typedMatches(eth, F.TERMS, t), false, String(t));
  for (const t of ["10 NOID", "10.000000 noid", "010 NOID"]) assert.equal(typedMatches(noid, F.TERMS, t), true, t);
  for (const t of ["10 ETH", "9.9942 NOID", "100 NOID", "10"]) assert.equal(typedMatches(noid, F.TERMS, t), false, t);
  assert.equal(typedMatches(eth, { ...F.TERMS, eth: { ...F.TERMS.eth, amount_wei: null } }, "0.001 ETH"), false, "no amount in the terms: nothing to confirm");
  assert.equal(typedMatches(eth, F.TERMS, "99999999999999999999999 ETH"), false);
});

test("the plain-words text is built from the terms and names what moves, to whom, and the risk", () => {
  const lock = describeSpend(SPENDS["send-lock"], F.TERMS, F.spendTick("lock_eth"));
  assert.match(lock.title, /Lock 0\.001 ETH/);
  const text = lock.lines.join(" ");
  assert.ok(text.includes(F.E.bob_sender) && text.includes(F.E.contract) && text.includes(F.E.alice_receiver));
  assert.match(text, /T_reveal/);
  assert.equal(lock.expected_typed, "0.001 ETH");
  assert.ok(lock.next.length > 20);
  assert.match(describeSpend(SPENDS["send-reveal"], F.TERMS, F.spendTick("reveal_eth")).lines.join(" "), /PUBLISHES THE SECRET/);
  assert.match(describeSpend(SPENDS["send-claim"], F.TERMS, F.spendTick("claim_noid")).lines.join(" "), new RegExp(F.TERMS.bob_noid));
  assert.match(describeSpend(SPENDS["send-refund-eth"], F.TERMS, F.spendTick("refund_eth")).lines.join(" "), /after T_reveal/i);
  assert.match(describeSpend(SPENDS["send-reveal-replace"], F.TERMS, F.spendTick("reveal_eth", { held: true })).title, /Re-send/);
});

test("no spend id can be reached through a prototype key", () => {
  assert.equal(Object.keys(SPENDS).length, 7);
  for (const s of Object.values(SPENDS)) assert.ok(/^send-/.test(s.id) && /^dry-/.test(s.dry));
});

test("send-fund: the plain-words statement names the amount, the contract and the once-only rule; the typed text is NOID", () => {
  const spend = SPENDS["send-fund"];
  assert.equal(spend.unit, "NOID");
  assert.equal(spend.role, "alice");
  const d = describeSpend(spend, F.TERMS, F.spendTick("fund_noid"));
  assert.match(d.title, /^Fund 10 NOID$/);
  assert.match(d.lines.join(" "), /EXACTLY ONCE/);
  assert.match(d.lines.join(" "), new RegExp(F.TERMS.contract_root));
  assert.equal(d.expected_typed, "10 NOID");
  assert.equal(typedMatches(spend, F.TERMS, "10 NOID"), true);
  assert.equal(typedMatches(spend, F.TERMS, "10.0 noid"), true);
  for (const t of ["10", "10 ETH", "1 NOID", "10 NOID; id", ""]) assert.equal(typedMatches(spend, F.TERMS, t), false, t);
  assert.match(d.next, /never fund a second time/i);
});

test("send-fund: offered only for a recorded or held fund_noid intent, never when funded.marker, an instance or a later phase shows it was sent", () => {
  const spend = SPENDS["send-fund"];
  assert.equal(relevantFor(spend, F.spendTick("fund_noid"), null), true, "recorded");
  assert.equal(relevantFor(spend, F.spendTick("fund_noid", { held: true }), null), true, "held");
  assert.equal(relevantFor(spend, F.spendTick("fund_noid"), "2026-11-06T11:46:09Z"), false, "funded.marker exists");
  assert.equal(relevantFor(spend, F.spendTick("lock_eth"), null), false, "another step");
  const r = evaluateSpend(spend, { ...good(spend), sentHash: "2026-11-06T11:46:09Z" });
  assert.ok(codes(r).includes("already_sent"));
  assert.match(r.reasons.find((x) => x.code === "already_sent").text, /funding is already done or acknowledged: 2026-11-06T11:46:09Z/);
});
