"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const V = require("../lib/viewmodel");
const P = require("../lib/phases");
const { NOW, D, TERMS, mkTick, mkLock, input } = require("./helpers");

const view = (role, tick, extra) => V.buildView(input(role, tick, extra));
const row = (v, id) => v.deadlines.find((d) => d.id === id);

// ---------------------------------------------------------------- formatting
test("fmtDur, noidText, ethText", () => {
  assert.equal(V.fmtDur(45), "45 s");
  assert.equal(V.fmtDur(90), "1 min 30 s");
  assert.equal(V.fmtDur(600), "10 min");
  assert.equal(V.fmtDur(3661), "1 h 01 min");
  assert.equal(V.fmtDur(9000), "2 h 30 min");
  assert.equal(V.fmtDur(-90), "1 min 30 s");
  assert.equal(V.fmtDur(null), "—");
  assert.equal(V.noidText(10000000), "10.000000");
  assert.equal(V.noidText(9994200), "9.994200");
  assert.equal(V.ethText("1000000000000000"), "0.001");
  assert.equal(V.ethText("1500000000000000000"), "1.500");
  assert.equal(V.ethText(null), null);
  assert.equal(V.ethText("nope"), null);
});

// ---------------------------------------------------------------- countdown math
test("height countdowns: blocks left, 30 s per block, advancing with the wall clock", () => {
  const tick = mkTick({ tip: D - 302, phase: "funding_final" });
  let v = view("alice", tick);
  assert.equal(row(v, "d").blocks_left, 302);
  assert.equal(row(v, "d").seconds_left, 9060);
  assert.equal(row(v, "d").state, "far");
  // the console counts nothing down to the nominal lock-by: the real last lock height is the engine's (its note), so the row only shows the number
  assert.equal(row(v, "lock_by").target, D - 252);
  assert.equal(row(v, "lock_by").blocks_left, undefined);
  assert.equal(row(v, "lock_by").seconds_left, undefined);
  assert.equal(row(v, "lock_by").no_countdown, true);
  assert.notEqual(row(v, "lock_by").state, "closing");
  // 95 s later with no new tick (the observation was 4 s old at NOW): 99 s = 3 more blocks are assumed
  v = V.buildView({ ...input("alice", tick), now: NOW + 95 });
  assert.equal(row(v, "d").blocks_left, 299);
  assert.equal(row(v, "d").seconds_left, 299 * 30);
  assert.equal(v.header.noid.tip, D - 302, "the observed tip is never changed");
  assert.equal(v.header.noid.tip_estimate, D - 302 + 3);
});

test("deadline states: far, closing under 30 blocks, passed, never a surprise 'fine'", () => {
  assert.equal(row(view("alice", mkTick({ tip: D - 31 })), "d").state, "far");
  assert.equal(row(view("alice", mkTick({ tip: D - 29 })), "d").state, "closing");
  assert.equal(row(view("alice", mkTick({ tip: D })), "d").state, "passed");
  assert.equal(row(view("alice", mkTick({ tip: D + 5 })), "d").blocks_left, -5);
  assert.equal(row(view("alice", mkTick({ tip: D + 5 })), "d").seconds_left, -150);
  const noTerms = V.buildView({ role: "alice", now: NOW, tick: mkTick(), terms: null, helpers: [] });
  assert.equal(row(noTerms, "d").state, "unknown");
  assert.equal(row(noTerms, "d").target, null);
});

test("T_reveal and the reveal cutoff use the chain clock and the profile's margin", () => {
  const lock = mkLock({ timelock: NOW + 3000 });
  const tick = mkTick({ phase: "lock_final", lock, ethTime: NOW - 6, ethObservedAt: NOW - 6 });
  let v = view("alice", tick);
  assert.equal(row(v, "t_reveal").seconds_left, 3000, "chain time advances with the wall clock since the observation");
  assert.equal(row(v, "reveal_cutoff").seconds_left, 3000 - 1800, "sepolia margin 1,800 s");
  assert.equal(row(v, "reveal_cutoff").state, "far");
  // rehearsal: 300 s
  v = view("alice", tick, { terms: { ...TERMS, profile: "rehearsal" } });
  assert.equal(row(v, "reveal_cutoff").seconds_left, 3000 - 300);
  // production when the bundle is missing
  v = view("alice", tick, { terms: { ...TERMS, profile: undefined } });
  assert.equal(row(v, "reveal_cutoff").seconds_left, 3000 - 1800);
  // closing: under 15 minutes
  v = view("alice", mkTick({ phase: "lock_final", lock: mkLock({ timelock: NOW + 2400 }) }));
  assert.equal(row(v, "reveal_cutoff").seconds_left, 602, "the chain clock is the observed time (NOW - 6) plus the 4 s since it was observed");
  assert.equal(row(v, "reveal_cutoff").state, "closing");
  // passed
  v = view("alice", mkTick({ phase: "lock_final", lock: mkLock({ timelock: NOW + 850 }) }));
  assert.equal(row(v, "reveal_cutoff").state, "passed");
  assert.equal(row(v, "t_reveal").state, "closing");
  // a lag in the chain clock shows up: the node is 100 s behind, so T_reveal is 100 s further away than the wall clock says
  v = view("alice", mkTick({ phase: "lock_final", lock: mkLock({ timelock: NOW + 3000 }), ethTime: NOW - 106, ethObservedAt: NOW - 6 }));
  assert.equal(row(v, "t_reveal").seconds_left, 3000 + 100 - 0, "clock = observed chain time + wall time since");
});

