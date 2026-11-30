"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { ReadOnlyRunner, buildCommand, validateConfig, runNumberOf, TABLE, FORBIDDEN_ARGS } = require("../lib/runner");

const WSL = { distro: "Ubuntu-24.04", runDir: "/home/u/live-run-4", binDir: "/home/u/live-run-4/bin" };
const NATIVE = { distro: null, runDir: "/srv/run", binDir: "/srv/run/bin" };

test("the helper table has no spending form: no --apply, --submit, --replace, --mainnet, no un-dry send", () => {
  const spendScripts = new Set(["lock.sh", "reveal.sh", "refund-eth.sh"]);
  const ids = new Set();
  for (const e of TABLE) {
    assert.ok(!ids.has(e.id), "unique ids");
    ids.add(e.id);
    for (const a of e.args) assert.ok(!FORBIDDEN_ARGS.test(a), `${e.id}: forbidden argument ${a}`);
    if (spendScripts.has(e.script)) assert.deepEqual(e.args, ["--dry-run"], `${e.id}: a sending helper only with --dry-run`);
    if (e.script === "tick.sh") assert.ok(e.args.length === 1 && ["alice", "bob"].includes(e.args[0]), "tick only for a role, never --apply");
    if (e.script === "claim.sh") assert.deepEqual(e.args, [], "claim.sh without --submit is the dry run");
    assert.ok(!/parano1d-cli|swap-cli|live\.js/.test(e.script), "only the helpers of scripts/live");
    assert.ok(/^[a-z-]+\.sh$/.test(e.script));
  }
  assert.deepEqual([...ids].sort(), ["check-object", "dry-claim", "dry-lock", "dry-refund-eth", "dry-reveal", "tick-alice", "tick-bob"]);
});

test("buildCommand: wsl.exe and native forms, an argument vector, no shell", () => {
  const w = buildCommand("dry-reveal", WSL, { PATH: "p", SystemRoot: "C:\\Windows", SECRET_THING: "x", SWAP_PASSPHRASE: "x" });
  assert.equal(w.file, "wsl.exe");
  assert.deepEqual(w.args, ["-d", "Ubuntu-24.04", "-e", "env", "L=/home/u/live-run-4", "bash", "/home/u/live-run-4/bin/reveal.sh", "--dry-run"]);
  assert.deepEqual(Object.keys(w.env).sort(), ["PATH", "SystemRoot"], "the child gets a cleared environment: no passphrase, no secrets");
  const n = buildCommand("tick-bob", NATIVE, { PATH: "p", HOME: "/h", SWAP_PASSPHRASE: "x" });
  assert.equal(n.file, "env");
  assert.deepEqual(n.args, ["L=/srv/run", "bash", "/srv/run/bin/tick.sh", "bob"]);
  assert.equal(n.env.L, "/srv/run");
  assert.ok(!("SWAP_PASSPHRASE" in n.env));
  assert.equal(buildCommand("dry-claim", NATIVE, {}).args.at(-1), "/srv/run/bin/claim.sh");
  assert.equal(buildCommand("dry-claim", NATIVE, {}).file, "env");
});

test("buildCommand: RUN reaches the helpers when the run number is known (their public copy folder, and so check-object's object file, follows from it)", () => {
  const w = buildCommand("check-object", { ...WSL, runNumber: 11 }, { PATH: "p" });
  assert.deepEqual(w.args, ["-d", "Ubuntu-24.04", "-e", "env", "RUN=11", "L=/home/u/live-run-4", "bash", "/home/u/live-run-4/bin/check-object.sh"]);
  const n = buildCommand("check-object", { ...NATIVE, runNumber: 11 }, { PATH: "p" });
  assert.deepEqual(n.args.slice(0, 2), ["RUN=11", "L=/srv/run"]);
  assert.equal(n.env.RUN, "11");
  for (const bad of [0, -1, 10000, 1.5, "11; id", NaN, null, undefined]) assert.ok(!buildCommand("tick-alice", { ...WSL, runNumber: bad }).args.some((a) => /^RUN=/.test(a)), String(bad));
  assert.equal(runNumberOf("/home/u/live-run-7"), 7);
  assert.equal(runNumberOf("/home/u/live-run-ui-test"), null);
});

test("buildCommand: unknown ids and anything that is not in the table are refused", () => {
  for (const id of ["lock", "reveal", "claim-submit", "tick-alice --apply", "../tick-alice", "", "dry-lock; rm -rf /", undefined, null, 5, {}, "__proto__", "constructor"]) {
    assert.throws(() => buildCommand(id, WSL), /unknown helper id/, String(id));
  }
});

