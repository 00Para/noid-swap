"use strict";
// Program mode: how the console reads the code of a spend STEP (exitcodes.js classifyStepExit, spec Appendix B), and the same reading through the action runner.
const test = require("node:test");
const assert = require("node:assert/strict");
const { classifyStepExit, STEP_ROWS, STEP_LABELS, EXIT_TABLE, classifySpendExit, OK, MAY_HAVE_SENT, NOT_SENT, WAITING, RERUN_SAFE, SECRET_PUBLIC_REVERTED } = require("../lib/exitcodes");
const { CODE_TABLE } = require("../lib/steps/spendcommon");
const { ActionRunner, BY_ID } = require("../lib/actions");
const { STEP_OF } = require("../lib/stepexec");
const { AuditLog } = require("../lib/audit");
const { ALL_SPENDS: SPENDS } = require("../lib/gate");
const fs = require("fs");
const os = require("os");
const path = require("path");

const R = (label) => `${label} REFUSED, nothing sent: because\n`;
const W = (label, n, sub, outcome) => `${label} exit ${n} (swap-cli wallet ${sub}, outcome ${outcome})\n`;

test("STEP_ROWS has one explicit row for every code of every spend step's CODE_TABLE (and the table of the bash helpers is unchanged)", () => {
  for (const [step, codes] of Object.entries(CODE_TABLE)) {
    assert.ok(STEP_ROWS[step], `no rows for ${step}`);
    assert.ok(STEP_LABELS[step], `no label for ${step}`);
    for (const k of Object.keys(codes)) assert.ok(Object.prototype.hasOwnProperty.call(STEP_ROWS[step], k), `${step} code ${k} has no row`);
    // and no row for a code the step cannot return
    for (const k of Object.keys(STEP_ROWS[step])) assert.ok(Object.prototype.hasOwnProperty.call(codes, k), `${step} has a row for code ${k} that CODE_TABLE does not list`);
  }
  assert.deepEqual(Object.keys(EXIT_TABLE).sort(), ["claim.sh", "fund.sh", "lock.sh", "refund-eth.sh", "reveal.sh", "wallet-fund.sh", "wallet-recover.sh", "wallet-sweep.sh"]);
  assert.equal(classifySpendExit("lock.sh", { exitCode: 3, stdout: "lock REFUSED, nothing sent: x\n" }).outcome, NOT_SENT); // the legacy reading still works
});

test("every (step, code) of CODE_TABLE reads as Appendix B says", () => {
  const sub = { walletFund: "fund", walletRecover: "recover", walletSweep: "sweep" };
  for (const step of Object.keys(CODE_TABLE)) {
    const label = STEP_LABELS[step];
    for (const k of Object.keys(CODE_TABLE[step])) {
      const code = k === "null" ? null : Number(k);
      const row = STEP_ROWS[step][k];
      const withR = classifyStepExit(step, { code, stdout: R(label), files: [] });
      const bare = classifyStepExit(step, { code, stdout: "", files: [] });
      if (code === null) {
        assert.equal(bare.outcome, MAY_HAVE_SENT, `${step} null`);
        assert.equal(bare.nothing_sent, false);
        assert.equal(bare.secret_may_be_public, step === "reveal");
      } else if (row === "ok") {
        assert.equal(bare.outcome, OK, `${step} ${code}`);
        assert.equal(bare.nothing_sent, false);
      } else if (row === "may") {
        assert.equal(withR.outcome, MAY_HAVE_SENT, `${step} ${code} stays may even with a REFUSED line`);
        assert.equal(withR.nothing_sent, false);
        assert.equal(withR.secret_may_be_public, step === "reveal", `${step} ${code}`);
      } else if (row === "R") {
        assert.equal(withR.outcome, NOT_SENT, `${step} ${code} with its line`);
        assert.equal(withR.nothing_sent, true);
        assert.equal(bare.outcome, MAY_HAVE_SENT, `${step} ${code} without its line is MAY (design 12.6)`);
        assert.equal(bare.nothing_sent, false);
      } else if (row === "Rm") {
        assert.equal(withR.outcome, NOT_SENT);
        assert.equal(bare.outcome, MAY_HAVE_SENT);
      } else if (row === "rev") {
        assert.equal(bare.outcome, SECRET_PUBLIC_REVERTED);
        assert.equal(bare.secret_may_be_public, true);
      } else if (row === "W4") {
        const ok = classifyStepExit(step, { code, stdout: W(label, 4, sub[step], "hold"), files: [] });
        assert.equal(ok.outcome, WAITING, `${step} 4`);
        assert.equal(ok.waiting, true);
        assert.equal(ok.nothing_sent, true);
        assert.equal(classifyStepExit(step, { code, stdout: W(label, 4, sub[step], "done"), files: [] }).outcome, WAITING);
        assert.equal(classifyStepExit(step, { code, stdout: "", files: [] }).outcome, MAY_HAVE_SENT);
        assert.equal(classifyStepExit(step, { code, stdout: W(label, 4, sub[step], "maybe_sent"), files: [] }).outcome, MAY_HAVE_SENT);
      } else if (row === "W6") {
        const ok = classifyStepExit(step, { code, stdout: W(label, 6, sub[step], "maybe_sent"), files: [] });
        assert.equal(ok.outcome, RERUN_SAFE, `${step} 6`);
        assert.equal(ok.rerun_safe, true);
        assert.equal(ok.nothing_sent, false);
        assert.equal(classifyStepExit(step, { code, stdout: "", files: [] }).outcome, MAY_HAVE_SENT);
      } else assert.fail(`unknown row ${row}`);
    }
  }
});

