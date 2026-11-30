"use strict";
// The repairs of 2026-11-16 in the actions runner: what a helper's exit status means (a clean refusal is not "may have sent"; an unknown status,
// a signal and a timeout are), the reveal's outcomes (the secret may be public), the production guard, the alarm beside a refund's send box.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const A = require("../lib/actions");
const { AuditLog } = require("../lib/audit");
const { readRun } = require("../lib/runfolder");
const F = require("./actions-fixtures");

const WSL = { skipFolderCheck: true, distro: "Ubuntu-24.04", runDir: "/home/u/live-run-5", binDir: "/home/u/live-run-5/bin", runNumber: 5, repoLiveDir: "/mnt/c/repo/scripts/live" };
const TX = "0x" + "ab".repeat(32);
const codes = (e) => (e.reasons || []).map((r) => r.code);
const exit = (code, extra = {}) => Object.assign(new Error("exit " + code), { code, ...extra });

/**
 * A runner over temp folders with a fake wsl.exe. `respond({script, flags, dry, n, write})` returns { err, out, errOut } and may `write(name, content)` the
 * files the helper would leave in the run folder; the default is the helper's good answer (dry-run file, or a mined result).
 */
function harness(o = {}) {
  const f = F.makeFolders();
  const clock = { ms: Date.now() };
  const log = [];
  let seq = 0;
  const exec = (file, args, opts, cb) => {
    const si = args.findIndex((a) => /\.sh$/.test(a));
    const script = si >= 0 ? path.basename(args[si]) : "inline";
    const flags = si >= 0 ? args.slice(si + 1) : [];
    log.push({ script, flags });
    const n = String(100000 + ++seq);
    const write = (name, content) => {
      const p = path.join(f.run, name);
      fs.writeFileSync(p, typeof content === "string" ? content : JSON.stringify(content));
      const t = new Date(clock.ms);
      fs.utimesSync(p, t, t);
    };
    const dry = flags.includes("--dry-run");
    const replace = flags.includes("--replace");
    const hash = flags[flags.indexOf("--replace") + 1];
    const r = (o.respond && o.respond({ script, flags, dry, n, write, replace, hash })) || null;
    if (r) return cb(r.err || null, r.out || "", r.errOut || "");
    if (script === "lock.sh") {
      if (dry) write(`eth-lock-${n}.json`, F.lockDry());
      else write(`eth-lock-${n}.json`, { lockId: F.LOCK_ID, txHash: TX, blockNumber: 1 });
    } else if (script === "reveal.sh") {
      if (dry) write(`eth-claim-dry-${n}.json`, F.revealDry({ replace, replacesTx: replace ? hash : null }));
      else write("eth-claim.json", { txHash: TX, blockNumber: 2 });
    } else if (script === "refund-eth.sh") {
      if (dry) write(`eth-refund-${n}.json`, F.refundDry({ replace, replacesTx: replace ? hash : null }));
      else write(`eth-refund-${n}.json`, { txHash: TX, blockNumber: 3 });
    }
    cb(null, "", "");
  };
  fs.writeFileSync(path.join(f.pub, "swap.object.json"), JSON.stringify({ address: "o1rootplaceholder", claim_authority: "o1AUTH" }));
  const mkRunner = () => new A.ActionRunner({ ...WSL, runDirs: [f.run, f.pub] }, { audit: new AuditLog(f.pub, { now: () => clock.ms }), exec, spawnDetached: () => ({ unref() {}, on() {} }), now: () => clock.ms, pollWatch: false });
  const runner = mkRunner();
  const adv = (ms) => (clock.ms += ms);
  const view = () => runner.view(readRun([f.run, f.pub], Math.floor(clock.ms / 1000)));
  return { f, clock, log, runner, adv, view, mkRunner, cleanup: f.cleanup };
}

/** Dry run, then the send, for a spend whose tick is already on disk. Returns the send's job record (or the thrown refusal). */
function dryAndSend(h, dryId, spendId, typed) {
  h.adv(1500);
  h.runner.startAction(dryId);
  h.adv(2500);
  return h.runner.startSpend(spendId, typed);
}

// ------------------------------------------------------------------------------------------------ the exit status of a spend

