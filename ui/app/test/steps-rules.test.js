"use strict";
// The cross-step rules of piece 4 (spec section 5) over every step of steps-fixtures/registry.js, and a check that each rule can fail (fake steps that break them).
//   argv: no secret in any argument vector; passphrase: only in the swap-cli commands that had it in bash, never in live.js; codes: every documented exit code is
//   reachable and nothing else is returned; wx: a file made with noclobber is never overwritten; env: a hostile parent environment (proxy variables, NODE_OPTIONS,
//   a SWAP_PASSPHRASE already set, an odd HOME) reaches no child; canary: a key and a secret a stub emits are in no result, file or call log.
// Steps 4.3 and 4.4 add an entry to registry.js and these tests cover them; 4.4 also adds the throw / kill / time-out rule for spend steps.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const C = require("../lib/steps/common");
const registry = require("./steps-fixtures/registry");
const { makeHarness } = require("./steps-fixtures/harness");
const { checkRules, KEY_CANARY } = require("./steps-fixtures/rules");

for (const entry of registry) {
  test(`cross-step rules: ${entry.name}`, async () => {
    const v = await checkRules(entry);
    for (const [rule, list] of Object.entries(v)) assert.deepEqual(list, [], `rule ${rule}`);
  });
}

test("the registry names every step of the module (a step that is not in it escapes the rules)", () => {
  const steps = require("../lib/steps");
  // the steps of 4.1 are named here; a later step names itself in its registry entry (`exports: ["lock"]`)
  const covered = new Set(["tick", "walletStatus", "boardDigest", "boardVerify", "boardBalance", ...registry.flatMap((e) => e.exports || [])]);
  const exported = Object.keys(steps).filter((k) => typeof steps[k] === "function" && k !== "createWatch");
  for (const k of exported) assert.ok(covered.has(k), `${k} is a step with no registry entry`);
  for (const k of covered) assert.equal(typeof steps[k], "function", k);
  assert.ok(registry.length >= covered.size);
});

// ---- the rules are not vacuous: a fake step that breaks each one is caught
async function runOnce(ctx, args) {
  const r = await C.runChild(ctx, { tool: "swapCli", args, passphrase: true });
  return { code: r.code, stdout: r.stdout, stderr: r.stderr, files: [] };
}
const fake = (over) => ({
  name: "fake",
  role: "alice",
  passphraseFor: ["tick"],
  codes: [0],
  prepare: (h) => h.swapFile("alice"),
  scenario: () => ({ swapCli: { tick: { stdout: "{}" } } }),
  run: (ctx) => runOnce(ctx, ["tick"]),
  cases: [{ label: "ordinary", expect: 0 }],
  ...over,
});
const flagged = async (entry, rule) => {
  const v = await checkRules(entry);
  assert.ok(v[rule].length > 0, `the ${rule} rule did not catch it: ${JSON.stringify(v)}`);
};

test("rules: a step that puts the passphrase or a secret in an argument vector is caught", async () => {
  await flagged(fake({ run: (ctx) => runOnce(ctx, ["tick", ctx.getPassphrase()]) }), "argv");
  await flagged(fake({ run: (ctx) => runOnce(ctx, ["tick", KEY_CANARY]) }), "argv");
});

test("rules: a swap-cli command that gets the passphrase without being listed, or is listed and does not get it, is caught", async () => {
  await flagged(fake({ passphraseFor: [] }), "passphrase");
  await flagged(fake({ passphraseFor: ["tick", "ethkey emit"], scenario: () => ({ swapCli: { tick: { stdout: "{}" }, "ethkey emit": { stdout: "" } } }), run: async (ctx) => {
    await runOnce(ctx, ["tick"]);
    const r = await C.runChild(ctx, { tool: "swapCli", args: ["ethkey", "emit", "x"] });
    return { code: r.code, stdout: "", stderr: "", files: [] };
  } }), "passphrase");
});

test("rules: a live.js child cannot be given the passphrase through the runner at all", async () => {
  const h = makeHarness();
  try {
    await assert.rejects(() => C.runChild(h.ctx, { tool: "liveJs", args: ["balance"], passphrase: true }), /never gets the passphrase/);
    assert.throws(() => C.startTool(h.ctx, { tool: "liveJs", args: ["balance"], passphrase: "x" }), /never gets the passphrase/);
  } finally {
    h.cleanup();
  }
});

test("rules: an undocumented code, a documented code that nothing reaches, a throwing step and a malformed result are caught", async () => {
  await flagged(fake({ run: async () => ({ code: 9, stdout: "", stderr: "", files: [] }), cases: [{ label: "c", expect: 9 }] }), "codes");
  await flagged(fake({ codes: [0, 2] }), "codes");
  await flagged(fake({ run: async () => { throw new Error("boom"); } }), "shape");
  await flagged(fake({ run: async () => ({ code: 0 }) }), "shape");
});

