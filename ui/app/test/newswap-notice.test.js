"use strict";
// R2, the signed "oldest safe version" notice: it refuses to START a swap (the form, a board slot, Bob's invitation save, `prepare` and `join` while the role's swap file does not exist) and
// refuses nothing of a swap that is running. The proof test for section 10: every spend, sweep, recovery, tick and watch passes with the flag set.
const test = require("node:test");
const assert = require("node:assert/strict");
const { makeEnv } = require("./program-harness");
const N = require("../lib/newswapnotice");
const { createStepExecutor } = require("../lib/stepexec");
const { createRunJsonSource } = require("../lib/settingsource");
const { AuditLog } = require("../lib/audit");
const { TABLE, WALLET_TABLE, BOARD_TABLE, BY_ID } = require("../lib/actions");
const { Autopilot } = require("../lib/autopilot");
const { NOID_PAYOUT, ETH_PAYOUT, BOB_NOID } = require("./steps-fixtures/settings");

const PIN = "0x48Ce4D6cf3c175737532017e82B9261b51F8E5eF";
const FORM = () => ({ role: "alice", profile: "sepolia", contract_version: 1, noid_amount: "5", eth_amount: "0.001", contract: PIN, bob_noid: BOB_NOID, bob_eth: "0x" + "b2".repeat(20), noid_payout: NOID_PAYOUT, eth_payout: ETH_PAYOUT, single_node_ok: false });
const NOTE = "This version has a flaw in its lock check.";
const flag = (env, o = {}) => {
  env.program.updateStatus = () => ({ state: "none", latest: null, url: null, unsafeForNewSwaps: true, unsafeNote: NOTE, ...o });
};

test("the reader: unsafe only for a strict true; the note must pass the release file's rules (280 characters, no control character), else it is null and unreadable", () => {
  const mk = (u) => ({ updateStatus: () => u });
  assert.deepEqual(N.read(mk({ unsafeForNewSwaps: false, unsafeNote: "x" })), { unsafe: false, note: null, note_unreadable: false, why: null });
  assert.equal(N.read(mk({ unsafeForNewSwaps: "true" })).unsafe, false);
  assert.equal(N.read({}).unsafe, false);
  assert.equal(N.read({ updateStatus: () => { throw new Error("x"); } }).unsafe, false);
  assert.equal(N.read(mk(null)).unsafe, false);
  const ok = N.read(mk({ unsafeForNewSwaps: true, unsafeNote: NOTE }));
  assert.deepEqual([ok.unsafe, ok.note, ok.note_unreadable], [true, NOTE, false]);
  assert.equal(ok.why, "New swaps are paused in this version by a signed security notice. Update the program to start one. Swaps already running go on as usual.");
  const long = N.read(mk({ unsafeForNewSwaps: true, unsafeNote: "a".repeat(281) }));
  assert.deepEqual([long.unsafe, long.note, long.note_unreadable], [true, null, true]);
  assert.equal(N.read(mk({ unsafeForNewSwaps: true, unsafeNote: "a".repeat(280) })).note, "a".repeat(280));
  for (const bad of ["line\nbreak", "tab\there", "nul\u0000", "bidi‮", "sep ", "\u0085next"]) assert.equal(N.read(mk({ unsafeForNewSwaps: true, unsafeNote: bad })).note, null, JSON.stringify(bad));
  assert.equal(N.read(mk({ unsafeForNewSwaps: true, unsafeNote: "" })).note, null);
  assert.equal(N.read(mk({ unsafeForNewSwaps: true, unsafeNote: 5 })).note, null);
});

test("GET /api/program: update carries unsafe and the note; new_swap_allowed gives the reason; the vault's own reasons keep priority", async () => {
  const env = makeEnv();
  try {
    const { api } = await env.start();
    let r = await api("GET", "/api/program");
    assert.deepEqual([r.body.update.unsafe, r.body.update.note, r.body.new_swap_allowed.ok], [false, null, true]);
    flag(env);
    r = await api("GET", "/api/program");
    assert.equal(r.body.update.unsafe, true);
    assert.equal(r.body.update.note, NOTE);
    assert.deepEqual(r.body.new_swap_allowed, { ok: false, why: N.REASON });
    env.vaultState.confirmed = false; // the vault's own reason first
    r = await api("GET", "/api/program");
    assert.equal(r.body.new_swap_allowed.ok, false);
    assert.match(r.body.new_swap_allowed.why, /recovery code/);
    env.vaultState.confirmed = true;
    flag(env, { unsafeNote: "x".repeat(281) });
    r = await api("GET", "/api/program");
    assert.deepEqual([r.body.update.unsafe, r.body.update.note, r.body.update.note_unreadable], [true, null, true]);
    // the notice goes with the update: not unsafe, no box
    env.program.updateStatus = () => ({ state: "none", latest: null, url: null, unsafeForNewSwaps: false, unsafeNote: null });
    r = await api("GET", "/api/program");
    assert.deepEqual([r.body.update.unsafe, r.body.new_swap_allowed.ok], [false, true]);
  } finally {
    await env.cleanup();
  }
});

