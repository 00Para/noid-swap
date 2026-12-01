"use strict";
// Bob's first step: the table's `join` action (role, production, lock, the exact argument vector, no path from the browser), the files the screen reads,
// the settings form writing the ten terms join.sh requires, and the page logic of "Join a swap" (when it shows, which step is done, the check line).
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

global.window = global.window || {};
require("../actions.js");
const J = global.window.NoidActions.join;
const S = global.window.NoidActions.start;
const A = require("../lib/actions");
const { AuditLog } = require("../lib/audit");
const { readRun } = require("../lib/runfolder");
const { validateForm, renderEnvLocal } = require("../lib/swapform");
const { handleActionPost } = require("../lib/actionroutes");
const F = require("./actions-fixtures");

const WSL = { skipFolderCheck: true, distro: "Ubuntu-24.04", runDir: "/home/u/live-run-5", binDir: "/home/u/live-run-5/bin", runNumber: 5, repoLiveDir: "/mnt/c/repo/scripts/live" };
const exit = (code) => Object.assign(new Error("exit " + code), { code });

// ------------------------------------------------------------------ the table entry
test("join: a setup action of Bob's, one optional argument slot, run from the frozen helpers", () => {
  const e = A.BY_ID.get("join");
  assert.equal(e.group, "setup");
  assert.equal(e.role, "bob");
  assert.deepEqual(e.script, { from: "bin", name: "join.sh" });
  assert.deepEqual(e.args, ["{BUNDLE?}"]);
  assert.ok(Object.isFrozen(e) && Object.isFrozen(e.args));
  assert.ok(!SPENDS_HAS("join"), "it is not a spend");
});
const SPENDS_HAS = (id) => !!require("../lib/gate").SPENDS[id];

test("join: the exact argument vector; no argument unless the server asks for the public copy", () => {
  const base = ["-d", "Ubuntu-24.04", "-e", "env", "RUN=5", "L=/home/u/live-run-5", "bash", "/home/u/live-run-5/bin/join.sh"];
  const c = A.buildActionCommand("join", { ...WSL, runDirs: ["//wsl.localhost/Ubuntu-24.04/home/u/live-run-5", "C:\\Users\\x\\pub"] });
  assert.deepEqual(c.args, base, "no argument by default");
  // the public copy folder of the console's own configuration, in the form the helper needs
  const pub = (dir, over = {}) => A.buildActionCommand("join", { ...WSL, runDirs: ["//wsl.localhost/Ubuntu-24.04/home/u/live-run-5", dir], ...over }, { bundleFromPublic: true }).args.slice(8);
  assert.deepEqual(pub("C:\\Users\\x\\pub"), ["/mnt/c/Users/x/pub/alice.bundle.json"]);
  assert.deepEqual(pub("C:/Users/x/pub/"), ["/mnt/c/Users/x/pub/alice.bundle.json"]);
  assert.deepEqual(pub("//wsl.localhost/Ubuntu-24.04/home/u/pub"), ["/home/u/pub/alice.bundle.json"]);
  assert.deepEqual(pub("\\\\wsl$\\ubuntu-24.04\\home\\u\\pub"), ["/home/u/pub/alice.bundle.json"], "the distro name is compared without case");
  // what cannot be said with plain characters, a share of another distro, a drive path with no distro: no argument at all
  assert.deepEqual(pub("C:\\Users\\a b\\pub"), []);
  assert.deepEqual(pub("//wsl.localhost/Debian/home/u/pub"), []);
  assert.deepEqual(pub("C:\\Users\\x\\pub", { distro: null }), []);
  assert.deepEqual(pub("C:\\Users\\x\\..\\pub"), []);
  assert.deepEqual(pub("C:\\Users\\x;id\\pub"), []);
  assert.deepEqual(pub("pub"), []);
  assert.deepEqual(A.buildActionCommand("join", { distro: null, runDir: "/srv/run-5", binDir: "/srv/run-5/bin", runNumber: 5, runDirs: ["/srv/run-5", "/srv/pub"] }, { bundleFromPublic: true }).args, ["RUN=5", "L=/srv/run-5", "bash", "/srv/run-5/bin/join.sh", "/srv/pub/alice.bundle.json"], "a console without a distro (a Mac): the plain path");
  // the caller's say-so is a switch, never a value: nothing from outside becomes an argument
  for (const v of ["/etc/passwd", "../../x", "$(id)", true, 1]) {
    const x = A.buildActionCommand("join", { ...WSL, runDirs: ["//wsl.localhost/Ubuntu-24.04/home/u/live-run-5", "C:\\Users\\x\\pub"] }, { bundleFromPublic: v === true ? "yes" : v, bundleArg: v, path: v, file: v });
    assert.deepEqual(x.args, base, `ignored: ${String(v)}`);
  }
  assert.equal(A.helperPathOf("C:\\Users\\x\\pub", null), null);
});

