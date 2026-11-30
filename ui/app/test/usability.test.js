"use strict";
// Usability fixes found in the first live use: the lead of the first card, the funding order, the lost key, a console started before its run
// folder exists, a tick file that is being rewritten, the lock-by margin and a cut phase name in the loop history.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const http = require("http");
const path = require("path");
const V = require("../lib/viewmodel");
const A = require("../lib/actions");
const { AuditLog } = require("../lib/audit");
const { readRun, TickKeeper, TICK_WRITING_S } = require("../lib/runfolder");
const { parseLoopText, phaseChanges } = require("../lib/looptext");
const { evaluateSpend, SPENDS } = require("../lib/gate");
const { RunLock, LazyRunLock, FILE: LOCK_FILE } = require("../lib/runlock");
const { createServer } = require("../server");
const F = require("./actions-fixtures");
const { NOW, D, TERMS, mkTick, input, registerToken, withToken } = require("./helpers");

const WSL = { skipFolderCheck: true, distro: "Ubuntu-24.04", runDir: "/home/u/live-run-5", binDir: "/home/u/live-run-5/bin", runNumber: 5, repoLiveDir: "/mnt/c/repo/scripts/live" };
const TX = "0x" + "ab".repeat(32);
const APP = path.join(__dirname, "..");
const BASE = { mock: false, host: "127.0.0.1", config: path.join(APP, "swaps.json"), mockDir: path.join(APP, "mock") };
const nowS = () => Math.floor(Date.now() / 1000);

// ============================================================================================ item 5: a tick file that is being rewritten
const tickPath = (f, role = "alice") => path.join(f.run, `last-tick-${role}.json`);
const roleOf = (f, keeper, role = "alice") => readRun([f.run, f.pub], nowS(), { keeper }).roles[role];

test("tick file: empty, half-written, then complete. Never a partial tick as a valid one; the last complete tick is kept for display with its own time", () => {
  const f = F.makeFolders();
  const keeper = new TickKeeper();
  try {
    // nothing read yet and the file is empty (the helper truncated it): not a tick, not an error, nothing to show yet
    fs.writeFileSync(tickPath(f), "");
    let r = roleOf(f, keeper);
    assert.equal(r.tick, null);
    assert.equal(r.tick_writing, true);
    assert.equal(r.tick_error, null, "being written is not 'unreadable'");
    assert.equal(r.tick_cached, false);

    // a complete tick is read and remembered
    f.writeTick("alice", F.spendTick("reveal_eth"), 40);
    r = roleOf(f, keeper);
    assert.equal(r.tick_writing, false);
    assert.equal(r.tick.action.action, "reveal_eth");
    const firstMtime = r.tick_mtime;
    assert.ok(Math.abs(nowS() - 40 - firstMtime) <= 2);

    // the helper truncates it again: the page keeps the last complete tick, labelled, with ITS time (not the empty file's time)
    fs.writeFileSync(tickPath(f), "");
    r = roleOf(f, keeper);
    assert.equal(r.tick_writing, true);
    assert.equal(r.tick_cached, true);
    assert.equal(r.tick.action.action, "reveal_eth");
    assert.equal(r.tick_mtime, firstMtime, "the cached tick keeps its own file time, so its age is honest");

    // half-written JSON
    const full = JSON.stringify({ ...F.spendTick("reveal_eth"), now: nowS() });
    fs.writeFileSync(tickPath(f), full.slice(0, Math.floor(full.length / 2)));
    r = roleOf(f, keeper);
    assert.equal(r.tick_writing, true);
    assert.equal(r.tick_error, null);
    assert.equal(r.tick.action.action, "reveal_eth", "still the cached complete tick");

    // complete again: the new content, not the cache
    f.writeTick("alice", F.spendTick("reveal_eth", { held: true }), 1);
    r = roleOf(f, keeper);
    assert.equal(r.tick_writing, false);
    assert.equal(r.tick_cached, false);
    assert.equal(r.tick.action.action, "wait");
    assert.equal(r.tick.intent.status, "held");
  } finally {
    f.cleanup();
  }
});

