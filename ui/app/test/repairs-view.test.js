"use strict";
// The repairs of 2026-11-16 in the view model: an aborted file with coins at the contract, a held step the engine does not offer, the engine's loud
// notes, the reveal cutoff from the intent, the lock-by note, the producer figures, production read-only, the leftover leg.
const test = require("node:test");
const assert = require("node:assert/strict");
const V = require("../lib/viewmodel");
const P = require("../lib/phases");
const F = require("./actions-fixtures");
const { NOW, D, TERMS, mkTick, mkLock, input } = require("./helpers");

const view = (role, tick, extra) => V.buildView(input(role, tick, extra));
const row = (v, id) => v.deadlines.find((d) => d.id === id);

// the engine's abandoned-instances note (engine.rs alice_abandoned_instances_note) for the run-16 shape: a 4 NOID instance where 5 was agreed
const RUN16_NOTE = "1 instance hold NOID at the contract root: slot 7 (creation 3, 4,000,000 micro-NOID). None fits the agreement, so none is this swap's funding; scripts/live/recover-noid.sh closes the instances of the agreed amount; an instance not larger than the close fee (at least 5,800 micro-NOID, more under load) cannot be recovered. This tool will not close it.";
const RUN16_REASON = "aborted: too late to fund: tip 281400 + 24 > lock-by 281262";
const ABSURD = /Nothing is at risk|Nothing is on chain|nothing can be lost|nothing is funded/i;

function aborted(role, o = {}) {
  return view(role, mkTick({ phase: "aborted", tip: D - 100, instance: o.instance === undefined ? { slot_index: 7, creation_id: 3, amount_micronoid: 4000000 } : o.instance, noid: o.noid, action: { action: "wait", reason: RUN16_REASON }, notes: o.notes === undefined ? [RUN16_NOTE] : o.notes }));
}

test("an aborted file with coins at the contract (run 16): 'coins at the contract' with the amount, the recovery helper in a terminal, and never 'nothing is at risk'", () => {
  const v = aborted("alice");
  assert.equal(v.phase.id, "aborted");
  assert.deepEqual(v.coins_at_contract.instances.map((i) => [i.slot, i.creation, i.amount_text]), [[7, 3, "4.000000"]]);
  assert.match(v.abort.headline, /Coins at the contract: the last tick lists 1 instance at the contract root/);
  assert.ok(v.abort.rows.some((r) => /4\.000000 NOID at the contract root \(slot 7, creation 3\)/.test(r.where)));
  assert.ok(v.abort.rows.some((r) => /recovery helper in a terminal \(the console cannot start it yet\)/.test(r.fate)));
  assert.deepEqual(v.abort.recovery.commands.map((c) => c.cmd), ["bash $L/bin/recover-noid.sh --dry-run", "bash $L/bin/recover-noid.sh", "bash $L/bin/tick.sh alice --closed-by <TXID> --apply"]);
  assert.ok(v.abort.you.some((t) => /recovery helper in a terminal/.test(t)));
  assert.ok(v.alarms.some((a) => a.id === "coins-after-abort" && /4\.000000 NOID/.test(a.text)));
  // the engine's own reason and notes are the card's content, whole
  assert.equal(v.action.reason, RUN16_REASON);
  assert.deepEqual(v.action.notes, [RUN16_NOTE]);
  for (const text of [v.abort.headline, ...v.abort.rows.flatMap((r) => [r.who, r.where, r.fate]), ...v.abort.you, v.phase.happening, v.phase.next, v.phase.nothing, v.phase.label]) assert.ok(!ABSURD.test(text), text);
  // several instances are all listed
  const two = aborted("alice", { noid: { instances: [{ instance: { slot_index: 7, creation_id: 3, amount_micronoid: 4000000 }, matches_opening: true }, { instance: { slot_index: 9, creation_id: 4, amount_micronoid: 5000000 }, matches_opening: false }], instance_count: 2 } });
  assert.equal(two.coins_at_contract.instances.length, 2);
  assert.match(two.abort.headline, /lists 2 instances/);
  assert.ok(two.abort.rows.some((r) => /does not match the opening/.test(r.where)));
});

