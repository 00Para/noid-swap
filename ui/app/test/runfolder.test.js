"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { readRun, classify, wslParts, pathCandidates, scrubText } = require("../lib/runfolder");
const { parseLoopText, phaseChanges } = require("../lib/looptext");
const { SENTINEL, FAKE_PREIMAGE, makeRunFolder, spyOpens, NOW } = require("./helpers");

test("run folder: reads the allowlisted files, strips the preimage and the openings", () => {
  const run = makeRunFolder();
  const r = readRun([run.dir], NOW);
  assert.equal(r.readable, true);
  const a = r.roles.alice;
  assert.equal(a.tick.phase_after, "lock_final");
  assert.equal(a.tick.eth.claimed.preimage, "[withheld]");
  assert.equal(a.tick.action.preimage, "[withheld]");
  assert.equal(a.tick.events[0].preimage, "[withheld]");
  assert.equal(r.roles.bob, null);
  assert.equal(a.loop.entries.length, 2);
  assert.equal(a.loop.entries[1].phase_after, "funding_final");
  assert.equal(r.terms.deadline_height, 281514);
  assert.equal(r.terms.profile, "sepolia");
  assert.ok(!("opening_hex" in r.terms));
  assert.ok(!("opening_hex" in r.bundle));
  assert.ok(!("opening_hex" in r.object) && !("program" in r.object));
  assert.equal(r.verify.ok, true);
  const all = JSON.stringify(r);
  for (const needle of [SENTINEL, FAKE_PREIMAGE.slice(2), "4e4f49444f424a33", "efefefefefefefef"]) assert.ok(!all.includes(needle), `payload must not contain ${needle.slice(0, 12)}…`);
  run.cleanup();
});

test("run folder: classifies helper outputs as dry run or real, keeps the failing helper's stderr", () => {
  const run = makeRunFolder();
  fs.writeFileSync(path.join(run.dir, "eth-lock-120009.json"), "");
  fs.writeFileSync(path.join(run.dir, "eth-lock-120009.err"), "refusing: past the reveal cutoff\n");
  const r = readRun([run.dir], NOW);
  const byFile = Object.fromEntries(r.helpers.map((h) => [h.file, h]));
  assert.equal(byFile["eth-claim-dry-120001.json"].dry, true);
  assert.equal(byFile["eth-claim-dry-120001.json"].kind, "eth_claim");
  assert.ok(!("data" in byFile["eth-claim-dry-120001.json"].summary), "calldata is dropped");
  assert.equal(byFile["eth-lock-120002.json"].dry, false, "a result with a txHash is a receipt, not a dry run");
  assert.equal(byFile["claim-120003.out"].kind, "claim_out");
  assert.equal(byFile["claim-120003.out"].dry, true);
  assert.equal(byFile["claim-120003.out"].summary.action.preimage, "[withheld]");
  assert.match(byFile["eth-lock-120009.json"].error, /empty/);
  assert.match(byFile["eth-lock-120009.json"].err_text, /past the reveal cutoff/);
  run.cleanup();
});

test("run folder: never opens a swap file, passphrase, key, receipt, recording, intent or env file", () => {
  const run = makeRunFolder();
  const { result, opened } = spyOpens(() => readRun([run.dir], NOW));
  assert.ok(result.withheld >= 8, `withheld count ${result.withheld}`);
  const forbidden = /(\.swap\.json|passphrase|[\\/]keys[\\/]|\.receipt|env\.local|claim-intent|[\\/]rec[\\/]|\.lock$)/;
  const bad = opened.filter(([k, p]) => k !== "readdirSync" && forbidden.test(p));
  assert.deepEqual(bad, [], "no forbidden path may be stat'ed, opened or read");
  assert.ok(opened.some(([k, p]) => k === "readFileSync" && /last-tick-alice\.json$/.test(p)), "sanity: the tick was read");
  run.cleanup();
});

test("run folder: unreadable folder, garbage tick and oversize files are reported, not thrown", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "noid-run-"));
  fs.writeFileSync(path.join(dir, "last-tick-bob.json"), "{not json");
  fs.writeFileSync(path.join(dir, "loop-bob.txt"), "garbage\nmore garbage\n");
  const r = readRun([dir, path.join(dir, "missing")], NOW);
  assert.match(r.roles.bob.tick_error, /JSON|Unexpected|position/i);
  assert.equal(r.roles.bob.loop.entries.length, 0);
  assert.equal(r.dirs[1].readable, false);
  assert.ok(r.errors.length >= 1);
  fs.rmSync(dir, { recursive: true, force: true });
  const none = readRun([path.join(os.tmpdir(), "does-not-exist-noid")], NOW);
  assert.equal(none.readable, false);
});

test("run folder: a second (public) folder supplies the object file; the newest copy wins", () => {
  const run = makeRunFolder();
  fs.rmSync(path.join(run.dir, "swap.object.json"));
  const pub = fs.mkdtempSync(path.join(os.tmpdir(), "noid-pub-"));
  fs.writeFileSync(path.join(pub, "swap.object.json"), JSON.stringify({ address: "o1PUB", deadline_height: 281514, opening_hex: "00" }));
  const r = readRun([run.dir, pub], NOW);
  assert.equal(r.object.address, "o1PUB");
  assert.ok(!("opening_hex" in r.object));
  fs.rmSync(pub, { recursive: true, force: true });
  run.cleanup();
});