test("lock.sh exit 3 with its refusal line is 'refused, nothing sent': no 'may have sent', the latch is released, a restart does not latch it, and a new dry run can go on", () => {
  const h = harness({
    respond: ({ script, dry, n }) => (script === "lock.sh" && !dry ? { err: exit(3), out: "lock REFUSED, nothing sent: the fresh read-only tick right before the send does not show a lock to send.\nwhy\n" } : null),
  });
  try {
    h.f.writeTick("bob", F.spendTick("lock_eth"), 0);
    const job = dryAndSend(h, "dry-lock", "send-lock", "0.001 ETH");
    assert.equal(job.state, "done");
    assert.equal(job.ok, false);
    assert.equal(job.exit_code, 3);
    assert.equal(job.nothing_sent, true);
    assert.equal(job.outcome, "refused_nothing_sent");
    assert.match(job.error, /Refused by lock\.sh, nothing was sent/);
    assert.ok(!/may have sent/.test(job.error), job.error);
    assert.equal(job.tx, null);
    assert.equal(h.runner.latchOf("send-lock"), null, "the latch is released");
    const end = h.runner.audit.tail(10).find((l) => l.action === "send-lock" && l.phase === "end");
    assert.equal(end.result, "refused, nothing sent (lock.sh exit 3)");
    // a restart: the audit log's start line is NOT turned back into a latch
    assert.equal(h.mkRunner().latch.get("send-lock"), undefined);
    // and the same intent can be sent after a fresh dry run (the helper is asked again)
    h.adv(3000);
    h.runner.startAction("dry-lock");
    h.adv(2500);
    const again = h.runner.startSpend("send-lock", "0.001 ETH");
    assert.equal(again.state, "done");
    assert.equal(h.log.filter((c) => c.script === "lock.sh" && !c.flags.includes("--dry-run")).length, 2, "the helper was started twice: the first sent nothing");
  } finally {
    h.cleanup();
  }
});

test("every other ending of a spend stays 'the transaction may have been sent' and the latch stays: exit 3 without the refusal line, exit 1, an unknown status, a signal, a timeout, an exit status with a result file", () => {
  const cases = [
    ["exit 3 without the helper's refusal line", { err: exit(3), out: "something else\n" }],
    ["exit 1", { err: exit(1), out: "lock SEND exit 1 at 10:00:00\n" }],
    ["an unknown status (7)", { err: exit(7), out: "" }],
    ["a signal", { err: exit(null, { signal: "SIGTERM", code: null }), out: "" }],
    ["a timeout", { err: exit(null, { killed: true, code: null }), out: "" }],
    ["exit 3 with the refusal line but a result file of the send", { err: exit(3), out: "lock REFUSED, nothing sent: x\n", file: true }],
    ["exit 2 with a result file of the send", { err: exit(2), out: "", file: true }],
  ];
  for (const [name, c] of cases) {
    const h = harness({
      respond: ({ script, dry, n, write }) => {
        if (script !== "lock.sh" || dry) return null;
        if (c.file) write(`eth-lock-${n}.json`, { txHash: TX });
        return { err: c.err, out: c.out };
      },
    });
    try {
      h.f.writeTick("bob", F.spendTick("lock_eth"), 0);
      const job = dryAndSend(h, "dry-lock", "send-lock", "0.001 ETH");
      assert.equal(job.nothing_sent, false, name);
      assert.notEqual(job.outcome, "refused_nothing_sent", name);
      assert.ok(h.runner.latchOf("send-lock"), `${name}: the latch stays`);
      const end = h.runner.audit.tail(10).find((l) => l.action === "send-lock" && l.phase === "end");
      assert.ok(!/refused, nothing sent/.test(end.result), `${name}: ${end.result}`);
      assert.match(end.result, /may have been sent|may still have run/, name);
      assert.ok(h.mkRunner().latch.get("send-lock"), `${name}: a restart keeps the latch`);
    } finally {
      h.cleanup();
    }
  }
});

