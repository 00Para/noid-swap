"use strict";
// The read-only steps of piece 4 (step 4.1): tick, the watch loop, wallet status, board digest / verify / balance. Test names say which case of
// scripts/live/selftest.sh they port: "(sN ...)" = section N. The two tools are the stubs of steps-fixtures/; no network, no shell, no WSL.
const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { tick, summaryLines, pyDumps, pyRepr, pyStr } = require("../lib/steps/tick");
const { createWatch, loopLine, terminalOf } = require("../lib/steps/watch");
const { walletStatus } = require("../lib/steps/walletstatus");
const { boardDigest, boardVerify, boardBalance } = require("../lib/steps/boardread");
const { makeHarness } = require("./steps-fixtures/harness");
const { makeSettings, ALICE_NOID, ALICE_ETH, BOB_ETH } = require("./steps-fixtures/settings");

const sha = (s) => crypto.createHash("sha256").update(s).digest("hex");
const H = [];
function harness(o) {
  const h = makeHarness(o);
  H.push(h);
  return h;
}
test.after(() => {
  for (const h of H) h.cleanup();
});
const p2 = (n) => String(n).padStart(2, "0");
const localClock = (ms) => {
  const d = new Date(ms);
  return `${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}`;
};
const localStamp = (ms) => localClock(ms).replace(/:/g, "");

const TICK = (o = {}) =>
  JSON.stringify({
    noid: { tip: 281108, instance: { slot_index: 7 }, instance_matches_opening: true, pending_calls: [], confirmed_tx: null, tracked_tx_pending: null },
    eth: { latest_block: 1416, finalized_block: 1400, latest_timestamp: 1800000000, lock: { amount: "1" }, claimed: null, pending_preimage: null, refunded: null },
    sources: { a: 1 },
    events: [],
    action: { action: "wait", reason: "the lock is not final yet" },
    notes: ["one"],
    intent: null,
    events_applied_to_file: true,
    phase_after: "lock_final",
    ...o,
  });

// ---------------------------------------------------------------------------------------------------------------------------------
// Python's wording of the summary

test("the summary prints values the way python3 did in tick.sh: None, True, False, json.dumps with its separators and ASCII escapes", () => {
  assert.equal(pyDumps({ a: [1, "x\u00e9", null, true], b: {} }), '{"a": [1, "x\\u00e9", null, true], "b": {}}');
  assert.equal(pyDumps("\u007f\n"), '"\\u007f\\n"');
  assert.equal(pyDumps(undefined), "null");
  assert.equal(pyRepr({ a: [null, true, false, "it's", 'say "x"', "b'\"c"] }), "{'a': [None, True, False, \"it's\", 'say \"x\"', 'b\\'\"c']}");
  assert.equal(pyStr("plain"), "plain");
  assert.equal(pyStr(null), "None");
  assert.equal(pyStr(5), "5");
  assert.equal(pyStr(["a"]), "['a']");
  const L = summaryLines(TICK());
  assert.equal(L[0], 'noid: tip 281108 instance {"slot_index": 7} matches True pending 0 confirmed null tracked_pending None');
  assert.equal(L[1], 'eth : latest 1416 finalized 1400 ts 1800000000 lock {"amount": "1"} claimed null pending_preimage None refunded null');
  assert.equal(L[2], 'sources: {"a": 1}');
  assert.equal(L[3], "events: []");
  assert.equal(L[4], 'ACTION: {"action": "wait", "reason": "the lock is not final yet"}');
  assert.equal(L[5], 'notes: ["one"]');
  assert.equal(L[6], "intent: null");
  assert.equal(L[7], "applied: True phase_after: lock_final");
  assert.equal(summaryLines("").length, 1);
  assert.match(summaryLines("")[0], /^no json: Expecting value/);
  assert.match(summaryLines("{oops")[0], /^no json: /);
  assert.equal(summaryLines("[1]"), null);
  const longIntent = summaryLines(TICK({ intent: { blob: "Z".repeat(1000) } })).find((l) => l.startsWith("intent:"));
  assert.equal(longIntent.length, "intent: ".length + 300, "each JSON part is cut like the helper cuts it");
  assert.equal(summaryLines(TICK({ noid: [1], eth: "x" }))[0], "noid: tip None instance null matches None pending 0 confirmed null tracked_pending None", "a part that is not an object counts as empty");
});

// ---------------------------------------------------------------------------------------------------------------------------------
// tick (scripts/live/tick.sh)

test("tick: the command line is the helper's (nodes, log start, reveal tx, --record-noid, --record-eth, the extra flags), the passphrase is given to swap-cli only, stdin is closed", async () => {
  const h = harness({ settings: { noid_rpc2: "http://127.0.0.1:9602", eth_rpc2: "https://second.example/rpc" } });
  h.swapFile("alice");
  h.write("eth-deploy-block.txt", "123456\n");
  h.write("reveal-reverted-tx.txt", `0x${"cd".repeat(32)}\n`);
  h.scenario({ swapCli: { tick: { stdout: TICK(), stderr: "e1\ne2\n", touch: true } } });
  const r = await tick(h.ctx, "alice", { args: ["--apply"] });
  assert.equal(r.code, 0);
  const c = h.calls("swapCli")[0];
  const stamp = localStamp(h.ctx.now());
  assert.deepEqual(c.argv, [
    "tick",
    path.join(h.runDir, "alice.swap.json"),
    "--transport", "curl", "--noid-rpc", "http://127.0.0.1:9601", "--eth-rpc", "https://ethereum-sepolia-rpc.publicnode.com", "--rpc-timeout", "60",
    "--noid-rpc", "http://127.0.0.1:9602", "--eth-rpc", "https://second.example/rpc",
    "--curl-path", h.ctx.tools.curl,
    "--eth-from-block", "123456",
    "--reveal-tx", `0x${"cd".repeat(32)}`,
    "--record-noid", path.join(h.runDir, "rec", `alice-noid-${stamp}.json`),
    "--record-eth", path.join(h.runDir, "rec", `alice-eth-${stamp}.json`),
    "--apply",
  ]);
  assert.deepEqual([c.pass, c.passMatches, c.stdin.length, c.cwd], [true, true, 0, h.runDir]);
  assert.deepEqual(r.files, ["last-tick-alice.json", "last-tick-alice.err", `rec/alice-noid-${stamp}.json`, `rec/alice-eth-${stamp}.json`]);
  assert.equal(h.read("last-tick-alice.json"), TICK());
  assert.equal(h.read("last-tick-alice.err"), "e1\ne2\n");
});