test("T_reveal is irrelevant once the lock is claimed or refunded; it falls back to the intent's value before a lock exists", () => {
  const claimed = view("bob", mkTick({ phase: "secret_seen", lock: mkLock({ claimed: true }) }));
  assert.equal(row(claimed, "t_reveal").state, "na");
  assert.equal(row(claimed, "reveal_cutoff").state, "na");
  const intent = { status: "recorded", intent: { action: "lock_eth", params: { t_reveal: NOW + 5000 }, decided_at: NOW - 10 } };
  const pre = view("bob", mkTick({ phase: "funding_final", action: { action: "lock_eth", hashlock: "0x1", t_reveal: NOW + 5000, receiver: "0x2", amount_wei: "1" }, intent }));
  assert.equal(row(pre, "t_reveal").target, NOW + 5000);
  const none = view("bob", mkTick({ phase: "received" }));
  assert.equal(row(none, "t_reveal").state, "unknown");
});

test("a stale tick keeps estimates but labels them; a dead one makes them unknown", () => {
  const old = (age) => mkTick({ now: NOW - age, noidObservedAt: NOW - age - 4, ethObservedAt: NOW - age - 4, ethTime: NOW - age - 6, tip: D - 302 });
  let v = V.buildView({ ...input("alice", old(200)), tick_mtime: NOW - 200 });
  assert.equal(v.deadlines_stale, true);
  assert.equal(row(v, "d").stale, true);
  assert.equal(row(v, "d").state, "far");
  assert.ok(v.alarms.some((a) => a.id === "tick-stale" && a.level === "attn"));
  v = V.buildView({ ...input("alice", old(700)), tick_mtime: NOW - 700 });
  assert.equal(row(v, "d").state, "unknown");
  assert.ok(v.alarms.some((a) => a.id === "tick-stale" && a.level === "danger"));
  assert.equal(v.header.tick.state, "danger");
});

test("observation age states: ok up to 60 s, warn to 120 s, attn beyond", () => {
  assert.equal(V.ageState(5), "ok");
  assert.equal(V.ageState(60), "ok");
  assert.equal(V.ageState(61), "warn");
  assert.equal(V.ageState(120), "warn");
  assert.equal(V.ageState(121), "attn");
  assert.equal(V.ageState(null), "unknown");
});

// ---------------------------------------------------------------- every phase of both roles
const ALICE_PHASES = ["created", "funding_submitted", "funded", "funding_final", "lock_seen", "lock_final", "reveal_submitted", "revealed", "done", "refund_submitted", "refund_included", "refunded", "lost", "aborted"];
const BOB_PHASES = ["received", "funded", "funding_final", "lock_submitted", "locked", "secret_seen", "claim_submitted", "claim_included", "done", "refund_submitted", "refund_mined", "refunded", "aborted"];

test("the catalogue has all engine phases, including refund_mined, lost and aborted, with the three plain-words fields", () => {
  assert.deepEqual(P.phaseIds("alice").sort(), [...ALICE_PHASES].sort());
  assert.deepEqual(P.phaseIds("bob").sort(), [...BOB_PHASES].sort());
  for (const [role, list] of [["alice", ALICE_PHASES], ["bob", BOB_PHASES]]) {
    for (const ph of list) {
      const i = P.phaseInfo(role, ph);
      for (const k of ["label", "happening", "next", "nothing"]) assert.ok(i[k] && i[k].length >= 3, `${role}/${ph}/${k}`);
    }
  }
  assert.equal(P.isTerminal("alice", "lost"), true);
  assert.equal(P.isTerminal("alice", "aborted"), true);
  assert.equal(P.isTerminal("alice", "refunded"), true);
  assert.equal(P.isTerminal("alice", "done"), false, "done is not terminal: a leftover leg can still be refunded");
  assert.equal(P.isTerminal("bob", "refund_mined"), false, "refund_mined is not terminal (M2.5b)");
  assert.equal(P.isTerminal("bob", "refunded"), true);
});