// ------------------------------------------------------------------ the runner
function harness(o = {}) {
  const f = F.makeFolders();
  const clock = { ms: Date.now() };
  const log = [];
  const exec = (file, args, opts, cb) => {
    const si = args.findIndex((a) => /\.sh$/.test(a));
    log.push({ script: si >= 0 ? path.basename(args[si]) : "inline", flags: si >= 0 ? args.slice(si + 1) : [], args });
    if (o.fail) return cb(exit(o.fail), "no usable bundle: x (nothing was written)\n", "");
    cb(null, "new-bob exit 0\n", "");
  };
  const audit = new AuditLog(f.pub, { now: () => clock.ms, role: o.role });
  const dirs = o.dirs || [f.run, f.pub];
  const runner = new A.ActionRunner({ ...WSL, ...(o.role ? { role: o.role } : {}), runDirs: dirs }, { audit, exec, spawnDetached: () => ({ unref() {}, on() {} }), now: () => clock.ms, pollWatch: false, ...(o.deps || {}) });
  if (o.lock) runner.runLock = o.lock;
  return { f, clock, log, runner, audit, adv: (ms) => (clock.ms += ms), view: () => runner.view(readRun(dirs, Math.floor(clock.ms / 1000))) };
}
const refused = (fn) => {
  try {
    fn();
  } catch (e) {
    return e;
  }
  assert.fail("expected a refusal");
};

test("join: runs as Bob's non-spending action, is audited, and one job at a time", { skip: F.WSL_HOST_ONLY }, () => {
  const h = harness();
  try {
    fs.rmSync(path.join(h.f.run, "alice.bundle.json"));
    const job = h.runner.startAction("join");
    assert.equal(job.state, "done");
    assert.equal(job.ok, true);
    assert.equal(job.role, "bob");
    assert.equal(h.log.length, 1);
    assert.equal(h.log[0].script, "join.sh");
    assert.equal(h.log[0].flags.length, 1, "the run folder has no file: the public copy's path is the one argument");
    const a = h.audit.tail(5);
    assert.deepEqual(a.map((l) => [l.action, l.phase]), [["join", "start"], ["join", "end"]]);
    // too fast, and busy
    assert.equal(refused(() => h.runner.startAction("join")).status, 429);
  } finally {
    h.f.cleanup();
  }
  const d = harness({ deps: {} });
  try {
    d.runner.busy = { id: "setup", job: 1, started_ms: Date.now() };
    assert.equal(refused(() => d.runner.startAction("join")).status, 409);
    assert.equal(d.log.length, 0);
  } finally {
    d.f.cleanup();
  }
});

test("join: the public copy's file is passed (built on the server) only when the run folder has none and the public one is good", { skip: F.WSL_HOST_ONLY }, () => {
  // the fixtures' folders are Windows temp paths; the console reads them as a drive path under the distro
  const tailOf = (args) => args.slice(args.findIndex((a) => /join\.sh$/.test(a)) + 1);
  // the run folder has the file: no argument, whatever the public folder holds
  const h1 = harness();
  try {
    h1.runner.startAction("join");
    assert.deepEqual(tailOf(h1.log[0].args), []);
  } finally {
    h1.f.cleanup();
  }
  // only the public folder has it
  const h2 = harness();
  try {
    fs.rmSync(path.join(h2.f.run, "alice.bundle.json"));
    h2.runner.startAction("join");
    const arg = tailOf(h2.log[0].args);
    assert.equal(arg.length, 1);
    assert.match(arg[0], /^\/mnt\/[a-z]\/.*\/public\/alice\.bundle\.json$/);
    assert.ok(!/\.\./.test(arg[0]));
    assert.match(h2.audit.tail(5)[0].detail, /bundle from the public copy folder/);
    assert.equal(h2.runner.view(readRun([h2.f.run, h2.f.pub], 1)).join.public_arg, true);
  } finally {
    h2.f.cleanup();
  }
  // the public file is not usable (not JSON): no argument, the helper's own refusal stands
  const h3 = harness();
  try {
    fs.rmSync(path.join(h3.f.run, "alice.bundle.json"));
    fs.writeFileSync(path.join(h3.f.pub, "alice.bundle.json"), "not json");
    h3.runner.startAction("join");
    assert.deepEqual(tailOf(h3.log[0].args), []);
  } finally {
    h3.f.cleanup();
  }
  // a bad file in the run folder is not papered over with the public one
  const h4 = harness();
  try {
    fs.writeFileSync(path.join(h4.f.run, "alice.bundle.json"), "");
    h4.runner.startAction("join");
    assert.deepEqual(tailOf(h4.log[0].args), []);
  } finally {
    h4.f.cleanup();
  }
});

test("join: no path, hash or file name from the browser reaches the command", () => {
  const h = harness();
  try {
    fs.rmSync(path.join(h.f.run, "alice.bundle.json"));
    const out = handleActionPost("/api/action", { id: "join", path: "/etc/passwd", bundle: "/etc/passwd", args: ["--x"], txHash: "0x" + "ab".repeat(32) }, { actions: h.runner, runDir: h.f.run });
    assert.equal(out.status, 202);
    const argv = h.log[0].args.join(" ");
    assert.ok(!/passwd|--x|abab/.test(argv), argv);
  } finally {
    h.f.cleanup();
  }
});