test("tick: the output is the one-screen summary: header with the exit status and the time, the first five lines of the error file, then the parts", async () => {
  const h = harness({ settings: { role: "bob" } });
  h.swapFile("bob");
  h.scenario({ swapCli: { tick: { stdout: TICK(), stderr: "l1\nl2\nl3\nl4\nl5\nl6\nl7\n", code: 1 } } });
  const r = await tick(h.ctx, "bob");
  assert.equal(r.code, 1, "swap-cli's own exit code");
  const lines = r.stdout.split("\n");
  assert.equal(lines[0], `[bob] tick exit 1 at ${localClock(h.ctx.now())}`);
  assert.deepEqual(lines.slice(1, 6), ["l1", "l2", "l3", "l4", "l5"]);
  assert.match(lines[6], /^noid: tip 281108/);
  assert.equal(lines.at(-2), "applied: True phase_after: lock_final");
  assert.match(r.stderr, /^NOTE: no second node/);
  const h2 = harness({ settings: { role: "bob" } });
  h2.swapFile("bob");
  h2.scenario({ swapCli: { tick: { stdout: "not json\n", stderr: "bad\n", code: 1 } } });
  const r2 = await tick(h2.ctx, "bob");
  assert.match(r2.stdout, /^\[bob\] tick exit 1 at .*\nbad\nno json: /);
});

test("(s12) tick: each ALERT: note is a line of its own, and so is the pending-claim ALARM: note; other ALARM notes are not", async () => {
  const h = harness({ settings: { role: "bob" } });
  h.swapFile("bob");
  h.scenario({ swapCli: { tick: { stdout: TICK({ notes: ["one", "ALERT: line one of the notes", "two", "ALERT: line two"] }) } } });
  const a = await tick(h.ctx, "bob");
  assert.equal(a.stdout.split("\n").filter((l) => l.startsWith("ALERT:")).length, 2);
  h.scenario({ swapCli: { tick: { stdout: TICK({ notes: ["one", "ALARM: the NOID claim is still pending (not seen mined) and the next call height 99", "ALARM: another thing", "two"] }) } } });
  const b = await tick(h.ctx, "bob");
  assert.equal(b.stdout.split("\n").filter((l) => l.startsWith("ALARM: the NOID claim is still pending")).length, 1);
  assert.equal(b.stdout.split("\n").filter((l) => l.startsWith("ALARM: another")).length, 0);
});

test("tick: the files are opened before the tool runs (the console reads a half-written tick as being written), and rec/ is made", async () => {
  const h = harness();
  h.swapFile("alice");
  h.write("last-tick-alice.json", "OLD CONTENT OLD CONTENT OLD CONTENT");
  h.scenario({ swapCli: { tick: { hang: true } } });
  const p = tick(h.ctx, "alice", { limitMs: 2500 });
  for (let i = 0; i < 60 && h.read("last-tick-alice.json") !== ""; i++) await new Promise((r) => setTimeout(r, 50));
  assert.equal(h.read("last-tick-alice.json"), "", "emptied while the tool runs");
  assert.ok(fs.statSync(path.join(h.runDir, "rec")).isDirectory());
  const r = await p;
  assert.equal(r.code, 124, "the limit was hit: the helper convention");
  assert.match(r.stdout, /^\[alice\] tick exit 124 at /);
});