test("with the flag set the form, a board slot and the invitation save refuse with 409 and the reason; nothing is made", async () => {
  const env = makeEnv();
  try {
    const bob = env.addSwap({ role: "bob" });
    const { api } = await env.start();
    flag(env);
    const before = (await api("GET", "/api/program")).body.swaps.length;
    let r = await api("POST", "/api/newswap", { fields: FORM() });
    assert.equal(r.status, 409);
    assert.equal(r.body.error, N.REASON);
    r = await api("POST", "/api/board/slot", { role: "alice" });
    assert.equal(r.status, 409);
    assert.equal(r.body.error, N.REASON);
    await api("POST", "/api/program/open", { what: "help" });
    r = await api("POST", "/api/invitation/save", { swap: bob.id });
    assert.equal(r.status, 409);
    assert.equal(r.body.error, N.REASON);
    assert.equal((await api("GET", "/api/program")).body.swaps.length, before, "no folder was made");
    // the flag gone: the form works again
    env.program.updateStatus = () => ({ state: "none", unsafeForNewSwaps: false, unsafeNote: null });
    r = await api("POST", "/api/newswap", { fields: FORM() });
    assert.equal(r.status, 200);
  } finally {
    await env.cleanup();
  }
});

test("prepare and join are refused while the role's swap file does not exist; they pass once it does", async () => {
  const env = makeEnv();
  try {
    flag(env);
    for (const [role, id] of [["alice", "prepare"], ["bob", "join"]]) {
      const sw = env.addSwap({ role });
      const source = createRunJsonSource({ dir: sw.dir });
      const executor = createStepExecutor({ program: env.program, swap: { id: sw.id, dir: sw.dir, settingsSource: source, audit: new AuditLog(sw.pub, { role }) }, steps: env.steps });
      let c = executor.precheck(BY_ID.get(id), {});
      assert.equal(c.ok, false, id);
      assert.equal(c.status, 409);
      assert.equal(c.tag, "new_swap_notice");
      assert.equal(c.why, N.REASON);
      const r = await executor.run(BY_ID.get(id), { bundlePath: "/x/alice.bundle.json" });
      assert.equal(r.refused, true);
      assert.equal(env.steps.calls.length, 0, "no step was called");
      env.swapFile(sw, role);
      c = executor.precheck(BY_ID.get(id), {});
      assert.equal(c.ok, true, `${id} with an existing swap file is a step of a swap that exists`);
    }
  } finally {
    await env.cleanup();
  }
});

test("the proof for section 10: every other entry of the tables (each spend, the recovery, the three sweeps, the ticks, the watch, the setup steps) is never refused by the notice", async () => {
  const env = makeEnv();
  try {
    flag(env);
    for (const role of ["alice", "bob"]) {
      const sw = env.addSwap({ role });
      env.swapFile(sw, role);
      const source = createRunJsonSource({ dir: sw.dir });
      const executor = createStepExecutor({ program: env.program, swap: { id: sw.id, dir: sw.dir, settingsSource: source, audit: new AuditLog(sw.pub, { role }) }, steps: env.steps });
      for (const e of [...TABLE, ...WALLET_TABLE, ...BOARD_TABLE]) {
        const c = executor.precheck(e, {});
        assert.notEqual(c.tag, "new_swap_notice", `${role} ${e.id}`);
      }
      for (const id of ["watch-start", "watch-stop"]) assert.notEqual(executor.precheck({ id, group: "watch" }, {}).tag, "new_swap_notice", id);
    }
    // and for a role whose file is missing, nothing but prepare and join is refused by the notice
    const sw = env.addSwap({ role: "alice" });
    const executor = createStepExecutor({ program: env.program, swap: { id: sw.id, dir: sw.dir, settingsSource: createRunJsonSource({ dir: sw.dir }), audit: new AuditLog(sw.pub, { role: "alice" }) }, steps: env.steps });
    const refused = [...TABLE, ...WALLET_TABLE, ...BOARD_TABLE].filter((e) => executor.precheck(e, {}).tag === "new_swap_notice").map((e) => e.id);
    assert.deepEqual(refused, ["prepare"]);
  } finally {
    await env.cleanup();
  }
});

test("the deposit watch and the autopilot's steps do not read the notice at all (a static look: only the entry points name it)", () => {
  const fs = require("fs");
  const path = require("path");
  const lib = path.join(__dirname, "..", "lib");
  const users = fs.readdirSync(lib).filter((n) => n.endsWith(".js") && /newswapnotice/.test(fs.readFileSync(path.join(lib, n), "utf8"))).sort();
  assert.deepEqual(users, ["stepexec.js", "swapset.js"]);
  assert.ok(typeof Autopilot === "function");
  assert.ok(!/newswapnotice/.test(fs.readFileSync(path.join(lib, "autopilot.js"), "utf8")));
  assert.ok(!/newswapnotice/.test(fs.readFileSync(path.join(lib, "actions.js"), "utf8")));
});

test("GET /api/run carries the notice for the card; a note that fails the rules is null", async () => {
  const env = makeEnv();
  try {
    const sw = env.addSwap({ role: "alice" });
    const { api } = await env.start();
    flag(env);
    let r = await api("GET", `/api/run?swap=${sw.id}`);
    assert.deepEqual(r.body.program.notice, { unsafe: true, note: NOTE, note_unreadable: false });
    flag(env, { unsafeNote: "a\nb" });
    r = await api("GET", `/api/run?swap=${sw.id}`);
    assert.deepEqual(r.body.program.notice, { unsafe: true, note: null, note_unreadable: true });
  } finally {
    await env.cleanup();
  }
});