test("config validation: plain absolute POSIX paths and a plain distro name only", () => {
  assert.deepEqual(validateConfig(WSL), []);
  assert.deepEqual(validateConfig(NATIVE), []);
  assert.ok(validateConfig({ ...WSL, runDir: "~/live-run-4" }).length);
  assert.ok(validateConfig({ ...WSL, runDir: "/home/u/a b" }).length);
  assert.ok(validateConfig({ ...WSL, binDir: "/home/u/../etc" }).length);
  assert.ok(validateConfig({ ...WSL, binDir: "/home/u/bin;id" }).length);
  assert.ok(validateConfig({ ...WSL, distro: "Ubuntu; calc" }).length);
  assert.ok(validateConfig({ ...WSL, binDir: null }).length);
  assert.throws(() => buildCommand("tick-alice", { ...WSL, runDir: "/x y" }), /absolute POSIX path/);
});

test("runner: runs the fixed command, cleans the output, is single-flight and rate-limited", async () => {
  const calls = [];
  let release;
  const exec = (file, args, opts, cb) => {
    calls.push({ file, args, opts });
    const done = () => cb(null, JSON.stringify({ dryRun: true, preimage: "0x" + "5e".repeat(32), lockId: "0x1" }), "stderr text\nsecret=" + "ef".repeat(32) + "\n");
    if (release === undefined) done();
    else release.fn = done;
  };
  const r = new ReadOnlyRunner(WSL, exec);
  const res = await r.run("dry-lock");
  assert.equal(res.ok, true);
  assert.equal(res.exit_code, 0);
  assert.equal(calls[0].file, "wsl.exe");
  assert.equal(calls[0].opts.shell, false);
  assert.ok(!res.stdout.includes("5e5e5e"), "JSON output is stripped");
  assert.match(res.stdout, /withheld/);
  assert.ok(!res.stderr.includes("efefef"), "text output is scrubbed");
  assert.match(res.command, /lock\.sh --dry-run$/);
  // too fast
  await assert.rejects(() => r.run("dry-lock"), (e) => e.status === 429);
  // busy
  release = {};
  const first = r.run("tick-alice");
  await assert.rejects(() => r.run("tick-bob"), (e) => e.status === 409);
  release.fn();
  assert.equal((await first).ok, true);
  // unknown id
  await assert.rejects(() => r.run("lock"), /unknown helper id/);
  assert.equal(r.describe().length, TABLE.length);
});

test("runner: a failing helper is reported with its exit code, a missing wsl.exe as an error", async () => {
  const r1 = new ReadOnlyRunner(WSL, (f, a, o, cb) => cb(Object.assign(new Error("exit 2"), { code: 2 }), "", "refusing: past the cutoff\n"));
  const a = await r1.run("dry-reveal");
  assert.equal(a.ok, false);
  assert.equal(a.exit_code, 2);
  assert.match(a.stderr, /past the cutoff/);
  const r2 = new ReadOnlyRunner(WSL, (f, a2, o, cb) => cb(Object.assign(new Error("spawn wsl.exe ENOENT"), { code: "ENOENT" }), "", ""));
  const b = await r2.run("tick-alice");
  assert.equal(b.ok, false);
  assert.equal(b.exit_code, null);
  assert.match(b.error, /ENOENT/);
  const r3 = new ReadOnlyRunner(WSL, (f, a2, o, cb) => cb(Object.assign(new Error("killed"), { killed: true, code: null }), "", ""));
  assert.equal((await r3.run("dry-claim")).timed_out, true);
});

test("--role for the read-only runner: the other role's ids are refused (403) before anything is spawned, and not listed", async () => {
  const { roleBlock } = require("../lib/runner");
  const calls = [];
  const r = new ReadOnlyRunner({ ...WSL, role: "alice" }, (file, args, o, cb) => (calls.push(args), cb(null, "", "")));
  assert.deepEqual(r.describe().map((x) => x.id).sort(), ["check-object", "dry-reveal", "tick-alice"]);
  for (const id of ["tick-bob", "dry-lock", "dry-claim", "dry-refund-eth"]) {
    await assert.rejects(() => r.run(id), (e) => e.status === 403 && /--role alice/.test(e.message), id);
  }
  assert.equal(calls.length, 0);
  assert.equal(roleBlock("tick-bob", "both"), null);
  assert.equal(roleBlock("tick-bob", undefined), null);
  assert.equal(roleBlock("check-object", "alice"), null);
  const both = new ReadOnlyRunner({ ...WSL, role: "both" }, (file, args, o, cb) => cb(null, "", ""));
  assert.equal(both.describe().length, 7);
  assert.ok(validateConfig({ ...WSL, role: "carol" }).length);
  assert.deepEqual(validateConfig({ ...WSL, role: "bob" }), []);
});

test("--role bob for the read-only runner: check-object (Alice's helper) is refused too, Bob's ticks and dry runs are listed", async () => {
  const b = new ReadOnlyRunner({ ...WSL, role: "bob" }, (file, args, o, cb) => cb(null, "", ""));
  assert.deepEqual(b.describe().map((x) => x.id).sort(), ["dry-claim", "dry-lock", "dry-refund-eth", "tick-bob"]);
  await assert.rejects(() => b.run("check-object"), (e) => e.status === 403 && /belongs to alice/.test(e.message));
});