test("the Ethereum sweep's 4 and 6 are may-have-sent (the table has no wait or same-bytes reading for it)", () => {
  assert.equal(classifyStepExit("walletSweep", { code: 4, kind: "eth", stdout: W("wallet-sweep", 4, "sweep", "hold") }).outcome, MAY_HAVE_SENT);
  assert.equal(classifyStepExit("walletSweep", { code: 6, kind: "eth", stdout: W("wallet-sweep", 6, "sweep", "maybe_sent") }).outcome, MAY_HAVE_SENT);
  assert.equal(classifyStepExit("walletSweep", { code: 4, kind: "noid", stdout: W("wallet-sweep", 4, "sweep", "hold") }).outcome, WAITING);
  assert.equal(classifyStepExit("walletSweep", { code: 3, kind: "eth", stdout: R("wallet-sweep") }).outcome, NOT_SENT);
});

test("a nothing-sent or waiting reading becomes may-have-sent when the step's files hold a real send result (never a -dry- one)", () => {
  for (const f of ["eth-lock-123456.json", "eth-claim.json", "eth-refund-123456.json", "eth-sweep-alice-123456.json", "eth-sweep-bob-000001.json"]) {
    assert.equal(classifyStepExit("lock", { code: 3, stdout: R("lock"), files: [f] }).outcome, MAY_HAVE_SENT, f);
    assert.equal(classifyStepExit("walletFund", { code: 4, stdout: W("wallet-fund", 4, "fund", "hold"), files: [`pub/${f}`] }).outcome, MAY_HAVE_SENT, f);
  }
  for (const f of ["eth-lock-dry-123456.json", "eth-claim-dry-123456.json", "eth-sweep-alice-dry-123456.json", "lock-precheck-1.json", "last-tick-bob.json"]) {
    assert.equal(classifyStepExit("lock", { code: 3, stdout: R("lock"), files: [f] }).outcome, NOT_SENT, f);
  }
});

test("a code that is not in the table, a missing code and a bad step name read as may-have-sent (the reveal: the secret may be public)", () => {
  assert.equal(classifyStepExit("lock", { code: 9, stdout: R("lock") }).outcome, MAY_HAVE_SENT);
  assert.equal(classifyStepExit("claim", { code: 3, stdout: R("claim") }).outcome, MAY_HAVE_SENT); // claim has no 3
  assert.equal(classifyStepExit("refundEth", { code: 3, stdout: R("refund") }).outcome, MAY_HAVE_SENT);
  const rev = classifyStepExit("reveal", { code: 7, stdout: "" });
  assert.equal(rev.outcome, MAY_HAVE_SENT);
  assert.equal(rev.secret_may_be_public, true);
  assert.equal(classifyStepExit("reveal", { code: 1, stdout: "" }).secret_may_be_public, true);
  assert.equal(classifyStepExit("reveal", { code: null }).secret_may_be_public, true);
  assert.equal(classifyStepExit("nope", { code: 0 }).outcome, MAY_HAVE_SENT);
  assert.equal(classifyStepExit("lock", undefined).outcome, MAY_HAVE_SENT);
  assert.equal(classifyStepExit("lock", { code: "0" }).outcome, MAY_HAVE_SENT); // not a whole number: no code
});