test("tick file: an empty or broken file that has been so for a long time is an error, not 'being written'; valid JSON that is no object is no tick", () => {
  const f = F.makeFolders();
  const keeper = new TickKeeper();
  try {
    f.writeTick("alice", F.spendTick("reveal_eth"), 5);
    assert.equal(roleOf(f, keeper).tick_writing, false);
    // the file broke 10 minutes ago: nobody is writing it any more
    fs.writeFileSync(tickPath(f), "{half");
    const old = new Date(Date.now() - (TICK_WRITING_S + 600) * 1000);
    fs.utimesSync(tickPath(f), old, old);
    let r = roleOf(f, keeper);
    assert.equal(r.tick_writing, false);
    assert.equal(r.tick, null, "the cache is not used for an error that is old");
    assert.match(r.tick_error, /JSON|position|Unexpected/i);
    // an empty file just as old
    fs.writeFileSync(tickPath(f), "");
    fs.utimesSync(tickPath(f), old, old);
    r = roleOf(f, keeper);
    assert.equal(r.tick_writing, false);
    assert.match(r.tick_error, /empty/);
    // a JSON value that is not an object is never a tick
    fs.writeFileSync(tickPath(f), "12");
    r = roleOf(f, keeper);
    assert.equal(r.tick, null);
    assert.equal(r.tick_writing, false);
    assert.match(r.tick_error, /not a JSON object/);
  } finally {
    f.cleanup();
  }
});

test("gate: a tick file that is being written answers 'try again in a few seconds' (tick_writing) and nothing else; freshness is not weakened", () => {
  const spend = SPENDS["send-reveal"];
  const tick = F.spendTick("reveal_eth");
  const base = F.runWith("alice", tick);
  const ctx = (run) => ({ run, nowMs: NOW * 1000, dry: null, expectedDryCommand: "x", requireTyped: false });
  // the cached tick is on the page, but the gate must not use it
  const writing = { ...base, roles: { ...base.roles, alice: { ...base.roles.alice, tick_writing: true } } };
  const g = evaluateSpend(spend, ctx(writing));
  assert.ok(g.reasons.some((x) => x.code === "tick_writing" && /try again in a few seconds/.test(x.text)));
  assert.ok(!g.reasons.some((x) => ["tick_missing", "tick_stale", "tick_clock", "engine_action", "dry_mismatch"].includes(x.code)), JSON.stringify(g.reasons.map((x) => x.code)));
  assert.equal(g.ok, false);
  // no cache either: the same one reason, not tick_missing
  const noCache = { ...base, roles: { ...base.roles, alice: { tick: null, tick_mtime: null, tick_writing: true } } };
  assert.deepEqual(evaluateSpend(spend, ctx(noCache)).reasons.map((x) => x.code).filter((c) => c.startsWith("tick")), ["tick_writing"]);
  // a file that is broken for good keeps the old answer
  const broken = { ...base, roles: { ...base.roles, alice: { tick: null, tick_mtime: NOW - 3, tick_error: "Unexpected end of JSON input", tick_writing: false } } };
  const gb = evaluateSpend(spend, ctx(broken));
  assert.ok(gb.reasons.some((x) => x.code === "tick_missing" && /Unexpected end/.test(x.text)));
  // and an old complete tick is still stale (the freshness rule is unchanged)
  const stale = F.runWith("alice", tick, { mtime: NOW - 400 });
  assert.ok(evaluateSpend(spend, ctx(stale)).reasons.some((x) => x.code === "tick_stale"));
});

function makeRunner(f, extra = {}) {
  const log = [];
  const exec = (file, args, opts, cb) => {
    const si = args.findIndex((a) => /\.sh$/.test(a));
    const script = si >= 0 ? path.basename(args[si]) : "inline";
    const flags = si >= 0 ? args.slice(si + 1) : [];
    log.push({ script, flags });
    const n = String(100000 + log.length);
    if (script === "reveal.sh" && flags.includes("--dry-run")) f.write(`eth-claim-dry-${n}.json`, F.revealDry());
    else if (script === "reveal.sh") {
      f.write("eth-claim.json", { txHash: TX, blockNumber: 124 });
      f.write("eth-claim.err", `sent: ${TX} nonce 2\n`);
    } else if (script === "install.sh") {
      fs.mkdirSync(f.run, { recursive: true });
    }
    cb(null, "", "");
  };
  const audit = new AuditLog(f.pub, {});
  const runner = new A.ActionRunner({ ...WSL, runDirs: [f.run, f.pub] }, { audit, exec, spawnDetached: () => ({ unref() {}, on() {} }), pollWatch: false, ...extra });
  return { runner, log, audit };
}
const refusedWith = (fn) => {
  try {
    fn();
  } catch (e) {
    return e;
  }
  assert.fail("expected a refusal");
};