test("classify / wsl paths", () => {
  assert.deepEqual(classify("last-tick-alice.json"), { kind: "tick", role: "alice" });
  assert.deepEqual(classify("loop-bob.txt"), { kind: "loop", role: "bob" });
  assert.equal(classify("alice.swap.json"), null);
  assert.equal(classify("passphrase.txt"), null);
  assert.equal(classify("alice.receipt"), null);
  assert.equal(classify("env.local.sh"), null);
  assert.equal(classify("claim-intent-120000.hex"), null);
  assert.equal(classify("eth-claim-dry-12.json").kind, "eth_claim");
  assert.deepEqual(wslParts("\\\\wsl.localhost\\Ubuntu-24.04\\home\\u\\live-run-4"), { distro: "Ubuntu-24.04", linux: "/home/u/live-run-4" });
  assert.deepEqual(wslParts("\\\\wsl$\\Debian\\srv\\run"), { distro: "Debian", linux: "/srv/run" });
  assert.equal(wslParts("C:\\runs\\x"), null);
  assert.deepEqual(pathCandidates("\\\\wsl.localhost\\D\\x"), ["\\\\wsl.localhost\\D\\x", "\\\\wsl$\\D\\x"]);
  assert.deepEqual(pathCandidates("/tmp/x"), ["/tmp/x"]);
});

test("scrubText withholds lines that look like they carry a secret", () => {
  const t = scrubText(`ok line\npreimage: 0x${"ab".repeat(32)}\nsecret=${"cd".repeat(32)}\nlast`);
  assert.ok(!t.includes("abab") && !t.includes("cdcd"));
  assert.match(t, /ok line/);
  assert.match(t, /last/);
});

// ---------------------------------------------------------------- loop text
test("loop text: watch.sh's one-line format, a line cut at 1200 characters, and the block format", () => {
  const text = [
    `18:25:14 [alice] tick exit 0 at 18:25:14 noid: tip 281108 instance {"a": 1} eth : latest 1 ACTION: {"action": "wait", "reason": "waiting for \\"funding\\" finality"} notes: [] intent: {"status": "none"} applied: True phase_after: funded`,
    `18:25:44 [alice] tick exit 0 at 18:25:44 noid: tip 281109 ACTION: {"action": "reveal_eth", "lock_id": "0x1"} notes: ["a long note that was cut by cut -c1-1200`,
    `18:26:14 [alice] tick exit 1 at 18:26:14 `,
    `18:26:44 [alice] tick exit 0 at 18:26:44 ACTION: {"kind": "lock_eth", "parameters": "withheld"} applied: True phase_after: funding_final`,
    "not a tick line",
  ].join("\n");
  const { entries, total } = parseLoopText(text);
  assert.equal(total, 4);
  assert.equal(entries[0].phase_after, "funded");
  assert.equal(entries[0].reason, 'waiting for "funding" finality');
  assert.equal(entries[0].intent_status, "none");
  assert.equal(entries[1].action, "reveal_eth");
  assert.equal(entries[1].phase_after, null);
  assert.equal(entries[1].truncated, true);
  assert.equal(entries[2].exit_code, 1);
  assert.equal(entries[3].action, "lock_eth", "a withheld spend prints kind, not action");
  assert.deepEqual(phaseChanges(entries), [{ time: "18:26:44", from: "funded", to: "funding_final" }]);
  const block = `[bob] tick exit 0 at 18:25:14\nnoid: tip 1\nACTION: {"action": "wait", "reason": "r"}\nnotes: []\napplied: True phase_after: locked\n`;
  const b = parseLoopText(block);
  assert.equal(b.entries[0].phase_after, "locked");
  assert.equal(b.entries[0].role, "bob");
  assert.equal(parseLoopText("").entries.length, 0);
  assert.equal(parseLoopText(null).entries.length, 0);
  const many = Array.from({ length: 100 }, (_, i) => `00:00:${String(i % 60).padStart(2, "0")} [alice] tick exit 0 at 00:00:00 ACTION: {"action": "wait"} phase_after: created`).join("\n");
  assert.equal(parseLoopText(many, 40).entries.length, 40);
  assert.equal(parseLoopText(many, 40).total, 100);
});

test("WSL share paths are understood in either slash style", () => {
  assert.deepEqual(wslParts("//wsl.localhost/Ubuntu-24.04/home/u/live-run-4"), { distro: "Ubuntu-24.04", linux: "/home/u/live-run-4" });
  assert.deepEqual(pathCandidates("//wsl.localhost/D/x/y"), ["//wsl.localhost/D/x/y", "//wsl$/D/x/y"]);
  assert.deepEqual(pathCandidates("//wsl$/D/x"), ["//wsl$/D/x", "//wsl.localhost/D/x"]);
  assert.equal(wslParts("/home/u/run"), null);
  assert.equal(wslParts("//server/share/x"), null);
});
