"use strict";
// The first steps of a swap in program mode (lib/firststeps.js, build spec item 1): Set up and the wallet setup run by themselves, a failed step waits for the person, a start that throws
// backs off, a board slot / a read-only folder / a folder that has its swap file get no setup step, check-line.json is written once from the step's own output.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { makeEnv, until } = require("./program-harness");
const { SwapSet } = require("../lib/swapset");
const { FirstSteps, readCheckLine, writeCheckLine, CHECK_FILE } = require("../lib/firststeps");

const OK = { code: 0, stdout: "", stderr: "", files: [] };
// the line of a real `swap-cli new-alice` (its stderr), with the run folder's name replaced
const NEW_ALICE_ERR = [
  "hashlock registry: recorded in ~/.noid-swap/hashlocks.txt (per machine) and /tmp/run/hashlocks.txt (this run folder)",
  "swap file written: /tmp/run/a.swap.json (phase created; nothing on chain)",
  "bundle check: 3a42697d14d41716 (opening_hex 1398 characters)",
  "send Bob the bundle below as a file, not as pasted text (it contains no secret); Bob's new-bob prints the same `bundle check:` line:",
  "",
].join("\n");
const JOIN_OUT = ["swap file written: /tmp/run/bob/bob.swap.json", "bundle check: 3a42697d14d41716 ok", "bundle digest: " + "ab".repeat(32), ""].join("\n");

const mk = (env, extra) => new SwapSet({ program: env.program, deps: env.deps(extra) });
const idle = (swap) => until(() => swap.runner.busy === null, "the action to end");

/** The stub steps that make the files the real steps make. */
function makeFilesStubs(env) {
  env.steps.results.setup = (ctx) => {
    fs.writeFileSync(path.join(ctx.runDir, "eth-deploy-block.txt"), "123456\n");
    return OK;
  };
  env.steps.results.walletSetup = (ctx, role) => {
    fs.writeFileSync(path.join(ctx.runDir, "wallet-addresses.txt"), `ROLE=${role}\nALICE_NOID=o1x\n`);
    return OK;
  };
}

const names = (env) => env.steps.calls.map((c) => c.name);

test("a new form swap gets Set up and then the wallet setup from the timer alone, each with its start and end audit lines saying it was started by the program", async () => {
  const env = makeEnv();
  try {
    makeFilesStubs(env);
    const a = env.addSwap({ role: "alice" });
    let t = 1_800_000_000_000;
    const set = mk(env, { now: () => t });
    set.scan();
    const swap = set.get(a.id);
    set.tick();
    await idle(swap);
    assert.deepEqual(names(env), ["setup"]);
    t += 5000;
    set.tick();
    await idle(swap);
    assert.deepEqual(names(env), ["setup", "walletSetup"]);
    assert.deepEqual(env.steps.calls[1].args, ["alice", {}]);
    t += 5000;
    set.tick(); // nothing is left to make: no third step
    await idle(swap);
    assert.deepEqual(names(env), ["setup", "walletSetup"]);
    const lines = swap.audit.all();
    const of = (action, phase) => lines.filter((l) => l.action === action && l.phase === phase);
    for (const id of ["setup", "wallet-setup-alice"]) {
      assert.equal(of(id, "start").length, 1, id);
      assert.match(of(id, "start")[0].detail || "", /started by the program/, id);
      assert.equal(of(id, "end").length, 1, id);
      assert.match(of(id, "end")[0].result, /^ok \(exit 0\)/, id);
    }
    assert.deepEqual(swap.firstSteps.view(), { running: null, failed: null, waiting: null });
    await set.stopAll();
  } finally {
    await env.cleanup();
  }
});

test("Bob's swap goes through the same chain with his own wallet step", async () => {
  const env = makeEnv();
  try {
    makeFilesStubs(env);
    const b = env.addSwap({ role: "bob" });
    let t = 1_800_000_000_000;
    const set = mk(env, { now: () => t });
    set.scan();
    const swap = set.get(b.id);
    for (let i = 0; i < 3; i++) {
      set.tick();
      await idle(swap);
      t += 5000;
    }
    assert.deepEqual(names(env), ["setup", "walletSetup"]);
    assert.deepEqual(env.steps.calls[1].args, ["bob", {}]);
    await set.stopAll();
  } finally {
    await env.cleanup();
  }
});