test("every phase renders a view model: one current node at most, an abort statement, a status, no throw", () => {
  for (const [role, list] of [["alice", ALICE_PHASES], ["bob", BOB_PHASES]]) {
    for (const ph of list) {
      const v = view(role, mkTick({ phase: ph, lock: mkLock() }));
      assert.equal(v.phase.id, ph);
      assert.equal(v.phase.known, true);
      assert.equal(v.phase.terminal, P.isTerminal(role, ph), `${role}/${ph} terminal`);
      const nodes = [...v.timeline.main, ...v.timeline.recovery];
      assert.ok(nodes.filter((n) => n.state === "current").length <= 1, `${role}/${ph}: at most one current node`);
      assert.ok(v.abort.headline.length > 10 && v.abort.rows.length >= 1, `${role}/${ph}: abort statement`);
      assert.ok(v.status);
      assert.ok(v.phase.happening && v.phase.next && v.phase.nothing);
    }
  }
});

test("timeline: main track, recovery track and the skipped fork", () => {
  const states = (role, ph) => {
    const t = V.timelineFor(role, ph);
    return { main: t.main.map((n) => n.state[0]).join(""), rec: t.recovery.map((n) => n.state[0]).join(""), extra: t.extra, onRec: t.on_recovery };
  };
  assert.deepEqual(states("alice", "created"), { main: "cppppppp", rec: "ppp", extra: null, onRec: false });
  assert.deepEqual(states("alice", "lock_final"), { main: "ddddcppp", rec: "ppp", extra: null, onRec: false });
  assert.equal(states("alice", "funding_submitted").main[1], "c", "funding_submitted is on the 'funded' node");
  assert.equal(states("alice", "done").main, "dddddddd");
  assert.deepEqual(states("alice", "refund_included"), { main: "dddsssss", rec: "dcp", extra: null, onRec: true });
  assert.deepEqual(states("alice", "refunded"), { main: "dddsssss", rec: "ddd", extra: null, onRec: true });
  assert.deepEqual(states("alice", "lost"), { main: "ddddddss", rec: "ppp", extra: "lost", onRec: true });
  assert.deepEqual(states("alice", "aborted"), { main: "ssssssss", rec: "ppp", extra: "aborted", onRec: true });
  assert.deepEqual(states("bob", "locked"), { main: "ddddcppp" + "p", rec: "ppp", extra: null, onRec: false });
  assert.deepEqual(states("bob", "refund_mined"), { main: "dddsssss" + "s", rec: "dcp", extra: null, onRec: true });
  assert.deepEqual(states("bob", "refunded"), { main: "dddsssss" + "s", rec: "ddd", extra: null, onRec: true });
  assert.equal(states("bob", "done").main, "ddddddddd");
  assert.deepEqual(states("bob", "aborted").main, "sssssssss");
  assert.deepEqual(V.timelineFor("alice", "no_such_phase").main.map((n) => n.state[0]).join(""), "pppppppp");
});

test("an unrecognised phase is shown as unrecognised, never explained", () => {
  const v = view("alice", mkTick({ phase: "brand_new_phase" }));
  assert.equal(v.phase.known, false);
  assert.match(v.phase.label, /Unrecognised phase "brand_new_phase"/);
  assert.match(v.phase.next, /do not act/);
  assert.match(v.abort.headline, /not recognised/);
});