test("an aborted file whose tick lists no instance, or none at all: 'no instance listed' and 'the console does not know', never 'nothing'", () => {
  const none = aborted("alice", { instance: null, notes: [] });
  assert.equal(none.coins_at_contract.known, true);
  assert.match(none.abort.headline, /lists no instance at the contract root\. That is what the node said then; the console does not claim more/);
  assert.equal(none.abort.recovery, null);
  assert.ok(!none.alarms.some((a) => a.id === "coins-after-abort"));
  // a tick with no noid block at all
  const t = mkTick({ phase: "aborted", action: { action: "wait", reason: RUN16_REASON } });
  delete t.noid;
  const unknown = view("alice", t);
  assert.equal(unknown.coins_at_contract.known, false);
  assert.match(unknown.abort.headline, /The console does not know whether anything is at the contract/);
  for (const v of [none, unknown]) for (const text of [v.abort.headline, ...v.abort.rows.flatMap((r) => [r.where, r.fate]), ...v.abort.you, v.phase.happening, v.phase.next, v.phase.nothing]) assert.ok(!ABSURD.test(text), text);
  // Bob's aborted file: the same rule, and no recovery step (the coins are Alice's)
  const bob = view("bob", mkTick({ phase: "aborted", action: { action: "abort", reason: "last lock height 281262 passed before Alice's funding was final" } }));
  assert.equal(bob.abort.recovery, null);
  assert.ok(!ABSURD.test(bob.abort.headline));
  assert.ok(bob.abort.rows.some((r) => /Ethereum lock|no matching lock|Unknown/.test(r.where)));
});

test("no phase text of either role claims 'nothing is at risk / on chain' for created, received or aborted", () => {
  for (const role of ["alice", "bob"]) {
    for (const id of ["created", "received", "aborted"]) {
      const info = P.phaseInfo(role, id);
      if (!info) continue;
      for (const k of ["label", "happening", "next", "nothing"]) assert.ok(!ABSURD.test(info[k]), `${role} ${id} ${k}: ${info[k]}`);
      const v = view(role, mkTick({ phase: id }));
      assert.ok(!ABSURD.test(v.abort.headline), `${role} ${id}`);
    }
  }
  assert.ok(!ABSURD.test(P.actionInfo("abort").plain));
});

// ------------------------------------------------------------------------------------------------ a held step the engine does not offer

const heldView = (o = {}) => {
  const t = F.spendTick("reveal_eth", { held: true, fresh: o.fresh, cutoffPassed: o.cutoffPassed, notes: o.notes });
  if (o.dropFresh) t.notes = t.notes.filter((n) => !n.startsWith("held: fresh decision"));
  return V.buildView({ ...input("alice", t), now: F.NOW, tick_mtime: F.NOW - 3 });
};

test("a held reveal whose cutoff has passed: no commands, no dry run, no frozen parameters, and the engine's reason is what leads", () => {
  const v = heldView({ fresh: "wait", cutoffPassed: true });
  assert.equal(v.status, "held");
  assert.deepEqual(v.action.held_not_offered, { kind: "reveal_eth", fresh: "wait", cutoff_passed: true });
  assert.deepEqual(v.action.commands, []);
  assert.equal(v.action.command_kind, null);
  assert.equal(v.action.dry_run, null);
  assert.match(v.action.reason, /its reveal cutoff has passed, so the printed parameters are not to be used/);
  assert.equal(v.action.actionable, false);
  // the held intent is still reported (it was decided), the page just does not offer it
  assert.equal(v.action.intent.status, "held");
});