test("a failed Set up stops the chain until the person clicks; after the click the chain goes on with the wallet setup", async () => {
  const env = makeEnv();
  try {
    makeFilesStubs(env);
    let fail = true;
    const good = env.steps.results.setup;
    env.steps.results.setup = (ctx) => (fail ? { code: 2, stdout: "", stderr: "a setting is wrong\n", files: [] } : good(ctx));
    const a = env.addSwap({ role: "alice" });
    let t = 1_800_000_000_000;
    const set = mk(env, { now: () => t });
    set.scan();
    const swap = set.get(a.id);
    set.tick();
    await idle(swap);
    assert.deepEqual(names(env), ["setup"]);
    for (let i = 0; i < 4; i++) {
      t += 10_000;
      set.tick();
      await idle(swap);
    }
    assert.deepEqual(names(env), ["setup"], "a failed step is not started again by itself");
    assert.equal(swap.firstSteps.view().failed, "setup");
    assert.equal(swap.firstSteps.view().running, null);
    // the person clicks "Try again": the same table entry
    fail = false;
    swap.runner.startAction("setup");
    await idle(swap);
    assert.equal(swap.firstSteps.view().failed, null);
    t += 10_000;
    set.tick();
    await idle(swap);
    assert.deepEqual(names(env), ["setup", "setup", "walletSetup"]);
    await set.stopAll();
  } finally {
    await env.cleanup();
  }
});

test("a Set up that ends cleanly but leaves its file missing counts as failed (the person decides)", async () => {
  const env = makeEnv();
  try {
    const a = env.addSwap({ role: "alice" }); // the stub makes no eth-deploy-block.txt
    let t = 1_800_000_000_000;
    const set = mk(env, { now: () => t });
    set.scan();
    const swap = set.get(a.id);
    set.tick();
    await idle(swap);
    t += 10_000;
    set.tick();
    await idle(swap);
    assert.deepEqual(names(env), ["setup"]);
    assert.equal(swap.firstSteps.view().failed, "setup");
    await set.stopAll();
  } finally {
    await env.cleanup();
  }
});

test("a closed key store starts nothing and writes no audit line; an unconfirmed recovery code starts no wallet setup and says why; both are waits", async () => {
  const env = makeEnv();
  try {
    makeFilesStubs(env);
    const a = env.addSwap({ role: "alice" });
    let t = 1_800_000_000_000;
    const set = mk(env, { now: () => t });
    set.scan();
    const swap = set.get(a.id);
    const before = swap.audit.all().length;
    env.vaultState.ready = false;
    set.tick();
    assert.match(swap.firstSteps.view().waiting, /key store is not open/);
    assert.deepEqual(names(env), []);
    assert.equal(swap.audit.all().length, before, "no audit line for a wait");
    env.vaultState.ready = true;
    set.tick(); // Set up needs no recovery code
    await idle(swap);
    assert.deepEqual(names(env), ["setup"]);
    env.vaultState.confirmed = false;
    const mid = swap.audit.all().length;
    for (let i = 0; i < 3; i++) {
      t += 10_000;
      set.tick();
      await idle(swap);
    }
    assert.deepEqual(names(env), ["setup"], "no wallet setup before the recovery code is confirmed");
    assert.match(swap.firstSteps.view().waiting, /recovery code/);
    assert.equal(swap.audit.all().length, mid, "no audit line for the wait either");
    env.vaultState.confirmed = true;
    t += 10_000;
    set.tick();
    await idle(swap);
    assert.deepEqual(names(env), ["setup", "walletSetup"]);
    assert.equal(swap.firstSteps.view().waiting, null);
    await set.stopAll();
  } finally {
    await env.cleanup();
  }
});