// ---------------------------------------------------------------- actions, commands, intents
test("wait / spending / withheld / held: what the action card may offer", () => {
  const wait = view("alice", mkTick({ phase: "funding_final", action: { action: "wait", reason: "waiting for Bob's lock" } }));
  assert.equal(wait.status, "waiting");
  assert.equal(wait.action.kind, "wait");
  assert.equal(wait.action.reason, "waiting for Bob's lock");
  assert.deepEqual(wait.action.commands, []);

  const intent = { status: "recorded", intent: { action: "reveal_eth", params: { action: "reveal_eth", lock_id: "0x" + "d1".repeat(32) }, decided_at: NOW - 20, phase_at_decision: "lock_final" } };
  const act = view("alice", mkTick({ phase: "lock_final", lock: mkLock(), action: { action: "reveal_eth", lock_id: "0x" + "d1".repeat(32) }, intent }), { commands: { bin: "/home/u/run/bin" } });
  assert.equal(act.status, "act");
  assert.equal(act.action.actionable, true);
  assert.deepEqual(act.action.commands.map((c) => [c.id, c.kind]), [["dry", "dry"], ["send", "send"], ["replace", "send"]]);
  assert.equal(act.action.commands[0].cmd, "bash /home/u/run/bin/reveal.sh --dry-run");
  assert.equal(act.action.commands[1].cmd, "bash /home/u/run/bin/reveal.sh");
  assert.equal(act.action.params.lock_id, "0x" + "d1".repeat(32));

  // a read-only tick: the parameters are withheld, so no command is offered and the page says why
  const withheld = view("alice", mkTick({ phase: "lock_final", lock: mkLock(), action: { kind: "reveal_eth", parameters: "withheld", note: "a read-only tick records nothing; run tick --apply" } }));
  assert.equal(withheld.action.kind, "reveal_eth");
  assert.equal(withheld.action.withheld, true);
  assert.equal(withheld.action.actionable, false);
  assert.deepEqual(withheld.action.commands, []);
  assert.match(withheld.action.withheld_note, /tick --apply/);
  // an observe-only tick (the program's read loop) says its own thing, not "the loop records the intent"
  const observing = view("alice", { ...mkTick({ phase: "lock_final", lock: mkLock(), action: { kind: "reveal_eth", parameters: "withheld", note: "an observe-only tick records no intent" } }), observe_only: true, events_applied_to_file: true });
  assert.equal(observing.action.withheld, true);
  assert.equal(observing.action.withheld_note, "Observing only: the program records what happens on the chains but decides nothing until you have approved and deposited.");
  assert.equal(observing.header.tick.applied, false, "shown as a read-only tick");
  assert.equal(withheld.status, "waiting");

  // a held intent: the engine says wait; the page shows the held step and the dry-run command, and an alarm
  const held = view("bob", mkTick({ phase: "funding_final", notes: ["held: fresh decision was lock_eth"], action: { action: "wait", reason: "intent lock_eth pending since 1: the chain does not show it yet" }, intent: { status: "held", intent: { action: "lock_eth", params: { action: "lock_eth", amount_wei: "1000000000000000", t_reveal: NOW + 5000 }, decided_at: NOW - 140, phase_at_decision: "funding_final" } } }));
  assert.equal(held.status, "held");
  assert.equal(held.action.intent.status, "held");
  assert.equal(held.action.intent.kind, "lock_eth");
  assert.ok(held.alarms.some((a) => a.id === "intent" && a.level === "warn" && /pays twice/.test(a.text)));
  assert.equal(held.action.command_kind, "lock_eth");
});

test("commands per action and role", () => {
  const c = (role, kind, ctx = {}) => V.commandsFor(role, kind, { bin: "B", ...ctx }).map((x) => `${x.kind}:${x.cmd}`);
  assert.deepEqual(c("bob", "lock_eth"), ["dry:bash B/lock.sh --dry-run", "send:bash B/lock.sh"]);
  assert.deepEqual(c("bob", "claim_noid"), ["dry:bash B/claim.sh", "send:bash B/claim.sh --submit"]);
  assert.deepEqual(c("bob", "refund_eth"), ["dry:bash B/refund-eth.sh --dry-run", "send:bash B/refund-eth.sh"]);
  const fund = c("alice", "fund_noid", { amount_text: "10.000000" });
  // funding and recovery go through the helpers (fund.sh: once per run folder; recover-noid.sh: every instance, chained to its preview), never the bare wallet command
  assert.deepEqual(fund, ["dry:bash B/check-object.sh", "dry:bash B/fund.sh --dry-run", "send:bash B/fund.sh"]);
  assert.match(V.commandsFor("alice", "fund_noid", { bin: "B", amount_text: "10.000000" })[2].note, /10\.000000.*ONCE/);
  const refund = c("alice", "refund_noid", { slot: 9705979, creation: 737344 });
  assert.deepEqual(refund, ["dry:bash B/recover-noid.sh --dry-run", "send:bash B/recover-noid.sh", "manual:bash B/tick.sh alice --closed-by <TXID> --apply"]);
  for (const x of [...fund, ...refund]) assert.ok(!/parano1d-cli contract (fund|call)/.test(x), x);
  assert.deepEqual(c("alice", "wait"), []);
  assert.deepEqual(c("alice", "abort"), []);
  // the default prefix is the shell variable
  assert.equal(V.commandsFor("bob", "claim_noid", {})[0].cmd, "bash $L/bin/claim.sh");
});