test("exit 2 of a spend helper (it stops before live.js ran) is a clean refusal; for the funding exit 3 counts only when the helper never reached the wallet call", () => {
  const h = harness({ respond: ({ script, dry }) => (script === "refund-eth.sh" && !dry ? { err: exit(2), out: "", errOut: "refusing: MAX_FEE_GWEI or GAS_PRICE_GWEI is not set\n" } : null) });
  try {
    h.f.writeTick("bob", F.spendTick("refund_eth"), 0);
    const job = dryAndSend(h, "dry-refund-eth", "send-refund-eth", "0.001 ETH");
    assert.equal(job.nothing_sent, true);
    assert.equal(h.runner.latchOf("send-refund-eth"), null);
  } finally {
    h.cleanup();
  }
  const X = require("../lib/exitcodes");
  assert.equal(X.classifySpendExit("fund.sh", { exitCode: 3, stdout: "REFUSED: the contract already has 1 instance(s); funding again would add another one\n" }).nothing_sent, true);
  assert.equal(X.classifySpendExit("fund.sh", { exitCode: 3, stdout: "funding 5.000000 NOID (once) at 11:46:09 UTC\nError: node says 3\n" }).nothing_sent, false, "exit 3 AFTER the wallet call is the wallet's own status");
  assert.equal(X.classifySpendExit("fund.sh", { exitCode: 1, stdout: "REFUSED: x\n" }).nothing_sent, false);
});

// ------------------------------------------------------------------------------------------------ the reveal's outcomes

test("a reveal that did not end clean says the secret MAY BE PUBLIC, whatever the helper's text, and the console never re-sends by itself", () => {
  const outcomes = [
    ["unknown outcome of the bounded send (exit 1, nothing readable)", { err: exit(1), out: "claim exit 1 at 10:00:00\nerror: The claim may have reached the network (the connection was reset); the secret may be public.\n" }],
    ["delivered_rejected (exit 1)", { err: exit(1), out: "claim exit 1\nerror: The endpoint received the claim and its node refused it (nonce too low). The endpoint has seen the secret: treat it as public.\n" }],
    ["a text nobody documented", { err: exit(1), out: "error: Nothing was sent (stopped while connecting): x\n" }],
    ["a timeout", { err: exit(null, { killed: true, code: null }), out: "" }],
    ["a signal", { err: exit(null, { signal: "SIGKILL", code: null }), out: "" }],
    ["an unknown status", { err: exit(9), out: "" }],
    ["exit 0 but no readable result", { err: null, out: "claim exit 0\n", noResult: true }],
  ];
  for (const [name, c] of outcomes) {
    const h = harness({
      respond: ({ script, dry, write }) => {
        if (script !== "reveal.sh" || dry) return null;
        if (!c.noResult) write("eth-claim.json", "");
        return { err: c.err, out: c.out };
      },
    });
    try {
      h.f.writeTick("alice", F.spendTick("reveal_eth"), 0);
      const job = dryAndSend(h, "dry-reveal", "send-reveal", "0.001 ETH");
      assert.equal(job.nothing_sent, false, name);
      assert.equal(job.secret_may_be_public, true, name);
      assert.match(job.warning, /treat the SECRET as PUBLIC/, name);
      assert.match(job.warning, /never re-sends a reveal by itself/, name);
      const end = h.runner.audit.tail(10).find((l) => l.action === "send-reveal" && l.phase === "end");
      assert.match(end.result, /SECRET MAY BE PUBLIC/, `${name}: ${end.result}`);
      // never an automatic re-send: the helper ran once, the first send is latched, and the re-send is not even offered without a pending claim
      assert.equal(h.log.filter((c2) => c2.script === "reveal.sh" && !c2.flags.includes("--dry-run")).length, 1, name);
      const v = h.view();
      assert.equal(v.spends["send-reveal-replace"].relevant, false, `${name}: no pending claim, no re-send box`);
      h.adv(5000);
      const e = (() => {
        try {
          h.runner.startAction("dry-reveal");
          h.adv(2500);
          h.runner.startSpend("send-reveal", "0.001 ETH");
        } catch (x) {
          return x;
        }
        return null;
      })();
      assert.ok(e && codes(e).includes("latched"), `${name}: a second first-send is refused (${e && codes(e)})`);
    } finally {
      h.cleanup();
    }
  }
});