test("a start that throws is tried again after 60 s, then 120 s, and so on, never later than 15 minutes", async () => {
  const env = makeEnv();
  try {
    const a = env.addSwap({ role: "alice" });
    let t = 1_800_000_000_000;
    const set = mk(env, { now: () => t });
    set.scan();
    const swap = set.get(a.id);
    const tries = [];
    swap.runner.startAction = () => {
      tries.push(t);
      throw new Error("the audit log cannot be written (EBUSY); nothing was run");
    };
    const fs0 = swap.firstSteps;
    // step every 10 s until it has tried nine times
    for (let i = 0; i < 18 * 60 && tries.length < 9; i++) {
      fs0.step();
      t += 10_000;
    }
    assert.equal(tries.length, 9);
    const gaps = tries.slice(1).map((x, i) => (x - tries[i]) / 1000);
    assert.deepEqual(gaps.slice(0, 5), [60, 120, 240, 480, 900]);
    assert.ok(gaps.every((g) => g <= 900 + 10), "never later than 15 minutes (+ one timer step)");
    assert.ok(gaps.slice(4).every((g) => g >= 890), "it stays at the cap");
    assert.match(fs0.view().waiting, /audit log/);
    await set.stopAll();
  } finally {
    await env.cleanup();
  }
});

test("no setup chain for a board slot (its FirstSteps is given the board flag: the board host drives the setup)", async () => {
  const env = makeEnv();
  try {
    makeFilesStubs(env);
    const slot = env.addSwap({ role: "alice" });
    let t = 1_800_000_000_000;
    const set = mk(env, { now: () => t });
    set.scan();
    const s = set.get(slot.id);
    const asSlot = new FirstSteps({ runner: s.runner, executor: s.executor, dir: slot.dir, settingsSource: s.settingsSource, board: true, now: () => t });
    for (let i = 0; i < 3; i++) {
      assert.equal(asSlot.step(), false);
      t += 10_000;
    }
    assert.deepEqual(names(env), []);
    assert.deepEqual(asSlot.view(), { running: null, failed: null, waiting: null });
    await set.stopAll();
  } finally {
    await env.cleanup();
  }
});

test("no setup chain for a folder that has its swap file (it gets the watch) or a read-only folder (nothing runs there)", async () => {
  const env = makeEnv();
  try {
    makeFilesStubs(env);
    const have = env.addSwap({ role: "alice" });
    env.swapFile(have, "alice");
    const prod = env.addSwap({ role: "alice" });
    fs.writeFileSync(path.join(prod.dir, "run.json"), fs.readFileSync(path.join(prod.dir, "run.json"), "utf8").replace('"sepolia"', '"production"'));
    let t = 1_800_000_000_000;
    const set = mk(env, { now: () => t });
    set.scan();
    assert.equal(set.get(prod.id).readOnly, true);
    for (let i = 0; i < 3; i++) {
      set.tick();
      t += 10_000;
    }
    assert.ok(!env.steps.calls.some((c) => c.name === "setup" || c.name === "walletSetup"), "no setup step anywhere");
    assert.ok(!env.steps.calls.some((c) => c.runDir === prod.dir), "nothing ran in the production folder");
    assert.equal(env.steps.watches.length, 1, "the folder with its swap file got its (read) loop");
    assert.equal(env.steps.watches[0].ctx.runDir, have.dir);
    await set.stopAll();
  } finally {
    await env.cleanup();
  }
});

test("an old folder (Set up done, no wallet, no check-line.json) gets its wallet and goes on", async () => {
  const env = makeEnv();
  try {
    makeFilesStubs(env);
    const a = env.addSwap({ role: "alice" });
    fs.writeFileSync(path.join(a.dir, "eth-deploy-block.txt"), "123456\n");
    let t = 1_800_000_000_000;
    const set = mk(env, { now: () => t });
    set.scan();
    const swap = set.get(a.id);
    set.tick();
    await idle(swap);
    assert.deepEqual(names(env), ["walletSetup"], "Set up is not run again");
    assert.ok(fs.existsSync(path.join(a.dir, "wallet-addresses.txt")));
    assert.equal(readCheckLine(a.dir), null);
    await set.stopAll();
  } finally {
    await env.cleanup();
  }
});

// ---- check-line.json (spec 1.3)