test("the REFUSED line must be the step's own label at the start of a line", () => {
  assert.equal(classifyStepExit("lock", { code: 2, stdout: "x\nlock REFUSED, nothing sent: y\n" }).outcome, NOT_SENT);
  assert.equal(classifyStepExit("lock", { code: 2, stdout: "reveal REFUSED, nothing sent: y\n" }).outcome, MAY_HAVE_SENT);
  assert.equal(classifyStepExit("lock", { code: 2, stdout: "note: lock REFUSED, nothing sent\n" }).outcome, MAY_HAVE_SENT);
  assert.equal(classifyStepExit("refundEth", { code: 2, stdout: "refund REFUSED, nothing sent: y\n" }).outcome, NOT_SENT);
  assert.equal(classifyStepExit("boardSign", { code: 3, stdout: "board-sign REFUSED, nothing sent: nothing is reported\n" }).outcome, NOT_SENT);
  assert.equal(classifyStepExit("boardSign", { code: 3, stdout: "" }).outcome, MAY_HAVE_SENT);
});

// ---- the same reading through the action runner (a step executor that answers a canned result)

function runnerWith(result, seed = []) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "no1d-exit-"));
  fs.mkdirSync(path.join(dir, "pub"));
  const audit = new AuditLog(path.join(dir, "pub"), { role: "alice" });
  for (const [action, phase, res] of seed) audit.append({ action, role: "alice", phase, result: res });
  const executor = {
    precheck: () => ({ ok: true }),
    run: async () => (typeof result === "function" ? result() : result),
    watchStatus: () => ({ running: false, ticks: 0 }),
  };
  const settingsSource = {
    load: () => ({ ok: true, settings: {}, why: null }),
    role: () => "alice",
    slotRole: () => null,
    walletRun: () => ({ found: true, use_swap_wallet: true, ambiguous: false, noid_payout: null, eth_payout: null }),
    boardRun: () => ({ on: false, declared: false, file: false, ambiguous: false }),
    productionReason: () => null,
    roleBlock: () => null,
  };
  const runner = new ActionRunner({ runDirs: [dir, path.join(dir, "pub")] }, { audit, executor, settingsSource, program: { version: "0.1.0" } });
  return { runner, dir, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

async function runSpend(id, result) {
  const h = runnerWith(result);
  try {
    const e = BY_ID.get(id);
    const spend = SPENDS[id];
    const rec = h.runner.launch(e, h.runner.command(id), { role: spend.role, spend, run: null, replaceTx: null, latch: { tickNow: 1, intentAt: 2 } });
    for (let i = 0; i < 200 && h.runner.busy; i++) await new Promise((r) => setTimeout(r, 5));
    assert.equal(h.runner.busy, null);
    return h.runner.jobs.find((j) => j.job === rec.job);
  } finally {
    h.cleanup();
  }
}

async function launchAndWait(h, id) {
  const e = BY_ID.get(id);
  const spend = SPENDS[id];
  h.runner.launch(e, h.runner.command(id), { role: spend.role, spend, run: null, replaceTx: null, latch: { tickNow: 1, intentAt: 2 } });
  for (let i = 0; i < 200 && h.runner.busy; i++) await new Promise((r) => setTimeout(r, 5));
  assert.equal(h.runner.busy, null);
}
function pushOut(runner, id) {
  // later jobs push the spend out of the 30 kept ones, as the runner trims its list
  for (let i = 0; i < 31; i++) {
    runner.jobs.push({ job: 1000 + i, group: "dry", id: "dry-claim", state: "done", outcome: null });
    if (runner.jobs.length > 30) runner.jobs.shift();
  }
  assert.ok(!runner.jobs.some((j) => j.id === id));
}

test("a spend run here keeps its own ending once its job leaves the kept list: an older may-have-sent line of the audit log does not come back", async () => {
  const h = runnerWith({ code: 0, stdout: "", stderr: "", files: [] }, [["send-claim", "start", "started"], ["send-claim", "end", "timeout, the transaction may have been sent"]]);
  try {
    assert.deepEqual(h.runner.mayHaveSentIds(), ["send-claim"], "read from the audit log at start");
    await launchAndWait(h, "send-claim");
    assert.deepEqual(h.runner.mayHaveSentIds(), [], "the clean run counts");
    pushOut(h.runner, "send-claim");
    assert.deepEqual(h.runner.mayHaveSentIds(), [], "and still counts once its job is gone");
  } finally {
    h.cleanup();
  }
  const m = runnerWith(() => Promise.reject(new Error("x")));
  try {
    await launchAndWait(m, "send-claim");
    assert.deepEqual(m.runner.mayHaveSentIds(), ["send-claim"]);
    pushOut(m.runner, "send-claim");
    assert.deepEqual(m.runner.mayHaveSentIds(), ["send-claim"], "a run that may have been sent keeps counting once its job is gone");
  } finally {
    m.cleanup();
  }
});

test("through the console: for every spend entry and every code of its step the job's outcome equals classifyStepExit", async () => {
  const cases = [];
  for (const [id, so] of Object.entries(STEP_OF)) {
    if (!SPENDS[id]) continue; // board-sign is not a spend of the gate
    for (const k of Object.keys(CODE_TABLE[so.step])) {
      const code = k === "null" ? null : Number(k);
      const label = STEP_LABELS[so.step];
      const sub = { walletFund: "fund", walletRecover: "recover", walletSweep: "sweep" }[so.step];
      const outs = ["", R(label), sub ? W(label, 4, sub, "hold") : "", sub ? W(label, 6, sub, "maybe_sent") : ""];
      for (const stdout of outs) cases.push({ id, so, code, stdout });
    }
  }
  assert.ok(cases.length > 100);
  for (const c of cases) {
    const job = await runSpend(c.id, { code: c.code, stdout: c.stdout, stderr: "", files: [], step: c.so.step });
    const want = classifyStepExit(c.so.step, { code: c.code, stdout: c.stdout, files: [], kind: c.so.kind });
    assert.equal(job.outcome, want.outcome, `${c.id} code ${c.code} out ${JSON.stringify(c.stdout)}`);
    assert.equal(job.nothing_sent, want.nothing_sent, `${c.id} ${c.code}`);
    // the reveal without a result file is read as "the secret may be public" by the console's older rule too
    if (want.secret_may_be_public === true) assert.equal(job.secret_may_be_public, true, `${c.id} ${c.code}`);
    else if (!c.id.startsWith("send-reveal")) assert.equal(job.secret_may_be_public, false, `${c.id} ${c.code}`);
    assert.equal(job.state, "done");
    assert.equal(job.ok, c.code === 0);
  }
});

test("through the console: a rejected promise of a spend step is may-have-sent (never 2 or 3); a 2 or 3 without its fixed line too", async () => {
  for (const id of ["send-lock", "send-reveal", "send-claim", "send-refund-eth", "send-fund", "send-recover", "send-sweep-noid", "send-sweep-eth-alice"]) {
    const job = await runSpend(id, () => Promise.reject(new Error("boom: a path C:/secret/x and a value 0xabc")));
    assert.equal(job.outcome, "may_have_sent", id);
    assert.equal(job.nothing_sent, false, id);
    assert.equal(job.exit_code, null, id);
    assert.equal(job.secret_may_be_public, id === "send-reveal", id);
    assert.ok(!/boom|C:\/secret|0xabc/.test(JSON.stringify(job)), "the error's own text never reaches the job record");
    for (const code of [2, 3]) {
      const j2 = await runSpend(id, { code, stdout: "something else\n", stderr: "", files: [] });
      assert.equal(j2.nothing_sent, false, `${id} ${code}`);
      assert.equal(j2.outcome, id === "send-reveal" && code === 3 ? "secret_public_reverted" : "may_have_sent", `${id} ${code}`);
    }
  }
});

test("through the console: a lock, a reveal or a refund that ended in code 1 carries the advice, and the reveal's 3 is the public-secret reading", async () => {
  for (const id of ["send-lock", "send-reveal", "send-refund-eth"]) {
    const job = await runSpend(id, { code: 1, stdout: "", files: [] });
    assert.match(job.advice, /A missing `sent:` line does not prove that nothing was sent/);
  }
  assert.equal((await runSpend("send-claim", { code: 1, stdout: "", files: [] })).advice, undefined);
  const rev = await runSpend("send-reveal", { code: 3, stdout: "", files: [] });
  assert.equal(rev.outcome, "secret_public_reverted");
  assert.equal(rev.secret_may_be_public, true);
});

test("through the console: a send result file in the step's files turns a clean refusal into may-have-sent", async () => {
  const j = await runSpend("send-lock", { code: 3, stdout: R("lock"), files: ["eth-lock-120000.json"], stderr: "" });
  assert.equal(j.outcome, "may_have_sent");
  const j2 = await runSpend("send-lock", { code: 3, stdout: R("lock"), files: ["lock-precheck-120000.json"], stderr: "" });
  assert.equal(j2.outcome, "refused_nothing_sent");
  assert.equal(j2.nothing_sent, true);
});
