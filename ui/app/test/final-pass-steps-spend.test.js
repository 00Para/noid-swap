"use strict";
// The final-pass fixes of the spend steps (low points 4.4-1, 4.4-4, 4.4-5, 4.4-6, 4.4-8 of ui/app/lib/steps/README.md). Each test fails on the code before its fix.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const C = require("../lib/steps/common");
const steps = require("../lib/steps");
const { classifyStepExit } = require("../lib/exitcodes");
const { makeHarness } = require("./steps-fixtures/harness");
const { ALICE_NOID } = require("./steps-fixtures/settings");
const { KEY_CANARY, SECRET_CANARY } = require("./steps-fixtures/rules");
const F = require("./steps-fixtures/spend-fixtures");

const H = [];
function harness(o) {
  const h = makeHarness(o);
  H.push(h);
  return h;
}
test.after(() => {
  for (const h of H) h.cleanup();
});
const has = (text, needle) => assert.ok(text.includes(needle), `expected ${JSON.stringify(needle)} in:\n${text}`);

/** A harness of one role with its swap file and a scenario (as steps-spend.test.js). */
function mk(role, scenario, settings = {}) {
  const h = harness({ settings: { role, ...settings } });
  h.swapFile(role);
  h.scenario({ ...scenario, swapCli: { "ethkey emit": { stdout: `${KEY_CANARY}\n` }, secret: { stdout: `${SECRET_CANARY}\n` }, ...(scenario.swapCli || {}) } });
  return h;
}

// ---------------------------------------------------------------------------------------------------------------------------------
// 4.4-1: an unreadable report size is not "empty"

test("4.4-1 walletStep: a report whose size cannot be read is counted as not empty: a real run that exited 1 is 1 (maybe sent), not 3 (nothing sent); a readable empty one stays 3", async () => {
  const h = mk("alice", { swapCli: { "wallet fund": { stdout: "", code: 1 } } });
  const plain = await C.walletStep(h.ctx, "fund", "wf-plain", false);
  assert.equal(plain.rc, 3, "an empty report and exit 1: the tool's own refusal shape");
  const real = fs.statSync;
  const mocked = (p, ...a) => {
    if (String(p).endsWith("wf-unreadable.json")) throw Object.assign(new Error("denied"), { code: "EPERM" });
    return real(p, ...a);
  };
  fs.statSync = mocked;
  let r;
  try {
    r = await C.walletStep(h.ctx, "fund", "wf-unreadable", false);
  } finally {
    fs.statSync = real;
  }
  assert.equal(r.parsed, null);
  assert.equal(r.rc, 1, "the size could not be read: it may have been sent");
  // a dry run sends nothing: 3 stays
  fs.statSync = mocked;
  let d;
  try {
    d = await C.walletStep(h.ctx, "fund", "wf-unreadable", true);
  } finally {
    fs.statSync = real;
  }
  assert.equal(d.rc, 3);
});

// ---------------------------------------------------------------------------------------------------------------------------------
// 4.4-4: no summary of an earlier run's result file

test("4.4-4 reveal (real): live.js never started (its result file cannot be opened): the eth-claim.json of an earlier run is not summarized, not saved as a reverted hash, not copied to pub/; the code is null", async () => {
  const h = mk("alice", { liveJs: { claim: { stdout: F.LIVE_OK } } });
  const stale = JSON.stringify({ txHash: `0x${"7".repeat(64)}`, reverted: true, secretPublic: true, blockNumber: 99 });
  h.write("eth-claim.json", stale);
  const real = fs.openSync;
  fs.openSync = (p, ...a) => {
    if (String(p).endsWith("eth-claim.json")) throw Object.assign(new Error("denied"), { code: "EPERM" });
    return real(p, ...a);
  };
  let r;
  try {
    r = await steps.reveal(h.ctx, {});
  } finally {
    fs.openSync = real;
  }
  assert.equal(r.code, null);
  has(r.stdout, "THE SECRET MAY BE PUBLIC");
  has(r.stdout, "live.js was not started, so this run wrote no result file");
  assert.ok(!r.stdout.includes("7".repeat(64)), "the earlier run's hash is not shown");
  assert.ok(!r.stdout.includes("THE CLAIM 0x"), "no reverted notice from an earlier run's file");
  assert.equal(h.exists("reveal-reverted-tx.txt"), false);
  assert.equal(h.exists("pub/eth-claim.json"), false);
  assert.equal(h.read("eth-claim.json"), stale, "the earlier file itself is left as it was");
  assert.equal(h.calls("liveJs").length, 0);
});

// ---------------------------------------------------------------------------------------------------------------------------------
// 4.4-5: a loud line whenever the secret may be or is public

