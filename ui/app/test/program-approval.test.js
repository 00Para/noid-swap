"use strict";
// Program mode: the autopilot's approval (design 12.3, spec 5.A.5): what it binds, that a missing input is a refusal and never the word "none", that a cache is not trusted right before a
// send; the role rule of the autopilot; and the stops of the program (key store, node, a step that may have been sent).
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { makeEnv, until } = require("./program-harness");
const { SwapSet } = require("../lib/swapset");
const { createToolHasher, TOOL_KEYS } = require("../lib/toolhash");
const { SPENDS } = require("../lib/gate");
const { ALL_SPENDS } = require("../lib/gate");
const runsettings = require("../lib/runsettings");
const F = require("./actions-fixtures");
const { WNA, statusText } = require("./wallet-harness");

const STATEMENTS = { stay_on: true, no_manual_steps: true, bob_check_matches: true };
const TYPED = "10 NOID";

async function setup(env, o = {}) {
  const a = env.addSwap({ role: o.role || "alice" });
  env.writeTerms(a, { aliceNoid: WNA });
  env.swapFile(a, o.role || "alice");
  env.writeTick(a, o.role || "alice", F.spendTick("fund_noid"));
  const set = new SwapSet({ program: env.program, deps: env.deps() });
  set.scan();
  const swap = set.get(a.id);
  const run = () => swap.runner.readRunFn(swap.runner.cfg.runDirs, Math.floor(Date.now() / 1000));
  return { a, set, swap, run, ap: swap.autopilot };
}

// a change a person (or a program) makes to run.json from outside: the file is replaced, not updated through runsettings.write (which keeps the payouts as they are)
const tamper = (dir, s) => fs.writeFileSync(path.join(dir, "run.json"), runsettings.canonicalBytes(s));

const hashOf = (h, fresh = true) => h.ap.termsHash(h.run(), { fresh });

test("12.3: the approval binds run.json, the program's version, the nine tool files and the step code; any one changing takes it out of force; the terminal-mode inputs are not used", async () => {
  const env = makeEnv();
  try {
    const h = await setup(env);
    const base = hashOf(h);
    assert.match(base, /^[0-9a-f]{64}$/);
    h.ap.turnOn("alice", TYPED, STATEMENTS);
    const file = JSON.parse(fs.readFileSync(path.join(h.a.dir, "autopilot-alice.json"), "utf8"));
    assert.equal(file.terms_sha256, base);
    assert.equal(file.program_version, "0.1.0");
    assert.equal(h.ap.approvalState("alice", h.run(), { fresh: true }).in_force, true);
    // the same files read again give the same hash; the cache changes nothing
    assert.equal(hashOf(h, false), base);

    const changes = [];
    // run.json: a value of the canonical bytes
    changes.push(["run.json", () => {
      const s = JSON.parse(fs.readFileSync(path.join(h.a.dir, "run.json"), "utf8"));
      s.rpc_timeout_s = 61;
      runsettings.write(h.a.dir, s);
    }, () => {
      const s = JSON.parse(fs.readFileSync(path.join(h.a.dir, "run.json"), "utf8"));
      s.rpc_timeout_s = 60;
      runsettings.write(h.a.dir, s);
    }]);
    // the payout address in run.json
    changes.push(["eth_payout", () => {
      const s = JSON.parse(fs.readFileSync(path.join(h.a.dir, "run.json"), "utf8"));
      s.eth_payout = "0x" + "d5".repeat(20);
      tamper(h.a.dir, s);
    }, () => {
      const s = JSON.parse(fs.readFileSync(path.join(h.a.dir, "run.json"), "utf8"));
      s.eth_payout = F.E ? "0x" + "c3".repeat(20) : s.eth_payout;
      tamper(h.a.dir, s);
    }]);
    // the program's version
    changes.push(["version", () => (env.program.version = "0.1.1"), () => (env.program.version = "0.1.0")]);
    // each of the nine tool files
    for (const k of TOOL_KEYS) {
      const orig = fs.readFileSync(env.toolFiles[k]);
      changes.push([k, () => fs.appendFileSync(env.toolFiles[k], "x"), () => fs.writeFileSync(env.toolFiles[k], orig)]);
    }
    // one step file
    for (const f of env.codeFiles) {
      const orig = fs.readFileSync(f);
      changes.push([path.basename(f), () => fs.appendFileSync(f, "// changed\n"), () => fs.writeFileSync(f, orig)]);
    }
    for (const [name, change, undo] of changes) {
      change();
      const changed = hashOf(h);
      assert.notEqual(changed, base, `${name} is bound`);
      assert.notEqual(changed, null, name);
      const st = h.ap.approvalState("alice", h.run(), { fresh: true });
      assert.equal(st.in_force, false, `${name}: out of force`);
      assert.equal(st.terms_changed, true);
      if (name === "version") assert.match(st.why, /approve again after an update/);
      undo();
      assert.equal(hashOf(h), base, `${name} undone`);
    }
    assert.equal(h.ap.approvalState("alice", h.run(), { fresh: true }).in_force, true);
    // the public terms are bound too
    const bundle = JSON.parse(fs.readFileSync(path.join(h.a.dir, "alice.bundle.json"), "utf8"));
    bundle.params.deadline_height += 1;
    for (const d of [h.a.dir, h.a.pub]) fs.writeFileSync(path.join(d, "alice.bundle.json"), JSON.stringify(bundle));
    assert.notEqual(hashOf(h), base);
    await h.set.stopAll();
  } finally {
    await env.cleanup();
  }
});