test("a held step the engine DOES offer keeps its commands; the console offers nothing when the fresh decision is not stated, or is another step", () => {
  const offered = heldView({});
  assert.equal(offered.action.held_not_offered, null);
  assert.equal(offered.action.command_kind, "reveal_eth");
  assert.ok(offered.action.commands.length > 0);
  for (const o of [{ fresh: "wait" }, { fresh: "refund_noid" }, { dropFresh: true }]) {
    const v = heldView(o);
    assert.ok(v.action.held_not_offered, JSON.stringify(o));
    assert.deepEqual(v.action.commands, [], JSON.stringify(o));
    assert.equal(v.action.command_kind, null);
  }
  // "do NOT send it" (a pending lock the producer screen refuses): not offered even when the fresh decision was the lock
  const lock = F.spendTick("lock_eth", { held: true });
  lock.action.reason = "intent lock_eth pending since 1799999980 (unix) but the producer screen refuses to lock now (T21: x): do NOT send it; if nothing was sent, `swap-cli intent FILE --cancel`";
  const lv = V.buildView({ ...input("bob", lock), now: F.NOW, tick_mtime: F.NOW - 3 });
  assert.ok(lv.action.held_not_offered);
  assert.deepEqual(lv.action.commands, []);
});

// ------------------------------------------------------------------------------------------------ the engine's loud notes

test("ALERT:, ALARM and ANOMALY notes are alarms and 'loud notes', whole and never cut; a plain 'stale' word is only an amber note", () => {
  const ALERT = "ALERT: a reorg removed Bob's NOID claim from the chain and it is not pending. Send it again: `bash $L/bin/claim.sh` is the dry run, check it, then `bash $L/bin/claim.sh --submit` ($L is the helpers' run folder). Then check on the next tick that the claim is in the pool or included, and send it again if it is gone (the node can drop a claim sent just before it handles a reorg); a claim built near the end of a 144-block epoch can expire unconfirmed and must be built again";
  const ALARM = "ALARM: the NOID claim is still pending (not seen mined) and the next call height 281500 is past the D-19 target (D 281514): if it is mined now it is not final before Alice's refund opens at D, and a reorg can still take it out; nothing can be sent instead of it (first-seen mempool)";
  const v = view("bob", mkTick({ phase: "claim_submitted", notes: [ALERT, ALARM, "the observation is stale"], action: { action: "wait", reason: "NOID claim pending" } }));
  const a = v.alarms.find((x) => x.text === ALERT);
  assert.ok(a, "the ALERT: note is an alarm");
  assert.equal(a.level, "danger");
  assert.equal(a.text.length, ALERT.length, "never cut");
  assert.ok(v.alarms.some((x) => x.text === ALARM && x.level === "danger"));
  assert.deepEqual(v.action.loud_notes, [ALERT, ALARM]);
  assert.ok(v.alarms.some((x) => x.level === "attn" && /stale/.test(x.text)));
  // the first alarms of the list are the danger ones
  assert.equal(v.alarms[0].level, "danger");
  assert.deepEqual(view("alice", mkTick({ phase: "funding_final", notes: ["waiting"] })).action.loud_notes, []);
});

// ------------------------------------------------------------------------------------------------ the reveal cutoff