test("rules: a step that overwrites a file it should create with noclobber is caught; one that refuses to is not", async () => {
  const marker = (ctx) => path.join(ctx.runDir, "wallet-funded.marker");
  await flagged(fake({ wx: ["wallet-funded.marker"], run: async (ctx) => {
    fs.writeFileSync(marker(ctx), "x");
    return { code: 0, stdout: "", stderr: "", files: [] };
  } }), "wx");
  const ok = await checkRules(fake({ wx: ["wallet-funded.marker"], run: async (ctx) => {
    try {
      fs.writeFileSync(marker(ctx), "x", { flag: "wx" });
    } catch {
      /* refused, as noclobber does */
    }
    return { code: 0, stdout: "", stderr: "", files: [] };
  } }));
  assert.deepEqual(ok.wx, []);
});

test("rules: a child started with the parent's environment instead of the allow-list is caught", async () => {
  const leaky = async (ctx) => {
    await new Promise((resolve) => {
      const env = { ...process.env, ...ctx.stubEnv };
      delete env.NODE_OPTIONS; // the hostile one would stop this stub from starting at all
      const c = spawn(process.execPath, [ctx.tools.swapCli[1], "tick"], { env, stdio: "ignore", windowsHide: true });
      c.on("close", resolve);
    });
    return { code: 0, stdout: "", stderr: "", files: [] };
  };
  await flagged(fake({ run: leaky }), "env");
});

test("rules: a key that leaks into a result or a file is caught", async () => {
  const emit = { passphraseFor: ["ethkey emit"] };
  await flagged(fake({ ...emit, run: (ctx) => runOnce(ctx, ["ethkey", "emit", "x"]) }), "canary");
  await flagged(fake({ ...emit, run: async (ctx) => {
    const r = await runOnce(ctx, ["ethkey", "emit", "x"]);
    fs.writeFileSync(path.join(ctx.runDir, "leak.txt"), r.stdout);
    return { code: 0, stdout: "", stderr: "", files: ["leak.txt"] };
  } }), "canary");
});

// ---- step 4.4: the code rule of the spend steps (a throw or a kill after the first sender started gives null; before it, a refusal code)
const { checkSpendFaults } = require("./steps-fixtures/rules");

for (const entry of registry) {
  if (typeof entry.senders !== "function") continue;
  test(`spend code rule (throw at every point, kill every child): ${entry.name}`, { timeout: 240000 }, async () => {
    const v = await checkSpendFaults(entry);
    for (const [rule, list] of Object.entries(v)) assert.deepEqual(list, [], `rule ${rule}`);
  });
}

// the spend rule is not vacuous: a fake spend step that returns "nothing sent" after its sender started is caught, and a correct one is not
const fakeSpend = (run, over = {}) => ({
  name: "fake spend",
  role: "alice",
  passphraseFor: ["tick"],
  codes: [0, 2, null],
  prepare: (h) => h.swapFile("alice"),
  scenario: () => ({ swapCli: { tick: { stdout: "{}" } } }),
  senders: (c) => c.tool === "swapCli" && c.argv[0] === "tick",
  run,
  cases: [{ label: "ordinary", expect: 0 }],
  ...over,
});
const sendThen = (after) => async (ctx) => {
  await C.runChild(ctx, { tool: "swapCli", args: ["tick"], passphrase: true });
  return after(ctx);
};

test("spend rule: a step that says 'nothing sent' (code 2) after its sender started is caught; one that says null is not", async () => {
  const bad = await checkSpendFaults(fakeSpend(async (ctx) => {
    const r = await sendThen(async (c) => {
      c.now(); // an injection point after the send
      return { code: 0, stdout: "", stderr: "", files: [] };
    })(ctx).catch(() => ({ code: 2, stdout: "", stderr: "", files: [] }));
    return r;
  }));
  assert.ok(bad.throwAfter.length > 0, JSON.stringify(bad));
  const good = await checkSpendFaults(fakeSpend(async (ctx) => {
    try {
      const r = await C.runChild(ctx, { tool: "swapCli", args: ["tick"], passphrase: true });
      if (r.signal || r.error || r.code !== 0) return { code: null, stdout: "", stderr: "", files: [] }; // the sender did not run to its end
      ctx.now(); // an injection point after the send
      return { code: 0, stdout: "", stderr: "", files: [] };
    } catch {
      return { code: null, stdout: "", stderr: "", files: [] };
    }
  }));
  assert.deepEqual(good.throwAfter, [], JSON.stringify(good));
  assert.deepEqual(good.kill, [], JSON.stringify(good));
});

test("spend rule: a step that returns null before its sender started is caught (the refusal must be a refusal)", async () => {
  const bad = await checkSpendFaults(fakeSpend(async (ctx) => {
    try {
      ctx.now(); // a point before the send
    } catch {
      return { code: null, stdout: "", stderr: "", files: [] };
    }
    return sendThen(async () => ({ code: 0, stdout: "", stderr: "", files: [] }))(ctx);
  }));
  assert.ok(bad.throwBefore.length > 0, JSON.stringify(bad));
});

test("spend rule: a step that treats a killed sender as 'nothing sent' (code 2) is caught", async () => {
  const bad = await checkSpendFaults(fakeSpend(async (ctx) => {
    const r = await C.runChild(ctx, { tool: "swapCli", args: ["tick"], passphrase: true });
    return { code: r.signal || r.code !== 0 ? 2 : 0, stdout: "", stderr: "", files: [] };
  }, { codes: [0, 2] }));
  assert.ok(bad.kill.length > 0, JSON.stringify(bad));
});