test("12.3: a missing or unreadable input makes the hash null (nothing in force); the word 'none' is never an input", async () => {
  const env = makeEnv();
  try {
    const h = await setup(env);
    h.ap.turnOn("alice", TYPED, STATEMENTS);
    const base = hashOf(h);
    const hide = (file, fn) => {
      const moved = file + ".moved";
      fs.renameSync(file, moved);
      try {
        fn();
      } finally {
        fs.renameSync(moved, file);
      }
    };
    for (const k of TOOL_KEYS) {
      hide(env.toolFiles[k], () => {
        assert.equal(hashOf(h), null, `${k} missing`);
        assert.equal(h.ap.approvalState("alice", h.run(), { fresh: true }).in_force, false);
        assert.equal(h.ap.approvalState("alice", h.run()).in_force, false, `${k} missing, cached read`);
      });
    }
    for (const f of env.codeFiles) hide(f, () => assert.equal(hashOf(h), null, path.basename(f)));
    hide(path.join(h.a.dir, "run.json"), () => assert.equal(hashOf(h), null));
    // a tool file the program object does not name, a program with no version, no code list
    const orig = env.program.toolFiles;
    env.program.toolFiles = () => {
      const x = orig();
      delete x.lib_rs;
      return x;
    };
    assert.equal(hashOf(h), null);
    env.program.toolFiles = () => {
      throw new Error("no");
    };
    assert.equal(hashOf(h), null);
    env.program.toolFiles = orig;
    const codes = env.program.codeFiles;
    env.program.codeFiles = [];
    assert.equal(hashOf(h), null);
    env.program.codeFiles = codes;
    const v = env.program.version;
    env.program.version = "";
    assert.equal(hashOf(h), null);
    env.program.version = v;
    assert.equal(hashOf(h), base);
    // the program object may give the code list as a function (the shell's does)
    env.program.codeFiles = () => codes;
    assert.equal(hashOf(h), base);
    env.program.codeFiles = codes;
    // turning the autopilot on with an input missing is refused
    h.ap.turnOff("alice");
    hide(env.toolFiles.swap_cli, () => assert.throws(() => h.ap.turnOn("alice", TYPED, STATEMENTS), (e) => e.status === 422 && e.reasons.some((r) => r.code === "terms_unhashable")));
    // the hash text itself never carries the word: the only strings in it are the inputs' own values
    const src = fs.readFileSync(path.join(__dirname, "..", "lib", "autopilot.js"), "utf8");
    const programPart = src.slice(src.indexOf("programTermsHash(run, o = {})"), src.indexOf("termsHash(run, o = {})"));
    assert.ok(!/"none"/.test(programPart), "programTermsHash has no 'none' word");
    await h.set.stopAll();
  } finally {
    await env.cleanup();
  }
});