test("check-line.json is written from new-alice.err only once alice.swap.json exists, in the exact form, once and never replaced", async () => {
  const env = makeEnv();
  try {
    const a = env.addSwap({ role: "alice" });
    fs.writeFileSync(path.join(a.dir, "new-alice.err"), NEW_ALICE_ERR);
    assert.equal(writeCheckLine(a.dir, "alice", 1_800_000_000_000), false, "no swap file yet: nothing is written");
    assert.ok(!fs.existsSync(path.join(a.dir, CHECK_FILE)));
    env.swapFile(a, "alice");
    assert.equal(writeCheckLine(a.dir, "alice", 1_800_000_123_000), true);
    const text = fs.readFileSync(path.join(a.dir, CHECK_FILE), "utf8");
    assert.equal(text, '{"v":1,"from":"prepare","hex":"3a42697d14d41716","at":1800000123}\n');
    assert.deepEqual(readCheckLine(a.dir), { v: 1, from: "prepare", hex: "3a42697d14d41716", at: 1800000123 });
    if (process.platform !== "win32") assert.equal(fs.statSync(path.join(a.dir, CHECK_FILE)).mode & 0o777, 0o600);
    // never replaced, even by another line
    fs.writeFileSync(path.join(a.dir, "new-alice.err"), NEW_ALICE_ERR.replace("3a42697d14d41716", "0000000000000001"));
    assert.equal(writeCheckLine(a.dir, "alice", 1_800_000_999_000), false);
    assert.equal(readCheckLine(a.dir).hex, "3a42697d14d41716");
  } finally {
    await env.cleanup();
  }
});

test("check-line.json is written from join-new-bob.out only once bob/bob.swap.json exists; a refused bundle leaves none", async () => {
  const env = makeEnv();
  try {
    const b = env.addSwap({ role: "bob" });
    fs.writeFileSync(path.join(b.dir, "join-new-bob.out"), JOIN_OUT);
    assert.equal(writeCheckLine(b.dir, "bob", 1_800_000_000_000), false, "no swap file: a refused bundle leaves no swap file and no check line");
    env.swapFile(b, "bob");
    assert.equal(writeCheckLine(b.dir, "bob", 1_800_000_000_000), true);
    assert.deepEqual(readCheckLine(b.dir), { v: 1, from: "join", hex: "3a42697d14d41716", at: 1800000000 });
    // Alice's form of the line is not Bob's: the "ok" form is Bob's only
    const a = env.addSwap({ role: "alice" });
    env.swapFile(a, "alice");
    fs.writeFileSync(path.join(a.dir, "new-alice.err"), JOIN_OUT);
    assert.equal(writeCheckLine(a.dir, "alice", 1_800_000_000_000), false);
  } finally {
    await env.cleanup();
  }
});

test("a source with no line, two different lines, a damaged line or a link writes nothing; two equal lines are one", async () => {
  const env = makeEnv();
  try {
    const cases = [
      ["no line", "swap file written\n", false],
      ["two different lines", NEW_ALICE_ERR + NEW_ALICE_ERR.replace("3a42697d14d41716", "0000000000000001"), false],
      ["a line that is too short", "bundle check: 3a42697d14d4171 (opening_hex 1398 characters)\n", false],
      ["upper case", "bundle check: 3A42697D14D41716 (opening_hex 1398 characters)\n", false],
      ["the same line twice", NEW_ALICE_ERR + NEW_ALICE_ERR, true],
      ["indented", "  bundle check: 3a42697d14d41716 (opening_hex 1398 characters)\n", false],
      ["too large a file", NEW_ALICE_ERR + "x".repeat(70 * 1024), false],
    ];
    for (const [name, text, ok] of cases) {
      const a = env.addSwap({ role: "alice" });
      env.swapFile(a, "alice");
      fs.writeFileSync(path.join(a.dir, "new-alice.err"), text);
      assert.equal(writeCheckLine(a.dir, "alice", 1_800_000_000_000), ok, name);
      assert.equal(fs.existsSync(path.join(a.dir, CHECK_FILE)), ok, name);
    }
  } finally {
    await env.cleanup();
  }
});