test("join: a console started with --role alice refuses it (403), and a production run refuses it with an audit line", () => {
  const a = harness({ role: "alice" });
  try {
    const e = refused(() => a.runner.startAction("join"));
    assert.equal(e.status, 403);
    assert.match(e.message, /started with --role alice: join belongs to bob, which runs on another machine/);
    assert.equal(a.log.length, 0);
    assert.equal(a.runner.view(readRun([a.f.run, a.f.pub], 1)).table.find((t) => t.id === "join").blocked.includes("another machine"), true);
  } finally {
    a.f.cleanup();
  }
  for (const role of [undefined, "bob"]) {
    const h = harness({ role });
    try {
      fs.writeFileSync(path.join(h.f.run, "env.local.sh"), "PROFILE='production'\nCHAIN='1'\n");
      const e = refused(() => h.runner.startAction("join"));
      assert.equal(e.status, 403);
      assert.match(e.message, /does not act on a production swap/);
      assert.equal(h.log.length, 0);
      assert.ok(h.audit.tail(5).some((l) => l.action === "join" && l.phase === "refused" && /production swap/.test(l.result)));
      assert.match(h.view().table.find((t) => t.id === "join").blocked, /production/);
    } finally {
      h.f.cleanup();
    }
  }
});

test("join: the run folder's lock is looked at first (a console that does not hold it runs nothing)", () => {
  const h = harness({ lock: { verify: () => ({ ok: false, why: "pid 7 holds it" }), isLazy: false, file: "ui-console.lock" } });
  try {
    const e = refused(() => h.runner.startAction("join"));
    assert.equal(e.status, 409);
    assert.match(e.message, /no longer holds the run folder's lock/);
    assert.equal(h.log.length, 0);
    assert.ok(h.audit.tail(5).some((l) => l.action === "join" && /run lock not ours/.test(l.result)));
  } finally {
    h.f.cleanup();
  }
});

test("join: the view's file facts: names, plain files only, links and bad files are named, nothing of the content", { skip: F.WSL_HOST_ONLY }, () => {
  const h = harness();
  try {
    let j = h.view().join;
    assert.equal(j.run_bundle.ok, true);
    assert.equal(j.public_bundle.ok, true);
    assert.equal(j.public_arg, true);
    assert.equal(j.bob_file, false);
    assert.equal(j.alice_file, false);
    assert.equal(j.receipt_in_run, false);
    assert.ok(!JSON.stringify(j).includes("hashlock"), "no content");
    fs.writeFileSync(path.join(h.f.run, "alice.bundle.json"), "");
    assert.equal(h.view().join.run_bundle.problem, "empty");
    fs.writeFileSync(path.join(h.f.run, "alice.bundle.json"), "[1]");
    assert.equal(h.view().join.run_bundle.problem, "not a JSON object");
    fs.writeFileSync(path.join(h.f.run, "alice.bundle.json"), "{x");
    assert.equal(h.view().join.run_bundle.problem, "not JSON");
    fs.writeFileSync(path.join(h.f.run, "alice.bundle.json"), "{" + " ".repeat(1048577) + "}");
    assert.equal(h.view().join.run_bundle.problem, "above 1 MB");
    fs.rmSync(path.join(h.f.run, "alice.bundle.json"));
    assert.equal(h.view().join.run_bundle, null);
    // a directory of that name is not a file
    fs.mkdirSync(path.join(h.f.run, "alice.bundle.json"));
    assert.equal(h.view().join.run_bundle.problem, "not a regular file");
    fs.rmdirSync(path.join(h.f.run, "alice.bundle.json"));
    // a symbolic link (where the platform lets a test make one) is refused like the helper refuses it
    try {
      fs.symlinkSync(path.join(h.f.pub, "alice.bundle.json"), path.join(h.f.run, "alice.bundle.json"));
      assert.equal(h.view().join.run_bundle.problem, "a symbolic link");
    } catch (e) {
      if (!/EPERM|EACCES|ENOSYS/.test(String(e.code))) throw e;
    }
    // Bob's swap file, Alice's swap file, the receipt
    fs.mkdirSync(path.join(h.f.run, "bob"));
    fs.writeFileSync(path.join(h.f.run, "bob", "bob.swap.json"), "{}");
    fs.writeFileSync(path.join(h.f.run, "alice.swap.json"), "{}");
    fs.writeFileSync(path.join(h.f.run, "alice.receipt"), "x");
    j = h.view().join;
    assert.equal(j.bob_file, true);
    assert.equal(j.alice_file, true);
    assert.equal(j.receipt_in_run, true);
  } finally {
    h.f.cleanup();
  }
});

// ------------------------------------------------------------------ the form writes the ten terms
const A1 = "o1lqvrmvsyl7mkt3cptkz3c965ujt5ce6mjawxwwxe7mgn36mjzt8sn69xw2";
const A2 = "o125qayvgtmvqnlhqmqwe08dza3acaax5mct3u5h4uen3qtrds3jfset7wlk";
const E = (n) => "0x" + String(n).repeat(40).slice(0, 40);
const GOOD = { role: "bob", run: "5", profile: "sepolia", lock_kind: "sha256", noid_amount: "5", eth_amount: "0.001", alice_noid: A1, bob_noid: A2, alice_eth: E("a"), bob_eth: E("b"), contract: E("c"), single_node_ok: false };
const TEN = ["BOB_NOID", "BOB_ETH", "CONTRACT", "AMOUNT", "WEI", "CHAIN", "PROFILE", "CONTRACT_VERSION", "LOCK_KIND", "VARIANT"];
const assigns = (text, name) => new RegExp(`^(export[ \\t]+)?${name}=`, "m").test(text); // join.sh's own test, grep -E "^(export[[:space:]]+)?NAME="

test("the settings form writes every term join.sh requires, each from a validated value", () => {
  const v = validateForm(GOOD, { runNumber: 5 });
  assert.equal(v.ok, true, JSON.stringify(v.errors));
  const t = renderEnvLocal(v.values, "x");
  for (const n of TEN) assert.ok(assigns(t, n), n);
  assert.match(t, /^VARIANT='raw'$/m);
  assert.match(t, /^CONTRACT_VERSION='1'$/m, "the helpers' default, now written");
  assert.match(t, /^CHAIN='11155111'$/m);
  // chosen values
  const w = validateForm({ ...GOOD, contract_version: "2" }, { runNumber: 5 });
  assert.equal(w.ok, true, JSON.stringify(w.errors));
  const t2 = renderEnvLocal(w.values, "x");
  assert.match(t2, /^VARIANT='raw'$/m);
  assert.match(t2, /^CONTRACT_VERSION='2'$/m);
  // the stock variant is not offered by the form
  assert.equal(validateForm({ ...GOOD, variant: "stock" }, { runNumber: 5 }).ok, false);
  // empty means the default
  assert.match(renderEnvLocal(validateForm({ ...GOOD, variant: "", contract_version: " " }, { runNumber: 5 }).values, "x"), /^CONTRACT_VERSION='1'$/m);
  // strict lists
  for (const bad of ["", "RAW", "raw;id", "poseidon", "x", 1]) if (bad !== "") assert.equal(validateForm({ ...GOOD, variant: bad }, { runNumber: 5 }).ok, false, String(bad));
  for (const bad of ["0", "3", "1;id", "v2", 2, "01"]) assert.equal(validateForm({ ...GOOD, contract_version: bad }, { runNumber: 5 }).ok, false, String(bad));
  // the poseidon lock kind needs raw
  assert.equal(validateForm({ ...GOOD, lock_kind: "poseidon", variant: "stock" }, { runNumber: 5 }).ok, false);
  assert.equal(validateForm({ ...GOOD, lock_kind: "poseidon" }, { runNumber: 5 }).ok, true);
  // every value line is still a plain single-quoted word
  for (const l of t2.split("\n").filter((l) => l && !l.startsWith("#"))) assert.match(l, /^[A-Z_0-9]+='[A-Za-z0-9._/@+-]+'$/, l);
});

// ------------------------------------------------------------------ the screen: when it shows
const job = (id, o = {}) => ({ job: 1, id, state: "done", ok: true, exit_code: 0, finished_at: 1_800_000_000, stdout: "", ...o });
function payload(o = {}) {
  return {
    role: o.role === undefined ? "bob" : o.role,
    dirs: o.dirs || [{ path: "C:\\run", readable: true }, { path: "C:\\pub", readable: true }],
    errors: o.errors || [],
    roles: o.roles === undefined ? { alice: null, bob: null } : o.roles,
    helpers: o.helpers || [],
    bundle: null,
    bundle_file: o.bundle_file || null,
    terms: null,
    actions: {
      enabled: true,
      production: o.production || null,
      jobs: o.jobs || [],
      lock: o.lock === undefined ? null : o.lock,
      watch: o.watch || { started_here: false, some_loop_running: false },
      form: { env_local: o.env === undefined ? { exists: false } : o.env },
      funding: { object_check_ok: false, marker_at: o.marker || null, acknowledged_at: o.ack || null, blocked_by: o.blocked || null },
      join: o.join === undefined ? { run_bundle: null, public_bundle: null, public_arg: false, receipt_in_run: false, bob_file: false, alice_file: false } : o.join,
    },
  };
}
const GOODFILE = { ok: true, size: 10, mtime: 1, problem: null };

test("the join screen shows for Bob in actions mode while nothing of his swap exists", () => {
  assert.equal(J.noJoinStarted(payload(), "bob"), true);
  assert.equal(J.noJoinStarted(payload({ role: "both" }), "bob"), true);
  assert.equal(J.noJoinStarted(payload({ roles: {}, lock: { held: false, folder_missing: true } }), "bob"), true, "the run folder does not exist yet");
});

test("each fact that says a swap exists, or that this is not Bob's page, turns the join screen off", () => {
  assert.equal(J.noJoinStarted(null, "bob"), false);
  assert.equal(J.noJoinStarted({ ...payload(), actions: { enabled: false } }, "bob"), false, "not the actions mode");
  assert.equal(J.noJoinStarted(payload(), "alice"), false, "Alice is selected");
  assert.equal(J.noJoinStarted(payload({ role: "alice" }), "bob"), false, "a console that drives Alice only");
  assert.equal(J.noJoinStarted(payload({ production: { text: "production" } }), "bob"), false);
  // a tick of Bob's in any form: readable, with an error, half written (error), only its loop file
  assert.equal(J.noJoinStarted(payload({ roles: { alice: null, bob: { tick: { phase: "received" } } } }), "bob"), false);
  assert.equal(J.noJoinStarted(payload({ roles: { alice: null, bob: { tick: null, tick_error: "bad" } } }), "bob"), false);
  assert.equal(J.noJoinStarted(payload({ roles: { alice: null, bob: { tick: null, loop: { entries: [] } } } }), "bob"), false);
  // Alice's tick: on a console for both roles one owner holds both files; on a console for Bob alone it is another machine's and does not count
  assert.equal(J.noJoinStarted(payload({ role: "both", roles: { alice: { tick: {} }, bob: null } }), "bob"), false);
  assert.equal(J.noJoinStarted(payload({ roles: { alice: { tick: {} }, bob: null } }), "bob"), true);
  assert.equal(J.noJoinStarted(payload({ marker: "2026-11-17T10:00:00Z" }), "bob"), false, "a funding marker");
  assert.equal(J.noJoinStarted(payload({ ack: 1 }), "bob"), false);
  assert.equal(J.noJoinStarted(payload({ blocked: "funded.marker" }), "bob"), false);
  assert.equal(J.noJoinStarted(payload({ helpers: [{ kind: "eth_lock" }] }), "bob"), false, "a helper result file");
  assert.equal(J.noJoinStarted(payload({ join: undefined, ...{} }), "bob"), true);
  const noFacts = payload();
  delete noFacts.actions.join;
  assert.equal(J.noJoinStarted(noFacts, "bob"), false, "without the server's file facts it does not show");
  assert.equal(J.noJoinStarted(payload({ join: { alice_file: true, bob_file: false } }), "bob"), false, "Alice's swap file is in this folder");
  assert.equal(J.noJoinStarted(payload({ errors: ["bundle: bad json"] }), "bob"), false);
  assert.equal(J.noJoinStarted(payload({ dirs: [] }), "bob"), false);
});

test("Bob's swap file: known from any other cause it is off; made by this console's own join it stays", () => {
  const withFile = (jobs) => payload({ join: { bob_file: true, alice_file: false, run_bundle: GOODFILE }, jobs });
  assert.equal(J.noJoinStarted(withFile([]), "bob"), false, "no record of a join: the file comes from elsewhere");
  assert.equal(J.noJoinStarted(withFile([job("join", { ok: false, exit_code: 8 })]), "bob"), false, "the newest join failed: not that one that made it");
  assert.equal(J.noJoinStarted(withFile([job("join")]), "bob"), true);
  assert.equal(J.noJoinStarted(withFile([job("join", { state: "running", ok: null })]), "bob"), true);
  assert.equal(J.noJoinStarted(withFile([job("join"), job("join", { ok: false })]), "bob"), false, "clean, then a failed one");
});

test("with the unreadable-folder cases from real readRun output", () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "noid-join-"));
  try {
    const pub = path.join(base, "pub");
    fs.mkdirSync(pub);
    fs.writeFileSync(path.join(pub, "alice.bundle.json"), JSON.stringify({ hashlock: "0x" + "00".repeat(32), params: {} }));
    const real = (dirs, lock) => ({ ...readRun(dirs, 1_800_000_000), role: "bob", actions: { enabled: true, production: null, jobs: [], lock: lock || null, form: { env_local: { exists: false } }, funding: {}, join: payload().actions.join } });
    assert.equal(J.noJoinStarted(real([path.join(base, "gone"), pub]), "bob"), false, "the share to the run folder dropped");
    const run = path.join(base, "run");
    fs.mkdirSync(run);
    assert.equal(J.noJoinStarted(real([run, pub]), "bob"), true);
    assert.equal(J.noJoinStarted(real([path.join(base, "gone")], { held: false, folder_missing: true }), "bob"), true, "only the lazily missing run folder is excused");
    assert.equal(J.noJoinStarted(real([path.join(base, "gone"), path.join(base, "gone2")], { held: false, folder_missing: true }), "bob"), false, "and no other folder");
    // a tick of Bob's in any form
    fs.writeFileSync(path.join(run, "last-tick-bob.err"), "warning\n");
    assert.equal(J.noJoinStarted(real([run, pub]), "bob"), false, "only the .err file");
    fs.rmSync(path.join(run, "last-tick-bob.err"));
    fs.writeFileSync(path.join(run, "last-tick-bob.json"), '{"phase": "rec');
    assert.equal(J.noJoinStarted(real([run, pub]), "bob"), false, "half written");
    fs.writeFileSync(path.join(run, "last-tick-bob.json"), "");
    assert.equal(J.noJoinStarted(real([run, pub]), "bob"), false, "empty");
    fs.rmSync(path.join(run, "last-tick-bob.json"));
    fs.writeFileSync(path.join(run, "loop-bob.txt"), "");
    assert.equal(J.noJoinStarted(real([run, pub]), "bob"), false, "loop file");
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test("the start screen is unchanged by the shared test: Alice's cases still hold", () => {
  const p = (o) => ({ ...payload(o), role: o.role || "both" });
  assert.equal(S.noSwapStarted(p({}), "alice"), true);
  assert.equal(S.noSwapStarted(p({}), "bob"), false);
  assert.equal(S.noSwapStarted(p({ marker: "x" }), "alice"), false);
});

// ------------------------------------------------------------------ the steps
const states = (f) => J.joinSteps(f).map((s) => `${s.id}:${s.state}`).join(" ");
const F0 = { folder_missing: false, install: null, env: null, setup: null, file: { where: null, problem: null }, check: null, watch: null, folder: "C:\\run", states: {} };
const clean = { at: 1 };

test("six steps in this order, one is next", () => {
  const st = J.joinSteps(F0);
  assert.deepEqual(st.map((s) => s.title), ["Install the helpers", "Enter your terms", "Set up", "Put Alice's file in the folder", "Check Alice's file", "Start the watch loop"]);
  assert.deepEqual(st.map((s) => s.action), ["install", null, "setup", null, "join", "watch-start"]);
  assert.equal(st.filter((s) => s.state === "now").length, 1);
  assert.equal(st[0].state, "now");
});

test("each step's own fact marks it done, and the first step that is not done is next", () => {
  assert.equal(states({ ...F0, install: clean }), "install:done terms:now setup:todo file:todo check:todo watch:todo");
  const env = { bytes: 3, mtime: 1 };
  assert.equal(states({ ...F0, install: clean, env }), "install:done terms:done setup:now file:todo check:todo watch:todo");
  assert.equal(states({ ...F0, install: clean, env, setup: clean }), "install:done terms:done setup:done file:now check:todo watch:todo");
  const file = { where: "run", problem: null };
  assert.equal(states({ ...F0, install: clean, env, setup: clean, file }), "install:done terms:done setup:done file:done check:now watch:todo");
  assert.equal(states({ ...F0, install: clean, env, setup: clean, file, check: clean }), "install:done terms:done setup:done file:done check:done watch:now");
  assert.equal(states({ ...F0, install: clean, env, setup: clean, file, check: clean, watch: { pid: 4 } }), "install:done terms:done setup:done file:done check:done watch:done", "everything done: no next step");
});

test("a step is done only from a fact; the check implies the four before it, nothing implies the check or the loop", () => {
  const st = J.joinSteps({ ...F0, check: clean });
  assert.deepEqual(st.map((s) => s.done_by), ["implied", "implied", "implied", "implied", "job", null]);
  assert.equal(st[5].state, "now");
  assert.equal(J.joinSteps({ ...F0, install: clean, env: { bytes: 1 }, setup: clean, file: { where: "public" } })[4].state, "now");
  assert.equal(J.joinSteps({ ...F0, watch: { pid: 1 } })[5].done_by, "loop");
  assert.equal(J.joinSteps({ ...F0, watch: { pid: 1 } })[0].state, "now", "a loop running does not show the setup");
  // exhaustively: no combination marks a step done without its own or an implying fact
  const keys = ["install", "env", "setup", "file", "check", "watch"];
  const val = { install: clean, env: { bytes: 1, mtime: 1 }, setup: clean, file: { where: "run" }, check: clean, watch: { pid: 1 } };
  const own = { install: "install", terms: "env", setup: "setup", file: "file", check: "check", watch: "watch" };
  const implied = { install: ["setup", "check"], terms: ["check"], setup: ["check"], file: ["check"] };
  for (let m = 0; m < 1 << keys.length; m++) {
    const f = { ...F0 };
    keys.forEach((k, i) => {
      if (m & (1 << i)) f[k] = val[k];
    });
    const steps = J.joinSteps(f);
    for (const s of steps) {
      const hasOwn = !!f[own[s.id]] && !(own[s.id] === "file" && !f.file.where);
      const hasImplier = (implied[s.id] || []).some((l) => !!f[own[l]] && (own[l] !== "file" || f.file.where));
      assert.equal(s.state === "done", hasOwn || hasImplier, `${s.id} for ${m}`);
    }
    assert.ok(steps.filter((s) => s.state === "now").length <= 1);
  }
});

test("joinFacts: the newest record of an action decides; a clean join needs Bob's swap file; no run folder, nothing counts", () => {
  const f = (o) => J.joinFacts(payload(o));
  const withFile = { run_bundle: GOODFILE, public_bundle: null, public_arg: false, bob_file: true, alice_file: false, receipt_in_run: false };
  // no record at all: nothing is done by a record
  const none = f({ join: withFile });
  assert.equal(none.install, null);
  assert.equal(none.check, null, "a swap file without a record of the join is not a fact about the check");
  // clean join and the file
  assert.deepEqual(f({ join: withFile, jobs: [job("join")] }).check, { at: 1_800_000_000 });
  // clean join but the file is gone
  assert.equal(f({ join: { ...withFile, bob_file: false }, jobs: [job("join")] }).check, null);
  // clean, then failed or running
  assert.equal(f({ join: withFile, jobs: [job("join"), job("join", { ok: false })] }).check, null);
  assert.equal(f({ join: withFile, jobs: [job("join"), job("join", { state: "running", ok: null })] }).check, null);
  assert.equal(f({ join: withFile, jobs: [job("join", { ok: false }), job("join")] }).check.at, 1_800_000_000);
  assert.equal(f({ join: withFile, jobs: [job("join"), job("join", { ok: false })] }).states.join, "failed");
  // the file: the run folder's good one, the public one when it can be named, and each problem
  const where = (j) => f({ join: { ...withFile, bob_file: false, ...j } }).file;
  assert.deepEqual(where({}), { where: "run", problem: null });
  assert.deepEqual(where({ run_bundle: null, public_bundle: GOODFILE, public_arg: true }), { where: "public", problem: null });
  assert.match(where({ run_bundle: null, public_bundle: GOODFILE, public_arg: false }).problem, /cannot be given to the helper/);
  assert.equal(where({ run_bundle: null, public_bundle: GOODFILE, public_arg: false }).where, null);
  assert.match(where({ run_bundle: { ok: false, problem: "empty" }, public_bundle: GOODFILE, public_arg: true }).problem, /run folder is empty/);
  assert.equal(where({ run_bundle: { ok: false, problem: "empty" }, public_bundle: GOODFILE, public_arg: true }).where, null, "a bad file in the run folder is not hidden by the public one");
  assert.match(where({ run_bundle: null, public_bundle: { ok: false, problem: "not JSON" } }).problem, /public copy folder is not JSON/);
  assert.deepEqual(where({ run_bundle: null, public_bundle: null }), { where: null, problem: null });
  // the loop
  assert.deepEqual(f({ watch: { started_here: true, pid: 9 } }).watch, { pid: 9 });
  assert.equal(f({ watch: { started_here: false, some_loop_running: true } }).watch, null, "another loop's file is not this console's loop");
  assert.equal(f({ env: { exists: true, bytes: 12, mtime: 5 } }).env.bytes, 12);
  assert.equal(f({ env: { exists: false } }).env, null);
  // no run folder
  const m = f({ lock: { held: false, folder_missing: true }, jobs: [job("install")], join: withFile, env: { exists: true, bytes: 1, mtime: 1 } });
  assert.equal(m.folder_missing, true);
  assert.equal(m.install, null);
  assert.equal(m.env, null);
  assert.equal(m.check, null);
  assert.equal(J.joinSteps(m)[0].state, "now");
});

test("a running or a failed join is never done: the strip stays on step 5 and says so", () => {
  const withFile = { run_bundle: GOODFILE, public_bundle: null, public_arg: false, bob_file: false, alice_file: false, receipt_in_run: false };
  const base = { env: { exists: true, bytes: 5, mtime: 1 }, join: withFile };
  const next = (jobs, extra = {}) => J.joinSteps(J.joinFacts(payload({ ...base, ...extra, jobs }))).find((s) => s.state === "now");
  assert.equal(next([job("install"), job("setup")]).id, "check");
  let n = next([job("install"), job("setup"), job("join", { state: "running", ok: null, finished_at: null })]);
  assert.equal(n.id, "check");
  assert.equal(n.rec, "running");
  n = next([job("install"), job("setup"), job("join", { ok: false, exit_code: 8 })]);
  assert.equal(n.id, "check");
  assert.equal(n.rec, "failed");
  // a clean join, then a failed one
  n = next([job("install"), job("setup"), job("join"), job("join", { ok: false })], { join: { ...withFile, bob_file: true } });
  assert.equal(n.id, "check");
  assert.equal(n.rec, "failed");
  // no record of the helpers: the page says it has none (the install step is next, not known)
  n = next([]);
  assert.equal(n.id, "install");
  assert.equal(n.rec, null);
  assert.equal(n.known, false);
  // the failed join does not make the earlier steps look done
  n = next([job("join", { ok: false })], { env: { exists: false } });
  assert.equal(n.id, "install");
});

// ------------------------------------------------------------------ the check line and the terms block
const HEAD = "Your terms, as this machine will state them (check them against what you agreed):";
const TERMS = [
  "  your Parano1d address:  one two three four",
  "  your Ethereum address:  0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "  the contract:           0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  "  the NOID amount:        5000000 micro-NOID",
  "  the ETH amount:         1000000000000000 wei",
  "  the chain:              11155111",
  "  the profile:            sepolia",
  "  the contract version:   1",
  "  the lock kind:          poseidon",
  "  the variant:            raw",
];
const OUT = ["== start", "bundle: x (10 bytes)", HEAD, ...TERMS, "== note", "bundle check: 0123456789abcdef ok", "   ^ compare these digits", "  | self-test ok", "new-bob exit 0"].join("\n");

test("the check line is taken only from the newest clean join record, in the exact form, and only when it is the only one", () => {
  assert.equal(J.joinResult([job("join", { stdout: OUT })]).line, "bundle check: 0123456789abcdef ok");
  assert.equal(J.joinResult([]), null);
  assert.equal(J.joinResult([job("join", { stdout: OUT, ok: false })]), null, "a failed record shows nothing");
  assert.equal(J.joinResult([job("join", { stdout: OUT, state: "running", ok: null })]), null);
  assert.equal(J.joinResult([job("join", { stdout: OUT }), job("join", { stdout: OUT, ok: false })]), null, "clean, then failed: the newest decides");
  assert.equal(J.joinResult([job("join", { stdout: OUT.replace("0123456789abcdef", "fedcba9876543210") }), job("join", { stdout: OUT })]).line, "bundle check: 0123456789abcdef ok", "the newest clean record");
  // the form is exact
  for (const bad of ["bundle check: 0123456789abcde ok", "bundle check: 0123456789abcdefg ok", "bundle check: 0123456789abcdef", "bundle check: 0123456789abcdef ok ", " bundle check: 0123456789abcdef ok", "  | bundle check: 0123456789abcdef ok", "bundle check: one two three four ok", "Bundle check: 0123456789abcdef ok", "bundle check: 0123456789abcdef OK"]) {
    assert.equal(J.joinResult([job("join", { stdout: OUT.replace("bundle check: 0123456789abcdef ok", bad) })]).line, null, bad);
  }
  // two lines: none is shown
  assert.equal(J.joinResult([job("join", { stdout: OUT + "\nbundle check: 1111111111111111 ok" })]).line, null);
  // CRLF is tolerated, as the helper's output may carry it
  assert.equal(J.joinResult([job("join", { stdout: OUT.replace(/\n/g, "\r\n") })]).line, "bundle check: 0123456789abcdef ok");
});

test("Bob's check line stays on his swap page until his lock: the newest clean join record's line, a plain pointer without one, nothing from the lock on", () => {
  const on = { enabled: true, jobs: [job("join", { stdout: OUT })] };
  const v = (role, id) => ({ role, phase: { id } });
  assert.deepEqual(J.BOB_BEFORE_LOCK, ["received", "funded", "funding_final"]);
  for (const id of J.BOB_BEFORE_LOCK) assert.deepEqual(J.bobCheck(v("bob", id), on), { line: "bundle check: 0123456789abcdef ok" }, id);
  // every later phase of Bob's, and the stopped ones: no box
  for (const id of ["lock_submitted", "locked", "secret_seen", "claim_submitted", "claim_included", "done", "refund_submitted", "refund_mined", "refunded", "aborted"]) assert.equal(J.bobCheck(v("bob", id), on), null, id);
  // not Alice's page, not outside actions mode, not without a phase
  assert.equal(J.bobCheck(v("alice", "created"), on), null);
  assert.equal(J.bobCheck(v("bob", "received"), { enabled: false, jobs: on.jobs }), null);
  assert.equal(J.bobCheck(v("bob", "received"), undefined), null);
  assert.equal(J.bobCheck({ role: "bob", phase: null }, on), null);
  // no clean record, a failed newest record, or a record with two lines: the box says where the line is and shows none
  assert.deepEqual(J.bobCheck(v("bob", "funded"), { enabled: true, jobs: [] }), { line: null });
  assert.deepEqual(J.bobCheck(v("bob", "funded"), { enabled: true, jobs: [job("join", { stdout: OUT }), job("join", { stdout: OUT, ok: false })] }), { line: null });
  assert.deepEqual(J.bobCheck(v("bob", "funded"), { enabled: true, jobs: [job("join", { stdout: OUT + "\nbundle check: 1111111111111111 ok" })] }), { line: null });
});

test("the terms block is the ten lines in the helper's order, as printed, else null", () => {
  const r = J.joinResult([job("join", { stdout: OUT })]);
  assert.equal(r.terms.length, 10);
  assert.deepEqual(r.terms[0], { label: "your Parano1d address", value: "one two three four" });
  assert.deepEqual(r.terms[3], { label: "the NOID amount", value: "5000000 micro-NOID" });
  assert.equal(r.terms[9].value, "raw");
  const swapped = [...TERMS];
  [swapped[0], swapped[1]] = [swapped[1], swapped[0]];
  assert.equal(J.joinResult([job("join", { stdout: ["x", HEAD, ...swapped].join("\n") })]).terms, null, "another order");
  assert.equal(J.joinResult([job("join", { stdout: ["x", HEAD, ...TERMS.slice(0, 9)].join("\n") })]).terms, null, "a line short");
  assert.equal(J.joinResult([job("join", { stdout: OUT.replace(HEAD, "Your terms") })]).terms, null, "no header");
  assert.equal(J.joinResult([job("join", { stdout: OUT.replace("  the variant:            raw", "  the variant:") })]).terms, null, "an empty value");
});

