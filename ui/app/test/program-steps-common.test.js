"use strict";
// Program mode's two context fields and the child-environment guard in steps/common.js: ctx.signal, ctx.notify, ETH_RPC_URL only with settings.
const test = require("node:test");
const assert = require("node:assert/strict");
const C = require("../lib/steps/common");
const { tick } = require("../lib/steps/tick");
const { makeHarness } = require("./steps-fixtures/harness");

test("ctx.signal: aborting it kills the child the step started and the step returns its usual did-not-finish result", async () => {
  const h = makeHarness();
  try {
    h.swapFile("alice");
    h.scenario({ swapCli: { tick: { hang: true } } });
    const ac = new AbortController();
    const ctx = { ...h.ctx, signal: ac.signal };
    const p = tick(ctx, "alice", {});
    setTimeout(() => ac.abort(), 300);
    const t0 = Date.now();
    const r = await p;
    assert.ok(Date.now() - t0 < 5000, "ended soon after the abort");
    assert.equal(r.code, 124, "the time-out reading of tick");
    // an already aborted signal kills at once
    const ac2 = new AbortController();
    ac2.abort();
    const r2 = await C.runChild({ ...h.ctx, signal: ac2.signal }, { tool: "swapCli", args: ["tick"], passphrase: false });
    assert.equal(r2.timedOut, true);
  } finally {
    h.cleanup();
  }
});

test("without a signal nothing changes: a child that ends runs to its end", async () => {
  const h = makeHarness();
  try {
    h.scenario({ swapCli: { tick: { stdout: "{}", code: 0 } } });
    const r = await C.runChild(h.ctx, { tool: "swapCli", args: ["tick"] });
    assert.equal(r.code, 0);
    assert.equal(r.timedOut, false);
  } finally {
    h.cleanup();
  }
});

test("childEnv sets ETH_RPC_URL only when ctx.settings carries a string eth_rpc (board-verify in a slot has no settings)", () => {
  const h = makeHarness();
  try {
    assert.equal(C.childEnv(h.ctx, "liveJs").ETH_RPC_URL, h.settings.eth_rpc);
    assert.equal("ETH_RPC_URL" in C.childEnv({ ...h.ctx, settings: null }, "liveJs"), false);
    assert.equal("ETH_RPC_URL" in C.childEnv({ ...h.ctx, settings: undefined }, "liveJs"), false);
    assert.equal("ETH_RPC_URL" in C.childEnv({ ...h.ctx, settings: { eth_rpc: 5 } }, "liveJs"), false);
    assert.equal("ETH_RPC_URL" in C.childEnv(h.ctx, "swapCli"), false);
  } finally {
    h.cleanup();
  }
});

test("ctx.notify: an ALERT line notifies once per call, before any POST, with or without an alert URL; no text of the tick goes with it", async () => {
  const h = makeHarness();
  try {
    const kinds = [];
    const order = [];
    const ctx = {
      ...h.ctx,
      notify: (...a) => {
        kinds.push(a);
        order.push("notify");
      },
      alertPost: async () => {
        order.push("post");
        return true;
      },
    };
    const text = "x\nALERT: something secret-looking 0xabc\nALERT: another\nnoise\n";
    await C.alertHook(ctx, text); // alert_url is null in the fixture settings
    assert.deepEqual(kinds, [["alert"]], "one notification for the one fixed message, and only the kind");
    assert.deepEqual(order, ["notify"]);
    kinds.length = 0;
    order.length = 0;
    const withUrl = { ...ctx, settings: { ...h.settings, alert_url: "https://hooks.example/x" } };
    await C.alertHook(withUrl, text);
    assert.deepEqual(order, ["notify", "post"], "the notification comes before the POST");
    // with no notify function and no URL the hook does nothing at all
    await C.alertHook({ ...h.ctx }, text);
    assert.deepEqual(h.files().filter((f) => /alert-pending/.test(f.rel)), []);
  } finally {
    h.cleanup();
  }
});

test("ctx.notify: with the caller's state an ALERT that stays on the next ticks notifies once; a new line, or one that came back after a quiet tick, notifies again; the POST is unchanged", async () => {
  const h = makeHarness();
  try {
    const kinds = [];
    const posts = [];
    const ctx = { ...h.ctx, settings: { ...h.settings, alert_url: "https://hooks.example/x" }, notify: (k) => kinds.push(k), alertPost: async (u, m) => (posts.push(m), true) };
    const state = {};
    const a1 = "ALERT: the producer screen refuses this lock now\n";
    await C.alertHook(ctx, a1, state);
    await C.alertHook(ctx, a1, state);
    await C.alertHook(ctx, a1, state);
    assert.deepEqual(kinds, ["alert"], "three ticks, one notification");
    assert.equal(posts.length, 3, "the POST goes out on every tick as before");
    await C.alertHook(ctx, a1 + "ALERT: another alert\n", state);
    assert.equal(kinds.length, 2, "a new line notifies");
    await C.alertHook(ctx, "applied: True\n", state);
    await C.alertHook(ctx, a1, state);
    assert.equal(kinds.length, 3, "after a quiet tick the same alert is new again");
    await C.alertHook(ctx, a1, undefined);
    await C.alertHook(ctx, a1, undefined);
    assert.equal(kinds.length, 5, "without a state every call notifies, as before");
  } finally {
    h.cleanup();
  }
});

test("ctx.notify: an ALARM line notifies once per episode (the latch), is re-armed by a complete tick that no longer shows it", async () => {
  const h = makeHarness();
  try {
    const kinds = [];
    const ctx = { ...h.ctx, notify: (k) => kinds.push(k) };
    const alarm = "ALARM: the NOID claim is still pending past its target (claim branch is closed)\n";
    await C.alarmHook(ctx, "bob", alarm);
    await C.alarmHook(ctx, "bob", alarm);
    assert.deepEqual(kinds, ["alarm"], "the second tick of the same episode is latched");
    await C.alarmHook(ctx, "bob", "applied: True phase_after: x\n");
    await C.alarmHook(ctx, "bob", alarm);
    assert.deepEqual(kinds, ["alarm", "alarm"], "re-armed");
    // a notify that throws cannot stop the hook
    await C.alarmHook({ ...h.ctx, notify: () => { throw new Error("x"); } }, "alice", alarm);
  } finally {
    h.cleanup();
  }
});