test("live run 13 replay: the dry run is made, the tick file is rewritten, the first click is told to wait, the dry run is NOT used up, the next click goes through", () => {
  const f = F.makeFolders();
  try {
    const { runner, log, audit } = makeRunner(f);
    f.writeTick("alice", F.spendTick("reveal_eth"), 3);
    const job = runner.startAction("dry-reveal");
    assert.equal(job.ok, true);
    assert.equal(log.length, 1);

    // the helper empties the file and runs the tick for 10 to 20 s
    fs.writeFileSync(tickPath(f), "");
    const e1 = refusedWith(() => runner.startSpend("send-reveal", "0.001 ETH"));
    assert.equal(e1.status, 422);
    assert.deepEqual(
      e1.reasons.map((r) => r.code),
      ["tick_writing"],
      "one specific reason: not tick_missing, not dry_mismatch"
    );
    assert.match(e1.reasons[0].text, /try again in a few seconds/);
    assert.equal(log.length, 1, "no helper ran");
    assert.ok(audit.tail(5).some((l) => l.action === "send-reveal" && l.phase === "refused" && /tick_writing/.test(l.result)));
    assert.equal(runner.dry.has("send-reveal"), true, "the refused click did not use up the dry run");

    // the page's view keeps the card (the cached tick) and says why the button waits
    const v1 = runner.view(readRun([f.run, f.pub], nowS()));
    assert.equal(v1.spends["send-reveal"].relevant, true);
    assert.equal(v1.spends["send-reveal"].eligible, false);
    assert.ok(v1.spends["send-reveal"].reasons.some((r) => r.code === "tick_writing"));
    assert.ok(v1.spends["send-reveal"].dry, "the dry run is still shown");

    // half of the JSON: still the same answer
    const full = JSON.stringify({ ...F.spendTick("reveal_eth"), now: nowS() });
    fs.writeFileSync(tickPath(f), full.slice(0, 200));
    assert.deepEqual(refusedWith(() => runner.startSpend("send-reveal", "0.001 ETH")).reasons.map((r) => r.code), ["tick_writing"]);

    // the tick is complete: the same dry run authorizes the send
    f.writeTick("alice", F.spendTick("reveal_eth"), 1);
    const sent = runner.startSpend("send-reveal", "0.001 ETH");
    assert.equal(sent.ok, true);
    assert.deepEqual(log[1], { script: "reveal.sh", flags: [] });
    assert.equal(runner.dry.has("send-reveal"), false, "a dry run authorizes one start, and it is used now");
  } finally {
    f.cleanup();
  }
});

test("a tick file broken for good is still tick_missing (with the parse error), never 'being written'", () => {
  const f = F.makeFolders();
  try {
    const { runner } = makeRunner(f);
    f.writeTick("alice", F.spendTick("reveal_eth"), 3);
    runner.startAction("dry-reveal");
    fs.writeFileSync(tickPath(f), "{half");
    const old = new Date(Date.now() - 700 * 1000);
    fs.utimesSync(tickPath(f), old, old);
    const codes = refusedWith(() => runner.startSpend("send-reveal", "0.001 ETH")).reasons.map((r) => r.code);
    assert.ok(codes.includes("tick_missing"));
    assert.ok(!codes.includes("tick_writing"));
  } finally {
    f.cleanup();
  }
});

test("view model: while the tick file is rewritten the page says so (info), keeps the cached tick, and a missing first tick is not 'no tick yet'", () => {
  const tick = mkTick({});
  const v = V.buildView({ ...input("alice", tick), tick_writing: true });
  assert.ok(v.alarms.some((a) => a.id === "tick-writing" && a.level === "info" && /last complete tick/.test(a.text)));
  const none = V.buildView({ ...input("alice", null), tick_writing: true });
  assert.ok(none.alarms.some((a) => a.id === "tick-writing" && /no complete tick has been read yet/.test(a.text)));
  assert.ok(!none.alarms.some((a) => a.id === "no-tick"));
  assert.ok(!V.buildView(input("alice", tick)).alarms.some((a) => a.id === "tick-writing"));
});