test("the reveal cutoff rows come from the intent's own cutoff and late_cutoff; the profile table is only a labelled fallback", () => {
  const T = F.NOW + 3000;
  const lock = mkLock({ timelock: T });
  const withIntent = (extra, profile) => {
    const intent = { status: "recorded", intent: { action: "reveal_eth", params: { action: "reveal_eth", lock_id: lock.lock_id, ...extra }, decided_at: NOW - 5 } };
    const tick = mkTick({ phase: "lock_final", lock, intent, action: { action: "reveal_eth", lock_id: lock.lock_id } });
    return V.buildView({ ...input("alice", tick), terms: profile ? { ...TERMS, profile } : TERMS });
  };
  // the intent says T - 900 and T - 100; the rehearsal table would say T - 300: the intent wins
  const v = withIntent({ t_reveal: T, cutoff: T - 900, late_cutoff: T - 100 }, "rehearsal");
  const c = row(v, "reveal_cutoff");
  assert.equal(c.target, T - 900);
  assert.equal(c.source, "intent");
  assert.match(c.label, /frozen in the engine's intent/);
  const l = row(v, "reveal_resend_cutoff");
  assert.equal(l.target, T - 100);
  assert.equal(l.source, "intent");
  assert.match(l.plain, /re-send of a reveal that may already be public/);
  // only a cutoff: no second row
  assert.equal(row(withIntent({ cutoff: T - 900 }), "reveal_resend_cutoff"), undefined);
  // no intent: the profile table, labelled as an estimate
  const fb = V.buildView({ ...input("alice", mkTick({ phase: "lock_final", lock })), terms: { ...TERMS, profile: "rehearsal" } });
  const f = row(fb, "reveal_cutoff");
  assert.equal(f.target, T - 300);
  assert.equal(f.source, "profile-table");
  assert.match(f.label, /estimate from the profile table/);
  assert.match(f.plain, /No reveal intent exists yet/);
  assert.equal(row(fb, "reveal_resend_cutoff"), undefined);
  // the page no longer says what the engine will do after the cutoff
  for (const d of [c, f, l]) assert.ok(!/will not reveal/.test(d.plain), d.plain);
  // a held intent carries them too
  const held = V.buildView({ ...input("alice", F.spendTick("reveal_eth", { held: true })), now: F.NOW, tick_mtime: F.NOW - 3 });
  assert.equal(row(held, "reveal_cutoff").source, "intent");
});

// ------------------------------------------------------------------------------------------------ the producer screen

test("the producer figures of the tick are shown as plain figures (no judgement of the console's own)", () => {
  const share = (n, largest, top, id) => ({ n, largest, largest_id: id, top_two: top, distinct: 8 });
  const noid = {
    producers: { source: "http://127.0.0.1:9601", tip: 281200, header_tip: 281200, read_at: NOW, window_long: 2880, window_short: 720, have: 2880, long: share(2880, 806, 1200, "8e1f2a3c"), short: share(720, 331, 400, "8e1f2a3c"), complete: true, headers_read: 4, second: { state: "agrees", height: 281190, sampled: 64 } },
    producer_marker: { state: "present", height: 281000, at: NOW - 60 },
    accept_producer_concentration: true,
  };
  const v = view("bob", mkTick({ phase: "received", noid }));
  const lines = v.producers.lines;
  assert.ok(lines.some((l) => /Long window: the largest producer \(8e1f2a3c\) made 806 of 2880 blocks \(28\.0 %\); the two largest together 1200; 8 distinct producers\./.test(l)), lines.join("\n"));
  assert.ok(lines.some((l) => /Short window: the largest producer \(8e1f2a3c\) made 331 of 720 blocks \(46\.0 %\)/.test(l)));
  assert.ok(lines.some((l) => /The second node agrees at height 281190 and on 64 sampled heights/.test(l)));
  assert.ok(lines.some((l) => /producer-differs marker is present beside the swap file \(height 281000/.test(l)));
  assert.ok(lines.some((l) => /--accept-producer-concentration is on/.test(l)));
  assert.ok(!lines.some((l) => /refuse|too high|dangerous|safe/i.test(l)), "no verdict of the console's own");
  // the other second-check states, an incomplete reading and an error
  const w = view("bob", mkTick({ phase: "received", noid: { producers: { tip: 5, header_tip: 0, window_long: 2880, window_short: 720, have: 0, long: null, short: null, complete: false, second: { state: "unreadable", reason: "timeout" }, error: "cannot open the node for the headers: refused" } } }));
  assert.ok(w.producers.lines.some((l) => /Long window \(2880 blocks\): not complete yet/.test(l)));
  assert.ok(w.producers.lines.some((l) => /The second node could not be checked: timeout/.test(l)));
  assert.ok(w.producers.lines.some((l) => /The reading says: cannot open the node/.test(l)));
  for (const [second, re] of [[{ state: "differs", height: 9, first: "aaaaaaaa", second: "bbbbbbbb" }, /different blocks at height 9 \(aaaaaaaa against bbbbbbbb\)/], [{ state: "producer_differs", height: 9 }, /same block at height 9 but name different producers/], [{ state: "not_configured" }, /No second node was asked/]]) {
    const x = view("bob", mkTick({ phase: "received", noid: { producers: { tip: 5, header_tip: 5, window_long: 1, window_short: 1, have: 1, long: share(1, 1, 1, "aa"), short: share(1, 1, 1, "aa"), complete: true, second } } }));
    assert.ok(x.producers.lines.some((l) => re.test(l)), JSON.stringify(second));
  }
  // nothing in the tick, nothing shown
  assert.equal(view("bob", mkTick({ phase: "received" })).producers, null);
});

// ------------------------------------------------------------------------------------------------ production, the leftover leg, the node-count wording

test("a production swap (the bundle's profile, or chain 1 in the terms, the tick or the swap file's terms) is shown read-only with a plain sentence, first among the alarms", () => {
  const prod = V.buildView({ ...input("alice", mkTick({ phase: "funding_final" })), terms: { ...TERMS, profile: "production" } });
  assert.deepEqual(prod.production, { read_only: true, text: V.PRODUCTION_TEXT });
  assert.equal(prod.alarms[0].id, "production");
  assert.match(prod.alarms[0].text, /does not act on a production swap/);
  assert.ok(V.isProduction({ profile: "sepolia", chain_id: 1 }, null));
  assert.ok(V.isProduction(null, { eth: { chain_id: 1 } }));
  assert.ok(V.isProduction(null, { swap_terms: { eth: { chain_id: 1 } } }));
  assert.ok(!V.isProduction({ profile: "sepolia", chain_id: 11155111 }, { eth: { chain_id: 11155111 } }));
  assert.ok(!V.isProduction({ profile: "rehearsal" }, null));
  // a profile the bundle does not state is the console's assumption, not a statement
  assert.ok(!V.isProduction({ profile: "production", profile_explicit: false }, null));
  assert.equal(view("alice", mkTick({ phase: "funding_final" })).production, null);
});

test("a done swap with a leftover leg is not finished: the structured facts count, not only the reason's words", () => {
  const old = { now: NOW - 90000, noidObservedAt: NOW - 90004, ethObservedAt: NOW - 90004, ethTime: NOW - 90006 };
  // Alice done, the reason says nothing about a leftover, but the instance is still listed at the contract
  const a = V.buildView({ ...input("alice", mkTick({ ...old, phase: "done", action: { action: "wait", reason: "done: ETH received" } })), tick_mtime: NOW - 90000 });
  assert.notEqual(a.status, undefined);
  assert.ok(a.alarms.some((x) => x.id === "tick-stale" && x.level === "danger"), "a leftover instance keeps the loop alarm");
  // Bob done with his lock still open
  const b = V.buildView({ ...input("bob", mkTick({ ...old, phase: "done", lock: mkLock(), action: { action: "wait", reason: "done: NOID received" } })), tick_mtime: NOW - 90000 });
  assert.ok(b.alarms.some((x) => x.id === "tick-stale" && x.level === "danger"));
  // the words that the engine no longer prints do not matter any more; the ones it prints do
  const E = require("../lib/enginetext");
  assert.equal(E.leftoverReason("done: ETH received; the NOID is still at the contract, refund_noid opens ..."), true);
  assert.equal(E.leftoverReason("taking it back"), false);
  assert.equal(E.leftoverReason("done: ETH received"), false);
});

test("the one-node note no longer says it is fine against a counterparty you control", () => {
  const t = mkTick({ phase: "funding_final" });
  t.sources = { noid: "x", eth: "y" };
  delete t.noid.second;
  delete t.eth.second;
  const v = view("bob", t);
  const w = v.alarms.filter((a) => /^single-/.test(a.id));
  assert.ok(w.length >= 1);
  for (const a of w) assert.ok(!/Fine against a counterparty you control/.test(a.text), a.text);
});