test("tick: a refusal is code 2 and no tool runs: another role's step, a role that is neither, a flag that is not passed on, a missing swap-cli, no passphrase, a bad log start file", async () => {
  const h = harness();
  h.swapFile("bob");
  h.scenario({ swapCli: { tick: { stdout: TICK() } } });
  const no = async (promise, re) => {
    const r = await promise;
    assert.equal(r.code, 2);
    assert.match(r.stderr, re);
    assert.equal(h.calls().length, 0, "no tool ran");
  };
  await no(tick(h.ctx, "bob"), /this run is alice's/);
  await no(tick(h.ctx, "carol"), /role must be alice or bob/);
  h.swapFile("alice");
  await no(tick(h.ctx, "alice", { args: ["--apply", "--apply"] }), /not one this step passes on/);
  await no(tick(h.ctx, "alice", { args: ["--record-noid", "/etc/x"] }), /not one this step passes on/);
  await no(tick(h.ctx, "alice", { args: ["--closed-by", "short"] }), /not one this step passes on/);
  await no(tick(h.ctx, "alice", { args: ["--closed-by"] }), /not one this step passes on/);
  await no(tick({ ...h.ctx, tools: { ...h.ctx.tools, swapCli: [path.join(h.root, "nope")] } }, "alice"), /swap-cli not found/);
  h.write("eth-deploy-block.txt", "garbage\n");
  await no(tick(h.ctx, "alice"), /does not hold one whole number/);
  fs.rmSync(path.join(h.runDir, "eth-deploy-block.txt"));
  const h2 = harness({ passphrase: null });
  h2.swapFile("alice");
  const r = await tick(h2.ctx, "alice");
  assert.equal(r.code, 2);
  assert.match(r.stderr, /passphrase/);
  assert.equal(h2.calls().length, 0);
  assert.equal(h2.exists("last-tick-alice.json"), false, "nothing was opened");
});

test("tick: --apply and --closed-by TXID (with or without 0x) are passed on, in the order given; swap-cli that cannot be started is exit 127", async () => {
  const h = harness();
  h.swapFile("alice");
  h.scenario({ swapCli: { tick: { stdout: TICK() } } });
  const tx = "ef".repeat(32);
  await tick(h.ctx, "alice", { args: ["--closed-by", tx, "--apply"] });
  await tick(h.ctx, "alice", { args: ["--closed-by", `0x${tx}`] });
  const [a, b] = h.calls("swapCli");
  assert.deepEqual(a.argv.slice(-3), ["--closed-by", tx, "--apply"]);
  assert.deepEqual(b.argv.slice(-2), ["--closed-by", `0x${tx}`]);
});

test("tick: a tool that cannot be started is exit 127 with the reason on stderr", async () => {
  const h = harness();
  h.swapFile("alice");
  const exe = path.join(h.root, process.platform === "win32" ? "ghost.exe" : "ghost");
  fs.writeFileSync(exe, "not a program");
  const r = await tick({ ...h.ctx, tools: { ...h.ctx.tools, swapCli: [exe] } }, "alice");
  assert.equal(r.code, 127);
  assert.match(r.stderr, /swap-cli could not be started/);
});

// ---------------------------------------------------------------------------------------------------------------------------------
// the watch loop (scripts/live/watch.sh)

const Z = "Z".repeat(3000);
const M = "0".repeat(1500);
/** The output the stub tick.sh of section 10 prints for tick number n in a mode. */
function stubTick(mode) {
  let n = 0;
  return async (ctx, role, o) => {
    assert.deepEqual(o, { args: ["--apply"] }, "the loop always applies");
    n++;
    let ph = "lock_final";
    let act = '{"action": "wait", "reason": "the lock is not final yet"}';
    if (mode === "long" && n >= 2) ph = "refunded";
    if (mode === "done") ph = "done";
    if (mode === "leftover") {
      ph = "done";
      if (n < 2) act = '{"action": "refund_noid", "reason": "the contract is still funded"}';
    }
    const stdout = [`[${role}] tick exit 0 at 12:00:0${n}`, `noid: tip 281108 instance {${M}}`, `eth : latest 1416 lock {${M}}`, "sources: {}", "events: []", `ACTION: ${act}`, `notes: ["${M}"]`, `intent: {"status": "held", "blob": "${Z}"}`, `applied: True phase_after: ${ph}`].join("\n") + "\n";
    return { code: 0, stdout, stderr: "", files: [] };
  };
}
const NOSLEEP = async () => {};
async function runWatch(mode, o = {}) {
  const h = harness(o.harness);
  const w = createWatch(h.ctx, { tick: stubTick(mode), sleep: NOSLEEP, ...(o.watch || {}) });
  const end = await w.start();
  const lines = (h.read("loop-alice.txt") || "").split("\n").filter(Boolean);
  return { h, end, lines, w };
}

test("(s10) watch: a 3,000-character intent does not push phase_after out of the line; the ACTION is in it; it starts with the time and the tick header; the long intent itself is cut", async () => {
  const { lines } = await runWatch("long");
  const l1 = lines[0];
  assert.ok(l1.endsWith("applied: True phase_after: lock_final"));
  assert.ok(l1.includes('ACTION: {"action": "wait", "reason": "the lock is not final yet"}'));
  assert.match(l1, /^\d\d:\d\d:\d\d \[alice\] tick exit 0 at 12:00:01 /);
  assert.ok(!l1.includes("Z".repeat(1000)), "cut");
  assert.ok(l1.includes("noid: tip 281108"));
});
test("(s10) watch: a non-terminal phase keeps the loop going; a terminal one (refunded) stops it after 2 lines, and says so", async () => {
  const { end, lines } = await runWatch("long");
  assert.equal(lines.length, 2);
  assert.equal(end.reason, "terminal");
  assert.match(end.message, /^all watched files terminal at \d\d:\d\d:\d\d$/);
});
test("(s10) watch: phase_after done stops the loop at once (1 line) and the line has the phase", async () => {
  const { end, lines } = await runWatch("done");
  assert.equal(lines.length, 1);
  assert.equal(end.reason, "terminal");
  assert.ok(lines[0].includes("phase_after: done"));
});
test("(s10) watch: done with a leftover refund in the action is not terminal (2 lines), the plain done after it is", async () => {
  const { lines } = await runWatch("leftover");
  assert.equal(lines.length, 2);
});

test("watch: the terminal rule of watch.sh on a line (refunded, lost, aborted; done unless a leftover leg is named); a phase that is neither is not terminal", () => {
  for (const ph of ["refunded", "lost", "aborted"]) assert.equal(terminalOf(`x phase_after: ${ph}`), 1);
  assert.equal(terminalOf("x phase_after: done"), 1);
  for (const k of ["refund_noid", "refund_eth", "still at the contract", "ETH lock is still open", "already submitted", "open past T_reveal", "taking it back"]) assert.equal(terminalOf(`ACTION ${k} phase_after: done`), 0, k);
  for (const ph of ["secret_seen", "lock_final", "claim_submitted"]) assert.equal(terminalOf(`x phase_after: ${ph}`), 0);
  assert.equal(terminalOf("no phase here"), 0);
  assert.equal(terminalOf("phase_after: doner"), 1, "a prefix match like the helper's case pattern");
});

test("watch: the loop line is the time and the eight parts, each cut on its own (300 600 700 800 1500 700 700 400), a part with no lines is empty", () => {
  const out = ["[bob] tick exit 0 at 1", "x".repeat(400), "noid: " + "n".repeat(700), "ACTION: a", "ACTION: b", "applied: True", "phase_after: p"].join("\n");
  const line = loopLine("12:34:56", out);
  const parts = line.slice("12:34:56 ".length);
  assert.ok(parts.startsWith("[bob] tick exit 0 at 1 noid: " + "n".repeat(594) + "  ACTION: a ACTION: b    applied: True phase_after: p"), "the order, the cut of 600 and the empty parts");
  assert.equal(loopLine("T", "").split(" ").length, 9, "eight parts, all empty, after the time");
  const eight = Array.from({ length: 12 }, (_, i) => `notes: ${i}`).join("\n");
  assert.equal(loopLine("T", eight).split("notes: ").length - 1, 8, "at most eight lines of a part");
});

test("(s12) watch with alert_url: the alert on the first tick is sent once (the later ticks show none), the URL is never in the output, the loop line carries the alert", async () => {
  const sent = [];
  let n = 0;
  const tickFn = async (ctx, role) => {
    n++;
    const ph = n < 3 ? "secret_seen" : "refunded";
    const lines = [`[${role}] tick exit 0 at 12:00:0${n}`, "noid: tip 281108", "eth : latest 1416", "sources: {}", "events: []", 'ACTION: {"action": "claim_noid"}', "notes: [\"REORG\", \"ALERT: a reorg removed Bob's NOID claim from the chain and it is not pending.\"]"];
    if (n === 1) lines.push("ALERT: a reorg removed Bob's NOID claim from the chain and it is not pending.");
    lines.push(`applied: True phase_after: ${ph}`);
    return { code: 0, stdout: `${lines.join("\n")}\n`, stderr: "", files: [] };
  };
  const h = harness({ settings: { role: "bob", alert_url: "https://alert.example/hook-SECRET-9f3a" } });
  h.ctx.alertPost = async (url, msg) => {
    sent.push({ url, msg });
    return true;
  };
  const end = await createWatch(h.ctx, { tick: tickFn, sleep: NOSLEEP }).start();
  assert.equal(end.reason, "terminal");
  assert.deepEqual(sent, [{ url: "https://alert.example/hook-SECRET-9f3a", msg: "noid-swap run 7: claim removed by a reorg; do the claim dry run" }]);
  assert.ok(h.read("loop-bob.txt").includes("ALERT: a reorg removed Bob's NOID claim"));
  assert.ok(!JSON.stringify([end, h.files().map((f) => f.bytes.toString())]).includes("hook-SECRET"));
});

test("(s12) watch: without alert_url nothing is sent; a failing sender does not stop the loop (it ends by the terminal phase after three ticks) and the failed alert is retried on each later tick and stays pending", async () => {
  const mk = (url, ok) => {
    const sent = [];
    let n = 0;
    const tickFn = async (ctx, role) => {
      n++;
      const lines = [`[${role}] tick exit 0 at 12:00:0${n}`, "noid: tip 1"];
      if (n === 1) lines.push("ALERT: a reorg removed Bob's NOID claim from the chain");
      lines.push(`applied: True phase_after: ${n < 3 ? "secret_seen" : "refunded"}`);
      return { code: 0, stdout: `${lines.join("\n")}\n`, stderr: "", files: [] };
    };
    const h = harness({ settings: { role: "bob", alert_url: url } });
    h.ctx.alertPost = async (u, m) => {
      sent.push(m);
      return ok;
    };
    return { h, sent, run: () => createWatch(h.ctx, { tick: tickFn, sleep: NOSLEEP }).start() };
  };
  const none = mk(null, true);
  await none.run();
  assert.equal(none.sent.length, 0);
  const bad = mk("https://alert.example/h", false);
  const end = await bad.run();
  assert.equal(end.reason, "terminal");
  assert.equal(end.ticks, 3);
  assert.equal(bad.sent.length, 3, "one try for the line, two retries");
  assert.equal(bad.h.read("alert-pending").split("|")[0], "3");
});

test("(s14) watch: the pending-claim alarm printed on four ticks is sent once; a failing sender does not stop the loop, the alarm is tried on each tick and no latch is kept; no alert_url sends nothing", async () => {
  const ALARM = "ALARM: the NOID claim is still pending (not seen mined) and the next call height 99 is past the D-19 target (D 100): if it is mined now it is not final before Alice's refund opens at D";
  const mk = (url, ok) => {
    const sent = [];
    let n = 0;
    const tickFn = async (ctx, role) => {
      n++;
      return { code: 0, stdout: [`[${role}] tick exit 0 at 12:00:0${n}`, "noid: tip 281108", 'ACTION: {"action": "wait"}', `notes: ["${ALARM.slice(0, 60)}"]`, ALARM, `applied: True phase_after: ${n < 4 ? "claim_submitted" : "done"}`].join("\n") + "\n", stderr: "", files: [] };
    };
    const h = harness({ settings: { role: "bob", alert_url: url } });
    h.ctx.alertPost = async (u, m) => {
      sent.push(m);
      return ok;
    };
    return { h, sent, run: () => createWatch(h.ctx, { tick: tickFn, sleep: NOSLEEP }).start() };
  };
  const good = mk("https://alert.example/hook-SECRET-9f3a", true);
  const end = await good.run();
  assert.deepEqual([end.reason, end.ticks], ["terminal", 4]);
  assert.deepEqual(good.sent, ["noid-swap run 7: Bob's NOID claim is still pending past its target; look at the loop log"]);
  const bad = mk("https://alert.example/hook-SECRET-9f3a", false);
  const e2 = await bad.run();
  assert.deepEqual([e2.ticks, bad.sent.length, fs.readdirSync(bad.h.runDir).filter((f) => f.startsWith("alarm-sent")).length], [4, 4, 0]);
  const none = mk(null, true);
  await none.run();
  assert.equal(none.sent.length, 0);
});

test("watch: stop() ends the loop after the tick in progress, a started loop is started once, a role that is not this run's is refused, a throwing tick does not end the loop", async () => {
  const h = harness();
  let n = 0;
  let release;
  const gate = new Promise((r) => (release = r));
  const w = createWatch(h.ctx, {
    tick: async (ctx, role) => {
      n++;
      if (n === 1) await gate;
      return { code: 0, stdout: `[${role}] tick exit 0 at x\napplied: True phase_after: secret_seen\n`, stderr: "", files: [] };
    },
    sleep: NOSLEEP,
  });
  const p = w.start();
  assert.equal(w.start(), p, "started once");
  const stopped = w.stop();
  release();
  await stopped;
  assert.equal((await p).reason, "stopped");
  assert.equal(n, 1, "the tick in progress finished, no other began");
  assert.equal(h.read("loop-alice.txt").split("\n").filter(Boolean).length, 1);
  const other = await createWatch(h.ctx, { roles: ["bob"], tick: stubTick("done"), sleep: NOSLEEP }).start();
  assert.equal(other.reason, "refused");
  assert.match(other.message, /this run is alice's/);
  const bad = await createWatch(h.ctx, { roles: ["carol"], tick: stubTick("done"), sleep: NOSLEEP }).start();
  assert.equal(bad.reason, "refused");
  let k = 0;
  const throwing = createWatch(harness().ctx, {
    tick: async (ctx, role) => {
      k++;
      if (k === 1) throw new Error("boom");
      return { code: 0, stdout: `[${role}] tick exit 0 at x\napplied: True phase_after: refunded\n`, stderr: "", files: [] };
    },
    sleep: NOSLEEP,
  });
  const e = await throwing.start();
  assert.deepEqual([e.reason, e.ticks, throwing.lastError], ["terminal", 2, "boom"]);
});

test("watch: with the real timer the pause is the interval, and stop() wakes it at once", async () => {
  const h = harness();
  const w = createWatch(h.ctx, { tick: async (ctx, role) => ({ code: 0, stdout: `[${role}] tick exit 0 at x\napplied: True phase_after: secret_seen\n`, stderr: "", files: [] }), intervalMs: 60000 });
  const p = w.start();
  await new Promise((r) => setTimeout(r, 100));
  const t0 = Date.now();
  await w.stop();
  assert.ok(Date.now() - t0 < 2000);
  assert.equal((await p).reason, "stopped");
});

test("watch, end to end through the real tick step and the stub tool: --apply on every tick, one loop line per tick, ends when the swap file is refunded", async () => {
  const h = harness();
  h.swapFile("alice");
  h.scenario({ swapCli: { tick: [{ stdout: TICK(), touch: true }, { stdout: TICK({ phase_after: "refunded" }), touch: true }] } });
  const end = await createWatch(h.ctx, { sleep: NOSLEEP }).start();
  assert.deepEqual([end.reason, end.ticks], ["terminal", 2]);
  const calls = h.calls("swapCli");
  assert.equal(calls.length, 2);
  assert.ok(calls.every((c) => c.argv.at(-1) === "--apply" && c.pass));
  const lines = h.read("loop-alice.txt").split("\n").filter(Boolean);
  assert.equal(lines.length, 2);
  assert.match(lines[0], /^\d\d:\d\d:\d\d \[alice\] tick exit 0 at \d\d:\d\d:\d\d .*applied: True phase_after: lock_final$/);
  assert.ok(lines[1].endsWith("phase_after: refunded"));
});

// ---------------------------------------------------------------------------------------------------------------------------------
// wallet status (scripts/live/wallet-status.sh; the cases of selftest section 18)

const KEY = `0x${"5ca1ab1e".repeat(8)}`;
const BAL = (o = {}) => JSON.stringify({ address: ALICE_NOID, tip: 280500, plain_micronoid: 5100000, swap_amount_micronoid: 5000000, funding_fee_reserve_micronoid: 6000, needed_micronoid: 5006000, deposit_covers: true, ...o });
const RES = (o = {}) => JSON.stringify({ address: ALICE_ETH, requiredWei: "1000000000000000", reserveWei: "1000000000000000", balanceWei: "2000000000000000", shortfallWei: "0", covered: true, keyChecked: true, ...o });
function statusScenario(h, o = {}) {
  h.scenario({
    swapCli: { "wallet balance": o.balance || { stdout: BAL() }, "ethkey emit": { stdout: `${KEY}\n`, ...(o.emit || {}) } },
    liveJs: { reserve: o.reserve || { stdout: RES() } },
  });
}
const lineCount = (text, re) => text.split("\n").filter((l) => re.test(l)).length;

test("(s18) wallet-status alice: exit 0, the NOID line, the ETH line with key_checked=true, done; the tools got the helper's arguments, the key arrived on stdin, no key anywhere", async () => {
  const h = harness();
  h.swapFile("alice");
  statusScenario(h);
  const r = await walletStatus(h.ctx, "alice");
  assert.equal(r.code, 0);
  assert.ok(r.stdout.includes(`wallet-status-noid: address=${ALICE_NOID} plain_micronoid=5100000 amount_micronoid=5000000 fee_reserve_micronoid=6000 need_micronoid=5006000 covers=true tip=280500\n`));
  assert.ok(r.stdout.includes(`wallet-status-eth: address=${ALICE_ETH} required_wei=1000000000000000 reserve_wei=1000000000000000 amount_wei=0 balance_wei=2000000000000000 shortfall_wei=0 covered=true key_checked=true\n`));
  assert.ok(r.stdout.startsWith("wallet-status: role alice\n") && r.stdout.endsWith("wallet-status: done\n"));
  const F = path.join(h.runDir, "alice.swap.json");
  const [bal, emit] = h.calls("swapCli");
  assert.deepEqual(bal.argv, ["wallet", "balance", F, "--transport", "curl", "--noid-rpc", "http://127.0.0.1:9601", "--rpc-timeout", "60", "--curl-path", h.ctx.tools.curl]);
  assert.deepEqual([bal.pass, bal.stdin.length, emit.argv, emit.pass], [true, 0, ["ethkey", "emit", F], true]);
  const live = h.calls("liveJs")[0];
  assert.deepEqual(live.argv, ["reserve", "--role", "alice", "--swap", F, "--key-stdin"]);
  assert.deepEqual([live.pass, live.stdin.sha256], [false, sha(`${KEY}\n`)]);
  assert.ok(!JSON.stringify(h.calls()).includes("--key-file"));
  for (const f of h.files()) assert.ok(!f.bytes.toString().includes(KEY), `${f.rel} has no key`);
  assert.ok(!JSON.stringify(r).includes(KEY));
  assert.deepEqual(r.files, ["wallet-status-alice.noid.json", "wallet-status-alice.noid.err", "wallet-status-alice.eth.json", "wallet-status-alice.eth.err"]);
});

test("(s18) wallet-status alice: not covered is data, not a failure: exit 0, covered=false and covers=false", async () => {
  const h = harness();
  h.swapFile("alice");
  statusScenario(h, { balance: { stdout: BAL({ deposit_covers: false }) }, reserve: { stdout: RES({ covered: false, shortfallWei: "5" }), code: 3 } });
  const r = await walletStatus(h.ctx, "alice");
  assert.equal(r.code, 0);
  assert.equal(lineCount(r.stdout, /covered=false/), 1);
  assert.equal(lineCount(r.stdout, /covers=false/), 1);
});

test("(s18) wallet-status alice: the key does not own the stated address (reserve exit 1): exit 3, no ETH line, no done, and it says nothing must be deposited", async () => {
  const h = harness();
  h.swapFile("alice");
  statusScenario(h, { reserve: { stdout: "", stderr: "key does not own the address\n", code: 1 } });
  const r = await walletStatus(h.ctx, "alice");
  assert.deepEqual([r.code, lineCount(r.stdout, /^wallet-status-eth:/), lineCount(r.stdout, /^wallet-status: done/)], [3, 0, 0]);
  assert.match(r.stdout, /nothing must be deposited/);
  assert.match(r.stdout, /key does not own the address/);
  assert.ok(r.stdout.trimEnd().endsWith("wallet-status: NOT complete"));
});

test("(s18) wallet-status alice: the balance cannot be read, a reserve output that is not JSON, keyChecked false: exit 3 each, the failing part prints no line, no done", async () => {
  const h = harness();
  h.swapFile("alice");
  statusScenario(h, { balance: { stdout: "", stderr: "node down\n", code: 1 } });
  let r = await walletStatus(h.ctx, "alice");
  assert.deepEqual([r.code, lineCount(r.stdout, /^wallet-status-noid:/), lineCount(r.stdout, /^wallet-status: done/)], [3, 0, 0]);
  assert.match(r.stdout, /the NOID balance could not be read \(swap-cli wallet balance exit 1\):\nnode down\n/);
  statusScenario(h, { reserve: { stdout: "garbage" } });
  r = await walletStatus(h.ctx, "alice");
  assert.deepEqual([r.code, lineCount(r.stdout, /^wallet-status: done/)], [3, 0]);
  statusScenario(h, { reserve: { stdout: RES({ keyChecked: false }) } });
  r = await walletStatus(h.ctx, "alice");
  assert.deepEqual([r.code, lineCount(r.stdout, /^wallet-status-eth:/)], [3, 0]);
  assert.match(r.stdout, /keyChecked/);
  statusScenario(h, { balance: { stdout: BAL({ tip: "x" }) } });
  r = await walletStatus(h.ctx, "alice");
  assert.equal(r.code, 3);
  assert.match(r.stdout, /the NOID balance: the field tip is missing or not of the expected shape/);
});

test("(s18) wallet-status: the reserve gets the cap and never the tip; an emitter that fails is exit 3 even if live.js says covered", async () => {
  const h = harness({ settings: { gas_price_gwei: "2", priority_fee_gwei: "0.01" } });
  h.swapFile("alice");
  statusScenario(h);
  await walletStatus(h.ctx, "alice");
  const live = h.calls("liveJs")[0];
  assert.deepEqual(live.argv.slice(-2), ["--gas-price-gwei", "2"]);
  assert.ok(!live.argv.includes("--priority-fee-gwei"));
  statusScenario(h, { emit: { stdout: "", stderr: "wrong passphrase\n", code: 1 } });
  const r = await walletStatus(h.ctx, "alice");
  assert.deepEqual([r.code, lineCount(r.stdout, /^wallet-status-eth:/)], [3, 0]);
});

test("(s18) wallet-status bob: exit 0, only the Ethereum part (no balance call, no NOID line), reserve --role bob on Bob's swap file", async () => {
  const h = harness({ settings: { role: "bob" } });
  h.swapFile("bob");
  statusScenario(h, { reserve: { stdout: RES({ address: BOB_ETH }) } });
  const r = await walletStatus(h.ctx, "bob");
  assert.equal(r.code, 0);
  assert.equal(h.calls("swapCli").filter((c) => c.argv[0] === "wallet").length, 0);
  assert.equal(lineCount(r.stdout, /^wallet-status-noid:/), 0);
  assert.equal(lineCount(r.stdout, new RegExp(`^wallet-status-eth: address=${BOB_ETH}`)), 1);
  assert.deepEqual(h.calls("liveJs")[0].argv.slice(0, 5), ["reserve", "--role", "bob", "--swap", path.join(h.runDir, "bob", "bob.swap.json")]);
  assert.deepEqual(r.files, ["wallet-status-bob.eth.json", "wallet-status-bob.eth.err"]);
});

test("(s18) wallet-status: no swap file, no passphrase, another role, a role that is neither, a missing tool: exit 2 and no tool runs", async () => {
  const h = harness();
  statusScenario(h);
  let r = await walletStatus(h.ctx, "alice");
  assert.equal(r.code, 2);
  assert.match(r.stderr, /no swap file at .*run prepare first/);
  assert.equal(h.calls().length, 0);
  h.swapFile("alice");
  for (const role of ["bob", "carol", undefined]) assert.equal((await walletStatus(h.ctx, role)).code, 2, String(role));
  const h2 = harness({ passphrase: null });
  h2.swapFile("alice");
  r = await walletStatus(h2.ctx, "alice");
  assert.equal(r.code, 2);
  assert.match(r.stderr, /passphrase/);
  r = await walletStatus({ ...h.ctx, tools: { ...h.ctx.tools, liveJs: [path.join(h.root, "nope")] } }, "alice");
  assert.equal(r.code, 2);
  assert.equal(h.calls().length, 0);
});

// ---------------------------------------------------------------------------------------------------------------------------------
// board helpers (selftest section 19: digest, verify, balance)

const WEB = `0x${"2e".repeat(20)}`;
const WNB = "o1selftestbobnoidaddressxxxxxxxxxx";
const BOF = "a1".repeat(32);
const BTK = "b2".repeat(32);
const BDG = "de".repeat(32);
const BSIG = `0x${"77".repeat(65)}`;
// the same pinned hashes as scripts/live/selftest.sh and ui/app/test/board-host.test.js
const SHA_ADDR = "5f5ce8c4bf4fc8f78de9f20f34206a587ccc92a4c67a0b031822746aa20151eb";
const SHA_CHK = "2ba29de31a3f8850fac7381941805853ea6814b21df80c1f65e8f8411cec4ecb";
const BUNDLE = '{"hashlock":"0xaa","params":{"profile":"sepolia"}}\n';
const bundleEntry = (o = {}) => ({
  stdout: BUNDLE,
  stderr: `bundle check: ${(o.check || BDG).slice(0, 16)} (opening_hex 1398 characters)\nbundle digest: ${o.digest || BDG}\n${o.digest2 ? `bundle digest: ${o.digest2}\n` : ""}`,
  code: o.code || 0,
});

function digestEnv(role, o = {}) {
  const h = harness({ settings: { role } });
  h.swapFile(role);
  h.write("alice.bundle.json", BUNDLE);
  h.write("pub/alice.bundle.json", BUNDLE);
  h.scenario({ swapCli: { bundle: bundleEntry(o) } });
  return h;
}

test("(s19) board-digest alice: exit 0, the whole digest, both files the same as the swap file's bundle, done; swap-cli bundle ran on Alice's file and got no passphrase", async () => {
  const h = digestEnv("alice");
  const r = await boardDigest(h.ctx, "alice");
  assert.equal(r.code, 0);
  assert.equal(r.stdout, `board-digest: role alice\nboard-digest: digest ${BDG}\nboard-digest: run-file same\nboard-digest: public-file same\nboard-digest: done\n`);
  const calls = h.calls();
  assert.equal(calls.length, 1);
  assert.deepEqual([calls[0].argv, calls[0].pass], [["bundle", path.join(h.runDir, "alice.swap.json")], false]);
  assert.ok(fs.statSync(path.join(h.runDir, "board")).isDirectory());
  assert.deepEqual(fs.readdirSync(path.join(h.runDir, "board")), [], "no temporary file is left");
});
test("(s19) board-digest alice: another bundle file in the run folder: run-file differs; no public copy: public-file missing; a symbolic link differs", async () => {
  const h = digestEnv("alice");
  h.write("alice.bundle.json", '{"hashlock":"0xbb"}\n');
  let r = await boardDigest(h.ctx, "alice");
  assert.ok(r.stdout.includes("run-file differs\n") && r.stdout.includes("public-file same\n"));
  fs.rmSync(path.join(h.runDir, "pub", "alice.bundle.json"));
  r = await boardDigest(h.ctx, "alice");
  assert.ok(r.stdout.includes("public-file missing\n"));
  fs.mkdirSync(path.join(h.runDir, "pub", "alice.bundle.json"));
  r = await boardDigest(h.ctx, "alice");
  assert.ok(r.stdout.includes("public-file missing\n"), "not a file");
  if (process.platform !== "win32") {
    fs.rmSync(path.join(h.runDir, "pub", "alice.bundle.json"), { recursive: true });
    fs.symlinkSync(path.join(h.runDir, "alice.bundle.json"), path.join(h.runDir, "pub", "alice.bundle.json"));
    h.write("alice.bundle.json", BUNDLE);
    r = await boardDigest(h.ctx, "alice");
    assert.ok(r.stdout.includes("public-file differs\n"));
  }
  fs.writeFileSync(path.join(h.runDir, "alice.bundle.json"), BUNDLE + " ");
  assert.ok((await boardDigest(h.ctx, "alice")).stdout.includes("run-file differs\n"), "byte for byte");
});
test("(s19) board-digest: two different digest lines, a digest that does not start with the check line's digits, swap-cli failing: exit 3 and no digest line", async () => {
  for (const [o, re] of [
    [{ digest2: "ee".repeat(32) }, /printed 2 different 'bundle digest:' lines/],
    [{ check: "ee".repeat(32) }, /does not start with the digits of the check line/],
    [{ code: 1 }, /swap-cli bundle failed \(exit 1\)/],
  ]) {
    const h = digestEnv("alice", o);
    const r = await boardDigest(h.ctx, "alice");
    assert.equal(r.code, 3, JSON.stringify(o));
    assert.equal(lineCount(r.stdout, /^board-digest: digest/), 0);
    assert.match(r.stdout + r.stderr, re);
  }
  const h = digestEnv("alice");
  h.scenario({ swapCli: { bundle: { stdout: BUNDLE, stderr: `bundle digest: ${BDG}\n` } } });
  assert.equal((await boardDigest(h.ctx, "alice")).code, 3, "no check line");
  h.scenario({ swapCli: { bundle: { stdout: BUNDLE, stderr: `bundle check: ${BDG.slice(0, 16)} x\nbundle digest: ${BDG}\nbundle digest: ${BDG}\n` } } });
  assert.equal((await boardDigest(h.ctx, "alice")).code, 0, "the same digest twice is one digest");
});
test("(s19) board-digest: no swap file: exit 2, swap-cli never ran; Bob's digest has no file comparison; another role is refused", async () => {
  const h = digestEnv("alice");
  fs.rmSync(path.join(h.runDir, "alice.swap.json"));
  const r = await boardDigest(h.ctx, "alice");
  assert.deepEqual([r.code, h.calls().length], [2, 0]);
  const b = digestEnv("bob");
  const rb = await boardDigest(b.ctx, "bob");
  assert.equal(rb.code, 0);
  assert.ok(rb.stdout.includes(`board-digest: digest ${BDG}\n`) && !rb.stdout.includes("run-file"));
  assert.equal((await boardDigest(b.ctx, "carol")).code, 2);
  assert.equal((await boardDigest(b.ctx, "alice")).code, 2, "this is Bob's run");
});

function verifyEnv(purpose, o = {}) {
  const h = harness({ settings: { role: "alice", bob_noid: WNB, bob_eth: WEB } });
  const lines = purpose === "addresses" ? [`signer ${WEB}`, `signature ${BSIG}`, `offer ${BOF}`, `take ${BTK}`, `bob_noid ${WNB}`, `bob_sender ${WEB}`] : [`signer ${WEB}`, `signature ${BSIG}`, `offer ${BOF}`, `take ${BTK}`, `digest ${BDG}`];
  h.write("board/verify.in", (o.lines || lines).join("\n") + (o.noEol ? "" : "\n"));
  h.scenario({ liveJs: { "verify-message": o.live || { stdout: `{\n  "valid": true,\n  "recovered": "${WEB}"\n}\n` } } });
  return h;
}
const nodeRan = (h) => h.calls("liveJs").length;

test("(s19) board-verify addresses: a valid signature: exit 0, valid true, the pinned text hash, done; live.js got the address, the message in hex and the signature; no key, no passphrase", async () => {
  const h = verifyEnv("addresses");
  const r = await boardVerify(h.ctx, "addresses");
  assert.equal(r.code, 0);
  assert.equal(r.stdout, `board-verify: purpose addresses\nboard-verify: text-sha256 ${SHA_ADDR}\nboard-verify: valid true\nboard-verify: done\n`);
  const c = h.calls("liveJs")[0];
  const text = `no1d-swap-v1 addresses\n${BOF}\n${BTK}\n${WNB}\n${WEB}`;
  assert.deepEqual(c.argv, ["verify-message", "--address", WEB, "--message-hex", `0x${Buffer.from(text).toString("hex")}`, "--signature", BSIG]);
  assert.deepEqual([c.pass, c.stdin.length, c.cwd], [false, 0, h.ethDir]);
  assert.equal(sha(text), SHA_ADDR);
});
test("(s19) board-verify checked: the pinned text hash for the digest text", async () => {
  const h = verifyEnv("checked");
  const r = await boardVerify(h.ctx, "checked");
  assert.deepEqual([r.code, r.stdout.includes(`board-verify: text-sha256 ${SHA_CHK}\n`)], [0, true]);
});
test("(s19) board-verify: a signature that is not valid is data (exit 0, valid false); live.js failing is exit 3 with no valid line", async () => {
  const h = verifyEnv("checked", { live: { stdout: '{\n  "valid": false,\n  "recovered": null\n}\n', code: 3 } });
  const r = await boardVerify(h.ctx, "checked");
  assert.deepEqual([r.code, lineCount(r.stdout, /^board-verify: valid false$/), lineCount(r.stdout, /^board-verify: valid true$/)], [0, 1, 0]);
  const f = verifyEnv("checked", { live: { stdout: "", stderr: "boom\n", code: 1 } });
  const rf = await boardVerify(f.ctx, "checked");
  assert.deepEqual([rf.code, lineCount(rf.stdout, /^board-verify: valid/)], [3, 0]);
  assert.match(rf.stdout, /live\.js verify-message failed \(exit 1\)/);
  for (const live of [{ stdout: "not json", code: 0 }, { stdout: '{"valid":"yes"}', code: 0 }, { stdout: '{"valid":false}', code: 0 }, { stdout: '{"valid":true}', code: 3 }, { stdout: "null", code: 0 }]) {
    const x = verifyEnv("checked", { live });
    const rx = await boardVerify(x.ctx, "checked");
    assert.equal(rx.code, 3, JSON.stringify(live));
    assert.equal(lineCount(rx.stdout, /^board-verify: valid/), 0);
  }
});
test("(s19) board-verify: input that is not exactly the lines of the purpose is refused (exit 2) and the node never ran: a quote and a command in bob_noid, an extra line, another order, a short signature, a missing file, a symbolic link, too large", async () => {
  const base = (purpose) => verifyEnv(purpose).read("board/verify.in").split("\n").slice(0, -1);
  const refuse = async (h, re, purpose = "addresses") => {
    const r = await boardVerify(h.ctx, purpose);
    assert.equal(r.code, 2, r.stderr);
    assert.match(r.stderr, re);
    assert.equal(nodeRan(h), 0);
  };
  const a = base("addresses");
  await refuse(verifyEnv("addresses", { lines: a.map((l) => (l.startsWith("bob_noid") ? "bob_noid o1x'; touch pwned #" : l)) }), /'bob_noid' is not an o1/);
  await refuse(verifyEnv("addresses", { lines: a.map((l) => (l.startsWith("bob_noid") ? "bob_noid o1$(touch pwned)aaaaaaaaaaaaaaaaaaaa" : l)) }), /'bob_noid' is not an o1/);
  await refuse(verifyEnv("addresses", { lines: [...a, `digest ${BDG}`] }), /more lines than the purpose uses/);
  await refuse(verifyEnv("addresses", { lines: [a[1], a[0], ...a.slice(2)] }), /does not have the line 'signer' where it belongs/);
  await refuse(verifyEnv("addresses", { lines: a.map((l) => (l.startsWith("signature") ? "signature 0x12" : l)) }), /'signature' is not 0x and 130 hex/);
  await refuse(verifyEnv("addresses", { lines: a.map((l) => (l.startsWith("offer") ? "offer ABC" : l)) }), /'offer' is not 64 lower-case hex/);
  await refuse(verifyEnv("addresses", { lines: a.map((l) => (l.startsWith("signer") ? "signer 0x12" : l)) }), /'signer' is not 0x and 40 hex/);
  await refuse(verifyEnv("addresses", { lines: a.slice(0, 4) }), /input ends before the line 'bob_noid'/);
  await refuse(verifyEnv("addresses", { noEol: true }), /input ends before the line 'bob_sender'/);
  await refuse(verifyEnv("checked", { lines: base("checked").slice(0, 4) }), /ends before the line 'digest'/, "checked");
  const none = harness();
  await refuse(none, /no plain file/);
  const big = verifyEnv("addresses");
  big.write("board/verify.in", `${"x".repeat(2049)}\n`);
  await refuse(big, /too large/);
  if (process.platform !== "win32") {
    const link = verifyEnv("addresses");
    fs.renameSync(path.join(link.runDir, "board", "verify.in"), path.join(link.runDir, "board", "real.in"));
    fs.symlinkSync(path.join(link.runDir, "board", "real.in"), path.join(link.runDir, "board", "verify.in"));
    await refuse(link, /no plain file/);
  }
  const pw = verifyEnv("addresses");
  const r = await boardVerify(pw.ctx, "carol");
  assert.equal(r.code, 2);
  assert.ok(!fs.existsSync(path.join(pw.runDir, "pwned")) && !fs.existsSync(path.join(pw.ctx.tools.ethDir, "pwned")));
});

function balanceEnv(o = {}) {
  const h = harness({ settings: { bob_eth: WEB, ...(o.settings || {}) } });
  h.scenario({ liveJs: { balance: o.live || { stdout: JSON.stringify({ address: WEB, balanceWei: "5000000000000000", balanceEth: "0.0", chainId: "11155111", blockNumber: 123, nonceLatest: 0, noncePending: 0 }, null, 2) } } });
  return h;
}
test("(s19) board-balance: exit 0 and one validated line, then done; live.js balance got the address and nothing else", async () => {
  const h = balanceEnv();
  const r = await boardBalance(h.ctx);
  assert.equal(r.code, 0);
  assert.equal(r.stdout, `board-balance: address=${WEB} balance_wei=5000000000000000 chain_id=11155111 block=123\nboard-balance: done\n`);
  const c = h.calls("liveJs")[0];
  assert.deepEqual([c.argv, c.pass, c.stdin.length, c.env.ETH_RPC_URL], [["balance", "--address", WEB], false, 0, h.settings.eth_rpc]);
});
test("(s19) board-balance: a bob_eth that is not an address is exit 2 and the node never ran; the swap's own addresses file supplies it when the setting is null", async () => {
  const h = balanceEnv({ settings: { bob_eth: "0xnothex" } });
  const r = await boardBalance(h.ctx);
  assert.deepEqual([r.code, h.calls().length], [2, 0]);
  const g = balanceEnv({ settings: { bob_eth: null } });
  assert.equal((await boardBalance(g.ctx)).code, 2);
  g.write("wallet-addresses.txt", `BOB_ETH=${WEB}\n`);
  assert.equal((await boardBalance(g.ctx)).code, 0);
});
test("(s19) board-balance: the node does not answer, an answer that is not JSON, a balance that is not whole decimal digits, a wrong chain id or block: exit 3 and no line", async () => {
  const good = { address: WEB, balanceWei: "1", chainId: "11155111", blockNumber: 123 };
  for (const live of [{ stdout: "", stderr: "node did not answer\n", code: 1 }, { stdout: "garbage" }, { stdout: JSON.stringify({ ...good, balanceWei: "12ab" }) }, { stdout: JSON.stringify({ ...good, chainId: 1 }) }, { stdout: JSON.stringify({ ...good, blockNumber: -1 }) }, { stdout: JSON.stringify({ ...good, address: "0x12" }) }, { stdout: "null" }]) {
    const h = balanceEnv({ live });
    const r = await boardBalance(h.ctx);
    assert.equal(r.code, 3, JSON.stringify(live));
    assert.equal(lineCount(r.stdout, /^board-balance: address=/), 0);
  }
});

test("the read-only steps never write a file the helpers do not write, and the files they list exist", async () => {
  const h = harness();
  h.swapFile("alice");
  statusScenario(h);
  const r = await walletStatus(h.ctx, "alice");
  for (const f of r.files) assert.ok(h.exists(f), f);
  const names = new Set(fs.readdirSync(h.runDir));
  for (const n of names) assert.ok(["passphrase.txt", "alice.swap.json", ...r.files].includes(n), `unexpected file ${n}`);
  assert.ok(!makeSettings({}).alert_url);
});