// ============================================================================================ item 6b: a cut phase name
test("loop history: a line whose phase name was cut yields no phase and no phase change; a short line with a new phase name keeps it", () => {
  const mk = (t, pad, name) => `${t} [alice] tick exit 0 at ${t} noid: tip 1 ACTION: {"action": "wait", "reason": "r"} notes: ["${pad}"] intent: {"status": "none"} applied: True phase_after: ${name}`;
  // a line cut by the old helper in the middle of "lock_final": exactly 1200 characters, ending "phase_after: re"
  const pad = "x".repeat(1198 - mk("10:00:30", "", "").length);
  const fragLine = mk("10:00:30", pad, "re");
  assert.equal(fragLine.length, 1200);
  const text = [mk("10:00:00", "", "lock_final"), fragLine, mk("10:01:00", "", "lock_final"), mk("10:01:30", "", "revealed")].join(String.fromCharCode(10));
  const { entries } = parseLoopText(text);
  assert.equal(entries.length, 4);
  assert.equal(entries[0].phase_after, "lock_final");
  assert.equal(entries[1].phase_after, null, "a fragment is not a phase");
  assert.equal(entries[1].truncated, true);
  assert.equal(entries[1].action, "wait", "the rest of the line is still shown");
  assert.equal(entries[3].phase_after, "revealed");
  assert.deepEqual(phaseChanges(entries), [{ time: "10:01:30", from: "lock_final", to: "revealed" }], "no 'lock_final -> re' and no 're -> revealed'");
  assert.deepEqual(V.buildView({ ...input("alice", mkTick({})), loop: { entries, total: 4 } }).history.changes, [{ time: "10:01:30", from: "lock_final", to: "revealed" }]);
  // a complete name on a long line is kept
  assert.equal(parseLoopText(mk("10:00:30", pad, "lock_final")).entries[0].phase_after, "lock_final");
  // a short line is not a cut line: an unknown (future) phase name is shown as the engine wrote it
  const novel = parseLoopText(`10:02:00 [alice] tick exit 0 at 10:02:00 ACTION: {"action": "wait"} applied: True phase_after: brand_new_phase`);
  assert.equal(novel.entries[0].phase_after, "brand_new_phase");
  // the new shape of the helper: every part cut on its own, the line always ends with applied / phase_after
  const newShape = parseLoopText(`10:03:00 [bob] tick exit 0 at 10:03:00 noid: tip 5 ACTION: {"action": "wait", "reason": "waiting"} notes: ["a long note…"] intent: {"status": "held"} applied: True phase_after: lock_submitted`);
  assert.equal(newShape.entries[0].phase_after, "lock_submitted");
  assert.equal(newShape.entries[0].truncated, false);
  assert.equal(newShape.entries[0].intent_status, "held");
});

// ============================================================================================ item 6a: the lock-by note (the engine's, not the console's)
test("lock-by: the console computes no margin; it shows the engine's own note (the real last lock height), loud only as the engine's words are", () => {
  const E = require("../lib/enginetext");
  const note = (text, extra = {}) => V.buildView({ ...input("bob", mkTick({ tip: TERMS.lock_by_height - 10, phase: "funding_final", notes: [text], ...extra })) });
  // the engine's note, as it prints it (swap-cli/src/engine.rs lock_by_margin_note)
  const long = "lock margin: 40 blocks to the last lock height 281300 (nominal lock-by 281262, tip 281260)";
  let v = note(long);
  assert.deepEqual(v.lock_by_note, { text: long, level: "quiet", stale: false });
  assert.equal(v.lock_by_margin, undefined, "the console's own margin is gone");
  v = note("lock margin is short: 8 blocks to the last lock height 281300 (nominal lock-by 281262, tip 281292); see the action");
  assert.equal(v.lock_by_note.level, "warn");
  v = note("the last lock height 281300 has passed (nominal lock-by 281262, tip 281310)");
  assert.equal(v.lock_by_note.level, "danger");
  v = note("nominal lock-by 281262 has passed (tip 281270); the lock is still allowed until the hard limit 281300");
  assert.equal(v.lock_by_note.level, "danger", "'has passed' is the engine's word; the note itself says the lock is still allowed and the page shows it whole");
  assert.match(v.lock_by_note.text, /the lock is still allowed until the hard limit 281300/);
  // the deadline row shows the nominal number and the engine's note, and counts nothing
  const row = v.deadlines.find((d) => d.id === "lock_by");
  assert.equal(row.engine_note, v.lock_by_note.text);
  assert.equal(row.no_countdown, true);
  assert.equal(row.blocks_left, undefined);
  // no note, no chip: the console does not fill the gap with its own number
  assert.equal(V.buildView({ ...input("alice", mkTick({ tip: TERMS.lock_by_height - 10, phase: "funding_final" })) }).lock_by_note, null);
  // the engine prints it only before the lock is seen, so after that there is none to show (and the console invents none); a finished swap shows none
  assert.equal(V.buildView({ ...input("alice", mkTick({ phase: "aborted", notes: [long] })) }).lock_by_note, null);
  assert.equal(V.buildView(input("alice", null)).lock_by_note, null);
  // an old tick labels it
  const old = V.buildView({ ...input("bob", mkTick({ now: NOW - 300, noidObservedAt: NOW - 304, ethObservedAt: NOW - 304, phase: "funding_final", notes: [long] })), tick_mtime: NOW - 300 });
  assert.equal(old.lock_by_note.stale, true);
  // only the engine's lock-by sentences are picked: other notes are not lock-by notes
  assert.equal(E.lockByNote(["the funding window of nobody", "something about lock-by in the middle: lock-by margin"]), null);
  assert.equal(E.lockByNote(["funding window: 200 blocks left before it is too late to fund (lock-by 281262, tip 281000)"]).slice(0, 14), "funding window");
});