test("dry-run attachment: newest dry run for the action, cross-checked against the terms and the decision", () => {
  const lockId = "0x" + "d1".repeat(32);
  const intent = { status: "recorded", intent: { action: "reveal_eth", params: { lock_id: lockId }, decided_at: NOW - 100 } };
  const tick = mkTick({ phase: "lock_final", lock: mkLock(), action: { action: "reveal_eth", lock_id: lockId }, intent });
  const helpers = [
    { kind: "eth_claim", file: "eth-claim-dry-1.json", mtime: NOW - 300, dry: true, ok: true, summary: { dryRun: true, lockId: "0x" + "99".repeat(32), receiver: TERMS.eth.alice_receiver } },
    { kind: "eth_claim", file: "eth-claim-dry-2.json", mtime: NOW - 60, dry: true, ok: true, summary: { dryRun: true, sent: false, lockId, receiver: TERMS.eth.alice_receiver, gasEstimate: null, feeCheck: { ratio: 3 } } },
    { kind: "eth_claim", file: "eth-claim.json", mtime: NOW - 10, dry: false, ok: true, summary: { txHash: "0xabc" } },
    { kind: "eth_lock", file: "eth-lock-1.json", mtime: NOW - 5, dry: true, ok: true, summary: {} },
  ];
  const v = view("alice", tick, { helpers });
  assert.equal(v.action.dry_run.file, "eth-claim-dry-2.json", "newest dry run of this kind; a real result and other kinds are ignored");
  assert.equal(v.action.dry_run.age_s, 60);
  assert.equal(v.action.dry_run.older_than_decision, false);
  assert.equal(v.action.dry_run.all_checks_ok, true);
  assert.ok(v.action.dry_run.checks.length >= 2);
  assert.ok(v.action.dry_run.facts.some((f) => f.label === "lock id" && f.value === lockId));
  // older than the decision -> flagged
  helpers[1].mtime = NOW - 200;
  assert.equal(view("alice", tick, { helpers }).action.dry_run.older_than_decision, true);
  // another lock id -> check fails
  helpers[1].summary.lockId = "0x" + "77".repeat(32);
  const bad = view("alice", tick, { helpers }).action.dry_run;
  assert.equal(bad.all_checks_ok, false);
  assert.equal(bad.checks[0].ok, false);
  // none at all
  assert.equal(view("alice", tick, { helpers: [] }).action.dry_run, null);
});

test("Bob's claim dry run: the recipient must be Bob's address from the terms", () => {
  const tick = mkTick({ phase: "secret_seen", lock: mkLock({ claimed: true }), action: { action: "claim_noid", call_height: 5, fee_micronoid: 5800, preimage: "[withheld]" } });
  const ok = { kind: "claim_out", file: "claim-1.out", mtime: NOW - 10, dry: true, ok: true, summary: { mode: "dry_run", plan: { txid: "ab".repeat(32), call_height: 5, fee_micronoid: 5800, amount_out_micronoid: 9994200, recipient: TERMS.bob_noid, self_verified: true } } };
  let d = view("bob", tick, { helpers: [ok] }).action.dry_run;
  assert.equal(d.all_checks_ok, true);
  assert.ok(d.facts.some((f) => f.label === "recipient" && f.value === TERMS.bob_noid));
  const wrong = { ...ok, summary: { mode: "dry_run", plan: { ...ok.summary.plan, recipient: "o1SOMEONE-ELSE" } } };
  d = view("bob", tick, { helpers: [wrong] }).action.dry_run;
  assert.equal(d.all_checks_ok, false);
  assert.match(d.checks.find((c) => !c.ok).name, /recipient is Bob/);
});