test("4.4-5 reveal (real): live.js exit 3 and a result that cannot be read: the loud line says the secret IS public, the code is 3", async () => {
  const h = mk("alice", { liveJs: { claim: { stdout: "", stderr: "error: the claim was mined and REVERTED\n", code: 3 } } });
  const r = await steps.reveal(h.ctx, {});
  assert.equal(r.code, 3);
  has(r.stdout, "!!! THE CLAIM WAS MINED AND REVERTED (live.js exit 3) AND NO HASH OF IT COULD BE READ FROM ITS RESULT: THE SECRET IS PUBLIC.");
  has(r.stdout, "!!! Run a tick for Alice with --apply now");
  assert.equal(h.exists("reveal-reverted-tx.txt"), false);
  const c = classifyStepExit("reveal", { code: r.code, stdout: r.stdout, files: r.files });
  assert.equal(c.secret_may_be_public, true);
});

test("4.4-5 reveal (real): exit 1 and live.js finished with a key that did not arrive whole: a loud line says the secret may be public; a clean exit 0 prints none; a dry run prints none", async () => {
  const one = mk("alice", { liveJs: { claim: { stdout: "", stderr: "error: boom\n", code: 1 } } });
  const r1 = await steps.reveal(one.ctx, {});
  assert.equal(r1.code, 1);
  has(r1.stdout, "!!! live.js ended on its own error (exit 1): the claim may have been sent: THE SECRET MAY BE PUBLIC.");
  const cut = mk("alice", { swapCli: { "ethkey emit": { stdout: "", stderr: "error: wrong passphrase\n", code: 1 } }, liveJs: { claim: { stdout: F.LIVE_OK, stderr: F.LIVE_SENT_ERR, code: 0 } } });
  const r2 = await steps.reveal(cut.ctx, {});
  assert.equal(r2.code, null);
  has(r2.stdout, "!!! live.js says it finished although its key or the secret did not arrive whole");
  const ok = mk("alice", { liveJs: { claim: { stdout: F.LIVE_OK, stderr: F.LIVE_SENT_ERR } } });
  const r3 = await steps.reveal(ok.ctx, {});
  assert.equal(r3.code, 0);
  assert.ok(!r3.stdout.includes("!!!"));
  const dry = mk("alice", { liveJs: { claim: { stdout: "", stderr: "error: boom\n", code: 1 } } });
  const r4 = await steps.reveal(dry.ctx, { dryRun: true });
  assert.ok(!r4.stdout.includes("!!!"), "a dry run sends nothing");
});

// ---------------------------------------------------------------------------------------------------------------------------------
// 4.4-6: the record mode's 3 says "REFUSED, nothing sent"

const wrScenario = (outcome, tick = {}) => ({
  swapCli: {
    "wallet address": { stdout: F.walletAddr() },
    "wallet recover": { stdout: F.step("recover", outcome, { target: ALICE_NOID }) },
    tick: { stdout: JSON.stringify({ events_applied_to_file: true, phase_after: "refunded", noid: {}, eth: {} }), touch: true, ...tick },
  },
});

test("4.4-6 wallet-recover --record: the tool refuses to record: 3 with the REFUSED, nothing sent line the console reads; after a send the close was sent, so stage B's failure keeps the old words", async () => {
  const bad = mk("alice", wrScenario("sent", { stdout: "", stderr: "error: only in the mempool\n", code: 1 }));
  bad.write("wallet-recovered-txid.txt", `${F.NOID_TX}\n`);
  const r = await steps.walletRecover(bad.ctx, { record: true });
  assert.equal(r.code, 3);
  has(r.stdout, "wallet-recover REFUSED, nothing sent: closed-by NOT recorded yet");
  const c = classifyStepExit("walletRecover", { code: r.code, stdout: r.stdout, files: r.files });
  assert.equal(c.nothing_sent, true, c.why);
  // stage A sent the close; the recording that follows is not a refusal of anything
  const sent = mk("alice", wrScenario("sent", { stdout: "", stderr: "error: only in the mempool\n", code: 1 }));
  const rs = await steps.walletRecover(sent.ctx, {});
  assert.equal(rs.code, 0);
  has(rs.stdout, "wallet-recover: closed-by NOT recorded yet");
  assert.ok(!/REFUSED, nothing sent/.test(rs.stdout), "the close was sent: nothing here is 'nothing sent'");
});

// ---------------------------------------------------------------------------------------------------------------------------------
// 4.4-8: the Ethereum sweep does not use 6

test("4.4-8 wallet-sweep eth (real): live.js printed sent: and did not finish: null (never 6, which means the same bytes are sent again); the console reads it as may have been sent", async () => {
  const swept = mk("alice", {
    swapCli: { "ethkey address": { stdout: F.ethkeyAddr("alice") } },
    liveJs: { sweep: { stdout: "", stderr: `${F.LIVE_SENT_ERR}error: timed out\n`, code: 1 } },
  });
  const r = await steps.walletSweep(swept.ctx, "eth", "alice", {});
  assert.equal(r.code, null);
  has(r.stdout, "live.js broadcast the sweep and did not finish (exit 1): it MAY have been sent");
  assert.equal(swept.exists("wallet-swept-eth-alice.marker"), false);
  const c = classifyStepExit("walletSweep", { code: r.code, stdout: r.stdout, files: r.files, kind: "eth" });
  assert.equal(c.nothing_sent, false);
  assert.equal(c.rerun_safe, undefined);
});