// ============================================================================================ items 1 and 2: what leads the first card, and the funding order
const spendEntry = (id, kind, role, title, o = {}) => ({ id, kind, role, label: title, replace: !!o.replace, relevant: o.relevant !== false, eligible: false, plain: { title }, ...o });
const actionsOf = (spends, funding = {}) => ({ enabled: true, spends: Object.fromEntries(spends.map((s) => [s.id, s])), funding: { object_check_ok: false, acknowledged_at: null, marker_at: null, blocked_by: null, ...funding } });

test("lead: when a spend of this console's role is relevant, the card is titled by the step; otherwise nothing leads", () => {
  const v = (role, tick) => V.buildView(input(role, tick));
  const alice = v("alice", F.spendTick("fund_noid"));
  const fund = actionsOf([spendEntry("send-fund", "fund_noid", "alice", "Fund 5 NOID")]);
  const lead = V.leadAction(alice, fund);
  assert.equal(lead.id, "send-fund");
  assert.equal(lead.title, "fund 5 NOID");
  // the reveal is titled "reveal the secret"; a re-send keeps its words and the amount
  assert.equal(V.leadAction(v("alice", F.spendTick("reveal_eth", { held: true })), actionsOf([spendEntry("send-reveal", "reveal_eth", "alice", "Reveal the secret and claim 0.001 ETH")])).title, "reveal the secret");
  assert.equal(V.leadAction(v("alice", F.spendTick("reveal_eth", { held: true })), actionsOf([spendEntry("send-reveal-replace", "reveal_eth", "alice", "Re-send the stuck reveal (0.001 ETH)", { replace: true })])).title, "re-send the stuck reveal (0.001 ETH)");
  assert.equal(V.leadAction(v("bob", F.spendTick("lock_eth")), actionsOf([spendEntry("send-lock", "lock_eth", "bob", "Lock 0.001 ETH")])).title, "lock 0.001 ETH");
  // a held intent: the engine's action is "wait", the step still leads
  const held = v("alice", F.spendTick("reveal_eth", { held: true }));
  assert.equal(held.action.kind, "wait");
  assert.equal(V.leadAction(held, actionsOf([spendEntry("send-reveal", "reveal_eth", "alice", "Reveal the secret and claim 0.001 ETH")])).id, "send-reveal");
  // nothing relevant, another role's spend, another machine, actions off, no tick: no lead
  assert.equal(V.leadAction(alice, actionsOf([spendEntry("send-fund", "fund_noid", "alice", "Fund 5 NOID", { relevant: false })])), null);
  assert.equal(V.leadAction(alice, actionsOf([spendEntry("send-lock", "lock_eth", "bob", "Lock 0.001 ETH")])), null);
  assert.equal(V.leadAction(alice, { enabled: false }), null);
  assert.equal(V.leadAction(alice, undefined), null);
  assert.equal(V.leadAction(v("alice", null), fund), null);
});

test("lead kinds: a fresh intent is 'your move'; a held one is 'decided earlier' with no command; the funding is never 'your move'", () => {
  const v = (role, tick) => V.buildView(input(role, tick));
  const reveal = actionsOf([spendEntry("send-reveal", "reveal_eth", "alice", "Reveal the secret and claim 0.001 ETH")]);
  const fresh = V.leadAction(v("alice", F.spendTick("reveal_eth")), reveal);
  assert.equal(fresh.kind, "move");
  assert.equal(fresh.heading, "Next: reveal the secret");
  assert.equal(fresh.chip, "your move");
  const held = V.leadAction(v("alice", F.spendTick("reveal_eth", { held: true })), reveal);
  assert.equal(held.kind, "decided");
  assert.equal(held.heading, "Reveal: decided earlier");
  assert.match(held.chip, /^decided earlier: send only if you have not$/);
  assert.doesNotMatch(held.heading + held.chip, /Next:|your move/);
  assert.equal(V.leadAction(v("alice", F.spendTick("reveal_eth", { held: true })), actionsOf([spendEntry("send-reveal-replace", "reveal_eth", "alice", "Re-send the stuck reveal (0.001 ETH)", { replace: true })])).heading, "Re-send the reveal: decided earlier");
  const lock = actionsOf([spendEntry("send-lock", "lock_eth", "bob", "Lock 0.001 ETH")]);
  assert.equal(V.leadAction(v("bob", F.spendTick("lock_eth")), lock).kind, "move");
  assert.equal(V.leadAction(v("bob", F.spendTick("lock_eth", { held: true })), lock).heading, "Lock: decided earlier");
  // the NOID claim has no intent: it is a fresh decision of the tick
  const claim = V.leadAction(v("bob", F.spendTick("claim_noid")), actionsOf([spendEntry("send-claim", "claim_noid", "bob", "Claim 5 NOID")]));
  assert.equal(claim.kind, "move");
  // the funding, recorded or held: "Funding", no chip, never "your move"
  const fund = actionsOf([spendEntry("send-fund", "fund_noid", "alice", "Fund 5 NOID")]);
  for (const o of [{}, { held: true }]) {
    const l = V.leadAction(v("alice", F.spendTick("fund_noid", o)), fund);
    assert.equal(l.kind, "funding");
    assert.equal(l.heading, "Funding");
    assert.equal(l.chip, null);
    assert.equal(l.title, "fund 5 NOID");
  }
  // and the order of the funding (its step 3, the acknowledgement) is offered with it
  const g = V.fundingGuide(v("alice", F.spendTick("fund_noid", { held: true })), fund);
  assert.equal(g.done, false);
  assert.match(g.steps[2], /I have funded/);
});