test("a reveal: a refusal before live.js ran (exit 2) is clean; mined and reverted (exit 3) says the secret IS public; exit 0 with a result raises nothing", () => {
  let h = harness({ respond: ({ script, dry }) => (script === "reveal.sh" && !dry ? { err: exit(2), out: "", errOut: "no /home/u/live-run-5/passphrase.txt (run setup.sh)\n" } : null) });
  try {
    h.f.writeTick("alice", F.spendTick("reveal_eth"), 0);
    const job = dryAndSend(h, "dry-reveal", "send-reveal", "0.001 ETH");
    assert.equal(job.nothing_sent, true);
    assert.equal(job.secret_may_be_public, false);
    assert.equal(job.warning, null);
    assert.equal(h.runner.latchOf("send-reveal"), null);
  } finally {
    h.cleanup();
  }
  h = harness({ respond: ({ script, dry, write }) => (script === "reveal.sh" && !dry ? (write("eth-claim.json", { txHash: TX, reverted: true, secretPublic: true }), { err: exit(3), out: "claim exit 3\n" }) : null) });
  try {
    h.f.writeTick("alice", F.spendTick("reveal_eth"), 0);
    const job = dryAndSend(h, "dry-reveal", "send-reveal", "0.001 ETH");
    assert.equal(job.secret_may_be_public, true);
    assert.match(job.warning, /SECRET IS PUBLIC/);
    assert.match(h.runner.audit.tail(10).find((l) => l.action === "send-reveal" && l.phase === "end").result, /SECRET PUBLIC/);
  } finally {
    h.cleanup();
  }
  h = harness();
  try {
    h.f.writeTick("alice", F.spendTick("reveal_eth"), 0);
    const job = dryAndSend(h, "dry-reveal", "send-reveal", "0.001 ETH");
    assert.equal(job.ok, true);
    assert.equal(job.warning, null);
    assert.equal(job.secret_may_be_public, false);
  } finally {
    h.cleanup();
  }
});

// ------------------------------------------------------------------------------------------------ the alarm beside a refund's send box

const ALARM = "ALARM: this lock's T_reveal 1800000000 is 120 s beyond the engine's own bound 1799999880 (D 281514): if Alice reveals late, the NOID claim may not be final before D; claim the moment the secret is seen; do not make another lock (lock d1d1d1d1)";

test("the view of the runner: an ALARM does not stop the ETH refund (its text goes beside the send box, the send runs after a dry run), but it still stops the claim", () => {
  const h = harness();
  try {
    h.f.writeTick("bob", F.spendTick("refund_eth", { notes: [ALARM] }), 0);
    h.adv(1500);
    h.runner.startAction("dry-refund-eth");
    h.adv(2500);
    const sp = h.view().spends["send-refund-eth"];
    assert.equal(sp.relevant, true);
    assert.equal(sp.eligible, true, JSON.stringify(sp.reasons));
    assert.deepEqual(sp.notices.map((n) => n.text), [ALARM], "the whole alarm, beside the send box");
    const sent = h.runner.startSpend("send-refund-eth", "0.001 ETH");
    assert.equal(sent.ok, true);
    // the claim is refused for the same alarm
    h.f.writeTick("bob", F.spendTick("claim_noid", { notes: [ALARM] }), 0);
    h.adv(5000);
    h.runner.startAction("dry-claim");
    h.adv(2500);
    const claim = h.view().spends["send-claim"];
    assert.equal(claim.eligible, false);
    assert.ok(claim.reasons.some((r) => r.code === "engine_alarm"));
  } finally {
    h.cleanup();
  }
});

// ------------------------------------------------------------------------------------------------ production: read-only, every action refused

const refusedWith = (fn, status) => {
  try {
    fn();
  } catch (e) {
    assert.equal(e.status, status, e.message);
    return e;
  }
  assert.fail("expected a refusal");
};