// ---------------------------------------------------------------- alarms
test("alarms: single node, second node unreadable, node lag, head age, ANOMALY / ALARM, reorg events, bad chain data", () => {
  const ids = (t, role = "alice", extra) => view(role, t, extra).alarms.map((a) => a.id);

  assert.deepEqual(ids(mkTick()), [], "a clean tick with two nodes has no alarm");
  const single = view("alice", mkTick({ single: true })).alarms;
  assert.deepEqual(single.map((a) => [a.id, a.level]), [["single-Parano1d", "warn"], ["single-Ethereum", "warn"]]);
  assert.ok(ids(mkTick({ noid: { second_error: "connection refused" }, eth: { second_error: "timeout" } })).includes("second-Parano1d"));

  const lag = mkTick({ eth: { second: { latest_block: 90, latest_timestamp: NOW - 6 - 400 } } });
  assert.ok(ids(lag).includes("eth-lag"));
  assert.ok(ids(mkTick({ noid: { second: { tip: D - 302 - 5, instance_count: 1 } } })).includes("noid-disagree"));
  assert.ok(ids(mkTick({ ethTime: NOW - 1000, ethObservedAt: NOW - 4 })).includes("eth-head-old"));
  assert.ok(ids(mkTick({ noid: { tip_time: NOW - 1000 } })).includes("noid-head-old"));
  assert.ok(ids(mkTick({ noidObservedAt: NOW - 400 })).includes("stale-Parano1d"));

  const an = view("alice", mkTick({ notes: ["ANOMALY: our lock was refunded after the reveal was sent"] })).alarms;
  assert.equal(an[0].id, "anomaly");
  assert.equal(an[0].level, "danger");
  assert.equal(view("bob", mkTick({ phase: "locked", action: { action: "wait", reason: "waiting for the secret (or T_reveal); ALARM, THE ETHEREUM NODE LAGS: head 900 s old" } })).alarms[0].id, "alarm-reason");
  assert.ok(ids(mkTick({ notes: ["ALARM: x"] })).includes("alarm"));

  assert.ok(ids(mkTick({ events: [{ event: "noid_tx_reorged", txid: "ab", was_height: 5, still_pending: false }] })).includes("event-noid_tx_reorged"));
  assert.ok(ids(mkTick({ events: [{ event: "eth_claim_reorged", block_number: 5, at: 1 }] })).includes("event-eth_claim_reorged"));
  assert.ok(ids(mkTick({ noid: { instance_count: 2 } })).includes("many-instances"));
  assert.ok(ids(mkTick({ noid: { instance_matches_opening: false } })).includes("opening-mismatch"));
  assert.ok(ids(mkTick({ lock: mkLock(), eth: { lock_count: 2 } })).includes("many-locks"));
  assert.ok(ids(mkTick({ lock: { ...mkLock(), hashlock: "0x" + "11".repeat(32) } })).includes("hashlock-mismatch"));
  assert.ok(ids(mkTick({ eth: { chain_id: 1 } })).includes("chain-mismatch"));

  // ordering: danger before attn before warn
  const mixed = view("alice", mkTick({ single: true, notes: ["ANOMALY: x"], noidObservedAt: NOW - 400 })).alarms.map((a) => a.level);
  assert.deepEqual(mixed, [...mixed].sort((a, b) => ({ danger: 0, attn: 1, warn: 2, info: 3 })[a] - ({ danger: 0, attn: 1, warn: 2, info: 3 })[b]));
});

test("alarms: no tick, unreadable tick, loop exit code, stderr", () => {
  const none = V.buildView({ role: "bob", now: NOW, tick: null, terms: TERMS, helpers: [] });
  assert.equal(none.status, "no-data");
  assert.equal(none.phase, null);
  assert.equal(none.action, null);
  assert.equal(none.alarms[0].id, "no-tick");
  assert.ok(none.abort.headline, "the abort panel still answers");
  const bad = V.buildView({ role: "bob", now: NOW, tick: null, tick_error: "Unexpected end of JSON", terms: TERMS, helpers: [] });
  assert.equal(bad.alarms[0].id, "tick-unreadable");
  assert.equal(bad.alarms[0].level, "danger");
  const t = mkTick();
  delete t.now;
  const v = V.buildView({ ...input("alice", t), loop: { entries: [{ time: "1", exit_code: 3, action: null, phase_after: null }], total: 1 }, err_text: "error: refusing to read" });
  assert.ok(v.alarms.some((a) => a.id === "loop-exit"));
  assert.ok(v.alarms.some((a) => a.id === "tick-err"));
});

test("the phase falls back to the loop file when the tick file is unreadable", () => {
  const v = V.buildView({ role: "alice", now: NOW, tick: null, tick_error: "x", loop: { entries: [{ time: "t", exit_code: 0, action: "wait", reason: "r", phase_after: "lock_final" }], total: 1 }, terms: TERMS, helpers: [] });
  assert.equal(v.phase.id, "lock_final");
  assert.equal(v.phase.source, "loop");
});

// ---------------------------------------------------------------- abort panel, receipts, header
test("abort panel: where each party's funds go, with numbers, per stage", () => {
  const ctx = { d: D, blocks_to_d: 240, t_reveal: NOW + 3000, t_reveal_s_left: 3000 };
  const a = V.abortPanel("alice", "lock_final", ctx);
  assert.match(a.headline, /both sides refund/);
  assert.equal(a.rows.length, 2);
  assert.match(a.rows[0].fate, /281,514/);
  assert.match(a.rows[0].fate, /240 blocks/);
  assert.match(a.rows[1].fate, /T_reveal/);
  assert.match(a.rows[1].fate, /50 min/);
  assert.match(V.abortPanel("alice", "reveal_submitted", ctx).headline, /already public/);
  assert.match(V.abortPanel("bob", "secret_seen", ctx).rows[1].fate, /Bob would lose both/);
  assert.match(V.abortPanel("alice", "funding_final", ctx).headline, /Bob risks nothing/);
  assert.match(V.abortPanel("alice", "lost", ctx).headline, /Both legs are gone/);
  assert.match(V.abortPanel("bob", "refund_mined", { ...ctx, blocks_to_d: -3 }).rows[1].fate, /has passed|Alice takes it back/);
  const past = V.abortPanel("alice", "funding_final", { ...ctx, blocks_to_d: -4 });
  assert.match(past.rows[0].fate, /has passed/);
  assert.ok(V.abortPanel("alice", "funding_final", ctx).you.some((y) => /do nothing until/.test(y)));
});