test("12.3: the metadata cache serves views, but authorize hashes every input again: a file changed with its metadata unchanged still takes the approval out of force", async () => {
  const env = makeEnv();
  try {
    const h = await setup(env);
    // a hasher whose file system reports one fixed stat for the tool file, as a restored mtime and size would
    const real = fs;
    const f = env.toolFiles.swap_cli;
    const st = real.statSync(f);
    const fake = { ...real, statSync: (p) => (p === f ? st : real.statSync(p)) };
    h.swap.runner.toolHasher = createToolHasher({ fs: fake });
    h.ap.turnOn("alice", TYPED, STATEMENTS);
    const base = hashOf(h, false);
    fs.writeFileSync(f, "tool swap_cli version X\n"); // the real content changed; the metadata the cache sees did not
    assert.equal(h.ap.approvalState("alice", h.run()).in_force, true, "a view still goes by the cache");
    assert.equal(hashOf(h, false), base);
    assert.equal(h.ap.approvalState("alice", h.run(), { fresh: true }).in_force, false, "a fresh read sees the change");
    // authorize is what a start goes through: it refuses
    const spend = ALL_SPENDS["send-fund"];
    assert.equal(h.ap.authorize(h.ap.token, spend, h.run(), Date.now()), null);
    fs.writeFileSync(f, "tool swap_cli version 1\n");
    assert.ok(h.ap.authorize(h.ap.token, spend, h.run(), Date.now()), "unchanged again: authorized");
    await h.set.stopAll();
  } finally {
    await env.cleanup();
  }
});


test("12.3: the view reads the approval's inputs again once a minute, so a tool file changed with its metadata kept stops showing 'on' before the next spend", async () => {
  const env = makeEnv();
  try {
    const h = await setup(env);
    const real = fs;
    const f = env.toolFiles.swap_cli;
    const st = real.statSync(f);
    const fake = { ...real, statSync: (p) => (p === f ? st : real.statSync(p)) };
    h.swap.runner.toolHasher = createToolHasher({ fs: fake });
    let t = 1_800_000_000_000;
    h.ap.now = () => t;
    h.ap.turnOn("alice", TYPED, STATEMENTS);
    assert.equal(h.ap.view(h.run()).alice.on, true);
    fs.writeFileSync(f, "tool swap_cli version X\n"); // the content changed; the metadata the cache sees did not
    t += 30_000;
    assert.equal(h.ap.view(h.run()).alice.on, true, "within the minute a view still goes by the cache");
    t += 31_000;
    const v = h.ap.view(h.run()).alice;
    assert.equal(v.on, false, "after the minute the inputs are read again");
    assert.equal(v.terms_changed, true);
    assert.equal(h.ap.approvalState("alice", h.run()).in_force, false, "the loop's own check agrees");
    fs.writeFileSync(f, "tool swap_cli version 1\n");
    t += 61_000;
    assert.equal(h.ap.view(h.run()).alice.on, true, "the file is back: on again at the next look");
    await h.set.stopAll();
  } finally {
    await env.cleanup();
  }
});

test("a board run's approval also binds the handover, the offer note and the peer key; without the board's identity nothing is in force", async () => {
  const env = makeEnv();
  try {
    const h = await setup(env);
    const s = JSON.parse(fs.readFileSync(path.join(h.a.dir, "run.json"), "utf8"));
    s.handover = "board";
    runsettings.write(h.a.dir, s);
    assert.equal(h.swap.runner.boardRun().on, true);
    assert.equal(hashOf(h), null, "no board, no identity: nothing to hash");
    h.swap.runner.board = { identity: () => ({ offer_id: "a".repeat(64), peer_key: "b".repeat(64) }) };
    const one = hashOf(h);
    assert.match(one, /^[0-9a-f]{64}$/);
    h.swap.runner.board = { identity: () => ({ offer_id: "a".repeat(64), peer_key: "c".repeat(64) }) };
    assert.notEqual(hashOf(h), one);
    h.swap.runner.board = { identity: () => ({ offer_id: "d".repeat(64), peer_key: "b".repeat(64) }) };
    assert.notEqual(hashOf(h), one);
    await h.set.stopAll();
  } finally {
    await env.cleanup();
  }
});