test("funding order: from the start while the file is at 'created' (also before the engine offers it), until a marker or an acknowledgement exists", () => {
  const waiting = V.buildView(input("alice", mkTick({ phase: "created", action: { action: "wait", reason: "too early to fund: the funding opens at height 299698 (tip 299600); a funding before it would lock the NOID for more than twice the swap's planned length (D 300302 is 302 blocks after H_create 300000)" } })));
  assert.equal(waiting.action.kind, "wait");
  assert.equal(V.leadAction(waiting, actionsOf([])), null, "the engine has not offered the funding");
  const g = V.fundingGuide(waiting, actionsOf([]));
  assert.ok(g && g.done === false, "but the order is shown");
  assert.equal(g.steps.length, 3);
  assert.match(g.title, /^Fund from here, right after Bob's check$/);
  assert.match(g.steps[0], /join\.sh, or new-bob/);
  assert.match(g.steps[0], /bundle check/);
  assert.match(g.steps[1], /Do it from here/);
  assert.match(g.steps[1], /before h_create/);
  assert.match(g.steps[2], /^Only if you funded outside this console: tick "I have funded"/);
  assert.match(g.alternative, /fund\.sh --dry-run, then fund\.sh, once/);
  assert.match(g.alternative, /alternative/);
  assert.doesNotMatch([g.title, ...g.steps, g.alternative].join(" "), /opens only at|from a terminal, right/);
  // once the engine offers it the order is still there (above the button that sends it)
  const offered = V.buildView(input("alice", F.spendTick("fund_noid")));
  assert.equal(V.fundingGuide(offered, actionsOf([spendEntry("send-fund", "fund_noid", "alice", "Fund 5 NOID")])).done, false);
  // a marker, an acknowledgement or a contract marker closes the order
  for (const funding of [{ marker_at: "2026-11-06T11:46:09Z" }, { acknowledged_at: 1800000000, marker_at: "2026-11-06T11:46:09Z", marker_acknowledged: true }, { blocked_by: "the contract's marker funded-o1x.marker next to the object file" }]) {
    const d = V.fundingGuide(waiting, actionsOf([], funding));
    assert.equal(d.done, true);
    assert.match(d.done_text, /never offered again|Do not fund a second time/);
  }
  assert.match(V.fundingGuide(waiting, actionsOf([], { acknowledged_at: 1, marker_acknowledged: true })).done_text, /told this console/);
  // not for Bob, not outside actions mode, not once past 'created'
  assert.equal(V.fundingGuide(V.buildView(input("bob", mkTick({ phase: "received" }))), actionsOf([])), null);
  assert.equal(V.fundingGuide(waiting, { enabled: false }), null);
  assert.equal(V.fundingGuide(V.buildView(input("alice", mkTick({ phase: "funding_final" }))), actionsOf([])), null);
  assert.equal(V.fundingGuide(V.buildView(input("alice", mkTick({ phase: "funded" }))), actionsOf([])), null);
});

// ============================================================================================ item 4: a console started before its run folder exists
test("LazyRunLock: no lock while the folder is missing; taken as soon as it exists; a live holder is never replaced; release removes only ours", () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "noid-lazy-"));
  try {
    const dir = path.join(base, "live-run-9");
    const lock = new LazyRunLock(dir, { role: "alice" });
    assert.equal(lock.held, false);
    let v = lock.verify();
    assert.equal(v.ok, false);
    assert.equal(v.folder_missing, true);
    assert.match(v.why, /does not exist yet/);
    assert.match(v.why, /Install helpers/);
    assert.equal(fs.existsSync(dir), false, "nothing was created");
    assert.deepEqual(lock.status(), { held: false, folder_missing: true, why: v.why, replaced: null });
    // the folder appears (the install step): the next look takes the lock
    fs.mkdirSync(dir);
    v = lock.verify();
    assert.deepEqual(v, { ok: true });
    assert.equal(lock.held, true);
    assert.equal(JSON.parse(fs.readFileSync(path.join(dir, LOCK_FILE), "utf8")).pid, process.pid);
    assert.deepEqual(lock.status(), { held: true, folder_missing: false, why: null, replaced: null });
    lock.release();
    assert.equal(fs.existsSync(path.join(dir, LOCK_FILE)), false);
    // a folder that exists whose lock is held by a live console: not "missing", not held
    const other = new LazyRunLock(dir, { role: "bob" });
    const holder = RunLock.acquire(dir, { pid: process.pid, now: () => Date.UTC(2026, 10, 6, 12, 0, 0) });
    const w = other.verify();
    assert.equal(w.ok, false);
    assert.equal(w.folder_missing, false);
    assert.match(w.why, /already running/);
    holder.release();
    assert.equal(other.verify().ok, true, "and once the holder is gone the lock is taken");
    other.release();
    // a path that is a file is a problem, not "not yet"
    fs.writeFileSync(path.join(base, "afile"), "x");
    assert.equal(LazyRunLock.exists(path.join(base, "afile")), true, "a file where the folder should be is not \"not yet\"");
    const odd = new LazyRunLock(path.join(base, "afile"));
    assert.equal(odd.verify().ok, false);
    assert.equal(odd.verify().folder_missing, false);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

function raw(port, { method = "GET", path: p = "/", headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, method, path: p, headers: { host: `127.0.0.1:${port}`, ...withToken(port, method, headers) } }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        let json = null;
        try {
          json = JSON.parse(text);
        } catch {
          /* not json */
        }
        resolve({ status: res.statusCode, text, json });
      });
    });
    req.on("error", reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

test("start on a missing run folder: no lock at start, only install runs, the lock is taken when the folder exists, spends refuse until then", async () => {
  const f = F.makeFolders();
  fs.rmSync(f.run, { recursive: true, force: true });
  const calls = [];
  const exec = (file, args, opts, cb) => {
    const si = args.findIndex((a) => /\.sh$/.test(a));
    const script = si >= 0 ? path.basename(args[si]) : "inline";
    calls.push(script);
    if (script === "install.sh") fs.mkdirSync(f.run, { recursive: true }); // what the real helper does
    cb(null, "installed 15 scripts\n", "");
  };
  const server = createServer({ ...BASE, runDirs: [f.run, f.pub], allowActions: true, skipFolderCheck: true, wslDistro: "Ubuntu-24.04", wslRunDir: "/home/u/live-run-5", helpersDir: "/home/u/live-run-5/bin", repoLiveDir: "/mnt/c/repo/scripts/live", actionsDeps: { exec, spawnDetached: () => ({ unref() {}, on() {} }), pollWatch: false } });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = registerToken(server);
  const ok = { origin: `http://127.0.0.1:${port}`, "content-type": "application/json", "x-swap-token": server.runToken, "sec-fetch-site": "same-origin" };
  const post = (p, body) => raw(port, { method: "POST", path: p, headers: ok, body: JSON.stringify(body) });
  try {
    assert.equal(server.runLock.isLazy, true);
    assert.equal(fs.existsSync(f.run), false, "starting did not create the run folder");
    // the page is told
    const run = (await raw(port, { path: "/api/run" })).json;
    assert.equal(run.actions.enabled, true);
    assert.equal(run.actions.lock.held, false);
    assert.equal(run.actions.lock.folder_missing, true);
    assert.match(run.actions.lock.why, /run folder does not exist yet.*Install helpers/);
    // every other action and every spend refuses before anything runs
    for (const id of ["setup", "prepare", "check-object", "tick-alice", "dry-reveal", "watch-start"]) {
      const r = await post("/api/action", { id });
      assert.equal(r.status, 409, id + " " + r.text);
      assert.match(r.json.error, /does not exist yet/);
    }
    const sp = await post("/api/spend", { id: "send-reveal", typed: "0.001 ETH" });
    assert.equal(sp.status, 409);
    assert.match(sp.json.error, /does not exist yet/);
    const nf = await post("/api/newswap", { fields: {}, replace: false });
    assert.equal(nf.status, 409, "the settings form needs the folder (and the lock) too");
    assert.equal((await post("/api/funded", { checked: true })).status, 409);
    assert.deepEqual(calls, [], "nothing ran");
    // the refusals leave a line each (action and settings form), not only the spend's
    for (const id of ["setup", "watch-start", "newswap"]) assert.ok(server.actions.audit.all().some((l) => l.action === id && l.phase === "refused" && /run folder does not exist/.test(l.result)), id);
    // install is allowed
    const inst = await post("/api/action", { id: "install" });
    assert.equal(inst.status, 202, inst.text);
    assert.deepEqual(calls, ["install.sh"]);
    assert.equal(fs.existsSync(f.run), true);
    // the next look takes the lock; the other actions then work
    const run2 = (await raw(port, { path: "/api/run" })).json;
    assert.equal(run2.actions.lock.held, true);
    assert.equal(run2.actions.lock.folder_missing, false);
    const lockFile = path.join(f.run, LOCK_FILE);
    assert.equal(JSON.parse(fs.readFileSync(lockFile, "utf8")).pid, process.pid);
    assert.equal(server.runLock.verify().ok, true);
    await new Promise((r) => setTimeout(r, 2100)); // the per-id rate limit
    assert.equal((await post("/api/action", { id: "setup" })).status, 202);
    assert.deepEqual(calls, ["install.sh", "setup.sh"]);
    // the audit log recorded the refusal of the spend
    assert.ok(server.actions.audit.all().some((l) => l.action === "send-reveal" && l.phase === "refused" && /run folder does not exist/.test(l.result)));
  } finally {
    await new Promise((r) => server.close(r));
    assert.equal(fs.existsSync(path.join(f.run, LOCK_FILE)), false, "released on close");
    f.cleanup();
  }
});

test("start on a missing run folder: when it appears with a lock held by a live console, nothing runs, not even install; the audit folder is made when missing", async () => {
  const f = F.makeFolders();
  fs.rmSync(f.run, { recursive: true, force: true });
  fs.rmSync(f.pub, { recursive: true, force: true });
  const calls = [];
  const server = createServer({ ...BASE, runDirs: [f.run, f.pub], allowActions: true, skipFolderCheck: true, wslDistro: "Ubuntu-24.04", wslRunDir: "/home/u/live-run-5", helpersDir: "/home/u/live-run-5/bin", repoLiveDir: "/mnt/c/repo/scripts/live", actionsDeps: { exec: (a, b, c, cb) => (calls.push(b), cb(null, "", "")), spawnDetached: () => ({ unref() {}, on() {} }), pollWatch: false } });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = registerToken(server);
  const ok = { origin: `http://127.0.0.1:${port}`, "content-type": "application/json", "x-swap-token": server.runToken, "sec-fetch-site": "same-origin" };
  try {
    assert.equal(fs.existsSync(f.pub), true, "the audit folder was made");
    assert.equal(fs.existsSync(path.join(f.pub, "ui-audit.jsonl")), true);
    // another console (this very process, standing in for it) takes the folder first
    fs.mkdirSync(f.run, { recursive: true });
    const other = RunLock.acquire(f.run, { pid: process.pid, now: () => Date.UTC(2026, 10, 6, 12, 0, 0) });
    const r = await raw(port, { method: "POST", path: "/api/action", headers: ok, body: JSON.stringify({ id: "install" }) });
    assert.equal(r.status, 409);
    assert.match(r.json.error, /does not hold the run folder's lock/);
    assert.match(r.json.error, /already running/);
    assert.deepEqual(calls, []);
    const run = (await raw(port, { path: "/api/run" })).json;
    assert.equal(run.actions.lock.held, false);
    assert.equal(run.actions.lock.folder_missing, false);
    other.release();
  } finally {
    await new Promise((r) => server.close(r));
    f.cleanup();
  }
});

test("a console started on an existing run folder behaves as before: the lock is taken at start and a second console is refused", async () => {
  const f = F.makeFolders();
  try {
    const opts = { ...BASE, runDirs: [f.run, f.pub], allowActions: true, skipFolderCheck: true, wslDistro: "U", wslRunDir: "/home/u/live-run-5", helpersDir: "/home/u/live-run-5/bin", repoLiveDir: "/r/scripts/live" };
    const a = createServer(opts);
    assert.equal(a.runLock.isLazy, undefined);
    assert.ok(fs.existsSync(path.join(f.run, LOCK_FILE)));
    assert.throws(() => createServer(opts), /another console is already running/);
    await new Promise((r) => a.close(r));
  } finally {
    f.cleanup();
  }
});
