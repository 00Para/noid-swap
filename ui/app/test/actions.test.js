"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const A = require("../lib/actions");
const { AuditLog } = require("../lib/audit");
const { SPENDS } = require("../lib/gate");
const F = require("./actions-fixtures");

const WSL = { skipFolderCheck: true, distro: "Ubuntu-24.04", runDir: "/home/u/live-run-5", binDir: "/home/u/live-run-5/bin", runNumber: 5, repoLiveDir: "/mnt/c/repo/scripts/live" };
const TX = "0x" + "ab".repeat(32);

// ---------------------------------------------------------------------------------------------- the table
test("the table: ids are unique, every script is a helper of scripts/live, nothing takes a free argument", () => {
  const ids = new Set();
  const allowedScripts = new Set(["install.sh", "setup.sh", "prepare.sh", "check-object.sh", "join.sh", "tick.sh", "lock.sh", "reveal.sh", "claim.sh", "refund-eth.sh", "fund.sh"]);
  const allowedArgs = new Set(["{RUN}", "{TX?}", "{BUNDLE?}", "--dry-run", "--replace", "--submit", "alice", "bob"]);
  for (const e of A.TABLE) {
    assert.ok(!ids.has(e.id), "unique " + e.id);
    ids.add(e.id);
    assert.ok(Object.isFrozen(e) && Object.isFrozen(e.args), "frozen: " + e.id);
    if (e.inline) {
      assert.deepEqual(e.args, [], "an inline script takes no argument");
      assert.ok([A.WATCH_START, A.WATCH_STOP, A.WATCH_STATUS].includes(e.inline));
      assert.ok(!/\{|`|\$\(/.test(e.inline.replace(/\$\(cat "\$L\/ui-watch.pid" 2>\/dev\/null\)/g, "")), "no template slot in a fixed script");
    } else {
      assert.ok(allowedScripts.has(e.script.name), e.script.name);
      assert.ok(["bin", "repo"].includes(e.script.from));
      if (e.script.from === "repo") assert.equal(e.script.name, "install.sh", "only install.sh comes from the repository");
      for (const a of e.args) assert.ok(allowedArgs.has(a), `${e.id}: argument ${a}`);
    }
  }
  assert.deepEqual(
    [...ids].sort(),
    ["check-object", "join", "dry-claim", "dry-fund", "dry-lock", "dry-refund-eth", "dry-refund-eth-replace", "dry-reveal", "dry-reveal-replace", "install", "prepare", "send-claim", "send-fund", "send-lock", "send-refund-eth", "send-refund-eth-replace", "send-reveal", "send-reveal-replace", "setup", "tick-alice", "tick-bob", "watch-start", "watch-stop"].sort()
  );
});

test("the groups: only `send-*` ids spend, each has a matching dry run with the same flags, none uses --apply or --mainnet", () => {
  for (const e of A.TABLE) {
    const isSend = /^send-/.test(e.id);
    assert.equal(e.group === "spend", isSend, e.id);
    assert.ok(!e.args.some((a) => /apply|mainnet|closed-by|cancel|secret/.test(a)), e.id);
    if (e.group === "dry") {
      assert.ok(e.args.includes("--dry-run") || e.script.name === "claim.sh", e.id);
      const s = SPENDS[e.spend];
      const send = A.BY_ID.get(s.id);
      assert.equal(send.script.name, e.script.name, "the dry run and the send use the same helper");
      assert.deepEqual(send.args.filter((a) => a !== "--submit"), e.args.filter((a) => a !== "--dry-run"), "same flags apart from the dry-run switch");
      assert.equal(s.dry, e.id);
    }
    if (e.group === "spend") {
      const s = SPENDS[e.id];
      assert.ok(s, "a gate entry exists for " + e.id);
      assert.ok(!e.args.includes("--dry-run"));
    }
    if (e.group === "tick") assert.ok(!e.args.includes("--apply"), "a console tick is read-only");
  }
  // claim.sh without --submit is the dry run; with --submit the spend
  assert.deepEqual(A.BY_ID.get("dry-claim").args, []);
  assert.deepEqual(A.BY_ID.get("send-claim").args, ["--submit"]);
});

test("buildActionCommand: wsl.exe -e, an argument vector, a cleared environment, absolute script paths under the run's bin", () => {
  const env = { PATH: "p", SystemRoot: "C:\\Windows", SWAP_PASSPHRASE: "x", ETH_RPC_URL: "y", SECRET_THING: "z" };
  for (const e of A.TABLE) {
    const c = A.buildActionCommand(e.id, WSL, { txHash: e.args.includes("{TX?}") ? TX : null, env });
    assert.equal(c.file, "wsl.exe");
    assert.deepEqual(c.args.slice(0, 5), ["-d", "Ubuntu-24.04", "-e", "env", "RUN=5"]);
    assert.equal(c.args[5], "L=/home/u/live-run-5");
    assert.deepEqual(Object.keys(c.env).sort(), ["PATH", "SystemRoot"], "no passphrase, no secrets in the child's environment");
    if (!e.inline) {
      assert.equal(c.args[6], "bash");
      const script = c.args[7];
      assert.ok(script === `/mnt/c/repo/scripts/live/install.sh` || script.startsWith("/home/u/live-run-5/bin/"), script);
      assert.ok(!/\.\./.test(script));
    } else assert.deepEqual(c.args.slice(6, 8), ["bash", "-c"]);
  }
  const lock = A.buildActionCommand("send-lock", WSL);
  assert.deepEqual(lock.args.slice(6), ["bash", "/home/u/live-run-5/bin/lock.sh"], "no --dry-run on the real send");
  assert.deepEqual(A.buildActionCommand("dry-lock", WSL).args.slice(6), ["bash", "/home/u/live-run-5/bin/lock.sh", "--dry-run"]);
  assert.deepEqual(A.buildActionCommand("install", WSL).args.slice(6), ["bash", "/mnt/c/repo/scripts/live/install.sh", "5"]);
  assert.deepEqual(A.buildActionCommand("send-reveal-replace", WSL, { txHash: TX }).args.slice(6), ["bash", "/home/u/live-run-5/bin/reveal.sh", "--replace", TX]);
  assert.deepEqual(A.buildActionCommand("send-reveal-replace", WSL).args.slice(6), ["bash", "/home/u/live-run-5/bin/reveal.sh", "--replace"], "no hash known: the helper's own search, nothing invented");
  const native = A.buildActionCommand("tick-bob", { distro: null, runDir: "/srv/run-5", binDir: "/srv/run-5/bin", runNumber: 5 }, { env });
  assert.equal(native.file, "env");
  assert.deepEqual(native.args, ["RUN=5", "L=/srv/run-5", "bash", "/srv/run-5/bin/tick.sh", "bob"]);
});

test("buildActionCommand: nothing outside the table, nothing from the request except a checked hash", () => {
  for (const id of ["lock", "reveal", "claim --submit", "tick-alice --apply", "../tick-alice", "", "dry-lock; rm -rf /", undefined, null, 5, {}, "__proto__", "constructor", "toString", "send-lock ", "SEND-LOCK", "prepare\n"]) {
    assert.throws(() => A.buildActionCommand(id, WSL), /unknown action id/, String(id));
  }
  for (const h of ["0xAB" + "ab".repeat(31), "0x" + "ab".repeat(31), "0x" + "ab".repeat(33), TX + " --apply", TX.toUpperCase(), "ab".repeat(32), "$(id)", "0x" + "zz".repeat(32), 5]) {
    assert.throws(() => A.buildActionCommand("send-reveal-replace", WSL, { txHash: h }), /transaction hash/, String(h));
  }
  for (const n of [0, -1, 10000, 5.5, "5", "5; id", null, NaN]) assert.throws(() => A.buildActionCommand("tick-bob", { ...WSL, runNumber: n }), /run number/, String(n));
  for (const bad of [{ runDir: "~/live-run-5" }, { runDir: "/home/u/a b" }, { binDir: "/home/u/../etc" }, { binDir: "/x;id" }, { distro: "U; calc" }, { repoLiveDir: "/mnt/c/a b/scripts" }]) assert.throws(() => A.buildActionCommand("install", { ...WSL, ...bad }));
  // a hash given to an action whose table entry has no slot goes nowhere
  const c = A.buildActionCommand("send-lock", WSL, { txHash: TX });
  assert.ok(!c.args.includes(TX));
});

test("runNumberOf and the repository path", () => {
  assert.equal(A.runNumberOf("/home/u/live-run-5"), 5);
  assert.equal(A.runNumberOf("/home/u/live-run-5/"), 5);
  assert.equal(A.runNumberOf("/home/u/live-run-05"), null);
  assert.equal(A.runNumberOf("/home/u/live-run-"), null);
  assert.equal(A.runNumberOf("/home/u/other"), null);
  assert.equal(A.defaultRepoLiveDir("C:\\Users\\x\\repo").endsWith("/scripts/live"), true);
  assert.match(A.defaultRepoLiveDir("C:\\Users\\x\\repo"), /^\/mnt\/c\/Users\/x\/repo\/scripts\/live$/);
});

// ---------------------------------------------------------------------------------------------- the runner
function setup(o = {}) {
  const f = F.makeFolders();
  const clock = { ms: Date.now() };
  const log = [];
  const writes = [];
  let seq = 0;
  const stamp = (p) => {
    const t = new Date(clock.ms);
    fs.utimesSync(p, t, t);
  };
  const hold = { cb: null };
  const behaviour = { lock: {}, reveal: {}, refund: {}, claim: {}, fail: null, noFile: false, ...(o.behaviour || {}) };
  const exec = (file, args, opts, cb) => {
    const si = args.findIndex((a) => /\.sh$/.test(a));
    const script = si >= 0 ? path.basename(args[si]) : "inline";
    const flags = si >= 0 ? args.slice(si + 1) : [];
    log.push({ file, args, opts, script, flags });
    const w = (name, content) => {
      if (behaviour.noFile) return;
      const p = path.join(f.run, name);
      fs.writeFileSync(p, typeof content === "string" ? content : JSON.stringify(content));
      stamp(p);
      writes.push(name);
    };
    const n = String(100000 + ++seq);
    const dry = flags.includes("--dry-run");
    const replace = flags.includes("--replace");
    const hash = flags[flags.indexOf("--replace") + 1];
    const finish = () => {
      if (behaviour.fail && behaviour.fail === script) return cb(Object.assign(new Error("exit 2"), { code: 2 }), "", "refusing: something\n");
      let out = "";
      let errOut = "";
      if (script === "lock.sh" && behaviour.emptyResult) {
        // a helper that failed before printing: the shell redirect leaves an EMPTY result file, the reason is on stdout
        w(`eth-lock-${n}.json`, "");
        return cb(Object.assign(new Error("exit 1"), { code: 1 }), "lock --dry-run exit 1\nerror: the swap file has no pending intent\n", "");
      }
      if (script === "lock.sh") {
        if (dry) w(`eth-lock-${n}.json`, F.lockDry(behaviour.lock));
        else {
          w(`eth-lock-${n}.json`, { lockId: F.LOCK_ID, txHash: TX, blockNumber: 123 });
          w(`eth-lock-${n}.err`, `sent: ${TX} nonce 1\n`);
        }
      } else if (script === "reveal.sh") {
        if (dry) w(`eth-claim-dry-${n}.json`, F.revealDry({ ...behaviour.reveal, replace, replacesTx: replace ? hash : null }));
        else {
          w("eth-claim.json", { txHash: TX, blockNumber: 124 });
          w("eth-claim.err", `sent: ${TX} nonce 2\n`);
        }
      } else if (script === "refund-eth.sh") {
        if (dry) w(`eth-refund-${n}.json`, F.refundDry({ ...behaviour.refund, replace, replacesTx: replace ? hash : null }));
        else {
          w(`eth-refund-${n}.json`, { txHash: TX, blockNumber: 125 });
          w(`eth-refund-${n}.err`, `sent: ${TX} nonce 3\n`);
        }
      } else if (script === "fund.sh") {
        // the real helper's shapes (scripts/live/fund.sh): text on stdout; exit 3 for a refusal; the marker is written BEFORE the wallet CLI runs
        if (dry) {
          const objFile = path.join(f.pub, "swap.object.json");
          const asLinux = objFile.replace(/\\/g, "/").replace(/^([A-Za-z]):/, (m, l) => "/mnt/" + l.toLowerCase());
          let sha = "00".repeat(32);
          try {
            sha = require("crypto").createHash("sha256").update(fs.readFileSync(objFile)).digest("hex");
          } catch {
            /* no object file: the helper would have refused (exit 2), the test then has none to hash */
          }
          out = F.fundDry({ objPath: asLinux, sha, ...(behaviour.fund || {}) });
          if (behaviour.fund && behaviour.fund.refusal) return cb(Object.assign(new Error("exit 3"), { code: 3 }), out, "");
        } else {
          w("funded.marker", "2026-11-06T11:46:09Z\n");
          out = "funding 10.000000 NOID (once) at 11:46:09 UTC\n";
          if (behaviour.fundFails) return cb(Object.assign(new Error("exit 1"), { code: 1 }), out, "wallet error\n");
        }
      } else if (script === "claim.sh") {
        if (flags.includes("--submit")) w(`claim-${n}.out`, { mode: "submit", plan: { txid: "ef".repeat(32), call_height: 1 } });
        else w(`claim-${n}.out`, F.claimDry(behaviour.claim));
      } else if (script === "check-object.sh") {
        // the real helper: the object's JSON on stdout, the verdict on STDERR (swap-cli alice-params --check-object)
        out = '{"claim_authority": "o1x"}\n';
        errOut = behaviour.objectMismatch ? "error: MISMATCH: the wallet built a different opening\n" : "object file OK: its opening is byte-for-byte the swap file's; fund exactly this address: o1x\n";
        if (behaviour.objectMismatch) return cb(Object.assign(new Error("exit 1"), { code: 1 }), out, errOut);
        if (behaviour.objectNoVerdict) errOut = "";
      }
      else if (args.some((a) => /alive/.test(a))) out = o.watchAlive ? "alive 4242\n" : "dead\n";
      cb(null, out, errOut);
    };
    if (opts && o.deferred) hold.cb = finish;
    else finish();
  };
  const spawned = [];
  const audit = o.audit || new AuditLog(f.pub, { now: () => clock.ms, role: o.role });
  if (o.objectFile !== false) fs.writeFileSync(path.join(f.pub, "swap.object.json"), JSON.stringify({ address: "o1rootplaceholder", claim_authority: "o1AUTH" }));
  const runner = new A.ActionRunner({ ...WSL, ...(o.role ? { role: o.role } : {}), runDirs: [f.run, f.pub] }, { audit, exec, spawnDetached: (file, args, opts) => (spawned.push({ file, args, opts }), { unref() {}, on() {} }), now: () => clock.ms, pollWatch: !!o.pollWatch });
  return { f, clock, log, writes, hold, runner, audit, spawned, behaviour, cleanup: f.cleanup };
}
const adv = (s, ms) => (s.clock.ms += ms);
const codes = (e) => (e.reasons || []).map((r) => r.code);
async function refused(fn) {
  try {
    await fn();
  } catch (e) {
    return e;
  }
  assert.fail("expected a refusal");
}

test("lock: no dry run, no send; the dry run is stored and compared; then a typed send runs the plain helper once", () => {
  const s = setup();
  try {
    s.f.writeTick("bob", F.spendTick("lock_eth"));
    // no dry run yet
    let e;
    try {
      s.runner.startSpend("send-lock", "0.001 ETH");
    } catch (x) {
      e = x;
    }
    assert.equal(e.status, 422);
    assert.ok(codes(e).includes("dry_missing"));
    assert.equal(s.log.length, 0, "nothing ran");
    assert.equal(s.audit.tail(5)[0].phase, "refused");

    // the dry run
    adv(s, 3000);
    const job = s.runner.startAction("dry-lock");
    assert.equal(job.state, "done", "the fake helper answers at once");
    assert.equal(job.ok, true);
    assert.deepEqual(s.log[0].flags, ["--dry-run"]);
    assert.ok(job.dry_hash && job.dry_hash.length === 64);
    const v = s.runner.view(require("../lib/runfolder").readRun([s.f.run, s.f.pub], Math.floor(s.clock.ms / 1000)));
    const sp = v.spends["send-lock"];
    assert.equal(sp.relevant, true);
    assert.equal(sp.eligible, true, JSON.stringify(sp.reasons));
    assert.equal(sp.dry.all_ok, true);
    assert.equal(sp.dry.hash, job.dry_hash);
    assert.ok(sp.dry.rows.every((r) => r.ok !== false));
    assert.equal(sp.expected_typed, "0.001 ETH");
    assert.match(sp.plain.title, /Lock 0\.001 ETH/);
    assert.equal(v.spends["send-reveal"].relevant, false);

    // wrong typed text
    adv(s, 3000);
    const e2 = refusedSync(() => s.runner.startSpend("send-lock", "0.01 ETH"));
    assert.equal(e2.status, 422);
    assert.deepEqual(codes(e2), ["typed"]);
    assert.equal(s.log.length, 1, "still only the dry run");

    // the real send
    adv(s, 3000);
    const sent = s.runner.startSpend("send-lock", "0.001 ETH");
    assert.equal(sent.state, "done");
    assert.equal(sent.ok, true);
    assert.deepEqual(s.log[1].flags, [], "lock.sh without --dry-run");
    assert.equal(sent.tx, TX);
    assert.equal(sent.dry_hash, job.dry_hash);
    assert.ok(sent.next && /Do not send it a second time/.test(sent.next));
    assert.equal(sent.files[0].name.startsWith("eth-lock-"), true);
    const lines = s.audit.tail(10);
    const startLine = lines.find((l) => l.action === "send-lock" && l.phase === "start");
    const endLine = lines.find((l) => l.action === "send-lock" && l.phase === "end");
    assert.equal(startLine.dry_hash, job.dry_hash);
    assert.equal(endLine.dry_hash, job.dry_hash);
    assert.equal(endLine.tx, TX);
    assert.match(endLine.t, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);
    assert.equal(startLine.role, "bob");
    assert.equal(s.audit.verify().ok, true);

    // a second click before the next tick: the engine still says lock_eth (stale), but the latch holds
    adv(s, 3000);
    s.f.writeTick("bob", F.spendTick("lock_eth"), 3); // a tick written after... but the latch is in seconds of the send
    const e3 = refusedSync(() => s.runner.startSpend("send-lock", "0.001 ETH"));
    assert.ok(codes(e3).includes("latched") || codes(e3).includes("dry_stale") || codes(e3).includes("dry_missing"), codes(e3).join());
  } finally {
    s.cleanup();
  }
});

function refusedSync(fn) {
  try {
    fn();
  } catch (e) {
    return e;
  }
  assert.fail("expected a refusal");
}

test("a second click right after a send is refused (latch + sent evidence + a used dry run); a restart remembers it; the claim latch lifts with a newer tick", () => {
  const s = setup();
  try {
    s.f.writeTick("bob", F.spendTick("lock_eth"), 0);
    adv(s, 1500);
    s.runner.startAction("dry-lock");
    adv(s, 2500);
    s.runner.startSpend("send-lock", "0.001 ETH");
    assert.equal(s.runner.dry.has("send-lock"), false, "the dry run authorized one start and is gone");
    // the same tick on disk, a new dry run, the send again
    adv(s, 2500);
    s.runner.startAction("dry-lock");
    adv(s, 2500);
    const e = refusedSync(() => s.runner.startSpend("send-lock", "0.001 ETH"));
    assert.ok(codes(e).includes("latched"), codes(e).join());
    assert.ok(codes(e).includes("already_sent"), "the helper's sent: line is evidence");
    assert.equal(s.log.filter((c) => c.script === "lock.sh" && !c.flags.includes("--dry-run")).length, 1, "exactly one real send");
    // even a newer tick that still shows the intent (held) cannot start it again for the same intent
    adv(s, 3000);
    s.f.writeTickAt("bob", F.spendTick("lock_eth", { held: true }), s.clock.ms);
    s.runner.startAction("dry-lock");
    adv(s, 3000);
    assert.ok(codes(refusedSync(() => s.runner.startSpend("send-lock", "0.001 ETH"))).includes("latched"));
    // a restart: a new runner over the same audit file knows the tick and the intent
    const again = new A.ActionRunner({ ...WSL, runDirs: [s.f.run, s.f.pub] }, { audit: new AuditLog(s.f.pub, { now: () => s.clock.ms }), exec: () => assert.fail("must not run"), now: () => s.clock.ms, pollWatch: false });
    const l = again.latch.get("send-lock");
    assert.equal(l.intentAt, F.INTENT_AT);
    assert.ok(l.tickNow > 0);
  } finally {
    s.cleanup();
  }
  // the NOID claim has no intent: the same tick is latched, a newer tick lifts it
  const c = setup();
  try {
    c.f.writeTick("bob", F.spendTick("claim_noid"), 0);
    adv(c, 1500);
    c.runner.startAction("dry-claim");
    adv(c, 2500);
    assert.equal(c.runner.startSpend("send-claim", "10 NOID").ok, true);
    adv(c, 2500);
    c.runner.startAction("dry-claim");
    adv(c, 2500);
    assert.ok(codes(refusedSync(() => c.runner.startSpend("send-claim", "10 NOID"))).includes("latched"));
    adv(c, 3000);
    c.f.writeTickAt("bob", F.spendTick("claim_noid"), c.clock.ms);
    c.runner.startAction("dry-claim");
    adv(c, 3000);
    assert.equal(c.runner.startSpend("send-claim", "10 NOID").ok, true, "a newer tick lifts the claim latch");
  } finally {
    c.cleanup();
  }
});

test("a dry run with a wrong field, a failed dry run, or an old one cannot be used", () => {
  const s = setup({ behaviour: { lock: { receiver: "0x" + "99".repeat(20) } } });
  try {
    s.f.writeTick("bob", F.spendTick("lock_eth"));
    adv(s, 1500);
    s.runner.startAction("dry-lock");
    adv(s, 2500);
    let e = refusedSync(() => s.runner.startSpend("send-lock", "0.001 ETH"));
    assert.ok(codes(e).includes("dry_mismatch"));
    // a failing helper
    s.behaviour.lock = {};
    s.behaviour.fail = "lock.sh";
    adv(s, 2500);
    const j = s.runner.startAction("dry-lock");
    assert.equal(j.ok, false);
    assert.equal(j.exit_code, 2);
    adv(s, 2500);
    e = refusedSync(() => s.runner.startSpend("send-lock", "0.001 ETH"));
    assert.ok(codes(e).includes("dry_failed"));
    // a good one, then it grows old
    s.behaviour.fail = null;
    adv(s, 2500);
    s.runner.startAction("dry-lock");
    const dryAt = s.clock.ms;
    adv(s, 91000);
    s.f.writeTickAt("bob", F.spendTick("lock_eth"), s.clock.ms - 2000);
    e = refusedSync(() => s.runner.startSpend("send-lock", "0.001 ETH"));
    assert.ok(codes(e).includes("dry_stale"), codes(e).join());
    assert.ok(s.clock.ms - dryAt > 90000);
    assert.equal(s.log.filter((c) => c.script === "lock.sh" && !c.flags.includes("--dry-run")).length, 0, "the real helper never ran");
  } finally {
    s.cleanup();
  }
});

test("one action at a time: a second request while one runs is refused, whatever it is", () => {
  const s = setup({ deferred: true });
  try {
    s.f.writeTick("bob", F.spendTick("lock_eth"));
    adv(s, 1500);
    const first = s.runner.startAction("dry-lock");
    assert.equal(first.state, "running");
    for (const id of ["tick-alice", "dry-claim", "watch-stop", "install"]) {
      const e = refusedSync(() => s.runner.startAction(id));
      assert.equal(e.status, 409, id);
      assert.match(e.message, /one action at a time/);
    }
    const e = refusedSync(() => s.runner.startSpend("send-lock", "0.001 ETH"));
    assert.equal(e.status, 409);
    assert.equal(s.log.length, 1);
    s.hold.cb();
    assert.equal(s.runner.view(null).busy, null);
    assert.equal(s.runner.view(null).jobs.slice(-1)[0].state, "done");
  } finally {
    s.cleanup();
  }
});

test("fail closed: when the audit log cannot be written, nothing runs", () => {
  const s = setup();
  try {
    s.f.writeTick("bob", F.spendTick("lock_eth"));
    adv(s, 1500);
    s.runner.startAction("dry-lock");
    adv(s, 2500);
    s.audit.append = () => {
      throw Object.assign(new Error("disk full"), { code: "ENOSPC" });
    };
    const before = s.log.length;
    const e = refusedSync(() => s.runner.startSpend("send-lock", "0.001 ETH"));
    assert.equal(e.status, 500);
    assert.match(e.message, /audit log cannot be written/);
    assert.equal(s.log.length, before);
    assert.equal(s.runner.view(null).busy, null);
  } finally {
    s.cleanup();
  }
});

test("a timed-out spend says so and tells the operator not to repeat it", () => {
  const s = setup();
  try {
    s.f.writeTick("bob", F.spendTick("lock_eth"));
    adv(s, 1500);
    s.runner.startAction("dry-lock");
    adv(s, 2500);
    s.behaviour.noFile = true;
    const real = s.runner.exec;
    s.runner.exec = (file, args, opts, cb) => cb(Object.assign(new Error("killed"), { killed: true, code: null }), "", "");
    const j = s.runner.startSpend("send-lock", "0.001 ETH");
    assert.equal(j.timed_out, true);
    assert.match(j.error, /do not assume the transaction was not sent/);
    assert.match(s.audit.tail(3).slice(-1)[0].result, /timeout/);
    s.runner.exec = real;
  } finally {
    s.cleanup();
  }
});

test("reveal, claim, refund: each uses its own dry run and sends the plain helper (--submit for the NOID claim)", () => {
  const cases = [
    ["alice", "reveal_eth", "dry-reveal", "send-reveal", "reveal.sh", [], "0.001 ETH"],
    ["bob", "claim_noid", "dry-claim", "send-claim", "claim.sh", ["--submit"], "10 NOID"],
    ["bob", "refund_eth", "dry-refund-eth", "send-refund-eth", "refund-eth.sh", [], "0.001 ETH"],
  ];
  for (const [role, kind, dryId, sendId, script, sendFlags, typed] of cases) {
    const s = setup();
    try {
      s.f.writeTick(role, F.spendTick(kind));
      adv(s, 1500);
      s.runner.startAction(dryId);
      adv(s, 2500);
      const wrong = refusedSync(() => s.runner.startSpend(sendId, "1 ETH"));
      assert.deepEqual(codes(wrong), ["typed"], sendId);
      adv(s, 2500);
      const j = s.runner.startSpend(sendId, typed);
      assert.equal(j.ok, true, sendId);
      const real = s.log.filter((c) => c.script === script).slice(-1)[0];
      assert.deepEqual(real.flags, sendFlags, sendId);
      assert.ok(j.tx, sendId + " has a transaction hash");
      assert.equal(s.runner.dry.has(sendId), false, "a dry run authorizes one start");
    } finally {
      s.cleanup();
    }
  }
});

test("--replace: the hash comes from the engine's tick (reveal) or the helper's stderr (refund), never from the page", () => {
  // reveal
  let s = setup();
  try {
    const pending = { lock_id: F.LOCK_ID, tx_hash: TX };
    s.f.writeTick("alice", F.spendTick("reveal_eth", { held: true, eth: { pending_preimage: pending } }));
    adv(s, 1500);
    const j = s.runner.startAction("dry-reveal-replace");
    assert.equal(j.ok, true);
    assert.deepEqual(s.log[0].flags, ["--dry-run", "--replace", TX]);
    adv(s, 2500);
    const sent = s.runner.startSpend("send-reveal-replace", "0.001 ETH");
    assert.deepEqual(s.log[1].flags, ["--replace", TX]);
    assert.equal(sent.ok, true);
    // a plain dry run does not unlock the replace send, and vice versa
    assert.equal(s.runner.dry.has("send-reveal"), false);
  } finally {
    s.cleanup();
  }
  // no pending claim in the tick: no hash, no dry run, no send
  s = setup();
  try {
    s.f.writeTick("alice", F.spendTick("reveal_eth", { held: true }));
    const e = refusedSync(() => s.runner.startAction("dry-reveal-replace"));
    assert.equal(e.status, 409);
    const e2 = refusedSync(() => s.runner.startSpend("send-reveal-replace", "0.001 ETH"));
    assert.equal(e2.status, 422);
    assert.equal(s.log.length, 0);
  } finally {
    s.cleanup();
  }
  // refund: the hash is read from the newest eth-refund-*.err
  s = setup();
  try {
    s.f.writeTick("bob", F.spendTick("refund_eth", { held: true }));
    s.f.write("eth-refund-090000.err", `warning\nsent: ${TX} nonce 3 maxFeePerGas 1 gwei\n`);
    adv(s, 1500);
    assert.equal(s.runner.startAction("dry-refund-eth-replace").ok, true);
    assert.deepEqual(s.log[0].flags, ["--dry-run", "--replace", TX]);
    // something that is not a hash in the file is ignored
    s.f.write("eth-refund-090001.err", "sent: 0xnothex\n");
    assert.equal(s.runner.replaceTxFor(SPENDS["send-refund-eth-replace"], null), TX);
  } finally {
    s.cleanup();
  }
});

test("replaceTxFor reveal_eth falls back to the eth-claim.err hash", () => {
  const s = setup();
  try {
    s.f.writeTick("alice", F.spendTick("reveal_eth", { held: true }));
    // nothing sent yet: no hash
    assert.equal(s.runner.replaceTxFor(SPENDS["send-reveal-replace"], null), null);
    // program mode never fills pending_preimage: the local `sent:` line of the last re-send is the hash
    s.f.write("eth-claim.err", `warning
sent: ${TX} nonce 0 maxFeePerGas 25 gwei
`);
    assert.equal(s.runner.replaceTxFor(SPENDS["send-reveal-replace"], null), TX);
  } finally {
    s.cleanup();
  }
});

test("replaceTxFor reveal_eth keeps the earlier re-send's hash after a refused run truncated eth-claim.err (reveal fee record)", () => {
  const s = setup();
  try {
    s.f.writeTick("alice", F.spendTick("reveal_eth", { held: true }));
    const R1 = "0x" + "a1".repeat(32);
    const R2 = "0x" + "b2".repeat(32);
    s.f.write("alice.swap.json.reveal-fees", `${JSON.stringify({ version: 1, lock_id: "cd".repeat(32), tx_hash: R1.slice(2), nonce: 0, max_fee_per_gas: "25000000000", max_priority_fee_per_gas: "1125000000", at: 1 })}
${JSON.stringify({ version: 1, lock_id: "cd".repeat(32), tx_hash: R2.slice(2), nonce: 0, max_fee_per_gas: "30000000000", max_priority_fee_per_gas: "1265625000", at: 2 })}
{"torn":
`);
    // the refused real run left an eth-claim.err with no `sent:` line
    s.f.write("eth-claim.err", "refusing: the fee cap is under 2 x the base fee");
    assert.equal(s.runner.replaceTxFor(SPENDS["send-reveal-replace"], null), R2);
  } finally {
    s.cleanup();
  }
});

test("a reveal that was mined and reverted says the secret is public, in the job and in the audit log", () => {
  const s = setup();
  try {
    s.f.writeTick("alice", F.spendTick("reveal_eth"));
    adv(s, 1500);
    s.runner.startAction("dry-reveal");
    adv(s, 2500);
    const real = s.runner.exec;
    s.runner.exec = (file, args, opts, cb) => {
      s.f.write("eth-claim.json", { sent: true, txHash: TX, reverted: true, secretPublic: true });
      cb(Object.assign(new Error("exit 3"), { code: 3 }), "", "");
    };
    const j = s.runner.startSpend("send-reveal", "0.001 ETH");
    s.runner.exec = real;
    assert.equal(j.ok, false);
    assert.match(j.warning, /SECRET IS PUBLIC/);
    assert.equal(j.tx, TX);
    assert.match(s.audit.tail(1)[0].result, /SECRET PUBLIC/);
  } finally {
    s.cleanup();
  }
});

test("install is refused mid-swap (swap files, a tick, a running loop): it rewrites the helpers the loop calls", () => {
  let s = setup();
  try {
    adv(s, 1500);
    assert.equal(s.runner.startAction("install").ok, true, "a fresh run folder");
    s.f.writeTick("bob", F.spendTick("lock_eth"));
    adv(s, 2500);
    const e = refusedSync(() => s.runner.startAction("install"));
    assert.equal(e.status, 409);
    assert.match(e.message, /swap files/);
  } finally {
    s.cleanup();
  }
  s = setup();
  try {
    fs.mkdirSync(path.join(s.f.run, "bob"));
    fs.writeFileSync(path.join(s.f.run, "bob", "bob.swap.json"), "{}");
    assert.match(refusedSync(() => s.runner.startAction("install")).message, /swap files/);
  } finally {
    s.cleanup();
  }
});

test("setup actions: check-object gates the funding acknowledgement; the acknowledgement is only logged", () => {
  const s = setup();
  try {
    const e = refusedSync(() => s.runner.acknowledgeFunding());
    assert.equal(e.status, 409);
    adv(s, 1500);
    const j = s.runner.startAction("check-object");
    assert.equal(j.ok, true);
    assert.equal(s.runner.view(null).funding.object_check_ok, true);
    const n = s.log.length;
    const ack = s.runner.acknowledgeFunding();
    assert.equal(ack.ok, true);
    assert.equal(s.log.length, n, "nothing is executed for the acknowledgement");
    assert.equal(s.audit.tail(1)[0].action, "funded-ack");
    // check-object failing keeps it closed
    const s2 = setup({ behaviour: { fail: "check-object.sh" } });
    s2.runner.startAction("check-object");
    assert.equal(s2.runner.view(null).funding.object_check_ok, false);
    s2.cleanup();
    // the real helper's shapes: a mismatch exits 1; an exit 0 without the "object file OK" line (stdout JSON only) is not a verdict
    for (const behaviour of [{ objectMismatch: true }, { objectNoVerdict: true }]) {
      const s3 = setup({ behaviour });
      s3.runner.startAction("check-object");
      assert.equal(s3.runner.view(null).funding.object_check_ok, false, JSON.stringify(behaviour));
      assert.equal(refusedSync(() => s3.runner.acknowledgeFunding()).status, 409);
      s3.cleanup();
    }
  } finally {
    s.cleanup();
  }
});

test("a dry run that failed and left an empty result file is logged without a hash (the sha256 of nothing is not a dry run's hash)", () => {
  const s = setup({ behaviour: { emptyResult: true } });
  try {
    adv(s, 1500);
    const j = s.runner.startAction("dry-lock");
    assert.equal(j.state, "done");
    const rec = s.runner.view(null).jobs.slice(-1)[0];
    assert.equal(rec.ok, false);
    assert.equal(rec.dry_hash, null);
    const end = s.audit.tail(2).find((r) => r.phase === "end");
    assert.equal(end.dry_hash, null);
    assert.equal(end.result, "failed (exit 1)");
  } finally {
    s.cleanup();
  }
});

test("spending ids cannot be started as plain actions, and unknown ids are refused before anything is logged or run", () => {
  const s = setup();
  try {
    for (const id of ["send-fund", "send-lock", "send-reveal", "send-claim", "send-refund-eth", "send-reveal-replace", "send-refund-eth-replace"]) {
      const e = refusedSync(() => s.runner.startAction(id));
      assert.equal(e.status, 400, id);
    }
    for (const id of ["lock", "tick-alice --apply", "__proto__", "dry-lock; id", undefined]) {
      assert.equal(refusedSync(() => s.runner.startAction(id)).status, 400, String(id));
      assert.equal(refusedSync(() => s.runner.startSpend(id, "0.001 ETH")).status, 400, String(id));
    }
    assert.equal(s.log.length, 0);
    assert.equal(s.audit.tail(5).length, 0);
  } finally {
    s.cleanup();
  }
});

test("the watch loop: started detached with the fixed script, one at a time, stopped only by the fixed script", () => {
  const s = setup();
  try {
    adv(s, 1500);
    const j = s.runner.startAction("watch-start");
    assert.equal(j.ok, true);
    assert.equal(s.spawned.length, 1);
    const sp = s.spawned[0];
    assert.equal(sp.file, "wsl.exe");
    assert.equal(sp.opts.detached, true);
    assert.equal(sp.opts.stdio, "ignore");
    assert.equal(sp.args[sp.args.length - 1], A.WATCH_START);
    assert.deepEqual(sp.args.slice(0, 7), ["-d", "Ubuntu-24.04", "-e", "env", "RUN=5", "L=/home/u/live-run-5", "bash"]);
    assert.equal(s.log.length, 0, "not through exec");
    // already alive: refused
    adv(s, 2500);
    const e = refusedSync(() => s.runner.startAction("watch-start"));
    assert.equal(e.status, 409);
    assert.equal(s.spawned.length, 1);
    // stop = the fixed stop script through exec
    adv(s, 2500);
    s.runner.startAction("watch-stop");
    assert.equal(s.log[s.log.length - 1].args[s.log[s.log.length - 1].args.length - 1], A.WATCH_STOP);
    const v = s.runner.view({ roles: { alice: { loop_mtime: Math.floor(s.clock.ms / 1000) - 400 } } });
    assert.equal(v.watch.started_here, false);
    assert.equal(v.watch.some_loop_running, false);
    // a loop updating the file (started in a terminal) blocks a second start too
    adv(s, 2500);
    const loopFile = path.join(s.f.run, "loop-alice.txt");
    fs.writeFileSync(loopFile, "18:25:14 [alice] tick exit 0 at 18:25:14 ACTION: {\"action\": \"wait\", \"reason\": \"x\"} applied: True phase_after: funding_final\n");
    fs.utimesSync(loopFile, new Date(s.clock.ms), new Date(s.clock.ms));
    const e2 = refusedSync(() => s.runner.startAction("watch-start"));
    assert.equal(e2.status, 409);
    assert.match(e2.message, /already/);
  } finally {
    s.cleanup();
  }
});

test("the watch status is asked with the fixed status script and shown as 'started here'", async () => {
  const s = setup({ pollWatch: true, watchAlive: true });
  try {
    s.runner.view(null);
    await new Promise((r) => setTimeout(r, 20));
    const status = s.log.find((c) => c.args[c.args.length - 1] === A.WATCH_STATUS);
    assert.ok(status, "the status script ran");
    const v = s.runner.view(null);
    assert.equal(v.watch.started_here, true);
    assert.equal(v.watch.pid, 4242);
  } finally {
    s.cleanup();
  }
});

test("the view carries the table with the exact commands and no secret-looking field", () => {
  const s = setup();
  try {
    const v = s.runner.view(null);
    assert.equal(v.table.length, A.TABLE.length);
    assert.ok(v.table.every((e) => typeof e.command === "string" && e.command.startsWith("wsl.exe -d Ubuntu-24.04 -e env RUN=5 L=/home/u/live-run-5 ")));
    assert.ok(v.table.find((e) => e.id === "dry-reveal-replace").command.includes("<pending tx hash>"));
    assert.ok(!JSON.stringify(v).includes("SWAP_PASSPHRASE"));
    assert.equal(v.audit.chain.ok, true);
  } finally {
    s.cleanup();
  }
});

// ---------------------------------------------------------------------------------------------- funding through fund.sh
const { readRun } = require("../lib/runfolder");
const STMT = { noPendingFunding: true, bobCheckMatches: true }; // the two statements of the funding confirmation
const viewOf = (s) => s.runner.view(readRun([s.f.run, s.f.pub], Math.floor(s.clock.ms / 1000)));

test("funding: dry-fund parses fund.sh's text; send-fund is gated on tick, dry run, object file, marker, typed NOID; the marker latches it for good", { skip: F.WSL_HOST_ONLY }, () => {
  const s = setup({ role: "alice" });
  try {
    s.f.writeTick("alice", F.spendTick("fund_noid"), 0);
    adv(s, 1500);
    // before any dry run: offered, but not eligible
    let sp = viewOf(s).spends["send-fund"];
    assert.equal(sp.relevant, true);
    assert.equal(sp.eligible, false);
    assert.ok(sp.reasons.some((r) => r.code === "dry_missing"));
    assert.equal(sp.expected_typed, "10 NOID");
    const e0 = refusedSync(() => s.runner.startSpend("send-fund", "10 NOID", STMT));
    assert.deepEqual(codes(e0), ["dry_missing"]);
    assert.equal(s.log.length, 0);

    // the dry run: the helper's text is the record; the result is hashed; the object file's sha is bound
    adv(s, 3000);
    const job = s.runner.startAction("dry-fund");
    assert.equal(job.state, "done");
    assert.equal(job.ok, true);
    assert.deepEqual(s.log[0].flags, ["--dry-run"]);
    assert.equal(s.log[0].script, "fund.sh");
    assert.ok(job.dry_hash && job.dry_hash.length === 64);
    sp = viewOf(s).spends["send-fund"];
    assert.equal(sp.dry.all_ok, true, JSON.stringify(sp.dry.rows.filter((r) => r.ok === false)));
    assert.equal(sp.eligible, true, JSON.stringify(sp.reasons));
    assert.match(sp.plain.title, /^Fund 10 NOID$/);

    // an object file that changed since the dry run: the dry run no longer counts
    fs.writeFileSync(path.join(s.f.pub, "swap.object.json"), JSON.stringify({ address: "o1OTHER" }));
    sp = viewOf(s).spends["send-fund"];
    assert.equal(sp.eligible, false);
    assert.ok(sp.reasons.some((r) => r.code === "dry_mismatch"));
    fs.writeFileSync(path.join(s.f.pub, "swap.object.json"), JSON.stringify({ address: "o1rootplaceholder", claim_authority: "o1AUTH" }));
    assert.equal(viewOf(s).spends["send-fund"].eligible, true, "back to the same bytes");

    // wrong typed text
    const e1 = refusedSync(() => s.runner.startSpend("send-fund", "10 ETH", STMT));
    assert.deepEqual(codes(e1), ["typed"]);
    assert.equal(s.log.length, 1, "still only the dry run");

    // a marker that appeared meanwhile (another click, a terminal) refuses it
    fs.writeFileSync(path.join(s.f.run, "funded.marker"), "2026-11-06T11:00:00Z\n");
    const e2 = refusedSync(() => s.runner.startSpend("send-fund", "10 NOID", STMT));
    assert.ok(codes(e2).includes("already_sent"));
    assert.equal(viewOf(s).spends["send-fund"].relevant, false, "not offered any more");
    fs.rmSync(path.join(s.f.run, "funded.marker"));

    // the real send
    adv(s, 3000);
    const sent = s.runner.startSpend("send-fund", "10 NOID", STMT);
    assert.equal(sent.state, "done");
    assert.equal(sent.ok, true);
    assert.deepEqual(s.log[1].flags, [], "fund.sh without --dry-run");
    assert.equal(sent.funded_marker, "2026-11-06T11:46:09Z");
    assert.equal(sent.tx, null);
    assert.match(sent.next, /Never fund a second time/);
    const end = s.audit.tail(10).find((l) => l.action === "send-fund" && l.phase === "end");
    assert.equal(end.role, "alice");
    assert.equal(end.srv_role, "alice");
    assert.equal(end.dry_hash, job.dry_hash);
    assert.match(end.detail, /^funded\.marker 2026-11-06T11:46:09Z$/);
    assert.equal(s.audit.verify().ok, true);

    // latched for good: not offered, the view says funded, a second attempt is refused whatever the tick says
    adv(s, 3000);
    s.f.writeTick("alice", F.spendTick("fund_noid", { held: true }), 0);
    const v = viewOf(s);
    assert.equal(v.spends["send-fund"].relevant, false);
    assert.equal(v.funding.marker_at, "2026-11-06T11:46:09Z");
    const e3 = refusedSync(() => s.runner.startSpend("send-fund", "10 NOID", STMT));
    assert.ok(codes(e3).includes("already_sent") || codes(e3).includes("dry_missing"));
    assert.equal(s.log.length, 2, "nothing more ran");
  } finally {
    s.cleanup();
  }
});

test("funding: every refusal fund.sh prints makes the dry run red and is shown as printed; the send stays closed", () => {
  for (const refusal of ["instance", "marker", "mismatch"]) {
    const s = setup({ behaviour: { fund: { refusal } } });
    try {
      s.f.writeTick("alice", F.spendTick("fund_noid"), 0);
      adv(s, 1500);
      const job = s.runner.startAction("dry-fund");
      assert.equal(job.ok, false, refusal);
      assert.equal(job.exit_code, 3);
      const sp = viewOf(s).spends["send-fund"];
      assert.equal(sp.dry.ok, false);
      assert.equal(sp.dry.result, "exit 3");
      assert.match(sp.dry.stderr, /REFUSED|not funding/, "the helper own text is shown");
      assert.equal(sp.eligible, false);
      assert.ok(sp.reasons.some((r) => r.code === "dry_failed"));
      const e = refusedSync(() => s.runner.startSpend("send-fund", "10 NOID", STMT));
      assert.ok(codes(e).includes("dry_failed"), refusal);
      assert.equal(s.log.length, 1);
    } finally {
      s.cleanup();
    }
  }
});

test("funding: without an object file the console can see no dry run passes; a failed fund.sh keeps the marker and says do not repeat", { skip: F.WSL_HOST_ONLY }, () => {
  const s = setup({ objectFile: false });
  try {
    s.f.writeTick("alice", F.spendTick("fund_noid"), 0);
    adv(s, 1500);
    s.runner.startAction("dry-fund");
    const sp = viewOf(s).spends["send-fund"];
    assert.equal(sp.dry.all_ok, false);
    assert.ok(sp.dry.rows.some((r) => /the console.s terms came from/.test(r.label) && r.ok === false && /give the public copy folder/.test(r.expected)));
  } finally {
    s.cleanup();
  }
  const f = setup({ behaviour: { fundFails: true } });
  try {
    f.f.writeTick("alice", F.spendTick("fund_noid"), 0);
    adv(f, 1500);
    f.runner.startAction("dry-fund");
    adv(f, 3000);
    const sent = f.runner.startSpend("send-fund", "10 NOID", STMT);
    assert.equal(sent.ok, false);
    assert.equal(sent.exit_code, 1);
    assert.equal(sent.funded_marker, "2026-11-06T11:46:09Z");
    assert.match(sent.error, /funded\.marker is still there on purpose/);
    assert.match(sent.error, /Do not run it again/);
    assert.equal(viewOf(f).funding.marker_at, "2026-11-06T11:46:09Z");
  } finally {
    f.cleanup();
  }
});

// ---------------------------------------------------------------------------------------------- the role of this console
test("--role alice: the other role's ticks, dry runs and spends are refused with 403 and never reach a helper; the watch loop ticks only Alice", () => {
  const s = setup({ role: "alice" });
  try {
    s.f.writeTick("bob", F.spendTick("lock_eth"), 0);
    s.f.writeTick("alice", F.spendTick("fund_noid"), 0);
    adv(s, 1500);
    for (const id of ["tick-bob", "join", "dry-lock", "dry-claim", "dry-refund-eth", "dry-refund-eth-replace"]) {
      const e = refusedSync(() => s.runner.startAction(id));
      assert.equal(e.status, 403, id);
      assert.match(e.message, /started with --role alice: .* belongs to bob, which runs on another machine/, id);
    }
    for (const id of ["send-lock", "send-claim", "send-refund-eth", "send-refund-eth-replace"]) {
      const e = refusedSync(() => s.runner.startSpend(id, "0.001 ETH"));
      assert.equal(e.status, 403, id);
    }
    assert.equal(s.log.length, 0, "nothing reached a helper");
    // Alice's own ids work
    s.runner.startAction("tick-alice");
    s.runner.startAction("check-object");
    adv(s, 3000);
    s.runner.startAction("dry-reveal");
    assert.deepEqual(s.log.map((l) => l.script), ["tick.sh", "check-object.sh", "reveal.sh"]);
    // the view: the other role's spends are not offered, the table marks the blocked ids
    const v = viewOf(s);
    assert.equal(v.role, "alice");
    assert.equal(v.spends["send-lock"].relevant, false);
    assert.equal(v.spends["send-lock"].other_machine, true);
    assert.deepEqual(v.table.filter((e) => e.blocked).map((e) => e.id).sort(), ["dry-claim", "dry-lock", "dry-refund-eth", "dry-refund-eth-replace", "join", "send-claim", "send-lock", "send-refund-eth", "send-refund-eth-replace", "tick-bob"].sort());
    assert.ok(v.table.filter((e) => !e.blocked).every((e) => !e.role || e.role === "alice"));
    // the watch loop: a fixed script that ticks only Alice
    adv(s, 3000);
    s.runner.startAction("watch-start");
    const last = s.spawned[s.spawned.length - 1];
    assert.equal(last.args[last.args.length - 1], 'echo $$ > "$L/ui-watch.pid"; exec bash "$L/bin/watch.sh" alice 30');
    // the audit log carries the role the console was started with
    assert.ok(s.audit.tail(10).every((r) => r.srv_role === "alice"));
  } finally {
    s.cleanup();
  }
});

test("--role bob and --role both: the mirror image, and the default keeps the one-machine behaviour", () => {
  const b = setup({ role: "bob" });
  try {
    adv(b, 1500);
    for (const id of ["tick-alice", "dry-reveal", "dry-fund"]) assert.equal(refusedSync(() => b.runner.startAction(id)).status, 403, id);
    for (const id of ["send-reveal", "send-reveal-replace", "send-fund"]) assert.equal(refusedSync(() => b.runner.startSpend(id, "1 ETH")).status, 403, id);
    b.runner.startAction("tick-bob");
    adv(b, 3000);
    b.runner.startAction("watch-start");
    const last = b.spawned[b.spawned.length - 1];
    assert.ok(last.args[last.args.length - 1].endsWith('/watch.sh" bob 30'));
    assert.equal(viewOf(b).spends["send-fund"].other_machine, true);
  } finally {
    b.cleanup();
  }
  for (const role of [undefined, "both"]) {
    const s = setup(role ? { role } : {});
    try {
      adv(s, 1500);
      s.runner.startAction("tick-alice");
      adv(s, 3000);
      s.runner.startAction("tick-bob");
      adv(s, 3000);
      s.runner.startAction("watch-start");
      const last = s.spawned[s.spawned.length - 1];
      assert.ok(last.args[last.args.length - 1].endsWith('/watch.sh" both 30'));
      assert.equal(viewOf(s).role, "both");
      assert.ok(viewOf(s).table.every((e) => !e.blocked));
    } finally {
      s.cleanup();
    }
  }
  assert.throws(() => new A.ActionRunner({ ...WSL, role: "carol", runDirs: [] }, { audit: {} }), /--role: alice, bob or both/);
});

test("watch status only counts the loop file of the role this console drives", () => {
  const s = setup({ role: "alice", pollWatch: false });
  try {
    // Bob's loop file is fresh (another machine's copy, or an unused one); Alice has none
    const now = Math.floor(s.clock.ms / 1000);
    const run = { roles: { alice: null, bob: { loop_mtime: now - 5 } } };
    assert.equal(s.runner.watchView(run).some_loop_running, false);
    run.roles.alice = { loop_mtime: now - 5 };
    assert.equal(s.runner.watchView(run).some_loop_running, true);
    const both = setup({ pollWatch: false });
    try {
      assert.equal(both.runner.watchView({ roles: { alice: null, bob: { loop_mtime: Math.floor(both.clock.ms / 1000) - 5 } } }).some_loop_running, true);
    } finally {
      both.cleanup();
    }
  } finally {
    s.cleanup();
  }
});

// ---------------------------------------------------------------------------------------------- H1: a funding done outside fund.sh, and the second statement
const restart = (s, o = {}) => new A.ActionRunner({ ...WSL, ...(o.role ? { role: o.role } : {}), runDirs: [s.f.run, s.f.pub] }, { audit: new AuditLog(s.f.pub, { now: () => s.clock.ms, role: o.role }), exec: () => assert.fail("must not run"), now: () => s.clock.ms, pollWatch: false });

test("H1: 'I have funded' is persistent: it writes the markers and is logged, closes send-fund for good, and a restart sees it (markers and audit log)", { skip: F.WSL_HOST_ONLY }, () => {
  const s = setup({ role: "alice" });
  try {
    s.f.writeTick("alice", F.spendTick("fund_noid"), 0);
    adv(s, 1500);
    s.runner.startAction("check-object");
    adv(s, 3000);
    s.runner.startAction("dry-fund");
    assert.equal(viewOf(s).spends["send-fund"].eligible, true, "before the acknowledgement the funding is possible");
    const ack = s.runner.acknowledgeFunding();
    assert.equal(ack.ok, true);
    const line = s.audit.tail(1)[0];
    assert.equal(line.action, "funded-ack");
    assert.match(line.detail, /^marker=none; wrote funded\.marker and the contract's marker$/);
    assert.equal(fs.readFileSync(path.join(s.f.run, "funded.marker"), "utf8").split("\n")[1], "acknowledged: funded outside fund.sh");
    // the page no longer offers it; the gate refuses it even with a fresh dry run and the typed text and the statement
    let v = viewOf(s);
    assert.equal(v.spends["send-fund"].relevant, false);
    assert.match(v.funding.blocked_by, /operator acknowledged .* a funding was done outside this console/);
    adv(s, 3000);
    s.runner.startAction("dry-fund");
    const e = refusedSync(() => s.runner.startSpend("send-fund", "10 NOID", STMT));
    assert.ok(codes(e).includes("already_sent"), codes(e).join());
    assert.equal(s.log.filter((l) => l.script === "fund.sh" && l.flags.length === 0).length, 0, "fund.sh was never run for real");
    // idempotent
    assert.equal(s.runner.acknowledgeFunding().already, true);
    assert.equal(s.audit.all().filter((r) => r.action === "funded-ack").length, 1, "one line, not two");
    // a restart (a new runner over the same audit log): still closed, and its view says so
    const again = restart(s, { role: "alice" });
    v = again.view(readRun([s.f.run, s.f.pub], Math.floor(s.clock.ms / 1000)));
    assert.equal(v.spends["send-fund"].relevant, false);
    assert.match(v.funding.blocked_by, /acknowledged/);
    assert.ok(v.funding.acknowledged_at > 0);
    const e2 = refusedSync(() => again.startSpend("send-fund", "10 NOID", STMT));
    assert.ok(codes(e2).includes("already_sent") || codes(e2).includes("dry_missing"));
  } finally {
    s.cleanup();
  }
});

test("H1: the acknowledgement is refused once a marker exists (either) or a send-fund was started from this console, and is a no-op for bob", { skip: F.WSL_HOST_ONLY }, () => {
  // the run folder's marker
  let s = setup({ role: "alice" });
  try {
    s.runner.startAction("check-object");
    fs.writeFileSync(path.join(s.f.run, "funded.marker"), "2026-11-06T11:00:00Z\n");
    const e = refusedSync(() => s.runner.acknowledgeFunding());
    assert.equal(e.status, 409);
    assert.match(e.message, /funded\.marker 2026-11-06T11:00:00Z/);
    assert.equal(s.audit.all().filter((r) => r.action === "funded-ack").length, 0);
  } finally {
    s.cleanup();
  }
  // the contract's marker, next to the object file (another run folder, same object folder)
  s = setup({ role: "alice", terms: true });
  try {
    s.runner.startAction("check-object");
    fs.writeFileSync(path.join(s.f.pub, "funded-" + F.TERMS.contract_root + ".marker"), "2026-11-06T11:00:00Z\nrun folder /elsewhere\n");
    s.f.write("alice.bundle.json", fs.readFileSync(path.join(s.f.pub, "alice.bundle.json"), "utf8"));
    const e = refusedSync(() => s.runner.acknowledgeFunding());
    assert.equal(e.status, 409);
    assert.match(e.message, /funded-o1rootplaceholder\.marker 2026-11-06T11:00:00Z/);
  } finally {
    s.cleanup();
  }
  // a send-fund start line is NOT a reason: fund.sh may have refused before it wrote a marker (the marker is the truth). With the marker the
  // acknowledgement is refused; without it, it is allowed and writes the markers itself.
  s = setup({ role: "alice" });
  try {
    s.f.writeTick("alice", F.spendTick("fund_noid"), 0);
    adv(s, 1500);
    s.runner.startAction("check-object");
    adv(s, 3000);
    s.runner.startAction("dry-fund");
    adv(s, 3000);
    s.runner.startSpend("send-fund", "10 NOID", STMT);
    assert.ok(fs.existsSync(path.join(s.f.run, "funded.marker")), "the fake fund.sh wrote its marker");
    const e = refusedSync(() => s.runner.acknowledgeFunding());
    assert.equal(e.status, 409);
    assert.match(e.message, /funded\.marker 2026-11-06T11:46:09Z/);
    // the marker is gone (fund.sh had refused before it wrote one): the start line in the log no longer closes the acknowledgement
    fs.rmSync(path.join(s.f.run, "funded.marker"));
    const ack = s.runner.acknowledgeFunding();
    assert.equal(ack.ok, true);
    assert.ok(fs.existsSync(path.join(s.f.run, "funded.marker")));
    // a console restarted over the same folders sees the markers, and a second acknowledgement is a no-op
    const again = restart(s);
    again.objectCheck = { ok: true, at_ms: s.clock.ms };
    assert.equal(again.acknowledgeFunding().already, true);
  } finally {
    s.cleanup();
  }
  // a console for Bob: the acknowledgement is Alice's
  s = setup({ role: "bob" });
  try {
    const e = refusedSync(() => s.runner.acknowledgeFunding());
    assert.equal(e.status, 403);
    assert.match(e.message, /--role bob/);
  } finally {
    s.cleanup();
  }
});

test("H1: send-fund needs the second statement in the request; without it nothing runs, with it the audit start line records it", { skip: F.WSL_HOST_ONLY }, () => {
  const s = setup({ role: "alice" });
  try {
    s.f.writeTick("alice", F.spendTick("fund_noid"), 0);
    adv(s, 1500);
    s.runner.startAction("dry-fund");
    adv(s, 3000);
    for (const meta of [{ bobCheckMatches: true }, { noPendingFunding: false, bobCheckMatches: true }, { noPendingFunding: "true", bobCheckMatches: true }, { noPendingFunding: 1, bobCheckMatches: true }]) {
      const e = refusedSync(() => s.runner.startSpend("send-fund", "10 NOID", meta));
      assert.deepEqual(codes(e), ["statement"], JSON.stringify(meta));
      assert.match(e.reasons[0].text, /No funding of this contract is pending: I have not run the wallet's fund command or fund\.sh for it anywhere else/);
    }
    // the statement about Bob's check line is required the same way, and only the boolean true counts
    for (const meta of [{ noPendingFunding: true }, { noPendingFunding: true, bobCheckMatches: false }, { noPendingFunding: true, bobCheckMatches: "true" }, { noPendingFunding: true, bobCheckMatches: 1 }]) {
      const e = refusedSync(() => s.runner.startSpend("send-fund", "10 NOID", meta));
      assert.deepEqual(codes(e), ["statement_bob_check"], JSON.stringify(meta));
      assert.match(e.reasons[0].text, /Bob's check line matches mine/);
    }
    // neither: both are named
    for (const meta of [undefined, {}]) assert.deepEqual(codes(refusedSync(() => s.runner.startSpend("send-fund", "10 NOID", meta))), ["statement", "statement_bob_check"], JSON.stringify(meta));
    assert.equal(s.log.length, 1, "only the dry run ran");
    assert.ok(s.audit.tail(10).some((r) => r.phase === "refused" && /statement/.test(r.result)));
    adv(s, 3000);
    const sent = s.runner.startSpend("send-fund", "10 NOID", STMT);
    assert.equal(sent.ok, true);
    const start = s.audit.all().find((r) => r.action === "send-fund" && r.phase === "start");
    assert.match(start.detail, /statement=no_pending_funding; statement=bob_check_line_matches/);
    assert.equal(start.srv_role, "alice");
    // the other spends do not take or record the statement
    assert.ok(!/statement/.test((s.audit.all().find((r) => r.action === "dry-fund" && r.phase === "start") || {}).detail || ""));
  } finally {
    s.cleanup();
  }
});

test("H1: the contract's own marker (funded-<root>.marker next to the object file) closes send-fund and is named in the view", { skip: F.WSL_HOST_ONLY }, () => {
  const s = setup({ role: "alice" });
  try {
    s.f.writeTick("alice", F.spendTick("fund_noid"), 0);
    adv(s, 1500);
    s.runner.startAction("dry-fund");
    assert.equal(viewOf(s).spends["send-fund"].eligible, true);
    // another run folder with the same object folder funded this contract
    fs.writeFileSync(path.join(s.f.pub, "funded-" + F.TERMS.contract_root + ".marker"), "2026-11-06T11:00:00Z\nrun folder /elsewhere\n");
    const v = viewOf(s);
    assert.equal(v.spends["send-fund"].relevant, false);
    assert.match(v.funding.blocked_by, /funded-o1rootplaceholder\.marker next to the object file \(2026-11-06T11:00:00Z\)/);
    assert.equal(v.funding.marker_at, null, "no marker in THIS run folder");
    const e = refusedSync(() => s.runner.startSpend("send-fund", "10 NOID", STMT));
    assert.ok(codes(e).includes("already_sent"));
    // a root that is not a plain bech32 word never names a file
    assert.equal(s.runner.contractMarker("o1../../x"), null);
    assert.equal(s.runner.contractMarker(null), null);
  } finally {
    s.cleanup();
  }
});

// ---------------------------------------------------------------------------------------------- M1 / M3 through the runner
test("M1/M3 through the runner: the dry run names the platform's wallet program and the very object file the terms came from", { skip: F.WSL_HOST_ONLY }, () => {
  const s = setup({ role: "alice", behaviour: { fund: { cli: "/tmp/evil" } } });
  try {
    s.f.writeTick("alice", F.spendTick("fund_noid"), 0);
    adv(s, 1500);
    s.runner.startAction("dry-fund");
    let sp = viewOf(s).spends["send-fund"];
    assert.equal(sp.dry.all_ok, false);
    assert.deepEqual(sp.dry.rows.filter((r) => r.ok === false).map((r) => r.label), ["The wallet command is the platform default (no other program)"]);
    assert.equal(sp.eligible, false);
  } finally {
    s.cleanup();
  }
  // a fund.sh that read ANOTHER object file (same bytes or not): red with both paths
  const t = setup({ role: "alice", behaviour: { fund: { objPath: "/home/u/other-run/swap.object.json" } } });
  try {
    t.f.writeTick("alice", F.spendTick("fund_noid"), 0);
    adv(t, 1500);
    t.runner.startAction("dry-fund");
    const sp = viewOf(t).spends["send-fund"];
    const row = sp.dry.rows.find((r) => /the console's terms came from/.test(r.label));
    assert.equal(row.ok, false);
    assert.match(row.expected, /swap\.object\.json sha256 [0-9a-f]{64}$/);
    assert.match(row.actual, /^\/home\/u\/other-run\/swap\.object\.json sha256 /);
    assert.equal(sp.eligible, false);
  } finally {
    t.cleanup();
  }
});

// ---------------------------------------------------------------------------------------------- L1: the whole audit log, one console per folder, the same folder
test("L1: the latches and the funding guards are rebuilt from the WHOLE audit log (a send-fund start line more than 400 lines back still counts)", () => {
  const s = setup({ role: "alice" });
  try {
    s.audit.append({ action: "send-fund", role: "alice", phase: "start", result: "started", detail: "statement=no_pending_funding; tick=5;intent=7" });
    for (let i = 0; i < 1600; i++) s.audit.append({ action: "tick-alice", role: "alice", phase: "end", result: "ok (exit 0)", detail: "x".repeat(1000) });
    assert.ok(fs.statSync(s.audit.file).size > 513 * 1024, "the log is past the old 512 KB read cap too");
    assert.equal(s.audit.all().length, 1601);
    assert.equal(s.audit.verify().ok, true, "the chain is verified over every line");
    const again = restart(s);
    assert.deepEqual(again.latch.get("send-fund"), { tickNow: 5, intentAt: 7 });
    again.objectCheck = { ok: true, at_ms: s.clock.ms };
    // the start line only latches the tick and the intent; it does not close the acknowledgement (only a marker does)
    assert.equal(again.acknowledgeFunding().ok, true);
    assert.ok(fs.existsSync(path.join(s.f.run, "funded.marker")));
  } finally {
    s.cleanup();
  }
});

test("L1: the folder the console reads must be the folder the helpers get as L; what cannot be shown to match refuses actions mode", () => {
  const base = { distro: "Ubuntu-24.04", runDir: "/home/u/live-run-5", binDir: "/home/u/live-run-5/bin", runNumber: 5 };
  const ok = (runDirs, extra = {}) => A.validateActionsConfig({ ...base, runDirs, ...extra });
  assert.deepEqual(ok(["//wsl.localhost/Ubuntu-24.04/home/u/live-run-5"]), []);
  assert.deepEqual(ok(["\\\\wsl.localhost\\Ubuntu-24.04\\home\\u\\live-run-5\\"]), [], "either slash style, a trailing slash");
  assert.deepEqual(ok(["//wsl$/ubuntu-24.04/home/u/live-run-5"]), [], "the \\\\wsl$ spelling, the distro case");
  assert.deepEqual(ok(["C:/Users/x/live-run-5"], { runDir: "/mnt/c/Users/x/live-run-5", binDir: "/mnt/c/Users/x/live-run-5/bin" }), [], "/mnt/c is C:");
  assert.deepEqual(A.validateActionsConfig({ distro: null, runDir: "/srv/live-run-5", binDir: "/srv/live-run-5/bin", runNumber: 5, runDirs: ["/srv/live-run-5"] }), [], "native: the same path");
  for (const [runDirs, extra] of [
    [["//wsl.localhost/Ubuntu-24.04/home/u/live-run-6"], {}], // another folder
    [["//wsl.localhost/Ubuntu-24.04/home/u/live-run-5"], { runDir: "/home/u/elsewhere/live-run-5", binDir: "/home/u/elsewhere/live-run-5/bin" }], // --wsl-run-dir names another one
    [["//wsl.localhost/Other-Distro/home/u/live-run-5"], {}], // another distro
    [["//wsl.localhost/Ubuntu-24.04/home/u/live-run-5"], { distro: "Other-Distro" }], // --wsl-distro names another
    [["C:/Users/x/live-run-5"], {}], // a Windows folder with a Linux L that is not its /mnt mapping
    [["relative/live-run-5"], {}], // cannot be shown
  ]) {
    const errs = ok(runDirs, extra);
    assert.ok(errs.some((e) => /cannot be shown to be the folder the helpers get as L/.test(e)), JSON.stringify([runDirs, extra, errs]));
  }
  // no read folder known (a unit test of the command builder): no check
  assert.deepEqual(A.validateActionsConfig({ ...base }), []);
});

// ---------------------------------------------------------------------------------------------- C1-C3: the markers, the run lock, one object file
const { RunLock, FILE: LOCK_FILE } = require("../lib/runlock");
const { spawnSync } = require("child_process");
const os = require("os");

/** A bash that runs the repository's POSIX helpers with POSIX paths (Git Bash on Windows, any bash elsewhere), or null: the end-to-end test then skips. */
function findBash() {
  const probe = os.tmpdir().replace(/\\/g, "/");
  for (const b of [process.env.GIT_BASH, "C:/Program Files/Git/bin/bash.exe", "bash"].filter(Boolean)) {
    try {
      const r = spawnSync(b, ["-c", 'cd "$1" && echo ok && command -v sha256sum shasum | head -n 1', "_", probe], { encoding: "utf8" });
      if (r.status === 0 && /^ok\n/.test(r.stdout) && r.stdout.trim().split("\n").length > 1) return b;
    } catch {
      /* next */
    }
  }
  return null;
}
const posix = (p) => (process.platform === "win32" ? p.replace(/\\/g, "/").replace(/^([A-Za-z]):/, (m, d) => "/" + d.toLowerCase()) : p);

test("C1: the acknowledgement writes funded.marker (two lines) and the contract's marker, exclusively; the real fund.sh is then refused by them (no wallet call)", { skip: !findBash() && "no POSIX bash to run fund.sh with" }, () => {
  const bash = findBash();
  const s = setup({ role: "alice" });
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "noid-fundsh-"));
  try {
    s.runner.startAction("check-object");
    adv(s, 3000);
    const ack = s.runner.acknowledgeFunding();
    assert.equal(ack.ok, true);
    const run = fs.readFileSync(path.join(s.f.run, "funded.marker"), "utf8").split("\n");
    assert.match(run[0], /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);
    assert.equal(run[1], "acknowledged: funded outside fund.sh");
    const cm = fs.readFileSync(path.join(s.f.pub, "funded-" + F.TERMS.contract_root + ".marker"), "utf8").split("\n");
    assert.equal(cm[1], "acknowledged: funded outside fund.sh");
    assert.equal(s.audit.tail(1)[0].action, "funded-ack", "the audit line stays");
    // the real helper, with stubs for the wallet CLI, check-object and swap-cli: it must refuse and never call `contract fund`
    const fb = path.join(work, "bin");
    fs.mkdirSync(fb);
    const live = path.resolve(__dirname, "..", "..", "..", "scripts", "live");
    for (const f of ["env.sh", "fund.sh"]) fs.writeFileSync(path.join(fb, f), fs.readFileSync(path.join(live, f), "utf8").replace(/\r/g, ""));
    const stub = (name, body) => fs.writeFileSync(path.join(work, name), "#!/bin/sh\n" + body, { mode: 0o755 });
    fs.writeFileSync(path.join(fb, "check-object.sh"), '#!/bin/sh\necho "object file OK: its opening is byte-for-byte the swap file\'s; fund exactly this address: o1rootplaceholder" >&2\n');
    stub("cli", 'echo "$@" >> "$STUB_LOG"\nexit 0\n');
    stub("swapcli", 'echo "{"; echo "  \\"amount_micronoid\\": 10000000,"; echo "}"\n');
    fs.writeFileSync(path.join(s.f.run, "env.local.sh"), "CONTRACT=0x0000000000000000000000000000000000000001\nALICE_NOID=o1a; BOB_NOID=o1b\nALICE_ETH=0xa; BOB_ETH=0xb\n");
    const log = path.join(work, "cli.log");
    fs.writeFileSync(log, "");
    fs.mkdirSync(path.join(work, "home"));
    const env = { ...process.env, HOME: posix(path.join(work, "home")), L: posix(s.f.run), LIVE_PLATFORM: "native", OBJ: posix(path.join(s.f.pub, "swap.object.json")), BIN: posix(path.join(work, "swapcli")), NOID_CLI: posix(path.join(work, "cli")), AMOUNT: "10000000", STUB_LOG: posix(log) };
    for (const flags of [[], ["--dry-run"]]) {
      const r = spawnSync(bash, [posix(path.join(fb, "fund.sh")), ...flags], { env, encoding: "utf8" });
      assert.equal(r.status, 3, `${flags.join(" ")}: ${r.stdout} ${r.stderr}`);
      assert.match(r.stdout, /REFUSED: (this contract was already funded through fund\.sh|fund\.sh already ran for this run folder)/);
      assert.match(r.stdout, /recorded \((object folder|run folder)\): acknowledged: funded outside fund\.sh/);
    }
    assert.equal(fs.readFileSync(log, "utf8").split("\n").filter((l) => /^contract fund /.test(l)).length, 0, "the wallet CLI's fund was never called");
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
    s.cleanup();
  }
});

test("C1: the acknowledgement refuses when a marker exists and writes nothing then; without a known object file only the run folder's marker is made; the exclusive creation loses to fund.sh", () => {
  // the contract's marker exists: refused, and no run-folder marker is made
  let s = setup({ role: "alice" });
  try {
    s.runner.startAction("check-object");
    fs.writeFileSync(path.join(s.f.pub, "funded-" + F.TERMS.contract_root + ".marker"), "2026-11-06T11:00:00Z\nrun folder /elsewhere\n");
    const e = refusedSync(() => s.runner.acknowledgeFunding());
    assert.equal(e.status, 409);
    assert.equal(fs.existsSync(path.join(s.f.run, "funded.marker")), false);
    assert.equal(s.audit.all().filter((r) => r.action === "funded-ack").length, 0, "no audit line either");
  } finally {
    s.cleanup();
  }
  // no object file: the contract's marker has no folder to go to; refused (409), nothing written, an audit `refused` line
  s = setup({ role: "alice", objectFile: false });
  try {
    s.runner.startAction("check-object");
    const e = refusedSync(() => s.runner.acknowledgeFunding());
    assert.equal(e.status, 409);
    assert.match(e.message, /no object file is visible/);
    assert.equal(fs.existsSync(path.join(s.f.run, "funded.marker")), false);
    assert.deepEqual(fs.readdirSync(s.f.pub).filter((n) => /^funded-/.test(n)), []);
    const last = s.audit.tail(1)[0];
    assert.deepEqual([last.action, last.phase], ["funded-ack", "refused"]);
    assert.match(last.result, /no object file is visible/);
    assert.equal(s.audit.all().filter((r) => r.action === "funded-ack" && r.phase === "note").length, 0);
  } finally {
    s.cleanup();
  }
  // an object file whose terms carry no contract root (no address, no bundle): refused the same way
  s = setup({ role: "alice" });
  try {
    fs.writeFileSync(path.join(s.f.pub, "swap.object.json"), JSON.stringify({ claim_authority: "o1AUTH" }));
    fs.rmSync(path.join(s.f.pub, "alice.bundle.json"));
    fs.rmSync(path.join(s.f.run, "alice.bundle.json"));
    s.runner.startAction("check-object");
    const e = refusedSync(() => s.runner.acknowledgeFunding());
    assert.equal(e.status, 409);
    assert.match(e.message, /no contract root/);
    assert.equal(fs.existsSync(path.join(s.f.run, "funded.marker")), false);
    assert.deepEqual(fs.readdirSync(s.f.pub).filter((n) => /^funded-/.test(n)), []);
    const last = s.audit.tail(1)[0];
    assert.deepEqual([last.action, last.phase], ["funded-ack", "refused"]);
    assert.match(last.result, /no contract root/);
  } finally {
    s.cleanup();
  }
  // the success response says what the acknowledgement does and does not block
  s = setup({ role: "alice" });
  try {
    s.runner.startAction("check-object");
    const ack = s.runner.acknowledgeFunding();
    assert.equal(ack.ok, true);
    assert.match(ack.note, /this run folder and this object folder only/);
    assert.match(ack.note, /COPY of the object file in another folder/);
  } finally {
    s.cleanup();
  }
  // the marker appears between the check and the write (fund.sh is running): the exclusive creation refuses, the contract's marker made first is taken back
  s = setup({ role: "alice" });
  try {
    s.runner.startAction("check-object");
    const real = s.runner.fundedMarker.bind(s.runner);
    let calls = 0;
    s.runner.fundedMarker = () => (calls++ === 0 ? null : real());
    const orig = fs.writeFileSync;
    fs.writeFileSync = function (p, d, o) {
      if (String(p).endsWith("funded.marker") && o && o.flag === "wx") orig.call(fs, p, "2026-11-06T12:00:00Z\nstage: calling wallet CLI\n"); // fund.sh was first
      return orig.call(fs, p, d, o);
    };
    let e;
    try {
      e = refusedSync(() => s.runner.acknowledgeFunding());
    } finally {
      fs.writeFileSync = orig;
    }
    assert.equal(e.status, 409);
    assert.match(e.message, /appeared while the acknowledgement was written/);
    assert.deepEqual(fs.readdirSync(s.f.pub).filter((n) => /^funded-/.test(n)), [], "the contract's marker made first was taken back");
    assert.match(fs.readFileSync(path.join(s.f.run, "funded.marker"), "utf8"), /stage: calling wallet CLI/, "fund.sh's marker is left alone");
  } finally {
    s.cleanup();
  }
});

test("C3: the terms and the binding come from ONE object file: the newest swap.object.json readRun took, not the first folder that has one", () => {
  const s = setup({ role: "alice" });
  try {
    // an older file in the run folder, a newer one (other bytes) in the public copy: readRun's terms come from the newer one
    const older = path.join(s.f.run, "swap.object.json");
    const newer = path.join(s.f.pub, "swap.object.json");
    fs.writeFileSync(older, JSON.stringify({ address: "o1olderone", claim_authority: "o1AUTH" }));
    fs.writeFileSync(newer, JSON.stringify({ address: "o1rootplaceholder", claim_authority: "o1AUTH", n: 2 }));
    fs.utimesSync(older, new Date(Date.now() - 600000), new Date(Date.now() - 600000));
    fs.utimesSync(newer, new Date(), new Date());
    const run = readRun([s.f.run, s.f.pub], Math.floor(Date.now() / 1000));
    assert.equal(run.object_file.path, newer);
    assert.equal(run.terms.contract_root, "o1rootplaceholder");
    const info = s.runner.objectInfo(run);
    assert.equal(info.path, newer, "the same file as the terms");
    assert.equal(info.dir, s.f.pub);
    assert.equal(info.sha, require("crypto").createHash("sha256").update(fs.readFileSync(newer)).digest("hex"));
    assert.equal(s.runner.objectSha(run), info.sha);
    // the old way (no run given) would have taken the first folder that has one
    assert.equal(s.runner.objectInfo().path, older);
    // the contract's marker is looked for next to the file the terms came from
    fs.writeFileSync(path.join(s.f.pub, "funded-o1rootplaceholder.marker"), "2026-11-06T11:00:00Z\n");
    assert.equal(s.runner.contractMarker("o1rootplaceholder", run).at, "2026-11-06T11:00:00Z");
    assert.equal(s.runner.contractMarker("o1rootplaceholder"), null, "the first-folder reading looks in the wrong folder");
    // no object file in any folder: nothing
    fs.rmSync(older);
    fs.rmSync(newer);
    assert.equal(s.runner.objectInfo(readRun([s.f.run, s.f.pub], 1)), null);
  } finally {
    s.cleanup();
  }
});

test("C3: the funding dry run in the view is bound to the file the terms came from, and its contract-address row is green", { skip: F.WSL_HOST_ONLY }, () => {
  const s = setup({ role: "alice" });
  try {
    s.f.writeTick("alice", F.spendTick("fund_noid"), 0);
    const older = path.join(s.f.run, "swap.object.json");
    fs.writeFileSync(older, JSON.stringify({ address: "o1rootplaceholder", old: true }));
    fs.utimesSync(older, new Date(Date.now() - 600000), new Date(Date.now() - 600000));
    fs.utimesSync(path.join(s.f.pub, "swap.object.json"), new Date(), new Date());
    adv(s, 1500);
    s.runner.startAction("dry-fund"); // the fake helper hashes and names the public copy's file
    const v = s.runner.view(readRun([s.f.run, s.f.pub], Math.floor(s.clock.ms / 1000)));
    const sp = v.spends["send-fund"];
    const row = sp.dry.rows.find((r) => /the console's terms came from/.test(r.label));
    assert.equal(row.ok, true, JSON.stringify(row));
    const root = sp.dry.rows.find((r) => /contract address = the terms' contract root/.test(r.label));
    assert.equal(root.ok, true);
  } finally {
    s.cleanup();
  }
});

test("C2: a console whose run lock is no longer its own spends nothing (the file is read again right before the start); the refusal is logged and says what to delete", () => {
  const s = setup();
  const lockDir = fs.mkdtempSync(path.join(os.tmpdir(), "noid-lockfile-"));
  try {
    const lock = RunLock.acquire(lockDir, { pid: process.pid, now: () => Date.UTC(2026, 10, 6, 12, 0, 0), role: "bob" });
    s.runner.runLock = lock;
    s.f.writeTick("bob", F.spendTick("lock_eth"), 0);
    adv(s, 1500);
    s.runner.startAction("dry-lock");
    adv(s, 2500);
    // another console took the lock over (its pid and start time are in the file now)
    fs.writeFileSync(path.join(lockDir, LOCK_FILE), JSON.stringify({ pid: process.pid + 1, started: "2026-11-06T12:00:05Z", role: "bob" }) + "\n");
    const before = s.log.length;
    const e = refusedSync(() => s.runner.startSpend("send-lock", "0.001 ETH"));
    assert.equal(e.status, 409);
    assert.match(e.message, /no longer holds the run folder's lock/);
    assert.ok(e.message.includes(lock.file) && /if no console is running, delete /.test(e.message), e.message);
    assert.equal(s.log.length, before, "no helper ran");
    const lines = s.audit.all();
    assert.equal(lines.some((r) => r.action === "send-lock" && r.phase === "start"), false, "no start line");
    assert.ok(lines.some((r) => r.action === "send-lock" && r.phase === "refused" && /run lock not ours/.test(r.result)));
    // the file is gone altogether: the same
    fs.rmSync(path.join(lockDir, LOCK_FILE));
    assert.match(refusedSync(() => s.runner.startSpend("send-lock", "0.001 ETH")).message, /the lock file is gone/);
    // the funding acknowledgement writes the markers a spend would: also refused
    s.runner.objectCheck = { ok: true, at_ms: s.clock.ms };
    assert.match(refusedSync(() => s.runner.acknowledgeFunding()).message, /no longer holds/);
    assert.equal(fs.existsSync(path.join(s.f.run, "funded.marker")), false);
    // the launch itself looks too (a spend that got past startSpend's own look): the same refusal, nothing logged as started
    fs.writeFileSync(path.join(lockDir, LOCK_FILE), JSON.stringify({ pid: process.pid + 1, started: "x" }) + "\n");
    assert.throws(() => s.runner.launch(A.BY_ID.get("send-lock"), s.runner.command("send-lock"), { role: "bob" }), /no longer holds/);
    assert.equal(s.audit.all().filter((r) => r.action === "send-lock" && r.phase === "start").length, 0);
    // the file is ours again: the spend goes through (the dry run is still valid)
    fs.writeFileSync(path.join(lockDir, LOCK_FILE), JSON.stringify({ pid: process.pid, started: "2026-11-06T12:00:00Z", role: "bob" }) + "\n");
    const job = s.runner.startSpend("send-lock", "0.001 ETH");
    assert.equal(job.state, "done");
    assert.equal(s.log.length, before + 1);
    lock.release();
  } finally {
    fs.rmSync(lockDir, { recursive: true, force: true });
    s.cleanup();
  }
});

test("restore selftest uses call-height from first_read when no tick", async () => {
  const fsx = require("fs");
  const osx = require("os");
  const pathx = require("path");
  const root = fsx.mkdtempSync(pathx.join(osx.tmpdir(), "no1d-selftest-"));
  try {
    const argsFile = pathx.join(root, "args.json");
    const stub = pathx.join(root, "stub.js");
    fsx.writeFileSync(stub, `require("fs").writeFileSync(${JSON.stringify(argsFile)}, JSON.stringify(process.argv.slice(2)));`);
    const dir = pathx.join(root, "run");
    fsx.mkdirSync(pathx.join(dir, "bob"), { recursive: true });
    fsx.writeFileSync(pathx.join(dir, "restored.json"), JSON.stringify({ v: 1, restored_at: "2026-11-25T10:00:00Z", backup_seq: 1, backup_made_at: "2026-11-25T09:00:00Z", backup_phase: "funding_final", first_read: { noid_tip: 300100, eth_block: 5, at: "2026-11-25T10:00:00Z" } }));
    const { ActionRunner } = require("../lib/actions");
    const mk = (noidRpc) => {
      const r = Object.create(ActionRunner.prototype);
      r.cfg = { runDirs: [dir] };
      r.program = { tools: { swapCli: [process.execPath, stub], curl: "/usr/bin/curl" } };
      r.settingsSource = { load: () => ({ ok: true, settings: { noid_rpc: noidRpc } }) };
      return r;
    };
    const read = () => JSON.parse(fsx.readFileSync(argsFile, "utf8"));
    // no tick: the height of the restore's first reading, plus one
    let res = await mk("https://node.example/rpc").runRestoreSelftest({ roles: { bob: null } });
    assert.equal(res.ok, true);
    assert.deepEqual(read().slice(0, 1), ["self-test"]);
    assert.deepEqual(read().slice(2), ["--call-height", "300101"]);
    // no tick and no first reading: the settings' node with the transport a tick uses
    fsx.rmSync(pathx.join(dir, "restored.json"));
    res = await mk("https://node.example/rpc").runRestoreSelftest({ roles: { bob: null } });
    assert.equal(res.ok, true);
    assert.deepEqual(read().slice(2), ["--noid-rpc", "https://node.example/rpc", "--transport", "curl", "--curl-path", "/usr/bin/curl"]);
  } finally {
    fsx.rmSync(root, { recursive: true, force: true });
  }
});