test("a production run folder (bundle says production, chain 1 anywhere, or env.local.sh PROFILE / CHAIN) is read-only: every action and spend refused, nothing runs, the view says so", () => {
  const prodBundle = (f, p) => {
    const b = JSON.parse(fs.readFileSync(path.join(f.run, "alice.bundle.json"), "utf8"));
    b.params.profile = p.profile;
    if (p.chain) b.params.eth.chain_id = p.chain;
    fs.writeFileSync(path.join(f.run, "alice.bundle.json"), JSON.stringify(b));
    fs.writeFileSync(path.join(f.pub, "alice.bundle.json"), JSON.stringify(b));
  };
  const variants = [
    ["the bundle says production", (h) => prodBundle(h.f, { profile: "production" })],
    ["the bundle's chain id is 1", (h) => prodBundle(h.f, { profile: "sepolia", chain: 1 })],
    ["the tick's Ethereum chain id is 1", (h) => h.f.writeTick("bob", F.spendTick("lock_eth", { eth: { chain_id: 1 } }), 0)],
    ["the swap file's own terms say chain 1 (swap_terms)", (h) => h.f.writeTick("bob", F.spendTick("lock_eth", { mutate: (t) => (t.swap_terms = { eth: { chain_id: 1 } }) }), 0)],
    ["env.local.sh says PROFILE='production'", (h) => fs.writeFileSync(path.join(h.f.run, "env.local.sh"), "UI_ROLE='both'\nPROFILE='production'\nCHAIN='1'\n")],
    ["env.local.sh says CHAIN=1 only", (h) => fs.writeFileSync(path.join(h.f.run, "env.local.sh"), "CHAIN=1\n")],
  ];
  for (const [name, setup] of variants) {
    const h = harness();
    try {
      h.f.writeTick("bob", F.spendTick("lock_eth"), 0);
      setup(h);
      h.adv(1500);
      for (const id of ["tick-bob", "dry-lock", "check-object", "watch-start", "setup"]) {
        const e = refusedWith(() => h.runner.startAction(id), 403);
        assert.match(e.message, /does not act on a production swap/, `${name}: ${id}`);
      }
      refusedWith(() => h.runner.startSpend("send-lock", "0.001 ETH"), 403);
      refusedWith(() => h.runner.acknowledgeFunding(), 403);
      assert.equal(h.log.length, 0, `${name}: nothing ran`);
      const v = h.view();
      assert.match(v.production.text, /production profile \(Ethereum mainnet\)/, name);
      assert.ok(v.table.every((e) => /production/.test(e.blocked || "")), `${name}: every table entry is blocked`);
      for (const s of Object.values(v.spends)) assert.equal(s.relevant, false, `${name}: ${s.id}`);
      assert.ok(h.runner.audit.tail(20).some((l) => l.phase === "refused" && /production swap/.test(l.result)), `${name}: refusals are logged`);
    } finally {
      h.cleanup();
    }
  }
  // the test profiles are not production: a sepolia bundle and an env.local.sh without PROFILE, or with sepolia / rehearsal, still run
  for (const envText of [null, "PROFILE='sepolia'\nCHAIN='11155111'\n", "PROFILE='rehearsal'\nCHAIN='31337'\n"]) {
    const h = harness();
    try {
      h.f.writeTick("bob", F.spendTick("lock_eth"), 0);
      if (envText) fs.writeFileSync(path.join(h.f.run, "env.local.sh"), envText);
      h.adv(1500);
      assert.equal(h.runner.startAction("dry-lock").state, "done");
      assert.equal(h.view().production, null);
    } finally {
      h.cleanup();
    }
  }
});


test("env.local.sh: only its PROFILE and CHAIN lines are read, by a strict pattern; production in any readable line counts", () => {
  const { envLocalNetwork } = require("../lib/production");
  const dir = fs.mkdtempSync(path.join(require("os").tmpdir(), "noid-env-"));
  const put = (lines) => fs.writeFileSync(path.join(dir, "env.local.sh"), lines.join("\n") + "\n");
  try {
    put(["# comment PROFILE='production'", "ALERT_URL='https://hooks.example/SECRET-TOKEN'", 'PROFILE="rehearsal"', "  export CHAIN=31337", "XPROFILE='production'", "PROFILE=$(id)"]);
    const n = envLocalNetwork(dir);
    assert.deepEqual(n, { profile: "rehearsal", chain: "31337", production: false }, "comments, other variables and expansions are not read");
    assert.deepEqual(envLocalNetwork(path.join(dir, "missing")), { profile: null, chain: null, production: false });
    assert.ok(!JSON.stringify(n).includes("SECRET"));
    // the careful reading: a later line cannot take production back
    put(["PROFILE='production'", "PROFILE='sepolia'"]);
    assert.deepEqual(envLocalNetwork(dir), { profile: "sepolia", chain: null, production: true });
    put(["CHAIN=1", "CHAIN=11155111"]);
    assert.equal(envLocalNetwork(dir).production, true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