test("header: amounts, profile, tips, ages; receipts keep txids but never the secret", () => {
  const tick = mkTick({ phase: "revealed", lock: mkLock({ claimed: true }), eth: { claimed: { lock_id: "0x" + "d1".repeat(32), preimage: "[withheld]", block_number: 99, tx_hash: "0x" + "d3".repeat(32) } }, noid: { confirmed_tx: { txid: "ab".repeat(32), height: 5 }, pending_calls: [{ txid: "cd".repeat(32), fee_micronoid: 1, admitted_height: 1 }] } });
  const v = view("alice", tick, { verify: { ok: true, text: "OK" } });
  assert.equal(v.header.amount_noid, "10.000000");
  assert.equal(v.header.amount_eth, "0.001");
  assert.equal(v.header.profile, "sepolia");
  assert.equal(v.header.noid.tip, D - 302);
  assert.equal(v.header.noid.state, "ok");
  assert.equal(v.header.tick.applied, true);
  assert.equal(v.header.noid.second, true);
  const labels = v.receipts.map((r) => r.label);
  assert.ok(labels.some((l) => /Claim transaction/.test(l)));
  assert.ok(labels.some((l) => /Lock transaction/.test(l)));
  assert.ok(labels.includes("Equivalence receipt"));
  assert.ok(v.receipts.some((r) => r.value === "ab".repeat(32)));
  assert.ok(!JSON.stringify(v).includes("5e5e5e"));
  // a read-only tick is labelled as such
  const ro = mkTick();
  ro.events_applied_to_file = false;
  assert.equal(view("alice", ro).header.tick.applied, false);
});

test("a stale spending decision is marked stale and the status says so", () => {
  const intent = { status: "recorded", intent: { action: "lock_eth", params: {}, decided_at: NOW - 900 } };
  const t = mkTick({ now: NOW - 300, noidObservedAt: NOW - 304, ethObservedAt: NOW - 304, phase: "funding_final", action: { action: "lock_eth", hashlock: "0x1", t_reveal: NOW + 5000, receiver: "0x2", amount_wei: "1" }, intent });
  const v = V.buildView({ ...input("bob", t), tick_mtime: NOW - 300 });
  assert.equal(v.status, "act-stale");
  assert.equal(v.action.stale, true);
  const settled = V.buildView({ ...input("bob", mkTick({ now: NOW - 3000, phase: "done" })), tick_mtime: NOW - 3000 });
  assert.equal(settled.status, "settled", "a settled swap is not 'stale'");
});

test("a finished swap does not raise a danger alarm for its stopped loop; a done swap with a leftover leg still does", () => {
  const old = { now: NOW - 90000, noidObservedAt: NOW - 90004, ethObservedAt: NOW - 90004, ethTime: NOW - 90006 };
  const done = V.buildView({ ...input("alice", mkTick({ ...old, phase: "done", instance: null, action: { action: "wait", reason: "done: ETH received" } })), tick_mtime: NOW - 90000 });
  assert.equal(done.status, "settled");
  assert.ok(done.alarms.some((a) => a.id === "tick-old-finished" && a.level === "info"));
  assert.ok(!done.alarms.some((a) => a.id === "tick-stale"));
  const refunded = V.buildView({ ...input("bob", mkTick({ ...old, phase: "refunded" })), tick_mtime: NOW - 90000 });
  assert.ok(refunded.alarms.some((a) => a.id === "tick-old-finished"));
  const leftover = V.buildView({ ...input("alice", mkTick({ ...old, phase: "done", action: { action: "wait", reason: "done: ETH received; the NOID is still at the contract, refund_noid opens at D" } })), tick_mtime: NOW - 90000 });
  assert.ok(leftover.alarms.some((a) => a.id === "tick-stale" && a.level === "danger"), "a leftover leg is not finished");
});