test("12.4: the autopilot acts only for the swap's own role; the other role's route is refused and its approval file is never used", async () => {
  const env = makeEnv();
  try {
    const h = await setup(env, { role: "alice" });
    assert.throws(() => h.ap.turnOn("bob", "0.001 ETH", { stay_on: true, no_manual_steps: true }), (e) => e.status === 403);
    assert.throws(() => h.ap.turnOff("bob"), (e) => e.status === 403);
    const view = h.ap.view(h.run());
    assert.equal(view.bob.available, false);
    assert.match(view.bob.reason, /alice's/);
    assert.equal(view.alice.available, true);
    // an approval file of the other role that somebody placed by hand: the step ignores it
    fs.writeFileSync(path.join(h.a.dir, "autopilot-bob.json"), JSON.stringify({ v: 1, role: "bob", terms_sha256: "0".repeat(64) }));
    env.steps.calls.length = 0;
    h.ap.step();
    assert.equal(env.steps.calls.length, 0);
    assert.equal(h.ap.state.bob.doing, null);
    // a role that cannot be read: nothing is driven, nothing is available
    fs.writeFileSync(path.join(h.a.dir, "run.json"), "{}");
    assert.match(h.ap.roleBlockedFor("alice"), /no readable role/);
    assert.throws(() => h.ap.turnOn("alice", TYPED, STATEMENTS), (e) => e.status === 403);
    await h.set.stopAll();
  } finally {
    await env.cleanup();
  }
});

test("the autopilot waits while the key store is closed, the folder is not private, or the Parano1d node has not answered since the start; it starts nothing then", async () => {
  const env = makeEnv();
  try {
    const h = await setup(env);
    env.writeLoop(h.a, "alice");
    h.ap.turnOn("alice", TYPED, STATEMENTS);
    env.vaultState.ready = false;
    h.ap.step();
    assert.match(h.ap.state.alice.waiting_reason, /key store is not open/);
    env.vaultState.ready = true;
    env.node.noid.ok_since_start = false;
    h.ap.step();
    assert.match(h.ap.state.alice.waiting_reason, /Parano1d node/);
    env.node.noid.ok_since_start = true;
    env.guard.ok = false;
    h.swap.executor.folderGuard(true);
    h.ap.step();
    assert.match(h.ap.state.alice.waiting_reason, /not private/);
    assert.equal(env.steps.calls.length, 0);
    env.guard.ok = true;
    h.swap.executor.folderGuard(true);
    h.ap.step(); // now it goes on: it starts the watch or reads the engine
    assert.equal(h.ap.state.alice.waiting_reason === null || !/not private|key store|Parano1d/.test(h.ap.state.alice.waiting_reason), true);
    await h.set.stopAll();
  } finally {
    await env.cleanup();
  }
});

test("a wallet step that may have been sent stops the autopilot for that swap (needs you); it is never run again by itself, even where the step says the same bytes would go", async () => {
  const env = makeEnv();
  try {
    const h = await setup(env);
    h.ap.turnOn("alice", TYPED, STATEMENTS);
    const spend = ALL_SPENDS["send-fund"];
    // the step answered "maybe_sent" (code 6): the console reads it as rerun-safe, the autopilot in program mode does not rerun
    h.ap.settleSpend({ kind: "spend", role: "alice", spend: spend.id, job: 1 }, { ok: false, nothing_sent: false, rerun_safe: true, exit_code: 6, script: "wallet-fund.sh", files: [], error: null });
    assert.equal(h.ap.needs.alice.length, 1);
    assert.equal(h.ap.needs.alice[0].spend, "send-fund");
    assert.equal(h.ap.needs.alice[0].retrying, false);
    assert.match(h.ap.state.alice.doing, /stopped: needs you/);
    assert.ok(h.ap.blocking("alice", "send-fund"));
    assert.equal(h.ap.authorize(h.ap.token, spend, h.run(), Date.now()), null, "a blocked step is not authorized");
    // after a restart the audit log rebuilds the same stop, also for the same-bytes outcome
    h.swap.audit.append({ action: "send-recover", role: "alice", phase: "start", result: "started" });
    h.swap.audit.append({ action: "send-recover", role: "alice", phase: "end", result: "may have been sent, the same bytes may be sent again (wallet-recover.sh exit 6)" });
    h.ap.loadNeeds("alice");
    assert.ok(h.ap.needs.alice.some((e) => e.spend === "send-recover"));
    await h.set.stopAll();
  } finally {
    await env.cleanup();
  }
});

void SPENDS;
void crypto;
void until;
void statusText;