test("readCheckLine takes only the file the program writes: exactly its keys, a 16-digit lower-case hex, a plain small file", async () => {
  const env = makeEnv();
  try {
    const a = env.addSwap({ role: "alice" });
    const put = (obj) => fs.writeFileSync(path.join(a.dir, CHECK_FILE), typeof obj === "string" ? obj : JSON.stringify(obj) + "\n");
    const good = { v: 1, from: "prepare", hex: "3a42697d14d41716", at: 1800000000 };
    put(good);
    assert.deepEqual(readCheckLine(a.dir), good);
    for (const [name, bad] of [
      ["an extra key", { ...good, x: 1 }],
      ["a missing key", { v: 1, from: "prepare", hex: good.hex }],
      ["v 2", { ...good, v: 2 }],
      ["from elsewhere", { ...good, from: "board" }],
      ["a short hex", { ...good, hex: "3a42697d14d4171" }],
      ["an upper-case hex", { ...good, hex: "3A42697D14D41716" }],
      ["a time that is not a whole number", { ...good, at: 1.5 }],
      ["an array", [good]],
      ["not json", "{"],
    ]) {
      put(bad);
      assert.equal(readCheckLine(a.dir), null, name);
    }
    put({ ...good, pad: "x".repeat(600) });
    assert.equal(readCheckLine(a.dir), null, "above 512 bytes");
    fs.rmSync(path.join(a.dir, CHECK_FILE));
    assert.equal(readCheckLine(a.dir), null, "absent");
    fs.mkdirSync(path.join(a.dir, CHECK_FILE));
    assert.equal(readCheckLine(a.dir), null, "a folder in its place");
  } finally {
    await env.cleanup();
  }
});

test("through the timer: the swap file and new-alice.err of a prepared swap give check-line.json at the next step", async () => {
  const env = makeEnv();
  try {
    const a = env.addSwap({ role: "alice" });
    fs.writeFileSync(path.join(a.dir, "new-alice.err"), NEW_ALICE_ERR);
    env.swapFile(a, "alice");
    const set = mk(env);
    set.scan();
    set.tick(); // the wallet poll uses this step
    await idle(set.get(a.id));
    set.tick();
    assert.deepEqual(readCheckLine(a.dir) && readCheckLine(a.dir).hex, "3a42697d14d41716");
    assert.deepEqual(set.get(a.id).runner.view(null).check_line, { hex: "3a42697d14d41716", from: "prepare" });
    await set.stopAll();
  } finally {
    await env.cleanup();
  }
});

// ---- the run payload's other new fields (spec 1.2)

test("wallet.roles.bob.key_address is BOB_ETH of wallet-addresses.txt (a plain small file for Bob), else null; first_steps is in the payload; the watch button's note says it records", async () => {
  const env = makeEnv();
  try {
    const b = env.addSwap({ role: "bob" });
    const set = mk(env);
    set.scan();
    const swap = set.get(b.id);
    const KEY = `0x${"b2".repeat(20)}`;
    const key = () => swap.runner.view(null).wallet.roles.bob.key_address;
    assert.equal(key(), null, "no file yet");
    fs.writeFileSync(path.join(b.dir, "wallet-addresses.txt"), `ROLE=bob\nBOB_ETH=${KEY}\n`);
    assert.equal(key(), KEY);
    fs.writeFileSync(path.join(b.dir, "wallet-addresses.txt"), `ROLE=alice\nBOB_ETH=${KEY}\n`);
    assert.equal(key(), null, "not Bob's file");
    fs.writeFileSync(path.join(b.dir, "wallet-addresses.txt"), `ROLE=bob\nBOB_ETH=0x12\n`);
    assert.equal(key(), null, "not an address");
    fs.writeFileSync(path.join(b.dir, "wallet-addresses.txt"), `ROLE=bob\nBOB_ETH=${KEY}\n${"#".repeat(1100)}\n`);
    assert.equal(key(), null, "above 1 KB");
    fs.writeFileSync(path.join(b.dir, "wallet-addresses.txt"), `ROLE=bob\nBOB_ETH=${KEY}\nBOB_ETH=${KEY}\n`);
    assert.equal(key(), null, "two lines");
    const v = swap.runner.view(null);
    assert.deepEqual(Object.keys(v.first_steps).sort(), ["failed", "running", "waiting"]);
    const watch = v.table.find((e) => e.id === "watch-start");
    assert.equal(watch.note, "Records what the engine decides, including a funding or a lock to send next. Use it only if you will send by hand.");
    assert.notEqual(v.table.find((e) => e.id === "tick-bob").note, watch.note);
    await set.stopAll();
  } finally {
    await env.cleanup();
  }
});