test("a role file that never saw the lock while the chain shows it settled raises file-behind-chain (the unused local copy of the other role)", () => {
  // Bob's local copy on Alice's machine (run 11): phase received, then aborted; the chain shows the lock claimed
  for (const phase of ["received", "funding_final", "aborted"]) {
    const v = view("bob", mkTick({ phase, lock: mkLock({ claimed: true }), action: { action: "wait", reason: "waiting for Alice's funding" } }));
    const al = v.alarms.find((a) => a.id === "file-behind-chain");
    assert.ok(al, phase);
    assert.equal(al.level, "attn");
    assert.match(al.text, /already claimed/);
    assert.match(al.text, /another machine/);
  }
  assert.match(view("bob", mkTick({ phase: "received", lock: mkLock({ refunded: true }) })).alarms.find((a) => a.id === "file-behind-chain").text, /already refunded/);
  assert.ok(view("alice", mkTick({ phase: "created", lock: mkLock({ claimed: true }) })).alarms.some((a) => a.id === "file-behind-chain"));
  // no alarm for the normal cases: an open lock, a file that did see the lock, no lock at all
  assert.ok(!view("bob", mkTick({ phase: "received", lock: mkLock() })).alarms.some((a) => a.id === "file-behind-chain"));
  assert.ok(!view("bob", mkTick({ phase: "done", lock: mkLock({ claimed: true }) })).alarms.some((a) => a.id === "file-behind-chain"));
  assert.ok(!view("alice", mkTick({ phase: "done", lock: mkLock({ claimed: true }) })).alarms.some((a) => a.id === "file-behind-chain"));
  assert.ok(!view("bob", mkTick({ phase: "received" })).alarms.some((a) => a.id === "file-behind-chain"));
});

// ---------------------------------------------------------------- which machine drives which role
test("machineStatus: --role says it; a console on both roles infers it from which role has tick or loop data", () => {
  assert.deepEqual(V.machineStatus("alice", { alice: null, bob: { tick: {} } }), { alice: "here", bob: "other", inferred: false });
  assert.deepEqual(V.machineStatus("bob", {}), { alice: "other", bob: "here", inferred: false });
  const t = { tick: {} };
  const l = { loop: { entries: [] } };
  assert.deepEqual(V.machineStatus("both", { alice: t, bob: null }), { alice: "here", bob: "other", inferred: true });
  assert.deepEqual(V.machineStatus("both", { alice: null, bob: l }), { alice: "other", bob: "here", inferred: true });
  assert.deepEqual(V.machineStatus(undefined, { alice: t, bob: l }), { alice: "unknown", bob: "unknown", inferred: false });
  assert.deepEqual(V.machineStatus("both", { alice: null, bob: null }), { alice: "unknown", bob: "unknown", inferred: false });
  assert.deepEqual(V.machineStatus("both", { alice: { tick: null, loop: null }, bob: t }), { alice: "other", bob: "here", inferred: true });
});

test("the other role's missing file is a note, not a problem; the role driven here keeps its alarms (file-behind-chain included)", () => {
  const M = { alice: "here", bob: "other", inferred: false };
  // Bob's tab on Alice's machine: no tick, runs elsewhere
  const bob = V.buildView(input("bob", null, { machines: M }));
  assert.equal(bob.status, "remote");
  assert.deepEqual(bob.alarms.map((a) => [a.level, a.id]), [["info", "other-machine"]]);
  assert.match(bob.alarms[0].text, /Bob runs on another machine: this console does not tick or spend for Bob/);
  assert.ok(!bob.alarms.some((a) => a.id === "no-tick"));
  // without the machine status the same view is the old "no data" problem
  const old = V.buildView(input("bob", null));
  assert.equal(old.status, "no-data");
  assert.ok(old.alarms.some((a) => a.id === "no-tick"));
  // Alice's own tab: a note about the other role, her own alarms untouched
  const alice = V.buildView(input("alice", mkTick({ phase: "created", lock: mkLock({ claimed: true }), action: { action: "wait", reason: "x" } }), { machines: M }));
  assert.ok(alice.alarms.some((a) => a.id === "file-behind-chain"), "a role driven here that is behind the chain still alarms");
  const note = alice.alarms.find((a) => a.id === "other-machine");
  assert.equal(note.level, "info");
  assert.match(note.text, /The other role \(Bob\) runs on another machine/);
  assert.notEqual(alice.status, "remote");
  // inferred (a console on both roles): the wording says "probably" and points to the watch loop
  const inferred = V.buildView(input("bob", null, { machines: { alice: "here", bob: "other", inferred: true } }));
  assert.match(inferred.alarms[0].text, /probably runs on another machine/);
  assert.match(inferred.alarms[0].text, /start the watch loop/);
  // a role that is "other" but still has a tick (not possible with --role: the server hides it) is shown as it is
  const withTick = V.buildView(input("bob", mkTick({ phase: "received" }), { machines: M }));
  assert.notEqual(withTick.status, "remote");
});

test("Bob's claim target is D - 19: a claim included there is final (tip >= inclusion + 18) by D - 1", () => {
  const r = row(view("bob", mkTick({ tip: D - 302, phase: "funding_final" })), "claim_target");
  assert.equal(r.target, D - 19);
  assert.match(r.label, /D − 19/);
});
